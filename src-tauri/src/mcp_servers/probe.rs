//! Whether a server answers: an MCP `initialize` sent to a URL, or to a local
//! command over its standard input. Nothing the server answers is kept.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::json;

use super::Status;

const BODY_LIMIT: u64 = 256 * 1024;
const COMMAND_WAIT: Duration = Duration::from_secs(45);

pub(crate) struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// One HTTP request; tests stand in a scripted server.
pub(crate) trait Http: Send + Sync {
    fn request(&self, method: &str, url: &str, headers: &[(String, String)], body: Option<Vec<u8>>) -> Result<Response>;
}

/// The real one: no redirects (a token is never sent on to another host),
/// short timeouts, and a capped body.
pub(crate) struct Ureq(ureq::Agent);

impl Ureq {
    pub fn new() -> Self {
        Ureq(ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(8)).timeout_read(Duration::from_secs(12)).timeout_write(Duration::from_secs(12)).build())
    }
}

impl Http for Ureq {
    fn request(&self, method: &str, url: &str, headers: &[(String, String)], body: Option<Vec<u8>>) -> Result<Response> {
        let mut request = self.0.request(method, url).set("User-Agent", concat!("TerminalX/", env!("CARGO_PKG_VERSION")));
        for (name, value) in headers {
            request = request.set(name, value);
        }
        let answer = match body {
            Some(body) => request.send_bytes(&body),
            None => request.call(),
        };
        let response = match answer {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(error)) => return Err(anyhow::anyhow!("{}", error.kind())),
        };
        let status = response.status();
        let headers = response.headers_names().into_iter().filter_map(|name| response.header(&name).map(|v| (name.clone(), v.to_string()))).collect();
        let mut body = Vec::new();
        // A stream left open after the answer ends the read at its timeout; what came is enough.
        let _ = response.into_reader().take(BODY_LIMIT).read_to_end(&mut body);
        Ok(Response { status, headers, body })
    }
}

pub(crate) fn initialize() -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "TerminalX", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

/// An answer to `initialize`: a JSON-RPC result for id 1, as JSON or as an SSE event.
fn answers(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body);
    let is_answer = |json: &str| serde_json::from_str::<serde_json::Value>(json).is_ok_and(|v| v.get("id") == Some(&json!(1)) && v.get("result").is_some());
    is_answer(text.trim()) || text.lines().filter_map(|line| line.strip_prefix("data:")).any(|data| is_answer(data.trim()))
}

pub(crate) fn url(http: &dyn Http, url: &str, auth: &[(String, String)]) -> Status {
    let mut headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "application/json, text/event-stream".to_string()),
    ];
    headers.extend(auth.iter().cloned());
    match http.request("POST", url, &headers, Some(initialize().to_string().into_bytes())) {
        Ok(response) if (200..300).contains(&response.status) && answers(&response.body) => Status::Connected,
        Ok(response) if (200..300).contains(&response.status) => Status::Unreachable { detail: "Not an MCP server".into() },
        Ok(response) if response.status == 401 || response.status == 403 => Status::NeedsSignIn,
        Ok(response) => Status::Unreachable { detail: format!("HTTP {}", response.status) },
        Err(_) => Status::Unreachable { detail: "No answer".into() },
    }
}

/// Start the command as an agent would, send `initialize` and wait for its
/// answer. It is stopped (its whole process group) either way.
pub(crate) fn command(program: &str, args: &[String], env: &BTreeMap<String, String>) -> Status {
    command_within(program, args, env, COMMAND_WAIT)
}

pub(crate) fn command_within(program: &str, args: &[String], env: &BTreeMap<String, String>, wait: Duration) -> Status {
    let path = crate::binpath::login_path();
    let resolved = if program.contains('/') { Some(std::path::PathBuf::from(program)) } else { crate::binpath::resolve(program) };
    let Some(resolved) = resolved else { return Status::Exited { code: Some(127) } };
    let mut command = Command::new(resolved);
    command.args(args).envs(env).env("PATH", path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(home) = dirs::home_dir() {
        command.current_dir(home);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let Ok(mut child) = command.spawn() else { return Status::Exited { code: Some(127) } };
    let stop = |child: &mut std::process::Child| {
        #[cfg(unix)]
        // SAFETY: signals only the process group this probe started.
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    };
    // Kept open until the end: some servers stop when their input closes.
    let mut stdin = child.stdin.take();
    if let Some(stdin) = stdin.as_mut() {
        let _ = writeln!(stdin, "{}", initialize());
        let _ = stdin.flush();
    }
    let (send, answer) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout.take(BODY_LIMIT * 4)).lines() {
                let Ok(line) = line else { break };
                if answers(line.as_bytes()) {
                    let _ = send.send(());
                    break;
                }
            }
        });
    }
    let deadline = Instant::now() + wait;
    let status = loop {
        if answer.recv_timeout(Duration::from_millis(100)).is_ok() {
            break Status::Connected;
        }
        if let Ok(Some(exit)) = child.try_wait() {
            // An answer written just before it exited still counts.
            break if answer.recv_timeout(Duration::from_millis(100)).is_ok() { Status::Connected } else { Status::Exited { code: exit.code() } };
        }
        if Instant::now() >= deadline {
            break Status::Unreachable { detail: "No answer".into() };
        }
    };
    stop(&mut child);
    drop(stdin);
    status
}
