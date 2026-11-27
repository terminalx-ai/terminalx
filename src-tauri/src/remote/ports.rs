//! Port streams (`ports/1`, PRO-28): a client reaches a TCP port that an
//! application in the workspace listens on, over the connection it already
//! holds. This is what a private preview is made of: the desktop listens on
//! its own `localhost`, and each connection it accepts becomes one stream
//! here (docs/CLOUD-PREVIEWS.md).
//!
//! What this module guarantees:
//! - It only ever connects to the workspace's own loopback. It opens no
//!   listener and no route: nothing becomes reachable from the internet, and
//!   a stream cannot be pointed at another host.
//! - A stream belongs to the connection that opened it and ends with it, so
//!   revoking an attachment, losing a role, a suspend or a delete all end
//!   every stream that connection had.
//! - Both directions are bounded by acknowledged windows. The relay cannot
//!   pause a sender and closes a connection whose buffer overflows, which
//!   would take the workspace's terminals and sessions down with it: a
//!   stream never has more than [`STREAM_WINDOW`] unacknowledged bytes in
//!   flight, and a connection never more than [`PEER_WINDOW`].

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

use super::protocol::RpcError;
use super::collab::v2::Permit;
use super::server::{Peer, MAX_WRITE_BYTES};

/// Streams one connection may hold. A page with its assets and a WebSocket
/// or two fits; a scan of the workspace's ports does not.
pub const MAX_STREAMS_PER_PEER: usize = 32;
/// Streams the runtime holds in all.
pub const MAX_STREAMS: usize = 128;
/// Unacknowledged bytes in flight on one stream, in each direction.
pub const STREAM_WINDOW: usize = 256 * 1024;
/// Unacknowledged bytes toward one connection over all its streams: well
/// under the relay's 4 MiB buffer, with room left for terminal output.
pub const PEER_WINDOW: usize = 1024 * 1024;
const _: () = assert!(STREAM_WINDOW <= PEER_WINDOW);
/// Bytes read from the application per `ports.data`.
const CHUNK: usize = 32 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// An application that takes nothing for this long ends its stream.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Opens one connection may have in flight (each holds a connect attempt).
const MAX_OPENS_IN_FLIGHT: usize = 8;
/// A stream nothing has crossed for this long is ended. Long enough for a
/// development server's reload socket, which is quiet between edits.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Bytes one stream may carry in its life, both directions together.
const LIFETIME_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Bytes sent toward a connection that it has not acknowledged yet.
#[derive(Default)]
struct Window {
    unacked: AtomicUsize,
    freed: Notify,
}

struct Stream {
    policy: Option<Permit>,
    #[cfg(target_os = "linux")]
    ssh: Option<SshStream>,
    #[cfg(any(target_os = "linux", all(test, unix)))]
    desktop: Option<DesktopStream>,
    id: String,
    peer_id: u64,
    port: u16,
    input: mpsc::UnboundedSender<Vec<u8>>,
    /// Bytes accepted from the client that the application has not taken.
    pending_input: AtomicUsize,
    /// Bytes sent to the client that it has not acknowledged.
    unacked: AtomicUsize,
    freed: Notify,
    peer_window: Arc<Window>,
    cancel: CancellationToken,
    /// Raised once the `ports.open` answer is on its way to the client:
    /// nothing is read from the application before, so no data can reach
    /// the client for a stream id it has not been told.
    started: Notify,
    /// Bytes carried so far, both directions.
    carried: AtomicU64,
    /// When something last crossed, in milliseconds since the stream opened.
    last_activity: AtomicU64,
    opened: std::time::Instant,
}

#[cfg(any(target_os = "linux", all(test, unix)))]
pub(super) struct DesktopStream {
    pub(super) collaboration: Arc<super::collab::Collaboration>,
    pub(super) allowed: Box<dyn Fn() -> bool + Send + Sync>,
    pub(super) lease: super::cloud_desktop::DesktopLease,
}

#[cfg(target_os = "linux")]
pub(super) struct SshStream {
    pub(super) collaboration: Arc<super::collab::Collaboration>,
    pub(super) allowed: Box<dyn Fn() -> bool + Send + Sync>,
    pub(super) _session: crate::workspace_ssh_listener::Session,
}

impl Stream {
    /// Count `bytes` carried. False once the stream has carried its lifetime's worth.
    fn carry(&self, bytes: usize) -> bool {
        self.last_activity.store(self.opened.elapsed().as_millis() as u64, Ordering::Relaxed);
        self.carried.fetch_add(bytes as u64, Ordering::Relaxed) + bytes as u64 <= LIFETIME_BYTES
    }

    fn idle_for(&self) -> Duration {
        self.opened.elapsed().saturating_sub(Duration::from_millis(self.last_activity.load(Ordering::Relaxed)))
    }
}

/// One open in flight, counted until it settles either way.
struct Opening<'a> {
    ports: &'a Ports,
    peer_id: u64,
}

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        let mut opening = self.ports.opening.lock().unwrap();
        if let Some(count) = opening.get_mut(&self.peer_id) {
            *count -= 1;
            if *count == 0 {
                opening.remove(&self.peer_id);
            }
        }
    }
}

#[derive(Default)]
pub struct Ports {
    streams: Mutex<HashMap<String, Arc<Stream>>>,
    windows: Mutex<HashMap<u64, Arc<Window>>>,
    opening: Mutex<HashMap<u64, usize>>,
    next: AtomicU64,
    desktop: bool,
}

/// Whether the caller may still open ports, read again at the moment a
/// stream would be registered.
pub type Allowed<'a> = &'a (dyn Fn() -> bool + Sync);

fn unreachable_port(port: u16) -> RpcError {
    RpcError::new("port_unreachable", format!("nothing in the workspace is listening on port {port}"))
}

fn stream_id(params: &Value) -> Result<&str, RpcError> {
    params.get("streamId").and_then(Value::as_str).ok_or_else(|| RpcError::invalid("streamId is required"))
}

impl Ports {
    #[cfg(any(target_os = "linux", all(test, unix)))]
    pub(super) fn desktop() -> Self { Self { desktop: true, ..Self::default() } }

    fn event(&self, port: &'static str, desktop: &'static str) -> &'static str {
        if self.desktop { desktop } else { port }
    }

    #[cfg(any(target_os = "linux", all(test, unix)))]
    pub(super) async fn open_desktop(
        self: &Arc<Self>, peer: &Arc<Peer>, ticket: crate::data_privacy::Ticket,
        open: impl std::future::Future<Output = Result<DesktopStream, RpcError>>,
    ) -> Result<Value, RpcError> {
        let _privacy = ticket.enter().map_err(|error| RpcError::forbidden(error.to_string()))?;
        let _opening = self.opening(peer.id())?;
        let mut desktop = open.await?;
        let socket = desktop.lease.connection.rfb.take().expect("fresh RFB socket");
        let (reader, writer) = socket.into_split();
        let allowed = &|| true;
        self.attach(peer, 0, allowed, ticket, None, Some(desktop),
            #[cfg(target_os = "linux")]
            None, reader, writer)
    }

    #[cfg(any(target_os = "linux", all(test, unix)))]
    pub(super) fn desktop_message(&self, peer: &Peer, method: &str, params: &Value) -> Result<Value, RpcError> {
        match method {
            "desktop.write" => self.write(peer, params),
            "desktop.ack" => self.ack(peer, params),
            "desktop.close" => {
                if let Some(stream) = self.owned(peer, stream_id(params)?) { self.end(&stream, None); }
                Ok(json!({}))
            }
            _ => Err(RpcError::invalid("invalid desktop stream method")),
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn open_ssh(
        self: &Arc<Self>, peer: &Arc<Peer>, ticket: crate::data_privacy::Ticket,
        socket: TcpStream, ssh: SshStream,
    ) -> Result<Value, RpcError> {
        let (reader, writer) = socket.into_split();
        self.attach(peer, 0, &|| true, ticket, None, None, Some(ssh), reader, writer)
    }

    fn opening(&self, id: u64) -> Result<Opening<'_>, RpcError> {
        self.check_room(id)?;
        let mut opening = self.opening.lock().unwrap();
        let limit = if self.desktop { 1 } else { MAX_OPENS_IN_FLIGHT };
        if opening.get(&id).copied().unwrap_or(0) >= limit || (self.desktop && opening.values().sum::<usize>() >= 8) {
            return Err(RpcError::new("backpressure", "too many streams being opened at once"));
        }
        *opening.entry(id).or_default() += 1;
        Ok(Opening { ports: self, peer_id: id })
    }

    #[cfg(test)]
    pub async fn handle(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value, allowed: Allowed<'_>) -> Result<Value, RpcError> {
        self.handle_admitted(peer, method, params, allowed, crate::github_process::ticket(), None).await
    }

    pub(crate) async fn handle_admitted(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value, allowed: Allowed<'_>, ticket: crate::data_privacy::Ticket, policy: Option<Permit>) -> Result<Value, RpcError> {
        let _privacy = ticket.enter().map_err(|error| RpcError::forbidden(error.to_string()))?;
        match method {
            "ports.list" => Ok(self.list(peer)),
            "ports.open" => self.open(peer, &params, allowed, ticket, policy).await,
            "ports.write" => self.write(peer, &params),
            "ports.ack" => self.ack(peer, &params),
            "ports.close" => {
                if let Some(stream) = self.owned(peer, stream_id(&params)?) {
                    self.end(&stream, None);
                }
                Ok(json!({}))
            }
            other => Err(RpcError::new("method_not_found", format!("{other} is not a workspace method"))),
        }
    }

    /// The ports applications listen on, when this system can tell, each
    /// with the process behind it (PRO-355), and the caller's own open
    /// streams. The runtime's own listeners are left out.
    fn list(&self, peer: &Peer) -> Value {
        let detected = super::port_listeners::listening(std::process::id());
        let streams: Vec<Value> = self
            .streams
            .lock()
            .unwrap()
            .values()
            .filter(|stream| stream.peer_id == peer.id())
            .map(|stream| json!({ "streamId": stream.id, "port": stream.port }))
            .collect();
        json!({
            "detected": detected.is_some(),
            "ports": detected.unwrap_or_default().into_iter().map(listed_port).collect::<Vec<_>>(),
            "streams": streams,
        })
    }

    /// Let a stream's data flow: its `ports.open` answer is on its way.
    pub fn start(&self, peer: &Peer, stream_id: &str) {
        if let Some(stream) = self.owned(peer, stream_id) {
            stream.started.notify_one();
        }
    }

    async fn open(self: &Arc<Self>, peer: &Arc<Peer>, params: &Value, allowed: Allowed<'_>, ticket: crate::data_privacy::Ticket, policy: Option<Permit>) -> Result<Value, RpcError> {
        let port = params
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| RpcError::invalid("port must be between 1 and 65535"))?;
        let _opening = self.opening(peer.id())?;
        // Loopback only, IPv4 then IPv6: where a development server listens.
        let mut socket = None;
        for address in [SocketAddr::from((Ipv4Addr::LOCALHOST, port)), SocketAddr::from((Ipv6Addr::LOCALHOST, port))] {
            if let Ok(Ok(connected)) = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
                socket = Some(connected);
                break;
            }
        }
        let socket = socket.ok_or_else(|| unreachable_port(port))?;
        let _ = socket.set_nodelay(true);
        let (reader, writer) = socket.into_split();
        self.attach(peer, port, allowed, ticket, policy,
            #[cfg(any(target_os = "linux", all(test, unix)))]
            None,
            #[cfg(target_os = "linux")]
            None, reader, writer)
    }

    #[allow(clippy::too_many_arguments)]
    fn attach(
        self: &Arc<Self>, peer: &Arc<Peer>, port: u16, allowed: Allowed<'_>,
        ticket: crate::data_privacy::Ticket, policy: Option<Permit>,
        #[cfg(any(target_os = "linux", all(test, unix)))] desktop: Option<DesktopStream>,
        #[cfg(target_os = "linux")] ssh: Option<SshStream>,
        reader: impl AsyncRead + Unpin + Send + 'static,
        writer: impl AsyncWrite + Unpin + Send + 'static,
    ) -> Result<Value, RpcError> {
        let read_lease = ticket.enter().map_err(|error| RpcError::forbidden(error.to_string()))?;
        let write_lease = ticket.enter().map_err(|error| RpcError::forbidden(error.to_string()))?;
        let (input, pending) = mpsc::unbounded_channel();
        let stream = {
            // Checked again under the lock: opens race each other, and the
            // connection may have closed or lost the right while this one
            // was connecting. `disconnect` and `revoke` take the same lock,
            // so a stream is either refused here or ended by them.
            let mut streams = self.streams.lock().unwrap();
            if peer.hung_up() {
                return Err(RpcError::new("unavailable", "the connection closed"));
            }
            if !allowed() {
                return Err(RpcError::forbidden("ports.open is no longer allowed for this connection"));
            }
            self.room(&streams, peer.id())?;
            #[cfg(any(target_os = "linux", all(test, unix)))]
            if desktop.as_ref().is_some_and(|desktop| !(desktop.allowed)()) {
                return Err(RpcError::forbidden("Cloud desktop access changed before open"));
            }
            #[cfg(target_os = "linux")]
            if ssh.as_ref().is_some_and(|ssh| !(ssh.allowed)()) {
                return Err(RpcError::forbidden("SSH access changed before open"));
            }
            let peer_window = self.windows.lock().unwrap().entry(peer.id()).or_default().clone();
            if let Some(permit) = &policy { permit.check(None).map_err(|_| RpcError::forbidden("Port policy changed before open"))?; }
            let stream = Arc::new(Stream {
                policy,
                #[cfg(target_os = "linux")]
                ssh,
                #[cfg(any(target_os = "linux", all(test, unix)))]
                desktop,
                id: format!("{}-{}", self.event("port", "desktop"), self.next.fetch_add(1, Ordering::Relaxed) + 1),
                peer_id: peer.id(),
                port,
                input,
                pending_input: AtomicUsize::new(0),
                unacked: AtomicUsize::new(0),
                freed: Notify::new(),
                peer_window,
                cancel: CancellationToken::new(),
                started: Notify::new(),
                carried: AtomicU64::new(0),
                last_activity: AtomicU64::new(0),
                opened: std::time::Instant::now(),
            });
            streams.insert(stream.id.clone(), stream.clone());
            stream
        };
        // Keep both socket halves owned until cancellation has dropped their
        // futures and I/O. Queued writes must never outlive their open request.
        let read = self.clone().read(stream.clone(), peer.clone(), reader);
        let feed = self.clone().feed(stream.clone(), peer.clone(), writer, pending);
        for (lease, work) in [
            (read_lease, Box::pin(read) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>),
            (write_lease, Box::pin(feed)),
        ] {
            let ticket = ticket.clone();
            let ports = self.clone();
            let stream = stream.clone();
            tokio::spawn(async move {
                let _lease = lease;
                tokio::select! { _ = ticket.cancelled() => {}, _ = work => {} }
                ports.end(&stream, None);
            });
        }
        #[cfg(target_os = "linux")]
        if stream.ssh.is_some() {
            let ports = self.clone();
            let stream = stream.clone();
            let peer = peer.clone();
            tokio::spawn(async move {
                let ssh = stream.ssh.as_ref().expect("SSH stream");
                loop {
                    tokio::select! {
                        _ = stream.cancel.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_millis(200)) => {}
                    }
                    if !(ssh.allowed)() {
                        ports.end(&stream, Some((&peer, "revoked")));
                        return;
                    }
                }
            });
        }
        // Who opened what, never what was carried.
        if self.desktop {
            return Ok(json!({ "streamId": stream.id, "window": STREAM_WINDOW, "maxWriteBytes": MAX_WRITE_BYTES }));
        }
        log::info!("port stream {}: {} opened port {port}", stream.id, peer.user_id.as_deref().unwrap_or("an attachment with no person"));
        Ok(json!({ "streamId": stream.id, "port": port, "window": STREAM_WINDOW, "maxWriteBytes": MAX_WRITE_BYTES }))
    }

    fn room(&self, streams: &HashMap<String, Arc<Stream>>, peer_id: u64) -> Result<(), RpcError> {
        let (total, per_peer) = if self.desktop { (8, 1) } else { (MAX_STREAMS, MAX_STREAMS_PER_PEER) };
        if streams.len() >= total || streams.values().filter(|stream| stream.peer_id == peer_id).count() >= per_peer {
            return Err(RpcError::new("backpressure", "too many open port streams"));
        }
        Ok(())
    }

    fn check_room(&self, peer_id: u64) -> Result<(), RpcError> {
        self.room(&self.streams.lock().unwrap(), peer_id)
    }

    /// The caller's own stream. Another connection's stream does not exist
    /// as far as this one can tell.
    fn owned(&self, peer: &Peer, id: &str) -> Option<Arc<Stream>> {
        self.streams.lock().unwrap().get(id).filter(|stream| stream.peer_id == peer.id()).cloned()
    }

    fn write(&self, peer: &Peer, params: &Value) -> Result<Value, RpcError> {
        let id = stream_id(params)?;
        let data = params.get("data").and_then(Value::as_str).ok_or_else(|| RpcError::invalid("data is required"))?;
        let bytes = general_purpose::STANDARD.decode(data).map_err(|_| RpcError::invalid("data is not base64"))?;
        if bytes.is_empty() || bytes.len() > MAX_WRITE_BYTES {
            return Err(RpcError::invalid(format!("a write carries 1 to {MAX_WRITE_BYTES} bytes")));
        }
        let stream = self.owned(peer, id).ok_or_else(|| RpcError::not_found("no such port stream"))?;
        let length = bytes.len();
        // The client paces itself by `ports.drained`; one that does not is refused, not buffered.
        if stream.pending_input.fetch_add(length, Ordering::SeqCst) + length > STREAM_WINDOW {
            stream.pending_input.fetch_sub(length, Ordering::SeqCst);
            return Err(RpcError::new("backpressure", "the application has not taken the earlier writes yet"));
        }
        if stream.input.send(bytes).is_err() {
            return Err(RpcError::not_found("no such port stream"));
        }
        Ok(json!({}))
    }

    fn ack(&self, peer: &Peer, params: &Value) -> Result<Value, RpcError> {
        let id = stream_id(params)?;
        let bytes = params.get("bytes").and_then(Value::as_u64).ok_or_else(|| RpcError::invalid("bytes is required"))? as usize;
        // An ack for a stream that just ended is not an error.
        if let Some(stream) = self.owned(peer, id) {
            // Never more than is outstanding: an ack cannot mint credit.
            let returned = release(&stream.unacked, bytes);
            release(&stream.peer_window.unacked, returned);
            stream.freed.notify_one();
            stream.peer_window.freed.notify_waiters();
        }
        Ok(json!({}))
    }

    /// Application → client.
    async fn read(self: Arc<Self>, stream: Arc<Stream>, peer: Arc<Peer>, mut reader: impl AsyncRead + Unpin) {
        tokio::select! {
            _ = stream.cancel.cancelled() => return,
            _ = stream.started.notified() => {}
        }
        let mut buffer = vec![0u8; CHUNK];
        let reason = loop {
            // Read only what the client has room for. The connection's share
            // is reserved before reading, so streams reading at once cannot
            // overshoot it together.
            loop {
                let stream_freed = stream.freed.notified();
                let peer_freed = stream.peer_window.freed.notified();
                if stream.unacked.load(Ordering::SeqCst) + CHUNK <= STREAM_WINDOW && reserve(&stream.peer_window.unacked, CHUNK, PEER_WINDOW) {
                    break;
                }
                tokio::select! {
                    _ = stream.cancel.cancelled() => return,
                    _ = stream_freed => {}
                    _ = peer_freed => {}
                    // Look again: nobody may be left to free anything.
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
                if peer.hung_up() {
                    self.end(&stream, None);
                    return;
                }
                // A client that stopped acknowledging holds nothing open.
                if stream.idle_for() >= IDLE_TIMEOUT {
                    self.end(&stream, Some((&peer, "idle")));
                    return;
                }
            }
            let read = loop {
                tokio::select! {
                    _ = stream.cancel.cancelled() => {
                        release(&stream.peer_window.unacked, CHUNK);
                        return;
                    }
                    read = tokio::time::timeout(Duration::from_secs(30), reader.read(&mut buffer)) => match read {
                        Ok(read) => break Some(read),
                        // Quiet: still worth keeping?
                        Err(_) if peer.hung_up() => break None,
                        Err(_) if stream.idle_for() >= IDLE_TIMEOUT => break Some(Err(std::io::ErrorKind::TimedOut.into())),
                        Err(_) => {}
                    },
                }
            };
            let Some(read) = read else {
                // The connection is gone: there is nobody to tell.
                release(&stream.peer_window.unacked, CHUNK);
                self.end(&stream, None);
                return;
            };
            match read {
                Ok(0) => {
                    release(&stream.peer_window.unacked, CHUNK);
                    break "eof";
                }
                Ok(count) => {
                    // Only what was read stays reserved.
                    release(&stream.peer_window.unacked, CHUNK - count);
                    stream.peer_window.freed.notify_waiters();
                    if peer.hung_up() {
                        release(&stream.peer_window.unacked, count);
                        self.end(&stream, None);
                        return;
                    }
                    if !stream.carry(count) {
                        release(&stream.peer_window.unacked, count);
                        break "limit";
                    }
                    #[cfg(any(target_os = "linux", all(test, unix)))]
                    let _admission = stream.desktop.as_ref().map(|desktop| desktop.collaboration.enter_admission());
                    #[cfg(any(target_os = "linux", all(test, unix)))]
                    if stream.desktop.as_ref().is_some_and(|desktop| !(desktop.allowed)()) {
                        release(&stream.peer_window.unacked, count);
                        break "revoked";
                    }
                    #[cfg(target_os = "linux")]
                    let _ssh_admission = stream.ssh.as_ref().map(|ssh| ssh.collaboration.enter_admission());
                    #[cfg(target_os = "linux")]
                    if stream.ssh.as_ref().is_some_and(|ssh| !(ssh.allowed)()) {
                        release(&stream.peer_window.unacked, count);
                        break "revoked";
                    }
                    stream.unacked.fetch_add(count, Ordering::SeqCst);
                    peer.notify_sized(
                        self.event("ports.data", "desktop.data"),
                        json!({ "streamId": stream.id, "data": general_purpose::STANDARD.encode(&buffer[..count]) }),
                        count,
                    );
                }
                Err(error) => {
                    release(&stream.peer_window.unacked, CHUNK);
                    break if error.kind() == std::io::ErrorKind::TimedOut { "idle" } else { "error" };
                }
            }
        };
        self.end(&stream, Some((&peer, reason)));
    }

    /// Client → application.
    async fn feed(self: Arc<Self>, stream: Arc<Stream>, peer: Arc<Peer>, mut writer: impl AsyncWrite + Unpin, mut pending: mpsc::UnboundedReceiver<Vec<u8>>) {
        loop {
            let bytes = tokio::select! {
                _ = stream.cancel.cancelled() => break,
                bytes = pending.recv() => match bytes { Some(bytes) => bytes, None => break },
            };
            let written = tokio::select! {
                _ = stream.cancel.cancelled() => break,
                written = tokio::time::timeout(WRITE_TIMEOUT, write_stream_input(&mut writer, &bytes, &stream)) => written,
            };
            if !matches!(written, Ok(Ok(()))) {
                self.end(&stream, Some((&peer, "error")));
                break;
            }
            stream.pending_input.fetch_sub(bytes.len(), Ordering::SeqCst);
            peer.notify(self.event("ports.drained", "desktop.drained"), json!({ "streamId": stream.id, "bytes": bytes.len() }));
            if !stream.carry(bytes.len()) {
                self.end(&stream, Some((&peer, "limit")));
                break;
            }
        }
        let _ = writer.shutdown().await;
    }

    /// End a stream once. `told` names the connection to tell and why; a
    /// stream the client closed itself, or whose connection is gone, tells
    /// nobody.
    fn end(&self, stream: &Arc<Stream>, told: Option<(&Peer, &str)>) {
        if self.streams.lock().unwrap().remove(&stream.id).is_none() {
            return;
        }
        stream.cancel.cancel();
        // What it had in flight no longer counts against the connection.
        let outstanding = stream.unacked.swap(0, Ordering::SeqCst);
        release(&stream.peer_window.unacked, outstanding);
        stream.peer_window.freed.notify_waiters();
        if let Some((peer, reason)) = told {
            peer.notify(self.event("ports.closed", "desktop.closed"), json!({ "streamId": stream.id, "reason": reason }));
        }
    }

    /// The connection is gone: so is everything it had open.
    pub fn disconnect(&self, peer_id: u64) {
        for stream in self.of(|stream| stream.peer_id == peer_id) {
            self.end(&stream, None);
        }
        self.windows.lock().unwrap().remove(&peer_id);
    }

    /// End the streams of a connection that may no longer drive, and say so.
    pub fn revoke(&self, peer: &Peer) {
        for stream in self.of(|stream| stream.peer_id == peer.id()) {
            self.end(&stream, Some((peer, "revoked")));
        }
    }

    #[cfg(any(target_os = "linux", all(test, unix)))]
    pub(super) fn revalidate_desktop(&self, peer: &Peer) {
        for stream in self.of(|stream| stream.peer_id == peer.id()
            && stream.desktop.as_ref().is_some_and(|desktop| !(desktop.allowed)())) {
            self.end(&stream, Some((peer, "revoked")));
        }
    }

    fn of(&self, matches: impl Fn(&Stream) -> bool) -> Vec<Arc<Stream>> {
        self.streams.lock().unwrap().values().filter(|stream| matches(stream)).cloned().collect()
    }

    #[cfg(test)]
    pub(super) fn open_streams(&self) -> usize {
        self.streams.lock().unwrap().len()
    }
}

/// Add `bytes` to `counter` if that keeps it within `limit`.
fn reserve(counter: &AtomicUsize, bytes: usize, limit: usize) -> bool {
    let mut current = counter.load(Ordering::SeqCst);
    loop {
        if current + bytes > limit {
            return false;
        }
        match counter.compare_exchange(current, current + bytes, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

/// Take up to `bytes` off `counter`; returns how much was taken.
fn release(counter: &AtomicUsize, bytes: usize) -> usize {
    let mut current = counter.load(Ordering::SeqCst);
    loop {
        let taken = bytes.min(current);
        match counter.compare_exchange(current, current - taken, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return taken,
            Err(actual) => current = actual,
        }
    }
}

/// One `ports.list` entry: `{ port, process? }`.
fn listed_port(listener: super::port_listeners::Listener) -> Value {
    match listener.process {
        Some(process) => json!({ "port": listener.port, "process": process }),
        None => json!({ "port": listener.port }),
    }
}

/// A port can be an agent's control interface. Each physical write retains
/// the stream opener's native revision/source, including queued bytes. The
/// lock is held only for a nonblocking syscall, never across an await.
async fn write_stream_input(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8], stream: &Stream) -> std::io::Result<()> {
    #[cfg(any(target_os = "linux", all(test, unix)))]
    if let Some(desktop) = &stream.desktop {
        return write_checked(writer, bytes, &desktop.collaboration, || (desktop.allowed)()).await;
    }
    #[cfg(target_os = "linux")]
    if let Some(ssh) = &stream.ssh {
        return write_checked(writer, bytes, &ssh.collaboration, || (ssh.allowed)()).await;
    }
    write_port_input(writer, bytes, stream.policy.as_ref()).await
}

async fn write_port_input(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8], policy: Option<&Permit>) -> std::io::Result<()> {
    let Some(policy) = policy else { return writer.write_all(bytes).await };
    write_checked(writer, bytes, &policy.collaboration, || policy.check(None).is_ok()).await
}

async fn write_checked(
    writer: &mut (impl AsyncWrite + Unpin), mut bytes: &[u8],
    collaboration: &super::collab::Collaboration, allowed: impl Fn() -> bool,
) -> std::io::Result<()> {
    while !bytes.is_empty() {
        let written = std::future::poll_fn(|cx| {
            let _admission = collaboration.enter_admission();
            if !allowed() {
                return std::task::Poll::Ready(Err(std::io::Error::other("stream authorization changed")));
            }
            std::pin::Pin::new(&mut *writer).poll_write(cx, bytes)
        }).await?;
        if written == 0 { return Err(std::io::ErrorKind::WriteZero.into()); }
        bytes = &bytes[written..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listed_port_names_its_process_only_when_known() {
        use super::super::port_listeners::{Listener, Process};
        let named = Listener { port: 5173, process: Some(Process { name: "vite".into(), pid: 42, cwd: Some("/repo/console".into()) }) };
        assert_eq!(listed_port(named), json!({ "port": 5173, "process": { "name": "vite", "pid": 42, "cwd": "/repo/console" } }));
        let no_cwd = Listener { port: 8080, process: Some(Process { name: "caddy".into(), pid: 7, cwd: None }) };
        assert_eq!(listed_port(no_cwd), json!({ "port": 8080, "process": { "name": "caddy", "pid": 7 } }));
        assert_eq!(listed_port(Listener { port: 3000, process: None }), json!({ "port": 3000 }));
    }

    #[test]
    fn a_connections_window_is_reserved_not_raced_for() {
        let window = AtomicUsize::new(0);
        // 32 streams asking at once get exactly what fits.
        let granted = (0..MAX_STREAMS_PER_PEER).filter(|_| reserve(&window, CHUNK, PEER_WINDOW)).count();
        assert_eq!(granted, PEER_WINDOW / CHUNK);
        assert_eq!(window.load(Ordering::SeqCst), PEER_WINDOW);
        assert!(!reserve(&window, 1, PEER_WINDOW));
    }

    #[test]
    fn an_ack_never_mints_credit() {
        let counter = AtomicUsize::new(100);
        assert_eq!(release(&counter, 40), 40);
        assert_eq!(release(&counter, 500), 60);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
}


#[cfg(test)]
#[tokio::test]
async fn phase2_collaboration_v2_port_final_writer_keeps_original_revision_and_drive_source() {
    use crate::remote::collab::{Collaboration, v2::{Action, Snapshot}};
    let dir = tempfile::tempdir().unwrap();
    let policy = Arc::new(Collaboration::new());
    policy.runtime_policy.bind(dir.path(), 1).unwrap();
    let snapshot = |revision: &str, source: &str| -> Snapshot { serde_json::from_value(json!({"v":2,"revision":revision,"members":[{
        "userId":"guest","role":"driver","canApprove":true,"approvalSource":"explicit", "writeSource":source
    }]})).unwrap() };
    policy.install_v2(snapshot("1", "explicit")).unwrap();
    let permit = Permit::new(policy.clone(), "guest", policy.runtime_policy.stamp("guest"), Action::Configure);
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
    let (mut server, _) = listener.accept().await.unwrap();
    let (_, mut writer) = client.into_split();
    write_port_input(&mut writer, b"safe", Some(&permit)).await.unwrap();
    let mut first = [0;4]; server.read_exact(&mut first).await.unwrap(); assert_eq!(&first, b"safe");
    policy.install_v2(snapshot("2", "everyone")).unwrap();
    assert!(write_port_input(&mut writer, b"stale", Some(&permit)).await.is_err());
    let current = Permit::new(policy.clone(), "guest", policy.runtime_policy.stamp("guest"), Action::Configure);
    assert!(write_port_input(&mut writer, b"everyone", Some(&current)).await.is_err());
    let mut byte = [0];
    assert!(tokio::time::timeout(Duration::from_millis(30), server.read(&mut byte)).await.is_err());
}
