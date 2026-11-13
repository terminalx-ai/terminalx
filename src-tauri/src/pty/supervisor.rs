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
use serde::{Deserialize, Serialize};

/// The helper is always this process's own running image: `/proc/self/exe`
/// names the exact executable mapped now, even when its path was replaced or
/// removed by an update since launch. The helper checks the same identity
/// from its side (`linux::verify_ancestry`), so a supervisor never runs on
/// behalf of a parent that is not this program.
fn helper_executable() -> io::Result<PathBuf> {
    Ok(PathBuf::from("/proc/self/exe"))
}

/// Run the helper, and exit, when this process is one. Meant for an
/// executable's pre-initialisation array: that runs before any shared
/// library's constructor, Rust's `main` or libtest, so before anything could
/// start a thread, which `linux::preflight` requires of a supervisor. (The
/// desktop links GTK and WebKit, whose libraries can start threads before
/// `main`; tests have libtest's own `main`.) Each executable lists it there
/// itself: a shared object cannot have that array, and this crate is also
/// built as one. [`dispatch`], at the top of both mains, still dispatches
/// should it not have run.
pub(crate) extern "C" fn dispatch_before_main(_argc: libc::c_int, _argv: *const *const libc::c_char, envp: *const *const libc::c_char) {
    let Ok(cmdline) = std::fs::read("/proc/self/cmdline") else { return };
    let mut args = cmdline.split(|byte| *byte == 0).skip(1);
    if args.next() != Some(protocol::HELPER.as_bytes()) { return; }
    // The loader passes the environment to this array's functions; libc
    // has not published it yet, and `getenv` reads only what it publishes.
    extern "C" { static mut environ: *const *const libc::c_char; }
    // SAFETY: single threaded, before libc's own initialisation, which sets
    // the same pointer the loader handed here.
    unsafe { if environ.is_null() { environ = envp; } }
    let launch = args.next().and_then(|arg| std::str::from_utf8(arg).ok()).and_then(|arg| Uuid::parse_str(arg).ok());
    let rest = args.filter(|arg| !arg.is_empty()).count();
    let code = match (launch, rest) { (Some(launch), 0) => linux::run(launch), _ => 119 };
    // SAFETY: the helper owns no Rust runtime state that needs unwinding.
    unsafe { libc::_exit(code) }
}

/// A test executable built from this crate (the lib's, and the serve
/// control target's) lists the dispatch itself.
#[cfg(test)]
#[used]
#[link_section = ".preinit_array"]
static TEST_DISPATCH: PreInit = dispatch_before_main;

/// What the loader calls an executable's pre-initialisation functions with.
#[cfg(test)]
type PreInit = extern "C" fn(libc::c_int, *const *const libc::c_char, *const *const libc::c_char);

/// portable-pty's public environment iterator converts to UTF-8 and drops raw
/// Unix names/values. Keep a single complete OsString snapshot instead. The
/// caller uses the same arg/env/remove/cwd operations as its portable builder.
/// The standalone serve control target builds its launches with this; the
/// runtime converts its portable-pty builder through [`launch_parts`].
#[allow(dead_code)]
pub(super) struct CommandBuilder(Command);
impl std::ops::Deref for CommandBuilder {
    type Target = Command;
    fn deref(&self) -> &Command { &self.0 }
}
impl std::ops::DerefMut for CommandBuilder {
    fn deref_mut(&mut self) -> &mut Command { &mut self.0 }
}
#[allow(dead_code)]
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
        let env = self.0.get_envs().filter_map(|(key, value)| value.map(|value| (key.to_os_string(), value.to_os_string()))).collect();
        let args: Vec<OsString> = self.0.get_args().map(OsStr::to_os_string).collect();
        launch_parts(self.0.get_program(), &args, env, self.0.get_current_dir())
    }
}

/// One launch, as bytes: Unix arguments and environment are not UTF-8.
/// `env` is the complete environment the program receives.
pub(super) fn launch_parts(program: &OsStr, args: &[OsString], env: std::collections::BTreeMap<OsString, OsString>, cwd: Option<&Path>) -> io::Result<(Launch, PathBuf)> {
    // Match portable-pty 0.9's invalid-directory fallback, then resolve that
    // actual directory, never merely the input.
    let home = match env.get(OsStr::new("HOME")).and_then(|home| home.to_str()) {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(passwd()?.0),
    };
    let cwd = cwd.filter(|cwd| cwd.is_dir()).unwrap_or(&home);
    let cwd = if cwd.is_absolute() { cwd.to_path_buf() } else { std::env::current_dir()?.join(cwd) };
    // Fails rather than treating a path it cannot resolve as some other one.
    let identity = cwd.canonicalize()?;
    let program_path = Path::new(program);
    let path = if program_path.is_absolute() { program_path.to_path_buf() }
        else if matches!(program_path.components().next(), Some(std::path::Component::CurDir | std::path::Component::ParentDir)) {
            cwd.join(program_path)
        } else {
            env.get(OsStr::new("PATH")).into_iter().flat_map(std::env::split_paths)
                .map(|directory| cwd.join(directory).join(program_path)).find(|path| executable(path))
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{} was not found in PATH", program_path.display())))?
        };
    if !executable(&path) { return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{} is not an executable file", path.display()))); }
    let argv = std::iter::once(program).chain(args.iter().map(OsString::as_os_str)).map(|arg| arg.as_bytes().to_vec()).collect();
    Ok((Launch { executable: path.as_os_str().as_bytes().to_vec(), argv,
        env: env.into_iter().map(|(key, value)| (key.into_vec(), value.into_vec())).collect(),
        cwd: cwd.as_os_str().as_bytes().to_vec() }, identity))
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

/// A supervisor failure as a person can act on it. Preflight checks what the
/// kernel must provide; ancestry, what may ask for supervision.
fn failure(stage: &str, errno: i32, then: &str) -> String {
    let cause = io::Error::from_raw_os_error(errno);
    let help = match stage {
        stage if stage.starts_with(linux::PREFLIGHT) => ": this Linux system lacks what terminal ownership needs (pidfd_open and pidfd_send_signal, close_range, PR_SET_CHILD_SUBREAPER, an all-child waitid, /proc child lists and a /proc of this PID namespace; Linux 5.9 or later without a seccomp filter denying them)",
        "ancestry" => ": the supervisor was not started by this TerminalX program",
        _ => "",
    };
    format!("PTY supervisor {stage} failed: {cause}{help}; {then}")
}

pub(crate) fn dispatch() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(protocol::HELPER)) { return None; }
    let launch = args.next().and_then(|arg| arg.to_str().and_then(|s| Uuid::parse_str(s).ok()));
    Some(match (launch, args.next()) { (Some(launch), None) => linux::run(launch), _ => 119 })
}

/// How long a lost launch's helper may go on without exiting before the
/// reader can release the launch anyway (#467 review): one stopped or stuck
/// in the kernel never settles it.
#[cfg(not(test))]
const LOST_GRACE: Duration = Duration::from_secs(60);
#[cfg(test)]
const LOST_GRACE: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase { Reserved, Bootstrapping, Running, Stopping, Unconfirmed, Proven, Lost, Extinct }

/// Whether the observer is held still for a handover (#765).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Park { Running, Requested, Parked }

/// What a held launch is, as the runtime replacing this one in the same
/// process takes it over (#765). The helper stays this process's unreaped
/// child across the exec, so its pid still names it; its control channel
/// goes over as a descriptor the handover keeps open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Carried {
    launch: String,
    supervisor: u32,
    shell: u32,
    shell_status: Option<i32>,
    stop_claim: u64,
    sent_claim: u64,
    empty_received: bool,
    phase: CarriedPhase,
}

/// Reap a helper this runtime let go of (its adoption failed): it ends
/// what it runs when its channel closes, then exits, and must not be left
/// a zombie. A pid that is not this process's child is left alone.
pub(crate) fn reap_abandoned(pid: u32) {
    let _ = std::thread::Builder::new().name("pty-supervisor-reaper".into()).spawn(move || loop {
        let mut status = 0;
        let reaped = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, 0) };
        if reaped == pid as libc::pid_t || (reaped < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR)) { return; }
    });
}

impl Carried {
    #[cfg(test)]
    pub(crate) fn break_for_test(&mut self) { self.launch = "not a launch".into(); }

    #[cfg(test)]
    pub(crate) fn stopping_for_test(&self) -> bool { self.phase == CarriedPhase::Stopping && self.stop_claim > 0 }

    /// The launch's shell, as its pane names it.
    pub(crate) fn shell(&self) -> u32 { self.shell }

    /// The helper process: this runtime's child, across the handover too.
    pub(crate) fn supervisor(&self) -> u32 { self.supervisor }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CarriedPhase { Running, Stopping, Unconfirmed }

/// The outcome of holding a launch still for a handover.
pub(crate) enum Parked {
    /// Nothing is left of it to carry.
    Settled,
    /// Held, with its channel duplicated for the next runtime.
    Carried(Carried, OwnedFd),
    /// Starting, mid-release or lost: not carried now. The handover waits.
    Not,
}

/// The helper process an observer watches: one it spawned, or one the
/// runtime it replaced spawned in this same process (#765).
enum Helper { Spawned(Child), Adopted { pid: u32, exited: Option<Option<i32>> } }

impl Helper {
    fn id(&self) -> u32 { match self { Self::Spawned(child) => child.id(), Self::Adopted { pid, .. } => *pid } }

    /// Reap the helper if it has exited: its exit code, `None` for a signal.
    /// Once reaped, the same answer again.
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        match self {
            Self::Spawned(child) => child.try_wait().map(|status| status.map(|status| status.code())),
            Self::Adopted { exited: Some(code), .. } => Ok(Some(*code)),
            Self::Adopted { pid, exited } => {
                let mut status = 0;
                let reaped = unsafe { libc::waitpid(*pid as libc::pid_t, &mut status, libc::WNOHANG) };
                if reaped < 0 { return Err(io::Error::last_os_error()); }
                if reaped == 0 { return Ok(None); }
                let code = libc::WIFEXITED(status).then(|| libc::WEXITSTATUS(status));
                *exited = Some(code);
                Ok(Some(code))
            }
        }
    }
}

/// Where an observer's channel stands: a new launch's, or a carried one's.
#[derive(Default)]
struct Resume { ready: bool, empty_received: bool, launch_sent: bool, sent_claim: u64 }

#[derive(Clone, Copy, PartialEq, Eq)]
enum LaunchDelivery { NoLaunch, MayHaveBeenSent, Sent }

struct State {
    phase: Phase,
    supervisor: Option<u32>,
    shell: Option<u32>,
    shell_status: Option<i32>,
    boot: Option<Result<u32, String>>,
    stop_claim: u64,
    park: Park,
    /// The observer is in its channel loop, where it can be held still.
    observing: bool,
    /// The helper has exited and been reaped: nothing more can be learned.
    reaped: bool,
    /// What preflight found this system lacking, before any launch.
    unsupported: Option<String>,
    /// When the launch was lost.
    lost_at: Option<Instant>,
    /// A Stop came while the observer was held for a handover, after the
    /// state was last taken for the record (#765 review).
    stopped_while_parked: bool,
}

pub(super) struct Owner {
    launch: Uuid,
    state: Mutex<State>,
    changed: Condvar,
    cancelled: AtomicBool,
    /// What the held observer left for a handover to take.
    carried: Mutex<Option<(Carried, OwnedFd)>>,
    #[cfg(test)]
    observer_reaped: AtomicBool,
    /// A fault for this launch's helper alone, from [`with_test_fault`].
    #[cfg(test)]
    fault: Option<String>,
}

#[cfg(test)]
thread_local! { static TEST_FAULT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }

/// Run `then` with every launch it starts given `fault` (the helper's
/// `TX467_SUPERVISOR_FAULT`), without touching other tests' launches.
#[cfg(test)]
pub(crate) fn with_test_fault<R>(fault: &str, then: impl FnOnce() -> R) -> R {
    TEST_FAULT.with(|slot| *slot.borrow_mut() = Some(fault.to_string()));
    let result = then();
    TEST_FAULT.with(|slot| *slot.borrow_mut() = None);
    result
}

impl Owner {
    /// Publish this exact handle in the pane/launch reservation before releasing
    /// admission. Even a not-yet-spawned worker is pending owned work.
    pub(super) fn reserve() -> Arc<Self> {
        Arc::new(Self { launch: Uuid::new_v4(), state: Mutex::new(State {
            phase: Phase::Reserved, supervisor: None, shell: None,
            shell_status: None, boot: None, stop_claim: 0, park: Park::Running, observing: false, reaped: false, unsupported: None, lost_at: None, stopped_while_parked: false,
        }), changed: Condvar::new(), cancelled: AtomicBool::new(false), carried: Mutex::new(None),
            #[cfg(test)] observer_reaped: AtomicBool::new(false), #[cfg(test)] fault: TEST_FAULT.with(|slot| slot.borrow().clone()), })
    }

    /// Hold the observer still where its channel state is whole, so a
    /// handover can carry the launch (#765). Messages the helper sends
    /// meanwhile wait in the channel. Undo with [`Self::unpark`].
    pub(super) fn park(&self, within: Duration) -> Parked {
        let deadline = Instant::now() + within;
        let mut state = self.state.lock().unwrap();
        if !state.observing {
            return if state.phase == Phase::Extinct { Parked::Settled } else { Parked::Not };
        }
        state.park = Park::Requested;
        self.changed.notify_all();
        while state.park == Park::Requested && state.observing {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
            state = self.changed.wait_timeout(state, left).unwrap().0;
        }
        if state.park != Park::Parked { state.park = Park::Running; return Parked::Not; }
        let taken = self.carried.lock().unwrap().take();
        match taken {
            Some((carried, socket)) => Parked::Carried(carried, socket),
            // Held where it could not be carried: let it go on at once.
            None => { state.park = Park::Running; self.changed.notify_all(); Parked::Not }
        }
    }

    /// Give up a lost launch whose helper has been reaped, at the reader's
    /// explicit request: there is no channel, witness or child left to learn
    /// anything from. Processes it started may still run, unowned; the
    /// caller says so. True when released.
    pub(super) fn release_lost(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if !Self::given_up(&state) { return false; }
        // A helper that never exited (stopped, or stuck in the kernel) is
        // killed and reaped by its observer once this is no longer pending.
        state.phase = Phase::Extinct;
        self.changed.notify_all();
        true
    }

    /// Lost, with nothing left to learn: its helper gone, or not heard from
    /// for [`LOST_GRACE`]. Only the reader can release it now.
    pub(super) fn lost_for_good(&self) -> bool { Self::given_up(&self.state.lock().unwrap()) }

    fn given_up(state: &State) -> bool {
        state.phase == Phase::Lost && (state.reaped || state.lost_at.is_some_and(|at| at.elapsed() >= LOST_GRACE))
    }

    /// Bring a held launch's carried state up to date for the record: a Stop
    /// that came since it was held goes over as Stopping, with its claim,
    /// for the runtime that takes over to send. From here on any further
    /// Stop shows in [`Self::stopped_while_parked`].
    pub(super) fn refresh(&self, carried: &mut Carried) {
        let mut state = self.state.lock().unwrap();
        if state.stop_claim > carried.stop_claim {
            carried.stop_claim = state.stop_claim;
            carried.phase = match state.phase { Phase::Unconfirmed => CarriedPhase::Unconfirmed, _ => CarriedPhase::Stopping };
        }
        state.stopped_while_parked = false;
    }

    /// Whether `carried` is this launch's.
    pub(super) fn launch_is(&self, carried: &Carried) -> bool { carried.launch == self.launch.to_string() }

    /// A Stop came since the state was last taken for the record.
    pub(super) fn stopped_while_parked(&self) -> bool { self.state.lock().unwrap().stopped_while_parked }

    /// Let a held observer go on: the handover was called off.
    pub(super) fn unpark(&self) {
        self.carried.lock().unwrap().take();
        let mut state = self.state.lock().unwrap();
        state.stopped_while_parked = false;
        state.park = Park::Running;
        self.changed.notify_all();
    }

    /// Whether a handover could carry this launch as it stands: started,
    /// with its channel up, and not lost.
    pub(super) fn carriable(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.observing && state.shell.is_some() && state.boot.as_ref().is_some_and(Result::is_ok)
            && matches!(state.phase, Phase::Running | Phase::Stopping | Phase::Unconfirmed | Phase::Proven)
    }

    /// Take over a launch the runtime this one replaced carried (#765). Its
    /// helper must still be this process's child, and `socket` its channel.
    pub(super) fn adopt(carried: Carried, socket: OwnedFd) -> io::Result<Arc<Self>> {
        let launch = Uuid::parse_str(&carried.launch).map_err(|_| io::Error::other("carried launch has no valid identity"))?;
        let pid = carried.supervisor as libc::pid_t;
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        if unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) } < 0 {
            return Err(io::Error::other(format!("carried supervisor {pid} is not this runtime's child: {}", io::Error::last_os_error())));
        }
        // A socket pair's credentials are its maker's: this process, which
        // made it before the exec and keeps its pid across it. The helper
        // checked the same from its end when it started.
        let mut kind: libc::c_int = 0;
        let mut length = std::mem::size_of_val(&kind) as libc::socklen_t;
        if unsafe { libc::getsockopt(socket.as_raw_fd(), libc::SOL_SOCKET, libc::SO_TYPE, (&mut kind as *mut libc::c_int).cast(), &mut length) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut peer = unsafe { std::mem::zeroed::<libc::ucred>() };
        length = std::mem::size_of_val(&peer) as libc::socklen_t;
        if unsafe { libc::getsockopt(socket.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut peer as *mut libc::ucred).cast(), &mut length) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if kind != libc::SOCK_SEQPACKET || peer.pid != unsafe { libc::getpid() } || peer.uid != unsafe { libc::getuid() } {
            return Err(io::Error::other("carried channel is not one this runtime made"));
        }
        let phase = match carried.phase { CarriedPhase::Running => Phase::Running, CarriedPhase::Stopping => Phase::Stopping, CarriedPhase::Unconfirmed => Phase::Unconfirmed };
        let owner = Arc::new(Self { launch, state: Mutex::new(State {
            phase, supervisor: Some(carried.supervisor), shell: Some(carried.shell), shell_status: carried.shell_status,
            boot: Some(Ok(carried.shell)), stop_claim: carried.stop_claim, park: Park::Running, observing: true, reaped: false, unsupported: None, lost_at: None, stopped_while_parked: false,
        }), changed: Condvar::new(), cancelled: AtomicBool::new(false), carried: Mutex::new(None),
            #[cfg(test)] observer_reaped: AtomicBool::new(false), #[cfg(test)] fault: TEST_FAULT.with(|slot| slot.borrow().clone()), });
        let observer = owner.clone();
        let resume = Resume { ready: true, empty_received: carried.empty_received, launch_sent: true, sent_claim: carried.sent_claim };
        std::thread::Builder::new().name("pty-supervisor".into())
            .spawn(move || observer.observe(Helper::Adopted { pid: carried.supervisor, exited: None }, socket, Vec::new(), resume))?;
        Ok(owner)
    }

    // Read by the standalone control target only.
    #[cfg(test)]
    #[allow(dead_code)]
    pub(super) fn observer_reaped(&self) -> bool { self.observer_reaped.load(Ordering::SeqCst) }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(super) fn test_unconfirmed(&self) -> bool { self.state.lock().unwrap().phase == Phase::Unconfirmed }

    /// The standalone control target checks this and [`Self::attach_allowed`].
    #[allow(dead_code)]
    pub(super) fn reserved(&self) -> bool {
        self.state.lock().unwrap().phase == Phase::Reserved && !self.cancelled.load(Ordering::SeqCst)
    }
    /// What this system lacks, when preflight said so before any launch:
    /// nothing was started, and the launch can be made without a supervisor.
    /// Waits briefly for the helper that said so to be reaped: only then is
    /// it certain that nothing was started.
    pub(super) fn unsupported(&self) -> Option<String> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut state = self.state.lock().unwrap();
        while state.unsupported.is_some() && state.phase != Phase::Extinct {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
            state = self.changed.wait_timeout(state, left).unwrap().0;
        }
        if state.phase == Phase::Extinct { state.unsupported.clone() } else { None }
    }

    /// Lose the channel as a protocol fault would: ownership stays, unproven.
    #[cfg(test)]
    pub(super) fn lose_for_test(&self) { self.lost("lost for a test"); }

    #[cfg(test)]
    pub(super) fn supervisor_for_test(&self) -> Option<u32> { self.state.lock().unwrap().supervisor }

    pub(super) fn pending(&self) -> bool { self.state.lock().unwrap().phase != Phase::Extinct }

    pub(super) fn pid(&self) -> Option<u32> {
        let state = self.state.lock().unwrap();
        // Once the supervisor has reaped the shell its pid may be anyone's:
        // the helper, still this process's unreaped child, names the launch.
        if state.phase == Phase::Extinct { None }
        else if state.shell_status.is_some() { state.supervisor }
        else { state.shell.or(state.supervisor) }
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
        // Held for a handover, the observer sends nothing: the record must
        // say so, or the handover is called off (`refresh`).
        if state.park != Park::Running { state.stopped_while_parked = true; }
        self.changed.notify_all();
    }

    #[allow(dead_code)]
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
        if state.phase != Phase::Lost { state.lost_at = Some(Instant::now()); }
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
            #[cfg(test)]
            if let Some(fault) = &self.fault { command.env("TX467_SUPERVISOR_FAULT", fault); }
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
                    { let mut state = owner.state.lock().unwrap(); state.supervisor = Some(child.id()); state.observing = true; }
                    owner.observe(Helper::Spawned(child), socket, config, Resume::default());
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

    fn observe(self: Arc<Self>, mut child: Helper, socket: OwnedFd, config: Vec<u8>, resume: Resume) {
        // An adopted helper is still this process's unreaped child, so its
        // pid cannot have been reused: a new pidfd names the same process.
        let witness = linux::pidfd(child.id() as i32);
        let mut delivery = if resume.launch_sent { LaunchDelivery::Sent } else { LaunchDelivery::NoLaunch };
        match &witness {
            Ok(witness) => self.observe_loop(&mut child, &socket, witness, &config, &mut delivery, resume),
            Err(_) => self.lost("could not retain supervisor identity"),
        }
        { let mut state = self.state.lock().unwrap(); state.observing = false; self.changed.notify_all(); }
        // Closing the private endpoint requests helper-side cleanup on loss.
        // Keep the direct Child/pidfd until its actual exit: never abandon an
        // unreaped helper or kill a witness that may still own descendants.
        drop(socket);
        let until = Instant::now() + Duration::from_secs(1);
        loop {
            if let Ok(Some(code)) = child.try_wait() {
                #[cfg(test)] self.observer_reaped.store(true, Ordering::SeqCst);
                let mut state = self.state.lock().unwrap();
                state.reaped = true;
                if delivery == LaunchDelivery::NoLaunch {
                    // Covers failure after the loop's live check as well
                    // as missing pidfd. Only authoritative exact-helper reap
                    // plus known non-delivery can settle without a witness.
                    state.phase = Phase::Extinct;
                } else if code == Some(linux::EMPTY_AFTER_LOSS) && state.phase != Phase::Extinct {
                    // The helper lost its channel, stopped everything and
                    // exited only once its own all-child wait found nothing:
                    // the exact helper's reaped status is that proof. Any
                    // other exit (a signal, a crash) leaves the launch Lost.
                    state.phase = Phase::Extinct;
                }
                self.changed.notify_all();
                return;
            }
            if !self.pending() && Instant::now() >= until {
                if let Ok(witness) = &witness { let _ = linux::signal_fd(witness.as_raw_fd(), libc::SIGKILL); }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn observe_loop(self: &Arc<Self>, child: &mut Helper, socket: &OwnedFd, witness: &OwnedFd, config: &[u8], delivery: &mut LaunchDelivery, resume: Resume) {
        let pid = child.id();
        let Resume { mut ready, mut empty_received, mut launch_sent, mut sent_claim } = resume;
        let mut offset = if launch_sent { config.len() } else { 0 };
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
                            Ok(Some(Response::Failed { stage, errno })) => {
                                reason = failure(&stage, errno, "before launch");
                                if let Some(feature) = stage.strip_prefix(linux::PREFLIGHT) {
                                    self.state.lock().unwrap().unsupported = Some(feature.to_string());
                                }
                                break;
                            }
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
                // It lost the channel from its side, cleaned up, and found
                // nothing left; the reap loop after this one settles it.
                Ok(Some(Some(linux::EMPTY_AFTER_LOSS))) => { self.lost("supervisor ended its launch after losing its channel"); return; }
                _ => { self.lost("supervisor exited before acknowledged release"); return; }
            }
            // A handover holds the observer here, between whole exchanges:
            // what was sent and received is all in these locals and the
            // state, and anything newer waits in the channel (#765).
            {
                let mut state = self.state.lock().unwrap();
                if state.park == Park::Requested {
                    let phase = match state.phase {
                        Phase::Running => Some(CarriedPhase::Running),
                        Phase::Stopping => Some(CarriedPhase::Stopping),
                        Phase::Unconfirmed => Some(CarriedPhase::Unconfirmed),
                        _ => None,
                    };
                    let steady = ready && launch_sent && release.is_none() && *delivery == LaunchDelivery::Sent;
                    let carried = phase.zip(state.shell).filter(|_| steady).and_then(|(phase, shell)| {
                        // Close-on-exec: the handover clears that on the
                        // descriptors its record names, and only those.
                        let fd = unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
                        (fd >= 0).then(|| (Carried { launch: self.launch.to_string(), supervisor: pid, shell, shell_status: state.shell_status,
                            stop_claim: state.stop_claim, sent_claim, empty_received, phase }, unsafe { OwnedFd::from_raw_fd(fd) }))
                    });
                    *self.carried.lock().unwrap() = carried;
                    state.park = Park::Parked;
                    self.changed.notify_all();
                    while state.park == Park::Parked { state = self.changed.wait(state).unwrap(); }
                }
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
                        // Before any launch, preflight says what the system lacks.
                        if !launch_sent { if let Some(feature) = stage.strip_prefix(linux::PREFLIGHT) { state.unsupported = Some(feature.to_string()); } }
                        state.boot = Some(Err(failure(&stage, errno, "cleanup pending")));
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
