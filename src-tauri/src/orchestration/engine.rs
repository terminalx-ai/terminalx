//! What happens to a run: stored, approved, started, refreshed, stopped.
//!
//! Everything a run does to a session goes through [`Host`], so the rules
//! here (which pieces may start, what a worker's report makes of its piece,
//! what a stop leaves behind) are the same against the app's sessions
//! ([`super::host::ManagerHost`]) and against the stand-in the tests use.
//!
//! A piece's state follows its worker: the report its last turn ended with
//! decides it, each time the run is read. Nothing here polls. A worker's turn
//! ending refreshes its run ([`worker_turn_ended`]), and so does every
//! command that reads one.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

use super::plan::{self, Plan, PlanError};
use super::{brief, guard, store, Approval, Piece, PieceState, Run, RunState, SessionRef};
use crate::store::settings::OrchestratorLimits;
use crate::worker_report::Status;

/// One start at a time: two callers must not both find the same piece ready.
static STARTING: Mutex<()> = Mutex::new(());

/// The session a run is created for.
pub struct Lead {
    pub project_path: String,
    /// The agent of the lead's own tab: the default for its pieces.
    pub agent: String,
    /// Workers need worktrees, so the project must be a git repository.
    pub repository: bool,
}

/// A worker session, just created for a piece.
pub struct Started {
    pub session_id: String,
    pub tab_id: String,
    pub branch: Option<String>,
}

/// What a piece's worker is doing now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerNow {
    /// In a turn, about to take its brief, or about to be reminded of its report.
    Working,
    /// Its last turn ended with a report.
    Reported { status: Status, result: String },
    /// It stopped without a report, or waits on a person: why, in a sentence.
    Stuck(String),
    /// Its session was deleted.
    Gone,
}

pub trait Host: Send + Sync {
    fn lead(&self, session_id: &str) -> Result<Lead, EngineError>;
    /// The agents a worker can be here.
    fn worker_agents(&self) -> Vec<String>;
    fn limits(&self, project_path: &str) -> OrchestratorLimits;
    /// Make the piece's worker: a session of the lead, in a worktree of its
    /// own on a branch cut from the lead's, with the piece's agent, model and
    /// effort, in `mode`. Nothing is sent to it yet.
    fn create_worker(&self, run: &Run, piece: &Piece, mode: &str) -> anyhow::Result<Started>;
    /// Make a new worker safe to brief: its branch pushes nowhere by itself. Asked again
    /// for the same session when it failed, so it must be safe to repeat.
    fn secure_worker(&self, worker: &SessionRef, branch: Option<&str>) -> anyhow::Result<()>;
    /// Send a worker its brief, and hold it to a report.
    fn brief_worker(&self, worker: &SessionRef, brief: &str) -> anyhow::Result<()>;
    fn worker(&self, worker: &SessionRef) -> WorkerNow;
    /// Stop a worker's agents. `false` when none was running.
    fn stop_worker(&self, worker: &SessionRef) -> anyhow::Result<bool>;
    /// Tell the lead what a person decided about its run.
    fn tell_lead(&self, run: &Run, text: &str);
    /// The stored run changed.
    fn changed(&self, run: &Run);
}

/// A refusal with a code a caller can branch on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub details: Value,
}

impl EngineError {
    pub fn new(code: &'static str, message: impl Into<String>, recovery: Option<&str>) -> Self {
        Self { code, message: message.into(), recovery: recovery.map(str::to_owned), details: Value::Null }
    }

    fn internal(error: anyhow::Error) -> Self {
        Self::new("internal_error", format!("{error:#}"), None)
    }

    fn not_found(id: &str) -> Self {
        Self::new("not_found", format!("No run {id}."), Some("Use a run id from `terminalx runs list --json`."))
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EngineError {}

impl From<PlanError> for EngineError {
    fn from(error: PlanError) -> Self {
        let mut details = match error.details {
            Value::Object(details) => Value::Object(details),
            _ => json!({}),
        };
        if let Some(piece) = &error.piece {
            details["piece"] = json!(piece);
        }
        Self { code: error.code, message: error.message, recovery: Some("Correct the plan and run `terminalx runs create --from` again. Nothing was stored.".into()), details }
    }
}

fn stored(id: &str) -> Result<Run, EngineError> {
    store::get(id).map_err(|_| EngineError::not_found(id))
}

fn rules_for<'a>(limits: &'a OrchestratorLimits, lead: &'a Lead, agents: &'a [String]) -> plan::Rules<'a> {
    plan::Rules { piece_limit: limits.piece_limit, default_agent: &lead.agent, agents, worker_mode: &limits.worker_mode, approval: limits.require_approval }
}

/// Validate a plan and store it as a run of `lead_session`. It waits for
/// approval unless its project asks for none.
pub fn create(host: &dyn Host, plan: &Plan, lead_session: &str, lead_tab: Option<String>) -> Result<Run, EngineError> {
    let lead = host.lead(lead_session)?;
    if !lead.repository {
        return Err(EngineError::new("not_a_repository", "A run needs a git repository: each worker gets a worktree and a branch of its own.", Some("Lead the run from a session of a project that is a git repository.")));
    }
    if let Some(open) = store::open_for_lead(lead_session).map_err(EngineError::internal)? {
        let mut error = EngineError::new("run_exists", format!("This session already leads run {}, which has not ended.", open.id), Some("Go on with it (`terminalx runs show`), or end it with `terminalx runs stop` before creating another."));
        error.details = json!({"run": open.id, "state": open.state});
        return Err(error);
    }
    let limits = host.limits(&lead.project_path);
    let agents = host.worker_agents();
    let pieces = plan::validate(plan, &rules_for(&limits, &lead, &agents))?;
    let now = crate::store::index::now();
    let run = Run {
        id: uuid::Uuid::now_v7().to_string(),
        lead: SessionRef { session_id: lead_session.to_string(), tab_id: lead_tab },
        project_path: lead.project_path,
        goal: plan.goal.trim().to_string(),
        state: if limits.require_approval { RunState::AwaitingApproval } else { RunState::Planned },
        budget: plan.budget.clone(),
        pieces,
        worker_mode: limits.worker_mode,
        plan_edited: false,
        approval: None,
        reason: None,
        created: now.clone(),
        modified: now,
    };
    store::insert(&run).map_err(EngineError::internal)?;
    host.changed(&run);
    Ok(run)
}

/// Replace the plan of a run nobody has started: what a person changes with
/// Edit before approving. The new plan passes the same rules as the first.
pub fn update_plan(host: &dyn Host, id: &str, plan: &Plan) -> Result<Run, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = stored(id)?;
    if !matches!(run.state, RunState::AwaitingApproval | RunState::Planned) {
        return Err(EngineError::new("run_started", "The plan can be changed only before the run starts.", None));
    }
    let lead = host.lead(&run.lead.session_id)?;
    let agents = host.worker_agents();
    // The run asks for approval or not as it did when it was made: an edit does not change who must see it.
    let mut limits = host.limits(&run.project_path);
    limits.require_approval = run.state == RunState::AwaitingApproval;
    let pieces = plan::validate(plan, &rules_for(&limits, &lead, &agents))?;
    let (run, ()) = store::update(id, |run| {
        run.goal = plan.goal.trim().to_string();
        run.budget = plan.budget.clone();
        run.pieces = pieces;
        run.plan_edited = true;
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&run);
    Ok(run)
}

/// A piece that waits, and the pieces it waits on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    pub piece: String,
    pub on: Vec<String>,
}

/// A piece whose worker could not be started or briefed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotStarted {
    pub piece: String,
    pub error: String,
}

/// What a start did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    pub run: Run,
    /// The pieces a worker was started for, in plan order.
    pub started: Vec<String>,
    /// The pieces still queued, each with the unfinished pieces it depends on.
    pub waiting: Vec<Waiting>,
    pub failed: Vec<NotStarted>,
}

/// Start a worker for every piece whose dependencies are done. Called again,
/// it starts the pieces that have become ready since.
pub fn start(host: &dyn Host, id: &str) -> Result<Start, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = refreshed(host, id)?;
    match run.state {
        RunState::AwaitingApproval => {
            let mut error = EngineError::new(
                "awaiting_approval",
                format!("Run {id} waits for a person to approve its plan. No worker starts before that."),
                Some("Tell the person the plan is ready to approve in the session's Run view, then end your turn. You are told here when they decide."),
            );
            error.details = json!({"run": id});
            Err(error)
        }
        state if state.ended() => Err(EngineError::new("run_ended", format!("Run {id} has ended ({}). Nothing more starts in it.", state_name(state)), Some("Create a new run for what is left."))),
        _ => launch_ready(host, id),
    }
}

/// A person approved the plan: the run starts.
pub fn approve(host: &dyn Host, id: &str) -> Result<Start, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = stored(id)?;
    if run.state != RunState::AwaitingApproval {
        return Err(EngineError::new("not_awaiting_approval", format!("Run {id} is not waiting for approval ({}).", state_name(run.state)), None));
    }
    store::update(id, |run| {
        run.approval = Some(Approval { at: crate::store::index::now() });
        run.state = RunState::Running;
        Ok(())
    })
    .map_err(EngineError::internal)?;
    let start = launch_ready(host, id)?;
    let run = &start.run;
    let lead = &run.lead.session_id;
    let edited = if run.plan_edited { format!(" They changed the plan first: read it again with `terminalx runs show {id} --json`.") } else { String::new() };
    let started = match start.started.is_empty() {
        true => "No worker could be started; `terminalx runs show` says why for each piece.".to_string(),
        false => format!("Workers were started for: {}.", start.started.join(", ")),
    };
    host.tell_lead(
        run,
        &format!(
            "The person approved the plan of run {id}.{edited} {started}\n\nWait for them with `terminalx wait --children-of {lead} --any --json`, read what they report with `terminalx sessions report --children-of {lead} --json`, and call `terminalx runs start {id} --json` again whenever a piece is done: it starts the pieces that waited on it."
        ),
    );
    Ok(start)
}

fn launch_ready(host: &dyn Host, id: &str) -> Result<Start, EngineError> {
    let run = stored(id)?;
    // Until its piece is stored, a worker is known as one by who started it.
    let _limited = guard::starting(&run.lead.session_id);
    // Pieces with no worker yet, and pieces whose worker has a session it was never briefed in.
    let ready: Vec<String> = run.pieces.iter().filter(|piece| piece.held.is_some() && piece.worker.is_some()).chain(run.ready()).map(|piece| piece.id.clone()).collect();
    let (mut started, mut failed) = (Vec::new(), Vec::new());
    for piece_id in ready {
        // Read again each time: the brief of a later piece names what earlier ones reported.
        let run = stored(id)?;
        let Some(piece) = run.piece(&piece_id) else { continue };
        let mode = piece.mode(&run.worker_mode).to_string();
        let (reference, branch) = match piece.worker.clone().filter(|_| piece.held.is_some()) {
            // The session it already has: never a second one for the same piece.
            Some(worker) => (worker, piece.branch.clone()),
            None => {
                let worker = match host.create_worker(&run, piece, &mode) {
                    Ok(worker) => worker,
                    Err(error) => {
                        let error = format!("{error:#}");
                        set_piece(id, &piece_id, |piece| {
                            piece.state = PieceState::Failed;
                            piece.note = Some(format!("Its worker could not be started: {error}"));
                        })?;
                        failed.push(NotStarted { piece: piece_id, error });
                        continue;
                    }
                };
                let reference = SessionRef { session_id: worker.session_id, tab_id: Some(worker.tab_id) };
                // Stored as soon as it exists, before anything else can fail: a session the run
                // does not know of would be made again by the next start, and left behind.
                set_piece(id, &piece_id, |piece| {
                    piece.worker = Some(reference.clone());
                    piece.branch = worker.branch.clone();
                    piece.started_mode = Some(mode.clone());
                    piece.attempts += 1;
                })?;
                (reference, worker.branch)
            }
        };
        if let Err(error) = host.secure_worker(&reference, branch.as_deref()) {
            let error = format!("{error:#}");
            set_piece(id, &piece_id, |piece| {
                piece.state = PieceState::Blocked;
                piece.held = Some(error.clone());
                piece.note = Some(format!("Its worker has a session but was not briefed: {error}"));
            })?;
            failed.push(NotStarted { piece: piece_id, error });
            continue;
        }
        // Running before the brief goes: the turn it starts may end first.
        let run = set_piece(id, &piece_id, |piece| {
            piece.held = None;
            piece.state = PieceState::Running;
            piece.note = None;
        })?;
        let piece = run.piece(&piece_id).expect("the piece was just written");
        match host.brief_worker(&reference, &brief::render(&run, piece)) {
            Ok(()) => started.push(piece_id),
            Err(error) => {
                let error = format!("{error:#}");
                set_piece(id, &piece_id, |piece| {
                    piece.state = PieceState::Blocked;
                    piece.note = Some(format!("Its worker was started but did not take its brief: {error}"));
                })?;
                failed.push(NotStarted { piece: piece_id, error });
            }
        }
    }
    let (run, ()) = store::update(id, |run| {
        if run.state == RunState::Planned {
            run.state = RunState::Running;
        }
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&run);
    let waiting = waiting(&run);
    Ok(Start { run, started, waiting, failed })
}

/// The queued pieces of a run, each with the dependencies that are not done.
pub fn waiting(run: &Run) -> Vec<Waiting> {
    run.pieces
        .iter()
        .filter(|piece| piece.state == PieceState::Queued)
        .map(|piece| Waiting { piece: piece.id.clone(), on: piece.depends_on.iter().filter(|id| run.piece(id).is_none_or(|dependency| dependency.state != PieceState::Done)).cloned().collect() })
        .collect()
}

fn set_piece(id: &str, piece_id: &str, change: impl FnOnce(&mut Piece)) -> Result<Run, EngineError> {
    let (run, ()) = store::update(id, |run| {
        if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
            change(piece);
        }
        Ok(())
    })
    .map_err(EngineError::internal)?;
    Ok(run)
}

/// The run with each piece brought up to date with its worker.
pub fn refreshed(host: &dyn Host, id: &str) -> Result<Run, EngineError> {
    let run = stored(id)?;
    if !matches!(run.state, RunState::Running | RunState::Failed) {
        return Ok(run);
    }
    // Workers are read outside the store's lock: a transcript is a file read.
    let seen: Vec<(String, SessionRef, WorkerNow)> = run
        .pieces
        .iter()
        // A piece whose worker was never briefed says why until it is; there is nothing to read from it.
        .filter(|piece| piece.state != PieceState::Stopped && piece.held.is_none())
        .filter_map(|piece| piece.worker.clone().map(|worker| (piece.id.clone(), worker.clone(), host.worker(&worker))))
        .collect();
    let (after, ()) = store::update(id, |run| {
        if !matches!(run.state, RunState::Running | RunState::Failed) {
            return Ok(());
        }
        for (piece_id, worker, now) in seen {
            // A piece whose worker was replaced meanwhile is not this worker's to decide.
            let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id && piece.worker.as_ref() == Some(&worker) && piece.state != PieceState::Stopped && piece.held.is_none()) else { continue };
            // What a worker reported stands when its session is deleted afterwards: the report
            // was read, and its branch is still in the repository.
            if piece.state == PieceState::Done && now == WorkerNow::Gone {
                continue;
            }
            let (state, note) = follows(now);
            piece.state = state;
            // A worker back at work keeps the line it last reported until it reports again.
            if state != PieceState::Running {
                piece.note = note;
            }
        }
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    if after != run {
        host.changed(&after);
    }
    Ok(after)
}

/// The state a piece takes from what its worker is doing.
fn follows(now: WorkerNow) -> (PieceState, Option<String>) {
    match now {
        WorkerNow::Working => (PieceState::Running, None),
        WorkerNow::Reported { status: Status::Done, result } => (PieceState::Done, Some(result)),
        WorkerNow::Reported { status: Status::Failed, result } => (PieceState::Failed, Some(result)),
        WorkerNow::Reported { status: Status::Partial, result } => (PieceState::Blocked, Some(format!("Reported partial: {result}"))),
        WorkerNow::Reported { status: Status::Blocked, result } => (PieceState::Blocked, Some(format!("Reported blocked: {result}"))),
        WorkerNow::Stuck(why) => (PieceState::Blocked, Some(why)),
        WorkerNow::Gone => (PieceState::Blocked, Some("Its worker session was deleted.".into())),
    }
}

/// What the pieces make of a started run. Done when every piece is; failed
/// when a piece failed and nothing is running or could start; running otherwise.
fn settle(run: &mut Run) {
    if !matches!(run.state, RunState::Running | RunState::Failed) {
        return;
    }
    let failed: Vec<&Piece> = run.pieces.iter().filter(|piece| piece.state == PieceState::Failed && piece.worker.is_some()).collect();
    let (state, reason) = if run.pieces.iter().all(|piece| piece.state == PieceState::Done) {
        (RunState::Done, None)
    } else if run.pieces.iter().any(|piece| piece.state == PieceState::Running) || !run.ready().is_empty() || failed.is_empty() {
        (RunState::Running, None)
    } else {
        let names: Vec<String> = failed.iter().map(|piece| piece.id.clone()).collect();
        let held: Vec<String> = waiting(run).into_iter().filter(|waiting| waiting.on.iter().any(|on| names.contains(on))).map(|waiting| waiting.piece).collect();
        let held = if held.is_empty() { String::new() } else { format!(" {} cannot start without it.", held.join(", ")) };
        (RunState::Failed, Some(format!("{} failed.{held}", names.join(", "))))
    };
    run.state = state;
    run.reason = reason;
}

/// Who stopped a run: the lead is told when it was not the lead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum By {
    Person,
    Cli,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub run: Run,
    /// The pieces whose worker was running and was stopped.
    pub stopped: Vec<String>,
    /// The pieces whose worker would not stop. The run is stopped all the same.
    pub failed: Vec<NotStarted>,
}

/// Stop every running worker and mark the run stopped. A plan nobody
/// approved is discarded the same way. Workers' sessions, worktrees and
/// branches stay as they are.
pub fn stop(host: &dyn Host, id: &str, by: By) -> Result<Stop, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    // Read the workers first: a piece whose worker has just reported done is done, not stopped.
    let run = refreshed(host, id)?;
    if run.state == RunState::Done {
        return Err(EngineError::new("run_ended", format!("Run {id} is done: every piece finished. There is nothing to stop."), None));
    }
    let waited = run.state == RunState::AwaitingApproval;
    let (mut stopped, mut failed) = (Vec::new(), Vec::new());
    for piece in &run.pieces {
        let Some(worker) = &piece.worker else { continue };
        match host.stop_worker(worker) {
            Ok(true) => stopped.push(piece.id.clone()),
            Ok(false) => {}
            // One that would not stop does not keep the rest running.
            Err(error) => failed.push(NotStarted { piece: piece.id.clone(), error: format!("{error:#}") }),
        }
    }
    let (after, ()) = store::update(id, |run| {
        for piece in run.pieces.iter_mut().filter(|piece| piece.state != PieceState::Done) {
            piece.state = PieceState::Stopped;
        }
        run.state = RunState::Stopped;
        run.reason = Some(match (by, waited) {
            (By::Person, true) => "A person discarded the plan.",
            (By::Person, false) => "A person stopped the run.",
            (By::Cli, _) => "Stopped with `terminalx runs stop`.",
        }.to_string());
        Ok(())
    })
    .map_err(EngineError::internal)?;
    if after != run {
        host.changed(&after);
        if by == By::Person {
            let said = if waited { format!("The person discarded the plan of run {id}. No worker was started. Ask them what to change before you plan again.") } else { format!("The person stopped run {id}. Its workers were stopped; their sessions and branches are as they left them. Do not start another run for this unless they ask.") };
            host.tell_lead(&after, &said);
        }
    }
    Ok(Stop { run: after, stopped, failed })
}

/// A turn ended in `session_id`: if it is a run's worker, its piece follows.
pub fn worker_turn_ended(host: &dyn Host, session_id: &str) {
    match store::for_worker(session_id) {
        Ok(Some((run, _))) => {
            if let Err(error) = refreshed(host, &run.id) {
                log::warn!("refresh run {} after its worker {session_id} ended a turn: {error}", run.id);
            }
        }
        Ok(None) => {}
        Err(error) => log::warn!("read the runs after {session_id} ended a turn: {error:#}"),
    }
}

/// A run as `runs show` returns it: the run, what it would start next, and
/// what waits on what.
pub fn shown(run: &Run) -> Value {
    let (estimate, unestimated) = run.estimate();
    let mut value = serde_json::to_value(run).unwrap_or_else(|_| json!({}));
    value["ready"] = json!(if matches!(run.state, RunState::Planned | RunState::Running) { run.ready().iter().map(|piece| piece.id.clone()).collect() } else { Vec::<String>::new() });
    value["waiting"] = json!(waiting(run));
    value["estimate"] = json!(estimate);
    value["unestimated"] = json!(unestimated);
    value
}

fn state_name(state: RunState) -> String {
    serde_json::to_value(state).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}
