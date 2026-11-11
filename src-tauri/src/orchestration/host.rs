//! The engine's [`Host`] over the app's own sessions.
//!
//! It needs only what the control socket also holds (the session manager and
//! the event sink), so the `terminalx runs` commands and the window's Approve
//! drive the same one.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context};

use super::engine::{EngineError, Host, Lead, Started, WorkerNow};
use super::{guard, Piece, Run, SessionRef, RUN_EVENT};
use crate::session::SessionManager;
use crate::session_ops::{NewSession, NewTab};
use crate::sink::EventSink;
use crate::store::index::{self, AgentTransport, ParentRef, SessionKind};
use crate::store::settings::OrchestratorLimits;
use crate::worker_report::{self, Status};

#[derive(Clone)]
pub struct ManagerHost {
    sink: Arc<dyn EventSink>,
    manager: SessionManager,
}

impl ManagerHost {
    pub fn new(sink: Arc<dyn EventSink>, manager: SessionManager) -> Self {
        Self { sink, manager }
    }
}

/// The commit a worker's branch is cut from: the lead's branch, or the commit
/// it has checked out when it is on none.
fn lead_base(cwd: &Path) -> anyhow::Result<String> {
    match crate::git::current_branch(cwd) {
        Some(branch) => Ok(branch),
        None => Ok(crate::git::run(cwd, &["rev-parse", "HEAD"]).context("the lead's checkout has no commit to branch from")?.trim().to_string()),
    }
}

impl Host for ManagerHost {
    fn lead(&self, session_id: &str) -> Result<Lead, EngineError> {
        let session = index::get(session_id).map_err(|_| EngineError::new("lead_not_found", format!("No session {session_id} to lead the run."), Some("Run the command inside the lead's session, or name it with --lead.")))?;
        let agent = session.tabs.iter().find(|tab| !tab.is_terminal()).map(|tab| tab.harness.clone()).unwrap_or_default();
        let repository = session.kind == SessionKind::Project && crate::git::is_repo(Path::new(&session.cwd));
        Ok(Lead { project_path: session.project_path, agent, repository })
    }

    fn worker_agents(&self) -> Vec<String> {
        // A worker is held to a report, and only an agent in its own terminal can be reminded of one.
        crate::harness::offered().into_iter().filter(|agent| agent.available && crate::session::pty_first(&agent.id).is_some()).map(|agent| agent.id).collect()
    }

    fn limits(&self, project_path: &str) -> OrchestratorLimits {
        crate::store::settings::load().orchestrator.for_project(project_path)
    }

    fn create_worker(&self, run: &Run, piece: &Piece, mode: &str) -> anyhow::Result<Started> {
        let lead = index::get(&run.lead.session_id).context("the lead's session is gone")?;
        let base = lead_base(Path::new(&lead.cwd))?;
        let entry = crate::session_ops::create_named_session_blocking(
            &*self.sink,
            NewSession {
                parent: Some(ParentRef { session_id: lead.id.clone(), tab_id: run.lead.tab_id.clone().filter(|tab| lead.tab(tab).is_some()) }),
                section_id: None,
                project_path: run.project_path.clone(),
                title: Some(piece.title.clone()),
                use_worktree: true,
                on_main: false,
                checkout_branch: None,
                checkout_pr: None,
                base_ref: Some(base),
                worktree_name: Some(format!("{}-{}", piece.id, piece.title)),
                issue: None,
                automation: None,
                cwd: None,
                tab: Some(NewTab { harness: piece.agent.clone(), transport: AgentTransport::Pty, model: piece.model.clone(), effort: piece.effort.clone(), permission_mode: Some(mode.to_string()) }),
            },
            None,
        )
        .map_err(|error| anyhow!("{error}"))?;
        let tab = entry.tabs.first().ok_or_else(|| anyhow!("the new session has no tab"))?;
        if let Some(branch) = entry.branch.as_deref() {
            // The session stays if this fails; its piece says why it did not start.
            guard::no_upstream(Path::new(&entry.cwd), branch).with_context(|| format!("session {} was created, but its branch {branch} could not be left without an upstream", entry.id))?;
        }
        Ok(Started { session_id: entry.id.clone(), tab_id: tab.id.clone(), branch: entry.branch.clone() })
    }

    fn brief_worker(&self, worker: &SessionRef, brief: &str) -> anyhow::Result<()> {
        let tab = worker.tab_id.as_deref().ok_or_else(|| anyhow!("the worker has no tab"))?;
        // Recorded before the brief goes: the turn it starts may end first.
        // A worker that cannot be recorded is still briefed; it just is not reminded.
        if let Err(error) = worker_report::expect(&worker.session_id, tab) {
            log::warn!("record that {}/{tab} owes a report: {error:#}", worker.session_id);
        }
        self.manager.send(&worker.session_id, tab, format!("{brief}\n\n{}", worker_report::brief()), Vec::new())?;
        Ok(())
    }

    fn worker(&self, worker: &SessionRef) -> WorkerNow {
        let Ok(session) = index::get(&worker.session_id) else { return WorkerNow::Gone };
        let Some(tab) = worker.tab_id.as_deref().filter(|tab| session.tab(tab).is_some()) else { return WorkerNow::Gone };
        let events = match self.manager.load_events(&session.id, tab) {
            Ok(events) => events,
            Err(error) => return WorkerNow::Stuck(format!("Its transcript could not be read: {error:#}")),
        };
        let view = self.manager.wait_view(&session.id, tab);
        let row = worker_report::of_tab(&events, crate::control::open_turn(&view), worker_report::expected(&session.id, tab));
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_string();
        let status = match row["status"].as_str() {
            Some("done") => Some(Status::Done),
            Some("partial") => Some(Status::Partial),
            Some("blocked") => Some(Status::Blocked),
            Some("failed") => Some(Status::Failed),
            _ => None,
        };
        match status {
            Some(status) => WorkerNow::Reported { status, result: text("result") },
            // No report: still on its way, or not coming.
            None if row["reason"] == "working" || row["reminderPending"] == true => WorkerNow::Working,
            // Its brief is typed into a CLI that is still starting.
            None if row["reason"] == "noTurn" && view.running => WorkerNow::Working,
            None => WorkerNow::Stuck(text("detail")),
        }
    }

    fn stop_worker(&self, worker: &SessionRef) -> anyhow::Result<bool> {
        let Ok(session) = index::get(&worker.session_id) else { return Ok(false) };
        let mut stopped = false;
        // Every agent of the session, as `sessions stop --children-of` does: a
        // terminal, or an agent a person started by hand in one, is left running.
        for tab in session.tabs.iter().filter(|tab| !tab.is_terminal() && !tab.by_hand()) {
            if self.manager.is_running(&session.id, &tab.id) {
                self.manager.stop(&session.id, &tab.id)?;
                stopped = true;
            }
        }
        Ok(stopped)
    }

    fn tell_lead(&self, run: &Run, text: &str) {
        let Ok(lead) = index::get(&run.lead.session_id) else { return };
        // The tab that made the run; a lead named with --lead is told in its own agent.
        let tab = run.lead.tab_id.as_deref().and_then(|tab| lead.tab(tab)).or_else(|| lead.tabs.iter().find(|tab| !tab.is_terminal()));
        let Some(tab) = tab else { return };
        if let Err(error) = self.manager.send(&lead.id, &tab.id, text.to_string(), Vec::new()) {
            log::warn!("tell the lead {} about run {}: {error:#}", lead.id, run.id);
        }
    }

    fn changed(&self, run: &Run) {
        self.sink.emit(RUN_EVENT, &super::engine::shown(run));
    }
}
