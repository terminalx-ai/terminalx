//! Tauri commands. Thin: validate, call a module, map the error to a string.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};
use crate::store::projects::{self, Project};
use crate::{git, harness, names, store};

pub use crate::session_ops::{NewSession, NewTab};
pub(crate) use crate::session_ops::create_session_blocking;
use crate::session_ops::{available_worktree_name, rename_workspace_entries};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}


// ------------------------------------------------------------------ account

#[tauri::command]
pub async fn account_status(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::AccountStatus> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || account.status(&app)).await.map_err(err)
}

/// Read the organizations and the role in each again from the account service.
#[tauri::command]
pub async fn account_refresh_roles(
    app: AppHandle,
    force: bool,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::RolesRefresh> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || account.refresh_roles(&app, force)).await.map_err(err)
}

/// Off the main thread: the first call reads the saved session from the Keychain.
#[tauri::command]
pub async fn account_sign_in(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::AccountStatus> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || account.begin_sign_in(&app)).await.map_err(err)?.map_err(err)
}

/// Opens an organization's page in the web console in the system browser
/// (PRO-40: API keys and webhooks are managed there).
#[tauri::command]
pub fn organization_console_open(app: AppHandle, organization_id: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = crate::account::organization_console_url(&organization_id).map_err(err)?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(err)
}

#[tauri::command]
pub async fn account_sign_out(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::AccountStatus> {
    state.pairing.sign_out().await;
    // Withdrawn while the token still works: this Mac's issues stop showing as worked on.
    let claims = state.work_claims.clone();
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || claims.sign_out(|| account.sign_out(&app))).await.map_err(err)
}

#[tauri::command]
pub async fn organization_create(
    name: String,
    idempotency_key: String,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::OrganizationCreated> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || account.create_organization(&name, &idempotency_key))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
pub async fn organization_select(
    app: AppHandle,
    organization_id: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::AccountStatus> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<crate::account::AccountStatus> {
        account.select_organization_for_revision(&organization_id, &context_revision)?;
        Ok(account.status(&app))
    }).await.map_err(err)?.map_err(err)
}

// ------------------------------------------------------ organization members

type MembersResult = Result<crate::organization_members::OrganizationRoster, crate::organization_members::OrganizationMembersError>;

async fn members_call(
    state: tauri::State<'_, crate::AppState>,
    operation: impl FnOnce(&crate::organization_members::OrganizationMembersService) -> MembersResult + Send + 'static,
) -> MembersResult {
    let service = state.organization_members.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|_| crate::organization_members::OrganizationMembersError::local("organization_members_unavailable"))?
}

#[tauri::command]
pub async fn organization_members(state: tauri::State<'_, crate::AppState>) -> MembersResult {
    members_call(state, |service| service.list()).await
}

/// The roster of a member organization other than the active one, read only
/// (the people a cloud workspace there can be shared with).
#[tauri::command]
pub async fn organization_members_in(org_id: String, state: tauri::State<'_, crate::AppState>) -> MembersResult {
    members_call(state, move |service| service.list_in(&org_id)).await
}

#[tauri::command]
pub async fn organization_member_invite(
    email: String,
    role: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> MembersResult {
    members_call(state, move |service| service.invite(&email, &role, &context_revision)).await
}

#[tauri::command]
pub async fn organization_invite_revoke(
    email: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> MembersResult {
    members_call(state, move |service| service.revoke_invite(&email, &context_revision)).await
}

#[tauri::command]
pub async fn organization_member_role_update(
    user_id: String,
    role: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> MembersResult {
    members_call(state, move |service| service.update_role(&user_id, &role, &context_revision)).await
}

#[tauri::command]
pub async fn organization_member_remove(
    user_id: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> MembersResult {
    members_call(state, move |service| service.remove(&user_id, &context_revision)).await
}

// ------------------------------------------------------ organization compute

type ComputeResult = Result<serde_json::Value, crate::organization_compute::OrganizationComputeError>;

async fn compute_call(
    state: tauri::State<'_, crate::AppState>,
    operation: impl FnOnce(&crate::organization_compute::OrganizationComputeService) -> ComputeResult + Send + 'static,
) -> ComputeResult {
    let service = state.organization_compute.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|_| crate::organization_compute::OrganizationComputeError::local("organization_compute_unavailable"))?
}

#[tauri::command]
pub async fn organization_compute_policy(state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    compute_call(state, |service| service.policy()).await
}

#[tauri::command]
pub async fn organization_compute_usage(state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    compute_call(state, |service| service.usage()).await
}

#[tauri::command]
pub async fn organization_compute_policy_update(
    policy: serde_json::Value,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    compute_call(state, move |service| service.update_policy(&policy, &context_revision)).await
}

#[tauri::command]
pub async fn organization_compute_provisioning_pause(
    expected_version: u64,
    paused: bool,
    reason: Option<String>,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    compute_call(state, move |service| {
        service.set_provisioning_paused(expected_version, paused, reason.as_deref(), &context_revision)
    })
    .await
}

// -------------------------------------------------- organization GitHub App

type GithubAppResult<T> = Result<T, crate::organization_github_app::GithubAppError>;

async fn github_app_call<T: Send + 'static>(
    state: tauri::State<'_, crate::AppState>,
    operation: impl FnOnce(&crate::organization_github_app::OrganizationGithubAppService) -> GithubAppResult<T> + Send + 'static,
) -> GithubAppResult<T> {
    let service = state.organization_github_app.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|_| crate::organization_github_app::GithubAppError::local("github_app_request_failed"))?
}

#[tauri::command]
pub async fn organization_github_app(
    state: tauri::State<'_, crate::AppState>,
) -> GithubAppResult<crate::organization_github_app::GithubAppSummary> {
    github_app_call(state, |service| service.summary()).await
}

#[tauri::command]
pub async fn organization_github_app_connect(
    context_revision: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> GithubAppResult<crate::organization_github_app::ConnectAttempt> {
    use tauri_plugin_opener::OpenerExt;
    github_app_call(state, move |service| {
        service.connect(&context_revision, |url| app.opener().open_url(url, None::<&str>).is_ok())
    })
    .await
}

#[tauri::command]
pub async fn organization_github_app_attempt(
    attempt_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> GithubAppResult<crate::organization_github_app::ConnectAttempt> {
    github_app_call(state, move |service| service.attempt(&attempt_id)).await
}

#[tauri::command]
pub async fn organization_github_app_attempt_cancel(
    attempt_id: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> GithubAppResult<crate::organization_github_app::ConnectAttempt> {
    github_app_call(state, move |service| service.cancel_attempt(&attempt_id, &context_revision)).await
}

#[tauri::command]
pub async fn organization_github_app_repositories(
    installation_id: String,
    query: String,
    refresh: bool,
    state: tauri::State<'_, crate::AppState>,
) -> GithubAppResult<crate::organization_github_app::LiveRepositories> {
    github_app_call(state, move |service| service.repositories(&installation_id, &query, refresh)).await
}

#[tauri::command]
pub async fn organization_github_app_repositories_save(
    repositories: Vec<crate::organization_github_app::RepositoryChoice>,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> GithubAppResult<()> {
    github_app_call(state, move |service| service.save_repositories(&repositories, &context_revision)).await
}

#[tauri::command]
pub async fn organization_github_app_disconnect(
    installation_id: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> GithubAppResult<()> {
    github_app_call(state, move |service| service.disconnect(&installation_id, &context_revision)).await
}

/// Open a GitHub page (an installation's settings) in the browser. Anything
/// that is not on https://github.com is refused.
#[tauri::command]
pub fn organization_github_app_open(url: String, app: tauri::AppHandle) -> GithubAppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    if !crate::organization_github_app::allowed_github_url(&url) {
        return Err(crate::organization_github_app::GithubAppError::local("invalid_request"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| crate::organization_github_app::GithubAppError::local("github_app_browser_failed"))
}

// ------------------------------------------------ organization environment

async fn environment_call(
    state: tauri::State<'_, crate::AppState>,
    operation: impl FnOnce(&crate::organization_environment::OrganizationEnvironmentService) -> ComputeResult + Send + 'static,
) -> ComputeResult {
    let service = state.organization_environment.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|_| crate::organization_compute::OrganizationComputeError::local("cloud_environment_unavailable"))?
}

#[tauri::command]
pub async fn organization_environment_status(provider: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    environment_call(state, move |service| service.status(&provider)).await
}

#[tauri::command]
pub async fn organization_environment_update(
    provider: String,
    expected_revision: u64,
    definition: serde_json::Value,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    environment_call(state, move |service| service.update(&provider, expected_revision, &definition, &context_revision)).await
}

#[tauri::command]
pub async fn organization_environment_build(
    provider: String,
    idempotency_key: String,
    confirm_provider_spend: bool,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    environment_call(state, move |service| service.build(&provider, &idempotency_key, confirm_provider_spend, &context_revision)).await
}

#[tauri::command]
pub async fn organization_environment_version(version_id: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    environment_call(state, move |service| service.version(&version_id)).await
}

#[tauri::command]
pub async fn organization_environment_version_retry(
    version_id: String,
    confirm_provider_spend: bool,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    environment_call(state, move |service| service.retry(&version_id, confirm_provider_spend, &context_revision)).await
}

#[tauri::command]
pub async fn organization_environment_version_cancel(version_id: String, context_revision: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    environment_call(state, move |service| service.cancel(&version_id, &context_revision)).await
}

#[tauri::command]
pub async fn organization_environment_version_rollback(version_id: String, context_revision: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    environment_call(state, move |service| service.rollback(&version_id, &context_revision)).await
}

#[tauri::command]
pub async fn organization_environment_recipes(provider: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    environment_call(state, move |service| service.recipes(&provider)).await
}

#[tauri::command]
pub async fn organization_environment_recipe_propose(
    provider: String,
    recipe: serde_json::Value,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    environment_call(state, move |service| service.propose_recipe(&provider, &recipe, &context_revision)).await
}

#[tauri::command]
pub async fn organization_environment_recipe_apply(
    recipe_id: String,
    confirm_apply: bool,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    environment_call(state, move |service| service.apply_recipe(&recipe_id, confirm_apply, &context_revision)).await
}

#[tauri::command]
pub async fn organization_environment_recipe_dismiss(recipe_id: String, context_revision: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    environment_call(state, move |service| service.dismiss_recipe(&recipe_id, &context_revision)).await
}

// ------------------------------------------- cloud workspace configuration

async fn config_call(
    state: tauri::State<'_, crate::AppState>,
    operation: impl FnOnce(&crate::organization_workspace_config::WorkspaceConfigService) -> ComputeResult + Send + 'static,
) -> ComputeResult {
    let service = state.workspace_config.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|_| crate::organization_compute::OrganizationComputeError::local("cloud_workspace_config_unavailable"))?
}

#[tauri::command]
pub async fn workspace_config_organization(state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    config_call(state, |service| service.organization()).await
}

#[tauri::command]
pub async fn workspace_config_organization_update(layer: serde_json::Value, context_revision: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    config_call(state, move |service| service.update_organization(&layer, &context_revision)).await
}

#[tauri::command]
pub async fn workspace_config_repository_update(layer: serde_json::Value, context_revision: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    config_call(state, move |service| service.update_repository(&layer, &context_revision)).await
}

#[tauri::command]
pub async fn workspace_config_workspace(workspace_id: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    config_call(state, move |service| service.workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn workspace_config_workspace_update(
    workspace_id: String,
    layer: serde_json::Value,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    config_call(state, move |service| service.update_workspace(&workspace_id, &layer, &context_revision)).await
}

#[tauri::command]
pub async fn workspace_config_secrets(state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    config_call(state, |service| service.secrets()).await
}

#[tauri::command]
pub async fn workspace_config_secret_put(
    name: String,
    value: String,
    runtime_access: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    let value = zeroize::Zeroizing::new(value);
    config_call(state, move |service| service.put_secret(&name, value, &runtime_access, &context_revision)).await
}

#[tauri::command]
pub async fn workspace_config_secret_delete(name: String, context_revision: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    config_call(state, move |service| service.delete_secret(&name, &context_revision)).await
}

#[tauri::command]
pub async fn workspace_config_secret_bind(
    name: String,
    scope: String,
    target: String,
    env_name: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> ComputeResult {
    config_call(state, move |service| service.bind_secret(&name, &scope, &target, &env_name, &context_revision)).await
}

#[tauri::command]
pub async fn workspace_config_secret_unbind(binding_id: String, context_revision: String, state: tauri::State<'_, crate::AppState>) -> ComputeResult {
    config_call(state, move |service| service.unbind_secret(&binding_id, &context_revision)).await
}

// --------------------------------------------------------- cloud workspaces

macro_rules! cloud_command {
    ($state:expr, $risk:expr, $operation:expr) => {{
        let service = $state.cloud_workspaces.clone();
        tauri::async_runtime::spawn_blocking(move || $operation(service))
            .await
            .map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::task_failed($risk))?
    }};
}

#[tauri::command]
pub async fn cloud_providers(
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudProviderSummaryResponse, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.providers())
}

#[tauri::command]
pub async fn cloud_provider(
    provider: crate::cloud_workspaces::CloudWorkspaceProviderId,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudProviderConnectionResponse, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.provider(provider))
}

enum ProviderPromptError { Cancelled, Empty, Unavailable }

impl ProviderPromptError {
    fn client_error(self) -> crate::cloud_workspaces::CloudWorkspaceClientError {
        let code = match self {
            Self::Cancelled => "cloud_provider_entry_cancelled",
            Self::Empty => "cloud_provider_credential_required",
            Self::Unavailable => "cloud_provider_secure_input_unavailable",
        };
        crate::cloud_workspaces::CloudWorkspaceClientError::local(code, false)
    }
}

/// What the native dialog for a provider key says: the provider and the
/// organization by the names Settings shows.
fn provider_key_prompt(provider: &str, organization: &str) -> String {
    format!("Enter the {provider} provider key for organization {organization}. The key is sent to the account service only for validation and secure storage.")
}

/// A key typed into a native secure field: it never passes through the
/// webview, and the field is emptied whichever way the dialog ends.
#[cfg(target_os = "macos")]
fn secure_prompt(title: &str, text: &str, placeholder: &str) -> Result<zeroize::Zeroizing<String>, ProviderPromptError> {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAlert, NSSecureTextField, NSAlertFirstButtonReturn};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    let mtm = MainThreadMarker::new().ok_or(ProviderPromptError::Unavailable)?;
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(text));
    let field = NSSecureTextField::initWithFrame(NSSecureTextField::alloc(mtm), NSRect::new(NSPoint::new(0., 0.), NSSize::new(360., 24.)));
    field.setPlaceholderString(Some(&NSString::from_str(placeholder)));
    alert.setAccessoryView(Some(&field));
    alert.addButtonWithTitle(&NSString::from_str("Validate"));
    alert.addButtonWithTitle(&NSString::from_str("Cancel"));
    let response = alert.runModal();
    if response != NSAlertFirstButtonReturn {
        field.setStringValue(&NSString::from_str(""));
        return Err(ProviderPromptError::Cancelled);
    }
    let value = zeroize::Zeroizing::new(field.stringValue().to_string());
    field.setStringValue(&NSString::from_str(""));
    if value.trim().is_empty() { return Err(ProviderPromptError::Empty); }
    Ok(value)
}

#[tauri::command]
pub async fn cloud_provider_connect(
    app: AppHandle,
    provider: crate::cloud_workspaces::CloudWorkspaceProviderId,
    input: crate::cloud_workspaces::CloudProviderConnectInput,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudProviderConnectionResponse, crate::cloud_workspaces::CloudWorkspaceClientError> {
    crate::cloud_workspaces::validate_disclosure(&input)?;
    static PROMPT_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _prompt_guard = PROMPT_GUARD.try_lock().map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::local("cloud_provider_operation_in_progress", true))?;
    let service = state.cloud_workspaces.clone();
    let (authorization, provider_name) = tauri::async_runtime::spawn_blocking(move || {
        let authorization = service.authorize_connect(provider)?;
        let provider_name = service.provider_display_name(&authorization);
        Ok::<_, crate::cloud_workspaces::CloudWorkspaceClientError>((authorization, provider_name))
    })
    .await
    .map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::task_failed(crate::cloud_workspaces::RequestRisk::Read))??;
    let text = provider_key_prompt(
        &dialog_name(provider_name, provider.label()),
        &dialog_name(state.account.organization_name(authorization.organization_id()), authorization.organization_id()),
    );
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || { let _ = sender.send(secure_prompt("Provider connection", &text, "Provider key")); })
        .map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::local("cloud_provider_secure_input_unavailable", false))?;
    let prompt_result = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::local("cloud_provider_secure_input_unavailable", false))?
        .map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::local("cloud_provider_secure_input_unavailable", false))?;
    let credential = prompt_result.map_err(ProviderPromptError::client_error)?;
    let service = state.cloud_workspaces.clone();
    tauri::async_runtime::spawn_blocking(move || service.connect_authorized(authorization, input, credential))
        .await
        .map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::task_failed(crate::cloud_workspaces::RequestRisk::Mutation))?
}

#[cfg(not(target_os = "macos"))]
fn secure_prompt(_title: &str, _text: &str, _placeholder: &str) -> Result<zeroize::Zeroizing<String>, ProviderPromptError> {
    Err(ProviderPromptError::Unavailable)
}

// ------------------------------------------------- agent logins (PRO-79)

/// Where a login to store comes from. Either way it is collected here, in
/// Rust: the webview names the source and never holds the login.
#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentLoginSource {
    /// An API key typed into a native secure dialog.
    ApiKey,
    /// The agent's own login already on this computer.
    LocalLogin,
}

/// Whose subscription a sign-in for the agent runs on.
fn subscription_label(provider: crate::cloud_workspaces::AgentLoginProvider) -> &'static str {
    use crate::cloud_workspaces::AgentLoginProvider::*;
    match provider {
        Codex => "ChatGPT",
        Claude => "Claude",
        Cursor => "Cursor",
    }
}

fn agent_label(provider: crate::cloud_workspaces::AgentLoginProvider) -> &'static str {
    use crate::cloud_workspaces::AgentLoginProvider::*;
    match provider {
        Codex => "Codex",
        Claude => "Claude Code",
        Cursor => "Cursor",
    }
}

#[tauri::command]
pub async fn cloud_agent_logins(
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::AgentLoginList, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.agent_logins(org_id.as_deref()))
}

/// Store an agent's login for the organization's cloud workspaces. The
/// order matters: consent and the owner-or-admin check first, and only then
/// is a key asked for or this computer's login read.
#[tauri::command]
pub async fn cloud_agent_login_connect(
    app: AppHandle,
    provider: crate::cloud_workspaces::AgentLoginProvider,
    source: AgentLoginSource,
    consent: crate::cloud_workspaces::AgentLoginConsent,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::AgentLogin, crate::cloud_workspaces::CloudWorkspaceClientError> {
    use crate::cloud_workspaces::{AgentLoginKind, AgentLoginProvider, CloudWorkspaceClientError, RequestRisk};
    // Claude Code's and Codex's sign-ins can be lent without their refresh tokens; Cursor keeps none to lend.
    if source == AgentLoginSource::LocalLogin && provider == AgentLoginProvider::Cursor {
        return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
    }
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = GUARD.try_lock().map_err(|_| CloudWorkspaceClientError::local("cloud_provider_operation_in_progress", true))?;
    let service = state.cloud_workspaces.clone();
    let authorization = tauri::async_runtime::spawn_blocking(move || service.authorize_agent_login(provider, &consent))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))??;
    // The organization by name, the active one or another the person belongs to; its id when no name is known.
    let organization = dialog_name(state.account.organization_name(authorization.organization_id()), authorization.organization_id());
    let replaces = authorization.replaces();
    let unavailable = || CloudWorkspaceClientError::local("cloud_provider_secure_input_unavailable", false);
    let (kind, secret, identity) = match source {
        AgentLoginSource::ApiKey => {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let title = format!("{} API key", agent_label(provider));
            let text = format!(
                "{}Enter the {} API key for organization {}. It is sent to the account service only for validation and encrypted storage, and is not shown again. {}",
                replacement_notice(agent_label(provider), &organization, replaces),
                agent_label(provider),
                organization,
                authorization.reach(AgentLoginKind::ApiKey).sentence()
            );
            app.run_on_main_thread(move || {
                let _ = sender.send(secure_prompt(&title, &text, "API key"));
            })
            .map_err(|_| unavailable())?;
            let entered = tauri::async_runtime::spawn_blocking(move || receiver.recv()).await.map_err(|_| unavailable())?.map_err(|_| unavailable())?;
            (AgentLoginKind::ApiKey, entered.map_err(ProviderPromptError::client_error)?, None)
        }
        AgentLoginSource::LocalLogin => {
            let reader = if provider == AgentLoginProvider::Codex { crate::agent_local_login::codex } else { crate::agent_local_login::claude };
            let read = tauri::async_runtime::spawn_blocking(reader)
                .await
                .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))?;
            let login = read.map_err(|error| CloudWorkspaceClientError::local(error.code(), false))?;
            // The confirmation that counts. What the webview says the person agreed to is only a
            // request: this dialog is drawn by the app itself, names the organization and the
            // account, and nothing is uploaded unless its own button is pressed. Every time.
            let expires = local_time(login.expires_at_ms);
            let agent = agent_label(provider);
            let account = login.account.clone().unwrap_or_else(|| format!("the {agent} account signed in on this Mac (its name is not recorded here)"));
            let text = local_login_confirmation(provider, &organization, &account, &expires, replaces, &authorization.reach(AgentLoginKind::LoginDocument));
            let title = format!("Lend this Mac's {agent} sign-in?");
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            app.run_on_main_thread(move || {
                let _ = sender.send(native_confirm(&title, &text, "Upload access token"));
            })
            .map_err(|_| unavailable())?;
            let confirmed = tauri::async_runtime::spawn_blocking(move || receiver.recv()).await.map_err(|_| unavailable())?.map_err(|_| unavailable())?;
            match confirmed {
                Some(true) => {}
                Some(false) => return Err(CloudWorkspaceClientError::local("cloud_agent_local_login_cancelled", false)),
                None => return Err(unavailable()),
            }
            // The dialog has no time limit: what was valid when it opened may not be now.
            if !crate::agent_local_login::still_worth_lending(login.expires_at_ms) {
                return Err(CloudWorkspaceClientError::local(crate::agent_local_login::LocalLoginError::Expired.code(), false));
            }
            // The expiry travels as a time (UTC), so whoever looks at the list sees it in their own zone.
            let identity = lent_identity(provider, login.account.as_deref(), login.expires_at_ms);
            (AgentLoginKind::LoginDocument, login.secret, Some(identity))
        }
    };
    let service = state.cloud_workspaces.clone();
    tauri::async_runtime::spawn_blocking(move || service.save_agent_login(authorization, provider, kind, secret, identity.as_deref()))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Mutation))?
}

/// What the native dialog for the sign-in's code says: what it finishes,
/// what is replaced, and who the login reaches (a default for a new login,
/// the stored scope for one that is replaced).
fn claude_code_prompt(organization: &str, replaces: Option<crate::cloud_workspaces::AgentLoginKind>, reach: &crate::cloud_workspaces::AgentLoginReach) -> String {
    format!(
        "{}Paste the code the Claude page showed after you approved. It finishes the sign-in for organization {organization}: the account service keeps the login and renews it. {}",
        replacement_notice("Claude Code", organization, replaces),
        reach.sentence()
    )
}

/// What a native dialog says first when storing a login replaces one that
/// is there: every way of connecting says it, in the dialog as on the page.
/// Empty when nothing is stored for the agent.
fn replacement_notice(agent: &str, organization: &str, replaces: Option<crate::cloud_workspaces::AgentLoginKind>) -> String {
    use crate::cloud_workspaces::AgentLoginKind;
    match replaces {
        Some(AgentLoginKind::ApiKey) => format!("THIS REPLACES the API key now stored for {agent} in {organization}.\n\n"),
        Some(AgentLoginKind::LoginDocument) => format!("THIS REPLACES the login now stored for {agent} in {organization}.\n\n"),
        None => String::new(),
    }
}

/// A name from the account service for a native dialog, cleaned like any
/// other text there; `fallback` when there is none.
fn dialog_name(name: Option<String>, fallback: &str) -> String {
    name.map(|name| dialog_text(&name)).filter(|name| !name.is_empty()).unwrap_or_else(|| fallback.to_owned())
}

/// Text for a native dialog: no control or direction-changing characters, bounded.
fn dialog_text(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control() && !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
        .take(120)
        .collect::<String>()
        .trim()
        .to_string()
}

/// What the stored login is called: whose sign-in it is, and when it stops
/// working as a UTC time the list can read back ("… · lent until
/// 2026-10-03T21:40:00Z").
fn lent_identity(provider: crate::cloud_workspaces::AgentLoginProvider, account: Option<&str>, expires_at_ms: i64) -> String {
    use chrono::TimeZone;
    let until = match chrono::Utc.timestamp_millis_opt(expires_at_ms) {
        chrono::LocalResult::Single(at) => at.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        _ => "an unknown time".into(),
    };
    let fallback = format!("{} on a Mac", agent_label(provider));
    format!("{} · lent until {until}", account.unwrap_or(&fallback))
}

/// When a lent sign-in stops working, in this computer's own time.
fn local_time(at_ms: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(at_ms) {
        chrono::LocalResult::Single(at) => at.format("%-d %b %Y, %H:%M").to_string(),
        _ => "an unknown time".into(),
    }
}

/// What the native confirmation says before a local sign-in is uploaded:
/// which organization gets it, whose it is, what exactly leaves this Mac,
/// who can use it, and when and how it ends.
fn local_login_confirmation(
    provider: crate::cloud_workspaces::AgentLoginProvider,
    organization: &str,
    account: &str,
    expires: &str,
    replaces: Option<crate::cloud_workspaces::AgentLoginKind>,
    reach: &crate::cloud_workspaces::AgentLoginReach,
) -> String {
    use crate::cloud_workspaces::AgentLoginKind;
    let reach = reach.sentence();
    let agent = agent_label(provider);
    let subscription = subscription_label(provider);
    let what = match provider {
        // Codex reads the account and plan from the ID token; it signs nothing in.
        crate::cloud_workspaces::AgentLoginProvider::Codex => "this sign-in's short-lived access token, with its ID token (which names the account and plan),",
        _ => "this sign-in's short-lived access token",
    };
    let replacing = match replaces {
        Some(AgentLoginKind::ApiKey) => format!(
            "THIS REPLACES the API key now stored for {agent} in {organization}. The key is removed; when the lent sign-in expires, {agent} agents in every workspace of the organization stop until a login is connected again.\n\n"
        ),
        Some(AgentLoginKind::LoginDocument) => format!(
            "THIS REPLACES the login now stored for {agent} in {organization}. When the lent sign-in expires, {agent} agents in every workspace of the organization stop until a login is connected again.\n\n"
        ),
        None => String::new(),
    };
    format!(
        "Organization: {organization}\nAccount (as {agent} on this Mac records it): {account}\n\n{replacing}\
         TerminalX will upload {what} to the account service, for agents in the cloud workspaces of {organization}. \
         The refresh token stays on this Mac, so this Mac's sign-in keeps working and the uploaded token cannot be renewed: it stops working on {expires}.\n\n\
         Until then agents run on your {subscription} subscription. {reach} \
         Anyone who can drive one of those workspaces can read the token off its machine.\n\n\
         To end it sooner, disconnect it in Settings: that reaches every workspace of the organization, running ones included."
    )
}

/// A yes-or-no question asked by the app itself, outside the webview.
/// `None` when it cannot be asked here.
#[cfg(target_os = "macos")]
fn native_confirm(title: &str, text: &str, confirm: &str) -> Option<bool> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertSecondButtonReturn, NSAlertStyle};
    use objc2_foundation::NSString;
    let mtm = MainThreadMarker::new()?;
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(text));
    // Cancel first: Return and the default button never upload anything.
    alert.addButtonWithTitle(&NSString::from_str("Cancel"));
    alert.addButtonWithTitle(&NSString::from_str(confirm));
    // Only the confirm button is a yes. Cancel, and any way a modal can end
    // without a button (abort, stop), is a no.
    Some(alert.runModal() == NSAlertSecondButtonReturn)
}

#[cfg(not(target_os = "macos"))]
fn native_confirm(_title: &str, _text: &str, _confirm: &str) -> Option<bool> {
    None
}

// "Log in with Claude": the account service's own sign-in (PRO-82).

/// What the page needs after a sign-in has begun. The page address is kept
/// so "open the page again" can ask for the same one; it is not a secret.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginStarted {
    attempt_id: String,
    authorize_url: String,
    expires_in_seconds: u64,
    /// The browser was asked to open the page.
    opened: bool,
}

/// Begin a sign-in and open the provider's page in the browser. Consent,
/// the organization it names, the owner-or-admin check there and the explicit
/// choice to replace a stored login all come first, as for any other way to connect.
#[tauri::command]
pub async fn cloud_agent_claude_login_start(
    app: AppHandle,
    consent: crate::cloud_workspaces::AgentLoginConsent,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ClaudeLoginStarted, crate::cloud_workspaces::CloudWorkspaceClientError> {
    use crate::cloud_workspaces::{AgentLoginProvider, CloudWorkspaceClientError, RequestRisk};
    use tauri_plugin_opener::OpenerExt;
    let service = state.cloud_workspaces.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        let authorization = service.authorize_agent_login(AgentLoginProvider::Claude, &consent)?;
        service.start_claude_login(&authorization)
    })
    .await
    .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Mutation))??;
    let opened = app.opener().open_url(&started.authorize_url, None::<&str>).is_ok();
    Ok(ClaudeLoginStarted { attempt_id: started.attempt_id, authorize_url: started.authorize_url, expires_in_seconds: started.expires_in_seconds, opened })
}

/// Open a sign-in page again. Only a page of the provider is opened,
/// whatever the webview hands in.
#[tauri::command]
pub fn cloud_agent_claude_login_open(app: AppHandle, url: String) -> Result<(), crate::cloud_workspaces::CloudWorkspaceClientError> {
    use tauri_plugin_opener::OpenerExt;
    let refused = || crate::cloud_workspaces::CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false);
    if !crate::cloud_workspaces::claude_login_page(&url) {
        return Err(refused());
    }
    app.opener().open_url(&url, None::<&str>).map_err(|_| refused())
}

/// Finish a sign-in: the code the provider's page showed is typed or pasted
/// into a native secure dialog, never into the webview, and sent once.
#[tauri::command]
pub async fn cloud_agent_claude_login_complete(
    app: AppHandle,
    attempt_id: String,
    consent: crate::cloud_workspaces::AgentLoginConsent,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::ClaudeLoginOutcome, crate::cloud_workspaces::CloudWorkspaceClientError> {
    use crate::cloud_workspaces::{AgentLoginKind, AgentLoginProvider, CloudWorkspaceClientError, RequestRisk};
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = GUARD.try_lock().map_err(|_| CloudWorkspaceClientError::local("cloud_provider_operation_in_progress", true))?;
    let service = state.cloud_workspaces.clone();
    let authorization = tauri::async_runtime::spawn_blocking(move || service.authorize_agent_login(AgentLoginProvider::Claude, &consent))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))??;
    let organization = dialog_name(state.account.organization_name(authorization.organization_id()), authorization.organization_id());
    let unavailable = || CloudWorkspaceClientError::local("cloud_provider_secure_input_unavailable", false);
    let text = claude_code_prompt(&organization, authorization.replaces(), &authorization.reach(AgentLoginKind::LoginDocument));
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(secure_prompt("Log in with Claude", &text, "Code from the Claude page"));
    })
    .map_err(|_| unavailable())?;
    let entered = tauri::async_runtime::spawn_blocking(move || receiver.recv()).await.map_err(|_| unavailable())?.map_err(|_| unavailable())?;
    let code = entered.map_err(ProviderPromptError::client_error)?;
    let service = state.cloud_workspaces.clone();
    tauri::async_runtime::spawn_blocking(move || service.complete_claude_login(authorization, &attempt_id, code))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Mutation))?
}

#[tauri::command]
pub async fn cloud_agent_claude_login_cancel(
    attempt_id: String,
    context_revision: String,
    org_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.cancel_claude_login(&attempt_id, context_revision, org_id.as_deref()))
}

// "Log in with ChatGPT" for Codex (PRO-79): Codex's own device-code login,
// run here in a throwaway home (`codex_device_login`). The code is shown in
// the page's dialog and nowhere else; the login the CLI writes is uploaded
// like any other and never reaches the webview.

/// The one sign-in that may be open: whose organization it is for, and
/// where its page is. Replaced (and so canceled) by a new start.
struct CodexSignIn {
    attempt_id: String,
    organization_id: String,
    verification_url: String,
    login: crate::codex_device_login::DeviceLogin,
}

static CODEX_SIGN_IN: std::sync::Mutex<Option<CodexSignIn>> = std::sync::Mutex::new(None);

/// What the dialog shows once the CLI has printed its code.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginStarted {
    attempt_id: String,
    user_code: String,
    verification_url: String,
    expires_in_seconds: u64,
}

/// Where a sign-in is: `waiting`, `complete` (with the stored login's public
/// fields), `expired`, `cancelled`, `failed`, or `unconfirmed` (it was sent
/// once and the service did not confirm storing it; it is not sent again).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginStatus {
    pub(crate) status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credential: Option<crate::cloud_workspaces::AgentLogin>,
    /// `unconfirmed`: why the service did not confirm storing it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_code: Option<String>,
}

/// The `codex` to run, and anything a debug build adds for a local
/// stand-in issuer (`TERMINALX_DEV_CODEX_ISSUER`) or CLI (`TERMINALX_DEV_CODEX_BIN`).
fn codex_login_program() -> Option<(std::path::PathBuf, Vec<String>)> {
    let dev = |name: &str| if cfg!(debug_assertions) { std::env::var(name).ok().filter(|value| !value.is_empty()) } else { None };
    let program = dev("TERMINALX_DEV_CODEX_BIN").map(std::path::PathBuf::from).or_else(|| crate::binpath::resolve("codex"))?;
    let args = dev("TERMINALX_DEV_CODEX_ISSUER").map(|issuer| vec!["--experimental_issuer".to_string(), issuer]).unwrap_or_default();
    Some((program, args))
}

fn codex_sign_in_gone() -> crate::cloud_workspaces::CloudWorkspaceClientError {
    crate::cloud_workspaces::CloudWorkspaceClientError::local("cloud_agent_login_attempt_gone", false)
}

/// Begin "Log in with ChatGPT". Consent, the organization it names, the
/// owner-or-admin check there and the explicit choice to replace a stored
/// login come first, as for any other way to connect; only then does the CLI run.
#[tauri::command]
pub async fn cloud_agent_codex_login_start(
    consent: crate::cloud_workspaces::AgentLoginConsent,
    state: tauri::State<'_, crate::AppState>,
) -> Result<CodexLoginStarted, crate::cloud_workspaces::CloudWorkspaceClientError> {
    use crate::cloud_workspaces::{AgentLoginProvider, CloudWorkspaceClientError, RequestRisk};
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = GUARD.try_lock().map_err(|_| CloudWorkspaceClientError::local("cloud_provider_operation_in_progress", true))?;
    let service = state.cloud_workspaces.clone();
    let authorization = tauri::async_runtime::spawn_blocking(move || service.authorize_agent_login(AgentLoginProvider::Codex, &consent))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))??;
    // Starting again abandons the sign-in that was open, and its code.
    drop(CODEX_SIGN_IN.lock().map_err(|_| codex_sign_in_gone())?.take());
    let (program, args) = codex_login_program().ok_or_else(|| CloudWorkspaceClientError::local(crate::codex_device_login::DeviceLoginError::CliMissing.code(), false))?;
    if !crate::codex_device_login::trusted_program(&program) {
        return Err(CloudWorkspaceClientError::local(crate::codex_device_login::DeviceLoginError::CliUntrusted.code(), false));
    }
    // Only directories no other account can write: `codex` from npm runs whichever `node` PATH finds first.
    let path = crate::codex_device_login::trusted_path(&crate::binpath::login_path());
    if !crate::codex_device_login::runs_trusted(&program, &path) {
        return Err(CloudWorkspaceClientError::local(crate::codex_device_login::DeviceLoginError::CliUntrusted.code(), false));
    }
    let (login, code) = tauri::async_runtime::spawn_blocking(move || crate::codex_device_login::start(&program, &args, &path, &crate::codex_device_login::homes_parent()))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Mutation))?
        .map_err(|error| CloudWorkspaceClientError::local(error.code(), false))?;
    let attempt_id = format!("codex-login-{}", uuid::Uuid::new_v4());
    let started = CodexLoginStarted {
        attempt_id: attempt_id.clone(),
        user_code: code.user_code.to_string(),
        verification_url: code.verification_url.clone(),
        expires_in_seconds: crate::codex_device_login::CODE_LIFETIME.as_secs(),
    };
    *CODEX_SIGN_IN.lock().map_err(|_| codex_sign_in_gone())? =
        Some(CodexSignIn { attempt_id, organization_id: authorization.organization_id().to_owned(), verification_url: code.verification_url, login });
    Ok(started)
}

/// Open the sign-in's page: the one the CLI printed, whatever the webview says.
#[tauri::command]
pub fn cloud_agent_codex_login_open(app: AppHandle, attempt_id: String) -> Result<(), crate::cloud_workspaces::CloudWorkspaceClientError> {
    use tauri_plugin_opener::OpenerExt;
    let url = codex_sign_in_page(&attempt_id)?;
    app.opener().open_url(&url, None::<&str>).map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false))
}

/// The page of the open sign-in `attempt_id`, checked against OpenAI's own
/// pages again here, whatever was stored.
pub(crate) fn codex_sign_in_page(attempt_id: &str) -> Result<String, crate::cloud_workspaces::CloudWorkspaceClientError> {
    let url = {
        let open = CODEX_SIGN_IN.lock().map_err(|_| codex_sign_in_gone())?;
        let open = open.as_ref().filter(|open| open.attempt_id == attempt_id).ok_or_else(codex_sign_in_gone)?;
        open.verification_url.clone()
    };
    if !crate::codex_device_login::verification_page(&url) {
        return Err(crate::cloud_workspaces::CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
    }
    Ok(url)
}

/// The app is quitting: the open sign-in's CLI is killed and its home
/// wiped before this returns.
pub(crate) fn shutdown_codex_sign_in() {
    let held = match CODEX_SIGN_IN.lock() {
        Ok(mut open) => open.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(held) = held {
        held.login.shutdown();
    }
}

/// How the sign-in is going. Once the CLI has finished, this stores its
/// login for the organization: consent, the organization and the choice to
/// replace are checked again first, and a login stored by someone else in
/// the meantime needs that choice (`cloud_agent_login_replace_unconfirmed`;
/// the sign-in stays, so it can be stored once chosen).
#[tauri::command]
pub async fn cloud_agent_codex_login_status(
    attempt_id: String,
    consent: crate::cloud_workspaces::AgentLoginConsent,
    state: tauri::State<'_, crate::AppState>,
) -> Result<CodexLoginStatus, crate::cloud_workspaces::CloudWorkspaceClientError> {
    use crate::cloud_workspaces::{CloudWorkspaceClientError, RequestRisk};
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = GUARD.try_lock().map_err(|_| CloudWorkspaceClientError::local("cloud_provider_operation_in_progress", true))?;
    let service = state.cloud_workspaces.clone();
    tauri::async_runtime::spawn_blocking(move || codex_sign_in_status(&service, &attempt_id, &consent))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Mutation))?
}

/// Where the open sign-in `attempt_id` is, storing its login once Codex has
/// finished. Blocking: it may talk to the account service.
pub(crate) fn codex_sign_in_status(
    service: &crate::cloud_workspaces::CloudWorkspaceService,
    attempt_id: &str,
    consent: &crate::cloud_workspaces::AgentLoginConsent,
) -> Result<CodexLoginStatus, crate::cloud_workspaces::CloudWorkspaceClientError> {
    use crate::cloud_workspaces::{AgentLoginKind, AgentLoginProvider, CloudWorkspaceClientError};
    use crate::codex_device_login::Phase;
    let (phase, organization_id) = {
        let mut open = CODEX_SIGN_IN.lock().map_err(|_| codex_sign_in_gone())?;
        let current = open.as_ref().filter(|open| open.attempt_id == attempt_id).ok_or_else(codex_sign_in_gone)?;
        let phase = current.login.phase();
        let organization_id = current.organization_id.clone();
        if !matches!(phase, Phase::Waiting | Phase::SignedIn) {
            // Over: nothing is held, and the next start begins afresh.
            open.take();
        }
        (phase, organization_id)
    };
    match phase {
        Phase::Waiting => return Ok(CodexLoginStatus { status: "waiting", credential: None, error_code: None }),
        Phase::SignedIn => {}
        over => return Ok(CodexLoginStatus { status: over.as_str(), credential: None, error_code: None }),
    }
    let authorization = service.authorize_agent_login(AgentLoginProvider::Codex, consent)?;
    if authorization.organization_id() != organization_id {
        // Signed in for one organization, now looking at another: it is stored for neither.
        drop(CODEX_SIGN_IN.lock().map_err(|_| codex_sign_in_gone())?.take());
        return Err(CloudWorkspaceClientError::local("account_context_changed", false));
    }
    // Sent at most once. Until here (a replace not yet chosen, another organization) the
    // sign-in is kept so it can still be stored. From here it is let go whatever the answer:
    // a PUT whose answer was lost may have been stored, and the service may since have renewed
    // the login, so sending this copy again could put back a refresh token already spent.
    let held = {
        let mut open = CODEX_SIGN_IN.lock().map_err(|_| codex_sign_in_gone())?;
        if !open.as_ref().is_some_and(|open| open.attempt_id == attempt_id) {
            return Err(codex_sign_in_gone());
        }
        open.take().ok_or_else(codex_sign_in_gone)?
    };
    let sign_in = held.login.sign_in().ok_or_else(codex_sign_in_gone)?;
    drop(held);
    match service.save_agent_login(authorization, AgentLoginProvider::Codex, AgentLoginKind::LoginDocument, sign_in.secret, sign_in.account.as_deref()) {
        Ok(stored) => Ok(CodexLoginStatus { status: "complete", credential: Some(stored), error_code: None }),
        Err(error) => Ok(CodexLoginStatus { status: "unconfirmed", credential: None, error_code: Some(error.code) }),
    }
}

/// Hold `login` as the open sign-in, as a start would.
/// Tests that use the one open sign-in take this first.
#[cfg(test)]
pub(crate) static CODEX_SIGN_IN_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn hold_codex_sign_in_for_test(attempt_id: &str, organization_id: &str, login: crate::codex_device_login::DeviceLogin) {
    hold_codex_sign_in_at_for_test(attempt_id, organization_id, "https://auth.openai.com/codex/device", login);
}

#[cfg(test)]
pub(crate) fn hold_codex_sign_in_at_for_test(attempt_id: &str, organization_id: &str, url: &str, login: crate::codex_device_login::DeviceLogin) {
    *CODEX_SIGN_IN.lock().unwrap() = Some(CodexSignIn { attempt_id: attempt_id.into(), organization_id: organization_id.into(), verification_url: url.into(), login });
}

#[cfg(test)]
pub(crate) fn codex_sign_in_held_for_test() -> bool {
    CODEX_SIGN_IN.lock().unwrap().is_some()
}

/// Cancel the sign-in: the CLI is stopped and its home wiped. Nothing was stored.
#[tauri::command]
pub fn cloud_agent_codex_login_cancel(attempt_id: String) -> Result<(), crate::cloud_workspaces::CloudWorkspaceClientError> {
    let mut open = CODEX_SIGN_IN.lock().map_err(|_| codex_sign_in_gone())?;
    if open.as_ref().is_some_and(|open| open.attempt_id == attempt_id) {
        open.take();
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_agent_login_remove(
    provider: crate::cloud_workspaces::AgentLoginProvider,
    context_revision: String,
    org_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.remove_agent_login(provider, context_revision, org_id.as_deref()))
}

// ------------------------------------------- personal model routes (PRO-18)

/// The caller's own model routes in an organization, with the template
/// catalog the service offers.
#[tauri::command]
pub async fn cloud_agent_routes(
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<serde_json::Value, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.agent_routes(org_id.as_deref()))
}

/// Save one of the caller's routes. In order: the request is checked
/// against the account, organization and catalog the page knew; only then
/// is a credential asked for, in a native secure dialog, and checked from
/// this Mac; it is saved when the check passed, could not reach the
/// endpoint's model list, or the member chose to save anyway.
#[tauri::command]
pub async fn cloud_agent_route_save(
    app: AppHandle,
    save: crate::cloud_workspaces::AgentRouteSave,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::AgentRouteSaved, crate::cloud_workspaces::CloudWorkspaceClientError> {
    use crate::cloud_workspaces::{AgentRouteSaved, CloudWorkspaceClientError, RequestRisk};
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = GUARD.try_lock().map_err(|_| CloudWorkspaceClientError::local("cloud_provider_operation_in_progress", true))?;
    let save = std::sync::Arc::new(save);
    let service = state.cloud_workspaces.clone();
    let prepared = save.clone();
    let change = tauri::async_runtime::spawn_blocking(move || service.prepare_route_change(&prepared))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))??;
    let change = std::sync::Arc::new(change);
    let mut check = None;
    let credential = if save.enter_credential {
        let organization = dialog_name(state.account.organization_name(&change.organization_id), &change.organization_id);
        let agent = save.agent.label();
        let host = change.host().map(|host| dialog_text(&host)).unwrap_or_else(|| "your endpoint".into());
        let title = format!("{agent} endpoint credential");
        let text = format!(
            "Enter the credential for {host} ({}). It is checked from this Mac, then sent to the account service, which encrypts it and hands it only to the cloud workspaces you create in organization {organization}, never to other members. It is not shown again.",
            dialog_text(&change.template.label)
        );
        let unavailable = || CloudWorkspaceClientError::local("cloud_provider_secure_input_unavailable", false);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let _ = sender.send(secure_prompt(&title, &text, "Credential"));
        })
        .map_err(|_| unavailable())?;
        let entered = tauri::async_runtime::spawn_blocking(move || receiver.recv()).await.map_err(|_| unavailable())?.map_err(|_| unavailable())?;
        let credential = entered.map_err(ProviderPromptError::client_error)?;
        let checking = change.clone();
        let (credential, checked) = tauri::async_runtime::spawn_blocking(move || {
            let checked = checking.check(&credential);
            (credential, checked)
        })
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))?;
        // Unverified is an endpoint without a model list: the workspace's own check decides.
        let blocks = checked.outcome == "failed" && !save.save_unchecked;
        check = Some(checked);
        if blocks {
            return Ok(AgentRouteSaved { saved: false, check, routes: None });
        }
        Some(credential)
    } else {
        None
    };
    let service = state.cloud_workspaces.clone();
    let routes = tauri::async_runtime::spawn_blocking(move || service.save_route(&change, &save, credential))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Mutation))??;
    Ok(AgentRouteSaved { saved: true, check, routes: Some(routes) })
}

/// Switch an agent back to the organization's login.
#[tauri::command]
pub async fn cloud_agent_route_remove(
    agent: crate::cloud_workspaces::AgentRouteAgent,
    context_revision: String,
    org_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<serde_json::Value, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.remove_agent_route(org_id.as_deref(), &context_revision, agent))
}

#[tauri::command]
pub async fn cloud_provider_disconnect(
    provider: crate::cloud_workspaces::CloudWorkspaceProviderId,
    context_revision: String,
    disposition: crate::cloud_workspaces::DisconnectDisposition,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudProviderConnectionResponse, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.disconnect_provider(provider, context_revision, disposition))
}

/// The organization's cloud teardown, or null when none was asked for.
#[tauri::command]
pub async fn cloud_teardown_status(
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<Option<crate::cloud_workspaces::CloudTeardown>, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.teardown_status(org_id.as_deref()))
}

/// How many workspaces a teardown of `organization_id` would take.
#[tauri::command]
pub async fn cloud_teardown_preview(
    organization_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudTeardownPreview, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.teardown_preview(&organization_id))
}

/// Archive or destroy every cloud workspace of `organization_id`. Only after
/// the person confirmed it: it cannot be undone. Refused, with nothing sent,
/// if that is no longer the active organization, the account context is not
/// the one the confirmation was given at, or the organization's workspaces
/// are no longer the ones `confirmed` counted.
#[tauri::command]
pub async fn cloud_teardown_request(
    organization_id: String,
    context_revision: String,
    disposition: crate::cloud_workspaces::TeardownDisposition,
    confirmed: crate::cloud_workspaces::ConfirmedTeardown,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudTeardown, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service
        .request_teardown(&organization_id, &context_revision, disposition, &confirmed))
}

#[tauri::command]
pub async fn cloud_provider_set_creation_enabled(
    provider: crate::cloud_workspaces::CloudWorkspaceProviderId,
    context_revision: String,
    enabled: bool,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudProviderSummary, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.set_provider_creation_enabled(provider, context_revision, enabled))
}

#[tauri::command]
pub async fn cloud_provider_revalidate(
    provider: crate::cloud_workspaces::CloudWorkspaceProviderId,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudProviderConnectionResponse, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.revalidate_provider(provider, context_revision))
}

#[tauri::command]
pub async fn cloud_workspace_setup(
    provider: crate::cloud_workspaces::CloudWorkspaceProviderId,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSetup, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.setup(org_id.as_deref(), provider))
}

#[tauri::command]
pub async fn cloud_workspace_quote(
    input: crate::cloud_workspaces::CloudWorkspaceQuoteInput,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceQuote, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.quote(org_id.as_deref(), input))
}

#[tauri::command]
pub async fn cloud_workspace_create(
    input: crate::cloud_workspaces::CloudWorkspaceCreateInput,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Create, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.create(org_id.as_deref(), input))
}

#[tauri::command]
pub async fn cloud_workspace_preflight(
    repositories: Vec<crate::cloud_workspaces::CreateRepository>,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
    agent: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspacePreflight, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.preflight(org_id.as_deref(), repositories, agent))
}

#[tauri::command]
pub async fn cloud_workspace_repositories(
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::SelectedRepositories, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.selected_repositories(org_id.as_deref()))
}

#[tauri::command]
pub async fn cloud_workspaces(
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceList, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.workspaces(org_id.as_deref()))
}

#[tauri::command]
pub async fn cloud_catalog_feed(
    state: tauri::State<'_, crate::AppState>,
    cursor: Option<String>,
) -> Result<crate::cloud_workspaces::CloudCatalogFeed, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.catalog_feed(cursor.as_deref()))
}

async fn cloud_workspace_lifecycle(
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
    workspace_id: String,
    action: crate::cloud_workspaces::OperationAction,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.lifecycle(org_id.as_deref(), &workspace_id, action))
}

#[tauri::command]
pub async fn cloud_workspace_suspend(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_workspace_lifecycle(state, org_id, workspace_id, crate::cloud_workspaces::OperationAction::Suspend).await
}

#[tauri::command]
pub async fn cloud_workspace_resume(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_workspace_lifecycle(state, org_id, workspace_id, crate::cloud_workspaces::OperationAction::Resume).await
}

#[tauri::command]
pub async fn cloud_workspace_release(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_workspace_lifecycle(state, org_id, workspace_id, crate::cloud_workspaces::OperationAction::Delete).await
}

/// Archive (30-day trash) or permanently delete; `force` only after the
/// person confirmed stopping running agent work.
#[tauri::command]
pub async fn cloud_workspace_archive(
    workspace_id: String,
    force: bool,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
    retention_days: Option<u32>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service
        .archive(org_id.as_deref(), &workspace_id, force, retention_days))
}

#[tauri::command]
pub async fn cloud_workspace_delete(
    workspace_id: String,
    force: bool,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service
        .lifecycle_with(org_id.as_deref(), &workspace_id, crate::cloud_workspaces::OperationAction::Delete, force))
}

#[tauri::command]
pub async fn cloud_workspace_unarchive(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.unarchive(org_id.as_deref(), &workspace_id))
}

#[tauri::command]
pub async fn cloud_workspace_disposition(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceDisposition, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.disposition(org_id.as_deref(), &workspace_id))
}

/// Who a cloud workspace is shared with, and the caller's own standing (PRO-30).
#[tauri::command]
pub async fn cloud_workspace_shares(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceShares, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.shares(org_id.as_deref(), &workspace_id))
}

#[tauri::command]
pub async fn cloud_workspace_share_put(
    workspace_id: String,
    user_id: String,
    role: crate::cloud_workspaces::ShareRole,
    can_approve: bool,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceShareChange, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service
        .share_put(org_id.as_deref(), &workspace_id, &user_id, role, can_approve))
}

#[tauri::command]
pub async fn cloud_workspace_share_revoke(
    workspace_id: String,
    user_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceShareChange, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service
        .share_revoke(org_id.as_deref(), &workspace_id, &user_id))
}

/// The organization's scheduled cloud tasks, or one workspace's (PRO-37).
#[tauri::command]
pub async fn cloud_schedules(
    workspace_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudSchedules, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.schedules(org_id.as_deref(), workspace_id.as_deref()))
}

#[tauri::command]
pub async fn cloud_schedule(
    schedule_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudScheduleDetail, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.schedule(org_id.as_deref(), &schedule_id))
}

/// What a schedule would cost, before it is saved. Writes nothing.
#[tauri::command]
pub async fn cloud_schedule_estimate(
    input: crate::cloud_workspaces::CloudScheduleEstimateInput,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudScheduleQuote, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.schedule_estimate(org_id.as_deref(), &input))
}

#[tauri::command]
pub async fn cloud_schedule_create(
    input: crate::cloud_workspaces::CloudScheduleCreateInput,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudSchedule, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.schedule_create(org_id.as_deref(), &input))
}

/// Pause a scheduled task (`active: false`) or resume a paused one.
#[tauri::command]
pub async fn cloud_schedule_set_active(
    schedule_id: String,
    active: bool,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudSchedule, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.schedule_set_active(org_id.as_deref(), &schedule_id, active))
}

#[tauri::command]
pub async fn cloud_schedule_delete(
    schedule_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<(), crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.schedule_delete(org_id.as_deref(), &schedule_id))
}

/// Pause every active scheduled task of the organization.
#[tauri::command]
pub async fn cloud_schedules_pause_all(
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudSchedulesPaused, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.schedules_pause_all(org_id.as_deref()))
}

/// Switch who may see a cloud workspace: `organization` so it can be shared,
/// `private` to hide it again (the server revokes every share with it).
#[tauri::command]
pub async fn cloud_workspace_set_access(
    workspace_id: String,
    access_mode: crate::cloud_workspaces::WorkspaceAccessMode,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspace, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service
        .set_access(org_id.as_deref(), &workspace_id, access_mode))
}

#[tauri::command]
pub async fn cloud_workspace_operation(
    operation_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.operation(org_id.as_deref(), &operation_id))
}

#[tauri::command]
pub async fn cloud_workspace_operation_cancel(
    operation_id: String,
    state: tauri::State<'_, crate::AppState>,
    org_id: Option<String>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.cancel_operation(org_id.as_deref(), &operation_id))
}

/// Off the main thread: an expired pairing removes its device token from the Keychain.
#[tauri::command]
pub async fn pairing_status(state: tauri::State<'_, crate::AppState>) -> CmdResult<crate::pairing::PairingStatus> {
    let pairing = state.pairing.clone();
    tauri::async_runtime::spawn_blocking(move || pairing.status()).await.map_err(err)
}

#[tauri::command]
pub async fn pairing_generate(
    connection_mode: Option<crate::pairing::PairingConnectionMode>,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::pairing::PairingStatus> {
    state
        .pairing
        .clone()
        .generate_pairing(connection_mode.unwrap_or_default())
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn pairing_revoke(
    device_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::pairing::PairingStatus> {
    state.pairing.revoke_device(&device_id).await.map_err(err)
}

#[tauri::command]
pub async fn pairing_set_host_name(
    display_name: String,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::pairing::PairingStatus> {
    state.pairing.set_host_name(&display_name).await.map_err(err)
}

// ------------------------------------------------------------------ projects

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsResponse {
    pub projects: Vec<Project>,
    pub last_selected: Option<String>,
}

#[tauri::command]
pub fn list_projects() -> CmdResult<ProjectsResponse> {
    let (projects, last_selected) = projects::list().map_err(err)?;
    Ok(ProjectsResponse { projects, last_selected })
}

/// The project list changed: a window that did not make the change reads it again.
pub(crate) const PROJECTS_CHANGED_EVENT: &str = "projects_changed";

#[tauri::command]
pub fn add_project(app: AppHandle, path: String) -> CmdResult<Project> {
    let project = projects::add(&path).map_err(err)?;
    let _ = app.emit(PROJECTS_CHANGED_EVENT, &());
    Ok(project)
}

/// The folder the sidebar's New chat runs in: a plain directory in the store,
/// so a chat needs no project of the user's and no worktree.
#[tauri::command]
pub fn chats_dir() -> CmdResult<String> {
    let dir = store::ensure_dir(store::root().map_err(err)?.join("Chats")).map_err(err)?;
    // Its agents are told to start a branch as a worktree, not in the reader's checkout.
    if let Err(error) = crate::chat_link::ensure_instructions(&dir) {
        log::warn!("write the chats' agent note: {error:#}");
    }
    // Canonical, as a session's project path is, so the sidebar can match them.
    Ok(std::fs::canonicalize(&dir).unwrap_or(dir).to_string_lossy().into_owned())
}

#[tauri::command]
pub fn remove_project(app: AppHandle, path: String) -> CmdResult<()> {
    projects::remove(&path).map_err(err)?;
    let _ = app.emit(PROJECTS_CHANGED_EVENT, &());
    Ok(())
}

#[tauri::command]
pub fn select_project(path: String) -> CmdResult<()> {
    projects::set_last_selected(&path).map_err(err)
}

/// The event a running local clone reports its progress on.
pub const PROJECT_CLONE_PROGRESS_EVENT: &str = "project_clone_progress";

type StartResult<T> = Result<T, crate::project_start::Failure>;

fn start_failure(error: impl std::fmt::Display) -> crate::project_start::Failure {
    crate::project_start::Failure { code: crate::project_start::FAILED, message: error.to_string() }
}

/// The reader's GitHub repositories through `gh`, or why there is no list.
#[tauri::command]
pub async fn github_repositories() -> CmdResult<crate::project_start::GithubRepositories> {
    tauri::async_runtime::spawn_blocking(crate::project_start::github_repositories).await.map_err(err)
}

/// Clone a repository under `parent`. Resolves when the clone is whole (or
/// was already there); `id` names it for progress events and for canceling.
#[tauri::command]
pub async fn project_clone(app: AppHandle, id: String, source: String, parent: String) -> StartResult<crate::project_start::CloneOutcome> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::project_start::clone_repository(&id, &source, &parent, move |progress| {
            let _ = app.emit(PROJECT_CLONE_PROGRESS_EVENT, &progress);
        })
    })
    .await
    .map_err(start_failure)?
}

#[tauri::command]
pub fn project_clone_cancel(id: String) {
    crate::project_start::cancel_clone(&id);
}

#[tauri::command]
pub fn project_start_defaults(parent: Option<String>) -> crate::project_start::StartDefaults {
    crate::project_start::defaults(parent.as_deref())
}

/// Quick start: a new empty Git repository at `parent/name`, returned as a path to add.
#[tauri::command]
pub async fn project_create(parent: String, name: String) -> StartResult<String> {
    tauri::async_runtime::spawn_blocking(move || crate::project_start::create_project(&parent, &name)).await.map_err(start_failure)?
}

// ------------------------------------------------------------------ sessions

#[tauri::command]
pub fn list_sessions(app: tauri::AppHandle) -> CmdResult<Vec<SessionEntry>> {
    store::message_activity::backfill(std::sync::Arc::new(app));
    store::conversation_titles::backfill().map_err(err)
}

// ---------------------------------------------------------------- automations

#[tauri::command]
pub fn automations_list(state: State<'_, AppState>) -> CmdResult<Vec<crate::automations::Automation>> {
    state.sessions().map_err(err)?.automations().map_err(err)
}

#[tauri::command]
pub fn automation_runs(state: State<'_, AppState>, automation_id: String) -> CmdResult<Vec<crate::automations::AutomationRun>> {
    state.sessions().map_err(err)?.automation_runs(&automation_id).map_err(err)
}

#[tauri::command]
pub fn automation_issue_states(state: State<'_, AppState>) -> CmdResult<Vec<crate::automations::AutomationIssueState>> {
    state.sessions().map_err(err)?.automation_issues().map_err(err)
}

#[tauri::command]
pub async fn automation_issue_preview(project_path: String, repo: String, query: String) -> CmdResult<Vec<crate::issues::Issue>> {
    tauri::async_runtime::spawn_blocking(move || crate::issues::github_search(Path::new(&project_path), &repo, &query, 50).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn automation_create(state: State<'_, AppState>, input: crate::automations::AutomationInput) -> CmdResult<crate::automations::Automation> {
    state.sessions().map_err(err)?.save_automation(None, input).map_err(err)
}

#[tauri::command]
pub fn automation_update(state: State<'_, AppState>, id: String, input: crate::automations::AutomationInput) -> CmdResult<crate::automations::Automation> {
    state.sessions().map_err(err)?.save_automation(Some(&id), input).map_err(err)
}

#[tauri::command]
pub fn automation_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.sessions().map_err(err)?.delete_automation(&id).map_err(err)
}

#[tauri::command]
pub async fn automation_run_now(state: State<'_, AppState>, id: String) -> CmdResult<crate::automations::AutomationRun> {
    let sessions = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.run_automation(&id).map_err(err))
        .await
        .map_err(err)?
}

/// The snippets the agent dashboard draws on its cards. Reading tails off the
/// disk is blocking work, and the dashboard asks for every session at once, so
/// it runs off the UI thread.
#[tauri::command]
pub async fn session_summaries(session_ids: Option<Vec<String>>) -> CmdResult<Vec<crate::summaries::SessionSummary>> {
    tauri::async_runtime::spawn_blocking(move || crate::summaries::collect(session_ids).map_err(err))
        .await
        .map_err(err)?
}

/// Cached display/status reads never walk transcripts or wait for the scan.
#[tauri::command]
pub async fn app_activity_summary(state: State<'_, AppState>) -> CmdResult<crate::store::activity::Summary> {
    let sessions = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.activity_summary().map_err(err))
        .await.map_err(err)?
}

#[tauri::command]
pub async fn stats_usage_snapshot(state: State<'_, AppState>) -> CmdResult<crate::stats::StatsUsageState> {
    let stats = state.stats_usage.clone();
    tauri::async_runtime::spawn_blocking(move || stats.read().map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn stats_usage_refresh(state: State<'_, AppState>, scope: String, generation: u64) -> CmdResult<crate::stats::StatsUsageState> {
    let stats = state.stats_usage.clone();
    tauri::async_runtime::spawn_blocking(move || stats.refresh(&scope, generation).map_err(err))
        .await
        .map_err(err)?
}

/// Create a session: an index entry around an existing checkout, or a new
/// worktree and its first tab. The index entry lands before anything else can
/// fail after it, so a session whose agent never starts is still visible and
/// deletable.
#[tauri::command]
pub async fn create_session(app: AppHandle, req: NewSession) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || create_session_blocking(&app, req))
        .await
        .map_err(err)?
}

/// Tell every window what a session is now. The window that made a change
/// updates its own copy from the reply; another window showing the same
/// session (the floating one beside the main one) only learns of it here.
fn announce_session(app: &AppHandle, session_id: &str) {
    if let Ok(session) = index::get(session_id) {
        let _ = app.emit("session_updated", &session);
    }
}

#[tauri::command]
pub fn add_tab(app: AppHandle, state: State<'_, AppState>, session_id: String, tab: NewTab) -> CmdResult<TabEntry> {
    let tab = state.sessions().map_err(err)?.add_tab(&session_id, &tab).map_err(err)?;
    announce_session(&app, &session_id);
    Ok(tab)
}

/// Tell every window how the workspaces' tabs are arranged now, and which closed tabs can be reopened.
fn announce_tabs(app: &AppHandle) {
    if let Ok(tabs) = index::tab_state() {
        let _ = app.emit("tab_state_changed", &tabs);
    }
}

/// Close an agent tab: its CLI is stopped and it leaves the session. A tab
/// that holds a conversation stays reopenable ([`reopen_tab`]), log and all.
#[tauri::command]
pub fn remove_tab(app: AppHandle, session_id: String, tab_id: String) -> CmdResult<()> {
    let state = app.state::<crate::AppState>();
    state.sessions().map_err(err)?.close_tab(&session_id, &tab_id).map_err(err)
}

/// Bring a closed tab back into its session, with its conversation.
#[tauri::command]
pub fn reopen_tab(app: AppHandle, session_id: String, tab_id: String) -> CmdResult<TabEntry> {
    let tab = crate::session_ops::reopen_tab_entry(&session_id, &tab_id)?;
    announce_session(&app, &session_id);
    announce_tabs(&app);
    Ok(tab)
}

/// Give an agent tab the reader's own title; `None` (or blank) takes it away,
/// and the tab goes by its first request again.
#[tauri::command]
pub fn rename_tab(app: AppHandle, session_id: String, tab_id: String, title: Option<String>) -> CmdResult<()> {
    crate::session_ops::rename_tab_entry(&session_id, &tab_id, title)?;
    announce_session(&app, &session_id);
    Ok(())
}

/// How every workspace's tabs are arranged, and the closed tabs that can be reopened.
#[tauri::command]
pub fn tab_state() -> CmdResult<index::TabState> {
    index::tab_state().map_err(err)
}

/// Save one workspace's tab order, pins, mutes and titles, for every window and every device.
#[tauri::command]
pub fn set_tab_layout(app: AppHandle, workspace: String, layout: index::TabLayout) -> CmdResult<()> {
    for session in index::set_tab_layout(&workspace, layout).map_err(err)? {
        let _ = app.emit("session_updated", &session);
    }
    announce_tabs(&app);
    Ok(())
}

fn patch_session(app: &AppHandle, session_id: &str, patch: crate::session_ops::SessionPatch) -> CmdResult<()> {
    let session = crate::session_ops::update_session_meta(session_id, &patch)?;
    let _ = app.emit("session_updated", &session);
    Ok(())
}

#[tauri::command]
pub fn rename_session(app: AppHandle, session_id: String, title: String) -> CmdResult<()> {
    patch_session(&app, &session_id, crate::session_ops::SessionPatch { title: Some(title), ..Default::default() })
}

/// Put text on the system clipboard. The webview's own clipboard refuses a
/// write it does not count as the reader's gesture (a choice in a context
/// menu, say); the system's has no such rule.
#[tauri::command]
pub fn copy_text(text: String) -> CmdResult<()> {
    use std::io::Write;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("pbcopy");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("clip");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::process::Command::new("wl-copy")
    } else {
        let mut xclip = std::process::Command::new("xclip");
        xclip.args(["-selection", "clipboard"]);
        xclip
    };
    let mut child = command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map_err(err)?;
    child.stdin.take().ok_or("The clipboard could not be written.")?.write_all(text.as_bytes()).map_err(err)?;
    let status = child.wait().map_err(err)?;
    if !status.success() {
        return Err("The clipboard could not be written.".into());
    }
    Ok(())
}

/// A project at a glance: branches, contributors, the newest commits and pull requests.
#[tauri::command]
pub async fn project_overview(project_path: String) -> CmdResult<crate::project_overview::ProjectOverview> {
    tauri::async_runtime::spawn_blocking(move || crate::project_overview::overview(Path::new(&project_path)))
        .await
        .map_err(err)
}

/// Take the agent's title for a conversation that still has a made-up one.
#[tauri::command]
pub fn adopt_agent_title(app: AppHandle, session_id: String) -> CmdResult<()> {
    if let Some(session) = crate::session_ops::adopt_agent_title(&session_id)? {
        let _ = app.emit("session_updated", &session);
    }
    Ok(())
}

#[tauri::command]
pub fn set_session_archived(app: AppHandle, session_id: String, archived: bool) -> CmdResult<()> {
    patch_session(&app, &session_id, crate::session_ops::SessionPatch { archived: Some(archived), ..Default::default() })
}

#[tauri::command]
pub fn set_session_pinned(app: AppHandle, session_id: String, pinned: bool) -> CmdResult<()> {
    patch_session(&app, &session_id, crate::session_ops::SessionPatch { pinned: Some(pinned), ..Default::default() })
}

#[tauri::command]
pub fn set_active_tab(app: AppHandle, session_id: String, tab_id: String) -> CmdResult<()> {
    let session = index::update_session(&session_id, |s| {
        if s.tab(&tab_id).is_some() {
            s.active_tab = Some(tab_id);
        }
        Ok(s.clone())
    })
    .map_err(err)?;
    let _ = app.emit("session_updated", &session);
    Ok(())
}

// ---------------------------------------------------------------- quick chats

/// Create a quick chat: a session with no project, in a scratch directory of
/// its own (or in `req.cwd`, which does not become a project).
#[tauri::command]
pub async fn create_quick_chat(app: AppHandle, req: crate::session_ops::NewQuickChat) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || crate::session_ops::create_quick_chat_blocking(&app, req))
        .await
        .map_err(err)?
}

/// Run a quick chat in another folder, or in its scratch directory again when
/// `cwd` is `None`. Its agents are stopped and start again there.
#[tauri::command]
pub async fn set_quick_chat_cwd(app: AppHandle, session_id: String, cwd: Option<String>) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("quickCwd", serde_json::json!({"sessionId":session_id,"cwd":cwd})).map_err(err)
    }).await.map_err(err)?
}

/// Turn a quick chat into an ordinary session of a project, with its history.
#[tauri::command]
pub async fn move_quick_chat_to_project(app: AppHandle, session_id: String, project_path: String) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("quickMove", serde_json::json!({"sessionId":session_id,"projectPath":project_path})).map_err(err)
    }).await.map_err(err)?
}

/// What a session's scratch directory holds, for the delete confirmation.
#[tauri::command]
pub async fn quick_chat_scratch(session_id: String) -> CmdResult<crate::session_ops::QuickChatScratch> {
    tauri::async_runtime::spawn_blocking(move || crate::session_ops::quick_chat_scratch(&session_id)).await.map_err(err)?
}

/// The sessions a workspace removal deleted or moved, and what became of
/// its branch.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRemoveReport {
    pub sessions: Vec<SessionEntry>,
    /// The workspace's branch, when it was kept because it holds commits
    /// nothing else has.
    pub kept_branch: Option<String>,
    /// A branch made to keep a detached HEAD's commits reachable.
    pub rescued_branch: Option<String>,
}

/// Delete one session, its logs and attachments. Its workspace stays, and so
/// does every other session: a workspace is removed with `remove_workspace`.
#[tauri::command]
pub async fn delete_session(app: AppHandle, session_id: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.delete_session(&session_id).map_err(err)
    })
    .await
    .map_err(err)?
}

/// The workspace this session could take along when it is deleted: its
/// worktree, when no other session runs there. `None` otherwise.
#[tauri::command]
pub async fn sole_workspace_of(session_id: String) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || crate::session_ops::sole_workspace_of(&session_id)).await.map_err(err)?
}

// ------------------------------------------------------------------ harnesses

#[tauri::command]
pub async fn list_harnesses() -> CmdResult<Vec<harness::HarnessInfo>> {
    crate::binpath::invalidate();
    tauri::async_runtime::spawn_blocking(harness::offered).await.map_err(err)
}

// ------------------------------------------------------------------ skills

#[tauri::command]
pub async fn list_skills(project_path: Option<String>, refresh: bool) -> CmdResult<Vec<crate::skills::DiscoveredSkill>> {
    tauri::async_runtime::spawn_blocking(move || crate::skills::discover(project_path.as_deref(), refresh).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn skill_detail(dir_path: String) -> CmdResult<crate::skills::SkillDetail> {
    tauri::async_runtime::spawn_blocking(move || crate::skills::detail(Path::new(&dir_path)).map_err(err))
        .await
        .map_err(err)?
}

// ------------------------------------------------------------------ git

#[tauri::command]
pub async fn work_status(cwd: String) -> CmdResult<git::WorkStatus> {
    tauri::async_runtime::spawn_blocking(move || git::work_status(Path::new(&cwd))).await.map_err(err)
}

#[tauri::command]
pub async fn list_branches(cwd: String) -> CmdResult<Vec<git::BranchInfo>> {
    tauri::async_runtime::spawn_blocking(move || git::list_branches(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn worktree_disposition(session_id: String) -> CmdResult<git::WorktreeDisposition> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = index::get(&session_id).map_err(err)?;
        Ok(match s.worktree_name.as_deref() {
            Some(name) if !s.worktree_removed => git::worktree_disposition(Path::new(&s.project_path), name),
            _ => git::WorktreeDisposition::default(),
        })
    })
    .await
    .map_err(err)?
}

/// The titles of the other sessions that deleting this one with its worktree
/// would delete too, for the confirmation to name.
#[tauri::command]
pub async fn sessions_sharing_worktree(session_id: String) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(crate::session_ops::sessions_sharing_worktree(&session_id)?.into_iter().map(|session| session.title).collect())
    })
    .await
    .map_err(err)?
}

/// Keep a session's worktree on disk but run the session in the project
/// itself from now on. (Settling by removing the worktree is
/// `remove_workspace` with the sessions kept.)
#[tauri::command]
pub async fn relocate_session(app: AppHandle, session_id: String) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("relocate", serde_json::json!({"sessionId":session_id})).map_err(err)
    }).await.map_err(err)?
}

/// Fork a tab into a new session: a fresh worktree at the source branch's
/// tip, the tab's log copied over so the history reads the same, and the
/// provider conversation forked on the first send.
#[tauri::command]
pub async fn fork_session(app: AppHandle, session_id: String, tab_id: String) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = index::get(&session_id).map_err(err)?;
        let tab = src.tab(&tab_id).cloned().ok_or("no such tab")?;
        let project_path = Path::new(&src.project_path);
        let id = uuid::Uuid::now_v7().to_string();
        let now = index::now();
        let mut new_tab = tab.clone();
        new_tab.id = uuid::Uuid::now_v7().to_string();
        new_tab.status = TabStatus::Idle;
        new_tab.created = now.clone();
        new_tab.modified = now.clone();
        // Claude can fork a conversation; Codex starts a new thread over the copied log.
        new_tab.fork_from = if tab.harness == "claude" { tab.provider_session_id.clone() } else { None };
        new_tab.provider_session_id = None;
        // A quick chat's fork is a quick chat with a scratch directory of its
        // own: sharing the parent's would have either one's deletion take the
        // other's files. What the parent had there is copied, since the
        // conversation refers to it.
        let scratch = if src.is_quick() { Some(store::quick::create(&id).map_err(err)?) } else { None };
        let in_scratch = src.is_quick() && store::quick::is_scratch(&src.id, &src.cwd);
        if let (Some(scratch), true) = (&scratch, in_scratch) {
            let _ = copy_dir(Path::new(&src.cwd), Path::new(scratch));
            // The fork's CLI reopens the parent conversation from the new
            // directory, and Claude Code looks for it under that directory's name.
            if let (Some(parent), Some(projects)) = (new_tab.fork_from.as_deref(), crate::agent_data::claude_projects_root()) {
                let _ = crate::harness::claude::transcript::rehome_in(&projects, &src.cwd, scratch, parent, true);
            }
        }
        let mut entry = SessionEntry {
            id: id.clone(),
            kind: src.kind,
            project_path: scratch.clone().unwrap_or_else(|| src.project_path.clone()),
            cwd: if in_scratch { scratch.clone().unwrap_or_else(|| src.cwd.clone()) } else { src.cwd.clone() },
            worktree_name: None,
            branch: src.branch.clone(),
            base_ref: None,
            worktree_base: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: src.issue.clone(),
            issue_work: src.issue_work.clone(),
            automation: src.automation.clone(),
            title: format!("{} (fork)", src.title),
            created: now.clone(),
            modified: now,
            archived: false,
            pinned: false,
            tabs: vec![new_tab.clone()],
            active_tab: Some(new_tab.id.clone()),
            link: None,
            unknown: BTreeMap::new(),
        };
        if src.worktree_name.is_some() && !src.worktree_removed {
            let taken = index::load().map(|s| index::claimed_worktree_names(&s)).unwrap_or_default();
            let taken = git::taken_worktree_names(project_path, &taken);
            let name = names::unclaimed(&taken);
            let wt = git::create_worktree(project_path, &name, src.branch.as_deref()).map_err(err)?;
            entry.cwd = wt.path;
            entry.worktree_name = Some(wt.name);
            entry.branch = Some(wt.branch);
            entry.base_ref = Some(wt.base_tree);
            entry.worktree_base = wt.worktree_base;
        }
        // Copy the log, re-stamping envelopes so the new tab owns them.
        if let Ok(dir) = store::sessions_dir() {
            let from = dir.join(&src.id).join(format!("{}.jsonl", tab.id));
            if let Ok(text) = std::fs::read_to_string(&from) {
                let to_dir = dir.join(&id);
                let _ = std::fs::create_dir_all(&to_dir);
                let mut out = String::with_capacity(text.len());
                for line in text.lines() {
                    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(line) {
                        v["sessionId"] = serde_json::Value::String(id.clone());
                        v["tabId"] = serde_json::Value::String(new_tab.id.clone());
                        out.push_str(&v.to_string());
                        out.push('\n');
                    }
                }
                let _ = std::fs::write(to_dir.join(format!("{}.jsonl", new_tab.id)), out);
            }
        }
        if let Ok(root) = store::root() {
            let from = root.join("attachments").join(&src.id);
            if from.is_dir() {
                let to = root.join("attachments").join(&id);
                let _ = copy_dir(&from, &to);
            }
        }
        index::update(|sessions| {
            sessions.push(entry.clone());
            Ok(())
        })
        .map_err(err)?;
        let _ = app.emit("session_created", &entry);
        Ok(entry)
    })
    .await
    .map_err(err)?
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let dest = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else {
            std::fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn snapshot_tree(cwd: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || git::snapshot_tree(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn head_tree(cwd: String) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&cwd);
        if !git::is_repo(p) {
            return Ok(None);
        }
        git::head_tree(p).map(Some).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn review_range(cwd: String, target: Option<String>, uncommitted: bool) -> CmdResult<git::ReviewRange> {
    tauri::async_runtime::spawn_blocking(move || git::review_range(Path::new(&cwd), target.as_deref(), uncommitted).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn changes_between(cwd: String, base: String, head: Option<String>) -> CmdResult<Vec<git::ChangedFile>> {
    tauri::async_runtime::spawn_blocking(move || git::changes_between(Path::new(&cwd), &base, head.as_deref()).map_err(err))
        .await
        .map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePair {
    pub before: Option<String>,
    pub after: Option<String>,
}

#[tauri::command]
pub async fn file_contents_at(cwd: String, path: String, base: String, head: Option<String>) -> CmdResult<FilePair> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&cwd);
        let before = git::blob_at(p, &base, &path).map_err(err)?;
        let after = match head {
            Some(h) => git::blob_at(p, &h, &path).map_err(err)?,
            None => git::working_file(p, &path),
        };
        Ok(FilePair { before, after })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn log_commits(cwd: String, range: Option<String>, limit: Option<u32>) -> CmdResult<Vec<git::CommitInfo>> {
    tauri::async_runtime::spawn_blocking(move || git::log_commits(Path::new(&cwd), range.as_deref(), limit.unwrap_or(100)).map_err(err))
        .await
        .map_err(err)?
}

// ------------------------------------------------------------------ agents (tabs)

use crate::session::{ImageInput, QueuedMessage, SendOutcome};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn prepare_continuation(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<crate::continuation::Context> {
    let m = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        m.prepare_continuation(&session_id, &tab_id).map_err(err)
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn load_tab_events(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Vec<crate::events::AgentEvent>> {
    let m = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || m.load_events(&session_id, &tab_id).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn session_share_create(state: State<'_, AppState>, session_id: String, settings: crate::local_sharing::LinkSettings, direct_only: bool) -> CmdResult<serde_json::Value> {
    state.pairing.create_share(session_id, settings, direct_only).await.map_err(err)
}
#[tauri::command]
pub fn session_share_status(state: State<'_, AppState>, session_id: String) -> CmdResult<serde_json::Value> {
    state.pairing.share_status(&session_id).map_err(err)
}
#[tauri::command]
pub fn session_share_change(state: State<'_, AppState>, session_id: String, action: String, params: serde_json::Value) -> CmdResult<serde_json::Value> {
    state.pairing.change_share(&session_id, &action, params).map_err(err)
}
#[tauri::command]
pub fn session_join_pending(state: State<'_, AppState>) -> Option<String> { state.pairing.pending_join() }
#[tauri::command]
pub async fn session_guest_join(state: State<'_, AppState>, link: String) -> CmdResult<serde_json::Value> {
    state.pairing.join_guest(link).await.map_err(err)
}
#[tauri::command]
pub fn session_guest_send(state: State<'_, AppState>, connection_id: String, request: serde_json::Value) -> CmdResult<()> {
    state.pairing.guest_send(&connection_id, request).map_err(err)
}
#[tauri::command]
pub fn session_guest_leave(state: State<'_, AppState>, connection_id: Option<String>) { state.pairing.leave_guest_connection(connection_id.as_deref()); }

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    text: String,
    images: Option<Vec<ImageInput>>,
    confirm_delivery: Option<bool>,
) -> CmdResult<SendOutcome> {
    let m = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        if confirm_delivery.unwrap_or(false) {
            m.send_confirmed(&session_id, &tab_id, text).map_err(err)
        } else {
            m.send(&session_id, &tab_id, text, images.unwrap_or_default()).map_err(err)
        }
    })
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn interrupt_turn(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<bool> {
    state.sessions().map_err(err)?.interrupt(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn tab_handoff(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<crate::session::HandoffInfo> {
    state.sessions().map_err(err)?.handoff(&session_id, &tab_id).map_err(err)
}

/// The terminal pane a tab's CLI is running in, or nothing if it is not.
/// A window that opened after the CLI did never saw the pane announced.
#[tauri::command]
pub fn tab_pane(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Option<crate::session::TabPtyEvent>> {
    state.sessions().map_err(err)?.pane_of(&session_id, &tab_id).map_err(err)
}

/// Start a tab's own CLI. PTY-first tabs are the CLI, so opening one starts
/// it; harnesses that still run headless do nothing here.
#[tauri::command]
pub async fn ensure_tab_started(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    let m = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || m.ensure_started(&session_id, &tab_id).map_err(err)).await.map_err(err)?
}

/// Stopping and the three settings below all wait for the CLI in the pane to
/// really be gone before they answer, so none of them runs on the main thread.
#[tauri::command]
pub async fn stop_tab(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    let m = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || m.stop(&session_id, &tab_id).map_err(err)).await.map_err(err)?
}

/// Send a message the CLI holds behind its running turn now: interrupt, then type it.
#[tauri::command]
pub fn send_queued_now(state: State<'_, AppState>, session_id: String, tab_id: String, seq: u64) -> CmdResult<()> {
    state.sessions().map_err(err)?.send_queued_now(&session_id, &tab_id, seq).map_err(err)
}

#[tauri::command]
pub fn cancel_queued(state: State<'_, AppState>, session_id: String, tab_id: String, message_id: String) -> CmdResult<Option<QueuedMessage>> {
    state.sessions().map_err(err)?.cancel_queued(&session_id, &tab_id, &message_id).map_err(err)
}

#[tauri::command]
pub fn list_queued(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Vec<QueuedMessage>> {
    state.sessions().map_err(err)?.queued(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn respond_permission(state: State<'_, AppState>, session_id: String, tab_id: String, request_id: String, option_id: String) -> CmdResult<()> {
    state.sessions().map_err(err)?.respond_permission(&session_id, &tab_id, &request_id, &option_id).map_err(err)
}

#[tauri::command]
pub fn answer_questions(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    request_id: String,
    answers: std::collections::HashMap<String, String>,
) -> CmdResult<()> {
    state.sessions().map_err(err)?.answer_questions(&session_id, &tab_id, &request_id, answers).map_err(err)
}

#[tauri::command]
pub async fn set_tab_model(state: State<'_, AppState>, session_id: String, tab_id: String, model: String) -> CmdResult<()> {
    let m = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || m.set_model(&session_id, &tab_id, &model).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn set_tab_permission_mode(state: State<'_, AppState>, session_id: String, tab_id: String, mode: String) -> CmdResult<()> {
    let m = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || m.set_permission_mode(&session_id, &tab_id, &mode).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn set_tab_effort(state: State<'_, AppState>, session_id: String, tab_id: String, effort: Option<String>) -> CmdResult<()> {
    let m = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || m.set_effort(&session_id, &tab_id, effort.as_deref()).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn mark_tab_read(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    state.sessions().map_err(err)?.mark_read(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn tab_status(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<TabStatus> {
    state.sessions().map_err(err)?.status_of(&session_id, &tab_id).map_err(err)
}

/// The picker's list. Claude and Codex depend on the signed-in account and
/// on the CLI installed here, so both are read from their CLIs and cached; the
/// rest is static. `refresh` is what the picker sends when it opens, so a
/// model added (or retired) mid-session shows up without a restart. Ordering
/// and the hidden-harness filter both live in `models::offered`.
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>, refresh: Option<bool>) -> CmdResult<Vec<crate::models::Model>> {
    let cache = state.codex_models.clone();
    let refresh = refresh.unwrap_or(false);
    // Each asks its own CLI; neither waits on the other.
    let claude = tauri::async_runtime::spawn_blocking(move || crate::harness::claude::models::get(refresh));
    let codex = tauri::async_runtime::spawn_blocking(move || cache.get(refresh));
    Ok(crate::models::offered(claude.await.map_err(err)?, codex.await.map_err(err)?))
}

#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[webview] {message}"),
        // Chatty by nature — a line per dictation result — so it sits at the
        // level a reader has to ask for.
        "debug" => log::debug!("[webview] {message}"),
        _ => log::info!("[webview] {message}"),
    }
}

// ------------------------------------------------------------------ status bar

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBarPatch {
    pub visible: Option<bool>,
    pub usage: Option<bool>,
    pub resources: Option<bool>,
    pub percent: Option<crate::store::settings::StatusPercent>,
    pub usage_mode: Option<crate::store::settings::StatusUsageMode>,
    pub usage_refresh_minutes: Option<u32>,
}

#[tauri::command]
pub fn status_bar_settings() -> crate::store::settings::StatusBarSettings {
    store::settings::load().status_bar
}

#[tauri::command]
pub fn set_status_bar_settings(app: AppHandle, patch: StatusBarPatch) -> CmdResult<crate::store::settings::StatusBarSettings> {
    let mut settings = store::settings::load();
    if let Some(value) = patch.visible {
        settings.status_bar.visible = value;
    }
    if let Some(value) = patch.usage {
        settings.status_bar.usage = value;
    }
    if let Some(value) = patch.resources {
        settings.status_bar.resources = value;
    }
    if let Some(value) = patch.percent {
        settings.status_bar.percent = value;
    }
    if let Some(value) = patch.usage_mode {
        settings.status_bar.usage_mode = value;
    }
    if let Some(value) = patch.usage_refresh_minutes {
        if !crate::store::settings::USAGE_REFRESH_MINUTES.contains(&value) {
            return Err(format!("Usage cannot refresh every {value} minutes."));
        }
        settings.status_bar.usage_refresh_minutes = value;
    }
    store::settings::save(&settings).map_err(err)?;
    crate::status::set_menu_checked(&app, settings.status_bar.visible);
    let _ = app.emit(crate::status::SETTINGS_EVENT, &settings.status_bar);
    Ok(settings.status_bar)
}

#[tauri::command]
pub fn status_usage_snapshot(state: State<'_, AppState>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    state.sessions().map_err(err)?.usage_snapshot().map_err(err)
}

#[tauri::command]
pub async fn status_usage_refresh(state: State<'_, AppState>, manual: Option<bool>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    let manager = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || manager.refresh_usage(manual.unwrap_or(false)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn status_codex_reset(state: State<'_, AppState>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    let manager = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || manager.reset_codex_usage().map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn status_resource_overview(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    state.sessions().map_err(err)?.resource_overview().map_err(err)
}

#[tauri::command]
pub async fn status_resource_sample(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let sessions = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.resource_sample().map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn status_resource_kill(
    state: State<'_, AppState>,
    pane_id: String,
    confirmed: Option<bool>,
) -> CmdResult<serde_json::Value> {
    let sessions = state.sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.resource_kill(&pane_id, confirmed.unwrap_or(false)).map_err(err))
        .await
        .map_err(err)?
}

// ------------------------------------------------------------------ files & commands

#[tauri::command]
pub async fn search_files(cwd: String, query: String, limit: Option<usize>) -> CmdResult<Vec<crate::files::FileHit>> {
    tauri::async_runtime::spawn_blocking(move || crate::files::search(Path::new(&cwd), &query, limit.unwrap_or(40)).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn invalidate_file_index(cwd: String) {
    crate::files::invalidate(Path::new(&cwd));
}

#[tauri::command]
pub async fn list_slash_commands(cwd: String, harness: String) -> CmdResult<Vec<harness::claude::commands::SlashCommand>> {
    if harness != "claude" {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || harness::claude::commands::list(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub media_type: String,
    pub data: String,
    pub name: String,
}

/// Read an image the reader dropped or picked, as base64 for the wire.
#[tauri::command]
pub async fn read_image_file(path: String) -> CmdResult<Option<ImageFile>> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let media = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => return Ok(None),
        };
        let meta = std::fs::metadata(p).map_err(err)?;
        if meta.len() > 5 * 1024 * 1024 {
            return Ok(None);
        }
        use base64::Engine as _;
        let bytes = std::fs::read(p).map_err(err)?;
        Ok(Some(ImageFile {
            media_type: media.into(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        }))
    })
    .await
    .map_err(err)?
}

// ------------------------------------------------------------------ git actions & PRs

#[tauri::command]
pub async fn git_commit(cwd: String, message: String, paths: Option<Vec<String>>) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || git::commit_all(Path::new(&cwd), &message, paths.as_deref()).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn git_identity() -> CmdResult<Option<git::Identity>> {
    tauri::async_runtime::spawn_blocking(git::global_identity).await.map_err(err)
}

#[tauri::command]
pub async fn git_push(cwd: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || git::push(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn git_pull(cwd: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || git::pull(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn git_discard(cwd: String, path: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || git::discard_file(Path::new(&cwd), &path).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn git_checkout(cwd: String, name: String, create: bool) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || git::checkout_branch(Path::new(&cwd), &name, create).map_err(err)).await.map_err(err)?
}

/// Uncommitted changes: HEAD's tree against a snapshot of the checkout. The
/// snapshot (not `git diff <tree>`) is what makes untracked files count.
#[tauri::command]
pub async fn working_changes(cwd: String) -> CmdResult<(String, Vec<git::ChangedFile>)> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&cwd);
        let head = git::head_tree(p).map_err(err)?;
        let snapshot = git::snapshot_tree(p).map_err(err)?;
        let files = if head == snapshot { Vec::new() } else { git::changes_between(p, &head, Some(&snapshot)).map_err(err)? };
        Ok((head, files))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_associations(session_key: String, additions: Vec<crate::pr_associations::Association>) -> CmdResult<Vec<crate::pr_associations::Association>> {
    tauri::async_runtime::spawn_blocking(move || crate::pr_associations::for_session(&session_key, additions).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_list(cwd: String, branch: String) -> CmdResult<Vec<crate::github::PullRequest>> {
    tauri::async_runtime::spawn_blocking(move || crate::github::prs_for_branch(Path::new(&cwd), &branch).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_landed(cwd: String) -> CmdResult<crate::landed::Landed> {
    tauri::async_runtime::spawn_blocking(move || crate::landed::check(Path::new(&cwd), Path::new(&cwd), crate::landed::Fetch::Fresh)).await.map_err(err)
}

#[tauri::command]
pub async fn pr_details(cwd: String, number: u64, url: Option<String>) -> CmdResult<crate::github::PullRequest> {
    tauri::async_runtime::spawn_blocking(move || crate::github::associated_pr_details(Path::new(&cwd), number, url.as_deref()).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_create(cwd: String, title: String, body: String, base: Option<String>, draft: bool, session_id: Option<String>) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = crate::github::create_pr(Path::new(&cwd), &title, &body, base.as_deref(), draft).map_err(err)?;
        if let Some(session) = session_id {
            crate::pr_associations::record_local(&session, Path::new(&cwd), &url, &crate::git::current_branch(Path::new(&cwd)).unwrap_or_default())
                .map_err(|error| format!("Created {url}, but saving its session association failed: {error:#}"))?;
        }
        Ok(url)
    })
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn pr_merge(cwd: String, number: u64, method: String, url: Option<String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::github::merge_associated_pr(Path::new(&cwd), number, &method, url.as_deref()).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_ready(cwd: String, number: u64, url: Option<String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::github::ready_associated_pr(Path::new(&cwd), number, url.as_deref()).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn gh_available() -> bool {
    crate::github::available()
}

// ------------------------------------------------------------------ terminals

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_spawn(state: State<'_, AppState>, id: String, cwd: String, cols: u16, rows: u16, command: Option<String>, title: Option<String>) -> CmdResult<()> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    tauri::async_runtime::spawn_blocking(move || runtime.terminals()?.spawn(&id, &cwd, cols, rows, command.as_deref(), title.as_deref())).await.map_err(err)?.map_err(err)
}


/// Which of these shell tabs are running a command now, for a close that would end it.
#[tauri::command]
pub async fn pty_busy(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<Vec<String>> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    tauri::async_runtime::spawn_blocking(move || runtime.terminals()?.busy(&ids)).await.map_err(err)?.map_err(err)
}

/// The shell tabs that are open, in every session: a window loaded after
/// they were opened (the floating one, a reload) lists them from this.
#[tauri::command]
pub async fn pty_shells(state: State<'_, AppState>) -> CmdResult<Vec<crate::pty::ShellPane>> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    tauri::async_runtime::spawn_blocking(move || runtime.terminals()?.shells()).await.map_err(err)?.map_err(err)
}

/// The agents in front of terminals right now (#437), for a window that
/// loads after they were started.
#[tauri::command]
pub fn pane_agents(state: State<'_, AppState>) -> CmdResult<Vec<crate::session::follow::PaneAgent>> {
    state.sessions().map_err(err)?.pane_agents().map_err(err)
}

/// Start a tab's agent again on one of the tab's conversations (#437): the
/// one it holds, or one it held before another agent was run in its terminal.
#[tauri::command]
pub async fn tab_resume_conversation(app: AppHandle, session_id: String, tab_id: String, harness: String, provider_session_id: String) -> CmdResult<()> {
    let manager = app.state::<AppState>().sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || manager.resume_conversation(&session_id, &tab_id, &harness, &provider_session_id).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pty_rename(state: State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    tauri::async_runtime::spawn_blocking(move || runtime.terminals()?.rename(&id, &title)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn pty_write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    tauri::async_runtime::spawn_blocking(move || runtime.terminals()?.write(&id, data.as_bytes())).await.map_err(err)?.map_err(err)
}

/// The window shows this pane: send it the pane's output as raw bytes, the
/// scrollback so far first. No base64, no JSON, and no other listener hears it.
/// `token` names this attachment in the acknowledgements and the detach that follow.
#[tauri::command]
pub async fn pty_attach(window: tauri::WebviewWindow, state: State<'_, AppState>, id: String, token: String, channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) -> CmdResult<()> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || runtime.attach(&label, &id, &token, Box::new(move |bytes| channel.send(tauri::ipc::InvokeResponseBody::Raw(bytes.to_vec())).is_ok())))
        .await.map_err(err)?.map_err(err)
}

/// The window has drawn `drawn` bytes of the pane's output since it attached (flow control).
#[tauri::command]
pub fn pty_ack(window: tauri::WebviewWindow, state: State<'_, AppState>, id: String, token: String, drawn: u64) -> CmdResult<()> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    runtime.ack(window.label(), &id, &token, drawn).map_err(err)
}

/// A freshly loaded window: whatever its previous page was shown is gone.
/// Only this window's views: another window goes on showing its terminals.
#[tauri::command]
pub fn pty_detach_all(window: tauri::WebviewWindow, state: State<'_, AppState>) {
    if let Some(runtime) = state.runtime() { runtime.detach_window(window.label()); }
}

#[tauri::command]
pub fn pty_detach(window: tauri::WebviewWindow, state: State<'_, AppState>, id: String, token: String) -> CmdResult<()> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    runtime.detach(window.label(), &id, &token).map_err(err)
}

#[tauri::command]
pub async fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    tauri::async_runtime::spawn_blocking(move || runtime.terminals()?.resize(&id, cols, rows)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub fn mobile_terminal_drivers(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    state.pairing.mobile_driven_tabs().map_err(err)
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    tauri::async_runtime::spawn_blocking(move || runtime.terminals()?.kill(&id)).await.map_err(err)?.map_err(err)
}

/// The webview's answer to a `terminal_perf_request` event.
#[tauri::command]
pub fn terminal_perf_reply(id: String, result: serde_json::Value) {
    crate::terminal_perf::reply(&id, result);
}

/// Whether the person lets the command line use cloud workspaces (PRO-40).
#[tauri::command]
pub fn cloud_control_setting() -> bool {
    crate::cloud_control::enabled()
}

/// What became of a request to change the switch: what it is now and, when
/// it did not turn on, why (`declined`, `backoff:<seconds>`, `busy`, `expired`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudControlSettingChange {
    enabled: bool,
    refused: Option<String>,
}

/// Turn the switch on or off. Turning it on asks the person in a native
/// dialog first, which neither the window nor computer use can answer.
#[tauri::command]
pub async fn cloud_control_set_setting(app: tauri::AppHandle, enabled: bool) -> Result<CloudControlSettingChange, String> {
    if enabled && !crate::cloud_control::enabled() {
        let answer = cloud_control_question(
            app,
            "Let agents in local sessions control cloud workspaces?".to_string(),
            "Any agent running in a local session will be able to list your organizations' cloud workspaces, read their conversations and send messages to running ones. Starting, stopping or creating a workspace will still ask you each time.".to_string(),
            "Turn on".to_string(),
        )
        .await;
        if answer != crate::cloud_control::Answer::Accepted {
            return Ok(CloudControlSettingChange { enabled: crate::cloud_control::enabled(), refused: Some(answer.wire()) });
        }
    }
    crate::cloud_control::set_enabled(enabled)?;
    Ok(CloudControlSettingChange { enabled: crate::cloud_control::enabled(), refused: None })
}

/// Ask the person about a cloud request that came from the command line.
/// Answers `accepted`, `declined`, `expired` (not answered in time),
/// `busy` (another question is on screen) or `backoff:<seconds>` (they
/// refused or left one unanswered a moment ago and are not asked again yet).
#[tauri::command]
pub async fn cloud_control_confirm(app: tauri::AppHandle, what: String, ok_label: String) -> String {
    let message = format!("A terminalx command (run by you or by an agent in a local session) asks to {what}");
    cloud_control_question(app, "Cloud workspace request".to_string(), message, ok_label).await.wire()
}

/// One native question, one at a time.
///
/// - **Only the agree button agrees.** The dialog has three buttons (see
///   [`cloud_control_buttons`]): "Refuse" first and default, so Return
///   refuses; the agree button; and "Close", which is where the platform
///   reports every dismissal (Escape, the window's close box). Anything but
///   the agree button is a refusal.
/// - **It expires.** The caller is answered after [`QUESTION_TTL`] whether or
///   not the person has answered. An expired request is dropped: the dialog
///   may still be on screen (it cannot be closed from here), and pressing
///   anything on it later does nothing. No other question is shown until it
///   is gone, and the back-off starts when it expired.
/// - Computer-use actions are refused for as long as the dialog is on screen.
///
/// [`QUESTION_TTL`]: crate::cloud_control::QUESTION_TTL
pub(crate) async fn cloud_control_question(app: tauri::AppHandle, title: String, message: String, ok_label: String) -> crate::cloud_control::Answer {
    use crate::cloud_control::{question_answered, question_begin, question_closed, question_expired, Confirming, QUESTION_TTL};
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    // Kept short and on one line: the label comes from this app, but never trust its length.
    let ok_label: String = ok_label.chars().filter(|c| !c.is_control()).take(40).collect();
    if let Err(answer) = question_begin(std::time::Instant::now()) {
        return answer;
    }
    let message = format!("{message}\n\nIf this is not answered within {} seconds the request is dropped, and answering later does nothing.", QUESTION_TTL.as_secs());
    let agree = ok_label.clone();
    let mut dialog = tauri::async_runtime::spawn_blocking(move || {
        let _open = Confirming::begin();
        let pressed = app
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(cloud_control_buttons(&ok_label))
            .blocking_show_with_result();
        cloud_control_agreed(&pressed, &agree)
    });
    match tokio::time::timeout(QUESTION_TTL, &mut dialog).await {
        Ok(pressed) => question_answered(pressed.unwrap_or(false), std::time::Instant::now()),
        Err(_) => {
            let answer = question_expired(std::time::Instant::now());
            // The dialog is still up. Wait for it to go, ignoring what was pressed.
            tauri::async_runtime::spawn(async move {
                let _ = dialog.await;
                question_closed();
            });
            answer
        }
    }
}

const CLOUD_CONTROL_REFUSE: &str = "Refuse";
const CLOUD_CONTROL_CLOSE: &str = "Close";

/// The question's buttons. Which slot each label sits in matters, because
/// the dialog layer reports a dismissal as its *cancel* slot and then renames
/// the result to that slot's label (tauri-plugin-dialog `desktop.rs`: rfd
/// answers `Cancel` for Escape and the close box on Linux and Windows):
///
/// - yes: "Refuse" (first, so it is the default and Return refuses);
/// - no: the agree label;
/// - cancel: "Close". A dismissal lands here and nowhere else.
///
/// With two buttons the agree label would have to take the cancel slot, and
/// every dismissal would come back as agreement.
fn cloud_control_buttons(agree: &str) -> tauri_plugin_dialog::MessageDialogButtons {
    tauri_plugin_dialog::MessageDialogButtons::YesNoCancelCustom(CLOUD_CONTROL_REFUSE.to_string(), agree.to_string(), CLOUD_CONTROL_CLOSE.to_string())
}

/// Whether the dialog's result is the explicit agree button, and nothing else.
fn cloud_control_agreed(pressed: &tauri_plugin_dialog::MessageDialogResult, agree: &str) -> bool {
    matches!(pressed, tauri_plugin_dialog::MessageDialogResult::Custom(label)
        if label == agree && label != CLOUD_CONTROL_REFUSE && label != CLOUD_CONTROL_CLOSE)
}

/// The window's answer to a `cloud_control_request` event (PRO-40).
#[tauri::command]
pub fn cloud_control_reply(id: String, result: serde_json::Value) {
    crate::cloud_control::reply(&id, result);
}

// ------------------------------------------------------------------ files & editor

#[tauri::command]
pub async fn list_dir(root: String, rel: String) -> CmdResult<Vec<crate::files::DirEntry>> {
    tauri::async_runtime::spawn_blocking(move || crate::files::list_dir(Path::new(&root), &rel)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<crate::files::TextFile> {
    tauri::async_runtime::spawn_blocking(move || crate::files::read_text(Path::new(&path))).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> CmdResult<u64> {
    tauri::async_runtime::spawn_blocking(move || crate::files::write_text(Path::new(&path), &content)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub fn file_mtime(path: String) -> Option<u64> {
    crate::files::stat_mtime(Path::new(&path))
}

#[tauri::command]
pub async fn inspect_local_path(base: String, path: String) -> CmdResult<crate::files::LocalPathInfo> {
    tauri::async_runtime::spawn_blocking(move || crate::files::inspect_local_path(Path::new(&base), Path::new(&path)))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Local-main-window only (not ACP/paired RPC): open an existing filesystem
/// object with the OS default application, with no caller-selected program.
#[tauri::command]
pub async fn open_local_path(app: AppHandle, path: String) -> CmdResult<()> {
    let path = tauri::async_runtime::spawn_blocking(move || crate::files::existing_local_path(Path::new(&path)))
        .await
        .map_err(err)?
        .map_err(err)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(err)
}

#[tauri::command]
pub async fn search_text(
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    limit: Option<usize>,
    replacement: Option<String>,
) -> CmdResult<crate::files::TextSearch> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::files::search_text(Path::new(&root), &query, regex, case_sensitive, limit.unwrap_or(500), replacement.as_deref())
    })
    .await
    .map_err(err)?
    .map_err(err)
}

#[tauri::command]
pub async fn replace_text(
    root: String,
    query: String,
    replacement: String,
    regex: bool,
    case_sensitive: bool,
    targets: Option<Vec<crate::files::ReplaceTarget>>,
    skip: Option<Vec<String>>,
) -> CmdResult<crate::files::ReplaceReport> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::files::replace_text(Path::new(&root), &query, &replacement, regex, case_sensitive, targets, &skip.unwrap_or_default())
    })
    .await
    .map_err(err)?
    .map_err(err)
}

// ------------------------------------------------------------------ dictation

#[tauri::command]
pub fn dictation_available() -> bool {
    crate::dictation::Dictation::available()
}

// Opening a microphone means talking to CoreAudio, which walks every audio
// device on the system and can block for a second or more. A synchronous
// command runs on the thread that services the webview's IPC — the main thread
// — so these hop onto the blocking pool and return as soon as the work is
// handed over.
#[tauri::command]
pub async fn dictation_start(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let (dictation, transcription) = (state.dictation.clone(), state.transcription.clone());
    tauri::async_runtime::spawn_blocking(move || dictation.start(app, transcription)).await.map_err(err)?
}

#[tauri::command]
pub async fn dictation_stop(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let (dictation, transcription) = (state.dictation.clone(), state.transcription.clone());
    tauri::async_runtime::spawn_blocking(move || dictation.stop(app, transcription)).await.map_err(err)?
}

// ------------------------------------------------------------------ transcription models

#[tauri::command]
pub fn transcription_models(state: State<'_, AppState>) -> Vec<crate::transcription::ModelRow> {
    state.transcription.models()
}

#[tauri::command]
pub fn transcription_download(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.transcription.downloads.start(app, &id).map_err(err)
}

#[tauri::command]
pub fn transcription_cancel_download(state: State<'_, AppState>, id: String) {
    state.transcription.downloads.cancel(&id);
}

#[tauri::command]
pub fn transcription_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.transcription.delete(&id).map_err(err)
}

#[tauri::command]
pub fn transcription_set_model(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.transcription.set_model(&id).map_err(err)
}

#[tauri::command]
pub fn transcription_preferences(state: State<'_, AppState>) -> crate::transcription::TranscriptionPreferences {
    state.transcription.preferences()
}

/// Enumerates input devices, so it must stay off the IPC thread and must only
/// be invoked in response to an explicit input-picker or dictation action.
#[tauri::command]
pub async fn transcription_inputs(state: State<'_, AppState>) -> CmdResult<Vec<crate::transcription::audio::InputDevice>> {
    let transcription = state.transcription.clone();
    tauri::async_runtime::spawn_blocking(move || transcription.inputs()).await.map_err(err)
}

#[tauri::command]
pub fn transcription_set_input(state: State<'_, AppState>, device: Option<String>) -> CmdResult<()> {
    state.transcription.set_input(device).map_err(err)
}

#[tauri::command]
pub fn transcription_set_mute(state: State<'_, AppState>, mute: bool) -> CmdResult<()> {
    state.transcription.set_mute(mute).map_err(err)
}

// ------------------------------------------------------------------ issues

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearStatus {
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer: Option<String>,
}

fn linear_key() -> CmdResult<String> {
    store::settings::load().linear_api_key.filter(|k| !k.trim().is_empty()).ok_or_else(|| "Linear is not connected. Add an API key in Settings → Integrations.".to_string())
}

#[tauri::command]
pub async fn issues_list(project_path: String, provider: String, filter: crate::issues::IssueFilter) -> CmdResult<Vec<crate::issues::Issue>> {
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "github" => crate::issues::github_list(Path::new(&project_path), &filter).map_err(err),
        "linear" => crate::issues::linear_list(&linear_key()?, &filter).map_err(err),
        other => Err(format!("unknown issue provider {other}")),
    })
    .await
    .map_err(err)?
}

// Managing one issue: the contract is `crate::issue_ops` (mirrored in
// src/lib/issueOps.ts). A failure is an `IssueOpError` with a kind and a fixed
// message, and every write answers with the issue as re-read from the provider.

type IssueOpResult<T> = Result<T, crate::issue_ops::IssueOpError>;

async fn issue_op<T: Send + 'static>(
    project_path: String,
    provider: crate::issue_ops::Provider,
    op: impl FnOnce(&crate::issue_ops::Target) -> IssueOpResult<T> + Send + 'static,
) -> IssueOpResult<T> {
    tauri::async_runtime::spawn_blocking(move || op(&crate::issue_ops::Target::resolve(Path::new(&project_path), provider)?))
        .await
        .map_err(|_| crate::issue_ops::IssueOpError::new(crate::issue_ops::IssueOpErrorKind::Other, provider))?
}

#[tauri::command]
pub async fn issue_details(project_path: String, provider: crate::issue_ops::Provider, id: String) -> IssueOpResult<crate::issue_ops::IssueDetails> {
    issue_op(project_path, provider, move |target| crate::issue_ops::details(target, &id)).await
}

#[tauri::command]
pub async fn issue_comments(project_path: String, provider: crate::issue_ops::Provider, id: String, cursor: Option<String>) -> IssueOpResult<crate::issue_ops::CommentsPage> {
    issue_op(project_path, provider, move |target| crate::issue_ops::comments(target, &id, cursor.as_deref())).await
}

/// What the pickers offer: for an issue's repository or team (`id`), or for
/// a new Linear issue in `team_id`. Cached per repository or team; `refresh`
/// reads them again.
#[tauri::command]
pub async fn issue_options(project_path: String, provider: crate::issue_ops::Provider, id: Option<String>, team_id: Option<String>, refresh: Option<bool>) -> IssueOpResult<crate::issue_ops::IssueOptions> {
    issue_op(project_path, provider, move |target| crate::issue_ops::options(target, id.as_deref(), team_id.as_deref(), refresh.unwrap_or(false))).await
}

/// Who the reader is to the provider, named as `issue_set_assignees` takes people.
#[tauri::command]
pub async fn issue_viewer(project_path: String, provider: crate::issue_ops::Provider) -> IssueOpResult<crate::issue_ops::IssueUser> {
    issue_op(project_path, provider, crate::issue_ops::viewer::viewer).await
}

#[tauri::command]
pub async fn issue_comment_add(project_path: String, provider: crate::issue_ops::Provider, id: String, body: String) -> IssueOpResult<crate::issue_ops::IssueComment> {
    issue_op(project_path, provider, move |target| crate::issue_ops::comment_add(target, &id, &body)).await
}

#[tauri::command]
pub async fn issue_comment_edit(project_path: String, provider: crate::issue_ops::Provider, id: String, comment_id: String, body: String) -> IssueOpResult<crate::issue_ops::IssueComment> {
    issue_op(project_path, provider, move |target| crate::issue_ops::comment_edit(target, &id, &comment_id, &body)).await
}

#[tauri::command]
pub async fn issue_comment_delete(project_path: String, provider: crate::issue_ops::Provider, id: String, comment_id: String) -> IssueOpResult<()> {
    issue_op(project_path, provider, move |target| crate::issue_ops::comment_delete(target, &id, &comment_id)).await
}

#[tauri::command]
pub async fn issue_set_state(project_path: String, provider: crate::issue_ops::Provider, id: String, change: crate::issue_ops::StateChange) -> IssueOpResult<crate::issue_ops::IssueDetails> {
    issue_op(project_path, provider, move |target| crate::issue_ops::set_state(target, &id, &change)).await
}

/// The whole set: Linear user ids (one or none), GitHub logins (up to 10).
#[tauri::command]
pub async fn issue_set_assignees(project_path: String, provider: crate::issue_ops::Provider, id: String, assignees: Vec<String>) -> IssueOpResult<crate::issue_ops::IssueDetails> {
    issue_op(project_path, provider, move |target| crate::issue_ops::set_assignees(target, &id, &assignees)).await
}

/// The whole set: Linear label ids, GitHub label names.
#[tauri::command]
pub async fn issue_set_labels(project_path: String, provider: crate::issue_ops::Provider, id: String, labels: Vec<String>) -> IssueOpResult<crate::issue_ops::IssueDetails> {
    issue_op(project_path, provider, move |target| crate::issue_ops::set_labels(target, &id, &labels)).await
}

#[tauri::command]
pub async fn issue_set_priority(project_path: String, provider: crate::issue_ops::Provider, id: String, priority: u8) -> IssueOpResult<crate::issue_ops::IssueDetails> {
    issue_op(project_path, provider, move |target| crate::issue_ops::set_priority(target, &id, priority)).await
}

#[tauri::command]
pub async fn issue_set_title(project_path: String, provider: crate::issue_ops::Provider, id: String, title: String) -> IssueOpResult<crate::issue_ops::IssueDetails> {
    issue_op(project_path, provider, move |target| crate::issue_ops::set_title(target, &id, &title)).await
}

#[tauri::command]
pub async fn issue_set_description(project_path: String, provider: crate::issue_ops::Provider, id: String, edit: crate::issue_ops::DescriptionEdit) -> IssueOpResult<crate::issue_ops::IssueDetails> {
    issue_op(project_path, provider, move |target| crate::issue_ops::set_description(target, &id, &edit)).await
}

#[tauri::command]
pub async fn issue_create(project_path: String, provider: crate::issue_ops::Provider, input: crate::issue_ops::IssueCreate) -> IssueOpResult<crate::issue_ops::IssueDetails> {
    issue_op(project_path, provider, move |target| crate::issue_ops::create(target, &input)).await
}

/// The project's Markdown issue templates (`.github/ISSUE_TEMPLATE/*.md`), from its checkout or cloud repository.
#[tauri::command]
pub async fn issue_templates(project_path: String) -> IssueOpResult<Vec<crate::issue_ops::templates::IssueTemplate>> {
    tauri::async_runtime::spawn_blocking(move || crate::issue_ops::templates::load(Path::new(&project_path)))
        .await
        .map_err(|_| crate::issue_ops::IssueOpError::new(crate::issue_ops::IssueOpErrorKind::Other, crate::issue_ops::Provider::Github))?
}

#[tauri::command]
pub fn linear_status() -> LinearStatus {
    let s = store::settings::load();
    let connected = s.linear_api_key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false);
    LinearStatus { connected, viewer: if connected { s.linear_viewer } else { None } }
}

/// Store a key after checking it answers; an empty key disconnects.
#[tauri::command]
pub async fn linear_set_api_key(key: String) -> CmdResult<LinearStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = key.trim().to_string();
        let mut s = store::settings::load();
        if key.is_empty() {
            s.linear_api_key = None;
            s.linear_viewer = None;
            store::settings::save(&s).map_err(err)?;
            return Ok(LinearStatus { connected: false, viewer: None });
        }
        let viewer = crate::issues::linear_viewer(&key).map_err(err)?;
        s.linear_api_key = Some(key);
        s.linear_viewer = Some(viewer.clone());
        store::settings::save(&s).map_err(err)?;
        Ok(LinearStatus { connected: true, viewer: Some(viewer) })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn linear_teams() -> CmdResult<Vec<crate::issues::IssueTeam>> {
    tauri::async_runtime::spawn_blocking(move || crate::issues::linear_teams(&linear_key()?).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn github_repo(project_path: String) -> Option<String> {
    crate::issues::github_repo(Path::new(&project_path))
}

/// The GitHub account a project is connected to: the one its pushes land as.
#[tauri::command]
pub async fn github_identity(project_path: String, refresh: Option<bool>) -> CmdResult<crate::github_identity::GithubIdentity> {
    tauri::async_runtime::spawn_blocking(move || crate::github_identity::identity(Path::new(&project_path), refresh.unwrap_or(false)))
        .await
        .map_err(err)
}

// ------------------------------------------------------------------ issue pipelines

/// A pipeline as it starts, with what the author's first prompt must carry
/// for the pipeline to hear when the work is done.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedIssuePipeline {
    pub pipeline: crate::issue_pipeline::Pipeline,
    pub author_brief: String,
}

#[tauri::command]
pub fn issue_pipelines_list() -> CmdResult<Vec<crate::issue_pipeline::Pipeline>> {
    crate::issue_pipeline::store::list().map_err(err)
}

/// Carry a session that was started from an issue on to a pull request, a
/// review and a merge. Refused, with the reason, for a session the pipeline
/// cannot serve: one on the default branch, or in a project that turned it off.
#[tauri::command]
pub async fn issue_pipeline_start(app: AppHandle, session_id: String, tab_id: String, auto_merge: Option<bool>) -> CmdResult<StartedIssuePipeline> {
    let sessions = app.state::<AppState>().sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.pipeline("start", serde_json::json!({"sessionId":session_id,"tabId":tab_id,"autoMerge":auto_merge})).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn issue_pipeline_continue(app: AppHandle, session_id: String, tab_id: String, options: crate::issue_pipeline::LaunchOptions) -> CmdResult<Option<StartedIssuePipeline>> {
    let sessions = app.state::<AppState>().sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.pipeline("continue", serde_json::json!({"sessionId":session_id,"tabId":tab_id,"options":options})).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn issue_pipeline_set_auto_merge(app: AppHandle, id: String, value: bool) -> CmdResult<crate::issue_pipeline::Pipeline> {
    let sessions = app.state::<AppState>().sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.pipeline("autoMerge", serde_json::json!({"id":id,"value":value})).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn issue_pipeline_set_resolve_conflicts(app: AppHandle, id: String, value: bool) -> CmdResult<crate::issue_pipeline::Pipeline> {
    let sessions = app.state::<AppState>().sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.pipeline("resolveConflicts", serde_json::json!({"id":id,"value":value})).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn issue_pipeline_act(app: AppHandle, id: String, action: crate::issue_pipeline::engine::Action) -> CmdResult<crate::issue_pipeline::Pipeline> {
    let sessions = app.state::<AppState>().sessions().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || sessions.pipeline("act", serde_json::json!({"id":id,"action":action})).map_err(err)).await.map_err(err)?
}

/// Move a cloud workspace's Linear issue to its team's review state with the
/// reader's own Linear key: the workspace has none. What it did, as the
/// pipeline's record says it.
#[tauri::command]
pub async fn issue_pipeline_linear_to_review(id: String, identifier: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let moved = crate::issues::linear_move_to_review(&linear_key()?, &id).map_err(err)?;
        Ok(crate::issue_pipeline::host::review_move_line(&identifier, moved))
    })
    .await
    .map_err(err)?
}

/// Merge a cloud workspace's pull request as the reader, with their own `gh`
/// (`issue_pipeline::cloud_merge`): a cloud workspace never merges by itself.
/// `pipeline` is as the workspace reported it, and `repository` the cloud
/// project's own (`owner/name`), which its pull request must be in.
#[tauri::command]
pub async fn issue_pipeline_merge_cloud(
    pipeline: crate::issue_pipeline::Pipeline,
    repository: String,
    settings: Option<crate::store::projects::IssuePipelineSettings>,
) -> CmdResult<crate::issue_pipeline::cloud_merge::CloudMerge> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings.unwrap_or_default();
        crate::issue_pipeline::cloud_merge::merge(&crate::issue_pipeline::cloud_merge::ReadersGh, &pipeline, &repository, &settings).map_err(err)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod command_tests {
    #[test]
    fn only_the_agree_button_agrees_to_a_cloud_request() {
        use tauri_plugin_dialog::MessageDialogResult;
        assert!(super::cloud_control_agreed(&MessageDialogResult::Custom("Resume and send".into()), "Resume and send"));
        // Everything else is a refusal: the Refuse button, a dismissal, and any result this code does not expect.
        for pressed in [
            MessageDialogResult::Custom("Refuse".into()),
            MessageDialogResult::Custom("Something else".into()),
            MessageDialogResult::Custom(String::new()),
            MessageDialogResult::Cancel,
            MessageDialogResult::No,
            MessageDialogResult::Ok,
            MessageDialogResult::Yes,
        ] {
            assert!(!super::cloud_control_agreed(&pressed, "Resume and send"), "{pressed:?}");
        }
        // A caller cannot make "Refuse" or "Close" the agree button.
        assert!(!super::cloud_control_agreed(&MessageDialogResult::Custom("Refuse".into()), "Refuse"));
        assert!(!super::cloud_control_agreed(&MessageDialogResult::Custom("Close".into()), "Close"));
    }

    /// What the platform's dialog answered, before the dialog layer renames it.
    #[derive(Clone, Copy, Debug)]
    enum Native {
        Yes,
        No,
        Ok,
        Cancel,
    }

    /// The renaming tauri-plugin-dialog 2.7.3 applies to a native result
    /// (`desktop.rs`, `show_message_dialog`), for the button sets used here.
    /// On Linux and Windows the platform never names a custom button itself,
    /// so this table is what decides which label a click or a dismissal
    /// becomes.
    fn as_the_dialog_layer_reports(native: Native, buttons: &tauri_plugin_dialog::MessageDialogButtons) -> tauri_plugin_dialog::MessageDialogResult {
        use tauri_plugin_dialog::{MessageDialogButtons as Buttons, MessageDialogResult as Result};
        match (native, buttons) {
            (Native::Ok, Buttons::OkCancelCustom(ok, _)) => Result::Custom(ok.clone()),
            (Native::Cancel, Buttons::OkCancelCustom(_, cancel)) => Result::Custom(cancel.clone()),
            (Native::Yes, Buttons::YesNoCancelCustom(yes, _, _)) => Result::Custom(yes.clone()),
            (Native::No, Buttons::YesNoCancelCustom(_, no, _)) => Result::Custom(no.clone()),
            (Native::Cancel, Buttons::YesNoCancelCustom(_, _, cancel)) => Result::Custom(cancel.clone()),
            (Native::Yes, _) => Result::Yes,
            (Native::No, _) => Result::No,
            (Native::Ok, _) => Result::Ok,
            (Native::Cancel, _) => Result::Cancel,
        }
    }

    #[test]
    fn a_dismissal_of_the_cloud_question_never_agrees_on_any_platform() {
        use tauri_plugin_dialog::MessageDialogButtons;
        let agree = "Resume and send";
        let buttons = super::cloud_control_buttons(agree);
        // The button set itself: Refuse first (the default), the agree label in the "no" slot, and a
        // third button whose only job is to be where a dismissal lands.
        assert!(matches!(&buttons, MessageDialogButtons::YesNoCancelCustom(yes, no, cancel) if yes == "Refuse" && no == agree && cancel == "Close"));
        let agreed = |native| super::cloud_control_agreed(&as_the_dialog_layer_reports(native, &buttons), agree);
        // Escape, the close box, an aborted modal: the platform says Cancel. That is not agreement.
        assert!(!agreed(Native::Cancel));
        // The default button (Return) refuses.
        assert!(!agreed(Native::Yes));
        // A result the button set does not have is not agreement either.
        assert!(!agreed(Native::Ok));
        // Only a click on the agree button is.
        assert!(agreed(Native::No));

        // Why three buttons: with two, the agree label has to sit in the cancel slot, and the same
        // dismissal comes back named as the agree button. This is the bug the review found.
        let two = MessageDialogButtons::OkCancelCustom("Refuse".into(), agree.into());
        assert!(super::cloud_control_agreed(&as_the_dialog_layer_reports(Native::Cancel, &two), agree));
    }

    use std::path::Path;
    use std::process::Command;

    use super::{rename_workspace_entries, NewSession, NewTab};

    // PRO-79: the app's own confirmation before a local sign-in is uploaded.
    #[test]
    fn the_local_sign_in_confirmation_names_the_organization_the_account_and_the_expiry() {
        use crate::cloud_workspaces::{AgentLoginKind, AgentLoginProvider, AgentLoginReach};
        let new = AgentLoginReach::ServiceDefault;
        let text = super::local_login_confirmation(AgentLoginProvider::Claude, "Acme Robotics", "ada@example.com", "3 Oct 2026, 21:40", None, &new);
        assert!(text.starts_with("Organization: Acme Robotics\nAccount (as Claude Code on this Mac records it): ada@example.com\n"));
        assert!(!text.contains("REPLACES") && !text.contains("sign out of Claude Code"));
        // Review of #293: replacing a stored login is said, in the dialog too.
        let replacing = super::local_login_confirmation(AgentLoginProvider::Claude, "Acme Robotics", "ada@example.com", "3 Oct 2026, 21:40", Some(AgentLoginKind::ApiKey), &new);
        assert!(replacing.contains("THIS REPLACES the API key now stored for Claude Code in Acme Robotics"));
        assert!(replacing.contains("agents in every workspace of the organization stop"));
        assert!(super::local_login_confirmation(AgentLoginProvider::Claude, "Acme", "a@b.c", "x", Some(AgentLoginKind::LoginDocument), &new).contains("THIS REPLACES the login now stored"));
        // Review of #293: the API-key and the sign-in dialogs say it too.
        assert_eq!(super::replacement_notice("Claude Code", "Acme", Some(AgentLoginKind::ApiKey)), "THIS REPLACES the API key now stored for Claude Code in Acme.\n\n");
        assert_eq!(super::replacement_notice("Cursor", "Acme", Some(AgentLoginKind::LoginDocument)), "THIS REPLACES the login now stored for Cursor in Acme.\n\n");
        assert_eq!(super::replacement_notice("Cursor", "Acme", None), "");
        // The expiry is stored as a UTC time, and dialog text is cleaned.
        assert_eq!(super::lent_identity(AgentLoginProvider::Claude, Some("ada@example.com"), 1_790_000_000_000), "ada@example.com · lent until 2026-09-21T14:13:20Z");
        assert_eq!(super::dialog_text(" Acme\u{202E}\n Robotics "), "Acme Robotics");
        assert!(text.contains("stops working on 3 Oct 2026, 21:40"));
        assert!(text.contains("The refresh token stays on this Mac"));
        // A new login: every member's workspaces, said as the service's default.
        assert!(text.contains("By default, agents in every member's cloud workspaces of the organization may run on it"));
        // Review of #429: a login narrowed to managers keeps that scope when it is replaced, and no dialog says otherwise.
        let narrowed = AgentLoginReach::Kept("managers".into());
        let kept = super::local_login_confirmation(AgentLoginProvider::Claude, "Acme", "a@b.c", "x", Some(AgentLoginKind::LoginDocument), &narrowed);
        assert!(kept.contains("This keeps who can use the login now: only workspaces that nobody but owners and admins can drive."));
        assert!(!kept.contains("every member"));
        let code = super::claude_code_prompt("Acme", Some(AgentLoginKind::LoginDocument), &narrowed);
        assert!(code.starts_with("THIS REPLACES the login now stored for Claude Code in Acme.\n\nPaste the code"));
        assert!(code.ends_with("This keeps who can use the login now: only workspaces that nobody but owners and admins can drive."));
        assert!(!code.contains("every member"));
        let first = super::claude_code_prompt("Acme", None, &new);
        assert!(first.starts_with("Paste the code") && first.contains("By default, agents in every member's cloud workspaces"));
        assert!(text.contains("Anyone who can drive one of those workspaces can read the token"));
        // #450: a running workspace does not stop a disconnect.
        assert!(text.contains("To end it sooner, disconnect it in Settings: that reaches every workspace of the organization, running ones included."));
        assert!(!text.contains("refuses while a workspace still uses the login"));
    }

    // PRO-79: lending this Mac's Codex sign-in says the same things, for Codex and ChatGPT.
    #[test]
    fn the_codex_lend_confirmation_says_the_same_for_codex() {
        use crate::cloud_workspaces::{AgentLoginKind, AgentLoginProvider, AgentLoginReach};
        let claude = super::local_login_confirmation(AgentLoginProvider::Claude, "Acme", "ada@example.com", "3 Oct 2026, 21:40", Some(AgentLoginKind::ApiKey), &AgentLoginReach::ServiceDefault);
        let codex = super::local_login_confirmation(AgentLoginProvider::Codex, "Acme", "ada@example.com", "3 Oct 2026, 21:40", Some(AgentLoginKind::ApiKey), &AgentLoginReach::ServiceDefault);
        assert!(codex.starts_with("Organization: Acme\nAccount (as Codex on this Mac records it): ada@example.com\n"));
        assert!(codex.contains("THIS REPLACES the API key now stored for Codex in Acme. The key is removed; when the lent sign-in expires, Codex agents in every workspace"));
        assert!(codex.contains("short-lived access token, with its ID token (which names the account and plan), to the account service"));
        assert!(codex.contains("The refresh token stays on this Mac") && codex.contains("stops working on 3 Oct 2026, 21:40"));
        assert!(codex.contains("Until then agents run on your ChatGPT subscription."));
        assert!(!codex.contains("Claude"));
        // Everything else is word for word the Claude Code dialog.
        let same = |text: &str| text.replace("Claude Code", "AGENT").replace("Codex", "AGENT").replace("Claude subscription", "SUB subscription").replace("ChatGPT subscription", "SUB subscription").replace(", with its ID token (which names the account and plan),", "");
        assert_eq!(same(&claude), same(&codex));
        assert_eq!(super::lent_identity(AgentLoginProvider::Codex, None, 1_790_000_000_000), "Codex on a Mac · lent until 2026-09-21T14:13:20Z");
    }

    // PRO-111: the provider key dialog names the provider and the organization, not their ids.
    #[test]
    fn the_provider_key_prompt_names_the_provider_and_the_organization() {
        use crate::cloud_workspaces::CloudWorkspaceProviderId;
        assert_eq!(
            super::provider_key_prompt("Local Docker (development)", "Org B"),
            "Enter the Local Docker (development) provider key for organization Org B. The key is sent to the account service only for validation and secure storage."
        );
        // Names from the account service are cleaned; the id or the provider's own label stands in for none.
        assert_eq!(super::dialog_name(Some(" Org\u{202E} B\n".into()), "08c6afb1"), "Org B");
        assert_eq!(super::dialog_name(Some("\u{200B} ".into()), "08c6afb1"), "08c6afb1");
        assert_eq!(super::dialog_name(None, "08c6afb1"), "08c6afb1");
        assert_eq!(super::dialog_name(None, CloudWorkspaceProviderId::Box.label()), "Boat");
        assert_eq!(CloudWorkspaceProviderId::LocalDocker.label(), "Local Docker");
    }
    use crate::session_ops::{
        create_session_entry, new_tab_entry, notify_workspace_deleted,
        validate_session_target,
    };

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git").current_dir(cwd).args(args).output().unwrap();
        assert!(output.status.success(), "git {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).into_owned()
    }
    #[test]
    fn new_tabs_use_the_default_permission_mode_when_unspecified() {
        let tab = new_tab_entry(&NewTab {
            harness: "claude".into(),
            model: String::new(),
            effort: None,
            permission_mode: None,
        });

        assert_eq!(
            tab.permission_mode,
            crate::store::index::DEFAULT_PERMISSION_MODE
        );

        // Blank is unset too; a named mode is the reader's and is kept.
        let blank = new_tab_entry(&NewTab { harness: "codex".into(), model: String::new(), effort: None, permission_mode: Some(String::new()) });
        assert_eq!(blank.permission_mode, "bypassPermissions");
        let chosen = new_tab_entry(&NewTab { harness: "claude".into(), model: String::new(), effort: None, permission_mode: Some("manual".into()) });
        assert_eq!(chosen.permission_mode, "manual");
    }

    #[test]
    fn folder_sessions_and_workspaces_survive_reload_without_git() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = crate::store::projects::add(&dir.path().to_string_lossy()).unwrap();
        assert_eq!(project.kind, crate::store::projects::ProjectKind::Folder);
        let workspaces = crate::workspaces::list(dir.path()).unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].path, project.path);
        assert!(workspaces[0].is_main && !workspaces[0].managed);
        assert!(workspaces[0].branch.is_none() && workspaces[0].head.is_none());
        for agent in [false, true] {
            let req: NewSession = serde_json::from_value(serde_json::json!({
                "projectPath": project.path, "useWorktree": true,
                "worktreeName": "saved-preference",
                "tab": if agent { serde_json::json!({"harness": "codex", "model": ""}) } else { serde_json::Value::Null }
            })).unwrap();
            let session = create_session_entry(req).unwrap();
            assert_eq!(session.cwd, project.path);
            assert!(session.worktree_name.is_none() && session.branch.is_none() && session.base_ref.is_none());
            assert_eq!(crate::store::index::get(&session.id).unwrap().cwd, project.path);
        }
        assert_eq!(super::list_projects().unwrap().projects, vec![project.clone()]);
        assert_eq!(crate::store::projects::add(&format!("{}/", project.path)).unwrap().path, project.path);
        assert_eq!(super::list_projects().unwrap().projects.len(), 1);
        assert!(!dir.path().join(".git").exists());
        assert!(!dir.path().join(".raccoon").exists());
        assert!(!crate::git::work_status(dir.path()).is_repo);
    }

    #[test]
    fn session_and_workspace_targets_must_be_directories() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, "hello").unwrap();
        for target in [&file, &dir.path().join("missing")] {
            assert!(crate::store::projects::add(&target.to_string_lossy()).is_err());
            assert!(crate::workspaces::list(target).is_err());
            for override_cwd in [false, true] {
                let req = serde_json::from_value(serde_json::json!({
                    "projectPath": if override_cwd { dir.path() } else { target.as_path() },
                    "cwd": if override_cwd { Some(target) } else { None }, "useWorktree": false
                })).unwrap();
                assert!(create_session_entry(req).is_err());
            }
        }
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn create_session_opens_an_existing_worktree_without_a_tab() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let external = dir.path().join("external");
        std::fs::create_dir(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        git(&project, &["config", "user.email", "t@example.com"]);
        git(&project, &["config", "user.name", "T"]);
        std::fs::write(project.join("README.md"), "project\n").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-q", "-m", "initial"]);
        git(&project, &["worktree", "add", "-q", "-b", "feature/external", external.to_str().unwrap()]);
        let before = git(&project, &["worktree", "list", "--porcelain"]);

        let session = create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: None,
            use_worktree: true,
            on_main: false,
            checkout_branch: None,
            base_ref: None,
            worktree_name: None,
            issue: None,
            automation: None,
            cwd: Some(external.to_string_lossy().into_owned()),
            tab: None,
        })
        .unwrap();

        assert_eq!(session.cwd, external.canonicalize().unwrap().to_string_lossy());
        assert_eq!(session.branch.as_deref(), Some("feature/external"));
        assert_eq!(session.title, "feature/external");
        assert!(session.tabs.is_empty());
        assert_eq!(session.active_tab, None);
        assert_eq!(session.worktree_name, None);
        assert_eq!(git(&project, &["worktree", "list", "--porcelain"]), before);
        assert_eq!(crate::store::index::load().unwrap(), vec![session]);
    }

    #[test]
    fn renames_a_managed_workspace_and_every_attached_session() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        git(&project, &["config", "user.email", "t@example.com"]);
        git(&project, &["config", "user.name", "T"]);
        std::fs::write(project.join("README.md"), "project\n").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-q", "-m", "initial"]);

        let first = create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: Some("First".into()),
            use_worktree: true,
            on_main: false,
            checkout_branch: None,
            base_ref: None,
            worktree_name: Some("old-workspace".into()),
            issue: None,
            automation: None,
            cwd: None,
            tab: Some(NewTab {
                harness: "codex".into(),
                model: String::new(),
                effort: None,
                permission_mode: None,
            }),
        })
        .unwrap();
        let second = create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: Some("Second".into()),
            use_worktree: false,
            on_main: false,
            checkout_branch: None,
            base_ref: None,
            worktree_name: None,
            issue: None,
            automation: None,
            cwd: Some(first.cwd.clone()),
            tab: None,
        })
        .unwrap();
        std::fs::write(Path::new(&first.cwd).join("dirty.txt"), "kept\n").unwrap();

        let renamed = rename_workspace_entries(&first.project_path, &first.cwd, "Better Workspace").unwrap();
        assert_eq!(renamed.name, "better-workspace");
        assert_eq!(renamed.branch, "raccoon/better-workspace");
        assert_eq!(renamed.sessions.len(), 2);
        assert!(renamed.sessions.iter().any(|session| session.id == first.id));
        assert!(renamed.sessions.iter().any(|session| session.id == second.id));
        for session in &renamed.sessions {
            assert!(session.cwd.ends_with("/.raccoon/worktrees/better-workspace"));
            assert_eq!(session.worktree_name.as_deref(), Some("better-workspace"));
            assert_eq!(session.branch.as_deref(), Some("raccoon/better-workspace"));
        }
        let cwd = Path::new(&renamed.path);
        assert_eq!(std::fs::read_to_string(cwd.join("dirty.txt")).unwrap(), "kept\n");
        assert_eq!(git(cwd, &["branch", "--show-current"]).trim(), "raccoon/better-workspace");
        assert!(!Path::new(&first.cwd).exists());
        assert_eq!(crate::store::index::load().unwrap(), renamed.sessions);
    }

    #[test]
    fn renames_a_branch_in_place_and_carries_its_sessions_and_label() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        git(&project, &["config", "user.email", "t@example.com"]);
        git(&project, &["config", "user.name", "T"]);
        std::fs::write(project.join("README.md"), "project\n").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-q", "-m", "initial"]);

        let session = create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: Some("First".into()),
            use_worktree: true,
            on_main: false,
            checkout_branch: None,
            base_ref: None,
            worktree_name: Some("calm-ember".into()),
            issue: None,
            automation: None,
            cwd: None,
            tab: Some(NewTab { harness: "codex".into(), model: String::new(), effort: None, permission_mode: None }),
        })
        .unwrap();
        let attached = crate::store::projects::add(project.to_str().unwrap()).unwrap();
        let from = session.branch.clone().unwrap();
        assert_ne!(from, "main");
        crate::store::projects::update(
            &attached.path,
            crate::store::projects::ProjectPatch { branch_label: Some(crate::store::projects::BranchLabel { branch: from.clone(), label: Some("Pricing research".into()) }), ..Default::default() },
        )
        .unwrap();

        assert!(crate::session_ops::rename_branch_entries(&attached.path, &from, "not a branch").is_err());
        assert!(crate::session_ops::rename_branch_entries(&attached.path, &from, "main").is_err());
        let renamed = crate::session_ops::rename_branch_entries(&attached.path, &from, "pricing-research").unwrap();
        assert_eq!(renamed.branch, "pricing-research");
        assert_eq!(renamed.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), [session.id.as_str()]);
        assert_eq!(renamed.project.branch_labels.get("pricing-research").map(String::as_str), Some("Pricing research"));
        // The worktree stays where it was, now on the renamed branch.
        assert_eq!(renamed.sessions[0].cwd, session.cwd);
        assert_eq!(git(Path::new(&session.cwd), &["branch", "--show-current"]).trim(), "pricing-research");
        assert_eq!(crate::store::index::load().unwrap()[0].branch.as_deref(), Some("pricing-research"));
    }

    #[test]
    fn deleting_a_workspace_removes_its_sessions_transcripts_and_attachments() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let worktree = dir.path().join("attached-worktree");
        std::fs::create_dir(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        git(&project, &["config", "user.email", "t@example.com"]);
        git(&project, &["config", "user.name", "T"]);
        std::fs::write(project.join("README.md"), "project\n").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-q", "-m", "initial"]);
        git(&project, &["worktree", "add", "-q", "-b", "feature/attached", worktree.to_str().unwrap()]);

        let created = create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: Some("Attached session".into()),
            use_worktree: true,
            on_main: false,
            checkout_branch: None,
            base_ref: None,
            worktree_name: None,
            issue: None,
            automation: None,
            cwd: Some(worktree.to_string_lossy().into_owned()),
            tab: Some(NewTab {
                harness: "codex".into(),
                model: "gpt-5".into(),
                effort: None,
                permission_mode: None,
            }),
        })
        .unwrap();
        let attached = crate::store::index::update_session(&created.id, |session| {
            session.worktree_name = Some("attached-worktree".into());
            session.base_ref = Some("main".into());
            Ok(session.clone())
        })
        .unwrap();
        let companion = create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: Some("Companion session".into()),
            use_worktree: true,
            on_main: false,
            checkout_branch: None,
            base_ref: None,
            worktree_name: None,
            issue: None,
            automation: None,
            cwd: Some(worktree.to_string_lossy().into_owned()),
            tab: None,
        })
        .unwrap();
        let bystander = create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: Some("Session on main".into()),
            use_worktree: false,
            on_main: true,
            checkout_branch: None,
            base_ref: None,
            worktree_name: None,
            issue: None,
            automation: None,
            cwd: None,
            tab: None,
        })
        .unwrap();
        let tab_id = attached.active_tab.as_deref().unwrap();
        let transcript = crate::store::log_path(&attached.id, tab_id).unwrap();
        std::fs::write(&transcript, "{\"kind\":\"message\"}\n").unwrap();
        let attachments = crate::store::root().unwrap().join("attachments").join(&attached.id);
        std::fs::create_dir_all(&attachments).unwrap();
        std::fs::write(attachments.join("shot.png"), b"png").unwrap();

        let removed = remove_for_test(&project, &worktree);

        assert!(!worktree.exists());
        assert_eq!(crate::workspaces::list(&project).unwrap().len(), 1);
        let mut removed_ids: Vec<_> = removed.iter().map(|session| session.id.clone()).collect();
        removed_ids.sort();
        let mut expected = vec![attached.id.clone(), companion.id.clone()];
        expected.sort();
        assert_eq!(removed_ids, expected);
        assert!(!transcript.exists());
        assert!(!transcript.parent().unwrap().exists());
        assert!(!attachments.exists());
        let remaining = crate::store::index::load().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, bystander.id);
        assert!(remaining[0].removed_workspace.is_none());
    }

    /// Delete a workspace as the dialog does after the second confirmation
    /// (these repositories have no remote, so nothing verifies as merged).
    fn remove_for_test(project: &Path, worktree: &Path) -> Vec<crate::store::index::SessionEntry> {
        let sink = crate::sink::BroadcastSink::new(16);
        let request = crate::session_ops::WorkspaceRemoval {
            project_path: project.to_str().unwrap(),
            path: worktree.to_str().unwrap(),
            sessions: crate::session_ops::SessionsFate::Delete,
            delete_branch: true,
            confirmation: crate::session_ops::Confirmation::Forced,
            expected_sessions: None,
            direct: crate::git::DirectDelete::Allowed,
            fetch: crate::landed::Fetch::Skip,
            guard: None,
        };
        crate::session_ops::remove_workspace(&sink, &request, &|_| {}).unwrap().sessions
    }

    #[test]
    fn deleting_a_workspace_without_sessions_removes_it_immediately() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let worktree = dir.path().join("empty-worktree");
        std::fs::create_dir(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        git(&project, &["config", "user.email", "t@example.com"]);
        git(&project, &["config", "user.name", "T"]);
        git(&project, &["commit", "-q", "--allow-empty", "-m", "initial"]);
        git(&project, &["worktree", "add", "-q", "-b", "feature/empty", worktree.to_str().unwrap()]);

        let moved = remove_for_test(&project, &worktree);

        assert!(moved.is_empty());
        assert!(!worktree.exists());
        assert_eq!(crate::workspaces::list(&project).unwrap().len(), 1);
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn workspace_deletion_notification_announces_removed_sessions_and_project() {
        use std::sync::{Arc, Mutex};
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let deleted_events = Arc::new(Mutex::new(Vec::new()));
        let updated_events = Arc::new(Mutex::new(Vec::new()));
        let workspace_events = Arc::new(Mutex::new(Vec::new()));
        let captured_deleted = deleted_events.clone();
        handle.listen("session_deleted", move |event| {
            captured_deleted.lock().unwrap().push(event.payload().to_string());
        });
        let captured_updated = updated_events.clone();
        handle.listen("session_updated", move |event| {
            captured_updated.lock().unwrap().push(event.payload().to_string());
        });
        let captured_workspaces = workspace_events.clone();
        handle.listen("workspaces_changed", move |event| {
            captured_workspaces.lock().unwrap().push(event.payload().to_string());
        });
        let removed = crate::store::index::SessionEntry {
            id: "removed-session".into(),
            kind: crate::store::index::SessionKind::Project,
            project_path: "/repo".into(),
            cwd: "/repo/.raccoon/worktrees/gone".into(),
            worktree_name: Some("gone".into()),
            branch: Some("feature/gone".into()),
            base_ref: None,
            worktree_base: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: None,
            issue_work: Default::default(),
            automation: None,
            title: "Removed".into(),
            created: "now".into(),
            modified: "now".into(),
            archived: false,
            pinned: false,
            tabs: Vec::new(),
            link: None,
            active_tab: None,
            unknown: Default::default(),
        };

        notify_workspace_deleted(&handle, "/repo", &[removed]);

        assert_eq!(deleted_events.lock().unwrap().as_slice(), ["\"removed-session\""]);
        assert!(updated_events.lock().unwrap().is_empty());
        assert_eq!(workspace_events.lock().unwrap().as_slice(), ["\"/repo\""]);
    }

    #[test]
    fn requested_worktree_cannot_be_silently_skipped() {
        let req: NewSession = serde_json::from_value(serde_json::json!({
            "projectPath": "/repo",
            "useWorktree": false,
            "worktreeName": "eng-42-fix-login",
            "tab": { "harness": "claude" }
        }))
        .unwrap();

        let error = validate_session_target(&req).unwrap_err();
        assert!(error.contains("onMain"));
    }
}

// ------------------------------------------------------------------ projects & workspaces

#[tauri::command]
pub fn update_project(app: AppHandle, path: String, patch: projects::ProjectPatch) -> CmdResult<Project> {
    let project = projects::update(&path, patch).map_err(err)?;
    let _ = app.emit(PROJECTS_CHANGED_EVENT, &());
    Ok(project)
}

/// Copy a chosen image into the store so the project keeps it even if the
/// original moves, and record it as the logo.
#[tauri::command]
pub fn set_project_logo(path: String, source: Option<String>) -> CmdResult<Project> {
    let logo = match source {
        Some(src) => {
            let dir = store::root().map_err(err)?.join("logos");
            std::fs::create_dir_all(&dir).map_err(err)?;
            let ext = Path::new(&src).extension().and_then(|e| e.to_str()).unwrap_or("png");
            let name = format!("{:x}.{ext}", md5_like(&path));
            let dest = dir.join(name);
            std::fs::copy(&src, &dest).map_err(err)?;
            Some(dest.to_string_lossy().into_owned())
        }
        None => None,
    };
    projects::update(&path, projects::ProjectPatch { logo: Some(logo), ..Default::default() }).map_err(err)
}

fn md5_like(s: &str) -> u64 {
    // A stable file name per project; not a security hash.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[tauri::command]
pub async fn list_workspaces(project_path: String) -> CmdResult<Vec<crate::workspaces::Workspace>> {
    tauri::async_runtime::spawn_blocking(move || crate::workspaces::list(Path::new(&project_path)).map_err(err)).await.map_err(err)?
}

/// What earlier deletes left on disk: worktrees no session uses, agent data
/// for worktrees that are gone, and `raccoon/*` branches with no worktree.
/// Reads only, apart from fetching each project's default branch.
#[tauri::command]
pub async fn scan_leftovers() -> CmdResult<Vec<crate::cleanup::Leftover>> {
    tauri::async_runtime::spawn_blocking(|| crate::cleanup::scan().map_err(err)).await.map_err(err)?
}

/// Delete the leftovers the person confirmed. Each is checked again first;
/// anything in use, or not clean and merged, is left alone. How far it is
/// goes out as `leftover_cleanup_progress` events carrying `run`.
#[tauri::command]
pub async fn remove_leftovers(app: AppHandle, ids: Vec<String>, run: Option<String>) -> CmdResult<crate::cleanup::Removal> {
    tauri::async_runtime::spawn_blocking(move || {
        let run = run.unwrap_or_default();
        let report = |progress: &crate::cleanup::Progress| {
            let _ = app.emit(crate::cleanup::PROGRESS_EVENT, crate::worktree_cleanup::OfRun { run: &run, progress });
        };
        let removal = crate::cleanup::remove(&ids, &report).map_err(err)?;
        let projects: std::collections::BTreeSet<&str> =
            removal.removed.iter().filter_map(|id| id.strip_prefix("worktree:")).filter_map(|rest| rest.rsplit_once(':')).map(|(project, _)| project).collect();
        for project in projects {
            let _ = app.emit(crate::session_ops::WORKSPACES_CHANGED_EVENT, project);
        }
        Ok(removal)
    })
    .await
    .map_err(err)?
}



/// Every worktree of the open projects on this machine with whether the
/// clean-up may remove it, and why not. Reads only.
#[tauri::command]
pub async fn worktree_cleanup_scan(app: AppHandle, project_paths: Option<Vec<String>>) -> CmdResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("scan", serde_json::json!({"projectPaths":project_paths})).map_err(err)
    }).await.map_err(err)?
}

/// What removing one worktree would free. `None` when `job` was cancelled.
#[tauri::command]
pub async fn worktree_cleanup_size(app: AppHandle, job: String, project_path: String, path: String) -> CmdResult<Option<u64>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("size", serde_json::json!({"job":job,"projectPath":project_path,"path":path})).map_err(err)
    }).await.map_err(err)?
}

/// Stop the size estimates whose job id starts with `prefix`.
#[tauri::command]
pub async fn worktree_cleanup_cancel_sizes(app: AppHandle, prefix: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("cancelSizes", serde_json::json!({"prefix":prefix})).map_err(err)
    }).await.map_err(err)?
}

/// Remove the worktrees the person confirmed. Each is checked again on the
/// spot; one that changed, is in use or is protected is left and reported.
/// How far it is goes out as `worktree_cleanup_progress` events carrying
/// `run`; the list returned is what happened.
#[tauri::command]
pub async fn worktree_cleanup_remove(app: AppHandle, items: Vec<crate::worktree_cleanup::RemoveItem>, run: Option<String>) -> CmdResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let items: Vec<_> = items.into_iter().map(|item| serde_json::json!({
            "projectPath":item.project_path,"path":item.path,"token":item.token,"deleteSessions":item.delete_sessions,
            "acceptIgnored":item.accept_ignored,"estimatedBytes":item.estimated_bytes
        })).collect();
        let results: serde_json::Value = state.sessions().map_err(err)?.workspace("remove", serde_json::json!({"items":items,"run":run})).map_err(err)?;
        for done in results.as_array().into_iter().flatten() {
            if matches!(done["outcome"].as_str(), Some("removed" | "alreadyRemoved")) {
                if let Some(path) = done["path"].as_str() { state.browser.forget_workspace(&crate::browser::control::canonical(path)); }
            }
        }
        Ok(results)
    }).await.map_err(err)?
}

/// Stop the removal `run` once the worktree it is on is finished. The ones
/// it has not started are left as they are and reported as not attempted.
#[tauri::command]
pub async fn worktree_cleanup_stop(app: AppHandle, run: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("cancelRemove", serde_json::json!({"prefix":run})).map_err(err)
    }).await.map_err(err)?
}

// ---- removing a workspace once its pull request has merged ------------------

pub(crate) const MERGED_CLEANUP_SETTINGS_EVENT: &str = "merged_cleanup_settings";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedCleanupProjectPatch {
    /// A local project's path, or a cloud workspace's key.
    key: String,
    /// `None` follows the default again.
    enabled: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedCleanupPatch {
    enabled: Option<bool>,
    delete_conversations: Option<bool>,
    grace_minutes: Option<u32>,
    project: Option<MergedCleanupProjectPatch>,
}

#[tauri::command]
pub fn merged_cleanup_settings() -> crate::store::settings::MergedCleanupSettings {
    store::settings::load().merged_cleanup
}

#[tauri::command]
pub fn set_merged_cleanup_settings(app: AppHandle, patch: MergedCleanupPatch) -> CmdResult<crate::store::settings::MergedCleanupSettings> {
    let mut settings = store::settings::load();
    let cleanup = &mut settings.merged_cleanup;
    if let Some(value) = patch.enabled {
        cleanup.enabled = value;
    }
    if let Some(value) = patch.delete_conversations {
        cleanup.delete_conversations = value;
    }
    if let Some(value) = patch.grace_minutes {
        if !crate::store::settings::GRACE_MINUTES.contains(&value) {
            return Err(format!("The grace period cannot be {value} minutes."));
        }
        cleanup.grace_minutes = value;
    }
    if let Some(project) = patch.project {
        match project.enabled {
            Some(enabled) => cleanup.projects.insert(project.key, enabled),
            None => cleanup.projects.remove(&project.key),
        };
    }
    store::settings::save(&settings).map_err(err)?;
    let _ = app.emit(MERGED_CLEANUP_SETTINGS_EVENT, &settings.merged_cleanup);
    Ok(settings.merged_cleanup)
}

// ---------------------------------------------------------------- work status (#441)

/// The claims the reader may see on the issues the Issues list shows, or why
/// only this machine's sessions can be shown.
#[tauri::command]
pub async fn work_claims_list(project_path: String, provider: String, issue_urls: Vec<String>, state: tauri::State<'_, crate::AppState>) -> CmdResult<crate::work_claims::WorkClaimsAnswer> {
    let service = state.work_claims.clone();
    tauri::async_runtime::spawn_blocking(move || service.list(&project_path, &provider, &issue_urls)).await.map_err(err)
}

/// The cloud sessions the window knows about, for their work status.
#[tauri::command]
pub fn work_claims_set_cloud(sessions: Vec<crate::work_claims::claims::CloudSession>, state: tauri::State<'_, crate::AppState>) {
    state.work_claims.set_cloud(sessions);
}

#[tauri::command]
pub fn work_status_settings() -> crate::store::settings::WorkStatusSettings {
    store::settings::load().work_status
}

#[tauri::command]
pub fn set_work_status_settings(share_with_team: bool, state: tauri::State<'_, crate::AppState>) -> CmdResult<crate::store::settings::WorkStatusSettings> {
    let mut settings = store::settings::load();
    settings.work_status.share_with_team = share_with_team;
    store::settings::save(&settings).map_err(err)?;
    state.work_claims.nudge();
    Ok(settings.work_status)
}

type OrgWorkStatusResult = Result<crate::work_claims::client::OrganizationWorkStatus, crate::work_claims::client::WorkClaimsError>;

#[tauri::command]
pub async fn organization_work_status(org_id: String, state: tauri::State<'_, crate::AppState>) -> OrgWorkStatusResult {
    let service = state.work_claims.clone();
    tauri::async_runtime::spawn_blocking(move || service.organization(&org_id))
        .await
        .map_err(|_| crate::work_claims::client::WorkClaimsError::local("work_claims_unavailable"))?
}

#[tauri::command]
pub async fn set_organization_work_status(org_id: String, patch: crate::work_claims::client::OrganizationWorkStatusPatch, state: tauri::State<'_, crate::AppState>) -> OrgWorkStatusResult {
    let service = state.work_claims.clone();
    tauri::async_runtime::spawn_blocking(move || service.set_organization(&org_id, &patch))
        .await
        .map_err(|_| crate::work_claims::client::WorkClaimsError::local("work_claims_unavailable"))?
}

fn work_link_changed(app: &AppHandle, state: &crate::AppState, session: &SessionEntry) {
    let _ = app.emit("session_updated", session);
    state.work_claims.nudge();
}

/// "Link to issue…" on a session.
#[tauri::command]
pub fn session_link_issue(app: AppHandle, session_id: String, issue: index::IssueRef, state: tauri::State<'_, crate::AppState>) -> CmdResult<SessionEntry> {
    let session = crate::work_claims::link_issue(&session_id, issue).map_err(err)?;
    work_link_changed(&app, &state, &session);
    Ok(session)
}

/// "Unlink" on a session: its issue, and never that one again by itself.
#[tauri::command]
pub fn session_unlink_issue(app: AppHandle, session_id: String, state: tauri::State<'_, crate::AppState>) -> CmdResult<SessionEntry> {
    let session = crate::work_claims::unlink_issue(&session_id).map_err(err)?;
    work_link_changed(&app, &state, &session);
    Ok(session)
}

/// "Don't share this session".
#[tauri::command]
pub fn session_set_work_private(app: AppHandle, session_id: String, private: bool, state: tauri::State<'_, crate::AppState>) -> CmdResult<SessionEntry> {
    let session = crate::work_claims::set_private(&session_id, private).map_err(err)?;
    work_link_changed(&app, &state, &session);
    Ok(session)
}

/// One pass over the projects the setting is on for: what merged, what
/// stays and why, and the removal of what is safe and due. Which projects
/// those are is read here, from the settings file, so no caller can widen it:
/// with the setting off this removes nothing.
#[tauri::command]
pub async fn merged_cleanup_sweep(app: AppHandle) -> CmdResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let result: serde_json::Value = state.sessions().map_err(err)?.workspace("mergedSweep", serde_json::json!({})).map_err(err)?;
        for status in result["statuses"].as_array().into_iter().flatten() {
            if status["phase"] == "removed" {
                if let Some(path) = status["path"].as_str() { state.browser.forget_workspace(&crate::browser::control::canonical(path)); }
            }
        }
        Ok(result)
    }).await.map_err(err)?
}

/// Keep a workspace that is waiting to be removed, or let it go again.
#[tauri::command]
pub async fn merged_cleanup_hold(app: AppHandle, path: String, held: bool) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("mergedHold", serde_json::json!({"path":path,"held":held})).map_err(err)
    }).await.map_err(err)?
}

/// What was removed by itself, newest first, with whether each can still be
/// brought back.
#[tauri::command]
pub async fn merged_cleanup_records(app: AppHandle) -> CmdResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("mergedRecords", serde_json::json!({})).map_err(err)
    }).await.map_err(err)?
}

/// Undo one removal: the worktree, its branch and what else can be put back.
#[tauri::command]
pub async fn merged_cleanup_restore(app: AppHandle, id: String) -> CmdResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        state.sessions().map_err(err)?.workspace("mergedRestore", serde_json::json!({"id":id})).map_err(err)
    }).await.map_err(err)?
}

/// An attached project's directory, for a call that asks GitHub about it.
fn attached_project(project_path: &str) -> CmdResult<std::path::PathBuf> {
    let (all, _) = projects::list().map_err(err)?;
    all.iter().find(|project| project.path == project_path).map(|project| std::path::PathBuf::from(&project.path)).ok_or_else(|| "That project is not attached.".to_string())
}

/// GitHub's own "Automatically delete head branches" for a project's
/// repository, and whether the reader may change it.
#[tauri::command]
pub async fn github_head_branch_setting(project_path: String) -> CmdResult<crate::github::HeadBranchSetting> {
    tauri::async_runtime::spawn_blocking(move || crate::github::head_branch_setting(&attached_project(&project_path)?).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn github_enable_head_branch_deletion(project_path: String) -> CmdResult<crate::github::HeadBranchSetting> {
    tauri::async_runtime::spawn_blocking(move || crate::github::enable_head_branch_deletion(&attached_project(&project_path)?).map_err(err)).await.map_err(err)?
}

/// What a workspace takes on disk. Asked for one workspace at a time, after
/// the list is shown, because walking a large checkout takes a while.
#[tauri::command]
pub async fn workspace_size(project_path: String, path: String) -> CmdResult<u64> {
    tauri::async_runtime::spawn_blocking(move || crate::workspaces::size(Path::new(&project_path), Path::new(&path)).map_err(err)).await.map_err(err)?
}

/// Resolve the name shown before a new worktree-backed session is created.
/// Supplying a requested name applies the same sanitising and collision rules
/// as creation, so the preview is normally the name that lands on disk.
#[tauri::command]
pub async fn preview_workspace_name(project_path: String, requested: Option<String>) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = projects::canonical(&project_path).map_err(err)?;
        available_worktree_name(Path::new(&project), requested.as_deref(), None)
    })
    .await
    .map_err(err)?
}

pub use crate::session_ops::WorkspaceRename;

/// Rename a managed workspace's folder and matching `raccoon/<name>` branch,
/// then retarget every session that shares it.
#[tauri::command]
pub async fn rename_workspace(app: AppHandle, project_path: String, path: String, name: String) -> CmdResult<WorkspaceRename> {
    tauri::async_runtime::spawn_blocking(move || {
        let renamed = rename_workspace_entries(&project_path, &path, &name).map_err(err)?;
        crate::session_ops::notify_workspace_settled(&app, &project_path, &renamed.sessions);
        Ok(renamed)
    })
    .await
    .map_err(err)?
}

/// Rename a branch where it is checked out, its worktree staying put.
#[tauri::command]
pub async fn rename_branch(app: AppHandle, project_path: String, from: String, to: String) -> CmdResult<crate::session_ops::BranchRename> {
    tauri::async_runtime::spawn_blocking(move || {
        let renamed = crate::session_ops::rename_branch_entries(&project_path, &from, &to).map_err(err)?;
        crate::session_ops::notify_workspace_settled(&app, &project_path, &renamed.sessions);
        Ok(renamed)
    })
    .await
    .map_err(err)?
}

/// The Local VM (`local_vm.rs`): where it stands, and the reader's controls.
/// Each runs the container runtime's CLI, so off the async runtime.
async fn local_vm<F>(call: F) -> CmdResult<crate::local_vm::VmStatus>
where
    F: FnOnce() -> anyhow::Result<crate::local_vm::VmStatus> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(call).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn local_vm_status() -> CmdResult<crate::local_vm::VmStatus> {
    local_vm(|| Ok(crate::local_vm::status())).await
}

#[tauri::command]
pub async fn local_vm_start() -> CmdResult<crate::local_vm::VmStatus> {
    local_vm(crate::local_vm::start).await
}

#[tauri::command]
pub async fn local_vm_stop() -> CmdResult<crate::local_vm::VmStatus> {
    local_vm(crate::local_vm::stop).await
}

#[tauri::command]
pub async fn local_vm_reset() -> CmdResult<crate::local_vm::VmStatus> {
    local_vm(crate::local_vm::reset).await
}

#[tauri::command]
pub async fn local_vm_start_runtime() -> CmdResult<crate::local_vm::VmStatus> {
    local_vm(crate::local_vm::start_runtime).await
}

/// What deleting a workspace would cost: the git state of its tree plus how
/// many sessions (and transcripts) would go with it.
#[tauri::command]
pub async fn workspace_disposition(project_path: String, path: String, fetch: Option<bool>) -> CmdResult<crate::workspaces::WorkspaceDisposition> {
    tauri::async_runtime::spawn_blocking(move || crate::session_ops::workspace_disposition(Path::new(&project_path), Path::new(&path), fetch == Some(true)))
    .await
    .map_err(err)?
}

/// Remove a workspace: the one command behind the workspace menu, the right
/// panel, settling, and the session delete that takes its workspace along.
///
/// `keep_sessions` is settling: the conversations stay and move to the
/// project root. Otherwise the sessions in the workspace are deleted with
/// it. `expected_sessions` are the ones the dialog named; if the workspace
/// holds any other set by now, nothing is removed.
///
/// The clean-and-merged check runs again here. A workspace that is not safe
/// is removed only with `confirmed_digest`: the digest of the check the
/// person saw when they gave the second confirmation. If the workspace has
/// changed since, it no longer matches and nothing is removed.
#[tauri::command]
pub async fn remove_workspace(app: AppHandle, project_path: String, path: String, keep_sessions: bool,
    delete_branch: bool, confirmed_digest: Option<String>, expected_sessions: Vec<String>) -> CmdResult<WorkspaceRemoveReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let removed = state.sessions().map_err(err)?.workspace("removeWorkspace", serde_json::json!({
            "projectPath":project_path,"path":path,"keepSessions":keep_sessions,"deleteBranch":delete_branch,
            "confirmedDigest":confirmed_digest,"expectedSessions":expected_sessions
        })).map_err(err)?;
        state.browser.forget_workspace(&crate::browser::control::canonical(&path));
        Ok(removed)
    }).await.map_err(err)?
}

// ---- The local mirror of a cloud workspace (PRO-25) -------------------------
//
// The frontend reads the workspace (`mirror.manifest`, `fs.read`) and hands
// what it read to these. None of them takes a local path: the mirror's
// directory is chosen here from the two ids, and only reported back.

fn cloud_mirror(organization_id: &str, workspace_id: &str) -> CmdResult<crate::cloud_mirror::Mirror> {
    crate::cloud_mirror::Mirror::at(&store::root().map_err(err)?, organization_id, workspace_id).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMirrorCheck {
    diverged: Vec<crate::cloud_mirror::Divergence>,
    diverged_total: usize,
    /// Discarded paths no sync has replaced yet: not in sync until a plan is carried out.
    discarded: usize,
}

#[tauri::command]
pub async fn cloud_mirror_status(organization_id: String, workspace_id: String) -> CmdResult<crate::cloud_mirror::Status> {
    tauri::async_runtime::spawn_blocking(move || cloud_mirror(&organization_id, &workspace_id)?.status().map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn cloud_mirror_enable(organization_id: String, workspace_id: String, account: String) -> CmdResult<crate::cloud_mirror::Status> {
    tauri::async_runtime::spawn_blocking(move || cloud_mirror(&organization_id, &workspace_id)?.enable_as(&account).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn cloud_mirror_disable(organization_id: String, workspace_id: String, remove_files: bool) -> CmdResult<crate::cloud_mirror::Status> {
    tauri::async_runtime::spawn_blocking(move || cloud_mirror(&organization_id, &workspace_id)?.disable(remove_files).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn cloud_mirror_check(organization_id: String, workspace_id: String) -> CmdResult<CloudMirrorCheck> {
    tauri::async_runtime::spawn_blocking(move || {
        let mirror = cloud_mirror(&organization_id, &workspace_id)?;
        let (diverged, diverged_total) = mirror.check().map_err(err)?;
        Ok(CloudMirrorCheck { diverged, diverged_total, discarded: mirror.pending_discards().map_err(err)? })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn cloud_mirror_plan(organization_id: String, workspace_id: String, manifest: crate::cloud_mirror::Manifest) -> CmdResult<crate::cloud_mirror::Plan> {
    tauri::async_runtime::spawn_blocking(move || cloud_mirror(&organization_id, &workspace_id)?.plan(&manifest).map_err(err)).await.map_err(err)?
}

/// `relative` is workspace-relative; `data_b64` is the file as `fs.read` gave
/// it; `size` is what the manifest listed for it.
#[tauri::command]
pub async fn cloud_mirror_stage(organization_id: String, workspace_id: String, relative: String, data_b64: String, size: u64, etag: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64.as_bytes()).map_err(err)?;
        cloud_mirror(&organization_id, &workspace_id)?.stage(&relative, &bytes, size, &etag).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn cloud_mirror_publish(
    organization_id: String,
    workspace_id: String,
    manifest: crate::cloud_mirror::Manifest,
    etags: BTreeMap<String, String>,
) -> CmdResult<crate::cloud_mirror::Published> {
    tauri::async_runtime::spawn_blocking(move || cloud_mirror(&organization_id, &workspace_id)?.publish(&manifest, &etags).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn cloud_mirror_resolve(
    organization_id: String,
    workspace_id: String,
    manifest: crate::cloud_mirror::Manifest,
    resolution: crate::cloud_mirror::Resolution,
) -> CmdResult<crate::cloud_mirror::Resolved> {
    tauri::async_runtime::spawn_blocking(move || cloud_mirror(&organization_id, &workspace_id)?.resolve(&manifest, resolution).map_err(err)).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMirrorRef {
    organization_id: String,
    workspace_id: String,
}

/// The mirrors on this computer, so the copy of a workspace the person can
/// no longer open can be removed.
#[tauri::command]
pub async fn cloud_mirror_list() -> CmdResult<Vec<CloudMirrorRef>> {
    tauri::async_runtime::spawn_blocking(move || {
        let found = crate::cloud_mirror::existing(&store::root().map_err(err)?);
        Ok(found.into_iter().map(|(organization_id, workspace_id)| CloudMirrorRef { organization_id, workspace_id }).collect())
    })
    .await
    .map_err(err)?
}

/// The saved session could not be read at this launch. Mirrors are kept for
/// a bounded time in that state, then removed. Returns how many were.
#[tauri::command]
pub async fn cloud_mirror_note_unreadable() -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0);
        crate::cloud_mirror::note_unreadable(&store::root().map_err(err)?, now_ms).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Remove what the mirror wrote. Returns the number of files removed.
#[tauri::command]
pub async fn cloud_mirror_purge(organization_id: String, workspace_id: String) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || cloud_mirror(&organization_id, &workspace_id)?.purge().map_err(err)).await.map_err(err)?
}

/// The account now using the app; mirrors made under another one are removed.
#[tauri::command]
pub async fn cloud_mirror_claim_owner(account: String, legacy_email: Option<String>) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || crate::cloud_mirror::claim_owner(&store::root().map_err(err)?, &account, legacy_email.as_deref()).map_err(err)).await.map_err(err)?
}
