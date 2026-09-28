//! Native-only client for the active organization's cloud workspace
//! configuration (PRO-19): organization defaults, repository configuration,
//! per-workspace layers, and the secrets vault with its bindings.
//!
//! Same fencing as the compute policy client: the access token stays native,
//! every response is dropped if the account or organization changed while it
//! was in flight, and mutations refuse to send for a stale context revision.
//! Layer edits also carry the layer version, so two admins cannot overwrite
//! each other. A secret value passes through here once, on its way to the
//! server, and is never returned: the server only ever answers with a mask.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};
use url::Url;
use zeroize::Zeroizing;

use crate::account::{AccountContext, AccountManager};
use crate::organization_compute::OrganizationComputeError as ConfigError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const UNAVAILABLE: &str = "cloud_workspace_config_unavailable";
const OUTCOME_UNKNOWN: &str = "cloud_workspace_config_outcome_unknown";
const INVALID: &str = "cloud_workspace_request_invalid";

/// Codes the configuration routes can return. Anything else is collapsed so
/// the webview never renders arbitrary server text.
fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "invalid_access_token"
            | "active_organization_required"
            | "organization_admin_required"
            | "cloud_workspace_not_found"
            | "cloud_workspace_request_invalid"
            | "cloud_workspace_config_conflict"
            | "cloud_workspace_config_env_invalid"
            | "cloud_workspace_config_mcp_invalid"
            | "cloud_workspace_config_secret_missing"
            | "cloud_workspace_config_override_denied"
            | "cloud_workspace_secret_invalid"
            | "cloud_workspace_secret_not_found"
            | "cloud_workspace_secret_binding_conflict"
            | "cloud_workspace_config_unavailable"
    )
}

fn local(code: &str) -> ConfigError {
    ConfigError::local(code)
}

#[derive(Clone, Copy)]
enum Method {
    Get,
    Put,
    Post,
    Delete,
}

impl Method {
    fn verb(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Put => "PUT",
            Self::Post => "POST",
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

    /// `body` is serialized JSON, in a buffer wiped once sent: it can hold a
    /// secret value.
    fn request(&self, context: &AccountContext, method: Method, tail: &[&str], body: Option<Zeroizing<Vec<u8>>>) -> Result<Map<String, Value>, ConfigError> {
        let mut url = self.base.clone();
        {
            let mut segments = url.path_segments_mut().map_err(|_| local(UNAVAILABLE))?;
            segments.extend(["v1", "desktop", "orgs", context.organization_id.as_str(), "cloud-workspace-config"]);
            segments.extend(tail);
        }
        let mutation = !matches!(method, Method::Get);
        let lost = if mutation { OUTCOME_UNKNOWN } else { UNAVAILABLE };
        let request = self.agent.request(method.verb(), url.as_str()).set("authorization", &format!("Bearer {}", context.access_token));
        let response = match body {
            Some(bytes) => request.set("content-type", "application/json").send_bytes(&bytes),
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

fn bounded_body(response: ureq::Response) -> Result<Vec<u8>, ConfigError> {
    let mut bytes = Vec::new();
    response.into_reader().take(RESPONSE_LIMIT_BYTES + 1).read_to_end(&mut bytes).map_err(|_| local(UNAVAILABLE))?;
    if bytes.len() as u64 > RESPONSE_LIMIT_BYTES {
        return Err(local(UNAVAILABLE));
    }
    Ok(bytes)
}

fn http_error(status: u16, response: ureq::Response) -> ConfigError {
    let code = bounded_body(response)
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_owned))
        .filter(|code| known_error_code(code))
        .unwrap_or_else(|| UNAVAILABLE.into());
    ConfigError { code, status: Some(status), retry_after_seconds: None }
}

fn json_body(value: &impl serde::Serialize) -> Result<Zeroizing<Vec<u8>>, ConfigError> {
    serde_json::to_vec(value).map(Zeroizing::new).map_err(|_| local(INVALID))
}

/// A secret's body, serialized straight from borrowed text so the value is
/// never copied into a `serde_json::Value` that would not be wiped.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretBody<'a> {
    value: &'a str,
    runtime_access: &'a str,
}

/// A vault name: the naming pattern only. Whether a name may be stored is
/// the server's call; delete and bind must still work for any stored name.
fn is_secret_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 128 && chars.next().is_some_and(|c| c.is_ascii_uppercase() || c == '_') && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn has_exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
}

const LAYER_KEYS: [&str; 4] = ["expectedVersion", "env", "prompt", "mcpServers"];

fn is_path_segment(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub struct WorkspaceConfigService {
    account: Arc<AccountManager>,
    client: Client,
}

impl WorkspaceConfigService {
    pub fn new(account: Arc<AccountManager>) -> Self {
        Self { account, client: Client::new(Url::parse(&crate::account::api_base_url()).expect("valid account service URL"), REQUEST_TIMEOUT) }
    }

    #[cfg(test)]
    fn for_test(account: Arc<AccountManager>, base: &str) -> Self {
        Self { account, client: Client::new(Url::parse(base).unwrap(), Duration::from_secs(2)) }
    }

    fn run(&self, expected_revision: Option<&str>, method: Method, tail: &[&str], body: Option<Zeroizing<Vec<u8>>>) -> Result<Value, ConfigError> {
        let context = self.account.context().ok_or_else(|| local("account_signed_out"))?;
        if context.organization_id.is_empty() {
            return Err(local("account_organization_unavailable"));
        }
        let revision = AccountManager::context_revision(&context);
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(local("account_context_changed"));
        }
        let mutation = !matches!(method, Method::Get);
        let result = self.client.request(&context, method, tail, body);
        if !self.account.is_current(&context) {
            let refused = matches!(&result, Err(error) if error.status.is_some());
            return Err(local(if mutation && !refused { "account_context_changed_after_send" } else { "account_context_changed" }));
        }
        let mut payload = result?;
        payload.insert("contextRevision".into(), Value::String(revision));
        Ok(Value::Object(payload))
    }

    pub fn organization(&self) -> Result<Value, ConfigError> {
        self.run(None, Method::Get, &["organization"], None)
    }

    pub fn update_organization(&self, layer: &Value, context_revision: &str) -> Result<Value, ConfigError> {
        let keys = [&LAYER_KEYS[..], &["memberOverrides", "lockedEnvKeys"]].concat();
        if !has_exact_keys(layer, &keys) {
            return Err(local(INVALID));
        }
        self.run(Some(context_revision), Method::Put, &["organization"], Some(json_body(layer)?))
    }

    pub fn update_repository(&self, layer: &Value, context_revision: &str) -> Result<Value, ConfigError> {
        let keys = [&LAYER_KEYS[..], &["repository"]].concat();
        if !has_exact_keys(layer, &keys) {
            return Err(local(INVALID));
        }
        self.run(Some(context_revision), Method::Put, &["repository"], Some(json_body(layer)?))
    }

    pub fn workspace(&self, workspace_id: &str) -> Result<Value, ConfigError> {
        if !is_path_segment(workspace_id) {
            return Err(local(INVALID));
        }
        self.run(None, Method::Get, &["workspaces", workspace_id], None)
    }

    pub fn update_workspace(&self, workspace_id: &str, layer: &Value, context_revision: &str) -> Result<Value, ConfigError> {
        if !is_path_segment(workspace_id) || !has_exact_keys(layer, &LAYER_KEYS) {
            return Err(local(INVALID));
        }
        self.run(Some(context_revision), Method::Put, &["workspaces", workspace_id], Some(json_body(layer)?))
    }

    pub fn secrets(&self) -> Result<Value, ConfigError> {
        self.run(None, Method::Get, &["secrets"], None)
    }

    pub fn put_secret(&self, name: &str, value: Zeroizing<String>, runtime_access: &str, context_revision: &str) -> Result<Value, ConfigError> {
        if !crate::cloud_config::is_injectable_name(name) || value.is_empty() || !matches!(runtime_access, "private-workspaces" | "all-workspaces") {
            return Err(local("cloud_workspace_secret_invalid"));
        }
        let body = json_body(&SecretBody { value: value.as_str(), runtime_access })?;
        self.run(Some(context_revision), Method::Put, &["secrets", name], Some(body))
    }

    pub fn delete_secret(&self, name: &str, context_revision: &str) -> Result<Value, ConfigError> {
        if !is_secret_name(name) {
            return Err(local("cloud_workspace_secret_invalid"));
        }
        self.run(Some(context_revision), Method::Delete, &["secrets", name], None)
    }

    pub fn bind_secret(&self, name: &str, scope: &str, target: &str, env_name: &str, context_revision: &str) -> Result<Value, ConfigError> {
        if !is_secret_name(name) || !crate::cloud_config::is_injectable_name(env_name) || !matches!(scope, "organization" | "repository" | "workspace") {
            return Err(local(INVALID));
        }
        self.run(
            Some(context_revision),
            Method::Post,
            &["secrets", name, "bindings"],
            Some(json_body(&json!({ "scope": scope, "target": target, "envName": env_name }))?),
        )
    }

    pub fn unbind_secret(&self, binding_id: &str, context_revision: &str) -> Result<Value, ConfigError> {
        if !is_path_segment(binding_id) {
            return Err(local(INVALID));
        }
        self.run(Some(context_revision), Method::Delete, &["secret-bindings", binding_id], None)
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

    fn service(base: &str) -> WorkspaceConfigService {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        WorkspaceConfigService::for_test(account, base)
    }

    fn revision() -> String {
        AccountManager::context_revision(&context())
    }

    #[test]
    fn reads_the_organization_layer_with_a_context_revision_and_keeps_the_token_native() {
        let (base, server) = serve_once("200 OK", r#"{"organization":{"version":1},"repositories":[],"canEdit":true}"#);
        let view = service(&base).organization().unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspace-config/organization "));
        assert!(request.contains("authorization: Bearer native-secret-token"));
        assert_eq!(view["contextRevision"], revision());
        assert!(!view.to_string().contains("native-secret-token"));
    }

    #[test]
    fn sends_a_secret_once_and_never_returns_it() {
        let (base, server) = serve_once("200 OK", r#"{"secrets":[{"name":"NPM_TOKEN","value":"********"}],"canEdit":true}"#);
        let view = service(&base).put_secret("NPM_TOKEN", Zeroizing::new("npm_value_123".into()), "private-workspaces", &revision()).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("PUT /v1/desktop/orgs/org-1/cloud-workspace-config/secrets/NPM_TOKEN "));
        assert!(request.contains(r#""value":"npm_value_123""#));
        assert!(!view.to_string().contains("npm_value_123"));
    }

    #[test]
    fn a_stored_secret_under_a_reserved_name_can_still_be_deleted_and_bound_elsewhere() {
        let (base, server) = serve_once("200 OK", r#"{"secrets":[],"canEdit":true}"#);
        service(&base).delete_secret("GITHUB_TOKEN", &revision()).unwrap();
        assert!(server.join().unwrap().starts_with("DELETE /v1/desktop/orgs/org-1/cloud-workspace-config/secrets/GITHUB_TOKEN "));
        let (base, server) = serve_once("200 OK", r#"{"secrets":[],"canEdit":true}"#);
        service(&base).bind_secret("GITHUB_TOKEN", "organization", "", "GH_PAT", &revision()).unwrap();
        assert!(server.join().unwrap().contains(r#""envName":"GH_PAT""#));
    }

    #[test]
    fn binds_and_unbinds_with_the_right_routes() {
        let (base, server) = serve_once("200 OK", r#"{"secrets":[],"canEdit":true}"#);
        service(&base).bind_secret("NPM_TOKEN", "repository", "github.com/acme/app", "NPM_TOKEN", &revision()).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspace-config/secrets/NPM_TOKEN/bindings "));
        assert!(request.contains(r#""target":"github.com/acme/app""#));

        let (base, server) = serve_once("200 OK", r#"{"secrets":[],"canEdit":true}"#);
        service(&base).unbind_secret("binding_1", &revision()).unwrap();
        assert!(server.join().unwrap().starts_with("DELETE /v1/desktop/orgs/org-1/cloud-workspace-config/secret-bindings/binding_1 "));
    }

    #[test]
    fn refuses_stale_contexts_malformed_layers_and_reserved_names_before_sending() {
        let service = service("http://127.0.0.1:9");
        let layer = json!({ "expectedVersion": 0, "env": {}, "prompt": null, "mcpServers": [] });
        assert_eq!(service.update_workspace("ws_1", &layer, "stale").unwrap_err().code, "account_context_changed");
        assert_eq!(service.update_organization(&layer, &revision()).unwrap_err().code, INVALID);
        assert_eq!(service.update_workspace("../x", &layer, &revision()).unwrap_err().code, INVALID);
        assert_eq!(service.bind_secret("GITHUB_TOKEN", "organization", "", "GITHUB_TOKEN", &revision()).unwrap_err().code, INVALID);
        assert_eq!(
            service.put_secret("HCLOUD_TOKEN", Zeroizing::new("x".into()), "all-workspaces", &revision()).unwrap_err().code,
            "cloud_workspace_secret_invalid"
        );
    }

    #[test]
    fn maps_known_codes_and_collapses_unknown_text() {
        let (base, server) = serve_once("403 Forbidden", r#"{"error":"cloud_workspace_config_override_denied"}"#);
        let layer = json!({ "expectedVersion": 0, "env": {}, "prompt": null, "mcpServers": [] });
        let error = service(&base).update_workspace("ws_1", &layer, &revision()).unwrap_err();
        server.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("cloud_workspace_config_override_denied", Some(403)));

        let (base, server) = serve_once("500 Internal Server Error", r#"{"error":"<script>"}"#);
        let error = service(&base).secrets().unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, UNAVAILABLE);
    }
}
