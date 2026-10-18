//! The account service's work-claim routes (terminalx-saas
//! `apps/api/docs/work-claims.md`). Like `organization_members`, the access
//! token stays native and only known error codes reach the webview.

use std::io::Read;
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use super::claims::{Claim, ClaimIssue};

const RESPONSE_LIMIT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkClaimsError {
    pub code: String,
    pub status: Option<u16>,
    /// How long the server asked to be left alone (`Retry-After`), bounded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

const MAX_RETRY_AFTER_SECONDS: u64 = 60 * 60;

impl WorkClaimsError {
    pub fn local(code: &str) -> Self {
        Self { code: code.into(), status: None, retry_after_seconds: None }
    }

    /// No answer at all: the service could not be reached.
    pub fn is_offline(&self) -> bool {
        self.status.is_none() && self.code == "work_claims_offline"
    }
}

/// Codes the server's work-claim routes can return. Anything else is
/// collapsed so the webview never renders arbitrary server text.
fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "unauthorized" | "forbidden" | "not_found" | "work_claims_invalid_request" | "work_claims_device_limit" | "work_claims_rate_limited" | "work_status_personal_organization"
    )
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: String,
}

/// What a publish answers.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    #[serde(default)]
    pub refresh_after_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub you: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub label: String,
}

/// One claim as the server shows it to this reader. `device` and
/// `sessionId` come only with the reader's own.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClaim {
    /// Opaque: one person's one session, the same from each of their
    /// machines, so a reader shows a cloud session once. Older servers omit it.
    #[serde(default)]
    pub key: Option<String>,
    pub scope: String,
    pub issue: ClaimIssue,
    pub person: Person,
    #[serde(default)]
    pub device: Option<Device>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub branch: Option<String>,
    /// `working`, `waiting`, `idle` or `pull_request`; a newer server's
    /// other states are passed on and shown as idle.
    pub state: String,
    #[serde(default)]
    pub cloud: bool,
    pub live: bool,
    pub since: i64,
    pub last_active_at: i64,
    pub refreshed_at: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub now: i64,
    #[serde(default = "default_live_for")]
    pub live_for_seconds: u64,
    pub claims: Vec<RemoteClaim>,
}

fn default_live_for() -> u64 {
    300
}

/// The organization's switch, as an admin sees it in Settings.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationWorkStatus {
    pub share_work_status: bool,
    #[serde(default)]
    pub can_manage: bool,
    #[serde(default)]
    pub personal: bool,
    /// The Linear workspaces (`linear.app/<key>`) whose issues members see
    /// each other's work on, as the admins declared them.
    #[serde(default)]
    pub linear_workspaces: Vec<String>,
}

/// A change to the organization's work status settings; what is left out stays.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationWorkStatusPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_work_status: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linear_workspaces: Option<Vec<String>>,
}

pub struct Client {
    base: Url,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(base: Url, timeout: Duration) -> Self {
        Self { base, agent: ureq::AgentBuilder::new().timeout(timeout).redirects(0).build() }
    }

    fn url(&self, segments: &[&str]) -> Result<Url, WorkClaimsError> {
        let mut url = self.base.clone();
        url.path_segments_mut().map_err(|_| WorkClaimsError::local("work_claims_unavailable"))?.extend(["v1", "desktop"]).extend(segments.iter().copied());
        Ok(url)
    }

    fn send<T: DeserializeOwned>(&self, method: &str, url: Url, token: &str, body: Option<Value>) -> Result<T, WorkClaimsError> {
        let request = self.agent.request(method, url.as_str()).set("authorization", &format!("Bearer {token}"));
        let response = match body {
            Some(body) => request.set("content-type", "application/json").send_json(body),
            None => request.call(),
        };
        match response {
            Ok(response) => bounded_body(response).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).ok_or_else(|| WorkClaimsError::local("work_claims_unavailable")),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response)),
            Err(ureq::Error::Transport(_)) => Err(WorkClaimsError::local("work_claims_offline")),
        }
    }

    /// Replace this device's claims with `claims`.
    pub fn publish(&self, token: &str, device_id: &str, device_label: &str, claims: &[Claim]) -> Result<Published, WorkClaimsError> {
        let url = self.url(&["work-claims", "devices", device_id])?;
        self.send("PUT", url, token, Some(json!({ "deviceLabel": device_label, "claims": claims })))
    }

    /// Withdraw every claim of this device.
    pub fn withdraw(&self, token: &str, device_id: &str) -> Result<(), WorkClaimsError> {
        let url = self.url(&["work-claims", "devices", device_id])?;
        self.send::<Value>("DELETE", url, token, None).map(|_| ())
    }

    /// The claims this reader may see on issues in `scopes`.
    pub fn list(&self, token: &str, provider: &str, scopes: &[String]) -> Result<Listed, WorkClaimsError> {
        let mut url = self.url(&["work-claims"])?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("provider", provider);
            for scope in scopes {
                query.append_pair("scope", scope);
            }
        }
        self.send("GET", url, token, None)
    }

    pub fn organization(&self, token: &str, organization_id: &str) -> Result<OrganizationWorkStatus, WorkClaimsError> {
        let url = self.url(&["orgs", organization_id, "work-status"])?;
        self.send("GET", url, token, None)
    }

    pub fn set_organization(&self, token: &str, organization_id: &str, patch: &OrganizationWorkStatusPatch) -> Result<OrganizationWorkStatus, WorkClaimsError> {
        let url = self.url(&["orgs", organization_id, "work-status"])?;
        let body = serde_json::to_value(patch).map_err(|_| WorkClaimsError::local("invalid_request"))?;
        self.send("POST", url, token, Some(body))
    }
}

fn bounded_body(response: ureq::Response) -> Result<Vec<u8>, WorkClaimsError> {
    let mut bytes = Vec::new();
    response.into_reader().take(RESPONSE_LIMIT_BYTES + 1).read_to_end(&mut bytes).map_err(|_| WorkClaimsError::local("work_claims_unavailable"))?;
    if bytes.len() as u64 > RESPONSE_LIMIT_BYTES {
        return Err(WorkClaimsError::local("work_claims_unavailable"));
    }
    Ok(bytes)
}

fn http_error(status: u16, response: ureq::Response) -> WorkClaimsError {
    let retry_after_seconds = response.header("Retry-After").and_then(|value| value.trim().parse::<u64>().ok()).map(|seconds| seconds.min(MAX_RETRY_AFTER_SECONDS));
    let code = bounded_body(response)
        .ok()
        .and_then(|body| serde_json::from_slice::<ErrorEnvelope>(&body).ok())
        .map(|envelope| envelope.error)
        .filter(|code| known_error_code(code))
        .unwrap_or_else(|| "work_claims_unavailable".into());
    WorkClaimsError { code, status: Some(status), retry_after_seconds }
}
