//! Explicit host-owner shutdown is distinct from task readiness. The caller
//! holds the exclusive VM admission guard until the owner's stop commits.
use super::{
    host,
    journal::{self, Environment, Journal},
    setup,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub(super) fn verify(journal: &Journal) -> Result<()> {
    verify_using(journal, |env| {
        host::guest_rpc(env, "environment.disposition", json!({}))
    })
}

pub(super) fn verify_using(
    journal: &Journal,
    mut inspect: impl FnMut(&Environment) -> Result<Value>,
) -> Result<()> {
    let state = journal.read()?;
    let before = serde_json::to_value(&state)?;
    if state.tasks.values().any(|task| !task.status.terminal()) {
        bail!("Resolve or cancel unfinished Local VM tasks before stopping the host owner");
    }
    for env in state
        .environments
        .values()
        .filter(|env| env.deleted_at.is_none())
    {
        if env.manual_control || !host::provision_settled(env) {
            bail!("Resolve VM provisioning and return manual desktop control before stopping the host owner");
        }
        if !setup::busy(env) {
            continue;
        }
        let report = env.setup.as_ref().context("Setup history is missing")?;
        if report["protocol"] != setup::PROTOCOL
            || report["environmentId"] != env.id
            || report["generation"] != env.generation
            || setup::validate_request(
                report["harness"].as_str().unwrap_or(""),
                report["idempotencyKey"].as_str().unwrap_or(""),
            )
            .is_err()
            || !matches!(
                report["status"].as_str(),
                Some("ready" | "needsAttention" | "failed" | "outcomeUnknown")
            )
            || !report["steps"].as_array().is_some_and(|steps| {
                steps.len() == setup::STEP_IDS.len()
                    && setup::STEP_IDS
                        .iter()
                        .all(|id| steps.iter().filter(|step| step["id"] == *id).count() == 1)
                    && steps.iter().all(|step| {
                        matches!(
                            step["state"].as_str(),
                            Some("pending" | "complete" | "waiting" | "failed" | "unknown")
                        )
                    })
            })
        {
            bail!("Guided setup is active or its history is incomplete; host owner retained");
        }
        let work =
            inspect(env).context("Fresh guest shutdown inspection failed; host owner retained")?;
        let tasks: Vec<_> = state
            .tasks
            .values()
            .filter(|task| task.target.environment_id == env.id)
            .collect();
        host::validate_quiescent_history(env, &tasks, &work, false)
            .context("Guest task/history quiescence is unproven; host owner retained")?;
        setup_operations_quiescent(env, report, &work)?;
    }
    // Admission prevents concurrent owner commands. Also refuse an external
    // journal replacement/change instead of stopping against stale evidence.
    if serde_json::to_value(journal.read()?)? != before {
        bail!("Local VM history changed during shutdown inspection; host owner retained");
    }
    Ok(())
}

fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn setup_operations_quiescent(env: &Environment, report: &Value, work: &Value) -> Result<()> {
    let empty = serde_json::Map::new();
    let host_ops = match report.get("operations") {
        None | Some(Value::Null) => &empty,
        Some(value) => value
            .as_object()
            .context("Retained host setup operations are damaged")?,
    };
    let guest_ops = work["setupOperations"]
        .as_object()
        .context("Guest setup operation history is missing")?;
    if host_ops.len() != guest_ops.len() {
        bail!("Host/guest setup operation histories differ; host owner retained");
    }
    // Recovery carries prior operations forward. Losing an operation from the
    // current map cannot erase the older checkpoint that proves it existed.
    if let Some(history) = report.get("history") {
        for previous in history
            .as_array()
            .context("Setup recovery history is damaged")?
        {
            if previous["protocol"] != setup::PROTOCOL
                || previous["environmentId"] != env.id
                || previous["generation"] != env.generation
            {
                bail!("Prior setup history binding changed; host owner retained");
            }
            if let Some(operations) = previous.get("operations").filter(|value| !value.is_null()) {
                for (key, prior) in operations
                    .as_object()
                    .context("Prior setup operations are damaged")?
                {
                    let retained = host_ops
                        .get(key)
                        .context("A prior setup operation was lost")?;
                    if prior["digest"] != retained["digest"]
                        || prior["receipt"]["action"] != retained["receipt"]["action"]
                        || prior["receipt"]["idempotencyKey"]
                            != retained["receipt"]["idempotencyKey"]
                    {
                        bail!("Retained setup operation identity changed; host owner retained");
                    }
                }
            }
        }
    }
    if let Some(action) = report.get("action").filter(|value| !value.is_null()) {
        let retained = action["idempotencyKey"]
            .as_str()
            .and_then(|key| host_ops.get(key))
            .context("Current setup action is missing from retained operations")?;
        for field in ["idempotencyKey", "action", "status"] {
            if action[field] != retained["receipt"][field] {
                bail!(
                    "Current setup action differs from its retained operation; host owner retained"
                );
            }
        }
    }
    for (key, operation) in host_ops {
        let guest = guest_ops
            .get(key)
            .context("Guest setup operation is missing")?;
        if !digest(&operation["digest"])
            || !digest(&guest["digest"])
            || key.trim().is_empty()
            || key.len() > 200
            || !operation["receipt"]["action"]
                .as_str()
                .is_some_and(|action| setup::ACTIONS.contains(&action))
            || !matches!(
                operation["receipt"]["status"].as_str(),
                Some("working" | "needsAttention" | "complete" | "failed" | "outcomeUnknown")
            )
            || operation["receipt"]["idempotencyKey"] != *key
            || guest["receipt"]["idempotencyKey"] != *key
            || operation["receipt"]["action"] != guest["receipt"]["action"]
            || guest["environmentId"] != env.id
            || guest["generation"] != env.generation
            || !matches!(
                guest["receipt"]["status"].as_str(),
                Some("complete" | "failed" | "outcomeUnknown")
            )
        {
            bail!("Guest setup operation binding/outcome is incomplete; host owner retained");
        }
        // The host hashes the wire JSON while the guest hashes typed parameters.
        // Both digests must be intact; equality is not their protocol contract.
        let previous_boot = guest["bootIdentity"]
            .as_str()
            .filter(|boot| journal::validate_id(boot).is_ok());
        let changed_boot = previous_boot.is_some_and(|boot| work["currentBootIdentity"] != boot);
        if guest["helperExitConfirmed"] != true && !changed_boot {
            bail!("Guest setup helper exit is unproven; host owner retained");
        }
    }
    // This does not mark unknown actions successful, refresh authentication or
    // desktop proof, make setup Ready, or stop any guest process/VM.
    Ok(())
}
