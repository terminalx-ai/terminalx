//! `terminalx-workspace-rpc/1`: the contract both ends of a cloud workspace
//! connection share (terminalx-saas `apps/api/docs/cloud-workspace-remote-runtime-contract.md`).
//!
//! The runtime serves only the methods in [`METHODS`]; there is no generic
//! "invoke a desktop command". Every method names the namespace version it
//! belongs to and the least authority that may call it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL: &str = "terminalx-workspace-rpc/1";

/// Namespace versions this build speaks, in preference order.
pub const CAPABILITIES: [&str; 4] = ["pty/1", "fs/1", "git/1", "session/1"];

/// Authority an attachment grants, from the API's `authority` (`manage` →
/// runtime scope, `participate` → session scope).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Authority {
    Participate,
    Manage,
}

impl Authority {
    /// The runtime's attachment scope, as the API's refresh reports it.
    pub fn from_scope(scope: &str) -> Option<Self> {
        match scope {
            "runtime" => Some(Self::Manage),
            "session" => Some(Self::Participate),
            _ => None,
        }
    }
}

pub struct Method {
    pub name: &'static str,
    pub capability: &'static str,
    pub authority: Authority,
    /// Mutating calls carry a `clientRequestId` and are answered from the
    /// idempotency cache when resent.
    pub idempotent: bool,
}

const fn method(name: &'static str, capability: &'static str, authority: Authority, idempotent: bool) -> Method {
    Method { name, capability, authority, idempotent }
}

use Authority::{Manage, Participate};

pub const METHODS: &[Method] = &[
    method("session.list", "session/1", Participate, false),
    method("session.get", "session/1", Participate, false),
    method("session.create", "session/1", Manage, true),
    method("session.close", "session/1", Manage, true),
    // Participate may send only to sessions shared with it; the server checks.
    method("session.send", "session/1", Participate, true),
    method("session.subscribe", "session/1", Participate, false),
    method("session.unsubscribe", "session/1", Participate, false),
    method("pty.create", "pty/1", Manage, true),
    method("pty.list", "pty/1", Participate, false),
    // Input and size belong to the terminal's controller; `pty.control`
    // takes them over explicitly. Participants only ever watch.
    method("pty.write", "pty/1", Manage, false),
    method("pty.resize", "pty/1", Manage, false),
    method("pty.control", "pty/1", Manage, false),
    method("pty.kill", "pty/1", Manage, false),
    method("pty.attach", "pty/1", Participate, false),
    method("pty.detach", "pty/1", Participate, false),
    method("fs.list", "fs/1", Participate, false),
    method("fs.stat", "fs/1", Participate, false),
    method("fs.read", "fs/1", Participate, false),
    method("fs.write", "fs/1", Manage, true),
    method("fs.rename", "fs/1", Manage, true),
    method("fs.delete", "fs/1", Manage, true),
    method("fs.mkdir", "fs/1", Manage, true),
    method("fs.watch", "fs/1", Participate, false),
    method("fs.unwatch", "fs/1", Participate, false),
    method("git.status", "git/1", Participate, false),
    method("git.diff", "git/1", Participate, false),
    method("git.log", "git/1", Participate, false),
    method("git.branches", "git/1", Participate, false),
    method("git.checkout", "git/1", Manage, true),
    method("git.commit", "git/1", Manage, true),
    method("git.stage", "git/1", Manage, true),
    method("git.unstage", "git/1", Manage, true),
    method("git.push", "git/1", Manage, true),
    method("git.pull", "git/1", Manage, true),
];

pub fn find_method(name: &str) -> Option<&'static Method> {
    METHODS.iter().find(|method| method.name == name)
}

/// The error codes of the contract. Clients branch on `code`, never on text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: &'static str,
    pub message: String,
}

impl RpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_params", message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new("forbidden", message)
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::new("internal", format!("{error:#}"))
    }
}

impl From<anyhow::Error> for RpcError {
    fn from(error: anyhow::Error) -> Self {
        Self::internal(error)
    }
}

pub fn success(id: &str, result: Value) -> Value {
    json!({ "id": id, "ok": true, "result": result })
}

pub fn failure(id: &str, error: &RpcError) -> Value {
    json!({ "id": id, "ok": false, "error": { "code": error.code, "message": error.message } })
}

/// `rpc.hello`: the intersection of what the client wants and what this
/// runtime serves. No overlap at all is `update_required`.
pub fn negotiate(params: &Value) -> Result<Vec<String>, RpcError> {
    if params.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
        return Err(RpcError::new("update_required", format!("this runtime speaks {PROTOCOL}")));
    }
    let wanted: Vec<&str> = params
        .get("want")
        .and_then(Value::as_array)
        .ok_or_else(|| RpcError::invalid("want must list namespace versions"))?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let granted: Vec<String> =
        CAPABILITIES.iter().filter(|capability| wanted.contains(capability)).map(|capability| capability.to_string()).collect();
    if granted.is_empty() {
        return Err(RpcError::new("update_required", "no namespace version in common with this runtime"));
    }
    Ok(granted)
}

pub const IDEMPOTENCY_TTL: Duration = Duration::from_secs(10 * 60);
const IDEMPOTENCY_MAX: usize = 4096;

/// Results of mutating calls by `(attachment, clientRequestId)`, kept for at
/// least ten minutes so a resend after a reconnect returns the first result
/// instead of writing or prompting twice.
/// A stored outcome: the result, or an error's code and message.
type Outcome = Result<Value, (String, String)>;

#[derive(Default)]
pub struct IdempotencyCache {
    entries: HashMap<(String, String), (Instant, Outcome)>,
}

impl IdempotencyCache {
    pub fn get(&mut self, scope: &str, request_id: &str, now: Instant) -> Option<Result<Value, RpcError>> {
        self.evict(now);
        self.entries.get(&(scope.to_string(), request_id.to_string())).map(|(_, result)| match result {
            Ok(value) => Ok(value.clone()),
            Err((code, message)) => Err(RpcError { code: leak_code(code), message: message.clone() }),
        })
    }

    pub fn put(&mut self, scope: &str, request_id: &str, result: &Result<Value, RpcError>, now: Instant) {
        self.evict(now);
        if self.entries.len() >= IDEMPOTENCY_MAX {
            // Drop the oldest; the TTL is a floor only while there is room.
            if let Some(oldest) = self.entries.iter().min_by_key(|(_, (at, _))| *at).map(|(key, _)| key.clone()) {
                self.entries.remove(&oldest);
            }
        }
        let stored = match result {
            Ok(value) => Ok(value.clone()),
            Err(error) => Err((error.code.to_string(), error.message.clone())),
        };
        self.entries.insert((scope.to_string(), request_id.to_string()), (now, stored));
    }

    fn evict(&mut self, now: Instant) {
        self.entries.retain(|_, (at, _)| now.duration_since(*at) < IDEMPOTENCY_TTL);
    }
}

/// Error codes are a closed set; map a stored one back to its static name.
fn leak_code(code: &str) -> &'static str {
    const CODES: &[&str] = &[
        "invalid_params",
        "not_found",
        "forbidden",
        "internal",
        "conflict",
        "path_forbidden",
        "capability_not_granted",
        "method_not_found",
        "cursor_expired",
        "update_required",
        "unavailable",
        "hello_required",
        "too_large",
        "git_failed",
        "not_controller",
        "backpressure",
    ];
    CODES.iter().find(|known| **known == code).copied().unwrap_or("internal")
}

pub fn valid_client_request_id(value: &str) -> bool {
    (8..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Typed close reasons (terminalx-saas `packages/shared/src/runtimeCloseReason.ts`),
/// plus the older relay codes a client still meets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseAction {
    /// 4100: re-check readiness via `open`, retry with backoff. Never replace the runtime.
    RecheckReadiness,
    /// 4101: the attachment belongs to an older generation; `open` again for a new one.
    Reattach,
    /// 4102: fetch a new ticket; keep the relay credential.
    RefreshTicket,
    /// 4103: stop and prompt for an app update.
    UpdateRequired,
    /// 4104, 4408, 4503, network drops: reconnect with the same credential.
    Reconnect,
    /// 4401: the relay credential itself was refused; it is gone.
    CredentialRejected,
    /// 4409: ask the director for the right cell.
    Reassign,
}

pub fn close_action(code: u16) -> CloseAction {
    match code {
        4100 | 4404 => CloseAction::RecheckReadiness,
        4101 => CloseAction::Reattach,
        4102 => CloseAction::RefreshTicket,
        4103 => CloseAction::UpdateRequired,
        4401 => CloseAction::CredentialRejected,
        4409 => CloseAction::Reassign,
        _ => CloseAction::Reconnect,
    }
}

/// Long opaque tokens (credentials, tickets) are cut from logged errors.
pub fn redact(message: &str) -> String {
    static TOKEN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| regex::Regex::new(r"[A-Za-z0-9_\-.]{32,}").expect("valid pattern")).replace_all(message, "[redacted]").into_owned()
}

pub const BACKOFF_FLOOR: Duration = Duration::from_millis(250);
pub const BACKOFF_CEILING: Duration = Duration::from_secs(10);

/// Exponential from 250 ms to 10 s with equal jitter: half the step is fixed,
/// half is `jitter` (0..1), so clients that dropped together spread out.
pub fn backoff(attempt: u32, jitter: f64) -> Duration {
    let step = BACKOFF_FLOOR.as_millis() as u64 * 2u64.saturating_pow(attempt.min(16));
    let step = step.min(BACKOFF_CEILING.as_millis() as u64);
    let half = step / 2;
    Duration::from_millis(half + (half as f64 * jitter.clamp(0.0, 1.0)) as u64).max(BACKOFF_FLOOR)
}

/// How much a caller may cost: reading a cache never connects, and only an
/// interactive action may resume a suspended workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Activation {
    CacheOnly,
    Sync,
    Connect,
    Wake,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_method_names_a_served_capability_and_mutations_are_idempotent() {
        for method in METHODS {
            assert!(CAPABILITIES.contains(&method.capability), "{}", method.name);
            assert!(method.name.starts_with(method.capability.split('/').next().unwrap()));
        }
        for name in ["pty.create", "fs.write", "git.commit", "session.send", "session.create"] {
            assert!(find_method(name).unwrap().idempotent, "{name}");
        }
        assert!(find_method("runtime.exec").is_none());
        assert!(find_method("invoke").is_none());
    }

    #[test]
    fn negotiation_grants_the_intersection_and_refuses_no_overlap() {
        let granted = negotiate(&json!({"protocol": PROTOCOL, "want": ["pty/1", "fs/2", "session/1"]})).unwrap();
        assert_eq!(granted, vec!["pty/1", "session/1"]);
        assert_eq!(negotiate(&json!({"protocol": PROTOCOL, "want": ["pty/9"]})).unwrap_err().code, "update_required");
        assert_eq!(negotiate(&json!({"protocol": "terminalx-workspace-rpc/2", "want": ["pty/1"]})).unwrap_err().code, "update_required");
    }

    #[test]
    fn idempotency_replays_results_and_errors_until_they_expire() {
        let mut cache = IdempotencyCache::default();
        let start = Instant::now();
        cache.put("device-a", "request-0001", &Ok(json!({"ptyId": "p1"})), start);
        cache.put("device-a", "request-0002", &Err(RpcError::new("conflict", "etag")), start);
        assert_eq!(cache.get("device-a", "request-0001", start).unwrap().unwrap(), json!({"ptyId": "p1"}));
        assert_eq!(cache.get("device-a", "request-0002", start).unwrap().unwrap_err().code, "conflict");
        assert!(cache.get("device-b", "request-0001", start).is_none(), "scoped per attachment");
        assert!(cache.get("device-a", "request-0001", start + IDEMPOTENCY_TTL).is_none());
    }

    #[test]
    fn close_codes_map_to_recovery_and_a_socket_failure_never_replaces_the_runtime() {
        assert_eq!(close_action(4100), CloseAction::RecheckReadiness);
        assert_eq!(close_action(4101), CloseAction::Reattach);
        assert_eq!(close_action(4102), CloseAction::RefreshTicket);
        assert_eq!(close_action(4103), CloseAction::UpdateRequired);
        assert_eq!(close_action(4104), CloseAction::Reconnect);
        assert_eq!(close_action(1006), CloseAction::Reconnect);
        assert_eq!(close_action(4401), CloseAction::CredentialRejected);
    }

    #[test]
    fn backoff_is_jittered_between_250ms_and_10s() {
        assert_eq!(backoff(0, 0.0), BACKOFF_FLOOR);
        assert_eq!(backoff(0, 1.0), Duration::from_millis(250));
        assert_eq!(backoff(3, 1.0), Duration::from_secs(2));
        assert_eq!(backoff(30, 1.0), BACKOFF_CEILING);
        assert_eq!(backoff(30, 0.0), BACKOFF_CEILING / 2);
    }

    #[test]
    fn activation_levels_are_ordered() {
        assert!(Activation::CacheOnly < Activation::Sync);
        assert!(Activation::Sync < Activation::Connect);
        assert!(Activation::Connect < Activation::Wake);
    }
}
