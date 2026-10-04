//! The session watcher against a real transcript (#203).
//!
//! Each tab here is a PTY-first Claude tab as the app runs one, less the CLI.
//! The transcript is the recorded `interactive_session.jsonl`, written into
//! the file the tab tails record by record.
//!
//! Nothing in these tests waits. The watcher takes the moment it judges from
//! and the time each pane last drew as arguments, so the rig keeps a clock of
//! its own that only moves when a test moves it, and reads the transcript on
//! the test's thread instead of leaving it to the poll thread. A five-minute
//! silence is `advance(PATIENCE.stall)`, and a machine too busy to schedule a
//! thread for a second changes nothing. The one test that runs a real pane
//! waits only for the pane to draw, never for an amount of time to pass.
use std::cell::Cell;
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::recovery::Patience;

const PATIENCE: Patience = Patience::DEFAULT;
/// The smallest step the rig's clock is moved by.
const MOMENT: Duration = Duration::from_millis(1);
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
    tail: Arc<tui::Tail>,
    pane: String,
    token: String,
    transcript: PathBuf,
    /// The rig's clock. Every event the rig causes is stamped with it, and
    /// every pass of the watcher judges from it.
    now: Cell<Instant>,
    /// When the pane last drew, by the rig's clock.
    drew: Cell<Option<Instant>>,
    _dir: tempfile::TempDir,
    _home: store::TempHome,
}

impl Rig {
    /// A tab with no pane process behind it: what its pane draws, and when,
    /// is the test's to say.
    fn new() -> Self {
        Self::of(CliKind::Claude, "")
    }

    /// A tab on either CLI, opened on a transcript that already holds
    /// `history`: a conversation the tab is resuming.
    fn of(kind: CliKind, history: &str) -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(256));
        // Through the constructor: the endpoint's fields are the hooks
        // module's business. Nothing here listens on it.
        let control = crate::hooks::prepare_control().unwrap();
        let manager = SessionManager::new(
            sink,
            Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()),
            Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            control,
        );
        let pane = format!("{SESSION}-{TAB}");
        let transcript = dir.path().join("transcript.jsonl");
        std::fs::write(&transcript, history).unwrap();
        let tail = Arc::new(match kind {
            CliKind::Claude => tui::Tail::opening(transcript.clone(), claude::transcript::decode_line, Default::default()).marking(claude::transcript::decode_marked),
            CliKind::Codex => tui::Tail::opening(transcript.clone(), codex::rollout::decode_line, Default::default()).marking(codex::rollout::decode_marked),
        });
        let token = crate::hooks::mint_token();
        let now = Instant::now();
        let rt = Arc::new(Mutex::new(TabRuntime {
            session_id: SESSION.into(),
            tab_id: TAB.into(),
            harness: match kind {
                CliKind::Claude => "claude".into(),
                CliKind::Codex => "codex".into(),
            },
            seq: 0,
            status: TabStatus::Idle,
            child: None,
            child_pid: None,
            engine: Engine::Cli(CliTab {
                usage_account: None,
                harness: kind,
                mode: "default".into(),
                pane_id: pane.clone(),
                generation: 0,
                restart_when_idle: false,
                ready: Arc::new(tui::Ready::new(kind == CliKind::Claude)),
                tail: tail.clone(),
                echoed: Default::default(),
                awaiting_delivery: None,
                decisions: HashMap::new(),
                turn_tail: Default::default(),
                transcript_turn: None,
                transcript_end_owed: false,
                answered: HashMap::new(),
                command: "claude".into(),
                origin: Origin { token: token.clone(), transcript_root: dir.path().to_path_buf(), conversation: None },
            }),
            pending: HashMap::new(),
            queued: Vec::new(),
            turn_open: false,
            turn_started_at: None,
            last_activity: now,
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
        // No `follow_transcript`: the poll thread would read the file
        // whenever it was next scheduled. `pump` is what it runs, and the rig
        // runs it itself, so a record is read exactly when a test appends it.
        Rig { manager, rt, tail, pane, token, transcript, now: Cell::new(now), drew: Cell::new(None), _dir: dir, _home: home }
    }

    /// Time passes, and nothing else happens.
    fn advance(&self, by: Duration) {
        self.now.set(self.now.get() + by);
    }

    /// The app stamps what it hears with the machine's clock. Put the rig's
    /// clock on it instead, so the test alone decides how long ago it was.
    fn stamp(&self) {
        self.rt.lock().unwrap().last_activity = self.now.get();
    }

    /// Records land in the transcript and the tab reads them, now.
    fn append(&self, records: &str) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&self.transcript).unwrap();
        file.write_all(records.as_bytes()).unwrap();
        drop(file);
        self.manager.pump(&self.rt, &self.tail);
        assert_eq!(self.tail.offset(), std::fs::metadata(&self.transcript).unwrap().len(), "the tab has read all of it");
        self.stamp();
    }

    /// The prompt and the reply land in the transcript; the tab is working.
    fn start_turn(&self) {
        self.append(&first_turn().0);
        assert!(self.rt.lock().unwrap().turn_open);
        assert_eq!(self.status(), TabStatus::InProgress);
        assert!(self.kinds().iter().any(|k| k == "assistant_text"));
    }

    /// The transcript records that the turn ended; no hook says so.
    fn end_turn_in_transcript(&self) {
        self.append(&first_turn().1);
    }

    /// The pane draws something, now.
    fn pane_draws(&self) {
        self.drew.set(Some(self.now.get()));
    }

    /// One pass of the watcher, at the rig's present moment.
    fn tick(&self) {
        self.manager.watch_tabs(PATIENCE, self.now.get(), |pane| {
            assert_eq!(pane, self.pane);
            self.drew.get()
        });
    }

    fn status(&self) -> TabStatus {
        self.rt.lock().unwrap().status
    }

    fn recovery(&self) -> Option<RecoveryKind> {
        self.rt.lock().unwrap().recovery
    }

    fn turn_open(&self) -> bool {
        self.rt.lock().unwrap().turn_open
    }

    fn transcript_turn(&self) -> Option<tui::TurnMark> {
        match &self.rt.lock().unwrap().engine {
            Engine::Cli(p) => p.transcript_turn,
            _ => None,
        }
    }

    fn events(&self) -> Vec<AgentEvent> {
        let path = self.rt.lock().unwrap().log_path.clone();
        store::read_lines(&path).unwrap()
    }

    fn kinds(&self) -> Vec<String> {
        self.events().iter().map(|e| serde_json::to_value(&e.payload).unwrap()["type"].as_str().unwrap_or("").to_string()).collect()
    }

    fn completed_turns(&self) -> usize {
        self.kinds().iter().filter(|k| *k == "turn_completed").count()
    }

    /// What the log says the banner is now, as a reload would restore it.
    fn banner(&self) -> Option<RecoveryKind> {
        self.events().iter().filter_map(|e| match &e.payload { Payload::Recovery { kind } => Some(*kind), _ => None }).next_back().flatten()
    }

    /// A hook frame from the tab's CLI, now.
    fn hook(&self, event: &str, payload: serde_json::Value) {
        self.manager.on_hook(HookFrame { tab: TAB.into(), session: SESSION.into(), token: self.token.clone(), event: event.into(), payload });
        self.stamp();
    }
}

/// A single step longer than the limit — a long build, a long generation —
/// with the terminal drawing throughout is work, not a stall.
#[test]
fn a_long_step_with_live_terminal_output_is_not_a_stall() {
    let rig = Rig::new();
    rig.start_turn();
    // No event for three times the limit, and the pane drawing all the while.
    for _ in 0..6 {
        rig.advance(PATIENCE.stall / 2);
        rig.pane_draws();
        rig.tick();
    }
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert!(!rig.kinds().iter().any(|k| k == "recovery"), "no banner was ever raised: {:?}", rig.kinds());

    // The pane stops too, and the limit is counted from when it did.
    rig.advance(PATIENCE.stall - MOMENT);
    rig.tick();
    assert_eq!(rig.recovery(), None);
    rig.advance(MOMENT);
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
}

/// Nothing from the agent on any channel: the warning is still raised, at
/// the limit and not before it.
#[test]
fn a_hung_agent_with_no_output_and_no_events_still_raises_the_warning() {
    let rig = Rig::new();
    rig.pane_draws();
    rig.start_turn();
    rig.advance(PATIENCE.stall - MOMENT);
    rig.tick();
    assert_eq!(rig.recovery(), None, "a moment short of the limit");
    assert_eq!(rig.status(), TabStatus::InProgress);

    rig.advance(MOMENT);
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    assert_eq!(rig.status(), TabStatus::Waiting);
    assert_eq!(rig.banner(), Some(RecoveryKind::Timeout));
}

/// A pane that has never drawn is judged on the events alone.
#[test]
fn a_pane_that_never_drew_does_not_hold_the_warning_back() {
    let rig = Rig::new();
    rig.start_turn();
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
}

/// The hooks never arrived (#202), but the transcript recorded the end of
/// the turn: the turn is closed, and no warning is raised.
#[test]
fn a_turn_the_transcript_completed_is_closed_instead_of_warned_about() {
    let rig = Rig::new();
    rig.start_turn();
    rig.end_turn_in_transcript();
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(rig.banner(), None);
    assert_eq!(rig.completed_turns(), 1);
    assert!(!rig.turn_open());
}

/// A turn that ended in the transcript is still the hooks' to close while
/// they may be on their way: the watcher does not race a `Stop` hook.
#[test]
fn a_transcript_end_waits_out_the_hooks_before_the_watcher_closes_it() {
    let rig = Rig::new();
    rig.start_turn();
    rig.end_turn_in_transcript();
    rig.advance(PATIENCE.settle - MOMENT);
    rig.tick();
    assert_eq!(rig.status(), TabStatus::InProgress, "closed before the Stop hook had its chance");
    rig.hook("Stop", json!({ "last_assistant_message": "pong" }));
    assert_eq!(rig.status(), TabStatus::Completed);
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert_eq!(rig.completed_turns(), 1, "one turn, closed once");
}

/// With no `Stop` hook at all, the watcher closes the turn once the hooks
/// have had their time, and not a moment sooner.
#[test]
fn a_transcript_end_is_acted_on_exactly_when_the_hooks_time_is_up() {
    let rig = Rig::new();
    rig.start_turn();
    rig.end_turn_in_transcript();
    rig.advance(PATIENCE.settle - MOMENT);
    rig.tick();
    assert!(rig.turn_open());
    rig.advance(MOMENT);
    rig.tick();
    assert!(!rig.turn_open());
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(rig.completed_turns(), 1);
}

/// The warning was raised on a quiet pane; then the pane drew again. The
/// banner goes away and the tab is working again, without any hook.
#[test]
fn a_raised_warning_clears_itself_when_the_terminal_shows_progress() {
    let rig = Rig::new();
    rig.pane_draws();
    rig.start_turn();
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));

    // Time alone does not take it back: what the pane drew before the
    // warning is not progress since.
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));

    rig.advance(MOMENT);
    rig.pane_draws();
    rig.tick();
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert_eq!(rig.banner(), None, "the log clears the banner too, so a reload does not bring it back");
}

/// The warning was raised; then the transcript recorded the end of the turn
/// and no hook ever came. The turn closes and the banner goes.
#[test]
fn a_raised_warning_clears_itself_when_the_transcript_completes_the_turn() {
    let rig = Rig::new();
    rig.start_turn();
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));

    rig.end_turn_in_transcript();
    rig.advance(PATIENCE.settle);
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
    let rig = Rig::new();
    rig.start_turn();
    rig.advance(PATIENCE.stall);
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
    let rig = Rig::new();
    rig.start_turn();
    rig.pane_draws();
    {
        let mut rt = rig.rt.lock().unwrap();
        rig.manager.apply(&mut rt, Payload::Error { message: "request timed out".into(), fatal: false }, None);
    }
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    for _ in 0..3 {
        rig.advance(PATIENCE.stall);
        rig.pane_draws();
        rig.tick();
    }
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    assert_eq!(rig.status(), TabStatus::Waiting);
}

/// A hook opens a turn without resetting the latch that keeps two closers
/// from racing; only a prompt does that. The transcript then records the end
/// and no `Stop` hook comes. The watcher used to ask the latch, be refused,
/// and skip the tab on every pass: "Working" for good, and never a warning.
#[test]
fn a_turn_a_hook_opened_is_closed_by_the_transcript_s_end_whatever_the_latch_says() {
    let rig = Rig::new();
    rig.hook("PreToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } }));
    assert!(rig.turn_open());
    assert_eq!(rig.status(), TabStatus::InProgress);

    rig.end_turn_in_transcript();
    rig.advance(PATIENCE.stall);
    for _ in 0..3 {
        rig.tick();
    }
    assert!(!rig.turn_open(), "the turn is not left open with nothing to close it");
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.completed_turns(), 1, "closed once, however many passes see it");
}

/// The `Stop` hook closes a turn before the CLI writes that turn's
/// `turn_duration`. A prompt sent in between is already open when the record
/// is read, and the record is not that prompt's end.
#[test]
fn the_last_turn_s_late_end_record_does_not_close_the_turn_after_it() {
    let rig = Rig::new();
    rig.start_turn();
    rig.hook("Stop", json!({ "last_assistant_message": "pong" }));
    assert_eq!(rig.status(), TabStatus::Completed);
    rig.hook("UserPromptSubmit", json!({ "prompt": "and again" }));
    assert_eq!(rig.status(), TabStatus::InProgress);

    // The first turn's end, late.
    rig.end_turn_in_transcript();
    assert_eq!(rig.transcript_turn(), None, "not recorded against the turn that is open now");
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert!(rig.turn_open());
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert_eq!(rig.completed_turns(), 1);

    // The second turn's own end still closes it when no hook does.
    rig.end_turn_in_transcript();
    assert_eq!(rig.transcript_turn(), Some(tui::TurnMark::Ended));
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert_eq!(rig.status(), TabStatus::Completed);
    assert_eq!(rig.completed_turns(), 2);
}

/// A turn can stop being open without a boundary: a prompt that never
/// reached the CLI is taken back that way. An "ended" left over from it is
/// not the next turn's.
#[test]
fn opening_a_turn_forgets_what_the_transcript_said_about_the_one_before() {
    let rig = Rig::new();
    if let Engine::Cli(p) = &mut rig.rt.lock().unwrap().engine {
        p.transcript_turn = Some(tui::TurnMark::Ended);
    }
    rig.hook("PreToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } }));
    assert_eq!(rig.transcript_turn(), None);
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert!(rig.turn_open());
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert_eq!(rig.completed_turns(), 0);
}

/// The one thing the rig's own pane cannot show: that what the watcher is
/// told about a pane in the app is what a real pane does. A pane that draws
/// reports when, and the watcher, judging from that moment, sees a tab at
/// work however long its events have been silent.
///
/// This waits for the pane to draw and for nothing else: it blocks on the
/// pane's own output event. The moment the watcher judges from is taken from
/// what the pane reported, so how long the machine took to get there does
/// not enter into it.
#[test]
fn what_a_real_pane_draws_is_what_holds_the_warning_back() {
    let rig = Rig::new();
    rig.start_turn();
    let silent_since = rig.rt.lock().unwrap().last_activity;

    let dir = tempfile::tempdir().unwrap();
    let sink = Arc::new(crate::sink::BroadcastSink::new(256));
    let (sent, drawn) = std::sync::mpsc::channel::<()>();
    let sent = Mutex::new(sent);
    sink.listen("pty_data", Box::new(move |_| { let _ = sent.lock().unwrap().send(()); }));
    assert_eq!(rig.manager.terminals.last_output(&rig.pane), None, "no pane yet");
    let spec = pty::PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some("sh -c 'while :; do echo working; sleep 0.1; done'"), env: &[] };
    rig.manager.terminals.spawn(sink, &rig.pane, spec).unwrap();
    drawn.recv_timeout(Duration::from_secs(300)).expect("the pane never drew");
    // Stamped before the event was sent, and after the turn's last event:
    // the pane did not exist until then.
    let drew = rig.manager.terminals.last_output(&rig.pane).expect("a pane that has drawn says when");
    assert!(drew > silent_since);

    // Events silent for the whole limit at least, and the pane's last
    // drawing at or after `drew`, which is after the silence began: so less
    // than the limit ago, whenever the pane next draws.
    let now = drew.max(silent_since + PATIENCE.stall);
    rig.manager.watch_tabs(PATIENCE, now, |pane| rig.manager.terminals.last_output(pane));
    assert_eq!(rig.recovery(), None);
    assert_eq!(rig.status(), TabStatus::InProgress);

    // The same moment with the pane left out of it is a stall.
    rig.manager.watch_tabs(PATIENCE, now, |_| None);
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
}

/// What a prompt typed into the terminal, and one sent from the composer,
/// each leave in the chat (#250). The same rig, on either CLI.
#[path = "session_prompt_tests.rs"]
mod prompts;

impl Drop for Rig {
    fn drop(&mut self) {
        // Only one test gives the tab a real pane; for the rest this is a
        // pane that was never there.
        self.manager.terminals.kill(&self.pane);
    }
}
