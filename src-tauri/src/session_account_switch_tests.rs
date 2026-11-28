//! Automatic account switching in the runtime (#981): a real tab whose CLI
//! is a stand-in, driven by the events its agent would send. The decision
//! itself has its own table tests (`agent_accounts/auto_switch_tests.rs`);
//! these cover what the runtime does with it: when it asks, what it sends,
//! what it says, and how a refused switch is undone.
//!
//! One rig per test, each with its own session id: an agent from one test
//! exiting late must not write into the next one's store.
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::agent_accounts::auto_switch::{LogEntry, Setting};

const TAB: &str = "agent";

struct Rig {
    manager: SessionManager,
    session: &'static str,
    program: PathBuf,
    _dir: tempfile::TempDir,
    _claude: claude::pty::TestProgram,
    _home: store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.closing();
        self.manager.terminals.kill_all();
    }
}

impl Rig {
    /// A session `session` with one Claude Code tab whose CLI is a stand-in
    /// that writes down the account directory it ran in, and two added
    /// accounts besides This Mac's login, with automatic switching on.
    fn new(session: &'static str) -> (Self, String, String) {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude");
        std::fs::write(&program, "#!/bin/sh\nprintf 'CLAUDE_CONFIG_DIR=%s\\n' \"$(printenv CLAUDE_CONFIG_DIR)\" > \"$0.tmp\" && mv \"$0.tmp\" \"$0.env\"\nprintf 'ready\\n'\nstty -icanon\nexec cat\n").unwrap();
        #[cfg(unix)]
        {
            #[cfg(unix)]
            use std::os::unix::fs::PermissionsExt;
            #[cfg(unix)]
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let claude = claude::pty::claude_program_for_tests(program.clone());
        let manager = SessionManager::new(
            Arc::new(crate::sink::BroadcastSink::new(1024)),
            Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()),
            Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        manager.follow_pane_exits();
        let checkout = dir.path().join("checkout");
        std::fs::create_dir(&checkout).unwrap();
        let entry = json!({
            "id": session, "projectPath": checkout, "cwd": checkout, "title": "Overnight run",
            "created": index::now(), "modified": index::now(),
            "tabs": [{ "id": TAB, "harness": "claude", "permissionMode": "default", "created": index::now() }],
        });
        index::save(&[serde_json::from_value(entry).unwrap()]).unwrap();
        let work = added_account("work@example.com");
        let side = added_account("side@example.com");
        let store = crate::agent_keys::store().unwrap();
        crate::agent_accounts::set_auto_switch_in(&store, Agent::Claude, Setting { enabled: true, ..Default::default() }).unwrap();
        let rig = Self { manager, session, program, _dir: dir, _claude: claude, _home: home };
        (rig, work, side)
    }

    /// Each account's 5-hour window, as the usage store would give it.
    fn usage(&self, used: &[(&str, f32)]) {
        let now = now_ms();
        let accounts = used.iter().map(|(id, used)| crate::status::usage::AccountUsage {
            agent: "claude".into(),
            usage: crate::agent_accounts::AgentAccountUsage {
                account_id: (*id).into(),
                label: (*id).into(),
                windows: vec![crate::status::usage::UsageWindow {
                    agent: "claude".into(), key: "five_hour".into(), label: "5-hour".into(), used_percent: *used,
                    resets_at: Some(now + 60 * 60_000), window_minutes: Some(300), updated_at: now, stale: false,
                    source: "test".into(), endpoint_running: true,
                }],
                error: None,
                unavailable: false,
            },
        }).collect();
        self.manager.switch_memory().usage_for_tests = Some(accounts);
    }

    /// Started on This Mac's login, and drawn.
    fn start(&self) {
        let _ = std::fs::remove_file(self.program.with_extension("env"));
        self.manager.ensure_started(self.session, TAB).unwrap();
        wait("the agent to start", || self.program.with_extension("env").is_file());
    }

    fn rt(&self) -> Arc<Mutex<TabRuntime>> {
        self.manager.runtime(self.session, TAB).unwrap()
    }

    /// What the tab's agent would send, applied as the runtime applies it.
    fn agent_says(&self, payload: Payload) {
        let rt = self.rt();
        let mut rt = rt.lock().unwrap();
        if !payload.is_turn_boundary() {
            rt.open_turn();
        }
        self.manager.apply(&mut rt, payload, None);
    }

    /// A prompt went in: its turn is open.
    fn turn_starts(&self) {
        self.rt().lock().unwrap().open_turn();
    }

    fn turn_ends(&self, auth_failed: bool) {
        self.agent_says(Payload::TurnCompleted {
            status: if auth_failed { TurnStatus::Error } else { TurnStatus::Ok },
            final_text: None, usage: None, duration_ms: None, head: None, auth_failed, detail: None,
        });
    }

    /// The account the tab is on now.
    fn account(&self) -> String {
        let entry = index::get(self.session).unwrap();
        crate::session_ops::tab_account(entry.tab(TAB).unwrap()).unwrap_or(LOCAL).to_string()
    }

    fn events(&self) -> Vec<AgentEvent> {
        store::read_lines::<AgentEvent>(&store::log_path(self.session, TAB).unwrap()).unwrap()
    }

    fn statuses(&self) -> Vec<String> {
        self.events().into_iter().filter_map(|event| match event.payload {
            Payload::Status { text, .. } => Some(text),
            _ => None,
        }).collect()
    }

    fn sent(&self, text: &str) -> usize {
        self.events().iter().filter(|event| matches!(&event.payload, Payload::UserMessage { text: sent, .. } if sent == text)).count()
    }

    /// This tab's lines of the switch log, oldest first.
    fn log(&self) -> Vec<LogEntry> {
        let mut log = auto_switch::read_log(now_ms()).unwrap();
        log.retain(|entry| entry.session_id == self.session);
        log.reverse();
        log
    }

    fn outcomes(&self) -> Vec<(Outcome, Option<String>)> {
        self.log().into_iter().map(|entry| (entry.outcome, entry.to)).collect()
    }
}

fn added_account(email: &str) -> String {
    let store = crate::agent_keys::store().unwrap();
    let id = crate::agent_accounts::new_id();
    crate::agent_accounts::create_private(&crate::agent_accounts::account_dir(&store.root, Agent::Claude, &id)).unwrap();
    let identity = crate::agent_accounts::Identity { email: Some(email.into()), plan: Some("Max".into()), ..Default::default() };
    crate::agent_accounts::add_signed_in(&store, Agent::Claude, &id, &identity, None, false).unwrap();
    id
}

fn wait(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !done() {
        assert!(Instant::now() < deadline, "never happened: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Long enough for anything a turn's end starts (it looks a moment later).
fn settle() {
    std::thread::sleep(AFTER_TURN + Duration::from_millis(300));
}

/// A limit hit in a turn: when the turn is over the tab moves once, says so,
/// and sends `continue` once; the next turn's end does not move it again.
#[test]
fn a_limit_hit_in_a_turn_switches_once_and_continues_once() {
    let (rig, work, side) = Rig::new("auto-switch-limit");
    rig.usage(&[(LOCAL, 40.0), (&work, 10.0), (&side, 30.0)]);
    rig.start();
    assert_eq!(rig.account(), LOCAL, "below the threshold the tab starts where it asked");

    rig.agent_says(Payload::RateLimited { status: Some("rejected".into()), resets_at: None, window: Some("five_hour".into()), message: None });
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(rig.account(), LOCAL, "never in a turn");
    assert!(rig.log().is_empty());

    let _ = std::fs::remove_file(rig.program.with_extension("env"));
    rig.turn_ends(false);
    wait("the switch", || rig.account() == work);
    wait("the agent to start again", || rig.program.with_extension("env").is_file());
    wait("the continue message", || rig.sent(crate::recovery::CONTINUE_PROMPT) == 1);
    let ran = std::fs::read_to_string(rig.program.with_extension("env")).unwrap();
    assert!(ran.contains(&work), "the agent runs on the account it moved to: {ran}");
    let line = rig.statuses().into_iter().find(|text| text.starts_with("Switched from ")).expect("the conversation says so");
    assert!(line.ends_with("hit its usage limit."), "{line}");
    assert_eq!(rig.outcomes(), [(Outcome::Switched, Some(work.clone()))]);

    // The continued turn ends; nothing more moves or is sent.
    rig.turn_ends(false);
    settle();
    assert_eq!(rig.account(), work);
    assert_eq!(rig.sent(crate::recovery::CONTINUE_PROMPT), 1, "one continue message");
    assert_eq!(rig.outcomes().len(), 1, "one switch");
}

/// Full past the threshold, a tab with a question waiting stays; once it
/// is answered, it moves between turns, with no `continue` (it was not
/// stopped).
#[test]
fn no_switch_while_a_question_waits() {
    let (rig, work, side) = Rig::new("auto-switch-question");
    rig.usage(&[(LOCAL, 20.0), (&work, 10.0), (&side, 30.0)]);
    rig.start();
    rig.usage(&[(LOCAL, 95.0), (&work, 10.0), (&side, 30.0)]);
    {
        let rt = rig.rt();
        let mut rt = rt.lock().unwrap();
        rt.pending.insert("ask".into(), PendingAsk { tool_use_id: "tool".into(), tool_name: "AskUserQuestion".into(), input: json!({}), suggestions: Vec::new() });
        rig.manager.set_status(&mut rt, TabStatus::Waiting);
    }
    rig.manager.consider_account_switch(rig.session, TAB);
    assert_eq!(rig.account(), LOCAL, "a waiting question keeps the tab where it is");
    assert!(rig.log().is_empty());

    // The typing guard holds it as well.
    {
        let rt = rig.rt();
        let mut rt = rt.lock().unwrap();
        rt.pending.clear();
        rig.manager.set_status(&mut rt, TabStatus::Completed);
    }
    rig.manager.note_typing(rig.session, TAB);
    rig.manager.consider_account_switch(rig.session, TAB);
    assert_eq!(rig.account(), LOCAL, "never while the person is typing");
    rig.manager.switch_memory().tab(&key_of(rig.session, TAB)).typed_at = None;

    rig.manager.consider_account_switch(rig.session, TAB);
    assert_eq!(rig.account(), work, "answered, it moves where there is the most room");
    let line = rig.statuses().into_iter().find(|text| text.starts_with("Switched from ")).unwrap();
    assert!(line.ends_with("reached 95% of its 5-hour limit."), "{line}");
    assert_eq!(rig.sent(crate::recovery::CONTINUE_PROMPT), 0, "nothing was stopped: no continue");
}

/// The account a tab moved to refuses its sign-in: the next account is
/// tried once, and when that refuses too the tab goes back where it was.
#[test]
fn a_refused_switch_tries_the_next_account_once_then_goes_back() {
    let (rig, work, side) = Rig::new("auto-switch-refused");
    rig.usage(&[(LOCAL, 20.0), (&work, 10.0), (&side, 30.0)]);
    rig.start();
    rig.usage(&[(LOCAL, 95.0), (&work, 10.0), (&side, 30.0)]);
    rig.manager.consider_account_switch(rig.session, TAB);
    assert_eq!(rig.account(), work);
    assert_eq!(rig.outcomes(), [(Outcome::Switched, Some(work.clone()))]);

    // Its first turn there: the provider refuses the sign-in.
    rig.turn_starts();
    rig.turn_ends(true);
    // The tab's account is written before its restart; the log line after it.
    wait("the next account", || rig.account() == side && rig.outcomes().len() >= 3);
    assert_eq!(rig.outcomes(), [
        (Outcome::Switched, Some(work.clone())),
        (Outcome::Failed, Some(work.clone())),
        (Outcome::Switched, Some(side.clone())),
    ]);

    // That one refuses as well: back on This Mac's login, and no third try.
    rig.turn_starts();
    rig.turn_ends(true);
    wait("the way back", || rig.account() == LOCAL && rig.outcomes().len() >= 4);
    wait("the line saying so", || rig.statuses().iter().any(|text| text.contains("Back on")));
    settle();
    assert_eq!(rig.account(), LOCAL);
    assert_eq!(rig.outcomes().iter().filter(|(outcome, _)| *outcome == Outcome::Switched).count(), 2, "the next account is tried once");
    assert_eq!(rig.outcomes().iter().filter(|(outcome, _)| *outcome == Outcome::Failed).count(), 2);
}

/// A follow-up held during a turn on a full account is sent after the
/// switch, on the new account, not before it on the full one.
#[test]
fn a_held_follow_up_goes_on_the_account_switched_to() {
    let (rig, work, side) = Rig::new("auto-switch-held");
    rig.usage(&[(LOCAL, 20.0), (&work, 10.0), (&side, 30.0)]);
    rig.start();
    rig.turn_starts();
    {
        let rt = rig.rt();
        let mut rt = rt.lock().unwrap();
        let mut queue = rt.held_queue.clone();
        queue.items.push(held::Item { id: "next".into(), text: "next task".into(), images: Vec::new(), files: Vec::new() });
        rig.manager.save_held(&mut rt, queue).unwrap();
    }
    // The account fills during the turn.
    rig.usage(&[(LOCAL, 93.0), (&work, 10.0), (&side, 30.0)]);
    rig.turn_ends(false);
    wait("the follow-up", || rig.sent("next task") == 1);
    assert_eq!(rig.account(), work);
    let events = rig.events();
    let switched = events.iter().position(|event| matches!(&event.payload, Payload::Status { text, .. } if text.starts_with("Switched from "))).expect("switched");
    let sent = events.iter().position(|event| matches!(&event.payload, Payload::UserMessage { text, .. } if text == "next task")).unwrap();
    assert!(switched < sent, "the switch comes before the follow-up");
    assert_eq!(rig.outcomes().len(), 1);

    // "Send now" is the person's own: it goes where the tab is.
    let rt = rig.rt();
    let mut rt = rt.lock().unwrap();
    let mut queue = rt.held_queue.clone();
    queue.items.push(held::Item { id: "now".into(), text: "right away".into(), images: Vec::new(), files: Vec::new() });
    queue.next = Some("now".into());
    rig.manager.save_held(&mut rt, queue).unwrap();
    assert!(!rig.manager.account_switch_holds_queue(&rt));
}
