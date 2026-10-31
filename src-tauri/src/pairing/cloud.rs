use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::json;

use crate::account::AccountContext;

use super::diagnostics::Category;
use super::model::{
    AccountPairingEnvelope, AccountPairingGrant, AccountPairingRevocation, HostBindingPayload,
    CAPABILITY,
};

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
    request_unit(
        &crate::account::api_base_url(),
        "/v1/desktop/host-account-bindings",
        "POST",
        Some(serde_json::to_value(payload)?),
        &context.access_token,
    )
}

/// A guest's token is presented only to the fixed account API. No active
/// organization, profile or host membership is needed to verify a person.
pub(super) fn verify_guest(token: &str) -> Result<crate::local_sharing::Person> {
    verify_guest_at(&crate::account::api_base_url(), token)
}

fn verify_guest_at(base: &str, token: &str) -> Result<crate::local_sharing::Person> {
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
    struct Response {
        cloud: Identity,
        #[serde(default)]
        organizations: Vec<Organization>,
    }
    let response: Response = request_json(
        base,
        "/v1/desktop/auth/capabilities",
        "POST",
        Some(json!({})),
        token,
    )?;
    let identity = response.cloud;
    if identity.user_id.trim().is_empty() || identity.email.trim().is_empty() {
        return Err(anyhow!("Account API returned no verified identity."));
    }
    Ok(crate::local_sharing::Person {
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
    })
}

/// Tell the account service this Mac is reachable over Relay. The service
/// accepts only "live" or "exited" and treats a "live" as current for 90 s,
/// so the caller sends one only while the control channel is answering;
/// otherwise the binding lapses to "unverifiable" on its own.
pub fn heartbeat(base: &str, context: &AccountContext, host_id: &str, generation: u64) -> Result<()> {
    request_unit(
        base,
        &format!("/v1/desktop/host-account-bindings/{host_id}/heartbeat"),
        "POST",
        Some(json!({
            "bindingGeneration": generation,
            "reachability": "live",
            "capabilities": [CAPABILITY]
        })),
        &context.access_token,
    )
}

pub fn unbind(context: &AccountContext, host_id: &str, generation: u64) -> Result<()> {
    request_unit(
        &crate::account::api_base_url(),
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
) -> Result<Vec<AccountPairingGrant>> {
    request_json::<GrantList>(
        base,
        &format!("/v1/desktop/host-account-bindings/{host_id}/pairing-grant-requests?bindingGeneration={generation}"),
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
) -> Result<Vec<AccountPairingRevocation>> {
    request_json::<RevocationList>(
        base,
        &format!("/v1/desktop/host-account-bindings/{host_id}/revocations?bindingGeneration={generation}"),
        "GET",
        None,
        &context.access_token,
    )
    .map(|response| response.revocations)
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
            crate::account::discard_body(response);
            Err(match retry_after {
                Some(after) => anyhow::Error::new(after).context(CloudHttpError(status)),
                None => CloudHttpError(status).into(),
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
    url::Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.origin().ascii_serialization() == value)
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
        assert!(pending_grants(&server.base, &context, "synthetic-host", 3).unwrap().is_empty());
        heartbeat(&server.base, &context, "synthetic-host", 3).unwrap();
        let error = pending_revocations(&server.base, &context, "synthetic-host", 3).unwrap_err();
        assert_eq!(error.downcast_ref::<CloudHttpError>().map(|error| error.0), Some(429));
        assert_eq!(error.downcast_ref::<RetryAfter>(), Some(&RetryAfter(Duration::from_secs(7))));
        assert_eq!(
            super::super::diagnostics::Failure::from_error(&error).category,
            Category::RateLimited
        );
        assert!(pending_grants(&server.base, &context, "synthetic-host", 3).unwrap().is_empty());

        let requests = server.requests();
        assert_eq!(
            requests.iter().map(|request| request.method.as_str()).collect::<Vec<_>>(),
            ["GET", "POST", "GET", "GET"]
        );
        assert_eq!(server.connections(), 1, "every request, the refused one too, reuses one connection");
        assert!(requests.iter().all(|request| request.authorization == "Bearer synthetic-access-token"));
        assert_eq!(
            requests[1].body,
            Some(json!({ "bindingGeneration": 3, "reachability": "live", "capabilities": [CAPABILITY] }))
        );
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
    fn guest_identity_is_verified_with_bearer_token_without_an_organization() {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (status, body) in [
                (
                    200,
                    r#"{"cloud":{"userId":"verified-user","email":"guest@example.com","displayName":"Verified Guest","emailVerified":true},"organizations":[]}"#,
                ),
                (
                    200,
                    r#"{"cloud":{"userId":"verified-user","email":"guest@example.com","displayName":null}}"#,
                ),
                (401, r#"{"userId":"forged","email":"forged@example.com"}"#),
                (
                    200,
                    r#"{"cloud":{"userId":"","email":"guest@example.com"}}"#,
                ),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(&mut stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert_eq!(line.trim(), "POST /v1/desktop/auth/capabilities HTTP/1.1");
                let mut length = 0;
                let mut authenticated = false;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    let lower = line.to_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length: ") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                    authenticated |= lower.trim() == "authorization: bearer synthetic-guest-token";
                }
                assert!(authenticated);
                let mut payload = vec![0; length];
                reader.read_exact(&mut payload).unwrap();
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&payload).unwrap(),
                    json!({})
                );
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let person = verify_guest_at(&base, "synthetic-guest-token").unwrap();
        assert_eq!(person.user_id, "verified-user");
        assert_eq!(person.display_name, "Verified Guest");
        assert!(person.email_verified);
        assert!(person.organization_ids.is_empty());
        let legacy = verify_guest_at(&base, "synthetic-guest-token").unwrap();
        assert!(!legacy.email_verified);
        assert_eq!(legacy.display_name, "guest@example.com");
        assert!(verify_guest_at(&base, "synthetic-guest-token").is_err());
        assert!(verify_guest_at(&base, "synthetic-guest-token").is_err());
        server.join().unwrap();
    }

    #[test]
    fn relay_cells_must_be_canonical_https_origins() {
        assert!(allowed_https_origin("https://relay.example"));
        assert!(!allowed_https_origin("http://relay.example"));
        assert!(!allowed_https_origin("https://relay.example/path"));
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
                    r#"{"v":1,"cellUrl":"https://cell.example.invalid","assignmentEpoch":1,"lease":"synthetic-lease"}"#,
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
        assert_eq!(assignment.cell_url, "https://cell.example.invalid");
        server.join().unwrap();
    }
}
