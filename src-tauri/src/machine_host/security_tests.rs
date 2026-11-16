//! The boundaries of operating another computer (PRO-357, docs/MACHINES.md
//! "Trust model"), each held by a test over a real socket where one exists:
//!
//! - An operating computer cannot pair others, change the operate switch,
//!   reach the built-in browser or computer use, or read outside the
//!   machine's projects.
//! - An agent running on the machine cannot approve a pairing, make a
//!   pairing code or let a disconnected computer back.
//! - An agent on the operating computer cannot add a machine without the
//!   person at the machine, and no TerminalX command adds or removes one.
//! - Credentials rotate on every connection and expire after 90 days unused;
//!   Disconnect holds a computer off; the activity log records it all.
//! - Data privacy mode opens no listener and makes no machine connection.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::activity::Kind;
use super::pairing_tests::{ask, eventually, local, paired, public_b64, rig, Answer, Asked, Rig};
use super::registry::{token_hash, PairedComputer, UNUSED_EXPIRY_MS};
use super::MachineHost;
use crate::machine_wire as wire;
use crate::relay_e2ee::HostKeypair;
use crate::remote::server::WorkspaceRpc;

const TTL: i64 = wire::APPROVAL_TTL_MS;

fn hello(want: &[&str]) -> Value {
    json!({ "protocol": "terminalx-workspace-rpc/1", "want": want, "client": { "app": "terminalx-desktop" } })
}

/// A paired computer `id`, connected and past `rpc.hello` with `want`.
async fn connected(rig: &Rig, id: &str, secret: [u8; 32], token: &str, want: &[&str]) -> Asked {
    paired(rig, id, secret, token);
    let mut computer = ask(rig, secret, token).await;
    assert_eq!(computer.answer(Duration::from_secs(5)).await, Answer::In);
    let hello = computer.call("hello", "rpc.hello", hello(want)).await;
    assert_eq!(hello["ok"], true, "{hello}");
    computer
}

/// The activity log once it holds every kind in `wanted`.
async fn logged(rig: &Rig, wanted: &[Kind]) -> Vec<super::activity::Entry> {
    eventually(&format!("the activity log notes {wanted:?}"), || {
        let entries = rig.host.activity().recent().unwrap();
        wanted.iter().all(|kind| entries.iter().any(|entry| entry.kind == *kind)).then_some(entries)
    })
    .await
}

fn error_code(answer: &Value) -> &str {
    answer["error"]["code"].as_str().unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_operating_computer_cannot_change_the_switch_or_reach_this_machines_own_controls() {
    for method in crate::remote::protocol::METHODS {
        for prefix in ["settings.", "runtime.machineHost", "machines.", "pairing.", "browser.", "computer.", "dictation.", "vm.", "runs."] {
            assert!(!method.name.starts_with(prefix), "{} is served to paired computers", method.name);
        }
    }
    let rig = rig(TTL);
    let mut computer = connected(&rig, "desk", [1; 32], "desk-token-0000000000000000", &["machine/1", "machine/4", "session/1"]).await;
    let asked = [
        "settings.set",
        "machines.setAllowOperating",
        "machine.allowOperating",
        "runtime.machineHost.approve",
        "runtime.machineHost.createCode",
        "runtime.machineHost.letBack",
        "runtime.machineHost.revoke",
        "runtime.machineHost.disconnect",
        "browser.open",
        "computer.click",
        "dictation.start",
        "vm.start",
        "runs.start",
    ];
    for (n, method) in asked.iter().enumerate() {
        let answer = computer.call(&format!("m{n}"), method, json!({ "enabled": true, "requestId": "x", "id": "desk" })).await;
        assert_eq!(error_code(&answer), "method_not_found", "{method}: {answer}");
    }
    let status = rig.host.status();
    assert!(status.code.is_none() && status.pending.is_none(), "nothing was paired or asked");
    assert!(status.computers.iter().all(|computer| computer.disconnected_at.is_none()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_operating_computer_reads_only_inside_the_machines_projects() {
    let rig = rig(TTL);
    let project_dir = tempfile::tempdir().unwrap();
    std::fs::write(project_dir.path().join("inside.txt"), "inside").unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
    let project = crate::store::projects::ensure_folder(project_dir.path().to_str().unwrap()).unwrap();
    let project_id = crate::remote::machine::project_id(&project.path);
    let mut computer = connected(&rig, "desk", [2; 32], "desk-token-0000000000000000", &["machine/1", "fs/1", "session/1"]).await;

    let inside = computer.call("in", "fs.read", json!({ "projectId": project_id, "path": "inside.txt" })).await;
    assert_eq!(inside["ok"], true, "a project's file is served: {inside}");
    let settings = crate::store::root().unwrap().join("settings.json");
    let forbidden = [
        "../secret.txt".to_string(),
        outside.path().join("secret.txt").display().to_string(),
        "/etc/hosts".to_string(),
        settings.display().to_string(),
        rig.host.registry().path().display().to_string(),
    ];
    for (n, path) in forbidden.iter().enumerate() {
        let answer = computer.call(&format!("out{n}"), "fs.read", json!({ "projectId": project_id, "path": path })).await;
        assert_eq!(error_code(&answer), "path_forbidden", "{path}: {answer}");
    }
    let unnamed = computer.call("unnamed", "fs.read", json!({ "path": "inside.txt" })).await;
    assert_eq!(error_code(&unnamed), "invalid_params", "a project call names its project: {unnamed}");
    let unknown = computer.call("unknown", "fs.read", json!({ "projectId": "not-a-project0000", "path": "inside.txt" })).await;
    assert_eq!(error_code(&unknown), "not_found", "{unknown}");
}

/// An agent on the machine has a shell and the `terminalx` CLI. Without the
/// window's attachment, nothing it sends to the runtime pairs, approves,
/// revokes, disconnects or lets back; and making a code, Allow and letting a
/// computer back need a person's witness besides (`serve_cli::consent`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_on_the_machine_cannot_approve_pair_or_let_a_computer_back() {
    let rig = rig(TTL);
    paired(&rig, "desk", [3; 32], "desk-token-0000000000000000");
    rig.host.disconnect("desk").unwrap();
    let guess = |extra: Value| {
        let mut params = json!({ "epoch": "guessed", "lease": "guessed" });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        params
    };
    let commands = [
        (wire::CREATE_CODE, guess(json!({}))),
        (wire::APPROVE, guess(json!({ "requestId": "any" }))),
        (wire::DECLINE, guess(json!({ "requestId": "any" }))),
        (wire::REVOKE, guess(json!({ "id": "desk" }))),
        (wire::DISCONNECT, guess(json!({ "id": "desk" }))),
        (wire::LET_BACK, guess(json!({ "id": "desk" }))),
        (wire::ADOPT_KEY, guess(json!({ "secretB64": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }))),
    ];
    for (command, params) in commands {
        let refused = rig.host.execute(command, params).unwrap_err();
        // `unsupported` here (no window ever attached); a desktop runtime says `attachment_expired`.
        assert!(matches!(refused.code.as_str(), "unsupported" | "attachment_expired"), "{command}: {}", refused.code);
    }
    let computers = rig.host.registry().list().unwrap();
    assert_eq!(computers.len(), 1, "not revoked");
    assert!(computers[0].disconnected_at.is_some(), "still held off");
    assert!(rig.host.status().code.is_none(), "no code was made");

    // Read-only commands need nothing.
    assert!(rig.host.execute(wire::STATUS, json!({})).is_ok());
    assert!(rig.host.execute(wire::ACTIVITY, json!({})).is_ok());

    #[cfg(unix)]
    {
        use crate::serve_cli::consent;
        for command in [wire::CREATE_CODE, wire::APPROVE, wire::LET_BACK] {
            assert!(consent::guards(command), "{command} needs a person");
        }
        let run = tempfile::tempdir().unwrap();
        let unsigned = consent::verify(run.path(), &mut json!({ "requestId": "any" })).unwrap_err();
        assert_eq!(unsigned.code, "person_required", "a request that does not say who sent it");
        let nobody = consent::verify(run.path(), &mut json!({ "consent": { "socket": run.path().join("nobody.sock"), "nonce": "n" } })).unwrap_err();
        assert_eq!(nobody.code, "person_required", "a witness that is not there");
    }
}

/// A pairing code reaching an agent on the operating computer pairs nothing
/// by itself: the machine waits for its person, and no answer is "Don't allow".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_code_alone_adds_no_machine_without_allow_on_the_machine() {
    let rig = rig(600);
    let code = local(&rig.host.create_code(None).unwrap().code, rig.port);
    let mut asking = ask(&rig, [4; 32], &code.device_token).await;
    assert_eq!(asking.answer(Duration::from_millis(300)).await, Answer::Silent, "it waits for the person at the machine");
    assert_eq!(asking.answer(Duration::from_secs(5)).await, Answer::Refused(wire::REFUSED_NOT_APPROVED.into()));
    assert!(rig.host.registry().list().unwrap().is_empty(), "nothing was paired");
    assert!(!rig.host.activity().recent().unwrap().iter().any(|entry| entry.kind == Kind::Paired));
}

/// On the operating computer, machines are added and removed only from the
/// app's own windows (Tauri commands). The `terminalx` CLI an agent can run
/// has no command for either.
#[test]
fn no_terminalx_command_adds_or_removes_a_machine() {
    let control = include_str!("../control.rs");
    assert!(!control.contains("\"machines."), "src/control.rs serves a machines.* command");
    for command in ["pair", "remove", "forget", "add"] {
        assert!(!control.contains(&format!("\"machine.{command}")), "src/control.rs serves machine.{command}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_credential_rotates_on_each_connection() {
    let rig = rig(TTL);
    let old = "desk-token-old-000000000000000";
    let mut computer = connected(&rig, "desk", [5; 32], old, &["machine/1", "machine/4"]).await;
    let rotated = computer.call("rotate", "machine.rotateCredential", json!({})).await;
    let new = rotated["result"]["deviceToken"].as_str().unwrap_or_else(|| panic!("a fresh token: {rotated}")).to_string();
    assert_ne!(new, old);
    let file = std::fs::read_to_string(rig.host.registry().path()).unwrap();
    assert!(!file.contains(&new) && file.contains(&base64::Engine::encode(&base64::engine::general_purpose::STANDARD, token_hash(&new))), "only its hash is kept");

    let mut again = ask(&rig, [5; 32], &new).await;
    assert_eq!(again.answer(Duration::from_secs(5)).await, Answer::In, "the fresh token is taken");
    let mut stale = ask(&rig, [5; 32], old).await;
    assert_eq!(stale.answer(Duration::from_secs(5)).await, Answer::Refused(wire::REFUSED_CODE_INACTIVE.into()), "the old one stopped working once the new one was used");
    let mut stolen = ask(&rig, [9; 32], &new).await;
    assert!(matches!(stolen.answer(Duration::from_secs(5)).await, Answer::Closed(Some(4401))), "the fresh token is still bound to the computer's key");

    // The answer was lost: the computer comes back with the token it has,
    // and the one it never kept stops working.
    let lost = again.call("rotate", "machine.rotateCredential", json!({})).await;
    let lost = lost["result"]["deviceToken"].as_str().unwrap().to_string();
    let mut kept = ask(&rig, [5; 32], &new).await;
    assert_eq!(kept.answer(Duration::from_secs(5)).await, Answer::In, "a lost answer locks nothing out");
    let mut unused = ask(&rig, [5; 32], &lost).await;
    assert_eq!(unused.answer(Duration::from_secs(5)).await, Answer::Refused(wire::REFUSED_CODE_INACTIVE.into()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_credential_unused_for_ninety_days_expires() {
    let rig = rig(TTL);
    let now = chrono::Utc::now().timestamp_millis();
    rig.host
        .registry()
        .put(PairedComputer {
            id: "old".into(),
            token_hash: token_hash("old-token-00000000000000000000"),
            label: "Old MacBook".into(),
            platform: Some("macos".into()),
            client_public_key_b64: Some(public_b64([6; 32])),
            fingerprint: None,
            approved_at: now - UNUSED_EXPIRY_MS - 120_000,
            last_seen_at: Some(now - UNUSED_EXPIRY_MS - 60_000),
            relay_device_id: None,
            next_token_hash: None,
            disconnected_at: None,
            other: Default::default(),
        })
        .unwrap();
    let mut computer = ask(&rig, [6; 32], "old-token-00000000000000000000").await;
    assert_eq!(computer.answer(Duration::from_secs(5)).await, Answer::Refused(wire::REFUSED_CODE_INACTIVE.into()), "\"Access removed\"");
    assert!(rig.host.registry().list().unwrap().is_empty(), "the record is gone");
    let entries = logged(&rig, &[Kind::Expired]).await;
    assert_eq!(entries[0].computer.as_deref(), Some("Old MacBook"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disconnect_closes_the_connection_and_holds_the_computer_off_until_it_is_let_back() {
    let rig = rig(TTL);
    let token = "desk-token-0000000000000000";
    let mut computer = connected(&rig, "desk", [7; 32], token, &["machine/1"]).await;
    eventually("connected", || rig.host.status().computers.first().is_some_and(|computer| computer.connected && computer.route == Some(wire::ComputerRoute::Lan)).then_some(())).await;
    assert!(rig.host.disconnect("desk").unwrap());
    assert!(computer.closed_within(Duration::from_secs(2)).await, "closed at once");
    let status = rig.host.status();
    assert!(status.computers[0].disconnected_at.is_some() && !status.computers[0].connected);

    let mut back = ask(&rig, [7; 32], token).await;
    assert_eq!(back.answer(Duration::from_secs(5)).await, Answer::Refused(wire::REFUSED_DISCONNECTED.into()), "held off, with the reason");
    assert_eq!(rig.host.registry().list().unwrap().len(), 1, "its credential is kept");

    assert!(rig.host.let_back("desk").unwrap());
    let mut again = ask(&rig, [7; 32], token).await;
    assert_eq!(again.answer(Duration::from_secs(5)).await, Answer::In);
    logged(&rig, &[Kind::Connected, Kind::Held, Kind::LetBack]).await;
}

/// The log names the computer and the time, survives a restart (it is a
/// file a new runtime reads), and never holds a token.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_activity_log_records_what_a_computer_did_and_nothing_secret() {
    let rig = rig(TTL);
    let token = "desk-token-0000000000000000";
    let mut computer = connected(&rig, "desk", [8; 32], token, &["machine/1", "machine/4"]).await;
    let _ = computer.call("rotate", "machine.rotateCredential", json!({})).await;
    drop(computer);
    let entries = logged(&rig, &[Kind::Connected, Kind::Disconnected]).await;
    let connected = entries.iter().find(|entry| entry.kind == Kind::Connected).unwrap();
    assert_eq!(connected.computer.as_deref(), Some("Desk"));
    assert_eq!(connected.detail.as_deref(), Some("lan"), "loopback is this network");
    assert!(connected.at > 0);
    assert!(rig.host.revoke("desk").unwrap());
    logged(&rig, &[Kind::Revoked]).await;

    let file = std::fs::read_to_string(rig.host.registry().path().parent().unwrap().join("activity.jsonl")).unwrap();
    assert!(!file.contains(token), "no token in the log");
    // A restarted runtime reads the same file.
    let reread = super::activity::Log::in_dir(rig.host.registry().path().parent().unwrap()).recent().unwrap();
    assert_eq!(reread, rig.host.activity().recent().unwrap());
}

/// Data privacy mode turns off being operated and operating (PRO-357). It is
/// one switch per process, so the check runs in a child of its own.
#[test]
fn data_privacy_mode_opens_no_listener_and_makes_no_machine_connection() {
    let root = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "machine_host::security_tests::privacy_child", "--nocapture", "--test-threads=1"])
        .env("TERMINALX_TEST_MACHINE_PRIVACY", "1")
        .env("TERMINALX_HOME", root.path().canonicalize().unwrap())
        .env_remove("TERMINALX_TEST_MANAGED_PRIVACY")
        .env_remove(wire::PORT_ENV)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("privacy child ran"), "the child ran its checks: {stdout}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn privacy_child() {
    if std::env::var("TERMINALX_TEST_MACHINE_PRIVACY").as_deref() != Ok("1") {
        return;
    }
    let root = crate::store::root().unwrap();
    crate::store::write_json(&root.join("data-privacy.json"), &json!({ "enabled": true })).unwrap();
    assert!(crate::data_privacy::refresh().enabled, "data privacy mode is on");
    let mut settings = crate::store::settings::load();
    settings.machines.allow_operating = true;
    crate::store::settings::save(&settings).unwrap();

    // Being operated: the switch is on, but nothing listens and no code is made.
    let data = tempfile::tempdir().unwrap();
    let keypair = HostKeypair::from_secret([12; 32]);
    let identity = crate::remote::machine::Identity { machine_id: keypair.host_id(), has_window: false };
    let rpc = WorkspaceRpc::machine(identity, 0, Arc::new(crate::sink::BroadcastSink::new(8)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
    let host = MachineHost::idle_for_test(data.path(), rpc, keypair);
    host.clone().reconcile(true).await;
    let status = host.status();
    assert!(!status.enabled, "privacy forces the switch off");
    assert!(status.listening.is_none(), "no listener is open");
    assert!(!status.takes_port);
    assert!(!host.keeps_runtime(), "no standing service");
    assert_eq!(host.create_code(None).unwrap_err().code, "not_enabled");

    // Operating: no machine connection is made, by the real dialer.
    assert!(crate::data_privacy::require_network().is_err(), "machine_remote_attach is refused");
    use crate::remote::machine_client::{Dialer as _, NetDialer, Route, RouteKind, Target};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://127.0.0.1:{}/machine/1", listener.local_addr().unwrap().port());
    let target = Arc::new(Target {
        machine_id: HostKeypair::from_secret([13; 32]).host_id(),
        public_key_b64: HostKeypair::from_secret([13; 32]).public_key_b64(),
        direct_endpoints: vec![endpoint.clone()],
        route: crate::machines::store::MachineRoute::ThisNetwork,
        last_route: None,
        last_seen_at: None,
        device_token: zeroize::Zeroizing::new("token-000000000000000000000000".into()),
        client_secret: zeroize::Zeroizing::new([14; 32]),
        label: "Desk".into(),
        platform: std::env::consts::OS.into(),
        relay: None,
    });
    let (events, _received) = tokio::sync::mpsc::unbounded_channel();
    let dialed = NetDialer.dial(target, Route::Direct { kind: RouteKind::Lan, endpoint }, false, 1, events).await;
    assert!(dialed.is_err(), "the dial is refused");
    assert!(tokio::time::timeout(Duration::from_millis(500), listener.accept()).await.is_err(), "nothing reached the machine's port");
    println!("privacy child ran");
}
