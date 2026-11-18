//! What the runtime's machine host (PRO-341, `machine_host`) and the window
//! say to each other. Both builds compile it: the runtime serves these, and
//! the desktop calls them over its authenticated runtime IPC.
//!
//! The runtime hosts while "Let other computers operate this Mac" is on
//! (`machines.allowOperating`, docs/MACHINES.md decision 9). It then owns the
//! direct listener on TCP 6768, which phones already use. A connection that
//! asks for [`MACHINE_PATH`] is an operating computer and the runtime serves
//! it. Every other connection is a phone: the runtime passes it, untouched,
//! to the window that registered a [`PhoneRoute`], which runs the phone's
//! E2EE handshake and pairing exactly as before. With no window registered,
//! the phone is refused as unreachable, as it is today with the window closed.
//!
//! On a phone route the runtime opens one Unix connection per phone and
//! writes one [`Forwarded`] header line (`encode_header`) before anything
//! else. For [`Forwarded::Direct`] the phone's own bytes follow, from the
//! first byte of its HTTP upgrade request, in both directions until either
//! side closes. For [`Forwarded::Relay`] nothing follows: the window opens
//! the relay data leg itself with what the header names. The Unix connection
//! stays open for that leg's lifetime; either side closing it cancels the leg.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Keep a forwarded relay leg only while its runtime route remains open.
#[cfg(unix)]
pub async fn with_relay_route<F: std::future::Future>(mut route: tokio::net::UnixStream, leg: F) -> Option<F::Output> {
    use tokio::io::AsyncReadExt;
    let mut byte = [0; 1];
    tokio::select! {
        biased;
        _ = route.read(&mut byte) => None,
        result = leg => Some(result),
    }
}

/// The WebSocket path an operating computer connects to on the direct
/// listener: `ws://<address>:6768/machine/1`. Phones connect to `/`.
pub const MACHINE_PATH: &str = "/machine/1";

/// Overrides the direct listener's port (6768). `0` takes any free port, and
/// the runtime prints the one it bound. For tests: phones look for 6768.
pub const PORT_ENV: &str = "TERMINALX_MACHINE_HOST_PORT";

/// Emitted on the runtime's event sink whenever [`Status`] changes. Its
/// payload is the new [`Status`].
pub const CHANGED_EVENT: &str = "machine_host_changed";

/// Runtime IPC commands. Every one but [`STATUS`] and [`ACTIVITY`] names the window's
/// attachment (`epoch` and `lease`) and is refused once it is no longer current.
pub const STATUS: &str = "runtime.machineHost.status";
pub const ADOPT_KEY: &str = "runtime.machineHost.adoptKey";
pub const PHONE_ROUTE: &str = "runtime.machineHost.phoneRoute";
pub const REVOKE: &str = "runtime.machineHost.revoke";
/// Remove the paired computer that paired through the account grant
/// `grantRequestId` (PRO-349, [`RevokeGrant`]): `{ revoked, id }`, with `id`
/// null when no computer has that grant.
pub const REVOKE_GRANT: &str = "runtime.machineHost.revokeGrant";
/// Make a pairing code (PRO-342). Answers [`CreatedCode`], or refuses with
/// `pairing_paused` (after five wrong attempts in a minute) or `not_enabled`.
pub const CREATE_CODE: &str = "runtime.machineHost.createCode";
/// Allow the computer waiting with `requestId` ([`Answer`]): `{ approved: true }`, or `not_found`.
pub const APPROVE: &str = "runtime.machineHost.approve";
/// Don't allow it ([`Answer`]): `{ declined: true }`.
pub const DECLINE: &str = "runtime.machineHost.decline";
/// The activity log (PRO-357): `{ entries: [...] }`, the last 200, newest first.
pub const ACTIVITY: &str = "runtime.machineHost.activity";
/// "Disconnect" ([`ForComputer`]): close the computer's connections and
/// refuse it until the person lets it back. `{ disconnected: bool }`.
pub const DISCONNECT: &str = "runtime.machineHost.disconnect";
/// Let a disconnected computer connect again ([`ForComputer`]). Like
/// [`APPROVE`], only a person may (`serve_cli::consent`). `{ letBack: bool }`.
pub const LET_BACK: &str = "runtime.machineHost.letBack";
/// A relay control request the window makes through the runtime's
/// registration while the runtime is registered ([`RelayControl`], PRO-368):
/// a phone's invite, credential install or revocation. Answers the relay's
/// reply to the request's `reqId` as it came (`control-error` included), or
/// refuses with `relay_offline` when the runtime is not registered.
pub const RELAY_CONTROL: &str = "runtime.machineHost.relayControl";
/// Emitted on the runtime's event sink when the relay hints, on the
/// runtime's registration, that this host's account pairing grants or
/// revocations changed. No payload. The window polls the account service.
pub const RELAY_HINT_EVENT: &str = "machine_host_relay_hint";

/// Phones the runtime serves itself while no window takes them (PRO-359).
/// Make a phone pairing code ([`PhoneCode`]): answers [`CreatedPhoneCode`],
/// or refuses with `not_enabled` (hosting is off or not listening yet) or
/// `window_takes_phones` (a window pairs this Mac's phones in Settings →
/// Devices). Only a person may (`serve_cli::consent`).
pub const PHONE_CODE: &str = "runtime.machineHost.phoneCode";
/// Let the phone waiting with `requestId` in ([`Answer`]): `{ approved: true }`,
/// or `not_found`. Only a person may.
pub const PHONE_APPROVE: &str = "runtime.machineHost.phoneApprove";
/// Don't ([`Answer`]): `{ declined: true }`.
pub const PHONE_DECLINE: &str = "runtime.machineHost.phoneDecline";
/// Remove a paired phone ([`ForComputer`], its device id): its connections
/// close at once. `{ revoked: bool }`.
pub const PHONE_REVOKE: &str = "runtime.machineHost.phoneRevoke";

/// A pairing code: `txm2.` and base64url, unpadded, of a [`MachineCode`].
pub const CODE_PREFIX: &str = "txm2.";
/// How long a code works (`OFFER_TTL_MS`), once.
pub const CODE_TTL_MS: i64 = 5 * 60_000;
/// How long a computer waits for Allow (`APPROVAL_TTL_MS`).
pub const APPROVAL_TTL_MS: i64 = 120_000;
/// Wrong attempts within [`ATTEMPT_WINDOW_MS`] that pause pairing for [`PAUSE_MS`].
pub const ATTEMPT_LIMIT: usize = 5;
pub const ATTEMPT_WINDOW_MS: i64 = 60_000;
pub const PAUSE_MS: i64 = 60_000;
/// The most a code may take, prefix included.
pub const MAX_CODE_BYTES: usize = 8192;

/// Why the machine host refused to pair, as `pairing_refused` says.
pub const REFUSED_NOT_APPROVED: &str = "not-approved";
pub const REFUSED_CODE_INACTIVE: &str = "code-inactive";
pub const REFUSED_ANOTHER_COMPUTER: &str = "another-computer";
pub const REFUSED_PAIRING_PAUSED: &str = "pairing-paused";
/// A paired computer the person disconnected, until they let it back (PRO-357).
pub const REFUSED_DISCONNECTED: &str = "disconnected";

/// The most a header line may take, newline included.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

/// Whether the runtime can use the machine's host key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyState {
    /// Loaded; `Status::machine_id` is its host id.
    Ready,
    /// A desktop-launched runtime on macOS has no copy yet. The window sends
    /// the bytes of its phone pairing key with [`ADOPT_KEY`].
    Needed,
    /// It could not be read or kept; `Status::error` says why.
    Error,
}

/// The runtime's own relay registration (PRO-368).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelayState {
    /// Not registering: the switch is off, the host key is not ready, or
    /// this build has no relay. Also what an older runtime says.
    #[default]
    Off,
    /// The switch is on and nobody is signed in on this machine.
    SignedOut,
    /// Making its first registration. The window waits a while for it
    /// rather than take the host id from it.
    Connecting,
    /// Its registration was lost or refused, and it is trying again. The
    /// window registers itself meanwhile; the runtime's next registration
    /// retires the window's.
    Retrying,
    /// Registered: [`Status::relay`] says where.
    Registered,
    /// A newer runtime process for this machine took the relay; this one
    /// does not register again until it restarts.
    Superseded,
}

/// Where the runtime is registered, for the window to use the registration
/// for its phones (PRO-368) instead of registering itself: the relay would
/// close one of the two.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRegistration {
    pub relay_host_id: String,
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: u64,
    /// The relay's generation for the registration (`host-hello-ack`).
    pub generation: u64,
    pub runtime_generation: u64,
}

/// One paired computer, as Settings → Machines lists it. No credential.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSummary {
    pub id: String,
    pub label: String,
    pub platform: Option<String>,
    pub approved_at: i64,
    pub last_seen_at: Option<i64>,
    pub connected: bool,
    /// When the person pressed Disconnect; refused until they let it back (PRO-357).
    #[serde(default)]
    pub disconnected_at: Option<i64>,
    /// The relay host id of the computer's client key ([`key_id_of`]); `None`
    /// for a record with no client key, and from a runtime before PRO-349.
    #[serde(default)]
    pub key_id: Option<String>,
    /// How its newest live connection reached this machine; `None` while it
    /// is not connected, and from a runtime before PRO-349.
    #[serde(default)]
    pub route: Option<ComputerRoute>,
}

/// `MachineRouteKind` in src/types/machines.ts, as the machine sees a computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerRoute {
    Lan,
    Tailscale,
    Relay,
}

impl ComputerRoute {
    /// A direct connection's route from its peer address: `tailscale` from
    /// `100.64.0.0/10` (or Tailscale's IPv6 range `fd7a:115c:a1e0::/48`),
    /// `lan` otherwise. A label, never an authentication decision
    /// (docs/MACHINES.md decision 6).
    pub fn of_peer(peer: std::net::IpAddr) -> Self {
        match peer.to_canonical() {
            std::net::IpAddr::V4(address) if address.octets()[0] == 100 && (address.octets()[1] & 0xC0) == 64 => Self::Tailscale,
            std::net::IpAddr::V6(address) if address.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0] => Self::Tailscale,
            _ => Self::Lan,
        }
    }
}

/// The short key id Settings → Machines labels a computer by: the relay host
/// id of its client key (standard base64 of 32 bytes), `None` for anything else.
pub fn key_id_of(client_public_key_b64: &str) -> Option<String> {
    use base64::Engine as _;
    let key: [u8; 32] = base64::engine::general_purpose::STANDARD.decode(client_public_key_b64).ok()?.try_into().ok()?;
    Some(crate::relay_e2ee::host_id_of(&key))
}

/// The answer to [`STATUS`], and the payload of [`CHANGED_EVENT`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `machines.allowOperating`.
    pub enabled: bool,
    pub host_key: HostKeyState,
    /// The relay host id of the host key (docs/MACHINES.md, machineId).
    pub machine_id: Option<String>,
    /// The bound direct listener, as `0.0.0.0:6768`, while it is open.
    pub listening: Option<String>,
    /// The runtime holds the direct port, or takes it as soon as it is free:
    /// it is on, its host key is not in error, and nothing but the port being
    /// in use (by the window, or connections still closing) keeps it from
    /// listening. Only then does the window give the port up and register a
    /// [`PhoneRoute`]; otherwise the window keeps serving phones on it.
    #[serde(default)]
    pub takes_port: bool,
    /// Whether a window's phone route is registered and current.
    pub phone_route: bool,
    pub computers: Vec<ComputerSummary>,
    /// Why the host is not serving although it is enabled.
    pub error: Option<String>,
    /// A computer asking to operate this machine, waiting for Allow.
    #[serde(default)]
    pub pending: Option<PendingComputer>,
    /// The live pairing code's expiry. Never the code: only [`CREATE_CODE`] answers it.
    #[serde(default)]
    pub code: Option<CodeExpiry>,
    /// Pairing is paused after five wrong attempts in a minute, until then.
    #[serde(default)]
    pub paused_until: Option<i64>,
    /// The runtime's own relay registration (PRO-368).
    #[serde(default)]
    pub relay_state: RelayState,
    /// Set while [`RelayState::Registered`].
    #[serde(default)]
    pub relay: Option<RelayRegistration>,
    /// Phones this runtime serves itself (PRO-359). Absent from a runtime
    /// before PRO-359, which served none.
    #[serde(default)]
    pub phones: PhoneStatus,
}

/// Phones the runtime serves while no window takes them (PRO-359).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    /// An existing desktop phone pairing keeps this host on independently.
    #[serde(default)]
    pub hosting: bool,
    /// Paired phones connected to this runtime now, by device id.
    #[serde(default)]
    pub connected: Vec<String>,
    /// The live phone pairing code's expiry. Never the code.
    #[serde(default)]
    pub code: Option<CodeExpiry>,
    /// A phone that used the code, waiting for Allow.
    #[serde(default)]
    pub pending: Option<PendingPhone>,
    /// A TerminalX window is open on this Mac: it pairs and serves phones,
    /// or will once hosting is on, so `pair --phone` sends the person there
    /// before asking anything.
    #[serde(default)]
    pub window_open: bool,
}

/// A phone waiting for Allow: the fingerprint it shows too.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPhone {
    pub request_id: String,
    pub device_id: String,
    pub fingerprint: String,
    pub requested_at: i64,
    pub expires_at: i64,
}

/// Params of [`PHONE_CODE`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneCode {
    pub epoch: String,
    pub lease: String,
}

/// The answer to [`PHONE_CODE`]: the `terminalx://pair` link a phone scans
/// or pastes, exactly as Settings → Devices shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPhoneCode {
    pub link: String,
    pub expires_at: i64,
    /// The four-group fingerprint a phone shows needs the phone's key, so
    /// it is not known yet: the machine id is shown instead.
    pub machine_id: String,
}

/// A computer waiting for Allow, as the approval dialog shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingComputer {
    pub request_id: String,
    pub label: String,
    pub platform: Option<String>,
    /// The pairing fingerprint (`pairing_fingerprint`), which the operating
    /// computer shows too.
    pub fingerprint: String,
    /// `direct` or `relay`.
    pub transport: String,
    pub requested_at: i64,
    pub expires_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeExpiry {
    pub expires_at: i64,
}

/// The answer to [`CREATE_CODE`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCode {
    pub code: String,
    pub expires_at: i64,
}

impl Status {
    pub fn hosting(&self) -> bool {
        self.enabled || self.phones.hosting
    }

    /// The window must neither bind 6768 nor open its own listener: the
    /// runtime has it, or is about to take it ([`Status::takes_port`]).
    pub fn runtime_owns_direct(&self) -> bool {
        self.hosting() && self.takes_port
    }
}

/// Params of [`ADOPT_KEY`]. The runtime keeps the bytes in a store it owns,
/// refuses bytes that differ from a key it already holds, and never makes
/// one of its own where the window is the key's owner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptKey {
    pub epoch: String,
    pub lease: String,
    pub secret_b64: String,
}

/// Params of [`PHONE_ROUTE`]: a private Unix socket in the runtime's `run`
/// directory that the window listens on. It stays registered while the
/// attachment does; a later registration by the same attachment replaces it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneRoute {
    pub epoch: String,
    pub lease: String,
    pub socket: PathBuf,
}

/// Params of [`REVOKE`]: the paired computer to remove. Its connections close.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revoke {
    pub epoch: String,
    pub lease: String,
    pub id: String,
}

/// Params of [`DISCONNECT`] and [`LET_BACK`]: the paired computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForComputer {
    pub epoch: String,
    pub lease: String,
    pub id: String,
}

/// Params of [`RELAY_CONTROL`]. `frame` is the relay control request as the
/// window would send it on its own registration, with its own `reqId`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayControl {
    pub epoch: String,
    pub lease: String,
    pub frame: serde_json::Value,
}

/// Params of [`REVOKE_GRANT`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeGrant {
    pub epoch: String,
    pub lease: String,
    pub grant_request_id: String,
}

/// Params of [`APPROVE`] and [`DECLINE`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Answer {
    pub epoch: String,
    pub lease: String,
    pub request_id: String,
}

/// Params of [`CREATE_CODE`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCode {
    pub epoch: String,
    pub lease: String,
    /// The account grant this code answers (PRO-349): the computer allowed
    /// with it is linked to the grant, so removing it on either side ends
    /// both. Absent for a code made in Settings → Machines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_request_id: Option<String>,
}

/// The machine's operating system, as `machine.describe` names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineOs {
    pub family: String,
    pub version: Option<String>,
}

/// A machine as its code names it, before anything connects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentity {
    pub machine_id: String,
    pub name: String,
    pub os: MachineOs,
    /// The TerminalX version on the machine.
    pub version: String,
}

/// The relay half of a machine's code, in the shape of a phone offer's
/// (`remote::client::RelayOffer`). No code carries one until PRO-344.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineRelay {
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: u64,
    pub relay_host_id: String,
    pub invite_token: String,
    pub invite_expires_at: i64,
}

/// A machine's pairing code (docs/MACHINES.md, "As built (PRO-342)"). The
/// runtime encodes it, the operating computer decodes it, both with this type.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineCode {
    pub v: u8,
    pub kind: String,
    pub scope: String,
    pub identity_mode: String,
    pub device_token: String,
    /// The host key, standard base64.
    pub public_key_b64: String,
    pub machine: MachineIdentity,
    pub direct_endpoints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<MachineRelay>,
    pub expires_at: i64,
}

/// Never print the token.
impl std::fmt::Debug for MachineCode {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("MachineCode")
            .field("machine", &self.machine)
            .field("directEndpoints", &self.direct_endpoints)
            .field("relay", &self.relay.is_some())
            .field("expiresAt", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl MachineCode {
    pub fn new(device_token: String, public_key_b64: String, machine: MachineIdentity, direct_endpoints: Vec<String>, expires_at: i64) -> Self {
        Self {
            v: 2,
            kind: "machine".into(),
            scope: "runtime".into(),
            identity_mode: "authenticate".into(),
            device_token,
            public_key_b64,
            machine,
            direct_endpoints,
            relay: None,
            expires_at,
        }
    }

    pub fn encode(&self) -> Result<String> {
        use base64::Engine as _;
        let code = format!("{CODE_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?));
        if code.len() > MAX_CODE_BYTES {
            bail!("the pairing code is over {MAX_CODE_BYTES} bytes");
        }
        Ok(code)
    }

    /// Decode a code a person pasted, refusing anything that is not a whole,
    /// consistent machine code: its `machineId` must be its key's host id.
    pub fn decode(code: &str) -> Result<Self> {
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use base64::Engine as _;
        let code = code.trim();
        if code.len() > MAX_CODE_BYTES {
            bail!("not a machine pairing code");
        }
        let body = code.strip_prefix(CODE_PREFIX).context("not a machine pairing code")?;
        let bytes = URL_SAFE_NO_PAD.decode(body).context("not a machine pairing code")?;
        let decoded: Self = serde_json::from_slice(&bytes).context("not a machine pairing code")?;
        if decoded.v != 2 || decoded.kind != "machine" || decoded.scope != "runtime" || decoded.identity_mode != "authenticate" {
            bail!("unsupported machine pairing code");
        }
        if URL_SAFE_NO_PAD.decode(&decoded.device_token).map(|token| token.len()) != Ok(32) {
            bail!("the code's device token is invalid");
        }
        let key: [u8; 32] = STANDARD
            .decode(&decoded.public_key_b64)
            .ok()
            .and_then(|key| key.try_into().ok())
            .context("the code's machine key is invalid")?;
        if crate::relay_e2ee::host_id_of(&key) != decoded.machine.machine_id {
            bail!("the code's machine id does not match its key");
        }
        let name_ok = |name: &str| !name.trim().is_empty() && name.chars().count() <= 80 && !name.chars().any(char::is_control);
        if !name_ok(&decoded.machine.name) {
            bail!("the code's machine name is invalid");
        }
        if decoded.direct_endpoints.is_empty() && decoded.relay.is_none() {
            bail!("the code names no way to reach the machine");
        }
        if decoded.direct_endpoints.len() > 64
            || !decoded.direct_endpoints.iter().all(|endpoint| {
                url::Url::parse(endpoint).is_ok_and(|url| url.scheme() == "ws" && url.host_str().is_some() && url.path() == MACHINE_PATH)
            })
        {
            bail!("the code's endpoints are invalid");
        }
        Ok(decoded)
    }
}

/// A relay connection request, as the relay's `conn-open` names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConnection {
    pub conn_id: String,
    pub conn_ticket: String,
    pub kind: String,
    pub relay_device_id: String,
    pub attach_deadline_ms: u64,
}

/// The first line on a phone route connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Forwarded {
    /// A phone on the direct listener; its bytes follow the header.
    Direct { peer: Option<String> },
    /// A phone through the runtime's relay registration. The window opens the
    /// data leg `/v1/host/data/<connId>` on `cell_url` with this generation.
    Relay { cell_url: String, relay_host_id: String, generation: u64, connection: RelayConnection },
}

#[derive(Serialize, Deserialize)]
struct Header {
    v: u8,
    #[serde(flatten)]
    forwarded: Forwarded,
}

/// The header line, newline included.
pub fn encode_header(forwarded: &Forwarded) -> Result<Vec<u8>> {
    let mut line = serde_json::to_vec(&Header { v: 1, forwarded: forwarded.clone() })?;
    line.push(b'\n');
    if line.len() > MAX_HEADER_BYTES {
        bail!("phone route header is over {MAX_HEADER_BYTES} bytes");
    }
    Ok(line)
}

/// Parse a header line, with or without its newline.
pub fn decode_header(line: &[u8]) -> Result<Forwarded> {
    if line.len() > MAX_HEADER_BYTES {
        bail!("phone route header is over {MAX_HEADER_BYTES} bytes");
    }
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let header: Header = serde_json::from_slice(line).context("decode phone route header")?;
    if header.v != 1 {
        bail!("unsupported phone route header version {}", header.v);
    }
    Ok(header.forwarded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_round_trip_and_name_their_kind() {
        let direct = Forwarded::Direct { peer: Some("192.168.1.20:51234".into()) };
        let line = encode_header(&direct).unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&line[..line.len() - 1]).unwrap(),
            serde_json::json!({ "v": 1, "kind": "direct", "peer": "192.168.1.20:51234" })
        );
        assert_eq!(decode_header(&line).unwrap(), direct);
        let relay = Forwarded::Relay {
            cell_url: "https://cell.example".into(),
            relay_host_id: "cs1uhCLEB_ttCYaQ".into(),
            generation: 3,
            connection: RelayConnection {
                conn_id: "c1".into(),
                conn_ticket: "t".into(),
                kind: "resume".into(),
                relay_device_id: "phone-1".into(),
                attach_deadline_ms: 10_000,
            },
        };
        let line = encode_header(&relay).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(value["kind"], "relay");
        assert_eq!(value["cellUrl"], "https://cell.example");
        assert_eq!(value["connection"]["relayDeviceId"], "phone-1");
        assert_eq!(decode_header(&line).unwrap(), relay);
    }

    #[test]
    fn a_header_of_another_version_or_size_is_refused() {
        assert!(decode_header(br#"{"v":2,"kind":"direct","peer":null}"#).is_err());
        assert!(decode_header(br#"{"v":1,"kind":"other"}"#).is_err());
        assert!(decode_header(&vec![b' '; MAX_HEADER_BYTES + 1]).is_err());
    }

    #[test]
    fn status_is_camel_case_and_keyless() {
        let status = Status {
            enabled: true,
            host_key: HostKeyState::Needed,
            machine_id: None,
            listening: None,
            takes_port: true,
            phone_route: false,
            computers: vec![],
            error: None,
            pending: None,
            code: Some(CodeExpiry { expires_at: 9 }),
            paused_until: None,
            phones: Default::default(),
            relay_state: RelayState::Off,
            relay: None,
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["code"], serde_json::json!({ "expiresAt": 9 }));
        assert_eq!(value["pausedUntil"], serde_json::Value::Null);
        assert_eq!(value["hostKey"], "needed");
        assert_eq!(value["phoneRoute"], false);
        assert_eq!(value["takesPort"], true);
        assert!(status.runtime_owns_direct(), "waiting for the window's key, it is about to take the port");
        let cannot = Status { host_key: HostKeyState::Error, takes_port: false, error: Some("no key".into()), ..status.clone() };
        assert!(!cannot.runtime_owns_direct(), "a runtime that cannot listen leaves the port to the window");
        let older: Status = serde_json::from_value(serde_json::json!({ "enabled": true, "hostKey": "ready", "machineId": null, "listening": null, "phoneRoute": false, "computers": [], "error": null })).unwrap();
        assert!(!older.runtime_owns_direct(), "a status without takesPort never takes the window's port");
        assert_eq!(older.pending, None, "a status from before PRO-342 has nothing pending");
    }

    #[test]
    fn a_computer_names_its_key_id_and_route_and_an_older_status_still_parses() {
        use base64::Engine as _;
        let client = crate::relay_e2ee::HostKeypair::from_secret([4; 32]);
        let key_id = key_id_of(&base64::engine::general_purpose::STANDARD.encode(client.public())).unwrap();
        assert_eq!(key_id, client.host_id(), "the relay host id of the client key");
        assert_eq!(key_id.len(), 16);
        assert_eq!(key_id_of("not a key"), None);
        assert_eq!(key_id_of(&base64::engine::general_purpose::STANDARD.encode([1u8; 31])), None, "31 bytes is no key");

        let computer = ComputerSummary {
            id: "computer-1".into(),
            label: "MacBook".into(),
            platform: Some("macos".into()),
            approved_at: 1,
            last_seen_at: Some(2),
            connected: true,
            key_id: Some(key_id.clone()),
            route: Some(ComputerRoute::Tailscale),
            disconnected_at: None,
        };
        let value = serde_json::to_value(&computer).unwrap();
        assert_eq!(value["keyId"], key_id.as_str());
        assert_eq!(value["route"], "tailscale");
        let idle = ComputerSummary { connected: false, key_id: None, route: None, ..computer.clone() };
        let value = serde_json::to_value(&idle).unwrap();
        assert_eq!((&value["keyId"], &value["route"]), (&serde_json::Value::Null, &serde_json::Value::Null), "both are present, as null");
        for (route, name) in [(ComputerRoute::Lan, "lan"), (ComputerRoute::Tailscale, "tailscale"), (ComputerRoute::Relay, "relay")] {
            assert_eq!(serde_json::to_value(route).unwrap(), name);
        }

        // A runtime before PRO-349 sends neither.
        let older: Status = serde_json::from_value(serde_json::json!({
            "enabled": true, "hostKey": "ready", "machineId": null, "listening": null, "phoneRoute": false, "error": null,
            "computers": [{ "id": "computer-1", "label": "MacBook", "platform": null, "approvedAt": 1, "lastSeenAt": null, "connected": true }],
        }))
        .unwrap();
        assert_eq!((older.computers[0].key_id.clone(), older.computers[0].route), (None, None));
    }

    #[test]
    fn a_direct_peer_is_tailscale_only_in_tailscale_ranges() {
        let route = |address: &str| ComputerRoute::of_peer(address.parse().unwrap());
        assert_eq!(route("100.64.0.1"), ComputerRoute::Tailscale);
        assert_eq!(route("100.127.255.254"), ComputerRoute::Tailscale);
        assert_eq!(route("::ffff:100.100.1.2"), ComputerRoute::Tailscale, "an IPv4-mapped peer on a dual-stack listener");
        assert_eq!(route("fd7a:115c:a1e0::1"), ComputerRoute::Tailscale);
        assert_eq!(route("100.128.0.1"), ComputerRoute::Lan);
        assert_eq!(route("100.63.255.255"), ComputerRoute::Lan);
        assert_eq!(route("192.168.1.20"), ComputerRoute::Lan);
        assert_eq!(route("127.0.0.1"), ComputerRoute::Lan);
        assert_eq!(route("fe80::1"), ComputerRoute::Lan);
    }

    #[test]
    fn create_code_names_a_grant_only_when_it_answers_one() {
        let plain = CreateCode { epoch: "e".into(), lease: "l".into(), grant_request_id: None };
        assert_eq!(serde_json::to_value(&plain).unwrap(), serde_json::json!({ "epoch": "e", "lease": "l" }), "what a PRO-342 runtime accepts");
        let parsed: CreateCode = serde_json::from_value(serde_json::json!({ "epoch": "e", "lease": "l", "grantRequestId": "g" })).unwrap();
        assert_eq!(parsed.grant_request_id.as_deref(), Some("g"));
    }

    fn code() -> MachineCode {
        use base64::Engine as _;
        let keypair = crate::relay_e2ee::HostKeypair::from_secret([7; 32]);
        MachineCode::new(
            crate::relay_e2ee::random_token(),
            base64::engine::general_purpose::STANDARD.encode(keypair.public()),
            MachineIdentity { machine_id: keypair.host_id(), name: "Mac mini".into(), os: MachineOs { family: "macos".into(), version: Some("26.1".into()) }, version: "0.2.33".into() },
            vec!["ws://192.168.1.20:6768/machine/1".into(), "ws://mac-mini.local:6768/machine/1".into()],
            1_763_200_000_000,
        )
    }

    #[test]
    fn a_machine_code_round_trips_in_the_documented_shape() {
        let made = code();
        let encoded = made.encode().unwrap();
        assert!(encoded.starts_with("txm2."));
        use base64::Engine as _;
        let json: serde_json::Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&encoded[5..]).unwrap()).unwrap();
        assert_eq!(json["v"], 2);
        assert_eq!(json["kind"], "machine");
        assert_eq!(json["scope"], "runtime");
        assert_eq!(json["identityMode"], "authenticate");
        assert_eq!(json["machine"]["os"]["family"], "macos");
        assert!(json.get("relay").is_none(), "no relay without the account");
        assert_eq!(MachineCode::decode(&format!("  {encoded}\n")).unwrap(), made);
        assert!(!format!("{made:?}").contains(&made.device_token), "Debug never prints the token");
    }

    #[test]
    fn a_code_that_is_not_whole_and_consistent_is_refused() {
        let encode = |code: &MachineCode| {
            use base64::Engine as _;
            format!("txm2.{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(code).unwrap()))
        };
        assert!(MachineCode::decode("").is_err());
        assert!(MachineCode::decode(&encode(&code()).replace("txm2.", "txm1.")).is_err(), "another prefix");
        assert!(MachineCode::decode("txm2.!!!").is_err());
        let mut other = code();
        other.machine.machine_id = "AAAAAAAAAAAAAAAA".into();
        assert!(MachineCode::decode(&encode(&other)).is_err(), "ids disagree");
        let mut other = code();
        other.device_token = "short".into();
        assert!(MachineCode::decode(&encode(&other)).is_err());
        let mut other = code();
        other.direct_endpoints = vec!["ws://192.168.1.20:6768/".into()];
        assert!(MachineCode::decode(&encode(&other)).is_err(), "a phone's endpoint");
        let mut other = code();
        other.kind = "phone".into();
        assert!(MachineCode::decode(&encode(&other)).is_err());
        let mut other = code();
        other.direct_endpoints.clear();
        assert!(MachineCode::decode(&encode(&other)).is_err(), "nowhere to connect");
        assert!(MachineCode::decode(&format!("txm2.{}", "A".repeat(MAX_CODE_BYTES))).is_err());
    }
}
