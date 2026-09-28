//! Native-only client for the active organization's member roster.
//!
//! The access token never crosses into the webview. Every call is fenced on
//! the account context it started in: a response that lands after sign-out,
//! account replacement, or an organization switch is dropped, and mutations
//! refuse to send when the caller's context revision is stale.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::account::{AccountContext, AccountManager};

const ACCOUNT_BASE_URL: &str = "https://login.terminalx.ai";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS: u64 = 60 * 60;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationMember {
    pub user_id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photo_url: Option<String>,
    pub role: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingInvite {
    pub email: String,
    pub role: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// Older servers omit it; the webview treats a missing status as pending.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssuedInvite {
    pub email: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite_url: Option<String>,
    #[serde(default)]
    pub email_sent: bool,
    #[serde(default)]
    pub deduplicated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationRoster {
    pub members: Vec<OrganizationMember>,
    pub pending_invites: Vec<PendingInvite>,
    pub viewer_role: String,
    pub can_manage_members: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite: Option<IssuedInvite>,
    /// Filled natively so the webview can fence its next mutation.
    #[serde(default)]
    pub context_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationMembersError {
    pub code: String,
    pub status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
}

impl OrganizationMembersError {
    pub(crate) fn local(code: &str) -> Self {
        Self { code: code.into(), status: None, retry_after_seconds: None }
    }
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: String,
}

/// Codes the server's desktop member routes can return. Anything else is
/// collapsed so the webview never renders arbitrary server text.
fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "unauthorized"
            | "forbidden"
            | "not_found"
            | "invalid_request"
            | "invalid_email"
            | "already_member"
            | "personal_org_no_invites"
            | "organization_requires_pro"
            | "invite_rate_limited"
            | "invite_recently_sent"
            | "cannot_change_own_role"
            | "cannot_change_owner_role"
            | "cannot_remove_owner"
            | "cannot_remove_self"
    )
}

struct Client {
    base: Url,
    timeout: Duration,
}

impl Client {
    fn request<T: DeserializeOwned>(
        &self,
        context: &AccountContext,
        tail: &[&str],
        body: Option<Value>,
    ) -> Result<T, OrganizationMembersError> {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| OrganizationMembersError::local("organization_members_unavailable"))?
            .extend(["v1", "desktop", "orgs", context.organization_id.as_str()])
            .extend(tail.iter().copied());
        let agent = ureq::AgentBuilder::new().timeout(self.timeout).redirects(0).build();
        let request = agent
            .request(if body.is_some() { "POST" } else { "GET" }, url.as_str())
            .set("authorization", &format!("Bearer {}", context.access_token));
        let response = match body {
            Some(body) => request.set("content-type", "application/json").send_json(body),
            None => request.call(),
        };
        match response {
            Ok(response) => serde_json::from_slice(&bounded_body(response)?)
                .map_err(|_| OrganizationMembersError::local("organization_members_unavailable")),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response)),
            Err(ureq::Error::Transport(_)) => {
                Err(OrganizationMembersError::local("organization_members_unavailable"))
            }
        }
    }
}

fn bounded_body(response: ureq::Response) -> Result<Vec<u8>, OrganizationMembersError> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(RESPONSE_LIMIT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| OrganizationMembersError::local("organization_members_unavailable"))?;
    if bytes.len() as u64 > RESPONSE_LIMIT_BYTES {
        return Err(OrganizationMembersError::local("organization_members_unavailable"));
    }
    Ok(bytes)
}

fn http_error(status: u16, response: ureq::Response) -> OrganizationMembersError {
    let retry_after_seconds = response
        .header("Retry-After")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.min(MAX_RETRY_AFTER_SECONDS));
    let code = bounded_body(response)
        .ok()
        .and_then(|body| serde_json::from_slice::<ErrorEnvelope>(&body).ok())
        .map(|envelope| envelope.error)
        .filter(|code| known_error_code(code))
        .unwrap_or_else(|| "organization_members_unavailable".into());
    OrganizationMembersError { code, status: Some(status), retry_after_seconds }
}

pub struct OrganizationMembersService {
    account: Arc<AccountManager>,
    client: Client,
}

impl OrganizationMembersService {
    pub fn new(account: Arc<AccountManager>) -> Self {
        Self {
            account,
            client: Client {
                base: Url::parse(ACCOUNT_BASE_URL).expect("valid account service URL"),
                timeout: REQUEST_TIMEOUT,
            },
        }
    }

    #[cfg(test)]
    fn for_test(account: Arc<AccountManager>, base: &str) -> Self {
        Self {
            account,
            client: Client { base: Url::parse(base).unwrap(), timeout: Duration::from_secs(2) },
        }
    }

    fn context(&self) -> Result<AccountContext, OrganizationMembersError> {
        let context = self
            .account
            .context()
            .ok_or_else(|| OrganizationMembersError::local("account_signed_out"))?;
        if context.organization_id.is_empty() {
            return Err(OrganizationMembersError::local("account_organization_unavailable"));
        }
        Ok(context)
    }

    fn run(
        &self,
        expected_revision: Option<&str>,
        tail: &[&str],
        body: Option<Value>,
    ) -> Result<OrganizationRoster, OrganizationMembersError> {
        let context = self.context()?;
        let revision = AccountManager::context_revision(&context);
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(OrganizationMembersError::local("account_context_changed"));
        }
        let result = self.client.request::<OrganizationRoster>(&context, tail, body);
        if !self.account.is_current(&context) {
            return Err(OrganizationMembersError::local("account_context_changed"));
        }
        let mut roster = result?;
        roster.context_revision = revision;
        Ok(roster)
    }

    pub fn list(&self) -> Result<OrganizationRoster, OrganizationMembersError> {
        self.run(None, &["members"], None)
    }

    pub fn invite(
        &self,
        email: &str,
        role: &str,
        context_revision: &str,
    ) -> Result<OrganizationRoster, OrganizationMembersError> {
        let email = email.trim();
        if email.is_empty() || !assignable(role) {
            return Err(OrganizationMembersError::local("invalid_request"));
        }
        self.run(Some(context_revision), &["invites"], Some(json!({ "email": email, "role": role })))
    }

    pub fn revoke_invite(
        &self,
        email: &str,
        context_revision: &str,
    ) -> Result<OrganizationRoster, OrganizationMembersError> {
        self.run(Some(context_revision), &["invites", "revoke"], Some(json!({ "email": email.trim() })))
    }

    pub fn update_role(
        &self,
        user_id: &str,
        role: &str,
        context_revision: &str,
    ) -> Result<OrganizationRoster, OrganizationMembersError> {
        if user_id.trim().is_empty() || !assignable(role) {
            return Err(OrganizationMembersError::local("invalid_request"));
        }
        self.run(
            Some(context_revision),
            &["members", "role"],
            Some(json!({ "userId": user_id.trim(), "role": role })),
        )
    }

    pub fn remove(
        &self,
        user_id: &str,
        context_revision: &str,
    ) -> Result<OrganizationRoster, OrganizationMembersError> {
        if user_id.trim().is_empty() {
            return Err(OrganizationMembersError::local("invalid_request"));
        }
        self.run(Some(context_revision), &["members", "remove"], Some(json!({ "userId": user_id.trim() })))
    }
}

fn assignable(role: &str) -> bool {
    role == "admin" || role == "member"
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

    /// Serve one canned HTTP response and hand back the raw request text.
    fn serve_once(status: &str, headers: &str, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}",
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

    fn service(base: &str) -> OrganizationMembersService {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        OrganizationMembersService::for_test(account, base)
    }

    const ROSTER: &str = r#"{"members":[{"userId":"user-1","email":"owner@example.com","role":"owner"}],"pendingInvites":[{"email":"new@example.com","role":"member","createdAt":1,"expiresAt":2,"status":"pending"}],"viewerRole":"owner","canManageMembers":true}"#;

    #[test]
    fn lists_the_active_organization_roster_with_a_context_revision() {
        let (base, server) = serve_once("200 OK", "", ROSTER);
        let roster = service(&base).list().unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/desktop/orgs/org-1/members "));
        assert!(request.contains("authorization: Bearer native-secret-token"));
        assert_eq!(roster.members[0].role, "owner");
        assert_eq!(roster.pending_invites[0].status.as_deref(), Some("pending"));
        assert_eq!(roster.context_revision, AccountManager::context_revision(&context()));
        // The token is native-only; nothing serialized for the webview carries it.
        assert!(!serde_json::to_string(&roster).unwrap().contains("native-secret-token"));
    }

    #[test]
    fn invites_with_a_matching_revision_and_surfaces_the_issued_link() {
        let body = ROSTER.replacen(
            "\"canManageMembers\":true",
            "\"canManageMembers\":true,\"invite\":{\"email\":\"new@example.com\",\"role\":\"admin\",\"inviteUrl\":\"https://console.test/invite/t\",\"emailSent\":false}",
            1,
        );
        let (base, server) = serve_once("200 OK", "", &body);
        let revision = AccountManager::context_revision(&context());
        let roster = service(&base).invite(" new@example.com ", "admin", &revision).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/desktop/orgs/org-1/invites "));
        assert!(request.contains(r#""email":"new@example.com""#));
        assert!(request.contains(r#""role":"admin""#));
        let invite = roster.invite.unwrap();
        assert_eq!(invite.invite_url.as_deref(), Some("https://console.test/invite/t"));
        assert!(!invite.email_sent);
    }

    #[test]
    fn refuses_to_send_a_mutation_for_a_stale_context() {
        let service = service("http://127.0.0.1:9");
        let error = service.remove("user-2", "stale-revision").unwrap_err();
        assert_eq!(error.code, "account_context_changed");
        let error = service.update_role("user-2", "owner", "stale-revision").unwrap_err();
        assert_eq!(error.code, "invalid_request");
    }

    #[test]
    fn maps_known_server_codes_and_retry_after() {
        let (base, server) = serve_once(
            "429 Too Many Requests",
            "retry-after: 42\r\n",
            r#"{"error":"invite_recently_sent"}"#,
        );
        let revision = AccountManager::context_revision(&context());
        let error = service(&base).invite("new@example.com", "member", &revision).unwrap_err();
        server.join().unwrap();
        assert_eq!(
            error,
            OrganizationMembersError {
                code: "invite_recently_sent".into(),
                status: Some(429),
                retry_after_seconds: Some(42),
            }
        );
    }

    #[test]
    fn collapses_unknown_server_text() {
        let (base, server) = serve_once("500 Internal Server Error", "", r#"{"error":"<script>"}"#);
        let error = service(&base).list().unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "organization_members_unavailable");
        assert_eq!(error.status, Some(500));
    }

    #[test]
    fn drops_a_response_that_lands_after_sign_out() {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let signer = account.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer);
            signer.set_context_for_test(None);
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{ROSTER}",
                ROSTER.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let error = OrganizationMembersService::for_test(account, &base).list().unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "account_context_changed");
    }
}
