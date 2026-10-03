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

use crate::account::{AccountContext, AccountManager, OrgAccess};

const CONTRACT: &str = "providers-v1";
/// Archive, tombstones and cleanup reports (terminalx-saas contract §10.6).
/// Without it an archived workspace reads as suspended.
const LIFECYCLE: &str = "archive-v1";
/// The local Docker provider (terminalx-saas `cloud:e2e:local --serve`) is
/// offered only by debug builds.
const SUPPORTED_PROVIDERS: &str = if cfg!(debug_assertions) { "machine0,box,local-docker" } else { "machine0,box" };
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 512 * 1024;
const MAX_RETRY_AFTER_SECONDS: u64 = 60 * 60;
/// Diagnostics carry up to a few hundred operations with their history.
const DIAGNOSTICS_RESPONSE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloudWorkspaceProviderId {
    Machine0,
    Box,
    #[serde(rename = "local-docker")]
    LocalDocker,
}

impl CloudWorkspaceProviderId {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Machine0 => "machine0",
            Self::Box => "box",
            Self::LocalDocker => "local-docker",
        }
    }
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
    pub resources: Option<Vec<CloudProviderResource>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DisconnectDisposition { Retain, Destroy }

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
    /// List enrichment (saas #137, PRO-56, contract §20.1). Every field is
    /// optional: older servers omit them, and create, open and lifecycle
    /// responses never carry them. A malformed value reads as absent rather
    /// than failing the list, and an absent one is left out of what the
    /// webview gets, so an old server's list reaches it as before.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub repositories: Option<Vec<WorkspaceRepository>>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
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
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceQuota {
    pub used: u32,
    pub limit: u32,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub running: Option<QuotaUsage>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub total: Option<QuotaUsage>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct QuotaUsage {
    pub used: u32,
    pub limit: u32,
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
    #[serde(default, deserialize_with = "safe_provider_error_code")]
    pub detail_code: Option<String>,
    pub progress: Option<OperationProgress>,
    pub events: Option<Vec<OperationEvent>>,
    /// An archive's final checkpoint: committed, failed, timed-out or skipped
    /// (§10.3). A string so a newer server's value still reaches the page.
    #[serde(default)]
    pub checkpoint: Option<String>,
    /// A delete's cleanup report until the provider confirms (§10.4).
    #[serde(default)]
    pub cleanup: Option<CleanupReport>,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CloudWorkspaceSnapshot {
    pub workspace: CloudWorkspace,
    pub operation: CloudWorkspaceOperation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceListItem {
    pub workspace: CloudWorkspace,
    pub latest_operation: Option<CloudWorkspaceOperation>,
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
    json!({
        "version": 1,
        "credentialIds": [],
        "repositories": repositories
            .iter()
            .map(|repository| {
                let mut entry = json!({ "sourceProvider": "github", "cloneUrl": repository.clone_url });
                if let Some(base) = &repository.base_ref {
                    entry["ref"] = json!(base);
                }
                entry
            })
            .collect::<Vec<_>>(),
    })
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
    body
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
/// `driver` also sends to agents and types into terminals.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShareRole {
    Viewer,
    Driver,
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
pub struct CloudWorkspaceShares {
    pub shares: Vec<CloudWorkspaceShare>,
    pub you: ShareViewer,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CloudWorkspaceShareChange {
    pub share: CloudWorkspaceShare,
    /// Only on a grant: false when an existing share was updated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<bool>,
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
        let mut url = self.base.clone();
        {
            let mut segments = url.path_segments_mut().map_err(|_| {
                CloudWorkspaceClientError::local("cloud_workspace_client_invalid", false)
            })?;
            segments.extend(["v1", "desktop", "orgs", context.organization_id.as_str()]);
            segments.extend(tail.iter().copied());
        }
        if let Some((key, value)) = query {
            url.query_pairs_mut().append_pair(key, value);
        }
        let agent = ureq::AgentBuilder::new()
            .timeout(self.timeout)
            .redirects(0)
            .build();
        let mut request = agent
            .request(method, url.as_str())
            .set("authorization", &format!("Bearer {}", context.access_token))
            .set("content-type", "application/json")
            .set("X-TerminalX-Cloud-Workspace-Contract", CONTRACT)
            .set("X-TerminalX-Cloud-Workspace-Providers", SUPPORTED_PROVIDERS)
            .set("X-TerminalX-Cloud-Workspace-Idle-Options", "never-v1")
            .set("X-TerminalX-Cloud-Workspace-Lifecycle", LIFECYCLE);
        if let Some(key) = idempotency_key {
            request = request.set("Idempotency-Key", key);
        }
        let response = match body {
            Some(body) => request.send_json(body),
            None => request.call(),
        };
        match response {
            Ok(response) => decode_response(response, risk, limit),
            Err(ureq::Error::Status(status, response)) => Err(http_error(status, response, risk)),
            Err(ureq::Error::Transport(_)) => Err(transport_error(risk)),
        }
    }
}

pub struct CloudWorkspaceService {
    account: Arc<AccountManager>,
    client: Client,
}

impl CloudWorkspaceService {
    pub fn new(account: Arc<AccountManager>) -> Self {
        Self {
            account,
            client: Client::production(),
        }
    }

    #[cfg(test)]
    fn for_test(account: Arc<AccountManager>, base: &str, timeout: Duration) -> Self {
        Self {
            account,
            client: Client::for_test(base, timeout),
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
            ensure_connection(result, provider)
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
        let connection = ensure_connection(connection, provider)?;
        if !self.account.is_current(&context) {
            return Err(context_changed_error(RequestRisk::Read));
        }
        if !connection.can_manage {
            return Err(CloudWorkspaceClientError::local("organization_admin_required", false));
        }
        Ok(ProviderConnectAuthorization { context, provider })
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
        ensure_connection(result, authorization.provider)
    }

    pub fn disconnect_provider(
        &self,
        provider: CloudWorkspaceProviderId,
        context_revision: String,
        disposition: DisconnectDisposition,
    ) -> Result<CloudProviderConnectionResponse, CloudWorkspaceClientError> {
        let authorization = self.authorize_connect(provider)?;
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
        ensure_connection(result, provider)
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
            ensure_provider(result, provider, RequestRisk::Read)
        })
    }

    pub fn quote(
        &self,
        org: Option<&str>,
        input: CloudWorkspaceQuoteInput,
    ) -> Result<CloudWorkspaceQuote, CloudWorkspaceClientError> {
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            let provider = input.provider;
            let result = client.request(
                context,
                &["cloud-workspaces", "quote"],
                None,
                Some(serde_json::to_value(input).expect("serialize quote input")),
                None,
                RequestRisk::Mutation,
            )?;
            ensure_provider(result, provider, RequestRisk::Mutation)
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
            if let Some(launch) = &input.launch {
                body["launch"] = launch_body(launch);
            }
            let result = client.request(
                context,
                &["cloud-workspaces"],
                None,
                Some(body),
                Some(&idempotency_key),
                RequestRisk::Create,
            )?;
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

    /// Check the repositories and refs before quoting (contract §16).
    pub fn preflight(&self, org: Option<&str>, repositories: Vec<CreateRepository>) -> Result<CloudWorkspacePreflight, CloudWorkspaceClientError> {
        if repositories.is_empty() {
            return Ok(CloudWorkspacePreflight { ready: true, checks: Vec::new() });
        }
        validate_create("preflight", &repositories, None)?;
        // A POST, but it changes nothing: a failed call is simply retryable,
        // never an unknown outcome.
        self.run_in(org, RequestRisk::Mutation, |client, context| {
            client.request(
                context,
                &["cloud-workspaces", "preflight"],
                None,
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
        let action_path = match action {
            OperationAction::Suspend => "suspend",
            OperationAction::Resume => "resume",
            OperationAction::Archive => "archive",
            OperationAction::Delete => "delete",
        };
        let body = if force && matches!(action, OperationAction::Archive | OperationAction::Delete) {
            json!({ "force": true })
        } else {
            json!({})
        };
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
    pub fn set_access(&self, org: Option<&str>, workspace_id: &str, access_mode: WorkspaceAccessMode) -> Result<CloudWorkspace, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Mutation, |client, context| {
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
        })
    }

    /// Who the workspace is shared with, and what the caller may do (§21.2).
    pub fn shares(&self, org: Option<&str>, workspace_id: &str) -> Result<CloudWorkspaceShares, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Read, |client, context| {
            let result: CloudWorkspaceShares = client.request(
                context,
                &["cloud-workspaces", workspace_id, "shares"],
                None,
                None,
                None,
                RequestRisk::Read,
            )?;
            if result.shares.iter().any(|share| !valid_resource_id(&share.user_id)) {
                return Err(invalid_response());
            }
            Ok(result)
        })
    }

    /// Grant or change one member's share. Idempotent: the same body twice
    /// leaves one share.
    pub fn share_put(
        &self,
        org: Option<&str>,
        workspace_id: &str,
        user_id: &str,
        role: ShareRole,
        can_approve: bool,
    ) -> Result<CloudWorkspaceShareChange, CloudWorkspaceClientError> {
        if !valid_resource_id(workspace_id) || !valid_resource_id(user_id) {
            return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
        }
        self.run_in(org, RequestRisk::Mutation, |client, context| {
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
        self.run_in(org, RequestRisk::Mutation, |client, context| {
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
        self.run_in(org, risk, |client, context| {
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
        })
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
) -> Result<Vec<u8>, CloudWorkspaceClientError> {
    bounded_body_limited(response, risk, RESPONSE_LIMIT_BYTES)
}

fn bounded_body_limited(
    response: ureq::Response,
    risk: RequestRisk,
    limit: u64,
) -> Result<Vec<u8>, CloudWorkspaceClientError> {
    let mut bytes = Vec::new();
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

fn known_error_code(code: &str) -> bool {
    matches!(
        code,
        "invalid_access_token"
            | "organization_admin_required"
            | "active_organization_required"
            | "cloud_workspace_not_found"
            | "cloud_workspace_operation_not_found"
            | "machine0_connection_required"
            | "cloud_provider_not_found"
            | "cloud_provider_connection_required"
            | "cloud_provider_connection_attention_required"
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
            | "cloud_workspace_device_auth_unavailable"
            | "cloud_workspace_operation_in_progress"
            | "cloud_workspace_active_work"
            | "cloud_workspace_archived"
            | "cloud_teardown_in_progress"
            | "cloud_workspace_quota_exceeded"
            | "cloud_workspace_concurrency_exceeded"
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
            | "cloud_workspace_share_not_found"
            | "cloud_workspace_share_redundant"
            | "cloud_workspace_share_requires_organization_access"
            | "cloud_workspace_share_limit"
            | "cloud_workspace_share_forbidden"
            | "cloud_workspace_collaboration_forbidden"
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
        )
}

fn ensure_provider<T>(
    value: T,
    expected: CloudWorkspaceProviderId,
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
    expected: CloudWorkspaceProviderId,
) -> Result<CloudProviderConnectionResponse, CloudWorkspaceClientError> {
    if value.provider != expected {
        return Err(invalid_response());
    }
    Ok(value)
}

trait ProviderBound {
    fn provider_id(&self) -> CloudWorkspaceProviderId;
}

impl ProviderBound for CloudProviderSummary {
    fn provider_id(&self) -> CloudWorkspaceProviderId {
        self.id
    }
}
impl ProviderBound for CloudWorkspaceSetup {
    fn provider_id(&self) -> CloudWorkspaceProviderId {
        self.provider
    }
}
impl ProviderBound for CloudWorkspaceQuote {
    fn provider_id(&self) -> CloudWorkspaceProviderId {
        self.provider
    }
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
        item.workspace.org_id != org_id
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

    fn serve_once(
        response: String,
        response_delay: Duration,
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
            thread::sleep(response_delay);
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
        for code in ["cloud_workspace_runtime_bootstrap_failed", "cloud_provider_permission_denied"] {
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
        assert_eq!(parse(Value::Null, json!({ "raw": "body" })), (None, None));
        // An older server sends neither, and nothing is invented for it.
        let old: CloudWorkspaceSnapshot = serde_json::from_str(&snapshot_body(Some("cloud_provider_permission_denied"))).unwrap();
        assert_eq!(old.operation.detail_code, None);
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
        assert!(lower.contains("x-terminalx-cloud-workspace-providers: machine0,box"));
    }

    #[test]
    fn provider_detail_uses_connection_dto_and_fixed_path() {
        let body =
            r#"{"provider":"box","state":"not-connected","canManage":false,"ignored":"drop"}"#;
        let (base, _, request) = serve_once(response("200 OK", body, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let detail = service.provider(CloudWorkspaceProviderId::Box).unwrap();
        let captured = request.join().unwrap();
        assert_eq!(detail.provider, CloudWorkspaceProviderId::Box);
        assert!(matches!(
            detail.state,
            CloudProviderConnectionState::NotConnected
        ));
        assert!(!detail.can_manage);
        assert!(captured
            .text
            .starts_with("GET /v1/desktop/orgs/org-1/cloud-providers/box HTTP/1.1"));
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

    #[test]
    fn provider_disconnect_denies_members_before_any_mutation() {
        let (base, _, request) = serve_once(response("200 OK", r#"{"provider":"box","state":"connected","canManage":false}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.disconnect_provider(CloudWorkspaceProviderId::Box, AccountManager::context_revision(&context()), DisconnectDisposition::Retain).unwrap_err();
        assert_eq!(error.code, "organization_admin_required");
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("GET "));
        assert!(!captured.extra_request);
    }

    #[test]
    fn provider_disconnect_fences_stale_organization_before_mutation() {
        let (base, _, request) = serve_once(response("200 OK", r#"{"provider":"box","state":"connected","canManage":true}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.disconnect_provider(CloudWorkspaceProviderId::Box, "old-context".into(), DisconnectDisposition::Destroy).unwrap_err();
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
        let setup = service.setup(None, CloudWorkspaceProviderId::Box).unwrap();
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
                provider: CloudWorkspaceProviderId::Machine0,
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
                    provider: CloudWorkspaceProviderId::Box,
                    state: WorkspaceState::Ready,
                    access_mode: WorkspaceAccessMode::Private,
                    created_at: 1,
                    updated_at: 1,
                    release_disposition: None,
                    launch: None,
                    archived_at: None,
                    delete_after: None,
                    deleted_at: None,
                    repositories: None,
                    created_by: None,
                    last_activity_at: None,
                    revision: None,
                    runtime_activity: None,
                    authority: None,
                    you: None,
                    shared_with: None,
                },
                latest_operation: None,
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

    #[test]
    fn invalid_names_repositories_refs_and_launches_never_reach_the_server() {
        let (_, service) = test_service("http://127.0.0.1:9");
        let launch = |agent: &str, prompt: Option<String>| Some(CreateLaunch { agent: agent.into(), model: None, effort: None, mode: None, prompt });
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
        let result = service.preflight(None, vec![repo("app", Some("nope"))]).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/preflight "));
        assert!(captured.text.contains(r#""ref":"nope""#));
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
    fn a_failed_preflight_call_is_retryable_not_an_unknown_outcome() {
        let (base, _, request) = serve_once(response("503 Service Unavailable", "oops", ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.preflight(None, vec![repo("app", None)]).unwrap_err();
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
        for field in ["repositories", "createdBy", "lastActivityAt", "runtimeActivity", "revision", "authority"] {
            assert!(sent["workspaces"][0]["workspace"].get(field).is_none(), "{field}");
        }
        assert!(sent.get("quota").is_none());
        // A pre-PRO-76 quota has no running or total.
        let quota: CloudWorkspaceQuota = serde_json::from_value(json!({ "used": 1, "limit": 2 })).unwrap();
        assert_eq!(serde_json::to_value(quota).unwrap(), json!({ "used": 1, "limit": 2 }));
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

    #[test]
    fn shares_list_reads_the_caller_standing() {
        let body = json!({
            "shares": [share_json("user-2", "viewer")],
            "you": { "role": "manager", "canApprove": true, "canManageShares": true }
        });
        let (base, _, request) = serve_once(response("200 OK", &body.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let listed = service.shares(None, "workspace-1").unwrap();
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
        let changed = service.set_access(None, "workspace-1", WorkspaceAccessMode::Organization).unwrap();
        let captured = request.join().unwrap();
        assert!(captured.text.starts_with("POST /v1/desktop/orgs/org-1/cloud-workspaces/workspace-1/access HTTP/1.1"));
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent, json!({ "accessMode": "organization" }));
        assert!(matches!(changed.access_mode, WorkspaceAccessMode::Organization));

        // Back to private: the same route, the other mode.
        workspace["accessMode"] = json!("private");
        let (base, _, request) = serve_once(response("200 OK", &workspace.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let changed = service.set_access(None, "workspace-1", WorkspaceAccessMode::Private).unwrap();
        let captured = request.join().unwrap();
        let sent: Value = serde_json::from_str(captured.text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent, json!({ "accessMode": "private" }));
        assert!(matches!(changed.access_mode, WorkspaceAccessMode::Private));

        // An answer for another workspace is an unknown outcome, not a success.
        workspace["id"] = json!("workspace-9");
        let (base, _, request) = serve_once(response("200 OK", &workspace.to_string(), ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.set_access(None, "workspace-1", WorkspaceAccessMode::Private).unwrap_err();
        request.join().unwrap();
        assert_eq!(error.code, "cloud_workspace_request_outcome_unknown");
    }

    #[test]
    fn set_access_keeps_the_refusal_of_a_member_and_checks_the_id_first() {
        let (base, _, request) = serve_once(response("403 Forbidden", r#"{"error":"organization_admin_required"}"#, ""), Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.set_access(None, "workspace-1", WorkspaceAccessMode::Organization).unwrap_err();
        request.join().unwrap();
        assert_eq!((error.code.as_str(), error.status), ("organization_admin_required", Some(403)));
        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.set_access(None, "../x", WorkspaceAccessMode::Private).unwrap_err().code, "cloud_workspace_request_invalid");
    }

    #[test]
    fn share_identifiers_are_checked_before_sending() {
        let (_, service) = test_service("http://127.0.0.1:9");
        assert_eq!(service.share_put(None, "workspace-1", "../x", ShareRole::Viewer, false).unwrap_err().code, "cloud_workspace_request_invalid");
        assert_eq!(service.share_revoke(None, "", "user-2").unwrap_err().code, "cloud_workspace_request_invalid");
        assert_eq!(service.shares(None, "a/b").unwrap_err().code, "cloud_workspace_request_invalid");
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
}
