//! Processes a workspace being removed would leave running.
//!
//! Stopping a workspace's sessions ends their agents and the process groups
//! they own. What their tools started and then let go of is in neither: a
//! `cargo check` that outlived the rust-analyzer that started it, and the
//! build scripts under it (#689). They go on running from a directory that is
//! about to be deleted, holding the build lock other runs wait on.
//!
//! [`stop_in`] looks for processes of this user that work inside the
//! workspace: their working directory is in it, or they were given a
//! `--manifest-path` in it. One that has lost its parent (adopted by init) is
//! stopped, with everything it started. One that still has a parent belongs
//! to something alive, an editor or a shell a person opened there, and is
//! only listed.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long a process is given to end after it is asked to.
const GRACE: Duration = Duration::from_secs(3);

/// The longest a command is quoted in a report.
const COMMAND_LIMIT: usize = 240;

/// A process found working in a workspace being removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stray {
    pub pid: u32,
    pub command: String,
    /// Stopped; otherwise it still has a parent and was left alone.
    pub stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Process {
    pid: u32,
    ppid: u32,
    uid: u32,
    cwd: Option<PathBuf>,
    args: Vec<String>,
}

/// The processes of a host to judge against `dir`: what [`stop_in`] reads,
/// apart from the listing itself, so the choice can be tested on its own.
fn choose(dir: &Path, table: &[Process], me: u32, uid: u32) -> (Vec<u32>, Vec<u32>) {
    let canonical = std::fs::canonicalize(dir).ok();
    let under = |path: &Path| path.starts_with(dir) || canonical.as_deref().is_some_and(|canonical| path.starts_with(canonical));
    let inside = |process: &Process| {
        process.cwd.as_deref().is_some_and(under)
            || process.args.iter().enumerate().any(|(at, arg)| match arg.strip_prefix("--manifest-path") {
                Some("") => process.args.get(at + 1).is_some_and(|path| under(Path::new(path))),
                Some(rest) => rest.strip_prefix('=').is_some_and(|path| under(Path::new(path))),
                None => false,
            })
    };
    let ours: Vec<&Process> = table.iter().filter(|process| process.uid == uid && process.pid != me && process.pid > 1).collect();
    // Orphans working inside, then everything they started, however deep.
    let mut stop: BTreeSet<u32> = ours.iter().filter(|process| process.ppid == 1 && inside(process)).map(|process| process.pid).collect();
    loop {
        let more: Vec<u32> = ours.iter().filter(|process| stop.contains(&process.ppid) && !stop.contains(&process.pid)).map(|process| process.pid).collect();
        if more.is_empty() {
            break;
        }
        stop.extend(more);
    }
    let left = ours.iter().filter(|process| !stop.contains(&process.pid) && inside(process)).map(|process| process.pid).collect();
    (stop.into_iter().collect(), left)
}

fn command(process: &Process) -> String {
    let text = process.args.join(" ");
    let mut end = text.len().min(COMMAND_LIMIT);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end < text.len() { format!("{}…", &text[..end]) } else { text }
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists and may be signalled.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

fn signal(pid: u32, signal: libc::c_int) {
    // SAFETY: a plain kill(2) of one process id, never a group or 0/-1.
    unsafe {
        libc::kill(pid as libc::pid_t, signal);
    }
}

/// Stop the processes left working in `dir` that nothing alive owns, and say
/// which were found: the ones stopped, then the ones left because they still
/// have a parent. Called once the workspace's sessions are stopped and before
/// it is deleted.
pub fn stop_in(dir: &Path) -> Vec<Stray> {
    let table = processes();
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    let (stop, left) = choose(dir, &table, std::process::id(), uid);
    let described = |pid: &u32, stopped: bool| Stray { pid: *pid, command: table.iter().find(|process| process.pid == *pid).map(command).unwrap_or_default(), stopped };
    let mut found: Vec<Stray> = stop.iter().map(|pid| described(pid, true)).chain(left.iter().map(|pid| described(pid, false))).collect();
    if stop.is_empty() {
        return found;
    }
    for pid in &stop {
        signal(*pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + GRACE;
    while stop.iter().any(|pid| alive(*pid)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    for pid in stop.iter().filter(|pid| alive(**pid)) {
        signal(*pid, libc::SIGKILL);
    }
    // One that would not die even so is reported as still running.
    std::thread::sleep(Duration::from_millis(50));
    for stray in found.iter_mut().filter(|stray| stray.stopped) {
        stray.stopped = !alive(stray.pid);
    }
    found
}

#[cfg(target_os = "linux")]
fn processes() -> Vec<Process> {
    use std::os::unix::fs::MetadataExt;
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
            let path = entry.path();
            let stat = std::fs::read_to_string(path.join("stat")).ok()?;
            // `pid (comm) state ppid ...`: the name may hold spaces and parentheses.
            let ppid = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()?;
            let uid = std::fs::metadata(&path).ok()?.uid();
            let cwd = std::fs::read_link(path.join("cwd")).ok();
            let args = std::fs::read(path.join("cmdline")).unwrap_or_default().split(|byte| *byte == 0).filter(|arg| !arg.is_empty()).map(|arg| String::from_utf8_lossy(arg).into_owned()).collect();
            Some(Process { pid, ppid, uid, cwd, args })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn processes() -> Vec<Process> {
    use std::os::unix::ffi::OsStrExt;
    let width = std::mem::size_of::<libc::pid_t>();
    // SAFETY: with a null buffer the call only reports how many there are.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let mut pids: Vec<libc::pid_t> = vec![0; count as usize + 64];
    // SAFETY: the buffer is `pids.len() * width` bytes, as the call is told.
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * width) as libc::c_int) };
    if filled <= 0 {
        return Vec::new();
    }
    pids.truncate(filled as usize);
    let bsd_size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let path_size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    pids.into_iter()
        .filter(|pid| *pid > 0)
        .filter_map(|pid| {
            // SAFETY: each struct is plain C data of exactly the size the
            // kernel is told; it is read only when that is what it filled.
            let (ppid, uid) = unsafe {
                let mut info: libc::proc_bsdinfo = std::mem::zeroed();
                if libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), bsd_size) != bsd_size {
                    return None;
                }
                (info.pbi_ppid, info.pbi_uid)
            };
            // SAFETY: as above; the path is NUL-terminated within the struct.
            let cwd = unsafe {
                let mut info: libc::proc_vnodepathinfo = std::mem::zeroed();
                if libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), path_size) == path_size {
                    let bytes = std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr().cast::<u8>(), std::mem::size_of_val(&info.pvi_cdir.vip_path));
                    let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
                    (end > 0).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..end])))
                } else {
                    None
                }
            };
            Some(Process { pid: pid as u32, ppid, uid, cwd, args: arguments(pid) })
        })
        .collect()
}

/// A process's arguments, from `KERN_PROCARGS2`: the argument count, the
/// executable's path, padding, then the arguments, each ending in a NUL.
#[cfg(target_os = "macos")]
fn arguments(pid: libc::pid_t) -> Vec<String> {
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    // SAFETY: with a null buffer sysctl only reports the size it needs.
    if unsafe { libc::sysctl(name.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 4 {
        return Vec::new();
    }
    let mut buffer = vec![0u8; size];
    // SAFETY: the buffer is `size` bytes, as sysctl is told, and it says how many it filled.
    if unsafe { libc::sysctl(name.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 4 {
        return Vec::new();
    }
    buffer.truncate(size);
    let count = i32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]).max(0) as usize;
    buffer[4..].split(|byte| *byte == 0).skip(1).filter(|part| !part.is_empty()).take(count).map(|part| String::from_utf8_lossy(part).into_owned()).collect()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn processes() -> Vec<Process> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, ppid: u32, cwd: Option<&str>, args: &[&str]) -> Process {
        Process { pid, ppid, uid: 501, cwd: cwd.map(PathBuf::from), args: args.iter().map(|arg| arg.to_string()).collect() }
    }

    #[test]
    fn only_orphans_working_in_the_workspace_are_stopped_with_what_they_started() {
        let dir = Path::new("/repo/.raccoon/worktrees/664-usage");
        let table = [
            // rust-analyzer's check, whose parent exited, and the build script under it.
            process(84119, 1, Some("/repo/.raccoon/worktrees/664-usage/src-tauri"), &["cargo", "check", "--workspace", "--manifest-path", "/repo/.raccoon/worktrees/664-usage/src-tauri/Cargo.toml"]),
            process(84123, 84119, Some("/repo/.raccoon/worktrees/664-usage/src-tauri"), &["build-script-build"]),
            process(84124, 84123, Some("/tmp"), &["rustc", "-"]),
            // Started elsewhere for this workspace, and orphaned.
            process(90001, 1, Some("/"), &["cargo", "test", "--manifest-path=/repo/.raccoon/worktrees/664-usage/Cargo.toml"]),
            // A person's shell there, still in its terminal: listed, not stopped.
            process(700, 650, Some("/repo/.raccoon/worktrees/664-usage"), &["-zsh"]),
            // Another workspace whose name starts the same, another user's, this process, and launchd.
            process(800, 1, Some("/repo/.raccoon/worktrees/664-usage-2"), &["cargo", "build"]),
            Process { uid: 0, ..process(801, 1, Some("/repo/.raccoon/worktrees/664-usage"), &["sudo-thing"]) },
            process(42, 1, Some("/repo/.raccoon/worktrees/664-usage"), &["terminalx"]),
            process(1, 0, Some("/"), &["launchd"]),
            // A path mentioned in passing is not a manifest path.
            process(900, 1, Some("/"), &["less", "/repo/.raccoon/worktrees/664-usage/README.md"]),
        ];
        let (stop, left) = choose(dir, &table, 42, 501);
        assert_eq!(stop, [84119, 84123, 84124, 90001]);
        assert_eq!(left, [700]);
        assert_eq!(command(&table[3]), "cargo test --manifest-path=/repo/.raccoon/worktrees/664-usage/Cargo.toml");
        assert!(choose(Path::new("/elsewhere"), &table, 42, 501) == (Vec::new(), Vec::new()));
    }

    #[test]
    fn a_long_command_is_cut_short_on_a_character_boundary() {
        let long = "é".repeat(COMMAND_LIMIT);
        let quoted = command(&process(1, 1, None, &[&long]));
        assert!(quoted.ends_with('…') && quoted.len() <= COMMAND_LIMIT + '…'.len_utf8());
    }

    /// The real listing finds a process working in a directory and its parent,
    /// and stops it once it is orphaned.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_process_left_working_in_a_directory_is_found_and_an_orphaned_one_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let ours = std::process::Command::new("sleep").arg("300").current_dir(dir.path()).spawn().unwrap();
        let found = processes();
        let child = found.iter().find(|process| process.pid == ours.id()).expect("the listing sees the child");
        assert_eq!(child.ppid, std::process::id());
        assert!(child.cwd.as_deref().is_some_and(|cwd| std::fs::canonicalize(cwd).unwrap() == std::fs::canonicalize(dir.path()).unwrap()), "{:?}", child.cwd);
        assert_eq!(child.args, ["sleep", "300"]);
        // Ours, it has a parent: listed and left running.
        let listed = stop_in(dir.path());
        assert!(listed.iter().any(|stray| stray.pid == ours.id() && !stray.stopped), "{listed:?}");
        let mut ours = ours;
        assert!(ours.try_wait().unwrap().is_none());
        ours.kill().unwrap();
        ours.wait().unwrap();

        // Orphaned: its shell exits at once and leaves it to init (launchd on
        // macOS). A duration no other sleep has tells it apart.
        let marker = format!("3000.{}", std::process::id());
        std::process::Command::new("sh").arg("-c").arg(format!("(sleep {marker} &) ; exit 0")).current_dir(dir.path()).status().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let orphan = loop {
            let found = processes().into_iter().find(|process| process.args == ["sleep", marker.as_str()]);
            match found {
                Some(process) if process.ppid == 1 => break Some(process),
                // A subreaper (a container's init) adopts it instead: nothing to show here.
                Some(process) if Instant::now() >= deadline => {
                    signal(process.pid, libc::SIGKILL);
                    break None;
                }
                _ if Instant::now() >= deadline => break None,
                _ => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        let Some(orphan) = orphan else { return };
        let stopped = stop_in(dir.path());
        assert!(stopped.iter().any(|stray| stray.pid == orphan.pid && stray.stopped && stray.command == format!("sleep {marker}")), "{stopped:?}");
        assert!(!alive(orphan.pid));
    }
}
