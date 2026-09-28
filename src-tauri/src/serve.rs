//! `terminalx-serve`: the TerminalX backend without a window. A cloud
//! workspace boots this instead of the legacy Electron AppImage under Xvfb,
//! so the agents in the cloud run the same harnesses, hooks socket, control
//! socket, transcript store and git/worktree code as the desktop app.
//!
//! Not here yet:
//! - TODO(PRO-13): register with the relay as a host (outbound only) and serve
//!   the portable RPC surface from `BroadcastSink::subscribe`.
//! - TODO(PRO-12): redeem the one-time bootstrap token
//!   (`/v1/cloud-workspace-bootstrap/redeem` + `/refresh`) and persist the
//!   runtime identity atomically before registering.
//! - The `terminalx` agent CLI, which is still built into the desktop binary
//!   only; agents in a cloud workspace reach this runtime through its control
//!   socket.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde_json::json;

use crate::sink::{BroadcastSink, EventSink, NoObserver};

const USAGE: &str = "\
terminalx-serve — the headless TerminalX runtime

Usage: terminalx-serve [options]

Options:
  --project-root <dir>   Register <dir> as a project and run agents in it
  --data-dir <dir>       State directory (sessions, transcripts, sockets);
                         defaults to $TERMINALX_HOME, then ~/.raccoon
  --runtime-kind <kind>  local (default) or cloud-workspace; cloud-workspace
                         requires --project-root
  --self-test            Start, run one shell in a PTY, then exit
  -V, --version          Print the version
  -h, --help             Print this help

The agent CLIs' hooks call back into this binary as `terminalx-serve hook
<Event>` and `terminalx-serve statusline`.";

/// What the runtime is serving, reported by `status` on the control socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Local,
    CloudWorkspace,
}

impl RuntimeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::CloudWorkspace => "cloud-workspace",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub project_root: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub runtime_kind: RuntimeKind,
    pub self_test: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Serve(Options),
    Help,
    Version,
}

fn parse(args: &[String]) -> Result<Command> {
    let mut options = Options { project_root: None, data_dir: None, runtime_kind: RuntimeKind::Local, self_test: false };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = |name: &str| -> Result<String> {
            match inline.clone().or_else(|| args.next().cloned()) {
                Some(value) if !value.is_empty() => Ok(value),
                _ => bail!("{name} needs a value"),
            }
        };
        match flag {
            "-h" | "--help" => return Ok(Command::Help),
            "-V" | "--version" => return Ok(Command::Version),
            "--project-root" => options.project_root = Some(PathBuf::from(value(flag)?)),
            "--data-dir" => options.data_dir = Some(PathBuf::from(value(flag)?)),
            "--runtime-kind" => {
                options.runtime_kind = match value(flag)?.as_str() {
                    "local" => RuntimeKind::Local,
                    "cloud-workspace" => RuntimeKind::CloudWorkspace,
                    other => bail!("unknown runtime kind {other}; expected local or cloud-workspace"),
                }
            }
            "--self-test" if inline.is_none() => options.self_test = true,
            other => bail!("unknown argument {other}"),
        }
    }
    if options.runtime_kind == RuntimeKind::CloudWorkspace && options.project_root.is_none() {
        bail!("--runtime-kind cloud-workspace requires --project-root");
    }
    Ok(Command::Serve(options))
}

/// The binary's whole `main`. Returns the process exit code.
pub fn main() -> i32 {
    // A hook process is short lived and answers before anything else starts.
    if crate::hooks::run_statusline_cli() || crate::hooks::run_hook_cli() {
        return 0;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse(&args) {
        Ok(Command::Serve(options)) => options,
        Ok(Command::Help) => {
            println!("{USAGE}");
            return 0;
        }
        Ok(Command::Version) => {
            println!("terminalx-serve {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }
        Err(error) => {
            eprintln!("terminalx-serve: {error:#}\n\n{USAGE}");
            return 2;
        }
    };
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    match run(options) {
        Ok(()) => 0,
        Err(error) => {
            log::error!("terminalx-serve: {error:#}");
            1
        }
    }
}

/// Everything a running runtime owns; dropped in `shutdown`.
struct Runtime {
    sink: Arc<BroadcastSink>,
    host: Arc<crate::harness::host::Host>,
    terminals: Arc<crate::pty::Terminals>,
    project_root: Option<String>,
}

fn run(options: Options) -> Result<()> {
    // Every store path resolves from TERMINALX_HOME, so it is fixed before
    // anything reads it and before any thread starts.
    if let Some(dir) = &options.data_dir {
        std::fs::create_dir_all(dir).with_context(|| format!("create data dir {}", dir.display()))?;
        let dir = std::fs::canonicalize(dir).with_context(|| format!("resolve data dir {}", dir.display()))?;
        std::env::set_var("TERMINALX_HOME", &dir);
    }
    let data_dir = crate::store::root().context("open the state directory")?;
    let tokio = tokio::runtime::Builder::new_multi_thread().enable_all().build().context("start the async runtime")?;
    let _entered = tokio.enter();
    let runtime = start(&options)?;
    println!(
        "{}",
        json!({
            "type": "ready",
            "version": env!("CARGO_PKG_VERSION"),
            "runtimeKind": options.runtime_kind.as_str(),
            "projectRoot": runtime.project_root,
            "dataDir": data_dir,
            "socket": crate::hooks::socket_path().ok(),
        })
    );
    let outcome = if options.self_test {
        self_test(&runtime)
    } else {
        tokio.block_on(wait_for_shutdown_signal());
        Ok(())
    };
    shutdown(&runtime);
    println!("{}", json!({ "type": "stopped", "ok": outcome.is_ok() }));
    outcome
}

/// The desktop's `setup`, less everything that needs a window.
fn start(options: &Options) -> Result<Runtime> {
    let project_root = match &options.project_root {
        Some(root) => {
            let project = crate::store::projects::add(&root.to_string_lossy())
                .with_context(|| format!("register project {}", root.display()))?;
            Some(project.path)
        }
        None => None,
    };
    // Recover local history before hooks can publish live activity.
    if let Err(error) = crate::store::activity::summary() {
        log::error!("initialize activity history: {error:#}");
    }
    let sink = Arc::new(BroadcastSink::new(1024));
    let host = Arc::new(crate::harness::host::Host::new());
    let terminals = Arc::new(crate::pty::Terminals::new());
    let control_endpoint = crate::hooks::prepare_control()?;
    let manager = crate::session::SessionManager::new(
        sink.clone(),
        Arc::new(NoObserver),
        host.clone(),
        terminals.clone(),
        Arc::new(crate::harness::codex::models::Cache::default()),
        Arc::new(crate::status::StatusState::default()),
        control_endpoint.clone(),
    );
    manager.follow_pane_exits();
    let hooked = manager.clone();
    let service = crate::control::ControlService::headless(
        sink.clone(),
        manager.clone(),
        control_endpoint.clone(),
        options.runtime_kind.as_str().into(),
    );
    let socket = crate::hooks::serve(control_endpoint, move |frame| hooked.on_hook(frame), move |request| service.handle(request))
        .context("listen on the hook and control socket")?;
    log::info!("hook socket at {}", socket.display());
    crate::session::idle_orphaned_tabs();
    Ok(Runtime { sink, host, terminals, project_root })
}

fn shutdown(runtime: &Runtime) {
    runtime.host.kill_all();
    runtime.terminals.kill_all();
    if let Err(error) = crate::store::activity::shutdown() {
        log::error!("flush activity on exit: {error:#}");
    }
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(error) => {
                log::warn!("listen for SIGTERM: {error}");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    log::info!("shutting down");
}

const SELF_TEST_PANE: &str = "serve-self-test";
const SELF_TEST_TIMEOUT: Duration = Duration::from_secs(30);
const SELF_TEST_MARKER: &[u8] = b"terminalx-serve-42-ok";
const EXIT_DRAIN: Duration = Duration::from_secs(3);

/// Run the reader's login shell in a PTY, type one command into it and wait
/// for its answer and its exit: the same path an agent tab's CLI takes.
fn self_test(runtime: &Runtime) -> Result<()> {
    let mut events = runtime.sink.subscribe();
    let cwd = match &runtime.project_root {
        Some(root) => root.clone(),
        None => std::env::current_dir()?.to_string_lossy().into_owned(),
    };
    let sink: Arc<dyn EventSink> = runtime.sink.clone();
    let spec = crate::pty::PaneSpec { cwd: &cwd, cols: 80, rows: 24, command: None, env: &[] };
    runtime.terminals.spawn(sink, SELF_TEST_PANE, spec).context("spawn a shell PTY")?;
    // The marker only appears once the shell has evaluated the arithmetic;
    // the echoed input line carries the unexpanded form.
    runtime.terminals.write(SELF_TEST_PANE, b"echo terminalx-serve-$((6*7))-ok; exit 0\n")?;
    let deadline = Instant::now() + SELF_TEST_TIMEOUT;
    let mut output = Vec::new();
    // The exit is reported by the waiter thread, the last output by the
    // reader thread as it drains the PTY: after the exit, the output still
    // gets a moment to arrive.
    let mut exited: Option<(Option<i64>, Instant)> = None;
    loop {
        let answered = contains(&output, SELF_TEST_MARKER)
            || runtime.terminals.read_output(SELF_TEST_PANE).is_some_and(|scrollback| contains(&scrollback, SELF_TEST_MARKER));
        match exited {
            Some((code, _)) if answered => {
                if code != Some(0) {
                    bail!("the shell answered but exited with {code:?}");
                }
                println!("{}", json!({ "type": "self-test", "pty": "ok", "shell": crate::pty::shell() }));
                return Ok(());
            }
            Some((code, at)) if at.elapsed() >= EXIT_DRAIN => {
                bail!("the shell exited with {code:?} without answering; output: {}", String::from_utf8_lossy(&output));
            }
            _ => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("the shell did not answer and exit within {}s; output: {}", SELF_TEST_TIMEOUT.as_secs(), String::from_utf8_lossy(&output));
        }
        let wait = if exited.is_some() { remaining.min(Duration::from_millis(50)) } else { remaining };
        let Some(event) = events.blocking_recv_timeout(wait) else { continue };
        let payload: serde_json::Value = serde_json::from_str(&event.payload)?;
        if payload["id"] != SELF_TEST_PANE {
            continue;
        }
        match &*event.event {
            "pty_data" => {
                let chunk = base64::engine::general_purpose::STANDARD.decode(payload["data"].as_str().unwrap_or_default())?;
                output.extend_from_slice(&chunk);
            }
            "pty_exit" => {
                let code = payload["code"].as_i64();
                log::info!("self-test shell exited with {code:?}");
                exited = Some((code, Instant::now()));
            }
            _ => {}
        }
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

trait RecvTimeout {
    fn blocking_recv_timeout(&mut self, timeout: Duration) -> Option<crate::sink::Published>;
}

impl RecvTimeout for tokio::sync::broadcast::Receiver<crate::sink::Published> {
    /// Poll rather than block: the self-test runs on the main thread, outside
    /// the async runtime, and a lagging receiver just skips ahead.
    fn blocking_recv_timeout(&mut self, timeout: Duration) -> Option<crate::sink::Published> {
        use tokio::sync::broadcast::error::TryRecvError;
        let deadline = Instant::now() + timeout;
        loop {
            match self.try_recv() {
                Ok(event) => return Some(event),
                Err(TryRecvError::Lagged(skipped)) => log::warn!("self-test skipped {skipped} events"),
                Err(TryRecvError::Empty) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                Err(TryRecvError::Empty | TryRecvError::Closed) => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn parses_the_cloud_workspace_invocation() {
        let parsed = parse(&args(&["--project-root", "/workspace", "--data-dir=/var/lib/terminalx", "--runtime-kind", "cloud-workspace"])).unwrap();
        assert_eq!(
            parsed,
            Command::Serve(Options {
                project_root: Some("/workspace".into()),
                data_dir: Some("/var/lib/terminalx".into()),
                runtime_kind: RuntimeKind::CloudWorkspace,
                self_test: false,
            })
        );
    }

    #[test]
    fn defaults_to_a_local_runtime() {
        let Command::Serve(options) = parse(&[]).unwrap() else { panic!("expected serve") };
        assert_eq!(options.runtime_kind, RuntimeKind::Local);
        assert!(options.project_root.is_none() && options.data_dir.is_none() && !options.self_test);
    }

    #[test]
    fn rejects_bad_invocations() {
        assert!(parse(&args(&["--runtime-kind", "cloud-workspace"])).is_err());
        assert!(parse(&args(&["--runtime-kind", "mars"])).is_err());
        assert!(parse(&args(&["--project-root"])).is_err());
        assert!(parse(&args(&["--no-pairing"])).is_err());
        assert_eq!(parse(&args(&["--help", "--bogus"])).unwrap(), Command::Help);
    }
}
