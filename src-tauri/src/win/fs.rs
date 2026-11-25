//! Private files and directories on Windows: what `0o600` and `0o700` are on
//! Unix. The owner-only descriptor is applied *as* the object is created, so
//! there is no moment in which another account could open it.
use std::fs::File;
use std::io;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::Path;

use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, CREATE_NEW, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
};

use super::security::{verify_private, wide_path, Descriptor};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// Whether `path` is a link of any kind (symlink, junction, mount point).
pub(crate) fn is_reparse_point(path: &Path) -> io::Result<bool> {
    Ok(std::fs::symlink_metadata(path)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

/// What names one file on this machine, as `(st_dev, st_ino)` does on Unix:
/// the volume's serial number and the file's NTFS index. Unlike a creation
/// time, which NTFS carries over to a file made under a name just freed
/// ("tunnelling"), a replacement always has another.
pub(crate) fn file_id(file: &File) -> io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    // SAFETY: an all-zero struct is a valid out-parameter.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: a live handle and an out-struct of the right type.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(info.dwVolumeSerialNumber), (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)))
}

/// Create `path` as a new file only this user (and SYSTEM) can open. Anything
/// already at `path`, a link included, is an `AlreadyExists` error: it is
/// never opened, so never followed. What `O_CREAT | O_EXCL` gives on Unix.
pub(crate) fn create_new_private(path: &Path) -> io::Result<File> {
    let descriptor = Descriptor::owner_only()?;
    let attributes = descriptor.attributes();
    let name = wide_path(path);
    // SAFETY: `name` is NUL-terminated; `attributes` points at `descriptor`,
    // alive for the call. The handle is owned by the returned File.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            CREATE_NEW,
            // A link already at `path`, dangling or not, is a name that exists, never a way through.
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        // Read right after the failed call, before anything else can set it.
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh handle nobody else owns.
    Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
}

/// Open the plain file at `path` to read and write, or create it when there
/// is none. A link there, or a file with a second name, is refused, never
/// followed: what `O_CREAT | O_NOFOLLOW` gives on Unix. A new file gets the
/// access its folder gives new files, not an owner-only one: for a lock in a
/// folder that need not be private, such as a repository's `.git`.
pub(crate) fn open_or_create_plain(path: &Path) -> io::Result<File> {
    let exists = |error: &io::Error| matches!(error.raw_os_error(), Some(code) if code == ERROR_FILE_EXISTS as i32 || code == ERROR_ALREADY_EXISTS as i32);
    // Another process may create it between the two steps: then it is opened.
    for _ in 0..2 {
        match open_plain(path, true, true) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            opened => return opened,
        }
        let name = wide_path(path);
        // SAFETY: `name` is NUL-terminated; the handle is owned by the File.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            // SAFETY: a fresh handle nobody else owns.
            return Ok(unsafe { File::from_raw_handle(handle as RawHandle) });
        }
        let error = io::Error::last_os_error();
        if !exists(&error) {
            return Err(error);
        }
    }
    open_plain(path, true, true)
}

/// Create `path` as a new file only this user (and SYSTEM) can open, or, when
/// it already exists and is a plain file, take its access down to that.
/// `truncate` empties an existing file. Links are refused, never followed.
pub(crate) fn create_private(path: &Path, truncate: bool) -> io::Result<File> {
    match create_new_private(path) {
        Ok(file) => return Ok(file),
        Err(error) if matches!(error.raw_os_error(), Some(code) if code == ERROR_FILE_EXISTS as i32 || code == ERROR_ALREADY_EXISTS as i32) => {}
        Err(error) => return Err(error),
    }
    // Opened without following a link, then judged and restricted through
    // this handle: nothing can be swapped in at the path meanwhile.
    let file = open_no_follow(path, FILE_GENERIC_READ | FILE_GENERIC_WRITE | WRITE_DAC | READ_CONTROL)?;
    plain_file(&file, path)?;
    super::security::restrict_handle(&file)?;
    if truncate {
        file.set_len(0)?;
    }
    Ok(file)
}

/// Open an existing private regular file for reading: a link is refused
/// (never followed), as is a file with more than one name or one another
/// account owns or can open. What `O_NOFOLLOW` and `fstat` give on Unix.
pub(crate) fn open_private(path: &Path) -> io::Result<File> {
    let file = open_no_follow(path, FILE_GENERIC_READ | READ_CONTROL)?;
    plain_file(&file, path)?;
    super::security::verify_private_handle(&file, &path.display().to_string())?;
    Ok(file)
}

/// `ERROR_STOPPED_ON_SYMLINK`: what [`open_read_refusing_links`] answers for a link.
pub(crate) const LINK_REFUSED: i32 = 681;

/// Open `path` for reading unless it is itself a link or other reparse point,
/// what `O_NOFOLLOW` does on Unix. A folder opens, for the caller to refuse.
pub(crate) fn open_read_refusing_links(path: &Path) -> io::Result<File> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS};
    let name = wide_path(path);
    // SAFETY: `name` is NUL-terminated; the handle is owned by the File.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh handle nobody else owns.
    let file = unsafe { File::from_raw_handle(handle as RawHandle) };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is live for the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::from_raw_os_error(LINK_REFUSED));
    }
    Ok(file)
}

/// Open the regular file at `path` itself, refusing a symbolic link or
/// junction there, and with `one_name` a file with another hard link. What
/// `O_NOFOLLOW` gives on Unix, with no check of who can open the file.
///
/// Other reparse points are files, not links: a OneDrive placeholder is one,
/// and only an ordinary open reaches its data. It is reopened that way and
/// must still be the same file.
pub(crate) fn open_plain(path: &Path, write: bool, one_name: bool) -> io::Result<File> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandle, GetFileInformationByHandleEx, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_TAG_INFO,
    };
    /// `IsReparseTagNameSurrogate`: the tag names another file.
    const NAME_SURROGATE: u32 = 0x2000_0000;

    let refused = || io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not a plain file", path.display()));
    let access = if write { FILE_GENERIC_READ | FILE_GENERIC_WRITE } else { FILE_GENERIC_READ };
    let held = open_no_follow(path, access)?;
    let mut tag = FILE_ATTRIBUTE_TAG_INFO { FileAttributes: 0, ReparseTag: 0 };
    // SAFETY: a live handle and an out-struct of the size passed.
    if unsafe { GetFileInformationByHandleEx(held.as_raw_handle(), FileAttributeTagInfo, (&raw mut tag).cast(), size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let file = if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        held
    } else if tag.ReparseTag & NAME_SURROGATE != 0 {
        return Err(refused());
    } else {
        let file = std::fs::OpenOptions::new().read(true).write(write).open(path)?;
        if file_id(&file)? != file_id(&held)? {
            return Err(refused());
        }
        file
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is live for the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 || (one_name && info.nNumberOfLinks != 1) {
        return Err(refused());
    }
    Ok(file)
}

/// Where the open `file` is now, as Windows names it with every link on the
/// way resolved: what a check of a held handle reads, which a link swapped
/// into a folder after the handle was opened cannot change.
pub(crate) fn final_path(file: &File) -> io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS};
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: a live handle and a buffer of the length passed.
        let length = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) } as usize;
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(std::ffi::OsString::from_wide(&buffer).into());
        }
        // Too small: `length` is the size needed, its terminating NUL included.
        buffer.resize(length + 1, 0);
    }
}

/// `path` itself, even when it is a link: the link is then what is opened.
fn open_no_follow(path: &Path, access: u32) -> io::Result<File> {
    let name = wide_path(path);
    // SAFETY: `name` is NUL-terminated; the handle is owned by the File.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh handle nobody else owns.
    Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
}

/// The open file is a regular file, not a link or directory, with one name.
fn plain_file(file: &File, path: &Path) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY};
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is live for the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 || info.nNumberOfLinks != 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not a plain file with one name", path.display())));
    }
    Ok(())
}

/// A folder of the temp directory named `name`, owner-only: made so when
/// missing, and refused when it exists and another account owns it or can
/// open it. What a TerminalX file in the temp directory is kept in, since
/// the temp directory itself may be a shared one.
pub(crate) fn private_temp(name: &str) -> io::Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(name);
    create_private_dir_all(&dir)?;
    Ok(dir)
}

/// Make `link` a directory junction to `target`: a link to a folder that,
/// unlike a symlink, needs neither an administrator nor Developer Mode.
/// The paths travel in the environment: no shell parses them.
pub(crate) fn junction(link: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    let made = std::process::Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:TERMINALX_LINK -Target $env:TERMINALX_TARGET | Out-Null"])
        .env("TERMINALX_LINK", link)
        .env("TERMINALX_TARGET", target)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .output()?;
    if !made.status.success() || !is_reparse_point(link).unwrap_or(false) {
        let _ = std::fs::remove_dir(link);
        return Err(io::Error::other(format!("could not link {}: {}", link.display(), String::from_utf8_lossy(&made.stderr).trim())));
    }
    Ok(())
}

/// Create `path` as a directory only this user (and SYSTEM) can open, whose
/// new contents inherit that. An existing directory must already be private
/// and not a link, as `ensure_private_dir` on Unix requires `0o700`.
pub(crate) fn create_private_dir(path: &Path) -> io::Result<()> {
    let descriptor = Descriptor::owner_only_directory()?;
    let attributes = descriptor.attributes();
    let name = wide_path(path);
    // SAFETY: as in create_private.
    if unsafe { CreateDirectoryW(name.as_ptr(), &attributes) } != 0 {
        return Ok(());
    }
    // SAFETY: reads this thread's last error right after the failed call.
    let error = unsafe { GetLastError() };
    if error != ERROR_ALREADY_EXISTS {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    if is_reparse_point(path)? || !std::fs::symlink_metadata(path)?.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not a plain directory", path.display())));
    }
    verify_private(path)
}

/// Like [`create_private_dir`], and creates missing parents the same way.
pub(crate) fn create_private_dir_all(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        return create_private_dir(path);
    }
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty() && !parent.exists()) {
        create_private_dir_all(parent)?;
    }
    create_private_dir(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_files_and_directories_are_owner_only() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a").join("b");
        create_private_dir_all(&dir).unwrap();
        verify_private(&dir).unwrap();
        verify_private(&root.path().join("a")).unwrap();
        let file = dir.join("token");
        use std::io::Write;
        create_private(&file, true).unwrap().write_all(b"secret").unwrap();
        verify_private(&file).unwrap();
        // Reopening keeps it private and can empty it.
        create_private(&file, true).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"");
        // An existing file with inherited access is taken down to owner-only.
        let loose = root.path().join("loose");
        std::fs::write(&loose, b"x").unwrap();
        create_private(&loose, false).unwrap();
        verify_private(&loose).unwrap();
        assert_eq!(std::fs::read(&loose).unwrap(), b"x");
        // A directory where a file is, is refused.
        assert!(create_private_dir(&loose).is_err());
    }

    #[test]
    fn open_plain_refuses_links_and_keeps_their_targets() {
        use std::io::{Read, Write};
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        std::fs::write(&target, b"kept").unwrap();

        let mut text = String::new();
        open_plain(&target, false, true).unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "kept");
        open_plain(&target, true, true).unwrap().write_all(b"KEPT").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"KEPT");

        // A second name is refused only when one name is required.
        let second = root.path().join("second");
        std::fs::hard_link(&target, &second).unwrap();
        assert!(open_plain(&second, true, true).is_err());
        assert!(open_plain(&second, false, false).is_ok());
        std::fs::remove_file(&second).unwrap();

        assert!(open_plain(root.path(), false, false).is_err());
        let folder = root.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        let junction_path = root.path().join("junction");
        junction(&junction_path, &folder).unwrap();
        assert!(open_plain(&junction_path, false, false).is_err());

        // Creating a symbolic link needs Developer Mode or an administrator.
        let link = root.path().join("link");
        if std::os::windows::fs::symlink_file(&target, &link).is_ok() {
            assert!(open_plain(&link, false, false).is_err());
            assert!(open_plain(&link, true, false).is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"KEPT");
        }
    }

    #[test]
    fn open_or_create_plain_makes_a_lock_and_refuses_a_linked_one() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let lock = root.path().join("mirror.lock");
        open_or_create_plain(&lock).unwrap().write_all(b"held").unwrap();
        // Made once, then opened as it is.
        open_or_create_plain(&lock).unwrap();
        assert_eq!(std::fs::read(&lock).unwrap(), b"held");
        // A lock that is a second name of another file is refused, and that file is left as it was.
        let other = root.path().join("other");
        std::fs::write(&other, b"kept").unwrap();
        let second = root.path().join("second.lock");
        std::fs::hard_link(&other, &second).unwrap();
        assert!(open_or_create_plain(&second).is_err());
        // A folder link there is refused too.
        let folder = root.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        let linked = root.path().join("linked.lock");
        junction(&linked, &folder).unwrap();
        assert!(open_or_create_plain(&linked).is_err());
        // Creating a symbolic link needs Developer Mode or an administrator.
        let dangling = root.path().join("dangling.lock");
        let target = root.path().join("made-through-the-link");
        if std::os::windows::fs::symlink_file(&target, &dangling).is_ok() {
            assert!(open_or_create_plain(&dangling).is_err());
            assert!(!target.exists(), "a dangling link is not followed to create its target");
            assert!(create_new_private(&dangling).is_err());
            assert!(!target.exists());
        }
        assert_eq!(std::fs::read(&other).unwrap(), b"kept");
    }

    #[test]
    fn paths_past_max_path_are_private_too() {
        let root = tempfile::tempdir().unwrap();
        let mut dir = root.path().to_path_buf();
        while dir.as_os_str().len() < 300 {
            dir.push("a-folder-name-of-forty-characters-long-x");
        }
        create_private_dir_all(&dir).unwrap();
        verify_private(&dir).unwrap();
        let file = dir.join("token");
        use std::io::{Read, Write};
        create_private(&file, true).unwrap().write_all(b"secret").unwrap();
        verify_private(&file).unwrap();
        let mut text = String::new();
        open_private(&file).unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "secret");
    }
}
