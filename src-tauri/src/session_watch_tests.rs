//! The session watcher against a real transcript (#203).
//!
//! Each tab here is a PTY-first Claude tab as the app runs one, less the CLI.
//! The transcript is the recorded `interactive_session.jsonl`, written into
//! the file the tab tails record by record.
//!
//! No test waits for a watcher deadline. The watcher takes the moment it judges from
//! and the time each pane last drew as arguments, so the rig keeps a clock of
//! its own that only moves when a test moves it, and reads the transcript on
//! the test's thread instead of leaving it to the poll thread. A five-minute
//! silence is `advance(PATIENCE.stall)`, and a machine too busy to schedule a
//! thread for a second changes nothing. Tests of a real pane or settings
//! restart wait for their events, never for an amount of time to pass.
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

#[derive(Default)]
struct Observer {
    rt: Mutex<std::sync::Weak<Mutex<TabRuntime>>>,
    completed: Mutex<Vec<(String, String, Option<String>)>>,
    interrupts: std::sync::atomic::AtomicUsize,
}

impl SessionObserver for Observer {
    fn interrupted(&self, _key: &str) {
        self.interrupts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    fn automation_completed(&self, session: &str, tab: &str, message: Option<String>) {
        let rt = self.rt.lock().unwrap().upgrade().unwrap();
        // Another thread may hold the lock for a moment, as the input thread a
        // typed `/effort` starts does. Only the caller holding it never lets go.
        let deadline = Instant::now() + Duration::from_secs(10);
        let rt = loop {
            match rt.try_lock() {
                Ok(rt) => break rt,
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(MOMENT),
                Err(_) => panic!("completion must release the tab lock before calling the observer"),
            }
        };
        if let Engine::Cli(p) = &rt.engine {
            assert!(p.answered.is_empty(), "the turn's tool answers must be forgotten before notifying the observer");
        }
        self.completed.lock().unwrap().push((session.into(), tab.into(), message));
    }
}

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
    observer: Arc<Observer>,
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

#[test]
fn sharing_blocks_bypass_before_changing_the_saved_tab_or_runtime() {
    let rig = Rig::new();
    let entry: index::SessionEntry = serde_json::from_value(json!({
        "id": SESSION, "projectPath": rig._dir.path(), "cwd": rig._dir.path(),
        "title": "shared", "created": index::now(), "modified": index::now(),
        "tabs": [{ "id": TAB, "harness": "claude", "permissionMode": "default", "created": index::now() }]
    })).unwrap();
    index::save(&[entry]).unwrap();
    rig.manager.sharing.lock().unwrap().sessions.insert(SESSION.into(),
        crate::local_sharing::Share::new("host".into(), "".into(), String::new()));
    assert!(rig.manager.set_permission_mode(SESSION, TAB, "bypassPermissions").is_err());
    assert_eq!(index::get(SESSION).unwrap().tab(TAB).unwrap().permission_mode, "default");
    let rt = rig.rt.lock().unwrap();
    assert!(matches!(&rt.engine, Engine::Cli(p) if p.mode == "default"));
}

#[test]
fn a_shared_session_takes_no_new_bypass_tab_and_an_unshared_one_still_does() {
    let rig = Rig::new();
    let entry: index::SessionEntry = serde_json::from_value(json!({
        "id": SESSION, "projectPath": rig._dir.path(), "cwd": rig._dir.path(),
        "title": "shared", "created": index::now(), "modified": index::now(),
        "tabs": [{ "id": TAB, "harness": "claude", "permissionMode": "default", "created": index::now() }]
    })).unwrap();
    index::save(&[entry]).unwrap();
    let tab = |mode: &str| crate::session_ops::NewTab { harness: "claude".into(), model: String::new(), effort: None, permission_mode: Some(mode.into()) };
    rig.manager.sharing.lock().unwrap().sessions.insert(SESSION.into(),
        crate::local_sharing::Share::new("host".into(), "".into(), String::new()));
    assert!(rig.manager.add_tab(SESSION, &tab("bypassPermissions")).is_err());
    assert_eq!(index::get(SESSION).unwrap().tabs.len(), 1);
    assert_eq!(rig.manager.add_tab(SESSION, &tab("plan")).unwrap().permission_mode, "plan");
    rig.manager.sharing.lock().unwrap().sessions.clear();
    assert_eq!(rig.manager.add_tab(SESSION, &tab("bypassPermissions")).unwrap().permission_mode, "bypassPermissions");
}

impl Rig {
    /// A tab with no pane process behind it: what its pane draws, and when,
    /// is the test's to say.
    fn new() -> Self {
        Self::of(CliKind::Claude, "")
    }

    fn with_live_pane() -> Self {
        let rig = Self::new();
        let sink = Arc::new(crate::sink::BroadcastSink::new(256));
        let spec = pty::PaneSpec {
            cwd: rig._dir.path().to_str().unwrap(), cols: 80, rows: 24,
            command: Some("sh -c 'read line'"), env: &[],
        };
        rig.manager.terminals.spawn(sink, &rig.pane, spec).unwrap();
        rig
    }

    fn counts(&self) -> (usize, usize) {
        self.manager.turn_counts_at(self.now.get())
    }

    /// A tab on either CLI, opened on a transcript that already holds
    /// `history`: a conversation the tab is resuming.
    fn of(kind: CliKind, history: &str) -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(256));
        let observer = Arc::new(Observer::default());
        // Through the constructor: the endpoint's fields are the hooks
        // module's business. Nothing here listens on it.
        let control = crate::hooks::prepare_control().unwrap();
        let manager = SessionManager::new(
            sink,
            observer.clone(),
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
            source_timestamp: None,
            message_times: HashMap::new(),
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
                settings_asked_at: None,
                launched_for: None,
                status_names_model: false,
                settings_command_is_ours: false,
                ready: Arc::new(tui::Ready::new(kind == CliKind::Claude)),
                tail: tail.clone(),
                echoed: Default::default(),
                awaiting_delivery: None,
                delivery_sent_at: None,
                accept_by: None,
                nudge_by: None,
                held: Vec::new(),
                resend_after_abort: None,
                codex_interrupt_hooks_owed: 0,
                codex_prompt_starts_turn: false,
                decisions: HashMap::new(),
                turn_tail: Default::default(),
                transcript_turn: None,
                transcript_end_owed: false,
                answered: HashMap::new(),
                command: "claude".into(),
                origin: Origin { token: token.clone(), transcript_root: dir.path().to_path_buf(), conversation: None },
                by_hand: None,
            }),
            pending: HashMap::new(),
            queued: Vec::new(),
            turn_open: false,
            turn_opener: None,
            compact_completed: false,
            compact_boundary_at: None,
            turn_started_at: None,
            turn_by_command: false,
            last_activity: now,
            recovery: None,
            stalled_at: None,
            last_settings_report: None,
            reported_mode_to_judge: None,
            restart_claim: None,
            stopping: false,
            stop_in_flight: false,
            stopping_pid: None,
            left_at: None,
            log_path: dir.path().join("tab.jsonl"),
            me: std::sync::Weak::new(),
        }));
        rt.lock().unwrap().me = Arc::downgrade(&rt);
        *observer.rt.lock().unwrap() = Arc::downgrade(&rt);
        manager.tabs.lock().unwrap().insert(key_of(SESSION, TAB), rt.clone());
        // No `follow_transcript`: the poll thread would read the file
        // whenever it was next scheduled. `pump` is what it runs, and the rig
        // runs it itself, so a record is read exactly when a test appends it.
        Rig { manager, observer, rt, tail, pane, token, transcript, now: Cell::new(now), drew: Cell::new(None), _dir: dir, _home: home }
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

#[test]
fn codex_pretool_reports_acknowledge_without_overriding_the_provider_policy() {
    for mode in ["bypassPermissions", "auto", "plan"] {
        let rig = Rig::in_mode(CliKind::Codex, mode);
        let reply = rig.manager.on_hook(HookFrame {
            session: SESSION.into(), tab: TAB.into(), token: rig.token.clone(),
            event: "PreToolUse".into(),
            payload: json!({"tool_name":"shell", "tool_input":{"command":"pwd"}}),
        });
        assert_eq!(reply.output, Some(json!({})), "{mode}: the local-owner bridge needs an explicit acknowledgement, not a missing reply");
        assert!(reply.refused.is_none());
        assert!(rig.rt.lock().unwrap().pending.is_empty());
        assert_eq!(rig.launch_mode().as_deref(), Some(mode));
    }
}

#[test]
fn a_pretool_report_from_a_replaced_launch_is_not_acknowledged() {
    let rig = Rig::in_mode(CliKind::Codex, "bypassPermissions");
    let reply = rig.manager.on_hook_pumping(HookFrame {
        session: SESSION.into(), tab: TAB.into(), token: rig.token.clone(),
        event: "PreToolUse".into(), payload: json!({"tool_name":"shell", "tool_input":{"command":"pwd"}}),
    }, |rt, _| {
        let mut rt = rt.lock().unwrap();
        let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
        p.origin.token = crate::hooks::mint_token();
    });
    assert!(reply.output.is_none(), "a stale launch must still fail closed at the owner bridge");
}

/// A send opens the turn before the input thread types anything. Silence
/// before that send must not make the new turn look stalled (#237).
#[test]
fn a_prompt_sent_to_an_idle_cli_counts_as_activity_before_the_pane_draws() {
    for kind in [CliKind::Claude, CliKind::Codex] {
        let rig = Rig::of(kind, "");
        let old = Instant::now() - PATIENCE.stall - MOMENT;
        rig.rt.lock().unwrap().last_activity = old;
        rig.drew.set(Some(old));
        let prompt = PromptText { mobile: None, shared_connection: None, author: None, agent: "hello".into(), display: "hello".into() };
        // The production send path, up to dispatching the input thread. Do
        // not use `stamp`: the send itself must refresh the activity clock.
        let (_, queued) = rig.manager.record_composer_prompt(&mut rig.rt.lock().unwrap(), &prompt, vec![], rig._dir.path().to_str().unwrap(), None);
        assert!(!queued);
        rig.now.set(Instant::now());
        rig.tick();
        assert!(rig.turn_open());
        assert_eq!(rig.status(), TabStatus::InProgress, "{kind:?}: a just-sent prompt is not stalled");
        assert_eq!(rig.recovery(), None);

        let sent_at = rig.rt.lock().unwrap().last_activity;
        rig.now.set(sent_at + PATIENCE.stall - MOMENT);
        rig.tick();
        assert_eq!(rig.status(), TabStatus::InProgress);
        assert_eq!(rig.recovery(), None);
        assert!(!rig.kinds().iter().any(|k| k == "recovery"));

        // If nothing ever confirms the send, its own silence still times out.
        rig.advance(MOMENT);
        rig.tick();
        assert_eq!(rig.recovery(), Some(RecoveryKind::DeliveryUnconfirmed));
    }
}

#[test]
fn the_watcher_completes_an_automation_with_the_last_assistant_message_once() {
    let rig = Rig::new();
    // Both turns in the recorded conversation, so the saved reply must be
    // the last one ("second"), not the first assistant message ("pong").
    rig.append(FIXTURE);
    assert!(rig.observer.completed.lock().unwrap().is_empty());
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert_eq!(*rig.observer.completed.lock().unwrap(), [(SESSION.to_string(), TAB.to_string(), Some("second".to_string()))]);
    assert_eq!(rig.status(), TabStatus::Completed);
    assert!(!rig.turn_open());
    assert_eq!(rig.completed_turns(), 1);
    let events = rig.events();
    assert_eq!(events.iter().filter(|e| matches!(&e.payload, Payload::AssistantText { text, .. } if text == "second")).count(), 1);
    assert!(events.iter().any(|e| matches!(&e.payload, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, .. })));

    rig.tick();
    rig.hook("Stop", json!({ "last_assistant_message": "second" }));
    assert_eq!(rig.completed_turns(), 1);
    assert_eq!(rig.observer.completed.lock().unwrap().len(), 1, "a late hook must not complete the automation again");
}

#[test]
fn the_watcher_can_complete_a_turn_without_an_assistant_message() {
    let rig = Rig::new();
    rig.hook("UserPromptSubmit", json!({ "prompt": "hello" }));
    rig.end_turn_in_transcript();
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert!(!rig.turn_open());
    assert_eq!(*rig.observer.completed.lock().unwrap(), [(SESSION.to_string(), TAB.to_string(), None)]);
}

#[test]
fn a_stop_hook_still_notifies_automation_when_only_a_hook_opened_the_turn() {
    let rig = Rig::new();
    // Without the prompt's transcript record the close latch is still shut.
    // Preserve Stop's notification even when that latch defers the boundary.
    rig.hook("UserPromptSubmit", json!({ "prompt": "hello" }));
    rig.hook("Stop", json!({}));
    assert_eq!(*rig.observer.completed.lock().unwrap(), [(SESSION.to_string(), TAB.to_string(), None)]);
}

#[test]
fn the_watcher_forgets_tool_answers_for_the_completed_turn() {
    let rig = Rig::of(CliKind::Codex, "");
    rig.append(include_str!("harness/codex/fixtures/rollout.jsonl"));
    {
        let mut rt = rig.rt.lock().unwrap();
        let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
        p.answered.insert(tool_key("Bash", &json!({ "command": "ls" })), true);
        p.answered.insert(tool_key("Bash", &json!({ "command": "rm file" })), false);
    }
    assert!(rig.turn_open());
    assert_eq!(rig.transcript_turn(), Some(tui::TurnMark::Ended));
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert!(!rig.turn_open());
    let rt = rig.rt.lock().unwrap();
    let Engine::Cli(p) = &rt.engine else { unreachable!() };
    assert!(p.answered.is_empty(), "neither allowed nor denied answers carry into the next turn");
}

#[test]
fn the_watcher_runs_a_pending_settings_restart_after_closing_the_turn() {
    let rig = Rig::new();
    let entry: index::SessionEntry = serde_json::from_value(json!({
        "id": SESSION, "projectPath": rig._dir.path(), "cwd": rig._dir.path(),
        "title": "watched", "created": index::now(), "modified": index::now(),
        "tabs": [{ "id": TAB, "harness": "claude", "created": index::now() }]
    })).unwrap();
    index::save(&[entry]).unwrap();
    rig.start_turn();
    {
        let mut rt = rig.rt.lock().unwrap();
        let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
        p.restart_when_idle = true;
    }
    let (sent, restarted) = std::sync::mpsc::channel();
    let shutting_down = rig.manager.shutting_down.clone();
    rig.manager.sink.listen("tab_status", Box::new(move |payload| {
        let event: serde_json::Value = serde_json::from_str(payload).unwrap();
        if event["status"] == "idle" {
            // Exercise the actual idle restart through releasing the CLI, then
            // refuse startup through the shutdown gate. Marking the tab as
            // already stopping would correctly cancel the idle dispatch itself.
            shutting_down.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = sent.send(());
        }
    }));
    rig.end_turn_in_transcript();
    rig.advance(PATIENCE.settle - MOMENT);
    rig.tick();
    assert!(rig.turn_open());
    assert!(restarted.try_recv().is_err(), "the pending restart must wait for the turn");
    rig.advance(MOMENT);
    rig.tick();
    restarted.recv_timeout(Duration::from_secs(10)).expect("the watcher never ran the settings restart");
    let rt = rig.rt.lock().unwrap();
    assert!(matches!(rt.engine, Engine::None), "the restart released the old CLI");
    assert!(!rt.turn_open);
    assert_eq!(rt.status, TabStatus::Idle);
    assert_eq!(rig.observer.completed.lock().unwrap().len(), 1);
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

/// Synthetic Claude records exercise the actual tail, decoder, session pump and
/// watcher. No provider process, real transcript or five-minute wait is needed.
fn compact_records(trigger: &str) -> String {
    format!("{}\n{}\n", json!({
        "type": "system", "subtype": "compact_boundary", "uuid": "compact-boundary",
        "timestamp": "2026-10-20T11:59:59.000Z",
        "compactMetadata": { "trigger": trigger, "preTokens": 1000, "postTokens": 100 }
    }), json!({
        "type": "user", "uuid": "compact-summary", "isCompactSummary": true,
        "isVisibleInTranscriptOnly": true,
        "timestamp": "2026-10-20T12:00:00.000Z",
        "message": { "role": "user", "content": "PRIVATE SYNTHETIC SUMMARY" }
    }))
}

fn compact_prompt() -> String {
    format!("{}\n", json!({ "type": "user", "uuid": "compact-command",
        "timestamp": "2026-10-20T11:59:58.000Z",
        "message": { "role": "user", "content": "<command-name>/compact</command-name><command-args></command-args>" }
    }))
}

#[test]
fn completed_compaction_never_becomes_a_stall() {
    for scenario in ["manual", "automatic", "idle", "never_started"] {
        // Exercise both one tail read and separate reads around the summary.
        for split in [false, true] {
            let rig = Rig::new();
            if matches!(scenario, "manual" | "idle") {
                rig.start_turn();
                rig.end_turn_in_transcript();
                rig.advance(PATIENCE.settle);
                rig.tick();
            }
            let records = compact_records(if scenario == "manual" { "manual" } else { "auto" });
            if scenario == "manual" {
                rig.append(&compact_prompt());
                if split {
                    rig.append(&records);
                    // Claude writes the command again after its summary.
                    rig.append(&compact_prompt().replace("compact-command", "compact-command-repeated"));
                } else {
                    rig.append(&(records + &compact_prompt().replace("compact-command", "compact-command-repeated")));
                }
            } else {
                if scenario == "automatic" {
                    rig.start_turn();
                }
                rig.append(&records);
                if scenario == "automatic" {
                    rig.end_turn_in_transcript();
                }
            }
            rig.advance(PATIENCE.stall + MOMENT);
            rig.tick();
            assert!(!rig.turn_open(), "{scenario}, split={split}");
            assert_ne!(rig.status(), TabStatus::InProgress, "{scenario}");
            assert_eq!(rig.recovery(), None, "{scenario}");
            assert_eq!(rig.banner(), None, "{scenario}");
            let summary = rig.events().into_iter().find(|e| matches!(e.payload, Payload::CompactionSummary { .. })).unwrap();
            assert_eq!(summary.ts, "2026-10-20T12:00:00.000Z");
        }
    }
}

#[test]
fn compaction_does_not_hide_a_real_hung_turn() {
    for manual in [false, true] {
        let rig = Rig::new();
        rig.start_turn();
        if manual { rig.append(&compact_prompt()); }
        rig.append(&compact_records(if manual { "manual" } else { "auto" }));
        rig.advance(PATIENCE.stall);
        rig.tick();
        assert!(rig.turn_open());
        assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    }
}

#[test]
fn compact_after_a_command_or_unsettled_turn_completes() {
    for before in ["command", "ended_same_read", "ended_previous_read"] {
        let rig = Rig::new();
        if before == "command" {
            rig.append(&compact_prompt().replace("/compact", "/help"));
            rig.append(&compact_prompt().replace("compact-command", "next-command"));
        } else {
            rig.start_turn();
            if before == "ended_same_read" {
                rig.append(&(first_turn().1 + &compact_prompt()));
            } else {
                rig.end_turn_in_transcript();
                rig.append(&compact_prompt());
            }
        }
        rig.append(&compact_records("manual"));
        rig.advance(PATIENCE.stall + MOMENT);
        rig.tick();
        assert!(!rig.turn_open(), "{before}");
        assert_eq!(rig.recovery(), None, "{before}");
    }
}

#[test]
fn a_repeated_compact_record_does_not_reopen_a_completed_command() {
    let rig = Rig::new();
    rig.append(&compact_prompt());
    rig.append(&compact_records("manual"));
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert!(!rig.turn_open());
    rig.append(&compact_prompt().replace("compact-command", "repeated-command"));
    rig.advance(PATIENCE.stall + MOMENT);
    rig.tick();
    assert!(!rig.turn_open());
    assert_eq!(rig.recovery(), None);
}

#[test]
fn a_queued_compact_echo_preserves_command_classification() {
    for completed in [false, true] {
        let rig = Rig::new();
        rig.start_turn();
        let prompt = PromptText { mobile: None, shared_connection: None, author: None, agent: "/compact".into(), display: "/compact".into() };
        let (sent, queued) = rig.manager.record_composer_prompt(
            &mut rig.rt.lock().unwrap(), &prompt, vec![], rig._dir.path().to_str().unwrap(), None,
        );
        assert!(queued);
        rig.end_turn_in_transcript();
        rig.advance(PATIENCE.settle);
        rig.tick();
        assert!(!rig.turn_open());

        rig.append(&compact_prompt());
        assert!(rig.turn_open());
        {
            let rt = rig.rt.lock().unwrap();
            assert!(rt.turn_by_command);
            assert_eq!(rt.turn_opener, Some(("transcript_queued_prompt", "compact_command")));
        }
        assert!(rig.events().iter().any(|event| matches!(event.payload,
            Payload::TurnStarted { prompt_seq: Some(seq), .. } if seq == sent.seq)));
        if completed {
            rig.append(&compact_records("manual"));
            rig.append(&compact_prompt().replace("compact-command", "repeated-command"));
        }
        rig.advance(PATIENCE.stall + MOMENT);
        rig.tick();
        if completed {
            assert!(!rig.turn_open());
            assert_ne!(rig.status(), TabStatus::InProgress);
            assert_eq!(rig.recovery(), None);
            assert_eq!(rig.banner(), None);
        } else {
            assert!(rig.turn_open());
            assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
        }
    }
}

#[test]
fn completed_compaction_does_not_consume_the_next_turns_end() {
    let rig = Rig::new();
    rig.append(&compact_prompt());
    rig.append(&compact_records("manual"));
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert!(!rig.turn_open());
    let (body, end) = first_turn();
    rig.append(&(body + &end));
    rig.advance(PATIENCE.stall + MOMENT);
    rig.tick();
    assert!(!rig.turn_open());
    assert_eq!(rig.recovery(), None);
}

#[test]
fn a_new_compact_request_needs_its_own_completion() {
    for timestamp in [Some("2026-10-20T12:01:00.000Z"), None] {
        let rig = Rig::new();
        rig.append(&compact_prompt());
        rig.append(&compact_records("manual"));
        let mut next: serde_json::Value = serde_json::from_str(&compact_prompt()).unwrap();
        next["uuid"] = json!("second-compact-command");
        next["timestamp"] = json!(timestamp);
        rig.append(&format!("{next}\n"));
        rig.advance(PATIENCE.stall);
        rig.tick();
        assert!(rig.turn_open());
        assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    }
}

#[test]
fn an_unfinished_compact_command_still_warns() {
    let rig = Rig::new();
    rig.append(&compact_prompt());
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert!(rig.turn_open());
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
}

#[test]
fn real_work_after_manual_compaction_still_warns() {
    for next in ["prompt", "tool"] {
        let rig = Rig::new();
        rig.append(&compact_prompt());
        rig.append(&compact_records("manual"));
        if next == "prompt" {
            rig.start_turn();
        } else {
            rig.append(&format!("{}\n", json!({
                "type": "assistant", "uuid": "tool-after-compact", "message": { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "synthetic-tool", "name": "Bash", "input": { "command": "synthetic command" } }
                ] }
            })));
        }
        rig.advance(PATIENCE.stall);
        rig.tick();
        assert!(rig.turn_open(), "{next}");
        assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout), "{next}");
    }
}

#[test]
fn working_status_without_an_open_turn_is_not_stall_evidence() {
    let rig = Rig::new();
    rig.rt.lock().unwrap().status = TabStatus::InProgress;
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.recovery(), None);
}

#[test]
fn stall_diagnostics_identify_the_opener_without_its_content() {
    for source in ["transcript_user_message", "hook_user_prompt_submit", "hook"] {
        let rig = Rig::new();
        match source {
            "transcript_user_message" => rig.append(&format!("{}\n", json!({
                "type": "user", "uuid": "private-id", "message": { "role": "user", "content": "PRIVATE PROMPT" }
            }))),
            "hook_user_prompt_submit" => rig.hook("UserPromptSubmit", json!({ "prompt": "PRIVATE PROMPT" })),
            _ => rig.hook("PreToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "PRIVATE COMMAND" } })),
        }
        // Later work must not replace the event that opened this turn.
        rig.hook("PostToolUse", json!({ "tool_name": "Bash" }));
        rig.advance(PATIENCE.stall);
        rig.tick();
        assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
        let diagnostics = std::fs::read_to_string(rig.rt.lock().unwrap().diagnostics_path()).unwrap();
        let stall = diagnostics.lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find(|line| line["type"] == "session_stall").unwrap();
        assert_eq!(stall["opener_source"], source);
        assert_eq!(stall["opener_kind"], if source == "hook" { "pre_tool_use" } else { "prompt" });
        assert_eq!(stall["quiet_ms"], 300_000);
        assert!(!diagnostics.contains("PRIVATE"));
        assert!(!diagnostics.contains("private-id"));
    }
}

/// A silence warning is not a turn boundary: cloud idle suspension must
/// still see the live turn after the five-minute UI warning (#419).
#[test]
fn a_silent_live_turn_keeps_counting_after_the_warning() {
    let rig = Rig::with_live_pane();
    rig.start_turn();
    assert_eq!(rig.manager.turn_counts(), (1, 0));
    let start = rig.now.get();
    for seconds in [299, 300, 400, 600] {
        rig.now.set(start + Duration::from_secs(seconds));
        rig.tick();
        assert!(rig.manager.terminals.is_running(&rig.pane));
        assert!(rig.turn_open());
        assert_eq!(rig.counts(), (1, 0), "a quiet live turn must keep the workspace awake at {seconds}s");
    }
    assert_eq!(rig.recovery(), Some(RecoveryKind::Timeout));
    rig.end_turn_in_transcript();
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert_eq!(rig.counts(), (0, 0), "completion releases compute even though the CLI stays alive");
}

#[test]
fn a_silent_live_turn_has_a_separate_one_hour_cloud_budget() {
    let rig = Rig::with_live_pane();
    rig.start_turn();
    rig.advance(crate::cloud_activity::MAX_TURN_SILENCE - MOMENT);
    rig.tick();
    assert_eq!(rig.counts(), (1, 0));
    rig.advance(MOMENT);
    assert_eq!(rig.counts(), (0, 0), "a hung process cannot hold compute forever");
    assert!(rig.turn_open());
    assert!(rig.manager.terminals.is_running(&rig.pane), "the budget does not kill the process");

    rig.hook("PreToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } }));
    assert_eq!(rig.counts(), (1, 0), "real activity renews the silence budget");
    rig.advance(crate::cloud_activity::MAX_TURN_SILENCE);
    assert_eq!(rig.counts(), (0, 0), "the budget applies even before the watcher next runs");
}

#[test]
fn a_silence_warning_does_not_keep_a_dead_process_awake() {
    let rig = Rig::with_live_pane();
    rig.start_turn();
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.counts(), (1, 0));
    rig.manager.terminals.kill(&rig.pane);
    assert!(rig.turn_open());
    assert_eq!(rig.counts(), (0, 0));
}

#[test]
fn cloud_counts_distinguish_silence_from_errors_and_unconfirmed_delivery() {
    for kind in [RecoveryKind::Timeout, RecoveryKind::DeliveryUnconfirmed, RecoveryKind::Disconnected] {
        let rig = Rig::with_live_pane();
        rig.start_turn();
        rig.manager.needs_recovery(&mut rig.rt.lock().unwrap(), kind);
        assert_eq!(rig.counts(), (0, 0), "a reported {kind:?} is not a silence guess");
        if kind == RecoveryKind::DeliveryUnconfirmed {
            rig.rt.lock().unwrap().stalled_at = Some(rig.now.get());
            assert_eq!(rig.counts(), (0, 0), "a watcher delivery warning does not hold compute either");
        }
    }
}

/// `start_cli` records the agent's cloud credential under the pane it spawns
/// (`cloud_grants::agent_env_for_launch`), so that is what a running CLI
/// tab is asked about (PRO-110): asked as `session/tab`, a Claude tab that
/// started signed in read as needing a sign-in once the login was removed.
#[test]
fn a_cli_tab_is_asked_about_its_launch_under_its_pane() {
    let rig = Rig::new();
    assert_eq!(rig.rt.lock().unwrap().launch_key(), rig.pane);
    // A headless agent's process is recorded under the tab.
    rig.rt.lock().unwrap().engine = Engine::None;
    assert_eq!(rig.rt.lock().unwrap().launch_key(), key_of(SESSION, TAB));
    // Outside a cloud workspace no agent is ever said to need one.
    assert_eq!(rig.manager.sign_in_required(SESSION, TAB, "claude"), None);
}

#[test]
fn a_silent_turn_waiting_for_approval_is_counted_separately() {
    let rig = Rig::with_live_pane();
    rig.start_turn();
    rig.advance(PATIENCE.stall);
    rig.tick();
    {
        let mut rt = rig.rt.lock().unwrap();
        rig.manager.apply(&mut rt, Payload::PermissionRequested {
            request_id: "r1".into(), tool_use_id: "call-2".into(), tool_name: "Bash".into(),
            input: json!({ "command": "ls" }), title: None, description: None, options: vec![],
        }, None);
    }
    assert_eq!(rig.counts(), (0, 1));
    rig.advance(crate::cloud_activity::MAX_TURN_SILENCE);
    rig.tick();
    assert_eq!(rig.counts(), (0, 1), "the silence budget does not expire approvals");
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
    assert_eq!(*rig.observer.completed.lock().unwrap(), [(SESSION.to_string(), TAB.to_string(), Some("pong".to_string()))]);
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
    let spec = pty::PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some("sh -c 'echo working; read line'"), env: &[] };
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

    // The cloud budget also sees actual PTY output, even if no hook or
    // transcript event arrived for an hour and the warning is still shown.
    rig.rt.lock().unwrap().last_activity = drew - crate::cloud_activity::MAX_TURN_SILENCE;
    assert_eq!(rig.manager.turn_counts_at(drew), (1, 0));
    assert_eq!(rig.manager.turn_counts_at(drew + crate::cloud_activity::MAX_TURN_SILENCE), (0, 0));
}

/// What a prompt typed into the terminal, and one sent from the composer,
/// each leave in the chat (#250). The same rig, on either CLI.
#[path = "session_prompt_tests.rs"]
mod prompts;

impl Drop for Rig {
    fn drop(&mut self) {
        // Most tests use a pane that was never there; those with a real
        // process must release it even when an assertion fails.
        self.manager.terminals.kill(&self.pane);
    }
}

// ---- #404: one model and effort, whichever side changed it

const STATUS_FRAMES: &str = include_str!("harness/claude/fixtures/status_line.jsonl");
const CLAUDE_COMMANDS: &str = include_str!("harness/claude/fixtures/model_and_effort_commands.jsonl");
const CODEX_SETTINGS: &str = include_str!("harness/codex/fixtures/settings.jsonl");

/// What a tab says it is on: the model and effort every view draws, then
/// whatever was asked for and is still waiting.
type Shown = (String, Option<String>, Option<String>, Option<String>);

fn shown(model: &str, effort: Option<&str>, asked_model: Option<&str>, asked_effort: Option<&str>) -> Shown {
    (model.into(), effort.map(String::from), asked_model.map(String::from), asked_effort.map(String::from))
}

impl Rig {
    /// A running tab the index knows, on `model` and `effort`.
    fn on(kind: CliKind, model: &str, effort: Option<&str>) -> Self {
        let rig = Self::of(kind, "");
        let harness = rig.rt.lock().unwrap().harness.clone();
        let entry: index::SessionEntry = serde_json::from_value(json!({
            "id": SESSION, "projectPath": rig._dir.path(), "cwd": rig._dir.path(),
            "title": "watched", "created": index::now(), "modified": index::now(),
            "tabs": [{ "id": TAB, "harness": harness, "model": model, "effort": effort, "created": index::now() }]
        })).unwrap();
        index::save(&[entry]).unwrap();
        rig
    }

    fn shown(&self) -> Shown {
        let tab = index::get(SESSION).unwrap().tab(TAB).unwrap().clone();
        (tab.model, tab.effort, tab.requested_model, tab.requested_effort)
    }

    /// The `settings_changed` events in the tab's log, as (model, effort).
    fn changes(&self) -> Vec<(Option<String>, Option<String>)> {
        self.events().into_iter().filter_map(|e| match e.payload { Payload::SettingsChanged { model, effort, .. } => Some((model, effort)), _ => None }).filter(|(model, effort)| model.is_some() || effort.is_some()).collect()
    }

    fn notices(&self) -> Vec<String> {
        self.events().into_iter().filter_map(|e| match e.payload { Payload::Status { text } => Some(text), _ => None }).collect()
    }

    fn status_line(&self, model: &str, effort: &str) {
        self.hook("StatusLine", json!({ "model": { "id": model, "display_name": model }, "effort": { "level": effort } }));
    }
}

/// The frames a real Claude Code sent as its model and effort were changed in
/// the terminal — by `/model sonnet`, `/effort high`, the `/model` picker and
/// the `/effort` slider — each move the tab, with nothing asked of the app.
#[test]
fn a_model_or_effort_changed_in_the_claude_terminal_reaches_the_tab() {
    let rig = Rig::on(CliKind::Claude, "opus", Some("high"));
    let (sent, updated) = std::sync::mpsc::channel();
    rig.manager.sink.listen("session_updated", Box::new(move |payload| {
        let session: serde_json::Value = serde_json::from_str(payload).unwrap();
        let _ = sent.send((session["tabs"][0]["model"].clone(), session["tabs"][0]["effort"].clone()));
    }));
    let mut seen = Vec::new();
    for frame in STATUS_FRAMES.lines() {
        rig.hook("StatusLine", serde_json::from_str(frame).unwrap());
        seen.push(rig.shown());
    }
    assert_eq!(
        seen,
        [
            // Startup: `opus` is what the tab was on, and stays an alias; the
            // effort the CLI resolved is not the one the tab had stored.
            shown("opus", Some("medium"), None, None),
            shown("sonnet", Some("medium"), None, None),
            shown("sonnet", Some("high"), None, None),
            shown("opus", Some("medium"), None, None),
            shown("opus", Some("xhigh"), None, None),
        ]
    );
    // Each one is in the log, and went to every view of the session.
    assert_eq!(rig.changes().len(), 5);
    assert_eq!(rig.changes()[1], (Some("sonnet".into()), None));
    assert_eq!(rig.changes()[4], (None, Some("xhigh".into())));
    let views: Vec<_> = updated.try_iter().collect();
    assert_eq!(views.len(), 5);
    assert_eq!(views[4], (json!("opus"), json!("xhigh")));

    // The same frame again — the CLI repeats itself after every reply — is not news.
    rig.status_line("claude-opus-5-5", "xhigh");
    assert_eq!(rig.changes().len(), 5);
    assert!(updated.try_recv().is_err());
}

#[test]
fn a_change_from_the_chat_is_pending_until_claude_says_it_is_running() {
    let rig = Rig::on(CliKind::Claude, "opus", Some("high"));
    rig.manager.set_model(SESSION, TAB, "sonnet").unwrap();
    rig.manager.set_effort(SESSION, TAB, Some("low")).unwrap();
    assert_eq!(rig.shown(), shown("opus", Some("high"), Some("sonnet"), Some("low")), "asked for, and not shown as current");
    assert!(rig.changes().is_empty());

    // A frame from before the commands landed.
    rig.status_line("claude-opus-5-5", "high");
    assert_eq!(rig.shown(), shown("opus", Some("high"), Some("sonnet"), Some("low")));

    rig.status_line("claude-sonnet-5-5", "high");
    assert_eq!(rig.shown(), shown("sonnet", Some("high"), None, Some("low")), "the alias that was asked for, not the id it runs");
    rig.status_line("claude-sonnet-5-5", "low");
    assert_eq!(rig.shown(), shown("sonnet", Some("low"), None, None));
    assert_eq!(rig.changes(), [(Some("sonnet".into()), None), (None, Some("low".into()))]);
}

/// With no status line to go on, the command's own printed result settles it.
#[test]
fn claude_taking_the_command_settles_a_change_the_status_line_never_named() {
    let rig = Rig::on(CliKind::Claude, "opus", Some("high"));
    rig.manager.set_model(SESSION, TAB, "sonnet").unwrap();
    // The command as the CLI recorded it, then what it printed.
    let command = CLAUDE_COMMANDS.lines().find(|line| line.contains("<command-args>sonnet</command-args>")).unwrap();
    let taken = CLAUDE_COMMANDS.lines().find(|line| line.contains("Set model to `Sonnet 5.5`")).unwrap();
    rig.append(&format!("{command}\n{taken}\n"));
    assert_eq!(rig.shown(), shown("sonnet", Some("high"), None, None));
    assert!(!rig.kinds().iter().any(|k| k == "user_message"), "the app's own keystrokes are not a message");
}

/// "Set model to …" names no id. Printed for a `/model` the reader typed in
/// the terminal, it is not the answer to a change the app is waiting on.
#[test]
fn a_model_command_typed_in_the_terminal_does_not_settle_the_apps_request() {
    let rig = Rig::on(CliKind::Claude, "opus", Some("high"));
    rig.manager.set_model(SESSION, TAB, "haiku").unwrap();
    let typed = CLAUDE_COMMANDS.lines().find(|line| line.contains("<command-args>sonnet</command-args>")).unwrap();
    let taken = CLAUDE_COMMANDS.lines().find(|line| line.contains("Set model to `Sonnet 5.5`")).unwrap();
    rig.append(&format!("{typed}\n{taken}\n"));
    assert_eq!(rig.shown(), shown("opus", Some("high"), Some("haiku"), None));
    // Nor does the CLI turning down something else the reader typed.
    let refused: String = CLAUDE_COMMANDS.lines().filter(|line| line.contains("nonsense-model")).map(|line| format!("{line}\n")).collect();
    rig.append(&refused);
    assert_eq!(rig.shown(), shown("opus", Some("high"), Some("haiku"), None));
    assert!(rig.notices().is_empty());
}

/// Two changes waiting, one taken back: the other still has its deadline.
#[test]
fn taking_one_change_back_leaves_the_other_its_deadline() {
    let rig = Rig::on(CliKind::Claude, "opus", Some("high"));
    rig.manager.set_effort(SESSION, TAB, Some("low")).unwrap();
    rig.manager.set_model(SESSION, TAB, "sonnet").unwrap();
    rig.manager.set_model(SESSION, TAB, "opus").unwrap();
    assert_eq!(rig.shown(), shown("opus", Some("high"), None, Some("low")));
    rig.advance(SETTINGS_ANSWER_WAIT * 2);
    rig.tick();
    assert_eq!(rig.shown(), shown("opus", Some("high"), None, None));
}

/// Asked for max, given high: what the CLI printed is what is running.
#[test]
fn an_effort_the_cli_set_to_something_else_is_not_shown_as_the_one_asked_for() {
    let rig = Rig::on(CliKind::Claude, "opus", Some("low"));
    rig.manager.set_effort(SESSION, TAB, Some("max")).unwrap();
    let command = CLAUDE_COMMANDS.lines().find(|line| line.contains("<command-args>high</command-args>")).unwrap().replace("<command-args>high", "<command-args>max");
    let printed = CLAUDE_COMMANDS.lines().find(|line| line.contains("Set effort level to high")).unwrap();
    rig.append(&format!("{command}\n{printed}\n"));
    assert_eq!(rig.shown(), shown("opus", Some("high"), None, Some("max")));
}

#[test]
fn a_change_claude_turns_down_reverts_with_its_reason() {
    let rig = Rig::on(CliKind::Claude, "opus", Some("high"));
    rig.manager.set_model(SESSION, TAB, "claude-haiku-5-5").unwrap();
    assert_eq!(rig.shown(), shown("opus", Some("high"), Some("claude-haiku-5-5"), None));
    // What the CLI really wrote when it refused that very command.
    let refused: String = CLAUDE_COMMANDS.lines().filter(|line| line.contains("claude-haiku-5-5")).map(|line| format!("{line}\n")).collect();
    assert!(refused.contains("commandRun"));
    rig.append(&refused);
    assert_eq!(rig.shown(), shown("opus", Some("high"), None, None));
    assert!(rig.changes().is_empty(), "what was running never changed");
    assert_eq!(rig.notices(), ["Claude Code did not change the model to claude-haiku-5-5: Authentication failed. Please check your API credentials."]);
    // The command the app typed is not drawn as something the reader said.
    assert!(!rig.kinds().iter().any(|k| k == "user_message"));
}

#[test]
fn a_change_claude_never_answers_is_taken_back() {
    let rig = Rig::on(CliKind::Claude, "opus", Some("high"));
    rig.status_line("claude-opus-5-5", "high");
    rig.start_turn();
    rig.manager.set_effort(SESSION, TAB, Some("max")).unwrap();
    // A CLI mid-turn may hold the command until the turn is over.
    rig.advance(SETTINGS_ANSWER_WAIT * 3);
    rig.stamp();
    rig.tick();
    assert_eq!(rig.shown(), shown("opus", Some("high"), None, Some("max")));

    rig.hook("Stop", json!({}));
    assert!(!rig.turn_open());
    rig.advance(SETTINGS_ANSWER_WAIT - MOMENT);
    rig.tick();
    assert_eq!(rig.shown().3.as_deref(), Some("max"));
    rig.advance(MOMENT);
    rig.tick();
    assert_eq!(rig.shown(), shown("opus", Some("high"), None, None));
    assert_eq!(rig.notices(), ["Claude Code did not change the effort to max: it did not confirm the change."]);
}

/// The recorded session answered on Haiku, and each assistant record says
/// so. That is the tab's model when nothing better has spoken — and not once
/// the status line has, since a record can name a fallback the session is
/// not set to.
#[test]
fn the_model_an_assistant_record_names_stands_in_for_a_silent_status_line() {
    let rig = Rig::on(CliKind::Claude, "", None);
    rig.start_turn();
    assert_eq!(rig.shown(), shown("haiku", None, None, None));
    // One rig at a time: each holds the test home.
    drop(rig);

    let rig = Rig::on(CliKind::Claude, "opus", Some("high"));
    rig.status_line("claude-opus-5-5", "high");
    rig.start_turn();
    assert_eq!(rig.shown(), shown("opus", Some("high"), None, None));
}

/// What the `/model` picker of a real Codex wrote, and the turns either side.
#[test]
fn a_model_or_effort_changed_in_the_codex_terminal_reaches_the_tab() {
    let rig = Rig::on(CliKind::Codex, "gpt-5.6-sol", Some("high"));
    let mut seen = Vec::new();
    for record in CODEX_SETTINGS.lines() {
        rig.append(&format!("{record}\n"));
        seen.push(rig.shown());
    }
    let terra = |effort| shown("gpt-5.6-terra", Some(effort), None, None);
    assert_eq!(seen, [shown("gpt-5.6-sol", Some("high"), None, None), terra("high"), terra("low"), terra("low"), terra("low")]);
    assert_eq!(rig.changes(), [(Some("gpt-5.6-terra".into()), None), (None, Some("low".into()))]);

    // A model and a level this app has never heard of are the ones in use.
    rig.append("{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-9-nova\",\"effort\":\"ultra\"}}\n");
    assert_eq!(rig.shown(), shown("gpt-9-nova", Some("ultra"), None, None));
}

/// Codex only reads its model at startup. Asked mid-turn, the change waits
/// for the turn and is never shown as what the running turn is on.
#[test]
fn a_change_to_codex_mid_turn_is_pending_until_the_restart_that_applies_it() {
    let rig = Rig::on(CliKind::Codex, "gpt-5.6-sol", Some("low"));
    rig.rt.lock().unwrap().turn_open = true;
    rig.manager.set_model(SESSION, TAB, "gpt-6-astra").unwrap();
    rig.manager.set_effort(SESSION, TAB, Some("high")).unwrap();
    assert_eq!(rig.shown(), shown("gpt-5.6-sol", Some("low"), Some("gpt-6-astra"), Some("high")));
    assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if p.restart_when_idle));
    assert!(rig.changes().is_empty());

    // The turn in progress goes on saying what it is really running.
    rig.append("{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-sol\",\"effort\":\"low\"}}\n");
    assert_eq!(rig.shown(), shown("gpt-5.6-sol", Some("low"), Some("gpt-6-astra"), Some("high")));

    // The restart, as far as letting go of the old process: launching a
    // real Codex is refused here.
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.turn_open = false;
        rt.stopping = true;
    }
    assert!(rig.manager.restart_for_settings(SESSION, TAB).is_err());
    assert_eq!(rig.shown(), shown("gpt-6-astra", Some("high"), None, None), "what the next launch is given");
    assert_eq!(rig.changes(), [(Some("gpt-6-astra".into()), Some("high".into()))]);
}

/// A headless agent that exits before answering leaves nothing "switching":
/// the change is what its next launch is given.
#[test]
fn a_change_a_headless_agent_never_answered_is_settled_when_it_exits() {
    let rig = Rig::on(CliKind::Claude, "auto", None);
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.harness = "cursor".into();
        rt.engine = Engine::None;
        rt.child_pid = Some(4242);
    }
    index::update_tab(SESSION, TAB, |t| {
        t.requested_model = Some("sonnet-4.5".into());
        Ok(())
    })
    .unwrap();
    rig.manager.on_exit(&rig.rt, 4242, Some(1));
    assert_eq!(rig.shown(), shown("sonnet-4.5", None, None, None));
}

#[test]
fn a_restart_that_did_not_put_codex_on_the_model_asked_for_says_so() {
    let rig = Rig::on(CliKind::Codex, "gpt-6-astra", Some("high"));
    {
        let mut rt = rig.rt.lock().unwrap();
        let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
        p.launched_for = Some(Settings { model: "gpt-6-astra".into(), effort: Some("high".into()), ..Default::default() });
    }
    rig.append(&format!("{}\n", CODEX_SETTINGS.lines().next().unwrap()));
    assert_eq!(rig.shown(), shown("gpt-5.6-sol", Some("high"), None, None));
    assert_eq!(rig.notices(), ["Codex is running model gpt-5.6-sol, not gpt-6-astra."]);
    // Said once: the next report is only a report.
    rig.append("{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-terra\",\"effort\":\"high\"}}\n");
    assert_eq!(rig.notices().len(), 1);
}

/// A tab on Codex's own default was not restarted onto any model in
/// particular, so whichever one it reports is not a miss.
#[test]
fn a_restarted_tab_on_the_default_model_is_not_told_it_missed() {
    let rig = Rig::on(CliKind::Codex, "", Some("high"));
    {
        let mut rt = rig.rt.lock().unwrap();
        let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
        p.launched_for = Some(Settings { effort: Some("high".into()), ..Default::default() });
    }
    rig.append(&format!("{}\n", CODEX_SETTINGS.lines().next().unwrap()));
    assert_eq!(rig.shown(), shown("gpt-5.6-sol", Some("high"), None, None));
    assert!(rig.notices().is_empty());
}

/// Clearing the effort mid-turn still needs the restart that applies it.
#[test]
fn clearing_codex_effort_mid_turn_still_schedules_the_restart() {
    let rig = Rig::on(CliKind::Codex, "gpt-5.6-sol", Some("high"));
    rig.rt.lock().unwrap().turn_open = true;
    rig.manager.set_effort(SESSION, TAB, None).unwrap();
    assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if p.restart_when_idle));
}

/// A tab that is not running has nobody to wait for: the choice is what the
/// next launch gets.
#[test]
fn a_change_to_a_tab_that_is_not_running_is_current_at_once() {
    for kind in [CliKind::Claude, CliKind::Codex] {
        let rig = Rig::on(kind, "before", Some("low"));
        rig.rt.lock().unwrap().engine = Engine::None;
        rig.manager.set_model(SESSION, TAB, "after").unwrap();
        rig.manager.set_effort(SESSION, TAB, Some("high")).unwrap();
        assert_eq!(rig.shown(), shown("after", Some("high"), None, None));
    }
}

#[test]
fn an_agent_with_no_effort_setting_refuses_one() {
    let rig = Rig::on(CliKind::Claude, "auto", None);
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.harness = "cursor".into();
        rt.engine = Engine::None;
    }
    let error = rig.manager.set_effort(SESSION, TAB, Some("high")).unwrap_err();
    assert_eq!(error.to_string(), "Cursor has no effort setting.");
    assert_eq!(rig.shown(), shown("auto", None, None, None));
}

/// A command that failed, as each CLI records it: the call and its result.
fn failed_command(kind: CliKind, id: &str) -> String {
    match kind {
        CliKind::Claude => format!(
            "{}\n{}\n",
            json!({ "type": "assistant", "uuid": format!("a-{id}"), "isSidechain": false, "message": { "id": format!("m-{id}"), "role": "assistant", "content": [{ "type": "tool_use", "id": id, "name": "Bash", "input": { "command": "cargo test" } }] } }),
            json!({ "type": "user", "uuid": format!("u-{id}"), "isSidechain": false, "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id, "is_error": true, "content": "test result: FAILED" }] } }),
        ),
        CliKind::Codex => format!(
            "{}\n",
            json!({ "type": "event_msg", "payload": { "type": "item_completed", "item": { "type": "CommandExecution", "id": id, "command": "cargo test", "cwd": "/w/demo", "status": "completed", "exit_code": 1, "aggregated_output": "test result: FAILED" } } }),
        ),
    }
}

/// The agent says something, as each CLI records it.
fn agent_text(kind: CliKind, id: &str) -> String {
    match kind {
        CliKind::Claude => format!("{}\n", json!({ "type": "assistant", "uuid": format!("a-{id}"), "isSidechain": false, "message": { "id": format!("m-{id}"), "role": "assistant", "content": [{ "type": "text", "text": "Trying another way." }] } })),
        CliKind::Codex => format!("{}\n", json!({ "type": "event_msg", "payload": { "type": "item_completed", "item": { "type": "AgentMessage", "id": id, "content": [{ "type": "text", "text": "Trying another way." }] } } })),
    }
}

impl Rig {
    /// A tab on either CLI with a turn open and the agent working.
    fn working(kind: CliKind) -> Self {
        let rig = Self::of(kind, "");
        match kind {
            CliKind::Claude => rig.start_turn(),
            CliKind::Codex => rig.append(&format!(
                "{}\n{}\n",
                json!({ "type": "event_msg", "payload": { "type": "task_started", "turn_id": "turn-1" } }),
                json!({ "type": "event_msg", "payload": { "type": "item_completed", "item": { "type": "UserMessage", "id": "user-1", "content": [{ "type": "text", "text": "run the tests" }] } } }),
            )),
        }
        assert!(rig.turn_open());
        assert_eq!(rig.status(), TabStatus::InProgress);
        rig
    }

    /// The failed tool results in the log, and every recovery ever raised.
    fn failed_tools_and_recoveries(&self) -> (usize, Vec<RecoveryKind>) {
        let events = self.events();
        let failed = events.iter().filter(|e| matches!(&e.payload, Payload::ToolCallCompleted { result, .. } if result.is_error)).count();
        let raised = events.iter().filter_map(|e| match &e.payload { Payload::Recovery { kind } => *kind, _ => None }).collect();
        (failed, raised)
    }
}

/// A command that exits non-zero in a running turn is the agent's to read,
/// not the reader's: the tab stays "Working" through the failure, through the
/// thinking after it, and through the work that follows (#400).
#[test]
fn a_failed_command_in_a_running_turn_does_not_ask_for_attention() {
    for kind in [CliKind::Claude, CliKind::Codex] {
        let rig = Rig::working(kind);
        for id in ["call-1", "call-2", "call-3"] {
            rig.append(&failed_command(kind, id));
            assert_eq!(rig.status(), TabStatus::InProgress, "{kind:?}: still working after a failed command");
            assert_eq!(rig.recovery(), None);
            rig.append(&agent_text(kind, &format!("text-{id}")));
            assert_eq!(rig.status(), TabStatus::InProgress);
        }
        let (failed, raised) = rig.failed_tools_and_recoveries();
        assert_eq!(failed, 3, "{kind:?}: each failure is still a failed row in the transcript");
        assert_eq!(raised, vec![], "{kind:?}: and none of them was ever a banner");
        assert_eq!(rig.banner(), None);
    }
}

/// The last thing a turn did was a command that failed, and then the turn
/// ended normally: it is completed, not in need of attention.
#[test]
fn a_turn_whose_last_tool_failed_and_then_completes_is_completed() {
    for kind in [CliKind::Claude, CliKind::Codex] {
        let rig = Rig::working(kind);
        rig.append(&failed_command(kind, "call-1"));
        rig.hook("Stop", json!({ "last_assistant_message": "The tests fail; see above." }));
        assert!(!rig.turn_open());
        assert_eq!(rig.status(), TabStatus::Completed, "{kind:?}");
        assert_eq!(rig.recovery(), None);
        assert_eq!(rig.failed_tools_and_recoveries(), (1, vec![]));
    }
}

/// A turn that ends in an error is the reader's to look at, failed tools
/// before it or not.
#[test]
fn a_turn_that_ends_in_an_error_asks_for_attention() {
    for kind in [CliKind::Claude, CliKind::Codex] {
        let rig = Rig::working(kind);
        rig.append(&failed_command(kind, "call-1"));
        {
            let mut rt = rig.rt.lock().unwrap();
            rig.manager.apply(&mut rt, Payload::TurnCompleted { status: TurnStatus::Error, final_text: Some("the agent crashed".into()), usage: None, duration_ms: None, head: None, auth_failed: false }, None);
        }
        assert!(!rig.turn_open());
        assert_eq!(rig.status(), TabStatus::Waiting, "{kind:?}");
        assert_eq!(rig.recovery(), Some(RecoveryKind::Failed));
        assert_eq!(rig.banner(), Some(RecoveryKind::Failed));
    }
}

/// Asking still waits, and a failed command while it waits changes nothing.
#[test]
fn a_pending_permission_still_waits_for_input_after_a_failed_command() {
    let rig = Rig::working(CliKind::Claude);
    rig.append(&failed_command(CliKind::Claude, "call-1"));
    {
        let mut rt = rig.rt.lock().unwrap();
        rig.manager.apply(&mut rt, Payload::PermissionRequested { request_id: "r1".into(), tool_use_id: "call-2".into(), tool_name: "Bash".into(), input: json!({ "command": "rm file" }), title: None, description: None, options: vec![] }, None);
    }
    assert_eq!(rig.status(), TabStatus::Waiting);
    assert_eq!(rig.recovery(), None);
}
// ---- #417: one permission mode, whichever side changed it

const CLAUDE_MODE_FRAMES: &str = include_str!("harness/claude/fixtures/permission_mode_hooks.jsonl");
const CODEX_PERMISSIONS: &str = include_str!("harness/codex/fixtures/permissions.jsonl");

impl Rig {
    /// A running tab the index knows, launched in `mode`.
    fn in_mode(kind: CliKind, mode: &str) -> Self {
        let rig = Self::of(kind, "");
        let harness = {
            let mut rt = rig.rt.lock().unwrap();
            let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
            p.mode = mode.into();
            rt.harness.clone()
        };
        let entry: index::SessionEntry = serde_json::from_value(json!({
            "id": SESSION, "projectPath": rig._dir.path(), "cwd": rig._dir.path(),
            "title": "watched", "created": index::now(), "modified": index::now(),
            "tabs": [{ "id": TAB, "harness": harness, "model": "m", "permissionMode": mode, "created": index::now() }]
        })).unwrap();
        index::save(&[entry]).unwrap();
        rig
    }

    /// The mode every view draws, and one asked for that is still waiting.
    fn mode(&self) -> (String, Option<String>) {
        let tab = index::get(SESSION).unwrap().tab(TAB).unwrap().clone();
        (tab.permission_mode, tab.requested_permission_mode)
    }

    /// The modes the tab's log says it moved into.
    fn mode_changes(&self) -> Vec<String> {
        self.events().into_iter().filter_map(|e| match e.payload { Payload::SettingsChanged { permission_mode, .. } => permission_mode, _ => None }).collect()
    }

    /// The mode the app's own every-tool gate goes by.
    fn launch_mode(&self) -> Option<String> {
        match &self.rt.lock().unwrap().engine {
            Engine::Cli(p) => Some(p.mode.clone()),
            _ => None,
        }
    }

    fn share(&self) {
        self.manager.sharing.lock().unwrap().sessions.insert(SESSION.into(), crate::local_sharing::Share::new("host".into(), "".into(), String::new()));
        // The restart a refused mode brings on goes as far as letting go of
        // the CLI: launching a real one is refused here.
        self.rt.lock().unwrap().stopping = true;
    }

    fn released(&self) -> bool {
        matches!(self.rt.lock().unwrap().engine, Engine::None)
    }
}

fn now_in(mode: &str) -> (String, Option<String>) {
    (mode.into(), None)
}

/// The frames a real Claude Code sent as its mode was cycled with Shift+Tab,
/// a prompt after each press: the prompt's own hook is where each is heard.
#[test]
fn a_mode_cycled_in_the_claude_terminal_reaches_the_tab_with_the_next_prompt() {
    let rig = Rig::in_mode(CliKind::Claude, "manual");
    let (sent, updated) = std::sync::mpsc::channel();
    rig.manager.sink.listen("session_updated", Box::new(move |payload| {
        let session: serde_json::Value = serde_json::from_str(payload).unwrap();
        let _ = sent.send(session["tabs"][0]["permissionMode"].as_str().unwrap().to_string());
    }));
    let mut seen = Vec::new();
    for frame in CLAUDE_MODE_FRAMES.lines() {
        let frame: serde_json::Value = serde_json::from_str(frame).unwrap();
        rig.hook(frame["event"].as_str().unwrap(), frame["payload"].clone());
        seen.push(rig.mode().0);
    }
    // SessionStart names no mode; `default` is the picker's "Ask every
    // time"; SessionEnd changes nothing.
    assert_eq!(seen, ["manual", "acceptEdits", "plan", "auto", "manual", "acceptEdits", "plan", "auto", "auto"]);
    let moved = ["acceptEdits", "plan", "auto", "manual", "acceptEdits", "plan", "auto"];
    assert_eq!(rig.mode_changes(), moved);
    assert_eq!(updated.try_iter().collect::<Vec<_>>(), moved, "and every view is told each time");
    assert_eq!(rig.launch_mode().as_deref(), Some("auto"));
}

/// A tool call's frame carries the mode too, so a change mid-turn is known
/// before the tool it would judge is.
#[test]
fn a_mode_changed_mid_turn_reaches_the_tab_with_the_next_tool_call() {
    let rig = Rig::in_mode(CliKind::Claude, "plan");
    rig.hook("UserPromptSubmit", json!({ "permission_mode": "plan", "prompt": "go" }));
    assert_eq!(rig.mode(), now_in("plan"));
    assert!(rig.mode_changes().is_empty(), "the mode it is in is no news");
    rig.hook("PreToolUse", json!({ "permission_mode": "acceptEdits", "tool_name": "Edit", "tool_input": {}, "tool_use_id": "t1" }));
    assert_eq!(rig.mode(), now_in("acceptEdits"));
    // A subagent's own mode is not the session's.
    rig.hook("PreToolUse", json!({ "permission_mode": "bypassPermissions", "agent_id": "a1", "tool_name": "Bash", "tool_input": {}, "tool_use_id": "t2" }));
    assert_eq!(rig.mode(), now_in("acceptEdits"));
}

#[test]
fn a_mode_the_app_has_no_entry_for_is_shown_as_reported() {
    let rig = Rig::in_mode(CliKind::Claude, "auto");
    rig.hook("UserPromptSubmit", json!({ "permission_mode": "dontAsk" }));
    assert_eq!(rig.mode(), now_in("dontAsk"));
    rig.hook("UserPromptSubmit", json!({ "permission_mode": "something-newer" }));
    assert_eq!(rig.mode(), now_in("something-newer"));

    // One rig at a time: each holds the test home.
    drop(rig);
    let rig = Rig::in_mode(CliKind::Codex, "auto");
    rig.append("{\"type\":\"turn_context\",\"payload\":{\"approval_policy\":\"never\",\"sandbox_policy\":{\"type\":\"workspace-write\"}}}\n");
    assert_eq!(rig.mode(), now_in("never, workspace-write"));
    assert_eq!(rig.mode_changes(), ["never, workspace-write"]);
}

/// What a real Codex wrote as its `/permissions` menu was taken through its
/// three presets, from a tab launched in Plan.
#[test]
fn a_stance_changed_in_the_codex_terminal_reaches_the_tab() {
    let rig = Rig::in_mode(CliKind::Codex, "plan");
    let mut seen = Vec::new();
    for record in CODEX_PERMISSIONS.lines() {
        rig.append(&format!("{record}\n"));
        seen.push(rig.mode().0);
    }
    assert_eq!(seen, ["plan", "auto", "auto", "auto", "auto", "bypassPermissions", "bypassPermissions", "bypassPermissions"]);
    assert_eq!(rig.mode_changes(), ["auto", "bypassPermissions"]);
}

/// "Ask every time" is the app's own gate over a stance other modes share,
/// so a report of that stance leaves the tab in it. Leaving the stance in
/// the terminal leaves the gate behind too.
#[test]
fn a_codex_tab_keeps_its_own_mode_under_a_stance_that_mode_launches() {
    let rig = Rig::in_mode(CliKind::Codex, "manual");
    let turn = |approval: &str, sandbox: &str| format!("{{\"type\":\"turn_context\",\"payload\":{{\"approval_policy\":\"{approval}\",\"sandbox_policy\":{{\"type\":\"{sandbox}\"}}}}}}\n");
    rig.append(&turn("on-request", "workspace-write"));
    assert_eq!(rig.mode(), now_in("manual"));
    assert!(codex::asks_every_tool(&rig.launch_mode().unwrap()));
    rig.append(&turn("never", "danger-full-access"));
    assert_eq!(rig.mode(), now_in("bypassPermissions"));
    assert!(!codex::asks_every_tool(&rig.launch_mode().unwrap()), "the reader took the tab out of asking");
}

/// The CLI is only restarted between turns, so a mode chosen in the chat
/// mid-turn is not the mode the turn is being judged under, and is not shown
/// as if it were.
#[test]
fn a_mode_from_the_chat_mid_turn_is_pending_until_the_restart_that_applies_it() {
    for kind in [CliKind::Claude, CliKind::Codex] {
        let rig = Rig::in_mode(kind, "auto");
        rig.rt.lock().unwrap().turn_open = true;
        rig.manager.set_permission_mode(SESSION, TAB, "plan").unwrap();
        assert_eq!(rig.mode(), ("auto".into(), Some("plan".into())));
        assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if p.restart_when_idle));
        assert!(rig.mode_changes().is_empty());
        assert_eq!(rig.launch_mode().as_deref(), Some("auto"));

        // What the running turn reports meanwhile is still where it is.
        if kind == CliKind::Claude {
            rig.hook("PreToolUse", json!({ "permission_mode": "auto", "tool_name": "Read", "tool_input": {}, "tool_use_id": "t1" }));
            assert_eq!(rig.mode(), ("auto".into(), Some("plan".into())));
        }

        // The restart, as far as letting go of the old process.
        {
            let mut rt = rig.rt.lock().unwrap();
            rt.turn_open = false;
            rt.stopping = true;
        }
        assert!(rig.manager.restart_for_settings(SESSION, TAB).is_err());
        assert_eq!(rig.mode(), now_in("plan"), "what the next launch is given");
        assert_eq!(rig.mode_changes(), ["plan"]);
    }
}

#[test]
fn asking_for_the_mode_the_tab_is_in_takes_a_waiting_change_back() {
    let rig = Rig::in_mode(CliKind::Claude, "auto");
    rig.rt.lock().unwrap().turn_open = true;
    rig.manager.set_permission_mode(SESSION, TAB, "plan").unwrap();
    rig.manager.set_permission_mode(SESSION, TAB, "auto").unwrap();
    assert_eq!(rig.mode(), now_in("auto"));
    assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if !p.restart_when_idle), "and the restart with it");

    // Codex may have a model waiting on the same restart.
    // One rig at a time: each holds the test home.
    drop(rig);
    let rig = Rig::in_mode(CliKind::Codex, "auto");
    rig.rt.lock().unwrap().turn_open = true;
    rig.manager.set_model(SESSION, TAB, "gpt-6-astra").unwrap();
    rig.manager.set_permission_mode(SESSION, TAB, "plan").unwrap();
    rig.manager.set_permission_mode(SESSION, TAB, "auto").unwrap();
    assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if p.restart_when_idle));
}

#[test]
fn a_mode_for_a_tab_that_is_not_running_is_current_at_once() {
    let rig = Rig::in_mode(CliKind::Claude, "auto");
    rig.rt.lock().unwrap().engine = Engine::None;
    rig.manager.set_permission_mode(SESSION, TAB, "plan").unwrap();
    assert_eq!(rig.mode(), now_in("plan"));
    assert_eq!(rig.mode_changes(), ["plan"]);
}

/// Outside a share, Bypass reached in the terminal is the mode the tab is in.
#[test]
fn bypass_chosen_in_the_terminal_is_shown_when_nothing_forbids_it() {
    let rig = Rig::in_mode(CliKind::Claude, "auto");
    rig.hook("UserPromptSubmit", json!({ "permission_mode": "bypassPermissions" }));
    assert_eq!(rig.mode(), now_in("bypassPermissions"));
    assert!(!rig.released());
}

/// A shared session may not be in Bypass, and a guest's prompt must never be
/// typed into a CLI that is. Showing the mode would not undo it: the CLI is
/// let go of at once and brought back in the mode the tab was in.
#[test]
fn a_shared_session_is_restarted_out_of_a_mode_it_may_not_be_in() {
    // Codex: "Full Access" confirmed in the TUI's `/permissions`.
    let rig = Rig::in_mode(CliKind::Codex, "auto");
    rig.share();
    rig.rt.lock().unwrap().turn_open = true;
    for record in CODEX_PERMISSIONS.lines() {
        rig.append(&format!("{record}\n"));
    }
    assert_eq!(rig.mode(), now_in("auto"), "never stored");
    assert!(rig.mode_changes().iter().all(|mode| mode != "bypassPermissions"));
    assert!(rig.released(), "the CLI that was in it is gone before anything else is typed");
    assert!(!rig.turn_open());
    assert_eq!(
        rig.notices(),
        ["Codex was switched to Bypass in the terminal. A shared session cannot be in Bypass, so Codex was restarted in Auto. Stop sharing this session before switching to Bypass."]
    );

    // Claude Code, and a stance with no sandbox under any other name.
    // One rig at a time: each holds the test home.
    drop(rig);
    let rig = Rig::in_mode(CliKind::Claude, "plan");
    rig.share();
    rig.hook("PreToolUse", json!({ "permission_mode": "bypassPermissions", "tool_name": "Bash", "tool_input": {}, "tool_use_id": "t1" }));
    assert_eq!(rig.mode(), now_in("plan"));
    assert!(rig.released());

    // One rig at a time: each holds the test home.
    drop(rig);
    let rig = Rig::in_mode(CliKind::Codex, "plan");
    rig.share();
    rig.append("{\"type\":\"turn_context\",\"payload\":{\"approval_policy\":\"on-request\",\"sandbox_policy\":{\"type\":\"danger-full-access\"}}}\n");
    assert_eq!(rig.mode(), now_in("plan"));
    assert!(rig.released());

    // Any other mode changed in the terminal of a shared session is just shown.
    // One rig at a time: each holds the test home.
    drop(rig);
    let rig = Rig::in_mode(CliKind::Claude, "plan");
    rig.share();
    rig.hook("UserPromptSubmit", json!({ "permission_mode": "acceptEdits" }));
    assert_eq!(rig.mode(), now_in("acceptEdits"));
    assert!(!rig.released());
}

/// The composer's prompt went into the pane and its Enter was written; the
/// CLI has not acknowledged it.
fn enter_written_unacknowledged(rig: &Rig, seq: u64) {
    let mut rt = rig.rt.lock().unwrap();
    if let Engine::Cli(p) = &mut rt.engine {
        p.awaiting_delivery = Some(seq);
        p.delivery_sent_at = Some(rig.now.get());
        p.accept_by = Some(rig.now.get() + tui::ACCEPT_TIMEOUT);
        p.nudge_by = Some(rig.now.get() + tui::NUDGE_AFTER);
    }
}

fn delivery_stages(rig: &Rig) -> Vec<String> {
    let path = rig.rt.lock().unwrap().diagnostics_path();
    std::fs::read_to_string(path).unwrap_or_default().lines().filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok()).filter_map(|v| v["stage"].as_str().map(String::from)).collect()
}

#[test]
fn an_enter_the_cli_let_go_by_is_written_once_more_before_the_reader_is_told() {
    let rig = Rig::with_live_pane();
    enter_written_unacknowledged(&rig, 7);
    rig.tick();
    assert!(delivery_stages(&rig).is_empty(), "not at once: the CLI gets its moment");
    rig.advance(tui::NUDGE_AFTER);
    rig.tick();
    assert_eq!(delivery_stages(&rig), ["nudged"]);
    assert_eq!(rig.recovery(), None, "a nudge is not a warning");
    rig.advance(Duration::from_secs(1));
    rig.tick();
    assert_eq!(delivery_stages(&rig), ["nudged"], "once only");
    // Still nothing: now the reader is told, as before.
    rig.advance(tui::ACCEPT_TIMEOUT);
    rig.tick();
    assert_eq!(rig.recovery(), Some(RecoveryKind::DeliveryUnconfirmed));
    assert_eq!(delivery_stages(&rig), ["nudged", "unconfirmed"]);
}

#[test]
fn no_enter_is_written_while_the_cli_is_asking_something_an_enter_would_answer() {
    let rig = Rig::with_live_pane();
    enter_written_unacknowledged(&rig, 8);
    {
        let mut rt = rig.rt.lock().unwrap();
        rig.manager.apply(&mut rt, Payload::PermissionRequested {
            request_id: "r1".into(), tool_use_id: "call-9".into(), tool_name: "Bash".into(),
            input: json!({ "command": "rm -rf build" }), title: None, description: None, options: vec![],
        }, None);
        assert!(!rt.pending.is_empty());
    }
    rig.advance(tui::NUDGE_AFTER);
    rig.tick();
    assert!(delivery_stages(&rig).is_empty(), "an Enter here would answer the question");
}

#[test]
fn send_now_keeps_pending_identities_and_echo_order_after_interrupt() {
    let rig = Rig::with_live_pane();
    rig.start_turn();
    {
        let mut rt = rig.rt.lock().unwrap();
        if let Engine::Cli(p) = &mut rt.engine {
            for (seq, text) in [(41, "first held"), (42, "second held")] {
                p.held.push(seq);
                let mut echo = ComposerEcho::new(text.into(), 0);
                echo.queued = true;
                echo.seq = seq;
                p.echoed.push_back(echo);
            }
        }
    }
    assert!(rig.manager.send_queued_now(SESSION, TAB, 7).is_ok(), "a stale action is a harmless no-op");
    rig.manager.send_queued_now(SESSION, TAB, 42).unwrap();
    // The Escape went in; the CLI ends the turn as interrupted.
    {
        let mut rt = rig.rt.lock().unwrap();
        rig.manager.apply(&mut rt, Payload::TurnCompleted { status: TurnStatus::Aborted, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false }, None);
    }
    let rt = rig.rt.lock().unwrap();
    assert!(!rt.turn_open, "an interrupt acknowledgement does not prove delivery");
    assert_eq!(rt.status, TabStatus::Idle);
    let Engine::Cli(p) = &rt.engine else { panic!("a CLI tab") };
    assert_eq!(p.awaiting_delivery, None);
    assert_eq!(p.held, vec![41, 42]);
    assert_eq!(p.echoed.iter().map(|echo| (echo.seq, echo.queued)).collect::<Vec<_>>(), vec![(41, true), (42, true)]);
    assert_eq!(p.resend_after_abort, Some(42), "still pending work until provider acceptance");
}

#[test]
fn message_timestamps_preserve_source_and_first_stream_chunk_on_disk() {
    let rig = Rig::new();
    let mut rt = rig.rt.lock().unwrap();
    let block = BlockRef { message_id: "synthetic-message".into(), index: 0 };
    let first = rig.manager.publish(&mut rt, Payload::Delta(Delta::TextDelta { block: block.clone(), text: "Hello".into() }), None);
    rt.source_timestamp = Some("2026-10-22T23:59:00Z".into());
    let next = rig.manager.publish(&mut rt, Payload::Delta(Delta::TextDelta { block: block.clone(), text: " world".into() }), None);
    let committed = rig.manager.publish(&mut rt, Payload::AssistantText { block: Some(block), text: "Hello world".into() }, None);
    assert_eq!(first.ts, next.ts);
    assert_eq!(first.ts, committed.ts);
    assert_eq!(first.message_ts.as_deref(), Some(first.ts.as_str()));
    assert_eq!(first.message_ts, next.message_ts);
    assert_eq!(first.message_ts, committed.message_ts);
    let source = rig.manager.publish(&mut rt, Payload::AssistantText { block: None, text: "Source record".into() }, None);
    assert_eq!(source.ts, "2026-10-22T23:59:00Z");
    rt.source_timestamp = Some(String::new());
    let unknown = rig.manager.publish(&mut rt, Payload::AssistantText { block: None, text: "Undated history".into() }, None);
    assert!(unknown.ts.is_empty());
    assert!(unknown.message_ts.is_none());
    let saved: Vec<AgentEvent> = store::read_lines(&rt.log_path).unwrap();
    assert_eq!(saved, vec![committed, source, unknown]);
}

#[test]
fn transcript_message_timestamps_survive_tailing() {
    let rig = Rig::new();
    rig.append(
        r#"{"type":"assistant","timestamp":"2026-10-22T23:59:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Synthetic dated message"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Synthetic undated message"}]}}
"#,
    );
    rig.manager.pump(&rig.rt, &rig.tail);
    let messages: Vec<_> = rig.events().into_iter().filter(|ev| matches!(ev.payload, Payload::AssistantText { .. })).collect();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].ts, "2026-10-22T23:59:00Z");
    assert_eq!(messages[1].ts, "");
    assert_eq!(messages[0].message_ts.as_deref(), Some("2026-10-22T23:59:00Z"));
    assert!(messages[1].message_ts.is_none());
}
