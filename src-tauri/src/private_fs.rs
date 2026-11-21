//! Files and directories only this user can open: `0o600`/`0o700` and the
//! uid checks that go with them on Unix, an owner-only DACL on Windows (see
//! `win::security`). One set of functions, so a caller never has to choose a
//! platform's way of saying "private".
use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{bail, Context, Result};

/// Refuse `path` unless it is a real directory (not a link) owned by this
/// user that no other account can open.
pub(crate) fn verify_dir(path: &Path, what: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).with_context(|| format!("inspect {what}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            bail!("{what} must be an owner-only directory, not a symlink");
        }
    }
    #[cfg(windows)]
    {
        if !metadata.is_dir() || crate::win::fs::is_reparse_point(path)? {
            bail!("{what} must be an owner-only directory, not a link");
        }
        crate::win::security::verify_private(path).with_context(|| format!("{what} must be an owner-only directory"))?;
    }
    Ok(())
}

/// Create `path` as an owner-only directory, or accept the one there if it
/// already is one. Its parent must exist.
#[cfg(windows)]
pub(crate) fn create_dir(path: &Path, what: &str) -> Result<()> {
    match crate::win::fs::create_private_dir(path) {
        Ok(()) => {}
        // An existing directory is checked below with a clearer message.
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
        Err(error) => return Err(error).with_context(|| format!("create {what}")),
    }
    verify_dir(path, what)
}

/// Open an existing private regular file for reading, refusing a link, a
/// file another account owns or can open, or one with more than one name.
pub(crate) fn open_file(path: &Path, what: &str) -> Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path).with_context(|| format!("open {what}"))?;
        let metadata = file.metadata()?;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            bail!("{what} is not a private regular file");
        }
        Ok(file)
    }
    #[cfg(windows)]
    {
        crate::win::fs::open_private(path).with_context(|| format!("{what} is not a private regular file"))
    }
}

/// A short private secret: the whole file, trimmed, at most `max` bytes.
pub(crate) fn read_secret(path: &Path, max: u64, what: &str) -> Result<zeroize::Zeroizing<String>> {
    let file = open_file(path, what)?;
    if file.metadata()?.len() > max {
        bail!("{what} is not valid");
    }
    let mut text = zeroize::Zeroizing::new(String::new());
    file.take(max).read_to_string(&mut text)?;
    let trimmed = zeroize::Zeroizing::new(text.trim().to_string());
    if trimmed.is_empty() {
        bail!("{what} is empty");
    }
    Ok(trimmed)
}

/// Create (or open) `path` as an owner-only regular file for writing.
/// `truncate` empties an existing one.
#[cfg(windows)]
pub(crate) fn create_file(path: &Path, truncate: bool) -> std::io::Result<File> {
    crate::win::fs::create_private(path, truncate)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn a_private_directory_and_secret_round_trip() {
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join("run");
        create_dir(&run, "run directory").unwrap();
        create_dir(&run, "run directory").unwrap();
        let token = run.join("control.token");
        create_file(&token, true).unwrap().write_all(b"  secret\n").unwrap();
        assert_eq!(read_secret(&token, 256, "token").unwrap().as_str(), "secret");
        assert!(read_secret(&token, 3, "token").is_err(), "longer than allowed");
        std::fs::hard_link(&token, run.join("second-name")).unwrap();
        assert!(open_file(&token, "token").is_err(), "a file with two names is refused");
    }
}
