//! Authenticated JSON-lines control protocol shared by the desktop app and
//! the `terminalx` command-line client.

#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::hooks::ControlEndpoint;
use crate::recovery::RecoveryKind;
use crate::session::{PendingPermission, SessionManager, WaitView};
use crate::session_ops::{NewSession, NewTab};
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};
use crate::store::projects::{self, Project};

#[path = "review_control.rs"]
pub(crate) mod review;

const APP_UNAVAILABLE_RECOVERY: &str =
    "Open TerminalX with the same TERMINALX_HOME, then retry status once.";
const LINEAR_INTEGRATION_RECOVERY: &str =
    "Add an API key in TerminalX Settings → Integrations.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub id: String,
    #[serde(default)]
    pub token: String,
    pub command: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    /// The refusal's particulars for a caller that branches on them: the
    /// piece a plan rule names, the limit it broke. Most errors have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ControlError {
    pub fn new(
        code: &str,
        message: impl Into<String>,
        recovery: impl Into<Option<String>>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recovery: recovery.into(),
            details: None,
        }
    }

    /// An orchestration refusal, with its own code and particulars.
    fn of_run(error: crate::orchestration::engine::EngineError) -> Self {
        let details = (!error.details.is_null()).then_some(error.details);
        Self { code: error.code.into(), message: error.message, recovery: error.recovery, details }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(
            "invalid_arguments",
            message,
            Some("Run terminalx --help and correct the named argument.".into()),
        )
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(
            "not_found",
            message,
            Some("Refresh the relevant list and use a full id from its JSON output.".into()),
        )
    }

    fn ambiguous(message: impl Into<String>) -> Self {
        Self::new(
            "ambiguous_selector",
            message,
            Some("Use the full id or an exact project path.".into()),
        )
    }

    pub(crate) fn internal(error: impl std::fmt::Display) -> Self {
        Self::new(
            "internal",
            format!("{error:#}"),
            Some("Report this error and stop rather than guessing at app state.".into()),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

impl ControlResponse {
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: impl Into<String>, error: ControlError) -> Self {
        Self {
            id: id.into(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

/// Send one request to the running app. Socket and token resolution happen
/// here so every command has identical authentication and recovery behavior.
pub fn call(
    command: &str,
    mut params: Value,
    timeout: Duration,
) -> Result<ControlResponse, ControlError> {
    #[cfg(unix)]
    use std::os::unix::net::UnixStream;

    let socket = client_socket_path();
    #[cfg(unix)]
    if !socket.exists() {
        return Err(ControlError::new(
            "app_unavailable",
            format!("No running app is listening at {}.", socket.display()),
            Some(APP_UNAVAILABLE_RECOVERY.into()),
        ));
    }
    let token = std::env::var(crate::hooks::CONTROL_TOKEN_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::fs::read_to_string(client_token_path()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .ok_or_else(|| {
            ControlError::new(
                "unauthorized",
                "The control token is missing.",
                Some("Restart an app-launched tab, or let a human shell read TERMINALX_HOME/run/control.token.".into()),
            )
        })?;
    if command == "review.comment" {
        params["hookToken"] = json!(std::env::var(crate::hooks::TOKEN_ENV).unwrap_or_default());
    }
    let request = ControlRequest {
        id: uuid::Uuid::now_v7().to_string(),
        token,
        command: command.into(),
        params,
    };
    let mut bytes = serde_json::to_vec(&request).map_err(ControlError::internal)?;
    bytes.push(b'\n');
    #[cfg(unix)]
    let line = {
    let mut stream = UnixStream::connect(&socket).map_err(|e| {
        ControlError::new(
            "app_unavailable",
            format!("Could not connect to {}: {e}", socket.display()),
            Some(APP_UNAVAILABLE_RECOVERY.into()),
        )
    })?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(ControlError::internal)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(ControlError::internal)?;
    stream.write_all(&bytes).map_err(ControlError::internal)?;
    stream.flush().map_err(ControlError::internal)?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| {
        if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) {
            ControlError::new(
                "timeout",
                "The app did not answer before the client timeout.",
                Some("Check status before retrying a mutating command; it may already have completed.".into()),
            )
        } else {
            ControlError::internal(e)
        }
    })?;
        line
    };
    #[cfg(windows)]
    let line = crate::pipe_transport::exchange(&socket, bytes, timeout).map_err(|error| {
        let timed_out = error.kind() == std::io::ErrorKind::TimedOut;
        ControlError::new(if timed_out { "timeout" } else { "app_unavailable" },
            format!("Could not exchange a control frame at {}: {error}", socket.display()),
            Some(if timed_out { "Check status before retrying; the command may already have completed." } else { APP_UNAVAILABLE_RECOVERY }.into()))
    })?;
    let response: ControlResponse = serde_json::from_str(&line).map_err(|e| {
        ControlError::new(
            "protocol_error",
            format!("The app returned an unreadable control response: {e}"),
            Some("Update the app and CLI together, then retry status.".into()),
        )
    })?;
    if response.id != request.id {
        return Err(ControlError::new(
            "protocol_error",
            "The app response id did not match the request.",
            Some("Update the app and CLI together, then retry status.".into()),
        ));
    }
    Ok(response)
}

fn client_home() -> PathBuf {
    crate::store::state_home_env().map(std::ffi::OsString::from)
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".raccoon")))
        .unwrap_or_else(|| PathBuf::from(".raccoon"))
}

fn client_socket_path() -> PathBuf {
    std::env::var_os(crate::hooks::CONTROL_SOCKET_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            #[cfg(unix)]
            { client_home().join("run/hooks.sock") }
            #[cfg(windows)]
            { crate::pipe_transport::path_for_home(&client_home()) }
        })
}

fn client_token_path() -> PathBuf {
    client_home().join("run/control.token")
}

#[derive(Clone)]
pub struct ControlService {
    sink: Arc<dyn EventSink>,
    manager: SessionManager,
    endpoint: ControlEndpoint,
    /// Set by the headless runtime (`cloud-workspace`, `local`); the desktop
    /// app reports none.
    runtime_kind: Option<String>,
    local_lifetime: Option<Arc<crate::local_runtime::Lifetime>>,
    /// Asks the person before edits to an existing issue. Creation never asks.
    /// Only the desktop app has a window for edits that require confirmation.
    #[cfg(feature = "desktop")]
    questions: Option<crate::issue_control::Ask>,
    /// Computer use and the built-in browser; the headless runtime has neither.
    #[cfg(feature = "desktop")]
    desktop: Option<WindowControl>,
}

#[cfg(feature = "desktop")]
#[derive(Clone)]
pub(crate) struct WindowControl {
    sink: Arc<dyn EventSink>,
    questions: Option<crate::issue_control::Ask>,
    pairing: Option<Arc<crate::pairing::PairingManager>>,
    computer: Arc<crate::computer::ComputerService>,
    browser: std::sync::Arc<crate::browser::BrowserRuntime>,
}

#[cfg(feature = "desktop")]
impl WindowControl {
    pub(crate) fn new(sink: Arc<dyn EventSink>, computer: Arc<crate::computer::ComputerService>, browser: Arc<crate::browser::BrowserRuntime>) -> Self {
        Self { sink, computer, browser, pairing: None, questions: None }
    }

    #[cfg(unix)]
    pub(crate) fn serve(mut self, app: tauri::AppHandle, endpoint: ControlEndpoint, pairing: Arc<crate::pairing::PairingManager>, ask: crate::issue_control::Ask) -> anyhow::Result<()> {
        use tauri::Manager;
        self.pairing = Some(pairing);
        self.questions = Some(ask);
        crate::hooks::serve_private(endpoint, |_| crate::hooks::HookReply::refused("Agent hooks belong to the background owner."), move |request| {
            let result = (|| {
                let runtime = app.state::<crate::AppState>().runtime().ok_or_else(|| ControlError::new("desktop_unavailable","The desktop has no runtime attachment.",None::<String>))?;
                let attachment = runtime.attachment().map_err(ControlError::internal)?;
                let (command,params) = crate::local_runtime::window::receive(&request,&attachment)?;
                if matches!(command.as_str(),"window.open"|"window.quit"|"window.stopAllAndQuit") {
                    let action_app = app.clone();
                    let action_attachment = attachment.clone();
                    let action = command.clone();
                    app.run_on_main_thread(move || {
                        // Scheduling onto AppKit is another asynchronous boundary.
                        // Never apply an action from a replaced attachment.
                        let current = action_app.state::<crate::AppState>().runtime()
                            .and_then(|runtime|runtime.attachment().ok());
                        if !current.is_some_and(|current|current.epoch == action_attachment.epoch && current.lease == action_attachment.lease) { return; }
                        match action.as_str() {
                            "window.open" => crate::account::focus_main_window(&action_app),
                            "window.quit" => action_app.exit(0),
                            "window.stopAllAndQuit" => crate::quit::stop_all_and_quit(&action_app),
                            _ => unreachable!(),
                        }
                    }).map_err(ControlError::internal)?;
                    return Ok(json!({"requested":command}));
                }
                self.execute(&command,params,&request.id)
            })();
            match result {
                Ok(value) => ControlResponse::success(request.id,value),
                Err(error) => ControlResponse::failure(request.id,error),
            }
        })?;
        Ok(())
    }

    #[cfg(unix)]
    fn execute(&self, command: &str, params: Value, request_id: &str) -> Result<Value, ControlError> {
        if command == "environment.snapshot" {
            let key = params["key"].as_str().ok_or_else(|| ControlError::invalid("Environment scope required."))?;
            let revision = params["revision"].as_str().ok_or_else(|| ControlError::invalid("Environment revision required."))?;
            return crate::store::environment::desktop_snapshot(key, revision)
                .and_then(|snapshot| Ok(serde_json::to_value(snapshot)?)).map_err(|_| ControlError::internal("Environment overrides are unavailable."));
        }
        if command == "agentKey.snapshot" {
            let harness = params["harness"].as_str().ok_or_else(|| ControlError::invalid("Agent required."))?;
            let revision = params["revision"].as_str().ok_or_else(|| ControlError::invalid("Key revision required."))?;
            return crate::agent_keys::desktop_snapshot(harness, revision).map_err(|_| ControlError::internal("The agent's API key is unavailable."));
        }
        if let Some(action) = command.strip_prefix("share.") {
            let pairing = self.pairing.as_ref().ok_or_else(|| ControlError::internal("Sharing is unavailable."))?;
            let session = params["sessionId"].as_str().ok_or_else(|| ControlError::internal("Session id required."))?;
            return match action {
                "create" => {
                    let settings = serde_json::from_value(params["settings"].clone()).map_err(ControlError::internal)?;
                    tauri::async_runtime::block_on(pairing.create_share(session.into(), settings, params["directOnly"].as_bool().unwrap_or(false)))
                }
                "list" => pairing.share_status(session),
                action => pairing.change_share(session, action, params.clone()),
            }.map_err(ControlError::internal);
        }
        if let Some(method) = command.strip_prefix("computer.selfUi.") {
            return crate::self_ui::call(self.sink.as_ref(), self.questions.as_ref(), method, params);
        }
        if let Some(method) = command.strip_prefix("computer.") {
            return self.computer.call(method, params, request_id).map_err(computer_error);
        }
        if command.starts_with("browser.") { return crate::browser::control::handle(&self.browser, command, params); }
        if let Some(action) = command.strip_prefix("cloud.") {
            if action != "status" && !crate::cloud_control::enabled() { return Err(crate::cloud_control::disabled_error()); }
            let params = if action == "sessions.create" { cloud_issue_start(params)? } else { params };
            return crate::cloud_control::call(self.sink.as_ref(), action, params);
        }
        match command {
            "issues.view" | "issues.comment" | "issues.status" | "issues.assign" | "issues.label" => issue_operation(self.questions.as_ref(), command, params),
            "floating.show" | "floating.hide" | "floating.toggle" => {
                let action = command.trim_start_matches("floating.");
                self.sink.emit(crate::session_ops::FLOATING_REQUEST_EVENT, &json!({"action":action,"session":optional_string(&params,"session")}));
                Ok(json!({"requested":action}))
            }
            "perf.terminal.start" => {
                if !crate::terminal_perf::bench_enabled() {
                    return Err(ControlError::new("unsupported", "The terminal benchmark is off in this app.",
                        Some(format!("Launch a Dev build with {}=1; see docs/TERMINAL-PERFORMANCE.md.",crate::terminal_perf::BENCH_ENV))));
                }
                Ok(json!({"requestId":crate::terminal_perf::ask(self.sink.as_ref(),"bench",params)}))
            }
            "perf.terminal.poll" => {
                let id = required_string(&params,"requestId")?;
                match crate::terminal_perf::poll(&id) {
                    Ok(Some(result)) => Ok(json!({"done":true,"result":result})),
                    Ok(None) => Ok(json!({"done":false})),
                    Err(()) => Err(ControlError::not_found(format!("No terminal benchmark request {id}."))),
                }
            }
            "window.terminalCounters" => {
                let id = crate::terminal_perf::ask(self.sink.as_ref(),"counters",json!({}));
                Ok(crate::terminal_perf::wait(&id,crate::terminal_perf::COUNTERS_TIMEOUT).unwrap_or(Value::Null))
            }
            _ => Err(ControlError::invalid("This command is not a window service.")),
        }
    }
}

impl ControlService {
    /// The control service of `terminalx-serve`: sessions, tabs, permissions,
    /// worktrees and issues, without the desktop's computer use and browser.
    pub fn headless(
        sink: Arc<dyn EventSink>,
        manager: SessionManager,
        endpoint: ControlEndpoint,
        runtime_kind: String,
    ) -> Self {
        Self {
            sink,
            manager,
            endpoint,
            runtime_kind: Some(runtime_kind),
            local_lifetime: None,
            #[cfg(feature = "desktop")]
            questions: None,
            #[cfg(feature = "desktop")]
            desktop: None,
        }
    }

    pub fn handle(&self, request: ControlRequest) -> ControlResponse {
        let _github_request = crate::github_process::scope();
        let id = request.id.clone();
        let _request = match self.local_lifetime.as_ref().map(|lifetime| lifetime.enter_command(request.command == "runtime.stopAll")).transpose() {
            Ok(guard) => guard,
            Err(error) => return ControlResponse::failure(id, error),
        };
        match self.execute(&request.command, request.params, &id) {
            Ok(result) => ControlResponse::success(id, result),
            Err(error) => ControlResponse::failure(id, error),
        }
    }

    pub(crate) fn with_local_lifetime(mut self, lifetime: Arc<crate::local_runtime::Lifetime>) -> Self {
        self.local_lifetime = Some(lifetime);
        self
    }

    fn execute(&self, command: &str, params: Value, request_id: &str) -> Result<Value, ControlError> {
        #[cfg(unix)]
        if let Some(lifetime) = &self.local_lifetime {
            if command == "runtime.window.register" { return lifetime.window.register(lifetime, params); }
            if crate::local_runtime::window::supported(command) { return lifetime.window.call(command, params); }
        }
        if command.starts_with("runtime.") {
            if let Some(lifetime) = &self.local_lifetime {
                if command == "runtime.dataPrivacy.refresh" {
                    return serde_json::to_value(crate::data_privacy::owner_status(lifetime.epoch())).map_err(ControlError::internal);
                }
                if let Some(method) = command.strip_prefix("runtime.mobile.") {
                    return crate::local_runtime::mobile::execute(&self.manager, lifetime, method, params).map_err(ControlError::internal);
                }
                if let Some(method) = command.strip_prefix("runtime.sharing.") {
                    return crate::local_sharing::owner::execute(&self.manager, lifetime, method, params).map_err(ControlError::internal);
                }
                if matches!(command, "runtime.session.workspace" | "runtime.session.pipeline" | "runtime.session.create" | "runtime.session.rowStatuses" | "runtime.session.workspaceSetup" | "runtime.pty.githubLogin") {
                    // Missing/expired origin stamps still permit local facts,
                    // but never acquire today's authority after socket queues
                    // or a listener handover. Authentication preceded this.
                    let ticket = serde_json::from_value::<crate::data_privacy::Forwarding>(params["networkAuthority"].clone())
                        .ok().map(|authority| authority.admit(lifetime.epoch())).unwrap_or_else(crate::data_privacy::Ticket::denied);
                    return crate::github_process::with_ticket(ticket, ||
                        crate::local_runtime::calls::execute(&self.manager, &self.sink, command, params).map_err(ControlError::internal));
                }
                if command.starts_with("runtime.session.") || command.starts_with("runtime.pty.") {
                    return crate::local_runtime::calls::execute(&self.manager, &self.sink, command, params).map_err(ControlError::internal);
                }
                // What stopping this runtime now would cut short, and a stop
                // committed only when nothing would be: what a newer desktop
                // replacing it by itself needs (#730).
                if command == "runtime.work" {
                    return Ok(json!({ "work": self.manager.retire_work() }));
                }
                if command == "runtime.stopAllIfIdle" {
                    {
                        // No turn, start or send is admitted between the check and the stop.
                        let _admission = crate::issue_pipeline::admission::lock();
                        lifetime.stop_all_if(&params, || {
                            let work = self.manager.retire_work();
                            if work.is_empty() { return Ok(()); }
                            Err(ControlError::new("runtime_busy", format!("Stopping the runtime now would cut short {} piece(s) of work.", work.len()), None::<String>))
                        })?;
                        self.manager.begin_shutdown();
                    }
                    if let Err(error) = self.manager.stop_all_confirmed() {
                        lifetime.stop_failed();
                        return Err(ControlError::internal(error));
                    }
                    return Ok(json!({ "stopping": true }));
                }
                // Replacing this runtime in place, keeping everything it runs (#765).
                #[cfg(unix)]
                if command == "runtime.handover.plan" {
                    return crate::local_runtime::handover::plan(lifetime, &params);
                }
                #[cfg(unix)]
                if command == "runtime.handover" {
                    return crate::local_runtime::handover::begin(lifetime, params);
                }
                if command == "runtime.liveness" {
                    // What a desktop needs to find and watch this owner, and
                    // nothing that waits on a session, tab, terminal or share:
                    // a probe of a wedged owner must not become one more
                    // request held up behind it (#661).
                    let mut liveness = json!({ "pid": std::process::id(), "socket": self.endpoint.socket, "localRuntime": lifetime.status() });
                    if let Some(kind) = &self.runtime_kind { liveness["runtimeKind"] = json!(kind); }
                    return Ok(liveness);
                }
                let result = lifetime.command(command, params)?;
                if command == "runtime.stopAll" {
                    if let Err(error) = self.manager.stop_all_confirmed() {
                        lifetime.stop_failed();
                        return Err(ControlError::internal(error));
                    }
                }
                return Ok(result);
            }
        }
        #[cfg(all(feature = "desktop", unix))]
        if crate::local_runtime::window::supported(command) {
            if let Some(desktop) = &self.desktop { return desktop.execute(command, params, request_id); }
        }
        #[cfg(feature = "desktop")]
        if let Some(desktop) = &self.desktop {
            if let Some(action) = command.strip_prefix("share.") {
                let pairing = desktop.pairing.as_ref().ok_or_else(|| ControlError::internal("Sharing is unavailable."))?;
                let session = params["sessionId"].as_str().ok_or_else(|| ControlError::internal("Session id required."))?;
                let result = match action {
                    "create" => {
                        let settings = serde_json::from_value(params["settings"].clone()).map_err(ControlError::internal)?;
                        tauri::async_runtime::block_on(pairing.create_share(session.into(), settings, params["directOnly"].as_bool().unwrap_or(false)))
                    }
                    "list" => pairing.share_status(session),
                    action => pairing.change_share(session, action, params.clone()),
                };
                return result.map_err(ControlError::internal);
            }
            if let Some(method) = command.strip_prefix("computer.selfUi.") {
                return crate::self_ui::call(self.sink.as_ref(), self.questions.as_ref(), method, params);
            }
            if let Some(method) = command.strip_prefix("computer.") {
                // Computer-use errors keep their own codes: the skill guide
                // teaches recovery per code, so they must not collapse into
                // `internal`.
                return desktop
                    .computer
                    .call(method, params, request_id)
                    .map_err(computer_error);
            }
            if command.starts_with("browser.") {
                return crate::browser::control::handle(&desktop.browser, command, params);
            }
        }
        #[cfg(not(feature = "desktop"))]
        let _ = request_id;
        // Cloud workspaces (PRO-40): the window decides and acts, exactly as a
        // click there would. The headless runtime has no account and no window.
        if let Some(action) = command.strip_prefix("cloud.") {
            if !self.has_webview() {
                return Err(ControlError::new(
                    "unsupported",
                    format!("{command} needs the TerminalX desktop app, signed in."),
                    None::<String>,
                ));
            }
            // The person's switch is checked here, in native code, before the
            // window hears of the command. `status` still answers, to say so.
            if action != "status" && !crate::cloud_control::enabled() {
                return Err(crate::cloud_control::disabled_error());
            }
            let params = if action == "sessions.create" { cloud_issue_start(params)? } else { params };
            return crate::cloud_control::call(self.sink.as_ref(), action, params);
        }
        // The Local VM (`local_vm.rs`): its runtime's CLI does the work, so any TerminalX process can.
        if let Some(action) = command.strip_prefix("vm.") {
            let vm_error = |error: anyhow::Error| ControlError::new("vm_failed", format!("{error:#}"), Some("See `terminalx skills get local-vm`.".to_string()));
            let result = match action {
                "status" => Ok(json!(crate::local_vm::status())),
                "start" => crate::local_vm::start().map(|status| json!(status)).map_err(vm_error),
                "stop" => crate::local_vm::stop().map(|status| json!(status)).map_err(vm_error),
                "call" => {
                    let tool = params["tool"].as_str().unwrap_or_default();
                    let arguments = params["arguments"].as_str().unwrap_or("{}");
                    crate::local_vm::call(tool, arguments).map(|output| json!({"output": output})).map_err(vm_error)
                }
                "tools" => crate::local_vm::tools(params["tool"].as_str()).map(|output| json!({"output": output})).map_err(vm_error),
                "screenshot" => crate::local_vm::screenshot(params["out"].as_str().map(std::path::PathBuf::from)).map(|path| json!({"path": path})).map_err(vm_error),
                other => Err(ControlError::new("invalid_arguments", format!("Unknown vm command {other}."), None::<String>)),
            };
            if matches!(action, "start" | "stop") {
                self.sink.emit(crate::local_vm::CHANGED_EVENT, &json!({}));
            }
            return result;
        }
        if command.starts_with("computer.") || command.starts_with("browser.") {
            return Err(ControlError::new(
                "unsupported",
                format!("{command} needs the TerminalX desktop app; terminalx-serve has no browser or computer use."),
                None::<String>,
            ));
        }
        match command {
            "status" => {
                let (projects, _) = projects::list().map_err(ControlError::internal)?;
                let mut status = json!({
                    "appVersion": env!("CARGO_PKG_VERSION"),
                    "pid": std::process::id(),
                    "socket": self.endpoint.socket,
                    // Whether a shell with no app environment reaches this
                    // launch: false while another TerminalX holds the home.
                    "publishesHome": self.endpoint.publishes(),
                    "projects": projects,
                    "runningTabs": self.manager.running_tabs(),
                    "startupIncident": crate::startup::snapshot().ok().and_then(|state| state.active().cloned()).map(|incident| json!({
                        "id": incident.id, "detectedAt": incident.detected_at, "escalatedAt": incident.escalated_at,
                        "affectedLaunches": incident.launches.len(), "blockedPipelines": incident.blocked_pipelines,
                        "probePending": incident.probe.is_some_and(|probe| probe.result.is_none()),
                        "action": "Inspect Local startup diagnostics. Pending or host-blocked validation is not a pass."
                    })),
                });
                if let Some(kind) = &self.runtime_kind {
                    status["runtimeKind"] = json!(kind);
                }
                if let Some(lifetime) = &self.local_lifetime {
                    status["localRuntime"] = lifetime.status();
                }
                if let Some(grants) = crate::cloud_grants::status_json() {
                    status["agentGrants"] = grants;
                }
                if let Some(config) = crate::cloud_config::status_json() {
                    status["workspaceConfig"] = config;
                }
                status["terminals"] = self.terminal_status();
                Ok(status)
            }
            "perf.terminal.start" => {
                if !self.has_webview() || !crate::terminal_perf::bench_enabled() {
                    return Err(ControlError::new(
                        "unsupported",
                        "The terminal benchmark is off in this app.",
                        Some(format!("Launch a Dev build with {}=1; see docs/TERMINAL-PERFORMANCE.md.", crate::terminal_perf::BENCH_ENV)),
                    ));
                }
                let id = crate::terminal_perf::ask(self.sink.as_ref(), "bench", params);
                Ok(json!({ "requestId": id }))
            }
            "perf.terminal.poll" => {
                let id = required_string(&params, "requestId")?;
                match crate::terminal_perf::poll(&id) {
                    Ok(Some(result)) => Ok(json!({ "done": true, "result": result })),
                    Ok(None) => Ok(json!({ "done": false })),
                    Err(()) => Err(ControlError::not_found(format!("No terminal benchmark request {id}."))),
                }
            }
            "config.show" => {
                let project = optional_string(&params, "project").map(|selector| resolve_project(&selector)).transpose()?;
                let resolved = crate::store::configuration::view(project.as_ref().map(|p| p.path.as_str())).map_err(ControlError::internal)?;
                serde_json::to_value(resolved).map_err(ControlError::internal)
            }
            "projects.list" => {
                let (projects, last_selected) = projects::list().map_err(ControlError::internal)?;
                Ok(json!({"projects": projects, "lastSelected": last_selected}))
            }
            "sessions.list" => self.sessions_list(params),
            "sessions.show" => {
                let selector = required_string(&params, "session")?;
                let mut session = resolve_session(&selector)?;
                self.manager.annotate_row_statuses(std::slice::from_mut(&mut session));
                Ok(crate::session_usage::with_cost(&session))
            }
            // Tokens and estimated cost (PRO-273): read again from the
            // agents' transcripts, so a turn under way counts as far as it got.
            "sessions.usage" => self.sessions_usage(params),
            "sessions.create" => self.sessions_create(params),
            "sessions.report" => self.sessions_report(params),
            // Commands of their own, not switches on `sessions.list`: a
            // runtime that does not know them refuses, where one handed an
            // unknown switch would answer with every session there is.
            "sessions.children" => self.sessions_children(params),
            "sessions.stop" => self.sessions_stop(params),
            // The floating window is the desktop app's; the request is handed
            // to it as an event, so this service needs no window of its own.
            "floating.show" | "floating.hide" | "floating.toggle" => {
                if !self.has_webview() {
                    return Err(ControlError::new("unsupported", "The floating chat window needs the TerminalX desktop app; this runtime has no window.", None));
                }
                let action = command.trim_start_matches("floating.");
                self.sink.emit(crate::session_ops::FLOATING_REQUEST_EVENT, &json!({ "action": action, "session": optional_string(&params, "session") }));
                Ok(json!({ "requested": action }))
            }
            "sessions.rename" => {
                let session = resolve_session(&required_string(&params, "session")?)?;
                let title = params.get("title").and_then(Value::as_str)
                    .ok_or_else(|| ControlError::invalid("Missing title."))?.to_string();
                let patch = crate::session_ops::SessionPatch { title: Some(title), ..Default::default() };
                let session = crate::session_ops::update_session_meta(&session.id, &patch)
                    .map_err(ControlError::internal)?;
                self.sink.emit("session_updated", &session);
                Ok(json!({"sessionId": session.id, "session": session}))
            }
            "sessions.status" => {
                let status = serde_json::from_value::<index::ManualStatus>(params.get("status").cloned().unwrap_or(Value::Null))
                    .map_err(|_| ControlError::invalid("Status must be backlog, in_progress, in_review, done or canceled."))?;
                let session = resolve_session(&required_string(&params, "session")?)?;
                let patch = crate::session_ops::SessionPatch { manual_status: Some(status), ..Default::default() };
                let session = crate::session_ops::update_session_meta(&session.id, &patch).map_err(ControlError::internal)?;
                self.sink.emit("session_updated", &session);
                Ok(json!({"sessionId": session.id, "session": session}))
            }
            // The app's own archive (#718): the windows hear of it at once.
            "sessions.archive" | "sessions.unarchive" => {
                let selectors: Vec<String> = match params.get("sessions") {
                    Some(Value::Array(values)) => values.iter().map(|value| value.as_str().map(str::to_string).ok_or_else(|| ControlError::invalid("Each session must be a string."))).collect::<Result<_, _>>()?,
                    _ => return Err(ControlError::invalid("Missing sessions.")),
                };
                if selectors.is_empty() {
                    return Err(ControlError::invalid("Name at least one session."));
                }
                // Every selector is resolved before anything changes: one that
                // matches nothing, or more than one session, changes nothing.
                let ids = selectors.iter().map(|selector| resolve_session(selector).map(|session| session.id)).collect::<Result<Vec<_>, _>>()?;
                let archived = command == "sessions.archive";
                let sessions = crate::session_archive::set_archived(self.sink.as_ref(), &ids, archived, crate::session_archive::By::Person)
                    .map_err(ControlError::internal)?;
                Ok(json!({"sessions": sessions}))
            }
            "tabs.list" => {
                let selector = required_string(&params, "session")?;
                let session = resolve_session(&selector)?;
                Ok(json!({"sessionId": session.id, "tabs": session.tabs}))
            }
            "send" => {
                let target = resolve_target(&required_string(&params, "target")?)?;
                let text = required_string(&params, "text")?;
                let outcome = self
                    .manager
                    .send(&target.session.id, &target.tab.id, text, Vec::new())
                    .map_err(ControlError::internal)?;
                Ok(
                    json!({"sessionId": target.session.id, "tabId": target.tab.id, "outcome": outcome}),
                )
            }
            "read" => self.read(params),
            "wait" => self.wait(params),
            "permissions.list" => Ok(json!({"permissions": self.manager.pending_permissions()})),
            "permissions.allow" | "permissions.deny" => self.decide_permission(command, params),
            "worktrees.list" => self.worktrees_list(params),
            "worktrees.rename" => {
                let name = required_string(&params, "name")?;
                let (project, worktree) = resolve_worktree(&params)?;
                if !worktree.managed || worktree.is_main {
                    return Err(ControlError::invalid("Only TerminalX-managed worktrees can be renamed."));
                }
                let renamed = crate::session_ops::rename_workspace_entries(&project.path, &worktree.path, &name)
                    .map_err(workspace_error)?;
                crate::session_ops::notify_workspace_settled(&*self.sink, &project.path, &renamed.sessions);
                serde_json::to_value(renamed).map_err(ControlError::internal)
            }
            "worktrees.delete" => self.worktree_delete(params),
            "review.comment" | "review.comments" => self.review_comments(command, params),
            "issues.list" => self.issues_list(params),
            // Creation uses the local owner's credentials and never needs a
            // desktop attachment. Cloud workspace capabilities stay unchanged.
            "issues.create" if cfg!(feature = "desktop") || self.local_lifetime.is_some() => issue_operation(None, command, params),
            #[cfg(feature = "desktop")]
            "issues.view" | "issues.comment" | "issues.status" | "issues.assign" | "issues.label" => self.issue_op(command, params),
            #[cfg(not(feature = "desktop"))]
            "issues.view" | "issues.comment" | "issues.status" | "issues.assign" | "issues.label" | "issues.create" => Err(ControlError::new(
                "unsupported",
                format!("{command} needs the TerminalX desktop app; terminalx-serve lists issues only."),
                None::<String>,
            )),
            "pipelines.start" | "pipelines.list" | "pipelines.show" | "pipelines.autoMerge" | "pipelines.resolveConflicts" | "pipelines.act" if cfg!(feature = "desktop") || self.local_lifetime.is_some() => self.pipelines(command, params),
            // A run's workers are sessions of a project on this computer, each in a worktree of its own:
            // the desktop's runtime has those. A cloud workspace's runtime has one checkout, and says so.
            "runs.create" | "runs.start" | "runs.show" | "runs.list" | "runs.stop" | "runs.checkFailed" | "runs.merge" | "runs.sendBack" | "runs.takeOver" | "runs.finish" | "runs.widen" | "runs.note" | "runs.skip" | "runs.cleanup" if cfg!(feature = "desktop") || self.local_lifetime.is_some() => self.runs(command, params),
            "runs.create" | "runs.start" | "runs.show" | "runs.list" | "runs.stop" | "runs.checkFailed" | "runs.merge" | "runs.sendBack" | "runs.takeOver" | "runs.finish" | "runs.widen" | "runs.note" | "runs.skip" | "runs.cleanup" => Err(ControlError::new("unsupported", "Orchestration runs need projects on this computer: this runtime serves one cloud workspace.", None::<String>)),
            other => Err(ControlError::invalid(format!(
                "Unknown control command {other}."
            ))),
        }
    }

    /// Orchestration runs (`orchestration`): a lead's plan of pieces, and the
    /// workers started for them. There is no command to approve a run: the
    /// lead runs this CLI, and a person approves its plan in the app.
    fn runs(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::orchestration::{engine, host::ManagerHost, plan::Plan, store};
        let host = ManagerHost::new(self.sink.clone(), self.manager.clone());
        // The session the command runs in, when it runs in one the app knows.
        let caller = params["caller"]["session"].as_str().and_then(|id| index::get(id).ok());
        // A run's worker leads no run and steers none, its own lead's included: it may read them.
        if matches!(command, "runs.create" | "runs.start" | "runs.stop" | "runs.merge" | "runs.sendBack" | "runs.takeOver" | "runs.finish" | "runs.widen" | "runs.note" | "runs.skip" | "runs.cleanup") && caller.as_ref().is_some_and(crate::orchestration::guard::limited) {
            return Err(ControlError::new("forbidden", "A worker of an orchestration run does not create, start, stop, merge, steer or clean up a run. Report what is ready; the lead decides what happens next.", None::<String>));
        }
        if command == "runs.create" {
            let lead = match optional_string(&params, "lead") {
                Some(selector) => resolve_session(&selector)?,
                None => caller.clone().ok_or_else(|| ControlError::new("lead_required", "A run needs a lead session, and this command did not run inside one.", Some("Run it in the lead's session, or name the lead with --lead SESSION.".into())))?,
            };
            // The tab is the caller's own: `--lead` naming another session says nothing of which of its tabs leads.
            let tab = caller.filter(|caller| caller.id == lead.id).and_then(|_| params["caller"]["tab"].as_str()).filter(|tab| lead.tab(tab).is_some()).map(str::to_owned);
            let plan: Plan = crate::orchestration::plan::parse(&params["plan"]).map_err(|error| ControlError::of_run(error.into()))?;
            let run = engine::create(&host, &plan, &lead.id, tab).map_err(ControlError::of_run)?;
            // Said where the lead reads it: a piece whose tier has no installed model, and what it runs on instead.
            let notes: Vec<Value> = run.pieces.iter().filter_map(|piece| Some(json!({"piece": piece.id, "note": piece.model_note.as_deref()?}))).collect();
            return Ok(json!({"run": engine::shown(&run), "approvalRequired": run.state == crate::orchestration::RunState::AwaitingApproval, "notes": notes}));
        }
        if command == "runs.list" {
            let lead = optional_string(&params, "lead").map(|selector| resolve_session(&selector)).transpose()?;
            let all = params["all"].as_bool().unwrap_or(false);
            let runs: Vec<Value> = store::list()
                .map_err(ControlError::internal)?
                .into_iter()
                .filter(|run| lead.as_ref().is_none_or(|lead| run.lead.session_id == lead.id))
                .filter(|run| all || !run.state.ended())
                // Each as it is now: a piece follows its worker.
                .map(|run| engine::refreshed(&host, &run.id).map(|run| engine::shown(&run)).map_err(ControlError::of_run))
                .collect::<Result<_, _>>()?;
            return Ok(json!({"runs": runs}));
        }
        // A worker does not judge a piece, its own or another's: that is its lead's, and TerminalX's.
        let from_worker = caller.as_ref().is_some_and(|caller| caller.run_worker());
        let run = match optional_string(&params, "run") {
            Some(selector) => {
                let mut matching = store::matching(&selector).map_err(ControlError::internal)?;
                match matching.len() {
                    0 => return Err(ControlError::not_found(format!("No run matches {selector}."))),
                    1 => matching.remove(0),
                    _ => return Err(ControlError::ambiguous(format!("More than one run matches {selector}."))),
                }
            }
            // Inside the lead's session the run need not be named: it leads one at a time.
            None => caller.and_then(|caller| store::for_lead(&caller.id).ok().flatten()).ok_or_else(|| ControlError::invalid("Name the run: this command did not run inside a session that leads one. `terminalx runs list --all --json` lists them."))?,
        };
        match command {
            "runs.show" => Ok(engine::shown(&engine::refreshed(&host, &run.id).map_err(ControlError::of_run)?)),
            "runs.start" => {
                self.manager.accepting_work().map_err(ControlError::internal)?;
                let start = engine::start(&host, &run.id).map_err(ControlError::of_run)?;
                Ok(json!({"run": engine::shown(&start.run), "started": start.started, "waiting": start.waiting, "failed": start.failed}))
            }
            "runs.checkFailed" => {
                if from_worker {
                    return Err(ControlError::new("not_the_lead", "A run's worker does not report a done-check as failed. Say what does not hold in your own report: `partial` or `failed`.", None::<String>));
                }
                self.manager.accepting_work().map_err(ControlError::internal)?;
                let piece = optional_string(&params, "piece").ok_or_else(|| ControlError::invalid("Name the piece whose done-check failed."))?;
                let output = params["output"].as_str().unwrap_or_default();
                let failed = engine::check_failed(&host, &run.id, &piece, output).map_err(ControlError::of_run)?;
                Ok(json!({"run": engine::shown(&failed.run), "piece": failed.piece, "retried": failed.retried, "blocked": failed.blocked, "failed": failed.failed}))
            }
            // Git work TerminalX does itself: every accepted piece into the lead's branch, in
            // dependency order, the integration check after each. It pushes nothing.
            "runs.merge" => {
                self.manager.accepting_work().map_err(ControlError::internal)?;
                let mut options = crate::orchestration::merge::Options::new(engine::By::Cli);
                // Only the lead's own conversation is not waited for: its turn is the one asking.
                // A command from any other session waits for the lead's turn like everyone's.
                options.from_lead = params["caller"]["session"].as_str() == Some(run.lead.session_id.as_str())
                    && run.lead.tab_id.as_deref().is_none_or(|tab| params["caller"]["tab"].as_str() == Some(tab));
                options.skip = params["skip"].as_array().into_iter().flatten().filter_map(|piece| piece.as_str().map(str::to_owned)).collect();
                options.recheck = params["recheck"].as_bool().unwrap_or(false);
                let merged = crate::orchestration::merge::merge(&host, &run.id, &options).map_err(ControlError::of_run)?;
                let mut value = serde_json::to_value(&merged).map_err(ControlError::internal)?;
                value["run"] = engine::shown(&merged.run);
                Ok(value)
            }
            "runs.sendBack" => {
                self.manager.accepting_work().map_err(ControlError::internal)?;
                let piece = optional_string(&params, "piece").ok_or_else(|| ControlError::invalid("Name the piece to send back to its worker."))?;
                let sent = engine::send_back(&host, &run.id, &piece).map_err(ControlError::of_run)?;
                Ok(json!({"run": engine::shown(&sent.run), "piece": sent.piece, "freshWorker": sent.fresh_worker, "blocked": sent.blocked, "failed": sent.failed}))
            }
            // A blocked piece (PRO-361), as the Run view's four actions do it.
            "runs.takeOver" | "runs.finish" | "runs.widen" | "runs.note" | "runs.skip" => {
                let piece = optional_string(&params, "piece").ok_or_else(|| ControlError::invalid("Name the piece."))?;
                match command {
                    "runs.takeOver" => {
                        self.manager.accepting_work().map_err(ControlError::internal)?;
                        let run = engine::take_over(&host, &run.id, &piece, engine::By::Cli).map_err(ControlError::of_run)?;
                        Ok(json!({"run": engine::shown(&run), "piece": piece}))
                    }
                    "runs.finish" => {
                        self.manager.accepting_work().map_err(ControlError::internal)?;
                        let from_lead = params["caller"]["session"].as_str() == Some(run.lead.session_id.as_str());
                        let finished = engine::finish(&host, &run.id, &piece, engine::By::Cli, from_lead).map_err(ControlError::of_run)?;
                        Ok(json!({"run": engine::shown(&finished.run), "piece": finished.piece, "commit": finished.commit, "checks": finished.checks}))
                    }
                    "runs.widen" => {
                        self.manager.accepting_work().map_err(ControlError::internal)?;
                        let own: Vec<String> = params["own"].as_array().into_iter().flatten().filter_map(|path| path.as_str().map(str::to_owned)).collect();
                        let widened = engine::widen(&host, &run.id, &piece, &own, engine::By::Cli).map_err(ControlError::of_run)?;
                        Ok(json!({"run": engine::shown(&widened.run), "piece": widened.piece, "added": widened.added, "started": widened.started, "failed": widened.failed}))
                    }
                    "runs.note" => {
                        self.manager.accepting_work().map_err(ControlError::internal)?;
                        let text = params["text"].as_str().unwrap_or_default();
                        let run = engine::note(&host, &run.id, &piece, text, engine::By::Cli).map_err(ControlError::of_run)?;
                        Ok(json!({"run": engine::shown(&run), "piece": piece}))
                    }
                    _ => {
                        let skipped = engine::skip(&host, &run.id, &piece, engine::By::Cli).map_err(ControlError::of_run)?;
                        Ok(json!({"run": engine::shown(&skipped.run), "skipped": skipped.skipped}))
                    }
                }
            }
            "runs.cleanup" => {
                let cleaned = crate::orchestration::merge::cleanup(&host, &run.id, params["confirmed"].as_bool().unwrap_or(false)).map_err(ControlError::of_run)?;
                Ok(json!({"run": engine::shown(&cleaned.run), "removed": cleaned.removed, "refused": cleaned.refused}))
            }
            "runs.stop" => {
                let stop = engine::stop(&host, &run.id, engine::By::Cli).map_err(ControlError::of_run)?;
                Ok(json!({"run": engine::shown(&stop.run), "stopped": stop.stopped, "failed": stop.failed}))
            }
            other => Err(ControlError::invalid(format!("Unknown control command {other}."))),
        }
    }

    fn has_webview(&self) -> bool {
        #[cfg(feature = "desktop")]
        return self.desktop.is_some();
        #[cfg(not(feature = "desktop"))]
        false
    }

    /// What the terminals hold: the PTY side from here, and the xterm side
    /// from the webview when there is one and it answers in time.
    fn terminal_status(&self) -> Value {
        let mut terminals = json!({ "backend": self.manager.terminals().stats() });
        #[cfg(unix)]
        if let Some(lifetime) = &self.local_lifetime {
            terminals["webview"] = if lifetime.window.available() {
                lifetime.window.call("window.terminalCounters", json!({})).unwrap_or(Value::Null)
            } else { Value::Null };
            return terminals;
        }
        if self.has_webview() {
            let id = crate::terminal_perf::ask(self.sink.as_ref(), "counters", json!({}));
            terminals["webview"] = crate::terminal_perf::wait(&id, crate::terminal_perf::COUNTERS_TIMEOUT).unwrap_or(Value::Null);
        }
        terminals
    }

    fn sessions_list(&self, params: Value) -> Result<Value, ControlError> {
        let mut sessions = index::load().map_err(ControlError::internal)?;
        // Read once: which session on a branch carries its PR is chosen among all of them.
        let stored = sessions.clone();
        let quick = params.get("quick").and_then(Value::as_bool).unwrap_or(false);
        // What the sidebar lists, or with `archived` what it lists under Show archived (#718).
        let archived = params.get("archived").and_then(Value::as_bool).unwrap_or(false);
        // Every session in the worktree, by the rule `worktrees delete` uses:
        // whatever project it belongs to, quick chats and archived ones
        // included. `--project` only says whose worktree it is.
        if optional_string(&params, "worktree").is_some() {
            if quick || archived {
                return Err(ControlError::invalid("--worktree lists every session in the worktree, quick chats and archived ones included; it cannot be combined with --quick or --archived."));
            }
            let (project, worktree) = resolve_worktree(&params)?;
            let mut held = crate::worktree_control::sessions_in(&sessions, &worktree.path);
            self.manager.annotate_row_statuses_among(&mut held, &stored);
            let held: Vec<Value> = held.iter().map(crate::session_usage::with_cost).collect();
            return Ok(json!({"project": project.path, "worktree": worktree.path, "sessions": held}));
        }
        if let Some(selector) = optional_string(&params, "project") {
            if quick {
                return Err(ControlError::invalid("--quick and --project are mutually exclusive: a quick chat has no project."));
            }
            let project = resolve_project(&selector)?;
            // A session may name its project through a symlink or another
            // spelling of the same folder.
            sessions.retain(|s| s.project().is_some_and(|path| crate::worktree_control::same_folder(path, &project.path)));
        }
        if quick {
            sessions.retain(SessionEntry::is_quick);
        }
        sessions.retain(|session| session.archived == archived);
        self.manager.annotate_row_statuses_among(&mut sessions, &stored);
        let sessions: Vec<Value> = sessions.iter().map(crate::session_usage::with_cost).collect();
        Ok(json!({"sessions": sessions}))
    }

    /// `sessions usage <session>`, or `--children-of <lead>`: the lead's own
    /// usage, a row per worker it started, and the grand total of them all.
    fn sessions_usage(&self, params: Value) -> Result<Value, ControlError> {
        use crate::session_usage::{merge, refresh_session, session_json, total};
        let refresh = |id: &str| -> Result<SessionEntry, ControlError> {
            let (session, changed) = refresh_session(id).map_err(ControlError::internal)?;
            if changed {
                self.sink.emit("session_updated", &session);
            }
            Ok(session)
        };
        let Some(selector) = optional_string(&params, "childrenOf") else {
            let session = resolve_session(&required_string(&params, "session")?)?;
            return Ok(session_json(&refresh(&session.id)?));
        };
        let sessions = index::load().map_err(ControlError::internal)?;
        let lead = resolve_lead(&sessions, &selector)?;
        let own = if lead.exists { Some(refresh(&lead.session_id)?) } else { None };
        let workers = sessions
            .iter()
            .filter(|session| session.started_by(&lead.session_id))
            .map(|session| refresh(&session.id))
            .collect::<Result<Vec<_>, _>>()?;
        let everyone: Vec<&SessionEntry> = own.iter().chain(&workers).collect();
        let models = merge(everyone.iter().flat_map(|session| &session.tabs).filter_map(|tab| tab.usage.as_ref()).flat_map(|usage| &usage.models));
        Ok(json!({
            "parent": lead,
            "lead": own.as_ref().map(session_json),
            "workers": workers.iter().map(session_json).collect::<Vec<_>>(),
            "models": models,
            "total": total(&models),
            "estimate": true,
        }))
    }

    /// `sessions list --children-of`: the sessions a lead started (PRO-270),
    /// in every project and worktree, quick chats and archived ones included.
    fn sessions_children(&self, params: Value) -> Result<Value, ControlError> {
        let sessions = index::load().map_err(ControlError::internal)?;
        let lead = resolve_lead(&sessions, &required_string(&params, "childrenOf")?)?;
        let children: Vec<_> = sessions.into_iter().filter(|session| session.started_by(&lead.session_id)).collect();
        let workers: Vec<_> = children.iter().map(|session| self.worker(session)).collect();
        Ok(json!({"parent": lead, "workers": workers, "sessions": children}))
    }

    /// One row of `sessions list --children-of`: what a lead asks of a worker
    /// without reading its whole entry. Model, effort and status are those of
    /// the session's own agent, the first it was given.
    fn worker(&self, session: &SessionEntry) -> Value {
        let agents = || session.tabs.iter().filter(|tab| !tab.is_terminal());
        let tab = agents().min_by(|a, b| a.created.cmp(&b.created));
        json!({
            "sessionId": session.id, "title": session.title, "kind": session.kind,
            "tabId": tab.map(|tab| &tab.id), "agent": tab.map(|tab| &tab.harness),
            "status": tab.map(|tab| tab.status), "model": tab.map(|tab| &tab.model), "effort": tab.and_then(|tab| tab.effort.as_ref()),
            "running": agents().any(|tab| self.manager.is_running(&session.id, &tab.id)),
            "worktree": session.worktree_name, "path": session.cwd, "branch": session.branch,
            "archived": session.archived, "created": session.created, "parent": session.parent,
        })
    }

    /// `sessions stop --children-of`: stop every running agent of the
    /// sessions a lead started. As Stop in the window does, it ends the
    /// agent and keeps the conversation, which its next prompt resumes. A
    /// terminal, and an agent a person started by hand in one, are theirs
    /// and are left running. The lead itself is not touched.
    fn sessions_stop(&self, params: Value) -> Result<Value, ControlError> {
        let sessions = index::load().map_err(ControlError::internal)?;
        let lead = resolve_lead(&sessions, &required_string(&params, "childrenOf")?)?;
        let (mut stopped, mut failed, mut workers) = (Vec::new(), Vec::new(), 0);
        for session in sessions.iter().filter(|session| session.started_by(&lead.session_id)) {
            workers += 1;
            for tab in session.tabs.iter().filter(|tab| !tab.is_terminal() && !tab.by_hand()) {
                if !self.manager.is_running(&session.id, &tab.id) {
                    continue;
                }
                let row = json!({"sessionId": session.id, "tabId": tab.id, "title": session.title});
                match self.manager.stop(&session.id, &tab.id) {
                    Ok(()) => stopped.push(row),
                    // One that would not stop does not keep the rest running.
                    Err(error) => failed.push(json!({"sessionId": session.id, "tabId": tab.id, "title": session.title, "error": format!("{error:#}")})),
                }
            }
        }
        Ok(json!({"parent": lead, "workers": workers, "stopped": stopped, "failed": failed}))
    }

    fn sessions_create(&self, params: Value) -> Result<Value, ControlError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            /// Absent for a quick chat, which has none.
            #[serde(default)]
            project: Option<String>,
            /// A quick chat: no project, a scratch directory of its own.
            #[serde(default)]
            quick: bool,
            /// A folder for a quick chat to run in instead of its scratch directory.
            #[serde(default)]
            cwd: Option<String>,
            agent: String,
            #[serde(default)]
            experimental_codex_stdio: bool,
            /// Required, unless the session starts from an issue.
            #[serde(default)]
            prompt: String,
            /// A tracker issue to work on: its number, key or URL.
            #[serde(default)]
            issue: Option<String>,
            #[serde(default)]
            provider: Option<String>,
            /// The issue's "merge automatically" switch; the project's default when absent.
            #[serde(default)]
            auto_merge: Option<bool>,
            #[serde(default)]
            resolve_conflicts: Option<bool>,
            /// Start from the issue and stop at the code, as before pipelines.
            #[serde(default)]
            no_pipeline: bool,
            #[serde(default)]
            title: Option<String>,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            use_worktree: bool,
            #[serde(default)]
            on_main: bool,
            #[serde(default)]
            model: String,
            #[serde(default)]
            effort: Option<String>,
            #[serde(default)]
            mode: Option<String>,
            /// A worker: told to end with a report block, and held to it (`worker_report`).
            #[serde(default)]
            report: bool,
            /// `--parent`: the session to record as having started this one.
            #[serde(default)]
            parent: Option<String>,
            /// `--no-parent`: record none, whoever asks.
            #[serde(default)]
            no_parent: bool,
            /// Where the command ran, as the CLI found it in its environment.
            #[serde(default)]
            caller: Value,
        }
        let mut p: Params = serde_json::from_value(params)
            .map_err(|e| ControlError::invalid(format!("Invalid session request: {e}")))?;
        if p.report && (p.issue.is_some() || p.auto_merge.is_some() || p.resolve_conflicts.is_some()) {
            return Err(ControlError::invalid("--report is for a worker that answers the session that started it; a session with a pipeline (--issue, --auto-merge, --resolve-conflicts) reports to its pipeline instead."));
        }
        // A worker is reminded of its report where a turn's end is heard: the terminal engine, as for a pipeline's sessions.
        if p.report && (p.experimental_codex_stdio || !matches!(crate::harness::HarnessId::parse(&p.agent), crate::harness::HarnessId::Claude | crate::harness::HarnessId::Codex)) {
            return Err(ControlError::invalid("--report needs an agent in its own terminal (claude, or codex without --experimental-codex-stdio): no other can be reminded of its report. Start the session without --report; `terminalx sessions report` still reads its reply."));
        }
        // A blank mode is no mode: the tab takes the default launch mode.
        p.mode = crate::store::index::requested_mode(p.mode.take());
        if p.prompt.trim().is_empty() && p.issue.is_none() {
            return Err(ControlError::invalid("--prompt cannot be empty."));
        }
        if p.issue.is_none() && p.provider.is_some() {
            return Err(ControlError::invalid("--provider applies to a session started with --issue."));
        }
        if (p.auto_merge.is_some() || p.resolve_conflicts.is_some()) && (p.no_pipeline || p.on_main || p.quick) {
            return Err(ControlError::invalid("Pipeline switches need a project pipeline and a worktree: they cannot be combined with --no-pipeline, --on-main or --quick."));
        }
        if p.quick {
            if p.project.is_some() || p.name.is_some() || p.use_worktree || p.on_main || p.issue.is_some() {
                return Err(ControlError::invalid("A quick chat has no project, so --project, --name, --worktree, --on-main and --issue do not apply to it."));
            }
        } else {
            if p.project.is_none() {
                return Err(ControlError::invalid("Missing --project. Use --quick for a chat with no project."));
            }
            if p.cwd.is_some() {
                return Err(ControlError::invalid("--cwd is for a quick chat; a project session runs in its project or a worktree of it."));
            }
            validate_control_session_target(p.use_worktree, p.on_main)?;
            if p.name.is_some() && p.on_main {
                return Err(ControlError::invalid("--name requires a new worktree and cannot be used with --on-main."));
            }
        }
        // Settled before anything is created: a parent nobody knows must not
        // leave a session or a worktree behind.
        let parent = parent_of_new_session(p.parent.as_deref(), p.no_parent, &p.caller)?;
        let available = crate::harness::offered()
            .into_iter()
            .find(|h| h.id == p.agent)
            .ok_or_else(|| ControlError::invalid(format!("Agent {} is not offered.", p.agent)))?;
        if !available.available {
            return Err(ControlError::new(
                "agent_unavailable",
                format!("{} is not installed or not on PATH.", available.name),
                Some(available.install_hint),
            ));
        }
        if let Some(mode) = p.mode.as_deref() {
            if !matches!(
                mode,
                "plan" | "manual" | "auto" | "acceptEdits" | "bypassPermissions"
            ) {
                return Err(ControlError::invalid(format!(
                    "Unknown permission mode {mode}."
                )));
            }
        }
        if p.experimental_codex_stdio && (p.agent != "codex" || p.issue.is_some()) {
            return Err(ControlError::invalid("Experimental stdio requires a new Codex session without an issue pipeline."));
        }
        let mut first_tab = NewTab { transport: if p.experimental_codex_stdio { index::AgentTransport::ExperimentalCodexStdio } else { index::AgentTransport::Pty }, harness: p.agent, model: p.model, effort: p.effort, permission_mode: p.mode };
        // Without the flag, Settings → Experimental → Native Codex decides.
        if !p.experimental_codex_stdio { crate::session_ops::prefer_native_codex(&mut first_tab, p.issue.is_some() || p.report); }
        let mut issue = None;
        let entry = match p.project.as_deref() {
            None => {
                // The title a quick chat started from the window gets: the prompt's first line.
                let title = p.title.or_else(|| p.prompt.trim().lines().next().map(|line| line.chars().take(60).collect()));
                let quick = crate::session_ops::NewQuickChat { section_id: None, title, cwd: p.cwd, tab: Some(first_tab), parent };
                crate::session_ops::create_quick_chat_blocking(&*self.sink, quick).map_err(ControlError::invalid)?
            }
            Some(selector) => {
                let project = resolve_project(selector)?;
                // The tracker is asked before anything is created: an issue
                // that cannot be read must not leave a worktree behind.
                if let Some(reference) = p.issue.as_deref() {
                    if !cfg!(feature = "desktop") && self.local_lifetime.is_none() {
                        return Err(ControlError::new("unsupported", "This runtime cannot start a local issue session.", Some("Start it from the Issues page, or update TerminalX.".into())));
                    }
                    issue = Some(issue_for_session(&project.path, reference, p.provider.as_deref())?);
                }
                crate::session_ops::create_named_session_blocking(
                    &*self.sink,
                    NewSession {
                        parent,
                        section_id: None,
                        project_path: project.path,
                        title: p.title,
                        use_worktree: p.use_worktree,
                        on_main: p.on_main,
                        checkout_branch: None,
                        checkout_pr: None,
                        base_ref: None,
                        worktree_name: None,
                        issue: issue.as_ref().map(|issue| issue.reference.clone()),
                        automation: None,
                        cwd: None,
                        tab: Some(first_tab),
                        orchestrate: false,
                    },
                    p.name.as_deref(),
                )
                .map_err(workspace_error)?
            }
        };
        // A session a run's worker starts has the worker's limits, whoever it names as its
        // parent, or none: marked before anything is sent to it (`orchestration::guard`).
        let mut entry = entry;
        if !entry.run_worker() && p.caller["session"].as_str().and_then(|id| index::get(id).ok()).is_some_and(|caller| crate::orchestration::guard::limited(&caller)) {
            entry = index::update_session(&entry.id, |session| {
                session.mark_run_worker();
                Ok(session.clone())
            })
            .map_err(ControlError::internal)?;
        }
        let tab = entry
            .tabs
            .first()
            .cloned()
            .ok_or_else(|| ControlError::internal("the new session has no tab"))?;
        // From an issue the prompt is the issue itself, with anything the
        // caller added after it, and the pipeline's brief last.
        let mut prompt = match &issue {
            Some(issue) if p.prompt.trim().is_empty() => issue.prompt.clone(),
            Some(issue) => format!("{}\n\n{}", issue.prompt, p.prompt.trim()),
            None => p.prompt,
        };
        let mut pipeline = Value::Null;
        let mut pipeline_note = Value::Null;
        // A session not started from an issue gets a pipeline only where the project turned a switch on.
        let pipeline_default = crate::store::projects::issue_pipeline_settings(&entry.project_path).is_ok_and(|settings| settings.enabled && (settings.auto_merge == Some(true) || settings.resolve_conflicts == Some(true)));
        // A worker hands its result to its lead, not to a pipeline of its own.
        if (issue.is_some() || p.auto_merge.is_some() || p.resolve_conflicts.is_some() || pipeline_default) && !p.no_pipeline && !p.report {
            match self.start_pipeline(&entry.id, &tab.id, p.auto_merge, p.resolve_conflicts, issue.as_ref().and_then(|issue| issue.body.as_deref())) {
                Ok((started, brief)) => {
                    prompt = format!("{prompt}\n\n{brief}");
                    pipeline = started;
                }
                // The session still starts; it just ends at the code, and says why.
                Err(reason) => pipeline_note = json!(reason),
            }
        }
        let mut report_note = Value::Null;
        if p.report {
            // Recorded before the prompt goes: the turn it starts may end first.
            // The session exists by now, so it still starts if this cannot be
            // written; it is told how to report and just is not reminded, and says so.
            if let Err(error) = crate::worker_report::expect(&entry.id, &tab.id) {
                log::warn!("record that {}/{} owes a report: {error:#}", entry.id, tab.id);
                report_note = json!(format!("The session was told how to report, but TerminalX could not record that it owes one ({error:#}), so it will not be reminded."));
            }
            prompt = format!("{prompt}\n\n{}", crate::worker_report::brief());
        }
        let outcome = self
            .manager
            .send(&entry.id, &tab.id, prompt, Vec::new())
            .map_err(ControlError::internal)?;
        let mut created = json!({"sessionId": entry.id, "tabId": tab.id, "title": entry.title, "kind": entry.kind,
            "worktreeName": entry.worktree_name, "branch": entry.branch, "path": entry.cwd, "parent": entry.parent,
            "session": entry, "outcome": outcome, "pipeline": pipeline, "pipelineNote": pipeline_note});
        // Only a worker's start says so; every other response is word for word what it was.
        if p.report {
            created["report"] = json!(true);
            created["reportNote"] = report_note;
        }
        Ok(created)
    }

    /// The report a tab's last turn ended with (`worker_report`).
    fn sessions_report(&self, params: Value) -> Result<Value, ControlError> {
        if params.get("childrenOf").is_some() {
            return self.sessions_reports(params);
        }
        let target = resolve_target(&required_string(&params, "session")?)?;
        let events = self.manager.load_events(&target.session.id, &target.tab.id).map_err(ControlError::internal)?;
        Ok(self.report_of(&target.session.id, &target.tab.id, &events))
    }

    /// What `tab`'s last turn reported, as `sessions report` returns it.
    fn report_of(&self, session_id: &str, tab_id: &str, events: &[crate::events::AgentEvent]) -> Value {
        // Held to a report, and so reminded of one: asked for it at its start, and no pipeline's tab.
        let owed = crate::worker_report::expected(session_id, tab_id) && !crate::issue_pipeline::store::takes_part(session_id, tab_id);
        let mut report = crate::worker_report::of_tab(events, open_turn(&self.manager.wait_view(session_id, tab_id)), owed);
        report["sessionId"] = json!(session_id);
        report["tabId"] = json!(tab_id);
        report
    }

    /// `sessions report --children-of`: one report row for each session a
    /// lead started, the sessions `sessions list --children-of` lists. A row
    /// is read from the worker's own agent, the first it was given, which is
    /// the one `--report` holds to a report. One worker that cannot be read
    /// does not hide the others: its row is `missing` and says why.
    fn sessions_reports(&self, params: Value) -> Result<Value, ControlError> {
        let sessions = index::load().map_err(ControlError::internal)?;
        let lead = resolve_lead(&sessions, &required_string(&params, "childrenOf")?)?;
        let reports: Vec<Value> = sessions.iter().filter(|session| session.started_by(&lead.session_id)).map(|session| {
            let tab = session.tabs.iter().filter(|tab| !tab.is_terminal()).min_by(|a, b| a.created.cmp(&b.created));
            let mut row = match tab {
                Some(tab) => match self.manager.load_events(&session.id, &tab.id) {
                    Ok(events) => self.report_of(&session.id, &tab.id, &events),
                    Err(error) => json!({"status": "missing", "reason": "unreadable", "detail": format!("{error:#}"), "sessionId": session.id, "tabId": tab.id}),
                },
                None => json!({"status": "missing", "reason": "noAgent", "detail": "This session has no agent tab.", "sessionId": session.id, "tabId": null}),
            };
            row["title"] = json!(session.title);
            row
        }).collect();
        Ok(json!({"parent": lead, "reports": reports}))
    }

    fn pipeline_host(&self) -> crate::issue_pipeline::host::LocalHost {
        crate::issue_pipeline::host::LocalHost::new(self.sink.clone(), self.manager.clone())
    }

    /// Start the issue pipeline for a new session: the pipeline and what the
    /// author's first prompt must carry for it, or why there is none.
    fn start_pipeline(&self, session_id: &str, tab_id: &str, auto_merge: Option<bool>, resolve_conflicts: Option<bool>, issue_body: Option<&str>) -> Result<(Value, String), String> {
        if !cfg!(feature = "desktop") && self.local_lifetime.is_none() { return Err("Issue pipelines need a local desktop owner.".into()); }
        let pipeline = crate::issue_pipeline::engine::start_with_switches(&self.pipeline_host(), session_id, tab_id, auto_merge, resolve_conflicts, issue_body).map_err(|error| format!("{error:#}"))?;
        Ok((json!(pipeline), crate::issue_pipeline::prompts::author_brief()))
    }

    fn pipelines(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::issue_pipeline::{engine, store};
        // A run's worker changes no pipeline, its own or anyone's: each of these can push a
        // branch, merge it, or let a merge through (`orchestration::guard`). It may still read them.
        if !matches!(command, "pipelines.list" | "pipelines.show") && params["caller"]["session"].as_str().and_then(|id| index::get(id).ok()).is_some_and(|caller| crate::orchestration::guard::limited(&caller)) {
            return Err(ControlError::new("forbidden", "A worker of an orchestration run does not start, steer or merge a pipeline. Report what is ready; the lead decides what happens to it.", None::<String>));
        }
        if command == "pipelines.start" {
            let target = resolve_target(&required_string(&params, "target")?)?;
            self.manager.accepting_work().map_err(ControlError::internal)?;
            let pipeline = engine::start_existing(&self.pipeline_host(), &target.session.id, &target.tab.id,
                params["autoMerge"].as_bool(), params["resolveConflicts"].as_bool(), params["adoptPr"].as_bool().unwrap_or(false),
                crate::issue_pipeline::SwitchActor::Cli {
                    session_id: params["caller"]["session"].as_str().map(str::to_owned),
                    tab_id: params["caller"]["tab"].as_str().map(str::to_owned),
                }).map_err(ControlError::internal)?;
            return Ok(json!({"pipeline": pipeline, "authorBrief": crate::issue_pipeline::prompts::author_brief()}));
        }
        if command == "pipelines.list" {
            let mut pipelines = store::list().map_err(ControlError::internal)?;
            if let Some(selector) = optional_string(&params, "project") {
                let project = resolve_project(&selector)?;
                pipelines.retain(|pipeline| pipeline.project_path == project.path);
            }
            return Ok(json!({"pipelines": pipelines}));
        }
        let project = optional_string(&params, "project").map(|selector| resolve_project(&selector)).transpose()?;
        let pipeline = resolve_pipeline(&required_string(&params, "pipeline")?, project.as_ref())?;
        let host = self.pipeline_host();
        let changed = match command {
            "pipelines.show" => Ok(pipeline),
            "pipelines.autoMerge" | "pipelines.resolveConflicts" => {
                let value = params.get("value").and_then(Value::as_bool).ok_or_else(|| ControlError::invalid("Say on or off."))?;
                // Caller metadata is attribution only; it grants no merge authority.
                let actor = crate::issue_pipeline::SwitchActor::Cli {
                    session_id: params["caller"]["session"].as_str().map(str::to_owned),
                    tab_id: params["caller"]["tab"].as_str().map(str::to_owned),
                };
                if command == "pipelines.autoMerge" { engine::set_auto_merge_by(&host, &pipeline.id, value, actor) }
                else { engine::set_resolve_conflicts_by(&host, &pipeline.id, value, actor) }
            }
            "pipelines.act" => {
                let action: engine::Action = serde_json::from_value(params.get("action").cloned().unwrap_or(Value::Null)).map_err(|_| ControlError::invalid("Unknown pipeline action."))?;
                engine::act_from_agent(&host, &pipeline.id, action)
            }
            other => return Err(ControlError::invalid(format!("Unknown control command {other}."))),
        }
        .map_err(ControlError::internal)?;
        Ok(json!({"pipeline": changed}))
    }

    fn read(&self, params: Value) -> Result<Value, ControlError> {
        let target = resolve_target(&required_string(&params, "target")?)?;
        let since = params.get("since").and_then(Value::as_u64);
        let tail = params
            .get("tail")
            .and_then(Value::as_u64)
            .map(|v| v as usize);
        let mut events = self
            .manager
            .load_events(&target.session.id, &target.tab.id)
            .map_err(ControlError::internal)?;
        if let Some(seq) = since {
            events.retain(|event| event.seq > seq);
        }
        if let Some(count) = tail {
            let keep_from = events.len().saturating_sub(count);
            events.drain(..keep_from);
        }
        Ok(json!({"sessionId": target.session.id, "tabId": target.tab.id, "events": events}))
    }

    fn wait(&self, params: Value) -> Result<Value, ControlError> {
        if params.get("childrenOf").is_some() {
            return self.wait_children(params);
        }
        if params.get("targets").is_some() {
            return self.wait_many(params);
        }
        let target = resolve_target(&required_string(&params, "target")?)?;
        let timeout = params
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(600)
            .min(86_400);
        let deadline = Instant::now() + Duration::from_secs(timeout);
        // It only waits and reads: a runtime that replaces this one answers
        // it afresh, and a handover need not wait for it (#765).
        let _resumable = crate::hooks::resumable();
        loop {
            if self.local_lifetime.as_ref().is_some_and(|lifetime| lifetime.is_stopping()) {
                return Err(ControlError::new("runtime_stopping", "The local runtime is stopping.", None::<String>));
            }
            let view = self.manager.wait_view(&target.session.id, &target.tab.id);
            if let Some(end) = wait_end(&view) {
                let mut result = json!({"sessionId": target.session.id, "tabId": target.tab.id, "reason": end.reason(), "status": view.status});
                if let WaitEnd::Recovery(kind) = end {
                    result["recovery"] = json!(kind);
                }
                return Ok(result);
            }
            if Instant::now() >= deadline {
                return Ok(
                    json!({"sessionId": target.session.id, "tabId": target.tab.id, "reason": "timeout", "status": view.status}),
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// `wait --children-of` (PRO-328): `wait_many` on the sessions a lead
    /// started, as `sessions list --children-of` finds them (archived ones and
    /// quick chats included). They are found once, when the call begins; a
    /// session the lead starts later is not waited on. A lead with none has
    /// nothing to wait for, which is an answer, not an error.
    fn wait_children(&self, mut params: Value) -> Result<Value, ControlError> {
        let mode = optional_string(&params, "mode").unwrap_or_else(|| "any".into());
        let listed = self.sessions_children(json!({"childrenOf": required_string(&params, "childrenOf")?}))?;
        // A lead whose run is under way waits on the run, not on each worker's turn.
        if let Some(run) = listed["parent"]["sessionId"].as_str().and_then(|lead| crate::orchestration::store::open_for_lead(lead).ok().flatten()).filter(|run| run.state == crate::orchestration::RunState::Running) {
            return self.wait_run(&run.id, &mode, &params);
        }
        let workers: Vec<Value> = listed["sessions"].as_array().into_iter().flatten().map(|session| session["id"].clone()).collect();
        if workers.is_empty() {
            return Ok(json!({"mode": mode, "timedOut": false, "targets": [], "reason": "nothing to wait for: that session started no sessions"}));
        }
        params["targets"] = json!(workers);
        self.wait_many(params)
    }

    /// `wait --children-of` for a lead whose orchestration run is under way
    /// (PRO-278): it returns when the run has something for the lead
    /// (`orchestration::engine::wake`), not each time a worker's turn ends. A
    /// worker's `done` is checked by the app first, and a result that fails a
    /// check goes back to a fresh worker without the lead, so a run costs its
    /// lead about one turn for each piece settled.
    ///
    /// The stored run is what is watched: a worker's or a verifier's turn
    /// ending and the gates finishing each write it. It is brought up to date
    /// from the transcripts now and then as well, for a worker that stopped
    /// on a request nobody answered, which ends no turn.
    fn wait_run(&self, run_id: &str, mode: &str, params: &Value) -> Result<Value, ControlError> {
        use crate::orchestration::{engine, host::ManagerHost, store};
        if !matches!(mode, "any" | "all") {
            return Err(ControlError::invalid(format!("mode takes any or all, not {mode}.")));
        }
        let host = ManagerHost::new(self.sink.clone(), self.manager.clone());
        let timeout = params.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(600).min(86_400);
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let _resumable = crate::hooks::resumable();
        // What the lead last saw is at least this old: a piece settled since then wakes it at once
        // only through `ready` or the run's end, which a missed change always shows up as.
        let began = engine::refreshed(&host, run_id).map_err(ControlError::of_run)?;
        let mut read = Instant::now();
        loop {
            if self.local_lifetime.as_ref().is_some_and(|lifetime| lifetime.is_stopping()) {
                return Err(ControlError::new("runtime_stopping", "The local runtime is stopping.", None::<String>));
            }
            let now = if read.elapsed() >= Duration::from_secs(5) {
                read = Instant::now();
                engine::refreshed(&host, run_id).map_err(ControlError::of_run)?
            } else {
                store::get(run_id).map_err(ControlError::internal)?
            };
            let timed_out = Instant::now() >= deadline;
            if let Some(mut woken) = engine::wake(&began, &now, mode == "all").or_else(|| timed_out.then(|| json!({"run": now.id, "state": now.state, "why": [], "ready": [], "pieces": now.pieces.iter().map(|piece| json!({"piece": piece.id, "state": piece.state, "changed": false, "note": piece.note})).collect::<Vec<_>>()}))) {
                woken["mode"] = json!(mode);
                woken["timedOut"] = json!(timed_out && woken["why"].as_array().is_none_or(|why| why.is_empty()));
                // No tab is listed: the run is what was waited on. `runs show` has each worker.
                woken["targets"] = json!([]);
                return Ok(woken);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// `wait` on several tabs at once (PRO-271). `any` returns as soon as one
    /// of them has settled, `all` when every one has; either returns at the
    /// timeout with what has not settled marked `timedOut`. A target already
    /// settled when the call begins counts at once, so nothing that ended
    /// between two calls is missed. Every target is listed, with `changed`
    /// on the ones whose state differs from when the call began.
    fn wait_many(&self, params: Value) -> Result<Value, ControlError> {
        let selectors: Vec<String> = params
            .get("targets")
            .and_then(Value::as_array)
            .and_then(|targets| targets.iter().map(|target| target.as_str().map(String::from)).collect())
            .filter(|targets: &Vec<String>| !targets.is_empty())
            .ok_or_else(|| ControlError::invalid("targets takes one or more sessions or tabs."))?;
        let mode = optional_string(&params, "mode").unwrap_or_else(|| "any".into());
        if !matches!(mode.as_str(), "any" | "all") {
            return Err(ControlError::invalid(format!("mode takes any or all, not {mode}.")));
        }
        // A target that names nothing fails the call before any waiting.
        let targets = selectors.iter().map(|selector| resolve_target(selector)).collect::<Result<Vec<_>, _>>()?;
        let timeout = params.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(600).min(86_400);
        let deadline = Instant::now() + Duration::from_secs(timeout);
        // As for one target: it only waits and reads (#765).
        let _resumable = crate::hooks::resumable();
        let mut began: Option<Vec<Option<WaitEnd>>> = None;
        loop {
            if self.local_lifetime.as_ref().is_some_and(|lifetime| lifetime.is_stopping()) {
                return Err(ControlError::new("runtime_stopping", "The local runtime is stopping.", None::<String>));
            }
            let views: Vec<WaitView> = targets.iter().map(|target| self.manager.wait_view(&target.session.id, &target.tab.id)).collect();
            let ends: Vec<Option<WaitEnd>> = views.iter().map(wait_end).collect();
            let began = began.get_or_insert_with(|| ends.clone());
            let settled = ends.iter().flatten().count();
            let done = if mode == "all" { settled == ends.len() } else { settled > 0 };
            let timed_out = !done && Instant::now() >= deadline;
            if done || timed_out {
                let listed: Vec<Value> = (0..targets.len())
                    .map(|i| {
                        let state = ends[i].map_or(if timed_out { "timedOut" } else { "running" }, WaitEnd::state);
                        let mut entry = json!({
                            "target": selectors[i], "sessionId": targets[i].session.id, "tabId": targets[i].tab.id,
                            "state": state, "status": views[i].status, "changed": ends[i] != began[i],
                        });
                        if let Some(end) = ends[i] {
                            entry["reason"] = json!(end.reason());
                            if let WaitEnd::Recovery(kind) = end {
                                entry["recovery"] = json!(kind);
                            }
                        }
                        entry
                    })
                    .collect();
                return Ok(json!({"mode": mode, "timedOut": timed_out, "targets": listed}));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn decide_permission(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        let selector = required_string(&params, "request")?;
        let pending = resolve_permission(&self.manager.pending_permissions(), &selector)?;
        let option = if command == "permissions.deny" {
            "deny".to_string()
        } else {
            optional_string(&params, "option").unwrap_or_else(|| "allow".into())
        };
        self.manager
            .respond_permission(
                &pending.session_id,
                &pending.tab_id,
                &pending.request_id,
                &option,
            )
            .map_err(|e| {
                ControlError::new(
                    "request_lapsed",
                    format!("{e:#}"),
                    Some("Refresh permissions list and use a current request id.".into()),
                )
            })?;
        Ok(
            json!({"sessionId": pending.session_id, "tabId": pending.tab_id, "requestId": pending.request_id, "decision": option}),
        )
    }

    /// Each worktree with the sessions that deleting it would delete, by the
    /// rule the delete uses. The main checkout, which cannot be deleted, has
    /// only their count: it holds every session that runs in the project
    /// itself.
    fn worktrees_list(&self, params: Value) -> Result<Value, ControlError> {
        let projects = selected_projects(optional_string(&params, "project"))?;
        let sessions = index::load().map_err(ControlError::internal)?;
        let mut groups = Vec::new();
        for project in projects {
            let worktrees = crate::workspaces::list(Path::new(&project.path))
                .map_err(ControlError::internal)?;
            let mut listed = Vec::with_capacity(worktrees.len());
            for worktree in worktrees {
                let held = crate::worktree_control::sessions_in(&sessions, &worktree.path);
                let mut value = serde_json::to_value(&worktree).map_err(ControlError::internal)?;
                value["sessionCount"] = json!(held.len());
                if !worktree.is_main {
                    value["sessions"] = json!(crate::worktree_control::summaries(&held, &project.path));
                }
                listed.push(value);
            }
            groups.push(json!({"project": project, "worktrees": listed}));
        }
        Ok(json!({"projects": groups}))
    }

    /// `worktrees delete`. Without `--yes`, or with `--dry-run`, it says what
    /// would go and removes nothing. `--sessions` names the sessions the
    /// caller was shown; as with the desktop dialog, nothing is removed
    /// unless they are exactly the ones there (#719).
    fn worktree_delete(&self, params: Value) -> Result<Value, ControlError> {
        let confirmed = params.get("confirmed").and_then(Value::as_bool).unwrap_or(false);
        let dry_run = params.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
        if confirmed && dry_run {
            return Err(ControlError::invalid("--dry-run removes nothing; it cannot be combined with --yes."));
        }
        let named = named_session_ids(&params)?;
        let (project, worktree) = resolve_worktree(&params)?;
        if worktree.is_main {
            return Err(ControlError::invalid(
                "A project's main checkout cannot be deleted.",
            ));
        }
        let held_now = || crate::session_ops::sessions_in_workspace(Path::new(&worktree.path)).map_err(ControlError::internal);
        let check_named = |named: &[String], held: &[SessionEntry]| {
            crate::worktree_control::named_sessions(named, held, &project.path).map_err(|error| sessions_changed(error, &worktree.path))
        };
        if !confirmed {
            let held = held_now()?;
            if let Some(named) = &named {
                check_named(named, &held)?;
            }
            let orphans = self.worktree_delete_orphans(&project, &held)?;
            let preview = self.worktree_delete_preview(&project, worktree.clone(), &held).with_orphans(orphans);
            if dry_run {
                return serde_json::to_value(preview).map_err(ControlError::internal);
            }
            let force = if preview.needs_force { ", adding --force only if losing the work listed is intended" } else { "" };
            return Err(ControlError::new(
                "confirmation_required",
                format!("Worktree deletion requires --yes. Nothing was removed.\n{}", preview.describe()),
                Some(format!(
                    "Check what is listed, then repeat with --yes --sessions {} to delete exactly these sessions{force}. --dry-run --json shows the same as JSON.",
                    preview.sessions_flag()
                )),
            ));
        }
        // The removal fences the worktree from its stop to its end, so nothing
        // starts there meanwhile, and no other tab's prompt waits for it
        // (#727). The sessions named with `--sessions` are checked against
        // the worktree again behind that fence, after the stop. A failed stop
        // cannot be discarded by a CLI caller either.
        self.manager.accepting_work().map_err(ControlError::internal)?;
        let expected = match &named {
            Some(named) => Some(check_named(named, &held_now()?)?),
            None => None,
        };
        // A lead's worktree: its run is cleaned up first, while the lead's
        // session and checkout are still there to measure the workers
        // against, so none is left a top-level row without a lead.
        // The same check as every other way of removing a workspace. One
        // that is not clean and merged is removed only with `--force`, which
        // is the CLI's second confirmation. A directory git cannot remove is
        // reported, never deleted directly: the CLI showed nothing of it.
        let force = params.get("force").and_then(Value::as_bool).unwrap_or(false);
        self.worktree_delete_clean_up_runs(&project, &worktree, &held_now()?, force)?;
        let stop = |session: &crate::store::index::SessionEntry| {
            self.manager.stop_session_confirmed(session).map_err(|error| format!("{error:#}"))
        };
        #[cfg(feature = "desktop")]
        let browser_key = crate::browser::control::canonical(&worktree.path);
        let request = crate::session_ops::WorkspaceRemoval {
            project_path: &project.path,
            path: &worktree.path,
            sessions: crate::session_ops::SessionsFate::Delete,
            delete_branch: false,
            // The preview carries no digest to confirm, so `--force` covers
            // whatever git state is there. The sessions are checked when the
            // caller names them with `--sessions`.
            confirmation: if force { crate::session_ops::Confirmation::Forced } else { crate::session_ops::Confirmation::Single },
            expected_sessions: expected.as_deref(),
            direct: crate::git::DirectDelete::Never,
            fetch: crate::landed::Fetch::Fresh,
            guard: None, archive: Some(crate::archive_script::Runner { terminals: self.manager.terminals(), sink: &self.sink, unattended: false }), archive_failure: None, archive_retry: None, archive_started: None,
        };
        let removed = crate::session_ops::remove_workspace_fallible(&*self.sink, &request, &stop).map_err(|error| {
            if error.starts_with(crate::session_ops::NEEDS_CONFIRMATION) {
                ControlError::new("needs_force", error, Some("Nothing was removed. Repeat with --force only if losing this work is intended.".into()))
            } else if error.starts_with(crate::session_ops::SESSIONS_CHANGED) {
                sessions_changed(error, &worktree.path)
            } else if let Some(failure) = crate::archive_script::Failure::from_error(&error) {
                ControlError::new("archive_script_failed", failure.message(), Some("Open the workspace removal dialog to review the log and choose whether to remove anyway.".into()))
            } else {
                ControlError::internal(error)
            }
        })?;
        // Only once the workspace is really gone: a removal that fails keeps it.
        #[cfg(feature = "desktop")]
        if let Some(desktop) = &self.desktop {
            desktop.browser.forget_workspace(&browser_key);
        }
        let (entries, removal, strays) = (removed.sessions, removed.removal, removed.strays);
        let removed = crate::worktree_control::summaries(&entries, &project.path);
        Ok(json!({"deleted": worktree.path, "project": project.path, "removedSessions": removed, "keptBranch": removal.kept_branch, "strayProcesses": strays}))
    }

    /// The workers that deleting the sessions in `held` would leave without
    /// their lead: each worker, in a session outside `held`, of every run a
    /// session in `held` leads. Each says why the run's cleanup would not
    /// remove it, when it would not.
    fn worktree_delete_orphans(&self, project: &Project, held: &[SessionEntry]) -> Result<Vec<crate::worktree_control::Orphan>, ControlError> {
        use crate::orchestration::{host::ManagerHost, merge, store};
        let held_ids: std::collections::BTreeSet<&str> = held.iter().map(|session| session.id.as_str()).collect();
        let runs: Vec<_> = store::list().map_err(ControlError::internal)?.into_iter().filter(|run| held_ids.contains(run.lead.session_id.as_str())).collect();
        if runs.is_empty() {
            return Ok(Vec::new());
        }
        let sessions = index::load().map_err(ControlError::internal)?;
        let host = ManagerHost::new(self.sink.clone(), self.manager.clone());
        let mut orphans = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for run in runs {
            // What the run's cleanup would do, asked without --yes: it removes nothing then.
            let mut verdicts: std::collections::HashMap<String, (Option<String>, String)> = std::collections::HashMap::new();
            let mut failed = None;
            match merge::cleanup(&host, &run.id, false) {
                Err(error) if error.code == "confirmation_required" => {
                    for (list, going) in [("wouldRemove", true), ("wouldRefuse", false)] {
                        for fate in error.details[list].as_array().into_iter().flatten() {
                            let (Some(session), Some(worktree)) = (fate["session"].as_str(), fate["worktree"].as_str()) else { continue };
                            let reason = if going { None } else { Some(fate["reason"].as_str().unwrap_or("The run's cleanup would leave it.").to_string()) };
                            verdicts.insert(session.to_string(), (reason, worktree.to_string()));
                        }
                    }
                }
                Err(error) => failed = Some(format!("The run's cleanup cannot run now: {}", error.message)),
                Ok(_) => {}
            }
            for piece in &run.pieces {
                for (index, attempt) in piece.tries.iter().enumerate() {
                    let Some(worker) = attempt.worker.as_ref() else { continue };
                    if held_ids.contains(worker.session_id.as_str()) || seen.contains(&worker.session_id) {
                        continue;
                    }
                    // Gone already: nothing is left behind.
                    let Some(session) = sessions.iter().find(|session| session.id == worker.session_id) else { continue };
                    seen.push(worker.session_id.clone());
                    let (blocked, worktree) = match verdicts.get(&worker.session_id) {
                        Some((reason, worktree)) => (failed.clone().or_else(|| reason.clone()), Some(worktree.clone())),
                        None => (Some(failed.clone().unwrap_or_else(|| "Its session is not in a worktree of its own, so the run's cleanup does not remove it.".to_string())), None),
                    };
                    orphans.push(crate::worktree_control::Orphan {
                        run: run.id.clone(),
                        piece: piece.id.clone(),
                        attempt: index + 1,
                        session: crate::worktree_control::WorktreeSession::of(session, &project.path),
                        worktree,
                        blocked,
                    });
                }
            }
        }
        Ok(orphans)
    }

    /// Before a lead's worktree goes, its runs' workers go: each run is
    /// cleaned up when every worker it would leave can be removed. Otherwise,
    /// or when the cleanup leaves one, nothing more is removed and the
    /// workers that block the delete are named. Without `force`, a lead's
    /// worktree that is not clean and merged is refused here, before any
    /// worker goes: the delete would stop there, and nothing may be removed
    /// by a delete that stops.
    fn worktree_delete_clean_up_runs(&self, project: &Project, worktree: &crate::workspaces::Workspace, held: &[SessionEntry], force: bool) -> Result<(), ControlError> {
        use crate::worktree_control::{orphan_listing, orphan_runs, orphans_recovery};
        let orphans = self.worktree_delete_orphans(project, held)?;
        if orphans.is_empty() {
            return Ok(());
        }
        let refuse = |orphans: &[crate::worktree_control::Orphan], cleaned: &[String]| {
            let blocking: Vec<_> = orphans.iter().filter(|orphan| orphan.blocked.is_some()).cloned().collect();
            let blocking = if blocking.is_empty() { orphans.to_vec() } else { blocking };
            let done = if cleaned.is_empty() { String::new() } else { format!(" The cleanup of run {} removed what it could first.", cleaned.join(", ")) };
            let mut error = ControlError::new(
                "workers_would_be_orphaned",
                format!(
                    "Worktree {} holds the lead of run {}. Deleting it would leave {} without a lead, so nothing of this worktree was removed.{done}\n{}",
                    worktree.name,
                    orphan_runs(orphans).join(", "),
                    if blocking.len() == 1 { "this worker".to_string() } else { format!("these {} workers", blocking.len()) },
                    orphan_listing(&blocking),
                ),
                Some(orphans_recovery(&blocking, &worktree.name)),
            );
            error.details = Some(json!({"orphans": blocking}));
            error
        };
        if orphans.iter().any(|orphan| orphan.blocked.is_some()) {
            return Err(refuse(&orphans, &[]));
        }
        if !force {
            let canonical = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
            let landed = crate::landed::check(&canonical(&project.path), &canonical(&worktree.path), crate::landed::Fetch::Fresh);
            if !landed.safe {
                let losses = if landed.losses.is_empty() { "It is not known to be clean and merged.".to_string() } else { landed.losses.join("\n") };
                return Err(ControlError::new(
                    "needs_force",
                    format!(
                        "{}. Worktree {} holds the lead of run {}, and is not clean and merged, so nothing was removed, its workers included.\n{losses}",
                        crate::session_ops::NEEDS_CONFIRMATION,
                        worktree.name,
                        orphan_runs(&orphans).join(", "),
                    ),
                    Some("Nothing was removed. Repeat with --force only if losing this work is intended; the run's cleanup then removes its workers first.".into()),
                ));
            }
        }
        let host = crate::orchestration::host::ManagerHost::new(self.sink.clone(), self.manager.clone());
        let mut cleaned = Vec::new();
        for run in orphan_runs(&orphans) {
            crate::orchestration::merge::cleanup(&host, &run, true).map_err(ControlError::of_run)?;
            cleaned.push(run);
        }
        // What the cleanup could not remove after all (a worker that wrote
        // something in its last moment) still blocks the delete.
        let left = self.worktree_delete_orphans(project, held)?;
        if !left.is_empty() {
            return Err(refuse(&left, &cleaned));
        }
        Ok(())
    }

    /// What deleting `worktree` would do: the sessions it holds, with what
    /// each still runs, and its git state checked as the delete checks it.
    fn worktree_delete_preview(&self, project: &Project, worktree: crate::workspaces::Workspace, held: &[SessionEntry]) -> crate::worktree_control::DeletePreview {
        let canonical = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        let landed = crate::landed::check(&canonical(&project.path), &canonical(&worktree.path), crate::landed::Fetch::Fresh);
        let terminals = self.manager.terminals();
        let sessions = held
            .iter()
            .map(|session| {
                let mut named = crate::worktree_control::WorktreeSession::of(session, &project.path);
                named.running_tabs = session
                    .tabs
                    .iter()
                    .filter(|tab| self.manager.is_running(&session.id, &tab.id) || terminals.is_running(&tab.pane_id()))
                    .map(|tab| crate::worktree_control::RunningTab { id: tab.id.clone(), harness: tab.harness.clone(), title: tab.title.clone() })
                    .collect();
                named.running_shells = terminals.session_pane_ids(&session.id, &[]).iter().filter(|pane| terminals.is_running(pane)).count();
                named
            })
            .collect();
        crate::worktree_control::DeletePreview::new(&project.path, worktree, sessions, landed)
    }

    fn issues_list(&self, params: Value) -> Result<Value, ControlError> {
        let project = resolve_project(&required_string(&params, "project")?)?;
        let provider = optional_string(&params, "provider").unwrap_or_else(|| "github".into());
        let filter = crate::issues::IssueFilter {
            assigned_to_me: params
                .get("assignedToMe")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            team_id: optional_string(&params, "team"),
            search: optional_string(&params, "search"),
            // As this command always listed them: GitHub's newest first, Linear's recently updated first.
            sort: (provider == "github").then(|| "created".into()),
            ..Default::default()
        };
        let issues = match provider.as_str() {
            "github" => crate::issues::github_list(Path::new(&project.path), &filter),
            "linear" => {
                let key = crate::store::settings::load()
                    .linear_api_key
                    .filter(|key| !key.trim().is_empty())
                    .ok_or_else(|| {
                        ControlError::new(
                            "integration_unavailable",
                            "Linear is not connected.",
                            Some(LINEAR_INTEGRATION_RECOVERY.into()),
                        )
                    })?;
                crate::issues::linear_list(&key, &filter)
            }
            other => {
                return Err(ControlError::invalid(format!(
                    "Unknown issue provider {other}."
                )))
            }
        }
        .map_err(ControlError::internal)?;
        Ok(json!({"project": project, "provider": provider, "issues": issues}))
    }

    #[cfg(feature = "desktop")]
    /// Existing issue operations, with their confirmation policy in `issue_control`.
    fn issue_op(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        issue_operation(self.questions.as_ref(), command, params)
    }
}

fn issue_operation(questions: Option<&crate::issue_control::Ask>, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::issue_control::{authorize, in_project, run, Caller, Live, Subject, Write};
        use crate::issue_ops::{Provider, Target};
        let action = command.trim_start_matches("issues.");
        let caller = Caller::of(&params);
        let named = optional_string(&params, "provider");
        let reference = optional_string(&params, "issue");
        let (provider, id) = match &reference {
            Some(reference) => {
                let (provider, id) = crate::issues::parse_issue_reference(reference, named.as_deref()).map_err(ControlError::invalid)?;
                (provider, Some(id))
            }
            None if action == "create" => (if named.as_deref() == Some("linear") { "linear" } else { "github" }, None),
            None => return Err(ControlError::invalid("Missing issue.")),
        };
        let project = issue_project(&params, &caller)?;
        if let Some(reference) = &reference {
            refuse_other_repository(&project.path, reference)?;
        }
        let target = Target::resolve(Path::new(&project.path), if provider == "linear" { Provider::Linear } else { Provider::Github }).map_err(crate::issue_control::op_error)?;
        let project_repo = match &target {
            Target::Github { repo, .. } => Some(repo.clone()),
            Target::Linear { .. } => None,
        };
        // Shown in the question as the caller's claim, never trusted.
        let session = caller.session.as_deref().and_then(|session| resolve_session(session).ok());
        let gate = |write: &Write, subject: &str, issue_repo: Option<&str>| {
            let subject = Subject {
                issue: subject,
                provider,
                project_name: &project.name,
                // The switch is the project's, and applies only to an issue that is verifiably its own.
                routine_allowed: project.agent_issue_updates && in_project(issue_repo, project_repo.as_deref()),
                session_title: session.as_ref().map(|s| s.title.as_str()),
                session_id: session.as_ref().map(|s| s.id.as_str()),
            };
            authorize(write, &subject, questions)
        };
        run(action, &params, id.as_deref(), &Live(target), &gate)
}

/// The project an issue command is for: the one named, else the one of the
/// session it runs in, else the one holding its working directory. A new
/// issue's project is always named.
fn issue_project(params: &Value, caller: &crate::issue_control::Caller) -> Result<Project, ControlError> {
    if let Some(selector) = optional_string(params, "project") {
        return resolve_project(&selector);
    }
    let (projects, _) = projects::list().map_err(ControlError::internal)?;
    let own = |path: &str| projects.iter().find(|project| project.path == path).cloned();
    if let Some(session) = caller.session.as_deref().and_then(|session| resolve_session(session).ok()) {
        if let Some(project) = own(&session.project_path) {
            return Ok(project);
        }
    }
    if let Some(cwd) = caller.cwd.as_deref() {
        let here = canonical_or_original(cwd);
        // A worktree lives outside its project's folder: its sessions say whose it is.
        let sessions = index::load().map_err(ControlError::internal)?;
        let mut best: Option<(usize, Project)> = None;
        let candidates = projects.iter().map(|project| (project.path.clone(), project.clone()))
            .chain(sessions.iter().filter(|session| !session.worktree_removed).filter_map(|session| own(&session.project_path).map(|project| (canonical_or_original(&session.cwd), project))));
        for (path, project) in candidates {
            if Path::new(&here).starts_with(&path) && best.as_ref().is_none_or(|(length, _)| path.len() > *length) {
                best = Some((path.len(), project));
            }
        }
        if let Some((_, project)) = best {
            return Ok(project);
        }
    }
    Err(ControlError::invalid("Could not tell which project the issue belongs to. Pass --project."))
}

/// A GitHub URL names its repository; the issue is read from the project's
/// own, so a URL into another one would act on this repository's issue of
/// the same number.
fn refuse_other_repository(project_path: &str, reference: &str) -> Result<(), ControlError> {
    let Some(named) = crate::issues::github_issue_url_repo(reference) else { return Ok(()) };
    let own = crate::issues::github_repo(Path::new(project_path));
    if own.as_deref().is_some_and(|own| own.eq_ignore_ascii_case(&named)) {
        return Ok(());
    }
    Err(ControlError::invalid(format!(
        "That issue is in {named}, and this project is {}. Pass --project with a project of that repository.",
        own.as_deref().unwrap_or("not a GitHub repository")
    )))
}

#[derive(Clone)]
struct Target {
    session: SessionEntry,
    tab: TabEntry,
}

#[cfg(feature = "desktop")]
fn computer_error(error: crate::computer::ComputerError) -> ControlError {
    let recovery = error.recovery();
    ControlError::new(&error.code, error.message, Some(recovery))
}

/// What `--issue` adds to a new session: the reference it carries and the
/// prompt it starts with.
struct IssueStart {
    reference: crate::store::index::IssueRef,
    prompt: String,
    /// The issue's own text, for a cloud workspace's reviewer.
    body: Option<String>,
}

/// `terminalx sessions create --project cloud:… --issue …`: the issue is read
/// here, with the reader's own `gh` or Linear key, before the window hears of
/// the command. The window gets the issue, its text and the prompt, and
/// starts the session in one of the project's workspaces, where the runtime
/// carries it on. A request without `--issue` goes on word for word.
#[cfg(feature = "desktop")]
fn cloud_issue_start(mut params: Value) -> Result<Value, ControlError> {
    let Some(reference) = optional_string(&params, "issue") else { return Ok(params) };
    let project = required_string(&params, "project")?;
    if crate::issues::cloud_project_repo(Path::new(&project)).is_none() {
        return Err(ControlError::invalid("Only a cloud project with a GitHub repository has issues to start from."));
    }
    let issue = issue_for_session(&project, &reference, optional_string(&params, "provider").as_deref())?;
    // From an issue the prompt is the issue itself, with anything the caller added after it.
    let extra = optional_string(&params, "prompt").unwrap_or_default();
    let prompt = if extra.trim().is_empty() { issue.prompt } else { format!("{}\n\n{}", issue.prompt, extra.trim()) };
    params["prompt"] = json!(prompt);
    params["issue"] = json!(issue.reference);
    params["issueBody"] = json!(issue.body);
    Ok(params)
}

#[cfg(not(feature = "desktop"))]
fn cloud_issue_start(params: Value) -> Result<Value, ControlError> {
    Ok(params)
}

fn issue_for_session(project_path: &str, reference: &str, provider: Option<&str>) -> Result<IssueStart, ControlError> {
    let (provider, id) = crate::issues::parse_issue_reference(reference, provider).map_err(ControlError::invalid)?;
    // A URL names its repository. The issue is read from the project's own,
    // so a URL into another one would silently become this project's issue of
    // the same number, and the pull request would close that one.
    if let Some(named) = crate::issues::github_issue_url_repo(reference) {
        let own = crate::issues::github_repo(Path::new(project_path));
        if !own.as_deref().is_some_and(|own| own.eq_ignore_ascii_case(&named)) {
            return Err(ControlError::invalid(format!(
                "That issue is in {named}, and this project is {}. Start it from a project of that repository.",
                own.as_deref().unwrap_or("not a GitHub repository")
            )));
        }
    }
    let issue = if provider == "linear" {
        let key = crate::store::settings::load().linear_api_key.filter(|key| !key.trim().is_empty()).ok_or_else(|| {
            ControlError::new("integration_unavailable", "Linear is not connected.", Some(LINEAR_INTEGRATION_RECOVERY.into()))
        })?;
        crate::issues::linear_details(&key, &id)
    } else {
        crate::issues::github_details(Path::new(project_path), &id)
    }
    .map_err(|error| ControlError::new("issue_unavailable", format!("{reference} could not be read: {error:#}"), Some("Check the issue and its integration in the Issues page, then retry. If this runtime cannot serve issue starts, start it from the Issues page or update TerminalX.".into())))?;
    Ok(IssueStart {
        prompt: crate::issue_pipeline::prompts::issue_prompt(&issue),
        body: issue.body.clone(),
        reference: crate::store::index::IssueRef { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
    })
}

/// A pipeline by its id (or the start of it), by its issue (`#433`,
/// `ENG-42`), or by the session working on it. An issue worked on more than
/// once names its newest pipeline. Two projects can each have an issue #12:
/// then the number alone names neither, and `project` has to say which.
fn resolve_pipeline(selector: &str, project: Option<&Project>) -> Result<crate::issue_pipeline::Pipeline, ControlError> {
    let mut pipelines = crate::issue_pipeline::store::list().map_err(ControlError::internal)?;
    if let Some(project) = project {
        pipelines.retain(|pipeline| pipeline.project_path == project.path);
    }
    if let Some(exact) = pipelines.iter().find(|pipeline| pipeline.id == selector) {
        return Ok(exact.clone());
    }
    // `#433` starts a comment in most shells, so the bare number names it too.
    let named = selector.trim_start_matches('#');
    let by_issue: Vec<&crate::issue_pipeline::Pipeline> = pipelines.iter().filter(|pipeline| pipeline.issue.as_ref().is_some_and(|issue| issue.identifier.trim_start_matches('#').eq_ignore_ascii_case(named) || issue.url == selector)).collect();
    let projects: std::collections::BTreeSet<&str> = by_issue.iter().map(|pipeline| pipeline.project_path.as_str()).collect();
    if projects.len() > 1 {
        return Err(ControlError::new(
            "ambiguous_selector",
            format!("More than one project has a pipeline for {selector}."),
            Some("Add --project, or use the pipeline's id from `terminalx pipelines list`.".into()),
        ));
    }
    if let Some(newest) = by_issue.last() {
        return Ok((*newest).clone());
    }
    let partial: Vec<_> = pipelines.into_iter().filter(|pipeline| pipeline.id.starts_with(selector) || pipeline.author.session_id.starts_with(selector)).collect();
    unique(partial, "pipeline", selector)
}

fn resolve_project(selector: &str) -> Result<Project, ControlError> {
    let (projects, _) = projects::list().map_err(ControlError::internal)?;
    let canonical = Path::new(selector)
        .exists()
        .then(|| canonical_or_original(selector));
    let exact: Vec<Project> = projects
        .iter()
        .filter(|project| {
            project.path == selector
                || project.name == selector
                || canonical.as_deref() == Some(project.path.as_str())
        })
        .cloned()
        .collect();
    if exact.len() == 1 {
        return Ok(exact[0].clone());
    }
    let partial: Vec<Project> = projects
        .into_iter()
        .filter(|project| project.name.contains(selector))
        .collect();
    unique(partial, "project", selector)
}

fn selected_projects(selector: Option<String>) -> Result<Vec<Project>, ControlError> {
    match selector {
        Some(selector) => Ok(vec![resolve_project(&selector)?]),
        None => Ok(projects::list().map_err(ControlError::internal)?.0),
    }
}

pub(crate) fn resolve_session(selector: &str) -> Result<SessionEntry, ControlError> {
    let sessions = index::load().map_err(ControlError::internal)?;
    let exact: Vec<_> = sessions
        .iter()
        .filter(|session| session.id == selector)
        .cloned()
        .collect();
    if exact.len() == 1 {
        return Ok(exact[0].clone());
    }
    unique(
        sessions
            .into_iter()
            .filter(|session| session.id.starts_with(selector))
            .collect(),
        "session",
        selector,
    )
}

fn validate_control_session_target(use_worktree: bool, on_main: bool) -> Result<(), ControlError> {
    if use_worktree && on_main {
        return Err(ControlError::invalid(
            "useWorktree and onMain are mutually exclusive.",
        ));
    }
    if !use_worktree && !on_main {
        return Err(ControlError::invalid(
            "Skipping a worktree requires onMain to be explicitly true.",
        ));
    }
    Ok(())
}

/// Who a new session is recorded as started by (PRO-270). `--no-parent`
/// records nobody and `--parent` the session it names, which must exist.
/// Otherwise it is the session the command ran in, when the app knows it:
/// that is only what the command's environment says, which is enough for a
/// record that grants nothing, and a session the app does not know (the
/// environment of one since deleted) is simply not recorded.
fn parent_of_new_session(parent: Option<&str>, no_parent: bool, caller: &Value) -> Result<Option<index::ParentRef>, ControlError> {
    if no_parent {
        return match parent {
            Some(_) => Err(ControlError::invalid("--parent and --no-parent are mutually exclusive.")),
            None => Ok(None),
        };
    }
    let calling = caller["session"].as_str().and_then(|id| index::get(id).ok());
    let session = match parent.map(str::trim) {
        Some("") => return Err(ControlError::invalid("--parent needs a session.")),
        Some(selector) => resolve_session(selector).map_err(|error| match error.code.as_str() {
            "not_found" => ControlError::new(
                "parent_not_found",
                format!("No session matches --parent {selector}."),
                Some("Use a session id from `terminalx sessions list --json`, or --no-parent to record none.".into()),
            ),
            _ => error,
        })?,
        None => match calling.clone() {
            Some(session) => session,
            None => return Ok(None),
        },
    };
    // The tab is the caller's own: `--parent` naming another session says
    // nothing of which of its tabs asked.
    let tab_id = calling.filter(|calling| calling.id == session.id)
        .and_then(|_| caller["tab"].as_str())
        .filter(|tab| session.tab(tab).is_some())
        .map(str::to_owned);
    Ok(Some(index::ParentRef { session_id: session.id, tab_id }))
}

/// The lead `--children-of` names.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Lead {
    session_id: String,
    title: Option<String>,
    /// False once the lead was deleted: its workers still name it.
    exists: bool,
}

/// A session by id or the start of one, as everywhere else; or the full id
/// of a lead that is gone, which the sessions it started still record.
fn resolve_lead(sessions: &[SessionEntry], selector: &str) -> Result<Lead, ControlError> {
    match resolve_session(selector) {
        Ok(session) => Ok(Lead { session_id: session.id, title: Some(session.title), exists: true }),
        Err(error) if error.code == "not_found" && sessions.iter().any(|session| session.started_by(selector)) => {
            Ok(Lead { session_id: selector.to_owned(), title: None, exists: false })
        }
        Err(error) => Err(error),
    }
}

fn resolve_target(selector: &str) -> Result<Target, ControlError> {
    let sessions = index::load().map_err(ControlError::internal)?;
    if let Some(session) = sessions
        .iter()
        .find(|session| session.id == selector)
        .cloned()
    {
        return target_from_session(session);
    }
    let exact_tabs: Vec<_> = sessions
        .iter()
        .flat_map(|session| {
            session
                .tabs
                .iter()
                .filter(|tab| tab.id == selector)
                .map(move |tab| (session.clone(), tab.clone()))
        })
        .collect();
    if !exact_tabs.is_empty() {
        let (session, tab) = unique(exact_tabs, "tab", selector)?;
        return Ok(Target { session, tab });
    }
    let mut matches = sessions
        .iter()
        .filter(|session| session.id.starts_with(selector))
        .cloned()
        .map(|session| (session, None))
        .collect::<Vec<_>>();
    matches.extend(sessions.iter().flat_map(|session| {
        session
            .tabs
            .iter()
            .filter(|tab| tab.id.starts_with(selector))
            .map(move |tab| (session.clone(), Some(tab.clone())))
    }));
    let (session, tab) = unique(matches, "session or tab", selector)?;
    match tab {
        Some(tab) => Ok(Target { session, tab }),
        None => target_from_session(session),
    }
}

fn target_from_session(session: SessionEntry) -> Result<Target, ControlError> {
    let tab_id = session
        .active_tab
        .as_deref()
        .or_else(|| session.tabs.first().map(|tab| tab.id.as_str()))
        .ok_or_else(|| ControlError::not_found("The session has no tabs."))?;
    let tab = session
        .tab(tab_id)
        .cloned()
        .ok_or_else(|| ControlError::not_found("The session's active tab no longer exists."))?;
    Ok(Target { session, tab })
}

/// Why `wait` returns before its timeout (#668).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WaitEnd {
    /// A request someone can answer: `permissions list` shows it.
    Permission,
    /// The agent stopped on an error and waits for someone to deal with it.
    Recovery(RecoveryKind),
    /// The agent asks in its own terminal, which `permissions list` does not
    /// show: its own permission prompt, or a CLI started by hand.
    Terminal,
    /// The turn ended.
    Stop,
    /// Nothing is running.
    Stopped,
}

impl WaitEnd {
    fn reason(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Recovery(_) => "recovery",
            Self::Terminal => "terminal",
            Self::Stop => "stop",
            Self::Stopped => "stopped",
        }
    }

    /// What a wait on several tabs calls it: the reason says which of them.
    fn state(self) -> &'static str {
        match self {
            Self::Permission | Self::Terminal => "needsPermission",
            Self::Recovery(_) => "failed",
            Self::Stop | Self::Stopped => "stopped",
        }
    }
}

/// The same rules as a cloud tab's wait (`settledReason` in cloudControl.ts),
/// on what the local runtime holds. Its status is never behind its
/// transcript, so a tab waiting on neither a request nor an error is waiting
/// on its own terminal.
fn wait_end(view: &WaitView) -> Option<WaitEnd> {
    if view.asks {
        return Some(WaitEnd::Permission);
    }
    if view.status == TabStatus::Waiting {
        return Some(view.recovery.map_or(WaitEnd::Terminal, WaitEnd::Recovery));
    }
    // A prompt behind the turn starts as soon as the turn ends.
    if view.queued && view.running {
        return None;
    }
    match view.status {
        TabStatus::Completed => Some(WaitEnd::Stop),
        TabStatus::Idle if !view.running => Some(WaitEnd::Stopped),
        _ => None,
    }
}

/// The turn a tab is in, for `sessions report`: a report an earlier turn
/// ended with is not the answer of one still open. A tab that only sits idle
/// with its agent running is in none.
pub(crate) fn open_turn(view: &WaitView) -> Option<crate::worker_report::OpenTurn> {
    use crate::worker_report::OpenTurn;
    if view.asks || view.status == TabStatus::Waiting {
        return Some(OpenTurn::Waiting);
    }
    (view.status == TabStatus::InProgress || (view.queued && view.running)).then_some(OpenTurn::Working)
}

fn resolve_permission(
    pending: &[PendingPermission],
    selector: &str,
) -> Result<PendingPermission, ControlError> {
    let exact: Vec<_> = pending
        .iter()
        .filter(|permission| permission.request_id == selector)
        .cloned()
        .collect();
    if exact.len() == 1 {
        return Ok(exact[0].clone());
    }
    unique(
        pending
            .iter()
            .filter(|permission| permission.request_id.starts_with(selector))
            .cloned()
            .collect(),
        "permission request",
        selector,
    )
}

fn unique<T>(matches: Vec<T>, kind: &str, selector: &str) -> Result<T, ControlError> {
    match matches.len() {
        0 => Err(ControlError::not_found(format!(
            "No {kind} matches {selector}."
        ))),
        1 => Ok(matches.into_iter().next().expect("one match")),
        _ => Err(ControlError::ambiguous(format!(
            "More than one {kind} matches {selector}."
        ))),
    }
}

fn required_string(params: &Value, name: &str) -> Result<String, ControlError> {
    optional_string(params, name).ok_or_else(|| ControlError::invalid(format!("Missing {name}.")))
}

fn optional_string(params: &Value, name: &str) -> Option<String> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn canonical_or_original(path: &str) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .into_owned()
}

fn workspace_error(error: crate::session_ops::WorkspaceError) -> ControlError {
    match error {
        crate::session_ops::WorkspaceError::InvalidArguments(message) => ControlError::invalid(message),
        crate::session_ops::WorkspaceError::Operation(message) => ControlError::internal(message),
    }
}

/// `--sessions`: the sessions the caller was shown in the worktree, by id or
/// the start of one. `None` when it named none, which is not the same as an
/// empty list: that says the worktree holds no sessions.
fn named_session_ids(params: &Value) -> Result<Option<Vec<String>>, ControlError> {
    let refused = || ControlError::invalid("sessions must be a list of session ids.");
    match params.get("sessions") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            let mut ids = Vec::with_capacity(items.len());
            for item in items {
                let id = item.as_str().ok_or_else(refused)?.trim();
                if !id.is_empty() {
                    ids.push(id.to_string());
                }
            }
            Ok(Some(ids))
        }
        Some(_) => Err(refused()),
    }
}

/// The sessions in the worktree are not the ones the caller named.
fn sessions_changed(message: String, worktree: &str) -> ControlError {
    ControlError::new(
        "sessions_changed",
        message,
        Some(format!("Nothing was removed. Check terminalx sessions list --worktree {worktree}, then name exactly the sessions it lists with --sessions.")),
    )
}

fn resolve_worktree(params: &Value) -> Result<(projects::Project, crate::workspaces::Workspace), ControlError> {
    let selector = required_string(params, "worktree")?;
    let projects = selected_projects(optional_string(params, "project"))?;
    let mut candidates = Vec::new();
    for project in projects {
        for worktree in
            crate::workspaces::list(Path::new(&project.path)).map_err(ControlError::internal)?
        {
            candidates.push((project.clone(), worktree));
        }
    }
    let exact: Vec<_> = candidates
        .iter()
        .filter(|(_, worktree)| worktree.path == selector || worktree.name == selector)
        .cloned()
        .collect();
    let matches = if exact.is_empty() {
        candidates
            .into_iter()
            .filter(|(_, worktree)| worktree.path.contains(&selector))
            .collect()
    } else {
        exact
    };
    let (project, worktree) = unique(matches, "worktree", &selector)?;
    Ok((project, worktree))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn headless_service() -> (ControlService, Arc<crate::sink::BroadcastSink>) {
        let sink = Arc::new(crate::sink::BroadcastSink::new(16));
        let endpoint = crate::hooks::prepare_control().unwrap();
        let manager = SessionManager::new(
            sink.clone(), Arc::new(crate::sink::NoObserver),
            Arc::new(crate::harness::host::Host::new()), Arc::new(crate::pty::Terminals::new()),
            Arc::new(Default::default()), Arc::new(Default::default()), endpoint.clone(),
        );
        (ControlService::headless(sink.clone(), manager, endpoint, "test".into()), sink)
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn an_issue_command_finds_its_project_by_name_by_its_session_or_by_where_it_runs() {
        use crate::issue_control::Caller;
        let _home = crate::store::temp_home();
        let (dir, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let second = projects::add(other.path().to_str().unwrap()).unwrap();
        let session = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        let nobody = Caller { session: None, cwd: None };
        assert_eq!(issue_project(&json!({"project": second.name}), &nobody).unwrap().path, second.path);
        let in_session = Caller { session: Some(session.id.clone()), cwd: Some(second.path.clone()) };
        assert_eq!(issue_project(&json!({}), &in_session).unwrap().path, project.path, "the session wins over the directory");
        let sub = dir.path().join("src");
        std::fs::create_dir(&sub).unwrap();
        let in_folder = Caller { session: None, cwd: Some(sub.to_string_lossy().into_owned()) };
        assert_eq!(issue_project(&json!({}), &in_folder).unwrap().path, project.path);
        let elsewhere = Caller { session: None, cwd: Some("/".into()) };
        assert!(issue_project(&json!({}), &elsewhere).unwrap_err().message.contains("Pass --project"));
        // A GitHub URL into another repository is refused rather than read as this one's number.
        assert!(refuse_other_repository(&project.path, "https://github.com/acme/api/issues/12").unwrap_err().message.contains("That issue is in acme/api"));
        refuse_other_repository(&project.path, "#12").unwrap();
    }

    #[test]
    fn quick_chats_are_listed_with_their_kind_and_never_under_a_project() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let ordinary = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        // Pointed at the project's own folder: still not one of the project's sessions.
        let quick = crate::session_ops::create_quick_chat_entry(crate::session_ops::NewQuickChat {
            parent: None,
            section_id: None,
            title: Some("Quick question".into()), cwd: Some(project.path.clone()), tab: None,
        }).unwrap();
        let (service, _sink) = headless_service();

        let all = service.execute("sessions.list", json!({}), "r1").unwrap();
        let listed = all["sessions"].as_array().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().find(|s| s["id"] == ordinary.id.as_str()).unwrap().get("kind").is_none(), "an ordinary session reads as it always did");
        assert_eq!(listed.iter().find(|s| s["id"] == quick.id.as_str()).unwrap()["kind"], "quick");

        let only_quick = service.execute("sessions.list", json!({"quick": true}), "r2").unwrap();
        assert_eq!(only_quick["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect::<Vec<_>>(), vec![quick.id.as_str()]);
        let of_project = service.execute("sessions.list", json!({"project": project.path}), "r3").unwrap();
        assert_eq!(of_project["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect::<Vec<_>>(), vec![ordinary.id.as_str()]);
        assert_eq!(service.execute("sessions.list", json!({"project": project.path, "quick": true}), "r4").unwrap_err().code, "invalid_arguments");
        // A quick chat is shown and renamed like any session.
        assert_eq!(service.execute("sessions.show", json!({"session": quick.id}), "r5").unwrap()["kind"], "quick");
        assert_eq!(service.execute("sessions.rename", json!({"session": quick.id, "title": "Renamed"}), "r6").unwrap()["session"]["title"], "Renamed");
    }

    /// `terminalx sessions archive|unarchive` run the app's own archive, so
    /// the sidebar hears of each session at once; `list --archived` lists
    /// what the sidebar keeps under Show archived (#718).
    #[test]
    fn a_sessions_report_is_read_from_its_tabs_last_turn_and_a_worker_is_recorded_as_owing_one() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let session = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "title": "worker", "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        let tab = session.tabs[0].id.clone();
        let (service, _sink) = headless_service();
        let log = crate::store::log_path(&session.id, &tab).unwrap();
        let mut seq = 0;
        let mut say = |payload: Value| {
            seq += 1;
            let event = json!({"id": format!("e{seq}"), "sessionId": session.id, "tabId": tab, "harness": "codex", "seq": seq, "ts": "2026-11-10T10:00:00.000Z", "payload": payload});
            crate::store::append_line(&log, &event.to_string()).unwrap();
        };

        // Nothing said yet: missing, by the session's id or the start of it, or by its tab.
        let report = service.execute("sessions.report", json!({"session": &session.id[..session.id.len() - 2]}), "r1").unwrap();
        assert_eq!((report["status"].as_str(), report["reason"].as_str(), report["sessionId"].as_str(), report["tabId"].as_str()), (Some("missing"), Some("noTurn"), Some(session.id.as_str()), Some(tab.as_str())));

        say(json!({"type": "user_message", "text": "Audit the handlers."}));
        say(json!({"type": "turn_started"}));
        say(json!({"type": "assistant_text", "text": "Audited.\n\n```terminalx-report\n{\"status\":\"done\",\"result\":\"Every handler checks the token.\",\"couldNotRead\":[\"vendor/closed.bin\"]}\n```"}));
        say(json!({"type": "turn_completed", "status": "ok"}));
        let report = service.execute("sessions.report", json!({"session": tab}), "r2").unwrap();
        assert_eq!((report["status"].as_str(), report["result"].as_str(), report["noEvidence"].as_bool(), report["seq"].as_u64()), (Some("done"), Some("Every handler checks the token."), Some(true), Some(3)));
        assert_eq!((&report["couldNotRead"], &report["changed"], report["sessionId"].as_str()), (&json!(["vendor/closed.bin"]), &Value::Null, Some(session.id.as_str())));

        say(json!({"type": "user_message", "text": "And the admin ones?"}));
        say(json!({"type": "turn_started"}));
        say(json!({"type": "assistant_text", "text": "They look fine to me."}));
        say(json!({"type": "turn_completed", "status": "ok"}));
        let report = service.execute("sessions.report", json!({"session": session.id}), "r3").unwrap();
        assert_eq!((report["status"].as_str(), report["reason"].as_str(), report["tail"].as_str()), (Some("missing"), Some("noBlock"), Some("They look fine to me.")));
        assert!(report.get("reminderPending").is_none(), "nobody asked this session for a report");
        assert_eq!(service.execute("sessions.report", json!({"session": "no-such-session"}), "r4").unwrap_err().code, "not_found");
        assert_eq!(service.execute("sessions.report", json!({}), "r5").unwrap_err().code, "invalid_arguments");

        // Only a tab asked for a report owes one, and a worker has no pipeline of its own to report to.
        assert!(!crate::worker_report::expected(&session.id, &tab));
        crate::worker_report::expect(&session.id, &tab).unwrap();
        crate::worker_report::expect(&session.id, &tab).unwrap();
        crate::worker_report::expect("a-session-that-is-gone", "t").unwrap();
        assert!(crate::worker_report::expected(&session.id, &tab) && !crate::worker_report::expected(&session.id, "another-tab"));
        assert_eq!(service.execute("sessions.report", json!({"session": session.id}), "r5b").unwrap()["reminderPending"], json!(true));
        crate::worker_report::expect(&session.id, "another-tab").unwrap();
        assert!(!crate::worker_report::expected("a-session-that-is-gone", "t"), "a deleted session's tabs are dropped");
        // Nor an agent or engine whose turn ends nobody hears, which could never be reminded.
        for switch in [json!({"issue": "433"}), json!({"autoMerge": true}), json!({"resolveConflicts": false}), json!({"experimentalCodexStdio": true}), json!({"agent": "opencode"}), json!({"agent": "cursor"})] {
            let mut params = json!({"project": project.path, "agent": "codex", "prompt": "go", "useWorktree": true, "report": true});
            params.as_object_mut().unwrap().extend(switch.as_object().unwrap().clone());
            let refused = service.execute("sessions.create", params, "r6").unwrap_err();
            assert!(refused.code == "invalid_arguments" && refused.message.contains("--report"), "{refused:?}");
        }
    }

    #[test]
    fn a_report_is_not_read_while_its_tabs_turn_is_open() {
        use crate::worker_report::OpenTurn;
        let view = |status, asks, queued, running| WaitView { status, asks, recovery: None, queued, running };
        assert_eq!(open_turn(&view(TabStatus::InProgress, false, false, true)), Some(OpenTurn::Working));
        assert_eq!(open_turn(&view(TabStatus::Completed, false, true, true)), Some(OpenTurn::Working), "a prompt behind the turn starts as it ends");
        assert_eq!(open_turn(&view(TabStatus::Waiting, false, false, true)), Some(OpenTurn::Waiting));
        assert_eq!(open_turn(&view(TabStatus::InProgress, true, false, true)), Some(OpenTurn::Waiting));
        // Finished, looked at or not, with the agent still there or gone: the last turn is the answer.
        for (status, running) in [(TabStatus::Completed, true), (TabStatus::Idle, true), (TabStatus::Idle, false)] {
            assert_eq!(open_turn(&view(status, false, false, running)), None, "{status:?} {running}");
        }
    }

    #[test]
    fn the_cli_archives_and_brings_back_sessions_as_the_app_does_and_lists_the_archived_ones() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let new = |title: &str| crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "title": title, "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        let (first, second, third) = (new("first"), new("second"), new("third"));
        let (service, sink) = headless_service();
        let mut heard = sink.subscribe();
        let ids = |listed: &Value| {
            let mut ids: Vec<String> = listed["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect();
            ids.sort();
            ids
        };
        let sorted = |mut ids: Vec<String>| { ids.sort(); ids };

        // By a prefix of one id and the whole of another, as any session command takes them.
        let result = service.execute("sessions.archive", json!({"sessions": [&first.id[..first.id.len() - 2], second.id]}), "r1").unwrap();
        assert!(result["sessions"].as_array().unwrap().iter().all(|session| session["archived"] == true));
        for expected in [&first.id, &second.id] {
            let event = heard.try_recv().unwrap();
            assert_eq!(&*event.event, "session_updated");
            let session: SessionEntry = serde_json::from_str(&event.payload).unwrap();
            assert_eq!((&session.id, session.archived, session.archive.auto_archived), (expected, true, false));
        }
        assert!(heard.try_recv().is_err(), "one event per session that changed");

        assert_eq!(ids(&service.execute("sessions.list", json!({}), "r2").unwrap()), vec![third.id.clone()]);
        assert_eq!(ids(&service.execute("sessions.list", json!({"archived": true}), "r3").unwrap()), sorted(vec![first.id.clone(), second.id.clone()]));
        assert_eq!(ids(&service.execute("sessions.list", json!({"archived": true, "project": project.path}), "r4").unwrap()).len(), 2);

        // Archiving one that is archived already tells nobody anything.
        service.execute("sessions.archive", json!({"sessions": [second.id]}), "r5").unwrap();
        assert!(heard.try_recv().is_err());

        // One unknown selector, and nothing changes.
        let refused = service.execute("sessions.unarchive", json!({"sessions": [first.id, "no-such-session"]}), "r6").unwrap_err();
        assert_eq!(refused.code, "not_found");
        assert!(index::get(&first.id).unwrap().archived);
        for empty in [json!({}), json!({"sessions": []}), json!({"sessions": [1]})] {
            assert_eq!(service.execute("sessions.archive", empty, "r7").unwrap_err().code, "invalid_arguments");
        }

        let result = service.execute("sessions.unarchive", json!({"sessions": [first.id]}), "r8").unwrap();
        assert_eq!(result["sessions"][0]["archived"], false);
        let back = index::get(&first.id).unwrap();
        assert!(!back.archived && back.archive.unarchived_at.is_some(), "it counts as idle from now");
        let event = heard.try_recv().unwrap();
        assert_eq!(serde_json::from_str::<SessionEntry>(&event.payload).unwrap().id, first.id);
        assert_eq!(ids(&service.execute("sessions.list", json!({}), "r9").unwrap()), sorted(vec![first.id.clone(), third.id.clone()]));
    }

    pub(super) fn git_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        crate::git::run(p, &["init", "-q", "-b", "main"]).unwrap();
        crate::git::run(p, &["config", "user.email", "t@example.com"]).unwrap();
        crate::git::run(p, &["config", "user.name", "T"]).unwrap();
        std::fs::write(p.join("a.txt"), "hello\n").unwrap();
        crate::git::run(p, &["add", "."]).unwrap();
        crate::git::run(p, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    fn ids(sessions: &Value) -> std::collections::BTreeSet<String> {
        sessions.as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect()
    }

    /// #719: a session of another project and a quick chat run in the
    /// worktree. `sessions list --project` does not show them, so everything
    /// that leads up to deleting the worktree must.
    #[test]
    fn every_session_a_worktree_delete_would_take_is_listed_previewed_and_named_first() {
        let _home = crate::store::temp_home();
        let (repo, elsewhere) = (git_repo(), tempfile::tempdir().unwrap());
        let project = projects::add(repo.path().to_str().unwrap()).unwrap();
        let other = projects::add(elsewhere.path().to_str().unwrap()).unwrap();
        let own = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "title": "zero-comparison", "useWorktree": true, "tab": {"harness": "claude"},
        })).unwrap()).unwrap();
        let (cwd, name) = (own.cwd.clone(), own.worktree_name.clone().unwrap());
        let foreign = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": other.path, "title": "Another project's", "useWorktree": false, "cwd": cwd,
        })).unwrap()).unwrap();
        let quick = crate::session_ops::create_quick_chat_entry(crate::session_ops::NewQuickChat {
            parent: None,
            section_id: None,
            title: Some("Quick look".into()), cwd: Some(cwd.clone()), tab: None,
        }).unwrap();
        let everyone: std::collections::BTreeSet<String> = [&own, &foreign, &quick].iter().map(|s| s.id.clone()).collect();
        let (service, _sink) = headless_service();

        // The project's own list leaves two of them out; the worktree's has all three.
        let of_project = service.execute("sessions.list", json!({"project": project.path}), "r1").unwrap();
        assert_eq!(ids(&of_project["sessions"]), std::collections::BTreeSet::from([own.id.clone()]));
        let in_worktree = service.execute("sessions.list", json!({"worktree": name, "project": project.name}), "r2").unwrap();
        assert_eq!(ids(&in_worktree["sessions"]), everyone);
        assert_eq!(in_worktree["worktree"], cwd.as_str());
        assert_eq!(service.execute("sessions.list", json!({"worktree": name, "quick": true}), "r3").unwrap_err().code, "invalid_arguments");
        assert_eq!(service.execute("sessions.list", json!({"worktree": name, "archived": true}), "r3").unwrap_err().code, "invalid_arguments");

        // `worktrees list` counts and names them; the main checkout has a count only.
        let listed = service.execute("worktrees.list", json!({"project": project.path}), "r4").unwrap();
        let worktrees = listed["projects"][0]["worktrees"].as_array().unwrap();
        let entry = worktrees.iter().find(|w| w["path"] == cwd.as_str()).unwrap();
        assert_eq!(entry["sessionCount"], 3);
        assert_eq!(ids(&entry["sessions"]), everyone);
        let belongs = |id: &str| entry["sessions"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap()["belongsTo"].clone();
        assert_eq!((belongs(&own.id), belongs(&foreign.id), belongs(&quick.id)), (json!("thisProject"), json!("anotherProject"), json!("quickChat")));
        let main = worktrees.iter().find(|w| w["isMain"] == true).unwrap();
        assert!(main.get("sessionCount").is_some() && main.get("sessions").is_none());

        let untouched = || {
            assert!(Path::new(&cwd).is_dir(), "the worktree stays");
            let left: std::collections::BTreeSet<String> = index::load().unwrap().into_iter().map(|s| s.id).collect();
            assert!(everyone.is_subset(&left), "every session stays");
        };

        // Without --yes: what would go is named, and nothing goes.
        let refused = service.execute("worktrees.delete", json!({"project": project.path, "worktree": name}), "r5").unwrap_err();
        assert_eq!(refused.code, "confirmation_required");
        for expected in ["zero-comparison", "\"Another project's\" (another project: ", "\"Quick look\" (a quick chat, no project)", "would delete 3 sessions"] {
            assert!(refused.message.contains(expected), "{expected}: {}", refused.message);
        }
        let recovery = refused.recovery.unwrap();
        assert!(everyone.iter().all(|id| recovery.contains(id.as_str())), "the recovery names the sessions to pass: {recovery}");
        untouched();

        // --dry-run: the same, as data.
        let preview = service.execute("worktrees.delete", json!({"project": project.path, "worktree": name, "dryRun": true}), "r6").unwrap();
        assert_eq!(preview["dryRun"], true);
        assert_eq!(ids(&preview["sessions"]), everyone);
        assert_eq!(preview["needsForce"], true, "no remote, so it cannot be verified as merged");
        assert!(preview["landed"]["losses"].as_array().is_some_and(|losses| !losses.is_empty()));
        assert_eq!(service.execute("worktrees.delete", json!({"worktree": name, "dryRun": true, "confirmed": true}), "r7").unwrap_err().code, "invalid_arguments");
        untouched();

        // --sessions that leave one out: nothing goes, and the missing one is named.
        let partial = service.execute("worktrees.delete", json!({
            "project": project.path, "worktree": name, "confirmed": true, "force": true, "sessions": [own.id, quick.id],
        }), "r8").unwrap_err();
        assert_eq!(partial.code, "sessions_changed");
        let (missing, _) = partial.message.split_once("It holds:").unwrap();
        assert!(missing.contains(&foreign.id) && missing.contains("Another project's"), "{}", partial.message);
        assert!(!missing.contains(&own.id), "{}", partial.message);
        untouched();

        // Named exactly (one by the start of its id: UUIDv7 ids share their first
        // characters, the time they were made), it goes, and the result says what went.
        let deleted = service.execute("worktrees.delete", json!({
            "project": project.path, "worktree": name, "confirmed": true, "force": true, "sessions": [own.id, quick.id, &foreign.id[..30]],
        }), "r9").unwrap();
        assert!(!Path::new(&cwd).exists());
        let removed = deleted["removedSessions"].as_array().unwrap();
        assert_eq!(ids(&deleted["removedSessions"]), everyone);
        let of = |id: &str| removed.iter().find(|s| s["id"] == id).unwrap().clone();
        assert_eq!((of(&own.id)["title"].clone(), of(&own.id)["project"].clone()), (json!("zero-comparison"), json!(project.path)));
        assert_eq!((of(&foreign.id)["title"].clone(), of(&foreign.id)["project"].clone()), (json!("Another project's"), json!(other.path)));
        assert_eq!((of(&quick.id)["title"].clone(), of(&quick.id)["project"].clone()), (json!("Quick look"), Value::Null));
        assert!(index::load().unwrap().iter().all(|s| !everyone.contains(&s.id)));
    }

    /// PRO-364: a lead in its own worktree, and a worker per entry of
    /// `merged`, each in a worktree of its own with one commit, which the lead
    /// has merged into its branch when the entry is true. The run is done.
    fn lead_with_workers(project: &Project, merged: &[bool]) -> (SessionEntry, Vec<SessionEntry>, String) {
        let new = |title: &str| crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "title": title, "useWorktree": true, "tab": {"harness": "claude"},
        })).unwrap()).unwrap();
        let lead = new("the lead");
        let mut workers = Vec::new();
        let mut pieces = Vec::new();
        for (index, merged) in merged.iter().enumerate() {
            let piece = format!("p{index}");
            let worker = new(&format!("worker {piece}"));
            let cwd = Path::new(&worker.cwd);
            std::fs::write(cwd.join(format!("{piece}.txt")), "work\n").unwrap();
            crate::git::run(cwd, &["add", "."]).unwrap();
            crate::git::run(cwd, &["commit", "-q", "-m", &format!("Work of {piece}")]).unwrap();
            let commit = crate::git::run(cwd, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
            if *merged {
                crate::git::run(Path::new(&lead.cwd), &["merge", "-q", "--no-ff", "-m", &format!("Merge {piece}"), &commit]).unwrap();
            }
            let at = json!({"sessionId": worker.id, "tabId": worker.tabs[0].id});
            pieces.push(json!({
                "id": piece, "title": format!("Piece {piece}"), "brief": {"goal": "a goal"}, "owns": [format!("{piece}.txt")], "dependsOn": [],
                "doneChecks": [{"type": "command", "run": "true"}], "agent": "claude", "state": "done", "worker": at,
                "tries": [{"step": "first", "worker": at, "outcome": "done",
                    "verification": {"gates": [], "facts": {"files": [format!("{piece}.txt")], "changedLines": 1, "commit": commit}, "outcome": "passed"}}],
            }));
            workers.push(worker);
        }
        let run: crate::orchestration::Run = serde_json::from_value(json!({
            "id": "run-of-the-lead", "lead": {"sessionId": lead.id, "tabId": lead.tabs[0].id}, "projectPath": project.path, "goal": "Bring the pieces together",
            "state": "done", "pieces": pieces, "workerMode": "bypassPermissions", "approval": {"at": "2026-11-12T09:00:00Z"},
            "created": "2026-11-12T09:00:00Z", "modified": "2026-11-12T09:00:00Z",
        })).unwrap();
        crate::orchestration::store::insert(&run).unwrap();
        (lead, workers, run.id)
    }

    /// PRO-364: deleting a lead's worktree runs its run's cleanup first, so
    /// its workers do not stay behind as top-level rows without a lead.
    #[test]
    fn worktree_delete_of_a_leads_worktree_removes_its_merged_clean_workers_first() {
        let _home = crate::store::temp_home();
        let repo = git_repo();
        let project = projects::add(repo.path().to_str().unwrap()).unwrap();
        let (lead, workers, run) = lead_with_workers(&project, &[true, true]);
        let name = lead.worktree_name.clone().unwrap();
        let (service, _sink) = headless_service();
        let worker_ids: std::collections::BTreeSet<String> = workers.iter().map(|w| w.id.clone()).collect();

        // The preview lists the two workers the delete would otherwise orphan, and that nothing blocks it.
        let preview = service.execute("worktrees.delete", json!({"project": project.path, "worktree": name, "dryRun": true}), "r1").unwrap();
        assert_eq!(ids(&preview["sessions"]), std::collections::BTreeSet::from([lead.id.clone()]), "only the lead is in its worktree");
        let orphans = preview["orphans"].as_array().unwrap();
        assert_eq!(orphans.iter().map(|o| o["session"]["id"].as_str().unwrap().to_string()).collect::<std::collections::BTreeSet<_>>(), worker_ids);
        assert!(orphans.iter().all(|o| o["run"] == run.as_str() && o.get("blocked").is_none() && o["worktree"].is_string()), "{orphans:?}");
        let asked = service.execute("worktrees.delete", json!({"project": project.path, "worktree": name}), "r2").unwrap_err();
        assert_eq!(asked.code, "confirmation_required");
        for expected in ["holds the lead of run run-of-the-lead", "worker p0", "worker p1", "the run's cleanup removes each of them"] {
            assert!(asked.message.contains(expected), "{expected}: {}", asked.message);
        }
        assert!(workers.iter().all(|w| Path::new(&w.cwd).is_dir()), "a preview removes nothing");

        // Confirmed without --force: the lead's worktree cannot be verified as merged (no remote),
        // so the delete stops, and stops before any worker goes.
        let unforced = service.execute("worktrees.delete", json!({
            "project": project.path, "worktree": name, "confirmed": true, "sessions": [lead.id],
        }), "r2b").unwrap_err();
        assert_eq!(unforced.code, "needs_force", "{}", unforced.message);
        assert!(unforced.message.contains("its workers included"), "{}", unforced.message);
        assert!(Path::new(&lead.cwd).is_dir() && workers.iter().all(|w| Path::new(&w.cwd).is_dir()), "a delete that stops removes no worker");
        let still: std::collections::BTreeSet<String> = index::load().unwrap().into_iter().map(|s| s.id).collect();
        assert!(worker_ids.is_subset(&still) && still.contains(&lead.id), "{still:?}");

        let branches: Vec<String> = workers.iter().map(|w| crate::git::run(Path::new(&w.cwd), &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim().to_string()).collect();
        // Confirmed: the workers go first, worktree and session, then the lead's worktree.
        let deleted = service.execute("worktrees.delete", json!({
            "project": project.path, "worktree": name, "confirmed": true, "force": true, "sessions": [lead.id],
        }), "r3").unwrap();
        assert_eq!(ids(&deleted["removedSessions"]), std::collections::BTreeSet::from([lead.id.clone()]));
        assert!(!Path::new(&lead.cwd).exists());
        assert!(workers.iter().all(|w| !Path::new(&w.cwd).exists()), "each worker's worktree is removed");
        let left: std::collections::BTreeSet<String> = index::load().unwrap().into_iter().map(|s| s.id).collect();
        assert!(left.is_disjoint(&worker_ids) && !left.contains(&lead.id), "no worker is left as a top-level row: {left:?}");
        // Their branches stay.
        for branch in &branches {
            assert!(crate::git::run(repo.path(), &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).is_ok(), "{branch}");
        }
    }

    /// PRO-364: a worker the run's cleanup would not remove keeps the lead's
    /// worktree: the delete names it, with what to do, and removes nothing.
    #[test]
    fn worktree_delete_of_a_leads_worktree_with_an_unmerged_worker_lists_it_and_refuses() {
        let _home = crate::store::temp_home();
        let repo = git_repo();
        let project = projects::add(repo.path().to_str().unwrap()).unwrap();
        let (lead, workers, run) = lead_with_workers(&project, &[true, false]);
        let name = lead.worktree_name.clone().unwrap();
        let (service, _sink) = headless_service();
        let untouched = || {
            assert!(Path::new(&lead.cwd).is_dir(), "the lead's worktree stays");
            assert!(workers.iter().all(|w| Path::new(&w.cwd).is_dir()), "every worker's worktree stays");
            let left: std::collections::BTreeSet<String> = index::load().unwrap().into_iter().map(|s| s.id).collect();
            assert!(workers.iter().chain([&lead]).all(|s| left.contains(&s.id)), "every session stays");
        };

        let preview = service.execute("worktrees.delete", json!({"project": project.path, "worktree": name, "dryRun": true}), "r1").unwrap();
        let orphans = preview["orphans"].as_array().unwrap();
        let of = |id: &str| orphans.iter().find(|o| o["session"]["id"] == id).unwrap().clone();
        assert!(of(&workers[0].id).get("blocked").is_none());
        assert!(of(&workers[1].id)["blocked"].as_str().unwrap().contains("1 commit that is not in"), "{:?}", of(&workers[1].id));
        untouched();

        let refused = service.execute("worktrees.delete", json!({
            "project": project.path, "worktree": name, "confirmed": true, "force": true, "sessions": [lead.id],
        }), "r2").unwrap_err();
        assert_eq!(refused.code, "workers_would_be_orphaned");
        for expected in [format!("holds the lead of run {run}"), "worker p1".to_string(), workers[1].id.clone(), workers[1].cwd.clone()] {
            assert!(refused.message.contains(&expected), "{expected}: {}", refused.message);
        }
        assert!(!refused.message.contains("worker p0"), "only the one that blocks is named: {}", refused.message);
        let recovery = refused.recovery.unwrap();
        assert!(recovery.contains(&format!("terminalx runs cleanup {run}")) && recovery.contains("terminalx worktrees delete"), "{recovery}");
        assert_eq!(refused.details.unwrap()["orphans"].as_array().unwrap().len(), 1);
        untouched();
    }

    /// #719: a session that names its project through a symlink is one of
    /// the project's sessions.
    #[cfg(unix)]
    #[test]
    fn a_project_lists_a_session_that_names_it_through_a_symlink() {
        let _home = crate::store::temp_home();
        let (dir, links) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let session = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        let link = links.path().join("project");
        std::os::unix::fs::symlink(&project.path, &link).unwrap();
        let spelled = format!("{}/", link.to_string_lossy());
        index::update_session(&session.id, |entry| { entry.project_path = spelled.clone(); Ok(()) }).unwrap();
        let (service, _sink) = headless_service();
        for selector in [project.path.as_str(), project.name.as_str()] {
            let listed = service.execute("sessions.list", json!({"project": selector}), "r").unwrap();
            assert_eq!(ids(&listed["sessions"]), std::collections::BTreeSet::from([session.id.clone()]), "{selector}");
        }
        // Another folder is still another project.
        let unrelated = projects::add(links.path().to_str().unwrap()).unwrap();
        assert!(ids(&service.execute("sessions.list", json!({"project": unrelated.path}), "r").unwrap()["sessions"]).is_empty());
    }

    /// PRO-270: who started a new session, settled before it is created.
    #[test]
    fn a_new_sessions_parent_is_the_caller_the_named_session_or_nobody() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let session = || crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        let (lead, other) = (session(), session());
        let lead_tab = lead.tabs[0].id.clone();
        let from_lead = json!({"session": lead.id, "tab": lead_tab});
        let parent = |session: &SessionEntry, tab: Option<&str>| Some(index::ParentRef { session_id: session.id.clone(), tab_id: tab.map(str::to_owned) });

        // Run in a session: that session and the tab that asked.
        assert_eq!(parent_of_new_session(None, false, &from_lead).unwrap(), parent(&lead, Some(&lead_tab)));
        // A tab that is not the session's is not recorded as one of its tabs.
        assert_eq!(parent_of_new_session(None, false, &json!({"session": lead.id, "tab": other.tabs[0].id})).unwrap(), parent(&lead, None));
        // Run anywhere else, or in a session the app no longer has: nobody, and no failure.
        for nobody in [Value::Null, json!({}), json!({"session": null, "tab": null}), json!({"session": "gone", "tab": "t"}), json!({"session": &lead.id[..lead.id.len() - 2]})] {
            assert_eq!(parent_of_new_session(None, false, &nobody).unwrap(), None, "{nobody}");
        }
        // --parent wins over where it ran, by id or the start of one; the tab is known only when it is the caller's own session.
        assert_eq!(parent_of_new_session(Some(&other.id), false, &from_lead).unwrap(), parent(&other, None));
        assert_eq!(parent_of_new_session(Some(&lead.id[..lead.id.len() - 2]), false, &from_lead).unwrap(), parent(&lead, Some(&lead_tab)));
        assert_eq!(parent_of_new_session(Some(&lead.id), false, &Value::Null).unwrap(), parent(&lead, None));
        // --no-parent: nobody, whoever asks.
        assert_eq!(parent_of_new_session(None, true, &from_lead).unwrap(), None);
        assert_eq!(parent_of_new_session(Some(&lead.id), true, &from_lead).unwrap_err().code, "invalid_arguments");
        // An unknown parent is its own error, and an ambiguous one stays ambiguous.
        let unknown = parent_of_new_session(Some("no-such-session"), false, &from_lead).unwrap_err();
        assert_eq!(unknown.code, "parent_not_found");
        assert!(unknown.message.contains("no-such-session") && unknown.recovery.unwrap().contains("--no-parent"));
        assert_eq!(parent_of_new_session(Some(""), false, &from_lead).unwrap_err().code, "invalid_arguments");
        let shared: String = lead.id.chars().zip(other.id.chars()).take_while(|(a, b)| a == b).map(|(a, _)| a).collect();
        assert!(!shared.is_empty(), "two ids made in the same moment share their timestamp");
        assert_eq!(parent_of_new_session(Some(&shared), false, &Value::Null).unwrap_err().code, "ambiguous_selector");

        // The request refuses an unknown parent before it creates anything.
        let (service, _sink) = headless_service();
        for request in [
            json!({"project": project.path, "agent": "claude", "prompt": "hi", "useWorktree": true, "parent": "no-such-session"}),
            json!({"quick": true, "agent": "claude", "prompt": "hi", "parent": "no-such-session"}),
        ] {
            let before = index::load().unwrap().len();
            let refused = service.execute("sessions.create", request, "r").unwrap_err();
            assert_eq!(refused.code, "parent_not_found");
            assert_eq!(index::load().unwrap().len(), before);
        }
    }

    /// PRO-273: a lead's own usage, a row per worker, and the grand total;
    /// and once the lead is gone, its workers alone.
    #[test]
    fn sessions_usage_reports_a_lead_its_workers_and_their_total() {
        use crate::session_usage::{ModelUsage, TabUsage};
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let create = |lead: Option<&SessionEntry>, harness: &str| crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "title": "worker",
            "parent": lead.map(|lead| json!({"sessionId": lead.id, "tabId": lead.tabs[0].id})).unwrap_or(Value::Null),
            "tab": {"harness": harness},
        })).unwrap()).unwrap();
        // Totals as a turn end left them; these tabs have no transcript to read again.
        let used = |session: &SessionEntry, model: &str, input: u64, cost: Option<f64>| {
            index::update_tab(&session.id, &session.tabs[0].id, |tab| {
                tab.usage = Some(TabUsage { models: vec![ModelUsage { model: model.into(), input_tokens: input, output_tokens: 10, cost_usd: cost, ..Default::default() }], updated: "t".into() });
                Ok(())
            }).unwrap();
        };
        let lead = create(None, "claude");
        let codex = create(Some(&lead), "codex");
        let claude = create(Some(&lead), "claude");
        let unpriced = create(Some(&lead), "claude");
        let unrelated = create(None, "codex");
        used(&lead, "claude-opus-5-5", 100, Some(1.0));
        used(&codex, "gpt-5.6-sol", 200, Some(0.5));
        used(&claude, "claude-opus-5-5", 300, Some(0.25));
        used(&unpriced, "claude-new-9", 400, None);
        used(&unrelated, "gpt-5.6-sol", 9999, Some(9.0));
        let (service, _sink) = headless_service();

        let report = service.execute("sessions.usage", json!({"childrenOf": lead.id}), "r").unwrap();
        assert_eq!(report["parent"], json!({"sessionId": lead.id, "title": lead.title, "exists": true}));
        assert_eq!(report["lead"]["sessionId"], json!(lead.id));
        assert_eq!(report["lead"]["total"]["costUsd"], json!(1.0));
        let workers = report["workers"].as_array().unwrap();
        let mut rows: Vec<(String, Value)> = workers.iter().map(|w| (w["sessionId"].as_str().unwrap().to_string(), w["total"]["costUsd"].clone())).collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        let mut expected = vec![(codex.id.clone(), json!(0.5)), (claude.id.clone(), json!(0.25)), (unpriced.id.clone(), Value::Null)];
        expected.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(rows, expected, "a row per worker, the unrelated session left out");
        assert_eq!(report["total"]["inputTokens"], json!(1000));
        assert_eq!(report["total"]["costUsd"], json!(1.75));
        assert_eq!(report["total"]["unpricedModels"], json!(["claude-new-9"]));
        let opus = report["models"].as_array().unwrap().iter().find(|m| m["model"] == "claude-opus-5-5").unwrap().clone();
        assert_eq!((opus["inputTokens"].clone(), opus["costUsd"].clone()), (json!(400), json!(1.25)), "the lead's and a worker's rows of one model merged");

        // One session, and the cost `sessions list` carries.
        let one = service.execute("sessions.usage", json!({"session": codex.id}), "r").unwrap();
        assert_eq!((one["tabs"].as_array().unwrap().len(), one["total"]["costUsd"].clone()), (1, json!(0.5)));
        let listed = service.execute("sessions.list", json!({}), "r").unwrap();
        let entry = |id: &str| listed["sessions"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap().clone();
        assert_eq!(entry(&codex.id)["estimatedCostUsd"], json!(0.5));
        assert_eq!((entry(&unpriced.id)["estimatedCostUsd"].clone(), entry(&unpriced.id)["estimatedCostUnpricedModels"].clone()), (Value::Null, json!(["claude-new-9"])));
        assert_eq!(service.execute("sessions.show", json!({"session": lead.id}), "r").unwrap()["estimatedCostUsd"], json!(1.0));

        // The lead deleted: named by its full id, its workers still answer.
        index::save(&index::load().unwrap().into_iter().filter(|s| s.id != lead.id).collect::<Vec<_>>()).unwrap();
        let orphaned = service.execute("sessions.usage", json!({"childrenOf": lead.id}), "r").unwrap();
        assert_eq!((orphaned["parent"]["exists"].clone(), orphaned["lead"].clone()), (json!(false), Value::Null));
        assert_eq!(orphaned["workers"].as_array().unwrap().len(), 3);
        assert_eq!(orphaned["total"]["costUsd"], json!(0.75));
        for (params, code) in [(json!({}), "invalid_arguments"), (json!({"childrenOf": "no-such-session"}), "not_found"), (json!({"session": "no-such-session"}), "not_found")] {
            assert_eq!(service.execute("sessions.usage", params, "r").unwrap_err().code, code);
        }
    }

    /// PRO-270: exactly the sessions a lead started, wherever they are.
    #[test]
    fn a_leads_workers_are_listed_across_projects_and_worktrees_and_outlive_it() {
        let _home = crate::store::temp_home();
        let (repo, elsewhere) = (git_repo(), tempfile::tempdir().unwrap());
        let project = projects::add(repo.path().to_str().unwrap()).unwrap();
        let second = projects::add(elsewhere.path().to_str().unwrap()).unwrap();
        let started_by = |lead: Option<&SessionEntry>| lead.map(|lead| json!({"sessionId": lead.id, "tabId": lead.tabs[0].id})).unwrap_or(Value::Null);
        let create = |project: &Project, worktree: bool, lead: Option<&SessionEntry>| crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": worktree, "title": "worker", "parent": started_by(lead),
            "tab": {"harness": "codex", "model": "gpt-5.5", "effort": "high"},
        })).unwrap()).unwrap();
        let lead = create(&project, false, None);
        let rival = create(&project, false, None);
        // The lead's: one in a worktree of its own project, one in another project, a quick chat, an archived one.
        let in_worktree = create(&project, true, Some(&lead));
        let in_other_project = create(&second, false, Some(&lead));
        let quick = crate::session_ops::create_quick_chat_entry(crate::session_ops::NewQuickChat {
            parent: Some(index::ParentRef { session_id: lead.id.clone(), tab_id: None }),
            section_id: None, title: Some("Quick look".into()), cwd: None, tab: None,
        }).unwrap();
        let archived = create(&project, false, Some(&lead));
        // Not the lead's: another lead's worker, a worker's own worker, and one nobody started.
        let rivals = create(&project, true, Some(&rival));
        let grandchild = create(&project, false, Some(&in_worktree));
        let unowned = create(&project, true, None);
        let (service, _sink) = headless_service();
        service.execute("sessions.archive", json!({"sessions": [archived.id]}), "r").unwrap();

        let listed = service.execute("sessions.children", json!({"childrenOf": lead.id}), "r").unwrap();
        let mine: std::collections::BTreeSet<String> = [&in_worktree, &in_other_project, &quick, &archived].iter().map(|s| s.id.clone()).collect();
        assert_eq!(ids(&listed["sessions"]), mine);
        assert_eq!(listed["parent"], json!({"sessionId": lead.id, "title": lead.title, "exists": true}));
        let workers = listed["workers"].as_array().unwrap();
        assert_eq!(workers.iter().map(|worker| worker["sessionId"].as_str().unwrap().to_string()).collect::<std::collections::BTreeSet<_>>(), mine);
        let row = |session: &SessionEntry| workers.iter().find(|worker| worker["sessionId"] == session.id.as_str()).unwrap().clone();
        let worker = row(&in_worktree);
        assert_eq!(worker, json!({
            "sessionId": in_worktree.id, "title": "worker", "kind": "project",
            "tabId": in_worktree.tabs[0].id, "agent": "codex", "status": "idle", "model": "gpt-5.5", "effort": "high", "running": false,
            "worktree": in_worktree.worktree_name, "path": in_worktree.cwd, "branch": in_worktree.branch,
            "archived": false, "created": in_worktree.created, "parent": {"sessionId": lead.id, "tabId": lead.tabs[0].id},
        }));
        assert!(worker["worktree"].is_string() && worker["branch"].is_string() && worker["path"] != json!(project.path));
        assert_eq!((&row(&in_other_project)["path"], &row(&in_other_project)["worktree"]), (&json!(in_other_project.cwd), &Value::Null));
        assert_eq!(row(&archived)["archived"], true);
        // A quick chat with no agent yet has none of an agent's fields.
        assert_eq!((&row(&quick)["kind"], &row(&quick)["tabId"], &row(&quick)["status"], &row(&quick)["model"]), (&json!("quick"), &Value::Null, &Value::Null, &Value::Null));

        // By the start of the id too; each lead has its own, and a worker is a lead of what it started.
        assert_eq!(ids(&service.execute("sessions.children", json!({"childrenOf": &rival.id[..rival.id.len() - 1]}), "r").unwrap()["sessions"]), [rivals.id.clone()].into());
        assert_eq!(ids(&service.execute("sessions.children", json!({"childrenOf": in_worktree.id}), "r").unwrap()["sessions"]), [grandchild.id.clone()].into());
        assert!(ids(&service.execute("sessions.children", json!({"childrenOf": unowned.id}), "r").unwrap()["sessions"]).is_empty());
        // The plain list is what it was: the link filters nothing there.
        assert_eq!(service.execute("sessions.list", json!({}), "r").unwrap()["sessions"].as_array().unwrap().len(), 8);
        for (params, code) in [(json!({}), "invalid_arguments"), (json!({"childrenOf": "no-such-session"}), "not_found")] {
            assert_eq!(service.execute("sessions.children", params.clone(), "r").unwrap_err().code, code);
            assert_eq!(service.execute("sessions.stop", params, "r").unwrap_err().code, code);
        }

        // One report row for each of them, read from the worker's own agent; a worker that has said nothing is missing.
        let log = crate::store::log_path(&in_worktree.id, &in_worktree.tabs[0].id).unwrap();
        for (seq, payload) in [
            json!({"type": "user_message", "text": "Audit the handlers."}), json!({"type": "turn_started"}),
            json!({"type": "assistant_text", "text": "Audited.\n\n```terminalx-report\n{\"status\":\"partial\",\"result\":\"Two of three handlers checked.\",\"notDone\":[\"admin handler: no access\"]}\n```"}),
            json!({"type": "turn_completed", "status": "ok"}),
        ].into_iter().enumerate() {
            let event = json!({"id": format!("e{seq}"), "sessionId": in_worktree.id, "tabId": in_worktree.tabs[0].id, "harness": "codex", "seq": seq + 1, "ts": "2026-11-10T10:00:00.000Z", "payload": payload});
            crate::store::append_line(&log, &event.to_string()).unwrap();
        }
        let read = service.execute("sessions.report", json!({"childrenOf": lead.id}), "r").unwrap();
        assert_eq!(read["parent"], listed["parent"]);
        let reports = read["reports"].as_array().unwrap();
        assert_eq!(reports.iter().map(|report| report["sessionId"].as_str().unwrap().to_string()).collect::<std::collections::BTreeSet<_>>(), mine);
        let report = |session: &SessionEntry| reports.iter().find(|report| report["sessionId"] == session.id.as_str()).unwrap().clone();
        let done = report(&in_worktree);
        assert_eq!((done["status"].as_str(), done["result"].as_str(), &done["notDone"], done["seq"].as_u64()), (Some("partial"), Some("Two of three handlers checked."), &json!(["admin handler: no access"]), Some(3)));
        assert_eq!((done["tabId"].as_str(), done["title"].as_str()), (Some(in_worktree.tabs[0].id.as_str()), Some("worker")));
        // The row is the one `sessions report <session>` gives, with the session's title.
        let mut alone = service.execute("sessions.report", json!({"session": in_worktree.id}), "r").unwrap();
        alone["title"] = json!("worker");
        assert_eq!(done, alone);
        for silent in [&in_other_project, &archived] {
            assert_eq!((report(silent)["status"].as_str(), report(silent)["reason"].as_str()), (Some("missing"), Some("noTurn")));
        }
        assert_eq!((report(&quick)["status"].as_str(), report(&quick)["reason"].as_str(), &report(&quick)["tabId"], report(&quick)["title"].as_str()), (Some("missing"), Some("noAgent"), &Value::Null, Some("Quick look")));
        // A lead with no workers has no reports, which is not an error; a session that is not there is.
        assert_eq!(service.execute("sessions.report", json!({"childrenOf": unowned.id}), "r").unwrap()["reports"], json!([]));
        assert_eq!(service.execute("sessions.report", json!({"childrenOf": "no-such-session"}), "r").unwrap_err().code, "not_found");

        // Nothing of the lead's is running: stopping them stops nothing, and says how many it looked at.
        let stopped = service.execute("sessions.stop", json!({"childrenOf": lead.id}), "r").unwrap();
        assert_eq!((&stopped["workers"], &stopped["stopped"], &stopped["failed"]), (&json!(4), &json!([]), &json!([])));

        // Archiving the lead, then deleting it, leaves its workers and their record as they are.
        service.execute("sessions.archive", json!({"sessions": [lead.id]}), "r").unwrap();
        assert_eq!(ids(&service.execute("sessions.children", json!({"childrenOf": lead.id}), "r").unwrap()["sessions"]), mine);
        index::update(|sessions| { sessions.retain(|session| session.id != lead.id); Ok(()) }).unwrap();
        let orphaned = service.execute("sessions.children", json!({"childrenOf": lead.id}), "r").unwrap();
        assert_eq!(ids(&orphaned["sessions"]), mine);
        assert_eq!(orphaned["parent"], json!({"sessionId": lead.id, "title": null, "exists": false}));
        assert!(orphaned["sessions"].as_array().unwrap().iter().all(|session| session["parent"]["sessionId"] == lead.id.as_str()));
        // A lead that is gone is named in full: the start of its id matches nothing any more.
        assert_eq!(service.execute("sessions.children", json!({"childrenOf": &lead.id[..lead.id.len() - 1]}), "r").unwrap_err().code, "not_found");
    }

    #[test]
    fn a_session_request_says_whether_it_is_a_quick_chat_or_names_its_project() {
        let _home = crate::store::temp_home();
        let (service, _sink) = headless_service();
        let refused = |params: Value| service.execute("sessions.create", params, "r").unwrap_err();
        // Neither: the caller is told about --quick rather than left guessing.
        let error = refused(json!({"agent": "claude", "prompt": "hi", "useWorktree": true}));
        assert_eq!(error.code, "invalid_arguments");
        assert!(error.message.contains("--quick"), "{}", error.message);
        // Both, or a quick chat with what only a project session has.
        for params in [
            json!({"quick": true, "project": "api", "agent": "claude", "prompt": "hi"}),
            json!({"quick": true, "name": "fix", "agent": "claude", "prompt": "hi"}),
            json!({"quick": true, "useWorktree": true, "agent": "claude", "prompt": "hi"}),
            json!({"quick": true, "onMain": true, "agent": "claude", "prompt": "hi"}),
        ] {
            assert_eq!(refused(params).code, "invalid_arguments");
        }
        assert_eq!(refused(json!({"project": "api", "cwd": "/tmp", "agent": "claude", "prompt": "hi", "useWorktree": true})).code, "invalid_arguments");
        assert!(index::load().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(crate::store::quick::root().unwrap()).unwrap().count(), 0);
    }

    #[test]
    fn the_floating_window_is_the_desktop_apps_and_a_headless_runtime_says_so() {
        let _home = crate::store::temp_home();
        let (service, sink) = headless_service();
        let mut events = sink.subscribe();
        for command in ["floating.show", "floating.hide", "floating.toggle"] {
            assert_eq!(service.execute(command, json!({}), "r").unwrap_err().code, "unsupported");
        }
        assert!(events.try_recv().is_err(), "nothing was asked of a window that does not exist");
    }

    #[test]
    fn rename_commands_update_persisted_sessions_and_publish_changes() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        crate::git::run(root, &["init", "-q", "-b", "main"]).unwrap();
        crate::git::run(root, &["config", "user.email", "t@example.com"]).unwrap();
        crate::git::run(root, &["config", "user.name", "T"]).unwrap();
        crate::git::run(root, &["commit", "--allow-empty", "-qm", "initial"]).unwrap();
        let project = projects::add(root.to_str().unwrap()).unwrap();
        let first = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": true, "worktreeName": "old",
            "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        let second = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "cwd": first.cwd,
        })).unwrap()).unwrap();
        let sink = Arc::new(crate::sink::BroadcastSink::new(16));
        let mut events = sink.subscribe();
        let endpoint = crate::hooks::prepare_control().unwrap();
        let manager = SessionManager::new(
            sink.clone(), Arc::new(crate::sink::NoObserver),
            Arc::new(crate::harness::host::Host::new()), Arc::new(crate::pty::Terminals::new()),
            Arc::new(Default::default()), Arc::new(Default::default()), endpoint.clone(),
        );
        let service = ControlService::headless(sink, manager, endpoint, "test".into());
        let result = service.execute("sessions.rename", json!({"session": first.id, "title": "#203 review"}), "r1").unwrap();
        assert_eq!(result["session"]["title"], "#203 review");
        assert_eq!(index::get(&first.id).unwrap().title, "#203 review");
        assert_eq!(index::get(&second.id).unwrap().title, second.title);
        assert_eq!(&*events.try_recv().unwrap().event, "session_updated");

        for status in ["backlog", "in_progress", "in_review", "done", "canceled"] {
            let result = service.execute("sessions.status", json!({"session": &first.id[..first.id.len() - 2], "status": status}), "status").unwrap();
            assert_eq!(result["session"]["manualStatus"], status);
            let event = events.try_recv().unwrap();
            assert_eq!(&*event.event, "session_updated");
            assert_eq!(serde_json::from_str::<Value>(&event.payload).unwrap()["manualStatus"], status);
            assert_eq!(index::get(&second.id).unwrap().manual_status, None);
        }
        for status in [Value::Null, json!("working"), json!(42)] {
            assert_eq!(service.execute("sessions.status", json!({"session": first.id, "status": status}), "invalid").unwrap_err().code, "invalid_arguments");
            assert!(events.try_recv().is_err());
        }

        let result = service.execute("worktrees.rename", json!({"worktree": "old", "name": "Fix 203", "project": project.path}), "r2").unwrap();
        assert_eq!(result["name"], "fix-203");
        assert_eq!(result["branch"], "raccoon/fix-203");
        assert_eq!(result["sessions"].as_array().unwrap().len(), 2);
        for id in [&first.id, &second.id] {
            let session = index::get(id).unwrap();
            assert_eq!(session.cwd, result["path"].as_str().unwrap());
            assert_eq!(session.worktree_name.as_deref(), Some("fix-203"));
            assert_eq!(&*events.try_recv().unwrap().event, "session_updated");
        }
        assert_eq!(&*events.try_recv().unwrap().event, "workspaces_changed");
        crate::git::run(root, &["branch", "raccoon/taken"]).unwrap();
        for name in ["!!!", "taken"] {
            let error = service.execute("worktrees.rename", json!({"worktree": "fix-203", "name": name}), "r3").unwrap_err();
            assert_eq!(error.code, "invalid_arguments");
            assert!(events.try_recv().is_err());
        }
        let error = service.execute("worktrees.rename", json!({"worktree": project.path, "name": "renamed-main"}), "r4").unwrap_err();
        assert_eq!(error.code, "invalid_arguments");
        assert_eq!(index::get(&first.id).unwrap().worktree_name.as_deref(), Some("fix-203"));
    }

    #[test]
    fn control_session_target_requires_explicit_on_main() {
        assert!(validate_control_session_target(true, false).is_ok());
        assert!(validate_control_session_target(false, true).is_ok());
        assert!(validate_control_session_target(true, true).is_err());
        let error = validate_control_session_target(false, false).unwrap_err();
        assert!(error.message.contains("onMain"));
    }

    #[test]
    fn resolves_an_agentless_session_for_cli_show_and_tab_listing() {
        let _home = crate::store::temp_home();
        let session = SessionEntry {
            id: "zero-tab-session".into(),
            kind: crate::store::index::SessionKind::Project,
            project_path: "/repo".into(),
            cwd: "/repo".into(),
            worktree_name: None,
            branch: Some("main".into()),
            base_ref: None,
            worktree_base: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: None,
            issue_work: Default::default(),
            automation: None,
            title: "main".into(),
            created: "now".into(),
            modified: "now".into(),
            archived: false,
            archive: Default::default(),
            pinned: false,
            manual_status: Default::default(),
            tabs: Vec::new(),
            active_tab: None,
            link: None,
            parent: None,
            unknown: std::collections::BTreeMap::new(),
        };
        index::update(|sessions| {
            sessions.push(session.clone());
            Ok(())
        })
        .unwrap();

        let resolved = resolve_session("zero-tab").unwrap();
        assert_eq!(resolved, session);
        assert!(resolved.tabs.is_empty());
    }

    #[test]
    fn request_and_response_are_single_line_json() {
        let request = ControlRequest {
            id: "r1".into(),
            token: "secret".into(),
            command: "sessions.list".into(),
            params: json!({"project": "/tmp/repo"}),
        };
        let encoded = serde_json::to_string(&request).unwrap();
        assert!(!encoded.contains('\n'));
        assert_eq!(
            serde_json::from_str::<ControlRequest>(&encoded).unwrap(),
            request
        );

        let response = ControlResponse::failure(
            "r1",
            ControlError::new("not_found", "gone", Some("list again".into())),
        );
        let encoded = serde_json::to_string(&response).unwrap();
        assert!(!encoded.contains('\n'));
        assert_eq!(
            serde_json::from_str::<ControlResponse>(&encoded).unwrap(),
            response
        );
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn computer_errors_keep_their_code_and_gain_the_guide_recovery() {
        let error = computer_error(crate::computer::ComputerError::new(
            "app_not_found",
            "no app matches Gmail",
        ));
        assert_eq!(error.code, "app_not_found");
        assert_eq!(error.message, "no app matches Gmail");
        assert!(error.recovery.unwrap().contains("list-apps"));
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn a_pipeline_is_named_by_its_issue_its_id_or_its_session() {
        let _home = crate::store::temp_home();
        let in_project = |project: &str, id: &str, identifier: &str, session: &str| -> crate::issue_pipeline::Pipeline {
            serde_json::from_value(json!({
                "id": id, "projectPath": project, "branch": "raccoon/x",
                "issue": {"provider": "github", "id": "1", "identifier": identifier, "title": "T", "url": format!("https://example.test/{identifier}")},
                "author": {"sessionId": session, "tabId": "t1"},
                "stage": "work", "state": "working", "maxRounds": 3,
                "created": "2026-10-12T00:00:00.000Z", "modified": "2026-10-12T00:00:00.000Z",
            }))
            .unwrap()
        };
        let pipeline = |id: &str, identifier: &str, session: &str| in_project("/repo", id, identifier, session);
        for stored in [pipeline("0199aaaa-1", "#433", "s-one"), pipeline("0199bbbb-2", "ENG-42", "s-two"), pipeline("0199cccc-3", "#433", "s-three")] {
            crate::issue_pipeline::store::insert(&stored).unwrap();
        }
        // The issue names its newest pipeline, with or without the hash a shell would eat.
        assert_eq!(resolve_pipeline("#433", None).unwrap().id, "0199cccc-3");
        assert_eq!(resolve_pipeline("433", None).unwrap().id, "0199cccc-3");
        assert_eq!(resolve_pipeline("eng-42", None).unwrap().id, "0199bbbb-2");
        assert_eq!(resolve_pipeline("0199aaaa-1", None).unwrap().id, "0199aaaa-1");
        assert_eq!(resolve_pipeline("0199bb", None).unwrap().id, "0199bbbb-2");
        assert_eq!(resolve_pipeline("s-one", None).unwrap().id, "0199aaaa-1");
        assert_eq!(resolve_pipeline("0199", None).unwrap_err().code, "ambiguous_selector");
        assert_eq!(resolve_pipeline("#9", None).unwrap_err().code, "not_found");

        // Another project has an issue #433 of its own. The number alone must
        // not pick one: turning on a merge for the wrong repository is not a typo to shrug off.
        crate::issue_pipeline::store::insert(&in_project("/other", "0199dddd-4", "#433", "s-four")).unwrap();
        let ambiguous = resolve_pipeline("433", None).unwrap_err();
        assert_eq!(ambiguous.code, "ambiguous_selector");
        assert!(ambiguous.recovery.unwrap().contains("--project"));
        let project = |path: &str| -> Project { serde_json::from_value(json!({"path": path, "name": "p"})).unwrap() };
        assert_eq!(resolve_pipeline("433", Some(&project("/repo"))).unwrap().id, "0199cccc-3");
        assert_eq!(resolve_pipeline("433", Some(&project("/other"))).unwrap().id, "0199dddd-4");
        // An id is an id wherever it is, unless the project named does not hold it.
        assert_eq!(resolve_pipeline("0199dddd-4", None).unwrap().id, "0199dddd-4");
        assert_eq!(resolve_pipeline("0199dddd-4", Some(&project("/repo"))).unwrap_err().code, "not_found");
        assert_eq!(resolve_pipeline("eng-42", None).unwrap().id, "0199bbbb-2");
    }

    #[test]
    fn wait_says_permission_only_for_a_request_someone_can_answer() {
        let view = |status, asks, recovery, queued, running| WaitView { status, asks, recovery, queued, running };
        let failed = Some(RecoveryKind::Failed);
        for (seen, expected) in [
            // A request held for an answer, whatever else the tab is doing.
            (view(TabStatus::Waiting, true, None, false, true), Some(WaitEnd::Permission)),
            (view(TabStatus::Waiting, true, failed, true, true), Some(WaitEnd::Permission)),
            // An agent that stopped on an error is not a permission (#668).
            (view(TabStatus::Waiting, false, failed, false, false), Some(WaitEnd::Recovery(RecoveryKind::Failed))),
            (view(TabStatus::Waiting, false, Some(RecoveryKind::SignedOut), false, true), Some(WaitEnd::Recovery(RecoveryKind::SignedOut))),
            // A prompt behind the error goes nowhere until it is dealt with.
            (view(TabStatus::Waiting, false, failed, true, true), Some(WaitEnd::Recovery(RecoveryKind::Failed))),
            // Waiting on the agent's own terminal prompt: said, without a request to look for.
            (view(TabStatus::Waiting, false, None, false, true), Some(WaitEnd::Terminal)),
            (view(TabStatus::Waiting, false, None, true, true), Some(WaitEnd::Terminal)),
            (view(TabStatus::InProgress, false, None, false, true), None),
            (view(TabStatus::Completed, false, None, false, true), Some(WaitEnd::Stop)),
            // The prompt sent behind the turn that just ended has not started yet.
            (view(TabStatus::Completed, false, None, true, true), None),
            // With no agent left to take it, it never will.
            (view(TabStatus::Completed, false, None, true, false), Some(WaitEnd::Stop)),
            (view(TabStatus::Idle, false, None, false, false), Some(WaitEnd::Stopped)),
            (view(TabStatus::Idle, false, None, false, true), None),
        ] {
            assert_eq!(wait_end(&seen), expected, "{seen:?}");
        }
        assert_eq!(
            [WaitEnd::Permission, WaitEnd::Recovery(RecoveryKind::Failed), WaitEnd::Terminal, WaitEnd::Stop, WaitEnd::Stopped].map(WaitEnd::reason),
            ["permission", "recovery", "terminal", "stop", "stopped"]
        );
    }

    #[test]
    fn wait_names_the_error_a_tab_whose_agent_failed_to_start_stopped_on() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let session = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        let tab = session.tabs[0].id.clone();
        // The launch's log: its prompt, then the failure the agent stopped on.
        let log = crate::store::log_path(&session.id, &tab).unwrap();
        for (seq, payload) in [(1, json!({"type": "user_message", "text": "fix the login"})), (2, json!({"type": "recovery", "kind": "failed"}))] {
            let event = json!({"id": format!("e{seq}"), "sessionId": session.id, "tabId": tab, "harness": "codex", "seq": seq, "ts": index::now(), "payload": payload});
            crate::store::append_line(&log, &event.to_string()).unwrap();
        }
        let (service, _sink) = headless_service();
        service.manager.load_events(&session.id, &tab).unwrap();
        assert!(service.manager.pending_permissions().is_empty());
        let waited = service.execute("wait", json!({"target": session.id, "timeoutSeconds": 1}), "w1").unwrap();
        assert_eq!(waited, json!({"sessionId": session.id, "tabId": tab, "reason": "recovery", "recovery": "failed", "status": "waiting"}));
    }

    #[test]
    fn recovery_copy_uses_the_terminalx_identity() {
        assert_eq!(
            APP_UNAVAILABLE_RECOVERY,
            "Open TerminalX with the same TERMINALX_HOME, then retry status once."
        );
        assert_eq!(
            LINEAR_INTEGRATION_RECOVERY,
            "Add an API key in TerminalX Settings → Integrations."
        );
    }
}

#[cfg(all(test, unix))]
#[path = "control_issue_tests.rs"]
mod issue_tests;

#[cfg(test)]
#[path = "control_wait_tests.rs"]
mod wait_tests;
