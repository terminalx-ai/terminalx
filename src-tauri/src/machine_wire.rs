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
//! the relay data leg itself with what the header names.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// The WebSocket path an operating computer connects to on the direct
/// listener: `ws://<address>:6768/machine/1`. Phones connect to `/`.
pub const MACHINE_PATH: &str = "/machine/1";

/// Overrides the direct listener's port (6768). `0` takes any free port, and
/// the runtime prints the one it bound. For tests: phones look for 6768.
pub const PORT_ENV: &str = "TERMINALX_MACHINE_HOST_PORT";

/// Emitted on the runtime's event sink whenever [`Status`] changes. Its
/// payload is the new [`Status`].
pub const CHANGED_EVENT: &str = "machine_host_changed";

/// Runtime IPC commands. Every one but [`STATUS`] names the window's
/// attachment (`epoch` and `lease`) and is refused once it is no longer current.
pub const STATUS: &str = "runtime.machineHost.status";
pub const ADOPT_KEY: &str = "runtime.machineHost.adoptKey";
pub const PHONE_ROUTE: &str = "runtime.machineHost.phoneRoute";
pub const REVOKE: &str = "runtime.machineHost.revoke";

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
    /// The bound direct listener, as `0.0.0.0:6768`, while it is open. Only
    /// then does the window stay off the port and register a [`PhoneRoute`].
    pub listening: Option<String>,
    /// Whether a window's phone route is registered and current.
    pub phone_route: bool,
    pub computers: Vec<ComputerSummary>,
    /// Why the host is not serving although it is enabled.
    pub error: Option<String>,
}

impl Status {
    /// The window must neither bind 6768 nor open its own listener: the
    /// runtime has it, or is about to take it.
    pub fn runtime_owns_direct(&self) -> bool {
        self.enabled
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
            phone_route: false,
            computers: vec![],
            error: None,
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["hostKey"], "needed");
        assert_eq!(value["phoneRoute"], false);
        assert!(status.runtime_owns_direct());
    }
}
