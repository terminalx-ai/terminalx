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
use crate::account::AccountContext;
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

/// The answer to a save: whether it was saved, what this Mac's check found,
/// and the routes as the service holds them now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRouteSaved {
    pub saved: bool,
    pub check: Option<Checked>,
    pub routes: Option<Value>,
}

const SETTING_KEYS: [&str; 5] = ["baseUrl", "authScheme", "model", "helperPath", "region"];

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
    pub bedrock: bool,
    pub custom_endpoint: bool,
    pub model_list: ModelList,
}

fn template_in(routes: &Value, agent: AgentRouteAgent, id: &str) -> Option<TemplateFacts> {
    let template = routes.get("templates")?.as_array()?.iter().find(|template| {
        template.get("id").and_then(Value::as_str) == Some(id) && template.get("provider").and_then(Value::as_str) == Some(agent.as_str())
    })?;
    Some(TemplateFacts {
        bedrock: id == "claude-bedrock",
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