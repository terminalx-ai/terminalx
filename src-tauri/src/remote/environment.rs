use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::protocol::RpcError;

const OUTPUT_LIMIT: u64 = 4096;
const TOOL_TIMEOUT: Duration = Duration::from_secs(2);
const PATH: &str = "/opt/terminalx/agent-cli/bin:/usr/local/bin:/usr/bin:/bin";
static RUNNING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
type Requests = HashMap<(u64, String), Arc<AtomicBool>>;
static REQUESTS: LazyLock<Mutex<Requests>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct Tool {
    id: &'static str,
    executables: &'static [&'static str],
    args: &'static [&'static str],
    prefix: &'static str,
}

const TOOLS: &[Tool] = &[
    Tool { id: "node", executables: &["/opt/terminalx/agent-cli/bin/node", "/usr/local/bin/node", "/usr/bin/node"], args: &["--version"], prefix: "v" },
    Tool { id: "npm", executables: &["/opt/terminalx/agent-cli/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"], args: &["--version"], prefix: "" },
    Tool { id: "pnpm", executables: &["/opt/terminalx/agent-cli/bin/pnpm", "/usr/local/bin/pnpm", "/usr/bin/pnpm"], args: &["--version"], prefix: "" },
    Tool { id: "python", executables: &["/usr/bin/python3"], args: &["--version"], prefix: "Python " },
    Tool { id: "git", executables: &["/usr/bin/git"], args: &["--version"], prefix: "git version " },
    Tool { id: "gh", executables: &["/usr/bin/gh"], args: &["--version"], prefix: "gh version " },
    Tool { id: "jq", executables: &["/usr/bin/jq"], args: &["--version"], prefix: "jq-" },
    Tool { id: "rg", executables: &["/usr/bin/rg"], args: &["--version"], prefix: "ripgrep " },
    Tool { id: "git-lfs", executables: &["/usr/bin/git-lfs"], args: &["--version"], prefix: "git-lfs/" },
    Tool { id: "tmux", executables: &["/usr/bin/tmux"], args: &["-V"], prefix: "tmux " },
    Tool { id: "vim", executables: &["/usr/bin/vim"], args: &["--version"], prefix: "VIM - Vi IMproved " },
];

fn request_id(params: &Value) -> Result<String, RpcError> {
    let object = params.as_object().ok_or_else(|| RpcError::invalid("requestId required"))?;
    let id = object.get("requestId").and_then(Value::as_str).filter(|id| uuid::Uuid::parse_str(id).is_ok());
    if object.len() != 1 || id.is_none() {
        return Err(RpcError::invalid("Only a UUID requestId is accepted"));
    }
    Ok(id.unwrap().to_string())
}

pub(super) fn cancel(peer: u64, params: &Value) -> Result<Value, RpcError> {
    let id = request_id(params)?;
    if let Some(cancelled) = REQUESTS.lock().unwrap().get(&(peer, id)) {
        cancelled.store(true, Ordering::SeqCst);
    }
    Ok(json!({}))
}

fn version(tool: &Tool, output: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(output).ok()?;
    let token = text.strip_prefix(tool.prefix)?.split_whitespace().next()?;
    let token = token.split('(').next()?;
    if token.is_empty() || token.len() > 32 || !token.starts_with(|c: char| c.is_ascii_digit())
        || !token.bytes().all(|c| c.is_ascii_digit() || c == b'.' || (tool.id == "tmux" && c.is_ascii_lowercase())) {
        return None;
    }
    Some(token.to_string())
}

struct Process(tokio::process::Child);
impl Drop for Process {
    fn drop(&mut self) {
        if let Some(id) = self.0.id() {
            #[cfg(unix)]
            unsafe { libc::kill(-(id as i32), libc::SIGKILL); }
            let _ = self.0.start_kill();
        }
    }
}

async fn probe(tool: &Tool, allowed: &impl Fn() -> bool) -> Value {
    if !allowed() { return json!({ "id": tool.id, "status": "error" }); }
    let mut spawned = None;
    for executable in tool.executables {
        let mut command = tokio::process::Command::new(executable);
        command.args(tool.args).env_clear().env("PATH", PATH).env("HOME", "/nonexistent")
            .env("LC_ALL", "C").env("npm_config_userconfig", "/dev/null")
            .env("npm_config_update_notifier", "false").env("PNPM_DISABLE_SELF_UPDATE_CHECK", "true")
            .current_dir("/").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        match command.spawn() {
            Ok(child) => { spawned = Some(child); break; }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return json!({ "id": tool.id, "status": "error" }),
        }
    }
    let Some(child) = spawned else { return json!({ "id": tool.id, "status": "missing" }); };
    let mut child = Process(child);
    let group = child.0.id();
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
    // A wrapper may leave descendants after it exits or closes stdout.
    #[cfg(unix)]
    if let Some(id) = group { unsafe { libc::kill(-(id as i32), libc::SIGKILL); } }
    let _ = child.0.start_kill();
    let _ = tokio::time::timeout(Duration::from_millis(250), child.0.wait()).await;
    result
}

struct Registration((u64, String));
impl Drop for Registration {
    fn drop(&mut self) { REQUESTS.lock().unwrap().remove(&self.0); }
}

pub(super) async fn report(peer: u64, params: &Value, authorized: impl Fn() -> bool) -> Result<Value, RpcError> {
    let id = request_id(params)?;
    let _permit = RUNNING.try_acquire().map_err(|_| RpcError::new("environment_busy", "Another report is running"))?;
    let cancelled = Arc::new(AtomicBool::new(false));
    REQUESTS.lock().unwrap().insert((peer, id.clone()), cancelled.clone());
    let _registration = Registration((peer, id));
    let allowed = || authorized() && !cancelled.load(Ordering::SeqCst);
    let mut tools = Vec::new();
    for tool in TOOLS {
        if !allowed() { return Err(RpcError::new("cancelled", "Environment report cancelled")); }
        tools.push(probe(tool, &allowed).await);
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

    #[tokio::test]
    async fn cancelled_authority_never_starts_a_probe() {
        assert_eq!(report(1, &json!({"requestId": uuid::Uuid::new_v4().to_string()}), || false).await.unwrap_err().code, "cancelled");
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

}
