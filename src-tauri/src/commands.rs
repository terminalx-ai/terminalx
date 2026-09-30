//! Tauri commands. Thin: validate, call a module, map the error to a string.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};
use crate::store::projects::{self, Project};
use crate::{git, harness, names, store};

pub use crate::session_ops::{NewSession, NewTab};
pub(crate) use crate::session_ops::create_session_blocking;
use crate::session_ops::{
    available_worktree_name, delete_workspace_entries, notify_workspace_deleted, notify_workspace_settled,
    sessions_in_workspace,
};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

/// Stop whatever a tab is running: a headless child, or the terminal pane a
/// PTY-first tab's own CLI lives in.
fn kill_tab(state: &tauri::State<'_, crate::AppState>, session_id: &str, tab_id: &str) {
    state.host.kill(&format!("{session_id}/{tab_id}"));
    state.terminals.kill(&crate::session::SessionManager::pane_id(tab_id));
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

#[tauri::command]
pub fn account_sign_in(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::AccountStatus> {
    state.account.clone().begin_sign_in(&app).map_err(err)
}

#[tauri::command]
pub async fn account_sign_out(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::AccountStatus> {
    state.pairing.sign_out().await;
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || account.sign_out(&app)).await.map_err(err)
}

#[tauri::command]
pub async fn organization_create(
    name: String,
    idempotency_key: String,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<crate::account::OrganizationSummary> {
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

#[cfg(target_os = "macos")]
fn secure_provider_prompt(provider: crate::cloud_workspaces::CloudWorkspaceProviderId, organization_id: &str) -> Result<zeroize::Zeroizing<String>, ProviderPromptError> {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAlert, NSSecureTextField, NSAlertFirstButtonReturn};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    let mtm = MainThreadMarker::new().ok_or(ProviderPromptError::Unavailable)?;
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str("Provider connection"));
    alert.setInformativeText(&NSString::from_str(&format!("Enter the {} provider key for organization {}. The key is sent to the account service only for validation and secure storage.", provider.as_str(), organization_id)));
    let field = NSSecureTextField::initWithFrame(NSSecureTextField::alloc(mtm), NSRect::new(NSPoint::new(0., 0.), NSSize::new(360., 24.)));
    field.setPlaceholderString(Some(&NSString::from_str("Provider key")));
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

#[cfg(not(target_os = "macos"))]
fn secure_provider_prompt(_provider: crate::cloud_workspaces::CloudWorkspaceProviderId, _organization_id: &str) -> Result<zeroize::Zeroizing<String>, ProviderPromptError> {
    Err(ProviderPromptError::Unavailable)
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
    let authorization = tauri::async_runtime::spawn_blocking(move || service.authorize_connect(provider))
        .await
        .map_err(|_| crate::cloud_workspaces::CloudWorkspaceClientError::task_failed(crate::cloud_workspaces::RequestRisk::Read))??;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let org_id = authorization.organization_id().to_owned();
    app.run_on_main_thread(move || { let _ = sender.send(secure_provider_prompt(provider, &org_id)); })
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

#[tauri::command]
pub async fn cloud_provider_disconnect(
    provider: crate::cloud_workspaces::CloudWorkspaceProviderId,
    context_revision: String,
    disposition: crate::cloud_workspaces::DisconnectDisposition,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudProviderConnectionResponse, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.disconnect_provider(provider, context_revision, disposition))
}

#[tauri::command]
pub async fn cloud_workspace_setup(
    provider: crate::cloud_workspaces::CloudWorkspaceProviderId,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSetup, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.setup(provider))
}

#[tauri::command]
pub async fn cloud_workspace_quote(
    input: crate::cloud_workspaces::CloudWorkspaceQuoteInput,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceQuote, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.quote(input))
}

#[tauri::command]
pub async fn cloud_workspace_create(
    input: crate::cloud_workspaces::CloudWorkspaceCreateInput,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Create, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.create(input))
}

#[tauri::command]
pub async fn cloud_workspace_preflight(
    repositories: Vec<crate::cloud_workspaces::CreateRepository>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspacePreflight, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.preflight(repositories))
}

#[tauri::command]
pub async fn cloud_workspace_repositories(
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::SelectedRepositories, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.selected_repositories())
}

#[tauri::command]
pub async fn cloud_workspaces(
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceList, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.workspaces())
}

async fn cloud_workspace_lifecycle(
    state: tauri::State<'_, crate::AppState>,
    workspace_id: String,
    action: crate::cloud_workspaces::OperationAction,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.lifecycle(&workspace_id, action))
}

#[tauri::command]
pub async fn cloud_workspace_suspend(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_workspace_lifecycle(state, workspace_id, crate::cloud_workspaces::OperationAction::Suspend).await
}

#[tauri::command]
pub async fn cloud_workspace_resume(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_workspace_lifecycle(state, workspace_id, crate::cloud_workspaces::OperationAction::Resume).await
}

#[tauri::command]
pub async fn cloud_workspace_release(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_workspace_lifecycle(state, workspace_id, crate::cloud_workspaces::OperationAction::Delete).await
}

/// Archive (30-day trash) or permanently delete; `force` only after the
/// person confirmed stopping running agent work.
#[tauri::command]
pub async fn cloud_workspace_archive(
    workspace_id: String,
    force: bool,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service
        .lifecycle_with(&workspace_id, crate::cloud_workspaces::OperationAction::Archive, force))
}

#[tauri::command]
pub async fn cloud_workspace_delete(
    workspace_id: String,
    force: bool,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service
        .lifecycle_with(&workspace_id, crate::cloud_workspaces::OperationAction::Delete, force))
}

#[tauri::command]
pub async fn cloud_workspace_unarchive(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.unarchive(&workspace_id))
}

#[tauri::command]
pub async fn cloud_workspace_disposition(
    workspace_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceDisposition, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.disposition(&workspace_id))
}

#[tauri::command]
pub async fn cloud_workspace_operation(
    operation_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.operation(&operation_id))
}

#[tauri::command]
pub async fn cloud_workspace_operation_cancel(
    operation_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::cloud_workspaces::CloudWorkspaceSnapshot, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.cancel_operation(&operation_id))
}

#[tauri::command]
pub fn pairing_status(state: tauri::State<'_, crate::AppState>) -> crate::pairing::PairingStatus {
    state.pairing.status()
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

#[tauri::command]
pub fn add_project(path: String) -> CmdResult<Project> {
    projects::add(&path).map_err(err)
}

#[tauri::command]
pub fn remove_project(path: String) -> CmdResult<()> {
    projects::remove(&path).map_err(err)
}

#[tauri::command]
pub fn select_project(path: String) -> CmdResult<()> {
    projects::set_last_selected(&path).map_err(err)
}

// ------------------------------------------------------------------ sessions

#[tauri::command]
pub fn list_sessions() -> CmdResult<Vec<SessionEntry>> {
    store::conversation_titles::backfill().map_err(err)
}

// ---------------------------------------------------------------- automations

#[tauri::command]
pub fn automations_list() -> CmdResult<Vec<crate::automations::Automation>> {
    store::automations::list().map_err(err)
}

#[tauri::command]
pub fn automation_runs(automation_id: String) -> CmdResult<Vec<crate::automations::AutomationRun>> {
    store::automations::list_runs(&automation_id).map_err(err)
}

#[tauri::command]
pub fn automation_issue_states() -> CmdResult<Vec<crate::automations::AutomationIssueState>> {
    crate::automations::issue_states().map_err(err)
}

#[tauri::command]
pub async fn automation_issue_preview(project_path: String, repo: String, query: String) -> CmdResult<Vec<crate::issues::Issue>> {
    tauri::async_runtime::spawn_blocking(move || crate::issues::github_search(Path::new(&project_path), &repo, &query, 50).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn automation_create(app: AppHandle, input: crate::automations::AutomationInput) -> CmdResult<crate::automations::Automation> {
    let mut input = input;
    input.project_path = projects::canonical(&input.project_path).map_err(err)?;
    validate_automation_target(&input)?;
    let automation = crate::automations::definition_from_input(input, None, chrono::Utc::now()).map_err(err)?;
    let automation = store::automations::insert(automation).map_err(err)?;
    crate::automations::emit_definitions(&app);
    Ok(automation)
}

#[tauri::command]
pub fn automation_update(app: AppHandle, id: String, input: crate::automations::AutomationInput) -> CmdResult<crate::automations::Automation> {
    let existing = store::automations::get(&id).map_err(err)?;
    let mut input = input;
    input.project_path = projects::canonical(&input.project_path).map_err(err)?;
    validate_automation_target(&input)?;
    let automation = crate::automations::definition_from_input(input, Some(&existing), chrono::Utc::now()).map_err(err)?;
    let reset_seen = match (&existing.issue_trigger, &automation.issue_trigger) {
        (Some(before), Some(after)) => {
            before.repo != after.repo
                || before.query != after.query
                || (!before.run_on_existing && after.run_on_existing)
        }
        (None, Some(_)) => true,
        _ => false,
    };
    let automation = store::automations::replace(automation).map_err(err)?;
    if reset_seen {
        store::automations::clear_seen(&id).map_err(err)?;
    }
    crate::automations::emit_definitions(&app);
    Ok(automation)
}

#[tauri::command]
pub fn automation_delete(app: AppHandle, id: String) -> CmdResult<()> {
    store::automations::remove(&id).map_err(err)?;
    crate::automations::emit_definitions(&app);
    Ok(())
}

fn validate_automation_target(input: &crate::automations::AutomationInput) -> CmdResult<()> {
    if input.workspace == crate::automations::AutomationWorkspace::NewWorktree && !git::is_repo(Path::new(&input.project_path)) {
        return Err("Folder automations must use an existing session; worktrees require a Git repository.".into());
    }
    if input.workspace == crate::automations::AutomationWorkspace::Session {
        let target = index::get(input.session_id.as_deref().ok_or("Choose a session for this automation.")?).map_err(err)?;
        if projects::canonical(&target.project_path).map_err(err)? != input.project_path {
            return Err("The selected session belongs to another project.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn automation_run_now(app: AppHandle, id: String) -> CmdResult<crate::automations::AutomationRun> {
    tauri::async_runtime::spawn_blocking(move || crate::automations::dispatch(&app, &id, crate::automations::AutomationTrigger::Manual, None).map_err(err))
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
pub async fn app_activity_summary() -> CmdResult<crate::store::activity::Summary> {
    tauri::async_runtime::spawn_blocking(|| crate::store::activity::summary().map_err(err))
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

#[tauri::command]
pub fn add_tab(session_id: String, tab: NewTab) -> CmdResult<TabEntry> {
    crate::session_ops::add_tab_entry(&session_id, &tab)
}

#[tauri::command]
pub fn remove_tab(app: AppHandle, session_id: String, tab_id: String) -> CmdResult<()> {
    let state = app.state::<crate::AppState>();
    kill_tab(&state, &session_id, &tab_id);
    index::update_session(&session_id, |s| {
        s.tabs.retain(|t| t.id != tab_id);
        if s.active_tab.as_deref() == Some(&tab_id) {
            s.active_tab = s.tabs.last().map(|t| t.id.clone());
        }
        Ok(())
    })
    .map_err(err)?;
    if let Ok(p) = store::log_path(&session_id, &tab_id) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[tauri::command]
pub fn rename_session(session_id: String, title: String) -> CmdResult<()> {
    let patch = crate::session_ops::SessionPatch { title: Some(title), ..Default::default() };
    crate::session_ops::update_session_meta(&session_id, &patch).map(|_| ())
}

#[tauri::command]
pub fn set_session_archived(session_id: String, archived: bool) -> CmdResult<()> {
    let patch = crate::session_ops::SessionPatch { archived: Some(archived), ..Default::default() };
    crate::session_ops::update_session_meta(&session_id, &patch).map(|_| ())
}

#[tauri::command]
pub fn set_session_pinned(session_id: String, pinned: bool) -> CmdResult<()> {
    let patch = crate::session_ops::SessionPatch { pinned: Some(pinned), ..Default::default() };
    crate::session_ops::update_session_meta(&session_id, &patch).map(|_| ())
}

#[tauri::command]
pub fn set_active_tab(session_id: String, tab_id: String) -> CmdResult<()> {
    index::update_session(&session_id, |s| {
        if s.tab(&tab_id).is_some() {
            s.active_tab = Some(tab_id);
        }
        Ok(())
    })
    .map_err(err)
}

/// Delete a session, its logs, attachments and (best effort) its worktree.
/// Removing the worktree takes every session that ran in it along, since a
/// checkout that no longer exists has nothing left for them to run in.
#[tauri::command]
pub async fn delete_session(app: AppHandle, session_id: String, remove_worktree: bool) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let stop = |session: &SessionEntry| {
            for tab in &session.tabs {
                kill_tab(&state, &session.id, &tab.id);
            }
        };
        crate::session_ops::delete_session_blocking(&app, &session_id, remove_worktree, &stop).map(|_| ())
    })
    .await
    .map_err(err)?
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

/// Remove a session's worktree, retaining its origin while moving future work
/// to the project root.
#[tauri::command]
pub async fn remove_session_worktree(app: AppHandle, session_id: String) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let s = index::get(&session_id).map_err(err)?;
        let name = s.worktree_name.clone().ok_or("session has no worktree")?;
        let attached = sessions_in_workspace(Path::new(&s.cwd))?;
        for session in &attached {
            for tab in &session.tabs {
                kill_tab(&state, &session.id, &tab.id);
            }
        }
        git::remove_worktree(Path::new(&s.project_path), &name).map_err(err)?;
        let moved = mark_workspace_sessions_removed(&s.project_path, &attached)?;
        notify_workspace_settled(&app, &s.project_path, &moved);
        moved
            .into_iter()
            .find(|entry| entry.id == session_id)
            .ok_or_else(|| "session disappeared while removing its worktree".into())
    })
    .await
    .map_err(err)?
}

/// Settle a worktree session once its work has landed: `delete` removes the
/// worktree and records its provenance, while `relocate` leaves it on disk;
/// both move future work to the project root and stop any agent first.
#[tauri::command]
pub async fn settle_session(app: AppHandle, session_id: String, action: String) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let s = index::get(&session_id).map_err(err)?;
        let name = s.worktree_name.clone().ok_or("session has no worktree")?;
        let out = match action.as_str() {
            "delete" => {
                let attached = sessions_in_workspace(Path::new(&s.cwd))?;
                for session in &attached {
                    for tab in &session.tabs {
                        kill_tab(&state, &session.id, &tab.id);
                    }
                }
                git::remove_worktree(Path::new(&s.project_path), &name).map_err(err)?;
                let moved = mark_workspace_sessions_removed(&s.project_path, &attached)?;
                notify_workspace_settled(&app, &s.project_path, &moved);
                moved
                    .into_iter()
                    .find(|entry| entry.id == session_id)
                    .ok_or_else(|| "session disappeared while settling its worktree".to_string())?
            }
            "relocate" => {
                for tab in &s.tabs {
                    kill_tab(&state, &s.id, &tab.id);
                }
                let branch = git::current_branch(Path::new(&s.project_path));
                let out = index::update_session(&session_id, |s| {
                    s.cwd = s.project_path.clone();
                    s.worktree_name = None;
                    s.worktree_removed = false;
                    s.removed_workspace = None;
                    s.branch = branch.clone();
                    s.base_ref = None;
                    for t in &mut s.tabs {
                        t.status = TabStatus::Idle;
                    }
                    Ok(s.clone())
                })
                .map_err(err)?;
                let _ = app.emit("session_updated", &out);
                out
            }
            other => return Err(format!("unknown settle action {other}")),
        };
        Ok(out)
    })
    .await
    .map_err(err)?
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
        let mut entry = SessionEntry {
            id: id.clone(),
            project_path: src.project_path.clone(),
            cwd: src.cwd.clone(),
            worktree_name: None,
            branch: src.branch.clone(),
            base_ref: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: src.issue.clone(),
            automation: src.automation.clone(),
            title: format!("{} (fork)", src.title),
            created: now.clone(),
            modified: now,
            archived: false,
            pinned: false,
            tabs: vec![new_tab.clone()],
            active_tab: Some(new_tab.id.clone()),
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
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || {
        let tracked = m.tracked_transcript(&session_id, &tab_id);
        crate::continuation::prepare(&session_id, &tab_id, tracked).map_err(err)
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn load_tab_events(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Vec<crate::events::AgentEvent>> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.load_events(&session_id, &tab_id).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    text: String,
    images: Option<Vec<ImageInput>>,
    confirm_delivery: Option<bool>,
) -> CmdResult<SendOutcome> {
    let m = state.manager().ok_or("not ready")?;
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
pub fn interrupt_turn(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.interrupt(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn tab_handoff(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<crate::session::HandoffInfo> {
    state.manager().ok_or("not ready")?.handoff(&session_id, &tab_id).map_err(err)
}

/// The terminal pane a tab's CLI is running in, or nothing if it is not.
/// A window that opened after the CLI did never saw the pane announced.
#[tauri::command]
pub fn tab_pane(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Option<crate::session::TabPtyEvent>> {
    Ok(state.manager().ok_or("not ready")?.pane_of(&session_id, &tab_id))
}

/// Start a tab's own CLI. PTY-first tabs are the CLI, so opening one starts
/// it; harnesses that still run headless do nothing here.
#[tauri::command]
pub async fn ensure_tab_started(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.ensure_started(&session_id, &tab_id).map_err(err)).await.map_err(err)?
}

/// Stopping and the three settings below all wait for the CLI in the pane to
/// really be gone before they answer, so none of them runs on the main thread.
#[tauri::command]
pub async fn stop_tab(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.stop(&session_id, &tab_id).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn cancel_queued(state: State<'_, AppState>, session_id: String, tab_id: String, message_id: String) -> CmdResult<Option<QueuedMessage>> {
    state.manager().ok_or("not ready")?.cancel_queued(&session_id, &tab_id, &message_id).map_err(err)
}

#[tauri::command]
pub fn list_queued(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Vec<QueuedMessage>> {
    Ok(state.manager().ok_or("not ready")?.queued(&session_id, &tab_id))
}

#[tauri::command]
pub fn respond_permission(state: State<'_, AppState>, session_id: String, tab_id: String, request_id: String, option_id: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.respond_permission(&session_id, &tab_id, &request_id, &option_id).map_err(err)
}

#[tauri::command]
pub fn answer_questions(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    request_id: String,
    answers: std::collections::HashMap<String, String>,
) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.answer_questions(&session_id, &tab_id, &request_id, answers).map_err(err)
}

#[tauri::command]
pub async fn set_tab_model(state: State<'_, AppState>, session_id: String, tab_id: String, model: String) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.set_model(&session_id, &tab_id, &model).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn set_tab_permission_mode(state: State<'_, AppState>, session_id: String, tab_id: String, mode: String) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.set_permission_mode(&session_id, &tab_id, &mode).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn set_tab_effort(state: State<'_, AppState>, session_id: String, tab_id: String, effort: Option<String>) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.set_effort(&session_id, &tab_id, effort.as_deref()).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn mark_tab_read(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.mark_read(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn tab_status(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<TabStatus> {
    Ok(state.manager().ok_or("not ready")?.status_of(&session_id, &tab_id))
}

/// The picker's list. Everything but Codex is static; Codex depends on the
/// signed-in account, so it is read from the CLI and cached. `refresh` is what
/// the picker sends when it opens, so a model added (or retired) mid-session
/// shows up without a restart. Ordering and the hidden-harness filter both
/// live in `models::offered`.
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>, refresh: Option<bool>) -> CmdResult<Vec<crate::models::Model>> {
    let cache = state.codex_models.clone();
    let refresh = refresh.unwrap_or(false);
    let codex = tauri::async_runtime::spawn_blocking(move || cache.get(refresh)).await.map_err(err)?;
    Ok(crate::models::offered(codex))
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
    store::settings::save(&settings).map_err(err)?;
    crate::status::set_menu_checked(&app, settings.status_bar.visible);
    let _ = app.emit(crate::status::SETTINGS_EVENT, &settings.status_bar);
    Ok(settings.status_bar)
}

#[tauri::command]
pub fn status_usage_snapshot(state: State<'_, AppState>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    Ok(state.manager().ok_or("not ready")?.usage_snapshot())
}

#[tauri::command]
pub async fn status_usage_refresh(app: AppHandle, state: State<'_, AppState>, manual: Option<bool>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    let status = state.status.clone();
    let manager = state.manager().ok_or("not ready")?;
    let manual = manual.unwrap_or(false);
    let publishing_app = app.clone();
    let publishing_manager = manager.clone();
    let failures = tauri::async_runtime::spawn_blocking(move || {
        let mut failures = Vec::new();
        if let Err(error) = status.usage.refresh_claude(manual) {
            failures.push(format!("Claude usage refresh: {error:#}"));
        }
        // Publish Claude as soon as its source settles; starting Codex's
        // app-server must not hold a confirmed Claude rollover off-screen.
        let _ = publishing_app.emit(crate::status::usage::EVENT, publishing_manager.usage_snapshot());
        if let Err(error) = status.usage.refresh_codex(manual) {
            failures.push(format!("Codex usage refresh: {error:#}"));
        }
        failures
    })
    .await
    .map_err(err)?;
    for failure in failures {
        log::warn!("{failure}");
    }
    let snapshot = manager.usage_snapshot();
    let _ = app.emit(crate::status::usage::EVENT, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn status_codex_reset(app: AppHandle, state: State<'_, AppState>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    let status = state.status.clone();
    let manager = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || status.usage.reset_codex().map_err(err)).await.map_err(err)??;
    let snapshot = manager.usage_snapshot();
    let _ = app.emit(crate::status::usage::EVENT, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn status_resource_overview(state: State<'_, AppState>) -> crate::status::resources::ResourceOverview {
    state.status.resources.overview(&state.terminals)
}

#[tauri::command]
pub async fn status_resource_sample(state: State<'_, AppState>) -> CmdResult<crate::status::resources::ResourceSnapshot> {
    let status = state.status.clone();
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || status.resources.sample(&terminals).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn status_resource_kill(
    state: State<'_, AppState>,
    pane_id: String,
    confirmed: Option<bool>,
) -> CmdResult<crate::status::resources::KillResult> {
    let status = state.status.clone();
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || status.resources.kill(&terminals, &pane_id, confirmed.unwrap_or(false)).map_err(err))
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
pub async fn pr_list(cwd: String, branch: String) -> CmdResult<Vec<crate::github::PullRequest>> {
    tauri::async_runtime::spawn_blocking(move || crate::github::prs_for_branch(Path::new(&cwd), &branch).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_details(cwd: String, number: u64) -> CmdResult<crate::github::PullRequest> {
    tauri::async_runtime::spawn_blocking(move || crate::github::pr_details(Path::new(&cwd), number).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_create(cwd: String, title: String, body: String, base: Option<String>, draft: bool) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || crate::github::create_pr(Path::new(&cwd), &title, &body, base.as_deref(), draft).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn pr_merge(cwd: String, number: u64, method: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::github::merge_pr(Path::new(&cwd), number, &method).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_ready(cwd: String, number: u64) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::github::mark_ready(Path::new(&cwd), number).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn gh_available() -> bool {
    crate::github::available()
}

// ------------------------------------------------------------------ terminals

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<'_, AppState>, id: String, cwd: String, cols: u16, rows: u16, command: Option<String>) -> CmdResult<()> {
    let spec = crate::pty::PaneSpec { cwd: &cwd, cols: cols.max(2), rows: rows.max(1), command: command.as_deref(), env: &[] };
    state.terminals.spawn(std::sync::Arc::new(app), &id, spec).map_err(err)
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    if !state.pairing.desktop_terminal_input_allowed(&id) {
        return Ok(());
    }
    state.terminals.write(&id, data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    if !state.pairing.desktop_terminal_input_allowed(&id) {
        return Ok(());
    }
    state.terminals.resize(&id, cols.max(2), rows.max(1)).map_err(err)
}

#[tauri::command]
pub fn mobile_terminal_drivers(state: State<'_, AppState>) -> Vec<String> {
    state.pairing.mobile_driven_tabs()
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, id: String) {
    state.terminals.kill(&id);
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

#[tauri::command]
pub async fn issue_details(project_path: String, provider: String, id: String) -> CmdResult<crate::issues::Issue> {
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "github" => crate::issues::github_details(Path::new(&project_path), &id).map_err(err),
        "linear" => crate::issues::linear_details(&linear_key()?, &id).map_err(err),
        other => Err(format!("unknown issue provider {other}")),
    })
    .await
    .map_err(err)?
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

#[cfg(test)]
mod command_tests {
    use std::path::Path;
    use std::process::Command;

    use super::{rename_workspace_entries, NewSession, NewTab};
    use crate::session_ops::{
        create_session_entry, delete_workspace_entries, new_tab_entry, notify_workspace_deleted,
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
        let project = super::add_project(dir.path().to_string_lossy().into_owned()).unwrap();
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
        assert_eq!(super::add_project(format!("{}/", project.path)).unwrap().path, project.path);
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
            assert!(super::add_project(target.to_string_lossy().into_owned()).is_err());
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

        let removed = delete_workspace_entries(
            project.to_str().unwrap(),
            worktree.to_str().unwrap(),
            true,
        )
        .unwrap();

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

        let moved = delete_workspace_entries(
            project.to_str().unwrap(),
            worktree.to_str().unwrap(),
            true,
        )
        .unwrap();

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
            project_path: "/repo".into(),
            cwd: "/repo/.raccoon/worktrees/gone".into(),
            worktree_name: Some("gone".into()),
            branch: Some("feature/gone".into()),
            base_ref: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: None,
            automation: None,
            title: "Removed".into(),
            created: "now".into(),
            modified: "now".into(),
            archived: false,
            pinned: false,
            tabs: Vec::new(),
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
pub fn update_project(path: String, patch: projects::ProjectPatch) -> CmdResult<Project> {
    projects::update(&path, patch).map_err(err)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRename {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub sessions: Vec<SessionEntry>,
}

fn rename_workspace_entries(project_path: &str, path: &str, requested: &str) -> CmdResult<WorkspaceRename> {
    let project = projects::canonical(project_path).map_err(err)?;
    let target = std::fs::canonicalize(path).map_err(err)?;
    let old_name = target
        .file_name()
        .and_then(|part| part.to_str())
        .ok_or_else(|| "Workspace has no usable name.".to_string())?
        .to_string();
    let name = available_worktree_name(Path::new(&project), Some(requested), Some(&old_name))?;
    let renamed = git::rename_worktree(Path::new(&project), &target, &name).map_err(err)?;
    let new_path = renamed.path.clone();
    let new_branch = renamed.branch.clone();
    let update = index::update(|sessions| {
        let mut affected = Vec::new();
        for session in sessions {
            // The old folder no longer exists after `git worktree move`, so
            // compare its canonical path lexically instead of canonicalising
            // the session cwd after the move.
            let matches = Path::new(&session.cwd) == target || session.cwd == path;
            if matches {
                session.cwd = new_path.clone();
                session.worktree_name = Some(name.clone());
                session.branch = Some(new_branch.clone());
                session.modified = index::now();
                affected.push(session.clone());
            }
        }
        Ok(affected)
    });
    match update {
        Ok(sessions) => Ok(WorkspaceRename { name, path: renamed.path, branch: renamed.branch, sessions }),
        Err(save_error) => {
            let rollback = git::rename_worktree(Path::new(&project), Path::new(&renamed.path), &old_name);
            match rollback {
                Ok(_) => Err(err(save_error)),
                Err(rollback_error) => Err(format!(
                    "Workspace was renamed but its session metadata could not be saved ({save_error:#}); rollback also failed ({rollback_error:#})."
                )),
            }
        }
    }
}

/// Rename a managed workspace's folder and matching `raccoon/<name>` branch,
/// then retarget every session that shares it.
#[tauri::command]
pub async fn rename_workspace(app: AppHandle, project_path: String, path: String, name: String) -> CmdResult<WorkspaceRename> {
    tauri::async_runtime::spawn_blocking(move || {
        let renamed = rename_workspace_entries(&project_path, &path, &name)?;
        for session in &renamed.sessions {
            let _ = app.emit("session_updated", session);
        }
        Ok(renamed)
    })
    .await
    .map_err(err)?
}

/// What deleting a workspace would cost: the git state of its tree plus how
/// many sessions (and transcripts) would go with it.
#[tauri::command]
pub async fn workspace_disposition(project_path: String, path: String) -> CmdResult<crate::workspaces::WorkspaceDisposition> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut disposition = crate::workspaces::disposition(Path::new(&project_path), Path::new(&path));
        disposition.sessions = sessions_in_workspace(Path::new(&path))?.len();
        Ok(disposition)
    })
    .await
    .map_err(err)?
}

fn mark_workspace_sessions_removed(project_path: &str, affected: &[SessionEntry]) -> CmdResult<Vec<SessionEntry>> {
    let project = std::fs::canonicalize(project_path).unwrap_or_else(|_| PathBuf::from(project_path));
    let affected_ids: std::collections::HashSet<_> = affected.iter().map(|session| session.id.clone()).collect();
    let branch = git::current_branch(&project);
    index::update(|sessions| {
        let mut moved = Vec::new();
        for session in sessions {
            if affected_ids.contains(&session.id) {
                index::mark_workspace_removed(session, branch.clone());
                session.modified = index::now();
                moved.push(session.clone());
            }
        }
        Ok(moved)
    })
    .map_err(err)
}

/// Remove a worktree and, with it, the sessions that lived there.
#[tauri::command]
pub async fn delete_workspace(app: AppHandle, project_path: String, path: String, delete_branch: bool) -> CmdResult<Vec<SessionEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let affected = sessions_in_workspace(Path::new(&path))?;
        for s in &affected {
            for t in &s.tabs {
                kill_tab(&state, &s.id, &t.id);
            }
        }
        state.browser.forget_workspace(&crate::browser::control::canonical(&path));
        let removed = delete_workspace_entries(&project_path, &path, delete_branch)?;
        notify_workspace_deleted(&app, &project_path, &removed);
        Ok(removed)
    })
    .await
    .map_err(err)?
}
