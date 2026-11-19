//! Runtime-owned phones: real relay data sockets and the shared phone RPC.
use super::*;
use crate::local_runtime::mobile::model::{
    AccountMirror, DeviceEntry, DeviceProvenance, DeviceScope,
};
use crate::phone::registry::{save_account_mirror, DeviceRegistry};
use crate::relay_e2ee::{token_hash, E2eeClientHandshake, E2eeSession, PayloadKind};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

type Socket = WebSocketStream<tokio::net::TcpStream>;
struct Rig {
    host: Arc<MachineHost>,
    phones: Arc<phones::Phones>,
    #[cfg(feature = "desktop")]
    sessions: crate::session::SessionManager,
    relay: Arc<crate::remote::host::RelayHost>,
    commands: mpsc::UnboundedReceiver<Value>,
    cell: tokio::net::TcpListener,
    lifetime: Arc<crate::local_runtime::Lifetime>,
    sink: Arc<crate::sink::BroadcastSink>,
    key: HostKeypair,
    _data: tempfile::TempDir,
    _home: crate::store::TempHome,
}

impl Rig {
    async fn new() -> Self {
        Self::with_keys(None).await
    }

    async fn with_keys(keys: Option<(key::KeyStore, u16)>) -> Self {
        let home = crate::store::temp_home();
        let data = tempfile::tempdir().unwrap();
        let sink = Arc::new(crate::sink::BroadcastSink::new(64));
        let terminals = Arc::new(crate::pty::Terminals::new());
        let sessions = crate::session::SessionManager::new(
            sink.clone(),
            Arc::new(crate::sink::NoObserver),
            Arc::new(crate::harness::host::Host::new()),
            terminals.clone(),
            Arc::default(),
            Arc::default(),
            crate::hooks::prepare_control().unwrap(),
        );
        let key = HostKeypair::from_secret([9; 32]);
        let rpc = WorkspaceRpc::machine(
            crate::remote::machine::Identity {
                machine_id: key.host_id(),
                has_window: false,
            },
            11,
            sink.clone(),
            terminals,
            None,
        )
        .unwrap();
        let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(60));
        let host = if let Some((keys, port)) = keys {
            MachineHost::new(data.path().into(), keys, sink.clone(), Rpc::Ready(rpc.clone()), Some(lifetime.clone()), port, false)
        } else {
            let host = MachineHost::idle_for_test(data.path(), rpc.clone(), key.clone());
            host.state.lock().unwrap().enabled = true;
            host
        };
        let phones = phones::Phones::new(sessions.clone(), sink.clone(), lifetime.clone(), || {}).unwrap();
        host.phones.set(phones.clone()).ok().unwrap();
        let cell = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (relay, commands) = crate::remote::host::RelayHost::phone_test_registration(
            rpc,
            format!("http://{}", cell.local_addr().unwrap()),
            [9; 32],
        );
        relay.set_routes(host.clone());
        host.use_relay(&relay);
        Self {
            host,
            phones,
            #[cfg(feature = "desktop")]
            sessions,
            relay,
            commands,
            cell,
            lifetime,
            sink,
            key,
            _data: data,
            _home: home,
        }
    }

    fn pair(&self, id: &str, token: &str, automatic: bool, approved: bool) {
        DeviceRegistry
            .add(DeviceEntry {
                id: id.into(),
                label: "Phone".into(),
                platform: "ios".into(),
                token: token_hash(token),
                scope: DeviceScope::Driver,
                provenance: if automatic {
                    DeviceProvenance::Automatic
                } else {
                    DeviceProvenance::Explicit
                },
                bound_user_id: automatic.then(|| "owner".into()),
                binding_generation: if automatic { 5 } else { 0 },
                public_key: String::new(),
                created_at: chrono::Utc::now().to_rfc3339(),
                last_seen_at: approved.then(|| chrono::Utc::now().to_rfc3339()),
                revoked_at: None,
                installation_id: automatic.then(|| "installation".into()),
                created_request_id: automatic.then(|| "grant".into()),
                fingerprint: None,
                approved_at: None,
                connection: None,
                last_seen_transport: None,
            })
            .unwrap();
    }

    fn open(&self, id: &str, kind: &str) {
        self.relay.phone_test_forward(wire::RelayConnection {
            conn_id: uuid::Uuid::new_v4().simple().to_string(),
            conn_ticket: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4; 32]),
            kind: kind.into(),
            relay_device_id: id.into(),
            attach_deadline_ms: 5000,
        });
    }

    async fn socket(&self) -> Socket {
        let (stream, _) = tokio::time::timeout(Duration::from_secs(5), self.cell.accept())
            .await
            .unwrap()
            .unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let auth: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(auth["type"], "host-data-auth");
        assert_eq!(
            auth["generation"], 37,
            "relay generation is separate from account generation 5 and runtime generation 11"
        );
        socket
    }

    async fn connect(&self, id: &str, token: &str, kind: &str, secret: [u8; 32]) -> Phone {
        self.open(id, kind);
        let socket = self.socket().await;
        let handshake = E2eeClientHandshake::with_secret(
            secret,
            &self.key.public_key_b64(),
            "relay",
            Some(&self.key.host_id()),
        )
        .unwrap();
        Phone::authenticate(socket, handshake, token).await
    }

    async fn command(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(5), self.commands.recv())
            .await
            .unwrap()
            .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn detached_runtime_applies_account_revocations_to_direct_phones() {
    use crate::machine_account::{self, tests::{service_with_hook, session_body}, Api};

    let rig = Rig::new().await;
    let host_id = rig.key.host_id();
    let account = AccountMirror {
        user_id: "owner".into(), email: "owner@example.com".into(),
        display_name: "Owner".into(), host_display_name: None, binding_generation: 5,
    };
    save_account_mirror(&account).unwrap();
    rig.phones.tick(now_ms());
    rig.pair("phone", "token", true, true);
    let mut session = session_body();
    session["cloud"]["userId"] = json!("owner");
    machine_account::save(&rig.host.data_dir, &serde_json::from_value(session).unwrap()).unwrap();
    // Computer operation keeps the account copy after the last phone goes.
    let mut settings = crate::store::settings::load();
    settings.machines.allow_operating = true;
    crate::store::settings::save(&settings).unwrap();
    // The poll and direct listener must work without either desktop or Relay.
    assert!(!rig.host.window_available());
    rig.relay.stop();
    {
        let mut state = rig.host.state.lock().unwrap();
        state.enabled = false;
        state.desktop_phones = true;
    }
    let rpc = match &*rig.host.rpc.lock().unwrap() {
        Rpc::Ready(rpc) => rpc.clone(),
        _ => unreachable!(),
    };
    let listener = direct::listen(rig.host.clone(), rpc, 0).unwrap();
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], listener.address.port()));
    rig.host.state.lock().unwrap().listening = Some(listener);
    let connect = || async {
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let (socket, _) = tokio_tungstenite::client_async(format!("ws://{address}/"), stream).await.unwrap();
        let handshake = E2eeClientHandshake::with_secret([7; 32], &rig.key.public_key_b64(), "direct", None).unwrap();
        Phone::authenticate(socket, handshake, "token").await
    };

    let revoked = json!({"revocations": [{
            "revocationId": "revoke-1", "userId": "owner", "hostId": host_id,
            "clientInstallationId": "installation", "grantRequestId": "grant",
            "bindingGeneration": 5,
    }]});
    let (retried, retry) = tokio::sync::oneshot::channel();
    let (later_acked, later_ack) = tokio::sync::oneshot::channel();
    let mut retried = Some(retried);
    let mut later_acked = Some(later_acked);
    let mut acknowledgements = 0;
    let mut later = revoked.clone();
    later["revocations"][0]["revocationId"] = json!("revoke-2");
    let (base, seen, handle) = service_with_hook(vec![
        (200, json!({"revocations": []})),
        (200, revoked.clone()),
        (500, json!({})),
        (200, revoked),
        (200, json!({})),
        (200, later),
        (200, json!({})),
    ], move |path| {
        if path.ends_with("/acknowledge") {
            acknowledgements += 1;
            if acknowledgements == 2 { retried.take().unwrap().send(()).unwrap(); }
            if acknowledgements == 3 { later_acked.take().unwrap().send(()).unwrap(); }
        }
    });
    let authority = rig.phones.watch_account_revocations();
    assert!(connect().await.read().await.is_none(), "admission requires an account check");
    let poller = tokio::spawn(phone_revocations::watch(Arc::downgrade(&rig.host), authority.clone(), Arc::new(Api::new(&base))));
    let entry = DeviceRegistry.find_by_token("token", Some(5)).unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while authority.check(&entry).is_err() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let mut phone = connect().await;
    phone.authenticated().await;
    assert_eq!(phone.call("sessions.summaries", json!({})).await["ok"], true);
    authority.hint();
    assert!(phone.read().await.is_none(), "revocation closes the active phone");
    assert!(DeviceRegistry.find_by_token("token", Some(5)).unwrap().is_none());
    assert!(connect().await.read().await.is_none(), "the saved token cannot reconnect");
    authority.hint();
    tokio::time::timeout(Duration::from_secs(5), retry).await.expect("retry after the last phone was revoked").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !authority.retired_binding_is_settled() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    authority.hint();
    tokio::time::timeout(Duration::from_secs(5), later_ack).await.expect("a hint rechecks a settled binding").unwrap();
    poller.abort();
    handle.join().unwrap();
    let seen = seen.lock().unwrap();
    let root = format!("/v1/desktop/host-account-bindings/{host_id}/revocations");
    assert_eq!(seen[0], (format!("{root}?bindingGeneration=5"), Value::Null, Some("Bearer access-1".into())));
    assert_eq!(seen[1], seen[0]);
    assert_eq!(seen[2], (format!("{root}/revoke-1/acknowledge"), json!({"bindingGeneration": 5}), Some("Bearer access-1".into())));
    assert_eq!(seen[3], seen[0]);
    assert_eq!(seen[4], seen[2]);
    assert_eq!(seen[5], seen[0]);
    assert_eq!(seen[6].0, format!("{root}/revoke-2/acknowledge"));
    assert!(machine_account::load(&rig.host.data_dir).unwrap().is_some(), "computer operation still needs the account copy");
}

/// Revoke the only account-paired phone through a detached poll, with an
/// approved explicit phone paired too when `other_phone`. Whether the
/// runtime's account copy is still there once the binding settled.
async fn account_copy_after_last_revocation(other_phone: bool) -> bool {
    use crate::machine_account::{self, tests::{service_with_hook, session_body}, Api};

    let rig = Rig::new().await;
    let host_id = rig.key.host_id();
    save_account_mirror(&AccountMirror {
        user_id: "owner".into(), email: "owner@example.com".into(),
        display_name: "Owner".into(), host_display_name: None, binding_generation: 5,
    }).unwrap();
    rig.phones.tick(now_ms());
    rig.pair("phone", "token", true, true);
    if other_phone {
        rig.pair("other", "other-token", false, true);
    }
    let mut session = session_body();
    session["cloud"]["userId"] = json!("owner");
    machine_account::save(&rig.host.data_dir, &serde_json::from_value(session).unwrap()).unwrap();
    assert!(!rig.host.window_available() && rig.host.phone_route().is_none());
    assert!(!crate::store::settings::load().machines.allow_operating);

    let (acked, ack) = tokio::sync::oneshot::channel();
    let mut acked = Some(acked);
    let (base, seen, handle) = service_with_hook(vec![
        (200, json!({"revocations": [{
            "revocationId": "revoke-1", "userId": "owner", "hostId": host_id,
            "clientInstallationId": "installation", "grantRequestId": "grant",
            "bindingGeneration": 5,
        }]})),
        (200, json!({})),
    ], move |path| {
        if path.ends_with("/acknowledge") {
            acked.take().unwrap().send(()).unwrap();
        }
    });
    let authority = rig.phones.watch_account_revocations();
    let poller = tokio::spawn(phone_revocations::watch(Arc::downgrade(&rig.host), authority.clone(), Arc::new(Api::new(&base))));
    tokio::time::timeout(Duration::from_secs(5), ack).await.expect("the revocation is acknowledged").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !authority.retired_binding_is_settled() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("the retired binding settles after one round");
    let saved = machine_account::load(&rig.host.data_dir).unwrap();
    poller.abort();
    handle.join().unwrap();
    assert_eq!(seen.lock().unwrap().len(), 2, "one fetch and one acknowledgement");
    assert!(DeviceRegistry.find_by_token("token", Some(5)).unwrap().is_none(), "the account phone is revoked");
    if let Some(saved) = &saved {
        assert_eq!((saved.access_token.as_str(), saved.refresh_token.as_str()), ("access-1", "refresh-1"), "a kept copy is unchanged");
    }
    saved.is_some()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn detached_last_phone_revocation_removes_the_runtime_account_tokens() {
    assert!(!account_copy_after_last_revocation(false).await, "no phone or computer operation needs the access and refresh tokens");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn detached_revocation_keeps_the_account_tokens_another_phone_needs() {
    assert!(account_copy_after_last_revocation(true).await, "an approved phone still needs the account copy");
}

#[cfg(feature = "desktop")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn detached_poll_fences_a_phone_admitted_by_the_window_before_acknowledging() {
    use crate::keychain::{testing::MemorySecrets, SecretStore};
    use crate::local_runtime::{client::{AttachmentIdentity, Build}, mobile::{self, Actor}};
    use crate::machine_account::{self, tests::{service_with_hook, session_body}, Api};
    use crate::phone::Owner;

    // Use the real session owner's mobile registry for the window lease.
    struct CheckBarrier {
        first_connection: String,
        entered: tokio::sync::oneshot::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    }
    struct WindowOwner {
        sessions: crate::session::SessionManager,
        lifetime: Arc<crate::local_runtime::Lifetime>,
        identity: AttachmentIdentity,
        build: Build,
        connection: Mutex<Option<(Actor, String)>>,
        before_output: Mutex<Option<CheckBarrier>>,
    }
    impl Owner for WindowOwner {
        fn attachment(&self) -> Result<AttachmentIdentity> { Ok(self.identity.clone()) }
        fn build(&self) -> &Build { &self.build }
        fn disconnect(&self) { self.lifetime.release(&self.identity.lease); }
        fn mobile(&self, actor: &Actor, method: &str, mut params: Value) -> Result<Value> {
            params["actor"] = serde_json::to_value(actor)?;
            let result = mobile::execute(&self.sessions, &self.lifetime, method, params.clone())?;
            if method == "register" {
                *self.connection.lock().unwrap() = Some((actor.clone(), params["connection"].as_str().unwrap().into()));
            }
            if method == "check" {
                let latest = self.connection.lock().unwrap().as_ref().is_some_and(|(_, id)| params["connection"] == *id);
                let barrier = {
                    let mut barrier = self.before_output.lock().unwrap();
                    if latest && barrier.as_ref().is_some_and(|barrier| params["connection"] != barrier.first_connection) {
                        barrier.take()
                    } else {
                        None
                    }
                };
                if let Some(barrier) = barrier {
                    barrier.entered.send(()).unwrap();
                    barrier.release.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            }
            Ok(result)
        }
    }

    let rig = Rig::new().await;
    let host_id = rig.key.host_id();
    save_account_mirror(&AccountMirror {
        user_id: "owner".into(), email: "owner@example.com".into(), display_name: "Owner".into(),
        host_display_name: None, binding_generation: 5,
    }).unwrap();
    rig.pair("phone", "token", true, true);
    rig.pair("unrelated", "other-token", false, true);
    let mut session = session_body();
    session["cloud"]["userId"] = json!("owner");
    machine_account::save(&rig.host.data_dir, &serde_json::from_value(session).unwrap()).unwrap();
    let entry = serde_json::from_value(json!({
        "id": "takeover", "projectPath": "/repo", "cwd": "/repo", "title": "Review",
        "created": "2026-01-01", "modified": "2026-01-01",
        "tabs": [{"id": "tab", "harness": "claude", "permissionMode": "manual", "created": "2026-01-01"}],
    })).unwrap();
    crate::store::index::save(&[entry]).unwrap();

    let rpc = match &*rig.host.rpc.lock().unwrap() {
        Rpc::Ready(rpc) => rpc.clone(),
        _ => unreachable!(),
    };
    let listener = direct::listen(rig.host.clone(), rpc, 0).unwrap();
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], listener.address.port()));
    rig.host.state.lock().unwrap().listening = Some(listener);
    let key = &rig.key;
    let connect = |token: &'static str| async move {
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let (socket, _) = tokio_tungstenite::client_async(format!("ws://{address}/"), stream).await.unwrap();
        let handshake = E2eeClientHandshake::with_secret([7; 32], &key.public_key_b64(), "direct", None).unwrap();
        Phone::authenticate(socket, handshake, token).await
    };

    let (poll_started, polling) = tokio::sync::oneshot::channel();
    let (reply_to_poll, poll_reply) = std::sync::mpsc::channel();
    let (ack_started, acknowledging) = tokio::sync::oneshot::channel();
    let (reply_to_ack, ack_reply) = std::sync::mpsc::channel();
    let (fence_check, check_at_ack) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
    let (mut poll_started, mut ack_started) = (Some(poll_started), Some(ack_started));
    let (base, seen, service) = service_with_hook(vec![
        (200, json!({"revocations": [{
            "revocationId": "revoke-1", "userId": "owner", "hostId": host_id,
            "clientInstallationId": "installation", "grantRequestId": "grant",
            "bindingGeneration": 5,
        }]})),
        (200, json!({})),
    ], move |path| {
        if path.ends_with("/acknowledge") {
            check_at_ack.recv_timeout(Duration::from_secs(5)).unwrap()();
            ack_started.take().unwrap().send(()).unwrap();
            ack_reply.recv_timeout(Duration::from_secs(5)).unwrap();
        } else {
            poll_started.take().unwrap().send(()).unwrap();
            poll_reply.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    });
    let authority = rig.phones.watch_account_revocations();
    let poller = tokio::spawn(phone_revocations::watch(Arc::downgrade(&rig.host), authority, Arc::new(Api::new(&base))));
    tokio::time::timeout(Duration::from_secs(5), polling).await.unwrap().unwrap();

    let owner = Arc::new(WindowOwner {
        sessions: rig.sessions.clone(),
        lifetime: rig.lifetime.clone(),
        identity: AttachmentIdentity { epoch: rig.lifetime.epoch().into(), lease: rig.lifetime.hold().unwrap() },
        build: Build { version: None, mobile: Default::default(), handover: None },
        connection: Mutex::new(None),
        before_output: Mutex::new(None),
    });
    let route_path = rig._data.path().join("takeover.sock");
    let route = tokio::net::UnixListener::bind(&route_path).unwrap();
    rig.host.register_phone_route(PhoneRoute {
        attachment: rig.lifetime.attachment(&owner.identity.epoch, &owner.identity.lease).unwrap(),
        lease: owner.identity.lease.clone(), socket: route_path,
        device_scoped: true,
    }).unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    secrets.set("test.revocation-takeover.pairing", "host-e2ee-key", rig.key.secret()).unwrap();
    let window = crate::pairing::PairingManager::with_secrets_for_test("test.revocation-takeover", secrets);
    window.set_phone_owner_for_test(owner.clone());
    let route_task = tokio::spawn(async move {
        loop {
            let (stream, _) = route.accept().await.unwrap();
            let window = window.clone();
            tokio::spawn(async move { let _ = window.routed_phone(stream).await; });
        }
    });
    let mut healthy = connect("other-token").await;
    healthy.authenticated().await;
    let mut phone = connect("token").await;
    phone.authenticated().await;
    assert_eq!(phone.call("sessions.summaries", json!({})).await["result"]["sessions"][0]["id"], "takeover");
    let (actor, connection) = owner.connection.lock().unwrap().clone().unwrap();
    let permit = rig.sessions.mobile.permit(&actor, &connection, "takeover", "tab").unwrap();
    assert!(permit.valid());
    let approval = json!({
        "connection": connection, "sessionId": "takeover", "tabId": "tab",
        "requestId": "test-approval", "optionId": "allow",
    });
    let (checked, checking) = tokio::sync::oneshot::channel();
    let (send_output, output) = std::sync::mpsc::channel();
    *owner.before_output.lock().unwrap() = Some(CheckBarrier {
        first_connection: connection, entered: checked, release: output,
    });
    let mut checked_before_revoke = connect("token").await;
    tokio::time::timeout(Duration::from_secs(5), checking).await.unwrap().unwrap();
    fence_check.send(Box::new(move || {
        assert!(DeviceRegistry.find_by_token("token", Some(5)).unwrap().is_none());
        assert!(!permit.valid(), "work queued by the window grant must lose its permit");
        for method in ["check", "permission"] {
            let error = owner.mobile(&actor, method, approval.clone()).unwrap_err();
            assert!(error.to_string().contains("revoked"), "{method}: {error:#}");
        }
    })).ok().unwrap();
    reply_to_poll.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), acknowledging).await.unwrap().unwrap();

    send_output.send(()).unwrap();
    assert!(checked_before_revoke.read().await.is_none(), "a pre-revocation grant check cannot authenticate afterward");
    assert!(phone.read().await.is_none(), "an idle revoked phone closes without sending another request");
    assert!(connect("token").await.read().await.is_none(), "a revoked credential cannot reconnect");
    for _ in 0..2 {
        assert!(!rig.phones.revoke("phone").unwrap(), "retry a persisted revocation");
        assert_eq!(healthy.call("sessions.summaries", json!({})).await["ok"], true);
    }
    reply_to_ack.send(()).unwrap();
    service.join().unwrap();
    assert_eq!(seen.lock().unwrap()[1].0, format!("/v1/desktop/host-account-bindings/{host_id}/revocations/revoke-1/acknowledge"));
    poller.abort();
    route_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refusing_a_relay_invite_still_creates_a_nearby_phone_code() {
    let rig = Rig::new().await;
    let mut control = rig.relay.phone_test_hold_control();
    let phones = rig.phones.clone();
    let key = rig.key.clone();
    let epoch = *phones.stopped().borrow();
    let creating = tokio::task::spawn_blocking(move || phones.create_code(&key, Some(6768), epoch));
    let (invite, reply) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(pending) = control.take() { break pending; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    assert_eq!(invite["type"], "invite-create");
    reply.send(Ok(json!({"type":"control-error", "reqId":invite["reqId"]}))).unwrap();
    let offer = decode_offer(&creating.await.unwrap().unwrap().link);
    assert!(offer.relay.is_none());
    assert!(offer.direct_endpoints.iter().any(|endpoint| endpoint.ends_with(":6768")));
    assert_ne!(offer.paired_device_id, invite["relayDeviceId"].as_str().unwrap());
    let (cleanup, _) = control.take().expect("retire the possibly issued invite");
    assert_eq!(cleanup["relayDeviceId"], invite["relayDeviceId"]);
    assert!(DeviceRegistry.find_by_token(&offer.device_token, None).unwrap().is_some());
}
impl Drop for Rig {
    fn drop(&mut self) {
        self.host.stop_serving();
        self.relay.stop();
    }
}
struct Phone {
    socket: Socket,
    session: E2eeSession,
}
impl Phone {
    async fn authenticate(mut socket: Socket, handshake: E2eeClientHandshake, token: &str) -> Self {
        socket
            .send(Message::Text(
                serde_json::to_string(handshake.hello()).unwrap().into(),
            ))
            .await
            .unwrap();
        let ready = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let mut session = handshake.accept_ready(&ready).unwrap();
        let auth = json!({"type":"e2ee_auth", "v":2, "transcriptHashB64":session.transcript_hash_b64, "deviceToken":token});
        socket
            .send(Message::Text(
                STANDARD
                    .encode(
                        session
                            .seal(auth.to_string().as_bytes(), PayloadKind::Text)
                            .unwrap(),
                    )
                    .into(),
            ))
            .await
            .unwrap();
        Self { socket, session }
    }
    async fn read(&mut self) -> Option<Value> {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(5), self.socket.next())
                .await
                .expect("phone response");
            match frame {
                Some(Ok(Message::Text(text))) => {
                    return Some(
                        serde_json::from_slice(
                            &self
                                .session
                                .open(
                                    &STANDARD.decode(text.as_bytes()).unwrap(),
                                    PayloadKind::Text,
                                )
                                .unwrap(),
                        )
                        .unwrap(),
                    )
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                _ => return None,
            }
        }
    }
    async fn authenticated(&mut self) {
        assert_eq!(self.read().await.unwrap()["type"], "e2ee_authenticated");
    }
    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.send(method, params).await;
        loop {
            let reply = self.read().await.unwrap();
            if reply["id"] == "req" {
                return reply;
            }
        }
    }
    async fn send(&mut self, method: &str, params: Value) {
        let request = json!({"id":"req", "method":method, "params":params});
        self.socket
            .send(Message::Text(
                STANDARD
                    .encode(
                        self.session
                            .seal(request.to_string().as_bytes(), PayloadKind::Text)
                            .unwrap(),
                    )
                    .into(),
            ))
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn headless_phone_relay_authenticates_provisions_and_reconnects() {
    let mut rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    let mut phone = rig.connect("phone", "token", "invite", [7; 32]).await;
    phone.authenticated().await;
    let hash = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([5; 32]);
    let reply = phone
        .call(
            "pairing.provisionRelay",
            json!({"reqId":"install", "newResumeTokenHash":hash}),
        )
        .await;
    assert_eq!(reply["result"]["currentVersion"], 1, "{reply}");
    rig.sink.emit_raw(
        "session_updated",
        serde_json::value::RawValue::from_string("{}".into()).unwrap(),
    );
    assert_eq!(phone.read().await.unwrap()["method"], "sessions.changed");
    let install = rig.command().await;
    assert_eq!(install["relayDeviceId"], "phone");
    assert_eq!(install["authorization"]["mode"], "relay-basis");
    drop(phone);
    let mut resumed = rig.connect("phone", "token", "resume", [7; 32]).await;
    resumed.authenticated().await;
    let reply = resumed
        .call(
            "pairing.getEndpoints",
            json!({"resumeConfirmReqId":"confirm", "installReqId":"status"}),
        )
        .await;
    assert_eq!(reply["result"]["relay"]["relayHostId"], rig.key.host_id());
    assert_eq!(
        rig.command().await["type"],
        "device-credential-install-status"
    );
    assert_eq!(rig.command().await["type"], "device-resume-confirm");
    let denied = resumed
        .call(
            "pairing.provisionRelay",
            json!({"reqId":"again", "newResumeTokenHash":hash}),
        )
        .await;
    assert!(denied.get("error").is_some());
    rig.phones.revoke("phone").unwrap();
    assert_eq!(rig.command().await["type"], "device-revoke");
    assert!(resumed.read().await.is_none());
    let mut revoked = rig.connect("phone", "token", "resume", [7; 32]).await;
    assert!(revoked.read().await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_registration_alone_never_admits_a_phone_or_another_identity() {
    let rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    for (id, token, key) in [
        ("phone", "wrong", [7; 32]),
        ("other", "token", [7; 32]),
        ("missing", "missing", [7; 32]),
    ] {
        let mut phone = rig.connect(id, token, "resume", key).await;
        assert!(phone.read().await.is_none());
    }
    let mut valid = rig.connect("phone", "token", "resume", [7; 32]).await;
    valid.authenticated().await;
    let mut impostor = rig.connect("phone", "token", "resume", [8; 32]).await;
    assert!(
        impostor.read().await.is_none(),
        "the pinned phone key is required"
    );
    rig.pair("unapproved", "new", false, false);
    let mut pending = rig.connect("unapproved", "new", "invite", [7; 32]).await;
    assert_eq!(pending.read().await.unwrap()["type"], "pairing_refused");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn account_generation_changes_fence_automatic_relay_phones() {
    account_change_fences_automatic_relay_phones("owner", 6).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_generation_account_switch_fences_automatic_relay_phones() {
    account_change_fences_automatic_relay_phones("another", 5).await;
}

async fn account_change_fences_automatic_relay_phones(next_user: &str, next_generation: u64) {
    let mut rig = Rig::new().await;
    let mut mirror = AccountMirror {
        user_id: "owner".into(),
        email: "a@b".into(),
        display_name: "Owner".into(),
        host_display_name: None,
        binding_generation: 5,
    };
    save_account_mirror(&mirror).unwrap();
    rig.phones.tick(now_ms());
    rig.pair("phone", "token", true, true);
    rig.open("phone", "resume");
    let mut pre_auth = rig.socket().await;
    let mut phone = rig.connect("phone", "token", "resume", [7; 32]).await;
    phone.authenticated().await;
    assert_eq!(phone.call("host.describe", json!({})).await["ok"], true);
    // A profile update is not a new account binding.
    let stopped = rig.phones.stopped();
    let epoch = *stopped.borrow();
    mirror.display_name = "Updated name".into();
    save_account_mirror(&mirror).unwrap();
    rig.phones.tick(now_ms());
    assert_eq!(*stopped.borrow(), epoch);
    assert_eq!(phone.call("host.describe", json!({})).await["ok"], true);
    mirror.binding_generation = next_generation;
    mirror.user_id = next_user.into();
    save_account_mirror(&mirror).unwrap();
    rig.phones.tick(now_ms());
    assert_ne!(*stopped.borrow(), epoch, "a changed user or generation must fence in-flight admission");
    assert!(phone.read().await.is_none());
    assert!(tokio::time::timeout(Duration::from_secs(5), pre_auth.next()).await.unwrap()
        .is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_)))));
    let revoked = rig.command().await;
    assert_eq!(revoked["type"], "device-revoke");
    assert_eq!(revoked["relayDeviceId"], "phone");
    let mut stale = rig.connect("phone", "token", "resume", [7; 32]).await;
    assert!(stale.read().await.is_none());
    // QR pairings survive account changes and sign-out; automatic credentials
    // remain tied to their original user and generation.
    rig.pair("explicit", "qr", false, true);
    let mut explicit = rig.connect("explicit", "qr", "resume", [8; 32]).await;
    explicit.authenticated().await;
    std::fs::remove_file(crate::store::root().unwrap().join("account.json")).unwrap();
    rig.phones.tick(now_ms());
    let mut signed_out = rig.connect("phone", "token", "resume", [7; 32]).await;
    assert!(signed_out.read().await.is_none());
    let mut explicit = rig.connect("explicit", "qr", "resume", [8; 32]).await;
    explicit.authenticated().await;
    assert_eq!(explicit.call("host.describe", json!({})).await["ok"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admission_rechecks_account_when_tick_ran_before_the_phone_was_tracked() {
    let rig = Rig::new().await;
    let mirror = AccountMirror {
        user_id: "owner".into(), email: "a@b".into(), display_name: "Owner".into(),
        host_display_name: None, binding_generation: 5,
    };
    save_account_mirror(&mirror).unwrap();
    rig.phones.tick(now_ms());
    rig.pair("phone", "token", true, true);
    DeviceRegistry.touch("phone", "phone-key", "fingerprint", crate::local_runtime::mobile::model::PairingTransport::Relay).unwrap();
    // This is the snapshot held after token authentication and key pinning.
    let authenticated = DeviceRegistry.find_by_token("token", Some(5)).unwrap().unwrap();
    let stopped = rig.phones.stopped();
    for changed in [
        Some(AccountMirror { binding_generation: 6, ..mirror.clone() }),
        Some(AccountMirror { user_id: "another".into(), ..mirror.clone() }),
        None,
    ] {
        // Each case starts with a valid binding and a fresh admission epoch.
        save_account_mirror(&mirror).unwrap();
        rig.phones.tick(now_ms());
        let epoch = *stopped.borrow();
        match changed {
            Some(changed) => save_account_mirror(&changed).unwrap(),
            None => std::fs::remove_file(crate::store::root().unwrap().join("account.json")).unwrap(),
        }
        // The tick cannot cancel a phone that has not yet been tracked. An
        // admission using its earlier snapshot must reject it without another tick.
        rig.phones.tick(now_ms());
        assert!(rig.phones.status().connected.is_empty());
        assert!(rig.phones.admit(&authenticated, "phone-key", epoch).is_err());
        assert!(rig.phones.status().connected.is_empty(), "failed admission must untrack itself");
        // Also try the current epoch: this must fail on the fresh account
        // read, not merely because the tick invalidated the earlier epoch.
        let current_epoch = *stopped.borrow();
        let error = rig.phones.admit(&authenticated, "phone-key", current_epoch).err().expect("stale credential admitted");
        assert!(error.to_string().contains("account changed during admission"), "{error:#}");
        assert!(rig.phones.status().connected.is_empty(), "account rejection must remove the tracked connection");
    }
    std::fs::write(crate::store::root().unwrap().join("account.json"), "invalid").unwrap();
    rig.phones.tick(now_ms());
    let current_epoch = *stopped.borrow();
    assert!(rig.phones.admit(&authenticated, "phone-key", current_epoch).is_err());
    assert!(rig.phones.status().connected.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admission_rechecks_a_revocation_that_preceded_tracking() {
    let rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    DeviceRegistry.touch("phone", "phone-key", "fingerprint", crate::local_runtime::mobile::model::PairingTransport::Relay).unwrap();
    let authenticated = DeviceRegistry.find_by_token("token", None).unwrap().unwrap();
    let stopped = rig.phones.stopped();
    let epoch = *stopped.borrow();
    rig.phones.revoke("phone").unwrap();
    assert!(rig.phones.admit(&authenticated, "phone-key", epoch).is_err());
    assert!(rig.phones.status().connected.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_phone_forgets_itself_after_acknowledging_and_cannot_reconnect() {
    let mut rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    let mut phone = rig.connect("phone", "token", "resume", [7; 32]).await;
    phone.authenticated().await;
    let reply = phone.call("pairing.forget", json!({})).await;
    assert_eq!(reply["result"]["forgotten"], true);
    assert!(phone.read().await.is_none());
    assert_eq!(rig.command().await["type"], "device-revoke");
    let mut stale = rig.connect("phone", "token", "resume", [7; 32]).await;
    assert!(stale.read().await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn window_takeover_fences_pre_auth_and_routes_until_its_lease_ends() {
    let rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    rig.open("phone", "resume");
    let mut pre_auth = rig.socket().await;
    let mut active = rig.connect("phone", "token", "resume", [7; 32]).await;
    active.authenticated().await;
    assert_eq!(active.call("host.describe", json!({})).await["ok"], true);
    let path = rig._data.path().join("window.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let lease = rig.lifetime.hold().unwrap();
    rig.host
        .register_phone_route(PhoneRoute {
            attachment: rig
                .lifetime
                .attachment(rig.lifetime.epoch(), &lease)
                .unwrap(),
            lease: lease.clone(),
            socket: path,
            device_scoped: false,
        })
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), pre_auth.next())
            .await
            .unwrap()
            .is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_))))
    );
    assert!(active.read().await.is_none());
    rig.open("phone", "resume");
    let (mut window, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut bytes = Vec::new();
    use tokio::io::AsyncReadExt;
    loop {
        let byte = window.read_u8().await.unwrap();
        bytes.push(byte);
        if byte == b'\n' { break; }
    }
    assert!(String::from_utf8(bytes).unwrap().contains("relayDeviceId"));
    rig.lifetime.release(&lease);
    let mut runtime = rig.connect("phone", "token", "resume", [7; 32]).await;
    runtime.authenticated().await;
    rig.host.stop_serving();
    assert!(runtime.read().await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retiring_the_relay_cancels_idle_and_pre_auth_phone_connections() {
    let rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    let mut phone = rig.connect("phone", "token", "resume", [7; 32]).await;
    phone.authenticated().await;
    rig.open("phone", "resume");
    let mut pre_auth = rig.socket().await;
    assert_eq!(phone.call("host.describe", json!({})).await["ok"], true);
    rig.relay.phone_test_retire();
    assert!(phone.read().await.is_none());
    assert!(
        tokio::time::timeout(Duration::from_secs(5), pre_auth.next())
            .await
            .unwrap()
            .is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_))))
    );
}

#[cfg(feature = "desktop")]
struct WindowPhoneOwner {
    build: crate::local_runtime::client::Build,
}

#[cfg(feature = "desktop")]
impl crate::phone::Owner for WindowPhoneOwner {
    fn attachment(&self) -> Result<crate::local_runtime::client::AttachmentIdentity> {
        Ok(crate::local_runtime::client::AttachmentIdentity { epoch: "test-epoch".into(), lease: "test-lease".into() })
    }
    fn mobile(&self, _: &crate::local_runtime::mobile::Actor, _: &str, _: Value) -> Result<Value> { Ok(json!({})) }
    fn build(&self) -> &crate::local_runtime::client::Build { &self.build }
    fn disconnect(&self) {}
}

#[cfg(feature = "desktop")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn window_paired_phone_reconnects_after_detach_with_computer_operation_off() {
    use crate::keychain::{testing::MemorySecrets, SecretStore};
    use crate::local_runtime::mobile::model::{PairingConnectionMode, PairingOffer};
    use std::os::unix::fs::PermissionsExt;

    async fn direct_phone(port: u16, offer: &PairingOffer) -> Phone {
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (socket, _) = tokio_tungstenite::client_async(format!("ws://127.0.0.1:{port}/"), tcp).await.unwrap();
        let handshake = E2eeClientHandshake::with_secret([7; 32], &offer.public_key_b64, "direct", None).unwrap();
        Phone::authenticate(socket, handshake, &offer.device_token).await
    }

    let secrets = Arc::new(MemorySecrets::default());
    let keys = key::KeyStore::at(key::Location::Keychain { service: "test.handoff.machine-host".into() }, secrets.clone());
    let window_port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let rig = Rig::with_keys(Some((keys, window_port))).await;
    secrets.set("test.handoff.pairing", "host-e2ee-key", rig.key.secret()).unwrap();
    let mut window = crate::pairing::PairingManager::with_secrets_for_test("test.handoff", secrets.clone());
    window.set_phone_port_for_test(window_port);
    window.set_phone_owner_for_test(Arc::new(WindowPhoneOwner { build: crate::local_runtime::client::Build {
        version: None, mobile: Default::default(), handover: None,
    }}));
    let lease = rig.lifetime.hold().unwrap();
    let epoch = rig.lifetime.epoch();
    assert_eq!(rig.host.status().host_key, HostKeyState::Needed);
    let created = window.generate_pairing(PairingConnectionMode::LocalOnly).await.unwrap();
    let offer = decode_offer(&created.active_pairing.unwrap().pairing_url);
    let mut phone = direct_phone(window_port, &offer).await;
    let pending = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(pending) = window.status().pending_approval { break pending; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    window.approve_pairing(&pending.request_id).unwrap();
    phone.authenticated().await;
    assert!(crate::phone::registry::has_paired_phone().unwrap());

    rig.host.execute(wire::ADOPT_KEY, json!({
        "epoch": epoch, "lease": lease,
        "secretB64": STANDARD.encode(secrets.stored("test.handoff.pairing", "host-e2ee-key").unwrap()),
    })).unwrap();
    assert_eq!(secrets.stored("test.handoff.machine-host", "host-e2ee-key").unwrap(), rig.key.secret());
    window.stop();
    rig.lifetime.release(&lease);
    assert!(phone.read().await.is_none());
    let status = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            rig.host.clone().reconcile(false).await;
            let status = rig.host.status();
            if status.listening.is_some() { break status; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    assert!(rig.host.keeps_runtime());
    assert!(!status.enabled, "the computer-operation switch stays off");
    assert!(status.phones.hosting);
    assert_eq!(status.listening.unwrap().parse::<std::net::SocketAddr>().unwrap().port(), window_port);

    let window = crate::pairing::PairingManager::with_secrets_for_test("test.handoff", secrets);
    window.set_phone_owner_for_test(Arc::new(WindowPhoneOwner { build: crate::local_runtime::client::Build {
        version: None, mobile: Default::default(), handover: None,
    }}));
    let lease = rig.lifetime.hold().unwrap();
    let run = rig._data.path().join("run");
    std::fs::create_dir(&run).unwrap();
    let path = run.join("w");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    rig.host.execute(wire::PHONE_ROUTE, json!({"epoch": epoch, "lease": lease, "socket": path})).unwrap();
    let route = tokio::spawn({
        let window = window.clone();
        async move {
            let (stream, _) = listener.accept().await.unwrap();
            window.routed_phone(stream).await.unwrap();
        }
    });
    let mut forwarded = direct_phone(window_port, &offer).await;
    forwarded.authenticated().await;
    assert!(rig.phones.status().connected.is_empty(), "the window served this connection");
    window.stop();
    rig.lifetime.release(&lease);
    assert!(forwarded.read().await.is_none());
    route.await.unwrap();
    rig.host.clone().reconcile(false).await;
    assert!(!rig.host.status().phone_route);

    let session: crate::store::index::SessionEntry = serde_json::from_value(json!({
        "id": "window-session", "projectPath": "/repo", "cwd": "/repo", "title": "Review",
        "created": "2026-01-01", "modified": "2026-01-01",
    })).unwrap();
    crate::store::index::save(&[session]).unwrap();
    let mut reconnected = direct_phone(window_port, &offer).await;
    reconnected.authenticated().await;
    let summaries = reconnected.call("sessions.summaries", json!({})).await;
    assert_eq!(summaries["result"]["sessions"][0]["id"], "window-session");
    assert_eq!(reconnected.call("rpc.hello", json!({})).await["ok"], false);

    let mut remote = rig.connect(&offer.paired_device_id, &offer.device_token, "resume", [7; 32]).await;
    remote.authenticated().await;
    assert_eq!(remote.call("sessions.summaries", json!({})).await["ok"], true);
}

fn decode_offer(link: &str) -> crate::local_runtime::mobile::model::PairingOffer {
    let url = url::Url::parse(link).unwrap();
    let code = url.query_pairs().find(|(key, _)| key == "code").unwrap().1;
    serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(code.as_bytes()).unwrap()).unwrap()
}

#[cfg(feature = "desktop")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forwarded_relay_retirement_cancels_only_its_own_window_legs() {
    use crate::keychain::SecretStore;
    use crate::local_runtime::client::Build;
    let mut rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    rig.pair("replacement", "replacement-token", false, true);
    let path = rig._data.path().join("window-relay.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let lease = rig.lifetime.hold().unwrap();
    rig.host.register_phone_route(PhoneRoute {
        attachment: rig.lifetime.attachment(rig.lifetime.epoch(), &lease).unwrap(),
        lease,
        socket: path,
        device_scoped: false,
    }).unwrap();
    let secrets = Arc::new(crate::keychain::testing::MemorySecrets::default());
    secrets.set("test.forwarded-relay.pairing", "host-e2ee-key", rig.key.secret()).unwrap();
    let manager = crate::pairing::PairingManager::with_secrets_for_test("test.forwarded-relay", secrets);
    manager.set_phone_owner_for_test(Arc::new(WindowPhoneOwner { build: Build {
        version: None, mobile: Default::default(), handover: None,
    }}));
    let window = tokio::spawn(async move {
        loop {
            let (route, _) = listener.accept().await.unwrap();
            let manager = manager.clone();
            tokio::spawn(async move {
                let _ = manager.routed_phone(route).await;
            });
        }
    });
    let mut old = rig.connect("phone", "token", "resume", [7; 32]).await;
    old.authenticated().await;
    assert_eq!(old.call("host.describe", json!({})).await["ok"], true);
    rig.open("phone", "resume");
    let mut pending = rig.socket().await;

    let rpc = match &*rig.host.rpc.lock().unwrap() { Rpc::Ready(rpc) => rpc.clone(), _ => unreachable!() };
    let (replacement, _commands) = crate::remote::host::RelayHost::phone_test_registration(
        rpc, format!("http://{}", rig.cell.local_addr().unwrap()), [9; 32]);
    replacement.set_routes(rig.host.clone());
    rig.host.use_relay(&replacement);
    let original = std::mem::replace(&mut rig.relay, replacement);
    let mut current = rig.connect("replacement", "replacement-token", "resume", [8; 32]).await;
    current.authenticated().await;
    original.phone_test_retire();
    assert!(old.read().await.is_none());
    assert!(tokio::time::timeout(Duration::from_secs(5), pending.next()).await.unwrap()
        .is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_)))));
    assert_eq!(current.call("host.describe", json!({})).await["ok"], true);
    window.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_phone_waits_for_approval_and_keeps_its_identity_after_reconnect() {
    let mut rig = Rig::new().await;
    let created: wire::CreatedPhoneCode = serde_json::from_value(rig.host.phone_code().unwrap()).unwrap();
    let offer = decode_offer(&created.link);
    let invite = offer.relay.as_ref().expect("terminal QR carries a Relay invite");
    assert_eq!(invite.relay_host_id, rig.key.host_id());
    assert_eq!(created.expires_at, invite.invite_expires_at);
    assert!(offer.direct_endpoints.is_empty(), "the server has no direct listener");
    let minted = rig.command().await;
    assert_eq!(minted["type"], "invite-create");
    assert_eq!(minted["relayDeviceId"], offer.paired_device_id);
    let mut phone = rig
        .connect(
            &offer.paired_device_id,
            &offer.device_token,
            "invite",
            [7; 32],
        )
        .await;
    let deadline = Instant::now() + Duration::from_secs(5);
    let pending = loop {
        assert!(Instant::now() < deadline, "the phone must request approval");
        if let Some(pending) = rig.phones.status().pending {
            break pending;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert!(rig.phones.status().connected.is_empty());
    rig.phones.approve(&pending.request_id).unwrap();
    phone.authenticated().await;
    let installed = phone.call("pairing.provisionRelay", json!({
        "reqId": "pairing-install", "newResumeTokenHash": crate::relay_e2ee::random_token(),
    })).await;
    assert_eq!(installed["ok"], true, "{installed}");
    let install = rig.command().await;
    assert_eq!(install["authorization"]["mode"], "relay-basis");
    assert_eq!(install["relayDeviceId"], offer.paired_device_id);
    drop(phone);
    let mut resumed = rig
        .connect(
            &offer.paired_device_id,
            &offer.device_token,
            "resume",
            [7; 32],
        )
        .await;
    resumed.authenticated().await;
    assert_eq!(DeviceRegistry.list().unwrap()[0].id, offer.paired_device_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabling_the_machine_fences_pre_auth_and_new_relay_admission() {
    let rig = Rig::new().await;
    rig.open("phone", "resume");
    let mut pre_auth = rig.socket().await;
    rig.host.state.lock().unwrap().enabled = false;
    rig.host.stop_serving();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), pre_auth.next())
            .await
            .unwrap()
            .is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_))))
    );
    let (_, cancel) = mpsc::unbounded_channel();
    assert!(!crate::remote::host::MachineRoutes::forward_phone(
        &*rig.host,
        wire::Forwarded::Direct { peer: None },
        cancel
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authenticated_direct_phone_can_provision_the_runtime_relay() {
    let mut rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    let rpc = match &*rig.host.rpc.lock().unwrap() {
        Rpc::Ready(rpc) => rpc.clone(),
        _ => unreachable!(),
    };
    let listener = direct::listen(rig.host.clone(), rpc, 0).unwrap();
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], listener.address.port()));
    rig.host.state.lock().unwrap().listening = Some(listener);
    let stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let (mut socket, _) = tokio_tungstenite::client_async(format!("ws://{address}/"), stream)
        .await
        .unwrap();
    let handshake =
        E2eeClientHandshake::with_secret([7; 32], &rig.key.public_key_b64(), "direct", None)
            .unwrap();
    socket
        .send(Message::Text(
            serde_json::to_string(handshake.hello()).unwrap().into(),
        ))
        .await
        .unwrap();
    let ready = socket.next().await.unwrap().unwrap().into_text().unwrap();
    let mut session = handshake.accept_ready(&ready).unwrap();
    let auth = json!({"type":"e2ee_auth", "v":2, "transcriptHashB64":session.transcript_hash_b64, "deviceToken":"token"});
    socket
        .send(Message::Text(
            STANDARD
                .encode(
                    session
                        .seal(auth.to_string().as_bytes(), PayloadKind::Text)
                        .unwrap(),
                )
                .into(),
        ))
        .await
        .unwrap();
    let mut phone = Phone { socket, session };
    phone.authenticated().await;
    let reply = phone.call("pairing.provisionRelay", json!({"reqId":"install", "newResumeTokenHash":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([5;32])})).await;
    assert_eq!(reply["ok"], true, "{reply}");
    let install = rig.command().await;
    assert_eq!(install["authorization"]["mode"], "authenticated-direct");
    assert_eq!(install["relayDeviceId"], "phone");
    assert!(install["authorization"]["directAuthId"]
        .as_str()
        .is_some_and(crate::remote::host::valid_opaque_id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn signed_out_and_unreadable_accounts_do_not_admit_automatic_relay_credentials() {
    let rig = Rig::new().await;
    rig.pair("automatic", "auto", true, true);
    rig.pair("explicit", "qr", false, true);
    let mut signed_out = rig.connect("automatic", "auto", "resume", [7; 32]).await;
    assert!(signed_out.read().await.is_none());
    let mut explicit = rig.connect("explicit", "qr", "resume", [7; 32]).await;
    explicit.authenticated().await;
    std::fs::write(
        crate::store::root().unwrap().join("account.json"),
        "invalid",
    )
    .unwrap();
    let mut unknown = rig.connect("automatic", "auto", "resume", [7; 32]).await;
    assert!(unknown.read().await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stale_relay_assignments_are_rejected_before_opening_the_data_leg() {
    let rig = Rig::new().await;
    let stopped = rig.phones.stopped();
    let epoch = *stopped.borrow();
    let forwarded = wire::Forwarded::Relay {
        cell_url: format!("http://{}", rig.cell.local_addr().unwrap()),
        relay_host_id: rig.key.host_id(),
        generation: 36,
        connection: wire::RelayConnection {
            conn_id: "connection".into(),
            conn_ticket: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4; 32]),
            kind: "resume".into(),
            relay_device_id: "phone".into(),
            attach_deadline_ms: 5000,
        },
    };
    let error = rig
        .phones
        .clone()
        .serve_relay(rig.key.clone(), forwarded, Some(6768), epoch)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("stale host assignment"));
}

async fn wait_disconnected(rig: &Rig) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !rig.phones.status().connected.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("phone disconnect must release its tracking guard");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disconnected_automatic_phones_lose_relay_credentials_on_account_changes() {
    for next in [Some(("another", 5)), Some(("owner", 6)), None] {
        let mut rig = Rig::new().await;
        let mut mirror = AccountMirror {
            user_id: "owner".into(), email: "a@b".into(), display_name: "Owner".into(),
            host_display_name: None, binding_generation: 5,
        };
        save_account_mirror(&mirror).unwrap();
        rig.phones.tick(now_ms());
        rig.pair("phone", "token", true, true);
        let mut phone = rig.connect("phone", "token", "resume", [7; 32]).await;
        phone.authenticated().await;
        drop(phone);
        wait_disconnected(&rig).await;
        match next {
            Some((user, generation)) => {
                mirror.user_id = user.into();
                mirror.binding_generation = generation;
                save_account_mirror(&mirror).unwrap();
            }
            None => std::fs::remove_file(crate::store::root().unwrap().join("account.json")).unwrap(),
        }
        rig.phones.tick(now_ms());
        let revoked = rig.command().await;
        assert_eq!(revoked["type"], "device-revoke");
        assert_eq!(revoked["relayDeviceId"], "phone");
        let mut stale = rig.connect("phone", "token", "resume", [7; 32]).await;
        assert!(stale.read().await.is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn externally_removed_disconnected_phones_lose_relay_credentials() {
    for delete_record in [false, true] {
        let mut rig = Rig::new().await;
        rig.pair("phone", "token", false, true);
        let mut phone = rig.connect("phone", "token", "resume", [7; 32]).await;
        phone.authenticated().await;
        drop(phone);
        wait_disconnected(&rig).await;
        if delete_record {
            crate::store::write_json(&crate::store::root().unwrap().join("devices.json"), &json!({"devices":[]})).unwrap();
        } else {
            DeviceRegistry.revoke("phone").unwrap();
        }
        rig.phones.tick(now_ms());
        let revoked = rig.command().await;
        assert_eq!(revoked["type"], "device-revoke");
        assert_eq!(revoked["relayDeviceId"], "phone");
        let mut stale = rig.connect("phone", "token", "resume", [7; 32]).await;
        assert!(stale.read().await.is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removal_without_a_phone_socket_is_retained_until_relay_control_returns() {
    let rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    // Registry discovery is independent of whether this runtime served a socket.
    rig.phones.tick(now_ms());
    rig.relay.phone_test_retire();
    DeviceRegistry.revoke("phone").unwrap();
    rig.phones.tick(now_ms());
    let rpc = match &*rig.host.rpc.lock().unwrap() {
        Rpc::Ready(rpc) => rpc.clone(),
        _ => unreachable!(),
    };
    let (relay, mut commands) = crate::remote::host::RelayHost::phone_test_registration(
        rpc, format!("http://{}", rig.cell.local_addr().unwrap()), [9; 32],
    );
    rig.host.use_relay(&relay);
    rig.phones.tick(now_ms());
    let revoked = tokio::time::timeout(Duration::from_secs(5), commands.recv()).await.unwrap().unwrap();
    assert_eq!(revoked["type"], "device-revoke");
    assert_eq!(revoked["relayDeviceId"], "phone");
    relay.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_revocations_retry_control_loss_before_send_or_acknowledgment() {
    for sent_before_loss in [false, true] {
        let rig = Rig::new().await;
        rig.pair("phone", "token", false, true);
        rig.phones.tick(now_ms());
        let mut control = rig.relay.phone_test_hold_control();
        DeviceRegistry.revoke("phone").unwrap();
        rig.phones.tick(now_ms());
        // The first queue accepted the command. It can disappear before the
        // control loop reads it, or after send but before its reply arrives.
        let old_reply = if sent_before_loss {
            let (request, reply) = control.take().expect("initial revocation");
            assert_eq!(request["type"], "device-revoke");
            assert_eq!(request["relayDeviceId"], "phone");
            rig.phones.tick(now_ms());
            assert!(control.take().is_none(), "do not duplicate an outstanding request on a live registration");
            Some(reply)
        } else { None };
        drop(control);
        let mut replacement = rig.relay.phone_test_hold_control();
        rig.phones.tick(now_ms());
        let (retried, reply) = replacement.take().expect("unacknowledged revocation must survive control loss");
        assert_eq!(retried["type"], "device-revoke");
        assert_eq!(retried["relayDeviceId"], "phone");
        drop(old_reply);
        // An error is not an acknowledgment; keep retrying the removal.
        reply.send(Ok(json!({"type":"control-error", "reqId":retried["reqId"]}))).unwrap();
        rig.phones.tick(now_ms());
        let (retried, reply) = replacement.take().expect("a refusal must not discard the revocation");
        reply.send(Ok(json!({"type":"device-revoked", "reqId":retried["reqId"]}))).unwrap();
        rig.phones.tick(now_ms());
        rig.phones.tick(now_ms());
        assert!(replacement.take().is_none(), "only an acknowledged revocation leaves the retry set");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_revocations_survive_restart_before_send_or_acknowledgment() {
    for sent_before_restart in [false, true] {
        let rig = Rig::new().await;
        rig.pair("phone", "token", false, true);
        rig.phones.tick(now_ms());
        let mut control = rig.relay.phone_test_hold_control();
        DeviceRegistry.revoke("phone").unwrap();
        rig.phones.tick(now_ms());
        let old_reply = if sent_before_restart {
            let (_, reply) = control.take().expect("initial revocation");
            Some(reply)
        } else { None };
        // Fresh Phones loads only the journal and registry, not the old
        // pending map, response receivers, or known-device cache.
        let restarted = rig.phones.restart_for_test(rig.sink.clone());
        drop(control);
        let mut control = rig.relay.phone_test_hold_control();
        restarted.use_relay(&rig.relay);
        restarted.tick(now_ms());
        let (request, reply) = control.take().expect("restart must recover unacknowledged revocation");
        assert_eq!(request["type"], "device-revoke");
        assert_eq!(request["relayDeviceId"], "phone");
        drop(old_reply);
        let journal = crate::store::root().unwrap().join("phone-relay-cleanup.json");
        let saved: Value = crate::store::read_json(&journal).unwrap().unwrap();
        assert_eq!(saved["pending"], json!(["phone"]), "queue acceptance must not clear durable intent");
        reply.send(Ok(json!({"type":"device-revoked", "reqId":request["reqId"]}))).unwrap();
        restarted.tick(now_ms());
        let saved: Value = crate::store::read_json(&journal).unwrap().unwrap();
        assert_eq!(saved["pending"], json!([]));
        let acknowledged = restarted.restart_for_test(rig.sink.clone());
        acknowledged.use_relay(&rig.relay);
        acknowledged.tick(now_ms());
        assert!(control.take().is_none(), "acknowledged cleanup must stay complete after restart");
        acknowledged.stop();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_recovers_external_deletion_before_a_cleanup_tick_and_offline_pending_work() {
    let rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    rig.phones.tick(now_ms());
    // Delete the complete record while the service is stopped. The known
    // identity must survive independently of both sockets and devices.json.
    rig.phones.stop();
    crate::store::write_json(&crate::store::root().unwrap().join("devices.json"), &json!({"devices":[]})).unwrap();
    let offline = rig.phones.restart_for_test(rig.sink.clone());
    offline.tick(now_ms());
    // Restart again before any relay registration exists: durable pending work
    // must not depend on a previous control queue or its lifetime.
    let restarted = offline.restart_for_test(rig.sink.clone());
    let mut control = rig.relay.phone_test_hold_control();
    restarted.use_relay(&rig.relay);
    restarted.tick(now_ms());
    let (request, reply) = control.take().expect("removed identity must survive both restarts");
    assert_eq!(request["relayDeviceId"], "phone");
    reply.send(Ok(json!({"type":"device-revoked", "reqId":request["reqId"]}))).unwrap();
    restarted.tick(now_ms());
    restarted.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_completes_durable_revocation_intent_before_phone_admission() {
    let rig = Rig::new().await;
    rig.pair("phone", "token", false, true);
    // Simulate process death between the write-ahead intent and the registry
    // mutation. The old token must not become usable after its relay ack.
    crate::store::write_json(&crate::store::root().unwrap().join("phone-relay-cleanup.json"),
        &json!({"known":["phone"], "pending":["phone"]})).unwrap();
    let restarted = rig.phones.restart_for_test(rig.sink.clone());
    assert!(DeviceRegistry.find_by_token("token", None).unwrap().is_none());
    let mut control = rig.relay.phone_test_hold_control();
    restarted.use_relay(&rig.relay);
    restarted.tick(now_ms());
    let (request, reply) = control.take().expect("write-ahead intent must still reach the relay");
    reply.send(Ok(json!({"type":"device-revoked", "reqId":request["reqId"]}))).unwrap();
    restarted.tick(now_ms());
    assert!(DeviceRegistry.find_by_token("token", None).unwrap().is_none());
    restarted.stop();
}
