//! Bringing the runtime along with an update (#730).
//!
//! Since #467 the runtime outlives the app, and with agent tabs attached it
//! never goes idle, so an update left the previous release's runtime serving
//! the new app until the Mac restarted. Now, whenever the desktop attaches to
//! a runtime older than itself, it replaces that runtime with the one bundled
//! with it, by itself only once nothing it runs would be cut short, by the
//! runtime's own idle rule: only managed agents that have settled, with no
//! process of their own running, may be stopped without asking. Until then
//! every window says the runtime is older than the app, names what it is
//! waiting for, and offers to restart it now.
//!
//! An agent's MCP and language servers are its own helpers, and start again
//! with it; what its tools started, in a shell, is work (`idle::working`).
//!
//! A runtime of this build or later says what stopping it would cut short
//! (`runtime.work`), and stops only if nothing would, deciding under the lock
//! that admits work (`runtime.stopAllIfIdle`). One too old to (0.2.22 and
//! before) is judged by what it shows: its agents' turns, its open terminals,
//! and what its agents' tools left running, read again just before it is
//! stopped. It cannot show a prompt it holds, nor one a CLI holds for after
//! its turn, so nothing may be found under way for [`SETTLE`] before it is
//! replaced. Replacing it by itself never stops it without asking unless it
//! agreed to stop: anything that goes wrong before then leaves it running.
//!
//! Replacing stops the runtime as Stop All does (`launch::retire`); each
//! agent picks up its conversation again when its tab next starts, as after
//! Restart runtime. A runtime of the app's version or a newer one is attached
//! as it always was, so two builds sharing one home never take turns
//! replacing each other's runtime.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::client::{Build, Refused};
use super::desktop::Desktop;
use crate::session::retire::{Work, WorkKind};
use crate::store::index::SessionEntry;
use crate::AppState;

/// How often an older runtime is asked what it is running.
const CHECK_EVERY: Duration = Duration::from_secs(5);
/// How long nothing may be found under way before an older runtime is
/// replaced by itself. A CLI starts the follow-up typed during a turn only
/// once that turn has ended, and until then neither the runtime nor the
/// desktop can see it; an older runtime cannot show the prompts it holds.
const SETTLE: Duration = Duration::from_secs(15);

/// The attached runtime is older than this app, as a window shows it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outdated {
    /// Its version, when it said.
    pub running: Option<String>,
    /// This app's, which the runtime bundled with it shares.
    pub app: String,
    /// What stopping it now would cut short, which the switch waits for.
    /// `None` until that has been read; the switch waits for that too.
    pub work: Option<Vec<String>>,
    /// Why that could not be read, or why the last switch failed.
    pub problem: Option<String>,
    /// The last switch failed: it is tried again only when asked.
    pub failed: bool,
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
    /// Since when every reading of it found nothing under way.
    quiet_since: Option<Instant>,
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

    fn outdated(&mut self, epoch: &str) -> Option<&mut Outdated> {
        self.pending.as_mut().filter(|(pending, _)| pending == epoch).map(|(_, outdated)| outdated)
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
            inner.quiet_since = None;
            return;
        }
        // A new attachment to the same older runtime keeps what was found.
        if inner.pending.as_ref().is_none_or(|(pending, _)| pending != epoch) {
            log::warn!("the local runtime ({}) is older than this app ({app}); it is replaced once nothing it runs would be cut short",
                build.version.as_ref().map_or_else(|| "a version it would not say".to_string(), ToString::to_string));
            inner.pending = Some((epoch.into(), Outdated {
                running: build.version.as_ref().map(ToString::to_string), app: app.to_string(), work: None, problem: None, failed: false,
            }));
            inner.quiet_since = None;
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
        self.inner.lock().unwrap().outdated(epoch).map(|outdated| outdated.clone())
    }

    pub(crate) fn switching(&self) -> Option<Switching> {
        self.inner.lock().unwrap().switching.clone()
    }

    /// Record what reading runtime `epoch`'s work found at `now`. True when
    /// that changes what windows show.
    fn found(&self, epoch: &str, work: Result<Vec<String>, String>, now: Instant) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let quiet = matches!(&work, Ok(work) if work.is_empty());
        let Some(outdated) = inner.outdated(epoch) else { return false };
        let (work, problem) = match work {
            Ok(work) => (Some(work), None),
            Err(problem) => (outdated.work.clone(), Some(problem)),
        };
        let changed = outdated.work != work || outdated.problem != problem;
        outdated.work = work;
        outdated.problem = problem;
        if quiet { inner.quiet_since.get_or_insert(now); } else { inner.quiet_since = None; }
        changed
    }

    /// Whether every reading of runtime `epoch` since [`SETTLE`] before `now`
    /// found nothing under way.
    fn settled(&self, epoch: &str, now: Instant) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let since = inner.quiet_since;
        inner.outdated(epoch).is_some() && since.is_some_and(|since| now.saturating_duration_since(since) >= SETTLE)
    }

    /// Mark a switch away from runtime `epoch` as under way. False when it is
    /// no longer the older runtime attached, or a switch already is.
    fn begin(&self, epoch: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.switching.is_some() { return false; }
        let Some(outdated) = inner.outdated(epoch) else { return false };
        let switching = Switching { from: outdated.running.clone(), to: outdated.app.clone() };
        inner.switching = Some(switching);
        inner.stopping = true;
        true
    }

    /// The older runtime has gone: the switch ends with the next attachment,
    /// or with a failure to make one.
    fn stopped(&self) {
        self.inner.lock().unwrap().stopping = false;
    }

    /// The runtime was left running, nothing of it stopped: work began after
    /// it was read, or `problem` kept it from agreeing to stop. The wait goes
    /// on from the start.
    fn declined(&self, epoch: &str, problem: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.switching = None;
        inner.stopping = false;
        inner.quiet_since = None;
        inner.due = true;
        if let Some(outdated) = inner.outdated(epoch) { outdated.problem = problem; }
    }

    fn failed(&self, epoch: &str, problem: String) {
        let mut inner = self.inner.lock().unwrap();
        inner.switching = None;
        inner.stopping = false;
        inner.quiet_since = None;
        if let Some(outdated) = inner.outdated(epoch) {
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

/// What a switch needs of the app, so the order of its steps can be tested
/// without one.
pub(crate) trait Host {
    /// Stop runtime `epoch` and wait until it has gone (`launch::retire`): as
    /// Stop All does when `forced`, otherwise only if nothing it runs would
    /// be cut short, which it refuses as `runtime_busy`.
    fn retire(&self, epoch: &str, forced: bool) -> anyhow::Result<()>;
    /// Runtime `epoch` has gone: let its attachment go and attach the
    /// bundled runtime in its place.
    fn reattach(&self, epoch: &str);
    /// Windows read their status again.
    fn changed(&self);
}

/// Replace the older runtime `epoch` with the one bundled with this app.
/// `forced` is Restart now: whatever it runs stops with it. Otherwise it is
/// stopped only if nothing would be cut short, and work found meanwhile puts
/// the switch off, which is no failure. Nothing happens when it is no longer
/// the one attached, or not older. The caller holds `ui::RESTART`.
pub(crate) fn switch(replacement: &Replacement, host: &impl Host, epoch: &str, forced: bool) -> Result<(), String> {
    if !replacement.begin(epoch) { return Ok(()); }
    host.changed();
    let result = host.retire(epoch, forced);
    let outcome = match result {
        Ok(()) => {
            log::info!("stopped the older local runtime; attaching the one bundled with this app");
            replacement.stopped();
            host.reattach(epoch);
            Ok(())
        }
        Err(error) if super::launch::left_running(&error) => {
            log::info!("the older local runtime was left running: {error:#}");
            // Work that began, or a runtime replaced meanwhile, is no news.
            let routine = super::launch::refused(&error, "runtime_busy") || super::launch::refused(&error, "runtime_restarted");
            replacement.declined(epoch, (!routine).then(|| format!("{error:#}")));
            Ok(())
        }
        Err(error) => {
            let message = format!("Could not restart the TerminalX runtime: {error:#}");
            replacement.failed(epoch, message.clone());
            Err(message)
        }
    };
    host.changed();
    outcome
}

/// One check of the older runtime `epoch`, whose `work` was just read at
/// `now`: replace it with `switch` once nothing has been under way for
/// [`SETTLE`], or else record what is, or why that could not be told.
/// Never switches on a reading that failed. True when windows need telling
/// what was found; a switch tells them itself.
fn check(replacement: &Replacement, epoch: &str, work: anyhow::Result<Vec<String>>, now: Instant, switch: impl FnOnce() -> Result<(), String>) -> bool {
    if let Err(error) = &work { log::warn!("read what the older local runtime is running: {error:#}"); }
    let quiet = matches!(&work, Ok(work) if work.is_empty());
    let changed = replacement.found(epoch, work.map_err(|error| format!("Could not tell what it is running: {error:#}")), now);
    if quiet && replacement.settled(epoch, now) {
        if let Err(error) = switch() { log::warn!("replace the older local runtime: {error}"); }
        return false;
    }
    changed
}

/// Ask an older attached runtime, every few seconds, what it is running, and
/// replace it once nothing would be cut short.
pub(crate) fn watch(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("local-runtime-replacement".into()).spawn(move || loop {
        let state = app.state::<AppState>();
        let epoch = state.runtime_replacement.next();
        let Some(runtime) = state.runtime().filter(|runtime| runtime.epoch() == epoch && runtime.attachment().is_ok()) else { continue };
        let changed = check(&state.runtime_replacement, &epoch, work(&runtime), Instant::now(), || {
            let _one = super::ui::RESTART.blocking_lock();
            switch(&state.runtime_replacement, &AppHost(&app), &epoch, false)
        });
        if changed { let _ = app.emit("local_runtime_state", ()); }
    });
    if let Err(error) = spawned { log::error!("start the local runtime replacement watch: {error}"); }
}

/// The switch's steps, done to the app.
pub(crate) struct AppHost<'a>(pub(crate) &'a AppHandle);

impl Host for AppHost<'_> {
    fn retire(&self, epoch: &str, forced: bool) -> anyhow::Result<()> {
        let state = self.0.state::<AppState>();
        let Some(runtime) = state.runtime().filter(|runtime| runtime.epoch() == epoch) else {
            let replaced = anyhow::Error::from(Refused { code: "runtime_restarted".into(), message: "Another runtime was attached meanwhile.".into() });
            return Err(replaced.context(super::launch::LeftRunning("The TerminalX runtime was replaced before it could be stopped; nothing was stopped.")));
        };
        let home = crate::store::root()?;
        let stopping = || runtime.stopping();
        let fallback = if forced { super::launch::Fallback::Forced } else { super::launch::Fallback::Agreed(&stopping) };
        super::launch::retire(&home, || if forced { runtime.stop_all() } else { stop_if_idle(&runtime) }, fallback)
    }

    fn reattach(&self, epoch: &str) {
        let state = self.0.state::<AppState>();
        *state.runtime_error.lock().unwrap() = "TerminalX is starting its updated runtime.".into();
        state.runtime_health.clear();
        // Nothing more is sent to the runtime that stopped. Dropping its
        // attachment reports the loss, and the supervisor's next attempt,
        // made now, starts the bundled runtime.
        if let Some(runtime) = state.runtime().filter(|runtime| runtime.epoch() == epoch) { runtime.disconnect(); }
        state.runtime_supervisor.retry_now();
    }

    fn changed(&self) { let _ = self.0.emit("local_runtime_state", ()); }
}

/// Stop `runtime` as Stop All does, only if nothing it runs would be cut
/// short: decided by the runtime under the lock that admits work when it can
/// (`runtime.stopAllIfIdle`), or, for one too old to, by reading its work
/// again just before asking it to stop.
fn stop_if_idle(runtime: &Desktop) -> anyhow::Result<()> {
    if runtime.stop_all_if_idle()? { return Ok(()); }
    let work = work(runtime)?;
    if !work.is_empty() {
        return Err(Refused { code: "runtime_busy".into(), message: format!("It is running {}.", work.join("; ")) }.into());
    }
    runtime.stop_all()
}

/// What stopping `runtime` now would cut short, by name: as it says, or, for
/// a runtime too old to say, as far as what it shows tells.
fn work(runtime: &Desktop) -> anyhow::Result<Vec<String>> {
    let sessions = crate::store::index::load().unwrap_or_default();
    if let Some(work) = runtime.work()? {
        return Ok(work.iter().map(|work| named(&sessions, work)).collect());
    }
    let status = runtime.status()?;
    let shells = runtime.terminals()?.all_shells()?;
    let table = super::idle::processes()?;
    shown_work(&sessions, &status, &shells, &table)
}

/// What an older runtime shows of its work (0.2.22 and before): agents in
/// the middle of a turn (`runningTabs`), every terminal still open
/// (`runtime.pty.shells`), and what an agent's tools left running, by the
/// process table. Each agent and terminal it starts is its child, leading a
/// process group of its own: a terminal's is a shell, counted with the open
/// terminals. An agent's helpers are no work (`idle::working`). A group whose
/// leader has gone is invisible here: such a runtime does not say which
/// groups are its own.
fn shown_work(sessions: &[SessionEntry], status: &Value, shells: &[crate::pty::ShellPane], table: &[super::idle::Process]) -> anyhow::Result<Vec<String>> {
    let tabs = status["runningTabs"].as_array().context("The TerminalX runtime did not say what it is running.")?;
    let mut work: Vec<String> = tabs.iter().filter(|tab| matches!(tab["status"].as_str(), Some("in_progress" | "waiting"))).map(|tab| named(sessions, &Work {
        kind: WorkKind::Turn, session_id: tab["sessionId"].as_str().map(str::to_owned), tab_id: tab["tabId"].as_str().map(str::to_owned),
        harness: tab["harness"].as_str().map(str::to_owned), title: None,
    })).collect();
    work.extend(shells.iter().filter(|shell| !shell.exited).map(|shell| named(sessions, &Work {
        kind: WorkKind::Terminal, session_id: Some(shell.session_id.clone()), tab_id: None, harness: None, title: shell.title.clone(),
    })));
    let runtime: u32 = status["pid"].as_u64().and_then(|pid| pid.try_into().ok()).context("The TerminalX runtime did not say its process.")?;
    let agents = table.iter().filter(|process| process.parent == runtime && !super::idle::is_shell(process));
    if agents.into_iter().any(|agent| super::idle::working(table, agent.pid)) {
        work.push(named(sessions, &Work { kind: WorkKind::Processes, session_id: None, tab_id: None, harness: None, title: None }));
    }
    Ok(work)
}

/// A piece of work as a person finds it: what it is, and in which session.
fn named(sessions: &[SessionEntry], work: &Work) -> String {
    let session = work.session_id.as_deref().and_then(|id| sessions.iter().find(|session| session.id == id));
    let agent = work.harness.as_deref().map(crate::harness::display_name);
    let tab = session.zip(work.tab_id.as_deref()).and_then(|(session, tab)| session.tab(tab))
        .and_then(|tab| tab.title.as_deref()).map(str::trim)
        .filter(|title| !title.is_empty() && session.is_none_or(|session| *title != session.title));
    let place = match (session, tab) {
        (Some(session), Some(tab)) => format!(" in \u{201c}{}\u{201d} ({tab})", session.title),
        (Some(session), None) => format!(" in \u{201c}{}\u{201d}", session.title),
        (None, _) => String::new(),
    };
    let agent = agent.unwrap_or("An agent");
    match work.kind {
        WorkKind::Turn => format!("{agent}{place}, in the middle of a turn"),
        WorkKind::Prompt if work.tab_id.is_none() => "A prompt from a phone, not yet delivered".into(),
        WorkKind::Prompt => format!("{agent}{place}, with a prompt not yet delivered"),
        WorkKind::ByHand => format!("{agent} started by hand{place}"),
        WorkKind::Terminal => match work.title.as_deref().map(str::trim).filter(|title| !title.is_empty()) {
            Some(title) => format!("The terminal \u{201c}{title}\u{201d}{place}"),
            None => format!("A terminal{place}"),
        },
        WorkKind::Processes if work.harness.is_some() => format!("Commands {agent}{place} left running"),
        WorkKind::Processes => "Commands its agents left running, or processes that outlived what started them".into(),
        WorkKind::Pipeline => "An issue pipeline step".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::ui::ConnectionState;
    use serde_json::json;
    use std::cell::RefCell;

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

    fn updating() -> ConnectionState {
        ConnectionState::Updating { from: Some(older()), to: env!("CARGO_PKG_VERSION").into() }
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
        assert_eq!((outdated.running, outdated.app, outdated.work, outdated.failed), (Some(older()), env!("CARGO_PKG_VERSION").to_string(), None, false));
        assert_eq!(replacement.next_now().as_deref(), Some("old"), "checked at once");
        assert_eq!(replacement.outdated("another"), None, "only windows attached to it are told");

        replacement.attached("unsaid", &build(None));
        assert_eq!(replacement.outdated("unsaid").unwrap().running, None, "one that would not say is taken for older");
        // Its replacement, of this app's version, clears it.
        replacement.attached("bundled", &build(Some(env!("CARGO_PKG_VERSION"))));
        assert_eq!(replacement.outdated("unsaid"), None);
    }

    /// #730 review: anything the runtime would cut short is waited for, a
    /// reading that found nothing must hold for SETTLE, and one that failed
    /// never switches.
    #[test]
    fn an_older_runtime_is_switched_only_once_nothing_has_been_under_way_for_a_while() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        let switched = std::cell::Cell::new(0);
        let switch = || { switched.set(switched.get() + 1); Ok(()) };
        let start = Instant::now();
        let terminal = || Ok(vec!["The terminal \u{201c}npm run dev\u{201d} in \u{201c}Web\u{201d}".to_string()]);
        assert!(check(&replacement, "old", terminal(), start, switch));
        assert_eq!(replacement.outdated("old").unwrap().work.unwrap().len(), 1);
        assert!(!check(&replacement, "old", terminal(), start + 60 * CHECK_EVERY, switch), "the same finding is not news");
        assert_eq!(switched.get(), 0, "a running terminal is never stopped by itself");

        // The turn ended: quiet, but a CLI may start the follow-up typed during it.
        let quiet_at = start + Duration::from_secs(400);
        assert!(check(&replacement, "old", Ok(vec![]), quiet_at, switch));
        assert!(!check(&replacement, "old", Ok(vec![]), quiet_at + CHECK_EVERY, switch));
        assert_eq!(switched.get(), 0, "not before it has been quiet for SETTLE");
        // It did: the wait starts again.
        assert!(check(&replacement, "old", Ok(vec!["Codex in \u{201c}Web\u{201d}, in the middle of a turn".into()]), quiet_at + 2 * CHECK_EVERY, switch));
        let quiet_at = quiet_at + 3 * CHECK_EVERY;
        check(&replacement, "old", Ok(vec![]), quiet_at, switch);
        assert!(check(&replacement, "old", Err(anyhow::anyhow!("did not answer within 15 seconds")), quiet_at + SETTLE, switch));
        assert_eq!(switched.get(), 0, "nor when what it runs could not be read");
        assert!(replacement.outdated("old").unwrap().problem.unwrap().starts_with("Could not tell what it is running"));
        let quiet_at = quiet_at + SETTLE + CHECK_EVERY;
        check(&replacement, "old", Ok(vec![]), quiet_at, switch);
        assert!(!check(&replacement, "old", Ok(vec![]), quiet_at + SETTLE, switch), "the switch tells windows itself");
        assert_eq!(switched.get(), 1, "replaced once nothing has been under way for SETTLE");
    }

    /// A stand-in for the app: the supervisor's attempts to attach go on
    /// while the switch runs, as they do in the app, and each step is noted
    /// with what a window would be shown at that point.
    struct Supervisor<'a> {
        replacement: &'a Replacement,
        stop: Box<dyn Fn(bool) -> anyhow::Result<()> + 'a>,
        steps: RefCell<Vec<String>>,
    }

    impl Supervisor<'_> {
        fn note(&self, step: &str) {
            let shown = match shown(self.replacement, connected("old")) {
                ConnectionState::Updating { .. } => "updating".to_string(),
                ConnectionState::Connected { outdated: Some(outdated), .. } => format!("outdated{}", if outdated.failed { ", failed" } else { "" }),
                ConnectionState::Connected { outdated: None, .. } => "connected".to_string(),
                other => format!("{other:?}"),
            };
            self.steps.borrow_mut().push(format!("{step}: {shown}"));
        }
    }

    impl Host for Supervisor<'_> {
        fn retire(&self, epoch: &str, forced: bool) -> anyhow::Result<()> {
            assert_eq!(epoch, "old");
            // The event connection is lost as the runtime stops, and the
            // supervisor tries again: the stopping runtime refuses it.
            self.replacement.attach_failed();
            self.note(if forced { "retire, forced" } else { "retire" });
            (self.stop)(forced)
        }
        fn reattach(&self, _epoch: &str) {
            self.note("reattach");
            // The bundled runtime is slow to start the first time, then attaches.
            self.replacement.attach_failed();
            self.note("bundled failed to attach once");
            self.replacement.attached("bundled", &build(Some(env!("CARGO_PKG_VERSION"))));
        }
        fn changed(&self) { self.note("changed"); }
    }

    /// #730 review: the switch's steps against an older runtime attached,
    /// with the supervisor's attempts to attach interleaved as in the app.
    #[test]
    fn a_switch_stops_the_older_runtime_then_attaches_the_bundled_one_and_windows_follow() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        let forced = std::cell::Cell::new(None);
        let supervisor = Supervisor { replacement: &replacement, stop: Box::new(|force| { forced.set(Some(force)); Ok(()) }), steps: RefCell::default() };
        assert_eq!(switch(&replacement, &supervisor, "old", false), Ok(()));
        assert_eq!(forced.get(), Some(false), "by itself: only if nothing would be cut short");
        assert_eq!(*supervisor.steps.borrow(), [
            "changed: updating",
            // The stopping runtime refusing an attachment does not end the switch.
            "retire: updating",
            "reattach: updating",
            // Once it has gone, the supervisor's own state shows instead.
            "bundled failed to attach once: outdated",
            "changed: connected",
        ]);
        assert_eq!(shown(&replacement, connected("bundled")), connected("bundled"));
        assert_eq!(replacement.next_now(), None, "nothing left to replace");
        // A late click on Restart now finds nothing to stop.
        let late = Supervisor { replacement: &replacement, stop: Box::new(|_| panic!("nothing is stopped")), steps: RefCell::default() };
        assert_eq!(switch(&replacement, &late, "old", true), Ok(()));
        assert!(late.steps.borrow().is_empty());
    }

    #[test]
    fn work_found_as_the_runtime_stops_puts_the_switch_off_without_stopping_anything() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        let busy = Supervisor { replacement: &replacement, steps: RefCell::default(), stop: Box::new(|_| {
            Err(anyhow::Error::from(Refused { code: "runtime_busy".into(), message: "an agent is mid-turn".into() })
                .context(super::super::launch::LeftRunning("The TerminalX runtime has work under way; nothing was stopped.")))
        }) };
        assert_eq!(switch(&replacement, &busy, "old", false), Ok(()), "no failure");
        assert_eq!(*busy.steps.borrow(), ["changed: updating", "retire: updating", "changed: outdated"], "never reattached");
        let outdated = replacement.outdated("old").unwrap();
        assert!(!outdated.failed && outdated.problem.is_none());
        assert_eq!(replacement.next_now().as_deref(), Some("old"), "read again at once, and waited for from the start");
        assert!(!replacement.settled("old", Instant::now() + SETTLE));
    }

    /// #730 review: replacing it by itself, a failure before the runtime
    /// agreed to stop leaves it running; it is neither stopped nor taken for
    /// a failed switch, and the reason is shown.
    #[test]
    fn a_runtime_left_running_by_a_failure_before_it_agreed_is_waited_for_again() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        let left = Supervisor { replacement: &replacement, steps: RefCell::default(), stop: Box::new(|_| {
            Err(anyhow::anyhow!("The TerminalX runtime did not answer status within 15 seconds.")
                .context(super::super::launch::LeftRunning("The TerminalX runtime did not agree to stop; nothing was stopped.")))
        }) };
        assert_eq!(switch(&replacement, &left, "old", false), Ok(()));
        assert_eq!(*left.steps.borrow(), ["changed: updating", "retire: updating", "changed: outdated"], "never reattached");
        let outdated = replacement.outdated("old").unwrap();
        assert!(!outdated.failed, "not a failed switch: nothing was stopped");
        assert!(outdated.problem.as_deref().is_some_and(|problem| problem.contains("did not agree to stop") && problem.contains("15 seconds")), "{outdated:?}");
        assert_eq!(replacement.next_now().as_deref(), Some("old"), "read again, and waited for from the start");
    }

    #[test]
    fn a_failed_switch_says_why_and_is_tried_again_only_when_asked() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        let failing = Supervisor { replacement: &replacement, steps: RefCell::default(), stop: Box::new(|_| anyhow::bail!("it did not exit")) };
        let error = switch(&replacement, &failing, "old", false).unwrap_err();
        assert_eq!(error, "Could not restart the TerminalX runtime: it did not exit");
        assert_eq!(failing.steps.borrow().last().map(String::as_str), Some("changed: outdated, failed"));
        let outdated = replacement.outdated("old").unwrap();
        assert_eq!((outdated.problem.as_deref(), outdated.failed), (Some(error.as_str()), true));
        assert_eq!(replacement.next_now(), None, "not by itself");
        // Restart now tries again, stopping whatever it runs.
        let forced = std::cell::Cell::new(None);
        let restart = Supervisor { replacement: &replacement, steps: RefCell::default(), stop: Box::new(|force| { forced.set(Some(force)); Ok(()) }) };
        assert_eq!(switch(&replacement, &restart, "old", true), Ok(()));
        assert_eq!(forced.get(), Some(true));
        assert_eq!(replacement.outdated("bundled"), None);
    }

    #[test]
    fn one_switch_at_a_time_and_only_from_the_older_runtime_attached() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())));
        assert!(replacement.begin("old"));
        assert!(!replacement.begin("old"));
        assert_eq!(shown(&replacement, connected("old")), updating());
        let reconnecting = ConnectionState::Connecting { terminal: false, attempt: 1, retry_in_ms: 0, down_ms: 0, message: "lost".into() };
        assert_eq!(shown(&replacement, reconnecting), updating(), "whatever else a window would say");
        assert_eq!(replacement.next_now(), None, "not checked while it is under way");
        let other = Replacement::default();
        assert!(!other.begin("bundled"), "nothing older attached");
    }

    fn sessions() -> Vec<SessionEntry> {
        vec![serde_json::from_value(json!({
            "id": "s1", "projectPath": "/p", "cwd": "/p", "title": "Fix login", "created": "2026-11-01T00:00:00Z", "modified": "2026-11-01T00:00:00Z",
            "tabs": [{ "id": "t1", "harness": "claude", "title": "Review", "created": "2026-11-01T00:00:00Z" },
                { "id": "t2", "harness": "codex", "title": "Fix login", "created": "2026-11-01T00:00:00Z" }],
        })).unwrap()]
    }

    #[test]
    fn work_is_named_by_what_it_is_and_where() {
        let sessions = sessions();
        let work = |kind, session: Option<&str>, tab: Option<&str>, harness: Option<&str>, title: Option<&str>| named(&sessions, &Work {
            kind, session_id: session.map(str::to_owned), tab_id: tab.map(str::to_owned), harness: harness.map(str::to_owned), title: title.map(str::to_owned),
        });
        let claude = crate::harness::display_name("claude");
        let codex = crate::harness::display_name("codex");
        assert_eq!(work(WorkKind::Turn, Some("s1"), Some("t1"), Some("claude"), None), format!("{claude} in \u{201c}Fix login\u{201d} (Review), in the middle of a turn"));
        assert_eq!(work(WorkKind::Prompt, Some("s1"), Some("t2"), Some("codex"), None), format!("{codex} in \u{201c}Fix login\u{201d}, with a prompt not yet delivered"), "a tab named as its session says it once");
        assert_eq!(work(WorkKind::Prompt, None, None, None, None), "A prompt from a phone, not yet delivered");
        assert_eq!(work(WorkKind::ByHand, Some("s1"), Some("t1"), Some("claude"), None), format!("{claude} started by hand in \u{201c}Fix login\u{201d} (Review)"));
        assert_eq!(work(WorkKind::Terminal, Some("s1"), None, None, Some("npm run dev")), "The terminal \u{201c}npm run dev\u{201d} in \u{201c}Fix login\u{201d}");
        assert_eq!(work(WorkKind::Terminal, Some("gone"), None, None, None), "A terminal");
        assert_eq!(work(WorkKind::Processes, Some("s1"), Some("t2"), Some("codex"), None), format!("Commands {codex} in \u{201c}Fix login\u{201d} left running"));
        assert_eq!(work(WorkKind::Processes, None, None, None, None), "Commands its agents left running, or processes that outlived what started them");
        assert_eq!(work(WorkKind::Pipeline, None, None, None, None), "An issue pipeline step");
    }

    /// #730 review: a runtime too old to say what it runs (0.2.22 and before)
    /// is judged by what it shows, in the shape a real 0.2.21 answers in.
    #[test]
    fn an_older_runtimes_turns_terminals_and_processes_are_read_from_what_it_shows() {
        let sessions = sessions();
        let claude = crate::harness::display_name("claude");
        let status = |tab_status: &str| json!({"pid": 100, "appVersion": "0.2.21",
            "runningTabs": [{"sessionId": "s1", "tabId": "t1", "harness": "claude", "status": tab_status}]});
        let shell = |exited: bool| crate::pty::ShellPane { id: "s1:1".into(), session_id: "s1".into(), title: Some("npm run dev".into()),
            renamed: false, cwd: "/p".into(), exited, created: "2026-11-01T00:00:00Z".into() };
        let table = |extra: &str| super::super::idle::parse(&format!("1 1 1 launchd\n100 1 100 terminalx-serve\n\
            200 100 200 claude\n201 200 200 npm exec @playwright/mcp\n202 201 200 node\n203 200 200 cua\n150 100 150 -zsh\n{extra}")).unwrap();
        // The runtime (100) runs an agent (200) with its MCP servers, and a terminal's shell (150).
        let settled = table("");
        let left = || "Commands its agents left running, or processes that outlived what started them".to_string();
        assert_eq!(shown_work(&sessions, &status("completed"), &[], &settled).unwrap(), Vec::<String>::new(), "a settled agent and its MCP servers may be stopped");
        assert_eq!(shown_work(&sessions, &status("idle"), &[shell(true)], &settled).unwrap(), Vec::<String>::new(), "a terminal whose shell exited is not running");
        assert_eq!(shown_work(&sessions, &status("in_progress"), &[], &settled).unwrap(), [format!("{claude} in \u{201c}Fix login\u{201d} (Review), in the middle of a turn")]);
        assert_eq!(shown_work(&sessions, &status("waiting"), &[shell(false)], &settled).unwrap(), [
            format!("{claude} in \u{201c}Fix login\u{201d} (Review), in the middle of a turn"),
            "The terminal \u{201c}npm run dev\u{201d} in \u{201c}Fix login\u{201d}".to_string(),
        ]);
        // A command the agent's tool started, still running in its shell.
        assert_eq!(shown_work(&sessions, &status("completed"), &[], &table("300 200 200 /bin/zsh\n301 300 200 node\n")).unwrap(), [left()]);
        // #730 review: a server whose shell exited, moved under launchd but still in the agent's group, which Stop All kills.
        assert_eq!(shown_work(&sessions, &status("completed"), &[], &table("400 1 200 node\n")).unwrap(), [left()]);
        assert_eq!(shown_work(&sessions, &status("completed"), &[], &table("999 1 999 node\n152 150 150 vim\n")).unwrap(), Vec::<String>::new(),
            "processes not the runtime's are not its work, and a terminal's program counts with its terminal");
        assert!(shown_work(&sessions, &json!({"pid": 100}), &[], &settled).is_err(), "a status without its tabs is no reading");
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
