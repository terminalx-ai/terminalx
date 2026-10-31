//! VM journal/provision/poll work hosted by the persistent local owner.
//! This module owns no host provider processes or second host LaunchAgent; the
//! separately installed guest runtime retains its own lifecycle and identity.
use super::host;
use super::journal::{self, Environment, Journal, Task, TaskStatus};
use super::process;
use crate::local_runtime::Lifetime;
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock, RwLockReadGuard, RwLockWriteGuard,
};
use std::time::Duration;

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn plist(label: &str, args: &[String], environment: &[(&str, String)], log: &str) -> String {
    let arguments = args
        .iter()
        .map(|s| format!("<string>{}</string>", xml(s)))
        .collect::<String>();
    let variables = environment
        .iter()
        .map(|(k, v)| format!("<key>{}</key><string>{}</string>", xml(k), xml(v)))
        .collect::<String>();
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array>{arguments}</array><key>EnvironmentVariables</key><dict>{variables}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",xml(label),xml(log),xml(log))
}
pub fn guest_plist(env: &Environment) -> Result<String> {
    env.transport.require_macos()?;
    if env.transport.is_personalized() { super::macos_transport::binding(env)?; }
    let install = env.transport.installation()?;
    let home = Path::new(&install).parent().context("Guest account home missing")?.to_string_lossy();
    Ok(plist("com.terminalx.local-guest",&[format!("{install}/bin/terminalx-serve"),"--data-dir".into(),format!("{install}/runtime")],&[
        ("TERMINALX_LOCAL_DESKTOP","0".into()),("TERMINALX_LOCAL_VM_ENVIRONMENT_ID",env.id.clone()),("TERMINALX_LOCAL_VM_GENERATION",env.generation.clone()),
        ("PATH",format!("{install}/bin:{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")),
    ],&format!("{install}/runtime/guest.log")))
}

/// Called only after the selected guest's worker/setup quiescence is verified.
/// Positional arguments are the exact agent label and already verified plist.
pub(super) const RELOAD_GUEST_AGENT: &str = r#"
set -eu
domain="gui/$(/usr/bin/id -u)"
service="$domain/$1"
# bootout acknowledges the request before a slow process has left launchd.
# Keep the old service's identity until it is absent; never retry bootstrap.
/bin/launchctl print "$domain" >/dev/null
if /bin/launchctl print "$service" >/dev/null 2>&1; then
    /bin/launchctl bootout "$service"
fi
attempts=0
while /bin/launchctl print "$service" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 100 ]; then
        echo 'Guest runtime service is still exiting; no replacement was started' >&2
        exit 1
    fi
    /bin/sleep 0.1
done
/bin/launchctl bootstrap "$domain" "$2"
"#;
static ADMISSION: RwLock<()> = RwLock::new(());
static STOPPING: AtomicBool = AtomicBool::new(false);
pub(crate) fn stopping() -> bool {
    STOPPING.load(Ordering::Acquire)
}
static JOURNAL_ROOT: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

/// All window mutations use the pinned owner. Recheck stop after admission,
/// including calls that entered the owner's request gate before stop committed.
pub fn admit(lifetime: &Lifetime) -> Result<RwLockReadGuard<'static, ()>> {
    let guard = ADMISSION.read().unwrap();
    if lifetime.is_stopping() || stopping() {
        bail!("The local owner is stopping; no VM operation was routed");
    }
    Ok(guard)
}

/// Selected at the owner route instead of a shared guard, never upgraded from
/// one. Keep through fresh probes and the durable disposition/deletion write.
pub fn admit_exclusive(lifetime: &Lifetime) -> Result<RwLockWriteGuard<'static, ()>> {
    let guard = ADMISSION.try_write().map_err(|_| {
        anyhow::anyhow!("A Local VM operation is in flight; wait for it and inspect again")
    })?;
    if lifetime.is_stopping() || stopping() {
        bail!("The local owner is stopping; no VM operation was routed");
    }
    Ok(guard)
}

pub(crate) fn initialized(root: &Path) -> bool {
    JOURNAL_ROOT.lock().unwrap().as_deref() == Some(root)
}

pub(super) fn state_busy(state: &journal::State) -> bool {
    state.tasks.values().any(|task| !task.status.terminal())
        || state
            .environments
            .values()
            .filter(|env| env.deleted_at.is_none())
            .any(|env| {
                env.manual_control
                    || super::setup::busy(env)
                    || env.provision.as_ref().is_some_and(|provision| {
                        if super::provisioning::adopted(env) {
                            return false;
                        }
                        !provision
                            .get("status")
                            .and_then(Value::as_str)
                            .is_some_and(|status| {
                                matches!(status, "completed" | "failed" | "canceled")
                            })
                    })
            })
}

fn journal_busy(root: &Path, initialized: bool) -> Result<bool> {
    if super::admission::has_reservations(root)? { return Ok(true); }
    if !root.join("journal.json").try_exists()? {
        return Ok(initialized);
    }
    Ok(state_busy(&Journal::open_existing(root)?.read()?))
}

pub fn has_work() -> bool {
    let result = (|| -> Result<bool> {
        let root = host::root()?;
        let initialized = initialized(&root);
        journal_busy(&root, initialized)
    })();
    result.unwrap_or(true)
}

/// A stop acknowledgement must not imply that independent guest actors stopped.
/// Hold the exclusive admission fence through the owner's stop commit.
pub fn prepare_stop() -> Result<RwLockWriteGuard<'static, ()>> {
    let guard = ADMISSION.try_write().map_err(|_| anyhow::anyhow!("A Local VM operation is in flight; Stop all was refused before changing owner state. Wait for it or request task/provision cancellation, then retry."))?;
    if has_work() {
        super::owner_shutdown::verify(&Journal::open_existing(&host::root()?)?)?;
    }
    Ok(guard)
}

pub struct Supervisor {
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Supervisor {
    pub fn start(lifetime: Arc<Lifetime>) -> Result<Self> {
        // Capture the serving owner's bytes before advertising setup support.
        // A later replacement at the same path cannot change this identity.
        super::bootstrap::owner_runtime_sha256()?;
        let root = host::root()?;
        journal::private_directory(&root)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("supervisor.lock"))?;
        // SAFETY: lock owns the descriptor for the entire supervisor lifetime.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("A supervisor already owns this environment journal");
        }
        let retained = root.join("health.json").try_exists()?
            || root.join("inputs").try_exists()?
            || root.join("artifacts").try_exists()?;
        let journal = if retained {
            Journal::open_existing(&root)?
        } else {
            host::journal()?
        };
        journal.transaction(|s|{
        for env in s.environments.values_mut(){
            if let Some(setup)=env.setup.as_mut() {
                if setup["status"]=="working" {
                    setup["status"]=json!("outcomeUnknown");
                    setup["detail"]=json!("The owner restarted during setup. Inspect the existing guest; installers and account/permission requests were not replayed.");
                    if let Some(steps)=setup["steps"].as_array_mut() { for step in steps {if step["state"]=="working" {step["state"]=json!("unknown");}} }
                    if setup["action"]["status"]=="working" {setup["action"]["status"]=json!("outcomeUnknown");}
                    if let Some(ops)=setup["operations"].as_object_mut() {for op in ops.values_mut() {
                        if op["receipt"]["status"]=="working" {op["receipt"]["status"]=json!("outcomeUnknown");}
                    }}
                }
            }
            if env.provision.as_ref().and_then(|p|p.get("status")).and_then(Value::as_str).is_some_and(|p|matches!(p,"running"|"canceling")) {
                env.provision=Some(host::progress("outcomeUnknown","The supervisor restarted during provisioning. Inspect the existing VM and cache; creation was not replayed."));
            }
        }
        Ok(())
    })?;
        *JOURNAL_ROOT.lock().unwrap() = Some(root.clone());
        let journal = Journal::open_existing(&root)?;
        STOPPING.store(false, Ordering::Release);
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let diagnostic = Arc::new(std::sync::Mutex::new(None::<String>));
        let heartbeat_diagnostic = diagnostic.clone();
        let heartbeat_root = root.clone();
        let heartbeat_stopped = stopped.clone();
        let heartbeat = std::thread::Builder::new().name("local-vm-heartbeat".into()).spawn(move || {
        while !heartbeat_stopped.load(Ordering::Acquire) {
            let detail=heartbeat_diagnostic.lock().unwrap().clone();
            let health=json!({"at":journal::now(),"pid":std::process::id(),"protocol":journal::PROTOCOL,"healthy":detail.is_none(),"detail":detail,"owner":"local-runtime"});
            if let Ok(bytes)=serde_json::to_vec(&health){let _=journal::atomic_private_write(&heartbeat_root.join("health.json"),&bytes);}
            std::thread::sleep(Duration::from_secs(1));
        }
    })?;
        let spawned = std::thread::Builder::new().name("local-vm-controller".into()).spawn(move || {
        let _lock = lock;
        let mut assertion: Option<Child> = None;
        while !worker_stopped.load(Ordering::Acquire) && !lifetime.is_stopping() {
            let Ok(request) = lifetime.enter() else {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            };
            let Ok(admission) = admit(&lifetime) else { break; };
            let outcome = tick(&journal, &worker_stopped);
            *diagnostic.lock().unwrap() = outcome.err().map(|e| crate::remote::protocol::redact(&e.to_string()));
            let working = journal.read().is_ok_and(|state| state.tasks.values().any(|t| {
                matches!(t.status, TaskStatus::Starting | TaskStatus::Running | TaskStatus::Canceling)
                    && state.environments.get(&t.target.environment_id).is_some_and(|e| e.keep_awake)
            }));
            if working && assertion.is_none() {
                // Idle system sleep only; screen locking/display sleep remain available.
                assertion = Command::new("/usr/bin/caffeinate").args(["-i", "-w", &std::process::id().to_string()])
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok();
            }
            if !working { if let Some(mut child)=assertion.take() {let _=child.kill(); let _=child.wait();} }
            drop(admission);
            drop(request);
            for _ in 0..30 {
                if worker_stopped.load(Ordering::Acquire) || lifetime.is_stopping() { break; }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if let Some(mut child)=assertion.take() {let _=child.kill(); let _=child.wait();}
        worker_stopped.store(true, Ordering::Release);
        let _ = heartbeat.join();
        let _=journal::atomic_private_write(&root.join("health.json"), &serde_json::to_vec(&json!({"at":null,"detail":"Local owner stopped; guest execution state must be reconciled on reconnect"})).unwrap());
    });
        match spawned {
            Ok(worker) => Ok(Self {
                stopped,
                worker: Some(worker),
            }),
            Err(error) => {
                stopped.store(true, Ordering::Release);
                Err(error.into())
            }
        }
    }

    pub fn shutdown(&mut self) {
        STOPPING.store(true, Ordering::Release);
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
            if let Ok(journal) = host::journal() {
                if let Err(error)=journal.transaction(|state| {
                    for task in state.tasks.values_mut().filter(|task| task.dispatch_started && !task.status.terminal()) {
                        task.status=TaskStatus::OutcomeUnknown;
                        task.detail=Some("Host owner stopped; guest execution outcome is unconfirmed. No prompt was replayed.".into());
                        task.updated_at=journal::now();
                    }
                    Ok(())
                }) {log::warn!("retain VM owner-stop uncertainty: {error:#}");}
            }
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn tick(journal: &Journal, stopped: &AtomicBool) -> Result<()> {
    let state = journal.read()?;
    for env in state
        .environments
        .values()
        .filter(|e| e.deleted_at.is_none())
    {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        if super::creation::hold_queued(journal, env)? {
            continue;
        }
        if env.setup.is_some() {
            if let Err(error) = super::setup::advance(journal, env) {
                super::setup::interrupted(journal, env, &error)?;
                continue;
            }
        }
        let provision = env
            .provision
            .as_ref()
            .and_then(|p| p.get("status"))
            .and_then(Value::as_str);
        if provision == Some("queued") {
            if env.setup.is_some()
                && journal.read()?.environments[&env.id]
                    .setup
                    .as_ref()
                    .is_some_and(|s| s["status"] == "outcomeUnknown")
            {
                continue;
            }
            ensure_running(stopped)?;
            provision_vm(journal, env, stopped)?;
        }
        let state = journal.read()?;
        if env.manual_control
            || state
                .tasks
                .values()
                .any(|t| t.target.environment_id == env.id && !t.status.terminal())
        {
            ensure_running(stopped)?;
            if let Ok(response) = host::guest_rpc(env, "desktop.state", json!({})) {
                host::record_manual_control(journal, env, &response)?;
            }
        }
        let mut tasks: Vec<Task> = state
            .tasks
            .values()
            .filter(|t| t.target.environment_id == env.id && !t.status.terminal())
            .cloned()
            .collect();
        tasks.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then(a.target.task_id.cmp(&b.target.task_id))
        });
        for task in tasks {
            if stopped.load(Ordering::Acquire) {
                break;
            }
            if task.status == TaskStatus::Queued {
                if !state.enabled {
                    continue;
                }
                if journal.claim(&task.target).is_err() {
                    continue;
                }
            }
            if let Err(error) = advance(journal, env, &task, stopped) {
                journal.transaction(|s| {
                    let t = journal::bound(s, &task.target)?;
                    if t.status.terminal() {
                        return Ok(());
                    }
                    t.detail = Some(crate::remote::protocol::redact(&error.to_string()));
                    t.status = if t.dispatch_started
                        || t.worker_session_id.is_some()
                        || t.status == TaskStatus::Running
                    {
                        TaskStatus::OutcomeUnknown
                    } else {
                        TaskStatus::Waiting
                    };
                    t.updated_at = journal::now();
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}
fn claim_provision(journal: &Journal, env: &Environment) -> Result<bool> {
    if super::creation::hold_queued(journal, env)? {
        return Ok(false);
    }
    journal.transaction(|state| {
        let current=state.environments.get_mut(&env.id).filter(|current|current.generation==env.generation && current.deleted_at.is_none()).context("Environment timeline changed")?;
        if current.provision.as_ref().and_then(|p|p.get("status")).and_then(Value::as_str)!=Some("queued") {return Ok(false);}
        super::creation::require_supported()?;
        current.provision=Some(host::progress("running","Downloading/checking the pinned image and starting macOS. Cancellation retains partial storage."));
        Ok(true)
    })
}

struct ProvisionChild(std::process::Child);
impl Drop for ProvisionChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn watch_provision(
    mut child: ProvisionChild,
    journal: &Journal,
    env: &Environment,
    stopped: &AtomicBool,
) -> Result<&'static str> {
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.0.try_wait()? {
            return Ok(if status.success() {
                "completed"
            } else {
                "failed"
            });
        }
        let state = journal.read()?;
        let cancel = state
            .environments
            .get(&env.id)
            .and_then(|env| env.provision.as_ref())
            .and_then(|p| p.get("status"))
            .and_then(Value::as_str)
            == Some("canceling");
        if stopped.load(Ordering::Acquire)
            || cancel
            || started.elapsed() > Duration::from_secs(7200)
        {
            return Ok("outcomeUnknown");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn provision_vm(journal: &Journal, env: &Environment, stopped: &AtomicBool) -> Result<()> {
    ensure_running(stopped)?;
    if !claim_provision(journal, env)? {
        return Ok(());
    }
    let outcome = (|| -> Result<&str> {
        ensure_running(stopped)?;
        let mut command = process::command("cua")?;
        command
            .args([
                "sb",
                "create",
                host::IMAGE,
                "--on",
                "local",
                "--kind",
                "vm",
                "--runtime",
                "lume",
                "--name",
                env.sandbox.trim_start_matches("local:"),
                "--cpu",
                "4",
                "--memory",
                "8GB",
                "--keep-on-failure",
                "--json",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let inventory: Value = serde_json::from_slice(&host::cua(
            &["sb", "ls", "--local", "--json"],
            b"",
            Duration::from_secs(45),
        )?)?;
        let entries = inventory
            .as_array()
            .context("Invalid VM inventory; creation was not sent")?;
        if entries.iter().any(|vm| vm["id"] == env.sandbox) {
            bail!("This VM already exists. Creation was not sent; enroll/inspect it explicitly instead");
        }
        if entries
            .iter()
            .filter(|vm| vm["runtime"] == "lume" && vm["state"] == "running")
            .count()
            >= 2
        {
            bail!("Two local macOS VMs are already running; no creation was sent");
        }
        ensure_running(stopped)?;
        let child = command.spawn()?;
        watch_provision(ProvisionChild(child), journal, env, stopped)
    })();
    let status = outcome.as_ref().copied().unwrap_or("outcomeUnknown");
    // A failed journal write preserves the prior running marker. On reconnect
    // it is reconciled as unknown; no raw child handle escapes on any path.
    journal.transaction(|state| {state.environments.get_mut(&env.id).context("Environment missing")?.provision=Some(host::progress(status,"Inspect retained VM/image storage. A stopped Cua client is not proof of VM cancellation."));Ok(())})?;
    outcome.map(|_| ())
}
fn ensure_running(stopped: &AtomicBool) -> Result<()> {
    if stopped.load(Ordering::Acquire) {
        bail!(
            "Local owner shutdown interrupted VM orchestration; external outcomes remain unknown"
        );
    }
    Ok(())
}

fn advance(journal: &Journal, env: &Environment, task: &Task, stopped: &AtomicBool) -> Result<()> {
    ensure_running(stopped)?;
    let result = if !task.dispatch_started {
        let description = host::guest_rpc(env, "describe", json!({}))?;
        if !description
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|c| c == if task.input.desktop { "task.submit" } else { "task.submitShell" }))
        {
            bail!(
                "{}",
                description
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Guest desktop/provider/runtime unavailable; complete guest setup")
            );
        }
        let files: Value = serde_json::from_slice(
            &fs::read(
                host::root()?
                    .join("inputs")
                    .join(format!("{}.json", task.target.task_id)),
            )
            .context(
                "Approved input snapshot unavailable; review and resubmit with the same key",
            )?,
        )?;
        ensure_running(stopped)?;
        let dispatch = journal.transaction(|s| {
            let t = journal::bound(s, &task.target)?;
            if t.status.terminal() {
                bail!("Task was canceled before guest dispatch");
            }
            t.dispatch_started = true;
            Ok(t.clone())
        })?;
        ensure_running(stopped)?;
        host::guest_rpc(env, "task.start", json!({"task":dispatch,"files":files}))?
    } else {
        ensure_running(stopped)?;
        host::guest_rpc(
            env,
            "task.poll",
            json!({"target":task.target,"after":task.last_event_seq}),
        )?
    };
    let guest: Task = serde_json::from_value(result).context("Guest task protocol mismatch")?;
    if guest.computer != task.computer
        || guest.transport_binding != task.transport_binding
        || guest.target != task.target
        || guest.input != task.input
        || guest.idempotency_key != task.idempotency_key
        || guest.input_digest != task.input_digest
    {
        bail!("Guest task identity changed; possible snapshot rollback. No prompt was replayed");
    }
    for event in &guest.events {
        journal.append(&task.target, event.clone())?;
    }
    let seq = journal.read()?.tasks[&task.target.task_id].last_event_seq;
    if seq != guest.last_event_seq {
        bail!("Guest event cursor mismatch; reconcile history before continuing");
    }
    // Retain evidence before terminal state allows the next workflow to run.
    for artifact in &guest.artifacts {
        ensure_running(stopped)?;
        journal::validate_id(&artifact.id)?;
        let directory = host::root()?.join("artifacts").join(&task.target.task_id);
        journal::private_directory(&directory)?;
        let path = directory.join(&artifact.id);
        if path.exists() {
            continue;
        }
        let response = host::guest_rpc(
            env,
            "task.artifact",
            json!({"target":task.target,"artifactId":artifact.id}),
        )?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(host::field(&response, "contentBase64")?)?;
        if bytes.len() as u64 != artifact.bytes || journal::digest(&bytes) != artifact.sha256 {
            bail!("Guest artifact integrity mismatch");
        }
        journal::atomic_private_write(&path, &bytes)?;
    }
    journal.transaction(|s| {
        let t = journal::bound(s, &task.target)?;
        if t.status.terminal() {
            return Ok(());
        }
        t.worker_session_id = guest.worker_session_id;
        t.worker_tab_id = guest.worker_tab_id;
        t.provider_conversation_id = guest.provider_conversation_id;
        t.status = guest.status;
        t.artifacts = guest.artifacts;
        t.outcome = guest.outcome;
        t.detail = guest.detail;
        t.updated_at = journal::now();
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_queued_creation_cannot_claim_an_unsupported_account_profile() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let env = journal.enroll("queued", "local:test").unwrap();
        journal.transaction(|state| {
            let env = state.environments.get_mut(&env.id).unwrap();
            env.owned = true;
            env.provision = Some(json!({"status":"queued"}));
            env.setup = Some(super::super::setup::initial(env, "codex", "retained-key")?);
            Ok(())
        }).unwrap();
        let env = journal.read().unwrap().environments[&env.id].clone();
        assert!(!claim_provision(&journal, &env).unwrap());
        let retained = journal.read().unwrap().environments[&env.id].clone();
        assert_eq!(retained.generation, env.generation);
        assert_eq!(retained.setup.as_ref().unwrap()["idempotencyKey"], "retained-key");
        assert_eq!(retained.provision.as_ref().unwrap()["status"], "failed");
        let refusal = &retained.provision.as_ref().unwrap()["creationRefusal"];
        assert_eq!(refusal["environmentId"], env.id);
        assert_eq!(refusal["generation"], env.generation);
        assert_eq!(refusal["originalSetup"], json!(env.setup));
        assert_eq!(refusal["originalProvision"], json!(env.provision));
        let reopened = Journal::open_existing(dir.path()).unwrap();
        let before = serde_json::to_value(reopened.read().unwrap()).unwrap();
        tick(&reopened, &AtomicBool::new(false)).unwrap();
        super::super::setup::advance(&reopened, &env).unwrap();
        let request = json!({"environmentId":env.id,"generation":env.generation,"harness":"codex","idempotencyKey":"retained-key","confirm":true});
        assert_eq!(super::super::setup::queue(&reopened, request.clone()).unwrap(), json!(retained.setup));
        let mut changed = request;
        changed["idempotencyKey"] = json!("retry-with-new-key");
        assert!(super::super::setup::queue(&reopened, changed).is_err());
        assert_eq!(serde_json::to_value(reopened.read().unwrap()).unwrap(), before);
    }
    #[test]
    fn queued_cancellation_cannot_be_overwritten_by_a_stale_provision_claim() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let env = journal.enroll("queued", "local:test").unwrap();
        journal
            .transaction(|state| {
                state.environments.get_mut(&env.id).unwrap().provision =
                    Some(json!({"status":"queued"}));
                Ok(())
            })
            .unwrap();
        host::cancel_provision(&journal, &env).unwrap();
        assert!(!claim_provision(&journal, &env).unwrap());
        let state = journal.read().unwrap();
        assert_eq!(
            state.environments[&env.id].provision.as_ref().unwrap()["status"],
            "canceled"
        );
        assert!(!state_busy(&state));
        journal
            .transaction(|state| {
                state.environments.get_mut(&env.id).unwrap().provision =
                    Some(json!({"status":"running"}));
                Ok(())
            })
            .unwrap();
        host::cancel_provision(&journal, &env).unwrap();
        assert_eq!(
            journal.read().unwrap().environments[&env.id]
                .provision
                .as_ref()
                .unwrap()["status"],
            "canceling"
        );
        journal
            .transaction(|state| {
                state.environments.get_mut(&env.id).unwrap().provision =
                    Some(json!({"status":"outcomeUnknown"}));
                Ok(())
            })
            .unwrap();
        host::cancel_provision(&journal, &env).unwrap();
        assert_eq!(
            journal.read().unwrap().environments[&env.id]
                .provision
                .as_ref()
                .unwrap()["status"],
            "outcomeUnknown"
        );
    }

    #[test]
    fn missing_or_corrupt_provision_history_always_reaps_the_owned_proxy_child() {
        for corrupt in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let journal = Journal::open(dir.path()).unwrap();
            let env = journal.enroll("fixture", "local:test").unwrap();
            journal.read().unwrap();
            if corrupt {
                std::fs::write(dir.path().join("journal.json"), b"damaged").unwrap();
            } else {
                std::fs::remove_file(dir.path().join("journal.json")).unwrap();
            }
            let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
            let pid = child.id();
            let retained = Journal::open_existing(dir.path()).unwrap();
            assert!(watch_provision(
                ProvisionChild(child),
                &retained,
                &env,
                &AtomicBool::new(false)
            )
            .is_err());
            assert!(!crate::harness::host::is_alive(pid));
            if corrupt {
                assert_eq!(
                    std::fs::read(dir.path().join("journal.json")).unwrap(),
                    b"damaged"
                );
            } else {
                assert!(!dir.path().join("journal.json").exists());
            }
        }
    }

    #[test]
    fn owner_busy_includes_unfinished_vm_work_manual_and_unrecognized_provision_state() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let env = journal.enroll("guest", "local:test").unwrap();
        let mut state = journal.read().unwrap();
        assert!(!state_busy(&state));
        for provision in [
            json!(null),
            json!({}),
            json!({"status":false}),
            json!({"status":"future-stage"}),
            json!({"status":"queued"}),
            json!({"status":"running"}),
            json!({"status":"canceling"}),
            json!({"status":"outcomeUnknown"}),
        ] {
            state.environments.get_mut(&env.id).unwrap().provision = Some(provision);
            assert!(state_busy(&state));
        }
        for status in ["completed", "failed"] {
            state.environments.get_mut(&env.id).unwrap().provision = Some(json!({"status":status}));
            assert!(!state_busy(&state));
        }
        state.environments.get_mut(&env.id).unwrap().manual_control = true;
        assert!(state_busy(&state));
        state.environments.get_mut(&env.id).unwrap().manual_control = false;
        let input = journal::TaskInput {
            parent_session_id: journal::new_id(),
            parent_tab_id: journal::new_id(),
            parent_message_id: journal::new_id(),
            environment_id: env.id,
            prompt: "selected".into(),
            harness: "codex".into(),
            model: "".into(),
            effort: None,
            permission_mode: "manual".into(),
            files: vec![],
            desktop: true,
        };
        let task = journal.submit("key", input).unwrap();
        state
            .tasks
            .insert(task.target.task_id.clone(), task.clone());
        for status in [
            TaskStatus::Queued,
            TaskStatus::Starting,
            TaskStatus::Running,
            TaskStatus::Waiting,
            TaskStatus::Canceling,
            TaskStatus::OutcomeUnknown,
        ] {
            state.tasks.get_mut(&task.target.task_id).unwrap().status = status;
            assert!(state_busy(&state));
        }
        state.tasks.get_mut(&task.target.task_id).unwrap().status = TaskStatus::Canceled;
        assert!(!state_busy(&state));
    }

    #[test]
    fn missing_or_corrupt_initialized_history_is_not_idle_or_recreated() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!journal_busy(dir.path(), false).unwrap());
        assert!(journal_busy(dir.path(), true).unwrap());
        let journal = Journal::open(dir.path()).unwrap();
        journal.read().unwrap();
        assert!(!journal_busy(dir.path(), true).unwrap());
        std::fs::remove_file(dir.path().join("journal.json")).unwrap();
        assert!(journal_busy(dir.path(), true).unwrap());
        assert!(Journal::open_existing(dir.path()).unwrap().read().is_err());
        assert!(!dir.path().join("journal.json").exists());
        std::fs::write(dir.path().join("journal.json"), b"broken history").unwrap();
        assert!(journal_busy(dir.path(), true).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("journal.json")).unwrap(),
            b"broken history"
        );
    }

    #[test]
    fn in_flight_vm_effects_refuse_stop_without_blocking_cancellation_or_committing_stop() {
        let _home = crate::store::temp_home();
        let life = Lifetime::new(Duration::ZERO);
        let first = admit(&life).unwrap();
        let started = std::time::Instant::now();
        assert!(prepare_stop().is_err());
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(!life.is_stopping());
        let cancellation = admit(&life).unwrap();
        assert!(admit_exclusive(&life).is_err());
        drop(cancellation);
        drop(first);
        let reconciliation = admit_exclusive(&life).unwrap();
        assert!(ADMISSION.try_read().is_err());
        drop(reconciliation);
        let stop = prepare_stop().unwrap();
        life.command("runtime.stopAll", json!({"epoch":life.status()["epoch"]}))
            .unwrap();
        drop(stop);
        assert!(admit(&life).is_err());
        assert!(admit_exclusive(&life).is_err());
        assert!(ensure_running(&AtomicBool::new(true)).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn guest_agent_reload_waits_for_a_slow_existing_service_to_leave_launchd() {
        let directory = tempfile::tempdir().unwrap();
        let label = format!("com.terminalx.test.guest-reload.{}", journal::new_id());
        let service = format!("gui/{}/{label}", unsafe { libc::geteuid() });
        // This exact disposable service is the only one cleanup may stop.
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = Command::new("/bin/launchctl")
                    .args(["bootout", &self.0])
                    .output();
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while std::time::Instant::now() < deadline {
                    if Command::new("/bin/launchctl")
                        .args(["print", &self.0])
                        .output()
                        .is_ok_and(|result| !result.status.success())
                    {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
        let _cleanup = Cleanup(service);
        let ready = directory.path().join("ready");
        let script = directory.path().join("slow-exit.sh");
        fs::write(&script, "trap '/bin/sleep 2; exit 0' TERM\n/usr/bin/touch \"$1\"\nwhile :; do /bin/sleep 30 & wait $!; done\n").unwrap();
        let agent = directory.path().join("agent.plist");
        fs::write(
            &agent,
            plist(
                &label,
                &[
                    "/bin/sh".into(),
                    script.to_str().unwrap().into(),
                    ready.to_str().unwrap().into(),
                ],
                &[],
                directory.path().join("agent.log").to_str().unwrap(),
            ),
        )
        .unwrap();
        let reload = || {
            Command::new("/bin/sh")
                .args(["-c", RELOAD_GUEST_AGENT, "terminalx-guest-install", &label])
                .arg(&agent)
                .output()
                .unwrap()
        };
        let wait_ready = || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !ready.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(
                ready.exists(),
                "The real disposable LaunchAgent did not start"
            );
        };
        let first = reload();
        assert!(
            first.status.success(),
            "{}",
            String::from_utf8_lossy(&first.stderr)
        );
        wait_ready();
        fs::remove_file(&ready).unwrap();
        let replacement = reload();
        assert!(
            replacement.status.success(),
            "{}",
            String::from_utf8_lossy(&replacement.stderr)
        );
        wait_ready();
    }

    #[test]
    fn launchagents_have_independent_lifetimes_and_no_display_assertion() {
        let env = Environment {
            transport: Default::default(),
            id: journal::new_id(),
            name: "Guest".into(),
            sandbox: "local:test".into(),
            generation: journal::new_id(),
            created_at: journal::now(),
            deleted_at: None,
            keep_awake: false,
            owned: false,
            provision: None,
            manual_control: false,
            setup: None,
        };
        let text = guest_plist(&env).unwrap();
        assert!(text.contains("KeepAlive"));
        assert!(text.contains("TERMINALX_LOCAL_VM_GENERATION"));
        assert!(!text.contains(".raccoon"));
        assert!(!text.contains("TERMINALX_NEXT_TOKEN"));
        assert_eq!(xml("<&\"'"), "&lt;&amp;&quot;&apos;");
    }
}
