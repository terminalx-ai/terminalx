//! Who holds the activity lease, so a conflict names the real holder (#767).
//! The OS says which process has the lock file open, whatever its version;
//! its executable says what it is.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Holder {
    App(u32),
    Runtime(u32),
    Command(u32),
    /// The holder could not be identified.
    Unknown,
}

impl Holder {
    pub(super) fn find(lock: &Path) -> Self {
        let own = std::process::id();
        holders(lock).into_iter().find(|pid| *pid != own).map_or(Self::Unknown, classify)
    }

    /// What Stats shows, once. Retry cannot help: the runtime takes the
    /// lease by itself as soon as the holder lets go.
    pub(super) fn notice(&self) -> String {
        let who = match self {
            Self::App(pid) => format!("The TerminalX app (pid {pid})"),
            Self::Runtime(pid) => format!("Another runtime (pid {pid})"),
            Self::Command(pid) => format!("A TerminalX command (pid {pid})"),
            Self::Unknown => "Another TerminalX process".into(),
        };
        format!("{who} is holding activity history. New agent work and PRs are kept aside and counted once it quits.")
    }
}

fn classify(pid: u32) -> Holder {
    #[cfg(unix)]
    if let Ok(executable) = libc::pid_t::try_from(pid).map_err(anyhow::Error::from).and_then(crate::local_runtime::launch::executable) {
        return of_executable(&executable, pid);
    }
    Holder::Command(pid)
}

/// The desktop app and the runtime are the only long-lived TerminalX
/// processes; anything else that opened the file ran as a command.
#[cfg_attr(not(unix), allow(dead_code))]
fn of_executable(executable: &Path, pid: u32) -> Holder {
    match executable.file_name().and_then(|name| name.to_str()) {
        Some("terminalx-serve") => Holder::Runtime(pid),
        Some("raccoon") => Holder::App(pid),
        _ => Holder::Command(pid),
    }
}

/// The processes that have `lock` open.
#[cfg(target_os = "macos")]
fn holders(lock: &Path) -> Vec<u32> {
    use std::os::unix::fs::MetadataExt;
    let Ok(metadata) = std::fs::metadata(lock) else { return Vec::new() };
    let (dev, ino) = (metadata.dev() as u32, metadata.ino());
    all_pids().into_iter().filter(|pid| opens(*pid, dev, ino)).filter_map(|pid| u32::try_from(pid).ok()).collect()
}

#[cfg(target_os = "macos")]
fn all_pids() -> Vec<libc::pid_t> {
    let width = std::mem::size_of::<libc::pid_t>();
    // SAFETY: with a null buffer the call only reports how many there are.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let mut pids: Vec<libc::pid_t> = vec![0; count as usize + 64];
    // SAFETY: the buffer is `pids.len() * width` bytes, as the call is told.
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * width) as libc::c_int) };
    pids.truncate(filled.max(0) as usize);
    pids.retain(|pid| *pid > 0);
    pids
}

/// `struct proc_fileinfo` and `struct vnode_fdinfo` from <sys/proc_info.h>,
/// which the libc crate does not carry.
#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcFileInfo {
    fi_openflags: u32,
    fi_status: u32,
    fi_offset: libc::off_t,
    fi_type: i32,
    fi_guardflags: u32,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct VnodeFdInfo {
    pfi: ProcFileInfo,
    pvi: libc::vnode_info,
}

#[cfg(target_os = "macos")]
const PROC_PIDFDVNODEINFO: libc::c_int = 1;

/// Whether `pid` has the file `dev`/`ino` open. Another user's process (or one
/// that exited meanwhile) cannot be read and is not it.
#[cfg(target_os = "macos")]
fn opens(pid: libc::pid_t, dev: u32, ino: u64) -> bool {
    let width = std::mem::size_of::<libc::proc_fdinfo>();
    // SAFETY: with a null buffer the call only reports the size it needs.
    let needed = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return false;
    }
    // SAFETY: proc_fdinfo is plain C data; all zeroes is a valid value.
    let mut fds: Vec<libc::proc_fdinfo> = vec![unsafe { std::mem::zeroed() }; needed as usize / width + 16];
    // SAFETY: the buffer is `fds.len() * width` bytes, as the call is told.
    let filled = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), (fds.len() * width) as libc::c_int) };
    fds.truncate(filled.max(0) as usize / width);
    let size = std::mem::size_of::<VnodeFdInfo>() as libc::c_int;
    fds.iter().filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32).any(|fd| {
        // SAFETY: `info` is plain C data of exactly `size` bytes; the kernel
        // fills it or reports another length, and it is read only on a match.
        unsafe {
            let mut info: VnodeFdInfo = std::mem::zeroed();
            libc::proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDVNODEINFO, (&mut info as *mut VnodeFdInfo).cast(), size) == size
                && info.pvi.vi_stat.vst_dev == dev
                && info.pvi.vi_stat.vst_ino == ino
        }
    })
}

/// The processes holding a lock on `lock`, from /proc/locks.
#[cfg(target_os = "linux")]
fn holders(lock: &Path) -> Vec<u32> {
    use std::os::unix::fs::MetadataExt;
    let Ok(metadata) = std::fs::metadata(lock) else { return Vec::new() };
    std::fs::read_to_string("/proc/locks")
        .map(|locks| lockers(&locks, metadata.dev(), metadata.ino()))
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn holders(_lock: &Path) -> Vec<u32> {
    Vec::new()
}

/// The pids in /proc/locks holding a lock on device `dev`, inode `ino`. A
/// line is `1: FLOCK  ADVISORY  WRITE 1234 08:01:5678 0 EOF`; one waiting
/// for a lock has `->` after its number and holds nothing.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn lockers(locks: &str, dev: u64, ino: u64) -> Vec<u32> {
    // glibc's major() and minor(), each truncated to 32 bits as there.
    let major = ((dev >> 8) & 0xfff) | ((dev >> 32) & 0xffff_f000);
    let minor = (dev & 0xff) | ((dev >> 12) & 0xffff_ff00);
    let file = format!("{major:02x}:{minor:02x}:{ino}");
    locks
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            (fields.get(1) != Some(&"->") && fields.get(5) == Some(&file.as_str())).then(|| fields.get(4)?.parse().ok()).flatten()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_holder_is_named_by_what_it_runs() {
        assert_eq!(of_executable(Path::new("/Applications/TerminalX.app/Contents/MacOS/raccoon"), 7), Holder::App(7));
        assert_eq!(of_executable(Path::new("/Applications/TerminalX.app/Contents/Resources/local-runtime/terminalx-serve"), 8), Holder::Runtime(8));
        assert_eq!(of_executable(Path::new("/usr/local/bin/some-tool"), 9), Holder::Command(9));
        assert!(Holder::App(7).notice().starts_with("The TerminalX app (pid 7) is holding activity history."));
        assert!(Holder::Runtime(8).notice().starts_with("Another runtime (pid 8)"));
        assert!(Holder::Command(9).notice().starts_with("A TerminalX command (pid 9)"));
        assert!(!Holder::Unknown.notice().contains("Retry"));
    }

    #[test]
    fn proc_locks_lines_name_only_the_processes_holding_that_file() {
        // st_dev 0x0801 is major 8, minor 1.
        let locks = "1: FLOCK  ADVISORY  WRITE 4242 08:01:5678 0 EOF\n\
                     1: -> FLOCK  ADVISORY  WRITE 4343 08:01:5678 0 EOF\n\
                     2: POSIX  ADVISORY  WRITE 99 08:01:1111 0 EOF\n\
                     3: FLOCK  ADVISORY  WRITE 77 00:2e:5678 0 EOF\n";
        assert_eq!(lockers(locks, 0x0801, 5678), [4242]);
        assert!(lockers(locks, 0x0801, 9).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_process_that_has_the_file_open_is_found() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("stats-activity.lock");
        let _open = std::fs::File::create(&lock).unwrap();
        assert!(holders(&lock).contains(&std::process::id()));
        // This process is never its own conflicting holder.
        assert_eq!(Holder::find(&lock), Holder::Unknown);
    }
}
