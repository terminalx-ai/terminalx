//! Process-bounded owner lifecycle regressions. Shell children exercise Host
//! drain and cancellation only; they are not provider compatibility evidence.
use super::*;
use std::sync::mpsc;
use serde_json::json;

const CASE: &str = "TERMINALX_TEST_STDIO_OWNER_CASE";
const WAIT: Duration = Duration::from_secs(3);

thread_local! {
    static FULL_PIPE: std::cell::RefCell<Option<mpsc::Sender<()>>> = const { std::cell::RefCell::new(None) };
    static HANDOFF_FENCED: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn handoff_fenced() {
    HANDOFF_FENCED.with(|hook| { if let Some(run) = hook.borrow_mut().take() { run(); } });
}
pub(super) fn observed_full_pipe() {
    FULL_PIPE.with(|hook| { if let Some(tx) = hook.borrow_mut().take() { tx.send(()).unwrap(); } });
}

#[test]
fn owned_stdio_lifecycle_is_process_bounded() {
    for case in ["admission-drain", "retain-drained-child", "full-input-pipe", "expired-input-pipe", "stale-control", "private-diagnostics", "refused-handshake", "refused-exit", "resume-thread", "resume-other-thread", "settings", "to-terminal",
        "phone-input", "phone-compact", "phone-revoked", "phone-reconcile-race", "share-input", "share-ended", "host-while-shared",
        "continuation-delivered", "continuation-undelivered", "continuation-stopped", "resend-after-restart",
        "native-fallback-send", "native-fallback-start", "native-supported-start", "cloud-launch", "streamed-reply", "streamed-stopped",
        "mailbox-after-refusal", "mailbox-cli-waiting", "busy-while-working"] {
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

/// Exercise the actual stdout reader and watcher together: activity during a
/// long turn must renew the silence deadline, and stale launch output cannot.
#[test]
fn codex_stdout_renews_activity_and_clears_only_watcher_timeouts() {
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-activity", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let rt = manager.runtime("stdio-activity", "tab").unwrap();
    let mut engine = Stdio::new(root.to_string_lossy().into_owned(), String::new(), None, "auto".into(), None);
    engine.thread = Some("thread".into());
    engine.ready = true;
    let launch = engine.launch.clone();
    let sink = StdioSink { manager: manager.clone(), rt: rt.clone(), launch, startup_stderr_bytes: Mutex::new(0), startup_stderr: Mutex::new(String::new()) };
    let patience = recovery::Patience::DEFAULT;
    {
        let mut rt = rt.lock().unwrap();
        rt.engine = Engine::CodexStdio(engine);
        rt.open_turn();
        rt.status = TabStatus::InProgress;
        rt.last_activity = Instant::now() - patience.stall - Duration::from_secs(1);
    }
    // A tool result, rather than assistant text, must count as activity too.
    let frame = json!({"method":"item/completed", "params":{"threadId":"thread", "turnId":"turn",
        "item":{"id":"tool", "type":"commandExecution", "status":"completed", "exitCode":0, "aggregatedOutput":"ok"}}}).to_string();
    sink.stdout_line(frame.clone());
    manager.watch_tabs(patience, Instant::now(), |_| None);
    assert_eq!(rt.lock().unwrap().recovery, None, "recent native output must not be called a five-minute stall");
    assert_eq!(rt.lock().unwrap().status, TabStatus::InProgress);

    // Genuine silence still warns. The next tool result clears that guess
    // immediately and starts a fresh deadline, without another user prompt.
    let deadline = rt.lock().unwrap().last_activity + patience.stall;
    manager.watch_tabs(patience, deadline, |_| None);
    assert_eq!(rt.lock().unwrap().recovery, Some(RecoveryKind::Timeout));
    let stale = StdioSink { manager: manager.clone(), rt: rt.clone(), launch: Arc::new(()), startup_stderr_bytes: Mutex::new(0), startup_stderr: Mutex::new(String::new()) };
    let before = rt.lock().unwrap().last_activity;
    stale.stdout_line(frame.clone());
    assert_eq!(rt.lock().unwrap().last_activity, before);
    assert_eq!(rt.lock().unwrap().recovery, Some(RecoveryKind::Timeout));
    sink.stdout_line(frame.clone());
    assert_eq!(rt.lock().unwrap().recovery, None);
    manager.watch_tabs(patience, Instant::now(), |_| None);
    assert_eq!(rt.lock().unwrap().status, TabStatus::InProgress);

    // An explicit provider failure is not a silence guess. Do not erase it
    // just because more transport output arrives.
    manager.needs_recovery(&mut rt.lock().unwrap(), RecoveryKind::SignedOut, crate::recovery_log::Source::SignIn);
    sink.stdout_line(frame);
    assert_eq!(rt.lock().unwrap().recovery, Some(RecoveryKind::SignedOut));
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
        assert!(Instant::now() < until, "{case}: no outcome: {:?}; provider received: {:?}",
            events().iter().map(|event| &event.payload).collect::<Vec<_>>(), std::fs::read_to_string(bin.join("received")));
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
/// mid-turn: the request waits without fencing its writer. Once idle it moves
/// only after the connection has exited, and for good.
fn to_terminal_fixture(manager: &SessionManager) {
    let rt = manager.runtime("stdio-owner", "tab").unwrap();
    let local_move = |defer| {
        let mut params = json!({"sessionId":"stdio-owner", "tabId":"tab"});
        if defer { params["deferUntilIdle"] = json!(true); }
        crate::local_runtime::calls::execute(manager, &manager.sink, "runtime.session.toTerminal", params)
    };
    let chat = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap().into_iter()
        .filter(|event| !matches!(event.payload, Payload::ContextCompactionLifecycle { .. } | Payload::Recovery { .. })).count();
    let before = chat();
    rt.lock().unwrap().turn_open = true;
    crate::issue_pipeline::admission::observe_next_lock(Some(Box::new(|| {
        assert!(!crate::issue_pipeline::admission::held("stdio-owner", "tab"), "checking an active turn must not fence its writer");
    })), None);
    assert!(!manager.codex_stdio_to_terminal("stdio-owner", "tab").unwrap(), "an active turn defers the switch without an error");
    assert!(local_move(false).unwrap_err().to_string().contains("still working"), "a protocol 1 caller cannot interpret a deferred success");
    assert!(!serde_json::from_value::<bool>(local_move(true).unwrap()).unwrap());
    assert!(matches!(rt.lock().unwrap().engine, Engine::CodexStdio(_)));
    rt.lock().unwrap().turn_open = false;
    // Interrupt was queued just before natural completion. Release its writer
    // inside the real handoff's fence, before missing history refuses the move.
    let (launch, interrupt) = {
        let mut rt = rt.lock().unwrap();
        let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
        engine.handle(r#"{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"finishing"}}}"#).unwrap();
        let StdioAction::Write(frame) = engine.interrupt().unwrap().remove(0) else { panic!("missing interrupt") };
        engine.handle(r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"finishing","status":"completed"}}}"#).unwrap();
        (engine.launch.clone(), frame)
    };
    let (writer, runtime) = (manager.clone(), Arc::downgrade(&rt));
    HANDOFF_FENCED.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
        assert!(crate::issue_pipeline::admission::held("stdio-owner", "tab"));
        writer.write_codex_frame(&runtime, &launch, interrupt, None, None).expect("a completed turn's queued interrupt must retire without failing its owner");
    })));
    let refused = manager.codex_stdio_to_terminal("stdio-owner", "tab").unwrap_err();
    assert!(refused.to_string().contains("saved conversation is not available"), "{refused:#}");
    assert!(matches!(&rt.lock().unwrap().engine, Engine::CodexStdio(engine) if !engine.failed()), "a missing rollout keeps the native owner usable");
    assert_eq!(rt.lock().unwrap().recovery, None);
    let relative = "sessions/2026/11/01/rollout-2026-11-01T00-00-00-thread-1.jsonl";
    let source = codex::home::native_root().unwrap().join(relative);
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, "{}\n").unwrap();
    // A previous refused handoff's copy must not hide later native work.
    let managed = codex::home::managed_root().unwrap().join(relative);
    std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
    std::fs::write(&managed, "").unwrap();
    // An exit Stop cannot confirm leaves the tab where it was, to retry.
    rt.lock().unwrap().stop_in_flight = true;
    assert!(manager.codex_stdio_to_terminal("stdio-owner", "tab").is_err());
    assert_eq!(index::get("stdio-owner").unwrap().tab("tab").unwrap().transport, AgentTransport::ExperimentalCodexStdio);
    rt.lock().unwrap().stop_in_flight = false;
    manager.needs_recovery(&mut rt.lock().unwrap(), RecoveryKind::Timeout, crate::recovery_log::Source::Watcher);
    let child = rt.lock().unwrap().child.clone().expect("a running connection");
    manager.codex_stdio_to_terminal("stdio-owner", "tab").unwrap();
    assert!(child.terminal_receipt().is_some(), "the connection exits before the tab changes engine");
    assert!(matches!(rt.lock().unwrap().engine, Engine::None) && rt.lock().unwrap().child.is_none());
    let tab = index::get("stdio-owner").unwrap().tab("tab").unwrap().clone();
    assert_eq!((tab.transport, tab.provider_session_id.as_deref()), (AgentTransport::Pty, Some("thread-1")));
    assert_eq!(std::fs::read(&managed).unwrap(), std::fs::read(&source).unwrap(), "the terminal takes the latest saved conversation");
    manager.codex_stdio_to_terminal("stdio-owner", "tab").unwrap();
    assert_eq!(chat(), before, "the move adds no prompts, turns or errors to the chat");
    serde_json::from_value::<()>(local_move(false).unwrap()).expect("an older desktop must still decode a completed handoff as null");
    assert!(serde_json::from_value::<bool>(local_move(true).unwrap()).unwrap());
    assert_eq!(rt.lock().unwrap().recovery, None, "the successful handoff clears the previous connection's warning");
    let path = rt.lock().unwrap().diagnostics_path();
    let trace: Vec<serde_json::Value> = store::read_lines::<serde_json::Value>(&path).unwrap().into_iter()
        .filter(|line| line["type"] == "terminal_view_transition").collect();
    assert!(trace.iter().any(|line| line["report"]["stage"] == "waiting_for_turn" && line["turn_open"] == true && line["transport"] == "experimentalCodexStdio"));
    assert!(trace.iter().any(|line| line["report"]["errorCategory"] == "owner_cleanup"));
    assert!(trace.iter().any(|line| line["report"]["errorCategory"] == "conversation_unavailable" && line["transport"] == "experimentalCodexStdio"));
    assert!(trace.iter().any(|line| line["report"]["stage"] == "transport_changed" && line["transport"] == "pty"));
    assert!(!serde_json::to_string(&trace).unwrap().contains("carry on"), "no conversation content in diagnostics");
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
    let root = store::root().unwrap().canonicalize().unwrap();
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
    if case.starts_with("native3-") { return native3_fixture(case, &manager, &root, &bin); }
    if case.starts_with("phone-") {
        let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(60));
        let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
        let actor: crate::local_runtime::mobile::Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
        manager.mobile.register(&lifetime, actor.clone(), "connection", "driver").unwrap();
        let permit = manager.mobile.permit(&actor, "connection", "stdio-owner", "tab").unwrap();
        // As `mobile::execute` sends it: who it is from, then what was typed.
        let typed = if case == "phone-compact" { "/compact" } else { "from the phone" };
        let agent = format!("[TerminalX Effective User v1] {{\"authority\":\"host\",\"userId\":\"driver\"}}\n{typed}");
        if matches!(case, "phone-revoked" | "phone-reconcile-race") { std::fs::write(bin.join("hold"), "").unwrap(); }
        let grant = permit.grant.clone();
        manager.send_mobile("stdio-owner", "tab", agent.clone(), typed.into(), Vec::new(), permit).unwrap();
        match case {
            "phone-reconcile-race" => {
                // A phone's reconcile holds its grant, then reads the tab
                // (`mobile::execute`). The writer, reaching that phone's
                // prompt meanwhile, must wait for the grant without holding
                // the tab, or neither can go on.
                let (held_tx, held_rx) = mpsc::channel();
                let (read_tx, read_rx) = mpsc::channel();
                let reconciling = manager.clone();
                let reconciler = std::thread::spawn(move || {
                    let _held = grant.enter().unwrap();
                    held_tx.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(300));
                    read_tx.send(reconciling.load_events("stdio-owner", "tab").map(|_| ())).unwrap();
                });
                held_rx.recv_timeout(WAIT).unwrap();
                std::fs::remove_file(bin.join("hold")).unwrap();
                read_rx.recv_timeout(WAIT).expect("a phone reconcile and the native writer deadlocked").unwrap();
                reconciler.join().unwrap();
                idle_after(4);
                assert_eq!(last_frame()["params"]["input"][0]["text"], agent.as_str());
                assert_eq!(ended(), [TurnStatus::Ok]);
            }
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

/// Stands in for Codex at a tab's first launch: says the version it is told
/// to, offers `--no-daemon` like a terminal-capable Codex, and records how it
/// was started each time.
/// A cloud workspace's grant snapshot and configuration for the
/// `cloud-launch` case, as `cloud_grants` and `cloud_config` would give a
/// terminal launch: a credential file, a variable, one to clear, a route with
/// its own model and provider, and developer instructions.
pub(super) fn cloud_stand_in() -> Option<(crate::cloud_grants::LaunchGrant, crate::cloud_config::LaunchConfig)> {
    if std::env::var(CASE).as_deref() != Ok("cloud-launch") { return None; }
    let mut grant = crate::cloud_grants::LaunchGrant::default();
    grant.env = vec![("CODEX_API_KEY".into(), Some("grant-secret".into())), ("OPENAI_API_KEY".into(), None)];
    grant.route = Some(crate::cloud_grants::RouteLaunch { model: Some("routed-model".into()), codex_args: " -c 'model_provider=\"route\"'".into(), ..Default::default() });
    grant.codex_auth = Some(Some(store::root().unwrap().join("grant-auth.json")));
    let config = crate::cloud_config::LaunchConfig { env: vec![("NODE_ENV".into(), "test".into())], args: " -c 'developer_instructions=\"brief\"'".into() };
    Some((grant, config))
}

#[test]
fn shell_quoted_launch_arguments_come_back_as_the_words_a_shell_would_pass() {
    // How `cloud_config` and `cloud_grants` quote for a terminal launch.
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let instructions = "developer_instructions=\"Be brief.\nIt's fine.\"";
    let server = "mcp_servers.docs={ url = \"https://example.test/mcp\", env_vars = [\"MCP_HEADER_SECRET_0\"] }";
    let text = format!(" -c {} -c {}", quote(instructions), quote(server));
    assert_eq!(shell_words(&text), ["-c", instructions, "-c", server]);
    assert!(shell_words("").is_empty());
    assert_eq!(shell_words(r#"a  ''  "b \"c\"" d\ e"#), ["a", "", "b \"c\"", "d e"]);
}

#[test]
fn a_cloud_launch_takes_the_route_configuration_and_credential_like_a_terminal_one() {
    let mut grant = crate::cloud_grants::LaunchGrant::default();
    grant.env = vec![("CODEX_API_KEY".into(), Some("grant-secret".into())), ("OPENAI_API_KEY".into(), None)];
    grant.route = Some(crate::cloud_grants::RouteLaunch { model: Some("routed-model".into()), codex_args: " -c 'model_provider=\"route\"'".into(), notice: Some("The route is not answering".into()), ..Default::default() });
    let config = crate::cloud_config::LaunchConfig { env: vec![("NODE_ENV".into(), "test".into())], args: " -c 'developer_instructions=\"brief\"'".into() };
    let native = native_launch(&grant, &config, " -c 'mcp_servers.computer={}'");
    assert_eq!(native.args, ["-c", "model_provider=\"route\"", "-c", "developer_instructions=\"brief\"", "-c", "mcp_servers.computer={}", "app-server", "--listen", "stdio://"]);
    // The grant's variables come last, so a credential always wins.
    assert_eq!(native.env, [("NODE_ENV".to_string(), "test".to_string()), ("CODEX_API_KEY".to_string(), "grant-secret".to_string())]);
    assert_eq!(native.unset, ["OPENAI_API_KEY"]);
    assert_eq!((native.model.as_deref(), native.notice.as_deref()), (Some("routed-model"), Some("The route is not answering")));

    // Outside a workspace: the app server and nothing else.
    let local = native_launch(&Default::default(), &Default::default(), "");
    assert_eq!(local.args, ["app-server", "--listen", "stdio://"]);
    assert!(local.env.is_empty() && local.unset.is_empty() && local.model.is_none());
}

/// Stands in for Codex in a cloud workspace: records the arguments and the
/// variables it was started with, starts a thread and plays one turn. Like
/// Codex, it makes `$CODEX_HOME/tmp` at every start, `--version` included,
/// and it records the home each version probe ran in.
const CLOUD_CODEX: &str = r#"#!/bin/sh
here=$(dirname "$0")
[ -n "${CODEX_HOME-}" ] && mkdir -p "$CODEX_HOME/tmp/arg0"
if [ "$1" = "--version" ]; then printf '%s\n' "${CODEX_HOME-}" >> "$here/probes"; echo "codex-cli 0.166.0"; exit 0; fi
printf '%s\n' "$@" > "$here/argv"
printf 'CODEX_HOME=%s\nCODEX_API_KEY=%s\nNODE_ENV=%s\nOPENAI_API_KEY=%s\n' "${CODEX_HOME-}" "${CODEX_API_KEY-}" "${NODE_ENV-}" "${OPENAI_API_KEY-unset}" > "$here/env"
while read -r line; do
  printf '%s\n' "$line" >> "$here/received"
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"thread/start"'*) printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      printf '{"id":%s,"result":{"turn":{"id":"turn-%s"}}}\n' "$id" "$id"
      printf '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-%s"}}}\n' "$id"
      printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%s","status":"completed"}}}\n' "$id" ;;
  esac
done
"#;

/// Native Codex in a cloud workspace (#644): started with the workspace's
/// route, configuration and credential in a hook-free home, the variable the
/// grant clears cleared, and the route's model; its thread is then picked up
/// by the terminal engine when the reader opens the terminal view.
fn cloud_launch_fixture() {
    use std::os::unix::fs::PermissionsExt;
    let _home = store::temp_home();
    let root = store::root().unwrap();
    std::env::set_var("CODEX_HOME", root.join("user-codex"));
    std::env::set_var("OPENAI_API_KEY", "inherited");
    std::fs::write(root.join("grant-auth.json"), "{\"workspace\":true}").unwrap();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("codex"), CLOUD_CODEX).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    manager.send("stdio-owner", "tab", "hello".into(), Vec::new()).unwrap();
    let events = || -> Vec<AgentEvent> { store::read_lines(&store::log_path("stdio-owner", "tab").unwrap()).unwrap_or_default() };
    let until = Instant::now() + WAIT;
    while !events().iter().any(|event| matches!(event.payload, Payload::TurnCompleted { .. })) {
        assert!(Instant::now() < until, "no turn: {:?}", events().iter().map(|event| &event.payload).collect::<Vec<_>>());
        std::thread::sleep(Duration::from_millis(20));
    }
    let argv: Vec<String> = std::fs::read_to_string(bin.join("argv")).unwrap().lines().map(str::to_owned).collect();
    assert_eq!(argv, ["-c", "model_provider=\"route\"", "-c", "developer_instructions=\"brief\"", "app-server", "--listen", "stdio://"]);
    let native = root.join("codex-native");
    let env = std::fs::read_to_string(bin.join("env")).unwrap();
    assert_eq!(env.lines().collect::<Vec<_>>(), [format!("CODEX_HOME={}", native.display()).as_str(), "CODEX_API_KEY=grant-secret", "NODE_ENV=test", "OPENAI_API_KEY=unset"]);
    assert_eq!(std::fs::read_link(native.join("auth.json")).unwrap(), root.join("grant-auth.json"), "the workspace's credential");
    let hooks: serde_json::Value = serde_json::from_slice(&std::fs::read(native.join("hooks.json")).unwrap()).unwrap();
    assert_eq!(hooks, json!({"hooks": {}}), "no Raccoon hook runs for an app-server session");
    let received: Vec<serde_json::Value> = std::fs::read_to_string(bin.join("received")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let started = received.iter().find(|frame| frame["method"] == "thread/start").expect("thread/start");
    assert_eq!(started["params"]["model"], "routed-model", "the route's model, not the tab's");
    // Both version probes, the first launch's and the launch's own, ran in
    // the native home: the VM user's own Codex home is left as it was (#705).
    let probes = std::fs::read_to_string(bin.join("probes")).unwrap();
    assert_eq!(probes.lines().collect::<Vec<_>>(), [native.to_str().unwrap(); 2]);
    assert!(!root.join("user-codex").exists(), "Codex made its temporary files in the VM user's home");

    // The terminal view: Codex's own terminal resumes the thread, whose rollout
    // the app server kept in the native home.
    let day = native.join("sessions/2026/11/01");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(day.join("rollout-2026-11-01T00-00-00-thread-1.jsonl"), "{}\n").unwrap();
    std::fs::write(bin.join("codex"), FIRST_LAUNCH_CODEX).unwrap();
    std::fs::write(bin.join("version"), "codex-cli 0.166.0\n").unwrap();
    manager.codex_stdio_to_terminal("stdio-owner", "tab").unwrap();
    manager.ensure_started("stdio-owner", "tab").unwrap();
    assert!(root.join("codex/sessions/2026/11/01/rollout-2026-11-01T00-00-00-thread-1.jsonl").is_file(), "adopted into the terminal engine's home");
    let launches = || std::fs::read_to_string(bin.join("launches")).unwrap_or_default();
    let until = Instant::now() + WAIT;
    while !launches().lines().any(|line| line.starts_with("--no-daemon") && line.contains("resume thread-1")) {
        assert!(Instant::now() < until, "the terminal Codex did not resume the thread: {:?}", launches());
        std::thread::sleep(Duration::from_millis(20));
    }
    manager.stop("stdio-owner", "tab").unwrap();
}

const FIRST_LAUNCH_CODEX: &str = r#"#!/bin/sh
here=$(dirname "$0")
printf '%s\n' "$*" >> "$here/launches"
case "$1" in
  --version) printf '%s\n' "${CODEX_HOME-}" >> "$here/probes"; cat "$here/version"; exit 0 ;;
  --help) printf '%s\n' "Usage: codex [OPTIONS]" "      --no-daemon  Keep this session to itself"; exit 0 ;;
  app-server) exit 0 ;;
esac
exec sleep 10
"#;

/// Native Codex is tried, not required (#644): a tab that has not started its
/// thread runs on the terminal engine when this Codex is older than the app
/// server's minimum, decided when it is first shown or sent to, with no error.
fn first_launch_fixture(case: &str) {
    use std::os::unix::fs::PermissionsExt;
    let _home = store::temp_home();
    let root = store::root().unwrap();
    // The terminal engine's home mirrors the reader's Codex home: a stand-in's.
    std::env::set_var("CODEX_HOME", root.join("user-codex"));
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("codex"), FIRST_LAUNCH_CODEX).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(bin.join("version"), if case == "native-supported-start" { "codex-cli 0.166.0\n" } else { "codex-cli 0.163.0\n" }).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    if case == "native-fallback-send" {
        manager.send("stdio-owner", "tab", "hello".into(), Vec::new()).unwrap();
    } else {
        manager.ensure_started("stdio-owner", "tab").unwrap();
    }
    let launches = || std::fs::read_to_string(bin.join("launches")).unwrap_or_default();
    let transport = index::get("stdio-owner").unwrap().tab("tab").unwrap().transport;
    let rt = manager.runtime("stdio-owner", "tab").unwrap();
    if case == "native-supported-start" {
        assert_eq!(transport, AgentTransport::ExperimentalCodexStdio);
        assert!(matches!(rt.lock().unwrap().engine, Engine::None), "showing the tab starts nothing");
        assert_eq!(launches().lines().collect::<Vec<_>>(), ["--version"]);
        // On a Mac native Codex runs in the reader's own home, and so does its check.
        let probes = std::fs::read_to_string(bin.join("probes")).unwrap();
        assert_eq!(probes.lines().collect::<Vec<_>>(), [root.join("user-codex").to_str().unwrap()]);
        return;
    }
    assert_eq!(transport, AgentTransport::Pty, "{case}: an older Codex runs on the terminal engine");
    assert!(matches!(rt.lock().unwrap().engine, Engine::Cli(_)), "{case}: started as a terminal tab");
    let until = Instant::now() + WAIT;
    while !launches().lines().any(|line| line.starts_with("--no-daemon")) {
        assert!(Instant::now() < until, "{case}: the terminal Codex was not launched: {:?}", launches());
        std::thread::sleep(Duration::from_millis(20));
    }
    let events: Vec<AgentEvent> = store::read_lines(&store::log_path("stdio-owner", "tab").unwrap()).unwrap_or_default();
    assert!(!events.iter().any(|event| matches!(event.payload, Payload::Error { .. })), "{case}: {:?}", events.iter().map(|event| &event.payload).collect::<Vec<_>>());
    manager.stop("stdio-owner", "tab").unwrap();
}

/// Stands in for native Codex whose provider refuses its sign-in for a turn:
/// while a `refuse` file exists, the next turn fails with an `unauthorized`
/// error, as on a revoked login, and the file goes; a `limit` file fails it
/// on a usage limit instead. An `ask` file makes the next turn ask to run a
/// command first, and goes too. While a `hold` file exists, a turn that has
/// started does not end. Each app server it starts is counted in `launches`.
const SIGNED_OUT_CODEX: &str = r#"#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi
echo "$$" >> "$here/launches"
while read -r line; do
  printf '%s\n' "$line" >> "$here/received"
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*) printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      printf '{"id":%s,"result":{"turn":{"id":"turn-%s"}}}\n' "$id" "$id"
      printf '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-%s"}}}\n' "$id"
      if [ -f "$here/ask" ]; then
        rm "$here/ask"
        printf '{"id":"ask-%s","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-%s","itemId":"cmd-%s"}}\n' "$id" "$id" "$id"
      fi
      while [ -f "$here/hold" ]; do sleep 0.02; done
      if [ -f "$here/refuse" ]; then
        rm "$here/refuse"
        printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%s","status":"failed","error":{"message":"unexpected status 401 Unauthorized","codexErrorInfo":"unauthorized"}}}}\n' "$id"
      elif [ -f "$here/limit" ]; then
        rm "$here/limit"
        printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%s","status":"failed","error":{"message":"You have hit your usage limit."}}}}\n' "$id"
      else
        printf '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-%s","itemId":"m%s","delta":"done"}}\n' "$id" "$id"
        printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%s","status":"completed"}}}\n' "$id"
      fi ;;
  esac
done
"#;

/// Stands in for Codex replying in pieces: answers the handshake, then for a
/// `turn/start` plays the frames written to `streamed` and, if there is one,
/// those in `finished`.
const STREAMING_CODEX: &str = r#"#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi
while read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"thread/start"'*) printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      printf '{"id":%s,"result":{"turn":{"id":"turn-1"}}}\n' "$id"
      cat "$here/streamed"
      if [ -f "$here/finished" ]; then cat "$here/finished"; fi ;;
  esac
done
"#;

/// The cloud mailbox over the tabs of `root`, as `terminalx-serve` runs it in
/// a workspace, with a server that leases nothing itself: each command is
/// handed to [`mailbox_send`] instead.
fn cloud_agents(manager: &SessionManager, root: &Path, sink: Arc<dyn crate::sink::EventSink>) -> Arc<crate::cloud_agents::CloudAgents> {
    use crate::cloud_agents::api::{Ack, AckOutcome, CallError, Checkpoint, Leased, MailboxApi, PutOutcome};
    struct Server;
    impl MailboxApi for Server {
        fn lease(&self, _: &str, _: u32) -> Result<Leased, CallError> { Ok(Leased::default()) }
        fn ack(&self, _: &str, _: &str, _: &Ack) -> Result<AckOutcome, CallError> { Ok(AckOutcome::Settled) }
        fn put_checkpoint(&self, _: &str, _: &Checkpoint) -> Result<PutOutcome, CallError> { Ok(PutOutcome::Stored) }
        fn delete_checkpoint(&self, _: &str) -> Result<(), CallError> { Ok(()) }
    }
    let ops = crate::cloud_agents::ManagerOps { manager: manager.clone(), root: root.to_string_lossy().into_owned() };
    let identity = crate::cloud_agents::Identity { organization_id: "org".into(), workspace_id: "ws".into() };
    crate::cloud_agents::CloudAgents::open(&root.join("cloud-agent"), Arc::new(ops), Some(sink), Some((Arc::new(Server), identity)), 1).unwrap()
}

/// A message sent to the tab from the CLI, a phone or another member, applied
/// as the mailbox applies a leased one: its outcome and its receipt's body.
fn mailbox_send(agents: &crate::cloud_agents::CloudAgents, id: &str, text: &str) -> (String, serde_json::Value) {
    use crate::cloud_agents::{api, crypto};
    let (key_id, key) = agents.keys.current().unwrap();
    let aad = crypto::command_aad("org", "ws", "tab", id, "send", &key_id);
    let (iv, ciphertext) = crypto::seal(&key, json!({ "v": 1, "text": text }).to_string().as_bytes(), &aad).unwrap();
    let lease = api::Lease {
        command_id: format!("command-{id}"), client_command_id: id.into(), tab_id: "tab".into(), kind: "send".into(), sequence: 1,
        key_id: key_id.clone(), iv, ciphertext, actor: api::Actor { user_id: "member".into(), authority: "manage".into(), role: None, can_approve: None },
        created_at: crate::cloud_agents::now_ms(), redelivery: false, lease_token: format!("token-{id}"), runtime_generation: 1,
    };
    let receipt = crate::cloud_agents::mailbox::handle(agents, &lease);
    let aad = crypto::receipt_aad("org", "ws", id, &receipt.outcome, &key_id);
    let body = crypto::open(&key, receipt.result_iv.as_deref().unwrap(), receipt.result_ciphertext.as_deref().unwrap(), &aad).unwrap();
    (receipt.outcome, serde_json::from_slice(&body).unwrap())
}

/// A message from the cloud mailbox to a tab whose turn failed (#644). A
/// native tab waits on that failure, which no turn end will lift: what was
/// queued behind the failed turn goes once it has ended, and a message sent
/// to the waiting tab goes straight in, as the desktop's own does. A refused
/// sign-in also lets go of the app server, which would never read a new one:
/// the next message starts another on the same thread. A terminal tab's
/// waiting can be the CLI's own prompt on screen, so a message still waits.
fn mailbox_fixture(case: &str) {
    use std::os::unix::fs::PermissionsExt;
    let _home = store::temp_home();
    let root = store::root().unwrap();
    std::env::set_var("CODEX_HOME", root.join("user-codex"));
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let native = case == "mailbox-after-refusal";
    std::fs::write(bin.join("codex"), if native { SIGNED_OUT_CODEX } else { FIRST_LAUNCH_CODEX }).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(bin.join("version"), "codex-cli 0.166.0\n").unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let transport = if native { "experimentalCodexStdio" } else { "pty" };
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":transport, "permissionMode":"auto", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let sink: Arc<dyn crate::sink::EventSink> = Arc::new(crate::sink::BroadcastSink::new(256));
    let manager = SessionManager::new(sink.clone(),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let agents = cloud_agents(&manager, &root, sink);
    let rt = manager.runtime("stdio-owner", "tab").unwrap();
    let queued = || agents.follow_ups.list("tab").into_iter().map(|follow_up| follow_up.text).collect::<Vec<_>>();
    if !native {
        manager.ensure_started("stdio-owner", "tab").unwrap();
        let until = Instant::now() + WAIT;
        while !manager.is_running("stdio-owner", "tab") {
            assert!(Instant::now() < until, "the terminal Codex did not start");
            std::thread::sleep(Duration::from_millis(20));
        }
        // Waiting on a failure with no turn open, as the native tab below is.
        manager.needs_recovery(&mut rt.lock().unwrap(), RecoveryKind::SignedOut, crate::recovery_log::Source::SignIn);
        assert!(matches!(rt.lock().unwrap().engine, Engine::Cli(_)));
        assert!(agents.ops.busy("stdio-owner", "tab"));
        let (outcome, receipt) = mailbox_send(&agents, "c1", "hello");
        assert_eq!((outcome.as_str(), &receipt["queued"]), ("applied", &json!(true)));
        agents.nudge_follow_ups("tab");
        assert_eq!(agents.dispatch_follow_ups(), 0);
        assert_eq!(queued(), ["hello"], "nothing is typed into the CLI's own prompt");
        manager.stop("stdio-owner", "tab").unwrap();
        return;
    }
    agents.start();
    let frames = || -> Vec<serde_json::Value> { std::fs::read_to_string(bin.join("received")).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect() };
    let starts = || frames().iter().filter(|frame| frame["method"] == "turn/start").map(|frame| frame["params"]["input"][0]["text"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let ended = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap().into_iter()
        .filter_map(|event| match event.payload { Payload::TurnCompleted { status, auth_failed, .. } => Some((status, auth_failed)), _ => None }).collect::<Vec<_>>();
    let settled = |turns: usize| {
        let until = Instant::now() + WAIT;
        while ended().len() < turns || rt.lock().unwrap().turn_open {
            assert!(Instant::now() < until, "turn {turns} did not end: sent {:?}, queued {:?}, ended {:?}", starts(), queued(), ended());
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    // Each app server the tab ran, and how each took up the thread.
    let launches = || std::fs::read_to_string(bin.join("launches")).unwrap_or_default().lines().count();
    let threads = || frames().iter().filter(|frame| matches!(frame["method"].as_str(), Some("thread/start" | "thread/resume")))
        .map(|frame| format!("{} {}", frame["method"].as_str().unwrap(), frame["params"]["threadId"].as_str().unwrap_or("-"))).collect::<Vec<_>>();
    const REFUSED: (TurnStatus, bool) = (TurnStatus::Error, true);
    const LIMITED: (TurnStatus, bool) = (TurnStatus::Error, false);
    const ANSWERED: (TurnStatus, bool) = (TurnStatus::Ok, false);

    // A message sent while a turn runs waits for it. That turn's sign-in is
    // refused: its app server, which never reads a new one, is let go, and
    // the message starts another on the same thread.
    std::fs::write(bin.join("hold"), "").unwrap();
    std::fs::write(bin.join("refuse"), "").unwrap();
    assert_eq!(mailbox_send(&agents, "c1", "fix the build").1["queued"], false);
    let (outcome, receipt) = mailbox_send(&agents, "c2", "sent mid-turn");
    assert_eq!((outcome.as_str(), &receipt["queued"]), ("applied", &json!(true)));
    assert_eq!(queued(), ["sent mid-turn"]);
    std::fs::remove_file(bin.join("hold")).unwrap();
    settled(2);
    assert_eq!(ended(), [REFUSED, ANSWERED]);
    assert_eq!(starts(), ["fix the build", "sent mid-turn"]);
    assert!(queued().is_empty());
    assert_eq!(launches(), 2);
    assert_eq!(threads(), ["thread/start -", "thread/resume thread-1"]);

    // Refused again while another tab's send holds admission, so the
    // connection's stop waits at its fence. The tab is busy already, and a
    // message sent now waits for the new connection rather than reaching
    // this one.
    std::fs::write(bin.join("refuse"), "").unwrap();
    std::fs::write(bin.join("hold"), "").unwrap();
    mailbox_send(&agents, "c3", "and the tests");
    let until = Instant::now() + WAIT;
    while starts().len() < 3 {
        assert!(Instant::now() < until, "Codex did not take the turn");
        std::thread::sleep(Duration::from_millis(20));
    }
    let admitted = crate::issue_pipeline::admission::lock();
    std::fs::remove_file(bin.join("hold")).unwrap();
    settled(3);
    let retiring = rt.lock().unwrap();
    assert!(retiring.stdio_retiring.is_some() && !retiring.stopping && matches!(retiring.engine, Engine::CodexStdio(_)), "its stop has not begun");
    drop(retiring);
    assert!(agents.ops.busy("stdio-owner", "tab"), "busy while the refused turn's connection goes");
    let (outcome, receipt) = mailbox_send(&agents, "c4", "sent while it goes");
    assert_eq!((outcome.as_str(), &receipt["queued"]), ("applied", &json!(true)));
    drop(admitted);
    let until = Instant::now() + WAIT;
    while launches() < 3 {
        assert!(Instant::now() < until, "no new connection after the refused turn's: queued {:?}", queued());
        std::thread::sleep(Duration::from_millis(20));
    }
    settled(4);
    assert_eq!(ended(), [REFUSED, ANSWERED, REFUSED, ANSWERED]);
    assert_eq!(starts(), ["fix the build", "sent mid-turn", "and the tests", "sent while it goes"]);
    assert!(queued().is_empty());

    // Refused once more: the connection goes, and the tab shows the refusal
    // until a message, after a new sign-in, starts Codex again and lifts it.
    std::fs::write(bin.join("refuse"), "").unwrap();
    mailbox_send(&agents, "c5", "and the docs");
    settled(5);
    let until = Instant::now() + WAIT;
    while !matches!(rt.lock().unwrap().engine, Engine::None) {
        assert!(Instant::now() < until, "the refused turn's connection was not let go");
        std::thread::sleep(Duration::from_millis(20));
    }
    let retired = rt.lock().unwrap();
    assert_eq!((retired.status, retired.recovery, retired.child.is_none()), (TabStatus::Waiting, Some(RecoveryKind::SignedOut), true));
    drop(retired);
    assert!(!agents.ops.busy("stdio-owner", "tab"));
    let (outcome, receipt) = mailbox_send(&agents, "c6", "signed in again");
    assert_eq!((outcome.as_str(), &receipt["queued"]), ("applied", &json!(false)));
    assert!(queued().is_empty());
    settled(6);
    assert_eq!(ended(), [REFUSED, ANSWERED, REFUSED, ANSWERED, REFUSED, ANSWERED]);
    assert_eq!(starts(), ["fix the build", "sent mid-turn", "and the tests", "sent while it goes", "and the docs", "signed in again"], "nothing replayed");
    assert_eq!(launches(), 4);
    assert_eq!(threads(), ["thread/start -", "thread/resume thread-1", "thread/resume thread-1", "thread/resume thread-1"]);
    let after = rt.lock().unwrap();
    assert_eq!((after.status, after.recovery), (TabStatus::Completed, None));
    drop(after);

    // A turn that fails some other way while it waits on an ask leaves the
    // tab waiting, as it was, and keeps its connection: what was queued
    // behind it goes all the same, on that connection.
    std::fs::write(bin.join("ask"), "").unwrap();
    std::fs::write(bin.join("hold"), "").unwrap();
    std::fs::write(bin.join("limit"), "").unwrap();
    mailbox_send(&agents, "c7", "run the migration");
    let until = Instant::now() + WAIT;
    while rt.lock().unwrap().pending.is_empty() {
        assert!(Instant::now() < until, "Codex did not ask");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(mailbox_send(&agents, "c8", "then deploy").1["queued"], true);
    assert_eq!(agents.dispatch_follow_ups(), 0, "not while the turn waits on its ask");
    assert_eq!(rt.lock().unwrap().status, TabStatus::Waiting);
    std::fs::remove_file(bin.join("hold")).unwrap();
    settled(8);
    assert_eq!(ended()[6..], [LIMITED, ANSWERED]);
    assert_eq!(starts()[6..], ["run the migration", "then deploy"]);
    assert!(queued().is_empty());
    assert_eq!(launches(), 4);
    manager.stop("stdio-owner", "tab").unwrap();
}

/// #644: Codex streams a reply in many pieces, each shown live as a preview.
/// The chat records the reply once, whole, at the time its first piece came:
/// when its item completes, or when its turn ends without that (here, Stop).
fn streamed_fixture(case: &str) {
    use std::os::unix::fs::PermissionsExt;
    const PIECES: [&str; 6] = ["One ", "reply, ", "streamed ", "in ", "many ", "pieces."];
    const THOUGHT: &str = "Reading the brief.\n\nWriting the reply.";
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("codex"), STREAMING_CODEX).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    // Shaped as Codex 0.166.0's app-server schema has them.
    let frame = |method: &str, mut params: serde_json::Value| {
        params["threadId"] = json!("thread-1");
        params["turnId"] = json!("turn-1");
        format!("{}\n", json!({"method": method, "params": params}))
    };
    let mut streamed = format!("{}\n", json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}));
    for (part, delta) in [(0, "Reading "), (0, "the brief."), (1, "Writing "), (1, "the reply.")] {
        streamed += &frame("item/reasoning/summaryTextDelta", json!({"itemId":"rs_1","summaryIndex":part,"delta":delta}));
    }
    streamed += &frame("item/completed", json!({"completedAtMs":0,"item":{"type":"reasoning","id":"rs_1","summary":["Reading the brief.","Writing the reply."],"content":[]}}));
    streamed += &frame("item/started", json!({"startedAtMs":0,"item":{"type":"agentMessage","id":"msg_2","text":""}}));
    for delta in PIECES {
        streamed += &frame("item/agentMessage/delta", json!({"itemId":"msg_2","delta":delta}));
    }
    std::fs::write(bin.join("streamed"), streamed).unwrap();
    if case == "streamed-reply" {
        let finished = frame("item/completed", json!({"completedAtMs":0,"item":{"type":"agentMessage","id":"msg_2","text":PIECES.concat()}}))
            + &format!("{}\n", json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}));
        std::fs::write(bin.join("finished"), finished).unwrap();
    }
    assert!(crate::binpath::set_priority_dir(&bin));
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let sink = Arc::new(crate::sink::BroadcastSink::new(1024));
    let mut heard = sink.subscribe();
    let manager = SessionManager::new(sink.clone(),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    manager.send("stdio-owner", "tab", "hello".into(), Vec::new()).unwrap();

    // Shown live: every piece, as a preview of its block.
    let mut live: Vec<AgentEvent> = Vec::new();
    let pieces = |live: &[AgentEvent], thinking: bool| live.iter().filter_map(|event| match &event.payload {
        Payload::Delta(Delta::TextDelta { block, text }) if !thinking => Some((block.message_id.clone(), text.clone())),
        Payload::Delta(Delta::ThinkingDelta { block, text }) if thinking => Some((block.message_id.clone(), text.clone())),
        _ => None,
    }).collect::<Vec<_>>();
    let until = Instant::now() + WAIT;
    while pieces(&live, false).len() < PIECES.len() {
        assert!(Instant::now() < until, "{case}: not every piece was shown: {:?}", live.iter().map(|event| &event.payload).collect::<Vec<_>>());
        match heard.try_recv() {
            Ok(published) if &*published.event == "agent_event" => live.push(serde_json::from_str(&published.payload).unwrap()),
            Ok(_) => {}
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    assert_eq!(pieces(&live, false), PIECES.map(|piece| ("msg_2".to_owned(), piece.to_owned())));
    assert_eq!(pieces(&live, true).iter().map(|(block, text)| { assert_eq!(block, "rs_1"); text.as_str() }).collect::<String>(), THOUGHT);
    if case == "streamed-stopped" { manager.stop("stdio-owner", "tab").unwrap(); }

    // Recorded: each item once, whole, ahead of the turn's end.
    let events = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap();
    let until = Instant::now() + WAIT;
    while !events().iter().any(|event| matches!(event.payload, Payload::TurnCompleted { .. })) {
        assert!(Instant::now() < until, "{case}: the turn never ended: {:?}", events().iter().map(|event| &event.payload).collect::<Vec<_>>());
        std::thread::sleep(Duration::from_millis(20));
    }
    let events = events();
    assert!(!events.iter().any(|event| matches!(event.payload, Payload::Delta(_))), "{case}: previews are never written to the log");
    let chat: Vec<_> = events.iter().filter_map(|event| match &event.payload {
        Payload::UserMessage { text, .. } => Some(format!("user: {text}")),
        Payload::Reasoning { block: Some(block), text } => Some(format!("thinking {}: {text}", block.message_id)),
        Payload::AssistantText { block: Some(block), text } => Some(format!("reply {}: {text}", block.message_id)),
        Payload::TurnCompleted { status, .. } => Some(format!("end: {status:?}")),
        _ => None,
    }).collect();
    let end = if case == "streamed-reply" { TurnStatus::Ok } else { TurnStatus::Aborted };
    assert_eq!(chat, ["user: hello".to_owned(), format!("thinking rs_1: {THOUGHT}"), format!("reply msg_2: {}", PIECES.concat()), format!("end: {end:?}")], "{case}");
    let first_piece = live.iter().find(|event| matches!(event.payload, Payload::Delta(Delta::TextDelta { .. }))).unwrap();
    let reply = events.iter().find(|event| matches!(event.payload, Payload::AssistantText { .. })).unwrap();
    assert!(reply.message_ts.is_some());
    assert_eq!(reply.message_ts, first_piece.message_ts, "{case}: the reply is dated by its first piece");
    if case == "streamed-reply" { manager.stop("stdio-owner", "tab").unwrap(); }
}

/// Stands in for Codex through turns that run until the test lets them on:
/// each `turn/start` starts its turn, then waits while `hold-progress` is
/// there before it runs a command, and while `hold-finish` is there before
/// it answers and completes. `turn/interrupt` ends the turn it names as
/// interrupted once `hold-interrupt` is gone. Turns are named by their
/// request's id, so a late frame of an interrupted turn is never another's.
const WORKING_CODEX: &str = r#"#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi
held() { while [ -f "$here/$1" ]; do [ -f "$here/cancel-$2" ] && exit 0; sleep 0.02; done; }
while read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"thread/start"'*) printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      printf '{"id":%s,"result":{"turn":{"id":"turn-%s"}}}\n' "$id" "$id"
      printf '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-%s"}}}\n' "$id"
      ( held hold-progress "turn-$id"
        printf '{"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-%s","item":{"type":"commandExecution","id":"c%s"}}}\n' "$id" "$id"
        printf '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-%s","item":{"type":"commandExecution","id":"c%s","status":"completed","exitCode":0,"aggregatedOutput":""}}}\n' "$id" "$id"
        held hold-finish "turn-$id"
        printf '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-%s","item":{"type":"agentMessage","id":"m%s","text":"done"}}}\n' "$id" "$id"
        printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%s","status":"completed"}}}\n' "$id" ) & ;;
    *'"method":"turn/interrupt"'*)
      turn=$(printf '%s' "$line" | sed -n 's/.*"turnId":"\([^"]*\)".*/\1/p')
      touch "$here/cancel-$turn"
      printf '{"id":%s,"result":{}}\n' "$id"
      held hold-interrupt none
      printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"%s","status":"interrupted"}}}\n' "$turn" ;;
  esac
done
"#;

/// #815: native Codex at work for longer than the watcher's stall limit is
/// not stalled, and a message sent while it works (or right after an
/// interrupt, before Codex has ended the turn) is refused as a request: no
/// error, no warning, no Needs attention, and the running turn goes on. The
/// watcher still calls real silence, and progress takes that warning back.
/// What happened is in the incident log, with no message text in it.
fn busy_fixture() {
    use std::os::unix::fs::PermissionsExt;
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("codex"), WORKING_CODEX).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let hold = |name: &str| std::fs::write(bin.join(name), "").unwrap();
    let release = |name: &str| std::fs::remove_file(bin.join(name)).unwrap();
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "model":"gpt-6-astra", "effort":"xhigh", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(1024)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let rt_arc = manager.runtime("stdio-owner", "tab").unwrap();
    let events = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap();
    let wait = |what: &str, done: &dyn Fn(&[AgentEvent]) -> bool| {
        let until = Instant::now() + WAIT;
        while !done(&events()) {
            assert!(Instant::now() < until, "{what}: {:?}", events().iter().map(|event| &event.payload).collect::<Vec<_>>());
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let count = |events: &[AgentEvent], test: &dyn Fn(&Payload) -> bool| events.iter().filter(|event| test(&event.payload)).count();
    let warned = |events: &[AgentEvent]| count(events, &|payload| matches!(payload, Payload::Error { .. } | Payload::Recovery { kind: Some(_) }));
    let busy = |what: &str| {
        let before = warned(&events());
        let error = manager.send("stdio-owner", "tab", format!("again: {what}"), Vec::new()).expect_err(what);
        assert!(error.to_string().starts_with(BUSY_WORDS), "{what}: {error:#}");
        let rt = rt_arc.lock().unwrap();
        assert!(rt.turn_open && rt.status == TabStatus::InProgress && rt.recovery.is_none(), "{what}: the running turn is left as it was");
        drop(rt);
        assert_eq!(warned(&events()), before, "{what}: a refused send raises nothing in the tab");
        assert!(!events().iter().any(|event| matches!(&event.payload, Payload::UserMessage { text, .. } if text.starts_with("again:"))), "{what}: and is not published");
    };
    let patience = recovery::Patience { stall: Duration::from_millis(250), settle: Duration::from_secs(10) };

    hold("hold-progress");
    hold("hold-finish");
    manager.send("stdio-owner", "tab", "first".into(), Vec::new()).unwrap();
    wait("the first turn starts", &|events| count(events, &|payload| matches!(payload, Payload::TurnStarted { .. })) == 1);
    let opened = rt_arc.lock().unwrap().turn_started_at.unwrap();
    std::thread::sleep(Duration::from_millis(300));
    release("hold-progress");
    wait("the command runs", &|events| count(events, &|payload| matches!(payload, Payload::ToolCallCompleted { .. })) == 1);
    let heard = rt_arc.lock().unwrap().last_activity;
    assert!(heard >= opened + Duration::from_millis(300), "Codex's frames are activity, not only the send");
    // Longer than the stall limit since the send, not since Codex was last heard.
    manager.watch_tabs(patience, heard + Duration::from_millis(200), |_| None);
    assert!(rt_arc.lock().unwrap().recovery.is_none(), "a turn at work is not stalled");
    busy("while the turn works");
    busy("again, a moment later");

    // Real silence is still called, and the agent's progress takes it back.
    manager.watch_tabs(patience, heard + Duration::from_millis(300), |_| None);
    assert_eq!(rt_arc.lock().unwrap().recovery, Some(RecoveryKind::Timeout));
    release("hold-finish");
    wait("the first turn ends", &|events| count(events, &|payload| matches!(payload, Payload::TurnCompleted { status: TurnStatus::Ok, .. })) == 1);
    assert!(rt_arc.lock().unwrap().recovery.is_none(), "the reply took the guess back");

    // Right after an interrupt Codex has not ended the turn yet: still busy.
    hold("hold-progress");
    hold("hold-finish");
    hold("hold-interrupt");
    manager.send("stdio-owner", "tab", "second".into(), Vec::new()).unwrap();
    wait("the second turn starts", &|events| count(events, &|payload| matches!(payload, Payload::TurnStarted { .. })) == 2);
    assert!(manager.interrupt("stdio-owner", "tab").unwrap());
    busy("right after an interrupt");
    release("hold-interrupt");
    wait("the interrupt ends the turn", &|events| count(events, &|payload| matches!(payload, Payload::TurnCompleted { status: TurnStatus::Aborted, .. })) == 1);
    // The message the sender kept goes now, as a turn of its own.
    release("hold-progress");
    release("hold-finish");
    manager.send("stdio-owner", "tab", "third".into(), Vec::new()).unwrap();
    wait("the third turn ends", &|events| count(events, &|payload| matches!(payload, Payload::TurnCompleted { status: TurnStatus::Ok, .. })) == 2);
    assert_eq!(count(&events(), &|payload| matches!(payload, Payload::Error { .. })), 0, "no error row at any point");
    manager.stop("stdio-owner", "tab").unwrap();

    let lines = crate::recovery_log::read_all().unwrap();
    let text = serde_json::to_string(&lines).unwrap();
    for typed in ["first", "second", "third", "again:"] { assert!(!text.contains(&format!("\"{typed}")), "no message text is recorded: {typed}"); }
    let sends: Vec<_> = lines.iter().filter(|line| line["kind"] == "send_attempt").map(|line| (line["admission"].as_str().unwrap(), line["found"]["turn_open"].as_bool().unwrap())).collect();
    assert_eq!(sends, [("admitted", false), ("busy", true), ("busy", true), ("admitted", false), ("busy", true), ("admitted", false)]);
    assert!(lines.iter().filter(|line| line["kind"] == "send_attempt").all(|line| line["turn_failed"] == false && line["origin"] == "programmatic"));
    let raised: Vec<_> = lines.iter().filter(|line| line["kind"] == "recovery_raised").collect();
    assert_eq!(raised.len(), 1, "one warning, the watcher's: {raised:?}");
    assert_eq!((raised[0]["reason"].as_str(), raised[0]["source"].as_str()), (Some("timeout"), Some("watcher")));
    assert_eq!(raised[0]["agent"], json!({"harness":"codex","transport":"codex_stdio","model":"gpt-6-astra","effort":"xhigh"}));
    assert_eq!(raised[0]["last_progress"]["kind"], "tool_completed");
    let cleared: Vec<_> = lines.iter().filter(|line| line["kind"] == "recovery_cleared").collect();
    assert_eq!((cleared.len(), cleared[0]["incident"].clone(), cleared[0]["cause"].as_str()), (1, raised[0]["incident"].clone(), Some("progress")));
    let ended: Vec<_> = lines.iter().filter(|line| line["kind"] == "turn_ended").map(|line| line["status"].as_str().unwrap()).collect();
    assert_eq!(ended, ["ok", "aborted", "ok"]);
    let summary = crate::recovery_log::summarize(&lines);
    assert_eq!(summary["busy_refusals_while_turn_open"], 3);
    assert_eq!(summary["groups"][0]["outcomes"], json!({"cleared_without_action:progress": 1}));
    assert_eq!(summary["groups"][0]["visible"]["incidents_shown"], 0, "nothing a window did not report is called seen");
}

/// What a busy refusal says, which the window recognises it by.
const BUSY_WORDS: &str = "Codex is still working on this turn, so this message was not sent.";

#[test]
fn a_busy_refusal_says_the_words_the_window_knows_it_by() {
    assert!(Busy.to_string().starts_with(BUSY_WORDS));
    // The window's BUSY_REFUSAL, which `isBusyRefusal` matches.
    let window = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/portable/src/recovery.ts")).unwrap();
    assert!(window.contains(&format!("\"{BUSY_WORDS}\"")), "the window's copy of the words drifted");
}

#[test]
fn child_fixture() {
    let Ok(case) = std::env::var(CASE) else { return };
    if matches!(case.as_str(), "resume-thread" | "resume-other-thread" | "settings" | "to-terminal") { return resume_fixture(&case); }
    if case.starts_with("native3-") { return remote_input_fixture(&case); }
    if matches!(case.as_str(), "phone-input" | "phone-compact" | "phone-revoked" | "phone-reconcile-race" | "share-input" | "share-ended" | "host-while-shared") { return remote_input_fixture(&case); }
    if matches!(case.as_str(), "continuation-delivered" | "continuation-undelivered" | "continuation-stopped" | "resend-after-restart") { return continuation_fixture(&case); }
    if matches!(case.as_str(), "native-fallback-send" | "native-fallback-start" | "native-supported-start") { return first_launch_fixture(&case); }
    if case == "cloud-launch" { return cloud_launch_fixture(); }
    if matches!(case.as_str(), "mailbox-after-refusal" | "mailbox-cli-waiting") { return mailbox_fixture(&case); }
    if matches!(case.as_str(), "streamed-reply" | "streamed-stopped") { return streamed_fixture(&case); }
    if case == "busy-while-working" { return busy_fixture(); }
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
        manager.write_codex_frame(&Arc::downgrade(&rt_arc), &launch, frame, None, None).unwrap();
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
    let child = manager.host.spawn(&rt.key(), SpawnSpec { program: Path::new("/bin/sh"), args: &args, cwd: &root, env: &[], unset: &[] }, sink).unwrap();
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
            finished.send(writer_manager.write_codex_frame(&runtime, &launch, frame, None, None)).unwrap();
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

static APPROVAL_QUEUED: Mutex<Option<Box<dyn FnOnce() + Send>>> = Mutex::new(None);
pub(super) fn before_approval(frame: &Outbound) {
    if frame.approval().is_some() {
        let hook = APPROVAL_QUEUED.lock().unwrap().take();
        if let Some(hook) = hook { hook(); }
    }
}

#[test]
fn privacy_native3_codex_handshake_and_approval_delivery() {
    for action in ["handshake", "approval"] {
        for kind in ["personal-on", "personal-cycle", "managed-on", "managed-cycle"] {
            let case = format!("native3-{action}-{kind}");
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "session::codex_stdio::tests::child_fixture", "--nocapture"])
                .env(CASE, &case).output().unwrap();
            assert!(out.status.success(), "{case}\n{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        }
    }
}

fn native3_fixture(case: &str, manager: &SessionManager, root: &Path, bin: &Path) {
    if case == "native3-resolved" { return native3_resolved_fixture(manager, bin); }
    use crate::remote::{protocol::{Authority as RemoteAuthority, PROTOCOL}, server::{Peer, WorkspaceRpc}};
    let policy = |enabled| {
        let managed = case.contains("managed");
        if enabled && managed { std::env::set_var("TERMINALX_TEST_MANAGED_PRIVACY", "1"); }
        else { std::env::remove_var("TERMINALX_TEST_MANAGED_PRIVACY"); }
        store::write_json(&root.join("data-privacy.json"), &json!({"enabled":enabled && !managed})).unwrap();
        assert_eq!(crate::data_privacy::refresh().enabled, enabled);
    };
    let wait = |why: &str, done: &dyn Fn() -> bool| {
        let until = Instant::now() + Duration::from_secs(8);
        while !done() { assert!(Instant::now() < until, "{why}"); std::thread::sleep(Duration::from_millis(5)); }
    };
    policy(false);
    struct Owner(SessionManager);
    impl Drop for Owner { fn drop(&mut self) { let _ = self.0.stop("stdio-owner", "tab"); } }
    let _owner = Owner(manager.clone());
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(2).enable_all().build().unwrap();
    let rpc = WorkspaceRpc::new(root, 1, manager.sink.clone(), manager.terminals.clone(), Some(manager.clone())).unwrap();
    let (peer, _events) = Peer::new("native3-relay".into(), RemoteAuthority::Manage);
    assert_eq!(runtime.block_on(rpc.handle(&peer, &json!({"id":"hello","method":"rpc.hello","params":{"protocol":PROTOCOL,"want":["session/1"]}})))["ok"], true);
    let send = |text: &str| runtime.block_on(rpc.handle(&peer, &json!({"id":"send","method":"session.send","params":{
        "sessionId":"stdio-owner","tabId":"tab","text":text,"clientRequestId":uuid::Uuid::new_v4().to_string()}})));
    let frames = || std::fs::read_to_string(bin.join("received")).unwrap_or_default().lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).collect::<Vec<_>>();
    let rt = manager.runtime("stdio-owner", "tab").unwrap();
    let events = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap();
    if case.contains("handshake") {
        std::fs::write(bin.join("hold"), "").unwrap();
        let result = send("expired relay prompt");
        assert_eq!(result["ok"], true, "{result}");
        wait("physical delayed thread request", &|| frames().iter().any(|f| f["method"] == "thread/resume"));
        policy(true); if case.ends_with("cycle") { policy(false); }
        std::fs::remove_file(bin.join("hold")).unwrap();
        wait("withdrawn remote turn", &|| !rt.lock().unwrap().turn_open);
        assert_eq!(frames().len(), 3, "revoked startup prompt reached Codex");
        assert!(events().iter().any(|e| matches!(e.payload, Payload::TurnCompleted { status: TurnStatus::Aborted, .. })));
        manager.send("stdio-owner", "tab", "valid local".into(), vec![]).unwrap();
        wait("local turn delivered", &|| frames().len() == 4 && !rt.lock().unwrap().turn_open);
        assert_eq!(frames()[3]["params"]["input"][0]["text"], "valid local");
        policy(false); assert_eq!(send("fresh relay")["ok"], true);
        wait("fresh relay delivered", &|| frames().len() == 5 && !rt.lock().unwrap().turn_open);
        assert_eq!(frames()[4]["params"]["input"][0]["text"], "fresh relay");
    } else {
        // A real stdio provider waits for the JSON-RPC approval reply. It does
        // not fabricate a completion while the approval remains unanswered.
        let script = RESUMING_CODEX.replace("      printf '{\"method\":\"item/agentMessage/delta\"", "      printf '{\"id\":\"approval\",\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"threadId\":\"thread-1\",\"turnId\":\"turn-%s\",\"itemId\":\"tool\",\"command\":\"echo approved\"}}\\n' \"$id\"\n      continue\n      printf '{\"method\":\"item/agentMessage/delta\"");
        assert_ne!(script, RESUMING_CODEX);
        std::fs::write(bin.join("codex"), script).unwrap();
        manager.send("stdio-owner", "tab", "local task".into(), vec![]).unwrap();
        wait("provider approval request", &|| !rt.lock().unwrap().pending.is_empty());
        let request = rt.lock().unwrap().pending.keys().next().unwrap().clone();
        let (entered, arrived) = mpsc::channel(); let (release, released) = mpsc::channel();
        *APPROVAL_QUEUED.lock().unwrap() = Some(Box::new(move || { entered.send(()).unwrap(); released.recv_timeout(Duration::from_secs(8)).unwrap(); }));
        // Same remote admission used by relay permission RPC; the physical
        // writer is a different thread and must retain this original ticket.
        { let ticket = crate::data_privacy::Ticket::default(); let _scope = ticket.scope().unwrap();
          manager.respond_permission("stdio-owner", "tab", &request, "allow").unwrap(); }
        arrived.recv_timeout(WAIT).unwrap();
        assert!(manager.respond_permission("stdio-owner", "tab", &request, "deny").unwrap_err().to_string().contains("still being delivered"));
        assert!(rt.lock().unwrap().pending.contains_key(&request));
        assert!(!events().iter().any(|e| matches!(e.payload, Payload::PermissionDecided { .. })));
        policy(true); if case.ends_with("cycle") { policy(false); }
        release.send(()).unwrap();
        // A writer fence proves the rejected answer was processed, without
        // inventing a provider response or sleeping to guess queue progress.
        let (tx, rx) = mpsc::channel();
        *APPROVAL_QUEUED.lock().unwrap() = Some(Box::new(move || { tx.send(()).unwrap(); }));
        wait("approval restored", &|| {
            manager.respond_permission("stdio-owner", "tab", &request, "deny").is_ok()
        });
        rx.recv_timeout(WAIT).unwrap();
        wait("local answer physically delivered", &|| frames().iter().any(|f| f["id"] == "approval" && f["result"]["decision"] == "decline"));
        assert!(frames().iter().all(|f| f["result"]["decision"] != "accept"));
        wait("delivered approval settled", &|| rt.lock().unwrap().pending.is_empty());
        assert_eq!(events().iter().filter(|e| matches!(e.payload, Payload::PermissionDecided { allowed: false, automatic: false, .. })).count(), 1);
    }
}

#[test]
fn privacy_native3_codex_provider_resolution_retires_queued_answer_once() {
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "session::codex_stdio::tests::child_fixture", "--nocapture"])
        .env(CASE, "native3-resolved").output().unwrap();
    assert!(out.status.success(), "{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
}

fn native3_resolved_fixture(manager: &SessionManager, bin: &Path) {
    struct Owner(SessionManager);
    impl Drop for Owner { fn drop(&mut self) { let _ = self.0.stop("stdio-owner", "tab"); } }
    let _owner = Owner(manager.clone());
    let wait = |why: &str, done: &dyn Fn() -> bool| {
        let until = Instant::now() + Duration::from_secs(8);
        while !done() { assert!(Instant::now() < until, "{why}"); std::thread::sleep(Duration::from_millis(5)); }
    };
    // Only the provider emits resolution, over its real stdout while the
    // approval writer is paused. The second request stays live throughout.
    let first_turn = r#"      if [ ! -f "$here/resolve" ]; then
        turn_id="$id"
        for request in approval unrelated; do
          printf '{"id":"%s","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-%s","itemId":"%s","command":"echo approval"}}\n' "$request" "$id" "$request"
        done
        while [ ! -f "$here/resolve" ]; do sleep 0.005; done
        for duplicate in 1 2; do
          printf '{"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":"approval"}}\n'
        done
        continue
      fi
"#;
    let needle = "      printf '{\"method\":\"item/agentMessage/delta\"";
    let script = RESUMING_CODEX.replace(needle, &format!("{first_turn}{needle}"))
        .replace("  case \"$line\" in\n", r#"  case "$line" in
    *'"id":"unrelated"'*)
      printf '{"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":"unrelated"}}\n'
      printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%s","status":"completed"}}}\n' "$turn_id" ;;
"#);
    assert!(script.contains(first_turn));
    std::fs::write(bin.join("codex"), script).unwrap();
    let rt = manager.runtime("stdio-owner", "tab").unwrap();
    let events = || store::read_lines::<AgentEvent>(&store::log_path("stdio-owner", "tab").unwrap()).unwrap();
    let frames = || std::fs::read_to_string(bin.join("received")).unwrap_or_default().lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).collect::<Vec<_>>();
    let request = "\"approval\"";
    let other = "\"unrelated\"";
    manager.send("stdio-owner", "tab", "initial task".into(), vec![]).unwrap();
    wait("both live provider requests", &|| rt.lock().unwrap().pending.len() == 2);
    let (entered, arrived) = mpsc::channel(); let (release, released) = mpsc::channel();
    *APPROVAL_QUEUED.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap(); released.recv_timeout(Duration::from_secs(8)).unwrap();
    }));
    manager.respond_permission("stdio-owner", "tab", request, "allow").unwrap();
    arrived.recv_timeout(WAIT).unwrap();
    assert_eq!(rt.lock().unwrap().pending.len(), 2);
    std::fs::write(bin.join("resolve"), "").unwrap();
    wait("provider resolution retires queued card before writer resumes", &|| !rt.lock().unwrap().pending.contains_key(request));
    assert!(rt.lock().unwrap().pending.contains_key(other));
    assert!(manager.respond_permission("stdio-owner", "tab", request, "allow").is_err());
    release.send(()).unwrap();
    // This reply fences the discarded frame through the same FIFO writer.
    manager.respond_permission("stdio-owner", "tab", other, "deny").unwrap();
    wait("unrelated reply delivered and turn completed", &|| !rt.lock().unwrap().turn_open);
    let received = frames();
    assert!(!received.iter().any(|frame| frame["id"] == "approval"), "resolved consent reached provider: {received:?}");
    assert_eq!(received.iter().filter(|frame| frame["id"] == "unrelated" && frame["result"]["decision"] == "decline").count(), 1);
    let decisions: Vec<_> = events().into_iter().filter(|e| matches!(e.payload, Payload::PermissionDecided { .. })).collect();
    assert_eq!(decisions.len(), 2, "each request must settle exactly once: {decisions:?}");
    assert!(matches!(&decisions[0].payload, Payload::PermissionDecided { request_id, allowed: false, automatic: true, label, .. } if request_id == request && label == "Lapsed"));
    assert!(matches!(&decisions[1].payload, Payload::PermissionDecided { request_id, allowed: false, automatic: false, .. } if request_id == other));
    manager.send("stdio-owner", "tab", "fresh task".into(), vec![]).unwrap();
    wait("fresh turn remains usable", &|| frames().iter().any(|f| f["params"]["input"][0]["text"] == "fresh task") && !rt.lock().unwrap().turn_open);
    assert!(rt.lock().unwrap().pending.is_empty());
    assert_eq!(events().iter().filter(|e| matches!(e.payload, Payload::PermissionDecided { .. })).count(), 2);
}
