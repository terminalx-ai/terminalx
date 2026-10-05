//! App-launch fixtures use a saved registry, no account, and an isolated port.
use super::*;
use std::net::{Ipv4Addr, TcpListener};
use std::time::Duration;

struct Startup(Arc<PairingManager>);

impl Drop for Startup {
    fn drop(&mut self) {
        self.0.stop();
    }
}

fn saved_device() -> DeviceEntry {
    DeviceEntry {
        id: "saved-phone".into(),
        label: "Phone".into(),
        platform: "ios".into(),
        token: token_hash("saved-credential"),
        scope: DeviceScope::Driver,
        provenance: DeviceProvenance::Explicit,
        bound_user_id: None,
        binding_generation: 0,
        public_key: String::new(),
        created_at: Utc::now().to_rfc3339(),
        last_seen_at: Some(Utc::now().to_rfc3339()),
        revoked_at: None,
        installation_id: None,
        created_request_id: None,
    }
}

fn configure(port: u16) -> Startup {
    let mut manager = PairingManager::new(Arc::new(AccountManager::default()));
    manager.direct_port = port;
    let manager = Startup(Arc::new(manager));
    // Match Tauri setup: configure is called outside an async runtime.
    manager
        .0
        .configure(
            Arc::new(crate::sink::BroadcastSink::new(16)),
            Some(crate::store::root().unwrap().join("logs")),
            "test.terminalx.pairing-startup",
        )
        .unwrap();
    manager
}

async fn wait_until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("saved pairings did not start the direct listener");
}

async fn connect_saved_phone(manager: &PairingManager, port: u16) {
    assert!(manager.account_context().is_none());
    assert!(manager.status().active_pairing.is_none());
    assert!(manager
        .registry
        .find_by_token("saved-credential", None)
        .unwrap()
        .is_some());
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
        .await
        .expect("a saved phone must be able to open its direct WebSocket after restart");
    socket.close(None).await.unwrap();
}

#[test]
fn startup_restores_the_listener_for_a_saved_phone_without_sign_in_or_a_new_code() {
    let _home = crate::store::temp_home();
    DeviceRegistry::default().add(saved_device()).unwrap();
    let reserved = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let manager = configure(port);
    tauri::async_runtime::block_on(async {
        wait_until(|| manager.0.inner.lock().unwrap().direct_listener_started).await;
        connect_saved_phone(&manager.0, port).await;
    });
}

#[test]
fn startup_retries_a_busy_port_and_accepts_the_saved_phone_when_it_is_released() {
    let _home = crate::store::temp_home();
    DeviceRegistry::default().add(saved_device()).unwrap();
    let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = occupied.local_addr().unwrap().port();
    let manager = configure(port);
    tauri::async_runtime::block_on(async {
        wait_until(|| manager.0.inner.lock().unwrap().direct_listener_retrying).await;
        assert!(!manager.0.inner.lock().unwrap().direct_listener_started);
        assert!(manager.0.status().last_error.is_none());
        drop(occupied);
        wait_until(|| manager.0.inner.lock().unwrap().direct_listener_started).await;
        connect_saved_phone(&manager.0, port).await;
    });
}

#[test]
fn startup_leaves_the_listener_off_without_a_claimed_unrevoked_device() {
    for devices in [
        vec![],
        vec![DeviceEntry {
            last_seen_at: None,
            ..saved_device()
        }],
        vec![DeviceEntry {
            revoked_at: Some(Utc::now().to_rfc3339()),
            ..saved_device()
        }],
    ] {
        let _home = crate::store::temp_home();
        for device in devices {
            DeviceRegistry::default().add(device).unwrap();
        }
        let reserved = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let manager = configure(reserved.local_addr().unwrap().port());
        tauri::async_runtime::block_on(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let inner = manager.0.inner.lock().unwrap();
        assert!(!inner.direct_listener_started);
        assert!(!inner.direct_listener_retrying);
        assert!(manager.0.registry.list().unwrap().is_empty());
    }
}
