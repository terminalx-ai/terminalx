//! A path made absolute and resolved, in the form the rest of the system
//! reads.
//!
//! On Windows `std::fs::canonicalize` answers with a verbatim path
//! (`\\?\C:\...`). Git, the agent CLIs and the reader do not take that form:
//! git reads `\\?\c:` in a remote as an SSH host and cannot `mkdir` a
//! worktree under it. The verbatim prefix is dropped wherever the ordinary
//! path names the same file, which is every path short and plain enough for
//! the ordinary form (`dunce`). On macOS and Linux this is
//! `std::fs::canonicalize` exactly.
use std::io;
use std::path::{Path, PathBuf};

/// [`std::fs::canonicalize`], without Windows' verbatim prefix where the
/// ordinary path means the same.
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    #[cfg(windows)]
    {
        dunce::canonicalize(path)
    }
    #[cfg(not(windows))]
    {
        std::fs::canonicalize(path)
    }
}

/// `path` in the ordinary form where that names the same file: a resolved
/// path too long for it keeps Windows' verbatim prefix (`\\?\`), and the
/// same path spelled two ways must still compare equal.
pub fn simplified(path: &Path) -> &Path {
    #[cfg(windows)]
    {
        dunce::simplified(path)
    }
    #[cfg(not(windows))]
    {
        path
    }
}

/// Whether `a` and `b` are the same path once each is [`simplified`].
pub fn same(a: &Path, b: &Path) -> bool {
    simplified(a) == simplified(b)
}

/// [`canonicalize`] as a method of a path, where `Path::canonicalize` would
/// be called.
pub trait Canonical {
    fn canonical(&self) -> io::Result<PathBuf>;
}

impl<P: AsRef<Path> + ?Sized> Canonical for P {
    fn canonical(&self) -> io::Result<PathBuf> {
        canonicalize(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_resolved_path_is_absolute_and_in_the_ordinary_form() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = canonicalize(dir.path()).unwrap();
        assert!(resolved.is_absolute());
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"), "{}", resolved.display());
        assert_eq!(dir.path().canonical().unwrap(), resolved);
        assert_eq!(canonicalize(resolved.join("..").join(dir.path().file_name().unwrap())).unwrap(), resolved);
    }
}
