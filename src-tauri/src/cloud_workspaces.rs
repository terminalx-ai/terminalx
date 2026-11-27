//! Native-only client for the provider-aware Cloud Workspace controller.
//!
//! Account and provider credentials stay outside the webview. The exposed
//! values are an allowlisted projection of the controller's safe desktop DTOs.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::account::{
    AccountContext, AccountManager, OrgAccess, PHASE2_EVENTS, PHASE2_FOLLOW_REASSIGN, PHASE2_ANNOUNCEMENTS, PHASE2_MENTIONS, PHASE2_NUDGES,
    PHASE2_FRESH_WORKSPACE, PHASE2_GITHUB_TRIGGER, PHASE2_PRESENCE, PHASE2_RESTART_DETAILS,
    PHASE2_ADMIN_SHARE, PHASE2_AFFECTED_WORKSPACES, PHASE2_DESKTOP_BILLING, PHASE2_GENERAL_ACCESS, PHASE2_PRECREATE_USAGE, PHASE2_WEBHOOK_TRIGGER, PHASE2_WORKSPACE_GROUPS,
};

const CONTRACT: &str = "providers-v1";
/// Archive, tombstones and cleanup reports (terminalx-saas contract §10.6).
/// Without it an archived workspace reads as suspended.
const LIFECYCLE: &str = "archive-v1";
/// Which providers this client can show and drive: every one the server
/// describes (PRO-415). A provider comes with a descriptor that says what it
/// is called, how it is drawn and ordered, and what its credential is, so the
/// client needs no list of its own. The ids after `described` are only for a
/// server older than described providers (or one rolled back): it skips the
/// word it does not know and answers for the providers it always offered,
/// without descriptors, where the client falls back to their display names.
/// A server that knows `described` answers with its whole registry and
/// ignores the rest.
const SUPPORTED_PROVIDERS: &str = "described,machine0,box,hetzner";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 512 * 1024;
/// The catalog feed carries every member Organization's list in one answer.
const CATALOG_RESPONSE_LIMIT_BYTES: u64 = 4 * RESPONSE_LIMIT_BYTES;
const MAX_RETRY_AFTER_SECONDS: u64 = 60 * 60;
/// Longer than any period the server offers; a bound, not the list.
const MAX_ARCHIVE_RETENTION_DAYS: u32 = 365;
/// Diagnostics carry up to a few hundred operations with their history.
const DIAGNOSTICS_RESPONSE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;

/// A cloud provider's id, as the server's registry names it (PRO-415): a
/// validated string, not a list this client knows. The shape is the
/// server's own (`^[a-z0-9][a-z0-9-]{0,62}$`), so an id can go into a URL
/// path segment and a header as it is.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(try_from = "String", into = "String")]
pub struct CloudWorkspaceProviderId(String);

impl CloudWorkspaceProviderId {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    fn valid(value: &str) -> bool {
        let bytes = value.as_bytes();
        (1..=63).contains(&bytes.len())
            && matches!(bytes[0], b'a'..=b'z' | b'0'..=b'9')
            && bytes.iter().all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-'))
    }
}

impl TryFrom<String> for CloudWorkspaceProviderId {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if Self::valid(&value) {
            Ok(Self(value))
        } else {
            Err("a provider id is 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit".into())
        }
    }
}

impl From<CloudWorkspaceProviderId> for String {
    fn from(value: CloudWorkspaceProviderId) -> Self {
        value.0
    }
}

impl std::fmt::Display for CloudWorkspaceProviderId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// One input of a provider's credential, asked for in a native dialog.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderCredentialField {
    pub name: String,
    /// `secret` is typed into a secure field; `text` into a plain one. An
    /// unknown kind is treated as secret.
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub help_url: Option<String>,
}

impl CloudProviderCredentialField {
    pub(crate) fn secret(&self) -> bool {
        self.kind != "text"
    }
}

/// Whose credential a provider's machines run on (PRO-452). `Organization`:
/// a key the organization connects. `Platform`: TerminalX's own, so there is
/// nothing for anybody to connect, replace, check or disconnect.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloudProviderCredentialSource {
    #[default]
    Organization,
    Platform,
}

impl<'de> Deserialize<'de> for CloudProviderCredentialSource {
    /// Only `platform` is a platform provider. A value this client does not
    /// know, of any type, is an organization's: the only kind there was, and
    /// the one that asks before it uses anything.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(if value.as_str() == Some("platform") { Self::Platform } else { Self::Organization })
    }
}

/// How a provider is presented, as the server's registry describes it
/// (PRO-415). The fields this client acts on are typed; the rest
/// (capabilities, offering, allowed values, copy) pass to the webview as the
/// server sent them, so a field the server adds needs no client release.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderDescriptor {
    pub id: CloudWorkspaceProviderId,
    pub label: String,
    pub icon: String,
    pub order: i64,
    /// False: hidden, listed only while the organization is still connected to it.
    #[serde(default = "listed_by_default")]
    pub listed: bool,
    /// Absent from a server older than platform providers: an organization's.
    #[serde(default)]
    pub credential_source: CloudProviderCredentialSource,
    /// Empty for a platform provider: nobody is asked for a credential.
    pub credential_fields: Vec<CloudProviderCredentialField>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

fn listed_by_default() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderCapabilities {
    pub suspend: bool,
    pub resume: bool,
    pub release_disposition: ReleaseDisposition,
    pub location_selection: SelectionRequirement,
    pub source_selection: SourceSelection,
    pub pricing: PricingAvailability,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseDisposition {
    Destroyed,
    Archived,
    TerminalxOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SelectionRequirement {
    Required,
    Automatic,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceSelection {
    Required,
    Optional,
    None,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PricingAvailability {
    ProviderRate,
    Estimate,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderPricing {
    ProviderRate,
    Estimate,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderConnection {
    pub state: ConnectedState,
    pub connected_at: i64,
    pub last_validated_at: Option<i64>,
    pub credential_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderConnectionResponse {
    pub provider: CloudWorkspaceProviderId,
    pub state: CloudProviderConnectionState,
    pub can_manage: bool,
    pub credential_fingerprint: Option<String>,
    pub connected_at: Option<i64>,
    pub last_validated_at: Option<i64>,
    pub credential_version: Option<i64>,
    pub provider_account: Option<String>,
    pub operations_blocked: Option<bool>,
    pub disconnect_disposition: Option<DisconnectDisposition>,
    /// `archive` while a disconnect that archives is under way (§10.7): the
    /// server reports it apart from `disconnectDisposition`, which an older
    /// desktop reads as retain or destroy only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disconnect_retention: Option<String>,
    /// When the archived workspaces of that disconnect are deleted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention_deadline: Option<i64>,
    pub resources: Option<Vec<CloudProviderResource>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DisconnectDisposition { Retain, Archive, Destroy }

/// What an organization-wide cloud teardown does with its workspaces (§10.7).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TeardownDisposition { Archive, Destroy }

/// `GET`/`POST …/cloud-teardown` (§10.7): the teardown an owner or admin
/// asked for, every resource the organization still has at its providers,
/// and what still blocks completion. `disposition` stays a string so a newer
/// server's value still reaches the page.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTeardown {
    pub organization_id: String,
    pub disposition: String,
    pub requested_at: i64,
    pub retention_deadline: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub resources: Vec<CloudTeardownResource>,
    #[serde(default)]
    pub remaining: Vec<CloudTeardownResource>,
}

/// The preview the person confirmed: the count they were shown and the
/// token of the set it counted.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedTeardown {
    pub expected_workspaces: u32,
    pub preview_token: String,
}

fn valid_preview_token(token: &str) -> bool {
    token.len() == 43 && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// `GET …/cloud-teardown/preview`: what a teardown would take, as counts.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTeardownPreview {
    pub organization_id: String,
    pub workspaces: u32,
    /// Private workspaces created by someone other than the caller.
    #[serde(default)]
    pub others_private_workspaces: u32,
    #[serde(default)]
    pub archived_workspaces: u32,
    /// Names exactly the set of workspaces counted; it goes back with the
    /// request, and the server refuses a teardown of any other set.
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTeardownResource {
    pub provider: String,
    pub id: String,
    pub kind: String,
    pub state: String,
    #[serde(default)]
    pub release_disposition: Option<String>,
    #[serde(default)]
    pub cleanup_required: bool,
    #[serde(default)]
    pub delete_after: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderResource {
    pub id: String,
    pub name: String,
    pub state: String,
    pub release_disposition: Option<ReleaseDisposition>,
    pub active_hourly_micros: Option<i64>,
    pub suspended_monthly_micros: Option<i64>,
    pub currency: String,
    pub operation_state: Option<String>,
    pub cleanup_required: bool,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderConnectInput {
    pub context_revision: String,
    pub disclosure: CloudProviderDisclosure,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderDisclosure {
    pub version: String,
    pub provider_billing_accepted: bool,
    pub organization_use_accepted: bool,
}

pub(crate) struct ProviderConnectAuthorization {
    context: AccountContext,
    provider: CloudWorkspaceProviderId,
}

impl ProviderConnectAuthorization {
    pub(crate) fn organization_id(&self) -> &str { &self.context.organization_id }
    pub(crate) fn provider(&self) -> &CloudWorkspaceProviderId { &self.provider }
}

pub(crate) fn validate_disclosure(input: &CloudProviderConnectInput) -> Result<(), CloudWorkspaceClientError> {
    if input.disclosure.version != "cloud-provider-connections-2026-08-13"
        || !input.disclosure.provider_billing_accepted || !input.disclosure.organization_use_accepted {
        return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudProviderConnectionState {
    NotConnected,
    Connected,
    AttentionRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectedState {
    Connected,
    AttentionRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderAvailability {
    Available,
    NotConnected,
    AttentionRequired,
    DisabledForCreate,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderSummary {
    pub id: CloudWorkspaceProviderId,
    pub display_name: String,
    pub availability: ProviderAvailability,
    pub can_manage: bool,
    pub connection: Option<CloudProviderConnection>,
    pub capabilities: CloudProviderCapabilities,
    /// Absent from a server older than described providers.
    #[serde(default)]
    pub descriptor: Option<CloudProviderDescriptor>,
}

impl CloudProviderSummary {
    /// What the provider is called: its descriptor's label, else the list's
    /// display name, else its id.
    pub(crate) fn label(&self) -> String {
        [self.descriptor.as_ref().map(|descriptor| descriptor.label.as_str()), Some(self.display_name.as_str())]
            .into_iter()
            .flatten()
            .find(|name| !name.trim().is_empty())
            .unwrap_or(self.id.as_str())
            .to_owned()
    }

    /// True for a provider that runs on TerminalX's own credential
    /// (PRO-452): it has no key, so no dialog ever asks for one and nothing
    /// is sent to connect it.
    pub(crate) fn platform_credential(&self) -> bool {
        self.descriptor.as_ref().is_some_and(|descriptor| descriptor.credential_source == CloudProviderCredentialSource::Platform)
    }

    /// What the connect dialog asks for: the descriptor's credential fields,
    /// else (a server older than described providers) one secret key.
    /// Nothing for a platform provider, whatever its descriptor lists.
    pub(crate) fn credential_fields(&self) -> Vec<CloudProviderCredentialField> {
        match &self.descriptor {
            Some(_) if self.platform_credential() => Vec::new(),
            Some(descriptor) if !descriptor.credential_fields.is_empty() => descriptor.credential_fields.clone(),
            _ => vec![CloudProviderCredentialField { name: "credential".into(), kind: "secret".into(), label: "provider key".into(), help_url: None }],
        }
    }
}

/// An agent whose login an organization can store for its cloud workspaces.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentLoginProvider {
    Codex,
    Claude,
    Cursor,
}

impl AgentLoginProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Cursor => "cursor",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        [Self::Codex, Self::Claude, Self::Cursor].into_iter().find(|provider| provider.as_str() == value)
    }
}

/// How a stored login authenticates the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentLoginKind {
    ApiKey,
    /// The agent's own login document (a subscription sign-in).
    LoginDocument,
}

impl AgentLoginKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ApiKey => "api-key",
            Self::LoginDocument => "oauth-credentials-json",
        }
    }
}

/// What the service says about a stored login. There is no field for the
/// login itself, so one the service ever sent by mistake is dropped here.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogin {
    pub provider: String,
    pub auth_kind: String,
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_identity: Option<String>,
    pub version: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_use: Option<String>,
    /// In the list only: the person who connected this subscription login
    /// no longer owns or administers the organization. The login is kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configurer_left: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentLoginList {
    pub credentials: Vec<AgentLogin>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AffectedWorkspace {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoginAffectedWorkspaces {
    pub workspaces: Vec<AffectedWorkspace>,
    pub count: usize,
    pub has_more: bool,
    pub has_hidden: bool,
}

/// A sign-in the account service has begun: the page to approve it on, and
/// the attempt to finish.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginStart {
    pub attempt_id: String,
    pub authorize_url: String,
    pub expires_in_seconds: u64,
}

/// How finishing a sign-in went. `status` is the service's word: `complete`
/// (with the stored login's public fields), `code-invalid` (with the tries
/// left), `unavailable`, `pending`, `expired`, `canceled` or `failed`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginOutcome {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<AgentLogin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts_left: Option<u32>,
}

/// Whether `value` is a page of the provider that may be opened for a
/// sign-in: `https`, on claude.com, claude.ai or anthropic.com (or a
/// subdomain), with no credentials in the address. A debug build also
/// accepts a loopback address, for a local stack's stand-in provider.
pub(crate) fn claude_login_page(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    if value.len() > 4096 || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    if cfg!(debug_assertions) && url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost") {
        return true;
    }
    url.scheme() == "https"
        && ["claude.com", "claude.ai", "anthropic.com"].iter().any(|domain| host == *domain || host.strip_suffix(domain).is_some_and(|rest| rest.ends_with('.')))
}

/// The service does not offer the sign-in (an older server, or the feature is off there).
fn flow_unavailable_on_404(error: CloudWorkspaceClientError) -> CloudWorkspaceClientError {
    if error.status == Some(404) { CloudWorkspaceClientError::local("cloud_agent_login_flow_unavailable", false) } else { error }
}

/// The attempt is not there for this person any more (expired and removed, or begun by someone else).
fn attempt_gone_on_404(error: CloudWorkspaceClientError) -> CloudWorkspaceClientError {
    if error.status == Some(404) { CloudWorkspaceClientError::local("cloud_agent_login_attempt_gone", false) } else { error }
}

/// What the person agreed to before a login is stored, and for which
/// organization they were looking at.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLoginConsent {
    pub context_revision: String,
    /// The organization's cloud workspaces may use this login.
    pub organization_sharing: bool,
    /// Short-lived access made from it is installed on the workspace machines.
    pub machine_installation: bool,
    /// The login now stored for this agent may be replaced. Required when there is one.
    #[serde(default)]
    pub replace_existing: bool,
    /// The organization whose logins these are (PRO-107): any one the
    /// person belongs to, named by id, whatever the active one is. None is
    /// the active organization, as before.
    #[serde(default)]
    pub organization_id: Option<String>,
}

pub(crate) struct AgentLoginAuthorization {
    context: AccountContext,
    /// What authorized `context`'s organization, which decides what keeps it current.
    access: OrgAccess,
    /// The kind of login stored for the agent now, which saving replaces.
    replaces: Option<AgentLoginKind>,
    /// That login's kind and scope as the service names them, for `reach`.
    stored: Option<(String, Option<String>)>,
}

/// Who may use a login once it is stored. The desktop offers no choice of
/// scope and so sends none (`sharedUse` is left out of every request): the
/// account service decides, and this is what it will decide.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AgentLoginReach {
    /// Nothing of this kind is stored: the service's default for a new login.
    ServiceDefault,
    /// A login of the same kind is replaced, and its scope stays as it is
    /// (`organization`, `managers`, or one this app does not know).
    Kept(String),
    /// A login of another kind is replaced: the service never widens, so
    /// the new login gets the stored scope or its kind's narrower default.
    NoWider(String),
}

impl AgentLoginReach {
    /// One sentence for a native dialog.
    pub(crate) fn sentence(&self) -> &'static str {
        match self {
            Self::ServiceDefault => "By default, agents in every member's cloud workspaces of the organization may run on it; the account service decides this, and Settings shows who the login reaches once it is stored.",
            Self::Kept(scope) if scope == "managers" => "This keeps who can use the login now: only workspaces that nobody but owners and admins can drive.",
            Self::Kept(scope) if scope == "organization" => "This keeps who can use the login now: agents in every member's cloud workspaces of the organization.",
            Self::Kept(_) => "This keeps who can use the login now, as the account service has it.",
            Self::NoWider(scope) if scope == "managers" => "This keeps who can use the login now, or fewer: at most workspaces that nobody but owners and admins can drive. Settings shows who the login reaches once it is stored.",
            Self::NoWider(scope) if scope == "organization" => "This keeps who can use the login now, or fewer: at most agents in every member's cloud workspaces of the organization. Settings shows who the login reaches once it is stored.",
            Self::NoWider(_) => "This keeps who can use the login now, or fewer. Settings shows who the login reaches once it is stored.",
        }
    }
}

impl AgentLoginAuthorization {
    pub(crate) fn organization_id(&self) -> &str {
        &self.context.organization_id
    }

    pub(crate) fn replaces(&self) -> Option<AgentLoginKind> {
        self.replaces
    }

    /// Who may use a login of `kind` stored under this authorization. A
    /// replacement never widens: the same kind keeps the stored scope, and
    /// another kind gets it or the narrower default of its own kind.
    pub(crate) fn reach(&self, kind: AgentLoginKind) -> AgentLoginReach {
        match &self.stored {
            None => AgentLoginReach::ServiceDefault,
            Some((stored_kind, scope)) => {
                // A server from before the scope existed says nothing, and shared every login with the organization.
                let scope = scope.clone().unwrap_or_else(|| "organization".into());
                if stored_kind == kind.as_str() {
                    AgentLoginReach::Kept(scope)
                } else {
                    AgentLoginReach::NoWider(scope)
                }
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(context: AccountContext, stored: Option<(&str, Option<&str>)>) -> Self {
        let replaces = stored.map(|(kind, _)| if kind == "api-key" { AgentLoginKind::ApiKey } else { AgentLoginKind::LoginDocument });
        Self { context, access: OrgAccess::Active, replaces, stored: stored.map(|(kind, scope)| (kind.to_owned(), scope.map(str::to_owned))) }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CloudProviderSummaryResponse {
    pub providers: Vec<CloudProviderSummary>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkPolicy {
    RelayOnly,
    ProviderPublicNetwork,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSelection {
    pub source_id: String,
    pub location_id: String,
    pub machine_class_id: String,
    pub idle_suspend_minutes: i64,
    pub retention_days: i64,
    pub network_policy: NetworkPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSource {
    pub id: String,
    pub kind: CatalogSourceKind,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogSourceKind {
    Image,
    Template,
    ProviderDefault,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLocation {
    pub id: String,
    pub label: String,
    pub placement: CatalogPlacement,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogPlacement {
    Selected,
    Automatic,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMachineClass {
    pub id: String,
    pub label: String,
    pub vcpu: i64,
    pub memory_mi_b: i64,
    pub disk_gi_b: i64,
    pub active_hourly_micros: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceSetup {
    pub provider: CloudWorkspaceProviderId,
    pub credential_fingerprint: String,
    pub currency: Currency,
    pub pricing: ProviderPricing,
    pub pricing_observed_at: i64,
    pub sources: Vec<CatalogSource>,
    pub locations: Vec<CatalogLocation>,
    pub machine_classes: Vec<CatalogMachineClass>,
    pub defaults: ProviderSelection,
    pub allowed_idle_suspend_minutes: Vec<i64>,
    pub allowed_retention_days: Vec<i64>,
    /// The organization's idle cap (PRO-410): the server has already left
    /// never and every longer window out of `allowed_idle_suspend_minutes`.
    /// None from a server that does not say, or with no cap.
    #[serde(default, deserialize_with = "lenient")]
    pub max_idle_suspend_minutes: Option<i64>,
}

/// A workspace's idle window and what it may be changed to (PRO-410).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdleSuspend {
    pub workspace_id: String,
    /// Minutes without activity before it is stopped, 0 for never.
    pub idle_suspend_minutes: Option<i64>,
    pub allowed_idle_suspend_minutes: Vec<i64>,
    pub max_idle_suspend_minutes: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum Currency {
    #[serde(rename = "USD")]
    Usd,
    #[serde(rename = "EUR")]
    Eur,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceQuoteInput {
    pub provider: CloudWorkspaceProviderId,
    pub source_id: String,
    pub location_id: String,
    pub machine_class_id: String,
    pub idle_suspend_minutes: i64,
    pub retention_days: i64,
    pub network_policy: NetworkPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfiguration {
    pub source_id: String,
    pub location_id: String,
    pub machine_class_id: String,
    pub idle_suspend_minutes: i64,
    pub retention_days: i64,
    pub network_policy: NetworkPolicy,
    pub source_label: String,
    pub location_label: String,
    pub machine_class_label: String,
    pub vcpu: i64,
    pub memory_mi_b: i64,
    pub disk_gi_b: i64,
    pub architecture: Architecture,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Architecture {
    #[serde(rename = "x86_64")]
    X86_64,
    Arm64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceQuote {
    pub id: String,
    pub provider: CloudWorkspaceProviderId,
    pub expires_at: i64,
    pub currency: Currency,
    pub pricing: ProviderPricing,
    pub pricing_observed_at: i64,
    pub active_hourly_micros: i64,
    pub always_on_thirty_day_micros: i64,
    pub estimated_suspended_monthly_micros: Option<i64>,
    pub configuration: ProviderConfiguration,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceState {
    Provisioning,
    Ready,
    Suspended,
    /// In the 30-day trash (§10.1): stopped, kept until `delete_after`.
    Archived,
    AttentionRequired,
    Destroyed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceAccessMode {
    Private,
    Organization,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspace {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub provider: CloudWorkspaceProviderId,
    pub state: WorkspaceState,
    pub access_mode: WorkspaceAccessMode,
    pub created_at: i64,
    pub updated_at: i64,
    pub release_disposition: Option<ReleaseDisposition>,
    /// The launch intent the workspace was created with (PRO-21, contract §19).
    #[serde(default)]
    pub launch: Option<WorkspaceLaunch>,
    /// Set while archived, including a failed archive (§10.1).
    #[serde(default)]
    pub archived_at: Option<i64>,
    /// When an archived workspace is deleted for good.
    #[serde(default)]
    pub delete_after: Option<i64>,
    #[serde(default)]
    pub deleted_at: Option<i64>,
    /// When the server learned the provider no longer has this workspace's
    /// machine and cannot bring it back (#1589): only while it is
    /// `attention-required` for that reason. Absent from older servers.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub machine_missing_at: Option<i64>,
    /// List enrichment (saas #137, PRO-56, contract §20.1). Every field is
    /// optional: older servers omit them, and create, open and lifecycle
    /// responses never carry them. A malformed value reads as absent rather
    /// than failing the list, and an absent one is left out of what the
    /// webview gets, so an old server's list reaches it as before.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub repositories: Option<Vec<WorkspaceRepository>>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<WorkspaceCreator>,

    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
    /// Minutes without activity before TerminalX stops it, 0 for never
    /// (PRO-410); absent from older servers.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub idle_suspend_minutes: Option<i64>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub runtime_activity: Option<WorkspaceRuntimeActivity>,
    /// `manage` or `participate`; a string so a newer server's value reaches the page.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    /// The caller's collaboration role (PRO-30, saas contract §21.2); absent
    /// from older servers.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub you: Option<ListYou>,
    /// How many plain members hold a share; only for a caller with a role.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub shared_with: Option<u32>,
    /// The agent command kinds the API takes for this workspace
    /// (terminalx-saas#289). Absent from servers that take only the first
    /// four, which refuse any other, so a kind added later (`follow-up`,
    /// #1328) is offered only where it is listed.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub agent_command_kinds: Option<Vec<String>>,
    /// Present on a preparation workspace only (PRO-20): when the server
    /// stops it, after which it cannot be started again.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub preparation: Option<WorkspacePreparation>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub checkout: Option<WorkspaceCheckout>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub runtime: Option<DetailsRuntime>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePreparation {
    pub stop_after: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCheckout {
    pub state: String,
    pub repositories: Vec<WorkspaceCheckoutRepository>,
    pub reported_at: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkspaceCheckoutRepository {
    pub repository: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// `you` on a workspace list item (§21.2).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListYou {
    pub role: CollaborationRole,
    pub can_approve: bool,
    /// A manager or the workspace's creator; false from a server that does not say.
    #[serde(default)]
    pub can_manage_shares: bool,
}

/// One repository a workspace was created from (§20.1), primary first.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepository {
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub full_name: Option<String>,
    #[serde(default)]
    pub clone_url: Option<String>,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub target_directory: Option<String>,
    #[serde(default)]
    pub primary: bool,
}

/// The runtime's own activity report as the list carries it (§20.1, 9.3).
/// Named apart from the runtime build; the counts read 0 unless `online`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRuntimeActivity {
    pub online: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reporting: Option<bool>,
    #[serde(default)]
    pub reported_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
    #[serde(default)]
    pub active_turns: u32,
    #[serde(default)]
    pub pending_approvals: u32,
}

/// The organization's workspace slots (§20.1, PRO-76). `used`/`limit` mirror
/// `running` for desktops that predate it.
///
/// A `limit` is absent where the organization has none (PRO-371): the server
/// leaves the key out, and a null reads the same. It is passed on absent, so
/// the webview never compares a count with null.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceQuota {
    pub used: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub running: Option<QuotaUsage>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub total: Option<QuotaUsage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPrecreateUsage {
    caller_owned_running: u32,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    caller_owned_running_limit: Option<u32>,
    quota: CloudWorkspaceQuota,
}

/// The desktop Organization > Billing page (PRO-596): plan, seats and next
/// charge. Only the fields named here reach the webview.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationBilling {
    plan: BillingPlan,
    billed_to: BillingView,
    seats: Option<BillingSeats>,
    seat_price: Option<BillingSeatPrice>,
    next_charge: Option<BillingCharge>,
    payer: Option<String>,
    can_manage_billing: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum BillingPlan { Free, Pro, Teams }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BillingView { Personal, Organization }

#[derive(Debug, Deserialize, Serialize)]
struct BillingSeats { used: u32, limit: u32 }

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BillingSeatPrice { currency: String, unit_amount_minor: u64, interval: String }

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BillingCharge { date: String, amount_minor: u64, currency: String }

#[derive(Debug, Deserialize)]
struct BillingPortal { url: String }

fn billing_currency(code: &str) -> bool {
    code.len() == 3 && code.bytes().all(|byte| byte.is_ascii_uppercase())
}

impl OrganizationBilling {
    fn valid(&self) -> bool {
        self.seat_price.as_ref().is_none_or(|price| billing_currency(&price.currency) && price.interval == "month")
            && self.next_charge.as_ref().is_none_or(|charge| billing_currency(&charge.currency)
                && chrono::DateTime::parse_from_rfc3339(&charge.date).is_ok())
            && self.seats.as_ref().is_none_or(|seats| seats.limit > 0)
            // A lapsed Teams subscription is still the organization's to manage, whatever the plan now is.
            && (!matches!(self.plan, BillingPlan::Teams) || self.billed_to == BillingView::Organization)
    }
}

/// A Polar customer portal session: https on polar.sh (or a subdomain such as
/// its sandbox), no port and no credentials.
fn polar_portal_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let host = url.host_str()?;
    (raw.starts_with("https://")
        && url.scheme() == "https"
        && (host == "polar.sh" || host.ends_with(".polar.sh"))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none())
        .then(|| url.to_string())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct QuotaUsage {
    pub used: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// An optional list field: a value that does not fit its type reads as
/// absent, so one field a newer server reshapes cannot fail the whole list.
fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// Contract §19.2. `phase` and `state` stay strings so a newer server's
/// values reach the page instead of failing the whole response.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLaunch {
    pub launch_id: String,
    pub phase: String,
    pub state: String,
    pub work_branch: String,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub has_prompt: bool,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub timings: LaunchTimings,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTimings {
    pub requested_at: Option<i64>,
    pub booting_at: Option<i64>,
    pub authenticating_at: Option<i64>,
    pub syncing_at: Option<i64>,
    pub starting_agent_at: Option<i64>,
    pub running_at: Option<i64>,
    pub failed_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationState {
    Queued,
    Running,
    CancelRequested,
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationStage {
    Queued,
    Preflight,
    CreatingMachine,
    Bootstrapping,
    ConnectingRelay,
    Cleanup,
    Ready,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationAction {
    Suspend,
    Resume,
    Restart,
    Archive,
    Delete,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProgressPhase {
    Allocating,
    Starting,
    InstallingRuntime,
    ConnectingRelay,
    Suspending,
    Releasing,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    pub phase: ProgressPhase,
    pub retry_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceOperation {
    pub id: String,
    pub workspace_id: String,
    #[serde(rename = "type")]
    pub operation_type: OperationType,
    pub action: Option<OperationAction>,
    pub state: OperationState,
    pub stage: OperationStage,
    pub cancelable: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_provider_contact_at: Option<i64>,
    pub next_attempt_at: Option<i64>,
    pub retry_reason: Option<RetryReason>,
    #[serde(default, deserialize_with = "safe_optional_error_code")]
    pub error_code: Option<String>,
    /// The provider's own normalized error code for a failed operation.
    /// Only a short token passes; anything else (a message, a body) is dropped.
    #[serde(default, deserialize_with = "safe_provider_error_code")]
    pub provider_error_code: Option<String>,
    /// The server's own detail for a failed operation, beside the error
    /// code (`box_deleted_sandbox_present`). Absent from an older server;
    /// only a short token passes.
    #[serde(default, deserialize_with = "safe_detail_code", skip_serializing_if = "Option::is_none")]
    pub detail_code: Option<String>,
    pub progress: Option<OperationProgress>,
    pub events: Option<Vec<OperationEvent>>,
    /// A stop's or an archive's final checkpoint: committed, failed,
    /// timed-out or skipped (§10.3). A string so a newer server's value still
    /// reaches the page.
    #[serde(default)]
    pub checkpoint: Option<String>,
    /// When the runtime reported that checkpoint. Absent from an older
    /// server, and for one the runtime never answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_at: Option<i64>,
    /// A delete's cleanup report until the provider confirms (§10.4).
    #[serde(default)]
    pub cleanup: Option<CleanupReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logs: Option<Vec<OperationLog>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, deserialize_with = "safe_provider_error_code", skip_serializing_if = "Option::is_none")]
    pub reason_detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationLog {
    pub source: String,
    pub content: String,
    pub occurred_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub complete: bool,
    pub items: Vec<CleanupItem>,
}

/// `kind` and `state` stay strings: the page names the known ones and shows
/// any other as it comes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub kind: String,
    pub state: String,
    #[serde(default)]
    pub provider_stage: Option<String>,
    #[serde(default)]
    pub expected_by: Option<i64>,
    /// The provider's id for the deletion it accepted, which its support
    /// asks for (admins only; absent from an older server). Only an id-like
    /// token passes.
    #[serde(default, deserialize_with = "safe_provider_operation_id", skip_serializing_if = "Option::is_none")]
    pub provider_operation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationEvent {
    pub code: OperationEventCode,
    pub occurred_at: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationEventCode {
    OperationQueued,
    ProviderPreflightStarted,
    MachineAllocationStarted,
    RuntimeInstallationStarted,
    CredentialsInstalling,
    CredentialsReady,
    RepositoryCloning,
    RepositoryReady,
    RepositoryCloneFailed,
    RelayConnectionStarted,
    ProviderCleanupStarted,
    WorkspaceReady,
    OperationFailed,
    OperationCanceled,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationType {
    Create,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetryReason {
    RateLimited,
}

// Project only the member-safe fields the desktop presents.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStartProgress {
    organization_id: String,
    workspace_id: String,
    operation: CloudStartProgressOperation,
    steps: Vec<CloudStartProgressStep>,
    events: Vec<CloudStartProgressEvent>,
}

#[derive(Deserialize, Serialize)]
struct CloudStartProgressOperation {
    id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudStartProgressStep {
    key: String,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    duration_ms: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudStartProgressEvent {
    id: String,
    state: String,
    stage: String,
    milestone: Option<String>,
    occurred_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceDetailsResponse {
    pub workspace: CloudWorkspace,
    pub details: CloudWorkspaceDetails,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceDetails {
    pub organization_id: String,
    pub workspace_id: String,
    pub created_by: String,
    pub provider: String,
    pub repositories: Vec<DetailsRepository>,
    pub machine_id: Option<String>,
    pub environment_version_id: Option<String>,
    pub environment_version: Option<DetailsEnvironmentVersion>,
    pub runtime: Option<DetailsRuntime>,
    pub provisioning_log: Option<DetailsProvisioningLog>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsRepository {
    pub identity: Option<String>,
    pub full_name: Option<String>,
    pub clone_url: String,
    #[serde(rename = "ref")]
    pub git_ref: Option<String>,
    pub target_directory: Option<String>,
    pub primary: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsEnvironmentVersion {
    pub id: String,
    pub version_number: i64,
    pub toolchain_version: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsRuntime {
    pub sha256: String,
    pub protocol: Option<i64>,
    pub installed_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsProvisioningLog {
    pub url: String,
    pub operation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CloudWorkspaceSnapshot {
    pub workspace: CloudWorkspace,
    pub operation: CloudWorkspaceOperation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceListItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub following: Option<bool>,
    pub workspace: CloudWorkspace,
    pub latest_operation: Option<CloudWorkspaceOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_markers: Option<Vec<crate::desktop_inbox::ReadMarker>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presence: Option<CatalogPresence>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CloudWorkspaceList {
    pub workspaces: Vec<CloudWorkspaceListItem>,
    /// Workspaces deleted in the last 30 days, content-free (§10.5): what
    /// this desktop kept of them is purged.
    #[serde(default)]
    pub tombstones: Vec<CloudWorkspaceTombstone>,
    /// The organization's workspace slots (§20.1); absent from older servers.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub quota: Option<CloudWorkspaceQuota>,
}

/// One Organization of the catalog feed (saas contract §23): its list as
/// `GET …/cloud-workspaces` answers it, or why it could not be listed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCatalogOrganization {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presence: Option<CatalogPresence>,
    pub org_id: String,
    #[serde(default)]
    pub workspaces: Vec<CloudWorkspaceListItem>,
    #[serde(default)]
    pub tombstones: Vec<CloudWorkspaceTombstone>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub quota: Option<CloudWorkspaceQuota>,
    /// Set when this Organization was not listed; the others are unaffected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudCatalogBody {
    cursor: String,
    #[serde(default)]
    reset: bool,
    organizations: Vec<CloudCatalogOrganization>,
    #[serde(default)]
    deleted_workspace_ids: Vec<String>,
}

/// What `cloud_catalog_feed` hands the webview. `changed: false` is the
/// server's 304: the catalog the cursor names is still current.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCatalogFeed {
    pub viewer_user_id: String,
    pub changed: bool,
    pub cursor: Option<String>,
    /// The answer is the whole catalog and replaces what the desktop holds.
    pub reset: bool,
    pub organizations: Vec<CloudCatalogOrganization>,
    pub deleted_workspace_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceTombstone {
    pub id: String,
    pub org_id: String,
    pub deleted_at: i64,
    pub expires_at: i64,
}

/// `GET …/cloud-workspaces/:id/disposition` (§10.2): what the server knows
/// before an archive or delete. Enumerations stay strings so a newer server's
/// values reach the page.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceDisposition {
    pub workspace_id: String,
    pub state: String,
    pub provider: String,
    #[serde(default)]
    pub archived_at: Option<i64>,
    #[serde(default)]
    pub delete_after: Option<i64>,
    #[serde(default)]
    pub active_operation: Option<DispositionOperation>,
    pub runtime: DispositionRuntime,
    #[serde(default)]
    pub attached_clients: u32,
    pub provider_capabilities: DispositionCapabilities,
    pub archive_retention_days: u32,
    /// The periods an archive may ask for instead; empty from a server that
    /// takes no choice.
    #[serde(default)]
    pub archive_retention_choices: Vec<u32>,
    #[serde(default)]
    pub blockers: Vec<String>,
    #[serde(default)]
    pub removed_on_delete: Vec<String>,
    pub runtime_facts: DispositionRuntimeFacts,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispositionOperation {
    pub id: String,
    pub action: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispositionRuntime {
    pub reporting: bool,
    #[serde(default)]
    pub reported_at: Option<i64>,
    pub stale: bool,
    pub active_turns: u32,
    pub pending_approvals: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispositionCapabilities {
    pub permanent_delete: bool,
    pub release_disposition: String,
    /// Whether a resume after a stop brings the same processes back (a warm
    /// reconnect) or is a cold boot. Absent from an older server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preserves_processes_on_resume: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispositionRuntimeFacts {
    pub available: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceCreateInput {
    pub name: String,
    pub quote_id: String,
    pub access_mode: WorkspaceAccessMode,
    pub confirm_provider_spend: bool,
    pub idempotency_key: String,
    /// The primary repository first, then additional ones (at most five).
    #[serde(default)]
    pub repositories: Vec<CreateRepository>,
    /// The agent and first prompt (PRO-21, contract §19.1).
    #[serde(default)]
    pub launch: Option<CreateLaunch>,
    /// A preparation workspace for "Configure with an agent" (PRO-20): the
    /// server keeps it private to its admin, gives it none of the
    /// organization's secrets and stops it at its own time limit.
    #[serde(default)]
    pub preparation: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepository {
    pub clone_url: String,
    /// The base revision (a branch); the default branch when absent.
    #[serde(default, rename = "ref")]
    pub base_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateLaunch {
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    /// Settings → Experimental → Native Codex for a Codex launch (#745): the
    /// runtime starts the first tab on Codex's app server where it can.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub native_codex: bool,
}

pub use crate::cloud_agents::launch::{MAX_PROMPT_BYTES, MAX_REPOSITORIES};
const NAME_MAX_CHARS: usize = 80;

/// The create's own checks (contract §19.1), made before anything is quoted
/// or sent: an invalid name, repository, ref or launch never costs a quote.
pub fn validate_create(
    name: &str,
    repositories: &[CreateRepository],
    launch: Option<&CreateLaunch>,
) -> Result<(), CloudWorkspaceClientError> {
    let invalid = |code: &str| Err(CloudWorkspaceClientError::local(code, false));
    let name = name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX_CHARS || name.chars().any(char::is_control) {
        return invalid("cloud_workspace_name_invalid");
    }
    if repositories.len() > MAX_REPOSITORIES {
        return invalid("cloud_workspace_repositories_too_many");
    }
    let mut seen = std::collections::HashSet::new();
    for repository in repositories {
        if !valid_clone_url(&repository.clone_url) {
            return invalid("cloud_workspace_repository_invalid");
        }
        if !seen.insert(repository.clone_url.to_ascii_lowercase().trim_end_matches(".git").to_string()) {
            return invalid("cloud_workspace_repository_duplicate");
        }
        if repository.base_ref.as_deref().is_some_and(|base| !crate::cloud_agents::launch::valid_branch(base)) {
            return invalid("cloud_workspace_repository_ref_invalid");
        }
    }
    if let Some(launch) = launch {
        let agent_ok = crate::cloud_agents::launch::valid_agent(&launch.agent);
        let model_ok = launch.model.as_deref().is_none_or(|model| (1..=100).contains(&model.len()) && model.bytes().all(|byte| (0x20..=0x7e).contains(&byte)));
        let effort_ok = launch.effort.as_deref().is_none_or(|effort| (1..=16).contains(&effort.len()) && effort.bytes().all(|byte| byte.is_ascii_lowercase()));
        let mode_ok = launch.mode.as_deref().is_none_or(|mode| matches!(mode, "plan" | "manual" | "auto" | "acceptEdits" | "bypassPermissions"));
        if !agent_ok || !model_ok || !effort_ok || !mode_ok {
            return invalid("cloud_workspace_launch_invalid");
        }
        if launch.prompt.as_deref().is_some_and(|prompt| prompt.len() > MAX_PROMPT_BYTES || prompt.contains('\0')) {
            return invalid("cloud_workspace_prompt_too_long");
        }
    }
    Ok(())
}

fn valid_clone_url(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://github.com/") else { return false };
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let segment = |part: Option<&str>| {
        part.is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')))
    };
    segment(parts.next()) && segment(parts.next()) && parts.next().is_none()
}

fn setup_body(repositories: &[CreateRepository]) -> Value {
    let mut body = json!({ "version": 1, "credentialIds": [] });
    // A setup may name no repository at all, but never an empty list.
    if !repositories.is_empty() {
        body["repositories"] = repositories
            .iter()
            .map(|repository| {
                let mut entry = json!({ "sourceProvider": "github", "cloneUrl": repository.clone_url });
                if let Some(base) = &repository.base_ref {
                    entry["ref"] = json!(base);
                }
                entry
            })
            .collect();
    }
    body
}

fn launch_body(launch: &CreateLaunch) -> Value {
    let mut body = json!({ "v": 1, "agent": launch.agent });
    for (name, value) in [("model", &launch.model), ("effort", &launch.effort), ("mode", &launch.mode)] {
        if let Some(value) = value.as_deref().filter(|value| !value.is_empty()) {
            body[name] = json!(value);
        }
    }
    if let Some(prompt) = launch.prompt.as_deref().filter(|prompt| !prompt.trim().is_empty()) {
        body["prompt"] = json!(prompt);
    }
    if launch.native_codex {
        body["nativeCodex"] = json!(true);
    }
    body
}

/// Whether a create that asked for native Codex was refused as malformed,
/// which is how a server from before the field answers it.
fn refused_native_codex(body: &Value, error: &CloudWorkspaceClientError) -> bool {
    body["launch"]["nativeCodex"] == json!(true) && error.status == Some(422) && error.code == "cloud_workspace_request_invalid"
}

/// `POST …/cloud-workspaces/preflight`: can these repositories and refs be
/// used, checked against GitHub before anything is quoted.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspacePreflight {
    pub ready: bool,
    #[serde(default)]
    pub checks: Vec<PreflightCheck>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightCheck {
    pub kind: String,
    #[serde(default)]
    pub clone_url: Option<String>,
    /// On an `agent-credential` check from an API that answers per agent
    /// (PRO-78): the agent it is about.
    #[serde(default)]
    pub agent: Option<String>,
    pub status: String,
    #[serde(default, deserialize_with = "safe_optional_error_code")]
    pub error_code: Option<String>,
    #[serde(default)]
    pub retryable: bool,
}

/// A repository the organization chose for cloud workspaces (PRO-14), as
/// the create form lists it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectedRepository {
    /// Selected organization repository row ID, when provided by the server.
    #[serde(default)]
    pub id: Option<String>,
    pub full_name: String,
    #[serde(default)]
    pub clone_url: Option<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub private: bool,
    /// `accessible`, `missing`, `installation-suspended` or `installation-revoked`.
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedRepositories {
    #[serde(default)]
    pub configured: bool,
    #[serde(default)]
    pub repositories: Vec<SelectedRepository>,
}

/// The collaboration role a share grants (contract §21.2): `viewer` reads,
/// `driver` also sends to agents and types into terminals; `manager` manages shares.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShareRole {
    Viewer,
    Driver,
    Manager,
}

/// Someone's effective role on a workspace (§21.1).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CollaborationRole {
    Manager,
    Driver,
    Viewer,
    None,
}

/// An active share of a cloud workspace with one organization member.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceShare {
    pub user_id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    pub role: ShareRole,
    pub can_approve: bool,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The caller's own standing on the workspace, as the share list reports it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShareViewer {
    pub role: CollaborationRole,
    pub can_approve: bool,
    pub can_manage_shares: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceShares {
    pub shares: Vec<CloudWorkspaceShare>,
    pub you: ShareViewer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_shares: Option<Vec<CloudGroupShare>>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub general_access: Option<GeneralAccess>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ShareCapabilities>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum GeneralAccess {
    InvitedOnly,
    Organisation { role: GeneralAccessRole },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeneralAccessRole {
    Read,
    Write,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShareCapabilities {
    pub can_change_general_access: bool,
    pub can_grant_admin: bool,
    pub can_use_organisation_write: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneralAccessChange {
    pub access_revision: String,
    pub general_access: GeneralAccess,
}

fn valid_access_revision(value: &str) -> bool {
    !value.is_empty() && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<i64>().is_ok()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWorkspaceShares {
    shares: Vec<CloudWorkspaceShare>,
    you: ShareViewer,
    #[serde(default, deserialize_with = "lenient")]
    general_access: Option<GeneralAccess>,
    #[serde(default, deserialize_with = "lenient")]
    access_revision: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    capabilities: Option<ShareCapabilities>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudGroup {
    id: String,
    name: String,
    member_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudGroupPage {
    groups: Vec<CloudGroup>,
    next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudGroupShare {
    group_id: String,
    group: CloudGroup,
    role: ShareRole,
    can_approve: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ShareSubjectType { User, Group }

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ShareSubject {
    #[serde(rename = "type")]
    kind: ShareSubjectType,
    id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum AccessChange {
    Put { id: String, subject: ShareSubject, role: ShareRole, can_approve: bool },
    Remove { id: String, subject: ShareSubject },
}

impl AccessChange {
    fn identifiers(&self) -> (&str, &str) {
        match self {
            Self::Put { id, subject, .. } | Self::Remove { id, subject } => (id, &subject.id),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudAccessApply {
    access_revision: String,
    request_id: String,
    changes: Vec<AccessChange>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "lowercase", rename_all_fields = "camelCase")]
enum AccessResult {
    Applied { id: String },
    Failed { id: String, code: String, message: String },
}

impl AccessResult {
    fn id(&self) -> &str {
        match self {
            Self::Applied { id } | Self::Failed { id, .. } => id,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccessApplied {
    access_revision: String,
    shares: Vec<CloudWorkspaceShare>,
    group_shares: Vec<CloudGroupShare>,
    results: Vec<AccessResult>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CloudWorkspaceShareChange {
    pub share: CloudWorkspaceShare,
    /// Only on a grant: false when an existing share was updated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<bool>,
}

/// When a scheduled task runs (saas contract §24.2). `hour` is not part of
/// `hourly`; `weekdays` (`mon` … `sun`) only of `weekly`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudScheduleTiming {
    pub preset: String,
    #[serde(default)]
    pub hour: u8,
    pub minute: u8,
    #[serde(default)]
    pub weekdays: Vec<String>,
    pub timezone: String,
}

/// Selected organization repository row ID, never a GitHub numeric ID or URL.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudScheduleGithubTrigger {
    pub repository_id: String,
    pub event: String,
    pub filters: Vec<CloudScheduleGithubFilter>,
    #[serde(default)]
    pub allow_fork_pull_requests: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudScheduleGithubFilter {
    pub field: String,
    pub operator: String,
    pub value: String,
}

/// Upper bounds on what a schedule costs and occupies, from the workspace's
/// own rate.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudScheduleEstimate {
    pub currency: String,
    pub hourly_micros: u64,
    /// The longest a run can keep the machine on: the wait for the runtime
    /// to take it, the limit, and the grace after it. A server that does not
    /// state it priced the limit alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_run_max_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_per_run_minutes: Option<u32>,
    pub per_run_max_micros: u64,
    pub monthly_runs: u32,
    pub monthly_max_micros: u64,
    /// Under `completionPolicy: "keep"` the machine a run starts stays on.
    #[serde(default)]
    pub keeps_machine_running: bool,
    #[serde(default)]
    pub running_slots: u32,
    /// The most runs the schedule starts in any 24 hours.
    pub max_runs_per_day: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudScheduleRun {
    pub id: String,
    pub scheduled_for: i64,
    #[serde(default)]
    pub trigger: String,
    /// Own allocated workspace; absent before fresh allocation. Never use the template ID.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub work_branch: Option<String>,
    #[serde(default)]
    pub archive_at: Option<i64>,
    /// Observed archival, not an archive request.
    #[serde(default)]
    pub archived_at: Option<i64>,
    /// queued | creating-workspace | provisioning | working | completed | failed | skipped |
    /// canceled | expired.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CloudScheduleRunNow {
    pub run: CloudScheduleRun,
    pub duplicate: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudScheduleCreator {
    pub user_id: String,
    pub display_name: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceNudgeInput {
    target_user_id: String,
    workspace_id: String,
    session_id: String,
    text: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NudgePreference {
    pub enabled: bool,
}

/// PRO-241: what the sidebar's card shows, for this app's version.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopAnnouncement {
    pub id: String,
    pub title: String,
    pub body: String,
    pub link: Option<String>,
    pub is_new: bool,
    pub published_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CurrentAnnouncement {
    pub announcement: Option<DesktopAnnouncement>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NudgeReceipt {
    pub delivered: bool,
}

/// A scheduled task as the API shows it. The prompt is never returned:
/// `prompt_bytes` says how long it is.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSchedule {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub console_url: Option<String>,
    pub workspace_id: String,
    pub name: String,
    #[serde(default)]
    pub created_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<CloudScheduleCreator>,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default)]
    pub prompt_bytes: u64,
    #[serde(default)]
    pub schedule: Option<CloudScheduleTiming>,
    #[serde(default)]
    pub github_trigger: Option<CloudScheduleGithubTrigger>,
    #[serde(default)]
    pub webhook_trigger: Option<CloudScheduleWebhookTrigger>,
    #[serde(default = "existing_workspace_mode", deserialize_with = "response_workspace_mode")]
    pub workspace_mode: String,
    #[serde(default)]
    pub archive_after_days: Option<u32>,
    #[serde(default, deserialize_with = "response_archive_on_pr_merge")]
    pub archive_on_pr_merge: bool,
    pub missed_run_policy: String,
    pub completion_policy: String,
    pub max_run_minutes: u32,
    /// `active` or `paused`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    pub estimate: CloudScheduleEstimate,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<CloudScheduleRun>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CloudSchedules {
    pub schedules: Vec<CloudSchedule>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CloudScheduleDetail {
    pub schedule: CloudSchedule,
    /// The newest runs first, at most 50.
    #[serde(default)]
    pub runs: Vec<CloudScheduleRun>,
}

#[derive(Deserialize, Serialize)]
pub struct CloudScheduleEdit {
    schedule: CloudSchedule,
    configuration: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct CloudScheduleAnswer {
    schedule: CloudSchedule,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudScheduleWebhookTrigger {
    #[serde(skip_deserializing)]
    pub url: String,
    #[serde(skip_deserializing)]
    pub secret_updated_at: Option<i64>,
    #[serde(skip_serializing)]
    path: String,
}

/// The request opts into a webhook without supplying any configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudScheduleWebhookInput;

impl<'de> Deserialize<'de> for CloudScheduleWebhookInput {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let fields = std::collections::BTreeMap::<String, serde::de::IgnoredAny>::deserialize(deserializer)?;
        if !fields.is_empty() {
            return Err(serde::de::Error::custom("webhookTrigger must be an empty object"));
        }
        Ok(Self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudScheduleSecretAnswer {
    schedule: CloudScheduleSecretView,
}

// Read responses deserialize straight into CloudSchedule, which ignores secret fields.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudScheduleSecretView {
    #[serde(flatten)]
    view: CloudSchedule,
    webhook_trigger: Option<CloudScheduleSecretTrigger>,
}

#[derive(Deserialize)]
struct CloudScheduleSecretTrigger {
    #[serde(flatten)]
    metadata: CloudScheduleWebhookTrigger,
    #[serde(default, deserialize_with = "deserialize_webhook_secret")]
    secret: Option<zeroize::Zeroizing<String>>,
}

fn deserialize_webhook_secret<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<zeroize::Zeroizing<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(|secret| secret.map(zeroize::Zeroizing::new))
}

/// Only create and rotate can serialize the one-time secret to the webview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudScheduleWriteResult {
    #[serde(flatten)]
    view: CloudSchedule,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "serialize_webhook_secret")]
    webhook_secret: Option<zeroize::Zeroizing<String>>,
}

fn serialize_webhook_secret<S: serde::Serializer>(
    secret: &Option<zeroize::Zeroizing<String>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    secret.as_deref().serialize(serializer)
}

impl std::fmt::Debug for CloudScheduleWriteResult {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("CloudScheduleWriteResult")
            .field("view", &self.view)
            .finish_non_exhaustive()
    }
}

impl CloudScheduleSecretView {
    fn into_write_result(mut self, client: &Client, webhook: bool) -> Result<CloudScheduleWriteResult, CloudWorkspaceClientError> {
        let webhook_secret = match (self.webhook_trigger, webhook) {
            (Some(trigger), true) if trigger.secret.as_ref().is_some_and(|secret| !secret.is_empty()) => {
                self.view.webhook_trigger = Some(trigger.metadata);
                trigger.secret
            }
            (None, false) => None,
            _ => return Err(post_send_error(RequestRisk::Mutation)),
        };
        client.normalize_schedule(&mut self.view, &mut [], RequestRisk::Mutation)?;
        Ok(CloudScheduleWriteResult { view: self.view, webhook_secret })
    }
}

/// What a schedule would cost and when it would first run, before it is saved.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudScheduleQuote {
    pub estimate: CloudScheduleEstimate,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    /// Whether the workspace's runtime can take a scheduled run.
    pub supported: bool,
    /// The refusal a create would get now, whatever the schedule says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CloudSchedulesPaused {
    pub paused: u32,
}

/// What the cost of a schedule depends on, asked before it is saved.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudScheduleEstimateInput {
    pub workspace_id: String,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub schedule: Option<CloudScheduleTiming>,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub github_trigger: Option<CloudScheduleGithubTrigger>,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub webhook_trigger: Option<CloudScheduleWebhookInput>,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub workspace_mode: Option<String>,
    pub completion_policy: String,
    pub max_run_minutes: u32,
}

/// A new scheduled task. The spend is confirmed by the person in the window
/// before this is sent; the request says so itself.
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudScheduleCreateInput {
    pub workspace_id: String,
    pub name: String,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub mode: String,
    pub prompt: String,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub schedule: Option<CloudScheduleTiming>,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub github_trigger: Option<CloudScheduleGithubTrigger>,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub webhook_trigger: Option<CloudScheduleWebhookInput>,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub workspace_mode: Option<String>,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub archive_after_days: Option<u32>,
    #[serde(default, deserialize_with = "present_automation_field")]
    pub archive_on_pr_merge: Option<bool>,
    pub missed_run_policy: String,
    pub completion_policy: String,
    pub max_run_minutes: u32,
}

/// The modes a schedule may start its agent in: every launch mode but
/// bypass permissions, since nobody watches a scheduled run.
const SCHEDULE_MODES: [&str; 4] = ["plan", "manual", "auto", "acceptEdits"];
const SCHEDULE_PRESETS: [&str; 4] = ["hourly", "daily", "weekdays", "weekly"];
const SCHEDULE_WEEKDAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const SCHEDULE_NAME_CHARS: usize = 80;
const SCHEDULE_RUN_MINUTES: std::ops::RangeInclusive<u32> = 5..=240;

/// The `schedule` object as the server's strict parser takes it, or `None`
/// for times it would refuse.
fn schedule_timing_body(timing: &CloudScheduleTiming) -> Option<Value> {
    let preset = timing.preset.as_str();
    let weekly = preset == "weekly";
    let mut days = timing.weekdays.clone();
    days.sort();
    days.dedup();
    if !SCHEDULE_PRESETS.contains(&preset)
        || timing.minute > 59
        || timing.hour > 23
        || timing.timezone.is_empty()
        || timing.timezone.len() > 64
        || (weekly && (timing.weekdays.is_empty() || days.len() != timing.weekdays.len()))
        || !timing.weekdays.iter().all(|day| SCHEDULE_WEEKDAYS.contains(&day.as_str()))
    {
        return None;
    }
    let mut body = json!({ "preset": preset, "minute": timing.minute, "timezone": timing.timezone });
    if preset != "hourly" {
        body["hour"] = json!(timing.hour);
    }
    if weekly {
        body["weekdays"] = json!(timing.weekdays);
    }
    Some(body)
}

/// Optional request fields may be omitted, but explicit null is not accepted
/// by the SaaS parser. Response DTOs remain nullable for compatibility.
fn present_automation_field<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn existing_workspace_mode() -> String { "existing".into() }

// Compatible responses may omit these fields or send null. Keep request
// parsing strict: only response DTOs use these defaults.
fn response_workspace_mode<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_else(existing_workspace_mode))
}

fn response_archive_on_pr_merge<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(Option::<bool>::deserialize(deserializer)?.unwrap_or(false))
}

/// The server may retain the template as an internal pre-allocation placeholder.
/// Expose no link until a fresh run has its own allocated workspace.
fn automation_run_identity(schedule: &mut CloudSchedule, runs: &mut [CloudScheduleRun]) {
    if schedule.workspace_mode != "fresh" { return; }
    for run in runs.iter_mut().chain(schedule.last_run.iter_mut()) {
        if run.workspace_id.as_deref() == Some(schedule.workspace_id.as_str()) {
            run.workspace_id = None;
        }
    }
}

/// Validate before consulting account/provider state or making HTTP requests.
fn automation_body(
    timing: Option<&CloudScheduleTiming>, github: Option<&CloudScheduleGithubTrigger>, webhook: bool,
    mode: Option<&str>, archive_days: Option<u32>, archive_merge: Option<bool>,
) -> Option<Value> {
    let fresh = mode == Some("fresh");
    if mode.is_some_and(|m| !matches!(m, "existing" | "fresh"))
        || archive_days.is_some_and(|days| !fresh || !(1..=365).contains(&days))
        || (archive_merge == Some(true) && !fresh)
    { return None; }
    let mut body = json!({});
    match (timing, github, webhook) {
        (None, None, true) => body["webhookTrigger"] = json!({}),
        (Some(timing), None, false) => body["schedule"] = schedule_timing_body(timing)?,
        (None, Some(trigger), false) => {
            if trigger.repository_id.is_empty() || trigger.repository_id.encode_utf16().count() > 255
                || !matches!(trigger.event.as_str(), "opened" | "pushed" | "merged")
                || trigger.filters.len() > 5
                || trigger.filters.iter().any(|f| !matches!(f.field.as_str(), "label" | "author" | "baseBranch")
                    || !matches!(f.operator.as_str(), "is" | "is-not") || f.value.trim().is_empty()
                    || f.value.encode_utf16().count() > 255 || f.value.chars().any(|c| c < ' ' || c == '\u{7f}'))
            { return None; }
            let mut trigger = trigger.clone();
            for filter in &mut trigger.filters { filter.value = filter.value.trim().to_owned(); }
            body["githubTrigger"] = serde_json::to_value(trigger).ok()?;
        }
        _ => return None,
    }
    if let Some(mode) = mode { body["workspaceMode"] = json!(mode); }
    if let Some(days) = archive_days { body["archiveAfterDays"] = json!(days); }
    if let Some(merge) = archive_merge { body["archiveOnPrMerge"] = json!(merge); }
    Some(body)
}

fn valid_schedule_revision(value: u64) -> bool {
    value < (1u64 << 53)
}

fn valid_schedule_id(value: &str) -> bool {
    value.len() == "schedule_".len() + 36
        && value.strip_prefix("schedule_").is_some_and(|rest| rest.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-')))
}

fn valid_schedule_policies(missed: Option<&str>, completion: &str, minutes: u32) -> bool {
    missed.is_none_or(|missed| matches!(missed, "skip" | "run-once")) && matches!(completion, "suspend" | "keep") && SCHEDULE_RUN_MINUTES.contains(&minutes)
}

// PRO-137 uses the existing account IDs, independently of PRO-133's stricter IDs.
fn valid_following_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte|
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'-'))
}

fn valid_following_path_id(value: &str) -> bool {
    // URL parsers normalize standalone dot segments; never address a different route.
    valid_following_id(value) && !matches!(value, "." | "..")
}

fn valid_reassign_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36 && bytes.iter().enumerate().all(|(i, byte)| match i {
        8 | 13 | 18 | 23 => *byte == b'-',
        14 => matches!(*byte, b'1'..=b'8'),
        19 => matches!(*byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
        _ => byte.is_ascii_hexdigit(),
    })
}

// Missing is allowed via default; explicit null must pass T's nonnullable decoder.
fn optional_nonnull<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReassignInput {
    pub target_user_id: String,
    pub expected_owner_id: String,
    pub request_id: String,
    #[serde(default, deserialize_with = "optional_nonnull", skip_serializing_if = "Option::is_none")]
    pub confirm_private: Option<bool>,
    #[serde(default, deserialize_with = "optional_nonnull", skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn reassign_input(body: Value) -> Result<WorkspaceReassignInput, CloudWorkspaceClientError> {
    if !body.is_object() { return Err(inbox_invalid()); }
    let input: WorkspaceReassignInput = serde_json::from_value(body).map_err(|_| inbox_invalid())?;
    if !valid_following_id(&input.target_user_id) || !valid_following_id(&input.expected_owner_id)
        || !valid_reassign_uuid(&input.request_id) || input.note.as_deref().is_some_and(|note| {
            note.encode_utf16().count() > 500 || note.chars().any(|ch|
                (ch <= '\u{1f}' && ch != '\n' && ch != '\t') || matches!(ch, '\u{7f}' | '<' | '>'))
        }) { return Err(inbox_invalid()); }
    Ok(input)
}

/// A chat mention (PRO-141). No text field exists, so none can be sent.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceMentionsInput {
    session_id: String,
    tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    user_ids: Vec<String>,
    #[serde(default)]
    check: bool,
}

fn mentions_input(body: Value) -> Result<WorkspaceMentionsInput, CloudWorkspaceClientError> {
    if !body.is_object() { return Err(inbox_invalid()); }
    let input: WorkspaceMentionsInput = serde_json::from_value(body).map_err(|_| inbox_invalid())?;
    let distinct: std::collections::HashSet<&String> = input.user_ids.iter().collect();
    let tab_ok = !input.tab_id.is_empty() && input.tab_id.len() <= 128
        && input.tab_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
    if !valid_following_id(&input.session_id) || !tab_ok
        || input.message_id.as_deref().map_or(!input.check, |id| !valid_following_id(id))
        || input.user_ids.is_empty() || input.user_ids.len() > 10 || distinct.len() != input.user_ids.len()
        || !input.user_ids.iter().all(|id| valid_following_id(id)) { return Err(inbox_invalid()); }
    Ok(input)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceMentionsResponse {
    pub workspace_id: String,
    /// Now following the workspace and notified.
    pub mentioned: Vec<String>,
    /// Cannot watch the workspace; when any are listed nothing was written.
    pub no_access: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFollowingResponse {
    pub workspace_id: String,
    pub following: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReassignResponse {
    pub workspace_id: String,
    pub owner_id: String,
    pub previous_owner_id: String,
    /// False is an exact committed retry receipt, never a current-owner projection.
    pub reassigned: bool,
}

/// Current visible presence only; no timestamps or durable history.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogPresence { pub active_members: Vec<PresencePerson> }

// PRO-133 transport only. No device lifecycle or cached presence state lives here.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresencePutInput {
    pub device_id: String,
    #[serde(deserialize_with = "presence_sequence")]
    pub sequence: u64,
    #[serde(deserialize_with = "required_nullable_string")]
    pub workspace_id: Option<String>,
}

fn required_nullable_string<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

fn presence_sequence<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    // JSON 1.0 is also a JS safe integer; strings and fractional values are not.
    let number = serde_json::Number::deserialize(deserializer)?;
    let value = number.as_f64().ok_or_else(|| <D::Error as serde::de::Error>::custom("invalid sequence"))?;
    if !(1.0..=9_007_199_254_740_991.0).contains(&value) || value.fract() != 0.0 {
        return Err(serde::de::Error::custom("invalid sequence"));
    }
    Ok(value as u64)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceReadInput {
    pub workspace_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresencePerson {
    pub user_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    pub display_name: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    pub photo_url: Option<String>,
}

/// Catalog creator names are additive and do not require a presence photo.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreator {
    pub user_id: String,
    pub display_name: Option<String>,
    pub photo_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceWorkspace {
    pub workspace_id: String,
    /// Current server created_by projection; never inferred from active members.
    pub owner: PresencePerson,
    pub active_members: Vec<PresencePerson>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresencePutResponse {
    pub applied: bool,
    pub ttl_seconds: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceReadResponse {
    pub ttl_seconds: u32,
    pub active_members: Vec<PresencePerson>,
    pub workspaces: Vec<PresenceWorkspace>,
}

fn valid_presence_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_presence_device(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36 && bytes.iter().enumerate().all(|(i, byte)| {
        match i {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'4',
            19 => matches!(*byte, b'8' | b'9' | b'a' | b'b'),
            _ => matches!(*byte, b'0'..=b'9' | b'a'..=b'f'),
        }
    })
}

fn valid_presence_people(people: &[PresencePerson]) -> bool {
    let mut seen = std::collections::HashSet::new();
    people.len() <= 500 && people.iter().all(|person| valid_presence_id(&person.user_id) && seen.insert(&person.user_id))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceClientError {
    pub code: String,
    pub status: Option<u16>,
    pub retryable: bool,
    pub retry_after_seconds: Option<u64>,
    pub retry_with_same_idempotency_key: bool,
    pub requires_original_account_context: bool,
}

impl CloudWorkspaceClientError {
    pub(crate) fn local(code: &str, retryable: bool) -> Self {
        Self {
            code: code.into(),
            status: None,
            retryable,
            retry_after_seconds: None,
            retry_with_same_idempotency_key: false,
            requires_original_account_context: false,
        }
    }

    pub(crate) fn task_failed(risk: RequestRisk) -> Self {
        match risk {
            RequestRisk::Read => Self::local("cloud_workspace_client_unavailable", true),
            RequestRisk::Mutation => post_send_error(RequestRisk::Mutation),
            RequestRisk::Create => create_outcome_unknown(),
        }
    }
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: String,
}

#[derive(Clone, Copy)]
pub(crate) enum RequestRisk {
    Read,
    Mutation,
    Create,
}

struct Client {
    base: Url,
    timeout: Duration,
}

impl Client {
    fn production() -> Self {
        Self {
            base: Url::parse(&crate::account::api_base_url()).expect("valid account service URL"),
            timeout: REQUEST_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn for_test(base: &str, timeout: Duration) -> Self {
        Self {
            base: Url::parse(base).unwrap(),
            timeout,
        }
    }

    fn normalize_schedule(
        &self,
        schedule: &mut CloudSchedule,
        runs: &mut [CloudScheduleRun],
        risk: RequestRisk,
    ) -> Result<(), CloudWorkspaceClientError> {
        if let Some(trigger) = &mut schedule.webhook_trigger {
            let valid_path = trigger.path.strip_prefix("/v1/automation-webhooks/whk_")
                .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7')));
            if !valid_path {
                return Err(post_send_error(risk));
            }
            trigger.url = format!("{}{}", self.base.origin().ascii_serialization(), trigger.path);
            // The API returns an hourly placeholder for event-driven schedules.
            schedule.schedule = None;
        }
        automation_run_identity(schedule, runs);
        Ok(())
    }

    fn request<T: DeserializeOwned>(
        &self,
        context: &AccountContext,
        tail: &[&str],
        query: Option<(&str, &str)>,
        body: Option<Value>,
        idempotency_key: Option<&str>,
        risk: RequestRisk,
    ) -> Result<T, CloudWorkspaceClientError> {
        let method = if matches!(risk, RequestRisk::Read) { "GET" } else { "POST" };
        self.request_as(method, context, tail, query, body, idempotency_key, risk)
    }

    #[allow(clippy::too_many_arguments)]
    fn request_as<T: DeserializeOwned>(
        &self,
        method: &str,
        context: &AccountContext,
        tail: &[&str],
        query: Option<(&str, &str)>,
        body: Option<Value>,
        idempotency_key: Option<&str>,
        risk: RequestRisk,
    ) -> Result<T, CloudWorkspaceClientError> {
        self.send(method, context, tail, query, body, idempotency_key, risk, RESPONSE_LIMIT_BYTES)
    }

    /// Like [`Self::request`], for an answer that may pass the usual size cap.
    #[allow(clippy::too_many_arguments)]
    fn request_limited<T: DeserializeOwned>(
        &self,
        context: &AccountContext,
        tail: &[&str],
        query: Option<(&str, &str)>,
        body: Option<Value>,
        idempotency_key: Option<&str>,
        risk: RequestRisk,
        limit: u64,
    ) -> Result<T, CloudWorkspaceClientError> {
        let method = if matches!(risk, RequestRisk::Read) { "GET" } else { "POST" };
        self.send(method, context, tail, query, body, idempotency_key, risk, limit)
    }

    #[allow(clippy::too_many_arguments)]
    fn send<T: DeserializeOwned>(
        &self,
        method: &str,
        context: &AccountContext,
        tail: &[&str],
        query: Option<(&str, &str)>,
        body: Option<Value>,
        idempotency_key: Option<&str>,
        risk: RequestRisk,
        limit: u64,
    ) -> Result<T, CloudWorkspaceClientError> {
        self.send_body(method, context, tail, query, body.map(RequestBody::Json), idempotency_key, risk, limit)
    }

    /// A mutation whose JSON body holds a secret: the body is one zeroized
    /// buffer from the caller to the socket, never a second copy in a `Value`.
    fn send_secret<T: DeserializeOwned>(&self, method: &str, context: &AccountContext, tail: &[&str], body: zeroize::Zeroizing<String>) -> Result<T, CloudWorkspaceClientError> {
        self.send_body(method, context, tail, None, Some(RequestBody::Secret(body)), None, RequestRisk::Mutation, RESPONSE_LIMIT_BYTES)
    }

    #[allow(clippy::too_many_arguments)]
    fn send_body<T: DeserializeOwned>(
        &self,
        method: &str,
        context: &AccountContext,
        tail: &[&str],
        query: Option<(&str, &str)>,
        body: Option<RequestBody>,
        idempotency_key: Option<&str>,
        risk: RequestRisk,
        limit: u64,
    ) -> Result<T, CloudWorkspaceClientError> {
        let mut url = self.organization_url(context, tail)?;
        if let Some((key, value)) = query {
            url.query_pairs_mut().append_pair(key, value);
        }
        self.send_url(method, context, url, body, idempotency_key, risk, limit)
    }

    fn organization_url(&self, context: &AccountContext, tail: &[&str]) -> Result<Url, CloudWorkspaceClientError> {
        let mut url = self.base.clone();
        url.path_segments_mut().map_err(|_| {
            CloudWorkspaceClientError::local("cloud_workspace_client_invalid", false)
        })?.extend(["v1", "desktop", "orgs", context.organization_id.as_str()]).extend(tail.iter().copied());
        Ok(url)
    }

    #[allow(clippy::too_many_arguments)]
    fn send_url<T: DeserializeOwned>(&self, method: &str, context: &AccountContext, url: Url, body: Option<RequestBody>, idempotency_key: Option<&str>, risk: RequestRisk, limit: u64) -> Result<T, CloudWorkspaceClientError> {
        let mut request = self.authorized_request(method, context, &url);
        if let Some(key) = idempotency_key {
            request = request.set("Idempotency-Key", key);
        }
        let response = match body {
            Some(RequestBody::Json(body)) => request.send_json(body),
            // A body that holds a secret is sent from its own zeroized buffer.
            Some(RequestBody::Secret(body)) => request.send_string(&body),
            None => request.call(),
        };
        match response {
            Ok(response) => decode_response(response, risk, limit),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response, risk)),
            Err(ureq::Error::Transport(_)) => Err(transport_error(risk)),
        }
    }
    fn inbox_url(&self, tail: &[&str]) -> Result<Url, CloudWorkspaceClientError> {
        let mut url = self.base.clone();
        url.path_segments_mut().map_err(|_| inbox_invalid())?.extend(["v1", "desktop", "organization-inbox"]).extend(tail.iter().copied());
        Ok(url)
    }

    fn authorized_request(&self, method: &str, context: &AccountContext, url: &Url) -> ureq::Request {
        crate::data_privacy::http_agent().timeout(self.timeout).redirects(0).build()
            .request(method, url.as_str())
            .set("authorization", &format!("Bearer {}", context.access_token))
            .set("content-type", "application/json")
            .set("X-TerminalX-Cloud-Workspace-Contract", CONTRACT)
            .set("X-TerminalX-Cloud-Workspace-Providers", SUPPORTED_PROVIDERS)
            .set("X-TerminalX-Cloud-Workspace-Idle-Options", "never-v1")
            .set("X-TerminalX-Cloud-Workspace-Lifecycle", LIFECYCLE)
    }

}

enum RequestBody {
    Json(Value),
    Secret(zeroize::Zeroizing<String>),
}

impl Client {
    /// `GET /v1/desktop/cloud-catalog` (saas contract §23). `None` is the
    /// server's 304: nothing changed since `cursor`.
    fn catalog_feed(&self, context: &AccountContext, cursor: Option<&str>, presence: bool) -> Result<Option<CloudCatalogBody>, CloudWorkspaceClientError> {
        let risk = RequestRisk::Read;
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| CloudWorkspaceClientError::local("cloud_workspace_client_invalid", false))?
            .extend(["v1", "desktop", "cloud-catalog"]);
        if presence { url.query_pairs_mut().append_pair("presence", "1"); }
        let agent = crate::data_privacy::http_agent().timeout(self.timeout).redirects(0).build();
        let mut request = agent
            .request("GET", url.as_str())
            .set("authorization", &format!("Bearer {}", context.access_token))
            .set("X-TerminalX-Cloud-Workspace-Contract", CONTRACT)
            .set("X-TerminalX-Cloud-Workspace-Providers", SUPPORTED_PROVIDERS)
            .set("X-TerminalX-Cloud-Workspace-Idle-Options", "never-v1")
            .set("X-TerminalX-Cloud-Workspace-Lifecycle", LIFECYCLE);
        if let Some(cursor) = cursor {
            request = request.set("If-None-Match", &format!("\"{cursor}\""));
        }
        match request.call() {
            Ok(response) if response.status() == 304 => Ok(None),
            Ok(response) if response.status() == 200 => decode_response(response, risk, CATALOG_RESPONSE_LIMIT_BYTES).map(Some),
            // Redirects are off: any other answer is not this API's.
            Ok(_) => Err(invalid_response()),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response, risk)),
            Err(ureq::Error::Transport(_)) => Err(transport_error(risk)),
        }
    }
}

/// A cursor is the server's opaque token; only one that is safe in a header is sent back.
fn valid_cursor(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub struct CloudWorkspaceService {
    account: Arc<AccountManager>,
    client: Client,
    #[cfg(test)]
    force_phase2_for_test: bool,
}

impl CloudWorkspaceService {
    pub fn new(account: Arc<AccountManager>) -> Self {
        Self {
            account,
            client: Client::production(),
            #[cfg(test)]
            force_phase2_for_test: false,
        }
    }

    #[cfg(test)]
    fn for_test(account: Arc<AccountManager>, base: &str, timeout: Duration) -> Self {
        Self {
            account,
            client: Client::for_test(base, timeout),
            force_phase2_for_test: false,
        }
    }

    /// The context for a call in `organization` (CS-18): the active
    /// Organization when none is named, as before; a named one must be the
    /// active one or, on a server that authorizes by membership, a member
    /// Organization. Never decided by the active Organization alone.
    fn context_in(&self, organization: Option<&str>) -> Result<(AccountContext, OrgAccess), CloudWorkspaceClientError> {
        match organization {
            None => Ok((self.context()?, OrgAccess::Active)),
            Some(organization) => {
                if !valid_resource_id(organization) {
                    return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
                }
                self.account.context_in(organization).map_err(|code| CloudWorkspaceClientError::local(code, false))
            }
        }
    }

    /// The Organization a call for `organization` (the active one when none)
    /// is made in: a member Organization, or an error. No request is made.
    pub fn organization_in(&self, organization: Option<&str>) -> Result<String, CloudWorkspaceClientError> {
        self.context_in(organization).map(|(context, _)| context.organization_id)
    }

    fn context(&self) -> Result<AccountContext, CloudWorkspaceClientError> {
        let context = self
            .account
            .context()
            .ok_or_else(|| CloudWorkspaceClientError::local("account_signed_out", false))?;
        if context.organization_id.is_empty() {
            return Err(CloudWorkspaceClientError::local(
                "account_organization_unavailable",
                false,
            ));
        }
        Ok(context)
    }

    fn run<T>(
        &self,
        risk: RequestRisk,
        operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>,
    ) -> Result<T, CloudWorkspaceClientError> {
        self.run_in(None, risk, operation)
    }

    /// Run a call in `organization` (the active one when none), fenced by
    /// what authorized it: an answer for an Organization the user left, or
    /// for another account, never reaches the webview.
    fn run_in<T>(
        &self,
        organization: Option<&str>,
        risk: RequestRisk,
        operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>,
    ) -> Result<T, CloudWorkspaceClientError> {
        let (context, access) = self.context_in(organization)?;
        let result = operation(&self.client, &context);
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(risk));
        }
        result
    }

    /// Account-wide inbox; never accepts a user or organization selector.
    pub fn inbox(&self, after: &str, wait_ms: u32) -> Result<crate::desktop_inbox::InboxPage, CloudWorkspaceClientError> {
        self.phase2_gate(PHASE2_EVENTS, None, None, "inbox_unavailable")?;
        if !crate::desktop_inbox::valid_cursor(after) || wait_ms > 25_000 { return Err(inbox_invalid()); }
        self.inbox_account(RequestRisk::Read, |client, context| {
            let mut url = client.inbox_url(&[])?;
            url.query_pairs_mut().append_pair("after", after).append_pair("waitMs", &wait_ms.to_string()).append_pair("presence", "1").append_pair("mentions", "1").append_pair("nudges", "1");
            let page: crate::desktop_inbox::InboxPage = client.send_url("GET", context, url, None, None, RequestRisk::Read, CATALOG_RESPONSE_LIMIT_BYTES)?;
            if page.v != 1 || page.events.len() > 100 || page.cursor.parse::<i64>().unwrap() < after.parse::<i64>().unwrap()
                || page.events.iter().any(|event| event.id().parse::<i64>().unwrap() > page.cursor.parse::<i64>().unwrap()) { return Err(post_send_error(RequestRisk::Read)); }
            Ok(page)
        })
    }

    pub fn inbox_stream(&self, after: &str, last_event_id: Option<&str>) -> Result<crate::desktop_inbox::InboxStreamPage, CloudWorkspaceClientError> {
        self.phase2_gate(PHASE2_EVENTS, None, None, "inbox_unavailable")?;
        if !crate::desktop_inbox::valid_cursor(after) || last_event_id.is_some_and(|id| !crate::desktop_inbox::valid_cursor(id)) { return Err(inbox_invalid()); }
        self.inbox_account(RequestRisk::Read, |client, context| {
            let mut url = client.inbox_url(&["stream"])?;
            url.query_pairs_mut().append_pair("after", after).append_pair("presence", "1").append_pair("mentions", "1").append_pair("nudges", "1");
            let mut request = client.authorized_request("GET", context, &url).set("accept", "text/event-stream");
            if let Some(id) = last_event_id { request = request.set("Last-Event-ID", id); }
            let response = match request.call() {
                Ok(response) => response,
                Err(ureq::Error::Status(status, response)) => return Err(http_error(status, response, RequestRisk::Read)),
                Err(_) => return Err(transport_error(RequestRisk::Read)),
            };
            if !response.header("content-type").is_some_and(|value| value.starts_with("text/event-stream")) { return Err(post_send_error(RequestRisk::Read)); }
            let page = crate::desktop_inbox::read_stream(response.into_reader()).map_err(|_| transport_error(RequestRisk::Read))?;
            if page.cursor.parse::<i64>().unwrap() < last_event_id.unwrap_or(after).parse::<i64>().unwrap() { return Err(post_send_error(RequestRisk::Read)); }
            Ok(page)
        })
    }

    pub fn inbox_receipts(&self, event_ids: Vec<String>) -> Result<crate::desktop_inbox::InboxReceipt, CloudWorkspaceClientError> {
        self.phase2_gate(PHASE2_EVENTS, None, None, "inbox_unavailable")?;
        if event_ids.is_empty() || event_ids.len() > 100 || event_ids.iter().any(|id| !crate::desktop_inbox::valid_cursor(id)) { return Err(inbox_invalid()); }
        self.inbox_account(RequestRisk::Mutation, |client, context| client.send_url("POST", context, client.inbox_url(&["receipts"])? , Some(RequestBody::Json(json!({"eventIds": event_ids}))), None, RequestRisk::Mutation, RESPONSE_LIMIT_BYTES))
    }

    fn inbox_account<T>(&self, risk: RequestRisk, operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>) -> Result<T, CloudWorkspaceClientError> {
        let context = self.account.context().ok_or_else(|| CloudWorkspaceClientError::local("account_signed_out", false))?;
        self.phase2_gate(PHASE2_EVENTS, None, Some(&context), "inbox_unavailable")?;
        let before = self.account.scope_if_same_account(&context).ok_or_else(|| context_changed_error(risk))?;
        let result = operation(&self.client, &context);
        if !self.account.scope_if_same_account(&context).is_some_and(|scope| scope.members == before.members) {
            return Err(context_changed_error(risk));
        }
        result
    }

    pub fn read_marker(&self, org: &str, workspace: &str, session_id: Option<String>, read_at: String) -> Result<crate::desktop_inbox::ReadMarker, CloudWorkspaceClientError> {
        self.phase2_gate(PHASE2_EVENTS, Some(org), None, "inbox_unavailable")?;
        if !valid_resource_id(org) || !valid_resource_id(workspace)
            || session_id.as_ref().is_some_and(|id| id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:@-".contains(&b)))
            || chrono::DateTime::parse_from_rfc3339(&read_at).is_err() { return Err(inbox_invalid()); }
        let context = self.account.inbox_member_context(org).map_err(|code| CloudWorkspaceClientError::local(code, false))?;
        self.phase2_gate(PHASE2_EVENTS, Some(org), Some(&context), "inbox_unavailable")?;
        let mut body = json!({"readAt": read_at});
        if let Some(session) = &session_id { body["sessionId"] = json!(session); }
        let result: Result<crate::desktop_inbox::ReadMarker, _> = self.client.request_as("PUT", &context, &["cloud-workspaces", workspace, "read-marker"], None, Some(body), None, RequestRisk::Mutation);
        if !self.account.inbox_member_is_current(&context, org) { return Err(context_changed_error(RequestRisk::Mutation)); }
        let marker = result?;
        if marker.session_id != session_id.unwrap_or_default() || chrono::DateTime::parse_from_rfc3339(&marker.read_at).is_err() { return Err(post_send_error(RequestRisk::Mutation)); }
        Ok(marker)
    }

    /// Retain the original context across the entire request.
    fn following_in<T>(&self, org: &str, risk: RequestRisk,
        operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>) -> Result<T, CloudWorkspaceClientError> {
        self.phase2_member_in(PHASE2_FOLLOW_REASSIGN, "workspace_following_unavailable", org, risk, operation)
    }

    /// A phase 2 call in an Organization the person belongs to, fenced like following.
    fn phase2_member_in<T>(&self, feature: &str, unavailable: &'static str, org: &str, risk: RequestRisk,
        operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>) -> Result<T, CloudWorkspaceClientError> {
        self.phase2_gate(feature, Some(org), None, unavailable)?;
        if !valid_following_path_id(org) { return Err(inbox_invalid()); }
        let original = self.account.context().ok_or_else(|| CloudWorkspaceClientError::local("account_signed_out", false))?;
        let context = self.account.inbox_member_context(org).map_err(|code| CloudWorkspaceClientError::local(code, false))?;
        if !self.account.is_current(&original) || original.generation != context.generation
            || original.access_token != context.access_token {
            return Err(context_changed_error(risk));
        }
        self.phase2_gate(feature, Some(org), Some(&context), unavailable)?;
        let result = operation(&self.client, &context);
        // Generation fences A-B-A; active org, profile, session and membership are
        // checked again even for errors. There is no successful cached fallback.
        let current = self.account.context();
        if !self.account.is_current(&original)
            || !self.account.inbox_member_is_current(&context, org)
            || !current.is_some_and(|now| now.access_token == original.access_token) {
            return Err(context_changed_error(risk));
        }
        result
    }

    pub fn workspace_follow(&self, org: &str, workspace: &str, following: bool, body: Value) -> Result<WorkspaceFollowingResponse, CloudWorkspaceClientError> {
        if !body.as_object().is_some_and(|object| object.is_empty()) || !valid_following_path_id(workspace) { return Err(inbox_invalid()); }
        self.following_in(org, RequestRisk::Mutation, |client, context| {
            let body: Value = client.request_as(if following { "PUT" } else { "DELETE" }, context,
                &["cloud-workspaces", workspace, "follow"], None, Some(json!({})), None, RequestRisk::Mutation)?;
            if !body.is_object() { return Err(post_send_error(RequestRisk::Mutation)); }
            let value: WorkspaceFollowingResponse = serde_json::from_value(body).map_err(|_| post_send_error(RequestRisk::Mutation))?;
            if value.workspace_id != workspace || value.following != following { return Err(post_send_error(RequestRisk::Mutation)); }
            Ok(value)
        })
    }

    pub fn workspace_reassign(&self, org: &str, workspace: &str, body: Value) -> Result<WorkspaceReassignResponse, CloudWorkspaceClientError> {
        let input = reassign_input(body)?;
        if !valid_following_path_id(workspace) { return Err(inbox_invalid()); }
        self.following_in(org, RequestRisk::Mutation, |client, context| {
            let body: Value = client.request_as("POST", context, &["cloud-workspaces", workspace, "reassign"],
                None, Some(json!(input)), None, RequestRisk::Mutation)?;
            if !body.is_object() { return Err(post_send_error(RequestRisk::Mutation)); }
            let value: WorkspaceReassignResponse = serde_json::from_value(body).map_err(|_| post_send_error(RequestRisk::Mutation))?;
            if value.workspace_id != workspace || value.owner_id != input.target_user_id || value.previous_owner_id != input.expected_owner_id {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            // Both booleans are accepted. No retry, owner cache, UUID lifecycle or
            // tab/session/credential migration is implied by this receipt.
            Ok(value)
        })
    }

    /// PRO-141: ids only. The message text stays in the end-to-end encrypted transcript.
    pub fn workspace_mentions(&self, org: &str, workspace: &str, body: Value) -> Result<WorkspaceMentionsResponse, CloudWorkspaceClientError> {
        let input = mentions_input(body)?;
        if !valid_following_path_id(workspace) { return Err(inbox_invalid()); }
        self.phase2_member_in(PHASE2_MENTIONS, "workspace_mentions_unavailable", org, RequestRisk::Mutation, |client, context| {
            let body: Value = client.request_as("POST", context, &["cloud-workspaces", workspace, "mentions"],
                None, Some(json!(input)), None, RequestRisk::Mutation)?;
            if !body.is_object() { return Err(post_send_error(RequestRisk::Mutation)); }
            let value: WorkspaceMentionsResponse = serde_json::from_value(body).map_err(|_| post_send_error(RequestRisk::Mutation))?;
            let asked = |id: &String| input.user_ids.contains(id) && id != &context.user_id;
            if value.workspace_id != workspace || !value.mentioned.iter().all(asked) || !value.no_access.iter().all(asked)
                || (input.check || !value.no_access.is_empty()) && !value.mentioned.is_empty() {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            Ok(value)
        })
    }

    pub fn nudge_preference(&self, org: &str) -> Result<NudgePreference, CloudWorkspaceClientError> {
        self.phase2_member_in(PHASE2_NUDGES, "nudges_unavailable", org, RequestRisk::Read, |client, context| {
            client.request(context, &["nudges", "preference"], None, None, None, RequestRisk::Read)
        })
    }

    /// The organization's current announcement for this build (PRO-241). The version is the app's own, never the
    /// page's. A link that is not https is dropped: the card opens it in the browser.
    pub fn current_announcement(&self, org: &str) -> Result<CurrentAnnouncement, CloudWorkspaceClientError> {
        self.phase2_member_in(PHASE2_ANNOUNCEMENTS, "announcements_unavailable", org, RequestRisk::Read, |client, context| {
            let mut value: CurrentAnnouncement = client.request(context, &["announcements", "current"],
                Some(("appVersion", env!("CARGO_PKG_VERSION"))), None, None, RequestRisk::Read)?;
            if let Some(announcement) = value.announcement.as_mut() {
                if announcement.link.as_deref().is_some_and(|link| !link.starts_with("https://")) { announcement.link = None; }
            }
            Ok(value)
        })
    }

    pub fn set_nudge_preference(&self, org: &str, enabled: bool) -> Result<NudgePreference, CloudWorkspaceClientError> {
        self.phase2_member_in(PHASE2_NUDGES, "nudges_unavailable", org, RequestRisk::Mutation, |client, context| {
            let saved: NudgePreference = client.request_as("PUT", context, &["nudges", "preference"],
                None, Some(json!({ "enabled": enabled })), None, RequestRisk::Mutation)?;
            if saved.enabled != enabled { return Err(post_send_error(RequestRisk::Mutation)); }
            Ok(saved)
        })
    }

    pub fn send_nudge(&self, org: &str, mut input: WorkspaceNudgeInput) -> Result<NudgeReceipt, CloudWorkspaceClientError> {
        if ![&input.target_user_id, &input.workspace_id, &input.session_id].into_iter().all(|id| valid_following_path_id(id))
            || input.text.chars().any(char::is_control) {
            return Err(inbox_invalid());
        }
        let text = input.text.trim();
        if !(1..=240).contains(&text.chars().count()) { return Err(inbox_invalid()); }
        input.text = text.to_owned();
        self.phase2_member_in(PHASE2_NUDGES, "nudges_unavailable", org, RequestRisk::Mutation, |client, context| {
            client.request(context, &["nudges"], None, Some(json!(input)), None, RequestRisk::Mutation)
        })
    }

    /// Both presence routes require readiness in the target organization.
    fn presence_in<T>(&self, org: &str, risk: RequestRisk,
        operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>) -> Result<T, CloudWorkspaceClientError> {
        self.phase2_gate(PHASE2_PRESENCE, Some(org), None, "presence_unavailable")?;
        if !valid_presence_id(org) { return Err(inbox_invalid()); }
        let original = self.account.context().ok_or_else(|| CloudWorkspaceClientError::local("account_signed_out", false))?;
        let context = self.account.inbox_member_context(org).map_err(|code| CloudWorkspaceClientError::local(code, false))?;
        if !self.account.is_current(&original) || original.generation != context.generation
            || original.access_token != context.access_token {
            return Err(context_changed_error(risk));
        }
        self.phase2_gate(PHASE2_PRESENCE, Some(org), Some(&context), "presence_unavailable")?;
        let result = operation(&self.client, &context);
        // Generation fences A-B-A; active org, profile, session and membership are
        // checked again even for errors. There is no successful cached fallback.
        let current = self.account.context();
        if !self.account.is_current(&original)
            || !self.account.inbox_member_is_current(&context, org)
            || !current.is_some_and(|now| now.access_token == original.access_token) {
            return Err(context_changed_error(risk));
        }
        result
    }

    pub fn presence_put(&self, org: &str, body: Value) -> Result<PresencePutResponse, CloudWorkspaceClientError> {
        if !body.is_object() { return Err(inbox_invalid()); }
        let input: PresencePutInput = serde_json::from_value(body).map_err(|_| inbox_invalid())?;
        if !valid_presence_device(&input.device_id) || !(1..=9_007_199_254_740_991).contains(&input.sequence)
            || input.workspace_id.as_deref().is_some_and(|id| !valid_presence_id(id)) { return Err(inbox_invalid()); }
        self.presence_in(org, RequestRisk::Mutation, |client, context| {
            let body: Value = client.request_as("PUT", context, &["presence"], None, Some(json!(input)), None, RequestRisk::Mutation)?;
            if !body.is_object() { return Err(post_send_error(RequestRisk::Mutation)); }
            let value: PresencePutResponse = serde_json::from_value(body).map_err(|_| post_send_error(RequestRisk::Mutation))?;
            if value.ttl_seconds != 45 { return Err(post_send_error(RequestRisk::Mutation)); }
            Ok(value)
        })
    }

    pub fn presence_read(&self, org: &str, body: Value) -> Result<PresenceReadResponse, CloudWorkspaceClientError> {
        if !body.is_object() { return Err(inbox_invalid()); }
        let input: PresenceReadInput = serde_json::from_value(body).map_err(|_| inbox_invalid())?;
        let mut requested = std::collections::HashSet::new();
        if input.workspace_ids.len() > 100 || !input.workspace_ids.iter().all(|id| valid_presence_id(id) && requested.insert(id.as_str())) { return Err(inbox_invalid()); }
        self.presence_in(org, RequestRisk::Read, |client, context| {
            let body: Value = client.request_as("POST", context, &["presence", "read"], None, Some(json!(input)), None, RequestRisk::Read)?;
            // Serde's struct visitor also accepts positional arrays. Require JSON
            // objects at every DTO boundary before decoding their exact fields.
            let people_are_objects = |value: &Value| value.as_array().is_some_and(|people| people.iter().all(Value::is_object));
            if !body.is_object() || !people_are_objects(&body["activeMembers"])
                || !body["workspaces"].as_array().is_some_and(|workspaces| workspaces.iter().all(|workspace| {
                    workspace.is_object() && workspace["owner"].is_object() && people_are_objects(&workspace["activeMembers"])
                })) { return Err(invalid_response()); }
            let value: PresenceReadResponse = serde_json::from_value(body).map_err(|_| invalid_response())?;
            let mut seen = std::collections::HashSet::new();
            if value.ttl_seconds != 45 || !valid_presence_people(&value.active_members)
                || !value.workspaces.iter().all(|workspace| {
                    requested.contains(workspace.workspace_id.as_str()) && seen.insert(workspace.workspace_id.as_str())
                        && valid_presence_id(&workspace.owner.user_id) && valid_presence_people(&workspace.active_members)
                        && workspace.active_members.iter().all(|person| value.active_members.iter().any(|aggregate| aggregate.user_id == person.user_id))
                }) { return Err(invalid_response()); }
            // Authorized omissions are intentional. The org aggregate also includes
            // visible workspaces outside this batch; never restrict it to the batch.
            Ok(value)
        })
    }

    pub fn phase2_contracts_available(&self) -> bool {
        self.phase2_ready(PHASE2_EVENTS, None, None)
    }

    fn phase2_ready(&self, feature: &str, org: Option<&str>, context: Option<&AccountContext>) -> bool {
        #[cfg(test)]
        if self.force_phase2_for_test { return true; }
        self.account.phase2_ready(feature, org, context)
    }

    fn phase2_target(&self, org: Option<&str>) -> String {
        match org {
            Some(org) => org.to_owned(),
            None => self.account.current_scope().map(|scope| scope.active_org_id).unwrap_or_default(),
        }
    }

    fn phase2_gate(&self, feature: &str, org: Option<&str>, context: Option<&AccountContext>, code: &str) -> Result<(), CloudWorkspaceClientError> {
        if self.phase2_ready(feature, org, context) { Ok(()) } else {
            Err(CloudWorkspaceClientError::local(code, true))
        }
    }

    fn schedule_readiness(&self, org: Option<&str>, context: Option<&AccountContext>, mode: Option<&str>, github: bool, webhook: bool) -> Result<(), CloudWorkspaceClientError> {
        if webhook {
            self.phase2_gate(PHASE2_WEBHOOK_TRIGGER, org, context, "cloud_workspace_runtime_not_ready")?;
        }
        if (mode == Some("fresh") && !self.phase2_ready(PHASE2_FRESH_WORKSPACE, org, context))
            || (github && !self.phase2_ready(PHASE2_GITHUB_TRIGGER, org, context)) {
            return Err(CloudWorkspaceClientError::local("cloud_schedule_runtime_unsupported", false));
        }
        Ok(())
    }

    /// PRO-212 integrated routes authorize by target membership, independent of CS-18.
    pub fn restart(&self, org: Option<&str>, workspace_id: &str) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        let target = self.phase2_target(org);
        self.phase2_gate(PHASE2_RESTART_DETAILS, Some(&target), None, "cloud_workspace_runtime_not_ready")?;
        self.member_phase2_workspace(org, workspace_id, RequestRisk::Mutation, |client, context| {
            self.phase2_gate(PHASE2_RESTART_DETAILS, Some(&context.organization_id), Some(context), "cloud_workspace_runtime_not_ready")?;
            let snapshot = client.request(context, &["cloud-workspaces", workspace_id, "restart"], None, Some(json!({})), None, RequestRisk::Mutation)?;
            ensure_snapshot(snapshot, &context.organization_id, Some(workspace_id), RequestRisk::Mutation)
        })
    }

    /// PRO-596: any member reads their organization's billing once it opted in.
    pub fn organization_billing(&self, org: &str) -> Result<OrganizationBilling, CloudWorkspaceClientError> {
        let risk = RequestRisk::Read;
        let unavailable = "organization_billing_unavailable";
        if !valid_resource_id(org) { return Err(inbox_invalid()); }
        self.phase2_gate(PHASE2_DESKTOP_BILLING, Some(org), None, unavailable)?;
        let context = self.account.inbox_member_context(org)
            .map_err(|code| CloudWorkspaceClientError::local(code, false))?;
        self.phase2_gate(PHASE2_DESKTOP_BILLING, Some(org), Some(&context), unavailable)?;
        let result = self.client.request(&context, &["billing"], None, None, None, risk);
        if !self.account.inbox_member_is_current(&context, org) { return Err(context_changed_error(risk)); }
        self.phase2_gate(PHASE2_DESKTOP_BILLING, Some(org), Some(&context), unavailable)?;
        let billing: OrganizationBilling = result?;
        if !billing.valid() { return Err(invalid_response()); }
        Ok(billing)
    }

    /// PRO-596: a fresh Polar customer portal for the payer; the server refuses anyone else.
    pub fn organization_billing_portal(&self, org: &str, view: BillingView) -> Result<String, CloudWorkspaceClientError> {
        let risk = RequestRisk::Read;
        let unavailable = "organization_billing_unavailable";
        if !valid_resource_id(org) { return Err(inbox_invalid()); }
        self.phase2_gate(PHASE2_DESKTOP_BILLING, Some(org), None, unavailable)?;
        let context = self.account.inbox_member_context(org)
            .map_err(|code| CloudWorkspaceClientError::local(code, false))?;
        self.phase2_gate(PHASE2_DESKTOP_BILLING, Some(org), Some(&context), unavailable)?;
        let view = match view { BillingView::Personal => "personal", BillingView::Organization => "teams" };
        let result = self.client.request_as("POST", &context, &["billing", view, "portal"], None, Some(json!({})), None, risk);
        if !self.account.inbox_member_is_current(&context, org) { return Err(context_changed_error(risk)); }
        let portal: BillingPortal = result?;
        polar_portal_url(&portal.url).ok_or_else(invalid_response)
    }

    pub fn precreate_usage(&self, org: &str) -> Result<CloudPrecreateUsage, CloudWorkspaceClientError> {
        let risk = RequestRisk::Read;
        let unavailable = "cloud_workspace_usage_unavailable";
        if !valid_resource_id(org) { return Err(inbox_invalid()); }
        self.phase2_gate(PHASE2_PRECREATE_USAGE, Some(org), None, unavailable)?;
        let context = self.account.inbox_member_context(org)
            .map_err(|code| CloudWorkspaceClientError::local(code, false))?;
        self.phase2_gate(PHASE2_PRECREATE_USAGE, Some(org), Some(&context), unavailable)?;
        let result = self.client.request(&context, &["cloud-workspaces", "precreate-usage"], None, None, None, risk);
        if !self.account.inbox_member_is_current(&context, org) { return Err(context_changed_error(risk)); }
        self.phase2_gate(PHASE2_PRECREATE_USAGE, Some(org), Some(&context), unavailable)?;
        let usage: CloudPrecreateUsage = result?;
        if !usage.quota.running.is_some_and(|running| usage.caller_owned_running <= running.used) {
            return Err(invalid_response());
        }
        Ok(usage)
    }

    pub fn details(&self, org: Option<&str>, workspace_id: &str) -> Result<CloudWorkspaceDetailsResponse, CloudWorkspaceClientError> {
        let target = self.phase2_target(org);
        self.phase2_gate(PHASE2_RESTART_DETAILS, Some(&target), None, "cloud_workspace_runtime_not_ready")?;
        self.member_phase2_workspace(org, workspace_id, RequestRisk::Read, |client, context| {
            self.phase2_gate(PHASE2_RESTART_DETAILS, Some(&context.organization_id), Some(context), "cloud_workspace_runtime_not_ready")?;
            let value: CloudWorkspaceDetailsResponse = client.request(context, &["cloud-workspaces", workspace_id, "details"], None, None, None, RequestRisk::Read)?;
            if value.workspace.id != workspace_id || value.workspace.org_id != context.organization_id
                || value.details.workspace_id != workspace_id || value.details.organization_id != context.organization_id
                || value.details.provider != value.workspace.provider.as_str() {
                return Err(post_send_error(RequestRisk::Read));
            }
            Ok(value)
        })
    }

    pub fn start_progress(&self, org: &str, workspace: &str, operation: &str) -> Result<CloudStartProgress, CloudWorkspaceClientError> {
        let risk = RequestRisk::Read;
        let unavailable = "cloud_workspace_start_progress_unavailable";
        let feature = "cloud.workspaces.start-progress.v1";
        if !valid_resource_id(operation) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.phase2_gate(feature, Some(org), None, unavailable)?;
        self.member_phase2_workspace(Some(org), workspace, risk, |client, context| {
            self.phase2_gate(feature, Some(org), Some(context), unavailable)?;
            let reply: CloudStartProgress = client.request(context, &["cloud-workspaces", workspace, "start-progress", operation], None, None, None, risk)?;
            self.phase2_gate(feature, Some(org), Some(context), unavailable)?;
            if reply.organization_id != org || reply.workspace_id != workspace || reply.operation.id != operation {
                return Err(post_send_error(risk));
            }
            Ok(reply)
        })
    }

    fn member_phase2_workspace<T>(&self, org: Option<&str>, workspace: &str, risk: RequestRisk,
        operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>) -> Result<T, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace) { return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false)); }
        let target = match org { Some(org) => org.to_owned(), None => self.context()?.organization_id };
        if !valid_resource_id(&target) { return Err(inbox_invalid()); }
        let context = self.account.inbox_member_context(&target)
            .map_err(|code| CloudWorkspaceClientError::local(code, false))?;
        let result = operation(&self.client, &context);
        if !self.account.inbox_member_is_current(&context, &target) { return Err(context_changed_error(risk)); }
        result
    }

    pub fn providers(&self) -> Result<CloudProviderSummaryResponse, CloudWorkspaceClientError> {
        self.run(RequestRisk::Read, |client, context| {
            client.request(
                context,
                &["cloud-providers"],
                None,
                None,
                None,
                RequestRisk::Read,
            )
        })
    }

    pub fn provider(
        &self,
        provider: CloudWorkspaceProviderId,
    ) -> Result<CloudProviderConnectionResponse, CloudWorkspaceClientError> {
        self.run(RequestRisk::Read, |client, context| {
            let result = client.request(
                context,
                &["cloud-providers", provider.as_str()],
                None,
                None,
                None,
                RequestRisk::Read,
            )?;
            ensure_connection(result, &provider)
        })
    }

    pub(crate) fn authorize_connect(
        &self,
        provider: CloudWorkspaceProviderId,
    ) -> Result<ProviderConnectAuthorization, CloudWorkspaceClientError> {
        let context = self.context()?;
        let connection = self.client.request::<CloudProviderConnectionResponse>(
            &context,
            &["cloud-providers", provider.as_str()],
            None,
            None,
            None,
            RequestRisk::Read,
        )?;
        let connection = ensure_connection(connection, &provider)?;
        if !self.account.is_current(&context) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        if !connection.can_manage {
            return Err(CloudWorkspaceClientError::local("organization_admin_required", false));
        }
        Ok(ProviderConnectAuthorization { context, provider })
    }

    /// The provider as the organization's provider list describes it: its
    /// name as Settings shows it and the credential its connect dialog asks
    /// for (PRO-415). `None` when the list cannot be read or does not name it.
    pub(crate) fn provider_summary(&self, authorization: &ProviderConnectAuthorization) -> Option<CloudProviderSummary> {
        let list = self
            .client
            .request::<CloudProviderSummaryResponse>(&authorization.context, &["cloud-providers"], None, None, None, RequestRisk::Read)
            .ok()?;
        list.providers.into_iter().find(|summary| summary.id == authorization.provider)
    }

    /// `provider_summary` for a provider an organization connects. A
    /// platform provider (PRO-452) is refused here, before any dialog: it
    /// has no key to ask for, and the server answers its connect route the
    /// same way.
    pub(crate) fn connectable_provider_summary(&self, authorization: &ProviderConnectAuthorization) -> Result<Option<CloudProviderSummary>, CloudWorkspaceClientError> {
        let summary = self.provider_summary(authorization);
        if summary.as_ref().is_some_and(CloudProviderSummary::platform_credential) {
            return Err(CloudWorkspaceClientError::local("cloud_provider_disabled", false));
        }
        Ok(summary)
    }

    pub(crate) fn connect_authorized(
        &self,
        authorization: ProviderConnectAuthorization,
        input: CloudProviderConnectInput,
        mut credential: zeroize::Zeroizing<String>,
    ) -> Result<CloudProviderConnectionResponse, CloudWorkspaceClientError> {
        if credential.trim().is_empty() || credential.len() > 64 * 1024 {
            return Err(CloudWorkspaceClientError::local(
                "cloud_workspace_request_invalid",
                false,
            ));
        }
        validate_disclosure(&input)?;
        if input.context_revision != AccountManager::context_revision(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        if !self.account.is_current(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let result = self.client.request(
            &authorization.context,
            &["cloud-providers", authorization.provider.as_str(), "connect"],
            None,
            Some(json!({ "credential": &*credential, "disclosure": input.disclosure })),
            None,
            RequestRisk::Mutation,
        )?;
        credential.clear();
        if !self.account.is_current(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        ensure_connection(result, &authorization.provider)
    }

    pub fn disconnect_provider(
        &self,
        provider: CloudWorkspaceProviderId,
        context_revision: String,
        disposition: DisconnectDisposition,
    ) -> Result<CloudProviderConnectionResponse, CloudWorkspaceClientError> {
        let authorization = self.authorize_connect(provider.clone())?;
        if context_revision != AccountManager::context_revision(&authorization.context)
            || !self.account.is_current(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let result = self.client.request(
            &authorization.context,
            &["cloud-providers", provider.as_str(), "disconnect"],
            None, Some(json!({ "disposition": disposition })), None, RequestRisk::Mutation,
        )?;
        if !self.account.is_current(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        ensure_connection(result, &provider)
    }

    /// The organization's cloud teardown, if one was ever asked for (§10.7).
    /// `None` when there is none; the server decides who may read it.
    pub fn teardown_status(&self, org: Option<&str>) -> Result<Option<CloudTeardown>, CloudWorkspaceClientError> {
        self.run_in(org, RequestRisk::Read, |client, context| {
            let result: Result<CloudTeardown, _> = client.request(context, &["cloud-teardown"], None, None, None, RequestRisk::Read);
            match result {
                Ok(teardown) => ensure_teardown(teardown, &context.organization_id, RequestRisk::Read).map(Some),
                Err(error) if error.status == Some(404) && error.code == "cloud_teardown_not_found" => Ok(None),
                Err(error) => Err(error),
            }
        })
    }

    /// What a teardown would take: how many workspaces the organization
    /// has, private ones the caller cannot list included. Counts only. It is
    /// read for the organization the confirmation names, which must be the
    /// active one, so the number shown is about what would be torn down.
    pub fn teardown_preview(&self, organization_id: &str) -> Result<CloudTeardownPreview, CloudWorkspaceClientError> {
        let context = self.context()?;
        if context.organization_id != organization_id {
            return Err(context_changed_error(RequestRisk::Read));
        }
        let preview: CloudTeardownPreview = self.client.request(&context, &["cloud-teardown", "preview"], None, None, None, RequestRisk::Read)?;
        if !self.account.is_current(&context) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        if preview.organization_id != organization_id {
            return Err(post_send_error(RequestRisk::Read));
        }
        Ok(preview)
    }

    /// Shut the organization's cloud down: archive every workspace with one
    /// shared deadline, or delete them now. It cannot be undone, and an
    /// archive may only be escalated to a destroy. The page asks for it only
    /// after an explicit confirmation.
    ///
    /// The confirmation was given for one organization, at one account
    /// context. Both are checked before anything is sent: if the active
    /// organization changed since (a switch in another window, before the
    /// page re-rendered), the name typed for one organization must never
    /// tear down another. Nothing is sent then, as `disconnect_provider`
    /// does.
    pub fn request_teardown(
        &self,
        organization_id: &str,
        context_revision: &str,
        disposition: TeardownDisposition,
        confirmed: &ConfirmedTeardown,
    ) -> Result<CloudTeardown, CloudWorkspaceClientError> {
        let context = self.context()?;
        if context.organization_id != organization_id
            || context_revision != AccountManager::context_revision(&context)
            || !self.account.is_current(&context)
        {
            return Err(context_changed_error(RequestRisk::Read));
        }
        if !valid_preview_token(&confirmed.preview_token) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        // What was shown must still be what would be taken: read it again
        // now, and send nothing if it changed. The server checks the same
        // against the count and token sent with the request.
        let current = self.teardown_preview(organization_id)?;
        if current.workspaces != confirmed.expected_workspaces || current.token != confirmed.preview_token {
            return Err(CloudWorkspaceClientError::local("cloud_teardown_preview_changed", false));
        }
        let body = json!({ "disposition": disposition, "expectedWorkspaces": confirmed.expected_workspaces, "previewToken": confirmed.preview_token });
        let result = self.client.request(&context, &["cloud-teardown"], None, Some(body), None, RequestRisk::Mutation)?;
        if !self.account.is_current(&context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        ensure_teardown(result, organization_id, RequestRisk::Mutation)
    }

    /// Whether new machines may be created on a provider (PRO-79). An owner's
    /// or admin's switch, as in the console: the saved key, its resources and
    /// every running workspace are untouched either way.
    pub fn set_provider_creation_enabled(
        &self,
        provider: CloudWorkspaceProviderId,
        context_revision: String,
        enabled: bool,
    ) -> Result<CloudProviderSummary, CloudWorkspaceClientError> {
        let authorization = self.authorize_connect(provider.clone())?;
        if context_revision != AccountManager::context_revision(&authorization.context)
            || !self.account.is_current(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let result: CloudProviderSummary = self.client.request(
            &authorization.context,
            &["cloud-providers", provider.as_str(), "settings"],
            None,
            // The settings contract of today: version 1 carries no provider configuration.
            Some(json!({ "enabledForCreate": enabled, "configurationVersion": 1, "configuration": {} })),
            None,
            RequestRisk::Mutation,
        )?;
        if !self.account.is_current(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        if result.id != provider {
            return Err(invalid_response());
        }
        Ok(result)
    }

    /// Check the saved key against the provider again, without entering it
    /// (PRO-79). The key never leaves the server; the answer is the same
    /// safe connection metadata a read gives.
    pub fn revalidate_provider(
        &self,
        provider: CloudWorkspaceProviderId,
        context_revision: String,
    ) -> Result<CloudProviderConnectionResponse, CloudWorkspaceClientError> {
        let authorization = self.authorize_connect(provider.clone())?;
        if context_revision != AccountManager::context_revision(&authorization.context)
            || !self.account.is_current(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let result = self.client.request(
            &authorization.context,
            &["cloud-providers", provider.as_str(), "revalidate"],
            None, Some(json!({})), None, RequestRisk::Mutation,
        )?;
        if !self.account.is_current(&authorization.context) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        ensure_connection(result, &provider)
    }

    /// An organization's agent logins for cloud workspaces (PRO-79): which
    /// agents are connected and how, never the login itself. `organization`
    /// is any one the person belongs to (PRO-107), the active one when none.
    /// The service answers owners and admins only; anyone else gets
    /// `organization_admin_required`.
    pub fn agent_logins(&self, organization: Option<&str>) -> Result<AgentLoginList, CloudWorkspaceClientError> {
        self.run_in(organization, RequestRisk::Read, Self::read_agent_logins)
    }

    pub fn agent_login_affected_workspaces(
        &self,
        provider: AgentLoginProvider,
        context_revision: &str,
        organization: Option<&str>,
    ) -> Result<AgentLoginAffectedWorkspaces, CloudWorkspaceClientError> {
        let risk = RequestRisk::Read;
        let unavailable = "cloud_agent_login_affected_workspaces_unavailable";
        let (context, access) = self.agent_login_context(organization, context_revision, risk)?;
        let org = Some(context.organization_id.as_str());
        self.phase2_gate(PHASE2_AFFECTED_WORKSPACES, org, Some(&context), unavailable)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(risk));
        }
        let result: Result<AgentLoginAffectedWorkspaces, _> = self.client.request_as(
            "GET",
            &context,
            &["cloud-workspace-credentials", provider.as_str(), "affected-workspaces"],
            None,
            None,
            None,
            risk,
        );
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(risk));
        }
        self.phase2_gate(PHASE2_AFFECTED_WORKSPACES, org, Some(&context), unavailable)?;
        let preview = result?;
        if preview.count != preview.workspaces.len() || preview.count > 100
            || preview.workspaces.iter().any(|workspace| !valid_resource_id(&workspace.id))
        {
            return Err(post_send_error(risk));
        }
        Ok(preview)
    }

    /// The context a change to agent logins is made in: `organization` (the
    /// active one when none), for the account and default organization the
    /// page knew when the person chose it (`context_revision`, the page's
    /// own). Naming the organization is what lets the page change one that is
    /// not the active one; switching the default organization in between
    /// still refuses, as it did before.
    fn agent_login_context(&self, organization: Option<&str>, context_revision: &str, risk: RequestRisk) -> Result<(AccountContext, OrgAccess), CloudWorkspaceClientError> {
        let active = self.context()?;
        if context_revision != AccountManager::context_revision(&active) {
            return Err(context_changed_error(risk));
        }
        let (context, access) = self.context_in(organization)?;
        // The same account and generation the revision was checked against: never a newer sign-in's.
        if context.generation != active.generation || context.user_id != active.user_id || context.profile_id != active.profile_id {
            return Err(context_changed_error(risk));
        }
        Ok((context, access))
    }

    fn read_agent_logins(client: &Client, context: &AccountContext) -> Result<AgentLoginList, CloudWorkspaceClientError> {
        let mut list: AgentLoginList = client.request(context, &["cloud-workspace-credentials"], None, None, None, RequestRisk::Read)?;
        // The same list holds the organization's GitHub token, which has its own section.
        list.credentials.retain(|login| AgentLoginProvider::parse(&login.provider).is_some());
        Ok(list)
    }

    /// Before a login is collected or read from this computer: the person
    /// consented to both things the service will ask about, the request is
    /// for the organization they were looking at (named in the consent, or
    /// the active one) in the account they were looking at, and the service
    /// accepts them as an owner or admin there (the list is refused to anyone
    /// else). Nothing is prompted for, read or sent before this passes.
    ///
    /// The service holds one login per organization and agent, so storing one
    /// replaces whatever is there. When a login is stored for `provider`,
    /// the person must have chosen to replace it (`replace_existing`); what
    /// would be replaced is returned so the native dialog can name it.
    pub(crate) fn authorize_agent_login(&self, provider: AgentLoginProvider, consent: &AgentLoginConsent) -> Result<AgentLoginAuthorization, CloudWorkspaceClientError> {
        if !consent.organization_sharing || !consent.machine_installation {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        let (context, access) = self.agent_login_context(consent.organization_id.as_deref(), &consent.context_revision, RequestRisk::Read)?;
        let stored = Self::read_agent_logins(&self.client, &context)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        let stored = stored
            .credentials
            .into_iter()
            .find(|login| login.provider == provider.as_str() && login.state.as_deref() != Some("disconnected"))
            .map(|login| (login.auth_kind, login.shared_use));
        let replaces = stored.as_ref().map(|(kind, _)| if kind == "api-key" { AgentLoginKind::ApiKey } else { AgentLoginKind::LoginDocument });
        if replaces.is_some() && !consent.replace_existing {
            return Err(CloudWorkspaceClientError::local("cloud_agent_login_replace_unconfirmed", false));
        }
        Ok(AgentLoginAuthorization { context, access, replaces, stored })
    }

    /// Store a login for an agent. `secret` is sent once, to the service
    /// that validates and encrypts it, and cleared; the answer carries the
    /// login's public fields only. No `sharedUse` is sent: nobody chose one
    /// here, so the service applies its default to a new login and never
    /// widens one it replaces (`AgentLoginAuthorization::reach`).
    pub(crate) fn save_agent_login(
        &self,
        authorization: AgentLoginAuthorization,
        provider: AgentLoginProvider,
        kind: AgentLoginKind,
        secret: zeroize::Zeroizing<String>,
        // Whose login it is, shown to the organization's other admins; never part of the secret.
        display_identity: Option<&str>,
    ) -> Result<AgentLogin, CloudWorkspaceClientError> {
        if secret.trim().is_empty() || secret.len() > 64 * 1024 {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        if !self.account.is_current_in(&authorization.context, authorization.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        // Built as text in zeroized buffers: the secret is JSON-escaped once and placed in the body once.
        let invalid = |_| CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false);
        let escaped = zeroize::Zeroizing::new(serde_json::to_string(secret.as_str()).map_err(invalid)?);
        drop(secret);
        let identity = serde_json::to_string(&display_identity).map_err(invalid)?;
        let body = zeroize::Zeroizing::new(format!(
            r#"{{"authKind":"{}","secret":{},"displayIdentity":{},"confirmOrganizationSharing":true,"confirmMachineInstallation":true}}"#,
            kind.as_str(),
            escaped.as_str(),
            identity
        ));
        drop(escaped);
        let login: AgentLogin = self.client.send_secret("PUT", &authorization.context, &["cloud-workspace-credentials", provider.as_str()], body)?;
        if !self.account.is_current_in(&authorization.context, authorization.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        if login.provider != provider.as_str() {
            return Err(invalid_response());
        }
        Ok(login)
    }

    // ---- "Log in with Claude" (PRO-82, the server-side sign-in) ----------
    //
    // The lasting way to connect a Claude subscription: the account service
    // runs the sign-in, keeps the login and renews it. The desktop starts an
    // attempt, opens the provider's page, and hands back the code the page
    // shows. The code is collected in a native dialog and sent once.

    /// Begin a sign-in. The answer's page address is checked here: only an
    /// `https` page of the provider is ever opened.
    pub(crate) fn start_claude_login(&self, authorization: &AgentLoginAuthorization) -> Result<ClaudeLoginStart, CloudWorkspaceClientError> {
        if !self.account.is_current_in(&authorization.context, authorization.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let started: ClaudeLoginStart = self
            .client
            .request(&authorization.context, &["cloud-workspace-credentials", "claude", "login-start"], None, Some(json!({})), None, RequestRisk::Mutation)
            .map_err(flow_unavailable_on_404)?;
        if !valid_resource_id(&started.attempt_id) || !claude_login_page(&started.authorize_url) {
            return Err(invalid_response());
        }
        Ok(started)
    }

    /// Finish a sign-in with the code the provider's page showed. No
    /// `sharedUse` is sent, as nobody chose one here: sending the default
    /// would widen a login an admin had narrowed to `managers` every time
    /// someone logged in again. The service applies its default to a new
    /// login and keeps the scope of a subscription login it replaces.
    pub(crate) fn complete_claude_login(
        &self,
        authorization: AgentLoginAuthorization,
        attempt_id: &str,
        code: zeroize::Zeroizing<String>,
    ) -> Result<ClaudeLoginOutcome, CloudWorkspaceClientError> {
        if !valid_resource_id(attempt_id) || code.trim().is_empty() || code.len() > 8 * 1024 {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        if !self.account.is_current_in(&authorization.context, authorization.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let invalid = |_| CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false);
        let escaped = zeroize::Zeroizing::new(serde_json::to_string(code.trim()).map_err(invalid)?);
        drop(code);
        let body = zeroize::Zeroizing::new(format!(
            r#"{{"attemptId":{},"code":{},"confirmOrganizationSharing":true,"confirmMachineInstallation":true}}"#,
            serde_json::to_string(attempt_id).map_err(invalid)?,
            escaped.as_str()
        ));
        drop(escaped);
        let outcome: ClaudeLoginOutcome = self
            .client
            .send_secret("POST", &authorization.context, &["cloud-workspace-credentials", "claude", "login-complete"], body)
            .map_err(attempt_gone_on_404)?;
        if !self.account.is_current_in(&authorization.context, authorization.access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        if outcome.credential.as_ref().is_some_and(|login| login.provider != AgentLoginProvider::Claude.as_str()) {
            return Err(invalid_response());
        }
        Ok(outcome)
    }

    /// Abandon a sign-in that was started here, for `organization` (the active one when none).
    pub fn cancel_claude_login(&self, attempt_id: &str, context_revision: String, organization: Option<&str>) -> Result<(), CloudWorkspaceClientError> {
        if !valid_resource_id(attempt_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        let (context, access) = self.agent_login_context(organization, &context_revision, RequestRisk::Mutation)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let _: Value = self
            .client
            .request(&context, &["cloud-workspace-credentials", "claude", "login-cancel"], None, Some(json!({ "attemptId": attempt_id })), None, RequestRisk::Mutation)
            .map_err(attempt_gone_on_404)?;
        Ok(())
    }

    /// Disconnect an agent's login in `organization` (the active one when
    /// none). The service refuses while a workspace still uses it, and access
    /// already handed to a machine lasts until its own expiry.
    pub fn remove_agent_login(&self, provider: AgentLoginProvider, context_revision: String, organization: Option<&str>) -> Result<(), CloudWorkspaceClientError> {
        let (context, access) = self.agent_login_context(organization, &context_revision, RequestRisk::Mutation)?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        let _: Value = self.client.request_as(
            "DELETE",
            &context,
            &["cloud-workspace-credentials", provider.as_str()],
            None,
            Some(json!({})),
            None,
            RequestRisk::Mutation,
        )?;
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        Ok(())
    }

    pub fn setup(
        &self,
        org: Option<&str>,
        provider: CloudWorkspaceProviderId,
    ) -> Result<CloudWorkspaceSetup, CloudWorkspaceClientError> {
        self.run_in(org, RequestRisk::Read, |client, context| {
            let result = client.request(
                context,
                &["cloud-workspaces", "setup"],
                Some(("provider", provider.as_str())),
                None,
                None,
                RequestRisk::Read,
            )?;
            ensure_provider(result, &provider, RequestRisk::Read)
        })
    }

    pub fn quote(
        &self,
        org: Option<&str>,
        input: CloudWorkspaceQuoteInput,
    ) -> Result<CloudWorkspaceQuote, CloudWorkspaceClientError> {
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            let provider = input.provider.clone();
            let result = client.request(
                context,
                &["cloud-workspaces", "quote"],
                None,
                Some(serde_json::to_value(input).expect("serialize quote input")),
                None,
                RequestRisk::Mutation,
            )?;
            ensure_provider(result, &provider, RequestRisk::Mutation)
        })
    }

    pub fn create(
        &self,
        org: Option<&str>,
        input: CloudWorkspaceCreateInput,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        if !input.confirm_provider_spend || !valid_idempotency_key(&input.idempotency_key) {
            return Err(CloudWorkspaceClientError::local(
                "cloud_workspace_request_invalid",
                false,
            ));
        }
        validate_create(&input.name, &input.repositories, input.launch.as_ref())?;
        self.run_in(org, RequestRisk::Create, |client, context| {
            let idempotency_key = input.idempotency_key.clone();
            let mut body = json!({
                "name": input.name.trim(),
                "quoteId": input.quote_id,
                "accessMode": input.access_mode,
                "confirmProviderSpend": true
            });
            if !input.repositories.is_empty() {
                body["setup"] = setup_body(&input.repositories);
            }
            // Sent only when asked for: a server from before preparation
            // workspaces refuses the key, and then nothing is created.
            if input.preparation {
                body["preparation"] = json!(true);
            }
            if let Some(launch) = &input.launch {
                body["launch"] = launch_body(launch);
            }
            let send = |body: Value| client.request(context, &["cloud-workspaces"], None, Some(body), Some(&idempotency_key), RequestRisk::Create);
            let result = match send(body.clone()) {
                // A server from before `launch.nativeCodex` (#745) refuses the
                // key before it records anything: the same create again
                // without it, whose first tab is a terminal tab, as before.
                Err(error) if refused_native_codex(&body, &error) => {
                    if let Some(launch) = body["launch"].as_object_mut() {
                        launch.remove("nativeCodex");
                    }
                    send(body)?
                }
                result => result?,
            };
            ensure_snapshot(result, &context.organization_id, None, RequestRisk::Create)
        })
    }

    pub fn workspaces(&self, org: Option<&str>) -> Result<CloudWorkspaceList, CloudWorkspaceClientError> {
        self.run_in(org, RequestRisk::Read, |client, context| {
            let result = client.request(
                context,
                &["cloud-workspaces"],
                None,
                None,
                None,
                RequestRisk::Read,
            )?;
            ensure_list(result, &context.organization_id, RequestRisk::Read)
        })
    }

    /// Every member Organization's list in one request (PRO-74, saas contract
    /// §23), for a server that offers it. The answer is fenced by the account
    /// that asked, and each Organization by membership as of the answer: an
    /// Organization the user is not (or no longer) a member of never reaches
    /// the webview, whatever the server sent. One Organization's invalid list
    /// is reported as that Organization's error and hides no other.
    pub fn catalog_feed(&self, cursor: Option<&str>) -> Result<CloudCatalogFeed, CloudWorkspaceClientError> {
        let risk = RequestRisk::Read;
        let context = self.account.context().ok_or_else(|| CloudWorkspaceClientError::local("account_signed_out", false))?;
        if !self.account.catalog_feed() {
            return Err(CloudWorkspaceClientError::local("cloud_catalog_feed_unavailable", false));
        }
        let cursor = cursor.filter(|cursor| valid_cursor(cursor));
        let presence = self.phase2_ready(PHASE2_PRESENCE, None, Some(&context));
        let answer = self.client.catalog_feed(&context, cursor, presence);
        if presence && !self.account.is_current(&context) { return Err(context_changed_error(risk)); }
        let scope = self.account.scope_if_same_account(&context).filter(|scope| scope.multi_org).ok_or_else(|| context_changed_error(risk))?;
        let Some(body) = answer? else {
            return Ok(CloudCatalogFeed { viewer_user_id: context.user_id.clone(), changed: false, cursor: cursor.map(str::to_string), reset: false, organizations: Vec::new(), deleted_workspace_ids: Vec::new() });
        };
        if !valid_cursor(&body.cursor) {
            return Err(invalid_response());
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut organizations = Vec::new();
        for mut organization in body.organizations {
            if !valid_resource_id(&organization.org_id) || !scope.allows(&organization.org_id) || !seen.insert(organization.org_id.clone()) {
                continue;
            }
            let org_id = organization.org_id;
            if !self.phase2_ready(PHASE2_PRESENCE, Some(&org_id), Some(&context)) {
                organization.presence = None;
                for item in &mut organization.workspaces { item.presence = None; }
            }
            let failed = |code: String| CloudCatalogOrganization { presence: None, org_id: org_id.clone(), workspaces: Vec::new(), tombstones: Vec::new(), quota: None, error: Some(code) };
            organizations.push(match organization.error {
                // Only a code this desktop knows crosses to the webview.
                _ if organization.presence.as_ref().is_some_and(|presence| !valid_presence_people(&presence.active_members)) => failed("cloud_workspace_invalid_response".into()),
                Some(code) => failed(if known_error_code(&code) { code } else { "cloud_workspace_unknown_error".into() }),
                None => match ensure_list(CloudWorkspaceList { workspaces: organization.workspaces, tombstones: organization.tombstones, quota: organization.quota }, &org_id, risk) {
                    Ok(list) => CloudCatalogOrganization { presence: organization.presence, org_id: org_id.clone(), workspaces: list.workspaces, tombstones: list.tombstones, quota: list.quota, error: None },
                    Err(error) => failed(error.code),
                },
            });
        }
        let listed: std::collections::BTreeSet<&str> = organizations.iter().flat_map(|organization| organization.tombstones.iter().map(|tombstone| tombstone.id.as_str())).collect();
        // Only ids this desktop was also shown a tombstone for, or (in a delta) ids that are well formed.
        let deleted_workspace_ids = body.deleted_workspace_ids.into_iter().filter(|id| valid_resource_id(id) && (!body.reset || listed.contains(id.as_str()))).collect();
        Ok(CloudCatalogFeed { viewer_user_id: context.user_id.clone(), changed: true, cursor: Some(body.cursor), reset: body.reset, organizations, deleted_workspace_ids })
    }

    /// Check the repositories and refs before quoting (contract §16), and
    /// with `agent` (the one a first prompt would go to, PRO-78) whether the
    /// organization has a login for it.
    pub fn preflight(&self, org: Option<&str>, repositories: Vec<CreateRepository>, agent: Option<String>) -> Result<CloudWorkspacePreflight, CloudWorkspaceClientError> {
        if repositories.is_empty() && agent.is_none() {
            return Ok(CloudWorkspacePreflight { ready: true, checks: Vec::new() });
        }
        validate_create("preflight", &repositories, None)?;
        if agent.as_deref().is_some_and(|agent| !crate::cloud_agents::launch::valid_agent(agent)) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_launch_invalid", false));
        }
        // A POST, but it changes nothing: a failed call is simply retryable,
        // never an unknown outcome.
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            client.request(
                context,
                &["cloud-workspaces", "preflight"],
                // A query parameter: an older API ignores it, where it would
                // reject an unknown body field.
                agent.as_deref().map(|agent| ("agent", agent)),
                Some(json!({ "setup": setup_body(&repositories) })),
                None,
                RequestRisk::Mutation,
            )
        })
        .map_err(|mut error| {
            if error.code == "cloud_workspace_request_outcome_unknown" {
                return CloudWorkspaceClientError::local("cloud_workspace_unavailable", true);
            }
            if error.status.is_some_and(|status| status == 429 || status >= 500) {
                error.retryable = true;
                error.requires_original_account_context = false;
            }
            error
        })
    }

    /// Cloud diagnostics of `org` (the active Organization when none) for the
    /// last `window_days` (1-30) days (PRO-38). Owners and administrators of
    /// that Organization only: the server checks the role there, and a member
    /// gets `organization_admin_required`. A server without the endpoint
    /// answers 404, reported as `cloud_diagnostics_not_supported`.
    pub fn diagnostics(&self, org: Option<&str>, window_days: u8) -> Result<crate::cloud_diagnostics::CloudDiagnostics, CloudWorkspaceClientError> {
        if !(1..=crate::cloud_diagnostics::MAX_WINDOW_DAYS).contains(&window_days) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        let days = window_days.to_string();
        self.run_in(org, RequestRisk::Read, |client, context| {
            let result: crate::cloud_diagnostics::CloudDiagnostics = client
                .request_limited(
                    context,
                    &["cloud-diagnostics"],
                    Some(("windowDays", &days)),
                    None,
                    None,
                    RequestRisk::Read,
                    DIAGNOSTICS_RESPONSE_LIMIT_BYTES,
                )
                .map_err(|mut error| {
                    if error.status == Some(404) && error.code == "cloud_workspace_unavailable" {
                        error.code = "cloud_diagnostics_not_supported".into();
                        error.retryable = false;
                    }
                    error
                })?;
            if result.organization_id != context.organization_id {
                return Err(invalid_response());
            }
            Ok(result)
        })
    }

    /// The organization's selected GitHub repositories (PRO-14), the ones a
    /// workspace can be created from.
    pub fn selected_repositories(&self, org: Option<&str>) -> Result<SelectedRepositories, CloudWorkspaceClientError> {
        self.run_in(org, RequestRisk::Read, |client, context| {
            client.request(context, &["github-app"], None, None, None, RequestRisk::Read)
        })
    }

    pub fn lifecycle(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        action: OperationAction,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        self.lifecycle_with(org, workspace_id, action, false)
    }

    /// Archive and delete refuse while agent work runs
    /// (`cloud_workspace_active_work`, §10.2) unless `force` is sent, which
    /// the page does only after the person confirmed it.
    pub fn lifecycle_with(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        action: OperationAction,
        force: bool,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local(
                "cloud_workspace_request_invalid",
                false,
            ));
        }
        if matches!(action, OperationAction::Restart) {
            return self.restart(org, workspace_id);
        }
        let action_path = match action {
            OperationAction::Suspend => "suspend",
            OperationAction::Resume => "resume",
            OperationAction::Restart => unreachable!(),
            OperationAction::Archive => "archive",
            OperationAction::Delete => "delete",
        };
        let body = if force && matches!(action, OperationAction::Archive | OperationAction::Delete) {
            json!({ "force": true })
        } else {
            json!({})
        };
        self.lifecycle_request(org, workspace_id, action_path, body)
    }

    /// Archive, keeping the workspace for `retention_days` instead of its
    /// own retention (§10.1). The period is sent only when given: a server
    /// from before the choice refuses a body that carries it, and the page
    /// offers the choice only when the disposition facts list the periods.
    pub fn archive(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        force: bool,
        retention_days: Option<u32>,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        let Some(days) = retention_days else {
            return self.lifecycle_with(org, workspace_id, OperationAction::Archive, force);
        };
        if !valid_resource_id(workspace_id) || days == 0 || days > MAX_ARCHIVE_RETENTION_DAYS {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        let mut body = json!({ "retentionDays": days });
        if force {
            body["force"] = json!(true);
        }
        self.lifecycle_request(org, workspace_id, "archive", body)
    }

    fn lifecycle_request(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        action_path: &str,
        body: Value,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            let result = client.request(
                context,
                &["cloud-workspaces", workspace_id, action_path],
                None,
                Some(body),
                None,
                RequestRisk::Mutation,
            )?;
            ensure_snapshot(
                result,
                &context.organization_id,
                Some(workspace_id),
                RequestRisk::Mutation,
            )
        })
    }

    /// Take a workspace out of the archive (§10.1). It stays suspended: the
    /// first interactive action resumes it.
    pub fn unarchive(&self, org: Option<&str>, workspace_id: &str) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            let result = client.request(
                context,
                &["cloud-workspaces", workspace_id, "unarchive"],
                None,
                Some(json!({})),
                None,
                RequestRisk::Mutation,
            )?;
            ensure_snapshot(result, &context.organization_id, Some(workspace_id), RequestRisk::Mutation)
        })
    }

    /// What the server knows before an archive or delete (§10.2).
    pub fn disposition(&self, org: Option<&str>, workspace_id: &str) -> Result<CloudWorkspaceDisposition, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Read, |client, context| {
            let result: CloudWorkspaceDisposition = client.request(
                context,
                &["cloud-workspaces", workspace_id, "disposition"],
                None,
                None,
                None,
                RequestRisk::Read,
            )?;
            if result.workspace_id != workspace_id {
                return Err(invalid_response());
            }
            Ok(result)
        })
    }

    /// `POST .../cloud-workspaces/:id/open?attachTicket=1`: the attachment
    /// for this installation, with its pairing code and an attach ticket once
    /// the runtime answered it (PRO-13). Returns the organization it was
    /// made for, so the caller can refuse a response from a switched account.
    pub fn open_attachment(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        client_installation_id: &str,
        refresh_pairing: bool,
    ) -> Result<(String, Value), CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            let mut body = json!({ "clientInstallationId": client_installation_id });
            if refresh_pairing {
                body["refreshPairing"] = json!(true);
            }
            let result: Value = client.request(
                context,
                &["cloud-workspaces", workspace_id, "open"],
                Some(("attachTicket", "1")),
                Some(body),
                None,
                RequestRisk::Mutation,
            )?;
            Ok((context.organization_id.clone(), result))
        })
    }

    /// Who may see the workspace (PRO-29): `organization` lets it be shared
    /// (§21.2), `private` hides it from everyone but its creator and revokes
    /// every share in the same transaction. Only an organization owner or
    /// admin may; anyone else gets `organization_admin_required`.
    pub fn set_access(&self, org: Option<&str>, workspace_id: &str, access_mode: WorkspaceAccessMode, context_revision: Option<&str>) -> Result<CloudWorkspace, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        let change = |client: &Client, context: &AccountContext| {
            let result: CloudWorkspace = client.request(
                context,
                &["cloud-workspaces", workspace_id, "access"],
                None,
                Some(json!({ "accessMode": access_mode })),
                None,
                RequestRisk::Mutation,
            )?;
            // An answer about another workspace or organization says nothing
            // about whether this one changed.
            if result.id != workspace_id || result.org_id != context.organization_id {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            Ok(result)
        };
        if let Some(revision) = context_revision {
            self.run_group_sharing(org, revision, RequestRisk::Mutation, |client, context| {
                // The visibility endpoint keeps the legacy organization
                // scope rules, even when invoked from the staged editor.
                if !self.account.current_scope().is_some_and(|scope| scope.allows(&context.organization_id)) {
                    return Err(CloudWorkspaceClientError::local("cloud_organization_unavailable", false));
                }
                change(client, context)
            })
        } else {
            self.run_in(org, RequestRisk::Mutation, change)
        }
    }

    /// Only explicit shares use the accepted target-membership contract here.
    /// Keep the initiating active context as well as target membership: neither
    /// a late success nor an HTTP error may escape into a replacement session.
    fn run_share_in<T>(&self, org: Option<&str>, context_revision: Option<&str>, risk: RequestRisk,
        operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>) -> Result<T, CloudWorkspaceClientError> {
        if org.is_some_and(|org| !valid_resource_id(org)) { return Err(inbox_invalid()); }
        // An explicit member target does not require an active organization.
        let active = self.account.context()
            .ok_or_else(|| CloudWorkspaceClientError::local("account_signed_out", false))?;
        if context_revision.is_some_and(|revision| revision != AccountManager::context_revision(&active)) {
            return Err(context_changed_error(risk));
        }
        if org.is_none() && active.organization_id.is_empty() {
            return Err(CloudWorkspaceClientError::local("account_organization_unavailable", false));
        }
        let target = org.unwrap_or(&active.organization_id);
        if !valid_resource_id(target) { return Err(inbox_invalid()); }
        let context = self.account.inbox_member_context(target)
            .map_err(|code| CloudWorkspaceClientError::local(code, false))?;
        // is_current includes generation/user/profile/active org, but not token
        // rotation. Fence the captured token too, even without a generation bump.
        let scope_is_current = || self.account.is_current(&active) && self.account.inbox_member_is_current(&context, target);
        let token_is_current = || self.account.context().is_some_and(|now| now.access_token == active.access_token);
        if context.generation != active.generation || context.user_id != active.user_id
            || context.profile_id != active.profile_id || context.access_token != active.access_token
            || !token_is_current() || !scope_is_current() {
            return Err(context_changed_error(risk));
        }
        let result = operation(&self.client, &context);
        let same_token = token_is_current();
        if !scope_is_current() {
            return Err(context_changed_error(risk));
        }
        if !same_token {
            // A rotated token fences the reply. Within the same group editor
            // scope, a mutation may already have committed under the old token.
            return Err(if context_revision.is_some() && matches!(risk, RequestRisk::Mutation) {
                post_send_error(risk)
            } else {
                context_changed_error(risk)
            });
        }
        result
    }

    fn run_group_sharing<T>(&self, org: Option<&str>, context_revision: &str, risk: RequestRisk,
        operation: impl FnOnce(&Client, &AccountContext) -> Result<T, CloudWorkspaceClientError>) -> Result<T, CloudWorkspaceClientError> {
        self.run_share_in(org, Some(context_revision), risk, |client, context| {
            let gate = || self.phase2_gate(PHASE2_WORKSPACE_GROUPS, Some(&context.organization_id), Some(context), "cloud_workspace_groups_unavailable");
            gate()?;
            let result = operation(client, context);
            // Reads can be hidden when readiness is withdrawn. A sent
            // mutation must keep its confirmed result or unknown outcome so
            // the caller can resolve it through the same request receipt.
            if matches!(risk, RequestRisk::Read) {
                gate()?;
            }
            result
        })
    }

    /// The workspace's idle window and what it may be changed to (PRO-410),
    /// for whoever may manage it.
    pub fn idle_suspend(&self, org: Option<&str>, workspace_id: &str) -> Result<WorkspaceIdleSuspend, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Read, |client, context| {
            let result: WorkspaceIdleSuspend = client.request(
                context,
                &["cloud-workspaces", workspace_id, "idle-suspend"],
                None,
                None,
                None,
                RequestRisk::Read,
            )?;
            if result.workspace_id != workspace_id {
                return Err(invalid_response());
            }
            Ok(result)
        })
    }

    /// How long the workspace may sit idle before it is stopped, 0 for never
    /// (PRO-410). The server holds it to the provider's windows and the
    /// organization's cap.
    pub fn set_idle_suspend(&self, org: Option<&str>, workspace_id: &str, idle_suspend_minutes: i64) -> Result<CloudWorkspace, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) || idle_suspend_minutes < 0 {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            let result: CloudWorkspace = client.request(
                context,
                &["cloud-workspaces", workspace_id, "idle-suspend"],
                None,
                Some(json!({ "idleSuspendMinutes": idle_suspend_minutes })),
                None,
                RequestRisk::Mutation,
            )?;
            // An answer about another workspace, or one that does not name
            // the window it now has, says nothing about whether this changed.
            if result.id != workspace_id || result.org_id != context.organization_id || result.idle_suspend_minutes != Some(idle_suspend_minutes) {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            Ok(result)
        })
    }

    /// Who the workspace is shared with, and what the caller may do (§21.2).
    pub fn shares(&self, org: Option<&str>, workspace_id: &str, context_revision: Option<&str>) -> Result<CloudWorkspaceShares, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        let read = |client: &Client, context: &AccountContext| {
            let tail = ["cloud-workspaces", workspace_id, "shares"];
            let mut result = if context_revision.is_some() {
                let result: CloudWorkspaceShares = client.request(context, &tail, None, None, None, RequestRisk::Read)?;
                if !result.access_revision.as_deref().is_some_and(valid_share_id)
                    || !result.group_shares.as_deref().is_some_and(valid_group_shares)
                    || result.shares.iter().any(|share| !valid_share_id(&share.user_id)) {
                    return Err(invalid_response());
                }
                result
            } else {
                let LegacyWorkspaceShares { shares, you, access_revision, general_access, capabilities } =
                    client.request(context, &tail, None, None, None, RequestRisk::Read)?;
                if shares.iter().any(|share| !valid_resource_id(&share.user_id)) {
                    return Err(invalid_response());
                }
                CloudWorkspaceShares { shares, you, access_revision, group_shares: None, general_access, capabilities }
            };
            if !self.phase2_ready(PHASE2_GENERAL_ACCESS, Some(&context.organization_id), Some(context))
                || matches!(result.general_access, Some(GeneralAccess::Organisation { role: GeneralAccessRole::Write }))
                || !result.access_revision.as_deref().is_some_and(valid_access_revision) {
                result.general_access = None;
                result.capabilities = None;
                if result.group_shares.is_none() { result.access_revision = None; }
            }
            Ok(result)
        };
        if let Some(revision) = context_revision {
            self.run_group_sharing(org, revision, RequestRisk::Read, read)
        } else {
            self.run_share_in(org, None, RequestRisk::Read, read)
        }
    }

    pub fn general_access_put(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        access_revision: &str,
        general_access: GeneralAccess,
        context_revision: &str,
    ) -> Result<GeneralAccessChange, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) || !valid_access_revision(access_revision) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        if matches!(general_access, GeneralAccess::Organisation { role: GeneralAccessRole::Write }) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_runtime_unsupported", false));
        }
        self.run_share_in(org, Some(context_revision), RequestRisk::Mutation, |client, context| {
            self.phase2_gate(
                PHASE2_GENERAL_ACCESS, Some(&context.organization_id), Some(context),
                "cloud_workspace_general_access_unavailable",
            )?;
            let result: GeneralAccessChange = client.request_as(
                "PUT", context, &["cloud-workspaces", workspace_id, "general-access"], None,
                Some(json!({ "accessRevision": access_revision, "generalAccess": general_access })),
                None, RequestRisk::Mutation,
            )?;
            if result.general_access != general_access || !valid_access_revision(&result.access_revision) {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            Ok(result)
        })
    }

    pub fn workspace_groups(&self, org: &str, query: &str, cursor: Option<&str>, context_revision: &str) -> Result<CloudGroupPage, CloudWorkspaceClientError> {
        if query.trim().encode_utf16().count() > 120 || query.contains('\0') || cursor.is_some_and(|cursor| !valid_share_id(cursor)) {
            return Err(inbox_invalid());
        }
        self.run_group_sharing(Some(org), context_revision, RequestRisk::Read, |client, context| {
            let mut url = client.organization_url(context, &["groups"])?;
            url.query_pairs_mut().append_pair("q", query).extend_pairs(cursor.map(|cursor| ("cursor", cursor)));
            let result: CloudGroupPage = client.send_url("GET", context, url, None, None, RequestRisk::Read, RESPONSE_LIMIT_BYTES)?;
            if result.groups.len() > 50 || result.groups.iter().any(|group| !valid_share_id(&group.id))
                || result.next_cursor.as_deref().is_some_and(|next| !valid_share_id(next) || Some(next) == cursor) {
                return Err(invalid_response());
            }
            Ok(result)
        })
    }

    pub fn apply_shares(&self, org: &str, workspace_id: &str, request: CloudAccessApply, context_revision: &str) -> Result<CloudAccessApplied, CloudWorkspaceClientError> {
        let mut ids = std::collections::HashSet::with_capacity(request.changes.len().min(128));
        if !valid_resource_id(workspace_id) || !valid_share_id(&request.access_revision) || !valid_share_id(&request.request_id)
            || !(1..=128).contains(&request.changes.len())
            || request.changes.iter().any(|change| {
                let (id, subject) = change.identifiers();
                !valid_share_id(id) || !valid_share_id(subject) || !ids.insert(id)
            }) {
            return Err(inbox_invalid());
        }
        let risk = RequestRisk::Mutation;
        self.run_group_sharing(Some(org), context_revision, risk, |client, context| {
            for change in &request.changes {
                if let AccessChange::Put {
                    subject: ShareSubject { kind: ShareSubjectType::User, .. },
                    role: ShareRole::Manager,
                    can_approve,
                    ..
                } = change {
                    self.require_admin_share(context, *can_approve)?;
                }
            }
            let mut result: CloudAccessApplied = client.request(
                context, &["cloud-workspaces", workspace_id, "shares", "apply"], None, Some(json!(request)), None, risk,
            ).map_err(|mut error| {
                if error.code == "cloud_workspace_request_outcome_unknown" || error.status.is_some_and(|status| status == 408 || status == 429 || status >= 500) {
                    error.retry_with_same_idempotency_key = true;
                    error.requires_original_account_context = true;
                }
                error
            })?;
            if !valid_share_id(&result.access_revision) || !valid_group_shares(&result.group_shares)
                || result.shares.iter().any(|share| !valid_share_id(&share.user_id))
                || result.results.len() != request.changes.len()
                || result.results.iter().zip(&request.changes).any(|(result, change)| result.id() != change.identifiers().0) {
                let mut error = post_send_error(risk);
                error.retry_with_same_idempotency_key = true;
                return Err(error);
            }
            // Project only recognized failure codes and use local copy. The
            // server message itself is unnecessary for unrecognized failures.
            for outcome in &mut result.results {
                if let AccessResult::Failed { code, message, .. } = outcome {
                    if !known_error_code(code) {
                        *code = "cloud_workspace_unknown_error".into();
                        *message = "The server refused this change.".into();
                    }
                }
            }
            Ok(result)
        })
    }

    /// Grant or change one member's share. Idempotent: the same body twice
    /// leaves one share.
    #[cfg(test)]
    fn share_put(&self, org: Option<&str>, workspace_id: &str, user_id: &str, role: ShareRole, can_approve: bool) -> Result<CloudWorkspaceShareChange, CloudWorkspaceClientError> {
        self.share_put_in_context(org, workspace_id, user_id, role, can_approve, None)
    }

    fn require_admin_share(&self, context: &AccountContext, can_approve: bool) -> Result<(), CloudWorkspaceClientError> {
        if !can_approve {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_runtime_unsupported", false));
        }
        self.phase2_gate(PHASE2_ADMIN_SHARE, Some(&context.organization_id), Some(context), "cloud_workspace_runtime_not_ready")
    }

    pub fn share_put_in_context(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        user_id: &str,
        role: ShareRole,
        can_approve: bool,
        context_revision: Option<&str>,
    ) -> Result<CloudWorkspaceShareChange, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) || !valid_resource_id(user_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        if role == ShareRole::Manager && !can_approve {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_runtime_unsupported", false));
        }
        self.run_share_in(org, context_revision, RequestRisk::Mutation, |client, context| {
            if role == ShareRole::Manager {
                self.require_admin_share(context, can_approve)?;
            }
            let result: CloudWorkspaceShareChange = client.request_as(
                "PUT",
                context,
                &["cloud-workspaces", workspace_id, "shares", user_id],
                None,
                Some(json!({ "v": 1, "role": role, "canApprove": can_approve })),
                None,
                RequestRisk::Mutation,
            )?;
            if result.share.user_id != user_id {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            Ok(result)
        })
    }

    /// Revoke one member's share; their participate attachments are revoked
    /// with it, so the runtime closes their connections.
    pub fn share_revoke(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        user_id: &str,
    ) -> Result<CloudWorkspaceShareChange, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) || !valid_resource_id(user_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_share_in(org, None, RequestRisk::Mutation, |client, context| {
            let result: CloudWorkspaceShareChange = client.request_as(
                "DELETE",
                context,
                &["cloud-workspaces", workspace_id, "shares", user_id],
                None,
                None,
                None,
                RequestRisk::Mutation,
            )?;
            if result.share.user_id != user_id {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            Ok(result)
        })
    }

    /// Replace or revoke only the authenticated caller's registration.
    #[allow(dead_code)]
    pub(crate) fn workspace_ssh_registration(&self, org: &str, workspace: &str, public_key: Option<&str>) -> Result<(), CloudWorkspaceClientError> {
        use crate::account::PHASE2_WORKSPACE_SSH;

        if !valid_resource_id(workspace) { return Err(inbox_invalid()); }
        let (method, body) = match public_key {
            Some(key) => {
                let key = crate::workspace_ssh::parse_public_key(key).ok_or_else(inbox_invalid)?;
                ("PUT", Some(json!({ "publicKey": key })))
            }
            None => ("DELETE", None),
        };
        self.phase2_member_in(PHASE2_WORKSPACE_SSH, "cloud_workspace_ssh_unavailable", org, RequestRisk::Mutation, |client, context| {
            let _: Value = client.request_as(method, context, &["cloud-workspaces", workspace, "ssh-key"], None, body, None, RequestRisk::Mutation)?;
            Ok(())
        })
    }

    /// The organization's scheduled tasks, or one workspace's (saas contract
    /// §24.2). For owners and admins; a server with the feature off answers
    /// `cloud_workspace_unavailable` with status 404.
    pub fn schedules(&self, org: Option<&str>, workspace_id: Option<&str>) -> Result<CloudSchedules, CloudWorkspaceClientError> {
        if workspace_id.is_some_and(|id| !valid_resource_id(id)) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Read, |client, context| {
            let mut result: CloudSchedules = client.request(context, &["cloud-schedules"], workspace_id.map(|id| ("workspaceId", id)), None, None, RequestRisk::Read)?;
            // An answer about another workspace is not this workspace's list.
            if result.schedules.iter().any(|schedule| !valid_schedule_id(&schedule.id) || workspace_id.is_some_and(|id| schedule.workspace_id != id)) {
                return Err(invalid_response());
            }
            for schedule in &mut result.schedules {
                client.normalize_schedule(schedule, &mut [], RequestRisk::Read)?;
            }
            Ok(result)
        })
    }

    /// One scheduled task and its newest runs.
    pub fn schedule(&self, org: Option<&str>, schedule_id: &str) -> Result<CloudScheduleDetail, CloudWorkspaceClientError> {
        if !valid_schedule_id(schedule_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Read, |client, context| {
            let mut result: CloudScheduleDetail = client.request(context, &["cloud-schedules", schedule_id], None, None, None, RequestRisk::Read)?;
            if result.schedule.id != schedule_id {
                return Err(invalid_response());
            }
            client.normalize_schedule(&mut result.schedule, &mut result.runs, RequestRisk::Read)?;
            Ok(result)
        })
    }

    /// What a schedule would cost and when it would first run. It writes
    /// nothing on the server, so it is asked like a read.
    pub fn schedule_estimate(&self, org: Option<&str>, input: &CloudScheduleEstimateInput) -> Result<CloudScheduleQuote, CloudWorkspaceClientError> {
        let timing = automation_body(input.schedule.as_ref(), input.github_trigger.as_ref(), input.webhook_trigger.is_some(), input.workspace_mode.as_deref(), None, None);
        let (Some(timing), true) = (timing, valid_resource_id(&input.workspace_id) && valid_schedule_policies(None, &input.completion_policy, input.max_run_minutes)) else {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        };
        let target = self.phase2_target(org);
        self.schedule_readiness(Some(&target), None, input.workspace_mode.as_deref(), input.github_trigger.is_some(), input.webhook_trigger.is_some())?;
        let mut body = timing;
        body["workspaceId"] = json!(input.workspace_id);
        body["completionPolicy"] = json!(input.completion_policy);
        body["maxRunMinutes"] = json!(input.max_run_minutes);
        self.run_in(org, RequestRisk::Read, |client, context| {
            self.schedule_readiness(Some(&context.organization_id), Some(context), input.workspace_mode.as_deref(), input.github_trigger.is_some(), input.webhook_trigger.is_some())?;
            client.request_as("POST", context, &["cloud-schedules", "estimate"], None, Some(body), None, RequestRisk::Read).map_err(|mut error: CloudWorkspaceClientError| {
                // A 404 that names no refusal is a server without the route
                // (another person's private workspace says so by its code).
                if error.status == Some(404) && error.code == "cloud_workspace_unavailable" {
                    error.code = "cloud_schedule_estimate_not_supported".into();
                    error.retryable = false;
                }
                error
            })
        })
    }

    /// Make a scheduled task. It starts billed compute by itself, which the
    /// person confirmed before this was called; the request says so. A mode
    /// is always sent and is never bypass permissions.
    fn schedule_configuration(input: &CloudScheduleCreateInput) -> Result<Value, CloudWorkspaceClientError> {
        let invalid = |code: &str| Err(CloudWorkspaceClientError::local(code, false));
        let name = input.name.trim();
        let Some(trigger_body) = automation_body(input.schedule.as_ref(), input.github_trigger.as_ref(), input.webhook_trigger.is_some(), input.workspace_mode.as_deref(), input.archive_after_days, input.archive_on_pr_merge) else { return invalid("cloud_workspace_request_invalid") };
        // As the server reads it: printable ASCII, no space.
        let model_ok = input.model.as_deref().is_none_or(|model| (1..=100).contains(&model.len()) && model.bytes().all(|byte| (0x21..=0x7e).contains(&byte)));
        let effort_ok = input.effort.as_deref().is_none_or(|effort| (1..=16).contains(&effort.len()) && effort.bytes().all(|byte| byte.is_ascii_lowercase()));
        if !valid_resource_id(&input.workspace_id)
            || name.is_empty()
            || name.chars().count() > SCHEDULE_NAME_CHARS
            || name.chars().any(char::is_control)
            || !crate::cloud_agents::launch::valid_agent(&input.agent)
            || !model_ok
            || !effort_ok
            || !SCHEDULE_MODES.contains(&input.mode.as_str())
            || !valid_schedule_policies(Some(&input.missed_run_policy), &input.completion_policy, input.max_run_minutes)
        {
            return invalid("cloud_workspace_request_invalid");
        }
        if input.prompt.trim().is_empty() || input.prompt.len() > MAX_PROMPT_BYTES || input.prompt.contains('\0') {
            return invalid("cloud_workspace_prompt_too_long");
        }
        let mut body = json!({
            "workspaceId": input.workspace_id,
            "name": name,
            "agent": input.agent,
            "mode": input.mode,
            "prompt": input.prompt,
            "missedRunPolicy": input.missed_run_policy,
            "completionPolicy": input.completion_policy,
            "maxRunMinutes": input.max_run_minutes,
        });
        body.as_object_mut().unwrap().extend(trigger_body.as_object().unwrap().clone());
        if let Some(model) = input.model.as_deref() {
            body["model"] = json!(model);
        }
        if let Some(effort) = input.effort.as_deref() {
            body["effort"] = json!(effort);
        }
        Ok(body)
    }

    pub fn schedule_create(&self, org: Option<&str>, input: &CloudScheduleCreateInput) -> Result<CloudScheduleWriteResult, CloudWorkspaceClientError> {
        let mut body = Self::schedule_configuration(input)?;
        body["confirmProviderSpend"] = json!(true);
        let target = self.phase2_target(org);
        self.schedule_readiness(Some(&target), None, input.workspace_mode.as_deref(), input.github_trigger.is_some(), input.webhook_trigger.is_some())?;
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            self.schedule_readiness(Some(&context.organization_id), Some(context), input.workspace_mode.as_deref(), input.github_trigger.is_some(), input.webhook_trigger.is_some())?;
            let result: CloudScheduleSecretAnswer = client.request(context, &["cloud-schedules"], None, Some(body), None, RequestRisk::Mutation)?;
            if result.schedule.view.workspace_id != input.workspace_id || !valid_schedule_id(&result.schedule.view.id) {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            result.schedule.into_write_result(client, input.webhook_trigger.is_some())
        })
    }

    pub fn schedule_webhook_rotate(&self, org: Option<&str>, schedule_id: &str) -> Result<CloudScheduleWriteResult, CloudWorkspaceClientError> {
        let target = self.phase2_target(org);
        self.phase2_gate(PHASE2_WEBHOOK_TRIGGER, Some(&target), None, "cloud_workspace_runtime_not_ready")?;
        if !valid_schedule_id(schedule_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            self.phase2_gate(PHASE2_WEBHOOK_TRIGGER, Some(&context.organization_id), Some(context), "cloud_workspace_runtime_not_ready")?;
            let result: CloudScheduleSecretAnswer = client.request(
                context, &["cloud-schedules", schedule_id, "webhook", "rotate"],
                None, Some(json!({})), None, RequestRisk::Mutation,
            )?;
            if result.schedule.view.id != schedule_id {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            result.schedule.into_write_result(client, true)
        })
    }

    /// Pause a scheduled task, or resume a paused one. Resuming starts billed
    /// compute by itself again and makes the schedule run for this person.
    pub fn schedule_set_active(&self, org: Option<&str>, schedule_id: &str, active: bool) -> Result<CloudSchedule, CloudWorkspaceClientError> {
        if !valid_schedule_id(schedule_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        let (context, access) = self.context_in(org)?;
        // Resume can start billed compute. Read the saved trigger and mode
        // before the mutation so each required readiness key is enforced.
        if active {
            let detail: Result<CloudScheduleDetail, _> = self.client.request(&context, &["cloud-schedules", schedule_id], None, None, None, RequestRisk::Read);
            if !self.account.is_current_in(&context, access) {
                return Err(context_changed_error(RequestRisk::Read));
            }
            let saved = detail?.schedule;
            if saved.id != schedule_id { return Err(invalid_response()); }
            if !matches!(saved.workspace_mode.as_str(), "existing" | "fresh")
                || (saved.schedule.is_none() && saved.github_trigger.is_none() && saved.webhook_trigger.is_none()) {
                return Err(CloudWorkspaceClientError::local("cloud_schedule_runtime_unsupported", false));
            }
            self.schedule_readiness(Some(&context.organization_id), Some(&context), Some(&saved.workspace_mode), saved.github_trigger.is_some(), saved.webhook_trigger.is_some())
                .map_err(|_| CloudWorkspaceClientError::local("cloud_schedule_runtime_unsupported", false))?;
        }
        let (action, body) = if active { ("resume", json!({ "confirmProviderSpend": true })) } else { ("pause", json!({})) };
        // Use the same captured authority for both requests; never recapture
        // a different account/profile after the preflight authorized a timer.
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        let result = (|| {
            let mut result: CloudScheduleAnswer = self.client.request(&context, &["cloud-schedules", schedule_id, action], None, Some(body), None, RequestRisk::Mutation)?;
            if result.schedule.id != schedule_id {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            self.client.normalize_schedule(&mut result.schedule, &mut [], RequestRisk::Mutation)?;
            Ok(result.schedule)
        })();
        if !self.account.is_current_in(&context, access) {
            return Err(context_changed_error(RequestRisk::Mutation));
        }
        result
    }

    /// Read the editable configuration using the server’s edit authorization.
    pub fn schedule_edit(&self, org: &str, schedule_id: &str) -> Result<CloudScheduleEdit, CloudWorkspaceClientError> {
        use crate::account::PHASE2_ORGANIZATION_AUTOMATIONS;
        if !valid_schedule_id(schedule_id) {
            return Err(inbox_invalid());
        }
        self.phase2_member_in(PHASE2_ORGANIZATION_AUTOMATIONS, "cloud_workspace_runtime_not_ready", org, RequestRisk::Read, |client, context| {
            let mut result: CloudScheduleEdit = client.request_as(
                "GET", context, &["cloud-schedules", schedule_id, "edit"], None, None, None, RequestRisk::Read,
            )?;
            if result.schedule.id != schedule_id || !result.schedule.updated_at.is_some_and(valid_schedule_revision) {
                return Err(post_send_error(RequestRisk::Read));
            }
            if result.configuration.get("webhookTrigger") == Some(&Value::Bool(true)) {
                result.configuration["webhookTrigger"] = json!({});
            }
            let input: CloudScheduleCreateInput = serde_json::from_value(result.configuration)
                .map_err(|_| post_send_error(RequestRisk::Read))?;
            if input.workspace_id != result.schedule.workspace_id {
                return Err(post_send_error(RequestRisk::Read));
            }
            self.schedule_readiness(Some(org), Some(context), input.workspace_mode.as_deref(), input.github_trigger.is_some(), input.webhook_trigger.is_some())?;
            result.configuration = Self::schedule_configuration(&input).map_err(|_| post_send_error(RequestRisk::Read))?;
            // The editor consumes a full timing DTO. The create/PATCH wire
            // format omits fields that do not apply to the chosen preset.
            if let Some(timing) = input.schedule {
                result.configuration["schedule"] = json!(timing);
            }
            client.normalize_schedule(&mut result.schedule, &mut [], RequestRisk::Read)?;
            Ok(result)
        })
    }

    pub fn schedule_patch(&self, org: &str, schedule_id: &str, expected_updated_at: u64, confirm_provider_spend: bool, input: &CloudScheduleCreateInput) -> Result<CloudSchedule, CloudWorkspaceClientError> {
        use crate::account::PHASE2_ORGANIZATION_AUTOMATIONS;
        if !valid_schedule_id(schedule_id) || !valid_schedule_revision(expected_updated_at) || !confirm_provider_spend {
            return Err(inbox_invalid());
        }
        let mut body = Self::schedule_configuration(input)?;
        body["expectedUpdatedAt"] = json!(expected_updated_at);
        body["confirmProviderSpend"] = json!(true);
        self.phase2_member_in(PHASE2_ORGANIZATION_AUTOMATIONS, "cloud_workspace_runtime_not_ready", org, RequestRisk::Mutation, |client, context| {
            self.schedule_readiness(Some(org), Some(context), input.workspace_mode.as_deref(), input.github_trigger.is_some(), input.webhook_trigger.is_some())?;
            let mut result: CloudScheduleAnswer = client.request_as(
                "PATCH", context, &["cloud-schedules", schedule_id], None, Some(body), None, RequestRisk::Mutation,
            )?;
            if result.schedule.id != schedule_id || result.schedule.workspace_id != input.workspace_id
                || !result.schedule.updated_at.is_some_and(valid_schedule_revision)
            {
                return Err(post_send_error(RequestRisk::Mutation));
            }
            client.normalize_schedule(&mut result.schedule, &mut [], RequestRisk::Mutation)?;
            Ok(result.schedule)
        })
    }

    pub fn schedule_run_now(&self, org: &str, schedule_id: &str, confirm_provider_spend: bool, idempotency_key: &str) -> Result<CloudScheduleRunNow, CloudWorkspaceClientError> {
        use crate::account::PHASE2_ORGANIZATION_AUTOMATIONS;
        if !confirm_provider_spend || !valid_schedule_id(schedule_id) || !valid_idempotency_key(idempotency_key) {
            return Err(inbox_invalid());
        }
        self.phase2_member_in(PHASE2_ORGANIZATION_AUTOMATIONS, "cloud_workspace_runtime_not_ready", org, RequestRisk::Mutation, |client, context| {
            client.request(context, &["cloud-schedules", schedule_id, "run-now"], None,
                Some(json!({ "confirmProviderSpend": true })), Some(idempotency_key), RequestRisk::Mutation)
        })
    }

    /// Delete a scheduled task, its prompt and its runs.
    pub fn schedule_delete(&self, org: Option<&str>, schedule_id: &str) -> Result<(), CloudWorkspaceClientError> {
        if !valid_schedule_id(schedule_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            let _: Value = client.request_as("DELETE", context, &["cloud-schedules", schedule_id], None, None, None, RequestRisk::Mutation)?;
            Ok(())
        })
    }

    /// Pause every active scheduled task of the organization: nothing starts
    /// from the next scheduler pass on. Each is resumed by hand.
    pub fn schedules_pause_all(&self, org: Option<&str>) -> Result<CloudSchedulesPaused, CloudWorkspaceClientError> {
        self.run_in(org, RequestRisk::Mutation, |client, context| client.request(context, &["cloud-schedules", "pause-all"], None, Some(json!({})), None, RequestRisk::Mutation))
    }

    pub fn operation(
        &self,
        org: Option<&str>,
        operation_id: &str,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        self.operation_request(org, operation_id, RequestRisk::Read)
    }

    pub fn cancel_operation(
        &self,
        org: Option<&str>,
        operation_id: &str,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        self.operation_request(org, operation_id, RequestRisk::Mutation)
    }

    fn operation_request(
        &self,
        org: Option<&str>,
        operation_id: &str,
        risk: RequestRisk,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        if !valid_resource_id(operation_id) {
            return Err(CloudWorkspaceClientError::local(
                "cloud_workspace_request_invalid",
                false,
            ));
        }
        let request = |client: &Client, context: &AccountContext| {
            let tail = [
                "cloud-workspace-operations",
                operation_id,
                if matches!(risk, RequestRisk::Mutation) {
                    "cancel"
                } else {
                    ""
                },
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
            let result: CloudWorkspaceSnapshot = client.request(
                context,
                tail.as_slice(),
                None,
                matches!(risk, RequestRisk::Mutation).then(|| json!({})),
                None,
                risk,
            )?;
            if result.operation.id != operation_id {
                return Err(post_send_error(risk));
            }
            ensure_snapshot(result, &context.organization_id, None, risk)
        };
        // Once the accepted Phase 2 routes are activated, their existing poll
        // endpoint also accepts a member target without requiring it active.
        if matches!(risk, RequestRisk::Read) && org.is_some_and(|org| self.phase2_ready(PHASE2_RESTART_DETAILS, Some(org), None)) {
            self.member_phase2_workspace(org, operation_id, risk, |client, context| {
                self.phase2_gate(PHASE2_RESTART_DETAILS, Some(&context.organization_id), Some(context), "cloud_workspace_runtime_not_ready")?;
                request(client, context)
            })
        } else {
            self.run_in(org, risk, request)
        }
    }
}

fn decode_response<T: DeserializeOwned>(
    response: ureq::Response,
    risk: RequestRisk,
    limit: u64,
) -> Result<T, CloudWorkspaceClientError> {
    let bytes = bounded_body_limited(response, risk, limit)?;
    serde_json::from_slice(&bytes).map_err(|_| post_send_error(risk))
}

fn bounded_body(
    response: ureq::Response,
    risk: RequestRisk,
) -> Result<zeroize::Zeroizing<Vec<u8>>, CloudWorkspaceClientError> {
    bounded_body_limited(response, risk, RESPONSE_LIMIT_BYTES)
}

fn bounded_body_limited(
    response: ureq::Response,
    risk: RequestRisk,
    limit: u64,
) -> Result<zeroize::Zeroizing<Vec<u8>>, CloudWorkspaceClientError> {
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    response
        .into_reader()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| post_send_error(risk))?;
    if bytes.len() as u64 > limit {
        return Err(post_send_error(risk));
    }
    Ok(bytes)
}

fn http_error(
    status: u16,
    response: ureq::Response,
    risk: RequestRisk,
) -> CloudWorkspaceClientError {
    let retry_after_seconds = parse_retry_after(response.header("Retry-After"));
    let parsed_code = bounded_body(response, risk)
        .ok()
        .and_then(|body| serde_json::from_slice::<ErrorEnvelope>(&body).ok())
        .map(|error| error.error)
        .filter(|code| known_error_code(code));
    if parsed_code.is_none() && matches!(risk, RequestRisk::Create) {
        return create_outcome_unknown();
    }
    let code = parsed_code.unwrap_or_else(|| "cloud_workspace_unavailable".into());
    let uncertain = status == 429 || status >= 500;
    let retryable = uncertain && matches!(risk, RequestRisk::Read);
    CloudWorkspaceClientError {
        code,
        status: Some(status),
        retryable,
        retry_after_seconds,
        retry_with_same_idempotency_key: matches!(risk, RequestRisk::Create) && uncertain,
        requires_original_account_context: !matches!(risk, RequestRisk::Read) && uncertain,
    }
}

fn transport_error(risk: RequestRisk) -> CloudWorkspaceClientError {
    match risk {
        RequestRisk::Read => CloudWorkspaceClientError::local("cloud_workspace_unavailable", true),
        RequestRisk::Mutation => post_send_error(RequestRisk::Mutation),
        RequestRisk::Create => create_outcome_unknown(),
    }
}

fn parse_retry_after(value: Option<&str>) -> Option<u64> {
    value?
        .trim()
        .parse::<u64>()
        .ok()
        .map(|seconds| seconds.min(MAX_RETRY_AFTER_SECONDS))
}

fn inbox_invalid() -> CloudWorkspaceClientError {
    CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false)
}

fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "invalid_access_token"
            | "workspace_owner_changed"
            | "workspace_reassign_same_owner"
            | "workspace_reassign_private_confirmation_required"
            | "workspace_reassign_target_not_visible"
            | "workspace_reassign_busy"
            | "workspace_reassign_personal_route_held"
            | "workspace_reassign_credential_restricted"
            | "workspace_reassign_runtime_unsupported"
            | "workspace_reassign_idempotency_conflict"
            | "cloud_workspace_last_admin"
            | "cloud_workspace_access_revision_conflict"
            | "cloud_workspace_general_access_unavailable"
            | "cloud_workspace_groups_unavailable"
            | "cloud_workspace_group_share_not_found"
            | "cloud_workspace_group_manager_unsupported"
            | "organization_group_not_found"
            | "workspace_following_unavailable"
            | "workspace_mentions_unavailable"
            | "nudge_rate_limited"
            | "nudges_unavailable"
            | "announcements_unavailable"
            | "presence_rate_limited"
            | "presence_device_limit"
            | "presence_capacity_exceeded"
            | "presence_unavailable"
            | "inbox_unavailable"
            | "organization_admin_required"
            | "organization_member_limit_reached"
            | "organization_billing_unavailable"
            | "active_organization_required"
            | "cloud_workspace_not_found"
            | "cloud_workspace_operation_not_found"
            | "machine0_connection_required"
            | "cloud_provider_not_found"
            | "cloud_provider_disabled"
            | "cloud_provider_connection_required"
            | "cloud_provider_connection_attention_required"
            // Connected, with new machines paused for the organization
            // (terminalx-saas #257); older servers said cloud_provider_unavailable.
            | "cloud_provider_creation_disabled"
            | "cloud_provider_operation_in_progress"
            | "cloud_provider_account_mismatch"
            | "cloud_provider_disposition_required"
            | "cloud_provider_credential_invalid"
            | "cloud_provider_permission_denied"
            | "cloud_provider_rate_limited"
            | "cloud_provider_invalid_response"
            | "cloud_provider_billing_required"
            | "cloud_provider_unavailable"
            | "cloud_workspace_provider_unsupported"
            | "cloud_workspace_credential_required"
            | "cloud_workspace_credential_in_use"
            | "cloud_workspace_credential_invalid"
            | "cloud_workspace_credential_verification_unavailable"
            | "cloud_workspace_repository_credential_required"
            | "cloud_workspace_repository_not_accessible"
            | "cloud_workspace_repository_ref_not_found"
            | "cloud_workspace_repository_verification_unavailable"
            | "cloud_workspace_agent_credential_required"
            // The provider no longer accepts the organization's login for an
            // agent: someone has to sign it in again (terminalx-saas #241).
            | "cloud_agent_credential_reauth_required"
            | "cloud_workspace_device_auth_unavailable"
            | "cloud_workspace_operation_in_progress"
            | "cloud_workspace_active_work"
            | "cloud_workspace_archived"
            | "cloud_teardown_in_progress"
            | "cloud_teardown_not_found"
            | "cloud_teardown_preview_changed"
            | "cloud_workspace_quota_exceeded"
            | "cloud_schedule_runtime_unsupported"
            | "cloud_schedule_cleanup_pending"
            | "cloud_schedule_revision_conflict"
            | "cloud_schedule_run_active"
            | "cloud_schedule_prompt_shell_command"
            | "cloud_schedule_prompt_slash_command"
            | "cloud_schedule_prompt_file_mention"
            | "cloud_schedule_needs_approval"
            | "cloud_workspace_concurrency_exceeded"
            // Existing SaaS lifecycle errors reused by restart; no new domain errors.
            | "cloud_workspace_manager_required"
            | "cloud_workspace_runtime_unsupported"
            | "cloud_workspace_runtime_not_ready"
            | "cloud_workspace_member_concurrency_exceeded"
            | "cloud_preparation_workspace_expired"
            | "idempotency_key_reused"
            | "cloud_workspace_quote_expired"
            | "cloud_workspace_request_invalid"
            | "cloud_workspace_rate_limited"
            | "machine0_invalid_response"
            | "machine0_unavailable"
            | "cloud_workspace_policy_denied"
            | "cloud_provisioning_paused"
            | "cloud_compute_policy_conflict"
            | "cloud_environment_changed"
            | "cloud_environment_repository_not_in_image"
            | "cloud_environment_version_missing"
            | "cloud_workspace_repository_invalid"
            | "cloud_workspace_github_installation_unavailable"
            | "github_app_not_configured"
            | "github_app_unavailable"
            | "github_repository_not_accessible"
            | "github_repository_not_authorized"
            | "github_repository_not_granted"
            | "github_repository_unavailable"
            | "github_installation_suspended"
            | "github_installation_revoked"
            | "organization_member_not_found"
            | "cloud_workspace_share_unavailable"
            | "cloud_workspace_share_not_found"
            | "cloud_workspace_share_redundant"
            | "cloud_workspace_share_requires_organization_access"
            | "cloud_workspace_share_limit"
            | "cloud_workspace_share_forbidden"
            | "cloud_workspace_share_credential_restricted"
            | "cloud_workspace_share_personal_route"
            | "cloud_workspace_collaboration_forbidden"
            | "cloud_agent_route_invalid"
            | "cloud_agent_route_template_unknown"
            | "cloud_agent_route_base_url_invalid"
            | "cloud_agent_route_model_invalid"
            | "cloud_agent_route_helper_invalid"
            | "cloud_agent_route_credential_invalid"
            | "cloud_agent_route_credential_required"
            | "cloud_agent_route_conflict"
    )
}

fn valid_resource_id(value: &str) -> bool {
    value != "."
        && value != ".."
        && !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_idempotency_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn valid_share_id(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-' | b'@'))
}

fn valid_group_shares(shares: &[CloudGroupShare]) -> bool {
    shares.len() <= 64 && shares.iter().all(|share| share.group_id == share.group.id && valid_share_id(&share.group_id))
}

fn invalid_response() -> CloudWorkspaceClientError {
    CloudWorkspaceClientError::local("cloud_workspace_invalid_response", false)
}

fn create_outcome_unknown() -> CloudWorkspaceClientError {
    CloudWorkspaceClientError {
        code: "cloud_workspace_create_outcome_unknown".into(),
        status: None,
        retryable: false,
        retry_after_seconds: None,
        retry_with_same_idempotency_key: true,
        requires_original_account_context: true,
    }
}

fn post_send_error(risk: RequestRisk) -> CloudWorkspaceClientError {
    match risk {
        RequestRisk::Read => invalid_response(),
        RequestRisk::Mutation => {
            let mut error =
                CloudWorkspaceClientError::local("cloud_workspace_request_outcome_unknown", false);
            error.requires_original_account_context = true;
            error
        }
        RequestRisk::Create => create_outcome_unknown(),
    }
}

fn context_changed_error(risk: RequestRisk) -> CloudWorkspaceClientError {
    match risk {
        RequestRisk::Read => CloudWorkspaceClientError::local("account_context_changed", true),
        RequestRisk::Mutation => {
            let mut error = CloudWorkspaceClientError::local("account_context_changed", false);
            error.requires_original_account_context = true;
            error
        }
        RequestRisk::Create => {
            let mut error = create_outcome_unknown();
            error.code = "account_context_changed".into();
            error
        }
    }
}

fn safe_optional_error_code<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(value.map(|code| {
        if known_operation_error_code(&code) {
            code
        } else {
            "cloud_workspace_unknown_error".into()
        }
    }))
}

fn safe_provider_error_code<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(code)) if safe_provider_code(&code) => Some(code),
        _ => None,
    })
}

/// A detail code as the server stores it: `^[a-z0-9][a-z0-9_-]{0,79}$`.
fn safe_detail_code<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(code))
            if (1..=80).contains(&code.len())
                && !matches!(code.as_bytes()[0], b'_' | b'-')
                && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')) =>
        {
            Some(code)
        }
        _ => None,
    })
}

fn safe_provider_operation_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(id))
            if (1..=128).contains(&id.len())
                && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')) =>
        {
            Some(id)
        }
        _ => None,
    })
}

/// A provider error code as the server normalizes it: lowercase letters,
/// digits and `_ . : -`, at most 64 bytes.
fn safe_provider_code(code: &str) -> bool {
    (1..=64).contains(&code.len())
        && code.as_bytes()[0].is_ascii_alphanumeric()
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

fn known_operation_error_code(code: &str) -> bool {
    known_error_code(code)
        || matches!(
            code,
            "provider_retry_exhausted"
                | "provider_reconciliation_required"
                | "provider_cleanup_pending"
                | "machine0_provisioning_failed"
                | "relay_attestation_pending"
                | "attachment_revocation_pending"
                | "cloud_provider_ambiguous_mutation"
                | "cloud_provider_credential_invalid"
                | "cloud_provider_billing_required"
                | "cloud_provider_rate_limited"
                | "cloud_provider_quota_exhausted"
                | "cloud_provider_capacity_unavailable"
                | "cloud_provider_state_conflict"
                | "cloud_provider_not_found"
                | "cloud_provider_invalid_response"
                | "cloud_provider_unavailable"
                | "cloud_provider_idempotency_key_reused"
                | "cloud_provider_idempotency_window_expired"
                | "cloud_provider_unsupported"
                | "provider_permanent_delete_unavailable"
                | "runtime_checkpoint_pending"
                | "cloud_workspace_runtime_bootstrap_failed"
                | "cloud_workspace_provisioning_timeout"
        )
}

fn ensure_provider<T>(
    value: T,
    expected: &CloudWorkspaceProviderId,
    risk: RequestRisk,
) -> Result<T, CloudWorkspaceClientError>
where
    T: ProviderBound,
{
    if value.provider_id() != expected {
        return Err(post_send_error(risk));
    }
    Ok(value)
}

fn ensure_connection(
    value: CloudProviderConnectionResponse,
    expected: &CloudWorkspaceProviderId,
) -> Result<CloudProviderConnectionResponse, CloudWorkspaceClientError> {
    if &value.provider != expected {
        return Err(invalid_response());
    }
    Ok(value)
}

trait ProviderBound {
    fn provider_id(&self) -> &CloudWorkspaceProviderId;
}

impl ProviderBound for CloudProviderSummary {
    fn provider_id(&self) -> &CloudWorkspaceProviderId {
        &self.id
    }
}
impl ProviderBound for CloudWorkspaceSetup {
    fn provider_id(&self) -> &CloudWorkspaceProviderId {
        &self.provider
    }
}
impl ProviderBound for CloudWorkspaceQuote {
    fn provider_id(&self) -> &CloudWorkspaceProviderId {
        &self.provider
    }
}

fn ensure_teardown(value: CloudTeardown, org_id: &str, risk: RequestRisk) -> Result<CloudTeardown, CloudWorkspaceClientError> {
    if value.organization_id != org_id {
        return Err(post_send_error(risk));
    }
    Ok(value)
}

fn ensure_snapshot(
    value: CloudWorkspaceSnapshot,
    org_id: &str,
    workspace_id: Option<&str>,
    risk: RequestRisk,
) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
    if value.workspace.org_id != org_id
        || value.operation.workspace_id != value.workspace.id
        || workspace_id.is_some_and(|expected| value.workspace.id != expected)
        || !valid_resource_id(&value.workspace.id)
        || !valid_resource_id(&value.operation.id)
        || value.operation.error_code.as_deref().is_some_and(|code| {
            !known_operation_error_code(code) && code != "cloud_workspace_unknown_error"
        })
    {
        return Err(post_send_error(risk));
    }
    Ok(value)
}

fn ensure_list(
    value: CloudWorkspaceList,
    org_id: &str,
    risk: RequestRisk,
) -> Result<CloudWorkspaceList, CloudWorkspaceClientError> {
    if value.workspaces.iter().any(|item| {
        item.workspace.creator.as_ref().is_some_and(|person| !valid_presence_id(&person.user_id) || item.workspace.created_by.as_deref() != Some(person.user_id.as_str()))
            || item.presence.as_ref().is_some_and(|presence| !valid_presence_people(&presence.active_members))
            || item.workspace.org_id != org_id
            || !valid_resource_id(&item.workspace.id)
            || item
                .latest_operation
                .as_ref()
                .is_some_and(|operation| operation.workspace_id != item.workspace.id)
            || item.latest_operation.as_ref().is_some_and(|operation| {
                !valid_resource_id(&operation.id)
                    || operation.error_code.as_deref().is_some_and(|code| {
                        !known_operation_error_code(code) && code != "cloud_workspace_unknown_error"
                    })
            })
    }) || value
        .tombstones
        .iter()
        .any(|tombstone| tombstone.org_id != org_id || !valid_resource_id(&tombstone.id))
    {
        return Err(post_send_error(risk));
    }
    Ok(value)
}

mod agent_model_routes;
pub use agent_model_routes::{AgentRouteAgent, AgentRouteSave, AgentRouteSaved};

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;

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

    struct CapturedRequest {
        text: String,
        extra_request: bool,
    }

    fn request_is_complete(request: &[u8]) -> bool {
        let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            return false;
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        });
        content_length.is_none_or(|length| request.len() >= header_end + 4 + length)
    }

    /// Answer each request in turn, one connection each, and return what
    /// was received. A connection that never comes is an empty string.
    fn serve_each(responses: Vec<String>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let handle = thread::spawn(move || {
            let mut received = Vec::new();
            for response in responses {
                let deadline = Instant::now() + Duration::from_secs(2);
                let stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break Some(stream),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                        Err(_) => break None,
                    }
                };
                let Some(mut stream) = stream else {
                    received.push(String::new());
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                while request.len() <= 64 * 1024 {
                    let read = stream.read(&mut buffer).expect("read bounded fixture request");
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request_is_complete(&request) {
                        break;
                    }
                }
                let _ = stream.write_all(response.as_bytes());
                received.push(String::from_utf8_lossy(&request).into_owned());
            }
            received
        });
        (format!("http://{address}"), handle)
    }

    fn serve_once(
        response: String,
        response_delay: Duration,
    ) -> (
        String,
        mpsc::Receiver<()>,
        thread::JoinHandle<CapturedRequest>,
    ) {
        serve_once_after(response, move || thread::sleep(response_delay))
    }

    fn serve_once_after(
        response: String,
        before_reply: impl FnOnce() + Send + 'static,
    ) -> (
        String,
        mpsc::Receiver<()>,
        thread::JoinHandle<CapturedRequest>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let (accepted_tx, accepted_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while request.len() <= 64 * 1024 {
                let read = stream
                    .read(&mut buffer)
                    .expect("read bounded fixture request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request_is_complete(&request) {
                    break;
                }
            }
            let _ = accepted_tx.send(());
            before_reply();
            let _ = stream.write_all(response.as_bytes());
            drop(stream);
            thread::sleep(Duration::from_millis(40));
            let extra_request = listener.accept().is_ok();
            CapturedRequest {
                text: String::from_utf8(request).unwrap(),
                extra_request,
            }
        });
        (format!("http://{address}"), accepted_rx, handle)
    }

    fn response(status: &str, body: &str, extra_headers: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn test_service(base: &str) -> (Arc<AccountManager>, CloudWorkspaceService) {
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(context()));
        let service =
            CloudWorkspaceService::for_test(account.clone(), base, Duration::from_secs(2));
        (account, service)
    }

    fn reassign_body() -> Value {
        json!({"targetUserId":"target.member:@-1", "expectedOwnerId":"previous-owner",
            "requestId":"01234567-89ab-8cde-Bfab-0123456789ab"})
    }

    fn reassign_reply(reassigned: bool) -> Value {
        json!({"workspaceId":"workspace-1", "ownerId":"target.member:@-1",
            "previousOwnerId":"previous-owner", "reassigned":reassigned})
    }

    fn following_call(service: &CloudWorkspaceService, action: &str, org: &str) -> Result<(), CloudWorkspaceClientError> {
        match action {
            "reassign" => service.workspace_reassign(org, "workspace-1", reassign_body()).map(|_| ()),
            "put" => service.workspace_follow(org, "workspace-1", true, json!({})).map(|_| ()),
            "delete" => service.workspace_follow(org, "workspace-1", false, json!({})).map(|_| ()),
            _ => unreachable!(),
        }
    }

    fn following_reply(action: &str) -> Value {
        if action == "reassign" { reassign_reply(true) }
        else { json!({"workspaceId":"workspace-1", "following":action == "put"}) }
    }

    #[test]
    fn phase2_following_contract_exact_paths_empty_delete_auth_inactive_org_and_receipt() {
        let (base, requests) = serve_each(vec![
            response("200 OK", r#"{"workspaceId":"workspace-1","following":true}"#, ""),
            response("200 OK", r#"{"workspaceId":"workspace-1","following":false}"#, ""),
            response("200 OK", &reassign_reply(true).to_string(), ""),
            response("200 OK", &reassign_reply(false).to_string(), ""),
            response("200 OK", &reassign_reply(true).to_string(), ""),
        ]);
        let (account, service) = phase2_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], false);
        assert!(service.workspace_follow("org-2", "workspace-1", true, json!({})).unwrap().following);
        assert!(!service.workspace_follow("org-2", "workspace-1", false, json!({})).unwrap().following);
        let mut body = reassign_body();
        body["confirmPrivate"] = json!(false);
        body["note"] = json!("Away\nplease\tland 🦝");
        assert!(service.workspace_reassign("org-2", "workspace-1", body.clone()).unwrap().reassigned);
        // A caller explicitly repeats the same payload. False is a receipt even
        // if another transfer happened later; no fresh-owner lookup is attempted.
        let receipt = service.workspace_reassign("org-2", "workspace-1", body.clone()).unwrap();
        assert!(!receipt.reassigned);
        assert_eq!(receipt.owner_id, "target.member:@-1");
        service.workspace_reassign("org-2", "workspace-1", reassign_body()).unwrap();
        let requests = requests.join().unwrap();
        assert_eq!(requests.len(), 5);
        for (i, (method, suffix, expected)) in [
            ("PUT", "follow", json!({})), ("DELETE", "follow", json!({})),
            ("POST", "reassign", body.clone()), ("POST", "reassign", body),
            ("POST", "reassign", reassign_body()),
        ].into_iter().enumerate() {
            let request = &requests[i];
            assert!(request.starts_with(&format!("{method} /v1/desktop/orgs/org-2/cloud-workspaces/workspace-1/{suffix} HTTP/1.1")));
            phase2_headers(request);
            assert!(request.to_ascii_lowercase().contains("content-type: application/json"));
            assert!(!request.to_ascii_lowercase().contains("idempotency-key:"));
            assert!(!request.contains("presence=1"));
            assert_eq!(serde_json::from_str::<Value>(request.split_once("\r\n\r\n").unwrap().1).unwrap(), expected);
        }
    }

    fn nudge_input(text: &str) -> WorkspaceNudgeInput {
        WorkspaceNudgeInput {
            target_user_id: "teammate".into(),
            workspace_id: "workspace-1".into(),
            session_id: "session-1".into(),
            text: text.into(),
        }
    }

    #[test]
    fn phase2_announcement_sends_the_app_version_and_drops_a_link_that_is_not_https() {
        let card = |link: &str| format!(r#"{{"announcement":{{"id":"a","title":"Team cloud workspaces","body":"Run sessions on your own machines.","link":{link},"isNew":true,"publishedAt":"2026-11-20T00:00:00.000Z"}}}}"#);
        let (base, requests) = serve_each(vec![
            response("200 OK", &card(r#""https://example.com/changelog""#), ""),
            response("200 OK", &card(r#""javascript:alert(1)""#), ""),
            response("200 OK", r#"{"announcement":null}"#, ""),
        ]);
        let (_, service) = phase2_service(&base);
        let first = service.current_announcement("org-1").unwrap().announcement.unwrap();
        assert_eq!((first.title.as_str(), first.link.as_deref(), first.is_new), ("Team cloud workspaces", Some("https://example.com/changelog"), true));
        assert_eq!(service.current_announcement("org-1").unwrap().announcement.unwrap().link, None);
        assert!(service.current_announcement("org-1").unwrap().announcement.is_none());
        let requests = requests.join().unwrap();
        for request in &requests {
            assert!(request.starts_with(&format!("GET /v1/desktop/orgs/org-1/announcements/current?appVersion={} HTTP/1.1", env!("CARGO_PKG_VERSION"))));
            phase2_headers(request);
        }
    }

    #[test]
    fn phase2_announcement_is_gated_and_strict() {
        let (base, _requests) = serve_each(vec![response("200 OK", r#"{"announcement":null,"extra":1}"#, "")]);
        let (_, gated) = test_service(&base);
        assert_eq!(gated.current_announcement("org-1").unwrap_err().code, "announcements_unavailable");
        let (_, service) = phase2_service(&base);
        assert!(service.current_announcement("org-1").is_err());
        assert!(known_error_code("announcements_unavailable"));
    }

    #[test]
    fn phase2_team_nudges_use_exact_paths_and_receipts() {
        let (base, requests) = serve_each(vec![
            response("200 OK", r#"{"enabled":false}"#, ""),
            response("200 OK", r#"{"enabled":true}"#, ""),
            response("200 OK", r#"{"delivered":false}"#, ""),
        ]);
        let (_, service) = phase2_service(&base);
        assert!(!service.nudge_preference("org-1").unwrap().enabled);
        assert!(service.set_nudge_preference("org-1", true).unwrap().enabled);
        assert!(!service.send_nudge("org-1", nudge_input("  Look at the changes 🔎  ")).unwrap().delivered);
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/desktop/orgs/org-1/nudges/preference HTTP/1.1"));
        assert!(requests[1].starts_with("PUT /v1/desktop/orgs/org-1/nudges/preference HTTP/1.1"));
        assert!(requests[2].starts_with("POST /v1/desktop/orgs/org-1/nudges HTTP/1.1"));
        for request in &requests { phase2_headers(request); }
        let body: Value = serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, json!({
            "targetUserId": "teammate", "workspaceId": "workspace-1", "sessionId": "session-1", "text": "Look at the changes 🔎"
        }));
    }

    #[test]
    fn phase2_team_nudges_refuse_bad_input_and_hold_on_missing_readiness() {
        let (_, gated) = test_service("http://127.0.0.1:1");
        assert_eq!(gated.send_nudge("org-1", nudge_input("Hello")).unwrap_err().code, "nudges_unavailable");
        for text in [" ", "Line 1\nLine 2", &"🦝".repeat(241)] {
            assert_eq!(gated.send_nudge("org-1", nudge_input(text)).unwrap_err().code, "cloud_workspace_request_invalid");
        }
    }

    fn mention_body() -> Value {
        json!({"sessionId":"session-1", "tabId":"tab-1", "messageId":"msg-1", "userIds":["user-2", "user-3"]})
    }

    #[test]
    fn phase2_mentions_contract_posts_ids_only_and_validates_the_reply() {
        let (base, requests) = serve_each(vec![
            response("200 OK", r#"{"workspaceId":"workspace-1","mentioned":["user-2","user-3"],"noAccess":[]}"#, ""),
            response("200 OK", r#"{"workspaceId":"workspace-1","mentioned":[],"noAccess":["user-3"]}"#, ""),
            // A follow the check must never report, someone not asked about, another workspace, an extra field.
            response("200 OK", r#"{"workspaceId":"workspace-1","mentioned":["user-2"],"noAccess":[]}"#, ""),
            response("200 OK", r#"{"workspaceId":"workspace-1","mentioned":["user-9"],"noAccess":[]}"#, ""),
            response("200 OK", r#"{"workspaceId":"workspace-2","mentioned":[],"noAccess":[]}"#, ""),
            response("200 OK", r#"{"workspaceId":"workspace-1","mentioned":[],"noAccess":[],"text":"x"}"#, ""),
        ]);
        let (account, service) = phase2_service(&base);
        account.set_memberships_for_test(&["org-1"], false);
        let done = service.workspace_mentions("org-1", "workspace-1", mention_body()).unwrap();
        assert_eq!(done.mentioned, ["user-2", "user-3"]);
        let check = json!({"sessionId":"session-1", "tabId":"tab-1", "userIds":["user-2", "user-3"], "check":true});
        assert_eq!(service.workspace_mentions("org-1", "workspace-1", check.clone()).unwrap().no_access, ["user-3"]);
        for body in [check.clone(), mention_body(), mention_body(), mention_body()] {
            assert!(service.workspace_mentions("org-1", "workspace-1", body).is_err());
        }
        let requests = requests.join().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests[0].starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/mentions HTTP/1.1"));
        phase2_headers(&requests[0]);
        assert_eq!(serde_json::from_str::<Value>(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap(),
            json!({"sessionId":"session-1", "tabId":"tab-1", "messageId":"msg-1", "userIds":["user-2", "user-3"], "check":false}));
        assert_eq!(serde_json::from_str::<Value>(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap(), check);
    }

    #[test]
    fn phase2_mentions_contract_refuses_text_bad_ids_and_production_hold_without_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (account, service) = phase2_service(&base);
        account.set_memberships_for_test(&["org-1"], false);
        let mut production = CloudWorkspaceService::new(account.clone());
        production.client = Client::for_test(&base, Duration::from_millis(30));
        assert_eq!(production.workspace_mentions("org-1", "workspace-1", mention_body()).unwrap_err().code, "workspace_mentions_unavailable");
        let with = |key: &str, value: Value| { let mut body = mention_body(); body[key] = value; body };
        let without = |key: &str| { let mut body = mention_body(); body.as_object_mut().unwrap().remove(key); body };
        for body in [
            Value::Null, json!([]), json!("{}"),
            // The message never goes to the server: there is no field for it.
            with("text", json!("@Aisha can you check?")),
            without("messageId"), without("tabId"), without("sessionId"), without("userIds"),
            with("userIds", json!([])), with("userIds", json!(["user-2", "user-2"])),
            with("userIds", json!((0..11).map(|i| format!("user-{i}")).collect::<Vec<_>>())),
            with("userIds", json!(["has space"])), with("tabId", json!("a/b")), with("tabId", json!("")),
            with("messageId", json!("x".repeat(129))), with("check", json!("yes")),
        ] {
            assert_eq!(service.workspace_mentions("org-1", "workspace-1", body).unwrap_err().code, "cloud_workspace_request_invalid");
        }
        assert_eq!(service.workspace_mentions("org-1", "bad/ws", mention_body()).unwrap_err().code, "cloud_workspace_request_invalid");
        assert!(listener.accept().is_err(), "nothing reached the server");
    }

    #[test]
    fn phase2_following_contract_uuid_versions_variants_and_utf16_boundaries() {
        for version in '1'..='8' {
            for variant in ['8','9','a','b','A','B'] {
                let mut body = reassign_body();
                body["requestId"] = json!(format!("01234567-89AB-{version}CDE-{variant}FAB-0123456789AB"));
                assert!(reassign_input(body).is_ok());
            }
        }
        for note in ["".to_owned(), "a".repeat(500), "🦝".repeat(250), "line\nwith\ttab".to_owned()] {
            let mut body = reassign_body(); body["note"] = json!(note);
            assert!(reassign_input(body).is_ok());
        }
        for id in ["a".repeat(128), "a.b_c:d@e-f".to_owned()] {
            let mut body = reassign_body(); body["targetUserId"] = json!(id);
            assert!(reassign_input(body).is_ok());
        }
        assert!(!valid_presence_id("a.b:c@d"));
        assert!(valid_following_id("a.b:c@d"));
    }

    #[test]
    fn phase2_following_contract_strict_input_path_nulls_and_production_hold_no_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (account, service) = phase2_service(&base);
        let mut production = CloudWorkspaceService::new(account.clone());
        production.client = Client::for_test(&base, Duration::from_millis(30));
        assert!(!production.phase2_contracts_available());
        for action in ["put", "delete", "reassign"] {
            assert_eq!(following_call(&production, action, "org-1").unwrap_err().code, "workspace_following_unavailable");
        }
        for following in [true, false] {
            for body in [Value::Null, json!([]), json!([{}]), json!(true), json!("{}"), json!({"extra":1})] {
                assert_eq!(service.workspace_follow("org-1", "workspace-1", following, body).unwrap_err().code, "cloud_workspace_request_invalid");
            }
        }
        let mut invalid = vec![Value::Null, json!([]), json!({}), json!("input")];
        for key in ["targetUserId", "expectedOwnerId", "requestId"] {
            let mut body = reassign_body(); body.as_object_mut().unwrap().remove(key); invalid.push(body);
            for value in [Value::Null, json!(1), json!(false), json!([]), json!({}), json!("")] {
                let mut body = reassign_body(); body[key] = value; invalid.push(body);
            }
        }
        for (key, values) in [
            ("note", vec![Value::Null, json!(false), json!(42), json!([]), json!({}), json!("a".repeat(501)), json!("🦝".repeat(251))]),
            ("confirmPrivate", vec![Value::Null, json!("false"), json!(0), json!([]), json!({})]),
            ("requestId", vec![json!("01234567-89ab-0cde-8fab-0123456789ab"), json!("01234567-89ab-9cde-8fab-0123456789ab"),
                json!("01234567-89ab-4cde-7fab-0123456789ab"), json!("01234567-89ab-4cde-cfab-0123456789ab"),
                json!("0123456789ab4cde8fab0123456789ab"), json!("{01234567-89ab-4cde-8fab-0123456789ab}"),
                json!("01234567-89ab-4cde-8fab-0123456789ab\n"), json!(" 01234567-89ab-4cde-8fab-0123456789ab")]),
        ] {
            for value in values { let mut body = reassign_body(); body[key] = value; invalid.push(body); }
        }
        for code in (0u8..=31).filter(|code| !matches!(*code, 9 | 10)).chain([127, b'<', b'>']) {
            let mut body = reassign_body(); body["note"] = json!(format!("before{}after", char::from(code))); invalid.push(body);
        }
        let mut extra = reassign_body(); extra["actorId"] = json!("invented"); invalid.push(extra);
        for id in ["", "x/y", "a\\b", "id\n", "id\r", "id?x", "id#x", "%2f", " a", "é", &"a".repeat(129)] {
            for key in ["targetUserId", "expectedOwnerId"] { let mut body = reassign_body(); body[key] = json!(id); invalid.push(body); }
            assert!(service.workspace_reassign(id, "workspace-1", reassign_body()).is_err());
            assert!(service.workspace_reassign("org-1", id, reassign_body()).is_err());
            for following in [true, false] {
                assert!(service.workspace_follow(id, "workspace-1", following, json!({})).is_err());
                assert!(service.workspace_follow("org-1", id, following, json!({})).is_err());
            }
        }
        for id in [".", ".."] {
            assert!(service.workspace_reassign("org-1", id, reassign_body()).is_err());
            assert!(service.workspace_follow(id, "workspace-1", true, json!({})).is_err());
        }
        for body in invalid {
            assert_eq!(service.workspace_reassign("org-1", "workspace-1", body).unwrap_err().code, "cloud_workspace_request_invalid");
        }
        account.set_memberships_for_test(&["org-1"], false);
        for action in ["put", "delete", "reassign"] { assert!(following_call(&service, action, "org-2").is_err()); }
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn phase2_following_contract_bounded_ids_note_wire_and_server_safety_refusals() {
        let workspace = "w".repeat(128);
        let note = "🦝".repeat(250);
        let mut input = reassign_body(); input["note"] = json!(note); input["confirmPrivate"] = json!(true);
        let mut success = reassign_reply(true); success["workspaceId"] = json!(workspace);
        let (base, _, request) = serve_once(response("200 OK", &success.to_string(), ""), Duration::ZERO);
        let (_, service) = phase2_service(&base);
        service.workspace_reassign("org-1", &workspace, input.clone()).unwrap();
        let captured = request.join().unwrap();
        assert!(!captured.extra_request);
        assert_eq!(serde_json::from_str::<Value>(captured.text.split_once("\r\n\r\n").unwrap().1).unwrap(), input);
        let workspace = "workspace.name:@-1";
        let (base, _, request) = serve_once(response("200 OK", &json!({"workspaceId":workspace,"following":true}).to_string(), ""), Duration::ZERO);
        let (_, service) = phase2_service(&base);
        service.workspace_follow("org-1", workspace, true, json!({})).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with(&format!("PUT /v1/desktop/orgs/org-1/cloud-workspaces/{workspace}/follow HTTP/1.1")));
        assert!(!captured.extra_request);
        for (code, confirm) in [
            ("workspace_reassign_private_confirmation_required", false),
            ("workspace_reassign_target_not_visible", true),
            ("workspace_reassign_runtime_unsupported", true),
            ("workspace_reassign_busy", true),
            ("workspace_reassign_personal_route_held", true),
            ("workspace_reassign_credential_restricted", true),
            ("workspace_reassign_idempotency_conflict", true),
        ] {
            let (base, _, request) = serve_once(response("409 Conflict", &json!({"error":code}).to_string(), ""), Duration::ZERO);
            let (_, service) = phase2_service(&base);
            let mut input = reassign_body(); input["confirmPrivate"] = json!(confirm);
            assert_eq!(service.workspace_reassign("org-1", "workspace-1", input).unwrap_err().code, code);
            assert!(!request.join().unwrap().extra_request);
        }
    }

    #[test]
    fn phase2_following_contract_response_ids_booleans_and_exact_receipt() {
        let mut bodies = vec![Value::Null, json!([]), json!({}), json!(["workspace-1","target.member:@-1","previous-owner",true])];
        for (key, value) in [("workspaceId", json!("foreign")), ("ownerId", json!("fresh-owner")), ("previousOwnerId", json!("wrong-owner")),
            ("ownerId", json!("bad\n")), ("reassigned", json!("false")), ("reassigned", Value::Null), ("extra", json!(true))] {
            let mut body = reassign_reply(false); body[key] = value; bodies.push(body);
        }
        let mut missing = reassign_reply(false); missing.as_object_mut().unwrap().remove("reassigned"); bodies.push(missing);
        let (base, requests) = serve_each(bodies.iter().map(|body| response("200 OK", &body.to_string(), "")).collect());
        let (_, service) = phase2_service(&base);
        for _ in &bodies {
            let error = service.workspace_reassign("org-1", "workspace-1", reassign_body()).unwrap_err();
            assert_eq!(error.code, "cloud_workspace_request_outcome_unknown");
            assert!(error.requires_original_account_context);
        }
        assert_eq!(requests.join().unwrap().len(), bodies.len());
        for following in [true, false] {
            for body in [Value::Null, json!(["workspace-1",following]), json!({"workspaceId":"wrong","following":following}),
                json!({"workspaceId":"workspace-1","following":!following}), json!({"workspaceId":"workspace-1","following":"true"}),
                json!({"workspaceId":"workspace-1","following":null}), json!({"workspaceId":"workspace-1"}),
                json!({"workspaceId":"workspace-1","following":following,"extra":1})] {
                let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
                let (_, service) = phase2_service(&base);
                assert_eq!(service.workspace_follow("org-1", "workspace-1", following, json!({})).unwrap_err().code, "cloud_workspace_request_outcome_unknown");
                assert!(!request.join().unwrap().extra_request);
            }
        }
    }

    #[test]
    fn phase2_following_contract_all_server_errors_and_no_automatic_retry() {
        for (status, code) in [
            ("401 Unauthorized", "invalid_access_token"), ("403 Forbidden", "active_organization_required"),
            ("403 Forbidden", "cloud_workspace_manager_required"), ("404 Not Found", "cloud_workspace_not_found"),
            ("422 Unprocessable Entity", "cloud_workspace_request_invalid"),
            ("409 Conflict", "workspace_owner_changed"), ("409 Conflict", "workspace_reassign_same_owner"),
            ("409 Conflict", "workspace_reassign_private_confirmation_required"), ("409 Conflict", "workspace_reassign_target_not_visible"),
            ("409 Conflict", "workspace_reassign_busy"), ("409 Conflict", "workspace_reassign_personal_route_held"),
            ("409 Conflict", "workspace_reassign_credential_restricted"), ("409 Conflict", "workspace_reassign_runtime_unsupported"),
            ("409 Conflict", "cloud_workspace_member_concurrency_exceeded"), ("409 Conflict", "cloud_teardown_in_progress"),
            ("409 Conflict", "workspace_reassign_idempotency_conflict"), ("409 Conflict", "cloud_workspace_last_admin"),
            ("409 Conflict", "cloud_workspace_group_manager_unsupported"),
            ("503 Service Unavailable", "workspace_following_unavailable"),
        ] {
            assert!(known_error_code(code));
            for action in ["put", "delete", "reassign"] {
                let (base, _, request) = serve_once(response(status, &json!({"error":code}).to_string(), ""), Duration::ZERO);
                let (_, service) = phase2_service(&base);
                let error = following_call(&service, action, "org-1").unwrap_err();
                assert_eq!(error.code, code);
                assert_eq!(error.status, Some(status[..3].parse::<u16>().unwrap()));
                assert!(!error.retryable);
                assert!(!error.retry_with_same_idempotency_key);
                assert!(!request.join().unwrap().extra_request);
            }
        }
        let (base, _, request) = serve_once(response("413 Payload Too Large", "framework body limit", ""), Duration::ZERO);
        let (_, service) = phase2_service(&base);
        assert_eq!(following_call(&service, "reassign", "org-1").unwrap_err().status, Some(413));
        assert!(!request.join().unwrap().extra_request);
    }

    #[test]
    fn phase2_following_contract_bounded_timeout_and_body_capture_no_retry() {
        for action in ["put", "delete", "reassign"] {
            let (base, _, request) = serve_once(response("200 OK", &following_reply(action).to_string(), ""), Duration::from_millis(150));
            let (account, _) = test_service(&base);
            let mut service = CloudWorkspaceService::for_test(account, &base, Duration::from_millis(30));
            service.force_phase2_for_test = true;
            let error = following_call(&service, action, "org-1").unwrap_err();
            assert_eq!(error.code, "cloud_workspace_request_outcome_unknown");
            assert_eq!(error.status, None);
            assert!(error.requires_original_account_context);
            assert!(!request.join().unwrap().extra_request);
            let mut body = following_reply(action).to_string(); body.push_str(&" ".repeat(RESPONSE_LIMIT_BYTES as usize + 1));
            let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
            let (_, service) = phase2_service(&base);
            assert_eq!(following_call(&service, action, "org-1").unwrap_err().code, "cloud_workspace_request_outcome_unknown");
            assert!(!request.join().unwrap().extra_request);
        }
    }

    #[test]
    fn phase2_following_contract_late_account_profile_org_session_and_aba_fenced() {
        for change in ["signout", "account", "profile", "org", "session", "aba", "membership"] {
            for (action, rejected) in [("put", false), ("delete", false), ("reassign", false), ("put", true), ("delete", true), ("reassign", true)] {
                let body = following_reply(action);
                let reply = if rejected { response("401 Unauthorized", r#"{"error":"invalid_access_token"}"#, "") }
                    else { response("200 OK", &body.to_string(), "") };
                let (base, accepted, request) = serve_once(reply, Duration::from_millis(100));
                let (account, mut service) = test_service(&base); service.force_phase2_for_test = true;
                account.set_memberships_for_test(&["org-1", "org-2"], false);
                let handle = thread::spawn(move || following_call(&service, action, "org-2"));
                accepted.recv_timeout(Duration::from_secs(1)).unwrap();
                let mut replacement = context();
                match change {
                    "signout" => account.set_context_for_test(None),
                    "membership" => { account.set_memberships_for_test(&["org-1"], false); },
                    "aba" => {
                        let mut other = context();
                        other.user_id = "user-2".into();
                        other.generation += 1;
                        account.set_context_for_test(Some(other));
                        replacement.generation += 2;
                        account.set_context_for_test(Some(replacement));
                        account.set_memberships_for_test(&["org-1", "org-2"], false);
                    },
                    _ => {
                        match change {
                            "account" => replacement.user_id = "user-2".into(),
                            "profile" => replacement.profile_id = "profile-2".into(),
                            "org" => replacement.organization_id = "org-2".into(),
                            "session" => replacement.access_token = "new-session-token".into(),
                            _ => unreachable!(),
                        }
                        account.set_context_for_test(Some(replacement));
                        // Keep target membership valid: each test must fail for
                        // the changed context field, not fixture membership loss.
                        account.set_memberships_for_test(&["org-1", "org-2"], false);
                    },
                }
                let error = handle.join().unwrap().unwrap_err();
                assert_eq!(error.code, "account_context_changed", "{change}, action={action}, rejected={rejected}");
                assert!(error.requires_original_account_context);
                assert!(!request.join().unwrap().extra_request);
            }
        }
    }

    fn presence_put_body() -> Value {
        json!({"deviceId":"01234567-89ab-4cde-8fab-0123456789ab", "sequence":1, "workspaceId":"workspace-1"})
    }

    fn presence_read_body() -> Value {
        json!({"ttlSeconds":45, "activeMembers":[{"userId":"member-1","displayName":null,"photoUrl":"https://example.com/current.png"}],
            "workspaces":[{"workspaceId":"workspace-1", "owner":{"userId":"current-owner","displayName":null,"photoUrl":null},
                "activeMembers":[{"userId":"member-1","displayName":null,"photoUrl":"https://example.com/current.png"}]}]})
    }

    #[test]
    fn phase2_presence_contract_exact_paths_auth_bodies_and_nonactive_target() {
        let (base, requests) = serve_each(vec![
            response("200 OK", r#"{"applied":false,"ttlSeconds":45}"#, ""),
            response("200 OK", r#"{"applied":true,"ttlSeconds":45}"#, ""),
            response("200 OK", &presence_read_body().to_string(), ""),
            response("200 OK", r#"{"ttlSeconds":45,"activeMembers":[],"workspaces":[]}"#, ""),
        ]);
        let (account, mut service) = test_service(&base);
        service.force_phase2_for_test = true;
        // Membership alone authorizes the inactive org, without CS-18 opt-in.
        account.set_memberships_for_test(&["org-1", "org-2"], false);
        let mut body = presence_put_body();
        body["sequence"] = json!(9_007_199_254_740_991_u64);
        assert!(!service.presence_put("org-2", body.clone()).unwrap().applied);
        let mut leave = body.clone();
        leave["workspaceId"] = Value::Null;
        // Number.isSafeInteger(1.0) is true; its normalized wire value is 1.
        leave["sequence"] = json!(1.0);
        assert!(service.presence_put("org-2", leave.clone()).unwrap().applied);
        leave["sequence"] = json!(1);
        let read = service.presence_read("org-2", json!({"workspaceIds":["workspace-1","omitted"]})).unwrap();
        assert_eq!(read.workspaces.len(), 1);
        assert_eq!(read.workspaces[0].owner.user_id, "current-owner");
        assert!(read.workspaces[0].owner.display_name.is_none());
        assert!(read.workspaces[0].owner.photo_url.is_none());
        assert!(read.active_members[0].display_name.is_none());
        service.presence_read("org-2", json!({"workspaceIds":[]})).unwrap();
        let requests = requests.join().unwrap();
        for (request, path, body) in [
            (&requests[0], "PUT /v1/desktop/orgs/org-2/presence HTTP/1.1", body),
            (&requests[1], "PUT /v1/desktop/orgs/org-2/presence HTTP/1.1", leave),
            (&requests[2], "POST /v1/desktop/orgs/org-2/presence/read HTTP/1.1", json!({"workspaceIds":["workspace-1","omitted"]})),
            (&requests[3], "POST /v1/desktop/orgs/org-2/presence/read HTTP/1.1", json!({"workspaceIds":[]})),
        ] {
            assert!(request.starts_with(path));
            assert!(request.to_ascii_lowercase().contains("authorization: bearer native-secret-token"));
            assert!(!request.to_ascii_lowercase().contains("presence=1"));
            assert!(!request.to_ascii_lowercase().contains("x-terminalx-presence"));
            assert_eq!(serde_json::from_str::<Value>(request.split_once("\r\n\r\n").unwrap().1).unwrap(), body);
        }
    }

    #[test]
    fn server_readiness_only_opens_its_target_route_and_a_refresh_can_close_it() {
        let answer = json!({"ttlSeconds": 45, "activeMembers": [], "workspaces": []});
        let (base, _, request) = serve_once(response("200 OK", &answer.to_string(), ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        let readiness = |enabled| json!({
            "version": 1,
            "organizations": {
                "org-1": { (PHASE2_EVENTS): true },
                "org-2": { (PHASE2_PRESENCE): enabled }
            }
        });
        account.apply_phase2_readiness_for_test(readiness(true));

        assert!(service.phase2_contracts_available());
        assert_eq!(
            service.presence_read("org-1", json!({"workspaceIds": []})).unwrap_err().code,
            "presence_unavailable"
        );
        assert_eq!(
            service.workspace_follow("org-2", "workspace-1", true, json!({})).unwrap_err().code,
            "workspace_following_unavailable"
        );
        assert_eq!(service.presence_read("org-2", json!({"workspaceIds": []})).unwrap().ttl_seconds, 45);
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-2/presence/read HTTP/1.1"));
        assert!(!captured.extra_request);

        account.apply_phase2_readiness_for_test(readiness(false));
        assert!(service.phase2_contracts_available());
        assert_eq!(
            service.presence_read("org-2", json!({"workspaceIds": []})).unwrap_err().code,
            "presence_unavailable"
        );
    }

    #[test]
    fn phase2_presence_contract_invalid_inputs_and_production_hold_never_http() {
        // A bound listener proves no connection was attempted (unlike a dead port).
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let (account, mut service) = test_service(&format!("http://{}", listener.local_addr().unwrap()));
        let mut production = CloudWorkspaceService::new(account.clone());
        assert!(!production.phase2_contracts_available());
        // Route the actual production constructor to the listener, preserving
        // its activation state, so a hold regression would be observable.
        production.client = Client::for_test(&format!("http://{}", listener.local_addr().unwrap()), Duration::from_millis(30));
        assert_eq!(production.presence_put("org-1", presence_put_body()).unwrap_err().code, "presence_unavailable");
        assert_eq!(production.presence_read("org-1", json!({"workspaceIds":[]})).unwrap_err().code, "presence_unavailable");
        assert!(!service.phase2_contracts_available());
        assert_eq!(service.presence_put("org-1", presence_put_body()).unwrap_err().code, "presence_unavailable");
        assert_eq!(service.presence_read("org-1", json!({"workspaceIds":[]})).unwrap_err().code, "presence_unavailable");
        service.force_phase2_for_test = true;
        let valid = presence_put_body();
        let mut invalid = vec![Value::Null, json!([]), json!([valid["deviceId"], 1, null]), json!({}), json!({"deviceId":"x","sequence":1}), json!({"deviceId":1,"sequence":1,"workspaceId":null})];
        for (key, value) in [
            ("deviceId", json!("01234567-89ab-3cde-8fab-0123456789ab")),
            ("deviceId", json!("01234567-89ab-4cde-7fab-0123456789ab")),
            ("deviceId", json!("01234567-89AB-4cde-8fab-0123456789ab")),
            ("deviceId", json!("01234567_89ab-4cde-8fab-0123456789ab")),
            ("deviceId", json!("01234567-89ab-4cde-cfab-0123456789ab")),
            ("sequence", json!(0)), ("sequence", json!(-1)), ("sequence", json!(1.5)),
            ("sequence", json!(9_007_199_254_740_992_u64)), ("sequence", json!("1")),
            ("sequence", Value::Null), ("sequence", json!(true)),
            ("workspaceId", json!("../private")), ("workspaceId", json!("a.b")), ("workspaceId", json!("a:b")),
            ("workspaceId", json!("")), ("workspaceId", json!("x".repeat(129))), ("workspaceId", json!(false)),
            ("userId", json!("actor")), ("profileId", json!("actor")), ("sessionId", json!("actor")),
        ] { let mut body = valid.clone(); body[key] = value; invalid.push(body); }
        for key in ["deviceId", "sequence", "workspaceId"] {
            let mut body = valid.clone(); body.as_object_mut().unwrap().remove(key); invalid.push(body);
        }
        for body in invalid { assert_eq!(service.presence_put("org-1", body).unwrap_err().code, "cloud_workspace_request_invalid"); }
        let too_many: Vec<String> = (0..101).map(|i| format!("workspace-{i}")).collect();
        for body in [Value::Null, json!([]), json!([["workspace-1"]]), json!({}), json!({"workspaceIds":null}), json!({"workspaceIds":[1]}),
            json!({"workspaceIds":["a","a"]}), json!({"workspaceIds":["a/b"]}), json!({"workspaceIds":["x".repeat(129)]}),
            json!({"workspaceIds":too_many}), json!({"workspaceIds":[""]}), json!({"workspaceIds":"a"}),
            json!({"workspaceIds":[],"profileId":"actor"}), json!({"workspaceIds":[],"extra":null})] {
            assert_eq!(service.presence_read("org-1", body).unwrap_err().code, "cloud_workspace_request_invalid");
        }
        for org in ["", "../org", "a.b", "a:b", &"x".repeat(129)] {
            assert_eq!(service.presence_put(org, presence_put_body()).unwrap_err().code, "cloud_workspace_request_invalid");
            assert_eq!(service.presence_read(org, json!({"workspaceIds":[]})).unwrap_err().code, "cloud_workspace_request_invalid");
        }
        account.set_memberships_for_test(&["org-1"], false);
        assert!(service.presence_read("org-2", json!({"workspaceIds":[]})).is_err());
        assert!(matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
        for variant in ['8', '9', 'a', 'b'] {
            assert!(valid_presence_device(&format!("01234567-89ab-4cde-{variant}fab-0123456789ab")));
        }
    }

    #[test]
    fn phase2_presence_contract_subset_omissions_and_invalid_outputs() {
        let mut bodies = vec![presence_read_body()];
        bodies[0]["workspaces"] = json!([]); // Aggregate need not be in requested batch.
        let mut foreign = presence_read_body(); foreign["workspaces"][0]["workspaceId"] = json!("foreign");
        let mut duplicate = presence_read_body(); let repeated = duplicate["workspaces"][0].clone(); duplicate["workspaces"].as_array_mut().unwrap().push(repeated);
        let mut bad_person = presence_read_body(); bad_person["activeMembers"][0]["userId"] = json!("bad/id");
        let mut missing_name = presence_read_body(); missing_name["workspaces"][0]["owner"].as_object_mut().unwrap().remove("displayName");
        let mut email = presence_read_body(); email["workspaces"][0]["owner"]["email"] = json!("hidden@example.com");
        let mut bad_ttl = presence_read_body(); bad_ttl["ttlSeconds"] = json!(44);
        let mut missing_aggregate = presence_read_body(); missing_aggregate["activeMembers"] = json!([]);
        let mut duplicate_people = presence_read_body(); duplicate_people["activeMembers"].as_array_mut().unwrap().push(json!({"userId":"member-1","displayName":null,"photoUrl":null}));
        let mut duplicate_attached = presence_read_body(); let person = duplicate_attached["workspaces"][0]["activeMembers"][0].clone(); duplicate_attached["workspaces"][0]["activeMembers"].as_array_mut().unwrap().push(person);
        let mut array_owner = presence_read_body(); array_owner["workspaces"][0]["owner"] = json!(["owner",null,null]);
        let mut array_person = presence_read_body(); array_person["activeMembers"][0] = json!(["member-1",null,null]);
        let mut array_attached = presence_read_body(); array_attached["workspaces"][0]["activeMembers"][0] = json!(["member-1",null,null]);
        let mut array_workspace = presence_read_body(); let workspace = array_workspace["workspaces"][0].clone();
        array_workspace["workspaces"][0] = json!([workspace["workspaceId"],workspace["owner"],workspace["activeMembers"]]);
        let mut missing_photo = presence_read_body(); missing_photo["activeMembers"][0].as_object_mut().unwrap().remove("photoUrl");
        let mut mistyped_name = presence_read_body(); mistyped_name["activeMembers"][0]["displayName"] = json!(false);
        let mut mistyped_photo = presence_read_body(); mistyped_photo["workspaces"][0]["owner"]["photoUrl"] = json!(42);
        let mut bad_owner = presence_read_body(); bad_owner["workspaces"][0]["owner"]["userId"] = json!("owner/private");
        let mut extra_workspace = presence_read_body(); extra_workspace["workspaces"][0]["creator"] = json!({"userId":"stale-owner"});
        let mut extra_top = presence_read_body(); extra_top["privateCount"] = json!(1);
        let mut too_many_people = presence_read_body(); too_many_people["activeMembers"] = json!((0..501).map(|i| json!({"userId":format!("member-{i}"),"displayName":null,"photoUrl":null})).collect::<Vec<_>>());
        bodies.extend([foreign, duplicate, bad_person, missing_name, email, bad_ttl, missing_aggregate,
            duplicate_people, duplicate_attached, array_owner, array_person, array_attached, array_workspace,
            missing_photo, mistyped_name, mistyped_photo, bad_owner, extra_workspace, extra_top, too_many_people,
            json!([45, [], []]), Value::Null, json!({"ttlSeconds":45,"activeMembers":[]})]);
        let (base, requests) = serve_each(bodies.iter().map(|body| response("200 OK", &body.to_string(), "")).collect());
        let (_, mut service) = test_service(&base); service.force_phase2_for_test = true;
        assert!(service.presence_read("org-1", json!({"workspaceIds":["workspace-1"]})).unwrap().workspaces.is_empty());
        for _ in 1..bodies.len() {
            assert!(service.presence_read("org-1", json!({"workspaceIds":["workspace-1"]})).is_err());
        }
        assert_eq!(requests.join().unwrap().len(), bodies.len());
    }

    #[test]
    fn phase2_presence_contract_current_owner_and_no_cached_authorization() {
        let mut first = presence_read_body();
        first["workspaces"][0]["owner"] = json!({"userId":"previous-owner","displayName":"Previous name","photoUrl":"https://example.com/old.png"});
        let mut current = presence_read_body();
        current["workspaces"][0]["owner"] = json!({"userId":"reassigned-owner","displayName":"Current name","photoUrl":null});
        let (base, requests) = serve_each(vec![
            response("200 OK", &first.to_string(), ""),
            response("200 OK", &current.to_string(), ""),
            response("200 OK", r#"{"ttlSeconds":45,"activeMembers":[],"workspaces":[]}"#, ""),
            response("401 Unauthorized", r#"{"error":"invalid_access_token"}"#, ""),
            response("403 Forbidden", r#"{"error":"active_organization_required"}"#, ""),
            response("404 Not Found", r#"{"error":"cloud_workspace_not_found"}"#, ""),
            response("503 Service Unavailable", r#"{"error":"presence_unavailable"}"#, ""),
        ]);
        let (_, mut service) = test_service(&base); service.force_phase2_for_test = true;
        let read = || service.presence_read("org-1", json!({"workspaceIds":["workspace-1"]}));
        assert_eq!(read().unwrap().workspaces[0].owner.user_id, "previous-owner");
        let latest = read().unwrap();
        let owner = &latest.workspaces[0].owner;
        assert_eq!(owner.user_id, "reassigned-owner");
        assert_eq!(owner.display_name.as_deref(), Some("Current name"));
        assert!(owner.photo_url.is_none());
        let hidden = read().unwrap();
        assert!(hidden.workspaces.is_empty() && hidden.active_members.is_empty());
        for code in ["invalid_access_token", "active_organization_required", "cloud_workspace_not_found", "presence_unavailable"] {
            assert_eq!(read().unwrap_err().code, code);
        }
        assert_eq!(requests.join().unwrap().len(), 7);
    }

    #[test]
    fn phase2_presence_contract_error_codes_retry_after_and_no_retry() {
        for (status, code, retry) in [
            ("429 Too Many Requests", "presence_rate_limited", Some(7)),
            ("429 Too Many Requests", "presence_device_limit", Some(7)),
            ("503 Service Unavailable", "presence_capacity_exceeded", None),
            ("503 Service Unavailable", "presence_unavailable", None),
            ("401 Unauthorized", "invalid_access_token", None),
            ("403 Forbidden", "active_organization_required", None),
            ("404 Not Found", "cloud_workspace_not_found", None),
            ("422 Unprocessable Entity", "cloud_workspace_request_invalid", None),
        ] {
            for put in [true, false] {
                let (base, _, request) = serve_once(response(status, &json!({"error":code}).to_string(), if retry.is_some() { "Retry-After: 7\r\n" } else { "" }), Duration::ZERO);
                let (_, mut service) = test_service(&base); service.force_phase2_for_test = true;
                let error = if put { service.presence_put("org-1", presence_put_body()).unwrap_err() }
                    else { service.presence_read("org-1", json!({"workspaceIds":[]})).unwrap_err() };
                assert_eq!(error.code, code);
                assert_eq!(error.status, Some(status[..3].parse::<u16>().unwrap()));
                assert_eq!(error.retry_after_seconds, retry);
                assert_eq!(serde_json::to_value(&error).unwrap()["retryAfterSeconds"], json!(retry));
                let uncertain = status.starts_with("429") || status.starts_with("503");
                assert_eq!(error.retryable, !put && uncertain);
                assert_eq!(error.requires_original_account_context, put && uncertain);
                assert!(!error.retry_with_same_idempotency_key);
                assert!(!request.join().unwrap().extra_request);
            }
        }
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT")), None);
        assert_eq!(parse_retry_after(Some("1.5")), None);
        let (base, _, request) = serve_once(response("413 Payload Too Large", "framework body limit", ""), Duration::ZERO);
        let (_, mut service) = test_service(&base); service.force_phase2_for_test = true;
        assert_eq!(service.presence_read("org-1", json!({"workspaceIds":[]})).unwrap_err().status, Some(413));
        assert!(!request.join().unwrap().extra_request);
    }

    #[test]
    fn phase2_presence_contract_bounds_malformed_put_and_bounded_timeout() {
        let ids: Vec<String> = (0..100).map(|i| format!("workspace_{i}-A")).collect();
        let (base, _, request) = serve_once(response("200 OK", r#"{"ttlSeconds":45,"activeMembers":[],"workspaces":[]}"#, ""), Duration::ZERO);
        let (_, mut service) = test_service(&base); service.force_phase2_for_test = true;
        service.presence_read("org-1", json!({"workspaceIds":ids})).unwrap();
        assert!(!request.join().unwrap().extra_request);
        for body in [json!([true,45]), Value::Null, json!({"applied":true,"ttlSeconds":46}), json!({"applied":"true","ttlSeconds":45}),
            json!({"ttlSeconds":45}), json!({"applied":true,"ttlSeconds":45,"extra":1})] {
            let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
            let (_, mut service) = test_service(&base); service.force_phase2_for_test = true;
            assert!(service.presence_put("org-1", presence_put_body()).is_err());
            assert!(!request.join().unwrap().extra_request);
        }
        let (base, _, request) = serve_once(response("200 OK", &presence_read_body().to_string(), ""), Duration::from_millis(150));
        let (account, _) = test_service(&base);
        let mut service = CloudWorkspaceService::for_test(account, &base, Duration::from_millis(30));
        service.force_phase2_for_test = true;
        // The delayed reply is valid for this request: only the transport
        // deadline, not an unrequested workspace, may make this call fail.
        let error = service.presence_read("org-1", json!({"workspaceIds":["workspace-1"]})).unwrap_err();
        assert_eq!(error.code, "cloud_workspace_unavailable");
        assert!(error.retryable);
        assert_eq!(error.status, None);
        assert!(!request.join().unwrap().extra_request);
    }

    #[test]
    fn phase2_presence_contract_response_body_capture_is_bounded() {
        for put in [true, false] {
            // Valid JSON with trailing whitespace must still obey the byte cap.
            let mut body = if put { json!({"applied":true,"ttlSeconds":45}).to_string() }
                else { presence_read_body().to_string() };
            body.push_str(&" ".repeat(RESPONSE_LIMIT_BYTES as usize + 1));
            let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
            let (_, mut service) = test_service(&base); service.force_phase2_for_test = true;
            let error = if put { service.presence_put("org-1", presence_put_body()).unwrap_err() }
                else { service.presence_read("org-1", json!({"workspaceIds":["workspace-1"]})).unwrap_err() };
            assert_eq!(error.code, if put { "cloud_workspace_request_outcome_unknown" } else { "cloud_workspace_invalid_response" });
            assert_eq!(error.requires_original_account_context, put);
            assert!(!request.join().unwrap().extra_request);
        }
    }

    #[test]
    fn phase2_presence_contract_late_account_profile_org_session_and_aba_fenced() {
        for change in ["signout", "account", "profile", "org", "session", "aba", "membership"] {
            for (put, rejected) in [(true, false), (false, false), (true, true), (false, true)] {
                let body = if put { json!({"applied":true,"ttlSeconds":45}) } else { presence_read_body() };
                let reply = if rejected { response("401 Unauthorized", r#"{"error":"invalid_access_token"}"#, "") }
                    else { response("200 OK", &body.to_string(), "") };
                let (base, accepted, request) = serve_once(reply, Duration::from_millis(100));
                let (account, mut service) = test_service(&base); service.force_phase2_for_test = true;
                account.set_memberships_for_test(&["org-1", "org-2"], false);
                let handle = thread::spawn(move || if put { service.presence_put("org-2", presence_put_body()).map(|_| ()) }
                    else { service.presence_read("org-2", json!({"workspaceIds":["workspace-1"]})).map(|_| ()) });
                accepted.recv_timeout(Duration::from_secs(1)).unwrap();
                let mut replacement = context();
                match change {
                    "signout" => account.set_context_for_test(None),
                    "membership" => { account.set_memberships_for_test(&["org-1"], false); },
                    "aba" => {
                        let mut other = context();
                        other.user_id = "user-2".into();
                        other.generation += 1;
                        account.set_context_for_test(Some(other));
                        replacement.generation += 2;
                        account.set_context_for_test(Some(replacement));
                        account.set_memberships_for_test(&["org-1", "org-2"], false);
                    },
                    _ => {
                        match change {
                            "account" => replacement.user_id = "user-2".into(),
                            "profile" => replacement.profile_id = "profile-2".into(),
                            "org" => replacement.organization_id = "org-2".into(),
                            "session" => replacement.access_token = "new-session-token".into(),
                            _ => unreachable!(),
                        }
                        account.set_context_for_test(Some(replacement));
                        // Keep target membership valid: each test must fail for
                        // the changed context field, not fixture membership loss.
                        account.set_memberships_for_test(&["org-1", "org-2"], false);
                    },
                }
                let error = handle.join().unwrap().unwrap_err();
                assert_eq!(error.code, "account_context_changed", "{change}, put={put}, rejected={rejected}");
                assert_eq!(error.requires_original_account_context, put);
                assert!(!request.join().unwrap().extra_request);
            }
        }
    }

    fn snapshot_body(error_code: Option<&str>) -> String {
        let mut value = json!({
            "workspace": {
                "id": "workspace-1", "orgId": "org-1", "name": "Product website",
                "provider": "machine0", "state": "provisioning", "accessMode": "private",
                "createdAt": 1, "updatedAt": 1
            },
            "operation": {
                "id": "operation-1", "workspaceId": "workspace-1", "type": "create",
                "state": "queued", "stage": "queued", "cancelable": true,
                "createdAt": 1, "updatedAt": 1
            },
            "ignoredProviderSdkField": { "raw": "must-not-cross" }
        });
        if let Some(error_code) = error_code {
            value["operation"]["errorCode"] = Value::String(error_code.into());
        }
        value.to_string()
    }

    #[test]
    fn phase2_workspace_ssh_registration_is_caller_scoped_and_held_by_default() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let mut public = vec![0, 0, 0, 11];
        public.extend(b"ssh-ed25519");
        public.extend([0, 0, 0, 32]);
        public.extend([9; 32]);
        let key = format!("ssh-ed25519 {}", STANDARD.encode(public));
        let (_, held) = test_service("http://127.0.0.1:1");
        assert_eq!(held.workspace_ssh_registration("org-1", "workspace-1", Some(&key)).unwrap_err().code, "cloud_workspace_ssh_unavailable");
        let (base, requests) = serve_each(vec![
            response("200 OK", "{}", ""),
            response("200 OK", "{}", ""),
        ]);
        let (_, ready) = phase2_service(&base);
        ready.workspace_ssh_registration("org-1", "workspace-1", Some(&key)).unwrap();
        ready.workspace_ssh_registration("org-1", "workspace-1", None).unwrap();
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("PUT /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/ssh-key HTTP/1.1"));
        assert!(requests[1].starts_with("DELETE /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/ssh-key HTTP/1.1"));
        for request in &requests { phase2_headers(request); }
        let body: Value = serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, json!({ "publicKey": key }));
        assert!(requests[1].split_once("\r\n\r\n").unwrap().1.is_empty());
    }

    fn phase2_service(base: &str) -> (Arc<AccountManager>, CloudWorkspaceService) {
        let (account, mut service) = test_service(base);
        service.force_phase2_for_test = true;
        (account, service)
    }

    fn phase2_headers(request: &str) {
        let request = request.to_ascii_lowercase();
        assert!(request.contains("authorization: bearer native-secret-token"));
        assert!(request.contains("x-terminalx-cloud-workspace-contract: providers-v1"));
        assert!(request.contains(&format!("x-terminalx-cloud-workspace-providers: {}", SUPPORTED_PROVIDERS)));
        assert!(request.contains("x-terminalx-cloud-workspace-lifecycle: archive-v1"));
    }

    fn phase2_details_body() -> Value {
        let snapshot: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        json!({"workspace": snapshot["workspace"], "details": {
            "organizationId": "org-1", "workspaceId": "workspace-1", "createdBy": "user-1", "provider": "machine0",
            "repositories": [{"identity": null, "fullName": null, "cloneUrl": "https://example.test/a.git", "ref": null, "targetDirectory": null, "primary": true}],
            "machineId": "machine-1", "environmentVersionId": "env-1",
            "environmentVersion": {"id": "env-1", "versionNumber": 7, "toolchainVersion": 12},
            "runtime": {"sha256": "artifact-sha", "protocol": 1, "installedAt": 1794657600123_i64},
            "provisioningLog": null
        }})
    }

    #[test]
    fn phase2_desktop_contract_production_activation_stays_held() {
        let (_, service) = test_service("http://127.0.0.1:9");
        assert!(!service.phase2_contracts_available());
        assert_eq!(service.inbox("0", 0).unwrap_err().code, "inbox_unavailable");
        assert_eq!(service.inbox_stream("0", None).unwrap_err().code, "inbox_unavailable");
        assert_eq!(service.inbox_receipts(vec!["1".into()]).unwrap_err().code, "inbox_unavailable");
        assert_eq!(service.read_marker("org-1", "workspace-1", None, "2026-11-14T12:00:00Z".into()).unwrap_err().code, "inbox_unavailable");
        assert_eq!(service.restart(None, "workspace-1").unwrap_err().code, "cloud_workspace_runtime_not_ready");
        assert_eq!(service.details(None, "workspace-1").unwrap_err().code, "cloud_workspace_runtime_not_ready");
    }

    #[test]
    fn phase2_desktop_contract_restart_exact_empty_body_queued_snapshot_and_existing_poll() {
        let mut body: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        body["operation"]["action"] = json!("restart");
        body["operation"]["cancelable"] = json!(false);
        body["operation"]["progress"] = json!({"phase": "starting", "retryAt": 1794657600123_i64});
        body["operation"]["checkpoint"] = json!("committed");
        body["operation"]["reason"] = json!("attention-stopped");
        body["operation"]["reasonDetail"] = json!("provider.runtime:unavailable");
        body["operation"]["logs"] = json!([{"source": "runtime", "content": "checkpoint saved", "occurredAt": 1794657600123_i64}]);
        body["workspace"]["runtime"] = json!({"sha256": "artifact", "protocol": 1, "installedAt": 1794657600123_i64});
        body["workspace"]["checkout"] = json!({"state": "ready", "repositories": [{"repository": "owner/repo", "state": "ready"}], "reportedAt": 1794657600123_i64});
        body["workspace"]["preparation"] = json!({"stopAfter": 1794657609999_i64});
        let queued = body.to_string();
        body["operation"]["state"] = json!("succeeded");
        let (base, requests) = serve_each(vec![response("202 Accepted", &queued, ""), response("200 OK", &body.to_string(), "")]);
        let (_, service) = phase2_service(&base);
        let snapshot = service.restart(Some("org-1"), "workspace-1").unwrap();
        let serialized = serde_json::to_value(snapshot).unwrap();
        assert_eq!(serialized["operation"]["state"], "queued");
        assert_eq!(serialized["operation"]["action"], "restart");
        assert_eq!(serialized["operation"]["type"], "create");
        assert_eq!(serialized["operation"]["cancelable"], false);
        assert_eq!(serialized["operation"]["checkpoint"], "committed");
        assert_eq!(serialized["operation"]["reason"], "attention-stopped");
        assert_eq!(serialized["operation"]["reasonDetail"], "provider.runtime:unavailable");
        assert_eq!(serialized["operation"]["logs"][0]["occurredAt"], 1794657600123_i64);
        assert_eq!(serialized["workspace"]["runtime"]["installedAt"], 1794657600123_i64);
        assert_eq!(serialized["workspace"]["checkout"]["state"], "ready");
        assert_eq!(serialized["workspace"]["preparation"]["stopAfter"], 1794657609999_i64);
        assert!(matches!(service.operation(None, "operation-1").unwrap().operation.state, OperationState::Succeeded));
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/restart HTTP/1.1"));
        assert_eq!(requests[0].split_once("\r\n\r\n").unwrap().1, "{}");
        assert!(requests[1].starts_with("GET /v1/desktop/orgs/org-1/cloud-workspace-operations/operation-1 HTTP/1.1"));
        for request in requests { phase2_headers(&request); }
    }

    #[test]
    fn phase2_desktop_contract_details_integer_versions_epoch_ms_and_no_body() {
        let body = phase2_details_body();
        let (base, requests) = serve_each(vec![response("200 OK", &body.to_string(), "Cache-Control: no-store\r\n")]);
        let (_, service) = phase2_service(&base);
        let details = service.details(None, "workspace-1").unwrap();
        let environment = details.details.environment_version.unwrap();
        assert_eq!((environment.version_number, environment.toolchain_version), (7, 12));
        assert_eq!(details.details.runtime.unwrap().installed_at, 1794657600123);
        assert!(details.details.provisioning_log.is_none());
        let request = &requests.join().unwrap()[0];
        assert!(request.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/details HTTP/1.1"));
        assert_eq!(request.split_once("\r\n\r\n").unwrap().1, "");
        phase2_headers(request);
        for field in ["toolchainVersion", "versionNumber"] {
            for wrong in [json!("12"), json!(1.5)] {
                let mut bad = body.clone();
                bad["details"]["environmentVersion"][field] = wrong;
                assert!(serde_json::from_value::<CloudWorkspaceDetailsResponse>(bad).is_err());
            }
        }
    }

    #[test]
    fn phase2_desktop_contract_restart_details_keep_membership_and_existing_errors() {
        for code in ["cloud_workspace_manager_required", "cloud_workspace_runtime_unsupported", "cloud_workspace_runtime_not_ready", "cloud_workspace_member_concurrency_exceeded", "cloud_preparation_workspace_expired"] {
            assert!(known_error_code(code));
        }

        let (account, service) = phase2_service("http://127.0.0.1:9");
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.restart(Some("org-3"), "workspace-1").unwrap_err().code, "cloud_organization_unavailable");
        assert_eq!(service.details(Some("org-3"), "workspace-1").unwrap_err().code, "cloud_organization_unavailable");
        for (status, code) in [("401 Unauthorized", "invalid_access_token"), ("403 Forbidden", "cloud_workspace_manager_required"), ("404 Not Found", "cloud_workspace_not_found"), ("409 Conflict", "cloud_workspace_operation_in_progress"), ("422 Unprocessable Entity", "cloud_workspace_request_invalid"), ("503 Service Unavailable", "cloud_provider_unavailable")] {
            let (base, requests) = serve_each(vec![response(status, &json!({"error": code}).to_string(), "")]);
            let (_, service) = phase2_service(&base);
            assert_eq!(service.restart(None, "workspace-1").unwrap_err().code, code);
            requests.join().unwrap();
        }
    }

    #[test]
    fn phase2_desktop_contract_restart_details_allow_inactive_member_org() {
        let mut details = phase2_details_body();
        details["workspace"]["orgId"] = json!("org-2");
        details["details"]["organizationId"] = json!("org-2");
        let mut snapshot: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        snapshot["workspace"]["orgId"] = json!("org-2");
        snapshot["operation"]["action"] = json!("restart");
        snapshot["operation"]["cancelable"] = json!(false);
        let (base, requests) = serve_each(vec![response("200 OK", &details.to_string(), ""), response("202 Accepted", &snapshot.to_string(), ""), response("200 OK", &snapshot.to_string(), "")]);
        let (account, service) = phase2_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], false);
        assert_eq!(service.details(Some("org-2"), "workspace-1").unwrap().workspace.org_id, "org-2");
        assert_eq!(service.restart(Some("org-2"), "workspace-1").unwrap().workspace.org_id, "org-2");
        assert_eq!(service.operation(Some("org-2"), "operation-1").unwrap().workspace.org_id, "org-2");
        for request in requests.join().unwrap() {
            assert!(request.contains("/v1/desktop/orgs/org-2/"));
            phase2_headers(&request);
        }
    }

    #[test]
    fn phase2_desktop_contract_inbox_account_route_bigint_filtered_page_receipts_and_revoke() {
        let id = "9223372036854775807";
        let body = json!({"v":1,"cursor":id,"hasMore":true,"events":[{"id":id,"type":"workspace.share-removed","workspaceId":"workspace-1","createdAt":"2026-11-14T12:00:00Z","organizationId":"must-drop","payload":{"private":"must-drop"}}]});
        let (base, requests) = serve_each(vec![response("200 OK", &body.to_string(), ""), response("200 OK", r#"{"acknowledged":true}"#, ""), response("200 OK", &json!({"v":1,"cursor":id,"hasMore":true,"events":[]}).to_string(), "")]);
        let (account, service) = phase2_service(&base);
        account.set_active_org_for_test("");
        let page = service.inbox("0", 25000).unwrap();
        assert_eq!(page.cursor, id);
        assert!(page.has_more);
        let event = serde_json::to_value(&page.events[0]).unwrap();
        assert!(event.get("organizationId").is_none() && event.get("payload").is_none());
        assert!(service.inbox_receipts(vec![id.into()]).unwrap().acknowledged);
        let filtered = service.inbox(id, 0).unwrap();
        assert!(filtered.has_more && filtered.events.is_empty());
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/desktop/organization-inbox?after=0&waitMs=25000&presence=1&mentions=1&nudges=1 HTTP/1.1"));
        assert!(requests[1].starts_with("POST /v1/desktop/organization-inbox/receipts HTTP/1.1"));
        assert_eq!(serde_json::from_str::<Value>(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap(), json!({"eventIds":[id]}));
        for request in requests { phase2_headers(&request); assert!(!request.contains("userId")); }
    }

    #[test]
    fn phase2_desktop_contract_read_marker_inactive_member_iso_and_real_session_id() {
        let timestamp = "2026-11-14T12:00:00.000Z";
        let (base, requests) = serve_each(vec![response("200 OK", &json!({"sessionId":"runtime.session:1@host","readAt":timestamp}).to_string(), ""), response("200 OK", &json!({"sessionId":"","readAt":timestamp}).to_string(), "")]);
        let (account, service) = phase2_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], false);
        assert_eq!(service.read_marker("org-2", "workspace-1", Some("runtime.session:1@host".into()), timestamp.into()).unwrap().read_at, timestamp);
        service.read_marker("org-2", "workspace-1", None, timestamp.into()).unwrap();
        assert_eq!(service.read_marker("org-3", "workspace-1", None, timestamp.into()).unwrap_err().code, "cloud_organization_unavailable");
        let requests = requests.join().unwrap();
        for request in &requests {
            assert!(request.starts_with("PUT /v1/desktop/orgs/org-2/cloud-workspaces/workspace-1/read-marker HTTP/1.1")); phase2_headers(request);
        }
        let workspace_body: Value = serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(workspace_body, json!({"readAt":timestamp}));
    }

    #[test]
    fn phase2_desktop_contract_sse_checkpoint_last_event_id_and_poll_fallback() {
        let sse = "event: inbox\nid: 9007199254740993\ndata: {\"id\":\"9007199254740993\",\"type\":\"workspace.share-removed\",\"workspaceId\":\"workspace-1\",\"createdAt\":\"2026-11-14T12:00:00Z\"}\n\nevent: checkpoint\nid: 9007199254740994\ndata: {\"cursor\":\"9007199254740994\"}\n\n";
        let (base, requests) = serve_each(vec![response("200 OK", sse, "Content-Type: text/event-stream\r\n"), response("200 OK", "event: inbox\nid: 2\n", "Content-Type: text/event-stream\r\n"), response("200 OK", r#"{"v":1,"cursor":"9007199254740994","hasMore":false,"events":[]}"#, "")]);
        let (_, service) = phase2_service(&base);
        let page = service.inbox_stream("0", Some("9007199254740992")).unwrap();
        assert_eq!(page.cursor, "9007199254740994"); assert_eq!(page.events.len(), 1);
        assert!(service.inbox_stream(&page.cursor, None).is_err());
        assert_eq!(service.inbox(&page.cursor, 0).unwrap().cursor, page.cursor);
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/desktop/organization-inbox/stream?after=0&presence=1&mentions=1&nudges=1 HTTP/1.1"));
        assert!(requests[0].to_ascii_lowercase().contains("last-event-id: 9007199254740992"));
        assert!(requests[2].contains("after=9007199254740994"));
        for request in requests { phase2_headers(&request); }
    }

    #[test]
    fn phase2_desktop_contract_non_machine0_details_and_response_scope_validation() {
        for provider in ["box", "hetzner"] {
            let mut body = phase2_details_body();
            body["workspace"]["provider"] = json!(provider);
            body["details"]["provider"] = json!(provider);
            let (base, requests) = serve_each(vec![response("200 OK", &body.to_string(), "")]);
            let (_, service) = phase2_service(&base);
            assert_eq!(service.details(None, "workspace-1").unwrap().details.provider, provider);
            phase2_headers(&requests.join().unwrap()[0]);
        }
        let mut body = phase2_details_body();
        body["details"]["organizationId"] = json!("other-org");
        let (base, requests) = serve_each(vec![response("200 OK", &body.to_string(), "")]);
        let (_, service) = phase2_service(&base);
        assert_eq!(service.details(None, "workspace-1").unwrap_err().code, "cloud_workspace_invalid_response");
        requests.join().unwrap();
    }

    #[test]
    fn phase2_desktop_contract_inbox_auth_and_late_account_membership_fences() {
        let (base, requests) = serve_each(vec![response("401 Unauthorized", r#"{"error":"invalid_access_token"}"#, "")]);
        let (_, service) = phase2_service(&base);
        let error = service.inbox("0", 0).unwrap_err();
        assert_eq!(error.code, "invalid_access_token"); assert!(!error.retryable);
        requests.join().unwrap();
        for replace_account in [false, true] {
            let (base, accepted, request) = serve_once(response("200 OK", r#"{"v":1,"cursor":"0","hasMore":false,"events":[]}"#, ""), Duration::from_millis(150));
            let (account, service) = phase2_service(&base);
            account.set_memberships_for_test(&["org-1", "org-2"], false);
            let pending = thread::spawn(move || service.inbox("0", 0));
            accepted.recv_timeout(Duration::from_secs(2)).unwrap();
            if replace_account { account.set_context_for_test(None); }
            else { account.set_memberships_for_test(&["org-1"], false); }
            assert!(pending.join().unwrap().is_err());
            request.join().unwrap();
        }
    }

    #[test]
    fn phase2_desktop_contract_validation_unavailable_and_catalog_marker_types() {
        let (_, service) = phase2_service("http://127.0.0.1:9");
        for invalid in ["", "01", "-1", "1.0", "9223372036854775808"] {
            assert_eq!(service.inbox(invalid, 0).unwrap_err().code, "cloud_workspace_request_invalid");
        }
        assert!(service.inbox("0", 25001).is_err());
        assert!(service.inbox_receipts(vec![]).is_err());
        assert!(service.inbox_receipts(vec!["1".into(); 101]).is_err());
        assert!(serde_json::from_value::<crate::desktop_inbox::InboxPage>(json!({"v":1,"cursor":1,"hasMore":false,"events":[]})).is_err());
        let (base, requests) = serve_each(vec![response("503 Service Unavailable", r#"{"error":"inbox_unavailable"}"#, "")]);
        let (_, service) = phase2_service(&base);
        let error = service.inbox("0", 0).unwrap_err();
        assert_eq!(error.code, "inbox_unavailable"); assert!(error.retryable);
        requests.join().unwrap();
        let snapshot: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        let item: CloudWorkspaceListItem = serde_json::from_value(json!({"workspace":snapshot["workspace"],"readMarkers":[{"sessionId":"","readAt":"2026-11-14T12:00:00.000Z"}]})).unwrap();
        assert_eq!(serde_json::to_value(item).unwrap()["readMarkers"][0]["readAt"], "2026-11-14T12:00:00.000Z");
    }

    #[test]
    fn phase2_desktop_contract_marker_and_details_restart_discard_late_scope_changes() {
        for route in ["read-marker", "details", "restart"] {
            let body = match route {
                "read-marker" => json!({"sessionId":"", "readAt":"2026-11-14T12:00:00Z"}).to_string(),
                "details" => phase2_details_body().to_string(),
                _ => {
                    let mut body: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
                    body["operation"]["action"] = json!("restart");
                    body["operation"]["cancelable"] = json!(false);
                    body.to_string()
                }
            };
            let (base, accepted, request) = serve_once(response("200 OK", &body, ""), Duration::from_millis(150));
            let (account, service) = phase2_service(&base);
            account.set_memberships_for_test(&["org-1", "org-2"], true);
            let pending = thread::spawn(move || match route {
                "read-marker" => service.read_marker("org-2", "workspace-1", None, "2026-11-14T12:00:00Z".into()).map(|_| ()),
                "details" => service.details(None, "workspace-1").map(|_| ()),
                _ => service.restart(None, "workspace-1").map(|_| ()),
            });
            accepted.recv_timeout(Duration::from_secs(2)).unwrap();
            if route == "read-marker" {
                account.set_memberships_for_test(&["org-1"], true);
            } else {
                account.set_active_org_for_test("org-2");
                account.set_memberships_for_test(&["org-2"], true);
            }
            assert!(pending.join().unwrap().is_err(), "discard late {route} response");
            phase2_headers(&request.join().unwrap().text);
        }
    }

    fn org_2_list_body() -> String {
        let mut snapshot: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        snapshot["workspace"]["orgId"] = json!("org-2");
        json!({ "workspaces": [{ "workspace": snapshot["workspace"], "latestOperation": snapshot["operation"] }] }).to_string()
    }

    #[test]
    fn a_member_organization_is_listed_by_its_own_path_only_with_the_capability() {
        // An older server: another Organization is refused before any request.
        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.workspaces(Some("org-2")).unwrap_err().code, "cloud_organization_unavailable");

        // CS-18: a member Organization, by its own path; the active one is not consulted.
        let (base, _, request) = serve_once(response("200 OK", &org_2_list_body(), ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.workspaces(Some("org-2")).unwrap().workspaces[0].workspace.org_id, "org-2");
        assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-2/cloud-workspaces HTTP/1.1"));

        // Never an Organization the user is not a member of.
        assert_eq!(service.workspaces(Some("org-3")).unwrap_err().code, "cloud_organization_unavailable");
    }

    #[test]
    fn a_default_organization_change_does_not_fence_a_member_organizations_answer() {
        let (base, accepted, request) = serve_once(response("200 OK", &org_2_list_body(), ""), Duration::from_millis(150));
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        let service = Arc::new(service);
        let listing = { let service = service.clone(); thread::spawn(move || service.workspaces(Some("org-2"))) };
        accepted.recv_timeout(Duration::from_secs(2)).unwrap();
        // Another client makes org-2 the default while the list is in flight.
        account.set_active_org_for_test("org-2");
        assert!(listing.join().unwrap().is_ok(), "the answer is still for a member organization");
        request.join().unwrap();

        // Losing the membership mid-flight fences it.
        let (base, accepted, request) = serve_once(response("200 OK", &org_2_list_body(), ""), Duration::from_millis(150));
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        let service = Arc::new(service);
        let listing = { let service = service.clone(); thread::spawn(move || service.workspaces(Some("org-2"))) };
        accepted.recv_timeout(Duration::from_secs(2)).unwrap();
        account.set_memberships_for_test(&["org-1"], true);
        assert!(listing.join().unwrap().is_err(), "an answer for an organization the user left never lands");
        request.join().unwrap();
    }

    fn feed_service(base: &str, organizations: &[&str]) -> (Arc<AccountManager>, Arc<CloudWorkspaceService>) {
        let (account, service) = test_service(base);
        account.set_memberships_for_test(organizations, true);
        account.set_catalog_feed_for_test(true);
        (account, Arc::new(service))
    }

    fn feed_item(org: &str, id: &str) -> Value {
        let snapshot: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        let mut workspace = snapshot["workspace"].clone();
        workspace["orgId"] = json!(org);
        workspace["id"] = json!(id);
        let mut operation = snapshot["operation"].clone();
        operation["workspaceId"] = json!(id);
        json!({ "workspace": workspace, "latestOperation": operation })
    }

    fn feed_body(organizations: Value) -> String {
        json!({ "v": 1, "cursor": "cursor-2", "reset": true, "organizations": organizations, "deletedWorkspaceIds": ["gone-1", "never-listed"] }).to_string()
    }

    #[test]
    fn phase2_presence_catalog_exact_projection_optin_and_independent_following() {
        for enabled in [false, true] {
            let mut item = feed_item("org-1", "workspace-1");
            item["following"] = json!(true);
            if enabled {
                item["workspace"]["createdBy"] = json!("user-1");
                item["workspace"]["creator"] = json!({"userId":"user-1","displayName":"Current owner","photoUrl":null});
                item["presence"] = json!({"activeMembers":[{"userId":"user-2","displayName":null,"photoUrl":null}]});
            }
            let mut organization = json!({"orgId":"org-1","workspaces":[item]});
            if enabled { organization["presence"] = json!({"activeMembers":[{"userId":"user-2","displayName":null,"photoUrl":null}]}); }
            let (base, _, request) = serve_once(response("200 OK", &feed_body(json!([organization])), ""), Duration::ZERO);
            let (account, mut service) = test_service(&base);
            account.set_memberships_for_test(&["org-1"], true);
            account.set_catalog_feed_for_test(true);
            service.force_phase2_for_test = enabled;
            let feed = service.catalog_feed(Some("cursor-1")).unwrap();
            assert_eq!(feed.viewer_user_id, "user-1");
            let item = &feed.organizations[0].workspaces[0];
            assert_eq!(item.following, Some(true));
            assert_eq!(item.presence.is_some(), enabled);
            assert_eq!(feed.organizations[0].presence.is_some(), enabled);
            let projection = serde_json::to_value(item).unwrap();
            assert!(projection["workspace"].get("creatorPerson").is_none());
            if enabled { assert_eq!(projection["workspace"]["creator"]["displayName"], "Current owner"); }
            let request = request.join().unwrap().text;
            assert_eq!(request.contains("presence=1"), enabled);
            assert!(request.to_ascii_lowercase().contains("if-none-match: \"cursor-1\""));
            phase2_headers(&request);
        }
    }

    #[test]
    fn phase2_presence_catalog_strips_presence_only_in_organizations_without_readiness() {
        let presence = json!({"activeMembers":[{"userId":"user-2","displayName":null,"photoUrl":null}]});
        let organization = |org, workspace| {
            let mut item = feed_item(org, workspace);
            item["presence"] = presence.clone();
            item["following"] = json!(true);
            json!({"orgId":org,"workspaces":[item],"presence":presence})
        };
        let body = feed_body(json!([organization("org-1", "workspace-1"), organization("org-2", "workspace-2")]));
        let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
        let (account, service) = feed_service(&base, &["org-1", "org-2"]);
        account.apply_phase2_readiness_for_test(json!({
            "version": 1,
            "organizations": {
                "org-1": { (PHASE2_PRESENCE): true },
                "org-2": { (PHASE2_PRESENCE): false, (PHASE2_FOLLOW_REASSIGN): true }
            }
        }));

        let feed = service.catalog_feed(None).unwrap();
        assert_eq!(feed.organizations.len(), 2);
        for (org, enabled) in feed.organizations.iter().zip([true, false]) {
            assert_eq!(org.org_id, if enabled { "org-1" } else { "org-2" });
            assert_eq!(org.presence.is_some(), enabled);
            assert_eq!(org.workspaces.len(), 1);
            assert_eq!(org.workspaces[0].presence.is_some(), enabled);
            assert_eq!(org.workspaces[0].following, Some(true));
        }
        assert!(request.join().unwrap().text.contains("presence=1"));
    }

    #[test]
    fn the_catalog_feed_is_only_asked_of_a_server_that_offers_it() {
        // Nothing listens here: a request would fail differently.
        let (account, service) = test_service("http://127.0.0.1:9");
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.catalog_feed(None).unwrap_err().code, "cloud_catalog_feed_unavailable");
        // The feed spans Organizations: without membership authorization it is not used either.
        account.set_catalog_feed_for_test(true);
        account.set_memberships_for_test(&["org-1", "org-2"], false);
        assert_eq!(service.catalog_feed(None).unwrap_err().code, "cloud_catalog_feed_unavailable");
        account.set_context_for_test(None);
        assert_eq!(service.catalog_feed(None).unwrap_err().code, "account_signed_out");
    }

    #[test]
    fn the_catalog_feed_sends_its_cursor_and_reads_304_as_unchanged() {
        let (base, _, request) = serve_once(response("304 Not Modified", "", "ETag: \"cursor-1\"\r\n"), Duration::ZERO);
        let (_, service) = feed_service(&base, &["org-1", "org-2"]);
        let feed = service.catalog_feed(Some("cursor-1")).unwrap();
        assert!(!feed.changed);
        assert_eq!(feed.cursor.as_deref(), Some("cursor-1"));
        assert!(feed.organizations.is_empty());
        let request = request.join().unwrap().text;
        assert!(request.starts_with("GET /v1/desktop/cloud-catalog HTTP/1.1"), "{request}");
        assert!(request.to_ascii_lowercase().contains("if-none-match: \"cursor-1\""), "{request}");
        assert!(request.contains("native-secret-token"));

        // A cursor that is not a plain token is never put in a header.
        let (base, _, request) = serve_once(response("200 OK", &feed_body(json!([])), ""), Duration::ZERO);
        let (_, service) = feed_service(&base, &["org-1"]);
        assert!(service.catalog_feed(Some("bad\r\nX-Injected: 1")).unwrap().changed);
        let request = request.join().unwrap().text.to_ascii_lowercase();
        assert!(!request.contains("if-none-match") && !request.contains("x-injected"), "{request}");
    }

    #[test]
    fn the_catalog_feed_keeps_only_member_organizations_and_valid_lists() {
        let body = feed_body(json!([
            { "orgId": "org-1", "workspaces": [feed_item("org-1", "ws-1")], "tombstones": [{ "id": "gone-1", "orgId": "org-1", "deletedAt": 1, "expiresAt": 2 }], "quota": { "used": 1, "limit": 2 } },
            // A list that names another Organization's workspace is not shown; the others are.
            { "orgId": "org-2", "workspaces": [feed_item("org-1", "ws-2")], "tombstones": [] },
            // Not a member: dropped, whatever the server sent.
            { "orgId": "org-9", "workspaces": [feed_item("org-9", "ws-9")], "tombstones": [] },
            { "orgId": "org-3", "error": "cloud_provider_unavailable" },
            { "orgId": "org-4", "error": "<script>" },
            // The same Organization twice: the first answer stands.
            { "orgId": "org-1", "workspaces": [], "tombstones": [] }
        ]));
        let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
        let (_, service) = feed_service(&base, &["org-1", "org-2", "org-3", "org-4"]);
        let feed = service.catalog_feed(None).unwrap();
        request.join().unwrap();
        assert!(feed.changed && feed.reset);
        assert_eq!(feed.cursor.as_deref(), Some("cursor-2"));
        let summary: Vec<(String, usize, Option<String>)> = feed.organizations.iter().map(|org| (org.org_id.clone(), org.workspaces.len(), org.error.clone())).collect();
        assert_eq!(
            summary,
            vec![
                ("org-1".to_string(), 1, None),
                ("org-2".to_string(), 0, Some("cloud_workspace_invalid_response".to_string())),
                ("org-3".to_string(), 0, Some("cloud_provider_unavailable".to_string())),
                ("org-4".to_string(), 0, Some("cloud_workspace_unknown_error".to_string())),
            ]
        );
        assert_eq!(feed.organizations[0].quota.as_ref().map(|quota| (quota.used, quota.limit)), Some((1, Some(2))));
        // In a whole catalog, a deleted id counts only with a tombstone this desktop was shown.
        assert_eq!(feed.deleted_workspace_ids, vec!["gone-1".to_string()]);
        let text = serde_json::to_string(&feed).unwrap();
        assert!(!text.contains("org-9") && !text.contains("ws-9") && !text.contains("<script>"), "{text}");
    }

    #[test]
    fn a_catalog_feed_answer_is_fenced_by_the_account_and_by_membership_as_of_the_answer() {
        let body = feed_body(json!([
            { "orgId": "org-1", "workspaces": [feed_item("org-1", "ws-1")], "tombstones": [] },
            { "orgId": "org-2", "workspaces": [feed_item("org-2", "ws-2")], "tombstones": [] }
        ]));
        // The membership in org-2 ends while the request is in flight.
        let (base, accepted, request) = serve_once(response("200 OK", &body, ""), Duration::from_millis(150));
        let (account, service) = feed_service(&base, &["org-1", "org-2"]);
        let asking = { let service = service.clone(); thread::spawn(move || service.catalog_feed(None)) };
        accepted.recv_timeout(Duration::from_secs(2)).unwrap();
        account.set_memberships_for_test(&["org-1"], true);
        let feed = asking.join().unwrap().unwrap();
        request.join().unwrap();
        assert_eq!(feed.organizations.iter().map(|org| org.org_id.as_str()).collect::<Vec<_>>(), vec!["org-1"]);

        // A change of the default Organization fences nothing.
        let (base, accepted, request) = serve_once(response("200 OK", &body, ""), Duration::from_millis(150));
        let (account, service) = feed_service(&base, &["org-1", "org-2"]);
        let asking = { let service = service.clone(); thread::spawn(move || service.catalog_feed(None)) };
        accepted.recv_timeout(Duration::from_secs(2)).unwrap();
        account.set_active_org_for_test("org-2");
        assert_eq!(asking.join().unwrap().unwrap().organizations.len(), 2);
        request.join().unwrap();

        // Signed out meanwhile: nothing of the answer lands.
        let (base, accepted, request) = serve_once(response("200 OK", &body, ""), Duration::from_millis(150));
        let (account, service) = feed_service(&base, &["org-1", "org-2"]);
        let asking = { let service = service.clone(); thread::spawn(move || service.catalog_feed(None)) };
        accepted.recv_timeout(Duration::from_secs(2)).unwrap();
        account.set_context_for_test(None);
        assert_eq!(asking.join().unwrap().unwrap_err().code, "account_context_changed");
        request.join().unwrap();
    }

    #[test]
    fn a_catalog_feed_failure_is_an_error_and_never_an_empty_catalog() {
        for (status, body, code) in [("503 Service Unavailable", r#"{"error":"cloud_provider_unavailable"}"#, "cloud_provider_unavailable"), ("200 OK", "not json", "cloud_workspace_invalid_response"), ("302 Found", "", "cloud_workspace_invalid_response")] {
            let (base, _, request) = serve_once(response(status, body, ""), Duration::ZERO);
            let (_, service) = feed_service(&base, &["org-1"]);
            assert_eq!(service.catalog_feed(Some("cursor-1")).unwrap_err().code, code, "{status}");
            request.join().unwrap();
        }
    }

    #[test]
    fn provider_error_code_passes_only_as_a_safe_token() {
        let parse = |code: Value| {
            let mut value: Value = serde_json::from_str(&snapshot_body(Some("cloud_provider_credential_invalid"))).unwrap();
            value["operation"]["providerErrorCode"] = code;
            serde_json::from_value::<CloudWorkspaceSnapshot>(value).unwrap().operation.provider_error_code
        };
        assert_eq!(parse(json!("permission_denied")).as_deref(), Some("permission_denied"));
        assert_eq!(parse(json!("box.forbidden:403")).as_deref(), Some("box.forbidden:403"));
        assert_eq!(parse(json!("Key sk-live-123 was rejected")), None);
        assert_eq!(parse(json!("-leading")), None);
        assert_eq!(parse(json!("a".repeat(65))), None);
        assert_eq!(parse(json!({ "raw": "body" })), None);
        assert_eq!(parse(Value::Null), None);
        for code in ["cloud_workspace_runtime_bootstrap_failed", "cloud_workspace_provisioning_timeout", "cloud_provider_permission_denied"] {
            let snapshot: CloudWorkspaceSnapshot = serde_json::from_str(&snapshot_body(Some(code))).unwrap();
            assert_eq!(snapshot.operation.error_code.as_deref(), Some(code));
        }
        let projected = serde_json::to_value(
            serde_json::from_str::<CloudWorkspaceSnapshot>(&snapshot_body(None)).unwrap(),
        )
        .unwrap();
        assert_eq!(projected["operation"]["providerErrorCode"], Value::Null);
    }

    // PRO-52: the detail code and the deletion's provider operation id reach the page, as tokens only.
    #[test]
    fn a_failed_delete_carries_its_detail_code_and_the_providers_operation_id() {
        let parse = |detail: Value, operation_id: Value| {
            let mut value: Value = serde_json::from_str(&snapshot_body(Some("cloud_provider_state_conflict"))).unwrap();
            value["operation"]["detailCode"] = detail;
            value["operation"]["cleanup"] = json!({ "complete": false, "items": [{ "kind": "provider-compute", "state": "unconfirmed", "providerOperationId": operation_id }] });
            let operation = serde_json::from_value::<CloudWorkspaceSnapshot>(value).unwrap().operation;
            (operation.detail_code, operation.cleanup.unwrap().items[0].provider_operation_id.clone())
        };
        assert_eq!(
            parse(json!("box_deleted_sandbox_present"), json!("op_01HZX-9f2c")),
            (Some("box_deleted_sandbox_present".into()), Some("op_01HZX-9f2c".into()))
        );
        assert_eq!(parse(json!("Boat said: sandbox still there"), json!("an id with spaces")), (None, None));
        assert_eq!(parse(json!("a".repeat(80)), json!("bdop_01HZX")).0, Some("a".repeat(80)));
        assert_eq!(parse(json!("a".repeat(81)), json!("bdop_01HZX")), (None, Some("bdop_01HZX".into())));
        assert_eq!(parse(json!("-leading"), json!("")), (None, None));
        assert_eq!(parse(Value::Null, json!({ "raw": "body" })), (None, None));
        // An older server sends neither, and nothing is invented for it.
        let old: CloudWorkspaceSnapshot = serde_json::from_str(&snapshot_body(Some("cloud_provider_permission_denied"))).unwrap();
        assert_eq!(old.operation.detail_code, None);
    }

    fn provider_id(id: &str) -> CloudWorkspaceProviderId {
        CloudWorkspaceProviderId::try_from(id.to_owned()).unwrap()
    }

    // PRO-415: which providers exist is the server's to say. The client reads
    // any id of the registry's shape, one it has never heard of included, and
    // refuses anything that could not go into a path segment as it is.
    #[test]
    fn a_provider_id_is_any_registry_shaped_string() {
        // Described providers first; the fixed ids only for a server without them.
        assert_eq!(SUPPORTED_PROVIDERS.split(',').next(), Some("described"));
        for name in SUPPORTED_PROVIDERS.split(',').skip(1) {
            assert!(serde_json::from_value::<CloudWorkspaceProviderId>(json!(name)).is_ok(), "{name}");
        }
        for name in ["hetzner", "acme-cloud", "0x", &"a".repeat(63)] {
            let parsed: CloudWorkspaceProviderId = serde_json::from_value(json!(name)).unwrap();
            assert_eq!(parsed.as_str(), name);
            assert_eq!(serde_json::to_value(&parsed).unwrap(), json!(name));
        }
        for name in ["", "Box", "-leading", "a/b", "a b", "a_b", "é", &"a".repeat(64)] {
            assert!(serde_json::from_value::<CloudWorkspaceProviderId>(json!(name)).is_err(), "{name:?}");
        }
    }

    // PRO-415: a described provider's descriptor reaches the webview whole,
    // fields this client does not type included; an older server's summary,
    // without one, still reads.
    #[test]
    fn provider_summaries_carry_their_descriptor() {
        let described: CloudProviderSummary = serde_json::from_value(json!({
            "id": "acme-cloud", "displayName": "Acme", "availability": "available", "canManage": true, "connection": null,
            "capabilities": { "suspend": true, "resume": true, "releaseDisposition": "destroyed", "locationSelection": "automatic", "sourceSelection": "optional", "pricing": "provider-rate" },
            "descriptor": {
                "id": "acme-cloud", "label": "Acme Cloud", "icon": "server", "order": 40, "listed": true,
                "credentialFields": [{ "name": "token", "kind": "secret", "label": "Acme token", "helpUrl": "https://acme.example/tokens" }],
                "capabilities": { "pauseResumeWithMemory": false, "stopStart": true, "snapshots": false, "exec": false, "computeRunsUntilStopped": false },
                "allowedRetentionDays": [7, 30], "somethingNew": { "kept": true }
            }
        }))
        .unwrap();
        assert_eq!(described.label(), "Acme Cloud");
        assert_eq!(described.credential_fields(), vec![CloudProviderCredentialField { name: "token".into(), kind: "secret".into(), label: "Acme token".into(), help_url: Some("https://acme.example/tokens".into()) }]);
        let projected = serde_json::to_value(&described).unwrap();
        assert_eq!(projected["descriptor"]["somethingNew"], json!({ "kept": true }));
        assert_eq!(projected["descriptor"]["allowedRetentionDays"], json!([7, 30]));
        assert_eq!(projected["descriptor"]["credentialFields"][0]["helpUrl"], json!("https://acme.example/tokens"));
        // A descriptor that does not say whose credential it is (a server older than platform providers) is an organization's.
        assert!(!described.platform_credential());
        assert_eq!(projected["descriptor"]["credentialSource"], json!("organization"));

        let older: CloudProviderSummary = serde_json::from_value(json!({
            "id": "box", "displayName": "Boat", "availability": "available", "canManage": true, "connection": null,
            "capabilities": { "suspend": true, "resume": true, "releaseDisposition": "destroyed", "locationSelection": "automatic", "sourceSelection": "optional", "pricing": "provider-rate" }
        }))
        .unwrap();
        assert!(older.descriptor.is_none());
        assert_eq!(older.label(), "Boat");
        assert_eq!(older.credential_fields().len(), 1);
        assert!(older.credential_fields()[0].secret());
        assert!(!older.platform_credential());
        assert_eq!(serde_json::to_value(&older).unwrap()["descriptor"], Value::Null);
    }

    // PRO-452: a provider that runs on TerminalX's own credential says so in
    // its descriptor and lists no credential fields. It reads beside the
    // organization ones, reaches the webview as `platform`, and asks for
    // nothing; anything but `platform` is an organization's.
    #[test]
    fn a_platform_provider_reads_with_no_credential_fields_and_asks_for_none() {
        let summary = |id: &str, descriptor: Value| json!({
            "id": id, "displayName": id, "availability": "available", "canManage": true, "connection": null,
            "capabilities": { "suspend": true, "resume": true, "releaseDisposition": "destroyed", "locationSelection": "required", "sourceSelection": "optional", "pricing": "provider-rate" },
            "descriptor": descriptor
        });
        let descriptor = |id: &str, label: &str, source: Value, fields: Value| {
            let mut described = json!({ "id": id, "label": label, "icon": "cloud", "order": 5, "listed": true, "billing": "Billed by TerminalX", "billedByProvider": false, "credentialFields": fields });
            if !source.is_null() {
                described["credentialSource"] = source;
            }
            described
        };
        let key = json!([{ "name": "credential", "kind": "secret", "label": "Acme token", "helpUrl": null }]);
        let list: CloudProviderSummaryResponse = serde_json::from_value(json!({ "providers": [
            summary("terminalx-cloud", descriptor("terminalx-cloud", "TerminalX Cloud", json!("platform"), json!([]))),
            summary("acme-cloud", descriptor("acme-cloud", "Acme Cloud", json!("organization"), key.clone())),
            summary("older-cloud", descriptor("older-cloud", "Older Cloud", Value::Null, key.clone())),
            summary("newer-cloud", descriptor("newer-cloud", "Newer Cloud", json!("something-new"), key.clone())),
            summary("odd-cloud", descriptor("odd-cloud", "Odd Cloud", json!(7), key.clone())),
        ] }))
        .unwrap();
        let [platform, organization, older, newer, odd] = list.providers.as_slice() else { panic!("five providers") };

        assert!(platform.platform_credential());
        assert_eq!(platform.label(), "TerminalX Cloud");
        // Not the one-key fallback of a descriptor without fields: there is nothing to ask for.
        assert!(platform.credential_fields().is_empty());
        let projected = serde_json::to_value(platform).unwrap();
        assert_eq!(projected["descriptor"]["credentialSource"], json!("platform"));
        assert_eq!(projected["descriptor"]["credentialFields"], json!([]));
        assert_eq!(projected["descriptor"]["billing"], json!("Billed by TerminalX"));
        assert_eq!(projected["availability"], json!("available"));
        assert_eq!(projected["connection"], Value::Null);

        for provider in [organization, older, newer, odd] {
            assert!(!provider.platform_credential(), "{}", provider.id);
            assert_eq!(provider.credential_fields().len(), 1, "{}", provider.id);
            assert_eq!(serde_json::to_value(provider).unwrap()["descriptor"]["credentialSource"], json!("organization"), "{}", provider.id);
        }

        // Even a platform descriptor that listed fields asks for none.
        let listed: CloudProviderSummary = serde_json::from_value(summary("terminalx-cloud", descriptor("terminalx-cloud", "TerminalX Cloud", json!("platform"), key))).unwrap();
        assert!(listed.credential_fields().is_empty());
    }

    #[test]
    fn sends_provider_contract_and_encodes_native_organization() {
        let body = r#"{"providers":[]}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let client = Client::for_test(&base, Duration::from_secs(2));
        let mut encoded_context = context();
        encoded_context.organization_id = "org/one".into();
        let _: CloudProviderSummaryResponse = client
            .request(
                &encoded_context,
                &["cloud-providers"],
                None,
                None,
                None,
                RequestRisk::Read,
            )
            .unwrap();
        let request = request.join().unwrap().text;
        assert!(request.starts_with("GET /v1/desktop/orgs/org%2Fone/cloud-providers HTTP/1.1"));
        let lower = request.to_ascii_lowercase();
        assert!(lower.contains("authorization: bearer native-secret-token"));
        assert!(lower.contains("x-terminalx-cloud-workspace-contract: providers-v1"));
        assert!(lower.contains("x-terminalx-cloud-workspace-providers: described,machine0,box,hetzner\r\n"));
    }

    #[test]
    fn provider_detail_uses_connection_dto_and_fixed_path() {
        let body =
            r#"{"provider":"box","state":"not-connected","canManage":false,"ignored":"drop"}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let detail = service.provider(provider_id("box")).unwrap();
        let captured = request.join().unwrap();
        assert_eq!(detail.provider, provider_id("box"));
        assert!(matches!(
            detail.state,
            CloudProviderConnectionState::NotConnected
        ));
        assert!(!detail.can_manage);
        assert!(captured
            .text
            .starts_with("GET /v1/desktop/orgs/org-1/cloud-providers/box HTTP/1.1"));
    }

    // PRO-111, PRO-415: the key dialog names the provider and asks for its
    // credential as the organization's list describes it.
    #[test]
    fn provider_summary_for_the_dialog_comes_from_the_organization_list() {
        let summary = |id: &str, name: &str, descriptor: Value| json!({ "id": id, "displayName": name, "availability": "available", "canManage": true, "connection": null, "capabilities": { "suspend": true, "resume": true, "releaseDisposition": "destroyed", "locationSelection": "automatic", "sourceSelection": "optional", "pricing": "provider-rate" }, "descriptor": descriptor });
        let fields = json!([{ "name": "account", "kind": "text", "label": "Account id" }, { "name": "secret", "kind": "secret", "label": "Secret key" }]);
        let body = json!({ "providers": [
            summary("box", "Boat", Value::Null),
            summary("acme-cloud", "Acme", json!({ "id": "acme-cloud", "label": "Acme Cloud (test)", "icon": "cloud", "order": 90, "credentialFields": fields })),
        ] })
        .to_string();
        let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let authorization = ProviderConnectAuthorization { context: context(), provider: provider_id("acme-cloud") };
        let found = service.provider_summary(&authorization).unwrap();
        assert_eq!(found.label(), "Acme Cloud (test)");
        let asked: Vec<(String, bool)> = found.credential_fields().into_iter().map(|field| (field.name.clone(), field.secret())).collect();
        assert_eq!(asked, vec![("account".into(), false), ("secret".into(), true)]);
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-providers HTTP/1.1"));
        assert!(!captured.extra_request);

        // Not listed, or no list: nothing, and the dialog falls back to the provider's id and one key.
        let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let authorization = ProviderConnectAuthorization { context: context(), provider: provider_id("hetzner") };
        assert!(service.provider_summary(&authorization).is_none());
        request.join().unwrap();
        let (base, _, request) = serve_once(response("503 Service Unavailable", "{}", ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert!(service.provider_summary(&authorization).is_none());
        request.join().unwrap();
    }

    // PRO-452: connecting a provider TerminalX itself provides is refused
    // from the organization's list, before a dialog could ask for a key; an
    // organization's provider, and one the list does not name, go on.
    #[test]
    fn a_platform_provider_is_never_connected() {
        let summary = |id: &str, source: &str, fields: Value| json!({ "id": id, "displayName": id, "availability": "available", "canManage": true, "connection": null, "capabilities": { "suspend": true, "resume": true, "releaseDisposition": "destroyed", "locationSelection": "automatic", "sourceSelection": "optional", "pricing": "provider-rate" }, "descriptor": { "id": id, "label": id, "icon": "cloud", "order": 5, "credentialSource": source, "credentialFields": fields } });
        let body = json!({ "providers": [
            summary("terminalx-cloud", "platform", json!([])),
            summary("acme-cloud", "organization", json!([{ "name": "credential", "kind": "secret", "label": "Acme token" }])),
        ] })
        .to_string();
        let connectable = |provider: &str| {
            let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let authorization = ProviderConnectAuthorization { context: context(), provider: provider_id(provider) };
            let result = service.connectable_provider_summary(&authorization);
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-providers HTTP/1.1"));
            // Reading the list is all that happened: nothing was sent to connect.
            assert!(!captured.extra_request);
            result
        };
        let refused = connectable("terminalx-cloud").unwrap_err();
        assert_eq!((refused.code.as_str(), refused.status, refused.retryable), ("cloud_provider_disabled", None, false));
        assert_eq!(connectable("acme-cloud").unwrap().unwrap().credential_fields().len(), 1);
        assert!(connectable("hetzner").unwrap().is_none());
    }

    #[test]
    fn provider_disconnect_projects_safe_metadata_and_uses_existing_endpoint() {
        let body = r#"{"provider":"box","state":"attention-required","canManage":true,"credentialVersion":4,"providerAccount":"Original account","operationsBlocked":true,"disconnectDisposition":"destroy","resources":[],"credentialCiphertext":"must-not-cross","credential":"must-not-cross"}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let client = Client::for_test(&base, Duration::from_secs(2));
        let result: CloudProviderConnectionResponse = client.request(&context(), &["cloud-providers", "box", "disconnect"], None, Some(json!({"disposition": DisconnectDisposition::Destroy})), None, RequestRisk::Mutation).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-providers/box/disconnect HTTP/1.1"));
        assert_eq!(serde_json::from_str::<Value>(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap(), json!({"disposition":"destroy"}));
        let projected = serde_json::to_value(result).unwrap();
        assert_eq!(projected["credentialVersion"], 4);
        assert_eq!(projected["providerAccount"], "Original account");
        assert!(!projected.to_string().contains("must-not-cross"));
        assert!(!captured.extra_request);
    }

    // PRO-79: the "new machines" switch and the key re-check, from the desktop.
    #[test]
    fn provider_creation_switch_and_recheck_use_their_endpoints_and_project_safe_metadata() {
        let summary = r#"{"id":"box","displayName":"Boat","availability":"disabled-for-create","canManage":true,"connection":null,"capabilities":{"suspend":true,"resume":true,"releaseDisposition":"archived","locationSelection":"automatic","sourceSelection":"optional","pricing":"provider-rate"},"credential":"must-not-cross"}"#;
        let (base, _, request) = serve_once(response("200 OK", summary, ""), Duration::ZERO);
        let client = Client::for_test(&base, Duration::from_secs(2));
        let result: CloudProviderSummary = client
            .request(&context(), &["cloud-providers", "box", "settings"], None, Some(json!({ "enabledForCreate": false, "configurationVersion": 1, "configuration": {} })), None, RequestRisk::Mutation)
            .unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-providers/box/settings HTTP/1.1"));
        assert_eq!(
            serde_json::from_str::<Value>(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            json!({ "enabledForCreate": false, "configurationVersion": 1, "configuration": {} })
        );
        let projected = serde_json::to_value(result).unwrap();
        assert_eq!(projected["availability"], "disabled-for-create");
        assert!(!projected.to_string().contains("must-not-cross"));

        let body = r#"{"provider":"box","state":"connected","canManage":true,"credentialVersion":4,"lastValidatedAt":1790000000000,"credential":"must-not-cross"}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let client = Client::for_test(&base, Duration::from_secs(2));
        let result: CloudProviderConnectionResponse = client.request(&context(), &["cloud-providers", "box", "revalidate"], None, Some(json!({})), None, RequestRisk::Mutation).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-providers/box/revalidate HTTP/1.1"));
        assert_eq!(serde_json::from_str::<Value>(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap(), json!({}));
        assert!(!serde_json::to_value(result).unwrap().to_string().contains("must-not-cross"));
    }

    #[test]
    fn provider_creation_switch_and_recheck_deny_members_and_stale_organizations_before_any_mutation() {
        type Call = fn(&CloudWorkspaceService, String) -> Option<CloudWorkspaceClientError>;
        let calls: [Call; 2] = [
            |service, revision| service.set_provider_creation_enabled(provider_id("box"), revision, false).err(),
            |service, revision| service.revalidate_provider(provider_id("box"), revision).err(),
        ];
        for call in calls {
            // A member: the read says so, and nothing is posted.
            let (base, _, request) = serve_once(response("200 OK", r#"{"provider":"box","state":"connected","canManage":false}"#, ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            assert_eq!(call(&service, AccountManager::context_revision(&context())).unwrap().code, "organization_admin_required");
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with("GET ") && !captured.extra_request);

            // Asked for another organization than the one now active.
            let (base, _, request) = serve_once(response("200 OK", r#"{"provider":"box","state":"connected","canManage":true}"#, ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            assert_eq!(call(&service, "old-context".into()).unwrap().code, "account_context_changed");
            assert!(!request.join().unwrap().extra_request);
        }
    }

    // ---- personal model routes (PRO-18)

    const ROUTES: &str = r#"{"catalogVersion":1,"agents":["claude","codex","cursor"],"templates":[{"id":"claude-gateway","version":1,"provider":"claude","mode":"custom-endpoint","label":"LLM gateway","capabilities":{"modelList":"anthropic"}},{"id":"claude-key-helper","version":1,"provider":"claude","mode":"user-managed","label":"Helper","capabilities":{"modelList":"anthropic"}}],"routes":[]}"#;

    fn route_save(revision: &str, template: &str, settings: Value, enter_credential: bool) -> AgentRouteSave {
        AgentRouteSave {
            organization_id: None,
            context_revision: revision.into(),
            agent: AgentRouteAgent::Claude,
            template_id: template.into(),
            settings: settings.as_object().unwrap().clone(),
            expected_version: 0,
            enter_credential,
            save_unchecked: false,
        }
    }

    #[test]
    fn a_route_is_saved_with_its_credential_sent_once_and_never_returned() {
        let revision = AccountManager::context_revision(&context());
        let (base, requests) = serve_each(vec![response("200 OK", ROUTES, ""), response("200 OK", ROUTES, "")]);
        let (_, service) = test_service(&base);
        let save = route_save(&revision, "claude-gateway", json!({ "baseUrl": " https://llm.example.com ", "authScheme": "bearer", "model": "" }), true);
        let change = service.prepare_route_change(&save).unwrap();
        assert_eq!(change.host().as_deref(), Some("llm.example.com"));
        let routes = service.save_route(&change, &save, Some(zeroize::Zeroizing::new("sk-gw-native-1".into()))).unwrap();
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/desktop/orgs/org-1/agent-model-routes "), "{}", requests[0]);
        assert!(requests[1].starts_with("PUT /v1/desktop/orgs/org-1/agent-model-routes/claude "), "{}", requests[1]);
        let body: Value = serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({ "templateId": "claude-gateway", "settings": { "baseUrl": "https://llm.example.com", "authScheme": "bearer" }, "expectedVersion": 0, "credential": "sk-gw-native-1" }));
        assert!(!routes.to_string().contains("sk-gw-native-1"));
    }

    #[test]
    fn a_route_change_without_a_credential_keeps_the_stored_one_and_sends_none() {
        let revision = AccountManager::context_revision(&context());
        let (base, requests) = serve_each(vec![response("200 OK", ROUTES, ""), response("200 OK", ROUTES, "")]);
        let (_, service) = test_service(&base);
        let save = route_save(&revision, "claude-key-helper", json!({ "helperPath": "./scripts/llm-key" }), false);
        let change = service.prepare_route_change(&save).unwrap();
        service.save_route(&change, &save, None).unwrap();
        let requests = requests.join().unwrap();
        let body: Value = serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({ "templateId": "claude-key-helper", "settings": { "helperPath": "./scripts/llm-key" }, "expectedVersion": 0 }));
    }

    #[test]
    fn a_route_change_is_refused_before_anything_is_asked_for() {
        let revision = AccountManager::context_revision(&context());
        // Nothing is sent for a stale page or settings that are not a template's fields.
        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.prepare_route_change(&route_save("stale", "claude-gateway", json!({}), true)).err().unwrap().code, "account_context_changed");
        assert_eq!(service.prepare_route_change(&route_save(&revision, "claude-gateway", json!({ "credential": "sk-x" }), true)).err().unwrap().code, "cloud_agent_route_invalid");
        assert_eq!(service.prepare_route_change(&route_save(&revision, "../x", json!({}), true)).err().unwrap().code, "cloud_agent_route_template_unknown");
        // A template the service does not offer for the agent, and a credential for a helper.
        for (template, enter, code) in [("codex-provider", true, "cloud_agent_route_template_unknown"), ("claude-key-helper", true, "cloud_agent_route_invalid")] {
            let (base, request) = serve_each(vec![response("200 OK", ROUTES, "")]);
            let (_, service) = test_service(&base);
            assert_eq!(service.prepare_route_change(&route_save(&revision, template, json!({}), enter)).err().unwrap().code, code);
            request.join().unwrap();
        }
    }

    #[test]
    fn route_refusals_keep_their_codes_and_switching_back_deletes_the_route() {
        let revision = AccountManager::context_revision(&context());
        for code in ["cloud_agent_route_conflict", "cloud_agent_route_credential_required", "cloud_agent_route_base_url_invalid"] {
            let (base, requests) = serve_each(vec![response("200 OK", ROUTES, ""), response("422 Unprocessable Entity", &json!({ "error": code }).to_string(), "")]);
            let (_, service) = test_service(&base);
            let save = route_save(&revision, "claude-gateway", json!({ "baseUrl": "https://llm.example.com", "authScheme": "bearer" }), false);
            let change = service.prepare_route_change(&save).unwrap();
            assert_eq!(service.save_route(&change, &save, None).unwrap_err().code, code);
            requests.join().unwrap();
        }
        let (base, requests) = serve_each(vec![response("200 OK", ROUTES, "")]);
        let (_, service) = test_service(&base);
        service.remove_agent_route(None, &revision, AgentRouteAgent::Codex).unwrap();
        assert!(requests.join().unwrap()[0].starts_with("DELETE /v1/desktop/orgs/org-1/agent-model-routes/codex "));
    }

    // ---- agent logins (PRO-79)

    fn consent(revision: &str, sharing: bool, machines: bool) -> AgentLoginConsent {
        AgentLoginConsent { context_revision: revision.into(), organization_sharing: sharing, machine_installation: machines, replace_existing: false, organization_id: None }
    }

    // Review of #293: lending a sign-in silently replaced a working API key.
    #[test]
    fn a_stored_login_is_replaced_only_by_an_explicit_choice_and_the_dialog_is_told_what_it_replaces() {
        let stored = r#"{"credentials":[{"id":"c1","provider":"claude","authKind":"api-key","fingerprint":"sha256:ab","version":1,"updatedAt":5,"state":"connected"},{"id":"c2","provider":"codex","authKind":"api-key","fingerprint":"sha256:cd","version":1,"updatedAt":5,"state":"disconnected"}]}"#;
        let revision = AccountManager::context_revision(&context());
        let ask = |provider, replace| {
            let (base, _, request) = serve_once(response("200 OK", stored, ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let result = service.authorize_agent_login(provider, &AgentLoginConsent { replace_existing: replace, ..consent(&revision, true, true) });
            request.join().unwrap();
            result
        };
        assert_eq!(ask(AgentLoginProvider::Claude, false).err().unwrap().code, "cloud_agent_login_replace_unconfirmed");
        assert_eq!(ask(AgentLoginProvider::Claude, true).unwrap().replaces(), Some(AgentLoginKind::ApiKey));
        // Nothing stored, or only a disconnected one: nothing to replace, no extra choice needed.
        assert_eq!(ask(AgentLoginProvider::Cursor, false).unwrap().replaces(), None);
        assert_eq!(ask(AgentLoginProvider::Codex, false).unwrap().replaces(), None);
    }

    // PRO-79: "Log in with ChatGPT". Once Codex has finished on this Mac, what it wrote is
    // stored like any other login: consent, organization and the replace choice first, then one PUT.
    #[test]
    fn a_finished_codex_sign_in_is_stored_once_for_its_organization_and_then_let_go() {
        let _one_at_a_time = crate::commands::CODEX_SIGN_IN_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        use crate::codex_device_login::{DeviceLogin, Phase, SignIn};
        let revision = AccountManager::context_revision(&context());
        let consented = |replace| AgentLoginConsent { replace_existing: replace, ..consent(&revision, true, true) };
        let secret = r#"{"auth_mode":"chatgpt","tokens":{"id_token":"id","access_token":"at","refresh_token":"rt","account_id":"acct"}}"#;
        let signed_in = || DeviceLogin::finished_for_test(Phase::SignedIn, Some(SignIn { secret: zeroize::Zeroizing::new(secret.into()), account: Some("ada@example.com".into()) }));
        let stored_api_key = r#"{"credentials":[{"id":"c1","provider":"codex","authKind":"api-key","fingerprint":"sha256:ab","version":1,"updatedAt":5,"state":"connected"}]}"#;
        let saved = r#"{"id":"c2","provider":"codex","authKind":"oauth-credentials-json","fingerprint":"sha256:cd","displayIdentity":"ada@example.com","version":2,"updatedAt":9,"state":"connected","sharedUse":"organization"}"#;

        // Someone stored an API key meanwhile: not replaced without the choice, and the sign-in is kept for it.
        crate::commands::hold_codex_sign_in_for_test("codex-login-1", "org-1", signed_in());
        let (base, requests) = serve_each(vec![response("200 OK", stored_api_key, "")]);
        let (_, service) = test_service(&base);
        assert_eq!(crate::commands::codex_sign_in_status(&service, "codex-login-1", &consented(false)).err().unwrap().code, "cloud_agent_login_replace_unconfirmed");
        assert_eq!(requests.join().unwrap().len(), 1);
        assert!(crate::commands::codex_sign_in_held_for_test());

        // Chosen: one read, one PUT with the whole login, its account as the name, and no scope of its own.
        let (base, requests) = serve_each(vec![response("200 OK", stored_api_key, ""), response("200 OK", saved, "")]);
        let (_, service) = test_service(&base);
        let status = crate::commands::codex_sign_in_status(&service, "codex-login-1", &consented(true)).unwrap();
        assert_eq!(status.status, "complete");
        assert_eq!(status.credential.unwrap().display_identity.as_deref(), Some("ada@example.com"));
        let requests = requests.join().unwrap();
        assert!(requests[1].starts_with("PUT /v1/desktop/orgs/org-1/cloud-workspace-credentials/codex HTTP/1.1"));
        let body: Value = serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({ "authKind": "oauth-credentials-json", "secret": secret, "displayIdentity": "ada@example.com", "confirmOrganizationSharing": true, "confirmMachineInstallation": true })
        );
        // Stored: nothing is held any more, and the attempt is gone.
        assert!(!crate::commands::codex_sign_in_held_for_test());
        assert_eq!(crate::commands::codex_sign_in_status(&service, "codex-login-1", &consented(true)).err().unwrap().code, "cloud_agent_login_attempt_gone");

        // Sent once, and the service did not confirm it (here a 503; a lost answer is the same):
        // it is let go and never sent again, as the service may have stored and since renewed it.
        crate::commands::hold_codex_sign_in_for_test("codex-login-4", "org-1", signed_in());
        let (base, requests) = serve_each(vec![
            response("200 OK", r#"{"credentials":[]}"#, ""),
            response("503 Service Unavailable", r#"{"error":"cloud_workspace_unavailable"}"#, ""),
            response("200 OK", saved, ""),
        ]);
        let (_, service) = test_service(&base);
        let status = crate::commands::codex_sign_in_status(&service, "codex-login-4", &consented(false)).unwrap();
        assert_eq!(status.status, "unconfirmed");
        assert!(status.error_code.is_some() && status.credential.is_none());
        assert!(!crate::commands::codex_sign_in_held_for_test());
        assert_eq!(crate::commands::codex_sign_in_status(&service, "codex-login-4", &consented(false)).err().unwrap().code, "cloud_agent_login_attempt_gone");
        let requests = requests.join().unwrap();
        assert_eq!(requests.iter().filter(|request| request.starts_with("PUT ")).count(), 1, "the login was sent more than once");

        // Still waiting, or over: the account service is not asked anything.
        for (phase, said) in [(Phase::Waiting, "waiting"), (Phase::Expired, "expired"), (Phase::Cancelled, "cancelled"), (Phase::Failed, "failed")] {
            crate::commands::hold_codex_sign_in_for_test("codex-login-2", "org-1", DeviceLogin::finished_for_test(phase, None));
            let (_, service) = test_service("http://127.0.0.1:9");
            assert_eq!(crate::commands::codex_sign_in_status(&service, "codex-login-2", &consented(false)).unwrap().status, said);
            // A sign-in that is over is let go; a waiting one is kept.
            assert_eq!(crate::commands::codex_sign_in_held_for_test(), phase == Phase::Waiting);
        }
        // Signed in while looking at another organization: stored for neither, and let go.
        crate::commands::hold_codex_sign_in_for_test("codex-login-3", "org-other", signed_in());
        let (base, requests) = serve_each(vec![response("200 OK", r#"{"credentials":[]}"#, "")]);
        let (_, service) = test_service(&base);
        assert_eq!(crate::commands::codex_sign_in_status(&service, "codex-login-3", &consented(false)).err().unwrap().code, "account_context_changed");
        assert_eq!(requests.join().unwrap().len(), 1);
        assert!(!crate::commands::codex_sign_in_held_for_test());
    }

    // Security review of #483: the page is checked against OpenAI's own again when it is opened.
    #[test]
    fn only_an_openai_page_of_the_open_sign_in_is_ever_opened() {
        let _one_at_a_time = crate::commands::CODEX_SIGN_IN_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        use crate::codex_device_login::{DeviceLogin, Phase};
        crate::commands::hold_codex_sign_in_at_for_test("codex-login-5", "org-1", "https://auth.openai.com/codex/device", DeviceLogin::finished_for_test(Phase::Waiting, None));
        assert_eq!(crate::commands::codex_sign_in_page("codex-login-5").unwrap(), "https://auth.openai.com/codex/device");
        assert_eq!(crate::commands::codex_sign_in_page("codex-login-other").err().unwrap().code, "cloud_agent_login_attempt_gone");
        for stored in ["https://auth.openai.com.evil.test/codex/device", "http://auth.openai.com/codex/device", "https://user:pw@auth.openai.com/", "file:///etc/passwd", "javascript:alert(1)"] {
            crate::commands::hold_codex_sign_in_at_for_test("codex-login-5", "org-1", stored, DeviceLogin::finished_for_test(Phase::Waiting, None));
            assert_eq!(crate::commands::codex_sign_in_page("codex-login-5").err().unwrap().code, "cloud_workspace_request_invalid", "{stored}");
        }
        crate::commands::shutdown_codex_sign_in();
        assert!(!crate::commands::codex_sign_in_held_for_test());
    }

    #[test]
    fn agent_logins_list_agents_only_and_never_carry_a_login() {
        let body = r#"{"credentials":[
            {"id":"c1","provider":"claude","authKind":"oauth-credentials-json","fingerprint":"sha256:ab","displayIdentity":"ada@example.com","version":2,"updatedAt":5,"state":"connected","sharedUse":"organization","configurerLeft":true,"secret":"must-not-cross","ciphertext":"must-not-cross"},
            {"id":"c2","provider":"github","authKind":"personal-access-token","fingerprint":"sha256:cd","version":1,"updatedAt":4},
            {"id":"c3","provider":"codex","authKind":"api-key","fingerprint":"sha256:ef","version":1,"updatedAt":3,"state":"revoked"}
        ]}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.agent_logins(None).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspace-credentials HTTP/1.1"));
        assert_eq!(listed.credentials.iter().map(|login| login.provider.as_str()).collect::<Vec<_>>(), ["claude", "codex"]);
        let sent = serde_json::to_value(&listed).unwrap();
        assert_eq!(sent["credentials"][0]["displayIdentity"], "ada@example.com");
        assert_eq!(sent["credentials"][1]["state"], "revoked");
        // #450: the service's word that the person who connected a login has left reaches the page, and only when it was said.
        assert_eq!(sent["credentials"][0]["configurerLeft"], true);
        assert!(sent["credentials"][1].get("configurerLeft").is_none());
        assert!(!sent.to_string().contains("must-not-cross"));
    }

    #[test]
    fn nothing_is_asked_for_or_read_before_consent_the_active_organization_and_the_admin_check() {
        // Without both consents: no request at all.
        let (base, _, request) = serve_once(response("200 OK", r#"{"credentials":[]}"#, ""), Duration::from_millis(50));
        let (_, service) = test_service(&base);
        let revision = AccountManager::context_revision(&context());
        for (sharing, machines) in [(false, true), (true, false), (false, false)] {
            assert_eq!(service.authorize_agent_login(AgentLoginProvider::Claude, &consent(&revision, sharing, machines)).err().unwrap().code, "cloud_workspace_request_invalid");
        }
        // For another organization than the active one: still no request.
        assert_eq!(service.authorize_agent_login(AgentLoginProvider::Claude, &consent("old-context", true, true)).err().unwrap().code, "account_context_changed");
        // Consented, for this organization: the one read that the service answers only for owners and admins.
        assert!(service.authorize_agent_login(AgentLoginProvider::Claude, &consent(&revision, true, true)).is_ok());
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspace-credentials HTTP/1.1"));
        assert!(!captured.extra_request);

        // A member: the service refuses the read, and the refusal is what comes back.
        let (base, _, request) = serve_once(response("403 Forbidden", r#"{"error":"organization_admin_required"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.authorize_agent_login(AgentLoginProvider::Claude, &consent(&revision, true, true)).err().unwrap().code, "organization_admin_required");
        assert!(!request.join().unwrap().extra_request);
    }

    // PRO-107: agent logins belong to each organization. One the person belongs to is named by id
    // and changed by its own path while another is active; nothing is ever sent to the active one.
    #[test]
    fn a_named_member_organizations_agent_logins_are_read_and_changed_by_its_own_path() {
        let revision = AccountManager::context_revision(&context());
        let in_org_2 = |replace| AgentLoginConsent { replace_existing: replace, organization_id: Some("org-2".into()), ..consent(&revision, true, true) };
        let stored = r#"{"credentials":[{"id":"c1","provider":"codex","authKind":"api-key","fingerprint":"sha256:ab","version":1,"updatedAt":5,"state":"connected"}]}"#;
        let saved = r#"{"id":"c2","provider":"codex","authKind":"api-key","fingerprint":"sha256:cd","version":2,"updatedAt":9,"state":"connected"}"#;

        // An older server reaches only the active organization: refused before any request.
        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.agent_logins(Some("org-2")).unwrap_err().code, "cloud_organization_unavailable");
        assert_eq!(service.authorize_agent_login(AgentLoginProvider::Codex, &in_org_2(true)).err().unwrap().code, "cloud_organization_unavailable");

        // The list.
        let (base, _, request) = serve_once(response("200 OK", stored, ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.agent_logins(Some("org-2")).unwrap().credentials[0].provider, "codex");
        assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-2/cloud-workspace-credentials HTTP/1.1"));
        // The native dialogs name it: the active organization's name, a member organization's, and nothing for any other.
        assert_eq!(account.organization_name("org-1").as_deref(), Some("Test Organization"));
        assert_eq!(account.organization_name("org-2").as_deref(), Some("org-2"));
        assert_eq!(account.organization_name("org-3"), None);

        // Replacing org-2's Codex login while org-1 is active: the replace choice is still asked
        // for, and the read and the PUT both go to org-2.
        let (base, requests) = serve_each(vec![response("200 OK", stored, ""), response("200 OK", stored, ""), response("200 OK", saved, "")]);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.authorize_agent_login(AgentLoginProvider::Codex, &in_org_2(false)).err().unwrap().code, "cloud_agent_login_replace_unconfirmed");
        let authorization = service.authorize_agent_login(AgentLoginProvider::Codex, &in_org_2(true)).unwrap();
        assert_eq!(authorization.organization_id(), "org-2");
        assert_eq!(authorization.replaces(), Some(AgentLoginKind::ApiKey));
        service.save_agent_login(authorization, AgentLoginProvider::Codex, AgentLoginKind::ApiKey, zeroize::Zeroizing::new("sk-2".to_string()), None).unwrap();
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/desktop/orgs/org-2/cloud-workspace-credentials HTTP/1.1"));
        assert!(requests[1].starts_with("GET /v1/desktop/orgs/org-2/cloud-workspace-credentials HTTP/1.1"));
        assert!(requests[2].starts_with("PUT /v1/desktop/orgs/org-2/cloud-workspace-credentials/codex HTTP/1.1"));
        assert!(requests.iter().all(|request| !request.contains("/orgs/org-1/")));

        // Disconnecting and cancelling a sign-in name it too.
        let (base, requests) = serve_each(vec![response("200 OK", r#"{"ok":true}"#, ""), response("200 OK", r#"{"status":"canceled"}"#, "")]);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        service.remove_agent_login(AgentLoginProvider::Codex, revision.clone(), Some("org-2")).unwrap();
        service.cancel_claude_login("attempt_1", revision.clone(), Some("org-2")).unwrap();
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("DELETE /v1/desktop/orgs/org-2/cloud-workspace-credentials/codex HTTP/1.1"));
        assert!(requests[1].starts_with("POST /v1/desktop/orgs/org-2/cloud-workspace-credentials/claude/login-cancel HTTP/1.1"));

        // Never an organization the person is not a member of, and never on a page that knew another account.
        let (account, service) = test_service("http://127.0.0.1:9");
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        let in_org_3 = AgentLoginConsent { organization_id: Some("org-3".into()), ..consent(&revision, true, true) };
        assert_eq!(service.authorize_agent_login(AgentLoginProvider::Codex, &in_org_3).err().unwrap().code, "cloud_organization_unavailable");
        assert_eq!(service.remove_agent_login(AgentLoginProvider::Codex, revision.clone(), Some("org-3")).err().unwrap().code, "cloud_organization_unavailable");
        assert_eq!(service.remove_agent_login(AgentLoginProvider::Codex, "old-context".into(), Some("org-2")).err().unwrap().code, "account_context_changed");
    }

    // PRO-107: a request in flight for a named organization is fenced by the membership, not by
    // which organization is active: a default switch does not drop it, leaving the organization does.
    #[test]
    fn a_named_organizations_login_change_survives_a_default_switch_but_not_leaving_it() {
        let revision = AccountManager::context_revision(&context());
        let saved = r#"{"id":"c2","provider":"codex","authKind":"api-key","fingerprint":"sha256:cd","version":2,"updatedAt":9,"state":"connected"}"#;
        let authorize = |account: &AccountManager, service: &CloudWorkspaceService| {
            account.set_memberships_for_test(&["org-1", "org-2"], true);
            service.authorize_agent_login(AgentLoginProvider::Codex, &AgentLoginConsent { organization_id: Some("org-2".into()), ..consent(&revision, true, true) }).unwrap()
        };

        let (base, requests) = serve_each(vec![response("200 OK", r#"{"credentials":[]}"#, ""), response("200 OK", saved, "")]);
        let (account, service) = test_service(&base);
        let authorization = authorize(&account, &service);
        account.set_active_org_for_test("org-2");
        assert!(service.save_agent_login(authorization, AgentLoginProvider::Codex, AgentLoginKind::ApiKey, zeroize::Zeroizing::new("sk-2".to_string()), None).is_ok());
        requests.join().unwrap();

        let (base, requests) = serve_each(vec![response("200 OK", r#"{"credentials":[]}"#, "")]);
        let (account, service) = test_service(&base);
        let authorization = authorize(&account, &service);
        account.set_memberships_for_test(&["org-1"], true);
        assert_eq!(
            service.save_agent_login(authorization, AgentLoginProvider::Codex, AgentLoginKind::ApiKey, zeroize::Zeroizing::new("sk-2".to_string()), None).err().unwrap().code,
            "account_context_changed"
        );
        assert_eq!(requests.join().unwrap().len(), 1, "nothing is sent for an organization the person left");
    }

    #[test]
    fn an_agent_login_is_put_once_with_both_confirmations_and_only_its_public_fields_come_back() {
        let body = r#"{"id":"c1","provider":"claude","authKind":"oauth-credentials-json","fingerprint":"sha256:ab","version":3,"updatedAt":9,"state":"connected","sharedUse":"organization","secret":"must-not-cross"}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let login = service
            .save_agent_login(
                AgentLoginAuthorization::for_test(context(), None),
                AgentLoginProvider::Claude,
                AgentLoginKind::LoginDocument,
                zeroize::Zeroizing::new(r#"{"claudeAiOauth":{"accessToken":"at-1"}}"#.to_string()),
                Some("ada@example.com (temporary)"),
            )
            .unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("PUT /v1/desktop/orgs/org-1/cloud-workspace-credentials/claude HTTP/1.1"));
        assert_eq!(
            serde_json::from_str::<Value>(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            json!({
                "authKind": "oauth-credentials-json",
                "secret": r#"{"claudeAiOauth":{"accessToken":"at-1"}}"#,
                "displayIdentity": "ada@example.com (temporary)",
                "confirmOrganizationSharing": true,
                "confirmMachineInstallation": true,
            })
        );
        assert!(!captured.extra_request);
        let sent = serde_json::to_value(&login).unwrap();
        assert_eq!((sent["provider"].as_str(), sent["version"].as_i64()), (Some("claude"), Some(3)));
        assert!(!sent.to_string().contains("must-not-cross") && !sent.to_string().contains("at-1"));

        // An empty login is refused here, and an answer about another agent is not accepted.
        let (base, _, _request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let empty = service.save_agent_login(AgentLoginAuthorization::for_test(context(), None), AgentLoginProvider::Codex, AgentLoginKind::ApiKey, zeroize::Zeroizing::new("  ".to_string()), None);
        assert_eq!(empty.err().unwrap().code, "cloud_workspace_request_invalid");
        let other = service.save_agent_login(AgentLoginAuthorization::for_test(context(), None), AgentLoginProvider::Codex, AgentLoginKind::ApiKey, zeroize::Zeroizing::new("sk-1".to_string()), None);
        assert!(other.is_err());
    }

    // Review of #429: the desktop sent `sharedUse: organization` with every sign-in, which widened a
    // login an admin had narrowed to managers whenever someone logged in again.
    #[test]
    fn replacing_a_login_sends_no_scope_so_the_service_keeps_the_one_it_has() {
        let narrowed = || AgentLoginAuthorization::for_test(context(), Some(("oauth-credentials-json", Some("managers"))));
        let body_of = |text: &str| serde_json::from_str::<Value>(text.split("\r\n\r\n").nth(1).unwrap()).unwrap();

        let done = r#"{"status":"complete","credential":{"id":"c1","provider":"claude","authKind":"oauth-credentials-json","fingerprint":"sha256:ab","version":2,"updatedAt":9,"state":"connected","sharedUse":"managers"}}"#;
        let (base, _, request) = serve_once(response("200 OK", done, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let outcome = service.complete_claude_login(narrowed(), "attempt_1", zeroize::Zeroizing::new("the-code#the-state".to_string())).unwrap();
        let sent = body_of(&request.join().unwrap().text);
        assert!(sent.get("sharedUse").is_none(), "a sign-in that replaces a login must not name a scope: {sent}");
        assert_eq!(sent.as_object().unwrap().len(), 4);
        // What the service kept comes back, and is what the page shows.
        assert_eq!(outcome.credential.unwrap().shared_use.as_deref(), Some("managers"));

        // The same for a login that is PUT (an API key, a lent sign-in), replacing or new.
        let stored = r#"{"id":"c1","provider":"claude","authKind":"api-key","fingerprint":"sha256:ab","version":3,"updatedAt":9,"state":"connected","sharedUse":"managers"}"#;
        for authorization in [AgentLoginAuthorization::for_test(context(), Some(("api-key", Some("managers")))), AgentLoginAuthorization::for_test(context(), None)] {
            let (base, _, request) = serve_once(response("200 OK", stored, ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            service.save_agent_login(authorization, AgentLoginProvider::Claude, AgentLoginKind::ApiKey, zeroize::Zeroizing::new("sk-1".to_string()), None).unwrap();
            assert!(body_of(&request.join().unwrap().text).get("sharedUse").is_none());
        }
    }

    #[test]
    fn a_dialog_is_told_who_the_login_will_reach_new_or_kept() {
        let reach = |stored, kind| AgentLoginAuthorization::for_test(context(), stored).reach(kind);
        // Nothing stored: the service's default, said as a default.
        assert_eq!(reach(None, AgentLoginKind::LoginDocument), AgentLoginReach::ServiceDefault);
        assert!(AgentLoginReach::ServiceDefault.sentence().starts_with("By default, agents in every member's cloud workspaces"));
        // The same kind is replaced: its scope stays, and a narrowed one is not described as everyone.
        let kept = reach(Some(("oauth-credentials-json", Some("managers"))), AgentLoginKind::LoginDocument);
        assert_eq!(kept, AgentLoginReach::Kept("managers".into()));
        assert_eq!(kept.sentence(), "This keeps who can use the login now: only workspaces that nobody but owners and admins can drive.");
        assert!(!kept.sentence().contains("every member"));
        assert!(reach(Some(("api-key", Some("organization"))), AgentLoginKind::ApiKey).sentence().contains("keeps who can use the login now: agents in every member's"));
        // An older server names no scope: it shared every login with the organization.
        assert_eq!(reach(Some(("api-key", None)), AgentLoginKind::ApiKey), AgentLoginReach::Kept("organization".into()));
        // A scope this app does not know is kept without being described.
        assert!(!reach(Some(("api-key", Some("teams"))), AgentLoginKind::ApiKey).sentence().contains("every member"));
        // Another kind of login never reaches more than the stored one and may reach fewer: not a first login, and
        // not described as every member when the stored login is for managers.
        for (was, becomes) in [("api-key", AgentLoginKind::LoginDocument), ("oauth-credentials-json", AgentLoginKind::ApiKey)] {
            let narrowed = reach(Some((was, Some("managers"))), becomes);
            assert_eq!(narrowed, AgentLoginReach::NoWider("managers".into()));
            assert_eq!(
                narrowed.sentence(),
                "This keeps who can use the login now, or fewer: at most workspaces that nobody but owners and admins can drive. Settings shows who the login reaches once it is stored."
            );
            assert!(!narrowed.sentence().contains("every member") && !narrowed.sentence().contains("By default"));
            let wide = reach(Some((was, Some("organization"))), becomes);
            assert!(wide.sentence().starts_with("This keeps who can use the login now, or fewer: at most agents in every member's cloud workspaces"));
            assert!(!wide.sentence().contains("By default"));
            assert!(!reach(Some((was, Some("teams"))), becomes).sentence().contains("every member"));
        }
    }

    // PRO-82 on the desktop: the account service's own sign-in for Claude.
    #[test]
    fn a_claude_sign_in_starts_completes_and_cancels_on_its_routes_and_opens_only_the_providers_page() {
        let authorization = || AgentLoginAuthorization::for_test(context(), None);
        let (base, _, request) = serve_once(response("200 OK", r#"{"attemptId":"attempt_1","authorizeUrl":"https://claude.com/cai/oauth/authorize?state=s","expiresInSeconds":600,"mode":"paste"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let started = service.start_claude_login(&authorization()).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspace-credentials/claude/login-start HTTP/1.1"));
        assert_eq!(serde_json::from_str::<Value>(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap(), json!({}));
        assert_eq!((started.attempt_id.as_str(), started.expires_in_seconds), ("attempt_1", 600));

        // A page that is not the provider's is never handed on to be opened.
        let (base, _, request) = serve_once(response("200 OK", r#"{"attemptId":"attempt_1","authorizeUrl":"https://claude.com.evil.example/authorize","expiresInSeconds":600}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert!(service.start_claude_login(&authorization()).is_err());
        request.join().unwrap();
        // An older server, or one with the feature off, answers 404: said as such.
        let (base, _, request) = serve_once(response("404 Not Found", r#"{"error":"not_found"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.start_claude_login(&authorization()).err().unwrap().code, "cloud_agent_login_flow_unavailable");
        request.join().unwrap();

        let done = r#"{"status":"complete","credential":{"id":"c1","provider":"claude","authKind":"oauth-credentials-json","fingerprint":"sha256:ab","displayIdentity":"ada@example.com","version":1,"updatedAt":9,"state":"connected","sharedUse":"organization","secret":"must-not-cross"}}"#;
        let (base, _, request) = serve_once(response("200 OK", done, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let outcome = service.complete_claude_login(authorization(), "attempt_1", zeroize::Zeroizing::new("  the-code#the-state \n".to_string())).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspace-credentials/claude/login-complete HTTP/1.1"));
        // Both confirmations are sent; the code is trimmed and sent once. No scope is sent: nobody chose one.
        assert_eq!(
            serde_json::from_str::<Value>(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            json!({ "attemptId": "attempt_1", "code": "the-code#the-state", "confirmOrganizationSharing": true, "confirmMachineInstallation": true })
        );
        assert!(!captured.extra_request);
        let sent = serde_json::to_value(&outcome).unwrap();
        assert_eq!((sent["status"].as_str(), sent["credential"]["displayIdentity"].as_str()), (Some("complete"), Some("ada@example.com")));
        assert!(!sent.to_string().contains("must-not-cross") && !sent.to_string().contains("the-code"));

        let (base, _, request) = serve_once(response("200 OK", r#"{"status":"code-invalid","attemptsLeft":3}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let wrong = service.complete_claude_login(authorization(), "attempt_1", zeroize::Zeroizing::new("nope".to_string())).unwrap();
        request.join().unwrap();
        assert_eq!((wrong.status.as_str(), wrong.attempts_left, wrong.credential.is_none()), ("code-invalid", Some(3), true));
        // An empty code is not sent at all.
        assert_eq!(service.complete_claude_login(authorization(), "attempt_1", zeroize::Zeroizing::new("  ".to_string())).err().unwrap().code, "cloud_workspace_request_invalid");

        let (base, _, request) = serve_once(response("200 OK", r#"{"status":"canceled"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.cancel_claude_login("attempt_1", "old-context".into(), None).err().unwrap().code, "account_context_changed");
        service.cancel_claude_login("attempt_1", AccountManager::context_revision(&context()), None).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspace-credentials/claude/login-cancel HTTP/1.1"));
        assert_eq!(serde_json::from_str::<Value>(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap(), json!({ "attemptId": "attempt_1" }));
        assert!(!captured.extra_request);
    }

    #[test]
    fn only_the_providers_https_pages_count_as_a_sign_in_page() {
        for page in ["https://claude.com/cai/oauth/authorize?x=1", "https://claude.ai/oauth/authorize", "https://platform.claude.com/x", "https://console.anthropic.com/oauth"] {
            assert!(claude_login_page(page), "{page}");
        }
        for page in [
            "http://claude.com/authorize",
            "https://claude.com.evil.example/authorize",
            "https://evilclaude.com/authorize",
            "https://user:pass@claude.com/authorize",
            "https://example.com/?next=https://claude.com",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "claude.com/authorize",
            "",
        ] {
            assert!(!claude_login_page(page), "{page}");
        }
    }

    #[test]
    fn organization_billing_reads_the_enabled_target_organization_only() {
        let body = json!({
            "plan": "teams", "billedTo": "organization",
            "seats": { "used": 3, "limit": 5 },
            "seatPrice": { "currency": "USD", "unitAmountMinor": 2000, "interval": "month" },
            "nextCharge": { "date": "2099-02-15T00:00:00.000Z", "amountMinor": 6000, "currency": "USD" },
            "payer": "Fixture Payer", "canManageBilling": true, "customerId": "never-forwarded"
        });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.organization_billing("org-2").unwrap_err().code, "organization_billing_unavailable");
        account.apply_phase2_readiness_for_test(json!({
            "version": 1, "organizations": { "org-2": { (PHASE2_DESKTOP_BILLING): true } }
        }));
        assert_eq!(service.organization_billing("org-1").unwrap_err().code, "organization_billing_unavailable");
        let billing = serde_json::to_value(service.organization_billing("org-2").unwrap()).unwrap();
        let mut expected = body.clone();
        expected.as_object_mut().unwrap().remove("customerId");
        assert_eq!(billing, expected);
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-2/billing HTTP/1.1"));
        assert!(!captured.extra_request);
    }

    #[test]
    fn organization_billing_rejects_inconsistent_answers_and_keeps_its_error_code() {
        for body in [
            r#"{"plan":"teams","billedTo":"personal","seats":null,"seatPrice":null,"nextCharge":null,"payer":null,"canManageBilling":false}"#,
            r#"{"plan":"free","billedTo":"personal","seats":null,"seatPrice":null,"nextCharge":{"date":"soon","amountMinor":1,"currency":"USD"},"payer":null,"canManageBilling":false}"#,
            r#"{"plan":"free","billedTo":"personal","seats":null,"seatPrice":null,"nextCharge":{"date":"2099-02-15T00:00:00Z","amountMinor":1,"currency":"usd"},"payer":null,"canManageBilling":false}"#,
        ] {
            let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
            let (account, service) = test_service(&base);
            account.set_memberships_for_test(&["org-1"], true);
            account.apply_phase2_readiness_for_test(json!({
                "version": 1, "organizations": { "org-1": { (PHASE2_DESKTOP_BILLING): true } }
            }));
            assert!(service.organization_billing("org-1").is_err(), "{body}");
            request.join().unwrap();
        }
        let (base, _, request) = serve_once(
            response("404 Not Found", r#"{"error":"organization_billing_unavailable"}"#, ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1"], true);
        account.apply_phase2_readiness_for_test(json!({
            "version": 1, "organizations": { "org-1": { (PHASE2_DESKTOP_BILLING): true } }
        }));
        let error = service.organization_billing("org-1").unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("organization_billing_unavailable", Some(404)));
    }

    #[test]
    fn organization_billing_portal_posts_the_view_and_opens_only_polar() {
        for (url, accepted) in [
            ("https://polar.sh/acme/portal?customer_session_token=fixture", true),
            ("https://sandbox.polar.sh/acme/portal", true),
            ("http://polar.sh/acme/portal", false),
            ("https://polar.sh.evil.test/portal", false),
            ("https://evilpolar.sh/portal", false),
            ("https://user@polar.sh/portal", false),
            ("https://polar.sh:444/portal", false),
        ] {
            let (base, _, request) = serve_once(response("200 OK", &json!({ "url": url }).to_string(), ""), Duration::ZERO);
            let (account, service) = test_service(&base);
            account.set_memberships_for_test(&["org-1"], true);
            account.apply_phase2_readiness_for_test(json!({
                "version": 1, "organizations": { "org-1": { (PHASE2_DESKTOP_BILLING): true } }
            }));
            let result = service.organization_billing_portal("org-1", BillingView::Organization);
            assert_eq!(result.is_ok(), accepted, "{url}");
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/billing/teams/portal HTTP/1.1"));
        }
        let (base, _, _request) = serve_once(response("200 OK", "{}", ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1"], true);
        assert_eq!(service.organization_billing_portal("org-1", BillingView::Personal).unwrap_err().code, "organization_billing_unavailable");
    }

    #[test]
    fn precreate_usage_reads_the_enabled_target_organization_and_preserves_unlimited() {
        let body = r#"{"callerOwnedRunning":2,"callerOwnedRunningLimit":null,"quota":{"used":5,"limit":8,"running":{"used":5,"limit":8},"total":{"used":7,"limit":10}}}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        for org in ["org-1", "org-2"] {
            account.apply_phase2_readiness_for_test(json!({
                "version": 1, "organizations": { (org): { (PHASE2_PRECREATE_USAGE): true } }
            }));
            let result = service.precreate_usage("org-2");
            if org == "org-1" {
                assert_eq!(result.unwrap_err().code, "cloud_workspace_usage_unavailable");
            } else {
                let usage = serde_json::to_value(result.unwrap()).unwrap();
                assert_eq!(usage, serde_json::from_str::<Value>(body).unwrap());
            }
        }
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-2/cloud-workspaces/precreate-usage HTTP/1.1"));
        assert!(!captured.extra_request);
    }

    #[test]
    fn start_progress_checks_target_readiness_and_projects_member_safe_fields() {
        let payload = json!({
            "organizationId": "org-2", "workspaceId": "workspace-1",
            "operation": { "id": "op-1", "state": "running" },
            "steps": [{ "key": "preflight", "startedAt": 1000, "finishedAt": null, "durationMs": null }],
            "events": [{ "id": "event-1", "state": "running", "stage": "preflight", "milestone": null, "occurredAt": 1000, "output": "raw" }],
            "setup": null
        });
        let (base, _, request) = serve_once(response("200 OK", &payload.to_string(), ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        let feature = "cloud.workspaces.start-progress.v1";
        for org in ["org-1", "org-2"] {
            account.apply_phase2_readiness_for_test(json!({
                "version": 1, "organizations": { (org): { (feature): true } }
            }));
            let result = service.start_progress("org-2", "workspace-1", "op-1");
            if org == "org-1" {
                assert_eq!(result.err().unwrap().code, "cloud_workspace_start_progress_unavailable");
            } else {
                let projected = serde_json::to_value(result.unwrap()).unwrap();
                assert_eq!(projected["steps"][0]["durationMs"], Value::Null);
                assert!(projected["events"][0].get("output").is_none());
                assert!(projected.get("setup").is_none());
            }
        }
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-2/cloud-workspaces/workspace-1/start-progress/op-1 HTTP/1.1"));
        assert!(!captured.extra_request);
    }

    #[test]
    fn agent_login_impact_reads_only_the_gated_preview() {
        let body = r#"{"workspaces":[{"id":"workspace_123","name":"API verification"}],"count":1,"hasMore":false,"hasHidden":true}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1"], true);
        let context_revision = AccountManager::context_revision(&context());
        let read = |revision: &str| {
            service.agent_login_affected_workspaces(AgentLoginProvider::Cursor, revision, Some("org-1"))
        };
        assert_eq!(read(&context_revision).unwrap_err().code, "cloud_agent_login_affected_workspaces_unavailable");
        account.apply_phase2_readiness_for_test(json!({
            "version": 1,
            "organizations": { "org-1": { (PHASE2_AFFECTED_WORKSPACES): true } }
        }));
        assert_eq!(read("previous-account").unwrap_err().code, "account_context_changed");
        let preview = read(&context_revision).unwrap();
        assert_eq!(preview.count, 1);
        assert_eq!(preview.workspaces[0].name, "API verification");
        assert!(preview.has_hidden && !preview.has_more);
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspace-credentials/cursor/affected-workspaces HTTP/1.1"));
        assert!(!captured.extra_request);
    }

    #[test]
    fn agent_login_impact_rejects_an_inconsistent_server_count() {
        let body = r#"{"workspaces":[],"count":1,"hasMore":false,"hasHidden":false}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, mut service) = test_service(&base);
        service.force_phase2_for_test = true;
        assert!(service.agent_login_affected_workspaces(
            AgentLoginProvider::Claude, &AccountManager::context_revision(&context()), None,
        ).is_err());
        request.join().unwrap();
    }

    #[test]
    fn an_agent_login_is_removed_with_delete_and_a_rejected_key_says_so() {
        let (base, _, request) = serve_once(response("200 OK", r#"{"ok":true}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        service.remove_agent_login(AgentLoginProvider::Cursor, AccountManager::context_revision(&context()), None).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("DELETE /v1/desktop/orgs/org-1/cloud-workspace-credentials/cursor HTTP/1.1"));
        assert_eq!(serde_json::from_str::<Value>(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap(), json!({}));

        let (base, _, request) = serve_once(response("422 Unprocessable Entity", r#"{"error":"cloud_workspace_credential_invalid"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        // Asked for another organization than the active one: nothing is sent.
        assert_eq!(service.remove_agent_login(AgentLoginProvider::Cursor, "old-context".into(), None).err().unwrap().code, "account_context_changed");
        let refused = service.save_agent_login(AgentLoginAuthorization::for_test(context(), None), AgentLoginProvider::Cursor, AgentLoginKind::ApiKey, zeroize::Zeroizing::new("key-1".to_string()), None);
        assert_eq!(refused.err().unwrap().code, "cloud_workspace_credential_invalid");
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("PUT ") && !captured.extra_request);
    }

    #[test]
    fn provider_disconnect_denies_members_before_any_mutation() {
        let (base, _, request) = serve_once(response("200 OK", r#"{"provider":"box","state":"connected","canManage":false}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.disconnect_provider(provider_id("box"), AccountManager::context_revision(&context()), DisconnectDisposition::Retain).unwrap_err();
        assert_eq!(error.code, "organization_admin_required");
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET "));
        assert!(!captured.extra_request);
    }

    #[test]
    fn provider_disconnect_fences_stale_organization_before_mutation() {
        let (base, _, request) = serve_once(response("200 OK", r#"{"provider":"box","state":"connected","canManage":true}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.disconnect_provider(provider_id("box"), "old-context".into(), DisconnectDisposition::Destroy).unwrap_err();
        assert_eq!(error.code, "account_context_changed");
        assert!(!request.join().unwrap().extra_request);
    }

    #[test]
    fn setup_accepts_authoritative_selected_location_fixture() {
        let body = json!({
            "provider": "box", "credentialFingerprint": "sha256:0123", "currency": "USD",
            "pricing": "provider-rate", "pricingObservedAt": 1,
            "sources": [{"id":"box-standard","kind":"provider-default","label":"Standard"}],
            "locations": [{"id":"automatic","label":"Automatic","placement":"selected"}],
            "machineClasses": [{"id":"small","label":"Small","vcpu":2,"memoryMiB":4096,"diskGiB":40,"activeHourlyMicros":18000}],
            "defaults": {"sourceId":"box-standard","locationId":"automatic","machineClassId":"small","idleSuspendMinutes":0,"retentionDays":30,"networkPolicy":"provider-public-network"},
            "allowedIdleSuspendMinutes": [5,15,30,60,0], "allowedRetentionDays": [7,30,90]
        }).to_string();
        let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let setup = service.setup(None, provider_id("box")).unwrap();
        let captured = request.join().unwrap();
        assert!(matches!(
            setup.locations[0].placement,
            CatalogPlacement::Selected
        ));
        assert!(captured.text.starts_with(
            "GET /v1/desktop/orgs/org-1/cloud-workspaces/setup?provider=box HTTP/1.1"
        ));
    }

    #[test]
    fn create_uses_exact_body_and_key_once_then_returns_authoritative_snapshot() {
        let body = snapshot_body(None);
        let (base, _, request) = serve_once(response("202 Accepted", &body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let result = service
            .create(None, CloudWorkspaceCreateInput {
                name: "Product website".into(),
                quote_id: "quote-1".into(),
                access_mode: WorkspaceAccessMode::Private,
                confirm_provider_spend: true,
                idempotency_key: "stable create key".into(),
                repositories: Vec::new(),
                launch: None,
                preparation: false,
            })
            .unwrap();
        let captured = request.join().unwrap();
        assert_eq!(result.operation.id, "operation-1");
        assert!(!captured.extra_request);
        let lower = captured.text.to_ascii_lowercase();
        assert!(lower.contains("idempotency-key: stable create key"));
        assert!(captured.text.contains(r#""quoteId":"quote-1""#));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("ignoredProviderSdkField"));
    }

    #[test]
    fn operation_method_decodes_snapshot_and_allowlists_operation_error() {
        let body = snapshot_body(Some("syntactically_valid_canary"));
        let (base, _, request) = serve_once(response("200 OK", &body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let result = service.operation(None, "operation-1").unwrap();
        let captured = request.join().unwrap();
        assert_eq!(
            result.operation.error_code.as_deref(),
            Some("cloud_workspace_unknown_error")
        );
        assert!(captured.text.starts_with(
            "GET /v1/desktop/orgs/org-1/cloud-workspace-operations/operation-1 HTTP/1.1"
        ));
    }

    #[test]
    fn quote_list_lifecycle_and_cancel_use_their_fixed_contracts() {
        let quote_body = json!({
            "id":"quote-1","provider":"machine0","expiresAt":2,"currency":"USD",
            "pricing":"estimate","pricingObservedAt":1,"activeHourlyMicros":100,
            "alwaysOnThirtyDayMicros":72000,
            "configuration": {
                "sourceId":"ubuntu","locationId":"us","machineClassId":"small",
                "idleSuspendMinutes":15,"retentionDays":30,"networkPolicy":"relay-only",
                "sourceLabel":"Ubuntu","locationLabel":"US","machineClassLabel":"Small",
                "vcpu":2,"memoryMiB":4096,"diskGiB":40,"architecture":"x86_64"
            }
        })
        .to_string();
        let (base, _, request) = serve_once(response("200 OK", &quote_body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let quote = service
            .quote(None, CloudWorkspaceQuoteInput {
                provider: provider_id("machine0"),
                source_id: "ubuntu".into(),
                location_id: "us".into(),
                machine_class_id: "small".into(),
                idle_suspend_minutes: 15,
                retention_days: 30,
                network_policy: NetworkPolicy::RelayOnly,
            })
            .unwrap();
        let captured = request.join().unwrap();
        assert_eq!(quote.id, "quote-1");
        assert!(captured
            .text
            .starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/quote HTTP/1.1"));

        let list_body = json!({"workspaces":[{"workspace":serde_json::from_str::<Value>(&snapshot_body(None)).unwrap()["workspace"],"latestOperation":serde_json::from_str::<Value>(&snapshot_body(None)).unwrap()["operation"]}]}).to_string();
        let (base, _, request) = serve_once(response("200 OK", &list_body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.workspaces(None).unwrap().workspaces.len(), 1);
        assert!(request
            .join()
            .unwrap()
            .text
            .starts_with("GET /v1/desktop/orgs/org-1/cloud-workspaces HTTP/1.1"));

        let mut lifecycle: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        lifecycle["operation"]["action"] = json!("suspend");
        let (base, _, request) = serve_once(
            response("202 Accepted", &lifecycle.to_string(), ""),
            Duration::ZERO,
        );
        let (_, service) = test_service(&base);
        service
            .lifecycle(None, "workspace-1", OperationAction::Suspend)
            .unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with(
            "POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/suspend HTTP/1.1"
        ));
        assert!(captured.text.ends_with("{}"));

        lifecycle["operation"]["state"] = json!("cancel-requested");
        let (base, _, request) = serve_once(
            response("200 OK", &lifecycle.to_string(), ""),
            Duration::ZERO,
        );
        let (_, service) = test_service(&base);
        service.cancel_operation(None, "operation-1").unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with(
            "POST /v1/desktop/orgs/org-1/cloud-workspace-operations/operation-1/cancel HTTP/1.1"
        ));
    }

    #[test]
    fn refuses_redirects_without_forwarding_authorization() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let redirect = format!("HTTP/1.1 302 Found\r\nLocation: http://{}/capture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", destination.local_addr().unwrap());
        let (base, _, first) = serve_once(redirect, Duration::ZERO);
        let client = Client::for_test(&base, Duration::from_millis(200));
        let error = client
            .request::<CloudProviderSummaryResponse>(
                &context(),
                &["cloud-providers"],
                None,
                None,
                None,
                RequestRisk::Read,
            )
            .unwrap_err();
        assert_eq!(error.code, "cloud_workspace_invalid_response");
        first.join().unwrap();
        thread::sleep(Duration::from_millis(20));
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn normalizes_rate_limits_and_drops_raw_provider_messages() {
        let body = r#"{"error":"cloud_provider_rate_limited","raw":"provider account secret"}"#;
        let (base, _, request) = serve_once(
            response("429 Too Many Requests", body, "Retry-After: 99999\r\n"),
            Duration::ZERO,
        );
        let client = Client::for_test(&base, Duration::from_secs(2));
        let error = client
            .request::<CloudProviderSummaryResponse>(
                &context(),
                &["cloud-providers"],
                None,
                None,
                None,
                RequestRisk::Read,
            )
            .unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_provider_rate_limited");
        assert_eq!(error.retry_after_seconds, Some(3600));
        assert!(error.retryable);
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("provider account secret"));
    }

    #[test]
    fn organization_member_limit_reached_is_preserved() {
        let (base, _, request) = serve_once(
            response("409 Conflict", r#"{"error":"organization_member_limit_reached"}"#, ""),
            Duration::ZERO,
        );
        let (_, service) = test_service(&base);
        let error = service.providers().unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("organization_member_limit_reached", Some(409)));
    }

    #[test]
    fn unknown_http_error_code_is_not_disclosed() {
        let body = r#"{"error":"syntactically_valid_canary"}"#;
        let (base, _, request) = serve_once(
            response("422 Unprocessable Entity", body, ""),
            Duration::ZERO,
        );
        let (_, service) = test_service(&base);
        let error = service.providers().unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_workspace_unavailable");
        assert!(!serde_json::to_string(&error).unwrap().contains("canary"));
    }

    #[test]
    fn a_valid_key_without_a_permission_is_reported_as_such() {
        let body = r#"{"error":"cloud_provider_permission_denied"}"#;
        let (base, _, request) = serve_once(response("422 Unprocessable Entity", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.providers().unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_provider_permission_denied");
    }

    /// terminalx-saas #241: a login the provider no longer accepts is one
    /// code the page turns into "Sign in again", and its list row says so.
    #[test]
    fn a_login_the_provider_refused_reaches_the_page_as_sign_in_required() {
        let (base, _, request) = serve_once(response("409 Conflict", r#"{"error":"cloud_agent_credential_reauth_required"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.providers().unwrap_err().code, "cloud_agent_credential_reauth_required");
        request.join().unwrap();

        let body = r#"{"credentials":[{"id":"c1","provider":"codex","authKind":"oauth-credentials-json","fingerprint":"sha256:ab","displayIdentity":"ada@example.com","version":3,"updatedAt":5,"state":"sign-in-required","sharedUse":"organization"}]}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.agent_logins(None).unwrap();
        request.join().unwrap();
        assert_eq!(serde_json::to_value(&listed).unwrap()["credentials"][0]["state"], "sign-in-required");
    }

    #[test]
    fn create_transport_failure_requires_same_key_reconciliation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let client = Client::for_test(&base, Duration::from_millis(50));
        let error = client
            .request::<CloudWorkspaceSnapshot>(
                &context(),
                &["cloud-workspaces"],
                None,
                Some(json!({})),
                Some("stable-create-key"),
                RequestRisk::Create,
            )
            .unwrap_err();
        assert_eq!(error.code, "cloud_workspace_create_outcome_unknown");
        assert!(!error.retryable);
        assert!(error.retry_with_same_idempotency_key);
        assert!(error.requires_original_account_context);
    }

    #[test]
    fn possibly_committed_mutations_require_original_context_at_every_boundary() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (_, service) = test_service(&base);
        let error = service
            .lifecycle(None, "workspace-1", OperationAction::Suspend)
            .unwrap_err();
        assert_eq!(error.code, "cloud_workspace_request_outcome_unknown");
        assert!(!error.retryable);
        assert!(!error.retry_with_same_idempotency_key);
        assert!(error.requires_original_account_context);

        let unavailable = response(
            "503 Service Unavailable",
            r#"{"error":"cloud_provider_unavailable"}"#,
            "",
        );
        let (base, _, request) = serve_once(unavailable.clone(), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service
            .lifecycle(None, "workspace-1", OperationAction::Delete)
            .unwrap_err();
        let captured = request.join().unwrap();
        assert!(!captured.extra_request);
        assert_eq!(error.code, "cloud_provider_unavailable");
        assert!(!error.retryable);
        assert!(!error.retry_with_same_idempotency_key);
        assert!(error.requires_original_account_context);

        let (base, _, request) = serve_once(unavailable, Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.cancel_operation(None, "operation-1").unwrap_err();
        let captured = request.join().unwrap();
        assert!(!captured.extra_request);
        assert_eq!(error.code, "cloud_provider_unavailable");
        assert!(!error.retryable);
        assert!(!error.retry_with_same_idempotency_key);
        assert!(error.requires_original_account_context);

        let task_error = CloudWorkspaceClientError::task_failed(RequestRisk::Mutation);
        assert_eq!(task_error.code, "cloud_workspace_request_outcome_unknown");
        assert!(!task_error.retryable);
        assert!(!task_error.retry_with_same_idempotency_key);
        assert!(task_error.requires_original_account_context);
    }

    #[test]
    fn request_timeout_is_bounded_and_keeps_create_reconciliation_semantics() {
        for risk in [RequestRisk::Read, RequestRisk::Create] {
            let body = if matches!(risk, RequestRisk::Read) {
                r#"{"providers":[]}"#.to_string()
            } else {
                snapshot_body(None)
            };
            let (base, _, request) =
                serve_once(response("200 OK", &body, ""), Duration::from_millis(100));
            let client = Client::for_test(&base, Duration::from_millis(20));
            let error = client
                .request::<CloudProviderSummaryResponse>(
                    &context(),
                    &["cloud-workspaces"],
                    None,
                    matches!(risk, RequestRisk::Create).then(|| json!({})),
                    matches!(risk, RequestRisk::Create).then_some("original-key"),
                    risk,
                )
                .unwrap_err();
            request.join().unwrap();
            if matches!(risk, RequestRisk::Create) {
                assert!(error.retry_with_same_idempotency_key);
                assert!(error.requires_original_account_context);
            } else {
                assert!(error.retryable);
            }
        }
    }

    #[test]
    fn malformed_create_response_and_http_500_require_same_key_reconciliation_without_retry() {
        for (status, body) in [
            ("202 Accepted", "{".to_string()),
            (
                "202 Accepted",
                snapshot_body(None).replace("org-1", "org-2"),
            ),
            (
                "500 Internal Server Error",
                r#"{"error":"cloud_provider_unavailable"}"#.to_string(),
            ),
        ] {
            let (base, _, request) = serve_once(response(status, &body, ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let error = service
                .create(None, CloudWorkspaceCreateInput {
                    name: "Product website".into(),
                    quote_id: "quote-1".into(),
                    access_mode: WorkspaceAccessMode::Private,
                    confirm_provider_spend: true,
                    idempotency_key: "original-key".into(),
                    repositories: Vec::new(),
                    launch: None,
                    preparation: false,
                })
                .unwrap_err();
            let captured = request.join().unwrap();
            assert!(!captured.extra_request);
            assert!(!error.retryable);
            assert!(error.retry_with_same_idempotency_key);
            assert!(error.requires_original_account_context);
        }
    }

    #[test]
    fn rejects_oversized_and_cross_organization_responses() {
        let oversized = "x".repeat(RESPONSE_LIMIT_BYTES as usize + 1);
        let (base, _, request) = serve_once(response("200 OK", &oversized, ""), Duration::ZERO);
        let client = Client::for_test(&base, Duration::from_secs(2));
        let error = client
            .request::<CloudProviderSummaryResponse>(
                &context(),
                &["cloud-providers"],
                None,
                None,
                None,
                RequestRisk::Read,
            )
            .unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_workspace_invalid_response");

        let list = CloudWorkspaceList {
            workspaces: vec![CloudWorkspaceListItem {
                workspace: CloudWorkspace {
                    id: "workspace-1".into(),
                    org_id: "another-org".into(),
                    name: "one".into(),
                    provider: provider_id("box"),
                    state: WorkspaceState::Ready,
                    access_mode: WorkspaceAccessMode::Private,
                    created_at: 1,
                    updated_at: 1,
                    release_disposition: None,
                    launch: None,
                    archived_at: None,
                    delete_after: None,
                    deleted_at: None,
                    machine_missing_at: None,
                    repositories: None,
                    created_by: None,
                    creator: None,
                    last_activity_at: None,
                    idle_suspend_minutes: None,
                    revision: None,
                    runtime_activity: None,
                    authority: None,
                    you: None,
                    shared_with: None,
                    agent_command_kinds: None,
                    preparation: None,
                    checkout: None,
                    runtime: None,
                },
                latest_operation: None,
                following: None,
                read_markers: None,
                presence: None,
            }],
            tombstones: Vec::new(),
            quota: None,
        };
        assert_eq!(
            ensure_list(list, "org-one", RequestRisk::Read)
                .unwrap_err()
                .code,
            "cloud_workspace_invalid_response"
        );
    }

    #[test]
    fn delayed_success_error_and_create_are_fenced_after_account_replacement() {
        for (status, body, risk, sign_out) in [
            (
                "200 OK",
                r#"{"providers":[]}"#.to_string(),
                RequestRisk::Read,
                true,
            ),
            (
                "503 Service Unavailable",
                r#"{"error":"cloud_provider_unavailable"}"#.to_string(),
                RequestRisk::Read,
                false,
            ),
            ("202 Accepted", "{".to_string(), RequestRisk::Create, false),
        ] {
            let (base, accepted, request) =
                serve_once(response(status, &body, ""), Duration::from_millis(80));
            let (account, service) = test_service(&base);
            let handle = thread::spawn(move || match risk {
                RequestRisk::Read => service.providers().map(|_| ()),
                RequestRisk::Create => service
                    .create(None, CloudWorkspaceCreateInput {
                        name: "Product website".into(),
                        quote_id: "quote-1".into(),
                        access_mode: WorkspaceAccessMode::Private,
                        confirm_provider_spend: true,
                        idempotency_key: "original-key".into(),
                        repositories: Vec::new(),
                        launch: None,
                        preparation: false,
                    })
                    .map(|_| ()),
                RequestRisk::Mutation => unreachable!(),
            });
            accepted.recv_timeout(Duration::from_secs(1)).unwrap();
            if sign_out {
                account.set_context_for_test(None);
            } else {
                let mut replacement = context();
                replacement.generation += 1;
                replacement.organization_id = "org-2".into();
                replacement.access_token = "new-native-token".into();
                account.set_context_for_test(Some(replacement));
            }
            let error = handle.join().unwrap().unwrap_err();
            let captured = request.join().unwrap();
            assert!(!captured.extra_request);
            assert_eq!(error.code, "account_context_changed");
            if matches!(risk, RequestRisk::Create) {
                assert!(!error.retryable);
                assert!(error.retry_with_same_idempotency_key);
                assert!(error.requires_original_account_context);
            }
        }
    }

    #[test]
    fn validates_dynamic_resource_and_idempotency_identifiers() {
        assert!(valid_resource_id("workspace_1:v2"));
        assert!(!valid_resource_id("../workspace"));
        assert!(!valid_resource_id("."));
        assert!(!valid_resource_id(".."));
        assert!(valid_idempotency_key("pro10-create-01"));
        assert!(!valid_idempotency_key("line\nbreak"));

        let join_error = CloudWorkspaceClientError::task_failed(RequestRisk::Create);
        assert!(!join_error.retryable);
        assert!(join_error.retry_with_same_idempotency_key);
        assert!(join_error.requires_original_account_context);
    }

    #[test]
    fn secure_connect_input_contains_no_credential_field() {
        let input = CloudProviderConnectInput {
            context_revision: "test-context".into(),
            disclosure: CloudProviderDisclosure {
                version: "cloud-provider-connections-2026-08-13".into(),
                provider_billing_accepted: true,
                organization_use_accepted: true,
            },
        };
        let encoded = serde_json::to_value(input).unwrap();
        assert!(encoded.get("credential").is_none());
    }

    fn launch_input(repositories: Vec<CreateRepository>, launch: Option<CreateLaunch>) -> CloudWorkspaceCreateInput {
        CloudWorkspaceCreateInput {
            name: "  Fix login  ".into(),
            quote_id: "quote-1".into(),
            access_mode: WorkspaceAccessMode::Organization,
            confirm_provider_spend: true,
            idempotency_key: "launch key".into(),
            repositories,
            launch,
            preparation: false,
        }
    }

    fn repo(name: &str, base_ref: Option<&str>) -> CreateRepository {
        CreateRepository { clone_url: format!("https://github.com/acme/{name}.git"), base_ref: base_ref.map(String::from) }
    }

    #[test]
    fn create_sends_repositories_refs_and_the_launch_intent() {
        let mut body: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        body["workspace"]["launch"] = json!({
            "launchId": "launch_1", "phase": "allocating", "state": "pending",
            "workBranch": "terminalx/fix-login-3f9a2c1b7d4e", "agent": "claude", "model": "sonnet",
            "hasPrompt": true, "timings": { "requestedAt": 5 }, "somethingNewer": 1
        });
        let (base, _, request) = serve_once(response("202 Accepted", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let launch = CreateLaunch {
            agent: "claude".into(),
            model: Some("sonnet".into()),
            effort: Some("high".into()),
            mode: None,
            prompt: Some("Fix the login".into()),
            native_codex: false,
        };
        let result = service.create(None, launch_input(vec![repo("app", Some("main")), repo("lib", None)], Some(launch))).unwrap();
        let captured = request.join().unwrap();
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            sent,
            json!({
                "name": "Fix login", "quoteId": "quote-1", "accessMode": "organization", "confirmProviderSpend": true,
                "setup": { "version": 1, "credentialIds": [], "repositories": [
                    { "sourceProvider": "github", "cloneUrl": "https://github.com/acme/app.git", "ref": "main" },
                    { "sourceProvider": "github", "cloneUrl": "https://github.com/acme/lib.git" }
                ] },
                "launch": { "v": 1, "agent": "claude", "model": "sonnet", "effort": "high", "prompt": "Fix the login" }
            })
        );
        let launch = result.workspace.launch.expect("the launch view");
        assert_eq!((launch.phase.as_str(), launch.work_branch.as_str()), ("allocating", "terminalx/fix-login-3f9a2c1b7d4e"));
        assert_eq!(launch.timings.requested_at, Some(5));
    }

    /// #745: Native Codex at create reaches the launch intent, and a server
    /// from before the field (which refuses unknown keys, recording nothing)
    /// still gets the create, once more without it, under the same key.
    #[test]
    fn a_native_codex_launch_says_so_and_an_older_server_still_gets_the_create() {
        let body = |request: &str| serde_json::from_str::<Value>(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let key = |request: &str| request.lines().find(|line| line.to_ascii_lowercase().starts_with("idempotency-key:")).map(str::to_owned);
        let launch = CreateLaunch { agent: "codex".into(), model: None, effort: None, mode: None, prompt: Some("Fix the login".into()), native_codex: true };
        let native = json!({ "v": 1, "agent": "codex", "prompt": "Fix the login", "nativeCodex": true });
        let refused = response("422 Unprocessable Entity", r#"{"error":"cloud_workspace_request_invalid"}"#, "");

        let (base, server) = serve_each(vec![response("202 Accepted", &snapshot_body(None), "")]);
        let (_, service) = test_service(&base);
        service.create(None, launch_input(Vec::new(), Some(launch.clone()))).unwrap();
        let received = server.join().unwrap();
        assert_eq!(body(&received[0])["launch"], native);

        let (base, server) = serve_each(vec![refused.clone(), response("202 Accepted", &snapshot_body(None), "")]);
        let (_, service) = test_service(&base);
        service.create(None, launch_input(Vec::new(), Some(launch.clone()))).unwrap();
        let received = server.join().unwrap();
        assert_eq!(body(&received[0])["launch"], native);
        assert_eq!(body(&received[1])["launch"], json!({ "v": 1, "agent": "codex", "prompt": "Fix the login" }));
        assert_eq!(key(&received[1]), key(&received[0]));

        // A create refused for anything else is refused once more, not sent a third time.
        let (base, server) = serve_each(vec![refused.clone(), refused.clone(), response("202 Accepted", &snapshot_body(None), "")]);
        let (_, service) = test_service(&base);
        let error = service.create(None, launch_input(Vec::new(), Some(launch.clone()))).unwrap_err();
        assert_eq!((error.code.as_str(), error.status), ("cloud_workspace_request_invalid", Some(422)));
        assert_eq!(server.join().unwrap()[2], "", "no third request");

        // Without Native Codex the refusal is final: nothing to leave out.
        let (base, server) = serve_each(vec![refused, response("202 Accepted", &snapshot_body(None), "")]);
        let (_, service) = test_service(&base);
        let plain = CreateLaunch { native_codex: false, ..launch };
        assert!(service.create(None, launch_input(Vec::new(), Some(plain))).is_err());
        let received = server.join().unwrap();
        assert!(body(&received[0])["launch"].get("nativeCodex").is_none());
        assert_eq!(received[1], "", "sent once");

        // What the page sends: the key, only when on.
        let parsed: CreateLaunch = serde_json::from_value(json!({ "agent": "codex", "nativeCodex": true })).unwrap();
        assert!(parsed.native_codex);
        assert!(!serde_json::from_value::<CreateLaunch>(json!({ "agent": "codex" })).unwrap().native_codex);
    }

    #[test]
    fn a_preparation_create_says_so_and_its_stop_time_reaches_the_page() {
        let mut body: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        body["workspace"]["preparation"] = json!({ "stopAfter": 3_600_000, "somethingNewer": true });
        let (base, _, request) = serve_once(response("202 Accepted", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let mut input = launch_input(vec![repo("app", Some("main"))], None);
        input.preparation = true;
        let result = service.create(None, input).unwrap();
        let captured = request.join().unwrap();
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent["preparation"], json!(true));
        assert_eq!(result.workspace.preparation, Some(WorkspacePreparation { stop_after: 3_600_000 }));
        assert_eq!(serde_json::to_value(&result.workspace).unwrap()["preparation"], json!({ "stopAfter": 3_600_000 }));

        // An ordinary create never carries the key, and an ordinary workspace has no such field.
        let (base, _, request) = serve_once(response("202 Accepted", &snapshot_body(None), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let result = service.create(None, launch_input(vec![repo("app", Some("main"))], None)).unwrap();
        let captured = request.join().unwrap();
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert!(sent.get("preparation").is_none());
        assert!(serde_json::to_value(&result.workspace).unwrap().get("preparation").is_none());
    }

    #[test]
    fn invalid_names_repositories_refs_and_launches_never_reach_the_server() {
        let (_, service) = test_service("http://127.0.0.1:9");
        let launch = |agent: &str, prompt: Option<String>| Some(CreateLaunch { agent: agent.into(), model: None, effort: None, mode: None, prompt, native_codex: false });
        let cases = [
            (launch_input(vec![repo("app", Some("feature..x"))], None), "cloud_workspace_repository_ref_invalid"),
            (launch_input(vec![repo("app", Some("-evil"))], None), "cloud_workspace_repository_ref_invalid"),
            (launch_input(vec![repo("app", Some("a b"))], None), "cloud_workspace_repository_ref_invalid"),
            (launch_input(vec![repo("app", None), repo("app", Some("main"))], None), "cloud_workspace_repository_duplicate"),
            (launch_input((0..6).map(|i| repo(&format!("r{i}"), None)).collect(), None), "cloud_workspace_repositories_too_many"),
            (
                launch_input(vec![CreateRepository { clone_url: "https://gitlab.com/acme/app".into(), base_ref: None }], None),
                "cloud_workspace_repository_invalid",
            ),
            (launch_input(Vec::new(), launch("Claude", None)), "cloud_workspace_launch_invalid"),
            (launch_input(Vec::new(), launch("claude", Some("x".repeat(MAX_PROMPT_BYTES + 1)))), "cloud_workspace_prompt_too_long"),
        ];
        for (input, code) in cases {
            assert_eq!(service.create(None, input).unwrap_err().code, code);
        }
        let mut unnamed = launch_input(Vec::new(), None);
        unnamed.name = "   ".into();
        assert_eq!(service.create(None, unnamed).unwrap_err().code, "cloud_workspace_name_invalid");
    }

    #[test]
    fn policy_and_quota_refusals_are_definite_not_outcome_unknown() {
        for code in ["cloud_workspace_policy_denied", "cloud_workspace_quota_exceeded", "cloud_provisioning_paused", "cloud_environment_repository_not_in_image"] {
            let body = format!(r#"{{"error":"{code}"}}"#);
            let (base, _, request) = serve_once(response("409 Conflict", &body, ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let error = service.create(None, launch_input(vec![repo("app", None)], None)).unwrap_err();
            request.join().unwrap();
            assert_eq!(error.code, code);
            assert!(!error.retry_with_same_idempotency_key, "{code} is a definite answer");
        }
    }

    #[test]
    fn preflight_checks_the_repositories_and_lists_selected_ones() {
        let body = r#"{"version":1,"ready":false,"checks":[{"kind":"repository","cloneUrl":"https://github.com/acme/app.git","status":"failed","errorCode":"cloud_workspace_repository_ref_not_found","retryable":false}]}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let result = service.preflight(None, vec![repo("app", Some("nope"))], None).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/preflight "));
        assert!(captured.text.contains(r#""ref":"nope""#));
        assert!(captured.text.contains(r#""credentialIds":[]"#));
        assert!(!result.ready);
        assert_eq!(result.checks[0].error_code.as_deref(), Some("cloud_workspace_repository_ref_not_found"));

        let body = r#"{"configured":true,"canManage":false,"installations":[],"repositories":[{"id":"r1","installationId":"i1","githubRepositoryId":7,"fullName":"acme/app","cloneUrl":"https://github.com/acme/app.git","defaultBranch":"main","private":true,"state":"accessible","reason":null,"lastVerifiedAt":1}]}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let selected = service.selected_repositories(None).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/github-app "));
        assert_eq!(selected.repositories[0].full_name, "acme/app");
        assert_eq!(selected.repositories[0].default_branch.as_deref(), Some("main"));
    }

    #[test]
    fn phase2_automation_repository_identity_http_and_serde_compatibility() {
        let body = r#"{"configured":true,"repositories":[{"id":"row-r1","githubRepositoryId":7,"fullName":"acme/app","cloneUrl":"https://github.com/acme/app.git","state":"accessible"},{"fullName":"acme/old","state":"accessible"},{"id":null,"fullName":"acme/null","state":"missing"}]}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let selected = service.selected_repositories(None).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/github-app "));
        assert_eq!(selected.repositories[0].id.as_deref(), Some("row-r1"));
        assert_eq!(selected.repositories[1].id, None);
        assert_eq!(selected.repositories[2].id, None);
        let projected = serde_json::to_value(&selected).unwrap();
        assert_eq!(projected["repositories"][0]["id"], "row-r1");
        assert!(projected["repositories"][1]["id"].is_null());
        assert!(projected["repositories"][2]["id"].is_null());

        for invalid_id in [serde_json::json!(7), serde_json::json!(true), serde_json::json!({})] {
            let repository = serde_json::json!({"id": invalid_id, "fullName": "acme/app", "state": "accessible"});
            assert!(serde_json::from_value::<SelectedRepository>(repository).is_err());
        }
    }

    #[test]
    fn preflight_asks_about_the_agent_of_a_first_prompt() {
        // No repositories: the prompt's agent alone is worth the call, and the
        // setup names no repository rather than an empty list.
        let body = r#"{"version":1,"ready":false,"checks":[{"kind":"agent-credential","agent":"claude","provider":"claude","status":"failed","errorCode":"cloud_workspace_agent_credential_required","retryable":false}]}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let result = service.preflight(None, Vec::new(), Some("claude".into())).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/preflight?agent=claude "), "{}", captured.text.lines().next().unwrap_or_default());
        assert!(captured.text.contains(r#"{"setup":{"credentialIds":[],"version":1}}"#));
        assert_eq!(result.checks[0].agent.as_deref(), Some("claude"));
        assert_eq!(result.checks[0].error_code.as_deref(), Some("cloud_workspace_agent_credential_required"));

        // Nothing to check sends nothing; a malformed agent is refused here.
        let (_, service) = test_service("http://127.0.0.1:9");
        assert!(service.preflight(None, Vec::new(), None).unwrap().ready);
        assert_eq!(service.preflight(None, Vec::new(), Some("Not Valid".into())).unwrap_err().code, "cloud_workspace_launch_invalid");
    }

    #[test]
    fn a_failed_preflight_call_is_retryable_not_an_unknown_outcome() {
        let (base, _, request) = serve_once(response("503 Service Unavailable", "oops", ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.preflight(None, vec![repo("app", None)], None).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.retryable), ("cloud_workspace_unavailable", true));
    }

    fn diagnostics_body(organization_id: &str) -> String {
        json!({
            "v": 1, "organizationId": organization_id, "generatedAt": 10,
            "window": { "from": 1, "to": 10, "maxOperations": 200, "truncated": false },
            "stageTimings": { "create": { "samples": 0, "totalMs": { "p50": null, "p95": null }, "stages": {} } },
            "operations": [], "workspaces": [], "closeReasons": [],
            "newerField": { "ignored": true }
        })
        .to_string()
    }

    #[test]
    fn diagnostics_uses_the_desktop_contract_and_the_window() {
        let (base, _, request) = serve_once(response("200 OK", &diagnostics_body("org-1"), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let diagnostics = service.diagnostics(None, 7).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-diagnostics?windowDays=7 HTTP/1.1"));
        let lower = captured.text.to_ascii_lowercase();
        assert!(lower.contains("authorization: bearer native-secret-token"));
        assert!(lower.contains("x-terminalx-cloud-workspace-contract: providers-v1"));
        assert_eq!(diagnostics.window.max_operations, Some(200));
        assert_eq!(diagnostics.stage_timings.create.unwrap().total_ms.p50, None);
    }

    #[test]
    fn diagnostics_of_a_member_organization_use_its_own_path() {
        // An older server: another Organization is refused before any request.
        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.diagnostics(Some("org-2"), 7).unwrap_err().code, "cloud_organization_unavailable");

        // The target Organization is the path's; the server checks the role there.
        let (base, _, request) = serve_once(response("200 OK", &diagnostics_body("org-2"), ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.diagnostics(Some("org-2"), 7).unwrap().organization_id, "org-2");
        assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-2/cloud-diagnostics?windowDays=7 HTTP/1.1"));

        // An answer for another Organization than the one asked never lands.
        let (base, _, request) = serve_once(response("200 OK", &diagnostics_body("org-1"), ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.diagnostics(Some("org-2"), 7).unwrap_err().code, "cloud_workspace_invalid_response");
        request.join().unwrap();

        // A member of the target gets the server's refusal, whatever they are elsewhere.
        let (base, _, request) = serve_once(response("403 Forbidden", r#"{"error":"organization_admin_required"}"#, ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], true);
        assert_eq!(service.diagnostics(Some("org-2"), 7).unwrap_err().code, "organization_admin_required");
        request.join().unwrap();

        // Never an Organization the user is not a member of.
        assert_eq!(service.diagnostics(Some("org-3"), 7).unwrap_err().code, "cloud_organization_unavailable");
        // What the export and the close log are scoped to.
        assert_eq!(service.organization_in(None).unwrap(), "org-1");
        assert_eq!(service.organization_in(Some("org-2")).unwrap(), "org-2");
        assert_eq!(service.organization_in(Some("org-3")).unwrap_err().code, "cloud_organization_unavailable");
    }

    #[test]
    fn diagnostics_refusals_old_servers_and_foreign_answers() {
        let (base, _, request) = serve_once(response("403 Forbidden", r#"{"error":"organization_admin_required"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.diagnostics(None, 7).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("organization_admin_required", Some(403)));

        let (base, _, request) = serve_once(response("404 Not Found", "404 Not Found", ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.diagnostics(None, 30).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.retryable), ("cloud_diagnostics_not_supported", false));

        let (base, _, request) = serve_once(response("200 OK", &diagnostics_body("org-2"), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.diagnostics(None, 1).unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_workspace_invalid_response");

        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.diagnostics(None, 0).unwrap_err().code, "cloud_workspace_request_invalid");
        assert_eq!(service.diagnostics(None, 31).unwrap_err().code, "cloud_workspace_request_invalid");
    }

    #[test]
    fn archive_and_delete_send_force_only_when_asked_and_read_the_archive_vocabulary() {
        let mut archived: Value = serde_json::from_str(&snapshot_body(None)).unwrap();
        archived["workspace"]["state"] = json!("archived");
        archived["workspace"]["archivedAt"] = json!(10);
        archived["workspace"]["deleteAfter"] = json!(20);
        archived["operation"]["action"] = json!("archive");
        archived["operation"]["state"] = json!("succeeded");
        archived["operation"]["checkpoint"] = json!("committed");
        archived["operation"]["checkpointAt"] = json!(15);
        let (base, _, request) = serve_once(response("202 Accepted", &archived.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let snapshot = service.lifecycle_with(None, "workspace-1", OperationAction::Archive, true).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/archive HTTP/1.1"));
        assert!(captured.text.contains("X-TerminalX-Cloud-Workspace-Lifecycle: archive-v1"), "{}", captured.text);
        assert!(captured.text.ends_with(r#"{"force":true}"#));
        assert_eq!(snapshot.workspace.state, WorkspaceState::Archived);
        assert_eq!((snapshot.workspace.archived_at, snapshot.workspace.delete_after), (Some(10), Some(20)));
        assert!(matches!(snapshot.operation.action, Some(OperationAction::Archive)));
        assert_eq!(snapshot.operation.checkpoint.as_deref(), Some("committed"));
        assert_eq!(snapshot.operation.checkpoint_at, Some(15));

        // A chosen retention period rides on the archive; none is sent unless chosen.
        for (force, days, body) in [(false, Some(90), r#"{"retentionDays":90}"#), (true, Some(7), r#"{"force":true,"retentionDays":7}"#), (false, None, "{}")] {
            let (base, _, request) = serve_once(response("202 Accepted", &archived.to_string(), ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            service.archive(None, "workspace-1", force, days).unwrap();
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/archive HTTP/1.1"));
            assert!(captured.text.ends_with(body), "{}", captured.text);
        }
        let (_, service) = test_service("http://127.0.0.1:9");
        for days in [0, 366] {
            assert_eq!(service.archive(None, "workspace-1", false, Some(days)).unwrap_err().code, "cloud_workspace_request_invalid");
        }

        let mut deleting: Value = serde_json::from_str(&snapshot_body(Some("provider_cleanup_pending"))).unwrap();
        deleting["operation"]["action"] = json!("delete");
        deleting["operation"]["state"] = json!("running");
        deleting["operation"]["stage"] = json!("cleanup");
        deleting["operation"]["cleanup"] = json!({ "complete": false, "items": [
            { "kind": "provider-compute", "state": "removed" },
            { "kind": "provider-storage", "state": "pending", "providerStage": "waiting_for_uploads", "expectedBy": 99 },
            { "kind": "future-thing", "state": "someday" }
        ] });
        let (base, _, request) = serve_once(response("202 Accepted", &deleting.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let snapshot = service.lifecycle_with(None, "workspace-1", OperationAction::Delete, false).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/delete HTTP/1.1"));
        assert!(captured.text.ends_with("{}"), "no force unless the person confirmed it");
        let cleanup = snapshot.operation.cleanup.unwrap();
        assert!(!cleanup.complete);
        assert_eq!(cleanup.items[1].provider_stage.as_deref(), Some("waiting_for_uploads"));
        assert_eq!(cleanup.items[2].state, "someday", "unknown kinds and states reach the page");

        // Force is never sent for suspend.
        let (base, _, request) = serve_once(response("202 Accepted", &snapshot_body(None), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        service.lifecycle_with(None, "workspace-1", OperationAction::Suspend, true).unwrap();
        assert!(request.join().unwrap().text.ends_with("{}"));
    }

    #[test]
    fn active_work_and_archived_refusals_keep_their_codes() {
        for code in ["cloud_workspace_active_work", "cloud_workspace_archived", "cloud_teardown_in_progress"] {
            let (base, _, request) = serve_once(response("409 Conflict", &json!({ "error": code }).to_string(), ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let error = service.lifecycle_with(None, "workspace-1", OperationAction::Archive, false).unwrap_err();
            request.join().unwrap();
            assert_eq!((error.code.as_str(), error.status), (code, Some(409)));
        }
    }

    #[test]
    fn teardown_is_read_and_requested_for_that_organization_only() {
        let teardown = json!({
            "organizationId": "org-1", "disposition": "archive", "requestedAt": 10, "retentionDeadline": 40,
            "resources": [
                { "provider": "box", "id": "workspace-1", "kind": "workspace", "state": "archived", "releaseDisposition": "destroyed", "cleanupRequired": false, "deleteAfter": 40 },
                { "provider": "box", "id": "workspace-2", "kind": "workspace", "state": "destroyed", "releaseDisposition": null, "cleanupRequired": false }
            ],
            "remaining": [{ "provider": "box", "id": "workspace-1", "kind": "workspace", "state": "archived", "releaseDisposition": "destroyed", "cleanupRequired": false, "deleteAfter": 40 }]
        });
        let (base, _, request) = serve_once(response("200 OK", &teardown.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let status = service.teardown_status(None).unwrap().unwrap();
        assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-1/cloud-teardown HTTP/1.1"));
        assert_eq!((status.disposition.as_str(), status.retention_deadline, status.completed_at), ("archive", 40, None));
        assert_eq!((status.resources.len(), status.remaining.len(), status.remaining[0].delete_after), (2, 1, Some(40)));

        // None was ever asked for: not an error.
        let (base, _, request) = serve_once(response("404 Not Found", &json!({ "error": "cloud_teardown_not_found" }).to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert!(service.teardown_status(None).unwrap().is_none());
        request.join().unwrap();

        // A member is refused by the server, and that is said.
        let (base, _, request) = serve_once(response("403 Forbidden", &json!({ "error": "organization_admin_required" }).to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.teardown_status(None).unwrap_err().code, "organization_admin_required");
        request.join().unwrap();

        // The request reads the preview again, then sends what was confirmed with it.
        let preview = json!({ "organizationId": "org-1", "workspaces": 7, "othersPrivateWorkspaces": 3, "archivedWorkspaces": 2, "token": TOKEN });
        let revision = AccountManager::context_revision(&context());
        for (disposition, word) in [(TeardownDisposition::Archive, "archive"), (TeardownDisposition::Destroy, "destroy")] {
            let (base, requests) = serve_each(vec![response("200 OK", &preview.to_string(), ""), response("202 Accepted", &teardown.to_string(), "")]);
            let (_, service) = test_service(&base);
            service.request_teardown("org-1", &revision, disposition, &confirmed(7)).unwrap();
            let received = requests.join().unwrap();
            assert!(received[0].starts_with("GET /v1/desktop/orgs/org-1/cloud-teardown/preview HTTP/1.1"), "{}", received[0]);
            assert!(received[1].starts_with("POST /v1/desktop/orgs/org-1/cloud-teardown HTTP/1.1"), "{}", received[1]);
            let body: Value = serde_json::from_str(received[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body, json!({ "disposition": word, "expectedWorkspaces": 7, "previewToken": TOKEN }));
        }

        // An answer about another organization is never shown as this one's.
        let mut other = teardown.clone();
        other["organizationId"] = json!("org-2");
        let (base, _, request) = serve_once(response("200 OK", &other.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.teardown_status(None).unwrap_err().code, "cloud_workspace_invalid_response");
        request.join().unwrap();
        let (base, requests) = serve_each(vec![response("200 OK", &preview.to_string(), ""), response("202 Accepted", &other.to_string(), "")]);
        let (_, service) = test_service(&base);
        assert_eq!(service.request_teardown("org-1", &revision, TeardownDisposition::Destroy, &confirmed(7)).unwrap_err().code, "cloud_workspace_request_outcome_unknown");
        requests.join().unwrap();
    }

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    fn confirmed(workspaces: u32) -> ConfirmedTeardown {
        ConfirmedTeardown { expected_workspaces: workspaces, preview_token: TOKEN.into() }
    }

    #[test]
    fn a_teardown_is_not_sent_when_the_workspaces_are_not_the_ones_confirmed() {
        let revision = AccountManager::context_revision(&context());
        // Another workspace appeared since the count was shown, or the same number of different ones.
        for now in [
            json!({ "organizationId": "org-1", "workspaces": 8, "token": TOKEN }),
            json!({ "organizationId": "org-1", "workspaces": 7, "token": "QPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcba" }),
        ] {
            let (base, requests) = serve_each(vec![response("200 OK", &now.to_string(), ""), response("202 Accepted", "{}", "")]);
            let (_, service) = test_service(&base);
            let error = service.request_teardown("org-1", &revision, TeardownDisposition::Destroy, &confirmed(7)).unwrap_err();
            assert_eq!(error.code, "cloud_teardown_preview_changed");
            // Only the preview was read: no teardown request was made.
            let received = requests.join().unwrap();
            assert!(received[0].starts_with("GET ") && received[1].is_empty(), "{received:?}");
        }
        // The server refusing for the same reason keeps its code.
        let preview = json!({ "organizationId": "org-1", "workspaces": 7, "token": TOKEN });
        let (base, requests) = serve_each(vec![response("200 OK", &preview.to_string(), ""), response("409 Conflict", &json!({ "error": "cloud_teardown_preview_changed" }).to_string(), "")]);
        let (_, service) = test_service(&base);
        assert_eq!(service.request_teardown("org-1", &revision, TeardownDisposition::Archive, &confirmed(7)).unwrap_err().code, "cloud_teardown_preview_changed");
        requests.join().unwrap();
        // A token that is not one is never sent anywhere.
        let (_, service) = test_service("http://127.0.0.1:9");
        let bad = ConfirmedTeardown { expected_workspaces: 7, preview_token: "../x".into() };
        assert_eq!(service.request_teardown("org-1", &revision, TeardownDisposition::Archive, &bad).unwrap_err().code, "cloud_workspace_request_invalid");
    }

    #[test]
    fn a_teardown_confirmed_for_one_organization_is_never_sent_for_another() {
        // Nothing listens here: any request would fail as a transport error,
        // so `account_context_changed` proves nothing was sent.
        let revision = AccountManager::context_revision(&context());
        let (account, service) = test_service("http://127.0.0.1:9");

        // The confirmation named another organization than the active one.
        let error = service.request_teardown("org-2", &revision, TeardownDisposition::Destroy, &confirmed(7)).unwrap_err();
        assert_eq!(error.code, "account_context_changed");
        // The account context is not the one the confirmation was given at.
        assert_eq!(service.request_teardown("org-1", "old-context", TeardownDisposition::Destroy, &confirmed(7)).unwrap_err().code, "account_context_changed");

        // The active organization changed while the confirmation was open:
        // the name was typed for org-1, and org-2 is active at send time.
        account.set_context_for_test(Some(AccountContext { organization_id: "org-2".into(), ..context() }));
        assert_eq!(service.request_teardown("org-1", &revision, TeardownDisposition::Destroy, &confirmed(7)).unwrap_err().code, "account_context_changed");
        assert_eq!(service.request_teardown("org-1", &revision, TeardownDisposition::Archive, &confirmed(7)).unwrap_err().code, "account_context_changed");
        // The count is not read for an organization that is no longer active either.
        assert_eq!(service.teardown_preview("org-1").unwrap_err().code, "account_context_changed");
    }

    #[test]
    fn the_teardown_preview_counts_are_read_for_the_named_organization() {
        let preview = json!({ "organizationId": "org-1", "workspaces": 7, "othersPrivateWorkspaces": 3, "archivedWorkspaces": 2, "token": TOKEN });
        let (base, _, request) = serve_once(response("200 OK", &preview.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let read = service.teardown_preview("org-1").unwrap();
        assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-1/cloud-teardown/preview HTTP/1.1"));
        assert_eq!((read.workspaces, read.others_private_workspaces, read.archived_workspaces, read.token.as_str()), (7, 3, 2, TOKEN));

        // Counts about another organization are never shown as this one's.
        let other = json!({ "organizationId": "org-2", "workspaces": 1, "token": TOKEN });
        let (base, _, request) = serve_once(response("200 OK", &other.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.teardown_preview("org-1").unwrap_err().code, "cloud_workspace_invalid_response");
        request.join().unwrap();
    }

    #[test]
    fn a_disconnect_may_archive_and_its_deadline_is_read() {
        assert_eq!(json!({ "disposition": DisconnectDisposition::Archive }), json!({ "disposition": "archive" }));
        let connection: CloudProviderConnectionResponse = serde_json::from_value(json!({
            "provider": "box", "state": "connected", "canManage": true,
            "credentialFingerprint": "sha256:0123abcd", "connectedAt": 1, "lastValidatedAt": 2, "credentialVersion": 1,
            "operationsBlocked": true, "disconnectRetention": "archive", "retentionDeadline": 99, "resources": []
        }))
        .unwrap();
        assert!(connection.disconnect_disposition.is_none());
        assert_eq!((connection.disconnect_retention.as_deref(), connection.retention_deadline), (Some("archive"), Some(99)));
    }

    #[test]
    fn unarchive_and_the_list_tombstones() {
        let (base, _, request) = serve_once(response("200 OK", &snapshot_body(None), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        service.unarchive(None, "workspace-1").unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/unarchive HTTP/1.1"));

        let list = json!({ "workspaces": [], "tombstones": [{ "id": "workspace-9", "orgId": "org-1", "deletedAt": 5, "expiresAt": 6 }] });
        let (base, _, request) = serve_once(response("200 OK", &list.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.workspaces(None).unwrap();
        request.join().unwrap();
        assert_eq!(listed.tombstones.len(), 1);
        assert_eq!(listed.tombstones[0].id, "workspace-9");

        // A tombstone for another organization means the answer is not ours.
        let list = json!({ "workspaces": [], "tombstones": [{ "id": "workspace-9", "orgId": "org-2", "deletedAt": 5, "expiresAt": 6 }] });
        let (base, _, request) = serve_once(response("200 OK", &list.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert!(service.workspaces(None).is_err());
        request.join().unwrap();
    }

    /// A list as saas #137/#139 (PRO-56, PRO-76) sends it (§20.1), and what
    /// the Tauri command hands the webview for it. The TypeScript catalog's
    /// tests read the second file, so both sides test the same payload.
    const ENRICHED_LIST: &str = include_str!("../../src/lib/fixtures/cloudWorkspaceList.server.json");
    const ENRICHED_LIST_WEBVIEW: &str = include_str!("../../src/lib/fixtures/cloudWorkspaceList.webview.json");

    fn enriched_list() -> Value {
        serde_json::from_str(ENRICHED_LIST).unwrap()
    }

    #[test]
    fn the_enriched_list_reaches_the_webview_with_every_field() {
        let (base, _, request) = serve_once(response("200 OK", &enriched_list().to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.workspaces(None).unwrap();
        request.join().unwrap();
        let workspace = &listed.workspaces[0].workspace;
        assert_eq!(workspace.repositories.as_ref().unwrap()[0].identity.as_deref(), Some("github.com/acme/api"));
        assert_eq!(workspace.runtime_activity.as_ref().unwrap().pending_approvals, 2);
        assert_eq!(workspace.authority.as_deref(), Some("participate"));

        // What the Tauri command hands the webview: every known field, camelCase, unchanged.
        let sent = serde_json::to_value(&listed).unwrap();
        let expected = enriched_list();
        for (field, value) in expected["workspaces"][0]["workspace"].as_object().unwrap() {
            if field == "aFutureField" {
                assert!(sent["workspaces"][0]["workspace"].get(field).is_none());
            } else {
                assert_eq!(&sent["workspaces"][0]["workspace"][field], value, "{field}");
            }
        }
        assert_eq!(sent["quota"], expected["quota"]);
        assert_eq!(sent["tombstones"], expected["tombstones"]);
        assert!(sent.get("aFutureListField").is_none());
        assert_eq!(sent, serde_json::from_str::<Value>(ENRICHED_LIST_WEBVIEW).unwrap());
    }

    #[test]
    fn an_old_servers_list_still_parses_and_is_passed_on_as_before() {
        let (base, _, request) = serve_once(response("200 OK", &org_2_list_body().replace("org-2", "org-1"), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.workspaces(None).unwrap();
        request.join().unwrap();
        let workspace = &listed.workspaces[0].workspace;
        assert!(workspace.repositories.is_none() && workspace.runtime_activity.is_none() && workspace.authority.is_none());
        assert!(listed.quota.is_none());
        let sent = serde_json::to_value(&listed).unwrap();
        for field in ["repositories", "createdBy", "lastActivityAt", "runtimeActivity", "revision", "authority", "machineMissingAt"] {
            assert!(sent["workspaces"][0]["workspace"].get(field).is_none(), "{field}");
        }
        assert!(sent.get("quota").is_none());
        // A pre-PRO-76 quota has no running or total.
        let quota: CloudWorkspaceQuota = serde_json::from_value(json!({ "used": 1, "limit": 2 })).unwrap();
        assert_eq!(serde_json::to_value(quota).unwrap(), json!({ "used": 1, "limit": 2 }));
    }

    #[test]
    fn a_machine_the_server_says_is_gone_reaches_the_webview() {
        // #1589: the server states it on the workspace, and the page reads it there.
        let mut list: Value = serde_json::from_str(&org_2_list_body().replace("org-2", "org-1")).unwrap();
        list["workspaces"][0]["workspace"]["state"] = json!("attention-required");
        list["workspaces"][0]["workspace"]["machineMissingAt"] = json!(1_795_305_607_000_i64);
        let parsed: CloudWorkspaceList = serde_json::from_value(list).unwrap();
        assert_eq!(parsed.workspaces[0].workspace.machine_missing_at, Some(1_795_305_607_000));
        assert_eq!(serde_json::to_value(&parsed).unwrap()["workspaces"][0]["workspace"]["machineMissingAt"], json!(1_795_305_607_000_i64));

        // A malformed value reads as absent rather than failing the list.
        let mut list: Value = serde_json::from_str(&org_2_list_body().replace("org-2", "org-1")).unwrap();
        list["workspaces"][0]["workspace"]["machineMissingAt"] = json!("yesterday");
        let parsed: CloudWorkspaceList = serde_json::from_value(list).unwrap();
        assert_eq!(parsed.workspaces[0].workspace.machine_missing_at, None);
        assert!(serde_json::to_value(&parsed).unwrap()["workspaces"][0]["workspace"].get("machineMissingAt").is_none());
    }

    #[test]
    fn a_quota_without_a_limit_is_passed_on_without_one() {
        // PRO-371: the server leaves `limit` out where the organization has none.
        let sent = json!({ "used": 3, "running": { "used": 3 }, "total": { "used": 60 } });
        let quota: CloudWorkspaceQuota = serde_json::from_value(sent.clone()).unwrap();
        assert_eq!((quota.limit, quota.running.unwrap().limit, quota.total.unwrap().limit), (None, None, None));
        assert_eq!(serde_json::to_value(&quota).unwrap(), sent);

        // A null limit reads the same, and never reaches the webview as null.
        let quota: CloudWorkspaceQuota = serde_json::from_value(json!({ "used": 3, "limit": null, "running": { "used": 3, "limit": null }, "total": { "used": 60, "limit": 100 } })).unwrap();
        assert_eq!(serde_json::to_value(&quota).unwrap(), json!({ "used": 3, "running": { "used": 3 }, "total": { "used": 60, "limit": 100 } }));

        // One limit set, the other not.
        let mut list: Value = serde_json::from_str(&org_2_list_body().replace("org-2", "org-1")).unwrap();
        list["quota"] = json!({ "used": 100, "limit": 100, "running": { "used": 100, "limit": 100 }, "total": { "used": 500 } });
        let parsed: CloudWorkspaceList = serde_json::from_value(list.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap()["quota"], list["quota"]);

        // A limit that is not a count is not "no limit": the quota is dropped whole.
        list["quota"] = json!({ "used": 3, "limit": "many" });
        assert!(serde_json::from_value::<CloudWorkspaceList>(list).unwrap().quota.is_none());
    }

    #[test]
    fn a_malformed_new_field_reads_as_absent_but_the_old_fields_stay_strict() {
        let mut list = enriched_list();
        let workspace = &mut list["workspaces"][0]["workspace"];
        workspace["repositories"] = json!("github.com/acme/api");
        workspace["runtimeActivity"] = json!({ "activeTurns": -1 });
        workspace["authority"] = json!(3);
        list["quota"] = json!({ "used": "one" });
        let parsed: CloudWorkspaceList = serde_json::from_value(list.clone()).unwrap();
        let workspace = &parsed.workspaces[0].workspace;
        assert!(workspace.repositories.is_none() && workspace.runtime_activity.is_none() && workspace.authority.is_none());
        assert!(parsed.quota.is_none());
        assert_eq!(workspace.created_by.as_deref(), Some("user_1"));

        for (field, value) in [("id", json!(null)), ("orgId", json!(1)), ("state", json!("melting")), ("createdAt", json!("soon"))] {
            let mut broken = enriched_list();
            broken["workspaces"][0]["workspace"][field] = value;
            assert!(serde_json::from_value::<CloudWorkspaceList>(broken).is_err(), "{field}");
        }
        let mut broken = enriched_list();
        broken["workspaces"][0]["workspace"].as_object_mut().unwrap().remove("updatedAt");
        assert!(serde_json::from_value::<CloudWorkspaceList>(broken).is_err());
    }

    #[test]
    fn disposition_reads_the_server_facts_for_that_workspace_only() {
        let facts = json!({
            "workspaceId": "workspace-1", "state": "ready", "provider": "box",
            "activeOperation": { "id": "operation-1", "action": "resume", "state": "running" },
            "runtime": { "reporting": true, "reportedAt": 1, "stale": false, "activeTurns": 1, "pendingApprovals": 2 },
            "attachedClients": 1,
            "providerCapabilities": { "permanentDelete": true, "releaseDisposition": "destroyed" },
            "archiveRetentionDays": 30,
            "archiveRetentionChoices": [7, 30, 90],
            "blockers": ["active-turns", "pending-approvals"],
            "removedOnDelete": ["runtime-credentials", "provider-storage"],
            "runtimeFacts": { "namespace": "lifecycle/1", "method": "lifecycle.dispositionFacts", "available": true }
        });
        let (base, _, request) = serve_once(response("200 OK", &facts.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let disposition = service.disposition(None, "workspace-1").unwrap();
        assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/disposition HTTP/1.1"));
        assert_eq!(disposition.runtime.active_turns, 1);
        assert_eq!(disposition.blockers, ["active-turns", "pending-approvals"]);
        assert!(disposition.runtime_facts.available);
        assert_eq!(disposition.archive_retention_choices, [7, 30, 90]);
        // An older server does not say what a resume brings back.
        assert_eq!(disposition.provider_capabilities.preserves_processes_on_resume, None);

        let mut cold = facts.clone();
        cold["providerCapabilities"]["preservesProcessesOnResume"] = json!(false);
        let (base, _, request) = serve_once(response("200 OK", &cold.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.disposition(None, "workspace-1").unwrap().provider_capabilities.preserves_processes_on_resume, Some(false));
        request.join().unwrap();

        let (base, _, request) = serve_once(response("200 OK", &facts.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.disposition(None, "workspace-2").unwrap_err().code, "cloud_workspace_invalid_response");
        request.join().unwrap();
    }

    fn share_json(user_id: &str, role: &str) -> Value {
        json!({
            "userId": user_id, "email": format!("{user_id}@example.com"), "name": "Alice",
            "role": role, "canApprove": false, "createdBy": "user-1", "createdAt": 1, "updatedAt": 2
        })
    }

    fn enable_workspace_groups(account: &AccountManager, org: &str) -> String {
        account.apply_phase2_readiness_for_test(json!({
            "version": 1,
            "organizations": { (org): { (PHASE2_WORKSPACE_GROUPS): true } }
        }));
        AccountManager::context_revision(&account.context().unwrap())
    }

    fn workspace_group_access_request(body: &Value) -> CloudAccessApply {
        serde_json::from_value(body.clone()).unwrap()
    }

    #[test]
    fn workspace_group_sharing_projects_target_search_pages_and_held_share_reads() {
        let group = json!({"id": "group@opaque", "name": "Release crew", "memberCount": 3});
        let you = json!({"role": "manager", "canApprove": true, "canManageShares": true});
        let legacy = json!({"shares": [], "you": you});
        let response_snapshot = json!({"shares": [], "you": you, "accessRevision": "rev:1",
            "groupShares": [{"groupId": "group@opaque", "role": "viewer", "canApprove": true, "group": group}]});
        let mut future_snapshot = response_snapshot.clone();
        future_snapshot["groupShares"][0]["role"] = json!("unknown-role");
        let search = json!({"groups": [group], "nextCursor": "next+not-a-valid-id"});
        let (base, captured) = serve_each(vec![
            response("200 OK", &future_snapshot.to_string(), ""),
            response("200 OK", &response_snapshot.to_string(), ""),
            response("200 OK", &json!({"groups": [group], "nextCursor": "next@opaque"}).to_string(), ""),
            response("200 OK", &json!({"groups": [], "nextCursor": null}).to_string(), ""),
            response("200 OK", &search.to_string(), ""),
        ]);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], false);
        let revision = enable_workspace_groups(&account, "org-2");
        assert_eq!(service.workspace_groups("org-1", "", None, &revision).unwrap_err().code, "cloud_workspace_groups_unavailable");
        assert_eq!(service.workspace_groups("org-non-member", "", None, &revision).unwrap_err().code, "cloud_organization_unavailable");
        assert_eq!(service.workspace_groups("org-2", "", None, "another-account").unwrap_err().code, "account_context_changed");
        assert_eq!(serde_json::to_value(service.shares(Some("org-1"), "workspace-1", None).unwrap()).unwrap(), legacy);
        assert_eq!(serde_json::to_value(service.shares(Some("org-2"), "workspace-1", Some(&revision)).unwrap()).unwrap(), response_snapshot);
        let first = service.workspace_groups("org-2", "Rel & % É", None, &revision).unwrap();
        assert_eq!(first.groups[0].member_count, 3);
        service.workspace_groups("org-2", "Rel & % É", first.next_cursor.as_deref(), &revision).unwrap();
        assert_eq!(service.workspace_groups("org-2", "", None, &revision).unwrap_err().code, "cloud_workspace_invalid_response");
        let requests = captured.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares "));
        assert!(requests[1].starts_with("GET /v1/desktop/orgs/org-2/cloud-workspaces/workspace-1/shares "));
        assert!(requests[2].starts_with("GET /v1/desktop/orgs/org-2/groups?q=Rel+%26+%25+%C3%89 "));
        assert!(requests[3].starts_with("GET /v1/desktop/orgs/org-2/groups?q=Rel+%26+%25+%C3%89&cursor=next%40opaque "));
        for request in requests { phase2_headers(&request); }
    }

    #[test]
    fn workspace_group_sharing_applies_one_envelope_preserves_partial_results_and_same_payload_retries() {
        let submit = json!({"accessRevision": "opaque:r1", "requestId": "request-1", "changes": [
            {"id": "one", "op": "put", "subject": {"type": "group", "id": "group-1"}, "role": "viewer", "canApprove": false},
            {"id": "two", "op": "remove", "subject": {"type": "user", "id": "user-1"}}
        ]});
        let snapshot = json!({"accessRevision": "opaque:r2", "shares": [], "groupShares": [], "results": [
            {"id": "one", "status": "applied"},
            {"id": "two", "status": "failed", "code": "cloud_workspace_last_admin", "message": "Keep an administrator."}
        ]});
        let mut invalid = snapshot.clone();
        invalid["results"][0]["id"] = json!("unexpected");
        let (base, captured) = serve_each(vec![
            response("503 Service Unavailable", r#"{"error":"cloud_workspace_share_unavailable"}"#, ""),
            response("200 OK", &snapshot.to_string(), ""),
            response("200 OK", &invalid.to_string(), ""),
            response("409 Conflict", r#"{"error":"cloud_workspace_access_revision_conflict"}"#, ""),
        ]);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1"], false);
        let revision = enable_workspace_groups(&account, "org-1");
        let mut duplicate = submit.clone();
        duplicate["changes"][1]["id"] = json!("one");
        let apply = |body: &Value| {
            service.apply_shares("org-1", "workspace-1", workspace_group_access_request(body), &revision)
                .map(|response| serde_json::to_value(response).unwrap())
        };
        assert_eq!(apply(&duplicate).unwrap_err().code, "cloud_workspace_request_invalid");
        let unavailable = apply(&submit).unwrap_err();
        assert_eq!(unavailable.code, "cloud_workspace_share_unavailable");
        assert!(unavailable.retry_with_same_idempotency_key && unavailable.requires_original_account_context);
        assert_eq!(apply(&submit).unwrap(), snapshot);
        let unknown = apply(&submit).unwrap_err();
        assert_eq!(unknown.code, "cloud_workspace_request_outcome_unknown");
        assert!(unknown.retry_with_same_idempotency_key);
        let conflict = apply(&submit).unwrap_err();
        assert_eq!(conflict.code, "cloud_workspace_access_revision_conflict");
        assert!(!conflict.retry_with_same_idempotency_key);
        for request in captured.join().unwrap() {
            assert!(request.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares/apply "));
            phase2_headers(&request);
            assert_eq!(serde_json::from_str::<Value>(request.split_once("\r\n\r\n").unwrap().1).unwrap(), submit);
        }
    }

    #[test]
    fn workspace_group_sharing_preserves_sent_mutation_outcomes_when_readiness_is_withdrawn() {
        let submit = json!({"accessRevision": "rev:1", "requestId": "request-1", "changes": [
            {"id": "one", "op": "remove", "subject": {"type": "user", "id": "user-1"}}
        ]});
        let reply = json!({"accessRevision": "rev:2", "shares": [], "groupShares": [],
            "results": [{"id": "one", "status": "applied"}]});
        let fixtures = [
            (response("200 OK", &reply.to_string(), ""), None, false),
            (response("409 Conflict", r#"{"error":"cloud_workspace_access_revision_conflict"}"#, ""),
                Some("cloud_workspace_access_revision_conflict"), false),
            (response("200 OK", "", ""), Some("cloud_workspace_request_outcome_unknown"), true),
        ];
        for (response, expected_error, retry) in fixtures {
            let (release, wait) = mpsc::channel();
            let (base, accepted, captured) =
                serve_once_after(response, move || wait.recv_timeout(Duration::from_secs(2)).unwrap());
            let (account, service) = test_service(&base);
            account.set_memberships_for_test(&["org-1"], false);
            let revision = enable_workspace_groups(&account, "org-1");
            let request = workspace_group_access_request(&submit);
            let worker = thread::spawn(move || service.apply_shares("org-1", "workspace-1", request, &revision));
            accepted.recv_timeout(Duration::from_secs(2)).unwrap();
            account.apply_phase2_readiness_for_test(json!({"version": 1, "organizations": {}}));
            assert!(!account.phase2_ready(PHASE2_WORKSPACE_GROUPS, Some("org-1"), None));
            release.send(()).unwrap();
            match (worker.join().unwrap(), expected_error) {
                (Ok(value), None) => assert_eq!(serde_json::to_value(value).unwrap(), reply),
                (Err(error), Some(code)) => {
                    assert_eq!(error.code, code);
                    assert_eq!(error.retry_with_same_idempotency_key, retry);
                }
                _ => panic!("readiness withdrawal changed the mutation outcome"),
            }
            let request = captured.join().unwrap();
            assert_eq!(serde_json::from_str::<Value>(request.text.split_once("\r\n\r\n").unwrap().1).unwrap(), submit);
            assert!(!request.extra_request);
        }
    }

    #[test]
    fn phase2_admin_share_contract_get_mixed_nullable_rows_and_effective_you() {
        for effective in ["manager", "driver", "viewer", "none"] {
            let mut manager = share_json("user-2", "manager");
            manager["name"] = Value::Null;
            manager["canApprove"] = json!(true);
            manager["createdAt"] = json!(1_731_000_000_123_i64);
            manager["updatedAt"] = json!(1_731_000_000_456_i64);
            let body = json!({"shares": [manager, share_json("user-3", "viewer"), share_json("user-4", "driver")],
                "you": {"role": effective, "canApprove": true, "canManageShares": effective == "manager"}});
            let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let listed = service.shares(None, "workspace-1", None).unwrap();
            assert_eq!(serde_json::to_value(&listed).unwrap(), body);
            assert_eq!(listed.shares[0].role, ShareRole::Manager);
            assert_eq!(listed.shares[0].name, None);
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares HTTP/1.1"));
            phase2_headers(&captured.text);
            assert_eq!(captured.text.split_once("\r\n\r\n").unwrap().1, "");
            assert!(!captured.extra_request);
        }
    }

    #[test]
    fn phase2_admin_grant_requires_target_readiness_and_the_original_context() {
        let mut manager = share_json("user-2", "manager");
        manager["canApprove"] = json!(true);
        let body = json!({ "share": manager, "created": false });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (account, service) = test_service(&base);
        account.set_memberships_for_test(&["org-1", "org-2"], false);
        account.apply_phase2_readiness_for_test(json!({
            "version": 1, "organizations": { "org-2": { (PHASE2_ADMIN_SHARE): true } }
        }));
        let revision = AccountManager::context_revision(&context());
        let held = service.share_put_in_context(
            Some("org-1"), "workspace-1", "user-2", ShareRole::Manager, true, Some(&revision),
        ).unwrap_err();
        assert_eq!(held.code, "cloud_workspace_runtime_not_ready");
        assert!(service.share_put_in_context(
            Some("org-2"), "workspace-1", "user-2", ShareRole::Manager, true, Some("replaced"),
        ).is_err());
        assert_eq!(service.share_put_in_context(
            Some("org-2"), "workspace-1", "user-2", ShareRole::Manager, true, Some(&revision),
        ).unwrap().share.role, ShareRole::Manager);

        let sent = request.join().unwrap().text;
        assert!(sent.starts_with("PUT /v1/desktop/orgs/org-2/cloud-workspaces/workspace-1/shares/user-2 HTTP/"));
        assert!(sent.contains(r#""canApprove":true"#));
    }

    #[test]
    fn phase2_admin_share_contract_enabled_manager_put_and_delete_receipts() {
        for method in ["PUT", "DELETE"] {
            for created in [true, false] {
                let mut share = share_json("user-2", "manager");
                share["name"] = Value::Null;
                share["canApprove"] = json!(true);
                let body = if method == "PUT" { json!({"share": share, "created": created}) }
                    else { json!({"share": share}) };
                let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
                let (_, service) = phase2_service(&base);
                let receipt = if method == "PUT" {
                    service.share_put(None, "workspace-1", "user-2", ShareRole::Manager, true).unwrap()
                } else { service.share_revoke(None, "workspace-1", "user-2").unwrap() };
                assert_eq!(serde_json::to_value(receipt).unwrap(), body);
                let captured = request.join().unwrap();
                assert!(captured.text.starts_with(&format!("{method} /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares/user-2 HTTP/1.1")));
                phase2_headers(&captured.text);
                let sent = captured.text.split_once("\r\n\r\n").unwrap().1;
                if method == "PUT" {
                    assert_eq!(serde_json::from_str::<Value>(sent).unwrap(), json!({"v": 1, "role": "manager", "canApprove": true}));
                } else { assert_eq!(sent, ""); }
                assert!(!captured.text.to_ascii_lowercase().contains("idempotency-key:"));
                assert!(!captured.extra_request);
            }
        }
    }

    #[test]
    fn phase2_admin_share_contract_manager_holds_and_invalid_inputs_never_send() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (account, mut service) = test_service(&base);
        // The production constructor and its HTTP fixture both start held.
        assert!(!CloudWorkspaceService::new(account).phase2_contracts_available());
        for enabled in [false, true] {
            service.force_phase2_for_test = enabled;
            let error = service.share_put(None, "workspace-1", "user-2", ShareRole::Manager, false).unwrap_err();
            assert_eq!(error.code, "cloud_workspace_runtime_unsupported");
            assert_eq!(serde_json::to_value(error).unwrap(), json!({"code": "cloud_workspace_runtime_unsupported",
                "status": null, "retryable": false, "retryAfterSeconds": null,
                "retryWithSameIdempotencyKey": false, "requiresOriginalAccountContext": false}));
            if !enabled {
                let error = service.share_put(None, "workspace-1", "user-2", ShareRole::Manager, true).unwrap_err();
                assert_eq!(error.code, "cloud_workspace_runtime_not_ready");
                assert!(error.status.is_none());
            }
            for invalid in ["", "../user", "user/2", "user?x", ".", ".."] {
                assert_eq!(service.share_put(None, "workspace-1", invalid, ShareRole::Manager, true).unwrap_err().code, "cloud_workspace_request_invalid");
                assert_eq!(service.share_revoke(None, "workspace-1", invalid).unwrap_err().code, "cloud_workspace_request_invalid");
                assert_eq!(service.shares(None, invalid, None).unwrap_err().code, "cloud_workspace_request_invalid");
                assert_eq!(service.share_put(None, invalid, "user-2", ShareRole::Viewer, false).unwrap_err().code, "cloud_workspace_request_invalid");
                assert_eq!(service.share_revoke(Some(invalid), "workspace-1", "user-2").unwrap_err().code, "cloud_workspace_request_invalid");
            }
        }
        // Tauri deserializes this same type before invoking the service. Invalid
        // wire roles must never coerce into a fallback grant or reach HTTP.
        for role in ["admin", "owner", "Manager", "none", "", "writer"] {
            assert!(serde_json::from_value::<ShareRole>(json!(role)).is_err());
        }
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn phase2_admin_share_contract_legacy_production_put_approval_is_independent() {
        for (role, wire) in [(ShareRole::Viewer, "viewer"), (ShareRole::Driver, "driver")] {
            for can_approve in [false, true] {
                let mut share = share_json("user-2", wire);
                share["canApprove"] = json!(can_approve);
                let body = json!({"share": share, "created": false});
                let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
                let (_, service) = test_service(&base);
                assert!(!service.phase2_contracts_available());
                let receipt = service.share_put(None, "workspace-1", "user-2", role, can_approve).unwrap();
                assert_eq!(receipt.share.can_approve, can_approve);
                assert_eq!(receipt.share.role, role);
                assert_eq!(receipt.created, Some(false));
                let captured = request.join().unwrap();
                phase2_headers(&captured.text);
                assert!(captured.text.starts_with("PUT /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares/user-2 HTTP/1.1"));
                assert_eq!(serde_json::from_str::<Value>(captured.text.split_once("\r\n\r\n").unwrap().1).unwrap(),
                    json!({"v": 1, "role": wire, "canApprove": can_approve}));
                assert!(!captured.extra_request);
            }
        }
    }

    #[test]
    fn phase2_admin_share_contract_target_member_without_capability_or_active_org() {
        for active_org in ["org-1", ""] {
            let bodies = [
                json!({"shares": [], "you": {"role": "none", "canApprove": false, "canManageShares": false}}),
                json!({"share": share_json("user-2", "viewer"), "created": false}),
                json!({"share": share_json("user-2", "manager")}),
            ];
            let (base, requests) = serve_each(bodies.iter().map(|body| response("200 OK", &body.to_string(), "")).collect());
            let (account, service) = test_service(&base);
            let mut current = context();
            current.organization_id = active_org.into();
            account.set_context_for_test(Some(current));
            account.set_memberships_for_test(&["org-2"], false);
            if active_org.is_empty() {
                let error = service.shares(None, "workspace-1", None).unwrap_err();
                assert_eq!(error.code, "account_organization_unavailable");
                assert!(error.status.is_none());
                assert_eq!(service.share_put(None, "workspace-1", "user-2", ShareRole::Viewer, false).unwrap_err().code, "account_organization_unavailable");
                assert_eq!(service.share_revoke(None, "workspace-1", "user-2").unwrap_err().code, "account_organization_unavailable");
            }
            service.shares(Some("org-2"), "workspace-1", None).unwrap();
            service.share_put(Some("org-2"), "workspace-1", "user-2", ShareRole::Viewer, false).unwrap();
            service.share_revoke(Some("org-2"), "workspace-1", "user-2").unwrap();
            for (request, method) in requests.join().unwrap().iter().zip(["GET", "PUT", "DELETE"]) {
                assert!(request.starts_with(&format!("{method} /v1/desktop/orgs/org-2/cloud-workspaces/workspace-1/shares")));
                phase2_headers(request);
            }
            // The same target remains unavailable to legacy provider transport.
            assert_eq!(service.teardown_status(Some("org-2")).unwrap_err().code, "cloud_organization_unavailable");
        }
    }

    #[test]
    fn phase2_admin_share_contract_nonmembership_and_private_errors_fail_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let (_, service) = test_service(&format!("http://{}", listener.local_addr().unwrap()));
        assert_eq!(service.shares(Some("org-2"), "workspace-1", None).unwrap_err().code, "cloud_organization_unavailable");
        assert_eq!(service.share_put(Some("org-2"), "workspace-1", "user-2", ShareRole::Viewer, false).unwrap_err().code, "cloud_organization_unavailable");
        assert_eq!(service.share_revoke(Some("org-2"), "workspace-1", "user-2").unwrap_err().code, "cloud_organization_unavailable");
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        for method in ["GET", "PUT", "DELETE"] {
            let (base, _, request) = serve_once(response("404 Not Found", r#"{"error":"cloud_workspace_not_found"}"#, ""), Duration::ZERO);
            let (account, service) = test_service(&base);
            account.set_memberships_for_test(&["org-1", "org-2"], false);
            let error = match method {
                "GET" => service.shares(Some("org-2"), "private-workspace", None).unwrap_err(),
                "PUT" => service.share_put(Some("org-2"), "private-workspace", "user-2", ShareRole::Viewer, false).unwrap_err(),
                _ => service.share_revoke(Some("org-2"), "private-workspace", "user-2").unwrap_err(),
            };
            assert_eq!(error.code, "cloud_workspace_not_found");
            assert_eq!(error.status, Some(404));
            assert!(!request.join().unwrap().extra_request);
        }
    }

    #[test]
    fn phase2_admin_share_contract_late_context_fences_success_and_error_for_all_routes() {
        for method in ["GET", "PUT", "DELETE"] {
            for success in [false, true] {
                for change in ["sign-out", "account", "profile", "organization", "session", "token-only", "A-B-A", "membership"] {
                    let body = if !success { json!({"error": "cloud_workspace_last_admin"}) }
                        else if method == "GET" { json!({"shares": [], "you": {"role": "manager", "canApprove": true, "canManageShares": true}}) }
                        else { json!({"share": share_json("user-2", "manager"), "created": false}) };
                    let (base, accepted, request) = serve_once(response(if success { "200 OK" } else { "409 Conflict" }, &body.to_string(), ""), Duration::from_millis(150));
                    let (account, service) = phase2_service(&base);
                    account.set_memberships_for_test(&["org-1", "org-2"], false);
                    let pending = thread::spawn(move || match method {
                        "GET" => service.shares(Some("org-2"), "workspace-1", None).map(|_| ()),
                        "PUT" => service.share_put(Some("org-2"), "workspace-1", "user-2", ShareRole::Manager, true).map(|_| ()),
                        _ => service.share_revoke(Some("org-2"), "workspace-1", "user-2").map(|_| ()),
                    });
                    accepted.recv_timeout(Duration::from_secs(2)).unwrap();
                    if change == "sign-out" { account.set_context_for_test(None); }
                    else if change == "membership" { account.set_memberships_for_test(&["org-1"], false); }
                    else {
                        let mut replacement = context();
                        match change {
                            "account" => replacement.user_id = "user-other".into(),
                            "profile" => replacement.profile_id = "profile-other".into(),
                            "organization" => replacement.organization_id = "org-other".into(),
                            "session" => replacement.generation += 1,
                            "token-only" => replacement.access_token = "rotated-token".into(),
                            "A-B-A" => {
                                let mut other = context();
                                other.user_id = "user-other".into(); other.generation += 1;
                                account.set_context_for_test(Some(other));
                                replacement.generation += 2;
                            }
                            _ => unreachable!(),
                        }
                        account.set_context_for_test(Some(replacement));
                        account.set_memberships_for_test(&["org-1", "org-2"], false);
                    }
                    let error = pending.join().unwrap().unwrap_err();
                    assert_eq!(error.code, "account_context_changed", "{method}/{success}/{change}");
                    assert!(error.status.is_none());
                    assert_eq!(error.requires_original_account_context, method != "GET");
                    assert!(!request.join().unwrap().extra_request);
                }
            }
        }
    }

    #[test]
    fn phase2_admin_share_contract_foreign_user_and_unknown_response_roles_refuse() {
        for method in ["GET", "PUT", "DELETE"] {
            for invalid in ["foreign-user", "unknown-role", "invalid-user-id"] {
                // A different valid user is allowed in GET's roster, but never
                // in the receipt for a specific PUT/DELETE target.
                if method == "GET" && invalid == "foreign-user" { continue; }
                let mut share = share_json(if invalid == "foreign-user" { "user-other" } else { "user-2" }, "manager");
                if invalid == "unknown-role" { share["role"] = json!("admin"); }
                if invalid == "invalid-user-id" { share["userId"] = json!("../user"); }
                let body = if method == "GET" { json!({"shares": [share], "you": {"role": "manager", "canApprove": true, "canManageShares": true}}) }
                    else { json!({"share": share, "created": false}) };
                let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
                let (_, service) = phase2_service(&base);
                let error = match method {
                    "GET" => service.shares(None, "workspace-1", None).unwrap_err(),
                    "PUT" => service.share_put(None, "workspace-1", "user-2", ShareRole::Manager, true).unwrap_err(),
                    _ => service.share_revoke(None, "workspace-1", "user-2").unwrap_err(),
                };
                assert_eq!(error.code, if method == "GET" { "cloud_workspace_invalid_response" } else { "cloud_workspace_request_outcome_unknown" });
                assert!(!request.join().unwrap().extra_request);
            }
        }
        let (base, _, request) = serve_once(response("200 OK", &json!({"shares": [], "you": {"role": "owner", "canApprove": true, "canManageShares": true}}).to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.shares(None, "workspace-1", None).unwrap_err().code, "cloud_workspace_invalid_response");
        assert!(!request.join().unwrap().extra_request);
    }

    #[test]
    fn phase2_admin_share_contract_safe_errors_status_retry_after_and_no_retry() {
        for (status, number, code) in [
            ("409 Conflict", 409, "cloud_workspace_last_admin"),
            ("409 Conflict", 409, "cloud_workspace_runtime_unsupported"),
            ("503 Service Unavailable", 503, "cloud_workspace_share_unavailable"),
            ("403 Forbidden", 403, "cloud_workspace_share_forbidden"),
            ("403 Forbidden", 403, "cloud_workspace_manager_required"),
            ("401 Unauthorized", 401, "invalid_access_token"),
            ("404 Not Found", 404, "cloud_workspace_not_found"),
            ("404 Not Found", 404, "organization_member_not_found"),
            ("404 Not Found", 404, "cloud_workspace_share_not_found"),
            ("422 Unprocessable Entity", 422, "cloud_workspace_request_invalid"),
            ("429 Too Many Requests", 429, "cloud_workspace_share_limit"),
            ("409 Conflict", 409, "cloud_workspace_share_redundant"),
            ("409 Conflict", 409, "cloud_workspace_share_requires_organization_access"),
            ("409 Conflict", 409, "cloud_workspace_share_credential_restricted"),
            ("409 Conflict", 409, "cloud_workspace_share_personal_route"),
            ("503 Service Unavailable", 503, "machine0_unavailable"),
        ] {
            for method in ["GET", "PUT", "DELETE"] {
                let (base, _, request) = serve_once(response(status, &json!({"error": code, "message": "private diagnostic must not cross"}).to_string(), "Retry-After: 17\r\n"), Duration::ZERO);
                let (_, service) = phase2_service(&base);
                let error = match method {
                    "GET" => service.shares(None, "workspace-1", None).unwrap_err(),
                    "PUT" => service.share_put(None, "workspace-1", "user-2", ShareRole::Manager, true).unwrap_err(),
                    _ => service.share_revoke(None, "workspace-1", "user-2").unwrap_err(),
                };
                assert_eq!(error.code, code);
                assert_eq!(error.status, Some(number));
                assert_eq!(error.retry_after_seconds, Some(17));
                assert_eq!(error.retryable, method == "GET" && (number == 429 || number >= 500));
                assert_eq!(error.requires_original_account_context, method != "GET" && (number == 429 || number >= 500));
                assert!(!error.retry_with_same_idempotency_key);
                assert!(!serde_json::to_string(&error).unwrap().contains("private diagnostic"));
                let captured = request.join().unwrap();
                phase2_headers(&captured.text);
                assert!(!captured.extra_request);
            }
        }
    }

    #[test]
    fn phase2_admin_share_contract_bounded_timeout_body_and_unknown_error_capture() {
        for method in ["GET", "PUT", "DELETE"] {
            for failure in ["timeout", "body-limit", "error-body-limit", "unknown-error"] {
                let body = match failure {
                    "body-limit" | "error-body-limit" => " ".repeat(RESPONSE_LIMIT_BYTES as usize + 1),
                    "unknown-error" => r#"{"error":"raw_database_secret","message":"private"}"#.into(),
                    _ => json!({"share": share_json("user-2", "manager")}).to_string(),
                };
                let status = if matches!(failure, "error-body-limit" | "unknown-error") { "503 Service Unavailable" } else { "200 OK" };
                let (base, _, request) = serve_once(response(status, &body, ""), if failure == "timeout" { Duration::from_millis(200) } else { Duration::ZERO });
                let (account, _) = test_service(&base);
                let mut service = CloudWorkspaceService::for_test(account, &base, if failure == "timeout" { Duration::from_millis(50) } else { Duration::from_secs(2) });
                service.force_phase2_for_test = true;
                let started = Instant::now();
                let error = match method {
                    "GET" => service.shares(None, "workspace-1", None).unwrap_err(),
                    "PUT" => service.share_put(None, "workspace-1", "user-2", ShareRole::Manager, true).unwrap_err(),
                    _ => service.share_revoke(None, "workspace-1", "user-2").unwrap_err(),
                };
                assert!(started.elapsed() < Duration::from_secs(2));
                let http_error = matches!(failure, "error-body-limit" | "unknown-error");
                assert_eq!(error.status, if http_error { Some(503) } else { None });
                assert_eq!(error.code, if http_error || (failure == "timeout" && method == "GET") { "cloud_workspace_unavailable" }
                    else if method == "GET" { "cloud_workspace_invalid_response" } else { "cloud_workspace_request_outcome_unknown" });
                let serialized = serde_json::to_string(&error).unwrap();
                assert!(!serialized.contains("raw_database_secret") && !serialized.contains("private"));
                assert!(!request.join().unwrap().extra_request);
            }
        }
    }

    #[test]
    fn shares_list_reads_the_caller_standing() {
        let body = json!({
            "shares": [share_json("user-2", "viewer")],
            "you": { "role": "manager", "canApprove": true, "canManageShares": true }
        });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.shares(None, "workspace-1", None).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares HTTP/1.1"));
        assert_eq!(listed.shares.len(), 1);
        assert_eq!(listed.shares[0].role, ShareRole::Viewer);
        assert_eq!(listed.you.role, CollaborationRole::Manager);
        assert!(listed.you.can_manage_shares);
        // Serialized for the webview in camelCase.
        let value = serde_json::to_value(&listed).unwrap();
        assert_eq!(value["you"]["canManageShares"], json!(true));
        assert_eq!(value["shares"][0]["userId"], json!("user-2"));
    }

    #[test]
    fn share_put_sends_the_strict_body_with_put() {
        let body = json!({ "share": share_json("user-2", "driver"), "created": true });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let changed = service.share_put(None, "workspace-1", "user-2", ShareRole::Driver, true).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("PUT /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares/user-2 HTTP/1.1"));
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent, json!({ "v": 1, "role": "driver", "canApprove": true }));
        assert_eq!(changed.created, Some(true));
        assert_eq!(changed.share.role, ShareRole::Driver);
    }

    #[test]
    fn share_revoke_uses_delete_and_checks_the_answer_is_that_person() {
        let body = json!({ "share": share_json("user-2", "viewer") });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        service.share_revoke(None, "workspace-1", "user-2").unwrap();
        assert!(request
            .join()
            .unwrap()
            .text
            .starts_with("DELETE /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares/user-2 HTTP/1.1"));

        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.share_revoke(None, "workspace-1", "user-3").unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_workspace_request_outcome_unknown");
    }

    #[test]
    fn share_refusals_keep_their_codes() {
        for (status, code) in [
            ("409 Conflict", "cloud_workspace_share_redundant"),
            ("409 Conflict", "cloud_workspace_share_requires_organization_access"),
            ("429 Too Many Requests", "cloud_workspace_share_limit"),
            ("403 Forbidden", "cloud_workspace_share_forbidden"),
            ("409 Conflict", "cloud_workspace_share_credential_restricted"),
            ("409 Conflict", "cloud_workspace_share_personal_route"),
            ("404 Not Found", "organization_member_not_found"),
            ("404 Not Found", "cloud_workspace_share_not_found"),
        ] {
            let (base, _, request) = serve_once(response(status, &json!({ "error": code }).to_string(), ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let error = service.share_put(None, "workspace-1", "user-2", ShareRole::Viewer, false).unwrap_err();
            request.join().unwrap();
            assert_eq!(error.code, code);
        }
    }

    #[test]
    fn catalog_creator_accepts_the_name_without_a_presence_photo() {
        let mut workspace: Value = serde_json::from_str::<Value>(&snapshot_body(None)).unwrap()["workspace"].clone();
        workspace["createdBy"] = json!("creator-1");
        workspace["creator"] = json!({ "userId": "creator-1", "displayName": "Aisha" });
        let parsed: CloudWorkspace = serde_json::from_value(workspace).unwrap();
        let creator = parsed.creator.unwrap();
        assert_eq!(creator.user_id, "creator-1");
        assert_eq!(creator.display_name.as_deref(), Some("Aisha"));
        assert!(creator.photo_url.is_none());
    }

    #[test]
    fn general_access_contract_projects_the_two_editors_independently() {
        let body = json!({
            "shares": [],
            "you": { "role": "manager", "canApprove": true, "canManageShares": true },
            "groupShares": [],
            "accessRevision": "9007199254740993",
            "generalAccess": { "mode": "organisation", "role": "read" },
            "capabilities": { "canChangeGeneralAccess": true, "canGrantAdmin": false, "canUseOrganisationWrite": false }
        });
        for (groups, general) in [(false, false), (false, true), (true, false), (true, true)] {
            let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
            let (account, service) = test_service(&base);
            account.set_memberships_for_test(&["org-1"], true);
            account.apply_phase2_readiness_for_test(json!({ "version": 1, "organizations": {
                "org-1": { (PHASE2_GENERAL_ACCESS): general, (PHASE2_WORKSPACE_GROUPS): groups }
            } }));
            let revision = AccountManager::context_revision(&context());
            let result = service.shares(None, "workspace-1", groups.then_some(revision.as_str())).unwrap();
            assert_eq!(result.group_shares.is_some(), groups);
            assert_eq!(result.access_revision.is_some(), groups || general, "groups={groups}, general={general}");
            assert_eq!(result.general_access.is_some(), general);
            assert_eq!(result.capabilities.is_some(), general);
            assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/shares HTTP/"));
        }
    }

    #[test]
    fn general_access_contract_uses_member_route_and_preserves_revision_errors() {
        let access = GeneralAccess::Organisation { role: GeneralAccessRole::Read };
        let revision = "9007199254740993";
        for (status, code, expected) in [
            ("200 OK", "", None),
            ("409 Conflict", "cloud_workspace_access_revision_conflict", Some(409)),
            ("403 Forbidden", "cloud_workspace_share_forbidden", Some(403)),
            ("503 Service Unavailable", "cloud_workspace_general_access_unavailable", Some(503)),
        ] {
            let body = if code.is_empty() {
                json!({"accessRevision": "9007199254740994", "generalAccess": access })
            } else {
                json!({"error": code })
            };
            let (base, _, request) = serve_once(response(status, &body.to_string(), ""), Duration::ZERO);
            let (account, service) = test_service(&base);
            account.set_memberships_for_test(&["org-1", "org-2"], false);
            account.apply_phase2_readiness_for_test(json!({
                "version": 1, "organizations": { "org-2": { (PHASE2_GENERAL_ACCESS): true } }
            }));
            let context_revision = AccountManager::context_revision(&context());
            let reply = service.general_access_put(Some("org-2"), "workspace-1", revision, access, &context_revision);
            if let Some(expected) = expected {
                let error = reply.unwrap_err();
                assert_eq!(error.status, Some(expected));
                assert_eq!(error.code, code);
            } else {
                assert_eq!(reply.unwrap(), GeneralAccessChange {
                    general_access: access, access_revision: "9007199254740994".into(),
                });
            }
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with("PUT /v1/desktop/orgs/org-2/cloud-workspaces/workspace-1/general-access HTTP/"));
            phase2_headers(&captured.text);
            let body: Value = serde_json::from_str(captured.text.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body, json!({"accessRevision": revision, "generalAccess": {"mode": "organisation", "role": "read"}}));
            assert!(!captured.extra_request);
        }
    }

    #[test]
    fn general_access_contract_refuses_write_stale_account_and_invalid_revision_before_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let (_, service) = test_service(&format!("http://{}", listener.local_addr().unwrap()));
        let current = AccountManager::context_revision(&context());
        let invited = GeneralAccess::InvitedOnly;
        for (token, policy, scope, code) in [
            ("1", invited, current.as_str(), "cloud_workspace_general_access_unavailable"),
            ("1", invited, "stale", "account_context_changed"),
            ("1", GeneralAccess::Organisation { role: GeneralAccessRole::Write }, current.as_str(), "cloud_workspace_runtime_unsupported"),
            ("9223372036854775808", invited, current.as_str(), "cloud_workspace_request_invalid"),
            ("01", invited, current.as_str(), "cloud_workspace_request_invalid"),
        ] {
            assert_eq!(service.general_access_put(None, "workspace-1", token, policy, scope).unwrap_err().code, code);
        }
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn general_access_contract_fences_late_receipts_after_signout() {
        let access = GeneralAccess::InvitedOnly;
        let body = json!({"accessRevision": "2", "generalAccess": access });
        let (base, accepted, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::from_millis(150));
        let (account, service) = phase2_service(&base);
        let pending = thread::spawn(move || service.general_access_put(
            Some("org-1"), "workspace-1", "1", access, &AccountManager::context_revision(&context()),
        ));
        accepted.recv_timeout(Duration::from_secs(2)).unwrap();
        account.set_context_for_test(None);
        let error = pending.join().unwrap().unwrap_err();
        assert_eq!(error.code, "account_context_changed");
        assert!(error.requires_original_account_context);
        assert!(!request.join().unwrap().extra_request);
    }

    #[test]
    fn list_items_carry_the_callers_role_and_share_count_leniently() {
        let mut workspace: Value = serde_json::from_str::<Value>(&snapshot_body(None)).unwrap()["workspace"].clone();
        workspace["you"] = json!({ "role": "driver", "canApprove": true });
        workspace["sharedWith"] = json!(3);
        let parsed: CloudWorkspace = serde_json::from_value(workspace.clone()).unwrap();
        assert_eq!(parsed.you, Some(ListYou { role: CollaborationRole::Driver, can_approve: true, can_manage_shares: false }));
        assert_eq!(parsed.shared_with, Some(3));
        let value = serde_json::to_value(&parsed).unwrap();
        assert_eq!((value["you"].clone(), value["sharedWith"].clone()), (json!({ "role": "driver", "canApprove": true, "canManageShares": false }), json!(3)));
        workspace["you"] = json!({ "role": "driver", "canApprove": true, "canManageShares": true });
        let creator: CloudWorkspace = serde_json::from_value(workspace.clone()).unwrap();
        assert!(creator.you.unwrap().can_manage_shares);
        // A role this build does not know, or a malformed count, drops the field, not the list.
        workspace["you"] = json!({ "role": "owner-of-everything", "canApprove": true });
        workspace["sharedWith"] = json!(-1);
        let parsed: CloudWorkspace = serde_json::from_value(workspace.clone()).unwrap();
        assert_eq!((parsed.you, parsed.shared_with), (None, None));
        // An older server sends neither; nothing is serialized for the page.
        let object = workspace.as_object_mut().unwrap();
        object.remove("you");
        object.remove("sharedWith");
        let parsed: CloudWorkspace = serde_json::from_value(workspace).unwrap();
        let value = serde_json::to_value(&parsed).unwrap();
        assert!(value.get("you").is_none() && value.get("sharedWith").is_none());
    }

    #[test]
    fn set_access_posts_the_mode_and_checks_the_answer_is_that_workspace() {
        let mut workspace: Value = serde_json::from_str::<Value>(&snapshot_body(None)).unwrap()["workspace"].clone();
        workspace["accessMode"] = json!("organization");
        let (base, _, request) = serve_once(response("200 OK", &workspace.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let changed = service.set_access(None, "workspace-1", WorkspaceAccessMode::Organization, None).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/access HTTP/1.1"));
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent, json!({ "accessMode": "organization" }));
        assert!(matches!(changed.access_mode, WorkspaceAccessMode::Organization));

        // Back to private: the same route, the other mode.
        workspace["accessMode"] = json!("private");
        let (base, _, request) = serve_once(response("200 OK", &workspace.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let changed = service.set_access(None, "workspace-1", WorkspaceAccessMode::Private, None).unwrap();
        let captured = request.join().unwrap();
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent, json!({ "accessMode": "private" }));
        assert!(matches!(changed.access_mode, WorkspaceAccessMode::Private));

        // An answer for another workspace is an unknown outcome, not a success.
        workspace["id"] = json!("workspace-9");
        let (base, _, request) = serve_once(response("200 OK", &workspace.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.set_access(None, "workspace-1", WorkspaceAccessMode::Private, None).unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_workspace_request_outcome_unknown");
    }

    #[test]
    fn set_access_keeps_the_refusal_of_a_member_and_checks_the_id_first() {
        let (base, _, request) = serve_once(response("403 Forbidden", r#"{"error":"organization_admin_required"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.set_access(None, "workspace-1", WorkspaceAccessMode::Organization, None).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("organization_admin_required", Some(403)));
        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.set_access(None, "../x", WorkspaceAccessMode::Private, None).unwrap_err().code, "cloud_workspace_request_invalid");
    }

    #[test]
    fn set_idle_suspend_posts_the_window_and_checks_the_answer_names_it() {
        let mut workspace: Value = serde_json::from_str::<Value>(&snapshot_body(None)).unwrap()["workspace"].clone();
        workspace["idleSuspendMinutes"] = json!(0);
        let (base, _, request) = serve_once(response("200 OK", &workspace.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let changed = service.set_idle_suspend(None, "workspace-1", 0).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/idle-suspend HTTP/1.1"));
        assert!(captured.text.to_ascii_lowercase().contains("x-terminalx-cloud-workspace-idle-options: never-v1"));
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent, json!({ "idleSuspendMinutes": 0 }));
        assert_eq!(changed.idle_suspend_minutes, Some(0));

        // An answer that does not name the window asked for (an older
        // server, another workspace's) is an unknown outcome, not a success.
        for (key, value) in [("idleSuspendMinutes", json!(15)), ("id", json!("workspace-9"))] {
            let mut other = workspace.clone();
            other[key] = value;
            let (base, _, request) = serve_once(response("200 OK", &other.to_string(), ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let error = service.set_idle_suspend(None, "workspace-1", 0).unwrap_err();
            request.join().unwrap();
            assert_eq!(error.code, "cloud_workspace_request_outcome_unknown", "{key}");
        }

        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.set_idle_suspend(None, "../x", 0).unwrap_err().code, "cloud_workspace_request_invalid");
        assert_eq!(service.set_idle_suspend(None, "workspace-1", -1).unwrap_err().code, "cloud_workspace_request_invalid");
    }

    #[test]
    fn idle_suspend_reads_the_window_and_its_choices_for_that_workspace() {
        let body = json!({
            "workspaceId": "workspace-1", "idleSuspendMinutes": 15,
            "allowedIdleSuspendMinutes": [5, 10, 15, 30], "maxIdleSuspendMinutes": 30
        });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let read = service.idle_suspend(None, "workspace-1").unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/idle-suspend HTTP/1.1"));
        assert_eq!(read, WorkspaceIdleSuspend {
            workspace_id: "workspace-1".into(),
            idle_suspend_minutes: Some(15),
            allowed_idle_suspend_minutes: vec![5, 10, 15, 30],
            max_idle_suspend_minutes: Some(30),
        });

        let mut other = body.clone();
        other["workspaceId"] = json!("workspace-9");
        let (base, _, request) = serve_once(response("200 OK", &other.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.idle_suspend(None, "workspace-1").unwrap_err().code, "cloud_workspace_invalid_response");
        request.join().unwrap();
    }

    #[test]
    fn share_identifiers_are_checked_before_sending() {
        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.share_put(None, "workspace-1", "../x", ShareRole::Viewer, false).unwrap_err().code, "cloud_workspace_request_invalid");
        assert_eq!(service.share_revoke(None, "", "user-2").unwrap_err().code, "cloud_workspace_request_invalid");
        assert_eq!(service.shares(None, "a/b", None).unwrap_err().code, "cloud_workspace_request_invalid");
    }

    #[test]
    fn a_hidden_provider_refuses_setup_and_create_definitely() {
        let body = r#"{"error":"cloud_provider_disabled"}"#;
        let (base, _, request) = serve_once(response("403 Forbidden", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.setup(None, provider_id("machine0")).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("cloud_provider_disabled", Some(403)));
        assert!(!error.retryable);

        let (base, _, request) = serve_once(response("403 Forbidden", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.create(None, launch_input(vec![repo("app", None)], None)).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("cloud_provider_disabled", Some(403)));
        assert!(!error.retry_with_same_idempotency_key, "a hidden provider is a refusal, not outcome unknown");
    }

    #[test]
    fn the_running_limit_refuses_create_and_resume_definitely() {
        let body = r#"{"error":"cloud_workspace_concurrency_exceeded"}"#;
        let (base, _, request) = serve_once(response("409 Conflict", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.create(None, launch_input(vec![repo("app", None)], None)).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("cloud_workspace_concurrency_exceeded", Some(409)));
        assert!(!error.retry_with_same_idempotency_key, "a refusal at the running limit is not outcome unknown");

        let (base, _, request) = serve_once(response("409 Conflict", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.lifecycle(None, "workspace-1", OperationAction::Resume).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("cloud_workspace_concurrency_exceeded", Some(409)));
        assert!(!error.requires_original_account_context);
    }
    fn automation_github() -> Value {
        json!({"repositoryId": "org-repository-row-1", "event": "pushed",
            "filters": [{"field": "baseBranch", "operator": "is-not", "value": " main "}]})
    }

    fn automation_input(fork: Option<bool>) -> CloudScheduleCreateInput {
        let mut input = schedule_input();
        input.schedule = None;
        input.workspace_mode = Some("fresh".into());
        input.archive_after_days = Some(365);
        input.archive_on_pr_merge = Some(true);
        let mut github = automation_github();
        if let Some(fork) = fork { github["allowForkPullRequests"] = json!(fork); }
        input.github_trigger = Some(serde_json::from_value(github).unwrap());
        input
    }

    fn automation_json() -> Value {
        let mut view = schedule_json(SCHEDULE, "workspace-1");
        view["schedule"] = Value::Null;
        view.as_object_mut().unwrap().remove("nextRunAt");
        view["workspaceMode"] = json!("fresh");
        view["archiveAfterDays"] = json!(365);
        view["archiveOnPrMerge"] = json!(true);
        let mut github = automation_github();
        github["filters"][0]["value"] = json!("main");
        view["githubTrigger"] = github;
        view
    }

    fn webhook_estimate_body() -> Value {
        json!({
            "workspaceId": "workspace-1", "webhookTrigger": {},
            "completionPolicy": "suspend", "maxRunMinutes": 45
        })
    }

    const WEBHOOK_ID: &str = "whk_abcdefghijklmnopqrstuvwxyz234567";
    const WEBHOOK_PATH: &str = "/v1/automation-webhooks/whk_abcdefghijklmnopqrstuvwxyz234567";

    fn webhook_schedule_view() -> Value {
        let mut view = schedule_json(SCHEDULE, "workspace-1");
        view["schedule"] = json!({
            "preset": "hourly", "hour": 0, "minute": 0, "weekdays": [], "timezone": "UTC"
        });
        view.as_object_mut().unwrap().remove("nextRunAt");
        view["lastRun"]["trigger"] = json!("webhook");
        view["webhookTrigger"] = json!({
            "webhookId": WEBHOOK_ID, "path": WEBHOOK_PATH
        });
        view
    }

    #[test]
    fn cloud_schedule_webhook_estimate_posts_only_the_webhook_trigger() {
        let view = webhook_schedule_view();
        let quote = json!({"estimate": view["estimate"], "nextRunAt": null, "supported": true});
        let (base, _, request) = serve_once(response("200 OK", &quote.to_string(), ""), Duration::ZERO);
        let (_, service) = phase2_service(&base);
        let input = serde_json::from_value(webhook_estimate_body()).unwrap();
        let result = service.schedule_estimate(Some("org-1"), &input).unwrap();
        assert!(result.supported && result.next_run_at.is_none());
        assert_eq!(result.estimate.max_runs_per_day, 24);
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-schedules/estimate HTTP/1.1"));
        assert_eq!(sent_body(&captured), webhook_estimate_body());
        assert!(!captured.extra_request);
    }

    #[test]
    fn cloud_schedule_webhook_create_and_rotate_return_a_flattened_one_time_secret() {
        let mut input = schedule_input();
        input.schedule = None;
        input.webhook_trigger = Some(CloudScheduleWebhookInput);
        for (rotate, secret) in [(false, "created-test-secret"), (true, "rotated-test-secret")] {
            let mut view = webhook_schedule_view();
            view["webhookTrigger"]["secret"] = json!(secret);
            let answer = json!({"schedule": view});
            let (base, _, request) = serve_once(response("200 OK", &answer.to_string(), ""), Duration::ZERO);
            let (_, service) = phase2_service(&base);
            let (result, path, body) = if rotate {
                (service.schedule_webhook_rotate(Some("org-1"), SCHEDULE).unwrap(),
                    format!("/v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/webhook/rotate"),
                    json!({}))
            } else {
                (service.schedule_create(Some("org-1"), &input).unwrap(),
                    "/v1/desktop/orgs/org-1/cloud-schedules".to_owned(),
                    json!({
                        "workspaceId": "workspace-1", "name": "Nightly triage", "agent": "claude",
                        "model": "sonnet", "mode": "acceptEdits", "prompt": "Triage the new issues.",
                        "webhookTrigger": {}, "missedRunPolicy": "skip", "completionPolicy": "suspend",
                        "maxRunMinutes": 45, "confirmProviderSpend": true
                    }))
            };
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with(&format!("POST {path} HTTP/1.1")));
            assert_eq!(sent_body(&captured), body);
            assert!(!captured.extra_request && !captured.text.contains(secret));
            assert!(!format!("{result:?}").contains(secret));
            let wire = serde_json::to_value(&result).unwrap();
            assert_eq!(wire["id"], SCHEDULE);
            assert_eq!(wire["schedule"], Value::Null);
            assert_eq!(wire["webhookTrigger"], json!({
                "url": format!("{base}{WEBHOOK_PATH}"), "secretUpdatedAt": null
            }));
            assert_eq!(wire["lastRun"]["trigger"], "webhook");
            assert_eq!(wire["webhookSecret"], secret);
        }
    }

    #[test]
    fn cloud_schedule_webhook_secrets_do_not_escape_read_views_or_errors() {
        let secret = "discard-test-secret";
        let mut view = webhook_schedule_view();
        view["webhookTrigger"]["secret"] = json!(secret);
        let detail = json!({"schedule": view,
            "runs": [view["lastRun"], {
                "id": "manual-run", "scheduledFor": 1792713600000i64, "trigger": "manual", "state": "completed"
            }]});
        let answer = json!({"schedule": view});
        let mut malformed = answer.clone();
        malformed["schedule"]["webhookTrigger"]["secret"] = json!([secret]);
        let (base, requests) = serve_each(vec![
            response("200 OK", &answer.to_string(), ""),
            response("200 OK", &detail.to_string(), ""),
            response("200 OK", &json!({"schedules": [view]}).to_string(), ""),
            response("403 Forbidden", &json!({"error": "organization_admin_required", "webhookSecret": secret}).to_string(), ""),
            response("200 OK", &malformed.to_string(), ""),
        ]);
        let (_, service) = phase2_service(&base);
        let rotated = service.schedule_webhook_rotate(Some("org-1"), SCHEDULE).unwrap();
        assert_eq!(serde_json::to_value(rotated).unwrap()["webhookSecret"], secret);
        let detail = service.schedule(Some("org-1"), SCHEDULE).unwrap();
        assert_eq!(detail.runs[1].trigger, "manual");
        let list = service.schedules(Some("org-1"), None).unwrap();
        assert_eq!(list.schedules[0].webhook_trigger, detail.schedule.webhook_trigger);
        assert!(!serde_json::to_string(&detail).unwrap().contains(secret));
        assert!(!serde_json::to_string(&list).unwrap().contains(secret));
        for code in ["organization_admin_required", "cloud_workspace_request_outcome_unknown"] {
            let error = service.schedule_webhook_rotate(Some("org-1"), SCHEDULE).unwrap_err();
            assert_eq!(error.code, code);
            assert!(!error.retryable);
            assert!(!format!("{error:?}").contains(secret));
            assert!(!serde_json::to_string(&error).unwrap().contains(secret));
        }
        assert_eq!(requests.join().unwrap().len(), 5);
    }

    #[test]
    fn cloud_schedule_webhook_requires_an_empty_object_a_single_trigger_and_phase2() {
        let mut estimate = webhook_estimate_body();
        for invalid_trigger in [Value::Null, json!([]), json!({"secret": "unaccepted"})] {
            estimate["webhookTrigger"] = invalid_trigger;
            assert!(serde_json::from_value::<CloudScheduleEstimateInput>(estimate.clone()).is_err());
        }
        let (_, service) = test_service("http://127.0.0.1:1");
        let mut input = schedule_input();
        input.webhook_trigger = Some(CloudScheduleWebhookInput);
        assert_eq!(service.schedule_create(None, &input).unwrap_err().code, "cloud_workspace_request_invalid");
        input.schedule = None;
        assert_eq!(service.schedule_create(None, &input).unwrap_err().code, "cloud_workspace_runtime_not_ready");
        let estimate = serde_json::from_value(webhook_estimate_body()).unwrap();
        assert_eq!(service.schedule_estimate(None, &estimate).unwrap_err().code, "cloud_workspace_runtime_not_ready");
        assert_eq!(service.schedule_webhook_rotate(Some("org-1"), SCHEDULE).unwrap_err().code, "cloud_workspace_runtime_not_ready");
    }

    #[test]
    fn phase2_automation_contract_held_paths_never_reach_an_old_server() {
        let (_, service) = test_service("http://127.0.0.1:1");
        assert!(!service.phase2_contracts_available());
        for fresh in [false, true] {
            for github in [false, true] {
                if !fresh && !github { continue; }
                let mut input = schedule_input();
                input.workspace_mode = fresh.then(|| "fresh".into());
                if github {
                    input.schedule = None;
                    input.github_trigger = Some(serde_json::from_value(automation_github()).unwrap());
                }
                let error = service.schedule_create(None, &input).unwrap_err();
                assert_eq!(error.code, "cloud_schedule_runtime_unsupported");
                assert!(error.status.is_none() && !error.retryable);
                let estimate = CloudScheduleEstimateInput {
                    workspace_id: input.workspace_id, schedule: input.schedule, github_trigger: input.github_trigger,
                    webhook_trigger: None, workspace_mode: input.workspace_mode, completion_policy: input.completion_policy, max_run_minutes: input.max_run_minutes,
                };
                assert_eq!(service.schedule_estimate(None, &estimate).unwrap_err().code, "cloud_schedule_runtime_unsupported");
            }
        }
    }

    #[test]
    fn phase2_automation_contract_fresh_timer_cleanup_boundaries_and_no_github() {
        for days in [1, 365] {
            let mut input = schedule_input();
            input.workspace_mode = Some("fresh".into());
            input.archive_after_days = Some(days);
            input.archive_on_pr_merge = Some(true);
            let mut view = schedule_json(SCHEDULE, "workspace-1");
            view["workspaceMode"] = json!("fresh");
            view["archiveAfterDays"] = json!(days);
            view["archiveOnPrMerge"] = json!(true);
            let (base, _, request) = serve_once(response("200 OK", &json!({"schedule": view}).to_string(), ""), Duration::ZERO);
            let (_, service) = phase2_service(&base);
            let created = service.schedule_create(None, &input).unwrap().view;
            assert_eq!(created.workspace_mode, "fresh");
            assert_eq!(created.archive_after_days, Some(days));
            assert!(created.archive_on_pr_merge);
            let sent = sent_body(&request.join().unwrap());
            assert_eq!(sent["archiveAfterDays"], days);
            assert_eq!(sent["archiveOnPrMerge"], true);
            assert!(sent.get("githubTrigger").is_none());
            assert_eq!(sent["schedule"]["preset"], "weekly");
        }
    }

    #[test]
    fn phase2_automation_contract_body_defaultforkoptin_and_persisted_optin() {
        for fork in [None, Some(false), Some(true)] {
            let mut view = automation_json();
            view["githubTrigger"]["allowForkPullRequests"] = json!(fork.unwrap_or(false));
            let (base, _, request) = serve_once(response("200 OK", &json!({"schedule": view}).to_string(), ""), Duration::ZERO);
            let (_, service) = phase2_service(&base);
            let created = service.schedule_create(None, &automation_input(fork)).unwrap().view;
            assert!(created.schedule.is_none() && created.next_run_at.is_none());
            assert_eq!(created.github_trigger.unwrap().allow_fork_pull_requests, fork.unwrap_or(false));
            let captured = request.join().unwrap();
            assert!(!captured.extra_request);
            let mut github = automation_github();
            github["filters"][0]["value"] = json!("main");
            github["allowForkPullRequests"] = json!(fork.unwrap_or(false));
            assert_eq!(sent_body(&captured), json!({
                "workspaceId": "workspace-1", "name": "Nightly triage", "agent": "claude", "model": "sonnet",
                "mode": "acceptEdits", "prompt": "Triage the new issues.", "githubTrigger": github,
                "workspaceMode": "fresh", "archiveAfterDays": 365, "archiveOnPrMerge": true,
                "missedRunPolicy": "skip", "completionPolicy": "suspend", "maxRunMinutes": 45, "confirmProviderSpend": true
            }));
            phase2_headers(&captured.text);
        }
    }

    #[test]
    fn phase2_automation_contract_null_response_defaults_retain_current_timer_apis() {
        let mut view = schedule_json(SCHEDULE, "workspace-1");
        for field in ["workspaceMode", "archiveOnPrMerge", "archiveAfterDays", "githubTrigger"] {
            view[field] = Value::Null;
        }
        let answer = json!({"schedule": view, "runs": []}).to_string();
        let (base, requests) = serve_each(vec![
            response("200 OK", &json!({"schedules": [view]}).to_string(), ""),
            response("200 OK", &answer, ""),
            response("200 OK", &answer, ""),
            response("200 OK", &answer, ""),
            response("200 OK", &answer, ""),
            response("200 OK", &answer, ""),
        ]);
        let (_, service) = test_service(&base);
        let listed = service.schedules(None, Some("workspace-1")).unwrap();
        let detail = service.schedule(None, SCHEDULE).unwrap();
        let created = service.schedule_create(None, &schedule_input()).unwrap().view;
        let paused = service.schedule_set_active(None, SCHEDULE, false).unwrap();
        // The held resume preflight must also accept compatible null defaults.
        let resumed = service.schedule_set_active(None, SCHEDULE, true).unwrap();
        for schedule in [&listed.schedules[0], &detail.schedule, &created, &paused, &resumed] {
            assert_eq!(schedule.workspace_mode, "existing");
            assert!(!schedule.archive_on_pr_merge);
            assert!(schedule.archive_after_days.is_none() && schedule.github_trigger.is_none());
            assert!(schedule.schedule.is_some());
            let wire = serde_json::to_value(schedule).unwrap();
            assert_eq!(wire["workspaceMode"], "existing");
            assert_eq!(wire["archiveOnPrMerge"], false);
        }
        let requests = requests.join().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests[4].starts_with(&format!("GET /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE} HTTP/1.1")));
        assert!(requests[5].starts_with(&format!("POST /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/resume HTTP/1.1")));
        assert_eq!(serde_json::from_str::<Value>(requests[5].split_once("\r\n\r\n").unwrap().1).unwrap(), json!({"confirmProviderSpend": true}));
        for request in &requests { phase2_headers(request); }
    }

    #[test]
    fn phase2_automation_contract_null_cleanup_preserves_fresh_response_and_strict_types() {
        let mut view = automation_json();
        view["archiveOnPrMerge"] = Value::Null;
        view["archiveAfterDays"] = Value::Null;
        view["githubTrigger"]["allowForkPullRequests"] = json!(true);
        let pending = json!({"id": "run-pending", "scheduledFor": 1, "state": "creating-workspace", "workspaceId": "workspace-1"});
        view["lastRun"] = pending.clone();
        let (base, _, request) = serve_once(response("200 OK", &json!({"schedule": view, "runs": [pending]}).to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let detail = service.schedule(None, SCHEDULE).unwrap();
        assert_eq!(detail.schedule.workspace_mode, "fresh");
        assert!(!detail.schedule.archive_on_pr_merge);
        assert!(detail.schedule.archive_after_days.is_none() && detail.schedule.schedule.is_none());
        assert!(detail.schedule.github_trigger.unwrap().allow_fork_pull_requests);
        assert!(detail.schedule.last_run.unwrap().workspace_id.is_none());
        assert!(detail.runs[0].workspace_id.is_none());
        assert!(!request.join().unwrap().extra_request);

        // Null compatibility must not coerce wrong response types.
        for (field, value) in [("workspaceMode", json!(false)), ("archiveOnPrMerge", json!("false"))] {
            let mut invalid = schedule_json(SCHEDULE, "workspace-1");
            invalid[field] = value;
            assert!(serde_json::from_value::<CloudSchedule>(invalid).is_err());
        }
        // Create inputs still follow the SaaS parser's omission-only defaults.
        for field in ["workspaceMode", "archiveOnPrMerge", "archiveAfterDays", "schedule", "githubTrigger"] {
            let mut input = json!({
                "workspaceId": "workspace-1", "name": "Triage", "agent": "claude", "mode": "acceptEdits",
                "prompt": "Triage issues.", "schedule": schedule_json(SCHEDULE, "workspace-1")["schedule"],
                "missedRunPolicy": "skip", "completionPolicy": "suspend", "maxRunMinutes": 45
            });
            input[field] = Value::Null;
            assert!(serde_json::from_value::<CloudScheduleCreateInput>(input).is_err());
        }
    }

    #[test]
    fn phase2_automation_contract_invalid_inputs_are_local_even_while_inactive() {
        let (account, service) = test_service("http://127.0.0.1:1");
        account.set_context_for_test(None);
        assert!(!service.phase2_contracts_available());
        let invalid = |edit: fn(&mut CloudScheduleCreateInput)| {
            let mut input = automation_input(None);
            edit(&mut input);
            assert_eq!(service.schedule_create(None, &input).unwrap_err().code, "cloud_workspace_request_invalid");
        };
        invalid(|i| i.schedule = schedule_input().schedule);
        invalid(|i| i.github_trigger = None);
        invalid(|i| i.workspace_mode = Some("clone".into()));
        invalid(|i| i.workspace_mode = None);
        invalid(|i| i.workspace_mode = Some("existing".into()));
        invalid(|i| i.archive_after_days = Some(0));
        invalid(|i| i.archive_after_days = Some(366));
        invalid(|i| i.github_trigger.as_mut().unwrap().event = "push".into());
        invalid(|i| i.github_trigger.as_mut().unwrap().repository_id.clear());
        invalid(|i| i.github_trigger.as_mut().unwrap().repository_id = "x".repeat(256));
        invalid(|i| { let g = i.github_trigger.as_mut().unwrap(); g.filters = vec![g.filters[0].clone(); 6]; });
        invalid(|i| i.github_trigger.as_mut().unwrap().filters[0].field = "headBranch".into());
        invalid(|i| i.github_trigger.as_mut().unwrap().filters[0].operator = "contains".into());
        invalid(|i| i.github_trigger.as_mut().unwrap().filters[0].value = " ".into());
        invalid(|i| i.github_trigger.as_mut().unwrap().filters[0].value = "x".repeat(256));
        invalid(|i| i.github_trigger.as_mut().unwrap().filters[0].value = "a\nb".into());
        invalid(|i| i.mode = "bypassPermissions".into());
        // Serde rejects unknown nested keys and non-boolean fork opt-in.
        for extra in [json!({"allowForkPullRequests": "true"}), json!({"webhook": true})] {
            let mut g = automation_github();
            g.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            assert!(serde_json::from_value::<CloudScheduleGithubTrigger>(g).is_err());
        }
        let mut g = automation_github();
        g["filters"][0]["unknown"] = json!(true);
        assert!(serde_json::from_value::<CloudScheduleGithubTrigger>(g).is_err());
        for field in ["schedule", "githubTrigger", "workspaceMode"] {
            let mut body = json!({"workspaceId": "workspace-1", "githubTrigger": automation_github(), "completionPolicy": "suspend", "maxRunMinutes": 60});
            body[field] = Value::Null;
            assert!(serde_json::from_value::<CloudScheduleEstimateInput>(body).is_err());
        }
        let estimate: CloudScheduleEstimateInput = serde_json::from_value(json!({
            "workspaceId": "workspace-1", "completionPolicy": "suspend", "maxRunMinutes": 60
        })).unwrap();
        assert_eq!(service.schedule_estimate(None, &estimate).unwrap_err().code, "cloud_workspace_request_invalid");
        let mut estimate_body = json!({"workspaceId": "workspace-1", "githubTrigger": automation_github(), "completionPolicy": "suspend", "maxRunMinutes": 60});
        estimate_body["archiveAfterDays"] = json!(1);
        assert!(serde_json::from_value::<CloudScheduleEstimateInput>(estimate_body).is_err());
    }

    #[test]
    fn phase2_automation_contract_freshrunidentity_is_own_workspace_or_unavailable() {
        for timer in [false, true] {
            let mut view = automation_json();
            if timer {
                view["schedule"] = schedule_json(SCHEDULE, "workspace-1")["schedule"].clone();
                view.as_object_mut().unwrap().remove("githubTrigger");
            } else {
                view.as_object_mut().unwrap().remove("schedule");
            }
            let pending = json!({"id": "run-pending", "scheduledFor": 1, "trigger": "github", "state": "creating-workspace", "workspaceId": "workspace-1"});
            let allocated = json!({"id": "run-own", "scheduledFor": 2, "trigger": "github", "state": "working", "workspaceId": "fresh-workspace-2", "workBranch": "terminalx/triage-123", "archiveAt": 1792713600000_i64, "archivedAt": null});
            view["lastRun"] = pending.clone();
            let body = json!({"schedule": view, "runs": [pending, allocated]});
            let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
            let (_, service) = phase2_service(&base);
            let detail = service.schedule(None, SCHEDULE).unwrap();
            assert!(detail.runs[0].workspace_id.is_none());
            assert!(detail.schedule.last_run.unwrap().workspace_id.is_none());
            assert_eq!(detail.runs[0].state, "creating-workspace");
            let pending = serde_json::to_value(&detail.runs[0]).unwrap();
            for field in ["workspaceId", "workBranch", "archiveAt", "archivedAt"] { assert!(pending[field].is_null()); }
            assert_eq!(detail.runs[1].workspace_id.as_deref(), Some("fresh-workspace-2"));
            assert_eq!(detail.runs[1].work_branch.as_deref(), Some("terminalx/triage-123"));
            let run = serde_json::to_value(&detail.runs[1]).unwrap();
            assert_eq!(run["archiveAt"], 1792713600000_i64);
            assert!(run["archivedAt"].is_null());
            request.join().unwrap();
        }
    }

    #[test]
    fn phase2_automation_contract_github_list_pause_resume_have_no_timer() {
        let view = automation_json();
        let (base, requests) = serve_each(vec![
            response("200 OK", &json!({"schedules": [view.clone()]}).to_string(), ""),
            response("200 OK", &json!({"schedule": view.clone()}).to_string(), ""),
            response("200 OK", &json!({"schedule": view.clone()}).to_string(), ""),
            response("200 OK", &json!({"schedule": view}).to_string(), ""),
        ]);
        let (_, service) = phase2_service(&base);
        let listed = service.schedules(None, Some("workspace-1")).unwrap();
        assert!(listed.schedules[0].schedule.is_none());
        assert!(!listed.schedules[0].github_trigger.as_ref().unwrap().allow_fork_pull_requests);
        for active in [false, true] {
            let changed = service.schedule_set_active(None, SCHEDULE, active).unwrap();
            assert!(changed.schedule.is_none() && changed.next_run_at.is_none());
        }
        let requests = requests.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/desktop/orgs/org-1/cloud-schedules?workspaceId=workspace-1 HTTP/1.1"));
        assert!(requests[1].starts_with(&format!("POST /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/pause HTTP/1.1")));
        assert!(requests[2].starts_with(&format!("GET /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE} HTTP/1.1")));
        assert!(requests[3].starts_with(&format!("POST /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/resume HTTP/1.1")));
        assert_eq!(requests[1].split_once("\r\n\r\n").unwrap().1, "{}");
        assert_eq!(serde_json::from_str::<Value>(requests[3].split_once("\r\n\r\n").unwrap().1).unwrap(), json!({"confirmProviderSpend": true}));
    }

    #[test]
    fn phase2_automation_contract_held_fresh_or_github_resume_never_posts() {
        for (fresh, github) in [(true, false), (false, true), (true, true)] {
            let mut view = automation_json();
            if !fresh { view["workspaceMode"] = json!("existing"); }
            if !github {
                view["schedule"] = schedule_json(SCHEDULE, "workspace-1")["schedule"].clone();
                view.as_object_mut().unwrap().remove("githubTrigger");
            }
            let (base, _, request) = serve_once(response("200 OK", &json!({"schedule": view, "runs": []}).to_string(), ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            assert!(!service.phase2_contracts_available());
            let error = service.schedule_set_active(None, SCHEDULE, true).unwrap_err();
            assert_eq!(error.code, "cloud_schedule_runtime_unsupported");
            assert!(error.status.is_none() && !error.retryable);
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with(&format!("GET /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE} HTTP/1.1")));
            assert!(!captured.extra_request, "held resume must not POST");
        }
    }

    #[test]
    fn phase2_automation_contract_held_resume_preflight_refusals_never_post() {
        for (status, code) in [("403 Forbidden", "organization_admin_required"), ("404 Not Found", "cloud_workspace_not_found")] {
            let (base, _, request) = serve_once(response(status, &json!({"error": code}).to_string(), ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            assert_eq!(service.schedule_set_active(None, SCHEDULE, true).unwrap_err().code, code);
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with("GET "));
            assert!(!captured.extra_request);
        }
    }

    #[test]
    fn phase2_automation_contract_delayed_resume_preflight_context_changes_never_post() {
        for change in ["sign-out", "account", "organization", "profile", "membership"] {
            let answer = json!({"schedule": schedule_json(SCHEDULE, "workspace-1"), "runs": []});
            let (base, accepted, request) = serve_once(response("200 OK", &answer.to_string(), ""), Duration::from_millis(150));
            let (account, service) = test_service(&base);
            let target = if change == "membership" {
                account.set_memberships_for_test(&["org-1", "org-2"], true);
                "org-2"
            } else { "org-1" };
            let resume = thread::spawn(move || service.schedule_set_active(Some(target), SCHEDULE, true));
            accepted.recv_timeout(Duration::from_secs(1)).unwrap();
            if change == "sign-out" {
                account.set_context_for_test(None);
            } else if change == "membership" {
                account.set_memberships_for_test(&["org-1"], true);
            } else {
                let mut replacement = context();
                replacement.generation += 1;
                match change {
                    "account" => replacement.user_id = "another-user".into(),
                    "organization" => replacement.organization_id = "org-2".into(),
                    "profile" => replacement.profile_id = "another-profile".into(),
                    _ => unreachable!(),
                }
                account.set_context_for_test(Some(replacement));
            }
            assert_eq!(resume.join().unwrap().unwrap_err().code, "account_context_changed");
            let captured = request.join().unwrap();
            assert!(captured.text.starts_with(&format!("GET /v1/desktop/orgs/{target}/cloud-schedules/{SCHEDULE} HTTP/1.1")));
            assert!(!captured.extra_request, "context change during {change} preflight must prevent spend POST");
        }
    }

    #[test]
    fn phase2_automation_contract_held_automation_safety_controls_need_no_preflight() {
        let (base, _, request) = serve_once(response("200 OK", &json!({"schedule": automation_json()}).to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert!(service.schedule_set_active(None, SCHEDULE, false).unwrap().schedule.is_none());
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with(&format!("POST /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/pause HTTP/1.1")));
        assert_eq!(sent_body(&captured), json!({}));
        assert!(!captured.extra_request);

        let (base, _, request) = serve_once(response("200 OK", "{\"ok\":true}", ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        service.schedule_delete(None, SCHEDULE).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("DELETE "));
        assert!(!captured.extra_request);

        let (base, _, request) = serve_once(response("200 OK", "{\"paused\":1}", ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.schedules_pause_all(None).unwrap().paused, 1);
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-schedules/pause-all HTTP/1.1"));
        assert!(!captured.extra_request);
    }

    #[test]
    fn phase2_automation_contract_numericcosts_fresh_ceiling_and_estimate_body() {
        for keep in [false, true] {
            let monthly = if keep { 62_208_000_000u64 } else { 410_400_000u64 };
            let body = json!({"estimate": {"currency": "USD", "hourlyMicros": 120000,
                "createPerRunMinutes": 20, "perRunMaxMinutes": 285, "perRunMaxMicros": 570000,
                "monthlyRuns": 720, "monthlyMaxMicros": monthly, "keepsMachineRunning": keep, "runningSlots": 1, "maxRunsPerDay": 24},
                "supported": false, "refusal": "cloud_schedule_runtime_unsupported", "nextRunAt": null});
            let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
            let (_, service) = phase2_service(&base);
            let input: CloudScheduleEstimateInput = serde_json::from_value(json!({
                "workspaceId": "workspace-1", "workspaceMode": "fresh", "githubTrigger": automation_github(),
                "completionPolicy": if keep {"keep"} else {"suspend"}, "maxRunMinutes": 240
            })).unwrap();
            let quote = service.schedule_estimate(None, &input).unwrap();
            assert_eq!(quote.estimate.monthly_max_micros, monthly);
            assert!(monthly > 120000 * 720, "fresh totals must not be clamped to one machine-month");
            assert_eq!(quote.estimate.create_per_run_minutes, Some(20));
            assert_eq!(quote.estimate.per_run_max_minutes, Some(285));
            assert_eq!(quote.refusal.as_deref(), Some("cloud_schedule_runtime_unsupported"));
            assert!(!quote.supported && quote.next_run_at.is_none());
            let captured = request.join().unwrap();
            let mut github = automation_github();
            github["filters"][0]["value"] = json!("main");
            github["allowForkPullRequests"] = json!(false);
            assert_eq!(sent_body(&captured), json!({"workspaceId": "workspace-1", "workspaceMode": "fresh", "githubTrigger": github,
                "completionPolicy": if keep {"keep"} else {"suspend"}, "maxRunMinutes": 240}));
        }
    }

    #[test]
    fn phase2_automation_contract_inactive_org_and_server_refusals_are_retained() {
        let (_, service) = phase2_service("http://127.0.0.1:1");
        assert_eq!(service.schedule_create(Some("org-other"), &automation_input(None)).unwrap_err().code, "cloud_organization_unavailable");
        for (status, code) in [("403 Forbidden", "organization_admin_required"), ("404 Not Found", "cloud_workspace_not_found"),
            ("409 Conflict", "cloud_provider_connection_required"), ("409 Conflict", "cloud_schedule_runtime_unsupported"),
            ("422 Unprocessable Entity", "cloud_workspace_request_invalid")] {
            let (base, _, request) = serve_once(response(status, &json!({"error": code}).to_string(), ""), Duration::ZERO);
            let (_, service) = phase2_service(&base);
            let error = service.schedule_create(None, &automation_input(None)).unwrap_err();
            assert_eq!(error.code, code);
            assert!(!request.join().unwrap().extra_request);
        }
    }

    fn schedule_json(id: &str, workspace_id: &str) -> Value {
        json!({
            "id": id, "workspaceId": workspace_id, "name": "Nightly triage", "createdBy": "user-1",
            "agent": "claude", "mode": "acceptEdits", "promptBytes": 41,
            "schedule": { "preset": "daily", "hour": 9, "minute": 0, "weekdays": [], "timezone": "Europe/Berlin" },
            "missedRunPolicy": "skip", "completionPolicy": "suspend", "maxRunMinutes": 60,
            "state": "active", "nextRunAt": 1_792_713_600_000i64,
            "estimate": { "currency": "USD", "hourlyMicros": 120_000, "perRunMaxMicros": 120_000, "monthlyRuns": 30, "monthlyMaxMicros": 3_600_000, "runningSlots": 1, "maxRunsPerDay": 24 },
            "lastRun": { "id": "run-1", "scheduledFor": 1_792_627_200_000i64, "trigger": "schedule", "state": "failed", "category": "timed-out" }
        })
    }

    const SCHEDULE: &str = "schedule_0b9d6b1e-3f5a-4c1d-9f2e-7a1b2c3d4e5f";

    fn schedule_input() -> CloudScheduleCreateInput {
        serde_json::from_value(json!({
            "workspaceId": "workspace-1", "name": "  Nightly triage ", "agent": "claude", "model": "sonnet", "mode": "acceptEdits",
            "prompt": "Triage the new issues.",
            "schedule": { "preset": "weekly", "hour": 9, "minute": 30, "weekdays": ["mon", "thu"], "timezone": "Europe/Berlin" },
            "missedRunPolicy": "skip", "completionPolicy": "suspend", "maxRunMinutes": 45
        }))
        .unwrap()
    }

    fn sent_body(captured: &CapturedRequest) -> Value {
        serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }

    #[test]
    fn phase2_organization_automations_run_now_requires_readiness_and_spend_confirmation() {
        let (_, held) = test_service("http://127.0.0.1:1");
        assert_eq!(held.schedule_run_now("org-1", SCHEDULE, true, "run-1").unwrap_err().code, "cloud_workspace_runtime_not_ready");
        assert_eq!(held.schedule_run_now("org-1", SCHEDULE, false, "run-1").unwrap_err().code, "cloud_workspace_request_invalid");
        let body = json!({ "run": { "id": "run-1", "scheduledFor": 10, "state": "queued" }, "duplicate": false });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, ready) = phase2_service(&base);
        let result = ready.schedule_run_now("org-1", SCHEDULE, true, "run-1").unwrap();
        assert_eq!(result.run.id, "run-1");
        assert!(!result.duplicate);
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with(&format!("POST /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/run-now HTTP/1.1")));
        assert!(captured.text.to_ascii_lowercase().contains("idempotency-key: run-1"));
        assert_eq!(sent_body(&captured), json!({ "confirmProviderSpend": true }));
    }

    #[test]
    fn phase2_organization_automations_edit_and_patch_use_the_exact_revision_and_routes() {
        let (_, held) = test_service("http://127.0.0.1:1");
        assert_eq!(held.schedule_edit("org-1", SCHEDULE).err().unwrap().code, "cloud_workspace_runtime_not_ready");
        assert_eq!(held.schedule_patch("org-1", SCHEDULE, 10, false, &schedule_input()).unwrap_err().code, "cloud_workspace_request_invalid");
        let mut input = schedule_input();
        let timing = input.schedule.as_mut().unwrap();
        timing.preset = "hourly".into();
        timing.hour = 0;
        timing.weekdays.clear();
        let configuration = CloudWorkspaceService::schedule_configuration(&input).unwrap();
        let mut schedule = schedule_json(SCHEDULE, &input.workspace_id);
        schedule["updatedAt"] = json!(1_785_000_000_123u64);
        schedule["consoleUrl"] = json!(format!("https://console.terminalx.ai/organizations/org-1/automations/{SCHEDULE}"));
        schedule["webhookSecret"] = json!("must not reach the UI");
        let mut projected_configuration = configuration.clone();
        projected_configuration["schedule"] = json!(input.schedule);
        let body = json!({ "schedule": schedule, "configuration": projected_configuration });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, reader) = phase2_service(&base);
        let editable = reader.schedule_edit("org-1", SCHEDULE).unwrap();
        assert!(request.join().unwrap().text.starts_with(&format!("GET /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/edit HTTP/1.1")));
        let projected = serde_json::to_value(&editable).unwrap();
        assert_eq!(projected["configuration"], projected_configuration);
        assert_eq!(projected["schedule"]["consoleUrl"], schedule["consoleUrl"]);
        assert!(projected["schedule"].get("webhookSecret").is_none());

        let revision = editable.schedule.updated_at.unwrap();
        schedule["updatedAt"] = json!(revision + 1);
        let body = json!({ "schedule": schedule });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, writer) = phase2_service(&base);
        let updated = writer.schedule_patch("org-1", SCHEDULE, revision, true, &input).unwrap();
        assert_eq!(updated.updated_at, Some(revision + 1));
        let request = request.join().unwrap();
        assert!(request.text.starts_with(&format!("PATCH /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE} HTTP/1.1")));
        let mut expected = configuration;
        assert!(expected["schedule"].get("hour").is_none());
        assert!(expected["schedule"].get("weekdays").is_none());
        expected["expectedUpdatedAt"] = json!(revision);
        expected["confirmProviderSpend"] = json!(true);
        assert_eq!(sent_body(&request), expected);
    }

    #[test]
    fn phase2_organization_automations_patch_preserves_active_run_refusal() {
        let (base, _, request) = serve_once(
            response("409 Conflict", r#"{"error":"cloud_schedule_run_active"}"#, ""),
            Duration::ZERO,
        );
        let (_, service) = phase2_service(&base);
        let error = service.schedule_patch("org-1", SCHEDULE, 10, true, &schedule_input()).unwrap_err();
        assert_eq!(error.code, "cloud_schedule_run_active");
        assert!(request.join().unwrap().text.starts_with("PATCH "));
    }

    #[test]
    fn phase2_organization_automations_project_creator_without_prompt_or_webhook_secret() {
        let mut schedule = schedule_json(SCHEDULE, "workspace-1");
        schedule["creator"] = json!({ "userId": "user-1", "displayName": "Sam" });
        schedule["prompt"] = json!("not part of the list view");
        schedule["webhookSecret"] = json!("not part of the list view");
        let body = json!({ "schedules": [schedule] });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.schedules(Some("org-1"), None).unwrap();
        assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-1/cloud-schedules HTTP/1.1"));
        let value = serde_json::to_value(&listed).unwrap();
        let row = &value["schedules"][0];
        assert_eq!(row["creator"], schedule["creator"]);
        assert!(row.get("prompt").is_none());
        assert!(row.get("webhookSecret").is_none());
    }

    #[test]
    fn phase2_automation_contract_schedules_are_listed_for_one_workspace_and_an_answer_about_another_is_refused() {
        let body = json!({ "schedules": [schedule_json(SCHEDULE, "workspace-1")] });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.schedules(None, Some("workspace-1")).unwrap();
        assert!(request.join().unwrap().text.starts_with("GET /v1/desktop/orgs/org-1/cloud-schedules?workspaceId=workspace-1 HTTP/1.1"));
        let schedule = &listed.schedules[0];
        assert_eq!(schedule.workspace_mode, "existing");
        assert!(!schedule.archive_on_pr_merge && schedule.github_trigger.is_none());
        assert_eq!((schedule.estimate.per_run_max_micros, schedule.estimate.max_runs_per_day, schedule.estimate.keeps_machine_running), (120_000, 24, false));
        assert_eq!(schedule.last_run.as_ref().and_then(|run| run.category.as_deref()), Some("timed-out"));
        // Serialized for the webview in camelCase.
        let value = serde_json::to_value(&listed).unwrap();
        assert_eq!(value["schedules"][0]["estimate"]["monthlyMaxMicros"], json!(3_600_000));
        assert_eq!(value["schedules"][0]["nextRunAt"], json!(1_792_713_600_000i64));

        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.schedules(None, Some("workspace-2")).unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_workspace_invalid_response");
    }

    #[test]
    fn phase2_automation_contract_a_server_with_scheduled_tasks_off_answers_not_found_and_nothing_is_retried() {
        let (base, _, request) = serve_once(response("404 Not Found", "404 Not Found", ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.schedules(None, None).unwrap_err();
        assert!(!request.join().unwrap().extra_request);
        assert_eq!(error.status, Some(404));
    }

    #[test]
    fn phase2_automation_contract_a_schedule_is_created_with_a_mode_the_confirmed_spend_and_only_the_keys_the_server_takes() {
        let body = json!({ "schedule": schedule_json(SCHEDULE, "workspace-1") });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let created = service.schedule_create(None, &schedule_input()).unwrap();
        let wire = serde_json::to_value(&created).unwrap();
        assert_eq!(wire["webhookTrigger"], Value::Null);
        assert!(wire.get("webhookSecret").is_none());
        let created = created.view;
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-schedules HTTP/1.1"));
        assert_eq!(
            sent_body(&captured),
            json!({
                "workspaceId": "workspace-1", "name": "Nightly triage", "agent": "claude", "model": "sonnet", "mode": "acceptEdits",
                "prompt": "Triage the new issues.",
                "schedule": { "preset": "weekly", "hour": 9, "minute": 30, "weekdays": ["mon", "thu"], "timezone": "Europe/Berlin" },
                "missedRunPolicy": "skip", "completionPolicy": "suspend", "maxRunMinutes": 45, "confirmProviderSpend": true
            })
        );
        assert_eq!(created.id, SCHEDULE);
        assert!(!captured.extra_request, "a create is never sent twice");
    }

    #[test]
    fn phase2_automation_contract_a_schedule_that_the_server_would_refuse_is_not_sent() {
        let (_, service) = test_service("http://127.0.0.1:1");
        let change = |edit: fn(&mut CloudScheduleCreateInput)| {
            let mut input = schedule_input();
            edit(&mut input);
            service.schedule_create(None, &input).unwrap_err().code
        };
        // Nobody watches a scheduled run: never bypass permissions, never no mode.
        assert_eq!(change(|input| input.mode = "bypassPermissions".into()), "cloud_workspace_request_invalid");
        // A model the server would refuse (it takes no space) is not sent.
        assert_eq!(change(|input| input.model = Some("opus 4".into())), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.mode = String::new()), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.name = "   ".into()), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.name = "x".repeat(81)), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.max_run_minutes = 4), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.max_run_minutes = 241), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.completion_policy = "forever".into()), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.schedule.as_mut().unwrap().preset = "cron".into()), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.schedule.as_mut().unwrap().weekdays = Vec::new()), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.schedule.as_mut().unwrap().weekdays = vec!["mon".into(), "mon".into()]), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.schedule.as_mut().unwrap().hour = 24), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.workspace_id = "../other".into()), "cloud_workspace_request_invalid");
        assert_eq!(change(|input| input.prompt = " ".into()), "cloud_workspace_prompt_too_long");
        assert_eq!(change(|input| input.prompt = "x".repeat(MAX_PROMPT_BYTES + 1)), "cloud_workspace_prompt_too_long");
        // A body with a key this build does not know is not a schedule.
        assert!(serde_json::from_value::<CloudScheduleCreateInput>(json!({ "organizationId": "org-2" })).is_err());
    }

    #[test]
    fn phase2_automation_contract_schedule_times_are_sent_as_the_strict_parser_takes_them() {
        let timing = |preset: &str, weekdays: &[&str]| CloudScheduleTiming {
            preset: preset.into(),
            hour: 7,
            minute: 5,
            weekdays: weekdays.iter().map(|day| day.to_string()).collect(),
            timezone: "UTC".into(),
        };
        // `hourly` has no hour; days belong to `weekly` only.
        assert_eq!(schedule_timing_body(&timing("hourly", &[])), Some(json!({ "preset": "hourly", "minute": 5, "timezone": "UTC" })));
        assert_eq!(schedule_timing_body(&timing("daily", &[])), Some(json!({ "preset": "daily", "hour": 7, "minute": 5, "timezone": "UTC" })));
        assert_eq!(schedule_timing_body(&timing("weekdays", &["mon"])), Some(json!({ "preset": "weekdays", "hour": 7, "minute": 5, "timezone": "UTC" })));
        assert_eq!(schedule_timing_body(&timing("weekly", &["sun"])), Some(json!({ "preset": "weekly", "hour": 7, "minute": 5, "weekdays": ["sun"], "timezone": "UTC" })));
        assert_eq!(schedule_timing_body(&timing("weekly", &["funday"])), None);
    }

    #[test]
    fn phase2_automation_contract_an_estimate_is_asked_without_a_prompt_and_read_back() {
        let body = json!({
            "estimate": { "currency": "USD", "hourlyMicros": 120_000, "perRunMaxMicros": 480_000, "monthlyRuns": 30, "monthlyMaxMicros": 86_400_000, "keepsMachineRunning": true, "runningSlots": 1, "maxRunsPerDay": 24 },
            "nextRunAt": 1_792_713_600_000i64, "supported": false
        });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let input: CloudScheduleEstimateInput = serde_json::from_value(json!({
            "workspaceId": "workspace-1", "schedule": { "preset": "daily", "hour": 9, "minute": 0, "timezone": "UTC" }, "completionPolicy": "keep", "maxRunMinutes": 240
        }))
        .unwrap();
        let quote = service.schedule_estimate(None, &input).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-schedules/estimate HTTP/1.1"));
        assert_eq!(
            sent_body(&captured),
            json!({ "workspaceId": "workspace-1", "schedule": { "preset": "daily", "hour": 9, "minute": 0, "timezone": "UTC" }, "completionPolicy": "keep", "maxRunMinutes": 240 })
        );
        assert!(quote.estimate.keeps_machine_running && !quote.supported);
        assert_eq!(quote.next_run_at, Some(1_792_713_600_000));
        // A server from before the bound counted the wait and the grace.
        assert_eq!((quote.estimate.per_run_max_minutes, quote.refusal), (None, None));

        let body = json!({
            "estimate": { "currency": "USD", "hourlyMicros": 120_000, "perRunMaxMinutes": 265, "perRunMaxMicros": 530_000, "monthlyRuns": 30, "monthlyMaxMicros": 15_900_000, "runningSlots": 1, "maxRunsPerDay": 24 },
            "supported": true, "refusal": "cloud_workspace_quota_exceeded"
        });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let quote = service.schedule_estimate(None, &input).unwrap();
        request.join().unwrap();
        assert_eq!((quote.estimate.per_run_max_minutes, quote.refusal.as_deref()), (Some(265), Some("cloud_workspace_quota_exceeded")));
    }

    #[test]
    fn phase2_automation_contract_an_estimate_from_a_server_without_the_route_is_not_a_server_that_cannot_be_reached() {
        let input: CloudScheduleEstimateInput = serde_json::from_value(json!({
            "workspaceId": "workspace-1", "schedule": { "preset": "daily", "hour": 9, "minute": 0, "timezone": "UTC" }, "completionPolicy": "suspend", "maxRunMinutes": 60
        }))
        .unwrap();
        let (base, _, request) = serve_once(response("404 Not Found", "404 Not Found", ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.schedule_estimate(None, &input).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.retryable), ("cloud_schedule_estimate_not_supported", false));
        // Another person's private workspace keeps its own answer.
        let (base, _, request) = serve_once(response("404 Not Found", r#"{"error":"cloud_workspace_not_found"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.schedule_estimate(None, &input).unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_workspace_not_found");
    }

    #[test]
    fn phase2_automation_contract_pause_resume_delete_and_pause_all_send_what_the_server_expects() {
        let answer = json!({ "schedule": schedule_json(SCHEDULE, "workspace-1") }).to_string();
        let (base, _, request) = serve_once(response("200 OK", &answer, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        service.schedule_set_active(None, SCHEDULE, false).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with(&format!("POST /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/pause HTTP/1.1")));
        assert_eq!(sent_body(&captured), json!({}));

        // Held activation reads the saved task first; legacy timer resume
        // retains authorization and its exact spend-confirmation body.
        let (base, requests) = serve_each(vec![response("200 OK", &answer, ""), response("200 OK", &answer, "")]);
        let (_, service) = test_service(&base);
        service.schedule_set_active(None, SCHEDULE, true).unwrap();
        let captured = requests.join().unwrap();
        assert!(captured[0].starts_with(&format!("GET /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE} HTTP/1.1")));
        assert!(captured[1].starts_with(&format!("POST /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE}/resume HTTP/1.1")));
        assert_eq!(serde_json::from_str::<Value>(captured[1].split_once("\r\n\r\n").unwrap().1).unwrap(), json!({ "confirmProviderSpend": true }));
        for request in &captured {
            assert!(request.to_ascii_lowercase().contains("authorization: bearer native-secret-token"));
            assert!(request.to_ascii_lowercase().contains("x-terminalx-cloud-workspace-contract: providers-v1"));
        }

        let (base, _, request) = serve_once(response("200 OK", r#"{"ok":true}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        service.schedule_delete(None, SCHEDULE).unwrap();
        assert!(request.join().unwrap().text.starts_with(&format!("DELETE /v1/desktop/orgs/org-1/cloud-schedules/{SCHEDULE} HTTP/1.1")));

        let (base, _, request) = serve_once(response("200 OK", r#"{"paused":3}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        assert_eq!(service.schedules_pause_all(None).unwrap().paused, 3);
        assert!(request.join().unwrap().text.starts_with("POST /v1/desktop/orgs/org-1/cloud-schedules/pause-all HTTP/1.1"));

        // An id that is not a schedule's never reaches a URL.
        assert_eq!(service.schedule_delete(None, "../cloud-workspaces/workspace-1").unwrap_err().code, "cloud_workspace_request_invalid");
        assert_eq!(service.schedule(None, "schedule_1").unwrap_err().code, "cloud_workspace_request_invalid");
    }

    #[test]
    fn phase2_automation_contract_a_refused_schedule_keeps_the_servers_reason() {
        for code in ["cloud_schedule_revision_conflict", "cloud_schedule_runtime_unsupported", "cloud_schedule_cleanup_pending", "cloud_schedule_prompt_shell_command", "cloud_schedule_prompt_slash_command", "cloud_schedule_prompt_file_mention"] {
            let (base, _, request) = serve_once(response("409 Conflict", &json!({ "error": code }).to_string(), ""), Duration::ZERO);
            let (_, service) = test_service(&base);
            let error = service.schedule_create(None, &schedule_input()).unwrap_err();
            request.join().unwrap();
            assert_eq!(error.code, code);
        }
        // A resume of a task paused for an approval nobody could give.
        let (base, requests) = serve_each(vec![
            response("200 OK", &json!({"schedule": schedule_json(SCHEDULE, "workspace-1")}).to_string(), ""),
            response("409 Conflict", &json!({ "error": "cloud_schedule_needs_approval" }).to_string(), ""),
        ]);
        let (_, service) = test_service(&base);
        let error = service.schedule_set_active(None, SCHEDULE, true).unwrap_err();
        let captured = requests.join().unwrap();
        assert!(captured[0].starts_with("GET ") && captured[1].contains("/resume HTTP/1.1"));
        assert_eq!(error.code, "cloud_schedule_needs_approval");
    }
}
