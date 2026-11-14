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
//! `--manifest-path` in it. Only a Rust build or check that has lost its
//! parent (adopted by init) is stopped, with what it started inside the
//! workspace. Anything else is listed and left alone: a process with a parent
//! belongs to something alive, an editor or a shell a person opened there, and
//! one detached on purpose (`screen`, `tmux`, `nohup`, an `ssh -f` tunnel, a
//! session leader of any kind) is someone's work. The report names programs,
//! never their arguments, which can carry a token or a password.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long a process is given to end after it is asked to.
const GRACE: Duration = Duration::from_secs(3);

/// A process found working in a workspace being removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stray {
    pub pid: u32,
    /// The program's name, without its path or arguments.
    pub program: String,
    /// Stopped; otherwise it was left running.
    pub stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Process {
    pid: u32,
    ppid: u32,
    uid: u32,
    /// It leads its own session (`setsid`): something detached on purpose.
    /// True too when that cannot be read.
    leader: bool,
    cwd: Option<PathBuf>,
    args: Vec<String>,
}

fn program(process: &Process) -> &str {
    let first = process.args.first().map(String::as_str).unwrap_or_default();
    first.rsplit('/').next().unwrap_or(first)
}

/// A Rust build or check, as a build tool or an editor starts one: never a
/// program a person runs (`cargo run`), installs or keeps watching.
fn build_tool(process: &Process) -> bool {
    match program(process) {
        "cargo" | "cargo-clippy" => {
            let subcommand = process.args.iter().skip(1).find(|arg| !arg.starts_with('-') && !arg.starts_with('+'));
            matches!(subcommand.map(String::as_str), Some("check" | "c" | "build" | "b" | "clippy" | "test" | "t" | "nextest" | "bench" | "doc" | "d" | "metadata" | "rustc" | "rustdoc" | "fetch"))
        }
        "rustc" | "rustdoc" | "clippy-driver" | "rust-analyzer" | "rust-analyzer-proc-macro-srv" => true,
        name => name.starts_with("build-script-") || name.starts_with("build_script_"),
    }
}

/// The processes of a host to judge against `dir`: what [`stop_in`] reads,
/// apart from the listing itself, so the choice can be tested on its own.
/// Which to stop, and which to list only.
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
    let ours: Vec<&Process> = table.iter().filter(|process| process.uid == uid && process.pid != me && process.pid > 1 && inside(process)).collect();
    // Orphaned builds and checks, then what they started in the workspace:
    // a build script, a test binary. Never a session leader, whatever started it.
    let mut stop: BTreeSet<u32> = ours.iter().filter(|process| process.ppid == 1 && !process.leader && build_tool(process)).map(|process| process.pid).collect();
    loop {
        let more: Vec<u32> = ours.iter().filter(|process| stop.contains(&process.ppid) && !stop.contains(&process.pid) && !process.leader).map(|process| process.pid).collect();
        if more.is_empty() {
            break;
        }
        stop.extend(more);
    }
    let left = ours.iter().filter(|process| !stop.contains(&process.pid)).map(|process| process.pid).collect();
    (stop.into_iter().collect(), left)
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

/// Stop the leftover builds and checks working in `dir`, and say what was
/// found: the ones stopped, then the ones left running. Called once the
/// workspace's sessions are stopped and before it is deleted.
pub fn stop_in(dir: &Path) -> Vec<Stray> {
    let table = processes();
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    let (stop, left) = choose(dir, &table, std::process::id(), uid);
    let described = |pid: &u32, stopped: bool| Stray { pid: *pid, program: table.iter().find(|process| process.pid == *pid).map(program).unwrap_or_default().to_string(), stopped };
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
            // `pid (comm) state ppid pgrp session ...`: the name may hold spaces and parentheses.
            let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
            let ppid = fields.get(1)?.parse().ok()?;
            let leader = fields.get(3).and_then(|session| session.parse::<u32>().ok()).is_none_or(|session| session == pid);
            let uid = std::fs::metadata(&path).ok()?.uid();
            let cwd = std::fs::read_link(path.join("cwd")).ok();
            let args = std::fs::read(path.join("cmdline")).unwrap_or_default().split(|byte| *byte == 0).filter(|arg| !arg.is_empty()).map(|arg| String::from_utf8_lossy(arg).into_owned()).collect();
            Some(Process { pid, ppid, uid, leader, cwd, args })
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
            // SAFETY: getsid only reads; an error (-1) is taken as a leader.
            let session = unsafe { libc::getsid(pid) };
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
            Some(Process { pid: pid as u32, ppid, uid, leader: session < 0 || session == pid, cwd, args: arguments(pid) })
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
        Process { pid, ppid, uid: 501, leader: false, cwd: cwd.map(PathBuf::from), args: args.iter().map(|arg| arg.to_string()).collect() }
    }

    const DIR: &str = "/repo/.raccoon/worktrees/664-usage";

    #[test]
    fn only_orphaned_builds_in_the_workspace_are_stopped_with_what_they_started_there() {
        let table = [
            // rust-analyzer's check, whose parent exited, and the build script under it.
            process(84119, 1, Some("/repo/.raccoon/worktrees/664-usage/src-tauri"), &["/Users/me/.rustup/toolchains/stable/bin/cargo", "check", "--workspace", "--message-format=json", "--manifest-path", "/repo/.raccoon/worktrees/664-usage/src-tauri/Cargo.toml"]),
            process(84123, 84119, Some("/repo/.raccoon/worktrees/664-usage/src-tauri"), &["/repo/.raccoon/worktrees/664-usage/src-tauri/target/debug/build/raccoon-1/build-script-build"]),
            // What that build script started elsewhere: not the workspace's to stop.
            process(84124, 84123, Some("/tmp"), &["cc", "-c", "x.c"]),
            // Started elsewhere for this workspace, and orphaned.
            process(90001, 1, Some("/"), &["cargo", "+nightly", "test", "--manifest-path=/repo/.raccoon/worktrees/664-usage/Cargo.toml"]),
            process(90002, 90001, Some("/repo/.raccoon/worktrees/664-usage"), &["/repo/.raccoon/worktrees/664-usage/target/debug/deps/usage-0123"]),
        ];
        let (stop, left) = choose(Path::new(DIR), &table, 42, 501);
        assert_eq!(stop, [84119, 84123, 90001, 90002]);
        assert!(left.is_empty());
        assert_eq!(program(&table[0]), "cargo");
        assert_eq!(program(&table[1]), "build-script-build");
        assert_eq!(choose(Path::new("/elsewhere"), &table, 42, 501), (Vec::new(), Vec::new()));
    }

    #[test]
    fn anything_detached_on_purpose_or_still_owned_is_listed_and_left_running() {
        let screen = Process { leader: true, ..process(700, 1, Some(DIR), &["SCREEN", "-dmS", "work"]) };
        let table = [
            // A detached screen session, adopted by launchd, and the shell in its window.
            screen,
            process(701, 700, Some(DIR), &["-zsh"]),
            // A tmux server, a nohup'd server, an ssh tunnel and the app itself the person runs, orphaned there.
            Process { leader: true, ..process(710, 1, Some(DIR), &["tmux"]) },
            process(711, 1, Some(DIR), &["python3", "-m", "http.server"]),
            process(712, 1, Some(DIR), &["ssh", "-f", "-N", "-L", "5432:db:5432", "bastion"]),
            process(713, 1, Some(DIR), &["cargo", "run", "--release"]),
            process(714, 1, Some(DIR), &["cargo", "watch", "-x", "check"]),
            // A build that leads its own session was detached on purpose too.
            Process { leader: true, ..process(715, 1, Some(DIR), &["cargo", "build"]) },
            // A person's shell there, and the check its editor runs: they have parents.
            process(720, 650, Some(DIR), &["-zsh"]),
            process(721, 600, Some(DIR), &["cargo", "check"]),
            // Another workspace whose name starts the same, another user's, this process, and launchd.
            process(800, 1, Some("/repo/.raccoon/worktrees/664-usage-2"), &["cargo", "build"]),
            Process { uid: 0, ..process(801, 1, Some(DIR), &["cargo", "build"]) },
            process(42, 1, Some(DIR), &["terminalx"]),
            process(1, 0, Some("/"), &["launchd"]),
            // A path mentioned in passing is not a manifest path.
            process(900, 1, Some("/"), &["less", "/repo/.raccoon/worktrees/664-usage/README.md"]),
        ];
        let (stop, left) = choose(Path::new(DIR), &table, 42, 501);
        assert!(stop.is_empty(), "{stop:?}");
        assert_eq!(left, [700, 701, 710, 711, 712, 713, 714, 715, 720, 721]);
    }

    /// The real listing finds a process working in a directory, with its
    /// parent and session; it stops an orphaned build there and nothing else.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_leftover_build_in_a_directory_is_stopped_and_a_detached_program_is_only_listed() {
        let dir = tempfile::tempdir().unwrap();
        let ours = std::process::Command::new("sleep").arg("300").current_dir(dir.path()).spawn().unwrap();
        let found = processes();
        let child = found.iter().find(|process| process.pid == ours.id()).expect("the listing sees the child");
        assert_eq!(child.ppid, std::process::id());
        assert!(!child.leader);
        assert!(child.cwd.as_deref().is_some_and(|cwd| std::fs::canonicalize(cwd).unwrap() == std::fs::canonicalize(dir.path()).unwrap()), "{:?}", child.cwd);
        assert_eq!(child.args, ["sleep", "300"]);
        // Ours, it has a parent: listed and left running, named without its arguments.
        let listed = stop_in(dir.path());
        assert!(listed.iter().any(|stray| stray.pid == ours.id() && !stray.stopped && stray.program == "sleep"), "{listed:?}");
        let mut ours = ours;
        assert!(ours.try_wait().unwrap().is_none());
        ours.kill().unwrap();
        ours.wait().unwrap();

        // Orphaned: each shell exits at once and leaves its job to init
        // (launchd on macOS). Durations no other sleep has tell them apart;
        // `exec -a` names one as a build script.
        let id = std::process::id();
        let (build, detached) = (format!("3000.{id}1"), format!("3000.{id}2"));
        for (name, duration) in [("build-script-build", &build), ("sleep", &detached)] {
            std::process::Command::new("bash").arg("-c").arg(format!("(exec -a {name} sleep {duration} &) ; exit 0")).current_dir(dir.path()).status().unwrap();
        }
        let orphan = |duration: &str| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let found = processes().into_iter().find(|process| process.args.get(1).is_some_and(|arg| arg == duration));
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
            }
        };
        let (Some(build), Some(detached)) = (orphan(&build), orphan(&detached)) else { return };
        let found = stop_in(dir.path());
        assert!(found.iter().any(|stray| stray.pid == build.pid && stray.stopped && stray.program == "build-script-build"), "{found:?}");
        assert!(found.iter().any(|stray| stray.pid == detached.pid && !stray.stopped), "{found:?}");
        assert!(!alive(build.pid));
        assert!(alive(detached.pid), "a program that is not a build is never stopped");
        signal(detached.pid, libc::SIGKILL);
    }
}
