//! When the machine's own relay registration (PRO-368) starts, stops and
//! what the window is told about it: signing out, another account, a newer
//! runtime process, another account's binding and a changed host key.

use std::time::{Duration, Instant};

use super::{may_register, running_relay_stop, unregistered_relay_state, RelayStop, RELAY_REFUSED_RETRY};
use crate::machine_wire::RelayState;
use crate::remote::account_link::Ended;
use crate::remote::host::HostStatus;

#[test]
fn a_running_registration_stops_when_the_link_ends_it() {
    assert_eq!(running_relay_stop(Some(Ended::Superseded), "host", "host", Some("u1"), None), Some(RelayStop::Superseded));
    assert_eq!(running_relay_stop(Some(Ended::OwnerConflict), "host", "host", Some("u1"), None), Some(RelayStop::OwnerConflict));
    assert_eq!(running_relay_stop(Some(Ended::SignedOut), "host", "host", Some("u1"), None), Some(RelayStop::SignedOut));
}

#[test]
fn signing_out_or_another_account_stops_it_at_the_next_read_pass() {
    // Not a read pass: the session file is not looked at.
    assert_eq!(running_relay_stop(None, "host", "host", Some("u1"), None), None);
    // Read, and nobody is signed in: the relay route closes.
    assert_eq!(running_relay_stop(None, "host", "host", Some("u1"), Some(None)), Some(RelayStop::SignedOut));
    // Read, and another account signed in.
    assert_eq!(running_relay_stop(None, "host", "host", Some("u1"), Some(Some("u2"))), Some(RelayStop::AnotherAccount));
    // The same account, its token rotated: keeps serving.
    assert_eq!(running_relay_stop(None, "host", "host", Some("u1"), Some(Some("u1"))), None);
    // Before its first token it registered for nobody yet.
    assert_eq!(running_relay_stop(None, "host", "host", None, Some(Some("u1"))), None);
}

#[test]
fn a_host_key_adopted_from_the_window_restarts_it() {
    assert_eq!(running_relay_stop(None, "old-host", "new-host", Some("u1"), Some(Some("u1"))), Some(RelayStop::HostKeyChanged));
}

#[test]
fn it_registers_again_for_another_account_not_for_the_one_superseded() {
    let now = Instant::now();
    assert!(may_register("u1", None, None, now));
    assert!(!may_register("u1", Some("u1"), None, now), "a newer process took the relay for u1");
    assert!(may_register("u2", Some("u1"), None, now), "another account starts its own generation");
}

#[test]
fn a_binding_another_account_holds_is_asked_about_again_later() {
    let refused_at = Instant::now();
    assert!(!may_register("u1", None, Some(("u1", refused_at)), refused_at + Duration::from_secs(60)));
    assert!(may_register("u1", None, Some(("u1", refused_at)), refused_at + RELAY_REFUSED_RETRY));
    assert!(may_register("u2", None, Some(("u1", refused_at)), refused_at), "another account is asked at once");
}

#[test]
fn the_window_registers_itself_while_the_runtime_is_retrying() {
    // The first registration: the window waits for it (a while).
    assert_eq!(unregistered_relay_state(None, &HostStatus::Connecting), RelayState::Connecting);
    // Lost, refused or fenced and trying again: the window does not wait.
    assert_eq!(unregistered_relay_state(None, &HostStatus::Retrying { attempt: 3 }), RelayState::Retrying);
    assert_eq!(unregistered_relay_state(None, &HostStatus::Fenced { runtime_generation: 2 }), RelayState::Retrying);
    // Ended by the account or another binding.
    assert_eq!(unregistered_relay_state(None, &HostStatus::Revoked), RelayState::SignedOut);
    assert_eq!(unregistered_relay_state(Some(Ended::SignedOut), &HostStatus::Retrying { attempt: 1 }), RelayState::SignedOut);
    assert_eq!(unregistered_relay_state(Some(Ended::Superseded), &HostStatus::Connecting), RelayState::Superseded);
    assert_eq!(unregistered_relay_state(Some(Ended::OwnerConflict), &HostStatus::Retrying { attempt: 1 }), RelayState::Off);
}
