//! The operating computer's connection to a paired machine (PRO-345,
//! docs/MACHINES.md "Connect", "Reconnect" and "As built (PRO-345)").
//!
//! One [`MachineSupervisor`] per machine owns its connection ([`Owners`]
//! keeps it to one). A round tries the routes [`plan_routes`] gives in turn:
//! the route that last worked, every `lan` endpoint, every `tailscale`
//! endpoint, then the relay when the record allows it, this computer holds a
//! relay credential and the account that obtained it is signed in. Each
//! connection runs E2EE v2 pinned to the machine's key with this
//! installation's client key, proves the device token in `e2ee_auth`, then
//! `rpc.hello` and `machine.describe`.
//!
//! The supervisor reconnects with `protocol::backoff`, ends in
//! `accessRemoved` or `needsUpdate` until "Try again" (PRO-354: `side` says
//! whether the machine or this computer is the older one), shows `updating`
//! instead of `reconnecting` while the machine hands its runtime over to a new
//! version (`machine.updateChanged`, at most [`UPDATING_FOR`]), and moves from the
//! relay back to a direct route without the web view reloading: the new
//! link takes the frames, the web view is told `connected` with a new
//! `link`, and the relay link drains answers for ten seconds.
//!
//! Nothing here is Tauri's: [`MachineEnv`] reads the record, the Keychain
//! and the account, and [`Dialer`] makes connections, so tests stand in for
//! both and the serve tests drive it against a real runtime.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::net::Ipv4Addr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
/// Re-exported for callers that build a [`Target`].
pub use zeroize::Zeroizing;

use super::client::{self, authenticate, pump_frames, relay_connect, Authenticated, ClientEvent, ClientState, Closed, Connection, Credential, RelayRoute};
use super::host::{jitter, now_ms, websocket_config};
use super::protocol::{self, CAPABILITIES, PROTOCOL};
use crate::relay_e2ee::E2eeClientHandshake;

/// A direct endpoint gets this long to connect and finish the handshake.
pub const DIRECT_TIMEOUT: Duration = Duration::from_secs(3);
/// The relay gets this long.
pub const RELAY_TIMEOUT: Duration = Duration::from_secs(15);
/// Each call after the handshake (`rpc.hello`, `machine.describe`, …).
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// A nudge while connected checks the link with `machine.describe` this long.
pub const LIVENESS_TIMEOUT: Duration = Duration::from_secs(3);
/// While connected: `machine.describe` (and, on the relay, a direct probe) this often.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// After a move to a direct route, the relay link stays open this long for answers.
pub const DRAIN: Duration = Duration::from_secs(10);
/// A link lost this long ago with no route answering since is `offline`.
pub const OFFLINE_AFTER: Duration = Duration::from_secs(30);
/// Request ids the supervisor sends itself; their answers never reach the web view.
const OWN_REQUEST_PREFIX: &str = "machine-supervisor-";
/// The close code of a refused credential.
const CREDENTIAL_REFUSED: u16 = 4401;
/// A link lost while the machine hands over to a new version is `updating`, not `reconnecting`, for at most this long.
pub const UPDATING_FOR: Duration = Duration::from_secs(180);
/// This desktop's TerminalX version, compared with a machine's to say which side updates.
pub const THIS_VERSION: &str = env!("CARGO_PKG_VERSION");

// ------------------------------------------------------------------ shapes

/// How the operating computer reaches a machine (`MachineRoute` in src/types/machines.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MachineRoute {
    RelayAndNearby,
    ThisNetwork,
}

/// `MachineRouteKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Lan,
    Tailscale,
    Relay,
}

/// `MachineRouteUsed`: `endpoint` is the direct address, null for the relay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteUsed {
    pub kind: RouteKind,
    pub endpoint: Option<String>,
}

/// `MachineRelayInfo`: where this computer reaches the machine through the
/// relay. Never the credential, which is in the Keychain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: u64,
    pub relay_host_id: String,
    pub relay_device_id: String,
    /// The account that obtained the credential.
    pub user_id: String,
}

/// A relay credential: where, and the resume token.
#[derive(Clone)]
pub struct RelayCredential {
    pub info: RelayInfo,
    pub resume_token: Zeroizing<String>,
}

impl std::fmt::Debug for RelayCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayCredential").field("info", &self.info).finish_non_exhaustive()
    }
}

/// `MachineConnectionState` in src/types/machines.ts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "state")]
pub enum MachineConnectionState {
    Idle,
    Connecting {
        trying: Vec<RouteKind>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        local_network_denied: bool,
    },
    Direct {
        route: RouteUsed,
        since: i64,
        rtt_ms: Option<u64>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        local_network_denied: bool,
    },
    Relay {
        route: RouteUsed,
        since: i64,
        rtt_ms: Option<u64>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        local_network_denied: bool,
    },
    Reconnecting {
        lost_at: i64,
        attempt: u32,
        retry_in_ms: u64,
        trying: Vec<RouteKind>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        local_network_denied: bool,
    },
    Offline {
        last_seen_at: Option<i64>,
        retry_in_ms: u64,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        local_network_denied: bool,
    },
    NeedsUpdate {
        version: Option<String>,
        side: MachineUpdateSide,
    },
    /// The machine is handing its runtime over to `version` (PRO-354); the lost link is expected.
    Updating {
        version: String,
        since: i64,
    },
    AccessRemoved,
    /// The person on the machine pressed Disconnect (PRO-357): refused until
    /// they let this computer back. Nothing retries until "Try again".
    Disconnected,
}

/// Which computer must update for the two to work together (`MachineUpdateSide`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MachineUpdateSide {
    /// The machine is older, or its version is unknown.
    Machine,
    /// The machine is newer than this desktop.
    ThisMac,
}

fn parse_version(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version.trim().trim_start_matches('v')).ok()
}

/// Which side updates (docs/MACHINES.md "Which side updates"): this Mac when
/// the machine's version is above this desktop's `ours`, or, with no version
/// known, when the machine offers a namespace this desktop does not know (it
/// is the newer one). Otherwise the machine.
pub fn update_side(machine_version: Option<&str>, offered: &[String], ours: &str) -> MachineUpdateSide {
    if let (Some(theirs), Some(ours)) = (machine_version.and_then(parse_version), parse_version(ours)) {
        return if theirs > ours { MachineUpdateSide::ThisMac } else { MachineUpdateSide::Machine };
    }
    let known = wanted_capabilities();
    if machine_version.is_none() && !offered.is_empty() && offered.iter().any(|name| !known.contains(&name.as_str())) {
        return MachineUpdateSide::ThisMac;
    }
    MachineUpdateSide::Machine
}

/// `rpc.hello` refused with `update_required`: the runtime's version and what
/// it offers, from `data: { runtimeVersion, offered }` (an older runtime sends none).
pub fn update_required_failure(error: &Value) -> DialFailure {
    let data = &error["data"];
    let version = data["runtimeVersion"].as_str().map(str::to_string);
    let offered = data["offered"].as_array().map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    DialFailure::NeedsUpdate { version, offered }
}

/// What a `machine.updateChanged` notification says about a handover: the
/// version and since when while `handingOver`, `Some(None)` for any other
/// phase, `None` when it is not that notification.
pub fn handing_over(message: &Value) -> Option<Option<(String, i64)>> {
    if message["event"] != "machine.updateChanged" {
        return None;
    }
    let progress = &message["params"]["status"]["progress"];
    if progress["phase"] != "handingOver" {
        return Some(None);
    }
    let version = progress["version"].as_str()?.to_string();
    Some(Some((version, progress["since"].as_i64().unwrap_or_else(now_ms))))
}

impl MachineConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, Self::Direct { .. } | Self::Relay { .. })
    }
}

/// `MachineConnectionView`: `machines_connections` and `machines_connection_changed`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineConnectionView {
    pub machine_id: String,
    pub state: MachineConnectionState,
}

// ------------------------------------------------------------------ routes

/// One route to try.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    Direct { kind: RouteKind, endpoint: String },
    Relay,
}

impl Route {
    pub fn kind(&self) -> RouteKind {
        match self {
            Route::Direct { kind, .. } => *kind,
            Route::Relay => RouteKind::Relay,
        }
    }

    pub fn used(&self) -> RouteUsed {
        match self {
            Route::Direct { kind, endpoint } => RouteUsed { kind: *kind, endpoint: Some(endpoint.clone()) },
            Route::Relay => RouteUsed { kind: RouteKind::Relay, endpoint: None },
        }
    }

    /// How long the route gets to connect and finish the handshake.
    pub fn timeout(&self) -> Duration {
        match self {
            Route::Direct { .. } => DIRECT_TIMEOUT,
            Route::Relay => RELAY_TIMEOUT,
        }
    }
}

/// The host of a `ws://host:port/path` endpoint.
fn endpoint_host(endpoint: &str) -> Option<String> {
    let url = url::Url::parse(endpoint).ok()?;
    url.host_str().map(|host| host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase())
}

/// `tailscale`: a host in `100.64.0.0/10` or under `.ts.net`; any other
/// direct endpoint is `lan`. A label for the route, never an authentication
/// decision (decision 6).
pub fn classify(endpoint: &str) -> RouteKind {
    let Some(host) = endpoint_host(endpoint) else { return RouteKind::Lan };
    if host.ends_with(".ts.net") {
        return RouteKind::Tailscale;
    }
    match host.parse::<Ipv4Addr>() {
        Ok(address) if address.octets()[0] == 100 && (address.octets()[1] & 0xC0) == 64 => RouteKind::Tailscale,
        _ => RouteKind::Lan,
    }
}

/// Whether the relay may be tried: the record says "relay and nearby", this
/// computer holds a credential for the machine, and the account that
/// obtained it is the one signed in now.
pub fn relay_allowed(route: MachineRoute, relay: Option<&RelayInfo>, signed_in: Option<&str>) -> bool {
    route == MachineRoute::RelayAndNearby && relay.zip(signed_in).is_some_and(|(relay, user)| relay.user_id == user)
}

/// One round, in order: the route that last worked, every `lan` endpoint,
/// every `tailscale` endpoint, then the relay when [`relay_allowed`].
pub fn plan_routes(target: &Target, signed_in: Option<&str>) -> Vec<Route> {
    let relay = relay_allowed(target.route, target.relay.as_ref().map(|relay| &relay.info), signed_in);
    let direct: Vec<Route> = [RouteKind::Lan, RouteKind::Tailscale]
        .into_iter()
        .flat_map(|kind| target.direct_endpoints.iter().filter(move |endpoint| classify(endpoint) == kind).map(move |endpoint| Route::Direct { kind, endpoint: endpoint.clone() }))
        .collect();
    let mut routes = Vec::new();
    match target.last_route.as_ref() {
        Some(RouteUsed { kind: RouteKind::Relay, .. }) if relay => routes.push(Route::Relay),
        Some(RouteUsed { endpoint: Some(endpoint), .. }) => {
            if let Some(route) = direct.iter().find(|route| matches!(route, Route::Direct { endpoint: known, .. } if known == endpoint)) {
                routes.push(route.clone());
            }
        }
        _ => {}
    }
    for route in direct {
        if !routes.contains(&route) {
            routes.push(route);
        }
    }
    if relay && !routes.contains(&Route::Relay) {
        routes.push(Route::Relay);
    }
    routes
}

fn kinds(routes: &[Route]) -> Vec<RouteKind> {
    let mut kinds = Vec::new();
    for route in routes {
        if !kinds.contains(&route.kind()) {
            kinds.push(route.kind());
        }
    }
    kinds
}

/// macOS refused Local Network access: `EHOSTUNREACH` to a private or
/// link-local address.
pub fn local_network_denied(endpoint: &str, error: &(dyn std::error::Error + 'static)) -> bool {
    let private = endpoint_host(endpoint).and_then(|host| host.parse::<Ipv4Addr>().ok()).is_some_and(|address| address.is_private() || address.is_link_local());
    if !private {
        return false;
    }
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = cause {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            if is_host_unreachable(io) {
                return true;
            }
        }
        if let Some(tokio_tungstenite::tungstenite::Error::Io(io)) = current.downcast_ref::<tokio_tungstenite::tungstenite::Error>() {
            if is_host_unreachable(io) {
                return true;
            }
        }
        cause = current.source();
    }
    false
}

fn is_host_unreachable(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::EHOSTUNREACH)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

// ------------------------------------------------------------------ wake and network change

/// A wake: the wall clock moved more than three seconds further than the
/// monotonic clock, which stands still while the computer sleeps.
pub fn woke(wall_elapsed: Duration, monotonic_elapsed: Duration) -> bool {
    wall_elapsed.saturating_sub(monotonic_elapsed) > Duration::from_secs(3)
}

/// Checked every second by the desktop.
pub struct WakeDetector {
    wall: std::time::SystemTime,
    monotonic: Instant,
}

impl Default for WakeDetector {
    fn default() -> Self {
        Self { wall: std::time::SystemTime::now(), monotonic: Instant::now() }
    }
}

impl WakeDetector {
    /// Whether the computer slept since the last check.
    pub fn check(&mut self) -> bool {
        let (wall, monotonic) = (std::time::SystemTime::now(), Instant::now());
        let woke = woke(wall.duration_since(self.wall).unwrap_or_default(), monotonic.duration_since(self.monotonic));
        (self.wall, self.monotonic) = (wall, monotonic);
        woke
    }
}

/// This computer's interface addresses; a change is a network change.
pub fn interface_addresses() -> BTreeSet<String> {
    if_addrs::get_if_addrs().unwrap_or_default().into_iter().filter(|interface| !interface.is_loopback()).map(|interface| format!("{}:{}", interface.name, interface.ip())).collect()
}

// ------------------------------------------------------------------ environment and dialing

/// What one round needs, read afresh for each.
#[derive(Clone)]
pub struct Target {
    pub machine_id: String,
    /// The pinned host key, standard base64.
    pub public_key_b64: String,
    pub direct_endpoints: Vec<String>,
    pub route: MachineRoute,
    pub last_route: Option<RouteUsed>,
    pub last_seen_at: Option<i64>,
    pub device_token: Zeroizing<String>,
    pub client_secret: Zeroizing<[u8; 32]>,
    /// This computer's name and platform, as `e2ee_auth` names them.
    pub label: String,
    pub platform: String,
    /// The relay credential, when this computer holds one.
    pub relay: Option<RelayCredential>,
}

/// The record, the Keychain and the account. Calls may block; the
/// supervisor makes them off its task.
pub trait MachineEnv: Send + Sync + 'static {
    /// The record, the device token and the client key; the relay
    /// credential only when it is the signed-in account's.
    fn target(&self) -> Result<Target>;
    /// The account signed in now. Cheap.
    fn signed_in_user(&self) -> Option<String>;
    /// A successful `machine.describe` on `route`: keep name, os, version,
    /// `directEndpoints`, `lastSeenAt` and `lastRoute`.
    fn described(&self, described: &Value, route: &RouteUsed);
    fn save_relay(&self, credential: &RelayCredential) -> Result<()>;
    /// Keep a rotated device token in place of the current one (PRO-357).
    fn save_token(&self, _token: &str) -> Result<()> {
        Ok(())
    }
    /// The relay refused the credential: forget it.
    fn drop_relay(&self);
    /// The machine's TerminalX version as the record last saw it, for which
    /// side updates when the runtime does not say (PRO-354).
    fn recorded_version(&self) -> Option<String> {
        None
    }
}

/// Why a route did not connect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DialFailure {
    /// `pairing_refused`, or `4401` once the device token was offered.
    AccessRemoved,
    /// `pairing_refused` `disconnected`: held off by the person on the machine.
    Disconnected,
    /// The runtime does not grant `machine/1`, or refused `rpc.hello` with
    /// `update_required`: its version and the namespaces it offers, when it said.
    NeedsUpdate { version: Option<String>, offered: Vec<String> },
    /// The relay refused the resume credential (`4401`; `4404` is the machine offline).
    RelayCredentialRefused,
    Unreachable { local_network_denied: bool, reason: String },
}

impl DialFailure {
    fn unreachable(reason: impl std::fmt::Display) -> Self {
        Self::Unreachable { local_network_denied: false, reason: protocol::redact(&reason.to_string()) }
    }
}

/// A paired computer's relay invite (`machine.relayAccess`).
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayAccess {
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: u64,
    pub relay_host_id: String,
    pub relay_device_id: String,
    pub invite_token: String,
    pub invite_expires_at: i64,
}

impl std::fmt::Debug for RelayAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayAccess").field("relay_host_id", &self.relay_host_id).field("relay_device_id", &self.relay_device_id).finish_non_exhaustive()
    }
}

/// An established link: hello and describe answered, frames flowing.
pub struct Established {
    /// `rpc.hello`'s result.
    pub hello: Value,
    /// `machine.describe`'s result.
    pub described: Value,
    pub rtt_ms: Option<u64>,
    /// To the machine. Dropping it closes the link.
    pub frames: mpsc::UnboundedSender<Value>,
    /// Relay access, when it was asked for and the machine has a relay.
    pub relay_access: Option<RelayAccess>,
    /// A fresh device token (`machine/5`, PRO-357), which the supervisor
    /// keeps in place of the one it connected with.
    pub rotated_token: Option<Zeroizing<String>>,
}

/// What a link sends its supervisor.
#[derive(Debug)]
pub enum LinkEvent {
    Message(Value),
    Closed(Closed),
}

pub type LinkEvents = mpsc::UnboundedSender<(u64, LinkEvent)>;
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Makes connections. The real one is [`NetDialer`]; tests stand in.
pub trait Dialer: Send + Sync + 'static {
    /// Connect on `route` and establish link number `link`, whose messages and
    /// end go to `events`. `relay_access`: also ask for relay access.
    fn dial(&self, target: Arc<Target>, route: Route, relay_access: bool, link: u64, events: LinkEvents) -> BoxFuture<Result<Established, DialFailure>>;
    /// Use an invite once: connect through the relay, prove the device token,
    /// install a fresh resume credential, close. `user_id` obtained it.
    fn provision(&self, target: Arc<Target>, access: RelayAccess, user_id: String) -> BoxFuture<Result<RelayCredential>>;
}

// ------------------------------------------------------------------ the real dialer

/// Direct (`ws://…/machine/1`) and relay connections.
pub struct NetDialer;

impl Dialer for NetDialer {
    fn dial(&self, target: Arc<Target>, route: Route, relay_access: bool, link: u64, events: LinkEvents) -> BoxFuture<Result<Established, DialFailure>> {
        Box::pin(async move {
            let mut connection = match &route {
                Route::Direct { endpoint, .. } => open_direct(&target, endpoint).await?,
                Route::Relay => open_relay(&target).await?,
            };
            let mut established = establish(&mut connection, &target, relay_access).await?;
            established.frames = spawn_pump(connection, link, events);
            Ok(established)
        })
    }

    fn provision(&self, target: Arc<Target>, access: RelayAccess, user_id: String) -> BoxFuture<Result<RelayCredential>> {
        Box::pin(async move { provision(&target, access, user_id).await })
    }
}

fn auth_fields(target: &Target) -> Value {
    json!({ "deviceToken": target.device_token.as_str(), "label": target.label, "platform": target.platform })
}

/// After the token was offered: a sealed refusal or a `4401` is "access removed".
async fn prove(connection: &mut Connection, target: &Target, deadline: tokio::time::Instant) -> Result<(), DialFailure> {
    match authenticate(connection, auth_fields(target), deadline).await {
        Ok(Authenticated::Yes) => Ok(()),
        Ok(Authenticated::Refused(reason)) => {
            log::info!("machines: machine {} refused this computer ({reason})", target.machine_id);
            if reason == crate::machine_wire::REFUSED_DISCONNECTED {
                return Err(DialFailure::Disconnected);
            }
            Err(DialFailure::AccessRemoved)
        }
        Err(Closed { code: Some(CREDENTIAL_REFUSED), .. }) => Err(DialFailure::AccessRemoved),
        Err(closed) => Err(DialFailure::unreachable(closed.reason)),
    }
}

async fn open_direct(target: &Target, endpoint: &str) -> Result<Connection, DialFailure> {
    let deadline = tokio::time::Instant::now() + DIRECT_TIMEOUT;
    let request = endpoint.into_client_request().map_err(DialFailure::unreachable)?;
    let (mut socket, _) = match tokio::time::timeout_at(deadline, crate::data_privacy::connect(request, Some(websocket_config()), true)).await {
        Err(_) => return Err(DialFailure::unreachable("timed out")),
        Ok(Err(error)) => {
            let denied = local_network_denied(endpoint, &error);
            return Err(DialFailure::Unreachable { local_network_denied: denied, reason: protocol::redact(&error.to_string()) });
        }
        Ok(Ok(opened)) => opened,
    };
    let handshake = E2eeClientHandshake::with_secret(*target.client_secret, &target.public_key_b64, "direct", None).map_err(DialFailure::unreachable)?;
    use futures_util::SinkExt;
    let hello = serde_json::to_string(handshake.hello()).map_err(DialFailure::unreachable)?;
    socket.send(tokio_tungstenite::tungstenite::Message::Text(hello.into())).await.map_err(DialFailure::unreachable)?;
    let ready = client::plaintext(&mut socket, deadline).await.map_err(|closed| DialFailure::unreachable(closed.reason))?;
    // Pinned: another key is not this machine.
    let session = handshake.accept_ready(&ready).map_err(DialFailure::unreachable)?;
    let mut connection = Connection { socket, session };
    prove(&mut connection, target, deadline).await?;
    Ok(connection)
}

/// The cell for the credential, from the director as the phone asks
/// (`POST /v1/resolve`), else the saved one.
async fn resolve_cell(relay: &RelayCredential) -> (String, u64) {
    let saved = (relay.info.cell_url.clone(), relay.info.assignment_epoch);
    let url = format!("{}/v1/resolve", relay.info.director_url.trim_end_matches('/'));
    let body = json!({ "v": 1, "relayHostId": relay.info.relay_host_id, "resumeToken": relay.resume_token.as_str() });
    let resolved = tokio::task::spawn_blocking(move || -> Result<(String, u64)> {
        let response: Value = crate::data_privacy::http_agent()
            .build()
            .post(&url)
            .timeout(Duration::from_secs(5))
            .send_json(body)
            .map_err(|error| anyhow!("relay resolve failed: {}", protocol::redact(&error.to_string())))?
            .into_json()?;
        let cell = response["cellUrl"].as_str().ok_or_else(|| anyhow!("resolve lacks cellUrl"))?.to_string();
        let epoch = response["assignmentEpoch"].as_u64().ok_or_else(|| anyhow!("resolve lacks assignmentEpoch"))?;
        Ok((cell, epoch))
    })
    .await;
    match resolved {
        Ok(Ok(resolved)) => resolved,
        Ok(Err(error)) => {
            log::debug!("machines: {error:#}; using the saved relay cell");
            saved
        }
        Err(_) => saved,
    }
}

async fn open_relay(target: &Target) -> Result<Connection, DialFailure> {
    let relay = target.relay.as_ref().ok_or_else(|| DialFailure::unreachable("no relay credential"))?;
    let deadline = tokio::time::Instant::now() + RELAY_TIMEOUT;
    let (cell_url, _) = resolve_cell(relay).await;
    let route = RelayRoute { cell_url: &cell_url, relay_host_id: &relay.info.relay_host_id, public_key_b64: &target.public_key_b64, client_secret: Some(*target.client_secret) };
    let mut connection = match relay_connect(&route, &Credential::Resume(relay.resume_token.to_string()), None, deadline).await {
        Ok(connection) => connection,
        // Only `4401` is the credential refused; `4404` is the machine
        // offline at the relay, which retries the same credential.
        Err(Closed { code: Some(CREDENTIAL_REFUSED), .. }) => return Err(DialFailure::RelayCredentialRefused),
        Err(closed) => return Err(DialFailure::unreachable(closed.reason)),
    };
    prove(&mut connection, target, deadline).await?;
    Ok(connection)
}

/// A request before the link is handed over: the answer, or its error.
async fn request(connection: &mut Connection, method: &str, params: Value) -> Result<Result<Value, Value>, DialFailure> {
    let id = format!("{OWN_REQUEST_PREFIX}{}", uuid::Uuid::new_v4().simple());
    connection.send(&json!({ "id": id, "method": method, "params": params })).await.map_err(DialFailure::unreachable)?;
    let deadline = tokio::time::Instant::now() + CALL_TIMEOUT;
    loop {
        let value = match tokio::time::timeout_at(deadline, connection.next()).await {
            Err(_) => return Err(DialFailure::unreachable(format!("{method} timed out"))),
            Ok(Err(closed)) => return Err(DialFailure::unreachable(closed.reason)),
            Ok(Ok(value)) => value,
        };
        if value["id"] == id.as_str() {
            return Ok(if value["ok"] == true { Ok(value["result"].clone()) } else { Err(value["error"].clone()) });
        }
    }
}

/// What this computer asks for: every namespace it knows, and the machine's.
pub fn wanted_capabilities() -> Vec<&'static str> {
    CAPABILITIES.iter().copied().chain([super::machine::MACHINE, super::machine::MACHINE_2, super::machine::MACHINE_3, super::machine::MACHINE_4, super::machine::MACHINE_5, super::machine::MACHINE_6, super::machine::MACHINE_7, super::machine::MACHINE_8]).collect()
}

/// `rpc.hello`, `machine.describe` and, when asked, `machine.relayAccess`.
async fn establish(connection: &mut Connection, target: &Target, want_relay_access: bool) -> Result<Established, DialFailure> {
    let hello = json!({ "protocol": PROTOCOL, "client": { "app": "terminalx-desktop", "version": env!("CARGO_PKG_VERSION") }, "want": wanted_capabilities() });
    let hello = match request(connection, "rpc.hello", hello).await? {
        Ok(hello) => hello,
        Err(error) if error["code"] == "update_required" => return Err(update_required_failure(&error)),
        Err(error) => return Err(DialFailure::unreachable(format!("rpc.hello refused: {}", error["code"]))),
    };
    let granted = |capability: &str| hello["capabilities"].as_array().is_some_and(|granted| granted.iter().any(|name| name == capability));
    if !granted(super::machine::MACHINE) {
        let offered = hello["capabilities"].as_array().map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        return Err(DialFailure::NeedsUpdate { version: hello["runtime"]["version"].as_str().map(str::to_string), offered });
    }
    let started = Instant::now();
    let described = request(connection, "machine.describe", json!({})).await?.map_err(|error| DialFailure::unreachable(format!("machine.describe refused: {}", error["code"])))?;
    let rtt_ms = Some(started.elapsed().as_millis() as u64);
    if described["machineId"] != target.machine_id.as_str() {
        return Err(DialFailure::unreachable("another machine answered"));
    }
    let relay_access = if want_relay_access && granted(super::machine::MACHINE_2) {
        match request(connection, "machine.relayAccess", json!({})).await? {
            Ok(answer) if answer["relay"].is_object() => match serde_json::from_value::<RelayAccess>(answer["relay"].clone()) {
                Ok(access) if access.relay_host_id == target.machine_id => Some(access),
                _ => {
                    log::warn!("machines: the machine's relay access was not for it");
                    None
                }
            },
            Ok(_) => None,
            Err(error) => {
                log::debug!("machines: machine.relayAccess refused: {}", error["code"]);
                None
            }
        }
    } else {
        None
    };
    // A fresh credential on every connection (PRO-357). The machine keeps the
    // old one working until this computer connects with the new one, so a
    // lost answer or a token that could not be saved locks nothing out.
    let rotated_token = if granted(super::machine::MACHINE_5) {
        match request(connection, "machine.rotateCredential", json!({})).await? {
            Ok(answer) => answer["deviceToken"].as_str().filter(|token| (16..=256).contains(&token.len())).map(|token| Zeroizing::new(token.to_string())),
            Err(error) => {
                log::debug!("machines: machine.rotateCredential refused: {}", error["code"]);
                None
            }
        }
    } else {
        None
    };
    let (frames, _) = mpsc::unbounded_channel();
    Ok(Established { hello, described, rtt_ms, frames, relay_access, rotated_token })
}

/// Frames both ways on `connection`, as link `link`, until it ends.
fn spawn_pump(connection: Connection, link: u64, events: LinkEvents) -> mpsc::UnboundedSender<Value> {
    let (frames, mut outgoing) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        // Never stopped this way: dropping `frames` closes the link.
        let (_never, mut stopped) = watch::channel(false);
        let deliver = events.clone();
        let closed = pump_frames(connection, &mut outgoing, |value| {
            let _ = deliver.send((link, LinkEvent::Message(value)));
        }, &mut stopped)
        .await;
        let _ = events.send((link, LinkEvent::Closed(closed)));
    });
    frames
}

async fn provision(target: &Target, access: RelayAccess, user_id: String) -> Result<RelayCredential> {
    if access.relay_host_id != target.machine_id {
        bail!("relay access for another machine");
    }
    let deadline = tokio::time::Instant::now() + RELAY_TIMEOUT;
    let route = RelayRoute { cell_url: &access.cell_url, relay_host_id: &access.relay_host_id, public_key_b64: &target.public_key_b64, client_secret: Some(*target.client_secret) };
    let mut connection = relay_connect(&route, &Credential::Invite(access.invite_token.clone()), None, deadline).await.map_err(|closed| anyhow!("relay invite: {} {}", closed.code.unwrap_or(0), closed.reason))?;
    match authenticate(&mut connection, auth_fields(target), deadline).await {
        Ok(Authenticated::Yes) => {}
        _ => bail!("the machine did not authenticate this computer through the relay"),
    }
    let resume = Zeroizing::new(client::random_token());
    let hash = general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(resume.as_bytes()));
    let installed = request(&mut connection, "pairing.provisionRelay", json!({ "reqId": uuid::Uuid::new_v4().simple().to_string(), "newResumeTokenHash": hash })).await;
    let _ = connection.socket.close(None).await;
    match installed {
        Ok(Ok(_)) => Ok(RelayCredential {
            info: RelayInfo {
                director_url: access.director_url,
                cell_url: access.cell_url,
                assignment_epoch: access.assignment_epoch,
                relay_host_id: access.relay_host_id,
                relay_device_id: access.relay_device_id,
                user_id,
            },
            resume_token: resume,
        }),
        Ok(Err(error)) => bail!("pairing.provisionRelay refused: {}", error["code"]),
        Err(failure) => bail!("pairing.provisionRelay: {failure:?}"),
    }
}

// ------------------------------------------------------------------ the supervisor

enum Command {
    /// Wake, a network change or a route probe: check the link, or retry now.
    Nudge,
    /// "Try again": a nudge that also leaves `accessRemoved` and `needsUpdate`.
    TryAgain,
    /// The signed-in account or the machine's route setting changed: the
    /// relay may no longer be used.
    RelayRulesChanged,
}

struct Shared {
    machine_id: String,
    /// The current link's frames.
    outbound: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    commands: mpsc::UnboundedSender<Command>,
    stopped: watch::Sender<bool>,
    state: Mutex<MachineConnectionState>,
    /// To the web views: states and messages.
    events: mpsc::UnboundedSender<ClientEvent>,
    /// The last state the web views were told. Held while one is sent, so a
    /// replay never lands after a newer state.
    told: Mutex<Option<ClientState>>,
    /// The web views holding this connection, by label. A reload holds again
    /// under the same label; the owner stops when the last lets go.
    holders: Mutex<HashSet<String>>,
}

impl Shared {
    fn tell(&self, state: ClientState) {
        let mut told = self.told.lock().unwrap();
        *told = Some(state.clone());
        let _ = self.events.send(ClientEvent::State(state));
    }
}

/// Called with each new state.
pub type OnState = Arc<dyn Fn(&MachineConnectionView) + Send + Sync>;

/// The one owner of a machine's connection.
#[derive(Clone)]
pub struct MachineSupervisor {
    shared: Arc<Shared>,
}

impl MachineSupervisor {
    /// Start connecting. Messages and the web view's states go to `events`;
    /// each machine state to `on_state`. Call inside a Tokio runtime.
    pub fn start(machine_id: &str, env: Arc<dyn MachineEnv>, dialer: Arc<dyn Dialer>, events: mpsc::UnboundedSender<ClientEvent>, on_state: OnState) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        let (stopped, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            machine_id: machine_id.to_string(),
            outbound: Mutex::new(None),
            commands,
            stopped,
            state: Mutex::new(MachineConnectionState::Idle),
            events: events.clone(),
            told: Mutex::new(None),
            holders: Mutex::new(HashSet::new()),
        });
        let run = Run::new(shared.clone(), env, dialer, events, on_state);
        tokio::spawn(run.run(receiver));
        Self { shared }
    }

    pub fn machine_id(&self) -> &str {
        &self.shared.machine_id
    }

    /// Forward one frame to the machine on the current link. False when not
    /// connected: the web view resends after the next `connected`.
    pub fn send(&self, frame: Value) -> bool {
        self.shared.outbound.lock().unwrap().as_ref().is_some_and(|outbound| outbound.send(frame).is_ok())
    }

    pub fn nudge(&self) {
        let _ = self.shared.commands.send(Command::Nudge);
    }

    pub fn try_again(&self) {
        let _ = self.shared.commands.send(Command::TryAgain);
    }

    /// The signed-in account or the machine's route setting changed: a relay
    /// link the rules no longer allow is closed.
    pub fn relay_rules_changed(&self) {
        let _ = self.shared.commands.send(Command::RelayRulesChanged);
    }

    /// Hold the connection for the web view `holder` and tell it the current
    /// state at once. False when the owner has stopped: start another.
    pub fn hold(&self, holder: &str) -> bool {
        let mut holders = self.shared.holders.lock().unwrap();
        if self.is_stopped() {
            return false;
        }
        holders.insert(holder.to_string());
        drop(holders);
        self.replay();
        true
    }

    /// Whether the web view `holder` holds this connection.
    pub fn holds(&self, holder: &str) -> bool {
        self.shared.holders.lock().unwrap().contains(holder)
    }

    /// Let go for `holder` (every holder when `None`). Stops the owner when
    /// nobody holds it any more, and says whether it did.
    pub fn release(&self, holder: Option<&str>) -> bool {
        let mut holders = self.shared.holders.lock().unwrap();
        match holder {
            Some(holder) => {
                holders.remove(holder);
            }
            None => holders.clear(),
        }
        if holders.is_empty() {
            self.stop();
            true
        } else {
            false
        }
    }

    /// Tell the web views the current state again: a web view that attached
    /// to a live connection heard nothing of what came before.
    pub fn replay(&self) {
        let told = self.shared.told.lock().unwrap();
        if let Some(state) = told.as_ref() {
            let _ = self.shared.events.send(ClientEvent::State(state.clone()));
        }
    }

    pub fn stop(&self) {
        self.shared.stopped.send_replace(true);
        self.shared.outbound.lock().unwrap().take();
    }

    pub fn is_stopped(&self) -> bool {
        *self.shared.stopped.borrow()
    }

    pub fn state(&self) -> MachineConnectionState {
        self.shared.state.lock().unwrap().clone()
    }
}

/// A link the supervisor holds.
struct Live {
    id: u64,
    route: Route,
    frames: mpsc::UnboundedSender<Value>,
    since: i64,
    rtt_ms: Option<u64>,
    /// The web view's `connected` state for this link.
    connected: ClientState,
}

/// What a background attempt (a direct probe while on the relay, or using a
/// relay invite) came back with. At most one runs, and never beside a round.
enum Background {
    Probe(Option<(Route, u64, Established)>),
    Provision(Result<RelayCredential>),
}

/// A background attempt under way. Dropping it cancels the attempt.
struct BackgroundTask {
    task: tokio::task::JoinHandle<()>,
    done: tokio::sync::oneshot::Receiver<Background>,
}

impl BackgroundTask {
    fn spawn(attempt: impl Future<Output = Background> + Send + 'static) -> Self {
        let (sender, done) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = sender.send(attempt.await);
        });
        Self { task, done }
    }

    /// Cancel it, and wait until it has let go of what it was dialing.
    async fn cancel(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

impl Drop for BackgroundTask {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// How a round ended.
enum RoundEnd {
    Connected(Route, u64, Box<Established>),
    Failed,
    AccessRemoved,
    Disconnected,
    NeedsUpdate(Option<String>, Vec<String>),
    Stopped,
}

struct Run {
    shared: Arc<Shared>,
    env: Arc<dyn MachineEnv>,
    dialer: Arc<dyn Dialer>,
    events: mpsc::UnboundedSender<ClientEvent>,
    on_state: OnState,
    stopped: watch::Receiver<bool>,
    links: mpsc::UnboundedReceiver<(u64, LinkEvent)>,
    links_tx: LinkEvents,
    next_link: u64,
    attempt: u32,
    /// When the last link was lost; `None` before the first.
    lost_at: Option<i64>,
    /// When this owner started trying, for `offline` before any link.
    started: Instant,
    lost_instant: Option<Instant>,
    last_seen_at: Option<i64>,
    local_network_denied: bool,
    background: Option<BackgroundTask>,
    own_requests: u64,
    /// The route kinds of the last round, for the waiting states.
    trying: Vec<RouteKind>,
    /// The machine said it is handing over to this version, since then
    /// (`machine.updateChanged`), and when this computer heard it.
    updating: Option<(String, i64, Instant)>,
}

impl Run {
    fn new(shared: Arc<Shared>, env: Arc<dyn MachineEnv>, dialer: Arc<dyn Dialer>, events: mpsc::UnboundedSender<ClientEvent>, on_state: OnState) -> Self {
        let stopped = shared.stopped.subscribe();
        let (links_tx, links) = mpsc::unbounded_channel();
        Self {
            shared,
            env,
            dialer,
            events,
            on_state,
            stopped,
            links,
            links_tx,
            next_link: 1,
            attempt: 0,
            lost_at: None,
            started: Instant::now(),
            lost_instant: None,
            last_seen_at: None,
            local_network_denied: false,
            background: None,
            own_requests: 0,
            trying: Vec::new(),
            updating: None,
        }
    }

    fn set_state(&self, state: MachineConnectionState) {
        let changed = {
            let mut current = self.shared.state.lock().unwrap();
            let changed = *current != state;
            *current = state.clone();
            changed
        };
        if changed {
            (self.on_state)(&MachineConnectionView { machine_id: self.shared.machine_id.clone(), state });
        }
    }

    fn emit(&self, state: ClientState) {
        self.shared.tell(state);
    }

    fn stopped(&self) -> bool {
        *self.stopped.borrow()
    }

    async fn target(&self) -> Result<Arc<Target>> {
        let env = self.env.clone();
        Ok(Arc::new(tokio::task::spawn_blocking(move || env.target()).await??))
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        'own: loop {
            if self.stopped() {
                break;
            }
            // The link was lost while a background attempt ran. The round
            // starts now: a direct link the probe already found is used, a
            // relay credential already got is kept, and what is still under
            // way is cancelled first, so two attempts never run for one
            // machine at once and nobody waits for a probe of dead routes.
            let mut ready = None;
            if let Some(mut background) = self.background.take() {
                match background.done.try_recv() {
                    Ok(Background::Probe(Some(found))) => ready = Some(found),
                    Ok(Background::Provision(result)) => self.keep_credential(result).await,
                    _ => {}
                }
                background.cancel().await;
            }
            let end = match ready {
                Some((route, link, established)) => RoundEnd::Connected(route, link, Box::new(established)),
                None => self.round().await,
            };
            match end {
                RoundEnd::Stopped => break,
                RoundEnd::Connected(route, link, established) => {
                    if !self.connected(&mut commands, route, link, *established).await {
                        break;
                    }
                }
                RoundEnd::AccessRemoved | RoundEnd::Disconnected | RoundEnd::NeedsUpdate(..) => {
                    self.updating = None;
                    let state = match end {
                        RoundEnd::NeedsUpdate(version, offered) => {
                            self.emit(ClientState::UpdateRequired);
                            let version = match version {
                                Some(version) => Some(version),
                                None => {
                                    let env = self.env.clone();
                                    tokio::task::spawn_blocking(move || env.recorded_version()).await.ok().flatten()
                                }
                            };
                            let side = update_side(version.as_deref(), &offered, THIS_VERSION);
                            MachineConnectionState::NeedsUpdate { version, side }
                        }
                        RoundEnd::Disconnected => {
                            self.emit(ClientState::Stopped);
                            MachineConnectionState::Disconnected
                        }
                        _ => {
                            self.emit(ClientState::Stopped);
                            MachineConnectionState::AccessRemoved
                        }
                    };
                    self.set_state(state);
                    // Nothing retries until "Try again".
                    loop {
                        tokio::select! {
                            command = commands.recv() => match command {
                                Some(Command::TryAgain) => {
                                    self.attempt = 0;
                                    self.started = Instant::now();
                                    self.lost_instant = None;
                                    self.lost_at = None;
                                    continue 'own;
                                }
                                Some(_) => {}
                                None => break 'own,
                            },
                            _ = self.stopped.changed() => break 'own,
                        }
                    }
                }
                RoundEnd::Failed => {
                    self.attempt += 1;
                    let delay = protocol::backoff(self.attempt, jitter());
                    self.waiting(delay, self.trying.clone());
                    let mut deadline = tokio::time::Instant::now() + delay;
                    loop {
                        tokio::select! {
                            _ = tokio::time::sleep_until(deadline) => break,
                            _ = self.stopped.changed() => break 'own,
                            command = commands.recv() => match command {
                                // Retry at once, with the backoff from its start.
                                Some(Command::Nudge | Command::TryAgain) => {
                                    self.attempt = 0;
                                    break;
                                }
                                Some(Command::RelayRulesChanged) => {}
                                None => break 'own,
                            },
                            // A link that ended before it was ours: nothing to do.
                            _ = self.links.recv() => {}
                        }
                        if self.stopped() {
                            break 'own;
                        }
                        deadline = deadline.min(tokio::time::Instant::now() + delay);
                    }
                }
            }
        }
        self.shared.outbound.lock().unwrap().take();
        self.emit(ClientState::Stopped);
        self.set_state(MachineConnectionState::Idle);
    }

    /// `reconnecting` (or `offline` past 30 s, or `connecting` before the
    /// first link, or `updating` while the machine hands over to a new
    /// version, for at most [`UPDATING_FOR`]) while it waits `retry` before
    /// the next round.
    fn waiting(&mut self, retry: Duration, trying: Vec<RouteKind>) {
        let retry_in_ms = retry.as_millis() as u64;
        let since = self.lost_instant.unwrap_or(self.started);
        if self.updating.as_ref().is_some_and(|(_, _, heard)| heard.elapsed() >= UPDATING_FOR) {
            self.updating = None;
        }
        let updating = self.updating.as_ref().filter(|_| self.lost_at.is_some()).cloned();
        // A round starting (`retry` zero) past the offline mark has no next
        // try to name yet: the state already shown stays, with its real
        // retry time, rather than an `offline` that says it retries in 0 ms.
        if retry.is_zero() && updating.is_none() && since.elapsed() >= OFFLINE_AFTER {
            return;
        }
        let state = if let Some((version, since, _)) = updating.as_ref() {
            MachineConnectionState::Updating { version: version.clone(), since: *since }
        } else if since.elapsed() >= OFFLINE_AFTER {
            MachineConnectionState::Offline { last_seen_at: self.last_seen_at, retry_in_ms, local_network_denied: self.local_network_denied }
        } else if let Some(lost_at) = self.lost_at {
            MachineConnectionState::Reconnecting { lost_at, attempt: self.attempt, retry_in_ms, trying, local_network_denied: self.local_network_denied }
        } else {
            MachineConnectionState::Connecting { trying, local_network_denied: self.local_network_denied }
        };
        match &state {
            MachineConnectionState::Connecting { .. } => self.emit(ClientState::Connecting { attempt: self.attempt }),
            _ => self.emit(ClientState::Reconnecting { attempt: self.attempt.max(1), reason: "the machine is not reachable".into(), retry_in_ms, close_code: None }),
        }
        self.set_state(state);
    }

    /// One pass over the routes, in order, one at a time.
    async fn round(&mut self) -> RoundEnd {
        let target = match self.target().await {
            Ok(target) => target,
            Err(error) => {
                log::warn!("machines: machine {} cannot be connected: {}", self.shared.machine_id, protocol::redact(&format!("{error:#}")));
                return RoundEnd::Failed;
            }
        };
        self.last_seen_at = self.last_seen_at.max(target.last_seen_at);
        let signed_in = self.env.signed_in_user();
        let routes = plan_routes(&target, signed_in.as_deref());
        self.local_network_denied = false;
        self.trying = kinds(&routes);
        self.waiting(Duration::ZERO, self.trying.clone());
        let want_relay_access = target.route == MachineRoute::RelayAndNearby && signed_in.is_some() && target.relay.is_none();
        for route in routes {
            let link = self.next_link;
            self.next_link += 1;
            let dial = self.dialer.dial(target.clone(), route.clone(), want_relay_access && route != Route::Relay, link, self.links_tx.clone());
            // The route's own time, and the calls after the handshake.
            let limit = route.timeout() + CALL_TIMEOUT * 3;
            let dialed = tokio::select! {
                dialed = tokio::time::timeout(limit, dial) => dialed.unwrap_or_else(|_| Err(DialFailure::unreachable("timed out"))),
                _ = self.stopped.changed() => return RoundEnd::Stopped,
            };
            match dialed {
                Ok(established) => return RoundEnd::Connected(route, link, Box::new(established)),
                Err(DialFailure::AccessRemoved) => return RoundEnd::AccessRemoved,
                Err(DialFailure::Disconnected) => return RoundEnd::Disconnected,
                Err(DialFailure::NeedsUpdate { version, offered }) => return RoundEnd::NeedsUpdate(version, offered),
                Err(DialFailure::RelayCredentialRefused) => {
                    log::info!("machines: the relay refused this computer's credential for machine {}", self.shared.machine_id);
                    let env = self.env.clone();
                    let _ = tokio::task::spawn_blocking(move || env.drop_relay()).await;
                }
                Err(DialFailure::Unreachable { local_network_denied, reason }) => {
                    self.local_network_denied |= local_network_denied;
                    log::debug!("machines: a {:?} route to machine {} did not answer: {reason}", route.kind(), self.shared.machine_id);
                }
            }
        }
        RoundEnd::Failed
    }

    fn connected_state(&self, live: &Live) -> MachineConnectionState {
        let (route, since, rtt_ms, local_network_denied) = (live.route.used(), live.since, live.rtt_ms, self.local_network_denied);
        match live.route {
            Route::Relay => MachineConnectionState::Relay { route, since, rtt_ms, local_network_denied },
            Route::Direct { .. } => MachineConnectionState::Direct { route, since, rtt_ms, local_network_denied },
        }
    }

    /// Make `established` the link: frames go to it, the web view hears
    /// `connected` with its number, the record is brought up to date.
    async fn install(&mut self, route: Route, link: u64, established: Established) -> Live {
        let hello = &established.hello;
        let connected = ClientState::Connected {
            runtime_generation: hello["runtime"]["runtimeGeneration"].as_u64().unwrap_or(0),
            runtime_epoch: hello["runtime"]["epoch"].as_str().unwrap_or_default().to_string(),
            runtime_version: hello["runtime"]["version"].as_str().unwrap_or_default().to_string(),
            capabilities: serde_json::from_value(hello["capabilities"].clone()).unwrap_or_default(),
            authority: hello["authority"].as_str().unwrap_or_default().to_string(),
            you: None,
            link: Some(link),
        };
        // The rotated credential first, so every later connection (the relay
        // credential's too) proves the new one. Not saved: the old one is
        // used again, and the machine drops the new one then.
        if let Some(token) = established.rotated_token.clone() {
            let env = self.env.clone();
            match tokio::task::spawn_blocking(move || env.save_token(&token)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => log::warn!("machines: keep machine {}'s fresh credential: {error:#}", self.shared.machine_id),
                Err(error) => log::warn!("machines: keep machine {}'s fresh credential: {error}", self.shared.machine_id),
            }
        }
        // The record first: whoever hears `connected` reads the route it names.
        self.record(&established.described, &route).await;
        *self.shared.outbound.lock().unwrap() = Some(established.frames.clone());
        let live = Live { id: link, route, frames: established.frames, since: now_ms(), rtt_ms: established.rtt_ms, connected };
        self.attempt = 0;
        self.lost_at = None;
        self.lost_instant = None;
        // The machine answers again: an update it was handing over is done.
        self.updating = None;
        self.last_seen_at = Some(live.since);
        self.emit(live.connected.clone());
        self.set_state(self.connected_state(&live));
        if let Some(access) = established.relay_access {
            self.start_provision(access);
        }
        live
    }

    async fn record(&self, described: &Value, route: &Route) {
        let (env, described, used) = (self.env.clone(), described.clone(), route.used());
        let _ = tokio::task::spawn_blocking(move || env.described(&described, &used)).await;
    }

    fn start_provision(&mut self, access: RelayAccess) {
        if self.background.is_some() {
            return;
        }
        let Some(user) = self.env.signed_in_user() else { return };
        let (dialer, env) = (self.dialer.clone(), self.env.clone());
        self.background = Some(BackgroundTask::spawn(async move {
            let result = async {
                let target = Arc::new(tokio::task::spawn_blocking(move || env.target()).await??);
                tokio::time::timeout(RELAY_TIMEOUT + CALL_TIMEOUT, dialer.provision(target, access, user)).await.map_err(|_| anyhow!("relay invite timed out"))?
            }
            .await;
            Background::Provision(result)
        }));
    }

    async fn keep_credential(&self, result: Result<RelayCredential>) {
        match result {
            Ok(credential) => {
                // Kept only for the account that is still signed in.
                if self.env.signed_in_user().as_deref() != Some(credential.info.user_id.as_str()) {
                    return;
                }
                let env = self.env.clone();
                match tokio::task::spawn_blocking(move || env.save_relay(&credential)).await {
                    Ok(Ok(())) => log::info!("machines: this computer has relay access to machine {}", self.shared.machine_id),
                    Ok(Err(error)) => log::warn!("machines: keep the relay credential: {}", protocol::redact(&format!("{error:#}"))),
                    Err(_) => {}
                }
            }
            Err(error) => log::info!("machines: no relay access to machine {}: {}", self.shared.machine_id, protocol::redact(&format!("{error:#}"))),
        }
    }

    /// Probe the direct routes in the background while on the relay.
    async fn start_probe(&mut self) {
        if self.background.is_some() {
            return;
        }
        let Ok(target) = self.target().await else { return };
        let routes: Vec<Route> = plan_routes(&target, None).into_iter().filter(|route| *route != Route::Relay).collect();
        if routes.is_empty() {
            return;
        }
        let first = self.next_link;
        self.next_link += routes.len() as u64;
        let (dialer, links) = (self.dialer.clone(), self.links_tx.clone());
        self.background = Some(BackgroundTask::spawn(async move {
            let mut found = None;
            for (offset, route) in routes.into_iter().enumerate() {
                let link = first + offset as u64;
                let limit = route.timeout() + CALL_TIMEOUT * 3;
                if let Ok(Ok(established)) = tokio::time::timeout(limit, dialer.dial(target.clone(), route.clone(), false, link, links.clone())).await {
                    found = Some((route, link, established));
                    break;
                }
            }
            Background::Probe(found)
        }));
    }

    fn own_request(&mut self, live: &Live) -> String {
        self.own_requests += 1;
        let id = format!("{OWN_REQUEST_PREFIX}{}-{}", live.id, self.own_requests);
        let _ = live.frames.send(json!({ "id": id, "method": "machine.describe", "params": {} }));
        id
    }

    /// Serve the link until it is lost (true: run another round) or the
    /// owner stops (false).
    async fn connected(&mut self, commands: &mut mpsc::UnboundedReceiver<Command>, route: Route, link: u64, established: Established) -> bool {
        let mut live = self.install(route, link, established).await;
        // The relay link after a move to a direct route, and until when it drains.
        let mut draining: Option<(Live, tokio::time::Instant)> = None;
        // The describe in flight: its id, when sent, and when it must have answered.
        let mut check: Option<(String, Instant, tokio::time::Instant)> = None;
        let mut every = tokio::time::interval_at(tokio::time::Instant::now() + CHECK_INTERVAL, CHECK_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let far = || tokio::time::Instant::now() + Duration::from_secs(86_400);
        loop {
            let check_deadline = check.as_ref().map(|(_, _, deadline)| *deadline).unwrap_or_else(far);
            let drain_deadline = draining.as_ref().map(|(_, deadline)| *deadline).unwrap_or_else(far);
            let lost = tokio::select! {
                _ = self.stopped.changed() => return false,
                event = self.links.recv() => {
                    let Some((id, event)) = event else { return false };
                    if id == live.id {
                        match event {
                            LinkEvent::Message(message) => {
                                let own = message.get("id").and_then(Value::as_str).is_some_and(|id| id.starts_with(OWN_REQUEST_PREFIX));
                                match handing_over(&message) {
                                    Some(Some((version, since))) => self.updating = Some((version, since, Instant::now())),
                                    Some(None) => self.updating = None,
                                    None => {}
                                }
                                if !own {
                                    let _ = self.events.send(ClientEvent::Message(message));
                                } else if check.as_ref().is_some_and(|(wanted, _, _)| message["id"] == wanted.as_str()) {
                                    let (_, sent, _) = check.take().expect("a check");
                                    if message["ok"] == true {
                                        live.rtt_ms = Some(sent.elapsed().as_millis() as u64);
                                        self.last_seen_at = Some(now_ms());
                                        self.set_state(self.connected_state(&live));
                                        self.record(&message["result"], &live.route).await;
                                    }
                                }
                                None
                            }
                            LinkEvent::Closed(closed) => Some(closed),
                        }
                    } else {
                        if let Some((old, _)) = draining.as_ref().filter(|(old, _)| old.id == id) {
                            match event {
                                // Answers to requests already sent on it still arrive; its notifications do not.
                                LinkEvent::Message(message) => {
                                    let answer = message.get("id").and_then(Value::as_str).is_some_and(|id| !id.starts_with(OWN_REQUEST_PREFIX));
                                    if answer {
                                        let _ = self.events.send(ClientEvent::Message(message));
                                    }
                                }
                                LinkEvent::Closed(_) => {
                                    let _ = old;
                                    draining = None;
                                }
                            }
                        }
                        None
                    }
                }
                command = commands.recv() => {
                    match command {
                        None => return false,
                        Some(Command::Nudge | Command::TryAgain) => {
                            if check.is_none() {
                                let id = self.own_request(&live);
                                check = Some((id, Instant::now(), tokio::time::Instant::now() + LIVENESS_TIMEOUT));
                            }
                            if live.route == Route::Relay {
                                self.start_probe().await;
                            }
                            None
                        }
                        Some(Command::RelayRulesChanged) => {
                            let user = self.env.signed_in_user();
                            let still = self.target().await.map(|target| relay_allowed(target.route, target.relay.as_ref().map(|relay| &relay.info), user.as_deref())).unwrap_or(false);
                            if live.route == Route::Relay && !still {
                                // Signing out closes relay links (docs/MACHINES.md).
                                Some(Closed { code: None, reason: "signed out of the account".into() })
                            } else {
                                None
                            }
                        }
                    }
                }
                _ = every.tick() => {
                    if check.is_none() {
                        let id = self.own_request(&live);
                        check = Some((id, Instant::now(), tokio::time::Instant::now() + CALL_TIMEOUT));
                    }
                    if live.route == Route::Relay {
                        self.start_probe().await;
                    }
                    None
                }
                _ = tokio::time::sleep_until(check_deadline) => Some(Closed { code: None, reason: "the machine did not answer".into() }),
                _ = tokio::time::sleep_until(drain_deadline) => {
                    // Dropping its frames closes it.
                    draining = None;
                    None
                }
                finished = finish(&mut self.background) => {
                    match finished {
                        Some(Background::Probe(Some((route, link, established)))) if live.route == Route::Relay => {
                            // The direct route is the link from now on; the relay drains.
                            let old = std::mem::replace(&mut live, self.install(route, link, established).await);
                            check = None;
                            draining = Some((old, tokio::time::Instant::now() + DRAIN));
                        }
                        Some(Background::Provision(result)) => self.keep_credential(result).await,
                        _ => {}
                    }
                    None
                }
            };
            if let Some(closed) = lost {
                self.shared.outbound.lock().unwrap().take();
                if live.route == Route::Relay && closed.code == Some(CREDENTIAL_REFUSED) {
                    let env = self.env.clone();
                    let _ = tokio::task::spawn_blocking(move || env.drop_relay()).await;
                }
                log::info!("machines: lost the {:?} link to machine {}: {}", live.route.kind(), self.shared.machine_id, protocol::redact(&closed.reason));
                drop(live);
                drop(draining);
                self.lost_at = Some(now_ms());
                self.lost_instant = Some(Instant::now());
                return true;
            }
        }
    }
}

/// The background attempt's result, once it has one; never without one.
async fn finish(slot: &mut Option<BackgroundTask>) -> Option<Background> {
    let Some(background) = slot.as_mut() else { return std::future::pending().await };
    let finished = (&mut background.done).await.ok();
    *slot = None;
    finished
}

// ------------------------------------------------------------------ owners

/// At most one supervisor per machine, with the connection id it was
/// attached as.
#[derive(Default)]
pub struct Owners {
    owners: Mutex<HashMap<String, (String, MachineSupervisor)>>,
}

impl Owners {
    /// The machine's connection id for the web view `holder`: the live
    /// owner's, which tells it the current state at once, or one `start`
    /// makes now. Concurrent calls for one machine never start two.
    pub fn attach(&self, machine_id: &str, holder: &str, start: impl FnOnce() -> Result<(String, MachineSupervisor)>) -> Result<String> {
        let mut owners = self.owners.lock().unwrap();
        if let Some((connection_id, supervisor)) = owners.get(machine_id) {
            if supervisor.hold(holder) {
                return Ok(connection_id.clone());
            }
        }
        let (connection_id, supervisor) = start()?;
        supervisor.hold(holder);
        owners.insert(machine_id.to_string(), (connection_id.clone(), supervisor));
        Ok(connection_id)
    }

    pub fn get(&self, machine_id: &str) -> Option<MachineSupervisor> {
        self.owners.lock().unwrap().get(machine_id).filter(|(_, supervisor)| !supervisor.is_stopped()).map(|(_, supervisor)| supervisor.clone())
    }

    /// Every live owner.
    pub fn all(&self) -> Vec<MachineSupervisor> {
        self.owners.lock().unwrap().values().filter(|(_, supervisor)| !supervisor.is_stopped()).map(|(_, supervisor)| supervisor.clone()).collect()
    }

    /// Forget the owner attached as `connection_id` (it was detached).
    pub fn forget(&self, connection_id: &str) {
        self.owners.lock().unwrap().retain(|_, (id, _)| id != connection_id);
    }

    /// Stop and forget the machine's owner: it was removed.
    pub fn remove(&self, machine_id: &str) {
        let removed = self.owners.lock().unwrap().remove(machine_id);
        if let Some((_, supervisor)) = removed {
            supervisor.stop();
        }
    }

    /// Nudge every owner: a wake or a network change.
    pub fn nudge_all(&self) {
        for supervisor in self.all() {
            supervisor.nudge();
        }
    }
}

#[cfg(test)]
#[path = "machine_client_tests.rs"]
mod tests;
