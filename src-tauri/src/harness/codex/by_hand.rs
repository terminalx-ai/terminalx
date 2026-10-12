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
//! `codex exec` holds a lock and a rollout too. It is never looked at here:
//! a run with no screen is not taken for a session (`crate::foreground`).
//!
//! Listing a process's open files means starting `lsof`, a fifth of a second
//! or more each time, so it is not done on every look. Whatever moves a
//! process to another conversation takes a lock, and a lock is a file made
//! in the locks folder, which changes that folder's date. Once a
//! conversation and its rollout are known, the files are listed again only
//! when that date has moved, or after `ASK_AGAIN` in case something moved
//! without it.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use crate::session::follow::Located;

/// How long what was found is trusted with no sign of a change.
const ASK_AGAIN: Duration = Duration::from_secs(30);

/// What a Codex was last found in, and what would show it has moved on.
#[derive(Debug, Clone)]
pub struct Seen {
    pub found: Located,
    /// The folder its locks are taken in, and when that folder last changed.
    locks: Option<(PathBuf, Option<SystemTime>)>,
    asked: Instant,
}

fn changed(folder: &Path) -> Option<SystemTime> {
    std::fs::metadata(folder).and_then(|meta| meta.modified()).ok()
}

impl Seen {
    /// Whether nothing says the process has moved on since it was asked.
    fn stands(&self) -> bool {
        let unmoved = self.locks.as_ref().is_some_and(|(folder, at)| changed(folder) == *at);
        self.found.transcript.is_some() && unmoved && self.asked.elapsed() < ASK_AGAIN
    }
}

/// The folder a set of open files has its locks in.
fn locks_folder(open: &[PathBuf]) -> Option<PathBuf> {
    open.iter().find(|path| locked(path).is_some()).and_then(|lock| lock.parent()).map(Path::to_path_buf)
}

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

/// [`look`], with the listing of a process's open files given.
fn look_with(pids: &[u32], last: Option<Seen>, open_files: impl Fn(u32) -> Vec<PathBuf>) -> Option<Seen> {
    if let Some(last) = last.as_ref().filter(|last| last.stands()) {
        return Some(last.clone());
    }
    // Read before the files are listed: a lock taken while they are being
    // listed then shows as a change the next time, and is asked about.
    let before = last.and_then(|last| last.locks).map(|(folder, _)| {
        let at = changed(&folder);
        (folder, at)
    });
    // The package's launcher holds nothing; the program it starts does.
    pids.iter().rev().find_map(|pid| {
        let open = open_files(*pid);
        let found = located_among(&open)?;
        let locks = locks_folder(&open).map(|folder| match &before {
            Some((known, at)) if *known == folder => (folder, *at),
            _ => {
                let at = changed(&folder);
                (folder, at)
            }
        });
        Some(Seen { found, locks, asked: Instant::now() })
    })
}

/// The conversation the Codex running as `pids` is in. `last` is what it was
/// found in the time before: while nothing says it has moved on, that is
/// the answer and no process is started to find it.
pub fn look(pids: &[u32], last: Option<Seen>) -> Option<Seen> {
    look_with(pids, last, crate::harness::host::open_files)
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

    /// A Codex left at its prompt is looked at for as long as it runs. Its
    /// open files are only listed again when a lock has been taken.
    #[test]
    fn a_settled_conversation_is_not_asked_about_again_until_a_lock_is_taken() {
        let home = Home::new();
        let (lock, rollout) = (home.lock(FIRST), home.rollout("2026-10-12T17-57-34", FIRST));
        let asked = std::cell::Cell::new(0);
        let open = std::cell::RefCell::new(vec![lock]);
        let list = |_pid: u32| {
            asked.set(asked.get() + 1);
            open.borrow().clone()
        };
        // With no rollout yet it is asked every time: the first prompt takes no lock.
        let seen = look_with(&[7], None, list).unwrap();
        assert_eq!(seen.found.transcript, None);
        let seen = look_with(&[7], Some(seen), list).unwrap();
        assert_eq!(asked.get(), 2);
        open.borrow_mut().push(rollout.clone());
        let seen = look_with(&[7], Some(seen), list).unwrap();
        assert_eq!((asked.get(), seen.found.transcript.clone()), (3, Some(rollout.clone())));
        // Settled: looked at again and again, and nothing is listed.
        let seen = (0..5).fold(seen, |seen, _| look_with(&[7], Some(seen), list).unwrap());
        assert_eq!(asked.get(), 3);
        // `/new` takes a lock, and that is seen at the next look.
        open.borrow_mut().push(home.lock(SECOND));
        let seen = look_with(&[7], Some(seen), list).unwrap();
        assert_eq!((asked.get(), seen.found), (4, Located { provider_session_id: SECOND.into(), transcript: None }));
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
