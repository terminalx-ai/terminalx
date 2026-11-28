//! Owner-only access on Windows: what `0o700` directories, `0o600` files and
//! same-uid checks are on Unix.
//!
//! An object TerminalX creates for itself gets a *protected* DACL that grants
//! full access to the current user and to SYSTEM and to nobody else, and
//! inherits nothing from its parent. Verification is a little wider than
//! creation: it also accepts the local Administrators group, which can take
//! ownership of anything on the machine in any case (as root can read a
//! `0o600` file on Unix). It refuses an object owned by another account, a
//! NULL DACL (which grants everyone everything), and any allow entry for a
//! principal other than those three.
use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, GetSecurityInfo, SDDL_REVISION_1,
    SE_FILE_OBJECT, SE_KERNEL_OBJECT, SE_OBJECT_TYPE,
};
use windows_sys::Win32::Security::{
    GetAce, GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE,
    ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// SYSTEM.
const SYSTEM: &str = "S-1-5-18";
/// BUILTIN\Administrators.
const ADMINISTRATORS: &str = "S-1-5-32-544";
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_ALLOWED_COMPOUND_ACE_TYPE: u8 = 4;
const ACCESS_ALLOWED_OBJECT_ACE_TYPE: u8 = 5;
const ACCESS_ALLOWED_CALLBACK_ACE_TYPE: u8 = 9;
const ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE: u8 = 11;
/// In an object ACE's flags: which of its two GUIDs are present.
const ACE_OBJECT_TYPE_PRESENT: u32 = 0x1;
const ACE_INHERITED_OBJECT_TYPE_PRESENT: u32 = 0x2;

pub(crate) fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

/// Longest path the plain Win32 form takes for every call: `MAX_PATH` less
/// the 12 `CreateDirectoryW` keeps for an 8.3 name, less its NUL. Files take
/// up to 259, but one threshold keeps a directory and the files in it alike.
const PLAIN_PATH_LIMIT: usize = 247;

/// `path` as a NUL-terminated wide string for a Win32 file call. Past
/// `MAX_PATH` the plain form fails, so a long path is made absolute and given
/// the verbatim prefix (`\\?\`, or `\\?\UNC\` for a share), which also turns
/// off `/` and `.` handling: the separators are made `\` and the path
/// resolved first, as the plain form would have.
pub(crate) fn wide_path(path: &Path) -> Vec<u16> {
    let plain = path.as_os_str();
    let text = plain.to_string_lossy();
    if plain.len() <= PLAIN_PATH_LIMIT || text.starts_with(r"\\?\") || text.starts_with(r"\\.\") {
        return wide(plain);
    }
    let Ok(absolute) = std::path::absolute(path) else { return wide(plain) };
    let text = absolute.as_os_str().to_string_lossy().replace('/', "\\");
    let verbatim = match text.strip_prefix(r"\\") {
        Some(share) => format!(r"\\?\UNC\{share}"),
        None => format!(r"\\?\{text}"),
    };
    wide(OsStr::new(&verbatim))
}

/// Memory Windows allocated with `LocalAlloc` on our behalf.
struct Local(*mut core::ffi::c_void);

impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from an API documented to allocate it
            // with LocalAlloc, and is freed once.
            unsafe { LocalFree(self.0) };
        }
    }
}

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: a handle this module opened, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn sid_string(sid: PSID) -> io::Result<String> {
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: `sid` is a valid SID owned by the caller; `text` receives a
    // LocalAlloc'd string we free below.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _free = Local(text.cast());
    // SAFETY: ConvertSidToStringSidW returns a NUL-terminated wide string.
    let len = unsafe { (0..).take_while(|&i| *text.add(i) != 0).count() };
    // SAFETY: `len` u16s were just read from this allocation.
    let units = unsafe { std::slice::from_raw_parts(text, len) };
    Ok(String::from_utf16_lossy(units))
}

/// The string SID of the user a process token belongs to.
fn token_user(token: HANDLE) -> io::Result<String> {
    let mut needed = 0u32;
    // SAFETY: a size query; the call fails with ERROR_INSUFFICIENT_BUFFER.
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    // u64 storage keeps the TOKEN_USER suitably aligned.
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `buffer` holds at least `needed` bytes.
    if unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), needed, &mut needed) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation(TokenUser) fills a TOKEN_USER at the start.
    let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    sid_string(user.User.Sid)
}

/// The string SID of the account this process runs as.
pub(crate) fn current_user() -> io::Result<&'static str> {
    static USER: OnceLock<String> = OnceLock::new();
    if let Some(user) = USER.get() {
        return Ok(user);
    }
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: the pseudo handle of this process needs no closing; `token` is
    // closed by `Handle`.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Handle(token);
    let user = token_user(token.0)?;
    Ok(USER.get_or_init(|| user))
}

/// The string SID of the account process `pid` runs as.
pub(crate) fn process_user(pid: u32) -> io::Result<String> {
    // SAFETY: plain query access; the handle is closed by `Handle`.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = Handle(process);
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `process` is a live handle with query access.
    if unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Handle(token);
    token_user(token.0)
}

/// The SDDL of an owner-only DACL. `inherit` adds object and container
/// inheritance, for a directory whose new children should get it too.
fn owner_only_sddl(user: &str, inherit: bool) -> String {
    let flags = if inherit { "OICI" } else { "" };
    format!("D:P(A;{flags};FA;;;{user})(A;{flags};FA;;;{SYSTEM})")
}

/// A self-relative security descriptor parsed from SDDL.
pub(crate) struct Descriptor(Local);

impl Descriptor {
    fn from_sddl(sddl: &str) -> io::Result<Self> {
        let text = wide(OsStr::new(sddl));
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `text` is NUL-terminated; the descriptor is LocalAlloc'd
        // and owned by the returned value.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut())
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(Local(descriptor)))
    }

    /// Owner-only access for an object that has no children (a file, a pipe).
    pub(crate) fn owner_only() -> io::Result<Self> {
        Self::from_sddl(&owner_only_sddl(current_user()?, false))
    }

    /// Owner-only access for a directory, inherited by what is created in it.
    pub(crate) fn owner_only_directory() -> io::Result<Self> {
        Self::from_sddl(&owner_only_sddl(current_user()?, true))
    }

    pub(crate) fn as_ptr(&self) -> PSECURITY_DESCRIPTOR {
        self.0 .0
    }

    /// Security attributes that apply this descriptor and are never
    /// inherited by child processes.
    pub(crate) fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.as_ptr(),
            bInheritHandle: 0,
        }
    }

    fn dacl(&self) -> io::Result<*mut ACL> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl: *mut ACL = std::ptr::null_mut();
        // SAFETY: the descriptor is valid for the life of `self`.
        if unsafe { GetSecurityDescriptorDacl(self.as_ptr(), &mut present, &mut dacl, &mut defaulted) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if present == 0 || dacl.is_null() {
            return Err(io::Error::other("owner-only descriptor has no DACL"));
        }
        Ok(dacl)
    }
}

/// Replace the DACL of an existing file or directory with an owner-only,
/// protected one: nothing is inherited from its parent from now on. Only the
/// tests change an object by path; the app restricts what it holds open
/// ([`restrict_handle`]).
#[cfg(test)]
pub(crate) fn restrict(path: &Path) -> io::Result<()> {
    use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to change access through a link"));
    }
    let descriptor = if metadata.is_dir() { Descriptor::owner_only_directory()? } else { Descriptor::owner_only()? };
    let dacl = descriptor.dacl()?;
    let name = wide_path(path);
    // SAFETY: `name` is NUL-terminated and `dacl` lives inside `descriptor`.
    let status = unsafe {
        SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    // A new DACL does not change who owns it: another account's object is
    // still refused.
    verify_private(path)
}

/// [`restrict`], on a file this process holds open (with `WRITE_DAC`), so
/// nothing can be swapped in at its path between the check and the change.
pub(crate) fn restrict_handle(file: &impl AsRawHandle) -> io::Result<()> {
    use windows_sys::Win32::Security::Authorization::SetSecurityInfo;
    let descriptor = Descriptor::owner_only()?;
    let dacl = descriptor.dacl()?;
    // SAFETY: the handle is live for the call and `dacl` lives in `descriptor`.
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    verify_private_handle(file, "the file")
}

/// [`verify_private`], of a file this process holds open (with
/// `READ_CONTROL`): what `fstat` is to `stat`.
pub(crate) fn verify_private_handle(file: &impl AsRawHandle, what: &str) -> io::Result<()> {
    check(handle_access(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT)?, what)
}

/// Who owns an object and who its DACL lets in.
struct Access {
    owner: String,
    /// `None`: a NULL DACL, which grants everyone full access.
    allowed: Option<Vec<String>>,
}

/// # Safety
/// `owner`, `dacl` and `descriptor` must be what a `Get*SecurityInfo` call
/// just returned; `descriptor` is freed here.
unsafe fn read_access(owner: PSID, dacl: *mut ACL, descriptor: PSECURITY_DESCRIPTOR) -> io::Result<Access> {
    let _free = Local(descriptor);
    let owner = sid_string(owner)?;
    if dacl.is_null() {
        return Ok(Access { owner, allowed: None });
    }
    let mut allowed = Vec::new();
    // SAFETY: `dacl` points into `descriptor`, alive until `_free` drops.
    let count = unsafe { (*dacl).AceCount };
    for index in 0..count as u32 {
        let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: `index` is below the ACL's own count.
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if ace.is_null() {
            return Err(io::Error::other("null ACE pointer"));
        }
        // SAFETY: `ace` is non-null and every ACE starts with an ACE_HEADER.
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        // Audit INHERIT_ONLY_ACE trustees too: an inherit-only allow ACE for
        // another account on a private directory would grant that account
        // access to newly created secret files inside it.
        match header.AceType {
            ACCESS_ALLOWED_ACE_TYPE | ACCESS_ALLOWED_CALLBACK_ACE_TYPE => {
                // SAFETY: these ACEs have the ACCESS_ALLOWED_ACE layout, and
                // the SID starts at SidStart.
                let allow = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
                if allow.Mask == 0 {
                    continue;
                }
                let sid = std::ptr::addr_of!(allow.SidStart) as PSID;
                allowed.push(sid_string(sid)?);
            }
            ACCESS_ALLOWED_OBJECT_ACE_TYPE | ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE => {
                // Header, mask, flags, then up to two GUIDs as the flags say,
                // then the SID.
                // SAFETY: the mask and flags follow the 4-byte header in every
                // object ACE; the SID offset is computed from those flags and
                // stays within the ACE's own size, checked below.
                let base = ace as *const u8;
                let (mask, flags) = unsafe { (std::ptr::read_unaligned(base.add(4) as *const u32), std::ptr::read_unaligned(base.add(8) as *const u32)) };
                let mut offset = 12usize;
                if flags & ACE_OBJECT_TYPE_PRESENT != 0 { offset += 16; }
                if flags & ACE_INHERITED_OBJECT_TYPE_PRESENT != 0 { offset += 16; }
                if offset + 8 > header.AceSize as usize {
                    return Err(io::Error::other("malformed object ACE"));
                }
                if mask == 0 {
                    continue;
                }
                // SAFETY: bounds-checked against AceSize just above.
                allowed.push(sid_string(unsafe { base.add(offset) } as PSID)?);
            }
            // A compound ACE names a server and a client; either counts.
            ACCESS_ALLOWED_COMPOUND_ACE_TYPE => {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "compound access entries are not accepted"));
            }
            // Deny and audit entries only take access away.
            _ => {}
        }
    }
    Ok(Access { owner, allowed: Some(allowed) })
}

fn check(access: Access, what: &str) -> io::Result<()> {
    let user = current_user()?;
    if access.owner != user && access.owner != ADMINISTRATORS {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{what} is owned by another account")));
    }
    let Some(allowed) = access.allowed else {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{what} grants access to everyone")));
    };
    if let Some(other) = allowed.iter().find(|sid| *sid != user && *sid != SYSTEM && *sid != ADMINISTRATORS) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{what} grants access to another account ({other})")));
    }
    Ok(())
}

/// Refuse a file or directory another account owns or can open: what a
/// `uid` plus `mode & 0o077 == 0` check is on Unix.
pub(crate) fn verify_private(path: &Path) -> io::Result<()> {
    let name = wide_path(path);
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: out-pointers to locals; the descriptor is freed by read_access.
    let status = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    // SAFETY: exactly what GetNamedSecurityInfoW returned.
    let access = unsafe { read_access(owner, dacl, descriptor)? };
    check(access, &path.display().to_string())
}

fn handle_access(handle: HANDLE, object: SE_OBJECT_TYPE) -> io::Result<Access> {
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `handle` is live for the call; out-pointers are locals.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            object,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    // SAFETY: exactly what GetSecurityInfo returned.
    unsafe { read_access(owner, dacl, descriptor) }
}

/// A connected pipe end whose *other* side runs as this user, and whose pipe
/// object this user created with an owner-only DACL. Checked by a client
/// before it sends a credential, so a pipe another account created first
/// under a predictable name never receives one.
pub(crate) fn verify_pipe_server(pipe: &impl AsRawHandle) -> io::Result<()> {
    let handle = pipe.as_raw_handle() as HANDLE;
    check(handle_access(handle, SE_KERNEL_OBJECT)?, "the TerminalX pipe")?;
    let pid = super::process::pipe_server_pid(handle)?;
    let user = process_user(pid)?;
    if user != current_user()? {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the TerminalX pipe is served by another account"));
    }
    Ok(())
}

/// The process on the other end of a server pipe runs as this user. The
/// owner-only DACL already keeps other accounts from opening it; this is the
/// `SO_PEERCRED` check on top.
pub(crate) fn verify_pipe_client(pipe: &impl AsRawHandle) -> io::Result<u32> {
    let pid = super::process::pipe_client_pid(pipe.as_raw_handle() as HANDLE)?;
    let user = process_user(pid)?;
    if user != current_user()? {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "a TerminalX pipe client runs as another account"));
    }
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;

    #[test]
    fn the_current_user_is_a_user_sid() {
        let user = current_user().unwrap();
        assert!(user.starts_with("S-1-5-"), "{user}");
        assert_ne!(user, SYSTEM);
        assert_eq!(process_user(std::process::id()).unwrap(), user);
    }

    #[test]
    fn a_restricted_file_and_directory_verify_and_an_open_one_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("secret");
        std::fs::write(&file, b"x").unwrap();
        // A NULL DACL: everyone has full access.
        let open = Descriptor::from_sddl("D:NO_ACCESS_CONTROL").unwrap();
        let name = wide(file.as_os_str());
        // SAFETY: a test applying a parsed descriptor's (NULL) DACL.
        let status = unsafe {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl: *mut ACL = std::ptr::null_mut();
            GetSecurityDescriptorDacl(open.as_ptr(), &mut present, &mut dacl, &mut defaulted);
            SetNamedSecurityInfoW(name.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null())
        };
        assert_eq!(status, ERROR_SUCCESS);
        assert!(verify_private(&file).is_err(), "a NULL DACL is refused");
        restrict(&file).unwrap();
        verify_private(&file).unwrap();
        // Everyone (WD) with read access is another account.
        let everyone = Descriptor::from_sddl(&format!("D:P(A;;FA;;;{})(A;;FR;;;WD)", current_user().unwrap())).unwrap();
        // SAFETY: as above.
        let status = unsafe {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl: *mut ACL = std::ptr::null_mut();
            GetSecurityDescriptorDacl(everyone.as_ptr(), &mut present, &mut dacl, &mut defaulted);
            SetNamedSecurityInfoW(name.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null())
        };
        assert_eq!(status, ERROR_SUCCESS);
        let error = verify_private(&file).unwrap_err();
        assert!(error.to_string().contains("S-1-1-0"), "{error}");
        restrict(dir.path()).unwrap();
        verify_private(dir.path()).unwrap();
        // A file created in a restricted directory inherits owner-only access.
        let child = dir.path().join("child");
        std::fs::write(&child, b"y").unwrap();
        verify_private(&child).unwrap();
        // An inherit-only allow ACE for Everyone on a private directory must be refused.
        let inherit_only = Descriptor::from_sddl(&format!("D:P(A;OICI;FA;;;{})(A;OICIIO;FR;;;WD)", current_user().unwrap())).unwrap();
        let dir_name = wide(dir.path().as_os_str());
        // SAFETY: applying a parsed test descriptor's DACL.
        let status = unsafe {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl: *mut ACL = std::ptr::null_mut();
            GetSecurityDescriptorDacl(inherit_only.as_ptr(), &mut present, &mut dacl, &mut defaulted);
            SetNamedSecurityInfoW(dir_name.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null())
        };
        assert_eq!(status, ERROR_SUCCESS);
        let error = verify_private(dir.path()).unwrap_err();
        assert!(error.to_string().contains("S-1-1-0"), "{error}");
    }
}
