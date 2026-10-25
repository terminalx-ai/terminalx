//! Tabs following their terminal (#437), against real panes and real
//! transcripts, less the agent CLIs themselves.
//!
//! What the foreground watcher would say is said by the test
//! (`pane_foreground`), and where a hand-started CLI keeps its conversation
//! is answered by a locator the test fills in. Everything after that is the
//! app's own: the tab that is made or changed, the transcript that is
//! followed, the log that is written. A pane here is a real PTY, because a
//! tab's shell and an agent's exit are things only a real one does.
//!
//! The transcripts are the recorded fixtures, written into the file a tab
//! follows record by record. Tests wait for what they expect to appear,
//! never for an amount of time to pass.
use std::time::{Duration, SystemTime};

use serde_json::json;

use super::follow::{conversation_is_blank, Activity, Glance, Located, Locator};
use super::*;
use crate::foreground::Agent;
use crate::store::index::Front;

const SESSION: &str = "followed";
const CLAUDE_FIXTURE: &str = include_str!("harness/claude/fixtures/interactive_session.jsonl");
const CODEX_FIXTURE: &str = include_str!("harness/codex/fixtures/rollout.jsonl");
const CLAUDE_ID: &str = "0a8b6f2e-52d1-4c0a-9d0e-5a4f7d2c1b3e";
const CODEX_ID: &str = "01a061f1-16d4-7c01-9900-e3903aa4d5ae";
/// Process ids no process has: an agent that has exited.
const CLAUDE_PID: u32 = 2_000_000_001;
const CODEX_PID: u32 = 2_000_000_002;

/// Which conversation a CLI says it is in, and what it says it is doing.
type Saying = (Option<Located>, Option<Activity>);

/// Where each hand-started CLI says it is, as the test last set it.
#[derive(Default)]
struct Told {
    by_pid: Mutex<HashMap<u32, Saying>>,
}

impl Told {
    fn set(&self, pid: u32, located: Option<Located>, activity: Option<Activity>) {
        self.by_pid.lock().unwrap().insert(pid, (located, activity));
    }

    fn doing(&self, pid: u32, activity: Activity) {
        if let Some(told) = self.by_pid.lock().unwrap().get_mut(&pid) {
            told.1 = Some(activity);
        }
    }
}

impl Locator for Told {
    fn locate(&self, agent: &Agent) -> Option<Located> {
        self.by_pid.lock().unwrap().get(&agent.pid)?.0.clone()
    }
    fn glance(&self, agent: &Agent) -> Glance {
        let told = self.by_pid.lock().unwrap();
        let Some((located, activity)) = told.get(&agent.pid) else { return Glance::default() };
        Glance { conversation: located.as_ref().map(|at| at.provider_session_id.clone()), activity: *activity }
    }
    fn locate_every(&self, _agent: &Agent, _settled: bool) -> Duration {
        Duration::ZERO
    }
    fn at_once(&self, _agent: &Agent) -> bool {
        true
    }
}

fn agent(harness: &'static str, pid: u32) -> Agent {
    Agent { harness, pid, pids: vec![pid], job: pid }
}

fn located(id: &str, transcript: &Path) -> Located {
    Located { provider_session_id: id.into(), transcript: Some(transcript.to_path_buf()) }
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap().write_all(text.as_bytes()).unwrap();
}

/// The Claude fixture up to and including the record that ends turn `n` (from 1).
fn claude_turns(n: usize) -> String {
    let mut ended = 0;
    let mut out = String::new();
    for line in CLAUDE_FIXTURE.lines() {
        out.push_str(line);
        out.push('\n');
        if line.contains(r#""subtype":"turn_duration""#) {
            ended += 1;
            if ended == n {
                break;
            }
        }
    }
    out
}

/// The Codex fixture's first turn: everything up to and including its `task_complete`.
fn codex_first_turn() -> String {
    let lines: Vec<&str> = CODEX_FIXTURE.lines().collect();
    let ends = |line: &&str| serde_json::from_str::<Value>(line).is_ok_and(|record| record["payload"]["type"] == "task_complete");
    let end = lines.iter().position(ends).expect("the fixture records its turn's end");
    lines[..=end].iter().map(|line| format!("{line}\n")).collect()
}

fn claude_user_record(text: &str) -> String {
    format!("{}\n", json!({ "type": "user", "uuid": uuid::Uuid::new_v4().to_string(), "cwd": "/w", "message": { "role": "user", "content": text } }))
}

fn claude_reply_record(text: &str) -> String {
    format!("{}\n", json!({ "type": "assistant", "uuid": uuid::Uuid::new_v4().to_string(), "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] } }))
}

struct Rig {
    manager: SessionManager,
    sink: Arc<crate::sink::BroadcastSink>,
    told: Arc<Told>,
    dir: tempfile::TempDir,
    _home: store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        // As the app does when it quits: the threads that outlive this rig
        // then leave the index alone, which by then is the next test's.
        self.manager.closing();
        self.manager.terminals.kill_all();
    }
}

impl Rig {
    /// A session with the given tabs, in an app that follows terminals.
    fn new(tabs: serde_json::Value) -> Self {
        let rig = Self::not_following(tabs);
        rig.manager.follow_with(rig.told.clone());
        rig
    }

    fn not_following(tabs: serde_json::Value) -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let sink = Arc::new(crate::sink::BroadcastSink::new(1024));
        let manager = SessionManager::new(
            sink.clone(),
            Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()),
            Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        manager.follow_pane_exits();
        let entry: index::SessionEntry = serde_json::from_value(json!({
            "id": SESSION, "projectPath": dir.path(), "cwd": dir.path(), "title": "followed",
            "created": index::now(), "modified": index::now(), "tabs": tabs,
        }))
        .unwrap();
        index::save(&[entry]).unwrap();
        Self { manager, sink, told: Arc::default(), dir, _home: home }
    }

    fn pane(&self, id: &str, command: &str) {
        let spec = pty::PaneSpec { cwd: self.dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(command), env: &[] };
        self.manager.terminals.spawn(self.sink.clone(), id, spec).unwrap();
    }

    /// A shell tab the reader opened, named as the window names one. `cat`
    /// stands for the shell: it is there until the pane is closed, and
    /// echoes what is typed at it.
    fn shell(&self, n: u32) -> String {
        let id = format!("{SESSION}:{n}");
        self.pane(&id, "cat");
        self.manager.terminals.set_title(&id, &format!("Terminal {n}"));
        id
    }

    fn tabs(&self) -> Vec<TabEntry> {
        index::get(SESSION).unwrap().tabs
    }

    fn tab(&self) -> TabEntry {
        let tabs = self.tabs();
        assert_eq!(tabs.len(), 1, "{tabs:?}");
        tabs.into_iter().next().unwrap()
    }

    fn events(&self, tab: &str) -> Vec<AgentEvent> {
        store::read_lines(&store::log_path(SESSION, tab).unwrap()).unwrap()
    }

    /// The conversation as the chat would draw it: who said what, and where
    /// a turn ended or the tab changed hands.
    fn said(&self, tab: &str) -> Vec<String> {
        self.events(tab)
            .into_iter()
            .filter_map(|event| match event.payload {
                Payload::UserMessage { text, .. } => Some(format!("user: {text}")),
                Payload::AssistantText { text, .. } => Some(format!("{}: {text}", event.harness)),
                Payload::TurnCompleted { status, .. } => Some(format!("turn {status:?}")),
                Payload::Status { text } => Some(format!("status: {text}")),
                Payload::Conversation { harness, resumed, .. } => Some(format!("conversation: {harness}{}", if resumed { ", resumed" } else { "" })),
                Payload::Recovery { kind: Some(kind) } => Some(format!("recovery: {kind:?}")),
                _ => None,
            })
            .collect()
    }

    fn status(&self, tab: &str) -> TabStatus {
        self.manager.status_of(SESSION, tab)
    }

    fn runtime(&self, tab: &str) -> Arc<Mutex<TabRuntime>> {
        self.manager.runtime(SESSION, tab).unwrap()
    }

    /// Whether the tab has let go of its agent, with nothing left for the reader to recover from.
    fn settled_as_terminal(&self, tab: &str) -> bool {
        let rt = self.runtime(tab);
        let rt = rt.lock().unwrap();
        matches!(rt.engine, Engine::None) && rt.recovery.is_none() && !rt.turn_open && rt.pending.is_empty() && rt.status == TabStatus::Idle
    }

    fn wait(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "never happened: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The tab's own CLI as the app launches one, less the CLI: a pane whose
    /// program exits when it is given a line, and a runtime that holds it.
    fn launched(&self, tab: &str, kind: CliKind, transcript: &Path) -> String {
        let pane = SessionManager::pane_id(tab);
        self.pane(&pane, "sh -c 'read line'");
        let (decode, marker): (tui::Decoder, tui::Marker) = match kind {
            CliKind::Claude => (claude::transcript::decode_line, claude::transcript::decode_marked),
            CliKind::Codex => (codex::rollout::decode_line, codex::rollout::decode_marked),
        };
        let tail = Arc::new(tui::Tail::opening(transcript.to_path_buf(), decode, Default::default()).marking(marker));
        let generation = self.manager.starts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let rt_arc = self.runtime(tab);
        rt_arc.lock().unwrap().engine = Engine::Cli(CliTab {
            usage_account: None,
            harness: kind,
            mode: "default".into(),
            pane_id: pane.clone(),
            nudge_by: None,
            held: Vec::new(),
            resend_after_abort: None,
            codex_interrupt_hooks_owed: 0,
            codex_prompt_starts_turn: false,
            generation,
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
            decisions: HashMap::new(),
            turn_tail: Default::default(),
            transcript_turn: None,
            transcript_end_owed: false,
            answered: HashMap::new(),
            command: "claude".into(),
            origin: Origin { token: crate::hooks::mint_token(), transcript_root: self.dir.path().to_path_buf(), conversation: None },
            by_hand: None,
        });
        self.manager.follow_transcript(&rt_arc, tail, pane.clone(), generation);
        pane
    }

    /// The reader exits the CLI in `pane`.
    fn exit(&self, pane: &str) {
        self.manager.terminals.write(pane, b"bye\n").unwrap();
    }

    /// `agent` as the watcher reports one that has `pane`'s terminal: its
    /// job is the one the terminal gives its input to. Here that is whatever
    /// the pane runs, which stands for the CLI.
    fn in_front(&self, pane: &str, agent: Agent) -> Agent {
        let front = || self.manager.terminals.fronts().into_iter().find(|front| front.id == pane && front.foreground == front.pid);
        self.wait("the pane's program to have its terminal", || front().is_some());
        Agent { job: front().unwrap().foreground, ..agent }
    }

    /// What has been typed into `pane`, as its terminal echoed it.
    fn typed(&self, pane: &str) -> String {
        String::from_utf8_lossy(&self.manager.terminals.read_output(pane).unwrap_or_default()).into_owned()
    }
}

fn agent_tab(id: &str, harness: &str, conversation: &str) -> serde_json::Value {
    json!({ "id": id, "harness": harness, "permissionMode": "default", "providerSessionId": conversation, "created": index::now() })
}

#[test]
fn a_shell_becomes_the_tab_of_the_agent_started_in_it_and_a_terminal_again_when_it_exits() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    let opened = rig.manager.terminals.opened(&pane).unwrap().1;
    let transcript = rig.dir.path().join("claude.jsonl");

    // The reader types `claude`. It names its conversation at once and writes nothing until it is prompted.
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &transcript)), Some(Activity::Idle));
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();
    assert_eq!((tab.harness.as_str(), tab.follow.front, tab.provider_session_id.as_deref()), ("claude", Front::ByHand, Some(CLAUDE_ID)));
    // It is the shell's tab still: in its pane, in its place, and it goes by the shell's name when it is a terminal.
    assert_eq!((tab.pane_id(), tab.created.clone(), tab.follow.terminal_title.as_deref()), (pane.clone(), opened.clone(), Some("Terminal 1")));
    assert!(tab.follow.adopted && !tab.follow.title_pinned && tab.title.is_none());
    assert_eq!(tab.permission_mode, follow::MODE_SET_IN_TERMINAL);
    assert_eq!(rig.manager.pane_agents().iter().map(|front| (front.pane_id.clone(), front.harness.clone())).collect::<Vec<_>>(), [(pane.clone(), Some("claude".into()))]);
    let shown = rig.manager.pane_of(SESSION, &tab.id).unwrap();
    assert!(shown.by_hand && !shown.terminal && shown.pane_id == pane);
    assert_eq!(rig.status(&tab.id), TabStatus::Idle);

    // The first turn, as the CLI writes it.
    rig.told.doing(CLAUDE_PID, Activity::Busy);
    append(&transcript, &claude_turns(1).lines().take(10).map(|line| format!("{line}\n")).collect::<String>());
    rig.wait("the prompt in the chat", || rig.said(&tab.id) == ["user: Reply with exactly: pong"]);
    rig.wait("working", || rig.status(&tab.id) == TabStatus::InProgress);
    append(&transcript, &claude_turns(1).lines().skip(10).map(|line| format!("{line}\n")).collect::<String>());
    rig.told.doing(CLAUDE_PID, Activity::Idle);
    rig.wait("the reply and the turn's end", || rig.said(&tab.id) == ["user: Reply with exactly: pong", "claude: pong", "turn Ok"]);
    assert_eq!(rig.status(&tab.id), TabStatus::Completed);
    // The conversation names the tab, as it does one the app started.
    assert_eq!(rig.tab().title.as_deref(), Some("Reply with exactly: pong"));

    // The reader exits it. Nothing went wrong: the tab is a terminal, and nothing is raised.
    rig.manager.pane_foreground(&pane, None);
    let after = rig.tab();
    assert_eq!((after.id.as_str(), after.follow.front, after.created.as_str(), after.pane_id()), (tab.id.as_str(), Front::Terminal, opened.as_str(), pane.clone()));
    assert!(rig.settled_as_terminal(&tab.id));
    assert_eq!(rig.said(&tab.id), ["user: Reply with exactly: pong", "claude: pong", "turn Ok", "status: Claude Code exited."]);
    assert!(rig.manager.pane_agents().is_empty());
    // Its shell was never touched.
    assert!(rig.manager.terminals.is_running(&pane));
    let shown = rig.manager.pane_of(SESSION, &tab.id).unwrap();
    assert!(shown.terminal && !shown.by_hand);

    // Codex next, in the same terminal. It has a conversation id before it has a rollout.
    let rollout = rig.dir.path().join("rollout.jsonl");
    rig.told.set(CODEX_PID, Some(Located { provider_session_id: CODEX_ID.into(), transcript: None }), None);
    rig.manager.pane_foreground(&pane, Some(agent("codex", CODEX_PID)));
    let codex = rig.tab();
    assert_eq!((codex.id.as_str(), codex.harness.as_str(), codex.follow.front, codex.provider_session_id.as_deref()), (tab.id.as_str(), "codex", Front::ByHand, Some(CODEX_ID)));
    assert_eq!((codex.created.as_str(), codex.pane_id()), (opened.as_str(), pane.clone()));
    // The Claude conversation is the tab's still, as one it held before.
    assert_eq!(codex.follow.history.iter().map(|past| (past.harness.as_str(), past.provider_session_id.as_deref(), past.title.as_deref(), past.id.as_deref())).collect::<Vec<_>>(), [("claude", Some(CLAUDE_ID), Some("Reply with exactly: pong"), None)]);
    assert!(codex.follow.conversation.is_some() && codex.title.is_none());

    // The first prompt makes the rollout.
    rig.told.set(CODEX_PID, Some(located(CODEX_ID, &rollout)), None);
    append(&rollout, &codex_first_turn());
    rig.wait("the Codex turn", || rig.said(&tab.id).last().is_some_and(|last| last == "turn Ok") && rig.said(&tab.id).len() > 6);
    let said = rig.said(&tab.id);
    assert_eq!(said[..5], ["user: Reply with exactly: pong", "claude: pong", "turn Ok", "status: Claude Code exited.", "conversation: codex"]);
    assert!(said[5].starts_with("user: ") && said[6..].iter().any(|line| line.starts_with("codex: ")), "{said:?}");
    assert_eq!(rig.status(&tab.id), TabStatus::Completed);
    // Its events come after its marker and under its own harness: neither conversation runs into the other.
    let events = rig.events(&tab.id);
    let marker = events.iter().position(|event| matches!(&event.payload, Payload::Conversation { id, .. } if *id == codex.follow.conversation)).unwrap();
    assert!(events[..marker].iter().all(|event| event.harness == "claude") && events[marker..].iter().all(|event| event.harness == "codex"));
    // And it is named for what was asked of Codex, not of Claude.
    let named = rig.tab().title.unwrap();
    assert!(said[5].strip_prefix("user: ").is_some_and(|asked| asked.eq_ignore_ascii_case(&named)), "{named:?} for {:?}", said[5]);

    rig.manager.pane_foreground(&pane, None);
    assert_eq!(rig.tab().follow.front, Front::Terminal);
    assert!(rig.settled_as_terminal(&tab.id));
    assert_eq!(rig.said(&tab.id).last().unwrap(), "status: Codex exited.");
    assert!(!rig.said(&tab.id).iter().any(|line| line.starts_with("recovery")));
}

/// What the reader arranged for a shell in its workspace's row of tabs (its
/// place, a pin, a title of their own) is the tab's when an agent is started
/// in the shell (#438). A window hears of the tab before it hears where the
/// tab goes, so it never sees it out of its place.
#[test]
fn a_shell_an_agent_is_started_in_keeps_its_place_in_the_row_of_tabs() {
    let rig = Rig::new(json!([]));
    let (pane, other) = (rig.shell(1), rig.shell(2));
    let workspace = rig.dir.path().to_string_lossy().into_owned();
    let (shell_key, other_key) = (format!("terminal:{pane}"), format!("terminal:{other}"));
    let arranged: index::TabLayout =
        serde_json::from_value(json!({ "order": [other_key.clone(), shell_key.clone()], "pinned": [shell_key.clone()], "titles": { shell_key.clone(): "dev server" } })).unwrap();
    index::set_tab_layout(&workspace, arranged).unwrap();
    let mut heard = rig.sink.subscribe();

    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &rig.dir.path().join("claude.jsonl"))), Some(Activity::Idle));
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));

    let tab_key = format!("agent:{}", rig.tab().id);
    let now = index::tab_state().unwrap().workspaces.remove(&workspace).unwrap();
    assert_eq!(now.order, [other_key.clone(), tab_key.clone()]);
    assert_eq!(now.pinned, std::slice::from_ref(&tab_key));
    assert_eq!(now.titles.get(&tab_key).map(String::as_str), Some("dev server"));
    let mut events = Vec::new();
    while let Ok(published) = heard.try_recv() {
        events.push(published);
    }
    let told = events.iter().position(|published| &*published.event == "tab_state_changed").expect("every window is told of the layout");
    assert!(events[told].payload.contains(&tab_key) && !events[told].payload.contains(&shell_key));
    assert!(events[..told].iter().any(|published| &*published.event == "session_updated" && published.payload.contains(&tab_key["agent:".len()..])), "the tab is announced first");

    // A shell nobody arranged is adopted without a word about layouts.
    let mut heard = rig.sink.subscribe();
    rig.told.set(CODEX_PID, Some(Located { provider_session_id: CODEX_ID.into(), transcript: None }), None);
    rig.manager.pane_foreground(&rig.shell(3), Some(agent("codex", CODEX_PID)));
    let mut again = Vec::new();
    while let Ok(published) = heard.try_recv() {
        again.push(published.event.to_string());
    }
    assert!(!again.iter().any(|event| event == "tab_state_changed"), "{again:?}");
    assert_eq!(index::tab_state().unwrap().workspaces[&workspace].order, [other_key, tab_key]);
}

#[test]
fn an_agent_tab_becomes_a_terminal_when_its_cli_exits_and_follows_what_is_started_there_next() {
    let rig = Rig::new(json!([agent_tab("t1", "claude", CLAUDE_ID)]));
    let transcript = rig.dir.path().join("claude.jsonl");
    let pane = rig.launched("t1", CliKind::Claude, &transcript);
    let created = rig.tab().created;
    append(&transcript, &claude_turns(1));
    rig.wait("the turn the app's own CLI ran", || rig.said("t1") == ["user: Reply with exactly: pong", "claude: pong"]);
    // No hook closes a turn here; the test closes it as the Stop hook would.
    {
        let rt = rig.runtime("t1");
        let mut rt = rt.lock().unwrap();
        rig.manager.end_open_turn(&mut rt, TurnStatus::Ok, None);
    }

    // The reader exits the CLI from the terminal view.
    rig.exit(&pane);
    rig.wait("the tab to become a terminal", || rig.tab().follow.front == Front::Terminal);
    assert!(rig.settled_as_terminal("t1"));
    assert_eq!(rig.said("t1"), ["user: Reply with exactly: pong", "claude: pong", "turn Ok", "status: Claude Code exited."]);
    // A shell took the CLI's place in the same pane, and the window is told it is a terminal.
    rig.wait("a shell in the tab's pane", || rig.manager.terminals.is_running(&pane));
    let shown = rig.manager.pane_of(SESSION, "t1").unwrap();
    assert!(shown.terminal && shown.pane_id == pane);
    assert_eq!((rig.tab().id.as_str(), rig.tab().created, rig.tab().harness.as_str()), ("t1", created.clone(), "claude"));

    // Codex is typed into that shell.
    let rollout = rig.dir.path().join("rollout.jsonl");
    rig.told.set(CODEX_PID, Some(located(CODEX_ID, &rollout)), None);
    rig.manager.pane_foreground(&pane, Some(agent("codex", CODEX_PID)));
    let tab = rig.tab();
    assert_eq!((tab.id.as_str(), tab.harness.as_str(), tab.follow.front, tab.created.clone()), ("t1", "codex", Front::ByHand, created.clone()));
    // The conversation the app started is kept as the app's own; the one started by hand is the reader's.
    assert_eq!(tab.follow.history.iter().map(|past| (past.provider_session_id.as_deref(), past.adopted)).collect::<Vec<_>>(), [(Some(CLAUDE_ID), false)]);
    assert!(tab.follow.adopted);
    append(&rollout, &codex_first_turn());
    rig.wait("the Codex turn", || rig.said("t1").last().is_some_and(|last| last == "turn Ok") && rig.said("t1").iter().any(|line| line.starts_with("codex: ")));
    rig.manager.pane_foreground(&pane, None);
    assert!(rig.settled_as_terminal("t1"));

    // Claude Code again, by hand, on the conversation the tab began with: it is picked up, not opened a second time.
    let before = rig.said("t1");
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &transcript)), Some(Activity::Idle));
    std::fs::File::options().write(true).open(&transcript).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();
    assert_eq!((tab.harness.as_str(), tab.provider_session_id.as_deref(), tab.follow.conversation.as_deref(), tab.follow.adopted), ("claude", Some(CLAUDE_ID), None, false));
    assert_eq!(tab.follow.history.iter().map(|past| (past.harness.as_str(), past.provider_session_id.as_deref())).collect::<Vec<_>>(), [("codex", Some(CODEX_ID))]);
    assert_eq!(tab.title.as_deref(), Some("Reply with exactly: pong"));
    // Nothing of it is brought in again: the log has its turns from when they happened.
    let mut expected = before.clone();
    expected.push("conversation: claude, resumed".into());
    assert_eq!(rig.said("t1"), expected);
    // What is said next belongs to it.
    append(&transcript, &claude_user_record("and again"));
    append(&transcript, &claude_reply_record("again"));
    rig.wait("the resumed conversation's next turn", || rig.said("t1").ends_with(&["user: and again".to_string(), "claude: again".to_string()]));
}

#[test]
fn an_exit_in_the_middle_of_a_turn_ends_the_turn_as_interrupted_and_says_so_once() {
    let rig = Rig::new(json!([agent_tab("t1", "claude", CLAUDE_ID)]));
    let transcript = rig.dir.path().join("claude.jsonl");
    let pane = rig.launched("t1", CliKind::Claude, &transcript);
    append(&transcript, &claude_user_record("a long job"));
    rig.wait("a running turn", || rig.status("t1") == TabStatus::InProgress);

    rig.exit(&pane);
    rig.wait("the tab to become a terminal", || rig.tab().follow.front == Front::Terminal);
    assert_eq!(rig.said("t1"), ["user: a long job", "turn Aborted", "status: Claude Code exited before the turn finished."]);
    assert!(rig.settled_as_terminal("t1"));
    // The exit is heard twice, from the pane and from the thread following the transcript, and settled once.
    rig.wait("a shell in the tab's pane", || rig.manager.terminals.is_running(&pane));
    std::thread::sleep(tui::POLL_INTERVAL * 3);
    assert_eq!(rig.said("t1").len(), 3);
    assert!(rig.settled_as_terminal("t1"));
    // Opening its log again finds nothing to recover either.
    rig.manager.load_events(SESSION, "t1").unwrap();
    assert!(rig.settled_as_terminal("t1"));
}

#[test]
fn a_runtime_that_does_not_follow_terminals_treats_an_exit_as_it_always_did() {
    let rig = Rig::not_following(json!([agent_tab("t1", "claude", CLAUDE_ID)]));
    let transcript = rig.dir.path().join("claude.jsonl");
    let pane = rig.launched("t1", CliKind::Claude, &transcript);
    append(&transcript, &claude_user_record("a long job"));
    rig.wait("a running turn", || rig.status("t1") == TabStatus::InProgress);

    rig.exit(&pane);
    rig.wait("the exit to be settled", || matches!(rig.runtime("t1").lock().unwrap().engine, Engine::None));
    assert_eq!(rig.tab().follow.front, Front::Agent);
    assert_eq!(rig.runtime("t1").lock().unwrap().recovery, Some(RecoveryKind::Failed));
    assert!(!rig.manager.terminals.is_running(&pane), "no shell is opened in a tab that stays its agent's");
    // And a hand-started agent is nothing to it.
    let shell = rig.shell(1);
    rig.manager.pane_foreground(&shell, Some(agent("claude", CLAUDE_PID)));
    assert_eq!(rig.tabs().len(), 1);
}

#[test]
fn a_conversation_the_app_has_never_seen_is_brought_in_from_its_first_turn() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    // `claude --resume`, on a conversation that was held somewhere else an hour ago.
    let transcript = rig.dir.path().join("claude.jsonl");
    append(&transcript, &claude_turns(2));
    std::fs::File::options().write(true).open(&transcript).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &transcript)), Some(Activity::Idle));
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let heard = statuses.clone();
    rig.sink.listen("tab_status", Box::new(move |payload| heard.lock().unwrap().push(payload.to_string())));

    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();
    // All of it is brought in, as turns that are over.
    rig.wait("the conversation's earlier turns", || rig.said(&tab.id).len() == 6);
    assert_eq!(rig.said(&tab.id), ["user: Reply with exactly: pong", "claude: pong", "turn Ok", "user: Reply with exactly: second", "claude: second", "turn Ok"]);
    // History is not work: the tab was never "working" or "completed" for it.
    assert_eq!(rig.status(&tab.id), TabStatus::Idle);
    assert!(statuses.lock().unwrap().is_empty(), "{:?}", statuses.lock().unwrap());
    assert_eq!(rig.tab().title.as_deref(), Some("Reply with exactly: pong"));

    // What is said from here on is followed as it happens.
    rig.told.doing(CLAUDE_PID, Activity::Busy);
    append(&transcript, &claude_user_record("third"));
    rig.wait("the live turn", || rig.status(&tab.id) == TabStatus::InProgress);
    append(&transcript, &claude_reply_record("3"));
    rig.told.doing(CLAUDE_PID, Activity::Idle);
    rig.wait("its end", || rig.said(&tab.id).ends_with(&["user: third".to_string(), "claude: 3".to_string(), "turn Ok".to_string()]));
    assert_eq!(rig.said(&tab.id).len(), 9);
}

#[test]
fn an_agent_that_has_yet_to_name_its_conversation_is_waited_for() {
    let rig = Rig::new(json!([agent_tab("t1", "claude", CLAUDE_ID)]));
    let transcript = rig.dir.path().join("claude.jsonl");
    let pane = rig.launched("t1", CliKind::Claude, &transcript);
    append(&transcript, &claude_turns(1));
    rig.wait("a turn of the tab's conversation", || rig.said("t1").len() == 2);
    rig.exit(&pane);
    rig.wait("the tab to become a terminal", || rig.tab().follow.front == Front::Terminal);
    rig.wait("a shell in the tab's pane", || rig.manager.terminals.is_running(&pane));
    std::fs::File::options().write(true).open(&transcript).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
    let before = rig.said("t1");

    // `claude -c`: seen before it has said anything, then under an id of its own, then under the one it continues.
    rig.told.set(CLAUDE_PID, None, None);
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();
    // Until it says which conversation it is on, the tab's own stands.
    assert_eq!((tab.follow.front, tab.provider_session_id.as_deref(), tab.follow.conversation.as_deref()), (Front::ByHand, Some(CLAUDE_ID), None));
    let passing = "7c0f3c0e-3a0b-4f5d-9d59-0c2f6b1a9e11";
    rig.told.set(CLAUDE_PID, Some(located(passing, &rig.dir.path().join("passing.jsonl"))), Some(Activity::Idle));
    rig.wait("the id it starts under", || rig.tab().provider_session_id.as_deref() == Some(passing));
    assert_eq!(rig.tab().follow.history.iter().map(|past| past.provider_session_id.clone()).collect::<Vec<_>>(), [Some(CLAUDE_ID.to_string())]);
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &transcript)), Some(Activity::Idle));
    rig.wait("the conversation it continues", || rig.tab().provider_session_id.as_deref() == Some(CLAUDE_ID));
    let tab = rig.tab();
    // The id nothing was ever said under leaves no conversation behind, and the tab is back on its own.
    assert!(tab.follow.history.is_empty(), "{:?}", tab.follow.history);
    assert_eq!(tab.follow.conversation, None);
    // Nothing of the conversation was brought in a second time.
    assert_eq!(rig.said("t1").iter().filter(|line| line.starts_with("user: ")).count(), before.iter().filter(|line| line.starts_with("user: ")).count());
}

#[test]
fn a_name_the_reader_gave_the_shell_is_the_tabs_whatever_runs_in_it() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(2);
    rig.manager.terminals.rename(&pane, "dev server");
    let transcript = rig.dir.path().join("claude.jsonl");
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &transcript)), Some(Activity::Idle));
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();
    assert_eq!((tab.title.as_deref(), tab.follow.title_pinned, tab.follow.terminal_title.as_deref()), (Some("dev server"), true, Some("dev server")));
    append(&transcript, &claude_turns(1));
    rig.wait("the turn", || rig.said(&tab.id).len() == 3);
    assert_eq!(rig.tab().title.as_deref(), Some("dev server"));
    rig.manager.pane_foreground(&pane, None);
    rig.told.set(CODEX_PID, Some(Located { provider_session_id: CODEX_ID.into(), transcript: None }), None);
    rig.manager.pane_foreground(&pane, Some(agent("codex", CODEX_PID)));
    let tab = rig.tab();
    assert_eq!((tab.title.as_deref(), tab.follow.title_pinned), (Some("dev server"), true));
    // The conversation it leaves keeps no name of its own: it never had one.
    assert_eq!(tab.follow.history[0].title, None);
}

#[test]
fn a_prompt_sent_from_the_chat_is_typed_into_the_hand_started_cli_and_drawn_once() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    let transcript = rig.dir.path().join("claude.jsonl");
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &transcript)), Some(Activity::Idle));
    rig.manager.pane_foreground(&pane, Some(rig.in_front(&pane, agent("claude", CLAUDE_PID))));
    let tab = rig.tab();

    let sent = rig.manager.send(SESSION, &tab.id, "hello from the chat".into(), Vec::new()).unwrap();
    assert!(!sent.queued);
    // It reaches the terminal the CLI is in: `cat` echoes what was typed at it.
    rig.wait("the prompt in the terminal", || rig.typed(&pane).contains("hello from the chat"));
    // The CLI records the prompt and answers; the chat shows each once. It
    // is quicker than the app looks: it is never seen busy, and the turn is
    // still closed once it has been idle a moment.
    append(&transcript, &claude_user_record("hello from the chat"));
    append(&transcript, &claude_reply_record("hello"));
    rig.wait("the reply and the turn's end", || rig.said(&tab.id).len() >= 3);
    assert_eq!(rig.said(&tab.id), ["user: hello from the chat", "claude: hello", "turn Ok"]);
    assert_eq!(rig.status(&tab.id), TabStatus::Completed);
    assert!(rig.runtime(&tab.id).lock().unwrap().recovery.is_none());
}

/// A CLI started by hand shares its pane with the shell it was started from.
/// When it exits, the watcher says so within a quarter of a second, and
/// until then the tab still holds it. A prompt that arrives in between is
/// not typed: the shell would run it as a command.
#[test]
fn a_prompt_is_never_typed_into_the_shell_a_hand_started_cli_has_left() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &rig.dir.path().join("claude.jsonl"))), Some(Activity::Idle));
    rig.manager.pane_foreground(&pane, Some(rig.in_front(&pane, agent("claude", CLAUDE_PID))));
    let tab = rig.tab();
    // The terminal gives its input to another job now, and nothing has told the tab.
    let leave = || {
        if let Engine::Cli(CliTab { by_hand: Some(by), .. }) = &mut rig.runtime(&tab.id).lock().unwrap().engine {
            by.agent.job = CLAUDE_PID;
        }
    };

    // It leaves while a prompt is on its way: sent while it was there, and typed after.
    let writer = rig.manager.writers.lock().unwrap().entry(pane.clone()).or_default().clone();
    let typing = writer.lock().unwrap();
    rig.manager.send(SESSION, &tab.id, "rm -rf build".into(), Vec::new()).unwrap();
    leave();
    drop(typing);
    // The thread that types holds the pane's writer for as long as it runs.
    rig.wait("the prompt's delivery to be over", || Arc::strong_count(&writer) == 2);
    assert!(!rig.typed(&pane).contains("rm -rf"), "{:?}", rig.typed(&pane));
    // Nothing went wrong that the reader has to recover from: the tab is about to be a terminal.
    assert!(rig.runtime(&tab.id).lock().unwrap().recovery.is_none());
    assert!(!rig.said(&tab.id).iter().any(|line| line.starts_with("recovery")));

    // One sent after it left is refused outright, and says why.
    let refused = rig.manager.send(SESSION, &tab.id, "make clean".into(), Vec::new()).unwrap_err();
    assert!(format!("{refused:#}").contains("no longer running in this tab's terminal"), "{refused:#}");
    // Nor is its shell sent the Escape that would have interrupted it.
    assert!(!rig.manager.interrupt(SESSION, &tab.id).unwrap());
    assert_eq!(rig.typed(&pane), "");
}

/// No hook closes the turn of a CLI started by hand: the transcript does.
/// Its record of a turn's end is acted on where it stands, so a turn that
/// ended and the prompt after it are two turns however they were read.
#[test]
fn a_turn_that_ends_and_the_prompt_after_it_are_two_turns_when_read_together() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    let transcript = rig.dir.path().join("claude.jsonl");
    // It says it is busy throughout: only the transcript says where one turn ends.
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &transcript)), Some(Activity::Busy));
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();
    let turn: Vec<String> = claude_turns(1).lines().map(|line| format!("{line}\n")).collect();
    append(&transcript, &turn[..10].concat());
    rig.wait("the first prompt", || rig.said(&tab.id) == ["user: Reply with exactly: pong"]);

    // The reply, the turn's end and a prompt that was waiting, in one write.
    append(&transcript, &format!("{}{}", turn[10..].concat(), claude_user_record("and then this")));
    rig.wait("the queued prompt", || rig.said(&tab.id).last().is_some_and(|last| last == "user: and then this"));
    assert_eq!(rig.said(&tab.id), ["user: Reply with exactly: pong", "claude: pong", "turn Ok", "user: and then this"]);
    rig.wait("the second turn to be open", || rig.runtime(&tab.id).lock().unwrap().turn_open && rig.status(&tab.id) == TabStatus::InProgress);
}

/// Esc in a hand-started Codex: the rollout says the turn was interrupted,
/// and it is not drawn, or reported to an automation, as one that finished.
#[test]
fn a_turn_interrupted_in_the_clis_own_screen_ends_as_interrupted() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    let rollout = rig.dir.path().join("rollout.jsonl");
    rig.told.set(CODEX_PID, Some(located(CODEX_ID, &rollout)), None);
    rig.manager.pane_foreground(&pane, Some(agent("codex", CODEX_PID)));
    let tab = rig.tab();
    let turn = codex_first_turn();
    let unfinished: String = turn.lines().take(turn.lines().count() - 1).map(|line| format!("{line}\n")).collect();
    append(&rollout, &unfinished);
    rig.wait("working", || rig.status(&tab.id) == TabStatus::InProgress);
    append(&rollout, &format!("{}\n", json!({ "timestamp": "2026-09-04T10:52:02.106Z", "type": "event_msg", "payload": { "type": "turn_aborted", "turn_id": "turn-1", "reason": "interrupted" } })));
    rig.wait("the turn's end", || !rig.runtime(&tab.id).lock().unwrap().turn_open);
    assert_eq!(rig.said(&tab.id).last().unwrap(), "turn Aborted");
    assert_ne!(rig.status(&tab.id), TabStatus::Completed);
    assert!(rig.runtime(&tab.id).lock().unwrap().recovery.is_none());
}

/// `codex resume <id>`: Codex takes the conversation's lock before it opens
/// its rollout, so the tab is on the conversation by name before there is
/// anything to read. Being on it by name is not having read it.
#[test]
fn a_conversation_named_before_it_says_where_it_is_written_is_still_brought_in_whole() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    let rollout = rig.dir.path().join("rollout.jsonl");
    append(&rollout, &codex_first_turn());
    std::fs::File::options().write(true).open(&rollout).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
    rig.told.set(CODEX_PID, Some(Located { provider_session_id: CODEX_ID.into(), transcript: None }), None);
    rig.manager.pane_foreground(&pane, Some(agent("codex", CODEX_PID)));
    let tab = rig.tab();
    assert_eq!(tab.provider_session_id.as_deref(), Some(CODEX_ID));
    assert!(rig.said(&tab.id).is_empty());

    rig.told.set(CODEX_PID, Some(located(CODEX_ID, &rollout)), None);
    rig.wait("the conversation's earlier turn", || rig.said(&tab.id).last().is_some_and(|last| last == "turn Ok"));
    let said = rig.said(&tab.id);
    assert!(said[0].starts_with("user: ") && said.iter().any(|line| line.starts_with("codex: ")), "{said:?}");
    // It is the tab's first conversation and history, not work: nothing was started for it.
    assert_eq!((rig.tab().follow.conversation, rig.tab().follow.history.len(), rig.status(&tab.id)), (None, 0, TabStatus::Idle));
}

/// `claude --resume <id> --fork-session`: the fork's file is made by its
/// first prompt, and arrives holding a copy of the parent's turns. They are
/// the conversation's history, not turns happening now.
#[test]
fn a_fork_arrives_holding_its_parents_turns_and_they_are_history() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    let fork = rig.dir.path().join("fork.jsonl");
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &fork)), Some(Activity::Idle));
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let heard = statuses.clone();
    rig.sink.listen("tab_status", Box::new(move |payload| heard.lock().unwrap().push(payload.to_string())));
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();

    rig.told.doing(CLAUDE_PID, Activity::Busy);
    append(&fork, &format!("{}{}", claude_turns(2), claude_user_record("and now this")));
    rig.wait("the prompt it is on", || rig.said(&tab.id).last().is_some_and(|last| last == "user: and now this"));
    assert_eq!(rig.said(&tab.id), ["user: Reply with exactly: pong", "claude: pong", "turn Ok", "user: Reply with exactly: second", "claude: second", "turn Ok", "user: and now this"]);
    rig.wait("working on it", || rig.status(&tab.id) == TabStatus::InProgress);
    // The parent's turns never made the tab "completed": only the one it is on is work.
    assert!(!statuses.lock().unwrap().iter().any(|status| status.contains("completed")), "{:?}", statuses.lock().unwrap());
}

/// An agent exited while it was asking for permission. What it asked went
/// with it, and reading the log again raises nothing for a tab that has
/// nothing wrong with it.
#[test]
fn an_ask_left_unanswered_when_the_agent_exited_is_nothing_to_recover_from() {
    let rig = Rig::new(json!([agent_tab("t1", "claude", CLAUDE_ID)]));
    let transcript = rig.dir.path().join("claude.jsonl");
    let pane = rig.launched("t1", CliKind::Claude, &transcript);
    append(&transcript, &claude_turns(1).lines().take(10).map(|line| format!("{line}\n")).collect::<String>());
    rig.wait("the prompt", || rig.said("t1") == ["user: Reply with exactly: pong"]);
    rig.runtime("t1").lock().unwrap().pending.insert("ask".into(), PendingAsk { tool_use_id: "tool".into(), tool_name: "Bash".into(), input: json!({}), suggestions: Vec::new() });

    rig.exit(&pane);
    rig.wait("the tab to become a terminal", || rig.tab().follow.front == Front::Terminal);
    assert!(rig.settled_as_terminal("t1"));
    let events = rig.events("t1");
    let decided: Vec<&str> = events.iter().filter_map(|event| match &event.payload { Payload::PermissionDecided { label, .. } => Some(label.as_str()), _ => None }).collect();
    assert_eq!(decided, ["Cancelled"]);
    // As the next window, or the next launch, reads it.
    assert_eq!(recovery::from_history(&events), None);
}

/// The exit that makes a tab a terminal and the window that then opens it
/// both ask for the tab's shell. It is given one, whoever asks and however
/// many ask at once.
#[test]
fn a_tab_opened_from_several_places_at_once_is_given_one_shell() {
    let rig = Rig::new(json!([agent_tab("t1", "claude", CLAUDE_ID)]));
    index::update_tab(SESSION, "t1", |tab| {
        tab.follow.front = Front::Terminal;
        Ok(())
    })
    .unwrap();
    let pane = SessionManager::pane_id("t1");
    let shell = |manager: &SessionManager| manager.terminals.fronts().into_iter().find(|front| front.id == pane).map(|front| front.pid);
    let seen: Vec<Option<u32>> = std::thread::scope(|scope| {
        let asking: Vec<_> = (0..8)
            .map(|_| {
                let manager = rig.manager.clone();
                let shell = &shell;
                scope.spawn(move || {
                    manager.ensure_started(SESSION, "t1").unwrap();
                    shell(&manager)
                })
            })
            .collect();
        asking.into_iter().map(|asked| asked.join().unwrap()).collect()
    });
    let now = shell(&rig.manager);
    assert!(now.is_some() && seen.iter().all(|pid| *pid == now), "{seen:?} then {now:?}");
    assert!(rig.manager.terminals.is_running(&pane));
}

#[test]
fn what_needs_the_cli_restarted_is_refused_for_one_started_by_hand_and_says_why() {
    let rig = Rig::new(json!([]));
    let (claude, codex) = (rig.shell(1), rig.shell(2));
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &rig.dir.path().join("claude.jsonl"))), Some(Activity::Idle));
    rig.told.set(CODEX_PID, Some(Located { provider_session_id: CODEX_ID.into(), transcript: None }), None);
    rig.manager.pane_foreground(&claude, Some(rig.in_front(&claude, agent("claude", CLAUDE_PID))));
    rig.manager.pane_foreground(&codex, Some(agent("codex", CODEX_PID)));
    let tabs = rig.tabs();
    let tab = |harness: &str| tabs.iter().find(|tab| tab.harness == harness).unwrap().id.clone();
    let refused = |outcome: Result<()>| {
        let message = format!("{:#}", outcome.unwrap_err());
        assert!(message.contains("started by hand") && message.contains("cannot restart"), "{message}");
    };

    // Either CLI reads its permission mode at startup only.
    refused(rig.manager.set_permission_mode(SESSION, &tab("claude"), "plan"));
    refused(rig.manager.set_permission_mode(SESSION, &tab("codex"), "plan"));
    // Codex takes a model or an effort by being restarted.
    refused(rig.manager.set_model(SESSION, &tab("codex"), "gpt-5"));
    refused(rig.manager.set_effort(SESSION, &tab("codex"), Some("high")));
    // Claude Code takes them while it runs, typed into it like any command.
    rig.manager.set_model(SESSION, &tab("claude"), "opus").unwrap();
    rig.wait("the command in the terminal", || rig.typed(&claude).contains("/model opus"));
    // Nothing was changed for the ones refused.
    assert!(rig.tabs().iter().all(|tab| tab.requested_permission_mode.is_none() && tab.permission_mode == follow::MODE_SET_IN_TERMINAL));
    // A guest of a shared session cannot drive a CLI the host started by hand.
    let guest = crate::local_sharing::Person { user_id: "guest".into(), display_name: "Guest".into(), email: String::new(), email_verified: false, organization_ids: Vec::new() };
    let permit = crate::local_sharing::WritePermit { share_generation: String::new(), connection_id: "c".into(), revision: 0, tab_epoch: 0 };
    let refused = rig.manager.send_shared(SESSION, &tab("claude"), "hi".into(), guest.clone(), permit.clone()).unwrap_err();
    assert!(format!("{refused:#}").contains("Only the host can send to it"), "{refused:#}");
    // Nor start an agent in a tab that is a terminal.
    rig.manager.pane_foreground(&claude, None);
    let refused = rig.manager.send_shared(SESSION, &tab("claude"), "hi".into(), guest, permit).unwrap_err();
    assert!(format!("{refused:#}").contains("Only the host can start one"), "{refused:#}");
    assert_eq!(rig.tabs().iter().find(|entry| entry.harness == "claude").unwrap().follow.front, Front::Terminal);
}

#[test]
fn stop_ends_a_hand_started_cli_and_leaves_the_shell_it_was_started_from() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    // A process of its own stands for the CLI, so Stop has something to end.
    let mut child = std::process::Command::new("sleep").arg("600").spawn().unwrap();
    let pid = child.id();
    let reaped = std::thread::spawn(move || child.wait().unwrap());
    rig.told.set(pid, Some(located(CLAUDE_ID, &rig.dir.path().join("claude.jsonl"))), Some(Activity::Busy));
    rig.manager.pane_foreground(&pane, Some(agent("claude", pid)));
    let tab = rig.tab();
    rig.wait("working", || rig.status(&tab.id) == TabStatus::InProgress);

    rig.manager.stop(SESSION, &tab.id).unwrap();
    assert!(!reaped.join().unwrap().success());
    assert_eq!(rig.tab().follow.front, Front::Terminal);
    assert!(rig.settled_as_terminal(&tab.id));
    assert_eq!(rig.said(&tab.id), ["turn Aborted", "status: Claude Code exited before the turn finished."]);
    assert!(rig.manager.terminals.is_running(&pane));
    assert!(rig.manager.pane_agents().is_empty());
}

#[test]
fn a_suspended_agent_gives_the_tab_back_and_takes_it_again() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    let transcript = rig.dir.path().join("claude.jsonl");
    // This process stands for the CLI: it is still there when the shell takes the terminal back.
    let pid = std::process::id();
    rig.told.set(pid, Some(located(CLAUDE_ID, &transcript)), Some(Activity::Idle));
    rig.manager.pane_foreground(&pane, Some(agent("claude", pid)));
    let tab = rig.tab();
    append(&transcript, &claude_turns(1));
    rig.wait("the turn", || rig.said(&tab.id).len() == 3);

    rig.manager.pane_foreground(&pane, None);
    assert_eq!(rig.tab().follow.front, Front::Terminal);
    assert_eq!(rig.said(&tab.id).last().unwrap(), "status: Claude Code was suspended in the terminal.");
    // `fg`: the same conversation, read on from where the tab had got to.
    append(&transcript, &claude_user_record("while you were away"));
    rig.manager.pane_foreground(&pane, Some(agent("claude", pid)));
    rig.wait("what was written in between", || rig.said(&tab.id).last().unwrap() == "user: while you were away");
    let tab = rig.tab();
    assert_eq!((tab.follow.front, tab.follow.conversation.as_deref(), tab.follow.history.len()), (Front::ByHand, None, 0));
    assert_eq!(rig.said(&tab.id).iter().filter(|line| line.starts_with("user: Reply")).count(), 1);
}

#[test]
fn a_tab_that_is_a_terminal_is_opened_as_one_and_resumes_only_a_conversation_of_its_own() {
    let rig = Rig::new(json!([agent_tab("t1", "claude", CLAUDE_ID)]));
    index::update_tab(SESSION, "t1", |tab| {
        tab.follow.front = Front::Terminal;
        Ok(())
    })
    .unwrap();
    let opened = Arc::new(Mutex::new(Vec::new()));
    let heard = opened.clone();
    rig.sink.listen("tab_pty", Box::new(move |payload| heard.lock().unwrap().push(serde_json::from_str::<Value>(payload).unwrap())));

    // Opening it gives it a shell, and starts no agent.
    rig.manager.ensure_started(SESSION, "t1").unwrap();
    let pane = SessionManager::pane_id("t1");
    assert!(rig.manager.terminals.is_running(&pane));
    assert!(matches!(rig.runtime("t1").lock().unwrap().engine, Engine::None));
    assert_eq!(opened.lock().unwrap().iter().map(|event| (event["paneId"].as_str().map(String::from), event["terminal"].as_bool())).collect::<Vec<_>>(), [(Some(pane.clone()), Some(true))]);
    assert_eq!(rig.tab().follow.front, Front::Terminal);

    let refused = rig.manager.resume_conversation(SESSION, "t1", "claude", "6c1b0a3e-1c62-4f6c-8a55-2b7a4b0f9d10").unwrap_err();
    assert!(format!("{refused:#}").contains("not one of this tab's"));
    assert_eq!(rig.tab().follow.front, Front::Terminal);
}

#[test]
fn a_tab_that_never_ran_takes_the_conversation_started_in_it_by_hand_as_the_readers_own() {
    // Made for Claude Code and never started: it has no conversation of its own yet.
    let rig = Rig::new(json!([{ "id": "t1", "harness": "claude", "permissionMode": "default", "created": index::now(), "front": "terminal" }]));
    let pane = SessionManager::pane_id("t1");
    rig.pane(&pane, "cat");
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &rig.dir.path().join("claude.jsonl"))), Some(Activity::Idle));
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();
    // The conversation is the tab's first, not a second one beside an empty first.
    assert_eq!((tab.follow.front, tab.provider_session_id.as_deref(), tab.follow.conversation.as_deref(), tab.follow.history.len()), (Front::ByHand, Some(CLAUDE_ID), None, 0));
    // The reader started it: it is theirs, and is not deleted with the session.
    assert!(tab.follow.adopted);
    assert!(rig.said("t1").is_empty());
}

#[test]
fn a_followed_cli_whose_terminal_the_app_closes_leaves_a_terminal_and_no_trace_of_trouble() {
    let rig = Rig::new(json!([]));
    let pane = rig.shell(1);
    rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &rig.dir.path().join("claude.jsonl"))), Some(Activity::Busy));
    rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
    let tab = rig.tab();
    rig.wait("working", || rig.status(&tab.id) == TabStatus::InProgress);

    // The session is moved, or its shells are closed: the pane goes, by the app's own hand.
    rig.manager.terminals.kill(&pane);
    rig.wait("the tab to let go of it", || matches!(rig.runtime(&tab.id).lock().unwrap().engine, Engine::None));
    assert_eq!(rig.tab().follow.front, Front::Terminal);
    assert!(rig.runtime(&tab.id).lock().unwrap().recovery.is_none());
    assert_eq!(rig.status(&tab.id), TabStatus::Idle);
    assert!(!rig.said(&tab.id).iter().any(|line| line.starts_with("recovery")));
    // Opened again, it is given a shell of its own.
    rig.manager.ensure_started(SESSION, &tab.id).unwrap();
    assert!(rig.manager.terminals.is_running(&pane));
    assert!(matches!(rig.runtime(&tab.id).lock().unwrap().engine, Engine::None));
}

#[test]
fn nothing_started_by_hand_outlives_the_app() {
    let _home = store::temp_home();
    let entry: index::SessionEntry = serde_json::from_value(json!({
        "id": SESSION, "projectPath": "/p", "cwd": "/p", "title": "t", "created": "x", "modified": "y",
        "tabs": [
            { "id": "by-hand", "harness": "codex", "created": "x", "front": "by_hand", "pane": "followed:1", "providerSessionId": CODEX_ID, "status": "in_progress" },
            { "id": "terminal", "harness": "claude", "created": "x", "front": "terminal", "pane": "followed:2", "terminalTitle": "Terminal 2" },
        ],
    }))
    .unwrap();
    index::save(&[entry]).unwrap();
    idle_orphaned_tabs();
    let tabs = index::get(SESSION).unwrap().tabs;
    // The CLI went with its terminal; its conversation is the tab's, for the app to resume.
    assert_eq!((tabs[0].follow.front, tabs[0].pane_id(), tabs[0].status, tabs[0].provider_session_id.as_deref()), (Front::Agent, "tab:by-hand".to_string(), TabStatus::Idle, Some(CODEX_ID)));
    // A terminal is a terminal still, in a pane of its own from here on.
    assert_eq!((tabs[1].follow.front, tabs[1].pane_id(), tabs[1].follow.terminal_title.as_deref()), (Front::Terminal, "tab:terminal".to_string(), Some("Terminal 2")));
}

#[test]
fn a_conversation_is_blank_until_something_is_said_in_it() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("tab.jsonl");
    assert!(conversation_is_blank(&log, None));
    let line = |payload: serde_json::Value| append(&log, &format!("{}\n", json!({ "id": "e", "sessionId": "s", "tabId": "t", "harness": "claude", "seq": 1, "ts": "now", "payload": payload })));
    line(json!({ "type": "status", "text": "starting" }));
    assert!(conversation_is_blank(&log, None));
    line(json!({ "type": "user_message", "text": "hello" }));
    assert!(!conversation_is_blank(&log, None));
    line(json!({ "type": "conversation", "id": "c2", "harness": "codex" }));
    assert!(conversation_is_blank(&log, Some("c2")));
    line(json!({ "type": "user_message", "text": "hi codex" }));
    assert!(!conversation_is_blank(&log, Some("c2")));
    // Back on the first one: what is said next is said in it.
    line(json!({ "type": "conversation", "harness": "claude", "resumed": true }));
    line(json!({ "type": "conversation", "id": "c3", "harness": "codex" }));
    assert!(conversation_is_blank(&log, Some("c3")) && !conversation_is_blank(&log, None));
}

/// The direct by-hand reader must carry the same launch fence as managed reads.
#[test]
fn by_hand_drained_history_and_live_records_cannot_cross_launches() {
    for (replace, empty) in [(false, false), (true, false), (false, true), (true, true)] {
        let rig = Rig::new(json!([]));
        let pane = rig.shell(1);
        let path = rig.dir.path().join("empty.jsonl");
        // An older, nonempty file selects History; a zero-byte file deliberately
        // has no historical first-read state. A blank line yields no records.
        std::fs::write(&path, "\n").unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_times(
            std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(60))
        ).unwrap();
        rig.told.set(CLAUDE_PID, Some(located(CLAUDE_ID, &path)), None);
        rig.manager.pane_foreground(&pane, Some(agent("claude", CLAUDE_PID)));
        let tab = rig.tab();
        let rt = rig.runtime(&tab.id);
        let tail = {
            let mut rt = rt.lock().unwrap();
            let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
            // Disable the automatic reader for this test's controlled read.
            p.generation += 1;
            p.tail.clone()
        };
        let captured = rig.dir.path().join("captured.jsonl");
        std::fs::write(&captured, CLAUDE_FIXTURE).unwrap();
        let read = tui::Tail::from_offset(captured, 0, claude::transcript::decode_line).marking(claude::transcript::decode_marked);
        let (paused_tx, paused_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let manager = rig.manager.clone();
        let current = rt.clone();
        let old_tail = tail.clone();
        let reader = std::thread::spawn(move || manager.pump_by_hand_from(&current, &old_tail, || {
            let records = if empty { Vec::new() } else { read.drain_records() };
            paused_tx.send(()).unwrap();
            resume_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            records
        }));
        paused_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if replace {
            let mut rt = rt.lock().unwrap();
            let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
            p.tail = Arc::new(tui::Tail::unknown(claude::transcript::decode_line));
            p.generation += 1;
            p.origin.token = crate::hooks::mint_token();
        }
        let before = rig.events(&tab.id);
        resume_tx.send(()).unwrap();
        reader.join().unwrap();
        if replace {
            assert_eq!(rig.events(&tab.id), before);
            rig.manager.pump_by_hand_from(&rt, &tail, || panic!("a stale tail must be rejected before consuming first-read state or reading"));
        } else if !empty {
            assert!(rig.events(&tab.id).len() > before.len());
            assert!(rig.said(&tab.id).iter().any(|line| line == "claude: pong"));
        }
        if empty {
            // A same-launch empty read restores History. A replaced launch
            // must not inherit that old first-read state: its next prompt is live.
            let current_tail = match &rt.lock().unwrap().engine { Engine::Cli(p) => p.tail.clone(), _ => unreachable!() };
            let fresh = rig.dir.path().join("fresh.jsonl");
            std::fs::write(&fresh, claude_user_record("fresh live prompt")).unwrap();
            let read = tui::Tail::from_offset(fresh, 0, claude::transcript::decode_line).marking(claude::transcript::decode_marked);
            rig.manager.pump_by_hand_from(&rt, &current_tail, || read.drain_records());
            let turn_open = rt.lock().unwrap().turn_open;
            assert_eq!(turn_open, replace, "only the unchanged launch restores historical first-read state");
        }
    }
}
