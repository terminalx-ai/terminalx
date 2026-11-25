//! Read-only Git inventory commands that many callers ask for at once, run
//! once for all of them (#1594).
//!
//! `git worktree list` reads every worktree's administrative files and stats
//! every checkout: a quarter of a second in a repository with a hundred
//! worktrees. Panels that poll, hook frames and sweeps all ask for it, often
//! for the same repository at the same moment. Requests for the same command
//! in the same folder share one run, and only a run that *starts after* a
//! request arrived answers it, so nobody gets a listing older than their own
//! request: a caller that has just added a worktree always sees it. At most
//! one such run per command and folder is in flight, plus one queued; across
//! folders at most [`MAX_RUNNING`] run at once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use anyhow::{anyhow, Result};

/// Shared runs in flight at once, across every folder.
const MAX_RUNNING: usize = 4;

type Key = (PathBuf, Vec<String>);
type Answer = std::result::Result<String, String>;

/// One run's answer, handed to every request that joined it.
#[derive(Default)]
struct Slot {
    answer: Mutex<Option<Answer>>,
    ready: Condvar,
}

impl Slot {
    fn publish(&self, answer: Answer) {
        *lock(&self.answer) = Some(answer);
        self.ready.notify_all();
    }

    fn wait(&self) -> Answer {
        let mut answer = lock(&self.answer);
        loop {
            if let Some(answer) = answer.as_ref() {
                return answer.clone();
            }
            answer = self.ready.wait(answer).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

#[derive(Default)]
struct Flight {
    /// A run of this command in this folder is in progress.
    running: bool,
    /// The run that starts once it finishes, and everyone waiting for it.
    next: Option<Arc<Slot>>,
}

#[derive(Default)]
struct Flights {
    flights: Mutex<(HashMap<Key, Flight>, usize)>,
    changed: Condvar,
}

fn flights() -> &'static Flights {
    static FLIGHTS: std::sync::OnceLock<Flights> = std::sync::OnceLock::new();
    FLIGHTS.get_or_init(Flights::default)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `git <args>` in `cwd`, as [`super::run`] runs it, shared with concurrent
/// requests for the same command in the same folder. For read-only commands
/// only: a joined request does not run anything itself.
pub(crate) fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    // A checkout bound to this thread starts its commands in a directory
    // other threads cannot see. Its answer is its own.
    #[cfg(unix)]
    if super::bound_at(cwd).is_some() {
        return super::run(cwd, args);
    }
    #[cfg(test)]
    REQUESTS.with(|requests| requests.set(requests.get() + 1));
    let key: Key = (cwd.to_path_buf(), args.iter().map(|arg| arg.to_string()).collect());
    shared(flights(), key, || super::run(cwd, args)).map_err(|error| anyhow!(error))
}

#[cfg(test)]
thread_local! {
    /// Shared runs this thread has asked for, so a test can bound them.
    pub(crate) static REQUESTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn shared(flights: &Flights, key: Key, run: impl FnOnce() -> Result<String>) -> Answer {
    let slot = {
        let mut state = lock(&flights.flights);
        let flight = state.0.entry(key.clone()).or_default();
        if let Some(next) = &flight.next {
            // Queued behind the run in progress, so it starts after we asked.
            let next = next.clone();
            drop(state);
            return next.wait();
        }
        let slot = Arc::new(Slot::default());
        flight.next = Some(slot.clone());
        slot
    };
    // This request runs the queued slot once the folder's current run, and
    // enough runs elsewhere, have finished.
    {
        let mut state = lock(&flights.flights);
        loop {
            let (map, running) = &mut *state;
            let flight = map.get_mut(&key).expect("a queued flight stays until it runs");
            if !flight.running && *running < MAX_RUNNING {
                flight.running = true;
                flight.next = None;
                *running += 1;
                break;
            }
            state = flights.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
    // Whatever happens to the run, its waiters are answered and the folder
    // is released.
    struct Finish<'a> {
        flights: &'a Flights,
        key: &'a Key,
        slot: &'a Slot,
        answer: Option<Answer>,
    }
    impl Drop for Finish<'_> {
        fn drop(&mut self) {
            self.slot.publish(self.answer.take().unwrap_or_else(|| Err("git stopped before it answered".into())));
            let mut state = lock(&self.flights.flights);
            let (map, running) = &mut *state;
            *running -= 1;
            if let Some(flight) = map.get_mut(self.key) {
                flight.running = false;
                if flight.next.is_none() {
                    map.remove(self.key);
                }
            }
            drop(state);
            self.flights.changed.notify_all();
        }
    }
    let mut finish = Finish { flights, key: &key, slot: &slot, answer: None };
    let answer = run().map_err(|error| format!("{error:#}"));
    finish.answer = Some(answer.clone());
    drop(finish);
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn key(folder: &str) -> Key {
        (PathBuf::from(folder), vec!["worktree".into(), "list".into()])
    }

    #[test]
    fn requests_made_while_a_run_is_in_progress_share_the_next_run() {
        let flights = Arc::new(Flights::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let (started, release) = (Arc::new(std::sync::Barrier::new(2)), Arc::new(std::sync::Barrier::new(2)));
        let first = {
            let (flights, runs, started, release) = (flights.clone(), runs.clone(), started.clone(), release.clone());
            std::thread::spawn(move || shared(&flights, key("/repo"), || {
                started.wait();
                release.wait();
                Ok(format!("run {}", runs.fetch_add(1, Ordering::SeqCst)))
            }))
        };
        started.wait();
        // Asked while run 0 is under way: none of these may be answered by it.
        let later: Vec<_> = (0..8).map(|_| {
            let (flights, runs) = (flights.clone(), runs.clone());
            std::thread::spawn(move || shared(&flights, key("/repo"), || Ok(format!("run {}", runs.fetch_add(1, Ordering::SeqCst)))))
        }).collect();
        // Every later request has queued before run 0 finishes.
        let queued = std::time::Instant::now();
        while lock(&flights.flights).0.get(&key("/repo")).is_none_or(|flight| flight.next.is_none()) {
            assert!(queued.elapsed() < Duration::from_secs(10));
            std::thread::yield_now();
        }
        std::thread::sleep(Duration::from_millis(100));
        release.wait();
        assert_eq!(first.join().unwrap().unwrap(), "run 0");
        for answer in later {
            assert_eq!(answer.join().unwrap().unwrap(), "run 1", "one fresh run answers them all");
        }
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert!(lock(&flights.flights).0.is_empty(), "a settled folder is forgotten");
    }

    #[test]
    fn a_request_after_a_run_finished_runs_again() {
        let flights = Flights::default();
        let runs = AtomicUsize::new(0);
        for expected in 0..3 {
            assert_eq!(shared(&flights, key("/repo"), || Ok(runs.fetch_add(1, Ordering::SeqCst).to_string())).unwrap(), expected.to_string());
        }
    }

    #[test]
    fn errors_reach_every_waiter_and_a_panicking_run_releases_the_folder() {
        let flights = Flights::default();
        assert_eq!(shared(&flights, key("/repo"), || Err(anyhow!("fatal: not a git repository"))).unwrap_err(), "fatal: not a git repository");
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| shared(&flights, key("/repo"), || panic!("git went away"))));
        assert!(panicked.is_err());
        assert_eq!(shared(&flights, key("/repo"), || Ok("after".into())).unwrap(), "after");
        assert_eq!(lock(&flights.flights).1, 0);
    }

    #[test]
    fn no_more_than_the_bound_run_at_once_across_folders() {
        let flights = Arc::new(Flights::default());
        let (now, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let threads: Vec<_> = (0..MAX_RUNNING * 3).map(|n| {
            let (flights, now, most) = (flights.clone(), now.clone(), most.clone());
            std::thread::spawn(move || shared(&flights, key(&format!("/repo{n}")), || {
                let running = now.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(running, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(30));
                now.fetch_sub(1, Ordering::SeqCst);
                Ok(String::new())
            }))
        }).collect();
        for thread in threads { thread.join().unwrap().unwrap(); }
        assert!(most.load(Ordering::SeqCst) <= MAX_RUNNING, "{} ran at once", most.load(Ordering::SeqCst));
    }

    #[test]
    fn shares_a_real_listing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(dir.path()).status().unwrap().success());
        let listed = run(dir.path(), &["worktree", "list", "--porcelain"]).unwrap();
        assert_eq!(listed, super::super::run(dir.path(), &["worktree", "list", "--porcelain"]).unwrap());
        assert!(run(&dir.path().join("missing"), &["worktree", "list", "--porcelain"]).is_err());
    }
}
