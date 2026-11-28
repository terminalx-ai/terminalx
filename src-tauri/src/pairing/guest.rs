//! Desktop guest transport. Tokens stay native and travel only inside the
//! existing E2EE channel; the renderer receives session data, never credentials.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::{
    cloud::{mint_guest_assertion, GuestAssertionAudience},
    sharing::{decode_link, now, ShareOffer},
    PairingManager,
};
use crate::relay_e2ee::{E2eeClientHandshake, E2eeSession, PayloadKind};

/// Refresh the short-lived guest assertion before it reaches expiry.
const ASSERTION_REFRESH_MARGIN_MS: i64 = crate::local_sharing::IDENTITY_MS / 2;

fn authenticate_request(id: &str, session_id: &str, assertion: &str) -> Value {
    json!({
        "id": id,
        "method": "session.authenticate",
        "params": {
            "sessionId": session_id,
            "assertion": assertion,
        }
    })
}

type Socket = crate::data_privacy::Socket;

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
        crate::data_privacy::require_network()?;
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
        crate::data_privacy::require_network()?;
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
        let audience = GuestAssertionAudience {
            session_id: offer.session_id.clone(),
            link_id: offer.link_id.clone(),
            host_public_key_b64: offer.pairing.public_key_b64.clone(),
            transcript_hash_b64: crypto.transcript_hash_b64.clone(),
        };
        let mint_ctx = context.clone();
        let mint_audience = audience.clone();
        let minted = tokio::task::spawn_blocking(move || mint_guest_assertion(&mint_ctx, &mint_audience))
            .await??;
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
            &authenticate_request("join", &offer.session_id, &minted.assertion),
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
        let mut assertion_expires_at = minted.expires_at;
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
                            // Never transmit the master `access_token` to the peer host;
                            // mint a fresh short-lived audience-bound assertion only when
                            // the current assertion approaches expiry.
                            let account = manager.account.clone();
                            let identity = tokio::select! {
                                _ = cancelled.recv() => bail!("You left the shared session."),
                                identity = tokio::task::spawn_blocking(move || account.context()) => identity?,
                            };
                            let identity = identity.filter(|identity| identity.user_id == user_id).context("Sign in again to join this session.")?;
                            if now() + ASSERTION_REFRESH_MARGIN_MS >= assertion_expires_at {
                                let refresh_audience = audience.clone();
                                let fresh = tokio::select! {
                                    _ = cancelled.recv() => bail!("You left the shared session."),
                                    minted = tokio::task::spawn_blocking(move || mint_guest_assertion(&identity, &refresh_audience)) => minted??,
                                };
                                send(&mut socket, &mut crypto, &authenticate_request("native.refresh", &session_id, &fresh.assertion)).await?;
                                assertion_expires_at = fresh.expires_at;
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
        let url = crate::remote::host::websocket_url(
            &relay.cell_url,
            &format!("/v1/connect/{}", relay.relay_host_id),
        )?;
        return tokio::time::timeout(
            Duration::from_secs(20),
            handshake(offer, &url, true),
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
    let (mut socket, _) = crate::data_privacy::connect(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_authenticate_frame_sends_scoped_assertion_and_never_access_token() {
        let frame = authenticate_request("join", "session-1", "scoped-assertion-xyz");
        assert_eq!(frame["method"], "session.authenticate");
        assert_eq!(frame["params"]["sessionId"], "session-1");
        assert_eq!(frame["params"]["assertion"], "scoped-assertion-xyz");
        assert!(frame["params"].get("accessToken").is_none());
        let serialized = frame.to_string();
        assert!(!serialized.contains("accessToken"));
    }
}
