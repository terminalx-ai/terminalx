//! A retained per-launch Linux supervisor, independent of the original shell.
//! No control I/O occurs while the ownership state mutex is held.
#[path = "supervisor/protocol.rs"]
mod protocol;
#[path = "supervisor/linux.rs"]
mod linux;

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use uuid::Uuid;
use protocol::{Request, Response};
pub(super) use protocol::Launch;
use std::ffi::{CStr, CString, OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

// A root libtest executable has no private helper dispatch. Test controllers
// must name the fresh dispatcher they built from this exact source snapshot.
// Configuration is frozen on first use; parallel cases cannot switch it.
#[cfg(test)]
static TEST_HELPER: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();

#[cfg(test)]
fn checked_test_helper(path: PathBuf) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    if !path.is_absolute() { return Err("test PTY supervisor executable must be an explicit absolute path".into()); }
    let path = path.canonicalize().map_err(|error| format!("test PTY supervisor executable: {error}"))?;
    let metadata = path.metadata().map_err(|error| format!("test PTY supervisor executable: {error}"))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err("test PTY supervisor path is not an executable file".into());
    }
    Ok(path)
}

#[cfg(test)]
pub(super) fn select_test_helper(path: PathBuf) -> io::Result<()> {
    let selected = checked_test_helper(path).map_err(io::Error::other)?;
    match TEST_HELPER.set(Ok(selected.clone())) {
        Ok(()) => Ok(()),
        Err(_) if TEST_HELPER.get() == Some(&Ok(selected)) => Ok(()),
        Err(_) => Err(io::Error::other("test PTY supervisor executable was already fixed for this process")),
    }
}

fn helper_executable() -> io::Result<PathBuf> {
    #[cfg(not(test))]
    { std::env::current_exe() }
    #[cfg(test)]
    {
        TEST_HELPER.get_or_init(|| {
            let path = std::env::var_os("TERMINALX_TEST_PTY_SUPERVISOR")
                .ok_or_else(|| "test PTY supervisor executable is required; libtest is not a helper dispatcher".to_string())?;
            checked_test_helper(PathBuf::from(path))
        }).clone().map_err(io::Error::other)
    }
}

/// portable-pty's public environment iterator converts to UTF-8 and drops raw
/// Unix names/values. Keep a single complete OsString snapshot instead. The
/// caller uses the same arg/env/remove/cwd operations as its portable builder.
pub(super) struct CommandBuilder(Command);
impl std::ops::Deref for CommandBuilder {
    type Target = Command;
    fn deref(&self) -> &Command { &self.0 }
}
impl std::ops::DerefMut for CommandBuilder {
    fn deref_mut(&mut self) -> &mut Command { &mut self.0 }
}
impl CommandBuilder {
    pub(super) fn new(program: impl AsRef<OsStr>) -> Self {
        let mut command = Command::new(program);
        let mut env: std::collections::BTreeMap<OsString, OsString> = std::env::vars_os().collect();
        if !env.contains_key(OsStr::new("SHELL")) {
            let shell = passwd().ok().map(|(_, shell)| shell).filter(|shell| executable(Path::new(shell)))
                .unwrap_or_else(|| OsString::from("/bin/sh"));
            env.insert(OsString::from("SHELL"), shell);
        }
        command.env_clear().envs(env);
        Self(command)
    }

    pub(super) fn cwd(&mut self, cwd: impl AsRef<OsStr>) { self.0.current_dir(cwd.as_ref()); }

    pub(super) fn launch(&self) -> io::Result<(Launch, PathBuf)> {
        let env: std::collections::BTreeMap<_, _> = self.0.get_envs().filter_map(|(key, value)| value.map(|value| (key, value))).collect();
        // Match portable-pty 0.9's invalid-directory fallback. Resolve that
        // actual directory before checkout admission, never merely the input.
        let home = match env.get(OsStr::new("HOME")).and_then(|home| home.to_str()) {
            Some(home) => PathBuf::from(home),
            None => PathBuf::from(passwd()?.0),
        };
        let cwd = self.0.get_current_dir().filter(|cwd| cwd.is_dir()).unwrap_or(&home);
        let cwd = if cwd.is_absolute() { cwd.to_path_buf() } else { std::env::current_dir()?.join(cwd) };
        // Registration uses this exact identity and fails rather than treating
        // a path it cannot resolve as an unrelated/idle checkout.
        let identity = cwd.canonicalize()?;
        let program = Path::new(self.0.get_program());
        let path = if program.is_absolute() { program.to_path_buf() }
            else if matches!(program.components().next(), Some(std::path::Component::CurDir | std::path::Component::ParentDir)) {
                cwd.join(program)
            } else {
                env.get(OsStr::new("PATH")).into_iter().flat_map(std::env::split_paths)
                    .map(|directory| cwd.join(directory).join(program)).find(|path| executable(path))
                    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "PTY executable not found in PATH"))?
            };
        if !executable(&path) { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "PTY executable is not an executable file")); }
        let argv = std::iter::once(self.0.get_program()).chain(self.0.get_args()).map(|arg| arg.as_bytes().to_vec()).collect();
        Ok((Launch { executable: path.as_os_str().as_bytes().to_vec(), argv,
            env: env.into_iter().map(|(key, value)| (key.as_bytes().to_vec(), value.as_bytes().to_vec())).collect(),
            cwd: cwd.as_os_str().as_bytes().to_vec() }, identity))
    }
}

fn executable(path: &Path) -> bool {
    let Ok(path_c) = CString::new(path.as_os_str().as_bytes()) else { return false };
    !path.is_dir() && unsafe { libc::access(path_c.as_ptr(), libc::X_OK) } == 0
}

fn passwd() -> io::Result<(OsString, OsString)> {
    let mut bytes = vec![0u8; 1024];
    loop {
        let mut entry = unsafe { std::mem::zeroed::<libc::passwd>() };
        let mut found = std::ptr::null_mut();
        let result = unsafe { libc::getpwuid_r(libc::getuid(), &mut entry, bytes.as_mut_ptr().cast(), bytes.len(), &mut found) };
        if result == libc::ERANGE && bytes.len() < 1024 * 1024 { bytes.resize(bytes.len() * 2, 0); continue; }
        if result != 0 { return Err(io::Error::from_raw_os_error(result)); }
        if found.is_null() { return Ok(("/".into(), "/bin/sh".into())); }
        if entry.pw_dir.is_null() || entry.pw_shell.is_null() { return Err(io::Error::other("incomplete passwd entry")); }
        return Ok(unsafe { (OsString::from_vec(CStr::from_ptr(entry.pw_dir).to_bytes().to_vec()),
            OsString::from_vec(CStr::from_ptr(entry.pw_shell).to_bytes().to_vec())) });
    }
}

pub(crate) fn dispatch() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(protocol::HELPER)) { return None; }
    let launch = args.next().and_then(|arg| arg.to_str().and_then(|s| Uuid::parse_str(s).ok()));
    Some(match (launch, args.next()) { (Some(launch), None) => linux::run(launch), _ => 119 })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase { Reserved, Bootstrapping, Running, Stopping, Unconfirmed, Proven, Lost, Extinct }

#[derive(Clone, Copy, PartialEq, Eq)]
enum LaunchDelivery { NoLaunch, MayHaveBeenSent, Sent }

struct State {
    phase: Phase,
    supervisor: Option<u32>,
    shell: Option<u32>,
    shell_status: Option<i32>,
    boot: Option<Result<u32, String>>,
    stop_claim: u64,
}

pub(super) struct Owner {
    launch: Uuid,
    state: Mutex<State>,
    changed: Condvar,
    cancelled: AtomicBool,
    #[cfg(test)]
    observer_reaped: AtomicBool,
}

impl Owner {
    /// Publish this exact handle in the pane/launch reservation before releasing
    /// admission. Even a not-yet-spawned worker is pending owned work.
    pub(super) fn reserve() -> Arc<Self> {
        Arc::new(Self { launch: Uuid::new_v4(), state: Mutex::new(State {
            phase: Phase::Reserved, supervisor: None, shell: None,
            shell_status: None, boot: None, stop_claim: 0,
        }), changed: Condvar::new(), cancelled: AtomicBool::new(false),
            #[cfg(test)] observer_reaped: AtomicBool::new(false), })
    }

    #[cfg(test)]
    pub(super) fn observer_reaped(&self) -> bool { self.observer_reaped.load(Ordering::SeqCst) }

    #[cfg(test)]
    pub(super) fn test_unconfirmed(&self) -> bool { self.state.lock().unwrap().phase == Phase::Unconfirmed }

    pub(super) fn reserved(&self) -> bool {
        self.state.lock().unwrap().phase == Phase::Reserved && !self.cancelled.load(Ordering::SeqCst)
    }
    pub(super) fn pending(&self) -> bool { self.state.lock().unwrap().phase != Phase::Extinct }

    pub(super) fn pid(&self) -> Option<u32> {
        let state = self.state.lock().unwrap();
        if state.phase == Phase::Extinct { None } else { state.shell.or(state.supervisor) }
    }

    pub(super) fn stop(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let mut state = self.state.lock().unwrap();
        if state.phase == Phase::Reserved {
            // Closing this gate under the same lock used by bootstrap proves
            // no worker can ever begin this launch. No OS child exists yet.
            state.phase = Phase::Extinct;
            state.boot = Some(Err("launch cancelled before bootstrap".into()));
            self.changed.notify_all();
            return;
        }
        if matches!(state.phase, Phase::Extinct | Phase::Lost | Phase::Stopping | Phase::Proven) { return; }
        // Exhaustion is an explicit loss, never claim reuse.
        let Some(claim) = state.stop_claim.checked_add(1) else { state.phase = Phase::Lost; return };
        state.stop_claim = claim;
        state.phase = Phase::Stopping;
        self.changed.notify_all();
    }

    pub(super) fn attach_allowed(&self) -> bool {
        let state = self.state.lock().unwrap();
        !self.cancelled.load(Ordering::SeqCst) && state.phase != Phase::Lost
            && state.boot.as_ref().is_some_and(Result::is_ok)
    }

    /// Only a worker which has not attempted OS launch can settle this way.
    fn no_child(&self, error: String) {
        let mut state = self.state.lock().unwrap();
        debug_assert!(state.supervisor.is_none());
        state.phase = Phase::Extinct;
        state.boot = Some(Err(error));
        self.changed.notify_all();
    }

    fn lost(&self, reason: &str) {
        let mut state = self.state.lock().unwrap();
        if state.phase == Phase::Extinct { return; }
        state.phase = Phase::Lost;
        if state.boot.is_none() { state.boot = Some(Err(reason.into())); }
        self.changed.notify_all();
    }

    pub(super) fn wait_shell(&self) -> Option<i32> {
        let mut state = self.state.lock().unwrap();
        while state.shell_status.is_none() && !matches!(state.phase, Phase::Lost | Phase::Extinct) {
            state = self.changed.wait(state).unwrap();
        }
        state.shell_status
    }

    /// Caller must hold no admission, runtime, authority or pane registry lock.
    /// The handle must already be retained before calling. Errors after helper
    /// creation leave ownership here; dropping a Result does not discard it.
    pub(super) fn bootstrap(self: &Arc<Self>, master: RawFd, launch: protocol::Launch) -> io::Result<u32> {
        {
            let mut state = self.state.lock().unwrap();
            if state.phase != Phase::Reserved {
                if state.supervisor.is_none() && state.phase == Phase::Stopping {
                    state.phase = Phase::Extinct;
                    state.boot = Some(Err("launch cancelled before bootstrap".into()));
                    self.changed.notify_all();
                }
                return Err(io::Error::other("launch is not reserved"));
            }
            state.phase = Phase::Bootstrapping;
        }
        let prepared = (|| {
            let config = serde_json::to_vec(&launch)?;
            if config.len() > protocol::MAX_CONFIG { return Err(io::Error::other("launch configuration exceeds bound")); }
            // Obtain the slave from this exact master, never a reusable pathname.
            let slave = unsafe { libc::ioctl(master, libc::TIOCGPTPEER, libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC) };
            if slave < 0 { return Err(io::Error::last_os_error()); }
            let slave = unsafe { OwnedFd::from_raw_fd(slave) };
            let mut sockets = [-1; 2];
            if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK, 0, sockets.as_mut_ptr()) } < 0 {
                return Err(io::Error::last_os_error());
            }
            let socket = unsafe { OwnedFd::from_raw_fd(sockets[0]) };
            let child_socket = unsafe { OwnedFd::from_raw_fd(sockets[1]) };
            // Duplicate above fixed slots before pre_exec, preventing aliasing
            // when the runtime happened to allocate one of descriptors 3/4.
            let duplicate = |fd| {
                let new = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
                if new < 0 { Err(io::Error::last_os_error()) } else { Ok(unsafe { OwnedFd::from_raw_fd(new) }) }
            };
            let pass_socket = duplicate(child_socket.as_raw_fd())?;
            let pass_slave = duplicate(slave.as_raw_fd())?;
            let mut command = Command::new(helper_executable()?);
            command.arg(protocol::HELPER).arg(self.launch.to_string())
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(test)]
            command.stderr(Stdio::inherit());
            let socket_fd = pass_socket.as_raw_fd();
            let slave_fd = pass_slave.as_raw_fd();
            unsafe {
                command.pre_exec(move || {
                    if libc::dup2(socket_fd, 3) < 0 || libc::dup2(slave_fd, 4) < 0 { return Err(io::Error::last_os_error()); }
                    Ok(())
                });
            }
            Ok((command, socket, config, pass_socket, pass_slave))
        })();
        let (mut command, socket, config, pass_socket, pass_slave) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => { self.no_child(error.to_string()); return Err(error); }
        };
        let owner = self.clone();
        // Create the observer before creating an OS child. Thread-creation
        // failure therefore has an exact no-child result, not a dropped Child.
        let worker = std::thread::Builder::new().name("pty-supervisor".into()).spawn(move || {
            let cancelled = owner.state.lock().unwrap().phase != Phase::Bootstrapping;
            if cancelled { owner.no_child("launch cancelled before helper creation".into()); return; }
            let spawned = command.spawn();
            drop(pass_socket); drop(pass_slave);
            match spawned {
                Ok(child) => {
                    owner.state.lock().unwrap().supervisor = Some(child.id());
                    owner.observe(child, socket, config);
                }
                Err(error) => owner.no_child(format!("start PTY supervisor: {error}")),
            }
        });
        if let Err(error) = worker {
            self.no_child(format!("could not start supervisor observer: {error}"));
            return Err(error);
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut state = self.state.lock().unwrap();
        loop {
            if let Some(result) = &state.boot { return result.clone().map_err(io::Error::other); }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                drop(state); self.stop(); return Err(io::Error::new(io::ErrorKind::TimedOut, "PTY supervisor bootstrap timed out; ownership retained"));
            };
            state = self.changed.wait_timeout(state, remaining).unwrap().0;
        }
    }

    fn observe(self: Arc<Self>, mut child: Child, socket: OwnedFd, config: Vec<u8>) {
        let witness = linux::pidfd(child.id() as i32);
        let mut delivery = LaunchDelivery::NoLaunch;
        match &witness {
            Ok(witness) => self.observe_loop(&mut child, &socket, witness, &config, &mut delivery),
            Err(_) => self.lost("could not retain supervisor identity"),
        }
        // Closing the private endpoint requests helper-side cleanup on loss.
        // Keep the direct Child/pidfd until its actual exit: never abandon an
        // unreaped helper or kill a witness that may still own descendants.
        drop(socket);
        let until = Instant::now() + Duration::from_secs(1);
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                #[cfg(test)] self.observer_reaped.store(true, Ordering::SeqCst);
                if delivery == LaunchDelivery::NoLaunch {
                    // Covers failure after the loop's live check as well
                    // as missing pidfd. Only authoritative exact-helper reap
                    // plus known non-delivery can settle without a witness.
                    // Sent/uncertain Launch remains Lost even after reap.
                    let mut state = self.state.lock().unwrap();
                    state.phase = Phase::Extinct;
                    self.changed.notify_all();
                }
                return;
            }
            if !self.pending() && Instant::now() >= until {
                if let Ok(witness) = &witness { let _ = linux::signal_fd(witness.as_raw_fd(), libc::SIGKILL); }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn observe_loop(self: &Arc<Self>, child: &mut Child, socket: &OwnedFd, witness: &OwnedFd, config: &[u8], delivery: &mut LaunchDelivery) {
        let pid = child.id();
        let mut ready = false;
        let mut empty_received = false;
        let mut offset = 0;
        let mut launch_sent = false;
        let mut sent_claim = 0;
        let mut release = None;
        let boot_deadline = Instant::now() + Duration::from_secs(11);
        #[cfg(test)]
        let fault = std::env::var("TX467_SUPERVISOR_FAULT").unwrap_or_default();
        #[cfg(test)]
        let mut live_barrier_done = false;
        loop {
            // Only this worker reaps the retained direct helper. A dead witness
            // can never authenticate a late queued Extinct response.
            match child.try_wait() {
                Ok(None) => {},
                Ok(Some(_)) if *delivery == LaunchDelivery::NoLaunch => {
                    // No Launch frame was ever sent on this private channel,
                    // and the exact helper has exited. It could not fork work.
                    let mut reason = "supervisor failed before launch".to_string();
                    for _ in 0..16 {
                        match protocol::receive::<Response>(socket.as_raw_fd(), self.launch) {
                            Ok(Some(Response::Failed { stage, errno })) => { reason = format!("PTY supervisor {stage} failed ({errno}) before launch"); break; }
                            Ok(Some(_)) => {},
                            _ => break,
                        }
                    }
                    let mut state = self.state.lock().unwrap();
                    state.phase = Phase::Extinct;
                    if state.boot.is_none() { state.boot = Some(Err(reason)); }
                    self.changed.notify_all();
                    return;
                }
                _ => { self.lost("supervisor exited before acknowledged release"); return; }
            }
            #[cfg(test)]
            if fault == "preflight-after-live-check" && !live_barrier_done {
                live_barrier_done = true;
                let marker = std::env::var_os("TX467_H1_PARENT_LIVE").expect("private H1 barrier path");
                std::fs::write(marker, pid.to_string()).expect("publish exact helper live observation");
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
                    assert_eq!(unsafe { libc::waitid(libc::P_PID, pid, &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) }, 0);
                    if unsafe { info.si_pid() } == pid as i32 { break; }
                    assert!(Instant::now() < deadline, "H1 helper did not reach terminal barrier");
                    std::thread::sleep(Duration::from_millis(5));
                }
                eprintln!("H1 exact helper={pid} live-check -> terminal WNOWAIT -> response EOF; no Launch attempt");
            }
            let (phase, claim) = { let state = self.state.lock().unwrap(); (state.phase, state.stop_claim) };
            let outgoing = if let Some(claim) = release { Some(Request::Release { claim }) }
                else if ready && claim > sent_claim { Some(Request::Stop { claim }) }
                else if ready && claim == 0 && offset < config.len() { Some(Request::Config { offset, bytes: config[offset..(offset + protocol::CHUNK).min(config.len())].to_vec() }) }
                else if ready && claim == 0 && !launch_sent { Some(Request::Launch { length: config.len() }) }
                else { None };
            if let Some(request) = outgoing {
                let launching = matches!(request, Request::Launch { .. });
                if launching { *delivery = LaunchDelivery::MayHaveBeenSent; }
                let sent = protocol::send(socket.as_raw_fd(), self.launch, &request);
                #[cfg(test)]
                let sent = if launching && fault == "uncertain-launch-loss" && matches!(sent, Ok(true)) {
                    // The packet really reached the private channel, but its
                    // caller sees an uncertain outcome. Never convert this to
                    // NoLaunch merely because no success was published.
                    Err(io::Error::other("injected uncertain Launch outcome"))
                } else { sent };
                match sent {
                    Ok(true) => match request {
                        Request::Config { bytes, .. } => offset += bytes.len(),
                        Request::Launch { .. } => { launch_sent = true; *delivery = LaunchDelivery::Sent; },
                        Request::Stop { claim } => sent_claim = claim,
                        Request::Release { .. } => {
                            // Proof was checked while the exact witness was
                            // alive; Release merely lets that now-empty helper
                            // exit. Its own termination is reaped separately.
                            { let mut state = self.state.lock().unwrap(); state.phase = Phase::Extinct;
                                if state.boot.is_none() { state.boot = Some(Err("launch cancelled".into())); }
                                self.changed.notify_all(); }
                            return;
                        }
                    },
                    // The seqpacket transport reports false only for a
                    // non-delivering retry. Any error is conservatively unknown.
                    Ok(false) => { if launching { *delivery = LaunchDelivery::NoLaunch; } },
                    Err(_) => { self.lost("supervisor send failed"); return; }
                }
            }
            for _ in 0..16 {
                let response = match protocol::receive::<Response>(socket.as_raw_fd(), self.launch) {
                    Ok(Some(response)) => response, Ok(None) => break,
                    Err(_) => { self.lost("supervisor response lost or invalid"); return; }
                };
                let mut state = self.state.lock().unwrap();
                let valid = match response {
                    Response::Ready { supervisor } if !ready && supervisor == pid => { ready = true; true }
                    Response::Started { shell } if launch_sent && state.boot.is_none() && state.shell.is_none() && shell > 0 => {
                        state.shell = Some(shell);
                        if state.stop_claim == 0 { state.phase = Phase::Running; state.boot = Some(Ok(shell)); }
                        else { state.boot = Some(Err("launch cancelled during bootstrap".into())); }
                        true
                    }
                    Response::ShellExit { status } if state.shell.is_some() && state.shell_status.is_none() => { state.shell_status = Some(status); true }
                    Response::Empty if !empty_received && state.shell_status.is_some() => {
                        empty_received = true;
                        if state.stop_claim == 0 { state.stop_claim = 1; state.phase = Phase::Stopping; }
                        true
                    }
                    Response::Extinct { claim } if claim > 0 && claim == sent_claim && claim == state.stop_claim
                        && matches!(state.phase, Phase::Stopping | Phase::Unconfirmed) => {
                        drop(state);
                        // Readability on pidfd means death, not a live proof.
                        let mut poll = libc::pollfd { fd: witness.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                        if unsafe { libc::poll(&mut poll, 1, 0) } != 0 { self.lost("extinction witness is not live"); return; }
                        let mut state = self.state.lock().unwrap();
                        if state.stop_claim == claim && matches!(state.phase, Phase::Stopping | Phase::Unconfirmed) {
                            state.phase = Phase::Proven;
                            release = Some(claim);
                        }
                        continue;
                    }
                    Response::Unconfirmed { claim } if claim == state.stop_claim && claim == sent_claim && claim > 0 && state.phase == Phase::Stopping => {
                        state.phase = Phase::Unconfirmed; true
                    }
                    Response::Failed { stage, errno } if state.boot.is_none() => {
                        state.boot = Some(Err(format!("PTY supervisor {stage} failed ({errno}); cleanup pending")));
                        if state.stop_claim == 0 { state.stop_claim = 1; state.phase = Phase::Stopping; }
                        true
                    }
                    _ => false,
                };
                self.changed.notify_all();
                drop(state);
                if !valid { self.lost("out-of-order supervisor response"); return; }
            }
            if phase == Phase::Lost { return; }
            if !launch_sent && Instant::now() >= boot_deadline { self.stop(); }
            let mut poll = libc::pollfd { fd: socket.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            let result = unsafe { libc::poll(&mut poll, 1, 20) };
            if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                self.lost("supervisor poll failed"); return;
            }
        }
    }
}
