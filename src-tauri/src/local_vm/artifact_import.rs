//! Host-side import of a guest task's artifacts into `artifacts/<task>/<id>`,
//! within a per-task budget the host accounts for itself. The guest only
//! declares what it retained. `retained.json` records every admitted artifact
//! before its payload is fetched, so lost replies, omitted or changed
//! manifests, partial writes, retries, reopen and concurrent polls never reset
//! the count. Files already retained are never deleted or replaced.
use super::journal::{self, Artifact};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::Path};

const LEDGER: &str = "retained.json";
const LOCK: &str = "import.lock";

#[derive(Clone, Copy)]
pub(super) struct Limits {
    pub(super) artifacts: usize,
    pub(super) bytes: u64,
    pub(super) artifact_bytes: u64,
}
/// Per task, across every poll: at most 128 artifacts and 256 MiB. Each
/// artifact keeps the guest's own 12 MiB bound.
pub(super) const LIMITS: Limits = Limits {
    artifacts: 128,
    bytes: 256 * 1024 * 1024,
    artifact_bytes: super::guest::MAX_ARTIFACT_BYTES as u64,
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u32,
    artifacts: Vec<Artifact>,
}

pub(super) struct Imported {
    /// Every artifact the host holds for this task, in admission order.
    pub(super) retained: Vec<Artifact>,
    /// Why declared artifacts were not imported, when any were refused.
    pub(super) refused: Option<String>,
}

/// The payload on disk is a regular file of the recorded size.
fn held(dir: &Path, a: &Artifact) -> bool {
    fs::symlink_metadata(dir.join(&a.id)).is_ok_and(|m| m.is_file() && m.len() == a.bytes)
}

fn same(a: &Artifact, b: &Artifact) -> bool {
    a.id == b.id && a.name == b.name && a.sha256 == b.sha256 && a.bytes == b.bytes && a.media_type == b.media_type
}

/// A manifest that no honest guest produces is refused whole, before any read
/// or write.
fn validate(manifest: &[Artifact], limits: Limits) -> Result<()> {
    let mut ids = HashSet::new();
    for a in manifest {
        // One spelling per id: the guest's own lowercase hyphenated form. Other
        // spellings of one UUID could name the same file on a case-insensitive volume.
        if uuid::Uuid::parse_str(&a.id).map(|id| id.hyphenated().to_string()).ok().as_deref() != Some(a.id.as_str()) {
            bail!("The guest declared a non-canonical artifact id; nothing was imported")
        }
        if !ids.insert(a.id.as_str()) {
            bail!("The guest declared artifact {} twice; nothing was imported", a.id)
        }
        if a.sha256.len() != 64
            || !a.sha256.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            || a.bytes > limits.artifact_bytes
            || a.name.is_empty()
            || a.name.len() > 1024
            || a.media_type.is_empty()
            || a.media_type.len() > 255
        {
            bail!("The guest's artifact {} has invalid metadata or exceeds the per-artifact limit; nothing was imported", a.id)
        }
    }
    Ok(())
}

/// The ledger, or for a task retained before it existed, every payload already
/// on disk, so earlier history counts too (then `true`: not yet recorded).
/// `known` supplies earlier metadata.
fn load(dir: &Path, known: &[Artifact]) -> Result<(Vec<Artifact>, bool)> {
    let path = dir.join(LEDGER);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= 1024 * 1024 => {
            let ledger: Ledger = serde_json::from_slice(&fs::read(&path)?)
                .context("The retained artifact ledger is unreadable; inspect it before importing more")?;
            if ledger.version != 1 {
                bail!("Unsupported retained artifact ledger; inspect it before importing more")
            }
            return Ok((ledger.artifacts, false));
        }
        Ok(_) => bail!("The retained artifact ledger is not a bounded regular file; inspect it before importing more"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut seeded = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if journal::validate_id(&id).is_err() {
            continue;
        }
        if !fs::symlink_metadata(entry.path())?.is_file() {
            bail!("Retained artifact {id} is not a regular file; inspect it before importing more")
        }
        let bytes = fs::read(entry.path())?;
        let sha256 = journal::digest(&bytes);
        let size = bytes.len() as u64;
        seeded.push(known.iter().find(|a| a.id == id && a.sha256 == sha256 && a.bytes == size).cloned().unwrap_or(Artifact {
            name: id.clone(),
            id,
            sha256,
            bytes: size,
            media_type: "application/octet-stream".into(),
            expires_at: None,
        }));
    }
    seeded.sort_by(|a, b| a.id.cmp(&b.id));
    Ok((seeded, true))
}

/// Imports `manifest` into `dir`. New artifacts are admitted in manifest order
/// while the task's budget allows; from the first that does not fit, the rest
/// are refused without being fetched. Admissions are recorded before `fetch`
/// runs, and each payload must match its declared size and SHA-256.
pub(super) fn import(
    dir: &Path,
    known: &[Artifact],
    manifest: &[Artifact],
    limits: Limits,
    mut fetch: impl FnMut(&Artifact) -> Result<Vec<u8>>,
) -> Result<Imported> {
    validate(manifest, limits)?;
    if manifest.is_empty() && !dir.try_exists()? {
        return Ok(Imported { retained: vec![], refused: None });
    }
    journal::private_directory(dir)?;
    let _lock = journal::Lock::acquire(&dir.join(LOCK))?;
    let (mut ledger, seeded) = load(dir, known)?;
    if let Some(changed) = manifest.iter().find(|a| ledger.iter().any(|r| r.id == a.id && !same(r, a))) {
        bail!("The guest changed retained artifact {}; nothing was imported", changed.id)
    }
    let mut count = ledger.len();
    let mut total = ledger
        .iter()
        .try_fold(0_u64, |sum, a| sum.checked_add(a.bytes))
        .context("Retained artifact sizes overflow")?;
    let (mut admitted, mut refused, mut refused_bytes, mut full) = (Vec::new(), 0_usize, 0_u64, false);
    for a in manifest.iter().filter(|a| !ledger.iter().any(|r| r.id == a.id)) {
        let fits = count < limits.artifacts && total.checked_add(a.bytes).is_some_and(|sum| sum <= limits.bytes);
        full |= !fits;
        if full {
            refused += 1;
            refused_bytes = refused_bytes.saturating_add(a.bytes);
        } else {
            count += 1;
            total += a.bytes;
            admitted.push(a.clone());
        }
    }
    if !admitted.is_empty() || seeded {
        ledger.extend(admitted);
        let bytes = serde_json::to_vec(&Ledger { version: 1, artifacts: ledger.clone() })?;
        journal::atomic_private_write(&dir.join(LEDGER), &bytes)?;
    }
    for a in manifest.iter().filter(|a| ledger.iter().any(|r| r.id == a.id)) {
        let path = dir.join(&a.id);
        if fs::symlink_metadata(&path).is_ok() {
            if !held(dir, a) {
                bail!("Retained artifact {} differs from its record on disk; inspect it before importing more", a.id)
            }
            continue;
        }
        let bytes = fetch(a)?;
        if bytes.len() as u64 != a.bytes || journal::digest(&bytes) != a.sha256 {
            bail!("Guest artifact integrity mismatch")
        }
        journal::atomic_private_write(&path, &bytes)?;
    }
    let retained = ledger.into_iter().filter(|a| held(dir, a)).collect();
    let refused = (refused > 0).then(|| {
        format!(
            "{refused} more artifact(s) ({refused_bytes} bytes) exceed this task's host limit of {} artifacts and {} MiB and were not imported. Imported artifacts are kept; the rest stay in the guest and need explicit export.",
            limits.artifacts,
            limits.bytes / (1024 * 1024)
        )
    });
    Ok(Imported { retained, refused })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const SMALL: Limits = Limits { artifacts: 3, bytes: 12, artifact_bytes: 8 };

    fn artifact(name: &str, content: &[u8]) -> (Artifact, Vec<u8>) {
        let id = uuid::Uuid::parse_str(&journal::digest(format!("{name}:{content:?}").as_bytes())[..32]).unwrap().to_string();
        (
            Artifact { id, name: name.into(), sha256: journal::digest(content), bytes: content.len() as u64, media_type: "text/plain".into(), expires_at: None },
            content.to_vec(),
        )
    }
    /// A guest that serves `payloads` and counts what the host fetched.
    struct Guest {
        payloads: Vec<(Artifact, Vec<u8>)>,
        fetched: RefCell<Vec<String>>,
    }
    impl Guest {
        fn new(payloads: &[(Artifact, Vec<u8>)]) -> Self {
            Self { payloads: payloads.to_vec(), fetched: RefCell::new(vec![]) }
        }
        fn manifest(&self, names: &[&str]) -> Vec<Artifact> {
            names.iter().map(|n| self.payloads.iter().find(|(a, _)| a.name == *n).unwrap().0.clone()).collect()
        }
        fn fetch(&self, a: &Artifact) -> Result<Vec<u8>> {
            self.fetched.borrow_mut().push(a.name.clone());
            Ok(self.payloads.iter().find(|(p, _)| p.id == a.id).context("unknown")?.1.clone())
        }
        fn fetched(&self) -> Vec<String> {
            std::mem::take(&mut *self.fetched.borrow_mut())
        }
    }
    fn names(imported: &Imported) -> Vec<&str> {
        imported.retained.iter().map(|a| a.name.as_str()).collect()
    }
    fn ledger(dir: &Path) -> Vec<String> {
        serde_json::from_slice::<Ledger>(&fs::read(dir.join(LEDGER)).unwrap()).unwrap().artifacts.into_iter().map(|a| a.name).collect()
    }
    fn payloads(dir: &Path) -> usize {
        fs::read_dir(dir).unwrap().filter(|e| journal::validate_id(&e.as_ref().unwrap().file_name().to_string_lossy()).is_ok()).count()
    }

    #[test]
    fn accounting_spans_polls_omissions_and_reopen_and_refuses_before_fetching() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("task");
        let guest = Guest::new(&[artifact("a", b"1"), artifact("b", b"22"), artifact("c", b"333"), artifact("d", b"4")]);
        let first = import(&dir, &[], &guest.manifest(&["a", "b"]), SMALL, |a| guest.fetch(a)).unwrap();
        assert_eq!((names(&first), first.refused.is_none(), guest.fetched()), (vec!["a", "b"], true, vec!["a".to_string(), "b".into()]));
        // The fourth artifact is over the count; it is refused and never fetched.
        let second = import(&dir, &first.retained, &guest.manifest(&["a", "b", "c", "d"]), SMALL, |a| guest.fetch(a)).unwrap();
        assert_eq!((names(&second), guest.fetched()), (vec!["a", "b", "c"], vec!["c".to_string()]));
        assert!(second.refused.as_deref().unwrap().starts_with("1 more artifact(s) (1 bytes) exceed this task's host limit of 3 artifacts"));
        // Omitting retained artifacts neither frees the budget nor hides them.
        let omitted = import(&dir, &[], &guest.manifest(&["d"]), SMALL, |a| guest.fetch(a)).unwrap();
        assert_eq!((names(&omitted), omitted.refused.is_some(), guest.fetched()), (vec!["a", "b", "c"], true, Vec::<String>::new()));
        let reopened = import(&dir, &[], &[], SMALL, |a| guest.fetch(a)).unwrap();
        assert_eq!((names(&reopened), payloads(&dir)), (vec!["a", "b", "c"], 3));
    }

    #[test]
    fn total_bytes_are_bounded_and_admission_stops_at_the_first_artifact_that_does_not_fit() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("task");
        let guest = Guest::new(&[artifact("x", b"12345678"), artifact("y", b"12345"), artifact("z", b"1")]);
        let imported = import(&dir, &[], &guest.manifest(&["x", "y", "z"]), SMALL, |a| guest.fetch(a)).unwrap();
        assert_eq!((names(&imported), guest.fetched()), (vec!["x"], vec!["x".to_string()]));
        assert!(imported.refused.unwrap().starts_with("2 more artifact(s) (6 bytes)"));
    }

    #[test]
    fn duplicate_oversized_malformed_or_changed_declarations_import_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("task");
        let guest = Guest::new(&[artifact("a", b"1"), artifact("big", b"123456789")]);
        let a = guest.manifest(&["a"]).remove(0);
        let mut bad_sha = a.clone();
        bad_sha.sha256 = "A".repeat(64);
        let mut bad_id = a.clone();
        bad_id.id = "../escape".into();
        let mut huge = a.clone();
        huge.bytes = u64::MAX;
        let mut upper = a.clone();
        upper.id = a.id.to_uppercase();
        let mut braced = a.clone();
        braced.id = format!("{{{}}}", a.id);
        let mut simple = a.clone();
        simple.id = a.id.replace('-', "");
        for manifest in [vec![a.clone(), a.clone()], guest.manifest(&["big"]), vec![bad_sha], vec![bad_id], vec![huge],
            vec![upper.clone()], vec![braced], vec![simple], vec![a.clone(), upper]]
        {
            assert!(import(&dir, &[], &manifest, SMALL, |a| guest.fetch(a)).is_err(), "{manifest:?}");
        }
        assert!(!dir.exists() && guest.fetched().is_empty(), "refused before any read or write");
        import(&dir, &[], std::slice::from_ref(&a), SMALL, |a| guest.fetch(a)).unwrap();
        guest.fetched();
        let mut renamed = a.clone();
        renamed.name = "other".into();
        let mut resized = a.clone();
        resized.bytes = 2;
        for changed in [renamed, resized] {
            assert!(import(&dir, &[], &[changed], SMALL, |a| guest.fetch(a)).is_err());
        }
        assert_eq!((ledger(&dir), payloads(&dir), guest.fetched()), (vec!["a".to_string()], 1, Vec::<String>::new()));
        // A retained file that no longer matches its record is neither listed nor skipped silently.
        fs::write(dir.join(&a.id), b"changed").unwrap();
        assert!(import(&dir, &[], std::slice::from_ref(&a), SMALL, |a| guest.fetch(a)).is_err());
        assert!(import(&dir, &[], &[], SMALL, |a| guest.fetch(a)).unwrap().retained.is_empty());
        assert_eq!((fs::read(dir.join(&a.id)).unwrap(), guest.fetched()), (b"changed".to_vec(), Vec::<String>::new()));
    }

    #[test]
    fn a_lost_reply_or_corrupt_payload_keeps_its_reservation_and_a_retry_fetches_only_what_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("task");
        let guest = Guest::new(&[artifact("a", b"1"), artifact("b", b"2"), artifact("c", b"3"), artifact("d", b"4")]);
        let manifest = guest.manifest(&["a", "b"]);
        let mut calls = 0;
        assert!(import(&dir, &[], &manifest, SMALL, |a| {
            calls += 1;
            if calls == 2 { bail!("reply lost") } else { guest.fetch(a) }
        })
        .is_err());
        assert_eq!((ledger(&dir), payloads(&dir)), (vec!["a".to_string(), "b".into()], 1), "both admitted before fetching");
        guest.fetched();
        // A corrupt payload is never written; its reservation stays counted.
        assert!(import(&dir, &[], &manifest, SMALL, |_| Ok(b"9".to_vec())).is_err());
        assert_eq!(payloads(&dir), 1);
        // Omitting the reserved artifact frees nothing: only one more fits.
        let next = import(&dir, &[], &guest.manifest(&["c", "d"]), SMALL, |a| guest.fetch(a)).unwrap();
        assert_eq!((names(&next), guest.fetched()), (vec!["a", "c"], vec!["c".to_string()]));
        assert!(next.refused.is_some());
        let retried = import(&dir, &[], &manifest, SMALL, |a| guest.fetch(a)).unwrap();
        assert_eq!((names(&retried), guest.fetched()), (vec!["a", "b", "c"], vec!["b".to_string()]));
    }

    #[test]
    fn history_from_before_the_ledger_counts_and_is_kept() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("task");
        journal::private_directory(&dir).unwrap();
        let earlier: Vec<_> = ["p", "q", "r", "s"].iter().map(|n| artifact(n, n.as_bytes())).collect();
        for (a, bytes) in &earlier {
            journal::atomic_private_write(&dir.join(&a.id), bytes).unwrap();
        }
        let known: Vec<Artifact> = earlier.iter().map(|(a, _)| a.clone()).collect();
        let guest = Guest::new(&[artifact("new", b"n")]);
        let imported = import(&dir, &known, &guest.manifest(&["new"]), SMALL, |a| guest.fetch(a)).unwrap();
        assert_eq!(imported.retained.len(), 4, "every earlier payload is kept and counted");
        assert!(imported.refused.is_some() && guest.fetched().is_empty());
        assert!(imported.retained.iter().all(|a| known.contains(a)), "earlier metadata is reused");
        assert_eq!(ledger(&dir).len(), 4, "the seeded history is recorded once");
    }

    #[test]
    fn concurrent_polls_share_one_budget() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("task");
        journal::private_directory(&dir).unwrap();
        let one = Limits { artifacts: 1, ..SMALL };
        let candidates: Vec<_> = (0..6).map(|i| artifact(&format!("n{i}"), &[b'0' + i])).collect();
        std::thread::scope(|scope| {
            for (a, bytes) in &candidates {
                let dir = &dir;
                scope.spawn(move || import(dir, &[], std::slice::from_ref(a), one, |_| Ok(bytes.clone())).unwrap());
            }
        });
        assert_eq!((ledger(&dir).len(), payloads(&dir)), (1, 1));
    }
}
