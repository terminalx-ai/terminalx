//! Design stage 9, guest side ("Retirement and person control"). After the
//! owner acknowledges the helper's final report over the verified session, the
//! helper removes exactly the three items the seed profile placed: the
//! enrollment key first, then the plist, then its own executable. Each is
//! unlinked through its parent's descriptor, and only while it, and its parent
//! directory, still have the identity this launch recorded before enrolling.
//! The intent is journaled before anything is checked or removed and the
//! outcome after, so a refused, partial or interrupted retirement stays an
//! inspection item: it is never repeated, never reseeded and never reported as
//! retired.
use crate::{
    enroll::Session,
    fsx::{self, Dir},
    seed::{self, Item},
    wire::Stream,
};
use serde_json::{json, Value};
use std::{
    io,
    path::{Path, PathBuf},
};

pub const INTENT: &str = "retirement-intent.json";
pub const RESULT: &str = "retirement.json";
/// Removal order over the profile's items (plist, program, key): the secret
/// first, then the plist so launchd cannot start the helper again, then the
/// executable.
const ORDER: [usize; 3] = [2, 0, 1];

fn refused(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason)
}

fn record(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("JSON values always serialize")
}

fn hex64(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// The owner's acknowledgement of this helper's final report. No public
/// constructor: only a frame tagged under the verified session makes one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Acknowledgement {
    /// Digest of the acknowledgement frame's body, echoed in the report.
    pub sha256: String,
    /// The owner's committed host-key observation record.
    pub observation_sha256: String,
}

impl Acknowledgement {
    /// Exactly `{retire: {challengeSha256, hostKeySha256, observationSha256}}`
    /// naming this session's challenge and the digest of `final_report`, the
    /// body this helper last sent.
    pub(crate) fn from_body(
        body: &Value,
        challenge_sha256: &str,
        final_report: &Value,
    ) -> io::Result<Acknowledgement> {
        let inner = body
            .as_object()
            .filter(|o| o.len() == 1)
            .and_then(|o| o.get("retire"))
            .and_then(Value::as_object)
            .filter(|i| i.len() == 3)
            .ok_or_else(|| refused("not a retirement acknowledgement"))?;
        if inner.get("challengeSha256").and_then(Value::as_str) != Some(challenge_sha256)
            || inner.get("hostKeySha256").and_then(Value::as_str)
                != Some(crate::sha256(&record(final_report)).as_str())
            || !inner.get("observationSha256").is_some_and(hex64)
        {
            return Err(refused(
                "the acknowledgement is for another session or report",
            ));
        }
        Ok(Acknowledgement {
            sha256: crate::sha256(&record(body)),
            observation_sha256: inner["observationSha256"]
                .as_str()
                .unwrap_or_default()
                .into(),
        })
    }
}

impl Session {
    /// The only way to obtain an `Acknowledgement`: the next owner frame,
    /// tagged under this verified session, for this session's challenge and
    /// the exact final report this helper sent.
    pub fn receive_acknowledgement(
        &mut self,
        stream: &mut impl Stream,
        challenge_sha256: &str,
        final_report: &Value,
    ) -> io::Result<Acknowledgement> {
        Acknowledgement::from_body(&self.receive(stream)?, challenge_sha256, final_report)
    }
}

/// What a seeded item and its parent directory were when recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    parent: (i32, u64),
    file: (i32, u64),
    mode: u16,
    uid: u32,
    size: i64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

impl Identity {
    fn of(parent: &Dir, stat: &libc::stat) -> Identity {
        Identity {
            parent: (parent.stat.st_dev, parent.stat.st_ino),
            file: (stat.st_dev, stat.st_ino),
            mode: stat.st_mode,
            uid: stat.st_uid,
            size: stat.st_size,
            mtime: (stat.st_mtime, stat.st_mtime_nsec),
            ctime: (stat.st_ctime, stat.st_ctime_nsec),
        }
    }

    fn to_json(self) -> Value {
        json!({"device": self.file.0, "inode": self.file.1, "mode": self.mode, "uid": self.uid,
            "size": self.size, "parentDevice": self.parent.0, "parentInode": self.parent.1})
    }
}

/// The item's parent, opened one component at a time from `root` without
/// following links, every directory owned by `owner` and writable by no one
/// else, and the item: a single-link regular file owned by `owner` with its
/// seeded mode.
fn open_item(root: &Path, owner: u32, item: &Item) -> io::Result<(Dir, Identity)> {
    let guard = |dir: &Dir| {
        if dir.stat.st_uid != owner || dir.stat.st_mode & 0o022 != 0 {
            return Err(refused(
                "a seeded item's directory is writable by another account",
            ));
        }
        Ok(())
    };
    let top = Dir::open_root(root)?;
    guard(&top)?;
    let parent = top.walk(item.dirs, |_, dir| guard(dir))?;
    if item.private_dir && parent.stat.st_mode & 0o077 != 0 {
        return Err(refused("the enrollment directory is not private"));
    }
    let stat = parent
        .stat_at(item.name)?
        .ok_or_else(|| refused("a seeded item is missing"))?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_mode & 0o7777 != item.mode
        || stat.st_uid != owner
        || stat.st_nlink != 1
    {
        return Err(refused("a seeded item is not as the seed placed it"));
    }
    let identity = Identity::of(&parent, &stat);
    Ok((parent, identity))
}

/// The seed profile's three items as this launch found them.
pub struct Seeded {
    root: PathBuf,
    owner: u32,
    found: Vec<Identity>,
}

/// Records the production profile's items under `root` (`/` in production),
/// each owned by `owner` (root in production). Refuses unless all three are
/// exactly as the seed places them.
pub fn seeded(root: &Path, owner: u32) -> io::Result<Seeded> {
    let found = seed::PRODUCTION
        .items
        .iter()
        .map(|item| open_item(root, owner, item).map(|(_, identity)| identity))
        .collect::<io::Result<Vec<_>>>()?;
    Ok(Seeded {
        root: root.to_path_buf(),
        owner,
        found,
    })
}

/// Unlinks one item through its parent, checked again just before, and then
/// confirmed absent.
fn remove(parent: &Dir, item: &Item, found: &Identity) -> io::Result<()> {
    let now = parent.stat_at(item.name)?;
    if now.map(|stat| Identity::of(parent, &stat)) != Some(*found) {
        return Err(refused("a seeded item changed before its removal"));
    }
    let name = fsx::component(item.name)?;
    // SAFETY: a live directory descriptor and one checked name component.
    if unsafe { libc::unlinkat(parent.fd(), name.as_ptr(), 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fsync of the open parent makes the removal durable.
    if unsafe { libc::fsync(parent.fd()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if parent.stat_at(item.name)?.is_some() {
        return Err(refused("a seeded item is still present"));
    }
    Ok(())
}

/// After `acknowledgement`: journals the intent in `state`, requires every
/// item to be exactly as recorded, removes them in `ORDER` and journals the
/// outcome: `retired` only when all three are confirmed absent, `refused` when
/// anything changed before a removal (nothing is removed), and
/// `outcomeUnknown` after a failed removal. `step` runs after each removal;
/// an error from it stops there as a crash would, leaving the intent without
/// an outcome. A second call finds the intent and refuses.
pub fn retire(
    state: &Dir,
    seeded: &Seeded,
    acknowledgement: &Acknowledgement,
    mut step: impl FnMut(usize) -> io::Result<()>,
) -> io::Result<Value> {
    let items = &seed::PRODUCTION.items;
    let recorded: Vec<Value> = items
        .iter()
        .zip(&seeded.found)
        .map(|(item, identity)| json!({"item": item.key, "identity": identity.to_json()}))
        .collect();
    state.publish_new(
        INTENT,
        &record(&json!({"acknowledgementSha256": acknowledgement.sha256,
            "observationSha256": acknowledgement.observation_sha256, "items": recorded, "version": 1})),
    )?;
    let finish = |stage: &str, removed: &[&str], reason: Option<String>| -> io::Result<Value> {
        let outcome = json!({"acknowledgementSha256": acknowledgement.sha256, "reason": reason,
            "removed": removed, "stage": stage, "version": 1});
        state.publish_new(RESULT, &record(&outcome))?;
        Ok(outcome)
    };
    let mut parents = Vec::new();
    for (item, found) in items.iter().zip(&seeded.found) {
        match open_item(&seeded.root, seeded.owner, item) {
            Ok((parent, now)) if now == *found => parents.push(parent),
            Ok(_) => return finish("refused", &[], Some(format!("{} changed", item.key))),
            Err(error) => return finish("refused", &[], Some(format!("{}: {error}", item.key))),
        }
    }
    let mut removed = Vec::new();
    for (step_index, &index) in ORDER.iter().enumerate() {
        let item = &items[index];
        if let Err(error) = remove(&parents[index], item, &seeded.found[index]) {
            return finish(
                "outcomeUnknown",
                &removed,
                Some(format!("{}: {error}", item.key)),
            );
        }
        removed.push(item.key);
        step(step_index)?;
    }
    finish("retired", &removed, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn euid() -> u32 {
        // SAFETY: no preconditions.
        unsafe { libc::geteuid() }
    }

    fn mode(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn path(root: &Path, item: &Item) -> PathBuf {
        item.dirs
            .iter()
            .fold(root.to_path_buf(), |p, c| p.join(c))
            .join(item.name)
    }

    /// A disposable root with the production profile's items, an unrelated
    /// neighbour beside each, and the helper's state directory.
    fn root() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        for item in &seed::PRODUCTION.items {
            let file = path(temp.path(), item);
            let parent = file.parent().unwrap();
            std::fs::create_dir_all(parent).unwrap();
            let mut dir = parent.to_path_buf();
            while dir != temp.path() {
                mode(&dir, 0o755);
                dir = dir.parent().unwrap().to_path_buf();
            }
            if item.private_dir {
                mode(parent, 0o700);
            }
            std::fs::write(&file, item.key).unwrap();
            mode(&file, item.mode.into());
            std::fs::write(parent.join("neighbour"), b"not seeded").unwrap();
        }
        temp
    }

    fn state(root: &Path) -> Dir {
        Dir::open_root(path(root, &seed::PRODUCTION.items[2]).parent().unwrap()).unwrap()
    }

    fn acknowledgement() -> Acknowledgement {
        let report = json!({"hostKey": {"keyReference": "r", "publicKey": "k"}});
        let body = json!({"retire": {"challengeSha256": "a".repeat(64),
            "hostKeySha256": crate::sha256(&record(&report)), "observationSha256": "b".repeat(64)}});
        Acknowledgement::from_body(&body, &"a".repeat(64), &report).unwrap()
    }

    fn present(root: &Path) -> Vec<bool> {
        seed::PRODUCTION
            .items
            .iter()
            .map(|item| std::fs::symlink_metadata(path(root, item)).is_ok())
            .collect()
    }

    fn neighbours(root: &Path) -> usize {
        seed::PRODUCTION
            .items
            .iter()
            .filter(|item| path(root, item).with_file_name("neighbour").exists())
            .count()
    }

    fn journal(root: &Path, name: &str) -> Option<Value> {
        let file = path(root, &seed::PRODUCTION.items[2]).with_file_name(name);
        std::fs::read(file)
            .ok()
            .map(|b| serde_json::from_slice(&b).unwrap())
    }

    #[test]
    fn only_an_exact_acknowledgement_of_this_session_and_report_is_accepted() {
        let report = json!({"hostKey": {"keyReference": "r", "publicKey": "k"}});
        let challenge = "a".repeat(64);
        let good = json!({"retire": {"challengeSha256": challenge,
            "hostKeySha256": crate::sha256(&record(&report)), "observationSha256": "b".repeat(64)}});
        let accepted = Acknowledgement::from_body(&good, &challenge, &report).unwrap();
        assert_eq!(accepted.sha256, crate::sha256(&record(&good)));
        let changed = |f: fn(&mut Value)| {
            let mut body = good.clone();
            f(&mut body);
            body
        };
        for bad in [
            changed(|b| b["retire"]["challengeSha256"] = json!("c".repeat(64))),
            changed(|b| b["retire"]["hostKeySha256"] = json!("d".repeat(64))),
            changed(|b| b["retire"]["observationSha256"] = json!("B".repeat(64))),
            changed(|b| b["retire"]["extra"] = json!(true)),
            changed(|b| b["also"] = json!({})),
            json!({"retire": {}}),
            json!({"hostKeyPending": {"keyReference": "r"}}),
        ] {
            assert!(
                Acknowledgement::from_body(&bad, &challenge, &report).is_err(),
                "{bad}"
            );
        }
        let other_report = json!({"hostKey": {"keyReference": "r", "publicKey": "other"}});
        assert!(Acknowledgement::from_body(&good, &challenge, &other_report).is_err());
    }

    #[test]
    fn retirement_removes_exactly_the_three_seeded_items_once() {
        let temp = root();
        let seeded = seeded(temp.path(), euid()).unwrap();
        let state = state(temp.path());
        let outcome = retire(&state, &seeded, &acknowledgement(), |_| Ok(())).unwrap();
        assert_eq!(outcome["stage"], "retired");
        assert_eq!(outcome["removed"], json!(["key", "plist", "program"]));
        assert_eq!(present(temp.path()), [false, false, false]);
        assert_eq!(
            neighbours(temp.path()),
            3,
            "nothing beside the seeded items is touched"
        );
        assert_eq!(journal(temp.path(), RESULT).unwrap(), outcome);
        let intent = journal(temp.path(), INTENT).unwrap();
        assert_eq!(intent["acknowledgementSha256"], acknowledgement().sha256);
        assert_eq!(intent["items"].as_array().unwrap().len(), 3);
        assert!(
            retire(&state, &seeded, &acknowledgement(), |_| Ok(())).is_err(),
            "never a second retirement"
        );
        assert_eq!(journal(temp.path(), RESULT).unwrap(), outcome);
    }

    #[test]
    fn a_changed_substituted_or_linked_item_refuses_and_removes_nothing() {
        type Change = fn(&Path);
        let cases: [(&str, Change); 6] = [
            ("replaced program", |r| {
                let p = path(r, &seed::PRODUCTION.items[1]);
                std::fs::remove_file(&p).unwrap();
                std::fs::write(&p, "program").unwrap();
                mode(&p, 0o755);
            }),
            ("symlinked plist", |r| {
                let p = path(r, &seed::PRODUCTION.items[0]);
                std::fs::rename(&p, r.join("elsewhere.plist")).unwrap();
                std::os::unix::fs::symlink(r.join("elsewhere.plist"), &p).unwrap();
            }),
            ("linked key", |r| {
                std::fs::hard_link(path(r, &seed::PRODUCTION.items[2]), r.join("alias")).unwrap()
            }),
            ("changed mode", |r| {
                mode(&path(r, &seed::PRODUCTION.items[0]), 0o664)
            }),
            ("rewritten key", |r| {
                std::fs::write(path(r, &seed::PRODUCTION.items[2]), "other").unwrap()
            }),
            ("substituted directory", |r| {
                let p = path(r, &seed::PRODUCTION.items[0]);
                let dir = p.parent().unwrap();
                std::fs::rename(dir, r.join("Library/Moved")).unwrap();
                std::fs::create_dir(dir).unwrap();
                mode(dir, 0o755);
                std::fs::copy(r.join("Library/Moved").join(p.file_name().unwrap()), &p).unwrap();
                mode(&p, 0o644);
            }),
        ];
        for (name, change) in cases {
            let temp = root();
            let seeded = seeded(temp.path(), euid()).unwrap();
            change(temp.path());
            let outcome =
                retire(&state(temp.path()), &seeded, &acknowledgement(), |_| Ok(())).unwrap();
            assert_eq!(outcome["stage"], "refused", "{name}");
            assert_eq!(outcome["removed"], json!([]), "{name}");
            let still = seed::PRODUCTION
                .items
                .iter()
                .filter(|item| std::fs::symlink_metadata(path(temp.path(), item)).is_ok())
                .count();
            assert_eq!(still, 3, "{name}: nothing is removed");
        }
        // Not exactly seeded at launch: nothing is recorded to retire.
        let temp = root();
        mode(&path(temp.path(), &seed::PRODUCTION.items[1]), 0o775);
        assert!(seeded(temp.path(), euid()).is_err());
        assert!(seeded(root().path(), euid() + 1).is_err(), "another owner");
    }

    #[test]
    fn an_interrupted_or_failed_retirement_is_never_reported_retired_or_repeated() {
        {
            // Interrupted after the first removal, as by a crash: the intent stays
            // without an outcome, and a later call refuses to start again.
            let temp = root();
            let seeded = seeded(temp.path(), euid()).unwrap();
            let state = state(temp.path());
            let crash = retire(&state, &seeded, &acknowledgement(), |index| {
                if index == 0 {
                    Err(io::Error::other("stopped"))
                } else {
                    Ok(())
                }
            });
            assert!(crash.is_err());
            // Profile order is plist, program, key; the key went first.
            assert_eq!(present(temp.path()), [true, true, false]);
            assert!(journal(temp.path(), INTENT).is_some());
            assert!(journal(temp.path(), RESULT).is_none());
            assert!(retire(&state, &seeded, &acknowledgement(), |_| Ok(())).is_err());
            assert_eq!(present(temp.path()), [true, true, false], "no repeat");
        }

        {
            // A removal that fails: an unknown outcome naming what was removed.
            let temp = root();
            let seeded = seeded(temp.path(), euid()).unwrap();
            let plist_dir = path(temp.path(), &seed::PRODUCTION.items[0])
                .parent()
                .unwrap()
                .to_path_buf();
            mode(&plist_dir, 0o555);
            let outcome =
                retire(&state(temp.path()), &seeded, &acknowledgement(), |_| Ok(())).unwrap();
            mode(&plist_dir, 0o755);
            assert_eq!(outcome["stage"], "outcomeUnknown");
            assert_eq!(outcome["removed"], json!(["key"]));
            assert_eq!(present(temp.path()), [true, true, false]);
        }
    }
}
