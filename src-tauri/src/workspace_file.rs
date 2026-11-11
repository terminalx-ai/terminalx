//! Open a canonical file inside a canonical workspace without following
//! symlinks swapped into its ancestors between validation and open.

use std::path::Path;

#[cfg(unix)]
pub(crate) fn open(root: &Path, path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::MetadataExt;
    let before = root.metadata()?;
    // root was canonicalized too: reject a symlink swapped into any of its
    // ancestors, rather than following one while opening the root descriptor.
    let directory = open_relative(
        std::fs::File::open("/")?,
        root.strip_prefix("/").map_err(std::io::Error::other)?,
    )?;
    let opened = directory.metadata()?;
    if before.dev() != opened.dev() || before.ino() != opened.ino() {
        return Err(std::io::Error::other("Repository directory changed."));
    }
    let relative = path.strip_prefix(root).map_err(std::io::Error::other)?;
    open_relative(directory, relative)
}

#[cfg(unix)]
pub(crate) fn open_relative(mut directory: std::fs::File, relative: &Path) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let std::path::Component::Normal(name) = component else {
            return Err(std::io::Error::other("Invalid workspace path."));
        };
        let name = std::ffi::CString::new(name.as_bytes()).map_err(std::io::Error::other)?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if components.peek().is_some() {
                libc::O_DIRECTORY
            } else {
                0
            };
        // SAFETY: directory is an owned, open fd and name is NUL-terminated.
        // Every component is resolved against the previous fd with no symlinks,
        // so replacing a parent after canonicalization cannot escape the root.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a new descriptor, owned only by this File.
        directory = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(not(unix))]
pub(crate) fn open(_root: &Path, path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn opening_rejects_a_parent_replaced_by_a_symlink_after_canonicalization() {
        use std::io::Read;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let parent = root.path().join("nested");
        std::fs::create_dir(&parent).unwrap();
        std::fs::write(parent.join(".env"), "KEY=inside").unwrap();
        std::fs::write(outside.path().join(".env"), "KEY=outside").unwrap();
        let path = parent.join(".env").canonicalize().unwrap();
        let canonical_root = root.path().canonicalize().unwrap();
        let pinned = std::fs::File::open(&parent).unwrap();
        std::fs::rename(&parent, root.path().join("original")).unwrap();
        std::os::unix::fs::symlink(outside.path(), &parent).unwrap();
        assert!(open(&canonical_root, &path).is_err());
        let mut inside = String::new();
        open_relative(pinned, Path::new(".env"))
            .unwrap()
            .read_to_string(&mut inside)
            .unwrap();
        assert_eq!(inside, "KEY=inside");
    }
}
