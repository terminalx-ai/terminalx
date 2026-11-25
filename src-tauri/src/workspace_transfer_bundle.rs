//! A cloud-to-local transfer bundle contains one
//! pinned branch and never supplies a destination path or updates a ref.

use anyhow::{bail, ensure, Context, Result};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

const BUNDLE_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(feature = "desktop")]
const MAX_CHECKOUT_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(feature = "desktop")]
const MAX_CHECKOUT_ENTRIES: usize = 100_000;
pub(crate) const CHUNK_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BranchCommit {
    branch_ref: String,
    commit: String,
}

impl BranchCommit {
    pub(crate) fn commit(&self) -> &str {
        &self.commit
    }

    pub(crate) fn branch(&self) -> &str {
        self.branch_ref
            .strip_prefix("refs/heads/")
            .expect("validated branch")
    }

    pub(crate) fn new(branch: &str, commit: &str) -> Result<Self> {
        ensure!(
            crate::remote::git::valid_ref_name(branch),
            "invalid transfer branch"
        );
        ensure!(
            matches!(commit.len(), 40 | 64) && commit.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "transfer needs a full commit id"
        );
        Ok(Self {
            branch_ref: format!("refs/heads/{branch}"),
            commit: commit.to_ascii_lowercase(),
        })
    }
}

pub(crate) struct TransferBundle {
    _directory: tempfile::TempDir,
    path: PathBuf,
    size: u64,
}

impl TransferBundle {
    pub(crate) fn size(&self) -> u64 {
        self.size
    }

    /// Read from the private, verified export. The attachment handler must
    /// authorize the current peer before returning each chunk.
    pub(crate) fn read_chunk(&self, offset: u64) -> Result<Vec<u8>> {
        ensure!(
            offset <= self.size,
            "transfer offset exceeds the bundle size"
        );
        let mut file = std::fs::File::open(&self.path)?;
        ensure!(
            file.metadata()?.len() == self.size,
            "the transfer bundle changed"
        );
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; (self.size - offset).min(CHUNK_BYTES) as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

pub(crate) fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let mut command = crate::git::git_in(repo, args);
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1");
    crate::git::output_within(command, BUNDLE_TIMEOUT)
        .map_err(|error| anyhow::anyhow!("transfer bundle: {error}"))
}

fn path_argument(path: &Path) -> Result<&str> {
    ensure!(
        path.is_absolute(),
        "transfer bundle needs a native storage path"
    );
    path.to_str().context("unsupported transfer bundle path")
}

pub(crate) fn export(repo: &Path, expected: &BranchCommit) -> Result<TransferBundle> {
    let head = git(repo, &["rev-parse", "--verify", &expected.branch_ref])?;
    ensure!(
        head.trim() == expected.commit,
        "cloud branch changed before export"
    );
    let directory = tempfile::Builder::new()
        .prefix("terminalx-transfer-")
        .tempdir()?;
    let path = directory.path().join("workspace.bundle");
    let base = ["@{upstream}", "refs/remotes/origin/HEAD"]
        .into_iter()
        .filter_map(|reference| git(repo, &["merge-base", expected.commit(), reference]).ok())
        .map(|base| base.trim().to_owned())
        .find(|base| base != expected.commit());
    let exclude = base.map(|base| format!("^{base}"));
    let mut args = vec![
        "bundle",
        "create",
        path_argument(&path)?,
        &expected.branch_ref,
    ];
    if let Some(exclude) = &exclude {
        args.push(exclude);
    }
    git(repo, &args)?;
    check_head(repo, &path, expected)?;
    let size = std::fs::metadata(&path)?.len();
    Ok(TransferBundle {
        _directory: directory,
        path,
        size,
    })
}

fn check_head(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<()> {
    let heads = git(repo, &["bundle", "list-heads", path_argument(bundle)?])?;
    let mut heads = heads.lines();
    let Some((commit, reference)) = heads.next().and_then(|line| line.split_once(' ')) else {
        bail!("the transfer bundle has no branch");
    };
    ensure!(
        commit == expected.commit && reference == expected.branch_ref && heads.next().is_none(),
        "the transfer bundle does not match the selected branch and commit"
    );
    Ok(())
}

/// Load Git objects only. The caller can create the named branch and
/// worktree after the transcript and destination have both been validated.
pub(crate) fn import_objects(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<()> {
    check_head(repo, bundle, expected)?;
    let bundle = path_argument(bundle)?;
    git(repo, &["bundle", "verify", bundle])?;
    git(
        repo,
        &[
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
            "-c",
            "fetch.unpackLimit=1",
            "fetch",
            "--no-write-fetch-head",
            "--no-tags",
            "--no-auto-maintenance",
            "--no-recurse-submodules",
            bundle,
            &expected.branch_ref,
        ],
    )?;
    git(
        repo,
        &["cat-file", "-e", &format!("{}^{{commit}}", expected.commit)],
    )?;
    Ok(())
}

/// Bound the contents Git will materialize before creating a worktree.
#[cfg(feature = "desktop")]
pub(crate) fn validate_checkout(repo: &Path, expected: &BranchCommit) -> Result<()> {
    let args = ["ls-tree", "-r", "-l", "-z", expected.commit()];
    let command = crate::git::git_in(repo, &args);
    let listing = crate::git::output_with_limit(command, &args, BUNDLE_TIMEOUT, 16 * 1024 * 1024)
        .map_err(|error| anyhow::anyhow!("transfer tree: {error}"))?;
    validate_listing(&listing, MAX_CHECKOUT_BYTES, MAX_CHECKOUT_ENTRIES)
}

#[cfg(feature = "desktop")]
fn validate_listing(listing: &str, max_bytes: u64, max_entries: usize) -> Result<()> {
    let mut size = 0u64;
    for (index, record) in listing.split_terminator('\0').enumerate() {
        ensure!(
            index < max_entries,
            "The Git checkout has too many entries to transfer"
        );
        let (metadata, _) = record.split_once('\t').context("Invalid Git tree entry")?;
        let mut fields = metadata.split_whitespace();
        let mode = fields.next().context("Missing Git tree mode")?;
        let object = fields.next().context("Missing Git tree object type")?;
        fields.next().context("Missing Git tree object ID")?;
        let bytes = fields.next().context("Missing Git tree object size")?;
        match (mode, object) {
            ("100644" | "100755" | "120000", "blob") => {
                size = size
                    .checked_add(bytes.parse()?)
                    .context("The Git checkout is too large to transfer")?;
                ensure!(
                    size <= max_bytes,
                    "The Git checkout is too large to transfer"
                );
            }
            ("160000", "commit") => {}
            _ => bail!("Unsupported Git tree entry"),
        }
    }
    Ok(())
}

/// Install the pinned commit only after the caller has verified the imported
/// transcript and selected the destination. A concurrent branch creation
/// wins. An existing matching branch can be used on retry.
pub(crate) fn ensure_local_branch(repo: &Path, expected: &BranchCommit) -> Result<bool> {
    let commit = format!("{}^{{commit}}", expected.commit);
    let resolved = git(repo, &["rev-parse", "--verify", &commit])?;
    ensure!(
        resolved.trim() == expected.commit,
        "transfer object is not the pinned commit"
    );

    let absent = "0".repeat(expected.commit.len());
    let create = git(
        repo,
        &[
            "update-ref",
            &expected.branch_ref,
            &expected.commit,
            &absent,
        ],
    );
    if create.is_ok() {
        return Ok(true);
    }

    let existing = git(repo, &["rev-parse", "--verify", &expected.branch_ref]);
    if existing
        .as_ref()
        .is_ok_and(|head| head.trim() == expected.commit)
    {
        return Ok(false);
    }
    if existing.is_ok() {
        bail!("a local branch with this name already points to a different commit");
    }
    create.map(|_| true)
}

#[cfg(feature = "desktop")]
pub(crate) fn checkout(repo: &Path, path: &Path, expected: &BranchCommit) -> Result<()> {
    ensure!(!path.exists(), "Transfer checkout path already exists");
    std::fs::create_dir_all(path.parent().context("No worktree directory")?)?;
    git(
        repo,
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "add",
            "--no-checkout",
            path_argument(path)?,
            expected.branch(),
        ],
    )?;
    let populate = (|| {
        let actual = git(path, &["rev-parse", "--verify", "HEAD"])?;
        ensure!(
            actual.trim() == expected.commit(),
            "The local branch moved during checkout"
        );
        git(
            path,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "filter.lfs.process=",
                "-c",
                "filter.lfs.smudge=",
                "-c",
                "filter.lfs.required=false",
                "reset",
                "--hard",
                expected.commit(),
            ],
        )?;
        Ok(())
    })();
    if let Err(error) = populate {
        let cleanup = git(
            repo,
            &["worktree", "remove", "--force", path_argument(path)?],
        );
        return match cleanup {
            Ok(_) => Err(error),
            Err(cleanup) => Err(error.context(format!(
                "Could not remove the unfinished transfer checkout: {cleanup}"
            ))),
        };
    }
    Ok(())
}

#[cfg(feature = "desktop")]
pub(crate) fn rollback_branch(repo: &Path, expected: &BranchCommit) -> Result<()> {
    let attached = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(worktreepath)",
            &expected.branch_ref,
        ],
    )?;
    ensure!(
        attached.trim().is_empty(),
        "The transfer branch is checked out and was kept"
    );
    git(
        repo,
        &["update-ref", "-d", &expected.branch_ref, expected.commit()],
    )?;
    Ok(())
}

#[cfg(feature = "desktop")]
pub(crate) fn rollback_checkout(repo: &Path, path: &Path, expected: &BranchCommit) -> Result<()> {
    ensure!(
        crate::git::is_worktree_of(repo, path),
        "Transfer checkout ownership changed"
    );
    let actual = git(path, &["rev-parse", "--verify", "HEAD"])?;
    ensure!(
        actual.trim() == expected.commit(),
        "Transfer checkout has changed"
    );
    git(repo, &["worktree", "remove", path_argument(path)?])?;
    Ok(())
}

#[derive(serde::Deserialize, serde::Serialize)]
// Transcript tags are lowercase. Message fields use the webview wire convention.
#[serde(
    tag = "role",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TranscriptMessage {
    User { text: String },
    Assistant { text: String },
}

#[derive(Debug, thiserror::Error)]
#[error("This workspace is too large to transfer")]
pub(crate) struct TransferTooLarge;

#[derive(Default)]
struct TranscriptExport {
    bytes: Vec<u8>,
    assistant_seen: bool,
}

impl TranscriptExport {
    fn event(&mut self, event: &crate::events::AgentEvent, max_bytes: usize) -> Result<()> {
        use crate::events::Payload;
        let (text, user) = match &event.payload {
            Payload::UserMessage {
                text,
                queued: false,
                ..
            } => {
                self.assistant_seen = false;
                (text, true)
            }
            Payload::TurnStarted { .. } => {
                self.assistant_seen = false;
                return Ok(());
            }
            Payload::AssistantText { text, .. }
                if event.subagent.is_none() && !text.trim().is_empty() =>
            {
                self.assistant_seen = true;
                (text, false)
            }
            Payload::TurnCompleted {
                final_text: Some(text),
                ..
            } if !self.assistant_seen && event.subagent.is_none() => {
                self.assistant_seen = true;
                (text, false)
            }
            _ => return Ok(()),
        };
        let remaining = max_bytes.saturating_sub(self.bytes.len());
        if text.len() >= remaining {
            return Err(TransferTooLarge.into());
        }
        let message = if user {
            TranscriptMessage::User { text: text.clone() }
        } else {
            TranscriptMessage::Assistant { text: text.clone() }
        };
        let encoded = serde_json::to_vec(&message)?;
        if encoded.len().saturating_add(2) > remaining {
            return Err(TransferTooLarge.into());
        }
        self.bytes
            .push(if self.bytes.is_empty() { b'[' } else { b',' });
        self.bytes.extend_from_slice(&encoded);
        Ok(())
    }

    fn finish(mut self) -> Vec<u8> {
        if self.bytes.is_empty() {
            self.bytes.push(b'[');
        }
        self.bytes.push(b']');
        self.bytes
    }
}

pub(crate) fn transcript_file(path: &Path, max_bytes: usize) -> Result<Vec<u8>> {
    use std::io::BufRead;
    let mut export = TranscriptExport::default();
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(export.finish()),
        Err(error) => return Err(error.into()),
    };
    for line in std::io::BufReader::new(file).lines() {
        if let Ok(event) = serde_json::from_str::<crate::events::AgentEvent>(&line?) {
            export.event(&event, max_bytes)?;
        }
    }
    Ok(export.finish())
}

#[cfg(feature = "desktop")]
pub(crate) fn save_transcript(
    session: &crate::store::index::SessionEntry,
    messages: Vec<TranscriptMessage>,
) -> Result<()> {
    use crate::events::AgentEvent;
    use serde_json::json;
    use std::io::Write;
    let tab = session.tabs.first().context("No local conversation")?;
    let mut log = Vec::new();
    let mut sequence = 0;
    let mut write_event = |payload| -> Result<()> {
        sequence += 1;
        let event: AgentEvent = serde_json::from_value(json!({
            "id": uuid::Uuid::new_v4().to_string(), "sessionId": session.id, "tabId": tab.id,
            "harness": tab.harness, "seq": sequence, "ts": session.created,
            "payload": payload,
        }))?;
        serde_json::to_writer(&mut log, &event)?;
        log.push(b'\n');
        Ok(())
    };
    let mut turn = false;
    for message in messages {
        match message {
            TranscriptMessage::User { text } => {
                if turn {
                    write_event(json!({ "type": "turn_completed", "status": "ok" }))?;
                }
                write_event(json!({ "type": "user_message", "text": text }))?;
            }
            TranscriptMessage::Assistant { text } => {
                write_event(json!({ "type": "assistant_text", "text": text }))?
            }
        }
        turn = true;
    }
    if turn {
        write_event(json!({ "type": "turn_completed", "status": "ok" }))?;
    }
    let path = crate::store::log_path(&session.id, &tab.id)?;
    let mut staged =
        tempfile::NamedTempFile::new_in(path.parent().context("No transcript directory")?)?;
    staged.write_all(&log)?;
    staged.as_file().sync_all()?;
    staged
        .persist_noclobber(path)
        .context("The local conversation already has a transcript")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(path: &Path) {
        std::fs::create_dir(path).unwrap();
        git(path, &["init", "-q", "-b", "main"]).unwrap();
        git(path, &["config", "user.name", "Fixture"]).unwrap();
        git(path, &["config", "user.email", "fixture@example.test"]).unwrap();
    }

    fn commit(repo: &Path) -> String {
        git(
            repo,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        )
        .unwrap();
        git(repo, &["rev-parse", "HEAD"]).unwrap().trim().into()
    }

    #[test]
    fn exports_the_branch_without_a_remote_and_imports_its_objects_without_moving_a_local_ref() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        repository(&local);
        git(&cloud, &["switch", "-c", "topic/one"]).unwrap();
        let source = BranchCommit::new("topic/one", &commit(&cloud)).unwrap();
        let local_head = commit(&local);
        let bundle = export(&cloud, &source).unwrap();
        let mut received = Vec::new();
        while (received.len() as u64) < bundle.size() {
            let bytes = bundle.read_chunk(received.len() as u64).unwrap();
            assert!(!bytes.is_empty());
            assert!(bytes.len() as u64 <= CHUNK_BYTES);
            received.extend(bytes);
        }
        assert!(bundle.read_chunk(bundle.size()).unwrap().is_empty());
        assert!(bundle.read_chunk(bundle.size() + 1).is_err());
        let incoming = temp.path().join("incoming.bundle");
        std::fs::write(&incoming, received).unwrap();
        import_objects(&local, &incoming, &source).unwrap();
        assert_eq!(
            git(&local, &["rev-parse", "HEAD"]).unwrap().trim(),
            local_head
        );
        assert!(git(&local, &["show-ref", "--verify", &source.branch_ref]).is_err());
        assert_eq!(
            git(&local, &["cat-file", "-t", &source.commit])
                .unwrap()
                .trim(),
            "commit"
        );
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn refuses_an_oversized_or_overpopulated_checkout() {
        let listing = "100644 blob abcd 8\tsource\0".repeat(2);
        assert!(validate_listing(&listing, 16, 2).is_ok());
        assert!(validate_listing(&listing, 15, 2).is_err());
        assert!(validate_listing(&listing, 16, 1).is_err());
        assert!(validate_listing("invalid\0", 16, 1).is_err());
    }

    #[test]
    fn exports_an_origin_delta_without_updating_the_remote_branch() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("origin");
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&origin);
        let base = commit(&origin);
        let source = origin.to_str().unwrap();
        for checkout in [&cloud, &local] {
            git(
                temp.path(),
                &["clone", "-q", source, checkout.to_str().unwrap()],
            )
            .unwrap();
            git(checkout, &["config", "user.name", "Fixture"]).unwrap();
            git(checkout, &["config", "user.email", "fixture@example.test"]).unwrap();
        }
        let head = commit(&cloud);
        let selected = BranchCommit::new("main", &head).unwrap();
        let bundle = export(&cloud, &selected).unwrap();
        assert_eq!(git(&origin, &["rev-parse", "main"]).unwrap().trim(), base);
        import_objects(&local, &bundle.path, &selected).unwrap();
        assert_eq!(git(&local, &["rev-parse", "main"]).unwrap().trim(), base);
        let missing_base = temp.path().join("missing-base");
        repository(&missing_base);
        assert!(import_objects(&missing_base, &bundle.path, &selected).is_err());
    }

    #[test]
    fn creates_only_the_pinned_local_branch_and_refuses_to_replace_it() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        repository(&local);
        let first = commit(&local);
        let second = commit(&local);
        let selected = BranchCommit::new("topic", &first).unwrap();
        assert!(ensure_local_branch(&local, &selected).unwrap());
        assert!(!ensure_local_branch(&local, &selected).unwrap());
        let conflicting = BranchCommit::new("topic", &second).unwrap();
        assert!(ensure_local_branch(&local, &conflicting).is_err());
        assert_eq!(git(&local, &["rev-parse", "topic"]).unwrap().trim(), first);
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).unwrap().trim(), second);
    }

    #[test]
    fn bounds_each_chunk_and_rejects_a_changed_snapshot_length() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.bundle");
        let mut bytes = vec![1; CHUNK_BYTES as usize];
        bytes.extend_from_slice(&[2, 3]);
        std::fs::write(&path, &bytes).unwrap();
        let bundle = TransferBundle {
            _directory: directory,
            path,
            size: bytes.len() as u64,
        };
        assert_eq!(
            bundle.read_chunk(0).unwrap(),
            &bytes[..CHUNK_BYTES as usize]
        );
        assert_eq!(bundle.read_chunk(CHUNK_BYTES).unwrap(), [2, 3]);
        std::fs::write(&bundle.path, [0]).unwrap();
        assert!(bundle.read_chunk(0).is_err());
    }

    #[test]
    fn refuses_a_moved_branch_and_an_unexpected_bundle_head() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        repository(&local);
        let initial = BranchCommit::new("main", &commit(&cloud)).unwrap();
        let bundle = export(&cloud, &initial).unwrap();
        let moved = BranchCommit::new("main", &commit(&cloud)).unwrap();
        assert!(export(&cloud, &initial).is_err());
        assert!(import_objects(&local, &bundle.path, &moved).is_err());
        assert!(git(&local, &["cat-file", "-e", &initial.commit]).is_err());
    }
}
