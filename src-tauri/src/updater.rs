//! The app updater is a native network operation. Its plugin transport does
//! not use our HTTP agent, so admission spans the entire bounded transfer.
use std::sync::Mutex;
use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

struct Found { id: String, update: tauri_plugin_updater::Update, privacy: crate::data_privacy::Ticket }
static FOUND: Mutex<Option<Found>> = Mutex::new(None);

#[derive(Serialize)]
pub struct Available { id: String, version: String }

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all_fields = "camelCase")]
pub enum DownloadEvent {
    Started { content_length: Option<u64> },
    Progress { chunk_length: usize },
    Finished,
}

#[tauri::command]
pub async fn app_update_check(app: tauri::AppHandle, channel: String) -> Result<Option<Available>, String> {
    let privacy = crate::data_privacy::Ticket::default();
    let result = async {
        anyhow::ensure!(matches!(channel.as_str(), "stable" | "beta"), "Unknown update channel");
        let updater = app.updater_builder().header("X-Raccoon-Channel", channel.as_str())?
            .timeout(crate::data_privacy::TRANSFER_TIMEOUT).build()?;
        let update = crate::data_privacy::transfer(&privacy, async { Ok(updater.check().await?) }).await?;
        let mut found = FOUND.lock().unwrap();
        *found = update.map(|update| Found { id: uuid::Uuid::new_v4().to_string(), update, privacy });
        Ok::<_, anyhow::Error>(found.as_ref().map(|found| Available { id: found.id.clone(), version: found.update.version.clone() }))
    }.await;
    result.map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn app_update_install(id: String, progress: tauri::ipc::Channel<DownloadEvent>) -> Result<(), String> {
    let result = async {
        let found = {
            let mut found = FOUND.lock().unwrap();
            anyhow::ensure!(found.as_ref().is_some_and(|found| found.id == id), "Check for updates again before installing");
            found.take().unwrap()
        };
        let finished = progress.clone();
        let mut began = false;
        let bytes = crate::data_privacy::transfer(&found.privacy, async {
            Ok(found.update.download(|chunk_length, content_length| {
                if !began { let _ = progress.send(DownloadEvent::Started { content_length }); began = true; }
                let _ = progress.send(DownloadEvent::Progress { chunk_length });
            }, || { let _ = finished.send(DownloadEvent::Finished); }).await?)
        }).await?;
        // A transfer that activation drained is discarded, never installed
        // or revived after privacy is turned back off.
        let _privacy = found.privacy.enter()?;
        found.update.install(bytes)?;
        Ok::<_, anyhow::Error>(())
    }.await;
    result.map_err(|error| format!("{error:#}"))
}
