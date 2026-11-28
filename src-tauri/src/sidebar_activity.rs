//! Listening servers for sidebar rows. One bounded, cached probe for the whole
//! window, including servers an agent detached from its terminal.
#[cfg(unix)]
use std::collections::BTreeSet;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(unix)]
fn listener_pids(output: &str) -> Vec<u32> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix('p')?.parse().ok())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(256)
        .collect()
}

#[cfg(unix)]
fn working_directories(output: &str) -> Vec<PathBuf> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .collect()
}

fn read_directories() -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        use std::process::Command;
        let binary = if cfg!(target_os = "macos") {
            "/usr/sbin/lsof"
        } else {
            "lsof"
        };
        let mut command = Command::new(binary);
        command.args([
            "-w",
            "-nP",
            "-a",
            "-u",
            &unsafe { libc::geteuid() }.to_string(),
            "-iTCP",
            "-sTCP:LISTEN",
            "-Fp",
        ]);
        let pids = crate::git::output_within(command, Duration::from_secs(2))
            .map(|output| listener_pids(&output))
            .unwrap_or_default();
        if pids.is_empty() {
            return Vec::new();
        }
        let mut command = Command::new(binary);
        command.args([
            "-w",
            "-a",
            "-p",
            &pids
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(","),
            "-d",
            "cwd",
            "-Fn",
        ]);
        crate::git::output_within(command, Duration::from_secs(2))
            .map(|output| working_directories(&output))
            .unwrap_or_default()
    }
    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

// A main checkout must not inherit a listener in one of its nested worktrees.
fn serves(cwd: &Path, roots: &[PathBuf], listeners: &[PathBuf]) -> bool {
    listeners.iter().any(|listener| {
        listener.starts_with(cwd)
            && !roots
                .iter()
                .any(|root| root != cwd && root.starts_with(cwd) && listener.starts_with(root))
    })
}

const LISTENER_TTL: Duration = Duration::from_secs(10);
const DIRECTORY_CACHE_TTL: Duration = Duration::from_secs(300);
const DIRECTORY_CACHE_MAX_ENTRIES: usize = 512;

#[derive(Default)]
struct ListenerSlot {
    at: Option<Instant>,
    directories: Vec<PathBuf>,
    refreshing: bool,
}

/// Live sessions from the window's existing list; polling must not reread histories.
#[derive(serde::Deserialize, Clone, PartialEq, Eq)]
pub struct SessionDirectory {
    id: String,
    cwd: String,
}

#[derive(Default)]
struct DirectoryCache {
    paths: HashMap<String, (Option<PathBuf>, Instant)>,
    order: VecDeque<String>,
    last_sessions: Vec<SessionDirectory>,
    last_rows: Vec<(String, PathBuf)>,
    last_at: Option<Instant>,
}

impl DirectoryCache {
    fn resolve_rows(&mut self, sessions: Vec<SessionDirectory>, now: Instant) -> Vec<(String, PathBuf)> {
        if self.last_at.is_some_and(|at| now.saturating_duration_since(at) < DIRECTORY_CACHE_TTL)
            && self.last_sessions == sessions
        {
            return self.last_rows.clone();
        }
        let rows: Vec<(String, PathBuf)> = sessions
            .iter()
            .filter_map(|session| {
                self.canonicalize_cached(&session.cwd, now)
                    .map(|cwd| (session.id.clone(), cwd))
            })
            .collect();
        self.last_sessions = sessions;
        self.last_rows = rows.clone();
        self.last_at = Some(now);
        rows
    }

    fn canonicalize_cached(&mut self, cwd: &str, now: Instant) -> Option<PathBuf> {
        if let Some((cached, at)) = self.paths.get(cwd) {
            if now.saturating_duration_since(*at) < DIRECTORY_CACHE_TTL {
                return cached.clone();
            }
        }
        let resolved = crate::paths::canonicalize(cwd).ok();
        if !self.paths.contains_key(cwd) {
            while self.paths.len() >= DIRECTORY_CACHE_MAX_ENTRIES {
                let Some(oldest) = self.order.pop_front() else {
                    break;
                };
                self.paths.remove(&oldest);
            }
            self.order.push_back(cwd.to_owned());
        }
        self.paths.insert(cwd.to_owned(), (resolved.clone(), now));
        resolved
    }
}

/// Single-flight refresh of listening directories without holding the cache
/// mutex across `lsof` subprocesses (P-55).
fn fetch_listeners(
    slot: &(Mutex<ListenerSlot>, Condvar),
    ttl: Duration,
    probe: impl FnOnce() -> Vec<PathBuf>,
) -> Vec<PathBuf> {
    let (lock, condvar) = slot;
    {
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if state.at.is_some_and(|at| at.elapsed() < ttl) {
                return state.directories.clone();
            }
            if state.refreshing {
                state = condvar.wait(state).unwrap_or_else(|e| e.into_inner());
                continue;
            }
            state.refreshing = true;
            break;
        }
    }

    struct ResetGuard<'a> {
        lock: &'a Mutex<ListenerSlot>,
        condvar: &'a Condvar,
        done: bool,
    }
    impl Drop for ResetGuard<'_> {
        fn drop(&mut self) {
            if !self.done {
                let mut state = self.lock.lock().unwrap_or_else(|e| e.into_inner());
                state.refreshing = false;
                self.condvar.notify_all();
            }
        }
    }
    let mut guard = ResetGuard {
        lock,
        condvar,
        done: false,
    };

    let directories: Vec<PathBuf> = probe()
        .into_iter()
        .filter_map(|path| crate::paths::canonicalize(path).ok())
        .collect();

    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
    state.at = Some(Instant::now());
    state.directories = directories.clone();
    state.refreshing = false;
    guard.done = true;
    condvar.notify_all();
    directories
}

pub fn listening_sessions(sessions: Vec<SessionDirectory>) -> Vec<String> {
    static LISTENERS: OnceLock<(Mutex<ListenerSlot>, Condvar)> = OnceLock::new();
    static DIRECTORIES: OnceLock<Mutex<DirectoryCache>> = OnceLock::new();
    if sessions.is_empty() {
        return Vec::new();
    }
    let slot = LISTENERS.get_or_init(|| (Mutex::new(ListenerSlot::default()), Condvar::new()));
    let listeners = fetch_listeners(slot, LISTENER_TTL, read_directories);
    if listeners.is_empty() {
        return Vec::new();
    }
    let rows = DIRECTORIES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .resolve_rows(sessions, Instant::now());
    let roots: Vec<_> = rows.iter().map(|(_, cwd)| cwd.clone()).collect();
    rows.iter()
        .filter(|(_, cwd)| serves(cwd, &roots, &listeners))
        .map(|(id, _)| id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn parses_only_process_ids_and_absolute_working_directories() {
        assert_eq!(
            listener_pids("p12\np34\np12\npinvalid\nn127.0.0.1:8080\n"),
            [12, 34]
        );
        assert_eq!(
            working_directories("p12\nfcwd\nn/repo/a folder\np34\nnrelative\n"),
            [PathBuf::from("/repo/a folder")]
        );
    }

    #[test]
    fn attributes_ports_to_the_deepest_checkout_without_prefix_collisions() {
        let roots: Vec<_> = [
            "/repo",
            "/repo/.raccoon/worktrees/a",
            "/repo/.raccoon/worktrees/ab",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect();
        let listeners = vec![PathBuf::from("/repo/.raccoon/worktrees/ab/server")];
        assert!(!serves(&roots[0], &roots, &listeners));
        assert!(!serves(&roots[1], &roots, &listeners));
        assert!(serves(&roots[2], &roots, &listeners));
        assert!(!serves(&roots[2], &roots, &[]));
    }

    #[test]
    fn single_flight_releases_lock_during_probe_and_deduplicates_callers() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        };
        let dir = tempfile::tempdir().unwrap();
        let canonical = crate::paths::canonicalize(dir.path()).unwrap();
        let slot = Arc::new((Mutex::new(ListenerSlot::default()), Condvar::new()));
        let probe_calls = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));

        let slot_a = Arc::clone(&slot);
        let calls_a = Arc::clone(&probe_calls);
        let entered_a = Arc::clone(&entered);
        let release_a = Arc::clone(&release);
        let dir_path = dir.path().to_path_buf();
        let t1 = std::thread::spawn(move || {
            fetch_listeners(&slot_a, Duration::from_secs(10), || {
                calls_a.fetch_add(1, Ordering::SeqCst);
                entered_a.wait();
                release_a.wait();
                vec![dir_path]
            })
        });

        // Wait until t1 is inside `probe()`; the slot mutex must NOT be held.
        entered.wait();
        {
            let guard = slot.0.try_lock().expect("mutex must be released during probe");
            assert!(guard.refreshing);
        }

        let slot_b = Arc::clone(&slot);
        let calls_b = Arc::clone(&probe_calls);
        let t2 = std::thread::spawn(move || {
            fetch_listeners(&slot_b, Duration::from_secs(10), || {
                calls_b.fetch_add(1, Ordering::SeqCst);
                Vec::new()
            })
        });

        // Give t2 a moment to park on the condvar, then unblock t1's probe.
        std::thread::sleep(Duration::from_millis(15));
        release.wait();

        assert_eq!(t1.join().unwrap(), vec![canonical.clone()]);
        assert_eq!(t2.join().unwrap(), vec![canonical]);
        assert_eq!(probe_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn directory_cache_retains_entries_and_bounds_size() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        let sessions = vec![SessionDirectory {
            id: "s1".into(),
            cwd: dir.path().to_string_lossy().into_owned(),
        }];
        let first = cache.resolve_rows(sessions.clone(), now);
        assert_eq!(first.len(), 1);
        // Same session list hits cached rows even past 10s listener TTL.
        let second = cache.resolve_rows(sessions, now + Duration::from_secs(60));
        assert_eq!(second, first);

        // Bound prevents unbounded memory growth.
        for i in 0..(DIRECTORY_CACHE_MAX_ENTRIES + 32) {
            let _ = cache.canonicalize_cached(&format!("/nonexistent-sidebar-path-{i}"), now);
        }
        assert!(cache.paths.len() <= DIRECTORY_CACHE_MAX_ENTRIES);
    }
}
