//! `terminalx-serve`: the TerminalX backend without a window. A cloud
//! workspace boots this instead of the legacy Electron AppImage under Xvfb,
//! so the agents in the cloud run the same harnesses, hooks socket, control
//! socket, transcript store and git/worktree code as the desktop app.
//!
//! A cloud workspace runtime redeems its bootstrap token (or refreshes the
//! stored credential) before anything else starts; see `cloud_bootstrap`.
//! It then records its memory baseline (`memory_baseline`) and reports its
//! activity to the API so an unused workspace can be suspended
//! (`cloud_activity`).
//!
//! Not here yet:
//! - TODO(PRO-13): register with the relay as a host (outbound only) and serve
//!   the portable RPC surface from `BroadcastSink::subscribe`.
//! - The `terminalx` agent CLI, which is still built into the desktop binary
//!   only; agents in a cloud workspace reach this runtime through its control
//!   socket.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde_json::json;

use tokio::sync::broadcast::error::RecvError;

use crate::sink::{BroadcastSink, EventSink, NoObserver};

const USAGE: &str = "\
terminalx-serve — the headless TerminalX runtime

Usage: terminalx-serve [options]

Options:
  --project-root <dir>   Register <dir> as a project and run agents in it
  --data-dir <dir>       State directory (sessions, transcripts, sockets);
                         required unless $TERMINALX_HOME is set, so the
                         runtime never takes over the desktop app's ~/.raccoon
  --runtime-kind <kind>  local (default) or cloud-workspace; cloud-workspace
                         requires --project-root
  --relay-link <file>    Register with the relay as a host and serve the
                         workspace RPC (terminals, files, Git, sessions),
                         with the relay session read from a JSON file; for
                         local development and the relay integration test
                         (cloud workspaces get it from the bootstrap)
  --self-test            Start, run one shell in a PTY, then exit
  -V, --version          Print the version
  -h, --help             Print this help

A cloud-workspace runtime bootstraps from $TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_ORIGIN
and $TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_TOKEN_PATH when they are set. It exits
with 3 when the server rejects the token or credential for good.

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
    pub relay_link: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Serve(Options),
    Help,
    Version,
}

fn parse(args: &[String]) -> Result<Command> {
    let mut options =
        Options { project_root: None, data_dir: None, runtime_kind: RuntimeKind::Local, self_test: false, relay_link: None };
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
            "--relay-link" => options.relay_link = Some(PathBuf::from(value(flag)?)),
            "--self-test" if inline.is_none() => options.self_test = true,
            other => bail!("unknown argument {other}"),
        }
    }
    if options.runtime_kind == RuntimeKind::CloudWorkspace && options.project_root.is_none() {
        bail!("--runtime-kind cloud-workspace requires --project-root");
    }
    if options.relay_link.is_some() && options.project_root.is_none() {
        bail!("--relay-link requires --project-root: the relay serves one workspace");
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
            if error.downcast_ref::<crate::cloud_bootstrap::Rejected>().is_some() {
                crate::cloud_bootstrap::REJECTED_EXIT_CODE
            } else {
                1
            }
        }
    }
}

/// Everything a running runtime owns; dropped in `shutdown`.
struct Runtime {
    sink: Arc<BroadcastSink>,
    host: Arc<crate::harness::host::Host>,
    terminals: Arc<crate::pty::Terminals>,
    manager: crate::session::SessionManager,
    project_root: Option<String>,
}

fn run(options: Options) -> Result<()> {
    // Every store path resolves from TERMINALX_HOME, so it is fixed before
    // anything reads it and before any thread starts.
    if let Some(dir) = &options.data_dir {
        std::fs::create_dir_all(dir).with_context(|| format!("create data dir {}", dir.display()))?;
        let dir = std::fs::canonicalize(dir).with_context(|| format!("resolve data dir {}", dir.display()))?;
        std::env::set_var("TERMINALX_HOME", &dir);
    } else if crate::store::state_home_env().is_none() {
        // The default home belongs to the desktop app: its socket, control
        // token and tab statuses would all be taken over.
        bail!("pass --data-dir (or set TERMINALX_HOME); terminalx-serve will not share the desktop app's ~/.raccoon");
    }
    let data_dir = crate::store::root().context("open the state directory")?;
    // The identity comes first: nothing is served until the runtime knows
    // which workspace it is, and a rejected token stops here.
    let cloud = match options.runtime_kind {
        RuntimeKind::CloudWorkspace => bootstrap_cloud_workspace(&data_dir)?,
        RuntimeKind::Local => None,
    };
    let tokio = tokio::runtime::Builder::new_multi_thread().enable_all().build().context("start the async runtime")?;
    let _entered = tokio.enter();
    let runtime = start(&options)?;
    if let (Some((cloud, origin)), false) = (&cloud, options.self_test) {
        report_activity(&runtime, cloud.clone(), origin);
    }
    println!(
        "{}",
        json!({
            "type": "ready",
            "version": env!("CARGO_PKG_VERSION"),
            "runtimeKind": options.runtime_kind.as_str(),
            "projectRoot": runtime.project_root,
            "dataDir": data_dir,
            "socket": crate::hooks::socket_path().ok(),
            "cloudWorkspace": cloud.as_ref().map(|(cloud, _)| {
                let session = cloud.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                json!({
                    "workspaceId": session.workspace_id,
                    "relayHostId": session.relay_host_id,
                    "capabilities": [crate::cloud_bootstrap::CAPABILITIES],
                })
            }),
        })
    );
    // The relay host: from the bootstrap in a cloud workspace, or from a
    // link file in development and tests.
    let link: Option<Arc<dyn crate::remote::host::RuntimeLink>> = match (&options.relay_link, &cloud) {
        (Some(path), _) => Some(Arc::new(crate::remote::host::FileLink::open(path).context("open the relay link")?)),
        (None, Some((cloud, origin))) => Some(Arc::new(crate::remote::bootstrap_link::BootstrapLink::new(cloud.clone(), origin))),
        (None, None) => None,
    };
    // The self-test checks the local runtime only.
    if let (Some(link), Some(root), false) = (link, &runtime.project_root, options.self_test) {
        start_relay_host(&runtime, link, root, &data_dir);
    }
    let outcome = if options.self_test {
        self_test(&runtime, &tokio)
    } else {
        tokio.block_on(wait_for_shutdown_signal());
        Ok(())
    };
    shutdown(&runtime);
    println!("{}", json!({ "type": "stopped", "ok": outcome.is_ok() }));
    outcome
}

/// Redeem or refresh, then keep the session fresh in the background. The
/// relay host registers with this session once the runtime is up.
fn bootstrap_cloud_workspace(data_dir: &std::path::Path) -> Result<Option<(Arc<crate::cloud_bootstrap::Bootstrapped>, String)>> {
    use crate::cloud_bootstrap::{establish, Config, HttpApi, Policy};
    let Some(config) = Config::from_env(data_dir)? else {
        log::warn!("no cloud workspace bootstrap configured; serving without a cloud identity");
        return Ok(None);
    };
    let api = Arc::new(HttpApi::new(&config.origin));
    let cloud = Arc::new(establish(&config, api.as_ref(), &Policy::from_env())?);
    {
        let session = cloud.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        log::info!("cloud workspace {} bootstrapped as relay host {}", session.workspace_id, session.relay_host_id);
    }
    cloud.record_memory_baseline();
    cloud.clone().spawn_refresh_loop(api);
    Ok(Some((cloud, config.origin)))
}

/// Tell the API about agent turns, terminal input and attached clients, so
/// it suspends the workspace only when nobody uses it (`cloud_activity`).
fn report_activity(runtime: &Runtime, cloud: Arc<crate::cloud_bootstrap::Bootstrapped>, origin: &str) {
    use crate::cloud_activity::{note, spawn_reporter, Counts, Kind};
    // A turn that starts or produces output publishes one of these.
    for event in ["agent_work_started", "agent_event"] {
        runtime.sink.listen(event, Box::new(|_| note(Kind::AgentTurn)));
    }
    let manager = runtime.manager.clone();
    let counts = move || Counts {
        active_turns: manager.running_tabs().iter().filter(|tab| tab.status == crate::store::index::TabStatus::InProgress).count(),
        pending_approvals: manager.pending_permissions().len(),
    };
    let api = crate::cloud_bootstrap::HttpApi::new(origin);
    spawn_reporter(counts, move |report| match cloud.report_activity(&api, report) {
        Ok(()) => true,
        Err(error) => {
            log::warn!("report activity: {}", crate::cloud_bootstrap::describe(&error));
            false
        }
    });
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
    Ok(Runtime { sink, host, terminals, manager, project_root })
}

/// Serve the workspace through the relay in the background, and report
/// each registration state as a JSON line on stdout.
fn start_relay_host(runtime: &Runtime, link: Arc<dyn crate::remote::host::RuntimeLink>, root: &str, data_dir: &std::path::Path) {
    let sink = runtime.sink.clone();
    let terminals = runtime.terminals.clone();
    let manager = runtime.manager.clone();
    let root = PathBuf::from(root);
    let devices = data_dir.join("run").join("remote-devices.json");
    tokio::spawn(async move {
        let host = match crate::remote::host::serve_workspace(link, root, sink, terminals, Some(manager), Some(devices)).await {
            Ok(host) => host,
            Err(error) => {
                log::error!("relay host: {error:#}");
                return;
            }
        };
        let mut status = host.status();
        loop {
            let current = status.borrow_and_update().clone();
            if matches!(current, crate::remote::host::HostStatus::Registered { .. }) {
                crate::cloud_activity::registered();
            }
            println!("{}", json!({ "type": "relay", "status": current }));
            if status.changed().await.is_err() {
                return;
            }
        }
    });
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
fn self_test(runtime: &Runtime, tokio: &tokio::runtime::Runtime) -> Result<()> {
    let mut events = runtime.sink.subscribe();
    let cwd = match &runtime.project_root {
        Some(root) => root.clone(),
        None => std::env::current_dir()?.to_string_lossy().into_owned(),
    };
    let sink: Arc<dyn EventSink> = runtime.sink.clone();
    let spec = crate::pty::PaneSpec { cwd: &cwd, cols: 80, rows: 24, command: None, env: &[] };
    runtime.terminals.spawn(sink, SELF_TEST_PANE, spec).context("spawn a shell PTY")?;
    // The marker only appears once `sh` has evaluated the arithmetic; the
    // echoed input line carries the unexpanded form. The line itself is
    // valid in fish and nushell as well as POSIX shells.
    runtime.terminals.write(SELF_TEST_PANE, b"sh -c 'echo terminalx-serve-$((6*7))-ok'; exit 0\n")?;
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
        let event = match tokio.block_on(tokio::time::timeout(wait, events.recv())) {
            Ok(Ok(event)) => event,
            Ok(Err(RecvError::Lagged(skipped))) => {
                log::warn!("self-test skipped {skipped} events");
                continue;
            }
            Ok(Err(RecvError::Closed)) => bail!("the event stream closed"),
            Err(_elapsed) => continue,
        };
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
                relay_link: None,
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
