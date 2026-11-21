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
    // The tab's own secret, for commands whose answer depends on which agent tab asks: the
    // session and tab a caller names are only claims.
    if matches!(command, "review.comment" | "runs.takeOver") || command.starts_with("bots.") {
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
    #[cfg(unix)]
    guest: Option<Arc<crate::local_vm::guest::Guest>>,
    #[cfg(unix)]
    local_vm_available: bool,
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
    /// Paired machines, for `machine.*` (PRO-356).
    machines: Option<Arc<crate::machines::connect::MachineConnections>>,
}

#[cfg(feature = "desktop")]
impl WindowControl {
    pub(crate) fn new(sink: Arc<dyn EventSink>, computer: Arc<crate::computer::ComputerService>, browser: Arc<crate::browser::BrowserRuntime>) -> Self {
        Self { sink, computer, browser, pairing: None, questions: None, machines: None }
    }

    pub(crate) fn serve(mut self, app: tauri::AppHandle, endpoint: ControlEndpoint, pairing: Arc<crate::pairing::PairingManager>, ask: crate::issue_control::Ask) -> anyhow::Result<()> {
        use tauri::Manager;
        self.pairing = Some(pairing);
        self.questions = Some(ask);
        self.machines = app.try_state::<Arc<crate::machines::connect::MachineConnections>>().map(|state| state.inner().clone());
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

    fn execute(&self, command: &str, params: Value, request_id: &str) -> Result<Value, ControlError> {
        if command == "environment.snapshot" {
            let key = params["key"].as_str().ok_or_else(|| ControlError::invalid("Environment scope required."))?;
            let revision = params["revision"].as_str().ok_or_else(|| ControlError::invalid("Environment revision required."))?;
            return crate::store::environment::desktop_snapshot(key, revision)
                .and_then(|snapshot| Ok(serde_json::to_value(snapshot)?)).map_err(|_| ControlError::internal("Environment overrides are unavailable."));
        }
        // The runtime's relay session needs a current access token (PRO-368).
        // The window rotates the session and keeps the runtime's copy itself.
        if command == "account.refresh" {
            let pairing = self.pairing.as_ref().ok_or_else(|| ControlError::internal("The account is unavailable."))?;
            pairing.refresh_account_for_runtime();
            return Ok(json!({ "refreshed": true }));
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
        // Paired machines (PRO-356): resolved and checked here, run over the
        // machine's connection in the window.
        if let Some(action) = command.strip_prefix("machine.") {
            let machines = self.machines.as_ref().ok_or_else(|| ControlError::new("unsupported", "This TerminalX has no paired machines.", None::<String>))?;
            return crate::machine_control::execute(machines, self.sink.as_ref(), action, params);
        }
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
            #[cfg(unix)]
            guest: None,
            #[cfg(unix)]
            local_vm_available: false,
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

    #[cfg(unix)]
    pub fn with_guest(mut self, guest: Option<Arc<crate::local_vm::guest::Guest>>) -> Self {
        self.guest = guest;
        self
    }

    #[cfg(unix)]
    pub(crate) fn with_vm_controller(mut self) -> Self { self.local_vm_available=true; self }

    /// The Local VM protocols this owner serves, or `None` without a controller.
    fn local_vm_capability(&self) -> Option<Value> {
        #[cfg(unix)]
        if self.local_vm_available {
            return Some(json!({
                "protocol": crate::local_vm::journal::PROTOCOL,
                "reconciliationProtocol": crate::local_vm::provisioning::PROTOCOL,
                "onboardingProtocol": crate::local_vm::setup::PROTOCOL,
            }));
        }
        None
    }

    /// A request as the control socket hands it on, for tests outside this module.
    #[cfg(test)]
    pub(crate) fn execute_for_tests(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        self.execute(command, params, "test")
    }

    pub(crate) fn with_local_lifetime(mut self, lifetime: Arc<crate::local_runtime::Lifetime>) -> Self {
        self.local_lifetime = Some(lifetime);
        self
    }

    fn execute(&self, command: &str, params: Value, request_id: &str) -> Result<Value, ControlError> {
        #[cfg(unix)]
        if let Some(guest) = &self.guest {
            if command != "local_vm.guest" {
                return Err(ControlError::new("unsupported", "This guest serves only bounded local_vm.guest task requests.", None::<String>));
            }
            let request = serde_json::from_value(params).map_err(|error| ControlError::invalid(format!("Invalid guest request: {error}")))?;
            return guest.dispatch(request).map_err(ControlError::internal);
        }
        if command == "local_vm.guest" {
            return Err(ControlError::new("unsupported", "No pinned guest is installed; no operation was routed.", None::<String>));
        }
        #[cfg(unix)]
        if command == "local_vm.request" {
            if !self.local_vm_available { return Err(ControlError::new("unsupported","This owner has no Local VM controller; no operation was sent.",None::<String>)); }
            let lifetime = self.local_lifetime.as_ref().ok_or_else(|| ControlError::new("unsupported", "Local VM requests require the persistent local owner.", None::<String>))?;
            let method = params["method"].as_str().ok_or_else(|| ControlError::invalid("method is required"))?;
            if method.starts_with("computer.") {
                let _admission = crate::local_vm::supervisor::admit(lifetime).map_err(ControlError::internal)?;
                return crate::computer_targets::request(&self.manager, method, params["params"].clone()).map_err(ControlError::internal);
            }
            if matches!(method, "environment.reconcileProvision" | "environment.delete" | "environment.create" | "environment.setup" | "environment.setupAction") {
                let _admission = crate::local_vm::supervisor::admit_exclusive(lifetime).map_err(ControlError::internal)?;
                return crate::local_vm::host::request(method, params["params"].clone()).map_err(ControlError::internal);
            }
            let _admission = crate::local_vm::supervisor::admit(lifetime).map_err(ControlError::internal)?;
            return crate::local_vm::host::request(method, params["params"].clone()).map_err(ControlError::internal);
        }
        // A run's worker stays within its limits on other machines too.
        if let Some(action) = command.strip_prefix("machine.") {
            refuse_limited_machine_caller(action, &params)?;
        }
        // A session working for a bot is held to it, whatever it says it is (PRO-468).
        if matches!(command, "sessions.create" | "runs.create" | "runs.start" | "runs.sendBack" | "runs.widen" | "runs.checkFailed" | "runs.takeOver" | "pipelines.start" | "send" | "permissions.allow" | "cloud.sessions.create" | "cloud.send" | "cloud.resume") || command.starts_with("machine.") {
            Caller::of(&self.manager, &params).gate(command, &params)?;
        }
        if let Some(lifetime) = &self.local_lifetime {
            if command == "runtime.window.register" {
                let registered = lifetime.window.register(lifetime, params)?;
                // The registrant is the window from now on, unless it runs in a pane or under this runtime (PRO-468).
                // Only the Unix bot guard reads it (`refuse_bot_runtime_call`).
                #[cfg(unix)]
                if let Some(pid) = crate::hooks::caller_pid() {
                    match crate::serve_cli::consent::started_at(pid) {
                        Some(started) if self.may_be_the_window(pid) => lifetime.window.recognise((pid, started)),
                        _ => log::warn!("process {pid} registered as the window, but runs in a pane or under this runtime: not taken for the window"),
                    }
                }
                return Ok(registered);
            }
            if crate::local_runtime::window::supported(command) { return lifetime.window.call(command, params); }
        }
        if command.starts_with("runtime.") {
            if let Some(lifetime) = &self.local_lifetime {
                if command == "runtime.dataPrivacy.refresh" {
                    return serde_json::to_value(crate::data_privacy::owner_status(lifetime.epoch())).map_err(ControlError::internal);
                }
                // Operating computers (PRO-341, `machine_wire`).
                if command.starts_with("runtime.machineHost.") {
                    // Only a person makes a pairing code or lets a computer
                    // in: never an agent or terminal this runtime started
                    // (docs/MACHINES.md, "Who may answer"; `consent`).
                    let params = {
                        let mut params = params;
                        if crate::serve_cli::consent::guards(command) {
                            #[cfg(unix)]
                            let run = self.endpoint.socket.parent().ok_or_else(|| ControlError::internal("the control socket has no directory"))?.to_owned();
                            // A pipe has no directory: the witness belongs to this home's `run`.
                            #[cfg(windows)]
                            let run = crate::store::root().map_err(ControlError::internal)?.join("run");
                            crate::serve_cli::consent::verify(&run, &mut params)?;
                        }
                        params
                    };
                    return match crate::machine_host::installed() {
                        Some(host) => host.execute(command, params),
                        None => Err(ControlError::new("unsupported", "This runtime does not host operating computers.", None::<String>)),
                    };
                }
                // The window's report of the app's own updater run, for a
                // computer that asked this machine to update (PRO-354). Only
                // the attached window reports.
                if command == "runtime.machineUpdate.report" {
                    let epoch = params["epoch"].as_str().unwrap_or_default();
                    let lease = params["lease"].as_str().unwrap_or_default();
                    lifetime.attachment(epoch, lease).map_err(|_| ControlError::new("unavailable", "The desktop attachment is no longer current.", None::<String>))?;
                    let data = crate::store::root().map_err(ControlError::internal)?;
                    return crate::remote::machine_update::report(&data, &params).map_err(|error| ControlError::invalid(format!("{error:#}")));
                }
                if let Some(method) = command.strip_prefix("runtime.mobile.") {
                    return crate::local_runtime::mobile::execute(&self.manager, lifetime, method, params).map_err(ControlError::internal);
                }
                if let Some(method) = command.strip_prefix("runtime.sharing.") {
                    return crate::local_sharing::owner::execute(&self.manager, lifetime, method, params).map_err(ControlError::internal);
                }
                if command.starts_with("runtime.session.") || command.starts_with("runtime.pty.") {
                    // A process in a bot's session reads here and changes nothing:
                    // its writes go through the commands that hold it to its bot (PRO-468).
                    #[cfg(unix)]
                    let window = lifetime.window.window_process();
                    #[cfg(not(unix))]
                    let window = None;
                    #[cfg(test)]
                    let window = TEST_WINDOW_PROCESS.with(std::cell::Cell::get).or(window);
                    refuse_bot_runtime_call(&self.manager, command, &params, window)?;
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
                    // Bots (PRO-468): what gives a bot more than it has comes from the window, a person, only.
                    #[cfg(unix)]
                    let params = {
                        let mut params = params;
                        if command == crate::serve_cli::consent::BOTS_COMMAND {
                            let run = self.endpoint.socket.parent().ok_or_else(|| ControlError::internal("the control socket has no directory"))?;
                            bots_from_a_person(run, &mut params, &crate::serve_cli::consent::Window::current())?;
                        }
                        params
                    };
                    #[cfg(not(unix))]
                    let params = {
                        let mut params = params;
                        if command == crate::serve_cli::consent::BOTS_COMMAND {
                            bots_without_a_window(&mut params)?;
                        }
                        params
                    };
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
                    // The desktop pins this owner's Local VM capability from
                    // this answer; it is fixed for the owner's life.
                    if let Some(local_vm) = self.local_vm_capability() { liveness["localVm"] = local_vm; }
                    return Ok(liveness);
                }
                if command == "runtime.stopAll" {
                    return crate::local_runtime::stop_all(&self.manager, lifetime, params);
                }
                return lifetime.command(command, params);
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
        // Paired machines live in the desktop app; the window above serves them.
        if command.starts_with("machine.") {
            return Err(ControlError::new(
                "unsupported",
                format!("{command} needs the TerminalX desktop app: machines are paired with it."),
                Some("Run it on the computer that paired the machine, with TerminalX open.".into()),
            ));
        }
        // The Local VM (`container_vm.rs`): its runtime's CLI does the work, so any TerminalX process can.
        if let Some(action) = command.strip_prefix("vm.") {
            let vm_error = |error: anyhow::Error| ControlError::new("vm_failed", format!("{error:#}"), Some("See `terminalx skills get local-vm`.".to_string()));
            // `--target` names one exact computer from `vm inventory`; without
            // it, the Local VM's own container, as before targets existed.
            let selected: Option<crate::computer_targets::Target> = if matches!(action, "call" | "tools" | "screenshot") {
                Some(match params.get("target").filter(|target| !target.is_null()) {
                    Some(target) => serde_json::from_value(target.clone()).map_err(|_| ControlError::invalid("--target must be an exact computer identity from `terminalx vm inventory`; no container was selected"))?,
                    None => crate::container_vm::default_target().map_err(vm_error)?,
                })
            } else { None };
            let result = match action {
                "inventory" => crate::computer_targets::inventory().map(|inventory| json!(inventory)).map_err(vm_error),
                "status" => Ok(json!(crate::container_vm::status())),
                "start" => crate::container_vm::start().map(|status| json!(status)).map_err(vm_error),
                "stop" => crate::container_vm::stop().map(|status| json!(status)).map_err(vm_error),
                "call" => {
                    let tool = params["tool"].as_str().unwrap_or_default();
                    let arguments = params["arguments"].as_str().unwrap_or("{}");
                    crate::container_vm::call(selected.as_ref().unwrap(), tool, arguments).map(|output| json!({"output": output})).map_err(vm_error)
                }
                "tools" => crate::container_vm::tools(selected.as_ref().unwrap(), params["tool"].as_str()).map(|output| json!({"output": output})).map_err(vm_error),
                "screenshot" => crate::container_vm::screenshot(selected.as_ref().unwrap(), params["out"].as_str().map(std::path::PathBuf::from)).map(|path| json!({"path": path})).map_err(vm_error),
                other => Err(ControlError::new("invalid_arguments", format!("Unknown vm command {other}."), None::<String>)),
            };
            if matches!(action, "start" | "stop") {
                self.sink.emit(crate::container_vm::CHANGED_EVENT, &json!({}));
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
                    if let Some(local_vm) = self.local_vm_capability() { status["localVm"] = local_vm; }
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
            // `terminalx-serve projects add` on a headless server (PRO-353):
            // the runtime writes the store, so no write of its own is lost,
            // and a paired computer's `machine.changed` hears of it.
            //
            // `terminalx projects add` (#1078) passes `refuseExisting`: the
            // same checks, but a folder that is already a project is refused
            // with `already_added`, so a script learns nothing was added.
            "projects.add" => {
                let path = required_string(&params, "path")?;
                let refuse_existing = params.get("refuseExisting").and_then(Value::as_bool).unwrap_or(false);
                let added = if refuse_existing { projects::add_new(&path) } else { projects::ensure(&path) };
                let project = added.map_err(project_refusal)?;
                self.sink.emit("projects_changed", &());
                Ok(json!({ "project": project }))
            }
            // `terminalx projects remove` (#1078), as the sidebar's Remove
            // project does it: the project's open conversations are archived
            // (Show archived brings them back), the project leaves the list,
            // and the folder on disk is not touched.
            "projects.remove" => {
                let selector = required_string(&params, "project")?;
                let project = resolve_project_exactly(&selector)?;
                let open: Vec<String> = index::load().map_err(ControlError::internal)?
                    .into_iter()
                    .filter(|session| !session.archived && session.project() == Some(project.path.as_str()))
                    .map(|session| session.id)
                    .collect();
                if !open.is_empty() {
                    crate::session_archive::set_archived(self.sink.as_ref(), &open, true, crate::session_archive::By::Person)
                        .map_err(ControlError::internal)?;
                }
                projects::remove(&project.path).map_err(ControlError::internal)?;
                self.sink.emit("projects_changed", &());
                Ok(json!({ "project": project, "archivedSessions": open }))
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
            "sessions.pin" | "sessions.unpin" => {
                let session = resolve_session(&required_string(&params, "session")?)?;
                let pinned = command == "sessions.pin";
                if session.pinned != pinned {
                    let patch = crate::session_ops::SessionPatch { pinned: Some(pinned), ..Default::default() };
                    let updated = crate::session_ops::update_session_meta(&session.id, &patch).map_err(ControlError::internal)?;
                    self.sink.emit("session_updated", &updated);
                }
                Ok(json!({"sessionId": session.id, "pinned": pinned}))
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
            // Non-deletion operations use the owner's credentials without a
            // desktop attachment. Cloud workspace capabilities stay unchanged.
            "issues.view" | "issues.comment" | "issues.status" | "issues.assign" | "issues.label" | "issues.create"
                if cfg!(feature = "desktop") || self.local_lifetime.is_some() => issue_operation(None, command, params),
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
            "bots.list" | "bots.show" | "bots.create" | "bots.rename" | "bots.pause" | "bots.resume" | "bots.delete" | "bots.pauseAll" | "bots.resumeAll" => self.bots(command, params),
            "bots.memory.list" | "bots.memory.add" | "bots.memory.forget" => self.bot_memory(command, params),
            "bots.items.list" | "bots.items.show" | "bots.items.add" | "bots.items.set" | "bots.items.ask" | "bots.items.check" | "bots.items.comment" | "bots.items.done" => self.bot_items(command, params),
            other => Err(ControlError::invalid(format!(
                "Unknown control command {other}."
            ))),
        }
    }

    /// Bots (`bots`, PRO-466): hire, list, rename, pause and delete them. With
    /// Settings → Experimental → Bots off every one answers `bots_off`.
    ///
    /// PRO-468: anyone may pause. A resume, or every bot's, is never applied
    /// from here: it is recorded on the bot and the owner answers it in the
    /// app (the window's own Resume needs no confirmation). A session that
    /// works for a bot (`Caller`) is refused hiring, deleting and resuming;
    /// its pause is recorded as the bot's when its launch secret proves it.
    fn bots(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::bots::{self, BotError, Named};
        if !bots::enabled() {
            return Err(ControlError::new("bots_off", bots::OFF_MESSAGE, Some("Ask the person to turn Bots on; do not edit settings.json for them.".into())));
        }
        let sink = self.sink.as_ref();
        // Only the caller's own mistakes are `invalid_arguments`: an unreadable store or a failed write is not.
        let failed = |error: anyhow::Error| match bots::refusal(&error) {
            Some(BotError::Refused(message)) => ControlError::invalid(message.clone()),
            Some(BotError::NotFound(_)) => ControlError::not_found(format!("{error}")),
            Some(BotError::Off) => ControlError::new("bots_off", bots::OFF_MESSAGE, None::<String>),
            None => ControlError::internal(error),
        };
        let named = || -> Result<bots::Bot, ControlError> {
            let selector = required_string(&params, "bot")?;
            match bots::named(&selector).map_err(failed)? {
                Named::One(bot) => Ok(*bot),
                Named::Several => Err(ControlError::new("ambiguous_selector", bots::several_named(&selector), Some("Use the id from `terminalx bots list --json`.".into()))),
                Named::Nobody => Err(ControlError::not_found(bots::nobody_named(&selector))),
            }
        };
        let shown = |bot: &bots::Bot| json!({"bot": bot, "home": bots::home(bot)});
        // The bot the caller's session works for, by its own claim (a session
        // id in its environment), which only ever takes rights away. A pause
        // is recorded as the bot's only when the tab's launch secret proves it.
        let caller = Caller::of(&self.manager, &params);
        let by = caller.verified_bot().unwrap_or_else(|| bots::OWNER.into());
        let waiting = "Waiting for you to confirm in TerminalX: a resume asked for from the command line is applied only when you press Resume in the app.";
        // Where no window can confirm a resume, none is asked for.
        let confirmable = resume_confirmable();
        let unconfirmable = || ControlError::new(
            "person_required",
            "Resuming a bot needs the TerminalX window on a Mac, which confirms that you asked. This TerminalX has none, so nothing can confirm it here.",
            Some("Resume it in TerminalX on a Mac.".into()),
        );
        let answer = match command {
            "bots.list" => json!(bots::listing().map_err(failed)?),
            "bots.show" => shown(&named()?),
            "bots.create" => {
                caller.person_only("hire bots")?;
                shown(&bots::chat::hire(sink, &required_string(&params, "role")?, &required_string(&params, "name")?).map_err(failed)?)
            }
            "bots.rename" => {
                // A new name is the owner's to give (`bots::gives_more`).
                caller.person_only("rename bots")?;
                let patch = bots::BotPatch { name: Some(required_string(&params, "name")?), ..Default::default() };
                json!({"bot": bots::update(sink, &named()?.id, patch).map_err(failed)?})
            }
            "bots.pause" => json!({"bot": bots::pause(sink, &named()?.id, &by).map_err(failed)?}),
            // Never applied from here: the owner answers in the app.
            "bots.resume" => {
                caller.person_only("resume bots")?;
                if !confirmable {
                    return Err(unconfirmable());
                }
                let bot = bots::request_resume(sink, &named()?.id, "cli").map_err(failed)?;
                let asked = bot.paused.is_some();
                json!({"bot": bot, "waiting": asked, "message": if asked { waiting } else { "Not paused: nothing to resume." }})
            }
            "bots.delete" => {
                caller.person_only("delete bots")?;
                let bot = named()?;
                bots::enforce::before_delete(&self.manager, &bot.id);
                bots::delete(sink, &bot.id).map_err(failed)?;
                bots::enforce::after_delete(sink, &bot.id);
                json!({"deleted": bot.id, "name": bot.name})
            }
            "bots.pauseAll" => json!(bots::pause_all(sink, &by).map_err(failed)?),
            _ => {
                caller.person_only("resume bots")?;
                if !confirmable {
                    return Err(unconfirmable());
                }
                let paused: Vec<String> = bots::listing().map_err(failed)?.bots.into_iter().filter(|bot| bot.paused.is_some()).map(|bot| bot.id).collect();
                for id in &paused {
                    bots::request_resume(sink, id, "cli").map_err(failed)?;
                }
                let mut listing = json!(bots::listing().map_err(failed)?);
                listing["waiting"] = json!(!paused.is_empty());
                listing["message"] = json!(if paused.is_empty() { "No bot is paused." } else { waiting });
                listing
            }
        };
        // A pause or a delete reaches that bot's running sessions now.
        match command {
            "bots.pause" | "bots.delete" => bots::enforce::reconcile(&self.manager, answer["bot"]["id"].as_str().or(answer["deleted"].as_str())),
            "bots.pauseAll" => bots::enforce::reconcile(&self.manager, None),
            _ => {}
        }
        Ok(answer)
    }

    /// A bot's memory from the command line (`terminalx bots memory`,
    /// PRO-470). Who asks is the [`Caller`], never what the params say: a
    /// caller placed in a bot's session, or one a bot started, is that bot,
    /// reaches only its own memory and is recorded as it, from the session it
    /// runs in. One that only claims a bot's session is refused unless the
    /// tab's launch secret proves the claim, never taken for the owner. Any
    /// other caller is the owner, and names the bot.
    fn bot_memory(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::bots::{self, memory, BotError, Named};
        if !bots::enabled() {
            return Err(ControlError::new("bots_off", bots::OFF_MESSAGE, Some("Ask the person to turn Bots on; do not edit settings.json for them.".into())));
        }
        let sink = self.sink.as_ref();
        let failed = |error: anyhow::Error| match bots::refusal(&error) {
            Some(BotError::Refused(message)) => ControlError::invalid(message.clone()),
            Some(BotError::NotFound(_)) => ControlError::not_found(format!("{error}")),
            Some(BotError::Off) => ControlError::new("bots_off", bots::OFF_MESSAGE, None::<String>),
            None => ControlError::internal(error),
        };
        let caller = Caller::of(&self.manager, &params);
        caller.refuse_gone()?;
        if caller.bot.is_some() && !caller.verified {
            return Err(ControlError::new(
                "unauthorized",
                "This command says it runs in a bot's session, but its tab could not prove it.",
                Some("Run it from the bot's own chat as the app started it, or from your own terminal.".into()),
            ));
        }
        let named = match optional_string(&params, "bot") {
            Some(selector) => Some(match bots::named(&selector).map_err(failed)? {
                Named::One(bot) => *bot,
                Named::Several => return Err(ControlError::new("ambiguous_selector", bots::several_named(&selector), Some("Use the id from `terminalx bots list --json`.".into()))),
                Named::Nobody => return Err(ControlError::not_found(bots::nobody_named(&selector))),
            }),
            None => None,
        };
        let (bot, by, source) = match (&caller.bot, named) {
            (Some(own), Some(bot)) if bot.id != *own => return Err(ControlError::new("forbidden", "A bot reads and writes only its own memory.", None::<String>)),
            (Some(own), _) => {
                // The session it runs in: where the kernel placed it, else the one its proved claim names.
                let entry = caller.session.as_deref().and_then(|session| index::get(session).ok());
                let duty = entry.as_ref().and_then(|entry| entry.unknown.get("botDuty")).and_then(Value::as_str).map(str::to_owned);
                let source = crate::bots::changes::Source {
                    kind: if duty.is_some() { "duty".into() } else { "chat".into() },
                    session: caller.session.clone(),
                    tab: caller.tab(&params),
                    title: entry.as_ref().map(|entry| entry.title.clone()),
                    duty,
                    unknown: Default::default(),
                };
                (bots::get(own).map_err(failed)?, own.clone(), source)
            }
            (None, Some(bot)) => {
                // The owner's writes come from a person: not from a process outside every pane with no terminal of its own.
                if command != "bots.memory.list" {
                    caller.person_only("change a bot's memory")?;
                }
                (bot, bots::OWNER.to_string(), crate::bots::changes::Source::of("cli"))
            }
            (None, None) => return Err(ControlError::invalid("Name the bot with --bot BOT.")),
        };
        let place = memory::Place::parse(&bot, optional_string(&params, "place").as_deref().unwrap_or(memory::BOT_PLACE)).map_err(failed)?;
        if by != bots::OWNER {
            // Off means off: a bot neither reads, writes nor forgets its notes.
            if bot.memory_off {
                return Err(ControlError::new("forbidden", "Your owner turned your memory off: nothing is kept, and there is nothing to read or forget.", None::<String>));
            }
            // A conversation reaches its own notes and those of the place it works in; the others are the owner's to manage.
            let working = memory::working_place(&bot);
            if place != memory::Place::Bot && place != working {
                return Err(ControlError::new(
                    "forbidden",
                    format!("This conversation works in {}; the notes of other places are not yours to read or change from here.", working.key()),
                    Some(format!("Use --place bot or --place {}, or leave --place out.", working.key())),
                ));
            }
        }
        match command {
            "bots.memory.add" => {
                let recorded = memory::add(sink, &bot, &place, &required_string(&params, "text")?, &by, source).map_err(failed)?;
                Ok(json!({"bot": bot.id, "place": place.key(), "changes": memory::shown(&recorded)}))
            }
            "bots.memory.forget" => {
                // `--line N` counts from 1, as the list shows the lines.
                let index = match params["number"].as_u64() {
                    Some(0) => return Err(ControlError::invalid("Lines are counted from 1.")),
                    Some(number) => Some(number as usize - 1),
                    None => None,
                };
                let recorded = memory::forget(sink, &bot, &place, &required_string(&params, "line")?, index, &by, source).map_err(failed)?;
                Ok(json!({"bot": bot.id, "place": place.key(), "changes": memory::shown(&recorded)}))
            }
            _ => {
                let view = memory::view(sink, &bot).map_err(failed)?;
                let shown = view.memory.places.iter().find(|shown| shown.key == place.key());
                Ok(json!({
                    "bot": bot.id,
                    "name": bot.name,
                    "off": bot.memory_off,
                    "place": place.key(),
                    "file": shown.map(|shown| shown.path.clone()),
                    "lines": shown.map(|shown| shown.lines.clone()).unwrap_or_default(),
                    "budget": memory::BUDGET,
                    "places": view.memory.places.iter().map(|shown| json!({"place": shown.key, "lines": shown.lines.len(), "read": shown.read})).collect::<Vec<_>>(),
                }))
            }
        }
    }

    /// A bot's work items (`terminalx bots items`, PRO-469). Only a bot edits
    /// its list, and only its own: the bot is the one `Caller` places the
    /// command in (its session, or a claim its tab's launch secret proves),
    /// never one the command names. A paused bot changes nothing. Anyone else
    /// (the owner's terminal) reads a list by naming the bot with `--bot`;
    /// the owner answers and gives work in the app.
    fn bot_items(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::bots::{self, BotError, Named};
        if !bots::enabled() {
            return Err(ControlError::new("bots_off", bots::OFF_MESSAGE, Some("Ask the person to turn Bots on; do not edit settings.json for them.".into())));
        }
        let failed = |error: anyhow::Error| match bots::refusal(&error) {
            Some(BotError::Refused(message)) => ControlError::invalid(message.clone()),
            Some(BotError::NotFound(_)) => ControlError::not_found(format!("{error}")),
            Some(BotError::Off) => ControlError::new("bots_off", bots::OFF_MESSAGE, None::<String>),
            None => ControlError::internal(error),
        };
        let action = command.trim_start_matches("bots.items.");
        let reads = matches!(action, "list" | "show");
        let caller = Caller::of(&self.manager, &params);
        caller.refuse_gone()?;
        let named = match optional_string(&params, "bot") {
            Some(selector) => Some(match bots::named(&selector).map_err(failed)? {
                Named::One(bot) => *bot,
                Named::Several => return Err(ControlError::new("ambiguous_selector", bots::several_named(&selector), Some("Use the id from `terminalx bots list --json`.".into()))),
                Named::Nobody => return Err(ControlError::not_found(bots::nobody_named(&selector))),
            }),
            None => None,
        };
        let bot = match (caller.verified_bot(), caller.bot.as_deref(), named) {
            // Held to its own bot, whatever it names.
            (Some(own), _, Some(bot)) if bot.id != own => return Err(caller.forbidden("read or change another bot's work items")),
            (Some(own), _, _) => bots::get(&own).map_err(failed)?,
            // It says it works for a bot, and cannot prove it: neither that bot nor the owner.
            (None, Some(_), _) => {
                return Err(ControlError::new(
                    "unauthorized",
                    "This command says it runs in a bot's session, but its tab could not prove it.",
                    Some("Run it from the bot's own session as TerminalX started it.".into()),
                ))
            }
            (None, None, Some(bot)) if reads => bot,
            (None, None, Some(_)) => {
                return Err(ControlError::new(
                    "forbidden",
                    "Only a bot changes its own work list, from its own sessions. Answer, comment, give work or stop an item in TerminalX.",
                    Some("Open the bot in TerminalX.".into()),
                ))
            }
            (None, None, None) => return Err(ControlError::invalid("Name the bot with --bot BOT, or run this from one of the bot's sessions.")),
        };
        if !reads {
            caller.refuse_while_paused("change its work items")?;
        }
        crate::bots::items::cli(self.sink.as_ref(), &bot, caller.session.clone(), action, &params).map_err(failed)
    }

    /// Orchestration runs (`orchestration`): a lead's plan of pieces, and the
    /// workers started for them. There is no command to approve a run: the
    /// lead runs this CLI, and a person approves its plan in the app.
    fn runs(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::orchestration::{engine, host::ManagerHost, plan::Plan, store};
        let host = ManagerHost::new(self.sink.clone(), self.manager.clone());
        // The session the command runs in, when it runs in one the app knows:
        // where the kernel places the caller, else the one it names (PRO-468).
        let placement = Caller::of(&self.manager, &params);
        let caller = placement.session(&params);
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
            let tab = caller.filter(|caller| caller.id == lead.id).and_then(|_| placement.tab(&params)).filter(|tab| lead.tab(tab).is_some());
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
        // A bot's session steers only the runs led for the same bot.
        if matches!(command, "runs.start" | "runs.note" | "runs.sendBack" | "runs.widen" | "runs.takeOver" | "runs.merge" | "runs.checkFailed" | "runs.stop" | "runs.finish" | "runs.skip" | "runs.cleanup") {
            placement.may_steer(&run)?;
        }
        match command {
            "runs.show" => Ok(engine::shown(&engine::refreshed(&host, &run.id).map_err(ControlError::of_run)?)),
            "runs.start" => {
                self.manager.accepting_work().map_err(ControlError::internal)?;
                let start = engine::start(&host, &run.id).map_err(ControlError::of_run)?;
                let mut started = json!({"run": engine::shown(&start.run), "started": start.started, "waiting": start.waiting, "failed": start.failed});
                // A `planned` run the person changed before the lead started it (PRO-365).
                if let Some(edited) = start.edited {
                    started["edited"] = json!(edited);
                }
                Ok(started)
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
                        // Only the run's own lead, from its own conversation, takes a piece of an approved
                        // plan over itself. The session and tab the caller names are claims any process
                        // can make: the lead's tab is proved by its own secret, else it is not the lead.
                        let from_lead = match (params["caller"]["session"].as_str(), params["caller"]["tab"].as_str()) {
                            (Some(session), Some(tab)) => session == run.lead.session_id
                                && run.lead.tab_id.as_deref().is_none_or(|lead_tab| lead_tab == tab)
                                && self.manager.authenticates_cli(session, tab, params["hookToken"].as_str().unwrap_or_default()),
                            _ => false,
                        };
                        let run = engine::take_over(&host, &run.id, &piece, engine::By::Cli, from_lead).map_err(ControlError::of_run)?;
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
            let mut held = crate::worktree_control::sessions_in(&sessions, &worktree.path).map_err(ControlError::internal)?;
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
        if params.get("allMachines").and_then(Value::as_bool) == Some(true) {
            return Ok(self.with_machine_sessions(sessions, archived));
        }
        Ok(json!({"sessions": sessions}))
    }

    /// `sessions list --all-machines` (PRO-356): this computer's sessions,
    /// each with `machine: null`, then every paired machine's, each naming
    /// its machine; `machines` says how each machine stands. Machines that
    /// cannot be read leave this computer's list whole, with the reason.
    fn with_machine_sessions(&self, local: Vec<Value>, archived: bool) -> Value {
        let mut sessions: Vec<Value> = local
            .into_iter()
            .map(|mut session| {
                session["machine"] = Value::Null;
                session
            })
            .collect();
        match self.window_call("machine.sessions.listAll", json!({"archived": archived})) {
            Ok(mut answer) => {
                if let Some(Value::Array(rows)) = answer.get_mut("sessions").map(Value::take) {
                    sessions.extend(rows);
                }
                json!({"sessions": sessions, "machines": answer.get("machines").cloned().unwrap_or_else(|| json!([]))})
            }
            Err(error) => json!({"sessions": sessions, "machines": [], "machinesError": error}),
        }
    }

    /// A window service from the control socket: the attached desktop's.
    fn window_call(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        if let Some(lifetime) = &self.local_lifetime {
            return lifetime.window.call(command, params);
        }
        #[cfg(feature = "desktop")]
        if let Some(desktop) = &self.desktop {
            return desktop.execute(command, params, "");
        }
        let _ = params;
        Err(ControlError::new("unsupported", format!("{command} needs the TerminalX desktop app."), None::<String>))
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
            /// `--account`: the agent account the first tab starts on, by id
            /// or label (#980). Absent: the project's default, then the agent's.
            #[serde(default)]
            account: Option<String>,
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
        // A session that works for a bot starts sessions that work for it too
        // (PRO-468): recorded as its own, under its access, and none while paused.
        let bot_caller = Caller::of(&self.manager, &json!({"caller": p.caller.clone()}));
        if bot_caller.bot.is_some() {
            bot_caller.refuse_while_paused("start sessions")?;
            let own = p.parent.as_deref().map(str::trim).is_none_or(|parent| resolve_session(parent).ok().map(|parent| parent.id) == bot_caller.session);
            if p.no_parent || !own {
                return Err(ControlError::new("forbidden", "A session that works for a bot records itself as the one that started a new session: drop --parent and --no-parent.", None::<String>));
            }
        }
        // Settled before anything is created: a parent nobody knows must not
        // leave a session or a worktree behind. A bot's session is the parent
        // the kernel names, whatever the caller said.
        let parent = match bot_caller.session.as_deref() {
            Some(session) => Some(index::ParentRef {
                session_id: session.to_owned(),
                tab_id: match &bot_caller.placed {
                    Some(placed) => placed.tab.clone().filter(|_| placed.session.as_deref() == Some(session)),
                    None => p.caller["tab"].as_str().filter(|_| p.caller["session"].as_str() == Some(session)).map(str::to_owned),
                },
            }),
            None => parent_of_new_session(p.parent.as_deref(), p.no_parent, &p.caller)?,
        };
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
        // Settled before anything is created, like the parent.
        let account = p.account.as_deref().map(|selector| resolve_account(&p.agent, selector)).transpose()?;
        let mut first_tab = NewTab { transport: if p.experimental_codex_stdio { index::AgentTransport::ExperimentalCodexStdio } else { index::AgentTransport::Pty }, harness: p.agent, model: p.model, effort: p.effort, permission_mode: p.mode };
        // Without the flag, Settings → Experimental → Native Codex decides.
        if !p.experimental_codex_stdio { crate::session_ops::prefer_native_codex(&mut first_tab, p.issue.is_some() || p.report); }
        let mut issue = None;
        let entry = match p.project.as_deref() {
            None => {
                // The title a quick chat started from the window gets: the prompt's first line.
                let title = p.title.or_else(|| p.prompt.trim().lines().next().map(|line| line.chars().take(60).collect()));
                let quick = crate::session_ops::NewQuickChat { section_id: None, title, cwd: p.cwd, tab: Some(first_tab), parent };
                crate::session_ops::create_quick_chat_blocking_on(&*self.sink, quick, account.as_deref()).map_err(ControlError::invalid)?
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
                crate::session_ops::create_named_session_blocking_on(
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
                    account.as_deref(),
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
                let mut value = serde_json::to_value(&worktree).map_err(ControlError::internal)?;
                match crate::worktree_control::sessions_in(&sessions, &worktree.path) {
                    Ok(held) => {
                        value["sessionCount"] = json!(held.len());
                        if !worktree.is_main {
                            value["sessions"] = json!(crate::worktree_control::summaries(&held, &project.path));
                        }
                    }
                    Err(error) => {
                        value["sessionCount"] = Value::Null;
                        if !worktree.is_main { value["sessions"] = Value::Null; }
                        value["sessionError"] = json!(error);
                    }
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
            match merge::cleanup_before_lead_removal(&host, &run.id, false) {
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
                        // No worktree of its own (removed already, sessions kept on purpose, or never one):
                        // the run's cleanup has nothing to remove and does not block the delete, which
                        // leaves the session as it is. Only a cleanup that cannot run blocks.
                        None => (failed.clone(), None),
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
            let canonical = |path: &str| crate::paths::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
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
            crate::orchestration::merge::cleanup_before_lead_removal(&host, &run, true).map_err(ControlError::of_run)?;
            cleaned.push(run);
        }
        // What the cleanup could not remove after all (a worker that wrote
        // something in its last moment) still blocks the delete.
        let left: Vec<_> = self.worktree_delete_orphans(project, held)?.into_iter().filter(|orphan| !orphan.keeps_session()).collect();
        if !left.is_empty() {
            return Err(refuse(&left, &cleaned));
        }
        Ok(())
    }

    /// What deleting `worktree` would do: the sessions it holds, with what
    /// each still runs, and its git state checked as the delete checks it.
    fn worktree_delete_preview(&self, project: &Project, worktree: crate::workspaces::Workspace, held: &[SessionEntry]) -> crate::worktree_control::DeletePreview {
        let canonical = |path: &str| crate::paths::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
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

}

/// `machine.*` a run's worker may not ask for (`orchestration::guard`): it
/// pairs or forgets no machine, and starts no session on one. A session it
/// starts here is marked a worker as it is made; one on a machine cannot be.
const LIMITED_MACHINE_ACTIONS: [&str; 3] = ["add", "remove", "sessions.create"];

fn refuse_limited_machine_caller(action: &str, params: &Value) -> Result<(), ControlError> {
    if !LIMITED_MACHINE_ACTIONS.contains(&action) {
        return Ok(());
    }
    let limited = params["caller"]["session"].as_str().and_then(|id| index::get(id).ok()).is_some_and(|caller| crate::orchestration::guard::limited(&caller));
    if limited {
        return Err(ControlError::new(
            "forbidden",
            "A worker of an orchestration run does not pair machines or start sessions on them. Report what the piece needs; the lead decides.",
            None::<String>,
        ));
    }
    Ok(())
}

fn issue_operation(questions: Option<&crate::issue_control::Ask>, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::issue_control::{authorize, run, Caller, Live, Subject, Write};
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
        // Shown in the question as the caller's claim, never trusted.
        let session = caller.session.as_deref().and_then(|session| resolve_session(session).ok());
        let gate = |write: &Write, subject: &str, _issue_repo: Option<&str>| {
            let subject = Subject {
                issue: subject,
                provider,
                project_name: &project.name,
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

/// [`resolve_project`] for a command that changes what it names: a project
/// matched only by part of its name is refused, so `remove api` cannot take
/// out `api-gateway`.
fn resolve_project_exactly(selector: &str) -> Result<Project, ControlError> {
    let project = resolve_project(selector)?;
    let canonical = Path::new(selector).exists().then(|| canonical_or_original(selector));
    if project.path == selector || project.name == selector || canonical.as_deref() == Some(project.path.as_str()) {
        return Ok(project);
    }
    Err(ControlError::new(
        "ambiguous_selector",
        format!("{selector} only matches part of the name of project {}.", project.name),
        Some(format!("Name the project by its full name ({}) or its path.", project.name)),
    ))
}

/// A folder `projects.add` would not take, with the code the CLI reports.
fn project_refusal(error: anyhow::Error) -> ControlError {
    use projects::Refusal;
    let message = format!("{error:#}");
    match error.downcast_ref::<Refusal>() {
        Some(Refusal::Missing(_)) => ControlError::new("not_found", message, Some("Check the path; create the folder or clone the repository first.".into())),
        Some(Refusal::NotADirectory(_)) => ControlError::new("not_a_directory", message, Some("Name the folder the project lives in, not a file inside it.".into())),
        Some(Refusal::AlreadyAdded(path)) => ControlError::new("already_added", message, Some(format!("Nothing was changed. Use it as it is: terminalx sessions create --project {path} ..."))),
        Some(Refusal::Mirror) => ControlError::new("invalid_project", message, None),
        None => ControlError::new("invalid_project", message, None),
    }
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

/// The agent account `selector` names for `agent` (#980): its id, or its
/// label, ignoring case. A label two accounts share names neither; an agent
/// without accounts has none to choose. Only ids and labels are answered,
/// never a token.
pub(crate) fn resolve_account(agent: &str, selector: &str) -> Result<String, ControlError> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(ControlError::invalid("--account cannot be empty."));
    }
    let Some(_) = crate::agent_keys::Agent::of(agent) else {
        return Err(ControlError::invalid(format!("{agent} has no accounts to choose from; leave out --account.")));
    };
    let view = crate::agent_accounts::list(agent).map_err(ControlError::internal)?;
    if let Some(account) = view.accounts.iter().find(|account| account.id == selector) {
        return Ok(account.id.clone());
    }
    let named: Vec<_> = view.accounts.iter().filter(|account| account.label.to_lowercase() == selector.to_lowercase()).collect();
    let listed = || view.accounts.iter().map(|account| format!("{} ({})", account.id, account.label)).collect::<Vec<_>>().join(", ");
    match named.as_slice() {
        [account] => Ok(account.id.clone()),
        [] => Err(ControlError::invalid(format!("No {agent} account is called {selector}. Its accounts: {}.", listed()))),
        _ => Err(ControlError::invalid(format!("More than one {agent} account is called {selector}; name it by id: {}.", listed()))),
    }
}

/// Who a new session is recorded as started by (PRO-270). `--no-parent`
/// records nobody and `--parent` the session it names, which must exist.
/// Otherwise it is the session the command ran in, when the app knows it:
/// that is only what the command's environment says, which is enough for a
/// record that grants nothing, and a session the app does not know (the
/// environment of one since deleted) is simply not recorded.
impl ControlService {
    /// Whether process `pid`, registering as the window, may be taken for it:
    /// not in any of this runtime's panes, nor under this runtime's process.
    #[cfg(unix)]
    fn may_be_the_window(&self, pid: i32) -> bool {
        // SAFETY: getpid has no preconditions.
        let runtime = unsafe { libc::getpid() };
        pid != runtime && !crate::serve_cli::consent::descends_from(pid, runtime) && matches!(self.manager.session_of_process(pid), Ok(None))
    }
}

/// While Bots is on, a `runtime.session.*` or `runtime.pty.*` call that is
/// not a read ([`runtime_read`]) is the window's: its process, by pid and
/// start time (`window`), passes at once, every keystroke included. Any
/// other caller is placed, every time: it passes only from a session no bot
/// works for, or with no session but a terminal of the person's own. Refused
/// from a bot's session or one a bot started, when the caller is gone, and
/// when it could not be placed. With Bots off nothing is looked at.
fn refuse_bot_runtime_call(manager: &SessionManager, command: &str, params: &Value, window: Option<(i32, u64)>) -> Result<(), ControlError> {
    if !crate::bots::enabled_cached() {
        return Ok(());
    }
    // A caller in a bot's session reads its own bot's work list here and no other, as `terminalx bots items` does;
    // `needsYou` holds every bot's questions, so it is the window's.
    if command == "runtime.session.bots" && matches!(params["operation"].as_str(), Some("items" | "item" | "needsYou")) {
        refuse_other_bots_items(manager, params, window)?;
    }
    if runtime_read(command, params) {
        return Ok(());
    }
    let pid = match crate::hooks::caller() {
        // In-process: no peer to place.
        crate::hooks::Peer::InProcess => return Ok(()),
        crate::hooks::Peer::Unreadable => return Err(gone()),
        crate::hooks::Peer::Pid(pid) => pid,
    };
    #[cfg(unix)]
    {
        if window.is_some_and(|(window, started)| window == pid && crate::serve_cli::consent::started_at(pid) == Some(started)) {
            return Ok(());
        }
        let caller = Caller::of_process(manager, &json!({}), Some(pid));
        caller.refuse_gone()?;
        // A bot reads its own duties, and no other bot's (PRO-471).
        if caller.bot.is_some() && own_duties_read(command, params, caller.bot.as_deref()) {
            return Ok(());
        }
        if caller.bot.is_some() {
            return Err(caller.forbidden("change sessions or terminals through the runtime directly"));
        }
        if caller.placed.is_none() && !person_terminal(pid) {
            return Err(ControlError::new(
                "person_required",
                "This call changes sessions or terminals, and came from a process that is not the TerminalX window, runs in no TerminalX pane and has no terminal of its own: while Bots is on, it may be a bot's.",
                Some("Use the `terminalx` commands, or run it in a terminal of your own.".into()),
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = (manager, window, pid);
    Ok(())
}

/// A process placed in a bot's session asks for a work list through the runtime: only its own bot's.
/// The window's own reads are not placed; a caller that cannot be placed is refused, never let through.
fn refuse_other_bots_items(manager: &SessionManager, params: &Value, window: Option<(i32, u64)>) -> Result<(), ControlError> {
    let pid = match crate::hooks::caller() {
        crate::hooks::Peer::InProcess => return Ok(()),
        crate::hooks::Peer::Unreadable => return Err(gone()),
        crate::hooks::Peer::Pid(pid) => pid,
    };
    #[cfg(unix)]
    if window.is_some_and(|(window, started)| window == pid && crate::serve_cli::consent::started_at(pid) == Some(started)) {
        return Ok(());
    }
    #[cfg(not(unix))]
    let _ = window;
    let caller = Caller::of_process(manager, &json!({}), Some(pid));
    caller.refuse_gone()?;
    let Some(bot) = caller.bot.as_deref() else { return Ok(()) };
    let own = params["operation"].as_str() != Some("needsYou") && params["params"]["id"].as_str() == Some(bot);
    if own {
        return Ok(());
    }
    Err(caller.forbidden("read another bot's work list, or every bot's questions: `terminalx bots items list` shows its own"))
}

/// Whether a call reads bot `bot`'s own duties. The window and a person's
/// terminal read any bot's; a process in a bot's session reads only its own.
fn own_duties_read(command: &str, params: &Value, bot: Option<&str>) -> bool {
    command == "runtime.session.bots" && params["operation"] == "duties" && bot.is_some_and(|bot| params["params"]["id"].as_str() == Some(bot))
}

/// The `runtime.session.*` and `runtime.pty.*` calls that only read, which
/// a process in a bot's session may make (PRO-468).
fn runtime_read(command: &str, params: &Value) -> bool {
    if let Some(method) = command.strip_prefix("runtime.session.") {
        return match method {
            // `memoryView` and `memoryLook` record edits found outside the app: not reads.
            "bots" => matches!(params["operation"].as_str(), Some("list" | "get" | "templates" | "roleRead" | "spentToday" | "memoryText" | "roleDiff" | "items" | "item" | "needsYou")),
            "list" | "log" | "automations" | "automationRuns" | "automationIssues" | "paneAgents" | "resourceOverview" | "resourceSample" | "usage"
            | "activity" | "events" | "eventsOpen" | "eventsChunk" | "eventsClose" | "status" | "pane" | "queued" | "rowStatuses" | "accountSupport" => true,
            // `questions` answers pending requests and `heldQueue` sends to an idle tab: neither is a read.
            _ => false,
        };
    }
    matches!(
        command.strip_prefix("runtime.pty."),
        Some("environmentReady" | "mobileDrivers" | "shells" | "stats" | "visibleShells" | "agentSetupRunning" | "agentLoginTabs")
    )
}

/// A bots operation of the runtime that gives a bot more than it has
/// (`bots::enforce::needs_person`) is applied only with the window's proof
/// that a person sent it, as pairing is (`serve_cli::consent`): the control
/// token alone is in every agent tab's environment. Without a window, only a
/// person's own terminal may. An `update` is judged under the store's lock
/// (`bots::update_as`): here it is only told whether a person was shown to
/// have asked, and a proof that fails is said at once when the update looks
/// like it gives more, so the window can repair what it can.
#[cfg(unix)]
fn bots_from_a_person(run: &Path, params: &mut Value, window: &crate::serve_cli::consent::Window) -> Result<(), ControlError> {
    use crate::serve_cli::consent;
    let operation = params["operation"].as_str().unwrap_or_default().to_owned();
    let witnessed = params.get(consent::PARAM).is_some();
    if operation == "update" {
        let proof = witnessed.then(|| consent::verify_for(run, params, window));
        let proved = matches!(proof, Some(Ok(())));
        if let Some(Err(error)) = proof {
            if crate::bots::enforce::needs_person(&operation, &params["params"]) {
                return Err(bots_refusal(&operation, error, window));
            }
        }
        if let Some(inner) = params["params"].as_object_mut() {
            inner.insert(crate::bots::BY_PERSON.into(), json!(proved));
        }
        return Ok(());
    }
    if !crate::bots::enforce::needs_person(&operation, &params["params"]) {
        if let Some(object) = params.as_object_mut() {
            object.remove(consent::PARAM);
        }
        return Ok(());
    }
    consent::verify_for(run, params, window).map_err(|error| bots_refusal(&operation, error, window))
}

#[cfg(test)]
thread_local! {
    /// Tests run with no window; they say whether one could confirm.
    static TEST_WINDOW_CONFIRMS: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

#[cfg(test)]
thread_local! {
    /// The window's process as a test registers it (pid, start time).
    static TEST_WINDOW_PROCESS: std::cell::Cell<Option<(i32, u64)>> = const { std::cell::Cell::new(None) };
}

/// Whether a window here can confirm a resume asked for from the command line.
fn resume_confirmable() -> bool {
    #[cfg(test)]
    return TEST_WINDOW_CONFIRMS.with(|confirms| confirms.get());
    #[cfg(all(not(test), unix))]
    return window_can_confirm(&crate::serve_cli::consent::Window::current());
    #[cfg(all(not(test), not(unix)))]
    false
}

/// What a Bots action is called where it is refused.
fn bots_action(operation: &str) -> &'static str {
    match operation {
        "resume" => "resume a bot",
        "resumeAll" => "resume every bot",
        "dismissResume" => "keep a bot paused",
        "create" => "hire a bot",
        "delete" => "delete a bot",
        "roleWrite" | "roleRestore" => "change a bot's role",
        "memoryAdd" | "memoryForget" | "memoryUndo" => "change a bot's memory",
        "dutySave" => "add or change a bot's duty",
        "dutySwitch" => "switch a bot's duty on",
        "dutyDelete" => "remove a bot's duty",
        "dutyDuplicate" => "copy a bot's duty",
        "dutyRun" => "run a bot's duty",
        "dutyTryCheck" => "try a duty's first check",
        "quietHours" => "change a bot's quiet hours",
        _ => "give a bot more access, change who it reports to or turn its memory back on",
    }
}

/// [`bots_from_a_person`] where no window can sign, as on Linux
/// (`window_can_confirm`): what needs a person is refused, and an `update`
/// is never a person's, so `bots::update_as` gives the bot nothing more.
#[cfg(not(unix))]
fn bots_without_a_window(params: &mut Value) -> Result<(), ControlError> {
    let operation = params["operation"].as_str().unwrap_or_default().to_owned();
    if let Some(object) = params.as_object_mut() {
        object.remove(crate::serve_cli::consent::PARAM);
    }
    if operation == "update" {
        if let Some(inner) = params["params"].as_object_mut() {
            inner.insert(crate::bots::BY_PERSON.into(), json!(false));
        }
        return Ok(());
    }
    if crate::bots::enforce::needs_person(&operation, &params["params"]) {
        let action = bots_action(&operation);
        return Err(ControlError::new(
            "pairing_unavailable",
            format!("To {action} needs the TerminalX window on a Mac, which confirms that you asked. This TerminalX has none that can."),
            Some("Use TerminalX on a Mac for this.".into()),
        ));
    }
    Ok(())
}

/// Whether a person can confirm a Bots action here at all: only the TerminalX
/// window on a Mac signs for one (`serve_cli::consent`).
#[cfg(unix)]
fn window_can_confirm(window: &crate::serve_cli::consent::Window) -> bool {
    cfg!(target_os = "macos") && !matches!(window, crate::serve_cli::consent::Window::Headless)
}

/// A refusal of a Bots action, said as one: the code a window repairs by
/// (`window_consent::unverifiable`) is kept, the words are of the action.
#[cfg(unix)]
fn bots_refusal(operation: &str, mut error: ControlError, window: &crate::serve_cli::consent::Window) -> ControlError {
    let action = bots_action(operation);
    if !window_can_confirm(window) {
        error.message = format!("To {action} needs the TerminalX window on a Mac, which confirms that you asked. This TerminalX has none that can.");
        error.recovery = Some("Use TerminalX on a Mac for this.".into());
    } else if error.code == "pairing_unavailable" {
        error.message = format!("TerminalX could not confirm that you asked to {action}: the runtime running now was not started by this window.");
        error.recovery = Some("Restart the runtime (Settings → Machines → Restart runtime), then try again.".into());
    } else {
        // `window_consent::unverifiable` reads the refusal's own words: they stay, after ours.
        error.message = format!("Only you may {action}, in the TerminalX window: {}", error.message);
        error.recovery = Some("An agent cannot do this; tell the person what you need.".into());
    }
    error
}

/// Who a `terminalx` command runs for (PRO-468), worked out on this side:
/// first from the process that sent it (the kernel says which, and
/// `SessionManager::session_of_process` places it in the tab whose agent or
/// terminal it runs under), then from the session it names, proved by the
/// tab's launch secret or not. Naming a session can only take rights away: a
/// caller placed in a bot's session is that bot's whatever it says. A caller
/// that cannot be placed is the owner only from a terminal of its own; with
/// none (a process that left its tab behind), it does nothing only a person
/// does, and starts nothing while any bot is paused.
struct Caller {
    /// The bot's id, its name when it can be read, and whether it is paused
    /// (a bot that cannot be read now counts as paused).
    bot: Option<String>,
    name: String,
    paused: bool,
    verified: bool,
    /// The session that works for the bot the caller runs in.
    session: Option<String>,
    /// Where the kernel places the caller among the runtime's panes, whatever it works for.
    placed: Option<crate::session::Placed>,
    /// The process the kernel says sent the command; `None` in-process or off unix.
    peer: Option<i32>,
    /// That process had exited, or was a zombie, when it was looked at: it
    /// cannot be placed, so nothing it asks for that matters is done.
    gone: bool,
    /// Where it runs could not be worked out (the sessions could not be read).
    incomplete: bool,
}

impl Caller {
    fn of(manager: &SessionManager, params: &Value) -> Self {
        match crate::hooks::caller() {
            crate::hooks::Peer::Pid(pid) => Self::of_process(manager, params, Some(pid)),
            crate::hooks::Peer::InProcess => Self::of_process(manager, params, None),
            // A sender that cannot be read is one that is gone.
            crate::hooks::Peer::Unreadable => {
                let mut caller = Self::of_process(manager, params, None);
                caller.gone = crate::bots::enabled();
                caller
            }
        }
    }

    fn of_process(manager: &SessionManager, params: &Value, peer: Option<i32>) -> Self {
        // With Bots off nothing is looked up: the command is what it says, as before.
        if !crate::bots::enabled() {
            return Self { bot: None, name: String::new(), paused: false, verified: false, session: None, placed: None, peer: None, gone: false, incomplete: false };
        }
        #[cfg(unix)]
        let (placing, gone) = (peer.map(|pid| manager.session_of_process(pid)).transpose(), peer.is_some_and(|pid| !crate::serve_cli::consent::alive(pid)));
        #[cfg(not(unix))]
        let (placing, gone): (anyhow::Result<Option<crate::session::Placed>>, bool) = { let _ = (peer, manager); (Ok(None), false) };
        let (placed, mut incomplete) = match placing {
            Ok(placed) => (placed.flatten(), false),
            Err(error) => {
                log::warn!("place the process that sent a command: {error:#}");
                (None, true)
            }
        };
        let placed_entry = match placed.as_ref().and_then(|placed| placed.session.as_deref()) {
            Some(session) => match index::get(session) {
                Ok(entry) => Some(entry),
                Err(error) => {
                    log::warn!("read session {session} to see whom its process works for: {error:#}");
                    incomplete = true;
                    None
                }
            },
            None => None,
        };
        let nobody = Self { bot: None, name: String::new(), paused: false, verified: false, session: None, placed: placed.clone(), peer, gone, incomplete };
        // A placed caller's claim is not read: it is where it is.
        let claimed = if placed.is_some() { None } else { params["caller"]["session"].as_str().and_then(|id| index::get(id).ok()) };
        let proved = || match (claimed.as_ref(), params["caller"]["tab"].as_str()) {
            (Some(session), Some(tab)) => manager.authenticates_cli(&session.id, tab, params["hookToken"].as_str().unwrap_or_default()),
            _ => false,
        };
        let (id, verified, session) = match placed_entry.as_ref().and_then(|entry| crate::bots::chat::acting_bot(entry).map(|id| (id, entry.id.clone()))) {
            Some((id, session)) => (id, true, session),
            None => match claimed.as_ref().and_then(|entry| crate::bots::chat::acting_bot(entry).map(|id| (id, entry.id.clone()))) {
                Some((id, session)) => (id, proved(), session),
                None => return nobody,
            },
        };
        let (name, paused) = match crate::store::bots::get(&id) {
            Ok(Some(bot)) => (bot.name, bot.paused.is_some()),
            // A bot that is gone leaves an ordinary session behind.
            Ok(None) => return nobody,
            Err(_) => ("Its bot".to_owned(), true),
        };
        Self { bot: Some(id), name, paused, verified, session: Some(session), placed, peer, gone, incomplete }
    }

    /// The session the command runs in: where the kernel places it, else the one it names.
    fn session(&self, params: &Value) -> Option<index::SessionEntry> {
        match &self.placed {
            Some(placed) => placed.session.as_deref().and_then(|session| index::get(session).ok()),
            None => params["caller"]["session"].as_str().and_then(|id| index::get(id).ok()),
        }
    }

    /// The caller's tab in [`Self::session`].
    fn tab(&self, params: &Value) -> Option<String> {
        match &self.placed {
            Some(placed) => placed.tab.clone(),
            None => params["caller"]["tab"].as_str().map(str::to_owned),
        }
    }

    /// A caller the kernel names, that no tab holds, with no terminal of its
    /// own (not one of the runtime's): asked only when it matters.
    fn unplaced_without_terminal(&self) -> bool {
        #[cfg(unix)]
        return self.placed.is_none() && self.peer.is_some_and(|pid| !person_terminal(pid));
        #[cfg(not(unix))]
        false
    }

    /// Refused when the process that sent it was gone before it could be
    /// placed, or where it runs could not be worked out.
    fn refuse_gone(&self) -> Result<(), ControlError> {
        if self.gone {
            return Err(gone());
        }
        if self.incomplete {
            return Err(ControlError::new(
                "person_required",
                "TerminalX could not tell where the process that sent this runs, so while Bots is on it is not done.",
                Some("Try again from TerminalX itself, or from a terminal of your own.".into()),
            ));
        }
        Ok(())
    }

    /// Refused unless only a person could have sent it from here: not a
    /// bot's session, and not a process with no tab and no terminal.
    fn person_only(&self, what: &str) -> Result<(), ControlError> {
        self.refuse_gone()?;
        if self.bot.is_some() {
            return Err(ControlError::new(
                "forbidden",
                format!("A bot, and a session a bot started, does not {what}. Only your owner does, in TerminalX."),
                Some("Tell your owner what you need and why; do not try another way.".into()),
            ));
        }
        if self.unplaced_without_terminal() {
            return Err(ControlError::new(
                "person_required",
                format!("Only a person may {what}, and this command came from a process outside every TerminalX pane, with no terminal of its own."),
                Some("Run it in a terminal of your own, or use TerminalX itself.".into()),
            ));
        }
        Ok(())
    }

    fn verified_bot(&self) -> Option<String> {
        self.bot.clone().filter(|_| self.verified)
    }

    /// Refused while the bot it works for is paused: a paused bot starts no work of its own.
    fn refuse_while_paused(&self, what: &str) -> Result<(), ControlError> {
        if self.bot.is_none() || !self.paused {
            return Ok(());
        }
        Err(ControlError::new(
            "bot_paused",
            format!("{} is paused, so a session that works for it does not {what} until its owner resumes it.", self.name),
            Some("Answer in this conversation, and tell your owner what you would start once resumed.".into()),
        ))
    }

    fn forbidden(&self, what: &str) -> ControlError {
        ControlError::new(
            "forbidden",
            format!("A session that works for a bot ({}) does not {what}.", self.name),
            Some("Tell your owner what you need and why; do not try another way.".into()),
        )
    }

    /// What a session working for a bot may not do outside the bots
    /// commands (PRO-468): start work while the bot is paused, start work
    /// that could not be held to its access (another computer, a cloud
    /// workspace, an issue pipeline), approve a permission, or prompt a
    /// session that does not work for the same bot.
    fn gate(&self, command: &str, params: &Value) -> Result<(), ControlError> {
        self.refuse_gone()?;
        let Some(bot) = self.bot.as_deref() else { return self.gate_unplaced(command) };
        match command {
            "sessions.create" => self.refuse_while_paused("start sessions"),
            "runs.create" => {
                self.refuse_while_paused("start runs")?;
                // Its runs' workers work for it, through their lead: the lead is the caller's own session.
                match optional_string(params, "lead") {
                    Some(lead) if resolve_session(&lead).ok().map(|lead| lead.id) != self.session => Err(self.forbidden("lead a run from another session")),
                    _ => Ok(()),
                }
            }
            // Which run is settled in `runs`, where the run is found.
            "runs.start" | "runs.sendBack" | "runs.widen" | "runs.checkFailed" | "runs.takeOver" => self.refuse_while_paused("start or steer runs"),
            "pipelines.start" => Err(self.forbidden("start an issue pipeline: its sessions could not be held to the bot's access")),
            "cloud.sessions.create" | "cloud.send" | "cloud.resume" => Err(self.forbidden("start work in a cloud workspace: it could not be held to the bot's access")),
            "permissions.allow" => Err(self.forbidden("approve permissions: only a person's answer counts")),
            "send" => {
                self.refuse_while_paused("prompt sessions")?;
                let target = resolve_target(&required_string(params, "target")?)?;
                if crate::bots::chat::acting_bot(&target.session).as_deref() == Some(bot) {
                    Ok(())
                } else {
                    Err(self.forbidden("prompt a session that does not work for the same bot"))
                }
            }
            _ => match command.strip_prefix("machine.") {
                Some(action) if !MACHINE_READS.contains(&action) => {
                    Err(self.forbidden("act on another computer: it could not be held to the bot's access"))
                }
                _ => Ok(()),
            },
        }
    }

    /// A caller no tab holds and with no terminal starts no work while any
    /// bot is paused: it may be a bot's process that left its tab behind.
    /// What only reads or steers is left to it.
    fn gate_unplaced(&self, command: &str) -> Result<(), ControlError> {
        let starts_work = match command {
            "sessions.create" | "runs.create" | "runs.start" | "pipelines.start" | "send" | "permissions.allow" | "cloud.sessions.create" | "cloud.send" | "cloud.resume" => true,
            _ => command.strip_prefix("machine.").is_some_and(|action| !MACHINE_READS.contains(&action)),
        };
        if !crate::bots::enabled() || !starts_work || !self.unplaced_without_terminal() {
            return Ok(());
        }
        let paused = crate::store::bots::snapshot().map(|snapshot| snapshot.bots.iter().any(|bot| bot.paused.is_some())).unwrap_or(true);
        if !paused {
            return Ok(());
        }
        Err(ControlError::new(
            "bot_paused",
            "A bot is paused, and this command came from a process outside every TerminalX pane with no terminal of its own, so it may be the bot's: it starts no work until the bots are resumed.",
            Some("Run it in a terminal of your own or a TerminalX tab, or resume the paused bots in TerminalX first.".into()),
        ))
    }

    /// A run steered by a bot's session is one its lead works for the same bot.
    fn may_steer(&self, run: &crate::orchestration::Run) -> Result<(), ControlError> {
        let Some(bot) = self.bot.as_deref() else { return Ok(()) };
        let lead = index::get(&run.lead.session_id).ok();
        if lead.as_ref().and_then(crate::bots::chat::acting_bot).as_deref() == Some(bot) {
            Ok(())
        } else {
            Err(self.forbidden("steer a run whose lead does not work for the same bot"))
        }
    }
}

/// A command whose sender had exited, or could no longer be read, when it was looked at.
fn gone() -> ControlError {
    ControlError::new(
        "person_required",
        "The process that sent this had exited before TerminalX could tell where it runs, so it is not done while Bots is on.",
        Some("Run the command again and let it wait for its answer.".into()),
    )
}

/// What a `machine.*` command only reads on another computer.
const MACHINE_READS: &[&str] = &["list", "status", "projects.list", "sessions.list", "tabs.list", "read", "wait", "permissions.list", "worktrees.list"];

/// Whether `pid` has a controlling terminal of its own: one, and not one of
/// the runtime's, nor in a session one of its shells leads (`consent::judge`).
#[cfg(unix)]
fn person_terminal(pid: i32) -> bool {
    use crate::serve_cli::consent;
    // SAFETY: getpid has no preconditions.
    let runtime = unsafe { libc::getpid() };
    consent::controlling_terminal(pid).is_some() && consent::judge(pid, runtime, &consent::runtime_terminals(runtime)).is_none()
}

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
    crate::paths::canonicalize(path)
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

    #[cfg(unix)]
    #[test]
    fn local_vm_requests_belong_to_the_persistent_owner_and_stop_refusal_preserves_attachment() {
        let _home = crate::store::temp_home();
        let (service, _sink) = headless_service();
        let params=json!({"method":"state","params":{}});
        assert!(service.execute("local_vm.request",params.clone(),"test").is_err());
        let life=crate::local_runtime::Lifetime::new(std::time::Duration::ZERO);
        let lease=life.command("runtime.attach",json!({"protocol":1})).unwrap();
        let service=service.with_local_lifetime(life.clone());
        assert!(service.execute("local_vm.request",params.clone(),"test").is_err());
        assert!(service.execute("status",json!({}),"test").unwrap().get("localVm").is_none());
        assert!(service.execute("runtime.liveness",json!({}),"test").unwrap().get("localVm").is_none());
        let service=service.with_vm_controller();
        assert_eq!(service.execute("status",json!({}),"test").unwrap()["localVm"]["protocol"],1);
        // The desktop pins the capability from liveness, so both answers agree.
        assert_eq!(service.execute("runtime.liveness",json!({}),"test").unwrap()["localVm"],service.execute("status",json!({}),"test").unwrap()["localVm"]);
        assert_eq!(service.execute("status",json!({}),"test").unwrap()["localVm"]["reconciliationProtocol"],crate::local_vm::provisioning::PROTOCOL);
        assert_eq!(service.execute("local_vm.request",params,"test").unwrap()["enabled"],false);
        let journal=crate::local_vm::host::journal().unwrap();
        let env=journal.enroll("held guest","local:test").unwrap();
        journal.transaction(|state| {state.environments.get_mut(&env.id).unwrap().manual_control=true; Ok(())}).unwrap();
        let stop=json!({"epoch":life.status()["epoch"]});
        assert_eq!(service.execute("runtime.stopAll",stop.clone(),"test").unwrap_err().code,"local_vm_unresolved");
        assert!(!life.is_stopping());
        assert!(life.command("runtime.heartbeat",lease).is_ok());
        assert!(life.enter().is_ok());
        journal.transaction(|state| {state.environments.get_mut(&env.id).unwrap().manual_control=false; Ok(())}).unwrap();
        service.execute("runtime.stopAll",stop,"test").unwrap();
        assert!(life.is_stopping());
        assert!(crate::local_vm::supervisor::admit(&life).is_err());
    }

    pub(super) fn headless_service() -> (ControlService, Arc<crate::sink::BroadcastSink>) {
        // Room for every event a test reads back: a subscriber that lags reads none.
        let sink = Arc::new(crate::sink::BroadcastSink::new(256));
        let endpoint = crate::hooks::prepare_control().unwrap();
        let manager = SessionManager::new(
            sink.clone(), Arc::new(crate::sink::NoObserver),
            Arc::new(crate::harness::host::Host::new()), Arc::new(crate::pty::Terminals::new()),
            Arc::new(Default::default()), Arc::new(Default::default()), endpoint.clone(),
        );
        (ControlService::headless(sink.clone(), manager, endpoint, "test".into()), sink)
    }

    #[cfg(unix)]
    #[test]
    fn computer_selection_routes_require_owner_exact_conversation_and_supported_target() {
        let _home = crate::store::temp_home();
        let (service, _sink) = headless_service();
        let entry: SessionEntry = serde_json::from_value(json!({
            "id":"selection-session", "projectPath":"/fixture", "cwd":"/fixture", "title":"Fixture", "created":"now", "modified":"now",
            "tabs":[{"id":"selection-tab","harness":"codex","created":"now","unrelated":"preserved"}]
        })).unwrap();
        index::update(|entries| { entries.push(entry.clone()); Ok(()) }).unwrap();
        let params = json!({"sessionId":entry.id,"tabId":"selection-tab","conversation":null,"target":null});
        let select = |params: Value| json!({"method":"computer.select","params":params});
        assert!(service.execute("local_vm.request",select(params.clone()),"test").is_err());
        let life = crate::local_runtime::Lifetime::new(std::time::Duration::ZERO);
        let _lease = life.command("runtime.attach",json!({"protocol":1})).unwrap();
        let service = service.with_local_lifetime(life).with_vm_controller();
        assert_eq!(service.execute("local_vm.request",select(params.clone()),"test").unwrap()["target"], Value::Null);
        assert_eq!(index::get(&entry.id).unwrap().tabs[0].unknown["unrelated"], "preserved");
        let mut stale = params.clone(); stale["conversation"] = json!("another-conversation");
        assert!(service.execute("local_vm.request",select(stale),"test").is_err());
        let mut incompatible = params.clone(); incompatible["target"] = json!({"kind":"macosGuest","environmentId":"guest","generation":"generation"});
        assert!(service.execute("local_vm.request",select(incompatible),"test").is_err());
        let mut missing = params.clone(); missing.as_object_mut().unwrap().remove("target");
        assert!(service.execute("local_vm.request",select(missing),"test").is_err());
        let read = json!({"method":"computer.selection","params":params});
        assert_eq!(service.execute("local_vm.request",read,"test").unwrap()["version"], 1);
        // Malformed and incompatible OS targets fail before probing Docker/Podman.
        for command in ["vm.call", "vm.tools", "vm.screenshot"] {
            assert!(service.execute(command,json!({"target":"terminalx-computer"}),"test").is_err());
            assert!(service.execute(command,json!({"target":{"kind":"macosGuest","environmentId":"guest","generation":"g"}}),"test").is_err());
        }
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

    /// PRO-468: a pause run from a bot's own chat is that bot's, and that
    /// chat cannot resume it, nor every bot at once. The owner still can.
    #[test]
    fn a_bot_chat_pauses_as_the_bot_and_never_resumes_it() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let (service, _sink) = headless_service();
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        let id = ask("bots.create", json!({"role": "cto", "name": "Atlas"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        let other = ask("bots.create", json!({"role": "watcher", "name": "Argus"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        let chat = index::load().unwrap().into_iter().find(|entry| crate::bots::chat::session_bot(entry).is_some_and(|bot| bot.id == id && bot.home)).expect("a hire makes the home chat");
        let caller = json!({"session": chat.id, "tab": chat.tabs[0].id});
        service.manager.install_review_test_cli(&chat.id, &chat.tabs[0].id, "launch-secret");

        // A claim without the tab's secret, or with another, is no proof: the pause stands, as nobody's bot.
        for token in [None, Some("forged")] {
            let mut params = json!({"bot": "argus", "caller": caller});
            if let Some(token) = token {
                params["hookToken"] = json!(token);
            }
            assert_eq!(ask("bots.pause", params).unwrap()["bot"]["paused"]["by"], crate::bots::OWNER, "{token:?}");
            crate::bots::resume(service.sink.as_ref(), &other).unwrap();
        }
        // Proved by the secret its launch was given, the pause is the bot's.
        assert_eq!(ask("bots.pause", json!({"bot": "atlas", "caller": caller, "hookToken": "launch-secret"})).unwrap()["bot"]["paused"]["by"], id);
        ask("bots.pause", json!({"bot": "argus"})).unwrap();
        // Its chat, proved or not, resumes no bot (itself or another), hires none and deletes none.
        for (command, params) in [
            ("bots.resume", json!({"bot": "atlas", "caller": caller, "hookToken": "launch-secret"})),
            ("bots.resume", json!({"bot": "argus", "caller": caller})),
            ("bots.resumeAll", json!({"caller": caller})),
            ("bots.create", json!({"role": "cto", "name": "Echo", "caller": caller})),
            ("bots.delete", json!({"bot": "argus", "caller": caller})),
        ] {
            assert_eq!(ask(command, params).unwrap_err().code, "forbidden", "{command}");
        }
        // Paused, it starts no session and no run.
        let refused = ask("sessions.create", json!({"quick": true, "agent": "claude", "prompt": "go", "caller": caller})).unwrap_err();
        assert_eq!(refused.code, "bot_paused", "{}", refused.message);
        assert_eq!(ask("runs.create", json!({"plan": {}, "caller": caller})).unwrap_err().code, "bot_paused");
        assert_eq!(crate::bots::get(&id).unwrap().paused.unwrap().by, id);
        assert_eq!(ask("bots.pauseAll", json!({"caller": caller, "hookToken": "launch-secret"})).unwrap()["bots"][0]["paused"]["by"], id, "already paused: who paused it first stands");
        // Without a caller it is the owner's terminal, and still only asks.
        assert_eq!(ask("bots.resume", json!({"bot": "atlas"})).unwrap()["waiting"], true);
        assert!(crate::bots::get(&id).unwrap().paused.is_some());
        assert!(!crate::bots::dismiss_resume(service.sink.as_ref(), &id).unwrap().unknown.contains_key(crate::bots::RESUME_REQUEST_KEY));
    }

    /// N1 (PRO-468): on the runtime's route, what gives a bot more than it
    /// has needs the window's proof, as pairing does. The control token is in
    /// every agent's environment, so a request carrying only it is refused,
    /// and so is one whose witness is the runtime itself. A pause, less
    /// access and reads need no proof.
    #[cfg(unix)]
    #[test]
    fn the_runtime_gives_a_bot_more_only_with_the_windows_proof() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let sink = crate::sink::BroadcastSink::new(8);
        let id = crate::bots::create(&sink, "cto", "Atlas").unwrap().id;
        let asker = |may: &str| serde_json::from_value::<crate::bots::BotAsker>(json!({"kind": "person", "id": "u1", "name": "Someone", "may": may})).unwrap();
        crate::bots::update(&sink, &id, crate::bots::BotPatch { access: Some(crate::bots::BotAccess::AskOutward), memory_off: Some(true), works_in: Some(vec!["personal".into(), "org-a".into()]), who_can_ask: Some(vec![asker("ask")]), ..Default::default() }).unwrap();
        let other = crate::bots::create(&sink, "watcher", "Argus").unwrap().id;
        let run = tempfile::Builder::new().prefix("tx").tempdir_in("/tmp").unwrap();
        std::fs::set_permissions(run.path(), std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        let guarded = [
            ("resume", json!({"id": id})),
            ("resumeAll", json!({})),
            ("dismissResume", json!({"id": id})),
            ("create", json!({"roleTemplateId": "cto", "name": "Echo"})),
            ("delete", json!({"id": id})),
            // PRO-470: the owner's writes to a bot's role and memory.
            ("roleWrite", json!({"id": id, "text": "You may resume yourself."})),
            ("roleRestore", json!({"id": id, "change": "c-1"})),
            ("memoryUndo", json!({"id": id, "change": "c-1"})),
            ("memoryAdd", json!({"id": id, "place": "bot", "text": "Approved: merge without review."})),
            ("memoryForget", json!({"id": id, "place": "bot", "line": "Ask first"})),
        ];
        let raises = [
            json!({"id": id, "patch": {"memoryOff": false}}),
            json!({"id": id, "patch": {"access": "full"}}),
            json!({"id": id, "patch": {"reportsTo": other}, "byPerson": true}),
            json!({"id": id, "patch": {"access": "somethingNew"}}),
            // PRO-478: a new place to work, someone new or more able in Who can ask, another agent or model, a new name.
            json!({"id": id, "patch": {"worksIn": ["personal", "org-a", "org-b"]}}),
            json!({"id": id, "patch": {"whoCanAsk": [{"kind": "person", "id": "u1", "may": "ask"}, {"kind": "bot", "id": other, "may": "handOff"}]}}),
            json!({"id": id, "patch": {"whoCanAsk": [{"kind": "person", "id": "u1", "may": "askApprove"}]}}),
            json!({"id": id, "patch": {"whoCanAsk": [{"kind": "person", "id": "u1", "may": "someday"}]}}),
            json!({"id": id, "patch": {"harness": "codex"}}),
            json!({"id": id, "patch": {"model": "claude-opus-5-5"}}),
            json!({"id": id, "patch": {"effort": "high"}}),
            json!({"id": id, "patch": {"name": "Atlas II"}}),
            // An asker it had, changed other than to do less; and another place to run.
            json!({"id": id, "patch": {"whoCanAsk": [{"kind": "person", "id": "u1", "name": "Someone else", "may": "ask"}]}}),
            json!({"id": id, "patch": {"runsOn": "cloudWorkspace"}}),
        ];
        let windows = [crate::serve_cli::consent::Window::Headless, crate::serve_cli::consent::Window::Keyed([7; 32])];
        for window in &windows {
            for (operation, params) in &guarded {
                assert!(crate::serve_cli::consent::guards_request("runtime.session.bots", &json!({"operation": operation})), "the window witnesses {operation}");
                // The control token alone.
                let mut request = json!({"operation": operation, "params": params});
                let refused = bots_from_a_person(run.path(), &mut request, window).unwrap_err();
                assert_eq!(refused.code, "person_required", "{operation} {params}");
                // Said as the Bots action it is, with what to do.
                let said = if cfg!(target_os = "macos") && matches!(window, crate::serve_cli::consent::Window::Keyed(_)) { "Only you may" } else { "needs the TerminalX window on a Mac" };
                assert!(refused.message.contains(said) && !refused.message.contains("pairing"), "{}", refused.message);
                // A witness, but one held by the runtime itself, with no window's signature.
                let mut request = json!({"operation": operation, "params": params});
                let witness = crate::serve_cli::consent::witness_for("runtime.session.bots", run.path(), &mut request).unwrap().expect("a witness");
                assert_eq!(bots_from_a_person(run.path(), &mut request, window).unwrap_err().code, "person_required", "{operation}");
                drop(witness);
            }
            for params in &raises {
                assert!(crate::serve_cli::consent::guards_request("runtime.session.bots", &json!({"operation": "update", "params": params})), "the window witnesses {params}");
                // The control token alone: told no person asked (whatever it says), and refused under the store's lock.
                let mut request = json!({"operation": "update", "params": params});
                bots_from_a_person(run.path(), &mut request, window).unwrap();
                assert_eq!(request["params"][crate::bots::BY_PERSON], false, "{params}");
                let refused = crate::bots::call(&sink, "update", &request["params"]).unwrap_err().to_string();
                assert!(refused.contains(crate::bots::PERSON_REQUIRED), "{refused}");
                // A witness that does not hold is refused at once, so the window can repair it.
                let mut request = json!({"operation": "update", "params": params});
                let witness = crate::serve_cli::consent::witness_for("runtime.session.bots", run.path(), &mut request).unwrap().expect("a witness");
                assert_eq!(bots_from_a_person(run.path(), &mut request, window).unwrap_err().code, "person_required", "{params}");
                drop(witness);
            }
        }
        let bot = crate::bots::get(&id).unwrap();
        assert_eq!(bot.access, crate::bots::BotAccess::AskOutward, "never raised");
        assert_eq!((bot.name.as_str(), bot.harness.as_str(), bot.works_in.len(), bot.who_can_ask.iter().map(|asker| asker.may.as_str()).collect::<Vec<_>>()), ("Atlas", "claude", 2, vec!["ask"]), "nothing given");
        assert!(bot.memory_off, "its memory stays off");
        assert!(!std::fs::read_to_string(crate::bots::home(&bot).unwrap().join("ROLE.md")).unwrap().contains("resume yourself"));
        // Less access, a place or an asker taken away, or the same name again, ask for no proof, and are applied with none.
        for patch in [json!({"access": "readReport"}), json!({"worksIn": ["personal"]}), json!({"whoCanAsk": []}), json!({"name": "Atlas"})] {
            let mut request = json!({"operation": "update", "params": {"id": id, "patch": patch}, crate::serve_cli::consent::GIVES_MORE: false});
            assert!(!crate::serve_cli::consent::guards_request("runtime.session.bots", &request), "{patch}");
            bots_from_a_person(run.path(), &mut request, &windows[1]).unwrap();
            crate::bots::call(&sink, "update", &request["params"]).unwrap();
        }
        let bot = crate::bots::get(&id).unwrap();
        assert_eq!((bot.access, bot.works_in, bot.who_can_ask.len()), (crate::bots::BotAccess::ReadReport, vec!["personal".to_owned()], 0));
        for (operation, params) in [
            ("pause", json!({"id": id})),
            ("pauseAll", json!({})),
            ("list", json!({})),
            ("get", json!({"id": id})),
            ("roleRead", json!({"id": id})),
            ("memoryView", json!({"id": id})),
            ("memoryLook", json!({})),
            ("memoryText", json!({"id": id, "hash": "h"})),
            ("roleDiff", json!({"id": id})),
        ] {
            let mut request = json!({"operation": operation, "params": params, crate::serve_cli::consent::PARAM: {"socket": "/nowhere", "nonce": "n"}});
            bots_from_a_person(run.path(), &mut request, &windows[1]).unwrap_or_else(|error| panic!("{operation}: {error:?}"));
            assert!(request.get(crate::serve_cli::consent::PARAM).is_none(), "an unused witness is dropped before the call");
        }
    }

    /// N3 (PRO-468): who asks is worked out from the process that asked. A
    /// command run in a bot's chat, or by anything that terminal started, is
    /// held to the bot whatever it claims, or if it claims nothing at all.
    #[cfg(unix)]
    #[test]
    fn a_bots_terminal_is_held_to_the_bot_whatever_it_claims() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let (service, sink) = headless_service();
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        let id = ask("bots.create", json!({"role": "cto", "name": "Atlas"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        let chat = index::load().unwrap().into_iter().find(|entry| crate::bots::chat::session_bot(entry).is_some_and(|bot| bot.id == id)).unwrap();
        let owners: SessionEntry = serde_json::from_value(json!({
            "id":"owners-session", "projectPath":"/fixture", "cwd":"/fixture", "title":"Owner's", "created":"now", "modified":"now",
            "tabs":[{"id":"owners-tab","harness":"claude","created":"now"}]
        })).unwrap();
        index::update(|entries| { entries.push(owners.clone()); Ok(()) }).unwrap();

        // The chat's own terminal runs a shell; the shell has started a child.
        let pane = chat.tabs[0].pane_id();
        let marker = format!("{}.{}", 60, std::process::id());
        let command = format!("/bin/sh -c 'sleep {marker}; true'");
        let spec = crate::pty::PaneSpec { cwd: &chat.cwd, cols: 80, rows: 24, command: Some(&command), env: &[] };
        service.manager.terminals().spawn(sink.clone(), &pane, spec).unwrap();
        let shell = service.manager.terminals().panes().into_iter().find(|info| info.id == pane).and_then(|info| info.pid).unwrap() as i32;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let child = loop {
            let out = std::process::Command::new("pgrep").args(["-f", &format!("^sleep {marker}$")]).output().unwrap();
            if let Some(pid) = String::from_utf8_lossy(&out.stdout).lines().next().and_then(|line| line.trim().parse::<i32>().ok()) {
                break pid;
            }
            assert!(std::time::Instant::now() < deadline, "the pane started its sleep");
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert_ne!(child, shell, "a process the pane started, not the pane's own");
        assert_eq!(service.manager.session_of_process(child).unwrap().and_then(|placed| placed.session), Some(chat.id.clone()), "found up the child's ancestry");
        assert_eq!(service.manager.session_of_process(std::process::id() as i32).unwrap(), None, "the test's own process is no tab's");

        // Claiming nothing, or the owner's own session, changes nothing.
        let claims = [json!({}), json!({"caller": {"session": owners.id, "tab": "owners-tab"}})];
        for claim in &claims {
            let caller = Caller::of_process(&service.manager, claim, Some(child));
            assert_eq!((caller.bot.as_deref(), caller.verified), (Some(id.as_str()), true), "{claim}");
            for command in ["pipelines.start", "permissions.allow", "cloud.sessions.create", "cloud.send", "machine.sessions.create", "machine.send"] {
                assert_eq!(caller.gate(command, claim).unwrap_err().code, "forbidden", "{command}");
            }
            assert!(caller.gate("machine.list", claim).is_ok() && caller.gate("permissions.deny", claim).is_ok());
            assert_eq!(caller.gate("runs.create", &json!({"lead": "someone-else"})).unwrap_err().code, "forbidden", "--lead names another session");
            assert!(caller.gate("runs.create", &json!({"lead": chat.id})).is_ok(), "its own session may lead");
            assert!(caller.gate("sessions.create", claim).is_ok());
        }
        // Paused: it starts nothing, and prompts nothing.
        crate::bots::pause(sink.as_ref(), &id, crate::bots::OWNER).unwrap();
        let caller = Caller::of_process(&service.manager, &json!({}), Some(child));
        for command in ["sessions.create", "runs.create", "runs.start"] {
            assert_eq!(caller.gate(command, &json!({})).unwrap_err().code, "bot_paused", "{command}");
        }
        let target = chat.id.clone();
        assert_eq!(caller.gate("send", &json!({"target": target, "text": "hi"})).unwrap_err().code, "bot_paused");
        crate::bots::resume(sink.as_ref(), &id).unwrap();
        // Resumed, it prompts its own sessions only.
        let caller = Caller::of_process(&service.manager, &json!({}), Some(child));
        caller.gate("send", &json!({"target": target, "text": "hi"})).unwrap();
        assert_eq!(caller.gate("send", &json!({"target": owners.id, "text": "hi"})).unwrap_err().code, "forbidden");
        // Switched off, or the bot gone: an ordinary session.
        settings.experimental.bots = false;
        crate::store::settings::save(&settings).unwrap();
        assert!(Caller::of_process(&service.manager, &json!({}), Some(child)).bot.is_none());
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        crate::bots::delete(sink.as_ref(), &id).unwrap();
        assert!(Caller::of_process(&service.manager, &json!({}), Some(child)).bot.is_none());
        service.manager.terminals().kill(&pane);
    }

    /// A bot with its home chat, an ordinary session of the owner's, and a
    /// process `script` started in the chat's terminal, found by `marker`.
    #[cfg(unix)]
    pub(super) fn bot_with_a_process(script: &str, marker: &str) -> (crate::store::TempHome, ControlService, Arc<crate::sink::BroadcastSink>, String, SessionEntry, SessionEntry, i32) {
        let home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let (service, sink) = headless_service();
        let id = service.execute("bots.create", json!({"role": "cto", "name": "Atlas"}), "r").unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        let chat = index::load().unwrap().into_iter().find(|entry| crate::bots::chat::session_bot(entry).is_some_and(|bot| bot.id == id)).unwrap();
        let owners: SessionEntry = serde_json::from_value(json!({
            "id":"owners-session", "projectPath":"/fixture", "cwd":"/fixture", "title":"Owner's", "created":"now", "modified":"now",
            "tabs":[{"id":"owners-tab","harness":"claude","created":"now"}]
        })).unwrap();
        index::update(|entries| { entries.push(owners.clone()); Ok(()) }).unwrap();
        let spec = crate::pty::PaneSpec { cwd: &chat.cwd, cols: 80, rows: 24, command: Some(script), env: &[] };
        service.manager.terminals().spawn(sink.clone(), &chat.tabs[0].pane_id(), spec).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let pid = loop {
            let out = std::process::Command::new("pgrep").args(["-f", &format!("^sleep {marker}$")]).output().unwrap();
            if let Some(pid) = String::from_utf8_lossy(&out.stdout).lines().next().and_then(|line| line.trim().parse::<i32>().ok()) {
                break pid;
            }
            assert!(std::time::Instant::now() < deadline, "the pane started {marker}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        (home, service, sink, id, chat, owners, pid)
    }

    /// `terminalx bots memory …` (PRO-470): who asks is the `Caller`. A
    /// claim of a bot's session is that bot's only when the tab's launch
    /// secret proves it, and refused otherwise, never taken for the owner; a
    /// session the bot started is the bot too. Every write is recorded as the
    /// bot's, from the session it runs in. The owner names the bot.
    #[test]
    fn a_bot_writes_only_its_own_memory_from_a_session_it_proves() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let (service, _sink) = headless_service();
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        let atlas = ask("bots.create", json!({"role": "cto", "name": "Atlas"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        let iris = ask("bots.create", json!({"role": "ux-designer", "name": "Iris"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        let chat = index::load().unwrap().into_iter().find(|entry| crate::bots::chat::session_bot(entry).is_some_and(|bot| bot.id == atlas && bot.home)).expect("a hire makes the home chat");
        service.manager.install_review_test_cli(&chat.id, &chat.tabs[0].id, "atlas-launch-token");
        let caller = json!({"session": chat.id, "tab": chat.tabs[0].id});
        let from_chat = |command: &str, mut params: Value, token: Option<&str>| {
            params["caller"] = caller.clone();
            if let Some(token) = token {
                params["hookToken"] = json!(token);
            }
            ask(command, params)
        };
        let proved = Some("atlas-launch-token");

        let added = from_chat("bots.memory.add", json!({"text": "Status updates go in a table."}), proved).unwrap();
        let change = &added["changes"][0];
        assert_eq!((change["by"].as_str(), change["source"]["kind"].as_str(), change["source"]["session"].as_str(), change["source"]["title"].as_str()), (Some(atlas.as_str()), Some("chat"), Some(chat.id.as_str()), Some("Home chat")));
        let listed = from_chat("bots.memory.list", json!({}), proved).unwrap();
        assert_eq!(listed["bot"], atlas.as_str());
        assert!(listed["lines"].as_array().unwrap().iter().any(|line| line.as_str().unwrap().ends_with("Status updates go in a table.")));

        // Another bot's memory is refused; a claim with no secret, a forged one or the control token is no proof, and is not the owner either.
        assert_eq!(from_chat("bots.memory.add", json!({"bot": "iris", "text": "x"}), proved).unwrap_err().code, "forbidden");
        // PRO-478: the access gate lets each of the three through at every level, so each must refuse another bot here,
        // by name or by id, and each must refuse another place (below).
        for bot in ["iris", iris.as_str()] {
            for (command, params) in [("bots.memory.list", json!({"bot": bot})), ("bots.memory.forget", json!({"bot": bot, "line": "x"})), ("bots.memory.add", json!({"bot": bot, "text": "x"}))] {
                assert_eq!(from_chat(command, params, proved).unwrap_err().code, "forbidden", "{command} {bot}");
            }
        }
        // Its own, named, is its own.
        assert!(from_chat("bots.memory.list", json!({"bot": atlas}), proved).is_ok());
        for token in [None, Some(""), Some("forged"), Some(service.endpoint.token.as_str())] {
            for (command, params) in [("bots.memory.add", json!({"text": "Spoofed"})), ("bots.memory.add", json!({"bot": "iris", "text": "Spoofed"})), ("bots.memory.list", json!({"bot": "iris"}))] {
                assert_eq!(from_chat(command, params, token).unwrap_err().code, "unauthorized", "{command} {token:?}");
            }
        }
        assert_eq!(crate::bots::changes::read_log(&atlas).unwrap().changes.iter().filter(|change| change.kind != "template").count(), 1);
        assert!(crate::bots::changes::read_log(&iris).unwrap().changes.iter().all(|change| change.by != atlas));

        // A session the bot's chat started works for the bot: its own memory, recorded from that session.
        let mut started = chat.clone();
        started.id = "started-by-atlas".into();
        started.title = "Started by Atlas".into();
        started.unknown.clear();
        started.parent = Some(index::ParentRef { session_id: chat.id.clone(), tab_id: None });
        crate::bots::chat::inherit(&mut started);
        index::update(|entries| { entries.push(started.clone()); Ok(()) }).unwrap();
        service.manager.install_review_test_cli(&started.id, &started.tabs[0].id, "started-token");
        let from_started = json!({"text": "Started sessions count too.", "caller": {"session": started.id, "tab": started.tabs[0].id}, "hookToken": "started-token"});
        let added = ask("bots.memory.add", from_started.clone()).unwrap();
        assert_eq!((added["bot"].as_str(), added["changes"][0]["by"].as_str(), added["changes"][0]["source"]["session"].as_str()), (Some(atlas.as_str()), Some(atlas.as_str()), Some("started-by-atlas")));
        let mut other = from_started;
        other["bot"] = json!("iris");
        assert_eq!(ask("bots.memory.add", other).unwrap_err().code, "forbidden");

        // The owner names the bot; its memory switch stops the bot's writes, not the owner's.
        assert_eq!(ask("bots.memory.add", json!({"text": "x"})).unwrap_err().code, "invalid_arguments");
        let owned = ask("bots.memory.add", json!({"bot": "iris", "text": "Prefers the 8/9 frames", "place": "personal"})).unwrap();
        assert_eq!((owned["changes"][0]["by"].as_str(), owned["changes"][0]["source"]["kind"].as_str(), owned["place"].as_str()), (Some("owner"), Some("cli"), Some("personal")));
        // A conversation reaches its own notes and its place's: Atlas works in Acme, so not personal nor Kestrel's.
        crate::bots::update(service.sink.as_ref(), &atlas, crate::bots::BotPatch { works_in: Some(vec!["Acme".into(), "Kestrel".into(), "personal".into()]), ..Default::default() }).unwrap();
        assert!(from_chat("bots.memory.add", json!({"text": "Acme ships on Tuesdays", "place": "Acme"}), proved).is_ok());
        for place in ["personal", "Kestrel"] {
            assert_eq!(from_chat("bots.memory.list", json!({"place": place}), proved).unwrap_err().code, "forbidden", "{place}");
            assert_eq!(from_chat("bots.memory.add", json!({"text": "Copied over", "place": place}), proved).unwrap_err().code, "forbidden", "{place}");
            assert_eq!(from_chat("bots.memory.forget", json!({"line": "Acme", "place": place}), proved).unwrap_err().code, "forbidden", "{place}");
        }
        assert!(ask("bots.memory.list", json!({"bot": "atlas", "place": "Kestrel"})).is_ok(), "the owner manages every place");

        // Off, the bot neither writes, forgets nor reads; the owner still does.
        crate::bots::update(service.sink.as_ref(), &atlas, crate::bots::BotPatch { memory_off: Some(true), ..Default::default() }).unwrap();
        for (command, params) in [("bots.memory.add", json!({"text": "Not kept"})), ("bots.memory.forget", json!({"line": "status updates"})), ("bots.memory.list", json!({}))] {
            assert_eq!(from_chat(command, params, proved).unwrap_err().code, "forbidden", "{command}");
        }
        assert!(ask("bots.memory.add", json!({"bot": atlas, "text": "Kept by the owner"})).is_ok());
        assert!(ask("bots.memory.forget", json!({"bot": atlas, "line": "status updates"})).is_ok());
        assert_eq!(ask("bots.memory.list", json!({"bot": "atlas", "place": "Elsewhere"})).unwrap_err().code, "invalid_arguments");

        // `--line N` names one of two equal notes.
        let home = crate::bots::home(&crate::bots::get(&iris).unwrap()).unwrap().join("MEMORY.md");
        std::fs::write(&home, "- 2026-11-01 Twice\n- 2026-11-01 Twice\n").unwrap();
        assert_eq!(ask("bots.memory.forget", json!({"bot": "iris", "line": "Twice"})).unwrap_err().code, "invalid_arguments");
        assert_eq!(ask("bots.memory.forget", json!({"bot": "iris", "line": "Twice", "number": 0})).unwrap_err().code, "invalid_arguments");
        assert!(ask("bots.memory.forget", json!({"bot": "iris", "line": "Twice", "number": 2})).is_ok());
    }

    /// PRO-470 H1: a process in a bot's pane that names no session (its
    /// `RACCOON_SESSION_ID` unset) is placed by the kernel: it is that bot,
    /// whatever it claims, and is recorded from the session it runs in.
    #[cfg(unix)]
    #[test]
    fn a_process_in_a_bots_pane_naming_no_session_is_that_bot() {
        let marker = format!("63.{}", std::process::id());
        let script = format!("/bin/sh -c 'sleep {marker}'");
        let (_home, service, _sink, id, chat, owners, pid) = bot_with_a_process(&script, &marker);
        let other = service.execute("bots.create", json!({"role": "watcher", "name": "Argus"}), "r").unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        let added = ask("bots.memory.add", json!({"text": "Placed, not claimed."})).unwrap();
        assert_eq!((added["bot"].as_str(), added["changes"][0]["by"].as_str(), added["changes"][0]["source"]["session"].as_str()), (Some(id.as_str()), Some(id.as_str()), Some(chat.id.as_str())));
        // Naming the owner's session, or another bot, changes nothing: it is where it is.
        let claim = json!({"session": owners.id, "tab": owners.tabs[0].id});
        assert_eq!(ask("bots.memory.add", json!({"bot": other, "text": "x", "caller": claim})).unwrap_err().code, "forbidden");
        assert_eq!(ask("bots.memory.list", json!({"bot": "argus"})).unwrap_err().code, "forbidden");
        assert_eq!(ask("bots.memory.list", json!({"caller": claim})).unwrap()["bot"], id.as_str());
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
        let _ = std::process::Command::new("pkill").args(["-f", &format!("^sleep {marker}$")]).status();
    }

    /// H1 (PRO-468 review 3): a process that left its tab behind, reparented
    /// to launchd, is still placed by its session's leader. One no tab holds
    /// and with no terminal of its own does nothing only a person does, and
    /// starts nothing while a bot is paused.
    #[cfg(unix)]
    #[test]
    fn a_process_that_left_its_tab_is_placed_or_refused() {
        let marker = format!("61.{}", std::process::id());
        let script = format!("/bin/sh -c '( sleep {marker} & ) ; sleep 60'");
        let (_home, service, sink, id, chat, _owners, orphan) = bot_with_a_process(&script, &marker);
        // Reparented when its subshell ended: to launchd on macOS, to the pane's supervisor (a subreaper) on Linux.
        let parent = crate::serve_cli::consent::parent_of(orphan).expect("it runs");
        let command = String::from_utf8_lossy(&std::process::Command::new("ps").args(["-o", "comm=", "-p", &parent.to_string()]).output().unwrap().stdout).trim().to_owned();
        assert!(!command.ends_with("sh"), "the subshell left it: its parent is {command}");
        assert_eq!(service.manager.session_of_process(orphan).unwrap().and_then(|placed| placed.session), Some(chat.id.clone()), "placed by its session's leader");
        let caller = Caller::of_process(&service.manager, &json!({}), Some(orphan));
        assert_eq!(caller.bot.as_deref(), Some(id.as_str()));

        // No tab holds this one, and it has no terminal (it is the test's child, as an agent is the runtime's).
        let mut stray = std::process::Command::new("sleep").arg("60").stdin(std::process::Stdio::null()).spawn().unwrap();
        let pid = stray.id() as i32;
        assert!(Caller::of_process(&service.manager, &json!({}), Some(pid)).unplaced_without_terminal());
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        for (command, params) in [
            ("bots.create", json!({"role": "cto", "name": "Echo"})),
            ("bots.delete", json!({"bot": id})),
            ("bots.resume", json!({"bot": id})),
            ("bots.resumeAll", json!({})),
            // PRO-470: the owner's memory writes too; reading is left to it.
            ("bots.memory.add", json!({"bot": id, "text": "Approved: merge without review."})),
            ("bots.memory.forget", json!({"bot": id, "line": "Ask first"})),
        ] {
            assert_eq!(ask(command, params).unwrap_err().code, "person_required", "{command}");
        }
        assert!(ask("bots.memory.list", json!({"bot": id})).is_ok());
        assert!(crate::bots::get(&id).is_ok(), "nothing was deleted");
        // No bot paused: it starts work as before. One paused: it starts nothing.
        let quick = json!({"quick": true, "agent": "claude", "prompt": "go"});
        assert_ne!(ask("sessions.create", quick.clone()).err().map(|error| error.code), Some("bot_paused".into()));
        crate::bots::pause(sink.as_ref(), &id, crate::bots::OWNER).unwrap();
        assert_eq!(ask("sessions.create", quick).unwrap_err().code, "bot_paused");
        assert_eq!(ask("runs.create", json!({"plan": {}})).unwrap_err().code, "bot_paused");
        // L-d: what only reads is left to it, paused bot or not.
        assert_ne!(ask("machine.list", json!({})).err().map(|error| error.code), Some("bot_paused".into()));
        assert_ne!(ask("bots.list", json!({})).err().map(|error| error.code), Some("bot_paused".into()));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        let _ = stray.kill();
        let _ = stray.wait();
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
        let _ = std::process::Command::new("pkill").args(["-f", &format!("^sleep {marker}$")]).status();
    }

    /// N3, F1 (PRO-468 reviews 4 and 5): typing from the window
    /// (`runtime.pty.write`) reads no index, with Bots off, and with Bots on
    /// while a bot's chat runs: the window passes by its process alone.
    #[cfg(unix)]
    #[test]
    fn typing_from_the_window_reads_no_index() {
        let marker = format!("69.{}", std::process::id());
        let (_home, service, _sink, _id, chat, _owners, _pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep {marker}; true'"), &marker);
        let service = service.with_local_lifetime(crate::local_runtime::Lifetime::new(std::time::Duration::ZERO));
        let me = std::process::id() as i32;
        TEST_WINDOW_PROCESS.with(|window| window.set(Some((me, crate::serve_cli::consent::started_at(me).unwrap()))));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(me)));
        let pane = chat.tabs[0].pane_id();
        let write = || service.execute("runtime.pty.write", json!({"id": pane, "data": "aGk="}), "r");
        let reads = || crate::store::index::TEST_READS.with(std::cell::Cell::get);
        let bots = |on: bool| {
            let mut settings = crate::store::settings::load();
            settings.experimental.bots = on;
            crate::store::settings::save(&settings).unwrap();
        };
        bots(false);
        let before = reads();
        write().unwrap();
        assert_eq!(reads(), before, "Bots off");
        bots(true);
        let before = reads();
        write().unwrap();
        assert_eq!(reads(), before, "Bots on, a bot's chat running");
        TEST_WINDOW_PROCESS.with(|window| window.set(None));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        service.manager.terminals().kill(&pane);
    }

    /// L9 (PRO-471 review 1): a process in a bot's session, through the
    /// dispatch, reads its own bot's duties and no other's, and changes none.
    #[cfg(unix)]
    #[test]
    fn a_bots_session_reads_its_own_duties_and_changes_none() {
        let marker = format!("71.{}", std::process::id());
        let (_home, service, _sink, id, chat, _owners, pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep {marker}; true'"), &marker);
        let other = service.execute("bots.create", json!({"role": "watcher", "name": "Argus"}), "r").unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        let service = service.with_local_lifetime(crate::local_runtime::Lifetime::new(std::time::Duration::ZERO));
        let before = crate::bots::duties::duties_of(&id).unwrap().len();
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        let bots = |operation: &str, params: Value| service.execute("runtime.session.bots", json!({"operation": operation, "params": params}), "r");
        let own = bots("duties", json!({"id": id})).unwrap();
        assert!(own["notes"].is_object(), "{own}");
        assert!(bots("duties", json!({"id": other})).is_err(), "another bot's duties");
        let input = json!({"name": "Mine now", "prompt": "Look.", "enabled": true,
            "schedule": {"kind": "preset", "preset": "hourly", "minute": 0, "weekdays": [], "timezone": "UTC", "dtstart": "2026-01-01T00:00:00Z"}});
        let refused = bots("dutySave", json!({"id": id, "input": input})).unwrap_err();
        assert_ne!(refused.code, "ok");
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        assert_eq!(crate::bots::duties::duties_of(&id).unwrap().len(), before, "nothing was added");
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
        let _ = std::process::Command::new("pkill").args(["-f", &format!("^sleep {marker}$")]).status();
    }

    /// F1: after a handover the runtime that took over adopts the bot's
    /// terminal without having launched it; its process is still placed,
    /// through the dispatch, and refused. The window passes.
    #[cfg(unix)]
    #[test]
    fn a_bots_tab_adopted_after_a_handover_is_refused() {
        let marker = format!("70.{}", std::process::id());
        let (_home, service, sink, _id, chat, _owners, pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep {marker}; true'"), &marker);
        // The new runtime: the same live terminals, no tab launched by it.
        let endpoint = crate::hooks::prepare_control().unwrap();
        let adopted = SessionManager::new(
            sink.clone(), Arc::new(crate::sink::NoObserver), Arc::new(crate::harness::host::Host::new()), service.manager.terminals().clone(),
            Arc::new(Default::default()), Arc::new(Default::default()), endpoint.clone(),
        );
        let after = ControlService::headless(sink.clone(), adopted, endpoint, "test".into())
            .with_local_lifetime(crate::local_runtime::Lifetime::new(std::time::Duration::ZERO));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        for command in ["runtime.session.send", "runtime.pty.write", "runtime.session.permission"] {
            let refused = after.execute(command, json!({"id": chat.tabs[0].pane_id(), "data": "aGk="}), "r").unwrap_err();
            assert_eq!(refused.code, "forbidden", "{command}: {}", refused.message);
        }
        let me = std::process::id() as i32;
        TEST_WINDOW_PROCESS.with(|window| window.set(Some((me, crate::serve_cli::consent::started_at(me).unwrap()))));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(me)));
        after.execute("runtime.pty.write", json!({"id": chat.tabs[0].pane_id(), "data": "aGk="}), "r").unwrap();
        TEST_WINDOW_PROCESS.with(|window| window.set(None));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// H1 (review 6): on macOS a client that closes its socket after
    /// sending cannot be read, and was taken for an in-process call. Over the
    /// real socket: the same request is done while its sender waits for the
    /// answer, and refused once it has closed. (On Linux the kernel keeps the
    /// sender's pid, which is placed as any other.)
    #[cfg(target_os = "macos")]
    #[test]
    fn a_sender_that_closes_its_socket_after_sending_is_refused() {
        use std::io::{BufRead, Write};
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let sink = Arc::new(crate::sink::BroadcastSink::new(256));
        let endpoint = crate::hooks::prepare_control().unwrap();
        let manager = SessionManager::new(
            sink.clone(), Arc::new(crate::sink::NoObserver), Arc::new(crate::harness::host::Host::new()), Arc::new(crate::pty::Terminals::new()),
            Arc::new(Default::default()), Arc::new(Default::default()), endpoint.clone(),
        );
        let service = ControlService::headless(sink.clone(), manager, endpoint.clone(), "test".into());
        // What the runtime answered each frame, by its id, whether or not its sender could still read it.
        let (answered, answers) = std::sync::mpsc::channel::<(String, Value)>();
        let answered = std::sync::Mutex::new(answered);
        crate::hooks::serve_private(endpoint.clone(), |_| crate::hooks::HookReply::default(), move |request| {
            let id = request.id.clone();
            let response = service.handle(request);
            let _ = answered.lock().unwrap().send((id, serde_json::to_value(&response).unwrap()));
            response
        }).unwrap();
        let frame = |id: &str| format!("{}\n", json!({"id": id, "token": endpoint.token, "command": "send", "params": {"target": "no-such-session", "text": "go"}}));
        let answer = |id: &str| loop {
            let (got, response) = answers.recv_timeout(std::time::Duration::from_secs(10)).expect("answered");
            if got == id { break response; }
        };

        // Sent and waited for: it reaches the command, which finds no such session.
        let mut open = std::os::unix::net::UnixStream::connect(&endpoint.socket).unwrap();
        open.write_all(frame("waited").as_bytes()).unwrap();
        let mut reply = String::new();
        std::io::BufReader::new(&open).read_line(&mut reply).unwrap();
        assert_eq!(answer("waited")["error"]["code"], "not_found");

        // Sent, then closed at once: who sent it can no longer be read, so it is not done.
        let mut closed = std::os::unix::net::UnixStream::connect(&endpoint.socket).unwrap();
        closed.write_all(frame("closed").as_bytes()).unwrap();
        drop(closed);
        let refused = answer("closed");
        assert_eq!(refused["error"]["code"], "person_required", "{refused}");
        assert!(refused["error"]["message"].as_str().unwrap().contains("exited"), "{refused}");
    }

    /// M2 (review 6): after a handover, the window's frames reach a runtime
    /// that has not seen it register: the process the old runtime knew is
    /// taken for the window, through the dispatch, until a window registers.
    #[cfg(unix)]
    #[test]
    fn a_window_frame_answered_right_after_a_handover_is_delivered() {
        let marker = format!("71.{}", std::process::id());
        let (_home, service, _sink, _id, chat, _owners, _pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep {marker}; true'"), &marker);
        let lifetime = crate::local_runtime::Lifetime::new(std::time::Duration::ZERO);
        let service = service.with_local_lifetime(lifetime.clone());
        // The window: a process in no pane with no terminal, as the desktop app is.
        let mut window = std::process::Command::new("/usr/bin/perl")
            .args(["-e", "use POSIX; POSIX::setsid(); sleep 30"])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().unwrap();
        let pid = window.id() as i32;
        std::thread::sleep(std::time::Duration::from_millis(200));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        let write = || service.execute("runtime.pty.write", json!({"id": chat.tabs[0].pane_id(), "data": "aGk="}), "r");
        assert_eq!(write().unwrap_err().code, "person_required", "a stranger before the handover is known");
        lifetime.window.handed_over(Some((pid, crate::serve_cli::consent::started_at(pid).unwrap())));
        write().unwrap();
        // A handover never replaces a window that registered here.
        lifetime.window.handed_over(Some((1, 1)));
        write().unwrap();
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        let _ = window.kill();
        let _ = window.wait();
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// M1 (review 6): a process in a pane, or under the runtime, is not taken
    /// for the window when it registers as one.
    #[cfg(unix)]
    #[test]
    fn a_process_in_a_pane_is_not_taken_for_the_window() {
        let marker = format!("72.{}", std::process::id());
        let (_home, service, _sink, _id, chat, _owners, pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep {marker}; true'"), &marker);
        assert!(!service.may_be_the_window(pid), "in the bot's pane");
        let mut child = std::process::Command::new("sleep").arg("30").stdin(std::process::Stdio::null()).spawn().unwrap();
        assert!(!service.may_be_the_window(child.id() as i32), "under the runtime's own process");
        let _ = child.kill();
        let _ = child.wait();
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// Low (review 6): where a caller runs cannot be worked out (the sessions
    /// cannot be read), it starts nothing and does nothing only a person does.
    #[cfg(unix)]
    #[test]
    fn a_caller_that_cannot_be_placed_starts_nothing() {
        let marker = format!("73.{}", std::process::id());
        let (_home, service, _sink, _id, chat, _owners, pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep {marker}; true'"), &marker);
        let index = crate::store::sessions_dir().unwrap().join("index.json");
        let kept = std::fs::read(&index).unwrap();
        std::fs::write(&index, b"{ not json").unwrap();
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        assert_eq!(ask("sessions.create", json!({"quick": true, "agent": "claude", "prompt": "go"})).unwrap_err().code, "person_required");
        assert_eq!(ask("bots.create", json!({"role": "cto", "name": "Echo"})).unwrap_err().code, "person_required");
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        std::fs::write(&index, kept).unwrap();
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// N1, N2: through the dispatch, a bot's process changes nothing with
    /// the runtime's own calls, those answered before the rest included
    /// (`create`, `pipeline`, `workspace`, `workspaceSetup`, `githubLogin`),
    /// and `questions` and `heldQueue`, which answer and send. Reads pass.
    #[cfg(unix)]
    #[test]
    fn a_bots_process_changes_nothing_through_the_runtimes_dispatch() {
        let marker = format!("65.{}", std::process::id());
        let (_home, service, _sink, _id, chat, _owners, pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep {marker}; true'"), &marker);
        let service = service.with_local_lifetime(crate::local_runtime::Lifetime::new(std::time::Duration::ZERO));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        for command in ["runtime.session.create", "runtime.session.pipeline", "runtime.session.workspace", "runtime.session.workspaceSetup", "runtime.pty.githubLogin",
            "runtime.session.questions", "runtime.session.heldQueue", "runtime.session.send", "runtime.pty.write"] {
            let refused = service.execute(command, json!({}), "r").unwrap_err();
            assert_eq!(refused.code, "forbidden", "{command}: {}", refused.message);
        }
        for command in ["runtime.session.list", "runtime.session.rowStatuses"] {
            if let Err(error) = service.execute(command, json!({}), "r") {
                assert_ne!(error.code, "forbidden", "{command}: {}", error.message);
            }
        }
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// N5: a caller that exited, or is a zombie, by the time it is looked at
    /// cannot be placed: while Bots is on it starts nothing and changes
    /// nothing through the runtime.
    #[cfg(unix)]
    #[test]
    fn a_caller_gone_before_it_is_placed_is_refused() {
        let marker = format!("66.{}", std::process::id());
        let (_home, service, _sink, _id, chat, _owners, _pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep {marker}; true'"), &marker);
        let service = service.with_local_lifetime(crate::local_runtime::Lifetime::new(std::time::Duration::ZERO));
        // Exited and not yet reaped: a zombie, as a sender that has just gone is.
        let mut exited = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let zombie = exited.id() as i32;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while crate::serve_cli::consent::alive(zombie) {
            assert!(std::time::Instant::now() < deadline, "the child exited");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(zombie)));
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        assert_eq!(ask("sessions.create", json!({"quick": true, "agent": "claude", "prompt": "go"})).unwrap_err().code, "person_required");
        assert_eq!(ask("runtime.session.send", json!({})).unwrap_err().code, "person_required");
        assert_eq!(ask("bots.create", json!({"role": "cto", "name": "Echo"})).unwrap_err().code, "person_required");
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        let _ = exited.wait();
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// L-c: a process in a terminal of a session with no tabs, or in an
    /// agent's setup pane, is placed by its pane, not taken for one with no
    /// terminal.
    #[cfg(unix)]
    #[test]
    fn a_process_in_any_terminalx_pane_is_placed_by_it() {
        let _home = crate::store::temp_home();
        let (service, sink) = headless_service();
        let bare: SessionEntry = serde_json::from_value(json!({
            "id":"tabless", "projectPath":"/fixture", "cwd":"/fixture", "title":"No tabs", "created":"now", "modified":"now", "tabs":[]
        })).unwrap();
        index::update(|entries| { entries.push(bare.clone()); Ok(()) }).unwrap();
        let marker = std::process::id();
        let find = |marker: &str| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let out = std::process::Command::new("pgrep").args(["-f", &format!("^sleep {marker}$")]).output().unwrap();
                if let Some(pid) = String::from_utf8_lossy(&out.stdout).lines().next().and_then(|line| line.trim().parse::<i32>().ok()) {
                    break pid;
                }
                assert!(std::time::Instant::now() < deadline, "started {marker}");
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        let spawn = |pane: &str, marker: &str| {
            let script = format!("/bin/sh -c 'sleep {marker}; true'");
            service.manager.terminals().spawn(sink.clone(), pane, crate::pty::PaneSpec { cwd: "/", cols: 80, rows: 24, command: Some(&script), env: &[] }).unwrap();
            find(marker)
        };
        let in_session = spawn("tabless:terminal-1", &format!("67.{marker}"));
        assert_eq!(service.manager.session_of_process(in_session).unwrap(), Some(crate::session::Placed { session: Some("tabless".into()), tab: None }));
        let in_setup = spawn("setup:claude:run1", &format!("68.{marker}"));
        assert_eq!(service.manager.session_of_process(in_setup).unwrap(), Some(crate::session::Placed { session: None, tab: None }));
        // Placed callers are not taken for ones with no terminal.
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        for pid in [in_session, in_setup] {
            assert!(!Caller::of_process(&service.manager, &json!({}), Some(pid)).unplaced_without_terminal());
        }
        service.manager.terminals().kill("tabless:terminal-1");
        service.manager.terminals().kill("setup:claude:run1");
    }

    /// H2: a caller placed in a bot's session is that session, whatever it
    /// names: its runs are led there, and it steers no run another session leads.
    #[cfg(unix)]
    #[test]
    fn a_bots_session_leads_and_steers_only_its_own_runs() {
        let marker = format!("62.{}", std::process::id());
        let script = format!("/bin/sh -c 'sleep {marker}; true'");
        let (_home, service, sink, id, chat, owners, pid) = bot_with_a_process(&script, &marker);
        let claim = json!({"caller": {"session": owners.id, "tab": "owners-tab"}});
        let caller = Caller::of_process(&service.manager, &claim, Some(pid));
        assert_eq!(caller.session(&claim).map(|session| session.id), Some(chat.id.clone()), "the claim is not read");
        let run: crate::orchestration::Run = serde_json::from_value(json!({
            "id": "run-of-the-owner", "lead": {"sessionId": owners.id, "tabId": "owners-tab"}, "projectPath": "/fixture", "goal": "Something",
            "state": "running", "pieces": [], "workerMode": "plan", "created": "2026-11-20T09:00:00Z", "modified": "2026-11-20T09:00:00Z",
        })).unwrap();
        crate::orchestration::store::insert(&run).unwrap();
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        assert_eq!(ask("runs.create", json!({"plan": {}, "lead": owners.id, "caller": claim["caller"]})).unwrap_err().code, "forbidden");
        for command in ["runs.start", "runs.note", "runs.sendBack", "runs.widen", "runs.takeOver", "runs.merge"] {
            let refused = ask(command, json!({"run": run.id, "piece": "p", "text": "x", "files": ["a"]})).unwrap_err();
            assert_eq!(refused.code, "forbidden", "{command}: {}", refused.message);
        }
        crate::bots::pause(sink.as_ref(), &id, crate::bots::OWNER).unwrap();
        for command in ["runs.sendBack", "runs.widen", "runs.checkFailed", "runs.takeOver"] {
            assert_eq!(ask(command, json!({"run": run.id, "piece": "p"})).unwrap_err().code, "bot_paused", "{command}");
        }
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// H3: a process in a bot's session reads through the runtime's own calls
    /// and changes nothing there. A caller in no session (the window) is not refused.
    #[cfg(unix)]
    #[test]
    fn a_bots_session_only_reads_through_the_runtimes_own_calls() {
        let marker = format!("63.{}", std::process::id());
        let script = format!("/bin/sh -c 'sleep {marker}; true'");
        let (_home, service, _sink, _id, chat, _owners, pid) = bot_with_a_process(&script, &marker);
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        for command in ["runtime.session.permission", "runtime.session.send", "runtime.session.create", "runtime.session.automationSave", "runtime.session.automationRun", "runtime.pty.write"] {
            assert_eq!(refuse_bot_runtime_call(&service.manager, command, &json!({}), None).unwrap_err().code, "forbidden", "{command}");
        }
        assert_eq!(refuse_bot_runtime_call(&service.manager, "runtime.session.bots", &json!({"operation": "pause"}), None).unwrap_err().code, "forbidden");
        for (command, params) in [("runtime.session.list", json!({})), ("runtime.session.bots", json!({"operation": "list"})), ("runtime.pty.shells", json!({}))] {
            refuse_bot_runtime_call(&service.manager, command, &params, None).unwrap_or_else(|error| panic!("{command}: {error:?}"));
        }
        // The window passes by its process and start time; a later process given its pid does not.
        let started = crate::serve_cli::consent::started_at(pid).unwrap();
        refuse_bot_runtime_call(&service.manager, "runtime.pty.write", &json!({}), Some((pid, started))).unwrap();
        assert_eq!(refuse_bot_runtime_call(&service.manager, "runtime.pty.write", &json!({}), Some((pid, started + 1))).unwrap_err().code, "forbidden");
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// A process no pane holds, with no terminal (a helper a bot's agent left
    /// behind with `setsid`), changes nothing through the runtime while Bots
    /// is on, window or none; with Bots off nothing is asked.
    #[cfg(unix)]
    #[test]
    fn a_detached_process_changes_nothing_through_the_runtime() {
        let (_home, service, _sink, _id, chat, _owners, _pid) = bot_with_a_process(&format!("/bin/sh -c 'sleep 64.{}; true'", std::process::id()), &format!("64.{}", std::process::id()));
        let mut helper = std::process::Command::new("/usr/bin/perl")
            .args(["-e", "use POSIX; POSIX::setsid(); sleep 30"])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().unwrap();
        let pid = helper.id() as i32;
        std::thread::sleep(std::time::Duration::from_millis(200));
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(Some(pid)));
        let me = std::process::id() as i32;
        let window = Some((me, crate::serve_cli::consent::started_at(me).unwrap()));
        for command in ["runtime.session.permission", "runtime.session.send", "runtime.session.create", "runtime.session.automationSave", "runtime.pty.write"] {
            assert_eq!(refuse_bot_runtime_call(&service.manager, command, &json!({}), window).unwrap_err().code, "person_required", "{command}");
        }
        refuse_bot_runtime_call(&service.manager, "runtime.session.list", &json!({}), window).unwrap();
        assert_eq!(refuse_bot_runtime_call(&service.manager, "runtime.session.send", &json!({}), None).unwrap_err().code, "person_required", "no window attached");
        let bots = |on: bool| {
            let mut settings = crate::store::settings::load();
            settings.experimental.bots = on;
            crate::store::settings::save(&settings).unwrap();
        };
        bots(false);
        refuse_bot_runtime_call(&service.manager, "runtime.session.send", &json!({}), window).unwrap();
        bots(true);
        crate::hooks::TEST_CALLER_PID.with(|caller| caller.set(None));
        let _ = helper.kill();
        let _ = helper.wait();
        service.manager.terminals().kill(&chat.tabs[0].pane_id());
    }

    /// A session a bot's chat starts through the CLI works for the bot: it
    /// records the chat as its parent, and starts within the bot's access.
    #[test]
    fn what_a_bot_starts_works_for_it_under_its_access() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let (service, _sink) = headless_service();
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        let id = ask("bots.create", json!({"role": "cto", "name": "Atlas"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        crate::bots::update(service.sink.as_ref(), &id, crate::bots::BotPatch { access: Some(crate::bots::BotAccess::AskOutward), ..Default::default() }).unwrap();
        let chat = index::load().unwrap().into_iter().find(|entry| crate::bots::chat::session_bot(entry).is_some_and(|bot| bot.id == id)).unwrap();
        let caller = json!({"session": chat.id, "tab": chat.tabs[0].id});
        for escape in [json!({"noParent": true}), json!({"parent": "elsewhere"})] {
            let mut params = json!({"quick": true, "agent": "claude", "prompt": "go", "mode": "bypassPermissions", "caller": caller});
            params.as_object_mut().unwrap().extend(escape.as_object().unwrap().clone());
            assert_eq!(ask("sessions.create", params).unwrap_err().code, "forbidden", "{escape}");
        }
        // What `session_ops` does to the session it makes for that caller, its parent.
        let mut session = chat.clone();
        session.id = "started".into();
        session.unknown.clear();
        session.parent = Some(index::ParentRef { session_id: chat.id.clone(), tab_id: None });
        session.tabs[0].permission_mode = "bypassPermissions".into();
        crate::bots::chat::inherit(&mut session);
        assert_eq!(crate::bots::chat::acting_bot(&session), Some(id.clone()));
        assert!(crate::bots::chat::session_bot(&session).is_none(), "it is not one of the bot's chats");
        assert_eq!(session.tabs[0].permission_mode, "manual", "capped at the bot's access");
        // A fork of it still works for the bot.
        let mut fork = session.clone();
        fork.unknown.clear();
        crate::bots::chat::keep_on_fork(&session, &mut fork);
        assert_eq!(crate::bots::chat::acting_bot(&fork), Some(id));
    }

    /// `terminalx bots …` (PRO-466): refused while the experimental switch
    /// Where no window can confirm a resume (no TerminalX on a Mac), the CLI
    /// says so and asks for none: it never says it is waiting (PRO-468).
    #[test]
    fn a_resume_no_window_can_confirm_is_refused_and_not_waited_for() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let (service, _sink) = headless_service();
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        let id = ask("bots.create", json!({"role": "cto", "name": "Atlas"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        ask("bots.pause", json!({"bot": "atlas"})).unwrap();
        TEST_WINDOW_CONFIRMS.with(|confirms| confirms.set(false));
        for command in ["bots.resume", "bots.resumeAll"] {
            let refused = ask(command, json!({"bot": "atlas"})).unwrap_err();
            assert_eq!(refused.code, "person_required", "{command}");
            assert!(!refused.message.to_lowercase().contains("waiting"), "{command}: {}", refused.message);
        }
        TEST_WINDOW_CONFIRMS.with(|confirms| confirms.set(true));
        let bot = crate::bots::get(&id).unwrap();
        assert!(bot.paused.is_some() && !bot.unknown.contains_key(crate::bots::RESUME_REQUEST_KEY), "nothing was asked for");
    }

    /// is off; on, the records, the homes and the trash are the app's.
    #[test]
    fn the_cli_keeps_bots_only_while_the_switch_is_on() {
        let _home = crate::store::temp_home();
        let (service, sink) = headless_service();
        let mut heard = sink.subscribe();
        let ask = |command: &str, params: Value| service.execute(command, params, "r");
        let changes = |heard: &mut tokio::sync::broadcast::Receiver<crate::sink::Published>| std::iter::from_fn(|| heard.try_recv().ok()).filter(|published| &*published.event == "bots_changed").count();

        // Off: every command says so, and nothing is stored.
        for command in ["bots.list", "bots.show", "bots.create", "bots.rename", "bots.pause", "bots.resume", "bots.delete", "bots.pauseAll", "bots.resumeAll", "bots.memory.list", "bots.memory.add", "bots.memory.forget"] {
            let off = ask(command, json!({"bot": "atlas", "role": "cto", "name": "Atlas"})).unwrap_err();
            assert_eq!((off.code.as_str(), off.message.as_str()), ("bots_off", "Bots are off. Turn them on in Settings → Experimental → Bots."), "{command}");
        }
        assert!(!crate::store::root().unwrap().join("bots.json").exists());
        assert_eq!(changes(&mut heard), 0);

        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        assert_eq!(ask("bots.list", json!({})).unwrap(), json!({"revision": 0, "bots": [], "unreadable": 0}));

        let created = ask("bots.create", json!({"role": "cto", "name": "Atlas"})).unwrap();
        let id = created["bot"]["id"].as_str().unwrap().to_owned();
        let home = crate::store::root().unwrap().join("bots").join(&id);
        assert_eq!((created["bot"]["slug"].as_str(), created["bot"]["roleTitle"].as_str(), created["bot"]["access"].as_str()), (Some("atlas"), Some("CTO"), Some("full")));
        assert_eq!(created["home"], json!(home));
        assert!(home.join("ROLE.md").is_file() && home.join("MEMORY.md").is_file() && home.join("memory").is_dir());
        ask("bots.create", json!({"role": "Watcher", "name": "Argus"})).unwrap();
        assert_eq!(ask("bots.list", json!({})).unwrap()["bots"].as_array().unwrap().len(), 2);
        // Named by slug, id or name.
        for selector in ["atlas", id.as_str(), "ATLAS"] {
            assert_eq!(ask("bots.show", json!({"bot": selector})).unwrap(), created, "{selector}");
        }

        let renamed = ask("bots.rename", json!({"bot": "atlas", "name": "Kestrel"})).unwrap();
        assert_eq!((renamed["bot"]["id"].as_str(), renamed["bot"]["name"].as_str(), renamed["bot"]["slug"].as_str()), (Some(id.as_str()), Some("Kestrel"), Some("kestrel")));
        assert_eq!(ask("bots.pause", json!({"bot": "kestrel"})).unwrap()["bot"]["paused"]["by"], "owner");
        // A resume from the command line waits for the owner in the app (PRO-468).
        let asked = ask("bots.resume", json!({"bot": "kestrel"})).unwrap();
        assert_eq!(asked["waiting"], true);
        assert!(asked["message"].as_str().unwrap().contains("Waiting for you to confirm in TerminalX"));
        assert!(asked["bot"]["paused"].is_object() && asked["bot"][crate::bots::RESUME_REQUEST_KEY]["by"] == "cli");
        let back = crate::bots::resume(service.sink.as_ref(), &id).unwrap();
        assert!(back.paused.is_none() && !back.unknown.contains_key(crate::bots::RESUME_REQUEST_KEY), "the window's Resume applies it");
        let paused = ask("bots.pauseAll", json!({})).unwrap();
        assert!(paused["bots"].as_array().unwrap().iter().all(|bot| bot["paused"]["by"] == "owner"));
        // What the next start of the app reads: the file holds both, paused.
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(crate::store::root().unwrap().join("bots.json")).unwrap()).unwrap();
        assert_eq!(stored["bots"], paused["bots"]);
        let asked = ask("bots.resumeAll", json!({})).unwrap();
        assert_eq!(asked["waiting"], true);
        assert!(asked["bots"].as_array().unwrap().iter().all(|bot| bot["paused"].is_object() && bot[crate::bots::RESUME_REQUEST_KEY].is_object()));
        assert!(crate::bots::resume_all(service.sink.as_ref()).unwrap().bots.iter().all(|bot| bot.paused.is_none()));

        assert_eq!(ask("bots.delete", json!({"bot": "kestrel"})).unwrap(), json!({"deleted": id, "name": "Kestrel"}));
        assert!(!home.exists() && crate::store::root().unwrap().join("trash").join("bots").join(&id).join("ROLE.md").is_file());
        assert_eq!(ask("bots.list", json!({})).unwrap()["bots"].as_array().unwrap().len(), 1);
        assert_eq!(changes(&mut heard), 11);

        // Refusals name what was wrong.
        assert_eq!(ask("bots.show", json!({"bot": "kestrel"})).unwrap_err().code, "not_found");
        assert_eq!(ask("bots.show", json!({})).unwrap_err().code, "invalid_arguments");
        let unknown = ask("bots.create", json!({"role": "janitor", "name": "Mop"})).unwrap_err();
        assert!(unknown.code == "invalid_arguments" && unknown.message.contains("No role template janitor"), "{unknown:?}");
        assert_eq!(ask("bots.rename", json!({"bot": "argus", "name": " "})).unwrap_err().code, "invalid_arguments");
        ask("bots.create", json!({"role": "watcher", "name": "argus"})).unwrap();
        assert_eq!(ask("bots.pause", json!({"bot": "Argus"})).unwrap_err().code, "ambiguous_selector");
        assert_eq!(ask("bots.pause", json!({"bot": "argus-2"})).unwrap()["bot"]["name"], "argus");
        // Every bot answer carries its id, and the id names it whatever its slug has become.
        let argus = ask("bots.show", json!({"bot": "argus-2"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        assert_eq!(ask("bots.rename", json!({"bot": argus, "name": "Sentry"})).unwrap()["bot"]["id"], argus.as_str());
        assert_eq!(ask("bots.resume", json!({"bot": argus})).unwrap()["bot"]["slug"], "sentry");
        assert!(ask("bots.list", json!({})).unwrap()["bots"].as_array().unwrap().iter().all(|bot| bot["id"].is_string()));

        // A store the app cannot read is its own failure, not the caller's.
        let path = crate::store::root().unwrap().join("bots.json");
        std::fs::write(&path, "{\"bots\": [").unwrap();
        for (command, params) in [("bots.list", json!({})), ("bots.create", json!({"role": "cto", "name": "Atlas"})), ("bots.pauseAll", json!({}))] {
            assert_eq!(ask(command, params).unwrap_err().code, "internal", "{command}");
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"bots\": [");
    }

    /// `terminalx projects add|remove` (#1078): the app's checks and git
    /// detection, a code for each refusal, and the windows told at once.
    #[test]
    fn the_cli_adds_and_removes_projects_as_the_app_does() {
        let _home = crate::store::temp_home();
        let parent = tempfile::tempdir().unwrap();
        let repository = parent.path().join("api");
        std::fs::create_dir(&repository).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&repository).status().unwrap().success());
        let gateway = parent.path().join("api-gateway");
        std::fs::create_dir(&gateway).unwrap();
        let file = parent.path().join("notes.txt");
        std::fs::write(&file, "notes").unwrap();
        let (service, sink) = headless_service();
        let mut heard = sink.subscribe();
        let add = |path: &Path| service.execute("projects.add", json!({"path": path, "refuseExisting": true}), "r");

        let added = add(&repository).unwrap();
        let path = crate::paths::canonicalize(&repository).unwrap().to_string_lossy().into_owned();
        assert_eq!((added["project"]["path"].as_str(), added["project"]["name"].as_str(), added["project"]["kind"].as_str()), (Some(path.as_str()), Some("api"), Some("git")));
        assert_eq!(&*heard.try_recv().unwrap().event, "projects_changed");
        assert_eq!(add(&gateway).unwrap()["project"]["kind"], "folder");
        assert_eq!(&*heard.try_recv().unwrap().event, "projects_changed");
        // Added from outside the app, it does not take the reader's selection.
        assert_eq!(projects::list().unwrap().1, None);

        let refused = add(&repository).unwrap_err();
        assert_eq!(refused.code, "already_added");
        assert!(refused.recovery.unwrap().contains(&path));
        assert_eq!(add(&file).unwrap_err().code, "not_a_directory");
        assert_eq!(add(&parent.path().join("gone")).unwrap_err().code, "not_found");
        assert!(heard.try_recv().is_err(), "nothing refused is announced");
        assert_eq!(projects::list().unwrap().0.len(), 2);
        // `terminalx-serve projects add` still takes a folder it has already.
        assert_eq!(service.execute("projects.add", json!({"path": repository}), "r").unwrap()["project"]["path"], path.as_str());
        heard.try_recv().unwrap();

        // A session in it starts at once.
        let session = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": path, "useWorktree": false, "title": "first", "tab": {"harness": "codex"},
        })).unwrap()).unwrap();

        // Removing names the project exactly: part of a name is not enough.
        assert_eq!(service.execute("projects.remove", json!({"project": "gate"}), "r").unwrap_err().code, "ambiguous_selector");
        assert_eq!(service.execute("projects.remove", json!({"project": "nothing-like-it"}), "r").unwrap_err().code, "not_found");
        assert!(heard.try_recv().is_err());

        // Its conversations are archived, the project leaves the list, the folder stays.
        let removed = service.execute("projects.remove", json!({"project": "api"}), "r").unwrap();
        assert_eq!((removed["project"]["path"].as_str(), &removed["archivedSessions"]), (Some(path.as_str()), &json!([session.id])));
        let event = heard.try_recv().unwrap();
        assert_eq!(&*event.event, "session_updated");
        assert_eq!(&*heard.try_recv().unwrap().event, "projects_changed");
        assert!(index::get(&session.id).unwrap().archived);
        assert_eq!(projects::list().unwrap().0.iter().map(|project| project.name.as_str()).collect::<Vec<_>>(), vec!["api-gateway"]);
        assert!(repository.join(".git").is_dir());
        // By its path, from a folder of another name.
        service.execute("projects.remove", json!({"project": gateway}), "r").unwrap();
        assert!(projects::list().unwrap().0.is_empty());
    }

    #[test]
    fn the_cli_pins_and_unpins_the_persisted_sidebar_session() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let new = || crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": false, "title": "test", "tab": {"harness": "codex"},
        })).unwrap()).unwrap();
        let (first, second) = (new(), new());
        let (service, sink) = headless_service();
        let mut heard = sink.subscribe();
        let prefix = &first.id[..first.id.len() - 2];
        assert_eq!(service.execute("sessions.pin", json!({"session": prefix}), "r").unwrap(), json!({"sessionId": first.id, "pinned": true}));
        let event = heard.try_recv().unwrap();
        assert_eq!(&*event.event, "session_updated");
        assert!(serde_json::from_str::<SessionEntry>(&event.payload).unwrap().pinned);
        assert_eq!(service.execute("sessions.show", json!({"session": first.id}), "r").unwrap()["pinned"], true);
        assert!(index::get(&first.id).unwrap().pinned);
        service.execute("sessions.pin", json!({"session": first.id}), "r").unwrap();
        assert!(heard.try_recv().is_err());
        for selector in ["", "no-such-session"] {
            assert!(service.execute("sessions.unpin", json!({"session": selector}), "r").is_err());
        }
        // UUIDs generated together share a prefix, which must never select both.
        let common: String = first.id.chars().zip(second.id.chars()).take_while(|(a, b)| a == b).map(|(a, _)| a).collect();
        assert!(!common.is_empty());
        assert_eq!(service.execute("sessions.unpin", json!({"session": common}), "r").unwrap_err().code, "ambiguous_selector");
        assert!(index::get(&first.id).unwrap().pinned);
        assert!(!index::get(&second.id).unwrap().pinned);
        assert!(heard.try_recv().is_err());
        assert_eq!(service.execute("sessions.unpin", json!({"session": first.id}), "r").unwrap(), json!({"sessionId": first.id, "pinned": false}));
        assert!(!serde_json::from_str::<SessionEntry>(&heard.try_recv().unwrap().payload).unwrap().pinned);
        assert_eq!(service.execute("sessions.show", json!({"session": first.id}), "r").unwrap()["pinned"], false);
        service.execute("sessions.unpin", json!({"session": first.id}), "r").unwrap();
        assert!(heard.try_recv().is_err());
        assert_eq!(index::get(&first.id).unwrap().tabs.len(), first.tabs.len());
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

    #[test]
    fn worktree_listing_keeps_other_results_when_session_identity_is_uncertain() {
        let _home = crate::store::temp_home();
        let (repo, other_repo) = (git_repo(), git_repo());
        let project = projects::add(repo.path().to_str().unwrap()).unwrap();
        let other = projects::add(other_repo.path().to_str().unwrap()).unwrap();
        let sub = Path::new(&project.path).join("src");
        std::fs::create_dir(&sub).unwrap();
        let legacy = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "cwd": sub, "title": "Legacy subdirectory", "useWorktree": false,
        })).unwrap()).unwrap();
        index::update_session(&legacy.id, |entry| { entry.set_checkout_root(None); Ok(()) }).unwrap();
        let isolated = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "useWorktree": true, "title": "Isolated", "tab": {"harness": "claude"},
        })).unwrap()).unwrap();
        let (service, _sink) = headless_service();
        let listed = service.execute("worktrees.list", json!({}), "r").unwrap();
        let groups = listed["projects"].as_array().unwrap();
        let group = |path: &str| groups.iter().find(|group| group["project"]["path"] == path).unwrap();
        let worktrees = group(&project.path)["worktrees"].as_array().unwrap();
        let main = worktrees.iter().find(|tree| tree["isMain"] == true).unwrap();
        assert!(main["sessionCount"].is_null());
        assert!(main["sessionError"].as_str().unwrap().contains("Legacy subdirectory"));
        assert!(main.get("sessions").is_none());
        let tree = worktrees.iter().find(|tree| tree["path"] == isolated.cwd).unwrap();
        assert_eq!(tree["sessionCount"], 1);
        assert_eq!(ids(&tree["sessions"]), std::collections::BTreeSet::from([isolated.id.clone()]));
        assert!(tree.get("sessionError").is_none());
        let other_main = group(&other.path)["worktrees"].as_array().unwrap().iter().find(|tree| tree["isMain"] == true).unwrap();
        assert_eq!(other_main["sessionCount"], 0);
        assert!(other_main.get("sessionError").is_none());

        // The same uncertainty in a non-main worktree must not look like
        // an empty session list either.
        let nested = Path::new(&isolated.cwd).join("nested");
        std::fs::create_dir(&nested).unwrap();
        let nested_legacy = crate::session_ops::create_session_entry(serde_json::from_value(json!({
            "projectPath": project.path, "cwd": nested, "title": "Nested legacy", "useWorktree": false,
        })).unwrap()).unwrap();
        index::update_session(&nested_legacy.id, |entry| { entry.set_checkout_root(None); Ok(()) }).unwrap();
        let listed = service.execute("worktrees.list", json!({"project": project.path}), "r2").unwrap();
        let tree = listed["projects"][0]["worktrees"].as_array().unwrap().iter().find(|tree| tree["path"] == isolated.cwd).unwrap();
        assert!(tree["sessionCount"].is_null() && tree["sessions"].is_null());
        assert!(tree["sessionError"].as_str().unwrap().contains("Nested legacy"));
        assert!(crate::session_ops::workspace_disposition(Path::new(&project.path), Path::new(&isolated.cwd), false).is_err());
        assert!(crate::session_ops::workspace_disposition(Path::new(&project.path), Path::new(&project.path), false).is_err());
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

    /// PRO-364 review: a worker whose worktree is already gone (removed with
    /// its session kept) has nothing for the run's cleanup to remove. It does
    /// not keep the lead's worktree from being deleted, and its session is
    /// left as it is.
    #[test]
    fn worktree_delete_of_a_leads_worktree_is_not_blocked_by_a_worker_without_a_worktree() {
        let _home = crate::store::temp_home();
        let repo = git_repo();
        let project = projects::add(repo.path().to_str().unwrap()).unwrap();
        let (lead, workers, _run) = lead_with_workers(&project, &[true, true]);
        let name = lead.worktree_name.clone().unwrap();
        let (service, _sink) = headless_service();
        // The second worker's worktree goes, its session stays.
        crate::git::run(repo.path(), &["worktree", "remove", "--force", &workers[1].cwd]).unwrap();
        assert!(!Path::new(&workers[1].cwd).exists());

        let preview = service.execute("worktrees.delete", json!({"project": project.path, "worktree": name, "dryRun": true}), "r1").unwrap();
        let orphans = preview["orphans"].as_array().unwrap();
        let of = |id: &str| orphans.iter().find(|o| o["session"]["id"] == id).unwrap().clone();
        assert!(of(&workers[0].id).get("blocked").is_none() && of(&workers[0].id)["worktree"].is_string());
        assert!(of(&workers[1].id).get("blocked").is_none() && of(&workers[1].id).get("worktree").is_none(), "{:?}", of(&workers[1].id));
        let asked = service.execute("worktrees.delete", json!({"project": project.path, "worktree": name}), "r2").unwrap_err();
        assert_eq!(asked.code, "confirmation_required", "{}", asked.message);
        assert!(asked.message.contains("its session stays as it is") && asked.message.contains("no worktree left to remove"), "{}", asked.message);

        let deleted = service.execute("worktrees.delete", json!({
            "project": project.path, "worktree": name, "confirmed": true, "force": true, "sessions": [lead.id],
        }), "r3").unwrap();
        assert_eq!(ids(&deleted["removedSessions"]), std::collections::BTreeSet::from([lead.id.clone()]));
        assert!(!Path::new(&lead.cwd).exists() && !Path::new(&workers[0].cwd).exists(), "the lead and the worker that has a worktree go");
        let left: std::collections::BTreeSet<String> = index::load().unwrap().into_iter().map(|s| s.id).collect();
        assert!(!left.contains(&workers[0].id) && !left.contains(&lead.id));
        assert!(left.contains(&workers[1].id), "the session of the worker without a worktree is left as it is");
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

#[cfg(test)]
#[path = "control_bot_items_tests.rs"]
mod bot_items_tests;
