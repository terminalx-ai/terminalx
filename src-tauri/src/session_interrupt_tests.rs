//! Escape is the agent's key, never the end of its process (#427).
//!
//! `interrupt` is what Escape in the chat does: the running turn is told to
//! stop the way its agent takes that (a bare Escape typed into a CLI, a
//! cancelled prompt for ACP), and nothing else. The process stays, the app
//! settles nothing until the agent says the turn is over, what the turn was
//! asking the reader is withdrawn, and queued follow-ups are kept. `stop` is
//! the other thing, and the only one that ends the process.
//!
//! The CLI tests run against both CLIs, with a real program in the pane that
//! says which byte it was typed. The headless tests run an ACP tab whose
//! agent is a process that only records what it is written; the test speaks
//! for the agent.
use super::*;

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !done() {
        assert!(Instant::now() < deadline, "never happened: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn screen(rig: &Rig) -> String {
    String::from_utf8_lossy(&rig.manager.terminals.read_output(&rig.pane).unwrap_or_default()).into_owned()
}

/// A program in the tab's pane that reads one byte, says which, and stays.
#[cfg(unix)]
fn with_a_cli_that_names_its_first_byte(kind: CliKind) -> Rig {
    let rig = Rig::of(kind, "");
    let script = rig._dir.path().join("one-byte-cli.sh");
    std::fs::write(
        &script,
        r#"stty raw -echo
printf 'CLI-IS-UP'
byte=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
printf 'TYPED-%s.' "$byte"
sleep 600
"#,
    )
    .unwrap();
    let sink = Arc::new(crate::sink::BroadcastSink::new(256));
    let command = format!("sh '{}'", script.display());
    let spec = pty::PaneSpec { cwd: rig._dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(&command), env: &[] };
    rig.manager.terminals.spawn(sink, &rig.pane, spec).unwrap();
    wait_until("the program in the pane is up", || screen(&rig).contains("CLI-IS-UP"));
    rig
}

impl Rig {
    /// Escape pressed in the chat.
    fn escape(&self) -> bool {
        self.manager.interrupt(SESSION, TAB).unwrap()
    }

    fn pane_is_running(&self) -> bool {
        self.manager.terminals.is_running(&self.pane)
    }

    /// The end of each turn the log holds, as the chat draws it.
    fn turn_ends(&self) -> Vec<TurnStatus> {
        self.events().iter().filter_map(|e| match &e.payload { Payload::TurnCompleted { status, .. } => Some(*status), _ => None }).collect()
    }

    /// How each request the log holds was settled: its label, and whether the app settled it itself.
    fn decisions(&self) -> Vec<(String, bool, bool)> {
        self.events()
            .iter()
            .filter_map(|e| match &e.payload {
                Payload::PermissionDecided { label, allowed, automatic, .. } => Some((label.clone(), *allowed, *automatic)),
                _ => None,
            })
            .collect()
    }

    /// The "Session closed" line only a hard stop writes.
    fn said_session_closed(&self) -> bool {
        self.events().iter().any(|e| matches!(&e.payload, Payload::Status { text } if text == recovery::SESSION_CLOSED_MESSAGE))
    }

    /// The CLI asks before running a tool, and its hook parks on the answer.
    /// Returns what the hook finally printed for the CLI.
    fn cli_asks(&self) -> std::sync::mpsc::Receiver<HookReply> {
        let manager = self.manager.clone();
        let frame = HookFrame {
            tab: TAB.into(),
            session: SESSION.into(),
            token: self.token.clone(),
            event: "PermissionRequest".into(),
            payload: json!({ "tool_name": "Bash", "tool_input": { "command": "rm -rf build" } }),
        };
        let (reply, printed) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = reply.send(manager.on_hook(frame));
        });
        wait_until("the request is on the reader's screen", || !self.rt.lock().unwrap().pending.is_empty());
        assert_eq!(self.status(), TabStatus::Waiting);
        printed
    }
}

/// What a hook printed for the CLI: its decision on the tool.
fn behavior(reply: &HookReply) -> Option<&str> {
    reply.output.as_ref()?["hookSpecificOutput"]["decision"]["behavior"].as_str()
}

/// The report: Escape while the agent works killed it and put "Session
/// closed … Resume safely" over the tab. Escape is typed into the CLI, which
/// stops its own turn; the process is the same one afterwards, and the next
/// message goes to it.
#[cfg(unix)]
#[test]
fn escape_in_the_chat_is_typed_into_the_cli_and_its_process_stays() {
    for kind in BOTH {
        let rig = with_a_cli_that_names_its_first_byte(kind);
        rig.compose("start", 0);
        rig.cli_takes("start");
        let generation = match &rig.rt.lock().unwrap().engine {
            Engine::Cli(p) => p.generation,
            _ => unreachable!(),
        };

        assert!(rig.escape(), "{kind:?}");
        // A bare Escape, and nothing else, reached the program.
        wait_until("the program reads the key", || screen(&rig).contains("TYPED-"));
        assert!(screen(&rig).contains("TYPED-1b."), "{kind:?}: {:?}", screen(&rig));

        // The app settles nothing by itself: the turn is the agent's until the agent says otherwise.
        assert!(rig.turn_open(), "{kind:?}");
        assert_eq!(rig.status(), TabStatus::InProgress, "{kind:?}");
        assert_eq!(rig.told(), ["user: start"], "{kind:?}");
        assert!(rig.pane_is_running(), "{kind:?}: Escape must not end the process");

        // The CLI says it stopped: the turn is drawn as stopped and the tab is idle.
        rig.interrupt();
        assert!(!rig.turn_open(), "{kind:?}");
        assert_eq!(rig.status(), TabStatus::Idle, "{kind:?}");
        assert_eq!(rig.turn_ends(), [TurnStatus::Aborted], "{kind:?}");

        // Nothing was closed: no banner to resume from, no recovery, and the same CLI takes the next message.
        assert!(!rig.said_session_closed(), "{kind:?}");
        assert_eq!((rig.recovery(), rig.banner()), (None, None), "{kind:?}");
        assert!(rig.pane_is_running(), "{kind:?}");
        assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if p.generation == generation), "{kind:?}: the CLI was replaced");
        assert!(!rig.compose("next", 0), "{kind:?}: the next message starts a turn on the same process");
        rig.cli_takes("next");
        rig.cli_replies("done");
        assert_eq!(rig.told(), ["user: start", "end", "user: next", "reply: done", "end"], "{kind:?}");
    }
}

/// With nothing running there is nothing to interrupt, and an Escape typed
/// into a CLI sitting at its prompt would clear what is in its input.
#[cfg(unix)]
#[test]
fn escape_with_nothing_running_types_nothing() {
    for kind in BOTH {
        let rig = with_a_cli_that_names_its_first_byte(kind);
        // Never started a turn.
        assert!(!rig.escape(), "{kind:?}");
        // Finished one.
        rig.compose("start", 0);
        rig.cli_takes("start");
        rig.cli_replies("done");
        assert_eq!(rig.status(), TabStatus::Completed, "{kind:?}");
        assert!(!rig.escape(), "{kind:?}");

        // The first byte the program ever reads is the one typed now, not an Escape.
        rig.manager.terminals.write(&rig.pane, b"x").unwrap();
        wait_until("the program reads a key", || screen(&rig).contains("TYPED-"));
        assert!(screen(&rig).contains("TYPED-78."), "{kind:?}: {:?}", screen(&rig));
        assert_eq!(rig.told(), ["user: start", "reply: done", "end"], "{kind:?}");
    }
}

/// A turn the app believes is running, in a tab whose CLI has gone: there is
/// nobody to type to, and the interrupt says so rather than pretending.
#[test]
fn escape_for_a_cli_that_is_not_running_does_nothing() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(!rig.escape(), "{kind:?}");
        assert!(rig.turn_open(), "{kind:?}");
        assert_eq!(rig.turn_ends(), [], "{kind:?}");
    }
}

/// Escape while the agent waits on the reader. In its own screen that key
/// turns the tool down and stops the turn. From the chat the card is
/// withdrawn, the CLI is told no, and the turn is interrupted: the tool the
/// reader was still deciding about never runs, the card does not sit there
/// for ten minutes, and nothing "lapses" into a recovery banner.
#[cfg(unix)]
#[test]
fn escape_withdraws_what_the_turn_was_asking_and_the_tool_does_not_run() {
    for kind in BOTH {
        let rig = with_a_cli_that_names_its_first_byte(kind);
        rig.compose("clean up", 0);
        rig.cli_takes("clean up");
        let printed = rig.cli_asks();

        assert!(rig.escape(), "{kind:?}");
        let reply = printed.recv_timeout(Duration::from_secs(30)).expect("the parked hook answers at once");
        assert_eq!(behavior(&reply), Some("deny"), "{kind:?}: {reply:?}");
        assert!(rig.rt.lock().unwrap().pending.is_empty(), "{kind:?}");
        assert_eq!(rig.decisions(), [("Cancelled".to_string(), false, true)], "{kind:?}");
        // Not waiting on the reader any more; the agent's turn until it says it stopped.
        assert_eq!(rig.status(), TabStatus::InProgress, "{kind:?}");
        assert!(rig.turn_open(), "{kind:?}");
        wait_until("the program reads the key", || screen(&rig).contains("TYPED-1b."));

        rig.interrupt();
        assert_eq!(rig.status(), TabStatus::Idle, "{kind:?}");
        assert_eq!(rig.turn_ends(), [TurnStatus::Aborted], "{kind:?}");
        assert_eq!((rig.recovery(), rig.banner()), (None, None), "{kind:?}: a withdrawn request has not lapsed");
        assert!(rig.pane_is_running(), "{kind:?}");
    }
}

/// The same key pressed in the terminal view goes straight to the agent, and
/// the app only hears that the turn was stopped. A card still open for that
/// turn is withdrawn with it, and the tab is idle, not waiting.
#[test]
fn a_turn_stopped_in_the_agents_own_terminal_takes_its_open_card_with_it() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("clean up", 0);
        rig.cli_takes("clean up");
        let printed = rig.cli_asks();

        rig.interrupt();
        let reply = printed.recv_timeout(Duration::from_secs(30)).expect("the parked hook answers at once");
        assert_eq!(behavior(&reply), Some("deny"), "{kind:?}: {reply:?}");
        assert_eq!(rig.decisions(), [("Cancelled".to_string(), false, true)], "{kind:?}");
        assert_eq!(rig.turn_ends(), [TurnStatus::Aborted], "{kind:?}");
        // The hook waking after the turn closed must not put the tab back to work.
        assert_eq!(rig.status(), TabStatus::Idle, "{kind:?}");
        assert_eq!((rig.recovery(), rig.banner()), (None, None), "{kind:?}");
    }
}

/// The explicit stop is the one that ends the process, and the only one that
/// says the session was closed.
#[cfg(unix)]
#[test]
fn the_hard_stop_is_what_ends_the_process_and_says_so() {
    for kind in BOTH {
        let rig = with_a_cli_that_names_its_first_byte(kind);
        rig.compose("start", 0);
        rig.cli_takes("start");

        rig.manager.stop(SESSION, TAB).unwrap();
        assert!(!rig.pane_is_running(), "{kind:?}");
        assert!(matches!(rig.rt.lock().unwrap().engine, Engine::None), "{kind:?}");
        assert!(rig.said_session_closed(), "{kind:?}");
        assert_eq!(rig.turn_ends(), [TurnStatus::Aborted], "{kind:?}");
        assert_eq!(rig.status(), TabStatus::Idle, "{kind:?}");
        // And after it there is nothing left for an Escape to reach.
        assert!(!rig.escape(), "{kind:?}");
    }
}

// ---- headless agents: the app's own queue ------------------------------------

/// An ACP tab mid-turn. Its agent is a process that records every line it is
/// written; the test answers for it with `agent`.
struct Headless {
    rig: Rig,
    wire: PathBuf,
    pid: u32,
}

impl Headless {
    fn acp() -> Self {
        let rig = Rig::of(CliKind::Claude, "");
        let dir = rig._dir.path().to_path_buf();
        let cwd = dir.to_str().unwrap().to_string();
        let wire = dir.join("wire.jsonl");
        let entry: index::SessionEntry = serde_json::from_value(json!({
            "id": SESSION, "projectPath": dir, "cwd": dir,
            "title": "headless", "created": index::now(), "modified": index::now(),
            "tabs": [{ "id": TAB, "harness": "cursor", "created": index::now() }]
        }))
        .unwrap();
        index::save(&[entry]).unwrap();
        let pid = {
            let mut rt = rig.rt.lock().unwrap();
            rt.harness = "cursor".into();
            rt.engine = Engine::Acp(acp::Acp::new(&cwd, None, None, "default"));
            let record = format!("cat > '{}'", wire.display());
            rig.manager.spawn_child(&mut rt, &rig.rt, Path::new("/bin/sh"), &["-c".to_string(), record], &cwd).unwrap();
            // The first prompt, as `send` starts one on a tab with no process yet.
            rig.manager.publish(&mut rt, Payload::UserMessage { author: None, text: "first".into(), images: Vec::new(), baseline: None, queued: false, cwd: Some(cwd.clone()) }, None);
            let Engine::Acp(agent) = &mut rt.engine else { unreachable!() };
            let actions = agent.start("first".into(), Vec::new());
            rig.manager.apply_actions(&mut rt, actions);
            rt.open_turn();
            rt.turn_started_at = Some(Instant::now());
            rig.manager.set_status(&mut rt, TabStatus::InProgress);
            rt.child_pid.unwrap()
        };
        let tab = Self { rig, wire, pid };
        tab.agent(json!({ "jsonrpc": "2.0", "id": tab.asked("initialize")["id"], "result": { "protocolVersion": 1, "agentCapabilities": {} } }));
        tab.agent(json!({ "jsonrpc": "2.0", "id": tab.asked("session/new")["id"], "result": { "sessionId": "s1" } }));
        tab
    }

    /// A line from the agent.
    fn agent(&self, line: serde_json::Value) {
        self.rig.manager.on_line(&self.rig.rt, &line.to_string());
    }

    /// Everything the agent has been written, in order.
    fn written(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(&self.wire).unwrap_or_default().lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
    }

    fn count(&self, method: &str) -> usize {
        self.written().iter().filter(|line| line["method"] == method).count()
    }

    /// The newest request or notification of `method` the agent was written, once it is there.
    fn asked(&self, method: &str) -> serde_json::Value {
        wait_until(&format!("the agent is written {method}"), || self.count(method) > 0);
        self.written().into_iter().rfind(|line| line["method"] == method).unwrap()
    }

    /// The prompt the agent was last given, once it is `text`.
    fn prompted(&self, text: &str) -> serde_json::Value {
        wait_until(&format!("the agent is prompted with {text:?}"), || self.written().iter().any(|line| line["method"] == "session/prompt" && line["params"]["prompt"][0]["text"] == text));
        self.asked("session/prompt")
    }

    fn prompt_ends(&self, prompt: &serde_json::Value, stop_reason: &str) {
        self.agent(json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": stop_reason } }));
    }

    fn queue(&self, text: &str) {
        let sent = self.rig.manager.send(SESSION, TAB, text.into(), Vec::new()).unwrap();
        assert!(sent.queued, "a message sent mid-turn waits in the app's queue");
    }

    fn queued(&self) -> Vec<String> {
        self.rig.manager.queued(SESSION, TAB).into_iter().map(|message| message.text).collect()
    }

    fn process(&self) -> Option<u32> {
        self.rig.rt.lock().unwrap().child_pid
    }
}

impl Drop for Headless {
    fn drop(&mut self) {
        self.rig.manager.host.kill(&key_of(SESSION, TAB));
    }
}

/// A headless agent has no queue of its own: follow-ups wait in the app's.
/// Escape used to empty it. It stops the turn that is running, and the next
/// queued message then starts, as it would have had the turn finished. With
/// nothing queued the tab simply goes idle, and with nothing running Escape
/// does nothing. The process is the same one throughout.
#[cfg(unix)]
#[test]
fn escape_cancels_a_headless_turn_and_the_next_queued_message_goes_on() {
    let tab = Headless::acp();
    let first = tab.prompted("first");
    tab.queue("second");
    tab.queue("third");

    assert!(tab.rig.escape());
    // The protocol's own word for it, to the same process.
    assert_eq!(tab.asked("session/cancel")["params"]["sessionId"], "s1");
    // Nothing is settled or dropped until the agent answers.
    assert!(tab.rig.turn_open());
    assert_eq!(tab.rig.status(), TabStatus::InProgress);
    assert_eq!(tab.queued(), ["second", "third"]);
    assert_eq!(tab.rig.turn_ends(), []);

    // The agent ends the prompt as cancelled: that turn is stopped, and the next message is its prompt at once.
    tab.prompt_ends(&first, "cancelled");
    let second = tab.prompted("second");
    assert_eq!(tab.rig.turn_ends(), [TurnStatus::Aborted]);
    assert_eq!(tab.queued(), ["third"]);
    assert!(tab.rig.turn_open());
    assert_eq!(tab.rig.status(), TabStatus::InProgress);

    // Escape again: one turn at a time, never the whole queue.
    assert!(tab.rig.escape());
    wait_until("the second turn is cancelled too", || tab.count("session/cancel") == 2);
    tab.prompt_ends(&second, "cancelled");
    let third = tab.prompted("third");
    assert_eq!(tab.queued(), Vec::<String>::new());

    // Nothing queued behind this one: the tab goes idle when it is stopped.
    assert!(tab.rig.escape());
    wait_until("the third turn is cancelled", || tab.count("session/cancel") == 3);
    tab.prompt_ends(&third, "cancelled");
    assert_eq!(tab.rig.turn_ends(), [TurnStatus::Aborted, TurnStatus::Aborted, TurnStatus::Aborted]);
    assert!(!tab.rig.turn_open());
    assert_eq!(tab.rig.status(), TabStatus::Idle);

    // Nothing running: Escape does nothing, and writes nothing.
    assert!(!tab.rig.escape());
    assert_eq!(tab.count("session/cancel"), 3);
    assert_eq!(tab.count("session/prompt"), 3);

    // One process, never closed, never restarted.
    assert_eq!(tab.process(), Some(tab.pid));
    assert!(!tab.rig.said_session_closed());
    assert_eq!((tab.rig.recovery(), tab.rig.banner()), (None, None));
}

/// A request the agent was waiting on is answered as cancelled before the
/// turn is, which is what the protocol asks of a client that cancels.
#[cfg(unix)]
#[test]
fn escape_answers_what_a_headless_turn_was_asking_as_cancelled() {
    let tab = Headless::acp();
    let first = tab.prompted("first");
    tab.agent(json!({
        "jsonrpc": "2.0", "id": 77, "method": "session/request_permission",
        "params": { "sessionId": "s1", "toolCall": { "toolCallId": "call-1", "kind": "execute", "title": "rm -rf build" },
            "options": [{ "optionId": "allow", "name": "Allow", "kind": "allow_once" }, { "optionId": "reject", "name": "Reject", "kind": "reject_once" }] }
    }));
    assert_eq!(tab.rig.status(), TabStatus::Waiting);
    assert_eq!(tab.rig.rt.lock().unwrap().pending.len(), 1);

    assert!(tab.rig.escape());
    tab.asked("session/cancel");
    let answered: Vec<serde_json::Value> = tab.written().into_iter().filter(|line| line["id"] == 77).collect();
    assert_eq!(answered.len(), 1);
    assert_eq!(answered[0]["result"]["outcome"]["outcome"], "cancelled");
    assert!(tab.rig.rt.lock().unwrap().pending.is_empty());
    assert_eq!(tab.rig.decisions(), [("Cancelled".to_string(), false, true)]);
    assert_eq!(tab.rig.status(), TabStatus::InProgress);

    tab.prompt_ends(&first, "cancelled");
    assert_eq!(tab.rig.status(), TabStatus::Idle);
    assert_eq!(tab.rig.turn_ends(), [TurnStatus::Aborted]);
    assert_eq!(tab.process(), Some(tab.pid));
}

/// The hard stop is still what drops the queue: nothing queued is sent to an
/// agent the reader has ended.
#[cfg(unix)]
#[test]
fn the_hard_stop_ends_a_headless_agent_and_drops_what_was_queued() {
    let tab = Headless::acp();
    tab.prompted("first");
    tab.queue("second");

    tab.rig.manager.stop(SESSION, TAB).unwrap();
    assert_eq!(tab.queued(), Vec::<String>::new());
    assert_eq!(tab.process(), None);
    assert!(tab.rig.said_session_closed());
    assert_eq!(tab.rig.turn_ends(), [TurnStatus::Aborted]);
    assert_eq!(tab.rig.status(), TabStatus::Idle);
    // The queued message never reached it.
    assert_eq!(tab.count("session/prompt"), 1);
}

// ---- real agents ----------------------------------------------------------------

/// The whole path against an installed headless agent: the agent as the
/// tab's child, its own protocol spoken to it, a real model behind it.
/// Escape stops the turn that is running, the message queued behind it is
/// the next prompt, and the agent is the same process afterwards.
///
/// The first reply has to outlast the few seconds before Escape is pressed,
/// which a request to count to two hundred does on any model.
#[cfg(unix)]
fn live_escape_stops_the_turn_and_the_queued_message_goes_on(harness: &str, project: &str) {
    let rig = Rig::of(CliKind::Claude, "");
    let entry: index::SessionEntry = serde_json::from_value(json!({
        "id": SESSION, "projectPath": project, "cwd": project,
        "title": "live", "created": index::now(), "modified": index::now(),
        "tabs": [{ "id": TAB, "harness": harness, "created": index::now() }]
    }))
    .unwrap();
    index::save(&[entry]).unwrap();
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.harness = harness.into();
        rt.engine = Engine::None;
    }
    // The agent must not outlive the test, whichever way it ends.
    struct AgentGone(SessionManager);
    impl Drop for AgentGone {
        fn drop(&mut self) {
            self.0.host.kill(&key_of(SESSION, TAB));
        }
    }
    let _agent_gone = AgentGone(rig.manager.clone());
    let texts = |rig: &Rig| -> Vec<String> {
        rig.events().iter().filter_map(|e| match &e.payload { Payload::AssistantText { text, .. } => Some(text.clone()), _ => None }).collect()
    };
    let pid = || rig.rt.lock().unwrap().child_pid;
    let send = |text: &str| rig.manager.send(SESSION, TAB, text.into(), Vec::new()).unwrap();

    let first = send("TICKS=60 Count from 1 to 200, one number per line.");
    assert!(!first.queued);
    let agent = pid().expect("the agent is the tab's child");
    // The reply is on its way: the agent has opened a session and taken the prompt.
    wait_until("the agent opens a session", || match &rig.rt.lock().unwrap().engine {
        Engine::OpenCode(o) => o.ready,
        Engine::Acp(a) => a.ready,
        _ => false,
    });
    std::thread::sleep(Duration::from_secs(4));
    assert!(rig.turn_open(), "the first reply should still be coming; use a slower model or a longer prompt");
    assert!(send("TICKS=4 Reply with the single word done.").queued);

    assert!(rig.escape());
    wait_until("the first turn is stopped", || rig.turn_ends().first() == Some(&TurnStatus::Aborted));
    // The queued message went out at once, to the same agent.
    wait_until("the queued message has run", || rig.turn_ends().len() == 2);
    assert_eq!(rig.turn_ends(), [TurnStatus::Aborted, TurnStatus::Ok]);
    assert_eq!(rig.manager.queued(SESSION, TAB).len(), 0);
    assert_eq!(pid(), Some(agent), "Escape must not end the agent");
    assert!(!rig.said_session_closed());
    assert_eq!((rig.recovery(), rig.banner()), (None, None));
    // Each turn drew its own reply and nothing of the other's.
    let replies = texts(&rig);
    assert_eq!(replies.len(), 2, "{replies:?}");
    eprintln!("{harness}: the stopped turn said {:?}; the queued one said {:?}", replies[0], replies[1]);

    // Nothing running: Escape does nothing, and the agent is still there for the next message.
    assert!(!rig.escape());
    assert!(!send("TICKS=2 Reply with the single word again.").queued);
    wait_until("the next message runs on the same agent", || rig.turn_ends().len() == 3);
    assert_eq!(rig.turn_ends()[2], TurnStatus::Ok);
    assert_eq!(pid(), Some(agent));
}

/// Against the installed `opencode`: its server, its event stream, its HTTP
/// API. Needs `opencode` on `PATH`, and in `TERMINALX_LIVE_OPENCODE_PROJECT`
/// a directory whose `opencode.json` names a model. Run it alone, with
/// `--ignored`, under a `HOME` that is not yours if the agent should not
/// read your own configuration.
#[cfg(unix)]
#[test]
#[ignore = "needs opencode on PATH and TERMINALX_LIVE_OPENCODE_PROJECT; run with --ignored"]
fn live_opencode_escape_stops_the_turn_and_the_queued_message_goes_on() {
    match std::env::var("TERMINALX_LIVE_OPENCODE_PROJECT") {
        Ok(project) => live_escape_stops_the_turn_and_the_queued_message_goes_on("opencode", &project),
        Err(_) => eprintln!("TERMINALX_LIVE_OPENCODE_PROJECT is not set; skipping"),
    }
}

/// Against an installed ACP agent, launched as the app launches one
/// (`cursor-agent acp`). Any agent that speaks ACP under that name will do:
/// it was checked with a `cursor-agent` script on `PATH` that runs
/// `opencode "$@"`. `TERMINALX_LIVE_ACP_PROJECT` is the directory it works in.
#[cfg(unix)]
#[test]
#[ignore = "needs an ACP agent on PATH as cursor-agent and TERMINALX_LIVE_ACP_PROJECT; run with --ignored"]
fn live_acp_escape_stops_the_turn_and_the_queued_message_goes_on() {
    match std::env::var("TERMINALX_LIVE_ACP_PROJECT") {
        Ok(project) => live_escape_stops_the_turn_and_the_queued_message_goes_on("cursor", &project),
        Err(_) => eprintln!("TERMINALX_LIVE_ACP_PROJECT is not set; skipping"),
    }
}

// ---- A guest in a shared session (`docs/MULTIPLAYER.md`) --------------------

/// The rig's session shared, with one admitted driver: what a guest's
/// requests go through, over the same tab and the same pane.
#[cfg(unix)]
fn shared_with_a_driver(rig: &Rig) -> crate::pairing::PairingManager {
    use crate::local_sharing::{tests as fixtures, Role};
    let harness = match rig.cli().0 {
        CliKind::Claude => "claude",
        CliKind::Codex => "codex",
    };
    let entry: index::SessionEntry = serde_json::from_value(json!({
        "id": SESSION, "projectPath": rig._dir.path(), "cwd": rig._dir.path(),
        "title": "shared", "created": index::now(), "modified": index::now(),
        "tabs": [{ "id": TAB, "harness": harness, "permissionMode": "default", "pane": rig.pane, "created": index::now() }]
    }))
    .unwrap();
    index::save(&[entry]).unwrap();
    let now = crate::pairing::sharing::now();
    let mut share = fixtures::fixture();
    let link = share.links.get_mut("link").unwrap();
    link.settings.expires_at = now + 60_000;
    link.settings.role = Role::Driver;
    let mut guest = fixtures::guest("connection", "alice");
    guest.verified_until = now + 60_000;
    share.join(guest, now).unwrap();
    rig.manager.sharing.lock().unwrap().sessions.insert(SESSION.into(), share);
    let pairing = crate::pairing::PairingManager::new(Arc::new(crate::account::AccountManager::default()));
    pairing.attach_sessions(rig.manager.clone());
    pairing
}

/// One request from the guest, as the share's router takes it.
#[cfg(unix)]
fn guest_asks(pairing: &crate::pairing::PairingManager, rig: &Rig, method: &str, extra: serde_json::Value) -> Result<serde_json::Value> {
    // The share lets a guest write four times a second; the test is not about that.
    if let Some(guest) = rig.manager.sharing.lock().unwrap().sessions.get_mut(SESSION).and_then(|share| share.guests.get_mut("connection")) {
        guest.last_write = 0;
    }
    let mut params = json!({ "sessionId": SESSION, "tabId": TAB });
    for (key, value) in extra.as_object().into_iter().flatten() {
        params[key.as_str()] = value.clone();
    }
    pairing.share_rpc(SESSION, "connection", method, params)
}

/// What guests have waiting behind the turn, in the order it will be sent.
#[cfg(unix)]
fn waiting_from_guests(rig: &Rig) -> Vec<String> {
    rig.manager.sharing.lock().unwrap().sessions.get(SESSION).map(|share| share.queue.iter().map(|input| input.text.clone()).collect()).unwrap_or_default()
}

#[cfg(unix)]
fn share_activity(rig: &Rig) -> Vec<String> {
    let sharing = rig.manager.sharing.lock().unwrap();
    let Some(share) = sharing.sessions.get(SESSION) else { return Vec::new() };
    // A dropped input carries the reason, which is what a failure here needs to say.
    share
        .activity
        .iter()
        .filter_map(|entry| match entry["action"].as_str()? {
            "joined" => None,
            "queue-dropped" => Some(format!("queue-dropped: {}", entry["detail"]["reason"])),
            action => Some(action.to_string()),
        })
        .collect()
}

/// A guest's Stop used to be the host's hard stop: it killed the host's CLI
/// and put "Session closed" over the host's tab. It is Escape, as the host's
/// own Stop is, and what guests queued behind the turn is kept. The stop that
/// ends the process is the one that says `force`.
#[cfg(unix)]
#[test]
fn a_guest_s_stop_is_an_escape_and_only_a_forced_one_ends_the_process() {
    for kind in BOTH {
        let rig = with_a_cli_that_names_its_first_byte(kind);
        let pairing = shared_with_a_driver(&rig);
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert_eq!(guest_asks(&pairing, &rig, "session.send", json!({ "text": "then the docs" })).unwrap()["queued"], true, "{kind:?}");

        let answer = guest_asks(&pairing, &rig, "session.stop", json!({})).unwrap();
        assert_eq!((&answer["stopped"], &answer["interrupted"]), (&json!(false), &json!(true)), "{kind:?}");
        wait_until("the program reads the key", || screen(&rig).contains("TYPED-"));
        assert!(screen(&rig).contains("TYPED-1b."), "{kind:?}: {:?}", screen(&rig));
        assert!(rig.pane_is_running(), "{kind:?}: a guest's Stop must not end the host's agent");
        assert!(rig.turn_open(), "{kind:?}");
        assert!(!rig.said_session_closed(), "{kind:?}");
        assert_eq!((rig.recovery(), rig.banner()), (None, None), "{kind:?}");
        assert_eq!(waiting_from_guests(&rig), ["then the docs"], "{kind:?}");

        // The agent did not answer: the guest asks for the stop that ends it.
        let answer = guest_asks(&pairing, &rig, "session.stop", json!({ "force": true })).unwrap();
        assert_eq!(answer["stopped"], true, "{kind:?}");
        assert!(!rig.pane_is_running(), "{kind:?}");
        assert!(rig.said_session_closed(), "{kind:?}");
        assert!(waiting_from_guests(&rig).is_empty(), "{kind:?}");
        assert_eq!(share_activity(&rig), ["queued", "interrupt", "stop"], "{kind:?}");
    }
}

/// With nothing running a guest's Stop types nothing and ends nothing.
#[cfg(unix)]
#[test]
fn a_guest_s_stop_with_nothing_running_does_nothing() {
    let rig = with_a_cli_that_names_its_first_byte(CliKind::Claude);
    let pairing = shared_with_a_driver(&rig);
    let answer = guest_asks(&pairing, &rig, "session.stop", json!({})).unwrap();
    assert_eq!((&answer["stopped"], &answer["interrupted"]), (&json!(false), &json!(false)));
    assert!(rig.pane_is_running());
    assert!(!rig.said_session_closed());
    assert!(share_activity(&rig).is_empty());
    // The first byte the program ever reads is the one typed now, not an Escape.
    rig.manager.terminals.write(&rig.pane, b"x").unwrap();
    wait_until("the program reads a key", || screen(&rig).contains("TYPED-"));
    assert!(screen(&rig).contains("TYPED-78."), "{:?}", screen(&rig));
}

/// A guest's Steer used to stop the host's CLI and start it again with the
/// steering prompt. It is Escape and then that prompt as the next message:
/// kept on the host, ahead of what was already waiting, and sent to the same
/// process once the interrupted turn has ended.
#[cfg(unix)]
#[test]
fn a_guest_s_steer_interrupts_and_goes_next_to_the_same_process() {
    for kind in BOTH {
        let rig = with_a_cli_that_names_its_first_byte(kind);
        let pairing = shared_with_a_driver(&rig);
        rig.compose("start", 0);
        rig.cli_takes("start");
        let generation = match &rig.rt.lock().unwrap().engine {
            Engine::Cli(p) => p.generation,
            _ => unreachable!(),
        };
        guest_asks(&pairing, &rig, "session.send", json!({ "text": "then the docs" })).unwrap();

        assert_eq!(guest_asks(&pairing, &rig, "session.steer", json!({ "text": "use the other branch" })).unwrap()["queued"], true, "{kind:?}");
        wait_until("the program reads the key", || screen(&rig).contains("TYPED-"));
        assert!(screen(&rig).contains("TYPED-1b."), "{kind:?}: {:?}", screen(&rig));
        assert!(rig.pane_is_running(), "{kind:?}: a guest's Steer must not end the host's agent");
        assert!(!rig.said_session_closed(), "{kind:?}");
        assert_eq!(waiting_from_guests(&rig), ["use the other branch", "then the docs"], "{kind:?}");

        // While the interrupted turn is still the agent's, nothing of a guest's is typed into it.
        pairing.drain_share_queue(SESSION).unwrap();
        assert_eq!(waiting_from_guests(&rig), ["use the other branch", "then the docs"], "{kind:?}");
        assert_eq!(rig.told(), ["user: start"], "{kind:?}");

        // The CLI says it stopped: the steering prompt is the next message, to the same process.
        // It is sent although the guest wrote a moment ago; the share's limit on how fast a
        // guest may write is for what they send, not for what is already waiting.
        rig.interrupt();
        assert_eq!(rig.status(), TabStatus::Idle, "{kind:?}");
        pairing.drain_share_queue(SESSION).unwrap();
        assert_eq!(waiting_from_guests(&rig), ["then the docs"], "{kind:?}");
        assert_eq!(share_activity(&rig), ["queued", "steer", "prompt"], "{kind:?}");
        assert_eq!(rig.told(), ["user: start", "end", "user: use the other branch"], "{kind:?}");
        assert!(rig.pane_is_running(), "{kind:?}");
        assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if p.generation == generation), "{kind:?}: the CLI was replaced");
        assert!(!rig.said_session_closed(), "{kind:?}");
    }
}
