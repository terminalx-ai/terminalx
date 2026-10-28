//! Source-derived boundary drafts, not captured provider output. Wire field
//! names come from rust-v0.164.0 v2 schemas; callback schedules are Host policy.
//! Invoke the real Sink implementation directly; no child/provider is started.

use super::*;
use serde_json::json;

#[derive(Clone, Default)]
struct Recorder {
    events: Arc<Mutex<Vec<Envelope>>>,
    reject: Arc<Mutex<bool>>,
}

impl Admission for Recorder {
    fn accept(&mut self, envelope: Envelope) -> Result<(), ()> {
        if *self.reject.lock().unwrap() { return Err(()); }
        self.events.lock().unwrap().push(envelope);
        Ok(())
    }
}

fn scope() -> Scope {
    Scope {
        owner: Owner { session_id: "session".into(), tab_id: "tab".into(), subagent_id: None },
        conversation_id: Some("conversation".into()), thread_id: "thread".into(),
    }
}

fn item(method: &str, thread: &str, turn: &str, id: &str) -> String {
    json!({"method": method, "params": {
        "threadId": thread, "turnId": turn, "item": {"type": "contextCompaction", "id": id},
        "startedAtMs": 1, "completedAtMs": 2
    }}).to_string()
}

fn setup() -> (OwnedTransport, Arc<BoundSink>, Recorder) {
    let recorder = Recorder::default();
    let transport = OwnedTransport::new(recorder.clone());
    let sink = transport.bind(scope()).unwrap();
    (transport, sink, recorder)
}

#[test]
fn host_sink_preserves_exact_owner_thread_turn_item_identity() {
    let (_, sink, recorder) = setup();
    let host_sink: Arc<dyn Sink> = sink;
    host_sink.stdout_line(item("item/started", "thread", "turn/a", "item:b"));
    let events = recorder.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].scope, scope());
    assert_eq!(events[1].launch, events[0].launch);
    assert_eq!(events[1].observation, Observation::ItemStarted { turn_id: "turn/a".into(), item_id: "item:b".into() });
}

#[test]
fn old_stdout_completion_and_exit_cannot_enter_replacement() {
    let (transport, old, recorder) = setup();
    let current = transport.bind(scope()).unwrap();
    old.stdout_line(item("item/started", "thread", "old", "i"));
    old.stdout_line(item("item/completed", "thread", "old", "i"));
    old.exited(10, Some(0));
    old.release().unwrap();
    assert_eq!(old.status(), Status::Superseded);
    assert_eq!(current.status(), Status::Open);
    current.stdout_line(item("item/completed", "thread", "new", "i"));
    let events = recorder.events.lock().unwrap();
    assert_eq!(events.len(), 3);
    assert!(events[1].launch > events[0].launch);
    assert_eq!(events[2].launch, events[1].launch);
}

#[test]
fn exit_before_stdout_blocks_start_but_retains_buffered_completion_without_start() {
    let (_, sink, recorder) = setup();
    sink.exited(10, Some(0));
    sink.stdout_line(item("item/started", "thread", "t", "i"));
    sink.exited(10, Some(0));
    sink.stdout_line(item("item/completed", "thread", "t", "i"));
    assert_eq!(sink.status(), Status::Exited);
    let events = recorder.events.lock().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[1].observation, Observation::Exited { pid: 10, code: Some(0) });
    assert!(matches!(events[2].observation, Observation::ItemCompleted { .. }));
}

#[test]
fn stdout_before_exit_preserves_admission_order_and_duplicate_evidence() {
    let (_, sink, recorder) = setup();
    for _ in 0..2 { sink.stdout_line(item("item/started", "thread", "t", "i")); }
    sink.stdout_line(item("item/completed", "thread", "t", "i"));
    sink.exited(11, None);
    let events = recorder.events.lock().unwrap();
    assert_eq!(events.len(), 5); // Dedupe belongs to the journal/reducer, not this fence.
    assert_eq!(events[1], events[2]);
    assert!(matches!(events[3].observation, Observation::ItemCompleted { .. }));
    assert!(matches!(events[4].observation, Observation::Exited { code: None, .. }));
}

#[test]
fn thread_is_exclusive_across_tabs_until_explicit_release_even_after_exit() {
    let (transport, sink, _) = setup();
    let mut other = scope();
    other.owner.tab_id = "other".into();
    assert!(transport.bind(other.clone()).is_err());
    sink.exited(10, None);
    assert!(transport.bind(other.clone()).is_err());
    sink.release().unwrap();
    assert!(transport.bind(other).is_ok());
    assert_eq!(sink.status(), Status::Superseded);
}

#[test]
fn subagent_thread_and_conversation_scope_do_not_leak_to_parent() {
    let (transport, parent, recorder) = setup();
    let mut child_scope = scope();
    child_scope.owner.subagent_id = Some("child".into());
    child_scope.thread_id = "child-thread".into();
    let child = transport.bind(child_scope.clone()).unwrap();
    parent.stdout_line(item("item/started", "child-thread", "t", "i"));
    child.stdout_line(item("item/started", "thread", "t", "i"));
    child.stdout_line(item("item/started", "child-thread", "t", "i"));
    let mut replacement_scope = scope();
    replacement_scope.conversation_id = Some("next-conversation".into());
    replacement_scope.thread_id = "next-thread".into();
    let replacement = transport.bind(replacement_scope.clone()).unwrap();
    parent.stdout_line(item("item/completed", "thread", "t", "i"));
    replacement.stdout_line(item("item/started", "thread", "t", "i"));
    let events = recorder.events.lock().unwrap();
    assert_eq!(events.len(), 4);
    assert_eq!(events[2].scope, child_scope);
    assert_eq!(events[3].scope, replacement_scope);
    assert_eq!(events[3].observation, Observation::Bound { replaces: Some((scope(), events[0].launch)) });
}

#[test]
fn scoped_retry_and_turn_interruption_do_not_invent_item_identity() {
    let (_, sink, recorder) = setup();
    sink.stdout_line(json!({"method":"error","params":{"threadId":"thread","turnId":"t","willRetry":true,"error":{"message":"not forwarded"}}}).to_string());
    sink.stdout_line(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"t","status":"interrupted","items":[],"error":null}}}).to_string());
    let events = recorder.events.lock().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[1].observation, Observation::TurnError { turn_id: "t".into(), will_retry: true });
    assert_eq!(events[2].observation, Observation::TurnEnded { turn_id: "t".into(), outcome: TurnOutcome::Interrupted });
}

#[test]
fn exit_suppresses_late_turn_signals_and_stderr_is_not_evidence() {
    let (_, sink, recorder) = setup();
    sink.exited(10, Some(1));
    sink.stdout_line(json!({"method":"error","params":{"threadId":"thread","turnId":"t","willRetry":false}}).to_string());
    sink.stdout_line(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"t","status":"failed"}}}).to_string());
    sink.stderr_line("compacting context /compact".into());
    assert_eq!(recorder.events.lock().unwrap().len(), 2);
}

#[test]
fn requests_responses_unknown_and_malformed_data_are_not_positive_evidence() {
    let (_, sink, recorder) = setup();
    for line in ["/compact", "{}", r#"{"id":1,"result":{}}"#] { sink.stdout_line(line.into()); }
    let valid = item("item/started", "thread", "t", "i");
    let mut request: Value = serde_json::from_str(&valid).unwrap();
    request["id"] = Value::Null;
    sink.stdout_line(request.to_string());
    for (field, value) in [("turnId", json!("")), ("threadId", json!("other")), ("item", json!({"type":"agentMessage","id":"i"}))] {
        let mut invalid: Value = serde_json::from_str(&valid).unwrap();
        invalid["params"][field] = value;
        sink.stdout_line(invalid.to_string());
    }
    sink.stdout_line(item("item/unknown", "thread", "t", "i"));
    assert_eq!(recorder.events.lock().unwrap().len(), 1);
}

#[test]
fn admission_failure_latches_closed_even_for_exit_or_completion() {
    let (_, sink, recorder) = setup();
    *recorder.reject.lock().unwrap() = true;
    sink.stdout_line(item("item/started", "thread", "t", "i"));
    *recorder.reject.lock().unwrap() = false;
    sink.stdout_line(item("item/completed", "thread", "t", "i"));
    sink.exited(10, Some(0));
    assert_eq!(sink.status(), Status::Blocked);
    assert_eq!(recorder.events.lock().unwrap().len(), 1);
}

#[test]
fn rejected_binding_is_inspectable_and_invalid_identity_never_replaces_owner() {
    let (transport, old, recorder) = setup();
    let mut invalid = scope();
    invalid.thread_id.clear();
    assert!(transport.bind(invalid).is_err());
    assert_eq!(old.status(), Status::Open);
    *recorder.reject.lock().unwrap() = true;
    let blocked = transport.bind(scope()).unwrap();
    assert_eq!(blocked.status(), Status::Blocked);
    assert_eq!(old.status(), Status::Superseded);
    assert!(blocked.release().is_err());
    assert_eq!(blocked.status(), Status::Blocked);
    *recorder.reject.lock().unwrap() = false;
    blocked.release().unwrap();
    assert_eq!(blocked.status(), Status::Superseded);
}

#[test]
fn admission_runs_inside_the_same_gate_as_replacement_and_exit() {
    struct GateCheck(Arc<Mutex<Option<Arc<Mutex<Gate>>>>>);
    impl Admission for GateCheck {
        fn accept(&mut self, _: Envelope) -> Result<(), ()> {
            let held = self.0.lock().unwrap();
            assert!(matches!(held.as_ref().unwrap().try_lock(), Err(std::sync::TryLockError::WouldBlock)));
            Ok(())
        }
    }
    let shared = Arc::new(Mutex::new(None));
    let transport = OwnedTransport::new(GateCheck(shared.clone()));
    *shared.lock().unwrap() = Some(transport.0.clone());
    let sink = transport.bind(scope()).unwrap();
    sink.stdout_line(item("item/started", "thread", "t", "i"));
    sink.exited(10, None);
    transport.bind(scope()).unwrap();
    // Break the test-only cycle. Production sinks do not contain this handle.
    shared.lock().unwrap().take();
}
