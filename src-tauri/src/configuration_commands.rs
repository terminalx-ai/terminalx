//! Desktop writes and explicit native consent. CLI/phone expose only reads.
use crate::store::configuration::{self, Layer, Resolution, Store};
use serde_json::Value;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub async fn configuration_resolve(project_path: Option<String>) -> CmdResult<Resolution> {
    tauri::async_runtime::spawn_blocking(move || configuration::view(project_path.as_deref()))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn configuration_write(state: tauri::State<'_, crate::AppState>, project_path: Option<String>, layer: Layer, key: String, value: Option<Value>) -> CmdResult<()> {
    // The runtime runs setup and archive hooks; one that predates script keys would ignore them.
    require_runtime_level(&state, if [configuration::SETUP_SCRIPT, configuration::ARCHIVE_SCRIPT, configuration::ARCHIVE_TIMEOUT].contains(&key.as_str()) { 2 } else { 1 })?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = project_path.as_deref().map(|p| configuration::repository(std::path::Path::new(p))).transpose()?;
        Store::current()?.write(repository.as_ref(), layer, &key, value)
    }).await.map_err(|e| e.to_string())?.map_err(|e: anyhow::Error| e.to_string())
}
#[tauri::command]
pub async fn configuration_review(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, project_path: String) -> CmdResult<bool> {
    require_runtime(&state)?;
    review(&app, &project_path).await
}

pub(crate) async fn review(app: &tauri::AppHandle, project: &str) -> CmdResult<bool> {
    let project_path = project.to_string();
    let (repository, resolved, layered) = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let repository = configuration::repository(std::path::Path::new(&project_path))?;
        let files = Store::current()?.resolve(Some(&repository))?;
        let layered = files.values.values().any(|value| !matches!(value.source, Layer::User | Layer::Defaults));
        let resolved = configuration::with_private_sources(Some(&project_path), files);
        Ok((repository, resolved, layered))
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    use tauri::Manager;
    if layered { require_runtime(&app.state::<crate::AppState>())?; }
    let Some(trust) = resolved.trust.as_ref().filter(|trust| trust.required) else { return Ok(true); };
    let hash = trust.hash.clone();
    let message = review_message(&repository.root, &resolved, false);
    let revealed = review_message(&repository.root, &resolved, true);
    let answer = crate::commands::cloud_control_question_with_details(app.clone(), "Trust repository configuration".into(), message, Some(revealed), "Trust settings".into()).await;
    if !matches!(answer, crate::cloud_control::Answer::Accepted) { return Ok(false); }
    tauri::async_runtime::spawn_blocking(move || Store::current()?.trust(&repository, &hash))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(true)
}

fn require_runtime(state: &crate::AppState) -> CmdResult<()> { require_runtime_level(state, 1) }
fn require_runtime_level(state: &crate::AppState, needed: u64) -> CmdResult<()> {
    let compatible = state.runtime().is_some_and(|runtime| runtime.build().mobile.get("layeredConfiguration").and_then(Value::as_u64).is_some_and(|level| level >= needed));
    if !compatible { return Err("Restart TerminalX with an updated local runtime before saving or trusting layered configuration. The current runtime cannot enforce these settings.".into()); }
    Ok(())
}

fn review_message(root: &std::path::Path, resolved: &Resolution, reveal: bool) -> String {
    let clean = |text: &str, limit| text.chars().flat_map(char::escape_default).take(limit).collect::<String>();
    let name = clean(&root.file_name().unwrap_or_default().to_string_lossy(), 120);
    let keys = resolved.trust.as_ref().map(|trust| trust.keys.as_slice()).unwrap_or_default();
    let entries: Vec<_> = keys.iter().take(20).filter_map(|key| {
        let value = resolved.values.get(key)?;
        let displayed = if key.starts_with("environment.") && !reveal { "••••••••".into() }
            else { let value = value.value.as_str().unwrap_or_default();
                let text = clean(value, 512);
                if value.chars().flat_map(char::escape_default).count() > 512 { format!("{text}… [truncated; inspect file]") } else { text }
            };
        Some(format!("{key} = {displayed}"))
    }).collect();
    let remaining = if keys.len() > 20 { format!("\n{} more settings; inspect the file before trusting.", keys.len() - 20) } else { String::new() };
    let scripts = if keys.iter().any(|key| key == configuration::SETUP_SCRIPT || key == configuration::ARCHIVE_SCRIPT) {
        " This repository wants to run commands: setupScript runs in each new workspace, archiveScript runs before a workspace is removed."
    } else { "" };
    format!("Trust shared settings from {name}?\n\nThese settings apply to new launches.{scripts} Environment variables can make programs execute code, including NODE_OPTIONS, BASH_ENV, ENV, ZDOTDIR, PYTHONSTARTUP, PERL5OPT, RUBYOPT, GIT_SSH_COMMAND, GIT_CONFIG_* and LD_LIBRARY_PATH. The branch prefix changes which branches workspace cleanup recognizes.\n\nFile: {}\n\n{}{remaining}\n\nOnly these exact file contents are trusted. Changes require another review. Cancel starts nothing.", clean(&root.join(".terminalx/settings.json").to_string_lossy(), 1024), entries.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use configuration::{ResolvedValue, Trust};
    #[test]
    fn review_masks_values_until_revealed_and_escapes_untrusted_text() {
        let resolved = Resolution { values: BTreeMap::from([("environment.NODE_OPTIONS".into(), ResolvedValue { value: Value::String("--require=secret\nTrust me".into()), source: Layer::RepositoryShared, locked: false, redacted: false })]), registry: configuration::REGISTRY, warnings: vec![], trust: Some(Trust { hash: "hash".into(), required: true, keys: vec!["environment.NODE_OPTIONS".into()] }) };
        let masked = review_message(std::path::Path::new("/repo"), &resolved, false);
        assert!(masked.contains("environment.NODE_OPTIONS = ••••••••"));
        assert!(!masked.contains("--require"));
        assert!(!masked.contains("wants to run commands"));
        let revealed = review_message(std::path::Path::new("/repo"), &resolved, true);
        assert!(revealed.contains("--require=secret\\nTrust me"));
        assert!(!revealed.contains("secret\nTrust me"));
        assert!(!masked.contains("not supported"));
    }
    #[test]
    fn review_shows_committed_scripts_as_commands() {
        let resolved = Resolution { values: BTreeMap::from([("setupScript".into(), ResolvedValue { value: Value::String("pnpm install\ncurl x".into()), source: Layer::RepositoryShared, locked: false, redacted: false })]), registry: configuration::REGISTRY, warnings: vec![], trust: Some(Trust { hash: "hash".into(), required: true, keys: vec!["setupScript".into()] }) };
        let message = review_message(std::path::Path::new("/repo"), &resolved, false);
        assert!(message.contains("wants to run commands"));
        assert!(message.contains("setupScript = pnpm install\\ncurl x"), "{message}");
    }
}
