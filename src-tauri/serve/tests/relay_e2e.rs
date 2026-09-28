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

impl Client {
    /// The next notification matching `want`, keeping the rest for later.
    async fn notification(&mut self, want: impl Fn(&Value) -> bool) -> Value {
        if let Some(index) = self.notifications.iter().position(&want) {
            return self.notifications.remove(index);
        }
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            match tokio::time::timeout_at(deadline, self.events.recv()).await.expect("notification").unwrap() {
                ClientEvent::Message(message) if want(&message) => return message,
                ClientEvent::Message(message) => self.notifications.push(message),
                ClientEvent::State(state) => self.states.push(state),
            }
        }
    }

    /// Follow one terminal's output from `offset` until `marker`, checking
    /// every byte arrives once and in order; a `pty.lagged` stream is picked
    /// up again from the last byte, as the desktop client does.
    async fn follow(&mut self, pty_id: &str, epoch: &str, mut offset: u64, marker: &str) -> (String, u64, u32) {
        let mut output = Vec::new();
        let mut lagged = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        // What arrived while a call was awaited comes first, in order.
        let (buffered, rest): (Vec<Value>, Vec<Value>) = std::mem::take(&mut self.notifications).into_iter().partition(|n| n["params"]["ptyId"] == pty_id);
        let mut buffered = std::collections::VecDeque::from(buffered);
        self.notifications = rest;
        while !String::from_utf8_lossy(&output).contains(marker) {
            let event = match buffered.pop_front() {
                Some(event) => event,
                None => match tokio::time::timeout_at(deadline, self.events.recv()).await.unwrap_or_else(|_| {
                    let tail = String::from_utf8_lossy(&output);
                    panic!("no {marker} after offset {offset}; got {:?}; states {:?}", &tail[tail.len().saturating_sub(400)..], self.states)
                }).unwrap() {
                    ClientEvent::Message(message) => message,
                    ClientEvent::State(state @ ClientState::Connected { .. }) => {
                        // A new connection has no subscriptions: resume from
                        // the last byte, as the desktop client does.
                        eprintln!("follow: reconnected at offset {offset}; resuming");
                        self.states.push(state);
                        let resumed = self
                            .ok("pty.attach", json!({ "ptyId": pty_id, "sinceOffset": offset, "runtimeGeneration": 7, "epoch": epoch }))
                            .await;
                        output.extend(STANDARD.decode(resumed["data"].as_str().unwrap()).unwrap());
                        offset = resumed["end"].as_u64().unwrap();
                        continue;
                    }
                    ClientEvent::State(state) => {
                        self.states.push(state);
                        continue;
                    }
                },
            };
            if event["params"]["ptyId"] != pty_id {
                self.notifications.push(event);
                continue;
            }
            match event["event"].as_str() {
                Some("pty.output") => {
                    let at = event["params"]["offset"].as_u64().unwrap();
                    let chunk = STANDARD.decode(event["params"]["data"].as_str().unwrap()).unwrap();
                    if at + chunk.len() as u64 <= offset {
                        continue;
                    }
                    assert!(at <= offset, "a gap in terminal output: expected {offset}, got {at}");
                    output.extend(&chunk[(offset - at) as usize..]);
                    offset = at + chunk.len() as u64;
                }
                Some("pty.lagged") => {
                    lagged += 1;
                    assert_eq!(event["params"]["offset"].as_u64(), Some(offset), "lagged names the first byte not sent");
                    let resumed = self
                        .ok("pty.attach", json!({ "ptyId": pty_id, "sinceOffset": offset, "runtimeGeneration": 7, "epoch": epoch }))
                        .await;
                    assert_eq!(resumed["truncated"], false, "the ring still held what was not sent");
                    output.extend(STANDARD.decode(resumed["data"].as_str().unwrap()).unwrap());
                    offset = resumed["end"].as_u64().unwrap();
                }
                _ => {}
            }
        }
        (String::from_utf8_lossy(&output).into_owned(), offset, lagged)
    }
}

fn source(harness: &Harness, pairing_dir: &Path, attachment: &str, device: &str, relay_host_id: &str) -> Arc<TestSource> {
    Arc::new(TestSource {
        harness_control: harness.control.clone(),
        pairing: pairing_dir.join(format!("{attachment}.pairing")),
        attachment_id: attachment.into(),
        device_id: device.into(),
        relay_host_id: relay_host_id.into(),
        generation: Mutex::new(7),
    })
}

/// PRO-26: interactive shells of a cloud workspace, over the relay.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs terminalx-saas, bun and Redis: scripts/remote-runtime/e2e.sh"]
async fn cloud_terminals_keep_identity_order_and_ownership_through_the_relay() {
    let harness = Harness::start();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("ws");
    let data = PathBuf::from(format!("/tmp/tx-e2e-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(&root).unwrap();
    let mut secret = [0u8; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let relay_host_id = relay_host_id_for_secret(secret);
    let relay_token = harness.post("/runtime-token", json!({ "relayHostId": relay_host_id, "runtimeGeneration": 7 }))["relayToken"]
        .as_str()
        .unwrap()
        .to_string();
    let link = dir.path().join("link.json");
    let tokens: Vec<String> = (0..3).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect();
    write_link(
        &link,
        &secret,
        &relay_token,
        &harness.director,
        json!([
            attachment("att-desk", "desktop-desk", &tokens[0], "runtime"),
            attachment("att-laptop", "desktop-laptop", &tokens[1], "runtime"),
            attachment("att-phone", "mobile-phone", &tokens[2], "session")
        ]),
    );
    let mut runtime = Runtime::start(&root, &data, &link);
    runtime.wait_for_relay("registered");
    let pairing_dir = dir.path().join("link.json.attachments");

    let mut desk = Client::start(source(&harness, &pairing_dir, "att-desk", "desktop-desk", &relay_host_id));
    let ClientState::Connected { runtime_epoch: epoch, .. } = desk.connected().await else { unreachable!() };
    assert!(epoch.starts_with("epoch-"), "{epoch}");

    // A workspace-bound shell, identified by id, epoch and process.
    let created = desk.ok("pty.create", json!({ "cols": 100, "rows": 30, "clientRequestId": "e2e-term-create-1" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_string();
    assert_eq!((created["epoch"].as_str(), created["number"].as_u64(), created["control"].as_str()), (Some(epoch.as_str()), Some(1), Some("you")));
    let pid = created["pid"].as_u64().expect("the shell's pid");
    desk.ok("pty.attach", json!({ "ptyId": pty_id })).await;
    // The desk's writer: one seq per accepted write; a refusal gives it back.
    let seq = std::cell::Cell::new(0u64);
    let write = |data: &str| {
        seq.set(seq.get() + 1);
        json!({ "ptyId": pty_id, "data": data, "seq": seq.get(), "writerId": "desk-1", "epoch": epoch })
    };

    // An interactive program: it prompts, waits for input and answers.
    // (The prompt is assembled by printf so the command's own echo never matches it.)
    desk.ok("pty.write", write("printf 'na%s? ' me; read who; echo hello-$who-$((40+2))\n")).await;
    let (_, offset, _) = desk.follow(&pty_id, &epoch, 0, "name? ").await;
    desk.ok("pty.write", write("relay\n")).await;
    let (_, offset, _) = desk.follow(&pty_id, &epoch, offset, "hello-relay-42").await;

    // Sustained output: ~1.9 MB crosses the relay once, in order, gap-free.
    desk.ok("pty.write", write("seq 1 300000; echo flood-$((1+1))-done\n")).await;
    let (flood, offset, lagged) = desk.follow(&pty_id, &epoch, offset, "flood-2-done").await;
    assert!(flood.contains("\r\n299999\r\n300000\r\n"), "the tail of the flood arrived");
    assert!(flood.contains("\r\n150000\r\n150001\r\n"), "the middle of the flood arrived");
    eprintln!("sustained output: {} bytes, {lagged} lagged resumes", flood.len());

    // A second desktop watches; input and size stay with the controller.
    let mut laptop = Client::start(source(&harness, &pairing_dir, "att-laptop", "desktop-laptop", &relay_host_id));
    laptop.connected().await;
    let watching = laptop.ok("pty.attach", json!({ "ptyId": pty_id, "sinceOffset": offset, "runtimeGeneration": 7, "epoch": epoch })).await;
    assert_eq!(watching["control"], "other");
    assert_eq!(laptop.refused("pty.resize", json!({ "ptyId": pty_id, "cols": 50, "rows": 10 })).await, "not_controller");
    assert_eq!(
        laptop.refused("pty.write", json!({ "ptyId": pty_id, "data": "ls\n", "seq": 1, "writerId": "laptop-1" })).await,
        "not_controller"
    );
    desk.ok("pty.resize", json!({ "ptyId": pty_id, "cols": 120, "rows": 40 })).await;
    let resized = laptop.notification(|n| n["event"] == "pty.resized").await;
    assert_eq!((resized["params"]["cols"].as_u64(), resized["params"]["rows"].as_u64()), (Some(120), Some(40)));
    // Taking over is explicit and announced.
    let taken = laptop.ok("pty.control", json!({ "ptyId": pty_id, "cols": 90, "rows": 25, "epoch": epoch })).await;
    assert_eq!(taken["control"], "you");
    assert_eq!(desk.notification(|n| n["event"] == "pty.control").await["params"]["control"], "other");
    assert_eq!(desk.refused("pty.write", write("echo desk\n")).await, "not_controller");
    seq.set(seq.get() - 1); // refused: the seq was not spent
    laptop.ok("pty.write", json!({ "ptyId": pty_id, "data": "stty size\n", "seq": 1, "writerId": "laptop-1" })).await;
    laptop.follow(&pty_id, &epoch, offset, "25 90").await;

    // The phone's scope watches only: no input, size or control.
    let mut phone = Client::start(source(&harness, &pairing_dir, "att-phone", "mobile-phone", &relay_host_id));
    let ClientState::Connected { authority, .. } = phone.connected().await else { unreachable!() };
    assert_eq!(authority, "participate");
    assert_eq!(phone.ok("pty.list", json!({})).await["terminals"][0]["ptyId"], pty_id.as_str());
    phone.ok("pty.attach", json!({ "ptyId": pty_id })).await;
    for method in ["pty.resize", "pty.control", "pty.write", "pty.kill"] {
        let refused = phone.refused(method, json!({ "ptyId": pty_id, "cols": 10, "rows": 10, "data": "x", "seq": 1 })).await;
        assert_eq!(refused, "forbidden", "{method}");
    }
    phone.supervisor.stop();

    // Stale and forged terminal ids reach nothing.
    assert_eq!(desk.refused("pty.write", json!({ "ptyId": "remote-pty-forged", "data": "x", "seq": 1 })).await, "not_found");
    assert_eq!(
        desk.refused("pty.write", json!({ "ptyId": pty_id, "data": "x", "seq": 1, "writerId": "old", "epoch": "epoch-stale" })).await,
        "not_found"
    );
    assert_eq!(
        desk.refused("pty.attach", json!({ "ptyId": pty_id, "sinceOffset": 0, "runtimeGeneration": 7, "epoch": "epoch-stale" })).await,
        "cursor_expired"
    );

    // The Cell restarts: both reconnect to the same process and terminal.
    harness.post("/restart-cell", json!({}));
    desk.state(|state| matches!(state, ClientState::Reconnecting { .. })).await;
    let ClientState::Connected { runtime_epoch: after, .. } = desk.connected().await else { unreachable!() };
    assert_eq!(after, epoch, "same runtime process");
    let listed = desk.ok("pty.list", json!({})).await;
    assert_eq!((listed["terminals"][0]["ptyId"].as_str(), listed["terminals"][0]["pid"].as_u64()), (Some(pty_id.as_str()), Some(pid)));
    let resumed = desk.ok("pty.attach", json!({ "ptyId": pty_id, "sinceOffset": offset, "runtimeGeneration": 7, "epoch": epoch })).await;
    assert_eq!(resumed["offset"].as_u64(), Some(offset));
    desk.ok("pty.control", json!({ "ptyId": pty_id })).await;
    // A resend of an applied write is not typed again after the reconnect.
    assert_eq!(desk.ok("pty.write", json!({ "ptyId": pty_id, "data": "x", "seq": seq.get(), "writerId": "desk-1", "epoch": epoch })).await["applied"], false);
    desk.ok("pty.write", write("echo same-shell-$$\n")).await;
    desk.follow(&pty_id, &epoch, resumed["end"].as_u64().unwrap(), &format!("same-shell-{pid}")).await;
    laptop.supervisor.stop();

    // The shell exits: reported, and input to it is refused, not dropped.
    desk.ok("pty.write", write("exit 7\n")).await;
    let exit = desk.notification(|n| n["event"] == "pty.exit").await;
    assert_eq!(exit["params"]["code"], 7);
    assert_eq!(desk.refused("pty.write", write("echo late\n")).await, "unavailable");
    desk.ok("pty.kill", json!({ "ptyId": pty_id })).await;
    assert_eq!(desk.ok("pty.list", json!({})).await["terminals"], json!([]));

    // The runtime stops and a new process starts in the same generation (a
    // resume): the client reconnects to a new epoch, and nothing addressed
    // to the old process's terminals reaches the new one.
    let second = desk.ok("pty.create", json!({ "clientRequestId": "e2e-term-create-2" })).await;
    let second_id = second["ptyId"].as_str().unwrap().to_string();
    drop(runtime);
    desk.state(|state| matches!(state, ClientState::Reconnecting { .. } | ClientState::WaitingForRuntime)).await;
    runtime = Runtime::start(&root, &data, &link);
    runtime.wait_for_relay("registered");
    let ClientState::Connected { runtime_epoch: restarted, .. } = desk.connected().await else { unreachable!() };
    assert_ne!(restarted, epoch, "a new runtime process");
    assert_eq!(desk.ok("pty.list", json!({})).await["terminals"], json!([]));
    assert_eq!(
        desk.refused("pty.write", json!({ "ptyId": second_id, "data": "x", "seq": 1, "writerId": "desk-2", "epoch": epoch })).await,
        "not_found"
    );
    assert_eq!(desk.refused("pty.attach", json!({ "ptyId": second_id })).await, "not_found");
    desk.supervisor.stop();
    drop(runtime);
    let _ = std::fs::remove_dir_all(&data);
}
