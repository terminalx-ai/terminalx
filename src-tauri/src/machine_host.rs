//! The runtime accepts operating computers itself (PRO-341, docs/MACHINES.md
//! decision 4 and "How PRO-341 builds it"): on the direct listener, and
//! through the relay, with the machine's one host key ([`key`]) and a
//! registry of paired computers ([`registry`]) kept apart from the phones'
//! `devices.json`. What it says to the window is in `crate::machine_wire`.
//!
//! Nothing listens and nothing is registered until `machines.allowOperating`
//! is on. While it is on the runtime is a standing service, so a computer can
//! connect with the window closed. Data privacy mode turns it off.

pub(crate) mod activity;
pub(crate) mod direct;
pub(crate) mod key;
pub(crate) mod pairing;
#[cfg(unix)]
pub(crate) mod phones;
pub mod registry;
#[cfg(all(test, feature = "desktop"))]
mod pairing_tests;
#[cfg(all(test, feature = "desktop"))]
mod security_tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};

use crate::control::ControlError;
use crate::machine_wire::{self as wire, ComputerRoute, ComputerSummary, HostKeyState, Status};
use self::pairing::{Asking, Decision, Pairing};
use crate::relay_e2ee::HostKeypair;
use crate::remote::server::WorkspaceRpc;
use crate::sink::EventSink;

/// The machine host's directory in the runtime's data directory.
pub(crate) const DIR: &str = "machine-host";

/// Directly reachable on this port, which phones already use.
pub const PORT: u16 = 6768;

/// How often the host checks what it cannot be told about: a port the
/// window is still releasing, an attachment that lapsed.
const TICK: Duration = Duration::from_secs(1);
/// Settings are read again every this many ticks without a change event.
const SETTINGS_EVERY: u32 = 15;

/// Held while a computer is connected and `pairing.keepAwake` is on.
pub const COMPUTER_CONNECTED: crate::power::Reason = crate::power::Reason::new("A computer is operating this Mac through TerminalX");

/// A route as the activity log names it.
fn route_name(route: ComputerRoute) -> &'static str {
    match route {
        ComputerRoute::Lan => "lan",
        ComputerRoute::Tailscale => "tailscale",
        ComputerRoute::Relay => "relay",
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Make `path` a directory only this user can enter, or check that it is one.
pub(crate) fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = std::fs::symlink_metadata(path)?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
            bail!("{} is not a directory of this user", path.display());
        }
        if metadata.mode() & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// What the runtime gives the host to build its one workspace RPC from.
pub struct Parts {
    pub sink: Arc<dyn EventSink>,
    pub terminals: Arc<crate::pty::Terminals>,
    pub sessions: crate::session::SessionManager,
    /// Opens the agent tabs this machine serves its computers when it builds
    /// its own RPC: with no relay link, nothing else gives it send, steer,
    /// stop, interrupt and decisions as live calls (decision 3). Called once,
    /// when the switch is first on, so a runtime that hosts no one opens none.
    pub agents: Option<OpenAgents>,
}

/// See [`Parts::agents`].
pub type OpenAgents = Arc<dyn Fn() -> Result<Arc<crate::cloud_agents::CloudAgents>> + Send + Sync>;

enum Rpc {
    /// Built here once the key is known.
    Build(Box<Parts>),
    /// The relay host builds it (`remote::host::serve_machine`) and hands it
    /// over: every route serves the same one.
    Awaiting,
    Ready(Arc<WorkspaceRpc>),
}

impl Rpc {
    fn is_build(&self) -> bool {
        matches!(self, Rpc::Build(_))
    }
}

/// The window's phone route.
struct PhoneRoute {
    attachment: Arc<crate::local_runtime::Attachment>,
    lease: String,
    socket: PathBuf,
}

/// One open connection of a paired computer.
struct Tracked {
    id: u64,
    cancel: mpsc::UnboundedSender<()>,
    route: ComputerRoute,
}

#[derive(Default)]
struct State {
    /// `machines.allowOperating`, as last read.
    allowed: bool,
    /// Allowed, and data privacy mode is off.
    enabled: bool,
    keep_awake: bool,
    keypair: Option<HostKeypair>,
    key_error: Option<String>,
    listening: Option<direct::Listening>,
    bind_error: Option<String>,
    /// The bind error is only the port being in use, which frees up.
    port_busy: bool,
    phone_route: Option<PhoneRoute>,
    /// Open connections per paired computer, closed on revocation or when
    /// the switch goes off, oldest first. The id tells them apart; the route
    /// is how each reached this machine.
    connections: HashMap<String, Vec<Tracked>>,
    /// Connected computers' names, for the activity log's "disconnected".
    labels: HashMap<String, String>,
    /// While a computer is connected: the projects as last seen (path to
    /// name), so the activity log notes one added or removed meanwhile.
    projects_seen: Option<HashMap<String, String>>,
    /// Phones passed to the window from the direct listener. Each holds the
    /// port, so they close with the listener.
    phones: HashMap<u64, mpsc::UnboundedSender<()>>,
    awake: Option<crate::power::Assertion>,
    last: Option<Status>,
    /// The live code, the computer waiting for Allow, the attempt limit.
    pairing: Pairing,
}

pub struct MachineHost {
    data_dir: PathBuf,
    keys: key::KeyStore,
    registry: registry::Registry,
    /// What operating computers did here (PRO-357).
    activity: activity::Log,
    sink: Arc<dyn EventSink>,
    rpc: Mutex<Rpc>,
    state: Mutex<State>,
    lifetime: Option<Arc<crate::local_runtime::Lifetime>>,
    port: u16,
    wake: Notify,
    settings_changed: Notify,
    next_connection: std::sync::atomic::AtomicU64,
    /// The machine's relay registration, when it serves with `--relay-link`
    /// (PRO-345): paired computers get relay access through it.
    relay: Mutex<Option<std::sync::Weak<crate::remote::host::RelayHost>>>,
    /// Phones it serves itself while no window takes them (PRO-359). Only a
    /// runtime with an owner lifetime serves them.
    #[cfg(unix)]
    phones: OnceLock<Arc<phones::Phones>>,
}

static INSTALLED: OnceLock<Arc<MachineHost>> = OnceLock::new();

/// The runtime's machine host, once it started.
pub fn installed() -> Option<&'static Arc<MachineHost>> {
    INSTALLED.get()
}

/// The listener's port: [`PORT`], or `TERMINALX_MACHINE_HOST_PORT` for tests.
fn configured_port() -> u16 {
    match std::env::var(wire::PORT_ENV) {
        Ok(value) => value.parse().unwrap_or_else(|_| {
            log::warn!("machine host: ignoring {}={value}", wire::PORT_ENV);
            PORT
        }),
        Err(_) => PORT,
    }
}

impl MachineHost {
    /// Start the host for a local runtime and install it for the control
    /// socket. `awaiting_rpc`: the relay host will hand over its RPC.
    /// `link_secret`: the relay link's host key, which a runtime with no key
    /// of its own yet keeps as the machine's, before anything can make one.
    pub fn start(
        data_dir: &Path,
        parts: Parts,
        lifetime: Option<Arc<crate::local_runtime::Lifetime>>,
        awaiting_rpc: bool,
        link_secret: Option<[u8; 32]>,
    ) -> Arc<Self> {
        let sink = parts.sink.clone();
        #[cfg(unix)]
        let sessions = parts.sessions.clone();
        let host = Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            keys: key::KeyStore::for_runtime(data_dir),
            registry: registry::Registry::in_data_dir(data_dir),
            activity: activity::Log::in_dir(&data_dir.join(DIR)),
            sink: sink.clone(),
            rpc: Mutex::new(if awaiting_rpc { Rpc::Awaiting } else { Rpc::Build(Box::new(parts)) }),
            state: Mutex::new(State::default()),
            lifetime,
            port: configured_port(),
            wake: Notify::new(),
            settings_changed: Notify::new(),
            next_connection: std::sync::atomic::AtomicU64::new(1),
            relay: Mutex::new(None),
            #[cfg(unix)]
            phones: OnceLock::new(),
        });
        let weak = Arc::downgrade(&host);
        sink.listen(
            "settings_file_changed",
            Box::new(move |_| {
                if let Some(host) = weak.upgrade() {
                    host.settings_changed.notify_one();
                }
            }),
        );
        // A project added or removed while a computer is connected is noted.
        let weak = Arc::downgrade(&host);
        sink.listen(
            "projects_changed",
            Box::new(move |_| {
                if let Some(host) = weak.upgrade() {
                    host.settings_changed.notify_one();
                }
            }),
        );
        if let Some(secret) = link_secret {
            if let Err(error) = host.seed_key(secret) {
                log::warn!("machine host: keep the relay link's host key: {error:#}");
            }
        }
        #[cfg(unix)]
        if let Some(lifetime) = host.lifetime.clone() {
            let weak = Arc::downgrade(&host);
            match phones::Phones::new(sessions, sink.clone(), lifetime, move || {
                if let Some(host) = weak.upgrade() {
                    host.wake.notify_one();
                }
            }) {
                Ok(phones) => {
                    let _ = host.phones.set(phones);
                }
                Err(error) => log::warn!("machine host: phones cannot be served here: {error:#}"),
            }
        }
        if INSTALLED.set(host.clone()).is_err() {
            log::warn!("machine host: a host was already installed in this process");
        }
        tokio::spawn(host.clone().supervise());
        host
    }

    /// The relay host's RPC, which the direct listener serves too.
    pub fn use_rpc(self: &Arc<Self>, rpc: Arc<WorkspaceRpc>) {
        rpc.set_machine_access(Arc::new(HostAccess::new(self)));
        *self.rpc.lock().unwrap() = Rpc::Ready(rpc);
        self.wake.notify_one();
    }

    /// The relay host this machine registers through (`--relay-link`):
    /// paired computers get relay access through it, and a revoked one's
    /// relay credential ends with it.
    pub fn use_relay(&self, relay: &Arc<crate::remote::host::RelayHost>) {
        *self.relay.lock().unwrap() = Some(Arc::downgrade(relay));
    }

    fn relay(&self) -> Option<Arc<crate::remote::host::RelayHost>> {
        self.relay.lock().unwrap().as_ref().and_then(std::sync::Weak::upgrade)
    }

    /// The direct listener's port, while it listens.
    pub(crate) fn listening_port(&self) -> Option<u16> {
        self.state.lock().unwrap().listening.as_ref().map(|listening| listening.address.port())
    }

    /// The direct listener's addresses (`machine/2` `directEndpoints`).
    fn direct_endpoints(&self) -> Vec<String> {
        let port = self.state.lock().unwrap().listening.as_ref().map(|listening| listening.address.port());
        port.map(|port| crate::direct_endpoints::machine_endpoints(port, wire::MACHINE_PATH)).unwrap_or_default()
    }

    pub fn registry(&self) -> &registry::Registry {
        &self.registry
    }

    pub fn activity(&self) -> &activity::Log {
        &self.activity
    }

    /// The machine's host key, once loaded.
    pub fn keypair(&self) -> Option<HostKeypair> {
        self.state.lock().unwrap().keypair.as_ref().map(|keypair| HostKeypair::from_secret(*keypair.secret()))
    }

    /// The key, loading it (and making it where this runtime owns it) now.
    /// For a relay link that starts before the switch is read.
    pub fn load_key(&self) -> Result<Option<HostKeypair>> {
        let loaded = self.keys.load()?;
        if let Some(keypair) = &loaded {
            self.state.lock().unwrap().keypair = Some(HostKeypair::from_secret(*keypair.secret()));
        }
        Ok(loaded)
    }

    /// A machine whose file store has no key yet takes `secret` as its key
    /// (a server first started with `--relay-link`). Whether it did.
    pub fn seed_key(&self, secret: [u8; 32]) -> Result<bool> {
        if self.keys.needs_window() || self.keys.exists()? {
            return Ok(false);
        }
        self.keys.seed(secret)?;
        self.state.lock().unwrap().keypair = Some(HostKeypair::from_secret(secret));
        Ok(true)
    }

    /// Whether the runtime must keep running: the switch is on (a standing
    /// service), or a computer is still connected.
    pub fn keeps_runtime(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.enabled || state.connections.values().any(|connections| !connections.is_empty())
    }

    pub fn enabled(&self) -> bool {
        self.state.lock().unwrap().enabled
    }

    /// The paired computers connected now, but the one connected as
    /// `caller` (its id on the direct route, its relay device id on the
    /// relay): `machine/3`'s `otherComputers`. Blocking: reads the registry.
    pub(crate) fn connected_others(&self, caller: Option<&str>) -> Vec<crate::remote::machine_update::OtherComputer> {
        let connected: Vec<String> = self.state.lock().unwrap().connections.iter().filter(|(_, connections)| !connections.is_empty()).map(|(id, _)| id.clone()).collect();
        if connected.is_empty() {
            return Vec::new();
        }
        let computers = self.registry.list().unwrap_or_else(|error| {
            log::warn!("machine host: read paired computers: {error:#}");
            Vec::new()
        });
        computers
            .into_iter()
            .filter(|computer| connected.contains(&computer.id))
            .filter(|computer| caller.is_none_or(|caller| computer.id != caller && computer.relay_device_id.as_deref() != Some(caller)))
            .map(|computer| crate::remote::machine_update::OtherComputer { id: computer.id, label: computer.label })
            .collect()
    }

    /// A desktop window is attached and serves this runtime's window calls.
    pub(crate) fn window_available(&self) -> bool {
        #[cfg(unix)]
        {
            self.lifetime.as_ref().is_some_and(|lifetime| lifetime.window.available())
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    pub fn status(&self) -> Status {
        let state = self.state.lock().unwrap();
        self.status_of(&state)
    }

    fn status_of(&self, state: &State) -> Status {
        let computers = self
            .registry
            .list()
            .unwrap_or_default()
            .into_iter()
            .map(|computer| {
                // The newest connection is the one it is using now.
                let route = state.connections.get(&computer.id).and_then(|connections| connections.last()).map(|tracked| tracked.route);
                ComputerSummary {
                    connected: route.is_some(),
                    key_id: computer.client_public_key_b64.as_deref().and_then(wire::key_id_of),
                    route,
                    disconnected_at: computer.disconnected_at,
                    id: computer.id,
                    label: computer.label,
                    platform: computer.platform,
                    approved_at: computer.approved_at,
                    last_seen_at: computer.last_seen_at,
                }
            })
            .collect();
        let host_key = match (&state.keypair, &state.key_error) {
            (Some(_), _) => HostKeyState::Ready,
            (None, Some(_)) => HostKeyState::Error,
            // A file key is made on the first pass with the switch on; a
            // desktop-launched runtime waits for the window's.
            (None, None) => HostKeyState::Needed,
        };
        let error = if !state.enabled {
            None
        } else {
            state.key_error.clone().or_else(|| state.bind_error.clone())
        };
        // A key in error or a port it cannot bind leaves the window serving
        // phones on the port; a port still in use is the window's to give up.
        let takes_port = state.enabled && host_key != HostKeyState::Error && (state.bind_error.is_none() || state.port_busy);
        let (pending, code, paused_until) = state.pairing.view(now_ms());
        Status {
            enabled: state.enabled,
            host_key,
            machine_id: state.keypair.as_ref().map(HostKeypair::host_id),
            listening: state.listening.as_ref().map(|listening| listening.address.to_string()),
            takes_port,
            phone_route: state.phone_route.as_ref().is_some_and(|route| route.attachment.valid()),
            computers,
            error,
            pending,
            code,
            paused_until,
            phones: self.phone_status(),
        }
    }

    #[cfg(unix)]
    fn phone_status(&self) -> wire::PhoneStatus {
        self.phones.get().map(|phones| phones.status()).unwrap_or_default()
    }

    #[cfg(not(unix))]
    fn phone_status(&self) -> wire::PhoneStatus {
        wire::PhoneStatus::default()
    }

    /// The phones served here, while no window takes them.
    #[cfg(unix)]
    pub(crate) fn phones(&self) -> Option<&Arc<phones::Phones>> {
        self.phones.get()
    }

    /// Tell the window and stdout when the status changed.
    fn publish(&self) {
        let status = {
            let mut state = self.state.lock().unwrap();
            let status = self.status_of(&state);
            if state.last.as_ref() == Some(&status) {
                return;
            }
            state.last = Some(status.clone());
            status
        };
        self.sink.emit(wire::CHANGED_EVENT, &status);
        println!("{}", json!({ "type": "machineHost", "status": status }));
    }

    async fn supervise(self: Arc<Self>) {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Settings are read when the file changes, and now and then besides.
        let mut read = true;
        let mut ticks = 0u32;
        loop {
            self.clone().reconcile(read).await;
            tokio::select! {
                _ = tick.tick() => {
                    ticks += 1;
                    read = ticks.is_multiple_of(SETTINGS_EVERY);
                }
                _ = self.settings_changed.notified() => read = true,
                _ = self.wake.notified() => read = false,
            }
        }
    }

    /// Bring the listener, the connections and the power assertion in line
    /// with the switch.
    async fn reconcile(self: Arc<Self>, read: bool) {
        let settings = if read { tokio::task::spawn_blocking(crate::store::settings::load).await.ok() } else { None };
        let was = {
            let mut state = self.state.lock().unwrap();
            if let Some(settings) = &settings {
                state.allowed = settings.machines.allow_operating;
                state.keep_awake = settings.pairing.keep_awake;
            }
            let was = state.enabled;
            state.enabled = state.allowed && !crate::data_privacy::enabled();
            let enabled = state.enabled;
            if state.phone_route.as_ref().is_some_and(|route| !route.attachment.valid()) {
                state.phone_route = None;
            }
            // A code or a request that ran out leaves the status at once.
            state.pairing.tick(now_ms());
            (was, enabled)
        };
        let (was, enabled) = was;
        if was && !enabled {
            self.stop_serving();
        }
        #[cfg(unix)]
        if let Some(phones) = self.phones.get().cloned() {
            let _ = tokio::task::spawn_blocking(move || phones.tick(now_ms())).await;
        }
        if read {
            let host = self.clone();
            let _ = tokio::task::spawn_blocking(move || {
                host.expire_unused(now_ms());
                host.note_project_changes();
            })
            .await;
        }
        if enabled {
            if let Err(error) = self.clone().serve().await {
                let busy = error.chain().any(|cause| cause.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::AddrInUse));
                let mut state = self.state.lock().unwrap();
                state.bind_error = Some(format!("{error:#}"));
                state.port_busy = busy;
            }
        }
        self.hold_awake();
        self.publish();
    }

    /// Remove the computers whose credential went unused for 90 days
    /// (PRO-357). One connected now is in use. Blocking.
    fn expire_unused(&self, now: i64) {
        let connected: Vec<String> = self.state.lock().unwrap().connections.keys().cloned().collect();
        match self.registry.remove_expired(now, &connected) {
            Ok(expired) => {
                for computer in expired {
                    self.ended_unused(&computer);
                }
            }
            Err(error) => log::warn!("machine host: expire unused credentials: {error:#}"),
        }
    }

    /// A computer whose credential went unused for 90 days was removed: end
    /// the rest as Revoke does (its connections, its relay credential) and
    /// note it. Its account grant, if any, ends when the operating computer
    /// removes this machine, as it is asked to on "Access removed".
    fn ended_unused(&self, computer: &registry::PairedComputer) {
        log::info!("machine host: computer {}'s credential went unused for 90 days and expired", computer.id);
        self.close_connections(&computer.id);
        if let (Some(device), Some(relay)) = (computer.relay_device_id.as_deref(), self.relay()) {
            relay.revoke_device(device);
        }
        self.activity.record(activity::Entry::new(activity::Kind::Expired, Some((&computer.id, &computer.label)), None));
        self.wake.notify_one();
    }

    /// Whether `computer_id` has a connection open now.
    fn is_connected(&self, computer_id: &str) -> bool {
        self.state.lock().unwrap().connections.get(computer_id).is_some_and(|connections| !connections.is_empty())
    }

    /// While a computer is connected, note a project added or removed on
    /// this machine. No method adds one, so it is not put down to a
    /// computer. Blocking: reads the project store.
    fn note_project_changes(&self) {
        {
            let mut state = self.state.lock().unwrap();
            if state.connections.is_empty() {
                state.projects_seen = None;
                return;
            }
        }
        let projects: HashMap<String, String> = match crate::store::projects::list() {
            Ok((projects, _)) => projects.into_iter().map(|project| (project.path, project.name)).collect(),
            Err(error) => {
                log::debug!("machine host: read projects: {error:#}");
                return;
            }
        };
        let seen = self.state.lock().unwrap().projects_seen.replace(projects.clone());
        let Some(seen) = seen else { return };
        let mut changes: Vec<(activity::Kind, &String)> = Vec::new();
        changes.extend(projects.iter().filter(|(path, _)| !seen.contains_key(*path)).map(|(_, name)| (activity::Kind::ProjectAdded, name)));
        changes.extend(seen.iter().filter(|(path, _)| !projects.contains_key(*path)).map(|(_, name)| (activity::Kind::ProjectRemoved, name)));
        for (kind, name) in changes {
            self.activity.record(activity::Entry::new(kind, None, Some(name)));
        }
    }

    /// Off: close the listener and every computer's connection, keep the records.
    fn stop_serving(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(listening) = state.listening.take() {
            listening.stop();
        }
        state.bind_error = None;
        state.pairing.end(wire::REFUSED_CODE_INACTIVE);
        let labels = std::mem::take(&mut state.labels);
        for (computer_id, connections) in state.connections.drain() {
            for tracked in connections {
                let _ = tracked.cancel.send(());
            }
            let label = labels.get(&computer_id).cloned().unwrap_or_default();
            let log = self.activity.clone();
            Self::off_task(move || log.record(activity::Entry::new(activity::Kind::Disconnected, Some((&computer_id, &label)), None)));
        }
        // A connection on the port keeps the window from binding it again.
        for (_, cancel) in state.phones.drain() {
            let _ = cancel.send(());
        }
        drop(state);
        #[cfg(unix)]
        if let Some(phones) = self.phones.get().cloned() {
            Self::off_task(move || phones.stop());
        }
        log::info!("machine host: off; no listener, every computer disconnected");
    }

    async fn serve(self: Arc<Self>) -> Result<()> {
        let built = self.rpc.lock().unwrap().is_build();
        if self.state.lock().unwrap().keypair.is_none() {
            let keys = self.clone();
            match tokio::task::spawn_blocking(move || keys.keys.load()).await? {
                Ok(Some(keypair)) => {
                    let mut state = self.state.lock().unwrap();
                    state.keypair = Some(keypair);
                    state.key_error = None;
                }
                // The window sends it (`runtime.machineHost.adoptKey`).
                Ok(None) => return Ok(()),
                Err(error) => {
                    self.state.lock().unwrap().key_error = Some(format!("{error:#}"));
                    return Ok(());
                }
            }
        }
        if self.state.lock().unwrap().listening.is_some() {
            return Ok(());
        }
        let Some(rpc) = self.rpc()? else { return Ok(()) };
        if built {
            rpc.set_machine_access(Arc::new(HostAccess::new(&self)));
        }
        let listening = direct::listen(self.clone(), rpc, self.port)?;
        log::info!("machine host: listening on {}", listening.address);
        let mut state = self.state.lock().unwrap();
        state.bind_error = None;
        state.listening = Some(listening);
        Ok(())
    }

    /// The one workspace RPC, built here when the relay host does not.
    fn rpc(&self) -> Result<Option<Arc<WorkspaceRpc>>> {
        let mut rpc = self.rpc.lock().unwrap();
        match &*rpc {
            Rpc::Ready(rpc) => return Ok(Some(rpc.clone())),
            Rpc::Awaiting => return Ok(None),
            Rpc::Build(_) => {}
        }
        let Some(machine_id) = self.state.lock().unwrap().keypair.as_ref().map(HostKeypair::host_id) else { return Ok(None) };
        let Rpc::Build(parts) = std::mem::replace(&mut *rpc, Rpc::Awaiting) else { unreachable!() };
        let identity = crate::remote::machine::Identity {
            machine_id,
            has_window: std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() == Ok("1"),
        };
        match WorkspaceRpc::machine(identity, 0, parts.sink.clone(), parts.terminals.clone(), Some(parts.sessions.clone())) {
            Ok(built) => {
                match parts.agents.as_ref().map(|open| open()) {
                    Some(Ok(agents)) => built.set_agents(agents),
                    Some(Err(error)) => log::error!("machine host: agent tabs: {error:#}; agent-commands/1 is not offered"),
                    None => {}
                }
                *rpc = Rpc::Ready(built.clone());
                Ok(Some(built))
            }
            Err(error) => {
                *rpc = Rpc::Build(parts);
                Err(error)
            }
        }
    }

    fn hold_awake(&self) {
        let mut state = self.state.lock().unwrap();
        let wanted = state.keep_awake && state.connections.values().any(|connections| !connections.is_empty());
        if wanted && state.awake.is_none() {
            match crate::power::Assertion::hold(COMPUTER_CONNECTED) {
                Ok(assertion) => state.awake = Some(assertion),
                Err(error) => log::warn!("machine host: keep awake: {error:#}"),
            }
        } else if !wanted {
            state.awake = None;
        }
    }

    /// Run blocking `work` (the activity log, the registry) off the async
    /// runtime when there is one.
    fn off_task(work: impl FnOnce() + Send + 'static) {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => drop(handle.spawn_blocking(work)),
            Err(_) => work(),
        }
    }

    /// Note a computer's connection by `route`, unless the switch is off;
    /// the returned id forgets it again. Whether it is its first.
    fn track(&self, computer: &registry::PairedComputer, route: ComputerRoute, cancel: mpsc::UnboundedSender<()>) -> Result<(u64, bool)> {
        let id = self.next_connection.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let first = {
            let mut state = self.state.lock().unwrap();
            if !state.enabled {
                bail!("other computers may not operate this machine now");
            }
            let connections = state.connections.entry(computer.id.clone()).or_default();
            let first = connections.is_empty();
            connections.push(Tracked { id, cancel, route });
            state.labels.insert(computer.id.clone(), computer.label.clone());
            first
        };
        self.hold_awake();
        self.wake.notify_one();
        Ok((id, first))
    }

    /// Let a computer in with `token` by `route`:
    /// `Ok(Err(reason))` refuses it with that `pairing_refused` reason.
    ///
    /// A credential unused for 90 days expires here unless it is connected
    /// now, and one the person disconnected is held off (PRO-357).
    /// Otherwise its connection is
    /// tracked, then the computer checked to be still paired: a revocation
    /// removes the record before it closes the tracked connections, so one
    /// racing this admission is either seen here or finds the connection and
    /// closes it. Admission settles a rotated token (`Registry::admitted`).
    /// Blocking: reads and writes the registry.
    pub(crate) fn admit(&self, computer: &registry::PairedComputer, token: &str, route: ComputerRoute, cancel: mpsc::UnboundedSender<()>) -> Result<Result<u64, &'static str>> {
        let now = now_ms();
        // One connected now is in use, however long ago it was let in: a
        // second connection (the direct probe beside the relay, a reconnect
        // while the old socket is half open) must not expire it.
        if computer.expired(now) && !self.is_connected(&computer.id) {
            if self.registry.remove(&computer.id)? {
                self.ended_unused(computer);
            }
            return Ok(Err(wire::REFUSED_CODE_INACTIVE));
        }
        if computer.disconnected_at.is_some() {
            log::info!("machine host: computer {} is disconnected until the person lets it back; refused", computer.id);
            return Ok(Err(wire::REFUSED_DISCONNECTED));
        }
        let (tracked, first) = self.track(computer, route, cancel)?;
        let current = match self.registry.list() {
            Ok(computers) => computers.into_iter().find(|known| known.id == computer.id),
            Err(error) => {
                self.release(&computer.id, tracked, false);
                return Err(error);
            }
        };
        match current {
            None => {
                self.release(&computer.id, tracked, false);
                bail!("the computer was revoked")
            }
            // Disconnected while it was let in: closed, as Disconnect closes the rest.
            Some(current) if current.disconnected_at.is_some() => {
                self.release(&computer.id, tracked, false);
                Ok(Err(wire::REFUSED_DISCONNECTED))
            }
            Some(_) => {
                if let Err(error) = self.registry.admitted(&computer.id, token, now) {
                    log::debug!("machine host: note when {} connected: {error:#}", computer.id);
                }
                if first {
                    self.activity.record(activity::Entry::new(activity::Kind::Connected, Some((&computer.id, &computer.label)), Some(route_name(route))));
                }
                Ok(Ok(tracked))
            }
        }
    }

    /// A computer's connection closed. Its last one notes "disconnected" and
    /// when it was last seen, off the async runtime.
    pub(crate) fn untrack(&self, computer_id: &str, id: u64) {
        self.release(computer_id, id, true);
    }

    /// Forget a tracked connection; `note`: its last one is put in the
    /// activity log (not for one refused before it was let in).
    fn release(&self, computer_id: &str, id: u64, note: bool) {
        let last = {
            let mut state = self.state.lock().unwrap();
            let mut last = None;
            if let Some(connections) = state.connections.get_mut(computer_id) {
                let before = connections.len();
                connections.retain(|tracked| tracked.id != id);
                if connections.is_empty() && before > 0 {
                    state.connections.remove(computer_id);
                    last = Some(state.labels.remove(computer_id).unwrap_or_default());
                }
            }
            last
        };
        if let Some(label) = last.filter(|_| note) {
            let (log, registry, computer_id) = (self.activity.clone(), registry::Registry::at(self.registry.path().to_path_buf()), computer_id.to_string());
            Self::off_task(move || {
                // Its last use: the 90 days of expiry count from here.
                let _ = registry.touch(&computer_id, now_ms());
                log.record(activity::Entry::new(activity::Kind::Disconnected, Some((&computer_id, &label)), None));
            });
        }
        self.hold_awake();
        self.wake.notify_one();
    }

    /// Note a phone passed to the window, unless the host is off.
    pub(crate) fn track_phone(&self, cancel: mpsc::UnboundedSender<()>) -> Option<u64> {
        let id = self.next_connection.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut state = self.state.lock().unwrap();
        state.enabled.then(|| {
            state.phones.insert(id, cancel);
            id
        })
    }

    pub(crate) fn untrack_phone(&self, id: u64) {
        self.state.lock().unwrap().phones.remove(&id);
    }

    /// Where a phone goes: the window's route while its attachment is current.
    pub(crate) fn phone_route(&self) -> Option<PathBuf> {
        let state = self.state.lock().unwrap();
        state.phone_route.as_ref().filter(|route| route.attachment.valid()).map(|route| route.socket.clone())
    }

    fn attachment(&self, epoch: &str, lease: &str) -> Result<Arc<crate::local_runtime::Attachment>, ControlError> {
        let lifetime = self.lifetime.as_ref().ok_or_else(|| ControlError::new("unsupported", "This runtime has no desktop attachments.", None::<String>))?;
        lifetime
            .attachment(epoch, lease)
            .map_err(|error| ControlError::new("attachment_expired", format!("{error:#}"), Some("Attach again, then repeat.".into())))
    }

    /// Remove a paired computer, then close its connections: one admitted
    /// meanwhile finds its record gone (`admit`). Whether it was paired.
    pub fn revoke(&self, id: &str) -> Result<bool> {
        Ok(self.revoke_computer(id)?.is_some())
    }

    /// [`Self::revoke`], answering the record it removed, whose
    /// `grant_request_id` the window tells the account service about.
    pub fn revoke_computer(&self, id: &str) -> Result<Option<registry::PairedComputer>> {
        let record = self.registry.list()?.into_iter().find(|computer| computer.id == id);
        let removed = self.registry.remove(id)?;
        self.close_connections(id);
        if let (true, Some(computer)) = (removed, &record) {
            self.activity.record(activity::Entry::new(activity::Kind::Revoked, Some((&computer.id, &computer.label)), None));
        }
        // Its relay credential ends with it (`device-revoke`).
        if let (Some(device), Some(relay)) = (record.as_ref().and_then(|computer| computer.relay_device_id.clone()), self.relay()) {
            relay.revoke_device(&device);
        }
        self.wake.notify_one();
        Ok(record.filter(|_| removed))
    }

    /// The account revoked the grant `grant_request_id` (the operating
    /// computer removed this machine, or signed out): remove the computer
    /// allowed through it. Its id, `None` when no computer has that grant.
    pub fn revoke_grant(&self, grant_request_id: &str) -> Result<Option<String>> {
        let Some(computer) = self.registry.find_by_grant(grant_request_id)? else { return Ok(None) };
        let removed = self.revoke_computer(&computer.id)?.map(|computer| computer.id);
        if let Some(id) = &removed {
            log::info!("machine host: computer {id} was removed through its account grant");
        }
        Ok(removed)
    }

    /// Close every connection of a computer, without noting "disconnected":
    /// the caller notes why.
    fn close_connections(&self, id: &str) {
        let mut state = self.state.lock().unwrap();
        state.labels.remove(id);
        for tracked in state.connections.remove(id).unwrap_or_default() {
            let _ = tracked.cancel.send(());
        }
    }

    /// "Disconnect" (PRO-357): close the computer's connections now and
    /// refuse it (`pairing_refused` `disconnected`) until the person lets it
    /// back. Its credential is kept. Whether it is paired. Blocking.
    pub fn disconnect(&self, id: &str) -> Result<bool> {
        let held = self.registry.set_disconnected(id, Some(now_ms()))?;
        let paired = held.is_some() || self.registry.list()?.iter().any(|computer| computer.id == id);
        // Held before its connections close, so none comes straight back.
        self.close_connections(id);
        if let Some(computer) = held {
            log::info!("machine host: computer {id} was disconnected by the person on this machine");
            self.activity.record(activity::Entry::new(activity::Kind::Held, Some((&computer.id, &computer.label)), None));
        }
        self.wake.notify_one();
        Ok(paired)
    }

    /// Let a disconnected computer connect again. Whether it was held. Blocking.
    pub fn let_back(&self, id: &str) -> Result<bool> {
        let Some(computer) = self.registry.set_disconnected(id, None)? else { return Ok(false) };
        log::info!("machine host: computer {id} may connect again");
        self.activity.record(activity::Entry::new(activity::Kind::LetBack, Some((&computer.id, &computer.label)), None));
        self.wake.notify_one();
        Ok(true)
    }

    /// The paired computer connected as `device_id` (its id on the direct
    /// route, its relay device id on the relay). Blocking.
    fn computer_of(&self, device_id: &str) -> Result<Option<registry::PairedComputer>> {
        Ok(self.registry.list()?.into_iter().find(|computer| computer.id == device_id || computer.relay_device_id.as_deref() == Some(device_id)))
    }

    /// `machine.rotateCredential` (PRO-357): a fresh device token for the
    /// computer connected as `device_id`. Only its hash is kept, beside the
    /// current one, until the computer connects with it. Blocking.
    pub(crate) fn rotate_credential(&self, device_id: &str) -> Result<Option<String>> {
        let Some(computer) = self.computer_of(device_id)? else { return Ok(None) };
        let token = crate::relay_e2ee::random_token();
        if !self.registry.rotate(&computer.id, registry::token_hash(&token))? {
            return Ok(None);
        }
        log::info!("machine host: computer {} was given a fresh credential", computer.id);
        Ok(Some(token))
    }

    /// `machine.relayAccess` for the paired computer connected as
    /// `device_id`: its relay device id (given once) and a fresh invite.
    async fn relay_access(self: Arc<Self>, device_id: String) -> Result<Value, crate::remote::protocol::RpcError> {
        use crate::remote::protocol::RpcError;
        let lookup = self.clone();
        let wanted = device_id.clone();
        let computer = tokio::task::spawn_blocking(move || lookup.registry.list())
            .await
            .map_err(RpcError::internal)?
            .map_err(RpcError::internal)?
            .into_iter()
            .find(|computer| computer.id == wanted || computer.relay_device_id.as_deref() == Some(wanted.as_str()))
            .ok_or_else(|| RpcError::forbidden("relay access is for a paired computer"))?;
        let Some(relay) = self.relay().filter(|relay| relay.is_registered()) else { return Ok(json!({ "relay": null })) };
        let fresh = format!("computer-{}", uuid::Uuid::new_v4().simple());
        let give = self.clone();
        let id = computer.id.clone();
        let relay_device_id = tokio::task::spawn_blocking(move || give.registry.give_relay_device(&id, &fresh))
            .await
            .map_err(RpcError::internal)?
            .map_err(RpcError::internal)?
            .ok_or_else(|| RpcError::forbidden("the computer was revoked"))?;
        let Some(invite) = relay.invite(&relay_device_id).await.map_err(|error| RpcError::new("unavailable", format!("{error:#}")))? else {
            return Ok(json!({ "relay": null }));
        };
        log::info!("machine host: computer {} was given relay access", computer.id);
        Ok(json!({ "relay": {
            "v": 1,
            "directorUrl": invite.director_url,
            "cellUrl": invite.cell_url,
            "assignmentEpoch": invite.assignment_epoch,
            "relayHostId": invite.relay_host_id,
            "relayDeviceId": relay_device_id,
            "inviteToken": invite.invite_token,
            "inviteExpiresAt": invite.invite_expires_at,
            "e2eeFraming": 2,
        } }))
    }

    /// A host that serves on `port` (0: any) with `keypair`, the switch on,
    /// and no settings watcher: for in-process tests over a real socket.
    #[cfg(test)]
    pub(crate) fn serving_for_test(data_dir: &Path, rpc: Arc<WorkspaceRpc>, keypair: HostKeypair, approval_ttl_ms: i64) -> Result<Arc<Self>> {
        let host = Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            keys: key::KeyStore::for_runtime(data_dir),
            registry: registry::Registry::in_data_dir(data_dir),
            activity: activity::Log::in_dir(&data_dir.join(DIR)),
            sink: Arc::new(crate::sink::BroadcastSink::new(8)),
            rpc: Mutex::new(Rpc::Ready(rpc.clone())),
            state: Mutex::new(State { allowed: true, enabled: true, keypair: Some(keypair), pairing: Pairing::with_approval_ttl(approval_ttl_ms), ..State::default() }),
            lifetime: None,
            port: 0,
            wake: Notify::new(),
            settings_changed: Notify::new(),
            next_connection: std::sync::atomic::AtomicU64::new(1),
            relay: Mutex::new(None),
            #[cfg(unix)]
            phones: OnceLock::new(),
        });
        rpc.set_machine_access(Arc::new(HostAccess::new(&host)));
        let listening = direct::listen(host.clone(), rpc, 0)?;
        host.state.lock().unwrap().listening = Some(listening);
        Ok(host)
    }

    /// A host with its key and RPC, nothing listening, that `reconcile`
    /// brings in line with `settings.json` and data privacy mode.
    #[cfg(test)]
    pub(crate) fn idle_for_test(data_dir: &Path, rpc: Arc<WorkspaceRpc>, keypair: HostKeypair) -> Arc<Self> {
        let host = Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            keys: key::KeyStore::for_runtime(data_dir),
            registry: registry::Registry::in_data_dir(data_dir),
            activity: activity::Log::in_dir(&data_dir.join(DIR)),
            sink: Arc::new(crate::sink::BroadcastSink::new(8)),
            rpc: Mutex::new(Rpc::Ready(rpc.clone())),
            state: Mutex::new(State { keypair: Some(keypair), ..State::default() }),
            lifetime: None,
            port: 0,
            wake: Notify::new(),
            settings_changed: Notify::new(),
            next_connection: std::sync::atomic::AtomicU64::new(1),
            relay: Mutex::new(None),
            #[cfg(unix)]
            phones: OnceLock::new(),
        });
        rpc.set_machine_access(Arc::new(HostAccess::new(&host)));
        host
    }

    #[cfg(test)]
    pub(crate) fn port_for_test(&self) -> u16 {
        self.state.lock().unwrap().listening.as_ref().expect("listening").address.port()
    }

    #[cfg(test)]
    pub(crate) fn expire_code_for_test(&self) {
        self.state.lock().unwrap().pairing.expire_code_for_test(now_ms());
    }

    #[cfg(test)]
    pub(crate) fn stop_for_test(&self) {
        self.stop_serving();
    }

    /// A new pairing code (docs/MACHINES.md, "As built (PRO-342)"). The
    /// code is answered to the caller only: never logged, never in the status.
    /// `grant_request_id`: the account grant it answers (PRO-349); the
    /// computer still waits for Allow with the fingerprint, as for any code.
    pub fn create_code(&self, grant_request_id: Option<String>) -> Result<wire::CreatedCode, ControlError> {
        let (public_key_b64, machine_id, port) = {
            let state = self.state.lock().unwrap();
            let not_enabled = |message: &str| ControlError::new("not_enabled", message, Some("Turn on \"Let other computers operate this Mac\".".into()));
            if !state.enabled {
                return Err(not_enabled("Other computers may not operate this machine now."));
            }
            let keypair = state.keypair.as_ref().ok_or_else(|| not_enabled("The machine's host key is not ready yet."))?;
            let listening = state.listening.as_ref().ok_or_else(|| not_enabled("The machine is not listening for computers yet."))?;
            (keypair.public_key_b64(), keypair.host_id(), listening.address.port())
        };
        // Read before the code exists, so it is not shortened by slow commands.
        let machine = self.identity(&machine_id);
        let endpoints = crate::direct_endpoints::machine_endpoints(port, wire::MACHINE_PATH);
        let (token, expires_at) = {
            let mut state = self.state.lock().unwrap();
            match state.pairing.create(now_ms(), grant_request_id) {
                Ok(created) => created,
                Err(until) => {
                    let mut paused = ControlError::new("pairing_paused", "Too many wrong pairing attempts. Try again in a minute.", None::<String>);
                    paused.details = Some(json!({ "pausedUntil": until }));
                    return Err(paused);
                }
            }
        };
        let code = wire::MachineCode::new(token, public_key_b64, machine, endpoints, expires_at).encode().map_err(ControlError::internal)?;
        self.wake.notify_one();
        Ok(wire::CreatedCode { code, expires_at })
    }

    /// What `machine.describe` says of this machine.
    fn identity(&self, machine_id: &str) -> wire::MachineIdentity {
        let has_window = std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() == Ok("1");
        let described = crate::remote::machine::describe(&crate::remote::machine::Identity { machine_id: machine_id.into(), has_window });
        wire::MachineIdentity {
            machine_id: machine_id.into(),
            name: described["name"].as_str().unwrap_or(crate::machine_name::UNNAMED_HOST).chars().take(80).collect(),
            os: wire::MachineOs {
                family: described["os"]["family"].as_str().unwrap_or(std::env::consts::OS).into(),
                version: described["os"]["version"].as_str().map(str::to_string),
            },
            version: described["version"].as_str().unwrap_or(env!("CARGO_PKG_VERSION")).into(),
        }
    }

    /// Allow: write the paired computer, then spend the code and let the
    /// waiting connection in. Blocking: writes the registry.
    pub fn approve(&self, request_id: &str) -> Result<(), ControlError> {
        let not_found = || ControlError::new("not_found", "No computer is waiting for that approval.", None::<String>);
        let approving = self.state.lock().unwrap().pairing.approving(request_id, now_ms()).ok_or_else(not_found)?;
        let now = now_ms();
        // Paired again from the same computer: the same record, a new token.
        let existing = self.registry.list().map_err(ControlError::internal)?.into_iter().find(|computer| computer.client_public_key_b64.as_deref() == Some(approving.client_key_b64.as_str()));
        let id = existing.as_ref().map(|computer| computer.id.clone()).unwrap_or_else(|| format!("computer-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]));
        let computer_label = approving.label.clone();
        let mut computer = registry::PairedComputer {
            id: id.clone(),
            token_hash: approving.token_hash,
            label: approving.label,
            platform: approving.platform,
            client_public_key_b64: Some(approving.client_key_b64),
            fingerprint: Some(approving.fingerprint),
            approved_at: now,
            last_seen_at: None,
            relay_device_id: existing.as_ref().and_then(|computer| computer.relay_device_id.clone()),
            // Paired again: a fresh token, and whatever held it off is over.
            next_token_hash: None,
            disconnected_at: None,
            other: existing.map(|computer| computer.other).unwrap_or_default(),
        };
        // Paired again: linked to the grant of this pairing, if any.
        computer.set_grant_request_id(approving.grant_request_id);
        self.registry.put(computer).map_err(ControlError::internal)?;
        if !self.state.lock().unwrap().pairing.approved(&approving.request_id) {
            // It ended while the record was written: nothing is granted.
            if let Err(error) = self.registry.remove(&id) {
                log::warn!("machine host: remove a pairing that ended before Allow: {error:#}");
            }
            return Err(not_found());
        }
        log::info!("machine host: computer {id} was allowed to operate this machine");
        self.activity.record(activity::Entry::new(activity::Kind::Paired, Some((&id, &computer_label)), None));
        self.wake.notify_one();
        Ok(())
    }

    /// Don't allow: nothing is written and the code ends.
    pub fn decline(&self, request_id: &str) {
        if self.state.lock().unwrap().pairing.decline(request_id) {
            log::info!("machine host: a computer was not allowed to operate this machine");
        }
        self.wake.notify_one();
    }

    /// A token that is not a paired computer's (docs/MACHINES.md rules 1, 3, 4).
    pub(crate) fn ask(&self, asking: Asking<'_>) -> Decision {
        let decision = self.state.lock().unwrap().pairing.ask(asking, now_ms());
        self.wake.notify_one();
        decision
    }

    /// A waiting connection closed.
    pub(crate) fn leave(&self, request_id: &str) {
        self.state.lock().unwrap().pairing.leave(request_id);
        self.wake.notify_one();
    }

    /// A paired computer's token from another key (rule 2).
    pub(crate) fn wrong_attempt(&self) {
        self.state.lock().unwrap().pairing.wrong_attempt(now_ms());
        self.wake.notify_one();
    }

    /// How long a computer waits for Allow.
    pub(crate) fn approval_ttl(&self) -> Duration {
        Duration::from_millis(self.state.lock().unwrap().pairing.approval_ttl_ms().max(0) as u64)
    }

    /// The paired computer whose token this is, if this is the key it paired
    /// with (rule 2). Another key is a wrong attempt. Every computer paired by
    /// code has its key pinned; a record with none was not paired here (the
    /// PRO-341 shape, which only a person with this user's files writes) and
    /// is admitted by its token, as PRO-341 admitted it.
    pub(crate) fn paired_with_key(&self, computer: registry::PairedComputer, client_key_b64: &str) -> Option<registry::PairedComputer> {
        let pinned = match computer.client_public_key_b64.as_deref() {
            Some(pinned) => bool::from(subtle::ConstantTimeEq::ct_eq(pinned.as_bytes(), client_key_b64.as_bytes())),
            None => true,
        };
        if pinned {
            return Some(computer);
        }
        log::warn!("machine host: computer {}'s credential came with another key; refused", computer.id);
        self.wrong_attempt();
        None
    }

    /// A runtime IPC command (`machine_wire`).
    #[cfg(unix)]
    fn served_phones(&self) -> Result<&Arc<phones::Phones>, ControlError> {
        self.phones.get().ok_or_else(|| ControlError::new("unsupported", "This runtime does not serve phones.", None::<String>))
    }

    /// A phone pairing code (`terminalx-serve pair --phone`), on a machine
    /// that is listening and whose phones no window takes.
    #[cfg(unix)]
    fn phone_code(&self) -> Result<Value, ControlError> {
        let phones = self.served_phones()?.clone();
        if self.phone_route().is_some() {
            return Err(ControlError::new(
                "window_takes_phones",
                "TerminalX is open on this Mac, so its window pairs phones.",
                Some("Pair the phone in TerminalX: Settings → Devices.".into()),
            ));
        }
        let (keypair, port) = {
            let state = self.state.lock().unwrap();
            (state.keypair.clone(), state.listening.as_ref().map(|listening| listening.address.port()))
        };
        let (Some(keypair), Some(port)) = (keypair, port) else {
            return Err(ControlError::new("not_enabled", "This machine is not reachable yet: turn on \"Let other computers operate this machine\" and wait for it to listen.", None::<String>));
        };
        phones.create_code(&keypair, port).map(|created| serde_json::to_value(created).expect("a code serialises"))
    }

    pub fn execute(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        let result = match command {
            wire::STATUS => Ok(serde_json::to_value(self.status()).map_err(ControlError::internal)?),
            wire::ADOPT_KEY => {
                let adopt: wire::AdoptKey = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and secretB64 are required"))?;
                self.attachment(&adopt.epoch, &adopt.lease)?;
                let secret: [u8; 32] = STANDARD
                    .decode(&adopt.secret_b64)
                    .ok()
                    .and_then(|bytes| bytes.try_into().ok())
                    .ok_or_else(|| ControlError::invalid("secretB64 must be 32 bytes of base64"))?;
                let keypair = self.keys.adopt(secret).map_err(|error| ControlError::new("key_refused", format!("{error:#}"), None::<String>))?;
                let mut state = self.state.lock().unwrap();
                state.key_error = None;
                state.keypair = Some(keypair);
                Ok(json!({ "adopted": true }))
            }
            wire::PHONE_ROUTE => {
                let route: wire::PhoneRoute = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and socket are required"))?;
                let attachment = self.attachment(&route.epoch, &route.lease)?;
                if let Err(error) = private_socket(&self.data_dir, &route.socket) {
                    return Err(ControlError::new("invalid_route", format!("{error:#}"), None::<String>));
                }
                let mut state = self.state.lock().unwrap();
                if state.phone_route.as_ref().is_some_and(|current| current.attachment.valid() && current.lease != route.lease) {
                    return Err(ControlError::new("busy", "Another window takes this machine's phones.", None::<String>));
                }
                state.phone_route = Some(PhoneRoute { attachment, lease: route.lease, socket: route.socket });
                drop(state);
                // A window takes phones now: the ones served here reconnect
                // and reach it, and a phone code made here ends (PRO-359).
                #[cfg(unix)]
                if let Some(phones) = self.phones.get().cloned() {
                    Self::off_task(move || phones.stop());
                }
                Ok(json!({ "registered": true }))
            }
            wire::REVOKE => {
                let revoke: wire::Revoke = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and id are required"))?;
                self.attachment(&revoke.epoch, &revoke.lease)?;
                let removed = self.revoke_computer(&revoke.id).map_err(ControlError::internal)?;
                // The window tells the account service the grant ended.
                Ok(json!({ "revoked": removed.is_some(), "grantRequestId": removed.as_ref().and_then(|computer| computer.grant_request_id()) }))
            }
            wire::REVOKE_GRANT => {
                let revoke: wire::RevokeGrant = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and grantRequestId are required"))?;
                self.attachment(&revoke.epoch, &revoke.lease)?;
                let removed = self.revoke_grant(&revoke.grant_request_id).map_err(ControlError::internal)?;
                Ok(json!({ "revoked": removed.is_some(), "id": removed }))
            }
            wire::CREATE_CODE => {
                let create: wire::CreateCode = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch and lease are required"))?;
                self.attachment(&create.epoch, &create.lease)?;
                self.create_code(create.grant_request_id).map(|created| serde_json::to_value(created).expect("a code serialises"))
            }
            wire::APPROVE => {
                let answer: wire::Answer = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and requestId are required"))?;
                self.attachment(&answer.epoch, &answer.lease)?;
                self.approve(&answer.request_id).map(|()| json!({ "approved": true }))
            }
            wire::ACTIVITY => {
                let entries = self.activity.recent().map_err(ControlError::internal)?;
                Ok(json!({ "entries": entries }))
            }
            wire::DISCONNECT => {
                let target: wire::ForComputer = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and id are required"))?;
                self.attachment(&target.epoch, &target.lease)?;
                let paired = self.disconnect(&target.id).map_err(ControlError::internal)?;
                Ok(json!({ "disconnected": paired }))
            }
            wire::LET_BACK => {
                let target: wire::ForComputer = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and id are required"))?;
                self.attachment(&target.epoch, &target.lease)?;
                let let_back = self.let_back(&target.id).map_err(ControlError::internal)?;
                Ok(json!({ "letBack": let_back }))
            }
            wire::DECLINE => {
                let answer: wire::Answer = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and requestId are required"))?;
                self.attachment(&answer.epoch, &answer.lease)?;
                self.decline(&answer.request_id);
                Ok(json!({ "declined": true }))
            }
            #[cfg(unix)]
            wire::PHONE_CODE => {
                let create: wire::PhoneCode = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch and lease are required"))?;
                self.attachment(&create.epoch, &create.lease)?;
                self.phone_code()
            }
            #[cfg(unix)]
            wire::PHONE_APPROVE => {
                let answer: wire::Answer = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and requestId are required"))?;
                self.attachment(&answer.epoch, &answer.lease)?;
                self.served_phones()?.approve(&answer.request_id).map(|()| json!({ "approved": true }))
            }
            #[cfg(unix)]
            wire::PHONE_DECLINE => {
                let answer: wire::Answer = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and requestId are required"))?;
                self.attachment(&answer.epoch, &answer.lease)?;
                self.served_phones()?.decline(&answer.request_id);
                Ok(json!({ "declined": true }))
            }
            #[cfg(unix)]
            wire::PHONE_REVOKE => {
                let target: wire::ForComputer = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and id are required"))?;
                self.attachment(&target.epoch, &target.lease)?;
                let revoked = self.served_phones()?.revoke(&target.id).map_err(ControlError::internal)?;
                Ok(json!({ "revoked": revoked }))
            }
            _ => Err(ControlError::new("unsupported", "Unknown machine host command.", None::<String>)),
        };
        self.wake.notify_one();
        result
    }
}

/// A Unix socket this user owns, private, in the runtime's `run` directory.
fn private_socket(data_dir: &Path, socket: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let run = std::fs::canonicalize(data_dir.join("run"))?;
        let parent = socket.parent().context("the phone route has no directory")?;
        if std::fs::canonicalize(parent)? != run {
            bail!("the phone route must be in this runtime's private directory");
        }
        let metadata = std::fs::symlink_metadata(socket)?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            bail!("the phone route must be a private socket");
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (data_dir, socket);
        bail!("phone routes need Unix sockets")
    }
}

impl crate::remote::host::MachineRoutes for MachineHost {
    fn is_computer(&self, relay_device_id: &str) -> bool {
        self.registry.knows_relay_device(relay_device_id).unwrap_or_else(|error| {
            log::warn!("machine host: read paired computers: {error:#}");
            // Unreadable: never hand an unknown connection to the window as a phone's.
            true
        })
    }

    fn admit_computer(&self, relay_device_id: &str, token: &str, client_key_b64: &str, cancel: mpsc::UnboundedSender<()>) -> Result<Result<(String, u64), &'static str>> {
        let Some(computer) = self.registry.find_by_relay_device(relay_device_id, token)? else { return Ok(Err(wire::REFUSED_CODE_INACTIVE)) };
        let Some(computer) = self.paired_with_key(computer, client_key_b64) else { return Ok(Err(wire::REFUSED_CODE_INACTIVE)) };
        let tracked = match self.admit(&computer, token, ComputerRoute::Relay, cancel)? {
            Ok(tracked) => tracked,
            Err(reason) => return Ok(Err(reason)),
        };
        log::info!("machine host: computer {} connected through the relay", computer.id);
        Ok(Ok((computer.id, tracked)))
    }

    fn release_computer(&self, computer_id: &str, tracked: u64) {
        self.untrack(computer_id, tracked);
    }

    fn forward_phone(&self, forwarded: wire::Forwarded) -> bool {
        let Some(route) = self.phone_route() else { return false };
        #[cfg(unix)]
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let sent = async {
                let mut window = tokio::net::UnixStream::connect(&route).await?;
                window.write_all(&wire::encode_header(&forwarded)?).await?;
                window.shutdown().await?;
                anyhow::Ok(())
            };
            if let Err(error) = sent.await {
                log::debug!("machine host: pass a phone's relay connection to the window: {error:#}");
            }
        });
        #[cfg(not(unix))]
        let _ = (route, forwarded);
        cfg!(unix)
    }
}

/// `machine/2` for the RPC every route serves: the direct addresses (read at
/// most every few seconds: on macOS each read asks `scutil`) and relay access.
struct HostAccess {
    host: std::sync::Weak<MachineHost>,
    endpoints: Mutex<Option<(std::time::Instant, Vec<String>)>>,
}

impl HostAccess {
    const FRESH_FOR: Duration = Duration::from_secs(4);

    fn new(host: &Arc<MachineHost>) -> Self {
        Self { host: Arc::downgrade(host), endpoints: Mutex::new(None) }
    }
}

impl crate::remote::machine::MachineAccess for HostAccess {
    fn direct_endpoints(&self) -> Vec<String> {
        let Some(host) = self.host.upgrade() else { return Vec::new() };
        let mut cached = self.endpoints.lock().unwrap();
        if let Some((at, endpoints)) = cached.as_ref().filter(|(at, _)| at.elapsed() < Self::FRESH_FOR) {
            let _ = at;
            return endpoints.clone();
        }
        let endpoints = host.direct_endpoints();
        // Asked before the listener is up there are none yet: keep asking
        // rather than hold an empty list for the whole freshness window.
        if !endpoints.is_empty() {
            *cached = Some((std::time::Instant::now(), endpoints.clone()));
        }
        endpoints
    }

    fn other_computers(&self, caller: Option<&str>) -> Vec<crate::remote::machine_update::OtherComputer> {
        self.host.upgrade().map(|host| host.connected_others(caller)).unwrap_or_default()
    }

    fn window_available(&self) -> bool {
        self.host.upgrade().is_some_and(|host| host.window_available())
    }

    fn note(&self, device_id: &str, method: &str, project_id: Option<&str>, detail: Option<&str>) {
        let kind = match method {
            "session.create" => activity::Kind::SessionCreated,
            "pty.create" => activity::Kind::TerminalOpened,
            "machine.update" => activity::Kind::Update,
            _ => return,
        };
        let Some(host) = self.host.upgrade() else { return };
        let (device_id, project_id, detail) = (device_id.to_string(), project_id.map(str::to_string), detail.map(str::to_string));
        MachineHost::off_task(move || {
            let computer = match host.computer_of(&device_id) {
                Ok(Some(computer)) => computer,
                Ok(None) => return,
                Err(error) => {
                    log::debug!("machine host: read paired computers: {error:#}");
                    return;
                }
            };
            // The project's name only: never a path inside it, a prompt or a command.
            let project = project_id.and_then(|wanted| {
                let (projects, _) = crate::store::projects::list().ok()?;
                projects.into_iter().find(|project| crate::remote::machine::project_id(&project.path) == wanted).map(|project| project.name)
            });
            host.activity.record(activity::Entry::new(kind, Some((&computer.id, &computer.label)), project.or(detail).as_deref()));
        });
    }

    fn rotate_credential(&self, device_id: &str) -> futures_util::future::BoxFuture<'static, Result<Value, crate::remote::protocol::RpcError>> {
        use crate::remote::protocol::RpcError;
        let host = self.host.upgrade();
        let device_id = device_id.to_string();
        Box::pin(async move {
            let Some(host) = host else { return Err(RpcError::new("unavailable", "the machine host stopped")) };
            let token = tokio::task::spawn_blocking(move || host.rotate_credential(&device_id)).await.map_err(RpcError::internal)?.map_err(RpcError::internal)?;
            match token {
                Some(token) => Ok(json!({ "deviceToken": token })),
                None => Err(RpcError::forbidden("a fresh credential is for a paired computer")),
            }
        })
    }

    fn relay_access(&self, device_id: &str) -> futures_util::future::BoxFuture<'static, Result<Value, crate::remote::protocol::RpcError>> {
        let host = self.host.upgrade();
        let device_id = device_id.to_string();
        Box::pin(async move {
            match host {
                Some(host) => host.relay_access(device_id).await,
                None => Ok(json!({ "relay": null })),
            }
        })
    }
}

/// A relay link that answers with the machine's host key, so the relay and
/// the direct listener are one machine with one fingerprint. A server whose
/// runtime had no key took the link's as its own in [`MachineHost::start`].
pub struct KeyedLink {
    inner: Arc<dyn crate::remote::host::RuntimeLink>,
    secret: [u8; 32],
}

impl KeyedLink {
    pub fn wrap(host: &MachineHost, inner: Arc<dyn crate::remote::host::RuntimeLink>) -> Arc<dyn crate::remote::host::RuntimeLink> {
        let linked = inner.host_secret();
        let secret = match host.load_key() {
            Ok(Some(keypair)) => *keypair.secret(),
            // A desktop runtime still waiting for the window's key.
            Ok(None) => linked,
            Err(error) => {
                log::warn!("machine host: load the host key: {error:#}");
                linked
            }
        };
        if secret != linked {
            // Its relay token names the link's key, so the relay will refuse it.
            log::error!("machine host: the relay link is for another host key than this machine's; make the link for this machine's key");
        }
        Arc::new(Self { inner, secret })
    }
}

impl crate::remote::host::RuntimeLink for KeyedLink {
    fn host_secret(&self) -> [u8; 32] {
        self.secret
    }

    fn session(&self) -> Result<crate::remote::host::RelaySession> {
        self.inner.session()
    }

    fn complete_attachment(&self, attachment_id: &str, pairing_code: &str) -> Result<()> {
        self.inner.complete_attachment(attachment_id, pairing_code)
    }

    fn complete_revocation(&self, attachment_id: &str) -> Result<()> {
        self.inner.complete_revocation(attachment_id)
    }
}
