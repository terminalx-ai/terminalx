//! Actual send/delete/revocation paths with deterministic lock barriers. Each
//! scenario runs in a disposable subprocess so a regression cannot hang Cargo.
use super::*;
use crate::issue_pipeline::admission;
use crate::local_runtime::{Lifetime, mobile::Actor};
use serde_json::json;
use std::sync::mpsc;
use std::time::Duration;

const CASE: &str = "TERMINALX_TEST_MOBILE_ADMISSION_CASE";
const WAIT: Duration = Duration::from_secs(3);

#[test]
fn blocked_mobile_admission_cannot_block_delete_revoke_detach_or_stop_all() {
    for case in ["delete", "revoke", "detach", "stop-all"] {
        let dir = tempfile::tempdir().unwrap();
        let log = std::fs::File::create(dir.path().join("child.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::mobile_admission_tests::child_fixture", "--nocapture"])
            .env(CASE, case).env("TERMINALX_HOME", dir.path().join("store"))
            .env("CLAUDE_CONFIG_DIR", dir.path().join("claude"))
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log)
            .spawn().unwrap();
        let until = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if Instant::now() >= until {
                child.kill().unwrap(); child.wait().unwrap();
                panic!("{case}: lock-order regression exceeded process deadline");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(), "{case}: {}", std::fs::read_to_string(dir.path().join("child.log")).unwrap());
    }
}

#[test]
fn child_fixture() {
    let Ok(case) = std::env::var(CASE) else { return };
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"mobile-admission", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(),"modified":index::now(),
        "tabs":[{"id":"tab","harness":"claude","permissionMode":"manual","created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    store::write_json(&root.join("devices.json"), &json!({"devices":[{
        "id":"driver","label":"Fixture","platform":"test","token":"fixture-hash",
        "scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":index::now()
    }]})).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let lifetime = Lifetime::new(Duration::from_secs(60));
    let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
    let actor: Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
    manager.mobile.register(&lifetime, actor.clone(), "connection", "driver").unwrap();
    let permit = manager.mobile.permit(&actor,"connection","mobile-admission","tab").unwrap();
    // Instantiate a stopped tab only. The rejected send must never launch any
    // installed provider or write a user-message event.
    manager.runtime("mobile-admission", "tab").unwrap();
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (fenced_tx, fenced_rx) = mpsc::channel();
    let fence_manager = manager.clone();
    let fence_lifetime = lifetime.clone();
    let fence_case = case.clone();
    let fence = std::thread::spawn(move || {
        if matches!(fence_case.as_str(), "delete" | "stop-all") {
            admission::observe_next_lock(None, Some(Box::new(move || {
                held_tx.send(()).unwrap(); release_rx.recv_timeout(WAIT).unwrap();
            })));
            let result = if fence_case == "delete" { fence_manager.delete_session("mobile-admission") }
                else { fence_manager.stop_all_confirmed() };
            fenced_tx.send(result.map_err(|error| error.to_string())).unwrap();
        } else {
            let guard = admission::lock();
            held_tx.send(()).unwrap(); release_rx.recv_timeout(WAIT).unwrap();
            let result = if fence_case == "revoke" { fence_manager.mobile.revoke_device(&actor,"driver") }
                else { fence_lifetime.command("runtime.detach", lease).map(|_| ()).map_err(|error| anyhow!(error.message)) };
            // Report while still holding admission: revocation must not wait
            // for a sender that is itself waiting for this lock.
            fenced_tx.send(result.map_err(|error| error.to_string())).unwrap();
            drop(guard);
        }
    });
    held_rx.recv_timeout(WAIT).unwrap();
    let (waiting_tx, waiting_rx) = mpsc::channel();
    let (sent_tx, sent_rx) = mpsc::channel();
    let sender = manager.clone();
    let send = std::thread::spawn(move || {
        admission::observe_next_lock(Some(Box::new(move || { waiting_tx.send(()).unwrap(); })), None);
        let result = sender.send_mobile("mobile-admission","tab","must not be delivered".into(),
            "must not be delivered".into(),vec![],permit);
        sent_tx.send(result.is_err()).unwrap();
    });
    waiting_rx.recv_timeout(WAIT).unwrap();
    release_tx.send(()).unwrap();
    fenced_rx.recv_timeout(WAIT).expect("fence blocked behind admission waiter").unwrap();
    assert!(sent_rx.recv_timeout(WAIT).expect("sender remained deadlocked"),"revoked send succeeded");
    fence.join().unwrap(); send.join().unwrap();
    assert!(manager.terminals.panes().is_empty(),"a rejected send launched a provider");
    assert!(manager.load_events("mobile-admission","tab").unwrap_or_default().iter()
        .all(|event| !matches!(event.payload,Payload::UserMessage { .. })),"a rejected prompt reached history");
    assert_eq!(index::get("mobile-admission").is_err(),case=="delete");
}
