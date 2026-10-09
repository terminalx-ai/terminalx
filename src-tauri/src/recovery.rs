//! Recovery messages are an allowlist: provider diagnostics never become UI text.
use crate::events::{Payload, TurnStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// `Tool` is no longer raised (#400): a failed tool is a row in the transcript,
/// not a state of the session. It stays for the logs that recorded it and for
/// the text a failed tool's result is replaced with.
pub enum RecoveryKind { Capacity, Tool, Timeout, DeliveryUnconfirmed, Disconnected, PermissionExpired, Failed }

impl RecoveryKind {
    pub fn classify(message: &str) -> Self {
        let text = message.to_ascii_lowercase();
        if ["capacity", "overloaded", "rate limit", "rate_limit", "too many requests", "429", "529"].iter().any(|s| text.contains(s)) {
            Self::Capacity
        } else if ["timeout", "timed out", "no progress"].iter().any(|s| text.contains(s)) {
            Self::Timeout
        } else if ["network", "disconnect", "connection", "broken pipe", "closed", "eof"].iter().any(|s| text.contains(s)) {
            Self::Disconnected
        } else { Self::Failed }
    }
    pub fn message(self) -> &'static str {
        match self {
            Self::Capacity => "The provider is at capacity. Retry or choose another available model.",
            Self::Tool => "A tool or command failed. Review its outcome before continuing.",
            Self::Timeout => "No progress was confirmed before the timeout. The process outcome is unknown.",
            Self::DeliveryUnconfirmed => "Prompt delivery could not be confirmed. Check the terminal: if your message is still in the agent's input, press Enter there to send it. To resend instead, stop the session, then press Up in the composer to recall your message.",
            Self::Disconnected => "The connection was lost. The process outcome is unknown.",
            Self::PermissionExpired => "The permission request expired. Check the terminal for a new request or stop the session.",
            Self::Failed => "The agent encountered an error. Review the conversation before continuing.",
        }
    }
}

/// How long the session watcher waits before it says anything about a turn.
#[derive(Debug, Clone, Copy)]
pub struct Patience {
    /// Silence on every channel for this long is a stall.
    pub stall: std::time::Duration,
    /// How long the hooks get to close a turn the transcript says has ended.
    pub settle: std::time::Duration,
}

impl Patience {
    pub const DEFAULT: Self = Self { stall: std::time::Duration::from_secs(300), settle: std::time::Duration::from_secs(10) };
}

/// Silence is an unknown outcome, never proof that a command failed or exited.
pub fn is_stale(working: bool, quiet: std::time::Duration, patience: Patience) -> bool {
    working && quiet >= patience.stall
}

/// Restore attention after a restart without resurrecting a running claim.
pub const SESSION_CLOSED_MESSAGE: &str = "Session closed. Untracked or remote commands may still be running; verify their outcome before continuing.";

pub fn from_history(events: &[crate::events::AgentEvent]) -> Option<RecoveryKind> {
    let mut recovery = None;
    let mut open = false;
    for event in events.iter().filter(|event| event.subagent.is_none()) {
        match &event.payload {
            // Older logs raised one for every failed tool, mid-turn (#400).
            Payload::Recovery { kind } => recovery = kind.filter(|kind| *kind != RecoveryKind::Tool),
            Payload::UserMessage { queued: false, .. } => { open = true; recovery = None; }
            Payload::TurnCompleted { .. } => open = false,
            Payload::Status { text } if text == SESSION_CLOSED_MESSAGE => { open = false; recovery = None; }
            Payload::PermissionDecided { label, .. } if label == "Lapsed" => recovery = Some(RecoveryKind::PermissionExpired),
            _ => {}
        }
    }
    recovery.or(open.then_some(RecoveryKind::Disconnected))
}

/// What ends a turn or stops the agent getting any further. A tool or command
/// that failed is neither: the agent reads the result and carries on, and a
/// turn that ends badly says so itself.
pub fn failure(payload: &Payload) -> Option<RecoveryKind> {
    match payload {
        Payload::Error { message, .. } => Some(RecoveryKind::classify(message)),
        Payload::TurnCompleted { status: TurnStatus::Error, final_text, .. } => Some(RecoveryKind::classify(final_text.as_deref().unwrap_or(""))),
        // Some providers emit rate-limit warnings while requests still succeed.
        Payload::RateLimited { status, .. } if status.as_deref() == Some("rejected") => Some(RecoveryKind::Capacity),
        Payload::ApiRetry { attempt, max_retries, reason } if attempt >= max_retries => Some(RecoveryKind::classify(reason.as_deref().unwrap_or(""))),
        _ => None,
    }
}

pub fn diagnose(path: &std::path::Path, payload: &Payload) {
    if let Ok(line) = serde_json::to_string(payload) {
        append_diagnostic(path, &line);
    }
}

/// One stage of a composer prompt's way into a PTY-first CLI: `ready`,
/// `body_written`, `submit_written`, then `accepted` or `unconfirmed`.
///
/// Counts and timings only. `seq` is the prompt's own event number in this
/// tab's log; nothing here is the prompt, a path, a command or an id that
/// means anything outside the tab, so the lines can be quoted in a report.
pub fn diagnose_delivery(path: &std::path::Path, seq: u64, stage: &str, elapsed: std::time::Duration, detail: serde_json::Value) {
    let mut line = serde_json::json!({
        "type": "prompt_delivery",
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "seq": seq,
        "stage": stage,
        "elapsed_ms": elapsed.as_millis() as u64,
    });
    if let (Some(line), serde_json::Value::Object(detail)) = (line.as_object_mut(), detail) {
        line.extend(detail);
    }
    log::info!("prompt delivery: {line}");
    append_diagnostic(path, &line.to_string());
}

fn append_diagnostic(path: &std::path::Path, line: &str) {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "{line}");
    }
}

pub fn sanitize(payload: &mut Payload) {
    match payload {
        Payload::Error { message, .. } => *message = RecoveryKind::classify(message).message().into(),
        Payload::TurnCompleted { status: TurnStatus::Error, final_text, .. } => *final_text = Some(RecoveryKind::classify(final_text.as_deref().unwrap_or("")).message().into()),
        Payload::ToolCallCompleted { result, .. } if result.is_error => {
            result.text = RecoveryKind::Tool.message().into();
            result.structured = None;
            result.images.clear();
        }
        Payload::ApiRetry { reason, .. } => *reason = reason.as_ref().map(|s| RecoveryKind::classify(s).message().into()),
        Payload::RateLimited { message, status, .. } => {
            *message = Some(RecoveryKind::Capacity.message().into());
            *status = status.as_ref().map(|s| if s == "rejected" { "rejected".into() } else { "limited".into() });
        }
        Payload::PermissionDenied { message, .. } => *message = "Permission was denied. Review the request before continuing.".into(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifications_do_not_echo_diagnostics() {
        for (raw, expected) in [
            ("at capacity token=secret /Users/private", RecoveryKind::Capacity),
            ("request timed out API_KEY=secret", RecoveryKind::Timeout),
            ("connection closed https://secret", RecoveryKind::Disconnected),
            ("failed /home/private", RecoveryKind::Failed),
        ] {
            assert_eq!(RecoveryKind::classify(raw), expected);
            let mut p = Payload::Error { message: raw.into(), fatal: false };
            sanitize(&mut p);
            assert!(matches!(p, Payload::Error { message, .. } if message == expected.message()));
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::events::*;
    fn event(payload: Payload) -> AgentEvent {
        AgentEvent { id: "e".into(), session_id: "s".into(), tab_id: "t".into(), harness: "codex".into(), seq: 1, ts: String::new(), subagent: None, payload }
    }
    #[test]
    fn silence_only_pauses_work_and_never_expires_a_permission() {
        use std::time::Duration;
        assert!(!is_stale(true, Duration::from_secs(299), Patience::DEFAULT));
        assert!(is_stale(true, Duration::from_secs(300), Patience::DEFAULT));
        assert!(!is_stale(false, Duration::from_secs(3600), Patience::DEFAULT));
    }
    #[test]
    fn restore_failure_stop_and_unknown_delivery() {
        let mut events = vec![event(Payload::Recovery { kind: Some(RecoveryKind::Capacity) })];
        assert_eq!(from_history(&events), Some(RecoveryKind::Capacity));
        events.push(event(Payload::Recovery { kind: None }));
        assert_eq!(from_history(&events), None);
        events.push(event(Payload::UserMessage { author: None, text: "Continue".into(), images: vec![], baseline: None, queued: false, cwd: None }));
        assert_eq!(from_history(&events), Some(RecoveryKind::Disconnected));
        events.push(event(Payload::Status { text: SESSION_CLOSED_MESSAGE.into() }));
        assert_eq!(from_history(&events), None);
        events.push(event(Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false }));
        assert_eq!(from_history(&events), None);
    }
    #[test]
    fn a_tool_failure_an_older_log_recorded_is_not_restored() {
        let events = vec![event(Payload::Recovery { kind: Some(RecoveryKind::Tool) })];
        assert_eq!(from_history(&events), None);
    }
    #[test]
    fn expired_permission_has_recovery_instead_of_working() {
        let events = vec![event(Payload::PermissionDecided { request_id: "r".into(), tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true })];
        assert_eq!(from_history(&events), Some(RecoveryKind::PermissionExpired));
    }
    #[test]
    fn a_tool_is_never_a_session_failure_and_failed_details_are_protected() {
        assert_eq!(failure(&Payload::ToolCallCompleted { call_id: "done".into(), result: ToolResult::default() }), None);
        let mut failed = Payload::ToolCallCompleted { call_id: "failed".into(), result: ToolResult { text: "TOKEN=secret /Users/private".into(), is_error: true, structured: Some(serde_json::json!({"request": "secret"})), ..Default::default() } };
        assert_eq!(failure(&failed), None);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        diagnose(&path, &failed);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(std::fs::read_to_string(path).unwrap().contains("TOKEN=secret"));
        sanitize(&mut failed);
        let public = serde_json::to_string(&failed).unwrap();
        assert!(!public.contains("secret"));
        assert!(!public.contains("/Users"));
    }
    #[test]
    fn a_turn_that_ends_in_an_error_is_a_failure_and_one_that_ends_well_is_not() {
        let end = |status, final_text: Option<&str>| Payload::TurnCompleted { status, final_text: final_text.map(Into::into), usage: None, duration_ms: None, head: None, auth_failed: false };
        assert_eq!(failure(&end(TurnStatus::Ok, None)), None);
        assert_eq!(failure(&end(TurnStatus::Aborted, None)), None);
        assert_eq!(failure(&end(TurnStatus::Error, Some("exited"))), Some(RecoveryKind::Failed));
        assert_eq!(failure(&end(TurnStatus::Error, Some("connection closed"))), Some(RecoveryKind::Disconnected));
    }
    #[test]
    fn a_retry_with_attempts_left_is_not_a_failure() {
        assert_eq!(failure(&Payload::ApiRetry { attempt: 2, max_retries: 10, reason: Some("overloaded".into()) }), None);
        let mut payloads = Vec::new();
        crate::harness::claude::transcript::decode_line(r#"{"type":"system","subtype":"api_error","error":{"message":"Overloaded"},"retryInMs":1000,"retryAttempt":2,"maxRetries":10}"#, &Default::default(), &mut payloads);
        crate::harness::codex::rollout::decode_line(r#"{"type":"event_msg","payload":{"type":"stream_error","message":"Reconnecting... 2/5"}}"#, &Default::default(), &mut payloads);
        assert_eq!(payloads.len(), 2);
        assert!(payloads.iter().all(|payload| failure(payload).is_none()), "{payloads:?}");
        // The last attempt, and an error with no attempts to count, still are.
        payloads.clear();
        crate::harness::claude::transcript::decode_line(r#"{"type":"system","subtype":"api_error","error":{"message":"Overloaded"},"retryAttempt":10,"maxRetries":10}"#, &Default::default(), &mut payloads);
        crate::harness::claude::transcript::decode_line(r#"{"type":"system","subtype":"api_error","error":{"message":"Overloaded"}}"#, &Default::default(), &mut payloads);
        crate::harness::codex::rollout::decode_line(r#"{"type":"event_msg","payload":{"type":"stream_error","message":"Reconnecting... 5/5"}}"#, &Default::default(), &mut payloads);
        crate::harness::codex::rollout::decode_line(r#"{"type":"event_msg","payload":{"type":"error","message":"stream disconnected before completion"}}"#, &Default::default(), &mut payloads);
        assert_eq!(payloads.iter().map(failure).collect::<Vec<_>>(), vec![Some(RecoveryKind::Capacity), Some(RecoveryKind::Capacity), Some(RecoveryKind::Failed), Some(RecoveryKind::Disconnected)]);
    }
    #[test]
    fn warning_limits_are_not_terminal_but_rejected_requests_are() {
        assert_eq!(failure(&Payload::RateLimited { status: Some("allowed_warning".into()), resets_at: None, message: None }), None);
        assert_eq!(failure(&Payload::RateLimited { status: Some("rejected".into()), resets_at: None, message: None }), Some(RecoveryKind::Capacity));
        assert_eq!(failure(&Payload::ApiRetry { attempt: 3, max_retries: 3, reason: Some("capacity".into()) }), Some(RecoveryKind::Capacity));
    }
    #[test]
    fn provider_capacity_records_reach_recovery() {
        let mut payloads = Vec::new();
        crate::harness::claude::transcript::decode_line(r#"{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"The model is at capacity. TOKEN=secret"}]}}"#, &Default::default(), &mut payloads);
        assert_eq!(failure(&payloads[0]), Some(RecoveryKind::Capacity));
        sanitize(&mut payloads[0]);
        assert!(!serde_json::to_string(&payloads[0]).unwrap().contains("secret"));
    }
}
