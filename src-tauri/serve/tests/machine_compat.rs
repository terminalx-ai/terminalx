//! The compatibility matrix (PRO-354, docs/MACHINES.md "Versions and
//! updates"): this build against the previous two released runtimes.
//!
//! - This build's machine client (`MachineSupervisor`) against each released
//!   `terminalx-serve`: it connects and is granted what that runtime offers,
//!   or, against a runtime from before machines, ends in a clean state
//!   (`needsUpdate`, or `offline` when nothing listens) without hanging.
//! - Each release's own `want` (its CAPABILITIES and machine namespaces, read
//!   from its git tag) against this build's runtime: the namespaces granted,
//!   and the calls a desktop of that version makes are answered.
//!
//! `scripts/machine-compat/fetch_releases.py` resolves the releases from this
//! build's version, checks each archive against its SHA256SUMS and writes the
//! manifest this test reads from `TERMINALX_MACHINE_COMPAT`. CI job
//! `machine-compat` runs both. Without the manifest the test is skipped
//! locally and fails under CI.
#![cfg(unix)]

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use common::agent::{AgentWorld, Serve};
use common::machine::{allow, computer, connect, free_port, host_key, listening, pair};
use raccoon_lib::remote::client::{ClientEvent, ClientState};
use raccoon_lib::remote::machine::{MACHINE, UNSERVED, WITHHELD};
use raccoon_lib::remote::machine_client::{
    wanted_capabilities, MachineConnectionState, MachineConnectionView, MachineEnv, MachineRoute, MachineSupervisor, NetDialer, OnState, RelayCredential, RouteKind, RouteUsed, Target, Zeroizing,
};
use raccoon_lib::remote::protocol::{self, AGENT_COMMANDS, CAPABILITIES, PROTOCOL};
use serde::Deserialize;
use serde_json::{json, Value};

const MANIFEST_ENV: &str = "TERMINALX_MACHINE_COMPAT";
const COMPUTER_TOKEN: &str = "the-compat-matrix-device-token-000001";

/// Read calls a desktop makes as it connects, which take no parameters. Each
/// one a release has, in a namespace it is granted, is called on the wire.
const PROBES: [&str; 9] = ["session.list", "runtime.agents", "pty.list", "lifecycle.resources", "pipeline.list", "pipeline.reviewers", "ports.list", "machine.describe", "machine.projects"];

/// Probes that must succeed with no parameters, not merely be answered, for
/// a desktop granted machine/1.
const MUST_SUCCEED: [&str; 3] = ["session.list", "machine.describe", "machine.projects"];

/// Answers that mean the runtime does not serve the call at all.
const NOT_SERVED: [&str; 3] = ["method_not_found", "capability_not_granted", "hello_required"];

#[derive(Debug, Deserialize)]
struct Manifest {
    build: String,
    releases: Vec<Release>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    tag: String,
    version: String,
    binary: PathBuf,
    binary_sha256: String,
    protocol: String,
    capabilities: Vec<String>,
    machine: Vec<String>,
    withheld: Vec<String>,
    want: Vec<String>,
    machine_host: bool,
    methods: Vec<ReleaseMethod>,
}

#[derive(Debug, Deserialize)]
struct ReleaseMethod {
    name: String,
    capability: String,
}

impl Release {
    /// What its runtime offers a paired computer on the direct listener: a
    /// machine's namespaces (`protocol::served(true)` at its tag), less what
    /// a machine withholds, and before [`AGENT_COMMANDS_SERVED_DIRECTLY`]
    /// less [`AGENT_COMMANDS`].
    fn offered_to_a_computer(&self) -> BTreeSet<String> {
        let agent_commands = version_triple(&self.version) >= AGENT_COMMANDS_SERVED_DIRECTLY;
        self.capabilities
            .iter()
            .filter(|capability| !self.withheld.contains(capability) && (agent_commands || capability.as_str() != AGENT_COMMANDS))
            .chain(&self.machine)
            .cloned()
            .collect()
    }

    /// Its `terminalx-serve`, started the way that version's desktop starts
    /// it (`--runtime-kind local`), in the throwaway world. The binary is
    /// hashed again first: only the one the script checked is ever run.
    fn command(&self, world: &AgentWorld) -> Command {
        let actual = sha256(&self.binary);
        assert_eq!(actual, self.binary_sha256, "{}: {} is not the binary the script checked against SHA256SUMS", self.tag, self.binary.display());
        let mut command = Command::new(&self.binary);
        let path = format!("{}:{}", world.bin.display(), std::env::var("PATH").unwrap_or_default());
        command
            .args(["--runtime-kind", "local", "--data-dir"])
            .arg(&world.data)
            .env("HOME", &world.home)
            .env("PATH", path)
            .env("CLAUDE_CONFIG_DIR", world.home.join(".claude"))
            .env_remove("TERMINALX_HOME")
            .env_remove("TERMINALX_LOCAL_DESKTOP")
            .env_remove("TERMINALX_LOCAL_APPLICATION")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
            .env("RUST_LOG", "info")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        command
    }
}

fn sha256(path: &Path) -> String {
    for (tool, args) in [("shasum", &["-a", "256"][..]), ("sha256sum", &[][..])] {
        if let Ok(output) = Command::new(tool).args(args).arg(path).output() {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout).split_whitespace().next().unwrap_or_default().to_lowercase();
            }
        }
    }
    panic!("neither shasum nor sha256sum could hash {}", path.display());
}

/// This build's version: the desktop crate's, which the releases carry.
fn build_version() -> String {
    let cargo = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../Cargo.toml")).unwrap();
    let mut in_package = false;
    for line in cargo.lines().map(str::trim) {
        if line.starts_with('[') {
            in_package = line == "[package]";
        } else if let (true, Some(value)) = (in_package, line.strip_prefix("version = \"")) {
            return value.trim_end_matches('"').to_string();
        }
    }
    panic!("no [package] version in src-tauri/Cargo.toml");
}

fn version_triple(version: &str) -> (u64, u64, u64) {
    let parts: Vec<u64> = version.split('.').map(|part| part.parse().unwrap_or_else(|_| panic!("not a release version: {version}"))).collect();
    assert_eq!(parts.len(), 3, "not a release version: {version}");
    (parts[0], parts[1], parts[2])
}

/// The manifest, or None to skip (no manifest, and not under CI).
fn manifest() -> Option<Manifest> {
    let Some(path) = std::env::var_os(MANIFEST_ENV) else {
        assert!(std::env::var_os("CI").is_none(), "{MANIFEST_ENV} is not set: run scripts/machine-compat/fetch_releases.py first (CI job machine-compat)");
        eprintln!("skipped: {MANIFEST_ENV} is not set (scripts/machine-compat/fetch_releases.py writes it)");
        return None;
    };
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", PathBuf::from(&path).display()))).unwrap();
    let build = build_version();
    assert_eq!(manifest.build, build, "the manifest was made for another build");
    assert_eq!(manifest.releases.len(), 2, "the matrix runs against the previous two releases");
    let versions: Vec<_> = manifest.releases.iter().map(|release| version_triple(&release.version)).collect();
    assert!(versions[0] > versions[1], "the two releases, newest first: {versions:?}");
    // The newer may have this build's version: main keeps the version of the
    // release it last shipped until the next one (fetch_releases.py).
    assert!(versions[0] <= version_triple(&build), "both releases come before this build ({build})");
    for release in &manifest.releases {
        assert_eq!(release.tag, format!("v{}", release.version));
        assert!(!release.capabilities.is_empty() && !release.methods.is_empty(), "{}: read nothing from its tag", release.tag);
    }
    Some(manifest)
}

/// The first release whose machine serves [`AGENT_COMMANDS`] to a computer
/// that reaches it only directly (PRO-358): with no relay link it opens its
/// agent tabs itself when it builds the direct listener's RPC
/// (`machine_host.rs`, `Parts::agents`). An earlier release built that RPC
/// without agent tabs, kept no command receipts and did not offer them.
const AGENT_COMMANDS_SERVED_DIRECTLY: (u64, u64, u64) = (0, 2, 35);

/// What this build's runtime offers a paired computer on the direct
/// listener: every namespace a machine serves, agent commands among them.
fn offered_directly() -> BTreeSet<String> {
    protocol::served(true).into_iter().map(str::to_string).collect()
}

fn set(names: impl IntoIterator<Item = impl ToString>) -> BTreeSet<String> {
    names.into_iter().map(|name| name.to_string()).collect()
}

/// The released runtime said it is the version it was downloaded as.
fn assert_ready_version(serve: &Serve, release: &Release) {
    let ready = serve.lines.lock().unwrap().iter().find(|line| line["type"] == "ready").cloned().expect("a ready line");
    assert_eq!(ready["version"], release.version.as_str(), "{}: {ready}", release.tag);
}

// ---------------------------------------------------------------------------
// This build's machine client against each released runtime.
// ---------------------------------------------------------------------------

/// The operating computer's record, token and key, kept in memory.
struct Paired {
    target: std::sync::Mutex<Target>,
}

impl MachineEnv for Paired {
    fn target(&self) -> anyhow::Result<Target> {
        Ok(self.target.lock().unwrap().clone())
    }
    fn signed_in_user(&self) -> Option<String> {
        None
    }
    fn described(&self, _described: &Value, route: &RouteUsed) {
        self.target.lock().unwrap().last_route = Some(route.clone());
    }
    fn save_relay(&self, _credential: &RelayCredential) -> anyhow::Result<()> {
        anyhow::bail!("no relay in the compatibility matrix")
    }
    fn drop_relay(&self) {}
}

/// What the supervisor tells the desktop: its machine states and the web
/// view's events.
struct Heard {
    states: tokio::sync::mpsc::UnboundedReceiver<MachineConnectionState>,
    client: tokio::sync::mpsc::UnboundedReceiver<ClientEvent>,
    seen: Vec<MachineConnectionState>,
}

impl Heard {
    async fn state(&mut self, what: &str, within: Duration, wanted: impl Fn(&MachineConnectionState) -> bool) -> MachineConnectionState {
        let seen = &mut self.seen;
        let states = &mut self.states;
        let found = tokio::time::timeout(within, async {
            loop {
                let state = states.recv().await.expect("the supervisor runs");
                seen.push(state.clone());
                if wanted(&state) {
                    return state;
                }
            }
        })
        .await;
        found.unwrap_or_else(|_| panic!("never {what}; saw {:?}", self.seen))
    }

    /// The capabilities of the web view's last `connected`, and every message so far.
    fn drain(&mut self) -> (Option<Vec<String>>, Vec<Value>) {
        let (mut capabilities, mut messages) = (None, Vec::new());
        while let Ok(event) = self.client.try_recv() {
            match event {
                ClientEvent::State(ClientState::Connected { capabilities: granted, .. }) => capabilities = Some(granted),
                ClientEvent::State(_) => {}
                ClientEvent::Message(message) => messages.push(message),
            }
        }
        (capabilities, messages)
    }
}

fn supervise(machine_id: &str, public_key_b64: String, port: u16) -> (MachineSupervisor, Heard) {
    let env = Arc::new(Paired {
        target: std::sync::Mutex::new(Target {
            machine_id: machine_id.to_string(),
            public_key_b64,
            direct_endpoints: vec![format!("ws://127.0.0.1:{port}/machine/1")],
            route: MachineRoute::RelayAndNearby,
            last_route: None,
            last_seen_at: None,
            device_token: Zeroizing::new(COMPUTER_TOKEN.into()),
            client_secret: Zeroizing::new([7u8; 32]),
            label: "Compat MacBook".into(),
            platform: "macos".into(),
            relay: None,
        }),
    });
    let (events, client) = tokio::sync::mpsc::unbounded_channel();
    let (states_tx, states) = tokio::sync::mpsc::unbounded_channel();
    let on_state: OnState = Arc::new(move |view: &MachineConnectionView| {
        let _ = states_tx.send(view.state.clone());
    });
    let supervisor = MachineSupervisor::start(machine_id, env, Arc::new(NetDialer), events, on_state);
    (supervisor, Heard { states, client, seen: Vec::new() })
}

/// The supervisor stops when asked, whatever state it ended in.
async fn stops_cleanly(supervisor: &MachineSupervisor, heard: &mut Heard, tag: &str) {
    supervisor.stop();
    heard.state(&format!("idle after stop against {tag}"), Duration::from_secs(20), |state| *state == MachineConnectionState::Idle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn this_builds_machine_client_against_each_previous_released_runtime() {
    let Some(manifest) = manifest() else { return };
    for release in &manifest.releases {
        client_against_release(release).await;
    }
}

async fn client_against_release(release: &Release) {
    let tag = release.tag.as_str();
    let world = AgentWorld::new();
    let port = free_port();
    // Paired and switched on, as PRO-342's pairing leaves a machine; a
    // runtime from before machines reads neither.
    pair(&world.data, "macbook", COMPUTER_TOKEN, None);
    allow(&world.data, true);
    let mut command = release.command(&world);
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
    let mut serve = Serve::start(command, &world.data);
    assert_ready_version(&serve, release);

    if !release.machine_host {
        // Before machines: nothing listens, and this build's client ends in
        // a state the desktop shows (offline), never hanging in between.
        std::thread::sleep(Duration::from_secs(2));
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "{tag}: a runtime from before machines opened the machine port");
        let machine_id = "a-machine-from-before-machines";
        let (supervisor, mut heard) = supervise(machine_id, raccoon_lib::relay_e2ee::HostKeypair::from_secret([3u8; 32]).public_key_b64(), port);
        let ended = heard
            // Each round starts by reporting "trying now" (`retry_in_ms: 0`),
            // which past 30 s reads offline too; the state to check is the
            // wait between rounds, which names when it tries again.
            .state(&format!("offline against {tag}"), Duration::from_secs(90), |state| matches!(state, MachineConnectionState::Offline { retry_in_ms, .. } if *retry_in_ms > 0) || matches!(state, MachineConnectionState::NeedsUpdate { .. }))
            .await;
        if let MachineConnectionState::Offline { retry_in_ms, .. } = ended {
            assert!(retry_in_ms > 0, "{tag}: offline names when it tries again");
        }
        assert!(!heard.seen.iter().any(MachineConnectionState::is_connected), "{tag}: connected to a runtime with no machine host: {:?}", heard.seen);
        let (capabilities, _) = heard.drain();
        assert!(capabilities.is_none(), "{tag}: the web view was told connected");
        stops_cleanly(&supervisor, &mut heard, tag).await;
        assert!(serve.child.try_wait().unwrap().is_none(), "{tag}: the released runtime kept running throughout");
        serve.kill();
        return;
    }

    listening(&serve);
    let keypair = host_key(&world.data);
    let machine_id = keypair.host_id();
    let (supervisor, mut heard) = supervise(machine_id.as_str(), keypair.public_key_b64(), port);
    let offered = release.offered_to_a_computer();
    let wanted = set(wanted_capabilities());
    let expected: BTreeSet<String> = offered.intersection(&wanted).cloned().collect();

    if !offered.contains(MACHINE) {
        // A listener that does not serve this build's machine namespace.
        heard.state(&format!("needsUpdate against {tag}"), Duration::from_secs(60), |state| matches!(state, MachineConnectionState::NeedsUpdate { .. })).await;
        stops_cleanly(&supervisor, &mut heard, tag).await;
        return;
    }

    heard
        .state(&format!("connected directly to {tag}"), Duration::from_secs(60), |state| matches!(state, MachineConnectionState::Direct { route, .. } if route.kind == RouteKind::Lan))
        .await;
    let (capabilities, _) = heard.drain();
    let granted = set(capabilities.unwrap_or_else(|| panic!("{tag}: the web view was not told connected")));
    assert_eq!(granted, expected, "{tag}: this build's client is granted what the release offers of what it wants");
    assert!(granted.contains(MACHINE));

    // The web view's own hello and first calls are answered through the link.
    let mut want = wanted_capabilities();
    want.sort_unstable();
    assert!(supervisor.send(json!({ "id": "web-hello", "method": "rpc.hello", "params": { "protocol": PROTOCOL, "want": want, "client": { "app": "terminalx-desktop", "version": build_version() } } })));
    assert!(supervisor.send(json!({ "id": "web-list", "method": "session.list", "params": {} })));
    assert!(supervisor.send(json!({ "id": "web-describe", "method": "machine.describe", "params": {} })));
    let answers = tokio::time::timeout(Duration::from_secs(30), async {
        let mut answers = Vec::new();
        loop {
            let (_, messages) = heard.drain();
            answers.extend(messages.into_iter().filter(|message| message["id"].as_str().is_some_and(|id| id.starts_with("web-"))));
            if answers.len() >= 3 {
                return answers;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{tag}: the web view's calls were not all answered"));
    for answer in &answers {
        assert_eq!(answer["ok"], true, "{tag}: {answer}");
    }
    let hello = answers.iter().find(|answer| answer["id"] == "web-hello").unwrap();
    assert_eq!(set(hello["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str)), expected, "{tag}: {hello}");
    assert_eq!(hello["result"]["runtime"]["version"], release.version.as_str(), "{tag}: {hello}");
    let described = answers.iter().find(|answer| answer["id"] == "web-describe").unwrap();
    assert_eq!(described["result"]["machineId"], machine_id.as_str(), "{tag}");
    stops_cleanly(&supervisor, &mut heard, tag).await;
    serve.kill();
}

// ---------------------------------------------------------------------------
// Each release's desktop against this build's runtime.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn each_previous_releases_want_is_served_by_this_builds_runtime() {
    let Some(manifest) = manifest() else { return };
    let world = AgentWorld::new();
    let port = free_port();
    pair(&world.data, "macbook", COMPUTER_TOKEN, None);
    allow(&world.data, true);
    let mut command = world.machine_command();
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
    let serve = Serve::start(command, &world.data);
    listening(&serve);
    let keypair = host_key(&world.data);
    let offered = offered_directly();
    let known: BTreeSet<String> = set(CAPABILITIES).union(&offered).cloned().collect();

    for release in &manifest.releases {
        let tag = release.tag.as_str();
        assert_eq!(release.protocol, PROTOCOL, "{tag} speaks another workspace protocol");

        // A newer machine keeps serving the older namespaces: none a release
        // asks for has been dropped from this build.
        let want = set(&release.want);
        let dropped: Vec<_> = want.difference(&known).collect();
        assert!(dropped.is_empty(), "{tag} asks for namespaces this build no longer knows: {dropped:?}");

        let mut desktop = computer(connect(port, &keypair.public_key_b64(), COMPUTER_TOKEN).await);
        let hello = desktop
            .call("rpc.hello", json!({ "protocol": release.protocol, "want": release.want, "client": { "app": "terminalx-desktop", "version": release.version } }))
            .await;
        assert_eq!(hello["ok"], true, "{tag}: {hello}");
        let granted = set(hello["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str));
        let expected: BTreeSet<String> =
            want.iter().filter(|namespace| !WITHHELD.contains(&namespace.as_str())).cloned().collect();
        assert_eq!(granted, expected, "{tag}: granted everything it wants but what a machine withholds");
        assert_eq!(granted, want.intersection(&offered).cloned().collect::<BTreeSet<_>>(), "{tag}");
        if want.contains(MACHINE) {
            assert!(granted.contains(MACHINE), "{tag}: a machine-era desktop is granted {MACHINE}");
        }

        // Every call it can make in a granted namespace is still one this
        // runtime serves there (or one a machine never served).
        for method in release.methods.iter().filter(|method| granted.contains(&method.capability)) {
            if UNSERVED.contains(&method.name.as_str()) {
                continue;
            }
            let served = protocol::find_method(&method.name).unwrap_or_else(|| panic!("{tag} calls {}, which this build dropped", method.name));
            assert_eq!(served.capability, method.capability, "{tag}: {} moved namespace", method.name);
        }

        // On the wire: the reads it makes as it connects are answered. A
        // machine-era desktop gets them; one from before machines was not
        // granted machine/1, so a call that needs a project is refused as
        // docs/MACHINES.md "Project scoping" says, naming machine/1, and
        // every other refusal is a real answer, never "not served".
        let machine_era = granted.contains(MACHINE);
        let mut probed = 0;
        for name in PROBES {
            let Some(method) = release.methods.iter().find(|method| method.name == name) else { continue };
            if !granted.contains(&method.capability) || UNSERVED.contains(&name) {
                continue;
            }
            let answer = desktop.call(name, json!({})).await;
            probed += 1;
            if answer["ok"] == true {
                continue;
            }
            assert!(!(machine_era && MUST_SUCCEED.contains(&name)), "{tag}: {name}: {answer}");
            let code = answer["error"]["code"].as_str().unwrap_or_default();
            if code == "capability_not_granted" {
                let message = answer["error"]["message"].as_str().unwrap_or_default();
                assert!(!machine_era && message.contains(MACHINE), "{tag}: {name} refused although {} was granted: {answer}", method.capability);
            } else {
                assert!(!NOT_SERVED.contains(&code), "{tag}: {name} was not served: {answer}");
            }
        }
        assert!(probed > 0, "{tag}: no read call was probed");

        // What a machine withholds is refused as not granted, not left unanswered.
        for namespace in want.iter().filter(|namespace| WITHHELD.contains(&namespace.as_str())) {
            let Some(method) = release.methods.iter().find(|method| &method.capability == namespace && protocol::find_method(&method.name).is_some()) else { continue };
            let answer = desktop.call(&method.name, json!({})).await;
            assert_eq!(answer["ok"], false, "{tag}: {} on a machine: {answer}", method.name);
            assert_eq!(answer["error"]["code"], "capability_not_granted", "{tag}: {}: {answer}", method.name);
        }

        drop(desktop);

        // A desktop of that version sharing nothing with a machine (only
        // what a machine withholds) is told to update, not left waiting.
        let mut other = computer(connect(port, &keypair.public_key_b64(), COMPUTER_TOKEN).await);
        let refused = other.call("rpc.hello", json!({ "protocol": release.protocol, "want": WITHHELD, "client": { "app": "terminalx-desktop", "version": release.version } })).await;
        assert_eq!(refused["ok"], false, "{tag}: {refused}");
        assert_eq!(refused["error"]["code"], "update_required", "{tag}: {refused}");
        // PRO-354: the refusal says which version this runtime is and what it
        // serves, so that desktop can tell which side has to update.
        assert_eq!(refused["error"]["data"]["runtimeVersion"], build_version().as_str(), "{tag}: {refused}");
        let named = refused["error"]["data"]["offered"].as_array().unwrap_or_else(|| panic!("{tag}: no offered list: {refused}"));
        assert_eq!(set(named.iter().filter_map(Value::as_str)), offered, "{tag}: {refused}");
    }
    let mut serve = serve;
    assert!(serve.child.try_wait().unwrap().is_none(), "this build's runtime kept running through every release's calls");
}
