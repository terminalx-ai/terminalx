//! The desktop's connection to a cloud workspace runtime.
//!
//! [`Supervisor`] keeps one workspace attached: it asks an [`AttachSource`]
//! (the API's `open?attachTicket=1`) for an attachment, connects through the
//! relay with the attach ticket, runs the E2EE handshake as the initiator,
//! proves the attachment's device token and negotiates `rpc.hello`. Frames
//! from the app are then sealed and forwarded as they are; the app owns
//! request ids, so a resend after a reconnect reuses the same
//! `clientRequestId` and the runtime answers it from its idempotency cache.
//!
//! Supervision follows the contract's typed close reasons: a failed socket
//! only triggers a readiness re-check through `open`, never a runtime
//! replacement, and retries use jittered backoff from 250 ms to 10 s.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use super::host::{jitter, now_ms, valid_base64url_32, websocket_config, websocket_url};
use super::protocol::{self, close_action, Activation, CloseAction, CAPABILITIES, PROTOCOL};
use crate::relay_e2ee::{E2eeClientHandshake, E2eeSession, PayloadKind};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const TICKET_MARGIN_MS: i64 = 10_000;
const PING_INTERVAL: Duration = Duration::from_secs(20);
const SILENCE_LIMIT: Duration = Duration::from_secs(60);

/// The relay half of a pairing offer.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayOffer {
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: u64,
    pub relay_host_id: String,
    pub invite_token: String,
    pub invite_expires_at: i64,
}

/// A runtime's pairing offer (`v: 2`), as the runtime publishes it for an
/// attachment and the API returns it from `open` as `pairingCode`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub device_token: String,
    pub public_key_b64: String,
    pub scope: String,
    pub relay: RelayOffer,
}

/// Accepts the bare base64url code or a `terminalx://pair?code=` link.
pub fn decode_pairing_code(code: &str) -> Result<PairingOffer> {
    let code = code.trim();
    let code = code.split_once("code=").map(|(_, rest)| rest.split('&').next().unwrap_or("")).unwrap_or(code);
    if code.is_empty() || code.len() > 8192 {
        bail!("invalid pairing code");
    }
    let bytes = general_purpose::URL_SAFE_NO_PAD.decode(code.trim_end_matches('=')).context("pairing code is not base64url")?;
    let value: Value = serde_json::from_slice(&bytes).context("pairing code is not JSON")?;
    if value["v"] != 2 || value["identityMode"] != "authenticate" || value["relay"]["v"] != 1 || value["relay"]["e2eeFraming"] != 2 {
        bail!("unsupported pairing offer");
    }
    let offer: PairingOffer = serde_json::from_value(value).context("incomplete pairing offer")?;
    if !valid_base64url_32(&offer.relay.invite_token)
        || offer.relay.relay_host_id.len() != 16
        || !matches!(offer.scope.as_str(), "runtime" | "session")
        || offer.device_token.is_empty()
    {
        bail!("invalid pairing offer");
    }
    Ok(offer)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachTicket {
    pub token: String,
    pub expires_at: i64,
    pub runtime_generation: u64,
}

#[derive(Clone, Debug)]
pub struct AttachGrant {
    pub attachment_id: String,
    pub offer: PairingOffer,
    /// Absent from an API older than PRO-13; the client then attaches with
    /// `relay-auth` v1 and cannot check the runtime generation.
    pub ticket: Option<AttachTicket>,
}

pub enum OpenOutcome {
    Ready(Box<AttachGrant>),
    /// The attachment exists but the runtime has not answered it yet.
    WaitingForRuntime,
    /// Suspended compute; only an interactive action ([`Activation::Wake`]) resumes it.
    Suspended,
}

/// Where attachments come from: `POST .../cloud-workspaces/:id/open?attachTicket=1`.
pub trait AttachSource: Send + Sync + 'static {
    fn open(&self, refresh_pairing: bool, activation: Activation) -> Result<OpenOutcome>;
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "state")]
pub enum ClientState {
    /// Below `connect`: nothing touches the network.
    Idle,
    Opening,
    WaitingForRuntime,
    Suspended,
    Connecting { attempt: u32 },
    Connected {
        runtime_generation: u64,
        /// The runtime process; terminals and their offsets belong to it.
        runtime_epoch: String,
        runtime_version: String,
        capabilities: Vec<String>,
        authority: String,
        /// The person's collaboration role when `collab/1` was granted
        /// (`{ userId, role, canApprove }`, saas contract §21.5).
        you: Option<Value>,
    },
    Reconnecting { attempt: u32, reason: String, retry_in_ms: u64 },
    UpdateRequired,
    Stopped,
}

pub enum ClientEvent {
    State(ClientState),
    /// A decrypted response or notification from the runtime.
    Message(Value),
}

enum Credential {
    Invite(String),
    Resume(String),
}

/// Why a connection attempt or a live connection ended.
#[derive(Debug)]
pub struct Closed {
    pub code: Option<u16>,
    pub reason: String,
}

impl Closed {
    fn other(error: impl std::fmt::Display) -> Self {
        Self { code: None, reason: protocol::redact(&format!("{error:#}")) }
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Connection {
    socket: Socket,
    session: E2eeSession,
}

impl Connection {
    async fn send(&mut self, value: &Value) -> Result<()> {
        let frame = self.session.seal(value.to_string().as_bytes(), PayloadKind::Text)?;
        self.socket.send(Message::Text(general_purpose::STANDARD.encode(frame).into())).await?;
        Ok(())
    }

    async fn next(&mut self) -> Result<Value, Closed> {
        loop {
            match self.socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let bytes = general_purpose::STANDARD.decode(text.as_bytes()).map_err(Closed::other)?;
                    let plaintext = self.session.open(&bytes, PayloadKind::Text).map_err(Closed::other)?;
                    return serde_json::from_slice(&plaintext).map_err(Closed::other);
                }
                Some(Ok(Message::Binary(bytes))) => {
                    self.session.open(&bytes, PayloadKind::Binary).map_err(Closed::other)?;
                }
                Some(Ok(Message::Close(frame))) => {
                    return Err(Closed {
                        code: frame.as_ref().map(|frame| u16::from(frame.code)),
                        reason: frame.map(|frame| frame.reason.to_string()).unwrap_or_default(),
                    })
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(Closed::other(error)),
                None => return Err(Closed { code: None, reason: "connection closed".into() }),
            }
        }
    }

    /// One request before the app takes over the channel.
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, Closed> {
        let id = format!("supervisor-{}", uuid::Uuid::new_v4().simple());
        self.send(&json!({ "id": id, "method": method, "params": params })).await.map_err(Closed::other)?;
        let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
        loop {
            let value = tokio::time::timeout_at(deadline, self.next()).await.map_err(|_| Closed::other(format!("{method} timed out")))??;
            if value["id"] == id {
                return if value["ok"] == true {
                    Ok(value["result"].clone())
                } else {
                    Err(Closed::other(format!("{method} refused: {}", value["error"]["code"])))
                };
            }
        }
    }
}

/// Relay attach (v2 with a ticket, else v1), then the E2EE handshake and
/// the device-token proof.
async fn connect(offer: &PairingOffer, credential: &Credential, ticket: Option<&AttachTicket>) -> Result<Connection, Closed> {
    let url = websocket_url(&offer.relay.cell_url, &format!("/v1/connect/{}", offer.relay.relay_host_id)).map_err(Closed::other)?;
    let request = url.into_client_request().map_err(Closed::other)?;
    let (mut socket, _) = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(websocket_config()), false),
    )
    .await
    .map_err(|_| Closed::other("relay connect timed out"))?
    .map_err(Closed::other)?;
    let (token, kind) = match credential {
        Credential::Invite(token) => (token, "invite"),
        Credential::Resume(token) => (token, "resume"),
    };
    let auth = match ticket {
        Some(ticket) => json!({ "type": "relay-auth", "v": 2, "mode": "connect", "credential": token, "attachTicket": ticket.token }),
        None => json!({ "type": "relay-auth", "v": 1, "mode": "connect", "credential": token }),
    };
    socket.send(Message::Text(auth.to_string().into())).await.map_err(Closed::other)?;
    let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
    let hello = plaintext(&mut socket, deadline).await?;
    let hello: Value = serde_json::from_str(&hello).map_err(Closed::other)?;
    if hello["type"] != "relay-hello" {
        return Err(Closed::other("relay sent no hello"));
    }
    if hello["ok"] != true {
        return Err(Closed { code: hello["code"].as_u64().map(|code| code as u16), reason: "relay refused the attach".into() });
    }
    if hello["credentialKind"] != kind {
        return Err(Closed::other("relay accepted a different credential kind"));
    }
    let handshake = E2eeClientHandshake::new(&offer.public_key_b64, "relay", Some(&offer.relay.relay_host_id)).map_err(Closed::other)?;
    socket.send(Message::Text(serde_json::to_string(handshake.hello()).map_err(Closed::other)?.into())).await.map_err(Closed::other)?;
    let ready = plaintext(&mut socket, deadline).await?;
    let session = handshake.accept_ready(&ready).map_err(Closed::other)?;
    let mut connection = Connection { socket, session };
    let transcript = connection.session.transcript_hash_b64.clone();
    connection
        .send(&json!({ "type": "e2ee_auth", "v": 2, "transcriptHashB64": transcript, "deviceToken": offer.device_token }))
        .await
        .map_err(Closed::other)?;
    let authenticated = tokio::time::timeout_at(deadline, connection.next()).await.map_err(|_| Closed::other("E2EE authentication timed out"))??;
    if authenticated["type"] != "e2ee_authenticated" || authenticated["transcriptHashB64"] != transcript.as_str() {
        return Err(Closed::other("the runtime did not authenticate this device"));
    }
    Ok(connection)
}

async fn plaintext(socket: &mut Socket, deadline: tokio::time::Instant) -> Result<String, Closed> {
    loop {
        match tokio::time::timeout_at(deadline, socket.next()).await.map_err(|_| Closed::other("relay handshake timed out"))? {
            Some(Ok(Message::Text(text))) => return Ok(text.to_string()),
            Some(Ok(Message::Close(frame))) => {
                return Err(Closed { code: frame.as_ref().map(|frame| u16::from(frame.code)), reason: "relay closed the attach".into() })
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(_)) => return Err(Closed::other("unexpected binary handshake frame")),
            Some(Err(error)) => return Err(Closed::other(error)),
            None => return Err(Closed { code: None, reason: "relay closed the attach".into() }),
        }
    }
}

struct Shared {
    outbound: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    activation: watch::Sender<Activation>,
    stopped: watch::Sender<bool>,
}

/// One supervised workspace attachment. Dropping every handle does not stop
/// it; call [`Supervisor::stop`].
#[derive(Clone)]
pub struct Supervisor {
    shared: Arc<Shared>,
}

impl Supervisor {
    pub fn start(source: Arc<dyn AttachSource>, activation: Activation, events: mpsc::UnboundedSender<ClientEvent>) -> Self {
        let (activation, _) = watch::channel(activation);
        let (stopped, _) = watch::channel(false);
        let shared = Arc::new(Shared { outbound: Mutex::new(None), activation, stopped });
        let supervisor = Self { shared: shared.clone() };
        tokio::spawn(run(shared, source, events));
        supervisor
    }

    /// Forward one frame (`{ id, method, params }`) to the runtime. False when
    /// not connected: the caller keeps its `clientRequestId` and resends
    /// after the next `connected` state.
    pub fn send(&self, frame: Value) -> bool {
        self.shared.outbound.lock().unwrap().as_ref().is_some_and(|outbound| outbound.send(frame).is_ok())
    }

    /// Raise (or lower) how much this attachment may cost. Only `Wake`
    /// resumes suspended compute.
    pub fn set_activation(&self, activation: Activation) {
        self.shared.activation.send_replace(activation);
    }

    pub fn stop(&self) {
        self.shared.stopped.send_replace(true);
        self.shared.outbound.lock().unwrap().take();
    }
}

struct Attached {
    grant: AttachGrant,
    invite_used: bool,
}

async fn run(shared: Arc<Shared>, source: Arc<dyn AttachSource>, events: mpsc::UnboundedSender<ClientEvent>) {
    let emit = |state: ClientState| {
        let _ = events.send(ClientEvent::State(state));
    };
    let mut stopped = shared.stopped.subscribe();
    let mut activation = shared.activation.subscribe();
    let mut attached: Option<Attached> = None;
    let mut resume: Option<(String, String)> = None;
    let mut refresh_pairing = false;
    let mut attempt = 0u32;
    'supervise: loop {
        if *stopped.borrow() {
            break;
        }
        let level = *activation.borrow_and_update();
        if level < Activation::Connect {
            emit(ClientState::Idle);
            tokio::select! {
                _ = activation.changed() => continue,
                _ = stopped.changed() => break,
            }
        }
        let ticket_stale = attached
            .as_ref()
            .and_then(|a| a.grant.ticket.as_ref())
            .is_some_and(|ticket| ticket.expires_at - now_ms() < TICKET_MARGIN_MS);
        if attached.is_none() || ticket_stale {
            emit(ClientState::Opening);
            let open_source = source.clone();
            let refresh = refresh_pairing;
            let opened = tokio::task::spawn_blocking(move || open_source.open(refresh, level)).await.map_err(anyhow::Error::from).and_then(|r| r);
            // A wake is spent on the open that asked for it: reconnects later
            // never resume compute again on their own.
            if level == Activation::Wake && matches!(opened, Ok(OpenOutcome::Ready(_) | OpenOutcome::WaitingForRuntime)) {
                shared.activation.send_replace(Activation::Connect);
                activation.borrow_and_update();
            }
            if let Ok(outcome) = &opened {
                refresh_pairing = still_refreshing(refresh_pairing, outcome);
            }
            match opened {
                Ok(OpenOutcome::Ready(grant)) => {
                    let same = attached.as_ref().is_some_and(|a| a.grant.attachment_id == grant.attachment_id);
                    let invite_used = same && attached.as_ref().is_some_and(|a| a.invite_used && a.grant.offer.relay.invite_token == grant.offer.relay.invite_token);
                    if resume.as_ref().is_some_and(|(attachment, _)| attachment != &grant.attachment_id) {
                        resume = None;
                    }
                    attached = Some(Attached { grant: *grant, invite_used });
                }
                Ok(OpenOutcome::WaitingForRuntime) => {
                    emit(ClientState::WaitingForRuntime);
                    attempt += 1;
                    if sleep_or_stop(&mut stopped, protocol::backoff(attempt, jitter()).max(Duration::from_secs(1))).await {
                        break;
                    }
                    continue;
                }
                Ok(OpenOutcome::Suspended) => {
                    emit(ClientState::Suspended);
                    tokio::select! {
                        _ = activation.changed() => continue,
                        _ = stopped.changed() => break,
                    }
                }
                Err(error) => {
                    attempt += 1;
                    let delay = protocol::backoff(attempt, jitter());
                    emit(ClientState::Reconnecting { attempt, reason: protocol::redact(&format!("{error:#}")), retry_in_ms: delay.as_millis() as u64 });
                    if sleep_or_stop(&mut stopped, delay).await {
                        break;
                    }
                    continue;
                }
            }
        }
        let current = attached.as_mut().expect("an attachment");
        let credential = match &resume {
            Some((_, token)) => Credential::Resume(token.clone()),
            None if !current.invite_used && current.grant.offer.relay.invite_expires_at > now_ms() => {
                Credential::Invite(current.grant.offer.relay.invite_token.clone())
            }
            None => {
                // The single-use invite is spent and no resume credential
                // was installed: ask the API for a fresh pairing.
                attached = None;
                refresh_pairing = true;
                continue;
            }
        };
        emit(ClientState::Connecting { attempt });
        let was_invite = matches!(credential, Credential::Invite(_));
        if was_invite {
            current.invite_used = true;
        }
        let closed = match connect(&current.grant.offer, &credential, current.grant.ticket.as_ref()).await {
            Ok(mut connection) => {
                match establish(&mut connection, current, was_invite).await {
                    Ok((state, installed)) => {
                        if let Some(token) = installed {
                            resume = Some((current.grant.attachment_id.clone(), token));
                        }
                        attempt = 0;
                        emit(state);
                        pump(connection, &shared, &events, &mut stopped).await
                    }
                    Err(closed) => closed,
                }
            }
            Err(closed) => closed,
        };
        shared.outbound.lock().unwrap().take();
        if *stopped.borrow() {
            break;
        }
        let action = closed.code.map(close_action).unwrap_or(CloseAction::Reconnect);
        match action {
            CloseAction::UpdateRequired => {
                emit(ClientState::UpdateRequired);
                tokio::select! {
                    _ = stopped.changed() => break 'supervise,
                    _ = activation.changed() => continue,
                }
            }
            // Readiness is re-checked through `open`; nothing here asks the
            // API to replace the runtime.
            CloseAction::RecheckReadiness | CloseAction::RefreshTicket | CloseAction::Reassign => attached = None,
            CloseAction::Reattach => {
                attached = None;
                resume = None;
            }
            CloseAction::CredentialRejected => {
                attached = None;
                resume = None;
                refresh_pairing = true;
            }
            CloseAction::Reconnect => {}
        }
        attempt += 1;
        let delay = protocol::backoff(attempt, jitter());
        let reason = match closed.code {
            Some(code) => format!("{code} {}", closed.reason),
            None => closed.reason,
        };
        emit(ClientState::Reconnecting { attempt, reason, retry_in_ms: delay.as_millis() as u64 });
        if sleep_or_stop(&mut stopped, delay).await {
            break;
        }
    }
    emit(ClientState::Stopped);
}

/// Whether the next `open` must still ask for a fresh pairing. The API
/// answers such a request by re-minting the attachment (waiting for the
/// runtime), and re-mints a ready one on every such request, so asking again
/// after it waits would re-mint forever and never see it ready.
fn still_refreshing(requested: bool, outcome: &OpenOutcome) -> bool {
    requested && !matches!(outcome, OpenOutcome::Ready(_) | OpenOutcome::WaitingForRuntime)
}

/// Install a resume credential on an invite connection, then negotiate
/// `rpc.hello` and check the generation against the ticket.
async fn establish(connection: &mut Connection, attached: &Attached, was_invite: bool) -> Result<(ClientState, Option<String>), Closed> {
    let installed = if was_invite {
        let token = random_token();
        let hash = general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()));
        let req_id = format!("resume-{}", uuid::Uuid::new_v4().simple());
        match connection.call("pairing.provisionRelay", json!({ "reqId": req_id, "newResumeTokenHash": hash })).await {
            Ok(_) => Some(token),
            Err(closed) => {
                // Still usable now; the next reconnect asks for a new pairing.
                log::warn!("cloud workspace: no resume credential: {}", closed.reason);
                None
            }
        }
    } else {
        None
    };
    let hello = connection
        .call(
            "rpc.hello",
            json!({ "protocol": PROTOCOL, "client": { "app": "terminalx-desktop", "version": env!("CARGO_PKG_VERSION") }, "want": CAPABILITIES }),
        )
        .await?;
    let generation = hello["runtime"]["runtimeGeneration"].as_u64().unwrap_or(0);
    if let Some(ticket) = &attached.grant.ticket {
        if generation != ticket.runtime_generation {
            // Defence in depth behind the relay fence.
            return Err(Closed { code: Some(4101), reason: "runtime generation differs from the ticket".into() });
        }
    }
    Ok((
        ClientState::Connected {
            runtime_generation: generation,
            runtime_epoch: hello["runtime"]["epoch"].as_str().unwrap_or_default().to_string(),
            runtime_version: hello["runtime"]["version"].as_str().unwrap_or_default().to_string(),
            capabilities: serde_json::from_value(hello["capabilities"].clone()).unwrap_or_default(),
            authority: hello["authority"].as_str().unwrap_or_default().to_string(),
            you: hello.get("you").filter(|you| you.is_object()).cloned(),
        },
        installed,
    ))
}

async fn pump(
    mut connection: Connection,
    shared: &Shared,
    events: &mpsc::UnboundedSender<ClientEvent>,
    stopped: &mut watch::Receiver<bool>,
) -> Closed {
    let (outbound, mut frames) = mpsc::unbounded_channel();
    *shared.outbound.lock().unwrap() = Some(outbound);
    let mut ping = tokio::time::interval(PING_INTERVAL);
    let mut last_seen = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _ = stopped.changed() => {
                let _ = connection.socket.close(None).await;
                return Closed { code: None, reason: "stopped".into() };
            }
            frame = frames.recv() => {
                let Some(frame) = frame else {
                    let _ = connection.socket.close(None).await;
                    return Closed { code: None, reason: "stopped".into() };
                };
                if let Err(error) = connection.send(&frame).await {
                    return Closed::other(error);
                }
            }
            _ = ping.tick() => {
                if last_seen.elapsed() > SILENCE_LIMIT {
                    return Closed::other("the relay went silent");
                }
                if let Err(error) = connection.socket.send(Message::Ping(Vec::new().into())).await {
                    return Closed::other(error);
                }
            }
            incoming = connection.socket.next() => {
                last_seen = tokio::time::Instant::now();
                let value = match incoming {
                    Some(Ok(Message::Text(text))) => general_purpose::STANDARD
                        .decode(text.as_bytes())
                        .map_err(anyhow::Error::from)
                        .and_then(|bytes| connection.session.open(&bytes, PayloadKind::Text))
                        .and_then(|plaintext| Ok(serde_json::from_slice::<Value>(&plaintext)?)),
                    Some(Ok(Message::Binary(bytes))) => match connection.session.open(&bytes, PayloadKind::Binary) {
                        Ok(_) => continue,
                        Err(error) => Err(error),
                    },
                    Some(Ok(Message::Close(frame))) => {
                        return Closed {
                            code: frame.as_ref().map(|frame| u16::from(frame.code)),
                            reason: frame.map(|frame| frame.reason.to_string()).unwrap_or_default(),
                        }
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => return Closed::other(error),
                    None => return Closed { code: None, reason: "connection closed".into() },
                };
                match value {
                    Ok(value) => {
                        let _ = events.send(ClientEvent::Message(value));
                    }
                    // A frame that fails authentication ends the session: the
                    // counters can no longer agree.
                    Err(error) => return Closed::other(error),
                }
            }
        }
    }
}

async fn sleep_or_stop(stopped: &mut watch::Receiver<bool>, delay: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => *stopped.borrow(),
        _ = stopped.changed() => true,
    }
}

fn random_token() -> String {
    use rand_core::RngCore;
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}


/// Parse the API's `open` response into an outcome.
pub fn open_outcome(response: &Value) -> Result<OpenOutcome> {
    let state = response["state"].as_str().ok_or_else(|| anyhow!("open response lacks state"))?;
    match state {
        "ready" => {
            let code = response["pairingCode"].as_str().ok_or_else(|| anyhow!("ready attachment lacks a pairing code"))?;
            let ticket = match response.get("attachTicket") {
                Some(ticket) if !ticket.is_null() => {
                    if ticket["v"] != 1 || ticket["protocol"] != PROTOCOL {
                        bail!("the API issued an attach ticket for another protocol");
                    }
                    Some(serde_json::from_value::<AttachTicket>(ticket.clone())?)
                }
                _ => None,
            };
            Ok(OpenOutcome::Ready(Box::new(AttachGrant {
                attachment_id: response["id"].as_str().unwrap_or_default().to_string(),
                offer: decode_pairing_code(code)?,
                ticket,
            })))
        }
        "waiting-for-runtime" => Ok(OpenOutcome::WaitingForRuntime),
        other => bail!("unexpected attachment state {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn offer_code(invite: &str) -> String {
        general_purpose::URL_SAFE_NO_PAD.encode(
            json!({
                "v": 2, "endpoint": "relay:abcdefghijklmnop", "deviceToken": "device-token-0123456789", "publicKeyB64": general_purpose::STANDARD.encode([1u8; 32]),
                "scope": "runtime", "identityMode": "authenticate",
                "relay": { "v": 1, "directorUrl": "https://relay.example", "cellUrl": "https://cell.example", "assignmentEpoch": 3,
                    "relayHostId": "abcdefghijklmnop", "inviteToken": invite, "inviteExpiresAt": 1, "e2eeFraming": 2 }
            })
            .to_string(),
        )
    }

    #[test]
    fn pairing_codes_decode_bare_or_as_links_and_reject_other_offers() {
        let invite = "a".repeat(43);
        let offer = decode_pairing_code(&offer_code(&invite)).unwrap();
        assert_eq!(offer.relay.relay_host_id, "abcdefghijklmnop");
        assert_eq!(decode_pairing_code(&format!("terminalx://pair?code={}", offer_code(&invite))).unwrap(), offer);
        assert!(decode_pairing_code(&offer_code("short")).is_err());
        let v1 = general_purpose::URL_SAFE_NO_PAD.encode(json!({ "v": 1 }).to_string());
        assert!(decode_pairing_code(&v1).is_err());
    }

    #[test]
    fn a_fresh_pairing_is_asked_for_once() {
        // Re-minted (waiting) or answered: the next open must not re-mint again.
        assert!(!still_refreshing(true, &OpenOutcome::WaitingForRuntime));
        assert!(!still_refreshing(true, &open_outcome(&json!({ "id": "a", "state": "ready", "pairingCode": offer_code(&"b".repeat(43)) })).unwrap()));
        // Suspended: nothing was re-minted yet.
        assert!(still_refreshing(true, &OpenOutcome::Suspended));
        assert!(!still_refreshing(false, &OpenOutcome::Suspended));
    }

    #[test]
    fn open_responses_map_to_outcomes() {
        let code = offer_code(&"b".repeat(43));
        let ready = open_outcome(&json!({
            "id": "att-1", "state": "ready", "pairingCode": code,
            "attachTicket": { "v": 1, "token": "jwt", "expiresAt": 5, "runtimeGeneration": 7, "protocol": PROTOCOL }
        }))
        .unwrap();
        let OpenOutcome::Ready(grant) = ready else { panic!("ready") };
        assert_eq!(grant.ticket.unwrap().runtime_generation, 7);
        assert!(matches!(open_outcome(&json!({ "state": "waiting-for-runtime" })).unwrap(), OpenOutcome::WaitingForRuntime));
        assert!(open_outcome(&json!({
            "state": "ready", "pairingCode": offer_code(&"b".repeat(43)),
            "attachTicket": { "v": 1, "token": "jwt", "expiresAt": 5, "runtimeGeneration": 7, "protocol": "terminalx-workspace-rpc/2" }
        }))
        .is_err());
        // An older API omits the ticket.
        let OpenOutcome::Ready(legacy) = open_outcome(&json!({ "id": "a", "state": "ready", "pairingCode": offer_code(&"b".repeat(43)) })).unwrap() else {
            panic!("ready")
        };
        assert!(legacy.ticket.is_none());
    }
}
