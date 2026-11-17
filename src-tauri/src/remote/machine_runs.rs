//! `machine/7` (PRO-403): a machine session's Setup and Run scripts from
//! another computer (docs/MACHINES.md "As built (PRO-403 to PRO-408)").
//!
//! - `machine.sessionActions`: the session's project's saved actions, preview
//!   URLs and setup script, as this machine's own store has them, with the
//!   session's latest setup attempt and the ports `$PORT` stands for here.
//! - `machine.runAction`: one saved action, started by this machine's own
//!   action runner in the session's folder here, exactly as for a session of
//!   its own window. A non-concurrent action already running is not started
//!   again (`started: false`); `restart` replaces it.
//! - `machine.setupRerun` / `machine.setupStop`: the workspace setup, run
//!   again or stopped by this machine's own `workspace_setup`.
//!
//! Every run is a pane of the machine runtime's own terminals. The protocol
//! server lists it with its session and a `run` tag (`pty.list`), so the
//! paired computer shows it as one of the session's terminals and attaches to
//! it like any other. Nothing of it runs on the paired computer.

use serde_json::{json, Value};

use super::protocol::RpcError;
use crate::session::SessionManager;
use crate::store::index::{self, SessionEntry};

/// What a session's script run is: one of its project's saved actions, or
/// its workspace setup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionRun {
    Action { action_id: String, name: String },
    Setup,
}

impl SessionRun {
    /// The session and run a runtime pane id names: `<session>:action-…`
    /// ([`crate::action_runner`]) or `<session>:workspace-setup-…`
    /// ([`crate::workspace_setup`]). A cheap test first: every pane's output
    /// passes through here.
    pub(crate) fn of_pane(pane: &str, title: Option<&str>) -> Option<(String, Self)> {
        if !pane.contains(':') || pane.starts_with(super::server::AGENT_PTY_PREFIX) || pane.starts_with(super::server::PTY_PREFIX) {
            return None;
        }
        if let Some(session) = crate::workspace_setup::pane_session(pane) {
            return Some((session.to_string(), Self::Setup));
        }
        let (session, action_id) = crate::action_runner::parse_pane(pane)?;
        Some((session.to_string(), Self::Action { name: title.unwrap_or(&action_id).to_string(), action_id }))
    }

    /// As `pty.list` names it: `{ kind: "action", actionId, name }` or `{ kind: "setup" }`.
    pub(crate) fn wire(&self) -> Value {
        match self {
            Self::Action { action_id, name } => json!({ "kind": "action", "actionId": action_id, "name": name }),
            Self::Setup => json!({ "kind": "setup" }),
        }
    }
}

/// A workspace setup attempt on the wire. Its pane, while the runtime keeps
/// it, is the terminal `pty.list` lists with `run: { kind: "setup" }`.
fn setup_wire(setup: &crate::workspace_setup::Setup) -> Value {
    json!({
        "paneId": setup.pane_id,
        "command": setup.command,
        "status": setup.status,
        "exitCode": setup.exit_code,
        "error": setup.error,
        "hasPane": setup.has_pane,
    })
}

/// `machine.sessionActions`: what the Run menu, the Open button and the
/// dock's Setup and Run tabs show for `session`, as this machine has it.
pub(super) fn session_actions(session: &SessionEntry, manager: Option<&SessionManager>) -> Result<Value, RpcError> {
    let canonical = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
    let wanted = canonical(&session.project_path);
    let project = super::machine::registered()?.into_iter().find(|project| canonical(&project.path) == wanted);
    let (actions, preview_urls) = project.map(|project| (project.actions, project.preview_urls)).unwrap_or_default();
    let setup = match manager {
        Some(manager) => crate::workspace_setup::current(manager, &session.id).map_err(RpcError::internal)?,
        None => None,
    };
    Ok(json!({
        "actions": actions,
        "previewUrls": preview_urls,
        "setupScript": crate::workspace_setup::saved_script(&session.project_path),
        // A workspace's own checkout runs setup; the project's folder does not.
        "setupApplies": !session.worktree_removed && session.worktree_name.is_some() && session.cwd != session.project_path,
        "available": !session.worktree_removed,
        // What $PORT and $PORT_1..$PORT_9 are on the machine; null when not known.
        "ports": index::workspace_ports::ports(&session.cwd).ok().filter(|ports| !ports.is_empty()),
        "setup": setup.as_ref().map(setup_wire),
    }))
}

/// A pane a start made or found, for the server to record as the session's terminal.
pub(super) struct StartedRun {
    pub pane_id: String,
    pub name: String,
    pub started: bool,
}

/// What a start answers, and the pane it ran, if any.
pub(super) struct Started {
    pub answer: Value,
    pub run: Option<StartedRun>,
}

/// `machine.runAction`, `machine.setupRerun` or `machine.setupStop` for
/// `session`, by this machine's own runner. What the runner refuses (a
/// removed worktree, an action no longer saved, a restart still stopping)
/// is `conflict`, in its words, for the person to read.
pub(super) fn start(manager: &SessionManager, session: &SessionEntry, method: &str, params: &Value) -> Result<Started, RpcError> {
    let refused = |error: anyhow::Error| RpcError::new("conflict", format!("{error:#}"));
    let text = |name: &str| params.get(name).and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or_else(|| RpcError::invalid(format!("{name} is required")));
    match method {
        "machine.runAction" => {
            let action_id = text("actionId")?;
            let restart = params.get("restart").and_then(Value::as_bool).unwrap_or(false);
            let outcome = crate::action_runner::run(manager, &session.id, action_id, crate::action_runner::RunOptions { restart }).map_err(refused)?;
            let answer = json!({
                "started": outcome.started,
                "run": {
                    "actionId": outcome.run.action_id,
                    "name": outcome.run.name,
                    "ptyId": outcome.run.pane_id,
                    "state": outcome.run.state,
                    "exitCode": outcome.run.exit_code,
                },
            });
            Ok(Started { answer, run: Some(StartedRun { pane_id: outcome.run.pane_id, name: outcome.run.name, started: outcome.started }) })
        }
        "machine.setupRerun" => {
            let setup = crate::workspace_setup::start(manager, &session.id, true).map_err(refused)?;
            Ok(Started { answer: json!({ "setup": setup.as_ref().map(setup_wire) }), run: None })
        }
        "machine.setupStop" => {
            let setup = crate::workspace_setup::stop(manager, &session.id, text("paneId")?).map_err(refused)?;
            Ok(Started { answer: json!({ "setup": setup.as_ref().map(setup_wire) }), run: None })
        }
        _ => Err(RpcError::new("method_not_found", format!("{method} is not a machine/7 method"))),
    }
}

#[cfg(test)]
#[path = "machine_runs_tests.rs"]
mod tests;
