//! The engine's [`Host`] over the app's own sessions.
//!
//! It needs only what the control socket also holds (the session manager and
//! the event sink), so the `terminalx runs` commands and the window's Approve
//! drive the same one.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context};

use super::budget::Login;
use super::engine::{self, Activity, Cost, EngineError, Host, Lead, Started, VerifierNow, WorkerNow};
use super::merge::{Checkouts, Worktree};
use super::verify::{self, Checked, Checkout, Gate};
use super::{guard, routing, Piece, Run, SessionRef, RUN_EVENT};
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

    fn queue_retirement(&self, run: &Run) {
        if !run.state.ended() { return; }
        let host = self.clone();
        let run = run.clone();
        engine::after_starting(move || {
            host.retire_automatically(&run, true);
            prune_base(&run);
        });
    }

    /// Sweep retries never stop final workers or a new turn. Preservation happens
    /// before Stop; a prompt admitted while it runs makes the final check refuse.
    pub(crate) fn retire_automatically(&self, snapshot: &Run, include_final: bool) {
        static RETIRING: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _retiring = RETIRING.lock().unwrap_or_else(|error| error.into_inner());
        let Ok(run) = super::store::get(&snapshot.id) else { return };
        if !run.state.ended() { return; }
        let archival = run.archival_workers();
        for worker in run.finished_workers() {
            let archive = archival.iter().any(|w| w.session_id == worker.session_id);
            if !archive && !include_final { continue; }
            let Ok(session) = index::get(&worker.session_id) else { continue };
            if session.archived || session.worktree_removed || session.archive.unarchived_at.is_some() { continue; }
            let last_message = crate::store::message_activity::last_message_at(&session);
            let idle = || index::get(&worker.session_id).is_ok_and(|current|
                current.cwd == session.cwd && !current.worktree_removed
                && current.archive.unarchived_at.is_none()
                && crate::store::message_activity::last_message_at(&current) == last_message
                && current.tabs.iter().all(|tab| self.manager.pipeline_idle(&current.id, &tab.id)));
            if !idle() { continue; }
            let head = crate::git::head_commit(Path::new(&session.cwd));
            if archive && !super::retirement::retry_allowed(&run, worker, &head) { continue; }
            let result = (|| -> anyhow::Result<()> {
                if archive { Host::preserve_worker(self, &run, worker)?; }
                use crate::issue_pipeline::admission::{self, Kind, Scope};
                let _fence = {
                    let _admission = admission::lock();
                    anyhow::ensure!(idle() && !super::retirement::recovered(worker), "Worker resumed during preservation; leave its turn running");
                    admission::fence(Kind::Refuse(admission::RUN_MERGING), [Scope::working_tree(Path::new(&session.cwd))])
                };
                Host::stop_worker_for_cleanup(self, worker)?;
                if archive { Host::archive_worker(self, &run, worker)?; }
                Ok(())
            })();
            if let Err(error) = result {
                let failure = super::retirement::ArchiveFailure { head, reason: format!("{error:#}") };
                if let Err(error) = super::retirement::record_failure(&run, worker, Some(failure)) {
                    log::warn!("Record worker retirement failure: {error:#}");
                }
            }
        }
    }
}

/// How often the watcher looks for stalled workers and runs due to resume.
/// A stall is measured in minutes, so a minute is fine enough.
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(60);
/// Above this, a worker's agent is working, whatever its transcript says.
const BUSY_CPU_PERCENT: f32 = 5.0;

/// Whether the watcher thread runs, and how often it was asked for: a run
/// that starts while the thread decides to end is not left unwatched.
static WATCHER: std::sync::Mutex<(bool, u64)> = std::sync::Mutex::new((false, 0));

fn millis(ts: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(ts).ok().map(|at| at.timestamp_millis())
}

/// What a worker did in its open turn, from its transcript's events.
pub(crate) fn activity_of(events: &[crate::events::AgentEvent]) -> Activity {
    use crate::events::Payload;
    let from = events.iter().rposition(|event| matches!(event.payload, Payload::TurnStarted { .. })).unwrap_or(0);
    let mut activity = Activity::default();
    let mut open = std::collections::HashSet::new();
    let mut background = false;
    for event in &events[from..] {
        let at = || millis(&event.ts);
        match &event.payload {
            Payload::TurnStarted { .. } => activity.last_ms = at(),
            Payload::ToolCallStarted { call_id, .. } => {
                open.insert(call_id.clone());
                activity.last_ms = at().or(activity.last_ms);
            }
            Payload::ToolCallCompleted { call_id, .. } => {
                open.remove(call_id);
                activity.last_ms = at().or(activity.last_ms);
            }
            Payload::FileEdits { .. } => activity.last_ms = at().or(activity.last_ms),
            Payload::BackgroundTasksChanged { tasks } => background = !tasks.is_empty(),
            _ => {}
        }
    }
    activity.command_running = !open.is_empty() || background;
    activity
}

/// The projects whose base checkout a check or a prune is using, and the signal that one
/// was let go: one at a time a project, any number of projects at once.
static BASES_HELD: std::sync::Mutex<std::collections::BTreeSet<String>> = std::sync::Mutex::new(std::collections::BTreeSet::new());
static BASE_FREED: std::sync::Condvar = std::sync::Condvar::new();

/// A project's base checkout, held: a command running in it is not switched or removed under it.
pub(super) struct BaseHeld(String);

impl Drop for BaseHeld {
    fn drop(&mut self) {
        BASES_HELD.lock().unwrap_or_else(|error| error.into_inner()).remove(&self.0);
        BASE_FREED.notify_all();
    }
}

/// Waits until no check of `project` holds its base checkout, then holds it.
fn hold_base(project: &str) -> BaseHeld {
    let mut held = BASES_HELD.lock().unwrap_or_else(|error| error.into_inner());
    while held.contains(project) {
        held = BASE_FREED.wait(held).unwrap_or_else(|error| error.into_inner());
    }
    held.insert(project.to_string());
    BaseHeld(project.to_string())
}

fn base_dir(root: &Path, project: &str) -> PathBuf {
    use sha2::Digest;
    root.join(&format!("{:x}", sha2::Sha256::digest(project.as_bytes()))[..16])
}

/// The checkout a project's base commits are run in (#1004): one of the
/// app's own, kept while the project has a run so what a check builds (ignored
/// files: a `target`) is there for its next one, and removed when its last run
/// ends ([`prune_base`]). Held while a command runs in it: two checks of one
/// project take turns, and other projects' checks do not wait. `repo` is any
/// checkout of the project; `commit` a result that forks from `base`, and it is
/// the commit where they fork that is checked out.
fn base_checkout(repo: &Path, root: &Path, project: &str, base: &str, commit: &str) -> anyhow::Result<(PathBuf, BaseHeld)> {
    let held = hold_base(project);
    let fork = crate::git::run(repo, &["merge-base", base, commit]).context("find where the result forks from its base")?;
    let fork = fork.trim();
    let dir = base_dir(root, project);
    let ours = crate::git::run(&dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok();
    let theirs = crate::git::run(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).context("read the project's repository")?;
    if ours.as_deref().map(crate::git::path_line) != Some(crate::git::path_line(&theirs)) {
        if dir.exists() {
            std::fs::remove_dir_all(&dir).with_context(|| format!("clear {}", dir.display()))?;
        }
        std::fs::create_dir_all(root)?;
        let _ = crate::git::run(repo, &["worktree", "prune"]);
        crate::git::run(repo, &["worktree", "add", "--detach", "--force", &dir.to_string_lossy(), fork]).context("add the base checkout")?;
    } else {
        crate::git::run(&dir, &["checkout", "--detach", "--force", fork]).context("check out the base commit")?;
        // What a command left there before goes; what is ignored (build output) stays.
        crate::git::run(&dir, &["clean", "-fdq"]).context("clean the base checkout")?;
    }
    Ok((dir, held))
}

/// A run ended: its project's base checkout, and what checks built in it, goes once no
/// other run of the project is under way. The next run's first base check makes it again.
fn prune_base(ended: &Run) {
    let Ok(root) = crate::store::root() else { return };
    let others = super::store::list().unwrap_or_default().into_iter().any(|run| run.id != ended.id && run.project_path == ended.project_path && run.state.followed());
    if others {
        return;
    }
    if let Err(error) = drop_base_checkout(Path::new(&ended.project_path), &root.join("run-bases"), &ended.project_path) {
        log::warn!("remove the base checkout of {} after run {}: {error:#}", ended.project_path, ended.id);
    }
}

/// Removes a project's base checkout, once no check is using it, and the repository's
/// record of it. Nothing to remove is not an error.
fn drop_base_checkout(repo: &Path, root: &Path, project: &str) -> anyhow::Result<()> {
    let _held = hold_base(project);
    let dir = base_dir(root, project);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
    crate::git::run(repo, &["worktree", "prune"]).context("forget the removed base checkout")?;
    Ok(())
}

/// Each file changed from `from` to `to` in the lead's checkout, for a piece it finishes:
/// every path as it is, never quoted, and both sides of a rename, since what the lead is
/// held to is checked against the piece's files path by path.
fn held_changes(cwd: &Path, from: &str, to: &str) -> anyhow::Result<Vec<verify::FileChange>> {
    let numbers = crate::git::run(cwd, &["diff", "--numstat", "--no-renames", "-z", &format!("{from}..{to}"), "--"])?;
    Ok(verify::numstat_z(&numbers))
}

/// The commit a worker's branch is cut from: the lead's branch, or the commit
/// it has checked out when it is on none.
fn lead_base(cwd: &Path) -> anyhow::Result<String> {
    match crate::git::current_branch(cwd) {
        Some(branch) => Ok(branch),
        None => Ok(crate::git::run(cwd, &["rev-parse", "HEAD"]).context("the lead's checkout has no commit to branch from")?.trim().to_string()),
    }
}

/// Assemble the exact accepted inputs without changing any checkout, index or
/// branch. Merge commits retain dependency ancestry for the final run merge.
pub(super) fn dependency_base(cwd: &Path, dependencies: &[(&str, &str)]) -> anyhow::Result<String> {
    let mut base = crate::git::run(cwd, &["rev-parse", "--verify", "HEAD^{commit}"])?.trim().to_string();
    for (id, accepted) in dependencies {
        let commit = crate::git::run(cwd, &["rev-parse", "--verify", &format!("{accepted}^{{commit}}")])
            .with_context(|| format!("the accepted commit of dependency {id} is unavailable"))?.trim().to_string();
        if matches!(crate::git::raw(cwd, &["merge-base", "--is-ancestor", &commit, &base]), Some((0, _))) {
            continue;
        }
        if matches!(crate::git::raw(cwd, &["merge-base", "--is-ancestor", &base, &commit]), Some((0, _))) {
            base = commit;
            continue;
        }
        let merged = crate::git::run(cwd, &["merge-tree", "--write-tree", &base, &commit])
            .with_context(|| format!("dependency {id} cannot be combined with this worker's starting code; resolve the dependency conflict before retrying"))?;
        let tree = merged.lines().next().context("the dependency merge returned no tree")?;
        base = crate::git::run(cwd, &["-c", "user.name=TerminalX", "-c", "user.email=terminalx@localhost", "commit-tree", tree, "-p", &base, "-p", &commit, "-m", &format!("Orchestration dependency {id}")])?.trim().to_string();
    }
    Ok(base)
}

impl Host for ManagerHost {
    fn retire_workers_later(&self, run: &Run) { self.queue_retirement(run); }
    fn stop_worker_for_cleanup(&self, worker: &SessionRef) -> anyhow::Result<bool> {
        let Some(session) = index::load()?.into_iter().find(|s| s.id == worker.session_id) else { return Ok(false) };
        if session.worktree_removed { return Ok(false); }
        use crate::issue_pipeline::admission::{self, Kind, Scope};
        let _fence = {
            let _admission = admission::lock();
            let current = index::get(&session.id)?;
            anyhow::ensure!(current.cwd == session.cwd && current.tabs.iter().all(|tab| self.manager.pipeline_idle(&current.id, &tab.id)),
                "Worker has moved or has an active or queued turn; leave it running and retry cleanup when idle");
            admission::fence(Kind::Refuse(admission::RUN_MERGING), [Scope::working_tree(Path::new(&session.cwd))])
        };
        engine::stop_worker_agents(&session.tabs, &|tab| self.manager.is_running(&session.id, tab), &|tab| self.manager.stop(&session.id, tab))
    }

    fn preserve_worker(&self, run: &Run, worker: &SessionRef) -> anyhow::Result<()> {
        if index::get(&worker.session_id)?.worktree_removed { return Ok(()); }
        super::retirement::preserve(run, worker)
    }

    fn archive_worker(&self, run: &Run, worker: &SessionRef) -> anyhow::Result<()> {
        use crate::issue_pipeline::admission::{self, Kind, Scope};
        let session = index::get(&worker.session_id)?;
        if session.worktree_removed { return Ok(()); }
        let fence = {
            let _admission = admission::lock();
            anyhow::ensure!(!session.tabs.iter().any(|tab| self.manager.is_running(&session.id, &tab.id)), "Worker is still running");
            admission::fence(Kind::Refuse(admission::RUN_MERGING), [Scope::working_tree(Path::new(&session.cwd))])
        };
        // Recheck the saved receipt under the prompt fence, without another full fetch.
        super::retirement::verify_saved(run, worker)?;
        crate::session_archive::set_archived(&*self.sink, std::slice::from_ref(&worker.session_id), true, crate::session_archive::By::Automation)?;
        drop(fence);
        Ok(())
    }

    fn held_by_pause(&self, run: &Run) -> Option<String> {
        crate::bots::pause::holds_run(&run.lead.session_id)
    }
    fn lead(&self, session_id: &str) -> Result<Lead, EngineError> {
        let session = index::get(session_id).map_err(|_| EngineError::new("lead_not_found", format!("No session {session_id} to lead the run."), Some("Run the command inside the lead's session, or name it with --lead.")))?;
        let (agent, model) = session.tabs.iter().find(|tab| !tab.is_terminal()).map(|tab| (tab.harness.clone(), tab.model.clone())).unwrap_or_default();
        let repository = session.kind == SessionKind::Project && crate::git::is_repo(Path::new(&session.cwd));
        let ask_first = session.orchestrate_start();
        Ok(Lead { project_path: session.project_path, agent, model, repository, cwd: session.cwd, ask_first })
    }

    fn worker_agents(&self) -> Vec<String> {
        // A worker is held to a report, and only an agent in its own terminal can be reminded of one.
        crate::harness::offered().into_iter().filter(|agent| agent.available && crate::session::pty_first(&agent.id).is_some()).map(|agent| agent.id).collect()
    }

    fn models(&self) -> routing::Installed {
        // As the pickers list them: each agent's CLI was asked once, and the answer is kept. A
        // Claude list with a tier missing is asked for again once it has aged: the account or the
        // CLI may have changed since this process first asked (#1533).
        let mut claude = crate::harness::claude::models::get(false);
        if routing::Tier::ALL.iter().any(|tier| routing::model_for("claude", *tier, &claude).is_none()) {
            claude = crate::harness::claude::models::get(true);
        }
        let models = crate::models::offered(claude, self.manager.codex_models().get(false));
        let read = std::collections::BTreeMap::from([("claude".to_string(), crate::harness::claude::models::read_from())]);
        routing::Installed { models, read }
    }

    fn worker_cost(&self, worker: &SessionRef) -> Cost {
        // Read from the worker's transcripts again, as far as they have got (`sessions usage`).
        match crate::session_usage::refresh_session(&worker.session_id) {
            Ok((session, _)) => {
                let (usd, unpriced_models) = crate::session_usage::estimated_cost(&session);
                let rows: Vec<_> = session.tabs.iter().filter_map(|tab| tab.usage.as_ref()).flat_map(|usage| &usage.models).collect();
                let output_tokens = (!rows.is_empty()).then(|| crate::session_usage::total(rows).output_tokens);
                Cost { usd, unpriced_models, output_tokens }
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

    fn worker_base(&self, run: &Run, piece: &Piece) -> anyhow::Result<String> {
        let lead = index::get(&run.lead.session_id).context("the lead's session is gone")?;
        let dependencies = piece.depends_on.iter().map(|id| {
            let dependency = run.piece(id).with_context(|| format!("dependency {id} is missing"))?;
            let commit = dependency.accepted_commit().with_context(|| format!("dependency {id} has no accepted commit; verify its result before starting {}", piece.id))?;
            Ok((id.as_str(), commit))
        }).collect::<anyhow::Result<Vec<_>>>()?;
        dependency_base(Path::new(&lead.cwd), &dependencies)
    }

    fn create_worker(&self, run: &Run, piece: &Piece, mode: &str) -> anyhow::Result<Started> {
        let lead = index::get(&run.lead.session_id).context("the lead's session is gone")?;
        let base = self.worker_base(run, piece)?;
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
                base_ref: Some(base.clone()),
                // Each try has a worktree and a branch of its own: the one before it keeps its.
                worktree_name: Some(match piece.tries.len() {
                    0 | 1 => format!("{}-{}", piece.id, piece.title),
                    tries => format!("{}-try{tries}-{}", piece.id, piece.title),
                }),
                issue: None,
                automation: None,
                cwd: None,
                tab: Some(NewTab { harness: piece.agent.clone(), transport: AgentTransport::Pty, model: piece.model.clone(), effort: piece.effort.clone(), permission_mode: Some(mode.to_string()) }),
                orchestrate: false,
            },
            None,
        )
        .map_err(|error| anyhow!("{error}"))?;
        let tab = entry.tabs.first().ok_or_else(|| anyhow!("the new session has no tab"))?;
        // It is marked a worker as it is made (`session_ops::inherit_run_limits`), while this
        // lead's start is under way; `secure_worker` checks that before it is briefed.
        Ok(Started { session_id: entry.id.clone(), tab_id: tab.id.clone(), branch: entry.branch.clone(), base_commit: Some(base) })
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
            Some(status) => WorkerNow::Reported { status, result: text("result"), report: super::TryReport::of_row(&row) },
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
            // Accepted results can unblock dependencies after the turn-end
            // scheduler already ran while the checks were still pending.
            engine::fill_slots(&host);
        });
        if let Err(error) = spawned {
            log::warn!("start the check of run {run_id}: {error}");
        }
    }

    fn check(&self, run: &Run, piece: &Piece, worker: &SessionRef, known: &verify::Known) -> Checked {
        let Ok(session) = index::get(&worker.session_id) else {
            return Checked::unreadable(Gate::Branch, "The worker's session was deleted, so its worktree cannot be checked.");
        };
        let base = match index::get(&run.lead.session_id).context("the lead's session is gone").and_then(|lead| lead_base(Path::new(&lead.cwd))) {
            Ok(base) => base,
            Err(error) => return Checked::unreadable(Gate::Scope, format!("The lead's branch could not be read, so there is nothing to compare the result with: {error:#}")),
        };
        // The project's own check, the one its pipelines run before a merge.
        let project_check = crate::store::projects::issue_pipeline_settings(&run.project_path).ok().and_then(|settings| settings.local_check_command);
        // The mode the worker was started in decides, with the person's approval, whether its commands are run unasked.
        let commands = verify::may_run_commands(run.approval.is_some(), piece.started_mode.as_deref().unwrap_or_else(|| piece.mode(&run.worker_mode)));
        let marks = crate::store::root().ok().map(|root| root.join("run-checks"));
        verify::gates(&Checkout { cwd: session.cwd.into(), base, branch: piece.branch.clone(), commands, marks }, piece, project_check.as_deref(), verify::COMMAND_TIMEOUT, known)
    }

    fn on_base(&self, run: &Run, _piece: &Piece, worker: &SessionRef, base: &str, commit: &str, command: &verify::CommandRun) -> verify::CommandRun {
        let not_run = |why: String| verify::CommandRun { run: command.run.clone(), project: command.project, exit_code: None, passed: false, millis: 0, output: Some(why), on_base: None };
        let Ok(session) = index::get(&worker.session_id) else { return not_run("The worker's session was deleted, so the commit its result started from could not be found.".into()) };
        let root = match crate::store::root() {
            Ok(root) => root.join("run-bases"),
            Err(error) => return not_run(format!("The app's own folder could not be read: {error:#}")),
        };
        match base_checkout(Path::new(&session.cwd), &root, &run.project_path, base, commit) {
            Ok((checkout, _held)) => verify::run_command(&checkout, &command.run, command.project, verify::COMMAND_TIMEOUT),
            Err(error) => not_run(format!("The commit the result started from could not be checked out: {error:#}")),
        }
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
            Some(worker_report::OpenTurn::Waiting) if view.recovery.is_some() && !view.asks => return VerifierNow::Stuck("It stopped on an error and gave no verdict.".into()),
            Some(worker_report::OpenTurn::Waiting) => return VerifierNow::Waiting("It needs an answer to a permission request or question. Open its conversation to continue the review.".into()),
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

    fn check_reset(&self, worker: &SessionRef) {
        if let (Ok(session), Ok(root)) = (index::get(&worker.session_id), crate::store::root()) {
            verify::forget_clean(&root.join("run-checks"), Path::new(&session.cwd));
        }
    }

    fn result_commit(&self, worker: &SessionRef) -> Option<String> {
        let session = index::get(&worker.session_id).ok()?;
        crate::git::head_commit(Path::new(&session.cwd))
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
        // A bot's item that waits to check back when this run reports (PRO-476).
        crate::bots::runs::lead_told(&self.manager, run);
    }

    fn changed(&self, run: &Run) {
        self.sink.emit(RUN_EVENT, &super::engine::shown(run));
    }

    fn login(&self, agent: &str) -> Login {
        if crate::agent_keys::uses_saved_key(agent) { Login::ApiKey } else { Login::Subscription }
    }

    fn windows(&self) -> Vec<crate::status::usage::UsageWindow> {
        self.manager.usage_windows()
    }

    fn activity(&self, worker: &SessionRef) -> Activity {
        let Some(tab) = worker.tab_id.as_deref() else { return Activity::default() };
        let mut activity = match self.manager.load_events(&worker.session_id, tab) {
            Ok(events) => activity_of(&events),
            // Unread is not idle: no stall is called on no evidence.
            Err(_) => return Activity { command_running: true, ..Activity::default() },
        };
        activity.busy = match self.manager.resource_sample() {
            Ok(sample) => sample.processes.iter().any(|process| process.session_id.as_deref() == Some(worker.session_id.as_str()) && process.tab_id.as_deref() == Some(tab) && process.cpu_percent.is_some_and(|cpu| cpu >= BUSY_CPU_PERCENT)),
            Err(_) => true,
        };
        activity
    }

    fn fill_later(&self) {
        let host = self.clone();
        std::thread::spawn(move || engine::fill_slots(&host));
    }

    fn watch(&self) {
        let mut watcher = WATCHER.lock().unwrap_or_else(|error| error.into_inner());
        watcher.1 += 1;
        if watcher.0 {
            return;
        }
        watcher.0 = true;
        let host = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(WATCH_EVERY);
            let asked = WATCHER.lock().unwrap_or_else(|error| error.into_inner()).1;
            let more = engine::watch(&host);
            let mut watcher = WATCHER.lock().unwrap_or_else(|error| error.into_inner());
            if !more && watcher.1 == asked {
                watcher.0 = false;
                return;
            }
        });
    }

    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    fn lead_head(&self, run: &Run) -> Option<String> {
        let cwd = self.lead_checkout(run).ok()?;
        crate::git::run(&cwd, &["rev-parse", "--verify", "HEAD^{commit}"]).ok().map(|head| head.trim().to_string()).filter(|head| !head.is_empty())
    }

    fn piece_in_lead(&self, run: &Run, piece: &Piece) -> anyhow::Result<Option<engine::LeadWork>> {
        let cwd = self.lead_checkout(run)?;
        let Some((branch, base)) = piece.tries.iter().rev().filter(|attempt| attempt.step != super::ladder::Step::Lead).find_map(|attempt| Some((attempt.branch.clone().or_else(|| piece.branch.clone())?, attempt.base_commit.clone()?))) else { return Ok(None) };
        let Ok(tip) = crate::git::run(&cwd, &["rev-parse", "--verify", &format!("{branch}^{{commit}}")]) else { return Ok(None) };
        let tip = tip.trim().to_string();
        let head = crate::git::run(&cwd, &["rev-parse", "--verify", "HEAD^{commit}"])?.trim().to_string();
        // Its work must be in the lead's branch: else finishing would count a result the branch does not have.
        if tip == base || !matches!(crate::git::raw(&cwd, &["merge-base", "--is-ancestor", &tip, &head]), Some((0, _))) {
            return Ok(None);
        }
        Ok(Some(engine::LeadWork { head, changes: held_changes(&cwd, &base, &tip)?, uncommitted: Vec::new() }))
    }

    fn lead_work(&self, run: &Run, since: &str) -> anyhow::Result<engine::LeadWork> {
        let cwd = self.lead_checkout(run)?;
        let head = crate::git::run(&cwd, &["rev-parse", "--verify", "HEAD^{commit}"])?.trim().to_string();
        let changes = held_changes(&cwd, since, &head)?;
        let uncommitted = crate::git::run(&cwd, &["status", "--porcelain", "--untracked-files=no", "--"])?.lines().filter(|line| !line.trim().is_empty()).map(|line| line.get(3..).unwrap_or(line).trim().to_string()).collect();
        Ok(engine::LeadWork { head, changes, uncommitted })
    }

    fn lead_commands(&self, run: &Run, piece: &Piece, by_lead: bool) -> Result<Vec<verify::CommandRun>, String> {
        let cwd = self.lead_checkout(run).map_err(|error| format!("{error:#}"))?;
        // No other writer while they run: the checkout is held as a merge holds it.
        let _reserved = self.reserve(run, &cwd, by_lead)?;
        let mut ran = Vec::new();
        for command in piece.done_checks.iter().filter_map(|check| match check { super::Check::Command { run } => Some(run.as_str()), _ => None }) {
            let result = verify::run_command(&cwd, command, false, verify::COMMAND_TIMEOUT);
            let passed = result.passed;
            ran.push(result);
            if !passed {
                break;
            }
        }
        Ok(ran)
    }

    fn lead_mode(&self, run: &Run) -> Option<String> {
        Checkouts::lead_mode(self, run)
    }
}

impl Checkouts for ManagerHost {
    fn retire_workers_later(&self, run: &Run) { self.queue_retirement(run); }
    fn worker_recovered(&self, worker: &SessionRef) -> bool { super::retirement::recovered(worker) }
    fn stop_agents_for_cleanup(&self, worker: &SessionRef) -> anyhow::Result<bool> { Host::stop_worker_for_cleanup(self, worker) }
    fn preserve_worker(&self, run: &Run, worker: &SessionRef) -> anyhow::Result<()> { Host::preserve_worker(self, run, worker) }
    fn archive_worker(&self, run: &Run, worker: &SessionRef) -> anyhow::Result<()> { Host::archive_worker(self, run, worker) }
    fn run_pr_merged(&self, run: &Run) -> anyhow::Result<bool> { Ok(super::retirement::merged_pr(run)?.is_some()) }
    fn preserve_worker_tip(&self, run: &Run, worker: &SessionRef, worktree: &Worktree, tip: &str) -> anyhow::Result<()> {
        Host::preserve_worker(self, run, worker)?;
        anyhow::ensure!(super::retirement::preserved(Path::new(&run.project_path), &worktree.path, tip), "The exact worker tip is not preserved");
        Ok(())
    }

    fn lead_checkout(&self, run: &Run) -> anyhow::Result<PathBuf> {
        Ok(PathBuf::from(index::get(&run.lead.session_id).context("the lead's session is gone")?.cwd))
    }

    fn lead_mode(&self, run: &Run) -> Option<String> {
        let lead = index::get(&run.lead.session_id).ok()?;
        let tab = run.lead.tab_id.as_deref().and_then(|tab| lead.tab(tab)).or_else(|| lead.tabs.iter().find(|tab| !tab.is_terminal()))?;
        Some(tab.permission_mode.clone())
    }

    fn reserve(&self, run: &Run, cwd: &Path, by_lead: bool) -> Result<Box<dyn std::any::Any + Send>, String> {
        use crate::issue_pipeline::admission::{self, Kind, Scope};
        let canonical = |path: &Path| crate::paths::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let checkout = canonical(cwd);
        // The lock a prompt is admitted under, and a pipeline reserves a checkout under: what is
        // found free here cannot be taken before the fence stands.
        let _admission = admission::lock();
        let pipelines = crate::issue_pipeline::store::list().map_err(|error| format!("the pipelines could not be read ({error:#})."))?;
        for pipeline in pipelines.iter().filter(|pipeline| pipeline.checking_locally || pipeline.resolution.is_some()) {
            let Ok(author) = index::get(&pipeline.author.session_id) else { continue };
            if canonical(Path::new(&author.cwd)) == checkout {
                return Err(if pipeline.checking_locally { "TerminalX is running a pipeline's checks in it.".into() } else { "it is reserved for a pipeline's conflict resolver.".into() });
            }
        }
        let sessions = index::load().map_err(|error| format!("the sessions could not be read ({error:#})."))?;
        // Every conversation that works on this checkout's files, from its top or a folder of it:
        // the ones the fence closes.
        for session in sessions.iter().filter(|session| admission::in_working_tree(&checkout, Path::new(&session.cwd))) {
            for tab in &session.tabs {
                // The lead's own turn is the one that asked. Named with `--lead`, its tab is not known: none of its agents is waited for.
                let asking = by_lead && session.id == run.lead.session_id && run.lead.tab_id.as_deref().is_none_or(|lead| lead == tab.id);
                if asking || tab.is_terminal() {
                    continue;
                }
                if !self.manager.pipeline_idle(&session.id, &tab.id) {
                    return Err(format!("the conversation \"{}\" is in a turn there.", session.title));
                }
            }
        }
        Ok(Box::new(admission::fence(Kind::Refuse(admission::RUN_MERGING), [Scope::working_tree(&checkout)])))
    }

    fn project_check(&self, project_path: &str) -> Option<String> {
        crate::store::projects::issue_pipeline_settings(project_path).ok().and_then(|settings| settings.local_check_command)
    }

    fn open_prs_into(&self, cwd: &Path, branch: &str) -> Option<Vec<u64>> {
        // A repository with no remote has no pull request to ask about.
        if crate::git::run(cwd, &["remote"]).ok()?.trim().is_empty() {
            return Some(Vec::new());
        }
        match crate::github::list_prs(cwd, &["--base", branch, "--state", "open", "--json", "number", "--limit", "20"]) {
            Ok(prs) => Some(prs.iter().filter_map(|pr| pr["number"].as_u64()).collect()),
            Err(error) => {
                // Not a GitHub repository, or gh is missing or signed out: the branch checks on refs still hold.
                log::info!("open pull requests into {branch} could not be read: {error:#}");
                None
            }
        }
    }

    fn worktree(&self, worker: &SessionRef) -> Option<Worktree> {
        let session = index::get(&worker.session_id).ok()?;
        let path = PathBuf::from(&session.cwd);
        // A worktree of its own, of this project: never the project's own checkout.
        if !path.is_dir() || !crate::git::is_own_worktree(&path) || !crate::git::is_worktree_of(Path::new(&session.project_path), &path) || crate::worktree_control::same_folder(&session.cwd, &session.project_path) {
            return None;
        }
        let busy = session.tabs.iter().any(|tab| !tab.is_terminal() && self.manager.is_running(&session.id, &tab.id));
        Some(Worktree { path, busy })
    }

    fn remove(&self, run: &Run, worker: &SessionRef, worktree: &Worktree, still_safe: &dyn Fn() -> Result<(), String>) -> anyhow::Result<()> {
        let path = worktree.path.to_string_lossy().into_owned();
        let expected = [worker.session_id.clone()];
        let superseded = run.superseded_workers().iter().any(|w| w.session_id == worker.session_id);
        let request = crate::session_ops::WorkspaceRemoval {
            project_path: &run.project_path,
            path: &path,
            sessions: if run.superseded_workers().iter().any(|w| w.session_id == worker.session_id) { crate::session_ops::SessionsFate::Keep } else { crate::session_ops::SessionsFate::Delete },
            // Never the branch: what was merged is named by it, and what was not is kept by it.
            delete_branch: false,
            // `cleanup` has looked already, and looks again through `guard`: clean, and every commit in the
            // lead's branch (or, with the lead gone, in the project's base branch).
            confirmation: if run.superseded_workers().iter().any(|w| w.session_id == worker.session_id) { crate::session_ops::Confirmation::Single } else { crate::session_ops::Confirmation::Forced },
            // Only the worker's own session goes: one somebody else opened there keeps the worktree.
            expected_sessions: Some(&expected),
            direct: crate::git::DirectDelete::Never,
            fetch: if superseded { crate::landed::Fetch::Fresh } else { crate::landed::Fetch::Skip },
            guard: Some(still_safe),
            archive: superseded.then(|| crate::archive_script::Runner { terminals: self.manager.terminals(), sink: &self.sink, unattended: true }),
            archive_failure: None,
            archive_retry: None,
            archive_started: None,
        };
        crate::session_ops::remove_workspace_fallible(&*self.sink, &request, &|entry| self.manager.stop_session_confirmed(entry).map_err(|error| format!("{error:#}"))).map_err(|error| anyhow!("{error}"))?;
        Ok(())
    }

    fn stop_agents(&self, worker: &SessionRef) -> anyhow::Result<bool> {
        Host::stop_worker(self, worker)
    }

    fn changed(&self, run: &Run) {
        self.sink.emit(RUN_EVENT, &super::engine::shown(run));
    }
}

#[cfg(test)]
mod tests {
    use super::activity_of;
    use crate::events::AgentEvent;
    use serde_json::json;

    fn git(cwd: &std::path::Path, args: &[&str]) -> String {
        crate::git::run(cwd, args).unwrap().trim().to_string()
    }

    #[cfg(unix)]
    #[test]
    fn what_a_lead_changed_names_both_sides_of_a_rename_and_every_path_as_it_is() {
        let repo = repository();
        std::fs::create_dir_all(repo.path().join("secret")).unwrap();
        std::fs::create_dir_all(repo.path().join("src")).unwrap();
        let base = commit_file(repo.path(), "secret/key.rs", "let key = 1;\n");
        // Moved into the piece's files from outside them, and a name git would quote.
        git(repo.path(), &["mv", "secret/key.rs", "src/cli.rs"]);
        git(repo.path(), &["commit", "-qm", "move"]);
        let head = commit_file(repo.path(), "src/a b\tc.rs", "x\n");
        let changes = super::held_changes(repo.path(), &base, &head).unwrap();
        let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
        assert_eq!(paths, vec!["secret/key.rs", "src/a b\tc.rs", "src/cli.rs"]);
        assert_eq!((changes[0].added, changes[0].removed), (Some(0), Some(1)));
        let owns = vec!["src/**".to_string()];
        let outside: Vec<&str> = paths.into_iter().filter(|path| !crate::orchestration::plan::owns(&owns, path)).collect();
        assert_eq!(outside, vec!["secret/key.rs"], "the file it came from is outside the piece");
    }

    fn commit_file(cwd: &std::path::Path, file: &str, content: &str) -> String {
        std::fs::write(cwd.join(file), content).unwrap();
        git(cwd, &["add", file]);
        git(cwd, &["commit", "-qm", file]);
        git(cwd, &["rev-parse", "HEAD"])
    }

    fn repository() -> tempfile::TempDir {
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-q", "-b", "lead"]);
        git(repo.path(), &["config", "user.name", "T"]);
        git(repo.path(), &["config", "user.email", "t@example.com"]);
        commit_file(repo.path(), "README", "initial\n");
        repo
    }

    fn worktree(repo: &std::path::Path, name: &str, base: &str) -> std::path::PathBuf {
        let path = repo.join(name);
        git(repo, &["worktree", "add", "-q", "-b", name, path.to_str().unwrap(), base]);
        path
    }

    fn consumer() -> super::Piece {
        use super::super::{plan, routing};
        let agents = ["claude".to_string()];
        let rules = plan::Rules { piece_limit: 8, default_agent: "claude", agents: &agents, worker_mode: "bypassPermissions", approval: true, checkout: None, routing: &routing::tests::TABLE, models: &routing::tests::MODELS, lead_model: "fable" };
        let plan = serde_json::from_value(json!({"goal": "Use accepted contracts", "pieces": [{
            "id": "consumer", "title": "Consumer", "kind": "code", "owns": ["consumer.ts"],
            "doneChecks": [{"type": "command", "run": "test -f contracts.ts && test -f config.ts && test -f consumer.ts"}]
        }]})).unwrap();
        plan::validate(&plan, &rules).unwrap().remove(0)
    }

    #[test]
    fn dependent_worktrees_include_only_accepted_inputs_and_verify_only_their_own_changes() {
        use super::super::{ladder::Step, verify, Try};
        let _home = crate::store::temp_home();
        let repo = repository();
        let lead = git(repo.path(), &["rev-parse", "HEAD"]);
        let contracts = worktree(repo.path(), "contracts", "lead");
        let accepted = commit_file(&contracts, "contracts.ts", "export type Contract = string;\n");
        let config = worktree(repo.path(), "config", "lead");
        let configuration = commit_file(&config, "config.ts", "export const enabled = true;\n");
        // A later, unverified dependency tip must never leak into the consumer.
        commit_file(&contracts, "unverified.ts", "not accepted\n");
        let base = super::dependency_base(repo.path(), &[("contracts", &accepted), ("config", &configuration)]).unwrap();
        assert_eq!(git(repo.path(), &["rev-parse", "HEAD"]), lead);
        assert!(!repo.path().join("contracts.ts").exists(), "the lead checkout is untouched");
        let cwd = worktree(repo.path(), "consumer", &base);
        assert!(cwd.join("contracts.ts").exists() && cwd.join("config.ts").exists());
        assert!(!cwd.join("unverified.ts").exists());
        // Both accepted commits remain ancestors for the final dependency-order merge.
        for accepted in [&accepted, &configuration] {
            git(&cwd, &["merge-base", "--is-ancestor", accepted, "HEAD"]);
        }
        let mut piece = consumer();
        let mut attempt = Try::planned(Step::First, "", None, None);
        attempt.base_commit = Some(base.clone());
        // The baseline survives persistence and restart.
        piece.tries.push(serde_json::from_str(&serde_json::to_string(&attempt).unwrap()).unwrap());
        commit_file(&cwd, "consumer.ts", "import type { Contract } from './contracts';\n");
        let checkout = verify::Checkout { cwd: cwd.clone(), base: "lead".into(), branch: Some("consumer".into()), commands: true, marks: None };
        let checked = verify::gates(&checkout, &piece, None, std::time::Duration::from_secs(10), &verify::Known::default());
        assert!(checked.passed(), "{:?}", checked.gates);
        assert_eq!(checked.base, base);
        assert_eq!(checked.facts.files, ["consumer.ts"]);
        assert!(checked.diff.contains("diff --git a/consumer.ts"));
        assert!(!checked.diff.contains("diff --git a/contracts.ts"));

        // Lead conflict checks still use the live lead branch, not the scope baseline.
        commit_file(repo.path(), "consumer.ts", "conflicting lead implementation\n");
        let checked = verify::gates(&checkout, &piece, None, std::time::Duration::from_secs(10), &verify::Known::default());
        assert!(checked.gates.iter().any(|gate| gate.gate == verify::Gate::Branch && !gate.passed));
        // Inherited files are not exempt from ownership: editing them is still refused.
        commit_file(&cwd, "contracts.ts", "unauthorized change\n");
        let checked = verify::gates(&checkout, &piece, None, std::time::Duration::from_secs(10), &verify::Known::default());
        assert_eq!((checked.gates[0].gate, checked.gates[0].passed), (verify::Gate::Scope, false));
        assert!(checked.gates[0].detail.as_ref().unwrap().contains("contracts.ts"));
        // Rewriting history cannot discard the accepted starting code unnoticed.
        git(&cwd, &["reset", "--hard", &lead]);
        commit_file(&cwd, "consumer.ts", "missing dependencies\n");
        let checked = verify::gates(&checkout, &piece, None, std::time::Duration::from_secs(10), &verify::Known::default());
        assert!(checked.gates[0].detail.as_ref().unwrap().contains("starting commit"));
    }

    #[test]
    fn conflicting_or_missing_dependencies_fail_without_changing_the_lead() {
        let repo = repository();
        let left = worktree(repo.path(), "left", "lead");
        let left_commit = commit_file(&left, "shared.ts", "left\n");
        let right = worktree(repo.path(), "right", "lead");
        let right_commit = commit_file(&right, "shared.ts", "right\n");
        let head = git(repo.path(), &["rev-parse", "HEAD"]);
        let status = git(repo.path(), &["status", "--porcelain"]);
        let error = super::dependency_base(repo.path(), &[("left", &left_commit), ("right", &right_commit)]).unwrap_err();
        assert!(format!("{error:#}").contains("dependency right cannot be combined"));
        let error = super::dependency_base(repo.path(), &[("missing", &"0".repeat(40))]).unwrap_err();
        assert!(format!("{error:#}").contains("dependency missing is unavailable"));
        assert_eq!(git(repo.path(), &["rev-parse", "HEAD"]), head);
        assert_eq!(git(repo.path(), &["status", "--porcelain"]), status);
        assert!(crate::git::operation_in_progress(repo.path()).unwrap().is_none());
    }

    fn event(seq: u64, ts: &str, payload: serde_json::Value) -> AgentEvent {
        serde_json::from_value(json!({"id": format!("e{seq}"), "sessionId": "w", "tabId": "t", "harness": "claude", "seq": seq, "ts": ts, "payload": payload})).unwrap()
    }

    fn ms(ts: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(ts).unwrap().timestamp_millis()
    }

    #[test]
    fn a_command_still_running_is_work_and_the_last_tool_call_or_edit_is_the_last_activity() {
        let started = |seq, ts, id: &str| event(seq, ts, json!({"type": "tool_call_started", "callId": id, "name": "Bash", "toolType": "shell", "input": {"command": "cargo build"}}));
        let done = |seq, ts, id: &str| event(seq, ts, json!({"type": "tool_call_completed", "callId": id, "result": {"text": "ok"}}));
        // An earlier turn's open call does not count: only the open turn's.
        let earlier = vec![
            event(1, "2026-11-11T09:00:00Z", json!({"type": "turn_started"})),
            started(2, "2026-11-11T09:00:01Z", "old"),
            event(3, "2026-11-11T10:00:00Z", json!({"type": "turn_started"})),
        ];
        let idle = activity_of(&earlier);
        assert_eq!((idle.last_ms, idle.command_running), (Some(ms("2026-11-11T10:00:00Z")), false));

        // A ten-minute build: its call has not returned.
        let mut building = earlier.clone();
        building.push(started(4, "2026-11-11T10:01:00Z", "build"));
        let activity = activity_of(&building);
        assert!(activity.command_running);
        assert_eq!(activity.last_ms, Some(ms("2026-11-11T10:01:00Z")));

        // It returned, and a file was edited after: that edit is the last activity.
        building.push(done(5, "2026-11-11T10:11:00Z", "build"));
        building.push(event(6, "2026-11-11T10:12:30Z", json!({"type": "file_edits", "edits": []})));
        let activity = activity_of(&building);
        assert!(!activity.command_running);
        assert_eq!(activity.last_ms, Some(ms("2026-11-11T10:12:30Z")));

        // A background task of its counts as a command running.
        building.push(event(7, "2026-11-11T10:13:00Z", json!({"type": "background_tasks_changed", "tasks": [{"id": "b1", "label": "npm test"}]})));
        assert!(activity_of(&building).command_running);
        building.push(event(8, "2026-11-11T10:20:00Z", json!({"type": "background_tasks_changed", "tasks": []})));
        assert!(!activity_of(&building).command_running);
    }

    /// #1004: a failing check is run again on the commit the result forks from, in a checkout
    /// of the app's own that is kept between checks: what a command left there goes, and
    /// what is ignored (build output) stays.
    #[test]
    fn a_check_runs_on_the_base_in_a_checkout_of_the_apps_own_kept_between_checks() {
        let repo = repository();
        commit_file(repo.path(), ".gitignore", "target/\n");
        let base = commit_file(repo.path(), "check.sh", "test \"$(cat state)\" = good\n");
        commit_file(repo.path(), "state", "bad\n");
        let fork = git(repo.path(), &["rev-parse", "HEAD"]);
        let worker = worktree(repo.path(), "worker", &fork);
        let result = commit_file(&worker, "state", "good\n");
        let root = tempfile::tempdir().unwrap();
        let (dir, held) = super::base_checkout(&worker, root.path(), "/projects/app", "lead", &result).unwrap();
        // At the fork, not at the result nor in the worker's worktree.
        assert!(dir.starts_with(root.path()));
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), fork);
        let ran = super::verify::run_command(&dir, "sh check.sh", false, std::time::Duration::from_secs(10));
        assert_eq!((ran.passed, ran.exit_code), (false, Some(1)));
        assert!(super::verify::run_command(&worker, "sh check.sh", false, std::time::Duration::from_secs(10)).passed);
        // What a command leaves in it goes before the next check; what is ignored stays.
        std::fs::write(dir.join("left-over"), "x").unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join("target/cache"), "built").unwrap();
        drop(held);
        let (again, _held) = super::base_checkout(&worker, root.path(), "/projects/app", &base, &result).unwrap();
        assert_eq!((again.clone(), git(&again, &["rev-parse", "HEAD"])), (dir.clone(), base.clone()));
        assert!(!again.join("left-over").exists() && again.join("target/cache").exists());
        // The repository knows it as a worktree of its own, detached: no branch is held.
        // Git spells a worktree's path with `/`, on Windows too.
        let listed = format!("worktree {}\nHEAD", crate::paths::canonicalize(&dir).unwrap().display()).replace('\\', "/");
        assert!(git(repo.path(), &["worktree", "list", "--porcelain"]).contains(&listed));
        // The project's last run ended: the checkout goes, with what was built in it, and the repository forgets it.
        drop(_held);
        super::drop_base_checkout(repo.path(), root.path(), "/projects/app").unwrap();
        assert!(!dir.exists());
        assert!(!git(repo.path(), &["worktree", "list", "--porcelain"]).contains(&listed));
        super::drop_base_checkout(repo.path(), root.path(), "/projects/app").unwrap();
        // The next check makes it again.
        let (made, _held) = super::base_checkout(&worker, root.path(), "/projects/app", &base, &result).unwrap();
        assert_eq!((made, git(&dir, &["rev-parse", "HEAD"])), (dir.clone(), base));
    }

    #[test]
    fn checks_of_one_project_take_turns_in_its_base_checkout_and_other_projects_do_not_wait() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let first = super::hold_base("/projects/turns-a");
        // Another project's check holds its own at once.
        let other = std::thread::spawn(|| drop(super::hold_base("/projects/turns-b")));
        other.join().unwrap();
        // A second check of the same project waits until the first lets go.
        let got = Arc::new(AtomicBool::new(false));
        let waiting = {
            let got = got.clone();
            std::thread::spawn(move || {
                let _held = super::hold_base("/projects/turns-a");
                got.store(true, Ordering::SeqCst);
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!got.load(Ordering::SeqCst), "it waits while the first holds the checkout");
        drop(first);
        waiting.join().unwrap();
        assert!(got.load(Ordering::SeqCst));
    }
}
