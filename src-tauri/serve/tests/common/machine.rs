//! A paired computer's side of the machine host (PRO-341): the registry it
//! is put in, the switch, and its direct E2EE connection on `/machine/1`.

use std::path::Path;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use raccoon_lib::machine_host::registry::{token_hash, PairedComputer, Registry};
use raccoon_lib::relay_e2ee::{E2eeClientHandshake, E2eeSession, HostKeypair, PayloadKind};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::agent::Serve;

/// A port nothing listens on, and one no other test got, in this process or
/// in another: a port just released is often the next one handed out, and
/// under cargo-nextest every test is a process of its own and tests of
/// different binaries run at the same time.
///
/// A port is taken by creating `<temp dir>/terminalx-test-ports/<port>`
/// exclusively, with this process's id in it. A file whose process is gone is
/// taken over; one whose process still runs, or that holds no id yet, is not.
pub fn free_port() -> u16 {
    let ports = std::env::temp_dir().join("terminalx-test-ports");
    std::fs::create_dir_all(&ports).unwrap();
    loop {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        if reserve(&ports, port) {
            return port;
        }
    }
}

/// Whether this process now holds `port`.
fn reserve(ports: &Path, port: u16) -> bool {
    let file = ports.join(port.to_string());
    if create_holding(&file) {
        return true;
    }
    let Some(holder) = holder(&file) else { return false };
    if alive(holder) {
        return false;
    }
    // Its process is gone. Of the processes that read the same id, the one
    // that creates `<port>.from-<id>` takes the port over. That file stays:
    // a process that read the id later cannot remove the file the one that
    // took it over wrote.
    if !create_holding(&ports.join(format!("{port}.from-{holder}"))) || self::holder(&file) != Some(holder) {
        return false;
    }
    // Another process may create the file once it is gone: then it is that
    // one's, and this one takes the next port.
    std::fs::remove_file(&file).is_ok() && create_holding(&file)
}

/// Create `path` if nothing is there, holding this process's id.
fn create_holding(path: &Path) -> bool {
    use std::io::Write as _;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(std::process::id().to_string().as_bytes()).unwrap();
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => panic!("reserving the test port {}: {error}", path.display()),
    }
}

/// The process id in a port's file: none while its creator has not written it.
fn holder(file: &Path) -> Option<libc::pid_t> {
    std::fs::read_to_string(file).ok()?.trim().parse().ok().filter(|pid| *pid > 0)
}

/// Whether a process with this id runs (signal 0 sends nothing; EPERM is
/// another user's process, which runs).
fn alive(pid: libc::pid_t) -> bool {
    let sent = unsafe { libc::kill(pid, 0) } == 0;
    sent || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn allow(data: &Path, on: bool) {
    std::fs::write(data.join("settings.json"), json!({ "machines": { "allowOperating": on } }).to_string()).unwrap();
}

/// Put a computer in the machine's registry, as PRO-342's pairing will.
pub fn pair(data: &Path, id: &str, token: &str, relay_device_id: Option<&str>) {
    Registry::in_data_dir(data)
        .put(PairedComputer {
            id: id.into(),
            token_hash: token_hash(token),
            label: format!("{id}'s MacBook Pro"),
            platform: Some("macos".into()),
            client_public_key_b64: None,
            fingerprint: None,
            // Now: a credential unused for 90 days would expire (PRO-357).
            approved_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64,
            last_seen_at: None,
            relay_device_id: relay_device_id.map(str::to_string),
            next_token_hash: None,
            disconnected_at: None,
            other: Default::default(),
        })
        .unwrap();
}

/// The last machine host status the runtime printed.
pub fn status(serve: &Serve) -> Value {
    serve.control("runtime.machineHost.status", json!({}))
}

pub fn listening(serve: &Serve) -> String {
    let deadline = std::time::Instant::now() + super::agent::AGENT_WAIT;
    loop {
        // The runtime prints "ready" before it installs its machine host
        // (src/serve.rs), so a status asked in between is refused as
        // "unsupported": not listening yet, rather than a failure.
        let response = serve.try_control("runtime.machineHost.status", json!({}));
        let last = if response["ok"] == true {
            response["result"].clone()
        } else {
            assert_eq!(response["error"]["code"], "unsupported", "runtime.machineHost.status failed: {response}");
            response
        };
        if let Some(address) = last["listening"].as_str() {
            return address.to_string();
        }
        assert!(std::time::Instant::now() < deadline, "the machine host never listened: {last}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn host_key(data: &Path) -> HostKeypair {
    let file: Value = serde_json::from_slice(&std::fs::read(data.join("machine-host/host-key.json")).unwrap()).unwrap();
    let secret: [u8; 32] = STANDARD.decode(file["secretB64"].as_str().unwrap()).unwrap().try_into().unwrap();
    HostKeypair::from_secret(secret)
}

pub type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub struct Computer {
    pub socket: Socket,
    pub session: E2eeSession,
    next: u64,
}

pub enum Outcome {
    In(Box<Computer>),
    Refused(Option<u16>),
}

pub async fn connect(port: u16, host_public_key_b64: &str, token: &str) -> Outcome {
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/machine/1")).await.unwrap();
    let handshake = E2eeClientHandshake::new(host_public_key_b64, "direct", None).unwrap();
    socket.send(Message::Text(serde_json::to_string(handshake.hello()).unwrap().into())).await.unwrap();
    let ready = match socket.next().await.unwrap().unwrap() {
        Message::Text(text) => text.to_string(),
        other => panic!("expected E2EE ready, got {other:?}"),
    };
    let mut session = handshake.accept_ready(&ready).unwrap();
    let transcript = session.transcript_hash_b64.clone();
    let auth = json!({ "type": "e2ee_auth", "v": 2, "transcriptHashB64": transcript, "deviceToken": token, "label": "Test MacBook", "platform": "macos" });
    let sealed = session.seal(auth.to_string().as_bytes(), PayloadKind::Text).unwrap();
    socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
    match tokio::time::timeout(Duration::from_secs(15), socket.next()).await.unwrap() {
        Some(Ok(Message::Text(text))) => {
            let reply: Value = serde_json::from_slice(&session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
            if reply["type"] == "pairing_refused" {
                // A token the machine does not know: the reason, then the close.
                return match tokio::time::timeout(Duration::from_secs(15), socket.next()).await.unwrap() {
                    Some(Ok(Message::Close(frame))) => Outcome::Refused(frame.map(|frame| u16::from(frame.code))),
                    _ => Outcome::Refused(None),
                };
            }
            assert_eq!(reply["type"], "e2ee_authenticated");
            assert_eq!(reply["transcriptHashB64"], transcript.as_str());
            Outcome::In(Box::new(Computer { socket, session, next: 1 }))
        }
        Some(Ok(Message::Close(frame))) => Outcome::Refused(frame.map(|frame| u16::from(frame.code))),
        Some(Ok(other)) => panic!("unexpected frame {other:?}"),
        Some(Err(_)) | None => Outcome::Refused(None),
    }
}

impl Computer {
    pub async fn call(&mut self, method: &str, params: Value) -> Value {
        self.call_observing(method, params, |_| {}).await
    }

    pub async fn call_observing(&mut self, method: &str, params: Value, mut observe: impl FnMut(Value)) -> Value {
        let id = format!("r{}", self.next);
        self.next += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        let sealed = self.session.seal(request.to_string().as_bytes(), PayloadKind::Text).unwrap();
        self.socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(30), self.socket.next()).await.expect("an answer").expect("open").unwrap();
            let Message::Text(text) = frame else { continue };
            let message: Value = serde_json::from_slice(&self.session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
            if message["id"] == id.as_str() {
                return message;
            }
            if message["event"].is_string() {
                observe(message);
            }
        }
    }

    /// The params of the next matching `event` notification within `within`.
    /// Returns `None` if the deadline expires or the connection closes first.
    pub async fn notification(&mut self, event: &str, within: Duration, matches: impl Fn(&Value) -> bool) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            match tokio::time::timeout_at(deadline, self.socket.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    let message: Value = serde_json::from_slice(&self.session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
                    if message["event"] == event && matches(&message["params"]) {
                        return Some(message["params"].clone());
                    }
                }
                Ok(Some(Ok(_))) => continue,
                Err(_) | Ok(None) | Ok(Some(Err(_))) => return None,
            }
        }
    }

    /// Whether the machine closed this connection within a few seconds.
    pub async fn closed(&mut self) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            match tokio::time::timeout_at(deadline, self.socket.next()).await {
                Err(_) => return false,
                Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => return true,
                Ok(Some(Ok(_))) => continue,
            }
        }
    }
}

pub fn computer(outcome: Outcome) -> Computer {
    match outcome {
        Outcome::In(computer) => *computer,
        Outcome::Refused(code) => panic!("the paired computer was refused ({code:?})"),
    }
}
