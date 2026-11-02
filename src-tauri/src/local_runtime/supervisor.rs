//! Keeps the desktop attached to its local runtime, so a dropped connection
//! is a short gap instead of a notice that waits for a click (#643).
//!
//! Two kinds of connection fail on their own: the app-wide event connection,
//! and each window's terminal-output connection. Each is re-established with
//! the cloud workspaces' backoff (250 ms to 10 s, jittered) and no lifetime
//! cap. A new event connection goes through discovery, which finds an owner
//! that restarted or starts one that exited. Windows then re-attach their
//! terminals and re-read what they show: nothing reloads, and no request that
//! was in flight is sent again, so no agent restarts and no prompt repeats.
//!
//! Every loss is logged with which connection it was and why it ended, and
//! every recovery with how long it was down and how many attempts it took
//! (#716), in the desktop's log beside the runtime's.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::client::Blocked;
use super::desktop::{Desktop, Lost, Watch};
use crate::remote::{host::jitter, protocol::{backoff, BACKOFF_CEILING}};
use crate::AppState;

/// A connection that fails again this soon after recovering keeps its
/// backoff: a link that cannot stay up is not retried four times a second.
const STABLE: Duration = Duration::from_secs(30);
const LOST_EVENTS: &str = "The connection to the background runtime closed. Agents and terminal commands keep running.";
const LOST_VIEW: &str = "Live terminal output in this window disconnected. Agents and terminal commands keep running.";

/// What one window shows. Read without asking the owner anything, so it never
/// waits on an owner that has stopped answering.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnectionState {
    /// `outdated`: the runtime is older than this app, and is replaced with
    /// the one bundled with it once none of its agents is mid-turn (#730).
    Connected {
        epoch: String, generation: u64, view: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        outdated: Option<super::replace::Outdated>,
    },
    /// Retrying by itself. `terminal`: only this window's terminal output is
    /// down; otherwise every window's live updates are.
    Connecting { terminal: bool, attempt: u32, retry_in_ms: u64, down_ms: u64, message: String },
    /// Retrying cannot help until something outside this window changes. It
    /// still goes on, at the slowest pace.
    Unavailable { message: String },
    /// The runtime is there but does not answer, as the watchdog or an
    /// attempt to attach found (`ui.rs`). Reconnecting reaches the same wedged
    /// process; only restarting it recovers (#661). `epoch` names the attached
    /// runtime, if any, so a restart cannot stop its replacement.
    Unresponsive { message: String, epoch: Option<String> },
    /// The runtime is being replaced with the one bundled with this app
    /// (`replace.rs`): its agents and terminals are stopping, and windows
    /// attach to the new one in place. `from`: its version, when it said.
    Updating { from: Option<String>, to: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Target { Events, View(String) }

impl std::fmt::Display for Target {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Events => write!(out, "the background runtime's event connection"),
            Self::View(window) => write!(out, "terminal output of window {window:?}"),
        }
    }
}

/// What an attempt to re-establish a connection came to, for the log.
#[derive(Debug, PartialEq)]
enum Report {
    Recovered { tries: u32, down: Duration },
    /// Still down. Not every failure is reported: the first, any whose reason
    /// differs from the one before, and then the 2nd, 4th, 8th and so on, so
    /// a runtime that stays away all day costs the log some twenty lines.
    Failed { tries: u32, down: Duration, message: String, retry_in: Duration },
}

#[derive(Debug)]
struct Retry {
    attempt: u32,
    /// Attempts made since this connection was lost. `attempt` carries over
    /// from a recovery that did not last, for the backoff; this does not.
    tries: u32,
    since: Instant,
    due: Instant,
    /// The loss this retry answers. A newer one while an attempt runs makes
    /// that attempt's success out of date.
    loss: u64,
    message: String,
    blocked: bool,
}

/// The window's attachment as it stands, read before the supervisor's lock.
struct Snapshot { generation: u64, epoch: Option<String>, view: u64 }

/// Retry bookkeeping. Its lock is a leaf: nothing else is locked under it.
#[derive(Default)]
struct Inner {
    /// The attachment last published. Losses of earlier ones are late news.
    generation: u64,
    pending: HashMap<Target, Retry>,
    /// When each target last recovered, and after how many attempts.
    recovered: HashMap<Target, (Instant, u32)>,
    losses: u64,
    halted: bool,
}

fn ms(duration: Duration) -> u64 { duration.as_millis().try_into().unwrap_or(u64::MAX) }

impl Inner {
    /// Why a loss of `target` needs no attempt of its own, if it does not.
    fn moot(&self, target: &Target, generation: u64) -> Option<&'static str> {
        if self.halted { return Some("the app is quitting"); }
        if generation < self.generation { return Some("it belonged to an attachment that has since been replaced"); }
        // A new attachment opens new view connections: none to repair first.
        if matches!(target, Target::View(_)) && self.pending.contains_key(&Target::Events) {
            return Some("the event connection is being re-established, and brings new terminal connections");
        }
        None
    }

    fn lose(&mut self, target: Target, generation: u64, message: &str, now: Instant, jitter: f64) -> bool {
        if self.moot(&target, generation).is_some() { return false; }
        self.losses += 1;
        let loss = self.losses;
        if let Some(retry) = self.pending.get_mut(&target) {
            retry.loss = loss;
            return true;
        }
        let attempt = self.recovered.get(&target)
            .filter(|(at, _)| now.saturating_duration_since(*at) < STABLE)
            .map_or(0, |(_, attempt)| attempt.saturating_add(1));
        self.pending.insert(target, Retry { attempt, tries: 0, since: now, due: now + backoff(attempt, jitter),
            loss, message: message.into(), blocked: false });
        true
    }

    /// The attempt that is due, or how long until one is. A lost event
    /// connection goes first: a new attachment brings new view connections.
    fn due(&self, now: Instant) -> Result<(Target, u64), Option<Duration>> {
        if self.halted { return Err(None); }
        let next = self.pending.get_key_value(&Target::Events)
            .or_else(|| self.pending.iter().min_by_key(|(_, retry)| retry.due));
        match next {
            Some((target, retry)) if retry.due <= now => Ok((target.clone(), retry.loss)),
            Some((_, retry)) => Err(Some(retry.due - now)),
            None => Err(None),
        }
    }

    fn settle(&mut self, target: &Target, loss: u64, outcome: Result<u64, (String, bool)>, now: Instant, jitter: f64) -> Option<Report> {
        if let (Target::Events, Ok(generation)) = (target, &outcome) {
            self.generation = self.generation.max(*generation);
            self.pending.retain(|target, _| *target == Target::Events);
        }
        let retry = self.pending.get_mut(target)?;
        retry.tries = retry.tries.saturating_add(1);
        let (tries, down) = (retry.tries, now.saturating_duration_since(retry.since));
        match outcome {
            Ok(_) if retry.loss == loss => {
                let attempt = retry.attempt;
                self.pending.remove(target);
                self.recovered.insert(target.clone(), (now, attempt));
                Some(Report::Recovered { tries, down })
            }
            Ok(_) => {
                // Lost again while this attempt ran: go on, not from the start.
                // That loss was reported as it happened.
                retry.attempt = retry.attempt.saturating_add(1);
                retry.due = now + backoff(retry.attempt, jitter);
                None
            }
            Err((message, blocked)) => {
                retry.attempt = retry.attempt.saturating_add(1);
                let retry_in = if blocked { BACKOFF_CEILING } else { backoff(retry.attempt, jitter) };
                retry.due = now + retry_in;
                let changed = message != retry.message;
                retry.message = message;
                retry.blocked = blocked;
                (changed || tries.is_power_of_two())
                    .then(|| Report::Failed { tries, down, message: retry.message.clone(), retry_in })
            }
        }
    }

    fn status(&self, window: &str, attached: Option<Snapshot>, unattached: &str, now: Instant) -> ConnectionState {
        if self.halted {
            return ConnectionState::Unavailable { message: "TerminalX is stopping its background runtime.".into() };
        }
        let retrying = |retry: &Retry, terminal: bool| if retry.blocked {
            ConnectionState::Unavailable { message: retry.message.clone() }
        } else {
            ConnectionState::Connecting { terminal, attempt: retry.attempt.saturating_add(1),
                retry_in_ms: ms(retry.due.saturating_duration_since(now)),
                down_ms: ms(now.saturating_duration_since(retry.since)), message: retry.message.clone() }
        };
        if let Some(retry) = self.pending.get(&Target::Events) { return retrying(retry, false); }
        let Some(attached) = attached else { return ConnectionState::Unavailable { message: unattached.into() } };
        let Some(epoch) = attached.epoch else {
            // Closed a moment ago; its loss is on the way.
            return ConnectionState::Connecting { terminal: false, attempt: 1, retry_in_ms: 0, down_ms: 0, message: LOST_EVENTS.into() };
        };
        if let Some(retry) = self.pending.get(&Target::View(window.into())) { return retrying(retry, true); }
        ConnectionState::Connected { epoch, generation: attached.generation, view: attached.view, outdated: None }
    }
}

#[derive(Default)]
pub(crate) struct Supervisor {
    inner: Mutex<Inner>,
    wake: Condvar,
    app: OnceLock<AppHandle>,
}

impl Supervisor {
    /// Retry on a thread of its own from now on. Called once, at setup.
    pub(crate) fn start(&self, app: &AppHandle) -> anyhow::Result<()> {
        if self.app.set(app.clone()).is_err() { return Ok(()); }
        let app = app.clone();
        std::thread::Builder::new().name("local-runtime-supervisor".into()).spawn(move || {
            let state = app.state::<AppState>();
            let supervisor = &state.runtime_supervisor;
            loop {
                let (target, loss) = supervisor.next();
                let outcome = match &target {
                    Target::Events => attach(&app).map_err(|error| {
                        // An owner that holds its socket and never answers is
                        // not reached by trying again: say so (#661).
                        state.runtime_health.attach_failed(&error);
                        state.runtime_replacement.attach_failed();
                        match error.downcast_ref::<Blocked>() {
                            Some(blocked) => (blocked.0.clone(), true),
                            None => (format!("Could not reconnect to the background runtime: {error:#}"), false),
                        }
                    }),
                    Target::View(window) => reopen(&app, window)
                        .map_err(|error| (format!("Could not reconnect this window's terminal output: {error:#}"), false)),
                };
                if let (Target::Events, Err((message, _))) = (&target, &outcome) {
                    *state.runtime_error.lock().unwrap() = message.clone();
                }
                let reattached = match (&target, &outcome) { (Target::Events, Ok(generation)) => Some(*generation), _ => None };
                if reattached.is_some() { state.runtime_health.clear(); }
                let report = supervisor.inner.lock().unwrap().settle(&target, loss, outcome, Instant::now(), jitter());
                if let Some(report) = report { log_report(&target, &report); }
                supervisor.emit();
                // Every window re-reads what the gap may have changed.
                if let Some(generation) = reattached { let _ = app.emit("local_runtime_reattached", serde_json::json!({"generation": generation})); }
            }
        })?;
        Ok(())
    }

    fn next(&self) -> (Target, u64) {
        let mut inner = self.inner.lock().unwrap();
        loop {
            inner = match inner.due(Instant::now()) {
                Ok(job) => return job,
                Err(Some(wait)) => self.wake.wait_timeout(inner, wait).unwrap().0,
                Err(None) => self.wake.wait(inner).unwrap(),
            };
        }
    }

    /// Windows read their status again; events are hints, status is the answer.
    fn emit(&self) {
        if let Some(app) = self.app.get() { let _ = app.emit("local_runtime_state", ()); }
    }

    fn lose(&self, target: Target, generation: u64, message: &str, reason: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(moot) = inner.moot(&target, generation) {
            drop(inner);
            log::info!("{target} closed: {reason}; it is not reconnected on its own, as {moot}");
            return;
        }
        let again = inner.pending.contains_key(&target);
        inner.lose(target.clone(), generation, message, Instant::now(), jitter());
        drop(inner);
        if again { log::warn!("lost {target} again while reconnecting it: {reason}"); }
        else { log::warn!("lost {target}: {reason}; reconnecting"); }
        self.wake.notify_all();
        self.emit();
    }

    /// A connection ended by itself, or was dropped on purpose (`Desktop::disconnect`).
    pub(crate) fn lost(&self, lost: Lost) {
        match lost {
            Lost::Events { generation, reason } => self.lose(Target::Events, generation, LOST_EVENTS, &reason),
            Lost::View { generation, window, reason } => self.lose(Target::View(window), generation, LOST_VIEW, &reason),
        }
    }

    /// The first attachment, at launch.
    pub(crate) fn attached(&self, generation: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.generation = inner.generation.max(generation);
    }

    /// The first attachment failed at launch: keep trying, as after any loss.
    pub(crate) fn unattached(&self, error: &anyhow::Error) {
        let now = Instant::now();
        let mut inner = self.inner.lock().unwrap();
        if !inner.lose(Target::Events, 0, LOST_EVENTS, now, jitter()) { return; }
        let loss = inner.losses;
        let failure = match error.downcast_ref::<Blocked>() {
            Some(blocked) => (blocked.0.clone(), true),
            None => (format!("Could not connect to the background runtime: {error:#}"), false),
        };
        // Logged as the launch's own failure to attach.
        let _ = inner.settle(&Target::Events, loss, Err(failure), now, jitter());
        drop(inner);
        self.wake.notify_all();
        self.emit();
    }

    /// "Try again": whatever is being re-established is attempted now.
    pub(crate) fn retry_now(&self) {
        let now = Instant::now();
        let mut inner = self.inner.lock().unwrap();
        for retry in inner.pending.values_mut() { retry.due = now; }
        drop(inner);
        self.wake.notify_all();
        self.emit();
    }

    /// Quitting: never reconnect to, or start, a runtime that is being left
    /// or stopped.
    pub(crate) fn halt(&self) {
        self.inner.lock().unwrap().halted = true;
        self.emit();
    }

    /// A stop-all that failed leaves the app running: keep it attached.
    pub(crate) fn resume(&self, runtime: Option<&Desktop>) {
        let closed = runtime.map(|runtime| (runtime.generation(), runtime.attachment().is_err()));
        let mut inner = self.inner.lock().unwrap();
        inner.halted = false;
        // A loss while halted was not recorded.
        let lost = match closed {
            Some((generation, true)) => Some(generation),
            Some((_, false)) => None,
            None => Some(inner.generation),
        };
        let lost = lost.is_some_and(|generation| inner.lose(Target::Events, generation, LOST_EVENTS, Instant::now(), jitter()));
        drop(inner);
        if lost { log::warn!("{} was closed while the app stopped its runtime; reconnecting", Target::Events); }
        self.wake.notify_all();
        self.emit();
    }

    pub(crate) fn status(&self, window: &str, runtime: Option<&Desktop>, unattached: &str) -> ConnectionState {
        let attached = runtime.map(|runtime| Snapshot { generation: runtime.generation(),
            epoch: runtime.attachment().ok().map(|attachment| attachment.epoch), view: runtime.renewed(window) });
        let now = Instant::now();
        let mut inner = self.inner.lock().unwrap();
        // Never leave a closed attachment unattended, whatever closed it.
        let resumed = match &attached {
            Some(Snapshot { epoch: None, generation, .. }) if !inner.pending.contains_key(&Target::Events) =>
                inner.lose(Target::Events, *generation, LOST_EVENTS, now, jitter()),
            _ => false,
        };
        let status = inner.status(window, attached, unattached, now);
        drop(inner);
        if resumed {
            log::warn!("{} was found closed with nothing reconnecting it; reconnecting", Target::Events);
            self.wake.notify_all();
            self.emit();
        }
        status
    }
}

fn log_report(target: &Target, report: &Report) {
    use super::log_file::span;
    let attempts = |tries: u32| if tries == 1 { "1 attempt".to_string() } else { format!("{tries} attempts") };
    match report {
        Report::Recovered { tries, down } => {
            log::info!("reconnected {target} after {}; it was down for {}", attempts(*tries), span(*down));
        }
        Report::Failed { tries, down, message, retry_in } => {
            log::warn!("{target} is still down after {} and {}: {message}; trying again in {}", attempts(*tries), span(*down), span(*retry_in));
        }
    }
}

/// Discovery, then a new attachment published in place of the old one.
pub(crate) fn attach(app: &AppHandle) -> anyhow::Result<u64> {
    let state = app.state::<AppState>();
    let previous = state.runtime();
    let source = app.path().resource_dir()?.join("local-runtime/terminalx-serve");
    let home = crate::store::root()?;
    // The owner that is running now, which may have restarted since the last
    // attachment, or a new one if it exited. A live owner is never replaced
    // here: one older than this app is, once attached (`replace.rs`).
    // A runtime started here keeps its log beside the app's (#661).
    let log = app.path().app_log_dir().ok().map(|dir| dir.join("runtime.log"));
    let client = super::launch::connect_desktop(&source, &home, &app.config().identifier, log.as_deref())?;
    let next = Arc::new(match &previous {
        Some(previous) => previous.reconnect(client)?,
        None => Desktop::connect_watched(client, Arc::new(app.clone()), Some(watch(app)))?,
    });
    let endpoint = state.window_endpoint.get().ok_or_else(|| anyhow::anyhow!("The private desktop endpoint is not ready."))?.clone();
    next.activate_window(endpoint, |next| {
        let mut current = state.runtime.lock().unwrap();
        let unchanged = match (current.as_ref(), previous.as_ref()) {
            (Some(current), Some(previous)) => Arc::ptr_eq(current, previous),
            (None, None) => true,
            _ => false,
        };
        anyhow::ensure!(unchanged, "The desktop connection changed while attaching.");
        state.pairing.attach_runtime(next.clone());
        *current = Some(next.clone());
        // One older than this app is replaced as soon as that cuts off no turn (#730).
        state.runtime_replacement.attached(next.epoch(), next.build());
        Ok(())
    })?;
    Ok(next.generation())
}

fn reopen(app: &AppHandle, window: &str) -> anyhow::Result<u64> {
    let runtime = app.state::<AppState>().runtime().ok_or_else(|| anyhow::anyhow!("The background runtime is not attached."))?;
    // A window that closed in the meantime needs no view connection.
    if app.get_webview_window(window).is_none() { return Ok(runtime.renewed(window)); }
    runtime.reopen_view(window)
}

fn watch(app: &AppHandle) -> Watch {
    let app = app.clone();
    Arc::new(move |lost| app.state::<AppState>().runtime_supervisor.lost(lost))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    fn attached(generation: u64) -> Option<Snapshot> {
        Some(Snapshot { generation, epoch: Some("owner".into()), view: 0 })
    }

    fn connected(status: &ConnectionState) -> bool { matches!(status, ConnectionState::Connected { .. }) }

    /// Run the attempt that is due at `now`, if any, with `outcome`.
    fn attempt(inner: &mut Inner, now: Instant, outcome: Result<u64, (String, bool)>) -> Target {
        attempt_reported(inner, now, outcome).0
    }

    fn attempt_reported(inner: &mut Inner, now: Instant, outcome: Result<u64, (String, bool)>) -> (Target, Option<Report>) {
        let (target, loss) = inner.due(now).expect("an attempt is due");
        let report = inner.settle(&target, loss, outcome, now, 0.5);
        (target, report)
    }

    /// #716: the log says how long each connection was down and how many
    /// attempts it took to bring back, and leaves out most failures of a
    /// long outage without leaving out one whose reason is new.
    #[test]
    fn a_recovery_is_reported_with_how_long_it_was_down_and_how_many_attempts_it_took() {
        let start = Instant::now();
        let mut inner = Inner { generation: 1, ..Default::default() };
        inner.lose(Target::View("main".into()), 1, LOST_VIEW, start, 0.5);
        let mut now = start;
        let mut reported = Vec::new();
        for attempt in 1..=9 {
            now += 10 * SECOND;
            let message = if attempt == 6 { "refused for a new reason" } else { "refused" };
            let (_, report) = attempt_reported(&mut inner, now, Err((message.into(), false)));
            if let Some(Report::Failed { tries, .. }) = report { reported.push(tries); }
        }
        assert_eq!(reported, [1, 2, 4, 6, 7, 8], "first, doubling, and each change of reason (into the new one and back)");
        now += 10 * SECOND;
        let (target, report) = attempt_reported(&mut inner, now, Ok(9));
        assert_eq!(target.to_string(), "terminal output of window \"main\"");
        assert_eq!(report, Some(Report::Recovered { tries: 10, down: 100 * SECOND }));

        // Failing again soon after keeps the backoff, but counts its attempts afresh.
        inner.lose(Target::View("main".into()), 1, LOST_VIEW, now + SECOND, 0.5);
        let due = inner.pending[&Target::View("main".into())].due;
        assert_eq!(attempt_reported(&mut inner, due, Ok(10)).1, Some(Report::Recovered { tries: 1, down: due - (now + SECOND) }));
    }

    #[test]
    fn a_loss_that_needs_no_attempt_of_its_own_says_why() {
        let now = Instant::now();
        let mut inner = Inner { generation: 2, ..Default::default() };
        assert_eq!(inner.moot(&Target::Events, 2), None);
        assert!(inner.moot(&Target::Events, 1).is_some_and(|why| why.contains("replaced")));
        inner.lose(Target::Events, 2, LOST_EVENTS, now, 0.5);
        assert!(inner.moot(&Target::View("main".into()), 2).is_some_and(|why| why.contains("event connection")));
        inner.halted = true;
        assert_eq!(inner.moot(&Target::Events, 2), Some("the app is quitting"));
        assert_eq!(Target::Events.to_string(), "the background runtime's event connection");
    }

    #[test]
    fn retries_on_the_cloud_backoff_with_no_lifetime_cap() {
        let start = Instant::now();
        let mut inner = Inner { generation: 1, ..Default::default() };
        assert!(inner.lose(Target::Events, 1, LOST_EVENTS, start, 0.5));
        let mut now = start;
        let mut delays = Vec::new();
        for _ in 0..20 {
            let Err(Some(wait)) = inner.due(now) else { panic!("the next attempt is scheduled") };
            delays.push(wait);
            now += wait;
            attempt(&mut inner, now, Err(("refused".into(), false)));
        }
        assert!(delays.iter().all(|delay| *delay >= Duration::from_millis(250) && *delay <= 10 * SECOND), "{delays:?}");
        assert!(delays.windows(2).all(|pair| pair[0] <= pair[1]), "backoff never shortens: {delays:?}");
        assert_eq!(delays.last(), Some(&Duration::from_millis(7_500)), "the ceiling, with half of its jitter");
        // Twenty failures later it is still being retried, and says which attempt is next.
        let ConnectionState::Connecting { attempt: next, terminal: false, message, .. } = inner.status("main", attached(1), "", now) else { panic!("still reconnecting") };
        assert_eq!((next, message.as_str()), (21, "refused"));
        attempt(&mut inner, now + 10 * SECOND, Ok(2));
        assert!(connected(&inner.status("main", attached(2), "", now + 10 * SECOND)));
    }

    #[test]
    fn a_delayed_loss_of_an_earlier_attachment_is_ignored_after_recovery() {
        let now = Instant::now();
        let mut inner = Inner { generation: 1, ..Default::default() };
        inner.lose(Target::Events, 1, LOST_EVENTS, now, 0.5);
        attempt(&mut inner, now + SECOND, Ok(2));
        assert!(!inner.lose(Target::Events, 1, LOST_EVENTS, now + 2 * SECOND, 0.5), "a queued loss of generation 1");
        assert!(!inner.lose(Target::View("main".into()), 1, LOST_VIEW, now + 2 * SECOND, 0.5));
        assert!(connected(&inner.status("main", attached(2), "", now + 2 * SECOND)));
        assert!(inner.lose(Target::Events, 2, LOST_EVENTS, now + 3 * SECOND, 0.5), "the current attachment's own loss counts");
    }

    #[test]
    fn a_loss_while_an_attempt_runs_keeps_the_target_pending() {
        let now = Instant::now();
        let mut inner = Inner { generation: 1, ..Default::default() };
        inner.lose(Target::Events, 1, LOST_EVENTS, now, 0.5);
        let (target, loss) = inner.due(now + SECOND).unwrap();
        // The new attachment is published, then fails before the attempt settles.
        assert!(inner.lose(Target::Events, 2, LOST_EVENTS, now + SECOND, 0.5));
        inner.settle(&target, loss, Ok(2), now + SECOND, 0.5);
        assert_eq!(inner.generation, 2);
        assert!(inner.pending.contains_key(&Target::Events), "the published attachment is already gone");
        assert!(!connected(&inner.status("main", attached(2), "", now + SECOND)));
    }

    #[test]
    fn one_windows_terminal_output_never_marks_another_window_unavailable() {
        let now = Instant::now();
        let mut inner = Inner { generation: 4, ..Default::default() };
        assert!(inner.lose(Target::View("main".into()), 4, LOST_VIEW, now, 0.5));
        let ConnectionState::Connecting { terminal, .. } = inner.status("main", attached(4), "", now) else { panic!("main is reconnecting") };
        assert!(terminal, "only this window's terminal output is down");
        assert!(connected(&inner.status("floating", attached(4), "", now)), "a healthy window looks healthy");
        // Switching windows changes nothing about either.
        assert!(!connected(&inner.status("main", attached(4), "", now)));
        assert_eq!(attempt(&mut inner, now + SECOND, Ok(9)), Target::View("main".into()));
        let renewed = Some(Snapshot { generation: 4, epoch: Some("owner".into()), view: 9 });
        assert_eq!(inner.status("main", renewed, "", now + SECOND), ConnectionState::Connected { epoch: "owner".into(), generation: 4, view: 9, outdated: None });
    }

    #[test]
    fn a_lost_event_connection_goes_first_and_replaces_every_view_repair() {
        let now = Instant::now();
        let mut inner = Inner { generation: 1, ..Default::default() };
        inner.lose(Target::View("main".into()), 1, LOST_VIEW, now, 0.5);
        inner.lose(Target::Events, 1, LOST_EVENTS, now + Duration::from_millis(100), 0.5);
        assert!(!inner.lose(Target::View("floating".into()), 1, LOST_VIEW, now, 0.5), "a new attachment brings new views");
        assert_eq!(attempt(&mut inner, now + SECOND, Ok(2)), Target::Events);
        assert!(inner.pending.is_empty(), "the old attachment's view repairs are moot");
        assert!(connected(&inner.status("main", attached(2), "", now + SECOND)));
    }

    #[test]
    fn a_connection_that_cannot_stay_up_keeps_its_backoff() {
        let now = Instant::now();
        let mut inner = Inner { generation: 1, ..Default::default() };
        let due = |inner: &Inner| inner.pending.values().map(|retry| retry.due).min().unwrap();
        inner.lose(Target::Events, 1, LOST_EVENTS, now, 0.5);
        for _ in 0..3 {
            let at = due(&inner);
            attempt(&mut inner, at, Err(("refused".into(), false)));
        }
        let recovered = due(&inner);
        attempt(&mut inner, recovered, Ok(2));
        inner.lose(Target::Events, 2, LOST_EVENTS, recovered + SECOND, 0.5);
        assert_eq!(inner.pending[&Target::Events].attempt, 4, "failed again 1 s after recovering");
        let recovered = due(&inner);
        attempt(&mut inner, recovered, Ok(3));
        inner.lose(Target::Events, 3, LOST_EVENTS, recovered + STABLE, 0.5);
        assert_eq!(inner.pending[&Target::Events].attempt, 0, "stable for a while: start over");
    }

    #[test]
    fn retrying_that_cannot_help_is_reported_at_once_and_goes_on_slowly() {
        let now = Instant::now();
        let mut inner = Inner { generation: 1, ..Default::default() };
        inner.lose(Target::Events, 1, LOST_EVENTS, now, 0.5);
        attempt(&mut inner, now + SECOND, Err(("Another TerminalX window is connected.".into(), true)));
        assert_eq!(inner.status("main", attached(1), "", now + SECOND), ConnectionState::Unavailable { message: "Another TerminalX window is connected.".into() });
        assert_eq!(inner.due(now + SECOND), Err(Some(BACKOFF_CEILING)));
        attempt(&mut inner, now + SECOND + BACKOFF_CEILING, Ok(2));
        assert!(connected(&inner.status("main", attached(2), "", now + 12 * SECOND)), "it clears by itself once it can attach");
    }

    #[test]
    fn halting_for_quit_never_attaches_again() {
        let now = Instant::now();
        let mut inner = Inner { generation: 1, halted: true, ..Default::default() };
        assert!(!inner.lose(Target::Events, 1, LOST_EVENTS, now, 0.5));
        assert_eq!(inner.due(now), Err(None));
        assert!(matches!(inner.status("main", attached(1), "", now), ConnectionState::Unavailable { .. }));
    }

    #[test]
    fn status_never_reports_a_closed_or_missing_attachment_as_connected() {
        let now = Instant::now();
        let inner = Inner { generation: 1, ..Default::default() };
        let closed = Some(Snapshot { generation: 1, epoch: None, view: 0 });
        assert!(matches!(inner.status("main", closed, "", now), ConnectionState::Connecting { terminal: false, .. }));
        assert_eq!(inner.status("main", None, "not attached", now), ConnectionState::Unavailable { message: "not attached".into() });
    }
}
