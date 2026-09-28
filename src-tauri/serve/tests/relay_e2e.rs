//! `terminalx-serve` behind a real relay, driven by the desktop's cloud
//! workspace client (PRO-13).
//!
//! Needs the terminalx-saas checkout (its relay code runs in
//! `scripts/remote-runtime/relay-harness.ts`), bun and a Redis, so it is
//! ignored by default. `scripts/remote-runtime/e2e.sh` starts Redis in Docker
//! and runs it:
//!
//! ```sh
//! TERMINALX_SAAS_DIR=~/code/ai/terminalx/terminalx-saas scripts/remote-runtime/e2e.sh
//! ```
//!
//! What it checks, end to end over E2EE through the relay:
//! - the runtime registers outbound and answers an attachment with a pairing code;
//! - the client attaches with a v2 ticket, proves the device token, negotiates
//!   `rpc.hello` and the runtime generation;
//! - a terminal runs a command, and a resent create or write is not repeated;
//! - after the Cell restarts, the runtime re-registers and the client resumes
//!   with its resume credential, replays output from its offset, and a resent
//!   write is still dropped;
//! - forged handles and unknown methods are refused;
//! - a second device (participate) attaches to the same running terminal
//!   read-only;
//! - a stale ticket is refused (4101) and a newer generation fences the runtime.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use raccoon_lib::remote::client::{decode_pairing_code, AttachGrant, AttachSource, AttachTicket, ClientEvent, ClientState, OpenOutcome, Supervisor};
use raccoon_lib::remote::host::relay_host_id_for_secret;
use raccoon_lib::remote::protocol::Activation;
use serde_json::{json, Value};
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(45);

struct Harness {
    child: Child,
    control: String,
    director: String,
}

impl Harness {
    fn start() -> Self {
        let saas = PathBuf::from(std::env::var("TERMINALX_SAAS_DIR").expect("TERMINALX_SAAS_DIR names the terminalx-saas checkout"));
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/remote-runtime/relay-harness.ts");
        let mut child = Command::new(std::env::var("BUN").unwrap_or_else(|_| "bun".into()))
            .arg(script)
            .current_dir(saas.join("apps/relay"))
            .env("TERMINALX_SAAS_DIR", &saas)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start the relay harness (is bun on PATH?)");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let ready: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("harness said {line:?}"));
        Self {
            child,
            control: ready["controlUrl"].as_str().unwrap().into(),
            director: ready["directorUrl"].as_str().unwrap().into(),
        }
    }

    fn post(&self, path: &str, body: Value) -> Value {
        ureq::post(&format!("{}{path}", self.control)).send_json(body).unwrap().into_json().unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

struct Runtime {
    child: Child,
    status: Arc<Mutex<Vec<Value>>>,
}

impl Runtime {
    fn start(root: &Path, data: &Path, link: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"))
            .args(["--runtime-kind", "cloud-workspace", "--project-root"])
            .arg(root)
            .arg("--data-dir")
            .arg(data)
            .arg("--relay-link")
            .arg(link)
            .env("RUST_LOG", "info")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let status = Arc::new(Mutex::new(Vec::new()));
        let lines = status.clone();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    lines.lock().unwrap().push(value);
                }
            }
        });
        Self { child, status }
    }

    fn wait_for_relay(&self, state: &str) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(found) = self.status.lock().unwrap().iter().rev().find(|line| line["type"] == "relay" && line["status"]["state"] == state) {
                return found.clone();
            }
            assert!(Instant::now() < deadline, "runtime never reached {state}: {:?}", self.status.lock().unwrap());
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc_kill(self.child.id() as i32, 15);
        }
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, signal: i32) -> i32;
}

/// The API's `open`, played by the test: the pairing code the runtime
/// published for the attachment, plus a ticket signed for `generation`.
struct TestSource {
    harness_control: String,
    pairing: PathBuf,
    attachment_id: String,
    device_id: String,
    relay_host_id: String,
    generation: Mutex<u64>,
}

impl AttachSource for TestSource {
    fn open(&self, _refresh_pairing: bool, _activation: Activation) -> anyhow::Result<OpenOutcome> {
        let Ok(code) = std::fs::read_to_string(&self.pairing) else { return Ok(OpenOutcome::WaitingForRuntime) };
        let generation = *self.generation.lock().unwrap();
        let ticket: Value = ureq::post(&format!("{}/ticket", self.harness_control))
            .send_json(json!({ "relayHostId": self.relay_host_id, "runtimeGeneration": generation, "deviceId": self.device_id, "attachmentId": self.attachment_id }))?
            .into_json()?;
        Ok(OpenOutcome::Ready(Box::new(AttachGrant {
            attachment_id: self.attachment_id.clone(),
            offer: decode_pairing_code(&code)?,
            ticket: Some(AttachTicket {
                token: ticket["token"].as_str().unwrap().into(),
                expires_at: ticket["expiresAt"].as_i64().unwrap(),
                runtime_generation: generation,
            }),
        })))
    }
}

struct Client {
    supervisor: Supervisor,
    events: mpsc::UnboundedReceiver<ClientEvent>,
    notifications: Vec<Value>,
    states: Vec<ClientState>,
    next: u64,
}

impl Client {
    fn start(source: Arc<TestSource>) -> Self {
        let (tx, events) = mpsc::unbounded_channel();
        let supervisor = Supervisor::start(source, Activation::Connect, tx);
        Self { supervisor, events, notifications: Vec::new(), states: Vec::new(), next: 0 }
    }

    async fn state(&mut self, want: impl Fn(&ClientState) -> bool) -> ClientState {
        if let Some(found) = self.states.iter().rev().find(|state| want(state)) {
            let found = found.clone();
            self.states.clear();
            return found;
        }
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            match tokio::time::timeout_at(deadline, self.events.recv()).await.expect("client state").unwrap() {
                ClientEvent::State(state) if want(&state) => {
                    self.states.clear();
                    return state;
                }
                ClientEvent::State(state) => self.states.push(state),
                ClientEvent::Message(message) => self.notifications.push(message),
            }
        }
    }

    async fn connected(&mut self) -> ClientState {
        self.state(|state| matches!(state, ClientState::Connected { .. })).await
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = format!("test-{}", self.next);
        assert!(self.supervisor.send(json!({ "id": id, "method": method, "params": params })), "{method}: not connected");
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            match tokio::time::timeout_at(deadline, self.events.recv()).await.unwrap_or_else(|_| panic!("{method} timed out")).unwrap() {
                ClientEvent::Message(message) if message["id"] == id.as_str() => return message,
                ClientEvent::Message(message) => self.notifications.push(message),
                ClientEvent::State(state) => self.states.push(state),
            }
        }
    }

    async fn ok(&mut self, method: &str, params: Value) -> Value {
        let response = self.call(method, params).await;
        assert_eq!(response["ok"], true, "{method}: {response}");
        response["result"].clone()
    }

    async fn refused(&mut self, method: &str, params: Value) -> String {
        let response = self.call(method, params).await;
        assert_eq!(response["ok"], false, "{method} should be refused: {response}");
        response["error"]["code"].as_str().unwrap().to_string()
    }

    /// Terminal output from notifications until `marker` appears.
    async fn output_until(&mut self, pty_id: &str, marker: &str) -> String {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let output: String = self
                .notifications
                .iter()
                .filter(|n| n["event"] == "pty.output" && n["params"]["ptyId"] == pty_id)
                .map(|n| String::from_utf8_lossy(&STANDARD.decode(n["params"]["data"].as_str().unwrap()).unwrap()).into_owned())
                .collect();
            if output.contains(marker) {
                return output;
            }
            match tokio::time::timeout_at(deadline, self.events.recv()).await.unwrap_or_else(|_| panic!("no {marker} in {output:?}")).unwrap() {
                ClientEvent::Message(message) => self.notifications.push(message),
                ClientEvent::State(state) => self.states.push(state),
            }
        }
    }
}

fn write_link(path: &Path, secret: &[u8; 32], relay_token: &str, director: &str, attachments: Value) {
    let temporary = path.with_extension("new");
    std::fs::write(
        &temporary,
        json!({ "v": 1, "hostSecretB64": STANDARD.encode(secret), "relayToken": relay_token, "directorUrl": director, "attachments": attachments }).to_string(),
    )
    .unwrap();
    std::fs::rename(temporary, path).unwrap();
}

fn attachment(id: &str, device: &str, token: &str, scope: &str) -> Value {
    let expires = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + 10 * 60_000;
    json!({ "id": id, "deviceId": device, "deviceToken": token, "scope": scope, "expiresAt": expires })
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs terminalx-saas, bun and Redis: scripts/remote-runtime/e2e.sh"]
async fn desktop_drives_a_remote_runtime_through_the_relay() {
    let harness = Harness::start();
    let dir = tempfile::tempdir().unwrap();
    // Short: the data dir holds the control socket.
    let root = dir.path().join("ws");
    let data = PathBuf::from(format!("/tmp/tx-e2e-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(&root).unwrap();
    std::process::Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&root).status().unwrap();

    let mut secret = [0u8; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let relay_host_id = relay_host_id_for_secret(secret);
    let token = |generation: u64| {
        harness.post("/runtime-token", json!({ "relayHostId": relay_host_id, "runtimeGeneration": generation }))["relayToken"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let link = dir.path().join("link.json");
    let manage_token = uuid::Uuid::new_v4().simple().to_string();
    write_link(&link, &secret, &token(7), &harness.director, json!([attachment("att-manage", "desktop-manage", &manage_token, "runtime")]));
    let runtime = Runtime::start(&root, &data, &link);
    let registered = runtime.wait_for_relay("registered");
    assert_eq!(registered["status"]["runtimeGeneration"], 7);
    assert_eq!(registered["status"]["relayHostId"], relay_host_id.as_str());

    let pairing_dir = dir.path().join("link.json.attachments");
    let source = Arc::new(TestSource {
        harness_control: harness.control.clone(),
        pairing: pairing_dir.join("att-manage.pairing"),
        attachment_id: "att-manage".into(),
        device_id: "desktop-manage".into(),
        relay_host_id: relay_host_id.clone(),
        generation: Mutex::new(7),
    });
    let mut client = Client::start(source.clone());
    let ClientState::Connected { runtime_generation, capabilities, authority, .. } = client.connected().await else { unreachable!() };
    assert_eq!(runtime_generation, 7);
    assert_eq!(capabilities, ["pty/1", "fs/1", "git/1", "session/1"]);
    assert_eq!(authority, "manage");

    // A terminal, created once even when the create is resent.
    let created = client.ok("pty.create", json!({ "cols": 100, "rows": 30, "clientRequestId": "e2e-pty-create-1" })).await;
    let again = client.ok("pty.create", json!({ "cols": 100, "rows": 30, "clientRequestId": "e2e-pty-create-1" })).await;
    assert_eq!(created, again);
    let pty_id = created["ptyId"].as_str().unwrap().to_string();
    client.ok("pty.attach", json!({ "ptyId": pty_id })).await;
    let command = "echo e2e-$((6*7))-ok\n";
    assert_eq!(client.ok("pty.write", json!({ "ptyId": pty_id, "data": command, "seq": 1 })).await["applied"], true);
    let output = client.output_until(&pty_id, "e2e-42-ok").await;
    assert_eq!(output.matches("e2e-42-ok").count(), 1);

    // Files and Git through the same channel.
    client.ok("fs.write", json!({ "path": "hello.txt", "text": "hi", "expectedEtag": null, "clientRequestId": "e2e-fs-write-1" })).await;
    assert_eq!(client.ok("fs.read", json!({ "path": "hello.txt" })).await["text"], "hi");
    assert_eq!(client.ok("git.status", json!({})).await["files"][0]["path"], "hello.txt");

    // Forged handles and arbitrary IPC are refused.
    assert_eq!(client.refused("pty.write", json!({ "ptyId": "remote-pty-forged", "data": "x", "seq": 1 })).await, "not_found");
    assert_eq!(client.refused("desktop.invoke", json!({ "command": "open_path" })).await, "method_not_found");
    assert_eq!(client.refused("fs.read", json!({ "path": "../link.json" })).await, "path_forbidden");

    // The Cell restarts: the runtime re-registers, the client resumes with
    // its resume credential (the invite was single-use) and nothing repeats.
    harness.post("/restart-cell", json!({}));
    client.state(|state| matches!(state, ClientState::Reconnecting { .. })).await;
    client.connected().await;
    assert_eq!(client.ok("pty.write", json!({ "ptyId": pty_id, "data": command, "seq": 1 })).await["applied"], false);
    let replay = client.ok("pty.attach", json!({ "ptyId": pty_id, "sinceOffset": 0, "runtimeGeneration": 7 })).await;
    let replayed = String::from_utf8_lossy(&STANDARD.decode(replay["data"].as_str().unwrap()).unwrap()).into_owned();
    assert_eq!(replayed.matches("e2e-42-ok").count(), 1, "{replayed}");
    let replay_again = client.ok("fs.write", json!({ "path": "hello.txt", "text": "changed", "expectedEtag": null, "clientRequestId": "e2e-fs-write-1" })).await;
    assert_eq!(replay_again["size"], 2, "a resent write returns its first result");
    assert_eq!(std::fs::read_to_string(root.join("hello.txt")).unwrap(), "hi");

    // A second device, participating, attaches to the same running terminal.
    let participant_token = uuid::Uuid::new_v4().simple().to_string();
    write_link(
        &link,
        &secret,
        &token(7),
        &harness.director,
        json!([
            attachment("att-manage", "desktop-manage", &manage_token, "runtime"),
            attachment("att-participate", "desktop-participate", &participant_token, "session")
        ]),
    );
    let second_source = Arc::new(TestSource {
        harness_control: harness.control.clone(),
        pairing: pairing_dir.join("att-participate.pairing"),
        attachment_id: "att-participate".into(),
        device_id: "desktop-participate".into(),
        relay_host_id: relay_host_id.clone(),
        generation: Mutex::new(7),
    });
    let mut second = Client::start(second_source);
    let ClientState::Connected { authority, .. } = second.connected().await else { unreachable!() };
    assert_eq!(authority, "participate");
    let watched = second.ok("pty.attach", json!({ "ptyId": pty_id, "sinceOffset": 0, "runtimeGeneration": 7 })).await;
    assert!(String::from_utf8_lossy(&STANDARD.decode(watched["data"].as_str().unwrap()).unwrap()).contains("e2e-42-ok"));
    assert_eq!(second.refused("pty.write", json!({ "ptyId": pty_id, "data": "whoami\n", "seq": 1 })).await, "forbidden");
    client.ok("pty.write", json!({ "ptyId": pty_id, "data": "echo shared-$((2+3))\n", "seq": 2 })).await;
    second.output_until(&pty_id, "shared-5").await;
    second.supervisor.stop();

    // A ticket for an older generation is refused by the relay's fence.
    let stale = Arc::new(TestSource {
        harness_control: harness.control.clone(),
        pairing: pairing_dir.join("att-manage.pairing"),
        attachment_id: "att-manage".into(),
        device_id: "desktop-manage".into(),
        relay_host_id: relay_host_id.clone(),
        generation: Mutex::new(6),
    });
    let mut stale_client = Client::start(stale);
    let refused = stale_client
        .state(|state| matches!(state, ClientState::Reconnecting { reason, .. } if reason.starts_with("4101")))
        .await;
    assert!(matches!(refused, ClientState::Reconnecting { .. }));
    stale_client.supervisor.stop();

    // A ticket for a newer generation (the API rebooted the runtime) raises
    // the relay's fence even though this client's invite is spent (4401), so
    // the old runtime can no longer register: after the Cell restarts it is
    // fenced (4101) and stays down instead of serving stale state.
    *source.generation.lock().unwrap() = 8;
    client.supervisor.stop();
    let mut newer = Client::start(source.clone());
    newer.state(|state| matches!(state, ClientState::Reconnecting { reason, .. } if reason.starts_with("4401"))).await;
    newer.supervisor.stop();
    harness.post("/restart-cell", json!({}));
    runtime.wait_for_relay("fenced");
    let _ = std::fs::remove_dir_all(&data);
}
