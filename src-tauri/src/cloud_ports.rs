//! The desktop's half of a cloud preview (PRO-28, docs/CLOUD-PREVIEWS.md): a
//! listener on this Mac's loopback whose connections travel to a port in the
//! workspace as `ports/1` streams, over the workspace connection that is
//! already open.
//!
//! A [`PortForwarder`] belongs to one connection, so to one workspace of one
//! account: its listeners are never handed to another workspace, and they go
//! when the connection is detached. It only sends `ports.*` requests. It
//! never changes the connection's activation: a browser tab reloading a
//! preview of a stopped workspace is told the workspace is stopped, and
//! nothing is resumed.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_util::sync::CancellationToken;

/// Request ids the forwarder sends; their answers never reach the web view.
pub const REQUEST_PREFIX: &str = "ports-";
/// Local ports tried after the wanted one is taken, before any free one.
const NEARBY_PORTS: u16 = 20;
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
    to_local: mpsc::UnboundedSender<Vec<u8>>,
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
}

#[derive(Clone)]
pub struct PortForwarder {
    inner: Arc<Inner>,
}

/// What a browser is told when a preview cannot be served.
fn page(status: &str, message: &str) -> Vec<u8> {
    let body = format!("{message}\n");
    format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
}

fn refusal(code: &str, port: u16) -> (&'static str, String) {
    match code {
        "port_unreachable" => ("502 Bad Gateway", format!("Nothing in the cloud workspace is listening on port {port}. Start the application there, then reload.")),
        "forbidden" => ("403 Forbidden", "You do not have access to this workspace's ports. A manager, or a driver who may approve permissions, can open a preview.".into()),
        "backpressure" => ("503 Service Unavailable", "Too many connections to this workspace's ports are open. Close some and reload.".into()),
        _ => ("502 Bad Gateway", format!("The cloud workspace could not open port {port} ({code}).")),
    }
}

const STOPPED: &str = "This cloud workspace is stopped or not connected. Start it in TerminalX, then reload. Nothing was started by opening this page.";

impl PortForwarder {
    /// `send` hands a request frame to the workspace connection; false when
    /// it could not be sent.
    pub fn new(send: impl Fn(Value) -> bool + std::marker::Send + Sync + 'static) -> Self {
        Self { inner: Arc::new(Inner { send: Box::new(send), ready: AtomicBool::new(false), state: Mutex::new(State::default()), next: AtomicUsize::new(0) }) }
    }

    fn id(&self, kind: &str) -> String {
        format!("{REQUEST_PREFIX}{kind}-{}", self.inner.next.fetch_add(1, Ordering::Relaxed))
    }

    /// The connection's state changed. `capabilities` is what a connected
    /// runtime granted; `None` when it is not connected. Streams end with
    /// the connection; listeners stay and say the workspace is stopped.
    pub fn set_connected(&self, capabilities: Option<&[String]>) {
        let ready = capabilities.is_some_and(|granted| granted.iter().any(|capability| capability == "ports/1"));
        self.inner.ready.store(ready, Ordering::SeqCst);
        if !ready {
            self.drop_streams();
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
    pub fn shutdown(&self) {
        self.inner.ready.store(false, Ordering::SeqCst);
        self.drop_streams();
        for (_, listening) in self.inner.state.lock().unwrap().forwards.drain() {
            listening.stop.cancel();
        }
    }

    pub fn forwards(&self) -> Vec<Forward> {
        let mut forwards: Vec<Forward> = self.inner.state.lock().unwrap().forwards.values().map(|listening| listening.forward.clone()).collect();
        forwards.sort_by_key(|forward| forward.port);
        forwards
    }

    /// Listen on this Mac's loopback for `port` of the workspace. Asking
    /// again for a port already forwarded returns the same forward. `local`
    /// is the wanted local port (the same number by default); when it is
    /// taken, a nearby or any free port is used and the forward says so,
    /// unless `exact`, which refuses instead. Never wakes the workspace: a
    /// connection that is not live is refused.
    pub async fn forward(&self, port: u16, local: Option<u16>, exact: bool) -> Result<Forward, String> {
        if port == 0 {
            return Err("cloud_port_invalid".into());
        }
        if let Some(listening) = self.inner.state.lock().unwrap().forwards.get(&port) {
            return Ok(listening.forward.clone());
        }
        if !self.inner.ready.load(Ordering::SeqCst) {
            return Err("cloud_port_not_connected".into());
        }
        let wanted = local.filter(|local| *local != 0).unwrap_or(port);
        let (listener, reassigned) = bind(wanted, exact).await?;
        let local_port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let forward = Forward { port, local_port, reassigned };
        let stop = CancellationToken::new();
        {
            let mut state = self.inner.state.lock().unwrap();
            // Two requests for the same port raced: the first one stands.
            if let Some(listening) = state.forwards.get(&port) {
                return Ok(listening.forward.clone());
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
                let forwarder = forwarder.clone();
                tokio::spawn(async move { forwarder.serve(socket, port).await });
            }
        });
        Ok(forward)
    }

    pub fn unforward(&self, port: u16) -> bool {
        let Some(listening) = self.inner.state.lock().unwrap().forwards.remove(&port) else { return false };
        listening.stop.cancel();
        true
    }

    /// One local connection, carried as one stream.
    async fn serve(&self, mut socket: TcpStream, port: u16) {
        if !self.inner.ready.load(Ordering::SeqCst) {
            let _ = socket.write_all(&page("503 Service Unavailable", STOPPED)).await;
            return;
        }
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
                let _ = socket.write_all(&page(status, &message)).await;
                return;
            }
            _ => {
                let _ = socket.write_all(&page("503 Service Unavailable", STOPPED)).await;
                return;
            }
        };
        let Some(stream_id) = opened.get("streamId").and_then(Value::as_str).map(str::to_string) else { return };
        let window = opened.get("window").and_then(Value::as_u64).map(|window| window as usize).filter(|window| *window >= CHUNK).unwrap_or(DEFAULT_WINDOW);
        let (to_local, mut from_runtime) = mpsc::unbounded_channel::<Vec<u8>>();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let drained = Arc::new(Notify::new());
        let end = CancellationToken::new();
        let ended_early = {
            let mut state = self.inner.state.lock().unwrap();
            // The connection was lost between the answer and here: the
            // stream died with it, and the local side just ends.
            if state.epoch != epoch {
                return;
            }
            // What the runtime sent before its answer was read.
            let early = state.early.remove(&stream_id).unwrap_or_default();
            for data in early.data {
                let _ = to_local.send(data);
            }
            if !early.closed {
                state.streams.insert(stream_id.clone(), Stream { to_local, in_flight: in_flight.clone(), drained: drained.clone(), end: end.clone() });
            }
            // Otherwise the sender is dropped here: what came is delivered, then the end.
            early.closed
        };
        if ended_early {
            while let Some(data) = from_runtime.recv().await {
                if socket.write_all(&data).await.is_err() {
                    break;
                }
            }
            return;
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
                    // Only what the local side has taken is acknowledged.
                    (forwarder.inner.send)(json!({ "id": forwarder.id("ack"), "method": "ports.ack", "params": { "streamId": stream_id, "bytes": data.len() } }));
                }
                let _ = writer.shutdown().await;
            }
        };
        let up = {
            let (forwarder, stream_id, end) = (self.clone(), stream_id.clone(), end.clone());
            async move {
                let mut buffer = vec![0u8; CHUNK];
                loop {
                    // Send only what the runtime has room for.
                    loop {
                        let freed = drained.notified();
                        if in_flight.load(Ordering::SeqCst) + CHUNK <= window {
                            break;
                        }
                        tokio::select! {
                            _ = end.cancelled() => return,
                            _ = freed => {}
                        }
                    }
                    let read = tokio::select! {
                        _ = end.cancelled() => return,
                        read = reader.read(&mut buffer) => read,
                    };
                    match read {
                        Ok(count) if count > 0 => {
                            in_flight.fetch_add(count, Ordering::SeqCst);
                            let frame = json!({
                                "id": format!("{REQUEST_PREFIX}write-{stream_id}-{}", forwarder.inner.next.fetch_add(1, Ordering::Relaxed)),
                                "method": "ports.write",
                                "params": { "streamId": stream_id, "data": general_purpose::STANDARD.encode(&buffer[..count]) },
                            });
                            if !(forwarder.inner.send)(frame) {
                                break;
                            }
                        }
                        _ => break,
                    }
                }
                // The local side is done: so is the stream.
                if forwarder.inner.state.lock().unwrap().streams.remove(&stream_id).is_some() {
                    (forwarder.inner.send)(json!({ "id": forwarder.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
                }
                end.cancel();
            }
        };
        tokio::join!(down, up);
        self.inner.state.lock().unwrap().streams.remove(&stream_id);
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
                    let mut current = stream.in_flight.load(Ordering::SeqCst);
                    while let Err(actual) = stream.in_flight.compare_exchange(current, current.saturating_sub(bytes), Ordering::SeqCst, Ordering::SeqCst) {
                        current = actual;
                    }
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

/// A loopback listener on `wanted`, or when that is taken and `exact` is not
/// asked for, on one of the next few ports, or on any free one. Returns
/// whether another port than the wanted one was used.
async fn bind(wanted: u16, exact: bool) -> Result<(TcpListener, bool), String> {
    let on = |port: u16| TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
    if let Ok(listener) = on(wanted).await {
        return Ok((listener, false));
    }
    if exact {
        return Err("cloud_port_in_use".into());
    }
    for offset in 1..=NEARBY_PORTS {
        if let Some(port) = wanted.checked_add(offset) {
            if let Ok(listener) = on(port).await {
                return Ok((listener, true));
            }
        }
    }
    on(0).await.map(|listener| (listener, true)).map_err(|_| "cloud_port_in_use".to_string())
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

    async fn free_port() -> u16 {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap().local_addr().unwrap().port()
    }

    fn b64(bytes: &[u8]) -> String {
        general_purpose::STANDARD.encode(bytes)
    }

    async fn read_all(socket: &mut TcpStream) -> String {
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(20), socket.read_to_string(&mut text)).await.expect("the connection ends").unwrap();
        text
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_local_connection_becomes_a_stream_and_bytes_go_both_ways() {
        let (forwarder, mut requests) = forwarder();
        let local = free_port().await;
        let forward = forwarder.forward(3000, Some(local), false).await.unwrap();
        assert_eq!(forward, Forward { port: 3000, local_port: local, reassigned: false });
        // Asking again is the same forward, not a second listener.
        assert_eq!(forwarder.forward(3000, None, false).await.unwrap(), forward);
        assert_eq!(forwarder.forwards(), vec![forward]);

        let mut browser = TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.unwrap();
        let open = next(&mut requests, "ports.open").await;
        assert_eq!(open["params"], json!({ "port": 3000 }));
        // The runtime's data can overtake its answer: nothing is lost.
        assert!(forwarder.on_message(&json!({ "event": "ports.data", "params": { "streamId": "port-1", "data": b64(b"HTTP/1.1 200 OK\r\n\r\n") } })));
        assert!(forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1", "window": 262144 } })));
        assert!(forwarder.on_message(&json!({ "event": "ports.data", "params": { "streamId": "port-1", "data": b64(b"hello") } })));

        let mut response = [0u8; 24];
        browser.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"HTTP/1.1 200 OK\r\n\r\nhello");
        // What the browser took is acknowledged to the runtime, byte for byte.
        let mut acked = 0;
        while acked < 24 {
            acked += next(&mut requests, "ports.ack").await["params"]["bytes"].as_u64().unwrap();
        }
        assert_eq!(acked, 24);
        browser.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        let write = next(&mut requests, "ports.write").await;
        assert_eq!(write["params"], json!({ "streamId": "port-1", "data": b64(b"GET / HTTP/1.1\r\n\r\n") }));

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
        let local = forwarder.forward(3000, Some(free_port().await), false).await.unwrap().local_port;
        let browser = TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.unwrap();
        let open = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-7" } }));
        drop(browser);
        assert_eq!(next(&mut requests, "ports.close").await["params"], json!({ "streamId": "port-7" }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stopped_workspace_gets_a_page_and_nothing_is_sent() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, Some(free_port().await), false).await.unwrap().local_port;
        // The workspace stops: the listener stays, and says so.
        forwarder.set_connected(None);
        let mut browser = TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.unwrap();
        let page = read_all(&mut browser).await;
        assert!(page.starts_with("HTTP/1.1 503 "), "{page}");
        assert!(page.contains("stopped or not connected") && page.contains("Nothing was started"), "{page}");
        assert!(requests.try_recv().is_err(), "no request leaves for a workspace that is not connected");
        // A new forward is not made on a connection that is not live.
        assert_eq!(forwarder.forward(4000, None, false).await.unwrap_err(), "cloud_port_not_connected");
        // Connected again, with a runtime that does not serve ports: the same.
        forwarder.set_connected(Some(&["pty/1".to_string()]));
        assert_eq!(forwarder.forward(4000, None, false).await.unwrap_err(), "cloud_port_not_connected");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refusal_is_explained_to_the_browser() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, Some(free_port().await), false).await.unwrap().local_port;
        for (code, status, words) in [("port_unreachable", "502", "Nothing in the cloud workspace is listening on port 3000"), ("forbidden", "403", "driver who may approve")] {
            let mut browser = TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.unwrap();
            let open = next(&mut requests, "ports.open").await;
            forwarder.on_message(&json!({ "id": open["id"], "ok": false, "error": { "code": code, "message": "raw server words" } }));
            let page = read_all(&mut browser).await;
            assert!(page.starts_with(&format!("HTTP/1.1 {status} ")) && page.contains(words), "{page}");
            assert!(!page.contains("raw server words"));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn open_streams_end_when_the_connection_does_and_listeners_when_it_is_detached() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, Some(free_port().await), false).await.unwrap().local_port;
        let mut browser = TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.unwrap();
        let open = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1" } }));
        // Access revoked, the workspace suspended, the relay gone: the same to the desktop.
        forwarder.set_connected(None);
        assert_eq!(read_all(&mut browser).await, "");
        assert_eq!(forwarder.forwards().len(), 1);
        forwarder.shutdown();
        assert!(forwarder.forwards().is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.is_err(), "the listener is closed");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_taken_local_port_is_reassigned_visibly_or_refused_when_exact() {
        let (forwarder, _requests) = forwarder();
        let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let wanted = taken.local_addr().unwrap().port();
        assert_eq!(forwarder.forward(3000, Some(wanted), true).await.unwrap_err(), "cloud_port_in_use");
        assert!(forwarder.forwards().is_empty());
        let forward = forwarder.forward(3000, Some(wanted), false).await.unwrap();
        assert!(forward.reassigned && forward.local_port != wanted, "{forward:?}");
        // Two workspaces' forwarders never share a listener: the second is moved.
        let (other, _other_requests) = self::forwarder();
        let second = other.forward(3000, Some(forward.local_port), false).await.unwrap();
        assert!(second.reassigned && second.local_port != forward.local_port);
        assert!(forwarder.unforward(3000));
        assert!(!forwarder.unforward(3000));
        assert_eq!(forwarder.forward(0, None, false).await.unwrap_err(), "cloud_port_invalid");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_local_side_is_read_only_as_fast_as_the_runtime_drains() {
        let (forwarder, mut requests) = forwarder();
        let local = forwarder.forward(3000, Some(free_port().await), false).await.unwrap().local_port;
        let mut browser = TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.unwrap();
        let open = next(&mut requests, "ports.open").await;
        let window = 2 * CHUNK;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1", "window": window } }));
        let upload = tokio::spawn(async move {
            let _ = browser.write_all(&vec![5u8; 8 * CHUNK]).await;
            browser
        });
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
}
