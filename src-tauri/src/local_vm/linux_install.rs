//! Guided delivery of a sealed native artifact. Public routes cannot inject a
//! catalog, executable path, account observation or installer completion proof.
use super::{
    admission::Guard,
    host,
    journal::{self, Journal},
    linux_profile::{self, Account, Architecture, InstallBinding},
    process,
};
use crate::computer_targets::{Capability, Target};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{path::Path, process::Command, time::Duration};

const SCRIPT: &str = include_str!("guest_linux_install.py");
const BUDGET: Duration = Duration::from_secs(120);

fn container(target: &Target) -> Result<&str> {
    target.require(Capability::AttachedDesktop)?;
    let Target::LinuxContainer { id, .. } = target else {
        bail!("An exact Linux container is required");
    };
    Ok(id)
}
fn inspect_at(binary: &Path, target: &Target) -> Result<()> {
    let id = container(target)?;
    let mut command = Command::new(binary);
    command.args(["inspect", "--format", "{{json .}}", id]);
    process::remove_control_credentials(&mut command);
    let value: Value =
        serde_json::from_slice(&process::run(&mut command, b"", Duration::from_secs(5))?)?;
    if value["Id"] != id
        || value["Config"]["Labels"]["ai.terminalx.computer"] != "1"
        || value["State"]["Running"] != true
        || value["State"]["Paused"] != false
        || value["State"]["Restarting"] != false
        || value["HostConfig"]["Privileged"] != false
        || value["Mounts"] != json!([])
        || !matches!(
            value["HostConfig"]["PidMode"].as_str(),
            Some("" | "private")
        )
    {
        bail!("Exact running private container without mounts/privileges is required; no installation routed");
    }
    Ok(())
}
fn invoke_at(
    binary: &Path,
    target: &Target,
    header: &Value,
    artifact: Option<&[u8]>,
) -> Result<Value> {
    inspect_at(binary, target)?;
    let mut input = serde_json::to_vec(header)?;
    if input.len() > 16 * 1024 {
        bail!("Installer header exceeds its bound");
    }
    input.push(b'\n');
    if let Some(bytes) = artifact {
        input.extend_from_slice(bytes);
    }
    let mut command = Command::new(binary);
    command.args([
        "exec",
        "-i",
        "--user",
        "cua",
        "--workdir",
        "/home/cua",
        container(target)?,
        "/usr/bin/python3",
        "-I",
        "-c",
        SCRIPT,
    ]);
    process::remove_control_credentials(&mut command);
    super::transport::decode(&process::run(&mut command, &input, BUDGET)?)
}
fn invoke(target: &Target, header: &Value, artifact: Option<&[u8]>) -> Result<Value> {
    let binary = crate::container_vm::selected_runtime(target)?;
    invoke_at(&binary, target, header, artifact)
}
fn header(action: &str, key: &str, intent: &Value) -> Result<Value> {
    Ok(
        json!({"action":action,"requestDigest":journal::digest(key.as_bytes()),
        "inputDigest":journal::digest(&serde_json::to_vec(intent)?),"intent":intent}),
    )
}
fn validate_target(record: &Value, target: &Target, digest: Option<&str>) -> Result<()> {
    if record["intent"]["binding"]["target"] != json!(target)
        || digest.is_some_and(|digest| record["inputDigest"] != digest)
    {
        bail!("Displayed installation target or intent changed; inspect the original request");
    }
    Ok(())
}
fn available_profile(id: &str) -> Result<Architecture> {
    let capability = linux_profile::capability();
    let profile=capability["profiles"].as_array().context("Profile catalog unavailable")?
        .iter().find(|profile|profile["id"]==id).context("No verified native Linux artifact profile is available; production installation is disabled")?;
    serde_json::from_value(profile["architecture"].clone()).map_err(Into::into)
}
fn status(root: &Path, target: &Target) -> Result<Value> {
    container(target)?;
    let mut result = linux_profile::capability();
    result["target"] = json!(target);
    let mut operations = Vec::new();
    let directory = root.join("linux-runtime-preparation");
    if directory.try_exists()? {
        for entry in std::fs::read_dir(directory)? {
            let record: Value = serde_json::from_slice(&linux_profile::read(
                &entry?.path().join("receipt.json"),
                64 * 1024,
            )?)?;
            if record["intent"]["binding"]["target"] == json!(target) {
                operations.push(record);
            }
        }
    }
    result["operations"] = json!(operations);
    Ok(result)
}
fn prepare(
    root: &Path,
    journal: &Journal,
    target: &Target,
    key: &str,
    profile: &str,
) -> Result<Value> {
    // This gate precedes all container/account contact, including in tests.
    let architecture = available_profile(profile)?;
    let artifact = linux_profile::cached(root, profile, architecture)?;
    if linux_profile::directory(root, key)?
        .join("receipt.json")
        .try_exists()?
    {
        let prior = linux_profile::inspect(root, key)?;
        validate_target(&prior, target, None)?;
        if prior["intent"]["profileId"] != profile {
            bail!("Preparation key already names another profile");
        }
        let binding: InstallBinding = serde_json::from_value(prior["intent"]["binding"].clone())?;
        return linux_profile::prepare(root, key, &binding, &artifact);
    }
    let account = {
        let _guard = Guard::acquire(root, target)?;
        if journal
            .read()?
            .environments
            .values()
            .any(|env| env.transport.container().as_ref() == Some(target))
        {
            bail!("Existing guest history prevents fresh installation");
        }
        let account: Account =
            serde_json::from_value(invoke(target, &json!({"action":"account"}), None)?)?;
        account.validate()?;
        account
    };
    if account.architecture != architecture {
        bail!("Trusted artifact does not match the dedicated guest architecture");
    }
    let binding = InstallBinding {
        target: target.clone(),
        environment_id: journal::new_id(),
        generation: journal::new_id(),
        architecture,
        account: Some(account),
    };
    linux_profile::prepare(root, key, &binding, &artifact)
}
fn deliver(root: &Path, journal: &Journal, key: &str) -> Result<Value> {
    linux_profile::trusted_record(root, key)?;
    linux_profile::execute_prepared(root, journal, key, |binding, path, intent| {
        let artifact = linux_profile::read(
            path,
            intent["bytes"].as_u64().context("Artifact size missing")?,
        )?;
        // No retry when exec/receipt delivery is lost. Recovery invokes only
        // the receipt action, which obtains the original guest mutation lock.
        invoke(
            &binding.target,
            &header("install", key, intent)?,
            Some(&artifact),
        )?;
        invoke(&binding.target, &header("receipt", key, intent)?, None)
    })
}
pub(crate) fn request(method: &str, params: Value) -> Result<Value> {
    let target: Target = serde_json::from_value(params["target"].clone())?;
    container(&target)?;
    let root = host::root()?;
    if method == "computer.linuxInstaller" {
        return status(&root, &target);
    }
    if params["confirm"] != true {
        bail!("Explicit installation or original receipt recovery confirmation is required");
    }
    let journal = host::journal()?;
    if !journal.read()?.enabled {
        bail!("Enable Local VM before preparing a guest runtime");
    }
    let key = params["idempotencyKey"]
        .as_str()
        .context("Original installation request key required")?;
    journal::validate_id(key)?;
    if method == "computer.prepareLinuxRuntime" {
        return prepare(
            &root,
            &journal,
            &target,
            key,
            params["profileId"]
                .as_str()
                .context("Trusted profile required")?,
        );
    }
    let record = linux_profile::trusted_record(&root, key)?;
    validate_target(
        &record,
        &target,
        Some(
            params["inputDigest"]
                .as_str()
                .context("Displayed installation digest required")?,
        ),
    )?;
    match method {
        "computer.deliverLinuxRuntime" => deliver(&root, &journal, key),
        "computer.reconcileLinuxRuntime" => {
            linux_profile::reconcile_prepared(&root, key, true, |binding, intent| {
                invoke(&binding.target, &header("receipt", key, intent)?, None)
            })
        }
        _ => bail!("Unknown Linux installation action"),
    }
}

#[cfg(test)]
#[path = "linux_install_tests.rs"]
mod tests;
