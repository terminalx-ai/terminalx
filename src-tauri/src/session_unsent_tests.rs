//! A tab whose CLI never started its conversation, launched again (#663).
//!
//! Real panes, and a stand-in for Claude Code that notes how it was started
//! and then either listens (echoing what is typed at it, as a terminal does)
//! or refuses, as Claude Code 2.1.314 refuses a conversation it never wrote.
//! The case the issue was found on is here as it happened: a handoff written
//! into a CLI that never submitted it, a reboot, and "continue" sent to a tab
//! that then resumed nothing. Tests wait for what they expect to appear,
//! never for an amount of time to pass.
use std::time::Duration;

use serde_json::json;

use super::*;

const SESSION: &str = "unstarted";
const TAB: &str = "handoff";
const CONVERSATION: &str = "12cfb036-cbbc-41df-8868-fb0979d00bca";
const HANDOFF: &str = "Continue work from the prior TerminalX conversation using the context below. The original provider session is read-only.";

/// The stand-in once it has noted its arguments: up, and reading what it is
/// given as it comes, as a TUI does, while its terminal echoes it.
const LISTENS: &str = "printf 'listening\\n'\nstty -icanon\nexec cat\n";
/// Or up until it is given a line, and then gone, as when the reader quits it.
const QUITS: &str = "printf 'listening\\n'\nread line\n";
/// Or gone at once, saying why.
const REFUSES: &str = "printf 'No conversation found with session ID: 12cfb036\\n' >&2\nexit 1\n";

/// No CLI here was started by hand, so none needs finding.
struct Nowhere;

impl follow::Locator for Nowhere {
    fn locate(&self, _agent: &crate::foreground::Agent) -> Option<follow::Located> {
        None
    }
}

struct Rig {
    manager: SessionManager,
    checkout: PathBuf,
    ran: PathBuf,
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

fn claude_tab(continuation: Option<u64>) -> Value {
    json!({ "id": TAB, "harness": "claude", "permissionMode": "default", "providerSessionId": CONVERSATION, "continuation": continuation, "created": index::now() })
}

impl Rig {
    fn new(tab: Value, stand_in: &str) -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude");
        std::fs::write(&program, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.ran\"\n{stand_in}")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
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
        let entry: index::SessionEntry = serde_json::from_value(json!({
            "id": SESSION, "projectPath": checkout, "cwd": checkout, "title": "unstarted",
            "created": index::now(), "modified": index::now(), "tabs": [tab],
        }))
        .unwrap();
        index::save(&[entry]).unwrap();
        Self { manager, checkout, ran: program.with_extension("ran"), _dir: dir, _claude: claude, _home: home }
    }

    /// What the tab's log held before the app was started again.
    fn logged(&self, seq: u64, payload: Value) {
        let event = json!({ "id": format!("before-{seq}"), "sessionId": SESSION, "tabId": TAB, "harness": "claude", "seq": seq, "ts": index::now(), "payload": payload });
        store::append_line(&store::log_path(SESSION, TAB).unwrap(), &event.to_string()).unwrap();
    }

    fn wait(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "never happened: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The arguments the stand-in was started with, one a line.
    fn args(&self) -> Vec<String> {
        self.wait("the CLI to be started", || std::fs::read_to_string(&self.ran).is_ok_and(|ran| ran.ends_with('\n')));
        std::fs::read_to_string(&self.ran).unwrap().lines().map(String::from).collect()
    }

    fn rt(&self) -> Arc<Mutex<TabRuntime>> {
        self.manager.runtime(SESSION, TAB).unwrap()
    }

    /// Claude Code's `SessionStart` hook, as the stand-in has none.
    fn up(&self) {
        if let Engine::Cli(p) = &self.rt().lock().unwrap().engine {
            p.ready.mark();
        }
    }

    /// What was typed at the stand-in, as its terminal echoed it.
    fn typed(&self) -> String {
        String::from_utf8_lossy(&self.manager.terminals.read_output(&SessionManager::pane_id(TAB)).unwrap_or_default()).into_owned()
    }

    /// Where Claude Code writes the conversation, in the test's own home.
    fn transcript(&self) -> PathBuf {
        claude::transcript::transcript_in(&crate::agent_data::claude_projects_root().unwrap(), self.checkout.to_str().unwrap(), CONVERSATION)
    }

    /// Claude Code taking a prompt and answering it.
    fn cli_takes(&self, prompt: &str, reply: &str) {
        let path = self.transcript();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let records = format!(
            "{}\n{}\n",
            json!({ "parentUuid": null, "isSidechain": false, "type": "user", "uuid": "u-1", "userType": "external", "cwd": self.checkout, "sessionId": CONVERSATION, "origin": { "kind": "human" }, "message": { "role": "user", "content": prompt } }),
            json!({ "parentUuid": "u-1", "isSidechain": false, "type": "assistant", "uuid": "a-1", "cwd": self.checkout, "sessionId": CONVERSATION, "message": { "id": "m-1", "role": "assistant", "content": [{ "type": "text", "text": reply }] } }),
        );
        use std::io::Write;
        std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap().write_all(records.as_bytes()).unwrap();
    }

    /// The chat as the reader is told it.
    fn said(&self) -> Vec<String> {
        store::read_lines::<AgentEvent>(&store::log_path(SESSION, TAB).unwrap())
            .unwrap()
            .into_iter()
            .filter_map(|event| match event.payload {
                Payload::UserMessage { text, queued, .. } => Some(format!("user{}: {text}", if queued { " (queued)" } else { "" })),
                Payload::AssistantText { text, .. } => Some(format!("claude: {text}")),
                Payload::Status { text } => Some(format!("status: {text}")),
                Payload::Recovery { kind: Some(kind) } => Some(format!("recovery: {kind:?}")),
                _ => None,
            })
            .collect()
    }
}

fn passed(args: &[String], flag: &str, value: &str) -> bool {
    args.windows(2).any(|pair| pair[0] == flag && pair[1] == value)
}

/// The common case: a tab opened, its CLI started, and nothing sent before
/// the app went. The CLI never wrote the conversation, so there is nothing
/// to resume, and nothing was lost.
#[test]
fn a_conversation_its_cli_never_wrote_is_started_under_the_same_id_not_resumed() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    let args = rig.args();
    assert!(passed(&args, "--session-id", CONVERSATION), "{args:?}");
    assert!(!args.iter().any(|arg| arg == "--resume"), "{args:?}");
    assert!(rig.said().is_empty(), "{:?}", rig.said());
    let tab = index::get(SESSION).unwrap().tab(TAB).cloned().unwrap();
    assert_eq!(tab.provider_session_id.as_deref(), Some(CONVERSATION));
}

#[test]
fn a_conversation_its_cli_wrote_is_resumed() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    rig.cli_takes("hello", "hi");
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    let args = rig.args();
    assert!(passed(&args, "--resume", CONVERSATION), "{args:?}");
    assert!(!args.iter().any(|arg| arg == "--session-id"), "{args:?}");
}

/// #663 as it happened: the handoff (seq 1) was written and never submitted,
/// "yo" was queued behind it, and after a reboot "continue" relaunched a tab
/// whose conversation Claude Code had never written.
#[test]
fn a_handoff_the_cli_never_took_is_sent_again_ahead_of_the_prompt_that_relaunched_the_tab() {
    let rig = Rig::new(claude_tab(Some(1)), LISTENS);
    rig.logged(1, json!({ "type": "user_message", "text": HANDOFF, "queued": false }));
    rig.logged(2, json!({ "type": "user_message", "text": "yo", "queued": true }));
    rig.logged(3, json!({ "type": "recovery", "kind": "delivery_unconfirmed" }));
    rig.logged(4, json!({ "type": "status", "text": "Claude Code exited." }));

    rig.manager.send(SESSION, TAB, "continue".into(), Vec::new()).unwrap();
    let args = rig.args();
    assert!(passed(&args, "--session-id", CONVERSATION) && !args.iter().any(|arg| arg == "--resume"), "{args:?}");
    rig.up();
    rig.wait("both prompts to be typed", || rig.typed().contains(HANDOFF) && rig.typed().contains("continue"));
    let typed = rig.typed();
    assert!(typed.find(HANDOFF).unwrap() < typed.find("continue").unwrap(), "the brief first: {typed:?}");
    assert!(!typed.contains("[200~yo"), "what was sent while the brief went unread is not sent again: {typed:?}");

    // The chat has the handoff once, where it was sent; the reader's prompt
    // waits behind it.
    let before = [
        format!("user: {HANDOFF}"),
        "user (queued): yo".into(),
        "recovery: DeliveryUnconfirmed".into(),
        "status: Claude Code exited.".into(),
        "status: Claude Code never received the context carried over from the earlier conversation; sending it again.".into(),
        "user (queued): continue".into(),
    ];
    assert_eq!(rig.said(), before);

    // Claude Code takes it. Its record is the handoff's echo, not a second message.
    rig.cli_takes(HANDOFF, "Reading the earlier conversation.");
    rig.wait("the reply", || rig.said().last().is_some_and(|line| line == "claude: Reading the earlier conversation."));
    assert_eq!(rig.said()[..before.len()], before);
    assert_eq!(rig.said().iter().filter(|line| line.contains(HANDOFF)).count(), 1);
    assert!(matches!(&rig.rt().lock().unwrap().engine, Engine::Cli(p) if p.awaiting_delivery.is_none()), "the handoff was delivered");
}

#[test]
fn a_prompt_the_cli_never_took_is_offered_again_and_goes_again_as_it_was_sent() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    let image = rig.checkout.join("failure.png");
    std::fs::write(&image, b"\x89PNG stand-in").unwrap();
    rig.logged(1, json!({ "type": "user_message", "text": "Fix the flaky test", "queued": false, "images": [{ "url": image, "mediaType": "image/png", "name": "failure.png" }] }));
    rig.logged(2, json!({ "type": "turn_completed", "status": "aborted", "durationMs": 1433 }));
    rig.logged(3, json!({ "type": "status", "text": "Claude Code exited." }));

    // Opened: the conversation starts without it, and the reader is asked.
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    assert!(passed(&rig.args(), "--session-id", CONVERSATION));
    assert_eq!(rig.said().last().map(String::as_str), Some("recovery: Unsent"));
    assert_eq!(rig.rt().lock().unwrap().status, TabStatus::Waiting);
    // Opened again, with the CLI still there: nothing more is said.
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    assert_eq!(rig.said().iter().filter(|line| *line == "recovery: Unsent").count(), 1);

    // "Resend last prompt".
    rig.up();
    let sent = rig.manager.resend_unsent(SESSION, TAB).unwrap();
    let Payload::UserMessage { text, images, queued, .. } = &sent.events[0].payload else { panic!("{:?}", sent.events) };
    assert_eq!((text.as_str(), images.len(), *queued), ("Fix the flaky test", 1, false));
    assert_eq!(std::fs::read(&images[0].url).unwrap(), b"\x89PNG stand-in", "the same image, archived again");
    assert!(rig.rt().lock().unwrap().recovery.is_none());
    rig.wait("the prompt and its image to be typed", || rig.typed().contains("Fix the flaky test") && rig.typed().contains(&images[0].url));
    assert_eq!(rig.said().last().map(String::as_str), Some("user: Fix the flaky test"));
}

#[test]
fn nothing_is_resent_where_nothing_went_unanswered() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    let error = rig.manager.resend_unsent(SESSION, TAB).unwrap_err();
    assert!(error.to_string().contains("no unanswered prompt"), "{error:#}");
}

/// A CLI gone before it ever got going says why, in both the desktop app,
/// which follows terminals, and a workspace runtime, which does not.
#[test]
fn a_cli_that_exits_as_it_starts_says_why() {
    for following in [true, false] {
        let rig = Rig::new(claude_tab(None), REFUSES);
        if following {
            rig.manager.follow_with(Arc::new(Nowhere));
        }
        rig.manager.ensure_started(SESSION, TAB).unwrap();
        rig.wait("the exit to be told", || rig.said().iter().any(|line| line.starts_with("status: Claude Code exited")));
        assert_eq!(rig.said(), ["status: Claude Code exited: No conversation found with session ID: 12cfb036"], "following: {following}");
    }
}

/// One the reader quit after it was up says only that it went: its last
/// screen is not a reason.
#[test]
fn a_cli_that_was_up_and_then_quit_is_not_given_a_reason() {
    let rig = Rig::new(claude_tab(None), QUITS);
    rig.manager.follow_with(Arc::new(Nowhere));
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    rig.wait("the CLI to be listening", || rig.typed().contains("listening"));
    rig.up();
    rig.manager.terminals.write(&SessionManager::pane_id(TAB), b"/exit\n").unwrap();
    rig.wait("the exit to be told", || rig.said().iter().any(|line| line.starts_with("status: Claude Code exited")));
    assert_eq!(rig.said(), ["status: Claude Code exited."]);
}

#[test]
fn prompts_reach_a_pane_in_the_order_they_were_sent_whichever_thread_runs_first() {
    let writer = Arc::new(PaneWriter::default());
    let tickets: Vec<Ticket> = (0..4).map(|_| writer.ticket()).collect();
    let typed = Arc::new(Mutex::new(Vec::new()));
    // The last sent is the first to run.
    let threads: Vec<_> = tickets
        .into_iter()
        .enumerate()
        .rev()
        .map(|(n, ticket)| {
            let typed = typed.clone();
            std::thread::spawn(move || {
                let _pane = ticket.take();
                typed.lock().unwrap().push(n);
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(*typed.lock().unwrap(), [0, 1, 2, 3]);
}

#[test]
fn a_prompt_that_never_got_going_does_not_hold_up_the_ones_after_it() {
    let writer = Arc::new(PaneWriter::default());
    let (first, second, third) = (writer.ticket(), writer.ticket(), writer.ticket());
    // Its thread never started, and it is given up before the one ahead of it is done.
    drop(second);
    let after = std::thread::spawn(move || drop(third.take()));
    drop(first);
    after.join().unwrap();
    // And the line goes on.
    drop(writer.ticket().take());
}
