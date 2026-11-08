//! Real ACP stdio replies held across owner acknowledgement. The first input
//! uses the actual paired-phone entry point, not adapter.start in a fixture.
use super::*;

const SERVER: &str = r#"#!/usr/bin/env python3
import json, pathlib, sys, time
base = pathlib.Path(sys.argv[0]).parent
for line in sys.stdin:
    value = json.loads(line)
    with (base / 'requests').open('a') as output:
        output.write(json.dumps(value) + '\n')
    method = value.get('method')
    if method == 'initialize':
        if (base / 'block-init').exists():
            (base / 'opening').touch()
            while (base / 'block-init').exists():
                time.sleep(0.005)
        if (base / 'fail-init').exists():
            (base / 'fail-init').unlink()
            print(json.dumps({'jsonrpc':'2.0','id':value['id'],'error':{'code':-32000,'message':'Initialization refused'}}), flush=True)
            continue
        result = {'protocolVersion':1,'agentCapabilities':{'loadSession':True}}
        if (base / 'needs-auth').exists():
            result['authMethods'] = [{'id':'fixture'}]
    elif method == 'authenticate':
        if (base / 'block-auth').exists():
            (base / 'opening').touch()
            while (base / 'block-auth').exists():
                time.sleep(0.005)
        result = {}
    elif method in ('session/new', 'session/load'):
        if method == 'session/load' and (base / 'fail-load').exists():
            (base / 'fail-load').unlink()
            print(json.dumps({'jsonrpc':'2.0','id':value['id'],'error':{'code':-32000,'message':'Session missing'}}), flush=True)
            continue
        (base / 'opening').touch()
        while (base / 'block-open').exists():
            time.sleep(0.005)
        result = {'sessionId':'owned-session','models':{'currentModelId':'original-model'},'modes':{'currentModeId':'normal','availableModes':[{'id':'normal'},{'id':'plan'}]}}
    elif method == 'session/prompt':
        result = {'stopReason':'end_turn'}
    elif method in ('session/set_model', 'session/set_mode'):
        result = {}
    else:
        continue
    print(json.dumps({'jsonrpc':'2.0','id':value['id'],'result':result}), flush=True)
    if method in ('session/new', 'session/load'):
        while (base / 'block-read').exists():
            time.sleep(0.005)
"#;

#[test]
fn blocked_acp_pipe_releases_admission_and_allows_privacy_and_stop() {
    for case in ["pipe-on", "pipe-cycle", "pipe-stop", "pipe-timeout", "pipe-model-off", "pipe-model-on", "pipe-model-cycle"] {
        println!("ACP blocked-pipe case: {case}");
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("child.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let mut child = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::watch_tests::prompts::privacy::acp_lifecycle::blocked_pipe_child", "--nocapture"])
            .env(CASE, case).env(DIRECTORY, dir.path())
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap());
        let ready = dir.path().join("ready.json");
        wait_for("actual ACP input pipe is full", || ready.exists());
        let info: serde_json::Value = serde_json::from_slice(&std::fs::read(ready).unwrap()).unwrap();
        if case.ends_with("-on") || case.ends_with("-cycle") {
            let preference = PathBuf::from(info["root"].as_str().unwrap()).join("data-privacy.json");
            store::write_json(&preference, &json!({"enabled":true})).unwrap();
            let started = Instant::now();
            assert!(refresh_owner(&info).enabled);
            assert!(started.elapsed() < Duration::from_secs(10), "a full pipe must not stall privacy acknowledgement");
            if case.ends_with("-cycle") {
                store::write_json(&preference, &json!({"enabled":false})).unwrap();
                assert!(!refresh_owner(&info).enabled);
            }
        }
        std::fs::write(dir.path().join("release"), b"").unwrap();
        let until = Instant::now() + WAIT;
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() { break status; }
            assert!(Instant::now() < until, "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success(), "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
    }
}

#[test]
fn blocked_pipe_child() {
    let Ok(case) = std::env::var(CASE) else { return };
    let coordination = PathBuf::from(std::env::var(DIRECTORY).unwrap());
    let rig = Rig::on(CliKind::Claude, "original-model", None);
    if case.starts_with("relay-queued-") {
        // WorkspaceRpc scopes visibility to the canonical workspace root.
        let root = rig._dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
        index::update_session(SESSION, |session| { session.project_path = root.clone(); session.cwd = root; Ok(()) }).unwrap();
    }
    index::update_tab(SESSION, TAB, |tab| { tab.harness = "cursor".into(); tab.permission_mode = "auto".into(); Ok(()) }).unwrap();
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.harness = "cursor".into(); rt.engine = Engine::None; rt.me = Arc::downgrade(&rig.rt);
    }
    let (lifetime, actor) = lifecycle_phone(&rig);
    let endpoint = rig.manager.control.clone();
    let service = crate::control::ControlService::headless(rig.manager.sink.clone(), rig.manager.clone(), endpoint.clone(), "local".into())
        .with_local_lifetime(lifetime.clone());
    crate::hooks::serve_private(endpoint.clone(), |_| crate::hooks::HookReply::refused("test"), move |request| service.handle(request)).unwrap();
    let program = rig._dir.path().join("acp-server");
    executable(&program, SERVER);
    std::fs::write(rig._dir.path().join("block-read"), b"").unwrap();
    let tab = index::get(SESSION).unwrap().tab(TAB).unwrap().clone();
    rig.manager.start_acp(&mut rig.rt.lock().unwrap(), &rig.rt, &tab, rig._dir.path().to_str().unwrap(), program.to_str().unwrap()).unwrap();
    let other_dir = rig._dir.path().join("other-provider");
    std::fs::create_dir(&other_dir).unwrap();
    let other_program = other_dir.join("acp-server");
    executable(&other_program, SERVER);
    let mut other_tab = tab.clone();
    other_tab.id = "other-tab".into();
    index::update_session(SESSION, |session| { session.tabs.push(other_tab.clone()); Ok(()) }).unwrap();
    let other_runtime = rig.manager.runtime(SESSION, &other_tab.id).unwrap();
    rig.manager.start_acp(&mut other_runtime.lock().unwrap(), &other_runtime, &other_tab, other_dir.to_str().unwrap(), other_program.to_str().unwrap()).unwrap();
    let (observed, full_pipe) = mpsc::channel();
    *ACP_FULL_PIPE.lock().unwrap() = Some(observed);
    let text = "x".repeat(2 * 1024 * 1024);
    let sent = crate::local_runtime::mobile::execute(&rig.manager, &lifetime, "send",
        json!({"actor":actor,"connection":"connection","sessionId":SESSION,"tabId":TAB,"text":text,"prompt":text})).unwrap();
    let seq = sent["events"][0]["seq"].as_u64().unwrap();
    full_pipe.recv_timeout(WAIT).expect("the production writer observed WouldBlock");
    if case.contains("model") {
        crate::local_runtime::mobile::execute(&rig.manager, &lifetime, "setModel",
            json!({"actor":actor,"connection":"connection","sessionId":SESSION,"tabId":TAB,"model":"remote-model"})).unwrap();
        assert!(!rig.rt.lock().unwrap().stopping, "a control waits behind the partial prompt instead of breaking its pipe");
        let pending = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
        assert_eq!(pending.requested_model.as_deref(), Some("remote-model"));
        assert!(!pending.request_privacy.is_empty());
    }
    let (released, available) = mpsc::channel();
    let runtime = rig.rt.clone();
    let manager = rig.manager.clone();
    let other = other_runtime.clone();
    let probing = std::thread::spawn(move || {
        {
            let _admission = crate::issue_pipeline::admission::lock_for("other-session", "other-tab");
            let _runtime = runtime.lock().unwrap();
        }
        manager.send(SESSION, "other-tab", "The other tab remains usable".into(), vec![]).unwrap();
        wait_for("another real ACP tab completes its prompt", || {
            store::read_lines::<serde_json::Value>(&other_dir.join("requests")).unwrap_or_default().iter().any(|request| request["method"] == "session/prompt")
                && !other.lock().unwrap().turn_open
        });
        released.send(()).unwrap();
    });
    available.recv_timeout(Duration::from_secs(2)).expect("another real tab remains usable while the first provider never reads");
    probing.join().unwrap();
    assert!(rig.rt.lock().unwrap().turn_open, "the other tab completes before the blocked prompt times out");
    rig.manager.stop(SESSION, "other-tab").unwrap();
    store::write_json(&coordination.join("ready.json"), &json!({"socket":endpoint.socket,"token":endpoint.token,"root":store::root().unwrap()})).unwrap();
    wait_for("parent privacy acknowledgement", || coordination.join("release").exists());
    if case == "pipe-model-off" {
        std::fs::remove_file(rig._dir.path().join("block-read")).unwrap();
        wait_for("the full prompt and queued control are each delivered", || index::get(SESSION).unwrap().tab(TAB).unwrap().model == "remote-model");
        wait_for("the provider completes the intact prompt", || !rig.rt.lock().unwrap().turn_open);
        rig.manager.stop(SESSION, TAB).unwrap();
        let requests = store::read_lines::<serde_json::Value>(&rig._dir.path().join("requests")).unwrap();
        assert_eq!(requests.iter().filter(|request| request["method"] == "session/prompt").count(), 1);
        assert_eq!(requests.iter().filter(|request| request["method"] == "session/set_model" && request["params"]["modelId"] == "remote-model").count(), 1);
        return;
    }
    if case == "pipe-stop" {
        let started = Instant::now();
        rig.manager.stop(SESSION, TAB).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
    }
    wait_for("blocked or cancelled input is withdrawn", || rig.events().iter().any(|e| matches!(&e.payload, Payload::PromptWithdrawn { prompt_seq } if *prompt_seq == seq)));
    wait_for("the failed delivery settles its turn", || !rig.rt.lock().unwrap().turn_open);
    assert!(!rig.events().iter().any(|e| matches!(&e.payload, Payload::TurnStarted { prompt_seq: Some(prompt_seq), .. } if *prompt_seq == seq)));
    rig.manager.stop(SESSION, TAB).unwrap();
    // No partial frame is completed or replayed after off/on or Stop.
    let requests = store::read_lines::<serde_json::Value>(&rig._dir.path().join("requests")).unwrap();
    assert!(!requests.iter().any(|request| request["method"] == "session/prompt"));
    assert!(!requests.iter().any(|request| request["method"] == "session/set_model"));
    assert!(rig.rt.lock().unwrap().child.is_none());
}

#[test]
fn phone_startup_prompt_requires_privacy_and_sender_authority_at_real_acp_write() {
    let mut cases: Vec<String> = ["phone-on", "phone-cycle", "phone-off", "phone-revoked", "phone-mode", "phone-interrupt", "phone-stop", "phone-init-error", "local-on", "phone-load-cycle", "phone-load-fallback-cycle", "phone-auth-cycle", "phone-interrupt-local", "edit-model-on", "edit-model-cycle", "edit-model-off", "edit-mode-on", "edit-mode-cycle", "edit-mode-off", "edit-local-model-on", "edit-local-mode-on", "edit-mixed-model-on", "edit-mixed-model-cycle", "edit-mixed-mode-on", "edit-mixed-mode-cycle"].into_iter().map(String::from).collect();
    for stage in ["init", "auth", "load"] {
        for setting in ["model", "mode"] {
            for policy in ["on", "cycle"] { cases.push(format!("edit-{stage}-{setting}-{policy}")); }
        }
    }
    startup_cases(cases);
}

#[test]
fn privacy_relay_acp_queue_retains_authority_and_local_messages() {
    startup_cases(["relay-queued-on", "relay-queued-cycle", "relay-queued-off"].into_iter().map(String::from));
}

fn startup_cases(cases: impl IntoIterator<Item = String>) {
    for case in cases {
        println!("ACP startup case: {case}");
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("child.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let mut child = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::watch_tests::prompts::privacy::acp_lifecycle::startup_child", "--nocapture"])
            .env(CASE, &case).env(DIRECTORY, dir.path())
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap());
        let ready = dir.path().join("ready.json");
        let until = Instant::now() + WAIT;
        while !ready.exists() {
            assert!(child.0.try_wait().unwrap().is_none() && Instant::now() < until, "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
            std::thread::sleep(Duration::from_millis(5));
        }
        let info: serde_json::Value = serde_json::from_slice(&std::fs::read(ready).unwrap()).unwrap();
        if case.ends_with("-on") || case.ends_with("-cycle") {
            let preference = PathBuf::from(info["root"].as_str().unwrap()).join("data-privacy.json");
            store::write_json(&preference, &json!({"enabled":true})).unwrap();
            assert!(refresh_owner(&info).enabled, "owner acknowledges before the provider is released");
            if case.ends_with("-cycle") {
                store::write_json(&preference, &json!({"enabled":false})).unwrap();
                assert!(!refresh_owner(&info).enabled);
            }
        }
        std::fs::write(dir.path().join("release"), b"").unwrap();
        let until = Instant::now() + WAIT;
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() { break status; }
            assert!(Instant::now() < until, "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success(), "{case}: {}", std::fs::read_to_string(&log_path).unwrap());
    }
}

#[test]
fn startup_child() {
    let Ok(case) = std::env::var(CASE) else { return };
    let coordination = PathBuf::from(std::env::var(DIRECTORY).unwrap());
    let rig = Rig::on(CliKind::Claude, "original-model", None);
    index::update_tab(SESSION, TAB, |tab| {
        tab.harness = "cursor".into(); tab.permission_mode = "auto".into();
        if case.contains("load") { tab.provider_session_id = Some("resume-session".into()); }
        Ok(())
    }).unwrap();
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.harness = "cursor".into(); rt.engine = Engine::None; rt.me = Arc::downgrade(&rig.rt);
    }
    let (lifetime, actor) = lifecycle_phone(&rig);
    let endpoint = rig.manager.control.clone();
    let service = crate::control::ControlService::headless(rig.manager.sink.clone(), rig.manager.clone(), endpoint.clone(), "local".into())
        .with_local_lifetime(lifetime.clone());
    crate::hooks::serve_private(endpoint.clone(), |_| crate::hooks::HookReply::refused("test"), move |request| service.handle(request)).unwrap();
    let program = rig._dir.path().join("acp-server");
    executable(&program, SERVER);
    let blocked = rig._dir.path().join(if case.starts_with("edit-init-") { "block-init" } else if case.contains("edit-auth-") { "block-auth" } else { "block-open" });
    std::fs::write(&blocked, b"").unwrap();
    if case.contains("fallback") { std::fs::write(rig._dir.path().join("fail-load"), b"").unwrap(); }
    if case.contains("auth") { std::fs::write(rig._dir.path().join("needs-auth"), b"").unwrap(); }
    if case == "phone-init-error" { std::fs::write(rig._dir.path().join("fail-init"), b"").unwrap(); }
    let launch = || {
        let tab = index::get(SESSION).unwrap().tab(TAB).unwrap().clone();
        rig.manager.start_acp(&mut rig.rt.lock().unwrap(), &rig.rt, &tab, rig._dir.path().to_str().unwrap(), program.to_str().unwrap()).unwrap();
    };
    launch();
    let relay = case.starts_with("relay-queued-");
    let local = case == "local-on" || case.starts_with("edit-") || relay;
    let relay_send = |text: &str| {
        use crate::remote::{protocol::{Authority, PROTOCOL}, server::{Peer, WorkspaceRpc}};
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let rpc = WorkspaceRpc::new(rig._dir.path(), 1, rig.manager.sink.clone(), rig.manager.terminals.clone(), Some(rig.manager.clone())).unwrap();
        let (peer, _events) = Peer::new("relay-acp".into(), Authority::Manage);
        assert_eq!(runtime.block_on(rpc.handle(&peer, &json!({"id":"hello","method":"rpc.hello","params":{"protocol":PROTOCOL,"want":["session/1"]}})))["ok"], true);
        let sent = runtime.block_on(rpc.handle(&peer, &json!({"id":"send","method":"session.send","params":{
            "clientRequestId":uuid::Uuid::new_v4().to_string(),"sessionId":SESSION,"tabId":TAB,"text":text}})));
        assert_eq!(sent["ok"], true, "{sent}");
        sent
    };
    let seq = if local {
        rig.manager.send(SESSION, TAB, "local startup".into(), vec![]).unwrap().events[0].seq
    } else {
        let sent = crate::local_runtime::mobile::execute(&rig.manager, &lifetime, "send",
            json!({"actor":actor,"connection":"connection","sessionId":SESSION,"tabId":TAB,
                "text":"remote startup","prompt":"remote startup"})).unwrap();
        sent["events"][0]["seq"].as_u64().expect("phone send returns the logged user message")
    };
    let withdrawn = || rig.events().iter().any(|e| matches!(&e.payload, Payload::PromptWithdrawn { prompt_seq } if *prompt_seq == seq));
    if case == "phone-init-error" { wait_for("initialization failure withdraws the stash", withdrawn); }
    else { wait_for("real provider paused before opening reply", || rig._dir.path().join("opening").exists()); }
    let remote_seq = if relay {
        let sent = relay_send("queued remote");
        assert_eq!(sent["result"]["outcome"]["queued"], true, "{sent}");
        assert!(rig.manager.send(SESSION, TAB, "queued local".into(), vec![]).unwrap().queued);
        let public = serde_json::to_value(rig.manager.queued(SESSION, TAB)).unwrap();
        assert!(public.as_array().unwrap().iter().all(|message| message.get("privacy").is_none()));
        Some(sent["result"]["outcome"]["events"][0]["seq"].as_u64().expect("relay queued event"))
    } else { None };
    let editing = case.starts_with("edit-");
    if editing {
        let mode = case.contains("mode-");
        if case.starts_with("edit-local-") {
            if mode { rig.manager.set_permission_mode(SESSION, TAB, "plan").unwrap(); }
            else { rig.manager.set_model(SESSION, TAB, "remote-model").unwrap(); }
        } else {
            crate::local_runtime::mobile::execute(&rig.manager, &lifetime, if mode { "setMode" } else { "setModel" },
                json!({"actor":actor,"connection":"connection","sessionId":SESSION,"tabId":TAB,"mode":"plan","model":"remote-model"})).unwrap();
        }
        if case.contains("mixed") {
            if mode { rig.manager.set_model(SESSION, TAB, "desktop-model").unwrap(); }
            else { rig.manager.set_permission_mode(SESSION, TAB, "plan").unwrap(); }
        }
        let pending = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
        assert_eq!(pending.model, "original-model");
        assert_eq!(pending.permission_mode, "auto");
        if mode { assert_eq!(pending.requested_permission_mode.as_deref(), Some("plan")); }
        else { assert_eq!(pending.requested_model.as_deref(), Some("remote-model")); }
        if !case.starts_with("edit-local-") { assert!(!pending.request_privacy.is_empty()); }
    }
    match case.as_str() {
        "phone-revoked" => rig.manager.mobile.revoke_device(&actor, "phone").unwrap(),
        "phone-mode" => rig.manager.set_permission_mode(SESSION, TAB, "plan").unwrap(),
        "phone-interrupt" => { assert!(rig.manager.interrupt(SESSION, TAB).unwrap()); }
        "phone-interrupt-local" => {
            assert!(rig.manager.send(SESSION, TAB, "queued local".into(), vec![]).unwrap().queued);
            assert!(rig.manager.interrupt(SESSION, TAB).unwrap());
            assert!(rig.rt.lock().unwrap().turn_open, "the queued local prompt owns the opening turn");
        }
        "phone-stop" => rig.manager.stop(SESSION, TAB).unwrap(),
        _ => {}
    }
    store::write_json(&coordination.join("ready.json"), &json!({"socket":endpoint.socket,"token":endpoint.token,"root":store::root().unwrap()})).unwrap();
    wait_for("owner acknowledgement before releasing opening reply", || coordination.join("release").exists());
    std::fs::remove_file(&blocked).unwrap();
    let requests = || store::read_lines::<serde_json::Value>(&rig._dir.path().join("requests")).unwrap_or_default();
    let prompts = || requests().into_iter().filter(|v| v["method"] == "session/prompt").collect::<Vec<_>>();
    if relay {
        let expected = if case.ends_with("-off") { 3 } else { 2 };
        wait_for("queued local work completes after remote admission decision", || prompts().len() == expected && !rig.rt.lock().unwrap().turn_open);
        assert!(rig.manager.queued(SESSION, TAB).is_empty());
        let texts = prompts().iter().map(ToString::to_string).collect::<Vec<_>>().join("\n");
        assert!(texts.contains("local startup") && texts.contains("queued local"));
        assert_eq!(texts.contains("queued remote"), expected == 3);
        assert_eq!(rig.events().iter().filter(|event| matches!(event.payload, Payload::PromptWithdrawn { prompt_seq } if Some(prompt_seq) == remote_seq)).count(), usize::from(expected == 2));
        store::write_json(&store::root().unwrap().join("data-privacy.json"), &json!({"enabled":false})).unwrap();
        assert!(!crate::data_privacy::refresh().enabled);
        relay_send("fresh restored relay");
        wait_for("fresh relay ACP prompt physically delivered", || prompts().len() == expected + 1 && !rig.rt.lock().unwrap().turn_open);
        assert!(prompts().last().unwrap().to_string().contains("fresh restored relay"));
        rig.manager.stop(SESSION, TAB).unwrap();
        return;
    }
    if editing {
        wait_for("local startup survives opening setting admission", || !rig.rt.lock().unwrap().turn_open);
        let mode = case.contains("mode-");
        let applied = case.ends_with("-off") || case.starts_with("edit-local-");
        let method = if mode { "session/set_mode" } else { "session/set_model" };
        assert_eq!(requests().iter().filter(|v| v["method"] == method).count(), usize::from(applied), "{case}: {:?}", requests());
        let final_settings = Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap());
        assert_eq!(final_settings.model, if !mode && applied { "remote-model" } else if mode && case.contains("mixed") { "desktop-model" } else { "original-model" });
        assert_eq!(final_settings.permission_mode, if (mode && applied) || (!mode && case.contains("mixed")) { "plan" } else { "auto" });
        assert!(final_settings.request_privacy.is_empty());
        assert!(final_settings.requested_model.is_none());
        assert!(final_settings.requested_permission_mode.is_none());
        assert_eq!(prompts().len(), 1);
        rig.manager.stop(SESSION, TAB).unwrap();
        if !applied {
            launch();
            rig.manager.send(SESSION, TAB, "local restart".into(), vec![]).unwrap();
            wait_for("local restart delivered without the withdrawn remote setting", || prompts().len() == 2);
            wait_for("local restart completes", || !rig.rt.lock().unwrap().turn_open);
            assert_eq!(requests().iter().filter(|v| v["method"] == method).count(), 0, "expired edits must not replay at restart");
            rig.manager.stop(SESSION, TAB).unwrap();
        }
        return;
    }
    if case == "phone-interrupt-local" {
        wait_for("queued local prompt survives remote cancellation", || !prompts().is_empty());
        wait_for("queued local turn completes", || !rig.rt.lock().unwrap().turn_open);
        assert!(withdrawn());
        assert_eq!(prompts().len(), 1);
        assert!(prompts()[0].to_string().contains("queued local"));
        assert!(!prompts()[0].to_string().contains("remote startup"));
        rig.manager.stop(SESSION, TAB).unwrap();
        return;
    }
    let delivered = local || case == "phone-off";
    if delivered {
        wait_for("authorized startup prompt physically delivered", || !prompts().is_empty());
        wait_for("provider completes authorized prompt", || !rig.rt.lock().unwrap().turn_open);
        assert!(!withdrawn());
    } else {
        wait_for("expired startup prompt withdrawn", withdrawn);
        wait_for("withdrawn startup turn closed", || !rig.rt.lock().unwrap().turn_open);
        assert!(prompts().is_empty(), "no remote prompt after acknowledgement: {:?}", prompts());
        assert_eq!(rig.events().iter().filter(|e| matches!(&e.payload, Payload::PromptWithdrawn { prompt_seq } if *prompt_seq == seq)).count(), 1);
        // Recovery never revives remote input. A new local prompt is usable
        // even while privacy remains on, after interrupt, failure or Stop.
        if matches!(&rig.rt.lock().unwrap().engine, Engine::None) { launch(); }
        rig.manager.send(SESSION, TAB, "local recovery".into(), vec![]).unwrap();
        wait_for("local work survives cancelled remote startup", || !prompts().is_empty());
        wait_for("local recovery completed", || !rig.rt.lock().unwrap().turn_open);
        assert_eq!(prompts().len(), 1);
        assert!(prompts()[0].to_string().contains("local recovery"));
        assert!(!prompts()[0].to_string().contains("remote startup"));
    }
    rig.manager.stop(SESSION, TAB).unwrap();
}
