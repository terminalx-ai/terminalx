//! An archive's final checkpoint (terminalx-saas contract §10.3, PRO-34),
//! end to end: the real `terminalx-serve` advertises `quiesce-v1`, finds the
//! pending request in its `/refresh` answer, and reports its final checkpoint
//! once to `/v1/cloud-workspace-bootstrap/checkpoint`.

#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const TOKEN: &str = "tokentokentokentokentokentokentokentokentok";
const CREDENTIAL: &str = "credentialcredentialcredentialcredentialcre";
const OPERATION: &str = "operation_archive_1";
const WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct State {
    capabilities: Vec<String>,
    /// Each checkpoint report: (bearer, body).
    reports: Vec<(String, Value)>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn start_server() -> (String, Arc<Mutex<State>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let state = Arc::new(Mutex::new(State::default()));
    let shared = state.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let state = shared.clone();
            std::thread::spawn(move || handle(stream, &state));
        }
    });
    (origin, state)
}

fn handle(stream: TcpStream, state: &Mutex<State>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let path = line.split_whitespace().nth(1).unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() {
            return;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut body = vec![0; length];
    let _ = reader.read_exact(&mut body);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let bearer = headers.get("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or_default().to_string();
    let session = json!({ "v": 1, "workspaceId": "ws_1", "organizationId": "org_1", "relayToken": "a.b.c", "relayTokenExpiresAt": 1, "directorUrl": "https://relay.invalid" });
    let (status, payload) = {
        let mut state = state.lock().unwrap();
        match path.as_str() {
            "/v1/cloud-workspace-bootstrap/redeem" if bearer == TOKEN => {
                let mut answer = session;
                answer["runtimeCredential"] = json!(CREDENTIAL);
                (200, answer)
            }
            "/v1/cloud-workspace-bootstrap/refresh" if bearer == CREDENTIAL => {
                let capabilities = headers.get("x-terminalx-cloud-workspace-runtime-capabilities").cloned().unwrap_or_default();
                let asks = capabilities.split(',').any(|capability| capability == "quiesce-v1");
                state.capabilities.push(capabilities);
                let mut answer = session;
                answer["attachments"] = json!([]);
                answer["revocations"] = json!([]);
                // Only for a runtime that asked for it, and only until answered.
                if asks {
                    answer["quiesce"] = if state.reports.is_empty() {
                        json!({ "operationId": OPERATION, "reason": "archive", "requestedAt": now_ms(), "deadline": now_ms() + 60_000 })
                    } else {
                        Value::Null
                    };
                }
                (200, answer)
            }
            "/v1/cloud-workspace-bootstrap/checkpoint" if bearer == CREDENTIAL && state.reports.is_empty() => {
                state.reports.push((bearer.clone(), body.clone()));
                (200, json!({ "ok": true }))
            }
            "/v1/cloud-workspace-bootstrap/checkpoint" => {
                state.reports.push((bearer.clone(), body.clone()));
                (401, json!({ "error": "cloud_workspace_bootstrap_invalid" }))
            }
            _ => (401, json!({ "error": "cloud_workspace_bootstrap_invalid" })),
        }
    };
    let payload = payload.to_string();
    let mut stream = stream;
    let _ = write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len());
}

fn boot(home: &std::path::Path, origin: &str) -> Child {
    let path = |name: &str| -> PathBuf { std::fs::canonicalize(home).unwrap().join(name) };
    for dir in ["d", "p", "shm"] {
        std::fs::create_dir_all(path(dir)).unwrap();
    }
    std::fs::write(path("bootstrap-token"), TOKEN).unwrap();
    Command::new(env!("CARGO_BIN_EXE_terminalx-serve"))
        .args(["--runtime-kind", "cloud-workspace", "--project-root"])
        .arg(path("p"))
        .arg("--data-dir")
        .arg(path("d"))
        .env("TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_ORIGIN", origin)
        .env("TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_TOKEN_PATH", path("bootstrap-token"))
        .env("TERMINALX_CLOUD_GRANT_DIR", path("shm"))
        .env("HOME", home)
        .env("GIT_CONFIG_GLOBAL", path("gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("SHELL", "/bin/sh")
        .env_remove("TERMINALX_HOME")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn stop(mut child: Child) {
    let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_pending_archive_gets_one_final_checkpoint_report() {
    let (origin, state) = start_server();
    // Short: the control socket path must fit in sun_path.
    let home = tempfile::Builder::new().prefix("txq").tempdir_in("/tmp").unwrap();
    let child = boot(home.path(), &origin);
    let started = Instant::now();
    while state.lock().unwrap().reports.is_empty() && started.elapsed() < WAIT {
        std::thread::sleep(Duration::from_millis(100));
    }
    // Long enough for a second, unwanted report to show up.
    std::thread::sleep(Duration::from_secs(5));
    stop(child);
    let state = state.lock().unwrap();
    assert!(state.capabilities.iter().all(|capabilities| capabilities.split(',').any(|c| c == "quiesce-v1")), "{:?}", state.capabilities);
    assert_eq!(state.reports.len(), 1, "exactly one report: {:?}", state.reports);
    let (bearer, body) = &state.reports[0];
    assert_eq!(bearer, CREDENTIAL, "reported with the runtime credential");
    // No agent tab to save: nothing failed, so the checkpoint is committed.
    assert_eq!(body, &json!({ "v": 1, "operationId": OPERATION, "result": "committed" }));
}
