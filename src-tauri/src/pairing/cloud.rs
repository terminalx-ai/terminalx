use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::json;

use crate::account::AccountContext;

use super::diagnostics::Category;
use super::model::{
    AccountPairingEnvelope, AccountPairingGrant, AccountPairingRevocation, HostBindingPayload,
};

/// Which grants a host poll lists. Without `requestedScope` the account
/// service lists only `mobile` ones, which is all a window before PRO-349
/// understands; `runtime` ones are for the machine host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantScope {
    Mobile,
    Runtime,
}

impl GrantScope {
    /// The query that follows `bindingGeneration`. Mobile sends none, as before.
    fn query(self) -> &'static str {
        match self {
            Self::Mobile => "",
            Self::Runtime => "&requestedScope=runtime",
        }
    }
}

const RELAY_DIRECTOR_URL: &str = "https://relay.terminalx.ai";
/// Debug builds only: the relay director of a local or staging stack, e.g. the
/// one terminalx-saas starts beside its API. The director runs on its own
/// origin, so it cannot be derived from the dev API base URL.
pub const DEV_RELAY_DIRECTOR_URL_ENV: &str = "TERMINALX_DEV_RELAY_DIRECTOR_URL";

#[derive(Debug)]
pub struct CloudHttpError(pub u16);

impl std::fmt::Display for CloudHttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "cloud service returned HTTP {}", self.0)
    }
}

impl std::error::Error for CloudHttpError {}

/// A refused request's `Retry-After`, in the whole seconds the account
/// service sends with a 429. It sits beneath the [`CloudHttpError`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryAfter(pub Duration);

impl std::fmt::Display for RetryAfter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "retry after {} s", self.0.as_secs())
    }
}

impl std::error::Error for RetryAfter {}

/// The account service's own name for why it refused a request, from the
/// `{"error": "…"}` it answers with (`host_binding_inactive`, …). It sits
/// beneath the [`CloudHttpError`], beside any [`RetryAfter`]: a refused host
/// registration is recovered by what it says (PRO-598).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudRefusal(pub String);

impl std::fmt::Display for CloudRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CloudRefusal {}

/// The refusal code of `error`, when the account service named one.
pub fn refusal_code(error: &anyhow::Error) -> Option<&str> {
    error.downcast_ref::<CloudRefusal>().map(|refusal| refusal.0.as_str())
}

/// The `error` code in a refusal's body. Only a short snake_case word is
/// taken: the body is the service's, and the code is shown and logged.
fn refusal_in(body: &[u8]) -> Option<CloudRefusal> {
    let body: serde_json::Value = serde_json::from_slice(body).ok()?;
    let code = body.get("error")?.as_str()?;
    let word = !code.is_empty()
        && code.len() <= 64
        && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    word.then(|| CloudRefusal(code.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayAuthorization {
    pub relay_token: String,
    pub expires_at: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayAssignment {
    pub v: u8,
    pub cell_url: String,
    pub assignment_epoch: u64,
    pub lease: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantList {
    requests: Vec<AccountPairingGrant>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevocationList {
    revocations: Vec<AccountPairingRevocation>,
}

pub fn register_host(context: &AccountContext, payload: &HostBindingPayload) -> Result<()> {
    register_host_at(&crate::account::api_base_url(), context, payload)
}

pub fn register_host_at(base: &str, context: &AccountContext, payload: &HostBindingPayload) -> Result<()> {
    request_unit(
        base,
        "/v1/desktop/host-account-bindings",
        "POST",
        Some(serde_json::to_value(payload)?),
        &context.access_token,
    )
}

pub(super) const GUEST_ASSERTION_PURPOSE: &str = "session-share-guest";
pub(super) const MAX_GUEST_ASSERTION_LEN: usize = 8192;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct GuestAssertionAudience {
    pub session_id: String,
    pub link_id: String,
    pub host_public_key_b64: String,
    pub transcript_hash_b64: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct GuestAssertion {
    pub assertion: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug)]
pub(super) struct VerifiedGuest {
    pub person: crate::local_sharing::Person,
    pub expires_at: i64,
}

/// Mint a short-lived, audience-bound guest identity assertion from the fixed
/// account API. The guest's master `access_token` is sent ONLY to the account
/// service here and NEVER transmitted to the peer share host.
pub(super) fn mint_guest_assertion(
    context: &AccountContext,
    audience: &GuestAssertionAudience,
) -> Result<GuestAssertion> {
    mint_guest_assertion_at(&crate::account::api_base_url(), context, audience)
}

fn mint_guest_assertion_at(
    base: &str,
    context: &AccountContext,
    audience: &GuestAssertionAudience,
) -> Result<GuestAssertion> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        assertion: String,
        expires_at: i64,
    }
    let response: Response = request_json(
        base,
        "/v1/desktop/auth/share-assertion",
        "POST",
        Some(json!({
            "v": 1,
            "purpose": GUEST_ASSERTION_PURPOSE,
            "sessionId": audience.session_id,
            "linkId": audience.link_id,
            "hostPublicKeyB64": audience.host_public_key_b64,
            "transcriptHashB64": audience.transcript_hash_b64,
        })),
        &context.access_token,
    )?;
    let assertion = response.assertion.trim().to_string();
    if assertion.is_empty() || assertion.len() > MAX_GUEST_ASSERTION_LEN {
        return Err(anyhow!("Account API returned an invalid guest assertion."));
    }
    if assertion == context.access_token {
        return Err(anyhow!("Refusing guest assertion that mirrors master access token."));
    }
    let now = chrono::Utc::now().timestamp_millis();
    if response.expires_at <= now {
        return Err(anyhow!("Account API returned an already-expired guest assertion."));
    }
    Ok(GuestAssertion {
        assertion,
        expires_at: response.expires_at,
    })
}

/// Verify a guest's short-lived, audience-bound assertion against the fixed
/// account API using the host's own account credentials. Never uses a guest
/// credential as an API `Authorization` bearer token.
pub(super) fn verify_guest_assertion(
    host_context: &AccountContext,
    assertion: &str,
    expected: &GuestAssertionAudience,
) -> Result<VerifiedGuest> {
    verify_guest_assertion_at(&crate::account::api_base_url(), host_context, assertion, expected)
}

fn verify_guest_assertion_at(
    base: &str,
    host_context: &AccountContext,
    assertion: &str,
    expected: &GuestAssertionAudience,
) -> Result<VerifiedGuest> {
    if assertion.is_empty() || assertion.len() > MAX_GUEST_ASSERTION_LEN {
        return Err(anyhow!("Invalid guest assertion."));
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity {
        user_id: String,
        email: String,
        display_name: Option<String>,
        #[serde(default)]
        email_verified: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Organization {
        org_id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        cloud: Identity,
        #[serde(default)]
        organizations: Vec<Organization>,
        #[serde(default)]
        expires_at: Option<i64>,
        #[serde(default)]
        purpose: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        link_id: Option<String>,
        #[serde(default)]
        host_public_key_b64: Option<String>,
        #[serde(default)]
        transcript_hash_b64: Option<String>,
    }
    let response: Response = request_json(
        base,
        "/v1/desktop/auth/share-assertion/verify",
        "POST",
        Some(json!({
            "v": 1,
            "purpose": GUEST_ASSERTION_PURPOSE,
            "assertion": assertion,
            "sessionId": expected.session_id,
            "linkId": expected.link_id,
            "hostPublicKeyB64": expected.host_public_key_b64,
            "transcriptHashB64": expected.transcript_hash_b64,
        })),
        &host_context.access_token,
    )?;
    if response.purpose.as_deref().is_some_and(|p| p != GUEST_ASSERTION_PURPOSE)
        || response.session_id.as_deref().is_some_and(|s| s != expected.session_id)
        || response.link_id.as_deref().is_some_and(|l| l != expected.link_id)
        || response.host_public_key_b64.as_deref().is_some_and(|k| k != expected.host_public_key_b64)
        || response.transcript_hash_b64.as_deref().is_some_and(|t| t != expected.transcript_hash_b64)
    {
        return Err(anyhow!("Guest assertion audience mismatch."));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let expires_at = match response.expires_at {
        Some(ts) if ts <= now => return Err(anyhow!("Guest assertion has expired.")),
        Some(ts) => ts.min(now + crate::local_sharing::IDENTITY_MS),
        None => now + crate::local_sharing::IDENTITY_MS,
    };
    let identity = response.cloud;
    if identity.user_id.trim().is_empty() || identity.email.trim().is_empty() {
        return Err(anyhow!("Account API returned no verified identity."));
    }
    Ok(VerifiedGuest {
        person: crate::local_sharing::Person {
            user_id: identity.user_id,
            display_name: identity
                .display_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| identity.email.clone()),
            email: identity.email,
            email_verified: identity.email_verified,
            organization_ids: response
                .organizations
                .into_iter()
                .map(|o| o.org_id)
                .collect(),
        },
        expires_at,
    })
}

/// Tell the account service this Mac is reachable over Relay. The service
/// accepts only "live" or "exited" and treats a "live" as current for 90 s,
/// so the caller sends one only while the control channel is answering;
/// otherwise the binding lapses to "unverifiable" on its own.
pub fn heartbeat(base: &str, context: &AccountContext, host_id: &str, generation: u64, capabilities: &[String]) -> Result<()> {
    request_unit(
        base,
        &format!("/v1/desktop/host-account-bindings/{host_id}/heartbeat"),
        "POST",
        Some(json!({
            "bindingGeneration": generation,
            "reachability": "live",
            "capabilities": capabilities
        })),
        &context.access_token,
    )
}

pub fn unbind(context: &AccountContext, host_id: &str, generation: u64) -> Result<()> {
    unbind_at(&crate::account::api_base_url(), context, host_id, generation)
}

pub fn unbind_at(base: &str, context: &AccountContext, host_id: &str, generation: u64) -> Result<()> {
    request_unit(
        base,
        &format!("/v1/desktop/host-account-bindings/{host_id}"),
        "DELETE",
        Some(json!({ "bindingGeneration": generation, "reason": "host-sign-out" })),
        &context.access_token,
    )
}

pub fn pending_grants(
    base: &str,
    context: &AccountContext,
    host_id: &str,
    generation: u64,
    scope: GrantScope,
) -> Result<Vec<AccountPairingGrant>> {
    let query = scope.query();
    request_json::<GrantList>(
        base,
        &format!("/v1/desktop/host-account-bindings/{host_id}/pairing-grant-requests?bindingGeneration={generation}{query}"),
        "GET",
        None,
        &context.access_token,
    )
    .map(|response| response.requests)
}

pub fn publish_envelope(
    context: &AccountContext,
    host_id: &str,
    request_id: &str,
    envelope: &AccountPairingEnvelope,
) -> Result<()> {
    request_unit(
        &crate::account::api_base_url(),
        &format!("/v1/desktop/host-account-bindings/{host_id}/pairing-grant-requests/{request_id}/envelope"),
        "PUT",
        Some(serde_json::to_value(envelope)?),
        &context.access_token,
    )
}

pub fn reject_grant(
    context: &AccountContext,
    host_id: &str,
    request_id: &str,
    generation: u64,
) -> Result<()> {
    request_unit(
        &crate::account::api_base_url(),
        &format!("/v1/desktop/host-account-bindings/{host_id}/pairing-grant-requests/{request_id}/reject"),
        "POST",
        Some(json!({ "bindingGeneration": generation, "reason": "mint-failed" })),
        &context.access_token,
    )
}

pub fn pending_revocations(
    base: &str,
    context: &AccountContext,
    host_id: &str,
    generation: u64,
    scope: GrantScope,
) -> Result<Vec<AccountPairingRevocation>> {
    let query = scope.query();
    request_json::<RevocationList>(
        base,
        &format!("/v1/desktop/host-account-bindings/{host_id}/revocations?bindingGeneration={generation}{query}"),
        "GET",
        None,
        &context.access_token,
    )
    .map(|response| response.revocations)
}

/// This Mac removed the computer allowed through `request_id`: the grant ends
/// and its envelope is deleted. No revocation is queued for this host, which
/// has already applied it. Repeating it is harmless (`idempotent: true`).
pub fn revoke_host_grant(
    base: &str,
    context: &AccountContext,
    host_id: &str,
    request_id: &str,
    generation: u64,
) -> Result<()> {
    request_unit(
        base,
        &format!("/v1/desktop/host-account-bindings/{host_id}/pairing-grant-requests/{request_id}/revoke"),
        "POST",
        Some(json!({ "bindingGeneration": generation, "reason": "host-removed" })),
        &context.access_token,
    )
}

pub fn acknowledge_revocation(
    base: &str,
    context: &AccountContext,
    host_id: &str,
    revocation_id: &str,
    generation: u64,
) -> Result<()> {
    request_unit(
        base,
        &format!(
            "/v1/desktop/host-account-bindings/{host_id}/revocations/{revocation_id}/acknowledge"
        ),
        "POST",
        Some(json!({ "bindingGeneration": generation })),
        &context.access_token,
    )
}

pub fn relay_authorization(
    context: &AccountContext,
    relay_host_id: &str,
    host_public_key_b64: &str,
) -> Result<RelayAuthorization> {
    relay_authorization_at(
        &crate::account::api_base_url(),
        context,
        relay_host_id,
        host_public_key_b64,
    )
}

fn relay_authorization_at(
    base: &str,
    context: &AccountContext,
    relay_host_id: &str,
    host_public_key_b64: &str,
) -> Result<RelayAuthorization> {
    request_json(
        base,
        "/v1/desktop/auth/relay-token",
        "POST",
        Some(json!({
            "relayHostId": relay_host_id,
            "hostPublicKeyB64": host_public_key_b64,
        })),
        &context.access_token,
    )
}

/// The relay director origin, or `None` when Relay is off. A release build
/// always uses production. A debug build uses [`DEV_RELAY_DIRECTOR_URL_ENV`]
/// and never production, so a Dev app pointed at a local stack does not
/// contact the production relay.
pub fn relay_director_url() -> Option<String> {
    relay_director_url_for(
        cfg!(debug_assertions),
        std::env::var(DEV_RELAY_DIRECTOR_URL_ENV).ok().as_deref(),
    )
}

fn relay_director_url_for(debug_build: bool, dev_value: Option<&str>) -> Option<String> {
    if !debug_build {
        return Some(RELAY_DIRECTOR_URL.to_string());
    }
    crate::account::dev_origin(true, DEV_RELAY_DIRECTOR_URL_ENV, dev_value)
}

pub fn relay_assignment(
    director_url: &str,
    authorization: &RelayAuthorization,
    relay_host_id: &str,
    reconnect: bool,
) -> Result<RelayAssignment> {
    relay_assignment_at(director_url, authorization, relay_host_id, reconnect)
}

fn relay_assignment_at(
    base: &str,
    authorization: &RelayAuthorization,
    relay_host_id: &str,
    reconnect: bool,
) -> Result<RelayAssignment> {
    if !allowed_https_origin(base) {
        return Err(anyhow!(Category::Protocol));
    }
    let mut body = json!({ "v": 1, "relayHostId": relay_host_id });
    if reconnect {
        body["reconnect"] = json!(true);
    }
    let assignment: RelayAssignment = request_json(
        base,
        "/v1/assign",
        "POST",
        Some(body),
        &authorization.relay_token,
    )?;
    if assignment.v != 1
        || assignment.lease.is_empty()
        || !allowed_https_origin(&assignment.cell_url)
    {
        return Err(anyhow!(Category::Protocol));
    }
    Ok(assignment)
}

fn request_unit(
    base: &str,
    path: &str,
    method: &str,
    body: Option<serde_json::Value>,
    token: &str,
) -> Result<()> {
    send(base, path, method, body, token).map(crate::account::discard_body)
}

fn request_json<T: DeserializeOwned>(
    base: &str,
    path: &str,
    method: &str,
    body: Option<serde_json::Value>,
    token: &str,
) -> Result<T> {
    let response = send(base, path, method, body, token)?;
    response.into_json().context(Category::Protocol)
}

fn send(
    base: &str,
    path: &str,
    method: &str,
    body: Option<serde_json::Value>,
    token: &str,
) -> Result<ureq::Response> {
    if token.is_empty() {
        return Err(anyhow!(Category::Authentication));
    }
    let request = crate::account::cloud_agent()
        .request(method, &format!("{base}{path}"))
        .set("authorization", &format!("Bearer {token}"))
        .set("content-type", "application/json");
    let response = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    match response {
        Ok(response) => Ok(response),
        Err(ureq::Error::Status(status, response)) => {
            let retry_after = retry_after(&response);
            // Read as `discard_body` drains it, so the connection is kept.
            let mut body = Vec::new();
            let _ = std::io::Read::read_to_end(&mut std::io::Read::take(response.into_reader(), 64 * 1024), &mut body);
            let refusal = refusal_in(&body);
            Err(match (retry_after, refusal) {
                (Some(after), Some(refusal)) => anyhow::Error::new(after).context(refusal).context(CloudHttpError(status)),
                (Some(after), None) => anyhow::Error::new(after).context(CloudHttpError(status)),
                (None, Some(refusal)) => anyhow::Error::new(refusal).context(CloudHttpError(status)),
                (None, None) => CloudHttpError(status).into(),
            })
        }
        Err(ureq::Error::Transport(error)) => Err(anyhow!(error).context("cloud request failed")),
    }
}

/// `Retry-After` as delta seconds, the only form the account service sends.
/// An HTTP date is ignored, and the caller's own backoff applies.
fn retry_after(response: &ureq::Response) -> Option<RetryAfter> {
    let seconds = response.header("retry-after")?.trim().parse::<u64>().ok()?;
    Some(RetryAfter(Duration::from_secs(seconds)))
}

pub(super) fn allowed_https_origin(value: &str) -> bool {
    crate::remote::host::valid_relay_origin(value)
}

/// A loopback HTTP/1.1 server that keeps connections alive, as the account
/// service does, and counts them.
#[cfg(test)]
pub(super) mod fixture {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    #[derive(Clone, Debug)]
    pub struct Recorded {
        pub method: String,
        pub path: String,
        pub authorization: String,
        pub body: Option<serde_json::Value>,
        pub at: Instant,
    }

    pub struct Reply {
        pub status: u16,
        pub retry_after: Option<u64>,
        pub body: String,
    }

    impl Reply {
        pub fn ok(body: &str) -> Self {
            Self { status: 200, retry_after: None, body: body.into() }
        }
    }

    type Responder = dyn Fn(&Recorded) -> Reply + Send + Sync;

    pub struct KeepAliveServer {
        pub base: String,
        requests: Arc<Mutex<Vec<Recorded>>>,
        connections: Arc<AtomicUsize>,
        stopped: Arc<AtomicBool>,
    }

    impl KeepAliveServer {
        pub fn start(respond: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let connections = Arc::new(AtomicUsize::new(0));
            let stopped = Arc::new(AtomicBool::new(false));
            let respond: Arc<Responder> = Arc::new(respond);
            {
                let (requests, connections, stopped) = (requests.clone(), connections.clone(), stopped.clone());
                std::thread::spawn(move || {
                    for stream in listener.incoming() {
                        if stopped.load(Ordering::SeqCst) {
                            return;
                        }
                        let Ok(stream) = stream else { continue };
                        connections.fetch_add(1, Ordering::SeqCst);
                        let (requests, respond) = (requests.clone(), respond.clone());
                        std::thread::spawn(move || serve(stream, &requests, &*respond));
                    }
                });
            }
            Self { base, requests, connections, stopped }
        }

        pub fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }

        pub fn connections(&self) -> usize {
            self.connections.load(Ordering::SeqCst)
        }
    }

    impl Drop for KeepAliveServer {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
            // Wake the accept loop so it sees the flag.
            let _ = TcpStream::connect(self.base.trim_start_matches("http://"));
        }
    }

    fn serve(stream: TcpStream, requests: &Mutex<Vec<Recorded>>, respond: &Responder) {
        // The client's pool holds connections open; let the thread end anyway.
        stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let path = parts.next().unwrap_or_default().to_string();
            let (mut length, mut authorization) = (0, String::new());
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 {
                    return;
                }
                if header == "\r\n" {
                    break;
                }
                let lower = header.to_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
                if lower.starts_with("authorization:") {
                    authorization = header["authorization:".len()..].trim().to_string();
                }
            }
            let mut payload = vec![0; length];
            reader.read_exact(&mut payload).unwrap();
            let request = Recorded {
                method,
                path,
                authorization,
                body: (length > 0).then(|| serde_json::from_slice(&payload).unwrap()),
                at: Instant::now(),
            };
            let reply = respond(&request);
            requests.lock().unwrap().push(request);
            let retry_after = reply
                .retry_after
                .map(|seconds| format!("Retry-After: {seconds}\r\n"))
                .unwrap_or_default();
            let written = write!(
                writer,
                "HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{retry_after}Connection: keep-alive\r\n\r\n{}",
                reply.status,
                reply.body.len(),
                reply.body
            );
            if written.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_keeps_the_services_code_beside_its_status_and_retry_after() {
        use super::fixture::{KeepAliveServer, Reply};
        let server = KeepAliveServer::start(|request| match request.method.as_str() {
            "POST" => Reply { status: 409, retry_after: None, body: r#"{"error":"host_binding_inactive"}"#.into() },
            "DELETE" => Reply { status: 429, retry_after: Some(9), body: r#"{"error":"account_pairing_rate_limited","retryAfter":9}"#.into() },
            _ => Reply { status: 500, retry_after: None, body: r#"{"error":"<b>not a code</b>"}"#.into() },
        });
        let context = AccountContext {
            access_token: "synthetic-access-token".into(),
            user_id: "synthetic-user".into(),
            email: "fixture@example.invalid".into(),
            display_name: "Fixture".into(),
            profile_id: "synthetic-profile".into(),
            organization_id: "synthetic-org".into(),
            relay_entitled: true,
            generation: 1,
        };
        let payload = HostBindingPayload {
            host_id: "synthetic-host".into(),
            host_public_key_b64: "synthetic-key".into(),
            binding_generation: 2,
            display_name: "Fixture Mac".into(),
            platform: "darwin".into(),
            environment_kind: "native".into(),
            capabilities: vec![],
        };
        let refused = register_host_at(&server.base, &context, &payload).unwrap_err();
        assert_eq!(refused.downcast_ref::<CloudHttpError>().map(|status| status.0), Some(409));
        assert_eq!(refusal_code(&refused), Some("host_binding_inactive"));
        assert_eq!(format!("{refused:#}"), "cloud service returned HTTP 409: host_binding_inactive");

        let limited = unbind_at(&server.base, &context, "synthetic-host", 3).unwrap_err();
        assert_eq!(refusal_code(&limited), Some("account_pairing_rate_limited"));
        assert_eq!(limited.downcast_ref::<RetryAfter>(), Some(&RetryAfter(Duration::from_secs(9))));
        assert_eq!(limited.downcast_ref::<CloudHttpError>().map(|status| status.0), Some(429));

        let odd = pending_grants(&server.base, &context, "synthetic-host", 3, GrantScope::Mobile).unwrap_err();
        assert_eq!(refusal_code(&odd), None, "only a snake_case word is taken from the body");
        assert_eq!(server.connections(), 1, "a refusal's body is read, so the connection is kept");
    }

    #[test]
    fn requests_share_one_kept_alive_connection_and_keep_retry_after() {
        use super::fixture::{KeepAliveServer, Reply};
        let server = KeepAliveServer::start(|request| match request.path.as_str() {
            path if path.ends_with("/pairing-grant-requests?bindingGeneration=3") => Reply::ok(r#"{"requests":[]}"#),
            path if path.ends_with("/heartbeat") => Reply::ok(r#"{"binding":{"reachability":"live"}}"#),
            _ => Reply {
                status: 429,
                retry_after: Some(7),
                body: r#"{"error":"account_pairing_rate_limited","retryAfter":7}"#.into(),
            },
        });
        let context = AccountContext {
            access_token: "synthetic-access-token".into(),
            user_id: "synthetic-user".into(),
            email: "fixture@example.invalid".into(),
            display_name: "Fixture".into(),
            profile_id: "synthetic-profile".into(),
            organization_id: "synthetic-org".into(),
            relay_entitled: true,
            generation: 1,
        };
        assert!(pending_grants(&server.base, &context, "synthetic-host", 3, GrantScope::Mobile).unwrap().is_empty());
        heartbeat(&server.base, &context, "synthetic-host", 3, &[super::super::model::CAPABILITY.into()]).unwrap();
        let error = pending_revocations(&server.base, &context, "synthetic-host", 3, GrantScope::Mobile).unwrap_err();
        assert_eq!(error.downcast_ref::<CloudHttpError>().map(|error| error.0), Some(429));
        assert_eq!(error.downcast_ref::<RetryAfter>(), Some(&RetryAfter(Duration::from_secs(7))));
        assert_eq!(
            super::super::diagnostics::Failure::from_error(&error).category,
            Category::RateLimited
        );
        assert!(pending_grants(&server.base, &context, "synthetic-host", 3, GrantScope::Mobile).unwrap().is_empty());

        let requests = server.requests();
        assert_eq!(
            requests.iter().map(|request| request.method.as_str()).collect::<Vec<_>>(),
            ["GET", "POST", "GET", "GET"]
        );
        assert_eq!(server.connections(), 1, "every request, the refused one too, reuses one connection");
        assert!(requests.iter().all(|request| request.authorization == "Bearer synthetic-access-token"));
        assert_eq!(
            requests[1].body,
            Some(json!({ "bindingGeneration": 3, "reachability": "live", "capabilities": [super::super::model::CAPABILITY] }))
        );
    }

    #[test]
    fn runtime_grants_and_revocations_ask_for_their_scope_and_a_host_removal_names_the_grant() {
        use super::fixture::{KeepAliveServer, Reply};
        let server = KeepAliveServer::start(|request| {
            let path = request.path.as_str();
            if path.contains("/pairing-grant-requests?") {
                Reply::ok(r#"{"requests":[{"userId":"u","hostId":"h","clientInstallationId":"i","grantRequestId":"g","bindingGeneration":3,"installationGeneration":1,"clientEphemeralPublicKey":"k","associatedDataVersion":1,"associatedData":"a","requestedScope":"runtime","expiresAt":"2099-01-01T00:00:00Z","state":"pending"}]}"#)
            } else if path.contains("/revocations?") {
                Reply::ok(r#"{"revocations":[{"revocationId":"r","userId":"u","hostId":"h","clientInstallationId":"i","grantRequestId":"g","bindingGeneration":3}]}"#)
            } else {
                Reply::ok(r#"{"grant":{},"idempotent":false,"correlationId":"c"}"#)
            }
        });
        let context = AccountContext {
            access_token: "synthetic-access-token".into(),
            user_id: "u".into(),
            email: "fixture@example.invalid".into(),
            display_name: "Fixture".into(),
            profile_id: "synthetic-profile".into(),
            organization_id: "synthetic-org".into(),
            relay_entitled: true,
            generation: 1,
        };
        let grants = pending_grants(&server.base, &context, "h", 3, GrantScope::Runtime).unwrap();
        assert_eq!(grants[0].requested_scope, "runtime");
        let revocations = pending_revocations(&server.base, &context, "h", 3, GrantScope::Runtime).unwrap();
        assert_eq!(revocations[0].grant_request_id, "g");
        pending_grants(&server.base, &context, "h", 3, GrantScope::Mobile).unwrap();
        revoke_host_grant(&server.base, &context, "h", "g", 3).unwrap();
        let requests = server.requests();
        let paths: Vec<_> = requests.iter().map(|request| request.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "/v1/desktop/host-account-bindings/h/pairing-grant-requests?bindingGeneration=3&requestedScope=runtime",
                "/v1/desktop/host-account-bindings/h/revocations?bindingGeneration=3&requestedScope=runtime",
                "/v1/desktop/host-account-bindings/h/pairing-grant-requests?bindingGeneration=3",
                "/v1/desktop/host-account-bindings/h/pairing-grant-requests/g/revoke",
            ],
            "the mobile poll is unchanged"
        );
        assert_eq!(requests[3].method, "POST");
        assert_eq!(requests[3].body, Some(json!({ "bindingGeneration": 3, "reason": "host-removed" })));
    }

    #[test]
    fn release_builds_use_the_production_relay_director() {
        assert_eq!(relay_director_url_for(false, None).as_deref(), Some("https://relay.terminalx.ai"));
        assert_eq!(
            relay_director_url_for(false, Some("http://127.0.0.1:8471")).as_deref(),
            Some("https://relay.terminalx.ai"),
            "release builds ignore the dev override"
        );
    }

    #[test]
    fn debug_builds_never_contact_the_production_relay_director() {
        assert_eq!(relay_director_url_for(true, None), None, "Relay is off without a dev director");
        assert_eq!(
            relay_director_url_for(true, Some("http://127.0.0.1:8471")).as_deref(),
            Some("http://127.0.0.1:8471")
        );
        assert_eq!(
            relay_director_url_for(true, Some("https://relay.staging.example/")).as_deref(),
            Some("https://relay.staging.example")
        );
        assert_eq!(relay_director_url_for(true, Some("http://relay.example")), None, "plain HTTP only on loopback");
        assert_eq!(relay_director_url_for(true, Some("https://relay.example/v1")), None);
    }

    #[test]
    fn guest_assertions_are_audience_bound_and_never_echo_master_access_tokens() {
        use super::fixture::{KeepAliveServer, Reply};
        let future = chrono::Utc::now().timestamp_millis() + 60_000;
        let past = chrono::Utc::now().timestamp_millis() - 1_000;
        let step = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server_step = step.clone();
        let server = KeepAliveServer::start(move |request| {
            let i = server_step.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            match (request.path.as_str(), i) {
                ("/v1/desktop/auth/share-assertion", 0) => Reply::ok(
                    &json!({ "assertion": "scoped-guest-assertion-1", "expiresAt": future }).to_string(),
                ),
                ("/v1/desktop/auth/share-assertion", 1) => Reply::ok(
                    &json!({ "assertion": "guest-master-token", "expiresAt": future }).to_string(),
                ),
                ("/v1/desktop/auth/share-assertion", 2) => Reply::ok(
                    &json!({ "assertion": "expired-assertion", "expiresAt": past }).to_string(),
                ),
                ("/v1/desktop/auth/share-assertion/verify", 3) => Reply::ok(
                    &json!({
                        "cloud": { "userId": "verified-user", "email": "guest@example.com", "displayName": "Verified Guest", "emailVerified": true },
                        "organizations": [],
                        "purpose": GUEST_ASSERTION_PURPOSE,
                        "sessionId": "session-1",
                        "linkId": "link-1",
                        "hostPublicKeyB64": "host-pub-b64",
                        "transcriptHashB64": "transcript-hash-b64",
                        "expiresAt": future
                    }).to_string(),
                ),
                ("/v1/desktop/auth/share-assertion/verify", 4) => Reply::ok(
                    &json!({
                        "cloud": { "userId": "verified-user", "email": "guest@example.com", "displayName": "Verified Guest" },
                        "sessionId": "wrong-session",
                        "expiresAt": future
                    }).to_string(),
                ),
                ("/v1/desktop/auth/share-assertion/verify", 5) => Reply::ok(
                    &json!({
                        "cloud": { "userId": "verified-user", "email": "guest@example.com" },
                        "expiresAt": past
                    }).to_string(),
                ),
                _ => Reply { status: 401, retry_after: None, body: r#"{"error":"invalid_assertion"}"#.into() },
            }
        });
        let guest_ctx = AccountContext {
            access_token: "guest-master-token".into(),
            user_id: "verified-user".into(),
            email: "guest@example.com".into(),
            display_name: "Verified Guest".into(),
            profile_id: "p-guest".into(),
            organization_id: "org-guest".into(),
            relay_entitled: true,
            generation: 1,
        };
        let host_ctx = AccountContext {
            access_token: "host-master-token".into(),
            user_id: "host-user".into(),
            email: "host@example.com".into(),
            display_name: "Host".into(),
            profile_id: "p-host".into(),
            organization_id: "org-host".into(),
            relay_entitled: true,
            generation: 1,
        };
        let audience = GuestAssertionAudience {
            session_id: "session-1".into(),
            link_id: "link-1".into(),
            host_public_key_b64: "host-pub-b64".into(),
            transcript_hash_b64: "transcript-hash-b64".into(),
        };

        let minted = mint_guest_assertion_at(&server.base, &guest_ctx, &audience).unwrap();
        assert_eq!(minted.assertion, "scoped-guest-assertion-1");
        assert_ne!(minted.assertion, guest_ctx.access_token);
        assert!(mint_guest_assertion_at(&server.base, &guest_ctx, &audience).is_err(), "must reject master token echo");
        assert!(mint_guest_assertion_at(&server.base, &guest_ctx, &audience).is_err(), "must reject expired assertion");

        let verified = verify_guest_assertion_at(&server.base, &host_ctx, &minted.assertion, &audience).unwrap();
        assert_eq!(verified.person.user_id, "verified-user");
        assert_eq!(verified.person.display_name, "Verified Guest");
        assert!(verified.person.email_verified);
        assert!(verify_guest_assertion_at(&server.base, &host_ctx, &minted.assertion, &audience).is_err(), "audience mismatch rejected");
        assert!(verify_guest_assertion_at(&server.base, &host_ctx, &minted.assertion, &audience).is_err(), "expired verification rejected");
        assert!(verify_guest_assertion_at(&server.base, &host_ctx, &minted.assertion, &audience).is_err(), "401 rejected");

        let requests = server.requests();
        assert_eq!(requests[0].authorization, "Bearer guest-master-token");
        assert_eq!(requests[3].authorization, "Bearer host-master-token", "host authenticates verification with its own token, never the guest's");
        assert_eq!(requests[3].body.as_ref().unwrap()["assertion"], "scoped-guest-assertion-1");
        assert_eq!(requests[3].body.as_ref().unwrap()["transcriptHashB64"], "transcript-hash-b64");
    }

    #[test]
    fn relay_cells_must_be_canonical_https_origins() {
        assert!(allowed_https_origin("https://relay.terminalx.ai"));
        assert!(allowed_https_origin("https://cell-1.relay.terminalx.ai"));
        assert!(!allowed_https_origin("https://relay.example"));
        assert!(!allowed_https_origin("http://relay.terminalx.ai"));
        assert!(!allowed_https_origin("https://relay.terminalx.ai/path"));
        assert!(!allowed_https_origin("https://169.254.169.254"));
    }
    #[test]
    fn authenticated_assignment_outage_preserves_status_and_recovers_without_body_leaks() {
        use super::super::diagnostics::{Failure, Stage};
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (path, token, status, body) in [
                (
                    "/v1/desktop/auth/relay-token",
                    "synthetic-access-token",
                    200,
                    r#"{"relayToken":"synthetic-relay-token","expiresAt":4000000000000}"#,
                ),
                (
                    "/v1/assign",
                    "synthetic-relay-token",
                    502,
                    "private email=fixture@example.invalid token=secret upstream=private-host",
                ),
                (
                    "/v1/desktop/auth/relay-token",
                    "synthetic-access-token",
                    200,
                    r#"{"relayToken":"synthetic-relay-token","expiresAt":4000000000000}"#,
                ),
                (
                    "/v1/assign",
                    "synthetic-relay-token",
                    200,
                    r#"{"v":1,"cellUrl":"https://cell-1.relay.terminalx.ai","assignmentEpoch":1,"lease":"synthetic-lease"}"#,
                ),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(&mut stream);
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                assert_eq!(request.trim(), format!("POST {path} HTTP/1.1"));
                let mut headers = String::new();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length: ") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                    headers.push_str(&line.to_lowercase());
                }
                assert!(headers.contains(&format!("authorization: bearer {token}")));
                let mut body_bytes = vec![0; length];
                reader.read_exact(&mut body_bytes).unwrap();
                let payload: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
                assert_eq!(payload["relayHostId"], "synthetic-host");
                if path == "/v1/assign" {
                    assert_eq!(payload["v"], 1);
                    assert_eq!(
                        payload.get("reconnect"),
                        if status == 200 {
                            Some(&json!(true))
                        } else {
                            None
                        }
                    );
                }
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let context = AccountContext {
            access_token: "synthetic-access-token".into(),
            user_id: "synthetic-user".into(),
            email: "fixture@example.invalid".into(),
            display_name: "Fixture".into(),
            profile_id: "synthetic-profile".into(),
            organization_id: "synthetic-org".into(),
            relay_entitled: true,
            generation: 1,
        };
        let authorization =
            relay_authorization_at(&base, &context, "synthetic-host", "synthetic-public-key")
                .unwrap();
        let error = relay_assignment_at(&base, &authorization, "synthetic-host", false)
            .err()
            .unwrap()
            .context(Stage::Assignment);
        assert_eq!(Failure::from_error(&error).http_status, Some(502));
        assert_eq!(
            Failure::from_error(&error).category,
            Category::ServiceUnavailable
        );
        for sensitive in [
            "secret",
            "private-host",
            "fixture@example.invalid",
            "synthetic-relay-token",
        ] {
            assert!(!format!("{error:#}").contains(sensitive));
        }
        let authorization =
            relay_authorization_at(&base, &context, "synthetic-host", "synthetic-public-key")
                .unwrap();
        let assignment =
            relay_assignment_at(&base, &authorization, "synthetic-host", true).unwrap();
        assert_eq!(assignment.assignment_epoch, 1);
        assert_eq!(assignment.cell_url, "https://cell-1.relay.terminalx.ai");
        server.join().unwrap();
    }
}
