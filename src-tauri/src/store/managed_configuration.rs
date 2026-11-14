//! Administrative policy never lives beneath a user-selected state directory.
//! Validate opened descriptors (including every parent), not racy path metadata.
use anyhow::Result;
use std::path::Path;

pub(crate) fn path() -> Option<&'static Path> {
    #[cfg(target_os = "macos")]
    { Some(Path::new("/Library/Application Support/TerminalX/managed-settings.json")) }
    #[cfg(target_os = "linux")]
    { Some(Path::new("/etc/terminalx/managed-settings.json")) }
    // Windows needs an administrator ACL policy before managed settings can be supported.
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    { None }
}

pub(super) fn read() -> Result<Option<Vec<u8>>> {
    #[cfg(unix)]
    if let Some(path) = path() {
        return read_from(std::fs::File::open("/")?, path.strip_prefix("/")?, protected)
            .map_err(|_| anyhow::anyhow!("Cannot safely read managed configuration. Its file and every parent must be root-owned, without group/world write access or extended ACLs; symlinks are refused."));
    }
    Ok(None)
}

#[cfg(unix)]
fn protected(file: &std::fs::File) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    validate_owner(metadata.uid(), metadata.mode())?;
    #[cfg(target_os = "macos")]
    no_extended_acl(file)?;
    Ok(())
}

#[cfg(unix)]
fn validate_owner(uid: u32, mode: u32) -> Result<()> {
    anyhow::ensure!(uid == 0 && mode & 0o022 == 0, "Managed policy is writable by a non-root principal.");
    Ok(())
}

#[cfg(target_os = "macos")]
fn no_extended_acl(file: &std::fs::File) -> Result<()> {
    use std::os::fd::AsRawFd;
    use std::ffi::c_void;
    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: libc::c_int, entry: *mut *mut c_void) -> libc::c_int;
        fn acl_free(object: *mut c_void) -> libc::c_int;
    }
    // Darwin ACLs can grant write/delete-child independently of POSIX mode.
    // Conservatively refuse any ACL, including a read-only one. Never guess.
    // SAFETY: valid held fd; ACL and entry pointers are opaque library objects.
    let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) }; // ACL_TYPE_EXTENDED
    if acl.is_null() {
        // Darwin returns ENOENT for an existing descriptor with no extended
        // ACL attached (rather than always allocating an empty ACL object).
        anyhow::ensure!(std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT), "Cannot inspect managed policy ACL.");
        return Ok(());
    }
    let mut entry = std::ptr::null_mut();
    // Darwin returns 0 for an entry and -1/EINVAL for an empty ACL.
    let result = unsafe { acl_get_entry(acl, 0, &mut entry) }; // ACL_FIRST_ENTRY
    let error = std::io::Error::last_os_error();
    // SAFETY: release exactly the ACL allocated above, after inspecting it.
    unsafe { acl_free(acl); }
    anyhow::ensure!(result == -1 && error.raw_os_error() == Some(libc::EINVAL), "Managed policy has an extended ACL.");
    Ok(())
}

#[cfg(unix)]
fn read_from(mut directory: std::fs::File, relative: &Path, validate: impl Fn(&std::fs::File) -> Result<()>) -> Result<Option<Vec<u8>>> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::io::Read;
    use anyhow::ensure;
    let mut parts = relative.components().peekable();
    ensure!(parts.peek().is_some(), "Policy needs a filename.");
    validate(&directory)?;
    while let Some(part) = parts.next() {
        let std::path::Component::Normal(name) = part else { anyhow::bail!("Invalid policy path."); };
        let leaf = parts.peek().is_none();
        let name = std::ffi::CString::new(name.as_bytes())?;
        let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK
            | if leaf { 0 } else { libc::O_DIRECTORY };
        // SAFETY: held parent descriptor and a single NUL-terminated component.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound { return Ok(None); }
            return Err(error.into());
        }
        // SAFETY: openat created this descriptor; transfer its sole ownership.
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        validate(&file)?;
        if leaf {
            ensure!(file.metadata()?.is_file(), "Managed policy must be a regular file.");
            let mut bytes = Vec::new();
            file.take(super::config_files::MAX_BYTES + 1).read_to_end(&mut bytes)?;
            ensure!(bytes.len() as u64 <= super::config_files::MAX_BYTES, "Managed policy exceeds 1 MiB.");
            return Ok(Some(bytes));
        }
        directory = file;
    }
    unreachable!()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs::{self, File}, os::unix::fs::{symlink, MetadataExt, PermissionsExt}};

    #[test]
    fn only_root_without_other_writers_can_own_policy_or_ancestors() {
        for mode in [0o600, 0o644, 0o700, 0o755] { assert!(validate_owner(0, mode).is_ok()); }
        for mode in [0o602, 0o620, 0o666, 0o775, 0o777, 0o1777] { assert!(validate_owner(0, mode).is_err()); }
        assert!(validate_owner(501, 0o600).is_err());
        assert!(validate_owner(501, 0o444).is_err(), "owner can chmod a read-only file");
    }

    #[test]
    fn descriptor_walk_checks_every_parent_and_leaf_and_refuses_links() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("policy")).unwrap();
        fs::write(root.path().join("policy/settings.json"), b"{}").unwrap();
        // Tests run unprivileged: use the fixture owner while exercising the same walk.
        let uid = File::open(root.path()).unwrap().metadata().unwrap().uid();
        let check = |file: &File| { let m = file.metadata()?; anyhow::ensure!(m.uid() == uid && m.mode() & 0o022 == 0, "unsafe"); Ok(()) };
        let read = |path| read_from(File::open(root.path()).unwrap(), Path::new(path), check);
        assert_eq!(read("policy/settings.json").unwrap(), Some(b"{}".to_vec()));
        fs::set_permissions(root.path().join("policy"), fs::Permissions::from_mode(0o777)).unwrap();
        assert!(read("policy/settings.json").is_err());
        assert!(read("policy/missing.json").is_err(), "unsafe parent cannot remove policy silently");
        fs::set_permissions(root.path().join("policy"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(root.path().join("policy/settings.json"), fs::Permissions::from_mode(0o666)).unwrap();
        assert!(read("policy/settings.json").is_err());
        fs::set_permissions(root.path().join("policy/settings.json"), fs::Permissions::from_mode(0o644)).unwrap();
        symlink("settings.json", root.path().join("policy/link.json")).unwrap();
        symlink("policy", root.path().join("link")).unwrap();
        assert!(read("policy/link.json").is_err());
        assert!(read("link/settings.json").is_err());
        assert!(read("policy").is_err());
        assert!(read("policy/../policy/settings.json").is_err());
        assert!(read("policy/missing.json").unwrap().is_none());
        fs::write(root.path().join("policy/settings.json"), vec![0; super::super::config_files::MAX_BYTES as usize + 1]).unwrap();
        assert!(read("policy/settings.json").is_err());
        if uid != 0 { assert!(protected(&File::open(root.path()).unwrap()).is_err()); }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn extended_acl_cannot_grant_writes_despite_safe_mode() {
        let root = tempfile::tempdir().unwrap();
        let file = File::create(root.path().join("policy.json")).unwrap();
        no_extended_acl(&file).unwrap();
        assert!(std::process::Command::new("chmod").args(["+a", "everyone allow write"]).arg(root.path().join("policy.json")).status().unwrap().success());
        assert!(no_extended_acl(&file).is_err());
    }

    #[test]
    fn policy_location_is_system_wide() {
        #[cfg(target_os = "macos")]
        assert_eq!(path().unwrap(), Path::new("/Library/Application Support/TerminalX/managed-settings.json"));
        #[cfg(target_os = "linux")]
        assert_eq!(path().unwrap(), Path::new("/etc/terminalx/managed-settings.json"));
    }
}
