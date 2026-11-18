//! The macOS window and runtime keep separate copies of the pairing key.
//! Child processes isolate the two OnceLocks and let the kernel identify the
//! window's witness as a caller outside the runtime's process tree.
use super::*;
use crate::control::{ControlResponse, ControlService};
use crate::keychain::{testing::MemorySecrets, SecretStore};
use crate::local_runtime::{
    client::{Client, Refused},
    desktop::Desktop,
    Lifetime,
};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

const ROLE: &str = "TERMINALX_TEST_WINDOW_CONSENT_ROLE";
const APP: &str = "test.terminalx.window-consent";
const ACCOUNT: &str = "host-e2ee-key";
const KEY: [u8; 32] = [42; 32];
const OTHER_KEY: [u8; 32] = [73; 32];

fn child(root: &Path, role: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "machine_host::window_consent_tests::process_fixture",
            "--nocapture",
        ])
        .env(ROLE, role)
        .env("TERMINALX_HOME", root)
        .env("TERMINALX_LOCAL_DESKTOP", "1")
        .env("TERMINALX_LOCAL_APPLICATION", APP)
        .env_remove("TERMINALX_TEST_MANAGED_PRIVACY");
    command
}

#[test]
fn installed_pairing_key_authorizes_the_window_after_runtime_adoption() {
    // The control and witness sockets need a short path on macOS.
    let home = tempfile::Builder::new()
        .prefix("wc")
        .tempdir_in("/tmp")
        .unwrap();
    let root = home.path().canonicalize().unwrap();
    for (launch, caller) in [
        ("runtime", "window"),
        ("runtime-restarted", "window-restarted"),
    ] {
        let ready = root.join(launch);
        let mut runtime = child(&root, launch)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ready.exists() && runtime.try_wait().unwrap().is_none() && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
        }

        let window = ready.exists().then(|| {
            let mut command = child(&root, caller);
            // SAFETY: setsid is async-signal-safe. The window is a sibling
            // of the runtime, in its own session with no controlling terminal.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            command.stdin(Stdio::null()).output().unwrap()
        });
        // EOF lets the runtime drop its listener before the next launch.
        drop(runtime.stdin.take());
        if window.is_none() {
            let _ = runtime.kill();
        }
        let runtime = runtime.wait_with_output().unwrap();
        assert!(
            runtime.status.success() && window.is_some(),
            "runtime {launch} failed: {}\n{}",
            String::from_utf8_lossy(&runtime.stdout),
            String::from_utf8_lossy(&runtime.stderr)
        );
        let window = window.unwrap();
        assert!(
            window.status.success(),
            "window failed: {}\n{}",
            String::from_utf8_lossy(&window.stdout),
            String::from_utf8_lossy(&window.stderr)
        );
    }
}

#[test]
fn process_fixture() {
    match std::env::var(ROLE).as_deref() {
        Ok(role @ ("runtime" | "runtime-restarted")) => runtime(role),
        Ok(role @ ("window" | "window-restarted")) => window(role == "window-restarted"),
        _ => {}
    }
}

fn runtime(role: &str) {
    let executor = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let root = crate::store::root().unwrap();
    let endpoint = crate::hooks::prepare_control().unwrap();
    let lifetime = Lifetime::new(Duration::from_secs(60));
    let sink = Arc::new(crate::sink::BroadcastSink::new(16));
    let terminals = Arc::new(crate::pty::Terminals::new());
    {
        let _runtime = executor.enter();
        let stream = crate::local_runtime::stream::start(
            &endpoint,
            sink.clone(),
            terminals.clone(),
            lifetime.clone(),
        )
        .unwrap();
        lifetime.set_stream_socket(stream);
    }
    let sessions = crate::session::SessionManager::new(
        sink.clone(),
        Arc::new(crate::sink::NoObserver),
        Arc::new(crate::harness::host::Host::new()),
        terminals,
        Arc::new(Default::default()),
        Arc::new(Default::default()),
        endpoint.clone(),
    );
    let service =
        ControlService::headless(sink.clone(), sessions, endpoint.clone(), "local".into())
            .with_local_lifetime(lifetime.clone());
    let secrets = MemorySecrets::default();
    let key_service = format!("{APP}.machine-host");
    // Persist only the synthetic fake-store contents across process exits.
    let saved = root.join("synthetic-runtime-key");
    if role == "runtime-restarted" {
        secrets
            .set(&key_service, ACCOUNT, &std::fs::read(&saved).unwrap())
            .unwrap();
    }
    let keys = key::KeyStore::for_runtime(&root).with_secrets_for_test(Arc::new(secrets.clone()));
    assert!(
        keys.needs_window(),
        "the runtime must adopt the window's key"
    );
    let host = MachineHost::new(
        root.clone(),
        keys,
        sink,
        Rpc::Awaiting,
        Some(lifetime),
        0,
        false,
    );
    assert!(INSTALLED.set(host.clone()).is_ok());
    {
        let mut state = host.state.lock().unwrap();
        state.enabled = true;
        // Only the endpoint used to format the code is needed. The
        // synthetic computer enters below without a TCP listener.
        let _runtime = executor.enter();
        state.listening = Some(direct::Listening::for_window_consent_test());
    }
    let loaded = host.load_key().unwrap();
    assert_eq!(loaded.is_some(), role == "runtime-restarted");

    let runtime_host = host.clone();
    let (_socket, _publisher) = crate::hooks::serve(
        endpoint,
        |_| crate::hooks::HookReply::refused("test runtime"),
        move |request| {
            // Put a synthetic computer in the real pairing state machine.
            // No external computer, relay or account participates.
            if request.command == "fixture.ask" {
                let token = request.params["token"].as_str().unwrap();
                let pairing::Decision::Wait { request_id, .. } =
                    runtime_host.ask(pairing::Asking {
                        token_hash: registry::token_hash(token),
                        client_key_b64: &pairing_tests::public_b64([13; 32]),
                        label: "Synthetic computer".into(),
                        platform: None,
                        fingerprint: "fixture fingerprint".into(),
                        transport: "lan",
                    })
                else {
                    panic!("the synthetic computer must wait for consent");
                };
                return ControlResponse::success(request.id, json!({ "requestId": request_id }));
            }
            let adopted = request.command == wire::ADOPT_KEY;
            let response = service.handle(request);
            if adopted && response.ok {
                let retained = secrets
                    .stored(&key_service, ACCOUNT)
                    .expect("adoption persists the key");
                assert_eq!(retained, KEY);
                std::fs::write(&saved, retained).unwrap();
            }
            response
        },
    )
    .unwrap();
    std::fs::write(root.join(role), b"ready").unwrap();
    std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
    host.stop_for_test();
}

fn window(restarted: bool) {
    // SAFETY: getsid/getpid only query the calling process.
    assert_eq!(unsafe { libc::getsid(0) }, unsafe { libc::getpid() });
    assert!(
        crate::serve_cli::consent::controlling_terminal(std::process::id() as libc::pid_t)
            .is_none()
    );
    let client = Client::connect(&crate::store::root().unwrap()).unwrap();
    let desktop = Arc::new(
        Desktop::connect(
            client.clone(),
            Arc::new(crate::sink::BroadcastSink::new(16)),
        )
        .unwrap(),
    );
    let call = |command, params| desktop.machine_host(command, params);
    let refused = |command, params, case| {
        let error = call(command, params).expect_err(case);
        let refusal = error
            .downcast_ref::<Refused>()
            .unwrap_or_else(|| panic!("{case}: {error:#}"));
        assert_eq!(refusal.code, "person_required", "{case}: {refusal}");
        assert!(
            refusal.message.contains("not the TerminalX window"),
            "{case}: {refusal}"
        );
    };
    let secrets = MemorySecrets::default();
    let service = format!("{APP}.pairing");
    secrets.set(&service, ACCOUNT, &KEY).unwrap();
    let manager =
        crate::pairing::PairingManager::with_secrets_for_test(APP, Arc::new(secrets.clone()));

    for (command, params) in [
        (wire::CREATE_CODE, json!({})),
        (wire::APPROVE, json!({"requestId": "unused"})),
    ] {
        refused(
            command,
            params,
            "detached caller with no installed proof provider",
        );
    }
    crate::install_window_pairing_consent(&manager);
    if !restarted {
        for (command, params) in [
            (wire::CREATE_CODE, json!({})),
            (wire::APPROVE, json!({"requestId": "unused"})),
        ] {
            refused(command, params, "window key before runtime adoption");
        }
    }
    let before = desktop.machine_host_status().unwrap().unwrap();
    let expected = if restarted {
        HostKeyState::Ready
    } else {
        HostKeyState::Needed
    };
    assert_eq!(before.host_key, expected);
    manager.reconcile_machine(&desktop);
    let after = desktop.machine_host_status().unwrap().unwrap();
    assert_eq!(
        after.host_key,
        HostKeyState::Ready,
        "the window supplies the key when the runtime needs it"
    );

    let created = call(wire::CREATE_CODE, json!({})).unwrap();
    let code = wire::MachineCode::decode(created["code"].as_str().unwrap()).unwrap();
    assert_eq!(
        code.public_key_b64,
        manager.host_key(false).unwrap().public_key_b64()
    );
    let pending: Value = client
        .quick("fixture.ask", json!({ "token": code.device_token }))
        .unwrap();
    let answer = json!({ "requestId": pending["requestId"] });

    // The installed provider reads the current key on each request. Changing
    // the window's store cannot replace an already-adopted runtime identity.
    secrets.set(&service, ACCOUNT, &OTHER_KEY).unwrap();
    // Force a replacement attempt even though reconciliation sees Ready.
    let error = call(
        wire::ADOPT_KEY,
        json!({ "secretB64": STANDARD.encode(OTHER_KEY) }),
    )
    .unwrap_err();
    assert_eq!(error.downcast_ref::<Refused>().unwrap().code, "key_refused");
    refused(wire::CREATE_CODE, json!({}), "different window key");
    refused(
        wire::APPROVE,
        answer.clone(),
        "different window key for a real pending request",
    );

    secrets.set(&service, ACCOUNT, &KEY).unwrap();
    let approved = call(wire::APPROVE, answer).unwrap();
    assert_eq!(approved["approved"], true);
    let status = call(wire::STATUS, json!({})).unwrap();
    assert!(status["pending"].is_null());
    assert_eq!(status["computers"][0]["label"], "Synthetic computer");
}
