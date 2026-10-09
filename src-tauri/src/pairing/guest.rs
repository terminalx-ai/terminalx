//! Desktop guest transport. Tokens stay native and travel only inside the
//! existing E2EE channel; the renderer receives session data, never credentials.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

use super::{
    sharing::{decode_link, ShareOffer},
    PairingManager,
};
use crate::relay_e2ee::{E2eeClientHandshake, E2eeSession, PayloadKind};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Handle {
    connection_id: String,
    tx: mpsc::Sender<Value>,
    cancel: mpsc::UnboundedSender<()>,
}

#[derive(Default)]
pub(super) struct GuestClient {
    handle: Mutex<Option<Handle>>,
    pending: Mutex<Option<String>>,
    generation: std::sync::atomic::AtomicU64,
}

impl PairingManager {
    pub(crate) fn pending_join(&self) -> Option<String> {
        self.guest.pending.lock().unwrap().clone()
    }

    pub(crate) fn set_pending_join(&self, link: String) -> Result<()> {
        decode_link(&link)?;
        *self.guest.pending.lock().unwrap() = Some(link);
        if let Some(sink) = self.sink.get() {
            sink.emit("session_join_requested", &json!({}));
        }
        Ok(())
    }

    pub(crate) fn leave_guest(&self) {
        self.guest
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.guest.pending.lock().unwrap() = None;
        if let Some(handle) = self.guest.handle.lock().unwrap().take() {
            let _ = handle.cancel.send(());
        }
    }

    pub(crate) fn guest_send(&self, connection_id: &str, request: Value) -> Result<()> {
        self.guest
            .handle
            .lock()
            .unwrap()
            .as_ref()
            .filter(|handle| handle.connection_id == connection_id)
            .context("The shared session is disconnected.")?
            .tx
            .try_send(request)
            .map_err(|_| anyhow!("The connection cannot keep up. Try again."))
    }

    pub(crate) fn leave_guest_connection(&self, connection_id: Option<&str>) {
        let Some(connection_id) = connection_id else {
            self.leave_guest();
            return;
        };
        let mut handle = self.guest.handle.lock().unwrap();
        if handle
            .as_ref()
            .is_some_and(|handle| handle.connection_id == connection_id)
        {
            if let Some(handle) = handle.take() {
                let _ = handle.cancel.send(());
            }
        }
    }

    pub(crate) async fn join_guest(self: &Arc<Self>, link: String) -> Result<Value> {
        let offer = decode_link(&link)?;
        let context = self
            .account
            .context()
            .context("Sign in to join this session.")?;
        self.leave_guest();
        let generation = self
            .guest
            .generation
            .load(std::sync::atomic::Ordering::SeqCst);
        let (mut socket, mut crypto) = connect(&offer).await?;
        if self
            .guest
            .generation
            .load(std::sync::atomic::Ordering::SeqCst)
            != generation
        {
            bail!("Join cancelled.");
        }
        send(
            &mut socket,
            &mut crypto,
            &json!({ "id": "join", "method": "session.authenticate", "params": {
            "sessionId": offer.session_id, "accessToken": context.access_token
        } }),
        )
        .await?;
        let joined =
            tokio::time::timeout(Duration::from_secs(35), receive(&mut socket, &mut crypto))
                .await??;
        if joined["id"] != "join" || joined["ok"] != true {
            bail!(
                "{}",
                joined["error"]["message"]
                    .as_str()
                    .unwrap_or("Your account cannot join this session.")
            );
        }
        let (tx, mut rx) = mpsc::channel::<Value>(64);
        let (cancel, mut cancelled) = mpsc::unbounded_channel();
        let connection_id = uuid::Uuid::new_v4().to_string();
        {
            let mut handle = self.guest.handle.lock().unwrap();
            if self
                .guest
                .generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != generation
                || self
                    .account
                    .current_scope()
                    .is_none_or(|scope| scope.user_id != context.user_id)
            {
                bail!("Join cancelled.");
            }
            *handle = Some(Handle {
                connection_id: connection_id.clone(),
                tx,
                cancel,
            });
        }
        let manager = self.clone();
        let user_id = context.user_id;
        let mut access_token = context.access_token;
        let session_id = offer.session_id.clone();
        let result_id = connection_id.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(15));
            let result = async {
                loop {
                    tokio::select! {
                        _ = cancelled.recv() => break,
                        _ = tick.tick() => {
                            // Local sign-out/account change ends the connection too.
                            let account = manager.account.clone();
                            let identity = tokio::select! {
                                _ = cancelled.recv() => bail!("You left the shared session."),
                                identity = tokio::task::spawn_blocking(move || account.context()) => identity?,
                            };
                            let identity = identity.filter(|identity| identity.user_id == user_id).context("Sign in again to join this session.")?;
                            if identity.access_token != access_token {
                                send(&mut socket, &mut crypto, &json!({ "id": "native.refresh", "method": "session.authenticate", "params": {
                                    "sessionId": session_id, "accessToken": identity.access_token
                                } })).await?;
                                access_token = identity.access_token;
                            }
                            socket.send(Message::Ping(Vec::new().into())).await?;
                        }
                        Some(request) = rx.recv() => send(&mut socket, &mut crypto, &request).await?,
                        message = receive(&mut socket, &mut crypto) => {
                            let message = message?;
                            if message["id"] == "native.refresh" {
                                if message["ok"] != true { bail!("Your sign-in is no longer valid. Sign in again."); }
                                continue;
                            }
                            if let Some(sink) = manager.sink.get() { sink.emit("session_guest_message", &json!({ "connectionId": connection_id, "message": message })); }
                        }
                    }
                }
                Ok::<_, anyhow::Error>(())
            }.await;
            let _ = socket.close(None).await;
            if let Some(sink) = manager.sink.get() {
                sink.emit("session_guest_closed", &json!({ "connectionId": connection_id,
                "message": result.err().map(|e| e.to_string()).unwrap_or_else(|| "You left the shared session.".into()) }));
            }
        });
        Ok(
            json!({ "sessionId": offer.session_id, "connectionId": result_id, "admitted": joined["result"]["admitted"] }),
        )
    }
}

async fn connect(offer: &ShareOffer) -> Result<(Socket, E2eeSession)> {
    let mut errors = Vec::new();
    for endpoint in std::iter::once(&offer.pairing.endpoint)
        .chain(&offer.pairing.direct_endpoints)
        .take(8)
    {
        match tokio::time::timeout(Duration::from_secs(3), handshake(offer, endpoint, false)).await
        {
            Ok(Ok(connection)) => return Ok(connection),
            _ => errors.push("direct unavailable"),
        }
    }
    if let Some(relay) = &offer.pairing.relay {
        let mut url = url::Url::parse(&relay.cell_url)?;
        url.set_scheme("wss")
            .map_err(|_| anyhow!("Invalid relay URL."))?;
        url.set_path(&format!("/v1/connect/{}", relay.relay_host_id));
        return tokio::time::timeout(
            Duration::from_secs(20),
            handshake(offer, url.as_str(), true),
        )
        .await?;
    }
    bail!("Cannot reach the host. This link requires the same network or Tailscale.")
}

async fn handshake(
    offer: &ShareOffer,
    endpoint: &str,
    relay: bool,
) -> Result<(Socket, E2eeSession)> {
    let (mut socket, _) = tokio_tungstenite::connect_async_with_config(
        endpoint,
        Some(super::pairing_websocket_config()),
        false,
    )
    .await?;
    if relay {
        let invite = offer.pairing.relay.as_ref().unwrap();
        socket.send(Message::Text(json!({ "type": "relay-auth", "v": 1, "mode": "connect", "credential": invite.invite_token }).to_string().into())).await?;
        let hello = text(&mut socket).await?;
        let hello: Value = serde_json::from_str(&hello)?;
        if hello["type"] != "relay-hello"
            || hello["ok"] != true
            || hello["credentialKind"] != "invite"
        {
            bail!("Relay refused this link.");
        }
    }
    let handshake = E2eeClientHandshake::new(
        &offer.pairing.public_key_b64,
        if relay { "relay" } else { "direct" },
        if relay {
            offer
                .pairing
                .relay
                .as_ref()
                .map(|r| r.relay_host_id.as_str())
        } else {
            None
        },
    )?;
    socket
        .send(Message::Text(
            serde_json::to_string(handshake.hello())?.into(),
        ))
        .await?;
    let ready = text(&mut socket).await?;
    let mut crypto = handshake.accept_ready(&ready)?;
    let transcript = crypto.transcript_hash_b64.clone();
    send(
        &mut socket,
        &mut crypto,
        &json!({ "type": "e2ee_auth", "v": 2, "transcriptHashB64": transcript,
        "deviceToken": offer.pairing.device_token }),
    )
    .await?;
    let authenticated = receive(&mut socket, &mut crypto).await?;
    if authenticated["type"] != "e2ee_authenticated"
        || authenticated["transcriptHashB64"] != crypto.transcript_hash_b64
    {
        bail!("Host authentication failed.");
    }
    Ok((socket, crypto))
}

async fn text(socket: &mut Socket) -> Result<String> {
    loop {
        match socket.next().await.context("The host disconnected.")?? {
            Message::Text(text) => return Ok(text.to_string()),
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
            Message::Pong(_) => (),
            _ => bail!("The host disconnected."),
        }
    }
}
async fn send(socket: &mut Socket, crypto: &mut E2eeSession, value: &Value) -> Result<()> {
    let bytes = crypto.seal(&serde_json::to_vec(value)?, PayloadKind::Text)?;
    socket
        .send(Message::Text(
            general_purpose::STANDARD.encode(bytes).into(),
        ))
        .await?;
    Ok(())
}
async fn receive(socket: &mut Socket, crypto: &mut E2eeSession) -> Result<Value> {
    let frame = text(socket).await?;
    let bytes = super::decode_canonical_base64(&frame)?;
    Ok(serde_json::from_slice(
        &crypto.open(&bytes, PayloadKind::Text)?,
    )?)
}
