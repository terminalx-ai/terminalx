//! One activation intent per verified installation. Engine acknowledgement is
//! never serving proof, and recovery never repeats a detached start.
use super::{
    admission::Guard,
    host,
    journal::{self, Journal},
    linux_install, linux_profile, process,
};
use crate::computer_targets::Target;
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{path::Path, process::Command, time::Duration};

pub(super) fn capability() -> Value {
    json!({"available":false,"reason":"Linux activation requires verified native artifacts and live supervision acceptance. Source/fixture verification does not enable production activation."})
}
fn script() -> String {
    let helpers = include_str!("guest_linux_install.py")
        .split("\nif __name__ == \"__main__\":")
        .next()
        .unwrap();
    format!("{helpers}\n{}", include_str!("guest_linux_activation.py"))
}
pub(super) fn invoke(target: &Target, header: &Value) -> Result<Value> {
    invoke_at(
        &crate::container_vm::selected_runtime(target)?,
        target,
        header,
    )
}
fn invoke_at(binary: &Path, target: &Target, header: &Value) -> Result<Value> {
    linux_install::inspect_at(binary, target)?;
    let Target::LinuxContainer { id, .. } = target else {
        bail!("Exact container required")
    };
    let start = header["action"] == "start";
    let input = serde_json::to_vec(header)?;
    if input.len() > 16 * 1024 {
        bail!("Activation envelope exceeds bound")
    }
    let mut command = Command::new(binary);
    command.arg("exec");
    if start {
        command.arg("--detach");
    }
    command.args([
        "--user",
        "cua",
        "--workdir",
        "/home/cua",
        id,
        "/usr/bin/python3",
        "-I",
        "-c",
        &script(),
        &base64::engine::general_purpose::STANDARD.encode(input),
    ]);
    process::remove_control_credentials(&mut command);
    let output = process::run(&mut command, b"", Duration::from_secs(45))?;
    if start {
        Ok(Value::Null)
    } else {
        super::transport::decode(&output)
    }
}
fn save(root: &Path, key: &str, record: &Value) -> Result<()> {
    journal::atomic_private_write(
        &linux_profile::directory(root, key)?.join("receipt.json"),
        &serde_json::to_vec(record)?,
    )
}
pub(super) fn marker_matches(marker: &Value, record: &Value) -> bool {
    marker["kind"] == "linuxRuntimeActivation"
        && marker["requestKey"] == record["requestKey"]
        && marker["inputDigest"] == record["inputDigest"]
        && marker["activationId"] == record["activation"]["id"]
        && marker["target"] == record["intent"]["binding"]["target"]
}
pub(super) fn verify_enrollment(record: &Value, description: &Value) -> Result<()> {
    if record.get("activation").is_none() {
        return Ok(());
    }
    let activation = &record["activation"];
    if activation["status"] != "owned"
        || activation["observation"]["ownerLeaseHeld"] != true
        || activation["observation"]["receipt"]["cancelRequested"] != false
        || description["activation"]["id"] != activation["id"]
        || description["activation"]["instance"] != activation["observation"]["receipt"]["instance"]
        || !description["activation"]["instance"].is_string()
    {
        bail!("Serving runtime does not prove the original uncanceled activation instance")
    }
    Ok(())
}
pub(super) fn change_using(
    root: &Path,
    journal: &Journal,
    key: &str,
    action: &str,
    mut invoke: impl FnMut(&Target, &Value) -> Result<Value>,
) -> Result<Value> {
    if !matches!(action, "start" | "status" | "cancel") {
        bail!("Unsupported activation action")
    }
    let mut record = linux_profile::inspect(root, key)?;
    let binding: linux_profile::InstallBinding =
        serde_json::from_value(record["intent"]["binding"].clone())?;
    linux_profile::validate_binding(&binding)?;
    if record["status"] != "installed"
        || record["inputDigest"] != journal::digest(&serde_json::to_vec(&record["intent"])?)
    {
        bail!("Original completed installation required")
    }
    linux_profile::validate_receipt(key, &record, &record["receipt"])?;
    let guard = Guard::lock(root, &binding.target)?;
    if guard.marker.try_exists()? {
        let marker: Value = serde_json::from_slice(&super::admission::read_marker(&guard.marker)?)?;
        if !marker_matches(&marker, &record) {
            bail!("Competing desktop/installer/activation reservation")
        }
    }
    let state = journal.read()?;
    if !state.enabled
        || (record.get("enrollment").is_some() && action != "status")
        || state.environments.values().any(|env| {
            env.transport.container().as_ref() == Some(&binding.target)
                && (action != "status"
                    || env.id != binding.environment_id
                    || env.generation != binding.generation
                    || env.deleted_at.is_some()
                    || env.manual_control
                    || super::setup::busy(env)
                    || serde_json::to_value(&env.transport)
                        .ok()
                        .map(|v| v["runtimeSha256"].clone())
                        != Some(record["intent"]["runtimeSha256"].clone()))
        })
        || state.tasks.values().any(|task| {
            task.target.environment_id == binding.environment_id && !task.status.terminal()
        })
    {
        bail!("Activation requires an unenrolled installation without competing task/desktop ownership; enrolled owner lifecycle is separate")
    }
    if record.get("activation").is_none() {
        if action != "start" {
            bail!("Original activation intent missing")
        }
        record["activation"] =
            json!({"id":journal::new_id(),"status":"outcomeUnknown","ready":false});
        save(root, key, &record)?; // before any remote delivery
    } else if action == "start" {
        return Ok(record); // duplicate request is a local read, never a second exec
    }
    let marker = json!({"kind":"linuxRuntimeActivation","target":binding.target,"requestKey":record["requestKey"],
        "inputDigest":record["inputDigest"],"activationId":record["activation"]["id"]});
    journal::atomic_private_write(&guard.marker, &serde_json::to_vec(&marker)?)?;
    let header = json!({"action":action,"activationId":record["activation"]["id"],
        "installation":linux_install::header("receipt",key,&record["intent"])?});
    // After a lost start reply, only the original status/cancel action is legal.
    let outcome = invoke(&binding.target, &header).and_then(|first| {
        if action == "start" || action == "cancel" {
            let mut observation = header.clone();
            observation["action"] = json!("status");
            invoke(&binding.target, &observation)
        } else {
            Ok(first)
        }
    });
    finish(root, key, record, guard, &header, outcome)
}
fn finish(
    root: &Path,
    key: &str,
    mut record: Value,
    guard: Guard,
    header: &Value,
    outcome: Result<Value>,
) -> Result<Value> {
    match outcome {
        Ok(observed) => {
            let receipt = &observed["receipt"];
            let binding = json!({"activationId":header["activationId"],"installation":header["installation"]});
            if receipt["version"] != 1 || receipt["binding"] != binding {
                bail!("Original activation receipt binding changed; reservation retained")
            }
            let terminal = observed["terminal"] == true
                && observed["ownerLeaseHeld"] == false
                && ((receipt["status"] == "canceled"
                    && receipt["exitProof"] == "canceledBeforeSpawn"
                    && receipt["instance"].is_null())
                    || (matches!(receipt["status"].as_str(), Some("exited" | "canceled"))
                        && receipt["exitProof"] == "originalChildWait"
                        && receipt["exitCode"].is_i64()));
            record["activation"]["status"] = json!(if terminal {
                "stopped"
            } else if observed["ownerLeaseHeld"] == true
                && receipt["cancelRequested"] == false
                && matches!(
                    receipt["status"].as_str(),
                    Some("running" | "outcomeUnknown")
                )
                && receipt["instance"]
                    .as_str()
                    .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
            {
                "owned"
            } else {
                "outcomeUnknown"
            });
            record["activation"]["observation"] = observed;
            record["activation"]["detail"] = json!(if terminal {
                "Original activation completed. Its history is retained; automatic replacement is unavailable."
            } else {
                "Original process observation retained. Serving enrollment and guest provider readiness are still required."
            });
            save(root, key, &record)?;
            if terminal {
                guard.completed()?;
            }
        }
        Err(error) => {
            record["activation"]["status"] = json!("outcomeUnknown");
            record["activation"]["detail"]=json!(format!("Activation outcome unknown; reconcile the original operation without replay: {error:#}"));
            save(root, key, &record)?;
        }
    }
    Ok(record)
}
pub(crate) fn request(method: &str, params: Value) -> Result<Value> {
    // Both gates precede engine discovery, account observation or process calls.
    let key = params["idempotencyKey"]
        .as_str()
        .context("Original installation required")?;
    journal::validate_id(key)?;
    if params["confirm"] != true {
        bail!("Confirm this original activation operation")
    }
    let root = host::root()?;
    let record = linux_profile::trusted_record(&root, key)?;
    let target: Target = serde_json::from_value(params["target"].clone())?;
    linux_install::validate_target(
        &record,
        &target,
        Some(
            params["inputDigest"]
                .as_str()
                .context("Displayed installation digest required")?,
        ),
    )?;
    if capability()["available"] != true {
        bail!("{}", capability()["reason"].as_str().unwrap())
    }
    let action = match method {
        "computer.activateLinuxRuntime" => "start",
        "computer.reconcileLinuxActivation" => "status",
        "computer.cancelLinuxActivation" => "cancel",
        _ => bail!("Unknown activation route"),
    };
    change_using(&root, &host::journal()?, key, action, |target, header| {
        invoke_at(
            &crate::container_vm::selected_runtime(target)?,
            target,
            header,
        )
    })
}

#[cfg(test)]
#[path = "linux_activation_tests.rs"]
mod tests;
