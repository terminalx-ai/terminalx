//! The operating computer of `scripts/remote-runtime/e2e-install-linux.sh`
//! (PRO-353): run from another container, it pairs with a freshly installed
//! server by the code `terminalx-serve pair` printed there, starts the first
//! session, and after the server reboots, connects again and finds it.
//!
//! It is driven by the script, one step per run, and is ignored otherwise:
//!
//! - `TX_E2E_CODE_FILE`: a file holding the pairing code (never printed);
//! - `TX_E2E_STEP`: `pair` (wait for the person to allow it), `session`
//!   (start a session in the server's only project and wait for its reply) or
//!   `reconnect` (connect with no one asked; the project and session are still
//!   there);
//! - `TX_E2E_STATE`: a folder for what one step tells the next.
//!
//! It connects only to the endpoints the code names, in order, as the desktop
//! does on this network.
#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use raccoon_lib::machine_wire::MachineCode;
use raccoon_lib::relay_e2ee::{E2eeClientHandshake, E2eeSession, PayloadKind};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

/// The operating computer's long-lived key, the same on every connection.
const COMPUTER_KEY: [u8; 32] = [7; 32];
const COMPUTER_LABEL: &str = "E2E Laptop";
const PROMPT_REPLY: &str = "first session on the server";

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Operating {
    socket: Socket,
    session: E2eeSession,
    next: u64,
    notifications: Vec<Value>,
}

/// Connect to the first endpoint that answers, authenticate with the code's
/// token, and wait (up to `wait`) for the machine to let this computer in.
async fn operate(code: &MachineCode, wait: Duration) -> Operating {
    let mut last = String::new();
    for endpoint in &code.direct_endpoints {
        let connected = tokio::time::timeout(Duration::from_secs(3), tokio_tungstenite::connect_async(endpoint.as_str())).await;
        let mut socket = match connected {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(error)) => {
                last = format!("{endpoint}: {error}");
                continue;
            }
            Err(_) => {
                last = format!("{endpoint}: timed out");
                continue;
            }
        };
        eprintln!("connected to {endpoint}");
        let handshake = E2eeClientHandshake::with_secret(COMPUTER_KEY, &code.public_key_b64, "direct", None).unwrap();
        socket.send(Message::Text(serde_json::to_string(handshake.hello()).unwrap().into())).await.unwrap();
        let ready = match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => text.to_string(),
            other => panic!("expected E2EE ready, got {other:?}"),
        };
        let mut session = handshake.accept_ready(&ready).expect("the machine proves the host key in the code");
        let transcript = session.transcript_hash_b64.clone();
        let auth = json!({ "type": "e2ee_auth", "v": 2, "transcriptHashB64": transcript, "deviceToken": code.device_token, "label": COMPUTER_LABEL, "platform": "linux" });
        let sealed = session.seal(auth.to_string().as_bytes(), PayloadKind::Text).unwrap();
        socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
        loop {
            match tokio::time::timeout(wait, socket.next()).await.expect("an answer from the machine") {
                Some(Ok(Message::Text(text))) => {
                    let reply: Value = serde_json::from_slice(&session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
                    match reply["type"].as_str() {
                        Some("e2ee_authenticated") => return Operating { socket, session, next: 1, notifications: Vec::new() },
                        Some("pairing_refused") => continue,
                        _ => panic!("unexpected reply {reply}"),
                    }
                }
                Some(Ok(Message::Close(frame))) => panic!("the machine refused this computer: {frame:?}"),
                Some(Ok(_)) => continue,
                Some(Err(error)) => panic!("the connection failed: {error}"),
                None => panic!("the machine closed the connection"),
            }
        }
    }
    panic!("no endpoint in the code answered; last: {last}");
}

impl Operating {
    async fn receive(&mut self, deadline: tokio::time::Instant) -> Value {
        loop {
            let frame = tokio::time::timeout_at(deadline, self.socket.next()).await.expect("an answer in time").expect("open").unwrap();
            let Message::Text(text) = frame else { continue };
            return serde_json::from_slice(&self.session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = format!("r{}", self.next);
        self.next += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        let sealed = self.session.seal(request.to_string().as_bytes(), PayloadKind::Text).unwrap();
        self.socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let message = self.receive(deadline).await;
            if message["id"] == id.as_str() {
                assert_eq!(message["ok"], true, "{method}: {message}");
                return message["result"].clone();
            }
            self.notifications.push(message);
        }
    }

    async fn hello(&mut self) {
        let hello = self.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "session/1"], "client": { "app": "terminalx-desktop" } })).await;
        let granted: Vec<&str> = hello["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(granted.contains(&"machine/1"), "{hello}");
    }

    /// The `session.event` payloads of a subscription so far and from now on,
    /// until `done` holds of them.
    async fn until(&mut self, subscription: &str, mut events: Vec<Value>, what: &str, done: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            for notification in std::mem::take(&mut self.notifications) {
                if notification["event"] == "session.event" && notification["params"]["subscriptionId"] == subscription {
                    events.push(notification["params"]["event"].clone());
                }
            }
            if done(&events) {
                return events;
            }
            let next = tokio::time::timeout_at(deadline, self.receive(deadline)).await.unwrap_or_else(|_| panic!("{what}: timed out; saw {events:?}"));
            self.notifications.push(next);
        }
    }
}

fn kind_texts<'a>(events: &'a [Value], kind: &str) -> Vec<&'a str> {
    events.iter().filter(|event| event["payload"]["type"] == kind).filter_map(|event| event["payload"]["text"].as_str()).collect()
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required (run scripts/remote-runtime/e2e-install-linux.sh)"))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "driven by scripts/remote-runtime/e2e-install-linux.sh"]
async fn operating_computer() {
    let code = std::fs::read_to_string(env("TX_E2E_CODE_FILE")).unwrap();
    let code = MachineCode::decode(code.trim()).expect("a pairing code");
    let state = PathBuf::from(env("TX_E2E_STATE"));
    match env("TX_E2E_STEP").as_str() {
        "pair" => {
            // The person has two minutes to answer on the server.
            let mut machine = operate(&code, Duration::from_secs(150)).await;
            machine.hello().await;
            let described = machine.call("machine.describe", json!({})).await;
            assert_eq!(described["machineId"], json!(code.machine.machine_id));
            assert_eq!(described["hasWindow"], false, "a headless server: {described}");
            println!("paired with {}", code.machine.machine_id);
        }
        "session" => {
            // Paired: let in at once, no one asked.
            let mut machine = operate(&code, Duration::from_secs(10)).await;
            machine.hello().await;
            let projects = machine.call("machine.projects", json!({})).await;
            let project = projects["projects"].as_array().unwrap().iter().find(|project| project["archived"] != true).unwrap_or_else(|| panic!("a project on the server: {projects}")).clone();
            let created = machine
                .call("session.create", json!({ "agent": "claude", "mode": "manual", "title": "First session", "projectId": project["projectId"], "prompt": format!("echo:{PROMPT_REPLY}"), "clientRequestId": "e2e-first-session" }))
                .await;
            let (session_id, tab_id) = (created["sessionId"].as_str().unwrap().to_string(), created["tabId"].as_str().unwrap().to_string());
            let subscribed = machine.call("session.subscribe", json!({ "sessionId": session_id, "tabId": tab_id })).await;
            let replayed: Vec<Value> = subscribed["events"].as_array().unwrap().iter().map(|entry| entry["event"].clone()).collect();
            let subscription = subscribed["subscriptionId"].as_str().unwrap().to_string();
            let events = machine
                .until(&subscription, replayed, "the agent's reply", |events| kind_texts(events, "assistant_text").contains(&PROMPT_REPLY) && events.iter().any(|event| event["payload"]["type"] == "turn_completed"))
                .await;
            assert!(kind_texts(&events, "assistant_text").contains(&PROMPT_REPLY));
            std::fs::write(state.join("session"), json!({ "sessionId": session_id, "projectId": project["projectId"] }).to_string()).unwrap();
            println!("first session {session_id} answered in {}", project["name"]);
        }
        "reconnect" => {
            let saved: Value = serde_json::from_slice(&std::fs::read(state.join("session")).unwrap()).unwrap();
            let mut machine = operate(&code, Duration::from_secs(10)).await;
            machine.hello().await;
            let projects = machine.call("machine.projects", json!({})).await;
            assert!(projects["projects"].as_array().unwrap().iter().any(|project| project["projectId"] == saved["projectId"]), "{projects}");
            let listed = machine.call("session.list", json!({})).await;
            assert!(listed["sessions"].as_array().unwrap().iter().any(|session| session["id"] == saved["sessionId"]), "the session survived the reboot: {listed}");
            println!("reconnected; session {} is still there", saved["sessionId"]);
        }
        other => panic!("unknown step {other}"),
    }
}
