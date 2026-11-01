//! Bringing the runtime along with an update (#730).
//!
//! Since #467 the runtime outlives the app, and with agent tabs attached it
//! never goes idle, so an update left the previous release's runtime serving
//! the new app until the Mac restarted. Now, whenever the desktop attaches to
//! a runtime older than itself, it replaces that runtime with the one bundled
//! with it: at once when no agent is in the middle of a turn, otherwise as
//! soon as none is. Until then every window says the runtime is older than
//! the app, names the agents it is waiting for, and offers to restart it now.
//!
//! Replacing it stops its agents and terminals as Stop All does
//! (`launch::retire`); each agent picks up its conversation again when its
//! tab next starts, as after Restart runtime. A runtime of the app's version
//! or a newer one is attached as it always was, so two builds sharing one
//! home never take turns replacing each other's runtime.

use std::sync::{Condvar, Mutex};
use std::time::Duration;

use anyhow::Context;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::client::Build;
use super::desktop::Desktop;
use crate::store::index::SessionEntry;
use crate::AppState;

/// How often an older runtime is asked whether its agents' turns are done.
const CHECK_EVERY: Duration = Duration::from_secs(5);

/// The attached runtime is older than this app, as a window shows it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outdated {
    /// Its version, when it said.
    pub running: Option<String>,
    /// This app's, which the runtime bundled with it shares.
    pub app: String,
    /// The agents in the middle of a turn, which the switch waits for. `None`
    /// until they have been read; the switch waits for that too.
    pub turns: Option<Vec<String>>,
    /// Why they could not be read, or why the last switch failed. A failed
    /// switch is tried again only when asked.
    pub problem: Option<String>,
    /// The last switch failed: it is not tried again by itself.
    #[serde(skip)]
    failed: bool,
}

/// The runtime is being replaced with the one bundled with this app.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Switching {
    pub from: Option<String>,
    pub to: String,
}

#[derive(Default)]
struct Inner {
    /// The attached runtime's epoch, while it is older than this app.
    pending: Option<(String, Outdated)>,
    /// A switch is under way, until the next attachment or failure to attach.
    switching: Option<Switching>,
    /// The older runtime is still stopping. Attaching fails meanwhile, as it
    /// refuses new attachments, and that does not end the switch.
    stopping: bool,
    /// Look again now rather than at the next check.
    due: bool,
}

impl Inner {
    /// The older runtime to keep checking: none while a switch is under way,
    /// or after one failed, which is tried again only when asked.
    fn checkable(&self) -> Option<&str> {
        let (epoch, outdated) = self.pending.as_ref()?;
        (self.switching.is_none() && !outdated.failed).then_some(epoch.as_str())
    }
}

/// What the desktop knows about replacing the attached runtime, for every window.
#[derive(Default)]
pub struct Replacement {
    inner: Mutex<Inner>,
    wake: Condvar,
}

/// This app's version, which its bundled runtime shares.
fn app_version() -> semver::Version {
    semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("the crate's own version is semantic")
}

impl Replacement {
    /// An attachment was published, to the runtime `epoch` of `build`.
    pub(crate) fn attached(&self, epoch: &str, build: &Build) {
        let app = app_version();
        let mut inner = self.inner.lock().unwrap();
        inner.switching = None;
        inner.stopping = false;
        if !build.older_than(&app) {
            inner.pending = None;
            return;
        }
        // A new attachment to the same older runtime keeps what was found.
        if inner.pending.as_ref().is_none_or(|(pending, _)| pending != epoch) {
            log::warn!("the local runtime ({}) is older than this app ({app}); it is replaced once none of its agents is in the middle of a turn",
                build.version.as_ref().map_or_else(|| "a version it would not say".to_string(), ToString::to_string));
            inner.pending = Some((epoch.into(), Outdated {
                running: build.version.as_ref().map(ToString::to_string), app: app.to_string(), turns: None, problem: None, failed: false,
            }));
        }
        inner.due = true;
        drop(inner);
        self.wake.notify_all();
    }

    /// Attaching failed. Once the older runtime has gone, a switch that was
    /// under way is over, and windows show how attaching goes instead.
    pub(crate) fn attach_failed(&self) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.stopping { inner.switching = None; }
    }

    /// What windows attached to runtime `epoch` are told about it.
    pub(crate) fn outdated(&self, epoch: &str) -> Option<Outdated> {
        let inner = self.inner.lock().unwrap();
        inner.pending.as_ref().filter(|(pending, _)| pending == epoch).map(|(_, outdated)| outdated.clone())
    }

    pub(crate) fn switching(&self) -> Option<Switching> {
        self.inner.lock().unwrap().switching.clone()
    }

    /// Record what reading the turns of runtime `epoch` found. True when that
    /// changes what windows show.
    fn found(&self, epoch: &str, turns: Result<Vec<String>, String>) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some((_, outdated)) = inner.pending.as_mut().filter(|(pending, _)| pending == epoch) else { return false };
        let (turns, problem) = match turns {
            Ok(turns) => (Some(turns), None),
            Err(problem) => (outdated.turns.clone(), Some(problem)),
        };
        let changed = outdated.turns != turns || outdated.problem != problem;
        outdated.turns = turns;
        outdated.problem = problem;
        changed
    }

    /// Mark a switch away from runtime `epoch` as under way. False when it is
    /// no longer the older runtime attached, or a switch already is.
    fn begin(&self, epoch: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.switching.is_some() { return false; }
        let Some((_, outdated)) = inner.pending.as_ref().filter(|(pending, _)| pending == epoch) else { return false };
        inner.switching = Some(Switching { from: outdated.running.clone(), to: outdated.app.clone() });
        inner.stopping = true;
        true
    }

    /// The older runtime has gone: the switch ends with the next attachment,
    /// or with a failure to make one.
    fn stopped(&self) {
        self.inner.lock().unwrap().stopping = false;
    }

    fn failed(&self, epoch: &str, problem: String) {
        let mut inner = self.inner.lock().unwrap();
        inner.switching = None;
        inner.stopping = false;
        if let Some((_, outdated)) = inner.pending.as_mut().filter(|(pending, _)| pending == epoch) {
            outdated.problem = Some(problem);
            outdated.failed = true;
        }
    }

    /// The older runtime to check next: at once when it was just attached,
    /// and every [`CHECK_EVERY`] after that. Waits while there is none.
    fn next(&self) -> String {
        let mut inner = self.inner.lock().unwrap();
        loop {
            if inner.checkable().is_none() {
                inner = self.wake.wait(inner).unwrap();
                continue;
            }
            if std::mem::take(&mut inner.due) {
                return inner.checkable().expect("checked above").to_owned();
            }
            let (next, waited) = self.wake.wait_timeout(inner, CHECK_EVERY).unwrap();
            inner = next;
            if waited.timed_out() { inner.due = true; }
        }
    }
}

/// What a window is told: `status` as the supervisor and watchdog judged
/// it, unless the runtime is being replaced, which says so in place of
/// anything else, or the attached runtime is older than this app.
pub(crate) fn shown(replacement: &Replacement, status: super::ui::ConnectionState) -> super::ui::ConnectionState {
    use super::ui::ConnectionState;
    if let Some(Switching { from, to }) = replacement.switching() {
        return ConnectionState::Updating { from, to };
    }
    match status {
        ConnectionState::Connected { epoch, generation, view, .. } => {
            let outdated = replacement.outdated(&epoch);
            ConnectionState::Connected { epoch, generation, view, outdated }
        }
        status => status,
    }
}

/// Ask an older attached runtime, every few seconds, whether any of its
/// agents is in the middle of a turn, and replace it once none is.
pub(crate) fn watch(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("local-runtime-replacement".into()).spawn(move || loop {
        let state = app.state::<AppState>();
        let epoch = state.runtime_replacement.next();
        let Some(runtime) = state.runtime().filter(|runtime| runtime.epoch() == epoch && runtime.attachment().is_ok()) else { continue };
        let changed = check(&state.runtime_replacement, &epoch, turns(&runtime), || {
            let _one = super::ui::RESTART.blocking_lock();
            switch(&app, &epoch)
        });
        if changed { let _ = app.emit("local_runtime_state", ()); }
    });
    if let Err(error) = spawned { log::error!("start the local runtime replacement watch: {error}"); }
}

/// One check of the older runtime `epoch`, whose agents mid-turn `turns`
/// read: replace it with `switch` when none is, or else record which are,
/// or why that could not be told. Never switches on a reading that failed.
/// True when windows need telling what was found; a switch tells them itself.
fn check(replacement: &Replacement, epoch: &str, turns: anyhow::Result<Vec<String>>, switch: impl FnOnce() -> Result<(), String>) -> bool {
    match turns {
        Ok(turns) if turns.is_empty() => {
            if let Err(error) = switch() { log::warn!("replace the older local runtime: {error}"); }
            false
        }
        found => {
            if let Err(error) = &found { log::warn!("read the older local runtime's turns: {error:#}"); }
            replacement.found(epoch, found.map_err(|error| format!("Could not tell which of its agents are in the middle of a turn: {error:#}")))
        }
    }
}

/// The agents `runtime` is in the middle of a turn with, by name. Stopping
/// the runtime now would cut those turns off.
fn turns(runtime: &Desktop) -> anyhow::Result<Vec<String>> {
    let status = runtime.status()?;
    let tabs = status["runningTabs"].as_array().context("The TerminalX runtime did not say what it is running.")?;
    let sessions = crate::store::index::load().unwrap_or_default();
    Ok(tabs.iter().filter(|tab| matches!(tab["status"].as_str(), Some("in_progress" | "waiting"))).map(|tab| name(&sessions, tab)).collect())
}

/// An agent as a person finds it: what it is, in which session's tab.
fn name(sessions: &[SessionEntry], tab: &Value) -> String {
    let agent = crate::harness::display_name(tab["harness"].as_str().unwrap_or_default());
    let Some(session) = sessions.iter().find(|session| tab["sessionId"] == session.id.as_str()) else { return agent.to_string() };
    let title = session.tab(tab["tabId"].as_str().unwrap_or_default())
        .and_then(|tab| tab.title.as_deref()).map(str::trim).filter(|title| !title.is_empty() && *title != session.title);
    match title {
        Some(title) => format!("{agent} in \u{201c}{}\u{201d} ({title})", session.title),
        None => format!("{agent} in \u{201c}{}\u{201d}", session.title),
    }
}

/// Replace the older runtime `epoch` with the one bundled with this app, now,
/// whatever its agents are doing. Nothing happens when it is no longer the
/// one attached, or not older. The caller holds `ui::RESTART`.
pub(crate) fn switch(app: &AppHandle, epoch: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let Some(runtime) = state.runtime().filter(|runtime| runtime.epoch() == epoch) else { return Ok(()) };
    if !state.runtime_replacement.begin(epoch) { return Ok(()); }
    let _ = app.emit("local_runtime_state", ());
    let result = crate::store::root().and_then(|home| super::launch::retire(&home, || runtime.stop_all()));
    match result {
        Ok(()) => {
            log::info!("stopped the older local runtime; attaching the one bundled with this app");
            state.runtime_replacement.stopped();
            *state.runtime_error.lock().unwrap() = "TerminalX is starting its updated runtime.".into();
            state.runtime_health.clear();
            // Nothing more is sent to the runtime that stopped. Dropping its
            // attachment reports the loss, and the supervisor's next attempt,
            // made now, starts the bundled runtime.
            runtime.disconnect();
            state.runtime_supervisor.retry_now();
            Ok(())
        }
        Err(error) => {
            let message = format!("Could not restart the TerminalX runtime: {error:#}");
            state.runtime_replacement.failed(epoch, message.clone());
            let _ = app.emit("local_runtime_state", ());
            Err(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::ui::ConnectionState;
    use serde_json::json;

    fn build(version: Option<&str>) -> Build {
        let version = version.map(|version| semver::Version::parse(version).unwrap());
        Build { version, mobile: Default::default() }
    }

    fn connected(epoch: &str) -> ConnectionState {
        ConnectionState::Connected { epoch: epoch.into(), generation: 1, view: 0, outdated: None }
    }

    /// The test's own version is the app's; one release before it is older.
    fn older() -> String {
        let mut version = app_version();
        if version.patch > 0 { version.patch -= 1 } else if version.minor > 0 { version.minor -= 1 } else { version.major -= 1 }
        version.to_string()
    }

    #[test]
    fn only_a_runtime_older_than_the_app_is_replaced() {
        let replacement = Replacement::default();
        replacement.attached("same", &build(Some(env!("CARGO_PKG_VERSION"))));
        assert_eq!(replacement.outdated("same"), None);
        assert_eq!(replacement.next_now(), None, "nothing to check");
        let mut newer = app_version();
        newer.minor += 1;
        replacement.attached("newer", &build(Some(&newer.to_string())));
        assert_eq!(replacement.outdated("newer"), None, "a newer runtime is never replaced by an older app");

        replacement.attached("old", &build(Some(&older())));
        let outdated = replacement.outdated("old").expect("an older runtime is");
        assert_eq!((outdated.running, outdated.app, outdated.turns), (Some(older()), env!("CARGO_PKG_VERSION").to_string(), None));
        assert_eq!(replacement.next_now().as_deref(), Some("old"), "checked at once");
        assert_eq!(replacement.outdated("another"), None, "only windows attached to it are told");

        replacement.attached("unsaid", &build(None));
        assert_eq!(replacement.outdated("unsaid").unwrap().running, None, "one that would not say is taken for older");
        // Its replacement, of this app's version, clears it.
        replacement.attached("bundled", &build(Some(env!("CARGO_PKG_VERSION"))));
        assert_eq!(replacement.outdated("unsaid"), None);
    }

    #[test]
    fn a_window_is_told_which_agents_the_switch_waits_for_and_when_it_is_under_way() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        assert!(replacement.found("old", Ok(vec!["Claude Code in \u{201c}Fix login\u{201d}".into()])));
        assert!(!replacement.found("old", Ok(vec!["Claude Code in \u{201c}Fix login\u{201d}".into()])), "the same finding is not news");
        let ConnectionState::Connected { outdated: Some(outdated), .. } = shown(&replacement, connected("old")) else { panic!("connected, and older") };
        assert_eq!(outdated.turns.as_deref(), Some(&["Claude Code in \u{201c}Fix login\u{201d}".to_string()][..]));
        assert_eq!(shown(&replacement, connected("bundled")), connected("bundled"), "a window attached elsewhere is not told");
        // Turns that could not be read leave the last ones known, and say why.
        assert!(replacement.found("old", Err("timed out".into())));
        let outdated = replacement.outdated("old").unwrap();
        assert_eq!((outdated.turns.map(|turns| turns.len()), outdated.problem.as_deref()), (Some(1), Some("timed out")));
        assert!(!replacement.found("bundled", Ok(vec![])), "a finding about another runtime is dropped");

        // Under way: every window says so, whatever else it would say.
        assert!(replacement.begin("old"));
        assert!(!replacement.begin("old"), "one switch at a time");
        let updating = ConnectionState::Updating { from: Some(older()), to: env!("CARGO_PKG_VERSION").into() };
        assert_eq!(shown(&replacement, connected("old")), updating);
        let reconnecting = ConnectionState::Connecting { terminal: false, attempt: 1, retry_in_ms: 0, down_ms: 0, message: "lost".into() };
        assert_eq!(shown(&replacement, reconnecting), updating);
        assert_eq!(replacement.next_now(), None, "not checked again while it is under way");
        // The bundled runtime attaches: over.
        replacement.attached("bundled", &build(Some(env!("CARGO_PKG_VERSION"))));
        assert_eq!(shown(&replacement, connected("bundled")), connected("bundled"));
    }

    /// #730: the switch waits for every turn, and for knowing there is none.
    #[test]
    fn an_older_runtime_is_switched_only_once_no_agent_is_mid_turn() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        let switched = std::cell::Cell::new(0);
        let switch = || { switched.set(switched.get() + 1); Ok(()) };
        assert!(check(&replacement, "old", Ok(vec!["Codex in \u{201c}Release notes\u{201d}".into()]), switch));
        assert_eq!(switched.get(), 0, "a turn in progress is never cut off by itself");
        assert!(check(&replacement, "old", Err(anyhow::anyhow!("did not answer within 15 seconds")), switch));
        assert_eq!(switched.get(), 0, "nor when its turns could not be read");
        assert!(replacement.outdated("old").unwrap().problem.unwrap().starts_with("Could not tell which of its agents"));
        assert!(!check(&replacement, "old", Ok(vec![]), switch), "the switch tells windows itself");
        assert_eq!(switched.get(), 1, "replaced once none is");
        // A switch that fails is logged; what it found is the switch's to record.
        assert!(!check(&replacement, "old", Ok(vec![]), || Err("it did not exit".into())));
    }

    #[test]
    fn a_failed_switch_says_why_and_is_tried_again_only_when_asked() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        assert!(replacement.begin("old"));
        replacement.failed("old", "Could not restart the TerminalX runtime: it did not exit.".into());
        assert_eq!(replacement.switching(), None);
        let outdated = replacement.outdated("old").unwrap();
        assert_eq!(outdated.problem.as_deref(), Some("Could not restart the TerminalX runtime: it did not exit."));
        assert_eq!(replacement.next_now(), None, "not by itself");
        assert!(replacement.begin("old"), "Restart now tries again");
        // While the older runtime stops it refuses to be attached again: still under way.
        replacement.attach_failed();
        assert!(replacement.switching().is_some());
        // Once it has gone, a failure to attach the new one leaves windows to show how attaching goes.
        replacement.stopped();
        replacement.attach_failed();
        assert_eq!(replacement.switching(), None);
        assert!(!replacement.begin("bundled"), "only the older runtime attached is switched away from");
    }

    #[test]
    fn agents_mid_turn_are_named_by_their_session_and_tab() {
        let session: SessionEntry = serde_json::from_value(json!({
            "id": "s1", "projectPath": "/p", "cwd": "/p", "title": "Fix login", "created": "2026-11-01T00:00:00Z", "modified": "2026-11-01T00:00:00Z",
            "tabs": [{ "id": "t1", "harness": "claude", "title": "Review", "created": "2026-11-01T00:00:00Z" },
                { "id": "t2", "harness": "codex", "title": "Fix login", "created": "2026-11-01T00:00:00Z" }],
        })).unwrap();
        let sessions = [session];
        assert_eq!(name(&sessions, &json!({"sessionId": "s1", "tabId": "t1", "harness": "claude"})),
            format!("{} in \u{201c}Fix login\u{201d} (Review)", crate::harness::display_name("claude")));
        assert_eq!(name(&sessions, &json!({"sessionId": "s1", "tabId": "t2", "harness": "codex"})),
            format!("{} in \u{201c}Fix login\u{201d}", crate::harness::display_name("codex")), "a tab named as its session says it once");
        assert_eq!(name(&sessions, &json!({"sessionId": "gone", "tabId": "t", "harness": "codex"})), crate::harness::display_name("codex"));
    }

    impl Replacement {
        /// [`Replacement::next`] without waiting: what is due now, if anything.
        fn next_now(&self) -> Option<String> {
            let mut inner = self.inner.lock().unwrap();
            let epoch = inner.checkable()?.to_owned();
            std::mem::take(&mut inner.due).then_some(epoch)
        }
    }
}
