//! Window connection state and preferences. Unavailable transport is a separate
//! state, never an empty list of agents or an instruction to recover their turns.

use std::sync::Mutex;
use std::time::Duration;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::client::unanswered;
pub use super::supervisor::ConnectionState;
use crate::{AppState, store::settings::{self, QuitBehavior}};

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
    /// restart reaches it, however often the supervisor tries again. Any
    /// other failure is not this watch's to say.
    pub(crate) fn attach_failed(&self, error: &anyhow::Error) {
        *self.0.lock().unwrap() = Watch { unresponsive: unanswered(error).then(|| format!("{error:#}")), ..Watch::default() };
    }

    /// A new attachment, or a restart: nothing is known about it yet.
    pub(crate) fn clear(&self) {
        *self.0.lock().unwrap() = Watch::default();
    }
}

/// Ask the attached runtime, every few seconds, whether it still answers and
/// its loop still turns, and tell every window when that changes. A runtime
/// wedged behind one lock otherwise looks attached and healthy for good (#661).
/// A closed attachment is the supervisor's: its attempts to attach again say
/// whether the runtime answers ([`Health::attach_failed`]).
pub(crate) fn watch(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("local-runtime-watchdog".into()).spawn(move || loop {
        std::thread::sleep(PROBE_EVERY);
        let state = app.state::<AppState>();
        let Some(runtime) = state.runtime().filter(|runtime| runtime.attachment().is_ok()) else { continue };
        let outcome = runtime.probe();
        if let Err(error) = &outcome { log::warn!("local runtime probe: {error:#}"); }
        if state.runtime_health.probed(runtime.epoch(), outcome) {
            let _ = app.emit("local_runtime_state", ());
        }
    });
    if let Err(error) = spawned { log::error!("start the local runtime watchdog: {error}"); }
}

/// Whether a window that found runtime `seen` not responding (none when it
/// found none attached) may restart now. `attached` is the runtime attached
/// now, if any, and `unresponsive` whether it is still found not responding.
/// A window that asks after another has already restarted it, or after the
/// runtime came back, stops nothing: not the replacement, not the recovered one.
fn restart_reaches(seen: Option<&str>, attached: Option<&str>, unresponsive: bool) -> bool {
    unresponsive && attached.is_none_or(|attached| seen == Some(attached))
}

/// One restart at a time, for every window.
static RESTART: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    let status = state.runtime_supervisor.status(window, runtime.as_deref(), &unattached);
    judged(status, state.runtime_health.unresponsive(), runtime.as_ref().map(|runtime| runtime.epoch()))
}

/// What a window is told: the supervisor's status, unless the runtime
/// `epoch` (none when it never attached) is found not responding.
/// Reconnecting, by itself or on "Try again", reaches the same wedged
/// process; only a restart recovers (#661). A runtime that retrying cannot
/// reach for another reason, or one stopped for quit, is said as such.
fn judged(status: ConnectionState, unresponsive: Option<String>, epoch: Option<&str>) -> ConnectionState {
    match (unresponsive, status) {
        (Some(message), ConnectionState::Connected { .. } | ConnectionState::Connecting { .. }) =>
            ConnectionState::Unresponsive { message, epoch: epoch.map(str::to_owned) },
        (_, status) => status,
    }
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

/// Stop the runtime without asking it, and have the supervisor attach a fresh
/// one through discovery (#661). Its agents and terminals stop with it; each
/// agent resumes its conversation from the provider's transcript when its tab
/// next starts, and windows re-attach in place as after any reconnect. `epoch`
/// is the runtime the window found not responding (none when it never
/// attached): a window that asks after another has already restarted it
/// stops nothing.
#[tauri::command]
pub async fn local_runtime_restart(app: AppHandle, window: tauri::WebviewWindow, epoch: Option<String>) -> Result<ConnectionState, String> {
    let _restart = RESTART.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let attached = state.runtime();
        if !restart_reaches(epoch.as_deref(), attached.as_ref().map(|runtime| runtime.epoch()), state.runtime_health.unresponsive().is_some()) {
            return Ok(status(&app, window.label()));
        }
        let home = crate::store::root().map_err(|error| format!("{error:#}"))?;
        super::launch::kill_owner(&home).map_err(|error| format!("Could not stop the TerminalX runtime: {error:#}"))?;
        log::info!("stopped the unresponsive local runtime; attaching a fresh one");
        *state.runtime_error.lock().unwrap() = "The TerminalX runtime is restarting.".into();
        state.runtime_health.clear();
        // Nothing more is sent to the process that was stopped. Dropping its
        // attachment reports the loss, and the supervisor's next attempt,
        // made now, starts a fresh runtime.
        if let Some(previous) = attached { previous.disconnect(); }
        state.runtime_supervisor.retry_now();
        Ok(status(&app, window.label()))
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
    fn a_runtime_found_not_responding_is_said_so_in_place_of_connected_or_reconnecting() {
        let connected = || ConnectionState::Connected { epoch: "wedged".into(), generation: 1, view: 0 };
        let connecting = || ConnectionState::Connecting { terminal: false, attempt: 3, retry_in_ms: 500, down_ms: 20_000,
            message: "Could not reconnect to the background runtime".into() };
        let finding = || Some("The TerminalX runtime did not answer runtime.liveness within 15 seconds.".to_string());
        assert_eq!(judged(connected(), None, Some("wedged")), connected());
        assert_eq!(judged(connected(), finding(), Some("wedged")),
            ConnectionState::Unresponsive { message: finding().unwrap(), epoch: Some("wedged".into()) });
        // Its attachment closed, and attaching again goes unanswered.
        assert_eq!(judged(connecting(), finding(), Some("wedged")),
            ConnectionState::Unresponsive { message: finding().unwrap(), epoch: Some("wedged".into()) });
        assert!(matches!(judged(connecting(), finding(), None), ConnectionState::Unresponsive { epoch: None, .. }),
            "a runtime that never let this desktop attach");
        // Quitting, or another desktop holding the runtime: no restart is offered.
        let stopping = || ConnectionState::Unavailable { message: "TerminalX is stopping its background runtime.".into() };
        assert_eq!(judged(stopping(), finding(), Some("wedged")), stopping());
    }

    #[test]
    fn a_restart_reaches_only_the_runtime_its_window_found_not_responding() {
        assert!(restart_reaches(Some("wedged"), Some("wedged"), true));
        assert!(restart_reaches(None, None, true), "a runtime that never let this desktop attach");
        assert!(!restart_reaches(Some("wedged"), Some("replacement"), true), "a late click must not stop the replacement");
        assert!(!restart_reaches(None, Some("replacement"), true), "a window that found none attached cannot name this one");
        // A second window's click after the first restarted it, while the
        // fresh runtime is still being attached in place of the old one.
        assert!(!restart_reaches(Some("wedged"), Some("wedged"), false), "a restart already under way, or a runtime that recovered");
    }
}
