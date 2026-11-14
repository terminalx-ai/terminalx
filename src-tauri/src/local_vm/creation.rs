//! Capabilities of the pinned creation profile, before any download or VM effect.
//! Existing guest setup is separate from secure first-account provisioning.
use super::journal::{Environment, Journal};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub(super) const PROFILE: &str = "macos-local-v1";
const REASON: &str = "secureGuestBootstrapUnavailable";
const DETAIL: &str = "Fresh VM creation is unavailable: this profile has no supported secure first-account personalization and account-bound transport. No new VM operation was dispatched. Existing compatible VMs can be enrolled and checked separately; enrollment does not create or secure an account.";

pub(super) fn capability() -> Value {
    // Lume 0.6.1's offline setup fixes the first account. Cua 0.7.0's
    // macOS adapter supplies no account binding to its Lume SSH transport.
    // Neither host compatibility nor successful SSH makes these supported.
    json!({"protocol":1,"profileId":PROFILE,"available":false,
        "firstAccountPersonalization":false,"accountBoundTransport":false,
        "reasonCode":REASON})
}

pub(super) fn require_supported() -> Result<()> {
    bail!(DETAIL)
}

pub(super) fn blocked(env: &Environment) -> bool {
    env.provision
        .as_ref()
        .is_some_and(|p| p["reasonCode"] == REASON)
}

/// Upgrade an old, not-yet-dispatched queue entry to a durable refusal. Keep
/// its exact environment/generation/request and original provisioning record.
/// Running/unknown/completed operations are never relabeled by this migration.
pub(super) fn hold_queued(journal: &Journal, target: &Environment) -> Result<bool> {
    let state = journal.read()?;
    let current = state
        .environments
        .get(&target.id)
        .filter(|env| env.generation == target.generation && env.sandbox == target.sandbox)
        .context("Creation timeline changed; no VM operation was routed")?;
    if current.deleted_at.is_some() {
        return Ok(false);
    }
    if !current
        .provision
        .as_ref()
        .is_some_and(|p| p["status"] == "queued")
    {
        return Ok(blocked(current));
    }
    journal.transaction(|state| {
        let env = state.environments.get_mut(&target.id)
            .filter(|env| env.generation == target.generation && env.sandbox == target.sandbox && env.deleted_at.is_none())
            .context("Creation timeline changed; no VM operation was routed")?;
        if !env.provision.as_ref().is_some_and(|p| p["status"] == "queued") {
            return Ok(blocked(env));
        }
        let original = env.provision.clone();
        let original_setup = env.setup.clone();
        let key = env.setup.as_ref().and_then(|report| report.get("idempotencyKey")).cloned();
        env.provision = Some(json!({"status":"failed","detail":DETAIL,"reasonCode":REASON,
            "stages":[{"id":"guestAccount","label":"Secure guest account setup","status":"failed","detail":DETAIL}],
            "creationRefusal":{"protocol":1,"profileId":PROFILE,"environmentId":env.id,
                "generation":env.generation,"idempotencyKey":key,"originalProvision":original,"originalSetup":original_setup}}));
        if let Some(report) = env.setup.as_mut().and_then(Value::as_object_mut) {
            report.insert("creationCapability".into(), capability());
            if report.get("status") == Some(&json!("queued")) {
                report.insert("status".into(), json!("failed"));
                report.insert("detail".into(), json!(DETAIL));
            }
            if let Some(steps) = report.get_mut("steps").and_then(Value::as_array_mut) {
                for step in steps {
                    if step["id"] == "vm" && step["state"] == "pending" {
                        step["state"] = json!("failed");
                        step["detail"] = json!(DETAIL);
                    }
                }
            }
        }
        Ok(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_never_relabels_dispatched_or_unknown_provisioning() {
        for status in [
            "running",
            "canceling",
            "outcomeUnknown",
            "completed",
            "failed",
            "canceled",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let journal = Journal::open(dir.path()).unwrap();
            let env = journal.enroll("retained", "local:retained").unwrap();
            journal.transaction(|state| {
                let env = state.environments.get_mut(&env.id).unwrap();
                env.provision = Some(json!({"status":status,"retained":"original outcome"}));
                env.setup = Some(json!({"status":"outcomeUnknown","operations":{"old":{"receipt":{"status":"outcomeUnknown"}}}}));
                Ok(())
            }).unwrap();
            let before = serde_json::to_value(journal.read().unwrap()).unwrap();
            assert!(!hold_queued(&journal, &env).unwrap());
            assert_eq!(
                serde_json::to_value(journal.read().unwrap()).unwrap(),
                before
            );
        }
    }

    #[test]
    fn stale_snapshot_cannot_bypass_the_hold_or_modify_a_new_generation() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let stale = journal.enroll("retained", "local:retained").unwrap();
        journal
            .transaction(|state| {
                state.environments.get_mut(&stale.id).unwrap().provision =
                    Some(json!({"status":"queued"}));
                Ok(())
            })
            .unwrap();
        assert!(hold_queued(&journal, &stale).unwrap());
        let mut changed = stale;
        changed.generation = super::super::journal::new_id();
        let before = serde_json::to_value(journal.read().unwrap()).unwrap();
        assert!(hold_queued(&journal, &changed).is_err());
        assert_eq!(
            serde_json::to_value(journal.read().unwrap()).unwrap(),
            before
        );
    }
}
