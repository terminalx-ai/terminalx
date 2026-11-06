//! Environment editing is a local desktop capability, never a remote RPC.
use crate::store::environment;
type CmdResult<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|_| "Environment operation failed.".to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn environment_list(project_path: Option<String>) -> CmdResult<Vec<environment::Row>> {
    blocking(move || environment::list(project_path.as_deref())).await
}

#[tauri::command]
pub async fn environment_reveal(project_path: Option<String>, name: String) -> CmdResult<String> {
    blocking(move || environment::reveal(project_path.as_deref(), &name)).await
}

#[tauri::command]
pub async fn environment_save(
    project_path: Option<String>,
    inputs: Vec<environment::Input>,
    previous: Option<String>,
) -> CmdResult<()> {
    blocking(move || environment::save(project_path.as_deref(), inputs, previous.as_deref())).await
}

#[tauri::command]
pub async fn environment_delete(project_path: Option<String>, name: String) -> CmdResult<()> {
    blocking(move || environment::delete(project_path.as_deref(), &name)).await
}

#[tauri::command]
pub async fn environment_read_file(project_path: String, path: String) -> CmdResult<String> {
    blocking(move || environment::read_env_file(&project_path, &path)).await
}

#[tauri::command]
pub async fn environment_changed(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> CmdResult<bool> {
    let runtime = state
        .runtime()
        .ok_or_else(|| state.runtime_error.lock().unwrap().clone())?;
    blocking(move || runtime.terminals()?.environment_changed(&id)).await
}
