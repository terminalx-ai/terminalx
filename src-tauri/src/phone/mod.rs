//! The phone protocol, served by whichever process hosts phones
//! (docs/MACHINES.md, decision 4 and "As built (PRO-359)"): the window's
//! `PairingManager` while a window takes phones, and the runtime itself
//! (`machine_host::phones`) when none does, as on a headless server or a Mac
//! whose window is closed.
//!
//! Both run the same E2EE v2 handshake with the machine's one host key, admit
//! the same `devices.json` records, and answer the same RPC ([`rpc`]). What
//! differs is only the owner the RPC's writes go through ([`Owner`]): the
//! window reaches the runtime over its authenticated desktop IPC, and the
//! runtime calls its own owner operations in process.

mod latest_worker;
pub(crate) mod registry;
pub(crate) mod rpc;
pub(crate) mod send_ids;
#[cfg(test)]
mod serve_tests;
pub(crate) mod sink;
mod sync_cache;
pub(crate) mod wire;

use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

use crate::local_runtime::client::{AttachmentIdentity, Build};
use crate::local_runtime::mobile::model::DeviceScope;
use crate::local_runtime::mobile::Actor;
use crate::relay_e2ee::{E2eeSession, PayloadKind};
use crate::sink::EventSink;

/// The largest message a pairing socket reads or writes.
pub(crate) const PAIRING_MESSAGE_BYTES_LIMIT: usize = 10 * 1024 * 1024;

/// How many messages may wait for a phone's socket. Each is a notice or a
/// streamed reply; invalidations do not queue here ([`Invalidations`]).
pub(crate) const OUTBOUND_QUEUE: usize = 128;

/// Why the host ended a phone's connection itself, for the relay
/// diagnostics (#1282). The text is what the phone may be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum Fault {
    /// Its outbound queue was full: the phone did not read fast enough.
    #[error("The mobile stream fell behind. Reconnect to load retained history.")]
    FellBehind,
    /// Closed on the host, by its terminal output failing or the owner letting it go.
    #[error("The mobile stream disconnected. Reconnect to load retained history.")]
    Closed,
    /// The account binding changed under it.
    #[error("The paired-device connection or account changed.")]
    Changed,
    /// A frame that did not decrypt or decode.
    #[error("The phone sent a message this computer could not read.")]
    Unreadable,
    /// More requests waiting for an answer than one connection may hold.
    #[error("The phone sent more requests than this computer holds unanswered.")]
    TooManyRequests,
}

/// The close codes the phone app closes its connection with (#1282),
/// mirrored in `mobile/src/transport/phone-close.ts`. The relay passes a
/// phone's code in 4000–4999 through to the Mac's leg unchanged and turns any
/// other into 4408, so only codes in that range say why the phone closed.
pub(crate) const PHONE_CLOSE_CLOSED: u16 = 4000;
pub(crate) const PHONE_CLOSE_PROBE_TIMEOUT: u16 = 4001;
pub(crate) const PHONE_CLOSE_FAILED: u16 = 4002;

/// How a phone's connection ended without a fault (#1282).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum EndReason {
    /// The phone app closed it on purpose: the person left, it reconnected
    /// or another path won (4000), or an older app closed normally (1000).
    PhoneClosed,
    /// The phone's liveness probe (`pairing.getEndpoints`) went unanswered
    /// and it closed the connection to start again (4001).
    ProbeTimeout,
    /// Something failed on the phone's side of the connection and it closed
    /// it (4002): a handshake that timed out, a frame it could not read.
    PhoneFailed,
    /// The relay closed this leg with one of its own codes: 4408 when the
    /// phone's leg dropped or closed without a code of its own (older apps),
    /// or the relay fell behind; 4413 for an oversized message; 4101 for a
    /// superseded runtime. The code is kept beside it.
    RelayClosed,
    /// A close frame whose origin cannot be told: no code, or one neither
    /// the phone app nor the relay sends (1001 when iOS ends the stream).
    Unknown,
    /// The socket ended with no close frame: the relay or the network dropped it.
    StreamEnded,
    /// Disconnected on the Mac; the pairing stays.
    DisconnectedOnMac,
    /// Revoked, signed out or stopping.
    Cancelled,
    /// The host let the connection's queue go.
    HostClosed,
    /// A shared session's viewer left.
    ShareEnded,
}

/// A connection's end: why, and the code its close frame carried, from the
/// phone or from the relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ended {
    pub reason: EndReason,
    pub close_code: Option<u16>,
}

impl Ended {
    pub(crate) fn by(reason: EndReason) -> Self {
        Self { reason, close_code: None }
    }

    /// The end a close frame with this code means.
    pub(crate) fn closed_with(close_code: Option<u16>) -> Self {
        let reason = match close_code {
            Some(PHONE_CLOSE_CLOSED | 1000) => EndReason::PhoneClosed,
            Some(PHONE_CLOSE_PROBE_TIMEOUT) => EndReason::ProbeTimeout,
            Some(PHONE_CLOSE_FAILED) => EndReason::PhoneFailed,
            // The relay's own close codes (terminalx-server
            // `apps/relay/src/protocol/close-codes.ts`).
            Some(4100..=4104 | 4401 | 4404 | 4408 | 4409 | 4413 | 4429 | 4503) => EndReason::RelayClosed,
            _ => EndReason::Unknown,
        };
        Self { reason, close_code }
    }
}

/// A change a phone reads again by itself: `sessions.changed`,
/// `settings.changed`, `sync.capabilitiesChanged`. One pending of each says
/// all a hundred would, so they collapse here instead of filling the
/// outbound queue, which an agent's every event used to do (#1282).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Invalidation {
    Capabilities = 1,
    Settings = 2,
    Sessions = 4,
}

#[derive(Default)]
pub(crate) struct Invalidations {
    pending: std::sync::atomic::AtomicU8,
    raised: tokio::sync::Notify,
}

impl Invalidations {
    pub(crate) fn raise(&self, which: Invalidation) {
        let bit = which as u8;
        if self.pending.fetch_or(bit, std::sync::atomic::Ordering::SeqCst) & bit == 0 {
            self.raised.notify_one();
        }
    }

    /// The notifications pending, in a fixed order, and none left pending.
    pub(crate) fn take(&self) -> Vec<serde_json::Value> {
        let bits = self.pending.swap(0, std::sync::atomic::Ordering::SeqCst);
        [
            (Invalidation::Capabilities, "sync.capabilitiesChanged"),
            (Invalidation::Settings, "settings.changed"),
            (Invalidation::Sessions, "sessions.changed"),
        ]
        .into_iter()
        .filter(|(which, _)| bits & *which as u8 != 0)
        .map(|(_, method)| serde_json::json!({ "method": method }))
        .collect()
    }

    async fn raised(&self) {
        self.raised.notified().await
    }
}

/// The runtime did not answer a paired-device call in time. The window's
/// relay diagnostics count it as a local-runtime failure.
#[derive(Debug, thiserror::Error)]
#[error("the local runtime did not answer a paired-device call")]
pub(crate) struct RuntimeUnanswered;

/// Where a phone connection's owner operations go
/// (`local_runtime::mobile::execute`).
pub(crate) trait Owner: Send + Sync {
    /// The attachment the connection's grants belong to.
    fn attachment(&self) -> Result<AttachmentIdentity>;
    /// One owner operation, as the actor.
    fn mobile(&self, actor: &Actor, method: &str, params: serde_json::Value) -> Result<serde_json::Value>;
    /// What the owner serves a phone (#730).
    fn build(&self) -> &Build;
    /// The owner could not take a connection's close: let the attachment go,
    /// so the grants it held end with it.
    fn disconnect(&self);
}

/// The window's owner: its runtime, over the authenticated desktop IPC.
#[cfg(feature = "desktop")]
impl Owner for crate::local_runtime::desktop::Desktop {
    fn attachment(&self) -> Result<AttachmentIdentity> {
        crate::local_runtime::desktop::Desktop::attachment(self)
    }
    fn mobile(&self, actor: &Actor, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        crate::local_runtime::desktop::Desktop::mobile(self, actor, method, params)
    }
    fn build(&self) -> &Build {
        crate::local_runtime::desktop::Desktop::build(self)
    }
    fn disconnect(&self) {
        crate::local_runtime::desktop::Desktop::disconnect(self)
    }
}

/// What the phone RPC needs from the process that hosts phones.
pub(crate) struct PhoneHost {
    pub(crate) mobile: Arc<rpc::MobileRuntime>,
    sink: OnceLock<Arc<dyn EventSink>>,
    owner: Mutex<Option<Arc<dyn Owner>>>,
    /// The account binding's generation: a connection admitted under an
    /// older one is closed. The window answers its own binding's; the
    /// runtime, the generation in the window's `account.json` mirror as it
    /// last read it (`machine_host::phones`), never reading the file here:
    /// this is asked on every request and event.
    generation: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl PhoneHost {
    pub(crate) fn new(generation: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            mobile: Arc::new(rpc::MobileRuntime::new()),
            sink: OnceLock::new(),
            owner: Mutex::new(None),
            generation: Box::new(generation),
        }
    }

    /// The events phones follow: sessions, settings, pipelines, agent events.
    pub(crate) fn configure(self: &Arc<Self>, sink: Arc<dyn EventSink>) -> Result<()> {
        self.sink.set(sink.clone()).map_err(|_| anyhow::anyhow!("the phone host was already configured"))?;
        self.mobile.configure(sink.clone())?;
        let host = Arc::downgrade(self);
        sink.listen(
            "agent_event",
            Box::new(move |payload| {
                if let Some(host) = host.upgrade() {
                    host.mobile.capture_agent_event(&host, payload);
                }
            }),
        );
        Ok(())
    }

    pub(crate) fn sink(&self) -> Option<&Arc<dyn EventSink>> {
        self.sink.get()
    }

    pub(crate) fn set_owner(&self, owner: Option<Arc<dyn Owner>>) {
        *self.owner.lock().unwrap() = owner;
        // What a phone may be offered is the owner's (#730), and the
        // connections the previous owner admitted are done.
        self.mobile.broadcast_capabilities_changed();
    }

    pub(crate) fn owner(&self) -> Option<Arc<dyn Owner>> {
        self.owner.lock().unwrap().clone()
    }

    pub(crate) fn generation(&self) -> u64 {
        (self.generation)()
    }
}

/// Why a host ends a phone's connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConnectionSignal {
    /// Signed out, stopping, or handed to another listener: close at once.
    Cancel,
    /// The phone's pairing was revoked: close at once with
    /// `CREDENTIAL_REFUSED`, so the phone knows its credential is gone and
    /// not that the connection dropped (#1315).
    Revoke,
    /// Disconnected on the Mac: tell the phone, then close; the pairing stays.
    Disconnect,
}

/// The phone's E2EE authentication, the first sealed frame.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct E2eeAuth {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub v: Option<u8>,
    #[serde(default)]
    pub transcript_hash_b64: Option<String>,
    pub device_token: String,
}

impl E2eeAuth {
    /// Read and check the authentication frame against the handshake.
    pub(crate) fn open(frame: Message, session: &mut E2eeSession) -> Result<Self> {
        let frame = text_frame_bytes(frame)?;
        let auth: Self = serde_json::from_slice(&session.open(&frame, PayloadKind::Text)?)?;
        if auth.kind != "e2ee_auth" || auth.v != Some(2) || auth.transcript_hash_b64.as_deref() != Some(&session.transcript_hash_b64) {
            bail!("E2EE authentication was not bound to the handshake");
        }
        Ok(auth)
    }
}

/// What a phone is sent on each of its connections before the Mac closes them.
pub(crate) fn disconnected_notification() -> serde_json::Value {
    serde_json::json!({ "method": "pairing.disconnected", "params": { "reason": "disconnected-on-mac" } })
}

/// The refusal a phone reads as "the Mac said no", not a dropped connection
/// to retry (docs/PAIRING-APPROVAL.md).
pub(crate) fn pairing_refused(reason: &str) -> serde_json::Value {
    serde_json::json!({ "type": "pairing_refused", "v": 1, "reason": reason })
}

/// Tell the phone its E2EE handshake succeeded and its credential was admitted.
pub(crate) async fn send_authenticated<S>(socket: &mut WebSocketStream<S>, session: &mut E2eeSession) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let reply = serde_json::json!({ "type": "e2ee_authenticated", "v": 2, "transcriptHashB64": session.transcript_hash_b64 });
    send_encrypted_text(socket, session, &reply.to_string()).await
}

/// Bound a slow client's write so revocation can drain output already admitted.
pub(crate) async fn send_with_grant(
    host: &Arc<PhoneHost>,
    connection: &Arc<rpc::MobileConnection>,
    send: impl std::future::Future<Output = Result<()>>,
) -> Result<()> {
    let _permit = connection.output_permit(host).await?;
    tokio::time::timeout(WRITE_TIMEOUT, send).await?
}

const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

async fn send_pong<S: AsyncRead + AsyncWrite + Unpin>(socket: &mut WebSocketStream<S>, bytes: tokio_tungstenite::tungstenite::Bytes) -> Result<()> {
    tokio::time::timeout(WRITE_TIMEOUT, socket.send(Message::Pong(bytes))).await??;
    Ok(())
}

pub(crate) fn pairing_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(64 * 1024)
        .write_buffer_size(64 * 1024)
        // A 5 MB image is base64 encoded in JSON, then the encrypted frame is
        // base64 encoded for the text websocket. Keep the authenticated
        // pairing channel bounded while leaving room for that expansion.
        .max_write_buffer_size(PAIRING_MESSAGE_BYTES_LIMIT)
        .max_message_size(Some(PAIRING_MESSAGE_BYTES_LIMIT))
        .max_frame_size(Some(PAIRING_MESSAGE_BYTES_LIMIT))
}

pub(crate) fn text_frame_bytes(message: Message) -> Result<Vec<u8>> {
    match message {
        Message::Text(text) => decode_canonical_base64(&text),
        _ => bail!("encrypted authentication frame was not text"),
    }
}

pub(crate) fn decode_canonical_base64(value: &str) -> Result<Vec<u8>> {
    let bytes = general_purpose::STANDARD.decode(value)?;
    if general_purpose::STANDARD.encode(&bytes) != value {
        bail!("encrypted text frame was not canonical base64");
    }
    Ok(bytes)
}

pub(crate) async fn send_encrypted_text<S>(socket: &mut WebSocketStream<S>, session: &mut E2eeSession, plaintext: &str) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let frame = session.seal(plaintext.as_bytes(), PayloadKind::Text)?;
    socket.send(Message::Text(general_purpose::STANDARD.encode(frame).into())).await?;
    Ok(())
}

/// One application message to the phone: one encrypted text frame, or binary
/// fragments when it is too large for the transport and the phone reassembles
/// them. A message neither can carry never reaches the socket, where it would
/// close the connection (#669): a reply becomes its request's error, and a
/// notification, which the phone can read again, is dropped.
pub(crate) async fn send_message<S>(socket: &mut WebSocketStream<S>, session: &mut E2eeSession, message: &serde_json::Value, wire: &wire::Wire) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let text = message.to_string();
    match wire.delivery(text.len()) {
        wire::Delivery::Frame => send_encrypted_text(socket, session, &text).await,
        wire::Delivery::Fragments => {
            for fragment in wire.fragments_of(text.as_bytes()) {
                let frame = session.seal(&fragment, PayloadKind::Binary)?;
                socket.send(Message::Binary(frame.into())).await?;
            }
            Ok(())
        }
        wire::Delivery::TooLarge => {
            let Some(id) = message.get("id").and_then(serde_json::Value::as_str) else {
                return Ok(());
            };
            let refusal = wire.too_large_response(id, text.len());
            send_encrypted_text(socket, session, &refusal.to_string()).await
        }
    }
}

/// How many requests a connection holds while one is answered.
const UNANSWERED_REQUESTS: usize = 64;
/// How many queued messages go under one output permit, and for how long a
/// batch keeps taking more: revocation waits for the permit (#1282).
const OUTPUT_BATCH: usize = 32;
const OUTPUT_BATCH_TIME: std::time::Duration = std::time::Duration::from_millis(500);

/// Check a request's connection, then answer it. Off the serve loop, so the
/// loop keeps the phone's queue draining while a slow request runs (#1282).
async fn answer<F, R>(host: &Arc<PhoneHost>, connection: &Arc<rpc::MobileConnection>, respond: &F, request: serde_json::Value) -> Result<(String, serde_json::Value)>
where
    F: Fn(serde_json::Value) -> R,
    R: std::future::Future<Output = serde_json::Value>,
{
    // Before the request runs: a stream it opens waits for its reply (#1333).
    let id = request_id(&request);
    connection.opening(&id);
    connection.check_off_runtime(host).await?;
    Ok((id, respond(request).await))
}

/// A host signal not yet read: `Some(None)` when the host dropped the
/// sender, which cancels the connection.
fn pending_signal(signals: &mut mpsc::UnboundedReceiver<ConnectionSignal>) -> Option<Option<ConnectionSignal>> {
    match signals.try_recv() {
        Ok(signal) => Some(Some(signal)),
        Err(mpsc::error::TryRecvError::Disconnected) => Some(None),
        Err(mpsc::error::TryRecvError::Empty) => None,
    }
}

/// The close code for a credential this Mac no longer accepts, as at the
/// relay ("Access removed"). Only a revoked or unknown device credential gets
/// it: the phone takes it as its pairing gone, and stops offering that
/// pairing's diagnostics (#1315). The relay passes it on to a phone on a
/// relay connection as it is.
pub(crate) const CREDENTIAL_REFUSED: u16 = 4401;

/// Close a phone's socket as refused: its device credential is revoked or unknown.
pub(crate) async fn close_refused<S>(socket: &mut WebSocketStream<S>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let frame = CloseFrame { code: CloseCode::from(CREDENTIAL_REFUSED), reason: "credential refused".into() };
    let _ = tokio::time::timeout(WRITE_TIMEOUT, socket.close(Some(frame))).await;
}

/// A check's failure, as the signal it stands for: a revocation when this
/// phone's credential is gone, as its signal may still be on its way, so the
/// phone is closed as refused and not dropped with no close frame (#1315).
/// Any other failure ends the connection with its error.
async fn revocation(connection: &rpc::MobileConnection, error: anyhow::Error) -> Result<Option<ConnectionSignal>> {
    if connection.credential_revoked().await {
        log::info!("phone: credential revoked during a check: {error:#}");
        return Ok(Some(ConnectionSignal::Revoke));
    }
    Err(error)
}

/// Whether a reply answered under this ending may still go out, under its
/// output permit: before any signal, or after a revocation (see `serve_connection`).
fn replies_under_permit(ending: Option<Option<ConnectionSignal>>) -> bool {
    matches!(ending, None | Some(Some(ConnectionSignal::Revoke)))
}

/// End a connection on its host's signal: `None` when the host dropped the
/// sender, which cancels it.
async fn end_on_signal<S>(socket: &mut WebSocketStream<S>, session: &mut E2eeSession, connection: &rpc::MobileConnection, signal: Option<ConnectionSignal>) -> Ended
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let reason = if signal == Some(ConnectionSignal::Disconnect) {
        let _ = tokio::time::timeout(WRITE_TIMEOUT, send_message(socket, session, &disconnected_notification(), connection.wire())).await;
        EndReason::DisconnectedOnMac
    } else {
        EndReason::Cancelled
    };
    connection.close();
    if signal == Some(ConnectionSignal::Revoke) {
        close_refused(socket).await;
    } else {
        let _ = tokio::time::timeout(WRITE_TIMEOUT, socket.close(None)).await;
    }
    Ended::by(reason)
}

/// The phone's requests and the host's replies and notifications, until the
/// phone closes, the host signals, or the connection falls behind. `respond`
/// answers one request at a time, in the order they came; while it runs the
/// loop still sends what is queued and reads what the phone sends. Every
/// reply is checked again after it, so a reply queued meanwhile never
/// discloses session data after a revocation. A stream the request opens is
/// held until its reply is sent, so its opening result (a terminal's
/// snapshot) always comes before its first item (#1333).
///
/// A host signal fences the connection as soon as it is seen, in flight
/// request or not (#1332): nothing queued, no invalidation and no reply goes
/// out after it, and no later request starts. Two requests in flight are
/// still answered first:
/// - a `pairing.forget`, which itself cancels the connection: its
///   acknowledgement carries no session data;
/// - any request when the signal is a revocation (#1315): its reply goes out
///   only under an output permit, which the registry refuses once the
///   credential is gone and which a revocation waits for, so the permit, not
///   the signal, decides whether it may. A disconnect leaves the credential,
///   and the permit with it, in place, so it alone withholds the reply.
///
/// A check that fails because the credential is gone ends the connection as
/// revoked, closed as refused, as the revocation's own signal would.
pub(crate) async fn serve_connection<S, F, R>(
    socket: &mut WebSocketStream<S>,
    session: &mut E2eeSession,
    host: &Arc<PhoneHost>,
    connection: &Arc<rpc::MobileConnection>,
    mut outbound: mpsc::Receiver<serde_json::Value>,
    mut signals: mpsc::UnboundedReceiver<ConnectionSignal>,
    respond: F,
) -> Result<Ended>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn(serde_json::Value) -> R,
    R: std::future::Future<Output = serde_json::Value>,
{
    let mut reassembly = wire::Reassembly::default();
    let mut stream_health = tokio::time::interval(std::time::Duration::from_millis(250));
    let mut grant_health = tokio::time::interval(std::time::Duration::from_secs(1));
    grant_health.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut waiting: std::collections::VecDeque<serde_json::Value> = std::collections::VecDeque::new();
    let mut answering = None;
    // Whether the request being answered is a `pairing.forget`.
    let mut forgetting = false;
    // The host's signal, once seen: the connection is fenced from then on.
    let mut ending: Option<Option<ConnectionSignal>> = None;
    loop {
        if ending.is_none() {
            ending = pending_signal(&mut signals);
        }
        if let Some(signal) = ending {
            // A forget's acknowledgement, or a reply after a revocation, is
            // waited for; any other request in flight is dropped with the connection.
            if !(answering.is_some() && (forgetting || replies_under_permit(ending))) {
                return Ok(end_on_signal(socket, session, connection, signal).await);
            }
        } else if answering.is_none() {
            if let Some(request) = waiting.pop_front() {
                forgetting = request["method"] == "pairing.forget";
                answering = Some(Box::pin(answer(host, connection, &respond, request)));
            }
        }
        tokio::select! {
            _ = stream_health.tick() => { connection.check_buffer()?; }
            _ = grant_health.tick(), if ending.is_none() => {
                if let Err(error) = connection.check_off_runtime(host).await {
                    ending = Some(revocation(connection, error).await?);
                }
            }
            signal = signals.recv(), if ending.is_none() => {
                ending = Some(signal);
            }
            answered = async { answering.as_mut().expect("guarded").await }, if answering.is_some() => {
                answering = None;
                let (id, response) = match answered {
                    Ok(answered) => answered,
                    Err(error) => {
                        // Its check failed before it was answered: no reply.
                        let signal = revocation(connection, error).await?;
                        ending.get_or_insert(signal);
                        continue;
                    }
                };
                // Revalidate after asynchronous work: queued replies must not
                // disclose session data after revocation or account replacement.
                // Successful self-unpairing deliberately revokes this connection;
                // its acknowledgement contains no session data.
                if forgetting && response["ok"] == true {
                    tokio::time::timeout(WRITE_TIMEOUT, send_message(socket, session, &response, connection.wire())).await??;
                } else if replies_under_permit(ending) {
                    match connection.output_permit(host).await {
                        Ok(_permit) => {
                            // The permit first, then the signal: a disconnect
                            // that came while the permit was taken withholds
                            // the reply (#1332). A revocation cannot have been
                            // written meanwhile: it waits for the permit.
                            if ending.is_none() {
                                ending = pending_signal(&mut signals);
                            }
                            if replies_under_permit(ending) {
                                tokio::time::timeout(WRITE_TIMEOUT, send_message(socket, session, &response, connection.wire())).await??;
                            }
                        }
                        Err(error) => {
                            let signal = revocation(connection, error).await?;
                            ending.get_or_insert(signal);
                        }
                    }
                }
                // Only now may the stream it opened follow it (#1333).
                connection.opened(&id);
            }
            _ = connection.invalidations().raised(), if ending.is_none() => {
                let pending = connection.invalidations().take();
                if !pending.is_empty() {
                    let _permit = match connection.output_permit(host).await {
                        Ok(permit) => permit,
                        Err(error) => {
                            ending = Some(revocation(connection, error).await?);
                            continue;
                        }
                    };
                    for message in &pending {
                        // A signal that came while the permit was taken fences the rest.
                        ending = pending_signal(&mut signals);
                        if ending.is_some() {
                            break;
                        }
                        tokio::time::timeout(WRITE_TIMEOUT, send_message(socket, session, message, connection.wire())).await??;
                    }
                }
            }
            outgoing = outbound.recv(), if ending.is_none() => {
                let Some(first) = outgoing else {
                    connection.close();
                    return Ok(Ended::by(EndReason::HostClosed));
                };
                // One permit for what is queued now, not a runtime round trip
                // and a device file read for every message (#1282).
                let _permit = match connection.output_permit(host).await {
                    Ok(permit) => permit,
                    Err(error) => {
                        ending = Some(revocation(connection, error).await?);
                        continue;
                    }
                };
                let started = tokio::time::Instant::now();
                let mut next = Some(first);
                let mut sent = 0;
                while let Some(message) = next.take() {
                    // A signal that came meanwhile fences the rest of the batch.
                    ending = pending_signal(&mut signals);
                    if ending.is_some() {
                        break;
                    }
                    tokio::time::timeout(WRITE_TIMEOUT, send_message(socket, session, &message, connection.wire())).await??;
                    sent += 1;
                    if sent < OUTPUT_BATCH && started.elapsed() < OUTPUT_BATCH_TIME {
                        next = outbound.try_recv().ok();
                    }
                }
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else {
                    connection.close();
                    return Ok(Ended::by(EndReason::StreamEnded));
                };
                use tokio_tungstenite::tungstenite::error::{Error as WsError, ProtocolError};
                let incoming = match incoming {
                    // Dropped with no close frame: by the relay or the network.
                    Err(WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake)) => {
                        connection.close();
                        return Ok(Ended::by(EndReason::StreamEnded));
                    }
                    incoming => incoming?,
                };
                let plaintext = match incoming {
                    Message::Text(text) => {
                        let bytes = decode_canonical_base64(&text).context(Fault::Unreadable)?;
                        session.open(&bytes, PayloadKind::Text).context(Fault::Unreadable)?
                    }
                    Message::Binary(bytes) => {
                        // Binary frames carry only the fragments of a request too
                        // large for one frame (#669). Other binary application streams
                        // are deliberately not attached to a workspace in this
                        // foundation; authentication and framing still fail closed.
                        let frame = session.open(&bytes, PayloadKind::Binary).context(Fault::Unreadable)?;
                        match reassembly.push(&frame).context(Fault::Unreadable)? {
                            Some(message) => message,
                            None => continue,
                        }
                    }
                    Message::Close(frame) => {
                        connection.close();
                        return Ok(Ended::closed_with(frame.map(|frame| u16::from(frame.code))));
                    }
                    Message::Ping(bytes) => {
                        send_pong(socket, bytes).await?;
                        continue;
                    }
                    Message::Pong(_) | Message::Frame(_) => continue,
                };
                let request: serde_json::Value = serde_json::from_slice(&plaintext).context(Fault::Unreadable)?;
                if waiting.len() >= UNANSWERED_REQUESTS {
                    return Err(Fault::TooManyRequests.into());
                }
                waiting.push_back(request);
            }
        }
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio_tungstenite::tungstenite::protocol::Role;

    #[tokio::test]
    async fn a_stalled_pong_write_ends_at_its_deadline() {
        let (mut transport, _phone) = tokio::io::duplex(1);
        transport.write_all(b"x").await.unwrap();
        let mut socket = WebSocketStream::from_raw_socket(transport, Role::Server, None).await;
        let error = send_pong(&mut socket, b"ping".to_vec().into()).await.unwrap_err();
        assert!(error.is::<tokio::time::error::Elapsed>());
    }
}

/// A method's answer when no handler took it: `status.get`, or why not.
pub(crate) fn static_rpc_response(request: &serde_json::Value, scope: DeviceScope) -> serde_json::Value {
    let id = request.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
    let method = request.get("method").and_then(serde_json::Value::as_str).unwrap_or("");
    if method == "status.get" && allowed_method(scope, method) {
        return serde_json::json!({
            "id": id,
            "ok": true,
            "result": { "protocolVersion": 2, "product": "TerminalX", "deviceScope": scope },
            "_meta": { "runtimeId": "desktop" }
        });
    }
    let (code, message) = if allowed_method(scope, method) {
        ("unavailable", "This paired-device method is not connected to a workspace yet".into())
    } else {
        ("forbidden", format!("Method '{method}' is not available to this paired device"))
    };
    serde_json::json!({
        "id": id,
        "ok": false,
        "error": { "code": code, "message": message },
        "_meta": { "runtimeId": "desktop" }
    })
}

/// A request's error reply.
pub(crate) fn error_response(id: &str, error: &anyhow::Error) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "ok": false,
        "error": { "code": "unavailable", "message": error.to_string() },
        "_meta": { "runtimeId": "desktop" }
    })
}

/// A request's id, or empty.
pub(crate) fn request_id(request: &serde_json::Value) -> String {
    request.get("id").and_then(serde_json::Value::as_str).unwrap_or("").to_string()
}

pub(crate) fn allowed_method(scope: DeviceScope, method: &str) -> bool {
    if scope == DeviceScope::Session {
        return crate::local_sharing::scoped_method(method);
    }
    const VIEWER: &[&str] = &[
        "status.get",
        "presence.join",
        "presence.leave",
        "presence.heartbeat",
        "presence.list",
        "chat.post",
        "chat.list",
        "sessions.summaries",
        "session.tail",
        // A prompt's image, from the session's own attachments.
        "session.image",
        "session.sync",
        "sync.capabilities",
        "transport.negotiate",
        "session.subscribe",
        "session.unsubscribe",
        "session.status",
        "session.roster",
        "session.tabs.list",
        "terminal.read",
        "terminal.subscribe",
        "terminal.unsubscribe",
        // What a tab runs, the models to pick from, and the context a
        // continuation would carry: reads, as the transcript is.
        "session.markRead",
        "session.tab",
        "models.list",
        "session.prepareContinuation",
        "notifications.missedSince",
        "notifications.subscribe",
        "notifications.unsubscribe",
        "host.describe",
        "pairing.forget",
        // What a new session can be started with, and this Mac's phone-visible settings.
        "sessions.options",
        "mac.settings",
    ];
    const DRIVER: &[&str] = &[
        // What the phone calls itself (PRO-314).
        "device.describe",
        "pairing.getEndpoints",
        "pairing.provisionRelay",
        "terminal.send",
        // Starts the tab's agent, and moves a native Codex tab to its terminal.
        "terminal.open",
        "terminal.control.get",
        "terminal.control.acquire",
        "terminal.control.release",
        "steerLease.get",
        "steerLease.acquire",
        "steerLease.release",
        "steerLease.queueInput",
        "chat.promoteToAgent",
        "session.send",
        "permission.respond",
        // Answering an agent's question, as the desktop's question card does (#979).
        "questions.respond",
        "sessions.create",
        "mac.setSettings",
        // The session controls a phone has as the desktop does (#706).
        "session.stop",
        "session.interrupt",
        "session.resendUnsent",
        "session.setModel",
        "session.setEffort",
        "session.setMode",
        "session.continue",
        // Closing a tab as the desktop's tab strip does.
        "session.closeTab",
    ];
    VIEWER.contains(&method) || (scope == DeviceScope::Driver && DRIVER.contains(&method))
}

/// What a phone is told this computer is (`host.describe`, PRO-87): its name,
/// and since PRO-359 whether it has a window and which OS it runs, so the
/// phone marks a headless server with a server icon. Phones before PRO-359
/// read only `name`.
pub(crate) fn host_description(name: Option<String>, has_window: bool) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "hasWindow": has_window,
        "platform": std::env::consts::OS,
    })
}

/// The pairing link. `name` is this computer's name, for the phone to show
/// instead of "Paired Mac" (PRO-87). It rides beside the offer as its own
/// query parameter, not inside it: phones parse the offer strictly, so a new
/// field there would make every phone build before this one refuse to pair,
/// while an extra parameter is simply not read by them. It is a label only;
/// nothing identifies or authenticates by it.
pub fn encode_pairing_offer(offer: &crate::local_runtime::mobile::model::PairingOffer, name: Option<&str>) -> Result<String> {
    let payload = serde_json::to_vec(offer)?;
    let mut link = format!("terminalx://pair?code={}", general_purpose::URL_SAFE_NO_PAD.encode(payload));
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        link.push_str("&name=");
        link.extend(url::form_urlencoded::byte_serialize(name.as_bytes()));
    }
    Ok(link)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceDescribeParams {
    label: String,
    platform: String,
}

/// What a phone calls itself (`device.describe`, PRO-314), checked and
/// cleaned: its label and platform.
pub(crate) fn device_description(params: Option<&serde_json::Value>) -> Result<(String, String)> {
    let params: DeviceDescribeParams = serde_json::from_value(params.cloned().unwrap_or_else(|| serde_json::json!({})))
        .map_err(|error| anyhow::anyhow!("invalid device.describe params: {error}"))?;
    let label = crate::machine_name::presentable_name(&params.label)
        .ok_or_else(|| anyhow::anyhow!("device.describe label must contain 1 to 64 visible characters"))?;
    if !matches!(params.platform.as_str(), "ios" | "android") {
        bail!("device.describe platform must be \"ios\" or \"android\"");
    }
    Ok((label, params.platform))
}
