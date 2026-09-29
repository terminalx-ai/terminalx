//! The runtime half of an archive's final checkpoint (terminalx-saas
//! contract §10.3). This runtime advertises `quiesce-v1`, so while an
//! archive waits for it the `/refresh` answer carries a `quiesce` request.
//! The runtime then stops taking new work, uploads every agent tab's newest
//! transcript checkpoint (§12), and reports `committed` or `failed` once. The
//! server waits at most 60 s and never lets a missing answer block the
//! archive, so this stays inside the request's deadline.
//!
//! If the request is gone and a device attaches again, or compute is still
//! running ten minutes later (the archive failed, or was undone before
//! compute stopped), work resumes.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::cloud_agents::{checkpoints, now_ms, CloudAgents};
use crate::cloud_bootstrap::{Bootstrapped, CallError, HttpApi, QuiesceRequest};

/// Never more than this, whatever the request's deadline says.
const MAX_BUDGET: Duration = Duration::from_secs(55);
/// Kept back from the server's deadline for the report itself.
const REPORT_MARGIN: Duration = Duration::from_secs(5);
/// How long the request must have been gone before work resumes.
const HOLD: Duration = Duration::from_secs(10 * 60);
const TICK: Duration = Duration::from_secs(2);
const REPORT_RETRY: Duration = Duration::from_secs(1);

/// How long the final checkpoint may take: up to the request's deadline less
/// the time to report, at most `MAX_BUDGET`, and at least a second.
pub fn budget(request: &QuiesceRequest, now_ms: u64) -> Duration {
    let left = Duration::from_millis(request.deadline.saturating_sub(now_ms));
    left.saturating_sub(REPORT_MARGIN).min(MAX_BUDGET).max(Duration::from_secs(1))
}

/// What the watcher remembers between ticks.
#[derive(Default)]
pub struct Quiescer {
    /// The operation already answered: one report per archive.
    answered: Option<String>,
    /// Since when no request has been pending while work is paused.
    idle_since: Option<Instant>,
}

impl Quiescer {
    /// Look at the current request once. `report` sends the result and
    /// returns a `CallError::Rejected` when the answer is no longer wanted.
    pub fn tick(
        &mut self,
        request: Option<&QuiesceRequest>,
        agents: Option<&CloudAgents>,
        report: &mut dyn FnMut(&str, bool) -> Result<(), CallError>,
        now: Instant,
        now_ms: u64,
    ) {
        let Some(request) = request else {
            // A device attached again: the archive revoked every attachment,
            // so the workspace is in use (the archive failed or was undone).
            if let Some(agents) = agents.filter(|agents| agents.quiesced() && agents.attached() > 0) {
                log::info!("a device attached after the archive; taking work again");
                agents.resume_work();
                self.idle_since = None;
                return;
            }
            if agents.is_some_and(CloudAgents::quiesced) {
                let since = *self.idle_since.get_or_insert(now);
                if now.duration_since(since) >= HOLD {
                    log::info!("the archive did not stop this runtime; taking work again");
                    if let Some(agents) = agents {
                        agents.resume_work();
                    }
                    self.idle_since = None;
                }
            }
            return;
        };
        self.idle_since = None;
        if self.answered.as_deref() == Some(request.operation_id.as_str()) {
            return;
        }
        let deadline = now + budget(request, now_ms);
        let committed = match agents {
            Some(agents) => checkpoints::final_checkpoint(agents, deadline),
            // No agent state here: nothing more to save.
            None => true,
        };
        log::info!("final checkpoint for {}: {}", request.operation_id, if committed { "committed" } else { "failed" });
        let report_until = deadline + REPORT_MARGIN;
        loop {
            match report(&request.operation_id, committed) {
                Ok(()) => break,
                Err(CallError::Rejected) => {
                    log::warn!("the final checkpoint report for {} is no longer wanted", request.operation_id);
                    break;
                }
                Err(CallError::Transient(error)) => {
                    if Instant::now() + REPORT_RETRY >= report_until {
                        log::warn!("report the final checkpoint for {}: {error:#}", request.operation_id);
                        break;
                    }
                    std::thread::sleep(REPORT_RETRY);
                }
            }
        }
        self.answered = Some(request.operation_id.clone());
    }
}

/// Watch the refreshed session for quiesce requests in the background.
pub fn spawn(cloud: Arc<Bootstrapped>, origin: &str, agents: Option<Arc<CloudAgents>>) {
    let api = HttpApi::new(origin);
    let spawned = std::thread::Builder::new().name("cloud-quiesce".into()).spawn(move || {
        let mut quiescer = Quiescer::default();
        loop {
            std::thread::sleep(TICK);
            let request = cloud.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).quiesce.clone();
            let mut report = |operation_id: &str, committed: bool| cloud.report_checkpoint(&api, operation_id, committed);
            quiescer.tick(request.as_ref(), agents.as_deref(), &mut report, Instant::now(), now_ms());
        }
    });
    if let Err(error) = spawned {
        log::error!("start the cloud quiesce watcher: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, deadline: u64) -> QuiesceRequest {
        QuiesceRequest { operation_id: id.into(), reason: "archive".into(), requested_at: 0, deadline }
    }

    #[test]
    fn the_budget_stays_inside_the_servers_deadline() {
        assert_eq!(budget(&request("op", 60_000), 0), Duration::from_secs(55));
        assert_eq!(budget(&request("op", 30_000), 0), Duration::from_secs(25));
        assert_eq!(budget(&request("op", 3_000), 0), Duration::from_secs(1), "late, but still tried once");
        assert_eq!(budget(&request("op", 10), 50_000), Duration::from_secs(1));
    }

    #[test]
    fn each_archive_is_answered_once() {
        let mut quiescer = Quiescer::default();
        let reports = std::cell::RefCell::new(Vec::new());
        let mut report = |id: &str, committed: bool| {
            reports.borrow_mut().push((id.to_string(), committed));
            Ok(())
        };
        let now = Instant::now();
        quiescer.tick(Some(&request("op_1", 60_000)), None, &mut report, now, 0);
        quiescer.tick(Some(&request("op_1", 60_000)), None, &mut report, now, 1_000);
        quiescer.tick(Some(&request("op_2", 90_000)), None, &mut report, now, 2_000);
        assert_eq!(*reports.borrow(), [("op_1".to_string(), true), ("op_2".to_string(), true)]);
    }

    #[test]
    fn a_rejected_report_is_not_retried_and_a_lost_one_is_until_the_deadline() {
        let mut quiescer = Quiescer::default();
        let mut calls = 0;
        let mut rejected = |_: &str, _: bool| {
            calls += 1;
            Err(CallError::Rejected)
        };
        quiescer.tick(Some(&request("op_1", 60_000)), None, &mut rejected, Instant::now(), 0);
        assert_eq!(calls, 1);

        let mut attempts = 0;
        let mut flaky = |_: &str, _: bool| {
            attempts += 1;
            if attempts < 2 {
                Err(CallError::Transient(anyhow::anyhow!("network")))
            } else {
                Ok(())
            }
        };
        quiescer.tick(Some(&request("op_2", 60_000)), None, &mut flaky, Instant::now(), 0);
        assert_eq!(attempts, 2);
    }
}
