//! The engine against a stand-in for the app's sessions: what starts when,
//! what a report makes of a piece, what survives a restart, what a stop leaves.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use serde_json::json;

use super::engine::{self, By, Cost, EngineError, Host, Lead, Started, VerifierNow, WorkerNow};
use super::verify::{self, Checked, Facts, Gate, GateResult};
use super::plan::Plan;
use super::ladder::Step;
use super::routing::Tier;
use super::{store, Outcome, Piece, PieceState, Run, RunState, SessionRef};
use crate::store::settings::{OrchestratorLimits, OrchestratorSettings};
use crate::worker_report::Status;

/// A worker the stand-in made, as the engine asked for it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Made {
    piece: String,
    agent: String,
    model: String,
    effort: Option<String>,
    mode: String,
    session: String,
}

#[derive(Default)]
struct World {
    made: Vec<Made>,
    briefs: BTreeMap<String, String>,
    now: BTreeMap<String, WorkerNow>,
    running: BTreeSet<String>,
    stopped: Vec<String>,
    told: Vec<String>,
    changed: Vec<RunState>,
    /// Pieces whose worker cannot be created, and sessions that will not take a brief or stop.
    no_worker: BTreeSet<String>,
    no_brief: BTreeSet<String>,
    no_stop: BTreeSet<String>,
    /// Pieces whose new session cannot be made safe to brief, and how often that was tried.
    no_secure: BTreeSet<String>,
    secured: Vec<String>,
    /// What each worker's session has used so far, in dollars, and how often it was read.
    costs: BTreeMap<String, f64>,
    cost_reads: BTreeMap<String, usize>,
    /// The runs the engine asked to have their waiting retries started, one entry an ask.
    retries: Vec<String>,
    /// What gates 2 to 4 find for a piece; one with no entry passes them with nothing changed.
    checks: BTreeMap<String, Checked>,
    /// The pieces whose gates were run, one entry a run of them.
    checked: Vec<String>,
    /// Left for the test to run (`engine::verify`), as the app runs them: off the read.
    hold_checks: bool,
    /// The verifiers made, as the engine asked for them, and what each was sent.
    verifiers: Vec<Made>,
    prompts: BTreeMap<String, String>,
    verifier_now: BTreeMap<String, VerifierNow>,
    verifier_tokens: BTreeMap<String, verify::Tokens>,
    /// Pieces no verifier can be made for.
    no_verifier: BTreeSet<String>,
    /// The commit a worker's worktree is at now, by its session.
    commits: BTreeMap<String, String>,
    /// The workers whose checked worktree was forgotten: they went back to work.
    resets: Vec<String>,
}

struct Fake {
    world: Mutex<World>,
    settings: Mutex<OrchestratorSettings>,
    repository: bool,
}

impl Fake {
    fn new() -> Self {
        Self { world: Mutex::new(World::default()), settings: Mutex::new(OrchestratorSettings::default()), repository: true }
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }

    /// The worker of `piece` ends its turn with a report.
    fn reports(&self, piece: &str, status: Status, result: &str) {
        let session = self.session_of(piece);
        let mut world = self.world();
        world.running.remove(&session);
        world.now.insert(session, WorkerNow::Reported { status, result: result.into() });
    }

    fn session_of(&self, piece: &str) -> String {
        self.world().made.iter().rev().find(|made| made.piece == piece).unwrap_or_else(|| panic!("no worker was made for {piece}")).session.clone()
    }

    /// What gates 2 to 4 will find for `piece`.
    fn finds(&self, piece: &str, checked: Checked) {
        self.world().checks.insert(piece.into(), checked);
    }

    /// Verifier `number` of `piece` (from 1) ends its turn with `reply`, having used `tokens`.
    fn verifier_replies(&self, piece: &str, number: usize, reply: &str, tokens: u64) {
        let mut world = self.world();
        let session = world.verifiers.iter().filter(|made| made.piece == piece).nth(number - 1).unwrap_or_else(|| panic!("no verifier {number} was made for {piece}")).session.clone();
        world.verifier_now.insert(session.clone(), VerifierNow::Replied(reply.into()));
        world.verifier_tokens.insert(session, verify::Tokens { input: tokens, ..Default::default() });
    }

    fn made(&self) -> Vec<String> {
        self.world().made.iter().map(|made| made.piece.clone()).collect()
    }
}

impl Host for Fake {
    fn lead(&self, session_id: &str) -> Result<Lead, EngineError> {
        if session_id == "nobody" {
            return Err(EngineError::new("lead_not_found", "No session nobody to lead the run.", None));
        }
        Ok(Lead { project_path: "/repo".into(), agent: "claude".into(), model: "fable".into(), repository: self.repository, cwd: "/repo".into() })
    }

    fn worker_agents(&self) -> Vec<String> {
        vec!["claude".into(), "codex".into()]
    }

    fn models(&self) -> Vec<crate::models::Model> {
        super::routing::tests::installed()
    }

    fn worker_cost(&self, worker: &SessionRef) -> Cost {
        let mut world = self.world();
        *world.cost_reads.entry(worker.session_id.clone()).or_default() += 1;
        Cost { usd: world.costs.get(&worker.session_id).copied(), unpriced_models: Vec::new() }
    }

    fn retry_waits(&self, run_id: &str) {
        self.world().retries.push(run_id.to_string());
    }

    fn limits(&self, project_path: &str) -> OrchestratorLimits {
        self.settings.lock().unwrap().for_project(project_path)
    }

    fn create_worker(&self, _run: &Run, piece: &Piece, mode: &str) -> anyhow::Result<Started> {
        let mut world = self.world();
        if world.no_worker.contains(&piece.id) {
            anyhow::bail!("the worktree could not be made");
        }
        let session = format!("w{}-{}", world.made.len() + 1, piece.id);
        world.made.push(Made { piece: piece.id.clone(), agent: piece.agent.clone(), model: piece.model.clone(), effort: piece.effort.clone(), mode: mode.into(), session: session.clone() });
        Ok(Started { session_id: session.clone(), tab_id: format!("{session}-tab"), branch: Some(format!("raccoon/{}", piece.id)) })
    }

    fn secure_worker(&self, worker: &SessionRef, branch: Option<&str>) -> anyhow::Result<()> {
        let mut world = self.world();
        world.secured.push(worker.session_id.clone());
        if world.no_secure.iter().any(|piece| worker.session_id.ends_with(&format!("-{piece}"))) {
            anyhow::bail!("its branch {} could not be left without an upstream", branch.unwrap_or("?"));
        }
        Ok(())
    }

    fn brief_worker(&self, worker: &SessionRef, brief: &str) -> anyhow::Result<()> {
        let mut world = self.world();
        if world.no_brief.contains(&worker.session_id) || world.no_brief.iter().any(|piece| worker.session_id.ends_with(&format!("-{piece}"))) {
            anyhow::bail!("the agent is not signed in");
        }
        world.briefs.insert(worker.session_id.clone(), brief.to_string());
        world.running.insert(worker.session_id.clone());
        world.now.insert(worker.session_id.clone(), WorkerNow::Working);
        Ok(())
    }

    fn worker(&self, worker: &SessionRef) -> WorkerNow {
        self.world().now.get(&worker.session_id).cloned().unwrap_or(WorkerNow::Gone)
    }

    fn stop_worker(&self, worker: &SessionRef) -> anyhow::Result<bool> {
        let mut world = self.world();
        if world.no_stop.contains(&worker.session_id) {
            anyhow::bail!("the agent would not stop");
        }
        let was_running = world.running.remove(&worker.session_id);
        if was_running {
            world.stopped.push(worker.session_id.clone());
        }
        Ok(was_running)
    }

    fn check_waits(&self, run_id: &str) {
        if self.world().hold_checks {
            return;
        }
        // The app runs them on a thread of their own; here they are run at once, so a
        // report read is a result checked.
        engine::verify(self, run_id).unwrap();
    }

    fn check(&self, _run: &Run, piece: &Piece, _worker: &SessionRef) -> Checked {
        let mut world = self.world();
        world.checked.push(piece.id.clone());
        world.checks.get(&piece.id).cloned().unwrap_or_else(|| passing(&[], 0))
    }

    fn create_verifier(&self, _run: &Run, piece: &Piece, worker: &SessionRef, model: &str, effort: Option<&str>, number: u32) -> anyhow::Result<SessionRef> {
        let mut world = self.world();
        if world.no_verifier.contains(&piece.id) {
            anyhow::bail!("the agent is not installed");
        }
        let tab = format!("{}-verifier-{number}", worker.session_id);
        world.verifiers.push(Made { piece: piece.id.clone(), agent: piece.agent.clone(), model: model.into(), effort: effort.map(str::to_owned), mode: super::guard::VERIFIER_MODE.into(), session: tab.clone() });
        Ok(SessionRef { session_id: worker.session_id.clone(), tab_id: Some(tab) })
    }

    fn brief_verifier(&self, verifier: &SessionRef, prompt: &str) -> anyhow::Result<()> {
        let tab = verifier.tab_id.clone().unwrap();
        let mut world = self.world();
        world.prompts.insert(tab.clone(), prompt.to_string());
        world.verifier_now.insert(tab, VerifierNow::Working);
        Ok(())
    }

    fn verifier(&self, verifier: &SessionRef) -> VerifierNow {
        self.world().verifier_now.get(verifier.tab_id.as_deref().unwrap_or_default()).cloned().unwrap_or(VerifierNow::Gone)
    }

    fn check_reset(&self, worker: &SessionRef) {
        self.world().resets.push(worker.session_id.clone());
    }

    fn result_commit(&self, worker: &SessionRef) -> Option<String> {
        self.world().commits.get(&worker.session_id).cloned()
    }

    fn verifier_tokens(&self, verifier: &SessionRef) -> Option<verify::Tokens> {
        self.world().verifier_tokens.get(verifier.tab_id.as_deref().unwrap_or_default()).copied()
    }

    fn tell_lead(&self, _run: &Run, text: &str) {
        self.world().told.push(text.to_string());
    }

    fn changed(&self, run: &Run) {
        self.world().changed.push(run.state);
    }
}

/// Gates 2 to 4 passed on a change of `files` and `lines` changed lines.
fn passing(files: &[&str], lines: u32) -> Checked {
    Checked {
        gates: vec![GateResult::passed(Gate::Scope, "Within what the piece owns."), GateResult::passed(Gate::Branch, "Committed and clean."), GateResult::passed(Gate::Commands, "1 command exited 0.")],
        facts: Facts { files: files.iter().map(|file| file.to_string()).collect(), changed_lines: lines, security_areas: Vec::new(), commands_not_run: false, commit: Some("c0ffee1".into()) },
        diff: files.iter().map(|file| format!("diff --git a/{file} b/{file}\n--- a/{file}\n+++ b/{file}\n@@ -1 +1 @@\n-old\n+new\n")).collect(),
        base: "settings-typed-store".into(),
    }
}

/// Six pieces, as a lead would split a move of settings reads: `map` first,
/// `store` on it, three movers on `store`, and `docs` on the three.
fn plan() -> Plan {
    serde_json::from_value(json!({
        "goal": "Move settings reads to the typed store",
        "budget": {"points": 25},
        "pieces": [
            {"id": "map", "title": "Map every settings read", "doneChecks": [{"type": "command", "run": "the list covers every call"}], "model": "haiku", "kind": "search", "estimate": {"low": 0.05, "high": 0.05}},
            {"id": "store", "title": "Typed store module", "kind": "code", "doneChecks": [{"type": "command", "run": "cargo t store::settings"}], "owns": ["src/store/settings/"], "dependsOn": ["map"], "model": "opus", "effort": "medium", "estimate": {"low": 1.6, "high": 2.4}},
            {"id": "session", "title": "Move session code", "kind": "scoped-code", "doneChecks": [{"type": "command", "run": "cargo t session"}], "owns": ["src/session*.rs"], "dependsOn": ["store"], "model": "sonnet", "effort": "medium"},
            {"id": "pipeline", "title": "Move pipeline code", "kind": "scoped-code", "doneChecks": [{"type": "command", "run": "cargo t issue_pipeline"}], "owns": ["src/issue_pipeline/"], "dependsOn": ["store"], "model": "sonnet", "permissionMode": "acceptEdits"},
            {"id": "cli", "title": "Move CLI code", "kind": "code", "doneChecks": [{"type": "command", "run": "cargo t control"}], "owns": ["src/cli.rs", "src/control.rs"], "dependsOn": ["store"], "agent": "codex", "model": "gpt-terra", "effort": "high"},
            {"id": "docs", "title": "Update the docs", "kind": "scoped-code", "doneChecks": [{"type": "command", "run": "every documented key exists"}], "owns": ["docs/"], "dependsOn": ["session", "pipeline", "cli"], "readsUntrusted": true},
        ],
    }))
    .unwrap()
}

fn states(run: &Run) -> Vec<(&str, PieceState)> {
    run.pieces.iter().map(|piece| (piece.id.as_str(), piece.state)).collect()
}

/// A stored run of `plan()` that asks for no approval, and its host.
fn started_free() -> (Fake, Run) {
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let run = engine::create(&host, &plan(), "lead", Some("lead-tab".into())).unwrap();
    (host, run)
}

#[test]
fn a_valid_plan_is_stored_as_a_run_that_waits_for_approval() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    let run = engine::create(&host, &plan(), "lead", Some("lead-tab".into())).unwrap();
    assert_eq!(run.state, RunState::AwaitingApproval);
    assert_eq!((run.lead.session_id.as_str(), run.lead.tab_id.as_deref(), run.project_path.as_str()), ("lead", Some("lead-tab"), "/repo"));
    assert_eq!((run.goal.as_str(), run.budget.points, run.worker_mode.as_str()), ("Move settings reads to the typed store", Some(25.0), "bypassPermissions"));
    assert_eq!(run.pieces.len(), 6);
    assert!(run.pieces.iter().all(|piece| piece.state == PieceState::Queued && piece.worker.is_none()));
    assert!(run.approval.is_none());
    // Stored, and announced to the window.
    assert_eq!(store::get(&run.id).unwrap(), run);
    assert_eq!(host.world().changed, vec![RunState::AwaitingApproval]);
    // What `runs show` adds: the estimate of the pieces that carry one, and what waits on what.
    let shown = engine::shown(&run);
    let near = |value: &serde_json::Value, expected: f64| (value.as_f64().unwrap() - expected).abs() < 1e-9;
    assert!(near(&shown["estimate"]["low"], 1.65) && near(&shown["estimate"]["high"], 2.45), "{}", shown["estimate"]);
    assert_eq!(shown["unestimated"], 4);
    assert_eq!(shown["ready"], json!([]), "nothing is ready to start before approval");
    assert_eq!(shown["waiting"][0], json!({"piece": "map", "on": []}));
    assert_eq!(shown["waiting"][5], json!({"piece": "docs", "on": ["session", "pipeline", "cli"]}));
}

#[test]
fn a_plan_is_refused_with_the_rule_and_the_piece_and_nothing_is_stored() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    let refused = |change: &dyn Fn(&mut Plan)| {
        let mut plan = plan();
        change(&mut plan);
        engine::create(&host, &plan, "lead", None).expect_err("the plan is refused")
    };
    let error = refused(&|plan| plan.pieces[4].owns.push("src/session_ops.rs".into()));
    assert_eq!((error.code, error.details["piece"].as_str(), error.details["other"].as_str(), error.details["path"].as_str()), ("shared_file", Some("cli"), Some("session"), Some("src/session_ops.rs")));
    let error = refused(&|plan| plan.pieces[1].depends_on.push("docs".into()));
    assert_eq!((error.code, error.details["piece"].as_str()), ("dependency_cycle", Some("store")));
    assert_eq!(error.details["cycle"], json!(["store", "docs", "session", "store"]));
    let error = refused(&|plan| plan.pieces[2].done_checks.clear());
    assert_eq!((error.code, error.details["piece"].as_str()), ("no_done_check", Some("session")));
    assert!(error.recovery.as_deref().unwrap().contains("Nothing was stored"));
    assert!(store::list().unwrap().is_empty());

    // The limit is the setting, app-wide with a project's own on top: changing it changes what is refused.
    host.settings.lock().unwrap().piece_limit = 5;
    let error = engine::create(&host, &plan(), "lead", None).unwrap_err();
    assert_eq!((error.code, &error.details), ("too_many_pieces", &json!({"limit": 5, "pieces": 6})));
    assert!(error.message.contains("6 pieces and the limit is 5"), "{}", error.message);
    host.settings.lock().unwrap().projects.entry("/repo".into()).or_default().piece_limit = Some(6);
    let run = engine::create(&host, &plan(), "lead", None).unwrap();
    assert_eq!(run.pieces.len(), 6);

    // One run at a time for a lead, a lead the app knows, and a repository to cut worktrees from.
    let error = engine::create(&host, &plan(), "lead", None).unwrap_err();
    assert_eq!((error.code, error.details["run"].as_str()), ("run_exists", Some(run.id.as_str())));
    assert_eq!(engine::create(&host, &plan(), "nobody", None).unwrap_err().code, "lead_not_found");
    let plain = Fake { repository: false, ..Fake::new() };
    assert_eq!(engine::create(&plain, &plan(), "other", None).unwrap_err().code, "not_a_repository");
}

#[test]
fn no_worker_starts_until_a_person_approves() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    let run = engine::create(&host, &plan(), "lead", Some("lead-tab".into())).unwrap();
    // The lead may ask as often as it likes.
    for _ in 0..2 {
        let error = engine::start(&host, &run.id).unwrap_err();
        assert_eq!((error.code, error.details["run"].as_str()), ("awaiting_approval", Some(run.id.as_str())));
        assert!(error.recovery.as_deref().unwrap().contains("end your turn"));
    }
    assert!(host.made().is_empty());
    assert_eq!(store::get(&run.id).unwrap().state, RunState::AwaitingApproval);

    let start = engine::approve(&host, &run.id).unwrap();
    assert_eq!(start.started, vec!["map"]);
    assert_eq!((start.run.state, start.run.approval.is_some()), (RunState::Running, true));
    assert_eq!(host.made(), vec!["map"]);
    // The lead's turn ended while it waited: it is told, and told how to go on.
    let told = host.world().told.clone();
    assert_eq!(told.len(), 1);
    assert!(told[0].contains(&format!("approved the plan of run {}", run.id)) && told[0].contains("Workers were started for: map.") && told[0].contains("terminalx wait --children-of lead"), "{}", told[0]);
    assert!(!told[0].contains("changed the plan"));
    // Approval is given once.
    assert_eq!(engine::approve(&host, &run.id).unwrap_err().code, "not_awaiting_approval");
    assert_eq!(host.made(), vec!["map"]);
}

#[test]
fn a_project_that_asks_for_no_approval_starts_at_once() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    host.settings.lock().unwrap().projects.entry("/repo".into()).or_default().require_approval = Some(false);
    let run = engine::create(&host, &plan(), "lead", None).unwrap();
    assert_eq!(run.state, RunState::Planned);
    assert_eq!(engine::shown(&run)["ready"], json!(["map"]));
    let start = engine::start(&host, &run.id).unwrap();
    assert_eq!((start.started, start.run.state, start.run.approval), (vec!["map".to_string()], RunState::Running, None));
    assert!(host.world().told.is_empty(), "the lead started it itself");
}

#[test]
fn start_starts_only_the_pieces_whose_dependencies_are_done() {
    let _home = crate::store::temp_home();
    let (host, run) = started_free();
    let id = run.id.as_str();

    let first = engine::start(&host, id).unwrap();
    assert_eq!(first.started, vec!["map"]);
    assert_eq!(first.waiting.iter().map(|waiting| (waiting.piece.as_str(), waiting.on.join(","))).collect::<Vec<_>>(), vec![("store", "map".to_string()), ("session", "store".into()), ("pipeline", "store".into()), ("cli", "store".into()), ("docs", "session,pipeline,cli".into())]);
    assert_eq!(states(&first.run)[..2], [("map", PieceState::Running), ("store", PieceState::Queued)]);
    // Called again while `map` is still working, it starts nothing.
    let again = engine::start(&host, id).unwrap();
    assert!(again.started.is_empty());
    assert_eq!(host.made(), vec!["map"]);

    // `map` done: `store` starts, and nothing that waits on `store`.
    host.reports("map", Status::Done, "41 call sites in 9 files.");
    let second = engine::start(&host, id).unwrap();
    assert_eq!(second.started, vec!["store"]);
    let map = second.run.piece("map").unwrap();
    assert_eq!((map.state, map.note.as_deref()), (PieceState::Done, Some("41 call sites in 9 files.")));

    // `store` done: the three that depend on it start together, in plan order.
    host.reports("store", Status::Done, "Store added, 14 tests pass.");
    let third = engine::start(&host, id).unwrap();
    assert_eq!(third.started, vec!["session", "pipeline", "cli"]);
    assert_eq!(third.waiting, vec![engine::Waiting { piece: "docs".into(), on: vec!["session".into(), "pipeline".into(), "cli".into()] }]);

    // Two of three done is not enough for `docs`.
    host.reports("session", Status::Done, "17 call sites moved.");
    host.reports("cli", Status::Done, "CLI reads moved.");
    let fourth = engine::start(&host, id).unwrap();
    assert!(fourth.started.is_empty());
    assert_eq!(fourth.waiting, vec![engine::Waiting { piece: "docs".into(), on: vec!["pipeline".into()] }]);
    assert_eq!(fourth.run.state, RunState::Running);

    host.reports("pipeline", Status::Done, "No direct reads remain.");
    let fifth = engine::start(&host, id).unwrap();
    assert_eq!(fifth.started, vec!["docs"]);
    assert_eq!(host.made(), vec!["map", "store", "session", "pipeline", "cli", "docs"], "each piece got one worker");

    // The last piece done: the run is done, and nothing more starts in it.
    host.reports("docs", Status::Done, "Every documented key exists.");
    let done = engine::refreshed(&host, id).unwrap();
    assert_eq!(done.state, RunState::Done);
    assert!(done.pieces.iter().all(|piece| piece.state == PieceState::Done && piece.attempts == 1));
    assert_eq!(engine::start(&host, id).unwrap_err().code, "run_ended");
    assert_eq!(engine::stop(&host, id, By::Cli).unwrap_err().code, "run_ended");
}

#[test]
fn each_worker_gets_its_pieces_agent_model_effort_and_mode_and_a_brief_built_from_it() {
    let _home = crate::store::temp_home();
    let (host, run) = started_free();
    let id = run.id.as_str();
    engine::start(&host, id).unwrap();
    host.reports("map", Status::Done, "41 call sites in 9 files.");
    engine::start(&host, id).unwrap();
    host.reports("store", Status::Done, "Store added.");
    let started = engine::start(&host, id).unwrap();

    let made = host.world().made.clone();
    let of = |piece: &str| made.iter().find(|made| made.piece == piece).unwrap().clone();
    // The plan's model and effort; bypass unless the plan says otherwise.
    assert_eq!(of("map"), Made { piece: "map".into(), agent: "claude".into(), model: "haiku".into(), effort: None, mode: "bypassPermissions".into(), session: "w1-map".into() });
    assert_eq!((of("store").model.as_str(), of("store").effort.as_deref(), of("store").mode.as_str()), ("opus", Some("medium"), "bypassPermissions"));
    assert_eq!((of("pipeline").model.as_str(), of("pipeline").mode.as_str()), ("sonnet", "acceptEdits"), "the plan chose another mode for this piece");
    assert_eq!((of("cli").agent.as_str(), of("cli").model.as_str(), of("cli").effort.as_deref()), ("codex", "gpt-terra", Some("high")));

    // The run records each worker, its branch, and the mode it was started in.
    let cli = started.run.piece("cli").unwrap();
    assert_eq!(cli.worker, Some(SessionRef { session_id: "w5-cli".into(), tab_id: Some("w5-cli-tab".into()) }));
    assert_eq!((cli.branch.as_deref(), cli.started_mode.as_deref(), cli.attempts), (Some("raccoon/cli"), Some("bypassPermissions"), 1));
    assert_eq!(started.run.piece("pipeline").unwrap().started_mode.as_deref(), Some("acceptEdits"));

    // The brief is the piece's, and names what the piece it waited on reported.
    let brief = host.world().briefs["w3-session"].clone();
    for said in ["## Your piece: Move session code", "- src/session*.rs", "cargo t session", "- Do not push.", "The piece \"Typed store module\" (store) is done. Its worker reported: Store added. Its work is on the branch `raccoon/store`"] {
        assert!(brief.contains(said), "{said:?} is missing from:\n{brief}");
    }
}

#[test]
fn the_projects_mode_is_the_default_of_its_workers_and_a_piece_may_choose_within_it() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    {
        let mut settings = host.settings.lock().unwrap();
        settings.require_approval = false;
        settings.projects.entry("/repo".into()).or_default().worker_mode = Some("acceptEdits".into());
    }
    let two = |mode: &str| -> Plan {
        serde_json::from_value(json!({"goal": "Two", "pieces": [
            {"id": "a", "title": "A", "kind": "code", "doneChecks": [{"type": "command", "run": "x"}]},
            {"id": "b", "title": "B", "kind": "code", "doneChecks": [{"type": "command", "run": "x"}], "permissionMode": mode},
        ]}))
        .unwrap()
    };
    // Nobody approves this project's runs, so its lead cannot hand a worker more than the project allows.
    let error = engine::create(&host, &two("bypassPermissions"), "lead", None).unwrap_err();
    assert_eq!((error.code, error.details["piece"].as_str(), error.details["workerMode"].as_str()), ("mode_not_allowed", Some("b"), Some("acceptEdits")));
    assert!(store::list().unwrap().is_empty());
    // A stricter mode is the piece's to choose.
    let run = engine::create(&host, &two("manual"), "lead", None).unwrap();
    assert_eq!(run.worker_mode, "acceptEdits");
    engine::start(&host, &run.id).unwrap();
    let modes: Vec<(String, String)> = host.world().made.iter().map(|made| (made.piece.clone(), made.mode.clone())).collect();
    assert_eq!(modes, vec![("a".to_string(), "acceptEdits".to_string()), ("b".into(), "manual".into())]);

    // Where a person approves the plan, they see the piece's mode and may let it stand.
    host.settings.lock().unwrap().require_approval = true;
    let approved = engine::create(&host, &two("bypassPermissions"), "another-lead", None).unwrap();
    assert_eq!((approved.state, approved.piece("b").unwrap().permission_mode.as_deref()), (RunState::AwaitingApproval, Some("bypassPermissions")));
    engine::approve(&host, &approved.id).unwrap();
    assert_eq!(host.world().made.last().map(|made| (made.piece.as_str(), made.mode.as_str())), Some(("b", "bypassPermissions")));
}

#[test]
fn a_run_survives_a_restart_with_its_piece_states_intact() {
    let home = crate::store::temp_home();
    let (host, run) = started_free();
    let id = run.id.clone();
    engine::start(&host, &id).unwrap();
    host.reports("map", Status::Done, "41 call sites in 9 files.");
    engine::start(&host, &id).unwrap();
    host.reports("store", Status::Blocked, "The migration needs a decision on the old keys.");
    let before = engine::refreshed(&host, &id).unwrap();
    assert_eq!(states(&before)[..3], [("map", PieceState::Done), ("store", PieceState::Blocked), ("session", PieceState::Queued)]);
    assert_eq!(before.piece("store").unwrap().note.as_deref(), Some("Reported blocked: The migration needs a decision on the old keys."));

    // The file is all there is: what a new process reads is what the old one wrote.
    let on_disk = std::fs::read_to_string(crate::store::root().unwrap().join("orchestration-runs.json")).unwrap();
    let file: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
    assert_eq!(file["runs"][0]["id"], id.as_str());
    assert_eq!(file["runs"][0]["state"], "running");
    assert_eq!(file["runs"][0]["pieces"][0]["state"], "done");
    assert_eq!(file["runs"][0]["pieces"][0]["worker"], json!({"sessionId": "w1-map", "tabId": "w1-map-tab"}));
    assert_eq!(file["runs"][0]["pieces"][1]["state"], "blocked");
    assert_eq!(file["runs"][0]["pieces"][2]["state"], "queued");

    // A new process: nothing in memory, the same home. Its agents are not
    // running, and the reports are still in the workers' transcripts.
    let restarted = Fake::new();
    restarted.settings.lock().unwrap().require_approval = false;
    {
        let mut world = restarted.world();
        world.now.insert("w1-map".into(), WorkerNow::Reported { status: Status::Done, result: "41 call sites in 9 files.".into() });
        world.now.insert("w2-store".into(), WorkerNow::Reported { status: Status::Blocked, result: "The migration needs a decision on the old keys.".into() });
    }
    assert_eq!(store::list().unwrap(), vec![before.clone()]);
    assert_eq!(engine::refreshed(&restarted, &id).unwrap(), before);
    assert_eq!(store::for_lead("lead").unwrap().unwrap().id, id);
    assert_eq!(store::for_worker("w2-store").unwrap().map(|(run, piece)| (run.id, piece)), Some((id.clone(), "store".into())));
    // It goes on where it was: the blocked piece's worker finishes, and the next pieces start.
    restarted.world().now.insert("w2-store".into(), WorkerNow::Reported { status: Status::Done, result: "Store added, 14 tests pass.".into() });
    let next = engine::start(&restarted, &id).unwrap();
    assert_eq!(next.started, vec!["session", "pipeline", "cli"]);
    drop(home);
}

#[test]
fn a_piece_follows_what_its_worker_reports() {
    let _home = crate::store::temp_home();
    let (host, run) = started_free();
    let id = run.id.as_str();
    engine::start(&host, id).unwrap();
    let map = || store::get(id).unwrap().piece("map").cloned().unwrap();

    // A turn that ended with a `blocked` report, then one that stopped on a question.
    host.reports("map", Status::Blocked, "The repository has no settings module.");
    engine::worker_turn_ended(&host, "w1-map");
    assert_eq!((map().state, map().note.as_deref()), (PieceState::Blocked, Some("Reported blocked: The repository has no settings module.")));
    host.world().now.insert("w1-map".into(), WorkerNow::Stuck("The tab's turn has stopped on a permission request, a question or an error; `terminalx wait` says which.".into()));
    assert!(engine::refreshed(&host, id).unwrap().piece("map").unwrap().note.as_deref().unwrap().contains("permission request"));
    // The lead sends it more work: it is running again, and keeps its last line until it reports.
    host.world().now.insert("w1-map".into(), WorkerNow::Working);
    engine::worker_turn_ended(&host, "w1-map");
    assert_eq!(map().state, PieceState::Running);
    assert!(map().note.is_some());
    // A session nobody's worker is changes nothing, and a deleted worker blocks its piece.
    engine::worker_turn_ended(&host, "some-other-session");
    host.world().now.remove("w1-map");
    assert_eq!((engine::refreshed(&host, id).unwrap().piece("map").unwrap().state, map().note.as_deref()), (PieceState::Blocked, Some("Its worker session was deleted.")));

    // A `failed` report is not the end of a piece: its next try waits for a fresh worker.
    host.reports("map", Status::Failed, "The search tool crashed.");
    let after = engine::refreshed(&host, id).unwrap();
    assert_eq!((after.state, after.piece("map").unwrap().state, after.piece("map").unwrap().worker.clone()), (RunState::Running, PieceState::Queued, None));
}

/// A run of one `scoped-code` piece on the table's model, started, and a second piece that waits on it.
fn one_piece() -> (Fake, String) {
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Move CLI reads", "pieces": [
        {"id": "cli", "title": "Move CLI code", "kind": "scoped-code", "doneChecks": [{"type": "command", "run": "cargo t control"}], "owns": ["src/cli.rs"]},
        {"id": "docs", "title": "Update the docs", "kind": "scoped-code", "doneChecks": [{"type": "command", "run": "every key is documented"}], "owns": ["docs/"], "dependsOn": ["cli"]},
    ]}))
    .unwrap();
    let run = engine::create(&host, &plan, "lead", Some("lead-tab".into())).unwrap();
    engine::start(&host, &run.id).unwrap();
    (host, run.id)
}

fn one_piece_for(lead: &str) -> (Fake, String) {
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Move CLI reads", "pieces": [{"id": "cli", "title": "Move CLI code", "kind": "scoped-code", "doneChecks": [{"type": "command", "run": "cargo t control"}], "owns": ["src/cli.rs"]}]})).unwrap();
    let run = engine::create(&host, &plan, lead, None).unwrap();
    engine::start(&host, &run.id).unwrap();
    (host, run.id)
}

/// What each try of a piece ran on and came to.
fn tried(run: &Run, piece: &str) -> Vec<(Step, String, Option<String>, Option<Outcome>)> {
    run.piece(piece).unwrap().tries.iter().map(|attempt| (attempt.step, attempt.model.clone(), attempt.effort.clone(), attempt.outcome)).collect()
}

#[test]
fn a_plan_with_kinds_and_no_models_starts_each_worker_on_the_tables_model_and_effort() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Kinds only", "pieces": [
        {"id": "map", "title": "Map", "kind": "search", "doneChecks": [{"type": "command", "run": "x"}]},
        {"id": "build", "title": "Build", "kind": "code", "doneChecks": [{"type": "command", "run": "x"}], "owns": ["src/"]},
        {"id": "port", "title": "Port", "kind": "code", "agent": "codex", "doneChecks": [{"type": "command", "run": "x"}], "owns": ["lib/"]},
        {"id": "study", "title": "Study", "kind": "research", "agent": "codex", "doneChecks": [{"type": "command", "run": "x"}]},
    ]}))
    .unwrap();
    let run = engine::create(&host, &plan, "lead", None).unwrap();
    assert_eq!(
        run.pieces.iter().map(|piece| (piece.id.as_str(), piece.model.as_str(), piece.effort.as_deref(), piece.tier)).collect::<Vec<_>>(),
        vec![("map", "haiku", None, Some(Tier::Small)), ("build", "opus", Some("medium"), Some(Tier::Large)), ("port", "gpt-6.1-sol", Some("medium"), Some(Tier::Large)), ("study", "gpt-6-astra", Some("medium"), Some(Tier::Top))]
    );
    engine::start(&host, &run.id).unwrap();
    let made: Vec<(String, String, String, Option<String>)> = host.world().made.iter().map(|made| (made.piece.clone(), made.agent.clone(), made.model.clone(), made.effort.clone())).collect();
    assert_eq!(made, vec![
        ("map".to_string(), "claude".to_string(), "haiku".to_string(), None),
        ("build".into(), "claude".into(), "opus".into(), Some("medium".into())),
        ("port".into(), "codex".into(), "gpt-6.1-sol".into(), Some("medium".into())),
        ("study".into(), "codex".into(), "gpt-6-astra".into(), Some("medium".into())),
    ]);
    // The project's own row decides for its runs.
    host.settings.lock().unwrap().projects.entry("/repo".into()).or_default().routing = serde_json::from_value(json!({"code": {"claude": {"tier": "mid", "effort": "high"}}})).unwrap();
    let again = engine::create(&host, &plan, "another-lead", None).unwrap();
    assert_eq!((again.piece("build").unwrap().model.as_str(), again.piece("build").unwrap().effort.as_deref()), ("sonnet", Some("high")));
    assert_eq!(again.piece("port").unwrap().model, "gpt-6.1-sol", "the Codex column is its own");
}

#[test]
fn a_failing_piece_follows_the_ladder_and_is_blocked_after_three_tries() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    let cli = || store::get(id).unwrap().piece("cli").cloned().unwrap();
    assert_eq!(tried(&store::get(id).unwrap(), "cli"), vec![(Step::First, "sonnet".to_string(), Some("medium".to_string()), None)]);

    // Try 1 reports `failed`: the piece is queued again, on more effort, with no worker.
    host.reports("cli", Status::Failed, "2 tests in control::tests fail.");
    assert_eq!(engine::worker_turn_ended(&host, "w1-cli").as_deref(), Some(id), "a retry waits to be started");
    let piece = cli();
    assert_eq!((piece.state, piece.worker.clone(), piece.branch.clone(), piece.model.as_str(), piece.effort.as_deref()), (PieceState::Queued, None, None, "sonnet", Some("high")));
    assert_eq!(piece.note.as_deref(), Some("Try 1 fell short on sonnet at medium. Try 2 runs on sonnet at high (tried again with the failure text, effort raised one level)."));
    // The try that fell short keeps its worker, its branch and what it said.
    assert_eq!((piece.tries[0].outcome, piece.tries[0].worker.as_ref().map(|worker| worker.session_id.as_str()), piece.tries[0].branch.as_deref()), (Some(Outcome::Failed), Some("w1-cli"), Some("raccoon/cli")));
    assert_eq!(piece.tries[0].detail.as_deref(), Some("The worker reported failed: 2 tests in control::tests fail."));
    assert!(piece.tries[0].ended.is_some() && piece.tries[1].started.is_none());

    // The next try is a fresh worker, started without the lead, with the failure text in its brief.
    let started = engine::start_retries(&host, id).unwrap();
    assert_eq!(started.started, vec!["cli"]);
    let second = host.world().made.last().cloned().unwrap();
    assert_eq!((second.session.as_str(), second.model.as_str(), second.effort.as_deref()), ("w2-cli", "sonnet", Some("high")));
    let brief = host.world().briefs["w2-cli"].clone();
    assert!(brief.contains("You are try 2 of this piece") && brief.contains("> The worker reported failed: 2 tests in control::tests fail.") && brief.contains("try 1: `raccoon/cli`"), "{brief}");
    assert_eq!((cli().state, cli().attempts), (PieceState::Running, 2));
    // The worker that fell short is no longer the piece's: a late turn of it changes nothing.
    assert_eq!(store::for_worker("w1-cli").unwrap().map(|(_, piece)| piece), None);
    assert_eq!(engine::worker_turn_ended(&host, "w1-cli"), None);

    // Try 2 reports `partial`: one model tier up, at one effort level lower.
    host.reports("cli", Status::Partial, "1 test still fails.");
    assert_eq!(engine::worker_turn_ended(&host, "w2-cli").as_deref(), Some(id));
    assert_eq!((cli().state, cli().model.as_str(), cli().effort.as_deref(), cli().tier), (PieceState::Queued, "opus", Some("medium"), Some(Tier::Large)));
    engine::start_retries(&host, id).unwrap();
    let third = host.world().made.last().cloned().unwrap();
    assert_eq!((third.session.as_str(), third.model.as_str(), third.effort.as_deref()), ("w3-cli", "opus", Some("medium")));
    let brief = host.world().briefs["w3-cli"].clone();
    assert!(brief.contains("You are try 3 of this piece") && brief.contains("> The worker reported partial: 1 test still fails.") && !brief.contains("2 tests in control::tests fail"), "{brief}");

    // Try 3 fails: the piece is blocked and goes back to the lead with what was tried. No fourth worker.
    host.reports("cli", Status::Failed, "The same test fails.");
    assert_eq!(engine::worker_turn_ended(&host, "w3-cli"), None, "nothing waits to be started");
    let run = store::get(id).unwrap();
    assert_eq!(tried(&run, "cli"), vec![
        (Step::First, "sonnet".to_string(), Some("medium".to_string()), Some(Outcome::Failed)),
        (Step::Effort, "sonnet".into(), Some("high".into()), Some(Outcome::Partial)),
        (Step::Tier, "opus".into(), Some("medium".into()), Some(Outcome::Failed)),
    ]);
    let piece = run.piece("cli").unwrap();
    assert_eq!((piece.state, piece.attempts, piece.gave_up()), (PieceState::Blocked, 3, true));
    assert_eq!(piece.note.as_deref(), Some("Blocked after 3 tries: sonnet at medium, then sonnet at high, then opus at medium. It used all 3 tries. Last failure: The worker reported failed: The same test fails."));
    // Nothing else can run: the run says which piece holds it up.
    assert_eq!((run.state, run.reason.as_deref()), (RunState::Failed, Some("cli is blocked after 3 tries. docs cannot start without it.")));
    assert!(engine::start_retries(&host, id).unwrap().started.is_empty());
    assert_eq!(engine::start(&host, id).unwrap_err().code, "run_ended");
    // Read again and again, it stays as it is.
    assert_eq!(engine::refreshed(&host, id).unwrap(), run);
    assert_eq!(host.made(), vec!["cli", "cli", "cli"]);
    assert_eq!(engine::shown(&run)["maxTries"], 3);

    // The lead may still get its last worker to finish: the piece is done, and the run goes on.
    host.reports("cli", Status::Done, "All of control::tests pass.");
    let back = engine::start(&host, id).unwrap();
    assert_eq!((back.run.state, back.run.reason.clone(), back.started), (RunState::Running, None, vec!["docs".to_string()]));
    assert_eq!(back.run.piece("cli").unwrap().tries[2].outcome, Some(Outcome::Done));
}

#[test]
fn the_next_try_is_asked_for_by_whichever_read_takes_the_ladders_step_and_only_once() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    // The worker's turn ends with `failed`, and the Run view reads the run before the turn-end hook does.
    host.reports("cli", Status::Failed, "2 tests fail.");
    let shown = engine::refreshed(&host, id).unwrap();
    assert!(shown.piece("cli").unwrap().retry_waits());
    assert_eq!(host.world().retries, vec![id.to_string()], "the read that climbed asks for the retry");
    // The hook comes second: the piece's worker is no longer its worker, and nothing more is asked.
    assert_eq!(engine::worker_turn_ended(&host, "w1-cli"), None);
    engine::refreshed(&host, id).unwrap();
    assert_eq!(host.world().retries.len(), 1, "nobody is asked twice for the same step");
    // What the host does with the ask: a fresh worker, without the lead.
    assert_eq!(engine::start_retries(&host, id).unwrap().started, vec!["cli"]);
    assert_eq!(host.world().made.last().map(|made| (made.session.clone(), made.effort.clone())), Some(("w2-cli".to_string(), Some("high".to_string()))));

    // The other order: the hook is the read that climbs, and it asks.
    host.reports("cli", Status::Partial, "1 test fails.");
    assert_eq!(engine::worker_turn_ended(&host, "w2-cli").as_deref(), Some(id));
    assert_eq!(host.world().retries.len(), 2);
    engine::start_retries(&host, id).unwrap();
    // The last try falls short: the piece is blocked, and there is no retry to ask for.
    host.reports("cli", Status::Failed, "The same test fails.");
    engine::refreshed(&host, id).unwrap();
    assert_eq!(host.world().retries.len(), 2);
    // A failed done-check starts its retry itself, under the lock it already holds: nothing is left for anyone to start.
    let (other, other_id) = one_piece_for("other-lead");
    other.reports("cli", Status::Done, "Done.");
    engine::worker_turn_ended(&other, "w1-cli");
    assert!(engine::check_failed(&other, &other_id, "cli", "exit 101").unwrap().retried);
    assert!(engine::start_retries(&other, &other_id).unwrap().started.is_empty());
}

#[test]
fn a_blocked_report_or_a_silent_worker_is_not_tried_again() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    // What a worker needs from a person, another model cannot give.
    host.reports("cli", Status::Blocked, "Which of the two config files is the source of truth?");
    assert_eq!(engine::worker_turn_ended(&host, "w1-cli"), None);
    let piece = store::get(&id).unwrap().piece("cli").cloned().unwrap();
    assert_eq!((piece.state, piece.tries.len(), piece.tries[0].outcome, piece.gave_up()), (PieceState::Blocked, 1, Some(Outcome::Blocked), false));
    assert!(piece.worker.is_some());
    host.world().now.insert("w1-cli".into(), WorkerNow::Stuck("It stopped on a permission request.".into()));
    assert_eq!(engine::worker_turn_ended(&host, "w1-cli"), None);
    assert_eq!(store::get(&id).unwrap().piece("cli").unwrap().tries.len(), 1);
    // The run waits on the lead; it has not failed.
    assert_eq!(store::get(&id).unwrap().state, RunState::Running);
}

#[test]
fn a_failed_done_check_takes_the_same_ladder_with_the_checks_output() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    // Only a piece whose worker said `done` has a check to fail.
    let error = engine::check_failed(&host, id, "cli", "exit 101").unwrap_err();
    assert_eq!((error.code, error.details["state"].as_str()), ("piece_not_done", Some("running")));
    assert_eq!(engine::check_failed(&host, id, "docs", "exit 101").unwrap_err().code, "piece_not_done");
    assert_eq!(engine::check_failed(&host, id, "ghost", "exit 101").unwrap_err().code, "piece_not_found");

    host.reports("cli", Status::Done, "CLI reads moved.");
    engine::worker_turn_ended(&host, "w1-cli");
    assert_eq!(store::get(id).unwrap().piece("cli").unwrap().state, PieceState::Done);
    let output = "test control::tests::create_reads_default_mode ... FAILED\nleft: Some(\"manual\")  right: Some(\"auto\")";
    let failed = engine::check_failed(&host, id, "cli", output).unwrap();
    // The next try is started at once: nobody has to ask.
    assert_eq!((failed.retried, failed.blocked, failed.piece.as_str()), (true, false, "cli"));
    assert_eq!(tried(&failed.run, "cli"), vec![(Step::First, "sonnet".to_string(), Some("medium".to_string()), Some(Outcome::CheckFailed)), (Step::Effort, "sonnet".into(), Some("high".into()), None)]);
    let brief = host.world().briefs["w2-cli"].clone();
    assert!(brief.contains("> The done-check did not hold: cargo t control") && brief.contains("> test control::tests::create_reads_default_mode ... FAILED"), "{brief}");

    // Twice more, and the piece is blocked: its worker's `done` does not stand over the check.
    host.reports("cli", Status::Done, "Fixed.");
    engine::worker_turn_ended(&host, "w2-cli");
    assert!(engine::check_failed(&host, id, "cli", output).unwrap().retried);
    host.reports("cli", Status::Done, "Fixed again.");
    engine::worker_turn_ended(&host, "w3-cli");
    let last = engine::check_failed(&host, id, "cli", output).unwrap();
    assert_eq!((last.retried, last.blocked), (false, true));
    let piece = last.run.piece("cli").unwrap();
    assert_eq!((piece.state, piece.tries.len(), piece.tries[2].outcome), (PieceState::Blocked, 3, Some(Outcome::CheckFailed)));
    assert!(piece.note.as_deref().unwrap().starts_with("Blocked after 3 tries: sonnet at medium, then sonnet at high, then opus at medium. It used all 3 tries. Last failure: The done-check did not hold: cargo t control"), "{:?}", piece.note);
    let again = engine::refreshed(&host, id).unwrap();
    assert_eq!(again.piece("cli").unwrap().state, PieceState::Blocked, "the worker still says done; the check said otherwise");
    assert_eq!(engine::check_failed(&host, id, "cli", output).unwrap_err().code, "piece_not_done");
    assert_eq!(host.made(), vec!["cli", "cli", "cli"]);

    // A long output keeps its end: that is where a test run says what failed.
    let (host, id) = one_piece_for("other-lead");
    host.reports("cli", Status::Done, "Done.");
    engine::worker_turn_ended(&host, "w1-cli");
    let long = format!("{}\nFAILED at the very end", "noise ".repeat(4000));
    let failed = engine::check_failed(&host, &id, "cli", &long).unwrap();
    let detail = failed.run.piece("cli").unwrap().tries[0].detail.clone().unwrap();
    assert!(detail.len() < 6200 && detail.ends_with("FAILED at the very end") && detail.contains("[…the start was left out]"), "{} bytes", detail.len());
}

#[test]
fn a_piece_with_no_tier_above_it_is_blocked_after_two_tries() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Reshape", "pieces": [{"id": "shape", "title": "Reshape the store", "kind": "refactor", "doneChecks": [{"type": "command", "run": "cargo t"}]}]})).unwrap();
    let run = engine::create(&host, &plan, "lead", None).unwrap();
    engine::start(&host, &run.id).unwrap();
    host.reports("shape", Status::Failed, "It does not compile.");
    engine::worker_turn_ended(&host, "w1-shape");
    engine::start_retries(&host, &run.id).unwrap();
    host.reports("shape", Status::Failed, "It still does not compile.");
    assert_eq!(engine::worker_turn_ended(&host, "w2-shape"), None);
    let after = store::get(&run.id).unwrap();
    assert_eq!(tried(&after, "shape"), vec![(Step::First, "fable".to_string(), Some("medium".to_string()), Some(Outcome::Failed)), (Step::Effort, "fable".into(), Some("high".into()), Some(Outcome::Failed))]);
    assert_eq!(after.piece("shape").unwrap().note.as_deref(), Some("Blocked after 2 tries: fable at medium, then fable at high. It already ran on the top tier: there is no model above it. Last failure: The worker reported failed: It still does not compile."));
    assert_eq!((after.state, after.reason.as_deref()), (RunState::Failed, Some("shape is blocked after 2 tries.")));
}

#[test]
fn each_try_records_its_model_effort_cost_and_outcome() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    // While a try runs, its cost is what its session has used so far.
    host.world().costs.insert("w1-cli".into(), 0.21);
    assert_eq!(engine::refreshed(&host, id).unwrap().piece("cli").unwrap().tries[0].cost_usd, Some(0.21));
    host.world().costs.insert("w1-cli".into(), 0.61);
    host.reports("cli", Status::Failed, "2 tests fail.");
    engine::worker_turn_ended(&host, "w1-cli");
    engine::start_retries(&host, id).unwrap();
    host.world().costs.insert("w2-cli".into(), 0.92);
    host.reports("cli", Status::Partial, "1 test fails.");
    engine::worker_turn_ended(&host, "w2-cli");
    engine::start_retries(&host, id).unwrap();
    host.world().costs.insert("w3-cli".into(), 2.18);
    host.reports("cli", Status::Done, "All tests pass.");
    engine::worker_turn_ended(&host, "w3-cli");

    let run = store::get(id).unwrap();
    /// A try as the Run view lists it: why it was made, what it ran on, what it cost, how it ended.
    type Listed<'a> = (Step, &'a str, Option<&'a str>, Option<f64>, Option<Outcome>);
    let history: Vec<Listed> = run.piece("cli").unwrap().tries.iter().map(|attempt| (attempt.step, attempt.model.as_str(), attempt.effort.as_deref(), attempt.cost_usd, attempt.outcome)).collect();
    assert_eq!(history, vec![
        (Step::First, "sonnet", Some("medium"), Some(0.61), Some(Outcome::Failed)),
        (Step::Effort, "sonnet", Some("high"), Some(0.92), Some(Outcome::Partial)),
        (Step::Tier, "opus", Some("medium"), Some(2.18), Some(Outcome::Done)),
    ]);
    assert!(run.piece("cli").unwrap().tries.iter().all(|attempt| attempt.started.is_some() && attempt.ended.is_some() && attempt.worker.is_some()));
    assert_eq!(run.piece("cli").unwrap().tries[2].detail.as_deref(), Some("All tests pass."));
    // `runs show` sums them, for the piece and for the run.
    let shown = engine::shown(&run);
    let near = |value: &serde_json::Value, expected: f64| (value.as_f64().unwrap() - expected).abs() < 1e-9;
    assert!(near(&shown["pieces"][0]["costUsd"], 3.71) && near(&shown["costUsd"], 3.71), "{}", shown["costUsd"]);
    assert_eq!((shown["pieces"][1]["costUsd"].clone(), shown["pieces"][0]["tries"][1]["step"].clone()), (json!(null), json!("effort")));
    // A try that has ended is not read again: its cost is what it was when it ended.
    let reads = host.world().cost_reads["w1-cli"];
    host.world().costs.insert("w1-cli".into(), 9.99);
    engine::refreshed(&host, id).unwrap();
    engine::start(&host, id).unwrap();
    assert_eq!(host.world().cost_reads["w1-cli"], reads);
    assert_eq!(store::get(id).unwrap().piece("cli").unwrap().tries[0].cost_usd, Some(0.61));
}

#[test]
fn stopping_a_run_ends_the_try_under_way() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    host.reports("cli", Status::Failed, "2 tests fail.");
    engine::worker_turn_ended(&host, "w1-cli");
    // The second try was planned and never started.
    let stopped = engine::stop(&host, &id, By::Cli).unwrap();
    assert_eq!(tried(&stopped.run, "cli").iter().map(|(_, _, _, outcome)| *outcome).collect::<Vec<_>>(), vec![Some(Outcome::Failed), Some(Outcome::Stopped)]);
    assert!(engine::start_retries(&host, &id).unwrap().started.is_empty(), "nothing starts in a stopped run");
    assert_eq!(host.made(), vec!["cli"]);
}

#[test]
fn a_worker_that_cannot_be_started_fails_its_piece_and_the_next_start_tries_again() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Three", "pieces": [
        {"id": "a", "title": "A", "kind": "code", "doneChecks": [{"type": "command", "run": "x"}]},
        {"id": "b", "title": "B", "kind": "code", "doneChecks": [{"type": "command", "run": "x"}]},
        {"id": "c", "title": "C", "kind": "code", "doneChecks": [{"type": "command", "run": "x"}]},
    ]}))
    .unwrap();
    let run = engine::create(&host, &plan, "lead", None).unwrap();
    host.world().no_worker.insert("a".into());
    host.world().no_brief.insert("b".into());
    let start = engine::start(&host, &run.id).unwrap();
    // One piece that cannot start does not keep the others from starting.
    assert_eq!(start.started, vec!["c"]);
    assert_eq!(start.failed, vec![engine::NotStarted { piece: "a".into(), error: "the worktree could not be made".into() }, engine::NotStarted { piece: "b".into(), error: "the agent is not signed in".into() }]);
    let (a, b) = (start.run.piece("a").unwrap(), start.run.piece("b").unwrap());
    assert_eq!((a.state, a.worker.is_none(), a.attempts), (PieceState::Failed, true, 0));
    assert_eq!(a.note.as_deref(), Some("Its worker could not be started: the worktree could not be made"));
    // `b` has a session that never took its brief: the lead sends it, or the person looks.
    assert_eq!((b.state, b.worker.is_some(), b.attempts), (PieceState::Blocked, true, 1));
    assert_eq!(start.run.state, RunState::Running);

    // The cause gone, `runs start` starts `a`; `b` keeps the session it has.
    host.world().no_worker.clear();
    let again = engine::start(&host, &run.id).unwrap();
    assert_eq!(again.started, vec!["a"]);
    assert_eq!(host.made(), vec!["b", "c", "a"]);
}

#[test]
fn a_session_that_cannot_be_made_safe_is_kept_and_tried_again_never_made_twice() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Two", "pieces": [
        {"id": "a", "title": "A", "kind": "code", "doneChecks": [{"type": "command", "run": "x"}]},
        {"id": "b", "title": "B", "kind": "code", "doneChecks": [{"type": "command", "run": "x"}]},
    ]}))
    .unwrap();
    let run = engine::create(&host, &plan, "lead", None).unwrap();
    host.world().no_secure.insert("a".into());
    let start = engine::start(&host, &run.id).unwrap();
    assert_eq!(start.started, vec!["b"]);
    assert_eq!(start.failed, vec![engine::NotStarted { piece: "a".into(), error: "its branch raccoon/a could not be left without an upstream".into() }]);
    // The session exists and the run knows it: it was not briefed, and the piece says why.
    let a = start.run.piece("a").unwrap().clone();
    assert_eq!((a.state, a.worker.as_ref().map(|worker| worker.session_id.as_str()), a.attempts), (PieceState::Blocked, Some("w1-a"), 1));
    assert_eq!(a.held.as_deref(), Some("its branch raccoon/a could not be left without an upstream"));
    assert_eq!(a.note.as_deref(), Some("Its worker has a session but was not briefed: its branch raccoon/a could not be left without an upstream"));
    assert!(!host.world().briefs.contains_key("w1-a"));
    // Reading the run does not make something else of it, and it is found as that run's worker.
    assert_eq!(engine::refreshed(&host, &run.id).unwrap().piece("a"), Some(&a));
    assert_eq!(store::for_worker("w1-a").unwrap().unwrap().1, "a");

    // Each later start tries the same session again: no second session, no second worktree.
    let again = engine::start(&host, &run.id).unwrap();
    assert_eq!((again.started.len(), again.failed.len()), (0, 1));
    assert_eq!(host.made(), vec!["a", "b"]);
    host.world().no_secure.clear();
    let third = engine::start(&host, &run.id).unwrap();
    assert_eq!(third.started, vec!["a"]);
    assert_eq!(host.made(), vec!["a", "b"], "the piece kept the one session it had");
    let a = third.run.piece("a").unwrap();
    assert_eq!((a.state, a.held.clone(), a.note.clone(), a.attempts), (PieceState::Running, None, None, 1));
    assert!(host.world().briefs.contains_key("w1-a"));
    assert_eq!(host.world().secured.iter().filter(|session| *session == "w1-a").count(), 3);
}

#[test]
fn what_a_worker_reported_stands_when_its_session_is_deleted_afterwards() {
    let _home = crate::store::temp_home();
    let (host, run) = started_free();
    let id = run.id.as_str();
    engine::start(&host, id).unwrap();
    host.reports("map", Status::Done, "41 call sites in 9 files.");
    engine::start(&host, id).unwrap();
    // The person tidies the finished worker's session away while the run goes on.
    host.world().now.remove("w1-map");
    let after = engine::refreshed(&host, id).unwrap();
    let map = after.piece("map").unwrap();
    assert_eq!((map.state, map.note.as_deref()), (PieceState::Done, Some("41 call sites in 9 files.")));
    // What waited on it still starts.
    host.reports("store", Status::Done, "Store added.");
    assert_eq!(engine::start(&host, id).unwrap().started, vec!["session", "pipeline", "cli"]);
    // A worker deleted before it finished is another matter: its piece is blocked.
    host.world().now.remove("w3-session");
    assert_eq!(engine::refreshed(&host, id).unwrap().piece("session").unwrap().state, PieceState::Blocked);
}

#[test]
fn stop_stops_every_running_worker_and_marks_the_run_stopped() {
    let _home = crate::store::temp_home();
    let (host, run) = started_free();
    let id = run.id.as_str();
    engine::start(&host, id).unwrap();
    host.reports("map", Status::Done, "41 call sites.");
    engine::start(&host, id).unwrap();
    host.reports("store", Status::Done, "Store added.");
    engine::start(&host, id).unwrap();
    host.reports("session", Status::Done, "Moved.");
    // `pipeline` and `cli` are working; `cli` will not stop.
    host.world().no_stop.insert("w5-cli".into());

    let stop = engine::stop(&host, id, By::Cli).unwrap();
    assert_eq!(stop.stopped, vec!["pipeline"]);
    assert_eq!(stop.failed, vec![engine::NotStarted { piece: "cli".into(), error: "the agent would not stop".into() }]);
    assert_eq!(host.world().stopped, vec!["w4-pipeline"], "only a worker that was running is stopped");
    assert_eq!((stop.run.state, stop.run.reason.as_deref()), (RunState::Stopped, Some("Stopped with `terminalx runs stop`.")));
    // What was done stays done; everything else, started or not, is stopped.
    assert_eq!(states(&stop.run), vec![("map", PieceState::Done), ("store", PieceState::Done), ("session", PieceState::Done), ("pipeline", PieceState::Stopped), ("cli", PieceState::Stopped), ("docs", PieceState::Stopped)]);
    assert_eq!(store::get(id).unwrap(), stop.run);
    assert!(host.world().told.is_empty(), "the lead stopped it itself");

    // Nothing starts in a stopped run, a late report does not revive a piece, and stopping again is harmless.
    assert_eq!(engine::start(&host, id).unwrap_err().code, "run_ended");
    host.reports("pipeline", Status::Done, "Finished after all.");
    engine::worker_turn_ended(&host, "w4-pipeline");
    assert_eq!(store::get(id).unwrap(), stop.run);
    host.world().no_stop.clear();
    let again = engine::stop(&host, id, By::Cli).unwrap();
    assert_eq!((again.run.state, again.stopped), (RunState::Stopped, vec!["cli".to_string()]));
    // The lead may plan again once its run has ended.
    assert!(store::open_for_lead("lead").unwrap().is_none());
    engine::create(&host, &plan(), "lead", None).unwrap();
}

#[test]
fn a_person_may_change_the_plan_before_approving_or_discard_it() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    let run = engine::create(&host, &plan(), "lead", None).unwrap();

    // Edit: one piece fewer, another model. It passes the same rules as the first plan.
    let mut edited = plan();
    edited.pieces.pop();
    edited.pieces[1].model = "sonnet".into();
    let after = engine::update_plan(&host, &run.id, &edited).unwrap();
    assert_eq!((after.pieces.len(), after.piece("store").unwrap().model.as_str(), after.plan_edited, after.state), (5, "sonnet", true, RunState::AwaitingApproval));
    let mut broken = plan();
    broken.pieces[0].done_checks.clear();
    let error = engine::update_plan(&host, &run.id, &broken).unwrap_err();
    assert_eq!((error.code, error.details["piece"].as_str()), ("no_done_check", Some("map")));
    assert_eq!(store::get(&run.id).unwrap(), after, "a refused edit changes nothing");

    engine::approve(&host, &run.id).unwrap();
    assert!(host.world().told[0].contains("They changed the plan first"), "{}", host.world().told[0]);
    assert_eq!(engine::update_plan(&host, &run.id, &edited).unwrap_err().code, "run_started");

    // A person stopping a running run tells the lead; so does discarding a plan.
    let stopped = engine::stop(&host, &run.id, By::Person).unwrap();
    assert_eq!((stopped.run.reason.as_deref(), stopped.stopped), (Some("A person stopped the run."), vec!["map".to_string()]));
    assert!(host.world().told[1].contains("The person stopped run"));
    let second = engine::create(&host, &plan(), "lead", None).unwrap();
    let discarded = engine::stop(&host, &second.id, By::Person).unwrap();
    assert_eq!((discarded.run.state, discarded.run.reason.as_deref()), (RunState::Stopped, Some("A person discarded the plan.")));
    assert!(discarded.run.pieces.iter().all(|piece| piece.state == PieceState::Stopped));
    assert!(host.world().told[2].contains("discarded the plan") && host.world().told[2].contains("No worker was started"));
    assert_eq!(host.made(), vec!["map"], "the discarded plan started nothing");
}

#[test]
fn runs_are_found_by_id_prefix_lead_and_worker() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let first = engine::create(&host, &plan(), "lead", None).unwrap();
    let second = engine::create(&host, &plan(), "another-lead", None).unwrap();
    assert_eq!(store::matching(&first.id).unwrap(), vec![first.clone()]);
    assert_eq!(store::matching(&first.id[..first.id.len() - 1]).unwrap().len(), 1);
    assert!(store::matching("zzz").unwrap().is_empty());
    assert_eq!(store::for_lead("another-lead").unwrap().unwrap().id, second.id);
    assert!(store::for_lead("w1-map").unwrap().is_none());
    assert!(store::for_worker("w1-map").unwrap().is_none());
    engine::start(&host, &first.id).unwrap();
    assert_eq!(store::for_worker("w1-map").unwrap().unwrap().1, "map");
    assert_eq!(engine::start(&host, "no-such-run").unwrap_err().code, "not_found");
}

// ---- checking a result before it is accepted (PRO-278) ----------------------

/// A started run of `pieces` that asks for no approval, led by `lead`.
fn run_of(lead: &str, pieces: serde_json::Value) -> (Fake, String) {
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Move CLI reads", "pieces": pieces})).unwrap();
    let run = engine::create(&host, &plan, lead, Some("lead-tab".into())).unwrap();
    engine::start(&host, &run.id).unwrap();
    (host, run.id)
}

/// The gates of a piece's try, as (gate, passed), and how its check ended.
fn gates_of(run: &Run, piece: &str, attempt: usize) -> (Vec<(Gate, bool)>, Option<verify::Outcome>) {
    let check = run.piece(piece).unwrap().tries[attempt].verification.as_ref().unwrap_or_else(|| panic!("try {} of {piece} has no check", attempt + 1));
    (check.gates.iter().map(|gate| (gate.gate, gate.passed)).collect(), check.outcome)
}

fn verdict_block(json: &str) -> String {
    format!("Read it.\n\n```terminalx-verdict\n{json}\n```\n")
}

const PASS: &str = r#"{"verdict": "pass", "evidence": []}"#;

#[test]
fn a_done_report_is_a_claim_until_its_result_passes_the_gates_and_then_it_is_accepted_with_no_verifier() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    // As the app runs them: the gates are not run by the read that finds the report.
    host.world().hold_checks = true;
    host.reports("cli", Status::Done, "17 reads moved.");
    let read = engine::refreshed(&host, id).unwrap();
    let piece = read.piece("cli").unwrap();
    assert_eq!((piece.state, piece.tries[0].outcome, piece.note.as_deref()), (PieceState::Verifying, Some(Outcome::Done), Some("17 reads moved.")));
    // Gate 1 is the report the read just parsed.
    assert_eq!(gates_of(&read, "cli", 0), (vec![(Gate::Report, true)], None));
    assert!(piece.check_waits());
    // Not done yet: what waits on it does not start, and the run is not done.
    assert_eq!(read.state, RunState::Running);
    let start = engine::start(&host, id).unwrap();
    assert!(start.started.is_empty());
    assert_eq!(start.waiting, vec![engine::Waiting { piece: "docs".into(), on: vec!["cli".into()] }]);
    assert_eq!(engine::check_failed(&host, id, "cli", "exit 1").unwrap_err().code, "piece_not_done");
    assert!(host.world().checked.is_empty());

    // The gates: a command check that passes, a small diff, no security area, not a refactor.
    host.finds("cli", passing(&["src/cli.rs"], 38));
    let checked = engine::verify(&host, id).unwrap();
    let piece = checked.piece("cli").unwrap();
    assert_eq!(piece.state, PieceState::Done);
    assert_eq!(gates_of(&checked, "cli", 0), (vec![(Gate::Report, true), (Gate::Scope, true), (Gate::Branch, true), (Gate::Commands, true)], Some(verify::Outcome::Passed)));
    let check = piece.tries[0].verification.as_ref().unwrap();
    assert_eq!(check.facts.as_ref().map(|facts| (facts.files.clone(), facts.changed_lines, facts.commit.as_deref())), Some((vec!["src/cli.rs".to_string()], 38, Some("c0ffee1"))));
    assert!(check.review.is_none() && check.ended.is_some());
    // Accepted with no model: no verifier session was made, and nothing was sent to one.
    {
        let world = host.world();
        assert_eq!(world.checked, vec!["cli"]);
        assert!(world.verifiers.is_empty() && world.prompts.is_empty());
        assert_eq!(world.made.len(), 1, "no session but the worker's");
    }
    assert_eq!(engine::shown(&checked)["verifierTokens"], json!(null));
    // Read again, the gates are not run again; and the piece that waited may start.
    engine::refreshed(&host, id).unwrap();
    engine::verify(&host, id).unwrap();
    assert_eq!(host.world().checked.len(), 1);
    assert_eq!(engine::start(&host, id).unwrap().started, vec!["docs"]);
}

#[test]
fn a_gate_that_fails_skips_the_later_ones_feeds_the_ladder_and_a_piece_stops_at_three_rounds() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    // Round 1: a file the piece does not own. Scope fails; branch state and the commands never run.
    host.finds("cli", Checked { gates: vec![GateResult::failed(Gate::Scope, "The change touches a file outside what the piece owns:\n- src/control.rs\nThis piece owns only: src/cli.rs.")], ..passing(&[], 0) });
    host.reports("cli", Status::Done, "Moved.");
    let run = engine::refreshed(&host, id).unwrap();
    assert_eq!(gates_of(&run, "cli", 0), (vec![(Gate::Report, true), (Gate::Scope, false)], Some(verify::Outcome::Failed)));
    let piece = run.piece("cli").unwrap();
    assert_eq!((piece.state, piece.tries[0].outcome, piece.retry_waits()), (PieceState::Queued, Some(Outcome::CheckFailed), true));
    let failure = piece.tries[0].detail.as_deref().unwrap();
    assert_eq!(failure, "The result did not pass the scope check, which TerminalX ran on it after the worker reported done.\nThe change touches a file outside what the piece owns:\n- src/control.rs\nThis piece owns only: src/cli.rs.");
    assert_eq!(piece.tries[0].verification.as_ref().unwrap().failure.as_deref(), Some(failure));
    // The ladder's next step, asked for by the check itself; the next worker reads what the gate printed.
    assert_eq!(host.world().retries, vec![id.to_string()]);
    assert_eq!(engine::start_retries(&host, id).unwrap().started, vec!["cli"]);
    let brief = host.world().briefs["w2-cli"].clone();
    assert!(brief.contains("## Earlier tries") && brief.contains("> The result did not pass the scope check") && brief.contains("> - src/control.rs"), "{brief}");

    // Round 2: in scope and clean, and the done-check exits 101.
    let mut failed = passing(&["src/cli.rs"], 20);
    failed.gates[2] = GateResult { gate: Gate::Commands, passed: false, detail: Some("The done-check `cargo t control` exited 101. The last 100 lines it printed:\ntest control::tests::create_reads_default_mode ... FAILED".into()), commands: vec![verify::CommandRun { run: "cargo t control".into(), project: false, exit_code: Some(101), passed: false, millis: 41_000, output: Some("test control::tests::create_reads_default_mode ... FAILED".into()) }] };
    host.finds("cli", failed);
    host.reports("cli", Status::Done, "Moved, within my files.");
    let run = engine::refreshed(&host, id).unwrap();
    assert_eq!(gates_of(&run, "cli", 1), (vec![(Gate::Report, true), (Gate::Scope, true), (Gate::Branch, true), (Gate::Commands, false)], Some(verify::Outcome::Failed)));
    let recorded = &run.piece("cli").unwrap().tries[1].verification.as_ref().unwrap().gates[3].commands[0];
    assert_eq!((recorded.exit_code, recorded.output.as_deref()), (Some(101), Some("test control::tests::create_reads_default_mode ... FAILED")));
    assert_eq!(engine::start_retries(&host, id).unwrap().started, vec!["cli"]);

    // Round 3 fails the same check: three rounds were had, and there is no fourth.
    host.reports("cli", Status::Done, "Fixed this time.");
    let run = engine::refreshed(&host, id).unwrap();
    let piece = run.piece("cli").unwrap();
    assert_eq!((piece.state, piece.tries.len(), piece.gave_up()), (PieceState::Blocked, 3, true));
    assert!(piece.note.as_deref().unwrap().starts_with("Blocked after 3 tries: sonnet at medium, then sonnet at high, then opus at medium. It used all 3 tries. Last failure: The result did not pass the command checks check"), "{:?}", piece.note);
    assert_eq!(tried(&run, "cli").iter().map(|attempt| attempt.3).collect::<Vec<_>>(), vec![Some(Outcome::CheckFailed); 3]);
    assert_eq!((run.state, run.reason.as_deref()), (RunState::Failed, Some("cli is blocked after 3 tries. docs cannot start without it.")));
    assert!(engine::start_retries(&host, id).unwrap().started.is_empty());
    engine::refreshed(&host, id).unwrap();
    let world = host.world();
    assert_eq!((world.made.len(), world.checked.len(), world.retries.len()), (3, 3, 2), "three workers, three checks, two retries");
    // Every round was settled by gates alone.
    assert!(world.verifiers.is_empty());
}

#[test]
fn a_worker_that_ends_without_a_report_that_can_be_read_fails_the_first_gate() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    host.world().now.insert("w1-cli".into(), WorkerNow::NoReport("The `terminalx-report` block is not a report: `evidence` must be a list of strings.".into()));
    let run = engine::refreshed(&host, id).unwrap();
    assert_eq!(gates_of(&run, "cli", 0), (vec![(Gate::Report, false)], Some(verify::Outcome::Failed)));
    let piece = run.piece("cli").unwrap();
    assert_eq!((piece.tries[0].outcome, piece.retry_waits()), (Some(Outcome::CheckFailed), true));
    assert!(piece.tries[0].detail.as_deref().unwrap().contains("ended without a report that can be read") && piece.tries[0].detail.as_deref().unwrap().contains("`evidence` must be a list of strings"), "{:?}", piece.tries[0].detail);
    // Nothing after gate 1 ran, and no model was asked.
    assert!(host.world().checked.is_empty() && host.world().verifiers.is_empty());
    // A report that does not say done is the same gate: the worker's own words are the failure.
    engine::start_retries(&host, id).unwrap();
    host.reports("cli", Status::Partial, "One call site is left.");
    let run = engine::refreshed(&host, id).unwrap();
    assert_eq!(gates_of(&run, "cli", 1), (vec![(Gate::Report, false)], Some(verify::Outcome::Failed)));
    assert_eq!(run.piece("cli").unwrap().tries[1].outcome, Some(Outcome::Partial));
    assert!(host.world().checked.is_empty());
}

#[test]
fn a_review_is_read_by_a_verifier_on_the_verify_row_that_sees_the_diff_and_none_of_the_workers_words() {
    let _home = crate::store::temp_home();
    let (host, id) = run_of("lead", json!([{"id": "guide", "title": "Write the settings guide", "kind": "code", "model": "opus", "effort": "high", "goal": "The guide documents every settings key.", "why": "WHY-ONLY-THE-WORKER-KNOWS",
        "owns": ["docs/"], "reviewOnly": true, "reviewOnlyReason": "It is prose.", "doneChecks": [{"type": "review", "text": "Every key in src/store/settings is named in the guide."}]}]));
    let id = id.as_str();
    // Review only: there is no command gate to run.
    let mut found = passing(&["docs/guide.md"], 64);
    found.gates.truncate(2);
    host.finds("guide", found);
    host.reports("guide", Status::Done, "RESULT-ONLY-THE-WORKER-WROTE: 41 keys documented.");
    let run = engine::refreshed(&host, id).unwrap();
    let piece = run.piece("guide").unwrap();
    assert_eq!(piece.state, PieceState::Verifying);
    let check = piece.tries[0].verification.as_ref().unwrap();
    assert!(check.review_open() && !piece.check_waits());
    let review = check.review.as_ref().unwrap();
    assert_eq!((review.reasons.clone(), review.voters, review.threshold), (vec!["No command proves this piece: it is checked by review alone.".to_string()], 1, 1));
    // One verifier, in the worker's own session and so its worktree, started where it cannot edit,
    // on the routing table's `verify` row (mid, medium) and not on the worker's Opus at high.
    let (verifier, prompt) = {
        let world = host.world();
        assert_eq!(world.made[0].model, "opus");
        assert_eq!(world.verifiers, vec![Made { piece: "guide".into(), agent: "claude".into(), model: "sonnet".into(), effort: Some("medium".into()), mode: "plan".into(), session: "w1-guide-verifier-1".into() }]);
        (world.verifiers[0].clone(), world.prompts["w1-guide-verifier-1"].clone())
    };
    assert_eq!(review.verifiers[0].session, Some(SessionRef { session_id: "w1-guide".into(), tab_id: Some(verifier.session.clone()) }));
    assert_eq!((review.verifiers[0].model.as_str(), review.verifiers[0].effort.as_deref()), ("sonnet", Some("medium")));
    // It is known as a verifier from before its first turn: an edit by it is refused.
    assert_eq!(store::is_verifier("w1-guide", "w1-guide-verifier-1"), Some(true));
    assert_eq!(store::is_verifier("w1-guide", "w1-guide-tab"), Some(false), "the worker's own tab is not one");
    // The prompt: the goal, the done-check, the diff and what the gates said.
    for said in ["The guide documents every settings key.", "- Every key in src/store/settings is named in the guide.", "diff --git a/docs/guide.md b/docs/guide.md", "- No command proves this piece: it is checked by review alone.", "- report: passed", "- scope: passed", "- branch state: passed", "against `settings-typed-store`"] {
        assert!(prompt.contains(said), "{said:?} is missing from:\n{prompt}");
    }
    // None of the worker's transcript: not its report, not its brief, not the lead's reasons.
    for absent in ["RESULT-ONLY-THE-WORKER-WROTE", "41 keys documented", "WHY-ONLY-THE-WORKER-KNOWS", "You are a worker in a run", "terminalx-report", "Move CLI reads"] {
        assert!(!prompt.contains(absent), "{absent:?} reached the verifier:\n{prompt}");
    }
    assert!(prompt.len() <= verify::PROMPT_LIMIT);
    assert_eq!(review.prompt_chars, prompt.chars().count());

    // While it reads, the piece waits; reading the run again asks nobody anything.
    let again = engine::refreshed(&host, id).unwrap();
    assert_eq!(again.piece("guide").unwrap().state, PieceState::Verifying);
    let asked = |host: &Fake| { let world = host.world(); (world.checked.len(), world.verifiers.len()) };
    assert_eq!(asked(&host), (1, 1));
    // Its turn ends with a pass: the turn ended in the worker's session, and the piece follows.
    host.verifier_replies("guide", 1, &verdict_block(PASS), 5_200);
    engine::worker_turn_ended(&host, "w1-guide");
    let run = store::get(id).unwrap();
    assert_eq!((run.piece("guide").unwrap().state, run.state), (PieceState::Done, RunState::Done));
    assert_eq!(gates_of(&run, "guide", 0), (vec![(Gate::Report, true), (Gate::Scope, true), (Gate::Branch, true), (Gate::Review, true)], Some(verify::Outcome::Passed)));
    // What the model step used is on the piece, apart from what its worker used.
    let verifier = &run.piece("guide").unwrap().tries[0].verification.as_ref().unwrap().review.as_ref().unwrap().verifiers[0];
    assert_eq!((verifier.verdict, verifier.tokens.map(|tokens| tokens.total())), (Some(verify::Decision::Pass), Some(5_200)));
    assert_eq!(engine::shown(&run)["verifierTokens"], 5_200);

    // The row is a setting: changed, the next verifier runs on what it names.
    let other = Fake::new();
    {
        let mut settings = other.settings.lock().unwrap();
        settings.require_approval = false;
        settings.routing.set("verify", "claude", Some(super::routing::Route { tier: Tier::Large, effort: Some("low".into()) }));
    }
    let plan: Plan = serde_json::from_value(json!({"goal": "Guide", "pieces": [{"id": "guide", "title": "Guide", "kind": "scoped-code", "owns": ["docs/"], "reviewOnly": true, "reviewOnlyReason": "Prose.", "doneChecks": [{"type": "review", "text": "Reads well."}]}]})).unwrap();
    let second = engine::create(&other, &plan, "lead-2", None).unwrap();
    engine::start(&other, &second.id).unwrap();
    other.reports("guide", Status::Done, "Written.");
    engine::refreshed(&other, &second.id).unwrap();
    assert_eq!(other.world().verifiers.iter().map(|made| (made.model.clone(), made.effort.clone())).collect::<Vec<_>>(), vec![("opus".to_string(), Some("low".to_string()))]);
}

#[test]
fn a_model_reads_a_result_only_where_the_gates_cannot_settle_it() {
    let _home = crate::store::temp_home();
    let piece = |id: &str, kind: &str, owns: &str| json!({"id": id, "title": id, "kind": kind, "model": "sonnet", "owns": [owns], "doneChecks": [{"type": "command", "run": "true"}]});
    let mut asked = piece("asked", "code", "f/");
    asked["doneChecks"] = json!([{"type": "command", "run": "true"}, {"type": "review", "text": "No public name changed."}]);
    let (host, id) = run_of("lead", json!([piece("plain", "code", "a/"), piece("keys", "code", "b/"), piece("large", "code", "c/"), piece("edge", "code", "d/"), piece("moved", "refactor", "e/"), asked]));
    host.finds("plain", passing(&["a/x.rs"], 120));
    host.finds("keys", Checked { facts: Facts { security_areas: vec!["secrets".into()], ..passing(&["b/keys.rs"], 12).facts }, ..passing(&["b/keys.rs"], 12) });
    host.finds("large", passing(&["c/x.rs"], 401));
    host.finds("edge", passing(&["d/x.rs"], 400));
    host.finds("moved", passing(&["e/x.rs"], 30));
    host.finds("asked", passing(&["f/x.rs"], 30));
    for id in ["plain", "keys", "large", "edge", "moved", "asked"] {
        host.reports(id, Status::Done, "Done.");
    }
    let run = engine::refreshed(&host, &id).unwrap();
    // A passing command, a diff of at most 400 lines, no security area, not a refactor, no review asked: accepted.
    assert_eq!(states(&run), vec![("plain", PieceState::Done), ("keys", PieceState::Verifying), ("large", PieceState::Verifying), ("edge", PieceState::Done), ("moved", PieceState::Verifying), ("asked", PieceState::Verifying)]);
    let reason = |piece: &str| run.piece(piece).unwrap().tries[0].verification.as_ref().unwrap().review.as_ref().map(|review| review.reasons.join(" "));
    assert_eq!(reason("plain"), None);
    assert_eq!(reason("edge"), None);
    assert_eq!(reason("keys").as_deref(), Some("The change touches a security area: secrets."));
    assert_eq!(reason("large").as_deref(), Some("The diff is 401 changed lines, over the 400 a result is accepted at without a reader."));
    assert!(reason("moved").unwrap().starts_with("The piece is a refactor"));
    assert_eq!(reason("asked").as_deref(), Some("The plan asks for a review of this piece."));
    assert_eq!(host.world().verifiers.iter().map(|made| made.piece.clone()).collect::<Vec<_>>(), vec!["keys", "large", "moved", "asked"]);
    // The verifier is told what the gates already ran, and is not asked to run it again.
    let prompt = host.world().prompts["w3-large-verifier-1"].clone();
    assert!(prompt.contains("- command checks: passed") && prompt.contains("Do not run them again."), "{prompt}");

    // The threshold is a setting, the app's or the project's own.
    let (roomy, roomy_id) = run_of("lead-2", json!([piece("large", "code", "c/")]));
    roomy.settings.lock().unwrap().projects.entry("/repo".into()).or_default().review_diff_lines = Some(1000);
    roomy.finds("large", passing(&["c/x.rs"], 401));
    roomy.reports("large", Status::Done, "Done.");
    assert_eq!(engine::refreshed(&roomy, &roomy_id).unwrap().piece("large").unwrap().state, PieceState::Done);
    assert!(roomy.world().verifiers.is_empty());
}

#[test]
fn a_verifier_that_fails_the_result_sends_it_back_with_its_evidence_as_the_failure_text() {
    let _home = crate::store::temp_home();
    let (host, id) = run_of("lead", json!([{"id": "cli", "title": "Tidy the CLI", "kind": "refactor", "model": "sonnet", "effort": "medium", "owns": ["src/cli.rs"], "doneChecks": [{"type": "command", "run": "cargo t cli"}]}]));
    let id = id.as_str();
    host.finds("cli", passing(&["src/cli.rs"], 90));
    host.reports("cli", Status::Done, "Tidied.");
    engine::refreshed(&host, id).unwrap();
    host.verifier_replies("cli", 1, &verdict_block(r#"{"verdict": "fail", "evidence": ["src/cli.rs:40: `parse_runs` was renamed, and control.rs still calls the old name", "src/cli.rs:212: the --json flag is no longer read"]}"#), 7_000);
    assert_eq!(engine::worker_turn_ended(&host, "w1-cli").as_deref(), Some(id), "the piece waits for its next try");
    let run = store::get(id).unwrap();
    assert_eq!(gates_of(&run, "cli", 0), (vec![(Gate::Report, true), (Gate::Scope, true), (Gate::Branch, true), (Gate::Commands, true), (Gate::Review, false)], Some(verify::Outcome::Failed)));
    let piece = run.piece("cli").unwrap();
    assert_eq!((piece.tries[0].outcome, piece.retry_waits(), piece.tries[1].step), (Some(Outcome::CheckFailed), true, Step::Effort));
    let failure = piece.tries[0].detail.as_deref().unwrap();
    assert_eq!(failure, "The result did not pass the review check, which TerminalX ran on it after the worker reported done.\nA verifier that read the diff, and none of the worker's reasoning, did not pass the result:\n- src/cli.rs:40: `parse_runs` was renamed, and control.rs still calls the old name\n- src/cli.rs:212: the --json flag is no longer read");
    // The same ladder as any other failed check: the next worker is briefed with the evidence.
    assert_eq!(host.world().retries, vec![id.to_string()]);
    engine::start_retries(&host, id).unwrap();
    assert!(host.world().briefs["w2-cli"].contains("> - src/cli.rs:40: `parse_runs` was renamed"));
    // The verifier that failed it is on the first try, with what it used.
    assert_eq!(piece.tries[0].verification.as_ref().unwrap().review.as_ref().unwrap().tokens(), Some(7_000));
}

#[test]
fn a_vote_of_three_with_a_threshold_of_two_passes_on_two_agreeing_verdicts() {
    let _home = crate::store::temp_home();
    let vote = json!([{"id": "migrate", "title": "Migrate the settings file", "kind": "code", "model": "opus", "owns": ["src/store/"],
        "doneChecks": [{"type": "command", "run": "cargo t store"}, {"type": "vote", "text": "The migration loses no key a person had set.", "voters": 3, "threshold": 2}]}]);
    let (host, id) = run_of("lead", vote.clone());
    let id = id.as_str();
    host.finds("migrate", passing(&["src/store/migrate.rs"], 96));
    host.reports("migrate", Status::Done, "Migrated.");
    let run = engine::refreshed(&host, id).unwrap();
    let review = run.piece("migrate").unwrap().tries[0].verification.as_ref().unwrap().review.clone().unwrap();
    assert_eq!((review.reasons, review.voters, review.threshold, review.verifiers.len()), (vec!["The plan asks for a vote on this piece.".to_string()], 3, 2, 3));
    // Three verifiers, each a conversation of its own, each sent the same prompt.
    {
        let world = host.world();
        assert_eq!(world.verifiers.iter().map(|made| made.session.as_str()).collect::<Vec<_>>(), vec!["w1-migrate-verifier-1", "w1-migrate-verifier-2", "w1-migrate-verifier-3"]);
        assert!(world.prompts.values().all(|prompt| prompt == &world.prompts["w1-migrate-verifier-1"] && prompt.contains("- The migration loses no key a person had set.")));
    }
    // One pass, then one fail: nothing is counted until each has answered.
    host.verifier_replies("migrate", 1, &verdict_block(PASS), 3_000);
    host.verifier_replies("migrate", 2, &verdict_block(r#"{"verdict": "fail", "evidence": ["src/store/migrate.rs:31: drops keys it does not know"]}"#), 4_000);
    engine::worker_turn_ended(&host, "w1-migrate");
    assert_eq!(store::get(id).unwrap().piece("migrate").unwrap().state, PieceState::Verifying);
    // The second pass makes two of three.
    host.verifier_replies("migrate", 3, &verdict_block(PASS), 3_500);
    engine::worker_turn_ended(&host, "w1-migrate");
    let run = store::get(id).unwrap();
    assert_eq!(run.piece("migrate").unwrap().state, PieceState::Done);
    let check = run.piece("migrate").unwrap().tries[0].verification.as_ref().unwrap();
    assert_eq!(check.gates.last().map(|gate| (gate.gate, gate.passed, gate.detail.as_deref())), Some((Gate::Review, true, Some("2 of 3 verifiers passed it; 2 had to."))));
    assert_eq!(check.review.as_ref().unwrap().verifiers.iter().map(|verifier| verifier.verdict).collect::<Vec<_>>(), vec![Some(verify::Decision::Pass), Some(verify::Decision::Fail), Some(verify::Decision::Pass)]);
    assert_eq!(engine::shown(&run)["verifierTokens"], 10_500);

    // One pass of three is not two: the piece goes back with the evidence of the two that failed it.
    let (short, short_id) = run_of("lead-2", vote);
    short.finds("migrate", passing(&["src/store/migrate.rs"], 96));
    short.reports("migrate", Status::Done, "Migrated.");
    engine::refreshed(&short, &short_id).unwrap();
    short.verifier_replies("migrate", 1, &verdict_block(PASS), 1);
    short.verifier_replies("migrate", 2, &verdict_block(r#"{"verdict": "fail", "evidence": ["src/store/migrate.rs:31: drops keys it does not know"]}"#), 1);
    short.verifier_replies("migrate", 3, &verdict_block(r#"{"verdict": "fail", "evidence": ["src/store/migrate.rs:58: writes before it has read"]}"#), 1);
    let run = engine::refreshed(&short, &short_id).unwrap();
    let piece = run.piece("migrate").unwrap();
    assert_eq!(piece.tries[0].outcome, Some(Outcome::CheckFailed));
    assert!(piece.tries[0].detail.as_deref().unwrap().ends_with("2 of 3 verifiers that read the diff did not pass the result (2 must pass, 1 did):\n- src/store/migrate.rs:31: drops keys it does not know\n- src/store/migrate.rs:58: writes before it has read"), "{:?}", piece.tries[0].detail);
}

#[test]
fn a_review_nobody_can_answer_blocks_the_piece_without_calling_the_result_wrong() {
    let _home = crate::store::temp_home();
    let pieces = json!([{"id": "guide", "title": "Guide", "kind": "scoped-code", "owns": ["docs/"], "reviewOnly": true, "reviewOnlyReason": "Prose.", "doneChecks": [{"type": "review", "text": "Reads well."}]}]);
    // The verifier ends without a verdict block, and with a fail that names no place.
    for reply in ["It looks fine to me.".to_string(), verdict_block(r#"{"verdict": "fail", "evidence": ["I do not like it."]}"#)] {
        let (host, id) = run_of(&format!("lead-{}", reply.len()), pieces.clone());
        host.reports("guide", Status::Done, "Written.");
        engine::refreshed(&host, &id).unwrap();
        host.verifier_replies("guide", 1, &reply, 900);
        let run = engine::refreshed(&host, &id).unwrap();
        let piece = run.piece("guide").unwrap();
        assert_eq!((piece.state, piece.tries.len(), piece.tries[0].outcome, piece.gave_up()), (PieceState::Blocked, 1, Some(Outcome::Done), false), "not a failed try: nobody said the result is wrong");
        assert_eq!(piece.tries[0].verification.as_ref().unwrap().outcome, Some(verify::Outcome::Inconclusive));
        assert!(piece.note.as_deref().unwrap().starts_with("Its result could not be checked. The verifier gave no verdict: "), "{:?}", piece.note);
        // It stands when the run is read again: the verifier is not asked a second time by a read.
        assert_eq!(engine::refreshed(&host, &id).unwrap(), run);
        assert_eq!(host.world().verifiers.len(), 1);
        assert!(host.world().retries.is_empty());
    }
    // A verifier that cannot be started at all is the same: said, and left to the lead.
    let (host, id) = run_of("lead-none", pieces);
    host.world().no_verifier.insert("guide".into());
    host.reports("guide", Status::Done, "Written.");
    let run = engine::refreshed(&host, &id).unwrap();
    let piece = run.piece("guide").unwrap();
    assert_eq!(piece.state, PieceState::Blocked);
    assert!(piece.note.as_deref().unwrap().contains("It could not be started: the agent is not installed"), "{:?}", piece.note);
}

#[test]
fn a_result_is_accepted_as_the_commit_that_was_checked() {
    let _home = crate::store::temp_home();
    let (host, id) = run_of("lead", json!([{"id": "guide", "title": "Guide", "kind": "scoped-code", "owns": ["docs/"], "reviewOnly": true, "reviewOnlyReason": "Prose.", "doneChecks": [{"type": "review", "text": "Reads well."}]}]));
    let id = id.as_str();
    host.finds("guide", passing(&["docs/guide.md"], 10));
    host.reports("guide", Status::Done, "Written.");
    engine::refreshed(&host, id).unwrap();
    // The gates ran on c0ffee1; while the verifier read, the branch moved.
    host.world().commits.insert("w1-guide".into(), "deadbeef".into());
    host.verifier_replies("guide", 1, &verdict_block(PASS), 800);
    let run = engine::refreshed(&host, id).unwrap();
    // Its pass is of another commit: the check starts again from the gates, and asks again.
    assert_eq!(run.piece("guide").unwrap().state, PieceState::Verifying);
    let asked = { let world = host.world(); (world.checked.len(), world.verifiers.len()) };
    assert_eq!(asked, (2, 2));
    // The branch where it was checked: the pass counts.
    host.world().commits.insert("w1-guide".into(), "c0ffee1".into());
    host.verifier_replies("guide", 2, &verdict_block(PASS), 800);
    assert_eq!(engine::refreshed(&host, id).unwrap().piece("guide").unwrap().state, PieceState::Done);
}

#[test]
fn a_check_under_way_ends_with_its_run_and_starts_again_when_its_worker_works_again() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    host.world().hold_checks = true;
    host.reports("cli", Status::Done, "Moved.");
    engine::refreshed(&host, id).unwrap();
    // The lead sends the worker back to work before the gates were run: what it reported is no longer its result.
    host.world().now.insert("w1-cli".into(), WorkerNow::Working);
    let run = engine::refreshed(&host, id).unwrap();
    let piece = run.piece("cli").unwrap();
    assert_eq!((piece.state, piece.tries[0].outcome, piece.tries[0].verification.is_none()), (PieceState::Running, None, true));
    // What the checks noted of its worktree is forgotten with it, once: what it leaves there now is its own.
    engine::refreshed(&host, id).unwrap();
    assert_eq!(host.world().resets, vec!["w1-cli"]);
    assert!(engine::verify(&host, id).unwrap().piece("cli").unwrap().state == PieceState::Running && host.world().checked.is_empty());
    // It reports again, and the run is stopped while that result waits: nothing is checked, nothing accepted.
    host.reports("cli", Status::Done, "Moved, again.");
    engine::refreshed(&host, id).unwrap();
    let stopped = engine::stop(&host, id, By::Cli).unwrap();
    assert_eq!(states(&stopped.run), vec![("cli", PieceState::Stopped), ("docs", PieceState::Stopped)]);
    let after = engine::verify(&host, id).unwrap();
    assert_eq!(after, stopped.run);
    assert!(host.world().checked.is_empty());
}

#[test]
fn a_lead_waiting_on_its_run_is_woken_by_a_piece_settled_not_by_each_turn_that_ends() {
    let _home = crate::store::temp_home();
    let (host, id) = one_piece();
    let id = id.as_str();
    host.world().hold_checks = true;
    let began = store::get(id).unwrap();
    // Nothing has happened: the lead sleeps on.
    assert_eq!(engine::wake(&began, &began, false), None);
    // The worker's turn ends with `done`: its result is being checked, and that is not the lead's to act on.
    host.reports("cli", Status::Done, "Moved.");
    let verifying = engine::refreshed(&host, id).unwrap();
    assert_eq!(verifying.piece("cli").unwrap().state, PieceState::Verifying);
    assert_eq!(engine::wake(&began, &verifying, false), None);
    // The check fails and the piece goes back to a fresh worker: still nothing for the lead.
    host.finds("cli", Checked { gates: vec![GateResult::failed(Gate::Scope, "- src/control.rs")], ..passing(&[], 0) });
    let retrying = engine::verify(&host, id).unwrap();
    assert!(retrying.piece("cli").unwrap().retry_waits());
    assert_eq!(engine::wake(&began, &retrying, false), None);
    assert_eq!(engine::wake(&began, &retrying, true), None, "a retry that waits is still under way");
    engine::start_retries(&host, id).unwrap();
    // The second try passes its gates: the piece is done, and the piece behind it is the lead's to start.
    host.world().checks.clear();
    host.reports("cli", Status::Done, "Moved, within my files.");
    engine::refreshed(&host, id).unwrap();
    let accepted = engine::verify(&host, id).unwrap();
    let woken = engine::wake(&began, &accepted, false).expect("an accepted piece wakes the lead");
    assert_eq!(woken["why"], json!(["cli is done: its result passed its checks.", "Ready to start with `terminalx runs start`: docs."]));
    assert_eq!((&woken["ready"], &woken["state"], &woken["pieces"][0]), (&json!(["docs"]), &json!("running"), &json!({"piece": "cli", "state": "done", "changed": true, "note": "Moved, within my files."})));
    // A change the lead missed between two waits still shows: the piece is ready when the next wait begins.
    assert_eq!(engine::wake(&accepted, &accepted, false).unwrap()["why"], json!(["Ready to start with `terminalx runs start`: docs."]));
    // Started, the lead sleeps again until the run ends; `--all` returns only then.
    engine::start(&host, id).unwrap();
    let running = store::get(id).unwrap();
    assert_eq!((engine::wake(&running, &running, false), engine::wake(&running, &running, true)), (None, None));
    host.reports("docs", Status::Done, "Documented.");
    engine::refreshed(&host, id).unwrap();
    let done = engine::verify(&host, id).unwrap();
    assert_eq!(engine::wake(&running, &done, true).unwrap()["why"], json!(["docs is done: its result passed its checks.", "The run is done."]));
    // A piece that blocked before the wait began, with nothing else under way: there is nothing to
    // wait for, and the lead is told so at once rather than left asleep to its timeout.
    let (asking, asking_id) = one_piece_for("lead-asking");
    asking.reports("cli", Status::Blocked, "Which config file is the source of truth?");
    let held = engine::refreshed(&asking, &asking_id).unwrap();
    assert_eq!((held.state, held.piece("cli").unwrap().state), (RunState::Running, PieceState::Blocked));
    let woken = engine::wake(&held, &held, false).expect("nothing is under way");
    assert_eq!(woken["why"], json!(["Nothing is under way and nothing can start: waiting changes nothing. Held up by: cli. `terminalx runs show` says why for each."]));
    assert_eq!(woken["pieces"][0]["changed"], false);
    // The same for a review nobody could answer.
    let (unread, unread_id) = run_of("lead-unread", json!([{"id": "guide", "title": "Guide", "kind": "scoped-code", "owns": ["docs/"], "reviewOnly": true, "reviewOnlyReason": "Prose.", "doneChecks": [{"type": "review", "text": "Reads well."}]}]));
    unread.reports("guide", Status::Done, "Written.");
    engine::refreshed(&unread, &unread_id).unwrap();
    unread.verifier_replies("guide", 1, "No verdict here.", 10);
    let inconclusive = engine::refreshed(&unread, &unread_id).unwrap();
    assert!(engine::wake(&inconclusive, &inconclusive, false).unwrap()["why"][0].as_str().unwrap().contains("Held up by: guide."));
    // A piece that ran out of tries wakes it too, with how far it got.
    let (stuck, stuck_id) = one_piece_for("lead-stuck");
    let before = store::get(&stuck_id).unwrap();
    for _ in 0..3 {
        stuck.reports("cli", Status::Failed, "A test fails.");
        engine::refreshed(&stuck, &stuck_id).unwrap();
        engine::start_retries(&stuck, &stuck_id).unwrap();
    }
    let blocked = store::get(&stuck_id).unwrap();
    assert_eq!(engine::wake(&before, &blocked, false).unwrap()["why"], json!(["cli is blocked after 3 tries.", "The run is failed."]));
}
