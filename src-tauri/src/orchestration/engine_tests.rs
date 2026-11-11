//! The engine against a stand-in for the app's sessions: what starts when,
//! what a report makes of a piece, what survives a restart, what a stop leaves.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use serde_json::json;

use super::budget::{Login, PauseKind, RunLimits};
use super::engine::{self, Activity, By, EngineError, Host, Lead, Resume, Started, WorkerNow};
use super::plan::Plan;
use super::{store, Hold, Piece, PieceState, Run, RunState, SessionRef};
use crate::status::usage::UsageWindow;
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
    /// PRO-280: the usage windows, each worker session's cost, the agents on
    /// an API key, each worker's activity, the clock, and how often a watch was asked for.
    windows: Vec<UsageWindow>,
    costs: BTreeMap<String, f64>,
    api_key: BTreeSet<String>,
    activity: BTreeMap<String, Activity>,
    clock: i64,
    watches: usize,
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

    fn tell_lead(&self, _run: &Run, text: &str) {
        self.world().told.push(text.to_string());
    }

    fn changed(&self, run: &Run) {
        self.world().changed.push(run.state);
    }

    fn login(&self, agent: &str) -> Login {
        if self.world().api_key.contains(agent) { Login::ApiKey } else { Login::Subscription }
    }

    fn windows(&self) -> Vec<UsageWindow> {
        self.world().windows.clone()
    }

    fn cost(&self, worker: &SessionRef) -> Option<f64> {
        self.world().costs.get(&worker.session_id).copied()
    }

    fn activity(&self, worker: &SessionRef) -> Activity {
        self.world().activity.get(&worker.session_id).cloned().unwrap_or_default()
    }

    /// At once: nothing here holds a lock a start would wait on.
    fn fill_later(&self) {
        engine::fill_slots(self);
    }

    fn watch(&self) {
        self.world().watches += 1;
    }

    fn now_ms(&self) -> i64 {
        self.world().clock
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
    assert_eq!(third.waiting, vec![engine::Waiting { piece: "docs".into(), on: vec!["session".into(), "pipeline".into(), "cli".into()], queued_for: None }]);

    // Two of three done is not enough for `docs`.
    host.reports("session", Status::Done, "17 call sites moved.");
    host.reports("cli", Status::Done, "CLI reads moved.");
    let fourth = engine::start(&host, id).unwrap();
    assert!(fourth.started.is_empty());
    assert_eq!(fourth.waiting, vec![engine::Waiting { piece: "docs".into(), on: vec!["pipeline".into()], queued_for: None }]);
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
            {"id": "a", "title": "A", "doneCheck": "x"},
            {"id": "b", "title": "B", "doneCheck": "x", "permissionMode": mode},
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
fn a_session_that_cannot_be_made_safe_is_kept_and_tried_again_never_made_twice() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    host.settings.lock().unwrap().require_approval = false;
    let plan: Plan = serde_json::from_value(json!({"goal": "Two", "pieces": [
        {"id": "a", "title": "A", "doneCheck": "x"},
        {"id": "b", "title": "B", "doneCheck": "x"},
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

// ---------------------------------------------------------------- limits, budget, stalls (PRO-280)

/// `count` pieces that depend on nothing, on `agent`.
fn flat_plan(count: usize, agent: &str) -> Plan {
    let pieces: Vec<serde_json::Value> = (1..=count).map(|n| json!({"id": format!("p{n}"), "title": format!("Piece {n}"), "doneCheck": "exit 0", "agent": agent, "model": "sonnet"})).collect();
    serde_json::from_value(json!({"goal": "Many small pieces", "pieces": pieces})).unwrap()
}

/// A host that starts runs without approval, with its settings changed by `set`.
fn free_host(set: impl FnOnce(&mut OrchestratorSettings)) -> Fake {
    let host = Fake::new();
    {
        let mut settings = host.settings.lock().unwrap();
        settings.require_approval = false;
        set(&mut settings);
    }
    host
}

fn window(key: &str, label: &str, percent: f32, resets_at: i64) -> UsageWindow {
    UsageWindow { agent: "claude".into(), key: key.into(), label: label.into(), used_percent: percent, resets_at: Some(resets_at), window_minutes: Some(300), updated_at: 0, stale: false, source: "statusline".into(), endpoint_running: false }
}

fn queued_for(run: &Run) -> Vec<(&str, Option<Hold>)> {
    run.pieces.iter().filter(|piece| piece.state == PieceState::Queued).map(|piece| (piece.id.as_str(), piece.queued_for)).collect()
}

#[test]
fn with_a_limit_of_two_two_of_five_run_and_each_finish_starts_one_more() {
    let _home = crate::store::temp_home();
    let host = free_host(|settings| settings.workers_per_run = 2);
    let run = engine::create(&host, &flat_plan(5, "claude"), "lead", None).unwrap();
    assert_eq!(run.limits.workers, 2, "the run takes its limit from the settings");

    let start = engine::start(&host, &run.id).unwrap();
    assert_eq!(start.started, vec!["p1", "p2"]);
    assert_eq!(queued_for(&start.run), vec![("p3", Some(Hold::RunLimit)), ("p4", Some(Hold::RunLimit)), ("p5", Some(Hold::RunLimit))]);
    assert!(start.waiting.iter().all(|waiting| waiting.on.is_empty() && waiting.queued_for == Some(Hold::RunLimit)), "{:?}", start.waiting);
    assert_eq!(engine::shown(&start.run)["inTurn"], 2);

    // Another start while both work starts nothing more.
    assert!(engine::start(&host, &run.id).unwrap().started.is_empty());
    assert_eq!(host.made(), vec!["p1", "p2"]);

    // Each finish starts the next queued piece, with no call from the lead.
    for (finished, next) in [("p1", "p3"), ("p2", "p4"), ("p3", "p5")] {
        host.reports(finished, Status::Done, "done");
        engine::worker_turn_ended(&host, &host.session_of(finished));
        let run = store::get(&run.id).unwrap();
        assert_eq!(run.piece(next).unwrap().state, PieceState::Running, "{next} starts when {finished} ends");
        assert!(run.in_turn() <= 2, "never more than two at once: {:?}", states(&run));
    }
    for finished in ["p4", "p5"] {
        host.reports(finished, Status::Done, "done");
        engine::worker_turn_ended(&host, &host.session_of(finished));
    }
    assert_eq!(store::get(&run.id).unwrap().state, RunState::Done);
    assert_eq!(host.made().len(), 5);
}

#[test]
fn a_piece_that_becomes_ready_by_a_dependency_still_waits_for_the_lead() {
    let _home = crate::store::temp_home();
    let host = free_host(|settings| settings.workers_per_run = 1);
    let run = engine::create(&host, &plan(), "lead", None).unwrap();
    assert_eq!(engine::start(&host, &run.id).unwrap().started, vec!["map"]);
    host.reports("map", Status::Done, "41 call sites");
    engine::worker_turn_ended(&host, &host.session_of("map"));
    // `store` is ready now, but the lead may have to collect `map`'s branch first.
    let run = store::get(&run.id).unwrap();
    assert_eq!((run.piece("store").unwrap().state, run.piece("store").unwrap().queued_for), (PieceState::Queued, None));
    assert_eq!(host.made(), vec!["map"]);
    assert_eq!(engine::start(&host, &run.id).unwrap().started, vec!["store"]);
}

#[test]
fn the_app_wide_limit_holds_across_two_runs() {
    let _home = crate::store::temp_home();
    let host = free_host(|settings| {
        settings.workers_per_run = 4;
        settings.workers_at_once = 3;
    });
    let first = engine::create(&host, &flat_plan(3, "claude"), "lead", None).unwrap();
    assert_eq!(engine::start(&host, &first.id).unwrap().started.len(), 3);
    let second = engine::create(&host, &flat_plan(2, "claude"), "lead-2", None).unwrap();
    let start = engine::start(&host, &second.id).unwrap();
    assert!(start.started.is_empty(), "three workers already run in the app");
    assert_eq!(queued_for(&start.run), vec![("p1", Some(Hold::AppLimit)), ("p2", Some(Hold::AppLimit))]);

    // A worker of the first run finishing frees a slot for the second.
    host.reports("p1", Status::Done, "done");
    engine::worker_turn_ended(&host, &host.session_of("p1"));
    let second = store::get(&second.id).unwrap();
    assert_eq!(second.in_turn(), 1);
    assert_eq!(queued_for(&second), vec![("p2", Some(Hold::AppLimit))]);
    let total: usize = store::list().unwrap().iter().map(Run::in_turn).sum();
    assert_eq!(total, 3);

    // Stopping the first run frees its slots too.
    engine::stop(&host, &first.id, By::Cli).unwrap();
    assert_eq!(store::get(&second.id).unwrap().in_turn(), 2);
}

#[test]
fn a_run_on_an_api_key_that_reaches_its_dollar_budget_starts_nothing_new_and_says_why() {
    let _home = crate::store::temp_home();
    let host = free_host(|settings| {
        settings.workers_per_run = 1;
        settings.budget_dollars = 2.0;
    });
    host.world().api_key.insert("claude".into());
    let run = engine::create(&host, &flat_plan(3, "claude"), "lead", None).unwrap();
    assert!(run.usage.api_key && !run.usage.subscription);
    assert_eq!(engine::start(&host, &run.id).unwrap().started, vec!["p1"]);
    assert_eq!(store::get(&run.id).unwrap().piece("p1").unwrap().login, Some(Login::ApiKey));

    // Its first worker spent past the budget in its turn.
    let p1 = host.session_of("p1");
    host.world().costs.insert(p1.clone(), 2.35);
    host.reports("p1", Status::Done, "done");
    engine::worker_turn_ended(&host, &p1);
    let run = store::get(&run.id).unwrap();
    assert_eq!(run.state, RunState::NeedsYou);
    let pause = run.pause.clone().unwrap();
    assert_eq!(pause.kind, PauseKind::Dollars);
    assert!(pause.message.contains("$2.35") && pause.message.contains("$2.00"), "{}", pause.message);
    assert_eq!(run.reason.as_deref(), Some(pause.message.as_str()));
    assert_eq!(host.made(), vec!["p1"], "the queued piece did not start");
    assert!(host.world().told.last().unwrap().contains("reached its budget"), "the lead is told");

    // The lead asking again is refused with the reason; what it asked for waits for the person.
    let error = engine::start(&host, &run.id).unwrap_err();
    assert_eq!(error.code, "needs_you");
    assert!(error.message.contains("$2.35"), "{}", error.message);
    assert_eq!(queued_for(&store::get(&run.id).unwrap()), vec![("p2", Some(Hold::Budget)), ("p3", Some(Hold::Budget))]);
    // Resuming while still past it is refused; raising the budget lets it go on.
    assert_eq!(engine::resume(&host, &run.id, Resume::Now).unwrap_err().code, "budget_reached");
    engine::set_limits(&host, &run.id, RunLimits { dollars: 10.0, ..run.limits.clone() }).unwrap();
    let resumed = engine::resume(&host, &run.id, Resume::Now).unwrap();
    assert_eq!((resumed.run.state, resumed.started.clone()), (RunState::Running, vec!["p2".to_string()]));
    assert!(host.world().told.last().unwrap().contains("running again"));
}

#[test]
fn a_subscription_run_stops_when_a_window_passes_its_level_and_names_the_window_and_its_reset() {
    let _home = crate::store::temp_home();
    let resets = chrono::Utc::now().timestamp_millis() + 3 * 3_600_000;
    let host = free_host(|settings| settings.workers_per_run = 1);
    host.world().windows = vec![window("five_hour", "5h", 40.0, resets), window("seven_day_opus", "7d Opus", 99.0, resets)];
    let run = engine::create(&host, &flat_plan(2, "claude"), "lead", None).unwrap();
    // Dollars do not count on a subscription; a window scoped to a model the run does not use does not either.
    assert!(run.usage.subscription && !run.usage.api_key);
    assert_eq!(run.usage.windows.iter().map(|window| window.key.as_str()).collect::<Vec<_>>(), vec!["five_hour"]);
    assert_eq!(engine::start(&host, &run.id).unwrap().started, vec!["p1"]);
    assert_eq!(store::get(&run.id).unwrap().usage.windows[0].start, Some(40.0), "the baseline is the window when the run began");

    let p1 = host.session_of("p1");
    host.world().costs.insert(p1.clone(), 500.0);
    host.world().windows[0].used_percent = 86.0;
    host.reports("p1", Status::Done, "done");
    engine::worker_turn_ended(&host, &p1);
    let run = store::get(&run.id).unwrap();
    assert_eq!(run.state, RunState::NeedsYou);
    let pause = run.pause.clone().unwrap();
    assert_eq!(pause.kind, PauseKind::Window);
    let at = super::budget::reset_time(resets, host.now_ms());
    assert!(pause.message.contains("Claude 5h") && pause.message.contains("86%") && pause.message.contains(&format!("resets at {at}")), "{}", pause.message);
    assert_eq!(pause.window.as_ref().and_then(|window| window.resets_at), Some(resets));
    assert_eq!(host.made(), vec!["p1"]);
}

#[test]
fn a_run_stops_on_its_own_points_and_the_settings_change_when_the_next_run_stops() {
    let _home = crate::store::temp_home();
    let resets = chrono::Utc::now().timestamp_millis() + 3_600_000;
    let host = free_host(|settings| settings.workers_per_run = 1);
    host.world().windows = vec![window("five_hour", "5h", 10.0, resets)];
    let run = engine::create(&host, &flat_plan(2, "claude"), "lead", None).unwrap();
    engine::start(&host, &run.id).unwrap();
    host.world().windows[0].used_percent = 36.0;
    host.reports("p1", Status::Done, "done");
    engine::worker_turn_ended(&host, &host.session_of("p1"));
    let run = store::get(&run.id).unwrap();
    let pause = run.pause.clone().unwrap();
    assert_eq!((run.state, pause.kind), (RunState::NeedsYou, PauseKind::Points));
    assert!(pause.message.contains("about 26 points") && pause.message.contains("budget of 25"), "{}", pause.message);
    engine::stop(&host, &run.id, By::Person).unwrap();

    // With 40 points and a 90% level in Settings, the same use does not stop the next run.
    {
        let mut settings = host.settings.lock().unwrap();
        settings.budget_points = 40.0;
        settings.window_ceiling = 90.0;
    }
    host.world().windows[0].used_percent = 10.0;
    let next = engine::create(&host, &flat_plan(2, "claude"), "lead", None).unwrap();
    assert_eq!((next.limits.points, next.limits.ceiling), (40.0, 90.0));
    engine::start(&host, &next.id).unwrap();
    host.world().windows[0].used_percent = 36.0;
    host.reports("p1", Status::Done, "done");
    engine::worker_turn_ended(&host, &host.session_of("p1"));
    let next = store::get(&next.id).unwrap();
    assert_eq!(next.state, RunState::Running);
    assert_eq!(next.piece("p2").unwrap().state, PieceState::Running);
    // It stops at the new budget instead: 42 points of its own are past 40.
    host.world().windows[0].used_percent = 52.0;
    host.reports("p2", Status::Partial, "half");
    engine::worker_turn_ended(&host, &host.session_of("p2"));
    let next = store::get(&next.id).unwrap();
    assert_eq!((next.state, next.pause.unwrap().kind), (RunState::NeedsYou, PauseKind::Points));
}

#[test]
fn a_run_with_workers_on_both_logins_keeps_both_budgets() {
    let _home = crate::store::temp_home();
    let host = free_host(|settings| {
        settings.workers_per_run = 1;
        settings.budget_dollars = 1.0;
    });
    host.world().api_key.insert("codex".into());
    host.world().windows = vec![window("five_hour", "5h", 10.0, chrono::Utc::now().timestamp_millis() + 3_600_000)];
    let mut plan = flat_plan(3, "claude");
    plan.pieces[1].agent = Some("codex".into());
    let run = engine::create(&host, &plan, "lead", None).unwrap();
    assert!(run.usage.api_key && run.usage.subscription);
    engine::start(&host, &run.id).unwrap();
    host.reports("p1", Status::Done, "done");
    engine::worker_turn_ended(&host, &host.session_of("p1"));
    // The codex worker on a key spends past a dollar: that stops it, though the window is fine.
    let p2 = host.session_of("p2");
    host.world().costs.insert(p2.clone(), 1.5);
    host.reports("p2", Status::Done, "done");
    engine::worker_turn_ended(&host, &p2);
    assert_eq!(store::get(&run.id).unwrap().pause.unwrap().kind, PauseKind::Dollars);
}

#[test]
fn a_run_paused_on_a_window_resumes_by_itself_after_the_reset_when_asked() {
    let _home = crate::store::temp_home();
    let now = chrono::Utc::now().timestamp_millis();
    let resets = now + 3_600_000;
    let host = free_host(|settings| settings.workers_per_run = 1);
    host.world().clock = now;
    host.world().windows = vec![window("five_hour", "5h", 90.0, resets)];
    let run = engine::create(&host, &flat_plan(2, "claude"), "lead", None).unwrap();
    // Over the level before anything starts: nothing starts, and the approval view would have warned.
    assert!(!super::budget::fit(&run, now).is_empty());
    let start = engine::start(&host, &run.id).unwrap();
    assert!(start.started.is_empty());
    assert_eq!(start.run.state, RunState::NeedsYou);
    assert_eq!(queued_for(&start.run), vec![("p1", Some(Hold::Budget)), ("p2", Some(Hold::Budget))]);

    let asked = engine::resume(&host, &run.id, Resume::AfterReset).unwrap();
    assert_eq!(asked.run.pause.as_ref().unwrap().resume_at, Some(resets));
    assert!(engine::watch(&host), "a resume to come is something to watch");
    assert_eq!(store::get(&run.id).unwrap().state, RunState::NeedsYou, "not before the reset");

    // The window resets: the next watch lets it go on.
    {
        let mut world = host.world();
        world.clock = resets + 1_000;
        world.windows = vec![window("five_hour", "5h", 2.0, resets + 5 * 3_600_000)];
    }
    engine::watch(&host);
    let run = store::get(&run.id).unwrap();
    assert_eq!(run.state, RunState::Running);
    assert_eq!(host.made(), vec!["p1"], "one worker, as the limit allows; the other queues for a slot");
    assert_eq!(queued_for(&run), vec![("p2", Some(Hold::RunLimit))]);
    assert!(host.world().told.last().unwrap().contains("reset"));
}

#[test]
fn a_worker_inside_a_long_build_is_not_stalled_and_an_idle_one_is() {
    let _home = crate::store::temp_home();
    let now = 10 * 3_600_000;
    let host = free_host(|_| {});
    host.world().clock = now;
    let run = engine::create(&host, &flat_plan(2, "claude"), "lead", None).unwrap();
    engine::start(&host, &run.id).unwrap();
    let (building, idle) = (host.session_of("p1"), host.session_of("p2"));
    {
        let mut world = host.world();
        // A ten-minute build: its last tool call started 12 minutes ago and has not returned.
        world.activity.insert(building.clone(), Activity { last_ms: Some(now - 12 * 60_000), command_running: true, busy: false });
        // Nothing for 11 minutes, no command, agent idle.
        world.activity.insert(idle.clone(), Activity { last_ms: Some(now - 11 * 60_000), command_running: false, busy: false });
    }
    assert!(engine::watch(&host));
    let run = store::get(&run.id).unwrap();
    assert_eq!((run.piece("p1").unwrap().state, run.piece("p2").unwrap().state), (PieceState::Running, PieceState::Stalled));
    assert!(run.piece("p2").unwrap().note.as_deref().unwrap().contains("11 minutes"));
    let told = host.world().told.clone();
    assert_eq!(told.iter().filter(|said| said.contains("looks stalled")).count(), 1);
    assert!(told.last().unwrap().contains("p2") && told.last().unwrap().contains(&idle));
    // A stalled worker still holds its slot.
    assert_eq!(run.in_turn(), 2);
    // Told once, not at every watch.
    engine::watch(&host);
    assert_eq!(host.world().told.iter().filter(|said| said.contains("looks stalled")).count(), 1);
    // A refresh while it is still in its turn leaves it stalled.
    engine::refreshed(&host, &run.id).unwrap();
    assert_eq!(store::get(&run.id).unwrap().piece("p2").unwrap().state, PieceState::Stalled);

    // It moves again: running. An agent busy on the CPU is never stalled either.
    host.world().activity.insert(idle.clone(), Activity { last_ms: Some(now - 60_000), command_running: false, busy: false });
    engine::watch(&host);
    assert_eq!(store::get(&run.id).unwrap().piece("p2").unwrap().state, PieceState::Running);
    host.world().activity.insert(idle.clone(), Activity { last_ms: Some(now - 30 * 60_000), command_running: false, busy: true });
    engine::watch(&host);
    assert_eq!(store::get(&run.id).unwrap().piece("p2").unwrap().state, PieceState::Running);

    // The stall time is a setting.
    host.settings.lock().unwrap().stall_minutes = 40;
    host.world().activity.insert(idle.clone(), Activity { last_ms: Some(now - 30 * 60_000), command_running: false, busy: false });
    engine::watch(&host);
    assert_eq!(store::get(&run.id).unwrap().piece("p2").unwrap().state, PieceState::Running);
}

#[test]
fn a_person_can_change_one_runs_limits_and_a_bad_value_is_refused() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    let run = engine::create(&host, &flat_plan(3, "claude"), "lead", None).unwrap();
    assert_eq!(run.limits, RunLimits::default());
    let changed = engine::set_limits(&host, &run.id, RunLimits { workers: 1, dollars: 3.0, points: 10.0, ceiling: 70.0 }).unwrap();
    assert_eq!(changed.limits.workers, 1);
    assert_eq!(engine::set_limits(&host, &run.id, RunLimits { workers: 0, ..changed.limits.clone() }).unwrap_err().code, "invalid_limits");
    assert_eq!(engine::set_limits(&host, &run.id, RunLimits { ceiling: 120.0, ..changed.limits.clone() }).unwrap_err().code, "invalid_limits");
    // Approved, it holds to the person's limit of one.
    let approved = engine::approve(&host, &run.id).unwrap();
    assert_eq!(approved.started, vec!["p1"]);
    assert!(host.world().told.last().unwrap().contains("Queued for a free worker slot"));
}

#[test]
fn a_lead_may_ask_for_less_budget_than_the_settings_allow_never_more() {
    let _home = crate::store::temp_home();
    let host = Fake::new();
    let mut plan = flat_plan(1, "claude");
    plan.budget.points = Some(10.0);
    plan.budget.dollars = Some(500.0);
    let run = engine::create(&host, &plan, "lead", None).unwrap();
    assert_eq!((run.limits.points, run.limits.dollars), (10.0, 15.0));
}
