//! `serve_connection` on a busy Mac (#1282): a phone whose Mac has agents at
//! work, and a request that takes a while, stays connected.
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::DuplexStream;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

use super::*;
use crate::local_runtime::mobile::model::{DeviceEntry, DeviceProvenance, DeviceScope};
use crate::relay_e2ee::{begin_e2ee_session, E2eeClientHandshake, E2eeHello, HostKeypair};

struct StandInOwner {
    build: Build,
    /// Whether the terminal's one delta was handed out.
    delta: std::sync::atomic::AtomicBool,
}

impl Owner for StandInOwner {
    fn attachment(&self) -> Result<AttachmentIdentity> {
        Ok(AttachmentIdentity { epoch: "epoch".into(), lease: "lease".into() })
    }
    fn mobile(&self, _: &Actor, method: &str, _: serde_json::Value) -> Result<serde_json::Value> {
        Ok(match method {
            // A terminal subscription opens with its scrollback snapshot …
            "observe" => json!({ "subscriptionId": "terminal", "snapshot": "scrollback" }),
            // … and its first poll already has a delta for it.
            "output" if !self.delta.swap(true, std::sync::atomic::Ordering::SeqCst) => {
                json!([{ "subscriptionId": "terminal", "text": "delta" }])
            }
            "output" => json!([]),
            _ => json!({}),
        })
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
        self.request_with(id, method, json!({})).await;
    }

    async fn request_with(&mut self, id: &str, method: &str, params: Value) {
        let request = json!({ "id": id, "method": method, "params": params });
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
    host.set_owner(Some(Arc::new(StandInOwner { build: Build::default(), delta: Default::default() })));

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
    let (signals_tx, signals) = mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        serve_connection(&mut socket, &mut session, &host, &connection, inbound, signals, |request| {
            let signals_tx = signals_tx.clone();
            let (host, connection) = (host.clone(), connection.clone());
            async move {
                if request["method"] == "terminal.subscribe" {
                    let response = rpc::off_runtime(move || {
                        let id = request["id"].as_str().unwrap_or_default().to_string();
                        Ok(match rpc::dispatch(&host, &connection, &request, &device()).expect("a phone method") {
                            Ok(result) => rpc::success_response(&id, result),
                            Err(error) => error_response(&id, &error),
                        })
                    })
                    .await
                    .unwrap();
                    // Its first poll ran meanwhile: the delta was queued before this reply.
                    tokio::time::sleep(slow).await;
                    return response;
                }
                if request["method"] == "slow" {
                    tokio::time::sleep(slow).await;
                }
                // As `pairing.forget` does: the connection is cancelled before its reply is sent.
                if request["method"] == "forget" {
                    signals_tx.send(ConnectionSignal::Cancel).unwrap();
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                json!({ "id": request["id"], "ok": true, "result": {} })
            }
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
    phone.socket.close(Some(CloseFrame { code: 4000.into(), reason: "".into() })).await.unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
    assert_eq!(ended, Ended { reason: EndReason::PhoneClosed, close_code: Some(4000) });
}

/// #1282: a close frame says who ended the session. The phone app closes with
/// its own code, which the relay passes through; the relay closes with its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_close_frame_records_who_ended_the_session() {
    for (code, expected) in [
        (Some(4000), EndReason::PhoneClosed),
        (Some(1000), EndReason::PhoneClosed),
        (Some(4001), EndReason::ProbeTimeout),
        (Some(4002), EndReason::PhoneFailed),
        (Some(4408), EndReason::RelayClosed),
        (Some(4413), EndReason::RelayClosed),
        (Some(4101), EndReason::RelayClosed),
        (Some(1001), EndReason::Unknown),
        (None, EndReason::Unknown),
    ] {
        let (mut phone, _sink, server, home) = served(Duration::ZERO).await;
        phone.request("first", "status.get").await;
        while phone.read().await.expect("connected")["id"] != "first" {}
        phone.socket.close(code.map(|code| CloseFrame { code: code.into(), reason: "".into() })).await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
        assert_eq!(ended, Ended { reason: expected, close_code: code }, "close code {code:?}");
        drop(home);
    }
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

/// The forget acknowledgement reaches the phone although answering it
/// cancelled the connection, and the request after it is not answered.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reply_goes_out_before_a_signal_that_came_while_it_was_answered() {
    for _ in 0..20 {
        let (mut phone, _sink, server, _home) = served(Duration::ZERO).await;
        phone.request("forget", "forget").await;
        phone.request("after", "status.get").await;
        let reply = phone.read().await.expect("the acknowledgement");
        assert_eq!(reply["id"], "forget");
        assert!(phone.read().await.is_none(), "nothing after the cancellation");
        let ended = tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
        assert_eq!(ended.reason, EndReason::Cancelled);
    }
}

/// #1333: a terminal subscription's first poll can find a delta before its
/// reply, with the scrollback snapshot, is sent. The phone resets its screen
/// to the snapshot, so a delta ahead of it would be lost.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_subscription_reply_comes_before_its_first_stream_item() {
    let (mut phone, _sink, server, _home) = served(Duration::from_millis(600)).await;
    let params = json!({ "worktreeId": "session", "tabId": "tab", "attachMode": "observe", "client": {}, "capabilities": {} });
    phone.request_with("subscribe", "terminal.subscribe", params).await;
    let mut order = Vec::new();
    while order.len() < 2 {
        let message = phone.read().await.expect("still connected");
        if message["id"] == "subscribe" {
            assert_eq!(message["ok"], true, "{message}");
            order.push(match message["result"]["type"].as_str() { Some(kind) => kind.to_string(), None => "reply".into() });
        }
    }
    assert_eq!(order, ["reply", "data"]);
    // Live traffic was not held behind it: the connection still answers.
    phone.request("after", "status.get").await;
    while phone.read().await.expect("still connected")["id"] != "after" {}
    drop(phone);
    let ended = tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
    assert_eq!(ended.reason, EndReason::StreamEnded);
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
