//! Protocol-unit inputs, not a simulated provider or live acceptance evidence.
//! Field contracts: official app-server docs; foreground emitter semantics:
//! rust-v0.164.0 core/compact.rs and compact_remote_v2_installation.rs.
use super::*;

fn client() -> Stdio { Stdio::new("/tmp/terminalx-stdio-contract".into(), "".into(), None, "auto".into(), None) }

fn wire(actions: &[Action]) -> Vec<Value> {
    actions.iter().filter_map(|a| match a { Action::Write(line) => Some(serde_json::from_str(&line.line).unwrap()), _ => None }).collect()
}

fn ready(text: &str) -> (Stdio, Vec<Action>) {
    let mut client = client();
    let start = wire(&client.start(text.into(), vec![]).unwrap());
    assert_eq!(start.len(), 1);
    assert_eq!(start[0]["method"], "initialize");
    let initialized = client.handle(&json!({"id": start[0]["id"], "result": {}}).to_string()).unwrap();
    let initialized = wire(&initialized);
    assert_eq!(initialized[0]["method"], "initialized");
    assert_eq!(initialized[1]["method"], "thread/start");
    let actions = client.handle(&json!({"id": initialized[1]["id"], "result": {"thread": {"id":"thread"}}}).to_string()).unwrap();
    (client, actions)
}

fn turn(client: &mut Stdio) -> Vec<Action> {
    client.handle(r#"{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"turn"}}}"#).unwrap()
}

fn item(method: &str, thread: &str) -> String {
    json!({"method":method,"params":{"threadId":thread,"turnId":"turn","item":{"type":"contextCompaction","id":"compact"}}}).to_string()
}

#[test]
fn a_prompt_is_accepted_once_by_whichever_of_its_result_or_start_comes_first() {
    let accepted = |actions: &[Action]| actions.iter().filter(|action| matches!(action, Action::Accepted)).count();
    let (mut client, actions) = ready("hello");
    assert!(client.unaccepted());
    let result = json!({"id": wire(&actions)[0]["id"], "result": {"turn": {"id": "turn"}}}).to_string();
    assert_eq!(accepted(&client.handle(&result).unwrap()), 1);
    assert!(!client.unaccepted());
    assert_eq!(accepted(&turn(&mut client)), 0);

    let (mut client, actions) = ready("hello");
    let result = json!({"id": wire(&actions)[0]["id"], "result": {"turn": {"id": "turn"}}}).to_string();
    let started = turn(&mut client);
    assert!(matches!(started.first(), Some(Action::Accepted)), "taken before its turn is drawn");
    assert_eq!(accepted(&client.handle(&result).unwrap()), 0);
}

#[test]
fn a_refused_or_unanswered_prompt_stays_unaccepted_and_compaction_never_waits() {
    let mut client = client();
    client.start("hello".into(), vec![]).unwrap();
    assert!(client.unaccepted(), "a prompt behind the handshake is not taken");
    let (mut client, actions) = ready("hello");
    let refused = json!({"id": wire(&actions)[0]["id"], "error": {"code": -32600, "message": "model not found"}}).to_string();
    assert!(client.handle(&refused).is_err());
    client.fail();
    assert!(client.unaccepted() && client.failed(), "a refused prompt was never received");
    let (client, _) = ready("/compact");
    assert!(!client.unaccepted());
}

#[test]
fn the_real_thread_is_bound_before_the_first_prompt_write() {
    let (client, actions) = ready("hello");
    assert_eq!(client.thread.as_deref(), Some("thread"));
    assert!(matches!(actions.first(), Some(Action::ThreadReady(id)) if id == "thread"));
    let requests = wire(&actions);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["method"], "turn/start");
    assert_eq!(requests[0]["params"]["threadId"], "thread");
    assert_eq!(requests[0]["params"]["input"][0]["text"], "hello");
}

#[test]
fn a_known_thread_is_resumed_without_its_turns_before_the_first_prompt() {
    let mut client = Stdio::new("/tmp/terminalx-stdio-contract".into(), "".into(), None, "auto".into(), Some("thread".into()));
    let start = wire(&client.start("hello again".into(), vec![]).unwrap());
    let initialized = wire(&client.handle(&json!({"id": start[0]["id"], "result": {}}).to_string()).unwrap());
    assert_eq!(initialized[1]["method"], "thread/resume");
    let params = &initialized[1]["params"];
    assert_eq!((&params["threadId"], &params["excludeTurns"]), (&json!("thread"), &json!(true)));
    assert_eq!((&params["approvalPolicy"], &params["sandbox"], &params["cwd"]), (&json!("on-request"), &json!("workspace-write"), &json!("/tmp/terminalx-stdio-contract")));
    let actions = client.handle(&json!({"id": initialized[1]["id"], "result": {"thread": {"id":"thread"}}}).to_string()).unwrap();
    assert!(matches!(actions.first(), Some(Action::ThreadReady(id)) if id == "thread"));
    let requests = wire(&actions);
    assert_eq!(requests[0]["method"], "turn/start");
    assert_eq!(requests[0]["params"]["input"][0]["text"], "hello again");
}

#[test]
fn a_resume_answered_with_another_thread_sends_no_prompt() {
    let mut client = Stdio::new("/tmp/terminalx-stdio-contract".into(), "".into(), None, "auto".into(), Some("thread".into()));
    client.start("hello again".into(), vec![]).unwrap();
    client.handle(r#"{"id":1,"result":{}}"#).unwrap();
    let error = client.handle(r#"{"id":2,"result":{"thread":{"id":"other"}}}"#).unwrap_err();
    assert!(error.to_string().contains("different thread"), "{error:#}");
    assert!(client.thread.is_none() && !client.ready);
}

#[test]
fn codex_releases_from_the_verified_minimum_are_supported() {
    for version in ["codex-cli 0.164.0", "codex-cli 0.166.0\n", "codex-cli 0.167.0-alpha.2", "codex-cli 1.0.0"] {
        assert!(supported(version), "{version}");
    }
    for version in ["codex-cli 0.163.9", "codex-cli 0.99.0", "codex 0.166.0", "codex-cli", "codex-cli 0.166", ""] {
        assert!(!supported(version), "{version}");
    }
}

#[test]
fn duplicate_responses_never_replay_the_first_prompt() {
    let (mut client, _) = ready("hello");
    for id in [1, 2] {
        assert!(client.handle(&json!({"id":id,"result":{"thread":{"id":"other"}}}).to_string()).unwrap().is_empty());
    }
    assert_eq!(client.thread.as_deref(), Some("thread"));
}

#[test]
fn interrupt_during_handshake_fences_the_deferred_input() {
    let mut client = client();
    client.start("must not send".into(), vec![]).unwrap();
    assert!(client.interrupt().is_err());
    assert!(client.blocked);
    assert!(client.handle(r#"{"id":1,"result":{}}"#).unwrap().is_empty());
    assert!(client.first.is_none());
}

#[test]
fn compact_command_is_never_a_user_input_or_a_model_turn() {
    let (mut client, actions) = ready("/compact");
    let requests = wire(&actions);
    assert_eq!(requests[0]["method"], "thread/compact/start");
    assert!(requests[0]["params"].get("input").is_none());
    assert!(turn(&mut client).is_empty());
    let started = client.handle(&item("item/started", "thread")).unwrap();
    assert!(matches!(&started[..], [Action::Lifecycle(Observation::ItemStarted { item_id, .. })] if item_id == "compact"));
    let completed = client.handle(&item("item/completed", "thread")).unwrap();
    assert!(matches!(&completed[..], [Action::Lifecycle(Observation::ItemCompleted { .. })]));
    let ended = client.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}"#).unwrap();
    assert!(matches!(&ended[..], [Action::Lifecycle(Observation::TurnEnded { .. }), Action::CompactEnded]));
}

#[test]
fn exit_closes_start_admission_but_preserves_buffered_completion() {
    let (mut client, _) = ready("hello");
    turn(&mut client);
    client.exited = true;
    assert!(client.handle(&item("item/started", "thread")).unwrap().is_empty());
    assert!(matches!(&client.handle(&item("item/completed", "thread")).unwrap()[..], [Action::Lifecycle(Observation::ItemCompleted { .. })]));
    assert!(client.handle(&item("item/completed", "another-thread")).unwrap().is_empty());
    assert!(client.prompt("never replay".into(), vec![]).is_err());
}

#[test]
fn late_turn_start_response_cannot_reopen_a_completed_turn() {
    let (mut client, actions) = ready("hello");
    let request = wire(&actions).remove(0);
    turn(&mut client);
    client.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}"#).unwrap();
    client.handle(&json!({"id": request["id"], "result":{"turn":{"id":"turn"}}}).to_string()).unwrap();
    assert!(client.turn.is_none());
    assert_eq!(wire(&client.prompt("next".into(), vec![]).unwrap())[0]["method"], "turn/start");
}

fn approval() -> String {
    json!({"id":"server-request", "method":"item/commandExecution/requestApproval", "params":{"threadId":"thread","turnId":"turn","itemId":"command","command":"pwd","availableDecisions":["accept","decline","cancel"]}}).to_string()
}

#[test]
fn server_request_ids_are_separate_and_decisions_are_exact_and_single_use() {
    let (mut client, _) = ready("hello");
    turn(&mut client);
    let actions = client.handle(&approval()).unwrap();
    let [Action::Emit(Payload::PermissionRequested { request_id, .. })] = &actions[..] else { panic!("approval card missing") };
    assert!(client.answer(request_id, "acceptForSession").is_err());
    let response = wire(&client.answer(request_id, "allow").unwrap()).remove(0);
    assert_eq!(response["id"], "server-request");
    assert_eq!(response["result"]["decision"], "accept");
    assert!(client.answer(request_id, "allow").is_err());
    assert!(!client.pending.is_empty(), "server approval must not consume client request IDs");
}

#[test]
fn resolved_or_ended_requests_cannot_be_answered() {
    let (mut client, _) = ready("hello");
    turn(&mut client);
    client.handle(&approval()).unwrap();
    client.handle(r#"{"method":"serverRequest/resolved","params":{"threadId":"thread","requestId":"server-request"}}"#).unwrap();
    assert!(client.answer("\"server-request\"", "allow").is_err());
    client.handle(&approval()).unwrap();
    client.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"interrupted"}}}"#).unwrap();
    assert!(client.answer("\"server-request\"", "allow").is_err());
}

#[test]
fn errors_carry_evidence_without_fabricating_a_compaction_result() {
    let (mut client, _) = ready("hello");
    turn(&mut client);
    for retry in [true, false] {
        let actions = client.handle(&json!({"method":"error","params":{"threadId":"thread","turnId":"turn","willRetry":retry,"error":{"message":"provider failure"}}}).to_string()).unwrap();
        assert!(matches!(&actions[0], Action::Lifecycle(Observation::TurnError { will_retry, .. }) if *will_retry == retry));
        assert!(!actions.iter().any(|a| matches!(a, Action::Lifecycle(Observation::ItemCompleted { .. }))));
    }
}

#[test]
fn unsupported_approval_extensions_fail_closed_without_an_allow() {
    let (mut client, _) = ready("hello");
    turn(&mut client);
    let actions = client.handle(r#"{"id":44,"method":"item/permissions/requestApproval","params":{"threadId":"thread","turnId":"turn","itemId":"permissions"}}"#).unwrap();
    let response = wire(&actions).remove(0);
    assert_eq!(response["error"]["code"], -32601);
    assert!(response.get("result").is_none());
    assert!(client.asks.is_empty());
}

#[test]
fn buffered_requests_after_exit_do_not_mask_positive_compaction_evidence() {
    for failed in [false, true] {
        let (mut client, _) = ready("hello");
        turn(&mut client);
        client.handle(&item("item/started", "thread")).unwrap();
        if failed { client.fail(); } else { client.exited = true; }
        assert!(client.handle(&approval()).unwrap().is_empty());
        assert!(client.handle(&item("item/started", "thread")).unwrap().is_empty());
        assert!(matches!(&client.handle(&item("item/completed", "thread")).unwrap()[..], [Action::Lifecycle(Observation::ItemCompleted { .. })]));
    }
}

#[test]
fn queued_interrupt_expires_with_its_turn_and_late_error_cannot_fail_next_turn() {
    let (mut client, _) = ready("hello");
    turn(&mut client);
    let mut actions = client.interrupt().unwrap();
    let Action::Write(frame) = actions.remove(0) else { panic!("interrupt frame missing") };
    assert!(client.write_is_current(&frame));
    let id = serde_json::from_str::<Value>(&frame.line).unwrap()["id"].clone();
    client.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}"#).unwrap();
    assert!(!client.write_is_current(&frame));
    client.retire_write(&frame, false);
    client.prompt("next".into(), vec![]).unwrap();
    assert!(client.handle(&json!({"id":id,"error":{"message":"turn no longer active"}}).to_string()).unwrap().is_empty());
    assert!(!client.blocked);
}

#[test]
fn resolved_approval_revokes_its_queued_reply() {
    let (mut client, _) = ready("hello");
    turn(&mut client);
    client.handle(&approval()).unwrap();
    let mut actions = client.answer("\"server-request\"", "allow").unwrap();
    let Action::Write(frame) = actions.remove(0) else { panic!("approval frame missing") };
    assert!(client.write_is_current(&frame));
    client.handle(r#"{"method":"serverRequest/resolved","params":{"threadId":"thread","requestId":"server-request"}}"#).unwrap();
    assert!(!client.write_is_current(&frame));
    client.retire_write(&frame, false);
    assert!(!client.blocked);
}

#[test]
fn every_terminal_turn_expires_visible_approval_cards() {
    for status in ["completed", "failed", "interrupted"] {
        let (mut client, _) = ready("hello");
        turn(&mut client);
        client.handle(&approval()).unwrap();
        let actions = client.handle(&json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":status}}}).to_string()).unwrap();
        let expired = actions.iter().position(|action| matches!(action, Action::Emit(Payload::PermissionDecided { request_id, allowed: false, .. }) if request_id == "\"server-request\"" )).unwrap();
        let completed = actions.iter().position(|action| matches!(action, Action::Emit(Payload::TurnCompleted { .. }))).unwrap();
        assert!(expired < completed, "cards expire before terminal status is published");
        assert!(client.asks.is_empty());
    }
}

/// #667: a failed turn whose model request Codex was refused for ends as a
/// refused sign-in; any other failure does not.
#[test]
fn a_turn_refused_for_its_sign_in_ends_with_auth_failed() {
    let ended = |error: Value| {
        let (mut client, _) = ready("hello");
        turn(&mut client);
        let actions = client.handle(&json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"failed","error":error}}}).to_string()).unwrap();
        actions.into_iter().find_map(|action| match action { Action::Emit(Payload::TurnCompleted { auth_failed, final_text, .. }) => Some((auth_failed, final_text)), _ => None }).unwrap()
    };
    for refused in [
        json!({"message": "unexpected status 401 Unauthorized", "codexErrorInfo": "unauthorized"}),
        json!({"message": "request failed", "codexErrorInfo": {"responseStreamConnectionFailed": {"httpStatusCode": 401}}}),
        json!({"message": "account/read failed: workspace routing discovery unauthorized (401)"}),
        json!({"message": "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."}),
    ] {
        assert!(ended(refused.clone()).0, "{refused}");
    }
    for other in [
        json!({"message": "stream disconnected before completion", "codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": null}}}),
        json!({"message": "error sending request: connection refused", "codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 503}}}),
        json!({"message": "You've hit your usage limit.", "codexErrorInfo": "usageLimitExceeded"}),
    ] {
        let (auth_failed, final_text) = ended(other.clone());
        assert!(!auth_failed, "{other}");
        assert_eq!(final_text.as_deref(), other["message"].as_str());
    }
    // A turn that ended well is never a refusal, whatever it says.
    let (mut client, _) = ready("hello");
    turn(&mut client);
    let actions = client.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed","error":{"codexErrorInfo":"unauthorized"}}}}"#).unwrap();
    assert!(actions.iter().any(|action| matches!(action, Action::Emit(Payload::TurnCompleted { auth_failed: false, .. }))));
}
