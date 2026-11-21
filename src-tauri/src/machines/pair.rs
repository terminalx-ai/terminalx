//! The operating computer's side of pairing by code (docs/MACHINES.md,
//! "Pairing by code", steps 3 to 7): connect to each direct endpoint in
//! turn, run E2EE v2 pinned to the code's key with this installation's
//! client key, prove the code's token inside `e2ee_auth` with this
//! computer's name, and wait for the machine's answer.
//!
//! When no direct endpoint answers and the code carries a relay invite
//! (PRO-487: a machine set to "Relay only", or one on another network), the
//! same proof and the same wait go through the relay
//! (`remote::machine_client::pair_through_relay`), and this computer keeps a
//! relay credential for the machine.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use crate::machine_wire::{MachineCode, MachineIdentity, MachineOs};
use crate::relay_e2ee::{E2eeClientHandshake, E2eeSession, PayloadKind};

/// Each endpoint gets this long to connect and answer the handshake.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for Allow: the machine's two minutes and some.
pub const APPROVAL_WAIT: Duration = Duration::from_secs(150);
/// Each request after Allow.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// The close code of a refused credential: a used code from another computer.
const CREDENTIAL_REFUSED: u16 = 4401;

/// Why pairing did not happen (`MachinePairingFailure` in src/types/machines.ts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub reason: &'static str,
    pub message: String,
}

impl Failure {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self { reason, message: message.into() }
    }

    /// The machine's `pairing_refused` reason, said as the dialog says it.
    fn refused(reason: &str) -> Self {
        match reason {
            "not-approved" => Self::new("not-approved", "The machine did not allow this computer."),
            "another-computer" => Self::new("another-computer", "Another computer is waiting for approval on the machine. Try again in two minutes."),
            "pairing-paused" => Self::new("pairing-paused", "Too many wrong attempts on the machine. Try again in a minute."),
            _ => Self::code_inactive(),
        }
    }

    fn code_inactive() -> Self {
        Self::new("code-inactive", "The code expired, was used, or was replaced by a newer one. Make a new code on the machine.")
    }

    pub fn cancelled() -> Self {
        Self::new("cancelled", "Pairing was cancelled.")
    }
}

/// Who this computer says it is.
pub struct Me<'a> {
    pub client_secret: &'a [u8; 32],
    pub label: &'a str,
    pub platform: &'a str,
    /// The TerminalX account signed in on this computer, if one is: a relay
    /// credential is kept for it, so pairing through the relay needs one.
    pub relay_user: Option<&'a str>,
}

/// Paired: what the machine said about itself after Allow, if it answered.
pub struct Paired {
    pub described: Option<MachineIdentity>,
    /// This computer's relay credential for the machine, when it paired
    /// through the relay.
    pub relay: Option<crate::remote::machine_client::RelayCredential>,
}

type Socket = crate::data_privacy::Socket;

struct Connection {
    socket: Socket,
    session: E2eeSession,
}

impl Connection {
    async fn send(&mut self, value: &Value) -> Result<()> {
        let frame = self.session.seal(value.to_string().as_bytes(), PayloadKind::Text)?;
        self.socket.send(Message::Text(STANDARD.encode(frame).into())).await?;
        Ok(())
    }

    /// The next sealed message, or how the machine closed.
    async fn next(&mut self) -> Result<Value, Option<u16>> {
        loop {
            match self.socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let bytes = STANDARD.decode(text.as_bytes()).map_err(|_| None)?;
                    let plaintext = self.session.open(&bytes, PayloadKind::Text).map_err(|_| None)?;
                    return serde_json::from_slice(&plaintext).map_err(|_| None);
                }
                Some(Ok(Message::Binary(bytes))) => {
                    self.session.open(&bytes, PayloadKind::Binary).map_err(|_| None)?;
                }
                Some(Ok(Message::Close(frame))) => return Err(frame.map(|frame| u16::from(frame.code))),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return Err(None),
            }
        }
    }

    async fn call(&mut self, id: &str, method: &str, params: Value) -> Result<Value> {
        self.send(&json!({ "id": id, "method": method, "params": params })).await?;
        let deadline = tokio::time::Instant::now() + CALL_TIMEOUT;
        loop {
            let value = tokio::time::timeout_at(deadline, self.next()).await.context("no answer")?.map_err(|_| anyhow!("closed"))?;
            if value["id"] == id {
                return if value["ok"] == true { Ok(value["result"].clone()) } else { Err(anyhow!("{method} refused: {}", value["error"]["code"])) };
            }
        }
    }
}

/// Connect and run the handshake on one endpoint.
async fn open(endpoint: &str, code: &MachineCode, me: &Me<'_>) -> Result<Connection> {
    let request = endpoint.into_client_request()?;
    let (mut socket, _) = crate::data_privacy::connect(request, Some(crate::remote::host::websocket_config()), true).await?;
    let handshake = E2eeClientHandshake::with_secret(*me.client_secret, &code.public_key_b64, "direct", None)?;
    socket.send(Message::Text(serde_json::to_string(handshake.hello())?.into())).await?;
    let ready = loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => break text.to_string(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            _ => anyhow::bail!("the machine closed before the handshake"),
        }
    };
    // Pinned to the code's key: another key is not this machine.
    let session = handshake.accept_ready(&ready)?;
    Ok(Connection { socket, session })
}

/// Pair with the machine of `code`. `Ok(Err(..))` is an answer the dialog
/// shows; `Err` is a fault. `cancel` turning true ends it as `cancelled`.
pub async fn pair(code: &MachineCode, me: Me<'_>, approval_wait: Duration, mut cancel: watch::Receiver<bool>) -> Result<Result<Paired, Failure>> {
    let attempt = async {
        let mut connection = None;
        for endpoint in &code.direct_endpoints {
            match tokio::time::timeout(CONNECT_TIMEOUT, open(endpoint, code, &me)).await {
                Ok(Ok(opened)) => {
                    connection = Some(opened);
                    break;
                }
                Ok(Err(error)) => log::debug!("machines: an endpoint of the machine did not answer: {error:#}"),
                Err(_) => log::debug!("machines: an endpoint of the machine timed out"),
            }
        }
        let Some(mut connection) = connection else {
            return Ok(match &code.relay {
                Some(invite) => through_relay(code, invite, &me, approval_wait).await,
                None => Err(Failure::new("unreachable", "No address of the machine answered. Check that both computers are on the same network or Tailscale.")),
            });
        };
        let transcript = connection.session.transcript_hash_b64.clone();
        // The token goes only inside E2EE, with the name the dialog shows.
        connection
            .send(&json!({ "type": "e2ee_auth", "v": 2, "transcriptHashB64": transcript, "deviceToken": code.device_token, "label": me.label, "platform": me.platform }))
            .await?;
        let answer = match tokio::time::timeout(approval_wait, connection.next()).await {
            Err(_) => return Ok(Err(Failure::refused("not-approved"))),
            Ok(Err(Some(CREDENTIAL_REFUSED))) => return Ok(Err(Failure::code_inactive())),
            Ok(Err(_)) => return Ok(Err(Failure::new("unreachable", "The machine closed the connection before it answered."))),
            Ok(Ok(answer)) => answer,
        };
        match answer["type"].as_str() {
            Some("e2ee_authenticated") if answer["transcriptHashB64"] == transcript.as_str() => {}
            Some("pairing_refused") => return Ok(Err(Failure::refused(answer["reason"].as_str().unwrap_or_default()))),
            _ => anyhow::bail!("the machine answered the pairing with something else"),
        }
        let described = describe(&mut connection).await;
        let _ = connection.socket.close(None).await;
        Ok(Ok(Paired { described, relay: None }))
    };
    tokio::select! {
        outcome = attempt => outcome,
        _ = cancel.wait_for(|cancelled| *cancelled) => Ok(Err(Failure::cancelled())),
    }
}

/// The code's relay invite, when no direct endpoint answered.
async fn through_relay(code: &MachineCode, invite: &crate::machine_wire::MachineRelay, me: &Me<'_>, approval_wait: Duration) -> Result<Paired, Failure> {
    use crate::remote::machine_client::{pair_through_relay, RelayPairer, RelayPairing};
    let direct = if code.direct_endpoints.is_empty() { "This machine opens no port: it is reached through the TerminalX relay." } else { "No address of the machine answered, so it is reached through the TerminalX relay." };
    let Some(user_id) = me.relay_user else {
        return Err(Failure::new("sign-in-required", format!("{direct} Sign in to TerminalX on this computer, then pair again.")));
    };
    let pairer = RelayPairer { public_key_b64: &code.public_key_b64, device_token: &code.device_token, client_secret: *me.client_secret, label: me.label, platform: me.platform, user_id };
    match pair_through_relay(invite, pairer, approval_wait).await {
        RelayPairing::Paired { credential, described } => Ok(Paired { described: described.as_ref().and_then(identity_of), relay: Some(credential) }),
        RelayPairing::Refused(reason) => Err(Failure::refused(&reason)),
        RelayPairing::CodeInactive => Err(Failure::code_inactive()),
        RelayPairing::NotAnswered => Err(Failure::refused("not-approved")),
        RelayPairing::Unreachable(detail) => {
            log::debug!("machines: pairing through the relay: {detail}");
            Err(Failure::new("unreachable", if code.direct_endpoints.is_empty() { "The machine did not answer through the TerminalX relay. Check that it is running and signed in to TerminalX." } else { "No address of the machine answered, and it did not answer through the TerminalX relay." }))
        }
    }
}

/// `rpc.hello` and `machine.describe`, step 7. A machine that does not
/// answer keeps the name its code gave.
async fn describe(connection: &mut Connection) -> Option<MachineIdentity> {
    let hello = json!({ "protocol": crate::remote::protocol::PROTOCOL, "want": ["machine/1"], "client": { "app": "terminalx-desktop" } });
    if let Err(error) = connection.call("pair-hello", "rpc.hello", hello).await {
        log::debug!("machines: rpc.hello after pairing: {error:#}");
        return None;
    }
    let described = match connection.call("pair-describe", "machine.describe", json!({})).await {
        Ok(described) => described,
        Err(error) => {
            log::debug!("machines: machine.describe after pairing: {error:#}");
            return None;
        }
    };
    // The projects are PRO-345's to keep; asking here checks that the new
    // credential is served the machine's workspace.
    if let Err(error) = connection.call("pair-projects", "machine.projects", json!({})).await {
        log::debug!("machines: machine.projects after pairing: {error:#}");
    }
    identity_of(&described)
}

/// What `machine.describe` said, as the record keeps it.
fn identity_of(described: &Value) -> Option<MachineIdentity> {
    Some(MachineIdentity {
        machine_id: described["machineId"].as_str()?.into(),
        name: described["name"].as_str()?.into(),
        os: MachineOs { family: described["os"]["family"].as_str()?.into(), version: described["os"]["version"].as_str().map(str::to_string) },
        version: described["version"].as_str()?.into(),
    })
}
