//! A per-user LaunchAgent owns lifecycle, queue draining and event collection.
//! The Tauri window and desktop viewer are clients, never process owners.
use super::host;
use super::journal::{self, Environment, Journal, Task, TaskStatus};
use super::process;
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub fn run_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("local-vm-supervisor") {
        return None;
    }
    let result = (|| {
        if args.len() != 2 || !Path::new(&args[1]).is_absolute() {
            bail!("local-vm-supervisor needs an absolute private data directory");
        }
        std::env::set_var("TERMINALX_HOME", &args[1]);
        run()
    })();
    if let Err(error) = &result {
        eprintln!("Local VM supervisor: {error:#}");
    }
    Some(if result.is_ok() { 0 } else { 1 })
}

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
pub fn guest_plist(env: &Environment) -> String {
    plist("com.terminalx.local-guest",&[format!("{}/bin/terminalx-serve",host::GUEST_HOME),"--data-dir".into(),format!("{}/runtime",host::GUEST_HOME)],&[
        ("TERMINALX_LOCAL_VM_ENVIRONMENT_ID",env.id.clone()),("TERMINALX_LOCAL_VM_GENERATION",env.generation.clone()),
        ("PATH","/Users/lume/.terminalx-local/bin:/Users/lume/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()),
    ],&format!("{}/runtime/guest.log",host::GUEST_HOME))
}
pub fn install() -> Result<()> {
    if std::env::consts::OS != "macos" {
        bail!("The local macOS supervisor requires macOS");
    }
    let data = crate::store::root()?;
    let root = host::root()?;
    let bin = root.join("bin");
    journal::private_directory(&bin)?;
    let bytes = fs::read(std::env::current_exe()?)?;
    let executable = bin.join("terminalx-local-supervisor");
    let same = fs::read(&executable)
        .ok()
        .is_some_and(|old| journal::digest(&old) == journal::digest(&bytes));
    if !same {
        journal::atomic_private_write(&executable, &bytes)?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))?;
    }
    let suffix = &journal::digest(data.as_os_str().as_encoded_bytes())[..12];
    let label = format!("com.terminalx.local-vm.{suffix}");
    let agents = dirs::home_dir()
        .context("Home unavailable")?
        .join("Library/LaunchAgents");
    fs::create_dir_all(&agents)?;
    let file = agents.join(format!("{label}.plist"));
    journal::atomic_private_write(
        &file,
        plist(
            &label,
            &[
                executable.to_string_lossy().into_owned(),
                "local-vm-supervisor".into(),
                data.to_string_lossy().into_owned(),
            ],
            &[("PATH", crate::binpath::login_path())],
            &root.join("supervisor.log").to_string_lossy(),
        )
        .as_bytes(),
    )?;
    // SAFETY: geteuid has no preconditions.
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    let loaded = Command::new("/bin/launchctl")
        .args(["print", &format!("{domain}/{label}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?
        .success();
    if !loaded {
        process::run(
            Command::new("/bin/launchctl")
                .args(["bootstrap", &domain])
                .arg(&file),
            b"",
            Duration::from_secs(15),
        )?;
    } else if !same {
        // Only this supervisor is restarted; guest workers and VMs are owned
        // independently. Dispatch markers prevent prompt replay on recovery.
        process::run(
            Command::new("/bin/launchctl").args(["kickstart", "-k", &format!("{domain}/{label}")]),
            b"",
            Duration::from_secs(15),
        )?;
    } else {
        process::run(
            Command::new("/bin/launchctl").args(["kickstart", &format!("{domain}/{label}")]),
            b"",
            Duration::from_secs(15),
        )?;
    }
    Ok(())
}
fn run() -> Result<()> {
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
    let journal = host::journal()?;
    journal.transaction(|s|{
        for env in s.environments.values_mut(){
            if env.provision.as_ref().and_then(|p|p.get("status")).and_then(Value::as_str).is_some_and(|p|matches!(p,"running"|"canceling")) {
                env.provision=Some(host::progress("outcomeUnknown","The supervisor restarted during provisioning. Inspect the existing VM and cache; creation was not replayed."));
            }
        }
        Ok(())
    })?;
    let diagnostic = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let heartbeat_diagnostic = diagnostic.clone();
    let heartbeat_root = root.clone();
    std::thread::Builder::new().name("local-vm-heartbeat".into()).spawn(move||loop{
        let detail=heartbeat_diagnostic.lock().unwrap().clone();
        let health=json!({"at":journal::now(),"pid":std::process::id(),"protocol":journal::PROTOCOL,"healthy":detail.is_none(),"detail":detail});
        if let Ok(bytes)=serde_json::to_vec(&health){let _=journal::atomic_private_write(&heartbeat_root.join("health.json"),&bytes);}
        std::thread::sleep(Duration::from_secs(3));
    })?;
    let mut assertion: Option<Child> = None;
    loop {
        let outcome = tick(&journal);
        *diagnostic.lock().unwrap() = outcome
            .err()
            .map(|e| crate::remote::protocol::redact(&e.to_string()));
        let state = journal.read()?;
        let working = state.tasks.values().any(|t| {
            matches!(
                t.status,
                TaskStatus::Starting | TaskStatus::Running | TaskStatus::Canceling
            ) && state
                .environments
                .get(&t.target.environment_id)
                .is_some_and(|e| e.keep_awake)
        });
        if working && assertion.is_none() {
            // -i prevents idle SYSTEM sleep only. No -d, -u or persistent
            // power setting; locking and display sleep remain available.
            assertion = Command::new("/usr/bin/caffeinate")
                .args(["-i", "-w", &std::process::id().to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok();
        }
        if !working {
            if let Some(mut child) = assertion.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

fn tick(journal: &Journal) -> Result<()> {
    let state = journal.read()?;
    for env in state
        .environments
        .values()
        .filter(|e| e.deleted_at.is_none())
    {
        let provision = env
            .provision
            .as_ref()
            .and_then(|p| p.get("status"))
            .and_then(Value::as_str);
        if provision == Some("queued") {
            provision_vm(journal, env)?;
        }
        let state = journal.read()?;
        if env.manual_control
            || state
                .tasks
                .values()
                .any(|t| t.target.environment_id == env.id && !t.status.terminal())
        {
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
            if task.status == TaskStatus::Queued {
                if !state.enabled {
                    continue;
                }
                if journal.claim(&task.target).is_err() {
                    continue;
                }
            }
            if let Err(error) = advance(journal, env, &task) {
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
fn provision_vm(journal: &Journal, env: &Environment) -> Result<()> {
    journal.transaction(|s| {s.environments.get_mut(&env.id).unwrap().provision=Some(host::progress("running","Downloading/checking the pinned image and starting macOS. Cancellation retains partial storage.")); Ok(())})?;
    // Claim before spawning. On a supervisor crash, a running stage is never
    // resubmitted. Inspect/reconnect is required to reconcile unknown state.
    let mut child = process::command("cua")?
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
        .stderr(Stdio::null())
        .spawn()?;
    let started = std::time::Instant::now();
    let outcome = loop {
        if let Some(status) = child.try_wait()? {
            break if status.success() {
                "completed"
            } else {
                "failed"
            };
        }
        let cancel = journal
            .read()?
            .environments
            .get(&env.id)
            .and_then(|e| e.provision.as_ref())
            .and_then(|p| p.get("status"))
            .and_then(Value::as_str)
            == Some("canceling");
        if cancel || started.elapsed() > Duration::from_secs(7200) {
            let _ = child.kill();
            let _ = child.wait();
            break "outcomeUnknown";
        }
        std::thread::sleep(Duration::from_secs(1));
    };
    journal.transaction(|s| {s.environments.get_mut(&env.id).unwrap().provision=Some(host::progress(outcome,"Inspect the retained VM/image storage. Install the guest runtime and complete guest permissions/provider login before submitting tasks.")); Ok(())})
}
fn advance(journal: &Journal, env: &Environment, task: &Task) -> Result<()> {
    let result = if !task.dispatch_started {
        let description = host::guest_rpc(env, "describe", json!({}))?;
        if !description
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|c| c == "task.submit"))
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
        let dispatch = journal.transaction(|s| {
            let t = journal::bound(s, &task.target)?;
            if t.status.terminal() {
                bail!("Task was canceled before guest dispatch");
            }
            t.dispatch_started = true;
            Ok(t.clone())
        })?;
        host::guest_rpc(env, "task.start", json!({"task":dispatch,"files":files}))?
    } else {
        host::guest_rpc(
            env,
            "task.poll",
            json!({"target":task.target,"after":task.last_event_seq}),
        )?
    };
    let guest: Task = serde_json::from_value(result).context("Guest task protocol mismatch")?;
    if guest.target != task.target
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
    fn launchagents_have_independent_lifetimes_and_no_display_assertion() {
        let env = Environment {
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
        };
        let text = guest_plist(&env);
        assert!(text.contains("KeepAlive"));
        assert!(text.contains("TERMINALX_LOCAL_VM_GENERATION"));
        assert!(!text.contains(".raccoon"));
        assert!(!text.contains("TERMINALX_NEXT_TOKEN"));
        assert_eq!(xml("<&\"'"), "&lt;&amp;&quot;&apos;");
    }
}
