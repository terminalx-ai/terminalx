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
use crate::session_ops::{available_worktree_name, rename_workspace_entries, sessions_in_workspace};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

/// Stop whatever a tab is running: a headless child, or the terminal pane a
/// PTY-first tab's own CLI lives in.
/// How long a delete waits for a session's processes to exit before it
/// tries to remove their directory anyway.
const STOP_BEFORE_REMOVE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Stop everything the sessions run (agents, their shells and whatever those
/// started, such as a dev server) and wait for it to exit, so nothing still
/// holds the directory that is about to be removed.
fn stop_sessions_and_wait(state: &tauri::State<'_, crate::AppState>, sessions: &[SessionEntry]) {
    let mut panes = Vec::new();
    for session in sessions {
        for tab in &session.tabs {
            state.host.kill(&format!("{}/{}", session.id, tab.id));
        }
        let tabs: Vec<String> = session.tabs.iter().map(|tab| tab.id.clone()).collect();
        panes.extend(state.terminals.session_pane_ids(&session.id, &tabs));
    }
    state.terminals.kill_all_and_wait(&panes, STOP_BEFORE_REMOVE_WAIT);
}

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
    secure_prompt(
        "Provider connection",
        &format!("Enter the {} provider key for organization {}. The key is sent to the account service only for validation and secure storage.", provider.as_str(), organization_id),
        "Provider key",
    )
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
) -> Result<crate::cloud_workspaces::AgentLoginList, crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Read, |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.agent_logins())
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
    // Only Claude Code's sign-in can be lent without its refresh token.
    if source == AgentLoginSource::LocalLogin && provider != AgentLoginProvider::Claude {
        return Err(CloudWorkspaceClientError::local("cloud_workspace_request_invalid", false));
    }
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = GUARD.try_lock().map_err(|_| CloudWorkspaceClientError::local("cloud_provider_operation_in_progress", true))?;
    let service = state.cloud_workspaces.clone();
    let authorization = tauri::async_runtime::spawn_blocking(move || service.authorize_agent_login(provider, &consent))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))??;
    // The organization by name when it is the active one; its id otherwise, as the provider dialog shows it.
    // It is put into a native dialog: text from the account service, cleaned like any other.
    let organization = state
        .account
        .active_organization_name(authorization.organization_id())
        .map(|name| dialog_text(&name))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| authorization.organization_id().to_owned());
    let replaces = authorization.replaces();
    let unavailable = || CloudWorkspaceClientError::local("cloud_provider_secure_input_unavailable", false);
    let (kind, secret, identity) = match source {
        AgentLoginSource::ApiKey => {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let title = format!("{} API key", agent_label(provider));
            let text = format!(
                "Enter the {} API key for organization {}. It is sent to the account service only for validation and encrypted storage, and is not shown again.",
                agent_label(provider),
                organization
            );
            app.run_on_main_thread(move || {
                let _ = sender.send(secure_prompt(&title, &text, "API key"));
            })
            .map_err(|_| unavailable())?;
            let entered = tauri::async_runtime::spawn_blocking(move || receiver.recv()).await.map_err(|_| unavailable())?.map_err(|_| unavailable())?;
            (AgentLoginKind::ApiKey, entered.map_err(ProviderPromptError::client_error)?, None)
        }
        AgentLoginSource::LocalLogin => {
            let read = tauri::async_runtime::spawn_blocking(crate::agent_local_login::claude)
                .await
                .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))?;
            let login = read.map_err(|error| CloudWorkspaceClientError::local(error.code(), false))?;
            // The confirmation that counts. What the webview says the person agreed to is only a
            // request: this dialog is drawn by the app itself, names the organization and the
            // account, and nothing is uploaded unless its own button is pressed. Every time.
            let expires = local_time(login.expires_at_ms);
            let account = login.account.clone().unwrap_or_else(|| "the Claude Code account signed in on this Mac (its name is not recorded here)".into());
            let text = local_login_confirmation(&organization, &account, &expires, replaces);
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            app.run_on_main_thread(move || {
                let _ = sender.send(native_confirm("Lend this Mac's Claude Code sign-in?", &text, "Upload access token"));
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
            let identity = lent_identity(login.account.as_deref(), login.expires_at_ms);
            (AgentLoginKind::LoginDocument, login.secret, Some(identity))
        }
    };
    let service = state.cloud_workspaces.clone();
    tauri::async_runtime::spawn_blocking(move || service.save_agent_login(authorization, provider, kind, secret, identity.as_deref()))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Mutation))?
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
fn lent_identity(account: Option<&str>, expires_at_ms: i64) -> String {
    use chrono::TimeZone;
    let until = match chrono::Utc.timestamp_millis_opt(expires_at_ms) {
        chrono::LocalResult::Single(at) => at.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        _ => "an unknown time".into(),
    };
    format!("{} · lent until {until}", account.unwrap_or("Claude Code on a Mac"))
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
fn local_login_confirmation(organization: &str, account: &str, expires: &str, replaces: Option<crate::cloud_workspaces::AgentLoginKind>) -> String {
    use crate::cloud_workspaces::AgentLoginKind;
    let replacing = match replaces {
        Some(AgentLoginKind::ApiKey) => format!(
            "THIS REPLACES the API key now stored for Claude Code in {organization}. The key is removed; when the lent sign-in expires, Claude Code agents in every workspace of the organization stop until a login is connected again.\n\n"
        ),
        Some(AgentLoginKind::LoginDocument) => format!(
            "THIS REPLACES the login now stored for Claude Code in {organization}. When the lent sign-in expires, Claude Code agents in every workspace of the organization stop until a login is connected again.\n\n"
        ),
        None => String::new(),
    };
    format!(
        "Organization: {organization}\nAccount (as Claude Code on this Mac records it): {account}\n\n{replacing}\
         TerminalX will upload this sign-in's short-lived access token to the account service, for agents in the cloud workspaces of {organization}. \
         The refresh token stays on this Mac, so this Mac's sign-in keeps working and the uploaded token cannot be renewed: it stops working on {expires}.\n\n\
         Until then, agents in every member's workspaces of this organization may run on your Claude subscription, \
         and anyone who can drive one of those workspaces can read the token off its machine.\n\n\
         To end it sooner, disconnect it in Settings (the service refuses while a workspace still uses the login)."
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
/// the active organization, the owner-or-admin check and the explicit choice
/// to replace a stored login all come first, as for any other way to connect.
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
    use crate::cloud_workspaces::{AgentLoginProvider, CloudWorkspaceClientError, RequestRisk};
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = GUARD.try_lock().map_err(|_| CloudWorkspaceClientError::local("cloud_provider_operation_in_progress", true))?;
    let service = state.cloud_workspaces.clone();
    let authorization = tauri::async_runtime::spawn_blocking(move || service.authorize_agent_login(AgentLoginProvider::Claude, &consent))
        .await
        .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))??;
    let organization = state
        .account
        .active_organization_name(authorization.organization_id())
        .map(|name| dialog_text(&name))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| authorization.organization_id().to_owned());
    let unavailable = || CloudWorkspaceClientError::local("cloud_provider_secure_input_unavailable", false);
    let text = format!(
        "Paste the code the Claude page showed after you approved. It finishes the sign-in for organization {organization}: the account service keeps the login, renews it, and agents in every member's cloud workspaces of the organization may run on it."
    );
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
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.cancel_claude_login(&attempt_id, context_revision))
}

#[tauri::command]
pub async fn cloud_agent_login_remove(
    provider: crate::cloud_workspaces::AgentLoginProvider,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), crate::cloud_workspaces::CloudWorkspaceClientError> {
    cloud_command!(state, crate::cloud_workspaces::RequestRisk::Mutation, move |service: std::sync::Arc<crate::cloud_workspaces::CloudWorkspaceService>| service.remove_agent_login(provider, context_revision))
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

/// The sessions a workspace removal deleted or moved, and what became of
/// its branch.
#[derive(Debug, Clone, serde::Serialize)]
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
        let stop = |session: &SessionEntry| stop_sessions_and_wait(&state, std::slice::from_ref(session));
        crate::session_ops::delete_session_blocking(&app, &session_id, &stop).map(|_| ())
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
        let s = index::get(&session_id).map_err(err)?;
        if s.worktree_name.is_none() {
            return Err("session has no worktree".to_string());
        }
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
            worktree_base: None,
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
pub async fn pty_write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    if !state.pairing.desktop_terminal_input_allowed(&id) {
        return Ok(());
    }
    // A paste can fill the PTY's input buffer while the program is busy
    // writing output. Never wait for it on the UI thread: that also prevents
    // the window's output acknowledgements and other panes' input arriving.
    state.terminals.write_async(&id, data.into_bytes()).await.map_err(err)
}

/// The window shows this pane: send it the pane's output as raw bytes, the
/// scrollback so far first. No base64, no JSON, and no other listener hears it.
/// `token` names this attachment in the acknowledgements and the detach that follow.
#[tauri::command]
pub fn pty_attach(state: State<'_, AppState>, id: String, token: String, channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) {
    state.terminals.attach(&id, &token, Box::new(move |bytes| channel.send(tauri::ipc::InvokeResponseBody::Raw(bytes.to_vec())).is_ok()));
}

/// The window has drawn `drawn` bytes of the pane's output since it attached (flow control).
#[tauri::command]
pub fn pty_ack(state: State<'_, AppState>, id: String, token: String, drawn: u64) {
    state.terminals.ack(&id, &token, drawn);
}

/// A freshly loaded window: whatever its previous page was shown is gone.
#[tauri::command]
pub fn pty_detach_all(state: State<'_, AppState>) {
    state.terminals.detach_all();
}

#[tauri::command]
pub fn pty_detach(state: State<'_, AppState>, id: String, token: String) {
    state.terminals.detach(&id, &token);
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
async fn cloud_control_question(app: tauri::AppHandle, title: String, message: String, ok_label: String) -> crate::cloud_control::Answer {
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
        use crate::cloud_workspaces::AgentLoginKind;
        let text = super::local_login_confirmation("Acme Robotics", "ada@example.com", "3 Oct 2026, 21:40", None);
        assert!(text.starts_with("Organization: Acme Robotics\nAccount (as Claude Code on this Mac records it): ada@example.com\n"));
        assert!(!text.contains("REPLACES") && !text.contains("sign out of Claude Code"));
        // Review of #293: replacing a stored login is said, in the dialog too.
        let replacing = super::local_login_confirmation("Acme Robotics", "ada@example.com", "3 Oct 2026, 21:40", Some(AgentLoginKind::ApiKey));
        assert!(replacing.contains("THIS REPLACES the API key now stored for Claude Code in Acme Robotics"));
        assert!(replacing.contains("agents in every workspace of the organization stop"));
        assert!(super::local_login_confirmation("Acme", "a@b.c", "x", Some(AgentLoginKind::LoginDocument)).contains("THIS REPLACES the login now stored"));
        // The expiry is stored as a UTC time, and dialog text is cleaned.
        assert_eq!(super::lent_identity(Some("ada@example.com"), 1_790_000_000_000), "ada@example.com · lent until 2026-09-21T14:13:20Z");
        assert_eq!(super::dialog_text(" Acme\u{202E}\n Robotics "), "Acme Robotics");
        assert!(text.contains("stops working on 3 Oct 2026, 21:40"));
        assert!(text.contains("The refresh token stays on this Mac"));
        assert!(text.contains("every member's workspaces"));
        assert!(text.contains("anyone who can drive one of those workspaces can read the token"));
        assert!(text.contains("the service refuses while a workspace still uses the login"));
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
            project_path: "/repo".into(),
            cwd: "/repo/.raccoon/worktrees/gone".into(),
            worktree_name: Some("gone".into()),
            branch: Some("feature/gone".into()),
            base_ref: None,
            worktree_base: None,
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

/// What earlier deletes left on disk: worktrees no session uses, agent data
/// for worktrees that are gone, and `raccoon/*` branches with no worktree.
/// Reads only, apart from fetching each project's default branch.
#[tauri::command]
pub async fn scan_leftovers() -> CmdResult<Vec<crate::cleanup::Leftover>> {
    tauri::async_runtime::spawn_blocking(|| crate::cleanup::scan().map_err(err)).await.map_err(err)?
}

/// Delete the leftovers the person confirmed. Each is checked again first;
/// anything in use, or not clean and merged, is left alone.
#[tauri::command]
pub async fn remove_leftovers(app: AppHandle, ids: Vec<String>) -> CmdResult<crate::cleanup::Removal> {
    tauri::async_runtime::spawn_blocking(move || {
        let removal = crate::cleanup::remove(&ids).map_err(err)?;
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

/// Run `f` with what the worktree clean-up reads about this machine: the
/// open projects, and what is running now (asked again at every check).
fn with_cleanup_host<R>(state: &crate::AppState, f: impl FnOnce(&crate::worktree_cleanup::Host<'_>) -> R) -> CmdResult<R> {
    let (all, _) = projects::list().map_err(err)?;
    let (open, archived): (Vec<Project>, Vec<Project>) = all.into_iter().partition(|project| !project.archived);
    // An archived project is not cleaned, and its folder is not removable either.
    let protected: Vec<std::path::PathBuf> = archived.iter().map(|project| std::path::PathBuf::from(&project.path)).collect();
    let manager = state.manager();
    let running = |session: &str, tab: &str| manager.as_ref().is_some_and(|manager| manager.is_running(session, tab)) || state.host.is_live(&format!("{session}/{tab}"));
    let live = |sessions: &[SessionEntry]| crate::worktree_cleanup::Live::observe(&state.terminals, sessions, &running);
    Ok(f(&crate::worktree_cleanup::Host { projects: &open, protected: &protected, confine: None, live: &live, fetch: crate::landed::Fetch::Fresh }))
}

/// Every worktree of the open projects on this machine with whether the
/// clean-up may remove it, and why not. Reads only.
#[tauri::command]
pub async fn worktree_cleanup_scan(app: AppHandle, project_paths: Option<Vec<String>>) -> CmdResult<Vec<crate::worktree_cleanup::ProjectScan>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        with_cleanup_host(&state, |host| crate::worktree_cleanup::scan(host, project_paths.as_deref()).map_err(err))?
    })
    .await
    .map_err(err)?
}

/// What removing one worktree would free. `None` when `job` was cancelled.
#[tauri::command]
pub async fn worktree_cleanup_size(app: AppHandle, job: String, project_path: String, path: String) -> CmdResult<Option<u64>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        with_cleanup_host(&state, |host| crate::worktree_cleanup::estimate_size(host, crate::worktree_cleanup::SizeJobs::global(), &format!("local:{job}"), &project_path, &path).map_err(err))?
    })
    .await
    .map_err(err)?
}

/// Stop the size estimates whose job id starts with `prefix`.
#[tauri::command]
pub fn worktree_cleanup_cancel_sizes(prefix: String) {
    crate::worktree_cleanup::SizeJobs::global().cancel(&format!("local:{prefix}"));
}

/// Remove the worktrees the person confirmed. Each is checked again on the
/// spot; one that changed, is in use or is protected is left and reported.
#[tauri::command]
pub async fn worktree_cleanup_remove(app: AppHandle, items: Vec<crate::worktree_cleanup::RemoveItem>) -> CmdResult<Vec<crate::worktree_cleanup::ItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let results = with_cleanup_host(&state, |host| crate::worktree_cleanup::remove(host, &app, &items))?;
        for done in results.iter().filter(|done| matches!(done.outcome, crate::worktree_cleanup::Outcome::Removed | crate::worktree_cleanup::Outcome::AlreadyRemoved)) {
            state.browser.forget_workspace(&crate::browser::control::canonical(&done.path));
        }
        Ok(results)
    })
    .await
    .map_err(err)?
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

/// What deleting a workspace would cost: the git state of its tree plus how
/// many sessions (and transcripts) would go with it.
#[tauri::command]
pub async fn workspace_disposition(project_path: String, path: String, fetch: Option<bool>) -> CmdResult<crate::workspaces::WorkspaceDisposition> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut disposition = crate::workspaces::disposition(Path::new(&project_path), Path::new(&path));
        // The fetch is for the dialog that is about to delete the workspace,
        // which asks for it. Everything else that reads the disposition (the
        // pull request panel does so every 30 seconds) stays off the network
        // and gets no clean-and-merged verdict at all.
        // A folder that is not on disk gets a verdict too ("cannot be
        // checked"), so the dialog can ask about it rather than wave it through.
        if fetch == Some(true) && !disposition.is_main {
            disposition.landed = Some(crate::landed::check(Path::new(&project_path), Path::new(&path), crate::landed::Fetch::Fresh));
        }
        let sessions = sessions_in_workspace(Path::new(&path))?;
        disposition.sessions = sessions.len();
        disposition.session_ids = sessions.iter().map(|session| session.id.clone()).collect();
        disposition.session_titles = sessions.into_iter().map(|session| session.title).collect();
        Ok(disposition)
    })
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
pub async fn remove_workspace(
    app: AppHandle,
    project_path: String,
    path: String,
    keep_sessions: bool,
    delete_branch: bool,
    confirmed_digest: Option<String>,
    expected_sessions: Vec<String>,
) -> CmdResult<WorkspaceRemoveReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let browser_key = crate::browser::control::canonical(&path);
        // Deleting a directory git cannot remove is itself a risk the person
        // has to have confirmed.
        let direct = if confirmed_digest.is_some() { git::DirectDelete::Allowed } else { git::DirectDelete::Never };
        let request = crate::session_ops::WorkspaceRemoval {
            project_path: &project_path,
            path: &path,
            sessions: if keep_sessions { crate::session_ops::SessionsFate::Keep } else { crate::session_ops::SessionsFate::Delete },
            delete_branch,
            confirmation: confirmed_digest.map(crate::session_ops::Confirmation::Shown).unwrap_or(crate::session_ops::Confirmation::Single),
            expected_sessions: Some(&expected_sessions),
            direct,
            fetch: crate::landed::Fetch::Fresh,
        };
        let stop = |session: &SessionEntry| stop_sessions_and_wait(&state, std::slice::from_ref(session));
        let removed = crate::session_ops::remove_workspace(&app, &request, &stop)?;
        // Only once the workspace is really gone: a removal that fails keeps it.
        state.browser.forget_workspace(&browser_key);
        Ok(WorkspaceRemoveReport { sessions: removed.sessions, kept_branch: removed.removal.kept_branch, rescued_branch: removed.removal.rescued_branch })
    })
    .await
    .map_err(err)?
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
        let (diverged, diverged_total) = cloud_mirror(&organization_id, &workspace_id)?.check().map_err(err)?;
        Ok(CloudMirrorCheck { diverged, diverged_total })
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
