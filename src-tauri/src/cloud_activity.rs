//! What a cloud workspace runtime tells the API about its own activity, so
//! the API can suspend a workspace nobody uses (terminalx-saas PRO-33,
//! `POST /v1/cloud-workspace-bootstrap/activity`, remote runtime contract
//! section 9.3).
//!
//! The code that sees activity notes it here: a client typing into a
//! terminal, an agent turn starting or producing output, a client attaching
//! over the relay. A reporter thread in `terminalx-serve` sends what was
//! noted, with the current counts of running turns and waiting approvals:
//!
//! - nothing before the first relay registration, then one report after
//!   every registration (the first one opts the workspace into idle suspend);
//! - at most one report per [`MIN_INTERVAL`];
//! - a report whenever something was noted or the counts changed, and every
//!   [`KEEPALIVE`] while a turn runs or an approval waits;
//! - `attachment` every [`KEEPALIVE`] while a client that can type is
//!   attached, so a person working only over the relay is never suspended as
//!   idle. A viewer or a phone that only reads is not such a client: looking
//!   does not hold compute (terminalx-saas contract 9.4.1).
//!
//! The notes are process-wide and cost an atomic operation, so the desktop
//! build, which never starts a reporter, pays nothing for them.

use std::sync::atomic::{AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The API's debounce: at most one report this often.
pub const MIN_INTERVAL: Duration = Duration::from_secs(15);
/// The API wants a report at least every 60 s while something keeps the
/// workspace awake; this leaves room for a slow request.
pub const KEEPALIVE: Duration = Duration::from_secs(45);
const TICK: Duration = Duration::from_secs(1);
/// The API rejects larger counts.
const MAX_COUNT: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    AgentTurn,
    TerminalInput,
    Attachment,
}

impl Kind {
    const ALL: [Kind; 3] = [Kind::AgentTurn, Kind::TerminalInput, Kind::Attachment];

    fn bit(self) -> u8 {
        match self {
            Kind::AgentTurn => 1,
            Kind::TerminalInput => 2,
            Kind::Attachment => 4,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Kind::AgentTurn => "agent-turn",
            Kind::TerminalInput => "terminal-input",
            Kind::Attachment => "attachment",
        }
    }
}

static NOTED: AtomicU8 = AtomicU8::new(0);
static ATTACHED: AtomicUsize = AtomicUsize::new(0);
static REGISTRATIONS: AtomicU64 = AtomicU64::new(0);
static LAUNCHING: AtomicUsize = AtomicUsize::new(0);

/// Something happened that counts as use of the workspace.
pub fn note(kind: Kind) {
    NOTED.fetch_or(kind.bit(), Ordering::Relaxed);
}

/// A client that can type is attached over the relay until the guard drops.
#[must_use]
pub fn attached() -> Attached {
    ATTACHED.fetch_add(1, Ordering::Relaxed);
    note(Kind::Attachment);
    Attached(())
}

pub struct Attached(());

impl Drop for Attached {
    fn drop(&mut self) {
        ATTACHED.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The workspace's launch (cloning its repositories, starting its agent) is
/// running until the guard drops. It is reported as a running turn: nobody
/// is attached yet and no agent turn exists, but suspending now would lose
/// the launch.
#[must_use]
pub fn launching() -> Launching {
    LAUNCHING.fetch_add(1, Ordering::Relaxed);
    note(Kind::AgentTurn);
    Launching(())
}

/// Launches running now.
#[cfg(test)]
pub(crate) fn launches() -> usize {
    LAUNCHING.load(Ordering::Relaxed)
}

pub struct Launching(());

impl Drop for Launching {
    fn drop(&mut self) {
        LAUNCHING.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The relay host registered (again).
pub fn registered() {
    REGISTRATIONS.fetch_add(1, Ordering::Relaxed);
}

/// Agent turns running now and permission prompts waiting for a person now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    pub active_turns: usize,
    pub pending_approvals: usize,
}

impl Counts {
    fn busy(self) -> bool {
        self.active_turns > 0 || self.pending_approvals > 0
    }

    /// With `launches` running launches counted as turns.
    fn with_launches(self, launches: usize) -> Self {
        Self { active_turns: self.active_turns.saturating_add(launches), ..self }
    }
}

/// What the reporter sees on one tick.
#[derive(Debug, Clone, Copy)]
struct Observed {
    noted: u8,
    attached: usize,
    registrations: u64,
    counts: Counts,
}

/// When to report, kept apart from the clock and the network so it can be
/// tested tick by tick.
#[derive(Default)]
struct Schedule {
    /// Noted since the last report that reached the API.
    pending: u8,
    registrations_seen: u64,
    /// A registration happened and has not been reported yet.
    registration_unreported: bool,
    last_sent: Option<Instant>,
    last_counts: Counts,
    last_attachment: Option<Instant>,
}

impl Schedule {
    /// The report to send now, if one is due.
    fn tick(&mut self, now: Instant, observed: Observed) -> Option<Value> {
        self.pending |= observed.noted;
        if observed.registrations != self.registrations_seen {
            self.registrations_seen = observed.registrations;
            self.registration_unreported = true;
        }
        if observed.attached > 0 && self.last_attachment.is_none_or(|at| now.duration_since(at) >= KEEPALIVE) {
            self.pending |= Kind::Attachment.bit();
            self.last_attachment = Some(now);
        } else if observed.attached == 0 {
            self.last_attachment = None;
        }
        // Nothing is sent before the first registration: the first report
        // opts the workspace into idle suspend.
        if self.registrations_seen == 0 {
            return None;
        }
        let since = self.last_sent.map(|at| now.duration_since(at));
        if since.is_some_and(|since| since < MIN_INTERVAL) {
            return None;
        }
        let counts = Counts {
            active_turns: observed.counts.active_turns.min(MAX_COUNT),
            pending_approvals: observed.counts.pending_approvals.min(MAX_COUNT),
        };
        let keepalive = counts.busy() && since.is_none_or(|since| since >= KEEPALIVE);
        let due = self.registration_unreported || self.pending != 0 || counts != self.last_counts || keepalive;
        due.then(|| {
            let activity: Vec<&str> = Kind::ALL.iter().filter(|kind| self.pending & kind.bit() != 0).map(|kind| kind.as_str()).collect();
            json!({
                "v": 1,
                "activity": activity,
                "activeTurns": counts.active_turns,
                "pendingApprovals": counts.pending_approvals,
            })
        })
    }

    /// The report from the last `tick` reached the API (or not).
    fn sent(&mut self, now: Instant, report: &Value, ok: bool) {
        // Failed attempts are spaced out too, so a down API is not hammered.
        self.last_sent = Some(now);
        if !ok {
            return;
        }
        self.pending = 0;
        self.registration_unreported = false;
        // What was sent, already clamped.
        self.last_counts = Counts {
            active_turns: report["activeTurns"].as_u64().unwrap_or(0) as usize,
            pending_approvals: report["pendingApprovals"].as_u64().unwrap_or(0) as usize,
        };
    }
}

/// Report for the life of the process: `counts` reads the runtime's turns
/// and approvals, `send` delivers one report and says whether it arrived.
pub fn spawn_reporter<C, S>(counts: C, send: S)
where
    C: Fn() -> Counts + Send + 'static,
    S: Fn(&Value) -> bool + Send + 'static,
{
    let spawned = std::thread::Builder::new().name("cloud-activity".into()).spawn(move || {
        let mut schedule = Schedule::default();
        loop {
            std::thread::sleep(TICK);
            let observed = Observed {
                noted: NOTED.swap(0, Ordering::Relaxed),
                attached: ATTACHED.load(Ordering::Relaxed),
                registrations: REGISTRATIONS.load(Ordering::Relaxed),
                counts: counts().with_launches(LAUNCHING.load(Ordering::Relaxed)),
            };
            let now = Instant::now();
            if let Some(report) = schedule.tick(now, observed) {
                let ok = send(&report);
                schedule.sent(now, &report, ok);
            }
        }
    });
    if let Err(error) = spawned {
        log::error!("start the cloud workspace activity reporter: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observed(noted: &[Kind], attached: usize, registrations: u64, counts: Counts) -> Observed {
        Observed { noted: noted.iter().fold(0, |bits, kind| bits | kind.bit()), attached, registrations, counts }
    }

    fn idle(registrations: u64) -> Observed {
        observed(&[], 0, registrations, Counts::default())
    }

    fn secs(start: Instant, s: u64) -> Instant {
        start + Duration::from_secs(s)
    }

    /// Tick once and treat any report as delivered.
    fn step(schedule: &mut Schedule, now: Instant, seen: Observed) -> Option<Value> {
        let report = schedule.tick(now, seen)?;
        schedule.sent(now, &report, true);
        Some(report)
    }

    #[test]
    fn a_running_launch_keeps_the_workspace_busy_with_nobody_attached() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        let launching = || observed(&[], 0, 1, Counts::default().with_launches(1));
        let first = step(&mut schedule, start, observed(&[Kind::AgentTurn], 0, 1, Counts::default().with_launches(1))).expect("a report when the launch starts");
        assert_eq!(first, json!({ "v": 1, "activity": ["agent-turn"], "activeTurns": 1, "pendingApprovals": 0 }));
        // A clone that runs for half an hour: reported busy at least every 60 s.
        let mut last = 0;
        for s in 1..=1800 {
            if let Some(report) = step(&mut schedule, secs(start, s), launching()) {
                assert_eq!(report["activeTurns"], 1);
                assert!(s - last <= 60, "busy report overdue at t={s}");
                last = s;
            }
        }
        assert!(last >= 1800 - 60);
        // The launch ends: one report says so.
        let done = step(&mut schedule, secs(start, 1801 + 15), idle(1)).expect("a report when the launch ends");
        assert_eq!(done["activeTurns"], 0);
    }

    #[test]
    fn the_launch_guard_counts_only_while_it_is_held() {
        {
            let _launching = launching();
            assert!(LAUNCHING.load(Ordering::Relaxed) >= 1);
            assert_ne!(NOTED.load(Ordering::Relaxed) & Kind::AgentTurn.bit(), 0);
        }
        assert_eq!(Counts { active_turns: 2, pending_approvals: 1 }.with_launches(1), Counts { active_turns: 3, pending_approvals: 1 });
        assert_eq!(Counts::default().with_launches(0), Counts::default());
    }

    #[test]
    fn silent_until_registered_then_one_empty_report() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        assert!(step(&mut schedule, start, observed(&[Kind::TerminalInput], 0, 0, Counts::default())).is_none());
        let first = step(&mut schedule, secs(start, 1), idle(1)).expect("a report after registering");
        // What was noted before registering is not lost.
        assert_eq!(first, json!({ "v": 1, "activity": ["terminal-input"], "activeTurns": 0, "pendingApprovals": 0 }));
        for s in 2..600 {
            assert!(step(&mut schedule, secs(start, s), idle(1)).is_none(), "an idle runtime stays quiet (t={s})");
        }
        let again = step(&mut schedule, secs(start, 600), idle(2)).expect("a report after registering again");
        assert_eq!(again["activity"], json!([]));
    }

    #[test]
    fn activity_is_debounced_but_never_dropped() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        step(&mut schedule, start, idle(1)).unwrap();
        assert!(step(&mut schedule, secs(start, 5), observed(&[Kind::TerminalInput], 0, 1, Counts::default())).is_none());
        assert!(step(&mut schedule, secs(start, 10), observed(&[Kind::AgentTurn], 0, 1, Counts::default())).is_none());
        let report = step(&mut schedule, secs(start, 15), idle(1)).unwrap();
        assert_eq!(report["activity"], json!(["agent-turn", "terminal-input"]));
        assert!(step(&mut schedule, secs(start, 30), idle(1)).is_none());
    }

    #[test]
    fn busy_counts_are_kept_alive_and_their_end_reported() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        step(&mut schedule, start, idle(1)).unwrap();
        let busy = Counts { active_turns: 1, pending_approvals: 2 };
        let report = step(&mut schedule, secs(start, 20), observed(&[], 0, 1, busy)).unwrap();
        assert_eq!((report["activeTurns"].as_u64(), report["pendingApprovals"].as_u64()), (Some(1), Some(2)));
        let mut sent = vec![];
        for s in 21..200 {
            if step(&mut schedule, secs(start, s), observed(&[], 0, 1, busy)).is_some() {
                sent.push(s);
            }
        }
        assert_eq!(sent, vec![65, 110, 155], "a keep-alive every {}s", KEEPALIVE.as_secs());
        let done = step(&mut schedule, secs(start, 200), idle(1)).expect("the end of the turn is reported");
        assert_eq!(done["activeTurns"], 0);
    }

    #[test]
    fn an_attached_client_is_reported_as_a_heartbeat() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        step(&mut schedule, start, idle(1)).unwrap();
        let mut sent = vec![];
        for s in 1..200 {
            if let Some(report) = step(&mut schedule, secs(start, s), observed(&[], 1, 1, Counts::default())) {
                assert_eq!(report["activity"], json!(["attachment"]));
                sent.push(s);
            }
        }
        assert_eq!(sent, vec![15, 46, 91, 136, 181]);
        // Detached: quiet again.
        for s in 200..400 {
            assert!(step(&mut schedule, secs(start, s), idle(1)).is_none());
        }
    }

    #[test]
    fn a_failed_report_is_retried_with_the_same_activity() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        let report = schedule.tick(start, observed(&[Kind::AgentTurn], 0, 1, Counts::default())).unwrap();
        schedule.sent(start, &report, false);
        assert!(schedule.tick(secs(start, 5), idle(1)).is_none(), "failures are spaced out too");
        let retry = schedule.tick(secs(start, 15), idle(1)).unwrap();
        assert_eq!(retry["activity"], json!(["agent-turn"]));
        schedule.sent(secs(start, 15), &retry, true);
        assert!(schedule.tick(secs(start, 30), idle(1)).is_none());
    }

    #[test]
    fn counts_are_clamped_to_the_contract() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        let many = Counts { active_turns: 20_000, pending_approvals: 3 };
        let report = step(&mut schedule, start, observed(&[], 0, 1, many)).unwrap();
        assert_eq!(report["activeTurns"], 10_000);
        assert!(step(&mut schedule, secs(start, 20), observed(&[], 0, 1, many)).is_none(), "unchanged once clamped");
    }
}
