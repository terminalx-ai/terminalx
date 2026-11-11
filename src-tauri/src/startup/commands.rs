//! Local desktop only. Preview freezes the exact allowlisted bytes. Export
//! consumes that preview after the person selects a local destination.
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

struct Preview { at: Instant, content: String }
static PREVIEWS: OnceLock<Mutex<HashMap<String, Preview>>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview { id: String, content: String }

#[tauri::command]
pub async fn startup_diagnostics_status() -> Result<super::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(super::snapshot).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn startup_diagnostics_policy(policy: super::Policy) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || super::set_policy(policy)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn startup_diagnostics_probe() -> Result<super::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(super::start_probe).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn startup_diagnostics_preview() -> Result<ExportPreview, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let content = super::preview().map_err(|error| error.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut previews = PREVIEWS.get_or_init(Mutex::default).lock().unwrap();
        previews.retain(|_, preview| preview.at.elapsed() < Duration::from_secs(600));
        if previews.len() >= 8 { return Err("Close earlier previews and try again in ten minutes.".into()); }
        previews.insert(id.clone(), Preview { at: Instant::now(), content: content.clone() });
        Ok(ExportPreview { id, content })
    }).await.map_err(|error| error.to_string())?
}

fn save_preview(id: &str, path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(path.is_absolute() && path.extension().is_some_and(|extension| extension == "json"), "Choose an absolute .json destination.");
    let mut previews = PREVIEWS.get_or_init(Mutex::default).lock().unwrap();
    let preview = previews.get(id).filter(|preview| preview.at.elapsed() < Duration::from_secs(600)).ok_or_else(|| anyhow::anyhow!("Preview expired. Preview the report again before saving."))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    // Never replace a destination, or follow a symlink chosen after preview.
    let mut file = options.open(path)?;
    file.write_all(preview.content.as_bytes())?;
    file.sync_all()?;
    previews.remove(id);
    Ok(())
}

#[tauri::command]
pub async fn startup_diagnostics_export(preview_id: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_preview(&preview_id, Path::new(&path))).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_requires_a_live_preview_and_writes_exactly_those_bytes_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.json");
        assert!(save_preview("unknown", &path).is_err());
        let id = uuid::Uuid::new_v4().to_string();
        PREVIEWS.get_or_init(Mutex::default).lock().unwrap().insert(id.clone(), Preview { at: Instant::now(), content: "{\"reviewed\":true}".into() });
        save_preview(&id, &path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"reviewed\":true}");
        assert!(save_preview(&id, &directory.path().join("second.json")).is_err());
    }
}
