//! Process-bounded owner lifecycle regressions. Shell children exercise Host
//! drain and cancellation only; they are not provider compatibility evidence.
use super::*;
use std::sync::mpsc;
use serde_json::json;

const CASE: &str = "TERMINALX_TEST_STDIO_OWNER_CASE";
const WAIT: Duration = Duration::from_secs(3);

thread_local! {
    static FULL_PIPE: std::cell::RefCell<Option<mpsc::Sender<()>>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn observed_full_pipe() {
    FULL_PIPE.with(|hook| { if let Some(tx) = hook.borrow_mut().take() { tx.send(()).unwrap(); } });
}

#[test]
fn owned_stdio_lifecycle_is_process_bounded() {
    for case in ["admission-drain", "retain-drained-child", "full-input-pipe", "expired-input-pipe", "stale-control", "private-diagnostics", "refused-handshake", "refused-exit", "resume-thread", "resume-other-thread", "settings", "to-terminal",
        "phone-input", "phone-compact", "phone-revoked", "share-input", "share-ended", "host-while-shared",
        "continuation-delivered", "continuation-undelivered", "continuation-stopped", "resend-after-restart"] {
        let dir = tempfile::tempdir().unwrap();
        let log = std::fs::File::create(dir.path().join("child.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::codex_stdio::tests::child_fixture", "--nocapture"])
            .env(CASE, case).env("TERMINALX_HOME", dir.path().join("store"))
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log)
            .spawn().unwrap();
        let until = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if Instant::now() >= until {
                child.kill().unwrap(); child.wait().unwrap();
                panic!("{case}: owner lifecycle exceeded process deadline");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(), "{case}: {}", std::fs::read_to_string(dir.path().join("child.log")).unwrap());
    }
}

struct GateSink {
    sink: StdioSink,
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    settled: mpsc::Sender<()>,
}
impl Sink for GateSink {
    fn stdout_line(&self, line: String) {
        self.entered.send(()).unwrap();
        self.release.lock().unwrap().recv_timeout(WAIT).unwrap();
        self.sink.stdout_line(line);
        self.settled.send(()).unwrap();
    }
    fn stderr_line(&self, line: String) { self.sink.stderr_line(line); }
    fn stdout_closed(&self, end: crate::harness::host::ReaderEnd) { self.sink.stdout_closed(end); }
    fn exited(&self, pid: u32, code: Option<i32>) { self.sink.exited(pid, code); }
    fn drained(&self, receipt: &TerminalReceipt) { self.sink.drained(receipt); }
}

/// Stands in for Codex at the process boundary: answers the version probe and
/// the handshake, records each frame it is sent, and plays one turn per
/// `turn/start` or manual compaction until its input closes. While a `hold`
/// file exists it does not answer the thread request, so a test can act
/// between a send and the write of its prompt. A `mode` file beside it, read
/// for each frame, makes it exit after `initialize` (`die`) or never answer
/// the thread request (`hang`).
const RESUMING_CODEX: &str = r#"#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi
while read -r line; do
  printf '%s\n' "$line" >> "$here/received"
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  mode=$(cat "$here/mode" 2>/dev/null)
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id"; [ "$mode" = die ] && exit 0 ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*)
      while [ -f "$here/hold" ]; do sleep 0.02; done
      [ "$mode" = hang ] || printf '{"id":%s,"result":{"thread":{"id":"%s"}}}\n' "$id" "$(cat "$here/answer")" ;;
    *'"method":"thread/compact/start"'*)
      printf '{"id":%s,"result":{}}\n' "$id"
      printf '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-%s"}}}\n' "$id"
      printf '{"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-%s","item":{"type":"contextCompaction","id":"c%s"}}}\n' "$id" "$id"
      printf '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-%s","item":{"type":"contextCompaction","id":"c%s"}}}\n' "$id" "$id"
      printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%s","status":"completed"}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      printf '{"id":%s,"result":{"turn":{"id":"turn-%s"}}}\n' "$id" "$id"
      printf '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-%s"}}}\n' "$id"
      printf '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-%s","itemId":"m%s","delta":"resumed"}}\n' "$id" "$id"
      printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%s","status":"completed"}}}\n' "$id" ;;
  esac
done
"#;

/// A tab whose connection ended (app restart, Stop) keeps its thread: the next
/// send resumes that thread in a new connection, and a reply naming any other
/// thread gets no prompt.
fn resume_fixture(case: &str) {
    use std::os::unix::fs::PermissionsExt;
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("codex"), RESUMING_CODEX).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(bin.join("answer"), if case == "resume-other-thread" { "thread-2" } else { "thread-1" }).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "providerSessionId":"thread-1", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    manager.send("stdio-owner", "tab", "carry on".into(), Vec::new()).unwrap();
    let events = || -> Vec<AgentEvent> { store::read_lines(&store::log_path("stdio-owner", "tab").unwrap()).unwrap() };
    let until = Instant::now() + WAIT;
    let settled = |events: &[AgentEvent]| events.iter().any(|event| matches!(&event.payload, Payload::TurnCompleted { .. } | Payload::Error { .. }));
    while !settled(&events()) {
        assert!(Instant::now() < until, "{case}: no outcome: {:?}", events().iter().map(|event| &event.payload).collect::<Vec<_>>());
        std::thread::sleep(Duration::from_millis(20));
    }
    let received: Vec<serde_json::Value> = std::fs::read_to_string(bin.join("received")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let methods: Vec<_> = received.iter().map(|frame| frame["method"].as_str().unwrap()).collect();
    assert_eq!(index::get("stdio-owner").unwrap().tab("tab").unwrap().provider_session_id.as_deref(), Some("thread-1"));
    assert_eq!(received[2]["params"]["threadId"], "thread-1");
    assert_eq!(received[2]["params"]["excludeTurns"], true);
    let events = events();
    if case == "settings" {
        return settings_fixture(&manager, &bin, &received);
    }
    if case == "to-terminal" {
        return to_terminal_fixture(&manager);
    }
    if case == "resume-thread" {
        assert_eq!(methods, ["initialize", "initialized", "thread/resume", "turn/start"]);
        assert_eq!(received[3]["params"]["input"][0]["text"], "carry on");
        let said: Vec<_> = events.iter().filter_map(|event| match &event.payload {
            Payload::AssistantText { text, .. } => Some(text.as_str()),
            Payload::TurnCompleted { status, .. } => Some(if *status == TurnStatus::Ok { "ok" } else { "not ok" }),
            _ => None,
        }).collect();
        assert_eq!(said, ["resumed", "ok"]);
        assert!(rt_bound(&manager), "the resumed thread must own compaction status again");
    } else {
        assert_eq!(methods, ["initialize", "initialized", "thread/resume"], "no prompt for another thread");
        assert!(events.iter().any(|event| matches!(&event.payload, Payload::Error { detail: Some(detail), .. } if detail.contains("resumed a different thread"))), "{:?}", events.iter().map(|event| &event.payload).collect::<Vec<_>>());
    }
    manager.stop("stdio-owner", "tab").unwrap();
}

/// Model and effort reach a live connection with its next turn. A permission
/// mode is only taken between turns: the connection stops, and the next send
/// resumes the thread under the new approval policy and sandbox.
fn settings_fixture(manager: &SessionManager, bin: &Path, first: &[serde_json::Value]) {
    let frames = || -> Vec<serde_json::Value> { std::fs::read_to_string(bin.join("received")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect() };
    let turns = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap().iter().filter(|event| matches!(event.payload, Payload::TurnCompleted { .. })).count();
    let idle_after = |n: usize| {
        let until = Instant::now() + WAIT;
        while turns() < n || manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().turn_open {
            assert!(Instant::now() < until, "turn {n} did not settle");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    assert_eq!(first[3]["params"]["model"], serde_json::Value::Null);
    idle_after(1);
    manager.set_model("stdio-owner", "tab", "gpt-next").unwrap();
    manager.set_effort("stdio-owner", "tab", Some("high")).unwrap();
    assert!(matches!(manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().engine, Engine::CodexStdio(_)), "model and effort keep the connection");
    manager.send("stdio-owner", "tab", "next".into(), Vec::new()).unwrap();
    idle_after(2);
    let sent = frames();
    assert_eq!(sent.len(), 5, "the same connection takes the next turn");
    assert_eq!((&sent[4]["method"], &sent[4]["params"]["model"], &sent[4]["params"]["effort"]), (&json!("turn/start"), &json!("gpt-next"), &json!("high")));
    for ask in ["manual", "default"] {
        let refused = manager.set_permission_mode("stdio-owner", "tab", ask).unwrap_err();
        assert!(refused.to_string().contains("Ask every time"), "{refused:#}");
    }
    manager.set_permission_mode("stdio-owner", "tab", "plan").unwrap();
    assert!(matches!(manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().engine, Engine::None), "the old approval policy and sandbox are not kept running");
    manager.send("stdio-owner", "tab", "planned".into(), Vec::new()).unwrap();
    idle_after(3);
    let sent = frames();
    let methods: Vec<_> = sent[5..].iter().map(|frame| frame["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["initialize", "initialized", "thread/resume", "turn/start"]);
    let resumed = &sent[7]["params"];
    assert_eq!((&resumed["threadId"], &resumed["approvalPolicy"], &resumed["sandbox"], &resumed["model"]), (&json!("thread-1"), &json!("on-request"), &json!("read-only"), &json!("gpt-next")));
    assert_eq!(sent[8]["params"]["effort"], "high");
    manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().turn_open = true;
    let refused = manager.set_permission_mode("stdio-owner", "tab", "auto").unwrap_err();
    assert!(refused.to_string().contains("between turns"), "{refused:#}");
    manager.stop("stdio-owner", "tab").unwrap();
}

/// Opening the terminal view hands the thread to Codex's own terminal: never
/// mid-turn, only once the connection has exited, and for good.
fn to_terminal_fixture(manager: &SessionManager) {
    let rt = manager.runtime("stdio-owner", "tab").unwrap();
    let chat = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap().into_iter()
        .filter(|event| !matches!(event.payload, Payload::ContextCompactionLifecycle { .. })).count();
    let before = chat();
    rt.lock().unwrap().turn_open = true;
    let refused = manager.codex_stdio_to_terminal("stdio-owner", "tab").unwrap_err();
    assert!(refused.to_string().contains("finish this turn"), "{refused:#}");
    assert!(matches!(rt.lock().unwrap().engine, Engine::CodexStdio(_)));
    rt.lock().unwrap().turn_open = false;
    // An exit Stop cannot confirm leaves the tab where it was, to retry.
    rt.lock().unwrap().stop_in_flight = true;
    assert!(manager.codex_stdio_to_terminal("stdio-owner", "tab").is_err());
    assert_eq!(index::get("stdio-owner").unwrap().tab("tab").unwrap().transport, AgentTransport::ExperimentalCodexStdio);
    rt.lock().unwrap().stop_in_flight = false;
    let child = rt.lock().unwrap().child.clone().expect("a running connection");
    manager.codex_stdio_to_terminal("stdio-owner", "tab").unwrap();
    assert!(child.terminal_receipt().is_some(), "the connection exits before the tab changes engine");
    assert!(matches!(rt.lock().unwrap().engine, Engine::None) && rt.lock().unwrap().child.is_none());
    let tab = index::get("stdio-owner").unwrap().tab("tab").unwrap().clone();
    assert_eq!((tab.transport, tab.provider_session_id.as_deref()), (AgentTransport::Pty, Some("thread-1")));
    manager.codex_stdio_to_terminal("stdio-owner", "tab").unwrap();
    assert_eq!(chat(), before, "the move adds nothing to the chat");
}

/// Continue in New Session into an experimental tab: confirmed once Codex
/// takes the turn, refused (and offered back, never replayed) when Codex goes
/// before it does or Stop comes first, and sent again by "Resend last prompt"
/// after a failure or an app restart.
fn continuation_fixture(case: &str) {
    use std::os::unix::fs::PermissionsExt;
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("codex"), RESUMING_CODEX).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(bin.join("answer"), "thread-1").unwrap();
    std::fs::write(bin.join("mode"), match case { "continuation-undelivered" => "die", "continuation-stopped" => "hang", _ => "" }).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let restart = case == "resend-after-restart";
    // After a restart: a brief and a later prompt in the log, neither taken.
    let tab = if restart {
        json!({"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "providerSessionId":"thread-1", "continuation":1, "created":index::now()})
    } else {
        json!({"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "created":index::now()})
    };
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(), "tabs":[tab]
    })).unwrap();
    index::save(&[session]).unwrap();
    let log = store::log_path("stdio-owner", "tab").unwrap();
    if restart {
        let line = |seq: u64, text: &str| json!({"id": format!("e{seq}"), "sessionId": "stdio-owner", "tabId": "tab", "harness": "codex", "seq": seq, "ts": index::now(),
            "payload": {"type":"user_message", "text": text, "images": [], "queued": false}}).to_string();
        std::fs::write(&log, format!("{}\n{}\n", line(1, "the brief"), line(2, "a later prompt"))).unwrap();
    }
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let rt = manager.runtime("stdio-owner", "tab").unwrap();
    let frames = || -> Vec<serde_json::Value> { std::fs::read_to_string(bin.join("received")).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect() };
    let starts = || frames().iter().filter(|frame| frame["method"] == "turn/start").map(|frame| frame["params"]["input"][0]["text"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let events = || store::read_lines::<AgentEvent>(&log).unwrap();
    let settled = |n: usize| {
        let until = Instant::now() + WAIT;
        while events().iter().filter(|event| matches!(event.payload, Payload::TurnCompleted { status: TurnStatus::Ok, .. })).count() < n || rt.lock().unwrap().turn_open {
            assert!(Instant::now() < until, "{case}: turn {n} did not settle: {:?}", events().iter().map(|event| &event.payload).collect::<Vec<_>>());
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    match case {
        "continuation-delivered" => {
            let outcome = manager.send_confirmed("stdio-owner", "tab", "the brief".into()).unwrap();
            assert!(!outcome.in_input);
            let seq = outcome.events[0].seq;
            assert_eq!(index::get("stdio-owner").unwrap().tab("tab").unwrap().continuation, Some(seq));
            let methods: Vec<_> = frames().iter().map(|frame| frame["method"].as_str().unwrap().to_owned()).collect();
            assert_eq!(methods, ["initialize", "initialized", "thread/start", "turn/start"]);
            assert_eq!(starts(), ["the brief"]);
            settled(1);
        }
        "continuation-undelivered" | "continuation-stopped" => {
            let refused = if case == "continuation-stopped" {
                let sender = manager.clone();
                let waiting = std::thread::spawn(move || sender.send_confirmed("stdio-owner", "tab", "the brief".into()));
                let until = Instant::now() + WAIT;
                while !frames().iter().any(|frame| frame["method"] == "thread/start") {
                    assert!(Instant::now() < until, "Codex was never asked for a thread");
                    std::thread::sleep(Duration::from_millis(20));
                }
                manager.stop("stdio-owner", "tab").unwrap();
                waiting.join().unwrap().unwrap_err()
            } else {
                manager.send_confirmed("stdio-owner", "tab", "the brief".into()).unwrap_err()
            };
            let said = format!("{refused:#}");
            assert!(said.contains(if case == "continuation-stopped" { "stopped before Codex received" } else { "did not receive" }), "{said}");
            assert!(starts().is_empty(), "Codex never took the brief");
            assert_eq!(rt.lock().unwrap().recovery, Some(RecoveryKind::Unsent));
            assert!(!rt.lock().unwrap().turn_open);
            let ended: Vec<_> = events().iter().filter_map(|event| match &event.payload { Payload::TurnCompleted { status, .. } => Some(*status), _ => None }).collect();
            assert_eq!(ended, [TurnStatus::Aborted]);
            // Offered back, sent only when asked, and without a Stop first:
            // a click comes after the dead child's readers have drained.
            let until = Instant::now() + WAIT;
            while rt.lock().unwrap().child.as_ref().is_some_and(|child| child.terminal_receipt().is_none()) {
                assert!(Instant::now() < until, "the dead child was never drained");
                std::thread::sleep(Duration::from_millis(20));
            }
            std::fs::write(bin.join("mode"), "").unwrap();
            manager.resend_unsent("stdio-owner", "tab").unwrap();
            settled(1);
            assert_eq!(starts(), ["the brief"], "the brief goes once, when the reader resends it");
        }
        "resend-after-restart" => {
            manager.load_events("stdio-owner", "tab").unwrap();
            assert_eq!(rt.lock().unwrap().recovery, Some(RecoveryKind::Unsent), "never taken, so not a lost connection");
            manager.resend_unsent("stdio-owner", "tab").unwrap();
            settled(1);
            let methods: Vec<_> = frames().iter().map(|frame| frame["method"].as_str().unwrap().to_owned()).collect();
            assert_eq!(methods, ["initialize", "initialized", "thread/resume", "turn/start"]);
            assert_eq!(starts(), ["the brief"], "the unanswered brief goes before the later prompt");
        }
        _ => unreachable!(),
    }
    manager.stop("stdio-owner", "tab").unwrap();
}

/// A phone, a share's guest and the host of a shared session reach a native
/// tab as they reach a PTY one. Each prompt is delivered under a permit that
/// is still current when its frame is written; one that is not is withdrawn
/// with nothing of it sent, and the turn it opened ends as stopped. It is not
/// offered back: its sender may no longer give it, and a resend would be the
/// host's.
fn remote_input_fixture(case: &str) {
    use std::os::unix::fs::PermissionsExt;
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("codex"), RESUMING_CODEX).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(bin.join("answer"), "thread-1").unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "providerSessionId":"thread-1", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    store::write_json(&root.join("devices.json"), &json!({"devices":[{
        "id":"driver","label":"Fixture","platform":"test","token":"fixture-hash",
        "scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":index::now()
    }]})).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let events = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap();
    let methods = || -> Vec<String> {
        std::fs::read_to_string(bin.join("received")).unwrap_or_default().lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()["method"].as_str().unwrap().to_owned()).collect()
    };
    let last_frame = || -> serde_json::Value { serde_json::from_str(std::fs::read_to_string(bin.join("received")).unwrap().lines().last().unwrap()).unwrap() };
    let idle_after = |frames: usize| {
        let until = Instant::now() + WAIT;
        while methods().len() < frames || manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().turn_open {
            assert!(Instant::now() < until, "{case}: did not settle: {:?} {:?}", methods(), events().iter().map(|event| &event.payload).collect::<Vec<_>>());
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let ended = || events().iter().filter_map(|event| match &event.payload { Payload::TurnCompleted { status, .. } => Some(*status), _ => None }).collect::<Vec<_>>();
    let users = || events().iter().filter_map(|event| match &event.payload {
        Payload::UserMessage { text, author, .. } => Some((text.clone(), author.as_ref().map(|person| person.user_id.clone()))),
        _ => None,
    }).collect::<Vec<_>>();
    let ready = || matches!(&manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().engine, Engine::CodexStdio(engine) if engine.ready && !engine.blocked && !engine.exited);
    if case.starts_with("phone-") {
        let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(60));
        let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
        let actor: crate::local_runtime::mobile::Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
        manager.mobile.register(&lifetime, actor.clone(), "connection", "driver").unwrap();
        let permit = manager.mobile.permit(&actor, "connection", "stdio-owner", "tab").unwrap();
        // As `mobile::execute` sends it: who it is from, then what was typed.
        let typed = if case == "phone-compact" { "/compact" } else { "from the phone" };
        let agent = format!("[TerminalX Effective User v1] {{\"authority\":\"host\",\"userId\":\"driver\"}}\n{typed}");
        if case == "phone-revoked" { std::fs::write(bin.join("hold"), "").unwrap(); }
        manager.send_mobile("stdio-owner", "tab", agent.clone(), typed.into(), Vec::new(), permit).unwrap();
        match case {
            "phone-input" => {
                idle_after(4);
                assert_eq!(methods(), ["initialize", "initialized", "thread/resume", "turn/start"]);
                assert_eq!(last_frame()["params"]["input"][0]["text"], agent.as_str(), "the agent is told who the prompt is from");
                assert_eq!(users(), [("from the phone".to_owned(), None)]);
                assert_eq!(ended(), [TurnStatus::Ok]);
            }
            "phone-compact" => {
                idle_after(4);
                assert_eq!(methods(), ["initialize", "initialized", "thread/resume", "thread/compact/start"]);
                assert!(users().is_empty() && ended().is_empty(), "a compaction is no user message or turn (#524/#566)");
            }
            _ => {
                manager.mobile.revoke_device(&actor, "driver").unwrap();
                std::fs::remove_file(bin.join("hold")).unwrap();
                idle_after(3);
                assert_eq!(methods(), ["initialize", "initialized", "thread/resume"], "a revoked phone's prompt is not written");
                assert_eq!(ended(), [TurnStatus::Aborted]);
                assert!(ready(), "the connection stays usable");
                assert_eq!(manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().recovery, None, "a withdrawn prompt is not offered back");
            }
        }
    } else {
        let now = chrono::Utc::now().timestamp_millis();
        let mut share = crate::local_sharing::tests::fixture();
        let link = share.links.get_mut("link").unwrap();
        link.settings.expires_at = now + 3_600_000;
        link.credential_expires_at = now + 3_600_000;
        let mut guest = crate::local_sharing::tests::guest("guest-connection", "alice");
        guest.verified_until = now + 3_600_000;
        let person = guest.person.clone();
        share.join(guest, now).unwrap();
        let permit = share.write_permit("guest-connection", "tab").unwrap();
        manager.sharing.lock().unwrap().sessions.insert("stdio-owner".into(), share);
        match case {
            "share-input" => {
                manager.send_shared("stdio-owner", "tab", "from a guest".into(), person, permit).unwrap();
                idle_after(4);
                assert_eq!(last_frame()["params"]["input"][0]["text"], "from a guest");
                assert_eq!(users(), [("from a guest".to_owned(), Some("alice".to_owned()))]);
                assert_eq!(ended(), [TurnStatus::Ok]);
            }
            "share-ended" => {
                std::fs::write(bin.join("hold"), "").unwrap();
                manager.send_shared("stdio-owner", "tab", "from a guest".into(), person, permit).unwrap();
                manager.sharing.lock().unwrap().sessions.remove("stdio-owner");
                std::fs::remove_file(bin.join("hold")).unwrap();
                idle_after(3);
                assert_eq!(methods(), ["initialize", "initialized", "thread/resume"], "a guest of an ended share sends nothing");
                assert_eq!(ended(), [TurnStatus::Aborted]);
                assert!(ready(), "the connection stays usable");
                assert_eq!(manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().recovery, None, "a withdrawn prompt is not offered back");
            }
            _ => {
                manager.send("stdio-owner", "tab", "from the host".into(), Vec::new()).unwrap();
                idle_after(4);
                assert_eq!(users(), [("from the host".to_owned(), Some("host".to_owned()))], "the host's message says it is theirs");
                assert_eq!(ended(), [TurnStatus::Ok]);
            }
        }
    }
    manager.stop("stdio-owner", "tab").unwrap();
}

fn rt_bound(manager: &SessionManager) -> bool {
    manager.runtime("stdio-owner", "tab").unwrap().lock().unwrap().stdio_compaction.is_some()
}

#[test]
fn child_fixture() {
    let Ok(case) = std::env::var(CASE) else { return };
    if matches!(case.as_str(), "resume-thread" | "resume-other-thread" | "settings" | "to-terminal") { return resume_fixture(&case); }
    if matches!(case.as_str(), "phone-input" | "phone-compact" | "phone-revoked" | "share-input" | "share-ended" | "host-while-shared") { return remote_input_fixture(&case); }
    if matches!(case.as_str(), "continuation-delivered" | "continuation-undelivered" | "continuation-stopped" | "resend-after-restart") { return continuation_fixture(&case); }
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let rt_arc = manager.runtime("stdio-owner", "tab").unwrap();
    let (entered, observed) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let (settled, done) = mpsc::channel();
    let mut rt = rt_arc.lock().unwrap();
    let mut engine = Stdio::new(root.to_string_lossy().into_owned(), String::new(), None, "auto".into(), None);
    let frame = if matches!(case.as_str(), "expired-input-pipe" | "stale-control") {
        engine.thread = Some("thread".into());
        engine.ready = true;
        engine.handle(r#"{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"turn"}}}"#).unwrap();
        let StdioAction::Write(mut frame) = engine.interrupt().unwrap().remove(0) else { panic!("missing interrupt") };
        // Inflate a typed frame to exercise partial delivery, not protocol
        // compatibility. This shell child never interprets the bytes.
        let mut json: serde_json::Value = serde_json::from_str(&frame.line).unwrap();
        json["testPadding"] = serde_json::Value::String("x".repeat(1024 * 1024));
        frame.line = json.to_string();
        frame
    } else { Outbound::connection("large input".repeat(65536)) };
    let launch = engine.launch.clone();
    rt.engine = Engine::CodexStdio(engine);
    // #667: a Codex whose provider refuses its sign-in before its thread is
    // ready, said in a protocol error or on stderr as it exits.
    if matches!(case.as_str(), "refused-handshake" | "refused-exit") {
        const REVOKED: &str = "account/read failed: workspace routing discovery unauthorized (401)";
        let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
        engine.start("fix the build".into(), Vec::new()).unwrap();
        manager.publish(&mut rt, Payload::UserMessage { author: None, text: "fix the build".into(), images: vec![], baseline: None, queued: false, cwd: None }, None);
        rt.open_turn();
        drop(rt);
        let sink = StdioSink { manager: manager.clone(), rt: rt_arc.clone(), launch: launch.clone(), startup_stderr_bytes: Mutex::new(0), startup_stderr: Mutex::new(String::new()) };
        let said = if case == "refused-handshake" {
            sink.stdout_line(json!({"id": 1, "error": {"code": -32603, "message": REVOKED}}).to_string());
            format!("Codex request failed: {REVOKED}")
        } else {
            sink.stderr_line("Starting Codex".into());
            sink.stderr_line(REVOKED.into());
            sink.stdout_closed(crate::harness::host::ReaderEnd::Eof);
            REVOKED.to_string()
        };
        let events: Vec<AgentEvent> = store::read_lines(&store::log_path("stdio-owner", "tab").unwrap()).unwrap();
        let ended: Vec<_> = events.iter().filter_map(|event| match &event.payload {
            Payload::TurnCompleted { status, auth_failed, detail, final_text, .. } => Some((*status, *auth_failed, detail.clone(), final_text.clone())),
            _ => None,
        }).collect();
        assert_eq!(ended, [(TurnStatus::Error, true, Some(said), Some(RecoveryKind::SignedOut.message().to_string()))], "{case}");
        let rt = rt_arc.lock().unwrap();
        assert_eq!(rt.recovery, Some(RecoveryKind::SignedOut), "{case}");
        assert!(!rt.turn_open);
        return;
    }
    if case == "private-diagnostics" {
        let path = rt.diagnostics_path();
        let seq = rt.seq;
        drop(rt);
        let sink = StdioSink { manager: manager.clone(), rt: rt_arc.clone(), launch: launch.clone(), startup_stderr_bytes: Mutex::new(0), startup_stderr: Mutex::new(String::new()) };
        sink.stderr_line("é".repeat(3000));
        sink.stderr_line("must not exceed startup budget".into());
        let lines: Vec<serde_json::Value> = std::fs::read_to_string(&path).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["detail"]["text"].as_str().unwrap().len(), 4096);
        assert_eq!(lines[0]["detail"]["truncated"], true);
        let retained = std::fs::read(&path).unwrap();
        {
            let mut rt = rt_arc.lock().unwrap();
            let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
            engine.ready = true;
        }
        let ready_sink = StdioSink { manager: manager.clone(), rt: rt_arc.clone(), launch: launch.clone(), startup_stderr_bytes: Mutex::new(0), startup_stderr: Mutex::new(String::new()) };
        ready_sink.stderr_line("model-work stderr is not captured".into());
        assert_eq!(std::fs::read(&path).unwrap(), retained);
        let mut rt = rt_arc.lock().unwrap();
        assert_eq!(rt.seq, seq);
        assert!(rt.recovery.is_none());
        let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
        engine.ready = false;
        rt.child_pid = Some(42);
        drop(rt);
        let stale = StdioSink { manager: manager.clone(), rt: rt_arc.clone(), launch: Arc::new(()), startup_stderr_bytes: Mutex::new(0), startup_stderr: Mutex::new(String::new()) };
        stale.stderr_line("wrong launch".into());
        stale.exited(42, Some(7));
        assert_eq!(std::fs::read(&path).unwrap(), retained);
        sink.exited(42, Some(7));
        let lines: Vec<serde_json::Value> = std::fs::read_to_string(&path).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["detail"], json!({"stage":"exit", "code":7, "stop_requested":false}));
        assert_eq!(rt_arc.lock().unwrap().seq, seq);
        return;
    }
    if case == "stale-control" {
        let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
        engine.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}"#).unwrap();
        drop(rt);
        // There is deliberately no child: a stale, entirely unsent control
        // must retire before touching stdin and without failing the owner.
        manager.write_codex_frame(&Arc::downgrade(&rt_arc), &launch, frame).unwrap();
        assert!(matches!(&rt_arc.lock().unwrap().engine, Engine::CodexStdio(e) if !e.blocked));
        return;
    }
    let sink = Arc::new(GateSink { sink: StdioSink { manager: manager.clone(), rt: rt_arc.clone(), launch: launch.clone(), startup_stderr_bytes: Mutex::new(0), startup_stderr: Mutex::new(String::new()) },
        entered, release: Mutex::new(gate), settled });
    // A complete buffered frame is held at the callback boundary. The process
    // exits naturally, so even a failed assertion leaves no long-lived child.
    let script = if matches!(case.as_str(), "full-input-pipe" | "expired-input-pipe") {
        r#"printf '%s\n' '{"method":"thread/status/changed","params":{"threadId":"unbound"}}'; exec sleep 10"#
    } else {
        r#"printf '%s\n' '{"method":"thread/status/changed","params":{"threadId":"unbound"}}'"#
    };
    let args = vec!["-c".into(), script.into()];
    let child = manager.host.spawn(&rt.key(), SpawnSpec { program: Path::new("/bin/sh"), args: &args, cwd: &root, env: &[] }, sink).unwrap();
    rt.child_pid = Some(child.pid); rt.child = Some(child.clone());
    drop(rt);
    observed.recv_timeout(WAIT).unwrap();
    if matches!(case.as_str(), "full-input-pipe" | "expired-input-pipe") {
        // The production writer fills the initially blocking pipe itself.
        // No prefill changes the descriptor flags before the writer runs.
        let writer_manager = manager.clone();
        let runtime = Arc::downgrade(&rt_arc);
        let (finished, result) = mpsc::channel();
        let (blocked, full_pipe) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            FULL_PIPE.with(|hook| *hook.borrow_mut() = Some(blocked));
            finished.send(writer_manager.write_codex_frame(&runtime, &launch, frame)).unwrap();
        });
        full_pipe.recv_timeout(WAIT).unwrap();
        // Buffered stdout and Stop must both advance despite the full stdin.
        release.send(()).unwrap();
        done.recv_timeout(WAIT).unwrap();
        assert!(matches!(&rt_arc.lock().unwrap().engine, Engine::CodexStdio(e) if !e.blocked && !e.exited));
        assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
        if case == "expired-input-pipe" {
            let mut rt = rt_arc.lock().unwrap();
            let Engine::CodexStdio(engine) = &mut rt.engine else { panic!("owner missing") };
            engine.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}"#).unwrap();
            drop(rt);
            let error = result.recv_timeout(WAIT).unwrap().unwrap_err();
            assert!(error.to_string().contains("partial write"), "expired partial frame must fail, got {error:#}");
            manager.stop("stdio-owner", "tab").unwrap();
        } else {
            manager.stop("stdio-owner", "tab").unwrap();
            let error = result.recv_timeout(WAIT).unwrap().unwrap_err();
            assert!(error.to_string().contains("cancelled"), "expected Stop cancellation, got {error:#}");
        }
        writer.join().unwrap();
        assert!(child.terminal_receipt().is_some());
    } else if case == "admission-drain" {
        // This is the distinguishing close/delete/stop-all schedule: admission
        // stays held until Stop has received the Host terminal receipt.
        let _admission = crate::issue_pipeline::admission::lock();
        release.send(()).unwrap();
        manager.stop("stdio-owner", "tab").unwrap();
        done.recv_timeout(WAIT).unwrap();
        assert!(child.terminal_receipt().is_some());
    } else {
        release.send(()).unwrap();
        done.recv_timeout(WAIT).unwrap();
        let until = Instant::now() + WAIT;
        while child.terminal_receipt().is_none() {
            assert!(Instant::now() < until, "Host did not publish reader receipt");
            std::thread::sleep(Duration::from_millis(5));
        }
        let rt = rt_arc.lock().unwrap();
        assert!(matches!(rt.engine, Engine::CodexStdio(_)));
        assert!(rt.child.as_ref().is_some_and(|retained| Arc::ptr_eq(retained, &child)), "drain must retain the exact cleanup witness");
        assert_eq!(rt.child_pid, Some(child.pid));
        drop(rt);
        manager.stop("stdio-owner", "tab").unwrap();
        assert!(rt_arc.lock().unwrap().child.is_none());
    }
}
