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

use super::budget::{self, Login, Pause, RunLimits};
use super::ladder::{self, Step, Verdict};
use super::plan::{self, Plan, PlanError};
use super::routing::{self, LeadModel};
use super::verify::{self as checks, Gate, GateResult, Tally, Verification, Verifier};
use super::{brief, guard, plan as plans, store, Approval, Hold, MergeState, Outcome, Piece, PieceState, Run, RunState, SessionRef, Try, TryReport};
use crate::models::Model;
use crate::status::usage::UsageWindow;
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
    /// The lead was started with Orchestrate (PRO-337): its runs wait for a
    /// person's Approve whatever the project's `requireApproval` says.
    pub ask_first: bool,
}

/// A worker session, just created for a piece.
pub struct Started {
    pub session_id: String,
    pub tab_id: String,
    pub branch: Option<String>,
}

/// What a worker in a turn has been doing: what tells a stall from a long build.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Activity {
    /// Its last tool call, tool result or file change in this turn, else the
    /// turn's start, in milliseconds since the epoch.
    pub last_ms: Option<i64>,
    /// A tool call of its has not returned, or a background task of its runs:
    /// a build or a test run, however long, is work.
    pub command_running: bool,
    /// Its agent's processes are using the CPU.
    pub busy: bool,
}

/// What a piece's worker is doing now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerNow {
    /// In a turn, about to take its brief, or about to be reminded of its report.
    Working,
    /// Its last turn ended with a report: its status and result line, and the rest of it.
    Reported { status: Status, result: String, report: TryReport },
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
    /// The output tokens its session used; `None` before any usage was read.
    pub output_tokens: Option<u64>,
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
    /// A worker went back to work after its result was checked, or reported
    /// again: what the checks noted of its worktree ([`checks::forget_clean`])
    /// no longer holds. Called before the gates of the new report run.
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
    /// How a new tab of `agent` would be signed in now.
    fn login(&self, agent: &str) -> Login;
    /// The usage windows as the status bar has them now.
    fn windows(&self) -> Vec<UsageWindow>;
    /// What a worker in a turn has been doing.
    fn activity(&self, worker: &SessionRef) -> Activity;
    /// Start what waits for a free worker slot ([`fill_slots`]), soon and
    /// outside the caller's locks: a turn ending must not wait on a start.
    fn fill_later(&self);
    /// Make sure something calls [`watch`] while a run has workers in a turn
    /// or waits to resume after a reset.
    fn watch(&self);
    fn now_ms(&self) -> i64;
    /// The commit the lead's branch is at now; `None` when its checkout cannot be read.
    fn lead_head(&self, run: &Run) -> Option<String>;
    /// What the lead committed in its checkout since `since`, for a piece it took over
    /// ([`finish`]), and what it left uncommitted.
    fn lead_work(&self, run: &Run, since: &str) -> anyhow::Result<LeadWork>;
    /// Run a piece's command done-checks in the lead's checkout, in order, until one fails.
    /// `by_lead`: the lead's own turn asked, so that turn is not one to wait for.
    /// `Err` says why they could not be run (its checkout is in use).
    fn lead_commands(&self, run: &Run, piece: &Piece, by_lead: bool) -> Result<Vec<checks::CommandRun>, String>;
    /// The permission mode of the lead's conversation, when it can be read.
    fn lead_mode(&self, run: &Run) -> Option<String>;
}

/// What the lead's checkout holds of a piece it took over.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LeadWork {
    /// The commit its branch is at now.
    pub head: String,
    /// Each file changed between the commit it took the piece over at and `head`.
    pub changes: Vec<checks::FileChange>,
    /// Tracked files with changes that are not committed.
    pub uncommitted: Vec<String>,
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

    pub(super) fn internal(error: anyhow::Error) -> Self {
        Self::new("internal_error", format!("{error:#}"), None)
    }

    pub(super) fn not_found(id: &str) -> Self {
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
/// approval unless its project asks for none and its lead was not started
/// with Orchestrate.
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
    let mut limits = host.limits(&lead.project_path);
    limits.require_approval |= lead.ask_first;
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
        limits: RunLimits::new(&limits, &plan.budget),
        // The ladder holds as Settings had it now, for every try of the run.
        max_tries: limits.tries_per_piece,
        effort_ceiling: limits.effort_ceiling,
        worker_mode: limits.worker_mode,
        plan_edited: false,
        approval: None,
        reason: None,
        integration_check: plan.integration(),
        merge: None,
        usage: Default::default(),
        pause: None,
        created: now.clone(),
        modified: now,
    };
    let mut run = run;
    // The windows it would draw on, for the person approving it: nothing counts yet.
    update_usage(host, &mut run);
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
    let reading = read_usage(host, &Run { pieces: pieces.clone(), ..run.clone() });
    let (run, ()) = store::update(id, |run| {
        // A budget the person wrote into the plan is theirs to set: it holds as written.
        if plan.budget.dollars != run.budget.dollars {
            if let Some(dollars) = plan.budget.dollars {
                run.limits.dollars = dollars;
            }
        }
        if plan.budget.points != run.budget.points {
            if let Some(points) = plan.budget.points {
                run.limits.points = points;
            }
        }
        run.limits.valid().map_err(|message| anyhow::anyhow!(message))?;
        run.goal = plan.goal.trim().to_string();
        run.budget = plan.budget.clone();
        run.integration_check = plan.integration();
        run.pieces = pieces;
        run.plan_edited = true;
        apply_usage(run, &reading, false);
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
    /// It was asked for but a limit holds it: it starts by itself when the limit allows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_for: Option<Hold>,
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
        RunState::NeedsYou => {
            // What the lead asked for starts when the person lets the run go on.
            let (run, ()) = store::update(id, |run| {
                let ready: Vec<String> = run.ready().iter().map(|piece| piece.id.clone()).collect();
                for piece in run.pieces.iter_mut().filter(|piece| ready.contains(&piece.id)) {
                    piece.queued_for = Some(Hold::Budget);
                }
                Ok(())
            })
            .map_err(EngineError::internal)?;
            host.changed(&run);
            let why = run.pause.as_ref().map(|pause| pause.message.clone()).unwrap_or_else(|| run.reason.clone().unwrap_or_default());
            let mut error = EngineError::new(
                "needs_you",
                format!("Run {id} reached its budget and starts nothing new until the person lets it go on. {why}"),
                Some("Tell the person, then end your turn. The pieces you asked for start when they resume the run (raising the budget alone does not), or after the window resets if they asked for that; you are told here."),
            );
            error.details = json!({"run": id, "pause": run.pause});
            Err(error)
        }
        _ => launch_ready(host, id, Launch::Ready),
    }
}

/// Which pieces a launch considers. Whichever it is, every piece passes the
/// budget and the worker limits before its brief goes (PRO-280): a retry or
/// an escalated try takes a slot like any other worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Launch {
    /// Every piece whose dependencies are done: what the lead asks for.
    Ready,
    /// Only pieces whose last try fell short and whose next one waits. What
    /// a worker's turn ending starts by itself: a piece a `done` report
    /// unblocked is the lead's to start, once it has read that report.
    Retries,
    /// Only the pieces a limit or the budget held, next tries among them:
    /// what a freed slot or a resume starts. A piece that became ready since
    /// waits for the lead, who may have to collect a finished piece's branch
    /// before it starts.
    Held,
}

/// Start the next try of every piece whose last one fell short. Called by
/// the host when a read of the run took the ladder's step
/// ([`Host::retry_waits`]), off that read's thread. A run that reached its
/// budget starts none: its next tries start when it is resumed.
pub fn start_retries(host: &dyn Host, id: &str) -> Result<Start, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    start_retries_locked(host, id)
}

fn start_retries_locked(host: &dyn Host, id: &str) -> Result<Start, EngineError> {
    let mut run = stored(id)?;
    if run.state == RunState::NeedsYou && run.pieces.iter().any(|piece| piece.retry_waits() && piece.queued_for.is_none()) {
        // Held for the person, as what the lead asks for is: it starts when they resume the run.
        (run, ()) = store::update(id, |run| {
            for piece in run.pieces.iter_mut().filter(|piece| piece.retry_waits()) {
                piece.queued_for = Some(Hold::Budget);
            }
            Ok(())
        })
        .map_err(EngineError::internal)?;
        host.changed(&run);
    }
    if !run.state.live() {
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
    let started = match (start.started.is_empty(), start.run.state) {
        (_, RunState::NeedsYou) => format!("No worker was started: {}", start.run.reason.clone().unwrap_or_default()),
        (true, _) => "No worker could be started; `terminalx runs show` says why for each piece.".to_string(),
        (false, _) => format!("Workers were started for: {}.", start.started.join(", ")),
    };
    let queued: Vec<&str> = start.waiting.iter().filter(|waiting| matches!(waiting.queued_for, Some(Hold::RunLimit | Hold::AppLimit))).map(|waiting| waiting.piece.as_str()).collect();
    let started = if queued.is_empty() { started } else { format!("{started} Queued for a free worker slot, and started by TerminalX as workers finish: {}.", queued.join(", ")) };
    host.tell_lead(
        run,
        &format!(
            "The person approved the plan of run {id}.{edited} {started}\n\nDo not poll. Wait with `terminalx wait --children-of {lead} --json`: while this run is open it returns when a piece's result is accepted or a piece is blocked, not each time a worker's turn ends. A worker's `done` is checked by TerminalX before the piece is done (its report, the files it touched, its branch, your commands; a verifier reads the diff only where those cannot settle it), and a result that fails goes back to a fresh worker without you. When the wait returns, read the run with `terminalx runs show {id} --json`, and call `terminalx runs start {id} --json` when a piece is done: it starts the pieces that waited on it. Do not merge the workers' branches by hand: `terminalx runs merge {id} --json` merges every accepted piece into your branch in dependency order and runs the integration check after each, and the run is done once all are merged."
        ),
    );
    Ok(start)
}

/// Run workers in a turn across every run: what the app-wide limit counts.
/// Sessions a person started by hand are not workers and are never counted.
fn in_turn_everywhere() -> Result<usize, EngineError> {
    Ok(store::list().map_err(EngineError::internal)?.iter().filter(|run| !run.state.ended()).map(Run::in_turn).sum())
}

/// What the budget is computed from, read from the host outside the store's
/// lock: the usage windows and each agent's login. What workers cost is
/// what their tries recorded (`Piece::cost`, PRO-273's per-session cost),
/// which every read of the run brings up to date.
struct Reading {
    windows: Vec<UsageWindow>,
    logins: std::collections::HashMap<String, Login>,
}

fn read_usage(host: &dyn Host, run: &Run) -> Reading {
    let logins = run.pieces.iter().map(|piece| piece.agent.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().map(|agent| (agent.clone(), host.login(&agent))).collect();
    Reading { windows: host.windows(), logins }
}

/// Bring a run's usage up to date. Its share of a window starts to count once
/// it has a worker, or (`starting`) as its first one is about to start.
fn apply_usage(run: &mut Run, reading: &Reading, starting: bool) {
    let active = starting || run.pieces.iter().any(|piece| piece.worker.is_some() || piece.tries.iter().any(|attempt| attempt.worker.is_some()));
    // Every try counts, an escalated one's as much as the first: each was a worker on the budget.
    let cost = |piece: &Piece| piece.cost().0;
    let login = |agent: &str| reading.logins.get(agent).copied().unwrap_or(Login::Subscription);
    budget::update(run, &reading.windows, &cost, &login, active);
}

fn update_usage(host: &dyn Host, run: &mut Run) {
    let reading = read_usage(host, run);
    apply_usage(run, &reading, false);
}

/// The run reached its budget: nothing new starts, and the lead is told why,
/// once. `held` are the pieces it was about to start, which start when the
/// person lets it go on.
fn pause(host: &dyn Host, id: &str, pause: Pause, held: &[String]) -> Result<Run, EngineError> {
    let mut paused_now = false;
    let (run, ()) = store::update(id, |run| {
        for piece in run.pieces.iter_mut().filter(|piece| held.contains(&piece.id)) {
            piece.queued_for = Some(Hold::Budget);
        }
        if run.state != RunState::NeedsYou {
            paused_now = true;
            run.state = RunState::NeedsYou;
            run.reason = Some(pause.message.clone());
            run.pause = Some(pause.clone());
        }
        Ok(())
    })
    .map_err(EngineError::internal)?;
    if paused_now {
        host.changed(&run);
        let reset = match pause.window.as_ref().and_then(|window| window.resets_at) {
            Some(_) => " They can also let it go on once the window resets.",
            None => "",
        };
        host.tell_lead(
            &run,
            &format!(
                "Run {id} reached its budget and starts no new piece: {}\n\nWorkers already in a turn finish it. The person decides what happens next: raise the budget, or resume the run.{reset} Do not start the remaining work another way. Tell the person, then end your turn; you are told here when the run goes on.",
                pause.message
            ),
        );
    }
    Ok(run)
}

fn launch_ready(host: &dyn Host, id: &str, launch: Launch) -> Result<Start, EngineError> {
    let run = stored(id)?;
    // Until its piece is stored, a worker is known as one by who started it.
    let _limited = guard::starting(&run.lead.session_id);
    let app_limit = host.limits(&run.project_path).workers_at_once as usize;
    // Pieces whose worker has a session it was never briefed in, and pieces with no worker yet.
    let briefless = || run.pieces.iter().filter(|piece| piece.held.is_some() && piece.worker.is_some());
    let ready: Vec<String> = match launch {
        Launch::Ready => briefless().chain(run.ready()).map(|piece| piece.id.clone()).collect(),
        Launch::Retries => run.ready().into_iter().filter(|piece| piece.retry_waits()).map(|piece| piece.id.clone()).collect(),
        Launch::Held => briefless()
            .filter(|piece| piece.queued_for.is_some())
            .chain(run.ready().into_iter().filter(|piece| piece.queued_for.is_some()))
            .map(|piece| piece.id.clone())
            .collect(),
    };
    let (mut started, mut failed) = (Vec::new(), Vec::new());
    for (index, piece_id) in ready.iter().enumerate() {
        let piece_id = piece_id.clone();
        // Read again each time: the brief of a later piece names what earlier ones reported.
        let run = stored(id)?;
        if run.piece(&piece_id).is_none() {
            continue;
        }
        // Every brief starts a turn, a held piece's in the session it already has as much as a
        // new one: each passes the budget and the worker limits.
        // The budget first: a run past it starts nothing, whatever the slots. A window's
        // baseline is taken here, before the run's first worker starts in it.
        let reading = read_usage(host, &run);
        let (current, ()) = store::update(id, |run| {
            apply_usage(run, &reading, true);
            Ok(())
        })
        .map_err(EngineError::internal)?;
        if let Some(reached) = budget::reached(&current, host.now_ms()) {
            pause(host, id, reached, &ready[index..])?;
            break;
        }
        let hold = if current.in_turn() >= current.limits.workers as usize {
            Some(Hold::RunLimit)
        } else if in_turn_everywhere()? >= app_limit {
            Some(Hold::AppLimit)
        } else {
            None
        };
        if let Some(hold) = hold {
            set_piece(id, &piece_id, |piece| piece.queued_for = Some(hold))?;
            continue;
        }
        let run = stored(id)?;
        let Some(piece) = run.piece(&piece_id) else { continue };
        let mode = piece.mode(&run.worker_mode).to_string();
        let (reference, branch) = match piece.worker.clone().filter(|_| piece.held.is_some()) {
            // The session it already has: never a second one for the same piece.
            Some(worker) => (worker, piece.branch.clone()),
            None => {
                let login = host.login(&piece.agent);
                let worker = match host.create_worker(&run, piece, &mode) {
                    Ok(worker) => worker,
                    Err(error) => {
                        let error = format!("{error:#}");
                        set_piece(id, &piece_id, |piece| {
                            piece.state = PieceState::Failed;
                            piece.queued_for = None;
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
                    piece.login = Some(login);
                    piece.queued_for = None;
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
            piece.queued_for = None;
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
    if !started.is_empty() {
        host.watch();
    }
    let waiting = waiting(&run);
    Ok(Start { run, started, waiting, failed })
}

/// The queued pieces of a run, each with the dependencies that are not done.
pub fn waiting(run: &Run) -> Vec<Waiting> {
    run.pieces
        .iter()
        .filter(|piece| piece.state == PieceState::Queued)
        .map(|piece| Waiting {
            piece: piece.id.clone(),
            on: piece.depends_on.iter().filter(|id| run.piece(id).is_none_or(|dependency| dependency.state != PieceState::Done)).cloned().collect(),
            queued_for: piece.queued_for,
        })
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
    if matches!(run.state, RunState::AwaitingApproval | RunState::Planned) {
        // Nothing runs yet; the windows it would draw on are kept current for the person deciding.
        let reading = read_usage(host, &run);
        let (after, ()) = store::update(id, |run| {
            apply_usage(run, &reading, false);
            Ok(())
        })
        .map_err(EngineError::internal)?;
        if after != run {
            host.changed(&after);
        }
        return Ok(after);
    }
    if !run.state.followed() {
        return Ok(run);
    }
    // Workers are read outside the store's lock: a transcript is a file read.
    let seen: Vec<(String, SessionRef, WorkerNow, Option<Cost>)> = run
        .pieces
        .iter()
        // A piece whose worker was never briefed says why until it is; there is nothing to read from it.
        // One a person skipped, or the lead took over, no longer follows the worker it had.
        .filter(|piece| !matches!(piece.state, PieceState::Stopped | PieceState::Skipped | PieceState::Lead) && piece.held.is_none())
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
    let usage = read_usage(host, &run);
    // What the lead's session has cost, while it resolves a conflict a person gave it.
    let lead_usd = run.merge.as_ref().and_then(|merge| merge.resolving.as_ref()).and_then(|_| host.worker_cost(&run.lead).usd);
    let now_ms = host.now_ms();
    let (after, reached) = store::update(id, |run| {
        let rules = run.ladder();
        if !run.state.followed() {
            return Ok(None);
        }
        for (piece_id, worker, now, cost) in seen {
            // A piece whose worker was replaced meanwhile is not this worker's to decide.
            let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id && piece.worker.as_ref() == Some(&worker) && !matches!(piece.state, PieceState::Stopped | PieceState::Skipped | PieceState::Lead) && piece.held.is_none()) else { continue };
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
                    attempt.output_tokens = cost.output_tokens.or(attempt.output_tokens);
                }
                // A failed done-check stands over the `done` its worker reported, until that worker works again.
                if attempt.outcome == Some(Outcome::CheckFailed) && now != WorkerNow::Working {
                    continue;
                }
            }
            let short = fell_short(&now).then(|| failure_of(&now));
            let outcome = outcome_of(&now);
            let report = match &now {
                WorkerNow::Reported { report, .. } => Some(report.clone()),
                _ => None,
            };
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
            // Still in its turn: whether it is stalled is the watcher's to say ([`watch`]).
            if state == PieceState::Running && piece.state == PieceState::Stalled {
                continue;
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
                        (attempt.outcome, attempt.ended, attempt.verification, attempt.report) = (None, None, None, None);
                    }
                    Some(outcome) => {
                        let at = crate::store::index::now();
                        if attempt.outcome != Some(outcome) || attempt.ended.is_none() {
                            attempt.ended = Some(at.clone());
                        }
                        attempt.outcome = Some(outcome);
                        attempt.detail = short.clone().or(note);
                        attempt.report = report;
                        // Gate 1, from the report that was just read: no session, no command.
                        if attempt.verification.is_none() {
                            attempt.verification = match (&short, state) {
                                (Some(failure), _) => Some(Verification { gates: vec![GateResult::failed(Gate::Report, failure.clone())], outcome: Some(checks::Outcome::Failed), failure: Some(failure.clone()), started: Some(at.clone()), ended: Some(at), ..Verification::default() }),
                                (None, PieceState::Verifying) => {
                                    // A new report is a new claim: what an earlier check noted of this worktree is not about it.
                                    back_at_work.push(worker.clone());
                                    Some(Verification::reported(at))
                                }
                                _ => None,
                            };
                        }
                    }
                }
            }
            if let Some(failure) = short {
                climb(piece, &failure, &models, &rules);
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
            counted(piece, &models, &rules);
        }
        follow_resolution(run, lead_usd);
        apply_usage(run, &usage, false);
        settle(run);
        Ok((run.state == RunState::Running).then(|| budget::reached(run, now_ms)).flatten())
    })
    .map_err(EngineError::internal)?;
    // A runtime that restarted has no watcher yet for the workers it found running.
    if after.in_turn() > 0 || after.pause.as_ref().is_some_and(|pause| pause.resume_at.is_some()) {
        host.watch();
    }
    // Past its budget: nothing new starts from here on, but what this read found is still
    // followed up. A result that waits for its checks is checked, and a next try that waits
    // is held for the person (`start_retries`), to start when the run is resumed.
    let after = match reached {
        Some(reached) => pause(host, id, reached, &[])?,
        None => {
            if after != run {
                host.changed(&after);
            }
            after
        }
    };
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
fn conclude(piece: &mut Piece, outcome: checks::Outcome, said: Option<String>, models: &[Model], rules: &ladder::Rules) {
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
            climb(piece, &failure, models, rules);
        }
        checks::Outcome::Inconclusive => {
            piece.state = PieceState::Blocked;
            piece.note = Some(format!("Its result could not be checked. {} The gates before the review passed; read the diff, or stop the run.", said.unwrap_or_default()));
        }
    }
}

/// Count the verdicts of a piece's review once every verifier has given
/// one or stopped without, and end the check with what they come to.
fn counted(piece: &mut Piece, models: &[Model], rules: &ladder::Rules) {
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
    conclude(piece, outcome, said, models, rules);
}

/// The current try of `piece_id` is the one whose check began at `started`,
/// still waiting on it: nobody replaced its worker or sent it back to work.
fn checked_try<'a>(run: &'a mut Run, piece_id: &str, worker: &SessionRef, started: &str) -> Option<&'a mut Piece> {
    // A run paused on its budget still has the results reported before it paused checked.
    if !run.state.followed() {
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
        if !run.state.followed() {
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
                let rules = run.ladder();
                if let Some(piece) = checked_try(run, &piece_id, &worker, &started) {
                    if let Some(check) = piece.tries.last_mut().and_then(|attempt| attempt.verification.as_mut()) {
                        check.gates.extend(checked.gates.iter().cloned());
                        check.facts = Some(checked.facts.clone());
                    }
                    conclude(piece, if failed.is_some() { checks::Outcome::Failed } else { checks::Outcome::Passed }, failed.clone(), &models, &rules);
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
            let rules = run.ladder();
            if let Some(piece) = checked_try(run, &piece_id, &worker, &started) {
                if let Some(review) = piece.tries.last_mut().and_then(|attempt| attempt.verification.as_mut()).and_then(|check| check.review.as_mut()) {
                    for (index, problem) in &unsent {
                        if let Some(verifier) = review.verifiers.get_mut(*index).filter(|verifier| !verifier.settled()) {
                            verifier.problem = Some(problem.clone());
                        }
                    }
                }
                counted(piece, &models, &rules);
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
        WorkerNow::Reported { status: Status::Partial, result , .. } => format!("The worker reported partial: {result}"),
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
        WorkerNow::Reported { status: Status::Done, result , .. } => (PieceState::Done, Some(result)),
        WorkerNow::Reported { status: Status::Failed, result , .. } => (PieceState::Failed, Some(result)),
        WorkerNow::Reported { status: Status::Partial, result , .. } => (PieceState::Blocked, Some(format!("Reported partial: {result}"))),
        WorkerNow::Reported { status: Status::Blocked, result , .. } => (PieceState::Blocked, Some(format!("Reported blocked: {result}"))),
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
fn climb(piece: &mut Piece, failure: &str, models: &[Model], rules: &ladder::Rules) {
    // A piece stored before tries were kept has no ladder to climb.
    let Some(last) = piece.tries.last().cloned() else { return };
    let tries = piece.tries.len();
    // A try a person asked for past the ladder (its files widened) is the last: the person decides again.
    let verdict = match piece.tries.iter().any(|attempt| attempt.step == Step::Widened) {
        true => Verdict::Blocked("The try after a person widened its files fell short too.".into()),
        false => ladder::next(&piece.agent, tries, rules, &last.model, last.effort.as_deref(), last.tier, models),
    };
    match verdict {
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
            // What came of merging the result that fell short says nothing of the next one.
            piece.merge = None;
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
    if !(run.state.live() || run.state == RunState::Done) {
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
        let rules = run.ladder();
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
            climb(piece, &failure, &models, &rules);
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

/// What sending a piece back did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentBack {
    pub run: Run,
    pub piece: String,
    /// The worker that has it now: the one whose result it was, or a fresh
    /// one when that session is gone.
    pub fresh_worker: bool,
    /// The piece is blocked: its worker is gone and the ladder ran out.
    pub blocked: bool,
    pub failed: Vec<NotStarted>,
}

/// The accepted result of `piece_id` could not be merged into the lead's
/// branch (`merge`): give it back to its worker, with the conflict or what
/// the integration check printed as its brief. The worker that made the
/// result is asked, in its own worktree, and its next report is checked by
/// the same gates; when its session is gone the piece takes the ladder's
/// next step instead, with the same text. No model writes that text.
pub fn send_back(host: &dyn Host, id: &str, piece_id: &str) -> Result<SentBack, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    // The hold a merge pass takes, kept to the end: no pass begins and merges the commit
    // that is being sent back between the look at its merge below and the piece going back to work.
    let _no_merge = super::merge::hold_for_send_back(id).map_err(|error| EngineError { message: format!("{} A piece is sent back once that has ended.", error.message), ..error })?;
    let run = refreshed(host, id)?;
    if !run.state.live() {
        return Err(EngineError::new("run_not_running", format!("Run {id} is not running ({}). A piece is sent back in a run that is.", state_name(run.state)), None));
    }
    let Some(piece) = run.piece(piece_id) else {
        let mut error = EngineError::new("piece_not_found", format!("Run {id} has no piece {piece_id}."), Some("Use a piece id from `terminalx runs show --json`."));
        error.details = json!({"pieces": run.pieces.iter().map(|piece| piece.id.clone()).collect::<Vec<_>>()});
        return Err(error);
    };
    let Some(text) = super::merge::brief(&run, piece) else {
        let mut error = EngineError::new("nothing_to_send_back", format!("Piece {piece_id} has no failed merge to send back: a piece goes back to its worker when its accepted result conflicts, or fails the integration check."), Some("`terminalx runs show --json` says where each piece's merge stands under `merge`."));
        error.details = json!({"piece": piece_id, "state": piece.state, "merge": piece.current_merge().map(|merge| merge.state)});
        return Err(error);
    };
    let worker = piece.worker.clone().filter(|worker| host.worker(worker) != WorkerNow::Gone);
    if let Some(worker) = worker {
        // A turn in the session it has, started as any worker's is: within the budget and the
        // worker limits (PRO-280). A fresh worker passes them where it is started, below.
        if let Some(reached) = budget::reached(&run, host.now_ms()) {
            return Err(over_budget(host, id, reached, "send the piece back to its worker"));
        }
        let app_limit = host.limits(&run.project_path).workers_at_once as usize;
        let full = if run.in_turn() >= run.limits.workers as usize {
            Some(format!("this run has {} of its {} workers in a turn", run.in_turn(), run.limits.workers))
        } else if in_turn_everywhere()? >= app_limit {
            Some(format!("the app has as many run workers in a turn as it allows ({app_limit})"))
        } else {
            None
        };
        if let Some(full) = full {
            let mut error = EngineError::new("no_free_worker", format!("Piece {piece_id} was not sent back: {full}. Its worker would be one more."), Some("Send it back when a worker's turn has ended, or raise the worker limit for this run."));
            error.details = json!({"piece": piece_id, "inTurn": run.in_turn(), "workers": run.limits.workers});
            return Err(error);
        }
        // Back at work: the try is open again, and what was checked is not what it will report.
        host.check_reset(&worker);
        let (after, ()) = store::update(id, |run| {
            if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
                piece.state = PieceState::Running;
                piece.note = Some("Sent back to its worker: its accepted result could not be merged.".into());
                piece.merge = None;
                if let Some(attempt) = piece.tries.last_mut() {
                    (attempt.outcome, attempt.ended, attempt.verification) = (None, None, None);
                }
            }
            settle(run);
            Ok(())
        })
        .map_err(EngineError::internal)?;
        host.changed(&after);
        if let Err(error) = host.brief_worker(&worker, &text) {
            let error = format!("{error:#}");
            let run = set_piece(id, piece_id, |piece| {
                piece.state = PieceState::Blocked;
                piece.note = Some(format!("It was sent back to its worker, which did not take the message: {error}"));
            })?;
            host.changed(&run);
            return Ok(SentBack { run, piece: piece_id.to_string(), fresh_worker: false, blocked: false, failed: vec![NotStarted { piece: piece_id.to_string(), error }] });
        }
        // A worker in a turn again is watched for a stall, as any is.
        host.watch();
        return Ok(SentBack { run: after, piece: piece_id.to_string(), fresh_worker: false, blocked: false, failed: Vec::new() });
    }
    // Its session is gone: a fresh worker on a branch cut from the lead's, which has the merged pieces in it.
    let failure = failure_text(&text);
    let models = host.models();
    let (run, ()) = store::update(id, |run| {
        let rules = run.ladder();
        if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
            if let Some(attempt) = piece.tries.last_mut() {
                attempt.outcome = Some(Outcome::CheckFailed);
                attempt.detail = Some(failure.clone());
                attempt.ended = Some(crate::store::index::now());
            }
            piece.merge = None;
            climb(piece, &failure, &models, &rules);
        }
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&run);
    let blocked = run.piece(piece_id).is_some_and(Piece::gave_up);
    let start = launch_ready(host, id, Launch::Retries)?;
    Ok(SentBack { run: start.run, piece: piece_id.to_string(), fresh_worker: true, blocked, failed: start.failed })
}

/// A person chose to have the lead resolve a piece's conflict: the lead is
/// sent both sides of each conflicting place and the goals of the pieces
/// involved (`merge::resolve_prompt`), and nothing else.
///
/// It is the merge stage's one model call, and the run's budget counts it: a
/// run past its budget does not start it, and waits for the person instead.
/// What the lead's session costs from here until the piece's merge is
/// settled is added to what the run has used ([`follow_resolution`]).
pub fn resolve_in_lead(host: &dyn Host, id: &str, piece_id: &str) -> Result<Run, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = refreshed(host, id)?;
    // Before the budget: a run that has ended is not paused again by being past it.
    if matches!(run.state, RunState::Stopped | RunState::Done) {
        let mut error = EngineError::new("run_ended", format!("Run {id} has ended ({}): nothing more is merged in it, so the lead is not asked to resolve a conflict.", state_name(run.state)), Some("Merge the branch you want by hand, or create a new run for what is left."));
        error.details = json!({"run": id, "state": run.state});
        return Err(error);
    }
    let prompt = run.piece(piece_id).and_then(|piece| super::merge::resolve_prompt(&run, piece)).ok_or_else(|| EngineError::new("nothing_to_resolve", format!("Piece {piece_id} of run {id} has no merge conflict to resolve."), None))?;
    if let Some(reached) = budget::reached(&run, host.now_ms()) {
        return Err(over_budget(host, id, reached, "ask the lead to resolve the conflict"));
    }
    // Not knowing how the lead is signed in is not "free": a subscription's windows are watched either way.
    let login = host.lead(&run.lead.session_id).map(|lead| host.login(&lead.agent)).unwrap_or(Login::Subscription);
    let lead_usd = host.worker_cost(&run.lead).usd.unwrap_or(0.0);
    let (run, ()) = store::update(id, |run| {
        let merge = run.merge.get_or_insert_with(Default::default);
        merge.end_resolving();
        merge.resolving = Some(super::Resolution { piece: piece_id.to_string(), login, lead_usd, usd: 0.0 });
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&run);
    host.tell_lead(&run, &prompt);
    Ok(run)
}

/// The piece `piece_id` of `run`, or the refusal that names the pieces it has.
fn piece_of<'a>(run: &'a Run, piece_id: &str) -> Result<&'a Piece, EngineError> {
    run.piece(piece_id).ok_or_else(|| {
        let mut error = EngineError::new("piece_not_found", format!("Run {} has no piece {piece_id}.", run.id), Some("Use a piece id from `terminalx runs show --json`."));
        error.details = json!({"pieces": run.pieces.iter().map(|piece| piece.id.clone()).collect::<Vec<_>>()});
        error
    })
}

fn piece_state_name(state: PieceState) -> String {
    serde_json::to_value(state).ok().and_then(|state| state.as_str().map(str::to_owned)).unwrap_or_default()
}

/// A run a person acts on a blocked piece of: started, and not ended by a stop or by being done.
fn acting_on(run: &Run, what: &str) -> Result<(), EngineError> {
    match run.state {
        RunState::AwaitingApproval | RunState::Planned => Err(EngineError::new("run_not_started", format!("Run {} has not started: no piece of it is blocked. To change a piece before it starts, edit the plan.", run.id), None)),
        RunState::Stopped | RunState::Done => {
            let mut error = EngineError::new("run_ended", format!("Run {} has ended ({}), so TerminalX does not {what}.", run.id, state_name(run.state)), Some("Create a new run for what is left."));
            error.details = json!({"run": run.id, "state": run.state});
            Err(error)
        }
        _ => Ok(()),
    }
}

/// The piece `piece_id`, which must be blocked (or failed) for a person to `what` it.
fn blocked<'a>(run: &'a Run, piece_id: &str, what: &str) -> Result<&'a Piece, EngineError> {
    acting_on(run, what)?;
    let piece = piece_of(run, piece_id)?;
    if !matches!(piece.state, PieceState::Blocked | PieceState::Failed) {
        let why = match piece.state {
            PieceState::Running | PieceState::Stalled => "its worker is at work",
            PieceState::Verifying => "its result is being checked",
            PieceState::Queued => "it has not started",
            PieceState::Done => "it is done",
            PieceState::Skipped => "it was skipped",
            PieceState::Lead => "the lead has taken it over",
            _ => "it was stopped",
        };
        let mut error = EngineError::new("piece_not_blocked", format!("Piece {piece_id} is not blocked: {why}. TerminalX does not {what} unless it is."), Some("`terminalx runs show --json` says where each piece stands."));
        error.details = json!({"piece": piece_id, "state": piece.state});
        return Err(error);
    }
    Ok(piece)
}

/// A person approved this run's plan: what changes it (the files a piece owns, a piece left out, a piece
/// lifted out of its scope into the lead) is theirs, from the Run view, not the lead's from the CLI.
fn person_only(run: &Run, piece_id: &str, by: By, what: &str) -> Result<(), EngineError> {
    if by == By::Cli && run.approval.is_some() {
        let mut error = EngineError::new("person_only", format!("A person approved the plan of run {}: only they {what}, in the session's Run view.", run.id), Some("Tell the person what the piece needs and why, then end your turn. You are told here when they decide."));
        error.details = json!({"piece": piece_id});
        return Err(error);
    }
    Ok(())
}

/// A turn of a worker that has a session: within the budget and the worker limits, as any
/// worker's turn is (PRO-280). `what` names it in the refusal.
fn turn_fits(host: &dyn Host, run: &Run, piece_id: &str, what: &str) -> Result<(), EngineError> {
    if let Some(reached) = budget::reached(run, host.now_ms()) {
        return Err(over_budget(host, &run.id, reached, what));
    }
    let app_limit = host.limits(&run.project_path).workers_at_once as usize;
    let full = if run.in_turn() >= run.limits.workers as usize {
        Some(format!("this run has {} of its {} workers in a turn", run.in_turn(), run.limits.workers))
    } else if in_turn_everywhere()? >= app_limit {
        Some(format!("the app has as many run workers in a turn as it allows ({app_limit})"))
    } else {
        None
    };
    match full {
        None => Ok(()),
        Some(full) => {
            let mut error = EngineError::new("no_free_worker", format!("TerminalX did not {what}: {full}. Its worker would be one more."), Some("Try again when a worker's turn has ended, or raise the worker limit for this run."));
            error.details = json!({"piece": piece_id, "inTurn": run.in_turn(), "workers": run.limits.workers});
            Err(error)
        }
    }
}

/// What skipping a piece did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub run: Run,
    /// The piece, then the pieces that depend on it and had not started: left out with it.
    pub skipped: Vec<String>,
}

/// A person leaves a blocked piece out of the run (18.03's Skip piece). No
/// worker works on it again, it is not merged, and the run is done once every
/// other piece is. A piece that depends on it and has not started is left out
/// with it: it would be built on work that will not be there. Asks no model,
/// so it works while the run is paused on its budget.
pub fn skip(host: &dyn Host, id: &str, piece_id: &str, by: By) -> Result<Skipped, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = refreshed(host, id)?;
    acting_on(&run, "skip a piece")?;
    let piece = piece_of(&run, piece_id)?;
    // The lead may give up on a piece it took over, too.
    if !matches!(piece.state, PieceState::Blocked | PieceState::Failed | PieceState::Lead) {
        blocked(&run, piece_id, "skip a piece")?;
    }
    person_only(&run, piece_id, by, "leave a piece out")?;
    let mut skipped = vec![piece_id.to_string()];
    loop {
        let more: Vec<String> = run.pieces.iter().filter(|other| !skipped.contains(&other.id) && other.state == PieceState::Queued && other.worker.is_none() && other.depends_on.iter().any(|on| skipped.contains(on))).map(|other| other.id.clone()).collect();
        if more.is_empty() {
            break;
        }
        skipped.extend(more);
    }
    let at = crate::store::index::now();
    let (after, ()) = store::update(id, |run| {
        for piece in run.pieces.iter_mut().filter(|piece| skipped.contains(&piece.id)) {
            piece.note = Some(match piece.id == piece_id {
                true => "Skipped by a person: the run goes on without it, and it is not merged.".to_string(),
                false => format!("Skipped with piece {piece_id}, which it depends on."),
            });
            piece.state = PieceState::Skipped;
            piece.queued_for = None;
            // A try under way (the lead's) or planned and never started ends here.
            if let Some(attempt) = piece.tries.last_mut().filter(|attempt| attempt.outcome.is_none()) {
                attempt.outcome = Some(Outcome::Stopped);
                attempt.ended = Some(at.clone());
            }
        }
        follow_resolution(run, None);
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&after);
    if by == By::Person {
        let with = if skipped.len() > 1 { format!(", and with it {}, which depend{} on it", skipped[1..].join(", "), if skipped.len() == 2 { "s" } else { "" }) } else { String::new() };
        host.tell_lead(
            &after,
            &format!("The person skipped piece {piece_id} of run {id}{with}. The run goes on without {}: nothing of {} is merged, and the run is done once every other piece is merged. Do not do that work another way unless they ask.", if skipped.len() == 1 { "it" } else { "them" }, if skipped.len() == 1 { "it" } else { "them" }),
        );
    }
    Ok(Skipped { run: after, skipped })
}

/// What widening a piece's files did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Widened {
    pub run: Run,
    pub piece: String,
    /// The files the piece owns now that it did not before.
    pub added: Vec<String>,
    /// A fresh worker was started for it; it waits for a slot or the budget otherwise.
    pub started: bool,
    pub failed: Vec<NotStarted>,
}

/// A person widens a blocked piece's files and has it tried again (18.03's
/// Widen scope and retry). `files` are the paths or globs it should own as
/// well; none means the files its last report and check name outside its
/// scope (`Piece::outside`). A file another piece still works on is refused:
/// two workers would change it at once. The new try is a fresh worker on the
/// last try's model and effort, briefed with what went before, and it starts
/// as any worker does, within the budget and the worker limits.
pub fn widen(host: &dyn Host, id: &str, piece_id: &str, files: &[String], by: By) -> Result<Widened, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = refreshed(host, id)?;
    let piece = blocked(&run, piece_id, "widen a piece's files")?;
    // A person approved the files each piece owns: changing them is theirs, as editing the plan is.
    person_only(&run, piece_id, by, "widen the files a piece owns")?;
    let named: Vec<String> = files.iter().map(|file| file.trim().trim_start_matches("./").to_string()).filter(|file| !file.is_empty()).collect();
    let wanted: Vec<String> = if named.is_empty() { piece.outside(&run).into_iter().map(|outside| outside.path).collect() } else { named };
    // A catch-all (`**`, `*/*`, `.`) is not a widening: it is every file.
    let everything = |path: &str| path.chars().all(|c| matches!(c, '*' | '/' | '.'));
    if let Some(bad) = wanted.iter().find(|path| everything(path)) {
        let mut error = EngineError::new("invalid_path", format!("{bad} is every file of the repository, not a widening. Name the files or directories the piece needs."), None);
        error.details = json!({"piece": piece_id, "path": bad});
        return Err(error);
    }
    if let Some(bad) = wanted.iter().find(|path| path.starts_with('/') || path.contains('\\') || path.split('/').any(|part| part == "..")) {
        let mut error = EngineError::new("invalid_path", format!("{bad} is not a path in the repository: a piece owns paths relative to the repository's root, with forward slashes and no `..`."), None);
        error.details = json!({"piece": piece_id, "path": bad});
        return Err(error);
    }
    let added: Vec<String> = wanted.iter().filter(|path| !plans::owns(&piece.owns, path)).cloned().collect();
    if added.is_empty() {
        let message = match wanted.is_empty() {
            true => format!("Piece {piece_id}'s last report and check name no file outside what it owns, so there is nothing to widen it to."),
            false => format!("Piece {piece_id} already owns {}.", wanted.join(", ")),
        };
        let mut error = EngineError::new("nothing_to_widen", message, Some("Name the files it needs: `terminalx runs widen <piece> --own <path>`, once a path."));
        error.details = json!({"piece": piece_id, "owns": piece.owns});
        return Err(error);
    }
    // A done piece's work is finished, and a skipped one's will not come: only one still to be done is in the way.
    // A directory or a glob is compared as one: `src/store` meets a piece that owns `src/store/a.rs`.
    let meets = |path: &str, other: &Piece| other.owns.iter().any(|owned| plans::overlap(path, owned));
    if let Some((path, other)) = added.iter().find_map(|path| run.pieces.iter().find(|other| other.id != piece_id && meets(path, other) && !other.state.settled() && other.state != PieceState::Stopped).map(|other| (path, other))) {
        let mut error = EngineError::new("owned_by_another", format!("{path} is owned by piece {}, which is {}: two workers would change it at once.", other.id, piece_state_name(other.state)), Some("Widen it once that piece is done, or skip one of them."));
        error.details = json!({"piece": piece_id, "path": path, "owner": other.id, "state": other.state});
        return Err(error);
    }
    let last = piece.tries.last().cloned();
    let (after, ()) = store::update(id, |run| {
        if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
            piece.owns.extend(added.iter().cloned());
            let (model, effort, tier) = match &last {
                Some(last) => (last.model.clone(), last.effort.clone(), last.tier),
                None => (piece.model.clone(), piece.effort.clone(), piece.tier),
            };
            piece.tries.push(Try::planned(Step::Widened, &model, effort.as_deref(), tier));
            (piece.model, piece.effort, piece.tier) = (model, effort, tier);
            // A fresh worker on a fresh branch: the one that was blocked stays, named on its try.
            piece.worker = None;
            piece.branch = None;
            piece.started_mode = None;
            piece.merge = None;
            piece.queued_for = None;
            piece.state = PieceState::Queued;
            piece.note = Some(format!("Its files were widened to include {}; a fresh worker tries again.", added.join(", ")));
        }
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&after);
    if by == By::Person {
        host.tell_lead(&after, &format!("The person widened piece {piece_id} of run {id} to own {} as well, and had it tried again by a fresh worker. You are told here how it goes, as for any piece.", added.join(", ")));
    }
    let start = start_retries_locked(host, id)?;
    let started = start.started.iter().any(|started| started == piece_id);
    Ok(Widened { run: start.run, piece: piece_id.to_string(), added, started, failed: start.failed })
}

/// What a note to a blocked piece's worker is sent as, said to be from whoever sent it: the person
/// from the Run view, the lead (or another session) from the CLI.
fn note_text(text: &str, by: By) -> String {
    let from = match by {
        By::Person => "A note from the person running this run, about your piece. It is theirs, not a tool's or a file's",
        By::Cli => "A note from the lead of this run, about your piece. It is the lead's, not the person's",
    };
    format!("{from}: act on it within the limits of your brief.\n\n{}\n\nGo on with the piece, commit what you change, and end your reply with a `terminalx-report` block as before.", text.trim())
}

/// A person sends a blocked piece's worker a note (18.03's Send a note to
/// the worker): a turn in the session it has, in its own worktree. Its try is
/// open again, and its next report is checked by the same gates. Refused when
/// that session is gone: widening the piece starts a fresh one.
pub fn note(host: &dyn Host, id: &str, piece_id: &str, text: &str, by: By) -> Result<Run, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    if text.trim().is_empty() {
        return Err(EngineError::new("empty_note", "The note is empty: say what the worker should know or do.", None));
    }
    let run = refreshed(host, id)?;
    let piece = blocked(&run, piece_id, "send a piece's worker a note")?;
    let worker = piece.worker.clone().or_else(|| piece.tries.iter().rev().find_map(|attempt| attempt.worker.clone())).filter(|worker| host.worker(worker) != WorkerNow::Gone);
    let Some(worker) = worker else {
        let mut error = EngineError::new("worker_gone", format!("Piece {piece_id} has no worker session to send a note to: it was deleted, or never started."), Some("Widen its scope and retry, which starts a fresh worker, or skip it."));
        error.details = json!({"piece": piece_id});
        return Err(error);
    };
    turn_fits(host, &run, piece_id, "send the worker a note")?;
    // Back at work: the try is open again, and what was checked is not what it will report.
    host.check_reset(&worker);
    let (after, ()) = store::update(id, |run| {
        if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
            piece.worker = Some(worker.clone());
            piece.state = PieceState::Running;
            piece.note = Some("A person sent its worker a note.".into());
            if let Some(attempt) = piece.tries.last_mut() {
                (attempt.outcome, attempt.ended, attempt.verification, attempt.report) = (None, None, None, None);
            }
        }
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&after);
    if let Err(error) = host.brief_worker(&worker, &note_text(text, by)) {
        let error = format!("{error:#}");
        let run = set_piece(id, piece_id, |piece| {
            piece.state = PieceState::Blocked;
            piece.note = Some(format!("A note was sent to its worker, which did not take it: {error}"));
        })?;
        host.changed(&run);
        let mut refusal = EngineError::new("note_not_taken", format!("The worker of piece {piece_id} did not take the note: {error}"), None);
        refusal.details = json!({"piece": piece_id});
        return Err(refusal);
    }
    // A worker in a turn again is watched for a stall, as any is.
    host.watch();
    if by == By::Person {
        host.tell_lead(&after, &format!("The person sent the worker of piece {piece_id} of run {id} a note, and it is at work again:\n\n{}\n\nYou are told here how it goes, as for any piece.", text.trim().lines().map(|line| format!("> {line}")).collect::<Vec<_>>().join("\n")));
    }
    Ok(after)
}

/// A person has the lead take a blocked piece over (18.03's Take over in
/// lead): the lead is sent the piece's brief, what its tries came to and where
/// their work is (`brief::take_over`), and finishes it in its own checkout,
/// where it may change any file. `finish` then checks that and makes the
/// piece done. Like resolving a conflict in the lead, it is a model call the
/// run's budget counts: a run past it does not start it.
pub fn take_over(host: &dyn Host, id: &str, piece_id: &str, by: By) -> Result<Run, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = refreshed(host, id)?;
    let piece = blocked(&run, piece_id, "hand a piece to the lead")?;
    // It lifts the piece out of the files a person approved for it.
    person_only(&run, piece_id, by, "hand a piece to the lead")?;
    if let Some(other) = run.merge.as_ref().and_then(|merge| merge.resolving.as_ref()).filter(|resolving| run.piece(&resolving.piece).is_some_and(|other| other.state == PieceState::Lead || other.current_merge().is_some_and(|merge| merge.state == MergeState::Conflict))) {
        let mut error = EngineError::new("lead_busy", format!("The lead is already working on piece {} for you: it takes one piece at a time.", other.piece), Some("Wait until that piece is settled, or skip it."));
        error.details = json!({"piece": piece_id, "busyWith": other.piece});
        return Err(error);
    }
    if let Some(reached) = budget::reached(&run, host.now_ms()) {
        return Err(over_budget(host, id, reached, "hand the piece to the lead"));
    }
    let Some(head) = host.lead_head(&run) else {
        return Err(EngineError::new("lead_not_found", "The lead's checkout cannot be read, so its work on the piece could not be told from what was there before.", None));
    };
    let lead = host.lead(&run.lead.session_id).ok();
    let login = lead.as_ref().map(|lead| host.login(&lead.agent)).unwrap_or(Login::Subscription);
    let lead_usd = host.worker_cost(&run.lead).usd.unwrap_or(0.0);
    let prompt = brief::take_over(&run, piece, &head, by == By::Person);
    let at = crate::store::index::now();
    let (after, ()) = store::update(id, |run| {
        let merge = run.merge.get_or_insert_with(Default::default);
        merge.end_resolving();
        merge.resolving = Some(super::Resolution { piece: piece_id.to_string(), login, lead_usd, usd: 0.0 });
        if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
            let mut attempt = Try::planned(Step::Lead, lead.as_ref().map_or("", |lead| lead.model.as_str()), None, None);
            attempt.worker = Some(run.lead.clone());
            attempt.from_commit = Some(head.clone());
            attempt.started = Some(at.clone());
            piece.tries.push(attempt);
            piece.state = PieceState::Lead;
            piece.queued_for = None;
            piece.note = Some("Taken over by the lead: it finishes the piece in its own checkout.".into());
        }
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&after);
    host.tell_lead(&after, &prompt);
    Ok(after)
}

/// What checking the lead's work on a piece it took over came to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub run: Run,
    pub piece: String,
    /// The commit of the lead's branch the piece is done at.
    pub commit: String,
    pub checks: Vec<checks::CommandRun>,
}

/// The lead says it finished a piece it took over: what it committed since is
/// the piece's result, checked by the piece's command done-checks in the
/// lead's checkout. Passing, the piece is done and in the lead's branch
/// already, so the merge counts it as merged by hand; failing, it stays with
/// the lead, and what the check printed is kept on its try.
pub fn finish(host: &dyn Host, id: &str, piece_id: &str, by: By, by_lead: bool) -> Result<Finished, EngineError> {
    let starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let run = refreshed(host, id)?;
    acting_on(&run, "finish a piece")?;
    let piece = piece_of(&run, piece_id)?;
    let since = piece.tries.last().filter(|attempt| attempt.step == Step::Lead && piece.state == PieceState::Lead).and_then(|attempt| attempt.from_commit.clone());
    let Some(since) = since else {
        let mut error = EngineError::new("not_taken_over", format!("Piece {piece_id} is not with the lead: a piece is finished this way once the lead has taken it over."), Some("A blocked piece is handed to the lead from the Run view, or with `terminalx runs take-over <piece>`."));
        error.details = json!({"piece": piece_id, "state": piece.state});
        return Err(error);
    };
    let commands = piece.done_checks.iter().any(|check| matches!(check, super::Check::Command { .. }));
    // The rule a merge keeps (`verify::may_run_commands`): a plan's commands are run unasked for a
    // person, for an approved plan, or for a lead that runs commands unasked itself.
    if by == By::Cli && commands && !checks::may_run_commands(run.approval.is_some(), host.lead_mode(&run).as_deref().unwrap_or_default()) {
        return Err(EngineError::new(
            "checks_not_approved",
            "Finishing runs the plan's commands in the lead's checkout, and nobody approved this plan: TerminalX does not run them unasked for a lead that is itself asked before it runs a command.",
            Some("Ask the person to press Check and finish in the session's Run view."),
        ));
    }
    let work = host.lead_work(&run, &since).map_err(|error| EngineError::new("lead_not_found", format!("The lead's checkout cannot be read: {error:#}"), None))?;
    if !work.uncommitted.is_empty() {
        let mut error = EngineError::new("uncommitted", format!("The lead's checkout has changes that are not committed: {}. A piece is finished as a commit.", work.uncommitted.iter().take(8).cloned().collect::<Vec<_>>().join(", ")), Some("Commit them, then finish the piece again."));
        error.details = json!({"piece": piece_id, "files": work.uncommitted});
        return Err(error);
    }
    if work.changes.is_empty() {
        let mut error = EngineError::new("nothing_committed", format!("Nothing was committed in the lead's branch since it took piece {piece_id} over at {}.", &since[..since.len().min(7)]), Some("Commit the piece's work in the lead's checkout first, or skip the piece."));
        error.details = json!({"piece": piece_id, "since": since});
        return Err(error);
    }
    let ran = host.lead_commands(&run, piece, by_lead).map_err(|why| EngineError::new("checkout_busy", format!("The lead's checkout is in use: {why} Nothing was checked."), Some("Finish the piece again once it is free.")))?;
    let failed = ran.iter().find(|command| !command.passed).cloned();
    let at = crate::store::index::now();
    let files: Vec<String> = work.changes.iter().map(|change| change.path.clone()).collect();
    let lines: u32 = work.changes.iter().map(|change| change.added.unwrap_or(0) + change.removed.unwrap_or(0)).sum();
    let gate = match (&failed, ran.is_empty()) {
        (Some(failed), _) => checks::GateResult { gate: Gate::Commands, passed: false, detail: Some(format!("`{}` {} in the lead's checkout.", failed.run, failed.exit_code.map_or("did not finish".to_string(), |code| format!("exited {code}")))), commands: ran.clone() },
        (None, false) => checks::GateResult { gate: Gate::Commands, passed: true, detail: Some(format!("{} passed in the lead's checkout.", if ran.len() == 1 { "Its command".to_string() } else { format!("All {} of its commands", ran.len()) })), commands: ran.clone() },
        (None, true) => GateResult::passed(Gate::Commands, "The piece has no command to run: the lead's commit is its result."),
    };
    let (after, ()) = store::update(id, |run| {
        if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
            if let Some(attempt) = piece.tries.last_mut() {
                attempt.verification = Some(Verification {
                    gates: vec![GateResult::passed(Gate::Report, "The lead said it finished the piece."), gate.clone()],
                    facts: Some(checks::Facts { files: files.clone(), changed_lines: lines, changes: work.changes.clone(), commit: Some(work.head.clone()), ..Default::default() }),
                    outcome: Some(if failed.is_some() { checks::Outcome::Failed } else { checks::Outcome::Passed }),
                    failure: gate.detail.clone().filter(|_| failed.is_some()),
                    started: Some(at.clone()),
                    ended: Some(at.clone()),
                    ..Verification::default()
                });
                if failed.is_none() {
                    attempt.outcome = Some(Outcome::Done);
                    attempt.ended = Some(at.clone());
                    attempt.detail = Some(format!("Finished by the lead at {}.", &work.head[..work.head.len().min(7)]));
                }
            }
            match &failed {
                None => {
                    piece.state = PieceState::Done;
                    piece.note = Some(format!("Finished by the lead in its own checkout, at {}; its checks passed there.", &work.head[..work.head.len().min(7)]));
                }
                Some(failed) => piece.note = Some(format!("The lead's work did not pass its checks: `{}` {}.", failed.run, failed.exit_code.map_or("did not finish".to_string(), |code| format!("exited {code}")))),
            }
        }
        follow_resolution(run, None);
        settle(run);
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&after);
    if let Some(failed) = failed {
        let mut error = EngineError::new("checks_failed", format!("Piece {piece_id} is not done: `{}` {} in the lead's checkout. It stays with the lead.", failed.run, failed.exit_code.map_or("did not finish".to_string(), |code| format!("exited {code}"))), Some("Fix it in the lead's checkout, commit, and finish the piece again."));
        error.details = json!({"piece": piece_id, "check": failed});
        return Err(error);
    }
    if by == By::Person {
        host.tell_lead(&after, &format!("The person checked piece {piece_id} of run {id}: what you committed passed its checks, so it is done. Start what waited for it with `terminalx runs start {id} --json`."));
    }
    // What waited on it may start, and its slot is free for a queued piece: started under the same lock.
    drop(starting);
    host.fill_later();
    Ok(Finished { run: after, piece: piece_id.to_string(), commit: work.head, checks: ran })
}

/// The run is past its budget, so a model call of its merge stage was not
/// started: the run waits for the person (`needsYou`), as it does when a
/// piece would start, and the caller is told which limit.
fn over_budget(host: &dyn Host, id: &str, reached: Pause, what: &str) -> EngineError {
    let message = format!("Run {id} is past its budget, so TerminalX did not {what}. {}", reached.message);
    if let Err(error) = pause(host, id, reached.clone(), &[]) {
        log::warn!("mark run {id} as past its budget: {error}");
    }
    let mut error = EngineError::new("budget_reached", message, Some("Raise the budget for this run and resume it, or let it go on after the window resets. Resolving the conflict by hand in the lead's checkout, then merging again (`terminalx runs merge`, or `--skip <piece>` to leave it out), uses none of it and works while the run is paused."));
    error.details = json!({"run": id, "pause": reached});
    error
}

/// Keep what the lead's conflict-resolving call has cost up to date, and
/// end it once its piece's merge is settled: merged, or sent back to work.
/// `lead_usd` is what the lead's session has cost now, when it was read.
fn follow_resolution(run: &mut Run, lead_usd: Option<f64>) {
    let Some(piece) = run.merge.as_ref().and_then(|merge| merge.resolving.as_ref()).map(|resolving| resolving.piece.clone()) else { return };
    // A conflict the lead resolves, or a piece it took over: open until the piece is settled either way.
    let open = run.piece(&piece).is_some_and(|piece| piece.state == PieceState::Lead || piece.current_merge().is_some_and(|merge| merge.state == MergeState::Conflict));
    let Some(merge) = run.merge.as_mut() else { return };
    if let (Some(now), Some(resolving)) = (lead_usd, merge.resolving.as_mut()) {
        resolving.usd = (now - resolving.lead_usd).max(0.0);
    }
    if !open {
        merge.end_resolving();
    }
}

/// What the pieces make of a started run. Merging when every piece's result
/// is accepted: it is done once those are merged (`merge`). Failed when a
/// piece failed or ran out of tries and nothing is running or could start;
/// running otherwise.
fn settle(run: &mut Run) {
    if run.state == RunState::NeedsYou {
        // It waits for the person until every piece's result is accepted anyway. Merging those
        // starts no worker and asks no model, so it does not wait on the budget; a merge that
        // stopped and needs resolving does, and the run stays with the person.
        let unresolved = run.pieces.iter().any(|piece| piece.current_merge().is_some_and(|merge| matches!(merge.state, MergeState::Conflict | MergeState::IntegrationFailed | MergeState::Failed)));
        if run.pieces.iter().all(|piece| piece.state.settled()) && !unresolved {
            run.state = RunState::Merging;
            run.reason = None;
            run.pause = None;
        }
        return;
    }
    if !run.state.live() {
        return;
    }
    // A blocked piece does not end the run: a person can take it over in the lead, widen it, send
    // its worker a note or skip it (PRO-361). Only a piece that failed with nothing to try does.
    let failed: Vec<&Piece> = run.pieces.iter().filter(|piece| piece.state == PieceState::Failed && piece.worker.is_some() && piece.tries.is_empty()).collect();
    let (state, reason) = if run.pieces.iter().all(|piece| piece.state.settled()) {
        // Every result is accepted. The run is done once they are merged into the lead's branch
        // and the checks pass there (`merge::merge`), which says so itself: what keeps a merged
        // run from done is its reason until then.
        (RunState::Merging, if run.state == RunState::Merging { run.reason.clone() } else { None })
    } else if run.pieces.iter().any(|piece| matches!(piece.state, PieceState::Running | PieceState::Stalled | PieceState::Verifying | PieceState::Lead)) || !run.ready().is_empty() || failed.is_empty() {
        (RunState::Running, None)
    } else {
        let names: Vec<String> = failed.iter().map(|piece| piece.id.clone()).collect();
        // Only a piece stored before tries were kept gets here: its worker reported failed and it has no ladder.
        let said: Vec<String> = failed.iter().map(|piece| format!("{} failed.", piece.id)).collect();
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
    let starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
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
            piece.queued_for = None;
            // A try that was under way, or planned and never started, ends here.
            if let Some(attempt) = piece.tries.last_mut().filter(|attempt| attempt.outcome.is_none()) {
                attempt.outcome = Some(Outcome::Stopped);
                attempt.ended = Some(crate::store::index::now());
            }
        }
        run.state = RunState::Stopped;
        run.pause = None;
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
    // Its workers' slots are free for other runs, which start under the same lock.
    drop(starting);
    host.fill_later();
    Ok(Stop { run: after, stopped, failed })
}

/// A person changes the worker limit or the budget of one run: while
/// approving it, or when it stopped to ask. A paused run stays paused until
/// it is resumed.
pub fn set_limits(host: &dyn Host, id: &str, limits: RunLimits) -> Result<Run, EngineError> {
    limits.valid().map_err(|message| EngineError::new("invalid_limits", message, None))?;
    let run = stored(id)?;
    if run.state.ended() {
        return Err(EngineError::new("run_ended", format!("Run {id} has ended ({}).", state_name(run.state)), None));
    }
    let (run, ()) = store::update(id, |run| {
        run.limits = limits;
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&run);
    // A higher worker limit is room for what queued.
    if run.state == RunState::Running {
        host.fill_later();
    }
    Ok(run)
}

/// What a person asks of a paused run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resume {
    /// Go on now: refused while the run is still past its budget.
    Now,
    /// Go on by itself once the window that stopped it resets.
    AfterReset,
}

/// A person lets a run that reached its budget go on.
pub fn resume(host: &dyn Host, id: &str, how: Resume) -> Result<Start, EngineError> {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    resume_locked(host, id, how, false)
}

fn resume_locked(host: &dyn Host, id: &str, how: Resume, by_reset: bool) -> Result<Start, EngineError> {
    let run = stored(id)?;
    if run.state != RunState::NeedsYou {
        return Err(EngineError::new("not_paused", format!("Run {id} is not waiting for you ({}).", state_name(run.state)), None));
    }
    if how == Resume::AfterReset {
        let Some(at) = run.pause.as_ref().and_then(|pause| pause.window.as_ref()).and_then(|window| window.resets_at) else {
            return Err(EngineError::new("no_reset", "This run did not stop on a usage window with a known reset time.", Some("Raise its budget, then resume it.")));
        };
        let (run, ()) = store::update(id, |run| {
            if let Some(pause) = run.pause.as_mut() {
                pause.resume_at = Some(at);
            }
            Ok(())
        })
        .map_err(EngineError::internal)?;
        host.changed(&run);
        host.watch();
        let waiting = waiting(&run);
        return Ok(Start { run, started: Vec::new(), waiting, failed: Vec::new() });
    }
    let mut current = run.clone();
    update_usage(host, &mut current);
    if let Some(reached) = budget::reached(&current, host.now_ms()) {
        let mut error = EngineError::new("budget_reached", format!("The run is still past its budget. {}", reached.message), Some("Raise the budget for this run, or let it go on after the window resets."));
        error.details = json!({"run": id, "pause": reached});
        return Err(error);
    }
    store::update(id, |run| {
        run.usage = current.usage.clone();
        run.state = RunState::Running;
        run.reason = None;
        run.pause = None;
        Ok(())
    })
    .map_err(EngineError::internal)?;
    let start = launch_ready(host, id, Launch::Held)?;
    let how = if by_reset { "Its usage window reset, as the person asked, so the run goes on." } else { "The person let it go on." };
    let started = if start.started.is_empty() { "No piece waited to start; call `terminalx runs start` when the next one is ready.".to_string() } else { format!("Workers were started for: {}.", start.started.join(", ")) };
    host.tell_lead(&start.run, &format!("Run {id} is running again. {how} {started}"));
    Ok(start)
}

/// Start the pieces that wait for a free worker slot, in every running run,
/// oldest run first. Called when a worker's turn ends, a run stops or a limit
/// rises: the lead does not call again for them.
pub fn fill_slots(host: &dyn Host) {
    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
    let runs = match store::list() {
        Ok(runs) => runs,
        Err(error) => return log::warn!("read the runs to start queued pieces: {error:#}"),
    };
    for run in runs.iter().filter(|run| matches!(run.state, RunState::Running | RunState::Failed)) {
        // Ready pieces a limit held (a next try among them), and pieces whose session waits for its brief behind one.
        // A next try no limit has held yet is `start_retries`'s to start, not a freed slot's.
        let held = |piece: &&Piece| matches!(piece.queued_for, Some(Hold::RunLimit | Hold::AppLimit));
        if !run.ready().iter().any(held) && !run.pieces.iter().filter(|piece| piece.held.is_some() && piece.worker.is_some()).any(|piece| held(&piece)) {
            continue;
        }
        // Read first: a worker whose session was deleted mid-turn holds its slot until a read
        // finds it gone, and no turn of it ends to say so.
        if let Err(error) = refreshed(host, &run.id) {
            log::warn!("read run {} before starting its queued pieces: {error}", run.id);
        }
        match launch_ready(host, &run.id, Launch::Held) {
            Ok(start) if !start.started.is_empty() => log::info!("run {}: started queued pieces {}", run.id, start.started.join(", ")),
            Ok(_) => {}
            Err(error) => log::warn!("start the queued pieces of run {}: {error}", run.id),
        }
    }
}

/// What a watch found: whether there is still anything to watch.
pub fn watch(host: &dyn Host) -> bool {
    let now = host.now_ms();
    let Ok(runs) = store::list() else { return true };
    let (mut more, mut fill) = (false, false);
    for run in runs.iter().filter(|run| !run.state.ended()) {
        if run.state == RunState::NeedsYou {
            match run.pause.as_ref().and_then(|pause| pause.resume_at) {
                // Past the reset, but the window has not been read since: its last reading is the
                // full one before the reset. Wait for one that is not; the person's ask stands.
                Some(at) if at <= now && !read_since_reset(host, run, at) => more = true,
                Some(at) if at <= now => {
                    let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
                    match resume_locked(host, &run.id, Resume::Now, true) {
                        Ok(_) => {}
                        // The new window filled already, or the run is past another limit: it waits for the person.
                        Err(error) => {
                            let _ = store::update(&run.id, |run| {
                                if let Some(pause) = run.pause.as_mut() {
                                    pause.resume_at = None;
                                }
                                Ok(())
                            });
                            host.tell_lead(run, &format!("Run {} was to go on after its usage window reset, but it cannot: {}", run.id, error.message));
                        }
                    }
                }
                Some(_) => more = true,
                None => {}
            }
        }
        if let Err(error) = mark_stalls(host, &run.id, now) {
            log::warn!("check run {} for stalled workers: {error}", run.id);
        }
        more |= stored(&run.id).is_ok_and(|run| run.in_turn() > 0);
        fill |= matches!(run.state, RunState::Running | RunState::Failed) && run.pieces.iter().any(|piece| matches!(piece.queued_for, Some(Hold::RunLimit | Hold::AppLimit)));
    }
    // What waits for a slot is looked at on every tick, not only when a turn ends: a slot can
    // free up without one (a worker's session deleted mid-turn).
    if fill {
        host.fill_later();
    }
    more
}

/// Whether the window that paused a run has been read afresh since it reset at
/// `at`: a reading that is not stale, taken after the reset or naming a later one.
fn read_since_reset(host: &dyn Host, run: &Run, at: i64) -> bool {
    let Some(paused) = run.pause.as_ref().and_then(|pause| pause.window.as_ref()) else { return true };
    host.windows().iter().any(|window| {
        window.agent == paused.agent && window.key == paused.key && !window.stale && (window.updated_at >= at || window.resets_at.is_some_and(|next| next > at + 60_000))
    })
}

/// Whether a worker in a turn is stalled: nothing for the stall time, no
/// command of its running, and its agent idle. Never on no evidence.
fn stalled(activity: &Activity, now: i64, stall_ms: i64) -> Option<i64> {
    if activity.command_running || activity.busy {
        return None;
    }
    let quiet = now - activity.last_ms?;
    (quiet >= stall_ms).then_some(quiet)
}

fn mark_stalls(host: &dyn Host, id: &str, now: i64) -> Result<(), EngineError> {
    let run = stored(id)?;
    let stall_ms = i64::from(host.limits(&run.project_path).stall_minutes) * 60_000;
    let seen: Vec<(String, SessionRef, Option<i64>)> = run
        .pieces
        .iter()
        .filter(|piece| matches!(piece.state, PieceState::Running | PieceState::Stalled))
        .filter_map(|piece| piece.worker.clone().map(|worker| (piece.id.clone(), worker.clone(), stalled(&host.activity(&worker), now, stall_ms))))
        .collect();
    let mut newly = Vec::new();
    let (after, ()) = store::update(id, |run| {
        for (piece_id, worker, quiet) in &seen {
            let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == *piece_id && piece.worker.as_ref() == Some(worker) && matches!(piece.state, PieceState::Running | PieceState::Stalled)) else { continue };
            match (piece.state, quiet) {
                (PieceState::Running, Some(quiet)) => {
                    piece.state = PieceState::Stalled;
                    piece.note = Some(format!("Stalled: no tool call or file change for {} minutes, no command running, and its agent is idle.", quiet / 60_000));
                    newly.push((piece.id.clone(), piece.title.clone(), worker.session_id.clone(), quiet / 60_000));
                }
                (PieceState::Stalled, None) => {
                    piece.state = PieceState::Running;
                    piece.note = None;
                }
                _ => {}
            }
        }
        Ok(())
    })
    .map_err(EngineError::internal)?;
    if after != run {
        host.changed(&after);
    }
    for (piece, title, session, minutes) in newly {
        host.tell_lead(
            &after,
            &format!(
                "The worker of piece {piece} ({title}) in run {id} looks stalled: it has made no tool call or file change for {minutes} minutes, runs no command, and its agent is idle. Look at it with `terminalx sessions show {session} --json`, send it what it needs, or stop it. It still counts as a running worker."
            ),
        );
    }
    Ok(())
}

/// A turn ended in `session_id`: if it is a run's worker, its piece follows.
/// Returns the run when a piece of it now waits for its next try. Starting
/// that try is not the caller's: the read that took the ladder's step asked
/// the host for it ([`Host::retry_waits`]), and that read may have been
/// another one (`runs show`, the Run view) that got there first.
pub fn worker_turn_ended(host: &dyn Host, session_id: &str) -> Option<String> {
    match store::for_worker(session_id) {
        Ok(Some((run, _))) => {
            let after = refreshed(host, &run.id);
            // Its slot may be free: what waits for one starts, in this run or another.
            host.fill_later();
            match after {
                Ok(after) => return after.pieces.iter().any(Piece::retry_waits).then_some(after.id),
                Err(error) => log::warn!("refresh run {} after its worker {session_id} ended a turn: {error}", run.id),
            }
        }
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
    let settled = |state: PieceState| matches!(state, PieceState::Done | PieceState::Blocked | PieceState::Failed | PieceState::Stopped | PieceState::Skipped);
    let changed: Vec<&Piece> = now.pieces.iter().filter(|piece| settled(piece.state) && began.piece(&piece.id).is_none_or(|before| before.state != piece.state)).collect();
    // A piece whose next try waits is started without the lead: it is not the lead's to start.
    let ready: Vec<String> = if matches!(now.state, RunState::Planned | RunState::Running) { now.ready().into_iter().filter(|piece| !piece.retry_waits()).map(|piece| piece.id.clone()).collect() } else { Vec::new() };
    let under_way = now.pieces.iter().any(|piece| matches!(piece.state, PieceState::Running | PieceState::Verifying) || piece.retry_waits());
    // Every result accepted: the lead is woken to merge them.
    let to_merge = now.state == RunState::Merging;
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
    if to_merge {
        why.push(match now.reason.as_deref() {
            Some(reason) => reason.to_string(),
            None => format!("Every piece's result is accepted. Merge them into your branch with `terminalx runs merge {} --json`: the run is done once they are merged and the checks pass there.", now.id),
        });
    } else if ended {
        why.push(format!("The run is {}.", state_name(now.state)));
    } else if !under_way && ready.is_empty() {
        let held: Vec<String> = now.pieces.iter().filter(|piece| matches!(piece.state, PieceState::Blocked | PieceState::Failed)).map(|piece| piece.id.clone()).collect();
        let yours: Vec<String> = now.pieces.iter().filter(|piece| piece.state == PieceState::Lead).map(|piece| piece.id.clone()).collect();
        let mut said = String::new();
        if !held.is_empty() {
            said.push_str(&format!(" Held up by: {}. `terminalx runs show` says why for each; the person decides what happens to a blocked piece.", held.join(", ")));
        }
        if !yours.is_empty() {
            said.push_str(&format!(" Taken over by you: {}. Finish {} in your checkout, commit, then `terminalx runs finish <piece>`.", yours.join(", "), if yours.len() == 1 { "it" } else { "them" }));
        }
        why.push(format!("Nothing is under way and nothing can start: waiting changes nothing.{said}"));
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
    value["inTurn"] = json!(run.in_turn());
    // What does not fit in what is left, for the person approving it.
    value["fit"] = json!(if matches!(run.state, RunState::AwaitingApproval | RunState::Planned) { budget::fit(run, chrono::Utc::now().timestamp_millis()) } else { Vec::new() });
    // `maxTries` and `effortCeiling` are the run's own fields: its ladder as Settings had it when it was made.
    // The order `runs merge` takes the pieces in, and whether a pass is at work on them now.
    value["mergeOrder"] = json!(run.merge_order().iter().map(|piece| piece.id.clone()).collect::<Vec<_>>());
    value["mergeUnderWay"] = json!(super::merge::under_way(&run.id));
    // What checking the results cost: the tokens of every verifier session, apart from the workers'.
    let verifier_tokens: Vec<u64> = run.pieces.iter().flat_map(|piece| &piece.tries).filter_map(|attempt| attempt.verification.as_ref()?.review.as_ref()?.tokens()).collect();
    value["verifierTokens"] = json!((!verifier_tokens.is_empty()).then(|| verifier_tokens.iter().sum::<u64>()));
    // What each piece's tries cost so far, and the run's workers together.
    let (mut total, mut unpriced) = (None::<f64>, Vec::<String>::new());
    for (index, piece) in run.pieces.iter().enumerate() {
        let (cost, missing) = piece.cost();
        value["pieces"][index]["costUsd"] = json!(cost);
        // Files its last report or check names that it does not own: where a blocked piece's fix lies.
        let outside = piece.outside(run);
        if !outside.is_empty() {
            value["pieces"][index]["outside"] = json!(outside);
        }
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
