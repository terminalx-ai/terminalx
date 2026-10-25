//! Serialize an entire read/modify/atomic-replace transaction. Lock a stable
//! sidecar, never the JSON inode that `write_atomic` replaces. No callback may
//! start another transaction; reads are allowed and see the last committed file.

use std::cell::Cell;
use std::fs::OpenOptions;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

thread_local! { static ACTIVE: Cell<bool> = const { Cell::new(false) }; }

pub(super) fn run<T>(path: &Path, timeout: Duration, update: impl FnOnce() -> Result<T>) -> Result<T> {
    if ACTIVE.with(|active| active.replace(true)) {
        bail!("nested store transactions are not supported");
    }
    struct Active;
    impl Drop for Active { fn drop(&mut self) { ACTIVE.with(|active| active.set(false)); } }
    let _active = Active;
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
    let deadline = Instant::now() + timeout;
    loop {
        match lock.try_lock() {
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
    update()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwinding_releases_both_the_file_lock_and_reentrancy_guard() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("index.lock");
        let panicked = std::panic::catch_unwind(|| {
            let _: Result<()> = run(&path, Duration::ZERO, || panic!("fixture panic"));
        });
        assert!(panicked.is_err());
        assert_eq!(run(&path, Duration::ZERO, || Ok(42)).unwrap(), 42);
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
