//! The nudge flash uses a separate, unprivileged static webview.
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "nudge-overlay";
const DISPLAY_TIME: Duration = Duration::from_secs(3);

fn show(app: &AppHandle, permitted: impl Fn() -> bool) -> Result<(), String> {
    if !permitted() || app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }

    let window =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("nudge-overlay.html".into()))
            .title("TerminalX nudge")
            .inner_size(960.0, 580.0)
            .center()
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .focusable(false)
            .focused(false)
            .skip_taskbar(true)
            .transparent(true)
            .visible(false)
            .build()
            .map_err(|error| error.to_string())?;
    // Fail closed if this platform cannot give the window click-through
    // behavior. Never expose an interactive window in its place.
    if let Err(error) = window.set_ignore_cursor_events(true) {
        let _ = window.destroy();
        return Err(error.to_string());
    }
    if !permitted() {
        let _ = window.destroy();
        return Ok(());
    }
    if let Err(error) = window.show() {
        let _ = window.destroy();
        return Err(error.to_string());
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DISPLAY_TIME).await;
        let _ = window.destroy();
    });
    Ok(())
}

#[tauri::command]
pub async fn nudge_overlay_show(
    app: AppHandle,
    org_id: String,
    context_revision: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use crate::account::{AccountManager, PHASE2_EVENTS, PHASE2_NUDGES};

        let Some(context) = account.context() else {
            return Ok(());
        };
        show(&app, || {
            AccountManager::context_revision(&context) == context_revision
                && account.inbox_member_is_current(&context, &org_id)
                && account.phase2_ready(PHASE2_EVENTS, Some(&org_id), Some(&context))
                && account.phase2_ready(PHASE2_NUDGES, Some(&org_id), Some(&context))
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
