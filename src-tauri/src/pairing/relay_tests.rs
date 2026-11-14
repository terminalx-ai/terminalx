//! Loopback protocol fixtures use only generated keys and synthetic identities.
use super::*;
use base64::{engine::general_purpose, Engine};
use crypto_box::{
    aead::{generic_array::GenericArray, Aead},
    PublicKey, SalsaBox, SecretKey,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::atomic::{AtomicU32, Ordering};

fn context() -> AccountContext {
    AccountContext {
        access_token: "synthetic-access-token".into(),
        user_id: "test-user".into(),
        email: "fixture@example.invalid".into(),
        display_name: "Fixture".into(),
        profile_id: "test-profile".into(),
        organization_id: "test-org".into(),
        relay_entitled: true,
        generation: 1,
    }
}

async fn wait_until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("relay state transition timed out");
}

// Build the server's encrypted proof challenge independently of the client.
fn challenge(key: &HostKeypair, origin: &str) -> (serde_json::Value, String) {
    let relay_key = SecretKey::from([7; 32]);
    let nonce = [8; 24];
    let now = now_ms();
    let expires = now + 10_000;
    let mut transcript = Vec::new();
    let context = context();
    let host_id = key.host_id();
    for (name, value) in [
        ("protocol", b"terminalx-relay-host-proof/v1".as_slice()),
        ("version", &[1]),
        ("relayOrigin", origin.as_bytes()),
        ("relayEphemeralPublicKey", relay_key.public_key().as_bytes()),
        ("challengeNonce", &nonce),
        ("challengeId", b"test-challenge"),
        ("userId", context.user_id.as_bytes()),
        ("profileId", context.profile_id.as_bytes()),
        ("organizationId", context.organization_id.as_bytes()),
        ("relayHostId", host_id.as_bytes()),
        ("hostPublicKey", key.public()),
        ("assignmentEpoch", &1u64.to_be_bytes()),
        ("previousGeneration", &[]),
        ("resumeRequested", &[0]),
        ("issuedAt", &now.to_be_bytes()),
        ("expiresAt", &expires.to_be_bytes()),
    ] {
        transcript.extend_from_slice(&(name.len() as u32).to_be_bytes());
        transcript.extend_from_slice(name.as_bytes());
        transcript.extend_from_slice(&(value.len() as u32).to_be_bytes());
        transcript.extend_from_slice(value);
    }
    let secret = [9; 32];
    let mut plaintext = b"terminalx-relay-host-challenge/v1\0".to_vec();
    plaintext.extend_from_slice(&(transcript.len() as u32).to_be_bytes());
    plaintext.extend_from_slice(&transcript);
    plaintext.extend_from_slice(&secret);
    let cipher = SalsaBox::new(&PublicKey::from(*key.public()), &relay_key);
    let encrypted = cipher
        .encrypt(GenericArray::from_slice(&nonce), plaintext.as_slice())
        .unwrap();
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&secret).unwrap();
    mac.update(b"terminalx-relay-host-proof/v1\0ack\0");
    mac.update(&transcript);
    (
        serde_json::json!({
            "type": "host-challenge", "challengeId": "test-challenge",
            "relayEphemeralPublicKeyB64": general_purpose::STANDARD.encode(relay_key.public_key().as_bytes()),
            "nonceB64": general_purpose::STANDARD.encode(nonce),
            "ciphertextB64": general_purpose::STANDARD.encode(encrypted), "expiresAt": expires,
        }),
        general_purpose::STANDARD.encode(mac.finalize().into_bytes()),
    )
}

// The callback's error type is fixed by tungstenite's server handshake API.
#[allow(clippy::result_large_err)]
fn verify_control_headers(
    request: &tokio_tungstenite::tungstenite::handshake::server::Request,
    response: tokio_tungstenite::tungstenite::handshake::server::Response,
) -> std::result::Result<
    tokio_tungstenite::tungstenite::handshake::server::Response,
    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
> {
    assert_eq!(request.uri().path(), "/v1/host/control");
    assert_eq!(
        request.headers()["authorization"],
        "Bearer synthetic-relay-token"
    );
    Ok(response)
}

// The callback's error type is fixed by tungstenite's server handshake API.
#[allow(clippy::result_large_err)]
fn refuse_data_leg(
    request: &tokio_tungstenite::tungstenite::handshake::server::Request,
    _: tokio_tungstenite::tungstenite::handshake::server::Response,
) -> std::result::Result<
    tokio_tungstenite::tungstenite::handshake::server::Response,
    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
> {
    assert_eq!(request.uri().path(), "/v1/host/data/phone-connection");
    Err(tokio_tungstenite::tungstenite::http::Response::builder()
        .status(503)
        .body(None)
        .unwrap())
}

type CellSocket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// The cell's side of `open_control`, up to an acknowledged control channel.
async fn accept_control(
    listener: &tokio::net::TcpListener,
    origin: &str,
    generation: u64,
) -> CellSocket {
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = tokio_tungstenite::accept_hdr_async(stream, verify_control_headers)
        .await
        .unwrap();
    let hello: serde_json::Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(hello["type"], "host-hello");
    let (challenge, proof) = challenge(&HostKeypair::from_secret([5; 32]), origin);
    socket
        .send(Message::Text(challenge.to_string().into()))
        .await
        .unwrap();
    let ack: serde_json::Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(ack["type"], "host-challenge-ack");
    assert_eq!(ack["proofB64"], proof);
    socket.send(Message::Text(serde_json::json!({
        "type": "host-hello-ack", "v": 1, "generation": generation,
        "controlResumeSecret": general_purpose::URL_SAFE_NO_PAD.encode([6; 32]),
        "leaseExpiresAt": now_ms() + 60_000, "activeConnIds": [], "pendingConns": [],
    }).to_string().into())).await.unwrap();
    socket
}

/// The Mac's side: the same steps as `connect_once`, without the account service.
async fn connect_to_cell(
    manager: Arc<PairingManager>,
    context: AccountContext,
    retry: &mut RetryState,
    origin: String,
    timing: ControlTiming,
) -> Result<()> {
    let keypair = HostKeypair::from_secret([5; 32]);
    let assignment = RelayAssignment {
        v: 1,
        cell_url: origin,
        assignment_epoch: 1,
        lease: "synthetic-lease".into(),
    };
    let (socket, ack) = open_control(&context, &keypair, &assignment, "synthetic-relay-token").await?;
    let (tx, rx) = mpsc::unbounded_channel();
    let live = RelayLive {
        tx,
        signals: Arc::new(ControlSignals::new(now_ms())),
        director_url: "https://relay.example.invalid".into(),
        cell_url: assignment.cell_url,
        assignment_epoch: 1,
        relay_host_id: keypair.host_id(),
        generation: ack.generation,
    };
    retry.connected(&manager, live.clone());
    control_loop(manager, socket, rx, live, context, keypair, timing)
        .await
        .context(Stage::ControlSession)
}

fn manager_with_diagnostics(directory: &std::path::Path) -> Arc<PairingManager> {
    let account = Arc::new(crate::account::AccountManager::default());
    account.set_context_for_test(Some(context()));
    let manager = Arc::new(PairingManager::new(account));
    manager
        .diagnostics
        .lock()
        .unwrap()
        .configure(directory.to_owned())
        .unwrap();
    manager
}

fn diagnostic_records(directory: &std::path::Path) -> Vec<serde_json::Value> {
    let bytes =
        std::fs::read_to_string(directory.join(super::super::diagnostics::FILE_NAME)).unwrap();
    serde_json::from_str(&bytes).unwrap()
}

#[tokio::test]
async fn supervisor_recovers_pairs_and_resets_backoff_after_another_disconnect() {
    let directory = tempfile::tempdir().unwrap();
    let manager = manager_with_diagnostics(directory.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server_origin = origin.clone();
    let (drop_first, dropped) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut dropped = Some(dropped);
        for generation in 1..=2 {
            let mut socket = accept_control(&listener, &server_origin, generation).await;
            let invite: serde_json::Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(invite["type"], "invite-create");
            assert_eq!(invite["relayDeviceId"], "synthetic-device");
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "type": "invite-created", "reqId": invite["reqId"],
                        "inviteToken": general_purpose::URL_SAFE_NO_PAD.encode([4; 32]),
                        "expiresAt": now_ms() + 60_000, "maxAttempts": 1,
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            if generation == 1 {
                dropped.take().unwrap().await.unwrap();
                socket.close(None).await.unwrap();
            } else {
                assert!(matches!(
                    socket.next().await.unwrap().unwrap(),
                    Message::Close(_)
                ));
            }
        }
    });
    let calls = Arc::new(AtomicU32::new(0));
    let calls_for_connect = calls.clone();
    let supervisor = tokio::spawn(supervise_with(
        manager.clone(),
        move |manager, context, retry| {
            let call = calls_for_connect.fetch_add(1, Ordering::SeqCst) + 1;
            let origin = origin.clone();
            Box::pin(async move {
                if call <= 2 {
                    assert_eq!(retry.attempts, call);
                    assert_eq!(retry.reconnect, call > 1);
                    return Err(anyhow!(cloud::CloudHttpError(502))
                        .context("private response token=secret")
                        .context(Stage::Assignment));
                }
                assert!(retry.reconnect);
                assert_eq!(retry.attempts, if call == 3 { 3 } else { 1 });
                connect_to_cell(manager, context, retry, origin, ControlTiming::default()).await
            })
        },
    ));
    wait_until(|| {
        manager.inner.lock().unwrap().relay_status.phase == super::super::RelayPhase::Offline
    })
    .await;
    {
        let inner = manager.inner.lock().unwrap();
        assert!(inner
            .relay_status
            .message
            .as_ref()
            .unwrap()
            .contains("service is temporarily unavailable"));
        assert_eq!(inner.relay_status.attempt, 1);
        assert!(inner.relay.is_none());
    }
    let mut drop_first = Some(drop_first);
    for generation in 1..=2 {
        wait_until(|| {
            manager
                .current_relay()
                .is_some_and(|live| live.generation == generation)
        })
        .await;
        assert_eq!(manager.inner.lock().unwrap().relay_status.attempt, 0);
        let live = manager.current_relay().unwrap();
        let offer = live.create_invite("synthetic-device".into()).await.unwrap();
        assert_eq!(offer.e2ee_framing, 2);
        assert_eq!(
            offer.invite_token,
            general_purpose::URL_SAFE_NO_PAD.encode([4; 32])
        );
        if generation == 1 {
            drop_first.take().unwrap().send(()).unwrap();
            wait_until(|| manager.current_relay().is_none()).await;
            assert_eq!(manager.inner.lock().unwrap().relay_status.attempt, 0);
        } else {
            manager.stopped.store(true, Ordering::SeqCst);
            live.shutdown();
        }
    }
    server.await.unwrap();
    supervisor.await.unwrap();
    let bytes =
        std::fs::read_to_string(directory.path().join(super::super::diagnostics::FILE_NAME))
            .unwrap();
    let records: serde_json::Value = serde_json::from_str(&bytes).unwrap();
    assert_eq!(
        records
            .as_array()
            .unwrap()
            .iter()
            .filter(|record| record["event"] == "connected")
            .count(),
        2
    );
    assert!(bytes.contains("service-unavailable"));
    for sensitive in [
        "secret",
        "synthetic",
        "127.0.0.1",
        "fixture@example.invalid",
    ] {
        assert!(!bytes.contains(sensitive));
    }
}

/// The control loop must notice a cell that has gone quiet (#666): its timer
/// spans loop passes, so the account tick cannot keep restarting it. A
/// channel the cell keeps pinging is left alone.
#[tokio::test]
async fn a_control_channel_that_goes_silent_is_replaced_and_recorded() {
    let timing = ControlTiming {
        tick: Duration::from_millis(20),
        silence: Duration::from_millis(250),
    };
    let directory = tempfile::tempdir().unwrap();
    let manager = manager_with_diagnostics(directory.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server_origin = origin.clone();
    let server = tokio::spawn(async move {
        // The first channel looks open but never carries another frame, like
        // one whose source address is gone.
        let _silent = accept_control(&listener, &server_origin, 1).await;
        let mut live = accept_control(&listener, &server_origin, 2).await;
        // Four silence periods of pings, each answered.
        for t in 0..20 {
            live.send(Message::Text(serde_json::json!({ "type": "ping", "t": t }).to_string().into()))
                .await
                .unwrap();
            let pong: serde_json::Value =
                serde_json::from_str(live.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(pong, serde_json::json!({ "type": "pong", "t": t }));
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        live
    });
    let supervisor = tokio::spawn(supervise_with(manager.clone(), move |manager, context, retry| {
        Box::pin(connect_to_cell(manager, context, retry, origin.clone(), timing))
    }));
    wait_until(|| manager.current_relay().is_some_and(|live| live.generation == 2)).await;
    let mut live_socket = server.await.unwrap();
    // Still the second channel after a second of pings: no silence detected.
    assert_eq!(manager.current_relay().unwrap().generation, 2);
    manager.stopped.store(true, Ordering::SeqCst);
    manager.current_relay().unwrap().shutdown();
    assert!(matches!(live_socket.next().await.unwrap().unwrap(), Message::Close(_)));
    supervisor.await.unwrap();
    let records = diagnostic_records(directory.path());
    let events: Vec<_> = records.iter().map(|record| record["event"].as_str().unwrap()).collect();
    assert_eq!(events, ["started", "connected", "failed", "connected"]);
    assert_eq!(
        records[2]["failure"],
        serde_json::json!({ "stage": "control-session", "category": "timeout", "httpStatus": null })
    );
}

/// A phone that reaches the cell but whose data leg never attaches leaves a
/// trace on the Mac (#666), and the control channel carries on.
#[tokio::test]
async fn a_phone_leg_that_cannot_attach_is_recorded_on_the_mac() {
    let directory = tempfile::tempdir().unwrap();
    let manager = manager_with_diagnostics(directory.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server_origin = origin.clone();
    let server = tokio::spawn(async move {
        let mut control = accept_control(&listener, &server_origin, 1).await;
        control
            .send(Message::Text(serde_json::json!({
                "type": "conn-open", "connId": "phone-connection",
                "connTicket": general_purpose::URL_SAFE_NO_PAD.encode([3; 32]),
                "kind": "resume", "relayDeviceId": "phone-device", "attachDeadlineMs": 5_000,
            }).to_string().into()))
            .await
            .unwrap();
        // The cell refuses the host data leg's WebSocket upgrade.
        let (data, _) = listener.accept().await.unwrap();
        let refused = tokio_tungstenite::accept_hdr_async(data, refuse_data_leg).await;
        assert!(refused.is_err());
        control
    });
    let supervisor = tokio::spawn(supervise_with(manager.clone(), move |manager, context, retry| {
        Box::pin(connect_to_cell(manager, context, retry, origin.clone(), ControlTiming::default()))
    }));
    let mut control = server.await.unwrap();
    wait_until(|| {
        diagnostic_records(directory.path())
            .iter()
            .any(|record| record["event"] == "phone-failed")
    })
    .await;
    assert_eq!(manager.current_relay().unwrap().generation, 1);
    manager.stopped.store(true, Ordering::SeqCst);
    manager.current_relay().unwrap().shutdown();
    assert!(matches!(control.next().await.unwrap().unwrap(), Message::Close(_)));
    supervisor.await.unwrap();
    let records = diagnostic_records(directory.path());
    let events: Vec<_> = records.iter().map(|record| record["event"].as_str().unwrap()).collect();
    assert_eq!(events, ["started", "connected", "phone-requested", "phone-failed"]);
    assert_eq!(
        records[3]["failure"],
        serde_json::json!({ "stage": "phone-attach", "category": "service-unavailable", "httpStatus": 503 })
    );
    let bytes = serde_json::to_string(&records).unwrap();
    for sensitive in ["phone-connection", "phone-device", "127.0.0.1"] {
        assert!(!bytes.contains(sensitive));
    }
}

#[tokio::test]
async fn control_frames_prove_liveness_and_carry_the_pairing_hint() {
    let account = Arc::new(crate::account::AccountManager::default());
    account.set_context_for_test(Some(context()));
    let manager = Arc::new(PairingManager::new(account));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server_origin = origin.clone();
    let (send_hint, hint_requested) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(stream, verify_control_headers)
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        let (challenge, _) = challenge(&HostKeypair::from_secret([5; 32]), &server_origin);
        socket.send(Message::Text(challenge.to_string().into())).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket.send(Message::Text(serde_json::json!({
            "type": "host-hello-ack", "v": 1, "generation": 1,
            "controlResumeSecret": general_purpose::URL_SAFE_NO_PAD.encode([6; 32]),
            "leaseExpiresAt": now_ms() + 60_000, "activeConnIds": [], "pendingConns": [],
        }).to_string().into())).await.unwrap();
        socket.send(Message::Text(r#"{"type":"ping","t":1}"#.into())).await.unwrap();
        let pong: serde_json::Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(pong, serde_json::json!({ "type": "pong", "t": 1 }));
        hint_requested.await.unwrap();
        socket.send(Message::Text(r#"{"type":"account-pairing-changed"}"#.into())).await.unwrap();
        // Like every control frame, the hint takes no field it does not know.
        socket
            .send(Message::Text(r#"{"type":"account-pairing-changed","hostId":"other"}"#.into()))
            .await
            .unwrap();
        while let Some(Ok(message)) = socket.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
    });
    let keypair = HostKeypair::from_secret([5; 32]);
    let assignment = RelayAssignment {
        v: 1,
        cell_url: origin,
        assignment_epoch: 1,
        lease: "synthetic-lease".into(),
    };
    let (socket, ack) = open_control(&context(), &keypair, &assignment, "synthetic-relay-token")
        .await
        .unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    let live = RelayLive {
        tx,
        // Silent since before the connection, so only a new frame can verify it.
        signals: Arc::new(ControlSignals::new(now_ms() - 60_000)),
        director_url: "https://relay.example.invalid".into(),
        cell_url: assignment.cell_url,
        assignment_epoch: 1,
        relay_host_id: keypair.host_id(),
        generation: ack.generation,
    };
    assert!(!live.control_verified());
    let control = tokio::spawn(control_loop(
        manager, socket, rx, live.clone(), context(), keypair, ControlTiming::default(),
    ));
    wait_until(|| live.control_verified()).await;
    send_hint.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), live.pairing_changed())
        .await
        .expect("the hint reaches the host-binding poll");
    let error = tokio::time::timeout(Duration::from_secs(5), control)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(error.downcast_ref::<serde_json::Error>().is_some(), "{error:#}");
    tokio::time::timeout(Duration::from_secs(5), live.control_closed())
        .await
        .expect("the poll sees the channel close");
    server.abort();
}
