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
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame};
use tokio_tungstenite::tungstenite::Message;

use super::MachineHost;
use crate::machine_wire::{encode_header, Forwarded, MACHINE_PATH};
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
        std::io::ErrorKind::AddrInUse => anyhow!("port {port} is in use; another program, or the window, still holds it"),
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
        serve_computer(host, rpc, Prefixed::new(head, stream)).await
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

/// E2EE v2 with the machine's host key, the computer's device token proved
/// inside it, then workspace RPC with full operating rights (decision 5).
async fn serve_computer<S: AsyncRead + AsyncWrite + Unpin>(host: Arc<MachineHost>, rpc: Arc<WorkspaceRpc>, stream: S) -> Result<()> {
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
    let lookup = host.clone();
    let computer = tokio::task::spawn_blocking(move || lookup.registry.find_by_token(&token)).await??;
    let Some(computer) = computer else {
        refuse(&mut socket).await;
        bail!("a device credential this machine does not know");
    };
    let (cancel_tx, mut cancel) = mpsc::unbounded_channel();
    // Admitted before it is told it is in, so turning the switch off or a
    // revocation meanwhile either refuses it here or finds it and closes it.
    let admit = host.clone();
    let id = computer.id.clone();
    let tracked = match tokio::task::spawn_blocking(move || admit.admit(&id, cancel_tx)).await? {
        Ok(tracked) => tracked,
        Err(error) => {
            refuse(&mut socket).await;
            return Err(error);
        }
    };
    let result = async {
        let authenticated = json!({ "type": "e2ee_authenticated", "v": 2, "transcriptHashB64": session.transcript_hash_b64 });
        crate::remote::host::send_sealed(&mut socket, &mut session, &authenticated).await?;
        let touch = host.clone();
        let id = computer.id.clone();
        let _ = tokio::task::spawn_blocking(move || touch.registry.touch(&id, chrono::Utc::now().timestamp_millis())).await;
        log::info!("machine host: computer {} connected directly", computer.id);
        let (peer, notifications) = Peer::for_installation(computer.id.clone(), Authority::Manage, None, None);
        crate::remote::host::serve_rpc(&mut socket, &mut session, &rpc, &peer, notifications, &mut cancel, |_| None).await
    }
    .await;
    host.untrack(&computer.id, tracked);
    result
}

async fn refuse<S: AsyncRead + AsyncWrite + Unpin>(socket: &mut tokio_tungstenite::WebSocketStream<S>) {
    let frame = CloseFrame { code: CloseCode::from(CREDENTIAL_REFUSED), reason: "credential refused".into() };
    let _ = socket.close(Some(frame)).await;
}

/// Pass a phone to the window, from the first byte it sent.
async fn forward_phone<S: AsyncRead + AsyncWrite + Unpin>(host: &MachineHost, head: Vec<u8>, mut stream: S, peer: SocketAddr) -> Result<()> {
    #[cfg(unix)]
    {
        // No window takes phones: refused as unreachable, as with the window closed.
        let route = host.phone_route().ok_or_else(|| anyhow!("no window takes phones"))?;
        let mut window = tokio::net::UnixStream::connect(&route).await.context("reach the window's phone route")?;
        window.write_all(&encode_header(&Forwarded::Direct { peer: Some(peer.to_string()) })?).await?;
        window.write_all(&head).await?;
        // Closed when the host gives up the port, so the window can take it
        // back: the phone reconnects to the window's own listener.
        let (cancel_tx, mut cancel) = mpsc::unbounded_channel();
        let Some(tracked) = host.track_phone(cancel_tx) else { bail!("the machine host is off") };
        let result = tokio::select! {
            copied = tokio::io::copy_bidirectional(&mut stream, &mut window) => copied.map(drop).map_err(anyhow::Error::from),
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
