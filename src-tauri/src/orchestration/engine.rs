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

use super::budget::{self, Login, Pause, RunLimits};
use super::plan::{self, Plan, PlanError};
use super::{brief, guard, store, Approval, Hold, Piece, PieceState, Run, RunState, SessionRef};
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
    /// Workers need worktrees, so the project must be a git repository.
    pub repository: bool,
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
    /// How a new tab of `agent` would be signed in now.
    fn login(&self, agent: &str) -> Login;
    /// The usage windows as the status bar has them now.
    fn windows(&self) -> Vec<UsageWindow>;
    /// What a worker's session has cost so far, at API prices; `None` before it was read.
    fn cost(&self, worker: &SessionRef) -> Option<f64>;
    /// What a worker in a turn has been doing.
    fn activity(&self, worker: &SessionRef) -> Activity;
    /// Start what waits for a free worker slot ([`fill_slots`]), soon and
    /// outside the caller's locks: a turn ending must not wait on a start.
    fn fill_later(&self);
    /// Make sure something calls [`watch`] while a run has workers in a turn
    /// or waits to resume after a reset.
    fn watch(&self);
    fn now_ms(&self) -> i64;
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
        limits: RunLimits::new(&limits, &plan.budget),
        worker_mode: limits.worker_mode,
        plan_edited: false,
        approval: None,
        reason: None,
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
    let pieces = plan::validate(plan, &rules_for(&limits, &lead, &agents))?;
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
                Some("Tell the person, then end your turn. The pieces you asked for start when they raise the budget or resume the run, and you are told here."),
            );
            error.details = json!({"run": id, "pause": run.pause});
            Err(error)
        }
        _ => launch_ready(host, id, Which::Ready),
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
    let start = launch_ready(host, id, Which::Ready)?;
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
            "The person approved the plan of run {id}.{edited} {started}\n\nWait for them with `terminalx wait --children-of {lead} --any --json`, read what they report with `terminalx sessions report --children-of {lead} --json`, and call `terminalx runs start {id} --json` again whenever a piece is done: it starts the pieces that waited on it."
        ),
    );
    Ok(start)
}

/// Which pieces a launch considers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Which {
    /// Every ready piece: what the lead's `runs start` and an approval ask for.
    Ready,
    /// Only the ready pieces a limit held: what a freed slot or a resume starts.
    /// A piece that became ready since waits for the lead, who may have to
    /// collect a finished piece's branch before it starts.
    Held,
}

/// Run workers in a turn across every run: what the app-wide limit counts.
/// Sessions a person started by hand are not workers and are never counted.
fn in_turn_everywhere() -> Result<usize, EngineError> {
    Ok(store::list().map_err(EngineError::internal)?.iter().filter(|run| !run.state.ended()).map(Run::in_turn).sum())
}

/// What the budget is computed from, read from the host outside the store's
/// lock: the usage windows, each started worker's cost, each agent's login.
struct Reading {
    windows: Vec<UsageWindow>,
    costs: std::collections::HashMap<String, f64>,
    logins: std::collections::HashMap<String, Login>,
}

fn read_usage(host: &dyn Host, run: &Run) -> Reading {
    let costs = run.pieces.iter().filter_map(|piece| piece.worker.as_ref()).filter_map(|worker| host.cost(worker).map(|cost| (worker.session_id.clone(), cost))).collect();
    let logins = run.pieces.iter().map(|piece| piece.agent.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().map(|agent| (agent.clone(), host.login(&agent))).collect();
    Reading { windows: host.windows(), costs, logins }
}

/// Bring a run's usage up to date. Its share of a window starts to count once
/// it has a worker, or (`starting`) as its first one is about to start.
fn apply_usage(run: &mut Run, reading: &Reading, starting: bool) {
    let active = starting || run.pieces.iter().any(|piece| piece.worker.is_some());
    let cost = |piece: &Piece| piece.worker.as_ref().and_then(|worker| reading.costs.get(&worker.session_id).copied());
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

fn launch_ready(host: &dyn Host, id: &str, which: Which) -> Result<Start, EngineError> {
    let run = stored(id)?;
    // Until its piece is stored, a worker is known as one by who started it.
    let _limited = guard::starting(&run.lead.session_id);
    let app_limit = host.limits(&run.project_path).workers_at_once as usize;
    // Pieces whose worker has a session it was never briefed in, and pieces with no worker yet.
    let ready: Vec<String> = run
        .pieces
        .iter()
        .filter(|piece| piece.held.is_some() && piece.worker.is_some())
        .chain(run.ready().into_iter().filter(|piece| which == Which::Ready || piece.queued_for.is_some()))
        .map(|piece| piece.id.clone())
        .collect();
    let (mut started, mut failed) = (Vec::new(), Vec::new());
    for (index, piece_id) in ready.iter().enumerate() {
        let piece_id = piece_id.clone();
        // Read again each time: the brief of a later piece names what earlier ones reported.
        let run = stored(id)?;
        let Some(piece) = run.piece(&piece_id) else { continue };
        let reuse = piece.worker.is_some() && piece.held.is_some();
        if !reuse {
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
    if !matches!(run.state, RunState::Running | RunState::Failed | RunState::NeedsYou) {
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
    let reading = read_usage(host, &run);
    let now_ms = host.now_ms();
    let (after, reached) = store::update(id, |run| {
        if !matches!(run.state, RunState::Running | RunState::Failed | RunState::NeedsYou) {
            return Ok(None);
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
            // Still in its turn: whether it is stalled is the watcher's to say ([`watch`]).
            if state == PieceState::Running && piece.state == PieceState::Stalled {
                continue;
            }
            piece.state = state;
            // A worker back at work keeps the line it last reported until it reports again.
            if state != PieceState::Running {
                piece.note = note;
            }
        }
        apply_usage(run, &reading, false);
        settle(run);
        Ok((run.state == RunState::Running).then(|| budget::reached(run, now_ms)).flatten())
    })
    .map_err(EngineError::internal)?;
    // A runtime that restarted has no watcher yet for the workers it found running.
    if after.in_turn() > 0 || after.pause.as_ref().is_some_and(|pause| pause.resume_at.is_some()) {
        host.watch();
    }
    if let Some(reached) = reached {
        return pause(host, id, reached, &[]);
    }
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
    if run.state == RunState::NeedsYou {
        // It waits for the person until every piece is done anyway.
        if run.pieces.iter().all(|piece| piece.state == PieceState::Done) {
            run.state = RunState::Done;
            run.reason = None;
            run.pause = None;
        }
        return;
    }
    if !matches!(run.state, RunState::Running | RunState::Failed) {
        return;
    }
    let failed: Vec<&Piece> = run.pieces.iter().filter(|piece| piece.state == PieceState::Failed && piece.worker.is_some()).collect();
    let (state, reason) = if run.pieces.iter().all(|piece| piece.state == PieceState::Done) {
        (RunState::Done, None)
    } else if run.pieces.iter().any(|piece| matches!(piece.state, PieceState::Running | PieceState::Stalled)) || !run.ready().is_empty() || failed.is_empty() {
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
    let start = launch_ready(host, id, Which::Held)?;
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
    for run in runs.iter().filter(|run| run.state == RunState::Running) {
        if !run.ready().iter().any(|piece| matches!(piece.queued_for, Some(Hold::RunLimit | Hold::AppLimit))) {
            continue;
        }
        match launch_ready(host, &run.id, Which::Held) {
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
    let mut more = false;
    for run in runs.iter().filter(|run| !run.state.ended()) {
        if run.state == RunState::NeedsYou {
            match run.pause.as_ref().and_then(|pause| pause.resume_at) {
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
    }
    more
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
pub fn worker_turn_ended(host: &dyn Host, session_id: &str) {
    match store::for_worker(session_id) {
        Ok(Some((run, _))) => {
            if let Err(error) = refreshed(host, &run.id) {
                log::warn!("refresh run {} after its worker {session_id} ended a turn: {error}", run.id);
            }
            // Its slot may be free: what waits for one starts, in this run or another.
            host.fill_later();
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
    value["inTurn"] = json!(run.in_turn());
    // What does not fit in what is left, for the person approving it.
    value["fit"] = json!(if matches!(run.state, RunState::AwaitingApproval | RunState::Planned) { budget::fit(run, chrono::Utc::now().timestamp_millis()) } else { Vec::new() });
    value
}

fn state_name(state: RunState) -> String {
    serde_json::to_value(state).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}
