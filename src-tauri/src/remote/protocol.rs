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

/// Namespace versions this build speaks, in preference order. A newer
/// version adds methods or fields to its namespace; it never changes what the
/// older one means, so a client that asks only for `session/1` is served
/// exactly as before.
/// - `session/2`: `session.update`, `session.addTab`, `session.delete` and
///   the `session.sessions` notification.
/// - `pty/2`: `pty.create` takes a `sessionId`, and `pty.list` returns it.
/// - `agents/1`: `runtime.agents`, the installed agents with their models,
///   efforts and modes.
/// - `collab/1` (PRO-30): presence, notes, tab leases and `collab.state`.
/// - `agent-pty/1` (PRO-86): the terminal an agent tab's CLI runs in is
///   reached through the `pty.*` methods as `tab:<tabId>`. It adds no method.
/// - `composer/1` (PRO-22): `session.commands`, the slash commands an agent
///   tab's composer offers its reader.
/// - `composer/2`: `session.files`, the session's files by name, for the
///   composer's `@` list.
/// - `composer/3`: `session.attach`, an image uploaded in parts for a
///   message that then names it (`images: [{ id }]`, in a mailbox `send` or
///   the live `session.send`).
/// - `ports/1` (PRO-28): streams to TCP ports on the workspace's loopback,
///   for private previews (`remote/ports.rs`, docs/CLOUD-PREVIEWS.md).
pub const CAPABILITIES: [&str; 15] =
    ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "lifecycle/1", "agents/1", "collab/1", "agent-pty/1", "composer/1", "composer/2", "composer/3", "ports/1"];

/// The namespace that lets a connection address an agent tab's own terminal
/// (spelled out in [`CAPABILITIES`], which the client's tests read).
pub const AGENT_PTY: &str = "agent-pty/1";

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
    // PRO-22: agent tabs. Sends, steers, stops and permission decisions
    // come through the API mailbox, never as live calls (docs/CLOUD-AGENT-TABS.md).
    method("session.tabs", "session/1", Participate, false),
    method("session.configure", "session/1", Manage, true),
    method("session.markRead", "session/1", Participate, false),
    method("session.nudge", "session/1", Participate, false),
    // The workspace content key travels only over the E2EE channel. It
    // opens every tab's checkpoint: a participant gets it only while the
    // workspace is shared with them (PRO-30; checked per call against their role).
    method("keys.get", "keys/1", Participate, false),
    method("keys.rotate", "keys/1", Manage, true),
    method("session.unsubscribe", "session/1", Participate, false),
    // CS-12: the session index, through the same `session_ops` as local.
    // Participants never change it.
    method("session.update", "session/2", Manage, true),
    method("session.addTab", "session/2", Manage, true),
    method("session.delete", "session/2", Manage, true),
    // What a new session or tab may run; read-only, like `harness::offered`.
    method("runtime.agents", "agents/1", Participate, false),
    // What the composer of an agent tab offers: read-only, and never more
    // than the caller may send (PRO-88).
    method("session.commands", "composer/1", Participate, false),
    method("session.files", "composer/2", Participate, false),
    method("session.attach", "composer/3", Participate, true),
    method("pty.create", "pty/1", Manage, true),
    method("pty.list", "pty/1", Participate, false),
    // Input and size belong to the terminal's controller; `pty.control`
    // takes them over explicitly. A participant may only if the workspace is
    // shared with them as a driver (PRO-30; checked per call against their role).
    method("pty.write", "pty/1", Participate, false),
    method("pty.resize", "pty/1", Participate, false),
    method("pty.control", "pty/1", Participate, false),
    method("pty.kill", "pty/1", Manage, false),
    method("pty.attach", "pty/1", Participate, false),
    method("pty.detach", "pty/1", Participate, false),
    method("fs.list", "fs/1", Participate, false),
    method("fs.stat", "fs/1", Participate, false),
    method("fs.read", "fs/1", Participate, false),
    method("fs.write", "fs/1", Manage, true),
    // PRO-24: large writes are staged part by part, then committed by fs.write.
    method("fs.writePart", "fs/1", Manage, true),
    method("fs.search", "fs/1", Participate, false),
    method("fs.cancel", "fs/1", Participate, false),
    method("fs.rename", "fs/1", Manage, true),
    method("fs.delete", "fs/1", Manage, true),
    method("fs.mkdir", "fs/1", Manage, true),
    method("fs.watch", "fs/1", Participate, false),
    method("fs.unwatch", "fs/1", Participate, false),
    // PRO-27: every git call names its repository (`repo`) unless the
    // workspace has exactly one (`remote/git.rs`).
    method("git.repositories", "git/1", Participate, false),
    method("git.status", "git/1", Participate, false),
    method("git.diff", "git/1", Participate, false),
    method("git.workingChanges", "git/1", Participate, false),
    method("git.changesBetween", "git/1", Participate, false),
    method("git.fileContents", "git/1", Participate, false),
    method("git.log", "git/1", Participate, false),
    method("git.branches", "git/1", Participate, false),
    method("git.prs", "git/1", Participate, false),
    method("git.checkout", "git/1", Manage, true),
    // The author comes from the client; credentials never do.
    method("git.commit", "git/1", Manage, true),
    method("git.stage", "git/1", Manage, true),
    method("git.unstage", "git/1", Manage, true),
    method("git.fetch", "git/1", Manage, true),
    method("git.push", "git/1", Manage, true),
    method("git.pull", "git/1", Manage, true),
    method("git.prCreate", "git/1", Manage, true),
    method("git.prReady", "git/1", Manage, true),
    method("git.prMerge", "git/1", Manage, true),
    // PRO-34 facts before archive or delete (saas contract 10.2): read-only.
    method("lifecycle.dispositionFacts", "lifecycle/1", Participate, false),
    // PRO-33: free memory and disk of the machine; read-only. A runtime
    // from before it answers `method_not_found`.
    method("lifecycle.resources", "lifecycle/1", Participate, false),
    // PRO-30 (saas contract §21.5): presence, notes and the tab driver
    // lease. Every call also needs the caller to have a role (not `none`).
    method("collab.state", "collab/1", Participate, false),
    method("presence.update", "collab/1", Participate, false),
    method("notes.list", "collab/1", Participate, false),
    method("notes.post", "collab/1", Participate, true),
    method("lease.acquire", "collab/1", Participate, false),
    method("lease.release", "collab/1", Participate, false),
    method("lease.takeOver", "collab/1", Participate, false),
    // PRO-28: a stream to a port is input to whatever listens there, so a
    // participant needs driver access, as for typing into a terminal
    // (checked per call against their role). Listing is reading.
    method("ports.list", "ports/1", Participate, false),
    method("ports.open", "ports/1", Participate, false),
    method("ports.write", "ports/1", Participate, false),
    method("ports.ack", "ports/1", Participate, false),
    method("ports.close", "ports/1", Participate, false),
];

/// Method prefixes of a namespace: `collab/1` spans presence, notes and
/// leases.
pub fn namespace_prefixes(capability: &str) -> &'static [&'static str] {
    match capability {
        "collab/1" => &["collab.", "presence.", "notes.", "lease."],
        "pty/1" | "pty/2" => &["pty."],
        "fs/1" => &["fs."],
        "git/1" => &["git."],
        "session/1" | "session/2" => &["session."],
        // `agents/1` describes the runtime's agents: `runtime.agents`.
        "agents/1" => &["runtime.agents"],
        "keys/1" => &["keys."],
        "lifecycle/1" => &["lifecycle."],
        // `composer/N` adds what an agent tab's composer asks of its session.
        "composer/1" => &["session.commands"],
        "composer/2" => &["session.files"],
        "composer/3" => &["session.attach"],
        "ports/1" => &["ports."],
        _ => &[],
    }
}

pub fn find_method(name: &str) -> Option<&'static Method> {
    METHODS.iter().find(|method| method.name == name)
}

/// The error codes of the contract. Clients branch on `code`, never on text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: &'static str,
    pub message: String,
    /// Structured detail for the client (`lease_held` carries the lease).
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
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
    let mut body = json!({ "code": error.code, "message": error.message });
    if let Some(data) = &error.data {
        body["data"] = data.clone();
    }
    json!({ "id": id, "ok": false, "error": body })
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
            Err((code, message)) => Err(RpcError::new(leak_code(code), message.clone())),
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
        "ambiguous_repository",
        "auth_failed",
        "outcome_unknown",
        "unpushed",
        "lease_held",
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
            assert!(namespace_prefixes(method.capability).iter().any(|prefix| method.name.starts_with(prefix)), "{}", method.name);
        }
        for name in ["session.update", "session.addTab", "session.delete"] {
            let method = find_method(name).unwrap();
            assert!(method.idempotent, "{name}");
            assert_eq!((method.capability, method.authority), ("session/2", Manage), "{name}");
        }
        for name in ["pty.create", "fs.write", "git.commit", "session.send", "session.create", "notes.post"] {
            assert!(find_method(name).unwrap().idempotent, "{name}");
        }
        assert!(find_method("runtime.exec").is_none());
        assert!(find_method("invoke").is_none());
    }

    #[test]
    fn negotiation_grants_the_intersection_and_refuses_no_overlap() {
        let granted = negotiate(&json!({"protocol": PROTOCOL, "want": ["pty/1", "fs/2", "session/1"]})).unwrap();
        assert_eq!(granted, vec!["pty/1", "session/1"]);
        // A session/1-only client is not handed the additions.
        let old = negotiate(&json!({"protocol": PROTOCOL, "want": ["pty/1", "fs/1", "git/1", "session/1", "keys/1", "lifecycle/1"]})).unwrap();
        assert!(!old.iter().any(|capability| ["pty/2", "session/2", "agents/1", AGENT_PTY].contains(&capability.as_str())));
        let new = negotiate(&json!({"protocol": PROTOCOL, "want": CAPABILITIES})).unwrap();
        assert_eq!(new, CAPABILITIES.to_vec());
        assert!(CAPABILITIES.contains(&AGENT_PTY));
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
