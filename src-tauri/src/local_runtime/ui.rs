//! Window connection state and preferences. Unavailable transport is a separate
//! state, never an empty list of agents or an instruction to recover their turns.

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub use super::supervisor::ConnectionState;
use crate::{AppState, store::settings::{self, QuitBehavior}};

/// Presentation-only observer installed once per window process. Scheduling and
/// activity accounting remain in the owner; reopening does not replay usage.
pub(crate) fn observe(app: &AppHandle) {
    use crate::sink::EventSink;
    let observed = app.clone();
    EventSink::listen(app,"agent_event",Box::new(move |payload| {
        if let Ok(event) = serde_json::from_str::<crate::events::AgentEvent>(payload) {
            observed.state::<AppState>().star_nag.observe(&observed,&event);
        }
    }));
    let observed = app.clone();
    EventSink::listen(app,"agent_work_started",Box::new(move |payload| {
        if let Ok(total) = serde_json::from_str::<u64>(payload) {
            observed.state::<AppState>().star_nag.work_started(&observed,total);
        }
    }));
    let observed = app.clone();
    EventSink::listen(app,"tab_status",Box::new(move |payload| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else { return };
        let (Some(session),Some(tab)) = (value["sessionId"].as_str(),value["tabId"].as_str()) else { return };
        if let Ok(status) = serde_json::from_value(value["status"].clone()) {
            observed.state::<AppState>().star_nag.status(&observed,format!("{session}/{tab}"),status);
        }
    }));
}

fn status(app: &AppHandle, window: &str) -> ConnectionState {
    let state = app.state::<AppState>();
    let runtime = state.runtime();
    let unattached = state.runtime_error.lock().unwrap().clone();
    state.runtime_supervisor.status(window, runtime.as_deref(), &unattached)
}

/// Off the main thread: reading an attachment can wait on a socket write.
#[tauri::command]
pub async fn local_runtime_status(app: AppHandle, window: tauri::WebviewWindow) -> Result<ConnectionState, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app, window.label())).await.map_err(|error| error.to_string())
}

/// "Try again": attempt now whatever the supervisor is re-establishing. It
/// never reloads a window and never replays a request.
#[tauri::command]
pub async fn local_runtime_reconnect(app: AppHandle, window: tauri::WebviewWindow) -> Result<ConnectionState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().runtime_supervisor.retry_now();
        status(&app, window.label())
    }).await.map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings { quit_behavior: Option<QuitBehavior> }

#[tauri::command]
pub fn local_runtime_settings() -> RuntimeSettings {
    RuntimeSettings { quit_behavior: settings::load().quit_behavior }
}

#[tauri::command]
pub fn set_local_runtime_quit_behavior(quit_behavior: QuitBehavior) -> Result<RuntimeSettings, String> {
    let mut settings = settings::load();
    settings.quit_behavior = Some(quit_behavior);
    settings::save(&settings).map_err(|error| format!("{error:#}"))?;
    Ok(RuntimeSettings { quit_behavior: settings.quit_behavior })
}
