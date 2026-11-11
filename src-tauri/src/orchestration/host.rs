//! The engine's [`Host`] over the app's own sessions.
//!
//! It needs only what the control socket also holds (the session manager and
//! the event sink), so the `terminalx runs` commands and the window's Approve
//! drive the same one.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context};

use super::engine::{Cost, EngineError, Host, Lead, Started, VerifierNow, WorkerNow};
use super::verify::{self, Checked, Checkout, Gate};
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
        let (agent, model) = session.tabs.iter().find(|tab| !tab.is_terminal()).map(|tab| (tab.harness.clone(), tab.model.clone())).unwrap_or_default();
        let repository = session.kind == SessionKind::Project && crate::git::is_repo(Path::new(&session.cwd));
        Ok(Lead { project_path: session.project_path, agent, model, repository, cwd: session.cwd })
    }

    fn worker_agents(&self) -> Vec<String> {
        // A worker is held to a report, and only an agent in its own terminal can be reminded of one.
        crate::harness::offered().into_iter().filter(|agent| agent.available && crate::session::pty_first(&agent.id).is_some()).map(|agent| agent.id).collect()
    }

    fn models(&self) -> Vec<crate::models::Model> {
        // As the pickers list them: each agent's CLI was asked once, and the answer is kept.
        crate::models::list(&self.manager.codex_models(), false)
    }

    fn worker_cost(&self, worker: &SessionRef) -> Cost {
        // Read from the worker's transcripts again, as far as they have got (`sessions usage`).
        match crate::session_usage::refresh_session(&worker.session_id) {
            Ok((session, _)) => {
                let (usd, unpriced_models) = crate::session_usage::estimated_cost(&session);
                Cost { usd, unpriced_models }
            }
            Err(_) => Cost::default(),
        }
    }

    fn retry_waits(&self, run_id: &str) {
        // The next try is a new session in a new worktree: made off the thread that read the
        // run, which may be a turn ending or a command waiting for its answer.
        let (host, run) = (self.clone(), run_id.to_string());
        std::thread::spawn(move || {
            if let Err(error) = super::engine::start_retries(&host, &run) {
                log::warn!("start the next try in run {run}: {error}");
            }
        });
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
                // Each try has a worktree and a branch of its own: the one before it keeps its.
                worktree_name: Some(match piece.tries.len() {
                    0 | 1 => format!("{}-{}", piece.id, piece.title),
                    tries => format!("{}-try{tries}-{}", piece.id, piece.title),
                }),
                issue: None,
                automation: None,
                cwd: None,
                tab: Some(NewTab { harness: piece.agent.clone(), transport: AgentTransport::Pty, model: piece.model.clone(), effort: piece.effort.clone(), permission_mode: Some(mode.to_string()) }),
            },
            None,
        )
        .map_err(|error| anyhow!("{error}"))?;
        let tab = entry.tabs.first().ok_or_else(|| anyhow!("the new session has no tab"))?;
        // It is marked a worker as it is made (`session_ops::inherit_run_limits`), while this
        // lead's start is under way; `secure_worker` checks that before it is briefed.
        Ok(Started { session_id: entry.id.clone(), tab_id: tab.id.clone(), branch: entry.branch.clone() })
    }

    fn secure_worker(&self, worker: &SessionRef, branch: Option<&str>) -> anyhow::Result<()> {
        let session = index::get(&worker.session_id).context("the worker's session is gone")?;
        // On its own entry, so its limits do not depend on the runs file.
        if !session.run_worker() {
            index::update_session(&session.id, |session| {
                session.mark_run_worker();
                Ok(())
            })
            .context("the session could not be marked as a run's worker")?;
        }
        if let Some(branch) = branch {
            guard::no_upstream(Path::new(&session.cwd), branch).with_context(|| format!("its branch {branch} could not be left without an upstream"))?;
        }
        Ok(())
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
            // Its brief is on its way into a CLI that is still starting.
            None if row["reason"] == "noTurn" && (view.running || view.queued) => WorkerNow::Working,
            // Its turn ended, the reminder went out and came to nothing: there is no report to read.
            None if matches!(row["reason"].as_str(), Some("noBlock" | "malformed" | "noReply")) => WorkerNow::NoReport(text("detail")),
            None => WorkerNow::Stuck(text("detail")),
        }
    }

    fn check_waits(&self, run_id: &str) {
        // The gates run the plan's commands: minutes, not a read's worth of time.
        let (host, run) = (self.clone(), run_id.to_string());
        let spawned = std::thread::Builder::new().name("run-verify".into()).spawn(move || {
            if let Err(error) = super::engine::verify(&host, &run) {
                log::warn!("check the results of run {run}: {error}");
            }
        });
        if let Err(error) = spawned {
            log::warn!("start the check of run {run_id}: {error}");
        }
    }

    fn check(&self, run: &Run, piece: &Piece, worker: &SessionRef) -> Checked {
        let Ok(session) = index::get(&worker.session_id) else {
            return Checked::unreadable(Gate::Branch, "The worker's session was deleted, so its worktree cannot be checked.");
        };
        let base = match index::get(&run.lead.session_id).context("the lead's session is gone").and_then(|lead| lead_base(Path::new(&lead.cwd))) {
            Ok(base) => base,
            Err(error) => return Checked::unreadable(Gate::Scope, format!("The lead's branch could not be read, so there is nothing to compare the result with: {error:#}")),
        };
        // The project's own check, the one its pipelines run before a merge.
        let project_check = crate::store::projects::issue_pipeline_settings(&run.project_path).ok().and_then(|settings| settings.local_check_command);
        verify::gates(&Checkout { cwd: session.cwd.into(), base, branch: piece.branch.clone() }, piece, project_check.as_deref(), verify::COMMAND_TIMEOUT)
    }

    fn create_verifier(&self, _run: &Run, piece: &Piece, worker: &SessionRef, model: &str, effort: Option<&str>, number: u32) -> anyhow::Result<SessionRef> {
        // A conversation of its own in the worker's session: the same worktree, the worker's
        // limits, and nothing of the worker's transcript. It starts in a mode that edits nothing.
        let tab = self.manager.add_tab(&worker.session_id, &NewTab { harness: piece.agent.clone(), transport: AgentTransport::Pty, model: model.to_string(), effort: effort.map(str::to_owned), permission_mode: Some(guard::VERIFIER_MODE.to_string()) })?;
        let (voters, _) = verify::panel(piece);
        let title = if voters > 1 { format!("Verifier {number}") } else { "Verifier".to_string() };
        crate::session_ops::rename_tab_entry(&worker.session_id, &tab.id, Some(title)).map_err(|error| anyhow!("{error}"))?;
        if let Ok(session) = index::get(&worker.session_id) {
            self.sink.emit("session_updated", &session);
        }
        Ok(SessionRef { session_id: worker.session_id.clone(), tab_id: Some(tab.id) })
    }

    fn brief_verifier(&self, verifier: &SessionRef, prompt: &str) -> anyhow::Result<()> {
        let tab = verifier.tab_id.as_deref().ok_or_else(|| anyhow!("the verifier has no tab"))?;
        self.manager.send(&verifier.session_id, tab, prompt.to_string(), Vec::new())?;
        Ok(())
    }

    fn verifier(&self, verifier: &SessionRef) -> VerifierNow {
        let Ok(session) = index::get(&verifier.session_id) else { return VerifierNow::Gone };
        let Some(tab) = verifier.tab_id.as_deref().filter(|tab| session.tab(tab).is_some()) else { return VerifierNow::Gone };
        let view = self.manager.wait_view(&session.id, tab);
        match crate::control::open_turn(&view) {
            Some(worker_report::OpenTurn::Working) => return VerifierNow::Working,
            Some(worker_report::OpenTurn::Waiting) => return VerifierNow::Stuck("It stopped on a permission request, a question or an error, and gave no verdict.".into()),
            None => {}
        }
        let events = match self.manager.load_events(&session.id, tab) {
            Ok(events) => events,
            Err(error) => return VerifierNow::Stuck(format!("Its transcript could not be read: {error:#}")),
        };
        match crate::issue_pipeline::host::last_reply(&events) {
            Some((_, reply)) => VerifierNow::Replied(reply),
            // Its prompt is on its way into a CLI that is still starting.
            None if view.running || view.queued => VerifierNow::Working,
            None => VerifierNow::Stuck("It ended without a reply.".into()),
        }
    }

    fn verifier_tokens(&self, verifier: &SessionRef) -> Option<verify::Tokens> {
        let tab_id = verifier.tab_id.as_deref()?;
        // Read from its transcript again, as far as it has got.
        if let Err(error) = crate::session_usage::refresh_tab(&verifier.session_id, tab_id) {
            log::warn!("read what verifier {}/{tab_id} used: {error:#}", verifier.session_id);
        }
        let session = index::get(&verifier.session_id).ok()?;
        let usage = session.tab(tab_id)?.usage.as_ref()?;
        let total = crate::session_usage::total(&usage.models);
        Some(verify::Tokens { input: total.input_tokens, output: total.output_tokens, cache_read: total.cache_read_tokens, cache_write: total.cache_write_tokens, cost_usd: total.cost_usd })
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
