//! The Local VM: a Linux desktop in a container on this machine, for the
//! reader to watch (the right panel's Computer tab) and for agents to work in
//! (the `computer` MCP server their CLIs are started with while it is on).
//!
//! It runs on whichever container runtime is installed, Docker or Podman, from
//! a pinned XFCE image that serves noVNC on 6901 and ships `cua-driver`, the
//! computer-use driver agents speak MCP to. The viewer port is published on
//! loopback only, behind a random VNC password kept in `~/.raccoon/computer`.
//! The container gets no mount of this machine: what it sees of the reader's
//! work is what a dev server serves, at `host.docker.internal`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use crate::computer_targets::{Capability, Runtime, Target};

pub const CONTAINER: &str = "terminalx-computer";
/// Told to the window when the VM was started or stopped from outside it (`terminalx vm …`).
pub const CHANGED_EVENT: &str = "local_vm_changed";
/// The official multi-architecture Cua XFCE image (amd64 + arm64), by digest.
pub const IMAGE: &str = "docker.io/trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
const LABEL: &str = "ai.terminalx.computer";
const VIEWER_PORT: u16 = 6901;
const QUICK: Duration = Duration::from_secs(20);
const PULL: Duration = Duration::from_secs(20 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmState {
    /// Neither Docker nor Podman is installed.
    NoRuntime,
    /// The CLI is there but its daemon (Docker Desktop, Colima, the Podman machine) is not running.
    RuntimeDown,
    NotCreated,
    Stopped,
    Running,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    /// Loopback port of the noVNC server; its RFB socket is `/websockify`.
    pub port: u16,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmStatus {
    pub state: VmState,
    /// `docker` or `podman`.
    pub runtime: Option<String>,
    /// Colima is installed, so a stopped Docker can be started from here.
    pub colima: bool,
    pub viewer: Option<Viewer>,
}

/// What survives a restart: whether the reader wants the VM on (agents are
/// only offered it then) and its VNC password.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Saved {
    enabled: bool,
    password: String,
}

fn state_path() -> Result<PathBuf> {
    Ok(crate::store::ensure_dir(crate::store::root()?.join("computer"))?.join("local-vm.json"))
}

fn load() -> Saved {
    state_path().ok().and_then(|path| std::fs::read(path).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn save(saved: &Saved) -> Result<()> {
    let path = state_path()?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    use std::io::Write;
    options.open(&path)?.write_all(&serde_json::to_vec(saved)?)?;
    Ok(())
}

/// The saved password, made on first use. VNC authentication reads eight characters.
fn password() -> Result<String> {
    let mut saved = load();
    if saved.password.len() < 8 {
        saved.password = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        save(&saved)?;
    }
    Ok(saved.password)
}

fn set_enabled(enabled: bool) -> Result<()> {
    let mut saved = load();
    if saved.enabled != enabled {
        saved.enabled = enabled;
        save(&saved)?;
    }
    Ok(())
}

/// Docker first, then Podman, on the reader's login PATH.
fn runtime() -> Option<PathBuf> {
    ["docker", "podman"].into_iter().find_map(crate::binpath::resolve)
}

fn runtime_name(path: &Path) -> String {
    path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_else(|| "docker".into())
}

/// Run `program args`, failing after `timeout` with what it printed to stderr.
fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let mut child = Command::new(program)
        .args(args)
        .env("PATH", crate::binpath::login_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("run {}", program.display()))?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let reader = std::thread::spawn(move || {
        let (mut stdout, mut stderr) = (String::new(), String::new());
        let _ = out.read_to_string(&mut stdout);
        let _ = err.read_to_string(&mut stderr);
        (stdout, stderr)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{} {} took too long", runtime_name(program), args.first().unwrap_or(&""));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let (stdout, stderr) = reader.join().map_err(|_| anyhow!("read command output"))?;
    if !status.success() {
        let reason = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("failed").trim().to_string();
        bail!("{reason}");
    }
    Ok(stdout)
}

fn daemon_up(runtime: &Path) -> bool {
    run(runtime, &["info", "--format", "{{.ServerVersion}}"], Duration::from_secs(8)).is_ok()
}

/// `true` running, `false` stopped, `None` absent.
fn container_running(runtime: &Path) -> Option<bool> {
    container_running_within(runtime, QUICK)
}

fn container_running_within(runtime: &Path, timeout: Duration) -> Option<bool> {
    run(runtime, &["inspect", "--format", "{{.State.Running}}", CONTAINER], timeout).ok().map(|out| out.trim() == "true")
}

/// Whether the container of that name is the one this app made (its label), and so ours to start, stop or remove.
fn ours(runtime: &Path) -> Result<()> {
    let label = run(runtime, &["inspect", "--format", &format!("{{{{index .Config.Labels \"{LABEL}\"}}}}"), CONTAINER], QUICK)?;
    if label.trim() != "1" {
        bail!("a container named {CONTAINER} exists that TerminalX did not create");
    }
    Ok(())
}

fn inspect_identity(path: &Path, runtime: Runtime, selector: &str, timeout: Duration) -> Result<(Target, bool)> {
    let output = run(path, &["inspect", "--format", "{{json .}}", selector], timeout)?;
    let value: serde_json::Value = serde_json::from_str(&output).context("Unreadable container identity")?;
    let id = value["Id"].as_str().context("Container ID is missing")?;
    let running = value["State"]["Running"].as_bool().context("Container running state is missing")?;
    if value["Config"]["Labels"][LABEL].as_str() != Some("1") {
        bail!("Container is not owned by TerminalX");
    }
    let target = Target::LinuxContainer { runtime, id: id.into() };
    target.require(Capability::AttachedDesktop)?;
    Ok((target, running))
}

pub fn identity(path: &Path, runtime: Runtime) -> Result<(Target, bool)> {
    inspect_identity(path, runtime, CONTAINER, Duration::from_secs(3))
}

pub(crate) fn validate_at(path: &Path, target: &Target, timeout: Duration) -> Result<()> {
    target.require(Capability::AttachedDesktop)?;
    let Target::LinuxContainer { runtime, id } = target else { bail!("An exact Linux desktop container is required; no OS fallback") };
    let (actual, running) = inspect_identity(path, *runtime, id, timeout).context("Selected container unavailable; no fallback")?;
    if &actual != target || !running { bail!("Selected container changed or stopped; no fallback"); }
    Ok(())
}

pub fn selected_runtime(target: &Target) -> Result<PathBuf> {
    target.require(Capability::AttachedDesktop)?;
    let Target::LinuxContainer { runtime, .. } = target else { bail!("This route requires an exact Linux desktop container; no OS fallback"); };
    let path = crate::binpath::resolve(runtime.name()).context("Selected container runtime is unavailable; no fallback")?;
    validate_at(&path, target, Duration::from_secs(3))?;
    Ok(path)
}

/// Read only, including stopped containers. Absence or a reused name is never
/// an exit receipt for an earlier exact target.
pub(crate) fn exit_evidence(target: &Target) -> Result<serde_json::Value> {
    target.require(Capability::AttachedDesktop)?;
    let Target::LinuxContainer { runtime, id } = target else { bail!("An exact Linux desktop container is required; no OS fallback") };
    let path = crate::binpath::resolve(runtime.name()).context("Selected container runtime is unavailable")?;
    let output = run(&path, &["inspect", "--format", "{{json .}}", id], Duration::from_secs(3))?;
    parse_exit_evidence(target, &serde_json::from_str(&output)?)
}

pub(crate) fn parse_exit_evidence(target: &Target, value: &serde_json::Value) -> Result<serde_json::Value> {
    target.require(Capability::AttachedDesktop)?;
    let Target::LinuxContainer { id, .. } = target else { bail!("An exact Linux desktop container is required; no OS fallback") };
    if value["Id"].as_str() != Some(id) || value["Config"]["Labels"][LABEL] != "1" {
        bail!("Exact owned container identity was not confirmed; ownership remains fenced");
    }
    if !matches!(value["HostConfig"]["PidMode"].as_str(), Some("" | "private")) {
        bail!("Private container PID namespace was not confirmed; ownership remains fenced");
    }
    let state = &value["State"];
    if state["Status"] != "exited" || state["Running"] != false || state["Pid"] != 0
        || state["Paused"] != false || state["Restarting"] != false || state["Dead"] != false {
        bail!("No supported container exit proof; ownership remains fenced");
    }
    let started = chrono::DateTime::parse_from_rfc3339(state["StartedAt"].as_str().context("Missing container start receipt")?)?;
    let finished = chrono::DateTime::parse_from_rfc3339(state["FinishedAt"].as_str().context("Missing container exit receipt")?)?;
    if started.timestamp() <= 0 || finished < started { bail!("Invalid container exit interval"); }
    Ok(serde_json::json!({"target":target,"status":"exited","running":false,"pid":0,
        "pidMode":value["HostConfig"]["PidMode"],"startedAt":state["StartedAt"],"finishedAt":state["FinishedAt"]}))
}

pub fn selected_status(target: &Target) -> Result<VmStatus> {
    let path = selected_runtime(target)?;
    let Target::LinuxContainer { runtime, id } = target else { bail!("An exact Linux desktop container is required; no OS fallback") };
    let port = parse_port(&run(&path, &["port", id, "6901/tcp"], QUICK)?).context("Selected viewer has no loopback binding")?;
    Ok(VmStatus { state: VmState::Running, runtime: Some(runtime.name().into()), colima: false, viewer: Some(Viewer { port, password: password()? }) })
}

/// `127.0.0.1:32768` (and `[::1]:32768`) to the port, loopback bindings only.
pub fn parse_port(out: &str) -> Option<u16> {
    out.lines().find_map(|line| {
        let (host, port) = line.trim().rsplit_once(':')?;
        matches!(host, "127.0.0.1" | "[::1]" | "localhost").then(|| port.parse().ok()).flatten()
    })
}

fn viewer_port(runtime: &Path) -> Option<u16> {
    run(runtime, &["port", CONTAINER, &format!("{VIEWER_PORT}/tcp")], QUICK).ok().as_deref().and_then(parse_port)
}

pub fn status() -> VmStatus {
    let colima = crate::binpath::resolve("colima").is_some();
    let Some(path) = runtime() else {
        return VmStatus { state: VmState::NoRuntime, runtime: None, colima, viewer: None };
    };
    let name = Some(runtime_name(&path));
    if !daemon_up(&path) {
        return VmStatus { state: VmState::RuntimeDown, runtime: name, colima, viewer: None };
    }
    let (state, viewer) = match container_running(&path) {
        None => (VmState::NotCreated, None),
        Some(false) => (VmState::Stopped, None),
        Some(true) => {
            let viewer = viewer_port(&path).zip(password().ok()).map(|(port, password)| Viewer { port, password });
            (VmState::Running, viewer)
        }
    };
    VmStatus { state, runtime: name, colima, viewer }
}

/// The arguments the container is created with: loopback-only viewer, no
/// mounts, capped resources, every capability dropped but the two its
/// supervisor needs to step down to the desktop user.
pub fn run_args(runtime: &str, password: &str) -> Vec<String> {
    let mut args: Vec<String> = ["run", "-d", "--name", CONTAINER, "--hostname", CONTAINER, "--label"].map(String::from).to_vec();
    args.push(format!("{LABEL}=1"));
    args.extend(
        [
            "--memory", "4g", "--cpus", "2", "--pids-limit", "512", "--shm-size", "512m",
            "--ipc", "private", "--cgroupns", "private",
            "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID",
        ]
        .map(String::from),
    );
    // Firefox's sandbox chroots, which Podman's default seccomp profile gates on this capability.
    if runtime == "podman" {
        args.extend(["--cap-add", "SYS_CHROOT"].map(String::from));
    }
    // Dev servers on this machine, reached from the VM's browser.
    args.extend(["--add-host", "host.docker.internal:host-gateway", "-e"].map(String::from));
    args.push(format!("VNC_PW={password}"));
    args.push("-p".into());
    args.push(format!("127.0.0.1::{VIEWER_PORT}"));
    args.push(IMAGE.into());
    args
}

/// Bring the VM up: the image (pulled once), the container (made once), and
/// the driver agents talk to. From now on new agent sessions are offered it.
pub fn start() -> Result<VmStatus> {
    let path = runtime().context("Docker or Podman is not installed")?;
    let name = runtime_name(&path);
    if !daemon_up(&path) {
        bail!("{name} is not running");
    }
    #[cfg(unix)]
    let admission = lifecycle_admission(&path, false)?;
    if run(&path, &["image", "inspect", IMAGE], QUICK).is_err() {
        run(&path, &["pull", IMAGE], PULL).context("download the desktop image")?;
    }
    match container_running(&path) {
        None => {
            let password = password()?;
            let args = run_args(&name, &password);
            run(&path, &args.iter().map(String::as_str).collect::<Vec<_>>(), QUICK).context("create the Local VM")?;
        }
        Some(running) => {
            // A container of that name that this app did not make is not ours to start.
            ours(&path)?;
            if !running {
                run(&path, &["start", CONTAINER], QUICK).context("start the Local VM")?;
            }
        }
    }
    // Up means the viewer answers and the desktop's X display exists; the driver needs the display.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let viewer = viewer_port(&path).is_some_and(|port| std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1)).is_ok());
        if viewer && run(&path, &["exec", "-u", "cua", CONTAINER, "test", "-S", "/tmp/.X11-unix/X1"], QUICK).is_ok() {
            break;
        }
        if Instant::now() >= deadline {
            bail!("the Local VM started but its screen did not come up");
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    // The driver reports usage by default; this one does not. Then its daemon, which `cua-driver mcp` needs.
    let _ = run(&path, &["exec", "-u", "cua", CONTAINER, "cua-driver", "telemetry", "disable"], QUICK);
    if run(&path, &["exec", "-u", "cua", CONTAINER, "cua-driver", "status"], QUICK).is_err() {
        run(&path, &["exec", "-d", "-u", "cua", "-e", "DISPLAY=:1", CONTAINER, "cua-driver", "serve"], QUICK).context("start the computer driver")?;
        // An agent started the moment this returns must find the driver listening.
        let deadline = Instant::now() + Duration::from_secs(15);
        while run(&path, &["exec", "-u", "cua", CONTAINER, "cua-driver", "status"], QUICK).is_err() {
            if Instant::now() >= deadline {
                bail!("the computer driver did not start in the Local VM");
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    set_enabled(true)?;
    #[cfg(unix)]
    if let Some(guard) = admission { guard.completed()?; }
    Ok(status())
}

/// Stop the VM; it keeps its state for the next start. Agents are no longer offered it.
pub fn stop() -> Result<VmStatus> {
    if let Some(path) = runtime() {
        #[cfg(unix)]
        let admission = lifecycle_admission(&path, false)?;
        if container_running(&path) == Some(true) {
            ours(&path)?;
            run(&path, &["stop", "-t", "5", CONTAINER], QUICK).context("stop the Local VM")?;
        }
        #[cfg(unix)]
        if let Some(guard) = admission { guard.completed()?; }
    }
    set_enabled(false)?;
    Ok(status())
}

/// Throw the VM away; the next start makes a fresh one.
pub fn reset() -> Result<VmStatus> {
    if let Some(path) = runtime() {
        #[cfg(unix)]
        let admission = lifecycle_admission(&path, true)?;
        if container_running(&path).is_some() {
            ours(&path)?;
            run(&path, &["rm", "-f", CONTAINER], QUICK).context("remove the Local VM")?;
        }
        #[cfg(unix)]
        if let Some(guard) = admission { guard.completed()?; }
    }
    set_enabled(false)?;
    Ok(status())
}

/// Start the container runtime itself: Colima when it is installed, else Docker Desktop.
pub fn start_runtime() -> Result<VmStatus> {
    if let Some(colima) = crate::binpath::resolve("colima") {
        run(&colima, &["start"], Duration::from_secs(5 * 60)).context("start Colima")?;
    } else if cfg!(target_os = "macos") {
        run(Path::new("/usr/bin/open"), &["-a", "Docker"], QUICK).context("open Docker Desktop")?;
        let deadline = Instant::now() + Duration::from_secs(90);
        while runtime().is_some_and(|path| !daemon_up(&path)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_secs(1));
        }
    } else {
        bail!("start Docker or Podman, then try again");
    }
    Ok(status())
}

/// One computer-use tool, run by the VM's driver: what an agent without the
/// `computer` MCP server (started before the VM was) uses instead.
pub fn call(target: &Target, tool: &str, arguments: &str) -> Result<String> {
    if tool.is_empty() || !tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        bail!("unknown tool {tool:?}");
    }
    serde_json::from_str::<serde_json::Value>(arguments).context("the tool's arguments must be JSON")?;
    let path = selected_runtime(target)?;
    let Target::LinuxContainer { id, .. } = target else { bail!("An exact Linux desktop container is required; no OS fallback") };
    #[cfg(unix)]
    let admission = attach(target)?;
    let result = run(&path, &["exec", "-u", "cua", "-e", "DISPLAY=:1", id, "cua-driver", "call", tool, arguments], Duration::from_secs(120))?;
    #[cfg(unix)]
    admission.completed()?;
    Ok(result)
}

/// The driver's tools, or one tool's description and argument schema.
pub fn tools(target: &Target, tool: Option<&str>) -> Result<String> {
    let path = selected_runtime(target)?;
    let Target::LinuxContainer { id, .. } = target else { bail!("An exact Linux desktop container is required; no OS fallback") };
    match tool {
        Some(tool) if !tool.is_empty() && tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
            run(&path, &["exec", "-u", "cua", id, "cua-driver", "describe", tool], QUICK)
        }
        Some(tool) => bail!("unknown tool {tool:?}"),
        None => run(&path, &["exec", "-u", "cua", id, "cua-driver", "list-tools"], QUICK),
    }
}

/// The VM's whole screen as a PNG on this machine, at `out` or in `~/.raccoon/computer/screens`.
pub fn screenshot(target: &Target, out: Option<PathBuf>) -> Result<PathBuf> {
    let path = selected_runtime(target)?;
    let Target::LinuxContainer { id, .. } = target else { bail!("An exact Linux desktop container is required; no OS fallback") };
    let out = match out {
        // Absolute, so `docker cp` never reads it as `container:path` or `-` (stdout).
        Some(out) => std::path::absolute(&out).context("where to save the screenshot")?,
        None => crate::store::ensure_dir(crate::store::root()?.join("computer").join("screens"))?.join(format!("screen-{}.png", chrono::Utc::now().format("%Y%m%d-%H%M%S%3f"))),
    };
    #[cfg(unix)]
    let admission = attach(target)?;
    let inside = "/tmp/terminalx-screen.png";
    run(&path, &["exec", "-u", "cua", id, "ffmpeg", "-loglevel", "error", "-f", "x11grab", "-i", ":1", "-frames:v", "1", "-y", inside], QUICK).context("capture the screen")?;
    run(&path, &["cp", &format!("{id}:{inside}"), &out.to_string_lossy()], QUICK).context("copy the screenshot out")?;
    #[cfg(unix)]
    admission.completed()?;
    Ok(out)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

const AGENT_NOTE: &str = "A Linux desktop (the TerminalX Local VM) is available through the `computer` MCP tools: screenshots, clicks, typing, launching apps such as Firefox. The agent, shell and project files remain on the host; only desktop tools use this selected container. Use it for desktop or browser actions; never install or start another VM, desktop image, X server or VNC. Servers running on this machine are reached inside it at http://host.docker.internal:<port>, not localhost. The user may be watching it, or holding control of it. `terminalx skills get local-vm` has the details.";

/// What a new agent session's command line gains while the VM is on: the VM's
/// driver as an MCP server named `computer`. A stale selection fails launch;
/// it must not silently start an agent with a different desktop.
pub fn launch_selected(target: &Target, harness: &str, appends_prompt: bool) -> Result<String> {
    if !matches!(harness, "claude" | "codex") { bail!("This agent does not support attached desktop tools"); }
    let path = selected_runtime(target)?;
    let Target::LinuxContainer { id, .. } = target else { bail!("An exact Linux desktop container is required; no OS fallback") };
    #[cfg(unix)]
    {
        let _ = (path, id);
        let executable = std::env::current_exe()?;
        let serialized = serde_json::to_string(target)?;
        let home = crate::store::root()?;
        Ok(mcp_args(harness, &executable.to_string_lossy(), &["container-computer-stdio", &serialized, &home.to_string_lossy()], appends_prompt, AGENT_NOTE))
    }
    #[cfg(not(unix))]
    Ok(agent_args(harness, &path.to_string_lossy(), id, appends_prompt))
}

#[cfg(any(test, not(unix)))]
pub fn agent_args(harness: &str, runtime: &str, id: &str, appends_prompt: bool) -> String {
    let args = ["exec", "-i", "-u", "cua", "-e", "DISPLAY=:1", id, "cua-driver", "mcp"];
    mcp_args(harness, runtime, &args, appends_prompt, AGENT_NOTE)
}

pub(crate) fn mcp_args(harness: &str, runtime: &str, args: &[&str], appends_prompt: bool, agent_note: &str) -> String {
    match harness {
        "claude" => {
            let config = serde_json::json!({ "mcpServers": { "computer": { "command": runtime, "args": args } } });
            let mut out = format!(" --mcp-config {}", shell_quote(&config.to_string()));
            if !appends_prompt {
                out.push_str(&format!(" --append-system-prompt {}", shell_quote(agent_note)));
            }
            out
        }
        "codex" => {
            let mut table = toml::map::Map::new();
            table.insert("command".into(), toml::Value::String(runtime.into()));
            table.insert("args".into(), toml::Value::Array(args.iter().map(|arg| toml::Value::String((*arg).into())).collect()));
            let inline = toml::Value::Table(table).to_string();
            format!(" -c {}", shell_quote(&format!("mcp_servers.computer={}", inline.trim())))
        }
        _ => String::new(),
    }
}

#[cfg(unix)]
fn lifecycle_admission(path: &Path, deleting: bool) -> Result<Option<crate::local_vm::admission::Guard>> {
    if container_running(path).is_none() { return Ok(None); }
    let runtime = match runtime_name(path).as_str() { "docker" => Runtime::Docker, "podman" => Runtime::Podman, _ => bail!("Unknown container runtime") };
    let (target, _) = identity(path, runtime)?;
    let journal = crate::local_vm::host::journal()?;
    if deleting && journal.read()?.environments.values().any(|e| e.transport.container().as_ref() == Some(&target)) {
        bail!("This container has retained guest task history. Reset requires explicit guest disposition; it cannot remove that history through the desktop shortcut");
    }
    Ok(Some(attach(&target)?))
}

#[cfg(unix)]
fn attach(target: &Target) -> Result<crate::local_vm::admission::Guard> {
    crate::local_vm::admission::Guard::attach(&crate::local_vm::host::root()?, target, &crate::local_vm::host::journal()?)
}

/// The attached MCP proxy holds admission for its entire lifetime. A crash or
/// transport failure retains an unknown-operation record instead of releasing
/// the container to a queued task merely because a host process disappeared.
#[cfg(unix)]
pub fn run_stdio_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("container-computer-stdio") { return None; }
    let result = (|| -> Result<()> {
        if args.len() != 3 || !Path::new(&args[2]).is_absolute() { bail!("An exact container target and owner home are required"); }
        std::env::set_var("TERMINALX_HOME", &args[2]);
        let target: Target = serde_json::from_str(&args[1])?;
        let path = selected_runtime(&target)?;
        let Target::LinuxContainer { id, .. } = &target else { bail!("An exact Linux desktop container is required; no OS fallback") };
        let admission = attach(&target)?;
        let status = Command::new(path).args(["exec", "-i", "-u", "cua", "-e", "DISPLAY=:1", id, "cua-driver", "mcp"])
            .stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).status()?;
        if !status.success() { bail!("Attached desktop transport exited without a successful guest exit receipt; route remains reserved"); }
        admission.completed()
    })();
    if let Err(error) = &result { eprintln!("Container desktop: {error:#}"); }
    Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_proof_requires_exact_owned_container_and_complete_stopped_state() {
        for runtime in [Runtime::Docker, Runtime::Podman] {
            let target = Target::LinuxContainer { runtime, id: "a".repeat(64) };
            let valid = serde_json::json!({"Id":"a".repeat(64),"Config":{"Labels":{"ai.terminalx.computer":"1"}},"HostConfig":{"PidMode":"private"},
                "State":{"Status":"exited","Running":false,"Pid":0,"Paused":false,"Restarting":false,"Dead":false,
                    "StartedAt":"2026-10-28T01:00:00Z","FinishedAt":"2026-10-28T01:00:01Z"}});
            assert!(parse_exit_evidence(&target,&valid).is_ok());
            for (path, bad) in [("/Id",serde_json::json!("b".repeat(64))), ("/Config/Labels/ai.terminalx.computer",serde_json::json!("0")),
                ("/HostConfig/PidMode",serde_json::json!("host")),("/HostConfig/PidMode",serde_json::Value::Null),
                ("/State/Status",serde_json::json!("running")),("/State/Running",serde_json::json!(true)),("/State/Pid",serde_json::json!(2)),
                ("/State/Paused",serde_json::json!(true)),("/State/Restarting",serde_json::json!(true)),("/State/Dead",serde_json::json!(true)),
                ("/State/FinishedAt",serde_json::json!("2026-10-28T00:00:00Z")),("/State/StartedAt",serde_json::Value::Null)] {
                let mut value = valid.clone(); *value.pointer_mut(path).unwrap()=bad;
                assert!(parse_exit_evidence(&target,&value).is_err(),"{path}");
            }
        }
    }

    #[test]
    fn only_a_loopback_binding_is_the_viewer() {
        assert_eq!(parse_port("127.0.0.1:32768\n"), Some(32768));
        assert_eq!(parse_port("[::1]:32770\n127.0.0.1:32768"), Some(32770));
        assert_eq!(parse_port("0.0.0.0:6901"), None);
        assert_eq!(parse_port(""), None);
    }

    #[test]
    fn the_container_is_loopback_only_locked_down_and_mounts_nothing() {
        let args = run_args("docker", "secret12");
        let joined = args.join(" ");
        assert!(joined.contains("-p 127.0.0.1::6901"), "{joined}");
        assert!(joined.contains("--cap-drop ALL"));
        assert!(joined.contains("VNC_PW=secret12"));
        assert!(joined.contains(&format!("--label {LABEL}=1")));
        assert!(!joined.contains("--mount") && !joined.contains(" -v "));
        assert!(!joined.contains("SYS_CHROOT"));
        assert!(run_args("podman", "x").contains(&"SYS_CHROOT".to_string()));
        assert_eq!(args.last().map(String::as_str), Some(IMAGE));
    }

    #[test]
    fn agents_get_the_driver_as_an_mcp_server_named_computer() {
        let claude = agent_args("claude", "/opt/homebrew/bin/docker", &"a".repeat(64), false);
        assert!(claude.starts_with(" --mcp-config '{\"mcpServers\":{\"computer\":{\"args\":[\"exec\",\"-i\""), "{claude}");
        assert!(claude.contains("\"command\":\"/opt/homebrew/bin/docker\""));
        assert!(claude.contains("--append-system-prompt") && claude.contains("host.docker.internal"));
        // A prompt the workspace already appends is not doubled.
        assert!(!agent_args("claude", "docker", &"a".repeat(64), true).contains("--append-system-prompt"));
        let codex = agent_args("codex", "/usr/local/bin/docker", &"a".repeat(64), false);
        assert!(codex.starts_with(" -c 'mcp_servers.computer={"), "{codex}");
        assert!(codex.contains(&"a".repeat(64)) && codex.contains("\"cua-driver\""));
        assert_eq!(agent_args("opencode", "docker", &"a".repeat(64), false), "");
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_container_is_never_reached_by_a_saved_selection() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("docker-fixture");
        let old = "a".repeat(64);
        let replacement = "b".repeat(64);
        let target = Target::LinuxContainer { runtime: Runtime::Docker, id: old.clone() };
        let fixture = |id: &str, running: bool, label: &str| {
            let value = serde_json::json!({"Id":id,"State":{"Running":running},"Config":{"Labels":{LABEL:label}}});
            // The fixture refuses name-based resolution on the execution path.
            let script = format!("#!/bin/sh\n[ \"$1\" = inspect ] && [ \"$4\" = {old} ] || exit 41\nprintf '%s\\n' '{}'\n", value);
            std::fs::write(&executable, script).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        };
        // Preserve the production three-second probe budget; allow scheduling
        // headroom for this subprocess fixture in the parallel workspace suite.
        fixture(&old, true, "1");
        validate_at(&executable, &target, Duration::from_secs(30)).unwrap();
        for harness in ["claude", "codex"] {
            let command = agent_args(harness, executable.to_str().unwrap(), &old, false);
            assert!(command.contains(&old));
            assert!(!command.contains(CONTAINER));
        }
        fixture(&replacement, true, "1");
        assert!(validate_at(&executable, &target, Duration::from_secs(30)).is_err());
        fixture(&old, false, "1");
        assert!(validate_at(&executable, &target, Duration::from_secs(30)).is_err());
        fixture(&old, true, "0");
        assert!(validate_at(&executable, &target, Duration::from_secs(30)).is_err());
        std::fs::remove_file(&executable).unwrap();
        assert!(validate_at(&executable, &target, Duration::from_secs(30)).is_err());
    }

    /// Against the machine's real Docker or Podman: `cargo test --lib container_vm -- --ignored`.
    #[test]
    #[ignore]
    fn starts_a_real_vm_an_agent_can_drive_then_stops_it() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("TERMINALX_HOME", home.path());
        let up = start().expect("start");
        assert_eq!(up.state, VmState::Running);
        let viewer = up.viewer.expect("viewer");
        assert_eq!(viewer.password.len(), 8);
        assert!(std::net::TcpStream::connect(("127.0.0.1", viewer.port)).is_ok());
        let docker = runtime().unwrap();
        let (target, _) = identity(&docker, Runtime::Docker).unwrap();
        assert!(launch_selected(&target, "claude", false).unwrap().contains("container-computer-stdio"));
        // What an agent's CLI runs, spoken to as MCP.
        let docker = runtime().unwrap();
        let mut child = Command::new(&docker)
            .args(["exec", "-i", "-u", "cua", "-e", "DISPLAY=:1", CONTAINER, "cua-driver", "mcp"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        {
            use std::io::Write;
            let stdin = child.stdin.as_mut().unwrap();
            for line in [
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_screen_size","arguments":{}}}"#,
            ] {
                writeln!(stdin, "{line}").unwrap();
            }
        }
        let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
        // The reply to request 2, past the handshake and any notification a warm driver sends first.
        let mut answer = String::new();
        for _ in 0..10 {
            answer.clear();
            std::io::BufRead::read_line(&mut reader, &mut answer).unwrap();
            if answer.contains("\"id\":2") {
                break;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        assert!(answer.contains("\"width\":1280"), "{answer}");
        assert!(call(&target, "get_screen_size", "{}").unwrap().contains("1280"));
        assert!(tools(&target, None).unwrap().contains("launch_app"));
        assert!(tools(&target, Some("launch_app")).unwrap().contains("urls"));
        assert!(call(&target, "bad tool", "{}").is_err());
        let shot = screenshot(&target, Some(home.path().join("s.png"))).unwrap();
        assert!(std::fs::read(&shot).unwrap().starts_with(b"\x89PNG"));
        let down = stop().expect("stop");
        assert_eq!(down.state, VmState::Stopped);
        assert!(launch_selected(&target, "claude", false).is_err());
        reset().expect("reset");
    }
}
