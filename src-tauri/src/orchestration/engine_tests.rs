//! The engine against a stand-in for the app's sessions: what starts when,
//! what a report makes of a piece, what survives a restart, what a stop leaves.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use serde_json::json;

use super::engine::{self, By, EngineError, Host, Lead, Started, WorkerNow};
use super::plan::Plan;
use super::{store, Piece, PieceState, Run, RunState, SessionRef};
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

    fn made(&self) -> Vec<String> {
        self.world().made.iter().map(|made| made.piece.clone()).collect()
    }
}

impl Host for Fake {
    fn lead(&self, session_id: &str) -> Result<Lead, EngineError> {
        if session_id == "nobody" {
            return Err(EngineError::new("lead_not_found", "No session nobody to lead the run.", None));
        }
        Ok(Lead { project_path: "/repo".into(), agent: "claude".into(), repository: self.repository })
    }

    fn worker_agents(&self) -> Vec<String> {
        vec!["claude".into(), "codex".into()]
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

    fn tell_lead(&self, _run: &Run, text: &str) {
        self.world().told.push(text.to_string());
    }

    fn changed(&self, run: &Run) {
        self.world().changed.push(run.state);
    }
}

/// Six pieces, as a lead would split a move of settings reads: `map` first,
/// `store` on it, three movers on `store`, and `docs` on the three.
fn plan() -> Plan {
    serde_json::from_value(json!({
        "goal": "Move settings reads to the typed store",
        "budget": {"points": 25},
        "pieces": [
            {"id": "map", "title": "Map every settings read", "doneCheck": "the list covers every call", "model": "haiku", "kind": "search", "estimate": {"low": 0.05, "high": 0.05}},
            {"id": "store", "title": "Typed store module", "doneCheck": "cargo t store::settings", "owns": ["src/store/settings/"], "dependsOn": ["map"], "model": "opus", "effort": "medium", "estimate": {"low": 1.6, "high": 2.4}},
            {"id": "session", "title": "Move session code", "doneCheck": "cargo t session", "owns": ["src/session*.rs"], "dependsOn": ["store"], "model": "sonnet", "effort": "medium"},
            {"id": "pipeline", "title": "Move pipeline code", "doneCheck": "cargo t issue_pipeline", "owns": ["src/issue_pipeline/"], "dependsOn": ["store"], "model": "sonnet", "permissionMode": "acceptEdits"},
            {"id": "cli", "title": "Move CLI code", "doneCheck": "cargo t control", "owns": ["src/cli.rs", "src/control.rs"], "dependsOn": ["store"], "agent": "codex", "model": "gpt-terra", "effort": "high"},
            {"id": "docs", "title": "Update the docs", "doneCheck": "every documented key exists", "owns": ["docs/"], "dependsOn": ["session", "pipeline", "cli"], "readsUntrusted": true},
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
    let error = refused(&|plan| plan.pieces[2].done_check = String::new());
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
fn the_projects_mode_is_the_default_of_its_workers_and_a_piece_may_still_choose() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    {
        let mut settings = host.settings.lock().unwrap();
        settings.require_approval = false;
        settings.projects.entry("/repo".into()).or_default().worker_mode = Some("manual".into());
    }
    let plan: Plan = serde_json::from_value(json!({"goal": "Two", "pieces": [
        {"id": "a", "title": "A", "doneCheck": "x"},
        {"id": "b", "title": "B", "doneCheck": "x", "permissionMode": "bypassPermissions"},
    ]}))
    .unwrap();
    let run = engine::create(&host, &plan, "lead", None).unwrap();
    assert_eq!(run.worker_mode, "manual");
    engine::start(&host, &run.id).unwrap();
    let modes: Vec<(String, String)> = host.world().made.iter().map(|made| (made.piece.clone(), made.mode.clone())).collect();
    assert_eq!(modes, vec![("a".to_string(), "manual".to_string()), ("b".into(), "bypassPermissions".into())]);
}

#[test]
fn a_run_survives_a_restart_with_its_piece_states_intact() {
    let home = crate::store::temp_home();
    let (host, run) = started_free();
    let id = run.id.clone();
    engine::start(&host, &id).unwrap();
    host.reports("map", Status::Done, "41 call sites in 9 files.");
    engine::start(&host, &id).unwrap();
    host.reports("store", Status::Partial, "The migration is written; two tests fail.");
    let before = engine::refreshed(&host, &id).unwrap();
    assert_eq!(states(&before)[..3], [("map", PieceState::Done), ("store", PieceState::Blocked), ("session", PieceState::Queued)]);
    assert_eq!(before.piece("store").unwrap().note.as_deref(), Some("Reported partial: The migration is written; two tests fail."));

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
        world.now.insert("w2-store".into(), WorkerNow::Reported { status: Status::Partial, result: "The migration is written; two tests fail.".into() });
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

    // A `failed` report with nothing else able to run fails the run, and says what it holds up.
    host.reports("map", Status::Failed, "The search tool crashed.");
    let failed = engine::refreshed(&host, id).unwrap();
    assert_eq!((failed.state, failed.piece("map").unwrap().state), (RunState::Failed, PieceState::Failed));
    assert_eq!(failed.reason.as_deref(), Some("map failed. store cannot start without it."));
    // The same worker made to finish brings the run back.
    host.reports("map", Status::Done, "41 call sites in 9 files.");
    let back = engine::start(&host, id).unwrap();
    assert_eq!((back.run.state, back.run.reason.clone(), back.started), (RunState::Running, None, vec!["store".to_string()]));
}

#[test]
fn a_worker_that_cannot_be_started_fails_its_piece_and_the_next_start_tries_again() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Three", "pieces": [
        {"id": "a", "title": "A", "doneCheck": "x"},
        {"id": "b", "title": "B", "doneCheck": "x"},
        {"id": "c", "title": "C", "doneCheck": "x"},
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
    broken.pieces[0].done_check.clear();
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
