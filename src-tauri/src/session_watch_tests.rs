//! The session watcher against real panes and a real transcript (#203).
//!
//! Each tab here is a PTY-first Claude tab as the app runs one, less the CLI:
//! the pane runs a shell command that is busy, quiet or hung on cue, and the
//! transcript is the recorded `interactive_session.jsonl` written into the
//! file the tab tails, record by record. The poll thread that follows it is
//! the production one. Only the watcher's patience is shortened, so a
//! five-minute silence takes under a second.
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::recovery::Patience;

const STALL: Duration = Duration::from_millis(800);
const PATIENCE: Patience = Patience { stall: STALL, settle: Duration::from_millis(200) };
const SESSION: &str = "watched-session";
const TAB: &str = "watched-tab";
const FIXTURE: &str = include_str!("harness/claude/fixtures/interactive_session.jsonl");

/// The fixture's first turn: everything up to the record that says it ended,
/// and that record.
fn first_turn() -> (String, String) {
    let lines: Vec<&str> = FIXTURE.lines().collect();
    let end = lines.iter().position(|l| l.contains(r#""subtype":"turn_duration""#)).expect("the fixture records its turn's end");
    let body = lines[..end].iter().map(|l| format!("{l}\n")).collect();
    (body, format!("{}\n", lines[end]))
}

struct Rig {
    manager: SessionManager,
    rt: Arc<Mutex<TabRuntime>>,
    pane: String,
    token: String,
    dir: tempfile::TempDir,
    transcript: PathBuf,
    _home: store::TempHome,
}

impl Rig {
    /// A tab whose pane runs `script` (one command; the pane `exec`s it).
    fn new(script: &str) -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(256));
        // Through the constructor: the endpoint's fields are the hooks
        // module's business. Nothing here listens on it.
        let control = crate::hooks::prepare_control().unwrap();
        let manager = SessionManager::new(
            sink.clone(),
            Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()),
            Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            control,
        );
        let pane = format!("{SESSION}-{TAB}");
        let cwd = dir.path().to_str().unwrap().to_string();
        manager.terminals.spawn(sink, &pane, pty::PaneSpec { cwd: &cwd, cols: 80, rows: 24, command: Some(script), env: &[] }).unwrap();
        let transcript = dir.path().join("transcript.jsonl");
        std::fs::write(&transcript, "").unwrap();
        let tail = Arc::new(Self::tail(transcript.clone()));
        let token = crate::hooks::mint_token();
        let rt = Arc::new(Mutex::new(TabRuntime {
            session_id: SESSION.into(),
            tab_id: TAB.into(),
            harness: "claude".into(),
            seq: 0,
            status: TabStatus::Idle,
            child: None,
            child_pid: None,
            engine: Engine::Cli(CliTab {
                usage_account: None,
                harness: CliKind::Claude,
                mode: "default".into(),
                pane_id: pane.clone(),
                generation: 0,
                restart_when_idle: false,
                ready: Arc::new(tui::Ready::new(true)),
                tail: tail.clone(),
                echoed: Default::default(),
                decisions: HashMap::new(),
                turn_tail: Default::default(),
                transcript_turn: None,
                transcript_end_owed: false,
                answered: HashMap::new(),
                command: script.into(),
                origin: Origin { token: token.clone(), transcript_root: dir.path().to_path_buf() },
            }),
            pending: HashMap::new(),
            queued: Vec::new(),
            turn_open: false,
            turn_started_at: None,
            last_activity: Instant::now(),
            recovery: None,
            stalled_at: None,
            stopping: false,
            stop_in_flight: false,
            stopping_pid: None,
            log_path: dir.path().join("tab.jsonl"),
            me: std::sync::Weak::new(),
        }));
        rt.lock().unwrap().me = Arc::downgrade(&rt);
        manager.tabs.lock().unwrap().insert(key_of(SESSION, TAB), rt.clone());
        manager.follow_transcript(&rt, tail, pane.clone(), 0);
        Rig { manager, rt, pane, token, dir, transcript, _home: home }
    }

    fn tail(path: PathBuf) -> tui::Tail {
        tui::Tail::opening(path, claude::transcript::decode_line, Default::default()).marking(claude::transcript::decode_marked)
    }

    fn append(&self, records: &str) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&self.transcript).unwrap();
        file.write_all(records.as_bytes()).unwrap();
    }

    /// Wait for `done`, polling; the transcript is read on its own thread.
    fn until(&self, what: &str, done: impl Fn(&Rig) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !done(self) {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The prompt and the reply land in the transcript; the tab is working.
    fn start_turn(&self) {
        self.append(&first_turn().0);
        self.until("the turn to open", |r| {
            // Reading the log takes the tab's lock, so it is let go of first.
            let working = {
                let rt = r.rt.lock().unwrap();
                rt.turn_open && rt.status == TabStatus::InProgress
            };
            working && r.kinds().iter().any(|k| k == "assistant_text")
        });
    }

    /// The transcript records that the turn ended; no hook says so.
    fn end_turn_in_transcript(&self) {
        let before = std::fs::metadata(&self.transcript).unwrap().len();
        self.append(&first_turn().1);
        // The poll thread has consumed the record once the tail's cursor has
        // moved past it; nothing is published for it on its own.
        let size = before + first_turn().1.len() as u64;
        self.until("the tail to read the end record", |r| match &r.rt.lock().unwrap().engine {
            Engine::Cli(p) => p.tail.offset() >= size,
            _ => false,
        });
    }

    /// No hook, transcript or engine event for longer than the stall limit.
    fn events_go_quiet(&self) {
        let since = self.rt.lock().unwrap().last_activity;
        let wait = (STALL + Duration::from_millis(50)).saturating_sub(since.elapsed());
        std::thread::sleep(wait);
    }

    /// The pane's command is up and drawing. The pane starts it through a
    /// login shell, which on a busy machine can take longer than the whole
    /// shortened stall limit to get there.
    fn pane_is_drawing(&self) {
        self.until("the pane to draw", |r| r.manager.terminals.quiet_for(&r.pane).is_some_and(|q| q < Duration::from_millis(300)));
    }

    /// The pane has drawn nothing for longer than the stall limit.
    fn pane_goes_quiet(&self) {
        self.until("the pane to go quiet", |r| r.manager.terminals.quiet_for(&r.pane).is_none_or(|q| q >= STALL));
    }

    fn tick(&self) {
        self.manager.watch_tabs(PATIENCE);
    }

    fn status(&self) -> TabStatus {
        self.rt.lock().unwrap().status
    }

    fn recovery(&self) -> Option<RecoveryKind> {
        self.rt.lock().unwrap().recovery
    }

    fn events(&self) -> Vec<AgentEvent> {
        store::read_lines(&self.rt.lock().unwrap().log_path).unwrap()
    }

    fn kinds(&self) -> Vec<String> {
        self.events().iter().map(|e| serde_json::to_value(&e.payload).unwrap()["type"].as_str().unwrap_or("").to_string()).collect()
    }

    /// What the log says the banner is now, as a reload would restore it.
    fn banner(&self) -> Option<RecoveryKind> {
        self.events().iter().filter_map(|e| match &e.payload { Payload::Recovery { kind } => Some(*kind), _ => None }).next_back().flatten()
    }

    fn hook(&self, event: &str, payload: serde_json::Value) {
        self.manager.on_hook(HookFrame { tab: TAB.into(), session: SESSION.into(), token: self.token.clone(), event: event.into(), payload });
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.terminals.kill(&self.pane);
    }
}

/// A single step longer than the limit — a long build, a long generation —
/// with the terminal drawing throughout is work, not a stall.
#[test]
fn a_long_step_with_live_terminal_output_is_not_a_stall() {
    let rig = Rig::new("sh -c 'while :; do echo working; sleep 0.1; done'");
    rig.start_turn();
    rig.pane_is_drawing();
    rig.events_go_quiet();
    rig.tick();
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert!(!rig.kinds().iter().any(|k| k == "recovery"), "no banner was ever raised: {:?}", rig.kinds());
}

/// Nothing from the agent on any channel: the warning is still raised.
#[test]
fn a_hung_agent_with_no_output_and_no_events_still_raises_the_warning() {
    let rig = Rig::new("sleep 120");
    rig.start_turn();
    rig.pane_goes_quiet();
    rig.events_go_quiet();
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    assert_eq!(rig.status(), TabStatus::Waiting);
    assert_eq!(rig.banner(), Some(RecoveryKind::Timeout));
}

/// The hooks never arrived (#202), but the transcript recorded the end of
/// the turn: the turn is closed, and no warning is raised.
#[test]
fn a_turn_the_transcript_completed_is_closed_instead_of_warned_about() {
    let rig = Rig::new("sleep 120");
    rig.start_turn();
    rig.end_turn_in_transcript();
    rig.pane_goes_quiet();
    rig.events_go_quiet();
    rig.tick();
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(rig.banner(), None);
    assert_eq!(rig.kinds().iter().filter(|k| *k == "turn_completed").count(), 1);
    assert!(!rig.rt.lock().unwrap().turn_open);
}

/// A turn that ended in the transcript is still the hooks' to close while
/// they may be on their way: the watcher does not race a `Stop` hook.
#[test]
fn a_transcript_end_waits_out_the_hooks_before_the_watcher_closes_it() {
    let rig = Rig::new("sleep 120");
    rig.start_turn();
    rig.end_turn_in_transcript();
    rig.rt.lock().unwrap().last_activity = Instant::now();
    rig.tick();
    assert_eq!(rig.status(), TabStatus::InProgress, "closed before the Stop hook had its chance");
    rig.hook("Stop", json!({ "last_assistant_message": "pong" }));
    assert_eq!(rig.status(), TabStatus::Completed);
    std::thread::sleep(PATIENCE.settle + Duration::from_millis(50));
    rig.tick();
    assert_eq!(rig.kinds().iter().filter(|k| *k == "turn_completed").count(), 1, "one turn, closed once");
}

/// The warning was raised on a quiet pane; then the pane drew again. The
/// banner goes away and the tab is working again, without any hook.
#[test]
fn a_raised_warning_clears_itself_when_the_terminal_shows_progress() {
    let rig = Rig::new("sh -c 'while [ ! -f go ]; do sleep 0.05; done; while :; do echo working; sleep 0.1; done'");
    rig.start_turn();
    rig.pane_goes_quiet();
    rig.events_go_quiet();
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));

    std::fs::write(rig.dir.path().join("go"), "").unwrap();
    rig.pane_is_drawing();
    rig.tick();
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert_eq!(rig.banner(), None, "the log clears the banner too, so a reload does not bring it back");
}

/// The warning was raised; then the transcript recorded the end of the turn
/// and no hook ever came. The turn closes and the banner goes.
#[test]
fn a_raised_warning_clears_itself_when_the_transcript_completes_the_turn() {
    let rig = Rig::new("sleep 120");
    rig.start_turn();
    rig.pane_goes_quiet();
    rig.events_go_quiet();
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));

    rig.end_turn_in_transcript();
    std::thread::sleep(PATIENCE.settle + Duration::from_millis(50));
    rig.tick();
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(rig.banner(), None);
}

/// The warning was raised; then a late `Stop` hook closed the turn with no
/// transcript record in between. A completed turn is not left needing
/// attention.
#[test]
fn a_raised_warning_does_not_outlive_a_completed_turn() {
    let rig = Rig::new("sleep 120");
    rig.start_turn();
    rig.pane_goes_quiet();
    rig.events_go_quiet();
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));

    rig.hook("Stop", json!({ "last_assistant_message": "pong" }));
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(rig.banner(), None);
}

/// A provider that reported a timeout is a real failure, not the watcher's
/// guess: the terminal redrawing does not clear it.
#[test]
fn terminal_output_does_not_clear_a_timeout_the_provider_reported() {
    let rig = Rig::new("sh -c 'while :; do echo working; sleep 0.1; done'");
    rig.start_turn();
    rig.pane_is_drawing();
    {
        let mut rt = rig.rt.lock().unwrap();
        rig.manager.apply(&mut rt, Payload::Error { message: "request timed out".into(), fatal: false }, None);
    }
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    rig.events_go_quiet();
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    assert_eq!(rig.status(), TabStatus::Waiting);
}

fn completed_turns(rig: &Rig) -> usize {
    rig.kinds().iter().filter(|k| *k == "turn_completed").count()
}

fn transcript_turn(rig: &Rig) -> Option<tui::TurnMark> {
    match &rig.rt.lock().unwrap().engine {
        Engine::Cli(p) => p.transcript_turn,
        _ => None,
    }
}

/// A hook opens a turn without resetting the latch that keeps two closers
/// from racing; only a prompt does that. The transcript then records the end
/// and no `Stop` hook comes. The watcher used to ask the latch, be refused,
/// and skip the tab on every pass: "Working" for good, and never a warning.
#[test]
fn a_turn_a_hook_opened_is_closed_by_the_transcript_s_end_whatever_the_latch_says() {
    let rig = Rig::new("sleep 120");
    rig.hook("PreToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } }));
    assert!(rig.rt.lock().unwrap().turn_open);
    assert_eq!(rig.status(), TabStatus::InProgress);

    rig.end_turn_in_transcript();
    rig.pane_goes_quiet();
    rig.events_go_quiet();
    for _ in 0..3 {
        rig.tick();
    }
    assert!(!rig.rt.lock().unwrap().turn_open, "the turn is not left open with nothing to close it");
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(rig.recovery(), None);
    assert_eq!(completed_turns(&rig), 1, "closed once, however many passes see it");
}

/// The `Stop` hook closes a turn before the CLI writes that turn's
/// `turn_duration`. A prompt sent in between is already open when the record
/// is read, and the record is not that prompt's end.
#[test]
fn the_last_turn_s_late_end_record_does_not_close_the_turn_after_it() {
    let rig = Rig::new("sleep 120");
    rig.start_turn();
    rig.hook("Stop", json!({ "last_assistant_message": "pong" }));
    assert_eq!(rig.status(), TabStatus::Completed);
    rig.hook("UserPromptSubmit", json!({ "prompt": "and again" }));
    assert_eq!(rig.status(), TabStatus::InProgress);

    // The first turn's end, late.
    rig.end_turn_in_transcript();
    assert_eq!(transcript_turn(&rig), None, "not recorded against the turn that is open now");
    std::thread::sleep(PATIENCE.settle + Duration::from_millis(50));
    rig.tick();
    assert!(rig.rt.lock().unwrap().turn_open);
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert_eq!(completed_turns(&rig), 1);

    // The second turn's own end still closes it when no hook does.
    rig.end_turn_in_transcript();
    assert_eq!(transcript_turn(&rig), Some(tui::TurnMark::Ended));
    std::thread::sleep(PATIENCE.settle + Duration::from_millis(50));
    rig.tick();
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(completed_turns(&rig), 2);
}

/// A turn can stop being open without a boundary: a prompt that never
/// reached the CLI is taken back that way. An "ended" left over from it is
/// not the next turn's.
#[test]
fn opening_a_turn_forgets_what_the_transcript_said_about_the_one_before() {
    let rig = Rig::new("sleep 120");
    if let Engine::Cli(p) = &mut rig.rt.lock().unwrap().engine {
        p.transcript_turn = Some(tui::TurnMark::Ended);
    }
    rig.hook("PreToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } }));
    assert_eq!(transcript_turn(&rig), None);
    std::thread::sleep(PATIENCE.settle + Duration::from_millis(50));
    rig.tick();
    assert!(rig.rt.lock().unwrap().turn_open);
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert_eq!(completed_turns(&rig), 0);
}
