//! Which code the app accepts as its helper (#480 review).
//!
//! The helper runs from a copy in a folder the person's user, and so an
//! agent, can write to. What makes that safe is that the app never trusts
//! the copy's files: it reads the identity of the helper shipped inside
//! TerminalX.app (its signing identifier, its code directory hash and, for
//! the released app, its Developer ID team) and accepts a running helper
//! only if the system says the code *running in that process* matches it.
//! The cdhash pins the exact build, so an older signed helper does not pass
//! either.
//!
//! Every helper process is started suspended and checked by pid before it
//! runs a single instruction; an agent helper is checked again on its socket
//! (the peer's audit token) once the app has connected.

#[cfg(target_os = "macos")]
use std::path::Path;

/// The identifier of the released helper. The released app accepts no other.
pub const RELEASE_HELPER_IDENTIFIER: &str = "com.terminalx.next.computer-use.v2";

/// What the bundled helper's signature says about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigningInfo {
    pub identifier: String,
    pub cdhash: Vec<u8>,
    pub team: Option<String>,
}

/// The code a helper process must be running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedHelper {
    pub identifier: String,
    pub cdhash: Vec<u8>,
    /// Set for the released app: the helper must carry a Developer ID of
    /// this team.
    pub team: Option<String>,
}

/// A process to check, as the system can name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Peer {
    /// An unreaped child of this app, still suspended: its pid cannot be
    /// reused and it cannot exec anything else before it is checked.
    Pid(i32),
    /// The audit token of a socket peer, which names one exec of one process.
    AuditToken([u8; 32]),
}

fn is_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 255 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn is_team(value: &str) -> bool {
    value.len() == 10 && value.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
}

/// Decide what to require of a helper, from the bundled helper's signature
/// and the app's own. The released app (`com.terminalx.next`) requires the
/// released helper's identifier and its own team's Developer ID; a released
/// app whose team cannot be read refuses every helper. Every build requires the bundled
/// helper's exact cdhash and refuses the pre-PRO-90 identities.
pub fn expect(bundled: SigningInfo, release_app: bool, app_team: Option<&str>) -> Result<ExpectedHelper, String> {
    if !is_identifier(&bundled.identifier) {
        return Err(format!("the bundled helper's signing identifier {:?} is not usable", bundled.identifier));
    }
    if super::permissions::is_legacy_helper(&bundled.identifier) {
        return Err(format!("the bundled helper is signed as {}, an older helper this app does not use", bundled.identifier));
    }
    if release_app && bundled.identifier != RELEASE_HELPER_IDENTIFIER {
        return Err(format!("the bundled helper is signed as {}, not {RELEASE_HELPER_IDENTIFIER}", bundled.identifier));
    }
    if bundled.cdhash.is_empty() {
        return Err("the bundled helper has no code directory hash".into());
    }
    let team = match (release_app, app_team) {
        (true, Some(team)) => {
            if !is_team(team) {
                return Err(format!("this app's team {team:?} is not a team identifier"));
            }
            if bundled.team.as_deref() != Some(team) {
                return Err(format!("the bundled helper is not signed by this app's team {team}"));
            }
            Some(team.to_owned())
        }
        (true, None) => return Err("this app's signing team could not be read, so no helper is accepted".into()),
        (false, _) => None,
    };
    Ok(ExpectedHelper { identifier: bundled.identifier, cdhash: bundled.cdhash, team })
}

impl ExpectedHelper {
    /// The code requirement a helper process must satisfy.
    pub fn requirement(&self) -> String {
        let hex: String = self.cdhash.iter().map(|b| format!("{b:02x}")).collect();
        let mut text = format!("identifier \"{}\" and cdhash H\"{hex}\"", self.identifier);
        if let Some(team) = &self.team {
            text.push_str(&format!(
                " and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{team}\""
            ));
        }
        text
    }
}

/// The pid an audit token names (`audit_token_t.val[5]`).
pub fn audit_token_pid(token: &[u8; 32]) -> i32 {
    i32::from_ne_bytes([token[20], token[21], token[22], token[23]])
}

/// The audit token of the process at the other end of a connected unix
/// socket, as the kernel recorded it.
#[cfg(target_os = "macos")]
pub fn peer_audit_token(fd: std::os::fd::RawFd) -> std::io::Result<[u8; 32]> {
    const SOL_LOCAL: libc::c_int = 0;
    const LOCAL_PEERTOKEN: libc::c_int = 0x006;
    let mut token = [0u8; 32];
    let mut len = token.len() as libc::socklen_t;
    let result = unsafe { libc::getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, token.as_mut_ptr().cast(), &mut len) };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if len as usize != token.len() {
        return Err(std::io::Error::other("the kernel returned a short audit token"));
    }
    Ok(token)
}

#[cfg(target_os = "macos")]
pub use system::{app_team, check, signing_info};

#[cfg(target_os = "macos")]
mod system {
    use super::{ExpectedHelper, Peer, SigningInfo};
    use std::ffi::c_void;
    use std::path::Path;

    type Ref = *const c_void;

    #[repr(C)]
    struct Opaque {
        _private: [u8; 0],
    }

    const UTF8: u32 = 0x0800_0100;
    const CF_NUMBER_SINT32: isize = 3;
    const DEFAULT_FLAGS: u32 = 0;
    const CHECK_ALL_ARCHITECTURES: u32 = 1 << 0;
    const SIGNING_INFORMATION: u32 = 1 << 1;
    const CHECK_NESTED_CODE: u32 = 1 << 3;
    const STRICT_VALIDATE: u32 = 1 << 4;
    const RESTRICT_SYMLINKS: u32 = 1 << 7;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFTypeDictionaryKeyCallBacks: Opaque;
        static kCFTypeDictionaryValueCallBacks: Opaque;
        fn CFRelease(cf: Ref);
        fn CFGetTypeID(cf: Ref) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFDataGetTypeID() -> usize;
        fn CFDataCreate(allocator: Ref, bytes: *const u8, length: isize) -> Ref;
        fn CFDataGetLength(data: Ref) -> isize;
        fn CFDataGetBytePtr(data: Ref) -> *const u8;
        fn CFNumberCreate(allocator: Ref, kind: isize, value: *const c_void) -> Ref;
        fn CFStringCreateWithBytes(allocator: Ref, bytes: *const u8, length: isize, encoding: u32, external: u8) -> Ref;
        fn CFStringGetLength(string: Ref) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(string: Ref, buffer: *mut u8, size: isize, encoding: u32) -> u8;
        fn CFDictionaryCreate(
            allocator: Ref,
            keys: *const Ref,
            values: *const Ref,
            count: isize,
            key_callbacks: *const Opaque,
            value_callbacks: *const Opaque,
        ) -> Ref;
        fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
        fn CFURLCreateFromFileSystemRepresentation(allocator: Ref, path: *const u8, length: isize, is_directory: u8) -> Ref;
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecGuestAttributePid: Ref;
        static kSecGuestAttributeAudit: Ref;
        static kSecCodeInfoIdentifier: Ref;
        static kSecCodeInfoUnique: Ref;
        static kSecCodeInfoTeamIdentifier: Ref;
        fn SecStaticCodeCreateWithPath(path: Ref, flags: u32, code: *mut Ref) -> i32;
        fn SecStaticCodeCheckValidity(code: Ref, flags: u32, requirement: Ref) -> i32;
        fn SecCodeCopySigningInformation(code: Ref, flags: u32, information: *mut Ref) -> i32;
        fn SecCodeCopySelf(flags: u32, code: *mut Ref) -> i32;
        fn SecCodeCopyGuestWithAttributes(host: Ref, attributes: Ref, flags: u32, guest: *mut Ref) -> i32;
        fn SecCodeCheckValidity(code: Ref, flags: u32, requirement: Ref) -> i32;
        fn SecRequirementCreateWithString(text: Ref, flags: u32, requirement: *mut Ref) -> i32;
    }

    /// An owned Core Foundation reference.
    struct Owned(Ref);

    impl Owned {
        fn new(raw: Ref) -> Option<Self> {
            (!raw.is_null()).then_some(Self(raw))
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }

    fn status(what: &str, code: i32) -> Result<(), String> {
        if code == 0 {
            Ok(())
        } else {
            Err(format!("{what} failed (OSStatus {code})"))
        }
    }

    fn cf_string(text: &str) -> Option<Owned> {
        Owned::new(unsafe { CFStringCreateWithBytes(std::ptr::null(), text.as_ptr(), text.len() as isize, UTF8, 0) })
    }

    fn rust_string(value: Ref) -> Option<String> {
        if value.is_null() || unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
            return None;
        }
        let size = unsafe { CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), UTF8) } + 1;
        let mut buffer = vec![0u8; size.max(1) as usize];
        if unsafe { CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) } == 0 {
            return None;
        }
        let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
        String::from_utf8(buffer[..end].to_vec()).ok()
    }

    fn rust_bytes(value: Ref) -> Option<Vec<u8>> {
        if value.is_null() || unsafe { CFGetTypeID(value) != CFDataGetTypeID() } {
            return None;
        }
        let length = unsafe { CFDataGetLength(value) } as usize;
        let bytes = unsafe { CFDataGetBytePtr(value) };
        (!bytes.is_null()).then(|| unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec())
    }

    fn information(code: &Owned) -> Result<SigningInfo, String> {
        let mut info: Ref = std::ptr::null();
        status("reading the signature", unsafe { SecCodeCopySigningInformation(code.0, SIGNING_INFORMATION, &mut info) })?;
        let info = Owned::new(info).ok_or("the signature could not be read")?;
        let get = |key: Ref| unsafe { CFDictionaryGetValue(info.0, key) };
        let identifier = rust_string(get(unsafe { kSecCodeInfoIdentifier })).ok_or("the code has no signing identifier")?;
        let cdhash = rust_bytes(get(unsafe { kSecCodeInfoUnique })).ok_or("the code has no code directory hash")?;
        let team = rust_string(get(unsafe { kSecCodeInfoTeamIdentifier }));
        Ok(SigningInfo { identifier, cdhash, team })
    }

    /// The signature of the code at `path`, after the system has checked
    /// that every file in it is what the signature seals (strictly, for every
    /// architecture, nested code included, no symlink leading out).
    pub fn signing_info(path: &Path) -> Result<SigningInfo, String> {
        use std::os::unix::ffi::OsStrExt;
        let bytes = path.as_os_str().as_bytes();
        let url = Owned::new(unsafe {
            CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, path.is_dir() as u8)
        })
        .ok_or("the path could not be named to the system")?;
        let mut code: Ref = std::ptr::null();
        status("opening the code", unsafe { SecStaticCodeCreateWithPath(url.0, DEFAULT_FLAGS, &mut code) })?;
        let code = Owned::new(code).ok_or("the code could not be opened")?;
        let flags = STRICT_VALIDATE | CHECK_ALL_ARCHITECTURES | CHECK_NESTED_CODE | RESTRICT_SYMLINKS;
        status("validating the signature", unsafe { SecStaticCodeCheckValidity(code.0, flags, std::ptr::null()) })?;
        information(&code)
    }

    /// The team that signed this app, if any.
    pub fn app_team() -> Option<String> {
        let mut code: Ref = std::ptr::null();
        if unsafe { SecCodeCopySelf(DEFAULT_FLAGS, &mut code) } != 0 {
            return None;
        }
        let code = Owned::new(code)?;
        information(&code).ok()?.team
    }

    /// Whether the code running in `peer` is the expected helper. The system
    /// checks the code the kernel loaded, not the file on disk now.
    pub fn check(peer: Peer, expected: &ExpectedHelper) -> Result<(), String> {
        let (key, value) = match peer {
            Peer::Pid(pid) => {
                let number = Owned::new(unsafe { CFNumberCreate(std::ptr::null(), CF_NUMBER_SINT32, (&pid as *const i32).cast()) })
                    .ok_or("the pid could not be named to the system")?;
                (unsafe { kSecGuestAttributePid }, number)
            }
            Peer::AuditToken(token) => {
                let data = Owned::new(unsafe { CFDataCreate(std::ptr::null(), token.as_ptr(), token.len() as isize) })
                    .ok_or("the audit token could not be named to the system")?;
                (unsafe { kSecGuestAttributeAudit }, data)
            }
        };
        let attributes = Owned::new(unsafe {
            CFDictionaryCreate(
                std::ptr::null(),
                &key,
                &value.0,
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            )
        })
        .ok_or("the process could not be named to the system")?;
        let mut guest: Ref = std::ptr::null();
        status("finding the process's code", unsafe {
            SecCodeCopyGuestWithAttributes(std::ptr::null(), attributes.0, DEFAULT_FLAGS, &mut guest)
        })?;
        let guest = Owned::new(guest).ok_or("the process's code could not be found")?;
        let text = cf_string(&expected.requirement()).ok_or("the requirement could not be written")?;
        let mut requirement: Ref = std::ptr::null();
        status("compiling the requirement", unsafe { SecRequirementCreateWithString(text.0, DEFAULT_FLAGS, &mut requirement) })?;
        let requirement = Owned::new(requirement).ok_or("the requirement could not be compiled")?;
        status("checking the running code", unsafe { SecCodeCheckValidity(guest.0, DEFAULT_FLAGS, requirement.0) })
            .map_err(|e| format!("it is not the helper shipped with this TerminalX ({e})"))
    }
}

/// The bundled helper's identity, for this app.
#[cfg(target_os = "macos")]
pub fn expected_for(bundled: &Path, app_identifier: Option<&str>) -> Result<ExpectedHelper, String> {
    let info = signing_info(bundled).map_err(|e| format!("{}: {e}", bundled.display()))?;
    let release_app = app_identifier == Some(super::permissions::RELEASE_APP_IDENTIFIER);
    expect(info, release_app, app_team().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(identifier: &str, team: Option<&str>) -> SigningInfo {
        SigningInfo { identifier: identifier.into(), cdhash: vec![0xab; 20], team: team.map(Into::into) }
    }

    #[test]
    fn the_requirement_pins_the_identifier_and_the_exact_build() {
        let expected = expect(info("com.terminalx.next.dev.computer-use.v2", None), false, None).unwrap();
        assert_eq!(
            expected.requirement(),
            format!("identifier \"com.terminalx.next.dev.computer-use.v2\" and cdhash H\"{}\"", "ab".repeat(20))
        );
    }

    #[test]
    fn the_released_app_also_requires_its_own_teams_developer_id_and_the_released_identifier() {
        let expected = expect(info(RELEASE_HELPER_IDENTIFIER, Some("AQ6323SP66")), true, Some("AQ6323SP66")).unwrap();
        let requirement = expected.requirement();
        assert!(requirement.starts_with("identifier \"com.terminalx.next.computer-use.v2\" and cdhash H\""));
        assert!(requirement.contains("anchor apple generic"));
        assert!(requirement.contains("certificate leaf[subject.OU] = \"AQ6323SP66\""));

        assert!(expect(info(RELEASE_HELPER_IDENTIFIER, Some("ZZZZZZZZZZ")), true, Some("AQ6323SP66")).is_err());
        assert!(expect(info(RELEASE_HELPER_IDENTIFIER, None), true, Some("AQ6323SP66")).is_err());
        assert!(expect(info("com.terminalx.next.dev.computer-use.v2", Some("AQ6323SP66")), true, Some("AQ6323SP66")).is_err());
        assert!(expect(info(RELEASE_HELPER_IDENTIFIER, Some("AQ6323SP66")), true, Some("not a team\"")).is_err());
        // A released app that cannot read its own team fails closed.
        let error = expect(info(RELEASE_HELPER_IDENTIFIER, Some("AQ6323SP66")), true, None).unwrap_err();
        assert!(error.contains("signing team could not be read"), "{error}");
    }

    #[test]
    fn old_helpers_and_unusable_identities_are_refused() {
        for legacy in super::super::permissions::LEGACY_HELPER_BUNDLE_IDS {
            assert!(expect(info(legacy, None), false, None).is_err(), "{legacy}");
        }
        assert!(expect(info("x\" or anchor apple", None), false, None).is_err());
        let mut no_hash = info("com.terminalx.next.dev.computer-use.v2", None);
        no_hash.cdhash.clear();
        assert!(expect(no_hash, false, None).is_err());
    }

    #[test]
    fn the_audit_token_names_its_pid_in_the_sixth_word() {
        let mut token = [0u8; 32];
        token[20..24].copy_from_slice(&4242i32.to_ne_bytes());
        assert_eq!(audit_token_pid(&token), 4242);
    }

    /// Two builds of one "helper" with the same identifier and different
    /// code: copies of this test binary, signed ad hoc.
    #[cfg(target_os = "macos")]
    fn two_builds(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let this = std::env::current_exe().unwrap();
        let sign = |path: &Path, extra: &[&str]| {
            std::fs::copy(&this, path).unwrap();
            let status = std::process::Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-", "--identifier", "com.terminalx.test.helper480"])
                .args(extra)
                .arg(path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        };
        let (current, older) = (dir.join("current"), dir.join("older"));
        sign(&current, &[]);
        sign(&older, &["--options", "runtime"]);
        (current, older)
    }

    #[cfg(target_os = "macos")]
    fn spawn(path: &Path, expected: &ExpectedHelper) -> std::io::Result<crate::computer::macos_native::HelperProcess> {
        let expected = expected.clone();
        let check: crate::computer::macos_native::CodeCheck = std::sync::Arc::new(move |peer| check(peer, &expected));
        crate::computer::macos_native::spawn_checked(path, &["--exact".into(), "no_such_test_480".into()], None, None, &check)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_the_exact_bundled_build_may_run_and_an_older_one_with_the_same_identity_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (current, older) = two_builds(dir.path());
        let expected = expected_for(&current, None).unwrap();
        assert_eq!(expected.identifier, "com.terminalx.test.helper480");
        assert_ne!(signing_info(&older).unwrap().cdhash, expected.cdhash);

        let mut accepted = spawn(&current, &expected).unwrap();
        accepted.wait();
        assert_eq!(accepted.try_wait().unwrap(), Some(0), "the accepted build was resumed and ran");

        let error = spawn(&older, &expected).err().expect("a different build is refused");
        assert!(error.to_string().contains("not the helper shipped with this TerminalX"), "{error}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_bundled_helper_whose_files_no_longer_match_its_signature_is_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let (current, _) = two_builds(dir.path());
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&current).unwrap().write_all(b"tampered").unwrap();
        assert!(signing_info(&current).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_released_app_refuses_a_helper_signed_under_another_identifier() {
        let dir = tempfile::tempdir().unwrap();
        let (current, _) = two_builds(dir.path());
        let error = expected_for(&current, Some("com.terminalx.next")).unwrap_err();
        assert!(error.contains("not com.terminalx.next.computer-use.v2"), "{error}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_socket_peer_is_checked_by_its_audit_token() {
        let dir = tempfile::tempdir().unwrap();
        let (current, _) = two_builds(dir.path());
        let expected = expected_for(&current, None).unwrap();
        // This test process is not the expected helper.
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        use std::os::fd::AsRawFd;
        let token = peer_audit_token(a.as_raw_fd()).unwrap();
        assert_eq!(audit_token_pid(&token), std::process::id() as i32);
        assert!(check(Peer::AuditToken(token), &expected).is_err());
    }
}
