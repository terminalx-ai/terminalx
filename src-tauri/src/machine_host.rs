//! The runtime accepts operating computers itself (PRO-341, docs/MACHINES.md
//! decision 4 and "How PRO-341 builds it"): on the direct listener, and
//! through the relay, with the machine's one host key ([`key`]) and a
//! registry of paired computers ([`registry`]) kept apart from the phones'
//! `devices.json`. What it says to the window is in `crate::machine_wire`.
//!
//! Nothing listens and nothing is registered until `machines.allowOperating`
//! is on. While it is on the runtime is a standing service, so a computer can
//! connect with the window closed. Data privacy mode turns it off.
//!
//! Where it listens is `machines.listen` (PRO-487, `crate::listen`): one
//! listener per address the choice binds, none for "Relay only". A caller
//! from a public address is refused unless `machines.allowPublic` says so.

pub(crate) mod activity;
pub(crate) mod direct;
pub(crate) mod key;
pub(crate) mod pairing;
#[cfg(unix)]
mod phone_revocations;
#[cfg(unix)]
pub(crate) mod phones;
pub mod registry;
#[cfg(all(test, feature = "desktop"))]
mod pairing_tests;
#[cfg(all(test, feature = "desktop"))]
mod security_tests;
#[cfg(all(test, feature = "desktop", target_os = "macos"))]
mod window_consent_tests;
#[cfg(test)]
mod relay_tests;
#[cfg(all(test, unix))]
mod phone_relay_tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

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
/// How long the window's relay request may wait for the relay's reply. The
/// window's call allows a little more (`Desktop::relay_control`).
const RELAY_CONTROL_WAIT: Duration = Duration::from_secs(15);

/// How long a pairing code waits for listeners the supervisor is opening.
const LISTENER_WAIT: Duration = Duration::from_secs(3);
/// How long a pairing code's relay invite may take to come back.
const CODE_INVITE_WAIT: Duration = Duration::from_secs(8);

/// Where the host keeps when it last refused a public caller, in [`DIR`].
const PUBLIC_CALLERS_FILE: &str = "public-callers.json";

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
/// When a public caller was last refused, as an earlier run kept it.
fn read_refused_public(data_dir: &Path) -> Option<i64> {
    let bytes = std::fs::read(data_dir.join(DIR).join(PUBLIC_CALLERS_FILE)).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?["refusedAt"].as_i64()
}

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
    device_scoped: bool,
}

/// One open connection of a paired computer.
struct Tracked {
    id: u64,
    cancel: mpsc::UnboundedSender<()>,
    route: ComputerRoute,
    /// The listener it came in on, on a direct route: it closes with it.
    via: Option<std::net::SocketAddr>,
}

#[derive(Default)]
struct State {
    /// `machines.allowOperating`, as last read.
    allowed: bool,
    /// Allowed, and data privacy mode is off.
    enabled: bool,
    desktop_phones: bool,
    keep_awake: bool,
    keypair: Option<HostKeypair>,
    key_error: Option<String>,
    /// One listener per address the listen setting binds (PRO-487).
    listeners: Vec<direct::Listening>,
    /// `machines.listen` and `machines.allowPublic`, as last read. `None`
    /// until the first read: every interface, public callers refused.
    plan: Option<crate::listen::Plan>,
    /// This computer's addresses, as last read, for the one-time question.
    interfaces: Vec<std::net::Ipv4Addr>,
    /// When a public caller was last refused.
    refused_public_at: Option<i64>,
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
    /// port, so they close with the listener it came in on.
    phones: HashMap<u64, (Option<std::net::SocketAddr>, mpsc::UnboundedSender<()>)>,
    awake: Option<crate::power::Assertion>,
    last: Option<Status>,
    /// The live code, the computer waiting for Allow, the attempt limit.
    pairing: Pairing,
    /// On, but nobody is signed in on this machine: no relay registration.
    relay_signed_out: bool,
    /// The account a newer runtime process took the relay from this one
    /// for (`409 machine_runtime_superseded`). It does not register for it
    /// again; another account it would.
    relay_superseded: Option<String>,
    /// The account the relay session was refused for because another
    /// account binds this machine (`409 host_binding_owner_conflict`), and
    /// when. Asked again after [`RELAY_REFUSED_RETRY`].
    relay_refused: Option<(String, Instant)>,
}

impl State {
    fn hosting(&self) -> bool {
        self.enabled || self.desktop_phones
    }

    /// The addresses bound now.
    fn bound(&self) -> Vec<std::net::SocketAddr> {
        self.listeners.iter().map(|listening| listening.address).collect()
    }

    /// The direct port, while something listens.
    fn port(&self) -> Option<u16> {
        self.listeners.first().map(|listening| listening.address.port())
    }

    fn plan(&self) -> crate::listen::Plan {
        self.plan.unwrap_or(crate::listen::Plan { choice: crate::listen::Listen::All, chosen: false, allow_public: false, public_unanswered: true })
    }

    /// Close the listener on `address` and every connection that came in on it.
    fn close_listener(&mut self, address: std::net::SocketAddr) {
        let Some(at) = self.listeners.iter().position(|listening| listening.address == address) else { return };
        self.listeners.remove(at).stop();
        for tracked in self.connections.values().flatten().filter(|tracked| tracked.via == Some(address)) {
            let _ = tracked.cancel.send(());
        }
        for (via, cancel) in self.phones.values() {
            if *via == Some(address) {
                let _ = cancel.send(());
            }
        }
    }
}

/// How long a machine another account binds waits before asking again.
const RELAY_REFUSED_RETRY: Duration = Duration::from_secs(10 * 60);

/// Why a running relay registration stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RelayStop {
    Superseded,
    OwnerConflict,
    SignedOut,
    HostKeyChanged,
    AnotherAccount,
}

impl RelayStop {
    fn why(self) -> &'static str {
        match self {
            Self::Superseded => "superseded",
            Self::OwnerConflict => "another account binds this machine",
            Self::SignedOut => "signed out",
            Self::HostKeyChanged => "host key changed",
            Self::AnotherAccount => "another account signed in",
        }
    }
}

/// Whether a running registration stops on this pass. `registered_host`:
/// the host id it registered as; `key_host`: the host key's now. `user`: the
/// account it registered for; `saved`: on a read pass, the account in the
/// session file (`Some(None)` when there is none), else `None`.
fn running_relay_stop(ended: Option<crate::remote::account_link::Ended>, registered_host: &str, key_host: &str, user: Option<&str>, saved: Option<Option<&str>>) -> Option<RelayStop> {
    use crate::remote::account_link::Ended;
    match ended {
        Some(Ended::Superseded) => Some(RelayStop::Superseded),
        Some(Ended::OwnerConflict) => Some(RelayStop::OwnerConflict),
        Some(Ended::SignedOut) => Some(RelayStop::SignedOut),
        // A key adopted from the window replaced the one it registered with.
        None if registered_host != key_host => Some(RelayStop::HostKeyChanged),
        // The link reads the session only when it renews its token, up to an
        // hour apart: signing out, or another account signing in, ends the
        // registration at the next read pass.
        None => match saved {
            Some(None) => Some(RelayStop::SignedOut),
            Some(Some(saved)) if user.is_some_and(|user| user != saved) => Some(RelayStop::AnotherAccount),
            _ => None,
        },
    }
}

/// Whether to register for `user`: not after a newer process superseded
/// this one for it, nor soon after another account's binding refused it.
fn may_register(user: &str, superseded: Option<&str>, refused: Option<(&str, Instant)>, now: Instant) -> bool {
    superseded != Some(user) && !refused.is_some_and(|(refused, at)| refused == user && now.duration_since(at) < RELAY_REFUSED_RETRY)
}

/// A running registration that is not registered, as the status says it.
/// `retrying`: it registered or tried before, and lost or was refused it.
fn unregistered_relay_state(ended: Option<crate::remote::account_link::Ended>, host: &crate::remote::host::HostStatus) -> wire::RelayState {
    use crate::remote::account_link::Ended;
    use crate::remote::host::HostStatus;
    match (ended, host) {
        (Some(Ended::Superseded), _) => wire::RelayState::Superseded,
        (Some(Ended::SignedOut), _) | (None, HostStatus::Revoked) => wire::RelayState::SignedOut,
        // Stopping at the next pass; the window need not wait for it.
        (Some(Ended::OwnerConflict), _) => wire::RelayState::Off,
        (None, HostStatus::Connecting) => wire::RelayState::Connecting,
        (None, HostStatus::Retrying { .. } | HostStatus::Fenced { .. } | HostStatus::Registered { .. }) => wire::RelayState::Retrying,
    }
}

/// The machine's own relay registration from the signed-in account (PRO-368).
struct AccountRelay {
    host: Arc<crate::remote::host::RelayHost>,
    link: Arc<crate::remote::account_link::AccountLink>,
    /// Wakes the supervisor on each change of the registration.
    watch: tokio::task::JoinHandle<()>,
    directory: Option<tokio::task::JoinHandle<()>>,
}

#[cfg(unix)]
type PhoneAdmission = (Arc<phones::Phones>, HostKeypair, u16, tokio::sync::watch::Receiver<u64>, u64);

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
    /// The machine's relay registration (PRO-345): paired computers get
    /// relay access through it. With `--relay-link` it is that link's; else
    /// the signed-in account's ([`AccountRelay`], PRO-368).
    relay: Mutex<Option<std::sync::Weak<crate::remote::host::RelayHost>>>,
    /// Whether this host registers with the relay from the account: not
    /// when a `--relay-link` registers it.
    account_relay_allowed: bool,
    account_relay: Mutex<Option<AccountRelay>>,
    /// Refused public callers, for one log line an hour (PRO-487).
    refusals: crate::listen::Refusals,
    /// Phones it serves itself while no window takes them (PRO-359). Only a
    /// runtime with an owner lifetime serves them.
    #[cfg(unix)]
    phones: OnceLock<Arc<phones::Phones>>,
}

/// Refused while a window takes this Mac's phones: it pairs and removes them.
#[cfg(unix)]
fn window_takes_phones(recovery: &str) -> ControlError {
    ControlError::new("window_takes_phones", "TerminalX is open on this Mac, so its window looks after phones.", Some(recovery.into()))
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
        let (user, root) = crate::listen::current_user();
        if root {
            log::warn!("the runtime runs as root ({user}): every paired computer and every agent on this machine acts as root");
        }
        let host = Self::new(
            data_dir.to_path_buf(),
            key::KeyStore::for_runtime(data_dir),
            sink.clone(),
            if awaiting_rpc { Rpc::Awaiting } else { Rpc::Build(Box::new(parts)) },
            lifetime,
            configured_port(),
            !awaiting_rpc,
        );
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
                    if host.keys.needs_window() {
                        tokio::spawn(phone_revocations::watch(
                            Arc::downgrade(&host),
                            phones.watch_account_revocations(),
                            Arc::new(crate::machine_account::Api::new(&crate::machine_account::api_base_url())),
                        ));
                    }
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

    fn new(
        data_dir: PathBuf,
        keys: key::KeyStore,
        sink: Arc<dyn EventSink>,
        rpc: Rpc,
        lifetime: Option<Arc<crate::local_runtime::Lifetime>>,
        port: u16,
        account_relay_allowed: bool,
    ) -> Arc<Self> {
        Arc::new(Self {
            keys,
            registry: registry::Registry::in_data_dir(&data_dir),
            activity: activity::Log::in_dir(&data_dir.join(DIR)),
            sink,
            rpc: Mutex::new(rpc),
            state: Mutex::new(State { refused_public_at: read_refused_public(&data_dir), ..State::default() }),
            data_dir,
            lifetime,
            port,
            wake: Notify::new(),
            settings_changed: Notify::new(),
            next_connection: std::sync::atomic::AtomicU64::new(1),
            relay: Mutex::new(None),
            #[cfg(unix)]
            phones: OnceLock::new(),
            account_relay_allowed,
            account_relay: Mutex::new(None),
            refusals: crate::listen::Refusals::default(),
        })
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
        #[cfg(unix)]
        if let Some(phones) = self.phones.get() {
            phones.use_relay(relay);
        }
    }

    fn relay(&self) -> Option<Arc<crate::remote::host::RelayHost>> {
        self.relay.lock().unwrap().as_ref().and_then(std::sync::Weak::upgrade)
    }

    /// The direct listener's addresses (`machine/2` `directEndpoints`).
    /// Only addresses a listener is bound to (PRO-487).
    fn direct_endpoints(&self) -> Vec<String> {
        let bound = self.state.lock().unwrap().bound();
        crate::direct_endpoints::bound_endpoints(&bound, wire::MACHINE_PATH)
    }

    /// Whether a connection from `peer` is answered: not one from a public
    /// address, unless the person allowed public callers. A refusal is
    /// remembered for the status, and the first each hour is logged and kept.
    pub(crate) fn answers(&self, peer: std::net::SocketAddr) -> bool {
        let allow_public = self.state.lock().unwrap().plan().allow_public;
        if crate::listen::caller_allowed(peer.ip(), allow_public) {
            return true;
        }
        let now = now_ms();
        self.state.lock().unwrap().refused_public_at = Some(now);
        if let Some(earlier) = self.refusals.note(Instant::now()) {
            let more = if earlier > 0 { format!(" ({earlier} more since this was last logged)") } else { String::new() };
            log::warn!(
                "machine host: refused a connection from the public address {}{more}. Public callers are refused; `terminalx-serve hosting --listen all --allow-public` answers them.",
                peer.ip()
            );
            let path = self.data_dir.join(DIR).join(PUBLIC_CALLERS_FILE);
            Self::off_task(move || {
                if let Err(error) = private_dir(path.parent().expect("in the host's directory")).and_then(|()| Ok(std::fs::write(&path, json!({ "refusedAt": now }).to_string())?)) {
                    log::debug!("machine host: keep when a public caller was refused: {error:#}");
                }
            });
            self.wake.notify_one();
        }
        false
    }

    /// Choose where it listens and whether public callers are answered
    /// (`machine.setListen`, the desktop's Settings → Machines). "Relay
    /// only" is refused while this machine is not on the relay: nothing
    /// could reach it again. Blocking: writes `settings.json`.
    pub fn set_listen(&self, listen: crate::listen::Listen, allow_public: bool) -> Result<wire::ListenStatus, ControlError> {
        if listen == crate::listen::Listen::Relay && !self.relay().is_some_and(|relay| relay.is_registered()) {
            return Err(ControlError::new(
                "not_reachable",
                "This machine is not connected to the TerminalX relay, so with no port open nothing could reach it.",
                Some("Sign in to TerminalX on it first (`terminalx-serve login` on a server).".into()),
            ));
        }
        crate::listen::choose(listen, allow_public).map_err(ControlError::internal)?;
        log::info!("machine host: listens on \"{}\" now; public callers are {}", listen.word(), if allow_public { "answered" } else { "refused" });
        let status = {
            let mut state = self.state.lock().unwrap();
            state.plan = Some(crate::listen::Plan { choice: listen, chosen: true, allow_public, public_unanswered: false });
            crate::listen::remember(state.plan());
            let mut status = self.listen_status(&state);
            // As it will be once the listeners follow, a moment from now.
            status.addresses = state.plan().binds(&state.interfaces).into_iter().map(|ip| std::net::SocketAddr::from((ip, self.port)).to_string()).collect();
            status
        };
        self.settings_changed.notify_one();
        Ok(status)
    }

    /// Where it listens and who it answers, as the status says it.
    fn listen_status(&self, state: &State) -> wire::ListenStatus {
        let plan = state.plan();
        wire::ListenStatus {
            choice: plan.choice,
            chosen: plan.chosen,
            addresses: state.bound().iter().map(ToString::to_string).collect(),
            allow_public: plan.allow_public,
            ask_public: state.hosting() && plan.asks_public(&state.interfaces, state.refused_public_at.is_some()),
            refused_public_at: state.refused_public_at,
        }
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
        state.hosting() || state.connections.values().any(|connections| !connections.is_empty())
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
        let error = if !state.hosting() {
            None
        } else {
            state.key_error.clone().or_else(|| state.bind_error.clone())
        };
        // A key in error or a port it cannot bind leaves the window serving
        // phones on the port; a port still in use is the window's to give up.
        let takes_port = state.hosting() && host_key != HostKeyState::Error && (state.bind_error.is_none() || state.port_busy);
        let (pending, code, paused_until) = state.pairing.view(now_ms());
        let phone_route = state.phone_route.as_ref().is_some_and(|route| route.attachment.valid());
        let (relay_state, relay) = self.relay_view(state);
        Status {
            enabled: state.enabled,
            host_key,
            machine_id: state.keypair.as_ref().map(HostKeypair::host_id),
            listening: state.listeners.first().map(|listening| listening.address.to_string()),
            takes_port,
            phone_route,
            computers,
            error,
            pending,
            code,
            paused_until,
            phones: wire::PhoneStatus { hosting: state.desktop_phones, window_open: phone_route || self.window_available(), ..self.phone_status() },
            relay_state,
            relay,
            listen: Some(self.listen_status(state)),
            // `sudo` is asked once, and only by a runtime that hosts.
            runs_as: Some(crate::listen::runs_as_now(state.hosting())),
        }
    }

    /// The relay registration as the status says it. Takes the
    /// `account_relay` lock under the state lock: never the other way round.
    fn relay_view(&self, state: &State) -> (wire::RelayState, Option<wire::RelayRegistration>) {
        let registration = |host: &crate::remote::host::RelayHost| {
            host.registration().map(|registration| wire::RelayRegistration {
                relay_host_id: registration.relay_host_id,
                director_url: registration.director_url,
                cell_url: registration.cell_url,
                assignment_epoch: registration.assignment_epoch,
                generation: registration.generation,
                runtime_generation: registration.runtime_generation,
            })
        };
        if let Some(relay) = self.account_relay.lock().unwrap().as_ref() {
            if let Some(registration) = registration(&relay.host) {
                return (wire::RelayState::Registered, Some(registration));
            }
            return (unregistered_relay_state(relay.link.ended(), &relay.host.status().borrow()), None);
        }
        if !state.hosting() || !self.account_relay_allowed {
            return (wire::RelayState::Off, None);
        }
        if state.relay_superseded.is_some() {
            (wire::RelayState::Superseded, None)
        } else if state.relay_signed_out {
            (wire::RelayState::SignedOut, None)
        } else {
            (wire::RelayState::Off, None)
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

    /// Capture the admission fence with route selection, before any handshake.
    #[cfg(unix)]
    pub(crate) fn phone_admission(&self) -> Option<PhoneAdmission> {
        let state = self.state.lock().unwrap();
        if !state.hosting() || state.phone_route.as_ref().is_some_and(|route| route.attachment.valid()) { return None; }
        let phones = self.phones.get()?.clone();
        let stopped = phones.stopped();
        let epoch = *stopped.borrow();
        Some((phones, state.keypair.clone()?, state.port()?, stopped, epoch))
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
        #[cfg(unix)]
        let desktop_phones = if self.phones.get().is_some() && self.keys.needs_window() {
            match tokio::task::spawn_blocking(crate::phone::registry::has_paired_phone).await {
                Ok(Ok(paired)) => paired,
                _ => false,
            }
        } else { false };
        #[cfg(not(unix))]
        let desktop_phones = false;
        let (was_hosting, was_enabled, hosting, enabled) = {
            let mut state = self.state.lock().unwrap();
            if let Some(settings) = &settings {
                state.allowed = settings.machines.allow_operating;
                state.keep_awake = settings.pairing.keep_awake;
                state.plan = Some(crate::listen::Plan::of(&settings.machines));
                crate::listen::remember(state.plan());
            }
            // Addresses come and go (Tailscale up, a new network): the
            // listeners follow them on every pass.
            state.interfaces = crate::listen::interfaces();
            let was = (state.hosting(), state.enabled);
            let network = !crate::data_privacy::enabled();
            state.enabled = state.allowed && network;
            if state.phone_route.as_ref().is_some_and(|route| !route.attachment.valid()) {
                state.phone_route = None;
            }
            // Leave a first pairing on the window's active routes. Moving
            // them before the phone installs its resume token can strand it.
            state.desktop_phones = desktop_phones && network
                && (was.0 || (state.phone_route.is_none() && !self.window_available()));
            // A code or a request that ran out leaves the status at once.
            state.pairing.tick(now_ms());
            (was.0, was.1, state.hosting(), state.enabled)
        };
        self.retire_code_invites();
        if was_hosting && !hosting {
            self.stop_serving();
        } else if was_enabled && !enabled {
            Self::stop_computers(&mut self.state.lock().unwrap(), self.activity.clone());
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
        if hosting {
            if let Err(error) = self.clone().serve().await {
                let busy = error.chain().any(|cause| cause.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::AddrInUse));
                let mut state = self.state.lock().unwrap();
                state.bind_error = Some(format!("{error:#}"));
                state.port_busy = busy;
            }
        }
        self.clone().reconcile_relay(read || was_hosting != hosting).await;
        self.hold_awake();
        self.publish();
    }

    /// Register with the relay from the signed-in account while the switch is
    /// on (PRO-368), and stop when it goes off, the machine signs out or a
    /// newer runtime process takes the relay. Whether someone signed in is
    /// read from the session file on `read` passes only.
    async fn reconcile_relay(self: Arc<Self>, read: bool) {
        if !self.account_relay_allowed {
            return;
        }
        let (enabled, secret) = {
            let state = self.state.lock().unwrap();
            (state.hosting(), state.keypair.as_ref().map(|keypair| *keypair.secret()))
        };
        let rpc = match &*self.rpc.lock().unwrap() {
            Rpc::Ready(rpc) => Some(rpc.clone()),
            _ => None,
        };
        let wanted = enabled && crate::remote::account_link::relay_enabled();
        let (Some(secret), Some(rpc), true) = (secret, rpc, wanted) else {
            self.stop_relay("off");
            if !enabled {
                let mut state = self.state.lock().unwrap();
                state.relay_signed_out = false;
            }
            return;
        };
        let running = self.account_relay.lock().unwrap().as_ref().map(|relay| (relay.link.ended(), relay.link.user_id(), relay.host.relay_host_id()));
        if let Some((ended, user, host_id)) = running {
            let saved = if read && ended.is_none() {
                let data_dir = self.data_dir.clone();
                match tokio::task::spawn_blocking(move || crate::machine_account::load(&data_dir)).await {
                    Ok(Ok(session)) => Some(session.map(|session| session.cloud.user_id)),
                    _ => None,
                }
            } else {
                None
            };
            let stop = running_relay_stop(ended, &host_id, &HostKeypair::from_secret(secret).host_id(), user.as_deref(), saved.as_ref().map(Option::as_deref));
            if let Some(stop) = stop {
                {
                    let mut state = self.state.lock().unwrap();
                    match stop {
                        RelayStop::Superseded => state.relay_superseded = user,
                        RelayStop::OwnerConflict => state.relay_refused = user.map(|user| (user, Instant::now())),
                        RelayStop::SignedOut => state.relay_signed_out = true,
                        RelayStop::HostKeyChanged | RelayStop::AnotherAccount => {}
                    }
                }
                self.stop_relay(stop.why());
            }
            return;
        }
        if !read {
            return;
        }
        let data_dir = self.data_dir.clone();
        let user = tokio::task::spawn_blocking(move || crate::machine_account::load(&data_dir)).await;
        let user = match user {
            Ok(Ok(session)) => session.map(|session| session.cloud.user_id),
            Ok(Err(error)) => {
                log::warn!("machine host: read the account session: {error:#}");
                None
            }
            Err(_) => None,
        };
        let Some(user) = user else {
            self.state.lock().unwrap().relay_signed_out = true;
            return;
        };
        {
            let mut state = self.state.lock().unwrap();
            state.relay_signed_out = false;
            let refused = state.relay_refused.as_ref().map(|(user, at)| (user.as_str(), *at));
            if !may_register(&user, state.relay_superseded.as_deref(), refused, Instant::now()) {
                return;
            }
            state.relay_superseded = None;
            state.relay_refused = None;
        }
        self.start_relay(secret, rpc);
    }

    /// Register with the relay as `secret`'s host, serving `rpc`.
    fn start_relay(self: &Arc<Self>, secret: [u8; 32], rpc: Arc<WorkspaceRpc>) {
        let window = self.account_window();
        #[cfg(unix)]
        let publish_directory = std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() != Ok("1") && self.phones.get().is_some();
        #[cfg(not(unix))]
        let publish_directory = false;
        let link = Arc::new(crate::remote::account_link::AccountLink::new(self.data_dir.clone(), secret, window));
        let host = crate::remote::host::RelayHost::new(link.clone(), rpc, None);
        // Before it registers, so no connection is answered without them.
        host.set_routes(self.clone());
        let sink = self.sink.clone();
        #[cfg(unix)]
        let weak = Arc::downgrade(self);
        host.on_pairing_hint(Arc::new(move || {
            #[cfg(unix)]
            if let Some(phones) = weak.upgrade().and_then(|machine| machine.phones.get().cloned()) {
                phones.account_revocation_hint();
            }
            sink.emit(wire::RELAY_HINT_EVENT, &json!({}));
        }));
        self.use_relay(&host);
        let mut status = host.status();
        let weak = Arc::downgrade(self);
        let watch = tokio::spawn(async move {
            while status.changed().await.is_ok() {
                let Some(machine) = weak.upgrade() else { return };
                if matches!(&*status.borrow(), crate::remote::host::HostStatus::Registered { .. }) {
                    log::info!("machine host: registered with the relay");
                }
                machine.wake.notify_one();
            }
        });
        let directory = publish_directory.then(|| tokio::spawn(crate::machine_account::directory::publish(
            self.data_dir.clone(), secret, link.clone(), host.clone(),
        )));
        tokio::spawn(host.clone().run());
        *self.account_relay.lock().unwrap() = Some(AccountRelay { host, link, watch, directory });
        log::info!("machine host: registering with the relay for the signed-in account");
    }

    /// End the account's relay registration and the connections it carried;
    /// paired computers fall back to the direct routes.
    fn stop_relay(&self, why: &str) {
        let Some(relay) = self.account_relay.lock().unwrap().take() else { return };
        relay.watch.abort();
        relay.host.stop();
        if let Some(directory) = relay.directory {
            directory.abort();
        }
        *self.relay.lock().unwrap() = None;
        log::info!("machine host: no relay registration ({why})");
    }

    /// The desktop window that keeps the account's session, when the desktop
    /// started this runtime.
    fn account_window(&self) -> Option<Arc<dyn crate::remote::account_link::AccountWindow>> {
        #[cfg(unix)]
        {
            let lifetime = self.lifetime.clone()?;
            (std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() == Ok("1")).then(|| Arc::new(LifetimeWindow(lifetime)) as Arc<dyn crate::remote::account_link::AccountWindow>)
        }
        #[cfg(not(unix))]
        {
            None
        }
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
        for listening in state.listeners.drain(..) {
            listening.stop();
        }
        state.bind_error = None;
        Self::stop_computers(&mut state, self.activity.clone());
        // A connection on the port keeps the window from binding it again.
        for (_, (_, cancel)) in state.phones.drain() {
            let _ = cancel.send(());
        }
        #[cfg(unix)]
        if let Some(phones) = self.phones.get() { phones.invalidate(); }
        drop(state);
        #[cfg(unix)]
        if let Some(phones) = self.phones.get().cloned() {
            Self::off_task(move || phones.stop());
        }
        log::info!("machine host: off; listener and connections closed");
    }

    fn stop_computers(state: &mut State, activity: activity::Log) {
        state.pairing.end(wire::REFUSED_CODE_INACTIVE);
        let labels = std::mem::take(&mut state.labels);
        for (computer_id, connections) in state.connections.drain() {
            for tracked in connections {
                let _ = tracked.cancel.send(());
            }
            let label = labels.get(&computer_id).cloned().unwrap_or_default();
            let log = activity.clone();
            Self::off_task(move || log.record(activity::Entry::new(activity::Kind::Disconnected, Some((&computer_id, &label)), None)));
        }
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
        let Some(rpc) = self.rpc()? else { return Ok(()) };
        if built {
            rpc.set_machine_access(Arc::new(HostAccess::new(&self)));
        }
        self.listen_where_chosen(rpc)
    }

    /// Bring the listeners in line with the listen setting and this
    /// computer's addresses now: close the ones no longer wanted, with the
    /// connections that came in on them, and open the missing ones. "Relay
    /// only" wants none.
    fn listen_where_chosen(self: &Arc<Self>, rpc: Arc<WorkspaceRpc>) -> Result<()> {
        let missing: Vec<std::net::Ipv4Addr> = {
            let mut state = self.state.lock().unwrap();
            let wanted = state.plan().binds(&state.interfaces);
            let unwanted: Vec<_> = state.bound().into_iter().filter(|address| !matches!(address.ip(), std::net::IpAddr::V4(ip) if wanted.contains(&ip))).collect();
            for address in unwanted {
                state.close_listener(address);
                log::info!("machine host: no longer listening on {address}");
            }
            let bound = state.bound();
            if wanted.is_empty() {
                state.bind_error = None;
            }
            wanted.into_iter().filter(|ip| !bound.iter().any(|address| address.ip() == std::net::IpAddr::V4(*ip))).collect()
        };
        let mut failed = None;
        for ip in missing {
            match direct::listen(self.clone(), rpc.clone(), std::net::SocketAddr::from((ip, self.port))) {
                Ok(listening) => {
                    log::info!("machine host: listening on {}", listening.address);
                    self.state.lock().unwrap().listeners.push(listening);
                }
                // The address left between reading the interfaces and
                // binding it: the next pass no longer wants it.
                Err(error) if error.chain().any(|cause| cause.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::AddrNotAvailable)) => {
                    log::debug!("machine host: {ip} is not this computer's address any more");
                }
                Err(error) => failed = Some(error),
            }
        }
        match failed {
            Some(error) => Err(error),
            None => {
                self.state.lock().unwrap().bind_error = None;
                Ok(())
            }
        }
    }

    /// The addresses the listeners answer on, waiting a moment for the
    /// supervisor to open them when the setting asks for some and none is up
    /// yet: a code asked for right after the switch, the key or the listen
    /// choice arrived names the addresses about to listen, instead of being
    /// refused as unreachable. Whether anything listens, and its addresses
    /// (none on a computer with no network address but loopback). Blocking,
    /// for at most [`LISTENER_WAIT`].
    fn endpoints_once_listening(&self) -> (bool, Vec<String>) {
        let deadline = std::time::Instant::now() + LISTENER_WAIT;
        loop {
            {
                let state = self.state.lock().unwrap();
                let bound = state.bound();
                // Nothing will listen: "Relay only", no address of the chosen kind, or the port could not be bound.
                let expected = state.plan.is_none() || !state.plan().binds(&state.interfaces).is_empty();
                if !bound.is_empty() || !state.enabled || !expected || state.bind_error.is_some() || std::time::Instant::now() >= deadline {
                    return (!bound.is_empty(), crate::direct_endpoints::bound_endpoints(&bound, wire::MACHINE_PATH));
                }
            }
            self.wake.notify_one();
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// End the relay invites of pairing codes that ended unused there, so a
    /// leaked code cannot be used through the relay later.
    fn retire_code_invites(&self) {
        let retired = self.state.lock().unwrap().pairing.take_retired();
        if retired.is_empty() {
            return;
        }
        let Some(relay) = self.relay() else { return };
        for device in retired {
            relay.revoke_device(&device);
        }
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
    fn track(&self, computer: &registry::PairedComputer, route: ComputerRoute, via: Option<std::net::SocketAddr>, cancel: mpsc::UnboundedSender<()>) -> Result<(u64, bool)> {
        let id = self.next_connection.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let first = {
            let mut state = self.state.lock().unwrap();
            if !state.enabled {
                bail!("other computers may not operate this machine now");
            }
            let connections = state.connections.entry(computer.id.clone()).or_default();
            let first = connections.is_empty();
            connections.push(Tracked { id, cancel, route, via });
            state.labels.insert(computer.id.clone(), computer.label.clone());
            first
        };
        self.hold_awake();
        self.wake.notify_one();
        Ok((id, first))
    }

    /// Let a computer in with `token` by `route` (`via` the listener it
    /// came in on, on a direct route):
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
    pub(crate) fn admit(&self, computer: &registry::PairedComputer, token: &str, route: ComputerRoute, via: Option<std::net::SocketAddr>, cancel: mpsc::UnboundedSender<()>) -> Result<Result<u64, &'static str>> {
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
        let (tracked, first) = self.track(computer, route, via, cancel)?;
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
    pub(crate) fn track_phone(&self, via: Option<std::net::SocketAddr>, cancel: mpsc::UnboundedSender<()>) -> Option<u64> {
        let id = self.next_connection.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut state = self.state.lock().unwrap();
        state.hosting().then(|| {
            state.phones.insert(id, (via, cancel));
            id
        })
    }

    pub(crate) fn untrack_phone(&self, id: u64) {
        self.state.lock().unwrap().phones.remove(&id);
    }

    fn register_phone_route(&self, route: PhoneRoute) -> Result<(), ControlError> {
        let mut state = self.state.lock().unwrap();
        if state.phone_route.as_ref().is_some_and(|current| current.attachment.valid() && current.lease != route.lease) {
            return Err(ControlError::new("busy", "Another window takes this machine's phones.", None::<String>));
        }
        state.phone_route = Some(route);
        #[cfg(unix)]
        if let Some(phones) = self.phones.get() { phones.invalidate(); }
        drop(state);
        #[cfg(unix)]
        if let Some(phones) = self.phones.get() { phones.stop(); }
        Ok(())
    }

    /// Where a phone goes: the window's route while its attachment is current.
    pub(crate) fn phone_route(&self) -> Option<PathBuf> {
        self.direct_phone_route().map(|(socket, _)| socket)
    }

    fn direct_phone_route(&self) -> Option<(PathBuf, bool)> {
        let state = self.state.lock().unwrap();
        state.phone_route.as_ref().filter(|route| route.attachment.valid()).map(|route| (route.socket.clone(), route.device_scoped))
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
            account_relay_allowed: false,
            account_relay: Mutex::new(None),
            refusals: crate::listen::Refusals::default(),
        });
        rpc.set_machine_access(Arc::new(HostAccess::new(&host)));
        let listening = direct::listen_everywhere(host.clone(), rpc, 0)?;
        host.state.lock().unwrap().listeners.push(listening);
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
            account_relay_allowed: false,
            account_relay: Mutex::new(None),
            refusals: crate::listen::Refusals::default(),
        });
        rpc.set_machine_access(Arc::new(HostAccess::new(&host)));
        host
    }

    #[cfg(test)]
    pub(crate) fn port_for_test(&self) -> u16 {
        self.state.lock().unwrap().port().expect("listening")
    }

    #[cfg(test)]
    pub(crate) fn expire_code_for_test(&self) {
        self.state.lock().unwrap().pairing.expire_code_for_test(now_ms());
    }

    #[cfg(test)]
    pub(crate) fn stop_for_test(&self) {
        self.stop_serving();
    }

    /// Listen as `plan` asks on a computer with `interfaces`, as a
    /// reconcile pass does after reading the settings.
    #[cfg(test)]
    pub(crate) fn listen_for_test(self: &Arc<Self>, plan: crate::listen::Plan, interfaces: Vec<std::net::Ipv4Addr>) -> Result<()> {
        {
            let mut state = self.state.lock().unwrap();
            state.plan = Some(plan);
            state.interfaces = interfaces;
        }
        let rpc = self.rpc()?.context("the test host has its rpc")?;
        self.listen_where_chosen(rpc)
    }

    /// A live code whose relay invite is for `relay_device_id`, as
    /// `create_code` makes on a machine registered with the relay: its token.
    #[cfg(test)]
    pub(crate) fn code_with_relay_for_test(&self, relay_device_id: &str) -> String {
        self.state.lock().unwrap().pairing.create(now_ms(), None, Some((relay_device_id.to_string(), i64::MAX))).expect("pairing is not paused").0
    }

    /// A new pairing code (docs/MACHINES.md, "As built (PRO-342)"). The
    /// code is answered to the caller only: never logged, never in the status.
    /// `grant_request_id`: the account grant it answers (PRO-349); the
    /// computer still waits for Allow with the fingerprint, as for any code.
    pub fn create_code(&self, grant_request_id: Option<String>) -> Result<wire::CreatedCode, ControlError> {
        let (public_key_b64, machine_id) = {
            let state = self.state.lock().unwrap();
            let not_enabled = |message: &str| ControlError::new("not_enabled", message, Some("Turn on \"Let other computers operate this Mac\".".into()));
            if !state.enabled {
                return Err(not_enabled("Other computers may not operate this machine now."));
            }
            let keypair = state.keypair.as_ref().ok_or_else(|| not_enabled("The machine's host key is not ready yet."))?;
            (keypair.public_key_b64(), keypair.host_id())
        };
        // Read before the code exists, so it is not shortened by slow commands.
        let machine = self.identity(&machine_id);
        // Only addresses a listener answers on: none under "Relay only".
        let (listening, endpoints) = self.endpoints_once_listening();
        // The way in with no listener open, or none the computer can reach
        // (PRO-487): an invite for a fresh relay device.
        let relay = self.code_invite(&machine_id);
        if !listening && relay.is_none() {
            return Err(ControlError::new(
                "not_reachable",
                "This machine opens no port and is not connected to the TerminalX relay, so no computer could use a code.",
                Some("Sign in to TerminalX on it (`terminalx-serve login` on a server), or choose where it listens (`terminalx-serve hosting --listen lan`).".into()),
            ));
        }
        let invite = relay.as_ref().map(|relay| (relay.relay_device_id.clone(), relay.invite_expires_at));
        let (token, expires_at) = {
            let mut state = self.state.lock().unwrap();
            match state.pairing.create(now_ms(), grant_request_id, invite) {
                Ok(created) => created,
                Err(until) => {
                    drop(state);
                    if let (Some(invite), Some(host)) = (&relay, self.relay()) {
                        host.revoke_device(&invite.relay_device_id);
                    }
                    let mut paused = ControlError::new("pairing_paused", "Too many wrong pairing attempts. Try again in a minute.", None::<String>);
                    paused.details = Some(json!({ "pausedUntil": until }));
                    return Err(paused);
                }
            }
        };
        // The code it replaced: its invite ends now, not on the next pass.
        self.retire_code_invites();
        let mut code = wire::MachineCode::new(token, public_key_b64, machine, endpoints, expires_at);
        code.relay = relay;
        let code = code.encode().map_err(ControlError::internal)?;
        self.wake.notify_one();
        Ok(wire::CreatedCode { code, expires_at })
    }

    /// The relay half of a new pairing code: a single-use invite for a fresh
    /// relay device, from the live registration. `None` while this machine
    /// is not registered with the relay, or the relay does not answer: the
    /// code then names its direct endpoints only. Blocking, for up to
    /// [`CODE_INVITE_WAIT`].
    fn code_invite(&self, host_id: &str) -> Option<wire::MachineRelay> {
        let relay = self.relay()?;
        let registration = relay.registration().filter(|registration| registration.relay_host_id == host_id)?;
        let relay_device_id = format!("computer-{}", uuid::Uuid::new_v4().simple());
        let req_id = uuid::Uuid::new_v4().to_string();
        let invited = (|| -> Result<(String, i64)> {
            let reply = relay
                .forward_control(json!({ "type": "invite-create", "reqId": req_id, "relayDeviceId": relay_device_id }))?
                .recv_timeout(CODE_INVITE_WAIT)
                .context("the relay did not answer")??;
            anyhow::ensure!(relay.registration().as_ref() == Some(&registration), "the relay registration changed meanwhile");
            anyhow::ensure!(reply["type"] == "invite-created" && reply["reqId"] == req_id, "the relay refused");
            let token = reply["inviteToken"].as_str().filter(|token| crate::remote::host::valid_base64url_32(token)).context("the relay sent an invalid invite")?;
            let expires_at = reply["expiresAt"].as_i64().filter(|expiry| *expiry > now_ms()).context("the relay sent an expired invite")?;
            Ok((token.to_string(), expires_at))
        })();
        match invited {
            Ok((invite_token, invite_expires_at)) => Some(wire::MachineRelay {
                director_url: registration.director_url,
                cell_url: registration.cell_url,
                assignment_epoch: registration.assignment_epoch,
                relay_host_id: registration.relay_host_id,
                relay_device_id,
                invite_token,
                invite_expires_at,
            }),
            Err(error) => {
                log::warn!("machine host: no relay invite for the pairing code: {error:#}");
                // It may have been made after all: end it.
                relay.revoke_device(&relay_device_id);
                None
            }
        }
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
        // Paired again through the relay: the relay device it had is retired.
        let replaced_relay_device = existing.as_ref().and_then(|computer| computer.relay_device_id.clone()).filter(|had| approving.relay_device_id.as_ref().is_some_and(|new| new != had));
        let mut computer = registry::PairedComputer {
            id: id.clone(),
            token_hash: approving.token_hash,
            label: approving.label,
            platform: approving.platform,
            client_public_key_b64: Some(approving.client_key_b64),
            fingerprint: Some(approving.fingerprint),
            approved_at: now,
            last_seen_at: None,
            // Paired through the relay: the relay device of the code's invite
            // is its own from now on (PRO-487).
            relay_device_id: approving.relay_device_id.clone().or_else(|| existing.as_ref().and_then(|computer| computer.relay_device_id.clone())),
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
        if let (Some(replaced), Some(relay)) = (replaced_relay_device, self.relay()) {
            relay.revoke_device(&replaced);
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
        let (keypair, port, epoch) = {
            let state = self.state.lock().unwrap();
            if self.window_available() || state.phone_route.as_ref().is_some_and(|route| route.attachment.valid()) {
                return Err(window_takes_phones("Pair the phone in TerminalX: Settings → Devices."));
            }
            if !state.hosting() {
                return Err(ControlError::new("not_enabled", "Phone hosting is off.", None::<String>));
            }
            (state.keypair.clone(), state.port(), *phones.stopped().borrow())
        };
        let Some(keypair) = keypair else {
            return Err(ControlError::new("not_enabled", "The machine's host key is not ready yet.", None::<String>));
        };
        phones.create_code(&keypair, port, epoch).map(|created| serde_json::to_value(created).expect("a code serialises"))
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
                self.settings_changed.notify_one();
                Ok(json!({ "adopted": true }))
            }
            wire::PHONE_ROUTE | wire::PHONE_ROUTE_BOUND => {
                let route: wire::PhoneRoute = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and socket are required"))?;
                let attachment = self.attachment(&route.epoch, &route.lease)?;
                if let Err(error) = private_socket(&self.data_dir, &route.socket) {
                    return Err(ControlError::new("invalid_route", format!("{error:#}"), None::<String>));
                }
                self.register_phone_route(PhoneRoute { attachment, lease: route.lease, socket: route.socket, device_scoped: command == wire::PHONE_ROUTE_BOUND })?;
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
            wire::RELAY_CONTROL => {
                let request: wire::RelayControl = serde_json::from_value(params).map_err(|_| ControlError::invalid("epoch, lease and frame are required"))?;
                self.attachment(&request.epoch, &request.lease)?;
                let offline = |message: String| ControlError::new("relay_offline", message, None::<String>);
                let relay = self.relay().filter(|relay| relay.is_registered()).ok_or_else(|| offline("This machine is not registered with the relay.".into()))?;
                let reply = relay.forward_control(request.frame).map_err(|error| offline(format!("{error:#}")))?;
                match reply.recv_timeout(RELAY_CONTROL_WAIT) {
                    Ok(Ok(reply)) => Ok(reply),
                    Ok(Err(error)) => Err(ControlError::invalid(format!("{error:#}"))),
                    Err(_) => Err(offline("The relay did not answer.".into())),
                }
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
                // A window serving phones holds their connections and grants:
                // it removes them itself, so they close at once.
                if self.phone_route().is_some() {
                    return Err(window_takes_phones("Remove the phone in TerminalX: Settings → Devices."));
                }
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
    fn pair_computer(self: Arc<Self>, asking: crate::remote::host::RelayAsking) -> futures_util::future::BoxFuture<'static, Result<Option<Result<(), &'static str>>>> {
        Box::pin(async move {
            // Only the relay device the live code's invite was made for asks;
            // any other is a paired computer's, admitted or refused as one.
            if !self.state.lock().unwrap().pairing.is_relay_device(&asking.relay_device_id) {
                return Ok(None);
            }
            let keypair = self.keypair().context("the machine host key is not loaded")?;
            let decision = self.ask(Asking {
                token_hash: registry::token_hash(&asking.token),
                client_key_b64: &asking.client_key_b64,
                label: direct::computer_label(asking.label.as_deref()),
                platform: direct::computer_platform(asking.platform.as_deref()),
                fingerprint: direct::computer_fingerprint(keypair.public(), &asking.client_key_b64, &asking.token)?,
                transport: "relay",
                relay_device_id: Some(&asking.relay_device_id),
            });
            let (request_id, outcome) = match decision {
                Decision::Wait { request_id, outcome } => (request_id, outcome),
                Decision::Refuse(reason) => return Ok(Some(Err(reason))),
            };
            // The relay host drops this future when the computer gives up:
            // the request is left then, as a closed direct connection leaves it.
            struct Leave<'a>(&'a MachineHost, &'a str, bool);
            impl Drop for Leave<'_> {
                fn drop(&mut self) {
                    if self.2 {
                        self.0.leave(self.1);
                    }
                }
            }
            let mut leave = Leave(&self, &request_id, true);
            let answered = direct::await_allow(&self, std::future::pending(), &request_id, outcome).await;
            leave.2 = false;
            match answered {
                Some(pairing::Outcome::Approved) => Ok(Some(Ok(()))),
                Some(pairing::Outcome::Refused(reason)) => Ok(Some(Err(reason))),
                Some(pairing::Outcome::Waiting) | None => anyhow::bail!("the pairing request ended without an answer"),
            }
        })
    }

    fn is_computer(&self, relay_device_id: &str) -> bool {
        // A computer pairing with the live code's invite is one too (PRO-487).
        if self.state.lock().unwrap().pairing.is_relay_device(relay_device_id) {
            return true;
        }
        self.registry.knows_relay_device(relay_device_id).unwrap_or_else(|error| {
            log::warn!("machine host: read paired computers: {error:#}");
            // Unreadable: never hand an unknown connection to the window as a phone's.
            true
        })
    }

    fn admit_computer(&self, relay_device_id: &str, token: &str, client_key_b64: &str, cancel: mpsc::UnboundedSender<()>) -> Result<Result<(String, u64), &'static str>> {
        let Some(computer) = self.registry.find_by_relay_device(relay_device_id, token)? else { return Ok(Err(wire::REFUSED_CODE_INACTIVE)) };
        let Some(computer) = self.paired_with_key(computer, client_key_b64) else { return Ok(Err(wire::REFUSED_CODE_INACTIVE)) };
        let tracked = match self.admit(&computer, token, ComputerRoute::Relay, None, cancel)? {
            Ok(tracked) => tracked,
            Err(reason) => return Ok(Err(reason)),
        };
        log::info!("machine host: computer {} connected through the relay", computer.id);
        Ok(Ok((computer.id, tracked)))
    }

    fn release_computer(&self, computer_id: &str, tracked: u64) {
        self.untrack(computer_id, tracked);
    }

    fn forward_phone(&self, forwarded: wire::Forwarded, mut relay_cancel: mpsc::UnboundedReceiver<()>) -> bool {
        // Route selection and the stop subscription share the takeover lock.
        // A window registered after this point invalidates the entire runtime
        // connection, including a phone still in its handshake or approval.
        let state = self.state.lock().unwrap();
        if !state.hosting() { return false; }
        let route = state.phone_route.as_ref().filter(|route| route.attachment.valid()).map(|route| route.socket.clone());
        if route.is_none() {
            #[cfg(unix)]
            {
                let Some(phones) = self.phones.get().cloned() else { return false };
                let Some(keypair) = state.keypair.clone() else { return false };
                let port = state.port();
                let mut stopped = phones.stopped();
                let epoch = *stopped.borrow();
                drop(state);
                tokio::spawn(async move {
                    tokio::select! {
                        biased;
                        _ = stopped.changed() => {},
                        _ = relay_cancel.recv() => {},
                        result = phones.serve_relay(keypair, forwarded, port, epoch) => {
                            if let Err(error) = result { log::debug!("machine host: relay phone closed: {error:#}"); }
                        }
                    }
                });
                return true;
            }
            #[cfg(not(unix))]
            return false;
        }
        drop(state);
        let route = route.unwrap();
        #[cfg(unix)]
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let sent = async {
                let mut window = tokio::net::UnixStream::connect(&route).await?;
                window.write_all(&wire::encode_header(&forwarded)?).await?;
                let mut byte = [0; 1];
                let _ = window.read(&mut byte).await;
                anyhow::Ok(())
            };
            tokio::select! {
                biased;
                _ = relay_cancel.recv() => {},
                result = sent => if let Err(error) = result {
                    log::debug!("machine host: pass a phone's relay connection to the window: {error:#}");
                },
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

    fn hosting_facts(&self) -> Option<(Value, Value)> {
        let host = self.host.upgrade()?;
        let state = host.state.lock().unwrap();
        let listen = serde_json::to_value(host.listen_status(&state)).ok()?;
        let runs_as = serde_json::to_value(crate::listen::runs_as_now(state.hosting())).ok()?;
        Some((listen, runs_as))
    }

    fn set_listen(&self, params: Value) -> futures_util::future::BoxFuture<'static, Result<Value, crate::remote::protocol::RpcError>> {
        use crate::remote::protocol::RpcError;
        let host = self.host.upgrade();
        Box::pin(async move {
            let host = host.ok_or_else(|| RpcError::new("unavailable", "the machine host stopped"))?;
            let listen = params["listen"].as_str().and_then(crate::listen::Listen::from_word).ok_or_else(|| RpcError::invalid("listen is one of relay, tailscale, lan, all"))?;
            let allow_public = match &params["allowPublic"] {
                Value::Null => false,
                Value::Bool(allow) => *allow,
                _ => return Err(RpcError::invalid("allowPublic is true or false")),
            };
            let status = tokio::task::spawn_blocking(move || host.set_listen(listen, allow_public))
                .await
                .map_err(RpcError::internal)?
                .map_err(|error| if error.code == "not_reachable" { RpcError::new("unavailable", error.message) } else { RpcError::internal(error.message) })?;
            Ok(json!({ "listen": status }))
        })
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

/// The desktop window, as the account's relay session sees it (PRO-368).
#[cfg(unix)]
struct LifetimeWindow(Arc<crate::local_runtime::Lifetime>);

#[cfg(unix)]
impl crate::remote::account_link::AccountWindow for LifetimeWindow {
    fn attached(&self) -> bool {
        self.0.window.available()
    }

    fn refresh(&self) -> Result<()> {
        self.0.window.refresh_account()
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
