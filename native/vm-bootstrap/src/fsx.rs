//! Descriptor-relative file access. Every component below a caller-opened root
//! is opened with O_NOFOLLOW from its already-open parent, so a symlink, or a
//! directory swapped for one, anywhere on the path is a refusal, not a redirect.
use std::{
    ffi::{CStr, CString},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

const DIR_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

fn check(code: libc::c_int) -> io::Result<libc::c_int> {
    if code < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(code)
    }
}

/// One path component: never empty, `.`, `..`, or containing `/` or NUL.
pub fn component(name: &str) -> io::Result<CString> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "single path component required",
        ));
    }
    CString::new(name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path component"))
}

pub fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fd is caller-owned and stat points to writable storage of the right type.
    check(unsafe { libc::fstat(fd, stat.as_mut_ptr()) })?;
    // SAFETY: fstat succeeded and initialized the structure.
    Ok(unsafe { stat.assume_init() })
}

pub fn kind(mode: libc::mode_t) -> &'static str {
    match mode & libc::S_IFMT {
        libc::S_IFREG => "file",
        libc::S_IFDIR => "directory",
        libc::S_IFLNK => "symlink",
        _ => "other",
    }
}

/// Sorted extended attribute names on an open file (quarantine, provenance, ...).
pub fn xattr_names(fd: RawFd) -> io::Result<Vec<String>> {
    // SAFETY: a NULL buffer with size 0 asks only for the required length.
    let size = unsafe { libc::flistxattr(fd, std::ptr::null_mut(), 0, 0) };
    if size < 0 {
        return Err(io::Error::last_os_error());
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let mut names = vec![0u8; size as usize];
    // SAFETY: names is writable for exactly names.len() bytes.
    let size = unsafe { libc::flistxattr(fd, names.as_mut_ptr().cast(), names.len(), 0) };
    if size < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut names: Vec<String> = names[..size as usize]
        .split(|b| *b == 0)
        .filter(|n| !n.is_empty())
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .collect();
    names.sort();
    Ok(names)
}

/// An open directory and the identity it had when opened.
pub struct Dir {
    fd: OwnedFd,
    pub stat: libc::stat,
}

impl Dir {
    /// The caller-chosen root. Only this open follows the given path as written.
    pub fn open_root(path: &Path) -> io::Result<Dir> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in root path"))?;
        // SAFETY: path is a valid C string; the descriptor is owned on success.
        let fd = check(unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        })?;
        // SAFETY: open returned a new descriptor that nothing else owns.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let stat = fstat(fd.as_raw_fd())?;
        Ok(Dir { fd, stat })
    }

    pub fn fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }

    pub fn open_dir(&self, name: &str) -> io::Result<Dir> {
        let name = component(name)?;
        // SAFETY: self.fd is open and name is a valid single component.
        let fd = check(unsafe { libc::openat(self.fd(), name.as_ptr(), DIR_FLAGS) })?;
        // SAFETY: openat returned a new descriptor that nothing else owns.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let stat = fstat(fd.as_raw_fd())?;
        Ok(Dir { fd, stat })
    }

    /// Opens `components` one at a time, calling `accept` on each directory.
    pub fn walk(
        &self,
        components: &[&str],
        mut accept: impl FnMut(&str, &Dir) -> io::Result<()>,
    ) -> io::Result<Dir> {
        let mut current: Option<Dir> = None;
        for name in components {
            let next = current.as_ref().unwrap_or(self).open_dir(name)?;
            accept(name, &next)?;
            current = Some(next);
        }
        match current {
            Some(dir) => Ok(dir),
            None => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "empty directory path",
            )),
        }
    }

    /// lstat of one entry; `None` when it does not exist.
    pub fn stat_at(&self, name: &str) -> io::Result<Option<libc::stat>> {
        let name = component(name)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: valid descriptor, component and writable stat storage.
        let code = unsafe {
            libc::fstatat(
                self.fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if code != 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(libc::ENOENT) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        // SAFETY: fstatat succeeded and initialized the structure.
        Ok(Some(unsafe { stat.assume_init() }))
    }

    pub fn make_dir(&self, name: &str, mode: libc::mode_t) -> io::Result<()> {
        let name = component(name)?;
        // SAFETY: valid descriptor and component.
        check(unsafe { libc::mkdirat(self.fd(), name.as_ptr(), mode) }).map(drop)
    }

    fn open_file(&self, name: &str, flags: libc::c_int, mode: libc::mode_t) -> io::Result<File> {
        let name = component(name)?;
        let flags = flags | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: valid descriptor and component; mode is passed as the variadic argument.
        let fd = check(unsafe {
            libc::openat(self.fd(), name.as_ptr(), flags, libc::c_uint::from(mode))
        })?;
        // SAFETY: openat returned a new descriptor that nothing else owns.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    /// A new file that must not already exist under any name or link.
    pub fn create_new(&self, name: &str, mode: libc::mode_t) -> io::Result<File> {
        self.open_file(name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, mode)
    }

    pub fn open_append(&self, name: &str, mode: libc::mode_t) -> io::Result<File> {
        self.open_file(name, libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT, mode)
    }

    /// Opens without blocking on a FIFO and requires a regular file.
    pub fn open_regular(&self, name: &str) -> io::Result<(File, libc::stat)> {
        let file = self.open_file(name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
        let stat = fstat(file.as_raw_fd())?;
        if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "regular file required",
            ));
        }
        Ok((file, stat))
    }

    /// Entry names, excluding `.` and `..`.
    pub fn entries(&self) -> io::Result<Vec<String>> {
        // fdopendir takes ownership, so give it a duplicate.
        // SAFETY: self.fd is open; dup returns a new owned descriptor on success.
        let copy = check(unsafe { libc::dup(self.fd()) })?;
        // SAFETY: copy is an open directory descriptor now owned by the DIR stream.
        let stream = unsafe { libc::fdopendir(copy) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: fdopendir failed, so copy is still ours to close.
            unsafe { libc::close(copy) };
            return Err(error);
        }
        // SAFETY: rewind the shared offset so a reused descriptor lists everything.
        unsafe { libc::rewinddir(stream) };
        let mut names = Vec::new();
        loop {
            // SAFETY: stream is a live DIR*; readdir returns NULL at the end.
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            // SAFETY: d_name is NUL-terminated within the returned entry.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            let name = name.to_string_lossy();
            if name != "." && name != ".." {
                names.push(name.into_owned());
            }
        }
        // SAFETY: stream is live and closed exactly once, which also closes copy.
        unsafe { libc::closedir(stream) };
        names.sort();
        Ok(names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::fs::symlink};

    #[test]
    fn components_are_single_names() {
        for bad in ["", ".", "..", "a/b", "/abs", "nul\0"] {
            assert!(component(bad).is_err(), "{bad:?}");
        }
        assert!(component("Application Support").is_ok());
    }

    #[test]
    fn walk_refuses_symlinked_directories_anywhere() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("a/b")).unwrap();
        symlink(outside.path(), temp.path().join("a/link")).unwrap();
        let root = Dir::open_root(temp.path()).unwrap();
        assert!(root.walk(&["a", "b"], |_, _| Ok(())).is_ok());
        let error = root.walk(&["a", "link"], |_, _| Ok(())).err().unwrap();
        assert!(
            matches!(
                error.raw_os_error(),
                Some(libc::ELOOP) | Some(libc::ENOTDIR)
            ),
            "{error}"
        );
        assert_eq!(
            root.stat_at("a").unwrap().map(|s| kind(s.st_mode)),
            Some("directory")
        );
        let link = root
            .open_dir("a")
            .unwrap()
            .stat_at("link")
            .unwrap()
            .unwrap();
        assert_eq!(kind(link.st_mode), "symlink");
    }

    #[test]
    fn file_opens_never_follow_or_replace() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"untouched").unwrap();
        symlink(&outside, temp.path().join("link")).unwrap();
        let root = Dir::open_root(temp.path()).unwrap();
        assert_eq!(
            root.create_new("link", 0o600).err().unwrap().raw_os_error(),
            Some(libc::EEXIST)
        );
        assert_eq!(
            root.open_append("link", 0o600)
                .err()
                .unwrap()
                .raw_os_error(),
            Some(libc::ELOOP)
        );
        assert_eq!(
            root.open_regular("link").err().unwrap().raw_os_error(),
            Some(libc::ELOOP)
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
        let mut file = root.create_new("new", 0o600).unwrap();
        file.write_all(b"x").unwrap();
        assert_eq!(
            root.create_new("new", 0o600).err().unwrap().raw_os_error(),
            Some(libc::EEXIST)
        );
        assert!(root.stat_at("absent").unwrap().is_none());
    }

    #[test]
    fn regular_open_refuses_fifo_and_directory_without_blocking() {
        let temp = tempfile::tempdir().unwrap();
        let fifo = CString::new(temp.path().join("fifo").as_os_str().as_bytes()).unwrap();
        // SAFETY: valid C path; creates a FIFO in the disposable directory.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        std::fs::create_dir(temp.path().join("dir")).unwrap();
        let root = Dir::open_root(temp.path()).unwrap();
        assert!(root.open_regular("fifo").is_err());
        assert!(root.open_regular("dir").is_err());
    }

    #[test]
    fn entries_and_xattrs_are_reported() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("b"), b"").unwrap();
        std::fs::create_dir(temp.path().join("a")).unwrap();
        let root = Dir::open_root(temp.path()).unwrap();
        assert_eq!(root.entries().unwrap(), ["a", "b"]);
        assert_eq!(
            root.entries().unwrap(),
            ["a", "b"],
            "repeatable on one descriptor"
        );
        let (file, _) = root.open_regular("b").unwrap();
        // This process may be provenance-tracked; that tag is the only one allowed here.
        let before = xattr_names(file.as_raw_fd()).unwrap();
        assert!(
            before.iter().all(|n| n == "com.apple.provenance"),
            "{before:?}"
        );
        let name = CString::new("com.apple.quarantine").unwrap();
        // SAFETY: valid descriptor, attribute name and value buffer.
        let code = unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                b"0081;".as_ptr().cast(),
                5,
                0,
                0,
            )
        };
        assert_eq!(code, 0, "{}", io::Error::last_os_error());
        assert!(xattr_names(file.as_raw_fd())
            .unwrap()
            .contains(&"com.apple.quarantine".to_owned()));
    }
}
