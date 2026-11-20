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
//! - A caller from a public address is refused under every listen choice
//!   unless the person allowed public callers; "Relay only" opens no port;
//!   a computer pairs through the relay only with the live code's invite and
//!   the person's Allow (PRO-487).

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
    let mut computer = connected(&rig, "desk", [1; 32], "desk-token-0000000000000000", &["machine/1", "machine/5", "session/1"]).await;
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

/// An agent on the machine has a shell and the `terminalx` CLI, and can
/// attach to the runtime as any process of the user can, so the window's
/// attachment is no boundary against it. The boundary is the person's
/// witness (`serve_cli::consent`, which `control.rs` checks before the host
/// sees a guarded command): making a code, Allow and letting a computer back
/// are refused unless the request's witness is a process outside the
/// runtime's tree and terminals. Revoke and Disconnect are not guarded: they
/// only take access away (docs/MACHINES.md, "Accepted risks").
#[cfg(unix)]
#[test]
fn an_agent_on_the_machine_cannot_approve_pair_or_let_a_computer_back() {
    use crate::serve_cli::consent;
    for command in [wire::CREATE_CODE, wire::APPROVE, wire::LET_BACK] {
        assert!(consent::guards(command), "{command} needs a person");
    }
    for command in [wire::REVOKE, wire::DISCONNECT, wire::STATUS, wire::ACTIVITY] {
        assert!(!consent::guards(command), "{command} takes nothing away from the person");
    }
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().join("run");
    std::fs::create_dir(&run).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    for (command, params) in [
        (wire::CREATE_CODE, json!({ "epoch": "e", "lease": "l" })),
        (wire::APPROVE, json!({ "epoch": "e", "lease": "l", "requestId": "any" })),
        (wire::LET_BACK, json!({ "epoch": "e", "lease": "l", "id": "desk" })),
    ] {
        // Asked with no witness, or one that is not there.
        let unsigned = consent::verify(&run, &mut params.clone()).unwrap_err();
        assert_eq!(unsigned.code, "person_required", "{command}: a request that does not say who sent it");
        let mut nobody = params.clone();
        nobody[consent::PARAM] = json!({ "socket": run.join("nobody.sock"), "nonce": "n" });
        assert_eq!(consent::verify(&run, &mut nobody).unwrap_err().code, "person_required", "{command}: a witness that is not there");
        // Asked with a real witness that the runtime's own process holds, as
        // a process it started (an agent, a terminal) would: the kernel says
        // who listens, and it is refused.
        let mut asked = params.clone();
        let witness = consent::witness_for(command, &run, &mut asked).unwrap().expect("guarded");
        let refused = consent::verify(&run, &mut asked).unwrap_err();
        assert_eq!(refused.code, "person_required", "{command}: {}", refused.message);
        assert!(asked.get(consent::PARAM).is_none(), "the witness is never passed on to the host");
        drop(witness);
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
    let mut computer = connected(&rig, "desk", [5; 32], old, &["machine/1", "machine/5"]).await;
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
    let hello = again.call("hello", "rpc.hello", hello(&["machine/1", "machine/5"])).await;
    assert!(hello["ok"].as_bool().unwrap_or(false), "{hello}");
    let lost = again.call("rotate", "machine.rotateCredential", json!({})).await;
    let lost = lost["result"]["deviceToken"].as_str().unwrap_or_else(|| panic!("a second fresh token: {lost}")).to_string();
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

/// A computer whose link has stayed up past 90 days is in use: a second
/// connection (the direct probe beside the relay, a reconnect while the old
/// socket is half open) is let in, not expired.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_computer_connected_for_ninety_days_is_not_expired_by_its_next_connection() {
    let rig = rig(TTL);
    let token = "desk-token-0000000000000000";
    let mut first = connected(&rig, "desk", [10; 32], token, &["machine/1"]).await;
    eventually("connected", || rig.host.status().computers.first().is_some_and(|computer| computer.connected).then_some(())).await;
    let now = chrono::Utc::now().timestamp_millis();
    let mut aged = rig.host.registry().list().unwrap().remove(0);
    aged.approved_at = now - UNUSED_EXPIRY_MS - 120_000;
    aged.last_seen_at = Some(now - UNUSED_EXPIRY_MS - 60_000);
    rig.host.registry().put(aged).unwrap();

    let mut second = ask(&rig, [10; 32], token).await;
    assert_eq!(second.answer(Duration::from_secs(5)).await, Answer::In, "a connected computer is not expired");
    assert_eq!(rig.host.registry().list().unwrap().len(), 1, "its record is kept");
    assert!(!rig.host.activity().recent().unwrap().iter().any(|entry| entry.kind == Kind::Expired));
    assert!(!first.closed_within(Duration::from_millis(300)).await, "the first link stays up");
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
    let mut computer = connected(&rig, "desk", [8; 32], token, &["machine/1", "machine/5"]).await;
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
fn plan(choice: crate::listen::Listen, allow_public: bool) -> crate::listen::Plan {
    crate::listen::Plan { choice, chosen: true, allow_public, public_unanswered: false }
}

/// PRO-487: whatever the listener is bound to, a connection whose source is
/// a public address is refused before anything is read from it, unless the
/// person allowed public callers. Local, private and Tailscale sources are
/// answered throughout.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_caller_from_a_public_address_is_refused_under_every_listen_choice_unless_allowed() {
    use crate::listen::Listen;
    let rig = rig(TTL);
    let source = |ip: &str| -> std::net::SocketAddr { format!("{ip}:50000").parse().unwrap() };
    let public = ["203.0.113.7", "8.8.8.8", "100.128.0.1", "172.32.0.1"];
    let nearby = ["127.0.0.1", "192.168.1.20", "10.1.2.3", "172.16.4.5", "100.93.49.78", "169.254.1.2"];

    // Before anyone chose (an install from before the setting): refused.
    for ip in public {
        assert!(!rig.host.answers(source(ip)), "{ip} before any choice");
    }
    for choice in Listen::EVERY {
        // The listeners themselves are another test's; here, who is answered.
        rig.host.state.lock().unwrap().plan = Some(plan(choice, false));
        for ip in public {
            assert!(!rig.host.answers(source(ip)), "{ip} under {choice:?}");
        }
        for ip in nearby {
            assert!(rig.host.answers(source(ip)), "{ip} under {choice:?}");
        }
        assert!(!rig.host.answers("[2001:db8::1]:50000".parse().unwrap()), "a public IPv6 source under {choice:?}");
        assert!(rig.host.answers("[fd7a:115c:a1e0::1]:50000".parse().unwrap()), "Tailscale's IPv6 range under {choice:?}");
    }
    // The refusal is said in the status and kept for the next start.
    let status = rig.host.status();
    let listen = status.listen.expect("the status says where it listens");
    assert!(!listen.allow_public && listen.refused_public_at.is_some(), "{listen:?}");
    let kept = eventually("the refusal is kept on disk", || std::fs::read(rig.host.data_dir.join(super::DIR).join(super::PUBLIC_CALLERS_FILE)).ok()).await;
    let kept_at = serde_json::from_slice::<Value>(&kept).unwrap()["refusedAt"].as_i64().expect("when it was refused");
    assert!(kept_at <= listen.refused_public_at.unwrap(), "the first refusal of the hour is the one kept");
    assert!(super::read_refused_public(&rig.host.data_dir).is_some(), "read back at the next start");

    // Only the explicit choice answers them.
    rig.host.state.lock().unwrap().plan = Some(plan(Listen::All, true));
    for ip in public {
        assert!(rig.host.answers(source(ip)), "{ip} once public callers are allowed");
    }
    assert!(rig.host.status().listen.unwrap().allow_public);

    // Over the real socket: a local caller is still served, a refusal having changed nothing for it.
    rig.host.state.lock().unwrap().plan = Some(plan(Listen::All, false));
    let mut computer = connected(&rig, "desk", [21; 32], "desk-token-0000000000000000", &["machine/1"]).await;
    let described = computer.call("d", "machine.describe", json!({})).await;
    assert_eq!(described["ok"], true, "{described}");
    assert_eq!(described["result"]["listen"]["choice"], "all", "its page reads where it listens: {described}");
    assert_eq!(described["result"]["listen"]["allowPublic"], false);
    assert!(described["result"]["runsAs"]["user"].as_str().is_some_and(|user| !user.is_empty()), "and who it runs as: {described}");
}

/// PRO-487: the install that listened before the setting existed keeps every
/// interface, refuses public callers, and asks once whether to keep its
/// public address; answering either way ends the question.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_from_before_the_setting_asks_once_about_its_public_address() {
    use crate::listen::{Listen, Plan};
    let rig = rig(TTL);
    let before = Plan::of(&crate::store::settings::MachinesSettings { allow_operating: true, listen: None, allow_public: None });
    let public: std::net::Ipv4Addr = "203.0.113.7".parse().unwrap();
    {
        let mut state = rig.host.state.lock().unwrap();
        state.plan = Some(before);
        state.interfaces = vec![std::net::Ipv4Addr::LOCALHOST, public];
    }
    let listen = rig.host.status().listen.unwrap();
    assert_eq!((listen.choice, listen.chosen, listen.allow_public, listen.ask_public), (Listen::All, false, false, true), "{listen:?}");
    assert!(!rig.host.answers("198.51.100.9:4000".parse().unwrap()), "refused until the person answers");

    // Behind NAT nothing is asked until a public caller was refused. (One
    // rig a test: a second would wait on the first's temp home.)
    {
        let mut state = rig.host.state.lock().unwrap();
        state.refused_public_at = None;
        state.interfaces = vec![std::net::Ipv4Addr::LOCALHOST, "192.168.1.20".parse().unwrap()];
    }
    assert!(!rig.host.status().listen.unwrap().ask_public);
    assert!(!rig.host.answers("198.51.100.9:4000".parse().unwrap()));
    assert!(rig.host.status().listen.unwrap().ask_public, "a public caller reached it and was refused");

    // Keep the public address, or close it: asked once.
    for (choice, allow_public) in [(Listen::All, true), (Listen::Lan, false)] {
        rig.host.state.lock().unwrap().plan = Some(plan(choice, allow_public));
        let listen = rig.host.status().listen.unwrap();
        assert_eq!((listen.chosen, listen.ask_public, listen.allow_public), (true, false, allow_public), "{listen:?}");
    }
}

/// PRO-487: the listeners follow the choice. "Relay only" opens no port and
/// closes the connections that came in on one; "Local network" binds private
/// and Tailscale addresses only, never loopback or a public one; the
/// advertised endpoints are the bound addresses.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_listen_choice_decides_what_is_bound_and_relay_only_opens_no_port() {
    use crate::listen::Listen;
    let mut rig = rig(TTL);
    let interfaces = crate::listen::interfaces();
    let mut computer = connected(&rig, "desk", [22; 32], "desk-token-0000000000000000", &["machine/1"]).await;
    let all_port = rig.port;

    // Relay only: nothing listens, and the computer that came in directly is closed.
    rig.host.listen_for_test(plan(Listen::Relay, false), interfaces.clone()).unwrap();
    assert!(computer.closed_within(Duration::from_secs(5)).await, "its listener closed, and it with it");
    let status = rig.host.status();
    assert!(status.listening.is_none(), "no listener: {:?}", status.listening);
    let listen = status.listen.unwrap();
    assert_eq!((listen.choice, listen.addresses.len()), (Listen::Relay, 0), "{listen:?}");
    assert!(std::net::TcpStream::connect(("127.0.0.1", all_port)).is_err(), "the port is closed");
    assert!(rig.host.direct_endpoints().is_empty(), "no address is advertised, not even loopback");
    // No listener and no relay registration: a code no computer could use is not made.
    let refused = rig.host.create_code(None).unwrap_err();
    assert_eq!(refused.code, "not_reachable", "{refused:?}");
    assert!(refused.recovery.unwrap().contains("terminalx-serve login"));
    assert!(rig.host.status().code.is_none());

    // Local network: private and Tailscale addresses only.
    rig.host.listen_for_test(plan(Listen::Lan, false), interfaces.clone()).unwrap();
    let wanted = crate::listen::bind_addresses(Listen::Lan, &interfaces);
    let bound: Vec<std::net::SocketAddr> = rig.host.status().listen.unwrap().addresses.iter().map(|address| address.parse().unwrap()).collect();
    assert_eq!(bound.iter().map(|address| address.ip()).collect::<Vec<_>>(), wanted.iter().map(|ip| std::net::IpAddr::V4(*ip)).collect::<Vec<_>>());
    assert!(bound.iter().all(|address| !address.ip().is_loopback() && !address.ip().is_unspecified() && !crate::listen::is_public(address.ip())), "{bound:?}");
    if let Some(port) = bound.first().map(std::net::SocketAddr::port) {
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "loopback is not a local-network address");
        let endpoints = rig.host.direct_endpoints();
        assert!(endpoints.iter().all(|endpoint| !endpoint.contains("127.0.0.1")) && !endpoints.is_empty(), "{endpoints:?}");
    }

    // Tailscale: its address only (none on a computer without Tailscale).
    rig.host.listen_for_test(plan(Listen::Tailscale, false), interfaces.clone()).unwrap();
    let bound: Vec<std::net::SocketAddr> = rig.host.status().listen.unwrap().addresses.iter().map(|address| address.parse().unwrap()).collect();
    assert!(bound.iter().all(|address| crate::listen::is_tailscale(address.ip())), "{bound:?}");
    assert_eq!(bound.len(), crate::listen::bind_addresses(Listen::Tailscale, &interfaces).len());

    // All interfaces, chosen in so many words: the wildcard again, and a code names its addresses.
    rig.host.listen_for_test(plan(Listen::All, false), interfaces).unwrap();
    rig.port = rig.host.port_for_test();
    assert_eq!(rig.host.status().listen.unwrap().addresses, vec![format!("0.0.0.0:{}", rig.port)]);
    let code = wire::MachineCode::decode(&rig.host.create_code(None).unwrap().code).unwrap();
    assert!(!code.direct_endpoints.is_empty() && code.relay.is_none(), "no relay registration here: {:?}", code.direct_endpoints);
    let mut again = ask(&rig, [22; 32], "desk-token-0000000000000000").await;
    assert_eq!(again.answer(Duration::from_secs(5)).await, Answer::In, "it connects again where the machine listens now");
}

/// PRO-487: pairing by code through the relay, for a machine with no
/// listener. Only the relay device the live code's invite was made for may
/// ask; nothing is granted before Allow; the computer's record keeps that
/// relay device, so it is admitted through the relay from then on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_computer_pairs_through_the_relay_only_with_the_codes_invite_and_allow() {
    use crate::remote::host::{MachineRoutes, RelayAsking};
    let rig = rig(TTL);
    let secret = [23; 32];
    let asking = |device: &str, token: &str| RelayAsking {
        relay_device_id: device.into(),
        token: token.into(),
        client_key_b64: public_b64(secret),
        label: Some("Test\u{7}MacBook".into()),
        platform: Some("macos".into()),
    };
    let token = rig.host.code_with_relay_for_test("computer-invited");
    assert!(rig.host.is_computer("computer-invited"), "its connection is the machine's, never passed on as a phone's");
    assert!(!rig.host.is_computer("computer-other"));

    // Another relay device with the code's token is not a pairing, and is not admitted.
    assert!(rig.host.clone().pair_computer(asking("computer-other", &token)).await.unwrap().is_none());
    let (cancel, _closed) = tokio::sync::mpsc::unbounded_channel();
    assert_eq!(rig.host.admit_computer("computer-other", &token, &public_b64(secret), cancel).unwrap().unwrap_err(), wire::REFUSED_CODE_INACTIVE);
    // The invite's device with a wrong token is refused, as on the direct route.
    assert_eq!(rig.host.clone().pair_computer(asking("computer-invited", "not-the-codes-token-000000")).await.unwrap(), Some(Err(wire::REFUSED_CODE_INACTIVE)));

    // The right one waits for the person; nothing is written meanwhile.
    let waiting = tokio::spawn(rig.host.clone().pair_computer(asking("computer-invited", &token)));
    let pending = eventually("the machine asks the person", || rig.host.status().pending).await;
    assert_eq!((pending.transport.as_str(), pending.label.as_str()), ("relay", "TestMacBook"), "{pending:?}");
    assert!(rig.host.registry().list().unwrap().is_empty(), "nothing is granted before Allow");
    let (cancel, _closed) = tokio::sync::mpsc::unbounded_channel();
    assert!(rig.host.admit_computer("computer-invited", &token, &public_b64(secret), cancel).unwrap().is_err(), "not admitted before Allow");

    let approve = rig.host.clone();
    let request_id = pending.request_id.clone();
    tokio::task::spawn_blocking(move || approve.approve(&request_id)).await.unwrap().unwrap();
    assert_eq!(waiting.await.unwrap().unwrap(), Some(Ok(())));
    let computers = rig.host.registry().list().unwrap();
    assert_eq!(computers.len(), 1);
    assert_eq!(computers[0].relay_device_id.as_deref(), Some("computer-invited"), "its relay device from now on");
    assert_eq!(computers[0].client_public_key_b64.as_deref(), Some(public_b64(secret).as_str()), "pinned to the key it paired with");

    // Admitted through the relay as any paired computer, with its key only.
    let (cancel, _closed) = tokio::sync::mpsc::unbounded_channel();
    let (id, tracked) = rig.host.admit_computer("computer-invited", &token, &public_b64(secret), cancel).unwrap().unwrap();
    assert_eq!(id, computers[0].id);
    rig.host.release_computer(&id, tracked);
    let (cancel, _closed) = tokio::sync::mpsc::unbounded_channel();
    assert!(rig.host.admit_computer("computer-invited", &token, &public_b64([24; 32]), cancel).unwrap().is_err(), "another key with its token");
    assert!(rig.host.status().code.is_none(), "the code is spent");

    // A computer that gives up (its relay connection closes) leaves the request.
    let token = rig.host.code_with_relay_for_test("computer-second");
    let waiting = tokio::spawn(rig.host.clone().pair_computer(asking("computer-second", &token)));
    eventually("the second request", || rig.host.status().pending).await;
    waiting.abort();
    let _ = waiting.await;
    eventually("the request is left when the computer gives up", || rig.host.status().pending.is_none().then_some(())).await;
    assert_eq!(rig.host.registry().list().unwrap().len(), 1, "nothing was granted to it");
}

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
