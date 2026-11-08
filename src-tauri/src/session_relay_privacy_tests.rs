//! Actual relay dispatch, files, SessionManager FIFO delivery and loopback ports.
use super::*;
use crate::remote::{protocol::{Authority, PROTOCOL}, server::{Peer, WorkspaceRpc}};
use std::future::Future;
use std::task::{Context, Waker};

const RELAY: &str = "TERMINALX_TEST_RELAY_PRIVACY";

fn policy(enabled: bool, managed: bool) {
    if managed && enabled { std::env::set_var("TERMINALX_TEST_MANAGED_PRIVACY", "1"); }
    else { std::env::remove_var("TERMINALX_TEST_MANAGED_PRIVACY"); }
    store::write_json(&store::root().unwrap().join("data-privacy.json"), &json!({"enabled":enabled && !managed})).unwrap();
    assert_eq!(crate::data_privacy::refresh().enabled, enabled);
}
fn refused(answer: &serde_json::Value) {
    assert_eq!(answer["ok"], false, "{answer}");
    assert_eq!(answer["error"]["code"], "forbidden", "{answer}");
    assert_eq!(answer["error"]["message"], crate::data_privacy::MESSAGE);
}

#[test]
fn privacy_relay_mutations_and_deferred_writes_keep_authority() {
    for managed in [false, true] {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::watch_tests::prompts::privacy::relay::privacy_relay_child", "--nocapture"])
            .env(RELAY, if managed { "managed" } else { "personal" }).output().unwrap();
        assert!(out.status.success(), "managed={managed}\n{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
}

#[test]
fn privacy_relay_child() {
    let Ok(kind) = std::env::var(RELAY) else { return };
    let managed = kind == "managed";
    let mut rig = Rig::of(CliKind::Claude, "");
    policy(false, managed);
    let root = rig._dir.path().canonicalize().unwrap();
    index::save(&[serde_json::from_value(json!({"id":SESSION,"projectPath":root,"cwd":root,
        "title":"Relay privacy","created":index::now(),"modified":index::now(),
        "tabs":[{"id":TAB,"harness":"claude","permissionMode":"default","created":index::now()}]})).unwrap()]).unwrap();
    // Watcher rigs normally use a synthetic pane name; public send uses the
    // saved tab's actual pane. Keep both owners on that same real PTY.
    rig.pane = index::get(SESSION).unwrap().tab(TAB).unwrap().pane_id();
    if let Engine::Cli(cli) = &mut rig.rt.lock().unwrap().engine { cli.pane_id = rig.pane.clone(); }
    // Fail closed if this test accidentally starts a new provider process.
    use std::os::unix::fs::PermissionsExt;
    let program = root.join("unexpected-agent");
    std::fs::write(&program, "#!/bin/sh\nexit 97\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let _agent = claude::pty::claude_program_for_tests(program);
    let input = root.join("typed");
    rig.run_in_pane(&format!("stty raw -echo\nprintf '\\033]0;CLI-IS-UP\\007'\nexec cat > '{}'\n", input.display()));
    if let Engine::Cli(cli) = &rig.rt.lock().unwrap().engine { cli.ready.mark(); }
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(1).enable_all().build().unwrap();
    let rpc = WorkspaceRpc::new(&root, 1, rig.manager.sink.clone(), rig.manager.terminals.clone(), Some(rig.manager.clone())).unwrap();
    let (peer, _events) = Peer::new("relay-privacy".into(), Authority::Manage);
    let hello = json!({"id":"hello","method":"rpc.hello","params":{"protocol":PROTOCOL,"want":["fs/1","session/1","ports/1"]}});
    assert_eq!(runtime.block_on(rpc.handle(&peer,&hello))["ok"],true);
    let request = |method: &str| json!({"id":"mutation","method":method,"params":{
        "clientRequestId":uuid::Uuid::new_v4().to_string(),"path":"target","text":"remote",
        "sessionId":SESSION,"tabId":TAB}});
    let target = root.join("target");
    for method in ["fs.write", "fs.delete", "session.send"] {
        std::fs::write(&target,"original").unwrap();
        policy(true,managed);
        refused(&runtime.block_on(rpc.handle_owned(peer.clone(),request(method))));
        policy(false,managed);
        let queued = rpc.handle_owned(peer.clone(),request(method));
        policy(true,managed); policy(false,managed);
        refused(&runtime.block_on(queued));
        // Poll into the actual blocking queue, then acknowledge the cycle.
        let (entered,arrived) = mpsc::channel(); let (release,released) = mpsc::channel();
        let blocker=runtime.spawn_blocking(move || { entered.send(()).unwrap(); released.recv().unwrap(); });
        arrived.recv_timeout(WAIT).unwrap();
        let mut pending=Box::pin(rpc.handle_owned(peer.clone(),request(method)));
        { let _rt=runtime.enter(); assert!(pending.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending()); }
        policy(true,managed); policy(false,managed); release.send(()).unwrap(); runtime.block_on(blocker).unwrap();
        refused(&runtime.block_on(pending));
        assert_eq!(std::fs::read_to_string(&target).unwrap(),"original");
        assert!(std::fs::read(&input).unwrap_or_default().is_empty());
    }
    for method in ["fs.write", "fs.delete"] {
        std::fs::write(&target,"original").unwrap();
        let (entered,arrived)=mpsc::channel(); let (release,released)=mpsc::channel();
        *crate::remote::server::BEFORE_REMOTE_WORK.lock().unwrap()=Some(Box::new(move || {
            assert!(crate::data_privacy::remote_ticket().is_some(), "deferred work must inherit remote authority");
            entered.send(()).unwrap(); released.recv_timeout(WAIT).unwrap();
        }));
        let pending=runtime.spawn(rpc.handle_owned(peer.clone(),request(method)));
        arrived.recv_timeout(WAIT).unwrap();
        let (acknowledged,ack)=mpsc::channel();
        let activation=std::thread::spawn(move || { policy(true,managed); acknowledged.send(()).unwrap(); });
        wait_for("policy withdrew authority", crate::data_privacy::enabled);
        assert!(ack.recv_timeout(Duration::from_millis(100)).is_err(), "acknowledged before an admitted filesystem mutation finished");
        release.send(()).unwrap();
        assert_eq!(runtime.block_on(pending).unwrap()["ok"],true);
        ack.recv_timeout(WAIT).unwrap(); activation.join().unwrap();
        let after=std::fs::read(&target).ok();
        policy(false,managed);
        assert_eq!(std::fs::read(&target).ok(),after);
        // A fresh remote request still works without restarting/signing in.
        assert_eq!(runtime.block_on(rpc.handle_owned(peer.clone(),request("fs.write")))["ok"],true);
        assert_eq!(std::fs::read_to_string(&target).unwrap(),"remote");
    }
    // Return from session.send while its real PTY write is behind an older
    // FIFO item. Only the captured ticket can prevent off/on resurrection.
    let queue=rig.manager.writers.lock().unwrap().entry(rig.pane.clone()).or_default().ticket();
    let writer=queue.take();
    let sent=runtime.block_on(rpc.handle_owned(peer.clone(),request("session.send")));
    assert_eq!(sent["ok"],true,"{sent}");
    assert!(rig.delivery_pending());
    policy(true,managed); policy(false,managed);
    drop(writer); drop(queue);
    wait_for("stale relay prompt withdrawn", || !rig.delivery_pending());
    rig.typed();
    assert!(std::fs::read(&input).unwrap_or_default().is_empty(),"stale relay send reached the PTY");
    let mut fresh=request("session.send"); fresh["params"]["text"]=json!("fresh relay");
    let sent=runtime.block_on(rpc.handle_owned(peer.clone(),fresh));
    assert_eq!(sent["ok"],true,"{sent}");
    wait_for("fresh relay physically delivered", || std::fs::read(&input).unwrap_or_default().ends_with(b"fresh relay\x1b[201~\r"));
    // A port's queued writes retain its opening generation and both halves
    // are gone before activation acknowledges; idle sockets cannot revive.
    runtime.block_on(async {
        use tokio::io::AsyncReadExt;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port=listener.local_addr().unwrap().port();
        let opened=rpc.handle(&peer,&json!({"id":"open","method":"ports.open","params":{"port":port}})).await;
        assert_eq!(opened["ok"],true,"{opened}");
        let (mut socket,_)=listener.accept().await.unwrap();
        let activation=tokio::task::spawn_blocking(move || policy(true,managed));
        activation.await.unwrap();
        let mut byte=[0u8];
        assert_eq!(tokio::time::timeout(Duration::from_secs(3),socket.read(&mut byte)).await.unwrap().unwrap(),0);
        policy(false,managed);
        let answer=rpc.handle(&peer,&json!({"id":"write","method":"ports.write","params":{"streamId":opened["result"]["streamId"],"data":"eA=="}})).await;
        assert_eq!(answer["ok"],false,"old stream must not revive");
    });
}
