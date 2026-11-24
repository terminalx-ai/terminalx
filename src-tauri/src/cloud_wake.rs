//! When a suspended cloud workspace should wake for a bot (PRO-482).
//!
//! A bot that lives on a cloud workspace keeps its duties on the workspace's
//! own scheduler (`automations`), which runs only while the workspace does.
//! The workspace is suspended once it has been idle for its idle-suspend
//! time, so it would sleep through a duty's time. The runtime therefore tells
//! the API the soonest time one of its bots' duties is due
//! (`POST /v1/cloud-workspace-bootstrap/wake-at`, terminalx-saas PRO-482):
//! the API resumes a suspended workspace at that time, and the scheduler,
//! which takes a due run within the duty's grace, runs it. `null` clears it.
//!
//! The time is read again every [`EVERY`] and sent only when it changed, or
//! once more after a failed send. An API that does not have the endpoint yet
//! (an older terminalx-saas) is asked again only after [`UNSERVED_RETRY`], not
//! every minute. Such an API also refuses the 2-minute idle window the window
//! asks for at a move, so the workspace keeps its own window there. A duty woken by an event (GitHub, Linear,
//! another bot) is read when the workspace next runs: the API cannot see such
//! an event while nothing in the workspace runs.

use std::time::Duration;

use chrono::{DateTime, Utc};

/// How often the soonest wake is read again.
pub const EVERY: Duration = Duration::from_secs(60);
/// A wake is asked for this much before the duty's time, so the workspace is
/// up when it is due (a resume takes tens of seconds).
pub const LEAD: chrono::TimeDelta = chrono::TimeDelta::seconds(90);

/// The time to ask the API to wake the workspace at: the soonest next run of
/// a duty that is on, of a bot that lives here and is not paused, less
/// [`LEAD`]. `None` with Bots off or nothing due.
pub fn next_wake(now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if !crate::bots::enabled() {
        return None;
    }
    let bots = crate::store::bots::list().ok()?;
    let working = |id: &str| bots.iter().any(|bot| bot.id == id && bot.paused.is_none() && bot.runs_on.here());
    let automations = crate::store::automations::list().ok()?;
    automations
        .iter()
        .filter(|automation| automation.enabled)
        .filter(|automation| crate::bots::duties::owner(automation).is_some_and(|owner| working(&owner.id)))
        .filter_map(|automation| DateTime::parse_from_rfc3339(&automation.next_run_at).ok())
        .map(|at| at.with_timezone(&Utc) - LEAD)
        .min()
        // A time already past asks for no wake: the workspace is running now.
        .filter(|at| *at > now)
}

/// The body the API takes.
pub fn report(at: Option<DateTime<Utc>>) -> serde_json::Value {
    serde_json::json!({ "v": 1, "at": at.map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)) })
}

/// How long an API without the endpoint is left before it is asked again.
pub const UNSERVED_RETRY: Duration = Duration::from_secs(60 * 60);

/// How a send went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sent {
    Taken,
    Failed,
    /// The API has no such endpoint (HTTP 404).
    Unserved,
}

/// What was last sent, so an unchanged time is not sent again.
#[derive(Default)]
pub struct Reporter {
    sent: Option<Option<DateTime<Utc>>>,
    unserved_until: Option<std::time::Instant>,
}

impl Reporter {
    /// The report to send now, if the wake changed since the last one sent.
    pub fn due(&self, wake: Option<DateTime<Utc>>) -> Option<serde_json::Value> {
        self.due_at(wake, std::time::Instant::now())
    }

    fn due_at(&self, wake: Option<DateTime<Utc>>, now: std::time::Instant) -> Option<serde_json::Value> {
        if self.unserved_until.is_some_and(|until| now < until) {
            return None;
        }
        (self.sent != Some(wake)).then(|| report(wake))
    }

    pub fn sent(&mut self, wake: Option<DateTime<Utc>>, outcome: Sent) {
        self.sent_at(wake, outcome, std::time::Instant::now());
    }

    fn sent_at(&mut self, wake: Option<DateTime<Utc>>, outcome: Sent, now: std::time::Instant) {
        self.unserved_until = (outcome == Sent::Unserved).then(|| now + UNSERVED_RETRY);
        if outcome == Sent::Taken {
            self.sent = Some(wake);
        }
    }
}

/// Start the thread that keeps the API told. `send` posts a report and says whether the API took it.
pub fn spawn_reporter(send: impl Fn(&serde_json::Value) -> Sent + Send + 'static) {
    std::thread::Builder::new()
        .name("cloud-wake".into())
        .spawn(move || {
            let mut reporter = Reporter::default();
            loop {
                let wake = next_wake(Utc::now());
                if let Some(body) = reporter.due(wake) {
                    reporter.sent(wake, send(&body));
                }
                std::thread::sleep(EVERY);
            }
        })
        .expect("start the cloud wake reporter");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wake_is_sent_once_until_it_changes_and_again_after_a_failure() {
        let at = DateTime::parse_from_rfc3339("2026-11-23T10:00:00Z").unwrap().with_timezone(&Utc);
        let mut reporter = Reporter::default();
        assert_eq!(reporter.due(None), Some(serde_json::json!({"v": 1, "at": null})));
        reporter.sent(None, Sent::Taken);
        assert_eq!(reporter.due(None), None);
        assert_eq!(reporter.due(Some(at)), Some(serde_json::json!({"v": 1, "at": "2026-11-23T10:00:00Z"})));
        reporter.sent(Some(at), Sent::Failed);
        assert!(reporter.due(Some(at)).is_some(), "a failed send is sent again");
        reporter.sent(Some(at), Sent::Taken);
        assert_eq!(reporter.due(Some(at)), None);
    }

    #[test]
    fn an_api_without_the_endpoint_is_asked_again_only_after_an_hour() {
        let now = std::time::Instant::now();
        let mut reporter = Reporter::default();
        reporter.sent_at(None, Sent::Unserved, now);
        assert_eq!(reporter.due_at(None, now + EVERY), None);
        assert_eq!(reporter.due_at(None, now + UNSERVED_RETRY - EVERY), None);
        assert!(reporter.due_at(None, now + UNSERVED_RETRY).is_some());
        reporter.sent_at(None, Sent::Taken, now + UNSERVED_RETRY);
        assert_eq!(reporter.due_at(None, now + UNSERVED_RETRY), None);
    }
}
