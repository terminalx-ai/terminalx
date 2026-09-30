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
//!
//! PRO-22 (`cloud_agent_tabs_…`): agent tabs run the fake Claude Code
//! (`scripts/remote-runtime/fake-claude`, needs python3) under the real
//! harness, and every send, steer, stop and decision goes through a fake API
//! mailbox (`common/mailbox.rs`) encrypted under the key from `keys.get`:
//! two tabs in parallel, a cut stream resumed by cursor, a queued follow-up,
//! an approval acked from its receipt after a redelivery, steering, stop,
//! a turn finishing while nobody is attached (and its checkpoint), and a
//! runtime restart (receipts, keys and the dead turn reported honestly).
//!
//! PRO-30 (`a_shared_workspace_…`): two members the workspace is shared
//! with (a driver and an approving viewer), a member it is not shared with,
//! and the admin: roles from the API's list, presence, attributed notes that
//! never reach the agent, the driver lease serializing competing sends,
//! permission decisions by approval right, and a mid-turn revocation that
//! closes the connection, drops the queued input and rotates the key, then a
//! reconnect under the new role.
//!
//! PRO-24 (`cloud_files_…`): files in bounded parts, change notifications,
//! a save refused after an agent's edit and made after a reconnect, a staged
//! large write, bounded search, symlink escapes and a participant's limits.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use raccoon_lib::remote::client::{decode_pairing_code, AttachGrant, AttachSource, AttachTicket, ClientEvent, ClientState, OpenOutcome, Supervisor};
use raccoon_lib::remote::host::relay_host_id_for_secret;
use raccoon_lib::remote::protocol::{Activation, CAPABILITIES};
use serde_json::{json, Value};
use tokio::sync::mpsc;

mod common;

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
        Self::start_with_env(root, data, link, &[])
    }

    fn start_with_env(root: &Path, data: &Path, link: &Path, env: &[(&str, &Path)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"))
            .envs(env.iter().map(|(key, value)| (*key, *value)))
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
    /// Session subscriptions this connection holds; notifications for any
    /// other (an earlier connection's) are dropped, as the desktop does.
    subscriptions: std::collections::HashSet<String>,
}

impl Client {
    fn start(source: Arc<TestSource>) -> Self {
        let (tx, events) = mpsc::unbounded_channel();
        let supervisor = Supervisor::start(source, Activation::Connect, tx);
        Self { supervisor, events, notifications: Vec::new(), states: Vec::new(), next: 0, subscriptions: Default::default() }
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
    // The supervisor asks for every namespace version this build speaks.
    assert_eq!(capabilities, CAPABILITIES);
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

    /// Follow a subscription from its `pty.attach` answer: the bytes the
    /// answer replayed count as output, and live output continues after them.
    /// (Following from the offset asked for instead would see the first live
    /// event start past it whenever the replay was not empty: a gap that is
    /// only the harness ignoring the answer.)
    async fn follow_attached(&mut self, pty_id: &str, epoch: &str, attached: &Value, marker: &str) -> (String, u64, u32) {
        let replayed = String::from_utf8_lossy(&STANDARD.decode(attached["data"].as_str().unwrap()).unwrap()).into_owned();
        if replayed.contains(marker) {
            return (replayed, attached["end"].as_u64().unwrap(), 0);
        }
        let (rest, end, lagged) = self.follow(pty_id, epoch, attached["end"].as_u64().unwrap(), marker).await;
        (replayed + &rest, end, lagged)
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
    let attached = desk.ok("pty.attach", json!({ "ptyId": pty_id })).await;
    // The desk's writer: one seq per accepted write; a refusal gives it back.
    let seq = std::cell::Cell::new(0u64);
    let write = |data: &str| {
        seq.set(seq.get() + 1);
        json!({ "ptyId": pty_id, "data": data, "seq": seq.get(), "writerId": "desk-1", "epoch": epoch })
    };

    // An interactive program: it prompts, waits for input and answers.
    // (The prompt is assembled by printf so the command's own echo never matches it.)
    desk.ok("pty.write", write("printf 'na%s? ' me; read who; echo hello-$who-$((40+2))\n")).await;
    let (_, offset, _) = desk.follow_attached(&pty_id, &epoch, &attached, "name? ").await;
    desk.ok("pty.write", write("relay\n")).await;
    let (_, offset, _) = desk.follow(&pty_id, &epoch, offset, "hello-relay-42").await;

    // Sustained output: ~1.9 MB crosses the relay once, in order, gap-free.
    desk.ok("pty.write", write("seq 1 300000; echo flood-$((1+1))-done\n")).await;
    let (flood, offset, lagged) = desk.follow(&pty_id, &epoch, offset, "flood-2-done").await;
    assert!(flood.contains("\r\n299999\r\n300000\r\n"), "the tail of the flood arrived");
    assert!(flood.contains("\r\n150000\r\n150001\r\n"), "the middle of the flood arrived");
    eprintln!("sustained output: {} bytes, {lagged} lagged resumes", flood.len());
    // Output that exists before the second desktop attaches.
    desk.ok("pty.write", write("echo before-$((3*3))-watching\n")).await;
    let before = offset;
    let (_, offset, _) = desk.follow(&pty_id, &epoch, offset, "before-9-watching").await;

    // A second desktop watches; input and size stay with the controller.
    let mut laptop = Client::start(source(&harness, &pairing_dir, "att-laptop", "desktop-laptop", &relay_host_id));
    laptop.connected().await;
    // It attaches from before that output, so its answer always replays
    // bytes and its live output starts after them.
    let watching = laptop.ok("pty.attach", json!({ "ptyId": pty_id, "sinceOffset": before, "runtimeGeneration": 7, "epoch": epoch })).await;
    assert_eq!(watching["offset"].as_u64(), Some(before));
    assert!(watching["end"].as_u64().unwrap() >= offset, "the answer replays up to what the desk has seen");
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
    let (watched, _, _) = laptop.follow_attached(&pty_id, &epoch, &watching, "25 90").await;
    assert_eq!(watched.matches("before-9-watching").count(), 1, "replayed once, then live without a gap: {watched}");

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
    desk.follow_attached(&pty_id, &epoch, &resumed, &format!("same-shell-{pid}")).await;
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

// ---------------------------------------------------------------- PRO-22

/// A tab's committed agent events as one client saw them, from subscription
/// replays and live `session.event` notifications.
#[derive(Default)]
struct Feed {
    events: Vec<Value>,
    cursor: Option<String>,
}

impl Feed {
    fn texts(&self, kind: &str) -> Vec<String> {
        common::agent::texts(&self.events, kind)
    }

    fn count(&self, kind: &str) -> usize {
        common::agent::count(&self.events, kind)
    }

    /// Take one event. Seqs only grow: an older one must be a replay of an
    /// event already held (a resubscribe's overlap), never a new one.
    fn push(&mut self, event: Value, cursor: Option<String>) {
        let seq = event["seq"].as_u64().expect("an event seq");
        if let Some(last) = self.events.last().and_then(|e| e["seq"].as_u64()) {
            if seq <= last {
                assert!(
                    self.events.iter().any(|e| e["id"] == event["id"]),
                    "an event went back in time: {seq} after {last}: {event}\nheld: {:?}",
                    self.events.iter().map(|e| (e["seq"].as_u64(), e["payload"]["type"].as_str().map(String::from), e["payload"]["text"].as_str().map(String::from))).collect::<Vec<_>>()
                );
                return;
            }
        }
        self.events.push(event);
        if cursor.is_some() {
            self.cursor = cursor;
        }
    }
}

type Feeds = std::collections::HashMap<String, Feed>;

impl Client {
    async fn subscribe_tab(&mut self, feeds: &mut Feeds, session_id: &str, tab_id: &str) -> String {
        let feed = feeds.entry(tab_id.to_string()).or_default();
        let mut params = json!({ "sessionId": session_id, "tabId": tab_id });
        if let Some(cursor) = &feed.cursor {
            params["sinceCursor"] = json!(cursor);
        }
        let result = self.ok("session.subscribe", params).await;
        let feed = feeds.get_mut(tab_id).unwrap();
        for entry in result["events"].as_array().unwrap() {
            feed.push(entry["event"].clone(), entry["cursor"].as_str().map(String::from));
        }
        if let Some(cursor) = result["cursor"].as_str() {
            feed.cursor = Some(cursor.to_string());
        }
        let id = result["subscriptionId"].as_str().unwrap().to_string();
        self.subscriptions.insert(id.clone());
        id
    }

    /// Route every `session.event` notification into its tab's feed.
    fn route_session_events(&mut self, feeds: &mut Feeds) {
        let (events, rest): (Vec<Value>, Vec<Value>) = std::mem::take(&mut self.notifications).into_iter().partition(|n| n["event"] == "session.event");
        self.notifications = rest;
        for notification in events {
            if !notification["params"]["subscriptionId"].as_str().is_some_and(|id| self.subscriptions.contains(id)) {
                continue;
            }
            let event = notification["params"]["event"].clone();
            let tab = event["tabId"].as_str().unwrap_or_default().to_string();
            feeds.entry(tab).or_default().push(event, notification["params"]["cursor"].as_str().map(String::from));
        }
    }

    /// Wait until `done` holds for a tab's feed.
    async fn until_tab(&mut self, feeds: &mut Feeds, tab_id: &str, what: &str, done: impl Fn(&Feed) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        loop {
            self.route_session_events(feeds);
            if feeds.get(tab_id).is_some_and(&done) {
                return;
            }
            match tokio::time::timeout_at(deadline, self.events.recv()).await {
                Ok(Some(ClientEvent::Message(message))) => self.notifications.push(message),
                Ok(Some(ClientEvent::State(state))) => self.states.push(state),
                Ok(None) => panic!("{what}: the client stopped"),
                Err(_) => panic!("{what}: timed out; {:?}", feeds.get(tab_id).map(|f| common::agent::kinds(&f.events))),
            }
        }
    }
}

/// The workspace content keys a client got from `keys.get`.
async fn workspace_keys(client: &mut Client) -> (String, std::collections::HashMap<String, [u8; 32]>) {
    let keys = client.ok("keys.get", json!({})).await;
    let map = keys["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| (k["keyId"].as_str().unwrap().to_string(), raccoon_lib::cloud_agents::crypto::key_from_b64(k["key"].as_str().unwrap()).unwrap()))
        .collect();
    (keys["currentKeyId"].as_str().unwrap().to_string(), map)
}

/// Block the test (not the runtime) until a mailbox command settles.
fn settled(mailbox: &common::mailbox::FakeMailbox, id: &str) -> common::mailbox::Command {
    tokio::task::block_in_place(|| mailbox.settled(id, Duration::from_secs(90)))
}

fn has(feed: &Feed, text: &str) -> bool {
    feed.texts("assistant_text").iter().any(|t| t == text)
}

/// PRO-22: agent tabs of a cloud workspace. The agent is the fake Claude Code
/// under the real harness; commands travel only through the (fake) API
/// mailbox, encrypted under the key the runtime handed out over the relay.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs terminalx-saas, bun and Redis: scripts/remote-runtime/e2e.sh"]
async fn cloud_agent_tabs_run_through_the_mailbox_and_survive_disconnects_and_restarts() {
    use common::agent::{AgentWorld, Serve};
    use common::mailbox::FakeMailbox;

    assert!(std::process::Command::new("python3").arg("--version").output().is_ok(), "the fake agent needs python3");
    let harness = Harness::start();
    let world = AgentWorld::new();
    let mailbox = FakeMailbox::start(7);
    let mut secret = [0u8; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let relay_host_id = relay_host_id_for_secret(secret);
    let relay_token = harness.post("/runtime-token", json!({ "relayHostId": relay_host_id, "runtimeGeneration": 7 }))["relayToken"].as_str().unwrap().to_string();
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("link.json");
    // Every connection is a new `open`: its own attachment and single-use
    // invite, added to the link the runtime keeps reading.
    let attachments = Mutex::new(Vec::<Value>::new());
    let write_agent_link = |attachments: &[Value]| {
        let temporary = link.with_extension("new");
        let contents = json!({
            "v": 1, "hostSecretB64": STANDARD.encode(secret), "relayToken": relay_token, "directorUrl": harness.director,
            "attachments": attachments, "mailbox": mailbox.link_section(),
        });
        std::fs::write(&temporary, contents.to_string()).unwrap();
        std::fs::rename(temporary, &link).unwrap();
    };
    write_agent_link(&[]);
    let start = || {
        let mut command = world.command();
        command.args(["--runtime-kind", "cloud-workspace", "--relay-link"]).arg(&link);
        let serve = Serve::start(command, &world.data);
        common::agent::wait_until("relay registration", || {
            serve.lines.lock().unwrap().iter().rev().find(|l| l["type"] == "relay" && l["status"]["state"] == "registered").cloned()
        });
        serve
    };
    let mut runtime = start();
    let pairing_dir = link_dir.path().join("link.json.attachments");
    let desk_source = || {
        let mut attachments = attachments.lock().unwrap();
        let id = format!("att-agents-{}", attachments.len() + 1);
        attachments.push(attachment(&id, "desktop-agents", &uuid::Uuid::new_v4().simple().to_string(), "runtime"));
        write_agent_link(&attachments);
        source(&harness, &pairing_dir, &id, "desktop-agents", &relay_host_id)
    };
    let mut desk = Client::start(desk_source());
    let ClientState::Connected { capabilities, .. } = desk.connected().await else { unreachable!() };
    assert!(capabilities.iter().any(|c| c == "keys/1"), "{capabilities:?}");
    let (key_id, keys) = workspace_keys(&mut desk).await;
    let key = keys[&key_id];
    let mut feeds = Feeds::new();
    let send = |tab: &str, kind: &str, plaintext: Value| mailbox.enqueue(&key_id, &key, tab, kind, plaintext, "manage");

    // Two agent tabs, each its own process and conversation.
    let a = desk.ok("session.create", json!({ "agent": "claude", "mode": "manual", "clientRequestId": "e2e-agent-create-a" })).await;
    let b = desk.ok("session.create", json!({ "agent": "claude", "mode": "manual", "clientRequestId": "e2e-agent-create-b" })).await;
    let (a_session, a_tab) = (a["sessionId"].as_str().unwrap().to_string(), a["tabId"].as_str().unwrap().to_string());
    let (b_session, b_tab) = (b["sessionId"].as_str().unwrap().to_string(), b["tabId"].as_str().unwrap().to_string());
    assert_ne!(a_tab, b_tab);
    let listed = desk.ok("session.tabs", json!({})).await;
    assert_eq!(listed["tabs"].as_array().unwrap().len(), 2, "{listed}");
    desk.subscribe_tab(&mut feeds, &a_session, &a_tab).await;
    desk.subscribe_tab(&mut feeds, &b_session, &b_tab).await;
    let first_a = send(&a_tab, "send", json!({ "v": 1, "text": "slow:8:400" }));
    let first_b = send(&b_tab, "send", json!({ "v": 1, "text": "echo:from B" }));
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &b_tab, "B's reply", |f| has(f, "from B")).await;
    assert_eq!(settled(&mailbox, &first_b).state, "applied");

    // The stream is cut mid-turn: a new connection resumes from the cursor,
    // with nothing lost and nothing twice.
    desk.until_tab(&mut feeds, &a_tab, "A's second chunk", |f| has(f, "chunk 2 of 8")).await;
    desk.supervisor.stop();
    let mut desk = Client::start(desk_source());
    desk.connected().await;
    desk.subscribe_tab(&mut feeds, &a_session, &a_tab).await;
    desk.subscribe_tab(&mut feeds, &b_session, &b_tab).await;
    desk.until_tab(&mut feeds, &a_tab, "A's turn to end", |f| f.count("turn_completed") >= 1).await;
    assert_eq!(settled(&mailbox, &first_a).state, "applied");
    let chunks = feeds[&a_tab].texts("assistant_text");
    assert_eq!(chunks, (1..=8).map(|i| format!("chunk {i} of 8")).collect::<Vec<_>>(), "every chunk once, in order");
    assert!(!feeds[&b_tab].texts("assistant_text").iter().any(|t| t.starts_with("chunk")), "the conversations stay apart");

    // A follow-up sent while the tab is busy waits for the turn, then goes.
    let long = send(&a_tab, "send", json!({ "v": 1, "text": "slow:5:400" }));
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &a_tab, "the long turn", |f| has(f, "chunk 1 of 5")).await;
    let follow_up = send(&a_tab, "send", json!({ "v": 1, "text": "echo:the follow-up" }));
    desk.ok("session.nudge", json!({})).await;
    assert_eq!(settled(&mailbox, &long).state, "applied");
    assert_eq!(settled(&mailbox, &follow_up).state, "applied");
    let receipt = mailbox.receipt(&follow_up, &keys).expect("an encrypted receipt");
    assert_eq!(receipt["queued"], true, "{receipt}");
    desk.until_tab(&mut feeds, &a_tab, "the follow-up's reply", |f| has(f, "the follow-up")).await;
    {
        let events = &feeds[&a_tab].events;
        let last_chunk = events.iter().position(|e| e["payload"]["text"] == "chunk 5 of 5").unwrap();
        let prompt = events.iter().rposition(|e| e["payload"]["type"] == "user_message" && e["payload"]["text"] == "echo:the follow-up").unwrap();
        assert!(prompt > last_chunk, "the follow-up went after the turn it waited for");
    }
    assert_eq!(feeds[&a_tab].texts("user_message").iter().filter(|t| *t == "echo:the follow-up").count(), 1);

    // A waiting approval, answered through the mailbox exactly once even
    // though the first ack is lost and the lease is redelivered.
    let ask = send(&b_tab, "send", json!({ "v": 1, "text": "ask:touch approved.txt" }));
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &b_tab, "the permission card", |f| f.count("permission_requested") >= 1).await;
    settled(&mailbox, &ask);
    let request = feeds[&b_tab].events.iter().find(|e| e["payload"]["type"] == "permission_requested").unwrap()["payload"]["requestId"].as_str().unwrap().to_string();
    let listed = desk.ok("session.tabs", json!({})).await;
    let b_info = listed["tabs"].as_array().unwrap().iter().find(|t| t["tabId"] == b_tab.as_str()).unwrap().clone();
    assert_eq!(b_info["status"], "waiting", "{b_info}");
    assert_eq!(b_info["pendingPermissions"][0]["requestId"], request.as_str());
    let decision = send(&b_tab, "permission-decision", json!({ "v": 1, "requestId": request, "optionId": "allow" }));
    mailbox.fail_acks(&decision, u32::MAX);
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &b_tab, "the allowed tool", |f| has(f, "allowed: touch approved.txt")).await;
    tokio::task::block_in_place(|| common::agent::wait_until("a lost ack", || mailbox.acks_for(&decision).iter().any(|(_, status)| *status == 503).then_some(())));
    // The lease runs out while the acks keep failing: the server leases the
    // same command again, and only then do acks get through.
    mailbox.expire_leases();
    desk.ok("session.nudge", json!({})).await;
    tokio::task::block_in_place(|| common::agent::wait_until("the redelivery", || (mailbox.command(&decision).lease_count >= 2).then_some(())));
    mailbox.state.lock().unwrap().fail_acks.clear();
    desk.ok("session.nudge", json!({})).await;
    let applied = settled(&mailbox, &decision);
    assert_eq!(applied.state, "applied", "the redelivery acks the stored receipt: {applied:?}");
    assert!(applied.lease_count >= 2, "it was redelivered: {applied:?}");
    assert_eq!(feeds[&b_tab].count("permission_requested"), 1);
    assert_eq!(feeds[&b_tab].texts("assistant_text").iter().filter(|t| t.starts_with("allowed:")).count(), 1);
    // The same decision again is a new command: refused as not pending, not applied twice.
    let again = send(&b_tab, "permission-decision", json!({ "v": 1, "requestId": request, "optionId": "allow" }));
    desk.ok("session.nudge", json!({})).await;
    let refused = settled(&mailbox, &again);
    assert_eq!((refused.state.as_str(), refused.category.as_deref()), ("rejected", Some("request-not-pending")));

    // Steering reaches the running turn; stop ends it.
    let running = send(&a_tab, "send", json!({ "v": 1, "text": "slow:40:300" }));
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &a_tab, "the turn to steer", |f| has(f, "chunk 2 of 40")).await;
    let steer = send(&a_tab, "steer", json!({ "v": 1, "text": "prefer the shorter path" }));
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &a_tab, "the steer's answer", |f| has(f, "steered: prefer the shorter path")).await;
    assert_eq!(settled(&mailbox, &steer).state, "applied");
    assert_eq!(settled(&mailbox, &running).state, "applied");
    let stop = send(&a_tab, "stop", json!({ "v": 1 }));
    desk.ok("session.nudge", json!({})).await;
    assert_eq!(settled(&mailbox, &stop).state, "applied");
    desk.until_tab(&mut feeds, &a_tab, "the stopped turn", |f| {
        f.events.iter().any(|e| e["payload"]["type"] == "turn_completed" && e["payload"]["status"] == "aborted")
    })
    .await;
    assert!(!has(&feeds[&a_tab], "chunk 40 of 40"), "stop ended the turn");

    // The user goes away mid-turn; the turn finishes without them, and the
    // transcript is all there on the next attach and in the checkpoint.
    let away = send(&b_tab, "send", json!({ "v": 1, "text": "slow:6:300" }));
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &b_tab, "the unattended turn", |f| has(f, "chunk 1 of 6")).await;
    desk.supervisor.stop();
    assert_eq!(settled(&mailbox, &away).state, "applied");
    let checkpoint = tokio::task::block_in_place(|| {
        common::agent::wait_until("B's checkpoint of the finished turn", || {
            mailbox
                .checkpoint(&b_tab, &keys)
                .filter(|(_, _, projection)| common::agent::texts(projection["events"].as_array().unwrap(), "assistant_text").contains(&"chunk 6 of 6".to_string()))
        })
    });
    assert_eq!(checkpoint.2["tabId"], b_tab.as_str());
    let mut desk = Client::start(desk_source());
    desk.connected().await;
    desk.subscribe_tab(&mut feeds, &a_session, &a_tab).await;
    desk.subscribe_tab(&mut feeds, &b_session, &b_tab).await;
    desk.until_tab(&mut feeds, &b_tab, "the recovered transcript", |f| has(f, "chunk 6 of 6")).await;
    assert_eq!(feeds[&b_tab].texts("assistant_text").iter().filter(|t| t.starts_with("chunk ")).count(), 6);

    // The runtime dies mid-turn and comes back on the same disk: a command it
    // applied but could not ack is acked from its receipt, not sent again,
    // and the interrupted tab says its process ended.
    let dying = send(&a_tab, "send", json!({ "v": 1, "text": "slow:60:300" }));
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &a_tab, "the doomed turn", |f| has(f, "chunk 2 of 60")).await;
    let unacked = send(&b_tab, "send", json!({ "v": 1, "text": "echo:before the restart" }));
    mailbox.fail_acks(&unacked, u32::MAX);
    desk.ok("session.nudge", json!({})).await;
    desk.until_tab(&mut feeds, &b_tab, "the unacked reply", |f| has(f, "before the restart")).await;
    tokio::task::block_in_place(|| common::agent::wait_until("the lost ack", || mailbox.acks_for(&unacked).iter().any(|(_, s)| *s == 503).then_some(())));
    runtime.kill();
    desk.state(|state| matches!(state, ClientState::Reconnecting { .. } | ClientState::WaitingForRuntime)).await;
    mailbox.state.lock().unwrap().fail_acks.clear();
    mailbox.expire_leases();
    let incarnations = mailbox.state.lock().unwrap().incarnations.len();
    runtime = start();
    desk.connected().await;
    // The new connection has none of the old one's subscriptions.
    desk.subscriptions.clear();
    assert_eq!(settled(&mailbox, &unacked).state, "applied");
    assert_eq!(mailbox.state.lock().unwrap().incarnations.len(), incarnations, "the receipt store survived the restart");
    assert_eq!(settled(&mailbox, &dying).state, "applied");
    let (key_after, keys_after) = workspace_keys(&mut desk).await;
    assert_eq!(key_after, key_id, "the workspace key survived the restart");
    let tabs = desk.ok("session.tabs", json!({})).await;
    let a_info = tabs["tabs"].as_array().unwrap().iter().find(|t| t["tabId"] == a_tab.as_str()).unwrap().clone();
    assert_ne!(a_info["process"], "running", "{a_info}");
    assert_ne!(a_info["status"], "in_progress", "{a_info}");
    // A cursor does not survive a runtime restart: seqs restart from the
    // last persisted event, so a live-only event seen before the restart
    // (usage) could share its seq with a new one after it. The runtime says
    // so with cursor_expired, and the client resyncs from a full replay.
    let stale = feeds[&b_tab].cursor.clone().expect("a cursor from before the restart");
    assert_eq!(
        desk.refused("session.subscribe", json!({ "sessionId": b_session, "tabId": b_tab, "sinceCursor": stale })).await,
        "cursor_expired"
    );
    feeds.remove(&a_tab);
    feeds.remove(&b_tab);
    desk.subscribe_tab(&mut feeds, &b_session, &b_tab).await;
    let b_replies = feeds[&b_tab].texts("assistant_text");
    assert_eq!(b_replies.iter().filter(|t| *t == "before the restart").count(), 1, "applied once: {b_replies:?}");
    let a_checkpoint = mailbox.checkpoint(&a_tab, &keys_after).expect("A's checkpoint");
    assert!(common::agent::texts(a_checkpoint.2["events"].as_array().unwrap(), "assistant_text").contains(&"chunk 2 of 60".to_string()));

    // The tab resumes its saved conversation on the next prompt.
    let resumed = send(&a_tab, "send", json!({ "v": 1, "text": "echo:after the restart" }));
    desk.ok("session.nudge", json!({})).await;
    assert_eq!(settled(&mailbox, &resumed).state, "applied");
    let receipt = mailbox.receipt(&resumed, &keys_after).expect("a receipt");
    let a_now = desk.ok("session.tabs", json!({})).await;
    assert_ne!(receipt["queued"], true, "the tab is idle after the restart, so the prompt goes now: {receipt}; before: {a_info}; now: {a_now}");
    desk.subscribe_tab(&mut feeds, &a_session, &a_tab).await;
    desk.until_tab(&mut feeds, &a_tab, "the resumed reply", |f| has(f, "after the restart")).await;
    desk.supervisor.stop();
    drop(runtime);
}

// ---------------------------------------------------------------- PRO-30

fn you(state: &ClientState) -> Value {
    match state {
        ClientState::Connected { you, .. } => you.clone().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// PRO-30: a workspace shared with two members, seen and driven by several
/// people at once through the relay.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs terminalx-saas, bun and Redis: scripts/remote-runtime/e2e.sh"]
async fn a_shared_workspace_serializes_input_and_stops_access_when_revoked() {
    use common::agent::{AgentWorld, Serve};
    use common::mailbox::FakeMailbox;

    assert!(std::process::Command::new("python3").arg("--version").output().is_ok(), "the fake agent needs python3");
    let harness = Harness::start();
    let world = AgentWorld::new();
    let mailbox = FakeMailbox::start(7);
    let mut secret = [0u8; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let relay_host_id = relay_host_id_for_secret(secret);
    let relay_token = harness.post("/runtime-token", json!({ "relayHostId": relay_host_id, "runtimeGeneration": 7 }))["relayToken"].as_str().unwrap().to_string();
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("link.json");
    let pairing_dir = link_dir.path().join("link.json.attachments");
    // The API's side, played by the test: attachments with their person, and
    // who the workspace is shared with (`collaboration`, contract §21.3).
    let attachments = Mutex::new(Vec::<Value>::new());
    let members = Mutex::new(json!([
        { "userId": "admin", "role": "manager", "canApprove": true },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ]));
    let write = || {
        let temporary = link.with_extension("new");
        let contents = json!({
            "v": 1, "hostSecretB64": STANDARD.encode(secret), "relayToken": relay_token, "directorUrl": harness.director,
            "attachments": *attachments.lock().unwrap(), "mailbox": mailbox.link_section(),
            "collaboration": { "v": 1, "members": *members.lock().unwrap() },
        });
        std::fs::write(&temporary, contents.to_string()).unwrap();
        std::fs::rename(temporary, &link).unwrap();
    };
    write();
    let mut command = world.command();
    command.args(["--runtime-kind", "cloud-workspace", "--relay-link"]).arg(&link);
    let serve = Serve::start(command, &world.data);
    common::agent::wait_until("relay registration", || {
        serve.lines.lock().unwrap().iter().rev().find(|l| l["type"] == "relay" && l["status"]["state"] == "registered").cloned()
    });
    let open = |user: &str, scope: &str| {
        let mut list = attachments.lock().unwrap();
        let id = format!("att-share-{}", list.len() + 1);
        let device = format!("device-{user}-{}", list.len() + 1);
        let mut entry = attachment(&id, &device, &uuid::Uuid::new_v4().simple().to_string(), scope);
        entry["userId"] = json!(user);
        list.push(entry);
        drop(list);
        write();
        source(&harness, &pairing_dir, &id, &device, &relay_host_id)
    };
    // The API re-mints an existing attachment (a reopened session) under the
    // same id with a new device and token; the runtime answers it again.
    let remint = |id: &str, user: &str, scope: &str| {
        let mut list = attachments.lock().unwrap();
        let device = format!("device-{user}-{}", list.len() + 1);
        let entry = list.iter_mut().find(|entry| entry["id"] == id).expect("an attachment to re-mint");
        *entry = attachment(id, &device, &uuid::Uuid::new_v4().simple().to_string(), scope);
        entry["userId"] = json!(user);
        drop(list);
        let _ = std::fs::remove_file(pairing_dir.join(format!("{id}.pairing")));
        write();
        source(&harness, &pairing_dir, id, &device, &relay_host_id)
    };

    let mut admin = Client::start(open("admin", "runtime"));
    assert_eq!(you(&admin.connected().await)["role"], "manager");
    let mut alice = Client::start(open("alice", "session"));
    let state = alice.connected().await;
    assert_eq!(you(&state), json!({ "userId": "alice", "role": "driver", "canApprove": false, "listed": true }));
    let mut bob = Client::start(open("bob", "session"));
    assert_eq!(you(&bob.connected().await)["role"], "viewer");
    // Carol is a member of the organization the workspace is not shared
    // with. (An outsider never gets this far: the API answers `open` with 404.)
    let mut carol = Client::start(open("carol", "session"));
    assert_eq!(you(&carol.connected().await)["role"], "none");
    for method in ["keys.get", "session.tabs", "collab.state", "pty.list", "fs.list"] {
        assert_eq!(carol.refused(method, json!({})).await, "forbidden", "{method}");
    }

    let (key_id, keys) = workspace_keys(&mut admin).await;
    let key = keys[&key_id];
    let (bob_key, _) = workspace_keys(&mut bob).await;
    assert_eq!(bob_key, key_id, "the key is handed out through sharing");
    let send_as = |user: &str, role: &str, can_approve: bool, tab: &str, kind: &str, plaintext: Value| {
        let authority = if role == "manager" { "manage" } else { "participate" };
        let actor = json!({ "userId": user, "authority": authority, "role": role, "canApprove": can_approve });
        mailbox.enqueue_as(&key_id, &key, tab, kind, plaintext, authority, Some(actor))
    };
    let created = admin.ok("session.create", json!({ "agent": "claude", "mode": "manual", "clientRequestId": "e2e-share-create" })).await;
    let (session, tab) = (created["sessionId"].as_str().unwrap().to_string(), created["tabId"].as_str().unwrap().to_string());
    let mut feeds = Feeds::new();
    bob.subscribe_tab(&mut feeds, &session, &tab).await;

    // Presence: one row per person, what they look at and whether they type.
    alice.ok("presence.update", json!({ "tabId": tab, "activity": "typing" })).await;
    let seen = bob
        .notification(|n| {
            n["event"] == "collab.presence"
                && n["params"]["participants"].as_array().unwrap().iter().any(|p| p["userId"] == "alice" && p["activity"] == "typing")
        })
        .await;
    let people: Vec<&str> = seen["params"]["participants"].as_array().unwrap().iter().map(|p| p["userId"].as_str().unwrap()).collect();
    assert_eq!(people, ["admin", "alice", "bob"], "carol has no access, so no presence");

    // Notes are for people: attributed, pushed to everyone, never sent to the agent.
    let note = bob.ok("notes.post", json!({ "tabId": tab, "text": "please keep the old API", "clientRequestId": "e2e-note-0001" })).await;
    assert_eq!(note["note"]["authorId"], "bob");
    let pushed = alice.notification(|n| n["event"] == "notes.posted").await;
    assert_eq!(pushed["params"]["note"]["text"], "please keep the old API");

    // Alice drives: her turn runs and she holds the tab's lease.
    let first = send_as("alice", "driver", false, &tab, "send", json!({ "v": 1, "text": "slow:6:300" }));
    alice.ok("session.nudge", json!({})).await;
    bob.until_tab(&mut feeds, &tab, "alice's turn", |f| has(f, "chunk 1 of 6")).await;
    assert_eq!(settled(&mailbox, &first).state, "applied");
    let tabs = bob.ok("session.tabs", json!({})).await;
    assert_eq!(tabs["tabs"][0]["lease"]["holderId"], "alice", "{tabs}");
    // Competing input: the admin's send while Alice drives is refused and
    // says who drives; Bob, a viewer, may not send at all.
    let competing = send_as("admin", "manager", true, &tab, "send", json!({ "v": 1, "text": "echo:admin was here" }));
    let viewer = send_as("bob", "viewer", true, &tab, "send", json!({ "v": 1, "text": "echo:bob was here" }));
    admin.ok("session.nudge", json!({})).await;
    let refused = settled(&mailbox, &competing);
    assert_eq!((refused.state.as_str(), refused.category.as_deref()), ("rejected", Some("lease-held")));
    assert_eq!(mailbox.receipt(&competing, &keys).unwrap()["holderId"], "alice");
    assert_eq!(settled(&mailbox, &viewer).category.as_deref(), Some("forbidden"));
    bob.until_tab(&mut feeds, &tab, "alice's turn to end", |f| f.count("turn_completed") >= 1).await;

    // Permission decisions follow the approval right, not driving.
    let ask = send_as("alice", "driver", false, &tab, "send", json!({ "v": 1, "text": "ask:touch shared.txt" }));
    alice.ok("session.nudge", json!({})).await;
    bob.until_tab(&mut feeds, &tab, "the permission card", |f| f.count("permission_requested") >= 1).await;
    settled(&mailbox, &ask);
    let request = feeds[&tab].events.iter().find(|e| e["payload"]["type"] == "permission_requested").unwrap()["payload"]["requestId"].as_str().unwrap().to_string();
    let by_alice = send_as("alice", "driver", false, &tab, "permission-decision", json!({ "v": 1, "requestId": request, "optionId": "allow" }));
    alice.ok("session.nudge", json!({})).await;
    assert_eq!(settled(&mailbox, &by_alice).category.as_deref(), Some("forbidden"));
    let by_bob = send_as("bob", "viewer", true, &tab, "permission-decision", json!({ "v": 1, "requestId": request, "optionId": "allow" }));
    bob.ok("session.nudge", json!({})).await;
    assert_eq!(settled(&mailbox, &by_bob).state, "applied");
    bob.until_tab(&mut feeds, &tab, "the approved tool", |f| has(f, "allowed: touch shared.txt")).await;

    // Mid-turn revocation: Alice's turn runs with a follow-up of hers queued
    // behind it; the admin unshares her.
    let long = send_as("alice", "driver", false, &tab, "send", json!({ "v": 1, "text": "slow:12:400" }));
    alice.ok("session.nudge", json!({})).await;
    bob.until_tab(&mut feeds, &tab, "the long turn", |f| has(f, "chunk 1 of 12")).await;
    let queued = send_as("alice", "driver", false, &tab, "send", json!({ "v": 1, "text": "echo:alice's queued follow-up" }));
    alice.ok("session.nudge", json!({})).await;
    assert_eq!(settled(&mailbox, &queued).state, "applied");
    assert_eq!(mailbox.receipt(&queued, &keys).unwrap()["queued"], true, "queued behind her running turn");
    let revoked_at = Instant::now();
    *members.lock().unwrap() = json!([
        { "userId": "admin", "role": "manager", "canApprove": true },
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ]);
    write();
    alice.state(|state| !matches!(state, ClientState::Connected { .. })).await;
    let took = revoked_at.elapsed();
    assert!(took < Duration::from_secs(20), "access stopped within the refresh interval, took {took:?}");
    admin.notification(|n| n["event"] == "keys.changed").await;
    let (key_after, _) = workspace_keys(&mut admin).await;
    assert_ne!(key_after, key_id, "the content key rotates when someone loses access");
    bob.until_tab(&mut feeds, &tab, "the long turn to end", |f| has(f, "chunk 12 of 12")).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    bob.route_session_events(&mut feeds);
    assert!(
        !feeds[&tab].texts("user_message").iter().any(|t| t.contains("alice's queued follow-up")),
        "the revoked person's queued input never reached the agent"
    );
    assert!(!has(&feeds[&tab], "alice's queued follow-up"));
    let leased = bob.ok("session.tabs", json!({})).await;
    assert!(leased["tabs"][0]["lease"].is_null() || leased["tabs"][0]["lease"]["holderId"] != "alice", "{leased}");
    assert!(!feeds[&tab].texts("user_message").iter().any(|t| t.contains("please keep the old API")), "notes never reach the agent");
    assert_eq!(settled(&mailbox, &long).state, "applied");

    // Reconnect: Alice opens again, and the API re-mints her attachment
    // (same id, new device) as that of a member with no share: she has nothing,
    // until she is shared with again as a viewer.
    alice.supervisor.stop();
    let mut alice = Client::start(remint("att-share-2", "alice", "session"));
    assert_eq!(you(&alice.connected().await)["role"], "none");
    assert_eq!(alice.refused("session.tabs", json!({})).await, "forbidden");
    assert_eq!(alice.refused("keys.get", json!({})).await, "forbidden");
    *members.lock().unwrap() = json!([
        { "userId": "admin", "role": "manager", "canApprove": true },
        { "userId": "alice", "role": "viewer", "canApprove": false },
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ]);
    write();
    let changed = alice.notification(|n| n["event"] == "collab.you").await;
    assert_eq!(changed["params"]["you"]["role"], "viewer");
    assert_eq!(alice.ok("session.tabs", json!({})).await["tabs"][0]["tabId"], tab.as_str());
    let (alice_key, _) = workspace_keys(&mut alice).await;
    assert_eq!(alice_key, key_after, "shared again, she gets the current key");
    assert_eq!(alice.refused("lease.acquire", json!({ "tabId": tab })).await, "forbidden", "a viewer does not drive");

    for client in [admin, alice, bob, carol] {
        client.supervisor.stop();
    }
    drop(serve);
}

// ---------------------------------------------------------------- PRO-24

/// Read a whole file part by part under the first part's version, as the
/// desktop client does; every part crossed the relay within its frame.
async fn read_file(client: &mut Client, path: &str) -> (Vec<u8>, Value) {
    let first = client.ok("fs.read", json!({ "path": path })).await;
    let mut bytes = match first.get("text") {
        Some(text) => text.as_str().unwrap().as_bytes().to_vec(),
        None => STANDARD.decode(first["dataB64"].as_str().unwrap()).unwrap(),
    };
    let mut eof = first["eof"].as_bool().unwrap();
    while !eof {
        let part = client.ok("fs.read", json!({ "path": path, "offset": bytes.len(), "version": first["version"] })).await;
        bytes.extend(STANDARD.decode(part["dataB64"].as_str().unwrap()).unwrap());
        eof = part["eof"].as_bool().unwrap();
    }
    (bytes, first)
}

/// PRO-24: a cloud workspace's files over the relay: bounded parts, change
/// notifications, conflict detection against an agent's edit, a save after a
/// reconnect, bounded search, symlink escapes and participant limits.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs terminalx-saas, bun and Redis: scripts/remote-runtime/e2e.sh"]
async fn cloud_files_are_browsed_edited_and_searched_through_the_relay() {
    let harness = Harness::start();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("ws");
    let outside = dir.path().join("outside");
    let data = PathBuf::from(format!("/tmp/tx-e2e-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "needle from outside").unwrap();
    std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
    // 1.5 MB of media: several parts, each within the relay's 1 MiB frame.
    let media: Vec<u8> = (0..1_500_000u32).map(|index| (index.wrapping_mul(2654435761) >> 24) as u8).collect();
    std::fs::write(root.join("clip.png"), &media).unwrap();
    let many: String = (0..5000).map(|line| format!("let needle_{line} = {line}; // {}\n", "x".repeat(200))).collect();
    std::fs::write(root.join("src/many.rs"), many).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

    let mut secret = [0u8; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let relay_host_id = relay_host_id_for_secret(secret);
    let relay_token = harness.post("/runtime-token", json!({ "relayHostId": relay_host_id, "runtimeGeneration": 7 }))["relayToken"]
        .as_str()
        .unwrap()
        .to_string();
    let link = dir.path().join("link.json");
    let tokens: Vec<String> = (0..2).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect();
    write_link(
        &link,
        &secret,
        &relay_token,
        &harness.director,
        json!([attachment("att-desk", "desktop-desk", &tokens[0], "runtime"), attachment("att-phone", "mobile-phone", &tokens[1], "session")]),
    );
    let runtime = Runtime::start(&root, &data, &link);
    runtime.wait_for_relay("registered");
    let pairing_dir = dir.path().join("link.json.attachments");
    let mut desk = Client::start(source(&harness, &pairing_dir, "att-desk", "desktop-desk", &relay_host_id));
    desk.connected().await;

    // The tree: a link out of the workspace is listed, never followed.
    let watch = desk.ok("fs.watch", json!({})).await;
    let subscription = watch["subscriptionId"].as_str().unwrap().to_string();
    let listing = desk.ok("fs.list", json!({})).await;
    let entry = |name: &str| listing["entries"].as_array().unwrap().iter().find(|entry| entry["name"] == name).cloned();
    assert_eq!(entry("clip.png").unwrap()["mediaType"], "image/png");
    #[cfg(unix)]
    {
        assert_eq!(entry("escape").unwrap()["escapes"], true);
        assert_eq!(desk.refused("fs.read", json!({ "path": "escape/secret.txt" })).await, "path_forbidden");
        assert_eq!(desk.refused("fs.list", json!({ "path": "escape" })).await, "path_forbidden");
    }

    // A large binary file, read in parts under one version.
    let (bytes, first) = read_file(&mut desk, "clip.png").await;
    assert_eq!(bytes, media);
    assert_eq!(first["binary"], true);

    // The editor reads a file; an agent in the workspace edits it meanwhile.
    let opened = desk.ok("fs.read", json!({ "path": "src/main.rs" })).await;
    std::fs::write(root.join("src/main.rs"), "fn main() { agent(); }\n").unwrap();
    let changed = desk
        .notification(|n| {
            n["event"] == "fs.changed"
                && n["params"]["subscriptionId"] == subscription.as_str()
                && n["params"]["paths"].as_array().is_some_and(|paths| paths.iter().any(|path| path == "src/main.rs"))
        })
        .await;
    assert!(changed["params"]["paths"].as_array().unwrap().iter().all(|path| !path.as_str().unwrap().starts_with("escape/")));
    let stale_save = json!({ "path": "src/main.rs", "text": "fn main() { mine(); }\n", "expectedEtag": opened["etag"], "clientRequestId": "e2e-save-0001" });
    assert_eq!(desk.refused("fs.write", stale_save).await, "conflict");
    assert_eq!(std::fs::read_to_string(root.join("src/main.rs")).unwrap(), "fn main() { agent(); }\n");

    // Resolved explicitly, but the connection drops before the save: the
    // unsaved buffer is saved after the reconnect, once.
    let current = desk.ok("fs.stat", json!({ "path": "src/main.rs" })).await;
    harness.post("/restart-cell", json!({}));
    desk.state(|state| matches!(state, ClientState::Reconnecting { .. })).await;
    desk.connected().await;
    let save = json!({ "path": "src/main.rs", "text": "fn main() { mine(); }\n", "expectedEtag": current["etag"], "clientRequestId": "e2e-save-0002" });
    let saved = desk.ok("fs.write", save.clone()).await;
    assert_eq!(desk.ok("fs.write", save).await, saved, "a resend is the first save's answer");
    assert_eq!(std::fs::read_to_string(root.join("src/main.rs")).unwrap(), "fn main() { mine(); }\n");

    // A large write: staged part by part, committed at once.
    let big: Vec<u8> = media.iter().rev().copied().collect();
    let part_bytes = 384 * 1024;
    for (index, part) in big.chunks(part_bytes).enumerate() {
        let params = json!({ "uploadId": "e2e-upload-01", "offset": index * part_bytes, "dataB64": STANDARD.encode(part), "clientRequestId": format!("e2e-part-{index:04}") });
        desk.ok("fs.writePart", params).await;
    }
    let commit = json!({ "path": "clip.png", "uploadId": "e2e-upload-01", "size": big.len(), "expectedEtag": first["etag"], "clientRequestId": "e2e-commit-01" });
    desk.ok("fs.write", commit).await;
    assert_eq!(std::fs::read(root.join("clip.png")).unwrap(), big);

    // Search: bounded, never through the escaping link, and cancellable.
    let found = desk.ok("fs.search", json!({ "searchId": "e2e-search-01", "query": "needle", "maxResults": 1000 })).await;
    let hits = found["hits"].as_array().unwrap();
    assert!(!hits.is_empty() && hits.len() <= 1000);
    assert_eq!(found["capped"], true);
    assert!(hits.iter().all(|hit| hit["path"] == "src/many.rs"), "nothing from outside the workspace");
    assert_eq!(desk.ok("fs.cancel", json!({ "searchId": "e2e-search-02" })).await["cancelled"], false);

    // A participant reads and searches, and cannot change anything.
    let mut phone = Client::start(source(&harness, &pairing_dir, "att-phone", "mobile-phone", &relay_host_id));
    phone.connected().await;
    assert_eq!(phone.ok("fs.read", json!({ "path": "src/main.rs" })).await["text"], "fn main() { mine(); }\n");
    phone.ok("fs.search", json!({ "searchId": "e2e-search-03", "query": "mine" })).await;
    let write = json!({ "path": "src/main.rs", "text": "x", "clientRequestId": "e2e-phone-0001" });
    assert_eq!(phone.refused("fs.write", write).await, "forbidden");
    let part = json!({ "uploadId": "e2e-upload-02", "offset": 0, "dataB64": "eA==", "clientRequestId": "e2e-phone-0002" });
    assert_eq!(phone.refused("fs.writePart", part).await, "forbidden");
    phone.supervisor.stop();
    desk.supervisor.stop();
    drop(runtime);
    let _ = std::fs::remove_dir_all(&data);
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// PRO-27: review, commit, push and a draft pull request in a two-repository
/// cloud workspace, through the relay. A local bare repository stands in for
/// GitHub's Git side and `scripts/remote-runtime/fake-gh` for its API.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs terminalx-saas, bun and Redis: scripts/remote-runtime/e2e.sh"]
async fn cloud_git_reviews_commits_pushes_and_opens_a_draft_pr_through_the_relay() {
    assert!(std::process::Command::new("python3").arg("--version").output().is_ok(), "the fake gh needs python3");
    let harness = Harness::start();
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let root = base.join("ws");
    let data = PathBuf::from(format!("/tmp/tx-e2e-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(&root).unwrap();
    // The remote, with `main` and `develop`, cloned twice into the workspace.
    let remote = base.join("remote.git");
    git(&base, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    let seed = base.join("seed");
    git(&base, &["clone", "-q", remote.to_str().unwrap(), seed.to_str().unwrap()]);
    std::fs::write(seed.join("README.md"), "hello\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "seed"]);
    git(&seed, &["push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/develop"]);
    git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    for name in ["app", "lib"] {
        git(&root, &["clone", "-q", remote.to_str().unwrap(), name]);
    }
    let github = base.join("github");
    std::fs::create_dir_all(&github).unwrap();
    let fake_gh = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/remote-runtime/fake-gh");
    let gh = base.join("gh");
    std::fs::write(&gh, format!("#!/bin/sh\nFAKE_GH_STATE='{}' exec '{}' \"$@\"\n", github.display(), fake_gh.display())).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let mut secret = [0u8; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let relay_host_id = relay_host_id_for_secret(secret);
    let relay_token = harness.post("/runtime-token", json!({ "relayHostId": relay_host_id, "runtimeGeneration": 7 }))["relayToken"]
        .as_str()
        .unwrap()
        .to_string();
    let link = base.join("link.json");
    let tokens: Vec<String> = (0..2).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect();
    write_link(
        &link,
        &secret,
        &relay_token,
        &harness.director,
        json!([attachment("att-desk", "desktop-desk", &tokens[0], "runtime"), attachment("att-phone", "mobile-phone", &tokens[1], "session")]),
    );
    let runtime = Runtime::start_with_env(&root, &data, &link, &[("TERMINALX_SERVE_GH", gh.as_path())]);
    runtime.wait_for_relay("registered");
    let pairing_dir = base.join("link.json.attachments");
    let mut desk = Client::start(source(&harness, &pairing_dir, "att-desk", "desktop-desk", &relay_host_id));
    desk.connected().await;

    // Two repositories: nothing is done in "whichever" of them.
    let listed = desk.ok("git.repositories", json!({})).await;
    let names: Vec<&str> = listed["repositories"].as_array().unwrap().iter().map(|repo| repo["repo"].as_str().unwrap()).collect();
    assert_eq!(names, ["app", "lib"]);
    assert_eq!(desk.refused("git.status", json!({})).await, "ambiguous_repository");

    // Edit on a new branch, review, commit as the person.
    desk.ok("git.checkout", json!({ "repo": "app", "branch": "feature/e2e", "create": true, "clientRequestId": "e2e-git-0001" })).await;
    desk.ok("fs.write", json!({ "path": "app/README.md", "text": "hello\ncloud\n", "clientRequestId": "e2e-git-0002" })).await;
    let changes = desk.ok("git.workingChanges", json!({ "repo": "app" })).await;
    assert_eq!(changes["files"][0]["path"], "README.md");
    let pair = desk.ok("git.fileContents", json!({ "repo": "app", "path": "README.md", "base": changes["head"] })).await;
    assert_eq!(pair, json!({ "before": "hello\n", "after": "hello\ncloud\n" }));
    let author = json!({ "name": "Ada Lovelace", "email": "ada@example.com" });
    let no_author = json!({ "repo": "app", "message": "Say cloud", "clientRequestId": "e2e-git-0003" });
    assert_eq!(desk.refused("git.commit", no_author).await, "invalid_params");
    desk.ok("git.commit", json!({ "repo": "app", "message": "Say cloud", "author": author, "clientRequestId": "e2e-git-0004" })).await;
    assert_eq!(git(&root.join("app"), &["log", "-1", "--format=%an <%ae>"]), "Ada Lovelace <ada@example.com>");

    // Push; the connection drops before the answer is read: the resend is
    // answered from the first push, and a later retry asks the remote first.
    let push = json!({ "repo": "app", "clientRequestId": "e2e-git-0005" });
    let pushed = desk.ok("git.push", push.clone()).await;
    assert_eq!(pushed["pushed"], true);
    harness.post("/restart-cell", json!({}));
    desk.state(|state| matches!(state, ClientState::Reconnecting { .. })).await;
    desk.connected().await;
    assert_eq!(desk.ok("git.push", push).await, pushed);
    let retry = desk.ok("git.push", json!({ "repo": "app", "clientRequestId": "e2e-git-0006" })).await;
    assert_eq!((retry["pushed"].clone(), retry["reconciled"].clone()), (json!(false), json!(true)));
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/feature/e2e"]), pushed["head"].as_str().unwrap());

    // GitHub refuses the workspace's token: reported as such, nothing created.
    std::fs::write(github.join("auth-expired"), "").unwrap();
    let create = |id: &str| json!({ "repo": "app", "title": "Say cloud", "body": "From the cloud", "base": "develop", "draft": true, "clientRequestId": id });
    assert_eq!(desk.refused("git.prCreate", create("e2e-git-0007")).await, "auth_failed");
    std::fs::remove_file(github.join("auth-expired")).unwrap();

    // A draft pull request into the chosen base, created once.
    let created = desk.ok("git.prCreate", create("e2e-git-0008")).await;
    assert_eq!((created["created"].clone(), created["pr"]["isDraft"].clone(), created["pr"]["base"].clone()), (json!(true), json!(true), json!("develop")));
    let again = desk.ok("git.prCreate", create("e2e-git-0009")).await;
    assert_eq!((again["existing"].clone(), again["pr"]["number"].clone()), (json!(true), created["pr"]["number"].clone()));
    let prs = desk.ok("git.prs", json!({ "repo": "app" })).await;
    assert_eq!(prs["prs"].as_array().unwrap().len(), 1);

    // Unpublished work before an archive: an uncommitted file in lib.
    std::fs::write(root.join("lib/scratch.txt"), "s").unwrap();
    let facts = desk.ok("lifecycle.dispositionFacts", json!({})).await;
    let repos = facts["repositories"].as_array().unwrap();
    assert_eq!(repos[0]["path"], "app");
    assert_eq!(repos[0]["openPullRequests"][0]["number"], created["pr"]["number"]);
    assert_eq!(repos[0]["unpushedCommits"], 0);
    assert_eq!(repos[1]["dirtyFiles"], 1);

    // A participant reads, and cannot publish.
    let mut phone = Client::start(source(&harness, &pairing_dir, "att-phone", "mobile-phone", &relay_host_id));
    phone.connected().await;
    assert_eq!(phone.ok("git.status", json!({ "repo": "app" })).await["branch"], "feature/e2e");
    phone.ok("lifecycle.dispositionFacts", json!({})).await;
    assert_eq!(phone.refused("git.push", json!({ "repo": "app", "clientRequestId": "e2e-phone-git-1" })).await, "forbidden");
    assert_eq!(phone.refused("git.prCreate", json!({ "repo": "app", "title": "x", "clientRequestId": "e2e-phone-git-2" })).await, "forbidden");
    phone.supervisor.stop();
    desk.supervisor.stop();
    drop(runtime);
    let _ = std::fs::remove_dir_all(&data);
}

/// PRO-21: a workspace created with a first prompt. The runtime consumes the
/// launch intent by itself; the desktop that attaches over the relay finds
/// the agent tab already holding that prompt (once), and continues in it
/// through the mailbox like any other tab.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs terminalx-saas, bun and Redis: scripts/remote-runtime/e2e.sh"]
async fn a_launched_workspace_opens_on_its_first_prompt_through_the_relay() {
    use common::agent::{AgentWorld, Serve};
    use common::mailbox::FakeMailbox;

    assert!(std::process::Command::new("python3").arg("--version").output().is_ok(), "the fake agent needs python3");
    let harness = Harness::start();
    let world = AgentWorld::new();
    let mailbox = FakeMailbox::start(7);
    mailbox.set_launch(json!({
        "launchId": "launch_relay", "workBranch": "terminalx/relay-launch-000000000001", "title": "First task",
        "agent": "claude", "mode": "manual", "prompt": "echo:the first task", "repositories": [],
    }));
    let mut secret = [0u8; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let relay_host_id = relay_host_id_for_secret(secret);
    let relay_token = harness.post("/runtime-token", json!({ "relayHostId": relay_host_id, "runtimeGeneration": 7 }))["relayToken"].as_str().unwrap().to_string();
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("link.json");
    let attachment_id = "att-launch-1";
    let attachments = vec![attachment(attachment_id, "desktop-launch", &uuid::Uuid::new_v4().simple().to_string(), "runtime")];
    std::fs::write(
        &link,
        json!({
            "v": 1, "hostSecretB64": STANDARD.encode(secret), "relayToken": relay_token, "directorUrl": harness.director,
            "attachments": attachments, "mailbox": mailbox.link_section(),
        })
        .to_string(),
    )
    .unwrap();
    let mut command = world.command();
    command.args(["--runtime-kind", "cloud-workspace", "--relay-link"]).arg(&link);
    let runtime = Serve::start(command, &world.data);
    let launch = tokio::task::block_in_place(|| {
        common::agent::wait_until("the launch", || Some(mailbox.launch()).filter(|launch| launch.state == "started"))
    });
    let tab = launch.completions[0]["tabId"].as_str().unwrap().to_string();
    let session = launch.completions[0]["sessionId"].as_str().unwrap().to_string();

    let pairing_dir = link_dir.path().join("link.json.attachments");
    let mut desk = Client::start(source(&harness, &pairing_dir, attachment_id, "desktop-launch", &relay_host_id));
    desk.connected().await;
    let listed = desk.ok("session.tabs", json!({})).await;
    let tabs = listed["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 1, "{listed}");
    assert_eq!(tabs[0]["tabId"].as_str(), Some(tab.as_str()));
    let mut feeds = Feeds::new();
    desk.subscribe_tab(&mut feeds, &session, &tab).await;
    desk.until_tab(&mut feeds, &tab, "the first task's reply", |f| has(f, "the first task")).await;
    assert_eq!(feeds[&tab].texts("user_message"), vec!["echo:the first task"], "the prompt is in the tab once");

    // The desktop continues in that tab through the mailbox.
    let (key_id, keys) = workspace_keys(&mut desk).await;
    let next = mailbox.enqueue(&key_id, &keys[&key_id], &tab, "send", json!({ "v": 1, "text": "echo:and then this" }), "manage");
    desk.ok("session.nudge", json!({})).await;
    assert_eq!(settled(&mailbox, &next).state, "applied");
    desk.until_tab(&mut feeds, &tab, "the follow-up", |f| has(f, "and then this")).await;
    assert_eq!(feeds[&tab].texts("user_message"), vec!["echo:the first task", "echo:and then this"]);
    assert_eq!(mailbox.launch().completions.len(), 1);
    desk.supervisor.stop();
    drop(runtime);
}
