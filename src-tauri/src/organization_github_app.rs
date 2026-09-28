//! Native-only client for the active organization's GitHub App installations
//! and the repositories chosen for cloud workspaces (PRO-14, contract §16.2
//! and §16.3 in terminalx-saas `apps/api/docs`).
//!
//! It follows `organization_members`: the access token never crosses into the
//! webview, every response is fenced on the account context it started in,
//! and mutations refuse to send when the caller's context revision is stale.
//! GitHub pages are opened natively, and only when they are on
//! `https://github.com`, so the webview cannot use these commands to open an
//! arbitrary URL.

use std::collections::BTreeMap;
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::account::{AccountContext, AccountManager};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
/// The server refuses a larger selection (§16.3).
pub const MAX_SELECTED_REPOSITORIES: usize = 100;
const MAX_QUERY_CHARS: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubInstallation {
    pub id: String,
    pub installation_id: u64,
    pub account_login: String,
    #[serde(default)]
    pub account_type: String,
    #[serde(default)]
    pub repository_selection: String,
    /// `connected`, `suspended` or `revoked`.
    pub state: String,
    #[serde(default)]
    pub permissions: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manage_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectedRepository {
    pub id: String,
    pub installation_id: String,
    pub github_repository_id: u64,
    pub full_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clone_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub private: bool,
    /// `accessible`, `missing`, `installation-suspended` or
    /// `installation-revoked`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubAppSummary {
    pub configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_url: Option<String>,
    #[serde(default)]
    pub installations: Vec<GithubInstallation>,
    #[serde(default)]
    pub repositories: Vec<SelectedRepository>,
    /// Whether the viewer may connect, choose and disconnect. The contract
    /// does not require it; when absent the webview asks the member roster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_manage: Option<bool>,
    /// Filled natively so the webview can fence its next mutation.
    #[serde(default)]
    pub context_revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectAttempt {
    pub attempt_id: String,
    /// Absent from the create response, which is always `waiting`.
    #[serde(default = "waiting")]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<GithubInstallation>,
    /// Set natively on create: whether the browser was opened.
    #[serde(default)]
    pub browser_opened: bool,
}

fn waiting() -> String {
    "waiting".into()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRepository {
    pub github_repository_id: u64,
    pub full_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub private: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clone_url: Option<String>,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissingRepository {
    pub github_repository_id: u64,
    pub full_name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRepositories {
    pub installation: GithubInstallation,
    pub repositories: Vec<LiveRepository>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub missing: Vec<MissingRepository>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manage_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChoice {
    pub installation_id: String,
    pub github_repository_id: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubAppError {
    pub code: String,
    pub status: Option<u16>,
}

impl GithubAppError {
    pub(crate) fn local(code: &str) -> Self {
        Self { code: code.into(), status: None }
    }
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: String,
}

/// Codes the server's desktop GitHub App routes can return. Anything else is
/// collapsed so the webview never renders arbitrary server text.
fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "unauthorized"
            | "forbidden"
            | "not_found"
            | "invalid_request"
            | "cloud_workspace_request_invalid"
            | "organization_admin_required"
            | "github_app_not_configured"
            | "github_app_unavailable"
            | "github_installation_unverified"
            | "github_installation_pending_approval"
            | "github_installation_already_connected"
            | "github_installation_suspended"
            | "github_installation_revoked"
            | "github_repository_not_accessible"
            | "github_repository_not_granted"
            | "github_connect_attempt_expired"
    )
}

/// An id the server issued (`ghinst_…`, an attempt id), before it is put in a
/// path.
fn opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Only GitHub's own pages are opened: an install or manage link from the
/// server, never an arbitrary URL.
pub fn allowed_github_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else { return false };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

enum Method {
    Get,
    Post,
    Put,
    Delete,
}

impl Method {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
        }
    }
}

struct Client {
    base: Url,
    agent: ureq::Agent,
}

impl Client {
    fn new(base: Url, timeout: Duration) -> Self {
        Self { base, agent: ureq::AgentBuilder::new().timeout(timeout).redirects(0).build() }
    }

    fn request<T: DeserializeOwned>(
        &self,
        context: &AccountContext,
        method: Method,
        tail: &[&str],
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<T, GithubAppError> {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| GithubAppError::local("github_app_request_failed"))?
            .extend(["v1", "desktop", "orgs", context.organization_id.as_str(), "github-app"])
            .extend(tail.iter().copied());
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        // Once a mutation is sent, a lost or unreadable response says nothing
        // about whether the server applied it.
        let mutation = !matches!(method, Method::Get);
        let lost = if mutation { "github_app_outcome_unknown" } else { "github_app_request_failed" };
        let request = self
            .agent
            .request(method.as_str(), url.as_str())
            .set("authorization", &format!("Bearer {}", context.access_token));
        let response = match body {
            Some(body) => request.set("content-type", "application/json").send_json(body),
            None => request.call(),
        };
        match response {
            Ok(response) => bounded_body(response)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .ok_or_else(|| GithubAppError::local(lost)),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response)),
            Err(ureq::Error::Transport(_)) => Err(GithubAppError::local(lost)),
        }
    }
}

fn bounded_body(response: ureq::Response) -> Result<Vec<u8>, GithubAppError> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(RESPONSE_LIMIT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| GithubAppError::local("github_app_request_failed"))?;
    if bytes.len() as u64 > RESPONSE_LIMIT_BYTES {
        return Err(GithubAppError::local("github_app_request_failed"));
    }
    Ok(bytes)
}

fn http_error(status: u16, response: ureq::Response) -> GithubAppError {
    let code = bounded_body(response)
        .ok()
        .and_then(|body| serde_json::from_slice::<ErrorEnvelope>(&body).ok())
        .map(|envelope| envelope.error)
        .filter(|code| known_error_code(code))
        .unwrap_or_else(|| if status == 404 { "not_found".into() } else { "github_app_request_failed".into() });
    GithubAppError { code, status: Some(status) }
}

pub struct OrganizationGithubAppService {
    account: Arc<AccountManager>,
    client: Client,
}

impl OrganizationGithubAppService {
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

    fn context(&self) -> Result<AccountContext, GithubAppError> {
        let context = self.account.context().ok_or_else(|| GithubAppError::local("account_signed_out"))?;
        if context.organization_id.is_empty() {
            return Err(GithubAppError::local("account_organization_unavailable"));
        }
        Ok(context)
    }

    /// One call, fenced on the account context. A mutation carries the
    /// revision the webview last saw and is refused if it no longer matches.
    fn run<T: DeserializeOwned>(
        &self,
        expected_revision: Option<&str>,
        method: Method,
        tail: &[&str],
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<(T, String), GithubAppError> {
        let context = self.context()?;
        let revision = AccountManager::context_revision(&context);
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(GithubAppError::local("account_context_changed"));
        }
        let mutation = !matches!(method, Method::Get);
        let result = self.client.request::<T>(&context, method, tail, query, body);
        if !self.account.is_current(&context) {
            // A mutation that was sent may still have been applied.
            return Err(GithubAppError::local(if mutation { "account_context_changed_after_send" } else { "account_context_changed" }));
        }
        Ok((result?, revision))
    }

    pub fn summary(&self) -> Result<GithubAppSummary, GithubAppError> {
        let (mut summary, revision) = self.run::<GithubAppSummary>(None, Method::Get, &[], &[], None)?;
        summary.context_revision = revision;
        Ok(summary)
    }

    /// Start a connect attempt and open its install page. The attempt is
    /// returned even when the browser could not be opened, so the webview can
    /// say so and keep polling.
    pub fn connect(&self, context_revision: &str, open: impl FnOnce(&str) -> bool) -> Result<ConnectAttempt, GithubAppError> {
        let (mut attempt, _) = self.run::<ConnectAttempt>(Some(context_revision), Method::Post, &["connect-attempts"], &[], Some(json!({})))?;
        if !opaque_id(&attempt.attempt_id) {
            return Err(GithubAppError::local("github_app_outcome_unknown"));
        }
        attempt.browser_opened = match attempt.install_url.as_deref() {
            Some(url) if allowed_github_url(url) => open(url),
            _ => {
                attempt.install_url = None;
                false
            }
        };
        Ok(attempt)
    }

    pub fn attempt(&self, attempt_id: &str) -> Result<ConnectAttempt, GithubAppError> {
        if !opaque_id(attempt_id) {
            return Err(GithubAppError::local("invalid_request"));
        }
        Ok(self.run::<ConnectAttempt>(None, Method::Get, &["connect-attempts", attempt_id], &[], None)?.0)
    }

    pub fn cancel_attempt(&self, attempt_id: &str, context_revision: &str) -> Result<ConnectAttempt, GithubAppError> {
        if !opaque_id(attempt_id) {
            return Err(GithubAppError::local("invalid_request"));
        }
        Ok(self
            .run::<ConnectAttempt>(Some(context_revision), Method::Post, &["connect-attempts", attempt_id, "cancel"], &[], Some(json!({})))?
            .0)
    }

    pub fn repositories(&self, installation_id: &str, query: &str, refresh: bool) -> Result<LiveRepositories, GithubAppError> {
        if !opaque_id(installation_id) {
            return Err(GithubAppError::local("invalid_request"));
        }
        let query: String = query.trim().chars().take(MAX_QUERY_CHARS).collect();
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        if !query.is_empty() {
            pairs.push(("query", query.as_str()));
        }
        if refresh {
            pairs.push(("refresh", "1"));
        }
        Ok(self
            .run::<LiveRepositories>(None, Method::Get, &["installations", installation_id, "repositories"], &pairs, None)?
            .0)
    }

    /// Replace the selection. The webview reloads the summary afterwards; the
    /// response body is not relied on.
    pub fn save_repositories(&self, choices: &[RepositoryChoice], context_revision: &str) -> Result<(), GithubAppError> {
        if choices.len() > MAX_SELECTED_REPOSITORIES || choices.iter().any(|choice| !opaque_id(&choice.installation_id)) {
            return Err(GithubAppError::local("invalid_request"));
        }
        self.run::<Value>(Some(context_revision), Method::Put, &["repositories"], &[], Some(json!({ "repositories": choices })))?;
        Ok(())
    }

    pub fn disconnect(&self, installation_id: &str, context_revision: &str) -> Result<(), GithubAppError> {
        if !opaque_id(installation_id) {
            return Err(GithubAppError::local("invalid_request"));
        }
        self.run::<Value>(Some(context_revision), Method::Delete, &["installations", installation_id], &[], Some(json!({})))?;
        Ok(())
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

    fn revision() -> String {
        AccountManager::context_revision(&context())
    }

    /// Serve one canned HTTP response and hand back the raw request text.
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

    fn service(base: &str) -> OrganizationGithubAppService {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        OrganizationGithubAppService::for_test(account, base)
    }

    const SUMMARY: &str = r#"{"configured":true,"installUrl":"https://github.com/apps/terminalx/installations/new","installations":[{"id":"ghinst_1","installationId":42,"accountLogin":"acme","accountType":"Organization","repositorySelection":"selected","state":"connected","permissions":{"contents":"write"},"manageUrl":"https://github.com/organizations/acme/settings/installations/42","updatedAt":1}],"repositories":[{"id":"ghrepo_1","installationId":"ghinst_1","githubRepositoryId":7,"fullName":"acme/api","cloneUrl":"https://github.com/acme/api.git","defaultBranch":"main","private":true,"state":"missing","reason":"github_repository_not_granted","lastVerifiedAt":1}]}"#;

    #[test]
    fn reads_the_summary_with_a_context_revision() {
        let (base, server) = serve_once("200 OK", SUMMARY);
        let summary = service(&base).summary().unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/desktop/orgs/org-1/github-app "), "{request}");
        assert!(request.contains("authorization: Bearer native-secret-token"));
        assert_eq!(summary.installations[0].installation_id, 42);
        assert_eq!(summary.repositories[0].reason.as_deref(), Some("github_repository_not_granted"));
        assert_eq!(summary.context_revision, revision());
        assert!(!serde_json::to_string(&summary).unwrap().contains("native-secret-token"));
    }

    #[test]
    fn connect_opens_only_a_github_install_page() {
        let body = r#"{"attemptId":"att_1","installUrl":"https://github.com/apps/terminalx/installations/new?state=s","expiresAt":9}"#;
        let (base, server) = serve_once("200 OK", body);
        let mut opened = None;
        let attempt = service(&base)
            .connect(&revision(), |url| {
                opened = Some(url.to_string());
                true
            })
            .unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/desktop/orgs/org-1/github-app/connect-attempts "));
        assert_eq!(attempt.state, "waiting");
        assert!(attempt.browser_opened);
        assert_eq!(opened.as_deref(), Some("https://github.com/apps/terminalx/installations/new?state=s"));

        let body = r#"{"attemptId":"att_2","installUrl":"https://evil.example/apps/x","expiresAt":9}"#;
        let (base, server) = serve_once("200 OK", body);
        let attempt = service(&base).connect(&revision(), |_| panic!("must not open")).unwrap();
        server.join().unwrap();
        assert!(!attempt.browser_opened);
        assert_eq!(attempt.install_url, None);
    }

    #[test]
    fn polls_and_cancels_an_attempt() {
        let body = r#"{"attemptId":"att_1","state":"failed","errorCode":"github_installation_pending_approval"}"#;
        let (base, server) = serve_once("200 OK", body);
        let attempt = service(&base).attempt("att_1").unwrap();
        assert!(server.join().unwrap().starts_with("GET /v1/desktop/orgs/org-1/github-app/connect-attempts/att_1 "));
        assert_eq!(attempt.error_code.as_deref(), Some("github_installation_pending_approval"));

        let (base, server) = serve_once("200 OK", r#"{"attemptId":"att_1","state":"canceled"}"#);
        let attempt = service(&base).cancel_attempt("att_1", &revision()).unwrap();
        assert!(server.join().unwrap().starts_with("POST /v1/desktop/orgs/org-1/github-app/connect-attempts/att_1/cancel "));
        assert_eq!(attempt.state, "canceled");
    }

    #[test]
    fn lists_repositories_with_an_encoded_query_and_refresh() {
        let body = r#"{"installation":{"id":"ghinst_1","installationId":42,"accountLogin":"acme","state":"connected"},"repositories":[{"githubRepositoryId":7,"fullName":"acme/api","selected":true}],"truncated":false,"missing":[{"githubRepositoryId":9,"fullName":"acme/old","reason":"github_repository_not_granted"}]}"#;
        let (base, server) = serve_once("200 OK", body);
        let live = service(&base).repositories("ghinst_1", " api & web ", true).unwrap();
        let request = server.join().unwrap();
        assert!(
            request.starts_with("GET /v1/desktop/orgs/org-1/github-app/installations/ghinst_1/repositories?query=api+%26+web&refresh=1 "),
            "{request}"
        );
        assert!(live.repositories[0].selected);
        assert_eq!(live.missing[0].full_name, "acme/old");
    }

    #[test]
    fn saves_the_selection_and_disconnects() {
        let (base, server) = serve_once("200 OK", SUMMARY);
        let choices = vec![RepositoryChoice { installation_id: "ghinst_1".into(), github_repository_id: 7 }];
        service(&base).save_repositories(&choices, &revision()).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("PUT /v1/desktop/orgs/org-1/github-app/repositories "));
        let body: Value = serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body, json!({ "repositories": [{ "installationId": "ghinst_1", "githubRepositoryId": 7 }] }));

        let (base, server) = serve_once("200 OK", "{}");
        service(&base).disconnect("ghinst_1", &revision()).unwrap();
        assert!(server.join().unwrap().starts_with("DELETE /v1/desktop/orgs/org-1/github-app/installations/ghinst_1 "));
    }

    #[test]
    fn refuses_bad_ids_oversized_selections_and_stale_contexts_before_sending() {
        let service = service("http://127.0.0.1:9");
        assert_eq!(service.attempt("../members").unwrap_err().code, "invalid_request");
        assert_eq!(service.repositories("a/b", "", false).unwrap_err().code, "invalid_request");
        assert_eq!(service.disconnect("ghinst_1", "stale").unwrap_err().code, "account_context_changed");
        let many: Vec<_> = (0..=MAX_SELECTED_REPOSITORIES as u64)
            .map(|id| RepositoryChoice { installation_id: "ghinst_1".into(), github_repository_id: id })
            .collect();
        assert_eq!(service.save_repositories(&many, &revision()).unwrap_err().code, "invalid_request");
    }

    #[test]
    fn maps_known_server_codes_and_collapses_unknown_text() {
        let (base, server) = serve_once("503 Service Unavailable", r#"{"error":"github_app_not_configured"}"#);
        let error = service(&base).summary().unwrap_err();
        server.join().unwrap();
        assert_eq!(error, GithubAppError { code: "github_app_not_configured".into(), status: Some(503) });

        let (base, server) = serve_once("422 Unprocessable Entity", r#"{"error":"github_repository_not_accessible"}"#);
        let error = service(&base).save_repositories(&[], &revision()).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "github_repository_not_accessible");

        let (base, server) = serve_once("500 Internal Server Error", r#"{"error":"<script>"}"#);
        let error = service(&base).summary().unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "github_app_request_failed");

        let (base, server) = serve_once("200 OK", "not json");
        let error = service(&base).disconnect("ghinst_1", &revision()).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "github_app_outcome_unknown");
    }

    #[test]
    fn only_github_pages_are_allowed() {
        assert!(allowed_github_url("https://github.com/organizations/acme/settings/installations/42"));
        assert!(!allowed_github_url("http://github.com/x"));
        assert!(!allowed_github_url("https://github.com.evil.example/x"));
        assert!(!allowed_github_url("https://user@github.com/x"));
        assert!(!allowed_github_url("https://github.com:8443/x"));
        assert!(!allowed_github_url("javascript:alert(1)"));
    }
}
