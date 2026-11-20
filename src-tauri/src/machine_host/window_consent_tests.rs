//! The macOS window owns the consent signing key and the runtime pins its verifier.
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
use ring::signature::{Ed25519KeyPair, KeyPair as _};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

const ROLE: &str = "TERMINALX_TEST_WINDOW_CONSENT_ROLE";
const APP: &str = "test.terminalx.window-consent";
const ACCOUNT: &str = "host-e2ee-key";
const KEY: [u8; 32] = [42; 32];
const CONSENT_ACCOUNT: &str = "window-consent-signing-key";
const SIGNING_SEED: [u8; 32] = [67; 32];

fn launch_key() -> String {
    let key = Ed25519KeyPair::from_seed_unchecked(&SIGNING_SEED).unwrap();
    STANDARD.encode(key.public_key())
}

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
        .env(
            crate::serve_cli::consent::WINDOW_PUBLIC_KEY_ENV,
            launch_key(),
        )
        .env_remove("TERMINALX_TEST_MANAGED_PRIVACY");
    command
}

#[test]
fn pinned_consent_key_authorizes_only_the_window_after_runtime_adoption() {
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

        let window = ready
            .exists()
            .then(|| detached_child(&root, caller).output().unwrap());
        let reopened = window
            .as_ref()
            .filter(|window| window.status.success())
            .map(|_| detached_child(&root, "window-reopened").output().unwrap());
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
        let reopened = reopened.unwrap();
        assert!(
            reopened.status.success(),
            "reopened window failed: {}\n{}",
            String::from_utf8_lossy(&reopened.stdout),
            String::from_utf8_lossy(&reopened.stderr)
        );
    }
}

fn detached_child(root: &Path, role: &str) -> Command {
    let mut command = child(root, role);
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    command.stdin(Stdio::null());
    command
}

#[test]
fn process_fixture() {
    match std::env::var(ROLE).as_deref() {
        Ok(role @ ("runtime" | "runtime-restarted" | "runtime-relaunched")) => runtime(role),
        Ok(role @ ("window" | "window-restarted" | "window-reopened")) => window(role),
        Ok("window-adopts") => window_adopts(),
        Ok("untrusted") => untrusted(),
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

fn detached_desktop(root: &Path) -> (Arc<Client>, Arc<Desktop>) {
    // SAFETY: getsid/getpid only query the calling process.
    assert_eq!(unsafe { libc::getsid(0) }, unsafe { libc::getpid() });
    assert!(
        crate::serve_cli::consent::controlling_terminal(std::process::id() as libc::pid_t)
            .is_none()
    );
    let client = Client::connect(root).unwrap();
    let desktop = Arc::new(
        Desktop::connect(
            client.clone(),
            Arc::new(crate::sink::BroadcastSink::new(16)),
        )
        .unwrap(),
    );
    (client, desktop)
}

fn assert_person_required(result: Result<Value>, case: &str) {
    let error = result.expect_err(case);
    let refusal = error
        .downcast_ref::<Refused>()
        .unwrap_or_else(|| panic!("{case}: {error:#}"));
    assert_eq!(refusal.code, "person_required", "{case}: {refusal}");
    assert!(
        refusal.message.contains("not the TerminalX window"),
        "{case}: {refusal}"
    );
}

fn untrusted() {
    let root = crate::store::root().unwrap();
    let (_, desktop) = detached_desktop(&root);
    let request_id = std::env::var("TERMINALX_TEST_CONSENT_REQUEST_ID").unwrap();
    for (command, params) in [
        (wire::CREATE_CODE, json!({})),
        (wire::APPROVE, json!({"requestId": request_id})),
    ] {
        assert_person_required(
            desktop.machine_host(command, params),
            "detached caller without the signing key",
        );
    }
}

fn window(role: &str) {
    let root = crate::store::root().unwrap();
    let (client, desktop) = detached_desktop(&root);
    let call = |command, params| desktop.machine_host(command, params);
    let secrets = MemorySecrets::default();
    let service = format!("{APP}.pairing");
    secrets.set(&service, ACCOUNT, &KEY).unwrap();
    let manager =
        crate::pairing::PairingManager::with_secrets_for_test(APP, Arc::new(secrets.clone()));

    secrets
        .set(&service, CONSENT_ACCOUNT, &SIGNING_SEED)
        .unwrap();
    crate::install_window_pairing_consent(&manager);
    assert_eq!(
        crate::serve_cli::consent::launch_public_key()
            .unwrap()
            .as_deref(),
        Some(launch_key().as_str())
    );
    let before = desktop.machine_host_status().unwrap().unwrap();
    let expected = if role == "window" {
        HostKeyState::Needed
    } else {
        HostKeyState::Ready
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
    if role == "window-reopened" {
        return;
    }
    assert_eq!(
        code.public_key_b64,
        manager.host_key(false).unwrap().public_key_b64()
    );
    let pending: Value = client
        .quick("fixture.ask", json!({ "token": code.device_token }))
        .unwrap();
    let answer = json!({ "requestId": pending["requestId"] });

    let untrusted = detached_child(&root, "untrusted")
        .env(
            "TERMINALX_TEST_CONSENT_REQUEST_ID",
            pending["requestId"].as_str().unwrap(),
        )
        .output()
        .unwrap();
    assert!(
        untrusted.status.success(),
        "detached fixture failed: {}\n{}",
        String::from_utf8_lossy(&untrusted.stdout),
        String::from_utf8_lossy(&untrusted.stderr)
    );

    // Even possession of the adopted host key cannot prove window identity.
    secrets.set(&service, CONSENT_ACCOUNT, &KEY).unwrap();
    assert_person_required(call(wire::CREATE_CODE, json!({})), "different signing key");
    assert_person_required(
        call(wire::APPROVE, answer.clone()),
        "different signing key for a real pending request",
    );

    secrets
        .set(&service, CONSENT_ACCOUNT, &SIGNING_SEED)
        .unwrap();
    let approved = call(wire::APPROVE, answer).unwrap();
    assert_eq!(approved["approved"], true);
    let status = call(wire::STATUS, json!({})).unwrap();
    assert!(status["pending"].is_null());
    assert_eq!(status["computers"][0]["label"], "Synthetic computer");
}

/// How the runtime the window adopts was launched, and what its Keychain
/// holds (PRO-486).
const CASE: &str = "TERMINALX_TEST_WINDOW_CONSENT_CASE";
/// Another build's consent key: another bundle identifier keeps another.
const OTHER_SEED: [u8; 32] = [91; 32];

/// The ways into a runtime that cannot verify its window, as a case name,
/// how the adopted runtime was launched (its pinned key, if any), and whether
/// this window's Keychain holds its consent key:
/// - launched by a build from before the key, and the item never saved (the
///   owner's Mac mini on 2026-11-20, TerminalX 0.2.37);
/// - launched while the Keychain write failed, the item saved later, or
///   replaced by an unpinned runtime while the app stays open;
/// - launched by a build with another bundle identifier, with its own key;
/// - launched with this key, and the item removed by hand since.
const ADOPTIONS: [(&str, Option<[u8; 32]>, bool); 4] = [
    ("unpinned, no item", None, false),
    ("unpinned, item", None, true),
    ("another build's key", Some(OTHER_SEED), true),
    ("item removed by hand", Some(SIGNING_SEED), false),
];

#[test]
fn an_adopted_runtime_that_cannot_verify_the_window_is_relaunched_by_it() {
    for (case, pinned, _) in ADOPTIONS {
        let home = tempfile::Builder::new().prefix("wr").tempdir_in("/tmp").unwrap();
        let root = home.path().canonicalize().unwrap();
        // The runtime an earlier app left running, which this window adopts.
        let mut adopted = child(&root, "runtime");
        match pinned {
            Some(seed) => adopted.env(
                crate::serve_cli::consent::WINDOW_PUBLIC_KEY_ENV,
                STANDARD.encode(Ed25519KeyPair::from_seed_unchecked(&seed).unwrap().public_key()),
            ),
            None => adopted.env_remove(crate::serve_cli::consent::WINDOW_PUBLIC_KEY_ENV),
        };
        let mut adopted = adopted.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !root.join("runtime").exists() && adopted.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(root.join("runtime").exists(), "{case}: the adopted runtime did not start");

        let mut window = detached_child(&root, "window-adopts").env(CASE, case).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        // The window stops the adopted runtime, as the app stops one with
        // nothing under way; here the test does, on the window's word.
        let deadline = Instant::now() + Duration::from_secs(60);
        while !root.join("stop-adopted").exists() && window.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(adopted.stdin.take());
        let adopted = adopted.wait_with_output().unwrap();
        let window = window.wait_with_output().unwrap();
        assert!(
            window.status.success(),
            "{case}: window failed: {}\n{}\nadopted runtime: {}\n{}",
            String::from_utf8_lossy(&window.stdout),
            String::from_utf8_lossy(&window.stderr),
            String::from_utf8_lossy(&adopted.stdout),
            String::from_utf8_lossy(&adopted.stderr)
        );
    }
}

/// The window that adopted the runtime: the issue's failure, then the
/// repair, as `window_consent::install_for` installs it in the app.
fn window_adopts() {
    let case = std::env::var(CASE).unwrap();
    let (_, _, holds_item) = ADOPTIONS.iter().find(|(name, _, _)| *name == case).copied().unwrap();
    let root = crate::store::root().unwrap();
    let (_, desktop) = detached_desktop(&root);
    let secrets = MemorySecrets::default();
    let service = format!("{APP}.pairing");
    secrets.set(&service, ACCOUNT, &KEY).unwrap();
    if holds_item {
        secrets.set(&service, CONSENT_ACCOUNT, &SIGNING_SEED).unwrap();
    }
    let manager = crate::pairing::PairingManager::with_secrets_for_test(APP, Arc::new(secrets.clone()));
    crate::install_window_pairing_consent(&manager);
    manager.reconcile_machine(&desktop);

    // As reported: every guarded command fails, with no repair installed.
    let error = desktop.machine_host(wire::CREATE_CODE, json!({})).unwrap_err();
    assert!(crate::local_runtime::window_consent::unverifiable(&error), "{case}: {error:#}");
    if !holds_item {
        assert!(error.to_string().contains("missing from Keychain"), "{case}: {error:#}");
    }

    static FRESH: Mutex<Option<(std::process::Child, Arc<Desktop>)>> = Mutex::new(None);
    let relaunches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (counted, window_root, keys) = (relaunches.clone(), root.clone(), manager.clone());
    crate::local_runtime::window_consent::install(Box::new(move |stale| {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(stale.epoch(), desktop_epoch(&window_root), "the adopted runtime is the one replaced");
        std::fs::write(window_root.join("stop-adopted"), b"").unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while std::os::unix::net::UnixStream::connect(window_root.join("run/hooks.sock")).is_ok() {
            assert!(Instant::now() < deadline, "the adopted runtime did not stop");
            std::thread::sleep(Duration::from_millis(20));
        }
        // As `local_runtime::launch` does: the window's key, created if
        // absent, pinned in the fresh runtime's environment.
        let key = crate::serve_cli::consent::launch_public_key()?.expect("the window provisions its key");
        let mut command = child(&window_root, "runtime-relaunched");
        command.env(crate::serve_cli::consent::WINDOW_PUBLIC_KEY_ENV, key).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        // SAFETY: setsid is async-signal-safe.
        unsafe {
            command.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
        }
        let runtime = command.spawn()?;
        let deadline = Instant::now() + Duration::from_secs(30);
        while !window_root.join("runtime-relaunched").exists() {
            assert!(Instant::now() < deadline, "the fresh runtime did not start");
            std::thread::sleep(Duration::from_millis(20));
        }
        let (_, fresh) = detached_desktop(&window_root);
        keys.reconcile_machine(&fresh);
        *FRESH.lock().unwrap() = Some((runtime, fresh.clone()));
        Ok(fresh)
    }));

    let created = desktop.machine_host(wire::CREATE_CODE, json!({})).unwrap_or_else(|error| panic!("{case}: {error:#}"));
    let code = wire::MachineCode::decode(created["code"].as_str().unwrap()).unwrap();
    assert_eq!(code.public_key_b64, manager.host_key(false).unwrap().public_key_b64());
    assert_eq!(relaunches.load(std::sync::atomic::Ordering::SeqCst), 1, "{case}");
    if !holds_item {
        assert!(secrets.stored(&service, CONSENT_ACCOUNT).is_some(), "{case}: the fresh launch saved a key");
    }
    let (mut runtime, fresh) = FRESH.lock().unwrap().take().unwrap();
    // The fresh runtime verifies this window with no further restart.
    fresh.machine_host(wire::CREATE_CODE, json!({})).unwrap();
    assert_eq!(relaunches.load(std::sync::atomic::Ordering::SeqCst), 1, "{case}");
    drop(runtime.stdin.take());
    assert!(runtime.wait().unwrap().success(), "{case}: the fresh runtime failed");
}

fn desktop_epoch(root: &Path) -> String {
    Client::connect(root).unwrap().epoch().to_owned()
}
