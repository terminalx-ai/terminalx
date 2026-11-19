//! Settings → Agents: the program each agent runs as, each agent's own
//! settings file, and OpenCode's providers and models (PRO-157).
//!
//! Every path these open is worked out here from the agent's id; the webview
//! never names a file for them to open.

use std::path::PathBuf;

use serde::Serialize;

use crate::harness::opencode::manage::{self, Paths};

type CmdResult<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

// ------------------------------------------------------------------ executables

#[tauri::command]
pub async fn agent_executable(harness: String) -> CmdResult<crate::harness::executables::Executable> {
    blocking(move || crate::harness::executables::state(&harness)).await
}

/// Choose the program `harness` runs as, or go back to the PATH's with no
/// `path`. Checked with `--version` first; a refusal keeps the old choice.
/// New tabs read it as they start, so running ones keep what they run.
#[tauri::command]
pub async fn set_agent_executable(harness: String, path: Option<String>) -> CmdResult<crate::harness::executables::Executable> {
    blocking(move || crate::harness::executables::set(&harness, path.as_deref())).await
}

// ------------------------------------------------------------------ settings files

/// An agent's own settings file, as its row shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigFile {
    pub path: String,
    pub display_path: String,
    pub exists: bool,
}

/// Where each agent keeps its settings, and what a new one starts as.
fn config_file(harness: &str) -> CmdResult<(PathBuf, &'static str)> {
    let home = || dirs::home_dir().ok_or_else(|| "No home directory.".to_owned());
    Ok(match harness {
        "claude" => {
            let dir = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()).map(PathBuf::from).map_or_else(|| home().map(|home| home.join(".claude")), Ok)?;
            (dir.join("settings.json"), "{}\n")
        }
        "codex" => (crate::harness::codex::home::user_root().ok_or("No home directory.")?.join("config.toml"), ""),
        "opencode" => (Paths::user().ok_or("No home directory.")?.config_file(), "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n"),
        "cursor" => (home()?.join(".cursor").join("cli-config.json"), "{}\n"),
        other => return Err(format!("Unknown agent: {}", other.chars().take(40).collect::<String>())),
    })
}

fn display(path: &std::path::Path) -> String {
    match dirs::home_dir().and_then(|home| path.strip_prefix(&home).ok().map(std::path::Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

#[tauri::command]
pub fn agent_config_file(harness: String) -> CmdResult<AgentConfigFile> {
    let (path, _) = config_file(&harness)?;
    Ok(AgentConfigFile { display_path: display(&path), exists: path.is_file(), path: path.to_string_lossy().into_owned() })
}

/// Open an agent's settings file in its default app or one of the editors
/// Open in lists, making an empty one first so the editor has a file.
#[tauri::command]
pub async fn open_agent_config_file(app: tauri::AppHandle, harness: String, editor: Option<String>) -> CmdResult<()> {
    let program = crate::configuration_commands::editor_program(editor.as_deref())?;
    let path = blocking(move || {
        let (path, empty) = config_file(&harness)?;
        if !path.exists() {
            if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|error| format!("Couldn’t create {}: {error}", display(parent)))?; }
            std::fs::write(&path, empty).map_err(|error| format!("Couldn’t create {}: {error}", display(&path)))?;
        }
        Ok(path)
    }).await?;
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path.to_string_lossy(), program).map_err(|error| error.to_string())
}

/// Show an agent's settings file, or the program it runs as, in Finder.
#[tauri::command]
pub async fn reveal_agent_path(app: tauri::AppHandle, harness: String, what: String) -> CmdResult<()> {
    let path = blocking(move || match what.as_str() {
        "config" => {
            let (path, _) = config_file(&harness)?;
            Ok(if path.exists() { path } else { path.parent().map(std::path::Path::to_path_buf).ok_or("No folder.")? })
        }
        "executable" => crate::harness::executables::state(&harness)?.path.map(PathBuf::from).ok_or_else(|| format!("{} is not installed.", crate::harness::display_name(&harness))),
        _ => Err("Nothing to show.".into()),
    }).await?;
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(path).map_err(|error| error.to_string())
}

// ------------------------------------------------------------------ OpenCode

fn paths() -> CmdResult<Paths> {
    Paths::user().ok_or_else(|| "No home directory.".into())
}

/// OpenCode's providers, the models in its picker and the catalogue to add
/// from. `fetch`: download the catalogue when OpenCode has no copy yet.
#[tauri::command]
pub async fn opencode_overview(fetch: Option<bool>) -> CmdResult<manage::Overview> {
    blocking(move || Ok(manage::overview_in(&paths()?, fetch.unwrap_or(true)))).await
}

#[tauri::command]
pub async fn opencode_catalog_models(provider: String) -> CmdResult<Vec<manage::CatalogModel>> {
    blocking(move || manage::catalog_models(&paths()?, &provider)).await
}

/// Connect a provider after it accepted the key; new OpenCode tabs use it.
#[tauri::command]
pub async fn opencode_connect(provider: String, key: String, base_url: Option<String>) -> CmdResult<manage::ConnectResult> {
    blocking(move || manage::connect_in(&paths()?, &provider, &key, base_url.as_deref())).await
}

#[tauri::command]
pub async fn opencode_disconnect(provider: String) -> CmdResult<manage::Overview> {
    blocking(move || manage::disconnect_in(&paths()?, &provider)).await
}

#[tauri::command]
pub async fn opencode_add_model(provider: String, model: String) -> CmdResult<manage::Overview> {
    blocking(move || manage::add_model_in(&paths()?, &provider, &model)).await
}

#[tauri::command]
pub async fn opencode_remove_model(provider: String, model: String) -> CmdResult<manage::Overview> {
    blocking(move || manage::remove_model_in(&paths()?, &provider, &model)).await
}

/// Open the newest log OpenCode wrote, in the app that opens logs.
#[tauri::command]
pub async fn opencode_open_logs(app: tauri::AppHandle) -> CmdResult<()> {
    let log = blocking(|| manage::latest_log(&paths()?).ok_or_else(|| "OpenCode hasn’t written a log yet. Start an OpenCode tab, then look again.".into())).await?;
    use tauri_plugin_opener::OpenerExt;
    if log.is_dir() { app.opener().reveal_item_in_dir(log) } else { app.opener().open_path(log.to_string_lossy(), None::<&str>) }.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_agent_has_its_own_settings_file() {
        let home = dirs::home_dir().unwrap();
        if std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
            assert_eq!(config_file("claude").unwrap(), (home.join(".claude/settings.json"), "{}\n"));
        }
        if std::env::var_os("CODEX_HOME").is_none() {
            assert_eq!(config_file("codex").unwrap().0, home.join(".codex/config.toml"));
        }
        assert!(config_file("opencode").unwrap().0.ends_with("opencode/opencode.json") || config_file("opencode").unwrap().0.ends_with("opencode/opencode.jsonc"));
        assert!(config_file("../etc").is_err());
        assert_eq!(display(&home.join(".codex/config.toml")), "~/.codex/config.toml");
    }
}
