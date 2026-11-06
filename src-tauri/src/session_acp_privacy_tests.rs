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
        if (base / 'fail-init').exists():
            (base / 'fail-init').unlink()
            print(json.dumps({'jsonrpc':'2.0','id':value['id'],'error':{'code':-32000,'message':'Initialization refused'}}), flush=True)
            continue
        result = {'protocolVersion':1,'agentCapabilities':{'loadSession':True}}
        if (base / 'needs-auth').exists():
            result['authMethods'] = [{'id':'fixture'}]
    elif method == 'authenticate':
        result = {}
    elif method in ('session/new', 'session/load'):
        if method == 'session/load' and (base / 'fail-load').exists():
            (base / 'fail-load').unlink()
            print(json.dumps({'jsonrpc':'2.0','id':value['id'],'error':{'code':-32000,'message':'Session missing'}}), flush=True)
            continue
        (base / 'opening').touch()
        while (base / 'block-open').exists():
            time.sleep(0.005)
        result = {'sessionId':'owned-session','models':{'currentModelId':'original-model'}}
    elif method == 'session/prompt':
        result = {'stopReason':'end_turn'}
    elif method in ('session/set_model', 'session/set_mode'):
        result = {}
    else:
        continue
    print(json.dumps({'jsonrpc':'2.0','id':value['id'],'result':result}), flush=True)
"#;

#[test]
fn phone_startup_prompt_requires_privacy_and_sender_authority_at_real_acp_write() {
    for case in ["phone-on", "phone-cycle", "phone-off", "phone-revoked", "phone-mode", "phone-interrupt", "phone-stop", "phone-init-error", "local-on", "phone-load-cycle", "phone-load-fallback-cycle", "phone-auth-cycle", "phone-interrupt-local"] {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("child.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let mut child = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::watch_tests::prompts::privacy::acp_lifecycle::startup_child", "--nocapture"])
            .env(CASE, case).env(DIRECTORY, dir.path())
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap());
        let ready = dir.path().join("ready.json");
        wait_for("phone input waiting for ACP session opening", || ready.exists());
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
    let blocked = rig._dir.path().join("block-open");
    std::fs::write(&blocked, b"").unwrap();
    if case.contains("fallback") { std::fs::write(rig._dir.path().join("fail-load"), b"").unwrap(); }
    if case.contains("auth") { std::fs::write(rig._dir.path().join("needs-auth"), b"").unwrap(); }
    if case == "phone-init-error" { std::fs::write(rig._dir.path().join("fail-init"), b"").unwrap(); }
    let launch = || {
        let tab = index::get(SESSION).unwrap().tab(TAB).unwrap().clone();
        rig.manager.start_acp(&mut rig.rt.lock().unwrap(), &rig.rt, &tab, rig._dir.path().to_str().unwrap(), program.to_str().unwrap()).unwrap();
    };
    launch();
    let local = case == "local-on";
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
