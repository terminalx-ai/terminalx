//! PRO-314 (docs/PAIRING-APPROVAL.md): a QR pairing waits for approval on the
//! Mac, devices carry fingerprints and connection paths, a disconnect keeps
//! the pairing, and the Mac stays awake only while a phone is connected.
//!
//! Phones here run the real v2 handshake over an in-memory WebSocket against
//! `handle_e2ee_socket`; secrets live in an in-memory store. No local runtime
//! is attached, so an authenticated connection ends right after
//! `e2ee_authenticated`, which is as far as pairing needs.
use super::crypto::{E2eeClientHandshake, E2eeSession};
use super::*;
use crate::keychain::testing::MemorySecrets;
use serde_json::json;
use std::time::Duration;
use tokio::io::DuplexStream;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::Role;

const PENDING: &str = "pending-phone";
const PENDING_TOKEN: &str = "pending-credential";
const PHONE: [u8; 32] = [0x21; 32];
const OTHER_PHONE: [u8; 32] = [0x42; 32];

struct Fixture {
    manager: Arc<PairingManager>,
    store: MemorySecrets,
    host: HostKeypair,
    _home: crate::store::TempHome,
}

fn manager(ttl_ms: i64) -> (Arc<PairingManager>, MemorySecrets, crate::store::TempHome) {
    let home = crate::store::temp_home();
    let store = MemorySecrets::default();
    let mut manager = PairingManager::new(Arc::new(AccountManager::default()));
    manager.secrets = PairingSecrets::with_store(Arc::new(store.clone()));
    manager.approval_ttl_ms = ttl_ms;
    manager.secrets.configure("test.terminalx.pairing-approval").unwrap();
    (Arc::new(manager), store, home)
}

fn entry(id: &str, token: &str) -> DeviceEntry {
    DeviceEntry {
        id: id.into(),
        label: "TerminalX Mobile".into(),
        platform: "mobile".into(),
        token: token_hash(token),
        scope: DeviceScope::Driver,
        provenance: DeviceProvenance::Explicit,
        bound_user_id: None,
        binding_generation: 0,
        public_key: String::new(),
        created_at: Utc::now().to_rfc3339(),
        last_seen_at: None,
        revoked_at: None,
        installation_id: None,
        created_request_id: None,
        fingerprint: None,
        approved_at: None,
        connection: None,
        last_seen_transport: None,
    }
}

/// What `generate_pairing` leaves behind once its code is shown.
fn fixture(ttl_ms: i64) -> Fixture {
    let (manager, store, home) = manager(ttl_ms);
    let host = manager.host_key(true).unwrap();
    manager.secrets.save_device_token(PENDING, PENDING_TOKEN).unwrap();
    manager.registry.add(entry(PENDING, PENDING_TOKEN)).unwrap();
    {
        let mut inner = manager.inner.lock().unwrap();
        inner.active_pairing = Some(PairingCode {
            pairing_url: "terminalx://pair?code=fixture".into(),
            expires_at: Utc::now().timestamp_millis() + OFFER_TTL_MS,
            connection_mode: PairingConnectionMode::Automatic,
            direct_available: true,
            transport: PairingTransport::Relay,
        });
        inner.pending_pairing_device = Some(PENDING.into());
    }
    Fixture { manager, store, host, _home: home }
}

struct Phone {
    socket: WebSocketStream<DuplexStream>,
    session: E2eeSession,
    key_b64: String,
    server: JoinHandle<Result<()>>,
}

/// One candidate of a phone with the long-lived key `secret`, through
/// `e2ee_auth` with `token`.
async fn connect(manager: &Arc<PairingManager>, host: &HostKeypair, secret: [u8; 32], relay: bool, token: &str, expected: Option<&str>) -> Phone {
    let (host_io, phone_io) = tokio::io::duplex(64 * 1024);
    let host_socket = WebSocketStream::from_raw_socket(host_io, Role::Server, Some(pairing_websocket_config())).await;
    let mut socket = WebSocketStream::from_raw_socket(phone_io, Role::Client, Some(pairing_websocket_config())).await;
    let relay_host_id = relay.then(|| host.host_id());
    let context = match &relay_host_id {
        Some(relay_host_id) => PairingConnectionContext::Relay {
            relay_host_id: relay_host_id.clone(),
            credential_kind: "invite".into(),
            basis_conn_id: "conn-1".into(),
        },
        None => PairingConnectionContext::Direct { direct_auth_id: "direct-1".into() },
    };
    let (server_manager, expected) = (manager.clone(), expected.map(str::to_string));
    let server = tokio::spawn(async move { server_manager.handle_e2ee_socket(host_socket, context, expected, None).await });
    let transport = if relay { "relay" } else { "direct" };
    let handshake = E2eeClientHandshake::with_secret(secret, &host.public_key_b64(), transport, relay_host_id.as_deref()).unwrap();
    let key_b64 = handshake.hello().client_public_key_b64.clone();
    socket.send(Message::Text(serde_json::to_string(handshake.hello()).unwrap().into())).await.unwrap();
    let ready = socket.next().await.unwrap().unwrap().into_text().unwrap();
    let mut session = handshake.accept_ready(&ready).unwrap();
    let auth = json!({ "type": "e2ee_auth", "v": 2, "transcriptHashB64": session.transcript_hash_b64, "deviceToken": token });
    let frame = session.seal(auth.to_string().as_bytes(), PayloadKind::Text).unwrap();
    socket.send(Message::Text(general_purpose::STANDARD.encode(frame).into())).await.unwrap();
    Phone { socket, session, key_b64, server }
}

async fn connect_pending(fixture: &Fixture, secret: [u8; 32], relay: bool) -> Phone {
    connect(&fixture.manager, &fixture.host, secret, relay, PENDING_TOKEN, relay.then_some(PENDING)).await
}

/// The phone's next message: `true` for `e2ee_authenticated`, `false` when
/// the Mac closed the connection instead.
async fn authenticated(phone: &mut Phone) -> bool {
    let next = tokio::time::timeout(Duration::from_secs(5), phone.socket.next()).await.expect("the Mac answered the phone");
    match next {
        Some(Ok(Message::Text(text))) => {
            let frame = general_purpose::STANDARD.decode(text.as_bytes()).unwrap();
            let message: serde_json::Value = serde_json::from_slice(&phone.session.open(&frame, PayloadKind::Text).unwrap()).unwrap();
            assert_eq!(message["type"], "e2ee_authenticated", "{message}");
            assert_eq!(message["transcriptHashB64"], phone.session.transcript_hash_b64.as_str());
            true
        }
        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => false,
        Some(Ok(other)) => panic!("unexpected frame before authentication: {other:?}"),
    }
}

/// Nothing reaches the phone for a while: it is still waiting.
async fn still_waiting(phone: &mut Phone) {
    assert!(tokio::time::timeout(Duration::from_millis(300), phone.socket.next()).await.is_err(), "the phone was answered before approval");
}

async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

async fn pending_request(manager: &PairingManager) -> PairingApprovalRequest {
    eventually("a pending approval", || manager.status().pending_approval.is_some()).await;
    manager.status().pending_approval.unwrap()
}

fn saved(manager: &PairingManager, id: &str) -> Option<DeviceEntry> {
    manager.registry.list().unwrap().into_iter().find(|device| device.id == id)
}

/// No device, no Keychain token, no code: nothing of the pairing is left.
fn nothing_left(fixture: &Fixture) {
    assert!(fixture.manager.registry.list().unwrap().is_empty());
    let service = fixture.manager.secrets.service_name().unwrap();
    assert_eq!(fixture.store.stored(service, &format!("device-{PENDING}")), None);
    let status = fixture.manager.status();
    assert!(status.pending_approval.is_none());
    assert!(status.active_pairing.is_none());
    assert!(status.devices.is_empty());
    assert!(fixture.manager.inner.lock().unwrap().pending_pairing_device.is_none());
}

#[tokio::test]
async fn approval_holds_both_racing_connections_then_releases_them_together() {
    let fixture = fixture(APPROVAL_TTL_MS);
    let mut direct = connect_pending(&fixture, PHONE, false).await;
    let request = pending_request(&fixture.manager).await;
    let expected = fingerprint::fingerprint_b64(fixture.host.public(), &direct.key_b64).unwrap();
    assert_eq!((request.device_id.as_str(), request.fingerprint.as_str(), request.transport), (PENDING, expected.as_str(), PairingTransport::Direct));
    assert_eq!(request.expires_at - request.requested_at, APPROVAL_TTL_MS);
    // The phone's Relay candidate, with the same key, waits on the same request.
    let mut relay = connect_pending(&fixture, PHONE, true).await;
    still_waiting(&mut direct).await;
    still_waiting(&mut relay).await;
    assert_eq!(fixture.manager.status().pending_approval, Some(request.clone()));
    let waiting = saved(&fixture.manager, PENDING).unwrap();
    assert_eq!((waiting.approved_at.as_deref(), waiting.last_seen_at.as_deref()), (None, None));
    assert!(fixture.manager.status().devices.is_empty());

    // The code's own expiry does not cut the pending approval short.
    fixture.manager.inner.lock().unwrap().active_pairing.as_mut().unwrap().expires_at = Utc::now().timestamp_millis() - 1;
    assert_eq!(fixture.manager.status().pending_approval, Some(request.clone()));
    assert!(saved(&fixture.manager, PENDING).is_some());

    assert!(fixture.manager.approve_pairing("another-request").is_err());
    let status = fixture.manager.approve_pairing(&request.request_id).unwrap();
    assert!(status.pending_approval.is_none());
    // Pinned to the compared key before any candidate goes on.
    let approved = saved(&fixture.manager, PENDING).unwrap();
    assert_eq!((approved.public_key.as_str(), approved.approved_at.is_some()), (direct.key_b64.as_str(), true));
    assert!(authenticated(&mut direct).await);
    assert!(authenticated(&mut relay).await);

    let device = saved(&fixture.manager, PENDING).unwrap();
    assert!(device.approved_at.is_some());
    assert_eq!(device.fingerprint.as_deref(), Some(expected.as_str()));
    assert_eq!(device.public_key, direct.key_b64);
    assert!(device.last_seen_at.is_some());
    assert!(device.last_seen_transport.is_some());
    let status = fixture.manager.status();
    assert!(status.active_pairing.is_none());
    assert_eq!(status.devices.iter().map(|device| device.id.as_str()).collect::<Vec<_>>(), [PENDING]);
    // Past authentication each ends where the absent runtime stops it.
    for phone in [direct, relay] {
        assert!(phone.server.await.unwrap().is_err());
    }
}

/// A candidate that looked the device up just before the approval reaches the
/// gate with that stale entry after it, even after the first candidate claimed
/// the code: it goes on, and no second request is opened.
#[tokio::test]
async fn a_candidate_that_looked_up_the_device_before_approval_still_goes_on() {
    let fixture = fixture(APPROVAL_TTL_MS);
    let stale = saved(&fixture.manager, PENDING).unwrap();
    let mut direct = connect_pending(&fixture, PHONE, false).await;
    let request = pending_request(&fixture.manager).await;
    fixture.manager.approve_pairing(&request.request_id).unwrap();
    assert!(authenticated(&mut direct).await);
    assert!(fixture.manager.inner.lock().unwrap().pending_pairing_device.is_none(), "the first candidate claimed the code");

    let (host_io, _phone_io) = tokio::io::duplex(1024);
    let mut late = WebSocketStream::from_raw_socket(host_io, Role::Server, None).await;
    let fingerprint = fingerprint::fingerprint_b64(fixture.host.public(), &direct.key_b64).unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        fixture.manager.await_approval(&mut late, &stale, &direct.key_b64, &fingerprint, PairingTransport::Relay),
    )
    .await
    .expect("not held again")
    .unwrap();
    assert!(fixture.manager.status().pending_approval.is_none());
}

#[tokio::test]
async fn a_second_phone_key_while_one_is_pending_is_refused_and_closed() {
    let fixture = fixture(APPROVAL_TTL_MS);
    let mut first = connect_pending(&fixture, PHONE, false).await;
    let request = pending_request(&fixture.manager).await;
    let mut other = connect_pending(&fixture, OTHER_PHONE, true).await;
    assert!(!authenticated(&mut other).await);
    let refused = other.server.await.unwrap().unwrap_err();
    assert!(format!("{refused:#}").contains("another phone is already waiting"), "{refused:#}");
    // The first phone's request is untouched.
    assert_eq!(fixture.manager.status().pending_approval, Some(request.clone()));
    still_waiting(&mut first).await;
    fixture.manager.approve_pairing(&request.request_id).unwrap();
    assert!(authenticated(&mut first).await);
    let device = saved(&fixture.manager, PENDING).unwrap();
    assert_eq!(device.public_key, first.key_b64);
}

#[tokio::test]
async fn decline_leaves_no_device_token_or_code() {
    let fixture = fixture(APPROVAL_TTL_MS);
    let service = fixture.manager.secrets.service_name().unwrap().to_string();
    assert!(fixture.store.stored(&service, &format!("device-{PENDING}")).is_some());
    let mut direct = connect_pending(&fixture, PHONE, false).await;
    let request = pending_request(&fixture.manager).await;
    let mut relay = connect_pending(&fixture, PHONE, true).await;
    still_waiting(&mut relay).await;

    assert!(fixture.manager.decline_pairing("another-request").is_err());
    let status = fixture.manager.decline_pairing(&request.request_id).unwrap();
    assert!(status.pending_approval.is_none() && status.active_pairing.is_none());
    assert!(!authenticated(&mut direct).await);
    assert!(!authenticated(&mut relay).await);
    for phone in [direct, relay] {
        let error = phone.server.await.unwrap().unwrap_err();
        assert!(format!("{error:#}").contains("not approved"), "{error:#}");
    }
    nothing_left(&fixture);
    // The credential authenticates nothing any more.
    let mut again = connect_pending(&fixture, PHONE, false).await;
    assert!(!authenticated(&mut again).await);
    assert!(fixture.manager.decline_pairing(&request.request_id).is_err());
}

#[tokio::test]
async fn an_approval_nobody_answers_times_out_and_leaves_no_device_token_or_code() {
    let fixture = fixture(300);
    let mut phone = connect_pending(&fixture, PHONE, true).await;
    let request = pending_request(&fixture.manager).await;
    assert_eq!(request.transport, PairingTransport::Relay);
    assert!(!authenticated(&mut phone).await);
    // The request and the code go at once; the device and its token right after.
    eventually("the approval to time out", || fixture.manager.status().pending_approval.is_none()).await;
    assert!(fixture.manager.status().active_pairing.is_none());
    let service = fixture.manager.secrets.service_name().unwrap().to_string();
    eventually("the device and its token to be discarded", || {
        fixture.manager.registry.list().unwrap().is_empty()
            && fixture.store.stored(&service, &format!("device-{PENDING}")).is_none()
    })
    .await;
    nothing_left(&fixture);
    assert!(fixture.manager.approve_pairing(&request.request_id).is_err());
}

#[tokio::test]
async fn no_new_approval_starts_once_the_code_expired() {
    let fixture = fixture(APPROVAL_TTL_MS);
    fixture.manager.inner.lock().unwrap().active_pairing.as_mut().unwrap().expires_at = Utc::now().timestamp_millis() - 1;
    let mut phone = connect_pending(&fixture, PHONE, false).await;
    assert!(!authenticated(&mut phone).await);
    let error = phone.server.await.unwrap().unwrap_err();
    assert!(format!("{error:#}").contains("expired"), "{error:#}");
    assert!(fixture.manager.inner.lock().unwrap().pending_approval.is_none());
}

#[tokio::test]
async fn phones_paired_before_approval_and_account_pairings_are_not_held() {
    let (manager, _store, _home) = manager(APPROVAL_TTL_MS);
    let host = manager.host_key(true).unwrap();
    let legacy_key = general_purpose::STANDARD.encode(HostKeypair::from_secret(PHONE).public());
    manager.registry.add(DeviceEntry { last_seen_at: Some(Utc::now().to_rfc3339()), public_key: legacy_key.clone(), ..entry("legacy", "legacy-credential") }).unwrap();
    manager.registry.add(DeviceEntry { provenance: DeviceProvenance::Automatic, ..entry("automatic", "automatic-credential") }).unwrap();

    // Its fingerprint comes from the key it already connected with.
    let expected = fingerprint::fingerprint_b64(host.public(), &legacy_key).unwrap();
    let listed = manager.status().devices.into_iter().find(|device| device.id == "legacy").unwrap();
    assert_eq!((listed.fingerprint.as_deref(), listed.approved_at.as_deref()), (Some(expected.as_str()), None));

    let mut legacy = connect(&manager, &host, PHONE, false, "legacy-credential", None).await;
    assert_eq!(legacy.key_b64, legacy_key);
    assert!(authenticated(&mut legacy).await);
    let mut automatic = connect(&manager, &host, OTHER_PHONE, true, "automatic-credential", Some("automatic")).await;
    assert!(authenticated(&mut automatic).await);
    assert!(manager.status().pending_approval.is_none());

    let legacy = saved(&manager, "legacy").unwrap();
    assert_eq!((legacy.fingerprint.as_deref(), legacy.last_seen_transport), (Some(expected.as_str()), Some(PairingTransport::Direct)));
    let automatic = saved(&manager, "automatic").unwrap();
    assert_eq!(automatic.last_seen_transport, Some(PairingTransport::Relay));
    assert!(automatic.fingerprint.is_some() && automatic.approved_at.is_none());

    // An unclaimed QR device whose code is no longer active is refused.
    manager.registry.add(entry("stray", "stray-credential")).unwrap();
    let mut stray = connect(&manager, &host, PHONE, false, "stray-credential", None).await;
    assert!(!authenticated(&mut stray).await);
}

/// The id of the assertion the manager holds for connected phones, as the
/// power module lists it.
fn held_assertion(manager: &PairingManager) -> Option<crate::power::Held> {
    let serial = manager.keep_awake.lock().unwrap().assertion.as_ref().map(crate::power::Assertion::serial)?;
    crate::power::held().into_iter().find(|held| held.serial == serial)
}

fn claimed(manager: &PairingManager, id: &str) {
    manager
        .registry
        .add(DeviceEntry { last_seen_at: Some(Utc::now().to_rfc3339()), approved_at: Some(Utc::now().to_rfc3339()), ..entry(id, id) })
        .unwrap();
}

#[test]
fn disconnect_tells_the_phone_closes_its_connections_and_keeps_the_pairing() {
    let (manager, _store, _home) = manager(APPROVAL_TTL_MS);
    claimed(&manager, "phone");
    claimed(&manager, "tablet");
    assert!(manager.status().keep_awake, "keep awake is on by default");
    assert!(held_assertion(&manager).is_none());

    let (direct, mut direct_signal) = manager.track_connection("phone", PairingTransport::Direct);
    let (relay, mut relay_signal) = manager.track_connection("phone", PairingTransport::Relay);
    let (tablet, mut tablet_signal) = manager.track_connection("tablet", PairingTransport::Direct);
    let status = manager.status();
    let phone = status.devices.iter().find(|device| device.id == "phone").unwrap();
    // The most recent live connection wins.
    assert_eq!(phone.connection.as_ref().map(|connection| connection.transport), Some(PairingTransport::Relay));
    assert!(phone.connection.as_ref().is_some_and(|connection| DateTime::parse_from_rfc3339(&connection.since).is_ok()));
    let held = held_assertion(&manager).expect("a connected phone keeps the Mac awake");
    assert_eq!(held.reason, crate::power::PHONE_CONNECTED);
    #[cfg(target_os = "macos")]
    assert!(held.id.is_some_and(|id| id != 0), "IOPMAssertionCreateWithName returned no id");

    let status = manager.disconnect_device("phone").unwrap();
    assert_eq!(direct_signal.try_recv(), Ok(ConnectionSignal::Disconnect));
    assert_eq!(relay_signal.try_recv(), Ok(ConnectionSignal::Disconnect));
    assert!(tablet_signal.try_recv().is_err());
    let phone = status.devices.iter().find(|device| device.id == "phone").expect("the pairing is kept");
    assert!(phone.connection.is_none());
    assert!(saved(&manager, "phone").is_some());
    // The tablet is still connected, so the Mac stays awake for it.
    assert_eq!(held_assertion(&manager).map(|held| held.serial), Some(held.serial));
    drop((direct, relay));

    drop(tablet);
    assert!(held_assertion(&manager).is_none());
    assert!(!crate::power::held().iter().any(|listed| listed.serial == held.serial), "released after the last connection");
    assert!(manager.status().devices.iter().all(|device| device.connection.is_none()));
    assert!(manager.disconnect_device("never-paired").is_err());
    assert_eq!(
        disconnected_notification(),
        json!({ "method": "pairing.disconnected", "params": { "reason": "disconnected-on-mac" } })
    );
}

#[test]
fn keep_awake_is_persisted_and_held_only_while_on_and_connected() {
    let (manager, _store, _home) = manager(APPROVAL_TTL_MS);
    claimed(&manager, "phone");
    assert!(crate::store::settings::load().pairing.keep_awake);

    let status = manager.set_keep_awake(false).unwrap();
    assert!(!status.keep_awake);
    assert!(!crate::store::settings::load().pairing.keep_awake);
    let (connection, _signal) = manager.track_connection("phone", PairingTransport::Relay);
    assert!(held_assertion(&manager).is_none(), "off: no assertion while connected");

    assert!(manager.set_keep_awake(true).unwrap().keep_awake);
    assert!(crate::store::settings::load().pairing.keep_awake);
    let held = held_assertion(&manager).expect("on and connected: held");
    #[cfg(target_os = "macos")]
    assert!(held.id.is_some());
    manager.set_keep_awake(false).unwrap();
    assert!(!crate::power::held().iter().any(|listed| listed.serial == held.serial), "turning it off releases it");
    manager.set_keep_awake(true).unwrap();
    assert!(held_assertion(&manager).is_some());

    // A settings file edited by hand is followed.
    let mut settings = crate::store::settings::load();
    settings.pairing.keep_awake = false;
    crate::store::settings::save(&settings).unwrap();
    manager.reload_keep_awake();
    assert!(!manager.status().keep_awake);
    assert!(held_assertion(&manager).is_none());
    manager.set_keep_awake(true).unwrap();

    drop(connection);
    assert!(held_assertion(&manager).is_none(), "released when the last connection closes");
    // Revoking cancels the connection and releases the assertion as well.
    let (_revoked, mut signal) = manager.track_connection("phone", PairingTransport::Direct);
    assert!(held_assertion(&manager).is_some());
    manager.cancel_connections("phone");
    assert_eq!(signal.try_recv(), Ok(ConnectionSignal::Cancel));
    assert!(held_assertion(&manager).is_none());
}

#[test]
fn device_describe_stores_a_clean_name_for_drivers_only() {
    let (manager, _store, _home) = manager(APPROVAL_TTL_MS);
    claimed(&manager, "phone");
    let device = saved(&manager, "phone").unwrap();
    assert!(allowed_method(DeviceScope::Driver, "device.describe"));
    assert!(!allowed_method(DeviceScope::Viewer, "device.describe"));

    let described = manager.describe_device(&device, Some(&json!({ "label": "  Paresh\u{2019}s\u{0007} iPhone\u{200B} ", "platform": "ios" })));
    assert_eq!(described.unwrap(), json!({ "ok": true }));
    let saved_device = saved(&manager, "phone").unwrap();
    assert_eq!((saved_device.label.as_str(), saved_device.platform.as_str()), ("Paresh\u{2019}s iPhone", "ios"));
    manager.describe_device(&device, Some(&json!({ "label": "p".repeat(100), "platform": "android" }))).unwrap();
    assert_eq!(saved(&manager, "phone").unwrap().label.chars().count(), 64);

    for refused in [
        json!({ "label": " \u{0007} ", "platform": "ios" }),
        json!({ "label": "Phone", "platform": "windows" }),
        json!({ "label": "Phone" }),
        json!({ "label": "Phone", "platform": "ios", "extra": true }),
    ] {
        assert!(manager.describe_device(&device, Some(&refused)).is_err(), "{refused}");
    }
    assert_eq!(saved(&manager, "phone").unwrap().platform, "android");
}

#[test]
fn status_and_devices_serialise_to_the_typescript_shapes() {
    let device = DeviceEntry {
        fingerprint: Some("1177\u{00B7}11ED".into()),
        approved_at: Some("2026-11-12T10:00:00+00:00".into()),
        connection: Some(PairedDeviceConnection { transport: PairingTransport::Relay, since: "2026-11-12T10:01:00+00:00".into() }),
        last_seen_transport: Some(PairingTransport::Direct),
        last_seen_at: Some("2026-11-12T10:01:00+00:00".into()),
        public_key: "key".into(),
        ..entry("phone", "token")
    };
    let value = serde_json::to_value(&device).unwrap();
    for key in ["fingerprint", "approvedAt", "connection", "lastSeenTransport", "publicKey", "createdAt", "lastSeenAt", "bindingGeneration"] {
        assert!(value.get(key).is_some(), "{key} in {value}");
    }
    assert_eq!(value["fingerprint"], "1177\u{00B7}11ED");
    assert_eq!(value["connection"], json!({ "transport": "relay", "since": "2026-11-12T10:01:00+00:00" }));
    assert_eq!(value["lastSeenTransport"], "direct");
    // The new fields are optional, as in TypeScript, and a saved file never carries a connection.
    let bare = serde_json::to_value(entry("phone", "token")).unwrap();
    for key in ["fingerprint", "approvedAt", "connection", "lastSeenTransport"] {
        assert!(bare.get(key).is_none(), "{key} in {bare}");
    }
    let read: DeviceEntry = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(read.connection, None);
    assert_eq!((read.fingerprint, read.last_seen_transport), (device.fingerprint.clone(), device.last_seen_transport));

    let status = PairingStatus {
        devices: vec![device],
        pending_approval: Some(PairingApprovalRequest {
            request_id: "request".into(),
            device_id: "phone".into(),
            fingerprint: "1177\u{00B7}11ED".into(),
            transport: PairingTransport::Direct,
            requested_at: 1,
            expires_at: 1 + APPROVAL_TTL_MS,
        }),
        keep_awake: true,
        ..PairingStatus::default()
    };
    let value = serde_json::to_value(&status).unwrap();
    let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["activePairing", "devices", "host", "keepAwake", "lastError", "pendingApproval", "relay"]);
    assert_eq!(
        value["pendingApproval"],
        json!({ "requestId": "request", "deviceId": "phone", "fingerprint": "1177\u{00B7}11ED", "transport": "direct", "requestedAt": 1, "expiresAt": 120_001 })
    );
    assert_eq!(value["keepAwake"], true);
    assert_eq!(serde_json::to_value(PairingStatus::default()).unwrap()["pendingApproval"], serde_json::Value::Null);
}
