//! The app updater is a native network operation. Its plugin transport does
//! not use our HTTP agent, so admission spans the entire bounded transfer.
use std::sync::Mutex;
use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

struct Found { id: String, update: tauri_plugin_updater::Update, privacy: crate::data_privacy::Ticket }
static FOUND: Mutex<Option<Found>> = Mutex::new(None);
/// An update downloaded and not yet installed: the window has a step to take
/// between the two on Windows, where installing ends this process.
static DOWNLOADED: Mutex<Option<(Found, Vec<u8>)>> = Mutex::new(None);

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
pub async fn app_update_check(app: tauri::AppHandle, window: tauri::WebviewWindow, channel: String) -> Result<Option<Available>, String> {
    crate::commands::require_main_window(&window)?;
    let privacy = crate::data_privacy::Ticket::default();
    let result = async {
        anyhow::ensure!(matches!(channel.as_str(), "stable" | "beta"), "Unknown update channel");
        let updater = app.updater_builder().header("X-Raccoon-Channel", channel.as_str())?
            .timeout(crate::data_privacy::TRANSFER_TIMEOUT).build()?;
        let update = crate::data_privacy::transfer(&privacy, async {
            match updater.check().await {
                Ok(update) => Ok(update),
                Err(error) if no_build_for_this_system(&error) => {
                    // The plugin says "no release" for any failed answer, not only a missing feed: kept visible in the log.
                    log::warn!("no update for this system in the feed: {error}");
                    Ok(None)
                }
                Err(error) => Err(error.into()),
            }
        }).await?;
        // A new check replaces whatever an earlier one found or downloaded.
        DOWNLOADED.lock().unwrap().take();
        let mut found = FOUND.lock().unwrap();
        *found = update.map(|update| Found { id: uuid::Uuid::new_v4().to_string(), update, privacy });
        Ok::<_, anyhow::Error>(found.as_ref().map(|found| Available { id: found.id.clone(), version: found.update.version.clone() }))
    }.await;
    result.map_err(|error| format!("{error:#}"))
}

/// Windows and Linux builds are published after the macOS one, and by a job of
/// their own: until then the feed has no entry for them, or no feed answers at
/// all. That is no update yet, not an error to show. On macOS it stays one.
fn no_build_for_this_system(error: &tauri_plugin_updater::Error) -> bool {
    !cfg!(target_os = "macos") && matches!(error, tauri_plugin_updater::Error::TargetsNotFound(_) | tauri_plugin_updater::Error::ReleaseNotFound)
}

/// Download the update found by [`app_update_check`]; [`app_update_apply`] installs it.
#[tauri::command]
pub async fn app_update_download(window: tauri::WebviewWindow, id: String, progress: tauri::ipc::Channel<DownloadEvent>) -> Result<(), String> {
    crate::commands::require_main_window(&window)?;
    let result = async {
        let found = {
            let mut found = FOUND.lock().unwrap();
            anyhow::ensure!(found.as_ref().is_some_and(|found| found.id == id), "Check for updates again before installing");
            found.take().unwrap()
        };
        DOWNLOADED.lock().unwrap().take();
        let finished = progress.clone();
        let mut began = false;
        let bytes = crate::data_privacy::transfer(&found.privacy, async {
            Ok(found.update.download(|chunk_length, content_length| {
                if !began { let _ = progress.send(DownloadEvent::Started { content_length }); began = true; }
                let _ = progress.send(DownloadEvent::Progress { chunk_length });
            }, || { let _ = finished.send(DownloadEvent::Finished); }).await?)
        }).await?;
        *DOWNLOADED.lock().unwrap() = Some((found, bytes));
        Ok::<_, anyhow::Error>(())
    }.await;
    result.map_err(|error| format!("{error:#}"))
}

/// Install the update [`app_update_download`] downloaded. On Windows the
/// installer takes over and this process exits before the call returns.
#[tauri::command]
pub async fn app_update_apply(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    crate::commands::require_main_window(&window)?;
    let result = async {
        let (found, bytes) = {
            let mut downloaded = DOWNLOADED.lock().unwrap();
            anyhow::ensure!(downloaded.as_ref().is_some_and(|(found, _)| found.id == id), "Check for updates again before installing");
            downloaded.take().unwrap()
        };
        // A transfer that activation drained is discarded, never installed
        // or revived after privacy is turned back off.
        let _privacy = found.privacy.enter()?;
        found.update.install(bytes)?;
        Ok::<_, anyhow::Error>(())
    }.await;
    result.map_err(|error| format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use tauri_plugin_updater::Error;

    #[test]
    fn a_feed_without_this_system_is_no_update_off_macos_and_an_error_on_it() {
        let missing = [Error::TargetsNotFound(vec!["windows-x86_64".into()]), Error::ReleaseNotFound];
        for error in &missing {
            assert_eq!(super::no_build_for_this_system(error), !cfg!(target_os = "macos"), "{error}");
        }
        assert!(!super::no_build_for_this_system(&Error::Network("refused".into())));
    }

    #[test]
    fn updater_main_window_guard_rejects_floating_and_chat_windows() {
        assert!(crate::commands::require_main_window_label("main").is_ok());
        assert!(crate::commands::require_main_window_label("floating").is_err());
        assert!(crate::commands::require_main_window_label("chat-1234").is_err());
        assert!(crate::commands::require_main_window_label("").is_err());
    }
}
