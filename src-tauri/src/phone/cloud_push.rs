//! Metadata-only cloud push notification emitter (`POST /v1/desktop/push/notify`).
//!
//! Privacy / E2EE invariant: never sends notification `title`, `body`,
//! `session_title`, question text, or local filesystem paths to the SaaS API or
//! APNs/FCM. Only opaque routing metadata (`hostId`, `relayHostId`, `sessionId`,
//! optional `paneKey`, `eventKind`, and a sanitized short `hostLabel`) leaves
//! the desktop.

use std::io::Read as _;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

const PUSH_NOTIFY_PATH: &str = "/v1/desktop/push/notify";
const PUSH_NOTIFY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ID_LEN: usize = 128;
const MAX_HOST_LABEL_LEN: usize = 40;

fn push_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(PUSH_NOTIFY_TIMEOUT)
            .timeout_read(PUSH_NOTIFY_TIMEOUT)
            .timeout_write(PUSH_NOTIFY_TIMEOUT)
            .build()
    })
}

fn discard_response_body(response: ureq::Response) {
    let _ = std::io::copy(&mut response.into_reader().take(64 * 1024), &mut std::io::sink());
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CloudPushEventKind {
    Approval,
    Question,
    Alert,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CloudPushEvent {
    pub(crate) kind: CloudPushEventKind,
    pub(crate) session_id: Option<String>,
    pub(crate) tab_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudPushNotifyPayload {
    pub(crate) host_id: String,
    pub(crate) relay_host_id: String,
    pub(crate) session_id: String,
    pub(crate) event_kind: CloudPushEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pane_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host_label: Option<String>,
}

fn is_safe_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_LEN
        && !value.contains("::")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn hash_opaque_id(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    let mut out = String::with_capacity(5 + 24);
    out.push_str("sess_");
    for byte in &digest[..12] {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn sanitize_host_label(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let mut cleaned = String::new();
    let mut last_was_space = false;
    for ch in raw.chars() {
        if ch.is_control() || ch.is_whitespace() {
            if !cleaned.is_empty() && !last_was_space {
                cleaned.push(' ');
                last_was_space = true;
            }
        } else {
            cleaned.push(ch);
            last_was_space = false;
        }
        if cleaned.chars().count() >= MAX_HOST_LABEL_LEN {
            break;
        }
    }
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

pub(crate) fn build_push_payload(
    relay_host_id: &str,
    host_label: Option<&str>,
    event: &CloudPushEvent,
) -> CloudPushNotifyPayload {
    let (session_id, routable_session) = match event.session_id.as_deref().map(str::trim) {
        Some(id) if is_safe_opaque_id(id) => (id.to_string(), true),
        Some(id) if !id.is_empty() => (hash_opaque_id(id), false),
        _ => ("desktop-session".to_string(), false),
    };
    // Only attach `pane_key` when `session_id` is a real routable session id;
    // otherwise mobile falls back cleanly to `openHost`.
    let pane_key = if routable_session {
        event
            .tab_id
            .as_deref()
            .map(str::trim)
            .filter(|id| is_safe_opaque_id(id))
            .map(str::to_string)
    } else {
        None
    };

    CloudPushNotifyPayload {
        host_id: relay_host_id.to_string(),
        relay_host_id: relay_host_id.to_string(),
        session_id,
        event_kind: event.kind,
        pane_key,
        host_label: sanitize_host_label(host_label),
    }
}

pub(crate) fn send_push_notify(
    api_base_url: &str,
    access_token: &str,
    payload: &CloudPushNotifyPayload,
) -> bool {
    let url = format!("{}{}", api_base_url.trim_end_matches('/'), PUSH_NOTIFY_PATH);
    let body = match serde_json::to_value(payload) {
        Ok(body) => body,
        Err(_) => return false,
    };
    match push_agent()
        .post(&url)
        .timeout(PUSH_NOTIFY_TIMEOUT)
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(body)
    {
        Ok(response) => {
            discard_response_body(response);
            true
        }
        Err(ureq::Error::Status(_, response)) => {
            discard_response_body(response);
            false
        }
        Err(ureq::Error::Transport(_)) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn builds_metadata_only_payload_and_hashes_paths() {
        let payload = build_push_payload(
            "host_1234567890ab",
            Some("MacBook\nPro\t16"),
            &CloudPushEvent {
                kind: CloudPushEventKind::Approval,
                session_id: Some("sess-42".into()),
                tab_id: Some("tab-1".into()),
            },
        );
        assert_eq!(payload.host_id, "host_1234567890ab");
        assert_eq!(payload.relay_host_id, "host_1234567890ab");
        assert_eq!(payload.session_id, "sess-42");
        assert_eq!(payload.pane_key.as_deref(), Some("tab-1"));
        assert_eq!(payload.event_kind, CloudPushEventKind::Approval);
        assert_eq!(payload.host_label.as_deref(), Some("MacBook Pro 16"));

        // Hashed session_id clears pane_key even when tab_id is opaque so mobile
        // falls back to `openHost` rather than routing to `/session/sess_...`.
        let hashed = build_push_payload(
            "host_1234567890ab",
            Some("   \n\t  "),
            &CloudPushEvent {
                kind: CloudPushEventKind::Question,
                session_id: Some("repo::/Users/alice/secret-project".into()),
                tab_id: Some("tab-1".into()),
            },
        );
        assert!(hashed.session_id.starts_with("sess_"));
        assert_eq!(hashed.session_id.len(), 29);
        assert!(hashed.pane_key.is_none());
        assert!(hashed.host_label.is_none());
        let json = serde_json::to_string(&hashed).unwrap();
        assert!(!json.contains("alice"));
        assert!(!json.contains("secret-project"));

        // Empty session_id falls back to desktop-session and omits pane_key;
        // UTF-8 host_label truncates safely at 40 chars.
        let fallback = build_push_payload(
            "host_1234567890ab",
            Some(&"é".repeat(60)),
            &CloudPushEvent {
                kind: CloudPushEventKind::Alert,
                session_id: None,
                tab_id: Some("tab-2".into()),
            },
        );
        assert_eq!(fallback.session_id, "desktop-session");
        assert!(fallback.pane_key.is_none());
        assert_eq!(fallback.host_label.as_deref().map(|s| s.chars().count()), Some(40));
    }

    #[test]
    fn posts_bearer_authenticated_metadata_to_desktop_push_notify() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut req_bytes = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                req_bytes.extend_from_slice(&buf[..n]);
                if let Some(sep) = req_bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&req_bytes[..sep]);
                    let content_len = headers
                        .lines()
                        .find_map(|line| {
                            let (k, v) = line.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if req_bytes.len() >= sep + 4 + content_len {
                        break;
                    }
                }
            }
            let req = String::from_utf8_lossy(&req_bytes).to_string();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{\"sent\":1}")
                .unwrap();
            req
        });

        let payload = build_push_payload(
            "host_1234567890ab",
            Some("Work Mac"),
            &CloudPushEvent {
                kind: CloudPushEventKind::Question,
                session_id: Some("sess-99".into()),
                tab_id: Some("tab-3".into()),
            },
        );
        let ok = send_push_notify(&format!("http://{addr}"), "desktop-access-tok", &payload);
        assert!(ok);

        let captured = server.join().unwrap();
        assert!(captured.starts_with("POST /v1/desktop/push/notify HTTP/1.1"));
        assert!(captured.contains("Authorization: Bearer desktop-access-tok"));
        assert!(captured.contains("\"eventKind\":\"question\""));
        assert!(captured.contains("\"sessionId\":\"sess-99\""));
        assert!(captured.contains("\"paneKey\":\"tab-3\""));
    }

    #[test]
    fn returns_false_on_non_2xx_push_notify_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            stream
                .write_all(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });

        let payload = build_push_payload(
            "host_1234567890ab",
            None,
            &CloudPushEvent {
                kind: CloudPushEventKind::Alert,
                session_id: Some("sess-1".into()),
                tab_id: None,
            },
        );
        assert!(!send_push_notify(&format!("http://{addr}"), "tok", &payload));
        server.join().unwrap();
    }
}
