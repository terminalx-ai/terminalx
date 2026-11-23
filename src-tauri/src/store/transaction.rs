//! Serialize an entire read/modify/atomic-replace transaction. Lock a stable
//! sidecar, never the JSON inode that `write_atomic` replaces. No callback may
//! start another transaction; reads are allowed and see the last committed file.

use std::cell::Cell;
use std::fs::{File, OpenOptions};
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
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let lock = options.open(path).context("open store transaction lock")?;
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
    loop {
        let acquired = if shared { lock.try_lock_shared() } else { lock.try_lock() };
        match acquired {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(std::fs::TryLockError::WouldBlock) => bail!("timed out waiting for the store transaction lock; no changes were written"),
            Err(std::fs::TryLockError::Error(error)) => return Err(error).context("lock store transaction"),
        }
    }
    // File drop releases the OS lock on success, error and unwinding; the OS
    // releases it on process death. Keep the sidecar itself forever.
    Ok(lock)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
