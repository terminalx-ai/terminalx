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

use std::future::Future;
use std::pin::Pin;
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
    /// The runtime is not reachable yet: the API says it has not answered
    /// the attachment, or the relay turned a first dial away because the
    /// runtime is not on it yet (still booting, or restarted while it booted).
    /// Nothing was lost: a connection that never came up is waited for.
    WaitingForRuntime {
        /// The relay close code of the dial that found it not there yet, for
        /// the desktop's own diagnostics.
        #[serde(skip_serializing)]
        close_code: Option<u16>,
    },
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
        /// A machine connection's link number (PRO-345): a new one while
        /// connected means the connection moved to another route, and the
        /// web view resubscribes from its cursors. Never set for a cloud
        /// workspace, whose state keeps exactly its old shape.
        #[serde(skip_serializing_if = "Option::is_none")]
        link: Option<u64>,
    },
    /// A connection that was up is gone, and it is being made again. Only
    /// ever after a connection reached `Connected`.
    Reconnecting {
        attempt: u32,
        reason: String,
        retry_in_ms: u64,
        /// The relay close code that ended the connection, for the desktop's
        /// own diagnostics; the web view reads it from `reason`.
        #[serde(skip_serializing)]
        close_code: Option<u16>,
    },
    UpdateRequired,
    Stopped,
}

pub enum ClientEvent {
    State(ClientState),
    /// A decrypted response or notification from the runtime.
    Message(Value),
}

pub(super) enum Credential {
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
    pub(super) fn other(error: impl std::fmt::Display) -> Self {
        Self { code: None, reason: protocol::redact(&format!("{error:#}")) }
    }
}

type Socket = crate::data_privacy::Socket;

/// One E2EE connection to a runtime, on any route: the cloud relay attach
/// here, a machine's direct and relay routes in `machine_client`.
pub(super) struct Connection {
    pub(super) socket: Socket,
    pub(super) session: E2eeSession,
}

impl Connection {
    pub(super) async fn send(&mut self, value: &Value) -> Result<()> {
        let frame = self.session.seal(value.to_string().as_bytes(), PayloadKind::Text)?;
        self.socket.send(Message::Text(general_purpose::STANDARD.encode(frame).into())).await?;
        Ok(())
    }

    pub(super) async fn next(&mut self) -> Result<Value, Closed> {
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
        self.call_within(method, params, HANDSHAKE_TIMEOUT).await
    }

    /// One request before the app takes over the channel, answered within `limit`.
    pub(super) async fn call_within(&mut self, method: &str, params: Value, limit: Duration) -> Result<Value, Closed> {
        let id = format!("supervisor-{}", uuid::Uuid::new_v4().simple());
        self.send(&json!({ "id": id, "method": method, "params": params })).await.map_err(Closed::other)?;
        let deadline = tokio::time::Instant::now() + limit;
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
    let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
    let relay = RelayRoute { cell_url: &offer.relay.cell_url, relay_host_id: &offer.relay.relay_host_id, public_key_b64: &offer.public_key_b64, client_secret: None };
    let mut connection = relay_connect(&relay, credential, ticket, deadline).await?;
    let auth = json!({ "deviceToken": offer.device_token });
    match authenticate(&mut connection, auth, deadline).await? {
        Authenticated::Yes => Ok(connection),
        Authenticated::Refused(_) => Err(Closed::other("the runtime did not authenticate this device")),
    }
}

/// Where a relay connection goes and with which keys.
pub(super) struct RelayRoute<'a> {
    pub cell_url: &'a str,
    pub relay_host_id: &'a str,
    /// The runtime's host key, which the handshake is pinned to.
    pub public_key_b64: &'a str,
    /// This installation's long-lived client key (a machine pins it); a
    /// fresh one per connection when absent (a cloud attachment).
    pub client_secret: Option<[u8; 32]>,
}

/// Through the relay with `credential` (relay-auth v2 with a ticket, else
/// v1), then the E2EE handshake as the initiator, by `deadline`. A relay
/// refusal is a [`Closed`] with the relay's code.
pub(super) async fn relay_connect(route: &RelayRoute<'_>, credential: &Credential, ticket: Option<&AttachTicket>, deadline: tokio::time::Instant) -> Result<Connection, Closed> {
    let url = websocket_url(route.cell_url, &format!("/v1/connect/{}", route.relay_host_id)).map_err(Closed::other)?;
    let request = url.into_client_request().map_err(Closed::other)?;
    let (mut socket, _) = tokio::time::timeout_at(deadline, crate::data_privacy::connect(request, Some(websocket_config()), false))
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
    let handshake = match route.client_secret {
        Some(secret) => E2eeClientHandshake::with_secret(secret, route.public_key_b64, "relay", Some(route.relay_host_id)),
        None => E2eeClientHandshake::new(route.public_key_b64, "relay", Some(route.relay_host_id)),
    }
    .map_err(Closed::other)?;
    socket.send(Message::Text(serde_json::to_string(handshake.hello()).map_err(Closed::other)?.into())).await.map_err(Closed::other)?;
    let ready = plaintext(&mut socket, deadline).await?;
    let session = handshake.accept_ready(&ready).map_err(Closed::other)?;
    Ok(Connection { socket, session })
}

/// How the runtime answered `e2ee_auth`.
pub(super) enum Authenticated {
    Yes,
    /// A machine's sealed `pairing_refused`, with its reason.
    Refused(String),
}

/// Prove the device token inside E2EE: `auth` holds `deviceToken` and any
/// fields the route adds (a machine's `label` and `platform`). The token is
/// never anywhere but inside the sealed frame.
pub(super) async fn authenticate(connection: &mut Connection, mut auth: Value, deadline: tokio::time::Instant) -> Result<Authenticated, Closed> {
    let transcript = connection.session.transcript_hash_b64.clone();
    auth["type"] = json!("e2ee_auth");
    auth["v"] = json!(2);
    auth["transcriptHashB64"] = json!(transcript);
    connection.send(&auth).await.map_err(Closed::other)?;
    let answer = tokio::time::timeout_at(deadline, connection.next()).await.map_err(|_| Closed::other("E2EE authentication timed out"))??;
    match answer["type"].as_str() {
        Some("e2ee_authenticated") if answer["transcriptHashB64"] == transcript.as_str() => Ok(Authenticated::Yes),
        Some("pairing_refused") => Ok(Authenticated::Refused(answer["reason"].as_str().unwrap_or_default().to_string())),
        _ => Err(Closed::other("the runtime did not authenticate this device")),
    }
}

pub(super) async fn plaintext(socket: &mut Socket, deadline: tokio::time::Instant) -> Result<String, Closed> {
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
        Self::start_with(source, activation, events, Arc::new(RelayDial))
    }

    fn start_with(source: Arc<dyn AttachSource>, activation: Activation, events: mpsc::UnboundedSender<ClientEvent>, dial: Arc<dyn Dial>) -> Self {
        let (activation, _) = watch::channel(activation);
        let (stopped, _) = watch::channel(false);
        let shared = Arc::new(Shared { outbound: Mutex::new(None), activation, stopped });
        let supervisor = Self { shared: shared.clone() };
        tokio::spawn(run(shared, source, events, dial));
        supervisor
    }

    /// Tests: a supervisor that is connected and runs nothing, and where its frames go.
    #[cfg(test)]
    pub(crate) fn connected_for_test() -> (Self, mpsc::UnboundedReceiver<Value>) {
        let (outbound, frames) = mpsc::unbounded_channel();
        let (activation, _) = watch::channel(Activation::Connect);
        let (stopped, _) = watch::channel(false);
        (Self { shared: Arc::new(Shared { outbound: Mutex::new(Some(outbound)), activation, stopped }) }, frames)
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

/// What the supervisor hands a connection while it lives.
struct Link<'a> {
    shared: &'a Shared,
    events: &'a mpsc::UnboundedSender<ClientEvent>,
    stopped: &'a mut watch::Receiver<bool>,
}

/// How one connection went.
struct Lived {
    /// Why it ended, or why it was never made.
    closed: Closed,
    /// It reached `connected` (and reported that state) before it ended.
    established: bool,
    /// The resume credential installed on it, if it was made with an invite.
    installed: Option<String>,
}

/// One connection to the runtime of an attachment, from the relay attach to
/// its end. The supervisor around it decides what to do next; a test stands
/// in for the relay here.
trait Dial: Send + Sync + 'static {
    fn live<'a>(&'a self, attached: &'a Attached, credential: &'a Credential, was_invite: bool, link: Link<'a>) -> Pin<Box<dyn Future<Output = Lived> + Send + 'a>>;
}

/// Through the relay: attach, the E2EE handshake, `rpc.hello`, then frames both ways.
struct RelayDial;

impl Dial for RelayDial {
    fn live<'a>(&'a self, attached: &'a Attached, credential: &'a Credential, was_invite: bool, link: Link<'a>) -> Pin<Box<dyn Future<Output = Lived> + Send + 'a>> {
        Box::pin(async move {
            let unmade = |closed| Lived { closed, established: false, installed: None };
            let mut connection = match connect(&attached.grant.offer, credential, attached.grant.ticket.as_ref()).await {
                Ok(connection) => connection,
                Err(closed) => return unmade(closed),
            };
            match establish(&mut connection, attached, was_invite).await {
                Ok((state, installed)) => {
                    let _ = link.events.send(ClientEvent::State(state));
                    let closed = pump(connection, link.shared, link.events, link.stopped).await;
                    Lived { closed, established: true, installed }
                }
                Err(closed) => unmade(closed),
            }
        })
    }
}

async fn run(shared: Arc<Shared>, source: Arc<dyn AttachSource>, events: mpsc::UnboundedSender<ClientEvent>, dial: Arc<dyn Dial>) {
    let emit = |state: ClientState| {
        let _ = events.send(ClientEvent::State(state));
    };
    let mut stopped = shared.stopped.subscribe();
    let mut activation = shared.activation.subscribe();
    let mut attached: Option<Attached> = None;
    let mut resume: Option<(String, String)> = None;
    let mut refresh_pairing = false;
    let mut attempt = 0u32;
    // A connection reached `Connected` since this supervisor started or last
    // parked. Until one has, a dial the relay turns away (the runtime still
    // booting, or restarted while it booted) is waited out as
    // `WaitingForRuntime`, not shown as a lost connection (#1288).
    let mut was_live = false;
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
                    emit(ClientState::WaitingForRuntime { close_code: None });
                    attempt += 1;
                    if sleep_or_stop(&mut stopped, protocol::backoff(attempt, jitter()).max(Duration::from_secs(1))).await {
                        break;
                    }
                    continue;
                }
                Ok(OpenOutcome::Suspended) => {
                    // Parked: whatever was attached belonged to the runtime
                    // that stopped, and a wake brings up a new one. Until it
                    // is up again, nothing was live to lose.
                    attached = None;
                    was_live = false;
                    emit(ClientState::Suspended);
                    tokio::select! {
                        _ = activation.changed() => continue,
                        _ = stopped.changed() => break,
                    }
                }
                Err(error) => {
                    attempt += 1;
                    let delay = protocol::backoff(attempt, jitter());
                    emit(ClientState::Reconnecting { attempt, reason: protocol::redact(&format!("{error:#}")), retry_in_ms: delay.as_millis() as u64, close_code: None });
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
        let lived = dial.live(current, &credential, was_invite, Link { shared: &shared, events: &events, stopped: &mut stopped }).await;
        if lived.established {
            was_live = true;
            if let Some(token) = lived.installed {
                resume = Some((current.grant.attachment_id.clone(), token));
            }
            attempt = 0;
            // A wake asked for while this connection was coming up or was up
            // had nothing to resume: it is spent with the connection. Left
            // standing, it would be used by the `open` after a later stop, and
            // this desktop's reconnect would undo that stop. Only a wake asked
            // for after the connection ended resumes compute.
            if *shared.activation.borrow() == Activation::Wake {
                shared.activation.send_replace(Activation::Connect);
            }
            activation.borrow_and_update();
        }
        let closed = lived.closed;
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
        let reason = match closed.code {
            Some(code) => format!("{code} {}", closed.reason),
            None => closed.reason,
        };
        let delay = if was_live {
            let delay = protocol::backoff(attempt, jitter());
            emit(ClientState::Reconnecting { attempt, reason, retry_in_ms: delay.as_millis() as u64, close_code: closed.code });
            delay
        } else {
            // Never up yet: the runtime is still on its way. Waited for at
            // the pace of the API's own waiting-for-runtime answers.
            log::info!("cloud workspace: runtime not reachable yet (attempt {attempt}): {reason}");
            emit(ClientState::WaitingForRuntime { close_code: closed.code });
            protocol::backoff(attempt, jitter()).max(Duration::from_secs(1))
        };
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
            link: None,
        },
        installed,
    ))
}

async fn pump(
    connection: Connection,
    shared: &Shared,
    events: &mpsc::UnboundedSender<ClientEvent>,
    stopped: &mut watch::Receiver<bool>,
) -> Closed {
    let (outbound, mut frames) = mpsc::unbounded_channel();
    *shared.outbound.lock().unwrap() = Some(outbound);
    pump_frames(connection, &mut frames, |value| {
        let _ = events.send(ClientEvent::Message(value));
    }, stopped)
    .await
}

/// Frames both ways on an established connection until it ends: `frames`
/// go out sealed as they come (none left means stop), and every message the
/// runtime sends goes to `deliver`. Pings keep a quiet link checked; one
/// silent for a minute is over. Shared by every route of every runtime.
pub(super) async fn pump_frames(
    mut connection: Connection,
    frames: &mut mpsc::UnboundedReceiver<Value>,
    mut deliver: impl FnMut(Value),
    stopped: &mut watch::Receiver<bool>,
) -> Closed {
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
                    Ok(value) => deliver(value),
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

pub(super) fn random_token() -> String {
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

    /// A pairing whose invite is still good, so the supervisor dials with it.
    fn live_grant() -> AttachGrant {
        grant_with_invite(&"c".repeat(43))
    }

    fn grant_with_invite(invite: &str) -> AttachGrant {
        let code = general_purpose::URL_SAFE_NO_PAD.encode(
            json!({
                "v": 2, "endpoint": "relay:abcdefghijklmnop", "deviceToken": "device-token-0123456789", "publicKeyB64": general_purpose::STANDARD.encode([1u8; 32]),
                "scope": "runtime", "identityMode": "authenticate",
                "relay": { "v": 1, "directorUrl": "https://relay.example", "cellUrl": "https://cell.example", "assignmentEpoch": 3,
                    "relayHostId": "abcdefghijklmnop", "inviteToken": invite, "inviteExpiresAt": now_ms() + 600_000, "e2eeFraming": 2 }
            })
            .to_string(),
        );
        AttachGrant { attachment_id: "att-1".into(), offer: decode_pairing_code(&code).unwrap(), ticket: None }
    }

    /// The API's `open`, over a workspace a test starts and stops. Only an
    /// `open` with `Wake` on a stopped workspace resumes it, as `ApiSource` does.
    struct FakeWorkspace {
        running: std::sync::atomic::AtomicBool,
        resumes: std::sync::atomic::AtomicUsize,
        opens: Mutex<Vec<Activation>>,
    }

    impl AttachSource for FakeWorkspace {
        fn open(&self, _refresh_pairing: bool, activation: Activation) -> Result<OpenOutcome> {
            use std::sync::atomic::Ordering;
            self.opens.lock().unwrap().push(activation);
            if self.running.load(Ordering::SeqCst) {
                return Ok(OpenOutcome::Ready(Box::new(live_grant())));
            }
            if activation < Activation::Wake {
                return Ok(OpenOutcome::Suspended);
            }
            self.resumes.fetch_add(1, Ordering::SeqCst);
            Ok(OpenOutcome::WaitingForRuntime)
        }
    }

    /// A relay that always connects, and closes a connection when the test says so.
    struct FakeRelay {
        closes: tokio::sync::Mutex<mpsc::UnboundedReceiver<Closed>>,
    }

    impl Dial for FakeRelay {
        fn live<'a>(&'a self, _attached: &'a Attached, _credential: &'a Credential, _was_invite: bool, link: Link<'a>) -> Pin<Box<dyn Future<Output = Lived> + Send + 'a>> {
            Box::pin(async move {
                let _ = link.events.send(ClientEvent::State(ClientState::Connected {
                    runtime_generation: 1,
                    runtime_epoch: "e1".into(),
                    runtime_version: "test".into(),
                    capabilities: Vec::new(),
                    authority: "manage".into(),
                    you: None,
                    link: None,
                }));
                let mut closes = self.closes.lock().await;
                let closed = tokio::select! {
                    closed = closes.recv() => closed.unwrap_or(Closed { code: None, reason: "relay gone".into() }),
                    _ = link.stopped.changed() => Closed { code: None, reason: "stopped".into() },
                };
                Lived { closed, established: true, installed: None }
            })
        }
    }

    /// The next state for which `wanted` holds, within a few seconds.
    async fn state_where(events: &mut mpsc::UnboundedReceiver<ClientEvent>, wanted: impl Fn(&ClientState) -> bool) -> ClientState {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match events.recv().await.expect("the supervisor is running") {
                    ClientEvent::State(state) if wanted(&state) => return state,
                    _ => {}
                }
            }
        })
        .await
        .expect("the supervisor reached the state")
    }

    #[tokio::test]
    async fn a_wake_asked_for_while_connected_never_undoes_a_later_stop() {
        use std::sync::atomic::Ordering;
        let workspace = Arc::new(FakeWorkspace { running: true.into(), resumes: 0.into(), opens: Mutex::new(Vec::new()) });
        let (close, closes) = mpsc::unbounded_channel();
        let (events, mut states) = mpsc::unbounded_channel();
        let supervisor = Supervisor::start_with(workspace.clone(), Activation::Connect, events, Arc::new(FakeRelay { closes: tokio::sync::Mutex::new(closes) }));
        state_where(&mut states, |state| matches!(state, ClientState::Connected { .. })).await;

        // An interactive action asks for a wake while the workspace is already connected: nothing to resume.
        supervisor.set_activation(Activation::Wake);
        // Someone stops the workspace: the relay closes the connection, and the supervisor checks readiness again.
        workspace.running.store(false, Ordering::SeqCst);
        close.send(Closed { code: Some(4100), reason: "runtime gone".into() }).unwrap();

        // It finds the workspace stopped and parks. It does not wait for a runtime it resumed.
        let after = state_where(&mut states, |state| matches!(state, ClientState::Suspended | ClientState::WaitingForRuntime { .. })).await;
        assert_eq!(after, ClientState::Suspended, "the reconnect after a stop must not resume the workspace");
        assert_eq!(workspace.resumes.load(Ordering::SeqCst), 0, "no resume");
        assert_eq!(*workspace.opens.lock().unwrap(), vec![Activation::Connect, Activation::Connect], "the reconnect opened with connect");

        // A wake asked for now, after the stop, is a new interactive action: it resumes, once.
        supervisor.set_activation(Activation::Wake);
        state_where(&mut states, |state| matches!(state, ClientState::WaitingForRuntime { .. })).await;
        assert_eq!(workspace.resumes.load(Ordering::SeqCst), 1);
        supervisor.stop();
    }

    /// A relay that turns each dial away with the next scripted close code
    /// (the runtime not on it yet, or restarted while it booted), then
    /// connects and holds the connection until the test closes it.
    struct BootingRelay {
        refusals: Mutex<std::collections::VecDeque<u16>>,
        relay: FakeRelay,
    }

    impl Dial for BootingRelay {
        fn live<'a>(&'a self, attached: &'a Attached, credential: &'a Credential, was_invite: bool, link: Link<'a>) -> Pin<Box<dyn Future<Output = Lived> + Send + 'a>> {
            let refusal = self.refusals.lock().unwrap().pop_front();
            match refusal {
                Some(code) => Box::pin(async move { Lived { closed: Closed { code: Some(code), reason: "not yet".into() }, established: false, installed: None } }),
                None => self.relay.live(attached, credential, was_invite, link),
            }
        }
    }

    /// The API's `open` over a running workspace: each answer is a fresh
    /// pairing, as the API mints one for every attachment it re-checks.
    struct MintingWorkspace {
        opens: Mutex<Vec<Activation>>,
    }

    impl AttachSource for MintingWorkspace {
        fn open(&self, _refresh_pairing: bool, activation: Activation) -> Result<OpenOutcome> {
            let mut opens = self.opens.lock().unwrap();
            opens.push(activation);
            let n = opens.len().to_string();
            Ok(OpenOutcome::Ready(Box::new(grant_with_invite(&format!("{n}{}", "c".repeat(43 - n.len()))))))
        }
    }

    /// Every state up to and including the first for which `last` holds.
    async fn states_until(events: &mut mpsc::UnboundedReceiver<ClientEvent>, last: impl Fn(&ClientState) -> bool) -> Vec<ClientState> {
        let mut seen = Vec::new();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let ClientEvent::State(state) = events.recv().await.expect("the supervisor is running") {
                    let done = last(&state);
                    seen.push(state);
                    if done {
                        return;
                    }
                }
            }
        })
        .await
        .expect("the supervisor reached the state");
        seen
    }

    fn tag(state: &ClientState) -> String {
        match state {
            ClientState::WaitingForRuntime { close_code: Some(code) } => format!("waitingForRuntime({code})"),
            ClientState::Reconnecting { close_code, .. } => format!("reconnecting({close_code:?})"),
            other => serde_json::to_value(other).unwrap()["state"].as_str().unwrap().to_string(),
        }
    }

    // #1288: a runtime that is still booting is waited for. The dials the
    // relay turns away before the first connect never read as a lost
    // connection; only one that was up and ended does.
    #[tokio::test]
    async fn dials_turned_away_while_the_runtime_boots_are_waited_out_and_only_a_lost_connection_reconnects() {
        let workspace = Arc::new(MintingWorkspace { opens: Mutex::new(Vec::new()) });
        let (close, closes) = mpsc::unbounded_channel();
        let (events, mut states) = mpsc::unbounded_channel();
        let relay = BootingRelay { refusals: Mutex::new([4100, 4404, 4101].into()), relay: FakeRelay { closes: tokio::sync::Mutex::new(closes) } };
        let supervisor = Supervisor::start_with(workspace.clone(), Activation::Connect, events, Arc::new(relay));

        let boot = states_until(&mut states, |state| matches!(state, ClientState::Connected { .. })).await;
        assert_eq!(
            boot.iter().map(tag).collect::<Vec<_>>(),
            [
                "opening",
                "connecting",
                "waitingForRuntime(4100)",
                "opening",
                "connecting",
                "waitingForRuntime(4404)",
                "opening",
                "connecting",
                "waitingForRuntime(4101)",
                "opening",
                "connecting",
                "connected"
            ],
            "the boot never reads as reconnecting"
        );
        // Readiness was checked through `open` after each turn-away, always with `connect`.
        assert_eq!(*workspace.opens.lock().unwrap(), vec![Activation::Connect; 4]);

        // The live connection is lost: that is a reconnect.
        close.send(Closed { code: None, reason: "relay gone".into() }).unwrap();
        let lost = states_until(&mut states, |state| matches!(state, ClientState::Reconnecting { .. })).await;
        assert_eq!(lost.iter().map(tag).collect::<Vec<_>>(), ["reconnecting(None)"]);
        supervisor.stop();
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
