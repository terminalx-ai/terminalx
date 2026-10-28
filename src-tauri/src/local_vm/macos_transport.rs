//! Personalized macOS host route. Production admission remains closed until
//! VM-bound provisioning/trust is implemented. Fixtures exercise this actual
//! executor with fake programs; there is no caller-selectable executable RPC.
use super::{
    journal::{self, Environment, Journal},
    macos_account::Account,
    macos_personalization::{self, Target},
    process,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::Ipv4Addr,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub bootstrap_id: String,
    pub target: Target,
    pub account: Account,
    pub runtime_sha256: String,
    pub trust_digest: String,
    pub key_reference: String,
}
impl Binding {
    pub(super) fn validate(&self, env: &Environment) -> Result<()> {
        journal::validate_id(&self.bootstrap_id)?;
        journal::validate_id(&self.key_reference)?;
        self.target.validate()?;
        self.account.validate()?;
        super::transport::validate_runtime_sha(&self.runtime_sha256)?;
        super::transport::validate_runtime_sha(&self.trust_digest)?;
        if env.id != self.target.environment_id
            || env.generation != self.target.generation
            || env.deleted_at.is_some()
        {
            bail!("Personalized transport environment/generation changed");
        }
        journal::validate_sandbox(&env.sandbox)
    }
    pub(super) fn check_retained(&self, root: &Path) -> Result<()> {
        let retained = macos_personalization::retained(root, &self.bootstrap_id, &self.target)?;
        if retained.account.account != self.account
            || retained.plan.ssh_key_reference != self.key_reference
            || journal::digest(&serde_json::to_vec(&retained.trust)?) != self.trust_digest
        {
            bail!("Retained personalized account/key/trust binding changed");
        }
        Ok(())
    }
}

pub(super) fn binding(env: &Environment) -> Result<&Binding> {
    let super::transport::Transport::MacosPersonalized { binding } = &env.transport else {
        bail!("Personalized macOS transport required");
    };
    binding.validate(env)?;
    Ok(binding)
}
pub(super) fn require_available() -> Result<()> {
    bail!("Personalized macOS setup is unavailable: this profile lacks verified restore provisioning and authenticated guest account/host-key capture. No SSH or legacy fallback was attempted")
}

/// An observation must come from the owned VM backend, never from UI parameters
/// or a cached IP. Until that backend/trust ceremony exists, rpc() refuses first.
pub(super) struct Endpoint {
    pub target: Target,
    pub sandbox: String,
    pub ip: Ipv4Addr,
    pub running: bool,
}
pub(super) struct Programs<'a> {
    pub ssh: &'a Path,
    pub keygen: &'a Path,
}

pub fn rpc(env: &Environment, method: &str, params: Value, budget: Duration) -> Result<Value> {
    binding(env)?;
    require_available()?;
    let endpoint = observed_endpoint(env)?;
    let root = super::host::root()?;
    let journal = Journal::open_existing(&root)?;
    rpc_using(
        &root,
        &journal,
        env,
        method,
        params,
        &endpoint,
        &Programs {
            ssh: Path::new("/usr/bin/ssh"),
            keygen: Path::new("/usr/bin/ssh-keygen"),
        },
        budget,
    )
}

fn observed_endpoint(_env: &Environment) -> Result<Endpoint> {
    // No production endpoint provider exists yet. In particular, a Cua name/IP
    // is not accepted as an immutable Lume VM/config observation.
    bail!("Authenticated personalized endpoint observation is unavailable")
}

/// One delivery, no retry. Callers retain their task/setup/attachment intent
/// before entering this function. A failed/lost receipt never proves release.
#[allow(clippy::too_many_arguments)] // Explicit internal fixture/executor dependencies; never a control RPC.
pub(super) fn rpc_using(
    root: &Path,
    journal: &Journal,
    env: &Environment,
    method: &str,
    params: Value,
    endpoint: &Endpoint,
    programs: &Programs<'_>,
    budget: Duration,
) -> Result<Value> {
    let pinned = binding(env)?;
    pinned.check_retained(root)?;
    if endpoint.target != pinned.target
        || endpoint.sandbox != env.sandbox
        || !endpoint.running
        || !endpoint.ip.is_private()
        || endpoint.ip.is_loopback()
    {
        bail!("Exact personalized VM endpoint is missing or replaced");
    }
    validate_route(root, journal, env, method, &params)?;
    let plan = macos_personalization::ssh_plan(
        root,
        &pinned.bootstrap_id,
        &pinned.target,
        endpoint.ip,
        &pinned.runtime_sha256,
        method,
        params,
    )?;
    let _keys = super::macos_keys::resolve(root, pinned, programs.keygen, budget)?;
    let directory = root
        .join("macos-personalization")
        .join(&pinned.bootstrap_id);
    super::macos_keys::check_directory(&directory)?;
    let known = directory.join("known_hosts");
    if known.try_exists()? {
        if super::macos_keys::private_read(&known, 4096)? != plan.known_hosts.as_bytes() {
            bail!("Retained SSH host-key pin changed; no replacement was written");
        }
    } else {
        super::macos_keys::write_new(&known, plan.known_hosts.as_bytes())?;
    }
    // A separate, fresh check catches changed journal/parent inputs before the
    // effect. The guest also checks the full account/runtime/env/generation.
    let request: Value = serde_json::from_slice(&plan.request)?;
    validate_route(root, journal, env, method, &request["params"])?;
    let mut command = isolated(programs.ssh, &directory);
    command.args(&plan.args);
    let response = super::transport::decode(&process::run(&mut command, &plan.request, budget)?)?;
    validate_route(root, journal, env, method, &request["params"])?;
    validate_response(journal, env, method, &request["params"], &response)?;
    Ok(response)
}

pub(super) fn isolated(program: &Path, home: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", home)
        .env("LC_ALL", "C")
        .env("SSH_ASKPASS_REQUIRE", "never");
    command
}

fn validate_route(
    root: &Path,
    journal: &Journal,
    env: &Environment,
    method: &str,
    params: &Value,
) -> Result<()> {
    let mut state = journal.read()?;
    let current = state
        .environments
        .get(&env.id)
        .context("Selected environment disappeared")?;
    if !state.enabled
        || current.deleted_at.is_some()
        || current.generation != env.generation
        || current.sandbox != env.sandbox
        || current.transport != env.transport
    {
        bail!("Retained personalized transport changed; no fallback");
    }
    for (key, value) in [("environmentId", &env.id), ("generation", &env.generation)] {
        if params.get(key).is_some_and(|v| v.as_str() != Some(value)) {
            bail!("Guest request target changed");
        }
    }
    if method == "task.start" {
        let offered: journal::Task = serde_json::from_value(params["task"].clone())?;
        if offered.target.environment_id != env.id || offered.target.generation != env.generation {
            bail!("Task belongs to another environment");
        }
        let retained = journal::bound(&mut state, &offered.target)?;
        if retained.input != offered.input
            || retained.input_digest != offered.input_digest
            || retained.idempotency_key != offered.idempotency_key
            || retained.guest_cwd != offered.guest_cwd
            || retained.transport_binding != offered.transport_binding
            || retained.computer != offered.computer
        {
            bail!("Task parent/input/transport identity differs from retained submission");
        }
    } else if method.starts_with("task.") || method == "desktop.takeover" {
        let target: journal::TaskTarget = serde_json::from_value(params["target"].clone())?;
        if target.environment_id != env.id || target.generation != env.generation {
            bail!("Task belongs to another environment");
        }
        journal::bound(&mut state, &target)?;
    } else if method.starts_with("desktop.attachment") && method != "desktop.attachmentCapabilities"
    {
        let id = params["leaseId"]
            .as_str()
            .context("Desktop lease missing")?;
        journal::validate_id(id)?;
        let record: Value = serde_json::from_slice(&super::macos_keys::private_read(
            &root.join("macos-attachments").join(format!("{id}.json")),
            128 * 1024 * 1024,
        )?)?;
        if record["transportBinding"] != json!(env.transport) {
            bail!("Desktop transport history changed");
        }
        for field in [
            "environmentId",
            "generation",
            "leaseId",
            "sessionId",
            "tabId",
            "conversation",
        ] {
            if record["binding"][field] != params[field] {
                bail!("Desktop parent/lease identity changed");
            }
        }
    }
    Ok(())
}

fn validate_response(
    journal: &Journal,
    env: &Environment,
    method: &str,
    params: &Value,
    response: &Value,
) -> Result<()> {
    if method == "describe" {
        let pinned = binding(env)?;
        if response["environmentId"] != env.id
            || response["generation"] != env.generation
            || response["runtimeSha256"] != pinned.runtime_sha256
            || response["protocol"] != journal::PROTOCOL
            || response["platform"] != "macos"
            || response["identity"]["macosAccount"] != json!(pinned.account)
        {
            bail!("Personalized runtime description lacks the exact serving account/artifact identity");
        }
    }
    if matches!(
        method,
        "task.start"
            | "task.poll"
            | "task.cancel"
            | "task.followup"
            | "task.recover"
            | "task.permission"
    ) {
        let target: journal::TaskTarget = serde_json::from_value(if method == "task.start" {
            params["task"]["target"].clone()
        } else {
            params["target"].clone()
        })?;
        let mut state = journal.read()?;
        let retained = journal::bound(&mut state, &target)?;
        let offered: journal::Task = serde_json::from_value(response.clone())?;
        if offered.target != retained.target
            || offered.input != retained.input
            || offered.input_digest != retained.input_digest
            || offered.transport_binding != retained.transport_binding
            || offered.computer != retained.computer
            || offered.idempotency_key != retained.idempotency_key
            || offered.guest_cwd != retained.guest_cwd
        {
            bail!("Guest task receipt changed parent/transport identity; original outcome remains fenced");
        }
    } else if method == "environment.setupReadiness" {
        super::setup::check_binding(
            env,
            params["harness"]
                .as_str()
                .context("Setup provider missing")?,
            response,
        )?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InstallPlan {
    pub identity: Value,
    pub runtime_sha256: String,
    pub runtime_path: PathBuf,
    pub plist_path: PathBuf,
    pub plist: String,
}
pub(super) fn install_plan(env: &Environment, runtime_sha256: &str) -> Result<InstallPlan> {
    let pinned = binding(env)?;
    if pinned.runtime_sha256 != runtime_sha256 {
        bail!("Personalized installer runtime differs from sealed binding");
    }
    let base = pinned.account.installation()?;
    Ok(InstallPlan {
        identity: json!({"environmentId":env.id,"generation":env.generation,"protocol":journal::PROTOCOL,"macosAccount":pinned.account}),
        runtime_sha256: runtime_sha256.into(),
        runtime_path: base.join("bin/terminalx-serve"),
        plist_path: Path::new(&pinned.account.home)
            .join("Library/LaunchAgents/com.terminalx.local-guest.plist"),
        plist: super::supervisor::guest_plist(env)?,
    })
}

pub(super) fn install(env: &Environment, _runtime: &Path) -> Result<()> {
    let pinned = binding(env)?;
    let _plan = install_plan(env, &pinned.runtime_sha256)?;
    require_available()?;
    bail!("Personalized runtime delivery requires the authenticated bootstrap installer receipt; legacy Cua installation is not used")
}

#[cfg(test)]
#[path = "macos_transport_tests.rs"]
mod tests;
