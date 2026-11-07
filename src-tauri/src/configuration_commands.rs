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
    require_runtime(&state)?;
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
    let (repository, trust, layered) = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let repository = configuration::repository(std::path::Path::new(&project_path))?;
        let resolution = Store::current()?.resolve(Some(&repository))?;
        let layered = resolution.values.values().any(|value| !matches!(value.source, Layer::User | Layer::Defaults));
        Ok((repository, resolution.trust, layered))
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    use tauri::Manager;
    if layered { require_runtime(&app.state::<crate::AppState>())?; }
    let Some(trust) = trust.filter(|trust| trust.required) else { return Ok(true); };
    let name = repository.root.file_name().unwrap_or_default().to_string_lossy();
    let name: String = name.chars().filter(|c| !c.is_control()).take(120).collect();
    let message = format!("This repository wants to run commands when a workspace is created. Trust {name}?\n\nShared environment variables can execute code through programs that read them. The shared branch prefix also changes which branches workspace cleanup recognizes.\n\nFile: {}\nSettings: {}\n\nOnly these exact file contents are trusted. Changes require another review. Cancel starts nothing. Setup and archive scripts are not supported by this version.", repository.root.join(".terminalx/settings.json").display(), trust.keys.iter().take(20).cloned().collect::<Vec<_>>().join(", "));
    let answer = crate::commands::cloud_control_question(app.clone(), "Trust repository configuration".into(), message, "Trust repository".into()).await;
    if !matches!(answer, crate::cloud_control::Answer::Accepted) { return Ok(false); }
    tauri::async_runtime::spawn_blocking(move || Store::current()?.trust(&repository, &trust.hash))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(true)
}

fn require_runtime(state: &crate::AppState) -> CmdResult<()> {
    let compatible = state.runtime().is_some_and(|runtime| runtime.build().mobile.get("layeredConfiguration").and_then(Value::as_u64).is_some_and(|level| level >= 1));
    if !compatible { return Err("Restart TerminalX with an updated local runtime before saving or trusting layered configuration. The current runtime cannot enforce these settings.".into()); }
    Ok(())
}
