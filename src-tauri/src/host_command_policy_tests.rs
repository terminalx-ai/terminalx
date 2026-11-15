use super::*;
use std::sync::Barrier;
use std::thread;

fn origin() -> Origin {
    Origin { mac: "mac-a".into(), account: "account-a".into(), organization: "org-a".into(),
        workspace: "workspace-a".into(), tab: "tab-a".into(), turn: "turn-a".into() }
}

fn context() -> TrustedContext {
    TrustedContext { enabled: Some(true), local_mac: Some("mac-a".into()), origin: Some(origin()),
        generation: Some(1), approval_revision: Some(1), can_approve: Some(true), turn_active: Some(true) }
}

fn input(id: &str) -> RequestInput {
    RequestInput { id: id.into(), origin: origin(), generation: 1, approval_revision: 1,
        issued_at_ms: 10, expires_at_ms: 100, executable: "/usr/bin/printf".into(),
        arguments: vec!["%s".into(), "literal ; $(text)\n\u{202e}".into()], cwd: "/local/folder".into(),
        timeout_ms: 1000, output_limit_bytes: 4096 }
}

fn policy() -> Policy {
    let policy = Policy::default();
    policy.update_trusted_context(context(), 10).unwrap();
    policy
}

fn approved(policy: &Policy) -> Request {
    let request = policy.submit(input("one"), 10).unwrap();
    let binding = request.prepare_local_decision(10).unwrap();
    assert_eq!(request.record_local_decision(binding, LocalDecision::AllowOnce, 10), Ok(State::Approved));
    request
}

#[test]
fn default_and_unknown_context_deny() {
    assert_eq!(Policy::default().submit(input("one"), 10).err(), Some(Rejection::ContextUnavailable));
    let mutations: Vec<Box<dyn Fn(&mut TrustedContext)>> = vec![
        Box::new(|c| c.enabled = None), Box::new(|c| c.enabled = Some(false)),
        Box::new(|c| c.can_approve = None), Box::new(|c| c.can_approve = Some(false)),
        Box::new(|c| c.turn_active = None), Box::new(|c| c.turn_active = Some(false)),
        Box::new(|c| c.local_mac = None), Box::new(|c| c.origin = None),
        Box::new(|c| c.generation = None), Box::new(|c| c.generation = Some(0)),
        Box::new(|c| c.approval_revision = None), Box::new(|c| c.approval_revision = Some(0)),
        Box::new(|c| c.local_mac = Some(String::new())),
    ];
    for mutate in mutations {
        let p = Policy::default();
        let mut c = context(); mutate(&mut c);
        p.update_trusted_context(c, 10).unwrap();
        assert_eq!(p.submit(input("one"), 10).err(), Some(Rejection::ContextUnavailable));
    }
}

#[test]
fn exact_origin_all_dimensions_and_missing_identity_deny() {
    for dimension in 0..6 {
        for replacement in ["different", ""] {
            let p = policy();
            let mut proposal = input("one");
            let o = &mut proposal.origin;
            let fields = [&mut o.mac, &mut o.account, &mut o.organization, &mut o.workspace, &mut o.tab, &mut o.turn];
            *fields.into_iter().nth(dimension).unwrap() = replacement.into();
            assert_eq!(p.submit(proposal, 10).err(), Some(if replacement.is_empty() {
                Rejection::InvalidRequest
            } else { Rejection::ContextMismatch }));
        }
    }
}

#[test]
fn same_account_other_mac_and_stale_generation_or_rights_deny() {
    let p = policy();
    let mut c = context(); c.local_mac = Some("mac-b".into());
    p.update_trusted_context(c, 10).unwrap();
    assert_eq!(p.submit(input("one"), 10).err(), Some(Rejection::ContextMismatch));
    for field in [0, 1] {
        let p = policy(); let mut proposal = input("one");
        if field == 0 { proposal.generation = 2; } else { proposal.approval_revision = 2; }
        assert_eq!(p.submit(proposal, 10).err(), Some(Rejection::ContextMismatch));
    }
}

#[test]
fn malformed_and_bounded_request_rejected() {
    let mutations: Vec<Box<dyn Fn(&mut RequestInput)>> = vec![
        Box::new(|i| i.id.clear()), Box::new(|i| i.id = "x".repeat(129)),
        Box::new(|i| i.id = "white space".into()), Box::new(|i| i.generation = 0),
        Box::new(|i| i.approval_revision = 0), Box::new(|i| i.executable.clear()),
        Box::new(|i| i.executable = "x".repeat(4097)), Box::new(|i| i.cwd.clear()),
        Box::new(|i| i.cwd = "x".repeat(4097)), Box::new(|i| i.arguments.push("\0".into())),
        Box::new(|i| i.executable.push('\0')), Box::new(|i| i.cwd.push('\0')),
        Box::new(|i| i.arguments = vec!["".into(); MAX_ARGUMENTS + 1]),
        Box::new(|i| i.arguments = vec!["x".repeat(8193)]),
        Box::new(|i| i.arguments = vec!["x".repeat(8192); 5]),
        Box::new(|i| i.expires_at_ms = i.issued_at_ms),
        Box::new(|i| i.expires_at_ms = i.issued_at_ms - 1),
        Box::new(|i| i.expires_at_ms = i.issued_at_ms + MAX_TTL_MS + 1),
        Box::new(|i| i.timeout_ms = 0), Box::new(|i| i.timeout_ms = MAX_TIMEOUT_MS + 1),
        Box::new(|i| i.output_limit_bytes = 0), Box::new(|i| i.output_limit_bytes = MAX_OUTPUT_BYTES + 1),
    ];
    for mutate in mutations {
        let p = policy(); let mut proposal = input("one"); mutate(&mut proposal);
        assert_eq!(p.submit(proposal, 10).err(), Some(Rejection::InvalidRequest));
    }
}

#[test]
fn valid_limits_and_exact_text_are_preserved_without_interpretation() {
    let p = policy(); let mut proposal = input("one");
    proposal.arguments.push(String::new());
    proposal.timeout_ms = MAX_TIMEOUT_MS; proposal.output_limit_bytes = MAX_OUTPUT_BYTES;
    proposal.expires_at_ms = proposal.issued_at_ms + MAX_TTL_MS;
    let original = proposal.clone();
    let request = p.submit(proposal, 10).unwrap();
    assert_eq!(request.input().arguments, original.arguments);
    assert_eq!(request.input().cwd, original.cwd);
    assert_eq!(request.input().executable, original.executable);
    let mut copy = request.input().clone(); copy.arguments.clear();
    assert_eq!(request.input().arguments, original.arguments);
}

#[test]
fn expiry_is_exclusive_and_late_decision_cannot_resurrect() {
    let p = policy(); let request = p.submit(input("one"), 10).unwrap();
    let binding = request.prepare_local_decision(99).unwrap();
    assert_eq!(request.record_local_decision(binding, LocalDecision::AllowOnce, 100), Err(Rejection::Expired));
    assert_eq!(request.take_ready_for_lead_integration(100), Err(Rejection::Expired));
    assert_eq!(p.submit(input("one"), 100).err(), Some(Rejection::Replay));
    let p = policy(); assert_eq!(p.submit(input("one"), 100).err(), Some(Rejection::Expired));
    let p = Policy::default(); p.update_trusted_context(context(), 0).unwrap();
    assert_eq!(p.submit(input("future"), 9).err(), Some(Rejection::Expired));
}

#[test]
fn approved_request_expires_before_ready() {
    let p = policy(); let request = approved(&p);
    assert_eq!(request.take_ready_for_lead_integration(100), Err(Rejection::Expired));
}

#[test]
fn one_successful_ready_observation_and_replay_tombstones() {
    let p = policy(); let request = approved(&p);
    assert_eq!(request.take_ready_for_lead_integration(10), Ok(State::ReadyForLeadIntegration));
    assert_eq!(request.clone().take_ready_for_lead_integration(10), Err(Rejection::InvalidTransition));
    assert_eq!(p.clone().submit(input("one"), 10).err(), Some(Rejection::Replay));
    let mut changed = input("one"); changed.arguments.push("changed".into());
    assert_eq!(p.submit(changed, 10).err(), Some(Rejection::Replay));
}

#[test]
fn deny_is_default_and_terminal() {
    let p = policy(); let request = p.submit(input("one"), 10).unwrap();
    let binding = request.prepare_local_decision(10).unwrap();
    assert_eq!(request.record_local_decision(binding, LocalDecision::default(), 10), Ok(State::Denied));
    assert_eq!(request.prepare_local_decision(10).err(), Some(Rejection::InvalidTransition));
    assert_eq!(request.take_ready_for_lead_integration(10), Err(Rejection::InvalidTransition));
}

#[test]
fn changed_request_binding_cannot_approve_another_request() {
    let p = policy(); let first = p.submit(input("one"), 10).unwrap();
    let binding = first.prepare_local_decision(10).unwrap(); first.cancel(10).unwrap();
    let second = p.submit(input("two"), 10).unwrap();
    assert_eq!(second.record_local_decision(binding, LocalDecision::AllowOnce, 10), Err(Rejection::DecisionMismatch));
    assert_eq!(second.state(10), Ok(State::Denied));
}

#[test]
fn foreign_policy_same_id_binding_is_rejected() {
    let p = policy(); let q = policy();
    let first = p.submit(input("one"), 10).unwrap(); let second = q.submit(input("one"), 10).unwrap();
    assert_eq!(second.record_local_decision(first.prepare_local_decision(10).unwrap(), LocalDecision::AllowOnce, 10),
        Err(Rejection::DecisionMismatch));
}

#[test]
fn duplicate_and_reordered_transitions_never_make_ready_twice() {
    let p = policy(); let request = p.submit(input("one"), 10).unwrap();
    assert_eq!(request.take_ready_for_lead_integration(10), Err(Rejection::InvalidTransition));
    let first = request.prepare_local_decision(10).unwrap(); let duplicate = request.prepare_local_decision(10).unwrap();
    request.record_local_decision(first, LocalDecision::AllowOnce, 10).unwrap();
    assert_eq!(request.record_local_decision(duplicate, LocalDecision::AllowOnce, 10), Err(Rejection::InvalidTransition));
    request.take_ready_for_lead_integration(10).unwrap();
    assert_eq!(request.prepare_local_decision(10).err(), Some(Rejection::InvalidTransition));
}

#[test]
fn cancellation_fences_pending_approved_and_ready() {
    for phase in 0..3 {
        let p = policy(); let request = p.submit(input("one"), 10).unwrap();
        let binding = request.prepare_local_decision(10).unwrap();
        let late = request.prepare_local_decision(10).unwrap();
        if phase > 0 { request.record_local_decision(binding, LocalDecision::AllowOnce, 10).unwrap(); }
        if phase > 1 { request.take_ready_for_lead_integration(10).unwrap(); }
        assert_eq!(request.cancel(10), Ok(State::Cancelled));
        assert_eq!(request.record_local_decision(late, LocalDecision::AllowOnce, 10), Err(Rejection::InvalidTransition));
        assert_eq!(request.take_ready_for_lead_integration(10), Err(Rejection::InvalidTransition));
        assert_eq!(p.submit(input("one"), 10).err(), Some(Rejection::Replay));
    }
}

#[test]
fn every_context_change_revokes_without_resurrection() {
    let mutations: Vec<Box<dyn Fn(&mut TrustedContext)>> = vec![
        Box::new(|c| c.enabled = Some(false)), Box::new(|c| c.can_approve = Some(false)),
        Box::new(|c| c.turn_active = Some(false)), Box::new(|c| c.local_mac = None),
        Box::new(|c| c.origin = None), Box::new(|c| c.generation = Some(2)),
        Box::new(|c| c.approval_revision = Some(2)),
        Box::new(|c| c.origin.as_mut().unwrap().mac = "mac-b".into()),
        Box::new(|c| c.origin.as_mut().unwrap().account = "account-b".into()),
        Box::new(|c| c.origin.as_mut().unwrap().organization = "org-b".into()),
        Box::new(|c| c.origin.as_mut().unwrap().workspace = "workspace-b".into()),
        Box::new(|c| c.origin.as_mut().unwrap().tab = "tab-b".into()),
        Box::new(|c| c.origin.as_mut().unwrap().turn = "turn-b".into()),
    ];
    for mutate in mutations {
        for phase in 0..3 {
            let p = policy(); let request = p.submit(input("one"), 10).unwrap();
            let late = request.prepare_local_decision(10).unwrap();
            if phase > 0 { request.record_local_decision(request.prepare_local_decision(10).unwrap(), LocalDecision::AllowOnce, 10).unwrap(); }
            if phase > 1 { request.take_ready_for_lead_integration(10).unwrap(); }
            let mut c = context(); mutate(&mut c);
            p.update_trusted_context(c, 11).unwrap();
            p.update_trusted_context(context(), 12).unwrap();
            assert_eq!(request.state(12), Ok(State::Revoked));
            assert_eq!(request.record_local_decision(late, LocalDecision::AllowOnce, 12), Err(Rejection::InvalidTransition));
            assert_eq!(request.take_ready_for_lead_integration(12), Err(Rejection::InvalidTransition));
        }
    }
}

#[test]
fn unchanged_context_does_not_revoke() {
    let p = policy(); let request = approved(&p);
    p.update_trusted_context(context(), 11).unwrap();
    assert_eq!(request.take_ready_for_lead_integration(11), Ok(State::ReadyForLeadIntegration));
}

#[test]
fn clock_rollback_disables_and_revokes_instead_of_extending_approval() {
    let p = policy(); let request = approved(&p);
    assert_eq!(request.take_ready_for_lead_integration(9), Err(Rejection::ClockReversed));
    assert_eq!(p.submit(input("two"), 10).err(), Some(Rejection::ContextUnavailable));
    p.update_trusted_context(context(), 10).unwrap();
    assert_eq!(request.state(10), Ok(State::Revoked));
    assert_eq!(request.take_ready_for_lead_integration(10), Err(Rejection::InvalidTransition));
}

#[test]
fn all_live_phases_block_other_commands_but_terminal_entries_allow_next_id() {
    for phase in 0..3 {
        let p = policy(); let request = p.submit(input("one"), 10).unwrap();
        if phase > 0 { request.record_local_decision(request.prepare_local_decision(10).unwrap(), LocalDecision::AllowOnce, 10).unwrap(); }
        if phase > 1 { request.take_ready_for_lead_integration(10).unwrap(); }
        assert_eq!(p.submit(input("two"), 10).err(), Some(Rejection::Busy));
        request.cancel(10).unwrap();
        assert!(p.submit(input("two"), 10).is_ok());
    }
}

#[test]
fn expiry_releases_busy_slot_without_removing_replay_tombstone() {
    let p = policy(); let _request = p.submit(input("one"), 10).unwrap();
    let mut next = input("two"); next.issued_at_ms = 100; next.expires_at_ms = 200;
    assert!(p.submit(next, 100).is_ok());
    assert_eq!(p.submit(input("one"), 100).err(), Some(Rejection::Replay));
}

#[test]
fn bounded_registry_keeps_terminal_tombstones_and_denies_when_full() {
    let p = policy();
    for id in 0..MAX_REQUESTS {
        p.submit(input(&format!("request-{id}")), 10).unwrap().cancel(10).unwrap();
    }
    assert_eq!(p.submit(input("new"), 10).err(), Some(Rejection::Capacity));
    assert_eq!(p.submit(input("request-0"), 10).err(), Some(Rejection::Replay));
}

#[test]
fn concurrent_distinct_submission_has_one_winner_across_policy_clones() {
    let p = policy(); let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8).map(|id| {
        let p = p.clone(); let barrier = barrier.clone();
        thread::spawn(move || { barrier.wait(); p.submit(input(&format!("request-{id}")), 10).map(|_| ()) })
    }).collect();
    let results: Vec<_> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|r| **r == Err(Rejection::Busy)).count(), 7);
}

#[test]
fn concurrent_same_id_submission_has_one_winner() {
    let p = policy(); let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8).map(|_| {
        let p = p.clone(); let barrier = barrier.clone();
        thread::spawn(move || { barrier.wait(); p.submit(input("same"), 10).map(|_| ()) })
    }).collect();
    let results: Vec<_> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|r| **r == Err(Rejection::Replay)).count(), 7);
}

#[test]
fn cloned_handles_share_one_consumption_gate_under_race() {
    let p = policy(); let request = approved(&p); let barrier = Arc::new(Barrier::new(16));
    let threads: Vec<_> = (0..16).map(|_| {
        let request = request.clone(); let barrier = barrier.clone();
        thread::spawn(move || { barrier.wait(); request.take_ready_for_lead_integration(10) })
    }).collect();
    let results: Vec<_> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| **r == Ok(State::ReadyForLeadIntegration)).count(), 1);
    assert_eq!(results.iter().filter(|r| **r == Err(Rejection::InvalidTransition)).count(), 15);
}

#[test]
fn cancelled_or_revoked_request_cannot_win_a_later_take_race() {
    for revoke in [false, true] {
        let p = policy(); let request = approved(&p);
        if revoke { p.update_trusted_context(TrustedContext::default(), 10).unwrap(); }
        else { request.cancel(10).unwrap(); }
        let thread = thread::spawn(move || request.take_ready_for_lead_integration(10));
        assert!(thread.join().unwrap().is_err());
    }
}

#[test]
fn poisoned_registry_fails_closed() {
    let p = policy(); let request = approved(&p); let shared = p.shared.clone();
    assert!(thread::spawn(move || { let _guard = shared.lock().unwrap(); panic!("simulated panic"); }).join().is_err());
    assert_eq!(request.take_ready_for_lead_integration(10), Err(Rejection::Poisoned));
    assert_eq!(p.submit(input("two"), 10).err(), Some(Rejection::Poisoned));
    assert_eq!(p.update_trusted_context(context(), 10), Err(Rejection::Poisoned));
}

#[test]
fn missing_trusted_origin_dimension_denies_even_when_proposal_is_complete() {
    for dimension in 0..6 {
        let p = Policy::default(); let mut c = context(); let o = c.origin.as_mut().unwrap();
        let fields = [&mut o.mac, &mut o.account, &mut o.organization, &mut o.workspace, &mut o.tab, &mut o.turn];
        fields.into_iter().nth(dimension).unwrap().clear();
        p.update_trusted_context(c, 10).unwrap();
        assert_eq!(p.submit(input("one"), 10).err(), Some(Rejection::ContextUnavailable));
    }
}

#[test]
fn cancel_and_revocation_races_are_serialized_and_fence_subsequent_observations() {
    for revoke in [false, true] {
        let p = policy(); let request = approved(&p); let barrier = Arc::new(Barrier::new(2));
        let consumer = request.clone(); let consumer_barrier = barrier.clone();
        let taking = thread::spawn(move || {
            consumer_barrier.wait(); consumer.take_ready_for_lead_integration(10)
        });
        barrier.wait();
        if revoke { p.update_trusted_context(TrustedContext::default(), 10).unwrap(); }
        else { assert_eq!(request.cancel(10), Ok(State::Cancelled)); }
        // If take won the mutex first it may have observed ready. That observation is not a
        // capability: cancellation/revocation still terminally fences the model afterwards.
        let result = taking.join().unwrap();
        assert!(result == Ok(State::ReadyForLeadIntegration) || result.is_err());
        if revoke { p.update_trusted_context(context(), 10).unwrap(); }
        assert_eq!(request.state(10), Ok(if revoke { State::Revoked } else { State::Cancelled }));
        assert_eq!(request.take_ready_for_lead_integration(10), Err(Rejection::InvalidTransition));
    }
}
