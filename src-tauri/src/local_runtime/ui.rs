//! Window connection state and preferences. Unavailable transport is a separate
//! state, never an empty list of agents or an instruction to recover their turns.

use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::client::unanswered;
use super::desktop::Desktop;
use crate::{AppState, store::settings::{self, QuitBehavior}};

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnectionState {
    Connected { epoch: String, running_agents: usize, terminals: usize },
    Unavailable { message: String },
    /// The runtime is there but does not answer. Reconnecting reaches the same
    /// wedged process; only restarting it recovers (#661). `epoch` names the
    /// attached runtime, if any, so a restart cannot stop its replacement.
    Unresponsive { message: String, epoch: Option<String> },
}

/// How often the watchdog asks the runtime whether it is answering.
const PROBE_EVERY: Duration = Duration::from_secs(5);
/// Failed probes in a row before a window says the runtime is not responding:
/// one slow answer is a busy runtime, not a wedged one.
const FAILED_PROBES: u32 = 2;

/// What the watchdog has found about the attached runtime, for every window.
#[derive(Default)]
pub struct Health(Mutex<Watch>);

#[derive(Default)]
struct Watch {
    /// The runtime the failures were counted against.
    epoch: Option<String>,
    failures: u32,
    unresponsive: Option<String>,
}

impl Health {
    pub(crate) fn unresponsive(&self) -> Option<String> {
        self.0.lock().unwrap().unresponsive.clone()
    }

    /// Count one probe of runtime `epoch`. True when that changes whether it is answering.
    fn probed(&self, epoch: &str, outcome: anyhow::Result<()>) -> bool {
        let mut watch = self.0.lock().unwrap();
        // Before any reset: windows showing the last runtime's finding are told
        // when its replacement is judged differently.
        let was = watch.unresponsive.is_some();
        if watch.epoch.as_deref() != Some(epoch) {
            *watch = Watch { epoch: Some(epoch.into()), ..Watch::default() };
        }
        match outcome {
            Ok(()) => {
                watch.failures = 0;
                watch.unresponsive = None;
            }
            Err(error) => {
                watch.failures += 1;
                if watch.failures >= FAILED_PROBES {
                    watch.unresponsive = Some(format!("{error:#}"));
                }
            }
        }
        was != watch.unresponsive.is_some()
    }

    /// Attaching failed. A runtime that took the connection and never
    /// answered, or turned it away as too busy, is not responding: only a
    /// restart reaches it. Any other failure is not this watch's to say.
    pub(crate) fn attach_failed(&self, error: &anyhow::Error) {
        *self.0.lock().unwrap() = Watch { unresponsive: unanswered(error).then(|| format!("{error:#}")), ..Watch::default() };
    }

    fn clear(&self) {
        *self.0.lock().unwrap() = Watch::default();
    }
}


fn failed(runtime: &Desktop, error: anyhow::Error) -> ConnectionState {
    let message = format!("{error:#}");
    if unanswered(&error) { ConnectionState::Unresponsive { message, epoch: Some(runtime.epoch().into()) } } else { ConnectionState::Unavailable { message } }
}

/// Ask the attached runtime, every few seconds, whether it still answers and
/// its loop still turns, and tell every window when that changes. A runtime
/// wedged behind one lock otherwise looks attached and healthy for good (#661).
pub(crate) fn watch(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("local-runtime-watchdog".into()).spawn(move || loop {
        std::thread::sleep(PROBE_EVERY);
        let state = app.state::<AppState>();
        let Some(runtime) = state.runtime() else { continue };
        let outcome = runtime.probe();
        if let Err(error) = &outcome { log::warn!("local runtime probe: {error:#}"); }
        if state.runtime_health.probed(runtime.epoch(), outcome) {
            let _ = app.emit("local_runtime_health", ());
        }
    });
    if let Err(error) = spawned { log::error!("start the local runtime watchdog: {error}"); }
}

/// Whether a window that found runtime `seen` not responding (none when it
/// found none attached) may restart the one `attached` now. A window that
/// asks after another has already replaced it must not stop the replacement.
fn restart_reaches(seen: Option<&str>, attached: &str) -> bool {
    seen == Some(attached)
}

/// One reconnect or restart at a time, for every window.
static RECONNECT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    let log = app.path().app_log_dir().ok().map(|dir| dir.join("runtime.log"));
    let client = super::launch::connect_desktop(&source,&home,&app.config().identifier,log.as_deref())?;
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
pub async fn local_runtime_status(window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<ConnectionState, String> {
    let unresponsive = state.runtime_health.unresponsive();
    let Some(runtime) = state.runtime() else {
        let message = state.runtime_error.lock().unwrap().clone();
        return Ok(if unresponsive.is_some() { ConnectionState::Unresponsive { message, epoch: None } } else { ConnectionState::Unavailable { message } });
    };
    // Asking again would only wait out the same timeout.
    if let Some(message) = unresponsive { return Ok(ConnectionState::Unresponsive { message, epoch: Some(runtime.epoch().into()) }); }
    tauri::async_runtime::spawn_blocking(move || {
        runtime.window_connection(window.label()).and_then(|()| connected(&runtime)).unwrap_or_else(|error| failed(&runtime, error))
    })
        .await.map_err(|error| error.to_string())
}

/// A failed attach: what every window is told, and what the watchdog knows.
fn attach_failed(app: &AppHandle, error: anyhow::Error) -> String {
    let message = format!("{error:#}");
    let state = app.state::<AppState>();
    *state.runtime_error.lock().unwrap() = message.clone();
    state.runtime_health.attach_failed(&error);
    message
}

#[tauri::command]
pub async fn local_runtime_reconnect(app: AppHandle, window: tauri::WebviewWindow) -> Result<ConnectionState, String> {
    let _reconnect = RECONNECT.lock().await;
    let previous = app.state::<AppState>().runtime();
    let Some(previous) = previous else {
        return tauri::async_runtime::spawn_blocking(move || {
            let next = connect(&app).map_err(|error| attach_failed(&app, error))?;
            let result = connected(&next).map_err(|error| format!("{error:#}"))?;
            let _ = app.emit("local_runtime_reattached", ());
            Ok(result)
        }).await.map_err(|error| error.to_string())?;
    };
    // A failed PTY reader must not revoke healthy windows or the owner lease.
    // The requesting page reloads to acquire fresh taps and replay snapshots.
    if previous.attachment().is_ok() {
        let label = window.label().to_owned();
        return tauri::async_runtime::spawn_blocking(move || {
            connected(&previous).map_err(|error| format!("{error:#}"))?;
            if previous.window_connection(&label).is_err() {
                // A newer shared failure must not be mistaken for a view-only
                // failure or return the earlier control snapshot as success.
                previous.attachment().map_err(|error| format!("{error:#}"))?;
                previous.detach_window(&label);
            }
            connected(&previous).map_err(|error| format!("{error:#}"))
        }).await.map_err(|error| error.to_string())?;
    }
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

/// Stop the runtime without asking it and start a fresh one (#661). Its
/// agents and terminals stop with it; each agent resumes its conversation
/// from the provider's transcript when its tab next starts. `epoch` is the
/// runtime the window found not responding (none when it never attached): a
/// window that asks after another has already restarted it stops nothing.
#[tauri::command]
pub async fn local_runtime_restart(app: AppHandle, epoch: Option<String>) -> Result<ConnectionState, String> {
    let _reconnect = RECONNECT.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Some(current) = state.runtime().filter(|current| !restart_reaches(epoch.as_deref(), current.epoch())) {
            return Ok(connected(&current).unwrap_or_else(|error| failed(&current, error)));
        }
        let home = crate::store::root().map_err(|error| format!("{error:#}"))?;
        super::launch::kill_owner(&home).map_err(|error| format!("Could not stop the TerminalX runtime: {error:#}"))?;
        // Nothing more is sent to the process that was stopped.
        *state.runtime_error.lock().unwrap() = "The TerminalX runtime is restarting.".into();
        if let Some(previous) = state.runtime.lock().unwrap().take() { previous.disconnect(); }
        state.runtime_health.clear();
        let next = connect(&app).map_err(|error| attach_failed(&app, error))?;
        log::info!("restarted the local runtime");
        let status = connected(&next).map_err(|error| format!("{error:#}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::client::{Refused, Unresponsive};

    fn timed_out() -> anyhow::Error {
        Unresponsive { command: "runtime.liveness".into(), waited: Duration::from_secs(15) }.into()
    }

    fn refused(code: &str) -> anyhow::Error {
        Refused { code: code.into(), message: "refused".into() }.into()
    }

    #[test]
    fn a_runtime_is_flagged_after_failed_probes_in_a_row_and_each_runtime_is_judged_alone() {
        let health = Health::default();
        assert!(!health.probed("first", Err(timed_out())), "one slow answer is a busy runtime");
        assert!(health.unresponsive().is_none());
        assert!(!health.probed("first", Ok(())));
        assert!(!health.probed("first", Err(timed_out())), "an answer in between starts the count again");
        assert!(health.probed("first", Err(refused("busy"))), "the second failure in a row is news");
        assert!(health.unresponsive().is_some_and(|message| message.contains("busy")));
        assert!(!health.probed("first", Err(timed_out())), "still not responding is not news");
        // Its replacement starts clean, and windows still showing the old
        // finding hear that it no longer holds.
        assert!(health.probed("second", Err(timed_out())));
        assert!(health.unresponsive().is_none());
        assert!(!health.probed("second", Ok(())));
        assert!(!health.probed("second", Err(timed_out())));
        assert!(health.probed("second", Err(timed_out())));
        assert!(health.probed("second", Ok(())), "answering again is news");
        assert!(health.unresponsive().is_none());
    }

    #[test]
    fn an_attach_the_runtime_never_answered_or_turned_away_offers_a_restart() {
        let health = Health::default();
        health.attach_failed(&timed_out());
        assert!(health.unresponsive().is_some());
        // Every request place held by stuck work: reconnecting meets the same refusal.
        health.attach_failed(&refused("busy").context("attach to the local runtime"));
        assert!(health.unresponsive().is_some());
        health.attach_failed(&refused("runtime_incompatible"));
        assert!(health.unresponsive().is_none(), "an answer that refuses for a reason is not a wedge");
        health.attach_failed(&anyhow::anyhow!("local runtime exited before attachment"));
        assert!(health.unresponsive().is_none());
    }

    #[test]
    fn a_restart_reaches_only_the_runtime_its_window_found_not_responding() {
        assert!(restart_reaches(Some("wedged"), "wedged"));
        assert!(!restart_reaches(Some("wedged"), "replacement"), "a late click must not stop the replacement");
        assert!(!restart_reaches(None, "replacement"), "a window that found none attached cannot name this one");
    }
}
