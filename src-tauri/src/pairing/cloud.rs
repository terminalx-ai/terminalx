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

pub const RELAY_DIRECTOR_URL: &str = "https://relay.terminalx.ai";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct CloudHttpError(pub u16);

impl std::fmt::Display for CloudHttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "cloud service returned HTTP {}", self.0)
    }
}

impl std::error::Error for CloudHttpError {}

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

pub fn heartbeat(
    context: &AccountContext,
    host_id: &str,
    generation: u64,
    reachability: &str,
) -> Result<()> {
    request_unit(
        &crate::account::api_base_url(),
        &format!("/v1/desktop/host-account-bindings/{host_id}/heartbeat"),
        "POST",
        Some(json!({
            "bindingGeneration": generation,
            "reachability": reachability,
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
    context: &AccountContext,
    host_id: &str,
    generation: u64,
) -> Result<Vec<AccountPairingGrant>> {
    request_json::<GrantList>(
        &crate::account::api_base_url(),
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
    context: &AccountContext,
    host_id: &str,
    generation: u64,
) -> Result<Vec<AccountPairingRevocation>> {
    request_json::<RevocationList>(
        &crate::account::api_base_url(),
        &format!("/v1/desktop/host-account-bindings/{host_id}/revocations?bindingGeneration={generation}"),
        "GET",
        None,
        &context.access_token,
    )
    .map(|response| response.revocations)
}

pub fn acknowledge_revocation(
    context: &AccountContext,
    host_id: &str,
    revocation_id: &str,
    generation: u64,
) -> Result<()> {
    request_unit(
        &crate::account::api_base_url(),
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

pub fn relay_assignment(
    authorization: &RelayAuthorization,
    relay_host_id: &str,
    reconnect: bool,
) -> Result<RelayAssignment> {
    relay_assignment_at(RELAY_DIRECTOR_URL, authorization, relay_host_id, reconnect)
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
    send(base, path, method, body, token).map(|_| ())
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
    let agent = ureq::AgentBuilder::new()
        .timeout(REQUEST_TIMEOUT)
        .redirects(0)
        .build();
    let request = agent
        .request(method, &format!("{base}{path}"))
        .set("authorization", &format!("Bearer {token}"))
        .set("content-type", "application/json");
    let response = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    match response {
        Ok(response) => Ok(response),
        Err(ureq::Error::Status(status, _)) => Err(CloudHttpError(status).into()),
        Err(ureq::Error::Transport(error)) => Err(anyhow!(error).context("cloud request failed")),
    }
}

pub(super) fn allowed_https_origin(value: &str) -> bool {
    url::Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.origin().ascii_serialization() == value)
}

#[cfg(test)]
mod tests {
    use super::*;

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
