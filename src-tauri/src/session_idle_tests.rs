//! Agents nobody is using are stopped, and come back when used (#696).
//!
//! Real panes, and a stand-in for Claude Code that sits at its prompt as 35
//! of the 38 agents in the issue did. Tests wait for what they expect to be
//! so (an agent quiet for its limit, a CLI started), never for a set time.
use std::time::Duration;

use serde_json::{json, Value};

use super::*;

const SESSION: &str = "idle";
const TAB: &str = "agent";
const CONVERSATION: &str = "5a0e4a52-8f7c-4e0b-9a51-3f8c6f2d9b10";
/// Up, drawing its prompt once, and then quiet until it is typed at.
const SITS: &str = "printf 'ready\\n'\nstty -icanon\nexec cat\n";
/// The same, having first left a process running that its own parent has
/// let go of, as `nohup … &` from one of its commands does.
const LEAVES_ONE: &str = "(sleep 300 & echo $! > left.pid)\nprintf 'ready\\n'\nstty -icanon\nexec cat\n";
/// Short enough to wait for here; what is under test is what happens at it.
const LIMIT: Duration = Duration::from_millis(300);

struct Rig {
    manager: SessionManager,
    ran: PathBuf,
    checkout: PathBuf,
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
    /// One session with one Claude tab; `session` is laid over its entry.
    fn new(session: Value) -> Self {
        Self::with(session, SITS)
    }

    fn with(session: Value, stand_in: &str) -> Self {
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
        let mut entry = json!({
            "id": SESSION, "projectPath": checkout, "cwd": checkout, "title": "Review #590",
            "created": index::now(), "modified": index::now(),
            "tabs": [{ "id": TAB, "harness": "claude", "permissionMode": "default", "providerSessionId": CONVERSATION, "created": index::now() }],
        });
        entry.as_object_mut().unwrap().extend(session.as_object().unwrap().clone());
        index::save(&[serde_json::from_value(entry).unwrap()]).unwrap();
        Self { manager, ran: program.with_extension("ran"), checkout, _dir: dir, _claude: claude, _home: home }
    }

    fn wait(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "never happened: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn rt(&self) -> Arc<Mutex<TabRuntime>> {
        self.manager.runtime(SESSION, TAB).unwrap()
    }

    fn running(&self) -> bool {
        self.manager.is_running(SESSION, TAB)
    }

    /// Started, and then quiet for the limit.
    fn idle_for_the_limit(&self) {
        self.wait("the CLI to run", || self.running() && self.ran.exists());
        self.wait("the agent to be quiet for the limit", || self.manager.idle_for(SESSION, TAB, Instant::now()).is_some_and(|idle| idle >= LIMIT));
    }

    fn statuses(&self) -> Vec<String> {
        store::read_lines::<AgentEvent>(&store::log_path(SESSION, TAB).unwrap())
            .unwrap()
            .into_iter()
            .filter_map(|event| match event.payload {
                Payload::Status { text } => Some(text),
                _ => None,
            })
            .collect()
    }

    fn sweep(&self, limit: Option<Duration>) -> Vec<crate::idle_agents::Why> {
        crate::idle_agents::sweep(&self.manager, limit, Instant::now()).into_iter().map(|(_, _, why)| why).collect()
    }
}

/// The whole round: quiet for the limit, it is stopped with a line saying
/// so, and a reply nobody read is still unread. Shown again it stays
/// stopped, by a runtime started since too; the next message starts it on
/// the same conversation.
#[test]
fn an_agent_with_nothing_to_do_is_stopped_and_its_next_message_starts_it_again() {
    let rig = Rig::new(json!({}));
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    rig.idle_for_the_limit();
    {
        let rt = rig.rt();
        let mut rt = rt.lock().unwrap();
        rig.manager.set_status(&mut rt, TabStatus::Completed);
    }

    // With no limit, an agent of a session the reader has not set aside runs on.
    assert!(rig.sweep(None).is_empty());
    assert!(rig.running());

    assert_eq!(rig.sweep(Some(LIMIT)), [crate::idle_agents::Why::Idle(LIMIT)]);
    assert!(!rig.running());
    assert!(rig.statuses().iter().any(|line| line.contains("with nothing to do. Your next message starts the agent again")), "{:?}", rig.statuses());
    assert_eq!(index::get(SESSION).unwrap().tab(TAB).unwrap().status, TabStatus::Completed, "still unread");
    let parked = || index::get(SESSION).unwrap().tab(TAB).unwrap().parked;
    assert!(parked());

    // Shown again: nothing starts.
    std::fs::remove_file(&rig.ran).unwrap();
    rig.manager.start_on_open(SESSION, TAB).unwrap();
    assert!(!rig.running() && !rig.ran.exists());
    // Nor by a runtime that started since, which knows the tab only from the index.
    let later = SessionManager::new(
        Arc::new(crate::sink::BroadcastSink::new(16)),
        Arc::new(crate::sink::NoObserver),
        Arc::new(Host::new()),
        Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()),
        Arc::new(Default::default()),
        crate::hooks::prepare_control().unwrap(),
    );
    later.start_on_open(SESSION, TAB).unwrap();
    assert!(!later.is_running(SESSION, TAB) && !rig.ran.exists());

    // Its next message does, on the same conversation.
    rig.manager.send(SESSION, TAB, "carry on".into(), Vec::new()).unwrap();
    rig.wait("the CLI to start again", || rig.running() && std::fs::read_to_string(&rig.ran).is_ok_and(|ran| ran.contains(CONVERSATION)));
    assert!(!parked());
}

/// An agent at work, or waiting on its reader, is never stopped however long
/// it has been quiet: in a turn, waiting for an answer, or with a turn open.
#[test]
fn an_agent_in_a_turn_or_waiting_on_its_reader_is_never_stopped() {
    let rig = Rig::new(json!({}));
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    rig.idle_for_the_limit();
    for status in [TabStatus::InProgress, TabStatus::Waiting] {
        {
            let rt = rig.rt();
            let mut rt = rt.lock().unwrap();
            rig.manager.set_display_status(&mut rt, status);
        }
        assert!(rig.sweep(Some(LIMIT)).is_empty(), "{status:?}");
        assert_eq!(rig.manager.stop_if_idle(SESSION, TAB, "never said", Duration::ZERO).unwrap(), AgentStop::Busy);
        assert!(rig.running(), "{status:?}");
    }
    {
        let rt = rig.rt();
        let mut rt = rt.lock().unwrap();
        rig.manager.set_display_status(&mut rt, TabStatus::Idle);
        rt.turn_open = true;
    }
    assert!(rig.sweep(Some(LIMIT)).is_empty(), "a turn is open");
    assert!(rig.running());
    assert!(!rig.statuses().iter().any(|line| line == "never said"));
}

/// The review's case: a CI watch run in the background, its turn over. The
/// agent is as quiet as one with nothing to do, but waits on it, and is not
/// stopped until it has reported in.
#[test]
fn an_agent_waiting_on_a_background_command_is_not_stopped_until_it_reports_in() {
    let rig = Rig::new(json!({}));
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    rig.idle_for_the_limit();
    // The launch reads its CLI's transcript for what it starts. Here the
    // same records go to a file of their own, which the tab's tailer does not
    // follow, so that it is only the sweep that hears of them.
    assert!(rig.rt().lock().unwrap().background.is_some());
    let transcript = rig.checkout.join("transcript.jsonl");
    rig.rt().lock().unwrap().background = Some(Arc::new(Mutex::new(claude::background::Watch::new(transcript.clone(), 0))));
    let records = [
        json!({ "type": "assistant", "timestamp": index::now(), "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_ci", "name": "Bash", "input": { "command": "gh run watch", "run_in_background": true } }] } }),
        json!({ "type": "user", "timestamp": index::now(), "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_ci", "content": "Command running in background with ID: bci" }] }, "toolUseResult": { "backgroundTaskId": "bci" } }),
    ];
    std::fs::write(&transcript, records.iter().map(|record| format!("{record}\n")).collect::<String>()).unwrap();

    assert!(rig.sweep(Some(LIMIT)).is_empty());
    assert!(rig.running());
    assert_eq!(rig.manager.background_work(SESSION, TAB).as_deref(), Some("a background command it has not heard back from"));

    let reported = json!({ "type": "attachment", "timestamp": index::now(), "attachment": { "type": "queued_command", "commandMode": "task-notification",
        "prompt": "<task-notification>\n<task-id>bci</task-id>\n<tool-use-id>toolu_ci</tool-use-id>\n<status>completed</status>\n</task-notification>" } });
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(&transcript).unwrap().write_all(format!("{reported}\n").as_bytes()).unwrap();
    assert_eq!(rig.sweep(Some(LIMIT)), [crate::idle_agents::Why::Idle(LIMIT)]);
    assert!(!rig.running());
}

/// A process one of its commands left running is still in the agent's
/// process group, and a stop would end it: the agent waits on it.
#[test]
fn an_agent_whose_command_left_a_process_running_is_not_stopped() {
    let rig = Rig::with(json!({}), LEAVES_ONE);
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    let left = rig.checkout.join("left.pid");
    rig.wait("the process to be left", || std::fs::read_to_string(&left).is_ok_and(|pid| pid.ends_with('\n')));
    let pid: u32 = std::fs::read_to_string(&left).unwrap().trim().parse().unwrap();
    rig.idle_for_the_limit();

    assert!(rig.sweep(Some(LIMIT)).is_empty());
    assert!(rig.running());
    assert_eq!(rig.manager.background_work(SESSION, TAB).as_deref(), Some("a process it left running"));

    // Gone (and reaped by launchd), the agent has nothing left to wait on.
    crate::harness::host::kill_now(pid);
    rig.wait("the process to be gone", || rig.manager.background_work(SESSION, TAB).is_none());
    assert_eq!(rig.sweep(Some(LIMIT)), [crate::idle_agents::Why::Idle(LIMIT)]);
}

/// An archived session, or one whose workspace was removed: opening its tab
/// shows its conversation and starts nothing; the terminal view, or a
/// message, does start it.
#[test]
fn opening_a_set_aside_sessions_tab_does_not_start_its_agent() {
    for set_aside in [json!({ "archived": true }), json!({ "worktreeRemoved": true })] {
        let rig = Rig::new(set_aside.clone());
        rig.manager.start_on_open(SESSION, TAB).unwrap();
        assert!(!rig.running() && !rig.ran.exists(), "{set_aside}");
        rig.manager.ensure_started(SESSION, TAB).unwrap();
        rig.wait("the CLI to run", || rig.running());
        // Once it runs, showing the tab again leaves it be.
        rig.manager.start_on_open(SESSION, TAB).unwrap();
        assert!(rig.running(), "{set_aside}");
    }
    // An ordinary session's tab starts its agent when shown, as it always has.
    let rig = Rig::new(json!({}));
    rig.manager.start_on_open(SESSION, TAB).unwrap();
    rig.wait("the CLI to run", || rig.running());
}
