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
        json!({"compatible":compatibility.is_ok(),"reason":compatibility.err().map(|e|crate::remote::protocol::redact(&format!("{e:#}"))),"runtime":runtime,"resources":resources()?,"freeDiskBytes":available_disk(&home)?,"profile":{"image":IMAGE,"downloadBytes":DOWNLOAD_BYTES,"cpu":4,"memoryBytes":8_589_934_592_u64,"diskLimitBytes":161_061_273_600_u64,"storage":home.join(".lume"),"cache":home.join(".cua"),"minimumFreeDiskBytes":53_687_091_200_u64},"releaseGatesVerified":false}),
    )
}
pub fn progress(status: &str, detail: &str) -> Value {
    json!({"status":status,"detail":detail,"stages":[{"id":"provision","label":"Create macOS guest","status":status,"detail":detail}]})
}
fn create(journal: &Journal, params: &Value) -> Result<Value> {
    confirm(params)?;
    compatible()?;
    let name = field(params, "name")?;
    let vm_name = field(params, "vmName")?;
    let sandbox = format!("local:{vm_name}");
    journal::validate_sandbox(&sandbox)?;
    if let Some(existing) = journal
        .read()?
        .environments
        .values()
        .find(|e| e.sandbox == sandbox && e.deleted_at.is_none())
    {
        if existing.owned && existing.name == name {
            return Ok(serde_json::to_value(existing)?);
        }
        bail!("This VM identity is already enrolled");
    }
    let inventory: Value =
        serde_json::from_slice(&cua(&["sb", "ls", "--local", "--json"], b"", BUDGET)?)?;
    if inventory
        .as_array()
        .context("Invalid VM inventory")?
        .iter()
        .any(|vm| vm.get("id").and_then(Value::as_str) == Some(&sandbox))
    {
        bail!("This VM already exists; enroll it explicitly instead");
    }
    if available_disk(&dirs::home_dir().context("Home directory unavailable")?)?
        < 50 * 1024 * 1024 * 1024
    {
        bail!("At least 50 GiB free disk is required before project/toolchain growth");
    }
    if inventory
        .as_array()
        .unwrap()
        .iter()
        .filter(|vm| {
            vm.get("runtime").and_then(Value::as_str) == Some("lume")
                && vm.get("state").and_then(Value::as_str) == Some("running")
        })
        .count()
        >= 2
    {
        bail!("Two local macOS VMs are already running; stop one explicitly before provisioning");
    }
    let resources = resources()?;
    if resources["virtualizationAvailable"] != true
        || resources["memoryBytes"].as_u64().unwrap_or(0) < 16 * 1024 * 1024 * 1024
        || resources["availableMemoryBytes"].as_u64().unwrap_or(0) < 8 * 1024 * 1024 * 1024
    {
        bail!("Virtualization and at least 8 GiB currently available memory (16 GiB total) are required, leaving resources for this Mac");
    }
    let env = journal.enroll(name, &sandbox)?;
    journal.transaction(|s| {
        let e = s.environments.get_mut(&env.id).unwrap();
        e.owned = true;
        e.provision = Some(progress("queued", "Waiting for the local supervisor"));
        Ok(())
    })?;
    Ok(serde_json::to_value(
        journal.read()?.environments[&env.id].clone(),
    )?)
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

fn install_guest(env: &Environment, runtime: &Path) -> Result<()> {
    compatible()?;
    if !runtime.is_absolute() || !runtime.is_file() {
        bail!("Select a macOS arm64 runtime binary");
    }
    if journal()?
        .read()?
        .tasks
        .values()
        .any(|t| t.target.environment_id == env.id && t.status.holds_desktop())
    {
        bail!("Stop active tasks before changing the guest runtime");
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
    let script=format!("set -eu; cd '{GUEST_HOME}/bin'; test \"$(shasum -a 256 terminalx-serve.new | cut -d ' ' -f1)\" = '{checksum}'; chmod 700 '{GUEST_HOME}' '{GUEST_HOME}/runtime'; chmod 600 '{GUEST_HOME}/identity.json'; chmod 755 terminalx-serve.new; mv terminalx-serve.new terminalx-serve; launchctl bootout gui/$(id -u)/com.terminalx.local-guest 2>/dev/null || true; launchctl bootstrap gui/$(id -u) /Users/lume/Library/LaunchAgents/com.terminalx.local-guest.plist");
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

fn provision_settled(env: &Environment) -> bool {
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
    if work["retainedData"]["complete"] != true || work["retainedData"]["unaccountedData"] != false
    {
        bail!("Unaccounted retained guest data or incomplete root/index inspection prevents deletion; inspect/export it explicitly");
    }
    if guest_tasks.is_empty() && canceled.is_empty() {
        super::provisioning::unused_guest(env, &work["unusedRuntimeProof"])?;
        let inventory = &work["retainedData"];
        if inventory != &work["unusedRuntimeProof"]["retainedData"]
            || inventory["complete"] != true
            || inventory["sessionIndexHasData"] != false
            || ["workspaceEntries", "artifactEntries", "sessionEntries"]
                .iter()
                .any(|key| !inventory[key].as_array().is_some_and(Vec::is_empty))
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
        if prior_boot == current_boot && guest["canceledBeforeStart"] != true {
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
