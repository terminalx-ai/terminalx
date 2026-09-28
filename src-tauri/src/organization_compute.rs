//! Native-only client for the active organization's cloud compute limits,
//! provisioning pause and provider usage report.
//!
//! Same fencing as the member roster: the access token stays native, every
//! response is dropped if the account or organization changed while it was
//! in flight, and mutations refuse to send for a stale context revision. The
//! server also checks the policy version, so two admins cannot overwrite each
//! other's edits.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use url::Url;

use crate::account::{AccountContext, AccountManager};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS: u64 = 60 * 60;
const UNAVAILABLE: &str = "organization_compute_unavailable";
const OUTCOME_UNKNOWN: &str = "organization_compute_outcome_unknown";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationComputeError {
    pub code: String,
    pub status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
}

impl OrganizationComputeError {
    pub(crate) fn local(code: &str) -> Self {
        Self { code: code.into(), status: None, retry_after_seconds: None }
    }
}

/// Codes the server's compute policy routes can return. Anything else is
/// collapsed so the webview never renders arbitrary server text.
fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "invalid_access_token"
            | "active_organization_required"
            | "organization_admin_required"
            | "cloud_workspace_not_found"
            | "cloud_workspace_request_invalid"
            | "cloud_compute_policy_conflict"
            | "cloud_provider_unavailable"
    )
}

enum Method {
    Get,
    Put,
    Post,
}

struct Client {
    base: Url,
    agent: ureq::Agent,
}

impl Client {
    fn new(base: Url, timeout: Duration) -> Self {
        Self { base, agent: ureq::AgentBuilder::new().timeout(timeout).redirects(0).build() }
    }

    fn request(
        &self,
        context: &AccountContext,
        method: Method,
        tail: &str,
        body: Option<Value>,
    ) -> Result<Map<String, Value>, OrganizationComputeError> {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| OrganizationComputeError::local(UNAVAILABLE))?
            .extend(["v1", "desktop", "orgs", context.organization_id.as_str(), "cloud-compute", tail]);
        // Once a mutation is sent, a lost or unreadable response says nothing
        // about whether the server applied it.
        let lost = if body.is_some() { OUTCOME_UNKNOWN } else { UNAVAILABLE };
        let verb = match method {
            Method::Get => "GET",
            Method::Put => "PUT",
            Method::Post => "POST",
        };
        let request = self
            .agent
            .request(verb, url.as_str())
            .set("authorization", &format!("Bearer {}", context.access_token));
        let response = match body {
            Some(body) => request.set("content-type", "application/json").send_json(body),
            None => request.call(),
        };
        match response {
            Ok(response) => bounded_body(response)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|value| match value {
                    Value::Object(map) => Some(map),
                    _ => None,
                })
                .ok_or_else(|| OrganizationComputeError::local(lost)),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response)),
            Err(ureq::Error::Transport(_)) => Err(OrganizationComputeError::local(lost)),
        }
    }
}

fn bounded_body(response: ureq::Response) -> Result<Vec<u8>, OrganizationComputeError> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(RESPONSE_LIMIT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| OrganizationComputeError::local(UNAVAILABLE))?;
    if bytes.len() as u64 > RESPONSE_LIMIT_BYTES {
        return Err(OrganizationComputeError::local(UNAVAILABLE));
    }
    Ok(bytes)
}

fn http_error(status: u16, response: ureq::Response) -> OrganizationComputeError {
    let retry_after_seconds = response
        .header("Retry-After")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.min(MAX_RETRY_AFTER_SECONDS));
    let code = bounded_body(response)
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_owned))
        .filter(|code| known_error_code(code))
        .unwrap_or_else(|| UNAVAILABLE.into());
    OrganizationComputeError { code, status: Some(status), retry_after_seconds }
}

pub struct OrganizationComputeService {
    account: Arc<AccountManager>,
    client: Client,
}

impl OrganizationComputeService {
    pub fn new(account: Arc<AccountManager>) -> Self {
        Self {
            account,
            client: Client::new(Url::parse(&crate::account::api_base_url()).expect("valid account service URL"), REQUEST_TIMEOUT),
        }
    }

    #[cfg(test)]
    fn for_test(account: Arc<AccountManager>, base: &str) -> Self {
        Self { account, client: Client::new(Url::parse(base).unwrap(), Duration::from_secs(2)) }
    }

    fn run(
        &self,
        expected_revision: Option<&str>,
        method: Method,
        tail: &str,
        body: Option<Value>,
    ) -> Result<Value, OrganizationComputeError> {
        let context = self.account.context().ok_or_else(|| OrganizationComputeError::local("account_signed_out"))?;
        if context.organization_id.is_empty() {
            return Err(OrganizationComputeError::local("account_organization_unavailable"));
        }
        let revision = AccountManager::context_revision(&context);
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(OrganizationComputeError::local("account_context_changed"));
        }
        let mutation = body.is_some();
        let result = self.client.request(&context, method, tail, body);
        if !self.account.is_current(&context) {
            return Err(OrganizationComputeError::local(if mutation {
                "account_context_changed_after_send"
            } else {
                "account_context_changed"
            }));
        }
        let mut payload = result?;
        payload.insert("contextRevision".into(), Value::String(revision));
        Ok(Value::Object(payload))
    }

    pub fn policy(&self) -> Result<Value, OrganizationComputeError> {
        self.run(None, Method::Get, "policy", None)
    }

    pub fn usage(&self) -> Result<Value, OrganizationComputeError> {
        self.run(None, Method::Get, "usage", None)
    }

    /// The webview's policy object is forwarded field by field; the server
    /// validates values, this only refuses shapes it would reject anyway.
    pub fn update_policy(&self, policy: &Value, context_revision: &str) -> Result<Value, OrganizationComputeError> {
        const KEYS: [&str; 6] = [
            "expectedVersion",
            "maxWorkspaces",
            "maxRunningWorkspaces",
            "maxIdleSuspendMinutes",
            "allowedMachineClasses",
            "allowedLocations",
        ];
        let object = policy.as_object().ok_or_else(|| OrganizationComputeError::local("cloud_workspace_request_invalid"))?;
        if object.len() != KEYS.len() || !KEYS.iter().all(|key| object.contains_key(*key)) {
            return Err(OrganizationComputeError::local("cloud_workspace_request_invalid"));
        }
        self.run(Some(context_revision), Method::Put, "policy", Some(policy.clone()))
    }

    pub fn set_provisioning_paused(
        &self,
        expected_version: u64,
        paused: bool,
        reason: Option<&str>,
        context_revision: &str,
    ) -> Result<Value, OrganizationComputeError> {
        let reason = reason.map(str::trim).filter(|reason| !reason.is_empty());
        self.run(
            Some(context_revision),
            Method::Post,
            "provisioning-pause",
            Some(json!({ "expectedVersion": expected_version, "paused": paused, "reason": reason })),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    fn context() -> AccountContext {
        AccountContext {
            access_token: "native-secret-token".into(),
            user_id: "user-1".into(),
            email: "owner@example.com".into(),
            display_name: "Owner".into(),
            profile_id: "profile-1".into(),
            organization_id: "org-1".into(),
            relay_entitled: true,
            generation: 3,
        }
    }

    fn serve_once(status: &str, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap_or(0);
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (base, handle)
    }

    fn service(base: &str) -> OrganizationComputeService {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        OrganizationComputeService::for_test(account, base)
    }

    const VIEW: &str = r#"{"policy":{"version":2,"maxWorkspaces":4},"canEdit":true,"counts":{"workspaces":1,"running":1}}"#;

    #[test]
    fn reads_the_policy_with_a_context_revision_and_keeps_the_token_native() {
        let (base, server) = serve_once("200 OK", VIEW);
        let view = service(&base).policy().unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/desktop/orgs/org-1/cloud-compute/policy "));
        assert!(request.contains("authorization: Bearer native-secret-token"));
        assert_eq!(view["contextRevision"], AccountManager::context_revision(&context()));
        assert!(!view.to_string().contains("native-secret-token"));
    }

    #[test]
    fn sends_policy_edits_as_put_and_pause_as_post() {
        let revision = AccountManager::context_revision(&context());
        let policy = json!({
            "expectedVersion": 2,
            "maxWorkspaces": 4,
            "maxRunningWorkspaces": null,
            "maxIdleSuspendMinutes": 30,
            "allowedMachineClasses": {},
            "allowedLocations": {"hetzner": ["fsn1"]}
        });
        let (base, server) = serve_once("200 OK", VIEW);
        service(&base).update_policy(&policy, &revision).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("PUT /v1/desktop/orgs/org-1/cloud-compute/policy "));
        assert!(request.contains(r#""allowedLocations":{"hetzner":["fsn1"]}"#));

        let (base, server) = serve_once("200 OK", VIEW);
        service(&base).set_provisioning_paused(3, true, Some("  budget  "), &revision).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/desktop/orgs/org-1/cloud-compute/provisioning-pause "));
        assert!(request.contains(r#""reason":"budget""#));
        assert!(request.contains(r#""paused":true"#));
    }

    #[test]
    fn refuses_stale_contexts_and_malformed_policies_before_sending() {
        let service = service("http://127.0.0.1:9");
        let error = service.set_provisioning_paused(1, true, None, "stale").unwrap_err();
        assert_eq!(error.code, "account_context_changed");
        let revision = AccountManager::context_revision(&context());
        let error = service.update_policy(&json!({"maxWorkspaces": 4}), &revision).unwrap_err();
        assert_eq!(error.code, "cloud_workspace_request_invalid");
    }

    #[test]
    fn maps_known_codes_and_collapses_unknown_text() {
        let (base, server) = serve_once("403 Forbidden", r#"{"error":"organization_admin_required"}"#);
        let revision = AccountManager::context_revision(&context());
        let error = service(&base).set_provisioning_paused(1, false, None, &revision).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "organization_admin_required");
        assert_eq!(error.status, Some(403));

        let (base, server) = serve_once("500 Internal Server Error", r#"{"error":"<script>"}"#);
        let error = service(&base).usage().unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, UNAVAILABLE);
    }

    #[test]
    fn reports_an_unknown_outcome_when_a_sent_edit_loses_its_response() {
        let (base, server) = serve_once("200 OK", "not json");
        let revision = AccountManager::context_revision(&context());
        let error = service(&base).set_provisioning_paused(1, true, None, &revision).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, OUTCOME_UNKNOWN);
    }
}
