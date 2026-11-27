//! Settings › MCP's commands. Each one is refused unless an organization the
//! person belongs to reports `organization.mcp-servers.v1`; shared servers
//! also need it for their own organization.

use std::sync::Arc;

use crate::account::{AccountManager, PHASE2_MCP_SERVERS};
use crate::cloud_workspaces::{CloudWorkspaceClientError, CloudWorkspaceService, SharedMcpServerInput};

use super::{deps, probe, ImportScan, Imported, Input, Listing, Status};

type CmdResult<T> = Result<T, String>;

const UNAVAILABLE: &str = "mcp_servers_unavailable";

fn ready(account: &AccountManager) -> CmdResult<()> {
    if account.phase2_ready(PHASE2_MCP_SERVERS, None, None) { Ok(()) } else { Err(UNAVAILABLE.into()) }
}

fn cloud_error(error: CloudWorkspaceClientError) -> String {
    match error.code.as_str() {
        "mcp_server_name_taken" => "Your organization already shares a server with this name.".into(),
        "mcp_server_target_query" => "A shared URL can't carry a query string or fragment; put keys under Authentication.".into(),
        "mcp_server_invalid" => "Your organization would not take this server. Check its name and URL.".into(),
        "mcp_server_limit_reached" => "Your organization shares as many servers as it can.".into(),
        "mcp_server_not_found" => "Your organization no longer shares this server.".into(),
        "organization_admin_required" => "Only an organization owner or admin can change its shared servers.".into(),
        UNAVAILABLE => UNAVAILABLE.into(),
        _ => "Could not reach your organization. Try again.".into(),
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

fn text<T>(result: anyhow::Result<T>) -> CmdResult<T> {
    result.map_err(|error| error.to_string())
}

/// Each ready organization's shared servers, listed again; an organization no
/// longer ready (or left) is dropped. One that cannot be reached keeps what
/// this Mac had.
fn refresh_shared(account: &AccountManager, cloud: &CloudWorkspaceService) -> CmdResult<Listing> {
    let deps = text(deps())?;
    let ready = account.phase2_ready_orgs(PHASE2_MCP_SERVERS);
    for org in text(super::shared_orgs_in(&deps))? {
        if !ready.contains(&org) {
            text(super::set_shared_in(&deps, &org, None))?;
        }
    }
    for org in &ready {
        match cloud.mcp_servers(org) {
            Ok(list) => {
                text(super::set_shared_in(&deps, org, Some(list.servers)))?;
            }
            Err(error) if error.code == UNAVAILABLE => {
                text(super::set_shared_in(&deps, org, None))?;
            }
            Err(error) => log::info!("mcp: shared servers of an organization could not be listed: {}", error.code),
        }
    }
    text(super::list_in(&deps))
}

#[tauri::command]
pub async fn mcp_servers(state: tauri::State<'_, crate::AppState>) -> CmdResult<Listing> {
    let account = state.account.clone();
    let cloud = state.cloud_workspaces.clone();
    blocking(move || {
        ready(&account)?;
        refresh_shared(&account, &cloud)
    })
    .await
}

#[tauri::command]
pub async fn mcp_server_save(input: Input, state: tauri::State<'_, crate::AppState>) -> CmdResult<Listing> {
    let account = state.account.clone();
    let cloud = state.cloud_workspaces.clone();
    blocking(move || {
        ready(&account)?;
        let deps = text(deps())?;
        let mut input = input;
        if let (Some(org), None) = (input.organization.clone(), &input.key) {
            if !account.phase2_ready(PHASE2_MCP_SERVERS, Some(&org), None) {
                return Err(UNAVAILABLE.into());
            }
            text(super::validate(&input))?;
            let created = cloud
                .mcp_server_create(&org, SharedMcpServerInput {
                    name: input.name.clone(),
                    target: input.target.trim().to_string(),
                    auth_kind: input.auth,
                    header_names: input.header_names.clone(),
                    agents: input.agents,
                })
                .map_err(cloud_error)?;
            let listing = refresh_shared(&account, &cloud)?;
            // The admin's own token or header values for it, kept on this Mac.
            input.key = listing.servers.iter().find(|row| row.shared_by.as_deref() == Some(org.as_str()) && row.key.ends_with(&format!("/{}", created.id))).map(|row| row.key.clone());
            if input.key.is_none() {
                return Ok(listing);
            }
            input.organization = None;
            input.client_id = None;
        }
        text(super::save_in(&deps, input))
    })
    .await
}

#[tauri::command]
pub async fn mcp_server_remove(key: String, state: tauri::State<'_, crate::AppState>) -> CmdResult<Listing> {
    let account = state.account.clone();
    let cloud = state.cloud_workspaces.clone();
    blocking(move || {
        ready(&account)?;
        if key.starts_with("local/") {
            return text(super::remove_in(&text(deps())?, &key));
        }
        let (org, id) = key.split_once('/').ok_or("This server is no longer installed.")?;
        cloud.mcp_server_delete(org, id).map_err(cloud_error)?;
        refresh_shared(&account, &cloud)
    })
    .await
}

#[tauri::command]
pub async fn mcp_server_set_off(key: String, off: bool, state: tauri::State<'_, crate::AppState>) -> CmdResult<Listing> {
    let account = state.account.clone();
    blocking(move || {
        ready(&account)?;
        text(super::set_off_in(&text(deps())?, &key, off))
    })
    .await
}

#[tauri::command]
pub async fn mcp_server_check(key: String, state: tauri::State<'_, crate::AppState>) -> CmdResult<Status> {
    let account = state.account.clone();
    blocking(move || {
        ready(&account)?;
        text(super::check_in(&text(deps())?, &key, &probe::Ureq::new()))
    })
    .await
}

#[tauri::command]
pub async fn mcp_server_sign_in(key: String, app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>) -> CmdResult<Listing> {
    use tauri_plugin_opener::OpenerExt;
    let account = state.account.clone();
    blocking(move || {
        ready(&account)?;
        let open = |url: &str| -> anyhow::Result<()> {
            app.opener().open_url(url, None::<&str>).map_err(|_| anyhow::anyhow!("The browser could not be opened."))
        };
        text(super::sign_in_in(&text(deps())?, &key, &probe::Ureq::new(), &open))
    })
    .await
}

#[tauri::command]
pub async fn mcp_server_sign_out(key: String, state: tauri::State<'_, crate::AppState>) -> CmdResult<Listing> {
    let account = state.account.clone();
    blocking(move || {
        ready(&account)?;
        text(super::sign_out_in(&text(deps())?, &key))
    })
    .await
}

#[tauri::command]
pub async fn mcp_import_scan(state: tauri::State<'_, crate::AppState>) -> CmdResult<ImportScan> {
    let account = state.account.clone();
    blocking(move || {
        ready(&account)?;
        text(super::import_scan_in(&text(deps())?))
    })
    .await
}

#[tauri::command]
pub async fn mcp_import(agent: String, state: tauri::State<'_, crate::AppState>) -> CmdResult<Imported> {
    let account = state.account.clone();
    blocking(move || {
        ready(&account)?;
        let from_codex = match agent.as_str() {
            "codex" => true,
            "claudeCode" => false,
            _ => return Err("Unknown agent.".into()),
        };
        text(super::import_in(&text(deps())?, from_codex))
    })
    .await
}

/// Keeps shared servers and OAuth sign-ins current while the app runs, so a
/// member gets a newly shared server without opening Settings › MCP and a
/// sign-in does not run out between agent starts.
pub(crate) fn start_upkeep(account: Arc<AccountManager>, cloud: Arc<CloudWorkspaceService>) {
    let _ = std::thread::Builder::new().name("mcp-upkeep".into()).spawn(move || {
        // Give the account a moment to load before the first look.
        std::thread::sleep(std::time::Duration::from_secs(30));
        loop {
            let ready = account.phase2_ready(PHASE2_MCP_SERVERS, None, None);
            let has_shared = deps().ok().and_then(|deps| super::shared_orgs_in(&deps).ok()).is_some_and(|orgs| !orgs.is_empty());
            if ready || has_shared {
                if let Err(error) = refresh_shared(&account, &cloud) {
                    log::info!("mcp: upkeep could not refresh shared servers: {error}");
                }
            }
            if ready {
                if let Ok(deps) = deps() {
                    super::refresh_due_in(&deps, &probe::Ureq::new());
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(10 * 60));
        }
    });
}
