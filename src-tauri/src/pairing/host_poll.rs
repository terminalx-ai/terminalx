//! The host-binding poll: the heartbeat that tells the account service this
//! Mac can be reached over Relay, and the fetch of the pairing grants and
//! revocations waiting for it.
//!
//! It runs beside one connected control channel. With nothing happening it
//! makes one round per heartbeat, over the one kept-alive connection of
//! [`crate::account::cloud_agent`]; a hint from the cell, or a grant, makes
//! it poll at the phone's pace for a while. A failed round backs off with
//! jitter, waits out a `Retry-After`, and is recorded in the relay
//! diagnostics. The heartbeat claims "live" only while the control channel
//! is hearing from the cell (#671).

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::Utc;
use rand_core::{OsRng, RngCore};

use crate::account::AccountContext;

use super::cloud::{self, RetryAfter};
use super::diagnostics::{Event, Failure, Stage};
use super::model::{AccountPairingGrant, AccountPairingRevocation};
use super::relay::{RelayLive, CONTROL_LIVENESS};
use super::PairingManager;

/// How often the poll runs and how it backs off.
#[derive(Clone, Copy, Debug)]
pub(super) struct Cadence {
    /// The account service treats a "live" heartbeat as current for 90 s
    /// (`liveReachabilityMaxAgeMs`), so every 30 s leaves room for two misses.
    heartbeat: Duration,
    /// Between rounds while nothing is happening: grants and revocations
    /// ride along with the heartbeat. A phone waiting to pair polls for its
    /// grant's whole 5-minute life, so this is how long it waits at most
    /// until the cell sends hints.
    idle: Duration,
    /// Between rounds, for `active_window` after a hint or a grant.
    active: Duration,
    active_window: Duration,
    /// The first failure's wait, doubling up to `backoff_max`.
    backoff_first: Duration,
    backoff_max: Duration,
    /// The longest `Retry-After` taken at its word.
    retry_after_max: Duration,
}

impl Cadence {
    pub(super) const APP: Self = Self {
        heartbeat: Duration::from_secs(30),
        idle: Duration::from_secs(30),
        active: Duration::from_secs(2),
        active_window: Duration::from_secs(60),
        backoff_first: Duration::from_secs(5),
        backoff_max: Duration::from_secs(5 * 60),
        retry_after_max: Duration::from_secs(15 * 60),
    };
}

/// When the next round runs, and whether it sends a heartbeat.
pub(super) struct Schedule {
    cadence: Cadence,
    /// Consecutive failed rounds.
    failures: u32,
    /// Poll at `cadence.active` until then.
    active_until: Option<Instant>,
    /// The service's `Retry-After`: no round before then, hint or not.
    not_before: Option<Instant>,
    last_heartbeat: Option<Instant>,
}

impl Schedule {
    pub(super) fn new(cadence: Cadence) -> Self {
        Self { cadence, failures: 0, active_until: None, not_before: None, last_heartbeat: None }
    }

    pub(super) fn heartbeat_due(&self, now: Instant) -> bool {
        self.last_heartbeat
            .is_none_or(|at| now.saturating_duration_since(at) >= self.cadence.heartbeat)
    }

    pub(super) fn heartbeat_sent(&mut self, at: Instant) {
        self.last_heartbeat = Some(at);
    }

    /// Something changed for this host, or is about to: poll fast for a
    /// while. Returns when the next round may start.
    pub(super) fn hinted(&mut self, now: Instant) -> Instant {
        self.active_until = Some(now + self.cadence.active_window);
        self.not_before.map_or(now, |at| at.max(now))
    }

    /// After a round that worked, finishing at `now`: when the next starts.
    pub(super) fn succeeded(&mut self, now: Instant) -> Instant {
        self.failures = 0;
        self.not_before = None;
        let active = self.active_until.is_some_and(|until| now < until);
        now + if active { self.cadence.active } else { self.cadence.idle }
    }

    /// After a round that failed at `now`: when the next starts. `jitter`
    /// is uniform in [0, 1).
    pub(super) fn failed(&mut self, now: Instant, retry_after: Option<Duration>, jitter: f64) -> Instant {
        self.failures = self.failures.saturating_add(1);
        let step = self
            .cadence
            .backoff_first
            .saturating_mul(1 << (self.failures - 1).min(16))
            .min(self.cadence.backoff_max);
        // At least half the step, so Macs that failed together (one outage)
        // do not all come back in the same second.
        let backoff = step / 2 + step.mul_f64(jitter.clamp(0.0, 1.0) / 2.0);
        self.not_before = retry_after.map(|after| now + after.min(self.cadence.retry_after_max));
        self.not_before.map_or(now + backoff, |at| at.max(now + backoff))
    }

    pub(super) fn failures(&self) -> u32 {
        self.failures
    }
}

fn jitter() -> f64 {
    f64::from(OsRng.next_u32()) / (f64::from(u32::MAX) + 1.0)
}

type Round = (AccountContext, Vec<AccountPairingGrant>, Vec<AccountPairingRevocation>);

impl PairingManager {
    /// Runs until the control channel closes, the epoch moves on (another
    /// channel, sign-out) or the account is no longer `user_id`'s.
    pub(super) async fn host_poll(self: Arc<Self>, epoch: u64, user_id: String, relay: RelayLive, generation: u64) {
        let base = crate::account::api_base_url();
        self.host_poll_with(epoch, user_id, relay, generation, base, Cadence::APP).await;
    }

    async fn host_poll_with(
        self: Arc<Self>,
        epoch: u64,
        user_id: String,
        relay: RelayLive,
        generation: u64,
        base: String,
        cadence: Cadence,
    ) {
        let host_id = relay.relay_host_id.clone();
        let mut schedule = Schedule::new(cadence);
        let mut recorded: Option<Failure> = None;
        let mut withholding_live = false;
        let mut next = Instant::now();
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(next.into()) => {}
                _ = relay.pairing_changed() => {
                    next = schedule.hinted(Instant::now());
                    if next > Instant::now() {
                        continue;
                    }
                }
                _ = relay.control_closed() => return,
            }
            if !self.is_epoch(epoch) {
                return;
            }
            let started = Instant::now();
            let heartbeat = schedule.heartbeat_due(started) && {
                let verified = relay.control_verified();
                if verified == withholding_live {
                    withholding_live = !verified;
                    if verified {
                        log::info!("relay control is answering again; reporting this Mac as live");
                    } else {
                        log::warn!(
                            "relay control silent for over {} s; not reporting this Mac as live",
                            CONTROL_LIVENESS.as_secs()
                        );
                    }
                }
                verified
            };
            let round = tokio::task::spawn_blocking({
                let manager = self.clone();
                let user_id = user_id.clone();
                let base = base.clone();
                let host_id = host_id.clone();
                move || -> Result<Option<Round>> {
                    // Access tokens last 30 minutes, and this refreshes one
                    // near its expiry; the token from connect time would be refused.
                    let Some(context) = manager.account_context().filter(|context| context.user_id == user_id)
                    else {
                        return Ok(None);
                    };
                    if heartbeat {
                        cloud::heartbeat(&base, &context, &host_id, generation)?;
                    }
                    let grants = cloud::pending_grants(&base, &context, &host_id, generation)?;
                    let revocations = cloud::pending_revocations(&base, &context, &host_id, generation)?;
                    Ok(Some((context, grants, revocations)))
                }
            })
            .await;
            match round {
                // Signed out or another account: the relay supervisor takes it from here.
                Ok(Ok(None)) => return,
                Ok(Ok(Some((context, grants, revocations)))) => {
                    if heartbeat {
                        schedule.heartbeat_sent(started);
                        if let Some(host) = self.inner.lock().unwrap().host.as_mut() {
                            host.last_seen_at = Some(Utc::now().to_rfc3339());
                        }
                    }
                    if schedule.failures() > 0 {
                        log::info!("host binding poll recovered after {} failed rounds", schedule.failures());
                        self.record_relay_diagnostic(Event::Recovered, schedule.failures(), None);
                    }
                    recorded = None;
                    // A phone is pairing; it may retry or another may follow.
                    if !grants.is_empty() {
                        schedule.hinted(Instant::now());
                    }
                    for grant in grants {
                        self.fulfill_grant(epoch, &context, &relay, generation, grant).await;
                    }
                    for revocation in revocations {
                        self.apply_revocation(&base, &context, &relay, generation, revocation).await;
                    }
                    self.emit();
                    next = schedule.succeeded(Instant::now());
                }
                Ok(Err(error)) => {
                    let error = error.context(Stage::HostBinding);
                    let retry_after = error.downcast_ref::<RetryAfter>().map(|after| after.0);
                    next = schedule.failed(Instant::now(), retry_after, jitter());
                    // One record per kind of failure in a streak, not one per round.
                    let failure = Failure::from_error(&error);
                    if recorded != Some(failure) {
                        self.record_relay_diagnostic(Event::Failed, schedule.failures(), Some(failure));
                        recorded = Some(failure);
                    }
                }
                Err(error) => {
                    log::warn!("host binding poll task failed: {error}");
                    next = schedule.failed(Instant::now(), None, jitter());
                }
            }
        }
    }

    async fn apply_revocation(
        &self,
        base: &str,
        context: &AccountContext,
        relay: &RelayLive,
        generation: u64,
        revocation: AccountPairingRevocation,
    ) {
        let host_id = &relay.relay_host_id;
        if revocation.user_id != context.user_id
            || &revocation.host_id != host_id
            || revocation.binding_generation != generation
        {
            return;
        }
        if let Ok(Some(device)) = self.registry.automatic_for_grant(
            &context.user_id,
            &revocation.client_installation_id,
            &revocation.grant_request_id,
        ) {
            if let Err(error) = self.fence_runtime_mobile("revoke", serde_json::json!({"deviceId":device.id})) {
                // The failed fence disconnects the attachment before
                // the persisted credential is retired below.
                log::warn!("fence revoked mobile grant: {error:#}");
            }
        }
        if let Ok(Some(device)) = self.registry.revoke_automatic_grant(
            &context.user_id,
            &revocation.client_installation_id,
            &revocation.grant_request_id,
        ) {
            let _ = self.secrets.delete_device_token(&device.id);
            self.cancel_connections(&device.id);
            relay.revoke(device.id);
        }
        let base = base.to_string();
        let context = context.clone();
        let host_id = host_id.clone();
        let revocation_id = revocation.revocation_id;
        let _ = tokio::task::spawn_blocking(move || {
            cloud::acknowledge_revocation(&base, &context, &host_id, &revocation_id, generation)
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::cloud::fixture::{KeepAliveServer, Recorded, Reply};
    use std::sync::atomic::{AtomicBool, Ordering};

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn an_idle_poll_runs_with_the_heartbeat_and_a_hint_speeds_it_up_for_a_while() {
        let start = Instant::now();
        let mut schedule = Schedule::new(Cadence::APP);
        assert!(schedule.heartbeat_due(start), "the first round heartbeats");
        schedule.heartbeat_sent(start);
        assert_eq!(schedule.succeeded(start + SECOND), start + 31 * SECOND);
        assert!(!schedule.heartbeat_due(start + 29 * SECOND));
        assert!(schedule.heartbeat_due(start + 31 * SECOND));

        let hinted = start + 40 * SECOND;
        assert_eq!(schedule.hinted(hinted), hinted, "a hint polls at once");
        assert_eq!(schedule.succeeded(hinted + SECOND), hinted + 3 * SECOND);
        assert_eq!(schedule.succeeded(hinted + 59 * SECOND), hinted + 61 * SECOND);
        assert_eq!(schedule.succeeded(hinted + 61 * SECOND), hinted + 91 * SECOND, "then idles again");
    }

    #[test]
    fn failures_back_off_with_jitter_up_to_a_cap_and_reset_on_success() {
        let now = Instant::now();
        let mut schedule = Schedule::new(Cadence::APP);
        // Half a step with no jitter, nearly a whole one with the most.
        assert_eq!(schedule.failed(now, None, 0.0), now + Duration::from_millis(2_500));
        assert_eq!(schedule.failed(now, None, 0.0), now + 5 * SECOND);
        assert_eq!(schedule.failed(now, None, 0.999_999), now + Duration::from_micros(19_999_990));
        for _ in 0..20 {
            schedule.failed(now, None, 0.5);
        }
        assert_eq!(schedule.failures(), 23);
        assert_eq!(schedule.failed(now, None, 0.0), now + 150 * SECOND);
        assert_eq!(schedule.failed(now, None, 1.0), now + 300 * SECOND, "never more than five minutes");
        assert_eq!(schedule.succeeded(now), now + 30 * SECOND);
        assert_eq!(schedule.failures(), 0);
        assert_eq!(schedule.failed(now, None, 0.0), now + Duration::from_millis(2_500));
    }

    #[test]
    fn retry_after_is_waited_out_even_by_a_hint() {
        let now = Instant::now();
        let mut schedule = Schedule::new(Cadence::APP);
        assert_eq!(schedule.failed(now, Some(40 * SECOND), 0.0), now + 40 * SECOND);
        assert_eq!(schedule.hinted(now + SECOND), now + 40 * SECOND);
        assert_eq!(schedule.hinted(now + 41 * SECOND), now + 41 * SECOND);
        // A longer backoff wins over a short Retry-After, and an absurd one is capped.
        for _ in 0..6 {
            schedule.failed(now, None, 0.0);
        }
        assert_eq!(schedule.failures(), 7);
        assert_eq!(schedule.failed(now, Some(SECOND), 0.0), now + 150 * SECOND);
        assert_eq!(schedule.failed(now, Some(86_400 * SECOND), 0.0), now + 900 * SECOND);
        // Without a Retry-After, a hint (Relay is answering) skips the backoff.
        schedule.failed(now, None, 0.0);
        assert_eq!(schedule.hinted(now + SECOND), now + SECOND);
    }

    const TEST_CADENCE: Cadence = Cadence {
        heartbeat: Duration::from_millis(250),
        idle: Duration::from_millis(250),
        active: Duration::from_millis(30),
        active_window: Duration::from_millis(400),
        backoff_first: Duration::from_millis(40),
        backoff_max: Duration::from_millis(160),
        retry_after_max: Duration::from_secs(5),
    };

    fn context(token: &str) -> AccountContext {
        AccountContext {
            access_token: token.into(),
            user_id: "test-user".into(),
            email: "fixture@example.invalid".into(),
            display_name: "Fixture".into(),
            profile_id: "test-profile".into(),
            organization_id: "test-org".into(),
            relay_entitled: true,
            generation: 1,
        }
    }

    fn kind(request: &Recorded) -> &'static str {
        let path = request.path.split('?').next().unwrap();
        match path.rsplit('/').next().unwrap() {
            "heartbeat" => "heartbeat",
            "pairing-grant-requests" => "grants",
            "revocations" => "revocations",
            _ => "other",
        }
    }

    fn count(server: &KeepAliveServer, wanted: &str) -> usize {
        server.requests().iter().filter(|request| kind(request) == wanted).count()
    }

    async fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(15), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
    }

    fn reply(request: &Recorded) -> Reply {
        match kind(request) {
            "heartbeat" => Reply::ok(r#"{"binding":{"reachability":"live"}}"#),
            "grants" => Reply::ok(r#"{"requests":[]}"#),
            "revocations" => Reply::ok(r#"{"revocations":[]}"#),
            _ => Reply { status: 404, retry_after: None, body: "{}".into() },
        }
    }

    fn manager(account: &Arc<crate::account::AccountManager>) -> Arc<PairingManager> {
        Arc::new(PairingManager::new(account.clone()))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_poll_reuses_a_connection_follows_the_token_and_claims_live_only_when_heard() {
        let server = KeepAliveServer::start(reply);
        let account = Arc::new(crate::account::AccountManager::default());
        account.set_context_for_test(Some(context("token-a")));
        let manager = manager(&account);
        manager.inner.lock().unwrap().host = Some(super::super::model::HostMetadata {
            host_id: "test-host".into(),
            public_key: "test-key".into(),
            binding_generation: 3,
            display_name: "Test Mac".into(),
            platform: "darwin".into(),
            environment_kind: "native".into(),
            capabilities: vec![],
            app_version: "0.0.0".into(),
            last_seen_at: None,
        });
        let last_seen = || manager.inner.lock().unwrap().host.as_ref().unwrap().last_seen_at.clone();
        let epoch = manager.epoch.load(Ordering::SeqCst);
        let (relay, control) = RelayLive::for_test("test-host", 3);
        let poll = tokio::spawn(manager.clone().host_poll_with(
            epoch,
            "test-user".into(),
            relay.clone(),
            3,
            server.base.clone(),
            TEST_CADENCE,
        ));

        wait_for("the first round", || count(&server, "revocations") >= 1).await;
        wait_for("the heartbeat to be noted", || last_seen().is_some()).await;
        let first: Vec<_> = server.requests().iter().map(kind).collect();
        assert_eq!(first, ["heartbeat", "grants", "revocations"]);
        assert!(server.requests()[1].path.ends_with("/host-account-bindings/test-host/pairing-grant-requests?bindingGeneration=3"));

        // The access token refreshes every 30 minutes; the poll takes the new one.
        account.set_context_for_test(Some(context("token-b")));
        wait_for("a round with the refreshed token", || {
            server.requests().iter().any(|request| request.authorization == "Bearer token-b")
        })
        .await;
        let rotated = server.requests().iter().position(|request| request.authorization == "Bearer token-b").unwrap();
        assert!(server.requests()[rotated..].iter().all(|request| request.authorization == "Bearer token-b"));

        // The control channel stops hearing from the cell (#666): no more "live".
        relay.signals.frame_received(chrono::Utc::now().timestamp_millis() - 60_000);
        let grants = count(&server, "grants");
        wait_for("a round after the silence began", || count(&server, "grants") >= grants + 2).await;
        let silent_from = server.requests().len();
        let seen_before_silence = last_seen();
        let grants = count(&server, "grants");
        wait_for("rounds well past the heartbeat interval", || count(&server, "grants") >= grants + 3).await;
        assert!(
            server.requests()[silent_from..].iter().all(|request| kind(request) != "heartbeat"),
            "a silent control channel is never reported as live"
        );
        assert_eq!(last_seen(), seen_before_silence, "last seen follows heartbeats, not rounds");

        // A frame arrives again; the next round heartbeats.
        relay.signals.frame_received(chrono::Utc::now().timestamp_millis());
        let heartbeats = count(&server, "heartbeat");
        wait_for("the heartbeat to resume", || count(&server, "heartbeat") > heartbeats).await;
        wait_for("last seen to move on", || last_seen() != seen_before_silence).await;

        assert_eq!(server.connections(), 1, "one kept-alive connection for every round");

        drop(control);
        tokio::time::timeout(Duration::from_secs(5), poll)
            .await
            .expect("the poll ends with its control channel")
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_hint_polls_at_once_and_a_rate_limit_is_waited_out_and_recorded() {
        let limited = Arc::new(AtomicBool::new(false));
        let refused_at = Arc::new(std::sync::Mutex::new(None::<Instant>));
        let server = KeepAliveServer::start({
            let (limited, refused_at) = (limited.clone(), refused_at.clone());
            move |request| {
                if kind(request) == "grants" && limited.swap(false, Ordering::SeqCst) {
                    *refused_at.lock().unwrap() = Some(request.at);
                    return Reply {
                        status: 429,
                        retry_after: Some(1),
                        body: r#"{"error":"account_pairing_rate_limited","retryAfter":1}"#.into(),
                    };
                }
                reply(request)
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let account = Arc::new(crate::account::AccountManager::default());
        account.set_context_for_test(Some(context("token-a")));
        let manager = manager(&account);
        manager.diagnostics.lock().unwrap().configure(directory.path().to_owned()).unwrap();
        let epoch = manager.epoch.load(Ordering::SeqCst);
        let (relay, control) = RelayLive::for_test("test-host", 3);
        // Idle for longer than the test runs, so only a hint explains a round.
        let cadence = Cadence {
            heartbeat: Duration::from_secs(60),
            idle: Duration::from_secs(60),
            active_window: Duration::from_secs(3),
            ..TEST_CADENCE
        };
        let poll = tokio::spawn(manager.clone().host_poll_with(
            epoch,
            "test-user".into(),
            relay.clone(),
            3,
            server.base.clone(),
            cadence,
        ));
        wait_for("the first round", || count(&server, "revocations") >= 1).await;

        relay.signals.hint_pairing_changed();
        wait_for("fast rounds after the hint", || count(&server, "grants") >= 4).await;

        limited.store(true, Ordering::SeqCst);
        relay.signals.hint_pairing_changed();
        wait_for("the refused round", || refused_at.lock().unwrap().is_some()).await;
        let refused = refused_at.lock().unwrap().unwrap();
        // Hints do not get around a Retry-After.
        relay.signals.hint_pairing_changed();
        let retried = || {
            server.requests().into_iter().find(|request| kind(request) == "grants" && request.at > refused).map(|request| request.at)
        };
        wait_for("the round after Retry-After", || retried().is_some()).await;
        let waited = retried().unwrap().duration_since(refused);
        assert!(waited >= Duration::from_millis(950), "{waited:?}");
        assert_eq!(server.connections(), 1);

        // The file is replaced whole, so a read sees one snapshot or the next.
        let path = directory.path().join(super::super::diagnostics::FILE_NAME);
        let records = || -> Vec<serde_json::Value> {
            serde_json::from_slice::<Vec<serde_json::Value>>(&std::fs::read(&path).unwrap()).unwrap()
        };
        // The round that recovers ends after its revocations request.
        wait_for("the recovery to be recorded", || records().iter().any(|record| record["event"] == "recovered")).await;
        let records = records();
        let failed = records.iter().find(|record| record["event"] == "failed").expect("the failure is recorded");
        assert_eq!(
            failed["failure"],
            serde_json::json!({ "stage": "host-binding", "category": "rate-limited", "httpStatus": 429 })
        );
        assert_eq!(failed["attempt"], 1);
        let recovered = records.iter().find(|record| record["event"] == "recovered").expect("so is the recovery");
        assert_eq!(recovered["attempt"], 1);
        let bytes = std::fs::read_to_string(&path).unwrap();
        for sensitive in ["token-a", "test-host", "test-user", "127.0.0.1"] {
            assert!(!bytes.contains(sensitive));
        }

        drop(control);
        tokio::time::timeout(Duration::from_secs(5), poll).await.unwrap().unwrap();
    }
}
