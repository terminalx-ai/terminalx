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

#[tokio::test]
async fn supervisor_recovers_pairs_and_resets_backoff_after_another_disconnect() {
    let directory = tempfile::tempdir().unwrap();
    let account = Arc::new(crate::account::AccountManager::default());
    account.set_context_for_test(Some(context()));
    let manager = Arc::new(PairingManager::new(account));
    manager
        .diagnostics
        .lock()
        .unwrap()
        .configure(directory.path().to_owned())
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server_origin = origin.clone();
    let (drop_first, dropped) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut dropped = Some(dropped);
        for generation in 1..=2 {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, verify_control_headers)
                .await
                .unwrap();
            let hello: serde_json::Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(hello["type"], "host-hello");
            let (challenge, proof) = challenge(&HostKeypair::from_secret([5; 32]), &server_origin);
            socket
                .send(Message::Text(challenge.to_string().into()))
                .await
                .unwrap();
            let ack: serde_json::Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(ack["type"], "host-challenge-ack");
            assert_eq!(ack["proofB64"], proof);
            socket.send(Message::Text(serde_json::json!({
                "type": "host-hello-ack", "v": 1, "generation": generation,
                "controlResumeSecret": general_purpose::URL_SAFE_NO_PAD.encode([6; 32]),
                "leaseExpiresAt": now_ms() + 60_000, "activeConnIds": [], "pendingConns": [],
            }).to_string().into())).await.unwrap();
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
                let keypair = HostKeypair::from_secret([5; 32]);
                let assignment = RelayAssignment {
                    v: 1,
                    cell_url: origin,
                    assignment_epoch: 1,
                    lease: "synthetic-lease".into(),
                };
                let (socket, ack) =
                    open_control(&context, &keypair, &assignment, "synthetic-relay-token").await?;
                let (tx, rx) = mpsc::unbounded_channel();
                let live = RelayLive {
                    tx,
                    cell_url: assignment.cell_url,
                    assignment_epoch: 1,
                    relay_host_id: keypair.host_id(),
                    generation: ack.generation,
                };
                retry.connected(&manager, live.clone());
                control_loop(manager, socket, rx, live, context, keypair)
                    .await
                    .context(Stage::ControlSession)
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
