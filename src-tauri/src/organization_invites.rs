//! Native-only client for the invitations addressed to the signed-in person
//! (PRO-175): list them, read what the inviting organization has ready, and
//! accept or decline.
//!
//! The access token stays native. These routes are the viewer's own, not an
//! organization's, so the call is fenced on the account (a response that lands
//! after sign-out or an account change is dropped), not on the organization.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use url::Url;

use crate::account::{AccountContext, AccountManager};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 1024 * 1024;
const UNAVAILABLE: &str = "organization_invites_unavailable";
const OUTCOME_UNKNOWN: &str = "organization_invites_outcome_unknown";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationInvitesError {
    pub code: String,
    pub status: Option<u16>,
}

impl OrganizationInvitesError {
    pub(crate) fn local(code: &str) -> Self {
        Self { code: code.into(), status: None }
    }
}

/// Codes the server's invite routes can return. Anything else is collapsed so
/// the webview never renders arbitrary server text.
fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "unauthorized"
            | "not_found"
            | "invite_expired"
            | "email_unverified"
            | "invite_requires_pro"
            | "organization_member_limit_reached"
            | "invites_welcome_unavailable"
    )
}

/// What the webview may ask for. The id is put in the path, so it is checked
/// to be one segment of plain characters.
pub enum InviteRequest<'a> {
    List,
    Welcome(&'a str),
    Accept(&'a str),
    Decline(&'a str),
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

struct Client {
    base: Url,
    agent: ureq::Agent,
}

impl Client {
    fn new(base: Url, timeout: Duration) -> Self {
        Self { base, agent: crate::data_privacy::http_agent().timeout(timeout).redirects(0).build() }
    }

    fn request(&self, context: &AccountContext, request: &InviteRequest) -> Result<Map<String, Value>, OrganizationInvitesError> {
        let (method, tail): (&str, Vec<&str>) = match request {
            InviteRequest::List => ("GET", vec![]),
            InviteRequest::Welcome(id) => ("GET", vec![*id, "welcome"]),
            InviteRequest::Accept(id) => ("POST", vec![*id, "accept"]),
            InviteRequest::Decline(id) => ("POST", vec![*id, "decline"]),
        };
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| OrganizationInvitesError::local(UNAVAILABLE))?
            .extend(["v1", "desktop", "invites"])
            .extend(tail);
        if matches!(request, InviteRequest::List) {
            // Recently expired ones too, while the server has the key on.
            url.set_query(Some("expired=1"));
        }
        let mutation = method == "POST";
        // Once a mutation is sent, a lost or unreadable response says nothing
        // about whether the server applied it.
        let lost = if mutation { OUTCOME_UNKNOWN } else { UNAVAILABLE };
        let call = self.agent.request(method, url.as_str()).set("authorization", &format!("Bearer {}", context.access_token));
        let response = if mutation { call.set("content-type", "application/json").send_string("{}") } else { call.call() };
        match response {
            Ok(response) => bounded_body(response)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|value| match value {
                    Value::Object(map) => Some(map),
                    _ => None,
                })
                .ok_or_else(|| OrganizationInvitesError::local(lost)),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response)),
            Err(ureq::Error::Transport(_)) => Err(OrganizationInvitesError::local(lost)),
        }
    }
}

fn bounded_body(response: ureq::Response) -> Result<Vec<u8>, OrganizationInvitesError> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(RESPONSE_LIMIT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| OrganizationInvitesError::local(UNAVAILABLE))?;
    if bytes.len() as u64 > RESPONSE_LIMIT_BYTES {
        return Err(OrganizationInvitesError::local(UNAVAILABLE));
    }
    Ok(bytes)
}

fn http_error(status: u16, response: ureq::Response) -> OrganizationInvitesError {
    let code = bounded_body(response)
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_owned))
        .filter(|code| known_error_code(code))
        .unwrap_or_else(|| UNAVAILABLE.into());
    OrganizationInvitesError { code, status: Some(status) }
}

pub struct OrganizationInvitesService {
    account: Arc<AccountManager>,
    client: Client,
}

impl OrganizationInvitesService {
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

    pub fn run(&self, request: InviteRequest) -> Result<Value, OrganizationInvitesError> {
        if let InviteRequest::Welcome(id) | InviteRequest::Accept(id) | InviteRequest::Decline(id) = &request {
            if !valid_id(id) {
                return Err(OrganizationInvitesError::local("invalid_request"));
            }
        }
        let context = self.account.context().ok_or_else(|| OrganizationInvitesError::local("account_signed_out"))?;
        // The same rule as the server's: an invitee is not a member of the
        // inviting organization, so any of their organizations reporting the
        // key turns these routes on. Nothing is sent while none does.
        if !self.account.phase2_ready(crate::account::PHASE2_INVITES_WELCOME, None, Some(&context)) {
            return Err(OrganizationInvitesError::local("invites_welcome_unavailable"));
        }
        let mutation = !matches!(request, InviteRequest::List | InviteRequest::Welcome(_));
        let result = self.client.request(&context, &request);
        if !self.account.is_current(&context) {
            let refused = matches!(&result, Err(error) if error.status.is_some());
            return Err(OrganizationInvitesError::local(if mutation && !refused {
                "account_context_changed_after_send"
            } else {
                "account_context_changed"
            }));
        }
        result.map(Value::Object)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    use serde_json::json;

    use super::*;

    fn context() -> AccountContext {
        AccountContext {
            access_token: "native-secret-token".into(),
            user_id: "user-1".into(),
            email: "invitee@example.com".into(),
            display_name: "Invitee".into(),
            profile_id: "profile-1".into(),
            organization_id: "personal-1".into(),
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
            stream.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap_or(0);
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if read == 0 || (text.contains("\r\n\r\n") && (text.starts_with("GET") || text.ends_with("{}"))) {
                    break;
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (base, handle)
    }

    fn ready(account: &AccountManager, enabled: bool) {
        account.set_memberships_for_test(&["personal-1"], true);
        account.apply_phase2_readiness_for_test(json!({
            "version": 1,
            "organizations": { "personal-1": { (crate::account::PHASE2_INVITES_WELCOME): enabled } }
        }));
    }

    fn service(base: &str) -> OrganizationInvitesService {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        ready(&account, true);
        OrganizationInvitesService::for_test(account, base)
    }

    #[test]
    fn lists_the_viewers_invitations_with_recently_expired_ones() {
        let (base, server) = serve_once("200 OK", r#"{"invites":[{"id":"invite-1","organizationName":"Orbit Labs","role":"member","expiresAt":2}]}"#);
        let invites = service(&base).run(InviteRequest::List).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/desktop/invites?expired=1 "));
        assert!(request.contains("authorization: Bearer native-secret-token"));
        assert_eq!(invites["invites"][0]["organizationName"], "Orbit Labs");
    }

    #[test]
    fn reads_the_welcome_and_posts_accept_by_the_invites_own_path() {
        let (base, server) = serve_once("200 OK", r#"{"organizationName":"Orbit Labs","agents":[]}"#);
        service(&base).run(InviteRequest::Welcome("invite-1")).unwrap();
        assert!(server.join().unwrap().starts_with("GET /v1/desktop/invites/invite-1/welcome "));

        let (base, server) = serve_once("200 OK", r#"{"organizationId":"org-2","organizationName":"Orbit Labs","role":"member"}"#);
        let joined = service(&base).run(InviteRequest::Accept("invite-1")).unwrap();
        assert!(server.join().unwrap().starts_with("POST /v1/desktop/invites/invite-1/accept "));
        assert_eq!(joined["organizationId"], "org-2");
    }

    #[test]
    fn keeps_known_refusals_and_collapses_others() {
        let (base, server) = serve_once("404 Not Found", r#"{"error":"invites_welcome_unavailable"}"#);
        let error = service(&base).run(InviteRequest::Welcome("invite-1")).unwrap_err();
        server.join().unwrap();
        assert_eq!(error, OrganizationInvitesError { code: "invites_welcome_unavailable".into(), status: Some(404) });

        let (base, server) = serve_once("500 Internal Server Error", r#"{"error":"something <b>odd</b>"}"#);
        let error = service(&base).run(InviteRequest::Decline("invite-1")).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, UNAVAILABLE);
    }

    #[test]
    fn refuses_an_id_that_is_not_one_plain_path_segment() {
        let invites = service("http://127.0.0.1:9");
        for id in ["", "../orgs", "a/b", "a?b", &"x".repeat(129)] {
            assert_eq!(invites.run(InviteRequest::Accept(id)).unwrap_err().code, "invalid_request");
        }
    }

    #[test]
    fn signed_out_sends_nothing() {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(None);
        let invites = OrganizationInvitesService::for_test(account, "http://127.0.0.1:9");
        assert_eq!(invites.run(InviteRequest::List).unwrap_err().code, "account_signed_out");
    }

    #[test]
    fn sends_nothing_while_no_organization_reports_the_readiness_key() {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        ready(&account, false);
        // Port 9 would refuse; the refusal comes first, before any request.
        let invites = OrganizationInvitesService::for_test(account, "http://127.0.0.1:9");
        assert_eq!(invites.run(InviteRequest::List).unwrap_err().code, "invites_welcome_unavailable");
        assert_eq!(invites.run(InviteRequest::Accept("invite-1")).unwrap_err().code, "invites_welcome_unavailable");
    }

    #[test]
    fn an_accept_whose_answer_is_lost_reports_an_unknown_outcome() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer);
            // Closed with no answer: the server may have applied it.
        });
        let error = service(&base).run(InviteRequest::Accept("invite-1")).unwrap_err();
        server.join().unwrap();
        assert_eq!(error, OrganizationInvitesError::local(OUTCOME_UNKNOWN));
    }

    #[test]
    fn an_answer_that_lands_after_the_account_changed_is_dropped() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let invites = Arc::new(service(&base));
        let account = invites.account.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer);
            // Another account signs in while the accept is in flight.
            account.set_context_for_test(Some(AccountContext { access_token: "other".into(), generation: 4, ..context() }));
            let body = r#"{"organizationId":"org-2","organizationName":"Orbit Labs","role":"member"}"#;
            let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes());
        });
        let error = invites.run(InviteRequest::Accept("invite-1")).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "account_context_changed_after_send");

        // A list read is dropped the same way, without claiming anything was sent.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let invites = Arc::new(service(&base));
        let account = invites.account.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer);
            account.set_context_for_test(None);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 14\r\nconnection: close\r\n\r\n{\"invites\":[]}");
        });
        assert_eq!(invites.run(InviteRequest::List).unwrap_err().code, "account_context_changed");
        server.join().unwrap();
    }
}
