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
    // Releasing the physical lock alone does not advance the FIFO: the
    // queued command also waits for this ticket's turn to be retired.
    drop(queue);
    if case != "openTerminal" {
        wait_for("queued command withdrawn", || matches!(&rig.rt.lock().unwrap().engine,Engine::Cli(cli) if !cli.echoed.iter().any(|echo|echo.command)));
        rig.typed();
    }
    assert!(std::fs::read(&input).unwrap_or_default().is_empty(),"old control must never type after restoration");
    assert!(crate::local_runtime::mobile::execute(&rig.manager,&lifetime,method,params).is_err(),"old phone grant cannot mutate the tab again");
}

#[test]
fn privacy_withdraws_deferred_phone_modes_and_preserves_mixed_desktop_edits() {
    // Each child has its own policy and store. The parent changes the saved
    // setting and waits for the real owner's refresh acknowledgement before
    // allowing the already-running turn to complete.
    for case in ["mode-codex", "mode-claude", "stopped-mode", "remote-model-first", "remote-model-last",
        "remote-effort-first", "remote-effort-last", "remote-clear-first", "remote-clear-last",
        "local-clear-first", "local-clear-last"] {
        for restore in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let log_path = dir.path().join("child.log");
            let log = std::fs::File::create(&log_path).unwrap();
            let mut child = Child(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "session::watch_tests::prompts::privacy::deferred_child", "--nocapture"])
                .env(CASE, case).env(DIRECTORY, dir.path())
                .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap());
            let info_path = dir.path().join("ready.json");
            wait_for("settings deferred during the running turn", || info_path.exists());
            let info: serde_json::Value = serde_json::from_slice(&std::fs::read(info_path).unwrap()).unwrap();
            let preference = PathBuf::from(info["root"].as_str().unwrap()).join("data-privacy.json");
            store::write_json(&preference, &json!({"enabled":true})).unwrap();
            assert!(refresh_owner(&info).enabled);
            if restore {
                store::write_json(&preference, &json!({"enabled":false})).unwrap();
                assert!(!refresh_owner(&info).enabled);
            }
            std::fs::write(dir.path().join("complete-turn"), b"").unwrap();
            let until = Instant::now() + WAIT;
            let status = loop {
                if let Some(status) = child.0.try_wait().unwrap() { break status; }
                assert!(Instant::now() < until, "{case}, restore={restore}: {}", std::fs::read_to_string(&log_path).unwrap());
                std::thread::sleep(Duration::from_millis(10));
            };
            assert!(status.success(), "{case}, restore={restore}: {}", std::fs::read_to_string(&log_path).unwrap());
        }
    }
}

#[test]
fn deferred_child() {
    let Ok(case) = std::env::var(CASE) else { return };
    let coordination = PathBuf::from(std::env::var(DIRECTORY).unwrap());
    let kind = if case == "mode-claude" { CliKind::Claude } else { CliKind::Codex };
    let rig = Rig::on(kind, "original-model", Some("low"));
    index::update_tab(SESSION, TAB, |tab| { tab.permission_mode = "default".into(); Ok(()) }).unwrap();
    let root = store::root().unwrap();
    crate::data_privacy::refresh();
    rig.rt.lock().unwrap().turn_open = true;
    let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(120));
    let endpoint = rig.manager.control.clone();
    let service = crate::control::ControlService::headless(rig.manager.sink.clone(), rig.manager.clone(), endpoint.clone(), "local".into())
        .with_local_lifetime(lifetime.clone());
    crate::hooks::serve_private(endpoint.clone(), |_| crate::hooks::HookReply::refused("test"), move |request| service.handle(request)).unwrap();
    store::write_json(&root.join("devices.json"), &json!({"devices":[{"id":"phone","label":"Phone","platform":"test",
        "token":"fixture","scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":index::now()}]})).unwrap();
    let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
    let actor: crate::local_runtime::mobile::Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
    rig.manager.mobile.register(&lifetime, actor.clone(), "connection", "phone").unwrap();
    let mode = case.contains("mode");
    let remote_model = case.contains("remote-model") || case.contains("local-clear");
    let clear = case.contains("clear");
    let phone = || {
        let method = if mode { "setMode" } else if remote_model { "setModel" } else { "setEffort" };
        let effort = if clear { serde_json::Value::Null } else { json!("high") };
        crate::local_runtime::mobile::execute(&rig.manager, &lifetime, method,
            json!({"actor":actor,"connection":"connection","sessionId":SESSION,"tabId":TAB,
                "model":"remote-model","effort":effort,"mode":"bypassPermissions"})).unwrap();
    };
    let desktop = || {
        if remote_model { rig.manager.set_effort(SESSION, TAB, if clear { None } else { Some("high") }).unwrap(); }
        else { rig.manager.set_model(SESSION, TAB, "desktop-model").unwrap(); }
    };
    if mode { phone(); }
    else if case.ends_with("first") { phone(); desktop(); }
    else { desktop(); phone(); }
    assert!(crate::data_privacy::remote_ticket().is_none(), "the deferred worker has no initiating thread-local scope");
    let saved = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
    assert_eq!(saved.model, "original-model");
    assert_eq!(saved.effort.as_deref(), Some("low"));
    assert_eq!(saved.permission_mode, "default");
    assert!(!saved.request_privacy.is_empty(), "remote provenance must survive the index round trip");
    if mode { assert_eq!(saved.requested_permission_mode.as_deref(), Some("bypassPermissions")); }
    else {
        assert_eq!(saved.requested_model.as_deref(), Some(if remote_model { "remote-model" } else { "desktop-model" }));
        assert_eq!(saved.requested_effort.as_deref(), Some(if clear { "" } else { "high" }));
    }
    let tail = match &rig.rt.lock().unwrap().engine { Engine::Cli(p) => p.tail.clone(), _ => unreachable!() };
    assert!(rig.manager.begin_idle_restart_launch(&rig.rt, &tail).is_none(), "a running turn cannot restart");
    if case == "stopped-mode" {
        rig.manager.release_cli(&mut rig.rt.lock().unwrap());
        let stopped = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
        assert_eq!(stopped.permission_mode, "default", "stopping must not promote a remote permission request");
        assert_eq!(stopped.requested_permission_mode.as_deref(), Some("bypassPermissions"));
    }
    store::write_json(&coordination.join("ready.json"), &json!({"socket":endpoint.socket,"token":endpoint.token,"root":root})).unwrap();
    wait_for("privacy acknowledged before turn completion", || coordination.join("complete-turn").exists());
    rig.rt.lock().unwrap().turn_open = false;
    let work = rig.manager.begin_idle_restart_launch(&rig.rt, &tail);
    if mode {
        assert!(work.is_none(), "a stale phone mode must not reserve a restart");
        if case != "stopped-mode" {
            let cancelled = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
            assert!(cancelled.requested_permission_mode.is_none(), "turn completion must withdraw the stale request");
            assert!(cancelled.request_privacy.is_empty());
            assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if !p.restart_when_idle));
        }
        // Also replay the still-pending saved record as a handover/next-start
        // would see it. Its persisted authority must remain invalid.
        index::update_tab(SESSION, TAB, |tab| { saved.write(tab); Ok(()) }).unwrap();
        let mut rt = rig.rt.lock().unwrap();
        assert!(rig.manager.admit_pending_settings(&mut rt).unwrap().is_empty());
        rig.manager.settle_settings_without_process(&mut rt).unwrap();
    } else {
        let work = work.expect("the independent desktop edit still requires its restart");
        assert!(work._privacy.is_empty(), "no stale remote request rode with the local restart");
        // Exercise the same process-release and restart claim as production,
        // then stop before launching a real provider in this unit fixture.
        rig.rt.lock().unwrap().stopping = true;
        assert!(rig.manager.complete_cli_restart(&rig.rt, work).is_err());
    }
    let after = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
    assert_eq!(after.permission_mode, "default");
    assert!(after.requested_permission_mode.is_none());
    assert!(after.requested_model.is_none());
    assert!(after.requested_effort.is_none());
    assert!(after.request_privacy.is_empty());
    assert_eq!(after.model, if mode || remote_model { "original-model" } else { "desktop-model" });
    assert_eq!(after.effort.as_deref(), if mode || !remote_model { Some("low") } else if clear { None } else { Some("high") });
    let mut reloaded: Settings = serde_json::from_value(serde_json::to_value(&after).unwrap()).unwrap();
    assert!(reloaded.admit_pending().is_empty());
    reloaded.launched();
    assert_eq!(reloaded, after, "a later launch cannot revive any withdrawn phone edit");
}

#[test]
fn privacy_launch_lifecycle_preserves_ownership_and_acp_model_delivery() {
    for case in ["cli-commit-failure", "acp-off", "acp-on-before-start", "acp-cycle-before-start",
        "acp-on-before-delivery", "acp-cycle-before-delivery", "acp-refuse", "acp-refuse-new-local", "acp-refuse-new-same"] {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("child.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let mut child = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::watch_tests::prompts::privacy::lifecycle_child", "--nocapture"])
            .env(CASE, case)
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap());
        let until = Instant::now() + WAIT;
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() { break status; }
            assert!(Instant::now() < until, "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success(), "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
    }
}

fn lifecycle_phone(rig: &Rig) -> (Arc<crate::local_runtime::Lifetime>, crate::local_runtime::mobile::Actor) {
    crate::data_privacy::refresh();
    store::write_json(&store::root().unwrap().join("devices.json"), &json!({"devices":[{"id":"phone","label":"Phone","platform":"test",
        "token":"fixture","scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":index::now()}]})).unwrap();
    let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(120));
    let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
    let actor: crate::local_runtime::mobile::Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
    rig.manager.mobile.register(&lifetime, actor.clone(), "connection", "phone").unwrap();
    (lifetime, actor)
}

fn lifecycle_privacy(enabled: bool) {
    store::write_json(&store::root().unwrap().join("data-privacy.json"), &json!({"enabled":enabled})).unwrap();
    assert_eq!(crate::data_privacy::refresh().enabled, enabled);
}

fn executable(path: &std::path::Path, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn lifecycle_child() {
    let Ok(case) = std::env::var(CASE) else { return };
    if case == "cli-commit-failure" { post_spawn_commit_failure(); }
    else { acp_pending_model_restart(&case); }
}

fn post_spawn_commit_failure() {
    let mut rig = Rig::on(CliKind::Codex, "original-model", Some("low"));
    // start_cli uses the persisted tab's real pane, unlike the placeholder
    // used by Rig's synthetic transcript tests. Inspect and clean up that
    // exact pane throughout the injected failure and subsequent Stop.
    rig.pane = index::get(SESSION).unwrap().tab(TAB).unwrap().pane_id();
    let (lifetime, actor) = lifecycle_phone(&rig);
    let program = rig._dir.path().join("codex");
    executable(&program, r#"#!/bin/sh
case "$1" in
  --help) printf '  --no-daemon  Run without the daemon\n'; exit 0;;
  app-server)
    while IFS= read -r line; do
      case "$line" in
        *'"method":"model/list"'*) printf '%s\n' '{"id":2,"result":{"data":[{"id":"original-model","isDefault":true},{"id":"remote-model"}]}}'; exit 0;;
        *'"id":2'*) printf '%s\n' '{"id":2,"error":{"message":"Unsupported fixture method"}}'; exit 0;;
      esac
    done
    exit 0;;
esac
printf 'LAUNCH %s\n' "$*" >> "$0.launches"
stty raw -echo
exec cat
"#);
    let _program = codex::pty::codex_program_for_tests(program.clone());
    rig.rt.lock().unwrap().engine = Engine::None;
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    let launches = || std::fs::read_to_string(program.with_extension("launches")).unwrap_or_default();
    wait_for("initial real CLI", || launches().lines().count() == 1);
    rig.rt.lock().unwrap().turn_open = true;
    crate::local_runtime::mobile::execute(&rig.manager, &lifetime, "setModel",
        json!({"actor":actor,"connection":"connection","sessionId":SESSION,"tabId":TAB,"model":"remote-model"})).unwrap();
    let pending = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
    assert_eq!(pending.requested_model.as_deref(), Some("remote-model"));
    assert!(!pending.request_privacy.is_empty());
    let index_path = store::sessions_dir().unwrap().join("index.json");
    let backup = index_path.with_extension("before-failure");
    let fail_path = index_path.clone();
    let saved_path = backup.clone();
    let terminals = rig.manager.terminals.clone();
    let pane = rig.pane.clone();
    let injected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let inject = injected.clone();
    // The real pane announcement occurs after spawn. Replace only the test
    // index with a directory so the subsequent settings read/write fails.
    let listener = rig.manager.sink.listen("tab_pty", Box::new(move |_| {
        if !inject.swap(true, std::sync::atomic::Ordering::SeqCst) {
            assert!(terminals.is_running(&pane));
            std::fs::rename(&fail_path, &saved_path).unwrap();
            std::fs::create_dir(&fail_path).unwrap();
        }
    }));
    let tail = {
        let mut rt = rig.rt.lock().unwrap();
        rt.turn_open = false;
        match &rt.engine { Engine::Cli(p) => p.tail.clone(), _ => unreachable!() }
    };
    let work = rig.manager.begin_idle_restart_launch(&rig.rt, &tail).unwrap();
    let error = rig.manager.complete_cli_restart(&rig.rt, work).unwrap_err();
    assert!(error.to_string().contains("Stop the agent before retrying"), "{error:#}");
    assert!(injected.load(std::sync::atomic::Ordering::SeqCst));
    rig.manager.sink.unlisten(listener);
    std::fs::remove_dir(&index_path).unwrap();
    std::fs::rename(&backup, &index_path).unwrap();
    wait_for("replacement really executed", || launches().lines().count() == 2);
    assert!(launches().lines().nth(1).unwrap().contains("remote-model"), "{}", launches());
    let token = {
        let rt = rig.rt.lock().unwrap();
        assert!(rt.stopping && rt.recovery.is_some(), "a failed commit is explicitly recoverable");
        let Engine::Cli(p) = &rt.engine else { panic!("a successfully spawned CLI must retain runtime ownership") };
        assert!(rig.manager.terminals.is_running(&p.pane_id));
        p.origin.token.clone()
    };
    assert_eq!(Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap()), pending,
        "failed commit must not strip the pending request's authority");
    let reply = rig.manager.on_hook(HookFrame { session:SESSION.into(),tab:TAB.into(),token:token.clone(),event:"SessionStart".into(),payload:json!({}) });
    assert!(reply.refused.is_none(), "the live process's own hook is recognized: {:?}", reply.refused);
    assert!(rig.manager.ensure_started(SESSION, TAB).is_err(), "retry cannot spawn another process before Stop");
    assert_eq!(launches().lines().count(), 2);
    let pid = rig.manager.terminals.panes().into_iter().find(|p| p.id == rig.pane).unwrap().pid.unwrap();
    rig.manager.stop(SESSION, TAB).unwrap();
    assert!(!rig.manager.terminals.is_running(&rig.pane));
    assert!(!crate::harness::host::is_alive(pid), "normal Stop must confirm the owned process exited");
    assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::None));
    assert_eq!(index::get(SESSION).unwrap().tab(TAB).unwrap().requested_model.as_deref(), Some("remote-model"));
    lifecycle_privacy(true);
    lifecycle_privacy(false);
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    wait_for("retry after privacy cycle", || launches().lines().count() == 3);
    assert!(launches().lines().nth(2).unwrap().contains("original-model"));
    assert!(!launches().lines().nth(2).unwrap().contains("remote-model"));
    assert!(index::get(SESSION).unwrap().tab(TAB).unwrap().requested_model.is_none());
    let reply = rig.manager.on_hook(HookFrame { session:SESSION.into(),tab:TAB.into(),token,event:"SessionStart".into(),payload:json!({}) });
    assert!(reply.refused.is_some(), "the prior launch's hook cannot attach to the replacement");
    rig.manager.stop(SESSION, TAB).unwrap();
}

fn acp_pending_model_restart(case: &str) {
    let rig = Rig::on(CliKind::Claude, "original-model", Some("low"));
    index::update_tab(SESSION, TAB, |tab| { tab.harness = "cursor".into(); tab.permission_mode = "auto".into(); Ok(()) }).unwrap();
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.harness = "cursor".into();
        rt.engine = Engine::None;
    }
    let (lifetime, actor) = lifecycle_phone(&rig);
    let program = rig._dir.path().join("acp-capture");
    executable(&program, r#"#!/bin/sh
while IFS= read -r line; do printf '%s\n' "$line" >> "$0.requests"; done
"#);
    let requests_path = program.with_extension("requests");
    let requests = || store::read_lines::<serde_json::Value>(&requests_path).unwrap_or_default();
    let launch = || {
        let tab = index::get(SESSION).unwrap().tab(TAB).unwrap().clone();
        rig.manager.start_acp(&mut rig.rt.lock().unwrap(), &rig.rt, &tab, rig._dir.path().to_str().unwrap(), program.to_str().unwrap()).unwrap();
    };
    let begin = || {
        let mut rt = rig.rt.lock().unwrap();
        let Engine::Acp(a) = &mut rt.engine else { unreachable!() };
        let actions = a.start("local prompt".into(), vec![]);
        rig.manager.apply_actions(&mut rt, actions);
    };
    let initialized = || rig.manager.on_line(&rig.rt, r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}"#);
    let opened = || rig.manager.on_line(&rig.rt, r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"existing-session","models":{"currentModelId":"original-model"}}}"#);
    launch();
    begin();
    initialized();
    opened();
    // An existing ACP session receives the phone request but has not replied.
    crate::local_runtime::mobile::execute(&rig.manager, &lifetime, "setModel",
        json!({"actor":actor,"connection":"connection","sessionId":SESSION,"tabId":TAB,"model":"remote-model"})).unwrap();
    wait_for("first model request reached real stdio", || requests().iter().any(|v| v["method"] == "session/set_model" && v["params"]["modelId"] == "remote-model"));
    // A separate local launch default must survive cancellation of the model.
    rig.manager.set_permission_mode(SESSION, TAB, "plan").unwrap();
    let retired_epoch = std::sync::atomic::AtomicU64::new(rig.rt.lock().unwrap().child.as_ref().unwrap().epoch);
    rig.manager.stop(SESSION, TAB).unwrap();
    let stopped = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
    assert_eq!(stopped.model, "original-model");
    assert_eq!(stopped.requested_model.as_deref(), Some("remote-model"));
    assert!(!stopped.request_privacy.is_empty());
    assert_eq!(stopped.permission_mode, "plan");
    std::fs::write(&requests_path, b"").unwrap();
    let toggle = || {
        lifecycle_privacy(true);
        if case.contains("cycle") { lifecycle_privacy(false); }
    };
    if case.ends_with("before-start") { toggle(); }
    launch();
    begin();
    // A reply from a retired child cannot advance the replacement's
    // request id 1, even though both adapters start their ids at one.
    let before_stale = rig.events().len();
    rig.manager.on_line_from(&rig.rt, r#"{"jsonrpc":"2.0","id":1,"error":{"message":"Old child failed initialization"}}"#, Some(&retired_epoch));
    assert_eq!(rig.events().len(), before_stale, "retired replies cannot end the replacement's opening turn");
    assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Acp(a) if a.session_id.is_none() && !a.ready));
    initialized();
    if case.ends_with("before-delivery") { toggle(); }
    opened();
    // Waiting for the prompt frame proves the model-selection delivery step
    // ran; the absence assertion below is not just an unscheduled writer.
    wait_for("restarted ACP reached its prompt", || requests().iter().any(|v| v["method"] == "session/prompt"));
    let frames = requests();
    let models: Vec<_> = frames.iter().filter(|v| v["method"] == "session/set_model").collect();
    if case == "acp-off" || case.starts_with("acp-refuse") {
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["params"]["modelId"], "remote-model");
        assert_eq!(index::get(SESSION).unwrap().tab(TAB).unwrap().requested_model.as_deref(), Some("remote-model"), "delivery still waits for the provider's response");
        if case.starts_with("acp-refuse") {
            let old = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
            let newer = if case.contains("new-") {
                let model = if case.ends_with("same") { "remote-model" } else { "new-local-model" };
                rig.manager.set_model(SESSION, TAB, model).unwrap();
                let newer = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
                assert_ne!(old.model_request_id(), newer.model_request_id());
                Some(newer)
            } else { None };
            let refused = json!({"jsonrpc":"2.0","id":models[0]["id"],"error":{"code":-32602,"message":"Unknown model"}}).to_string();
            rig.manager.on_line(&rig.rt, &refused);
            if let Some(newer) = newer {
                let after = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
                assert_eq!(after.requested_model, newer.requested_model, "a late refusal cannot remove the newer local edit");
                assert_eq!(after.model_request_id(), newer.model_request_id());
                wait_for("new local model reached stdio", || requests().iter().filter(|v| v["method"] == "session/set_model").count() == 2);
                let fresh = requests().into_iter().rfind(|v| v["method"] == "session/set_model").unwrap();
                rig.manager.on_line(&rig.rt, &json!({"jsonrpc":"2.0","id":fresh["id"],"error":{"code":-32602,"message":"New choice also refused"}}).to_string());
            }
            let rejected = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
            assert_eq!(rejected.model, "original-model");
            assert_eq!(rejected.permission_mode, "plan");
            assert!(rejected.requested_model.is_none() && rejected.request_privacy.is_empty());
            // An old response replay is inert, and restarting cannot issue
            // either rejected request as a fresh launch default.
            rig.manager.on_line(&rig.rt, &refused);
            rig.manager.stop(SESSION, TAB).unwrap();
            std::fs::write(&requests_path, b"").unwrap();
            launch(); begin(); initialized(); opened();
            wait_for("restart after refusal reached prompt", || requests().iter().any(|v| v["method"] == "session/prompt"));
            assert!(!requests().iter().any(|v| v["method"] == "session/set_model"));
        } else {
            rig.manager.on_line(&rig.rt, &json!({"jsonrpc":"2.0","id":models[0]["id"],"result":{}}).to_string());
        }
    } else {
        assert!(models.is_empty(), "an expired remote request must not reach the restarted provider: {frames:?}");
    }
    let after = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
    assert_eq!(after.model, if case == "acp-off" { "remote-model" } else { "original-model" });
    assert!(after.requested_model.is_none());
    assert!(after.request_privacy.is_empty());
    assert_eq!(after.permission_mode, "plan");
    let rt = rig.rt.lock().unwrap();
    let Engine::Acp(a) = &rt.engine else { unreachable!() };
    assert_eq!(a.model.as_deref(), Some(after.model.as_str()));
    assert_eq!(a.mode, "plan");
    drop(rt);
    rig.manager.stop(SESSION, TAB).unwrap();
}

#[path = "session_acp_privacy_tests.rs"]
mod acp_lifecycle;

#[path = "session_relay_privacy_tests.rs"]
mod relay;

#[path = "session_opencode_privacy_tests.rs"]
mod opencode_privacy;
