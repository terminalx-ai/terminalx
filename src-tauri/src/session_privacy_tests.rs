//! Cross-process activation against the real PTY delivery path. A child owns
//! the phone/guest input; this process acts as the desktop changing its file
//! and waiting for the owner's authenticated refresh acknowledgement.
use super::*;
use std::io::{BufRead, Write};
use std::sync::mpsc;

const CASE: &str = "TERMINALX_TEST_PRIVACY_WRITER";
const DIRECTORY: &str = "TERMINALX_TEST_PRIVACY_COORDINATION";
const WAIT: Duration = Duration::from_secs(60);

fn wait_for(what: &str, condition: impl Fn() -> bool) {
    let until = Instant::now() + WAIT;
    while !condition() {
        assert!(Instant::now() < until, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn refresh_owner(info: &serde_json::Value) -> crate::data_privacy::Status {
    let mut socket = std::os::unix::net::UnixStream::connect(info["socket"].as_str().unwrap()).unwrap();
    socket.set_read_timeout(Some(WAIT)).unwrap();
    serde_json::to_writer(&mut socket, &json!({"id":"privacy", "token":info["token"],
        "command":"runtime.dataPrivacy.refresh", "params":{}})).unwrap();
    socket.write_all(b"\n").unwrap();
    let mut line = String::new();
    std::io::BufReader::new(socket).read_line(&mut line).unwrap();
    let response: crate::control::ControlResponse = serde_json::from_str(&line).unwrap();
    assert!(response.ok, "{response:?}");
    serde_json::from_value(response.result.unwrap()).unwrap()
}

#[test]
fn privacy_activation_drains_phone_and_guest_paste_before_acknowledging() {
    for case in ["phone", "guest"] {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("child.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let mut child = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::watch_tests::prompts::privacy::writer_child", "--nocapture"])
            .env(CASE, case).env(DIRECTORY, dir.path())
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap());
        let info_path = dir.path().join("ready.json");
        wait_for("owner admitted the paste", || info_path.exists());
        let info: serde_json::Value = serde_json::from_slice(&std::fs::read(info_path).unwrap()).unwrap();
        let preference = PathBuf::from(info["root"].as_str().unwrap()).join("data-privacy.json");
        store::write_json(&preference, &json!({"enabled":true})).unwrap();
        let (tx, rx) = mpsc::channel();
        let owner = info.clone();
        let activation = std::thread::spawn(move || tx.send(refresh_owner(&owner)).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err(), "activation must wait through the admitted paste/draw window");
        std::fs::write(dir.path().join("release"), b"").unwrap();
        assert!(rx.recv_timeout(WAIT).unwrap().enabled);
        activation.join().unwrap();
        // The owner may finish a paste admitted before activation, but its
        // last Enter is before this acknowledgement, never after it.
        let input = PathBuf::from(info["input"].as_str().unwrap());
        wait_for("the CLI read Enter", || std::fs::read(&input).unwrap_or_default().ends_with(b"\r"));
        let before = std::fs::read(&input).unwrap();
        assert_eq!(before, b"\x1b[200~remote\x1b[201~\r", "{case}");
        store::write_json(&preference, &json!({"enabled":false})).unwrap();
        assert!(!refresh_owner(&info).enabled);
        std::fs::write(dir.path().join("restored"), b"").unwrap();
        let until = Instant::now() + WAIT;
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() { break status; }
            assert!(Instant::now() < until, "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success(), "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
        // Child verifies the old queued write is cancelled before its store
        // and PTY are disposed. No provider or external network is involved.
    }
}

#[test]
fn writer_child() {
    let Ok(case) = std::env::var(CASE) else { return };
    let coordination = PathBuf::from(std::env::var(DIRECTORY).unwrap());
    let rig = Rig::of(CliKind::Claude, "");
    let root = store::root().unwrap();
    crate::data_privacy::refresh();
    index::save(&[serde_json::from_value(json!({"id":SESSION,"projectPath":rig._dir.path(),"cwd":rig._dir.path(),
        "title":"Privacy", "created":index::now(),"modified":index::now(),
        "tabs":[{"id":TAB,"harness":"claude","permissionMode":"default","created":index::now()}]})).unwrap()]).unwrap();
    let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(120));
    let endpoint = rig.manager.control.clone();
    let service = crate::control::ControlService::headless(rig.manager.sink.clone(), rig.manager.clone(), endpoint.clone(), "local".into())
        .with_local_lifetime(lifetime.clone());
    crate::hooks::serve_private(endpoint.clone(), |_| crate::hooks::HookReply::refused("test"), move |request| service.handle(request)).unwrap();
    let input = rig._dir.path().join("typed");
    rig.run_in_pane(&format!("stty raw -echo\nprintf '\\033]0;CLI-IS-UP\\007'\nexec cat > '{}'\n", input.display()));
    let mut mobile = None;
    let mut shared = None;
    if case == "phone" {
        store::write_json(&root.join("devices.json"), &json!({"devices":[{"id":"phone","label":"Phone","platform":"test",
            "token":"fixture","scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":index::now()}]})).unwrap();
        let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
        let actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
        rig.manager.mobile.register(&lifetime, actor, "connection", "phone").unwrap();
        let actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
        mobile = Some(rig.manager.mobile.permit(&actor,"connection",SESSION,TAB).unwrap());
    } else {
        let mut share = crate::local_sharing::tests::fixture();
        let link = share.links.get_mut("link").unwrap();
        link.settings.expires_at = i64::MAX;
        link.credential_expires_at = i64::MAX;
        let mut guest = crate::local_sharing::tests::guest("connection", "guest");
        guest.verified_until = i64::MAX;
        let now = chrono::Utc::now().timestamp_millis();
        share.join(guest, now).unwrap();
        share.admit("connection", Some(TAB), true, false, now).unwrap();
        shared = Some(share.write_permit("connection",TAB).unwrap());
        rig.manager.sharing.lock().unwrap().sessions.insert(SESSION.into(),share);
    }
    let paused = coordination.clone();
    let info = json!({"socket":endpoint.socket,"token":endpoint.token,"root":root,"input":input});
    rig.manager.sink.listen("prompt_delivery",Box::new(move |payload| {
        let event: serde_json::Value = serde_json::from_str(payload).unwrap();
        if event["stage"] == "body_written" {
            store::write_json(&paused.join("ready.json"), &info).unwrap();
            wait_for("desktop release", || paused.join("release").exists());
        }
    }));
    rig.compose("remote",0);
    let (ready, seq) = {
        let rt = rig.rt.lock().unwrap();
        let Engine::Cli(cli) = &rt.engine else { unreachable!() };
        (cli.ready.clone(), cli.awaiting_delivery.unwrap())
    };
    ready.mark();
    let (receipt, _received) = mpsc::channel();
    let delivery = || PromptDelivery { mobile:mobile.clone().map(|p|(p,SESSION.into(),TAB.into(),seq)),
        shared:shared.clone().map(|p|(p,SESSION.into(),TAB.into(),seq)),ready:Some(ready.clone()),seq:Some(seq),receipt:Some((seq,receipt.clone())),..Default::default() };
    rig.manager.type_prompt(&rig.rt,&rig.pane,"remote".into(),vec![],delivery());
    wait_for("privacy activation and restoration", || coordination.join("restored").exists());
    rig.typed();
    assert!(mobile.as_ref().is_none_or(|permit| !permit.valid()));
    assert!(shared.as_ref().is_none_or(|permit| !permit.privacy.valid()));
    assert!(crate::data_privacy::Ticket::default().valid(), "new connections work without signing in again");
    let before = std::fs::read(&input).unwrap();
    rig.manager.type_prompt(&rig.rt,&rig.pane,"stale queued input".into(),vec![],delivery());
    // Once cancellation is published, the delayed writer has checked the
    // expired permit, rather than merely not having been scheduled yet.
    wait_for("stale queued prompt cancelled", || !rig.delivery_pending());
    rig.typed();
    assert_eq!(std::fs::read(&input).unwrap(),before,"old permits never revive");
}

#[test]
fn privacy_fences_paused_controls_and_cancels_queued_model_effort_commands() {
    for case in ["control", "openTerminal", "model", "effort"] {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("child.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let mut child = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::watch_tests::prompts::privacy::control_child", "--nocapture"])
            .env(CASE, case).env(DIRECTORY, dir.path())
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap());
        let info_path = dir.path().join("ready.json");
        wait_for("control admitted or command queued", || info_path.exists());
        let info: serde_json::Value = serde_json::from_slice(&std::fs::read(info_path).unwrap()).unwrap();
        let preference = PathBuf::from(info["root"].as_str().unwrap()).join("data-privacy.json");
        store::write_json(&preference, &json!({"enabled":true})).unwrap();
        let (tx, rx) = mpsc::channel();
        let owner = info.clone();
        let activation = std::thread::spawn(move || tx.send(refresh_owner(&owner)).unwrap());
        if matches!(case, "control" | "openTerminal") {
            assert!(rx.recv_timeout(Duration::from_millis(100)).is_err(), "admitted {case} must hold activation before its mutation");
            std::fs::write(dir.path().join("release"), b"").unwrap();
        }
        assert!(rx.recv_timeout(WAIT).unwrap().enabled);
        activation.join().unwrap();
        let input = PathBuf::from(info["input"].as_str().unwrap());
        assert!(std::fs::read(&input).unwrap_or_default().is_empty(), "{case}: no command has been delivered");
        store::write_json(&preference, &json!({"enabled":false})).unwrap();
        assert!(!refresh_owner(&info).enabled);
        std::fs::write(dir.path().join("restored"), b"").unwrap();
        let until = Instant::now() + WAIT;
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() { break status; }
            assert!(Instant::now() < until,"{case}: {}", std::fs::read_to_string(&log_path).unwrap());
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success(),"{case}: {}", std::fs::read_to_string(&log_path).unwrap());
    }
}

#[test]
fn control_child() {
    let Ok(case) = std::env::var(CASE) else { return };
    let coordination = PathBuf::from(std::env::var(DIRECTORY).unwrap());
    let rig = Rig::of(CliKind::Claude, "");
    let root = store::root().unwrap();
    crate::data_privacy::refresh();
    index::save(&[serde_json::from_value(json!({"id":SESSION,"projectPath":rig._dir.path(),"cwd":rig._dir.path(),
        "title":"Privacy control", "created":index::now(),"modified":index::now(),
        "tabs":[{"id":TAB,"harness":"claude","permissionMode":"default","model":"opus","effort":"low","created":index::now()}]})).unwrap()]).unwrap();
    let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(120));
    let endpoint = rig.manager.control.clone();
    let service = crate::control::ControlService::headless(rig.manager.sink.clone(),rig.manager.clone(),endpoint.clone(),"local".into())
        .with_local_lifetime(lifetime.clone());
    crate::hooks::serve_private(endpoint.clone(), |_| crate::hooks::HookReply::refused("test"), move |request| service.handle(request)).unwrap();
    let input = rig._dir.path().join("typed");
    rig.run_in_pane(&format!("stty raw -echo\nprintf '\\033]0;CLI-IS-UP\\007'\nexec cat > '{}'\n",input.display()));
    store::write_json(&root.join("devices.json"), &json!({"devices":[{"id":"phone","label":"Phone","platform":"test",
        "token":"fixture","scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":index::now()}]})).unwrap();
    let lease = lifetime.command("runtime.attach",json!({"protocol":1})).unwrap();
    let actor: crate::local_runtime::mobile::Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
    rig.manager.mobile.register(&lifetime,actor.clone(),"connection","phone").unwrap();
    let params = json!({"actor":actor,"connection":"connection","sessionId":SESSION,"tabId":TAB,"model":"sonnet","effort":"high"});
    let method = if case == "openTerminal" { "openTerminal" } else if case == "effort" { "setEffort" } else { "setModel" };
    let info = json!({"socket":endpoint.socket,"token":endpoint.token,"root":root,"input":input});
    // Hold the existing physical-writer queue. The model/effort operation
    // returns after enqueue, proving it is the queued authority, not its
    // original call's lease, which prevents a write after off/on.
    let queue = rig.manager.writers.lock().unwrap().entry(rig.pane.clone()).or_default().ticket();
    let writer = queue.take();
    if matches!(case.as_str(),"control" | "openTerminal") {
        let directory = coordination.clone();
        let info = info.clone();
        crate::local_runtime::mobile::observe_control_admission(Box::new(move || {
            store::write_json(&directory.join("ready.json"),&info).unwrap();
            wait_for("paused control released", || directory.join("release").exists());
        }));
    }
    let result = crate::local_runtime::mobile::execute(&rig.manager,&lifetime,method,params.clone());
    if matches!(case.as_str(),"model" | "effort") {
        result.unwrap();
        assert!(matches!(&rig.rt.lock().unwrap().engine,Engine::Cli(cli) if cli.echoed.iter().any(|echo|echo.command)),"a real slash command was queued");
        store::write_json(&coordination.join("ready.json"),&info).unwrap();
    }
    wait_for("activation and restoration", || coordination.join("restored").exists());
    drop(writer);
    if case != "openTerminal" {
        wait_for("queued command withdrawn", || matches!(&rig.rt.lock().unwrap().engine,Engine::Cli(cli) if !cli.echoed.iter().any(|echo|echo.command)));
        rig.typed();
    }
    assert!(std::fs::read(&input).unwrap_or_default().is_empty(),"old control must never type after restoration");
    assert!(crate::local_runtime::mobile::execute(&rig.manager,&lifetime,method,params).is_err(),"old phone grant cannot mutate the tab again");
}
