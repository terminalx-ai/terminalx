//! The personalized VM's environment record: the step after the person pinned
//! the guest's host key that makes the VM a Local VM environment whose
//! transport is bound to its verified bootstrap. Every binding field comes from
//! a record the host already verifies; nothing comes from the request except
//! the display name:
//! - VM, environment and generation: the original completed restore
//!   (`macos_provision::created_for_bootstrap`);
//! - sandbox: the endpoint pin that restore recorded;
//! - account and home: the ledger's account receipt;
//! - host key: the ledger's trust receipt, which must be the person's pin in
//!   `host-key-confirmation.json`;
//! - per-VM key: the produced original reference;
//! - runtime: an `ApprovedRuntime`.
//!
//! The record is created once. An identical retry returns it; anything
//! conflicting, stale or deleted is refused, never replaced. This build has no
//! approved runtime and transport admission is closed, so the production entry
//! refuses before reading or writing anything.
use super::{
    journal::{self, Environment, Journal},
    macos_endpoint, macos_keys, macos_personalization, macos_provision,
    macos_transport::{self, Binding},
    transport::Transport,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::Path;

/// The guest runtime a personalized environment pins: the signed runtime
/// bundled with this TerminalX owner (`bootstrap::profile`). No constructor
/// takes a digest from a request or adopts whatever build is running.
pub(super) struct ApprovedRuntime {
    sha256: String,
}
impl ApprovedRuntime {
    /// Refuses in this build. Nothing pins the TerminalX release signing
    /// identity or a release catalog entry for the owner executable, so its
    /// digest (`bootstrap::owner_runtime_sha256`) would describe whatever build
    /// is running, including a local development build.
    pub(super) fn production() -> Result<Self> {
        bail!("No approved guest runtime: this build pins no TerminalX release signing identity or runtime catalog entry, so a local build's digest is never bound")
    }
    #[cfg(test)]
    pub(super) fn fixture(sha256: &str) -> Self {
        Self {
            sha256: sha256.into(),
        }
    }
}

/// The environment the verified records describe for bootstrap `key`, named
/// `name`. Reads only.
fn environment(root: &Path, key: &str, name: &str, runtime: &ApprovedRuntime) -> Result<Environment> {
    if name.trim().is_empty() || name.len() > 120 {
        bail!("Provide an environment name of 1–120 bytes");
    }
    super::transport::validate_runtime_sha(&runtime.sha256)?;
    let created = macos_provision::created_for_bootstrap(root, key)?;
    let target: macos_personalization::Target = serde_json::from_value(created["target"].clone())?;
    let sandbox = macos_endpoint::pinned_sandbox(root, key, &target)?;
    if sandbox != format!("local:terminalx-{key}") {
        bail!("The original restore recorded another sandbox for this VM")
    }
    let retained = macos_personalization::retained(root, key, &target)?;
    // The ledger's trust must be the person's pin of the owner-observed key.
    let pinned: Value = serde_json::from_slice(&macos_keys::private_read(
        &root.join("bo").join(key).join("host-key-confirmation.json"),
        32 * 1024,
    )?)?;
    let account = &retained.account.account;
    if pinned["hostKey"] != retained.trust.host_key.as_str()
        || pinned["fingerprint"] != retained.trust.host_key_fingerprint.as_str()
        || pinned["observationSha256"] != retained.trust.bootstrap_observation_digest.as_str()
        || pinned["keyReference"] != retained.plan.ssh_key_reference.as_str()
        || pinned["account"] != json!({"name": account.short_name, "uid": account.uid})
    {
        bail!("The trusted host key is not the person's pin for this VM, key and account")
    }
    let binding = Binding {
        bootstrap_id: key.into(),
        target: target.clone(),
        account: account.clone(),
        runtime_sha256: runtime.sha256.clone(),
        trust_digest: journal::digest(&serde_json::to_vec(&retained.trust)?),
        key_reference: retained.plan.ssh_key_reference.clone(),
    };
    binding.check_retained(root)?;
    // The produced original key for exactly this bootstrap, VM and account.
    macos_keys::retained_public(root, &binding)?;
    let env = Environment {
        transport: Transport::MacosPersonalized {
            binding: Box::new(binding),
        },
        id: target.environment_id.clone(),
        name: name.trim().into(),
        sandbox,
        generation: target.generation.clone(),
        created_at: journal::now(),
        deleted_at: None,
        keep_awake: false,
        owned: true,
        provision: None,
        manual_control: false,
        setup: None,
    };
    macos_transport::binding(&env)?;
    Ok(env)
}

/// Records the environment once. An identical earlier record (same binding,
/// sandbox, generation and name) is returned; any other record for this VM,
/// sandbox or bootstrap, including a deleted one, is refused and kept.
fn record(journal: &Journal, env: Environment) -> Result<Environment> {
    let Transport::MacosPersonalized { binding } = &env.transport else {
        bail!("Personalized transport required")
    };
    let key = binding.bootstrap_id.clone();
    journal.transaction(|state| {
        if let Some(existing) = state.environments.get(&env.id) {
            if existing.deleted_at.is_none()
                && existing.owned
                && existing.transport == env.transport
                && existing.sandbox == env.sandbox
                && existing.generation == env.generation
                && existing.name == env.name
            {
                return Ok(existing.clone());
            }
            bail!("This VM's environment record already exists with another identity or was deleted; it is never replaced or recreated")
        }
        let claimed = |other: &Environment| {
            matches!(&other.transport, Transport::MacosPersonalized { binding } if binding.bootstrap_id == key)
        };
        if state.environments.values().any(|other| claimed(other) || (other.deleted_at.is_none() && other.sandbox == env.sandbox)) {
            bail!("Another environment already holds this VM or bootstrap")
        }
        state.environments.insert(env.id.clone(), env.clone());
        Ok(env.clone())
    })
}

/// The environment for bootstrap `key` from verified records, recorded once.
/// Fixtures supply the root, journal and runtime; production enters through
/// `bind`.
pub(super) fn bind_using(
    root: &Path,
    journal: &Journal,
    key: &str,
    name: &str,
    runtime: &ApprovedRuntime,
) -> Result<Environment> {
    journal::validate_id(key)?;
    record(journal, environment(root, key, name, runtime)?)
}

/// Production entry: refuses while transport admission is closed and while
/// no runtime is approved, before reading or writing anything.
pub(super) fn bind(params: &Value) -> Result<Value> {
    macos_transport::require_available()?;
    let runtime = ApprovedRuntime::production()?;
    let key = params["idempotencyKey"]
        .as_str()
        .context("Original bootstrap operation required")?;
    let name = params["name"].as_str().context("Environment name required")?;
    let env = bind_using(&super::host::root()?, &super::host::journal()?, key, name, &runtime)?;
    Ok(serde_json::to_value(env)?)
}

#[cfg(test)]
#[path = "macos_environment_tests.rs"]
mod tests;
