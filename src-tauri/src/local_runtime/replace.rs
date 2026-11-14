//! Bringing the runtime along with an update (#730, #765).
//!
//! Since #467 the runtime outlives the app, and with agent tabs attached it
//! never goes idle, so an update left the previous release's runtime serving
//! the new app until the Mac restarted. Now, whenever the desktop attaches to
//! a runtime older than itself, it replaces that runtime with the one bundled
//! with it.
//!
//! A runtime that can be handed over (TerminalX 0.2.24 and later) is replaced
//! at once and in place (`handover`): the newer runtime takes over its
//! process, with every agent, terminal and turn it runs. Nothing is stopped.
//! What its handover record cannot carry (an agent driven over its standard
//! input and output) is never stopped by itself: every window names it, and
//! Restart now hands everything else over, stopping only that.
//!
//! An older one is replaced as before (#730): by itself only once nothing it
//! runs would be cut short, by the runtime's own idle rule: only managed
//! agents that have settled, with no process of their own running, may be
//! stopped without asking. Until then every window says the runtime is older
//! than the app, names what it is waiting for, and offers to restart it now.
//!
//! An agent's MCP and language servers are its own helpers, and start again
//! with it; what its tools started, in a shell, is work (`idle::working`).
//!
//! A runtime of 0.2.23 says what stopping it would cut short
//! (`runtime.work`), and stops only if nothing would, deciding under the lock
//! that admits work (`runtime.stopAllIfIdle`). One too old to (0.2.22 and
//! before) is judged by what it shows: its agents' turns, its open terminals,
//! and what its agents' tools left running, read again just before it is
//! stopped. It cannot show a prompt it holds, nor one a CLI holds for after
//! its turn, so nothing may be found under way for [`SETTLE`] before it is
//! replaced. Replacing it by itself never stops it without asking unless it
//! agreed to stop: anything that goes wrong before then leaves it running.
//!
//! Such a runtime is stopped as Stop All does (`launch::retire`); each agent
//! picks up its conversation again when its tab next starts, as after Restart
//! runtime. A runtime of the app's version or a newer one is attached as it
//! always was, so two builds sharing one home never take turns replacing each
//! other's runtime.
//!
//! An update made in the app decides about the runtime before it installs
//! (#766, `update_plan.rs`), and the app it relaunches into follows that
//! plan: it replaces the runtime as it attaches when Update now was chosen,
//! or when nothing was under way before the relaunch and still is; otherwise
//! it waits as above, without asking again. One that can be handed over
//! needs no plan to keep what it runs: Update now stops only what its
//! handover cannot carry. Windows show the wait in the status bar, and a
//! floating notice only when a switch failed.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use anyhow::Context;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::client::{Build, Refused};
use super::desktop::Desktop;
use super::update_plan::Plan;
use crate::session::retire::{Work, WorkKind};
use crate::store::index::SessionEntry;
use crate::AppState;

/// How often an older runtime is asked what it is running.
const CHECK_EVERY: Duration = Duration::from_secs(5);
/// A stuck old runtime cannot receive a lifecycle fix until it upgrades.
/// Bound its busy retries, then leave recovery to the reader (#818).
const BUSY_ATTEMPTS: u8 = 6;
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
    /// It is handed over rather than stopped (#765): replacing it keeps what
    /// it runs, and `work` names only what it cannot keep.
    pub keeps: bool,
    /// What `work` names, as the runtime names it, when it `keeps` what it
    /// runs: what Restart now stops, sent back as the reader was shown it.
    pub unkept: Vec<Work>,
}

/// The runtime is being replaced with the one bundled with this app.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Switching {
    pub from: Option<String>,
    pub to: String,
    /// Handed over: what it runs goes on (#765).
    pub keeping: bool,
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
    /// Update now was chosen before the update (#766): replace the older
    /// runtime at once, whatever it runs.
    forced: bool,
    /// What the update card listed that a handover cannot carry, which Update
    /// now agreed to stop (#765): only that is.
    planned_stop: Vec<Work>,
    /// The runtime whose handover to this app's runtime has been found
    /// possible once: it is not checked again each time it is read.
    verified: Option<String>,
    busy_attempts: u8,
    /// An older runtime was just handed over or stopped, and the next one
    /// attached should be the runtime bundled with this app.
    switched: bool,
    /// The runtime that came up after a switch was older than this app too:
    /// the bundled runtime itself is, as in a development build left running
    /// across a version bump. Switching again would only bring it back, so
    /// for as long as this app runs it is attached as it is.
    bundled_older: bool,
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

/// What the watch is to do next with the older runtime attached.
#[derive(Debug, PartialEq)]
pub(crate) enum Due {
    /// Read what it runs, and replace it once nothing would be cut short.
    Check(String),
    /// Replace it now, as was chosen before the update: whatever it runs, or,
    /// handed over, stopping only what the update card listed.
    Replace(String, Vec<Work>),
}

/// What the desktop knows about replacing the attached runtime, for every window.
#[derive(Default)]
pub struct Replacement {
    inner: Mutex<Inner>,
    wake: Condvar,
    #[cfg(test)]
    before_wait: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

/// This app's version, which its bundled runtime shares.
fn app_version() -> semver::Version {
    semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("the crate's own version is semantic")
}

impl Replacement {
    /// An attachment was published, to the runtime `epoch` of `build`.
    /// `plan` is what was decided about the runtime before an update, if one
    /// was left for this app (#766): it holds only for the runtime it was
    /// made for, and only while it is current.
    pub(crate) fn attached(&self, epoch: &str, build: &Build, plan: Option<&Plan>) {
        self.attached_at(epoch, build, plan, SystemTime::now(), Instant::now());
    }

    fn attached_at(&self, epoch: &str, build: &Build, plan: Option<&Plan>, clock: SystemTime, now: Instant) {
        let app = app_version();
        let mut inner = self.inner.lock().unwrap();
        inner.switching = None;
        inner.stopping = false;
        if !build.older_than(&app) {
            inner.pending = None;
            inner.quiet_since = None;
            inner.forced = false;
            inner.planned_stop.clear();
            inner.verified = None;
            inner.switched = false;
            return;
        }
        // Older again straight after a switch: what came up is the bundled
        // runtime, and it is no newer. Replacing it would hand it over to
        // itself, round and round, dropping the connection each time.
        if std::mem::take(&mut inner.switched) && !inner.bundled_older {
            let running = build.version.as_ref().map_or_else(|| "a version it would not say".to_string(), ToString::to_string);
            log::warn!("the runtime bundled with this app ({running}) is older than the app ({app}); it is attached as it is and not replaced again");
            inner.bundled_older = true;
        }
        if inner.bundled_older {
            inner.pending = None;
            inner.quiet_since = None;
            inner.forced = false;
            inner.planned_stop.clear();
            return;
        }
        let plan = plan.filter(|plan| plan.epoch == epoch && plan.current(clock));
        // A new attachment to the same older runtime keeps what was found.
        if inner.pending.as_ref().is_none_or(|(pending, _)| pending != epoch) {
            inner.busy_attempts = 0;
            // The runtime bundled with this app reads the record it writes.
            let keeps = keeps(build);
            let running = build.version.as_ref().map_or_else(|| "a version it would not say".to_string(), ToString::to_string);
            if keeps {
                let when = if plan.is_some_and(|plan| plan.forced) { " now, as was chosen before the update," } else { "" };
                log::warn!("the local runtime ({running}) is older than this app ({app}); it is handed over to this app's{when} keeping what it runs");
            } else {
                let when = match plan {
                    Some(plan) if plan.forced => "now, as was chosen before the update",
                    Some(_) => "once nothing it runs would be cut short, as was chosen before the update",
                    None => "once nothing it runs would be cut short",
                };
                log::warn!("the local runtime ({running}) is older than this app ({app}); it is replaced {when}");
            }
            inner.pending = Some((epoch.into(), Outdated {
                running: build.version.as_ref().map(ToString::to_string), app: app.to_string(), work: None, problem: None, failed: false, keeps, unkept: Vec::new(),
            }));
            // Nothing found under way by every reading before the relaunch
            // counts towards the wait for it to settle; the first reading
            // here still has to find nothing.
            inner.quiet_since = plan.and_then(|plan| plan.quiet_for(clock)).and_then(|quiet| now.checked_sub(quiet));
            inner.forced = plan.is_some_and(|plan| plan.forced);
            inner.planned_stop = plan.filter(|plan| plan.forced).map(|plan| plan.stop.clone()).unwrap_or_default();
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

    /// Whether runtime `epoch` is handed over rather than stopped (#765).
    fn keeps(&self, epoch: &str) -> bool {
        self.inner.lock().unwrap().outdated(epoch).is_some_and(|outdated| outdated.keeps)
    }

    /// What runtime `epoch`'s handover cannot carry, as just read, beside the
    /// names `work` gives it.
    fn kept_back(&self, epoch: &str, unkept: Vec<Work>) {
        if let Some(outdated) = self.inner.lock().unwrap().outdated(epoch) { outdated.unkept = unkept; }
    }

    /// Whether the handover of runtime `epoch` to this app's runtime was
    /// found possible already.
    fn verified(&self, epoch: &str) -> bool {
        self.inner.lock().unwrap().verified.as_deref() == Some(epoch)
    }

    fn verify_done(&self, epoch: &str) {
        self.inner.lock().unwrap().verified = Some(epoch.into());
    }

    /// The handover of runtime `epoch` was refused: something it cannot
    /// carry came up, or the runtime was replaced meanwhile (#765).
    /// Whatever failed before, what it runs is read again and shown.
    fn handover_refused(&self, epoch: &str) {
        self.declined(epoch, None);
        let mut inner = self.inner.lock().unwrap();
        if let Some(outdated) = inner.outdated(epoch) {
            outdated.failed = false;
            inner.busy_attempts = 0;
        }
        drop(inner);
        // A manual retry can make a failed replacement checkable again
        // while the watcher is parked without a timeout.
        self.wake.notify_all();
    }

    /// A stop may already have succeeded before collecting the handover
    /// failed. Never claim nothing stopped, or turn that consent into a
    /// stop-all. Give transitions time, then show the exact blocker and the
    /// existing explicit recovery action instead of looping indefinitely.
    fn handover_busy(&self, epoch: &str, problem: String) {
        let mut inner = self.inner.lock().unwrap();
        if inner.outdated(epoch).is_none() { return; }
        inner.switching = None;
        inner.stopping = false;
        inner.quiet_since = None;
        inner.due = false;
        inner.busy_attempts = inner.busy_attempts.saturating_add(1);
        if inner.busy_attempts >= BUSY_ATTEMPTS {
            let outdated = inner.outdated(epoch).expect("checked above");
            outdated.failed = true;
            outdated.problem = Some(format!("The runtime update is still blocked: {problem}. Try again after the agent settles. If it remains blocked, choose TerminalX → Stop all and quit, then reopen TerminalX. That action stops all agents and terminal commands; no full stop has been performed automatically."));
        } else {
            inner.outdated(epoch).expect("checked above").failed = false;
        }
        drop(inner);
        // Resume the watcher's timed checks after a refused manual retry;
        // due stays false, so the normal busy retry interval still applies.
        self.wake.notify_all();
    }

    fn retry_requested(&self, epoch: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.outdated(epoch).is_some() { inner.busy_attempts = 0; }
    }

    /// Runtime `epoch` cannot be handed over to this app's after all, for
    /// `problem`: it is replaced as one from before handovers is (#730).
    fn cannot_keep(&self, epoch: &str, problem: String) {
        let mut inner = self.inner.lock().unwrap();
        inner.quiet_since = None;
        inner.due = true;
        if let Some(outdated) = inner.outdated(epoch) {
            log::warn!("the local runtime cannot be handed over, so it is replaced once nothing it runs would be cut short: {problem}");
            outdated.keeps = false;
            outdated.work = None;
            outdated.unkept.clear();
            outdated.problem = Some(problem);
        }
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
        let switching = Switching { from: outdated.running.clone(), to: outdated.app.clone(), keeping: outdated.keeps };
        inner.switching = Some(switching);
        inner.stopping = true;
        true
    }

    /// The older runtime has gone: the switch ends with the next attachment,
    /// or with a failure to make one.
    fn stopped(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.stopping = false;
        inner.switched = true;
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
        inner.forced = false;
        inner.switching = None;
        inner.stopping = false;
        inner.quiet_since = None;
        if let Some(outdated) = inner.outdated(epoch) {
            outdated.problem = Some(problem);
            outdated.failed = true;
        }
    }

    /// What to do next with the older runtime attached: replace it at once
    /// when Update now was chosen for it, or else check it at once when it
    /// was just attached, and every [`CHECK_EVERY`] after that. Waits while
    /// there is none.
    fn next(&self) -> Due {
        let mut inner = self.inner.lock().unwrap();
        loop {
            if inner.checkable().is_none() {
                // Signal while still holding inner: a test that receives this
                // cannot change the predicate until wait atomically unlocks.
                #[cfg(test)]
                if let Some(waiting) = self.before_wait.lock().unwrap().take() { waiting.send(()).unwrap(); }
                inner = self.wake.wait(inner).unwrap();
                continue;
            }
            if std::mem::take(&mut inner.forced) {
                inner.due = false;
                let stop = std::mem::take(&mut inner.planned_stop);
                return Due::Replace(inner.checkable().expect("checked above").to_owned(), stop);
            }
            if std::mem::take(&mut inner.due) {
                return Due::Check(inner.checkable().expect("checked above").to_owned());
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
    if let Some(Switching { from, to, keeping }) = replacement.switching() {
        return ConnectionState::Updating { from, to, keeping };
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
    /// Hand runtime `epoch` over to the one bundled with this app, in its
    /// own process, and wait until that one answers (#765). Nothing is
    /// stopped but what of `stop` the handover cannot carry: the reader was
    /// shown it and agreed. Anything else it cannot carry refuses it
    /// (`handover_unadoptable`), with nothing stopped.
    fn hand_over(&self, epoch: &str, stop: &[Work]) -> anyhow::Result<()>;
    /// Runtime `epoch` has gone: let its attachment go and attach the
    /// bundled runtime in its place.
    fn reattach(&self, epoch: &str);
    /// Windows read their status again.
    fn changed(&self);
}

/// Replace the older runtime `epoch` with the one bundled with this app.
/// `forced` is Restart now: whatever it runs stops with it, unless it can be
/// handed over, when only what of `stop` its handover cannot carry does:
/// `stop` is what the reader was shown. Otherwise it is stopped only if
/// nothing would be cut short, and work found meanwhile puts the switch off,
/// which is no failure. Nothing happens when it is no longer the one
/// attached, or not older. The caller holds `ui::RESTART`.
pub(crate) fn switch(replacement: &Replacement, host: &impl Host, epoch: &str, forced: bool, stop: &[Work]) -> Result<(), String> {
    let keeps = replacement.keeps(epoch);
    if !replacement.begin(epoch) { return Ok(()); }
    if forced { replacement.retry_requested(epoch); }
    host.changed();
    // Handed over, it keeps what it runs; stopped, Restart now stops all of it.
    let result = if keeps { host.hand_over(epoch, if forced { stop } else { &[] }) } else { host.retire(epoch, forced) };
    let outcome = match result {
        Ok(()) => {
            if keeps {
                log::info!("handed the older local runtime over to the one bundled with this app; attaching it");
            } else {
                log::info!("stopped the older local runtime; attaching the one bundled with this app");
            }
            replacement.stopped();
            host.reattach(epoch);
            Ok(())
        }
        // The bundled runtime cannot take this one over after all: it is
        // replaced as one from before handovers is, nothing stopped yet.
        Err(error) if keeps && super::launch::refused(&error, "handover_unsupported") => {
            replacement.declined(epoch, None);
            replacement.cannot_keep(epoch, format!("{error:#}"));
            Ok(())
        }
        Err(error) if keeps && super::launch::refused(&error, "handover_busy") => {
            log::info!("the older local runtime is waiting to hand over: {error:#}");
            replacement.handover_busy(epoch, format!("{error:#}"));
            Ok(())
        }
        // Something it cannot carry came up, or it was replaced meanwhile:
        // read what remains again, without broadening the approved stops.
        Err(error) if keeps && ["handover_unadoptable", "runtime_restarted"].iter().any(|code| super::launch::refused(&error, code)) => {
            log::info!("the older local runtime was not handed over yet: {error:#}");
            replacement.handover_refused(epoch);
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
    // Handed over, nothing is cut short: it is replaced as soon as nothing
    // it cannot carry is running, with no wait for its turns to end (#765).
    if quiet && (replacement.keeps(epoch) || replacement.settled(epoch, now)) {
        if let Err(error) = switch() { log::warn!("replace the older local runtime: {error}"); }
        return false;
    }
    changed
}

/// Ask an older attached runtime, every few seconds, what it is running, and
/// replace it once nothing would be cut short; or at once, when Update now
/// was chosen for it before the update (#766).
pub(crate) fn watch(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("local-runtime-replacement".into()).spawn(move || loop {
        let state = app.state::<AppState>();
        let epoch = match state.runtime_replacement.next() {
            Due::Replace(epoch, stop) => {
                let _one = super::ui::RESTART.blocking_lock();
                if let Err(error) = switch(&state.runtime_replacement, &AppHost(&app), &epoch, true, &stop) { log::warn!("replace the older local runtime: {error}"); }
                continue;
            }
            Due::Check(epoch) => epoch,
        };
        let Some(runtime) = state.runtime().filter(|runtime| runtime.epoch() == epoch && runtime.attachment().is_ok()) else { continue };
        let replacement = &state.runtime_replacement;
        let read = if replacement.keeps(&epoch) {
            // Whether it can be handed over at all is asked the first time.
            let verify = !replacement.verified(&epoch);
            kept_back(&app, &runtime, verify).map(|(unkept, named)| {
                if verify { replacement.verify_done(&epoch); }
                replacement.kept_back(&epoch, unkept);
                named
            })
        } else { work(&runtime) };
        // The bundled runtime cannot take this one over: replaced as before.
        if let Err(error) = &read {
            if super::launch::refused(error, "handover_unsupported") {
                state.runtime_replacement.cannot_keep(&epoch, format!("{error:#}"));
                let _ = app.emit("local_runtime_state", ());
                continue;
            }
        }
        let changed = check(&state.runtime_replacement, &epoch, read, Instant::now(), || {
            let _one = super::ui::RESTART.blocking_lock();
            switch(&state.runtime_replacement, &AppHost(&app), &epoch, false, &[])
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

    fn hand_over(&self, epoch: &str, stop: &[Work]) -> anyhow::Result<()> {
        let state = self.0.state::<AppState>();
        let Some(runtime) = state.runtime().filter(|runtime| runtime.epoch() == epoch) else {
            return Err(Refused { code: "runtime_restarted".into(), message: "Another runtime was attached meanwhile.".into() }.into());
        };
        hand_over(self.0, &runtime, stop)
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

/// Hand `runtime` over to the runtime bundled with this app and wait until
/// that one answers in its place (#765). What of `stop` the handover cannot
/// carry is stopped first: the reader was shown it and agreed. Anything else
/// it cannot carry refuses the handover, with nothing stopped.
pub(crate) fn hand_over(app: &AppHandle, runtime: &Desktop, stop: &[Work]) -> anyhow::Result<()> {
    hand_over_within(app, runtime, stop, None)
}

/// [`hand_over`], given `within` to say it is handing over, when it is one
/// that may not answer at all.
pub(crate) fn hand_over_within(app: &AppHandle, runtime: &Desktop, stop: &[Work], within: Option<Duration>) -> anyhow::Result<()> {
    let home = crate::store::root()?;
    let binary = super::supervisor::bundled(app, &home)?;
    runtime.hand_over(&binary, stop, within)?;
    super::launch::taken_over(&home, runtime.epoch(), TAKE_OVER)
}

/// Whether `build` can be handed over to the runtime bundled with this app.
pub(crate) fn keeps(build: &super::client::Build) -> bool {
    build.handover.is_some_and(|format| super::handover::FORMATS.contains(&format))
}

/// How long the runtime taking over has to answer after a handover: it
/// starts from a binary that may be new to this Mac's security checks.
const TAKE_OVER: Duration = Duration::from_secs(60);

/// What `runtime` cannot keep running through a handover to this app's
/// runtime (#765): as the runtime names it, and by name for a person. When
/// `verify`, the runtime also checks that this app's runtime can take it over
/// at all, which costs a check of that binary's contents and signature.
pub(crate) fn kept_back(app: &AppHandle, runtime: &Desktop, verify: bool) -> anyhow::Result<(Vec<Work>, Vec<String>)> {
    let binary = if verify { Some(super::supervisor::bundled(app, &crate::store::root()?)?) } else { None };
    let unkept = runtime.handover_plan(binary.as_deref())?;
    let sessions = crate::store::index::load().unwrap_or_default();
    let named = unkept.iter().map(|work| named(&sessions, work)).collect();
    Ok((unkept, named))
}

/// What moving `runtime` to the runtime bundled with this app would cut
/// short, by name, read before an update installs (#766) as the watch reads
/// it: what its handover cannot carry when it can be handed over (#765), or
/// else what stopping it would. The first is also given as the runtime names
/// it, for Update now to stop only what the update card listed.
pub(super) fn cut_short(app: &AppHandle, runtime: &Desktop) -> anyhow::Result<(Vec<String>, Vec<Work>)> {
    if keeps(runtime.build()) {
        match kept_back(app, runtime, true) {
            // The bundled runtime cannot take it over: it is stopped instead.
            Err(error) if super::launch::refused(&error, "handover_unsupported") => {}
            read => return read.map(|(unkept, named)| (named, unkept)),
        }
    }
    work(runtime).map(|named| (named, Vec::new()))
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
pub(super) fn work(runtime: &Desktop) -> anyhow::Result<Vec<String>> {
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
        Build { version, mobile: Default::default(), handover: None }
    }

    /// A build that writes this app's handover record (#765).
    fn handing(version: &str) -> Build {
        Build { handover: Some(super::super::handover::FORMAT), ..build(Some(version)) }
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
        ConnectionState::Updating { from: Some(older()), to: env!("CARGO_PKG_VERSION").into(), keeping: false }
    }

    #[test]
    fn only_a_runtime_older_than_the_app_is_replaced() {
        let replacement = Replacement::default();
        replacement.attached("same", &build(Some(env!("CARGO_PKG_VERSION"))), None);
        assert_eq!(replacement.outdated("same"), None);
        assert_eq!(replacement.next_now(), None, "nothing to check");
        let mut newer = app_version();
        newer.minor += 1;
        replacement.attached("newer", &build(Some(&newer.to_string())), None);
        assert_eq!(replacement.outdated("newer"), None, "a newer runtime is never replaced by an older app");

        replacement.attached("old", &build(Some(&older())), None);
        let outdated = replacement.outdated("old").expect("an older runtime is");
        assert_eq!((outdated.running, outdated.app, outdated.work, outdated.failed, outdated.keeps), (Some(older()), env!("CARGO_PKG_VERSION").to_string(), None, false, false));
        assert_eq!(replacement.next_now(), Some(Due::Check("old".into())), "checked at once");
        assert_eq!(replacement.outdated("another"), None, "only windows attached to it are told");

        replacement.attached("unsaid", &build(None), None);
        assert_eq!(replacement.outdated("unsaid").unwrap().running, None, "one that would not say is taken for older");
        // Its replacement, of this app's version, clears it.
        replacement.attached("bundled", &build(Some(env!("CARGO_PKG_VERSION"))), None);
        assert_eq!(replacement.outdated("unsaid"), None);
    }

    /// A runtime that comes up older straight after a switch is the bundled
    /// one, and no newer: it is attached as it is, not handed over to itself
    /// again and again (a development build left running across a version bump).
    #[test]
    fn a_bundled_runtime_older_than_the_app_is_not_switched_round_and_round() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())), None);
        assert!(replacement.outdated("old").is_some());
        assert!(replacement.begin("old"));
        replacement.stopped();
        // What came up in its place is just as old.
        replacement.attached("bundled", &build(Some(&older())), None);
        assert_eq!(replacement.outdated("bundled"), None, "not replaced again");
        assert_eq!(replacement.switching(), None);
        assert_eq!(replacement.next_now(), None, "nothing left to check");
        // Nor on a later attachment, for as long as the app runs.
        replacement.attached("bundled-again", &build(Some(&older())), None);
        assert_eq!(replacement.outdated("bundled-again"), None);

        // One older runtime replaced by a current one is the normal case: nothing is held back.
        let normal = Replacement::default();
        normal.attached("old", &build(Some(&older())), None);
        assert!(normal.begin("old"));
        normal.stopped();
        normal.attached("bundled", &build(Some(env!("CARGO_PKG_VERSION"))), None);
        normal.attached("older-later", &build(Some(&older())), None);
        assert!(normal.outdated("older-later").is_some(), "a later older runtime is still replaced");
    }

    /// #730 review: anything the runtime would cut short is waited for, a
    /// reading that found nothing must hold for SETTLE, and one that failed
    /// never switches.
    #[test]
    fn an_older_runtime_is_switched_only_once_nothing_has_been_under_way_for_a_while() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())), None);
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
        /// What each handover was told to stop.
        stopped: RefCell<Vec<Vec<Work>>>,
    }

    impl<'a> Supervisor<'a> {
        fn new(replacement: &'a Replacement, stop: impl Fn(bool) -> anyhow::Result<()> + 'a) -> Self {
            Self { replacement, stop: Box::new(stop), steps: RefCell::default(), stopped: RefCell::default() }
        }
    }

    impl Supervisor<'_> {
        fn note(&self, step: &str) {
            let shown = match shown(self.replacement, connected("old")) {
                ConnectionState::Updating { keeping: true, .. } => "updating, keeping".to_string(),
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
        fn hand_over(&self, epoch: &str, stop: &[Work]) -> anyhow::Result<()> {
            assert_eq!(epoch, "old");
            // The runtime is the same process, so the supervisor's attempts
            // reach it throughout; the event connection drops at the exec.
            self.replacement.attach_failed();
            self.note(if stop.is_empty() { "hand over" } else { "hand over, stopping the unkept" });
            self.stopped.borrow_mut().push(stop.to_vec());
            (self.stop)(!stop.is_empty())
        }
        fn reattach(&self, _epoch: &str) {
            self.note("reattach");
            // The bundled runtime is slow to start the first time, then attaches.
            self.replacement.attach_failed();
            self.note("bundled failed to attach once");
            self.replacement.attached("bundled", &build(Some(env!("CARGO_PKG_VERSION"))), None);
        }
        fn changed(&self) { self.note("changed"); }
    }

    /// #730 review: the switch's steps against an older runtime attached,
    /// with the supervisor's attempts to attach interleaved as in the app.
    #[test]
    fn a_switch_stops_the_older_runtime_then_attaches_the_bundled_one_and_windows_follow() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())), None);
        let forced = std::cell::Cell::new(None);
        let supervisor = Supervisor { replacement: &replacement, stop: Box::new(|force| { forced.set(Some(force)); Ok(()) }), steps: RefCell::default(), stopped: RefCell::default() };
        assert_eq!(switch(&replacement, &supervisor, "old", false, &[]), Ok(()));
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
        let late = Supervisor { replacement: &replacement, stop: Box::new(|_| panic!("nothing is stopped")), steps: RefCell::default(), stopped: RefCell::default() };
        assert_eq!(switch(&replacement, &late, "old", true, &[]), Ok(()));
        assert!(late.steps.borrow().is_empty());
    }

    #[test]
    fn work_found_as_the_runtime_stops_puts_the_switch_off_without_stopping_anything() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())), None);
        let busy = Supervisor { replacement: &replacement, stopped: RefCell::default(), steps: RefCell::default(), stop: Box::new(|_| {
            Err(anyhow::Error::from(Refused { code: "runtime_busy".into(), message: "an agent is mid-turn".into() })
                .context(super::super::launch::LeftRunning("The TerminalX runtime has work under way; nothing was stopped.")))
        }) };
        assert_eq!(switch(&replacement, &busy, "old", false, &[]), Ok(()), "no failure");
        assert_eq!(*busy.steps.borrow(), ["changed: updating", "retire: updating", "changed: outdated"], "never reattached");
        let outdated = replacement.outdated("old").unwrap();
        assert!(!outdated.failed && outdated.problem.is_none());
        assert_eq!(replacement.next_now(), Some(Due::Check("old".into())), "read again at once, and waited for from the start");
        assert!(!replacement.settled("old", Instant::now() + SETTLE));
    }

    /// #730 review: replacing it by itself, a failure before the runtime
    /// agreed to stop leaves it running; it is neither stopped nor taken for
    /// a failed switch, and the reason is shown.
    #[test]
    fn a_runtime_left_running_by_a_failure_before_it_agreed_is_waited_for_again() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())), None);
        let left = Supervisor { replacement: &replacement, stopped: RefCell::default(), steps: RefCell::default(), stop: Box::new(|_| {
            Err(anyhow::anyhow!("The TerminalX runtime did not answer status within 15 seconds.")
                .context(super::super::launch::LeftRunning("The TerminalX runtime did not agree to stop; nothing was stopped.")))
        }) };
        assert_eq!(switch(&replacement, &left, "old", false, &[]), Ok(()));
        assert_eq!(*left.steps.borrow(), ["changed: updating", "retire: updating", "changed: outdated"], "never reattached");
        let outdated = replacement.outdated("old").unwrap();
        assert!(!outdated.failed, "not a failed switch: nothing was stopped");
        assert!(outdated.problem.as_deref().is_some_and(|problem| problem.contains("did not agree to stop") && problem.contains("15 seconds")), "{outdated:?}");
        assert_eq!(replacement.next_now(), Some(Due::Check("old".into())), "read again, and waited for from the start");
    }

    #[test]
    fn a_failed_switch_says_why_and_is_tried_again_only_when_asked() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())), None);
        let failing = Supervisor { replacement: &replacement, stopped: RefCell::default(), steps: RefCell::default(), stop: Box::new(|_| anyhow::bail!("it did not exit")) };
        let error = switch(&replacement, &failing, "old", false, &[]).unwrap_err();
        assert_eq!(error, "Could not restart the TerminalX runtime: it did not exit");
        assert_eq!(failing.steps.borrow().last().map(String::as_str), Some("changed: outdated, failed"));
        let outdated = replacement.outdated("old").unwrap();
        assert_eq!((outdated.problem.as_deref(), outdated.failed), (Some(error.as_str()), true));
        assert_eq!(replacement.next_now(), None, "not by itself");
        // Restart now tries again, stopping whatever it runs.
        let forced = std::cell::Cell::new(None);
        let restart = Supervisor { replacement: &replacement, stopped: RefCell::default(), steps: RefCell::default(), stop: Box::new(|force| { forced.set(Some(force)); Ok(()) }) };
        assert_eq!(switch(&replacement, &restart, "old", true, &[]), Ok(()));
        assert_eq!(forced.get(), Some(true));
        assert_eq!(replacement.outdated("bundled"), None);
    }

    #[test]
    fn one_switch_at_a_time_and_only_from_the_older_runtime_attached() {
        let replacement = Replacement::default();
        replacement.attached("old", &build(Some(&older())), None);
        assert!(replacement.begin("old"));
        assert!(!replacement.begin("old"));
        assert_eq!(shown(&replacement, connected("old")), updating());
        let reconnecting = ConnectionState::Connecting { terminal: false, attempt: 1, retry_in_ms: 0, down_ms: 0, message: "lost".into() };
        assert_eq!(shown(&replacement, reconnecting), updating(), "whatever else a window would say");
        assert_eq!(replacement.next_now(), None, "not checked while it is under way");
        let other = Replacement::default();
        assert!(!other.begin("bundled"), "nothing older attached");
    }

    /// #765: a runtime that can be handed over is replaced as soon as
    /// nothing it cannot carry is running, mid-turn or not, with no settling
    /// wait, and keeping what it runs.
    #[test]
    fn a_runtime_that_can_be_handed_over_is_handed_over_at_once_and_keeps_what_it_runs() {
        let replacement = Replacement::default();
        replacement.attached("old", &handing(&older()), None);
        assert!(replacement.outdated("old").unwrap().keeps);
        let switched = std::cell::Cell::new(0);
        assert!(!check(&replacement, "old", Ok(vec![]), Instant::now(), || { switched.set(switched.get() + 1); Ok(()) }), "the switch tells windows itself");
        assert_eq!(switched.get(), 1, "no wait for turns to end: they go on");

        let replacement = Replacement::default();
        replacement.attached("old", &handing(&older()), None);
        let stopping = std::cell::Cell::new(None);
        let supervisor = Supervisor::new(&replacement, |stop| { stopping.set(Some(stop)); Ok(()) });
        assert_eq!(switch(&replacement, &supervisor, "old", false, &[]), Ok(()));
        assert_eq!(stopping.get(), Some(false), "by itself it stops nothing");
        assert_eq!(*supervisor.steps.borrow(), [
            "changed: updating, keeping",
            "hand over: updating, keeping",
            "reattach: updating, keeping",
            "bundled failed to attach once: outdated",
            "changed: connected",
        ]);
        assert_eq!(replacement.next_now(), None, "nothing left to replace");
    }

    /// #765: what a handover cannot carry is named and never stopped by
    /// itself; Restart now hands the rest over, stopping only that.
    #[test]
    fn what_a_handover_cannot_carry_is_named_and_stopped_only_when_asked() {
        let replacement = Replacement::default();
        replacement.attached("old", &handing(&older()), None);
        let unkept = || Ok(vec!["Codex in \u{201c}Web\u{201d}, in the middle of a turn".to_string()]);
        let start = Instant::now();
        replacement.kept_back("old", vec![stdio("s1", "t1")]);
        assert!(check(&replacement, "old", unkept(), start, || panic!("never by itself")));
        assert!(!check(&replacement, "old", unkept(), start + 100 * CHECK_EVERY, || panic!("never by itself")));
        let outdated = replacement.outdated("old").unwrap();
        assert_eq!(outdated.work.unwrap().len(), 1, "named for the reader");
        assert_eq!(outdated.unkept, [stdio("s1", "t1")], "and as the runtime names it, for the window to send back");
        let restart = Supervisor::new(&replacement, |_| Ok(()));
        // Restart now sends what the window showed: only that is stopped.
        assert_eq!(switch(&replacement, &restart, "old", true, &outdated.unkept), Ok(()));
        assert_eq!(*restart.stopped.borrow(), [vec![stdio("s1", "t1")]]);
        assert_eq!(restart.steps.borrow()[1], "hand over, stopping the unkept: updating, keeping");
    }

    /// #765 review: Restart now after a failed handover, or with an agent
    /// started since the window last showed what would stop, stops nothing
    /// it was not shown: the runtime refuses, and what it cannot carry is
    /// read and shown again.
    #[test]
    fn restart_now_stops_only_what_the_window_showed_and_a_refusal_shows_it_again() {
        let replacement = Replacement::default();
        replacement.attached("old", &handing(&older()), None);
        let failing = Supervisor::new(&replacement, |_| anyhow::bail!("the updated TerminalX runtime did not answer after the handover"));
        assert!(switch(&replacement, &failing, "old", false, &[]).is_err());
        assert!(replacement.outdated("old").unwrap().failed);
        assert_eq!(replacement.next_now(), None, "a failed switch is not tried by itself");
        // Try again: the window showed nothing to stop, and an agent the
        // handover cannot carry has started since.
        let refused = Supervisor::new(&replacement, |_| Err(Refused { code: "handover_unadoptable".into(), message: "1 agent(s) cannot be kept running".into() }.into()));
        assert_eq!(switch(&replacement, &refused, "old", true, &[]), Ok(()), "no failure: nothing was stopped");
        assert_eq!(*refused.stopped.borrow(), [Vec::<Work>::new()], "nothing it was not shown");
        let outdated = replacement.outdated("old").unwrap();
        assert!(!outdated.failed, "{outdated:?}");
        assert_eq!(replacement.next_now(), Some(Due::Check("old".into())), "read again, to be shown");
    }

    /// #818: an already-running old runtime cannot receive the cleanup fix
    /// until it upgrades. Do not hammer that runtime or broaden stop consent
    /// when its lifecycle state never settles.
    #[test]
    fn repeated_busy_handovers_pause_with_recovery_and_allow_an_explicit_retry() {
        let replacement = Replacement::default();
        replacement.attached("old", &handing(&older()), None);
        let busy = Supervisor::new(&replacement, |_| Err(Refused {
            code: "handover_busy".into(), message: "The agent in session/tab is starting or stopping".into(),
        }.into()));
        for attempt in 1..=6 {
            switch(&replacement, &busy, "old", false, &[]).unwrap();
            assert_eq!(replacement.next_now(), None, "busy attempts wait for the periodic check, never immediately retry");
            assert_eq!(replacement.outdated("old").unwrap().failed, attempt == 6);
        }
        let outdated = replacement.outdated("old").unwrap();
        assert!(outdated.keeps, "a busy handover never authorizes a full stop");
        let problem = outdated.problem.unwrap();
        assert!(problem.contains("session/tab") && problem.contains("Stop all and quit"), "{problem}");
        replacement.attached("old", &handing(&older()), None);
        assert_eq!(replacement.next_now(), None, "reattaching the same runtime does not restart the loop");
        assert!(busy.steps.borrow().iter().all(|step| !step.starts_with("retire")));
        let retry = Supervisor::new(&replacement, |_| Ok(()));
        switch(&replacement, &retry, "old", true, &[]).unwrap();
        assert!(replacement.outdated("old").is_none(), "an explicit retry can still hand over safely");
    }

    fn refused_manual_retry_wakes_the_waiting_loop(code: &'static str) {
        use std::sync::{mpsc, Arc};
        let replacement = Arc::new(Replacement::default());
        replacement.attached("old", &handing(&older()), None);
        let refusal = |code: &'static str| move |_| Err(Refused { code: code.into(), message: "still blocked".into() }.into());
        let busy = Supervisor::new(&replacement, refusal("handover_busy"));
        for _ in 0..BUSY_ATTEMPTS { switch(&replacement, &busy, "old", false, &[]).unwrap(); }
        assert!(replacement.outdated("old").unwrap().failed);

        let (waiting, parked) = mpsc::channel();
        *replacement.before_wait.lock().unwrap() = Some(waiting);
        let (returned, result) = mpsc::channel();
        let watcher = replacement.clone();
        let thread = std::thread::spawn(move || {
            let due = watcher.next();
            returned.send((due, Instant::now())).unwrap();
        });
        parked.recv_timeout(Duration::from_secs(2)).unwrap();
        let retried = Instant::now();
        let retry = Supervisor::new(&replacement, refusal(code));
        switch(&replacement, &retry, "old", true, &[]).unwrap();
        assert!(!replacement.outdated("old").unwrap().failed);
        let outcome = result.recv_timeout(CHECK_EVERY + Duration::from_secs(2));
        // Also join on failure: this regression must not leak a sleeping
        // watcher when the production notification is missing.
        if outcome.is_err() {
            replacement.inner.lock().unwrap().due = true;
            replacement.wake.notify_all();
        }
        thread.join().unwrap();
        let (due, returned_at) = outcome.expect("a refused manual retry must wake the paused watcher");
        assert_eq!(due, Due::Check("old".into()));
        if code == "handover_busy" {
            assert!(returned_at.duration_since(retried) >= CHECK_EVERY, "waking the watcher must preserve the busy retry delay");
        }
        assert!(retry.steps.borrow().iter().all(|step| !step.starts_with("retire")), "no broader stop consent");
    }

    #[test]
    fn manual_busy_retry_wakes_the_paused_watcher() {
        refused_manual_retry_wakes_the_waiting_loop("handover_busy");
    }

    #[test]
    fn manual_unadoptable_retry_wakes_the_paused_watcher() {
        refused_manual_retry_wakes_the_waiting_loop("handover_unadoptable");
    }

    /// #765: a handover refused for something it cannot carry, or for work
    /// still settling, stops nothing and is no failure; one the bundled
    /// runtime cannot take over at all is replaced as before handovers.
    #[test]
    fn a_handover_refused_stops_nothing_and_one_impossible_falls_back_to_stopping_when_idle() {
        let refusal = |code: &'static str| move |_| -> anyhow::Result<()> { Err(Refused { code: code.into(), message: "refused".into() }.into()) };
        for code in ["handover_busy", "handover_unadoptable", "runtime_restarted"] {
            let replacement = Replacement::default();
            replacement.attached("old", &handing(&older()), None);
            let busy = Supervisor::new(&replacement, refusal(code));
            assert_eq!(switch(&replacement, &busy, "old", false, &[]), Ok(()), "{code}");
            assert_eq!(busy.steps.borrow().last().map(String::as_str), Some("changed: outdated"), "{code}: never reattached");
            let outdated = replacement.outdated("old").unwrap();
            assert!(!outdated.failed && outdated.keeps && outdated.problem.is_none(), "{code}: {outdated:?}");
            let next = if code == "handover_busy" { None } else { Some(Due::Check("old".into())) };
            assert_eq!(replacement.next_now(), next, "{code}: busy waits for the periodic check");
        }
        let replacement = Replacement::default();
        replacement.attached("old", &handing(&older()), None);
        let impossible = Supervisor::new(&replacement, refusal("handover_unsupported"));
        assert_eq!(switch(&replacement, &impossible, "old", false, &[]), Ok(()));
        let outdated = replacement.outdated("old").unwrap();
        assert!(!outdated.keeps && !outdated.failed && outdated.problem.is_some(), "{outdated:?}");
        // From now on it waits until nothing would be cut short, as before.
        let start = Instant::now();
        assert!(check(&replacement, "old", Ok(vec![]), start, || panic!("not before SETTLE")));
        let retired = std::cell::Cell::new(false);
        let stop = Supervisor::new(&replacement, |forced| { assert!(!forced); retired.set(true); Ok(()) });
        check(&replacement, "old", Ok(vec![]), start + SETTLE, || switch(&replacement, &stop, "old", false, &[]));
        assert!(retired.get());
        assert_eq!(stop.steps.borrow()[1], "retire: updating");
    }

    /// #765: a handover that failed for any other reason says why, and is
    /// tried again only when asked.
    #[test]
    fn a_failed_handover_says_why_and_is_tried_again_only_when_asked() {
        let replacement = Replacement::default();
        replacement.attached("old", &handing(&older()), None);
        let failing = Supervisor::new(&replacement, |_| anyhow::bail!("the updated TerminalX runtime did not answer after the handover"));
        let error = switch(&replacement, &failing, "old", false, &[]).unwrap_err();
        assert!(error.contains("did not answer after the handover"), "{error}");
        let outdated = replacement.outdated("old").unwrap();
        assert!(outdated.failed && outdated.keeps);
        assert_eq!(replacement.next_now(), None, "not by itself");
    }

    /// What the app that installed an update left for this one (#766).
    fn plan(epoch: &str, forced: bool, quiet_for: Option<Duration>, clock: SystemTime) -> Plan {
        let millis = super::super::update_plan::millis;
        Plan { epoch: epoch.into(), forced, quiet_since: quiet_for.map(|quiet| millis(clock - quiet)), made_at: millis(clock - Duration::from_secs(3)), made_by: 1, stop: Vec::new() }
    }

    /// An agent driven over its standard input and output, which a handover
    /// cannot carry.
    fn stdio(session: &str, tab: &str) -> Work {
        Work { kind: WorkKind::Turn, session_id: Some(session.into()), tab_id: Some(tab.into()), harness: Some("gemini".into()), title: None }
    }

    /// #766: Update now was chosen, listing what it stops: the relaunched app
    /// replaces the older runtime as it attaches, whatever it runs, and asks
    /// nothing.
    #[test]
    fn update_now_chosen_before_the_update_replaces_the_older_runtime_as_it_attaches() {
        let replacement = Replacement::default();
        let clock = SystemTime::now();
        replacement.attached_at("old", &build(Some(&older())), Some(&plan("old", true, None, clock)), clock, Instant::now());
        assert_eq!(replacement.next_now(), Some(Due::Replace("old".into(), vec![])), "at once, without reading what it runs first");
        assert_eq!(replacement.next_now(), None, "once");
        let forced = std::cell::Cell::new(None);
        let supervisor = Supervisor { replacement: &replacement, stop: Box::new(|force| { forced.set(Some(force)); Ok(()) }), steps: RefCell::default(), stopped: RefCell::default() };
        assert_eq!(switch(&replacement, &supervisor, "old", true, &[]), Ok(()));
        assert_eq!(forced.get(), Some(true), "whatever it runs stops with it");
        assert_eq!(supervisor.steps.borrow().last().map(String::as_str), Some("changed: connected"));
        assert_eq!(replacement.outdated("bundled"), None, "no notice follows: the bundled runtime is attached");
    }

    /// #765 with #766: Update now chosen for a runtime that can be handed
    /// over hands it over as the app attaches, stopping only what its
    /// handover cannot carry, which is all the update card listed.
    #[test]
    fn update_now_chosen_for_a_runtime_that_can_be_handed_over_stops_only_what_it_cannot_carry() {
        let replacement = Replacement::default();
        let clock = SystemTime::now();
        let listed = Plan { stop: vec![stdio("s1", "t1")], ..plan("old", true, None, clock) };
        replacement.attached_at("old", &handing(&older()), Some(&listed), clock, Instant::now());
        assert!(replacement.outdated("old").unwrap().keeps);
        let Some(Due::Replace(epoch, stop)) = replacement.next_now() else { panic!("at once, as was chosen") };
        assert_eq!((epoch.as_str(), stop.as_slice()), ("old", [stdio("s1", "t1")].as_slice()), "with what the update card listed");
        let supervisor = Supervisor::new(&replacement, |_| Ok(()));
        assert_eq!(switch(&replacement, &supervisor, "old", true, &stop), Ok(()));
        assert_eq!(*supervisor.stopped.borrow(), [vec![stdio("s1", "t1")]], "what it cannot carry stops, as the card said, and only that");
        assert_eq!(supervisor.steps.borrow()[1], "hand over, stopping the unkept: updating, keeping", "handed over, never retired");
        assert_eq!(supervisor.steps.borrow().last().map(String::as_str), Some("changed: connected"));
    }

    /// #766: a failed switch during an update says why, and is tried again
    /// only when asked.
    #[test]
    fn a_switch_chosen_before_the_update_that_fails_says_why_and_waits_to_be_asked_again() {
        let replacement = Replacement::default();
        let clock = SystemTime::now();
        replacement.attached_at("old", &build(Some(&older())), Some(&plan("old", true, None, clock)), clock, Instant::now());
        assert_eq!(replacement.next_now(), Some(Due::Replace("old".into(), vec![])));
        let failing = Supervisor { replacement: &replacement, stopped: RefCell::default(), steps: RefCell::default(), stop: Box::new(|_| anyhow::bail!("it did not exit")) };
        assert_eq!(switch(&replacement, &failing, "old", true, &[]), Err("Could not restart the TerminalX runtime: it did not exit".into()));
        let outdated = replacement.outdated("old").unwrap();
        assert!(outdated.failed && outdated.problem.as_deref() == Some("Could not restart the TerminalX runtime: it did not exit"), "{outdated:?}");
        assert_eq!(replacement.next_now(), None, "neither replaced again nor checked by itself");
        // A new attachment to the same runtime does not bring the plan back.
        replacement.attached_at("old", &build(Some(&older())), None, clock, Instant::now());
        assert_eq!(replacement.next_now(), None);
    }

    /// #766: nothing was under way when the update was asked for, nor once
    /// it was installed: the relaunched app replaces the older runtime on
    /// its first reading that finds nothing, without waiting from the start.
    #[test]
    fn nothing_under_way_before_the_relaunch_replaces_the_older_runtime_on_the_first_quiet_reading() {
        let switched = std::cell::Cell::new(0);
        let switch = || { switched.set(switched.get() + 1); Ok(()) };
        let clock = SystemTime::now();
        let now = Instant::now();

        let replacement = Replacement::default();
        replacement.attached_at("old", &build(Some(&older())), Some(&plan("old", false, Some(SETTLE + CHECK_EVERY), clock)), clock, now);
        assert_eq!(replacement.next_now(), Some(Due::Check("old".into())), "read first: it is never replaced on a reading from before the relaunch alone");
        check(&replacement, "old", Ok(vec![]), now, switch);
        assert_eq!(switched.get(), 1, "replaced as it attaches");

        // A download quicker than SETTLE: the rest of the wait, not all of it.
        let replacement = Replacement::default();
        replacement.attached_at("old", &build(Some(&older())), Some(&plan("old", false, Some(SETTLE - CHECK_EVERY), clock)), clock, now);
        check(&replacement, "old", Ok(vec![]), now, switch);
        assert_eq!(switched.get(), 1);
        check(&replacement, "old", Ok(vec![]), now + CHECK_EVERY, switch);
        assert_eq!(switched.get(), 2);

        // Something started meanwhile: it waits, by itself, from the start.
        let replacement = Replacement::default();
        replacement.attached_at("old", &build(Some(&older())), Some(&plan("old", false, Some(SETTLE * 2), clock)), clock, now);
        assert!(check(&replacement, "old", Ok(vec!["Codex in \u{201c}Web\u{201d}, in the middle of a turn".into()]), now, switch));
        check(&replacement, "old", Ok(vec![]), now + CHECK_EVERY, switch);
        assert_eq!(switched.get(), 2, "not before it has settled again");
        check(&replacement, "old", Ok(vec![]), now + CHECK_EVERY + SETTLE, switch);
        assert_eq!(switched.get(), 3, "and then by itself, without asking");
    }

    /// #766: Update when they're done is the wait #730 made, with nothing to
    /// ask; and a plan for another runtime, or one made long ago, is no plan.
    #[test]
    fn a_plan_holds_only_for_the_runtime_it_was_made_for_and_only_for_a_while() {
        let switched = std::cell::Cell::new(0);
        let switch = || { switched.set(switched.get() + 1); Ok(()) };
        let clock = SystemTime::now();
        let now = Instant::now();
        let quiet = Some(SETTLE * 2);
        for (case, plan) in [
            ("when they're done", plan("old", false, None, clock)),
            ("another runtime's", plan("other", true, quiet, clock)),
            ("one made long ago", plan("old", true, quiet, clock - super::super::update_plan::VALID_FOR - Duration::from_secs(5))),
        ] {
            let replacement = Replacement::default();
            replacement.attached_at("old", &build(Some(&older())), Some(&plan), clock, now);
            assert_eq!(replacement.next_now(), Some(Due::Check("old".into())), "{case}: checked, not replaced at once");
            check(&replacement, "old", Ok(vec![]), now, switch);
            assert_eq!(switched.get(), 0, "{case}: waits for nothing to be under way for SETTLE");
            check(&replacement, "old", Ok(vec![]), now + SETTLE, switch);
            assert_eq!(switched.get(), 1, "{case}: then replaced by itself");
            switched.set(0);
        }
        // A runtime not older than the app has nothing to replace, whatever the plan says.
        let replacement = Replacement::default();
        replacement.attached_at("old", &build(Some(env!("CARGO_PKG_VERSION"))), Some(&plan("old", true, quiet, clock)), clock, now);
        assert_eq!(replacement.next_now(), None);
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
        fn next_now(&self) -> Option<Due> {
            let mut inner = self.inner.lock().unwrap();
            let epoch = inner.checkable()?.to_owned();
            if std::mem::take(&mut inner.forced) {
                inner.due = false;
                return Some(Due::Replace(epoch, std::mem::take(&mut inner.planned_stop)));
            }
            std::mem::take(&mut inner.due).then_some(Due::Check(epoch))
        }
    }
}
