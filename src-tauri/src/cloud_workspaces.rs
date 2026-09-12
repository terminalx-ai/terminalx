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

use crate::account::{AccountContext, AccountManager};

const ACCOUNT_BASE_URL: &str = "https://login.terminalx.ai";
const CONTRACT: &str = "providers-v1";
const SUPPORTED_PROVIDERS: &str = "machine0,box";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT_BYTES: u64 = 512 * 1024;
const MAX_RETRY_AFTER_SECONDS: u64 = 60 * 60;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloudWorkspaceProviderId {
    Machine0,
    Box,
}

impl CloudWorkspaceProviderId {
    fn as_str(self) -> &'static str {
        match self {
            Self::Machine0 => "machine0",
            Self::Box => "box",
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
    pub progress: Option<OperationProgress>,
    pub events: Option<Vec<OperationEvent>>,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceCreateInput {
    pub name: String,
    pub quote_id: String,
    pub access_mode: WorkspaceAccessMode,
    pub confirm_provider_spend: bool,
    pub idempotency_key: String,
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
    fn local(code: &str, retryable: bool) -> Self {
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
            base: Url::parse(ACCOUNT_BASE_URL).expect("valid account service URL"),
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
        let method = if matches!(risk, RequestRisk::Read) {
            "GET"
        } else {
            "POST"
        };
        let mut request = agent
            .request(method, url.as_str())
            .set("authorization", &format!("Bearer {}", context.access_token))
            .set("content-type", "application/json")
            .set("X-TerminalX-Cloud-Workspace-Contract", CONTRACT)
            .set("X-TerminalX-Cloud-Workspace-Providers", SUPPORTED_PROVIDERS)
            .set("X-TerminalX-Cloud-Workspace-Idle-Options", "never-v1");
        if let Some(key) = idempotency_key {
            request = request.set("Idempotency-Key", key);
        }
        let response = match body {
            Some(body) => request.send_json(body),
            None => request.call(),
        };
        match response {
            Ok(response) => decode_response(response, risk),
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
        let context = self.context()?;
        let result = operation(&self.client, &context);
        if !self.account.is_current(&context) {
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

    pub fn setup(
        &self,
        provider: CloudWorkspaceProviderId,
    ) -> Result<CloudWorkspaceSetup, CloudWorkspaceClientError> {
        self.run(RequestRisk::Read, |client, context| {
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
        input: CloudWorkspaceQuoteInput,
    ) -> Result<CloudWorkspaceQuote, CloudWorkspaceClientError> {
        self.run(RequestRisk::Mutation, |client, context| {
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
        input: CloudWorkspaceCreateInput,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        if !input.confirm_provider_spend || !valid_idempotency_key(&input.idempotency_key) {
            return Err(CloudWorkspaceClientError::local(
                "cloud_workspace_request_invalid",
                false,
            ));
        }
        self.run(RequestRisk::Create, |client, context| {
            let idempotency_key = input.idempotency_key.clone();
            let body = json!({
                "name": input.name,
                "quoteId": input.quote_id,
                "accessMode": input.access_mode,
                "confirmProviderSpend": true
            });
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

    pub fn workspaces(&self) -> Result<CloudWorkspaceList, CloudWorkspaceClientError> {
        self.run(RequestRisk::Read, |client, context| {
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

    pub fn lifecycle(
        &self,
        workspace_id: &str,
        action: OperationAction,
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
            OperationAction::Delete => "delete",
        };
        self.run(RequestRisk::Mutation, |client, context| {
            let result = client.request(
                context,
                &["cloud-workspaces", workspace_id, action_path],
                None,
                Some(json!({})),
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

    pub fn operation(
        &self,
        operation_id: &str,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        self.operation_request(operation_id, RequestRisk::Read)
    }

    pub fn cancel_operation(
        &self,
        operation_id: &str,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        self.operation_request(operation_id, RequestRisk::Mutation)
    }

    fn operation_request(
        &self,
        operation_id: &str,
        risk: RequestRisk,
    ) -> Result<CloudWorkspaceSnapshot, CloudWorkspaceClientError> {
        if !valid_resource_id(operation_id) {
            return Err(CloudWorkspaceClientError::local(
                "cloud_workspace_request_invalid",
                false,
            ));
        }
        self.run(risk, |client, context| {
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
) -> Result<T, CloudWorkspaceClientError> {
    let bytes = bounded_body(response, risk)?;
    serde_json::from_slice(&bytes).map_err(|_| post_send_error(risk))
}

fn bounded_body(
    response: ureq::Response,
    risk: RequestRisk,
) -> Result<Vec<u8>, CloudWorkspaceClientError> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(RESPONSE_LIMIT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| post_send_error(risk))?;
    if bytes.len() as u64 > RESPONSE_LIMIT_BYTES {
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
            | "cloud_provider_credential_invalid"
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
            | "cloud_workspace_quota_exceeded"
            | "idempotency_key_reused"
            | "cloud_workspace_quote_expired"
            | "cloud_workspace_request_invalid"
            | "cloud_workspace_rate_limited"
            | "machine0_invalid_response"
            | "machine0_unavailable"
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
    }) {
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
        let setup = service.setup(CloudWorkspaceProviderId::Box).unwrap();
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
            .create(CloudWorkspaceCreateInput {
                name: "Product website".into(),
                quote_id: "quote-1".into(),
                access_mode: WorkspaceAccessMode::Private,
                confirm_provider_spend: true,
                idempotency_key: "stable create key".into(),
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
        let result = service.operation("operation-1").unwrap();
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
            .quote(CloudWorkspaceQuoteInput {
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
        assert_eq!(service.workspaces().unwrap().workspaces.len(), 1);
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
            .lifecycle("workspace-1", OperationAction::Suspend)
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
        service.cancel_operation("operation-1").unwrap();
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
            .lifecycle("workspace-1", OperationAction::Suspend)
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
            .lifecycle("workspace-1", OperationAction::Delete)
            .unwrap_err();
        let captured = request.join().unwrap();
        assert!(!captured.extra_request);
        assert_eq!(error.code, "cloud_provider_unavailable");
        assert!(!error.retryable);
        assert!(!error.retry_with_same_idempotency_key);
        assert!(error.requires_original_account_context);

        let (base, _, request) = serve_once(unavailable, Duration::ZERO);
        let (_, service) = test_service(&base);
        let error = service.cancel_operation("operation-1").unwrap_err();
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
                .create(CloudWorkspaceCreateInput {
                    name: "Product website".into(),
                    quote_id: "quote-1".into(),
                    access_mode: WorkspaceAccessMode::Private,
                    confirm_provider_spend: true,
                    idempotency_key: "original-key".into(),
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
                },
                latest_operation: None,
            }],
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
                    .create(CloudWorkspaceCreateInput {
                        name: "Product website".into(),
                        quote_id: "quote-1".into(),
                        access_mode: WorkspaceAccessMode::Private,
                        confirm_provider_spend: true,
                        idempotency_key: "original-key".into(),
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
}
