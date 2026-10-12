use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::*;

const PROMPT: &str = "Summarise what changed since yesterday";

fn run(id: &str) -> Run {
    Run {
        run_id: id.into(),
        name: "Daily summary".into(),
        agent: "claude".into(),
        model: Some("claude-opus".into()),
        effort: Some("high".into()),
        mode: Some("acceptEdits".into()),
        prompt: PROMPT.into(),
        max_run_minutes: 1,
    }
}

/// The server's side of §24.4: a run is handed out once, and a run that is
/// over answers a report as settled.
#[derive(Default)]
struct FakeApi {
    waiting: Mutex<VecDeque<Run>>,
    claims: AtomicUsize,
    /// The next claim takes the run on the server and loses the answer.
    lose_claim: AtomicBool,
    not_offered: AtomicBool,
    /// The credential is not accepted: `401` on a claim.
    rejected: AtomicBool,
    /// Reports are answered with a `404` that names no run, from the report after this many.
    reports_not_offered_after: Mutex<Option<usize>>,
    /// A server from before this failure category: a report naming it is refused like a malformed one.
    unknown_category: Mutex<Option<String>>,
    reports: Mutex<Vec<Report>>,
    fail_reports: AtomicUsize,
    reject_reports: AtomicBool,
    /// The run is over on the server from the report after this many.
    settled_after: Mutex<Option<usize>>,
}

impl FakeApi {
    fn with(runs: Vec<Run>) -> Arc<Self> {
        Arc::new(Self { waiting: Mutex::new(runs.into()), ..Self::default() })
    }

    fn reports(&self) -> Vec<(String, Option<String>)> {
        self.reports.lock().unwrap().iter().map(|report| (report.outcome.clone(), report.category.clone())).collect()
    }

    /// The reports that end a run.
    fn ends(&self) -> Vec<(String, Option<String>)> {
        self.reports().into_iter().filter(|(outcome, _)| outcome != "started").collect()
    }
}

impl ScheduledApi for FakeApi {
    fn claim(&self) -> Result<Claimed, CallError> {
        self.claims.fetch_add(1, Ordering::SeqCst);
        if self.rejected.load(Ordering::SeqCst) {
            return Ok(Claimed::Rejected);
        }
        if self.not_offered.load(Ordering::SeqCst) {
            return Ok(Claimed::NotOffered);
        }
        let run = self.waiting.lock().unwrap().pop_front();
        if self.lose_claim.swap(false, Ordering::SeqCst) {
            return Err(CallError::Transient(anyhow!("lost response")));
        }
        Ok(run.map_or(Claimed::None, |run| Claimed::Run(Box::new(run))))
    }

    fn report(&self, report: &Report) -> Result<Reported, CallError> {
        if self.reject_reports.load(Ordering::SeqCst) {
            return Err(CallError::Rejected);
        }
        if self.fail_reports.load(Ordering::SeqCst) > 0 {
            self.fail_reports.fetch_sub(1, Ordering::SeqCst);
            return Err(CallError::Transient(anyhow!("lost response")));
        }
        if report.category.is_some() && report.category == *self.unknown_category.lock().unwrap() {
            return Err(CallError::Rejected);
        }
        let mut reports = self.reports.lock().unwrap();
        if self.reports_not_offered_after.lock().unwrap().is_some_and(|after| reports.len() >= after) {
            return Ok(Reported::NotOffered);
        }
        if self.settled_after.lock().unwrap().is_some_and(|after| reports.len() >= after) {
            return Ok(Reported::Settled("canceled".into()));
        }
        reports.push(report.clone());
        Ok(Reported::Accepted)
    }
}

/// An agent whose turn goes through `script`, the last state for good.
struct FakeAgent {
    available: bool,
    sign_in_required: bool,
    start_fails: bool,
    script: Mutex<VecDeque<Turn>>,
    /// Whether an interrupt ends the turn; an agent that ignores it has to
    /// be stopped.
    obeys_interrupt: bool,
    started: Mutex<Vec<crate::session_ops::NewTab>>,
    interrupts: AtomicUsize,
    stops: AtomicUsize,
    ended: AtomicBool,
    /// The record on disk when the agent was started, and the runs held as
    /// work at each look at the turn.
    record: Mutex<Option<String>>,
    record_path: Mutex<Option<PathBuf>>,
    held: Arc<AtomicUsize>,
    held_seen: Mutex<Vec<(Turn, usize)>>,
    /// The turn is stopped at a permission request.
    awaiting_approval: AtomicBool,
    /// Someone who may answer it is attached.
    approver: Arc<AtomicBool>,
}

impl FakeAgent {
    fn new(script: &[Turn]) -> Self {
        Self {
            available: true,
            sign_in_required: false,
            start_fails: false,
            script: Mutex::new(script.iter().copied().collect()),
            obeys_interrupt: true,
            started: Mutex::default(),
            interrupts: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
            ended: AtomicBool::new(false),
            record: Mutex::default(),
            record_path: Mutex::default(),
            held: Arc::default(),
            held_seen: Mutex::default(),
            awaiting_approval: AtomicBool::new(false),
            approver: Arc::default(),
        }
    }
}

impl Agent for FakeAgent {
    fn available(&self, _agent: &str, _model: &str) -> bool {
        self.available
    }

    fn sign_in_required(&self, _agent: &str) -> bool {
        self.sign_in_required
    }

    fn start(&self, run: &Run, _title: &str) -> Result<(String, String), StartError> {
        if self.start_fails {
            return Err(StartError::NotStarted(anyhow!("no session")));
        }
        self.started.lock().unwrap().push(new_tab(run));
        *self.record.lock().unwrap() = self.record_path.lock().unwrap().as_ref().and_then(|path| std::fs::read_to_string(path).ok());
        Ok(("session-1".into(), "tab-1".into()))
    }

    fn turn(&self, _session_id: &str, _tab_id: &str) -> Turn {
        let turn = if self.ended.load(Ordering::SeqCst) {
            Turn::Ended(TurnStatus::Aborted)
        } else {
            let mut script = self.script.lock().unwrap();
            if script.len() > 1 { script.pop_front().unwrap() } else { script.front().copied().unwrap_or(Turn::Running) }
        };
        self.held_seen.lock().unwrap().push((turn, self.held.load(Ordering::SeqCst)));
        turn
    }

    fn awaiting_approval(&self, _session_id: &str, _tab_id: &str) -> bool {
        self.awaiting_approval.load(Ordering::SeqCst) && !self.ended.load(Ordering::SeqCst)
    }

    fn interrupt(&self, _session_id: &str, _tab_id: &str) {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
        if self.obeys_interrupt {
            self.ended.store(true, Ordering::SeqCst);
        }
    }

    fn stop(&self, _session_id: &str, _tab_id: &str) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.ended.store(true, Ordering::SeqCst);
    }
}

struct Held(Arc<AtomicUsize>);

impl Drop for Held {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Rig {
    dir: tempfile::TempDir,
    api: Arc<FakeApi>,
    agent: Arc<FakeAgent>,
    runner: Runner,
}

fn fast() -> Timing {
    let ms = Duration::from_millis;
    Timing { claim_every: ms(30_000), not_offered_every: ms(300_000), minute: ms(60_000), interrupt_grace: ms(40), start_grace: ms(60_000), heartbeat: ms(60_000), approval_grace: ms(60_000), tick: ms(2) }
}

fn rig_in(dir: tempfile::TempDir, api: Arc<FakeApi>, agent: FakeAgent, timing: Timing) -> Rig {
    let root = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let state = dir.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    *agent.record_path.lock().unwrap() = Some(state.join(FILE));
    let agent = Arc::new(agent);
    let held = agent.held.clone();
    let approver = agent.approver.clone();
    let runner = Runner {
        api: api.clone(),
        agent: agent.clone(),
        store: Store::open(&state),
        root,
        timing,
        paused: Arc::new(|| false),
        hold: Arc::new(move || {
            held.fetch_add(1, Ordering::SeqCst);
            Box::new(Held(held.clone()))
        }),
        approver: Arc::new(move || approver.load(Ordering::SeqCst)),
    };
    Rig { dir, api, agent, runner }
}

fn rig(runs: Vec<Run>, agent: FakeAgent) -> Rig {
    rig_in(tempfile::tempdir().unwrap(), FakeApi::with(runs), agent, fast())
}

fn end(outcome: &str, category: Option<&str>) -> (String, Option<String>) {
    (outcome.into(), category.map(String::from))
}

#[test]
fn a_run_is_started_reported_and_completed() {
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Pending, Turn::Running, Turn::Running, Turn::Ended(TurnStatus::Ok)]));
    assert_eq!(rig.runner.pass().unwrap(), Duration::ZERO, "the next run is asked for at once");
    let reports = rig.api.reports.lock().unwrap().clone();
    assert_eq!(rig.api.reports(), [end("started", None), end("completed", None)]);
    for report in &reports {
        assert_eq!((report.run_id.as_str(), report.session_id.as_deref(), report.tab_id.as_deref()), ("run_1", Some("session-1"), Some("tab-1")));
    }
    // Nothing to interrupt; the agent process is ended with the run, so a
    // workspace people keep up does not collect one idle CLI per run.
    assert_eq!((rig.agent.interrupts.load(Ordering::SeqCst), rig.agent.stops.load(Ordering::SeqCst)), (0, 1));
    assert!(rig.runner.store.get().is_none(), "nothing is owed once the end is reported");
    // Nothing more to run: wait for the next claim.
    assert_eq!(rig.runner.pass().unwrap(), fast().claim_every);
    assert_eq!(rig.agent.started.lock().unwrap().len(), 1);
}

#[test]
fn the_tab_gets_the_schedules_agent_model_effort_and_mode() {
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]));
    rig.runner.pass().unwrap();
    let started = rig.agent.started.lock().unwrap();
    let tab = &started[0];
    assert_eq!((tab.harness.as_str(), tab.model.as_str(), tab.effort.as_deref(), tab.permission_mode.as_deref()), ("claude", "claude-opus", Some("high"), Some("acceptEdits")));
}

#[test]
fn a_run_without_a_mode_or_in_bypass_permissions_never_starts_an_agent() {
    // A tab made with no mode runs in bypass permissions.
    assert_eq!(crate::store::index::permission_mode_or_default(None), "bypassPermissions");
    for mode in [None, Some(""), Some("bypassPermissions"), Some("yolo")] {
        let rig = rig(vec![Run { mode: mode.map(String::from), ..run("run_1") }], FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]));
        rig.runner.pass().unwrap();
        assert!(rig.agent.started.lock().unwrap().is_empty(), "{mode:?}");
        assert_eq!(rig.api.reports(), [end("failed", Some("runtime-error"))], "{mode:?}");
    }
    for mode in MODES {
        let rig = rig(vec![Run { mode: Some(mode.into()), ..run("run_1") }], FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]));
        rig.runner.pass().unwrap();
        assert_eq!(rig.agent.started.lock().unwrap()[0].permission_mode.as_deref(), Some(mode));
    }
}

#[test]
fn a_prompt_the_cli_would_run_as_a_command_is_not_sent() {
    for (prompt, category) in [("/model opus", "slash-command-forbidden"), ("/permissions", "slash-command-forbidden"), ("!rm -rf .", "shell-command-forbidden"), ("read @/etc/passwd", "file-mention-forbidden")] {
        let rig = rig(vec![Run { prompt: prompt.into(), ..run("run_1") }], FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]));
        rig.runner.pass().unwrap();
        assert!(rig.agent.started.lock().unwrap().is_empty(), "{prompt}");
        assert_eq!(rig.api.reports(), [end("failed", Some(category))], "{prompt}");
    }
}

#[test]
fn a_run_that_cannot_start_says_why_and_holds_nothing() {
    type Change = fn(&mut FakeAgent, &mut Run);
    let cases: [(&str, Change); 5] = [
        ("agent-unavailable", |agent, _| agent.available = false),
        ("agent-credential-required", |agent, _| agent.sign_in_required = true),
        ("agent-start-failed", |agent, _| agent.start_fails = true),
        ("runtime-error", |_, run| run.agent = "../bin/sh".into()),
        ("runtime-error", |_, run| run.prompt = "  ".into()),
    ];
    for (category, change) in cases {
        let mut agent = FakeAgent::new(&[Turn::Running]);
        let mut run = run("run_1");
        change(&mut agent, &mut run);
        let rig = rig(vec![run], agent);
        rig.runner.pass().unwrap();
        assert_eq!(rig.api.reports(), [end("failed", Some(category))]);
        assert_eq!(rig.agent.held.load(Ordering::SeqCst), 0, "{category}: not counted as work once it failed");
        assert!(rig.runner.store.get().is_none(), "{category}");
    }
}

#[test]
fn a_missing_project_folder_fails_the_run() {
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Running]));
    std::fs::remove_dir_all(&rig.runner.root).unwrap();
    rig.runner.pass().unwrap();
    assert!(rig.agent.started.lock().unwrap().is_empty());
    assert_eq!(rig.api.reports(), [end("failed", Some("project-unavailable"))]);
}

#[test]
fn how_a_turn_ends_is_what_is_reported() {
    let cases = [
        (Turn::Ended(TurnStatus::Error), "agent-failed"),
        (Turn::Ended(TurnStatus::Aborted), "canceled"),
        (Turn::Gone, "canceled"),
        (Turn::Exited, "agent-exited"),
    ];
    for (turn, category) in cases {
        let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Running, turn]));
        rig.runner.pass().unwrap();
        assert_eq!(rig.api.ends(), [end("failed", Some(category))], "{turn:?}");
        assert_eq!(rig.api.reports.lock().unwrap().last().unwrap().tab_id.as_deref(), Some("tab-1"));
    }
}

#[test]
fn a_turn_past_the_limit_is_interrupted_and_reported_timed_out() {
    let timing = Timing { minute: Duration::from_millis(30), ..fast() };
    let rig = rig_in(tempfile::tempdir().unwrap(), FakeApi::with(vec![run("run_1")]), FakeAgent::new(&[Turn::Running]), timing);
    let began = Instant::now();
    rig.runner.pass().unwrap();
    assert!(began.elapsed() >= Duration::from_millis(30), "not before the limit");
    assert_eq!(rig.api.ends(), [end("failed", Some("timed-out"))]);
    // The agent ended its turn when asked; its process is ended once, with the run.
    assert_eq!((rig.agent.interrupts.load(Ordering::SeqCst), rig.agent.stops.load(Ordering::SeqCst)), (1, 1));
    assert_eq!(rig.agent.held.load(Ordering::SeqCst), 0);
    assert!(rig.runner.store.get().is_none());
}

#[test]
fn an_agent_that_ignores_the_interrupt_is_stopped() {
    let timing = Timing { minute: Duration::from_millis(30), ..fast() };
    let agent = FakeAgent { obeys_interrupt: false, ..FakeAgent::new(&[Turn::Running]) };
    let rig = rig_in(tempfile::tempdir().unwrap(), FakeApi::with(vec![run("run_1")]), agent, timing.clone());
    let began = Instant::now();
    rig.runner.pass().unwrap();
    assert!(began.elapsed() >= timing.minute + timing.interrupt_grace, "the interrupt is given its grace first");
    assert_eq!((rig.agent.interrupts.load(Ordering::SeqCst), rig.agent.stops.load(Ordering::SeqCst)), (1, 1));
    assert_eq!(rig.api.ends(), [end("failed", Some("timed-out"))]);
}

#[test]
fn the_limit_counts_the_schedules_minutes() {
    let timing = Timing { minute: Duration::from_millis(40), ..fast() };
    let rig = rig_in(tempfile::tempdir().unwrap(), FakeApi::with(vec![Run { max_run_minutes: 3, ..run("run_1") }]), FakeAgent::new(&[Turn::Running]), timing);
    let began = Instant::now();
    rig.runner.pass().unwrap();
    assert!(began.elapsed() >= Duration::from_millis(120));
    assert_eq!(rig.api.ends(), [end("failed", Some("timed-out"))]);
}

#[test]
fn a_prompt_that_never_opens_a_turn_fails_the_run_and_stops_the_agent() {
    let timing = Timing { start_grace: Duration::from_millis(20), ..fast() };
    let rig = rig_in(tempfile::tempdir().unwrap(), FakeApi::with(vec![run("run_1")]), FakeAgent::new(&[Turn::Pending]), timing);
    rig.runner.pass().unwrap();
    assert_eq!(rig.api.ends(), [end("failed", Some("agent-start-failed"))]);
    assert_eq!(rig.agent.stops.load(Ordering::SeqCst), 1);
}

#[test]
fn a_run_the_server_ended_has_its_turn_ended_and_nothing_more_reported() {
    // The first report (`started`) is taken; the next one is answered `409`.
    let timing = Timing { heartbeat: Duration::from_millis(10), ..fast() };
    let api = FakeApi::with(vec![run("run_1")]);
    *api.settled_after.lock().unwrap() = Some(1);
    let rig = rig_in(tempfile::tempdir().unwrap(), api, FakeAgent::new(&[Turn::Running]), timing);
    rig.runner.pass().unwrap();
    assert_eq!(rig.api.reports(), [end("started", None)]);
    assert_eq!((rig.agent.interrupts.load(Ordering::SeqCst), rig.agent.stops.load(Ordering::SeqCst)), (1, 1));
    assert_eq!(rig.agent.held.load(Ordering::SeqCst), 0);
    assert!(rig.runner.store.get().is_none());
}

#[test]
fn a_run_counts_as_work_until_its_turn_runs_and_not_after() {
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Pending, Turn::Pending, Turn::Running, Turn::Running, Turn::Ended(TurnStatus::Ok)]));
    rig.runner.pass().unwrap();
    let seen = rig.agent.held_seen.lock().unwrap().clone();
    // Held while the prompt waits for its turn, so the idle monitor does not
    // stop the machine in between; the running turn is then counted by the
    // session manager like any other, and the hold is given up.
    assert_eq!(seen[..3], [(Turn::Pending, 1), (Turn::Pending, 1), (Turn::Running, 1)]);
    assert_eq!(seen[3..], [(Turn::Running, 0), (Turn::Ended(TurnStatus::Ok), 0)]);
    assert_eq!(rig.agent.held.load(Ordering::SeqCst), 0, "nothing keeps the machine up once the run is over");
}

#[test]
fn the_record_on_disk_names_the_run_and_never_holds_the_prompt() {
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]));
    rig.runner.pass().unwrap();
    let record = rig.agent.record.lock().unwrap().clone().expect("written before the agent is touched");
    assert_eq!(serde_json::from_str::<Value>(&record).unwrap(), json!({ "stage": "claimed", "runId": "run_1" }));
    assert!(!record.contains(PROMPT));
}

#[test]
fn a_claim_whose_answer_is_lost_starts_nothing() {
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Running]));
    rig.api.lose_claim.store(true, Ordering::SeqCst);
    assert!(rig.runner.pass().is_err());
    // The server handed the run out; asking again gets nothing.
    assert_eq!(rig.runner.pass().unwrap(), fast().claim_every);
    assert!(rig.agent.started.lock().unwrap().is_empty());
    assert!(rig.api.reports().is_empty());
}

/// A runtime that died with `record` on disk, started again.
fn restarted(record: Record, runs: Vec<Run>) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("state")).unwrap();
    Store::open(&dir.path().join("state")).put(&record).unwrap();
    rig_in(dir, FakeApi::with(runs), FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]), fast())
}

#[test]
fn a_restart_in_the_middle_of_a_run_fails_it_and_never_sends_the_prompt_again() {
    let rig = restarted(Record::Claimed { run_id: "run_1".into() }, Vec::new());
    rig.runner.pass().unwrap();
    assert_eq!(rig.api.reports(), [end("failed", Some("runtime-error"))]);
    assert!(rig.agent.started.lock().unwrap().is_empty());
    assert!(rig.runner.store.get().is_none());

    let rig = restarted(Record::Started { run_id: "run_1".into(), session_id: "session-9".into(), tab_id: "tab-9".into() }, Vec::new());
    rig.runner.pass().unwrap();
    let reports = rig.api.reports.lock().unwrap().clone();
    assert_eq!(reports, [failed("run_1", "runtime-error", Some(("session-9".into(), "tab-9".into())))]);
    assert!(rig.agent.started.lock().unwrap().is_empty());
}

#[test]
fn a_restart_reports_the_old_run_before_it_takes_the_next() {
    let rig = restarted(Record::Claimed { run_id: "run_1".into() }, vec![run("run_2")]);
    rig.runner.pass().unwrap();
    let reports = rig.api.reports.lock().unwrap().clone();
    let said: Vec<_> = reports.iter().map(|report| (report.run_id.as_str(), report.outcome.as_str())).collect();
    assert_eq!(said, [("run_1", "failed"), ("run_2", "started"), ("run_2", "completed")]);
    assert_eq!(rig.agent.started.lock().unwrap().len(), 1);
}

#[test]
fn an_end_that_could_not_be_reported_is_reported_by_a_later_pass() {
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]));
    // `started` and every try of `completed` are lost.
    rig.api.fail_reports.store(1 + REPORT_ATTEMPTS as usize, Ordering::SeqCst);
    rig.runner.pass().unwrap();
    assert!(rig.api.reports().is_empty());
    assert!(matches!(rig.runner.store.get(), Some(Record::Done { .. })));
    rig.runner.pass().unwrap();
    assert_eq!(rig.api.reports(), [end("completed", None)]);
    assert!(rig.runner.store.get().is_none());
    assert_eq!(rig.agent.started.lock().unwrap().len(), 1, "the prompt was sent once");
}

#[test]
fn a_server_without_scheduled_runs_is_asked_rarely_and_nothing_happens() {
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Running]));
    rig.api.not_offered.store(true, Ordering::SeqCst);
    assert_eq!(rig.runner.pass().unwrap(), fast().not_offered_every);
    assert!(rig.agent.started.lock().unwrap().is_empty());

    // A record owed to a server that does not accept the credential waits.
    let rig = restarted(Record::Claimed { run_id: "run_1".into() }, Vec::new());
    rig.api.not_offered.store(true, Ordering::SeqCst);
    rig.api.reject_reports.store(true, Ordering::SeqCst);
    assert_eq!(rig.runner.pass().unwrap(), fast().not_offered_every);
    assert!(rig.runner.store.get().is_some());
}

#[test]
fn a_turn_waiting_for_an_approval_nobody_can_give_is_ended_and_says_so() {
    // A limit of a minute; the wait for someone to turn up is far shorter.
    let timing = Timing { approval_grace: Duration::from_millis(40), ..fast() };
    let agent = FakeAgent::new(&[Turn::Running]);
    agent.awaiting_approval.store(true, Ordering::SeqCst);
    let rig = rig_in(tempfile::tempdir().unwrap(), FakeApi::with(vec![run("run_1")]), agent, timing.clone());
    let began = Instant::now();
    rig.runner.pass().unwrap();
    assert!(began.elapsed() >= timing.approval_grace, "someone opening the workspace is given time to connect");
    assert!(began.elapsed() < timing.minute, "not held until the limit");
    assert_eq!(rig.api.ends(), [end("failed", Some("needs-approval"))]);
    assert_eq!(rig.api.reports.lock().unwrap().last().unwrap().tab_id.as_deref(), Some("tab-1"));
    assert_eq!((rig.agent.interrupts.load(Ordering::SeqCst), rig.agent.stops.load(Ordering::SeqCst)), (1, 1));
    assert_eq!(rig.agent.held.load(Ordering::SeqCst), 0);
    assert!(rig.runner.store.get().is_none());
}

#[test]
fn a_turn_waiting_for_an_approval_is_left_alone_while_someone_who_can_give_it_is_attached() {
    let timing = Timing { approval_grace: Duration::from_millis(10), minute: Duration::from_millis(80), ..fast() };
    let agent = FakeAgent::new(&[Turn::Running]);
    agent.awaiting_approval.store(true, Ordering::SeqCst);
    agent.approver.store(true, Ordering::SeqCst);
    let rig = rig_in(tempfile::tempdir().unwrap(), FakeApi::with(vec![run("run_1")]), agent, timing);
    rig.runner.pass().unwrap();
    // It ran to its limit: the wait was a person's to end.
    assert_eq!(rig.api.ends(), [end("failed", Some("timed-out"))]);
}

#[test]
fn an_approval_that_is_answered_starts_the_wait_afresh() {
    // Asked, answered, asked again: neither wait reaches the grace, though
    // together they pass it.
    let timing = Timing { approval_grace: Duration::from_millis(60), minute: Duration::from_millis(200), ..fast() };
    let agent = FakeAgent::new(&[Turn::Running]);
    agent.awaiting_approval.store(true, Ordering::SeqCst);
    let rig = rig_in(tempfile::tempdir().unwrap(), FakeApi::with(vec![run("run_1")]), agent, timing);
    let agent = rig.agent.clone();
    let answers = std::thread::spawn(move || {
        for waiting in [false, true, false, true, false] {
            std::thread::sleep(Duration::from_millis(35));
            agent.awaiting_approval.store(waiting, Ordering::SeqCst);
        }
    });
    rig.runner.pass().unwrap();
    answers.join().unwrap();
    assert_eq!(rig.api.ends(), [end("failed", Some("timed-out"))]);
}

#[test]
fn a_server_from_before_needs_approval_is_told_the_turn_was_stopped() {
    let timing = Timing { approval_grace: Duration::from_millis(10), ..fast() };
    let agent = FakeAgent::new(&[Turn::Running]);
    agent.awaiting_approval.store(true, Ordering::SeqCst);
    let api = FakeApi::with(vec![run("run_1")]);
    *api.unknown_category.lock().unwrap() = Some("needs-approval".into());
    let rig = rig_in(tempfile::tempdir().unwrap(), api, agent, timing);
    rig.runner.pass().unwrap();
    assert_eq!(rig.api.ends(), [end("failed", Some("canceled"))]);
    assert!(rig.runner.store.get().is_none());
}

#[test]
fn scheduled_runs_turned_off_under_a_running_turn_do_not_end_it() {
    // `started` is taken; from then on every report is a `404` that names no run.
    let timing = Timing { heartbeat: Duration::from_millis(5), ..fast() };
    let api = FakeApi::with(vec![run("run_1")]);
    *api.reports_not_offered_after.lock().unwrap() = Some(1);
    let script: Vec<Turn> = std::iter::repeat_n(Turn::Running, 40).chain([Turn::Ended(TurnStatus::Ok)]).collect();
    let rig = rig_in(tempfile::tempdir().unwrap(), api, FakeAgent::new(&script), timing);
    rig.runner.pass().unwrap();
    // The turn ran to its own end, uninterrupted.
    assert_eq!(rig.agent.interrupts.load(Ordering::SeqCst), 0);
    assert!(rig.agent.held_seen.lock().unwrap().iter().any(|(turn, _)| *turn == Turn::Ended(TurnStatus::Ok)));
    // Its end waits on record for a server that takes reports again.
    assert!(matches!(rig.runner.store.get(), Some(Record::Done { report }) if report.outcome == "completed"));
    *rig.api.reports_not_offered_after.lock().unwrap() = None;
    rig.runner.pass().unwrap();
    assert_eq!(rig.api.reports(), [end("started", None), end("completed", None)]);
    assert!(rig.runner.store.get().is_none());
    assert_eq!(rig.agent.started.lock().unwrap().len(), 1);
}

#[test]
fn a_run_handed_out_twice_is_run_once() {
    let rig = rig(vec![run("run_1"), run("run_1")], FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]));
    rig.runner.pass().unwrap();
    rig.runner.pass().unwrap();
    assert_eq!(rig.agent.started.lock().unwrap().len(), 1, "the prompt was sent once");
    assert_eq!(rig.api.ends(), [end("completed", None), end("failed", Some("runtime-error"))]);
    // Also after a restart: the ids are on disk.
    let rig = rig_in(rig.dir, FakeApi::with(vec![run("run_1"), run("run_2")]), FakeAgent::new(&[Turn::Ended(TurnStatus::Ok)]), fast());
    rig.runner.pass().unwrap();
    assert!(rig.agent.started.lock().unwrap().is_empty());
    rig.runner.pass().unwrap();
    assert_eq!(rig.agent.started.lock().unwrap().len(), 1, "another run is taken as before");
    assert_eq!(rig.api.ends(), [end("failed", Some("runtime-error")), end("completed", None)]);
}

#[test]
fn a_credential_that_is_not_accepted_right_now_is_asked_about_again_soon() {
    // The workspace may have been woken for a run: not the five minutes of
    // a server without scheduled runs.
    let rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Running]));
    rig.api.rejected.store(true, Ordering::SeqCst);
    assert_eq!(rig.runner.pass().unwrap(), fast().claim_every);
    assert!(fast().claim_every < fast().not_offered_every);
    assert!(rig.agent.started.lock().unwrap().is_empty());
}

#[test]
fn a_runtime_about_to_be_archived_takes_no_run() {
    let mut rig = rig(vec![run("run_1")], FakeAgent::new(&[Turn::Running]));
    rig.runner.paused = Arc::new(|| true);
    assert_eq!(rig.runner.pass().unwrap(), fast().claim_every);
    assert_eq!(rig.api.claims.load(Ordering::SeqCst), 0);
    assert!(rig.dir.path().join("project").is_dir());
}

#[test]
fn a_claim_is_read_as_the_server_sends_it() {
    let sent = json!({
        "runId": "csr_1", "scheduleId": "csc_1", "name": "Nightly", "scheduledFor": 1_792_713_600_000u64,
        "agent": "codex", "mode": "manual", "prompt": "run the checks", "maxRunMinutes": 45,
    });
    let run: Run = serde_json::from_value(sent).unwrap();
    assert_eq!((run.run_id.as_str(), run.agent.as_str(), run.mode.as_deref(), run.max_run_minutes), ("csr_1", "codex", Some("manual"), 45));
    assert_eq!((run.model, run.effort), (None, None));
    // No mode is read as none, not as a default.
    let run: Run = serde_json::from_value(json!({ "runId": "csr_1", "agent": "claude", "prompt": "p", "maxRunMinutes": 5 })).unwrap();
    assert_eq!(run.mode, None);
}

#[test]
fn a_report_carries_only_what_the_server_accepts() {
    let keys = |report: &Report| {
        let mut keys: Vec<String> = serde_json::to_value(report).unwrap().as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(&failed("run_1", "timed-out", None)), ["category", "outcome", "runId"]);
    let started = Report { run_id: "run_1".into(), outcome: "started".into(), category: None, session_id: Some("s".into()), tab_id: Some("t".into()) };
    assert_eq!(keys(&started), ["outcome", "runId", "sessionId", "tabId"]);
    // The categories this runtime reports are ones the server lists (§24.4).
    let listed = [
        "agent-failed", "agent-exited", "agent-start-failed", "agent-credential-required", "agent-unavailable", "project-unavailable",
        "shell-command-forbidden", "slash-command-forbidden", "file-mention-forbidden", "timed-out", "canceled", "runtime-error",
    ];
    for category in [TIMED_OUT, CANCELED, RUNTIME_ERROR, AGENT_FAILED, AGENT_EXITED, AGENT_START_FAILED, AGENT_UNAVAILABLE, CREDENTIAL_REQUIRED, PROJECT_UNAVAILABLE] {
        assert!(listed.contains(&category), "{category}");
    }
    for category in [super::super::slash::SLASH_CATEGORY, super::super::slash::SHELL_CATEGORY, super::super::slash::MENTION_CATEGORY] {
        assert!(listed.contains(&category), "{category}");
    }
}

#[test]
fn a_long_schedule_name_is_a_short_title() {
    assert_eq!(title_of(&Run { name: "  Nightly checks\nsecond line".into(), ..run("r") }), "Nightly checks");
    assert_eq!(title_of(&Run { name: String::new(), ..run("r") }), "Scheduled task");
    assert_eq!(title_of(&Run { name: "x".repeat(200), ..run("r") }).chars().count(), 80);
}
