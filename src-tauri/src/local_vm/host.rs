//! Host adapter to a separately installed Cua/Lume stack. Requests are always
//! qualified by a journal identity; none accepts a raw tool/desktop selector.
use super::journal::{self, Environment, Journal, Task, TaskInput, TaskTarget};
use super::process;
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const IMAGE: &str =
    "ghcr.io/trycua/macos@sha256:7cb23670cad48a6723cf667bc63c444b83dc0c73756c23b614897127d5ba22ba";
pub const DOWNLOAD_BYTES: u64 = 24_212_741_210;
pub const GUEST_HOME: &str = "/Users/lume/.terminalx-local";
const BUDGET: Duration = Duration::from_secs(45);

pub fn root() -> Result<PathBuf> {
    Ok(crate::store::root()?.join("local-vm"))
}
pub fn journal() -> Result<Journal> {
    let root = root()?;
    if super::supervisor::initialized(&root) {
        Journal::open_existing(&root)
    } else {
        Journal::open(&root)
    }
}

pub fn request(method: &str, params: Value) -> Result<Value> {
    let journal = journal()?;
    match method {
        "state" => {
            let mut state = serde_json::to_value(journal.read()?)?;
            let health: Option<Value> = fs::read(root()?.join("health.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            let last_seen = health
                .as_ref()
                .and_then(|v| v.get("at"))
                .and_then(Value::as_str);
            let fresh = last_seen
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .is_some_and(|at| {
                    let age = chrono::Utc::now().signed_duration_since(at).num_seconds();
                    (0..=15).contains(&age)
                });
            state["supervisor"] = json!({"connected":fresh,"lastSeenAt":last_seen,"detail":health.as_ref().and_then(|v|v.get("detail"))});
            state["creation"] = super::creation::capability();
            return Ok(state);
        }
        "configure" => {
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .context("enabled is required")?;
            journal.transaction(|s| {
                s.enabled = enabled;
                Ok(())
            })?;
            return Ok(json!({"enabled":enabled}));
        }
        "doctor" => return doctor(),
        _ => {}
    }
    if !journal.read()?.enabled {
        bail!("Enable Local Cua in Settings → Environments first");
    }
    match method {
        "enroll" => {
            compatible()?;
            let sandbox = field(&params, "sandbox")?;
            let info = inspect_sandbox(sandbox)?;
            validate_macos_vm(&info)?;
            Ok(serde_json::to_value(
                journal.enroll(field(&params, "name")?, sandbox)?,
            )?)
        }
        "environment.create" => create(&journal, &params),
        "environment.setup" => super::setup::queue(&journal, params),
        "environment.setupReadiness" => super::setup::inspect(&journal, params),
        "environment.setupAction" => super::setup::action(&journal, params),
        "environment.setupAuth" => super::setup::auth(&journal, params),
        "task.submit" => submit(&journal, params),
        "environment.start" => {
            let env = environment(&journal, &params)?;
            compatible()?;
            cua(
                &["sb", "resume", &env.sandbox],
                b"",
                Duration::from_secs(180),
            )?;
            Ok(json!({"started":true}))
        }
        "environment.stop" => {
            confirm(&params)?;
            let env = environment(&journal, &params)?;
            cua(
                &["sb", "suspend", &env.sandbox],
                b"",
                Duration::from_secs(120),
            )?;
            journal.transaction(|s| {
                for task in s
                    .tasks
                    .values_mut()
                    .filter(|t| t.target.environment_id == env.id && t.status.holds_desktop())
                {
                    task.status = journal::TaskStatus::OutcomeUnknown;
                    task.detail = Some(
                        "VM stopped; external outcome is unknown until the guest reconnects".into(),
                    );
                }
                Ok(())
            })?;
            Ok(json!({"stopped":true,"historyRetained":true}))
        }
        "environment.inspect" => {
            let env = environment(&journal, &params)?;
            if params["purpose"] == "deletion" {
                return Ok(
                    json!({"status":"deletionInspection","stages":[],"deletion":deletion_preview(&journal,&env)}),
                );
            }
            if env
                .provision
                .as_ref()
                .is_some_and(|p| p["status"] == "outcomeUnknown")
                || params["purpose"] == "provisionRecovery"
            {
                // Recovery inspection must not start driver/model/auth probes.
                let review = super::provisioning::preview(&journal, &env);
                return Ok(
                    json!({"status":"outcomeUnknown","stages":env.provision.as_ref().and_then(|p|p.get("stages")),
                    "reconciliation":review,"deletion":{"canDelete":false,"reason":"Reconcile interrupted provisioning before independent deletion inspection","tasks":[],"guestWork":null}}),
                );
            }
            let vm = inspect_sandbox(&env.sandbox)?;
            let runtime = guest_rpc(&env, "describe", json!({}));
            if let Ok(response) = &runtime {
                record_manual_control(&journal, &env, response)?;
            }
            let deletion = deletion_preview(&journal, &env);
            Ok(
                json!({"status":vm.get("state").or(vm.get("status")),"stages":env.provision.as_ref().and_then(|p|p.get("stages")).cloned().unwrap_or(json!([])),"vm":safe_vm(&vm),"runtime":runtime.as_ref().ok(),"deletion":deletion,"detail":runtime.err().map(|e|crate::remote::protocol::redact(&format!("{e:#}")))}),
            )
        }
        "environment.reconcileProvision" => super::provisioning::reconcile(&journal, params),
        "environment.install" => {
            let env = environment(&journal, &params)?;
            install_guest(&env, Path::new(field(&params, "runtimePath")?))?;
            Ok(json!({"installed":true,"credentialsCopied":false}))
        }
        "environment.releaseDesktop" => {
            confirm(&params)?;
            let env = environment(&journal, &params)?;
            let response = guest_rpc(&env, "desktop.release", json!({"confirm":true}))?;
            manual_control_receipt(&journal, &env, &response, false)?;
            Ok(response)
        }
        "task.takeover" => {
            confirm(&params)?;
            let target: TaskTarget =
                serde_json::from_value(params.get("target").cloned().context("target required")?)?;
            let (task, env) = bound_environment(&journal, &target)?;
            let mut request = params;
            request["after"] = json!(task.last_event_seq);
            let response = guest_rpc(&env, "desktop.takeover", request)?;
            // A durable manual hold is independent of whether worker exit is
            // confirmed yet. Never clear it because takeover is still pending.
            manual_control_receipt(&journal, &env, &response, true)?;
            let stopped = response
                .get("task")
                .context("Guest takeover task receipt is missing")?;
            let stopped = recovery_receipt(&task, stopped)?;
            let ready = response
                .get("ready")
                .and_then(Value::as_bool)
                .context("Guest takeover readiness is missing")?;
            if ready && !stopped.status.terminal() {
                bail!("Guest worker exit is not confirmed; manual desktop hold remains in place");
            }
            Ok(response)
        }
        "environment.awake" => {
            let env = environment(&journal, &params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .context("enabled required")?;
            journal.transaction(|s| {
                s.environments
                    .get_mut(&env.id)
                    .context("Environment not found")?
                    .keep_awake = enabled;
                Ok(())
            })?;
            Ok(json!({"enabled":enabled}))
        }
        "environment.desktop" => {
            let env = environment(&journal, &params)?;
            if let Some(target) = params.get("target") {
                let target: TaskTarget = serde_json::from_value(target.clone())?;
                let (_, bound) = bound_environment(&journal, &target)?;
                if bound.id != env.id {
                    bail!("Desktop environment differs from task target");
                }
            }
            // Native Lume viewing avoids the upstream HTTP codec path that
            // failed the pilot. It is separate from worker/VM lifetime.
            let info = inspect_sandbox(&env.sandbox)?;
            validate_macos_vm(&info)?;
            if !info
                .get("state")
                .or(info.get("status"))
                .and_then(Value::as_str)
                .is_some_and(|s| matches!(s, "running" | "ready"))
            {
                bail!("Start this VM before opening its desktop");
            }
            process::run(
                process::command("lume")?
                    .args(["attach", env.sandbox.trim_start_matches("local:")]),
                b"",
                BUDGET,
            )?;
            Ok(json!({"opened":true,"viewer":"lume","workerLifetime":"independent"}))
        }
        "environment.cancelProvision" => {
            let env = environment(&journal, &params)?;
            cancel_provision(&journal, &env)
        }
        "environment.delete" => delete(&journal, &params),
        "describe" => {
            let env = environment(&journal, &params)?;
            let response = guest_rpc(&env, "describe", json!({}))?;
            record_manual_control(&journal, &env, &response)?;
            Ok(response)
        }
        "task.cancel" | "task.followup" | "task.permission" | "task.recover" => {
            let target: TaskTarget =
                serde_json::from_value(params.get("target").cloned().context("target required")?)?;
            let (task, env) = bound_environment(&journal, &target)?;
            if method == "task.followup" && task.status.terminal() {
                bail!("This task has finished; submit a new selected task for further work");
            }
            if method == "task.cancel" {
                let canceled = journal.transaction(|s| {
                    let t = journal::bound(s, &target)?;
                    if t.status.terminal() {
                        return Ok(Some(t.clone()));
                    }
                    if !t.dispatch_started {
                        t.status = journal::TaskStatus::Canceled;
                        t.updated_at = journal::now();
                        return Ok(Some(t.clone()));
                    }
                    Ok(None)
                })?;
                if let Some(canceled) = canceled {
                    return Ok(serde_json::to_value(canceled)?);
                }
            }
            if method == "task.recover" {
                confirm(&params)?;
            }
            let result = guest_rpc(&env, method, params)?;
            if method == "task.recover" {
                let recovered = recovery_receipt(&task, &result)?;
                journal.transaction(|s| {
                    let t = journal::bound(s, &target)?;
                    if !t.status.terminal() && !recovered.status.terminal() {
                        t.status = recovered.status;
                        t.detail = recovered.detail;
                        t.updated_at = journal::now();
                    }
                    Ok(())
                })?;
            }
            if method == "task.cancel" {
                journal.transaction(|s| {
                    let t = journal::bound(s, &target)?;
                    if t.status.terminal() {
                        return Ok(());
                    }
                    // A cancellation receipt is not worker-exit evidence. The
                    // supervisor polls and retains terminal events/artifacts
                    // before releasing the lease or enabling manual takeover.
                    retain_cancellation(t, &result);
                    t.updated_at = journal::now();
                    Ok(())
                })?;
            }
            Ok(result)
        }
        "task.artifact" => artifact(&journal, &params),
        "task.applyPatch" => apply_patch(&journal, &params),
        _ => bail!("Unknown local VM method"),
    }
}

fn retain_cancellation(task: &mut Task, response: &Value) {
    // A tombstone prevents a delayed start but cannot erase evidence of an
    // earlier dispatch whose guest record has disappeared or rolled back.
    if response["absent"] == true {
        task.status = journal::TaskStatus::OutcomeUnknown;
        task.detail = Some("The guest task record is missing. Cancellation blocks delayed starts, but earlier worker exit and external outcomes remain unknown.".into());
    } else if response["status"] == "outcomeUnknown" {
        task.status = journal::TaskStatus::OutcomeUnknown;
    } else {
        task.status = journal::TaskStatus::Canceling;
    }
}

pub(crate) fn cancel_provision(journal: &Journal, env: &Environment) -> Result<Value> {
    let stage = journal.transaction(|state| {
        let current = state
            .environments
            .get_mut(&env.id)
            .filter(|current| current.generation == env.generation && current.deleted_at.is_none())
            .context("Environment timeline changed")?;
        let status = current
            .provision
            .as_ref()
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            .context("Provisioning state requires explicit inspection")?;
        let status = status.to_owned();
        match status.as_str() {
            "queued" => {
                current.provision = Some(progress(
                    "canceled",
                    "Canceled before any provisioning process started; no VM operation was sent",
                ))
            }
            "running" => current.provision = Some(progress(
                "canceling",
                "Cancel requested; stopping the Cua client does not prove the VM operation stopped",
            )),
            "canceling" | "outcomeUnknown" | "completed" | "failed" | "canceled" => {}
            _ => bail!(
                "Unrecognized provisioning state; inspect retained history before reconciling"
            ),
        }
        Ok(current.provision.clone())
    })?;
    Ok(json!({"cancelRequested":true,"provision":stage}))
}

fn recovery_receipt(task: &Task, response: &Value) -> Result<Task> {
    let recovered: Task =
        serde_json::from_value(response.clone()).context("Invalid guest recovery receipt")?;
    if recovered.target != task.target
        || recovered.input != task.input
        || recovered.idempotency_key != task.idempotency_key
        || recovered.input_digest != task.input_digest
        || recovered.guest_cwd != task.guest_cwd
        || recovered.worker_session_id != task.worker_session_id
        || recovered.worker_tab_id != task.worker_tab_id
        || recovered.provider_conversation_id != task.provider_conversation_id
    {
        bail!("Guest recovery changed immutable task or provider conversation identity");
    }
    Ok(recovered)
}

pub fn field<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("{key} is required"))
}
fn confirm(params: &Value) -> Result<()> {
    if params.get("confirm") != Some(&Value::Bool(true)) {
        bail!("Explicit confirmation is required");
    }
    Ok(())
}
fn environment(journal: &Journal, params: &Value) -> Result<Environment> {
    let state = journal.read()?;
    let env = state
        .environments
        .get(field(params, "environmentId")?)
        .filter(|e| e.deleted_at.is_none())
        .context("Environment unavailable; no host fallback")?
        .clone();
    if params
        .get("generation")
        .is_some_and(|v| v.as_str() != Some(&env.generation))
    {
        bail!("Environment generation changed; no operation was routed");
    }
    Ok(env)
}
pub fn bound_environment(journal: &Journal, target: &TaskTarget) -> Result<(Task, Environment)> {
    journal.transaction(|state| {
        let task = journal::bound(state, target)?.clone();
        let env = state
            .environments
            .get(&target.environment_id)
            .context("Environment not found")?
            .clone();
        Ok((task, env))
    })
}

pub fn cua(args: &[&str], input: &[u8], budget: Duration) -> Result<Vec<u8>> {
    process::run(process::command("cua")?.args(args), input, budget)
}
pub fn inspect_sandbox(sandbox: &str) -> Result<Value> {
    journal::validate_sandbox(sandbox)?;
    let info: Value =
        serde_json::from_slice(&cua(&["sb", "info", sandbox, "--json"], b"", BUDGET)?)?;
    Ok(info)
}
fn validate_macos_vm(info: &Value) -> Result<()> {
    let image = info
        .get("image")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if info.get("kind").and_then(Value::as_str) != Some("vm")
        || info.get("runtime").and_then(Value::as_str) != Some("lume")
        || !image.contains("macos")
    {
        bail!("Only a local Lume macOS VM is supported; host Spaces and Linux guests are refused");
    }
    Ok(())
}
fn safe_vm(info: &Value) -> Value {
    json!({"id":info.get("id"),"state":info.get("state"),"image":info.get("image"),"sizeBytes":info.get("size_bytes"),"diskLimitBytes":161_061_273_600_u64})
}

pub fn record_manual_control(journal: &Journal, env: &Environment, response: &Value) -> Result<()> {
    if let Some(manual) = response.get("manualControl").and_then(Value::as_bool) {
        journal.transaction(|s| {
            s.environments
                .get_mut(&env.id)
                .filter(|current| {
                    current.deleted_at.is_none() && current.generation == env.generation
                })
                .context("Environment timeline changed; manual desktop control receipt is stale")?
                .manual_control = manual;
            Ok(())
        })?;
    }
    Ok(())
}

fn manual_control_receipt(
    journal: &Journal,
    env: &Environment,
    response: &Value,
    expected: bool,
) -> Result<()> {
    if response.get("manualControl").and_then(Value::as_bool) != Some(expected) {
        bail!("Guest did not acknowledge the durable manual desktop control state");
    }
    record_manual_control(journal, env, response)
}
pub fn guest_rpc(env: &Environment, method: &str, params: Value) -> Result<Value> {
    journal::validate_sandbox(&env.sandbox)?;
    let info = inspect_sandbox(&env.sandbox)?;
    guest_rpc_ready(env, method, params, &info, BUDGET)
}

pub(super) fn guest_rpc_ready(
    env: &Environment,
    method: &str,
    mut params: Value,
    info: &Value,
    budget: Duration,
) -> Result<Value> {
    validate_macos_vm(info)?;
    if info["id"] != env.sandbox {
        bail!("Cua returned a different VM identity; no guest request was sent");
    }
    if !info
        .get("state")
        .or(info.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|s| matches!(s, "running" | "ready"))
    {
        bail!("Guest VM is stopped or unavailable; start it explicitly. No host fallback");
    }
    params["environmentId"] = json!(env.id);
    params["generation"] = json!(env.generation);
    let request = serde_json::to_vec(&json!({"method":method,"params":params}))?;
    // -i uses argv and authenticated Cua guest transport, not an HTTP endpoint
    // exposed to the LAN. The guest helper reads its own owner-only token.
    let bytes = cua(
        &[
            "sb",
            "exec",
            "-i",
            &env.sandbox,
            "--",
            "/Users/lume/.terminalx-local/bin/terminalx-serve",
            "local-vm-rpc",
            "-",
        ],
        &request,
        budget,
    )?;
    let response: Value = serde_json::from_slice(&bytes).context("Invalid guest response")?;
    if response.get("ok") == Some(&Value::Bool(false)) {
        bail!(
            "Guest request refused: {}",
            response
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("guest unavailable")
        );
    }
    Ok(response.get("result").cloned().unwrap_or(response))
}

fn compatible() -> Result<()> {
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" {
        bail!("Local macOS VMs require an Apple Silicon Mac");
    }
    for (program, wanted) in [
        ("cua", journal::CUA_VERSION),
        ("lume", journal::LUME_VERSION),
    ] {
        let output = process::run(process::command(program)?.arg("--version"), b"", BUDGET)?;
        let version = String::from_utf8_lossy(&output);
        if !version
            .split_whitespace()
            .any(|v| v.trim_start_matches('v') == wanted)
        {
            bail!("Install the pinned {program} version {wanted}; runtime mismatch");
        }
    }
    Ok(())
}
// statvfs integer widths vary between supported Unix build targets.
#[allow(clippy::unnecessary_cast)]
fn available_disk(path: &Path) -> Result<u64> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: CString is terminated and stat points to writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful statvfs initialized stat.
    let stat = unsafe { stat.assume_init() };
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}
fn resources() -> Result<Value> {
    if std::env::consts::OS != "macos" {
        return Ok(json!({"virtualizationAvailable":false}));
    }
    let sysctl = |key: &str| -> Result<u64> {
        let out = process::run(
            std::process::Command::new("/usr/sbin/sysctl").args(["-n", key]),
            b"",
            BUDGET,
        )?;
        Ok(String::from_utf8(out)?.trim().parse()?)
    };
    let memory = sysctl("hw.memsize")?;
    let vm = process::run(
        &mut std::process::Command::new("/usr/bin/vm_stat"),
        b"",
        BUDGET,
    )?;
    let vm = String::from_utf8(vm)?;
    let page = vm
        .lines()
        .next()
        .and_then(|s| s.split("page size of ").nth(1))
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(16384);
    let mut pages = 0_u64;
    for line in vm.lines().filter(|s| {
        s.starts_with("Pages free:")
            || s.starts_with("Pages inactive:")
            || s.starts_with("Pages speculative:")
    }) {
        if let Some(count) = line
            .split(':')
            .nth(1)
            .and_then(|s| s.trim().trim_end_matches('.').parse::<u64>().ok())
        {
            pages = pages.saturating_add(count);
        }
    }
    Ok(
        json!({"virtualizationAvailable":sysctl("kern.hv_support").unwrap_or(0)==1,"memoryBytes":memory,"availableMemoryBytes":pages.saturating_mul(page),"cpuCount":sysctl("hw.ncpu").unwrap_or(0)}),
    )
}
pub fn doctor() -> Result<Value> {
    let compatibility = compatible();
    let runtime = cua(&["runtime", "doctor", "--json"], b"", BUDGET)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let home = dirs::home_dir().context("Home directory unavailable")?;
    Ok(
        json!({"compatible":compatibility.is_ok(),"reason":compatibility.err().map(|e|crate::remote::protocol::redact(&format!("{e:#}"))),"runtime":runtime,"resources":resources()?,"freeDiskBytes":available_disk(&home)?,"profile":{"image":IMAGE,"downloadBytes":DOWNLOAD_BYTES,"cpu":4,"memoryBytes":8_589_934_592_u64,"diskLimitBytes":161_061_273_600_u64,"storage":home.join(".lume"),"cache":home.join(".cua"),"minimumFreeDiskBytes":53_687_091_200_u64},"bootstrapProfile":super::bootstrap::profile(),"releaseGatesVerified":false}),
    )
}
pub fn progress(status: &str, detail: &str) -> Value {
    json!({"status":status,"detail":detail,"stages":[{"id":"provision","label":"Create macOS guest","status":status,"detail":detail}]})
}
fn create(journal: &Journal, params: &Value) -> Result<Value> {
    confirm(params)?;
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" {
        bail!("Local macOS setup requires Apple Silicon");
    }
    let name = field(params, "name")?;
    let vm_name = field(params, "vmName")?;
    let sandbox = format!("local:{vm_name}");
    let key = field(params, "idempotencyKey")?;
    let harness = field(params, "harness")?;
    super::setup::validate_request(harness, key)?;
    if name.trim().is_empty() || name.len() > 120 {
        bail!("Provide an environment name of 1–120 bytes");
    }
    journal::validate_sandbox(&sandbox)?;
    if let Some(existing) = existing_creation(&journal.read()?, name, &sandbox, harness, key)? {
        return Ok(serde_json::to_value(existing)?);
    }
    if harness != "codex" {
        bail!("Guided creation currently prepares Codex only. No machine or download was started; existing other-provider tasks and environments are preserved");
    }
    super::creation::require_supported()?;
    if let Some(existing) = journal
        .read()?
        .environments
        .values()
        .find(|e| e.sandbox == sandbox && e.deleted_at.is_none())
    {
        if existing.owned
            && existing.name == name
            && existing
                .setup
                .as_ref()
                .is_some_and(|s| s["idempotencyKey"] == key && s["harness"] == harness)
        {
            return Ok(serde_json::to_value(existing)?);
        }
        bail!("This VM identity is already enrolled");
    }
    if available_disk(&dirs::home_dir().context("Home directory unavailable")?)?
        < 50 * 1024 * 1024 * 1024
    {
        bail!("At least 50 GiB free disk is required before project/toolchain growth");
    }
    let resources = resources()?;
    if resources["virtualizationAvailable"] != true
        || resources["memoryBytes"].as_u64().unwrap_or(0) < 16 * 1024 * 1024 * 1024
        || resources["availableMemoryBytes"].as_u64().unwrap_or(0) < 8 * 1024 * 1024 * 1024
    {
        bail!("Virtualization and at least 8 GiB currently available memory (16 GiB total) are required, leaving resources for this Mac");
    }
    Ok(serde_json::to_value(reserve_creation(
        journal, name, &sandbox, harness, key,
    )?)?)
}

fn existing_creation(
    state: &journal::State,
    name: &str,
    sandbox: &str,
    harness: &str,
    key: &str,
) -> Result<Option<Environment>> {
    if let Some(prior) = state
        .environments
        .values()
        .find(|e| e.setup.as_ref().is_some_and(|s| s["idempotencyKey"] == key))
    {
        if prior.name != name.trim()
            || prior.sandbox != sandbox
            || prior.setup.as_ref().unwrap()["harness"] != harness
        {
            bail!("Creation key already names different approved input");
        }
        return Ok(Some(prior.clone()));
    }
    Ok(None)
}
fn reserve_creation(
    journal: &Journal,
    name: &str,
    sandbox: &str,
    harness: &str,
    key: &str,
) -> Result<Environment> {
    super::setup::validate_request(harness, key)?;
    journal::validate_sandbox(sandbox)?;
    journal.transaction(|state| {
        if let Some(prior) = existing_creation(state, name, sandbox, harness, key)? {
            return Ok(prior);
        }
        if state
            .environments
            .values()
            .any(|e| e.sandbox == sandbox && e.deleted_at.is_none())
        {
            bail!("VM identity is already enrolled");
        }
        let mut env = Environment {
            id: journal::new_id(),
            name: name.trim().into(),
            sandbox: sandbox.into(),
            generation: journal::new_id(),
            created_at: journal::now(),
            deleted_at: None,
            keep_awake: false,
            owned: true,
            provision: Some(progress(
                "queued",
                "Waiting for disclosed tool preparation before creating the VM",
            )),
            manual_control: false,
            setup: None,
        };
        env.setup = Some(super::setup::initial(&env, harness, key)?);
        state.environments.insert(env.id.clone(), env.clone());
        Ok(env)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Submission {
    idempotency_key: String,
    input: TaskInput,
    source_root: String,
}
fn submit(journal: &Journal, params: Value) -> Result<Value> {
    let req: Submission = serde_json::from_value(params)?;
    if journal
        .read()?
        .environments
        .get(&req.input.environment_id)
        .is_some_and(super::setup::busy)
    {
        bail!("Finish this environment's guided setup and desktop verification before submitting a task");
    }
    let files = export_files(Path::new(&req.source_root), &req.input.files)?;
    let task = journal.submit(&req.idempotency_key, req.input)?;
    // A recovered submission may supply these bytes again, but can never
    // change the approved hash or send a new prompt under the existing key.
    let path = root()?.join("inputs");
    journal::private_directory(&path)?;
    journal::atomic_private_write(
        &path.join(format!("{}.json", task.target.task_id)),
        &serde_json::to_vec(&files)?,
    )?;
    Ok(serde_json::to_value(task)?)
}
fn validate_context_path(path: &str) -> Result<()> {
    journal::validate_relative(path)?;
    for part in path.split('/') {
        let part = part.to_ascii_lowercase();
        if matches!(
            part.as_str(),
            ".git"
                | ".ssh"
                | ".aws"
                | ".gnupg"
                | ".azure"
                | ".kube"
                | ".codex"
                | ".claude"
                | "node_modules"
        ) || part == ".env"
            || part.starts_with(".env.")
            || part == "credentials"
            || part.starts_with("credentials.")
            || part == "id_rsa"
            || part.starts_with("id_rsa.")
            || part == "id_ed25519"
            || part.starts_with("id_ed25519.")
            || [".pem", ".key", ".p12", ".pfx"]
                .iter()
                .any(|extension| part.ends_with(extension))
        {
            bail!("Credential/private configuration cannot be exported as task context");
        }
    }
    Ok(())
}
pub fn export_files(source: &Path, manifest: &[journal::InputFile]) -> Result<Value> {
    if !source.is_absolute() {
        bail!("Explicit absolute context root required");
    }
    if manifest.len() > 64 {
        bail!("Select at most 64 context files");
    }
    let source = fs::canonicalize(source)?;
    let mut total = 0_u64;
    let mut files = Vec::new();
    for item in manifest {
        validate_context_path(&item.path)?;
        let path = fs::canonicalize(source.join(&item.path))?;
        if !path.starts_with(&source) || !path.is_file() {
            bail!("Selected input leaves project scope");
        }
        validate_context_path(
            path.strip_prefix(&source)?
                .to_str()
                .context("Context path must be UTF-8")?,
        )?;
        if path.metadata()?.len() > 10 * 1024 * 1024 {
            bail!("Selected file exceeds 10 MiB");
        }
        let bytes = fs::read(&path)?;
        total = total
            .checked_add(bytes.len() as u64)
            .context("Input size overflow")?;
        if total > 10 * 1024 * 1024 || manifest.len() > 64 {
            bail!("Selected context exceeds transfer limit");
        }
        if bytes.len() as u64 != item.bytes || journal::digest(&bytes) != item.sha256 {
            bail!("Selected context changed since approval; review the manifest again");
        }
        files.push(json!({"path":item.path,"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
    }
    Ok(json!(files))
}

pub(crate) fn install_current_guest(env: &Environment) -> Result<()> {
    install_guest(env, &std::env::current_exe()?)
}

pub(crate) fn check_setup_vm(env: &Environment) -> Result<()> {
    let info = inspect_sandbox(&env.sandbox)?;
    validate_macos_vm(&info)?;
    if info["id"] != env.sandbox
        || info["state"] != "running"
        || info["status"] != "ready"
        || env.owned && info["image"] != IMAGE
    {
        bail!("The selected guest is not authoritatively booted with the expected profile. No machine was recreated; inspect/start this exact VM explicitly");
    }
    Ok(())
}

pub(crate) fn prepare_guest_driver(env: &Environment) -> Result<()> {
    // Existing compatible signed app is preserved in place, retaining its
    // designated requirement and user-granted permissions. Never replace or
    // stop a daemon as a side effect of setup inspection/preparation.
    let probe = "if test -d /Applications/CuaDriver.app; then /usr/bin/codesign --verify --strict /Applications/CuaDriver.app && /usr/bin/codesign --verify -R '=anchor apple generic and identifier com.trycua.driver and certificate leaf[subject.OU] = YCK386LBJ7' /Applications/CuaDriver.app && /Applications/CuaDriver.app/Contents/MacOS/cua-driver --version; else printf driver-missing; fi";
    let output = cua(
        &[
            "sb",
            "exec",
            "-i",
            &env.sandbox,
            "--",
            "/bin/sh",
            "-c",
            probe,
        ],
        b"",
        BUDGET,
    )?;
    let version = String::from_utf8_lossy(&output);
    if version
        .split_whitespace()
        .any(|v| v.trim_start_matches('v') == super::desktop::DRIVER_VERSION)
    {
        return Ok(());
    }
    if output != b"driver-missing" {
        bail!("Existing guest Driver does not match the supported signed profile; no daemon/app was replaced");
    }
    let prepared = super::bootstrap::prepare(&super::bootstrap::DRIVER)?;
    let archive = prepared.join("terminalx-archive.tar.gz");
    let bytes = fs::read(&archive)?;
    if journal::digest(&bytes) != super::bootstrap::DRIVER.sha256 {
        bail!("Cached Driver archive changed; no guest installation sent");
    }
    let stage = format!(
        "{GUEST_HOME}/staging/driver-{}",
        super::bootstrap::DRIVER.sha256
    );
    cua(
        &[
            "sb",
            "exec",
            "-i",
            &env.sandbox,
            "--",
            "/bin/mkdir",
            "-p",
            &stage,
        ],
        b"",
        BUDGET,
    )?;
    cua(
        &[
            "sb",
            "cp",
            archive.to_str().context("Tool archive path invalid")?,
            &format!("{}:{stage}/driver.tar.gz", env.sandbox),
        ],
        b"",
        Duration::from_secs(180),
    )?;
    let script=format!("set -eu; test ! -e /Applications/CuaDriver.app; cd '{stage}'; test \"$(/usr/bin/shasum -a 256 driver.tar.gz | /usr/bin/cut -d ' ' -f1)\" = '{}'; /usr/bin/tar -xzf driver.tar.gz; /usr/bin/codesign --verify --strict '{}'; /usr/bin/codesign --verify -R '=anchor apple generic and identifier com.trycua.driver and certificate leaf[subject.OU] = YCK386LBJ7' '{}'; /bin/mv '{}' /Applications/CuaDriver.app",super::bootstrap::DRIVER.sha256,super::bootstrap::DRIVER.signed_path,super::bootstrap::DRIVER.signed_path,super::bootstrap::DRIVER.signed_path);
    cua(
        &[
            "sb",
            "exec",
            "-i",
            &env.sandbox,
            "--",
            "/bin/sh",
            "-c",
            &script,
        ],
        b"",
        BUDGET,
    )?;
    Ok(())
}

pub(crate) fn prepare_guest_provider(env: &Environment, harness: &str) -> Result<()> {
    if harness != "codex" {
        bail!("This prepared profile supports automatic Codex setup; existing other provider installations are preserved");
    }
    let probe=format!("PATH='{GUEST_HOME}/bin:/Users/lume/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'; if command -v codex >/dev/null 2>&1; then codex --version; else printf provider-missing; fi");
    let output = cua(
        &[
            "sb",
            "exec",
            "-i",
            &env.sandbox,
            "--",
            "/bin/sh",
            "-c",
            &probe,
        ],
        b"",
        BUDGET,
    )?;
    if String::from_utf8_lossy(&output)
        .split_whitespace()
        .any(|v| v.trim_start_matches('v') == super::bootstrap::CODEX.version)
    {
        return Ok(());
    }
    if output != b"provider-missing" {
        bail!("Existing provider CLI differs from the pinned profile; its credentials/configuration were not replaced");
    }
    let prepared = super::bootstrap::prepare(&super::bootstrap::CODEX)?;
    let binary = prepared.join(super::bootstrap::CODEX.executable);
    let destination = format!("{}:{GUEST_HOME}/bin/codex.stage", env.sandbox);
    cua(
        &[
            "sb",
            "cp",
            binary.to_str().context("Provider tool path invalid")?,
            &destination,
        ],
        b"",
        Duration::from_secs(180),
    )?;
    // Initial file-store policy belongs only to a genuinely new guest account
    // setup. Existing account/config/auth files are never changed or copied.
    let script=format!("set -eu; cd '{GUEST_HOME}/bin'; test ! -e codex; test \"$(/usr/bin/shasum -a 256 codex.stage | /usr/bin/cut -d ' ' -f1)\" = '{}'; /usr/bin/codesign --verify --strict codex.stage; /usr/bin/codesign --verify -R '=anchor apple generic and identifier codex and certificate leaf[subject.OU] = 2DC432GLL2' codex.stage; chmod 755 codex.stage; /bin/mv codex.stage codex; if test ! -e /Users/lume/.codex/config.toml && test ! -e /Users/lume/.codex/auth.json; then /bin/mkdir -p /Users/lume/.codex; chmod 700 /Users/lume/.codex; (umask 077; printf 'cli_auth_credentials_store = \"file\"\\n' > /Users/lume/.codex/config.toml); fi",super::bootstrap::CODEX.executable_sha256);
    cua(
        &[
            "sb",
            "exec",
            "-i",
            &env.sandbox,
            "--",
            "/bin/sh",
            "-c",
            &script,
        ],
        b"",
        BUDGET,
    )?;
    Ok(())
}

fn install_guest(env: &Environment, runtime: &Path) -> Result<()> {
    compatible()?;
    if !runtime.is_absolute() || !runtime.is_file() {
        bail!("The bundled macOS arm64 guest runtime is unavailable");
    }
    process::run(
        std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(runtime),
        b"",
        BUDGET,
    )?;
    if journal()?
        .read()?
        .tasks
        .values()
        .any(|t| t.target.environment_id == env.id && !t.status.terminal())
    {
        bail!("Stop active tasks before changing the guest runtime");
    }
    if journal()?
        .read()?
        .environments
        .get(&env.id)
        .is_none_or(|e| {
            e.generation != env.generation || e.manual_control || e.deleted_at.is_some()
        })
    {
        bail!("Environment/manual lease changed; no runtime update sent");
    }
    let arches = process::run(
        std::process::Command::new("/usr/bin/lipo")
            .args(["-archs"])
            .arg(runtime),
        b"",
        BUDGET,
    )?;
    if !String::from_utf8_lossy(&arches)
        .split_whitespace()
        .any(|a| a == "arm64")
    {
        bail!("Runtime must contain macOS arm64 code");
    }
    let identity=cua(&["sb","exec","-i",&env.sandbox,"--","/bin/sh","-c","test \"$(uname -sm)\" = 'Darwin arm64' && test \"$(id -un)\" = lume && printf guest-ok"],b"",BUDGET)?;
    if identity != b"guest-ok" {
        bail!("Guest identity/profile mismatch");
    }
    cua(
        &[
            "sb",
            "exec",
            "-i",
            &env.sandbox,
            "--",
            "/bin/mkdir",
            "-p",
            GUEST_HOME,
            "/Users/lume/.terminalx-local/bin",
            "/Users/lume/.terminalx-local/runtime",
            "/Users/lume/Library/LaunchAgents",
        ],
        b"",
        BUDGET,
    )?;
    let prior=cua(&["sb","exec","-i",&env.sandbox,"--","/bin/sh","-c","if test -f /Users/lume/.terminalx-local/identity.json; then cat /Users/lume/.terminalx-local/identity.json; fi"],b"",BUDGET)?;
    if !prior.is_empty() {
        let prior: Value = serde_json::from_slice(&prior)?;
        if prior.get("environmentId").and_then(Value::as_str) != Some(&env.id)
            || prior.get("generation").and_then(Value::as_str) != Some(&env.generation)
        {
            bail!("This guest is bound to a different environment/timeline. Reconcile it explicitly before installation");
        }
        let current = cua(
            &[
                "sb",
                "exec",
                "-i",
                &env.sandbox,
                "--",
                "/usr/bin/shasum",
                "-a",
                "256",
                &format!("{GUEST_HOME}/bin/terminalx-serve"),
            ],
            b"",
            BUDGET,
        )?;
        let expected = journal::digest(&fs::read(runtime)?);
        if String::from_utf8_lossy(&current).split_whitespace().next() == Some(expected.as_str()) {
            // A matching file does not identify the process that is serving
            // requests: it may still be an older loaded executable.
            if guest_rpc(
                env,
                "environment.setupReadiness",
                json!({"harness":"codex"}),
            )
            .is_ok_and(|read| serving_runtime_matches(env, &expected, &read))
            {
                return Ok(());
            }
        }
        let disposition = guest_rpc(env, "environment.disposition", json!({}))?;
        let state = journal()?.read()?;
        let tasks: Vec<_> = state
            .tasks
            .values()
            .filter(|t| t.target.environment_id == env.id)
            .collect();
        validate_quiescent_history(env, &tasks, &disposition, false).context(
            "Guest worker/setup quiescence is unproven; existing daemon and history were retained",
        )?;
    }
    let destination = format!("{}:{GUEST_HOME}/bin/terminalx-serve.new", env.sandbox);
    cua(
        &[
            "sb",
            "cp",
            runtime.to_str().context("Runtime path must be UTF-8")?,
            &destination,
        ],
        b"",
        Duration::from_secs(180),
    )?;
    let checksum = journal::digest(&fs::read(runtime)?);
    let staging = root()?.join("install");
    journal::private_directory(&staging)?;
    let identity_path = staging.join(format!("{}.json", env.id));
    journal::atomic_private_write(
        &identity_path,
        &serde_json::to_vec(
            &json!({"environmentId":env.id,"generation":env.generation,"protocol":journal::PROTOCOL}),
        )?,
    )?;
    cua(
        &[
            "sb",
            "cp",
            identity_path.to_str().unwrap(),
            &format!("{}:{GUEST_HOME}/identity.json", env.sandbox),
        ],
        b"",
        BUDGET,
    )?;
    let plist = super::supervisor::guest_plist(env);
    let plist_path = staging.join(format!("{}.plist", env.id));
    journal::atomic_private_write(&plist_path, plist.as_bytes())?;
    cua(
        &[
            "sb",
            "cp",
            plist_path.to_str().unwrap(),
            &format!(
                "{}:/Users/lume/Library/LaunchAgents/com.terminalx.local-guest.plist",
                env.sandbox
            ),
        ],
        b"",
        BUDGET,
    )?;
    let script=format!("set -eu; cd '{GUEST_HOME}/bin'; test \"$(shasum -a 256 terminalx-serve.new | cut -d ' ' -f1)\" = '{checksum}'; chmod 700 '{GUEST_HOME}' '{GUEST_HOME}/runtime'; chmod 600 '{GUEST_HOME}/identity.json'; chmod 755 terminalx-serve.new; mv terminalx-serve.new terminalx-serve; {}",super::supervisor::RELOAD_GUEST_AGENT);
    cua(
        &[
            "sb",
            "exec",
            "-i",
            &env.sandbox,
            "--",
            "/bin/sh",
            "-c",
            &script,
            "terminalx-guest-install",
            "com.terminalx.local-guest",
            "/Users/lume/Library/LaunchAgents/com.terminalx.local-guest.plist",
        ],
        b"",
        BUDGET,
    ).context("The verified guest runtime was copied, but its LaunchAgent handoff failed. Inspect the exact guest service before recovering setup; the VM and Driver were not restarted")?;
    let expected = journal::digest(&fs::read(runtime)?);
    for _ in 0..6 {
        if guest_rpc(
            env,
            "environment.setupReadiness",
            json!({"harness":"codex"}),
        )
        .is_ok_and(|read| serving_runtime_matches(env, &expected, &read))
        {
            return Ok(());
        }
        if super::supervisor::stopping() {
            bail!("Owner stopped while confirming installed runtime; installation outcome remains unknown");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    bail!("The installed guest runtime has not confirmed its serving executable/identity. Inspect the retained installation; no automatic reinstall was attempted")
}

fn serving_runtime_matches(env: &Environment, expected: &str, read: &Value) -> bool {
    read["protocol"] == 1
        && read["environmentId"] == env.id
        && read["generation"] == env.generation
        && read["runtime"]["identity"]["protocol"] == journal::PROTOCOL
        && read["runtime"]["identity"]["environmentId"] == env.id
        && read["runtime"]["identity"]["generation"] == env.generation
        && read["runtime"]["executableSha256"] == expected
        && read["runtime"]["bootIdentity"]
            .as_str()
            .is_some_and(|s| journal::validate_id(s).is_ok())
}
fn deletion_preview(journal: &Journal, env: &Environment) -> Value {
    let result = (|| -> Result<Value> {
        let state = journal.read()?;
        let tasks: Vec<&Task> = state
            .tasks
            .values()
            .filter(|t| t.target.environment_id == env.id)
            .collect();
        let active = tasks.iter().any(|t| !t.status.terminal());
        let provisioning = !provision_settled(env);
        let guest_work = guest_rpc(env, "environment.disposition", json!({}));
        let reason = if active {
            Some("Resolve/cancel all unfinished tasks before deletion".to_owned())
        } else if provisioning {
            Some("Reconcile provisioning before deletion".to_owned())
        } else if super::setup::busy(env) {
            Some(
                "Resolve guided setup and owned account/permission operations before deletion"
                    .to_owned(),
            )
        } else if env.manual_control {
            Some("Return manual desktop control before deletion".to_owned())
        } else {
            guest_work
                .as_ref()
                .map_err(|e| anyhow::anyhow!("Guest work inspection unavailable: {e:#}"))
                .and_then(|work| validate_deletion_work(env, &tasks, work))
                .err()
                .map(|e| e.to_string())
        };
        Ok(
            json!({"canDelete":reason.is_none(),"reason":reason,"tasks":tasks.iter().map(|t|json!({"target":t.target,"status":t.status,"workerSessionId":t.worker_session_id,"workerTabId":t.worker_tab_id,"providerConversationId":t.provider_conversation_id,"guestCwd":t.guest_cwd})).collect::<Vec<_>>(),"guestWork":guest_work.unwrap_or(json!({"available":false,"detail":"Guest work could not be inspected; no deletion is permitted"}))}),
        )
    })();
    result.unwrap_or_else(
        |e| json!({"canDelete":false,"reason":e.to_string(),"tasks":[],"guestWork":null}),
    )
}

pub(super) fn provision_settled(env: &Environment) -> bool {
    env.provision.is_none()
        || super::provisioning::adopted(env)
        || env.provision.as_ref().is_some_and(|p| {
            matches!(
                p["status"].as_str(),
                Some("completed" | "failed" | "canceled")
            )
        })
}

fn validate_deletion_work(env: &Environment, tasks: &[&Task], work: &Value) -> Result<()> {
    validate_quiescent_history(env, tasks, work, true)
}

// Runtime replacement preserves all retained data. It still requires fresh,
// complete matching history and an affirmative zero-owned-group observation.
// Destruction additionally requires the independent attempt/boot and inventory
// proofs below; a runtime update never creates deletion authorization.
pub(super) fn validate_quiescent_history(
    env: &Environment,
    tasks: &[&Task],
    work: &Value,
    deleting: bool,
) -> Result<()> {
    if env.manual_control || tasks.iter().any(|task| !task.status.terminal()) {
        bail!("Resolve host task and manual desktop holds before deletion");
    }
    if work["evidenceVersion"] != 1
        || work["complete"] != true
        || work["environmentId"] != env.id
        || work["generation"] != env.generation
        || work["manualControl"] != false
        || work["activeOwnedGroups"].as_u64() != Some(0)
    {
        bail!("Fresh complete bound guest quiescence/manual-control evidence is required before deletion");
    }
    let current_boot = field(work, "currentBootIdentity")?;
    journal::validate_id(current_boot)?;
    let guest_tasks = work["tasks"]
        .as_array()
        .context("Complete guest task history is missing")?;
    let canceled = work["canceledTargets"]
        .as_object()
        .context("Canceled target history is missing")?;
    if deleting
        && (work["retainedData"]["complete"] != true
            || work["retainedData"]["unaccountedData"] != false)
    {
        bail!("Unaccounted retained guest data or incomplete root/index inspection prevents deletion; inspect/export it explicitly");
    }
    if guest_tasks.is_empty() && canceled.is_empty() {
        super::provisioning::unused_guest(env, &work["unusedRuntimeProof"])?;
        let inventory = &work["retainedData"];
        if deleting
            && (inventory != &work["unusedRuntimeProof"]["retainedData"]
                || inventory["complete"] != true
                || inventory["sessionIndexHasData"] != false
                || ["workspaceEntries", "artifactEntries", "sessionEntries"]
                    .iter()
                    .any(|key| !inventory[key].as_array().is_some_and(Vec::is_empty)))
        {
            bail!("Unaccounted retained workspace, artifact or session data requires explicit inspection/export; empty task history cannot authorize deletion");
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    for guest in guest_tasks {
        let target: TaskTarget = serde_json::from_value(guest["target"].clone())?;
        if !seen.insert(target.task_id.clone()) {
            bail!("Duplicate guest task history");
        }
        let host = tasks
            .iter()
            .find(|t| t.target == target)
            .context("Guest task is absent from retained host history")?;
        if !host.status.terminal()
            || guest["status"] != serde_json::to_value(host.status)?
            || guest["inputDigest"] != host.input_digest
            || guest["guestCwd"] != host.guest_cwd
            || guest["workerSessionId"] != json!(host.worker_session_id)
            || guest["workerTabId"] != json!(host.worker_tab_id)
            || guest["providerConversationId"] != json!(host.provider_conversation_id)
            || !guest["lastEventSeq"]
                .as_u64()
                .is_some_and(|seq| seq >= host.last_event_seq)
        {
            bail!("Guest task identity, terminal state or retained history differs; deletion remains blocked");
        }
        if !guest["gitPorcelain"].is_string() || guest.get("detail") != Some(&Value::Null) {
            bail!("Guest workspace inspection failed; export or reconcile its retained data before deletion");
        }
        let events = guest["eventDigests"]
            .as_array()
            .context("Guest event history proof is missing")?;
        if events.len() as u64
            != guest["lastEventSeq"]
                .as_u64()
                .context("Guest history cursor missing")?
            || events
                .iter()
                .enumerate()
                .any(|(i, e)| e["seq"].as_u64() != Some(i as u64 + 1))
        {
            bail!("Guest history is incomplete or rolled back");
        }
        for event in &host.events {
            if events
                .get(event.seq.saturating_sub(1) as usize)
                .and_then(|e| e["digest"].as_str())
                != Some(journal::digest(&serde_json::to_vec(event)?).as_str())
            {
                bail!("Guest event history differs from retained host events; deletion remains blocked");
            }
        }
        let prior_boot = guest["bootIdentity"]
            .as_str()
            .context("Guest worker exit proof is missing")?;
        journal::validate_id(prior_boot)?;
        if deleting && prior_boot == current_boot && guest["canceledBeforeStart"] != true {
            bail!("Positive worker exit proof is unavailable for this attempt; terminal status alone does not permit deletion");
        }
    }
    for (id, value) in canceled {
        let target: TaskTarget = serde_json::from_value(value.clone())?;
        if target.task_id != *id
            || !seen.insert(id.clone())
            || !tasks.iter().any(|t| {
                t.target == target
                    && t.status == journal::TaskStatus::Canceled
                    && !t.dispatch_started
                    && t.worker_session_id.is_none()
                    && t.worker_tab_id.is_none()
                    && t.provider_conversation_id.is_none()
                    && t.last_event_seq == 0
                    && t.events.is_empty()
            })
        {
            bail!("A guest tombstone cannot replace a dispatched task record or erase retained worker/history evidence");
        }
    }
    if tasks
        .iter()
        .any(|t| t.dispatch_started && !seen.contains(&t.target.task_id))
    {
        bail!(
            "Dispatched host targets are missing from the guest history; deletion remains blocked"
        );
    }
    Ok(())
}
fn delete(journal: &Journal, params: &Value) -> Result<Value> {
    confirm(params)?;
    field(params, "generation")?;
    let env = environment(journal, params)?;
    let preview = deletion_preview(journal, &env);
    if preview.get("canDelete") != Some(&Value::Bool(true)) {
        bail!(
            "{}",
            preview
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("Inspect retained data before deletion")
        );
    }
    let state = journal.read()?;
    if state
        .tasks
        .values()
        .any(|t| t.target.environment_id == env.id && !t.status.terminal())
    {
        bail!("Resolve/cancel every affected task before deleting the VM. History is retained");
    }
    if state.environments.get(&env.id) != Some(&env)
        || !provision_settled(&env)
        || super::setup::busy(&env)
        || env.manual_control
    {
        bail!("Environment disposition changed; inspect again before deletion");
    }
    // The UI lists uncommitted work and resume metadata before this call.
    // Deletion never traverses a host checkout or removes its journal/artifacts.
    cua(
        &["sb", "rm", &env.sandbox, "--force"],
        b"",
        Duration::from_secs(180),
    )?;
    journal.transaction(|s| {
        s.environments.get_mut(&env.id).unwrap().deleted_at = Some(journal::now());
        Ok(())
    })?;
    Ok(json!({"deleted":true,"historyRetained":true}))
}

fn artifact(journal: &Journal, params: &Value) -> Result<Value> {
    let target: TaskTarget =
        serde_json::from_value(params.get("target").cloned().context("target required")?)?;
    let state = journal.read()?;
    let task = state
        .tasks
        .get(&target.task_id)
        .filter(|t| t.target == target)
        .context("Task binding mismatch")?;
    let artifact = task
        .artifacts
        .iter()
        .find(|a| a.id == field(params, "artifactId").unwrap_or_default())
        .context("Artifact unavailable")?;
    journal::validate_id(&artifact.id)?;
    let bytes = fs::read(
        root()?
            .join("artifacts")
            .join(&target.task_id)
            .join(&artifact.id),
    )
    .context("Artifact not retained locally; reconnect to the guest or check its expiration")?;
    if journal::digest(&bytes) != artifact.sha256 || bytes.len() as u64 != artifact.bytes {
        bail!("Artifact integrity check failed");
    }
    if let Ok(content) = std::str::from_utf8(&bytes) {
        Ok(json!({"name":artifact.name,"mediaType":artifact.media_type,"content":content}))
    } else {
        Ok(
            json!({"name":artifact.name,"mediaType":artifact.media_type,"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        )
    }
}
fn apply_patch(journal: &Journal, params: &Value) -> Result<Value> {
    confirm(params)?;
    let result = artifact(journal, params)?;
    if !matches!(
        result.get("mediaType").and_then(Value::as_str),
        Some("text/x-diff" | "text/x-patch")
    ) {
        bail!("Select a patch artifact");
    }
    let destination = Path::new(field(params, "destinationRoot")?);
    if !destination.is_absolute() {
        bail!("Select an absolute host checkout");
    }
    let destination = fs::canonicalize(destination)?;
    let top = process::run(
        std::process::Command::new("git")
            .arg("-C")
            .arg(&destination)
            .args(["rev-parse", "--show-toplevel"]),
        b"",
        BUDGET,
    )?;
    if fs::canonicalize(String::from_utf8(top)?.trim())? != destination {
        bail!("Select the repository root");
    }
    let bytes = field(&result, "content")?.as_bytes();
    let key = journal::digest(&serde_json::to_vec(&(
        params.get("target"),
        params.get("artifactId"),
        &destination,
        journal::digest(bytes),
    ))?);
    apply_patch_once(&root()?.join("imports"), &destination, bytes, &key)
}
fn apply_patch_once(receipts: &Path, destination: &Path, bytes: &[u8], key: &str) -> Result<Value> {
    journal::private_directory(receipts)?;
    let _lock = journal::Lock::acquire(&receipts.join(format!("{key}.lock")))?;
    let path = receipts.join(format!("{key}.json"));
    if path.exists() {
        let receipt: Value = serde_json::from_slice(&fs::read(&path)?)?;
        match receipt.get("status").and_then(Value::as_str){
            Some("applied")=>return Ok(json!({"applied":true,"conflicts":[],"detail":"This exact task artifact was previously imported here; it was not applied twice"})),
            Some("applying")=>bail!("Patch import outcome is unknown after interruption. Inspect the host checkout; this import was not replayed"),
            Some("conflict")=>{},
            _=>bail!("Invalid retained patch-import receipt; inspect it before retrying"),
        }
    }
    journal::atomic_private_write(
        &path,
        &serde_json::to_vec(&json!({"status":"applying","at":journal::now()}))?,
    )?;
    let result = apply_patch_bytes(destination, bytes)?;
    journal::atomic_private_write(
        &path,
        &serde_json::to_vec(
            &json!({"status":if result["applied"]==true{"applied"}else{"conflict"},"at":journal::now()}),
        )?,
    )?;
    Ok(result)
}
fn apply_patch_bytes(destination: &Path, bytes: &[u8]) -> Result<Value> {
    let command = || {
        let mut c = std::process::Command::new("git");
        c.arg("-C").arg(destination);
        c
    };
    if process::run(
        command().args(["apply", "--check", "--index", "-"]),
        bytes,
        BUDGET,
    )
    .is_err()
    {
        return Ok(
            json!({"applied":false,"conflicts":["Patch does not apply cleanly to the index and working tree"],"detail":"Host work was preserved. Resolve differences before applying."}),
        );
    }
    process::run(command().args(["apply", "--index", "-"]), bytes, BUDGET)?;
    Ok(
        json!({"applied":true,"conflicts":[],"detail":"Patch applied to the explicitly selected checkout and index"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_creation_refuses_unsupported_account_profile_before_reservation() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let before = journal.read().unwrap();
        let error = create(&journal, &json!({"name":"Guest","vmName":"new","harness":"codex","idempotencyKey":"new-account","confirm":true})).unwrap_err();
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert!(error.to_string().contains("secure first-account"), "{error:#}");
        }
        assert_eq!(serde_json::to_value(journal.read().unwrap()).unwrap(), serde_json::to_value(before).unwrap());
    }
    #[test]
    fn unsupported_guided_provider_is_refused_before_reserving_or_allocating_a_vm() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let error=create(&journal,&json!({"name":"Guest","vmName":"new","harness":"claude","idempotencyKey":"unsupported","confirm":true})).unwrap_err();
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert!(error
                .to_string()
                .contains("No machine or download was started"));
        }
        assert!(journal.read().unwrap().environments.is_empty());
    }
    #[test]
    fn create_reservation_is_atomic_keyed_and_retains_deleted_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let env = reserve_creation(&journal, "Guest", "local:new", "codex", "create-1").unwrap();
        assert!(env.owned);
        assert_eq!(env.provision.as_ref().unwrap()["status"], "queued");
        assert_eq!(env.setup.as_ref().unwrap()["idempotencyKey"], "create-1");
        assert_eq!(
            reserve_creation(&journal, "Guest", "local:new", "codex", "create-1").unwrap(),
            env
        );
        for (name, sandbox, harness) in [
            ("Other", "local:new", "codex"),
            ("Guest", "local:other", "codex"),
            ("Guest", "local:new", "claude"),
        ] {
            assert!(reserve_creation(&journal, name, sandbox, harness, "create-1").is_err());
        }
        journal
            .transaction(|state| {
                state.environments.get_mut(&env.id).unwrap().deleted_at = Some(journal::now());
                Ok(())
            })
            .unwrap();
        let prior = reserve_creation(&journal, "Guest", "local:new", "codex", "create-1").unwrap();
        assert_eq!(prior.id, env.id);
        assert!(prior.deleted_at.is_some());
        assert_eq!(journal.read().unwrap().environments.len(), 1);
        // Disabling fresh creation must still acknowledge an older exact
        // request, including a retained tombstone, without allocating again.
        let receipt = create(&journal, &json!({"name":"Guest","vmName":"new","harness":"codex","idempotencyKey":"create-1","confirm":true})).unwrap();
        assert_eq!(receipt, serde_json::to_value(prior).unwrap());
    }

    #[test]
    fn serving_runtime_ack_binds_loaded_executable_identity_and_boot() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let env = journal.enroll("Guest", "local:test").unwrap();
        let sha = "a".repeat(64);
        let read = json!({"protocol":1,"environmentId":env.id,"generation":env.generation,"runtime":{"identity":{"protocol":journal::PROTOCOL,"environmentId":env.id,"generation":env.generation},"executableSha256":sha,"bootIdentity":journal::new_id()}});
        assert!(serving_runtime_matches(&env, &sha, &read));
        for (path, value) in [
            ("/runtime/executableSha256", json!("b".repeat(64))),
            ("/runtime/bootIdentity", Value::Null),
            ("/runtime/identity/generation", json!(journal::new_id())),
            ("/environmentId", json!(journal::new_id())),
        ] {
            let mut changed = read.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert!(!serving_runtime_matches(&env, &sha, &changed), "{path}");
        }
    }
    #[test]
    fn deletion_requires_fresh_complete_bound_guest_history_and_positive_exit_proof() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let env = journal.enroll("Guest", "local:test").unwrap();
        let mut task = journal
            .submit(
                "retained-task",
                TaskInput {
                    parent_session_id: journal::new_id(),
                    parent_tab_id: journal::new_id(),
                    parent_message_id: "message".into(),
                    environment_id: env.id.clone(),
                    prompt: "Original".into(),
                    harness: "codex".into(),
                    model: "".into(),
                    effort: None,
                    permission_mode: "manual".into(),
                    files: vec![],
                    desktop: true,
                },
            )
            .unwrap();
        task.status = journal::TaskStatus::Completed;
        task.dispatch_started = true;
        task.last_event_seq = 1;
        task.events = vec![journal::TaskEvent {
            seq: 1,
            timestamp: journal::now(),
            payload: json!({"type":"taskSettled"}),
        }];
        let boot = journal::new_id();
        let work = json!({"evidenceVersion":1,"complete":true,"environmentId":env.id,"generation":env.generation,
            "retainedData":{"complete":true,"unaccountedData":false},
            "currentBootIdentity":boot,"manualControl":false,"activeOwnedGroups":0,"canceledTargets":{},
            "tasks":[{"target":task.target,"status":task.status,"inputDigest":task.input_digest,"guestCwd":task.guest_cwd,
                "workerSessionId":null,"workerTabId":null,"providerConversationId":null,"lastEventSeq":1,
                "eventDigests":[{"seq":1,"digest":journal::digest(&serde_json::to_vec(&task.events[0]).unwrap())}],
                "gitPorcelain":" M src/uncommitted.rs","detail":null,"bootIdentity":journal::new_id(),"canceledBeforeStart":false}]});
        assert!(validate_deletion_work(&env, &[&task], &work).is_ok());
        // A complete current manager observation permits preserving/updating
        // the runtime, while deletion still needs the stronger attempt proof.
        let mut same_boot = work.clone();
        same_boot["tasks"][0]["bootIdentity"] = json!(boot);
        assert!(validate_quiescent_history(&env, &[&task], &same_boot, false).is_ok());
        assert!(validate_deletion_work(&env, &[&task], &same_boot).is_err());
        same_boot["tasks"] = json!([]);
        assert!(validate_quiescent_history(&env, &[&task], &same_boot, false).is_err());
        for (path, value) in [
            ("/environmentId", json!(journal::new_id())),
            ("/generation", json!(journal::new_id())),
            ("/manualControl", json!(true)),
            ("/manualControl", Value::Null),
            ("/activeOwnedGroups", json!(1)),
            ("/complete", Value::Null),
            ("/tasks", json!([])),
            ("/tasks/0/status", json!("running")),
            ("/tasks/0/target/generation", json!(journal::new_id())),
            ("/tasks/0/gitPorcelain", Value::Null),
            ("/tasks/0/detail", json!("Workspace missing")),
            ("/tasks/0/lastEventSeq", json!(0)),
            ("/tasks/0/eventDigests/0/digest", json!("b".repeat(64))),
            ("/tasks/0/workerSessionId", json!(journal::new_id())),
            ("/tasks/0/bootIdentity", json!(boot)),
        ] {
            let mut changed = work.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert!(
                validate_deletion_work(&env, &[&task], &changed).is_err(),
                "{path}"
            );
        }
        assert!(validate_deletion_work(&env, &[&task], &json!({"ok":true})).is_err());
        assert!(validate_deletion_work(&env, &[], &work).is_err());
        // A newly minted absent-record cancellation must not stand in for a
        // dispatched terminal record, even if worker IDs/cursor were lost.
        task.status = journal::TaskStatus::Canceled;
        let mut tombstone = work.clone();
        tombstone["tasks"] = json!([]);
        tombstone["canceledTargets"] = json!({task.target.task_id.clone():task.target});
        assert!(validate_deletion_work(&env, &[&task], &tombstone).is_err());
        task.events.clear();
        task.last_event_seq = 0;
        assert!(validate_deletion_work(&env, &[&task], &tombstone).is_err());
        task.worker_session_id = Some(journal::new_id());
        task.worker_tab_id = Some(journal::new_id());
        task.provider_conversation_id = Some(journal::new_id());
        retain_cancellation(&mut task, &json!({"absent":true,"canceled":true}));
        assert_eq!(task.status, journal::TaskStatus::OutcomeUnknown);
        assert!(task.status.holds_desktop());
        assert!(task.worker_session_id.is_some() && task.provider_conversation_id.is_some());
    }

    #[test]
    fn deletion_of_empty_guest_requires_durable_unused_timeline_not_empty_or_missing_records() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let env = journal.enroll("Guest", "local:test").unwrap();
        let boot = journal::new_id();
        let mut work = json!({"evidenceVersion":1,"complete":true,"environmentId":env.id,"generation":env.generation,
            "currentBootIdentity":boot,"manualControl":false,"activeOwnedGroups":0,"tasks":[],"canceledTargets":{}});
        assert!(validate_deletion_work(&env, &[], &work).is_err());
        work["unusedRuntimeProof"] = json!({"evidenceVersion":1,"environmentId":env.id,"generation":env.generation,
            "currentBootIdentity":boot,"initializedTimeline":{"timelineId":journal::new_id(),"bootIdentity":boot,"noExecution":true},
            "noExecutionSinceInitialization":true,"manualControl":false,"activeOwnedGroups":0,"tasks":[],"canceledTargets":{},"historyDigest":"a".repeat(64)});
        let inventory = json!({"complete":true,"workspaceEntries":[],"artifactEntries":[],"sessionEntries":[],
            "sessionIndexHasData":false,"unaccountedData":false,"sessionIndexDigest":"c".repeat(64)});
        work["retainedData"] = inventory.clone();
        work["unusedRuntimeProof"]["retainedData"] = inventory;
        assert!(validate_deletion_work(&env, &[], &work).is_ok());
        for (key, value) in [
            ("workspaceEntries", json!(["unlisted-work"])),
            ("artifactEntries", json!(["orphan-artifacts"])),
            ("sessionEntries", json!(["orphan-session"])),
            ("sessionIndexHasData", json!(true)),
            ("complete", Value::Null),
        ] {
            let mut changed = work.clone();
            changed["retainedData"][key] = value.clone();
            changed["unusedRuntimeProof"]["retainedData"][key] = value;
            assert!(
                validate_deletion_work(&env, &[], &changed).is_err(),
                "{key}"
            );
        }
        let mut unknown = env;
        unknown.provision = Some(progress("outcomeUnknown", "Never cleared by guest ack"));
        assert!(!provision_settled(&unknown));
        unknown.provision = Some(progress("adopted", "Forged status without a receipt"));
        assert!(!provision_settled(&unknown));
    }
    #[test]
    fn manual_control_only_releases_on_a_durable_false_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let env = journal.enroll("Guest", "local:test").unwrap();
        manual_control_receipt(
            &journal,
            &env,
            &json!({"manualControl":true,"ready":false}),
            true,
        )
        .unwrap();
        assert!(journal.read().unwrap().environments[&env.id].manual_control);
        for response in [
            json!({}),
            json!({"released":true}),
            json!({"manualControl":true}),
            json!({"manualControl":"false"}),
        ] {
            assert!(manual_control_receipt(&journal, &env, &response, false).is_err());
            assert!(
                Journal::open(temp.path())
                    .unwrap()
                    .read()
                    .unwrap()
                    .environments[&env.id]
                    .manual_control
            );
        }
        manual_control_receipt(&journal, &env, &json!({"manualControl":false}), false).unwrap();
        assert!(!journal.read().unwrap().environments[&env.id].manual_control);
        journal
            .transaction(|state| {
                let current = state.environments.get_mut(&env.id).unwrap();
                current.generation = journal::new_id();
                current.manual_control = true;
                Ok(())
            })
            .unwrap();
        assert!(
            manual_control_receipt(&journal, &env, &json!({"manualControl":false}), false).is_err()
        );
        assert!(journal.read().unwrap().environments[&env.id].manual_control);
    }

    #[test]
    fn recovery_receipts_preserve_full_task_and_provider_binding() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let env = journal.enroll("Guest", "local:test").unwrap();
        let mut task = journal
            .submit(
                "original-task",
                TaskInput {
                    parent_session_id: journal::new_id(),
                    parent_tab_id: journal::new_id(),
                    parent_message_id: journal::new_id(),
                    environment_id: env.id,
                    prompt: "Original task prompt".into(),
                    harness: "codex".into(),
                    model: "".into(),
                    effort: None,
                    permission_mode: "manual".into(),
                    files: vec![],
                    desktop: true,
                },
            )
            .unwrap();
        task.worker_session_id = Some(journal::new_id());
        task.worker_tab_id = Some(journal::new_id());
        task.provider_conversation_id = Some(journal::new_id());
        task.status = journal::TaskStatus::OutcomeUnknown;
        let mut response = serde_json::to_value(&task).unwrap();
        response["status"] = json!("starting");
        response["lastEventSeq"] = json!(1);
        response["events"] = json!([{"seq":1,"timestamp":journal::now(),"payload":{"type":"taskRecovered","idempotencyKey":"new-human-input"}}]);
        assert_eq!(
            recovery_receipt(&task, &response).unwrap().status,
            journal::TaskStatus::Starting
        );
        for field in [
            "idempotencyKey",
            "inputDigest",
            "guestCwd",
            "workerSessionId",
            "workerTabId",
            "providerConversationId",
        ] {
            let mut changed = response.clone();
            changed[field] = json!("different-binding");
            assert!(recovery_receipt(&task, &changed).is_err(), "{field}");
        }
        for field in ["environmentId", "generation", "workspaceId", "taskId"] {
            let mut changed = response.clone();
            changed["target"][field] = json!(journal::new_id());
            assert!(recovery_receipt(&task, &changed).is_err(), "{field}");
        }
        for (field, value) in [
            ("prompt", json!("replayed prompt")),
            ("harness", json!("claude")),
            ("model", json!("substitute-model")),
            ("effort", json!("high")),
            ("permissionMode", json!("bypassPermissions")),
        ] {
            let mut changed = response.clone();
            changed["input"][field] = value;
            assert!(recovery_receipt(&task, &changed).is_err(), "{field}");
        }
        // The RPC acknowledgement is validated here; its events are retained
        // only through the supervisor's contiguous polling path.
        assert!(journal.read().unwrap().tasks[&task.target.task_id]
            .events
            .is_empty());
    }

    #[test]
    fn real_git_patch_import_preserves_dirty_host_work() {
        let temp = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(temp.path())
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            out.stdout
        };
        git(&["init", "--quiet"]);
        fs::write(temp.path().join("selected"), b"before\n").unwrap();
        git(&["add", "selected"]);
        fs::write(temp.path().join("selected"), b"after\n").unwrap();
        let patch = git(&["diff", "--binary", "--", "selected"]);
        fs::write(temp.path().join("selected"), b"host edits\n").unwrap();
        assert_eq!(
            apply_patch_bytes(temp.path(), &patch).unwrap()["applied"],
            false
        );
        assert_eq!(
            fs::read(temp.path().join("selected")).unwrap(),
            b"host edits\n"
        );
        fs::write(temp.path().join("selected"), b"before\n").unwrap();
        // Restoring bytes can leave Git's stat cache racily dirty. Establish
        // the intended clean-index fixture without staging different content.
        git(&["update-index", "--refresh"]);
        let receipts = tempfile::tempdir().unwrap();
        assert_eq!(
            apply_patch_once(receipts.path(), temp.path(), &patch, "test-import").unwrap()
                ["applied"],
            true
        );
        assert_eq!(
            apply_patch_once(receipts.path(), temp.path(), &patch, "test-import").unwrap()
                ["applied"],
            true
        );
        assert_eq!(fs::read(temp.path().join("selected")).unwrap(), b"after\n");
    }
    #[test]
    fn real_files_require_approved_bytes_and_reject_symlink_escape() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("selected"), b"a").unwrap();
        let mut item = journal::InputFile {
            path: "selected".into(),
            sha256: journal::digest(b"a"),
            bytes: 1,
        };
        assert_eq!(
            export_files(temp.path(), &[item.clone()])
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        fs::write(temp.path().join("selected"), b"b").unwrap();
        assert!(export_files(temp.path(), &[item.clone()]).is_err());
        fs::write(outside.path().join("secret"), b"a").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), temp.path().join("escape"))
            .unwrap();
        item.path = "escape".into();
        assert!(export_files(temp.path(), &[item]).is_err());
    }
}
