//! The guest runtime's own OS account, as the password database records it
//! for the process's real and effective IDs. Nothing is created or changed.
#[cfg(target_os = "linux")]
use anyhow::Context as _;
use anyhow::{bail, Result};
use std::path::Path;

pub(super) struct User {
    pub short_name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
}

/// Copies only name/IDs/home from getpwuid_r. No password fields are read.
/// The caller-owned buffer and result are kept alive until the strings are copied.
pub(super) fn current_user() -> Result<User> {
    // SAFETY: these ID accessors have no pointer arguments/preconditions.
    let (uid, real_uid, gid, real_gid) = unsafe {
        (
            libc::geteuid(),
            libc::getuid(),
            libc::getegid(),
            libc::getgid(),
        )
    };
    if uid != real_uid || gid != real_gid {
        bail!("Guest account cannot use changed effective credentials");
    }
    let mut size = 1024;
    loop {
        let mut bytes = vec![0_u8; size];
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // SAFETY: entry/result are writable, bytes is a valid buffer of size
        // bytes.len(); getpwuid_r initializes entry on successful non-null result.
        let code = unsafe {
            libc::getpwuid_r(
                uid,
                entry.as_mut_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
                &mut result,
            )
        };
        if code == libc::ERANGE && size < 1024 * 1024 {
            size *= 2;
            continue;
        }
        if code != 0 || result.is_null() {
            bail!("OS account metadata is unavailable");
        }
        // SAFETY: the successful call initialized this structure; strings remain
        // valid in bytes until copied below. Null fields are refused explicitly.
        let entry = unsafe { entry.assume_init() };
        if entry.pw_name.is_null()
            || entry.pw_dir.is_null()
            || entry.pw_uid != uid
            || entry.pw_gid != gid
        {
            bail!("OS account identity differs from the current process");
        }
        // SAFETY: successful getpwuid_r returns NUL-terminated strings in bytes.
        let (short_name, home) = unsafe {
            (
                std::ffi::CStr::from_ptr(entry.pw_name).to_str()?.to_owned(),
                std::ffi::CStr::from_ptr(entry.pw_dir).to_str()?.to_owned(),
            )
        };
        if !Path::new(&home).is_absolute() {
            bail!("OS account home must be absolute");
        }
        return Ok(User {
            short_name,
            uid,
            gid,
            home,
        });
    }
}

#[cfg(target_os = "macos")]
pub(super) fn check_legacy_user() -> Result<()> {
    let user = current_user()?;
    if user.short_name != "lume"
        || user.uid < 501
        || user.gid == 0
        || user.home != "/Users/lume"
        || dirs::home_dir().as_deref() != Some(Path::new("/Users/lume"))
    {
        bail!("Legacy guest runtime requires its original non-root lume account");
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
const OWNER_HOME: &str = "/var/lib/terminalx-owner";

/// Check the OS identity, not merely HOME: changing HOME cannot separate a
/// key holder from processes running under the same UID.
#[cfg(any(target_os = "linux", test))]
fn validate_linux_owner(user: &User, home: Option<&Path>, groups: usize) -> Result<()> {
    if user.short_name != "terminalx-owner"
        || user.uid == 0
        || user.gid == 0
        || user.home != OWNER_HOME
        || home != Some(Path::new(OWNER_HOME))
        || groups != 0
    {
        bail!("Linux key holder requires the isolated terminalx-owner account and no supplementary groups");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn check_linux_owner() -> Result<()> {
    let user = current_user()?;
    // SAFETY: a zero-sized query does not dereference the null group buffer.
    let groups = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if groups < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    validate_linux_owner(&user, dirs::home_dir().as_deref(), groups as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> User {
        // A dedicated system account can have a UID below 1000.
        User {
            short_name: "terminalx-owner".into(),
            uid: 991,
            gid: 991,
            home: OWNER_HOME.into(),
        }
    }

    #[test]
    fn linux_owner_role_requires_os_identity_not_a_home_override() {
        let home = Some(Path::new(OWNER_HOME));
        assert!(validate_linux_owner(&owner(), home, 0).is_ok());
        let mut worker = owner();
        worker.short_name = "cua".into();
        assert!(validate_linux_owner(&worker, home, 0).is_err());
        worker.short_name = "terminalx-owner".into();
        worker.home = "/home/cua".into();
        assert!(validate_linux_owner(&worker, home, 0).is_err());
        assert!(validate_linux_owner(&owner(), Some(Path::new("/home/cua")), 0).is_err());
        assert!(validate_linux_owner(&owner(), None, 0).is_err());
    }

    #[test]
    fn linux_owner_role_rejects_root_and_supplementary_access() {
        let home = Some(Path::new(OWNER_HOME));
        let mut root = owner();
        root.uid = 0;
        assert!(validate_linux_owner(&root, home, 0).is_err());
        root = owner();
        root.gid = 0;
        assert!(validate_linux_owner(&root, home, 0).is_err());
        assert!(validate_linux_owner(&owner(), home, 1).is_err());
    }
}

#[cfg(any(target_os = "linux", test))]
fn validate_linux_worker(user: &User, home: Option<&Path>, groups: &[u32]) -> Result<()> {
    if user.short_name != "cua"
        || user.uid == 0
        || user.gid == 0
        || user.home != "/home/cua"
        || home != Some(Path::new("/home/cua"))
        || groups.iter().any(|gid| *gid != user.gid)
    {
        bail!("Linux execution runtime requires the unprivileged cua account");
    }
    Ok(())
}

/// Called before accepting inherited IPC, setting up hooks, or provider lookup.
/// The launcher's clean environment is checked, not silently repaired here.
#[cfg(target_os = "linux")]
#[allow(dead_code)] // The production worker entrypoint remains disabled.
pub(super) fn check_linux_worker() -> Result<()> {
    let user = current_user()?;
    let mut groups = [0u32; 64];
    // SAFETY: the group array is writable and contains 64 gid_t entries.
    let count = unsafe { libc::getgroups(groups.len() as i32, groups.as_mut_ptr()) };
    if count < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let home = std::env::var_os("HOME");
    validate_linux_worker(
        &user,
        home.as_deref().map(Path::new),
        &groups[..count as usize],
    )?;
    let (mut real, mut effective, mut saved) = (0, 0, 0);
    // SAFETY: all outputs are live writable uid_t/gid_t values.
    if unsafe { libc::getresuid(&mut real, &mut effective, &mut saved) } != 0
        || [real, effective, saved] != [user.uid; 3]
        || unsafe { libc::getresgid(&mut real, &mut effective, &mut saved) } != 0
        || [real, effective, saved] != [user.gid; 3]
    {
        bail!("Worker credentials retain another identity");
    }
    for (key, value) in std::env::vars_os() {
        let key = key
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid worker environment"))?;
        match key {
            "HOME" if value == "/home/cua" => (),
            "USER" | "LOGNAME" if value == "cua" => (),
            "PATH" if value == "/usr/local/bin:/usr/bin:/bin" => (),
            "LANG" if value == "C.UTF-8" => (),
            _ => bail!("Unexpected inherited worker environment variable: {key}"),
        }
    }
    // No saved credentials, inheritable/ambient capabilities or future setuid
    // exec may provide a reverse transition into the owner/root account.
    let status = std::fs::read_to_string("/proc/self/status")?;
    for field in ["CapInh:", "CapPrm:", "CapEff:", "CapAmb:"] {
        let value = status
            .lines()
            .find_map(|line| line.strip_prefix(field))
            .context("missing capability status")?;
        if u64::from_str_radix(value.trim(), 16)? != 0 {
            bail!("Worker retains capabilities");
        }
    }
    if unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) } != 1 {
        bail!("Worker must prohibit gaining privileges on exec");
    }
    Ok(())
}

#[cfg(test)]
mod worker_tests {
    use super::*;
    #[test]
    fn worker_role_refuses_owner_root_home_spoofing_and_extra_groups() {
        let mut worker = User {
            short_name: "cua".into(),
            uid: 1000,
            gid: 1000,
            home: "/home/cua".into(),
        };
        let home = Some(Path::new("/home/cua"));
        assert!(validate_linux_worker(&worker, home, &[]).is_ok());
        assert!(validate_linux_worker(&worker, home, &[1000]).is_ok());
        assert!(validate_linux_worker(&worker, home, &[991]).is_err());
        assert!(validate_linux_worker(&worker, Some(Path::new(OWNER_HOME)), &[]).is_err());
        worker.short_name = "terminalx-owner".into();
        assert!(validate_linux_worker(&worker, home, &[]).is_err());
        worker.short_name = "cua".into();
        worker.uid = 0;
        assert!(validate_linux_worker(&worker, home, &[]).is_err());
    }
}
