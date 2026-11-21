//! Bounded installed-tool observations; never an arbitrary command or environment dump.
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::protocol::RpcError;

const OUTPUT_LIMIT: u64 = 4096;
const TOOL_TIMEOUT: Duration = Duration::from_secs(2);
const PATH: &str = "/opt/terminalx/agent-cli/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
static RUNNING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
type Requests = HashMap<(u64, String), Arc<AtomicBool>>;
static EARLY_CANCELS: LazyLock<Mutex<VecDeque<(u64, String, Instant)>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
static REQUESTS: LazyLock<Mutex<Requests>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct Tool<'a> {
    id: &'static str,
    executables: &'a [&'a str],
    args: &'static [&'static str],
    prefix: &'static str,
}

const TOOLS: &[Tool<'_>] = &[
    Tool { id: "node", executables: &["/opt/terminalx/agent-cli/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node", "/bin/node"], args: &["--version"], prefix: "v" },
    Tool { id: "npm", executables: &["/opt/terminalx/agent-cli/bin/npm", "/usr/local/bin/npm", "/opt/homebrew/bin/npm", "/usr/bin/npm", "/bin/npm"], args: &["--version"], prefix: "" },
    Tool { id: "pnpm", executables: &["/opt/terminalx/agent-cli/bin/pnpm", "/usr/local/bin/pnpm", "/opt/homebrew/bin/pnpm", "/usr/bin/pnpm", "/bin/pnpm"], args: &["--version"], prefix: "" },
    Tool { id: "python", executables: &["/opt/terminalx/agent-cli/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python3", "/bin/python3"], args: &["--version"], prefix: "Python " },
    Tool { id: "git", executables: &["/opt/terminalx/agent-cli/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/usr/bin/git", "/bin/git"], args: &["--version"], prefix: "git version " },
    Tool { id: "gh", executables: &["/opt/terminalx/agent-cli/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/usr/bin/gh", "/bin/gh"], args: &["--version"], prefix: "gh version " },
    Tool { id: "jq", executables: &["/opt/terminalx/agent-cli/bin/jq", "/usr/local/bin/jq", "/opt/homebrew/bin/jq", "/usr/bin/jq", "/bin/jq"], args: &["--version"], prefix: "jq-" },
    Tool { id: "rg", executables: &["/opt/terminalx/agent-cli/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg", "/usr/bin/rg", "/bin/rg"], args: &["--version"], prefix: "ripgrep " },
    Tool { id: "git-lfs", executables: &["/opt/terminalx/agent-cli/bin/git-lfs", "/usr/local/bin/git-lfs", "/opt/homebrew/bin/git-lfs", "/usr/bin/git-lfs", "/bin/git-lfs"], args: &["--version"], prefix: "git-lfs/" },
    Tool { id: "tmux", executables: &["/opt/terminalx/agent-cli/bin/tmux", "/usr/local/bin/tmux", "/opt/homebrew/bin/tmux", "/usr/bin/tmux", "/bin/tmux"], args: &["-V"], prefix: "tmux " },
    Tool { id: "vim", executables: &["/opt/terminalx/agent-cli/bin/vim", "/usr/local/bin/vim", "/opt/homebrew/bin/vim", "/usr/bin/vim", "/bin/vim"], args: &["--version"], prefix: "VIM - Vi IMproved " },
];

fn request_id(params: &Value) -> Result<String, RpcError> {
    let object = params.as_object().ok_or_else(|| RpcError::invalid("requestId required"))?;
    let id = object.get("requestId").and_then(Value::as_str).filter(|id| uuid::Uuid::parse_str(id).is_ok());
    if object.len() != 1 || id.is_none() {
        return Err(RpcError::invalid("Only a UUID requestId is accepted"));
    }
    Ok(uuid::Uuid::parse_str(id.unwrap()).expect("validated UUID").to_string())
}

pub(super) fn cancel(peer: u64, params: &Value) -> Result<Value, RpcError> {
    let id = request_id(params)?;
    let requests = REQUESTS.lock().unwrap();
    if let Some(cancelled) = requests.get(&(peer, id.clone())) {
        cancelled.store(true, Ordering::SeqCst);
    } else {
        // The socket may read cancel before its spawned report task is polled.
        // Retain bounded, short-lived tombstones so that report cannot start.
        let mut early = EARLY_CANCELS.lock().unwrap();
        early.retain(|(_, _, at)| at.elapsed() < Duration::from_secs(30));
        if early.len() == 128 { early.pop_front(); }
        early.push_back((peer, id, Instant::now()));
    }
    Ok(json!({}))
}

fn version(tool: &Tool<'_>, output: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(output).ok()?;
    let token = text.strip_prefix(tool.prefix)?.split_whitespace().next()?;
    let token = token.split('(').next()?;
    let numeric = if tool.id == "tmux" && token.ends_with(|c: char| c.is_ascii_lowercase()) {
        &token[..token.len() - 1]
    } else { token };
    if token.len() > 32 || !numeric.split('.').all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())) {
        return None;
    }
    Some(token.to_string())
}

struct Process(tokio::process::Child);
impl Process {
    fn kill_unreaped(&mut self) -> bool {
        if let Some(id) = self.0.id() {
            #[cfg(unix)]
            unsafe { libc::kill(-(id as i32), libc::SIGKILL); }
            #[cfg(not(unix))]
            let _ = id;
            let _ = self.0.start_kill();
            return true;
        }
        false
    }
}
impl Drop for Process {
    fn drop(&mut self) { self.kill_unreaped(); }
}

#[cfg(target_os = "macos")]
async fn developer_tools_available() -> bool {
    if std::path::Path::new("/Library/Developer/CommandLineTools").is_dir() { return true; }
    let mut command = tokio::process::Command::new("/usr/bin/xcode-select");
    command.arg("-p").env_clear().current_dir("/").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    matches!(tokio::time::timeout(Duration::from_millis(500), command.status()).await, Ok(Ok(status)) if status.success())
}
#[cfg(not(target_os = "macos"))]
async fn developer_tools_available() -> bool { true }

#[cfg(all(test, unix))]
async fn probe(tool: &Tool<'_>, allowed: &impl Fn() -> bool) -> Value {
    probe_with_developer_tools(tool, allowed, developer_tools_available().await).await
}

async fn probe_with_developer_tools(tool: &Tool<'_>, allowed: &impl Fn() -> bool, developer_tools: bool) -> Value {
    if !allowed() { return json!({ "id": tool.id, "status": "error" }); }
    let mut spawned = None;
    for executable in tool.executables {
        // Apple stubs may launch a separate installer outside this process group.
        if cfg!(target_os = "macos") && !developer_tools && matches!(*executable, "/usr/bin/python3" | "/usr/bin/git") { continue; }
        if !allowed() { return json!({ "id": tool.id, "status": "error" }); }
        // ENOENT from exec can also mean a present script's interpreter (or
        // binary's loader) is missing. Only skip an absent directory entry;
        // symlink_metadata deliberately retains dangling links as errors.
        match tokio::fs::symlink_metadata(executable).await {
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return json!({ "id": tool.id, "status": "error" }),
        }
        if !allowed() { return json!({ "id": tool.id, "status": "error" }); }
        let mut command = tokio::process::Command::new(executable);
        command.args(tool.args).env_clear().env("PATH", PATH).env("HOME", "/nonexistent")
            .env("LC_ALL", "C").env("npm_config_userconfig", "/dev/null")
            .env("npm_config_update_notifier", "false").env("PNPM_DISABLE_SELF_UPDATE_CHECK", "true")
            .env("COREPACK_ENABLE_NETWORK", "0").env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
            .current_dir("/").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        match command.spawn() {
            Ok(child) => { spawned = Some(child); break; }
            Err(_) => return json!({ "id": tool.id, "status": "error" }),
        }
    }
    let Some(child) = spawned else { return json!({ "id": tool.id, "status": "missing" }); };
    let mut child = Process(child);
    let stdout = child.0.stdout.take().expect("piped stdout");
    let work = async {
        let mut output = Vec::new();
        stdout.take(OUTPUT_LIMIT + 1).read_to_end(&mut output).await?;
        if output.len() as u64 > OUTPUT_LIMIT { return Ok::<_, std::io::Error>(None); }
        let status = child.0.wait().await?;
        Ok(status.success().then(|| version(tool, &output)).flatten())
    };
    let cancellation = async {
        loop {
            if !allowed() { break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    let result = tokio::select! {
        result = tokio::time::timeout(TOOL_TIMEOUT, work) => match result {
            Ok(Ok(Some(version))) => json!({ "id": tool.id, "status": "installed", "version": version }),
            Err(_) => json!({ "id": tool.id, "status": "timeout" }),
            _ => json!({ "id": tool.id, "status": "error" }),
        },
        _ = cancellation => json!({ "id": tool.id, "status": "error" }),
    };
    // Child::id becomes None after wait reaps it. Never signal a cached PID:
    // its process group id could already belong to an unrelated new process.
    if child.kill_unreaped() {
        let _ = tokio::time::timeout(Duration::from_millis(250), child.0.wait()).await;
    }
    result
}

struct Registration((u64, String));
impl Drop for Registration {
    fn drop(&mut self) { REQUESTS.lock().unwrap().remove(&self.0); }
}

pub(super) async fn report(peer: u64, params: &Value, authorized: impl Fn() -> bool) -> Result<Value, RpcError> {
    report_with_slot(peer, params, authorized, &RUNNING, TOOLS).await
}

async fn report_with_slot(peer: u64, params: &Value, authorized: impl Fn() -> bool, slot: &tokio::sync::Semaphore, inventory: &[Tool<'_>]) -> Result<Value, RpcError> {
    let id = request_id(params)?;
    if !authorized() { return Err(RpcError::new("cancelled", "Environment report cancelled")); }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut requests = REQUESTS.lock().unwrap();
        let mut early = EARLY_CANCELS.lock().unwrap();
        early.retain(|(_, _, at)| at.elapsed() < Duration::from_secs(30));
        if early.iter().any(|(owner, request, _)| *owner == peer && request == &id) {
            return Err(RpcError::new("cancelled", "Environment report cancelled"));
        }
        // A caller gets one live request and at most one cancelled request
        // still cleaning up. It cannot fill an unbounded global wait queue.
        let own: Vec<_> = requests.iter().filter(|((owner, _), _)| *owner == peer).collect();
        if requests.contains_key(&(peer, id.clone())) || own.len() >= 2 || own.iter().any(|(_, flag)| !flag.load(Ordering::SeqCst)) {
            return Err(RpcError::new("environment_busy", "This caller already has a report pending"));
        }
        requests.insert((peer, id.clone()), cancelled.clone());
    }
    let _registration = Registration((peer, id));
    let allowed = || authorized() && !cancelled.load(Ordering::SeqCst);
    let wait_cancel = async {
        while allowed() { tokio::time::sleep(Duration::from_millis(25)).await; }
    };
    let _permit = tokio::select! {
        permit = tokio::time::timeout(Duration::from_secs(1), slot.acquire()) =>
            permit.map_err(|_| RpcError::new("environment_busy", "Another report is running"))?
                .map_err(|_| RpcError::new("environment_busy", "Environment reports unavailable"))?,
        _ = wait_cancel => return Err(RpcError::new("cancelled", "Environment report cancelled")),
    };
    let developer_tools = developer_tools_available().await;
    let mut tools = Vec::new();
    for tool in inventory {
        if !allowed() { return Err(RpcError::new("cancelled", "Environment report cancelled")); }
        tools.push(probe_with_developer_tools(tool, &allowed, developer_tools).await);
    }
    if !allowed() { return Err(RpcError::new("cancelled", "Environment report cancelled")); }
    Ok(json!({ "version": 1, "observedAt": crate::cloud_agents::now_ms(), "tools": tools }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_tools_and_numeric_versions_leave_the_runtime() {
        assert_eq!(TOOLS.len(), 11);
        assert_eq!(version(&TOOLS[0], b"v24.22.1\n"), Some("24.22.1".into()));
        assert_eq!(version(&TOOLS[6], b"jq-1.7\n"), Some("1.7".into()));
        for output in [b"secret-token".as_slice(), b"v24.1\x1b[31m", b"v24.1/token", b"v24.1@example.com"] {
            assert!(version(&TOOLS[0], output).is_none());
        }
        assert!(request_id(&json!({"requestId": uuid::Uuid::new_v4().to_string(), "command": "env"})).is_err());
        assert!(request_id(&json!({"requestId": "../../etc"})).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_authority_never_starts_a_probe() {
        assert_eq!(report(1, &json!({"requestId": uuid::Uuid::new_v4().to_string()}), || false).await.unwrap_err().code, "cancelled");
        let params = json!({"requestId": uuid::Uuid::new_v4().to_string()});
        cancel(1, &params).unwrap();
        assert_eq!(report(1, &params, || true).await.unwrap_err().code, "cancelled");
        let actual = report(1, &json!({"requestId": uuid::Uuid::new_v4().to_string()}), || true).await.unwrap();
        assert_eq!(actual["tools"].as_array().unwrap().len(), TOOLS.len());
        assert!(actual["tools"].as_array().unwrap().iter().any(|tool| tool["status"] == "installed"));
        for (tool, observed) in TOOLS.iter().zip(actual["tools"].as_array().unwrap()) {
            assert_eq!(observed["id"], tool.id);
            assert!(["installed", "missing", "timeout", "error"].contains(&observed["status"].as_str().unwrap()));
        }
        eprintln!("Sanitized real installed-tool observation: {actual}");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn processes_have_a_clean_environment_and_only_versions_are_returned() {
        let tool = Tool { id: "node", executables: &["/bin/sh"], args: &["-c", "test \"$HOME\" = /nonexistent && test -z \"$USER\" && test \"$PWD\" = / && printf 'v24.22.1\n'"], prefix: "v" };
        assert_eq!(probe(&tool, &|| true).await, json!({"id": "node", "status": "installed", "version": "24.22.1"}));
        let missing = Tool { executables: &["/nonexistent/terminalx-fixture"], ..tool };
        assert_eq!(probe(&missing, &|| true).await["status"], "missing");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn only_absent_candidates_fall_through_to_a_later_installation() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node");
        let executables = [path.to_str().unwrap(), "/bin/sh"];
        let tool = Tool { id: "node", executables: &executables, args: &["-c", "printf 'v24.22.1\\n'"], prefix: "v" };
        // An absent candidate permits the later installation.
        assert_eq!(probe(&tool, &|| true).await["status"], "installed");
        std::fs::write(&path, b"#!/nonexistent/terminalx-interpreter\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        // exec returns ENOENT here too, but the installation exists and is broken.
        assert_eq!(probe(&tool, &|| true).await["status"], "error");
        let only_executable = [path.to_str().unwrap()];
        let only = Tool { executables: &only_executable, ..tool };
        assert_eq!(probe(&only, &|| true).await["status"], "error");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(probe(&tool, &|| true).await["status"], "error");
        std::fs::remove_file(&path).unwrap();
        symlink(dir.path().join("absent-target"), &path).unwrap();
        assert_eq!(probe(&tool, &|| true).await["status"], "error");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn output_and_process_lifetime_are_bounded() {
        let verbose = Tool { id: "node", executables: &["/bin/sh"], args: &["-c", "printf v; i=0; while [ $i -lt 5000 ]; do printf 1; i=$((i+1)); done"], prefix: "v" };
        assert_eq!(probe(&verbose, &|| true).await["status"], "error");
        let hanging = Tool { args: &["-c", "sleep 30"], ..verbose };
        assert_eq!(probe(&hanging, &|| true).await["status"], "timeout");
        let began = std::time::Instant::now();
        assert_eq!(probe(&hanging, &|| began.elapsed() < Duration::from_millis(100)).await["status"], "error");
        assert!(began.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn cancellation_is_scoped_to_the_attachment() {
        let id = uuid::Uuid::new_v4().to_string();
        let cancelled = Arc::new(AtomicBool::new(false));
        REQUESTS.lock().unwrap().insert((900, id.clone()), cancelled.clone());
        let _registration = Registration((900, id.clone()));
        cancel(901, &json!({"requestId": id})).unwrap();
        assert!(!cancelled.load(Ordering::SeqCst));
        cancel(900, &json!({"requestId": id})).unwrap();
        assert!(cancelled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancelled_report_reopen_waits_for_cleanup_and_limits_each_caller() {
        let slot = tokio::sync::Semaphore::new(1);
        let permit = slot.acquire().await.unwrap();
        let first = json!({"requestId": uuid::Uuid::new_v4().to_string()});
        let second = json!({"requestId": uuid::Uuid::new_v4().to_string()});
        let first_run = report_with_slot(4001, &first, || true, &slot, &[]);
        let reopen = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let third = json!({"requestId": uuid::Uuid::new_v4().to_string()});
            assert_eq!(report_with_slot(4001, &third, || true, &slot, &[]).await.unwrap_err().code, "environment_busy");
            cancel(4001, &first).unwrap();
            let second_run = report_with_slot(4001, &second, || true, &slot, &[]);
            let cleanup = async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                drop(permit);
            };
            let (result, ()) = tokio::join!(second_run, cleanup);
            result.unwrap()
        };
        let (old, new) = tokio::join!(first_run, reopen);
        assert_eq!(old.unwrap_err().code, "cancelled");
        assert_eq!(new["tools"], json!([]));
        assert!(!REQUESTS.lock().unwrap().keys().any(|(peer, _)| *peer == 4001));
    }

    #[tokio::test]
    async fn two_callers_wait_for_the_same_slot_without_a_false_busy_error() {
        let slot = tokio::sync::Semaphore::new(1);
        let permit = slot.acquire().await.unwrap();
        let a = json!({"requestId": uuid::Uuid::new_v4().to_string()});
        let b = json!({"requestId": uuid::Uuid::new_v4().to_string()});
        let release = async { tokio::time::sleep(Duration::from_millis(100)).await; drop(permit); };
        let (a, b, ()) = tokio::join!(report_with_slot(4002, &a, || true, &slot, &[]), report_with_slot(4003, &b, || true, &slot, &[]), release);
        assert!(a.is_ok());
        assert!(b.is_ok());
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn missing_developer_tools_skip_apple_stubs_without_launching_them() {
        for executable in ["/usr/bin/git", "/usr/bin/python3"] {
            let executables = [executable, "/bin/sh"];
            let tool = Tool { id: "node", executables: &executables, args: &["-c", "printf 'v24.22.1\\n'"], prefix: "v" };
            assert_eq!(probe_with_developer_tools(&tool, &|| true, false).await["version"], "24.22.1");
            let stub = [executable];
            let tool = Tool { executables: &stub, ..tool };
            assert_eq!(probe_with_developer_tools(&tool, &|| true, false).await["status"], "missing");
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn cleanup_signals_only_an_unreaped_child() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "exit 0"]).process_group(0);
        let mut exited = Process(command.spawn().unwrap());
        assert!(exited.0.wait().await.unwrap().success());
        assert!(!exited.kill_unreaped(), "a reaped PID/group must never be signalled");
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]).process_group(0);
        let mut running = Process(command.spawn().unwrap());
        assert!(running.kill_unreaped());
        assert!(!running.0.wait().await.unwrap().success());
        assert!(!running.kill_unreaped());
    }

}
