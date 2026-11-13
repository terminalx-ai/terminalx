//! Linux ownership witness. Only the helper's single main thread may reap.
//!
//! Candidate discovery is deliberately separate from extinction: even an empty
//! children file cannot settle ownership. Only the all-child wait can do that.
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::ffi::CString;
use super::protocol::Launch;
use super::protocol::{self, Request, Response};
use uuid::Uuid;
use std::collections::VecDeque;

const WALL: i32 = 0x4000_0000;
/// The helper's exit status when its channel was lost and its own all-child
/// wait then found nothing left: it never exits so otherwise. Reaped from
/// the exact helper, it settles the launch the runtime had lost (#467).
pub(super) const EMPTY_AFTER_LOSS: i32 = 124;
const MAX_CHILDREN: usize = 4096;
const MAX_CHILD_BYTES: u64 = 64 * 1024;

fn syscall_result(value: libc::c_long) -> io::Result<libc::c_long> {
    if value < 0 { Err(io::Error::last_os_error()) } else { Ok(value) }
}

pub(super) fn pidfd(pid: libc::pid_t) -> io::Result<OwnedFd> {
    let fd = syscall_result(unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) })?;
    // SAFETY: successful pidfd_open returned a fresh owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
}

pub(super) fn signal_fd(fd: RawFd, signal: i32) -> io::Result<()> {
    syscall_result(unsafe {
        libc::syscall(libc::SYS_pidfd_send_signal, fd, signal, std::ptr::null::<libc::siginfo_t>(), 0)
    }).map(|_| ())
}

/// No consumer other than the helper loop calls waitpid. A bounded batch that
/// exhausts its allowance is indeterminate, never empty.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Children { Live, Empty, Churning }

pub(super) fn drain(mut exited: impl FnMut(libc::pid_t, i32)) -> io::Result<Children> {
    for _ in 0..MAX_CHILDREN {
        let mut status = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG | WALL) };
        if pid > 0 {
            // Traced stop events can be returned without WUNTRACED; they are
            // not an exit and cannot stand in for the original shell status.
            if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) { exited(pid, status); }
        } else if pid == 0 {
            return Ok(Children::Live);
        } else {
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ECHILD) => return Ok(Children::Empty),
                Some(libc::EINTR) => continue,
                _ => return Err(error),
            }
        }
    }
    Ok(Children::Churning)
}

fn eligible_child(pid: libc::pid_t) -> io::Result<()> {
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    let result = unsafe {
        libc::waitid(libc::P_PID, pid as libc::id_t, &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT | WALL)
    };
    if result < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

/// The sole reaper does not reap between eligibility and signalling. An exited
/// child therefore still reserves its PID. Revalidation rejects stale/nonchild
/// candidates; a pidfd alone would not establish ownership.
pub(super) fn signal_child(pid: libc::pid_t, signal: i32) -> io::Result<()> {
    eligible_child(pid)?;
    let fd = pidfd(pid)?;
    eligible_child(pid)?;
    match signal_fd(fd.as_raw_fd(), signal) {
        Err(e) if e.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        result => result,
    }
}

fn candidates() -> io::Result<Vec<libc::pid_t>> {
    #[cfg(test)]
    if std::env::var_os("TX467_ANCESTRY_OMIT").is_some_and(|path| std::path::Path::new(&path).exists()) {
        return Ok(Vec::new()); // Discovery-only fault: never replace the all-child wait.
    }
    let tid = unsafe { libc::syscall(libc::SYS_gettid) };
    if tid <= 0 { return Err(io::Error::last_os_error()); }
    let file = File::open(format!("/proc/self/task/{tid}/children"))?;
    let mut bytes = Vec::new();
    file.take(MAX_CHILD_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CHILD_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "child discovery exceeds bound"));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid child discovery"))?;
    let mut result = Vec::new();
    for item in text.split_whitespace() {
        let pid = item.parse::<libc::pid_t>().ok().filter(|pid| *pid > 0)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid child identity"))?;
        if result.len() == MAX_CHILDREN {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "too many child candidates"));
        }
        result.push(pid);
    }
    Ok(result)
}

pub(super) fn signal_children(signal: i32) -> io::Result<()> {
    let mut failure = None;
    for pid in candidates()? {
        if let Err(error) = signal_child(pid, signal) { failure.get_or_insert(error); }
    }
    failure.map_or(Ok(()), Err)
}

/// Call in the freshly exec'd, dedicated, single-thread helper before any
/// owned fork. Unsupported kernel/seccomp/proc configurations fail pre-launch.
pub(super) fn preflight() -> io::Result<()> {
    if unsafe { libc::syscall(libc::SYS_gettid) } != unsafe { libc::getpid() } as libc::c_long {
        return Err(io::Error::other("supervisor must run on its fresh main thread"));
    }
    #[cfg(test)]
    assert_single_thread("entry");
    // Nothing else may wait for children here, or run while this forks.
    if std::fs::read_dir("/proc/self/task")?.count() != 1 {
        return Err(io::Error::other("supervisor must be single threaded"));
    }
    let mut own_stat = Vec::new();
    File::open("/proc/self/stat")?.take(4097).read_to_end(&mut own_stat)?;
    let own_pid = own_stat.split(|byte| byte.is_ascii_whitespace()).next()
        .and_then(|pid| std::str::from_utf8(pid).ok()).and_then(|pid| pid.parse::<libc::pid_t>().ok());
    if own_stat.len() > 4096 || own_pid != Some(unsafe { libc::getpid() }) {
        return Err(io::Error::other("proc PID view does not match supervisor PID namespace"));
    }
    // This range cannot contain an open descriptor. Check the actual close_range
    // operation used by the child, without touching a real descriptor.
    syscall_result(unsafe { libc::syscall(libc::SYS_close_range, u32::MAX, u32::MAX, 0) })?;
    let own = pidfd(unsafe { libc::getpid() })?;
    signal_fd(own.as_raw_fd(), 0)?;
    candidates()?;
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    let result = unsafe { libc::waitid(libc::P_ALL, 0, &mut info,
        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT | WALL) };
    if result != -1 || io::Error::last_os_error().raw_os_error() != Some(libc::ECHILD) {
        return Err(io::Error::other("helper must begin without children and support all-child waitid"));
    }
    if drain(|_, _| {})? != Children::Empty {
        return Err(io::Error::other("helper already owns children"));
    }
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut enabled: libc::c_int = 0;
    if unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut enabled, 0, 0, 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    if enabled != 1 { return Err(io::Error::other("subreaper setup not retained")); }
    Ok(())
}

pub(super) fn monotonic() -> io::Result<libc::timespec> {
    let mut time = unsafe { std::mem::zeroed::<libc::timespec>() };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } < 0 {
        Err(io::Error::last_os_error())
    } else { Ok(time) }
}

/// An absolute deadline prevents incidental signals from shortening backoff.
/// Errors propagate: callers must retain the witness, not certify or spin.
pub(super) fn backoff() -> io::Result<()> {
    let mut until = monotonic()?;
    until.tv_nsec += 50_000_000;
    if until.tv_nsec >= 1_000_000_000 { until.tv_sec += 1; until.tv_nsec -= 1_000_000_000; }
    loop {
        let error = unsafe { libc::clock_nanosleep(libc::CLOCK_MONOTONIC,
            libc::TIMER_ABSTIME, &until, std::ptr::null_mut()) };
        match error {
            0 => return Ok(()),
            libc::EINTR => continue,
            _ => return Err(io::Error::from_raw_os_error(error)),
        }
    }
}

/// Block every catchable signal in the witness, including arbitrary clone exit
/// signals. SIGKILL/SIGSTOP remain outside our control: witness loss/suspension
/// must stay unconfirmed in the parent. A timed poll also covers exit_signal=0.
pub(super) fn wake_descriptor() -> io::Result<OwnedFd> {
    unsafe {
        if libc::signal(libc::SIGCHLD, libc::SIG_DFL) == libc::SIG_ERR {
            return Err(io::Error::last_os_error());
        }
        let mut watched = std::mem::zeroed::<libc::sigset_t>();
        if libc::sigfillset(&mut watched) < 0
            || libc::sigdelset(&mut watched, libc::SIGKILL) < 0
            || libc::sigdelset(&mut watched, libc::SIGSTOP) < 0
            || libc::sigprocmask(libc::SIG_SETMASK, &watched, std::ptr::null_mut()) < 0
        { return Err(io::Error::last_os_error()); }
        let fd = libc::signalfd(-1, &watched, libc::SFD_CLOEXEC | libc::SFD_NONBLOCK);
        if fd < 0 { return Err(io::Error::last_os_error()); }
        Ok(OwnedFd::from_raw_fd(fd))
    }
}

pub(super) fn consume_wake(fd: RawFd) -> io::Result<()> {
    // Bounded even if another process continuously sends signals. Readiness is
    // only a hint; never a second wait consumer or an extinction condition.
    for _ in 0..32 {
        let mut info = unsafe { std::mem::zeroed::<libc::signalfd_siginfo>() };
        let n = unsafe { libc::read(fd, (&mut info as *mut libc::signalfd_siginfo).cast(), std::mem::size_of_val(&info)) };
        if n == std::mem::size_of_val(&info) as isize { continue; }
        if n < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock { return Ok(()); }
            if error.kind() == io::ErrorKind::Interrupted { continue; }
            return Err(error);
        }
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "invalid supervisor wake record"));
    }
    Ok(())
}

pub(super) struct Executable {
    path: CString,
    args: Vec<CString>,
    env: Vec<CString>,
    cwd: CString,
}

impl Executable {
    pub(super) fn prepare(launch: Launch) -> io::Result<Self> {
        let cstring = |bytes| CString::new(bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in child configuration"));
        if launch.argv.is_empty() || launch.executable.first() != Some(&b'/') || launch.cwd.first() != Some(&b'/') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "child needs absolute executable/cwd and argv"));
        }
        let args = launch.argv.into_iter().map(&cstring).collect::<io::Result<_>>()?;
        let mut env = Vec::with_capacity(launch.env.len());
        for (mut name, value) in launch.env {
            if name.is_empty() || name.contains(&b'=') {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid environment name"));
            }
            name.push(b'='); name.extend(value);
            env.push(cstring(name)?);
        }
        Ok(Self { path: cstring(launch.executable)?, args, env, cwd: cstring(launch.cwd)? })
    }

    /// CLOEXEC EOF plus retained-child state identifies the exec transition.
    /// It does not promise completion of later loader steps or program entry.
    /// The parent must reconcile that handshake before Started, not merely fork.
    /// No allocation, locks, destructor or Rust runtime calls in the child.
    pub(super) fn fork(&self, slave: RawFd) -> io::Result<(libc::pid_t, OwnedFd)> {
        let mut args: Vec<_> = self.args.iter().map(|s| s.as_ptr()).collect();
        args.push(std::ptr::null());
        let mut env: Vec<_> = self.env.iter().map(|s| s.as_ptr()).collect();
        env.push(std::ptr::null());
        let mut pipe = [-1; 2];
        if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let read = unsafe { OwnedFd::from_raw_fd(pipe[0]) };
        let write = unsafe { OwnedFd::from_raw_fd(pipe[1]) };
        if write.as_raw_fd() < 3 || slave < 3 {
            return Err(io::Error::other("invalid child descriptor layout"));
        }
        #[cfg(test)]
        let hold_before_exec = matches!(std::env::var("TX467_SUPERVISOR_FAULT").as_deref(), Ok("kill-before-eof" | "timeout-before-exec" | "timeout-late-exec"));
        #[cfg(test)]
        let fail_error_write = std::env::var("TX467_SUPERVISOR_FAULT").as_deref() == Ok("failed-error-write");
        #[cfg(test)]
        assert_single_thread("fork");
        let pid = unsafe { libc::fork() };
        if pid < 0 { return Err(io::Error::last_os_error()); }
        if pid == 0 {
            unsafe {
                let error_fd = write.as_raw_fd();
                // portable-pty clears the complete mask and resets these
                // dispositions; std::process additionally restores SIGPIPE.
                for signal in [libc::SIGCHLD, libc::SIGHUP, libc::SIGINT, libc::SIGQUIT,
                    libc::SIGTERM, libc::SIGALRM, libc::SIGPIPE] {
                    if libc::signal(signal, libc::SIG_DFL) == libc::SIG_ERR { child_error(error_fd, 1); }
                }
                let mut mask = std::mem::zeroed::<libc::sigset_t>();
                if libc::sigemptyset(&mut mask) < 0 || libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut()) < 0 {
                    child_error(error_fd, 2);
                }
                if libc::setsid() < 0 { child_error(error_fd, 3); }
                for fd in 0..3 { if libc::dup2(slave, fd) < 0 { child_error(error_fd, 4); } }
                if libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 { child_error(error_fd, 5); }
                if libc::chdir(self.cwd.as_ptr()) < 0 { child_error(error_fd, 6); }
                if error_fd > 3 && libc::syscall(libc::SYS_close_range, 3u32, (error_fd - 1) as u32, 0) < 0 {
                    child_error(error_fd, 7);
                }
                if libc::syscall(libc::SYS_close_range, (error_fd + 1) as u32, u32::MAX, 0) < 0 {
                    child_error(error_fd, 7);
                }
                #[cfg(test)]
                if fail_error_write { libc::close(error_fd); child_error(error_fd, 8); }
                #[cfg(test)]
                if hold_before_exec { libc::raise(libc::SIGSTOP); }
                libc::execve(self.path.as_ptr(), args.as_ptr(), env.as_ptr());
                child_error(error_fd, 8);
            }
        }
        drop(write);
        Ok((pid, read))
    }
}

unsafe fn child_error(fd: RawFd, stage: i32) -> ! {
    let record = [stage, *libc::__errno_location()];
    // Eight bytes are below PIPE_BUF; one writer and an empty pipe. EINTR can
    // be retried without allocating. A failed write still exits unsuccessfully;
    // the parent must never interpret a signalled/failed bootstrap as readiness.
    loop {
        let n = libc::write(fd, record.as_ptr().cast(), std::mem::size_of_val(&record));
        if n >= 0 || *libc::__errno_location() != libc::EINTR { break; }
    }
    libc::_exit(127)
}

fn millis() -> io::Result<i64> {
    let time = monotonic()?;
    time.tv_sec.checked_mul(1000).and_then(|n| n.checked_add(time.tv_nsec / 1_000_000))
        .ok_or_else(|| io::Error::other("monotonic clock overflow"))
}

fn verify_channel(control: RawFd, slave: RawFd) -> io::Result<()> {
    let mut kind: libc::c_int = 0;
    let mut length = std::mem::size_of_val(&kind) as libc::socklen_t;
    if unsafe { libc::getsockopt(control, libc::SOL_SOCKET, libc::SO_TYPE, (&mut kind as *mut libc::c_int).cast(), &mut length) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut peer = unsafe { std::mem::zeroed::<libc::ucred>() };
    length = std::mem::size_of_val(&peer) as libc::socklen_t;
    if unsafe { libc::getsockopt(control, libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut peer as *mut libc::ucred).cast(), &mut length) } < 0 {
        return Err(io::Error::last_os_error());
    }
    if kind != libc::SOCK_SEQPACKET || peer.pid != unsafe { libc::getppid() }
        || peer.uid != unsafe { libc::getuid() } || unsafe { libc::isatty(slave) } != 1
    { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "invalid inherited supervisor descriptors")); }
    Ok(())
}

/// Supervise only for the parent that is this same program, at the same
/// privilege. The inherited channel already names the parent (SO_PEERCRED
/// pid and uid, checked above); this checks what that parent is. Both
/// `/proc/<pid>/exe` links resolve to the exact image mapped, so a file
/// replaced or removed since launch still compares as itself.
pub(super) fn verify_ancestry() -> io::Result<()> {
    let (uid, euid, gid, egid) = unsafe { (libc::getuid(), libc::geteuid(), libc::getgid(), libc::getegid()) };
    if uid != euid || gid != egid {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "supervisor must not run with changed privileges"));
    }
    let identity = |path: &str| -> io::Result<(u64, u64)> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path)?;
        Ok((metadata.dev(), metadata.ino()))
    };
    let own = identity("/proc/self/exe")?;
    let parent = identity(&format!("/proc/{}/exe", unsafe { libc::getppid() }))?;
    if own != parent {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "supervisor parent is not this program"));
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum ExecObservation { Ready, Exiting, Interrupted }

/// This is the retained original child, not a PID census. Until this check has
/// a terminal outcome the sole reaper leaves it waitable, preventing PID reuse
/// and preserving proc state even for an immediate successful exit.
/// Linux sets PF_FORKNOEXEC in copy_process and clears it in begin_new_exec
/// after the point of no return and before close-on-exec descriptors are closed.
/// A setup-error writer which itself fails still has PF_FORKNOEXEC set.
fn observe_exec_eof(pid: libc::pid_t) -> io::Result<ExecObservation> {
    const PF_EXITING: u64 = 0x0000_0004;
    const PF_FORKNOEXEC: u64 = 0x0000_0040;
    let mut bytes = Vec::new();
    File::open(format!("/proc/{pid}/stat"))?.take(4097).read_to_end(&mut bytes)?;
    #[cfg(test)]
    inject_proc_observation(pid, &mut bytes)?;
    if bytes.len() > 4096 { return Err(io::Error::other("oversized child exec state")); }
    // comm may contain spaces, parentheses and non-UTF8 bytes. Only the numeric
    // fields following its last closing parenthesis are parsed.
    let open = bytes.iter().position(|byte| *byte == b'(').ok_or_else(|| io::Error::other("invalid child exec identity"))?;
    let observed = std::str::from_utf8(&bytes[..open]).ok().and_then(|value| value.trim().parse::<libc::pid_t>().ok());
    if observed != Some(pid) { return Err(io::Error::other("child proc identity does not match retained launch")); }
    let close = bytes.iter().rposition(|byte| *byte == b')').filter(|close| *close > open).ok_or_else(|| io::Error::other("invalid child exec state"))?;
    let fields = bytes[close + 1..].split(|byte| byte.is_ascii_whitespace()).filter(|field| !field.is_empty()).collect::<Vec<_>>();
    let flags = fields.get(6).and_then(|bytes| std::str::from_utf8(bytes).ok()).and_then(|flags| flags.parse::<u64>().ok())
        .ok_or_else(|| io::Error::other("missing child exec flags"))?;
    if flags & PF_FORKNOEXEC != 0 { return Ok(ExecObservation::Interrupted); }
    #[cfg(test)]
    if injected_exit_hold() { return Ok(ExecObservation::Exiting); }
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    if unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT | WALL) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let observed = unsafe { info.si_pid() };
    if observed != 0 && observed != pid { return Err(io::Error::other("child wait identity does not match retained launch")); }
    if observed != 0 {
        return Ok(if info.si_code == libc::CLD_EXITED { ExecObservation::Ready } else { ExecObservation::Interrupted });
    }
    // exit_files may have closed the pipe before wait status is reportable.
    // Do not turn that intermediate state into a readiness notification.
    Ok(if flags & PF_EXITING != 0 { ExecObservation::Exiting } else { ExecObservation::Ready })
}

struct Stop { claim: u64, started: i64, reported: bool }

/// Invoked before application/thread initialization. The fixed descriptors are
/// created by the exact parent launch; there is no listener or discoverable RPC.
pub(super) fn run(launch: Uuid) -> i32 {
    let control = 3;
    let slave = 4;
    if verify_channel(control, slave).is_err() { return 120; }
    // Remove inherited descriptors before creating any others. Normal helper
    // dispatch owns neither the PTY master nor any application service handle.
    if unsafe { libc::syscall(libc::SYS_close_range, 5u32, u32::MAX, 0) } < 0 { return 121; }
    let control = unsafe { OwnedFd::from_raw_fd(control) };
    // The channel is the parent's; refuse before preflight for any other
    // parent, and say why on it. No child exists yet.
    if let Err(error) = verify_ancestry() {
        let _ = protocol::send(control.as_raw_fd(), launch, &Response::Failed {
            stage: "ancestry".into(), errno: error.raw_os_error().unwrap_or(libc::EPERM),
        });
        return 125;
    }
    let mut slave = Some(unsafe { OwnedFd::from_raw_fd(slave) });
    #[cfg(test)]
    if std::env::var("TX467_SUPERVISOR_FAULT").as_deref() == Ok("preflight-after-live-check") {
        let marker = std::env::var_os("TX467_H1_PARENT_LIVE").expect("private H1 barrier path");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !std::path::Path::new(&marker).exists() {
            assert!(std::time::Instant::now() < deadline, "parent did not observe live helper");
            backoff().unwrap();
        }
        assert_single_thread("preflight-failure");
        assert!(protocol::send(control.as_raw_fd(), launch, &Response::Failed {
            stage: "injected preflight".into(), errno: libc::ENOTSUP,
        }).unwrap());
        return 122; // Real helper exit, before Ready/config/Launch/child creation.
    }
    let setup = wake_descriptor().and_then(|wake| { preflight()?; Ok(wake) });
    let wake = match setup {
        Ok(wake) => wake,
        Err(error) => {
            let _ = protocol::send(control.as_raw_fd(), launch, &Response::Failed {
                stage: "preflight".into(), errno: error.raw_os_error().unwrap_or(libc::EIO),
            });
            return 122; // No child has been launched.
        }
    };
    #[cfg(test)]
    if let Some(path) = std::env::var_os("TX467_NONEXEC_CLONE_READY") {
        nonexec_clone_control(std::path::Path::new(&path)).expect("native clone control setup");
    }
    let mut channel = Some(control);
    let mut replies = VecDeque::from([Response::Ready { supervisor: unsafe { libc::getpid() } as u32 }]);
    let mut config = Vec::new();
    let mut shell = None;
    let mut shell_status = None;
    let mut status_sent = false;
    let mut exec_pipe: Option<OwnedFd> = None;
    let mut exec_eof = false;
    let mut started = false;
    let mut bootstrap_finished = false;
    let mut attempted = false;
    let mut stop: Option<Stop> = None;
    let mut admission_closed = false;
    let mut empty_advised = false;
    let initial = match millis() { Ok(n) => n, Err(_) => return 123 };
    let mut bootstrap_deadline = initial + 10_000;
    loop {
        let now = match millis() {
            Ok(now) => now,
            Err(_) => {
                // A failed clock cannot turn an unbounded cleanup into success.
                // Retain the witness and stop consuming CPU if even backoff is
                // unavailable. Parent deadlines will report LOST/unconfirmed.
                if backoff().is_err() { unsafe { libc::raise(libc::SIGSTOP); } }
                continue;
            }
        };
        // Before exec resolution preserve the original child's exact proc/wait
        // identity, including a zombie. No other thread consumes child status.
        // This is conservatively live, never an extinction observation.
        let children = if shell.is_some() && !bootstrap_finished {
            Ok(Children::Live)
        } else {
            drain(|pid, status| { if shell == Some(pid) { shell_status = Some(status); } })
        };
        if (children.is_err() || matches!(children, Ok(Children::Churning))) && backoff().is_err() {
            unsafe { libc::raise(libc::SIGSTOP); }
        }

        #[cfg(test)]
        if exec_pipe.is_some() && std::env::var("TX467_SUPERVISOR_FAULT").as_deref() == Ok("kill-before-eof") {
            kill_held_before_read(shell.unwrap());
        }
        if let Some(pipe) = &exec_pipe {
            let mut record = [0i32; 2];
            let n = unsafe { libc::read(pipe.as_raw_fd(), record.as_mut_ptr().cast(), std::mem::size_of_val(&record)) };
            if n == 0 {
                exec_pipe = None;
                exec_eof = true;
                #[cfg(test)]
                if bootstrap_finished { eprintln!("supervisor late exec EOF after terminal bootstrap outcome"); }
            } else if n > 0 || (n < 0 && !matches!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)) {
                exec_pipe = None;
                admission_closed = true;
                if !bootstrap_finished {
                    bootstrap_finished = true;
                    replies.push_back(Response::Failed { stage: if n == 8 { format!("child setup {}", record[0]) } else { "invalid exec handshake".into() },
                        errno: if n == 8 { record[1] } else { libc::EIO } });
                }
            }
        }
        if exec_eof && !bootstrap_finished {
            match observe_exec_eof(shell.unwrap()) {
                Ok(ExecObservation::Exiting) => {},
                Ok(ExecObservation::Ready) if !admission_closed => {
                    bootstrap_finished = true;
                    started = true;
                    replies.push_back(Response::Started { shell: shell.unwrap() as u32 });
                }
                outcome => {
                    bootstrap_finished = true;
                    admission_closed = true;
                    replies.push_back(Response::Failed { stage: "exec interrupted or unconfirmed".into(),
                        errno: outcome.err().and_then(|error| error.raw_os_error()).unwrap_or(libc::EINTR) });
                }
            }
        }
        if started && !status_sent {
            if let Some(status) = shell_status { replies.push_back(Response::ShellExit { status }); status_sent = true; }
        }
        if !bootstrap_finished && !admission_closed && now >= bootstrap_deadline {
            bootstrap_finished = true;
            admission_closed = true;
            replies.push_back(Response::Failed { stage: "bootstrap timeout".into(), errno: libc::ETIMEDOUT });
            #[cfg(test)]
            if std::env::var("TX467_SUPERVISOR_FAULT").as_deref() == Ok("timeout-late-exec") {
                signal_child(shell.unwrap(), libc::SIGCONT).unwrap();
            }
        }
        if started && matches!(children, Ok(Children::Empty)) && !empty_advised {
            replies.push_back(Response::Empty);
            empty_advised = true; // Advisory only; a current Stop is still required.
        }

        if let Some(current) = &mut stop {
            if matches!(children, Ok(Children::Empty)) && !current.reported {
                replies.push_back(Response::Extinct { claim: current.claim });
                current.reported = true;
            } else if !current.reported && now - current.started >= 2000 {
                replies.push_back(Response::Unconfirmed { claim: current.claim });
                current.reported = true;
            }
            let signal = !matches!(children, Ok(Children::Empty));
            #[cfg(test)]
            let signal = signal && !(std::env::var("TX467_SUPERVISOR_FAULT").as_deref() == Ok("timeout-late-exec") && exec_pipe.is_some());
            if signal {
                let _ = signal_children(if now - current.started >= 400 { libc::SIGKILL } else { libc::SIGTERM });
            }
        } else if admission_closed {
            // Local bootstrap failure also closes admission, but cannot produce
            // a positive response without a parent's explicit current claim.
            stop = Some(Stop { claim: 0, started: now, reported: true });
        }

        if channel.is_none() {
            if matches!(children, Ok(Children::Empty)) { return EMPTY_AFTER_LOSS; }
            if backoff().is_err() { unsafe { libc::raise(libc::SIGSTOP); } }
        } else {
            let fd = channel.as_ref().unwrap().as_raw_fd();
            let mut lost = replies.len() > 32;
            while !lost {
                let Some(reply) = replies.front() else { break };
                match protocol::send(fd, launch, reply) {
                    Ok(true) => { replies.pop_front(); }
                    Ok(false) => break,
                    Err(_) => { lost = true; }
                }
            }
            // Limit commands per iteration so a sender cannot starve reaping.
            for _ in 0..16 {
                if lost { break; }
                let request = match protocol::receive::<Request>(fd, launch) {
                    Ok(Some(request)) => request,
                    Ok(None) => break,
                    Err(_) => { lost = true; break; }
                };
                match request {
                    Request::Config { offset, bytes } if !attempted && !admission_closed
                        && offset == config.len() && bytes.len() <= protocol::CHUNK
                        && config.len().checked_add(bytes.len()).is_some_and(|len| len <= protocol::MAX_CONFIG) => {
                        config.extend(bytes);
                    }
                    Request::Launch { length } if !attempted && !admission_closed && length == config.len() => {
                        #[cfg(test)]
                        if matches!(std::env::var("TX467_SUPERVISOR_FAULT").as_deref(),
                            Ok("sent-launch-loss" | "uncertain-launch-loss")) {
                            assert_single_thread("launch-channel-loss");
                            eprintln!("H1 Launch received; injected helper exit before child creation");
                            // A crash, as far as the runtime can tell: never
                            // the status that proves the launch empty.
                            return 126;
                        }
                        attempted = true; // No second fork, even if preparation fails.
                        let prepared = serde_json::from_slice::<Launch>(&config)
                            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid launch configuration"))
                            .and_then(Executable::prepare)
                            .and_then(|executable| executable.fork(slave.as_ref().unwrap().as_raw_fd()));
                        config.clear();
                        slave.take(); // Never retain the slave and postpone PTY EOF.
                        match prepared {
                            Ok((pid, pipe)) => {
                                shell = Some(pid); exec_pipe = Some(pipe); bootstrap_deadline = now + 10_000;
                                #[cfg(test)]
                                if std::env::var("TX467_SUPERVISOR_FAULT").as_deref() == Ok("timeout-before-exec") || std::env::var("TX467_SUPERVISOR_FAULT").as_deref() == Ok("timeout-late-exec") || std::env::var("TX467_SUPERVISOR_FAULT").as_deref() == Ok("exiting-timeout") { bootstrap_deadline = now + 150; }
                            }
                            Err(error) => {
                                bootstrap_finished = true;
                                admission_closed = true;
                                replies.push_back(Response::Failed { stage: "launch".into(), errno: error.raw_os_error().unwrap_or(libc::EINVAL) });
                            }
                        }
                    }
                    Request::Stop { claim } if claim > 0 && stop.as_ref().is_none_or(|old| claim > old.claim) => {
                        if !bootstrap_finished {
                            bootstrap_finished = true;
                            replies.push_back(Response::Failed { stage: "launch cancelled".into(), errno: libc::ECANCELED });
                        }
                        admission_closed = true;
                        slave.take();
                        config.clear();
                        stop = Some(Stop { claim, started: now, reported: false });
                    }
                    Request::Release { claim } if stop.as_ref().is_some_and(|current| current.claim == claim && claim > 0 && current.reported)
                        && admission_closed && matches!(children, Ok(Children::Empty)) => return 0,
                    _ => { lost = true; }
                }
            }
            if lost {
                channel.take(); replies.clear(); slave.take(); config.clear();
                bootstrap_finished = true; // Release temporary original-child hold on loss.
                admission_closed = true;
                if stop.is_none() { stop = Some(Stop { claim: 0, started: now, reported: true }); }
            }
        }
        let mut poll = [
            libc::pollfd { fd: channel.as_ref().map_or(-1, AsRawFd::as_raw_fd), events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: wake.as_raw_fd(), events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: exec_pipe.as_ref().map_or(-1, AsRawFd::as_raw_fd), events: libc::POLLIN, revents: 0 },
        ];
        let result = unsafe { libc::poll(poll.as_mut_ptr(), poll.len() as libc::nfds_t, 50) };
        if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted && backoff().is_err() {
            unsafe { libc::raise(libc::SIGSTOP); }
        }
        if poll[1].revents != 0 && consume_wake(wake.as_raw_fd()).is_err() && backoff().is_err() {
            unsafe { libc::raise(libc::SIGSTOP); }
        }
    }
}

#[cfg(test)]
fn assert_single_thread(phase: &str) {
    let tasks = std::fs::read_dir("/proc/self/task").unwrap().collect::<io::Result<Vec<_>>>().unwrap();
    let threads = tasks.len();
    let names: Vec<String> = tasks.iter().map(|task| std::fs::read_to_string(task.path().join("comm")).unwrap_or_default().trim().to_string()).collect();
    assert_eq!(threads, 1, "supervisor {phase} must be single threaded: {names:?}");
    eprintln!("supervisor thread evidence phase={phase} pid={} threads={threads}", unsafe { libc::getpid() });
}

#[cfg(test)]
fn kill_held_before_read(pid: libc::pid_t) {
    // Exact native barrier: first observe the pre-exec SIGSTOP without consuming
    // it, then kill and observe exit without reaping. No scheduling sleep stands
    // in for the required stopped-before-exec state.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        assert_eq!(unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WSTOPPED | libc::WNOHANG | libc::WNOWAIT | WALL) }, 0);
        if unsafe { info.si_pid() } == pid { break; }
        assert!(std::time::Instant::now() < deadline, "child did not reach pre-exec barrier");
        backoff().unwrap();
    }
    signal_child(pid, libc::SIGKILL).unwrap();
    loop {
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        assert_eq!(unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT | WALL) }, 0);
        if unsafe { info.si_pid() } == pid { break; }
        assert!(std::time::Instant::now() < deadline, "killed child did not exit");
        backoff().unwrap();
    }
    eprintln!("supervisor pre-exec barrier killed retained child pid={pid} before pipe read");
}

#[cfg(test)]
fn inject_proc_observation(pid: libc::pid_t, bytes: &mut Vec<u8>) -> io::Result<()> {
    match std::env::var("TX467_SUPERVISOR_FAULT").as_deref() {
        Ok("proc-unavailable") => return Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected proc access denial")),
        Ok("proc-malformed") => *bytes = b"malformed".to_vec(),
        Ok("proc-truncated") => bytes.resize(4097, b'0'),
        Ok("proc-wrong-pid") => {
            let open = bytes.iter().position(|byte| *byte == b'(').unwrap();
            let mut wrong = format!("{} ", pid + 1).into_bytes(); wrong.extend_from_slice(&bytes[open..]); *bytes = wrong;
        }
        _ => {},
    }
    Ok(())
}

#[cfg(test)]
fn injected_exit_hold() -> bool {
    let mode = std::env::var("TX467_SUPERVISOR_FAULT").unwrap_or_default();
    if !matches!(mode.as_str(), "exiting-once" | "exiting-timeout" | "exiting-stop") { return false; }
    static OBSERVATIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let count = OBSERVATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let held = mode != "exiting-once" || count == 0;
    if held {
        // Branch injection only: no claim of controlling the kernel's do_exit
        // window. Actual child exec/cleanup still uses the normal syscall path.
        if let Ok(path) = std::env::var("TX467_EXIT_OBSERVED") { std::fs::write(path, b"injected PF_EXITING/no-event").unwrap(); }
        eprintln!("supervisor injected PF_EXITING/no-event observation={count}");
    }
    held
}

// No production fixture operation: this native control exists only in the
// private fresh-executable test dispatcher. Exec would reset exit_signal, so
// keep this actual SIGUSR1 clone unexecuted under the exact Rust supervisor.
#[cfg(test)]
fn nonexec_clone_control(marker: &std::path::Path) -> io::Result<()> {
    assert_single_thread("nonexec-clone");
    extern "C" fn child(arg: *mut libc::c_void) -> libc::c_int {
        unsafe {
            let fd = *(arg.cast::<libc::c_int>());
            if libc::dup2(fd, 1) < 0 { libc::_exit(81); }
            if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0) < 0 { libc::_exit(82); }
            let mut mask = std::mem::zeroed::<libc::sigset_t>();
            if libc::sigemptyset(&mut mask) < 0 || libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut()) < 0 { libc::_exit(83); }
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
            let ids = [libc::getpid(), libc::getppid()];
            if libc::write(1, ids.as_ptr().cast(), std::mem::size_of_val(&ids)) != std::mem::size_of_val(&ids) as isize { libc::_exit(84); }
            libc::close(1);
            loop { libc::pause(); }
        }
    }
    let mut pipe = [-1; 2];
    if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) } < 0 { return Err(io::Error::last_os_error()); }
    let read = unsafe { OwnedFd::from_raw_fd(pipe[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(pipe[1]) };
    let mut stack = vec![0u128; 65536];
    let mut ready_fd = write.as_raw_fd();
    let pid = unsafe { libc::clone(child, stack.as_mut_ptr().add(stack.len()).cast(), libc::SIGUSR1, (&mut ready_fd as *mut libc::c_int).cast()) };
    if pid < 0 { return Err(io::Error::last_os_error()); }
    drop(write);
    let mut poll = libc::pollfd { fd: read.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    if unsafe { libc::poll(&mut poll, 1, 2000) } != 1 { return Err(io::Error::other("clone readiness timeout")); }
    let mut ids = [0i32; 2];
    if unsafe { libc::read(read.as_raw_fd(), ids.as_mut_ptr().cast(), std::mem::size_of_val(&ids)) } != std::mem::size_of_val(&ids) as isize
        || ids != [pid, unsafe { libc::getpid() }] { return Err(io::Error::other("wrong clone readiness identity")); }
    // This diagnostic uses the same exclusive helper thread. A live clone
    // cannot be reaped here; the production drain remains the actual selector.
    let mut status = 0;
    let old = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
    let errno = io::Error::last_os_error().raw_os_error();
    assert_eq!((old, errno), (-1, Some(libc::ECHILD)), "default selector must miss this native live clone");
    eprintln!("ANCESTRY nonexec clone pid={pid} ppid={} default_wait=ECHILD", ids[1]);
    std::fs::write(marker, format!("{} {}", ids[0], ids[1]))?;
    Ok(())
}
