//! The runtime accepts operating computers itself (PRO-341, docs/MACHINES.md
//! decision 4 and "How PRO-341 builds it"): on the direct listener, and
//! through the relay, with the machine's one host key ([`key`]) and a
//! registry of paired computers ([`registry`]) kept apart from the phones'
//! `devices.json`. What it says to the window is in `crate::machine_wire`.
//!
//! Nothing listens and nothing is registered until `machines.allowOperating`
//! is on. While it is on the runtime is a standing service, so a computer can
//! connect with the window closed. Data privacy mode turns it off.

pub(crate) mod direct;
pub(crate) mod key;
pub mod registry;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};

use crate::control::ControlError;
use crate::machine_wire::{self as wire, ComputerSummary, HostKeyState, Status};
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
}

enum Rpc {
    /// Built here once the key is known.
    Build(Box<Parts>),
    /// The relay host builds it (`remote::host::serve_machine`) and hands it
    /// over: every route serves the same one.
    Awaiting,
    Ready(Arc<WorkspaceRpc>),
}

/// The window's phone route.
struct PhoneRoute {
    attachment: Arc<crate::local_runtime::Attachment>,
    lease: String,
    socket: PathBuf,
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
    /// the switch goes off. The sender's id tells them apart.
    connections: HashMap<String, Vec<(u64, mpsc::UnboundedSender<()>)>>,
    /// Phones passed to the window from the direct listener. Each holds the
    /// port, so they close with the listener.
    phones: HashMap<u64, mpsc::UnboundedSender<()>>,
    awake: Option<crate::power::Assertion>,
    last: Option<Status>,
}

pub struct MachineHost {
    data_dir: PathBuf,
    keys: key::KeyStore,
    registry: registry::Registry,
    sink: Arc<dyn EventSink>,
    rpc: Mutex<Rpc>,
    state: Mutex<State>,
    lifetime: Option<Arc<crate::local_runtime::Lifetime>>,
    port: u16,
    wake: Notify,
    settings_changed: Notify,
    next_connection: std::sync::atomic::AtomicU64,
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
        let host = Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            keys: key::KeyStore::for_runtime(data_dir),
            registry: registry::Registry::in_data_dir(data_dir),
            sink: sink.clone(),
            rpc: Mutex::new(if awaiting_rpc { Rpc::Awaiting } else { Rpc::Build(Box::new(parts)) }),
            state: Mutex::new(State::default()),
            lifetime,
            port: configured_port(),
            wake: Notify::new(),
            settings_changed: Notify::new(),
            next_connection: std::sync::atomic::AtomicU64::new(1),
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
        if let Some(secret) = link_secret {
            if let Err(error) = host.seed_key(secret) {
                log::warn!("machine host: keep the relay link's host key: {error:#}");
            }
        }
        if INSTALLED.set(host.clone()).is_err() {
            log::warn!("machine host: a host was already installed in this process");
        }
        tokio::spawn(host.clone().supervise());
        host
    }

    /// The relay host's RPC, which the direct listener serves too.
    pub fn use_rpc(&self, rpc: Arc<WorkspaceRpc>) {
        *self.rpc.lock().unwrap() = Rpc::Ready(rpc);
        self.wake.notify_one();
    }

    pub fn registry(&self) -> &registry::Registry {
        &self.registry
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
            .map(|computer| ComputerSummary {
                connected: state.connections.get(&computer.id).is_some_and(|connections| !connections.is_empty()),
                id: computer.id,
                label: computer.label,
                platform: computer.platform,
                approved_at: computer.approved_at,
                last_seen_at: computer.last_seen_at,
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
        Status {
            enabled: state.enabled,
            host_key,
            machine_id: state.keypair.as_ref().map(HostKeypair::host_id),
            listening: state.listening.as_ref().map(|listening| listening.address.to_string()),
            takes_port,
            phone_route: state.phone_route.as_ref().is_some_and(|route| route.attachment.valid()),
            computers,
            error,
        }
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
            (was, enabled)
        };
        let (was, enabled) = was;
        if was && !enabled {
            self.stop_serving();
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

    /// Off: close the listener and every computer's connection, keep the records.
    fn stop_serving(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(listening) = state.listening.take() {
            listening.stop();
        }
        state.bind_error = None;
        for (_, connections) in state.connections.drain() {
            for (_, cancel) in connections {
                let _ = cancel.send(());
            }
        }
        // A connection on the port keeps the window from binding it again.
        for (_, cancel) in state.phones.drain() {
            let _ = cancel.send(());
        }
        log::info!("machine host: off; no listener, every computer disconnected");
    }

    async fn serve(self: Arc<Self>) -> Result<()> {
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

    /// Note a computer's connection, unless the switch is off; the returned
    /// id forgets it again.
    pub(crate) fn track(&self, computer_id: &str, cancel: mpsc::UnboundedSender<()>) -> Result<u64> {
        let id = self.next_connection.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut state = self.state.lock().unwrap();
            if !state.enabled {
                bail!("other computers may not operate this machine now");
            }
            state.connections.entry(computer_id.to_string()).or_default().push((id, cancel));
        }
        self.hold_awake();
        self.wake.notify_one();
        Ok(id)
    }

    /// Let a computer in: track its connection, then check it is still
    /// paired. A revocation removes the record before it closes the tracked
    /// connections, so one racing this admission is either seen here or
    /// finds the connection and closes it. Blocking: reads the registry.
    pub(crate) fn admit(&self, computer_id: &str, cancel: mpsc::UnboundedSender<()>) -> Result<u64> {
        let tracked = self.track(computer_id, cancel)?;
        match self.registry.list() {
            Ok(computers) if computers.iter().any(|known| known.id == computer_id) => Ok(tracked),
            Ok(_) => {
                self.untrack(computer_id, tracked);
                bail!("the computer was revoked")
            }
            Err(error) => {
                self.untrack(computer_id, tracked);
                Err(error)
            }
        }
    }

    pub(crate) fn untrack(&self, computer_id: &str, id: u64) {
        {
            let mut state = self.state.lock().unwrap();
            if let Some(connections) = state.connections.get_mut(computer_id) {
                connections.retain(|(connection, _)| *connection != id);
                if connections.is_empty() {
                    state.connections.remove(computer_id);
                }
            }
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

    /// A runtime IPC command (`machine_wire`).
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
                Ok(json!({ "registered": true }))
            }
            wire::REVOKE => {
                let revoke: wire::Revoke = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and id are required"))?;
                self.attachment(&revoke.epoch, &revoke.lease)?;
                let removed = self.registry.remove(&revoke.id).map_err(ControlError::internal)?;
                for (_, cancel) in self.state.lock().unwrap().connections.remove(&revoke.id).unwrap_or_default() {
                    let _ = cancel.send(());
                }
                Ok(json!({ "revoked": removed }))
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

    fn admit_computer(&self, relay_device_id: &str, token: &str, cancel: mpsc::UnboundedSender<()>) -> Result<Option<(String, u64)>> {
        let Some(computer) = self.registry.find_by_relay_device(relay_device_id, token)? else { return Ok(None) };
        let tracked = self.admit(&computer.id, cancel)?;
        if let Err(error) = self.registry.touch(&computer.id, chrono::Utc::now().timestamp_millis()) {
            log::debug!("machine host: note when {} connected: {error:#}", computer.id);
        }
        log::info!("machine host: computer {} connected through the relay", computer.id);
        Ok(Some((computer.id, tracked)))
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
