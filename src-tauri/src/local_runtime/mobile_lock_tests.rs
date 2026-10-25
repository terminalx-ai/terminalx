//! Mixed sharing/mobile operations on the same desktop lease. Run in bounded
//! children so a lock-order regression cannot strand the test runner.
use super::*;
use crate::{harness::host::Host, local_sharing, pty, session::SessionManager, sink, store};
use serde_json::json;
use std::{cell::RefCell, sync::mpsc, time::{Duration, Instant}};

thread_local! {
    static SNAPSHOT: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
}
pub(super) fn after_snapshot() {
    let callback = SNAPSHOT.with(|slot| slot.borrow_mut().take());
    if let Some(callback) = callback { callback(); }
}
const CASE: &str = "TERMINALX_TEST_SHARED_MOBILE_LOCK_CASE";
const WAIT: Duration = Duration::from_secs(4);

#[test]
fn shared_stop_does_not_deadlock_mobile_authority_or_revocation() {
    for case in ["check", "close", "revoke", "clear"] {
        let dir = tempfile::tempdir().unwrap();
        let log = std::fs::File::create(dir.path().join("child.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "local_runtime::mobile::lock_tests::mixed_lease_child", "--nocapture"])
            .env(CASE,case).env("TERMINALX_HOME",dir.path().join("store"))
            .env("CLAUDE_CONFIG_DIR",dir.path().join("claude"))
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log)
            .spawn().unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if Instant::now() >= until {
                child.kill().unwrap(); child.wait().unwrap();
                panic!("{case}: mixed sharing/mobile lock deadline exceeded");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(),"{case}: {}",std::fs::read_to_string(dir.path().join("child.log")).unwrap());
    }
}

#[test]
fn mixed_lease_child() {
    let Ok(case) = std::env::var(CASE) else { return };
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let entry: store::index::SessionEntry = serde_json::from_value(json!({
        "id":"mixed-lease","projectPath":root,"cwd":root,"title":"fixture",
        "created":store::index::now(),"modified":store::index::now(),
        "tabs":[{"id":"tab","harness":"claude","permissionMode":"manual","created":store::index::now()}]
    })).unwrap();
    store::index::save(&[entry]).unwrap();
    store::write_json(&root.join("devices.json"), &json!({"devices":[{
        "id":"driver","label":"Fixture","platform":"test","token":"fixture-hash",
        "scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":store::index::now()
    }]})).unwrap();
    let manager = SessionManager::new(Arc::new(sink::BroadcastSink::new(256)),Arc::new(sink::NoObserver),
        Arc::new(Host::new()),Arc::new(pty::Terminals::new()),Arc::new(Default::default()),
        Arc::new(Default::default()),crate::hooks::prepare_control().unwrap());
    let lifetime = Lifetime::new(Duration::from_secs(60));
    let lease = lifetime.command("runtime.attach",json!({"protocol":1})).unwrap();
    let actor: Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
    manager.mobile.register(&lifetime,actor.clone(),"connection","driver").unwrap();
    let permit = manager.mobile.permit(&actor,"connection","mixed-lease","tab").unwrap();
    let sharing_actor = json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,
        "userId":"host","profileId":"profile","organizationId":"org"});
    let call = |method, mut params: Value| {
        params["actor"] = sharing_actor.clone(); params["sessionId"] = json!("mixed-lease");
        local_sharing::owner::execute(&manager,&lifetime,method,params).unwrap()
    };
    call("register",json!({}));
    let expiry = chrono::Utc::now().timestamp_millis()+60_000;
    call("create",json!({"linkId":"link","url":"https://example.invalid/fixture","tokenHash":"fixture",
        "credentialExpiresAt":expiry,"directOnly":true,
        "host":{"userId":"host","displayName":"Host","email":"host@example.invalid","organizationIds":["org"]},
        "settings":{"audience":"anyone","role":"driver","people":[],"expiresAt":expiry,
            "approveEachPerson":false,"canApprove":false,"maximumPeople":4,"singleUse":false}}));
    assert_eq!(call("join",json!({"linkId":"link","connectionId":"guest",
        "person":{"userId":"guest","displayName":"Guest","email":"guest@example.invalid","emailVerified":true,"organizationIds":[]}}))["admitted"],true);
    let (held_tx,held_rx) = mpsc::channel();
    let (stop_go,stop_wait) = mpsc::channel();
    let (stopped_tx,stopped_rx) = mpsc::channel();
    let stopping = manager.clone();
    let stop = std::thread::spawn(move || {
        local_sharing::runtime::observe_attachment(Box::new(move || {
            held_tx.send(()).unwrap(); stop_wait.recv_timeout(WAIT).unwrap();
        }));
        let actor = serde_json::from_value(sharing_actor).unwrap();
        let result = local_sharing::runtime::request(&stopping,Some(&actor),"mixed-lease","guest","session.stop",
            json!({"sessionId":"mixed-lease","tabId":"tab","force":true}));
        stopped_tx.send(result.map_err(|e|e.to_string())).unwrap();
    });
    held_rx.recv_timeout(WAIT).unwrap();
    let (snapshot_tx,snapshot_rx) = mpsc::channel();
    let (probe_go,probe_wait) = mpsc::channel();
    let (done_tx,done_rx) = mpsc::channel();
    let mobile = manager.clone(); let mobile_actor = actor.clone(); let mobile_case = case.clone();
    let probe = std::thread::spawn(move || {
        SNAPSHOT.with(|slot| *slot.borrow_mut() = Some(Box::new(move || {
            snapshot_tx.send(()).unwrap(); probe_wait.recv_timeout(WAIT).unwrap();
        })));
        let result = match mobile_case.as_str() {
            "check" => mobile.mobile.grant(&mobile_actor,"connection").and_then(|grant| grant.enter().map(|_|())),
            "close" => mobile.mobile.close(&mobile_actor,"connection"),
            "revoke" => mobile.mobile.revoke_device(&mobile_actor,"driver"),
            "clear" => mobile.mobile.clear(&mobile_actor),
            _ => unreachable!(),
        };
        done_tx.send(result.map_err(|e|e.to_string())).unwrap();
    });
    // Stop owns Attachment. The mobile request has read Registry metadata but
    // has not acquired Attachment. It must not retain Registry at this boundary:
    // stop must invalidate the revision and finish before the probe resumes.
    snapshot_rx.recv_timeout(WAIT).unwrap(); stop_go.send(()).unwrap();
    assert_eq!(stopped_rx.recv_timeout(WAIT).expect("shared stop blocked on mobile registry").unwrap()["stopped"],true);
    probe_go.send(()).unwrap(); done_rx.recv_timeout(WAIT).expect("mobile operation stayed blocked").unwrap();
    stop.join().unwrap(); probe.join().unwrap();
    assert!(!permit.valid(),"stop must invalidate the earlier input epoch");
    if case == "check" { manager.mobile.revoke_device(&actor,"driver").unwrap(); }
    assert!(manager.mobile.grant(&actor,"connection").is_err());
    lifetime.command("runtime.detach",lease).unwrap();
    assert!(!permit.valid());
    assert!(manager.terminals().panes().is_empty(),"lock regression must not launch a provider");
}
