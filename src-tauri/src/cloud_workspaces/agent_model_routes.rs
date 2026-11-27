//! A member's own agent model routes (PRO-18), from the desktop: how the
//! agents in the cloud workspaces they create reach their model instead of
//! the organization's login. A custom endpoint (a gateway or model
//! provider, with a credential the member stores) or a credential helper the
//! member manages in the workspace.
//!
//! Routes are personal and per organization (`/v1/desktop/orgs/{org}/
//! agent-model-routes`, membership-only on the service, which reads and
//! changes the caller's own routes and nobody else's), so any member may
//! set theirs in any organization they belong to, active or not. The
//! service owns the template catalog and validates every field; the page
//! renders the catalog it answers with.
//!
//! A credential is collected in a native secure dialog, checked from this
//! Mac against the endpoint's model list (`agent_route_check`: codes and
//! model ids come back, never a response body), sent once to the service in
//! one zeroized buffer and never returned to the webview. A failed check
//! keeps it from being saved unless the member chose to save anyway, which
//! the page offers for any failure (an endpoint may answer only the cloud,
//! or serve a model it does not list). The check that labels a route
//! working is the workspace's own (`cloud_grants`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{context_changed_error, invalid_response, CloudWorkspaceClientError, CloudWorkspaceService, RequestRisk};
use crate::account::{AccountContext, PHASE2_ORGANIZATION_ROUTES};
use crate::agent_route_check::{self, Checked, CredentialHeader, ModelList, Probe};

/// The agents a route can be for: Cursor's CLI has none.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentRouteAgent {
    Claude,
    Codex,
}

impl AgentRouteAgent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }
}

/// What the page asks to save. The credential is never in it: when
/// `enter_credential` is set, the app asks for one in its own dialog.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRouteSave {
    /// The organization the page names; the active one when none.
    pub organization_id: Option<String>,
    pub context_revision: String,
    pub agent: AgentRouteAgent,
    pub template_id: String,
    pub settings: Map<String, Value>,
    pub expected_version: u64,
    pub enter_credential: bool,
    /// Save even when this Mac's check fails, whatever the reason: an
    /// endpoint may answer only the cloud (unreachable, or 403 to other
    /// addresses), or serve a model it does not list. The workspace's own
    /// check labels the route either way.
    pub save_unchecked: bool,
}

/// What an owner or admin asks to add as an organization route (PRO-310):
/// a custom provider for everyone's workspaces on `repository`. The
/// credential is never in it: the app asks for it in its own dialog.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationRouteAdd {
    pub organization_id: Option<String>,
    pub context_revision: String,
    pub agent: AgentRouteAgent,
    /// `owner/name` of a GitHub repository.
    pub repository: String,
    pub template_id: String,
    pub settings: Map<String, Value>,
    /// Save even when this Mac's check fails.
    pub save_unchecked: bool,
}

/// `owner/name`, as the service stores it, or None.
fn route_repository(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let value = value.strip_suffix(".git").unwrap_or(&value).to_string();
    let (owner, name) = value.split_once('/')?;
    let owner_ok = !owner.is_empty() && owner.len() <= 39 && !owner.starts_with('-') && owner.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    let name_ok = !name.is_empty() && name.len() <= 100 && name != "." && name != ".." && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    (owner_ok && name_ok).then_some(value)
}

fn organization_route_id_ok(id: &str) -> bool {
    id.strip_prefix("orgroute_").is_some_and(|rest| rest.len() == 36 && rest.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-'))
}

const ORGANIZATION_ROUTES: &str = "organization-model-routes";
const ORGANIZATION_ROUTES_OFF: &str = "cloud_organization_routes_unavailable";

/// The answer to a save: whether it was saved, what this Mac's check found,
/// and the routes as the service holds them now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRouteSaved {
    pub saved: bool,
    pub check: Option<Checked>,
    pub routes: Option<Value>,
}

const SETTING_KEYS: [&str; 4] = ["baseUrl", "authScheme", "model", "helperPath"];

/// The settings as plain strings of the keys a template can have; anything
/// else is refused before a dialog opens.
fn plain_settings(settings: &Map<String, Value>) -> Result<Map<String, Value>, CloudWorkspaceClientError> {
    let invalid = || CloudWorkspaceClientError::local("cloud_agent_route_invalid", false);
    let mut plain = Map::new();
    for (key, value) in settings {
        if !SETTING_KEYS.contains(&key.as_str()) {
            return Err(invalid());
        }
        match value {
            Value::String(text) if text.len() <= 512 => {
                if !text.trim().is_empty() {
                    plain.insert(key.clone(), Value::String(text.trim().to_string()));
                }
            }
            Value::Null => {}
            _ => return Err(invalid()),
        }
    }
    Ok(plain)
}

fn template_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// One template of the catalog the service answered, as far as a save
/// needs it.
pub(crate) struct TemplateFacts {
    pub label: String,
    pub custom_endpoint: bool,
    pub model_list: ModelList,
}

fn template_in(routes: &Value, agent: AgentRouteAgent, id: &str) -> Option<TemplateFacts> {
    let template = routes.get("templates")?.as_array()?.iter().find(|template| {
        template.get("id").and_then(Value::as_str) == Some(id) && template.get("provider").and_then(Value::as_str) == Some(agent.as_str())
    })?;
    Some(TemplateFacts {
        label: template.get("label").and_then(Value::as_str).unwrap_or(id).to_string(),
        custom_endpoint: template.get("mode").and_then(Value::as_str) == Some("custom-endpoint"),
        model_list: match template.pointer("/capabilities/modelList").and_then(Value::as_str) {
            Some("openai") => ModelList::OpenAi,
            _ => ModelList::Anthropic,
        },
    })
}

/// What a save is about to do, checked before anything is asked for.
pub(crate) struct RouteChange {
    context: AccountContext,
    access: crate::account::OrgAccess,
    pub template: TemplateFacts,
    pub settings: Map<String, Value>,
    pub organization_id: String,
}

impl RouteChange {
    /// The address the credential is for, as the dialog names it.
    pub fn host(&self) -> Option<String> {
        let base = self.settings.get("baseUrl")?.as_str()?;
        url::Url::parse(base).ok()?.host_str().map(str::to_string)
    }

    /// Check the endpoint from this Mac with `credential`, as the CLI would
    /// send it.
    pub fn check(&self, credential: &str) -> Checked {
        let text = |key: &str| self.settings.get(key).and_then(Value::as_str);
        let Some(base_url) = text("baseUrl") else { return Checked::failed("unreachable") };
        let header = match (self.template.model_list, text("authScheme")) {
            (ModelList::Anthropic, Some("x-api-key")) => CredentialHeader::ApiKey,
            _ => CredentialHeader::Bearer,
        };
        agent_route_check::probe(&Probe { list: self.template.model_list, base_url, credential, header, model: text("model") })
    }
}

impl CloudWorkspaceService {
    /// The caller's routes in `organization` (any one they belong to; the
    /// active one when none), with the template catalog.
    pub fn agent_routes(&self, organization: Option<&str>) -> Result<Value, CloudWorkspaceClientError> {
        let (context, access) = self.context_in(organization)?;
        let routes = Self::read_routes(&self.client, &context)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        Ok(routes)
    }

    fn read_routes(client: &super::Client, context: &AccountContext) -> Result<Value, CloudWorkspaceClientError> {
        let routes: Value = client.request(context, &["agent-model-routes"], None, None, None, RequestRisk::Read)?;
        if !routes.is_object() || !routes.get("routes").is_some_and(Value::is_array) {
            return Err(invalid_response());
        }
        Ok(routes)
    }

    /// Before a credential is asked for or an endpoint called: the request is
    /// for the organization the page names in the account the page knew,
    /// the service still offers the template for the agent, and the
    /// settings are plain values of its fields.
    pub(crate) fn prepare_route_change(&self, save: &AgentRouteSave) -> Result<RouteChange, CloudWorkspaceClientError> {
        if !template_id_ok(&save.template_id) {
            return Err(CloudWorkspaceClientError::local("cloud_agent_route_template_unknown", false));
        }
        let settings = plain_settings(&save.settings)?;
        let (context, access) = self.agent_login_context(save.organization_id.as_deref(), &save.context_revision, RequestRisk::Read)?;
        let routes = Self::read_routes(&self.client, &context)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        let template = template_in(&routes, save.agent, &save.template_id).ok_or_else(|| CloudWorkspaceClientError::local("cloud_agent_route_template_unknown", false))?;
        if !template.custom_endpoint && save.enter_credential {
            return Err(CloudWorkspaceClientError::local("cloud_agent_route_invalid", false));
        }
        let organization_id = context.organization_id.clone();
        Ok(RouteChange { context, access, template, settings, organization_id })
    }

    /// Save the route, with the credential when one was entered: sent once,
    /// from one zeroized buffer, and cleared.
    pub(crate) fn save_route(&self, change: &RouteChange, save: &AgentRouteSave, credential: Option<zeroize::Zeroizing<String>>) -> Result<Value, CloudWorkspaceClientError> {
        if !self.account.is_current_in(&change.context, change.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let invalid = |_| CloudWorkspaceClientError::local("cloud_agent_route_invalid", false);
        let head = serde_json::json!({ "templateId": save.template_id, "settings": change.settings, "expectedVersion": save.expected_version });
        let head = serde_json::to_string(&head).map_err(invalid)?;
        let path = ["agent-model-routes", save.agent.as_str()];
        let routes: Value = match credential {
            Some(credential) => {
                let escaped = zeroize::Zeroizing::new(serde_json::to_string(credential.as_str()).map_err(invalid)?);
                drop(credential);
                // `{…}` with the credential added as the last field.
                let body = zeroize::Zeroizing::new(format!(r#"{},"credential":{}}}"#, &head[..head.len() - 1], escaped.as_str()));
                drop(escaped);
                self.client.send_secret("PUT", &change.context, &path, body)?
            }
            None => self.client.request_as("PUT", &change.context, &path, None, Some(serde_json::from_str(&head).map_err(invalid)?), None, RequestRisk::Mutation)?,
        };
        if !self.account.is_current_in(&change.context, change.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        if !routes.get("routes").is_some_and(Value::is_array) {
            return Err(invalid_response());
        }
        Ok(routes)
    }

    /// Back to the organization's login for `agent`: the service deletes the
    /// caller's route and its credential.
    pub fn remove_agent_route(&self, organization: Option<&str>, context_revision: &str, agent: AgentRouteAgent) -> Result<Value, CloudWorkspaceClientError> {
        let (context, access) = self.agent_login_context(organization, context_revision, RequestRisk::Mutation)?;
        let routes: Value = self.client.request_as("DELETE", &context, &["agent-model-routes", agent.as_str()], None, None, None, RequestRisk::Mutation)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        if !routes.get("routes").is_some_and(Value::is_array) {
            return Err(invalid_response());
        }
        Ok(routes)
    }

    // ---- organization routes (PRO-310)

    /// The organization's routes, which every member reads, with whether the
    /// caller may add and remove them. Behind its readiness key.
    pub fn organization_routes(&self, organization: Option<&str>) -> Result<Value, CloudWorkspaceClientError> {
        let (context, access) = self.context_in(organization)?;
        let org = Some(context.organization_id.as_str());
        self.phase2_gate(PHASE2_ORGANIZATION_ROUTES, org, Some(&context), ORGANIZATION_ROUTES_OFF)?;
        let routes = Self::read_organization_routes(&self.client, &context)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        Ok(routes)
    }

    fn read_organization_routes(client: &super::Client, context: &AccountContext) -> Result<Value, CloudWorkspaceClientError> {
        let routes: Value = client.request(context, &[ORGANIZATION_ROUTES], None, None, None, RequestRisk::Read)?;
        if !routes.get("routes").is_some_and(Value::is_array) || !routes.get("canManage").is_some_and(Value::is_boolean) {
            return Err(invalid_response());
        }
        Ok(routes)
    }

    /// Before a credential is asked for: the key is on, the caller may
    /// manage routes, the repository is `owner/name`, and the service offers
    /// the template (a custom endpoint) for the agent.
    pub(crate) fn prepare_organization_route(&self, add: &OrganizationRouteAdd) -> Result<RouteChange, CloudWorkspaceClientError> {
        if !template_id_ok(&add.template_id) {
            return Err(CloudWorkspaceClientError::local("cloud_agent_route_template_unknown", false));
        }
        if route_repository(&add.repository).is_none() {
            return Err(CloudWorkspaceClientError::local("cloud_organization_route_repository_invalid", false));
        }
        let settings = plain_settings(&add.settings)?;
        let (context, access) = self.agent_login_context(add.organization_id.as_deref(), &add.context_revision, RequestRisk::Read)?;
        let org = Some(context.organization_id.as_str());
        self.phase2_gate(PHASE2_ORGANIZATION_ROUTES, org, Some(&context), ORGANIZATION_ROUTES_OFF)?;
        let routes = Self::read_organization_routes(&self.client, &context)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        if routes.get("canManage").and_then(Value::as_bool) != Some(true) {
            return Err(CloudWorkspaceClientError::local("organization_admin_required", false));
        }
        let template = template_in(&routes, add.agent, &add.template_id)
            .filter(|template| template.custom_endpoint)
            .ok_or_else(|| CloudWorkspaceClientError::local("cloud_agent_route_template_unknown", false))?;
        let organization_id = context.organization_id.clone();
        Ok(RouteChange { context, access, template, settings, organization_id })
    }

    /// Add the route with its credential: sent once, from one zeroized
    /// buffer, and cleared.
    pub(crate) fn add_organization_route(&self, change: &RouteChange, add: &OrganizationRouteAdd, credential: zeroize::Zeroizing<String>) -> Result<Value, CloudWorkspaceClientError> {
        if !self.account.is_current_in(&change.context, change.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let invalid = |_| CloudWorkspaceClientError::local("cloud_agent_route_invalid", false);
        let repository = route_repository(&add.repository).ok_or_else(|| CloudWorkspaceClientError::local("cloud_organization_route_repository_invalid", false))?;
        let head = serde_json::json!({ "agent": add.agent.as_str(), "repository": repository, "templateId": add.template_id, "settings": change.settings });
        let head = serde_json::to_string(&head).map_err(invalid)?;
        let escaped = zeroize::Zeroizing::new(serde_json::to_string(credential.as_str()).map_err(invalid)?);
        drop(credential);
        let body = zeroize::Zeroizing::new(format!(r#"{},"credential":{}}}"#, &head[..head.len() - 1], escaped.as_str()));
        drop(escaped);
        let routes: Value = self.client.send_secret("POST", &change.context, &[ORGANIZATION_ROUTES], body)?;
        if !self.account.is_current_in(&change.context, change.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        if !routes.get("routes").is_some_and(Value::is_array) {
            return Err(invalid_response());
        }
        Ok(routes)
    }

    /// Remove an organization route and its credential. New sessions on its
    /// repository go back to each member's own login.
    pub fn remove_organization_route(&self, organization: Option<&str>, context_revision: &str, route_id: &str) -> Result<Value, CloudWorkspaceClientError> {
        if !organization_route_id_ok(route_id) {
            return Err(CloudWorkspaceClientError::local("cloud_organization_route_not_found", false));
        }
        let (context, access) = self.agent_login_context(organization, context_revision, RequestRisk::Mutation)?;
        let org = Some(context.organization_id.as_str());
        self.phase2_gate(PHASE2_ORGANIZATION_ROUTES, org, Some(&context), ORGANIZATION_ROUTES_OFF)?;
        let routes: Value = self.client.request_as("DELETE", &context, &[ORGANIZATION_ROUTES, route_id], None, None, None, RequestRisk::Mutation)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        if !routes.get("routes").is_some_and(Value::is_array) {
            return Err(invalid_response());
        }
        Ok(routes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_plain_values_of_template_fields_leave_the_page() {
        let settings = json!({ "baseUrl": " https://llm.example.com ", "model": "", "authScheme": "bearer" });
        let plain = plain_settings(settings.as_object().unwrap()).unwrap();
        assert_eq!(Value::Object(plain), json!({ "baseUrl": "https://llm.example.com", "authScheme": "bearer" }));
        for bad in [json!({ "credential": "sk-x" }), json!({ "baseUrl": 7 }), json!({ "model": ["a"] }), json!({ "helperPath": "x".repeat(513) })] {
            assert_eq!(plain_settings(bad.as_object().unwrap()).unwrap_err().code, "cloud_agent_route_invalid", "{bad}");
        }
        assert!(template_id_ok("claude-gateway"));
        assert!(!template_id_ok("../x") && !template_id_ok("") && !template_id_ok("Claude"));
    }

    #[test]
    fn an_organization_route_names_one_github_repository_and_its_own_id() {
        assert_eq!(route_repository(" Acme/TerminalX.git ").as_deref(), Some("acme/terminalx"));
        assert_eq!(route_repository("acme/terminal.x").as_deref(), Some("acme/terminal.x"));
        for bad in ["acme", "acme/", "/x", "a/b/c", "acme/..", "https://github.com/acme/x", "acme/has space", "-acme/x"] {
            assert!(route_repository(bad).is_none(), "{bad}");
        }
        assert!(organization_route_id_ok("orgroute_0b6f3c1e-1d2a-4f5b-8c7d-9e0f1a2b3c4d"));
        for bad in ["orgroute_../x", "route_0b6f3c1e-1d2a-4f5b-8c7d-9e0f1a2b3c4d", "orgroute_", ""] {
            assert!(!organization_route_id_ok(bad), "{bad}");
        }
    }

    #[test]
    fn finds_the_template_the_service_offers_for_the_agent() {
        let routes = json!({
            "templates": [
                { "id": "claude-gateway", "provider": "claude", "mode": "custom-endpoint", "label": "LLM gateway", "capabilities": { "modelList": "anthropic" } },
                { "id": "codex-provider", "provider": "codex", "mode": "custom-endpoint", "label": "Provider", "capabilities": { "modelList": "openai" } },
                { "id": "claude-key-helper", "provider": "claude", "mode": "user-managed", "capabilities": { "modelList": "anthropic" } }
            ],
            "routes": []
        });
        let gateway = template_in(&routes, AgentRouteAgent::Claude, "claude-gateway").unwrap();
        assert!(gateway.custom_endpoint && gateway.model_list == ModelList::Anthropic && gateway.label == "LLM gateway");
        assert_eq!(template_in(&routes, AgentRouteAgent::Codex, "codex-provider").unwrap().model_list, ModelList::OpenAi);
        assert!(!template_in(&routes, AgentRouteAgent::Claude, "claude-key-helper").unwrap().custom_endpoint);
        assert!(template_in(&routes, AgentRouteAgent::Codex, "claude-gateway").is_none(), "a template of another agent");
        assert!(template_in(&routes, AgentRouteAgent::Claude, "nope").is_none());
    }
}