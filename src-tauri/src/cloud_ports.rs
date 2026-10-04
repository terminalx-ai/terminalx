//! The desktop's half of a cloud preview (PRO-28, docs/CLOUD-PREVIEWS.md): a
//! listener on this Mac's loopback whose connections travel to a port in the
//! workspace as `ports/1` streams, over the workspace connection that is
//! already open.
//!
//! A [`PortForwarder`] belongs to one connection, so to one workspace of one
//! account: its listeners are never handed to another workspace. They close
//! when the connection stops being live (the workspace stopped, access was
//! revoked, the relay dropped), when it is detached, and when the active
//! organization changes; a preview is opened again by the person, never
//! revived. It only sends `ports.*` requests and never changes the
//! connection's activation, so nothing here can resume a stopped workspace.
//!
//! What a listener on loopback exposes is stated in docs/CLOUD-PREVIEWS.md:
//! any program of this user can connect, and a web page in the person's
//! browser can send requests to it. The local port is random by default, the
//! listener never shares a port with another program, and a request whose
//! `Host` is not this loopback address is refused, which is what stops a web
//! page from reading a preview through DNS rebinding.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_util::sync::CancellationToken;

/// Request ids the forwarder sends; their answers never reach the web view.
pub const REQUEST_PREFIX: &str = "ports-";
/// Local connections one forwarder carries at once.
const MAX_LOCAL_CONNECTIONS: usize = 64;
/// How long a new local connection may say nothing before its stream is
/// opened anyway, for a protocol where the server speaks first. What the
/// client sends later is still judged before it is forwarded.
const SILENT_OPEN: Duration = Duration::from_millis(400);
/// The longest HTTP request head that is read to find its `Host`.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// A request head that stops arriving for this long ends the connection.
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// Bytes read from the local connection per `ports.write` (the runtime
/// accepts 64 KiB).
const CHUNK: usize = 32 * 1024;
/// Used until the runtime's `ports.open` answer names its own.
const DEFAULT_WINDOW: usize = 256 * 1024;
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// Streams whose data arrived before their `ports.open` answer.
const MAX_EARLY_STREAMS: usize = 64;

/// One forwarded port, as the interface shows it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    /// The port in the workspace.
    pub port: u16,
    /// The port on this Mac's loopback.
    pub local_port: u16,
    /// The wanted local port was taken and another was used.
    pub reassigned: bool,
}

struct Listening {
    forward: Forward,
    stop: CancellationToken,
}

struct Stream {
    /// The workspace port, so stopping its forward ends it.
    port: u16,
    to_local: mpsc::UnboundedSender<Vec<u8>>,
    /// Bytes from the runtime not yet written to the local side.
    queued: Arc<AtomicUsize>,
    /// Bytes sent to the runtime that it has not reported drained.
    in_flight: Arc<AtomicUsize>,
    drained: Arc<Notify>,
    end: CancellationToken,
}

#[derive(Default)]
struct Early {
    data: Vec<Vec<u8>>,
    closed: bool,
}

#[derive(Default)]
struct State {
    forwards: HashMap<u16, Listening>,
    /// Counts the times the connection was lost: a stream opened on one
    /// connection is never registered on the next.
    epoch: u64,
    /// The active organization when the first forward was made; a forward
    /// does not outlive a switch to another.
    scope: Option<String>,
    opens: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    streams: HashMap<String, Stream>,
    early: HashMap<String, Early>,
}

type Send = Box<dyn Fn(Value) -> bool + std::marker::Send + Sync>;

struct Inner {
    send: Send,
    /// Connected, with `ports/1` granted.
    ready: AtomicBool,
    state: Mutex<State>,
    next: AtomicUsize,
    /// Local connections being carried.
    carried: AtomicUsize,
}

#[derive(Clone)]
pub struct PortForwarder {
    inner: Arc<Inner>,
}

/// What a browser is told when a preview cannot be served.
fn page(status: &str, message: &str) -> Vec<u8> {
    let body = format!("{message}\n");
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn refusal(code: &str, port: u16) -> (&'static str, String) {
    match code {
        "port_unreachable" => ("502 Bad Gateway", format!("Nothing in the cloud workspace is listening on port {port}. Start the application there, then reload.")),
        "forbidden" => ("403 Forbidden", "You do not have access to this workspace's ports. A manager, or a driver who may approve permissions, can open a preview.".into()),
        "backpressure" => ("503 Service Unavailable", "Too many connections to this workspace's ports are open. Close some and reload.".into()),
        // The runtime's own words are never put on the page.
        _ => ("502 Bad Gateway", format!("The cloud workspace could not open port {port}.")),
    }
}

const STOPPED: &str = "This cloud workspace is stopped or not connected. Start it in TerminalX, then reload. Nothing was started by opening this page.";

impl PortForwarder {
    /// `send` hands a request frame to the workspace connection; false when
    /// it could not be sent.
    pub fn new(send: impl Fn(Value) -> bool + std::marker::Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Inner {
                send: Box::new(send),
                ready: AtomicBool::new(false),
                state: Mutex::new(State::default()),
                next: AtomicUsize::new(0),
                carried: AtomicUsize::new(0),
            }),
        }
    }

    fn id(&self, kind: &str) -> String {
        format!("{REQUEST_PREFIX}{kind}-{}", self.inner.next.fetch_add(1, Ordering::Relaxed))
    }

    /// The connection's state changed. `capabilities` is what a connected
    /// runtime granted; `None` when it is not connected. Whatever ended the
    /// connection (the workspace stopped, access was revoked, the relay
    /// dropped), its streams and its listeners end with it: nothing keeps
    /// answering on this Mac for a workspace that is not there, and nothing
    /// comes back by itself when it returns.
    pub fn set_connected(&self, capabilities: Option<&[String]>) {
        let ready = capabilities.is_some_and(|granted| granted.iter().any(|capability| capability == "ports/1"));
        self.inner.ready.store(ready, Ordering::SeqCst);
        if !ready {
            self.shutdown();
        }
    }

    /// Close every forward unless `active` is still the organization they
    /// were made under.
    pub fn keep_scope(&self, active: Option<&str>) {
        let changed = self.inner.state.lock().unwrap().scope.as_deref().is_some_and(|made_under| Some(made_under) != active);
        if changed {
            log::info!("closing port forwards: the active organization changed");
            self.shutdown();
        }
    }

    fn drop_streams(&self) {
        let mut state = self.inner.state.lock().unwrap();
        state.epoch += 1;
        for (_, stream) in state.streams.drain() {
            stream.end.cancel();
        }
        for (_, answer) in state.opens.drain() {
            let _ = answer.send(Err("disconnected".into()));
        }
        state.early.clear();
    }

    /// The connection is gone for good: listeners too.
    /// Close every listener and stream. The connection itself is untouched.
    pub fn shutdown(&self) {
        self.drop_streams();
        let mut state = self.inner.state.lock().unwrap();
        for (_, listening) in state.forwards.drain() {
            listening.stop.cancel();
        }
        state.scope = None;
    }

    pub fn forwards(&self) -> Vec<Forward> {
        let mut forwards: Vec<Forward> = self.inner.state.lock().unwrap().forwards.values().map(|listening| listening.forward.clone()).collect();
        forwards.sort_by_key(|forward| forward.port);
        forwards
    }

    /// Listen on this Mac's loopback for `port` of the workspace. Asking
    /// again for a port already forwarded returns the same forward. The
    /// local port is a random free one unless `local` names one; when that
    /// one is taken by any program on any address, a random one is used and
    /// the forward says so, unless `exact`, which refuses instead. `scope`
    /// is the active organization, which the forward does not outlive.
    /// Never wakes the workspace: a connection that is not live is refused.
    pub async fn forward(&self, port: u16, local: Option<u16>, exact: bool, scope: Option<String>) -> Result<Forward, String> {
        if port == 0 {
            return Err("cloud_port_invalid".into());
        }
        if let Some(listening) = self.inner.state.lock().unwrap().forwards.get(&port) {
            return Ok(listening.forward.clone());
        }
        if !self.inner.ready.load(Ordering::SeqCst) {
            return Err("cloud_port_not_connected".into());
        }
        let (listener, reassigned) = bind(local.filter(|local| *local != 0), exact)?;
        let local_port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let forward = Forward { port, local_port, reassigned };
        let stop = CancellationToken::new();
        {
            let mut state = self.inner.state.lock().unwrap();
            // Two requests for the same port raced: the first one stands.
            if let Some(listening) = state.forwards.get(&port) {
                return Ok(listening.forward.clone());
            }
            // Read again under the lock that a disconnect takes to close
            // everything: a forward made here cannot outlive it. (The
            // listener is dropped on return.)
            if !self.inner.ready.load(Ordering::SeqCst) {
                return Err("cloud_port_not_connected".into());
            }
            if state.scope.is_none() {
                state.scope = scope;
            }
            state.forwards.insert(port, Listening { forward: forward.clone(), stop: stop.clone() });
        }
        let forwarder = self.clone();
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = stop.cancelled() => return,
                    accepted = listener.accept() => accepted,
                };
                let Ok((socket, _)) = accepted else { continue };
                // Over the limit, a connection is closed, not queued.
                if forwarder.inner.carried.fetch_add(1, Ordering::SeqCst) >= MAX_LOCAL_CONNECTIONS {
                    forwarder.inner.carried.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let forwarder = forwarder.clone();
                tokio::spawn(async move {
                    forwarder.serve(socket, port, local_port).await;
                    forwarder.inner.carried.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        Ok(forward)
    }

    /// Stop forwarding `port`: the listener closes, and so does every
    /// connection it was carrying.
    pub fn unforward(&self, port: u16) -> bool {
        let closed: Vec<String> = {
            let mut state = self.inner.state.lock().unwrap();
            let Some(listening) = state.forwards.remove(&port) else { return false };
            listening.stop.cancel();
            let ids: Vec<String> = state.streams.iter().filter(|(_, stream)| stream.port == port).map(|(id, _)| id.clone()).collect();
            for id in &ids {
                if let Some(stream) = state.streams.remove(id) {
                    stream.end.cancel();
                }
            }
            ids
        };
        for stream_id in closed {
            (self.inner.send)(json!({ "id": self.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
        }
        true
    }

    /// One local connection, carried as one stream.
    ///
    /// The client's first bytes are judged before any of them is forwarded,
    /// whenever they arrive: an HTTP request that does not name this
    /// loopback listener is refused (see [`judge`]). A client that says
    /// nothing at first gets its stream anyway after [`SILENT_OPEN`], so a
    /// protocol whose server speaks first works; what the client then sends
    /// is still judged before it goes anywhere.
    async fn serve(&self, mut socket: TcpStream, port: u16, local_port: u16) {
        if !self.inner.ready.load(Ordering::SeqCst) {
            answer_and_close(&mut socket, &page("503 Service Unavailable", STOPPED)).await;
            return;
        }
        let foreign = page("403 Forbidden", &format!("This preview is only served at http://127.0.0.1:{local_port}. The request named another host and was refused."));
        let mut head = Vec::new();
        let verdict = match tokio::time::timeout(SILENT_OPEN, judge(&mut socket, &mut head, local_port)).await {
            Ok(verdict) => Some(verdict),
            // Bytes have begun to arrive: they are judged before anything else happens.
            Err(_) if !head.is_empty() => Some(judge(&mut socket, &mut head, local_port).await),
            Err(_) => None,
        };
        match verdict {
            Some(Verdict::Refuse) => {
                answer_and_close(&mut socket, &foreign).await;
                return;
            }
            Some(Verdict::Closed) => return,
            Some(Verdict::Carry) | None => {}
        }
        let judged = verdict.is_some();
        let request = self.id("open");
        let (answer, answered) = oneshot::channel();
        let epoch = {
            let mut state = self.inner.state.lock().unwrap();
            state.opens.insert(request.clone(), answer);
            state.epoch
        };
        let sent = (self.inner.send)(json!({ "id": request, "method": "ports.open", "params": { "port": port } }));
        let opened = if sent { tokio::time::timeout(OPEN_TIMEOUT, answered).await.ok().and_then(Result::ok) } else { None };
        self.inner.state.lock().unwrap().opens.remove(&request);
        let opened = match opened {
            Some(Ok(opened)) => opened,
            Some(Err(code)) if code != "disconnected" => {
                let (status, message) = refusal(&code, port);
                answer_and_close(&mut socket, &page(status, &message)).await;
                return;
            }
            _ => {
                answer_and_close(&mut socket, &page("503 Service Unavailable", STOPPED)).await;
                return;
            }
        };
        let Some(stream_id) = opened.get("streamId").and_then(Value::as_str).map(str::to_string) else { return };
        // The runtime names its window; it is never taken as larger than ours.
        let window = opened.get("window").and_then(Value::as_u64).map(|window| window as usize).filter(|window| *window >= CHUNK).unwrap_or(DEFAULT_WINDOW).min(DEFAULT_WINDOW);
        let (to_local, mut from_runtime) = mpsc::unbounded_channel::<Vec<u8>>();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let queued = Arc::new(AtomicUsize::new(0));
        let drained = Arc::new(Notify::new());
        let end = CancellationToken::new();
        let registered = {
            let mut state = self.inner.state.lock().unwrap();
            if state.epoch != epoch {
                // The connection was lost between the answer and here: the
                // stream died with it, and the local side just ends.
                None
            } else if !state.forwards.contains_key(&port) {
                // The forward was stopped meanwhile: the stream is given back.
                state.early.remove(&stream_id);
                Some(false)
            } else {
                // What the runtime sent before its answer was read.
                let early = state.early.remove(&stream_id).unwrap_or_default();
                for data in early.data {
                    queued.fetch_add(data.len(), Ordering::SeqCst);
                    let _ = to_local.send(data);
                }
                if early.closed {
                    // The sender is dropped: what came is delivered, then the end.
                    end.cancel();
                } else {
                    state.streams.insert(stream_id.clone(), Stream { port, to_local, queued: queued.clone(), in_flight: in_flight.clone(), drained: drained.clone(), end: end.clone() });
                }
                Some(true)
            }
        };
        match registered {
            None => return,
            Some(false) => {
                (self.inner.send)(json!({ "id": self.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
                return;
            }
            Some(true) => {}
        }
        let (mut reader, mut writer) = socket.into_split();
        let down = {
            let (forwarder, stream_id, end) = (self.clone(), stream_id.clone(), end.clone());
            async move {
                loop {
                    let data = tokio::select! {
                        _ = end.cancelled() => {
                            // Whatever the runtime sent before it closed is still delivered.
                            while let Ok(data) = from_runtime.try_recv() {
                                if writer.write_all(&data).await.is_err() { break; }
                            }
                            break;
                        }
                        data = from_runtime.recv() => match data { Some(data) => data, None => break },
                    };
                    if writer.write_all(&data).await.is_err() {
                        break;
                    }
                    release(&queued, data.len());
                    // Only what the local side has taken is acknowledged.
                    (forwarder.inner.send)(json!({ "id": forwarder.id("ack"), "method": "ports.ack", "params": { "streamId": stream_id, "bytes": data.len() } }));
                }
                writer
            }
        };
        let up = {
            let (forwarder, stream_id, end) = (self.clone(), stream_id.clone(), end.clone());
            async move {
                // True when the client's first bytes turned out to be a request for another host.
                let refused = async {
                    // Judged bytes not yet sent on; read from the socket only once it is empty.
                    let mut backlog = head;
                    if !judged {
                        let verdict = tokio::select! {
                            _ = end.cancelled() => return false,
                            verdict = judge(&mut reader, &mut backlog, local_port) => verdict,
                        };
                        match verdict {
                            Verdict::Carry => {}
                            Verdict::Refuse => return true,
                            Verdict::Closed => return false,
                        }
                    }
                    let mut buffer = vec![0u8; CHUNK];
                    loop {
                        // Send only what the runtime has room for.
                        loop {
                            let freed = drained.notified();
                            if in_flight.load(Ordering::SeqCst) + CHUNK <= window {
                                break;
                            }
                            tokio::select! {
                                _ = end.cancelled() => return false,
                                _ = freed => {}
                            }
                        }
                        let count = if backlog.is_empty() {
                            let read = tokio::select! {
                                _ = end.cancelled() => return false,
                                read = reader.read(&mut buffer) => read,
                            };
                            match read {
                                Ok(count) if count > 0 => count,
                                _ => return false,
                            }
                        } else {
                            let count = backlog.len().min(CHUNK);
                            buffer[..count].copy_from_slice(&backlog[..count]);
                            backlog.drain(..count);
                            count
                        };
                        in_flight.fetch_add(count, Ordering::SeqCst);
                        let frame = json!({
                            "id": format!("{REQUEST_PREFIX}write-{stream_id}-{}", forwarder.inner.next.fetch_add(1, Ordering::Relaxed)),
                            "method": "ports.write",
                            "params": { "streamId": stream_id, "data": general_purpose::STANDARD.encode(&buffer[..count]) },
                        });
                        if !(forwarder.inner.send)(frame) {
                            return false;
                        }
                    }
                }
                .await;
                // The local side is done: so is the stream.
                if forwarder.inner.state.lock().unwrap().streams.remove(&stream_id).is_some() {
                    (forwarder.inner.send)(json!({ "id": forwarder.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
                }
                end.cancel();
                (reader, refused)
            }
        };
        let (writer, (reader, refused)) = tokio::join!(down, up);
        self.inner.state.lock().unwrap().streams.remove(&stream_id);
        if let Ok(mut socket) = reader.reunite(writer) {
            if refused {
                answer_and_close(&mut socket, &foreign).await;
            } else {
                let _ = socket.shutdown().await;
            }
        }
    }

    /// A message from the runtime. True when it was the forwarder's: an
    /// answer to one of its requests or a `ports.*` notification, neither of
    /// which goes to the web view.
    pub fn on_message(&self, message: &Value) -> bool {
        if let Some(id) = message.get("id").and_then(Value::as_str).filter(|id| id.starts_with(REQUEST_PREFIX)) {
            let ok = message.get("ok").and_then(Value::as_bool) == Some(true);
            let mut state = self.inner.state.lock().unwrap();
            if let Some(answer) = state.opens.remove(id) {
                let result = if ok {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(message.pointer("/error/code").and_then(Value::as_str).unwrap_or("unknown").to_string())
                };
                // Nobody is waiting any more (the local side gave up): the
                // stream the runtime opened is closed again.
                if let Err(Ok(opened)) = answer.send(result) {
                    if let Some(stream_id) = opened.get("streamId").and_then(Value::as_str) {
                        state.early.remove(stream_id);
                        drop(state);
                        (self.inner.send)(json!({ "id": self.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
                    }
                }
            } else if !ok {
                // A write the runtime refused ends its stream.
                let stream = id.strip_prefix(REQUEST_PREFIX).and_then(|rest| rest.strip_prefix("write-")).and_then(|rest| rest.rsplit_once('-')).map(|(stream, _)| stream.to_string());
                if let Some(stream) = stream.and_then(|stream| state.streams.remove(&stream)) {
                    stream.end.cancel();
                }
            }
            return true;
        }
        let Some(event) = message.get("event").and_then(Value::as_str).filter(|event| event.starts_with("ports.")) else { return false };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let Some(stream_id) = params.get("streamId").and_then(Value::as_str) else { return true };
        let mut state = self.inner.state.lock().unwrap();
        match event {
            "ports.data" => {
                let Some(data) = params.get("data").and_then(Value::as_str).and_then(|data| general_purpose::STANDARD.decode(data).ok()) else { return true };
                if let Some(stream) = state.streams.get(stream_id) {
                    // The runtime sends no more than a window unacknowledged.
                    // One that does is not buffered for: its stream ends.
                    if stream.queued.fetch_add(data.len(), Ordering::SeqCst) + data.len() > 2 * DEFAULT_WINDOW {
                        if let Some(stream) = state.streams.remove(stream_id) {
                            stream.end.cancel();
                        }
                        drop(state);
                        (self.inner.send)(json!({ "id": self.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
                        return true;
                    }
                    let _ = stream.to_local.send(data);
                } else if state.early.len() < MAX_EARLY_STREAMS || state.early.contains_key(stream_id) {
                    let early = state.early.entry(stream_id.to_string()).or_default();
                    // Bounded by the runtime's own window: it sends no more unacknowledged.
                    if early.data.iter().map(Vec::len).sum::<usize>() + data.len() <= DEFAULT_WINDOW {
                        early.data.push(data);
                    }
                }
            }
            "ports.drained" => {
                if let Some(stream) = state.streams.get(stream_id) {
                    let bytes = params.get("bytes").and_then(Value::as_u64).unwrap_or(0) as usize;
                    // Never below zero: a report cannot mint credit.
                    release(&stream.in_flight, bytes);
                    stream.drained.notify_one();
                }
            }
            "ports.closed" => {
                if let Some(stream) = state.streams.remove(stream_id) {
                    stream.end.cancel();
                } else if let Some(early) = state.early.get_mut(stream_id) {
                    early.closed = true;
                } else if state.early.len() < MAX_EARLY_STREAMS {
                    state.early.insert(stream_id.to_string(), Early { data: Vec::new(), closed: true });
                }
            }
            _ => {}
        }
        true
    }
}

/// Send `answer`, then close without a reset: what the client already sent
/// is read and dropped first, because closing a socket with unread data
/// resets it and the client would never see the answer.
async fn answer_and_close(socket: &mut TcpStream, answer: &[u8]) {
    if socket.write_all(answer).await.is_err() {
        return;
    }
    let _ = socket.shutdown().await;
    let mut sink = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
    while let Ok(Ok(count)) = tokio::time::timeout_at(deadline, socket.read(&mut sink)).await {
        if count == 0 {
            break;
        }
    }
}

/// Take up to `bytes` off `counter`.
fn release(counter: &AtomicUsize, bytes: usize) {
    let mut current = counter.load(Ordering::SeqCst);
    while let Err(actual) = counter.compare_exchange(current, current.saturating_sub(bytes), Ordering::SeqCst, Ordering::SeqCst) {
        current = actual;
    }
}

/// Listen on `127.0.0.1:port` (0: any free port) **without address reuse**.
/// tokio's `TcpListener::bind` sets `SO_REUSEADDR`, and on macOS that lets a
/// loopback bind succeed while another program listens on the wildcard
/// address of the same port; the new socket then takes that program's
/// loopback traffic.
fn listen_on(port: u16) -> std::io::Result<TcpListener> {
    let socket = TcpSocket::new_v4()?;
    socket.bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))?;
    socket.listen(128)
}

/// Whether another program already listens on `port` on an address that a
/// browser's `localhost`, or loopback traffic, could reach: the IPv4
/// wildcard, IPv6 loopback or the IPv6 wildcard.
fn taken_elsewhere(port: u16) -> bool {
    let in_use = |socket: std::io::Result<TcpSocket>, address: SocketAddr| {
        socket.and_then(|socket| socket.bind(address)).is_err_and(|error| error.kind() == std::io::ErrorKind::AddrInUse)
    };
    in_use(TcpSocket::new_v4(), SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
        || in_use(TcpSocket::new_v6(), SocketAddr::from((Ipv6Addr::LOCALHOST, port)))
        || in_use(TcpSocket::new_v6(), SocketAddr::from((Ipv6Addr::UNSPECIFIED, port)))
}

/// A loopback listener: on a random free port, or on `wanted` when one is
/// named and no program has it on any address. A taken `wanted` is refused
/// when `exact`, else a random port is used and the answer says so.
fn bind(wanted: Option<u16>, exact: bool) -> Result<(TcpListener, bool), String> {
    let random = || listen_on(0).map_err(|_| "cloud_port_in_use".to_string());
    let Some(wanted) = wanted else { return random().map(|listener| (listener, false)) };
    if !taken_elsewhere(wanted) {
        if let Ok(listener) = listen_on(wanted) {
            return Ok((listener, false));
        }
    }
    if exact {
        return Err("cloud_port_in_use".into());
    }
    random().map(|listener| (listener, true))
}

/// What the client's first bytes are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// Not HTTP, or an HTTP request that names this loopback listener.
    Carry,
    /// An HTTP request that names another host, or none.
    Refuse,
    /// The client hung up, or stopped mid-request, before it could be told.
    Closed,
}

/// Read the client's first bytes into `head` until they can be judged, and
/// judge them. Nothing read here has been forwarded: on [`Verdict::Carry`]
/// `head` holds every byte read, to be sent on first.
///
/// This is what stops DNS rebinding: a web page that points a hostname of
/// its own at 127.0.0.1 has the browser send that hostname as `Host`, and
/// such a request never reaches the workspace. It waits for the bytes
/// however late they come (a browser may connect first and send later), so
/// it cannot be outwaited. A caller may cancel it while `head` is still
/// empty and call it again later.
async fn judge<R: tokio::io::AsyncRead + Unpin>(reader: &mut R, head: &mut Vec<u8>, local_port: u16) -> Verdict {
    let mut buffer = [0u8; 4096];
    loop {
        if let Some(verdict) = classify(head, local_port) {
            return verdict;
        }
        if head.len() >= MAX_HEAD_BYTES {
            return Verdict::Refuse;
        }
        // An empty head waits as long as the client stays silent; a request
        // that has begun must keep coming.
        let read = if head.is_empty() { Ok(reader.read(&mut buffer).await) } else { tokio::time::timeout(HEAD_TIMEOUT, reader.read(&mut buffer)).await };
        match read {
            Ok(Ok(count)) if count > 0 => head.extend_from_slice(&buffer[..count]),
            _ => return Verdict::Closed,
        }
    }
}

/// Judge `head` if it is enough to judge: `None` while more bytes are needed.
fn classify(head: &[u8], local_port: u16) -> Option<Verdict> {
    match request_line(head)? {
        false => Some(Verdict::Carry),
        true => {
            // The whole head is needed: `Host` may be its last line.
            let end = head.windows(4).position(|window| window == b"\r\n\r\n").map(|at| at + 2).or_else(|| head.windows(2).position(|window| window == b"\n\n").map(|at| at + 1))?;
            Some(if names_this_listener(&head[..end], local_port) { Verdict::Carry } else { Verdict::Refuse })
        }
    }
}

/// Whether `head` starts with an HTTP request line, `<token> <target>
/// HTTP/<version>`, whatever the method: `Some(true)` or `Some(false)` once
/// that can be told, `None` while the first line is still arriving and could
/// yet be one.
fn request_line(head: &[u8]) -> Option<bool> {
    // RFC 9110 token characters.
    let token = |byte: u8| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte);
    if head.is_empty() {
        return None;
    }
    let Some(end) = head.iter().position(|byte| *byte == b'\n') else {
        // No line end yet. It can still become a request line only if every
        // byte so far fits one: a method, then printable characters. However
        // long the method or the line: a page chooses both, and a line that
        // is called "not HTTP" before its end is forwarded with its `Host`
        // unread. It stays undecided until its line end, or until the head
        // is too long and is refused.
        let method_end = head.iter().position(|byte| *byte == b' ');
        let method = &head[..method_end.unwrap_or(head.len())];
        let rest = method_end.map_or(&[][..], |at| &head[at..]);
        let plausible = method.iter().all(|byte| token(*byte)) && rest.iter().all(|byte| (0x20..0x7f).contains(byte) || *byte == b'\r');
        return if plausible { None } else { Some(false) };
    };
    let line = head[..end].strip_suffix(b"\r").unwrap_or(&head[..end]);
    let mut parts = line.split(|byte| *byte == b' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Some(false) };
    Some(!method.is_empty() && method.iter().all(|byte| token(*byte)) && !target.is_empty() && version.starts_with(b"HTTP/"))
}

/// Whether a complete request head names this listener by a loopback name
/// in every `Host` line it has, and has at least one.
fn names_this_listener(head: &[u8], local_port: u16) -> bool {
    let text = String::from_utf8_lossy(head);
    let port = local_port.to_string();
    let mut hosts = text.split('\n').skip(1).filter_map(|line| line.trim_end_matches('\r').split_once(':')).filter(|(name, _)| name.trim().eq_ignore_ascii_case("host")).map(|(_, value)| value.trim().to_ascii_lowercase()).peekable();
    hosts.peek().is_some() && hosts.all(|value| ["127.0.0.1", "localhost", "[::1]"].iter().any(|host| value == format!("{host}:{port}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A forwarder whose requests land in a channel, as the runtime would see them.
    fn forwarder() -> (PortForwarder, mpsc::UnboundedReceiver<Value>) {
        let (sent, requests) = mpsc::unbounded_channel();
        let forwarder = PortForwarder::new(move |frame| sent.send(frame).is_ok());
        forwarder.set_connected(Some(&["ports/1".to_string()]));
        (forwarder, requests)
    }

    async fn next(requests: &mut mpsc::UnboundedReceiver<Value>, method: &str) -> Value {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(20), requests.recv()).await.expect("a request").expect("open channel");
            if frame["method"] == method {
                return frame;
            }
        }
    }

    fn b64(bytes: &[u8]) -> String {
        general_purpose::STANDARD.encode(bytes)
    }

    async fn read_all(socket: &mut TcpStream) -> String {
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(20), socket.read_to_string(&mut text)).await.expect("the connection ends").unwrap();
        text
    }

    async fn connect(local: u16) -> TcpStream {
        TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.unwrap()
    }

    fn get(local: u16) -> Vec<u8> {
        format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{local}\r\n\r\n").into_bytes()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_local_connection_becomes_a_stream_and_bytes_go_both_ways() {
        let (forwarder, mut requests) = forwarder();
        // A random free local port by default: not the workspace's number.
        let forward = forwarder.forward(3000, None, false, None).await.unwrap();
        assert!(!forward.reassigned && forward.local_port != 0 && forward.local_port != 3000, "{forward:?}");
        let local = forward.local_port;
        // Asking again is the same forward, not a second listener.
        assert_eq!(forwarder.forward(3000, None, false, None).await.unwrap(), forward);
        assert_eq!(forwarder.forwards(), vec![forward]);

        let mut browser = connect(local).await;
        browser.write_all(&get(local)).await.unwrap();
        let open = next(&mut requests, "ports.open").await;
        assert_eq!(open["params"], json!({ "port": 3000 }));
        // The runtime's data can overtake its answer: nothing is lost.
        assert!(forwarder.on_message(&json!({ "event": "ports.data", "params": { "streamId": "port-1", "data": b64(b"HTTP/1.1 200 OK\r\n\r\n") } })));
        assert!(forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1", "window": 262144 } })));
        assert!(forwarder.on_message(&json!({ "event": "ports.data", "params": { "streamId": "port-1", "data": b64(b"hello") } })));
        let mut response = [0u8; 24];
        browser.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"HTTP/1.1 200 OK\r\n\r\nhello");
        // The request the browser sent arrives whole (the host check only
        // peeked), and what the browser took is acknowledged byte for byte.
        let (mut written, mut acked) = (None, 0);
        while written.is_none() || acked < 24 {
            let frame = tokio::time::timeout(Duration::from_secs(20), requests.recv()).await.expect("a request").unwrap();
            match frame["method"].as_str() {
                Some("ports.write") => written = Some(frame["params"].clone()),
                Some("ports.ack") => acked += frame["params"]["bytes"].as_u64().unwrap(),
                _ => {}
            }
        }
        assert_eq!(written.unwrap(), json!({ "streamId": "port-1", "data": b64(&get(local)) }));
        assert_eq!(acked, 24);

        // The application hangs up: so does the local connection.
        assert!(forwarder.on_message(&json!({ "event": "ports.closed", "params": { "streamId": "port-1", "reason": "eof" } })));
        assert_eq!(read_all(&mut browser).await, "");
        // Neither answers nor port events are anyone else's.
        assert!(!forwarder.on_message(&json!({ "event": "pty.output", "params": {} })));
        assert!(!forwarder.on_message(&json!({ "id": "42", "ok": true, "result": {} })));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_browser_closing_closes_the_stream() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        let browser = connect(local).await;
        let open = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-7" } }));
        drop(browser);
        assert_eq!(next(&mut requests, "ports.close").await["params"], json!({ "streamId": "port-7" }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_that_names_another_host_is_refused_and_never_reaches_the_workspace() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        // What DNS rebinding looks like: the page's own hostname, aimed at 127.0.0.1.
        for host in ["attacker.example".to_string(), format!("attacker.example:{local}"), "127.0.0.1:1".to_string()] {
            let mut browser = connect(local).await;
            browser.write_all(format!("GET /secret HTTP/1.1\r\nHost: {host}\r\nAccept: */*\r\n\r\n").as_bytes()).await.unwrap();
            let page = read_all(&mut browser).await;
            assert!(page.starts_with("HTTP/1.1 403 ") && page.contains("X-Content-Type-Options: nosniff"), "{host}: {page}");
        }
        // A request with no Host at all is refused too.
        let mut browser = connect(local).await;
        browser.write_all(b"GET / HTTP/1.1\r\nAccept: */*\r\n\r\n").await.unwrap();
        assert!(read_all(&mut browser).await.starts_with("HTTP/1.1 403 "));
        assert!(requests.try_recv().is_err(), "nothing was asked of the workspace");

        // The loopback names are served, whatever the case of the header.
        for host in [format!("127.0.0.1:{local}"), format!("localhost:{local}")] {
            let mut browser = connect(local).await;
            browser.write_all(format!("POST /x HTTP/1.1\r\nhOsT: {host}\r\n\r\n").as_bytes()).await.unwrap();
            let open = next(&mut requests, "ports.open").await;
            forwarder.on_message(&json!({ "id": open["id"], "ok": false, "error": { "code": "port_unreachable" } }));
            assert!(read_all(&mut browser).await.starts_with("HTTP/1.1 502 "));
        }
        // Not HTTP (a database client, say), or a server that speaks first: carried as it is.
        let mut client = connect(local).await;
        client.write_all(&[0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]).await.unwrap();
        assert_eq!(next(&mut requests, "ports.open").await["params"], json!({ "port": 3000 }));
        let _silent = connect(local).await;
        assert_eq!(next(&mut requests, "ports.open").await["params"], json!({ "port": 3000 }));

    }

    #[test]
    fn the_first_bytes_are_judged_as_http_by_shape_not_by_a_list_of_methods() {
        let carry = Some(Verdict::Carry);
        let refuse = Some(Verdict::Refuse);
        // Any method token is a request, and needs a Host that is this listener.
        for method in ["GET", "PROPFIND", "QUERY", "M-SEARCH", "x"] {
            assert_eq!(classify(format!("{method} / HTTP/1.1\r\nHost: 127.0.0.1:80\r\n\r\n").as_bytes(), 80), carry, "{method}");
            assert_eq!(classify(format!("{method} / HTTP/1.1\r\nHost: evil.example\r\n\r\n").as_bytes(), 80), refuse, "{method}");
        }
        assert_eq!(classify(b"GET / HTTP/1.0\r\n\r\n", 80), refuse, "no Host at all");
        assert_eq!(classify(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", 80), refuse);
        assert_eq!(classify(b"GET / HTTP/1.1\nHost: localhost:80\n\n", 80), carry, "bare line feeds");
        // Two Host lines: both must be this listener.
        assert_eq!(classify(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:80\r\nHost: evil.example\r\n\r\n", 80), refuse);
        assert_eq!(classify(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:81\r\n\r\n", 80), refuse, "another port is another origin");
        // Still arriving: not judged, and so not forwarded, yet.
        for partial in [&b""[..], b"G", b"PROPFIND /x", b"GET / HTTP/1.1\r\n", b"GET / HTTP/1.1\r\nHost: 127.0.0.1:80\r\n"] {
            assert_eq!(classify(partial, 80), None, "{:?}", String::from_utf8_lossy(partial));
        }
        // A method or a first line of any length is still a request line in
        // the making: what fetch('/' + 'a'.repeat(5000), { method: 'A'.repeat(65) })
        // sends has no line end in its first read.
        let long_method = "A".repeat(65);
        assert_eq!(classify(format!("{long_method} /x").as_bytes(), 80), None);
        assert_eq!(classify("A".repeat(4096).as_bytes(), 80), None);
        let long_line = format!("{long_method} /{}", "a".repeat(5000));
        assert_eq!(classify(long_line.as_bytes(), 80), None);
        assert_eq!(classify(format!("{long_line} HTTP/1.1\r\nHost: attacker.example\r\n\r\n").as_bytes(), 80), refuse);
        assert_eq!(classify(format!("{long_line} HTTP/1.1\r\nHost: 127.0.0.1:80\r\n\r\n").as_bytes(), 80), carry);
        // Not HTTP: carried as it is.
        for other in [&b"SSH-2.0-OpenSSH\r\n"[..], b"\x16\x03\x01\x02\x00", b"\x00\x00\x00\x08\x04\xd2\x16\x2f", b"HELO there\r\n", b"GET /\r\n"] {
            assert_eq!(classify(other, 80), carry, "{:?}", String::from_utf8_lossy(other));
        }
    }

    #[tokio::test]
    async fn a_first_line_that_never_ends_is_refused_not_carried() {
        // Read in 4096-byte pieces, as from a socket: undecided all the way to the cap.
        let endless = format!("{} /{}", "A".repeat(65), "a".repeat(2 * MAX_HEAD_BYTES));
        let mut head = Vec::new();
        assert_eq!(judge(&mut endless.as_bytes(), &mut head, 80).await, Verdict::Refuse);
        assert!(head.len() >= MAX_HEAD_BYTES);
        // The same request with its end and a foreign Host, arriving whole.
        let request = format!("{} /{} HTTP/1.1\r\nHost: attacker.example\r\n\r\n", "A".repeat(65), "a".repeat(5000));
        let mut head = Vec::new();
        assert_eq!(judge(&mut request.as_bytes(), &mut head, 80).await, Verdict::Refuse);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_that_comes_late_or_in_pieces_is_judged_before_any_of_it_is_forwarded() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        // A browser can connect first and send later (a preconnect). The
        // stream opens for a silent client, but its request is still judged.
        let mut browser = connect(local).await;
        let open = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1" } }));
        tokio::time::sleep(SILENT_OPEN + Duration::from_millis(300)).await;
        browser.write_all(b"GET /secret HTTP/1.1\r\nHost: attacker.example\r\n\r\n").await.unwrap();
        let page = read_all(&mut browser).await;
        assert!(page.starts_with("HTTP/1.1 403 "), "{page}");
        // The stream is given back, and not one byte of the request went to the workspace.
        let mut closed = false;
        while let Ok(Some(frame)) = tokio::time::timeout(Duration::from_millis(500), requests.recv()).await {
            assert_ne!(frame["method"], "ports.write", "a refused request was forwarded");
            closed |= frame["method"] == "ports.close";
        }
        assert!(closed);

        // The long method and long path a page can choose, with its own Host:
        // refused, and nothing is asked of the workspace.
        let mut browser = connect(local).await;
        browser.write_all(format!("{} /{} HTTP/1.1\r\nHost: attacker.example\r\n\r\n", "A".repeat(65), "a".repeat(5000)).as_bytes()).await.unwrap();
        assert!(read_all(&mut browser).await.starts_with("HTTP/1.1 403 "));
        assert!(requests.try_recv().is_err(), "a long request line was carried unjudged");

        // In pieces, with the Host last: nothing is asked of the workspace until the head is whole.
        let mut browser = connect(local).await;
        browser.write_all(b"PROPFIND /dav HTTP/1.1\r\nDepth: 1\r\n").await.unwrap();
        assert!(tokio::time::timeout(SILENT_OPEN + Duration::from_millis(300), requests.recv()).await.is_err(), "opened before the request was judged");
        browser.write_all(b"Host: attacker.example\r\n\r\n").await.unwrap();
        assert!(read_all(&mut browser).await.starts_with("HTTP/1.1 403 "));
        assert!(requests.try_recv().is_err());

        // The same late request for this listener is carried whole.
        let mut browser = connect(local).await;
        let open = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-2" } }));
        tokio::time::sleep(Duration::from_millis(100)).await;
        browser.write_all(&get(local)).await.unwrap();
        assert_eq!(next(&mut requests, "ports.write").await["params"], json!({ "streamId": "port-2", "data": b64(&get(local)) }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_a_forward_closes_its_connections_and_a_window_is_never_taken_as_larger_than_ours() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        let mut browser = connect(local).await;
        let open = next(&mut requests, "ports.open").await;
        // A runtime that claims an enormous window.
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1", "window": 1_000_000_000u64 } }));
        let (mut reader, mut writer) = browser.split();
        let upload = async {
            let _ = writer.write_all(&vec![5u8; 4 * DEFAULT_WINDOW]).await;
        };
        let counted = async {
            let mut sent = 0usize;
            while let Ok(Some(frame)) = tokio::time::timeout(Duration::from_millis(1500), requests.recv()).await {
                if frame["method"] == "ports.write" {
                    sent += general_purpose::STANDARD.decode(frame["params"]["data"].as_str().unwrap()).unwrap().len();
                }
            }
            sent
        };
        let sent = tokio::select! {
            sent = counted => sent,
            _ = async { upload.await; std::future::pending::<()>().await } => unreachable!(),
        };
        assert!(sent > 0 && sent <= DEFAULT_WINDOW, "{sent} bytes sent with nothing drained");

        // Stop the forward: the open connection ends and its stream is closed.
        assert!(forwarder.unforward(3000));
        assert_eq!(next(&mut requests, "ports.close").await["params"], json!({ "streamId": "port-1" }));
        let mut rest = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(20), reader.read_to_end(&mut rest)).await.expect("the connection is closed");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn when_the_workspace_stops_or_access_goes_everything_closes_and_nothing_comes_back() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        let mut browser = connect(local).await;
        let open = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1" } }));
        // Suspended, access revoked, the relay gone: the same to the desktop.
        forwarder.set_connected(None);
        assert_eq!(read_all(&mut browser).await, "");
        assert!(forwarder.forwards().is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.is_err(), "the listener is closed");
        // A new forward is not made on a connection that is not live.
        assert_eq!(forwarder.forward(4000, None, false, None).await.unwrap_err(), "cloud_port_not_connected");
        // The workspace comes back: the forward does not. The person opens it again.
        forwarder.set_connected(Some(&["ports/1".to_string()]));
        assert!(forwarder.forwards().is_empty());
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.is_err());
        // A runtime that does not serve ports is not asked.
        forwarder.set_connected(Some(&["pty/1".to_string()]));
        assert_eq!(forwarder.forward(4000, None, false, None).await.unwrap_err(), "cloud_port_not_connected");
        while requests.try_recv().is_ok() {}
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_forward_does_not_outlive_a_switch_of_the_active_organization() {
        let (forwarder, _requests) = forwarder();
        let local = forwarder.forward(3000, None, false, Some("org-a".into())).await.unwrap().local_port;
        forwarder.keep_scope(Some("org-a"));
        assert_eq!(forwarder.forwards().len(), 1);
        forwarder.keep_scope(Some("org-b"));
        assert!(forwarder.forwards().is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.is_err());
        // The connection is still live: a preview can be opened again, under the new organization.
        assert!(forwarder.forward(3000, None, false, Some("org-b".into())).await.is_ok());
        forwarder.keep_scope(None);
        assert!(forwarder.forwards().is_empty(), "signed out: nothing is kept");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refusal_is_explained_to_the_browser() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        for (code, status, words) in [
            ("port_unreachable", "502", "Nothing in the cloud workspace is listening on port 3000"),
            ("forbidden", "403", "driver who may approve"),
            ("<script>alert(1)</script>", "502", "could not open port 3000."),
        ] {
            let mut browser = connect(local).await;
            let open = next(&mut requests, "ports.open").await;
            forwarder.on_message(&json!({ "id": open["id"], "ok": false, "error": { "code": code, "message": "raw server words" } }));
            let page = read_all(&mut browser).await;
            assert!(page.starts_with(&format!("HTTP/1.1 {status} ")) && page.contains(words), "{page}");
            assert!(!page.contains("raw server words") && !page.contains("<script>") && page.contains("nosniff"));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_named_local_port_another_program_has_on_any_address_is_never_shared() {
        let (forwarder, _requests) = forwarder();
        // Another program listens on the wildcard address, with address reuse
        // as most servers set it. A loopback bind that also reuses the
        // address would succeed on macOS and take its loopback traffic.
        let other = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.unwrap();
        let wanted = other.local_addr().unwrap().port();
        assert_eq!(forwarder.forward(3000, Some(wanted), true, None).await.unwrap_err(), "cloud_port_in_use");
        assert!(forwarder.forwards().is_empty());
        let forward = forwarder.forward(3000, Some(wanted), false, None).await.unwrap();
        assert!(forward.reassigned && forward.local_port != wanted, "{forward:?}");
        // The other program still gets its own connections.
        let reached = tokio::spawn(async move { other.accept().await.is_ok() });
        TcpStream::connect((Ipv4Addr::LOCALHOST, wanted)).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(10), reached).await.unwrap().unwrap());

        // The same for one on IPv6 loopback, where a browser's `localhost` may go first.
        if let Ok(six) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await {
            let wanted = six.local_addr().unwrap().port();
            assert_eq!(forwarder.forward(4000, Some(wanted), true, None).await.unwrap_err(), "cloud_port_in_use");
        }
        // Two workspaces' forwarders never share a listener either.
        let (second, _second_requests) = self::forwarder();
        assert_eq!(second.forward(3000, Some(forward.local_port), true, None).await.unwrap_err(), "cloud_port_in_use");
        // A free named port is used as asked.
        let free = listen_on(0).unwrap().local_addr().unwrap().port();
        assert_eq!(second.forward(5000, Some(free), true, None).await.unwrap(), Forward { port: 5000, local_port: free, reassigned: false });
        assert!(forwarder.unforward(3000));
        assert!(!forwarder.unforward(3000));
        assert_eq!(forwarder.forward(0, None, false, None).await.unwrap_err(), "cloud_port_invalid");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_local_side_is_read_only_as_fast_as_the_runtime_drains() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        let mut browser = connect(local).await;
        let upload = tokio::spawn(async move {
            let _ = browser.write_all(&vec![5u8; 8 * CHUNK]).await;
            browser
        });
        let open = next(&mut requests, "ports.open").await;
        let window = 2 * CHUNK;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1", "window": window } }));
        let mut sent = 0usize;
        while let Ok(Some(frame)) = tokio::time::timeout(Duration::from_millis(1500), requests.recv()).await {
            if frame["method"] == "ports.write" {
                sent += general_purpose::STANDARD.decode(frame["params"]["data"].as_str().unwrap()).unwrap().len();
            }
        }
        assert!(sent > 0 && sent <= window, "{sent} bytes sent with nothing drained");
        // The runtime drains: the rest follows.
        let mut drained = 0usize;
        while sent < 8 * CHUNK {
            forwarder.on_message(&json!({ "event": "ports.drained", "params": { "streamId": "port-1", "bytes": sent - drained } }));
            drained = sent;
            let frame = next(&mut requests, "ports.write").await;
            sent += general_purpose::STANDARD.decode(frame["params"]["data"].as_str().unwrap()).unwrap().len();
        }
        assert_eq!(sent, 8 * CHUNK);
        let _browser = upload.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_runtime_that_sends_past_its_window_and_too_many_local_connections_are_both_cut_off() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        // A browser that reads nothing, and a runtime that ignores the window.
        let mut stalled = connect(local).await;
        let open = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1" } }));
        let chunk = b64(&vec![9u8; 60 * 1024]);
        let mut closed = false;
        for _ in 0..4096 {
            forwarder.on_message(&json!({ "event": "ports.data", "params": { "streamId": "port-1", "data": chunk } }));
            if let Ok(frame) = requests.try_recv() {
                closed |= frame["method"] == "ports.close";
            }
            if closed {
                break;
            }
        }
        assert!(closed || next(&mut requests, "ports.close").await["params"]["streamId"] == "port-1");
        let mut sink = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(20), stalled.read_to_end(&mut sink)).await.expect("the stalled connection is ended");

        // More local connections than the limit: the extra ones are closed, not queued.
        let mut held = Vec::new();
        for _ in 0..MAX_LOCAL_CONNECTIONS {
            held.push(connect(local).await);
        }
        for _ in 0..MAX_LOCAL_CONNECTIONS {
            next(&mut requests, "ports.open").await;
        }
        let mut extra = connect(local).await;
        assert_eq!(read_all(&mut extra).await, "");
        assert!(tokio::time::timeout(Duration::from_millis(500), requests.recv()).await.is_err(), "the extra connection asked nothing of the workspace");
    }
}
