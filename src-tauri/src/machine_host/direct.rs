//! The direct listener on TCP 6768, for this network and Tailscale.
//!
//! Phones already connect here (`ws://<mac>:6768`). Before any handshake the
//! listener reads the HTTP upgrade request's head to learn its path:
//! [`MACHINE_PATH`] is an operating computer, which is served here; any other
//! path is a phone, whose bytes go untouched to the window's phone route
//! (`machine_wire`), where the phone's E2EE handshake and pairing run as they
//! always have. Each side checks the token against its own registry.

use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpSocket};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame};
use tokio_tungstenite::tungstenite::Message;

use super::pairing::{Asking, Decision, Outcome};
use super::registry::token_hash;
use super::MachineHost;
use crate::machine_wire::{encode_header, ComputerRoute, Forwarded, MACHINE_PATH, REFUSED_CODE_INACTIVE, REFUSED_NOT_APPROVED};
use crate::relay_e2ee::{begin_e2ee_session, E2eeHello, PayloadKind};
use crate::remote::protocol::Authority;
use crate::remote::server::{Peer, WorkspaceRpc};

/// The most an HTTP request head may take before the path is known.
const MAX_HEAD: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// The close code a refused credential gets, as at the relay: "Access removed".
const CREDENTIAL_REFUSED: u16 = 4401;

/// The open listener; dropping [`Listening::stop`]s nothing by itself.
pub(crate) struct Listening {
    pub address: SocketAddr,
    accept: tokio::task::JoinHandle<()>,
}

impl Listening {
    /// A reported endpoint for consent tests that never opens a TCP listener.
    #[cfg(all(test, feature = "desktop", target_os = "macos"))]
    pub(super) fn for_window_consent_test() -> Self {
        Self {
            address: SocketAddr::from((Ipv4Addr::LOCALHOST, 6768)),
            accept: tokio::spawn(std::future::pending()),
        }
    }

    /// Close the port. Open connections are closed by the host.
    pub fn stop(self) {
        self.accept.abort();
    }
}

/// Bind exclusively, as the phone listener always has, so an advertised
/// address cannot reach another program's listener.
fn bind(port: u16) -> std::io::Result<TcpListener> {
    let socket = TcpSocket::new_v4()?;
    // Linux refuses a second listener on the port even with SO_REUSEADDR, so
    // there it only lets the port be bound past connections still closing
    // (TIME_WAIT is 60 s there). macOS lets it share the port, so not there.
    #[cfg(target_os = "linux")]
    socket.set_reuseaddr(true)?;
    socket.bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))?;
    socket.listen(1024)
}

pub(crate) fn listen(host: Arc<MachineHost>, rpc: Arc<WorkspaceRpc>, port: u16) -> Result<Listening> {
    let listener = bind(port).map_err(|error| match error.kind() {
        // Kept as the cause, so the host can tell a port still in use (which
        // frees up) from a failure that does not.
        std::io::ErrorKind::AddrInUse => anyhow!(error).context(format!("port {port} is in use; another program, or the window, still holds it")),
        _ => anyhow!(error).context(format!("listen on port {port}")),
    })?;
    let address = listener.local_addr()?;
    let accept = tokio::spawn(async move {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    log::warn!("machine host: accept: {error}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let (host, rpc) = (host.clone(), rpc.clone());
            tokio::spawn(async move {
                if let Err(error) = connection(host, rpc, stream, peer).await {
                    log::debug!("machine host: connection from {peer} ended: {error:#}");
                }
            });
        }
    });
    Ok(Listening { address, accept })
}

async fn connection(host: Arc<MachineHost>, rpc: Arc<WorkspaceRpc>, stream: tokio::net::TcpStream, peer: SocketAddr) -> Result<()> {
    let mut stream = crate::data_privacy::NetworkIo::new(stream);
    let head = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut stream)).await.context("no request")??;
    if request_path(&head)? == MACHINE_PATH {
        anyhow::ensure!(host.enabled(), "computer operation is off");
        serve_computer(host, rpc, Prefixed::new(head, stream), ComputerRoute::of_peer(peer.ip())).await
    } else {
        forward_phone(&host, head, stream, peer).await
    }
}

/// Read up to the end of the HTTP head (`\r\n\r\n`), keeping every byte.
pub(crate) async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            bail!("closed before its request was complete");
        }
        head.extend_from_slice(&chunk[..count]);
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(head);
        }
        if head.len() > MAX_HEAD {
            bail!("request head over {MAX_HEAD} bytes");
        }
    }
}

/// The path of an HTTP request, without its query.
pub(crate) fn request_path(head: &[u8]) -> Result<String> {
    let line = head.split(|byte| *byte == b'\n').next().unwrap_or_default();
    let line = std::str::from_utf8(line).context("request line is not text")?.trim_end_matches('\r');
    let mut parts = line.split(' ');
    let (Some(_method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else { bail!("not an HTTP request") };
    if !version.starts_with("HTTP/") {
        bail!("not an HTTP request");
    }
    Ok(target.split('?').next().unwrap_or_default().to_string())
}

/// A stream that first gives back bytes already read from it.
pub(crate) struct Prefixed<S> {
    prefix: Vec<u8>,
    at: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    pub(crate) fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self { prefix, at: 0, inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if this.at < this.prefix.len() {
            let count = (this.prefix.len() - this.at).min(buf.remaining());
            buf.put_slice(&this.prefix[this.at..this.at + count]);
            this.at += count;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// E2EE v2 with the machine's host key, then the computer's `e2ee_auth`,
/// answered in the order docs/MACHINES.md "As built (PRO-342)" gives: a
/// paired computer with the key it paired with is served workspace RPC with
/// full operating rights (decision 5); the live code's token waits for Allow;
/// anything else is refused. Nothing is granted before Allow: no
/// `e2ee_authenticated`, no record, no RPC.
pub(crate) async fn serve_computer<S: AsyncRead + AsyncWrite + Unpin>(host: Arc<MachineHost>, rpc: Arc<WorkspaceRpc>, stream: S, route: ComputerRoute) -> Result<()> {
    let mut socket = tokio_tungstenite::accept_async_with_config(stream, Some(crate::remote::host::websocket_config())).await?;
    let keypair = host.keypair().context("the machine host key is not loaded")?;
    let hello = match tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.next()).await.context("no E2EE hello")? {
        Some(Ok(Message::Text(text))) => text,
        _ => bail!("closed before the E2EE hello"),
    };
    let hello: E2eeHello = serde_json::from_str(&hello).context("decode E2EE hello")?;
    let (ready, mut session) = begin_e2ee_session(&keypair, hello, "direct", None)?;
    socket.send(Message::Text(serde_json::to_string(&ready)?.into())).await?;
    let auth = match tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.next()).await.context("no E2EE authentication")? {
        Some(Ok(Message::Text(text))) => text,
        _ => bail!("closed before E2EE authentication"),
    };
    let auth: Value = serde_json::from_slice(&session.open(&STANDARD.decode(auth.as_bytes())?, PayloadKind::Text)?)?;
    if auth["type"] != "e2ee_auth" || auth["v"] != 2 || auth["transcriptHashB64"].as_str() != Some(&session.transcript_hash_b64) {
        bail!("E2EE authentication was not bound to the handshake");
    }
    let token = auth["deviceToken"].as_str().map(str::to_string).ok_or_else(|| anyhow!("E2EE authentication lacks a device token"))?;
    let client_key = session.client_public_key_b64.clone();
    let computer = match find(&host, &token).await? {
        Some(computer) => computer,
        None => {
            let asking = Asking {
                token_hash: token_hash(&token),
                client_key_b64: &client_key,
                label: computer_label(auth["label"].as_str()),
                platform: computer_platform(auth["platform"].as_str()),
                fingerprint: computer_fingerprint(keypair.public(), &client_key, &token)?,
                transport: "direct",
            };
            let (request_id, outcome) = match host.ask(asking) {
                Decision::Wait { request_id, outcome } => (request_id, outcome),
                Decision::Refuse(reason) => return refuse_pairing(&mut socket, &mut session, reason).await,
            };
            match await_allow(&host, &mut socket, &request_id, outcome).await {
                Some(Outcome::Approved) => {}
                Some(Outcome::Refused(reason)) => return refuse_pairing(&mut socket, &mut session, reason).await,
                Some(Outcome::Waiting) | None => bail!("the asking computer closed before an answer"),
            }
            // Allow wrote its record: admitted as any paired computer is.
            find(&host, &token).await?.ok_or_else(|| anyhow!("the computer allowed a moment ago was removed"))?
        }
    };
    let Some(computer) = host.paired_with_key(computer, &client_key) else {
        refuse(&mut socket).await;
        bail!("a paired computer's credential with another key");
    };
    let (cancel_tx, mut cancel) = mpsc::unbounded_channel();
    // Admitted before it is told it is in, so turning the switch off or a
    // revocation meanwhile either refuses it here or finds it and closes it.
    // An expired credential or a computer the person disconnected is
    // refused with its reason (PRO-357).
    let admit = host.clone();
    let admitted = computer.clone();
    let tracked = match tokio::task::spawn_blocking(move || admit.admit(&admitted, &token, route, cancel_tx)).await? {
        Ok(Ok(tracked)) => tracked,
        Ok(Err(reason)) => return refuse_pairing(&mut socket, &mut session, reason).await,
        Err(error) => {
            refuse(&mut socket).await;
            return Err(error);
        }
    };
    let result = async {
        let authenticated = json!({ "type": "e2ee_authenticated", "v": 2, "transcriptHashB64": session.transcript_hash_b64 });
        crate::remote::host::send_sealed(&mut socket, &mut session, &authenticated).await?;
        log::info!("machine host: computer {} connected directly", computer.id);
        let (peer, notifications) = Peer::for_installation(computer.id.clone(), Authority::Manage, None, None);
        crate::remote::host::serve_rpc(&mut socket, &mut session, &rpc, &peer, notifications, &mut cancel, |_| None).await
    }
    .await;
    host.untrack(&computer.id, tracked);
    result
}

/// The paired computer whose token this is. Blocking, so off this task.
async fn find(host: &Arc<MachineHost>, token: &str) -> Result<Option<crate::machine_host::registry::PairedComputer>> {
    let (lookup, token) = (host.clone(), token.to_string());
    tokio::task::spawn_blocking(move || lookup.registry.find_by_token(&token)).await?
}

/// Wait for Allow, two minutes at most. A frame from the computer, or its
/// connection closing, means it gave up: `None`, and the last such
/// connection declines the request.
async fn await_allow<S: AsyncRead + AsyncWrite + Unpin>(
    host: &MachineHost,
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    request_id: &str,
    mut outcome: watch::Receiver<Outcome>,
) -> Option<Outcome> {
    let deadline = tokio::time::Instant::now() + host.approval_ttl();
    let answered = tokio::select! {
        answered = outcome.wait_for(|outcome| *outcome != Outcome::Waiting) => answered.map(|outcome| *outcome).ok(),
        _ = tokio::time::sleep_until(deadline) => {
            host.decline(request_id);
            Some(Outcome::Refused(REFUSED_NOT_APPROVED))
        }
        _ = gave_up(socket) => None,
    };
    match answered {
        Some(answered) => Some(answered),
        None => {
            // Closed, or the request ended with its sender: never Allow.
            host.leave(request_id);
            let ended = *outcome.borrow();
            (ended != Outcome::Waiting).then_some(ended)
        }
    }
}

/// Resolves when the waiting computer sends anything but a ping or pong, or
/// its connection ends. Nothing it sends before Allow is answered.
async fn gave_up<S: AsyncRead + AsyncWrite + Unpin>(socket: &mut tokio_tungstenite::WebSocketStream<S>) {
    while let Some(Ok(Message::Ping(_) | Message::Pong(_))) = socket.next().await {}
}

/// `pairing_refused`, sealed, then the socket closes. A token this machine
/// does not know (`code-inactive`) may be a revoked computer's as well as a
/// spent code's, so that close is `4401`, "Access removed", as a refused
/// credential's always was: a computer that was connecting stops retrying,
/// and one that was pairing has read the reason first.
async fn refuse_pairing<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    session: &mut crate::relay_e2ee::E2eeSession,
    reason: &'static str,
) -> Result<()> {
    let refused = json!({ "type": "pairing_refused", "v": 1, "reason": reason });
    let _ = crate::remote::host::send_sealed(socket, session, &refused).await;
    if reason == REFUSED_CODE_INACTIVE {
        refuse(socket).await;
    } else {
        let _ = socket.close(None).await;
    }
    bail!("pairing refused ({reason})")
}

/// The name the computer gave, as the approval dialog may show it: control
/// characters stripped, 1 to 64 characters.
pub(crate) fn computer_label(label: Option<&str>) -> String {
    let label: String = label.unwrap_or_default().chars().filter(|char| !char.is_control()).collect();
    let label: String = label.trim().chars().take(64).collect();
    let label = label.trim();
    if label.is_empty() { "Unnamed computer".into() } else { label.into() }
}

pub(crate) fn computer_platform(platform: Option<&str>) -> Option<String> {
    platform.filter(|platform| matches!(*platform, "macos" | "linux")).map(str::to_string)
}

/// The pairing fingerprint both screens show (decision 5).
pub(crate) fn computer_fingerprint(host_pk: &[u8; 32], client_key_b64: &str, token: &str) -> Result<String> {
    let client: [u8; 32] = STANDARD.decode(client_key_b64)?.try_into().map_err(|_| anyhow!("client key is not 32 bytes"))?;
    Ok(crate::pairing_fingerprint::fingerprint(host_pk, &client, &token_hash(token)))
}

async fn refuse<S: AsyncRead + AsyncWrite + Unpin>(socket: &mut tokio_tungstenite::WebSocketStream<S>) {
    let frame = CloseFrame { code: CloseCode::from(CREDENTIAL_REFUSED), reason: "credential refused".into() };
    let _ = socket.close(Some(frame)).await;
}

/// Pass a phone to the window, from the first byte it sent.
async fn forward_phone<S: AsyncRead + AsyncWrite + Unpin>(host: &MachineHost, head: Vec<u8>, stream: S, peer: SocketAddr) -> Result<()> {
    #[cfg(unix)]
    {
        // No window takes phones: the runtime serves the phone itself (PRO-359).
        let Some(route) = host.phone_route() else {
            return serve_phone(host, head, stream).await;
        };
        let mut window = tokio::net::UnixStream::connect(&route).await.context("reach the window's phone route")?;
        window.write_all(&encode_header(&Forwarded::Direct { peer: Some(peer.to_string()) })?).await?;
        window.write_all(&head).await?;
        // Closed when the host gives up the port, so the window can take it
        // back: the phone reconnects to the window's own listener.
        let (cancel_tx, mut cancel) = mpsc::unbounded_channel();
        let Some(tracked) = host.track_phone(cancel_tx) else { bail!("the machine host is off") };
        let (mut phone_read, mut phone_write) = tokio::io::split(stream);
        let (mut window_read, mut window_write) = window.into_split();
        // A WebSocket is done when either peer closes. In particular, an
        // idle revoked phone need not close its own half of the TCP socket.
        let result = tokio::select! {
            copied = tokio::io::copy(&mut phone_read, &mut window_write) => copied.map(drop).map_err(anyhow::Error::from),
            copied = tokio::io::copy(&mut window_read, &mut phone_write) => copied.map(drop).map_err(anyhow::Error::from),
            _ = cancel.recv() => Ok(()),
        };
        host.untrack_phone(tracked);
        result
    }
    #[cfg(not(unix))]
    {
        let _ = (host, head, &mut stream, peer);
        bail!("phone routes need Unix sockets")
    }
}

/// Serve a phone here, while no window takes phones (`phones`). It holds
/// the port as a forwarded phone does, so it closes with the listener.
#[cfg(unix)]
async fn serve_phone<S: AsyncRead + AsyncWrite + Unpin>(host: &MachineHost, head: Vec<u8>, stream: S) -> Result<()> {
    let (phones, keypair, port, stopped, epoch) = host.phone_admission().context("the runtime no longer owns phone admission")?;
    let (cancel_tx, mut cancel) = mpsc::unbounded_channel();
    let Some(tracked) = host.track_phone(cancel_tx) else { bail!("the machine host is off") };
    let result = tokio::select! {
        served = phones.serve(keypair, Prefixed::new(head, stream), port, stopped, epoch) => served,
        _ = cancel.recv() => Ok(()),
    };
    host.untrack_phone(tracked);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_decides_who_serves_a_connection() {
        let computer = b"GET /machine/1 HTTP/1.1\r\nHost: mac.local:6768\r\nUpgrade: websocket\r\n\r\n";
        assert_eq!(request_path(computer).unwrap(), MACHINE_PATH);
        assert_eq!(request_path(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").unwrap(), "/");
        assert_eq!(request_path(b"GET /machine/1?x=1 HTTP/1.1\r\n\r\n").unwrap(), MACHINE_PATH);
        assert!(request_path(b"\x16\x03\x01garbage").is_err());
        assert!(request_path(b"GET /machine/1\r\n\r\n").is_err());
    }

    #[tokio::test]
    async fn the_head_is_kept_and_replayed_before_the_rest() {
        let (mut client, server) = tokio::io::duplex(64);
        client.write_all(b"GET / HTTP/1.1\r\nA: b\r\n\r\nbody").await.unwrap();
        drop(client);
        let mut server = server;
        let head = read_head(&mut server).await.unwrap();
        assert!(head.starts_with(b"GET / HTTP/1.1"));
        let mut replayed = Vec::new();
        Prefixed::new(head, server).read_to_end(&mut replayed).await.unwrap();
        assert_eq!(replayed, b"GET / HTTP/1.1\r\nA: b\r\n\r\nbody");
    }

    #[tokio::test]
    async fn an_endless_head_is_refused() {
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        client.write_all(&vec![b'a'; MAX_HEAD + 10]).await.unwrap();
        assert!(read_head(&mut server).await.is_err());
    }
}
