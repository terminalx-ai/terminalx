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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

use super::protocol::RpcError;
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
    pub async fn handle(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value, allowed: Allowed<'_>) -> Result<Value, RpcError> {
        match method {
            "ports.list" => Ok(self.list(peer)),
            "ports.open" => self.open(peer, &params, allowed).await,
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

    /// The ports applications listen on, when this system can tell, and the
    /// caller's own open streams.
    fn list(&self, peer: &Peer) -> Value {
        let detected = listening_ports();
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
            "ports": detected.unwrap_or_default().into_iter().map(|port| json!({ "port": port })).collect::<Vec<_>>(),
            "streams": streams,
        })
    }

    /// Let a stream's data flow: its `ports.open` answer is on its way.
    pub fn start(&self, peer: &Peer, stream_id: &str) {
        if let Some(stream) = self.owned(peer, stream_id) {
            stream.started.notify_one();
        }
    }

    async fn open(self: &Arc<Self>, peer: &Arc<Peer>, params: &Value, allowed: Allowed<'_>) -> Result<Value, RpcError> {
        let port = params
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| RpcError::invalid("port must be between 1 and 65535"))?;
        self.check_room(peer.id())?;
        let _opening = {
            let mut opening = self.opening.lock().unwrap();
            let count = opening.entry(peer.id()).or_default();
            if *count >= MAX_OPENS_IN_FLIGHT {
                return Err(RpcError::new("backpressure", "too many ports are being opened at once"));
            }
            *count += 1;
            Opening { ports: self, peer_id: peer.id() }
        };
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
            Self::room(&streams, peer.id())?;
            let peer_window = self.windows.lock().unwrap().entry(peer.id()).or_default().clone();
            let stream = Arc::new(Stream {
                id: format!("port-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1),
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
        let (reader, writer) = socket.into_split();
        tokio::spawn(self.clone().read(stream.clone(), peer.clone(), reader));
        tokio::spawn(self.clone().feed(stream.clone(), peer.clone(), writer, pending));
        // Who opened what, never what was carried.
        log::info!("port stream {}: {} opened port {port}", stream.id, peer.user_id.as_deref().unwrap_or("an attachment with no person"));
        Ok(json!({ "streamId": stream.id, "port": port, "window": STREAM_WINDOW, "maxWriteBytes": MAX_WRITE_BYTES }))
    }

    fn room(streams: &HashMap<String, Arc<Stream>>, peer_id: u64) -> Result<(), RpcError> {
        if streams.len() >= MAX_STREAMS || streams.values().filter(|stream| stream.peer_id == peer_id).count() >= MAX_STREAMS_PER_PEER {
            return Err(RpcError::new("backpressure", "too many open port streams"));
        }
        Ok(())
    }

    fn check_room(&self, peer_id: u64) -> Result<(), RpcError> {
        Self::room(&self.streams.lock().unwrap(), peer_id)
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
    async fn read(self: Arc<Self>, stream: Arc<Stream>, peer: Arc<Peer>, mut reader: tokio::net::tcp::OwnedReadHalf) {
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
                    stream.unacked.fetch_add(count, Ordering::SeqCst);
                    peer.notify_sized(
                        "ports.data",
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
    async fn feed(self: Arc<Self>, stream: Arc<Stream>, peer: Arc<Peer>, mut writer: tokio::net::tcp::OwnedWriteHalf, mut pending: mpsc::UnboundedReceiver<Vec<u8>>) {
        loop {
            let bytes = tokio::select! {
                _ = stream.cancel.cancelled() => break,
                bytes = pending.recv() => match bytes { Some(bytes) => bytes, None => break },
            };
            let written = tokio::select! {
                _ = stream.cancel.cancelled() => break,
                written = tokio::time::timeout(WRITE_TIMEOUT, writer.write_all(&bytes)) => written,
            };
            if !matches!(written, Ok(Ok(()))) {
                self.end(&stream, Some((&peer, "error")));
                break;
            }
            stream.pending_input.fetch_sub(bytes.len(), Ordering::SeqCst);
            peer.notify("ports.drained", json!({ "streamId": stream.id, "bytes": bytes.len() }));
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
            peer.notify("ports.closed", json!({ "streamId": stream.id, "reason": reason }));
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

/// TCP ports something listens on that a loopback connection reaches, or
/// `None` where this system gives no cheap way to tell (a port can still be
/// opened by number).
fn listening_ports() -> Option<Vec<u16>> {
    let v4 = std::fs::read_to_string("/proc/net/tcp").ok()?;
    let v6 = std::fs::read_to_string("/proc/net/tcp6").unwrap_or_default();
    let mut ports: Vec<u16> = parse_listeners(&v4).into_iter().chain(parse_listeners(&v6)).collect();
    ports.sort_unstable();
    ports.dedup();
    Some(ports)
}

/// Listening sockets in a `/proc/net/tcp` or `tcp6` table that are bound to
/// loopback or to every address. One bound to a single other interface is
/// not reachable over loopback and is left out.
fn parse_listeners(table: &str) -> Vec<u16> {
    const LISTEN: &str = "0A";
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let local = fields.nth(1)?;
            let state = fields.nth(1)?;
            if state != LISTEN {
                return None;
            }
            let (address, port) = local.rsplit_once(':')?;
            let reachable = match address.len() {
                // IPv4, little-endian: 127.x.x.x or 0.0.0.0.
                8 => address == "00000000" || address.ends_with("7F"),
                // IPv6 in four little-endian words: ::, ::1, or the IPv4 forms mapped.
                32 => {
                    address == "00000000000000000000000000000000"
                        || address == "00000000000000000000000001000000"
                        || (address.starts_with("0000000000000000FFFF0000") && (address.ends_with("00000000") || address.ends_with("7F")))
                }
                _ => false,
            };
            reachable.then(|| u16::from_str_radix(port, 16).ok()).flatten().filter(|port| *port != 0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listeners_are_read_from_the_proc_tables() {
        let v4 = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
                  0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0\n\
                  1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0\n\
                  2: 0A00000A:2000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1 0\n\
                  3: 0100007F:C350 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 4 1 0\n";
        // Loopback and any-address listeners; not one bound to another
        // interface, and not an established connection.
        assert_eq!(parse_listeners(v4), vec![3000, 8080]);
        let v6 = "  sl  local_address                         remote_address                        st\n\
                  0: 00000000000000000000000000000000:1389 00000000000000000000000000000000:0000 0A 0 0 0\n\
                  1: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 0 0 0\n\
                  2: 000080FE00000000FF005450B6AD1DFE:0050 00000000000000000000000000000000:0000 0A 0 0 0\n";
        assert_eq!(parse_listeners(v6), vec![5001, 8081]);
        assert!(parse_listeners("garbage\nmore garbage").is_empty());
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
