use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::json;

use crate::account::AccountContext;

use super::model::{
    AccountPairingEnvelope, AccountPairingGrant, AccountPairingRevocation, HostBindingPayload,
    CAPABILITY,
};

pub const ACCOUNT_BASE_URL: &str = "https://login.terminalx.ai";
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
        ACCOUNT_BASE_URL,
        "/v1/desktop/host-account-bindings",
        "POST",
        Some(serde_json::to_value(payload)?),
        &context.access_token,
    )
}

pub fn heartbeat(
    context: &AccountContext,
    host_id: &str,
    generation: u64,
    reachability: &str,
) -> Result<()> {
    request_unit(
        ACCOUNT_BASE_URL,
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
        ACCOUNT_BASE_URL,
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
        ACCOUNT_BASE_URL,
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
        ACCOUNT_BASE_URL,
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
        ACCOUNT_BASE_URL,
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
        ACCOUNT_BASE_URL,
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
        ACCOUNT_BASE_URL,
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
    request_json(
        ACCOUNT_BASE_URL,
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
    let mut body = json!({ "v": 1, "relayHostId": relay_host_id });
    if reconnect {
        body["reconnect"] = json!(true);
    }
    let assignment: RelayAssignment = request_json(
        RELAY_DIRECTOR_URL,
        "/v1/assign",
        "POST",
        Some(body),
        &authorization.relay_token,
    )?;
    if assignment.v != 1
        || assignment.lease.is_empty()
        || !allowed_https_origin(&assignment.cell_url)
    {
        bail!("relay director returned an invalid assignment");
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
    response
        .into_json()
        .context("decode cloud service response")
}

fn send(
    base: &str,
    path: &str,
    method: &str,
    body: Option<serde_json::Value>,
    token: &str,
) -> Result<ureq::Response> {
    if token.is_empty() {
        bail!("account authorization is unavailable");
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

fn allowed_https_origin(value: &str) -> bool {
    url::Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.origin().ascii_serialization() == value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_cells_must_be_canonical_https_origins() {
        assert!(allowed_https_origin("https://relay.example"));
        assert!(!allowed_https_origin("http://relay.example"));
        assert!(!allowed_https_origin("https://relay.example/path"));
    }
}
