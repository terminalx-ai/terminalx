//! `kill -9` at every step of the cloud workspace bootstrap neither burns the
//! token nor registers a second identity (PRO-42 acceptance).
//!
//! Each case runs the real `terminalx-serve` binary against a fake bootstrap
//! server with the terminalx-saas semantics, lets a debug-only crash point
//! SIGKILL it at one step, then starts it again and checks that it comes up
//! with one identity and the server's live credential.

#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// A run that takes longer than this is a hang, not a slow test.
const RUN_TIMEOUT: Duration = Duration::from_secs(60);

const TOKEN: &str = "tokentokentokentokentokentokentokentokentok";
/// The token a fenced restart delivers (terminalx-saas PRO-33).
const FENCED_TOKEN: &str = "fencedfencedfencedfencedfencedfencedfencedf";

#[derive(Default)]
struct State {
    /// Token → the relay host id it was redeemed for.
    tokens: HashMap<String, Option<String>>,
    /// The one live runtime credential; every redeem rotates it.
    credential: Option<String>,
    redeem_hosts: Vec<String>,
    redeem_keys: Vec<String>,
    counter: u64,
    /// An older server: a spent token never replays.
    no_replay: bool,
    versions: Vec<String>,
    capabilities: Vec<String>,
}

struct FakeServer {
    origin: String,
    state: Arc<Mutex<State>>,
}

impl FakeServer {
    fn start(no_replay: bool) -> Self {
        Self::start_on(TcpListener::bind("127.0.0.1:0").unwrap(), no_replay)
    }

    fn start_on(listener: TcpListener, no_replay: bool) -> Self {
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let mut state = State { no_replay, ..State::default() };
        state.tokens.insert(TOKEN.into(), None);
        let state = Arc::new(Mutex::new(state));
        let shared = state.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = shared.clone();
                std::thread::spawn(move || handle(stream, &state));
            }
        });
        Self { origin, state }
    }
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
        reader.read_line(&mut header).unwrap();
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
    reader.read_exact(&mut body).unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let bearer = headers.get("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or_default().to_string();
    let answer = {
        let mut state = state.lock().unwrap();
        if let Some(version) = headers.get("x-terminalx-cloud-workspace-runtime-version") {
            state.versions.push(version.clone());
        }
        if let Some(capabilities) = headers.get("x-terminalx-cloud-workspace-runtime-capabilities") {
            state.capabilities.push(capabilities.clone());
        }
        match path.as_str() {
            "/v1/cloud-workspace-bootstrap/redeem" => redeem(&mut state, &bearer, &body),
            "/v1/cloud-workspace-bootstrap/refresh" => refresh(&state, &bearer, &body),
            _ => None,
        }
    };
    let (status, payload) = match answer {
        Some(payload) => ("200 OK", payload),
        None => ("401 Unauthorized", json!({ "error": "cloud_workspace_bootstrap_invalid" })),
    };
    let payload = payload.to_string();
    let mut stream = stream;
    let _ = write!(stream, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len());
}

fn session() -> Value {
    json!({ "v": 1, "workspaceId": "ws_1", "organizationId": "org_1", "relayToken": "a.b.c", "relayTokenExpiresAt": 1, "directorUrl": "https://relay.example" })
}

fn redeem(state: &mut State, token: &str, body: &Value) -> Option<Value> {
    let keys: Vec<&String> = body.as_object()?.keys().collect();
    if keys.len() != 2 {
        return None;
    }
    let host = body["relayHostId"].as_str()?.to_string();
    let key = body["hostPublicKeyB64"].as_str()?.to_string();
    match state.tokens.get(token)? {
        None => {}
        // The replay terminalx-saas allows: same token, same host key.
        Some(bound) if *bound == host && !state.no_replay => {}
        Some(_) => return None,
    }
    state.tokens.insert(token.into(), Some(host.clone()));
    state.redeem_hosts.push(host);
    state.redeem_keys.push(key);
    state.counter += 1;
    let credential = format!("{:0>43}", state.counter);
    state.credential = Some(credential.clone());
    let mut answer = session();
    answer["runtimeCredential"] = json!(credential);
    Some(answer)
}

fn refresh(state: &State, credential: &str, body: &Value) -> Option<Value> {
    if body != &json!({}) || state.credential.as_deref() != Some(credential) {
        return None;
    }
    let mut answer = session();
    answer["attachments"] = json!([]);
    answer["revocations"] = json!([]);
    answer["accessMode"] = json!("private");
    Some(answer)
}

struct Vm {
    _home: tempfile::TempDir,
    data_dir: PathBuf,
    token_path: PathBuf,
    project: PathBuf,
}

impl Vm {
    fn new() -> Self {
        // Short: the control socket path must fit in sun_path.
        let home = tempfile::Builder::new().prefix("txb").tempdir_in("/tmp").unwrap();
        let data_dir = home.path().join("d");
        let project = home.path().join("p");
        std::fs::create_dir_all(&project).unwrap();
        let token_path = home.path().join("bootstrap-token");
        std::fs::write(&token_path, TOKEN).unwrap();
        Self { _home: home, data_dir, token_path, project }
    }

    fn run(&self, origin: &str, crash_at: Option<&str>) -> Output {
        wait_with_timeout(self.spawn(origin, crash_at))
    }

    fn spawn(&self, origin: &str, crash_at: Option<&str>) -> Child {
        let mut command = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"));
        command
            .args(["--runtime-kind", "cloud-workspace", "--self-test"])
            .arg("--project-root")
            .arg(&self.project)
            .arg("--data-dir")
            .arg(&self.data_dir)
            .env("TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_ORIGIN", origin)
            .env("TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_TOKEN_PATH", &self.token_path)
            .env("SHELL", "/bin/sh")
            // A rejection is final at once instead of after ten minutes.
            .env("TERMINALX_SERVE_TEST_REJECTED_WINDOW_MS", "0")
            .env_remove("TERMINALX_HOME")
            .env_remove("TERMINALX_SERVE_TEST_CRASH_AT");
        if let Some(step) = crash_at {
            command.env("TERMINALX_SERVE_TEST_CRASH_AT", step);
        }
        command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap()
    }

    fn state_dir(&self) -> PathBuf {
        std::fs::canonicalize(&self.data_dir).unwrap_or_else(|_| self.data_dir.clone()).join("cloud-workspace")
    }

    fn stored(&self) -> Option<Value> {
        read_json(&self.state_dir().join("runtime.json"))
    }

    fn host_key(&self) -> Option<Vec<u8>> {
        std::fs::read(self.state_dir().join("host-key.json")).ok()
    }
}

fn wait_with_timeout(mut child: Child) -> Output {
    let deadline = Instant::now() + RUN_TIMEOUT;
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!("terminalx-serve hung for {}s\nstderr:\n{}", RUN_TIMEOUT.as_secs(), String::from_utf8_lossy(&output.stderr));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.wait_with_output().unwrap()
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read(path).ok().map(|bytes| serde_json::from_slice(&bytes).unwrap())
}

fn describe(output: &Output) -> String {
    format!("status {:?}\nstdout:\n{}\nstderr:\n{}", output.status, String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr))
}

fn assert_killed(output: &Output, step: &str) {
    assert_eq!(output.status.signal(), Some(9), "expected SIGKILL at {step}: {}", describe(output));
}

fn assert_healthy(vm: &Vm, server: &FakeServer, output: &Output) {
    assert!(output.status.success(), "{}", describe(output));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let ready: Value = stdout.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).find(|line| line["type"] == "ready").expect("a ready line");
    assert_eq!(ready["cloudWorkspace"]["workspaceId"], "ws_1");
    assert!(!vm.token_path.exists(), "the token is deleted once the credential is stored");
    let state = server.state.lock().unwrap();
    let stored = vm.stored().expect("a stored identity");
    assert_eq!(stored["runtimeCredential"].as_str(), state.credential.as_deref(), "the stored credential is the live one");
    // One identity: every redeem, replays included, named the same host.
    let mut hosts = state.redeem_hosts.clone();
    hosts.dedup();
    let mut keys = state.redeem_keys.clone();
    keys.dedup();
    assert_eq!(hosts.len(), 1, "redeems named more than one relay host: {:?}", state.redeem_hosts);
    assert_eq!(keys.len(), 1);
    assert_eq!(stored["relayHostId"], json!(hosts[0]));
    assert_eq!(ready["cloudWorkspace"]["relayHostId"], json!(hosts[0]));
    assert!(state.versions.iter().all(|version| version == &state.versions[0]) && !state.versions.is_empty());
    assert!(state.capabilities.iter().all(|capabilities| capabilities == "organization-access-v1,agent-grants-v1,github-broker-v1,quiesce-v1,collaboration-v1"));
    assert_eq!(ready["cloudWorkspace"]["capabilities"], json!(["organization-access-v1", "agent-grants-v1", "github-broker-v1", "quiesce-v1", "collaboration-v1"]));
}

const STEPS: &[&str] = &[
    // Inside the host key's durable write, before the rename.
    "1:temp-written",
    "host-key-persisted",
    "before-redeem",
    // The server committed the redeem; its answer never reached the disk.
    "after-redeem-response",
    // Inside the identity's durable write, before the rename.
    "2:temp-written",
    "identity-persisted",
    "token-removed",
];

#[test]
fn kill_9_at_each_step_then_restart() {
    for step in STEPS {
        let server = FakeServer::start(false);
        let vm = Vm::new();
        assert_killed(&vm.run(&server.origin, Some(step)), step);
        let key_after_crash = vm.host_key();
        assert!(vm.token_path.exists() || matches!(*step, "token-removed"), "{step}: the token survives until the identity is stored");
        let output = vm.run(&server.origin, None);
        assert_healthy(&vm, &server, &output);
        if let Some(key) = key_after_crash {
            assert_eq!(vm.host_key(), Some(key), "{step}: the host key never changes once written");
        }
        let redeems = server.state.lock().unwrap().redeem_hosts.len();
        let expected = match *step {
            "after-redeem-response" | "2:temp-written" => 2,
            "1:temp-written" | "host-key-persisted" | "before-redeem" | "identity-persisted" | "token-removed" => 1,
            _ => unreachable!(),
        };
        assert_eq!(redeems, expected, "{step}: redeem count");
    }
}

#[test]
fn kill_9_at_every_step_in_one_life() {
    let server = FakeServer::start(false);
    let vm = Vm::new();
    for step in STEPS {
        let output = vm.run(&server.origin, Some(step));
        // Once the identity is stored, later steps are not reached again.
        if output.status.signal() != Some(9) {
            assert!(output.status.success(), "{step}: {}", describe(&output));
        }
    }
    assert_healthy(&vm, &server, &vm.run(&server.origin, None));
    // A restart after success refreshes and never redeems again.
    let before = server.state.lock().unwrap().redeem_hosts.len();
    assert_healthy(&vm, &server, &vm.run(&server.origin, None));
    assert_eq!(server.state.lock().unwrap().redeem_hosts.len(), before);
}

/// A fenced restart revokes the stored credential and delivers a new token
/// next to it. The token wins over the stored identity, and a `kill -9` at
/// any step of that second redeem still ends with one identity, the live
/// credential and the token spent.
#[test]
fn kill_9_during_a_fenced_restart_redeem() {
    // The host key exists by now, so the identity is the first durable write.
    const FENCED_STEPS: &[&str] = &["before-redeem", "after-redeem-response", "1:temp-written", "identity-persisted", "token-removed"];
    for step in FENCED_STEPS {
        let server = FakeServer::start(false);
        let vm = Vm::new();
        assert_healthy(&vm, &server, &vm.run(&server.origin, None));
        let fenced_credential = {
            let mut state = server.state.lock().unwrap();
            state.tokens.insert(FENCED_TOKEN.into(), None);
            state.credential.take()
        };
        std::fs::write(&vm.token_path, FENCED_TOKEN).unwrap();
        assert_killed(&vm.run(&server.origin, Some(step)), step);
        assert!(vm.token_path.exists() || *step == "token-removed", "{step}: the token survives until the identity is stored");
        assert_healthy(&vm, &server, &vm.run(&server.origin, None));
        let stored = vm.stored().unwrap();
        assert_ne!(stored["runtimeCredential"].as_str(), fenced_credential.as_deref(), "{step}: the fenced-out credential is replaced");
        let redeems = server.state.lock().unwrap().redeem_hosts.len();
        let expected = if matches!(*step, "after-redeem-response" | "1:temp-written") { 3 } else { 2 };
        assert_eq!(redeems, expected, "{step}: redeem count");
    }
}

/// While the stored credential still works (a generation-only rotation
/// never revokes it), a delivered token the server refuses is not fatal.
#[test]
fn a_refused_delivered_token_falls_back_to_the_stored_credential() {
    let server = FakeServer::start(false);
    let vm = Vm::new();
    assert_healthy(&vm, &server, &vm.run(&server.origin, None));
    std::fs::write(&vm.token_path, FENCED_TOKEN).unwrap();
    let output = vm.run(&server.origin, None);
    assert!(output.status.success(), "{}", describe(&output));
    assert_eq!(std::fs::read_to_string(&vm.token_path).unwrap(), FENCED_TOKEN, "a token that was never spent is kept");
    assert_eq!(server.state.lock().unwrap().redeem_hosts.len(), 1);
}

/// Against a server without redeem replay, the lost-answer window cannot be
/// recovered, but the token is still not deleted and the runtime stops with
/// the non-restartable exit code instead of looping.
#[test]
fn an_old_server_keeps_the_token_and_exits_3() {
    let server = FakeServer::start(true);
    let vm = Vm::new();
    assert_killed(&vm.run(&server.origin, Some("after-redeem-response")), "after-redeem-response");
    let output = vm.run(&server.origin, None);
    assert_eq!(output.status.code(), Some(3), "{}", describe(&output));
    assert!(vm.token_path.exists());
    assert!(vm.stored().is_none());
}

#[test]
fn a_rejected_token_exits_3_and_is_kept() {
    let server = FakeServer::start(false);
    let vm = Vm::new();
    std::fs::write(&vm.token_path, "otherotherotherotherotherotherotherotherotx").unwrap();
    let output = vm.run(&server.origin, None);
    assert_eq!(output.status.code(), Some(3), "{}", describe(&output));
    assert!(vm.token_path.exists());
}

/// An API that is down at boot is waited for in the process, not by
/// systemd restarts that would hit the unit's start limit.
#[test]
fn an_unreachable_server_is_retried_until_it_answers() {
    let vm = Vm::new();
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let child = vm.spawn(&format!("http://127.0.0.1:{port}"), None);
    std::thread::sleep(Duration::from_millis(1500));
    assert!(vm.token_path.exists(), "the token is kept while the API is down");
    let server = FakeServer::start_on(TcpListener::bind(("127.0.0.1", port)).unwrap(), false);
    let output = wait_with_timeout(child);
    assert_healthy(&vm, &server, &output);
}
