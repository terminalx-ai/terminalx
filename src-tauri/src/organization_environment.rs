//! Native-only client for the active organization's cloud Environment
//! (PRO-15) and its recipes (PRO-20): the template with its machine install
//! script and per-repository setup, the versions built from it, rollback, and
//! the proposals an admin may apply.
//!
//! Same fencing as the compute policy client: the access token stays native,
//! every response is dropped if the account or organization changed while it
//! was in flight, and mutations refuse to send for a stale context revision.
//! A template edit also names the revision it expects, so two admins cannot
//! overwrite each other. Reads never start compute; a build and a retry do,
//! and are only sent with the person's explicit confirmation.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};
use url::Url;

use crate::account::{AccountContext, AccountManager};
use crate::organization_compute::OrganizationComputeError as EnvironmentError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;
const UNAVAILABLE: &str = "cloud_environment_unavailable";
const OUTCOME_UNKNOWN: &str = "cloud_environment_outcome_unknown";
const INVALID: &str = "cloud_workspace_request_invalid";
const CONFIRMATION_REQUIRED: &str = "cloud_environment_confirmation_required";

/// Codes the Environment routes can return. Anything else is collapsed so
/// the webview never renders arbitrary server text.
fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "invalid_access_token"
            | "active_organization_required"
            | "organization_admin_required"
            | "not_found"
            | "idempotency_key_reused"
            | "cloud_workspace_not_found"
            | "cloud_workspace_request_invalid"
            | "cloud_provider_not_found"
            | "cloud_provider_unavailable"
            | "cloud_provider_connection_required"
            | "cloud_provider_connection_attention_required"
            | "cloud_provisioning_paused"
            | "cloud_environment_not_found"
            | "cloud_environment_version_not_found"
            | "cloud_environment_provider_unsupported"
            | "cloud_environment_definition_invalid"
            | "cloud_environment_revision_conflict"
            | "cloud_environment_build_in_progress"
            | "cloud_environment_rollback_unavailable"
            | "cloud_environment_recipe_invalid"
            | "cloud_environment_recipe_not_found"
            | "cloud_environment_recipe_not_pending"
    )
}

fn local(code: &str) -> EnvironmentError {
    EnvironmentError::local(code)
}

#[derive(Clone, Copy)]
enum Method {
    Get,
    Put,
    Post,
}

impl Method {
    fn verb(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Put => "PUT",
            Self::Post => "POST",
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

    fn request(
        &self,
        context: &AccountContext,
        method: Method,
        tail: &[&str],
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Map<String, Value>, EnvironmentError> {
        let mut url = self.base.clone();
        {
            let mut segments = url.path_segments_mut().map_err(|_| local(UNAVAILABLE))?;
            segments.extend(["v1", "desktop", "orgs", context.organization_id.as_str()]);
            segments.extend(tail);
        }
        // Once a mutation is sent, a lost or unreadable response says nothing
        // about whether the server applied it.
        let lost = if matches!(method, Method::Get) { UNAVAILABLE } else { OUTCOME_UNKNOWN };
        let mut request = self.agent.request(method.verb(), url.as_str()).set("authorization", &format!("Bearer {}", context.access_token));
        if let Some(key) = idempotency_key {
            request = request.set("idempotency-key", key);
        }
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
                .ok_or_else(|| local(lost)),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response)),
            Err(ureq::Error::Transport(_)) => Err(local(lost)),
        }
    }
}

fn bounded_body(response: ureq::Response) -> Result<Vec<u8>, EnvironmentError> {
    let mut bytes = Vec::new();
    response.into_reader().take(RESPONSE_LIMIT_BYTES + 1).read_to_end(&mut bytes).map_err(|_| local(UNAVAILABLE))?;
    if bytes.len() as u64 > RESPONSE_LIMIT_BYTES {
        return Err(local(UNAVAILABLE));
    }
    Ok(bytes)
}

fn http_error(status: u16, response: ureq::Response) -> EnvironmentError {
    let code = bounded_body(response)
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_owned))
        .filter(|code| known_error_code(code))
        .unwrap_or_else(|| UNAVAILABLE.into());
    EnvironmentError { code, status: Some(status), retry_after_seconds: None }
}

/// A provider id as the server names them (`machine0`, `local-docker`).
fn is_provider(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A version or recipe id: one path segment, nothing that could leave it.
fn is_resource_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The server takes 1 to 128 printable ASCII characters; the webview sends a UUID.
fn is_idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn has_exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
}

pub struct OrganizationEnvironmentService {
    account: Arc<AccountManager>,
    client: Client,
}

impl OrganizationEnvironmentService {
    pub fn new(account: Arc<AccountManager>) -> Self {
        Self { account, client: Client::new(Url::parse(&crate::account::api_base_url()).expect("valid account service URL"), REQUEST_TIMEOUT) }
    }

    #[cfg(test)]
    fn for_test(account: Arc<AccountManager>, base: &str) -> Self {
        Self { account, client: Client::new(Url::parse(base).unwrap(), Duration::from_secs(2)) }
    }

    fn run(
        &self,
        expected_revision: Option<&str>,
        method: Method,
        tail: &[&str],
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, EnvironmentError> {
        let context = self.account.context().ok_or_else(|| local("account_signed_out"))?;
        if context.organization_id.is_empty() {
            return Err(local("account_organization_unavailable"));
        }
        let revision = AccountManager::context_revision(&context);
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(local("account_context_changed"));
        }
        let mutation = !matches!(method, Method::Get);
        let result = self.client.request(&context, method, tail, body, idempotency_key);
        if !self.account.is_current(&context) {
            // A definite HTTP refusal means nothing was applied, even if the
            // context changed meanwhile.
            let refused = matches!(&result, Err(error) if error.status.is_some());
            return Err(local(if mutation && !refused { "account_context_changed_after_send" } else { "account_context_changed" }));
        }
        let mut payload = result?;
        payload.insert("contextRevision".into(), Value::String(revision));
        Ok(Value::Object(payload))
    }

    /// The template, the active version and the build history. A plain read.
    pub fn status(&self, provider: &str) -> Result<Value, EnvironmentError> {
        if !is_provider(provider) {
            return Err(local(INVALID));
        }
        self.run(None, Method::Get, &["cloud-environments", provider], None, None)
    }

    /// Replaces the template's definition when it is still at `expected_revision`.
    /// The server validates the definition; this only refuses a body it would
    /// reject for its shape.
    pub fn update(&self, provider: &str, expected_revision: u64, definition: &Value, context_revision: &str) -> Result<Value, EnvironmentError> {
        if !is_provider(provider) || !has_exact_keys(definition, &["installScript", "repositories"]) {
            return Err(local(INVALID));
        }
        self.run(
            Some(context_revision),
            Method::Put,
            &["cloud-environments", provider],
            Some(json!({ "expectedRevision": expected_revision, "definition": definition })),
            None,
        )
    }

    /// Starts a build: a builder machine in the organization's provider
    /// account. Never sent without the person's confirmation of that spend.
    pub fn build(&self, provider: &str, idempotency_key: &str, confirm_provider_spend: bool, context_revision: &str) -> Result<Value, EnvironmentError> {
        if !confirm_provider_spend {
            return Err(local(CONFIRMATION_REQUIRED));
        }
        if !is_provider(provider) || !is_idempotency_key(idempotency_key) {
            return Err(local(INVALID));
        }
        self.run(
            Some(context_revision),
            Method::Post,
            &["cloud-environments", provider, "builds"],
            Some(json!({ "confirmProviderSpend": true })),
            Some(idempotency_key),
        )
    }

    /// One version, with its build log for owners and admins. A plain read.
    pub fn version(&self, version_id: &str) -> Result<Value, EnvironmentError> {
        if !is_resource_id(version_id) {
            return Err(local(INVALID));
        }
        self.run(None, Method::Get, &["cloud-environment-versions", version_id], None, None)
    }

    /// Rebuilds a failed version's configuration as a new version: a builder
    /// machine again, so the same confirmation as a build.
    pub fn retry(&self, version_id: &str, confirm_provider_spend: bool, context_revision: &str) -> Result<Value, EnvironmentError> {
        if !confirm_provider_spend {
            return Err(local(CONFIRMATION_REQUIRED));
        }
        self.version_action(version_id, "retry", json!({ "confirmProviderSpend": true }), context_revision)
    }

    pub fn cancel(&self, version_id: &str, context_revision: &str) -> Result<Value, EnvironmentError> {
        self.version_action(version_id, "cancel", json!({}), context_revision)
    }

    /// Makes a retained version the published one again. New workspaces
    /// launch from it; existing ones keep theirs.
    pub fn rollback(&self, version_id: &str, context_revision: &str) -> Result<Value, EnvironmentError> {
        self.version_action(version_id, "rollback", json!({}), context_revision)
    }

    fn version_action(&self, version_id: &str, action: &str, body: Value, context_revision: &str) -> Result<Value, EnvironmentError> {
        if !is_resource_id(version_id) {
            return Err(local(INVALID));
        }
        self.run(Some(context_revision), Method::Post, &["cloud-environment-versions", version_id, action], Some(body), None)
    }

    /// The proposals stored for this provider, newest first. A plain read.
    pub fn recipes(&self, provider: &str) -> Result<Value, EnvironmentError> {
        if !is_provider(provider) {
            return Err(local(INVALID));
        }
        self.run(None, Method::Get, &["cloud-environments", provider, "recipes"], None, None)
    }

    /// Stores a proposal: a definition with how its checks ended. It changes
    /// nothing by existing; only applying it writes the template. The server
    /// validates every field, this only refuses a body it would reject for
    /// its shape.
    pub fn propose_recipe(&self, provider: &str, recipe: &Value, context_revision: &str) -> Result<Value, EnvironmentError> {
        let with_source = has_exact_keys(recipe, &["baseRevision", "definition", "observations", "sourceWorkspaceId"]);
        if !is_provider(provider) || !(with_source || has_exact_keys(recipe, &["baseRevision", "definition", "observations"])) {
            return Err(local(INVALID));
        }
        if with_source && !recipe["sourceWorkspaceId"].as_str().is_some_and(is_resource_id) {
            return Err(local(INVALID));
        }
        self.run(Some(context_revision), Method::Post, &["cloud-environments", provider, "recipes"], Some(recipe.clone()), None)
    }

    /// Writes a recipe's definition into the template. It builds nothing; the
    /// person confirms replacing the template, not provider spend.
    pub fn apply_recipe(&self, recipe_id: &str, confirm_apply: bool, context_revision: &str) -> Result<Value, EnvironmentError> {
        if !confirm_apply {
            return Err(local(CONFIRMATION_REQUIRED));
        }
        self.recipe_action(recipe_id, "apply", json!({ "confirmApply": true }), context_revision)
    }

    pub fn dismiss_recipe(&self, recipe_id: &str, context_revision: &str) -> Result<Value, EnvironmentError> {
        self.recipe_action(recipe_id, "dismiss", json!({}), context_revision)
    }

    fn recipe_action(&self, recipe_id: &str, action: &str, body: Value, context_revision: &str) -> Result<Value, EnvironmentError> {
        if !is_resource_id(recipe_id) {
            return Err(local(INVALID));
        }
        self.run(Some(context_revision), Method::Post, &["cloud-environment-recipes", recipe_id, action], Some(body), None)
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

    /// Read one full HTTP request, body included, so a reply never races the upload.
    fn read_request(stream: &mut std::net::TcpStream) -> String {
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
        String::from_utf8_lossy(&request).into_owned()
    }

    fn serve_once(status: &str, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            stream.write_all(response.as_bytes()).unwrap();
            request
        });
        (base, handle)
    }

    /// A server that must not be reached: the listener is never accepted on.
    fn unreachable_base() -> String {
        "http://127.0.0.1:9".into()
    }

    fn service(base: &str) -> OrganizationEnvironmentService {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        OrganizationEnvironmentService::for_test(account, base)
    }

    fn revision() -> String {
        AccountManager::context_revision(&context())
    }

    const STATUS: &str = r#"{"provider":"local-docker","supported":true,"canManage":true,"rebuildRequired":false,"pendingChanges":[],"versions":[]}"#;

    #[test]
    fn reads_the_environment_with_a_context_revision_and_keeps_the_token_native() {
        let (base, server) = serve_once("200 OK", STATUS);
        let view = service(&base).status("local-docker").unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/desktop/orgs/org-1/cloud-environments/local-docker "));
        assert!(request.contains("authorization: Bearer native-secret-token"));
        assert_eq!(view["contextRevision"], revision());
        assert!(!view.to_string().contains("native-secret-token"));
    }

    #[test]
    fn sends_a_template_edit_with_the_revision_it_expects() {
        let (base, server) = serve_once("200 OK", STATUS);
        let definition = json!({ "installScript": "apt-get install -y jq", "repositories": [] });
        service(&base).update("local-docker", 4, &definition, &revision()).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("PUT /v1/desktop/orgs/org-1/cloud-environments/local-docker "));
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({ "expectedRevision": 4, "definition": definition }));
    }

    #[test]
    fn a_build_carries_the_confirmation_and_its_idempotency_key() {
        let (base, server) = serve_once("202 Accepted", r#"{"id":"version-1","state":"queued"}"#);
        service(&base).build("local-docker", "0b8f6a52-0c1f-4c35-9d0e-1d5d5a7d1c11", true, &revision()).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/desktop/orgs/org-1/cloud-environments/local-docker/builds "));
        assert!(request.to_ascii_lowercase().contains("idempotency-key: 0b8f6a52-0c1f-4c35-9d0e-1d5d5a7d1c11"));
        assert!(request.ends_with(r#"{"confirmProviderSpend":true}"#));
    }

    #[test]
    fn nothing_that_spends_or_replaces_is_sent_without_its_confirmation() {
        let environment = service(&unreachable_base());
        let revision = revision();
        assert_eq!(environment.build("local-docker", "0b8f6a52-0c1f-4c35", false, &revision).unwrap_err().code, CONFIRMATION_REQUIRED);
        assert_eq!(environment.retry("version-1", false, &revision).unwrap_err().code, CONFIRMATION_REQUIRED);
        assert_eq!(environment.apply_recipe("recipe-1", false, &revision).unwrap_err().code, CONFIRMATION_REQUIRED);
    }

    #[test]
    fn refuses_ids_that_would_leave_their_path_segment_before_sending() {
        let environment = service(&unreachable_base());
        let revision = revision();
        assert_eq!(environment.status("../cloud-compute").unwrap_err().code, INVALID);
        assert_eq!(environment.status("Local Docker").unwrap_err().code, INVALID);
        assert_eq!(environment.version("version/../../x").unwrap_err().code, INVALID);
        assert_eq!(environment.rollback("", &revision).unwrap_err().code, INVALID);
        assert_eq!(environment.dismiss_recipe("recipe?x=1", &revision).unwrap_err().code, INVALID);
        assert_eq!(environment.build("local-docker", "short", true, &revision).unwrap_err().code, INVALID);
        assert_eq!(environment.update("local-docker", 1, &json!({ "installScript": "" }), &revision).unwrap_err().code, INVALID);
    }

    #[test]
    fn version_and_recipe_actions_post_to_their_own_routes() {
        let revision = revision();
        for (action, path, body) in [
            ("retry", "/cloud-environment-versions/version-1/retry", r#"{"confirmProviderSpend":true}"#),
            ("cancel", "/cloud-environment-versions/version-1/cancel", "{}"),
            ("rollback", "/cloud-environment-versions/version-1/rollback", "{}"),
            ("apply", "/cloud-environment-recipes/recipe-1/apply", r#"{"confirmApply":true}"#),
            ("dismiss", "/cloud-environment-recipes/recipe-1/dismiss", "{}"),
        ] {
            let (base, server) = serve_once("200 OK", r#"{"id":"x"}"#);
            let environment = service(&base);
            match action {
                "retry" => environment.retry("version-1", true, &revision),
                "cancel" => environment.cancel("version-1", &revision),
                "rollback" => environment.rollback("version-1", &revision),
                "apply" => environment.apply_recipe("recipe-1", true, &revision),
                _ => environment.dismiss_recipe("recipe-1", &revision),
            }
            .unwrap();
            let request = server.join().unwrap();
            assert!(request.starts_with(&format!("POST /v1/desktop/orgs/org-1{path} ")), "{action}: {request}");
            assert!(request.ends_with(body), "{action}: {request}");
        }
    }

    #[test]
    fn stores_a_proposal_as_given_and_refuses_another_shape() {
        let recipe = json!({ "baseRevision": 3, "definition": { "installScript": "", "repositories": [] }, "observations": { "v": 1, "observedBy": "verification", "repositories": [] }, "sourceWorkspaceId": "workspace_1" });
        let (base, server) = serve_once("201 Created", r#"{"id":"recipe-1","state":"proposed"}"#);
        service(&base).propose_recipe("local-docker", &recipe, &revision()).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/desktop/orgs/org-1/cloud-environments/local-docker/recipes "));
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, recipe);

        let environment = service(&unreachable_base());
        assert_eq!(environment.propose_recipe("local-docker", &json!({ "definition": {} }), &revision()).unwrap_err().code, INVALID);
        let mut bad = recipe.clone();
        bad["sourceWorkspaceId"] = json!("../x");
        assert_eq!(environment.propose_recipe("local-docker", &bad, &revision()).unwrap_err().code, INVALID);
    }

    #[test]
    fn refuses_a_mutation_for_a_stale_context_without_sending() {
        let error = service(&unreachable_base()).rollback("version-1", "stale-revision").unwrap_err();
        assert_eq!(error.code, "account_context_changed");
        assert_eq!(error.status, None);
    }

    #[test]
    fn passes_known_refusals_through_and_collapses_anything_else() {
        let (base, server) = serve_once("409 Conflict", r#"{"error":"cloud_environment_revision_conflict"}"#);
        let error = service(&base).apply_recipe("recipe-1", true, &revision()).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "cloud_environment_revision_conflict");
        assert_eq!(error.status, Some(409));

        let (base, server) = serve_once("500 Internal Server Error", r#"{"error":"<script>"}"#);
        let error = service(&base).recipes("local-docker").unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, UNAVAILABLE);
    }

    #[test]
    fn reports_an_unknown_outcome_when_a_sent_change_loses_its_response() {
        let (base, server) = serve_once("200 OK", "not json");
        let error = service(&base).rollback("version-1", &revision()).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, OUTCOME_UNKNOWN);

        let (base, server) = serve_once("200 OK", "not json");
        let error = service(&base).status("local-docker").unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, UNAVAILABLE);
    }

    #[test]
    fn a_response_that_arrives_after_a_sign_out_is_dropped() {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let signer = account.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            signer.set_context_for_test(None);
            let response = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{STATUS}", STATUS.len());
            stream.write_all(response.as_bytes()).unwrap();
        });
        let error = OrganizationEnvironmentService::for_test(account, &base).status("local-docker").unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "account_context_changed");
    }
}
