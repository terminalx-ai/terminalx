use super::super::{ExecutionOutcome, ExecutionSlot, Rejection, Request, RequestInput, State};
#[cfg(test)]
use super::GroupEvent;
use std::ffi::{c_char, c_int, c_short, c_uint, c_ulong, c_void, CString};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, PipeReader, Read};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;
use std::ptr;
use std::sync::mpsc::SyncSender;
use std::thread;
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(5);
const CLEANUP_GRACE: Duration = Duration::from_millis(100);
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

pub(in super::super) struct ApprovedPaths {
    cwd: File,
    // Holding the file keeps its inode from being recycled between approval and spawn.
    _executable: File,
    executable_version: Metadata,
}

impl ApprovedPaths {
    pub(in super::super) fn open(input: &RequestInput) -> Result<Self, Rejection> {
        let cwd = open(&input.cwd, O_DIRECTORY).map_err(|_| Rejection::InvalidDirectory)?;
        let (executable, metadata) = protected_system_executable(&input.executable)?;
        Ok(Self {
            cwd,
            _executable: executable,
            executable_version: metadata,
        })
    }

    fn verify_directory(&self, input: &RequestInput) -> Result<(), Rejection> {
        let current = open(&input.cwd, O_DIRECTORY).map_err(|_| Rejection::InvalidDirectory)?;
        if !same_file(&self.cwd, &current) {
            return Err(Rejection::InvalidDirectory);
        }
        Ok(())
    }

    fn verify_executable(&self, input: &RequestInput) -> Result<(), Rejection> {
        // Both paths stay on the protected system mount. The sandbox wrapper
        // installs a no-fork policy, then replaces itself with the approved
        // program in the new session. There is no unsandboxed launch path.
        protected_system_executable(SANDBOX_EXEC)?;
        let (_, current) = protected_system_executable(&input.executable)?;
        if file_version(&self.executable_version) != file_version(&current) {
            return Err(Rejection::ExecutableUnavailable);
        }
        Ok(())
    }
}

fn protected_system_executable(path: &str) -> Result<(File, Metadata), Rejection> {
    let unavailable = Rejection::ExecutableUnavailable;
    let (parent, name) = path.rsplit_once('/').ok_or(unavailable)?;
    if !matches!(parent, "/bin" | "/sbin" | "/usr/bin" | "/usr/sbin")
        || name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
    {
        return Err(unavailable);
    }
    let directory = open(parent, O_DIRECTORY).map_err(|_| unavailable)?;
    let directory_info = directory.metadata().map_err(|_| unavailable)?;
    let executable = open(path, O_NONBLOCK).map_err(|_| unavailable)?;
    let metadata = executable.metadata().map_err(|_| unavailable)?;
    // Darwin spawns by pathname. Restrict this slice to direct system binaries
    // on a read-only mount, where an unprivileged writer cannot replace the path
    // between the identity comparison and spawn.
    if !metadata.is_file()
        || metadata.mode() & 0o111 == 0
        || metadata.mode() & 0o022 != 0
        || metadata.uid() != 0
        || directory_info.uid() != 0
        || metadata.dev() != directory_info.dev()
        || !read_only_mount(&directory)
        || !read_only_mount(&executable)
    {
        return Err(unavailable);
    }
    Ok((executable, metadata))
}

/// Darwin sys/statvfs.h, whose block and inode counts are unsigned int.
#[repr(C)]
struct StatVfs {
    block_sizes: [c_ulong; 2],
    counts: [c_uint; 6],
    fs_id: c_ulong,
    flags: c_ulong,
    name_max: c_ulong,
}

fn read_only_mount(file: &File) -> bool {
    const ST_RDONLY: c_ulong = 1;
    let mut status = MaybeUninit::<StatVfs>::uninit();
    // fstatvfs initializes the provided Darwin struct on success.
    unsafe {
        fstatvfs(file.as_raw_fd(), status.as_mut_ptr()) == 0
            && status.assume_init().flags & ST_RDONLY != 0
    }
}

fn file_version(metadata: &Metadata) -> (u64, u64, u64, u32, i64, i64, i64, i64) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mode(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}

fn open(path: &str, flags: c_int) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(flags | O_NOFOLLOW_ANY)
        .open(path)
}

fn same_file(approved: &File, current: &File) -> bool {
    match (approved.metadata(), current.metadata()) {
        (Ok(approved), Ok(current)) => {
            (approved.dev(), approved.ino()) == (current.dev(), current.ino())
        }
        _ => false,
    }
}

pub(in super::super) fn run(
    request: &Request,
    paths: ApprovedPaths,
    sender: SyncSender<ExecutionOutcome>,
    slot: ExecutionSlot<'_>,
) {
    let (outcome, pending_cleanup) = match launch(request, paths) {
        Ok((mut process, started_at)) => {
            let output = process.collect(request, started_at);
            let state = request.finish(match &output {
                Ok(_) => State::Completed,
                Err(state) => *state,
            });
            let outcome = match output {
                Ok((status, stdout, stderr)) if state == State::Completed => {
                    ExecutionOutcome::Exited {
                        code: status.code(),
                        signal: status.signal(),
                        stdout,
                        stderr,
                    }
                }
                _ => ExecutionOutcome::Stopped(state),
            };
            process.close_pipes();
            (outcome, Some(process))
        }
        Err(state) => (ExecutionOutcome::Stopped(request.finish(state)), None),
    };

    // Usually the group drains before result delivery. If the OS delays cleanup, deliver the
    // terminal result on time while this worker retains the group and the only execution slot.
    let mut process = pending_cleanup;
    if let Some(child) = &mut process {
        let started = Instant::now();
        while child.pid.is_some() && started.elapsed() < CLEANUP_GRACE {
            if child.cleanup_step().is_none() && child.pid.is_some() {
                thread::sleep(POLL_INTERVAL);
            }
        }
        if child.pid.is_some() {
            let _ = sender.send(outcome);
            drop(process);
            drop(slot);
            return;
        }
    }
    drop(slot);
    let _ = sender.send(outcome);
}

fn launch(request: &Request, paths: ApprovedPaths) -> Result<(Process, Instant), State> {
    // Prepare OS inputs outside the authority lock. The final state/clock check occurs after
    // preparation and directly before posix_spawn, while holding the same lock as revocation.
    let launch = Launch::prepare(request.input(), &paths).map_err(|_| State::SpawnFailed)?;
    paths
        .verify_directory(request.input())
        .map_err(|_| State::SpawnFailed)?;

    #[cfg(test)]
    if let Some(before_spawn) = &request.policy.test_before_spawn {
        before_spawn();
    }

    let mut registry = request.policy.lock().map_err(|_| State::Revoked)?;
    let entry = request
        .checked(&mut registry, State::Starting)
        .map_err(|_| State::Revoked)?;
    paths
        .verify_executable(request.input())
        .map_err(|_| State::SpawnFailed)?;
    let started_at = Instant::now();
    let process = launch
        .spawn(
            #[cfg(test)]
            request.policy.test_group_events.clone(),
        )
        .map_err(|_| State::SpawnFailed)?;
    entry.state = State::Running;
    Ok((process, started_at))
}

struct Launch {
    actions: FileActions,
    attributes: Attributes,
    argv: Vec<*const c_char>,
    _arguments: Vec<CString>,
    stdout: PipeReader,
    stderr: PipeReader,
    // Keep file-action source FDs open through posix_spawn.
    _writers: [io::PipeWriter; 2],
}

impl Launch {
    fn prepare(input: &RequestInput, paths: &ApprovedPaths) -> io::Result<Self> {
        // The executable spelling was validated when approval was prepared.
        // Limit runtime exec to the approved image as well as forbidding fork.
        let profile = format!(
            "(version 1) (allow default) (deny process-fork) (deny process-exec) (allow process-exec (literal \"{}\"))",
            input.executable,
        );
        let arguments = [SANDBOX_EXEC, "-p", &profile, input.executable.as_str()]
            .into_iter()
            .chain(input.arguments.iter().map(String::as_str))
            .map(|arg| CString::new(arg.as_bytes()))
            .collect::<Result<Vec<_>, _>>()?;
        let argv = arguments
            .iter()
            .map(|arg| arg.as_ptr())
            .chain([ptr::null()])
            .collect();
        let (stdout, stdout_writer) = io::pipe()?;
        let (stderr, stderr_writer) = io::pipe()?;
        nonblocking(stdout.as_raw_fd())?;
        nonblocking(stderr.as_raw_fd())?;
        let actions = FileActions::new()?;
        let attributes = Attributes::new()?;
        let cwd_fd = paths.cwd.as_raw_fd();
        let stdout_fd = stdout_writer.as_raw_fd();
        let stderr_fd = stderr_writer.as_raw_fd();
        if [cwd_fd, stdout_fd, stderr_fd].iter().any(|fd| *fd <= 2) {
            return Err(io::Error::other("standard descriptors unavailable"));
        }
        // SAFETY: actions is initialized and each source FD outlives posix_spawn. The default
        // close-on-exec disposition leaves only the three explicitly mapped stream descriptors.
        unsafe {
            check(posix_spawn_file_actions_addfchdir_np(&actions.0, cwd_fd))?;
            check(posix_spawn_file_actions_addopen(
                &actions.0,
                0,
                c"/dev/null".as_ptr(),
                0,
                0,
            ))?;
            check(posix_spawn_file_actions_adddup2(&actions.0, stdout_fd, 1))?;
            check(posix_spawn_file_actions_adddup2(&actions.0, stderr_fd, 2))?;
        }
        Ok(Self {
            actions,
            attributes,
            argv,
            _arguments: arguments,
            stdout,
            stderr,
            _writers: [stdout_writer, stderr_writer],
        })
    }

    fn spawn(
        self,
        #[cfg(test)] group_events: Option<std::sync::Arc<std::sync::Mutex<Vec<GroupEvent>>>>,
    ) -> io::Result<Process> {
        let envp = [ptr::null()];
        let mut pid = 0;
        // SAFETY: strings and null-terminated pointer vectors live through the call. The
        // initialized spawn objects and source FDs remain live until posix_spawn returns.
        unsafe {
            check(posix_spawn(
                &mut pid,
                self.argv[0],
                &self.actions.0,
                &self.attributes.0,
                self.argv.as_ptr(),
                envp.as_ptr(),
            ))?;
        }
        Ok(Process {
            pid: Some(pid),
            stdout: Some(self.stdout),
            stderr: Some(self.stderr),
            #[cfg(test)]
            group_events,
        })
    }
}

struct Process {
    pid: Option<c_int>,
    stdout: Option<PipeReader>,
    stderr: Option<PipeReader>,
    #[cfg(test)]
    group_events: Option<std::sync::Arc<std::sync::Mutex<Vec<GroupEvent>>>>,
}

type Captured = (ExitStatus, Vec<u8>, Vec<u8>);

impl Process {
    fn collect(&mut self, request: &Request, started: Instant) -> Result<Captured, State> {
        let limit = request.input().output_limit_bytes as usize;
        let timeout = Duration::from_millis(request.input().timeout_ms);
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let mut status = None;
        loop {
            let state = request.state().map_err(|_| State::Revoked)?;
            if state != State::Running {
                return Err(state);
            }
            if started.elapsed() >= timeout {
                return Err(State::TimedOut);
            }
            if let Some(pid) = self.pid {
                if exited_unreaped(pid).map_err(|_| State::Failed)? {
                    status = self.cleanup_step();
                    if self.pid.is_none() && status.is_none() {
                        return Err(State::Failed);
                    }
                }
            }
            let first = drain(&mut self.stdout, &mut stdout, limit - stderr.len())?;
            let second = drain(&mut self.stderr, &mut stderr, limit - stdout.len())?;
            if !first && !second {
                if let Some(status) = status {
                    return Ok((status, stdout, stderr));
                }
                thread::sleep(POLL_INTERVAL);
            }
        }
    }

    fn close_pipes(&mut self) {
        self.stdout = None;
        self.stderr = None;
    }

    fn cleanup_step(&mut self) -> Option<ExitStatus> {
        let pid = self.pid?;
        match exited_unreaped(pid) {
            Ok(true) if matches!(has_other_members(pid), Ok(false)) => {
                let mut status = 0;
                // SAFETY: the leader is our child. waitpid is the last operation on its PID.
                let result = unsafe { waitpid(pid, &mut status, WNOHANG) };
                if result == pid {
                    self.pid = None;
                    #[cfg(test)]
                    self.record(GroupEvent::Reaped(pid));
                    return Some(ExitStatus::from_raw(status));
                }
                if result < 0 && io::Error::last_os_error().raw_os_error() == Some(ECHILD) {
                    self.pid = None;
                }
            }
            Ok(_) => {
                // SAFETY: waitid verified that the unreaped child still anchors the group ID.
                // This worker exclusively owns waiting/reaping the child. Never signal a
                // numeric group after waitpid or after an ownership failure.
                #[cfg(test)]
                self.record(GroupEvent::Signal(pid));
                unsafe { kill(-pid, SIGKILL) };
            }
            Err(error) if error.raw_os_error() == Some(ECHILD) => self.pid = None,
            Err(_) => {}
        }
        None
    }

    #[cfg(test)]
    fn record(&self, event: GroupEvent) {
        if let Some(events) = &self.group_events {
            events.lock().unwrap().push(event);
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.close_pipes();
        while self.pid.is_some() {
            self.cleanup_step();
            if self.pid.is_some() {
                thread::sleep(POLL_INTERVAL);
            }
        }
    }
}

// Read a small chunk per stream per loop so a busy writer cannot starve the other stream
// or prevent a deadline/revocation check. Read one byte over budget to distinguish exact fit.
fn drain(
    reader: &mut Option<PipeReader>,
    output: &mut Vec<u8>,
    limit: usize,
) -> Result<bool, State> {
    let Some(pipe) = reader else { return Ok(false) };
    let mut buffer = [0u8; 8192];
    let remaining = limit - output.len();
    let read_len = buffer.len().min(remaining + 1);
    match pipe.read(&mut buffer[..read_len]) {
        Ok(0) => {
            *reader = None;
            Ok(false)
        }
        Ok(n) if n > remaining => Err(State::OutputLimitExceeded),
        Ok(n) => {
            output.extend_from_slice(&buffer[..n]);
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(true),
        Err(_) => Err(State::Failed),
    }
}

fn exited_unreaped(pid: c_int) -> io::Result<bool> {
    loop {
        // SAFETY: zero is valid storage for the Darwin siginfo_t layout. WNOWAIT preserves the
        // PID until cleanup has stopped the group. Only waitpid below releases that ownership.
        let mut info: SigInfo = unsafe { std::mem::zeroed() };
        if unsafe { waitid(P_PID, pid as c_uint, &mut info, WEXITED | WNOHANG | WNOWAIT) } == 0 {
            return Ok(info.pid != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn has_other_members(pid: c_int) -> io::Result<bool> {
    // At most one entry can be the reserved leader. Any second entry establishes membership.
    let mut members = [0i32; 2];
    // SAFETY: the output buffer is writable for exactly the passed byte count.
    let bytes = unsafe {
        proc_listpids(
            PROC_PGRP_ONLY,
            pid as c_uint,
            members.as_mut_ptr().cast(),
            std::mem::size_of_val(&members) as c_int,
        )
    };
    if bytes <= 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(members.iter().any(|member| *member > 0 && *member != pid))
}

fn nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: fd is an open read end owned by the caller, and only its status flags change.
    unsafe {
        let flags = fcntl(fd, F_GETFL);
        if flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

struct FileActions(*mut c_void);

impl FileActions {
    fn new() -> io::Result<Self> {
        let mut raw = ptr::null_mut();
        // SAFETY: this is writable storage for an opaque Darwin spawn handle.
        check(unsafe { posix_spawn_file_actions_init(&mut raw) })?;
        Ok(Self(raw))
    }
}

impl Drop for FileActions {
    fn drop(&mut self) {
        // SAFETY: this handle was initialized once and is destroyed once.
        unsafe { posix_spawn_file_actions_destroy(&mut self.0) };
    }
}

struct Attributes(*mut c_void);

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut raw = ptr::null_mut();
        // SAFETY: this is writable storage for an opaque Darwin spawn handle.
        check(unsafe { posix_spawnattr_init(&mut raw) })?;
        let attributes = Self(raw);
        // SAFETY: the initialized handle is exclusively owned here. SETSID makes the child
        // leader of a new session and group. The empty mask drops inherited signal blocks.
        unsafe {
            check(posix_spawnattr_setsigmask(&attributes.0, &0))?;
            check(posix_spawnattr_setflags(
                &attributes.0,
                SETSID | SETSIGMASK | CLOEXEC_DEFAULT,
            ))?;
        }
        Ok(attributes)
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: this handle was initialized once and is destroyed once.
        unsafe { posix_spawnattr_destroy(&mut self.0) };
    }
}

fn check(errno: c_int) -> io::Result<()> {
    if errno == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(errno))
    }
}

// Darwin ABI from sys/{fcntl,signal,spawn,wait,proc_info,errno}.h, spawn.h and libproc.h.
// Kept local so the dormant module can be verified with standalone rustc.
const O_NONBLOCK: c_int = 0x0000_0004;
const O_DIRECTORY: c_int = 0x0010_0000;
const O_NOFOLLOW_ANY: c_int = 0x2000_0000;
const F_GETFL: c_int = 3;
const F_SETFL: c_int = 4;
const P_PID: c_int = 1;
const WNOHANG: c_int = 0x01;
const WEXITED: c_int = 0x04;
const WNOWAIT: c_int = 0x20;
const SIGKILL: c_int = 9;
const ECHILD: c_int = 10;
const PROC_PGRP_ONLY: c_uint = 2;
const SETSIGMASK: c_short = 0x0008;
const SETSID: c_short = 0x0400;
const CLOEXEC_DEFAULT: c_short = 0x4000;

#[repr(C)]
struct SigInfo {
    signo: c_int,
    errno: c_int,
    code: c_int,
    pid: c_int,
    uid: c_uint,
    status: c_int,
    addr: *mut c_void,
    value: usize,
    band: std::ffi::c_long,
    reserved: [std::ffi::c_ulong; 7],
}

unsafe extern "C" {
    fn fstatvfs(fd: c_int, status: *mut StatVfs) -> c_int;
    fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
    fn kill(pid: c_int, signal: c_int) -> c_int;
    fn waitid(kind: c_int, id: c_uint, info: *mut SigInfo, options: c_int) -> c_int;
    fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
    fn proc_listpids(kind: c_uint, info: c_uint, buffer: *mut c_void, size: c_int) -> c_int;
    fn posix_spawn(
        pid: *mut c_int,
        path: *const c_char,
        actions: *const *mut c_void,
        attributes: *const *mut c_void,
        argv: *const *const c_char,
        envp: *const *const c_char,
    ) -> c_int;
    fn posix_spawn_file_actions_init(actions: *mut *mut c_void) -> c_int;
    fn posix_spawn_file_actions_destroy(actions: *mut *mut c_void) -> c_int;
    fn posix_spawn_file_actions_addfchdir_np(actions: *const *mut c_void, fd: c_int) -> c_int;
    fn posix_spawn_file_actions_addopen(
        actions: *const *mut c_void,
        fd: c_int,
        path: *const c_char,
        flags: c_int,
        mode: u16,
    ) -> c_int;
    fn posix_spawn_file_actions_adddup2(
        actions: *const *mut c_void,
        from: c_int,
        to: c_int,
    ) -> c_int;
    fn posix_spawnattr_init(attributes: *mut *mut c_void) -> c_int;
    fn posix_spawnattr_destroy(attributes: *mut *mut c_void) -> c_int;
    fn posix_spawnattr_setsigmask(attributes: *const *mut c_void, mask: *const c_uint) -> c_int;
    fn posix_spawnattr_setflags(attributes: *const *mut c_void, flags: c_short) -> c_int;
}
