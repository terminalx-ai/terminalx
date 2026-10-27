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
    Ok(status())
}

/// Stop the VM; it keeps its state for the next start. Agents are no longer offered it.
pub fn stop() -> Result<VmStatus> {
    set_enabled(false)?;
    if let Some(path) = runtime() {
        if container_running(&path) == Some(true) {
            ours(&path)?;
            run(&path, &["stop", "-t", "5", CONTAINER], QUICK).context("stop the Local VM")?;
        }
    }
    Ok(status())
}

/// Throw the VM away; the next start makes a fresh one.
pub fn reset() -> Result<VmStatus> {
    set_enabled(false)?;
    if let Some(path) = runtime() {
        if container_running(&path).is_some() {
            ours(&path)?;
            run(&path, &["rm", "-f", CONTAINER], QUICK).context("remove the Local VM")?;
        }
    }
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

/// The running VM's runtime, or why there is none to use.
fn running() -> Result<PathBuf> {
    let path = runtime().context("Docker or Podman is not installed")?;
    if container_running(&path) != Some(true) {
        bail!("the Local VM is not running; start it with `terminalx vm start`");
    }
    Ok(path)
}

/// One computer-use tool, run by the VM's driver: what an agent without the
/// `computer` MCP server (started before the VM was) uses instead.
pub fn call(tool: &str, arguments: &str) -> Result<String> {
    if tool.is_empty() || !tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        bail!("unknown tool {tool:?}");
    }
    serde_json::from_str::<serde_json::Value>(arguments).context("the tool's arguments must be JSON")?;
    let path = running()?;
    run(&path, &["exec", "-u", "cua", "-e", "DISPLAY=:1", CONTAINER, "cua-driver", "call", tool, arguments], Duration::from_secs(120))
}

/// The driver's tools, or one tool's description and argument schema.
pub fn tools(tool: Option<&str>) -> Result<String> {
    let path = running()?;
    match tool {
        Some(tool) if !tool.is_empty() && tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
            run(&path, &["exec", "-u", "cua", CONTAINER, "cua-driver", "describe", tool], QUICK)
        }
        Some(tool) => bail!("unknown tool {tool:?}"),
        None => run(&path, &["exec", "-u", "cua", CONTAINER, "cua-driver", "list-tools"], QUICK),
    }
}

/// The VM's whole screen as a PNG on this machine, at `out` or in `~/.raccoon/computer/screens`.
pub fn screenshot(out: Option<PathBuf>) -> Result<PathBuf> {
    let path = running()?;
    let out = match out {
        // Absolute, so `docker cp` never reads it as `container:path` or `-` (stdout).
        Some(out) => std::path::absolute(&out).context("where to save the screenshot")?,
        None => crate::store::ensure_dir(crate::store::root()?.join("computer").join("screens"))?.join(format!("screen-{}.png", chrono::Utc::now().format("%Y%m%d-%H%M%S%3f"))),
    };
    let inside = "/tmp/terminalx-screen.png";
    run(&path, &["exec", "-u", "cua", CONTAINER, "ffmpeg", "-loglevel", "error", "-f", "x11grab", "-i", ":1", "-frames:v", "1", "-y", inside], QUICK).context("capture the screen")?;
    run(&path, &["cp", &format!("{CONTAINER}:{inside}"), &out.to_string_lossy()], QUICK).context("copy the screenshot out")?;
    Ok(out)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

const AGENT_NOTE: &str = "A Linux desktop (the TerminalX Local VM) is available through the `computer` MCP tools: screenshots, clicks, typing, launching apps such as Firefox. Use it whenever a task needs a VM, a desktop or a browser to check UI visually; never install or start another VM, desktop image, X server or VNC. Servers running on this machine are reached inside it at http://host.docker.internal:<port>, not localhost. The user may be watching it, or holding control of it. `terminalx skills get local-vm` has the details.";

/// What a new agent session's command line gains while the VM is on: the VM's
/// driver as an MCP server named `computer`, and a note saying how to reach
/// this machine's dev servers from it. Empty while it is off.
pub fn launch_args(harness: &str, appends_prompt: bool) -> String {
    if !load().enabled {
        return String::new();
    }
    let Some(path) = runtime() else { return String::new() };
    // Asked on every agent launch: a runtime that hangs costs it seconds, not the usual wait.
    if container_running_within(&path, Duration::from_secs(3)) != Some(true) {
        return String::new();
    }
    agent_args(harness, &path.to_string_lossy(), appends_prompt)
}

pub fn agent_args(harness: &str, runtime: &str, appends_prompt: bool) -> String {
    let args = ["exec", "-i", "-u", "cua", "-e", "DISPLAY=:1", CONTAINER, "cua-driver", "mcp"];
    match harness {
        "claude" => {
            let config = serde_json::json!({ "mcpServers": { "computer": { "command": runtime, "args": args } } });
            let mut out = format!(" --mcp-config {}", shell_quote(&config.to_string()));
            if !appends_prompt {
                out.push_str(&format!(" --append-system-prompt {}", shell_quote(AGENT_NOTE)));
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let claude = agent_args("claude", "/opt/homebrew/bin/docker", false);
        assert!(claude.starts_with(" --mcp-config '{\"mcpServers\":{\"computer\":{\"args\":[\"exec\",\"-i\""), "{claude}");
        assert!(claude.contains("\"command\":\"/opt/homebrew/bin/docker\""));
        assert!(claude.contains("--append-system-prompt") && claude.contains("host.docker.internal"));
        // A prompt the workspace already appends is not doubled.
        assert!(!agent_args("claude", "docker", true).contains("--append-system-prompt"));
        let codex = agent_args("codex", "/usr/local/bin/docker", false);
        assert!(codex.starts_with(" -c 'mcp_servers.computer={"), "{codex}");
        assert!(codex.contains("\"terminalx-computer\"") && codex.contains("\"cua-driver\""));
        assert_eq!(agent_args("opencode", "docker", false), "");
    }

    /// Against the machine's real Docker or Podman: `cargo test --lib local_vm -- --ignored`.
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
        assert!(launch_args("claude", false).contains("cua-driver"));
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
        assert!(call("get_screen_size", "{}").unwrap().contains("1280"));
        assert!(tools(None).unwrap().contains("launch_app"));
        assert!(tools(Some("launch_app")).unwrap().contains("urls"));
        assert!(call("bad tool", "{}").is_err());
        let shot = screenshot(Some(home.path().join("s.png"))).unwrap();
        assert!(std::fs::read(&shot).unwrap().starts_with(b"\x89PNG"));
        let down = stop().expect("stop");
        assert_eq!(down.state, VmState::Stopped);
        assert_eq!(launch_args("claude", false), "");
        reset().expect("reset");
    }
}
