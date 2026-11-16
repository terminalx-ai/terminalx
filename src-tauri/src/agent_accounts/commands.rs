//! Settings → Agents: agent accounts (#980).
//!
//! A local desktop capability, never a remote RPC. Every command may reach
//! the Keychain or run an agent's CLI, so each is `async` and does its work
//! on a blocking thread. No token ever comes back: what returns is ids,
//! labels, kinds, addresses and plans, and a Codex device code while its
//! dialog is open.

use serde::Serialize;
use zeroize::Zeroizing;

use super::{login, AgentAccounts, Finished};

type CmdResult<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(run: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|_| "The agent accounts could not be changed.".to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn agent_accounts_list(harness: String) -> CmdResult<AgentAccounts> {
    blocking(move || super::list(&harness)).await
}

/// Begin "Add account": the agent's own sign-in into a new directory.
#[tauri::command]
pub async fn agent_accounts_add_start(harness: String) -> CmdResult<login::Started> {
    blocking(move || super::add_start(&harness)).await
}

/// Where an open sign-in is; once it ended, the account it became.
#[tauri::command]
pub async fn agent_accounts_add_finish(attempt_id: String) -> CmdResult<Finished> {
    blocking(move || super::add_finish(&attempt_id)).await
}

#[tauri::command]
pub async fn agent_accounts_add_cancel(attempt_id: String) -> CmdResult<()> {
    blocking(move || super::add_cancel(&attempt_id)).await
}

/// Open an open sign-in's page again: the one the CLI gave, checked here.
#[tauri::command]
pub async fn agent_accounts_open_page(app: tauri::AppHandle, attempt_id: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let page = blocking(move || login::page_of(&attempt_id)).await?;
    app.opener().open_url(&page, None::<&str>).map_err(|_| "The page could not be opened.".to_string())
}

/// Save another API key as an account of its own.
#[tauri::command]
pub async fn agent_accounts_add_key(harness: String, key: String, label: Option<String>) -> CmdResult<AgentAccounts> {
    let key = Zeroizing::new(key);
    blocking(move || super::add_key(&harness, &key, label.as_deref())).await
}

#[tauri::command]
pub async fn agent_accounts_relabel(harness: String, account_id: String, label: String) -> CmdResult<AgentAccounts> {
    blocking(move || super::relabel(&harness, &account_id, &label)).await
}

/// Sign one account in again, in its own directory only.
#[tauri::command]
pub async fn agent_accounts_sign_in_again(harness: String, account_id: String) -> CmdResult<login::Started> {
    blocking(move || super::sign_in_again(&harness, &account_id)).await
}

/// What removing an account did: with tabs still running on it and no
/// `confirmed`, nothing, and which tabs those are.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub removed: bool,
    pub running_tabs: Vec<crate::agent_keys::RunningTab>,
    pub accounts: AgentAccounts,
}

/// Remove an account: first the running tabs that use it are named, and
/// only once that is `confirmed` does the agent's own logout run and its
/// directory and Keychain entry go.
#[tauri::command]
pub async fn agent_accounts_remove(state: tauri::State<'_, crate::AppState>, harness: String, account_id: String, confirmed: bool) -> CmdResult<Removal> {
    let runtime = state.runtime();
    blocking(move || {
        let running_tabs: Vec<crate::agent_keys::RunningTab> = match runtime {
            Some(runtime) => serde_json::from_value(runtime.terminals()?.agent_login_tabs(&harness)?).unwrap_or_default(),
            None => Vec::new(),
        };
        let running_tabs: Vec<_> = running_tabs.into_iter().filter(|tab| tab.account.as_deref() == Some(account_id.as_str())).collect();
        if !running_tabs.is_empty() && !confirmed {
            return Ok(Removal { removed: false, running_tabs, accounts: super::list(&harness)? });
        }
        let accounts = super::remove(&harness, &account_id)?;
        Ok(Removal { removed: true, running_tabs, accounts })
    })
    .await
}

/// The default account of an agent, or with `project_id` of one project
/// (local only). `account_id` `None` with a project: follow the agent's.
#[tauri::command]
pub async fn agent_accounts_set_default(harness: String, account_id: Option<String>, project_id: Option<String>) -> CmdResult<AgentAccounts> {
    blocking(move || super::set_default(&harness, account_id.as_deref(), project_id.as_deref())).await
}

/// Switch accounts automatically (#981): the agent's setting as Settings sent it.
#[tauri::command]
pub async fn agent_accounts_set_auto_switch(harness: String, setting: super::auto_switch::Setting) -> CmdResult<AgentAccounts> {
    blocking(move || super::set_auto_switch(&harness, setting)).await
}

/// "Never switch accounts in this project" (#981), on or off.
#[tauri::command]
pub async fn agent_accounts_set_never_switch(harness: String, project_id: String, never: bool) -> CmdResult<AgentAccounts> {
    blocking(move || super::set_never_switch(&harness, &project_id, never)).await
}

/// The automatic switches of the last 30 days, newest first (#981).
#[tauri::command]
pub async fn agent_accounts_switch_log() -> CmdResult<Vec<super::auto_switch::LogEntry>> {
    blocking(move || super::auto_switch::read_log(chrono::Utc::now().timestamp_millis())).await
}

/// The account a new session of `harness` starts on when automatic
/// switching moves it off `account_id` (#981), and why; `None` otherwise.
#[tauri::command]
pub async fn agent_accounts_launch_choice(state: tauri::State<'_, crate::AppState>, harness: String, project_id: Option<String>, account_id: Option<String>) -> CmdResult<Option<crate::session::account_switch::LaunchChoice>> {
    let sessions = state.sessions();
    blocking(move || match sessions {
        Ok(sessions) => sessions.launch_account_choice(&harness, project_id.as_deref(), account_id.as_deref()),
        // No runtime yet: nothing chooses another account.
        Err(_) => Ok(None),
    })
    .await
}

/// One account's login state, from the agent's own status in its directory.
#[tauri::command]
pub async fn agent_accounts_readiness(harness: String, account_id: String) -> CmdResult<crate::harness::readiness::Readiness> {
    blocking(move || super::readiness(&harness, &account_id)).await
}

#[cfg(test)]
mod tests {
    /// A synchronous Tauri command runs on the main thread, and these reach
    /// the Keychain or run a CLI: each must be `async` and work on a blocking thread.
    #[test]
    fn no_agent_accounts_command_runs_on_the_main_thread() {
        let file = include_str!("commands.rs");
        let source = &file[..file.find("#[cfg(test)]").unwrap()];
        let commands = source.matches("#[tauri::command]").count();
        assert_eq!(commands, 15);
        assert_eq!(source.matches("#[tauri::command]\npub async fn agent_accounts_").count(), commands);
        assert_eq!(source.matches("blocking(move ||").count(), commands);
    }
}
