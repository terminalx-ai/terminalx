use super::*;

// Recorded CLI fixtures shared with the live decoders: Claude Code 2.1.258
// and codex-cli 0.152.0, including the model's input tape.
const CLAUDE: &str = include_str!("claude/fixtures/interactive_session.jsonl");
const CODEX: &str = include_str!("codex/fixtures/rollout.jsonl");
const NEW: &str = "11111111-1111-4111-8111-111111111111";
const CLAUDE_ID: &str = "a35bdd55-a09a-4197-8959-28cb43221008";
const CODEX_ID: &str = "01a061f1-16d4-7c01-9900-e3903aa4d5ae";
fn claude_anchor() -> Anchor<'static> {
    Anchor { timestamp: "2026-09-02T11:17:16.389Z", text: "pong", message_id: None }
}
fn codex_anchor() -> Anchor<'static> {
    Anchor { timestamp: "2026-09-02T11:46:33.240Z", text: "ok", message_id: Some("msg_0a08247068cf241f016a980c991ae087d2b8603411a299c2ef") }
}
fn records(text: &str) -> Vec<Value> { text.lines().map(|l| serde_json::from_str(l).unwrap()).collect() }
#[test]
fn claude_ends_at_answer_and_keeps_original() {
    let out = duplicate("claude", CLAUDE, CLAUDE_ID, NEW, Some(&claude_anchor())).unwrap();
    let rows = records(&out);
    assert_eq!(rows.last().unwrap()["message"]["content"][0]["text"], "pong");
    assert!(rows.iter().all(|r| r["sessionId"] == NEW));
    assert!(!out.contains("second"));
    assert!(CLAUDE.contains("second"));
    assert!(!out.contains("last-prompt"));
    assert!(duplicate("claude", CLAUDE, CLAUDE_ID, NEW, None).unwrap().contains("second"));
}
#[test]
fn codex_keeps_model_tape_and_completion_but_no_later_context() {
    let out = duplicate("codex", CODEX, CODEX_ID, NEW, Some(&codex_anchor())).unwrap();
    let rows = records(&out);
    assert_eq!(rows[0]["payload"]["id"], NEW);
    assert_eq!(rows[0]["payload"]["session_id"], NEW);
    assert_eq!(rows.len(), 14);
    assert_eq!(rows.last().unwrap()["payload"]["type"], "task_complete");
    assert!(rows.iter().any(|r| r["type"] == "response_item" && r["payload"]["role"] == "developer"));
    assert!(rows.iter().any(|r| r["type"] == "response_item" && r["payload"]["id"] == codex_anchor().message_id.unwrap()));
    assert!(!out.contains(CODEX_ID));
    assert!(records(&duplicate("codex", CODEX, CODEX_ID, NEW, None).unwrap()).len() > rows.len());
}
#[test]
fn malformed_or_unknown_records_fail_even_after_selected_turn() {
    for (harness, fixture, id, anchor) in [("claude", CLAUDE, CLAUDE_ID, claude_anchor()), ("codex", CODEX, CODEX_ID, codex_anchor())] {
        for tail in ["{broken\n", "{\"type\":\"new-format\",\"payload\":{}}\n"] {
            assert!(duplicate(harness, &format!("{fixture}\n{tail}"), id, NEW, Some(&anchor)).unwrap_err().to_string().contains("Unknown"));
        }
        assert!(duplicate(harness, fixture, NEW, NEW, Some(&anchor)).is_err());
    }
}
#[test]
fn ambiguous_missing_or_incomplete_answers_fail() {
    let mut a = claude_anchor();
    a.timestamp = "2020-01-01T00:00:00Z";
    assert!(duplicate("claude", CLAUDE, CLAUDE_ID, NEW, Some(&a)).is_err());
    assert!(duplicate("claude", &format!("{CLAUDE}\n{CLAUDE}"), CLAUDE_ID, NEW, Some(&claude_anchor())).is_err());
    let missing = CODEX.lines().filter(|l| !l.contains("task_complete")).collect::<Vec<_>>().join("\n");
    assert!(duplicate("codex", &missing, CODEX_ID, NEW, Some(&codex_anchor())).is_err());
    let missing_tape = CODEX.lines().filter(|l| !(l.contains("response_item") && l.contains(codex_anchor().message_id.unwrap()))).collect::<Vec<_>>().join("\n");
    assert!(duplicate("codex", &missing_tape, CODEX_ID, NEW, Some(&codex_anchor())).is_err());
}
#[test]
fn messages_containing_the_old_id_are_not_rewritten() {
    let fixture = CODEX.replace("reply with the word ok", &format!("remember {CODEX_ID}"));
    assert!(duplicate("codex", &fixture, CODEX_ID, NEW, Some(&codex_anchor())).unwrap().contains(&format!("remember {CODEX_ID}")));
}

#[test]
fn current_recorded_clis_include_bookkeeping_without_retaining_later_context() {
    for (harness, source, id, timestamp, message_id) in [
        ("claude", include_str!("fixtures/claude-reset.jsonl"), "32610000-0000-4000-8000-000000000001", "2026-11-07T10:56:21.941Z", None),
        ("codex", include_str!("fixtures/codex-reset.jsonl"), "01a1b5a6-efed-7c52-a67d-a4c5c6f0466d", "2026-11-07T10:56:25Z", Some("msg_012842287db3b21e016aef03d890b887d28ca6c6bcf431f896")),
    ] {
        let anchor = Anchor { timestamp, text: "FIRST_RESET_MARKER", message_id };
        let out = duplicate(harness, source, id, NEW, Some(&anchor)).unwrap();
        assert!(out.contains("FIRST_RESET_MARKER"));
        assert!(!out.contains("LATER_RESET_SECRET"));
        assert!(duplicate(harness, source, id, NEW, None).unwrap().contains("LATER_RESET_SECRET"));
        if harness == "codex" { assert_eq!(records(&out).last().unwrap()["payload"]["type"], "task_complete"); }
        else { assert!(!out.contains("session-owner")); }
    }
}

#[test]
fn unknown_nested_codex_semantics_are_not_silently_copied() {
    for record in [
        r#"{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}"#,
        r#"{"type":"response_item","payload":{"type":"future_memory_reference"}}"#,
    ] {
        assert!(duplicate("codex", &format!("{CODEX}\n{record}\n"), CODEX_ID, NEW, Some(&codex_anchor())).unwrap_err().to_string().contains("Unknown Codex"));
    }
}
