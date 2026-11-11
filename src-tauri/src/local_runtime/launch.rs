//! Install an immutable helper outside the replaceable app bundle, then
//! discover or launch it. A window's Child handle never owns runtime lifetime.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

use super::client::Client;

fn private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let meta = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        bail!("runtime installation directory is not private");
    }
    Ok(())
}

pub(crate) fn digest(file: &mut File) -> Result<String> {
    let mut sha = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        sha.update(&buffer[..count]);
    }
    Ok(format!("{:x}", sha.finalize()))
}

fn open_binary(path: &Path) -> Result<File> {
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    if !file.metadata()?.is_file() { bail!("runtime executable is not a regular file"); }
    Ok(file)
}

/// Copy only the bundled helper supplied by the native launcher. Hashing the
/// whole executable makes versions coexist even when their app version matches.
pub fn install(source: &Path, home: &Path) -> Result<PathBuf> {
    use std::io::{Seek, SeekFrom};
    let mut input = open_binary(source).context("open bundled terminalx-serve")?;
    let hash = digest(&mut input)?;
    input.seek(SeekFrom::Start(0))?;
    private_dir(&home.join("runtime"))?;
    let directory = home.join("runtime").join(&hash);
    private_dir(&directory)?;
    let target = directory.join("terminalx-serve");
    if target.symlink_metadata().is_ok() {
        let mut existing = open_binary(&target)?;
        let meta = existing.metadata()?;
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 || meta.mode() & 0o100 == 0
            || digest(&mut existing)? != hash {
            bail!("installed runtime does not match its immutable version");
        }
        return Ok(target);
    }
    let mut staged = tempfile::NamedTempFile::new_in(&directory)?;
    std::io::copy(&mut input, &mut staged)?;
    staged.flush()?;
    staged.as_file_mut().seek(SeekFrom::Start(0))?;
    if digest(staged.as_file_mut())? != hash { bail!("bundled runtime changed while it was installed"); }
    staged.as_file().set_permissions(std::fs::Permissions::from_mode(0o700))?;
    staged.as_file().sync_all()?;
    match staged.persist_noclobber(&target) {
        Ok(_) => { File::open(&directory)?.sync_all()?; }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if digest(&mut open_binary(&target)?)? != hash { bail!("another install wrote an unexpected runtime"); }
        }
        Err(error) => return Err(error.error.into()),
    }
    Ok(target)
}

/// The bundled helper, installed in `home` ([`install`]) and checked to be
/// signed: what a runtime is started from, or handed over to (#765).
pub fn installed(source: &Path, home: &Path) -> Result<PathBuf> {
    let executable = install(source, home)?;
    #[cfg(target_os = "macos")]
    {
        let verified = Command::new("/usr/bin/codesign").args(["--verify", "--strict"]).arg(&executable).output()?;
        if !verified.status.success() { bail!("the installed runtime's code signature could not be verified"); }
    }
    Ok(executable)
}

pub fn connect_or_start(source: &Path, home: &Path) -> Result<Arc<Client>> {
    launch(source,home,None,None)
}

/// `log` is where a runtime started here keeps its log, rotated by the
/// runtime itself. Discarding it left a wedged runtime with no account (#661).
pub fn connect_desktop(source: &Path, home: &Path, application: &str, log: Option<&Path>) -> Result<Arc<Client>> {
    let client = launch(source,home,Some(application),log)?;
    let status = client.liveness(super::client::LIFECYCLE_TIMEOUT)?;
    if cfg!(target_os = "macos") && status["localRuntime"]["nativeTray"] != true {
        return Err(super::client::Blocked("The running local owner does not support the desktop tray. Its work was left running; attach with a compatible build after it finishes.".into()).into());
    }
    Ok(client)
}

/// Hold the home's launch lock, which serializes launchers, not runtimes:
/// the runtime owns its separate lock. Released when the file is dropped.
fn launch_lock(home: &Path, deadline: Instant) -> Result<File> {
    use std::os::fd::AsRawFd;
    let launch = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(home.join("run/local-launch.lock"))?;
    let metadata = launch.metadata()?;
    // SAFETY: geteuid has no preconditions.
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
        bail!("local launch lock is not private");
    }
    loop {
        // SAFETY: descriptor remains owned by `launch` until it is returned.
        if unsafe { libc::flock(launch.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { return Ok(launch); }
        if Instant::now() >= deadline { bail!("another desktop is starting the local runtime"); }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn launch(source: &Path, home: &Path, application: Option<&str>, log: Option<&Path>) -> Result<Arc<Client>> {
    let home = std::fs::canonicalize(home)?;
    private_dir(&home.join("run"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let _launch = launch_lock(&home, deadline)?;
    // A live but incompatible owner is an error, never permission to start a
    // competing process or terminate the running owner's work.
    if std::os::unix::net::UnixStream::connect(home.join("run/hooks.sock")).is_ok() {
        return Client::connect(&home);
    }
    let executable = installed(source, &home)?;
    let mut command = Command::new(executable);
    if let Some(application) = application {
        command.env("TERMINALX_LOCAL_DESKTOP","1").env("TERMINALX_LOCAL_APPLICATION",application);
    } else {
        command.env_remove("TERMINALX_LOCAL_DESKTOP").env_remove("TERMINALX_LOCAL_APPLICATION");
    }
    command.args(["--runtime-kind", "local", "--data-dir"]).arg(&home).stdin(Stdio::null());
    // The runtime takes the log over once it starts; until then, whatever it
    // prints (an argument it refuses) goes there too.
    match log.map(|log| -> Result<(File, File)> {
        if let Some(parent) = log.parent() { std::fs::create_dir_all(parent)?; }
        let file = super::log_file::open(log)?;
        Ok((file.try_clone()?, file))
    }) {
        Some(Ok((stdout, stderr))) => { command.arg("--log-file").arg(log.expect("opened")).stdout(stdout).stderr(stderr); }
        Some(Err(error)) => {
            log::warn!("local runtime log: {error:#}");
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        None => { command.stdout(Stdio::null()).stderr(Stdio::null()); }
    }
    // SAFETY: setsid is async-signal-safe and this hook only creates an OS
    // session. No allocator, lock or inherited window pipe is used after fork.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()); }
            Ok(())
        });
    }
    // Where this start's own lines begin, so a failure reports its error
    // and not an earlier runtime's.
    let since = log.and_then(|log| std::fs::metadata(log).ok()).map_or(0, |metadata| metadata.len());
    let started = Instant::now();
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(StartFailed::new(None, Duration::ZERO, Some(format!("start local runtime: {error}")), log.map(Path::to_path_buf)).into()),
    };
    attachment(child, &home, deadline, started, log.map(|log| (log, since)))
}

/// Wait for runtime `child`, started at `started`, to take connections in
/// `home`. One that exits first is a [`StartFailed`]: how it ended, and the
/// error it logged from offset `since` of its log (PRO-287).
fn attachment(mut child: std::process::Child, home: &Path, deadline: Instant, started: Instant, log: Option<(&Path, u64)>) -> Result<Arc<Client>> {
    loop {
        if let Ok(client) = Client::connect(home) {
            std::thread::spawn(move || { let _ = child.wait(); });
            return Ok(client);
        }
        if let Some(status) = child.try_wait()? {
            let error = log.and_then(|(log, since)| logged_error(log, since));
            return Err(StartFailed::new(Some(status), started.elapsed(), error, log.map(|(log, _)| log.to_path_buf())).into());
        }
        if Instant::now() >= deadline {
            // Do not kill on timeout: the runtime may already own accepted
            // work. With no attachments or work it exits by its idle policy.
            std::thread::spawn(move || { let _ = child.wait(); });
            bail!("local runtime did not become ready; it was not stopped");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The runtime's executable, as a failure names it.
pub const PROCESS: &str = "terminalx-serve";

/// A runtime this desktop started that exited, or never ran, before it took
/// a connection (PRO-287): what a window shows in place of reconnecting,
/// since trying again starts the same runtime that just failed. Carried as
/// fields, never parsed back out of a message.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartFailed {
    /// The executable that was started.
    pub process: String,
    /// Its exit code, when it exited.
    pub code: Option<i32>,
    /// The signal that ended it, when one did. With no code either, it never ran.
    pub signal: Option<i32>,
    /// How long it ran, in milliseconds.
    pub ran_ms: u64,
    /// The last error it logged while starting, or why it could not be started.
    pub error: Option<String>,
    /// Where its log is, when it has one.
    pub log: Option<PathBuf>,
    /// When it failed, in milliseconds since the Unix epoch.
    pub at: i64,
    /// This app's version.
    pub app: String,
    /// The OS it ran on, as "macOS 26.1 (25B78)", when it could be read.
    pub os: Option<String>,
}

impl StartFailed {
    fn new(status: Option<std::process::ExitStatus>, ran: Duration, error: Option<String>, log: Option<PathBuf>) -> Self {
        use std::os::unix::process::ExitStatusExt;
        Self {
            process: PROCESS.into(),
            code: status.and_then(|status| status.code()),
            signal: status.and_then(|status| status.signal()),
            ran_ms: ran.as_millis().try_into().unwrap_or(u64::MAX),
            error, log,
            at: chrono::Utc::now().timestamp_millis(),
            app: env!("CARGO_PKG_VERSION").into(),
            os: crate::startup::os_label(),
        }
    }

    /// How it ended: "exited with code 78 after 0.4 s".
    pub fn ended(&self) -> String {
        let ran = super::log_file::span(Duration::from_millis(self.ran_ms));
        match (self.code, self.signal) {
            (Some(code), _) => format!("{} exited with code {code} after {ran}", self.process),
            (None, Some(signal)) => format!("{} was ended by signal {signal} after {ran}", self.process),
            (None, None) => format!("{} could not be started", self.process),
        }
    }
}

impl std::fmt::Display for StartFailed {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "local runtime failed before attachment: {}", self.ended())?;
        if let Some(error) = &self.error { write!(out, ": {error}")?; }
        Ok(())
    }
}

impl std::error::Error for StartFailed {}

/// How much of a failed start's log is read for its error.
const LOGGED_TAIL: u64 = 64 * 1024;

/// The error runtime start logged in `log` from offset `since`: its last
/// error record, or failing that its last line of output (a panic's message,
/// an argument it refused). A log that was started afresh in the meantime is
/// read from its beginning.
fn logged_error(log: &Path, since: u64) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut file = File::open(log).ok()?;
    let length = file.metadata().ok()?.len();
    let from = if since > length { 0 } else { since.max(length.saturating_sub(LOGGED_TAIL)) };
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    error_line(&String::from_utf8_lossy(&bytes))
}

/// The line of `text`, a runtime's log, that says why it stopped (see
/// [`logged_error`]), without its record's time, level and module.
fn error_line(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    // "[2026-11-11T09:13:45Z ERROR raccoon_lib::serve] terminalx-serve: …"
    let record = |line: &str| line.strip_prefix('[').and_then(|rest| rest.split_once("] ")).map(|(head, message)| (head.to_owned(), message.to_owned()));
    if let Some(message) = lines.iter().rev().filter_map(|line| record(line)).find(|(head, _)| head.split_whitespace().nth(1) == Some("ERROR")).map(|(_, message)| message) {
        return Some(message);
    }
    // Not a record: what it printed itself. A panic ends with a note on how to see more.
    lines.iter().rev().find(|line| record(line).is_none() && !line.starts_with("note: ")).map(|line| (*line).to_owned())
}

/// Stop the runtime that holds `home` without asking it, for one that has
/// stopped answering (#661). Only a process running a runtime installed in
/// this home is signalled, and with it the processes it started: their
/// terminals close with it, and an agent left running would hold on to the
/// conversation the next runtime resumes. `false` when no runtime was running.
pub fn kill_owner(home: &Path) -> Result<bool> {
    kill_holder(home, None)
}

/// [`kill_owner`], of process `expected` only when it is given: a runtime
/// that started in its place in the meantime is left alone.
fn kill_holder(home: &Path, expected: Option<libc::pid_t>) -> Result<bool> {
    let home = std::fs::canonicalize(home)?;
    let _launch = launch_lock(&home, Instant::now() + Duration::from_secs(30))?;
    let socket = home.join("run/hooks.sock");
    let Some(pid) = listener(&socket) else { return Ok(false) };
    if expected.is_some_and(|expected| expected != pid) { return Ok(false); }
    owned_runtime(&home, pid)?;
    log::warn!("stopping the local runtime (pid {pid}) without asking it");
    let children = children(pid);
    // The runtime leads its own group (it calls setsid), which holds every
    // helper it started without a terminal of its own.
    // SAFETY: getpgid only reads the process table.
    let group = unsafe { libc::getpgid(pid) } == pid;
    let signal = |sig| {
        // SAFETY: the pid was just identified as this home's runtime.
        unsafe { libc::kill(if group { -pid } else { pid }, sig) };
    };
    signal(libc::SIGTERM);
    if !exited(pid, &socket, Duration::from_secs(3)) {
        signal(libc::SIGKILL);
        if !exited(pid, &socket, Duration::from_secs(5)) { bail!("The local runtime (pid {pid}) did not exit."); }
    }
    // Each terminal leads a session of its own. Its program had the terminal
    // hung up on it; one that ignored that is ended here.
    // SAFETY: a negative pid names the group that child leads, if it leads one.
    for child in &children { unsafe { libc::kill(-child, libc::SIGTERM) }; }
    let deadline = Instant::now() + Duration::from_secs(1);
    // SAFETY: signal zero only checks that the group still exists.
    while Instant::now() < deadline && children.iter().any(|child| unsafe { libc::kill(-child, 0) } == 0) {
        std::thread::sleep(Duration::from_millis(50));
    }
    // SAFETY: as above.
    for child in &children { unsafe { libc::kill(-child, libc::SIGKILL) }; }
    Ok(true)
}

/// Check that `pid` runs a runtime installed in `home`, and so is one to stop.
fn owned_runtime(home: &Path, pid: libc::pid_t) -> Result<()> {
    let executable = executable(pid).context("identify the process holding the runtime socket")?;
    if executable.parent().and_then(Path::parent) != Some(home.join("runtime").as_path())
        || executable.file_name() != Some(std::ffi::OsStr::new("terminalx-serve")) {
        bail!("The process holding the runtime socket ({}) is not a TerminalX runtime of this home; it was left running.", executable.display());
    }
    Ok(())
}

/// How long a runtime that has stopped its work may take to exit.
const EXIT_AFTER_STOP: Duration = Duration::from_secs(30);

/// When a runtime that was asked to stop and did not may be stopped without
/// asking, as [`kill_owner`] does, with its terminals and what they run.
pub enum Fallback<'a> {
    /// Restart now, or a runtime that stopped answering: whatever it runs
    /// stops with it.
    Forced,
    /// The desktop replacing it by itself (#730): only once it agreed to
    /// stop, as `stopping` says, and so refuses any new work.
    Agreed(&'a dyn Fn() -> bool),
}

/// The runtime was left running, and nothing of it was stopped.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct LeftRunning(pub &'static str);

/// Whether `error` says the runtime was left running, nothing of it stopped.
pub fn left_running(error: &anyhow::Error) -> bool { error.downcast_ref::<LeftRunning>().is_some() }

/// Stop the runtime holding `home` the way quitting with Stop All does, and
/// wait until it has gone, so the next attachment starts the bundled runtime
/// in its place (#730). `stop_all` asks the runtime this desktop attached to,
/// pinned to it: one that has been replaced since refuses, and is left alone,
/// as is one that refuses for work under way (`runtime_busy`). One that agreed
/// to stop and does not exit after it is stopped without asking; one that did
/// not agree only as `fallback` allows. Either way each agent picks up its
/// conversation again when its tab next starts. An error that left the
/// runtime running says so ([`left_running`]).
pub fn retire(home: &Path, stop_all: impl FnOnce() -> Result<()>, fallback: Fallback<'_>) -> Result<()> {
    retire_within(home, stop_all, fallback, EXIT_AFTER_STOP)
}

fn retire_within(home: &Path, stop_all: impl FnOnce() -> Result<()>, fallback: Fallback<'_>, exit_after_stop: Duration) -> Result<()> {
    let home = std::fs::canonicalize(home)?;
    let socket = home.join("run/hooks.sock");
    let Some(pid) = listener(&socket) else { return Ok(()) };
    owned_runtime(&home, pid).map_err(|error| error.context(LeftRunning("The process holding the runtime socket was left running.")))?;
    log::info!("stopping the local runtime (pid {pid}) so the one bundled with this app takes its place");
    match stop_all() {
        // It agreed: one that lingers is stopped without asking.
        Ok(()) => if exited(pid, &socket, exit_after_stop) { return Ok(()); }
        Err(error) if refused(&error, "runtime_restarted") => {
            return Err(error.context(LeftRunning("The TerminalX runtime was replaced before it could be stopped; nothing was stopped.")));
        }
        Err(error) if refused(&error, "runtime_busy") => {
            return Err(error.context(LeftRunning("The TerminalX runtime has work under way; nothing was stopped.")));
        }
        Err(error) => match fallback {
            Fallback::Forced => log::warn!("the local runtime did not stop its work when asked ({error:#}); stopping it without asking"),
            Fallback::Agreed(stopping) if stopping() => {
                log::warn!("the local runtime agreed to stop but did not finish ({error:#}); stopping it without asking");
            }
            Fallback::Agreed(_) => {
                return Err(error.context(LeftRunning("The TerminalX runtime did not agree to stop; nothing was stopped.")));
            }
        },
    }
    kill_holder(&home, Some(pid))?;
    if !exited(pid, &socket, Duration::ZERO) { bail!("The TerminalX runtime (pid {pid}) did not exit."); }
    Ok(())
}

/// Wait until the runtime that replaced runtime `epoch` in its own process
/// answers on `home`'s socket (#765): the same process, under another epoch.
pub fn taken_over(home: &Path, epoch: &str, within: Duration) -> Result<()> {
    let deadline = Instant::now() + within;
    let socket = home.join("run/hooks.sock");
    let pid = listener(&socket);
    loop {
        match Client::connect(home) {
            Ok(client) if client.epoch() != epoch => {
                let now = listener(&socket);
                if pid.is_some() && now != pid {
                    bail!("another runtime took the socket while the TerminalX runtime was being handed over");
                }
                return Ok(());
            }
            Ok(_) => {}
            Err(error) if Instant::now() >= deadline => {
                return Err(error.context("the updated TerminalX runtime did not answer after the handover"));
            }
            Err(_) => {}
        }
        if Instant::now() >= deadline { bail!("the TerminalX runtime did not hand over within {} seconds", within.as_secs()); }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Whether the runtime refused with `code`, anywhere in `error`'s chain.
pub fn refused(error: &anyhow::Error, code: &str) -> bool {
    error.chain().any(|cause| cause.downcast_ref::<super::client::Refused>().is_some_and(|refused| refused.code == code))
}

/// Whether the runtime has gone: its pid no longer exists, or nothing
/// listens on its socket any more (it may be exiting, or not yet reaped).
fn exited(pid: libc::pid_t, socket: &Path, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        // SAFETY: signal zero only checks that the process exists.
        let gone = unsafe { libc::kill(pid, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        if gone || listener(socket).is_none_or(|holder| holder != pid) { return true; }
        if Instant::now() >= deadline { return false; }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The process listening on `socket`, as the kernel records it.
fn listener(socket: &Path) -> Option<libc::pid_t> {
    use std::os::fd::AsRawFd;
    let stream = std::os::unix::net::UnixStream::connect(socket).ok()?;
    #[cfg(target_os = "macos")]
    {
        let mut pid: libc::pid_t = 0;
        let mut size = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        // SAFETY: LOCAL_PEERPID writes one pid_t into the buffer it is given.
        let read = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut size) };
        (read == 0 && pid > 0).then_some(pid)
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: an all-zero ucred is valid, and SO_PEERCRED fills exactly one.
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: as above.
        let read = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut credentials as *mut libc::ucred).cast(), &mut size) };
        (read == 0 && credentials.pid > 0).then_some(credentials.pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = stream.as_raw_fd();
        None
    }
}

/// The executable a process is running.
pub(crate) fn executable(pid: libc::pid_t) -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: proc_pidpath writes at most the buffer's size.
        let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if length <= 0 { return Err(std::io::Error::last_os_error().into()); }
        path.truncate(length as usize);
        Ok(PathBuf::from(<std::ffi::OsString as std::os::unix::ffi::OsStringExt>::from_vec(path)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(std::fs::read_link(format!("/proc/{pid}/exe"))?)
    }
}

/// The processes `pid` started that are still its children.
pub(crate) fn children(pid: libc::pid_t) -> Vec<libc::pid_t> {
    #[cfg(target_os = "macos")]
    {
        let mut pids = vec![0 as libc::pid_t; 4096];
        // SAFETY: the buffer's byte size is passed; the count returned fits it.
        let count = unsafe { libc::proc_listchildpids(pid, pids.as_mut_ptr().cast(), (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int) };
        pids.truncate(count.clamp(0, 4096) as usize);
        pids.retain(|child| *child > 0);
        pids
    }
    #[cfg(not(target_os = "macos"))]
    {
        let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
        entries.flatten().filter_map(|entry| {
            let child: libc::pid_t = entry.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            // The parent is the second field after the parenthesised name.
            let parent: libc::pid_t = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()?;
            (parent == pid).then_some(child)
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_versions_survive_bundle_replacement_and_reject_tampering() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let source = fixture.path().join("bundled-helper");
        std::fs::write(&source, b"first helper image").unwrap();
        let first = install(&source, &home).unwrap();
        assert_eq!(install(&source, &home).unwrap(), first);
        std::fs::write(&source, b"updated helper image").unwrap();
        let second = install(&source, &home).unwrap();
        assert_ne!(first, second);
        std::fs::remove_file(&source).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"first helper image");
        assert_eq!(std::fs::read(&second).unwrap(), b"updated helper image");
        assert_eq!(std::fs::metadata(&first).unwrap().mode() & 0o777, 0o700);
        std::fs::write(&source, b"first helper image").unwrap();
        std::fs::write(&first, b"tampered helper").unwrap();
        assert!(install(&source, &home).is_err());
    }

    /// PRO-287: a runtime that exits while starting is reported with its
    /// exit code, how long it ran, and the error it logged in this start,
    /// not an earlier one's.
    #[test]
    fn a_runtime_that_exits_while_starting_reports_its_exit_code_and_error() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir_all(home.join("run")).unwrap();
        let log = fixture.path().join("runtime.log");
        std::fs::write(&log, "[2026-11-10T08:00:00Z ERROR raccoon_lib::serve] terminalx-serve: an earlier start's failure\n").unwrap();
        let since = std::fs::metadata(&log).unwrap().len();
        let script = format!(
            "printf '%s\\n' '[2026-11-11T09:41:12Z INFO  raccoon_lib::serve] starting' \
             '[2026-11-11T09:41:12Z ERROR raccoon_lib::serve] terminalx-serve: open the state directory: Permission denied (os error 13)' \
             '[2026-11-11T09:41:12Z INFO  raccoon_lib::serve] shutting down' >> '{}'; exit 78", log.display());
        let started = Instant::now();
        let child = Command::new("/bin/sh").args(["-c", &script]).spawn().unwrap();
        let error = attachment(child, &home, Instant::now() + Duration::from_secs(10), started, Some((&log, since))).err().expect("it exited");
        let failed = error.downcast_ref::<StartFailed>().expect("a structured start failure");
        assert_eq!((failed.code, failed.signal), (Some(78), None));
        assert_eq!(failed.error.as_deref(), Some("terminalx-serve: open the state directory: Permission denied (os error 13)"));
        assert_eq!(failed.log.as_deref(), Some(log.as_path()));
        assert_eq!(failed.process, "terminalx-serve");
        assert_eq!(failed.app, env!("CARGO_PKG_VERSION"));
        assert!(failed.ran_ms < 10_000);
        assert!(failed.ended().starts_with("terminalx-serve exited with code 78 after "), "{}", failed.ended());
        assert!(error.to_string().contains("Permission denied"), "the log line says it too: {error}");
        if cfg!(target_os = "macos") { assert!(failed.os.as_deref().is_some_and(|os| os.starts_with("macOS ")), "{:?}", failed.os); }
    }

    #[test]
    fn a_runtime_ended_by_a_signal_while_starting_says_which() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir_all(home.join("run")).unwrap();
        let child = Command::new("/bin/sh").args(["-c", "kill -9 $$"]).spawn().unwrap();
        let error = attachment(child, &home, Instant::now() + Duration::from_secs(10), Instant::now(), None).err().expect("it was killed");
        let failed = error.downcast_ref::<StartFailed>().unwrap();
        assert_eq!((failed.code, failed.signal, failed.error.as_deref(), failed.log.as_deref()), (None, Some(9), None, None));
        assert!(failed.ended().starts_with("terminalx-serve was ended by signal 9 after "));
    }

    /// The error a failed start logged: its last error record, without the
    /// record's time, level and module; else what it printed itself.
    #[test]
    fn a_failed_start_is_told_by_its_last_error_or_what_it_printed() {
        let records = "[2026-11-11T09:41:12Z ERROR raccoon_lib::a] first\n[2026-11-11T09:41:12Z ERROR raccoon_lib::serve] terminalx-serve: second\n[2026-11-11T09:41:13Z INFO  raccoon_lib::serve] after\n";
        assert_eq!(error_line(records).as_deref(), Some("terminalx-serve: second"));
        let panic = "thread 'main' panicked at src/serve.rs:12:5:\nthe socket path is too long\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n";
        assert_eq!(error_line(panic).as_deref(), Some("the socket path is too long"));
        assert_eq!(error_line("terminalx-serve: unknown argument --bogus\n").as_deref(), Some("terminalx-serve: unknown argument --bogus"));
        assert_eq!(error_line("[2026-11-11T09:41:12Z INFO  raccoon_lib::serve] only records, none an error\n"), None);
        assert_eq!(error_line(""), None);
    }

    #[test]
    fn installer_refuses_symlinks_and_shared_directories() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let source = fixture.path().join("helper");
        std::fs::write(&source, b"helper image").unwrap();
        let linked = fixture.path().join("linked-helper");
        std::os::unix::fs::symlink(&source, &linked).unwrap();
        assert!(install(&linked, &home).is_err());
        let outside = fixture.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("runtime")).unwrap();
        assert!(install(&source, &home).is_err());
        std::fs::remove_file(home.join("runtime")).unwrap();
        std::fs::create_dir(home.join("runtime")).unwrap();
        std::fs::set_permissions(home.join("runtime"), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(install(&source, &home).is_err());
    }

    const OWNER_HOME: &str = "TERMINALX_TEST_UNRESPONSIVE_OWNER_HOME";

    /// A runtime that holds its socket and never answers, as one wedged
    /// behind a lock does, with a terminal of its own in its own session.
    #[test]
    fn unresponsive_owner_child() {
        use std::os::unix::net::UnixListener;
        let Some(home) = std::env::var_os(OWNER_HOME).map(PathBuf::from) else { return };
        let _listener = UnixListener::bind(home.join("run/hooks.sock")).unwrap();
        let mut terminal = Command::new("/bin/sleep");
        terminal.arg("600");
        // SAFETY: setsid is async-signal-safe.
        unsafe { terminal.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
        let mut terminal = terminal.spawn().unwrap();
        std::fs::write(home.join("terminal.pid"), terminal.id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(600));
        let _ = terminal.kill();
        let _ = terminal.wait();
    }

    /// Start `executable` as the wedged owner of a fresh home, and wait until
    /// it holds the socket. Returns the home, the owner and its terminal's pid.
    fn wedged_owner(fixture: &Path, executable: impl Fn(&Path) -> PathBuf) -> (PathBuf, std::process::Child, libc::pid_t) {
        let home = fixture.join("home");
        std::fs::create_dir(&home).unwrap();
        private_dir(&home.join("run")).unwrap();
        let mut owner = Command::new(executable(&home));
        owner.args(["--exact", "local_runtime::launch::tests::unresponsive_owner_child", "--nocapture"])
            .env(OWNER_HOME, &home).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // SAFETY: as the launcher does: the owner leads a session of its own.
        unsafe { owner.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
        let mut owner = owner.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let terminal = loop {
            if let Ok(pid) = std::fs::read_to_string(home.join("terminal.pid")) { break pid.parse().unwrap(); }
            if Instant::now() >= deadline || owner.try_wait().unwrap().is_some() {
                let _ = owner.kill();
                panic!("the fixture owner never held its socket");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        (std::fs::canonicalize(home).unwrap(), owner, terminal)
    }

    fn running(pid: libc::pid_t) -> bool {
        // SAFETY: signal zero only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn an_unresponsive_owner_is_stopped_with_the_terminals_it_started() {
        let fixture = tempfile::tempdir().unwrap();
        let (home, mut owner, terminal) = wedged_owner(fixture.path(), |home| {
            // Installed as the launcher installs a runtime, so it is one of this home's.
            let installed = home.join("runtime/fixture");
            std::fs::create_dir_all(&installed).unwrap();
            let installed = installed.join("terminalx-serve");
            std::fs::copy(std::env::current_exe().unwrap(), &installed).unwrap();
            installed
        });
        assert_eq!(listener(&home.join("run/hooks.sock")), Some(owner.id() as libc::pid_t));
        assert!(kill_owner(&home).unwrap());
        let deadline = Instant::now() + Duration::from_secs(10);
        while owner.try_wait().unwrap().is_none() || running(terminal) {
            assert!(Instant::now() < deadline, "the owner or its terminal outlived the restart");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!kill_owner(&home).unwrap(), "nothing is left to stop");
    }

    fn installed_owner(fixture: &Path) -> (PathBuf, std::process::Child, libc::pid_t) {
        wedged_owner(fixture, |home| {
            let installed = home.join("runtime/fixture");
            std::fs::create_dir_all(&installed).unwrap();
            let installed = installed.join("terminalx-serve");
            std::fs::copy(std::env::current_exe().unwrap(), &installed).unwrap();
            installed
        })
    }

    fn reap(mut owner: std::process::Child, terminal: libc::pid_t) {
        let _ = owner.kill();
        let _ = owner.wait();
        // SAFETY: the fixture's own terminal session.
        unsafe { libc::kill(-terminal, libc::SIGKILL) };
    }

    /// #730: a runtime that stops its work and exits when asked is not
    /// stopped any other way.
    #[test]
    fn retiring_a_runtime_that_stops_when_asked_waits_for_it_to_exit() {
        let fixture = tempfile::tempdir().unwrap();
        let (home, owner, terminal) = installed_owner(fixture.path());
        let owner = std::sync::Mutex::new(owner);
        let asked = std::cell::Cell::new(false);
        retire_within(&home, || {
            asked.set(true);
            // As a runtime does once it has stopped its agents: it exits.
            let mut owner = owner.lock().unwrap();
            owner.kill().unwrap();
            owner.wait().unwrap();
            Ok(())
        }, Fallback::Agreed(&|| panic!("it stopped when asked")), Duration::from_secs(10)).unwrap();
        assert!(asked.get());
        assert!(running(terminal), "a runtime asked to stop closes its own terminals; nothing else was signalled");
        reap(owner.into_inner().unwrap(), terminal);
    }

    /// #730: a runtime that agreed to stop and does not exit, or did not stop
    /// when Restart now asked, or agreed and could not finish, is stopped
    /// without asking, with its terminals.
    #[test]
    fn a_runtime_that_does_not_stop_when_asked_is_stopped_without_asking() {
        for answer in ["never exits", "refuses, forced", "agreed, then failed"] {
            let fixture = tempfile::tempdir().unwrap();
            let (home, mut owner, terminal) = installed_owner(fixture.path());
            let stop = || if answer == "never exits" { Ok(()) } else { anyhow::bail!("timed out") };
            let agreed = || true;
            let fallback = match answer { "refuses, forced" => Fallback::Forced, _ => Fallback::Agreed(&agreed) };
            retire_within(&home, stop, fallback, Duration::from_millis(300)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while owner.try_wait().unwrap().is_none() || running(terminal) {
                assert!(Instant::now() < deadline, "{answer}: the owner or its terminal outlived the switch");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    /// #730: the desktop's stop is pinned to the runtime it saw. One replaced
    /// in the meantime refuses it, and is not stopped any other way either.
    #[test]
    fn a_runtime_replaced_before_it_was_retired_is_left_running() {
        let fixture = tempfile::tempdir().unwrap();
        let (home, mut owner, terminal) = installed_owner(fixture.path());
        let replaced = || Err(super::super::client::Refused { code: "runtime_restarted".into(), message: "Refresh runtime status before stopping all work.".into() }.into());
        let error = retire_within(&home, replaced, Fallback::Forced, Duration::from_millis(300)).unwrap_err();
        assert!(error.to_string().contains("replaced") && refused(&error, "runtime_restarted") && left_running(&error), "{error:#}");
        assert!(owner.try_wait().unwrap().is_none() && running(terminal));
        // Nor one that refuses for work under way.
        let busy = || Err(super::super::client::Refused { code: "runtime_busy".into(), message: "an agent is mid-turn".into() }.into());
        let error = retire_within(&home, busy, Fallback::Forced, Duration::from_millis(300)).unwrap_err();
        assert!(error.to_string().contains("work under way") && refused(&error, "runtime_busy") && left_running(&error), "{error:#}");
        assert!(owner.try_wait().unwrap().is_none() && running(terminal));
        // #730 review: replacing it by itself, any other failure before it
        // agreed to stop (a re-read that failed, a timeout, no free request
        // place) leaves it running too.
        for failure in ["could not read what it runs", "busy"] {
            let stop = || if failure == "busy" {
                Err(super::super::client::Refused { code: "busy".into(), message: "Too many requests.".into() }.into())
            } else { anyhow::bail!("{failure}") };
            let error = retire_within(&home, stop, Fallback::Agreed(&|| false), Duration::from_millis(300)).unwrap_err();
            assert!(left_running(&error) && format!("{error:#}").contains("did not agree to stop"), "{error:#}");
            assert!(owner.try_wait().unwrap().is_none() && running(terminal), "{failure}: nothing was stopped");
        }
        reap(owner, terminal);

        // Nor is a socket held by anything but this home's runtime touched.
        let fixture = tempfile::tempdir().unwrap();
        let (home, mut owner, terminal) = wedged_owner(fixture.path(), |_| std::env::current_exe().unwrap());
        let error = retire_within(&home, || panic!("a stranger is never asked"), Fallback::Forced, Duration::ZERO).unwrap_err();
        assert!(format!("{error:#}").contains("not a TerminalX runtime") && left_running(&error), "{error:#}");
        assert!(owner.try_wait().unwrap().is_none() && running(terminal));
        reap(owner, terminal);
        // With no runtime at all there is nothing to do.
        assert!(retire_within(&home, || panic!("nothing to ask"), Fallback::Forced, Duration::ZERO).is_ok());
    }

    #[test]
    fn a_socket_held_by_anything_but_this_homes_runtime_is_left_alone() {
        let fixture = tempfile::tempdir().unwrap();
        let (home, mut owner, terminal) = wedged_owner(fixture.path(), |_| std::env::current_exe().unwrap());
        let error = kill_owner(&home).unwrap_err();
        assert!(error.to_string().contains("not a TerminalX runtime"), "{error:#}");
        assert!(owner.try_wait().unwrap().is_none() && running(terminal));
        owner.kill().unwrap();
        owner.wait().unwrap();
        // SAFETY: the fixture's own terminal session.
        unsafe { libc::kill(-terminal, libc::SIGKILL) };
    }
}
