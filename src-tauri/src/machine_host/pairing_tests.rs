//! Pairing by code over a real socket (PRO-342): the machine host on a port
//! of its own, the operating computer's client (`crate::machines`) and raw
//! E2EE clients that ask with a key of their choosing.

use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::registry::{token_hash, PairedComputer};
use super::MachineHost;
use crate::machine_wire::{MachineCode, APPROVAL_TTL_MS};
use crate::machines::store::MachineRoute;
use crate::machines::{MachinePairResult, Machines};
use crate::relay_e2ee::{E2eeClientHandshake, E2eeSession, HostKeypair, PayloadKind};
use crate::remote::server::WorkspaceRpc;

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(super) struct Rig {
    pub(super) host: Arc<MachineHost>,
    pub(super) keypair: HostKeypair,
    pub(super) port: u16,
    _data: tempfile::TempDir,
    _home: crate::store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.host.stop_for_test();
    }
}

pub(super) fn rig(approval_ttl_ms: i64) -> Rig {
    let home = crate::store::temp_home();
    let data = tempfile::tempdir().unwrap();
    let keypair = HostKeypair::from_secret([9; 32]);
    let identity = crate::remote::machine::Identity { machine_id: keypair.host_id(), has_window: false };
    let rpc = WorkspaceRpc::machine(identity, 0, Arc::new(crate::sink::BroadcastSink::new(64)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
    let host = MachineHost::serving_for_test(data.path(), rpc, keypair.clone(), approval_ttl_ms).unwrap();
    let port = host.port_for_test();
    Rig { host, keypair, port, _data: data, _home: home }
}

pub(super) fn public_b64(secret: [u8; 32]) -> String {
    STANDARD.encode(x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(secret)).as_bytes())
}

/// The code, reached on loopback here.
pub(super) fn local(code: &str, port: u16) -> MachineCode {
    let mut code = MachineCode::decode(code).unwrap();
    assert!(code.direct_endpoints.iter().all(|endpoint| endpoint.ends_with(&format!(":{port}/machine/1"))), "{:?}", code.direct_endpoints);
    code.direct_endpoints = vec![format!("ws://127.0.0.1:{port}/machine/1")];
    code
}

pub(super) struct Asked {
    socket: Socket,
    session: E2eeSession,
    transcript: String,
}

/// Connect with `secret` as the client key and send `e2ee_auth` with `token`.
pub(super) async fn ask(rig: &Rig, secret: [u8; 32], token: &str) -> Asked {
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/machine/1", rig.port)).await.unwrap();
    let handshake = E2eeClientHandshake::with_secret(secret, &rig.keypair.public_key_b64(), "direct", None).unwrap();
    socket.send(Message::Text(serde_json::to_string(handshake.hello()).unwrap().into())).await.unwrap();
    let ready = match socket.next().await.unwrap().unwrap() {
        Message::Text(text) => text.to_string(),
        other => panic!("expected E2EE ready, got {other:?}"),
    };
    let mut session = handshake.accept_ready(&ready).unwrap();
    let transcript = session.transcript_hash_b64.clone();
    let auth = json!({ "type": "e2ee_auth", "v": 2, "transcriptHashB64": transcript, "deviceToken": token, "label": "Test\u{7}MacBook", "platform": "macos" });
    let sealed = session.seal(auth.to_string().as_bytes(), PayloadKind::Text).unwrap();
    socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
    Asked { socket, session, transcript }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Answer {
    In,
    Refused(String),
    Closed(Option<u16>),
    Silent,
}

impl Asked {
    pub(super) async fn answer(&mut self, wait: Duration) -> Answer {
        match tokio::time::timeout(wait, self.socket.next()).await {
            Err(_) => Answer::Silent,
            Ok(Some(Ok(Message::Text(text)))) => {
                let reply: Value = serde_json::from_slice(&self.session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
                match reply["type"].as_str() {
                    Some("e2ee_authenticated") => {
                        assert_eq!(reply["transcriptHashB64"], self.transcript.as_str());
                        Answer::In
                    }
                    Some("pairing_refused") => Answer::Refused(reply["reason"].as_str().unwrap().into()),
                    _ => panic!("unexpected reply {reply}"),
                }
            }
            Ok(Some(Ok(Message::Close(frame)))) => Answer::Closed(frame.map(|frame| u16::from(frame.code))),
            Ok(Some(Ok(other))) => panic!("unexpected frame {other:?}"),
            Ok(Some(Err(_)) | None) => Answer::Closed(None),
        }
    }

    pub(super) async fn call(&mut self, id: &str, method: &str, params: Value) -> Value {
        let request = json!({ "id": id, "method": method, "params": params });
        let sealed = self.session.seal(request.to_string().as_bytes(), PayloadKind::Text).unwrap();
        self.socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(20), self.socket.next()).await.expect("an answer").expect("open").unwrap();
            let Message::Text(text) = frame else { continue };
            let message: Value = serde_json::from_slice(&self.session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
            if message["id"] == id {
                return message;
            }
        }
    }

    /// Whether the machine closed this connection within `wait`.
    pub(super) async fn closed_within(&mut self, wait: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match tokio::time::timeout_at(deadline, self.socket.next()).await {
                Err(_) => return false,
                Ok(None | Some(Err(_)) | Some(Ok(Message::Close(_)))) => return true,
                Ok(Some(Ok(_))) => continue,
            }
        }
    }
}

pub(super) async fn eventually<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(found) = check() {
            return found;
        }
        assert!(Instant::now() < deadline, "never: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub(super) fn paired(rig: &Rig, id: &str, secret: [u8; 32], token: &str) {
    rig.host
        .registry()
        .put(PairedComputer {
            id: id.into(),
            token_hash: token_hash(token),
            label: "Desk".into(),
            platform: Some("macos".into()),
            client_public_key_b64: Some(public_b64(secret)),
            fingerprint: None,
            // Now: a credential unused for 90 days would expire (PRO-357).
            approved_at: chrono::Utc::now().timestamp_millis(),
            last_seen_at: None,
            relay_device_id: None,
            next_token_hash: None,
            disconnected_at: None,
            other: Default::default(),
        })
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_computer_pairs_by_code_once_the_machine_allows_it() {
    let rig = rig(APPROVAL_TTL_MS);
    let created = rig.host.create_code(None).unwrap();
    let code = local(&created.code, rig.port);
    let status = rig.host.status();
    assert_eq!(status.code.as_ref().map(|code| code.expires_at), Some(created.expires_at));
    assert!(!serde_json::to_string(&status).unwrap().contains(&code.device_token), "the status never carries the code");
    assert_eq!(code.machine.machine_id, rig.keypair.host_id());

    // The operating computer, with its own key in a Keychain stand-in.
    let store = tempfile::tempdir().unwrap();
    let keychain = crate::keychain::testing::MemorySecrets::default();
    let secrets = crate::machines::secrets::MachineSecrets::with_store(Arc::new(keychain.clone()));
    secrets.configure("ai.terminalx.test").unwrap();
    let machines = Arc::new(Machines::for_test(secrets, store.path().to_path_buf(), Duration::from_secs(30)));
    let encoded = code.encode().unwrap();
    let inspected = machines.inspect(&encoded).unwrap();
    assert!(!inspected.already_paired);
    assert!(!inspected.has_relay);
    let pairing = tokio::spawn(machines.clone().pair(encoded.clone(), MachineRoute::ThisNetwork));

    let pending = eventually("a computer waits for Allow", || rig.host.status().pending).await;
    assert_eq!(pending.fingerprint, inspected.fingerprint, "both screens show one fingerprint");
    assert_eq!(pending.transport, "direct");
    // The operating computer names the system it runs on: macOS here, Linux on CI.
    assert_eq!(pending.platform.as_deref(), Some(std::env::consts::OS));
    assert!(rig.host.registry().list().unwrap().is_empty(), "nothing is written before Allow");

    // Another computer with the same code is refused; the same computer's
    // second connection shares the request but is served nothing.
    let mut other = ask(&rig, [2; 32], &code.device_token).await;
    assert_eq!(other.answer(Duration::from_secs(5)).await, Answer::Refused("another-computer".into()));
    let client_secret = *machines_secret(&machines);
    let mut early = ask(&rig, client_secret, &code.device_token).await;
    let request = json!({ "id": "early", "method": "session.list", "params": {} });
    let sealed = early.session.seal(request.to_string().as_bytes(), PayloadKind::Text).unwrap();
    early.socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
    assert!(matches!(early.answer(Duration::from_secs(5)).await, Answer::Closed(_)), "no RPC before Allow");
    assert_eq!(rig.host.status().pending.map(|pending| pending.request_id), Some(pending.request_id.clone()), "the first connection still waits");

    rig.host.approve(&pending.request_id).unwrap();
    let MachinePairResult::Paired { paired, machine } = pairing.await.unwrap().unwrap() else { panic!("not paired") };
    assert!(paired);
    assert_eq!(machine.machine_id, rig.keypair.host_id());
    assert_eq!(machine.public_key_b64, rig.keypair.public_key_b64());
    assert_eq!(machine.route, MachineRoute::ThisNetwork);
    assert_eq!(machines.list().unwrap(), vec![(*machine).clone()]);
    assert!(machines.inspect(&encoded).unwrap().already_paired);
    use crate::keychain::SecretStore as _;
    let kept = keychain.get("ai.terminalx.test.machines", &format!("machine:{}", machine.machine_id)).unwrap();
    assert_eq!(kept.as_deref(), Some(code.device_token.as_bytes()), "the device token is in the Keychain");
    assert!(!std::fs::read_to_string(store.path().join("machines.json")).unwrap().contains(&code.device_token), "never in machines.json");

    let computers = rig.host.registry().list().unwrap();
    assert_eq!(computers.len(), 1);
    assert_eq!(computers[0].client_public_key_b64.as_deref(), Some(public_b64(client_secret).as_str()), "its key is pinned");
    assert_eq!(computers[0].fingerprint.as_deref(), Some(inspected.fingerprint.as_str()));
    assert!(computers[0].proves(&code.device_token));
    let status = rig.host.status();
    assert_eq!((status.pending, status.code), (None, None), "the code is spent");

    // It connects with what it kept, with full operating rights.
    let mut computer = ask(&rig, client_secret, &code.device_token).await;
    assert_eq!(computer.answer(Duration::from_secs(5)).await, Answer::In);
    let hello = computer.call("hello", "rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "session/1"], "client": { "app": "terminalx-desktop" } })).await;
    assert_eq!(hello["result"]["authority"], "manage", "{hello}");
    assert!(hello["result"]["capabilities"].as_array().unwrap().contains(&json!("machine/1")));

    // The used code, replayed from another key, is refused as a credential.
    let mut replay = ask(&rig, [3; 32], &code.device_token).await;
    assert_eq!(replay.answer(Duration::from_secs(5)).await, Answer::Closed(Some(4401)));
    assert_eq!(rig.host.registry().list().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_computer_paired_through_a_grant_still_waits_for_allow_and_its_revocation_removes_it() {
    let rig = rig(APPROVAL_TTL_MS);
    let code = local(&rig.host.create_code(Some("grant-1".into())).unwrap().code, rig.port);
    let client_secret = [11; 32];
    let mut asking = ask(&rig, client_secret, &code.device_token).await;
    assert_eq!(asking.answer(Duration::from_millis(300)).await, Answer::Silent, "a granted account is no approval");
    let pending = eventually("the computer waits for Allow", || rig.host.status().pending).await;
    assert!(rig.host.registry().list().unwrap().is_empty());
    rig.host.approve(&pending.request_id).unwrap();
    assert_eq!(asking.answer(Duration::from_secs(5)).await, Answer::In);

    let computers = rig.host.registry().list().unwrap();
    assert_eq!(computers[0].grant_request_id(), Some("grant-1"), "linked to the grant it answered");
    let id = computers[0].id.clone();
    let key_id = crate::relay_e2ee::host_id_of(x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(client_secret)).as_bytes());
    let status = rig.host.status();
    assert_eq!(status.computers[0].key_id.as_deref(), Some(key_id.as_str()));
    assert_eq!(status.computers[0].route, Some(crate::machine_wire::ComputerRoute::Lan), "loopback is no Tailscale address");
    assert!(status.computers[0].connected);
    let value = serde_json::to_value(&status).unwrap();
    assert_eq!(value["computers"][0]["keyId"], key_id.as_str());
    assert_eq!(value["computers"][0]["route"], "lan");

    // Another grant names no computer here.
    assert_eq!(rig.host.revoke_grant("grant-2").unwrap(), None);
    assert_eq!(rig.host.registry().list().unwrap().len(), 1);
    // The operating computer removed this machine: its grant's revocation removes it and closes it.
    assert_eq!(rig.host.revoke_grant("grant-1").unwrap(), Some(id));
    assert!(asking.closed_within(Duration::from_secs(5)).await, "its connection closes");
    assert!(rig.host.registry().list().unwrap().is_empty());
    let status = eventually("the status forgets it", || Some(rig.host.status()).filter(|status| status.computers.is_empty())).await;
    assert!(status.computers.is_empty());
    let mut again = ask(&rig, client_secret, &code.device_token).await;
    assert!(matches!(again.answer(Duration::from_secs(5)).await, Answer::Closed(_) | Answer::Refused(_)), "its credential is refused");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removing_a_computer_here_answers_its_grant_and_a_disconnected_one_has_no_route() {
    let rig = rig(APPROVAL_TTL_MS);
    let code = local(&rig.host.create_code(Some("grant-9".into())).unwrap().code, rig.port);
    let mut asking = ask(&rig, [12; 32], &code.device_token).await;
    let pending = eventually("the computer waits for Allow", || rig.host.status().pending).await;
    rig.host.approve(&pending.request_id).unwrap();
    assert_eq!(asking.answer(Duration::from_secs(5)).await, Answer::In);
    drop(asking);
    let idle = eventually("it disconnects", || rig.host.status().computers.into_iter().find(|computer| !computer.connected)).await;
    assert_eq!(idle.route, None, "not connected: no route");
    assert!(idle.key_id.is_some(), "the key id stays");
    let removed = rig.host.revoke_computer(&idle.id).unwrap().expect("it was paired");
    assert_eq!(removed.grant_request_id(), Some("grant-9"), "the window revokes this grant");
    assert!(rig.host.revoke_computer(&idle.id).unwrap().is_none());
}

fn machines_secret(machines: &Machines) -> zeroize::Zeroizing<[u8; 32]> {
    machines.client_secret_for_test()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn decline_no_answer_and_closing_leave_no_record() {
    let rig = rig(500);
    let code = local(&rig.host.create_code(None).unwrap().code, rig.port);
    let mut asked = ask(&rig, [4; 32], &code.device_token).await;
    let pending = eventually("waiting", || rig.host.status().pending).await;
    assert_eq!(pending.label, "TestMacBook", "control characters are stripped");
    rig.host.decline(&pending.request_id);
    assert_eq!(asked.answer(Duration::from_secs(5)).await, Answer::Refused("not-approved".into()));
    assert!(rig.host.approve(&pending.request_id).is_err(), "nothing to allow after Don't allow");
    let status = rig.host.status();
    assert_eq!((status.pending, status.code), (None, None), "Don't allow ends the code");

    let code = local(&rig.host.create_code(None).unwrap().code, rig.port);
    let mut asked = ask(&rig, [4; 32], &code.device_token).await;
    assert_eq!(asked.answer(Duration::from_secs(5)).await, Answer::Refused("not-approved".into()), "no answer in time");
    assert!(rig.host.status().code.is_none());

    let code = local(&rig.host.create_code(None).unwrap().code, rig.port);
    let asked = ask(&rig, [4; 32], &code.device_token).await;
    eventually("waiting", || rig.host.status().pending).await;
    drop(asked);
    eventually("closing declines", || rig.host.status().code.is_none().then_some(())).await;
    assert!(rig.host.status().pending.is_none());
    assert!(rig.host.registry().list().unwrap().is_empty(), "no record after any of them");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revoking_closes_the_connection_and_refuses_the_credential() {
    let rig = rig(APPROVAL_TTL_MS);
    paired(&rig, "desk", [5; 32], "desk-token");
    let mut computer = ask(&rig, [5; 32], "desk-token").await;
    assert_eq!(computer.answer(Duration::from_secs(5)).await, Answer::In);
    let hello = computer.call("hello", "rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "session/1"], "client": { "app": "terminalx-desktop" } })).await;
    assert_eq!(hello["result"]["authority"], "manage", "{hello}");
    let listed = computer.call("list", "session.list", json!({})).await;
    assert_eq!(listed["ok"], true, "{listed}");
    eventually("connected", || rig.host.status().computers.first().is_some_and(|computer| computer.connected).then_some(())).await;
    let revoked = Instant::now();
    assert!(rig.host.revoke("desk").unwrap());
    assert!(computer.closed_within(Duration::from_secs(2)).await, "closed within two seconds");
    assert!(revoked.elapsed() < Duration::from_secs(2));
    let mut again = ask(&rig, [5; 32], "desk-token").await;
    assert_eq!(again.answer(Duration::from_secs(5)).await, Answer::Refused("code-inactive".into()), "the credential is refused after");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn five_wrong_attempts_pause_pairing_but_not_paired_computers() {
    let rig = rig(APPROVAL_TTL_MS);
    paired(&rig, "desk", [6; 32], "desk-token");
    let code = local(&rig.host.create_code(None).unwrap().code, rig.port);
    for attempt in 0..3 {
        let mut wrong = ask(&rig, [7; 32], &crate::relay_e2ee::random_token()).await;
        assert_eq!(wrong.answer(Duration::from_secs(5)).await, Answer::Refused("code-inactive".into()), "attempt {attempt}");
    }
    assert!(rig.host.status().paused_until.is_none(), "three are not enough");
    rig.host.expire_code_for_test();
    for attempt in 3..5 {
        let mut expired = ask(&rig, [7; 32], &code.device_token).await;
        assert_eq!(expired.answer(Duration::from_secs(5)).await, Answer::Refused("code-inactive".into()), "expired attempt {attempt}");
    }
    let now = chrono::Utc::now().timestamp_millis();
    let until = rig.host.status().paused_until.expect("paused");
    assert!(until > now + 55_000 && until <= now + 60_000, "a minute after the fifth");
    let refused = rig.host.create_code(None).unwrap_err();
    assert_eq!(refused.code, "pairing_paused");
    assert_eq!(refused.details.unwrap()["pausedUntil"], until);
    let mut paused = ask(&rig, [7; 32], &crate::relay_e2ee::random_token()).await;
    assert_eq!(paused.answer(Duration::from_secs(5)).await, Answer::Refused("pairing-paused".into()));
    let mut desk = ask(&rig, [6; 32], "desk-token").await;
    assert_eq!(desk.answer(Duration::from_secs(5)).await, Answer::In, "a paired computer still connects");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paired_computer_has_no_pairing_browser_or_computer_methods() {
    for method in crate::remote::protocol::METHODS {
        for prefix in ["pairing.", "browser.", "computer."] {
            assert!(!method.name.starts_with(prefix), "{} is served to paired computers", method.name);
        }
    }
    let rig = rig(APPROVAL_TTL_MS);
    paired(&rig, "desk", [8; 32], "desk-token");
    let mut computer = ask(&rig, [8; 32], "desk-token").await;
    assert_eq!(computer.answer(Duration::from_secs(5)).await, Answer::In);
    let hello = computer.call("hello", "rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "session/1"], "client": { "app": "terminalx-desktop" } })).await;
    assert_eq!(hello["ok"], true, "{hello}");
    for (id, method) in [("a", "pairing.createCode"), ("b", "pairing.approve"), ("c", "browser.open"), ("d", "computer.click"), ("e", "runtime.machineHost.createCode")] {
        let answer = computer.call(id, method, json!({})).await;
        assert_eq!(answer["ok"], false, "{method}: {answer}");
        assert_eq!(answer["error"]["code"], "method_not_found", "{method}: {answer}");
    }
    assert!(rig.host.status().code.is_none(), "no code was made");
}
