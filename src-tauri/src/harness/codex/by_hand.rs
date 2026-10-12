//! A Codex the reader started by hand (#437): which conversation it is in.
//!
//! Codex keeps no file that maps a process to a conversation, but the
//! process holds the conversation's own files open for as long as it is in
//! it, and its open files can be listed. Which Codex home they are in comes
//! with them: the reader's own, not the one the app manages for the tabs it
//! launches.
//!
//! Probed on codex-cli 0.153.4, typed into a shell in a PTY. The package's
//! `codex` is a node launcher that starts the native program as its child;
//! only the native one holds anything of the conversation's:
//!
//! - `<home>/thread-writer-locks/<id>.lock`, from about 0.3 s after it
//!   starts and before any prompt. `<id>` is the conversation's;
//! - `<home>/sessions/YYYY/MM/DD/rollout-<started>-<id>.jsonl`, created by
//!   the first prompt and held open from then on. `codex resume <id>` has
//!   the existing rollout open from the start, with its lock, and appends
//!   to it;
//! - `/new` takes another lock, and the next prompt opens another rollout,
//!   while the files of the conversation before stay open. So the newest
//!   lock is the conversation the process is in now.
//!
//! `codex exec` holds a lock and a rollout too; it never has the terminal
//! raw, so it is never looked at here (`crate::foreground`).

use std::path::{Path, PathBuf};

use crate::session::follow::Located;

/// The conversation id a rollout is named for: the 36 characters before `.jsonl`.
fn rollout_id(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    uuid::Uuid::parse_str(id).ok().map(|_| id)
}

/// A rollout is `<home>/sessions/<year>/<month>/<day>/<file>`.
fn is_rollout(path: &Path) -> bool {
    rollout_id(path).is_some() && path.ancestors().nth(4).and_then(Path::file_name).is_some_and(|dir| dir == "sessions")
}

/// The conversation a lock file is for.
fn locked(path: &Path) -> Option<&str> {
    let id = path.file_name()?.to_str()?.strip_suffix(".lock")?;
    (path.parent()?.file_name()? == "thread-writer-locks" && uuid::Uuid::parse_str(id).is_ok()).then_some(id)
}

/// The conversation among a process's open files: the one whose lock it took
/// last, with that conversation's rollout once it has one open. With no lock
/// in sight, the rollout it opened last (their names sort by when each
/// conversation started).
fn located_among(open: &[PathBuf]) -> Option<Located> {
    let rollouts: Vec<&PathBuf> = open.iter().filter(|path| is_rollout(path)).collect();
    let taken = |lock: &&PathBuf| std::fs::metadata(lock).and_then(|meta| meta.created().or_else(|_| meta.modified())).ok();
    let newest_lock = open.iter().filter(|path| locked(path).is_some()).max_by_key(taken).and_then(|path| locked(path));
    match newest_lock {
        Some(id) => Some(Located { provider_session_id: id.to_string(), transcript: rollouts.iter().find(|rollout| rollout_id(rollout) == Some(id)).map(|rollout| (*rollout).clone()) }),
        None => {
            let rollout = rollouts.into_iter().max_by_key(|rollout| rollout.file_name().map(|name| name.to_os_string()))?;
            Some(Located { provider_session_id: rollout_id(rollout)?.to_string(), transcript: Some(rollout.clone()) })
        }
    }
}

pub fn locate(pid: u32) -> Option<Located> {
    located_among(&crate::harness::host::open_files(pid))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: &str = "01a0814c-460b-75d1-b691-d8c3ba980644";
    const SECOND: &str = "01a08199-0d2f-7c43-8a50-1f2e3d4c5b6a";

    /// A Codex home with real lock files, since which lock is newest is asked of the disk.
    struct Home(tempfile::TempDir);

    impl Home {
        fn new() -> Self {
            let home = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(home.path().join("thread-writer-locks")).unwrap();
            Self(home)
        }

        fn lock(&self, id: &str) -> PathBuf {
            // Locks taken one after another, however coarse the disk's clock.
            std::thread::sleep(std::time::Duration::from_millis(20));
            let path = self.0.path().join("thread-writer-locks").join(format!("{id}.lock"));
            std::fs::write(&path, "").unwrap();
            path
        }

        fn rollout(&self, started: &str, id: &str) -> PathBuf {
            self.0.path().join("sessions/2026/10/12").join(format!("rollout-{started}-{id}.jsonl"))
        }
    }

    #[test]
    fn a_new_conversation_is_known_by_its_lock_before_it_has_a_rollout() {
        let home = Home::new();
        let open = vec![PathBuf::from("/dev/ttys004"), home.0.path().join("logs_2.sqlite"), home.lock(FIRST)];
        assert_eq!(located_among(&open), Some(Located { provider_session_id: FIRST.into(), transcript: None }));
        // The first prompt makes the rollout, which the process then has open.
        let rollout = home.rollout("2026-10-12T17-57-34", FIRST);
        let open = [open, vec![rollout.clone()]].concat();
        assert_eq!(located_among(&open), Some(Located { provider_session_id: FIRST.into(), transcript: Some(rollout) }));
    }

    #[test]
    fn the_newest_lock_is_the_conversation_the_process_is_in_now() {
        let home = Home::new();
        let (first_lock, first_rollout) = (home.lock(FIRST), home.rollout("2026-10-12T17-57-34", FIRST));
        // `/new`: another lock, and the files of the conversation before stay open.
        let second_lock = home.lock(SECOND);
        let open = vec![first_rollout.clone(), second_lock.clone(), first_lock.clone()];
        assert_eq!(located_among(&open), Some(Located { provider_session_id: SECOND.into(), transcript: None }));
        let second_rollout = home.rollout("2026-10-12T18-03-10", SECOND);
        let open = vec![first_rollout.clone(), second_rollout.clone(), second_lock, first_lock];
        assert_eq!(located_among(&open), Some(Located { provider_session_id: SECOND.into(), transcript: Some(second_rollout.clone()) }));
        // With no lock to go by, the rollout of the conversation that started last.
        assert_eq!(located_among(&[second_rollout.clone(), first_rollout]), Some(Located { provider_session_id: SECOND.into(), transcript: Some(second_rollout) }));
    }

    #[test]
    fn files_that_only_look_like_a_conversation_are_not_one() {
        for path in [
            // Not under a `sessions` folder's year, month and day.
            format!("/tmp/rollout-2026-10-12T13-37-21-{FIRST}.jsonl"),
            format!("/Users/me/notes/sessions/rollout-2026-{FIRST}.jsonl"),
            // No conversation id in the name.
            "/Users/me/.codex/sessions/2026/10/12/rollout-notes.jsonl".to_string(),
            "/Users/me/.codex/thread-writer-locks/not-an-id.lock".to_string(),
            format!("/Users/me/.codex/other-locks/{FIRST}.lock"),
        ] {
            assert_eq!(located_among(&[PathBuf::from(&path)]), None, "{path}");
        }
    }
}
