//! `serve_connection` on a busy Mac (#1282): a phone whose Mac has agents at
//! work, and a request that takes a while, stays connected.
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::DuplexStream;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

use super::*;
use crate::local_runtime::mobile::model::{DeviceEntry, DeviceProvenance, DeviceScope};
use crate::relay_e2ee::{begin_e2ee_session, E2eeClientHandshake, E2eeHello, HostKeypair};

struct StandInOwner {
    build: Build,
}

impl Owner for StandInOwner {
    fn attachment(&self) -> Result<AttachmentIdentity> {
        Ok(AttachmentIdentity { epoch: "epoch".into(), lease: "lease".into() })
    }
    fn mobile(&self, _: &Actor, _: &str, _: serde_json::Value) -> Result<serde_json::Value> {
        Ok(json!({}))
    }
    fn build(&self) -> &Build {
        &self.build
    }
    fn disconnect(&self) {}
}

fn device() -> DeviceEntry {
    DeviceEntry {
        id: "phone".into(),
        label: "Phone".into(),
        platform: "ios".into(),
        token: crate::relay_e2ee::token_hash("token"),
        scope: DeviceScope::Driver,
        provenance: DeviceProvenance::Explicit,
        bound_user_id: None,
        binding_generation: 0,
        public_key: String::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        last_seen_at: Some(chrono::Utc::now().to_rfc3339()),
        revoked_at: None,
        installation_id: None,
        created_request_id: None,
        fingerprint: None,
        approved_at: None,
        connection: None,
        last_seen_transport: None,
    }
}

struct Phone {
    socket: WebSocketStream<DuplexStream>,
    session: E2eeSession,
}

impl Phone {
    async fn request(&mut self, id: &str, method: &str) {
        let request = json!({ "id": id, "method": method, "params": {} });
        let frame = self.session.seal(request.to_string().as_bytes(), PayloadKind::Text).unwrap();
        self.socket.send(Message::Text(STANDARD.encode(frame).into())).await.unwrap();
    }

    /// The next message, or `None` once the Mac closed the connection.
    async fn read(&mut self) -> Option<Value> {
        loop {
            match tokio::time::timeout(Duration::from_secs(10), self.socket.next()).await.expect("a message from the Mac")? {
                Ok(Message::Text(text)) => {
                    let plaintext = self.session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap();
                    return Some(serde_json::from_slice(&plaintext).unwrap());
                }
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                _ => return None,
            }
        }
    }
}

/// A served connection, its phone end, and the sink agents' events go through.
async fn served(
    slow: Duration,
) -> (Phone, Arc<crate::sink::BroadcastSink>, tokio::task::JoinHandle<Result<Ended>>, crate::store::TempHome) {
    let home = crate::store::temp_home();
    registry::DeviceRegistry.add(device()).unwrap();
    let host = Arc::new(PhoneHost::new(|| 0));
    let sink = Arc::new(crate::sink::BroadcastSink::new(64));
    host.configure(sink.clone()).unwrap();
    host.set_owner(Some(Arc::new(StandInOwner { build: Build::default() })));

    let keypair = HostKeypair::from_secret([3; 32]);
    let handshake = E2eeClientHandshake::with_secret([4; 32], &keypair.public_key_b64(), "direct", None).unwrap();
    let hello: E2eeHello = serde_json::from_value(serde_json::to_value(handshake.hello()).unwrap()).unwrap();
    let (ready, mut session) = begin_e2ee_session(&keypair, hello, "direct", None).unwrap();
    let phone_session = handshake.accept_ready(&serde_json::to_string(&ready).unwrap()).unwrap();

    let (mac_end, phone_end) = tokio::io::duplex(1 << 20);
    let mut socket = WebSocketStream::from_raw_socket(mac_end, Role::Server, None).await;
    let phone = WebSocketStream::from_raw_socket(phone_end, Role::Client, None).await;
    let (outbound, inbound) = mpsc::channel(OUTBOUND_QUEUE);
    let connection = Arc::new(rpc::MobileConnection::open(&host, &device(), outbound, wire::Transport::Direct, None).await.unwrap());
    let (_signals_tx, signals) = mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let _signals_tx = _signals_tx;
        serve_connection(&mut socket, &mut session, &host, &connection, inbound, signals, |request| async move {
            if request["method"] == "slow" {
                tokio::time::sleep(slow).await;
            }
            json!({ "id": request["id"], "ok": true, "result": {} })
        })
        .await
    });
    (Phone { socket: phone, session: phone_session }, sink, server, home)
}

fn agent_event(seq: u64) -> Value {
    json!({
        "id": format!("event-{seq}"), "sessionId": "session", "tabId": "tab", "harness": "claude",
        "seq": seq, "ts": "2026-11-19T00:00:00Z",
        "payload": { "type": "assistant_text", "text": "working" },
    })
}

/// The cause of #1282's short sessions: each agent event queued a
/// `session.event` and a `sessions.changed`, eight fit, and the queue did not
/// drain while a request was answered, so a Mac with agents at work closed
/// the phone as fallen behind within seconds of it connecting.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_phone_stays_connected_to_a_busy_mac_through_a_slow_request() {
    let (mut phone, sink, server, _home) = served(Duration::from_secs(2)).await;
    phone.request("slow", "slow").await;
    let emitter = std::thread::spawn(move || {
        for seq in 0..1500 {
            sink.emit_raw("agent_event", serde_json::value::to_raw_value(&agent_event(seq)).unwrap());
            if seq % 3 == 0 {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    });
    let (mut events, mut changed, mut answered) = (0, 0, false);
    while events < 1500 || !answered {
        let message = phone.read().await.expect("the Mac kept the phone connected");
        match message["method"].as_str() {
            Some("session.event") => events += 1,
            Some("sessions.changed") => changed += 1,
            _ if message["id"] == "slow" => {
                assert_eq!(message["ok"], true);
                answered = true;
            }
            _ => {}
        }
    }
    emitter.join().unwrap();
    assert!(changed >= 1, "the phone was told its sessions changed");
    assert!(changed < 1500, "repeated invalidations were collapsed, {changed} sent");
    // The connection still answers.
    phone.request("after", "status.get").await;
    while phone.read().await.expect("still connected")["id"] != "after" {}
    phone.socket.close(None).await.unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
    assert_eq!(ended.reason, EndReason::PhoneClosed);
    assert_eq!(ended.close_code, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn requests_are_still_answered_in_the_order_they_came() {
    let (mut phone, _sink, server, _home) = served(Duration::from_millis(300)).await;
    phone.request("first", "slow").await;
    phone.request("second", "status.get").await;
    phone.request("third", "slow").await;
    let mut order = Vec::new();
    while order.len() < 3 {
        let message = phone.read().await.unwrap();
        if let Some(id) = message["id"].as_str() {
            order.push(id.to_string());
        }
    }
    assert_eq!(order, ["first", "second", "third"]);
    drop(phone);
    let ended = tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
    assert_eq!(ended.reason, EndReason::StreamEnded);
}

/// A phone that reads nothing at all still falls behind, and says so.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_phone_that_stops_reading_is_recorded_as_fallen_behind() {
    let (phone, sink, server, _home) = served(Duration::ZERO).await;
    let payload = "x".repeat(64 * 1024);
    for seq in 0..400 {
        let mut event = agent_event(seq);
        event["payload"]["text"] = json!(payload);
        sink.emit_raw("agent_event", serde_json::value::to_raw_value(&event).unwrap());
    }
    let error = tokio::time::timeout(Duration::from_secs(10), server).await.unwrap().unwrap().unwrap_err();
    assert!(
        matches!(error.downcast_ref::<Fault>(), Some(Fault::FellBehind)) || error.chain().any(|cause| cause.is::<tokio::time::error::Elapsed>()),
        "{error:#}"
    );
    drop(phone);
}

#[test]
fn invalidations_collapse_and_come_in_a_fixed_order() {
    let invalidations = Invalidations::default();
    for _ in 0..100 {
        invalidations.raise(Invalidation::Sessions);
    }
    invalidations.raise(Invalidation::Capabilities);
    assert_eq!(
        invalidations.take(),
        [json!({ "method": "sync.capabilitiesChanged" }), json!({ "method": "sessions.changed" })]
    );
    assert!(invalidations.take().is_empty());
}
