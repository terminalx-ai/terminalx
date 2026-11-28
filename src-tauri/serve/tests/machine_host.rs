//! A local runtime accepts operating computers itself (PRO-341): the real
//! `terminalx-serve`, no desktop, no account. Off by default it opens no
//! port; on, a paired computer connects on `/machine/1` with E2EE v2 and
//! works the machine's workspace RPC, and a phone's connection goes to the
//! window's phone route untouched. The relay route is in `relay_e2e.rs`.
#![cfg(unix)]

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixListener;
use std::time::Duration;

use common::agent::{wait_until, AgentWorld, Serve};
use common::machine::{allow, computer, connect, free_port, host_key, listening, pair, status, Outcome};
use raccoon_lib::remote::client::{ClientEvent, ClientState};
use raccoon_lib::remote::machine_client::{
    MachineConnectionState, MachineConnectionView, MachineEnv, MachineRoute, MachineSupervisor, NetDialer, OnState, RelayCredential, RouteKind, RouteUsed, Target, Zeroizing,
};
use serde_json::json;
use std::sync::Arc;

const TOKEN: &str = "a-paired-computers-device-token-0001";

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_computer_operates_a_local_runtime_directly_and_only_while_allowed() {
    let world = AgentWorld::new();
    let port = free_port();
    let mut command = world.machine_command();
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
    let serve = Serve::start(command, &world.data);

    // Off by default: nothing listens, and no key is made.
    std::thread::sleep(Duration::from_millis(300));
    let off = status(&serve);
    assert_eq!(off["enabled"], false);
    assert_eq!(off["takesPort"], false, "the window keeps the port");
    assert!(off["listening"].is_null());
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "no port is open while the switch is off");
    assert!(!world.data.join("machine-host/host-key.json").exists());

    pair(&world.data, "macbook", TOKEN, None);
    allow(&world.data, true);
    let address = listening(&serve);
    assert!(address.ends_with(&format!(":{port}")), "{address}");
    let keypair = host_key(&world.data);
    assert_eq!(status(&serve)["machineId"], keypair.host_id().as_str());
    assert_eq!(status(&serve)["takesPort"], true);

    // The paired computer works the machine's workspace RPC.
    let mut macbook = computer(connect(port, &keypair.public_key_b64(), TOKEN).await);
    let hello = macbook.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "session/1", "pty/1"], "client": { "app": "terminalx-desktop" } })).await;
    assert_eq!(hello["ok"], true, "{hello}");
    let granted: Vec<String> = serde_json::from_value(hello["result"]["capabilities"].clone()).unwrap();
    assert!(granted.contains(&"machine/1".to_string()), "{granted:?}");
    let described = macbook.call("machine.describe", json!({})).await;
    assert_eq!(described["result"]["machineId"], keypair.host_id().as_str(), "{described}");
    let sessions = macbook.call("session.list", json!({})).await;
    assert_eq!(sessions["ok"], true, "{sessions}");
    assert!(sessions["result"]["sessions"].is_array());
    let connected = status(&serve);
    assert_eq!(connected["computers"][0]["connected"], true, "{connected}");
    assert!(connected["computers"][0]["lastSeenAt"].is_i64());

    // A token it does not know is refused as "Access removed".
    match connect(port, &keypair.public_key_b64(), "an-unknown-device-token-0000000000").await {
        Outcome::Refused(code) => assert_eq!(code, Some(4401)),
        Outcome::In(_) => panic!("an unknown token was let in"),
    }

    // A phone (any other path) goes to the window's route, byte for byte.
    let attachment = serve.control("runtime.attach", json!({ "protocol": 1 }));
    let route = world.data.join("run/phones.sock");
    let listener = UnixListener::bind(&route).unwrap();
    std::fs::set_permissions(&route, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    serve.control("runtime.machineHost.phoneRoute", json!({ "epoch": attachment["epoch"], "lease": attachment["lease"], "socket": route }));
    let window = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        let mut body = vec![0u8; "GET / HTTP/1.1\r\nHost: mac\r\n\r\nphone-bytes".len()];
        reader.read_exact(&mut body).unwrap();
        reader.get_mut().write_all(b"from-window").unwrap();
        (header, body)
    });
    {
        let mut phone = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        phone.write_all(b"GET / HTTP/1.1\r\nHost: mac\r\n\r\nphone-bytes").unwrap();
        phone.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut answer = [0u8; 11];
        phone.read_exact(&mut answer).unwrap();
        assert_eq!(&answer, b"from-window");
    }
    let (header, body) = window.join().unwrap();
    let header = raccoon_lib::machine_wire::decode_header(header.as_bytes()).unwrap();
    assert!(matches!(header, raccoon_lib::machine_wire::Forwarded::Direct { peer: Some(_) }), "{header:?}");
    assert_eq!(body, b"GET / HTTP/1.1\r\nHost: mac\r\n\r\nphone-bytes");

    // Revoking a computer closes its connection at once and refuses it after.
    serve.control("runtime.machineHost.revoke", json!({ "epoch": attachment["epoch"], "lease": attachment["lease"], "id": "macbook" }));
    assert!(macbook.closed().await, "a revoked computer's connection closes");
    drop(macbook);
    assert!(matches!(connect(port, &keypair.public_key_b64(), TOKEN).await, Outcome::Refused(Some(4401))));

    // Off again: every computer is disconnected and the port closes; the
    // records stay, so on again needs no new pairing.
    pair(&world.data, "studio", "studio-device-token-000000000000000", None);
    let mut studio = computer(connect(port, &keypair.public_key_b64(), "studio-device-token-000000000000000").await);
    allow(&world.data, false);
    assert!(studio.closed().await, "turning the switch off closes every computer's connection");
    // A socket still open on the port would keep it from being bound again.
    drop(studio);
    wait_until("the port to close", || std::net::TcpStream::connect(("127.0.0.1", port)).is_err().then_some(()));
    assert_eq!(status(&serve)["computers"].as_array().unwrap().len(), 1);
    allow(&world.data, true);
    // The closed connections hold the port in TIME_WAIT for up to 30 s.
    listening(&serve);
    assert_eq!(host_key(&world.data).host_id(), keypair.host_id(), "the key is never made again");
    let mut again = computer(connect(port, &keypair.public_key_b64(), "studio-device-token-000000000000000").await);
    assert_eq!(again.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1"] })).await["ok"], true);
}

#[test]
fn a_runtime_hosting_computers_does_not_exit_when_idle() {
    let world = AgentWorld::new();
    let port = free_port();
    allow(&world.data, true);
    let mut command = world.machine_command();
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string()).args(["--idle-grace-seconds", "1"]);
    let mut serve = Serve::start(command, &world.data);
    listening(&serve);
    std::thread::sleep(Duration::from_millis(1600));
    assert!(serve.child.try_wait().unwrap().is_none(), "a standing service with the switch on");
    allow(&world.data, false);
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while serve.child.try_wait().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline, "with the switch off, an idle runtime exits as before");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// What the operating computer's supervisor is told: its machine states and
/// the web view's states.
struct Heard {
    states: tokio::sync::mpsc::UnboundedReceiver<MachineConnectionState>,
    client: tokio::sync::mpsc::UnboundedReceiver<ClientEvent>,
}

impl Heard {
    async fn state(&mut self, what: &str, within: Duration, wanted: impl Fn(&MachineConnectionState) -> bool) -> MachineConnectionState {
        let mut seen = Vec::new();
        let found = tokio::time::timeout(within, async {
            loop {
                let state = self.states.recv().await.expect("the supervisor runs");
                seen.push(state.clone());
                if wanted(&state) {
                    return state;
                }
            }
        })
        .await;
        found.unwrap_or_else(|_| panic!("never {what}; saw {seen:?}"))
    }

    /// The web view's last `connected` link, and every message so far.
    fn drain(&mut self) -> (Option<u64>, Vec<serde_json::Value>) {
        let (mut link, mut messages) = (None, Vec::new());
        while let Ok(event) = self.client.try_recv() {
            match event {
                ClientEvent::State(ClientState::Connected { link: connected, .. }) => link = connected,
                ClientEvent::State(_) => {}
                ClientEvent::Message(message) => messages.push(message),
            }
        }
        (link, messages)
    }
}

/// The operating computer's record, token and key, kept in memory.
struct Paired {
    target: std::sync::Mutex<Target>,
    described: std::sync::Mutex<Vec<serde_json::Value>>,
}

impl MachineEnv for Paired {
    fn target(&self) -> anyhow::Result<Target> {
        Ok(self.target.lock().unwrap().clone())
    }
    fn signed_in_user(&self) -> Option<String> {
        None
    }
    fn described(&self, described: &serde_json::Value, route: &RouteUsed) {
        self.described.lock().unwrap().push(described.clone());
        self.target.lock().unwrap().last_route = Some(route.clone());
    }
    fn save_relay(&self, _credential: &RelayCredential) -> anyhow::Result<()> {
        anyhow::bail!("no relay in this test")
    }
    fn drop_relay(&self) {}
}

/// PRO-345: the desktop's machine supervisor against the real runtime, on
/// the direct route. It connects, survives the runtime restarting, and
/// ends in "access removed" once the machine revokes it, retrying nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_machine_supervisor_connects_directly_survives_a_restart_and_ends_in_access_removed() {
    const COMPUTER_TOKEN: &str = "the-operating-computers-device-token-02";
    let world = AgentWorld::new();
    let port = free_port();
    let command = || {
        let mut command = world.machine_command();
        command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
        command
    };
    pair(&world.data, "macbook", COMPUTER_TOKEN, None);
    allow(&world.data, true);
    let serve = Serve::start(command(), &world.data);
    listening(&serve);
    let keypair = host_key(&world.data);
    let machine_id = keypair.host_id();

    // machine/2 on the machine side: directEndpoints, and no relay without a registration.
    let mut probe = computer(connect(port, &keypair.public_key_b64(), COMPUTER_TOKEN).await);
    let hello = probe.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "machine/2"] })).await;
    assert!(hello["result"]["capabilities"].as_array().unwrap().iter().any(|granted| granted == "machine/2"), "{hello}");
    let described = probe.call("machine.describe", json!({})).await;
    let endpoints = described["result"]["directEndpoints"].as_array().cloned().unwrap_or_default();
    assert!(!endpoints.is_empty() && endpoints.iter().all(|endpoint| endpoint.as_str().unwrap().ends_with(&format!(":{port}/machine/1"))), "{described}");
    assert_eq!(probe.call("machine.relayAccess", json!({})).await["result"], json!({ "relay": null }));
    drop(probe);

    let env = Arc::new(Paired {
        target: std::sync::Mutex::new(Target {
            machine_id: machine_id.clone(),
            public_key_b64: keypair.public_key_b64(),
            direct_endpoints: vec![format!("ws://127.0.0.1:{port}/machine/1")],
            route: MachineRoute::RelayAndNearby,
            last_route: None,
            last_seen_at: None,
            device_token: Zeroizing::new(COMPUTER_TOKEN.into()),
            client_secret: Zeroizing::new([9u8; 32]),
            label: "Test MacBook".into(),
            platform: "macos".into(),
            relay: None,
        }),
        described: std::sync::Mutex::new(Vec::new()),
    });
    let (events, client) = tokio::sync::mpsc::unbounded_channel();
    let (states_tx, states) = tokio::sync::mpsc::unbounded_channel();
    let on_state: OnState = Arc::new(move |view: &MachineConnectionView| {
        let _ = states_tx.send(view.state.clone());
    });
    let supervisor = MachineSupervisor::start(&machine_id, env.clone(), Arc::new(NetDialer), events, on_state);
    let mut heard = Heard { states, client };

    let direct = |state: &MachineConnectionState| matches!(state, MachineConnectionState::Direct { route, .. } if route.kind == RouteKind::Lan);
    heard.state("connected directly", Duration::from_secs(30), direct).await;
    let (first_link, _) = heard.drain();
    assert!(first_link.is_some(), "the web view was told connected with a link");
    assert_eq!(env.described.lock().unwrap()[0]["machineId"], machine_id.as_str());
    // Frames from the web view reach the machine and its answers come back.
    assert!(supervisor.send(json!({ "id": "web-hello", "method": "rpc.hello", "params": { "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "session/1"] } })));
    assert!(supervisor.send(json!({ "id": "web-list", "method": "session.list", "params": {} })));
    let answered = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let (_, messages) = heard.drain();
            if let Some(answer) = messages.into_iter().find(|message| message["id"] == "web-list") {
                return answer;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("session.list was answered");
    assert_eq!(answered["ok"], true, "{answered}");

    // The runtime restarts: the link is lost, then found again on its own.
    drop(serve);
    heard.state("reconnecting", Duration::from_secs(30), |state| matches!(state, MachineConnectionState::Reconnecting { .. })).await;
    let serve = Serve::start(command(), &world.data);
    listening(&serve);
    heard.state("connected again", Duration::from_secs(90), direct).await;
    let (second_link, _) = heard.drain();
    assert!(second_link.is_some() && second_link != first_link, "a new link: {first_link:?} then {second_link:?}");

    // Revoked on the machine: access removed, and nothing retries.
    let attachment = serve.control("runtime.attach", json!({ "protocol": 1 }));
    serve.control("runtime.machineHost.revoke", json!({ "epoch": attachment["epoch"], "lease": attachment["lease"], "id": "macbook" }));
    heard.state("access removed", Duration::from_secs(30), |state| *state == MachineConnectionState::AccessRemoved).await;
    let (_, _) = heard.drain();
    supervisor.nudge();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(heard.states.try_recv().is_err(), "nothing retried after access was removed");
    assert_eq!(supervisor.state(), MachineConnectionState::AccessRemoved);
    supervisor.stop();
}
