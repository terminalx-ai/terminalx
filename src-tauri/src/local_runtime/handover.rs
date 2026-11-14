//! Replacing the runtime without stopping what it runs (#765).
//!
//! Every agent and terminal belongs to the runtime process: it holds each
//! terminal's master, each agent is its child, and each agent's hooks dial a
//! socket named for its pid. So the runtime is replaced in place. Asked to
//! hand over (`runtime.handover`), it holds everything still, writes down
//! what it knows in a handover record, keeps open the descriptors the record
//! names, and execs the newer runtime's binary. The pid does not change: the
//! agents stay its children, their hooks reach the same socket with the same
//! tokens, and every terminal stays open. The new runtime reads the record
//! (`--adopt`) and takes it all over before it serves anything; the app and
//! the phone reconnect as after any lost connection.
//!
//! Nothing is stopped by a handover. What the record's format cannot carry
//! (an agent driven over its standard input and output) is named first
//! (`runtime.handover.plan`); it goes only if the reader agrees to stop it,
//! as Stop does, and then only it. The record is versioned: a runtime reads
//! every format it names in `handover-formats`, and is handed over to only
//! when it reads this one.
//!
//! Only a runtime installed in this home, immutably and with this one's
//! signature, at this version or a newer one, is ever exec'd: whoever can
//! ask for a handover must not be able to put a program of their own in the
//! runtime's place.

use std::collections::HashMap;
use std::ffi::OsString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::control::ControlError;
use crate::session::handover::{TabRecord, Unsettled};
use crate::session::retire::Work;

/// The record format this build writes.
pub const FORMAT: u32 = 1;
/// The record formats this build reads.
pub const FORMATS: &[u32] = &[1];
/// The subcommand that says which formats a runtime's binary reads.
pub const FORMATS_COMMAND: &str = "handover-formats";

/// How long each part of the runtime is given to come to rest.
const SETTLE_WITHIN: Duration = Duration::from_secs(10);
/// How long the binary taking over is given to say what it reads.
const ASK_WITHIN: Duration = Duration::from_secs(30);
/// How long the reply to the handover may take to be written before exec.
const REPLY_WITHIN: Duration = Duration::from_secs(5);

mod bytes {
    use super::*;
    pub fn serialize<S: serde::Serializer>(value: &[u8], serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(value))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Vec<u8>, D::Error> {
        base64::engine::general_purpose::STANDARD.decode(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Everything a runtime hands to the one that replaces it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub format: u32,
    /// The version of the runtime that wrote it.
    pub from: String,
    pub pid: u32,
    /// The data directory's ownership lock, held.
    pub owner: RawFd,
    pub control: ControlRecord,
    #[serde(default)]
    pub frames: Vec<FrameRecord>,
    #[serde(default)]
    pub decisions: Vec<ParkedRecord>,
    #[serde(default)]
    pub panes: Vec<PaneRecord>,
    #[serde(default)]
    pub(crate) retained: Vec<crate::local_runtime::scrollback::History>,
    #[serde(default)]
    pub groups: Vec<u32>,
    #[serde(default)]
    pub(crate) tabs: Vec<TabRecord>,
}

/// The launch's hook and control sockets.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRecord {
    pub socket: PathBuf,
    pub token: String,
    /// The listener on `socket`.
    pub own: RawFd,
    /// The home's published socket's listener and its lock, when held.
    pub published: Option<(RawFd, RawFd)>,
}

/// A hook or control frame read and not answered.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRecord {
    pub fd: RawFd,
    pub line: String,
}

/// A hook waiting on a decision.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedRecord {
    pub fd: RawFd,
    pub request_id: String,
}

/// A terminal.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneRecord {
    pub id: String,
    pub fd: RawFd,
    pub pid: Option<u32>,
    pub group: Option<u32>,
    pub explicit_command: bool,
    #[serde(default)]
    pub environment: Option<crate::store::environment::Stamp>,
    pub cwd: String,
    pub created: String,
    pub tty: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
    #[serde(with = "bytes")]
    pub scrollback: Vec<u8>,
    pub printed: u64,
    #[serde(with = "bytes")]
    pub screen: Vec<u8>,
    pub quiet_ms: Option<u64>,
    pub title: Option<String>,
    #[serde(default)]
    pub renamed: bool,
}

/// What `handover-formats` prints: which records this binary reads.
pub fn formats() -> Value {
    json!({ "version": env!("CARGO_PKG_VERSION"), "formats": FORMATS })
}

// --------------------------------------------------------------- the old side

/// What a runtime hands over, once it is serving.
pub(crate) struct Runtime {
    pub manager: crate::session::SessionManager,
    pub terminals: Arc<crate::pty::Terminals>,
    pub bridge: Arc<crate::hooks::Bridge>,
    pub control: crate::hooks::ControlEndpoint,
    pub home: PathBuf,
    /// The descriptor holding the data directory's ownership lock.
    pub owner: RawFd,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// The runtime can be handed over from now on.
pub(crate) fn install(runtime: Runtime) {
    let _ = RUNTIME.set(runtime);
}

fn refused(code: &str, message: impl Into<String>) -> ControlError {
    ControlError::new(code, message, None::<String>)
}

/// Agents the handover cannot carry that nobody agreed to have stopped: the
/// reader is asked about them first (`runtime.handover.plan`).
#[derive(Debug)]
struct Unkept(usize);

impl std::fmt::Display for Unkept {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{} agent(s) cannot be kept running through the update; ask before stopping them.", self.0)
    }
}

impl std::error::Error for Unkept {}

fn failed(error: anyhow::Error) -> ControlError {
    if let Some(unkept) = error.downcast_ref::<Unkept>() {
        return refused("handover_unadoptable", unkept.to_string());
    }
    if let Some(unsettled) = error.downcast_ref::<Unsettled>() {
        return ControlError::new("handover_busy", format!("{unsettled}; it is handed over once that has settled."), Some("Try again in a moment.".into()));
    }
    ControlError::new("handover_failed", format!("{error:#}"), None::<String>)
}

/// `runtime.handover.plan`: whether this runtime can be handed over to
/// `binary` (when named), and what would have to be stopped first.
pub(crate) fn plan(lifetime: &super::Lifetime, params: &Value) -> Result<Value, ControlError> {
    let runtime = RUNTIME.get().ok_or_else(|| refused("unsupported", "This runtime cannot be handed over."))?;
    pinned(lifetime, params)?;
    if let Some(binary) = params["binary"].as_str() {
        verify(&runtime.home, Path::new(binary)).map_err(|error| refused("handover_unsupported", format!("{error:#}")))?;
    }
    Ok(json!({ "format": FORMAT, "unadoptable": runtime.manager.unadoptable() }))
}

fn pinned(lifetime: &super::Lifetime, params: &Value) -> Result<(), ControlError> {
    if params["epoch"].as_str() != Some(lifetime.epoch.as_str()) {
        return Err(refused("runtime_restarted", "Refresh runtime status before handing the runtime over."));
    }
    Ok(())
}

/// `runtime.handover`: replace this runtime with `binary`, in place, keeping
/// every agent and terminal running. `stop` names what the reader agreed to
/// have stopped because the record cannot carry it; anything else of the
/// kind refuses the handover with nothing stopped. The reply is written just
/// before the process becomes the new runtime.
pub(crate) fn begin(lifetime: &super::Lifetime, params: Value) -> Result<Value, ControlError> {
    let runtime = RUNTIME.get().ok_or_else(|| refused("unsupported", "This runtime cannot be handed over."))?;
    pinned(lifetime, &params)?;
    let binary = PathBuf::from(params["binary"].as_str().ok_or_else(|| ControlError::invalid("binary is required"))?);
    let verified = verify(&runtime.home, &binary).map_err(|error| refused("handover_unsupported", format!("{error:#}")))?;
    let stop: Vec<(String, String)> = params["stop"].as_array().map(|stop| stop.iter().filter_map(|work| {
        Some((work["sessionId"].as_str()?.to_string(), work["tabId"].as_str()?.to_string()))
    }).collect()).unwrap_or_default();
    let named = |work: &Work| work.session_id.as_ref().zip(work.tab_id.as_ref()).is_some_and(|(session, tab)| stop.iter().any(|(s, t)| s == session && t == tab));
    let unadoptable = runtime.manager.unadoptable();
    let unnamed = unadoptable.iter().filter(|work| !named(work)).count();
    if unnamed > 0 {
        return Err(failed(Unkept(unnamed).into()));
    }
    // What the reader agreed to have stopped, as Stop stops it, and nothing else.
    for work in unadoptable.iter().filter(|work| named(work)) {
        let (Some(session), Some(tab)) = (&work.session_id, &work.tab_id) else { continue };
        log::info!("stopping {session}/{tab} before the handover, as asked");
        runtime.manager.stop(session, tab).map_err(|error| failed(error.context("stop an agent the handover cannot carry")))?;
    }
    let (ready, readied) = std::sync::mpsc::channel::<Result<(), ControlError>>();
    let (go, gone) = std::sync::mpsc::channel::<()>();
    // This request is the handover itself: nothing waits for it.
    let _aside = crate::hooks::step_aside();
    std::thread::Builder::new().name("runtime-handover".into()).spawn(move || {
        let outcome = hand_over(runtime, &verified, &ready, gone);
        if let Err(error) = outcome {
            log::warn!("the runtime was not handed over: {error:#}");
            let _ = ready.send(Err(failed(error)));
        }
    }).map_err(ControlError::internal)?;
    match readied.recv() {
        Ok(Ok(())) => {
            log::info!("handing the runtime over to {}", binary.display());
            crate::hooks::after_reply(Box::new(move || { let _ = go.send(()); }));
            Ok(json!({ "handingOver": true, "pid": std::process::id(), "format": FORMAT }))
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err(ControlError::internal("The handover ended without saying how.")),
    }
}

/// Hold everything still, write the record, and exec `binary`. Returns only
/// when the handover is off, with everything going on as before.
fn hand_over(runtime: &Runtime, binary: &Verified, ready: &std::sync::mpsc::Sender<Result<(), ControlError>>, go: std::sync::mpsc::Receiver<()>) -> Result<()> {
    // Local VM work is not carried: none is in flight or under way, and none
    // starts until the exec or until the handover is off.
    let _vm = crate::local_vm::supervisor::prepare_handover().map_err(|error| Unsettled(format!("{error:#}")))?;
    // No frame is answered from here on, once those under way are: what
    // they wait for (a pipeline step, the admission lock) is not held yet.
    runtime.bridge.freeze(SETTLE_WITHIN).map_err(|error| Unsettled(format!("{error:#}")))?;
    let thawed = || runtime.bridge.thaw();
    // No pipeline step starts, and none is running.
    let Some(steps) = crate::issue_pipeline::engine::pause_steps(SETTLE_WITHIN) else {
        thawed();
        return Err(Unsettled("An issue pipeline step is under way".into()).into());
    };
    // No turn, start or send is admitted.
    let admission = crate::issue_pipeline::admission::lock();
    let terminals = match runtime.terminals.freeze(SETTLE_WITHIN) {
        Ok(terminals) => terminals,
        Err(error) => {
            drop((admission, steps));
            thawed();
            return Err(Unsettled(format!("{error:#}")).into());
        }
    };
    let path = runtime.home.join("run").join(format!("handover-{}.json", std::process::id()));
    let outcome = runtime.manager.hold_tabs(SETTLE_WITHIN, |held| -> Result<()> {
        // Started since what had to be stopped was named: asked about first.
        if !held.unadoptable.is_empty() {
            return Err(Unkept(held.unadoptable.len()).into());
        }
        // Only now, with every tab held, can no waiting hook be answered; one
        // answered before is answered here.
        let hooks = runtime.bridge.take(|request_id| held.awaited.contains(request_id)).map_err(|error| Unsettled(format!("{error:#}")))?;
        let (record, kept) = Record::of(runtime, hooks, terminals, held.tabs)?;
        // It holds the agents' hook tokens: none of it is left behind.
        if let Err(error) = write(&path, &record) {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        // Every descriptor the record names stays open in the new runtime:
        // the duplicates made for it, and the ownership lock's own, which
        // is the only one this runtime goes on using if the exec fails.
        let opened = kept.iter().map(AsRawFd::as_raw_fd).chain([runtime.owner]).try_for_each(|fd| set_cloexec(fd, false));
        if let Err(error) = opened {
            let _ = set_cloexec(runtime.owner, true);
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        let _ = ready.send(Ok(()));
        // The reply to the handover goes out first.
        let _ = go.recv_timeout(REPLY_WITHIN);
        log::info!("the runtime hands {} terminal(s) and {} agent tab(s) to {}", record.panes.len(), record.tabs.len(), binary.path.display());
        log::logger().flush();
        let error = exec(binary, &path);
        // Still this runtime: the descriptors go back to being its own.
        for fd in kept.iter().map(AsRawFd::as_raw_fd).chain([runtime.owner]) {
            let _ = set_cloexec(fd, true);
        }
        let _ = std::fs::remove_file(&path);
        Err(error.context(format!("start {}", binary.path.display())))
    });
    runtime.terminals.thaw();
    drop((admission, steps));
    thawed();
    outcome?
}

impl Record {
    /// The record of what was frozen, and the descriptors it names, which
    /// must stay open across the exec.
    fn of(runtime: &Runtime, hooks: crate::hooks::Frozen, terminals: crate::pty::Frozen, tabs: Vec<TabRecord>) -> Result<(Self, Vec<OwnedFd>)> {
        let mut kept: Vec<OwnedFd> = Vec::new();
        let mut keep = |fd: OwnedFd| -> RawFd {
            let raw = fd.as_raw_fd();
            kept.push(fd);
            raw
        };
        // The ownership lock is held by the runtime's own descriptor, which
        // goes over as it is.
        let owner = runtime.owner;
        let control = ControlRecord {
            socket: runtime.control.socket.clone(),
            token: runtime.control.token.clone(),
            own: keep(hooks.own),
            published: hooks.published.map(|(listener, lock)| (keep(listener), keep(lock))),
        };
        let frames = hooks.held.into_iter().map(|(fd, line)| FrameRecord { fd: keep(fd), line }).collect();
        let decisions = hooks.parked.into_iter().map(|(request_id, fd)| ParkedRecord { fd: keep(fd), request_id }).collect();
        let panes = terminals.panes.into_iter().map(|pane| PaneRecord {
            id: pane.id, fd: keep(pane.master), pid: pane.pid, group: pane.group, explicit_command: pane.explicit_command, environment: Some(pane.environment),
            cwd: pane.cwd, created: pane.created, tty: pane.tty, cols: pane.cols, rows: pane.rows, scrollback: pane.scrollback,
            printed: pane.printed, screen: pane.screen, quiet_ms: pane.quiet.map(|quiet| u64::try_from(quiet.as_millis()).unwrap_or(u64::MAX)),
            title: pane.title, renamed: pane.renamed,
        }).collect();
        let record = Self { format: FORMAT, from: env!("CARGO_PKG_VERSION").into(), pid: std::process::id(), owner, control, frames, decisions,
            panes, retained: terminals.retained, groups: terminals.groups, tabs };
        Ok((record, kept))
    }
}

/// Write `record` where only this user can read it.
fn write(path: &Path, record: &Record) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)
        .with_context(|| format!("create {}", path.display()))?;
    serde_json::to_writer(&mut file, record).context("write the handover record")?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

fn set_cloexec(fd: RawFd, on: bool) -> Result<()> {
    // SAFETY: F_GETFD/F_SETFD only read and set the descriptor's own flags.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 { return Err(std::io::Error::last_os_error()).context("read a descriptor's flags"); }
        let flags = if on { flags | libc::FD_CLOEXEC } else { flags & !libc::FD_CLOEXEC };
        if libc::fcntl(fd, libc::F_SETFD, flags) < 0 { return Err(std::io::Error::last_os_error()).context("set a descriptor's flags"); }
    }
    Ok(())
}

/// Become the verified runtime, run with this runtime's own arguments and
/// `--adopt record`. Returns only on failure. Everything was held still for a
/// while since it was verified, so it is checked again first: the same file,
/// with the same contents. On Linux the very descriptor checked is exec'd;
/// on macOS, which cannot exec one, its path is, a moment after the check.
fn exec(binary: &Verified, record: &Path) -> anyhow::Error {
    let (file, identity) = match opened(&binary.path, &binary.digest) {
        Ok(opened) => opened,
        Err(error) => return error.context("the runtime to hand over to changed since it was checked"),
    };
    if identity != binary.identity {
        return anyhow::anyhow!("{} was replaced since it was checked", binary.path.display());
    }
    let args = arguments(record);
    #[cfg(target_os = "linux")]
    return fexecve(&file, &binary.path, &args);
    #[cfg(not(target_os = "linux"))]
    {
        use std::os::unix::process::CommandExt;
        drop(file);
        anyhow::Error::from(std::process::Command::new(&binary.path).args(args).exec())
    }
}

/// Exec `file`, as `path`, with `args`. Returns only on failure.
#[cfg(target_os = "linux")]
fn fexecve(file: &std::fs::File, path: &Path, args: &[OsString]) -> anyhow::Error {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let text = |bytes: &[u8]| CString::new(bytes).map_err(|_| anyhow::anyhow!("an argument holds a NUL byte"));
    let built = (|| -> Result<(Vec<CString>, Vec<CString>)> {
        let mut argv = vec![text(path.as_os_str().as_bytes())?];
        for arg in args { argv.push(text(arg.as_bytes())?); }
        let mut envp = Vec::new();
        for (name, value) in std::env::vars_os() {
            let mut pair = name.as_bytes().to_vec();
            pair.push(b'=');
            pair.extend_from_slice(value.as_bytes());
            envp.push(text(&pair)?);
        }
        Ok((argv, envp))
    })();
    let (argv, envp) = match built {
        Ok(built) => built,
        Err(error) => return error,
    };
    let mut argv: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
    argv.push(std::ptr::null());
    let mut envp: Vec<*const libc::c_char> = envp.iter().map(|pair| pair.as_ptr()).collect();
    envp.push(std::ptr::null());
    // SAFETY: both arrays are NUL-terminated, and every string they point at
    // outlives the call, which returns only on failure.
    unsafe { libc::fexecve(file.as_raw_fd(), argv.as_ptr(), envp.as_ptr()) };
    std::io::Error::last_os_error().into()
}

/// This runtime's own arguments, with `--adopt record` in place of any it had.
fn arguments(record: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    let mut given = std::env::args_os().skip(1);
    while let Some(arg) = given.next() {
        if arg == "--adopt" {
            given.next();
            continue;
        }
        if arg.to_string_lossy().starts_with("--adopt=") { continue; }
        args.push(arg);
    }
    args.push("--adopt".into());
    args.push(record.into());
    args
}

/// A runtime binary checked to be one this runtime may hand over to, as it
/// was when checked: checked again just before it is exec'd ([`exec`]).
pub(crate) struct Verified {
    /// Its path, every link resolved.
    path: PathBuf,
    /// The file that was checked, by device and inode.
    identity: (u64, u64),
    /// The digest of its contents, which is the name of its directory.
    digest: String,
}

/// Whether `binary` is one this runtime may hand over to: a runtime installed
/// in `home` as the app installs one (`launch::install`), in a private
/// directory of this home's named for the digest of its contents, private to
/// this user; signed as this runtime is (macOS); reading this runtime's
/// record format; and of this version or a newer one.
pub(crate) fn verify(home: &Path, binary: &Path) -> Result<Verified> {
    use std::os::unix::fs::MetadataExt;
    let runtimes = std::fs::canonicalize(home.join("runtime")).context("find this home's installed runtimes")?;
    if binary.file_name() != Some(std::ffi::OsStr::new("terminalx-serve")) {
        bail!("{} is not a runtime installed in this home", binary.display());
    }
    let directory = binary.parent().context("the runtime has no directory")?;
    // The version's own directory, not a link to one elsewhere, and private.
    let held = std::fs::symlink_metadata(directory).with_context(|| format!("look at {}", directory.display()))?;
    // SAFETY: geteuid has no preconditions.
    if !held.is_dir() || held.uid() != unsafe { libc::geteuid() } || held.mode() & 0o077 != 0 {
        bail!("{} is not a private directory of this home's runtimes", directory.display());
    }
    let digest = directory.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
    let path = runtimes.join(&digest).join("terminalx-serve");
    if std::fs::canonicalize(binary).ok().as_ref() != Some(&path) {
        bail!("{} is not a runtime installed in this home", binary.display());
    }
    let identity = checked(&path, &digest)?;
    #[cfg(target_os = "macos")]
    signed_alike(&path)?;
    let answer = ask(&path)?;
    let version = answer["version"].as_str().and_then(|version| semver::Version::parse(version).ok()).context("the runtime did not say its version")?;
    let own = semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("the crate's own version is semantic");
    if version < own {
        bail!("{} is version {version}, older than this runtime ({own})", binary.display());
    }
    if !answer["formats"].as_array().is_some_and(|formats| formats.iter().any(|format| format.as_u64() == Some(u64::from(FORMAT)))) {
        bail!("{} cannot take over this runtime's agents: it reads none of the handover formats this one writes", binary.display());
    }
    // Asking it must not have changed it: what was signed is what is run.
    if checked(&path, &digest)? != identity {
        bail!("{} changed while it was checked", binary.display());
    }
    Ok(Verified { path, identity, digest })
}

/// Open `path` as the private executable of this user's whose contents
/// `digest` names, and say which file it is.
fn checked(path: &Path, digest: &str) -> Result<(u64, u64)> {
    let (file, identity) = opened(path, digest)?;
    drop(file);
    Ok(identity)
}

fn opened(path: &Path, digest: &str) -> Result<(std::fs::File, (u64, u64))> {
    use std::io::{Seek, SeekFrom};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let meta = file.metadata()?;
    // SAFETY: geteuid has no preconditions.
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 || meta.mode() & 0o100 == 0 {
        bail!("{} is not a private executable of this user's", path.display());
    }
    if super::launch::digest(&mut file)? != digest {
        bail!("{} does not match the version it was installed as", path.display());
    }
    file.seek(SeekFrom::Start(0))?;
    Ok((file, (meta.dev(), meta.ino())))
}

/// Ask `binary` which records it reads, as `handover-formats` says.
fn ask(binary: &Path) -> Result<Value> {
    use std::io::Read;
    let mut child = std::process::Command::new(binary).arg(FORMATS_COMMAND)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .spawn().with_context(|| format!("run {}", binary.display()))?;
    let deadline = std::time::Instant::now() + ASK_WITHIN;
    let status = loop {
        if let Some(status) = child.try_wait()? { break status; }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{} did not say which handovers it reads within {} seconds", binary.display(), ASK_WITHIN.as_secs());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut out = String::new();
    child.stdout.take().context("no output")?.read_to_string(&mut out)?;
    if !status.success() {
        bail!("{} cannot take over a running runtime: it is from before handovers", binary.display());
    }
    serde_json::from_str(out.trim()).with_context(|| format!("{} answered what handovers it reads in a form this runtime cannot read", binary.display()))
}

/// The team that signed `binary`, as `codesign` reports it.
#[cfg(target_os = "macos")]
fn team(binary: &Path) -> Result<Option<String>> {
    let shown = std::process::Command::new("/usr/bin/codesign").args(["-dv", "--verbose=2"]).arg(binary).output()?;
    if !shown.status.success() { bail!("{} is not signed", binary.display()); }
    let text = String::from_utf8_lossy(&shown.stderr);
    Ok(text.lines().find_map(|line| line.strip_prefix("TeamIdentifier=")).map(str::trim).filter(|team| *team != "not set").map(str::to_owned))
}

/// `binary` passes a strict signature check, by the team that signed this
/// runtime when one did.
#[cfg(target_os = "macos")]
fn signed_alike(binary: &Path) -> Result<()> {
    let verified = std::process::Command::new("/usr/bin/codesign").args(["--verify", "--strict"]).arg(binary).output()?;
    if !verified.status.success() { bail!("{}'s code signature could not be verified", binary.display()); }
    let own = std::env::current_exe().context("locate this runtime")?;
    if let Some(expected) = team(&own)? {
        if team(binary)?.as_deref() != Some(expected.as_str()) {
            bail!("{} is not signed by the team that signed this runtime", binary.display());
        }
    }
    Ok(())
}

// --------------------------------------------------------------- the new side

/// Reap, as they exit, the children the runtime this process was left behind
/// that nothing here waits for (a probe or a `git` it was running): `kept`
/// are the ones a pane took over. Read before this runtime starts any child
/// of its own, so none of those is taken for one.
pub fn reap_strays(kept: &std::collections::HashSet<u32>) {
    // SAFETY: getpid has no preconditions.
    let own = unsafe { libc::getpid() };
    let strays: Vec<libc::pid_t> = super::launch::children(own).into_iter()
        .filter(|child| u32::try_from(*child).is_ok_and(|child| !kept.contains(&child))).collect();
    if strays.is_empty() { return; }
    log::info!("reaping {} process(es) the replaced runtime started and nothing here waits for", strays.len());
    let spawned = std::thread::Builder::new().name("handover-reaper".into()).spawn(move || {
        let mut strays = strays;
        while !strays.is_empty() {
            strays.retain(|stray| {
                let mut status = 0;
                // SAFETY: WNOHANG reaps this process's own child if it has
                // exited; one that is not its child any more answers -1.
                (unsafe { libc::waitpid(*stray, &mut status, libc::WNOHANG) }) == 0
            });
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    if let Err(error) = spawned { log::warn!("start the handover reaper: {error}"); }
}

/// A record read back by the runtime that takes over, with the descriptors
/// it names made this process's own again.
pub struct Adopted {
    pub record: Record,
    owner: Option<OwnedFd>,
    descriptors: HashMap<RawFd, OwnedFd>,
}

impl Adopted {
    /// The descriptor the record names as `fd`, once.
    pub fn take(&mut self, fd: RawFd) -> Result<OwnedFd> {
        self.descriptors.remove(&fd).with_context(|| format!("the handover record names descriptor {fd} twice or not at all"))
    }

    /// The data directory's ownership lock.
    pub fn owner(&mut self) -> Result<OwnedFd> {
        self.owner.take().context("the handover record's ownership lock was already taken")
    }
}

/// Read the record at `path`, written by the runtime this process was,
/// and remove it. Every descriptor it names is checked open and is closed
/// on exec again from here on, so no program this runtime starts inherits it.
pub fn read(path: &Path) -> Result<Adopted> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)
        .with_context(|| format!("open the handover record {}", path.display()))?;
    let meta = file.metadata()?;
    // SAFETY: geteuid has no preconditions.
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        bail!("the handover record is not a private file of this user's");
    }
    let record: Record = serde_json::from_reader(std::io::BufReader::new(file)).context("read the handover record")?;
    let _ = std::fs::remove_file(path);
    if !FORMATS.contains(&record.format) {
        bail!("the handover record is in format {}, which this runtime does not read", record.format);
    }
    if record.pid != std::process::id() {
        bail!("the handover record was written by process {}, not this one", record.pid);
    }
    let mut named: Vec<RawFd> = vec![record.control.own];
    named.extend(record.control.published.iter().flat_map(|(listener, lock)| [*listener, *lock]));
    named.extend(record.frames.iter().map(|frame| frame.fd));
    named.extend(record.decisions.iter().map(|decision| decision.fd));
    named.extend(record.panes.iter().map(|pane| pane.fd));
    let mut descriptors = HashMap::new();
    for fd in named.into_iter().chain([record.owner]) {
        if fd <= 2 || descriptors.contains_key(&fd) {
            bail!("the handover record names descriptor {fd} wrongly");
        }
        set_cloexec(fd, true).with_context(|| format!("take over descriptor {fd}"))?;
        // SAFETY: the record names a descriptor the runtime this process was
        // kept open for exactly this, and nothing else in this process owns it.
        descriptors.insert(fd, unsafe { OwnedFd::from_raw_fd(fd) });
    }
    let owner = descriptors.remove(&record.owner);
    Ok(Adopted { record, owner, descriptors })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_build_reads_the_format_it_writes_and_says_so() {
        assert!(FORMATS.contains(&FORMAT));
        let said = formats();
        assert_eq!(said["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(said["formats"], json!(FORMATS));
    }

    /// #765: a record in a format this build does not read is refused before
    /// any descriptor it names is touched.
    #[test]
    fn a_record_in_an_unknown_format_is_refused_untouched() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handover.json");
        let record = json!({ "format": 999, "from": "9.9.9", "pid": std::process::id(), "owner": 900,
            "control": { "socket": "/nowhere", "token": "t", "own": 901, "published": null } });
        std::fs::write(&path, record.to_string()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let error = read(&path).err().expect("an unknown format is refused");
        assert!(format!("{error:#}").contains("format 999"), "{error:#}");
    }

    #[test]
    fn a_record_another_process_wrote_or_others_can_read_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handover.json");
        let record = |pid: u32| json!({ "format": FORMAT, "from": "0.0.1", "pid": pid, "owner": 900,
            "control": { "socket": "/nowhere", "token": "t", "own": 901, "published": null } }).to_string();
        std::fs::write(&path, record(std::process::id())).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(format!("{:#}", read(&path).err().unwrap()).contains("private"));
        std::fs::write(&path, record(1)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(format!("{:#}", read(&path).err().unwrap()).contains("process 1"));
    }

    /// #765: only a runtime installed in this home, as the app installs one,
    /// may take this one's place.
    #[test]
    fn only_a_runtime_installed_in_this_home_is_handed_over_to() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let elsewhere = fixture.path().join("terminalx-serve");
        std::fs::write(&elsewhere, b"#!/bin/sh\n").unwrap();
        assert!(format!("{:#}", verify(&home, &elsewhere).err().unwrap()).contains("find this home's installed runtimes"));
        let installed = crate::local_runtime::launch::install(&elsewhere, &home).unwrap();
        // Installed, but tampered with since.
        std::fs::write(&installed, b"#!/bin/sh\necho changed\n").unwrap();
        assert!(format!("{:#}", verify(&home, &installed).err().unwrap()).contains("does not match"));
        assert!(verify(&home, &home.join("runtime/x/other")).is_err());
        // #765 review: the version's directory must be the home's own, not a
        // link to one elsewhere holding a binary of someone's choosing.
        let foreign = fixture.path().join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        std::fs::copy(&elsewhere, foreign.join("terminalx-serve")).unwrap();
        let linked = home.join("runtime").join("linked");
        std::os::unix::fs::symlink(&foreign, &linked).unwrap();
        assert!(format!("{:#}", verify(&home, &linked.join("terminalx-serve")).err().unwrap()).contains("not a private directory"));
    }
}
