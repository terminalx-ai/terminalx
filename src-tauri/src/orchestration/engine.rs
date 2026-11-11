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
//!
//! A try that falls short (a `failed` or `partial` report, or a done-check
//! that does not hold, [`check_failed`]) is followed by the next step of the
//! ladder ([`super::ladder`]): the piece is queued again on what that step
//! names, and a fresh worker is started for it with the failure text in its
//! brief. No model decides any of this. When the ladder runs out the piece
//! is `blocked`, with what was tried in its note.
//!
//! A `done` report is a claim, not acceptance. The piece is `verifying`
//! until its result has passed the gates ([`super::verify`]): its report,
//! the files it touched, the state of its branch and the plan's commands are
//! checked with no model ([`verify`]), off the thread that read the report,
//! and a verifier session reads the diff only where those cannot settle it.
//! A gate that fails is a try that fell short: what the gate printed is the
//! failure text of the same ladder.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

use super::ladder::{self, Step, Verdict};
use super::plan::{self, Plan, PlanError};
use super::routing::{self, LeadModel};
use super::verify::{self as checks, Gate, GateResult, Tally, Verification, Verifier};
use super::{brief, guard, store, Approval, Outcome, Piece, PieceState, Run, RunState, SessionRef, Try};
use crate::models::Model;
use crate::store::settings::OrchestratorLimits;
use crate::worker_report::Status;

/// One start at a time: two callers must not both find the same piece ready.
static STARTING: Mutex<()> = Mutex::new(());

/// The session a run is created for.
pub struct Lead {
    pub project_path: String,
    /// The agent of the lead's own tab: the default for its pieces.
    pub agent: String,
    /// The model of the lead's own tab: what a piece runs on when its tier
    /// has no installed model. Empty for the agent's default.
    pub model: String,
    /// Workers need worktrees, so the project must be a git repository.
    pub repository: bool,
    /// The lead's own checkout: where a path a piece owns is looked up.
    pub cwd: String,
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
    /// Its last turn ended, it was reminded once, and there is still no
    /// report that can be read: what is wrong with the reply. Gate 1 fails.
    NoReport(String),
    /// It stopped without a report, or waits on a person: why, in a sentence.
    Stuck(String),
    /// Its session was deleted.
    Gone,
}

/// What a verifier of a piece's result is doing now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifierNow {
    /// Reading, or about to take its prompt.
    Working,
    /// Its last turn ended with this reply.
    Replied(String),
    /// It stopped without a reply, or waits on a person: why, in a sentence.
    Stuck(String),
    /// Its conversation was closed.
    Gone,
}

/// What a worker's session has used, at API list prices.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cost {
    /// `None` before any usage was read, and when no model used has a price.
    pub usd: Option<f64>,
    /// Models whose tokens the cost leaves out.
    pub unpriced_models: Vec<String>,
}

pub trait Host: Send + Sync {
    fn lead(&self, session_id: &str) -> Result<Lead, EngineError>;
    /// The agents a worker can be here.
    fn worker_agents(&self) -> Vec<String>;
    /// The models the agents' CLIs list: a tier is resolved against them.
    fn models(&self) -> Vec<Model>;
    /// What a worker's session has used so far (`session_usage`).
    fn worker_cost(&self, worker: &SessionRef) -> Cost;
    /// A piece of `run_id` fell short and its next try waits for a worker: start it
    /// ([`start_retries`]), off the caller's thread. Whoever read the run first is told, a
    /// worker's turn ending or a command that shows it, and nobody is told twice.
    fn retry_waits(&self, run_id: &str);
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
    /// A piece of `run_id` reported `done` and its result has not been
    /// checked: run the gates ([`verify`]), off the caller's thread. They run
    /// the plan's commands, which may take minutes; a read never waits on them.
    fn check_waits(&self, run_id: &str);
    /// Gates 2 to 4 on a worker's result ([`checks::gates`]): git and the
    /// piece's commands, in the worker's worktree. No session is started.
    fn check(&self, run: &Run, piece: &Piece, worker: &SessionRef) -> checks::Checked;
    /// Make a verifier for a piece's result: a conversation in the worker's
    /// worktree that cannot edit files, on `model` at `effort`. It is not the
    /// worker's conversation and is given none of it. Nothing is sent yet.
    fn create_verifier(&self, run: &Run, piece: &Piece, worker: &SessionRef, model: &str, effort: Option<&str>, number: u32) -> anyhow::Result<SessionRef>;
    fn brief_verifier(&self, verifier: &SessionRef, prompt: &str) -> anyhow::Result<()>;
    fn verifier(&self, verifier: &SessionRef) -> VerifierNow;
    /// A worker went back to work after its result was checked: what the
    /// checks noted of its worktree ([`checks::forget_clean`]) no longer holds.
    fn check_reset(&self, worker: &SessionRef);
    /// The commit a worker's worktree is at now. A result is accepted as the
    /// commit its gates ran on; `None` when the worktree cannot be read.
    fn result_commit(&self, worker: &SessionRef) -> Option<String>;
    /// What a verifier's conversation has used.
    fn verifier_tokens(&self, verifier: &SessionRef) -> Option<checks::Tokens>;
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

fn rules_for<'a>(limits: &'a OrchestratorLimits, lead: &'a Lead, agents: &'a [String], models: &'a [Model]) -> plan::Rules<'a> {
    plan::Rules { piece_limit: limits.piece_limit, default_agent: &lead.agent, agents, worker_mode: &limits.worker_mode, approval: limits.require_approval, routing: &limits.routing, models, lead_model: &lead.model, checkout: Some(std::path::Path::new(&lead.cwd)) }
}

/// The installed models, when the plan leaves a model or an effort to the
/// routing table. A plan that names both for every piece asks no CLI.
fn models_for(host: &dyn Host, plan: &Plan) -> Vec<Model> {
    let named = |text: Option<&str>| text.is_some_and(|text| !text.trim().is_empty());
    match plan.pieces.iter().all(|piece| named(Some(&piece.model)) && named(piece.effort.as_deref())) {
        true => Vec::new(),
        false => host.models(),
    }
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
    let models = models_for(host, plan);
    let pieces = plan::validate(plan, &rules_for(&limits, &lead, &agents, &models))?;
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
    let models = models_for(host, plan);
    let pieces = plan::validate(plan, &rules_for(&limits, &lead, &agents, &models))?;
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
        _ => launch_ready(host, id, Launch::Ready),
    }
}

/// Which pieces a launch starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Launch {
    /// Every piece whose dependencies are done: what the lead asks for.
    Ready,
    /// Only pieces whose last try fell short and whose next one waits. What
    /// a worker's turn ending starts by itself: a piece a `done` report
    /// unblocked is the lead's to start, once it has read that report.
    Retries,
}

/// Start the next try of every piece whose last one fell short. Called by
/// the host when a read of the run took the ladder's step
/// ([`Host::retry_waits`]), off that read's thread.
pub fn start_retries(host: &dyn Host, id: &str) -> Result<Start, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = stored(id)?;
    if !matches!(run.state, RunState::Running | RunState::Failed) {
        let waiting = waiting(&run);
        return Ok(Start { run, started: Vec::new(), waiting, failed: Vec::new() });
    }
    launch_ready(host, id, Launch::Retries)
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
    let start = launch_ready(host, id, Launch::Ready)?;
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
            "The person approved the plan of run {id}.{edited} {started}\n\nDo not poll. Wait with `terminalx wait --children-of {lead} --json`: while this run is open it returns when a piece's result is accepted or a piece is blocked, not each time a worker's turn ends. A worker's `done` is checked by TerminalX before the piece is done (its report, the files it touched, its branch, your commands; a verifier reads the diff only where those cannot settle it), and a result that fails goes back to a fresh worker without you. When the wait returns, read the run with `terminalx runs show {id} --json`, and call `terminalx runs start {id} --json` when a piece is done: it starts the pieces that waited on it."
        ),
    );
    Ok(start)
}

fn launch_ready(host: &dyn Host, id: &str, launch: Launch) -> Result<Start, EngineError> {
    let run = stored(id)?;
    // Until its piece is stored, a worker is known as one by who started it.
    let _limited = guard::starting(&run.lead.session_id);
    // Pieces with no worker yet, and pieces whose worker has a session it was never briefed in.
    let ready: Vec<String> = match launch {
        Launch::Ready => run.pieces.iter().filter(|piece| piece.held.is_some() && piece.worker.is_some()).chain(run.ready()).map(|piece| piece.id.clone()).collect(),
        Launch::Retries => run.ready().into_iter().filter(|piece| piece.retry_waits()).map(|piece| piece.id.clone()).collect(),
    };
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
                    // The try the ladder planned, or the first one.
                    if piece.tries.last().is_none_or(|last| last.worker.is_some()) {
                        piece.tries.push(Try::planned(Step::First, &piece.model, piece.effort.as_deref(), piece.tier));
                    }
                    let attempt = piece.tries.last_mut().expect("a try was just planned");
                    attempt.worker = Some(reference.clone());
                    attempt.branch = worker.branch.clone();
                    attempt.started = Some(crate::store::index::now());
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
    let seen: Vec<(String, SessionRef, WorkerNow, Option<Cost>)> = run
        .pieces
        .iter()
        // A piece whose worker was never briefed says why until it is; there is nothing to read from it.
        .filter(|piece| piece.state != PieceState::Stopped && piece.held.is_none())
        .filter_map(|piece| {
            let worker = piece.worker.clone()?;
            // A try that has ended has its cost: only one still open is read again.
            let cost = piece.tries.last().is_some_and(|attempt| attempt.outcome.is_none()).then(|| host.worker_cost(&worker));
            Some((piece.id.clone(), worker.clone(), host.worker(&worker), cost))
        })
        .collect();
    // The verifiers still reading a result: each is read as a worker is.
    let reading: Vec<(String, usize, SessionRef, VerifierNow, Option<checks::Tokens>)> = run
        .pieces
        .iter()
        .filter(|piece| piece.state == PieceState::Verifying)
        .flat_map(|piece| {
            let review = piece.tries.last().and_then(|attempt| attempt.verification.as_ref()).filter(|check| check.review_open()).and_then(|check| check.review.as_ref());
            review.into_iter().flat_map(|review| review.verifiers.iter().enumerate()).filter(|(_, verifier)| !verifier.settled()).filter_map(|(index, verifier)| {
                let session = verifier.session.clone()?;
                let now = host.verifier(&session);
                let tokens = if now == VerifierNow::Working { None } else { host.verifier_tokens(&session) };
                Some((piece.id.clone(), index, session, now, tokens))
            }).collect::<Vec<_>>()
        })
        .collect();
    // Where each result that is about to be counted stands now: it is accepted as the commit that was checked.
    let commits: Vec<(String, Option<String>)> = run
        .pieces
        .iter()
        .filter(|piece| reading.iter().any(|(id, _, _, now, _)| *id == piece.id && *now != VerifierNow::Working))
        .filter_map(|piece| Some((piece.id.clone(), host.result_commit(piece.worker.as_ref()?))))
        .collect();
    // The ladder needs the installed models only when a try fell short.
    let models = if seen.iter().any(|(_, _, now, _)| fell_short(now)) || reading.iter().any(|(_, _, _, now, _)| *now != VerifierNow::Working) { host.models() } else { Vec::new() };
    let mut back_at_work: Vec<SessionRef> = Vec::new();
    let (after, ()) = store::update(id, |run| {
        if !matches!(run.state, RunState::Running | RunState::Failed) {
            return Ok(());
        }
        for (piece_id, worker, now, cost) in seen {
            // A piece whose worker was replaced meanwhile is not this worker's to decide.
            let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id && piece.worker.as_ref() == Some(&worker) && piece.state != PieceState::Stopped && piece.held.is_none()) else { continue };
            // What a worker reported stands when its session is deleted afterwards: the report
            // was read, and its branch is still in the repository.
            if piece.state == PieceState::Done && now == WorkerNow::Gone {
                continue;
            }
            if let Some(attempt) = piece.tries.last_mut() {
                // A deleted session has no usage left to read: what was read stands.
                if let Some(cost) = cost.filter(|_| now != WorkerNow::Gone) {
                    attempt.cost_usd = cost.usd;
                    attempt.cost_unpriced_models = cost.unpriced_models;
                }
                // A failed done-check stands over the `done` its worker reported, until that worker works again.
                if attempt.outcome == Some(Outcome::CheckFailed) && now != WorkerNow::Working {
                    continue;
                }
            }
            let short = fell_short(&now).then(|| failure_of(&now));
            let outcome = outcome_of(&now);
            let (mut state, note) = follows(now);
            // `done` is the worker's claim: the piece is done once its result has passed the gates.
            if state == PieceState::Done {
                // A check recorded for an earlier report (one that said `failed`) says nothing of this one.
                if let Some(attempt) = piece.tries.last_mut().filter(|attempt| attempt.outcome.is_some_and(|outcome| outcome != Outcome::Done)) {
                    attempt.verification = None;
                }
                match piece.tries.last().map(|attempt| attempt.verification.as_ref().and_then(|check| check.outcome)) {
                    // A piece stored before tries were kept has nothing to record a check on.
                    None | Some(Some(checks::Outcome::Passed)) => {}
                    // A check that could not be finished stands, as a failed one does, until the worker works again.
                    Some(Some(_)) => continue,
                    Some(None) => state = PieceState::Verifying,
                }
            }
            piece.state = state;
            // A worker back at work keeps the line it last reported until it reports again.
            if state != PieceState::Running {
                piece.note = note.clone();
            }
            if let Some(attempt) = piece.tries.last_mut() {
                match outcome {
                    // Back at work: the try is open again, and what was checked is not what it will report.
                    None => {
                        if attempt.verification.is_some() {
                            back_at_work.push(worker.clone());
                        }
                        (attempt.outcome, attempt.ended, attempt.verification) = (None, None, None);
                    }
                    Some(outcome) => {
                        let at = crate::store::index::now();
                        if attempt.outcome != Some(outcome) || attempt.ended.is_none() {
                            attempt.ended = Some(at.clone());
                        }
                        attempt.outcome = Some(outcome);
                        attempt.detail = short.clone().or(note);
                        // Gate 1, from the report that was just read: no session, no command.
                        if attempt.verification.is_none() {
                            attempt.verification = match (&short, state) {
                                (Some(failure), _) => Some(Verification { gates: vec![GateResult::failed(Gate::Report, failure.clone())], outcome: Some(checks::Outcome::Failed), failure: Some(failure.clone()), started: Some(at.clone()), ended: Some(at), ..Verification::default() }),
                                (None, PieceState::Verifying) => Some(Verification::reported(at)),
                                _ => None,
                            };
                        }
                    }
                }
            }
            if let Some(failure) = short {
                climb(piece, &failure, &models);
            }
        }
        for (piece_id, index, session, now, tokens) in reading {
            let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id && piece.state == PieceState::Verifying) else { continue };
            let Some(review) = piece.tries.last_mut().and_then(|attempt| attempt.verification.as_mut()).filter(|check| check.review_open()).and_then(|check| check.review.as_mut()) else { continue };
            let Some(verifier) = review.verifiers.get_mut(index).filter(|verifier| verifier.session.as_ref() == Some(&session) && !verifier.settled()) else { continue };
            match now {
                VerifierNow::Working => continue,
                VerifierNow::Replied(reply) => match checks::verdict(&reply) {
                    Ok(verdict) => (verifier.verdict, verifier.evidence) = (Some(verdict.decision), verdict.evidence),
                    Err(problem) => verifier.problem = Some(problem),
                },
                VerifierNow::Stuck(why) => verifier.problem = Some(why),
                VerifierNow::Gone => verifier.problem = Some("Its conversation was closed before it gave a verdict.".into()),
            }
            verifier.tokens = tokens;
        }
        for piece in run.pieces.iter_mut().filter(|piece| piece.state == PieceState::Verifying) {
            // The branch moved under its verifiers: what they read is not what would be accepted.
            // The check starts again, from the gates, on the commit that is there now.
            let moved = commits.iter().find(|(id, _)| *id == piece.id).and_then(|(_, now)| now.as_deref()).is_some_and(|now| {
                piece.tries.last().and_then(|attempt| attempt.verification.as_ref()).filter(|check| check.review_open()).and_then(|check| check.facts.as_ref()?.commit.as_deref()).is_some_and(|checked| checked != now)
            });
            if moved {
                if let Some(attempt) = piece.tries.last_mut() {
                    attempt.verification = Some(Verification::reported(crate::store::index::now()));
                }
                continue;
            }
            counted(piece, &models);
        }
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    if after != run {
        host.changed(&after);
    }
    for worker in &back_at_work {
        host.check_reset(worker);
    }
    // This read is the one that took the ladder's step: the next try is started from here,
    // whichever read it was. A later read finds the piece already waiting and says nothing.
    if after.pieces.iter().any(|piece| piece.retry_waits() && !run.piece(&piece.id).is_some_and(Piece::retry_waits)) {
        host.retry_waits(&after.id);
    }
    // A result waits for its gates: they are run from here, off this thread, by whichever
    // read finds them waiting. One whose gates a thread is already running is left to it.
    if after.pieces.iter().any(|piece| piece.check_waits() && !checks::is_checking(&after.id, &piece.id)) {
        host.check_waits(&after.id);
        // Gates with no command to run may be through already.
        return stored(id);
    }
    Ok(after)
}

/// A gate's failure as the next try reads it.
fn gate_failure(gate: &GateResult) -> String {
    format!("The result did not pass the {} check, which TerminalX ran on it after the worker reported done.\n{}", gate.gate.name(), gate.detail.as_deref().unwrap_or_default())
}

/// End the check of a piece's current try. Passed: the piece is done.
/// Failed: the try fell short, and `said` is the failure text the ladder
/// gives the next one. Inconclusive: the piece is blocked, and `said` is why.
fn conclude(piece: &mut Piece, outcome: checks::Outcome, said: Option<String>, models: &[Model]) {
    let at = crate::store::index::now();
    let Some(attempt) = piece.tries.last_mut() else { return };
    let check = attempt.verification.get_or_insert_with(Verification::default);
    check.outcome = Some(outcome);
    check.failure = said.clone();
    check.ended = Some(at.clone());
    match outcome {
        checks::Outcome::Passed => piece.state = PieceState::Done,
        checks::Outcome::Failed => {
            let failure = failure_text(&said.unwrap_or_default());
            attempt.outcome = Some(Outcome::CheckFailed);
            attempt.detail = Some(failure.clone());
            attempt.ended = Some(at);
            climb(piece, &failure, models);
        }
        checks::Outcome::Inconclusive => {
            piece.state = PieceState::Blocked;
            piece.note = Some(format!("Its result could not be checked. {} The gates before the review passed; read the diff, or stop the run.", said.unwrap_or_default()));
        }
    }
}

/// Count the verdicts of a piece's review once every verifier has given
/// one or stopped without, and end the check with what they come to.
fn counted(piece: &mut Piece, models: &[Model]) {
    let Some(check) = piece.tries.last_mut().and_then(|attempt| attempt.verification.as_mut()).filter(|check| check.review_open()) else { return };
    let Some(review) = check.review.as_ref() else { return };
    let passes = review.verifiers.iter().filter(|verifier| verifier.verdict == Some(checks::Decision::Pass)).count();
    let (outcome, said) = match checks::tally(review) {
        Tally::Open => return,
        Tally::Passed => {
            check.gates.push(GateResult::passed(Gate::Review, if review.voters == 1 { "The verifier passed it.".to_string() } else { format!("{passes} of {} verifiers passed it; {} had to.", review.voters, review.threshold) }));
            (checks::Outcome::Passed, None)
        }
        Tally::Failed(evidence) => {
            let gate = GateResult::failed(Gate::Review, evidence);
            let failure = gate_failure(&gate);
            check.gates.push(gate);
            (checks::Outcome::Failed, Some(failure))
        }
        Tally::Inconclusive(why) => (checks::Outcome::Inconclusive, Some(why)),
    };
    conclude(piece, outcome, said, models);
}

/// The current try of `piece_id` is the one whose check began at `started`,
/// still waiting on it: nobody replaced its worker or sent it back to work.
fn checked_try<'a>(run: &'a mut Run, piece_id: &str, worker: &SessionRef, started: &str) -> Option<&'a mut Piece> {
    if !matches!(run.state, RunState::Running | RunState::Failed) {
        return None;
    }
    run.pieces.iter_mut().find(|piece| {
        piece.id == piece_id && piece.state == PieceState::Verifying && piece.worker.as_ref() == Some(worker) && piece.tries.last().and_then(|attempt| attempt.verification.as_ref()).is_some_and(|check| check.outcome.is_none() && check.started.as_deref() == Some(started))
    })
}

/// Check the result of every piece that waits for it: gates 2 to 4
/// ([`checks::gates`]), then a verifier only where [`checks::review_reasons`]
/// names a reason. Called by the host off the thread that read the report
/// ([`Host::check_waits`]): the plan's commands run here, and may take minutes.
///
/// A result that passes with no reason for a review is accepted here, with
/// no session started. One that fails a gate takes the ladder's next step
/// with what the gate printed. One that needs a reader gets its verifiers,
/// and is settled when they have answered ([`refreshed`]).
pub fn verify(host: &dyn Host, id: &str) -> Result<Run, EngineError> {
    let run = stored(id)?;
    let waiting: Vec<String> = run.pieces.iter().filter(|piece| piece.check_waits()).map(|piece| piece.id.clone()).collect();
    for piece_id in waiting {
        // One thread a piece: a second read that got here first has it.
        let Some(_checking) = checks::checking(id, &piece_id) else { continue };
        let run = stored(id)?;
        if !matches!(run.state, RunState::Running | RunState::Failed) {
            break;
        }
        let Some(piece) = run.piece(&piece_id).filter(|piece| piece.check_waits()) else { continue };
        let (Some(worker), Some(started)) = (piece.worker.clone(), piece.tries.last().and_then(|attempt| attempt.verification.as_ref()).and_then(|check| check.started.clone())) else { continue };
        let checked = host.check(&run, piece, &worker);
        let limits = host.limits(&run.project_path);
        let failed = checked.gates.iter().find(|gate| !gate.passed).map(gate_failure);
        let reasons = if checked.passed() { checks::review_reasons(piece, &checked.facts, limits.review_diff_lines) } else { Vec::new() };
        // Gates 1 to 4 passed and nothing calls for a reader, or a gate failed: settled with no session.
        if reasons.is_empty() {
            let models = if failed.is_some() { host.models() } else { Vec::new() };
            let (after, ()) = store::update(id, |run| {
                if let Some(piece) = checked_try(run, &piece_id, &worker, &started) {
                    if let Some(check) = piece.tries.last_mut().and_then(|attempt| attempt.verification.as_mut()) {
                        check.gates.extend(checked.gates.iter().cloned());
                        check.facts = Some(checked.facts.clone());
                    }
                    conclude(piece, if failed.is_some() { checks::Outcome::Failed } else { checks::Outcome::Passed }, failed.clone(), &models);
                }
                settle(run);
                Ok(())
            })
            .map_err(EngineError::internal)?;
            announce(host, &run, &after);
            continue;
        }
        // The model step: the routing table's `verify` row, not the worker's model.
        let (voters, threshold) = checks::panel(piece);
        let models = host.models();
        let lead = host.lead(&run.lead.session_id).ok();
        let chosen = routing::choose("verify", &piece.agent, "", None, &limits.routing, &models, &LeadModel { agent: lead.as_ref().map_or(piece.agent.as_str(), |lead| lead.agent.as_str()), model: lead.as_ref().map_or("", |lead| lead.model.as_str()) });
        let report: Vec<GateResult> = piece.tries.last().and_then(|attempt| attempt.verification.as_ref()).map(|check| check.gates.clone()).unwrap_or_default();
        let prompt = checks::prompt(piece, &checked.base, &report, &checked, &reasons);
        let verifiers: Vec<Verifier> = (1..=voters)
            .map(|number| {
                let made = host.create_verifier(&run, piece, &worker, &chosen.model, chosen.effort.as_deref(), number);
                let problem = made.as_ref().err().map(|error| format!("It could not be started: {error:#}"));
                Verifier { session: made.ok(), model: chosen.model.clone(), effort: chosen.effort.clone(), verdict: None, evidence: Vec::new(), problem, tokens: None }
            })
            .collect();
        // Stored before anything is sent: a verifier is known as one, and held to reading, from its first turn.
        let review = checks::Review { reasons, voters, threshold, verifiers: verifiers.clone(), prompt_chars: prompt.chars().count() };
        let (after, kept) = store::update(id, |run| {
            let Some(piece) = checked_try(run, &piece_id, &worker, &started) else { return Ok(false) };
            if let Some(check) = piece.tries.last_mut().and_then(|attempt| attempt.verification.as_mut()) {
                check.gates.extend(checked.gates.iter().cloned());
                check.facts = Some(checked.facts.clone());
                check.review = Some(review);
            }
            Ok(true)
        })
        .map_err(EngineError::internal)?;
        announce(host, &run, &after);
        if !kept {
            continue;
        }
        for verifier in verifiers.iter().filter_map(|verifier| verifier.session.as_ref()) {
            store::note_verifier(&verifier.session_id, verifier.tab_id.as_deref().unwrap_or_default());
        }
        let unsent: Vec<(usize, String)> = verifiers
            .iter()
            .enumerate()
            .filter_map(|(index, verifier)| Some((index, host.brief_verifier(verifier.session.as_ref()?, &prompt).err()?)))
            .map(|(index, error)| (index, format!("It was started but did not take its prompt: {error:#}")))
            .collect();
        // One that could not be asked has said all it will: a review nobody can answer ends here.
        let (last, ()) = store::update(id, |run| {
            if let Some(piece) = checked_try(run, &piece_id, &worker, &started) {
                if let Some(review) = piece.tries.last_mut().and_then(|attempt| attempt.verification.as_mut()).and_then(|check| check.review.as_mut()) {
                    for (index, problem) in &unsent {
                        if let Some(verifier) = review.verifiers.get_mut(*index).filter(|verifier| !verifier.settled()) {
                            verifier.problem = Some(problem.clone());
                        }
                    }
                }
                counted(piece, &models);
            }
            settle(run);
            Ok(())
        })
        .map_err(EngineError::internal)?;
        announce(host, &after, &last);
    }
    stored(id)
}

/// Say that a run changed, and ask for the next try of a piece that now waits for one.
fn announce(host: &dyn Host, before: &Run, after: &Run) {
    if after != before {
        host.changed(after);
    }
    if after.pieces.iter().any(|piece| piece.retry_waits() && !before.piece(&piece.id).is_some_and(Piece::retry_waits)) {
        host.retry_waits(&after.id);
    }
}

/// The worker's report says the try fell short, `failed` or `partial`, or there is no report to read.
fn fell_short(now: &WorkerNow) -> bool {
    matches!(now, WorkerNow::Reported { status: Status::Failed | Status::Partial, .. } | WorkerNow::NoReport(_))
}

/// What the next try is told went wrong: the worker's own words.
fn failure_of(now: &WorkerNow) -> String {
    match now {
        WorkerNow::Reported { status: Status::Partial, result } => format!("The worker reported partial: {result}"),
        WorkerNow::Reported { result, .. } => format!("The worker reported failed: {result}"),
        WorkerNow::NoReport(problem) => format!("The worker ended without a report that can be read, after it was asked once more for one. {problem} Whatever it did is on its branch, unchecked."),
        _ => String::new(),
    }
}

/// How the current try ended, from what its worker is doing; `None` while it works.
fn outcome_of(now: &WorkerNow) -> Option<Outcome> {
    Some(match now {
        WorkerNow::Working => return None,
        WorkerNow::Reported { status: Status::Done, .. } => Outcome::Done,
        WorkerNow::Reported { status: Status::Failed, .. } => Outcome::Failed,
        WorkerNow::Reported { status: Status::Partial, .. } => Outcome::Partial,
        WorkerNow::NoReport(_) => Outcome::CheckFailed,
        WorkerNow::Reported { status: Status::Blocked, .. } | WorkerNow::Stuck(_) | WorkerNow::Gone => Outcome::Blocked,
    })
}

/// The state a piece takes from what its worker is doing.
fn follows(now: WorkerNow) -> (PieceState, Option<String>) {
    match now {
        WorkerNow::Working => (PieceState::Running, None),
        WorkerNow::Reported { status: Status::Done, result } => (PieceState::Done, Some(result)),
        WorkerNow::Reported { status: Status::Failed, result } => (PieceState::Failed, Some(result)),
        WorkerNow::Reported { status: Status::Partial, result } => (PieceState::Blocked, Some(format!("Reported partial: {result}"))),
        WorkerNow::Reported { status: Status::Blocked, result } => (PieceState::Blocked, Some(format!("Reported blocked: {result}"))),
        WorkerNow::NoReport(problem) => (PieceState::Blocked, Some(format!("No report: {problem}"))),
        WorkerNow::Stuck(why) => (PieceState::Blocked, Some(why)),
        WorkerNow::Gone => (PieceState::Blocked, Some("Its worker session was deleted.".into())),
    }
}

/// The most of a failure text a piece keeps and a retry is briefed with. The
/// end is kept: a test run says what failed in its last lines.
const FAILURE_TEXT_LIMIT: usize = 6000;

fn failure_text(text: &str) -> String {
    let text = text.trim();
    if text.len() <= FAILURE_TEXT_LIMIT {
        return text.to_string();
    }
    let mut from = text.len() - FAILURE_TEXT_LIMIT;
    while !text.is_char_boundary(from) {
        from += 1;
    }
    format!("[…the start was left out]\n{}", &text[from..])
}

/// A model and effort as a line names them.
fn on(model: &str, effort: Option<&str>) -> String {
    let model = if model.is_empty() { "the agent's default model" } else { model };
    match effort {
        Some(effort) => format!("{model} at {effort}"),
        None => model.to_string(),
    }
}

/// The current try of `piece` fell short with `failure`: take the next step
/// of the ladder. Either the piece is queued again on what that step names,
/// for a fresh worker, or it is blocked with what was tried. Its last try
/// already carries its outcome. Safe to repeat on a piece that is blocked.
fn climb(piece: &mut Piece, failure: &str, models: &[Model]) {
    // A piece stored before tries were kept has no ladder to climb.
    let Some(last) = piece.tries.last().cloned() else { return };
    let tries = piece.tries.len();
    match ladder::next(&piece.agent, tries, &last.model, last.effort.as_deref(), last.tier, models) {
        Verdict::Again(next) => {
            piece.note = Some(format!("Try {tries} fell short on {}. Try {} runs on {} ({}).", on(&last.model, last.effort.as_deref()), tries + 1, on(&next.model, next.effort.as_deref()), ladder::describe(next.step)));
            piece.tries.push(Try::planned(next.step, &next.model, next.effort.as_deref(), next.tier));
            piece.model = next.model;
            piece.effort = next.effort;
            piece.tier = next.tier;
            // The worker that fell short is done with: the next try is a fresh session
            // on a fresh branch. Its session and branch stay, named on its try.
            piece.worker = None;
            piece.branch = None;
            piece.started_mode = None;
            piece.state = PieceState::Queued;
        }
        Verdict::Blocked(why) => {
            let tried: Vec<String> = piece.tries.iter().map(|attempt| on(&attempt.model, attempt.effort.as_deref())).collect();
            piece.state = PieceState::Blocked;
            piece.note = Some(format!("Blocked after {tries} {}: {}. {why} Last failure: {failure}", if tries == 1 { "try" } else { "tries" }, tried.join(", then ")));
        }
    }
}

/// What a failed done-check did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFailed {
    pub run: Run,
    pub piece: String,
    /// A worker was started for the piece's next try.
    pub retried: bool,
    /// The piece is blocked: the ladder ran out.
    pub blocked: bool,
    pub failed: Vec<NotStarted>,
}

/// The done-check of `piece_id` did not hold, though its worker reported
/// `done`: `output` is what the check said. The piece takes the next step of
/// the ladder, with `output` as the failure text its next worker is given.
pub fn check_failed(host: &dyn Host, id: &str, piece_id: &str, output: &str) -> Result<CheckFailed, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = refreshed(host, id)?;
    if !matches!(run.state, RunState::Running | RunState::Failed | RunState::Done) {
        return Err(EngineError::new("run_not_running", format!("Run {id} is not running ({}). A done-check is reported for a piece of a run that is.", state_name(run.state)), None));
    }
    let Some(piece) = run.piece(piece_id) else {
        let mut error = EngineError::new("piece_not_found", format!("Run {id} has no piece {piece_id}."), Some("Use a piece id from `terminalx runs show --json`."));
        error.details = json!({"pieces": run.pieces.iter().map(|piece| piece.id.clone()).collect::<Vec<_>>()});
        return Err(error);
    };
    if piece.state != PieceState::Done || piece.tries.is_empty() {
        let why = match piece.state {
            PieceState::Running => "its worker is still working".to_string(),
            PieceState::Verifying => "its result is still being checked by TerminalX, which sends it back by itself if a check fails".to_string(),
            PieceState::Queued => "it has no worker yet".to_string(),
            PieceState::Blocked if piece.gave_up() => format!("it is already blocked after {} tries", piece.tries.len()),
            _ => format!("it is {}", serde_json::to_value(piece.state).ok().and_then(|state| state.as_str().map(str::to_owned)).unwrap_or_default()),
        };
        let mut error = EngineError::new("piece_not_done", format!("Piece {piece_id} did not report done: {why}. A failed done-check is reported for a piece whose worker said it was done."), Some("A piece that reports `failed` or `partial` is tried again without being asked."));
        error.details = json!({"piece": piece_id, "state": piece.state});
        return Err(error);
    }
    // The checks as the plan wrote them: the next worker is held to the same ones.
    let checks: Vec<&str> = piece.done_checks.iter().map(super::Check::text).collect();
    let failure = format!("The done-check did not hold: {}\n{}", checks.join("; "), failure_text(output));
    let models = host.models();
    let (run, ()) = store::update(id, |run| {
        // A run that was done is not, with a piece whose check failed.
        if run.state == RunState::Done {
            run.state = RunState::Running;
        }
        if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
            if let Some(attempt) = piece.tries.last_mut() {
                attempt.outcome = Some(Outcome::CheckFailed);
                attempt.detail = Some(failure.clone());
                attempt.ended = Some(crate::store::index::now());
            }
            climb(piece, &failure, &models);
        }
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&run);
    let blocked = run.piece(piece_id).is_some_and(Piece::gave_up);
    let start = launch_ready(host, id, Launch::Retries)?;
    Ok(CheckFailed { retried: start.started.iter().any(|started| started == piece_id), run: start.run, piece: piece_id.to_string(), blocked, failed: start.failed })
}

/// What the pieces make of a started run. Done when every piece is; failed
/// when a piece failed or ran out of tries and nothing is running or could
/// start; running otherwise.
fn settle(run: &mut Run) {
    if !matches!(run.state, RunState::Running | RunState::Failed) {
        return;
    }
    let failed: Vec<&Piece> = run.pieces.iter().filter(|piece| (piece.state == PieceState::Failed && piece.worker.is_some()) || piece.gave_up()).collect();
    let (state, reason) = if run.pieces.iter().all(|piece| piece.state == PieceState::Done) {
        (RunState::Done, None)
    } else if run.pieces.iter().any(|piece| matches!(piece.state, PieceState::Running | PieceState::Verifying)) || !run.ready().is_empty() || failed.is_empty() {
        (RunState::Running, None)
    } else {
        let names: Vec<String> = failed.iter().map(|piece| piece.id.clone()).collect();
        let said: Vec<String> = failed
            .iter()
            .map(|piece| match piece.gave_up() {
                true => format!("{} is blocked after {} {}.", piece.id, piece.tries.len(), if piece.tries.len() == 1 { "try" } else { "tries" }),
                false => format!("{} failed.", piece.id),
            })
            .collect();
        let held: Vec<String> = waiting(run).into_iter().filter(|waiting| waiting.on.iter().any(|on| names.contains(on))).map(|waiting| waiting.piece).collect();
        let held = if held.is_empty() { String::new() } else { format!(" {} cannot start without {}.", held.join(", "), if names.len() == 1 { "it" } else { "them" }) };
        (RunState::Failed, Some(format!("{}{held}", said.join(" "))))
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
            // A try that was under way, or planned and never started, ends here.
            if let Some(attempt) = piece.tries.last_mut().filter(|attempt| attempt.outcome.is_none()) {
                attempt.outcome = Some(Outcome::Stopped);
                attempt.ended = Some(crate::store::index::now());
            }
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
/// Returns the run when a piece of it now waits for its next try. Starting
/// that try is not the caller's: the read that took the ladder's step asked
/// the host for it ([`Host::retry_waits`]), and that read may have been
/// another one (`runs show`, the Run view) that got there first.
pub fn worker_turn_ended(host: &dyn Host, session_id: &str) -> Option<String> {
    match store::for_worker(session_id) {
        Ok(Some((run, _))) => match refreshed(host, &run.id) {
            Ok(after) => return after.pieces.iter().any(Piece::retry_waits).then_some(after.id),
            Err(error) => log::warn!("refresh run {} after its worker {session_id} ended a turn: {error}", run.id),
        },
        Ok(None) => {}
        Err(error) => log::warn!("read the runs after {session_id} ended a turn: {error:#}"),
    }
    None
}

/// Why a lead that waits on its run is woken, or `None` while there is
/// nothing for it to do. `began` is the run when the wait began.
///
/// A lead does not poll its workers, and is not woken each time one ends a
/// turn: a `done` report is checked first, and a result that fails goes back
/// to a fresh worker without the lead. It is woken when a piece's result is
/// accepted, when a piece stops for good (blocked, failed), when a piece is
/// ready for it to start, when the run has ended, or when nothing is under
/// way and nothing could start (a piece blocked before the wait began would
/// otherwise keep it asleep to its timeout). With `all`, only once nothing is
/// under way any more.
pub fn wake(began: &Run, now: &Run, all: bool) -> Option<Value> {
    let name = |state: PieceState| serde_json::to_value(state).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default();
    let settled = |state: PieceState| matches!(state, PieceState::Done | PieceState::Blocked | PieceState::Failed | PieceState::Stopped);
    let changed: Vec<&Piece> = now.pieces.iter().filter(|piece| settled(piece.state) && began.piece(&piece.id).is_none_or(|before| before.state != piece.state)).collect();
    // A piece whose next try waits is started without the lead: it is not the lead's to start.
    let ready: Vec<String> = if matches!(now.state, RunState::Planned | RunState::Running) { now.ready().into_iter().filter(|piece| !piece.retry_waits()).map(|piece| piece.id.clone()).collect() } else { Vec::new() };
    let under_way = now.pieces.iter().any(|piece| matches!(piece.state, PieceState::Running | PieceState::Verifying) || piece.retry_waits());
    let ended = now.state != RunState::Running;
    let woken = match all {
        true => ended || !under_way,
        // Nothing under way and nothing to start: whatever holds the run up (a blocked piece,
        // from before this wait began) will not change by waiting.
        false => ended || !changed.is_empty() || !ready.is_empty() || !under_way,
    };
    if !woken {
        return None;
    }
    let mut why: Vec<String> = changed.iter().map(|piece| match piece.state {
        PieceState::Done => format!("{} is done: its result passed its checks.", piece.id),
        PieceState::Blocked if piece.gave_up() => format!("{} is blocked after {} tries.", piece.id, piece.tries.len()),
        state => format!("{} is {}.", piece.id, name(state)),
    }).collect();
    if !ready.is_empty() {
        why.push(format!("Ready to start with `terminalx runs start`: {}.", ready.join(", ")));
    }
    if ended {
        why.push(format!("The run is {}.", state_name(now.state)));
    } else if !under_way && ready.is_empty() {
        let held: Vec<String> = now.pieces.iter().filter(|piece| matches!(piece.state, PieceState::Blocked | PieceState::Failed)).map(|piece| piece.id.clone()).collect();
        why.push(format!("Nothing is under way and nothing can start: waiting changes nothing.{}", if held.is_empty() { String::new() } else { format!(" Held up by: {}. `terminalx runs show` says why for each.", held.join(", ")) }));
    }
    Some(json!({
        "run": now.id, "state": now.state, "reason": now.reason, "why": why, "ready": ready,
        "pieces": now.pieces.iter().map(|piece| json!({"piece": piece.id, "state": piece.state, "changed": began.piece(&piece.id).is_none_or(|before| before.state != piece.state), "note": piece.note})).collect::<Vec<_>>(),
    }))
}

/// A run as `runs show` returns it: the run, what it would start next, what
/// waits on what, and what its workers cost so far.
pub fn shown(run: &Run) -> Value {
    let (estimate, unestimated) = run.estimate();
    let mut value = serde_json::to_value(run).unwrap_or_else(|_| json!({}));
    value["ready"] = json!(if matches!(run.state, RunState::Planned | RunState::Running) { run.ready().iter().map(|piece| piece.id.clone()).collect() } else { Vec::<String>::new() });
    value["waiting"] = json!(waiting(run));
    value["estimate"] = json!(estimate);
    value["unestimated"] = json!(unestimated);
    value["maxTries"] = json!(ladder::MAX_TRIES);
    // What checking the results cost: the tokens of every verifier session, apart from the workers'.
    let verifier_tokens: Vec<u64> = run.pieces.iter().flat_map(|piece| &piece.tries).filter_map(|attempt| attempt.verification.as_ref()?.review.as_ref()?.tokens()).collect();
    value["verifierTokens"] = json!((!verifier_tokens.is_empty()).then(|| verifier_tokens.iter().sum::<u64>()));
    // What each piece's tries cost so far, and the run's workers together.
    let (mut total, mut unpriced) = (None::<f64>, Vec::<String>::new());
    for (index, piece) in run.pieces.iter().enumerate() {
        let (cost, missing) = piece.cost();
        value["pieces"][index]["costUsd"] = json!(cost);
        value["pieces"][index]["costUnpricedModels"] = json!(missing);
        if let Some(cost) = cost {
            total = Some(total.unwrap_or(0.0) + cost);
        }
        for model in missing {
            if !unpriced.contains(&model) {
                unpriced.push(model);
            }
        }
    }
    value["costUsd"] = json!(total);
    value["costUnpricedModels"] = json!(unpriced);
    value
}

fn state_name(state: RunState) -> String {
    serde_json::to_value(state).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}
