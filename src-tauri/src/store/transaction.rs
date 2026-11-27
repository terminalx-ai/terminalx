//! Serialize an entire read/modify/atomic-replace transaction. Lock a stable
//! sidecar, never the JSON inode that `write_atomic` replaces. No callback may
//! start another transaction; reads are allowed and see the last committed file.

use std::cell::Cell;
use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

thread_local! { static ACTIVE: Cell<bool> = const { Cell::new(false) }; }

pub(crate) fn run<T>(path: &Path, timeout: Duration, update: impl FnOnce() -> Result<T>) -> Result<T> {
    write(path, None, timeout, update)
}

/// A writer keeps the admission lock while existing readers drain. New
/// readers cannot acquire the data lock until that writer finishes.
pub(crate) fn run_with_readers<T>(path: &Path, admission: &Path, timeout: Duration, update: impl FnOnce() -> Result<T>) -> Result<T> {
    write(path, Some(admission), timeout, update)
}

fn write<T>(path: &Path, admission: Option<&Path>, timeout: Duration, update: impl FnOnce() -> Result<T>) -> Result<T> {
    if ACTIVE.with(|active| active.replace(true)) {
        bail!("nested store transactions are not supported");
    }
    struct Active;
    impl Drop for Active { fn drop(&mut self) { ACTIVE.with(|active| active.set(false)); } }
    let _active = Active;
    let deadline = Instant::now() + timeout;
    let _admission = admission.map(|path| lock(path, deadline, false)).transpose()?;
    let _lock = lock(path, deadline, false)?;
    update()
}

/// Hold a read of a credential through a bounded delivery in another process.
pub(crate) fn read_lock(path: &Path, admission: &Path, timeout: Duration) -> Result<File> {
    let deadline = Instant::now() + timeout;
    let _admission = lock(admission, deadline, false)?;
    lock(path, deadline, true)
}

fn lock(path: &Path, deadline: Instant, shared: bool) -> Result<File> {
    #[cfg(unix)]
    let lock = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        options.open(path).context("open store transaction lock")?
    };
    // Owner-only, and a link or a file with a second name is refused rather
    // than followed: the checks below on Unix.
    #[cfg(windows)]
    let lock = crate::win::fs::create_private(path, false).context("open store transaction lock")?;
    let metadata = lock.metadata()?;
    if !metadata.is_file() { bail!("store transaction lock is not a regular file"); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            bail!("store transaction lock is not private");
        }
    }
    let acquired = if shared { lock.try_lock_shared() } else { lock.try_lock() };
    match acquired {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                bail!("timed out waiting for the store transaction lock; no changes were written");
            }
            // Wait using a blocking OS flock/LockFileEx call so the kernel wakes
            // us immediately on release instead of polling in a 5ms sleep loop.
            let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let cancelled_waiter = std::sync::Arc::clone(&cancelled);
            let (tx, rx) = std::sync::mpsc::sync_channel::<std::io::Result<File>>(1);
            std::thread::Builder::new()
                .name("store-tx-lock".into())
                .spawn(move || {
                    let res = if shared { lock.lock_shared() } else { lock.lock() };
                    match res {
                        Ok(()) => {
                            if cancelled_waiter.load(std::sync::atomic::Ordering::Acquire)
                                || tx.send(Ok(lock)).is_err()
                            {
                                // Caller timed out; drop immediately to release the OS lock.
                            }
                        }
                        Err(err) => {
                            let _ = tx.send(Err(err));
                        }
                    }
                })
                .context("spawn store transaction lock waiter")?;
            match rx.recv_timeout(remaining) {
                Ok(Ok(file)) => return Ok(file),
                Ok(Err(error)) => return Err(error).context("lock store transaction"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    cancelled.store(true, std::sync::atomic::Ordering::Release);
                    // Drain in case the waiter sent just before seeing `cancelled`.
                    let _ = rx.try_recv();
                    bail!("timed out waiting for the store transaction lock; no changes were written");
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    bail!("store transaction lock waiter exited unexpectedly");
                }
            }
        }
        Err(std::fs::TryLockError::Error(error)) => return Err(error).context("lock store transaction"),
    }
    // File drop releases the OS lock on success, error and unwinding; the OS
    // releases it on process death. Keep the sidecar itself forever.
    Ok(lock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn a_transaction_lock_with_a_second_name_is_refused_and_the_other_file_stays_unlocked() {
        let dir = tempfile::tempdir().unwrap();
        let other = dir.path().join("someone-elses-file");
        std::fs::write(&other, b"kept").unwrap();
        let lock_path = dir.path().join(".transaction.lock");
        std::fs::hard_link(&other, &lock_path).unwrap();
        assert!(lock(&lock_path, Instant::now(), false).is_err(), "a lock with a second name is refused");
        // Had it been taken, Windows' mandatory lock would now keep this file from being locked or written.
        let still = std::fs::OpenOptions::new().read(true).write(true).open(&other).unwrap();
        still.try_lock().expect("the other file was never locked");
        drop(still);
        assert_eq!(std::fs::read(&other).unwrap(), b"kept");
    }

    #[cfg(windows)]
    #[test]
    fn a_transaction_lock_that_is_a_symbolic_link_is_refused_and_nothing_is_made_at_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("made-through-the-link");
        let lock_path = dir.path().join(".transaction.lock");
        // Creating a symbolic link needs Developer Mode or an administrator.
        if std::os::windows::fs::symlink_file(&target, &lock_path).is_err() {
            return;
        }
        assert!(lock(&lock_path, Instant::now(), false).is_err());
        assert!(!target.exists(), "a dangling link is not followed to create its target");
    }

    #[cfg(windows)]
    #[test]
    fn a_new_transaction_lock_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join(".transaction.lock");
        drop(lock(&lock_path, Instant::now() + Duration::from_secs(1), false).unwrap());
        crate::win::security::verify_private(&lock_path).unwrap();
    }

    #[test]
    fn credential_reader_keeps_an_exclusive_update_waiting() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("devices.lock");
        let admission = fixture.path().join("devices-admission.lock");
        let output = read_lock(&path, &admission, Duration::ZERO).unwrap();
        assert!(run_with_readers::<()>(&path, &admission, Duration::ZERO, || panic!("update ran during output")).is_err());
        // Model a writer that has taken its place ahead of this reader and
        // is still waiting for the first output. The second read cannot barge in.
        let writer = lock(&admission, Instant::now(), false).unwrap();
        assert!(read_lock(&path, &admission, Duration::ZERO).is_err());
        drop(output);
        let _exclusive = lock(&path, Instant::now() + Duration::from_secs(10), false).unwrap();
        drop(writer);
    }

    #[test]
    fn unwinding_releases_both_the_file_lock_and_reentrancy_guard() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("index.lock");
        let panicked = std::panic::catch_unwind(|| {
            let _: Result<()> = run(&path, Duration::ZERO, || panic!("fixture panic"));
        });
        assert!(panicked.is_err());
        // A child another test forks shares the lock's file until it execs, so
        // this waits a little; a lock the unwinding kept would never be free.
        assert_eq!(run(&path, Duration::from_secs(10), || Ok(42)).unwrap(), 42);
    }

    #[cfg(unix)]
    #[test]
    fn refuse_symlink_and_nonprivate_lock_without_running_the_mutation() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let target = fixture.path().join("other");
        std::fs::write(&target, b"untouched").unwrap();
        let path = fixture.path().join("index.lock");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(run(&path, Duration::ZERO, || -> Result<()> { panic!("symlink admitted"); }).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(run(&path, Duration::ZERO, || -> Result<()> { panic!("public lock admitted"); }).is_err());
    }

    #[test]
    fn contended_lock_wakes_via_blocking_flock_and_respects_timeout() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("contended.lock");
        let held = lock(&path, Instant::now() + Duration::from_secs(1), false).unwrap();

        // Finite timeout expires while the lock is held.
        let started = Instant::now();
        let timed_out = run(&path, Duration::from_millis(30), || Ok(()));
        assert!(timed_out.is_err());
        assert!(started.elapsed() >= Duration::from_millis(25));

        // Releasing the lock wakes a waiting acquirer promptly via OS flock.
        let path_for_thread = path.clone();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            drop(held);
        });
        let value = run(&path_for_thread, Duration::from_secs(5), || Ok(99)).unwrap();
        releaser.join().unwrap();
        assert_eq!(value, 99);
    }
}
