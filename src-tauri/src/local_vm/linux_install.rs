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
const RUNTIME_SCRIPT: &str = include_str!("guest_linux_runtime.py");
const BUDGET: Duration = Duration::from_secs(120);

/// The installer's filesystem helpers, without its entrypoint, for the
/// activation and sealed-runtime programs that are loaded after them.
pub(super) fn helpers() -> &'static str {
    SCRIPT
        .split("\nif __name__ == \"__main__\":")
        .next()
        .expect("installer source has helpers")
}

/// The root program that seals the runtime and launches RPCs from it (#978).
pub(super) fn runtime_script() -> String {
    format!("{}\n{RUNTIME_SCRIPT}", helpers())
}

/// `exec` of the sealed-runtime program, as root, in the exact container.
/// Only the root program reads `runtime_sha256`; the guest account never
/// chooses what runs.
pub(super) fn runtime_command(binary: &Path, id: &str, header: &Value) -> Result<Command> {
    use base64::Engine;
    let envelope = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(header)?);
    if envelope.len() > 4096 {
        bail!("Sealed runtime envelope exceeds its bound");
    }
    let mut command = Command::new(binary);
    command.args(["exec", "-i", "--user", "0:0", "--workdir", "/", id, "/usr/bin/python3", "-I", "-c"]);
    command.arg(runtime_script()).arg(envelope);
    process::remove_control_credentials(&mut command);
    Ok(command)
}

/// Store the host's verified artifact as the root-owned runtime. Idempotent:
/// an identical sealed runtime is observed, a different one is refused.
fn seal_at(binary: &Path, target: &Target, intent: &Value, artifact: &[u8]) -> Result<Value> {
    inspect_at(binary, target)?;
    let sha = intent["runtimeSha256"].as_str().context("Artifact digest missing")?;
    if journal::digest(artifact) != sha {
        bail!("Delivered artifact changed");
    }
    let header = json!({"action":"seal","runtimeSha256":sha,"bytes":artifact.len()});
    let result = super::transport::decode(&process::run(
        &mut runtime_command(binary, container(target)?, &header)?,
        artifact,
        BUDGET,
    )?)?;
    if result["status"] != "sealed" || result["runtimeSha256"] != sha || result["path"] != super::transport::SEALED_RUNTIME {
        bail!("Guest did not confirm the sealed runtime");
    }
    Ok(result)
}

fn container(target: &Target) -> Result<&str> {
    target.require(Capability::AttachedDesktop)?;
    let Target::LinuxContainer { id, .. } = target else {
        bail!("An exact Linux container is required");
    };
    Ok(id)
}
pub(super) fn inspect_at(binary: &Path, target: &Target) -> Result<()> {
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
        "0:0",
        "--workdir",
        "/",
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
pub(super) fn header(action: &str, key: &str, intent: &Value) -> Result<Value> {
    Ok(
        json!({"action":action,"requestDigest":journal::digest(key.as_bytes()),
        "inputDigest":journal::digest(&serde_json::to_vec(intent)?),"intent":intent}),
    )
}
pub(super) fn validate_target(record: &Value, target: &Target, digest: Option<&str>) -> Result<()> {
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
    result["activation"] = super::linux_activation::capability();
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
    let environment_id = journal::new_id();
    let host_key_sha256 = super::guest_key::verifier(&super::guest_key::ensure(root, &environment_id)?);
    let binding = InstallBinding {
        target: target.clone(),
        environment_id,
        generation: journal::new_id(),
        architecture,
        account: Some(account),
        host_key_sha256,
    };
    linux_profile::prepare(root, key, &binding, &artifact)
}
/// The container engine for a target: the selected one in production, a
/// disposable stand-in in fixtures.
pub(super) type Engine<'a> = &'a dyn Fn(&Target) -> Result<std::path::PathBuf>;
fn selected(target: &Target) -> Result<std::path::PathBuf> {
    crate::container_vm::selected_runtime(target)
}
/// `request` holds the compiled-catalog gate (`trusted_record`) before this.
pub(super) fn deliver_with(root: &Path, journal: &Journal, key: &str, engine: Engine) -> Result<Value> {
    linux_profile::execute_prepared(root, journal, key, |binding, path, intent| {
        let artifact = linux_profile::read(
            path,
            intent["bytes"].as_u64().context("Artifact size missing")?,
        )?;
        let binary = engine(&binding.target)?;
        // No retry when exec/receipt delivery is lost. Recovery invokes only
        // the receipt action, which obtains the original guest mutation lock.
        invoke_at(
            &binary,
            &binding.target,
            &header("install", key, intent)?,
            Some(&artifact),
        )?;
        let receipt = invoke_at(&binary, &binding.target, &header("receipt", key, intent)?, None)?;
        seal_at(&binary, &binding.target, intent, &artifact)?;
        Ok(receipt)
    })
}
/// Recovery observes the original receipt, then completes the idempotent seal
/// from the host's retained artifact, so a lost seal never strands the key path.
pub(super) fn reconcile_with(root: &Path, key: &str, engine: Engine) -> Result<Value> {
    linux_profile::reconcile_prepared(root, key, true, |binding, intent| {
        let binary = engine(&binding.target)?;
        let receipt = invoke_at(&binary, &binding.target, &header("receipt", key, intent)?, None)?;
        let artifact = linux_profile::read(
            &linux_profile::directory(root, key)?.join("runtime.elf"),
            intent["bytes"].as_u64().context("Artifact size missing")?,
        )?;
        seal_at(&binary, &binding.target, intent, &artifact)?;
        Ok(receipt)
    })
}

/// Verify a currently serving owner after installation. This never starts an
/// owner or provider and does not infer readiness from installed files.
pub(super) fn enroll_serving_using(
    root: &Path,
    journal: &Journal,
    key: &str,
    describe: impl FnOnce(&journal::Environment) -> Result<Value>,
) -> Result<Value> {
    let mut record = linux_profile::inspect(root, key)?;
    let binding: InstallBinding = serde_json::from_value(record["intent"]["binding"].clone())?;
    linux_profile::validate_binding(&binding)?;
    let account = binding
        .account
        .as_ref()
        .context("Installed dedicated account binding missing")?;
    account.validate()?;
    let guard = Guard::lock(root, &binding.target)?;
    let activation_reserved = guard.marker.try_exists()?;
    if activation_reserved {
        let marker: Value = serde_json::from_slice(&super::admission::read_marker(&guard.marker)?)?;
        if !super::linux_activation::marker_matches(&marker, &record) {
            bail!("Competing ownership prevents enrollment")
        }
    }
    if record["status"] != "installed"
        || record["inputDigest"] != journal::digest(&serde_json::to_vec(&record["intent"])?)
    {
        bail!("Original completed installation receipt required before serving-runtime enrollment");
    }
    linux_profile::validate_receipt(key, &record, &record["receipt"])?;
    let Target::LinuxContainer { runtime, id } = &binding.target else {
        bail!("Exact Linux container required");
    };
    let target = Target::LinuxGuest {
        runtime: *runtime,
        id: id.clone(),
        environment_id: binding.environment_id.clone(),
        generation: binding.generation.clone(),
    };
    let sha = record["intent"]["runtimeSha256"]
        .as_str()
        .context("Installed runtime digest missing")?;
    let env = journal::Environment {
        transport: super::transport::Transport::LinuxContainer {
            runtime: *runtime,
            id: id.clone(),
            runtime_sha256: sha.into(),
        },
        id: binding.environment_id.clone(),
        generation: binding.generation.clone(),
        name: "Linux guest".into(),
        sandbox: format!("container:{}:{id}", runtime.name()),
        created_at: journal::now(),
        deleted_at: None,
        keep_awake: false,
        owned: false,
        detached: false,
        provision: None,
        manual_control: false,
        setup: None,
    };
    let state = journal.read()?;
    if !state.enabled
        || state
            .tasks
            .values()
            .any(|task| task.target.environment_id == env.id && !task.status.terminal())
        || state.environments.get(&env.id).is_some_and(|current| {
            current.deleted_at.is_some()
                || current.generation != env.generation
                || current.transport != env.transport
                || current.manual_control
                || super::setup::busy(current)
        })
    {
        bail!("Serving enrollment is disabled or conflicts with retained guest work/identity");
    }
    let observed = describe(&env)?;
    super::transport::validate_description(&env, &observed)?;
    if observed["identity"]["environmentId"] != env.id
        || observed["identity"]["generation"] != env.generation
        || observed["identity"]["protocol"] != journal::PROTOCOL
        || observed["identity"]["account"] != json!(account)
        || observed["identity"]["hostKeySha256"] != binding.host_key_sha256
        || observed["manualControl"] != false
    {
        bail!("Serving guest account/identity differs from the original installed runtime");
    }
    super::linux_activation::verify_enrollment(&record, &observed)?;
    let enrolled = journal.enroll_container(&env.name, &target, sha)?;
    record["enrollment"] = json!({"status":"verified","environment":enrolled,"description":observed,"checkedAt":journal::now(),"ready":false});
    record["ready"] = json!(false);
    record["detail"]=json!("Installed runtime is serving with the original account/artifact binding. Guest provider authorization and task readiness remain separate.");
    journal::atomic_private_write(
        &linux_profile::directory(root, key)?.join("receipt.json"),
        &serde_json::to_vec(&record)?,
    )?;
    if activation_reserved {
        guard.completed()?;
    }
    Ok(record)
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
        "computer.enrollInstalledLinuxRuntime" => {
            if record.get("activation").is_some() {
                if super::linux_activation::capability()["available"] != true {
                    bail!("Linux activation live acceptance is unavailable")
                }
                super::linux_activation::change_using(
                    &root,
                    &journal,
                    key,
                    "status",
                    super::linux_activation::invoke,
                )?;
            }
            enroll_serving_using(&root, &journal, key, |env| {
                super::transport::linux_rpc(env, "describe", json!({}), Duration::from_secs(45))
            })
        }
        "computer.deliverLinuxRuntime" => deliver_with(&root, &journal, key, &selected),
        "computer.reconcileLinuxRuntime" => reconcile_with(&root, key, &selected),
        _ => bail!("Unknown Linux installation action"),
    }
}

#[cfg(test)]
#[path = "linux_install_tests.rs"]
pub(crate) mod tests;
