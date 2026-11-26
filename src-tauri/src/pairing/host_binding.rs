//! What the window does when the account service refuses this Mac's host
//! registration (PRO-598). The registration is what lists this Mac in the
//! account's machine list, so a refusal is never left silent: it is either
//! recovered from, retried, or said in Settings → Account with its reason.
//!
//! The binding generation fences both sides. Sign-out moves the local fence
//! to N + 1 and revokes the binding there at N + 1; the service then refuses
//! N + 1 again (`host_binding_inactive`), and only a later generation brings
//! the host back. When the revoke never reached it, the binding is still
//! active at N and the service refuses any later one
//! (`host_binding_generation_conflict`) until that binding is ended.
//! terminalx-server `services/accountPairing/hostBindings.ts` `register`.

use std::time::Duration;

use super::cloud::{refusal_code, CloudHttpError};

/// The next step after a refused registration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Recovery {
    /// The binding was revoked at this generation (a sign-out's unbind
    /// landed): register at the next one.
    NextGeneration,
    /// The binding is still active at an earlier generation (a sign-out's
    /// unbind never landed): end it at this generation, as that sign-out
    /// meant to, then register at the next one.
    UnbindThenNextGeneration,
    /// Not this Mac's to fix now (Relay has not confirmed it yet, a rate
    /// limit, the network, the service): try again after a wait.
    Retry,
    /// Only a person can fix it; say why and stop.
    GiveUp,
}

/// How many generation steps one bind may take. Each step answers one
/// refusal the service gives for a fence that lags it, so two cover a revoke
/// that landed and one that did not; more means the service disagrees with
/// itself, and the reason is shown instead of moving the fence further.
pub(super) const MAX_GENERATION_STEPS: u32 = 2;

pub(super) fn recovery(error: &anyhow::Error) -> Recovery {
    let status = error.downcast_ref::<CloudHttpError>().map(|status| status.0);
    match (status, refusal_code(error)) {
        (_, Some("host_binding_inactive")) => Recovery::NextGeneration,
        (_, Some("host_binding_generation_conflict")) => Recovery::UnbindThenNextGeneration,
        (_, Some("host_binding_proof_unavailable")) => Recovery::Retry,
        (_, Some("host_binding_owner_conflict" | "host_binding_identity_mismatch" | "host_binding_stale_generation")) => Recovery::GiveUp,
        // 401: the next attempt asks for a fresh session. 408, 429 and the
        // service's own failures pass.
        (Some(401 | 408 | 429), _) | (Some(500..=599), _) => Recovery::Retry,
        (Some(_), _) => Recovery::GiveUp,
        // No answer at all: the network.
        (None, _) => Recovery::Retry,
    }
}

/// Why this Mac is not on the account's machine list, as Settings → Account
/// says it. `this_mac` is the platform's name for this computer.
pub(super) fn reason(error: &anyhow::Error, this_mac: &str) -> String {
    let status = error.downcast_ref::<CloudHttpError>().map(|status| status.0);
    match refusal_code(error) {
        Some("host_binding_owner_conflict") => format!(
            "Another TerminalX account lists {this_mac}. Sign out of TerminalX on {this_mac} as that account, or sign in here with it."
        ),
        Some("host_binding_identity_mismatch") => format!(
            "Your account lists {this_mac} with another key than the one it has now. Remove {this_mac} from your account on another device, then sign in again here."
        ),
        Some("host_binding_stale_generation") => format!(
            "Your account has a newer sign-in of {this_mac} than this one. Sign out and in again under Settings → Account."
        ),
        Some("host_binding_proof_unavailable") => {
            format!("Relay has not confirmed that {this_mac} is connected yet. Trying again.")
        }
        Some(code) => format!("The account service refused {this_mac} ({code}). Trying again."),
        None => match status {
            Some(401) => "Your session needs renewing. Trying again.".into(),
            Some(429) => "The account service asked to wait. Trying again.".into(),
            Some(status) => format!("The account service answered HTTP {status}. Trying again."),
            None => format!("Could not reach the account service: {error:#}. Trying again."),
        },
    }
}

/// The wait before retry `attempt` (1-based): 5 s doubling to 5 minutes.
/// A `Retry-After` from the service waits at least as long.
pub(super) fn retry_delay(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let step = Duration::from_secs(5).saturating_mul(1 << attempt.saturating_sub(1).min(6)).min(Duration::from_secs(300));
    retry_after.map_or(step, |after| after.min(Duration::from_secs(900)).max(step))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::cloud::{CloudRefusal, RetryAfter};

    fn refused(status: u16, code: &str) -> anyhow::Error {
        anyhow::Error::new(CloudRefusal(code.into())).context(CloudHttpError(status))
    }

    #[test]
    fn a_binding_revoked_at_this_generation_registers_at_the_next() {
        // The owner's MacBook Pro: signed out (revoked at 2), signed in again at 2.
        assert_eq!(recovery(&refused(409, "host_binding_inactive")), Recovery::NextGeneration);
    }

    #[test]
    fn a_binding_still_active_at_an_earlier_generation_is_ended_first() {
        assert_eq!(recovery(&refused(409, "host_binding_generation_conflict")), Recovery::UnbindThenNextGeneration);
    }

    #[test]
    fn what_relay_or_the_network_has_not_settled_is_retried() {
        assert_eq!(recovery(&refused(503, "host_binding_proof_unavailable")), Recovery::Retry);
        let limited = anyhow::Error::new(RetryAfter(Duration::from_secs(7)))
            .context(CloudRefusal("account_pairing_rate_limited".into()))
            .context(CloudHttpError(429));
        assert_eq!(recovery(&limited), Recovery::Retry);
        assert_eq!(recovery(&anyhow::Error::new(CloudHttpError(401))), Recovery::Retry);
        assert_eq!(recovery(&anyhow::Error::new(CloudHttpError(502))), Recovery::Retry);
        assert_eq!(recovery(&anyhow::anyhow!("connection refused").context("cloud request failed")), Recovery::Retry);
    }

    #[test]
    fn what_only_a_person_can_fix_stops_with_its_reason() {
        for code in ["host_binding_owner_conflict", "host_binding_identity_mismatch", "host_binding_stale_generation"] {
            let error = refused(409, code);
            assert_eq!(recovery(&error), Recovery::GiveUp, "{code}");
            assert!(!reason(&error, "this Mac").contains("Trying again"), "{code}: a person must act");
        }
        assert_eq!(recovery(&refused(400, "account_pairing_invalid_request")), Recovery::GiveUp);
    }

    #[test]
    fn every_reason_names_the_computer_or_the_cause() {
        assert!(reason(&refused(409, "host_binding_owner_conflict"), "this Mac").contains("Another TerminalX account lists this Mac"));
        assert!(reason(&refused(503, "host_binding_proof_unavailable"), "this PC").contains("this PC"));
        assert!(reason(&refused(409, "host_binding_incompatible"), "this Mac").contains("host_binding_incompatible"));
        assert!(reason(&anyhow::Error::new(CloudHttpError(502)), "this Mac").contains("HTTP 502"));
    }

    #[test]
    fn retries_back_off_to_five_minutes_and_honour_retry_after() {
        assert_eq!(retry_delay(1, None), Duration::from_secs(5));
        assert_eq!(retry_delay(2, None), Duration::from_secs(10));
        assert_eq!(retry_delay(20, None), Duration::from_secs(300));
        assert_eq!(retry_delay(1, Some(Duration::from_secs(60))), Duration::from_secs(60));
        assert_eq!(retry_delay(1, Some(Duration::from_secs(9_999))), Duration::from_secs(900));
    }

    // ---- bind_host against the account service's own generation rules ----

    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};

    use serde_json::Value;

    use crate::account::AccountContext;
    use crate::pairing::cloud::fixture::{KeepAliveServer, Recorded, Reply};
    use crate::pairing::model::{AccountMirror, HostBindingPayload};
    use crate::pairing::{registry, AccountListing, PairingManager};

    /// One host's row in `host_account_bindings`, as terminalx-server keeps it.
    #[derive(Clone, Debug)]
    struct Row {
        owner: String,
        generation: u64,
        active: bool,
    }

    /// `hostBindings.register` and `hostBindings.unbind`, rule for rule
    /// (terminalx-server `services/accountPairing/hostBindings.ts`), for the
    /// one host and user these tests bind. `proof_unavailable` answers the
    /// first registrations as Relay does before it has confirmed the host.
    struct Directory {
        row: Mutex<Option<Row>>,
        proof_unavailable: Mutex<u32>,
    }

    fn refuse(status: u16, code: &str) -> Reply {
        Reply { status, retry_after: None, body: format!(r#"{{"error":"{code}"}}"#) }
    }

    impl Directory {
        fn new(row: Option<Row>) -> Arc<Self> {
            Arc::new(Self { row: Mutex::new(row), proof_unavailable: Mutex::new(0) })
        }

        fn answer(&self, request: &Recorded) -> Reply {
            let body = request.body.clone().unwrap_or(Value::Null);
            let generation = body["bindingGeneration"].as_u64().unwrap();
            let mut row = self.row.lock().unwrap();
            match request.method.as_str() {
                "POST" => {
                    let mut unproven = self.proof_unavailable.lock().unwrap();
                    if *unproven > 0 {
                        *unproven -= 1;
                        return refuse(503, "host_binding_proof_unavailable");
                    }
                    if let Some(existing) = row.as_ref() {
                        if existing.owner != USER && existing.active {
                            return refuse(409, "host_binding_owner_conflict");
                        }
                        if generation < existing.generation {
                            return refuse(409, "host_binding_stale_generation");
                        }
                        if existing.active && generation > existing.generation {
                            return refuse(409, "host_binding_generation_conflict");
                        }
                        if !existing.active && generation == existing.generation {
                            return refuse(409, "host_binding_inactive");
                        }
                    }
                    *row = Some(Row { owner: USER.into(), generation, active: true });
                    Reply { status: 201, retry_after: None, body: "{}".into() }
                }
                "DELETE" => {
                    let Some(existing) = row.as_mut().filter(|existing| existing.owner == USER) else {
                        return refuse(404, "host_binding_not_found");
                    };
                    if !existing.active && generation == existing.generation {
                        return Reply::ok("{}");
                    }
                    if generation <= existing.generation {
                        return refuse(409, "host_binding_stale_generation");
                    }
                    existing.generation = generation;
                    existing.active = false;
                    Reply::ok("{}")
                }
                method => panic!("unexpected {method} {}", request.path),
            }
        }
    }

    const USER: &str = "synthetic-user";
    const HOST: &str = "synthetic-host";

    fn context() -> AccountContext {
        AccountContext {
            access_token: "synthetic-access-token".into(),
            user_id: USER.into(),
            email: "fixture@example.invalid".into(),
            display_name: "Fixture".into(),
            profile_id: "synthetic-profile".into(),
            organization_id: "synthetic-org".into(),
            relay_entitled: true,
            generation: 1,
        }
    }

    struct Bind {
        bound: Option<u64>,
        saved_fence: u64,
        calls: Vec<(String, u64)>,
        listing: Option<AccountListing>,
        last_error: Option<String>,
    }

    /// `relay_ready`'s bind, from a local fence at `fence`.
    async fn bind(directory: Arc<Directory>, fence: u64) -> Bind {
        let _home = crate::store::temp_home();
        let server = KeepAliveServer::start({
            let directory = directory.clone();
            move |request| directory.answer(request)
        });
        let account = Arc::new(crate::account::AccountManager::default());
        account.set_context_for_test(Some(context()));
        let manager = Arc::new(PairingManager::new(account));
        let mut mirror = AccountMirror {
            user_id: USER.into(),
            email: "fixture@example.invalid".into(),
            display_name: "Fixture".into(),
            host_display_name: None,
            binding_generation: fence,
        };
        registry::save_account_mirror(&mirror).unwrap();
        let mut payload = HostBindingPayload {
            host_id: HOST.into(),
            host_public_key_b64: "synthetic-key".into(),
            binding_generation: fence,
            display_name: "Fixture Mac".into(),
            platform: "darwin".into(),
            environment_kind: "native".into(),
            capabilities: vec![],
        };
        let epoch = manager.epoch.load(Ordering::SeqCst);
        let bound = manager.bind_host(&server.base, epoch, USER, &mut mirror, &mut payload).await;
        let inner = manager.inner.lock().unwrap();
        Bind {
            bound,
            saved_fence: registry::load_account_mirror().unwrap().unwrap().binding_generation,
            calls: server
                .requests()
                .iter()
                .map(|request| (request.method.clone(), request.body.as_ref().unwrap()["bindingGeneration"].as_u64().unwrap()))
                .collect(),
            listing: inner.account_listing.clone(),
            last_error: inner.last_error.clone(),
        }
    }

    fn calls(expected: &[(&str, u64)]) -> Vec<(String, u64)> {
        expected.iter().map(|(method, generation)| (method.to_string(), *generation)).collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn signed_out_and_in_again_the_mac_is_listed_at_the_next_generation() {
        // The owner's MacBook Pro (PRO-598): signed out, which revoked it at 2
        // and left the fence at 2; signed in again as the same person.
        let directory = Directory::new(Some(Row { owner: USER.into(), generation: 2, active: false }));
        let bind = bind(directory.clone(), 2).await;
        assert_eq!(bind.calls, calls(&[("POST", 2), ("POST", 3)]));
        assert_eq!(bind.bound, Some(3));
        assert_eq!(bind.saved_fence, 3, "the fence moved before the registration that was taken");
        let row = directory.row.lock().unwrap().clone().unwrap();
        assert!(row.active && row.generation == 3, "listed: {row:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_sign_out_the_service_never_heard_is_finished_then_the_mac_is_listed() {
        // Signed out offline: the fence moved to 2, the binding stayed active at 1.
        let directory = Directory::new(Some(Row { owner: USER.into(), generation: 1, active: true }));
        let bind = bind(directory.clone(), 2).await;
        assert_eq!(bind.calls, calls(&[("POST", 2), ("DELETE", 2), ("POST", 3)]));
        assert_eq!((bind.bound, bind.saved_fence), (Some(3), 3));
        assert!(directory.row.lock().unwrap().as_ref().unwrap().active);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_mac_the_service_has_not_seen_registers_as_before() {
        let directory = Directory::new(None);
        let bind = bind(directory, 1).await;
        assert_eq!(bind.calls, calls(&[("POST", 1)]));
        assert_eq!((bind.bound, bind.saved_fence), (Some(1), 1));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relay_not_confirming_yet_is_said_and_retried() {
        let directory = Directory::new(None);
        *directory.proof_unavailable.lock().unwrap() = 1;
        let bind = bind(directory, 1).await;
        assert_eq!(bind.calls, calls(&[("POST", 1), ("POST", 1)]), "the same generation, after the wait");
        assert_eq!(bind.bound, Some(1));
        // What it said while it waited; relay_ready clears it once listed.
        assert!(matches!(&bind.listing, Some(AccountListing::Pending { reason }) if reason.contains("Relay has not confirmed")), "{:?}", bind.listing);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn another_accounts_mac_is_refused_with_the_reason_and_the_fence_kept() {
        let directory = Directory::new(Some(Row { owner: "someone-else".into(), generation: 4, active: true }));
        let bind = bind(directory, 1).await;
        assert_eq!(bind.calls, calls(&[("POST", 1)]));
        assert_eq!((bind.bound, bind.saved_fence), (None, 1));
        let Some(AccountListing::Refused { reason }) = &bind.listing else { panic!("{:?}", bind.listing) };
        assert!(reason.contains("Another TerminalX account lists this Mac"), "{reason}");
        assert!(bind.last_error.as_deref().is_some_and(|error| error.contains(reason.as_str())));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_newer_binding_elsewhere_is_refused_not_stepped_past() {
        let directory = Directory::new(Some(Row { owner: USER.into(), generation: 7, active: true }));
        let bind = bind(directory, 2).await;
        assert_eq!(bind.calls, calls(&[("POST", 2)]));
        assert_eq!((bind.bound, bind.saved_fence), (None, 2));
        assert!(matches!(bind.listing, Some(AccountListing::Refused { .. })));
    }
}
