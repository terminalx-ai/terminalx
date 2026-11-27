//! Process resources for a single Linux workspace desktop. Its caller must
//! authorize the attachment before starting or opening a desktop connection.
//! RFB runs over an inherited loopback socket per attachment, with no persistent VNC listener.

use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const START_TIMEOUT: Duration = Duration::from_secs(8);
const STARTUP_GRACE: Duration = Duration::from_secs(1);
const HEALTH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub(crate) enum DesktopError {
    #[error("Not available in this workspace image")]
    MissingTools,
    #[error("Could not start the cloud desktop")]
    StartupFailed,
    #[error("Chrome could not start in this workspace image")]
    ChromeStartupFailed,
    #[error("Cloud desktop access changed before open")]
    AccessChanged,
}

impl From<io::Error> for DesktopError {
    fn from(_: io::Error) -> Self {
        Self::StartupFailed
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DesktopAccess {
    Watch,
    Control,
}

struct Tools {
    xvfb: PathBuf,
    xauth: PathBuf,
    window_manager: PathBuf,
    vnc: PathBuf,
    chrome: PathBuf,
    /// Optional: a desktop without one still serves Chrome.
    terminal: Option<PathBuf>,
}

fn executable(dirs: &[&str], names: &[&str]) -> Result<PathBuf, DesktopError> {
    names
        .iter()
        .flat_map(|name| dirs.iter().map(move |dir| Path::new(dir).join(name)))
        .find(|path| {
            path.metadata()
                .is_ok_and(|file| file.is_file() && file.permissions().mode() & 0o111 != 0)
        })
        .ok_or(DesktopError::MissingTools)
}

impl Tools {
    fn discover(dirs: &[&str]) -> Result<Self, DesktopError> {
        Ok(Self {
            xvfb: executable(dirs, &["Xvfb"])?,
            xauth: executable(dirs, &["xauth"])?,
            window_manager: executable(dirs, &["openbox", "fluxbox"])?,
            vnc: executable(dirs, &["x11vnc"])?,
            chrome: executable(dirs, &["google-chrome", "chromium", "chromium-browser"])?,
            terminal: executable(dirs, &["x-terminal-emulator", "xterm"]).ok(),
        })
    }
}

/// Dropping a process stops its group while the child's id is still owned.
struct Process {
    child: Option<Child>,
    files: Option<Arc<tempfile::TempDir>>,
    #[cfg(target_os = "linux")]
    runtime_lifetime: Option<std::io::PipeWriter>,
}

impl Process {
    fn spawn(command: &mut Command, files: Option<Arc<tempfile::TempDir>>) -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        let runtime_lifetime = watch_runtime(command)?;
        Ok(Self {
            child: Some(command.spawn()?),
            files,
            #[cfg(target_os = "linux")]
            runtime_lifetime: Some(runtime_lifetime),
        })
    }

    fn child(&mut self) -> &mut Child {
        self.child
            .as_mut()
            .expect("desktop child is owned until drop")
    }

    fn id(&self) -> Option<u32> {
        self.child.as_ref().and_then(Child::id)
    }

    #[cfg(target_os = "linux")]
    fn is_running(&mut self) -> bool {
        let Some(pid) = self.id() else { return false };
        // Observe the exit without reaping. Drop still owns the process group
        // and can stop its remaining members before Tokio reaps its leader.
        let mut status: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut status,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        result == 0 && unsafe { status.si_pid() } == 0
    }

    #[cfg(not(target_os = "linux"))]
    fn is_running(&mut self) -> bool {
        matches!(self.child().try_wait(), Ok(None))
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if let Some(pid) = child.id() {
            // SAFETY: the private group leader is still owned by this child.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            let _ = child.start_kill();
            if let Some(files) = self.files.take() {
                // Keep X authority and the browser profile until the group
                // kill has been issued and the leader has been collected.
                if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    runtime.spawn(async move {
                        let _ = child.wait().await;
                        drop(files);
                    });
                }
            }
        }
        #[cfg(target_os = "linux")]
        drop(self.runtime_lifetime.take());
    }
}

/// Give each Linux process group a watchdog with a read end of a pipe owned
/// by the runtime. Even SIGKILL closes the write end. A group member, unlike
/// the old runtime, cannot mistake a reused PGID for its own group.
#[cfg(target_os = "linux")]
fn watch_runtime(command: &mut Command) -> io::Result<std::io::PipeWriter> {
    use std::os::fd::AsRawFd;
    let (reader, writer) = std::io::pipe()?;
    // SAFETY: pre_exec and the watchdog use only async-signal-safe operations.
    // The leader execs normally. The watchdog retains only the pipe read end.
    unsafe {
        command.pre_exec(move || {
            let read_fd = reader.as_raw_fd();
            // Raw fork-style clone avoids inherited pthread atfork handlers.
            let watcher = libc::syscall(
                libc::SYS_clone,
                libc::SIGCHLD as libc::c_ulong,
                0usize,
                0usize,
                0usize,
                0usize,
            );
            if watcher < 0 {
                return Err(io::Error::last_os_error());
            }
            if watcher == 0 {
                // This process is a fork of the runtime and must stay opaque
                // to other processes belonging to the desktop user.
                if libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) == 0
                    && libc::dup2(read_fd, 0) >= 0
                {
                    // Close inherited sockets, stdio and all copies of the writer.
                    if libc::syscall(libc::SYS_close_range, 1u32, u32::MAX, 0u32) == 0 {
                        let mut byte = 0u8;
                        loop {
                            let read = libc::read(0, (&mut byte as *mut u8).cast(), 1);
                            if read == 0 {
                                break;
                            }
                            if read < 0 && *libc::__errno_location() != libc::EINTR {
                                break;
                            }
                        }
                    }
                }
                libc::kill(-libc::getpgrp(), libc::SIGKILL);
                libc::_exit(1);
            }
            Ok(())
        });
    }
    Ok(writer)
}

fn command(path: &Path) -> Command {
    let mut child = Command::new(path);
    child
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    child
}

async fn write_cookie(
    xauth: &Path,
    authority: &Path,
    files: &Arc<tempfile::TempDir>,
    display: &str,
    cookie: &str,
) -> io::Result<()> {
    let mut process = Process::spawn(
        command(xauth)
            .arg("-q")
            .arg("-f")
            .arg(authority)
            .args(["source", "-"])
            .stdin(Stdio::piped()),
        Some(files.clone()),
    )?;
    let mut input = process.child().stdin.take().expect("piped xauth stdin");
    input
        .write_all(format!("add {display} MIT-MAGIC-COOKIE-1 {cookie}\n").as_bytes())
        .await?;
    drop(input);
    if process.child().wait().await?.success() && authority.is_file() {
        Ok(())
    } else {
        Err(io::Error::other("could not write desktop X authority"))
    }
}

/// `DevToolsActivePort`: the port, then the browser target's path.
fn parse_devtools(text: &str) -> Option<String> {
    let mut lines = text.lines();
    let port: u16 = lines.next()?.trim().parse().ok().filter(|port| *port != 0)?;
    let path = lines.next()?.trim();
    let id = path.strip_prefix("/devtools/browser/")?;
    (!id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
        .then(|| format!("ws://127.0.0.1:{port}{path}"))
}

fn parse_display(bytes: &[u8]) -> io::Result<u16> {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|line| line.strip_suffix('\n'))
        .filter(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|number| number.parse().ok())
        .ok_or_else(|| io::Error::other("invalid Xvfb display"))
}

pub(crate) struct Desktop {
    // Drop graphics clients before the server, and all processes before their private files.
    chrome: Process,
    // Not watched: closing the terminal window must not restart the desktop.
    _terminal: Option<Process>,
    manager: Process,
    xvfb: Process,
    files: Arc<tempfile::TempDir>,
    display: String,
    vnc: PathBuf,
}

pub(crate) struct DesktopConnection {
    pub(crate) rfb: Option<TcpStream>,
    _server: Process,
}

impl Desktop {
    #[cfg(test)]
    pub(crate) async fn start(dirs: &[&str]) -> Result<Self, DesktopError> {
        Self::start_in(dirs, None).await
    }

    /// `workdir` is where the terminal opens (the workspace checkout).
    pub(crate) async fn start_in(dirs: &[&str], workdir: Option<&Path>) -> Result<Self, DesktopError> {
        let tools = Tools::discover(dirs)?;
        let mut desktop = tokio::time::timeout(START_TIMEOUT, Self::launch(tools, workdir))
            .await
            .map_err(|_| DesktopError::StartupFailed)??;
        tokio::time::sleep(STARTUP_GRACE).await;
        if !desktop.xvfb.is_running() || !desktop.manager.is_running() {
            return Err(DesktopError::StartupFailed);
        }
        if !desktop.chrome.is_running() {
            return Err(DesktopError::ChromeStartupFailed);
        }
        Ok(desktop)
    }

    fn is_running(&mut self) -> bool {
        self.xvfb.is_running() && self.manager.is_running() && self.chrome.is_running()
    }

    async fn launch(tools: Tools, workdir: Option<&Path>) -> Result<Self, DesktopError> {
        let files = Arc::new(
            tempfile::Builder::new()
                .prefix("terminalx-desktop-")
                .tempdir()?,
        );
        let authority = files.path().join("Xauthority");
        let cookie = uuid::Uuid::new_v4().simple().to_string();
        // Xvfb loads the authorization protocol and cookie before assigning its
        // display number. Write the selected number for clients after startup.
        write_cookie(&tools.xauth, &authority, &files, ":0", &cookie).await?;
        let mut xvfb = Process::spawn(
            command(&tools.xvfb)
                .args([
                    "-displayfd",
                    "1",
                    "-screen",
                    "0",
                    "1280x800x24",
                    "-nolisten",
                    "tcp",
                    "-auth",
                ])
                .arg(&authority)
                .stdout(Stdio::piped()),
            Some(files.clone()),
        )?;
        let mut number = Vec::new();
        let mut output = xvfb
            .child()
            .stdout
            .take()
            .expect("piped Xvfb display number");
        for _ in 0..6 {
            let byte = output.read_u8().await?;
            number.push(byte);
            if byte == b'\n' {
                break;
            }
        }
        let display = format!(":{}", parse_display(&number)?);
        if display != ":0" {
            write_cookie(&tools.xauth, &authority, &files, &display, &cookie).await?;
        }
        let launch = |path: &Path| {
            let mut app = command(path);
            app.env("DISPLAY", &display)
                .env("XAUTHORITY", &authority)
                .env("HOME", files.path())
                .current_dir(files.path());
            app
        };
        let manager = Process::spawn(&mut launch(&tools.window_manager), Some(files.clone()))?;
        // A private profile and a loopback DevTools port on an ephemeral
        // number, for the cloud browser for agents (PRO-209). Chrome writes
        // the chosen port to `DevToolsActivePort` in the profile.
        let profile = files.path().join("chrome");
        let chrome = Process::spawn(
            launch(&tools.chrome)
                .arg(format!("--user-data-dir={}", profile.display()))
                .args([
                    "--remote-debugging-address=127.0.0.1",
                    "--remote-debugging-port=0",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "about:blank",
                ]),
            Some(files.clone()),
        )
        .map_err(|_| DesktopError::ChromeStartupFailed)?;
        let terminal = tools.terminal.as_deref().and_then(|path| {
            let mut terminal = launch(path);
            if let Some(dir) = workdir.filter(|dir| dir.is_dir()) {
                terminal.current_dir(dir);
            }
            Process::spawn(&mut terminal, Some(files.clone()))
                .map_err(|error| log::warn!("cloud desktop: the terminal did not start: {error}"))
                .ok()
        });
        Ok(Self {
            chrome,
            _terminal: terminal,
            manager,
            xvfb,
            files,
            display,
            vnc: tools.vnc,
        })
    }

    /// Chrome's DevTools browser endpoint, once Chrome has written it:
    /// `ws://127.0.0.1:<port><path>`.
    async fn devtools(&self) -> Result<String, DesktopError> {
        let file = self.files.path().join("chrome").join("DevToolsActivePort");
        for _ in 0..50 {
            if let Some(endpoint) = tokio::fs::read_to_string(&file).await.ok().as_deref().and_then(parse_devtools) {
                return Ok(endpoint);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(DesktopError::ChromeStartupFailed)
    }

    pub(crate) async fn connect(
        &self,
        access: DesktopAccess,
    ) -> Result<DesktopConnection, DesktopError> {
        self.connect_inner(access)
            .await
            .map_err(|_| DesktopError::StartupFailed)
    }

    async fn connect_inner(&self, access: DesktopAccess) -> io::Result<DesktopConnection> {
        // x11vnc expects TCP in inetd mode. Bind an ephemeral loopback
        // listener only long enough to form one socket pair. Reject a raced
        // connection before launching VNC, then close the listener.
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let rfb = TcpStream::connect(listener.local_addr()?).await?;
        let (server, address) = listener.accept().await?;
        if address != rfb.local_addr()? {
            return Err(io::Error::other("unexpected desktop loopback peer"));
        }
        drop(listener);
        let server = server.into_std()?;
        server.set_nonblocking(false)?;
        let input: OwnedFd = server.try_clone()?.into();
        let output: OwnedFd = server.into();
        let mut process = command(&self.vnc);
        process
            .args(["-inetd", "-display", &self.display, "-auth"])
            .arg(self.files.path().join("Xauthority"))
            .args([
                "-rfbport",
                "0",
                "-no6",
                "-localhost",
                "-norc",
                "-nopw",
                "-nosel",
                "-novncconnect",
                "-noremote",
                "-nocmds",
                "-noultraext",
            ])
            .env("HOME", self.files.path())
            .stdin(Stdio::from(input))
            .stdout(Stdio::from(output));
        if access == DesktopAccess::Watch {
            process.arg("-viewonly");
        }
        let server = Process::spawn(&mut process, Some(self.files.clone()))?;
        Ok(DesktopConnection {
            rfb: Some(rfb),
            _server: server,
        })
    }
}

/// The workspace owns the pool. A live RFB stream owns one lease; after
/// the last lease closes, a later connection may reuse the warm desktop
/// until the idle timer expires.
pub(crate) struct DesktopPool {
    state: Mutex<PoolState>,
    bin_dirs: Vec<String>,
    workdir: Option<PathBuf>,
    idle_timeout: Duration,
    runtime: tokio::runtime::Handle,
}

#[derive(Default)]
struct PoolState {
    desktop: Option<Desktop>,
    connected: usize,
    generation: u64,
}

pub(crate) struct DesktopLease {
    pub(crate) connection: DesktopConnection,
    pool: Weak<DesktopPool>,
}

/// An agent's hold on the desktop (PRO-209): it keeps the desktop up with no
/// viewer, like a stream does, and names Chrome's DevTools endpoint.
pub(crate) struct AgentLease {
    pub(crate) devtools: String,
    pool: Weak<DesktopPool>,
}

impl Drop for AgentLease {
    fn drop(&mut self) {
        DesktopPool::disconnected(self.pool.clone());
    }
}

static SHARED: std::sync::OnceLock<Arc<DesktopPool>> = std::sync::OnceLock::new();

/// The workspace's one desktop, shared by its viewers and its agents, its
/// terminal opening in `workdir`. The first caller, on the runtime's Tokio
/// runtime, decides the folder; a workspace runtime serves one project.
pub(crate) fn shared_pool_in(workdir: Option<PathBuf>) -> Arc<DesktopPool> {
    // Each test has its own Tokio runtime, and so its own pool.
    #[cfg(test)]
    return DesktopPool::new_in(vec!["/usr/bin".into(), "/bin".into()], workdir, Duration::from_secs(60));
    #[cfg(not(test))]
    SHARED
        .get_or_init(|| DesktopPool::new_in(vec!["/usr/bin".into(), "/bin".into()], workdir, Duration::from_secs(60)))
        .clone()
}

/// The shared desktop, for an agent: set up by the relay server first.
pub(crate) fn shared_pool() -> Option<Arc<DesktopPool>> {
    SHARED.get().cloned()
}

impl DesktopPool {
    #[cfg(test)]
    pub(crate) fn new(bin_dirs: Vec<String>, idle_timeout: Duration) -> Arc<Self> {
        Self::new_in(bin_dirs, None, idle_timeout)
    }

    /// `workdir`: the folder the desktop's terminal opens in.
    pub(crate) fn new_in(bin_dirs: Vec<String>, workdir: Option<PathBuf>, idle_timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::default(),
            bin_dirs,
            workdir,
            idle_timeout,
            runtime: tokio::runtime::Handle::current(),
        })
    }

    pub(crate) async fn connect(
        self: &Arc<Self>,
        access: DesktopAccess,
        allowed: impl Fn() -> bool,
    ) -> Result<DesktopLease, DesktopError> {
        let mut state = self.state.lock().await;
        if !allowed() {
            return Err(DesktopError::AccessChanged);
        }
        if state
            .desktop
            .as_mut()
            .is_some_and(|desktop| !desktop.is_running())
        {
            state.desktop = None;
        }
        if state.desktop.is_none() {
            let dirs: Vec<_> = self.bin_dirs.iter().map(String::as_str).collect();
            let desktop = Desktop::start_in(&dirs, self.workdir.as_deref()).await?;
            self.watch_health(desktop.files.path().to_owned());
            state.desktop = Some(desktop);
        }
        if !allowed() {
            if state.connected == 0 {
                state.desktop = None;
            }
            return Err(DesktopError::AccessChanged);
        }
        let connection = match state
            .desktop
            .as_ref()
            .expect("desktop started")
            .connect(access)
            .await
        {
            Ok(connection) => connection,
            Err(error) => {
                if state.connected == 0 {
                    state.desktop = None;
                }
                return Err(error);
            }
        };
        state.connected += 1;
        state.generation = state.generation.wrapping_add(1);
        Ok(DesktopLease {
            connection,
            pool: Arc::downgrade(self),
        })
    }

    /// Whether this image has the desktop packages at all.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn tools_present(&self) -> bool {
        let dirs: Vec<_> = self.bin_dirs.iter().map(String::as_str).collect();
        Tools::discover(&dirs).is_ok()
    }

    /// Start the desktop if it is not up, and hold it for an agent.
    pub(crate) async fn agent(self: &Arc<Self>) -> Result<AgentLease, DesktopError> {
        let mut state = self.state.lock().await;
        if state.desktop.as_mut().is_some_and(|desktop| !desktop.is_running()) {
            state.desktop = None;
        }
        if state.desktop.is_none() {
            let dirs: Vec<_> = self.bin_dirs.iter().map(String::as_str).collect();
            let desktop = Desktop::start_in(&dirs, self.workdir.as_deref()).await?;
            self.watch_health(desktop.files.path().to_owned());
            state.desktop = Some(desktop);
        }
        let devtools = match state.desktop.as_ref().expect("desktop started").devtools().await {
            Ok(devtools) => devtools,
            Err(error) => {
                if state.connected == 0 {
                    state.desktop = None;
                }
                return Err(error);
            }
        };
        state.connected += 1;
        state.generation = state.generation.wrapping_add(1);
        Ok(AgentLease { devtools, pool: Arc::downgrade(self) })
    }

    fn watch_health(self: &Arc<Self>, files: PathBuf) {
        let pool = Arc::downgrade(self);
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(HEALTH_INTERVAL).await;
                let Some(pool) = pool.upgrade() else { return };
                let mut state = pool.state.lock().await;
                let Some(desktop) = state
                    .desktop
                    .as_mut()
                    .filter(|desktop| desktop.files.path() == files)
                else {
                    return;
                };
                if !desktop.is_running() {
                    state.desktop = None;
                    return;
                }
            }
        });
    }

    fn disconnected(pool: Weak<Self>) {
        let Some(current) = pool.upgrade() else {
            return;
        };
        let runtime = current.runtime.clone();
        runtime.spawn(async move {
            let (generation, idle_timeout) = {
                let Some(current) = pool.upgrade() else {
                    return;
                };
                let mut state = current.state.lock().await;
                state.connected -= 1;
                if state.connected != 0 {
                    return;
                }
                (state.generation, current.idle_timeout)
            };
            tokio::time::sleep(idle_timeout).await;
            let Some(current) = pool.upgrade() else {
                return;
            };
            let mut state = current.state.lock().await;
            if state.connected == 0 && state.generation == generation {
                state.desktop = None;
            }
        });
    }
}

impl Drop for DesktopLease {
    fn drop(&mut self) {
        DesktopPool::disconnected(self.pool.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_a_loopback_browser_devtools_endpoint() {
        assert_eq!(
            parse_devtools("41235\n/devtools/browser/0b9e-4f1a\n").as_deref(),
            Some("ws://127.0.0.1:41235/devtools/browser/0b9e-4f1a")
        );
        for invalid in ["", "0\n/devtools/browser/a", "41235\n/devtools/page/a", "41235\n/devtools/browser/", "x\n/devtools/browser/a", "1\n/devtools/browser/a?b"] {
            assert_eq!(parse_devtools(invalid), None, "{invalid:?}");
        }
    }

    #[test]
    fn accepts_only_a_bounded_numeric_display() {
        assert_eq!(parse_display(b"172\n").unwrap(), 172);
        for invalid in [b"\n".as_slice(), b"42", b"-1\n", b"65536\n", b":01\n"] {
            assert!(parse_display(invalid).is_err());
        }
    }

    #[test]
    fn missing_and_non_executable_tools_are_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = [dir.path().to_str().unwrap()];
        let path = dir.path().join("fixture");
        std::fs::write(&path, b"").unwrap();
        assert_eq!(
            executable(&dirs, &["fixture"]),
            Err(DesktopError::MissingTools)
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(executable(&dirs, &["missing", "fixture"]), Ok(path));
    }

    fn fixture(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[tokio::test]
    async fn starts_in_a_private_display_and_reclaims_the_files_on_drop() {
        let tools = tempfile::tempdir().unwrap();
        let dirs = [tools.path().to_str().unwrap()];
        assert!(matches!(
            Desktop::start(&dirs).await,
            Err(DesktopError::MissingTools)
        ));
        fixture(tools.path(), "xauth", "umask 077; cat > \"$3\"");
        fixture(tools.path(), "Xvfb", "printf '42\\n'; exec /bin/sleep 15");
        fixture(tools.path(), "openbox", "exec /bin/sleep 15");
        fixture(tools.path(), "x11vnc", "exit 0");
        fixture(tools.path(), "chromium", "exec /bin/sleep 15");
        let desktop = Desktop::start(&dirs).await.unwrap();
        assert_eq!(desktop.display, ":42");
        let files = desktop.files.path().to_owned();
        let auth = files.join("Xauthority");
        assert_eq!(auth.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert!(std::fs::read_to_string(auth)
            .unwrap()
            .starts_with("add :42 MIT-MAGIC-COOKIE-1 "));
        drop(desktop);
        tokio::time::timeout(Duration::from_secs(2), async {
            while files.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("desktop files are removed after the processes exit");
    }

    #[tokio::test]
    async fn opens_a_terminal_in_the_workspace_and_survives_it_closing() {
        let tools = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let dirs = [tools.path().to_str().unwrap()];
        let opened = tools.path().join("opened");
        fixture(tools.path(), "xauth", "umask 077; cat > \"$3\"");
        fixture(tools.path(), "Xvfb", "printf '42\\n'; exec /bin/sleep 15");
        fixture(tools.path(), "openbox", "exec /bin/sleep 15");
        fixture(tools.path(), "x11vnc", "exit 0");
        fixture(tools.path(), "chromium", "exec /bin/sleep 15");
        // Without a terminal in the image the desktop still starts.
        drop(Desktop::start_in(&dirs, Some(workspace.path())).await.unwrap());
        // The terminal records where it opened, then its window is closed.
        fixture(tools.path(), "xterm", &format!("pwd > '{}'; echo \"$DISPLAY\" >> '{}'", opened.display(), opened.display()));
        let mut desktop = Desktop::start_in(&dirs, Some(workspace.path())).await.unwrap();
        let recorded = std::fs::read_to_string(&opened).unwrap();
        let mut lines = recorded.lines();
        assert_eq!(Path::new(lines.next().unwrap()).canonicalize().unwrap(), workspace.path().canonicalize().unwrap());
        assert_eq!(lines.next(), Some(":42"));
        assert!(desktop.is_running(), "a closed terminal does not restart the desktop");
    }

    #[tokio::test]
    async fn concurrent_opens_share_one_cold_desktop_start() {
        let tools = tempfile::tempdir().unwrap();
        let counter = tools.path().join("starts");
        fixture(tools.path(), "xauth", "umask 077; cat > \"$3\"");
        fixture(
            tools.path(),
            "Xvfb",
            &format!(
                "printf 'start\\n' >> '{}'; printf '42\\n'; exec /bin/sleep 15",
                counter.display(),
            ),
        );
        fixture(tools.path(), "openbox", "exec /bin/sleep 15");
        fixture(tools.path(), "x11vnc", "exec /bin/cat");
        fixture(tools.path(), "chromium", "exec /bin/sleep 15");
        let pool = DesktopPool::new(
            vec![tools.path().to_string_lossy().into_owned()],
            Duration::from_secs(1),
        );
        let (watch, control) = tokio::join!(
            pool.connect(DesktopAccess::Watch, || true),
            pool.connect(DesktopAccess::Control, || true),
        );
        let (watch, control) = (watch.unwrap(), control.unwrap());
        assert_eq!(std::fs::read_to_string(counter).unwrap(), "start\n");
        assert_ne!(
            watch.connection._server.id(),
            control.connection._server.id()
        );
        assert_eq!(pool.state.lock().await.connected, 2);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn watchdog_kills_the_desktop_group_when_runtime_pipe_closes() {
        use std::os::unix::process::ExitStatusExt;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut leader = Process::spawn(
            command(Path::new("/bin/sh"))
                .args(["-c", "sleep 15 & printf '%s\\n' \"$!\"; wait"])
                .stdout(Stdio::piped()),
            None,
        )
        .unwrap();
        let mut line = String::new();
        let mut out = BufReader::new(leader.child().stdout.take().unwrap());
        tokio::time::timeout(Duration::from_secs(3), out.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let member: u32 = line.trim().parse().unwrap();
        let stat = PathBuf::from(format!("/proc/{member}/stat"));
        assert!(stat.exists());
        assert!(leader.is_running());

        drop(leader.runtime_lifetime.take());
        let status = tokio::time::timeout(Duration::from_secs(3), leader.child().wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        tokio::time::timeout(Duration::from_secs(3), async {
            while std::fs::read_to_string(&stat).is_ok_and(|line| {
                line.rsplit_once(") ")
                    .is_some_and(|(_, state)| !state.starts_with('Z'))
            }) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the descendant was terminated with its leader");
    }

    #[tokio::test]
    async fn keeps_the_desktop_for_live_leases_and_stops_it_when_idle() {
        let tools = tempfile::tempdir().unwrap();
        fixture(tools.path(), "xauth", "umask 077; cat > \"$3\"");
        fixture(tools.path(), "Xvfb", "printf '42\\n'; exec /bin/sleep 15");
        fixture(tools.path(), "openbox", "exec /bin/sleep 15");
        fixture(tools.path(), "x11vnc", "exec /bin/cat");
        fixture(tools.path(), "chromium", "exec /bin/sleep 15");
        let pool = DesktopPool::new(
            vec![tools.path().to_str().unwrap().into()],
            Duration::from_millis(20),
        );
        let mut first = pool.connect(DesktopAccess::Watch, || true).await.unwrap();
        let second = pool.connect(DesktopAccess::Control, || true).await.unwrap();
        let files = pool
            .state
            .lock()
            .await
            .desktop
            .as_ref()
            .unwrap()
            .files
            .path()
            .to_owned();
        first
            .connection
            .rfb
            .as_mut()
            .unwrap()
            .write_all(b"x")
            .await
            .unwrap();
        assert_eq!(
            first
                .connection
                .rfb
                .as_mut()
                .unwrap()
                .read_u8()
                .await
                .unwrap(),
            b'x'
        );
        drop(first);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(files.exists());
        drop(second);
        tokio::time::timeout(Duration::from_secs(2), async {
            while files.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn refuses_early_chrome_exit_and_restarts_a_dead_display_once() {
        let tools = tempfile::tempdir().unwrap();
        let dirs = [tools.path().to_str().unwrap()];
        fixture(tools.path(), "xauth", "umask 077; cat > \"$3\"");
        fixture(
            tools.path(),
            "Xvfb",
            "printf x >> \"$0.starts\"; printf '42\\n'; exec /bin/sleep 15",
        );
        fixture(tools.path(), "openbox", "exec /bin/sleep 15");
        fixture(tools.path(), "x11vnc", "exec /bin/cat");
        let chrome = tools.path().join("chromium");
        let false_binary = ["/usr/bin/false", "/bin/false"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
            .unwrap();
        std::os::unix::fs::symlink(false_binary, &chrome).unwrap();
        assert_eq!(
            Desktop::start(&dirs).await.err(),
            Some(DesktopError::ChromeStartupFailed)
        );

        std::fs::remove_file(chrome).unwrap();
        fixture(tools.path(), "chromium", "exec /bin/sleep 15");
        let pool = DesktopPool::new(vec![dirs[0].into()], Duration::from_secs(20));
        let old_lease = pool.connect(DesktopAccess::Watch, || true).await.unwrap();
        let old_files = {
            let mut state = pool.state.lock().await;
            let desktop = state.desktop.as_mut().unwrap();
            desktop.xvfb.child().kill().await.unwrap();
            desktop.files.path().to_owned()
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while pool.state.lock().await.desktop.is_some() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            old_files.exists(),
            "the old stream still owns its X authority"
        );

        let (watch, control) = tokio::join!(
            pool.connect(DesktopAccess::Watch, || true),
            pool.connect(DesktopAccess::Control, || true),
        );
        let _leases = (watch.unwrap(), control.unwrap());
        {
            let mut state = pool.state.lock().await;
            assert_eq!(state.connected, 3);
            assert!(state.desktop.as_mut().unwrap().is_running());
        }
        drop(old_lease);
        tokio::time::timeout(Duration::from_secs(5), async {
            while old_files.exists() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(tools.path().join("Xvfb.starts")).unwrap(),
            b"xxx"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires real Xvfb, xauth, a window manager, x11vnc and sandboxed Chrome on Linux"]
    async fn real_binaries_exchange_rfb_without_a_tcp_listener() -> io::Result<()> {
        use std::collections::HashSet;

        fn assert_no_listeners(process: &Process) -> io::Result<()> {
            let pid = process.id().expect("live process");
            let proc = PathBuf::from(format!("/proc/{pid}"));
            let mut sockets = HashSet::new();
            for entry in std::fs::read_dir(proc.join("fd"))? {
                let Ok(target) = std::fs::read_link(entry?.path()) else {
                    continue;
                };
                let target = target.to_string_lossy();
                if let Some(inode) = target
                    .strip_prefix("socket:[")
                    .and_then(|v| v.strip_suffix(']'))
                {
                    sockets.insert(inode.to_owned());
                }
            }
            for protocol in ["tcp", "tcp6"] {
                let table = match std::fs::read_to_string(proc.join("net").join(protocol)) {
                    Ok(table) => table,
                    Err(error) if protocol == "tcp6" && error.kind() == io::ErrorKind::NotFound => {
                        continue
                    }
                    Err(error) => return Err(error),
                };
                for row in table.lines().skip(1) {
                    let fields: Vec<_> = row.split_whitespace().collect();
                    assert!(
                        fields.get(3) != Some(&"0A")
                            || !fields.get(9).is_some_and(|inode| sockets.contains(*inode)),
                        "desktop process {pid} owns a listening {protocol} socket"
                    );
                }
            }
            Ok(())
        }

        let dirs = ["/usr/bin", "/bin"];
        if matches!(Tools::discover(&dirs), Err(DesktopError::MissingTools)) {
            eprintln!(
                "Skipping real cloud desktop test because the workspace image lacks desktop tools"
            );
            return Ok(());
        }
        let desktop = Desktop::start(&dirs)
            .await
            .expect("real desktop starts with Chrome sandbox enabled");
        for access in [DesktopAccess::Watch, DesktopAccess::Control] {
            let mut connection = desktop.connect(access).await.expect("real x11vnc starts");
            let mut version = [0; 12];
            let socket = connection.rfb.as_mut().unwrap();
            tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut version)).await??;
            assert!(version.starts_with(b"RFB ") && version.ends_with(b"\n"));
            assert_no_listeners(&desktop.xvfb)?;
            assert_no_listeners(&connection._server)?;
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires the real desktop tools and xdotool on Linux"]
    async fn real_viewer_pointer_input_is_discarded() -> io::Result<()> {
        async fn handshake(socket: &mut TcpStream) -> io::Result<()> {
            let mut version = [0; 12];
            socket.read_exact(&mut version).await?;
            assert_eq!(&version, b"RFB 003.008\n");
            socket.write_all(&version).await?;
            let method_count = socket.read_u8().await?;
            let mut methods = vec![0; usize::from(method_count)];
            socket.read_exact(&mut methods).await?;
            assert!(methods.contains(&1));
            socket.write_u8(1).await?;
            assert_eq!(socket.read_u32().await?, 0);
            socket.write_u8(1).await?;
            let mut init = [0; 24];
            socket.read_exact(&mut init).await?;
            let length = u32::from_be_bytes(init[20..24].try_into().unwrap()) as usize;
            assert!(length <= 4096);
            socket.read_exact(&mut vec![0; length]).await?;
            Ok(())
        }

        async fn move_pointer(socket: &mut TcpStream, x: u8, y: u8) -> io::Result<()> {
            socket.write_all(&[5, 0, 0, x, 0, y]).await
        }

        async fn pointer(desktop: &Desktop, xdotool: &Path) -> io::Result<(u16, u16)> {
            let output = command(xdotool)
                .env("DISPLAY", &desktop.display)
                .env("XAUTHORITY", desktop.files.path().join("Xauthority"))
                .args(["getmouselocation", "--shell"])
                .output()
                .await?;
            assert!(output.status.success());
            let pos = String::from_utf8(output.stdout).unwrap();
            let coordinate = |axis| {
                pos.lines()
                    .find_map(|line| line.strip_prefix(axis))
                    .unwrap()
                    .parse()
                    .unwrap()
            };
            Ok((coordinate("X="), coordinate("Y=")))
        }

        let dirs = ["/usr/bin", "/bin"];
        let Ok(xdotool) = executable(&dirs, &["xdotool"]) else {
            eprintln!("Skipping real cloud desktop pointer test because xdotool is absent");
            return Ok(());
        };
        if Tools::discover(&dirs).is_err() {
            eprintln!("Skipping real cloud desktop pointer test because desktop tools are absent");
            return Ok(());
        }
        let desktop = Desktop::start(&dirs).await.expect("real desktop starts");
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut control = desktop.connect(DesktopAccess::Control).await.unwrap();
            let control = control.rfb.as_mut().unwrap();
            handshake(control).await?;
            move_pointer(control, 30, 40).await?;
            while pointer(&desktop, &xdotool).await? != (30, 40) {
                tokio::time::sleep(Duration::from_millis(30)).await;
            }

            let mut watch = desktop.connect(DesktopAccess::Watch).await.unwrap();
            let watch = watch.rfb.as_mut().unwrap();
            handshake(watch).await?;
            move_pointer(watch, 140, 150).await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(pointer(&desktop, &xdotool).await?, (30, 40));
            move_pointer(control, 140, 150).await?;
            while pointer(&desktop, &xdotool).await? != (140, 150) {
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            Ok::<_, io::Error>(())
        })
        .await??;
        Ok(())
    }

    #[tokio::test]
    async fn each_connection_gets_its_own_process_and_watch_mode() {
        let files = tempfile::tempdir().unwrap();
        let vnc = files.path().join("rfb-fixture");
        std::fs::write(&vnc, b"#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
        std::fs::set_permissions(&vnc, std::fs::Permissions::from_mode(0o700)).unwrap();
        let idle = || Process::spawn(command(Path::new("/bin/sleep")).arg("15"), None).unwrap();
        let desktop = Desktop {
            chrome: idle(),
            _terminal: None,
            manager: idle(),
            xvfb: idle(),
            files: Arc::new(files),
            display: ":42".into(),
            vnc,
        };
        let mut watch = desktop.connect(DesktopAccess::Watch).await.unwrap();
        let mut control = desktop.connect(DesktopAccess::Control).await.unwrap();
        for (socket, view_only) in [
            (watch.rfb.as_mut().unwrap(), true),
            (control.rfb.as_mut().unwrap(), false),
        ] {
            let mut flags = String::new();
            tokio::time::timeout(Duration::from_secs(2), socket.read_to_string(&mut flags))
                .await
                .unwrap()
                .unwrap();
            assert!(flags.lines().any(|arg| arg == "-inetd"));
            assert!(flags.lines().any(|arg| arg == "-no6"));
            assert!(flags.lines().any(|arg| arg == "-localhost"));
            assert!(flags.contains("-rfbport\n0\n"));
            assert_eq!(flags.lines().any(|arg| arg == "-viewonly"), view_only);
        }
    }
}
