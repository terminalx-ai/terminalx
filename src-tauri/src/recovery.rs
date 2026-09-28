//! Recovery messages are an allowlist: provider diagnostics never become UI text.
use crate::events::{Payload, TurnStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryKind { Capacity, Tool, Timeout, Disconnected, PermissionExpired, Failed }

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
            Self::Disconnected => "The connection was lost. The process outcome is unknown.",
            Self::PermissionExpired => "The permission request expired. Check the terminal for a new request or stop the session.",
            Self::Failed => "The agent encountered an error. Review the conversation before continuing.",
        }
    }
}

/// Silence is an unknown outcome, never proof that a command failed or exited.
pub fn is_stale(working: bool, quiet: std::time::Duration) -> bool {
    working && quiet >= std::time::Duration::from_secs(300)
}

/// Restore attention after a restart without resurrecting a running claim.
pub const SESSION_CLOSED_MESSAGE: &str = "Session closed. Untracked or remote commands may still be running; verify their outcome before continuing.";

pub fn from_history(events: &[crate::events::AgentEvent]) -> Option<RecoveryKind> {
    let mut recovery = None;
    let mut open = false;
    for event in events.iter().filter(|event| event.subagent.is_none()) {
        match &event.payload {
            Payload::Recovery { kind } => recovery = *kind,
            Payload::UserMessage { queued: false, .. } => { open = true; recovery = None; }
            Payload::TurnCompleted { .. } => open = false,
            Payload::Status { text } if text == SESSION_CLOSED_MESSAGE => { open = false; recovery = None; }
            Payload::PermissionDecided { label, .. } if label == "Lapsed" => recovery = Some(RecoveryKind::PermissionExpired),
            _ => {}
        }
    }
    recovery.or(open.then_some(RecoveryKind::Disconnected))
}

pub fn failure(payload: &Payload) -> Option<RecoveryKind> {
    match payload {
        Payload::Error { message, .. } => Some(RecoveryKind::classify(message)),
        Payload::TurnCompleted { status: TurnStatus::Error, final_text, .. } => Some(RecoveryKind::classify(final_text.as_deref().unwrap_or(""))),
        Payload::ToolCallCompleted { result, .. } if result.is_error => Some(RecoveryKind::Tool),
        // Some providers emit rate-limit warnings while requests still succeed.
        Payload::RateLimited { status, .. } if status.as_deref() == Some("rejected") => Some(RecoveryKind::Capacity),
        Payload::ApiRetry { attempt, max_retries, reason } if attempt >= max_retries => Some(RecoveryKind::classify(reason.as_deref().unwrap_or(""))),
        _ => None,
    }
}

pub fn diagnose(path: &std::path::Path, payload: &Payload) {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let (Ok(mut file), Ok(line)) = (options.open(path), serde_json::to_string(payload)) {
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
        assert!(!is_stale(true, Duration::from_secs(299)));
        assert!(is_stale(true, Duration::from_secs(300)));
        assert!(!is_stale(false, Duration::from_secs(3600)));
    }
    #[test]
    fn restore_failure_stop_and_unknown_delivery() {
        let mut events = vec![event(Payload::Recovery { kind: Some(RecoveryKind::Capacity) })];
        assert_eq!(from_history(&events), Some(RecoveryKind::Capacity));
        events.push(event(Payload::Recovery { kind: None }));
        assert_eq!(from_history(&events), None);
        events.push(event(Payload::UserMessage { text: "Continue".into(), images: vec![], baseline: None, queued: false, cwd: None }));
        assert_eq!(from_history(&events), Some(RecoveryKind::Disconnected));
        events.push(event(Payload::Status { text: SESSION_CLOSED_MESSAGE.into() }));
        assert_eq!(from_history(&events), None);
        events.push(event(Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false }));
        assert_eq!(from_history(&events), None);
    }
    #[test]
    fn expired_permission_has_recovery_instead_of_working() {
        let events = vec![event(Payload::PermissionDecided { request_id: "r".into(), tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true })];
        assert_eq!(from_history(&events), Some(RecoveryKind::PermissionExpired));
    }
    #[test]
    fn completed_tool_is_not_a_failure_and_failed_details_are_protected() {
        assert_eq!(failure(&Payload::ToolCallCompleted { call_id: "done".into(), result: ToolResult::default() }), None);
        let mut failed = Payload::ToolCallCompleted { call_id: "failed".into(), result: ToolResult { text: "TOKEN=secret /Users/private".into(), is_error: true, structured: Some(serde_json::json!({"request": "secret"})), ..Default::default() } };
        assert_eq!(failure(&failed), Some(RecoveryKind::Tool));
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
