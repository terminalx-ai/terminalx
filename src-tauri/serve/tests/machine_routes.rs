//! A machine's two routes on every pull request (PRO-358): the real
//! `terminalx-serve` as the machine (no project root, registered with a
//! relay through `--relay-link`), the desktop's `MachineSupervisor` as the
//! paired computer, the relay in the test process (`common/relay.rs`) and a
//! TCP proxy the test owns as the direct route, between the address the
//! computer knows and the runtime's listener. Closing the proxy drops the
//! direct route; stopping the test relay drops the relay.
//!
//! - `the_direct_route_drops_and_the_machine_answers_through_the_relay`: the
//!   supervisor connects directly and gets relay access (`machine.relayAccess`:
//!   this relay's director and cell, an invite used once, a resume credential
//!   installed with its hash only); when the direct route drops it carries on
//!   through the relay on a new link, every client connection on its own host
//!   data leg, calls answer, and the shell it started keeps its output.
//! - `both_routes_drop_and_the_supervisor_recovers_on_its_own`: with both
//!   routes down the supervisor (and the web view) says reconnecting; the
//!   relay comes back and it reconnects through it by itself, then moves to
//!   the direct route when that is back; both drop again and the direct route
//!   comes back first. A new link each time.
//! - `revoking_the_computer_ends_its_relay_connection_and_the_relay_refuses_it`:
//!   the machine revokes the computer while it works through the relay: the
//!   relay connection ends, the runtime sends `device-revoke`, the relay
//!   refuses the resume credential from then on, the machine refuses the
//!   computer on the direct route, and the supervisor stops in
//!   `accessRemoved` with nothing retried on either route.
//! - `a_relay_only_machine_opens_no_port_and_is_paired_by_code_through_the_relay`
//!   (PRO-487): a machine set to "Relay only" binds nothing; its code carries
//!   no address and a relay invite; a computer that is not signed in is told
//!   to sign in; a signed-in one pairs through the relay once the person
//!   allows it, and its supervisor then operates the machine over the relay.
#![cfg(unix)]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use common::agent::{wait_until, AgentWorld, Serve};
use common::machine::{allow, free_port, host_key, listening, pair};
use common::relay::{try_attach, Attach, TestRelay, CREDENTIAL_REFUSED};
use raccoon_lib::cloud_agents::crypto::random_bytes;
use raccoon_lib::relay_e2ee::token_hash;
use raccoon_lib::remote::client::{ClientEvent, ClientState};
use raccoon_lib::remote::host::relay_host_id_for_secret;
use raccoon_lib::remote::machine_client::{
    MachineConnectionState, MachineConnectionView, MachineEnv, MachineRoute, MachineSupervisor, NetDialer, OnState, RelayCredential, RouteKind, RouteUsed, Target, Zeroizing,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;

/// Any one step. A route coming back waits out the supervisor's and the
/// runtime's backoff (at most 10 s each), and a move from the relay to a
/// direct route waits for the supervisor's 30 s check; generous for a slow
/// CI runner.
const WAIT: Duration = Duration::from_secs(120);
/// The account signed in on the operating computer.
const USER: &str = "user-pro358";
/// The runtime generation in the machine's relay token.
const RUNTIME_GENERATION: u64 = 7;
/// The computer's id in the machine's registry.
const COMPUTER: &str = "desk";

/// The direct route: a TCP proxy from the endpoint the computer knows to the
/// runtime's listener. Dropped, its port closes and every connection through
/// it ends at once; restored, it listens on the same port again.
struct DirectRoute {
    port: u16,
    target: u16,
    runtime: Option<tokio::runtime::Runtime>,
    /// Connections it has taken, ever.
    accepted: Arc<AtomicUsize>,
}

impl DirectRoute {
    fn open(target: u16) -> Self {
        let mut route = Self { port: free_port(), target, runtime: None, accepted: Arc::new(AtomicUsize::new(0)) };
        route.restore();
        route
    }

    /// The `ws://…/machine/1` endpoint the computer knows for the machine.
    fn endpoint(&self) -> String {
        format!("ws://127.0.0.1:{}/machine/1", self.port)
    }

    fn restore(&mut self) {
        assert!(self.runtime.is_none(), "the direct route is already open");
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        // A connection the proxy closed may hold the port for a moment.
        let listener = loop {
            match std::net::TcpListener::bind(("127.0.0.1", self.port)) {
                Ok(listener) => break listener,
                Err(error) => {
                    assert!(std::time::Instant::now() < deadline, "the direct route could not listen on {} again: {error}", self.port);
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        };
        listener.set_nonblocking(true).unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("direct-route").enable_all().build().unwrap();
        let (target, accepted) = (self.target, self.accepted.clone());
        runtime.spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            loop {
                let Ok((mut inbound, _)) = listener.accept().await else { continue };
                accepted.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    if let Ok(mut outbound) = tokio::net::TcpStream::connect(("127.0.0.1", target)).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                });
            }
        });
        self.runtime = Some(runtime);
    }

    fn drop_route(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }

    fn accepted(&self) -> usize {
        self.accepted.load(Ordering::SeqCst)
    }
}

impl Drop for DirectRoute {
    fn drop(&mut self) {
        self.drop_route();
    }
}

/// The operating computer's record and Keychain, in memory, as
/// `machines::connect::StoreEnv` keeps them on disk.
struct Kept {
    target: Mutex<Target>,
    /// Every relay credential the supervisor kept, in order.
    saved: Mutex<Vec<RelayCredential>>,
    /// How often the relay refused the credential and it was forgotten.
    dropped: Mutex<u32>,
}

impl MachineEnv for Kept {
    fn target(&self) -> anyhow::Result<Target> {
        Ok(self.target.lock().unwrap().clone())
    }

    fn signed_in_user(&self) -> Option<String> {
        Some(USER.into())
    }

    fn described(&self, _described: &Value, route: &RouteUsed) {
        self.target.lock().unwrap().last_route = Some(route.clone());
    }

    fn save_relay(&self, credential: &RelayCredential) -> anyhow::Result<()> {
        self.saved.lock().unwrap().push(credential.clone());
        self.target.lock().unwrap().relay = Some(credential.clone());
        Ok(())
    }

    fn save_token(&self, token: &str) -> anyhow::Result<()> {
        self.target.lock().unwrap().device_token = Zeroizing::new(token.to_string());
        Ok(())
    }

    fn drop_relay(&self) {
        *self.dropped.lock().unwrap() += 1;
        self.target.lock().unwrap().relay = None;
    }
}

/// What the web view hears from the supervisor: answers, notifications and
/// the connection states it is told.
struct Web {
    events: mpsc::UnboundedReceiver<ClientEvent>,
    messages: Vec<Value>,
    told: Vec<ClientState>,
    next: u64,
}

impl Web {
    fn hear(&mut self, event: ClientEvent) {
        match event {
            ClientEvent::Message(message) => self.messages.push(message),
            ClientEvent::State(state) => self.told.push(state),
        }
    }

    fn drain(&mut self) {
        while let Ok(event) = self.events.try_recv() {
            self.hear(event);
        }
    }

    /// The link of the last `connected` the web view was told.
    fn link(&mut self) -> Option<u64> {
        self.drain();
        self.told.iter().rev().find_map(|state| match state {
            ClientState::Connected { link, .. } => *link,
            _ => None,
        })
    }

    async fn call(&mut self, supervisor: &MachineSupervisor, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = format!("web-{}", self.next);
        assert!(supervisor.send(json!({ "id": id, "method": method, "params": params })), "{method}: the supervisor has no link to send it on ({:?})", supervisor.state());
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            if let Some(found) = self.messages.iter().position(|message| message["id"] == id.as_str()) {
                return self.messages.remove(found);
            }
            match tokio::time::timeout_at(deadline, self.events.recv()).await {
                Ok(Some(event)) => self.hear(event),
                Ok(None) => panic!("the supervisor went away before {method} was answered"),
                Err(_) => panic!("{method} was not answered within {WAIT:?}; the machine is {:?}", supervisor.state()),
            }
        }
    }

    async fn ok(&mut self, supervisor: &MachineSupervisor, method: &str, params: Value) -> Value {
        let answer = self.call(supervisor, method, params).await;
        assert_eq!(answer["ok"], true, "{method}: {answer}");
        answer["result"].clone()
    }

    /// Everything the terminal printed in `pty.output` notifications so far.
    fn output(&self, pty_id: &str) -> String {
        self.messages
            .iter()
            .filter(|message| message["event"] == "pty.output" && message["params"]["ptyId"] == pty_id)
            .map(|message| String::from_utf8_lossy(&STANDARD.decode(message["params"]["data"].as_str().unwrap_or_default()).unwrap_or_default()).into_owned())
            .collect()
    }

    async fn output_until(&mut self, pty_id: &str, marker: &str) -> String {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let output = self.output(pty_id);
            if output.contains(marker) {
                return output;
            }
            match tokio::time::timeout_at(deadline, self.events.recv()).await {
                Ok(Some(event)) => self.hear(event),
                _ => panic!("no {marker:?} in the terminal's output: {output:?}"),
            }
        }
    }
}

/// `check` until it holds, within [`WAIT`]; its `Err` says what was seen.
async fn eventually<T>(what: &str, mut check: impl FnMut() -> Result<T, String>) -> T {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        match check() {
            Ok(found) => return found,
            Err(seen) => assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}; saw {seen}"),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn direct(state: &MachineConnectionState) -> bool {
    matches!(state, MachineConnectionState::Direct { route, .. } if route.kind == RouteKind::Lan)
}

fn relay(state: &MachineConnectionState) -> bool {
    matches!(state, MachineConnectionState::Relay { .. })
}

fn reconnecting(state: &MachineConnectionState) -> bool {
    matches!(state, MachineConnectionState::Reconnecting { .. })
}

/// The machine, its relay and direct route, and the computer operating it.
/// Fields drop in order: the supervisor stops first, the runtime goes before
/// its directories.
struct Rig {
    supervisor: MachineSupervisor,
    states: mpsc::UnboundedReceiver<MachineConnectionState>,
    web: Web,
    kept: Arc<Kept>,
    machine_id: String,
    project_id: String,
    direct: DirectRoute,
    serve: Serve,
    relay: TestRelay,
    world: AgentWorld,
    _link: tempfile::TempDir,
}

impl Rig {
    /// A machine that lets computers operate it, registered with the test
    /// relay, with one computer paired by code (no relay device yet), and
    /// that computer's supervisor started with only the direct endpoint.
    async fn start() -> Self {
        let relay = TestRelay::start();
        let world = AgentWorld::new();
        let secret = random_bytes::<32>();
        let machine_id = relay_host_id_for_secret(secret);
        let link_dir = tempfile::tempdir().unwrap();
        let link = link_dir.path().join("link.json");
        let contents = json!({
            "v": 1,
            "hostSecretB64": STANDARD.encode(secret),
            "relayToken": TestRelay::relay_token(&machine_id, RUNTIME_GENERATION),
            "directorUrl": relay.director_url(),
            "attachments": [],
            "revocations": [],
        });
        std::fs::write(&link, contents.to_string()).unwrap();
        let token = uuid::Uuid::new_v4().simple().to_string();
        allow(&world.data, true);
        pair(&world.data, COMPUTER, &token, None);
        let project = world.project.to_string_lossy().into_owned();
        std::fs::write(world.data.join("projects.json"), json!({ "projects": [{ "path": project, "name": "project", "kind": "git" }] }).to_string()).unwrap();

        let port = free_port();
        let mut command = world.machine_command();
        command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string()).args(["--runtime-kind", "local", "--relay-link"]).arg(&link);
        let serve = Serve::start(command, &world.data);
        wait_until("the machine's relay registration", || serve.lines.lock().unwrap().iter().rev().find(|line| line["type"] == "relay" && line["status"]["state"] == "registered").cloned());
        assert!(relay.registration(&machine_id).is_some(), "the test relay holds the machine's registration");
        let address = listening(&serve);
        assert!(address.ends_with(&format!(":{port}")), "the machine listens on {address}, not {port}");
        let keypair = host_key(&world.data);
        assert_eq!(keypair.host_id(), machine_id, "one key on every route");

        let direct = DirectRoute::open(port);
        let kept = Arc::new(Kept {
            target: Mutex::new(Target {
                machine_id: machine_id.clone(),
                public_key_b64: keypair.public_key_b64(),
                direct_endpoints: vec![direct.endpoint()],
                route: MachineRoute::RelayAndNearby,
                last_route: None,
                last_seen_at: None,
                device_token: Zeroizing::new(token),
                client_secret: Zeroizing::new(random_bytes::<32>()),
                label: "Test MacBook".into(),
                platform: "macos".into(),
                relay: None,
            }),
            saved: Mutex::new(Vec::new()),
            dropped: Mutex::new(0),
        });
        let (events, web_events) = mpsc::unbounded_channel();
        let (states_tx, states) = mpsc::unbounded_channel();
        let on_state: OnState = Arc::new(move |view: &MachineConnectionView| {
            let _ = states_tx.send(view.state.clone());
        });
        let supervisor = MachineSupervisor::start(&machine_id, kept.clone(), Arc::new(NetDialer), events, on_state);
        Rig {
            supervisor,
            states,
            web: Web { events: web_events, messages: Vec::new(), told: Vec::new(), next: 0 },
            kept,
            project_id: raccoon_lib::remote::machine::project_id(&project),
            machine_id,
            direct,
            serve,
            relay,
            world,
            _link: link_dir,
        }
    }

    /// Machine states until one is `wanted`, within [`WAIT`]: every state
    /// on the way, that one last.
    async fn until(&mut self, what: &str, wanted: impl Fn(&MachineConnectionState) -> bool) -> Vec<MachineConnectionState> {
        let mut since = Vec::new();
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            match tokio::time::timeout_at(deadline, self.states.recv()).await {
                Ok(Some(state)) => {
                    let found = wanted(&state);
                    since.push(state);
                    if found {
                        return since;
                    }
                }
                Ok(None) => panic!("the supervisor stopped before {what}; saw {since:?}"),
                Err(_) => panic!("never {what} within {WAIT:?}; saw {since:?}"),
            }
        }
    }

    /// The relay credential the supervisor kept, once it has one.
    async fn credential(&self) -> RelayCredential {
        eventually("a relay credential", || self.kept.saved.lock().unwrap().first().cloned().ok_or_else(|| format!("none; the machine is {:?}", self.supervisor.state()))).await
    }

    /// The client connections the relay admitted for the machine.
    fn admitted(&self) -> Vec<Attach> {
        self.relay.attaches(&self.machine_id).into_iter().filter(|attach| matches!(attach, Attach::Admitted { .. })).collect()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.supervisor.stop();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_direct_route_drops_and_the_machine_answers_through_the_relay() {
    let mut rig = Rig::start().await;

    // Direct first, and relay access with it (`machine.relayAccess`): this
    // relay's director and cell, an invite used once, and the resume
    // credential behind it installed at the relay.
    rig.until("direct", direct).await;
    let credential = rig.credential().await;
    let info = credential.info.clone();
    assert_eq!(info.relay_host_id, rig.machine_id);
    assert_eq!((info.director_url.as_str(), info.cell_url.as_str()), (rig.relay.director_url().as_str(), rig.relay.cell_url().as_str()), "{info:?}");
    assert_eq!(info.user_id, USER);
    assert!(info.relay_device_id.starts_with("computer-"), "{info:?}");
    let device = info.relay_device_id.clone();
    let invites = rig.relay.invites(&device);
    assert_eq!(invites.len(), 1, "one invite for the computer: {invites:?}");
    assert!(invites[0].1, "the invite was used");
    assert_eq!(rig.relay.credential(&rig.machine_id, &device), Some((token_hash(&credential.resume_token), 1)), "the resume credential behind the invite");
    assert_eq!(try_attach(&rig.relay.cell_url(), &rig.machine_id, &invites[0].0).await, Err(Some(CREDENTIAL_REFUSED)), "an invite is good once");
    assert_eq!(
        rig.relay.attaches(&rig.machine_id),
        vec![Attach::Admitted { relay_device_id: device.clone(), kind: "invite" }, Attach::Refused(CREDENTIAL_REFUSED)],
        "the computer used the relay only to install its credential"
    );
    let registry = std::fs::read_to_string(rig.world.data.join("machine-host/paired-computers.json")).unwrap_or_default();
    assert!(registry.contains(&device), "the machine keeps the computer's relay device: {registry}");
    assert!(!registry.contains(credential.resume_token.as_str()), "never the resume token");

    // A shell, started on the direct route.
    let created = rig.web.ok(&rig.supervisor, "pty.create", json!({ "cols": 80, "rows": 24, "projectId": rig.project_id, "clientRequestId": "pro358-routes-shell" })).await;
    let pty_id = created["ptyId"].as_str().unwrap_or_else(|| panic!("pty.create: {created}")).to_string();
    rig.web.ok(&rig.supervisor, "pty.attach", json!({ "ptyId": pty_id })).await;
    let wrote = rig.web.ok(&rig.supervisor, "pty.write", json!({ "ptyId": pty_id, "data": "echo before-$((40+2))\n", "seq": 1 })).await;
    assert_eq!(wrote["applied"], true, "{wrote}");
    rig.web.output_until(&pty_id, "before-42").await;
    let direct_link = rig.web.link().expect("the web view was told the direct link");

    // The direct route drops: the supervisor carries on through the relay
    // with the resume credential, on a new link.
    rig.direct.drop_route();
    let reached = rig.until("the relay", relay).await;
    assert!(reached.iter().any(reconnecting), "the lost direct link is reported first: {reached:?}");
    assert_eq!(*rig.kept.dropped.lock().unwrap(), 0, "the relay took the resume credential");
    let relay_link = rig.web.link().expect("the web view was told the relay link");
    assert_ne!(relay_link, direct_link, "a new link");
    let admitted = rig.admitted();
    assert_eq!(admitted.last(), Some(&Attach::Admitted { relay_device_id: device.clone(), kind: "resume" }), "{admitted:?}");
    // Each client connection was served on a data leg of its own.
    eventually("a host data leg per client connection", || {
        let (legs, connections) = (rig.relay.data_legs(&rig.machine_id), rig.admitted().len());
        (legs == connections).then_some(()).ok_or_else(|| format!("{legs} data legs for {connections} connections"))
    })
    .await;

    // Calls answer through the relay.
    let listed = rig.web.ok(&rig.supervisor, "session.list", json!({})).await;
    assert!(listed["sessions"].is_array(), "{listed}");
    let described = rig.web.ok(&rig.supervisor, "machine.describe", json!({})).await;
    assert_eq!(described["machineId"], json!(rig.machine_id), "{described}");

    // The shell kept running: attached again through the relay, it replays
    // what it printed and runs the next command.
    let attached = rig.web.ok(&rig.supervisor, "pty.attach", json!({ "ptyId": pty_id })).await;
    let replayed = String::from_utf8_lossy(&STANDARD.decode(attached["data"].as_str().unwrap_or_default()).unwrap_or_default()).into_owned();
    assert!(replayed.contains("before-42"), "the shell's earlier output is replayed: {replayed:?}");
    // Through the relay the machine knows the computer by the same id as on
    // the direct route, so it still controls its terminal (the desktop never
    // takes control back after a route change) and its write numbering
    // carries on: a resent write is dropped, the next one runs.
    assert_eq!(attached["control"], "you", "the computer still controls its terminal: {attached}");
    let resent = rig.web.ok(&rig.supervisor, "pty.write", json!({ "ptyId": pty_id, "data": "echo before-$((40+2))\n", "seq": 1 })).await;
    assert_eq!(resent["applied"], false, "the direct route's write is not typed again: {resent}");
    let wrote = rig.web.ok(&rig.supervisor, "pty.write", json!({ "ptyId": pty_id, "data": "echo after-$((50+8))\n", "seq": 2 })).await;
    assert_eq!(wrote["applied"], true, "{wrote}");
    rig.web.output_until(&pty_id, "after-58").await;
    assert!(relay(&rig.supervisor.state()), "still on the relay: {:?}", rig.supervisor.state());
    assert_eq!(rig.relay.connections(&device), 1, "one relay connection for the computer");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn both_routes_drop_and_the_supervisor_recovers_on_its_own() {
    let mut rig = Rig::start().await;
    rig.until("direct", direct).await;
    rig.credential().await;
    let first_link = rig.web.link().expect("the web view was told the direct link");
    let first_registration = rig.relay.registration(&rig.machine_id).expect("the machine is registered");

    // Both routes drop: the supervisor, and the web view, say reconnecting.
    rig.relay.stop();
    rig.direct.drop_route();
    rig.until("reconnecting", reconnecting).await;
    rig.web.drain();
    assert!(rig.web.told.iter().any(|state| matches!(state, ClientState::Reconnecting { .. })), "the web view was told: {:?}", rig.web.told);
    assert!(!rig.supervisor.send(json!({ "id": "web-offline", "method": "machine.describe", "params": {} })), "no link to send on");

    // The relay comes back first. The runtime registers again and the
    // supervisor reconnects through it by itself, on a new link, with the
    // credential the relay kept.
    rig.relay.start_again();
    rig.until("the relay", relay).await;
    let registration = rig.relay.registration(&rig.machine_id).expect("the machine registered again");
    assert!(registration > first_registration, "a new registration: {first_registration} then {registration}");
    assert_eq!(*rig.kept.dropped.lock().unwrap(), 0, "the relay still took the resume credential");
    let relay_link = rig.web.link().expect("the web view was told the relay link");
    assert_ne!(relay_link, first_link, "a new link");
    let described = rig.web.ok(&rig.supervisor, "machine.describe", json!({})).await;
    assert_eq!(described["machineId"], json!(rig.machine_id), "{described}");

    // Then the direct route: the supervisor's own check finds it and moves
    // the connection there, on a new link, with nothing in between.
    rig.direct.restore();
    let moved = rig.until("direct again", direct).await;
    assert!(moved.iter().all(|state| relay(state) || direct(state)), "nothing between the relay and the direct route: {moved:?}");
    let direct_link = rig.web.link().expect("the web view was told the direct link");
    assert_ne!(direct_link, relay_link, "a new link");
    let described = rig.web.ok(&rig.supervisor, "machine.describe", json!({})).await;
    assert_eq!(described["machineId"], json!(rig.machine_id), "{described}");

    // Both drop again, and this time the direct route comes back first.
    rig.relay.stop();
    rig.direct.drop_route();
    rig.until("reconnecting again", reconnecting).await;
    rig.direct.restore();
    rig.until("direct after the outage", direct).await;
    let last_link = rig.web.link().expect("the web view was told the direct link");
    assert_ne!(last_link, direct_link, "a new link");
    let listed = rig.web.ok(&rig.supervisor, "session.list", json!({})).await;
    assert!(listed["sessions"].is_array(), "{listed}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revoking_the_computer_ends_its_relay_connection_and_the_relay_refuses_it() {
    let mut rig = Rig::start().await;
    rig.until("direct", direct).await;
    let credential = rig.credential().await;
    let device = credential.info.relay_device_id.clone();
    rig.direct.drop_route();
    rig.until("the relay", relay).await;
    eventually("the computer's relay connection", || {
        let open = rig.relay.connections(&device);
        (open == 1).then_some(()).ok_or_else(|| format!("{open} connections"))
    })
    .await;

    // The person on the machine removes the computer while it works through
    // the relay.
    let attachment = rig.serve.control("runtime.attach", json!({ "protocol": 1 }));
    rig.serve.control("runtime.machineHost.revoke", json!({ "epoch": attachment["epoch"], "lease": attachment["lease"], "id": COMPUTER }));

    // The relay connection ends, the machine ends the computer's relay
    // credential (`device-revoke`), and the relay refuses it from then on.
    let ended = rig.until("the relay link to end", |state| !relay(state)).await;
    eventually("device-revoke at the relay", || rig.relay.revoked(&rig.machine_id, &device).then_some(()).ok_or_else(|| format!("{:?}", rig.relay.attaches(&rig.machine_id)))).await;
    eventually("the computer's relay connections to close", || {
        let open = rig.relay.connections(&device);
        (open == 0).then_some(()).ok_or_else(|| format!("{open} still open; the machine is {ended:?}"))
    })
    .await;
    assert_eq!(rig.relay.credential(&rig.machine_id, &device), None, "the resume credential is gone");
    assert_eq!(try_attach(&rig.relay.cell_url(), &rig.machine_id, &credential.resume_token).await, Err(Some(CREDENTIAL_REFUSED)), "the relay refuses the revoked computer");

    // The machine refuses it on the direct route too: access removed, and
    // nothing is retried on either route.
    rig.direct.restore();
    rig.until("access removed", |state| *state == MachineConnectionState::AccessRemoved).await;
    let (attaches, accepted) = (rig.relay.attaches(&rig.machine_id), rig.direct.accepted());
    tokio::time::sleep(Duration::from_secs(5)).await;
    let mut later = Vec::new();
    while let Ok(state) = rig.states.try_recv() {
        later.push(state);
    }
    assert!(later.is_empty(), "nothing after access was removed: {later:?}");
    assert_eq!(rig.supervisor.state(), MachineConnectionState::AccessRemoved);
    assert_eq!(rig.relay.attaches(&rig.machine_id), attaches, "nothing retried through the relay");
    assert_eq!(rig.direct.accepted(), accepted, "nothing retried on the direct route");
    rig.web.drain();
    assert!(matches!(rig.web.told.last(), Some(ClientState::Stopped)), "the web view was told it stopped: {:?}", rig.web.told);
}

/// A real terminal-owned witness for the headless machine's guarded commands
/// (creating a code, Allow), as `machines_e2e.rs` has for its fixture.
#[test]
fn terminal_consent_helper() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    let Ok(socket) = std::env::var("TX_E2E_SOCKET") else { return };
    let command = std::env::var("TX_E2E_COMMAND").unwrap();
    let mut params: Value = serde_json::from_str(&std::env::var("TX_E2E_PARAMS").unwrap()).unwrap();
    let run = std::path::PathBuf::from(std::env::var_os("TX_E2E_RUN").unwrap());
    let _witness = raccoon_lib::serve_cli::consent::witness_for(&command, &run, &mut params).unwrap().unwrap();
    let mut stream = UnixStream::connect(socket).unwrap();
    writeln!(stream, "{}", json!({ "id": "t", "token": std::env::var("TX_E2E_TOKEN").unwrap(), "command": command, "params": params })).unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    println!("TX_E2E_RESPONSE {}", line.trim());
}

/// The person at the machine: `command` from a terminal of their own.
fn person(serve: &Serve, data: &std::path::Path, command: &str, extra: Value) -> Value {
    let attached = serve.control("runtime.attach", json!({ "protocol": 1 }));
    let mut params = json!({ "epoch": attached["epoch"], "lease": attached["lease"] });
    for (name, value) in extra.as_object().unwrap() {
        params[name] = value.clone();
    }
    let response = if raccoon_lib::serve_cli::consent::guards(command) {
        let mut helper = std::process::Command::new(std::env::current_exe().unwrap());
        helper
            .args(["--exact", "terminal_consent_helper", "--nocapture"])
            .env("TX_E2E_SOCKET", &serve.socket)
            .env("TX_E2E_TOKEN", &serve.token)
            .env("TX_E2E_RUN", data.join("run"))
            .env("TX_E2E_COMMAND", command)
            .env("TX_E2E_PARAMS", params.to_string());
        let mut terminal = common::world::Terminal::start(helper);
        assert_eq!(terminal.exit_code(), 0, "terminal helper failed: {}", terminal.screen());
        let screen = terminal.wait_for("test result:");
        let response = screen.lines().find_map(|line| line.split_once("TX_E2E_RESPONSE ").map(|(_, value)| value)).expect("terminal helper response");
        serde_json::from_str(response).expect("terminal helper returned JSON")
    } else {
        serve.try_control(command, params)
    };
    assert_eq!(response["ok"], true, "{command}: {response}");
    response["result"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_relay_only_machine_opens_no_port_and_is_paired_by_code_through_the_relay() {
    use raccoon_lib::machine_wire::MachineCode;
    use raccoon_lib::machine_pair as pair;

    let relay = TestRelay::start();
    let world = AgentWorld::new();
    let secret = random_bytes::<32>();
    let machine_id = relay_host_id_for_secret(secret);
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("link.json");
    let contents = json!({
        "v": 1,
        "hostSecretB64": STANDARD.encode(secret),
        "relayToken": TestRelay::relay_token(&machine_id, RUNTIME_GENERATION),
        "directorUrl": relay.director_url(),
        "attachments": [],
        "revocations": [],
    });
    std::fs::write(&link, contents.to_string()).unwrap();
    // A fresh install after `terminalx-serve login` and the first `pair`: Relay only.
    std::fs::write(world.data.join("settings.json"), json!({ "machines": { "allowOperating": true, "listen": "relay", "allowPublic": false } }).to_string()).unwrap();
    let project = world.project.to_string_lossy().into_owned();
    std::fs::write(world.data.join("projects.json"), json!({ "projects": [{ "path": project, "name": "project", "kind": "git" }] }).to_string()).unwrap();

    let port = free_port();
    let mut command = world.machine_command();
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string()).args(["--runtime-kind", "local", "--relay-link"]).arg(&link);
    let serve = Serve::start(command, &world.data);
    wait_until("the machine's relay registration", || serve.lines.lock().unwrap().iter().rev().find(|line| line["type"] == "relay" && line["status"]["state"] == "registered").cloned());

    // No listener: nothing is bound, on the port it would use or any other.
    let status = common::machine::status(&serve);
    assert_eq!(status["enabled"], true, "{status}");
    assert!(status["listening"].is_null(), "Relay only opens no port: {status}");
    assert_eq!(status["listen"]["choice"], "relay", "{status}");
    assert_eq!(status["listen"]["addresses"], json!([]), "{status}");
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "nothing listens on {port}");
    assert!(status["runsAs"]["user"].as_str().is_some_and(|user| !user.is_empty()), "{status}");

    // Its code names no address, and carries a single-use relay invite.
    let created = person(&serve, &world.data, "runtime.machineHost.createCode", json!({}));
    let code = MachineCode::decode(created["code"].as_str().unwrap()).unwrap();
    assert!(code.direct_endpoints.is_empty(), "no address to advertise: {:?}", code.direct_endpoints);
    let invite = code.relay.clone().expect("a relay invite in the code");
    assert_eq!(invite.relay_host_id, machine_id);
    assert_eq!(relay.invites(&invite.relay_device_id), vec![(invite.invite_token.clone(), false)], "minted for this code's computer, not used yet");
    let code_first_device = invite.relay_device_id.clone();

    // A code replaced before it was used: the relay revokes its invite's device (security review).
    let replaced = person(&serve, &world.data, "runtime.machineHost.createCode", json!({}));
    let replaced = MachineCode::decode(replaced["code"].as_str().unwrap()).unwrap().relay.expect("a relay invite");
    let created = person(&serve, &world.data, "runtime.machineHost.createCode", json!({}));
    let code = MachineCode::decode(created["code"].as_str().unwrap()).unwrap();
    let invite = code.relay.clone().expect("a relay invite in the new code");
    assert_ne!(invite.relay_device_id, replaced.relay_device_id);
    eventually("the replaced code's invite to be revoked at the relay", || {
        relay.revoked(&machine_id, &replaced.relay_device_id).then_some(()).ok_or_else(|| "not yet".to_string())
    })
    .await;
    // So was the first code's, which the second replaced.
    eventually("the first code's invite to be revoked", || {
        relay.revoked(&machine_id, &code_first_device).then_some(()).ok_or_else(|| "not yet".to_string())
    })
    .await;
    assert!(!relay.revoked(&machine_id, &invite.relay_device_id), "the live code's invite is not");

    // A computer nobody is signed in on cannot use the relay, and is told so; the code is still live.
    let client_secret = random_bytes::<32>();
    let (_cancel, cancelled) = tokio::sync::watch::channel(false);
    let signed_out = pair::Me { client_secret: &client_secret, label: "Test MacBook", platform: "macos", relay_user: None };
    let failure = pair::pair(&code, signed_out, Duration::from_secs(30), cancelled.clone()).await.unwrap().err().expect("pairing needs a sign-in");
    assert_eq!(failure.reason, "sign-in-required", "{}", failure.message);
    assert_eq!(relay.invites(&invite.relay_device_id), vec![(invite.invite_token.clone(), false)], "the invite was not spent");

    // Signed in: it asks through the relay, and nothing is granted before Allow.
    let pairing = {
        let code = code.clone();
        tokio::spawn(async move {
            let me = pair::Me { client_secret: &client_secret, label: "Test MacBook", platform: "macos", relay_user: Some(USER) };
            pair::pair(&code, me, WAIT, cancelled).await
        })
    };
    let pending = wait_until("the computer to ask through the relay", || common::machine::status(&serve)["pending"].as_object().map(|pending| Value::Object(pending.clone())));
    assert_eq!(pending["transport"], "relay", "{pending}");
    assert_eq!(pending["label"], "Test MacBook");
    assert_eq!(common::machine::status(&serve)["computers"], json!([]), "nothing is granted before Allow");
    let approved = person(&serve, &world.data, "runtime.machineHost.approve", json!({ "requestId": pending["requestId"] }));
    assert_eq!(approved["approved"], true, "{approved}");
    let paired = pairing.await.unwrap().unwrap().unwrap_or_else(|failure| panic!("pairing through the relay failed: {} ({})", failure.reason, failure.message));
    let credential = paired.relay.expect("a relay credential kept with the pairing");
    assert_eq!(credential.info.relay_device_id, invite.relay_device_id);
    assert!(relay.credential(&machine_id, &invite.relay_device_id).is_some(), "the relay keeps its resume credential's hash");
    let computers = common::machine::status(&serve)["computers"].clone();
    assert_eq!(computers.as_array().map(Vec::len), Some(1), "{computers}");
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "pairing opened no port");

    // From then on its supervisor operates the machine through the relay alone.
    let keypair = host_key(&world.data);
    let kept = Arc::new(Kept {
        target: Mutex::new(Target {
            machine_id: machine_id.clone(),
            public_key_b64: keypair.public_key_b64(),
            direct_endpoints: Vec::new(),
            route: MachineRoute::RelayAndNearby,
            last_route: None,
            last_seen_at: None,
            device_token: Zeroizing::new(code.device_token.clone()),
            client_secret: Zeroizing::new(client_secret),
            label: "Test MacBook".into(),
            platform: "macos".into(),
            relay: Some(credential),
        }),
        saved: Mutex::new(Vec::new()),
        dropped: Mutex::new(0),
    });
    let (events, web_events) = mpsc::unbounded_channel();
    let (states_tx, mut states) = mpsc::unbounded_channel();
    let on_state: OnState = Arc::new(move |view: &MachineConnectionView| {
        let _ = states_tx.send(view.state.clone());
    });
    let supervisor = MachineSupervisor::start(&machine_id, kept.clone(), Arc::new(NetDialer), events, on_state);
    let mut web = Web { events: web_events, messages: Vec::new(), told: Vec::new(), next: 0 };
    let deadline = tokio::time::Instant::now() + WAIT;
    let mut seen = Vec::new();
    loop {
        match tokio::time::timeout_at(deadline, states.recv()).await {
            Ok(Some(state)) if self::relay(&state) => break,
            Ok(Some(state)) => {
                assert!(!direct(&state), "there is no direct route to take: {state:?}");
                seen.push(state);
            }
            _ => panic!("never connected through the relay; saw {seen:?}"),
        }
    }
    let described = web.ok(&supervisor, "machine.describe", json!({})).await;
    assert_eq!(described["machineId"], json!(machine_id));
    assert_eq!(described["listen"]["choice"], "relay", "its page reads where it listens: {described}");
    assert_eq!(described["listen"]["addresses"], json!([]));
    assert_eq!(*kept.dropped.lock().unwrap(), 0, "the relay never refused its credential");

    // The computer that manages it chooses where it listens (`machine.setListen`, machine/9):
    // the runtime writes the setting and opens the listeners with no restart; the relay link stays.
    let chosen = web.ok(&supervisor, "machine.setListen", json!({ "listen": "all", "allowPublic": false })).await;
    assert_eq!((chosen["listen"]["choice"].as_str(), chosen["listen"]["chosen"].as_bool(), chosen["listen"]["allowPublic"].as_bool()), (Some("all"), Some(true), Some(false)), "{chosen}");
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(world.data.join("settings.json")).unwrap()).unwrap();
    assert_eq!((settings["machines"]["listen"].as_str(), settings["machines"]["allowPublic"].as_bool(), settings["machines"]["allowOperating"].as_bool()), (Some("all"), Some(false), Some(true)), "{settings}");
    eventually("the listener to open where it was chosen", || {
        let status = common::machine::status(&serve);
        (status["listen"]["addresses"] == json!([format!("0.0.0.0:{port}")])).then_some(()).ok_or_else(|| status["listen"].to_string())
    })
    .await;
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok(), "it listens on {port} now");
    let refused = web.call(&supervisor, "machine.setListen", json!({ "listen": "everywhere" })).await;
    assert_eq!(refused["ok"], false, "a word it does not know is refused, not read as a choice: {refused}");
    // Back to Relay only: the port closes, and the computer is still served through the relay.
    let back = web.ok(&supervisor, "machine.setListen", json!({ "listen": "relay", "allowPublic": false })).await;
    assert_eq!(back["listen"]["choice"], "relay", "{back}");
    eventually("the listener to close", || std::net::TcpStream::connect(("127.0.0.1", port)).is_err().then_some(()).ok_or_else(|| "still listening".to_string())).await;
    assert_eq!(web.ok(&supervisor, "machine.describe", json!({})).await["listen"]["addresses"], json!([]));
    supervisor.stop();
}
