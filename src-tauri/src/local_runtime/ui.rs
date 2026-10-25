//! Window connection state and preferences. Unavailable transport is a separate
//! state, never an empty list of agents or an instruction to recover their turns.

use std::sync::Arc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::desktop::Desktop;
use crate::{AppState, store::settings::{self, QuitBehavior}};

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnectionState {
    Connected { epoch: String, running_agents: usize, terminals: usize },
    Unavailable { message: String },
}

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

pub(crate) fn connect(app: &AppHandle) -> anyhow::Result<Arc<Desktop>> {
    let state = app.state::<AppState>();
    let source = app.path().resource_dir()?.join("local-runtime/terminalx-serve");
    let home = crate::store::root()?;
    let client = super::launch::connect_desktop(&source,&home,&app.config().identifier)?;
    let next = Arc::new(Desktop::connect(client,Arc::new(app.clone()))?);
    let endpoint = state.window_endpoint.get().ok_or_else(|| anyhow::anyhow!("The private desktop endpoint is not ready."))?.clone();
    next.activate_window(endpoint, |next| {
        let mut current = state.runtime.lock().unwrap();
        anyhow::ensure!(current.is_none(), "The desktop connection changed while attaching.");
        state.pairing.attach_runtime(next.clone());
        *current = Some(next.clone());
        Ok(())
    })?;
    Ok(next)
}

fn connected(runtime: &Desktop) -> anyhow::Result<ConnectionState> {
    let running_agents = runtime.sessions()?.running_tabs()?.len();
    let terminals = runtime.terminals()?.shells()?.iter().filter(|shell| !shell.exited).count();
    let epoch = runtime.attachment()?.epoch;
    Ok(ConnectionState::Connected { epoch, running_agents, terminals })
}

#[tauri::command]
pub async fn local_runtime_status(state: State<'_, AppState>) -> Result<ConnectionState, String> {
    let Some(runtime) = state.runtime() else { return Ok(ConnectionState::Unavailable { message: state.runtime_error.lock().unwrap().clone() }) };
    tauri::async_runtime::spawn_blocking(move || connected(&runtime).unwrap_or_else(|error| ConnectionState::Unavailable { message: format!("{error:#}") }))
        .await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn local_runtime_reconnect(app: AppHandle) -> Result<ConnectionState, String> {
    static RECONNECT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _reconnect = RECONNECT.lock().await;
    let previous = app.state::<AppState>().runtime();
    let Some(previous) = previous else {
        return tauri::async_runtime::spawn_blocking(move || {
            let next = connect(&app).map_err(|error| {
                let message = format!("{error:#}");
                *app.state::<AppState>().runtime_error.lock().unwrap() = message.clone();
                message
            })?;
            let result = connected(&next).map_err(|error| format!("{error:#}"))?;
            let _ = app.emit("local_runtime_reattached", ());
            Ok(result)
        }).await.map_err(|error| error.to_string())?;
    };
    if !app.state::<AppState>().runtime().as_ref().is_some_and(|current| Arc::ptr_eq(current, &previous)) {
        return Err("The desktop connection changed while reconnecting. Try again.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let next = Arc::new(previous.reconnect().map_err(|error| format!("Could not reconnect to the running owner: {error:#}. Reopen TerminalX if it has stopped."))?);
        let status = connected(&next).map_err(|error| format!("{error:#}"))?;
        let state = app.state::<AppState>();
        let endpoint = state.window_endpoint.get().ok_or("The private desktop endpoint is not ready.")?.clone();
        next.activate_window(endpoint, |next| {
            let mut current = state.runtime.lock().unwrap();
            anyhow::ensure!(current.as_ref().is_some_and(|current| Arc::ptr_eq(current, &previous)),
                "The desktop connection changed while reconnecting. Try again.");
            state.pairing.attach_runtime(next.clone());
            *current = Some(next.clone());
            Ok(())
        }).map_err(|error| format!("Could not activate window services: {error:#}"))?;
        let _ = app.emit("local_runtime_reattached", ());
        Ok(status)
    }).await.map_err(|error| error.to_string())?
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
