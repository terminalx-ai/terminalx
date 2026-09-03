//! Authenticated JSON-lines control protocol shared by the desktop app and
//! the `terminalx-next` command-line client.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::commands::{NewSession, NewTab};
use crate::hooks::ControlEndpoint;
use crate::session::{PendingPermission, SessionManager};
use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};
use crate::store::projects::{self, Project};

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
            Some("Run terminalx-next --help and correct the named argument.".into()),
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
#[cfg(unix)]
pub fn call(
    command: &str,
    params: Value,
    timeout: Duration,
) -> Result<ControlResponse, ControlError> {
    use std::os::unix::net::UnixStream;

    let socket = client_socket_path();
    if !socket.exists() {
        return Err(ControlError::new(
            "app_unavailable",
            format!("No running app is listening at {}.", socket.display()),
            Some("Open Raccoon with the same RACCOON_HOME, then retry status once.".into()),
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
                Some("Restart an app-launched tab, or let a human shell read RACCOON_HOME/run/control.token.".into()),
            )
        })?;
    let request = ControlRequest {
        id: uuid::Uuid::now_v7().to_string(),
        token,
        command: command.into(),
        params,
    };
    let mut stream = UnixStream::connect(&socket).map_err(|e| {
        ControlError::new(
            "app_unavailable",
            format!("Could not connect to {}: {e}", socket.display()),
            Some("Open Raccoon with the same RACCOON_HOME, then retry status once.".into()),
        )
    })?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(ControlError::internal)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(ControlError::internal)?;
    let mut bytes = serde_json::to_vec(&request).map_err(ControlError::internal)?;
    bytes.push(b'\n');
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

#[cfg(not(unix))]
pub fn call(
    _command: &str,
    _params: Value,
    _timeout: Duration,
) -> Result<ControlResponse, ControlError> {
    Err(ControlError::new(
        "app_unavailable",
        "The control socket requires Unix.",
        None,
    ))
}

fn client_home() -> PathBuf {
    std::env::var_os("RACCOON_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".raccoon")))
        .unwrap_or_else(|| PathBuf::from(".raccoon"))
}

fn client_socket_path() -> PathBuf {
    std::env::var_os(crate::hooks::CONTROL_SOCKET_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| client_home().join("run/hooks.sock"))
}

fn client_token_path() -> PathBuf {
    client_home().join("run/control.token")
}

#[derive(Clone)]
pub struct ControlService {
    app: AppHandle,
    manager: SessionManager,
    endpoint: ControlEndpoint,
}

impl ControlService {
    pub fn new(app: AppHandle, manager: SessionManager, endpoint: ControlEndpoint) -> Self {
        Self {
            app,
            manager,
            endpoint,
        }
    }

    pub fn handle(&self, request: ControlRequest) -> ControlResponse {
        let id = request.id.clone();
        match self.execute(&request.command, request.params) {
            Ok(result) => ControlResponse::success(id, result),
            Err(error) => ControlResponse::failure(id, error),
        }
    }

    fn execute(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        match command {
            "status" => {
                let (projects, _) = projects::list().map_err(ControlError::internal)?;
                Ok(json!({
                    "appVersion": env!("CARGO_PKG_VERSION"),
                    "pid": std::process::id(),
                    "socket": self.endpoint.socket,
                    "projects": projects,
                    "runningTabs": self.manager.running_tabs(),
                }))
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
            "worktrees.delete" => self.worktree_delete(params),
            "issues.list" => self.issues_list(params),
            other => Err(ControlError::invalid(format!(
                "Unknown control command {other}."
            ))),
        }
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
        let p: Params = serde_json::from_value(params)
            .map_err(|e| ControlError::invalid(format!("Invalid session request: {e}")))?;
        if p.prompt.trim().is_empty() {
            return Err(ControlError::invalid("--prompt cannot be empty."));
        }
        validate_control_session_target(p.use_worktree, p.on_main)?;
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
        let entry = crate::commands::create_session_blocking(
            &self.app,
            NewSession {
                project_path: project.path,
                title: None,
                use_worktree: p.use_worktree,
                on_main: p.on_main,
                base_ref: None,
                worktree_name: None,
                issue: None,
                cwd: None,
                tab: Some(NewTab {
                    harness: p.agent,
                    model: p.model,
                    effort: p.effort,
                    permission_mode: p.mode,
                }),
            },
        )
        .map_err(ControlError::internal)?;
        let tab = entry
            .tabs
            .first()
            .cloned()
            .ok_or_else(|| ControlError::internal("the new session has no tab"))?;
        let outcome = self
            .manager
            .send(&entry.id, &tab.id, p.prompt, Vec::new())
            .map_err(ControlError::internal)?;
        Ok(json!({"sessionId": entry.id, "tabId": tab.id, "session": entry, "outcome": outcome}))
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
        let selector = required_string(&params, "worktree")?;
        let projects = selected_projects(optional_string(&params, "project"))?;
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
        if worktree.is_main {
            return Err(ControlError::invalid(
                "A project's main checkout cannot be deleted.",
            ));
        }
        let sessions = index::load().map_err(ControlError::internal)?;
        let target = canonical_or_original(&worktree.path);
        let affected: Vec<SessionEntry> = sessions
            .into_iter()
            .filter(|session| canonical_or_original(&session.cwd) == target)
            .collect();
        for session in &affected {
            for tab in &session.tabs {
                let _ = self.manager.stop(&session.id, &tab.id);
            }
        }
        crate::workspaces::delete(Path::new(&project.path), Path::new(&worktree.path), false)
            .map_err(ControlError::internal)?;
        let branch = crate::git::current_branch(Path::new(&project.path));
        let mut moved = Vec::new();
        for affected_session in affected {
            let entry = index::update_session(&affected_session.id, |session| {
                session.cwd = session.project_path.clone();
                session.worktree_name = None;
                session.worktree_removed = true;
                session.branch = branch.clone();
                session.base_ref = None;
                for tab in &mut session.tabs {
                    tab.status = TabStatus::Idle;
                }
                Ok(session.clone())
            })
            .map_err(ControlError::internal)?;
            let _ = self.app.emit("session_updated", &entry);
            moved.push(entry.id);
        }
        Ok(json!({"deleted": worktree.path, "project": project.path, "movedSessions": moved}))
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
                            Some("Add an API key in Raccoon Settings → Integrations.".into()),
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

fn resolve_session(selector: &str) -> Result<SessionEntry, ControlError> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
            worktree_removed: false,
            issue: None,
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
}
