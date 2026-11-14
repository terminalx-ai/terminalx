//! Settings → Agents: an agent's API key and which login it uses (PRO-306).
//!
//! A local desktop capability, never a remote RPC. Every command that may
//! reach the Keychain is `async` and does its work on a blocking thread
//! (`keychain.rs`). The key comes in once, on save, and never goes back out:
//! what returns is the masked form.
use zeroize::Zeroizing;

use crate::agent_keys::{self, Mode};

type CmdResult<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(run: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|_| "The agent login settings could not be changed.".to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn agent_login_status(harness: String) -> CmdResult<agent_keys::Status> {
    blocking(move || agent_keys::status(&harness)).await
}

#[tauri::command]
pub async fn agent_login_save_key(harness: String, key: String) -> CmdResult<agent_keys::Status> {
    let key = Zeroizing::new(key);
    blocking(move || agent_keys::save_key(&harness, key)).await
}

#[tauri::command]
pub async fn agent_login_remove_key(harness: String) -> CmdResult<agent_keys::Status> {
    blocking(move || agent_keys::remove_key(&harness)).await
}

#[tauri::command]
pub async fn agent_login_set_mode(harness: String, mode: Mode) -> CmdResult<agent_keys::Status> {
    blocking(move || agent_keys::set_mode(&harness, mode)).await
}

#[tauri::command]
pub async fn agent_login_set_base_url(harness: String, base_url: Option<String>) -> CmdResult<agent_keys::Status> {
    blocking(move || agent_keys::set_base_url(&harness, base_url)).await
}

/// Ask the provider whether the saved key works.
#[tauri::command]
pub async fn agent_login_verify(harness: String) -> CmdResult<agent_keys::Verified> {
    blocking(move || agent_keys::verify(&harness)).await
}

/// Whether the login shell has a key for this agent that may be offered.
#[tauri::command]
pub async fn agent_login_shell_offer(harness: String) -> CmdResult<Option<agent_keys::ShellOfferStatus>> {
    blocking(move || agent_keys::shell_offer(&harness)).await
}

/// Copy the login shell's key into the Keychain, as the person asked.
#[tauri::command]
pub async fn agent_login_import_shell(harness: String) -> CmdResult<agent_keys::Status> {
    blocking(move || agent_keys::import_shell(&harness)).await
}

#[tauri::command]
pub async fn agent_login_dismiss_shell(harness: String) -> CmdResult<()> {
    blocking(move || agent_keys::dismiss_shell(&harness)).await
}

/// The tabs whose agent is running, from the runtime that runs them.
#[tauri::command]
pub async fn agent_login_tabs(state: tauri::State<'_, crate::AppState>, harness: String) -> CmdResult<serde_json::Value> {
    let runtime = state.runtime().ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    blocking(move || runtime.terminals()?.agent_login_tabs(&harness)).await
}

#[cfg(test)]
mod tests {
    /// A synchronous Tauri command runs on the main thread, and these reach
    /// the Keychain: each must be `async` and work on a blocking thread.
    #[test]
    fn no_agent_login_command_runs_on_the_main_thread() {
        let file = include_str!("agent_login_commands.rs");
        let source = &file[..file.find("#[cfg(test)]").unwrap()];
        let commands = source.matches("#[tauri::command]").count();
        assert_eq!(commands, 10);
        assert_eq!(source.matches("#[tauri::command]\npub async fn agent_login_").count(), commands);
        assert_eq!(source.matches("blocking(move ||").count(), commands);
    }
}
