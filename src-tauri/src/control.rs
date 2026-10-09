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

    fn invalid(message: impl Into<String>) -> Self {
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
    /// Computer use and the built-in browser; the headless runtime has neither.
    #[cfg(feature = "desktop")]
    desktop: Option<DesktopControl>,
}

#[cfg(feature = "desktop")]
#[derive(Clone)]
struct DesktopControl {
    pairing: Option<Arc<crate::pairing::PairingManager>>,
    computer: Arc<crate::computer::ComputerService>,
    browser: std::sync::Arc<crate::browser::BrowserRuntime>,
}

impl ControlService {
    #[cfg(feature = "desktop")]
    pub fn new(
        sink: Arc<dyn EventSink>,
        manager: SessionManager,
        endpoint: ControlEndpoint,
        computer: Arc<crate::computer::ComputerService>,
        browser: std::sync::Arc<crate::browser::BrowserRuntime>,
    ) -> Self {
        Self {
            sink,
            manager,
            endpoint,
            runtime_kind: None,
            desktop: Some(DesktopControl { computer, browser, pairing: None }),
        }
    }

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
            #[cfg(feature = "desktop")]
            desktop: None,
        }
    }

    pub fn handle(&self, request: ControlRequest) -> ControlResponse {
        let id = request.id.clone();
        match self.execute(&request.command, request.params, &id) {
            Ok(result) => ControlResponse::success(id, result),
            Err(error) => ControlResponse::failure(id, error),
        }
    }

    #[cfg(feature = "desktop")]
    pub(crate) fn with_pairing(mut self, pairing: Arc<crate::pairing::PairingManager>) -> Self {
        if let Some(desktop) = &mut self.desktop { desktop.pairing = Some(pairing); }
        self
    }

    fn execute(&self, command: &str, params: Value, request_id: &str) -> Result<Value, ControlError> {
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
        if self.has_webview() {
            let id = crate::terminal_perf::ask(self.sink.as_ref(), "counters", json!({}));
            terminals["webview"] = crate::terminal_perf::wait(&id, crate::terminal_perf::COUNTERS_TIMEOUT).unwrap_or(Value::Null);
        }
        terminals
    }

    fn sessions_list(&self, params: Value) -> Result<Value, ControlError> {
        let mut sessions = index::load().map_err(ControlError::internal)?;
        if let Some(selector) = optional_string(&params, "project") {
            let project = resolve_project(&selector)?;
            sessions.retain(|s| s.project_path == project.path);
        }
        Ok(json!({"sessions": sessions}))
    }

    fn sessions_create(&self, params: Value) -> Result<Value, ControlError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            project: String,
            agent: String,
            prompt: String,
            #[serde(default)]
            title: Option<String>,
            #[serde(default)]
            name: Option<String>,
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
        if p.prompt.trim().is_empty() {
            return Err(ControlError::invalid("--prompt cannot be empty."));
        }
        validate_control_session_target(p.use_worktree, p.on_main)?;
        if p.name.is_some() && p.on_main {
            return Err(ControlError::invalid("--name requires a new worktree and cannot be used with --on-main."));
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
        let project = resolve_project(&p.project)?;
        let entry = crate::session_ops::create_named_session_blocking(
            &*self.sink,
            NewSession {
                project_path: project.path,
                title: p.title,
                use_worktree: p.use_worktree,
                on_main: p.on_main,
                base_ref: None,
                worktree_name: None,
                issue: None,
                automation: None,
                cwd: None,
                tab: Some(NewTab {
                    harness: p.agent,
                    model: p.model,
                    effort: p.effort,
                    permission_mode: p.mode,
                }),
            },
            p.name.as_deref(),
        )
        .map_err(workspace_error)?;
        let tab = entry
            .tabs
            .first()
            .cloned()
            .ok_or_else(|| ControlError::internal("the new session has no tab"))?;
        let outcome = self
            .manager
            .send(&entry.id, &tab.id, p.prompt, Vec::new())
            .map_err(ControlError::internal)?;
        Ok(json!({"sessionId": entry.id, "tabId": tab.id, "title": entry.title,
            "worktreeName": entry.worktree_name, "branch": entry.branch, "path": entry.cwd,
            "session": entry, "outcome": outcome}))
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
        // Agents, then the session's shells, each waited for, so nothing
        // still holds the directory.
        let stop = |session: &crate::store::index::SessionEntry| {
            for tab in &session.tabs {
                let _ = self.manager.stop(&session.id, &tab.id);
            }
            let shells = self.manager.terminals().session_pane_ids(&session.id, &[]);
            self.manager.terminals().kill_all_and_wait(&shells, std::time::Duration::from_secs(5));
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
        };
        let removed = crate::session_ops::remove_workspace(&*self.sink, &request, &stop).map_err(|error| {
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
            project_path: "/repo".into(),
            cwd: "/repo".into(),
            worktree_name: None,
            branch: Some("main".into()),
            base_ref: None,
            worktree_base: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: None,
            automation: None,
            title: "main".into(),
            created: "now".into(),
            modified: "now".into(),
            archived: false,
            pinned: false,
            tabs: Vec::new(),
            active_tab: None,
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
