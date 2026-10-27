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
use crate::session::{PendingPermission, SessionManager};
use crate::session_ops::{NewSession, NewTab};
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};
use crate::store::projects::{self, Project};

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
        }
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

    fn internal(error: impl std::fmt::Display) -> Self {
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
    params: Value,
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
    /// Asks the person before an agent's write to an issue. Only the desktop
    /// app has a window to ask in; without one such a write is refused.
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
            "issues.view" | "issues.comment" | "issues.status" | "issues.assign" | "issues.label" | "issues.create" => issue_operation(self.questions.as_ref(), command, params),
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
                if let Some(method) = command.strip_prefix("runtime.mobile.") {
                    return crate::local_runtime::mobile::execute(&self.manager, lifetime, method, params).map_err(ControlError::internal);
                }
                if let Some(method) = command.strip_prefix("runtime.sharing.") {
                    return crate::local_sharing::owner::execute(&self.manager, lifetime, method, params).map_err(ControlError::internal);
                }
                if command.starts_with("runtime.session.") || command.starts_with("runtime.pty.") {
                    return crate::local_runtime::calls::execute(&self.manager, &self.sink, command, params).map_err(ControlError::internal);
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
            "projects.list" => {
                let (projects, last_selected) = projects::list().map_err(ControlError::internal)?;
                Ok(json!({"projects": projects, "lastSelected": last_selected}))
            }
            "sessions.list" => self.sessions_list(params),
            "sessions.show" => {
                let selector = required_string(&params, "session")?;
                Ok(serde_json::to_value(resolve_session(&selector)?)
                    .map_err(ControlError::internal)?)
            }
            "sessions.create" => self.sessions_create(params),
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
            "issues.list" => self.issues_list(params),
            #[cfg(feature = "desktop")]
            "issues.view" | "issues.comment" | "issues.status" | "issues.assign" | "issues.label" | "issues.create" => self.issue_op(command, params),
            #[cfg(not(feature = "desktop"))]
            "issues.view" | "issues.comment" | "issues.status" | "issues.assign" | "issues.label" | "issues.create" => Err(ControlError::new(
                "unsupported",
                format!("{command} needs the TerminalX desktop app; terminalx-serve lists issues only."),
                None::<String>,
            )),
            "pipelines.list" | "pipelines.show" | "pipelines.autoMerge" | "pipelines.act" if cfg!(feature = "desktop") || self.local_lifetime.is_some() => self.pipelines(command, params),
            other => Err(ControlError::invalid(format!(
                "Unknown control command {other}."
            ))),
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
        let quick = params.get("quick").and_then(Value::as_bool).unwrap_or(false);
        if let Some(selector) = optional_string(&params, "project") {
            if quick {
                return Err(ControlError::invalid("--quick and --project are mutually exclusive: a quick chat has no project."));
            }
            let project = resolve_project(&selector)?;
            sessions.retain(|s| s.project() == Some(project.path.as_str()));
        }
        if quick {
            sessions.retain(SessionEntry::is_quick);
        }
        Ok(json!({"sessions": sessions}))
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
        }
        let mut p: Params = serde_json::from_value(params)
            .map_err(|e| ControlError::invalid(format!("Invalid session request: {e}")))?;
        // A blank mode is no mode: the tab takes the default launch mode.
        p.mode = crate::store::index::requested_mode(p.mode.take());
        if p.prompt.trim().is_empty() && p.issue.is_none() {
            return Err(ControlError::invalid("--prompt cannot be empty."));
        }
        if p.issue.is_none() && p.provider.is_some() {
            return Err(ControlError::invalid("--provider applies to a session started with --issue."));
        }
        if p.auto_merge.is_some() && (p.no_pipeline || p.on_main) {
            return Err(ControlError::invalid("--auto-merge needs the pipeline and a worktree: it cannot be combined with --no-pipeline or --on-main."));
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
        let first_tab = NewTab { harness: p.agent, model: p.model, effort: p.effort, permission_mode: p.mode };
        let mut issue = None;
        let entry = match p.project.as_deref() {
            None => {
                // The title a quick chat started from the window gets: the prompt's first line.
                let title = p.title.or_else(|| p.prompt.trim().lines().next().map(|line| line.chars().take(60).collect()));
                let quick = crate::session_ops::NewQuickChat { title, cwd: p.cwd, tab: Some(first_tab) };
                crate::session_ops::create_quick_chat_blocking(&*self.sink, quick).map_err(ControlError::invalid)?
            }
            Some(selector) => {
                let project = resolve_project(selector)?;
                // The tracker is asked before anything is created: an issue
                // that cannot be read must not leave a worktree behind.
                if let Some(reference) = p.issue.as_deref() {
                    issue = Some(issue_for_session(&project.path, reference, p.provider.as_deref())?);
                }
                crate::session_ops::create_named_session_blocking(
                    &*self.sink,
                    NewSession {
                        project_path: project.path,
                        title: p.title,
                        use_worktree: p.use_worktree,
                        on_main: p.on_main,
                        base_ref: None,
                        worktree_name: None,
                        issue: issue.as_ref().map(|issue| issue.reference.clone()),
                        automation: None,
                        cwd: None,
                        tab: Some(first_tab),
                    },
                    p.name.as_deref(),
                )
                .map_err(workspace_error)?
            }
        };
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
        let pipeline_default = crate::store::projects::issue_pipeline_settings(&entry.project_path).is_ok_and(|settings| settings.enabled && (settings.auto_merge || settings.resolve_conflicts));
        if (issue.is_some() || p.auto_merge.is_some() || pipeline_default) && !p.no_pipeline {
            match self.start_pipeline(&entry.id, &tab.id, p.auto_merge) {
                Ok((started, brief)) => {
                    prompt = format!("{prompt}\n\n{brief}");
                    pipeline = started;
                }
                // The session still starts; it just ends at the code, and says why.
                Err(reason) => pipeline_note = json!(reason),
            }
        }
        let outcome = self
            .manager
            .send(&entry.id, &tab.id, prompt, Vec::new())
            .map_err(ControlError::internal)?;
        Ok(json!({"sessionId": entry.id, "tabId": tab.id, "title": entry.title, "kind": entry.kind,
            "worktreeName": entry.worktree_name, "branch": entry.branch, "path": entry.cwd,
            "session": entry, "outcome": outcome, "pipeline": pipeline, "pipelineNote": pipeline_note}))
    }

    fn pipeline_host(&self) -> crate::issue_pipeline::host::LocalHost {
        crate::issue_pipeline::host::LocalHost::new(self.sink.clone(), self.manager.clone())
    }

    /// Start the issue pipeline for a new session: the pipeline and what the
    /// author's first prompt must carry for it, or why there is none.
    fn start_pipeline(&self, session_id: &str, tab_id: &str, auto_merge: Option<bool>) -> Result<(Value, String), String> {
        if !cfg!(feature = "desktop") && self.local_lifetime.is_none() { return Err("Issue pipelines need a local desktop owner.".into()); }
        let pipeline = crate::issue_pipeline::engine::start(&self.pipeline_host(), session_id, tab_id, auto_merge, None).map_err(|error| format!("{error:#}"))?;
        Ok((json!(pipeline), crate::issue_pipeline::prompts::author_brief()))
    }

    fn pipelines(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::issue_pipeline::{engine, store};
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
            "pipelines.autoMerge" => {
                let value = params.get("value").and_then(Value::as_bool).ok_or_else(|| ControlError::invalid("Say on or off."))?;
                engine::set_auto_merge(&host, &pipeline.id, value)
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
        let target = resolve_target(&required_string(&params, "target")?)?;
        let timeout = params
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(600)
            .min(86_400);
        let deadline = Instant::now() + Duration::from_secs(timeout);
        loop {
            if self.local_lifetime.as_ref().is_some_and(|lifetime| lifetime.is_stopping()) {
                return Err(ControlError::new("runtime_stopping", "The local runtime is stopping.", None::<String>));
            }
            let status = self.manager.status_of(&target.session.id, &target.tab.id);
            let running = self.manager.is_running(&target.session.id, &target.tab.id);
            let reason = match status {
                TabStatus::Waiting => Some("permission"),
                TabStatus::Completed => Some("stop"),
                TabStatus::Idle if !running => Some("stopped"),
                _ => None,
            };
            if let Some(reason) = reason {
                return Ok(
                    json!({"sessionId": target.session.id, "tabId": target.tab.id, "reason": reason, "status": status}),
                );
            }
            if Instant::now() >= deadline {
                return Ok(
                    json!({"sessionId": target.session.id, "tabId": target.tab.id, "reason": "timeout", "status": status}),
                );
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

    fn worktrees_list(&self, params: Value) -> Result<Value, ControlError> {
        let projects = selected_projects(optional_string(&params, "project"))?;
        let mut groups = Vec::new();
        for project in projects {
            let worktrees = crate::workspaces::list(Path::new(&project.path))
                .map_err(ControlError::internal)?;
            groups.push(json!({"project": project, "worktrees": worktrees}));
        }
        Ok(json!({"projects": groups}))
    }

    fn worktree_delete(&self, params: Value) -> Result<Value, ControlError> {
        if !params
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(ControlError::new(
                "confirmation_required",
                "Worktree deletion requires --yes.",
                Some("Inspect worktrees list, then repeat with --yes only when deletion is intended.".into()),
            ));
        }
        let (project, worktree) = resolve_worktree(&params)?;
        if worktree.is_main {
            return Err(ControlError::invalid(
                "A project's main checkout cannot be deleted.",
            ));
        }
        // Keep admission through confirmed exit and removal. A failed stop
        // cannot be discarded by a CLI caller either.
        let _admission = crate::issue_pipeline::admission::lock();
        self.manager.accepting_work().map_err(ControlError::internal)?;
        let stop = |session: &crate::store::index::SessionEntry| {
            self.manager.stop_session_confirmed(session).map_err(|error| format!("{error:#}"))
        };
        #[cfg(feature = "desktop")]
        let browser_key = crate::browser::control::canonical(&worktree.path);
        // The same check as every other way of removing a workspace. One
        // that is not clean and merged is removed only with `--force`, which
        // is the CLI's second confirmation. A directory git cannot remove is
        // reported, never deleted directly: the CLI showed nothing of it.
        let force = params.get("force").and_then(Value::as_bool).unwrap_or(false);
        let request = crate::session_ops::WorkspaceRemoval {
            project_path: &project.path,
            path: &worktree.path,
            sessions: crate::session_ops::SessionsFate::Delete,
            delete_branch: false,
            // The CLI shows nothing first, so its `--force` covers whatever
            // is there, and it names no sessions to compare with.
            confirmation: if force { crate::session_ops::Confirmation::Forced } else { crate::session_ops::Confirmation::Single },
            expected_sessions: None,
            direct: crate::git::DirectDelete::Never,
            fetch: crate::landed::Fetch::Fresh,
            guard: None,
        };
        let removed = crate::session_ops::remove_workspace_fallible(&*self.sink, &request, &stop).map_err(|error| {
            if error.starts_with(crate::session_ops::NEEDS_CONFIRMATION) {
                ControlError::new("needs_force", error, Some("Nothing was removed. Repeat with --force only if losing this work is intended.".into()))
            } else {
                ControlError::internal(error)
            }
        })?;
        // Only once the workspace is really gone: a removal that fails keeps it.
        #[cfg(feature = "desktop")]
        if let Some(desktop) = &self.desktop {
            desktop.browser.forget_workspace(&browser_key);
        }
        let (entries, removal) = (removed.sessions, removed.removal);
        let removed: Vec<_> = entries.into_iter().map(|entry| entry.id).collect();
        Ok(json!({"deleted": worktree.path, "project": project.path, "removedSessions": removed, "keptBranch": removal.kept_branch}))
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
    /// `issues.view|comment|status|assign|label|create` (PRO-100): one issue,
    /// through the contract's operations, with every write put to the
    /// person first (see `issue_control`).
    fn issue_op(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        issue_operation(self.questions.as_ref(), command, params)
    }
}

#[cfg(feature = "desktop")]
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

#[cfg(feature = "desktop")]
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

#[cfg(feature = "desktop")]
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

#[cfg(feature = "desktop")]
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
    .map_err(|error| ControlError::not_found(format!("{reference} could not be read: {error:#}")))?;
    Ok(IssueStart {
        prompt: crate::issue_pipeline::prompts::issue_prompt(&issue),
        body: issue.body.clone(),
        reference: crate::store::index::IssueRef { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
    })
}

#[cfg(not(feature = "desktop"))]
fn issue_for_session(_project_path: &str, _reference: &str, _provider: Option<&str>) -> Result<IssueStart, ControlError> {
    Err(ControlError::invalid("Sessions are started from an issue in the desktop app."))
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

    fn headless_service() -> (ControlService, Arc<crate::sink::BroadcastSink>) {
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
            pinned: false,
            tabs: Vec::new(),
            active_tab: None,
            link: None,
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
