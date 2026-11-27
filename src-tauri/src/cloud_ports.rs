//! The desktop's half of a cloud preview (PRO-28, docs/CLOUD-PREVIEWS.md): a
//! listener on this Mac's loopback whose connections travel to a port in the
//! workspace as `ports/1` streams, over the workspace connection that is
//! already open.
//!
//! A [`PortForwarder`] belongs to one connection, so to one workspace of one
//! account (or one paired machine): its listeners are never handed to another.
//! They close when the connection stops being live (the workspace stopped,
//! access was revoked, the relay dropped), when it is detached, and when the
//! active organization changes. A cloud workspace's forwards are then gone: a
//! preview is opened again by the person, never revived. A paired machine's
//! forwards wait instead and open again when its link returns (PRO-355,
//! docs/MACHINES.md). Detaching forgets everything either way.
//!
//! Two switches per connection (PRO-355): Forwarding (on by default; off
//! closes every listener and keeps the forwards waiting) and auto-forward (off
//! by default; while on and connected, `ports.list` is read every
//! [`AUTO_POLL`] and each port that starts listening after the switch was
//! turned on is forwarded, outside [`AUTO_SKIPPED`]). The forwarder only sends
//! `ports.*` requests and never changes the connection's activation, so
//! nothing here can resume a stopped workspace.
//!
//! What a listener on loopback exposes is stated in docs/CLOUD-PREVIEWS.md:
//! any program of this user can connect, and a web page in the person's
//! browser can send requests to it. The local port is random by default, the
//! listener never shares a port with another program, and a request whose
//! `Host` is not this loopback address is refused, which is what stops a web
//! page from reading a preview through DNS rebinding.

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket};
#[cfg(test)]
use tokio::net::TcpStream;
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
/// How often auto-forward reads `ports.list`.
pub const AUTO_POLL: Duration = Duration::from_secs(2);
/// Ports auto-forward leaves alone: the ephemeral range, where clients bind,
/// not servers (`AUTO_FORWARD_SKIPPED` in src/lib/api.ts).
pub const AUTO_SKIPPED: std::ops::RangeInclusive<u16> = 32768..=60999;
/// Auto-forwards one connection keeps at once: a workspace that starts many
/// listeners does not take as many ports on this Mac.
pub const MAX_AUTO_FORWARDS: usize = 16;

/// Whether a forward is listening on this Mac now.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ForwardState {
    Open,
    /// Kept while the connection is away or Forwarding is off; opened again
    /// (on the same local port when it is free) once both are back.
    Waiting,
}

/// One forwarded port, as the interface shows it (`CloudPortForward`).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    /// The port in the workspace.
    pub port: u16,
    /// The port on this Mac's loopback.
    pub local_port: u16,
    /// The wanted local port was taken and another was used.
    pub reassigned: bool,
    pub state: ForwardState,
    /// Opened by auto-forward, not by the person.
    pub auto: bool,
}

/// A connection's two switches (`CloudPortSettings`).
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortSettings {
    /// Forwarding: off closes every listener and keeps the forwards waiting.
    pub enabled: bool,
    /// Forward ports that start listening after this was turned on.
    pub auto: bool,
}

impl Default for PortSettings {
    fn default() -> Self {
        Self { enabled: true, auto: false }
    }
}

/// What changed, for `cloud_port_forwards_changed`: the forwards and switches
/// as they now are, and the forwards that opened without a click (auto, or
/// returned after a reconnect).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForwardsChanged {
    pub forwards: Vec<Forward>,
    pub settings: PortSettings,
    pub opened: Vec<Forward>,
}

struct Listening {
    forward: Forward,
    /// Closes the listener; `None` while the forward is waiting.
    stop: Option<CancellationToken>,
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
    /// Requests awaiting their answer: `ports.open`, and auto-forward's `ports.list`.
    opens: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    streams: HashMap<String, Stream>,
    early: HashMap<String, Early>,
    settings: PortSettings,
    /// The ports auto-forward's last list reported listening; `None` until its
    /// first list, which only records what already listens. A port missing
    /// from a later list is forgotten, so a server that stops and starts again
    /// is new to it.
    seen: Option<HashSet<u16>>,
    /// Ports the person stopped while auto-forward was on: not taken again
    /// while they keep listening, forgotten once a list no longer has them.
    stopped: HashSet<u16>,
    /// The active organization when auto-forward was turned on.
    auto_scope: Option<String>,
    /// Stops the auto-forward reader while one runs.
    poll: Option<CancellationToken>,
    /// What was last told, so an unchanged state is not told again.
    told: Option<(Vec<Forward>, PortSettings)>,
}

type Send = Box<dyn Fn(Value) -> bool + std::marker::Send + Sync>;
type OnChange = Box<dyn Fn(ForwardsChanged) + std::marker::Send + Sync>;

struct Inner {
    send: Send,
    /// A paired machine's connection: forwards wait through a dropped link
    /// and return with it, and no organization scopes them.
    returns: bool,
    /// Connected, with `ports/1` granted.
    ready: AtomicBool,
    state: Mutex<State>,
    next: AtomicUsize,
    /// Local connections being carried.
    carried: AtomicUsize,
    /// Told every change. Held while telling, so changes are told in order.
    on_change: Mutex<Option<OnChange>>,
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
    /// A cloud workspace's forwarder. `send` hands a request frame to the
    /// workspace connection; false when it could not be sent.
    pub fn new(send: impl Fn(Value) -> bool + std::marker::Send + Sync + 'static) -> Self {
        Self::with(send, false)
    }

    /// A paired machine's forwarder: its forwards wait through a dropped link
    /// and open again when it returns.
    pub fn for_machine(send: impl Fn(Value) -> bool + std::marker::Send + Sync + 'static) -> Self {
        Self::with(send, true)
    }

    fn with(send: impl Fn(Value) -> bool + std::marker::Send + Sync + 'static, returns: bool) -> Self {
        Self {
            inner: Arc::new(Inner {
                send: Box::new(send),
                returns,
                ready: AtomicBool::new(false),
                state: Mutex::new(State::default()),
                next: AtomicUsize::new(0),
                carried: AtomicUsize::new(0),
                on_change: Mutex::new(None),
            }),
        }
    }

    /// Be told each change of the forwards or switches. `on_change` must not
    /// call back into the forwarder.
    pub fn on_change(&self, on_change: impl Fn(ForwardsChanged) + std::marker::Send + Sync + 'static) {
        *self.inner.on_change.lock().unwrap() = Some(Box::new(on_change));
    }

    fn id(&self, kind: &str) -> String {
        format!("{REQUEST_PREFIX}{kind}-{}", self.inner.next.fetch_add(1, Ordering::Relaxed))
    }

    fn ready(&self) -> bool {
        self.inner.ready.load(Ordering::SeqCst)
    }

    /// Tell the forwards and switches as they now are, unless nothing changed
    /// since last told and nothing `opened` by itself.
    fn tell(&self, opened: Vec<Forward>) {
        let on_change = self.inner.on_change.lock().unwrap();
        let changed = {
            let mut state = self.inner.state.lock().unwrap();
            let now = (listed(&state), state.settings);
            // A Stop or pause can overtake publication of an automatic forward.
            let opened = opened.into_iter().filter(|forward| now.0.contains(forward)).collect::<Vec<_>>();
            if opened.is_empty() && state.told.as_ref() == Some(&now) {
                return;
            }
            state.told = Some(now.clone());
            ForwardsChanged { forwards: now.0, settings: now.1, opened }
        };
        if let Some(on_change) = on_change.as_ref() {
            on_change(changed);
        }
    }

    /// The connection's state changed. `capabilities` is what a connected
    /// runtime granted; `None` when it is not connected. Whatever ended the
    /// connection (the workspace stopped, access was revoked, the relay
    /// dropped), its streams and its listeners end with it: nothing keeps
    /// answering on this Mac for a workspace that is not there. A cloud
    /// workspace's forwards are gone and nothing comes back by itself when it
    /// returns; a machine's wait and open again when it is connected.
    pub fn set_connected(&self, capabilities: Option<&[String]>) {
        let ready = capabilities.is_some_and(|granted| granted.iter().any(|capability| capability == "ports/1"));
        self.inner.ready.store(ready, Ordering::SeqCst);
        let opened = if ready {
            self.reopen()
        } else {
            if self.inner.returns {
                self.hold();
            } else {
                self.close(false);
            }
            Vec::new()
        };
        self.poll_while_wanted();
        self.tell(opened);
    }

    /// Close every forward unless `active` is still the organization they
    /// (or auto-forward) were made under.
    pub fn keep_scope(&self, active: Option<&str>) {
        let made_under = {
            let state = self.inner.state.lock().unwrap();
            [state.scope.clone(), state.auto_scope.clone()]
        };
        let changed = made_under.iter().flatten().any(|made_under| Some(made_under.as_str()) != active);
        if changed {
            log::info!("closing port forwards: the active organization changed");
            self.shutdown();
        }
    }

    /// End every stream. Each one the runtime still holds is closed there
    /// too while the connection is live.
    fn drop_streams(&self) {
        let ended: Vec<String> = {
            let mut state = self.inner.state.lock().unwrap();
            state.epoch += 1;
            let ended = state
                .streams
                .drain()
                .map(|(id, stream)| {
                    stream.end.cancel();
                    id
                })
                .collect();
            for (_, answer) in state.opens.drain() {
                let _ = answer.send(Err("disconnected".into()));
            }
            state.early.clear();
            ended
        };
        if self.ready() {
            for stream_id in ended {
                (self.inner.send)(json!({ "id": self.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
            }
        }
    }

    /// Close every listener and keep each forward as waiting.
    fn hold(&self) {
        self.drop_streams();
        let mut state = self.inner.state.lock().unwrap();
        for listening in state.forwards.values_mut() {
            if let Some(stop) = listening.stop.take() {
                stop.cancel();
            }
            listening.forward.state = ForwardState::Waiting;
        }
    }

    /// Close every listener and forget every forward; with `forget_settings`,
    /// the switches and what auto-forward has seen too.
    fn close(&self, forget_settings: bool) {
        self.drop_streams();
        let mut state = self.inner.state.lock().unwrap();
        for (_, listening) in state.forwards.drain() {
            if let Some(stop) = listening.stop {
                stop.cancel();
            }
        }
        state.scope = None;
        if forget_settings {
            state.settings = PortSettings::default();
            state.seen = None;
            state.stopped.clear();
            state.auto_scope = None;
            if let Some(poll) = state.poll.take() {
                poll.cancel();
            }
        }
    }

    /// Open every waiting forward again, while connected with Forwarding on:
    /// on the same local port when it is free, else on a new one
    /// (`reassigned`). Returns those that opened.
    fn reopen(&self) -> Vec<Forward> {
        let mut opened = Vec::new();
        let mut listeners = Vec::new();
        {
            let mut state = self.inner.state.lock().unwrap();
            if !self.ready() || !state.settings.enabled {
                return opened;
            }
            for listening in state.forwards.values_mut().filter(|listening| listening.stop.is_none()) {
                let wanted = listening.forward.local_port;
                let Ok((listener, moved)) = bind(Some(wanted).filter(|wanted| *wanted != 0), false) else { continue };
                let Ok(local) = listener.local_addr().map(|address| address.port()) else { continue };
                let stop = CancellationToken::new();
                listening.forward.local_port = local;
                listening.forward.reassigned |= moved;
                listening.forward.state = ForwardState::Open;
                listening.stop = Some(stop.clone());
                opened.push(listening.forward.clone());
                listeners.push((listening.forward.port, listener, local, stop));
            }
        }
        for (port, listener, local, stop) in listeners {
            self.accept(port, listener, local, stop);
        }
        opened.sort_by_key(|forward| forward.port);
        opened
    }

    /// The connection is gone for good (detached, or no longer this
    /// person's): every listener and stream closes, and every forward and
    /// switch is forgotten. The connection itself is untouched.
    pub fn shutdown(&self) {
        self.close(true);
        self.tell(Vec::new());
    }

    pub fn forwards(&self) -> Vec<Forward> {
        listed(&self.inner.state.lock().unwrap())
    }

    pub fn settings(&self) -> PortSettings {
        self.inner.state.lock().unwrap().settings
    }

    /// Change either switch; answers the switches as they now are. `scope` is
    /// the active organization, which auto-forward does not outlive.
    pub fn set_settings(&self, enabled: Option<bool>, auto: Option<bool>, scope: Option<String>) -> PortSettings {
        let (hold, reopen) = {
            let mut state = self.inner.state.lock().unwrap();
            if let Some(auto) = auto {
                if auto && !state.settings.auto {
                    // Only ports that start listening from now on.
                    state.seen = None;
                    state.stopped.clear();
                    state.auto_scope = if self.inner.returns { None } else { scope };
                }
                state.settings.auto = auto;
            }
            let was = state.settings.enabled;
            if let Some(enabled) = enabled {
                state.settings.enabled = enabled;
            }
            if !state.settings.enabled || !state.settings.auto {
                if let Some(poll) = state.poll.take() {
                    poll.cancel();
                }
            }
            (was && !state.settings.enabled, !was && state.settings.enabled)
        };
        if hold {
            self.hold();
        }
        if reopen {
            // Turned on by the person: not "opened without a click".
            self.reopen();
        }
        self.poll_while_wanted();
        self.tell(Vec::new());
        self.settings()
    }

    /// Run auto-forward's reader while connected with both switches on, and
    /// only then.
    fn poll_while_wanted(&self) {
        let mut state = self.inner.state.lock().unwrap();
        let wanted = self.ready() && state.settings.enabled && state.settings.auto;
        if !wanted {
            if let Some(poll) = state.poll.take() {
                poll.cancel();
            }
            return;
        }
        if state.poll.is_some() || tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let stop = CancellationToken::new();
        state.poll = Some(stop.clone());
        tokio::spawn(self.clone().poll(stop));
    }

    /// Read `ports.list` every [`AUTO_POLL`] until stopped. Its answers stay
    /// native (`ports-` request ids).
    async fn poll(self, stop: CancellationToken) {
        loop {
            let request = self.id("list");
            let (answer, answered) = oneshot::channel();
            self.inner.state.lock().unwrap().opens.insert(request.clone(), answer);
            let listed = if (self.inner.send)(json!({ "id": request, "method": "ports.list", "params": {} })) {
                tokio::select! {
                    _ = stop.cancelled() => None,
                    answer = tokio::time::timeout(OPEN_TIMEOUT, answered) => answer.ok().and_then(Result::ok),
                }
            } else {
                None
            };
            self.inner.state.lock().unwrap().opens.remove(&request);
            if stop.is_cancelled() {
                return;
            }
            if let Some(Ok(result)) = listed {
                self.auto_forward(&result, &stop);
            }
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = tokio::time::sleep(AUTO_POLL) => {}
            }
        }
    }

    /// Forward each port in a `ports.list` answer that started listening
    /// since auto-forward was turned on, outside [`AUTO_SKIPPED`], on the
    /// same local port when it is free.
    fn auto_forward(&self, listed: &Value, poll: &CancellationToken) {
        // A runtime that cannot tell what listens says nothing about what stopped.
        if listed.get("detected").and_then(Value::as_bool) != Some(true) {
            return;
        }
        let ports: HashSet<u16> = listed
            .get("ports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("port").and_then(Value::as_u64))
            .filter_map(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .collect();
        let (fresh, scope) = {
            let mut guard = self.inner.state.lock().unwrap();
            let state = &mut *guard;
            if poll.is_cancelled() || !state.settings.auto || !state.settings.enabled {
                return;
            }
            let Some(seen) = state.seen.as_mut() else {
                // The first list: what already listens is left to the person.
                state.seen = Some(ports);
                return;
            };
            let mut fresh: Vec<u16> = ports
                .iter()
                .copied()
                .filter(|port| !seen.contains(port) && !state.stopped.contains(port) && !AUTO_SKIPPED.contains(port) && !state.forwards.contains_key(port))
                .collect();
            state.stopped.retain(|port| ports.contains(port));
            *seen = ports;
            fresh.sort_unstable();
            // Past the cap the rest are left to the person, as already seen.
            let room = MAX_AUTO_FORWARDS.saturating_sub(state.forwards.values().filter(|listening| listening.forward.auto).count());
            fresh.truncate(room);
            (fresh, state.auto_scope.clone())
        };
        // Until PRO-189 supplies a Connections strategy and range, prefer
        // the same unprivileged local number and fall back to a free one.
        let opened: Vec<Forward> = fresh
            .into_iter()
            .filter_map(|port| self.open(port, Some(port).filter(|port| *port >= 1024), false, scope.clone(), Some(poll)).ok())
            .collect();
        if !opened.is_empty() {
            self.tell(opened);
        }
    }

    /// Listen on this Mac's loopback for `port` of the workspace. Asking
    /// again for a port already forwarded returns the same forward (opened
    /// again if it was waiting and can be). The local port is a random free
    /// one unless `local` names one; when that one is taken by any program on
    /// any address, a random one is used and the forward says so, unless
    /// `exact`, which refuses instead. `scope` is the active organization,
    /// which a cloud workspace's forward does not outlive. Never wakes the
    /// workspace: a connection that is not live is refused, and so is any
    /// new forward while Forwarding is off (`cloud_port_forwarding_off`).
    pub async fn forward(&self, port: u16, local: Option<u16>, exact: bool, scope: Option<String>) -> Result<Forward, String> {
        let forward = self.open(port, local, exact, scope, None)?;
        self.tell(Vec::new());
        Ok(forward)
    }

    fn open(&self, port: u16, local: Option<u16>, exact: bool, scope: Option<String>, poll: Option<&CancellationToken>) -> Result<Forward, String> {
        if port == 0 {
            return Err("cloud_port_invalid".into());
        }
        let auto_cancelled = |state: &State| {
            poll.is_some_and(|poll| poll.is_cancelled() || !state.settings.auto || state.stopped.contains(&port) || state.forwards.contains_key(&port))
        };
        let mut wanted = local.filter(|local| *local != 0);
        {
            let mut state = self.inner.state.lock().unwrap();
            if auto_cancelled(&state) {
                return Err("cloud_port_auto_cancelled".into());
            }
            if let Some(listening) = state.forwards.get(&port) {
                // Open, or waiting and not to be opened yet: as it is.
                if listening.stop.is_some() || !self.ready() || !state.settings.enabled {
                    return Ok(listening.forward.clone());
                }
                // Waiting, and asked for again: on its own local port unless another is named.
                wanted = wanted.or(Some(listening.forward.local_port).filter(|local| *local != 0));
                state.forwards.remove(&port);
            }
            if !self.ready() {
                return Err("cloud_port_not_connected".into());
            }
            if !state.settings.enabled {
                return Err("cloud_port_forwarding_off".into());
            }
        }
        let (listener, reassigned) = bind(wanted, exact)?;
        let local_port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let forward = Forward { port, local_port, reassigned, state: ForwardState::Open, auto: poll.is_some() };
        let stop = CancellationToken::new();
        {
            let mut state = self.inner.state.lock().unwrap();
            if auto_cancelled(&state) {
                return Err("cloud_port_auto_cancelled".into());
            }
            // Two requests for the same port raced: the first one stands.
            if let Some(listening) = state.forwards.get(&port) {
                return Ok(listening.forward.clone());
            }
            // Read again under the lock that a disconnect takes to close
            // everything: a forward made here cannot outlive it. (The
            // listener is dropped on return.)
            if !self.ready() {
                return Err("cloud_port_not_connected".into());
            }
            if !state.settings.enabled {
                return Err("cloud_port_forwarding_off".into());
            }
            // A machine is no organization's: its forwards outlive a switch.
            if state.scope.is_none() && !self.inner.returns {
                state.scope = scope;
            }
            state.forwards.insert(port, Listening { forward: forward.clone(), stop: Some(stop.clone()) });
        }
        self.accept(port, listener, local_port, stop);
        Ok(forward)
    }

    /// Accept local connections on `listener` until `stop`.
    fn accept(&self, port: u16, listener: TcpListener, local_port: u16, stop: CancellationToken) {
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
                    forwarder.serve(socket, port, Some(local_port)).await;
                    forwarder.inner.carried.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
    }

    /// Stop forwarding `port`: the listener closes, and so does every
    /// connection it was carrying. A waiting forward is forgotten.
    pub fn unforward(&self, port: u16) -> bool {
        let closed: Vec<String> = {
            let mut state = self.inner.state.lock().unwrap();
            let Some(listening) = state.forwards.remove(&port) else { return false };
            // Stopped by the person: auto-forward leaves it while it keeps listening.
            if state.settings.auto {
                state.stopped.insert(port);
            }
            if let Some(stop) = listening.stop {
                stop.cancel();
            }
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
        self.tell(Vec::new());
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
    async fn serve(&self, mut socket: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin, port: u16, local_port: Option<u16>) {
        if !self.ready() {
            if local_port.is_some() {
                answer_and_close(&mut socket, &page("503 Service Unavailable", STOPPED)).await;
            }
            return;
        }
        let foreign = local_port.map(|local_port| page("403 Forbidden", &format!("This preview is only served at http://127.0.0.1:{local_port}. The request named another host and was refused.")));
        let mut head = Vec::new();
        let verdict = if let Some(local_port) = local_port {
            match tokio::time::timeout(SILENT_OPEN, judge(&mut socket, &mut head, local_port)).await {
                Ok(verdict) => Some(verdict),
                // Bytes have begun to arrive: they are judged before anything else happens.
                Err(_) if !head.is_empty() => Some(judge(&mut socket, &mut head, local_port).await),
                Err(_) => None,
            }
        } else {
            Some(Verdict::Carry)
        };
        match verdict {
            Some(Verdict::Refuse) => {
                if let Some(foreign) = foreign.as_ref() {
                    answer_and_close(&mut socket, foreign).await;
                }
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
        let frame = if local_port.is_some() {
            json!({ "id": request, "method": "ports.open", "params": { "port": port } })
        } else {
            json!({ "id": request, "method": "ssh.open", "params": {} })
        };
        let sent = (self.inner.send)(frame);
        let opened = if sent { tokio::time::timeout(OPEN_TIMEOUT, answered).await.ok().and_then(Result::ok) } else { None };
        self.inner.state.lock().unwrap().opens.remove(&request);
        let opened = match opened {
            Some(Ok(opened)) => opened,
            _ if local_port.is_none() => return,
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
            } else if local_port.is_some() && !state.forwards.contains_key(&port) {
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
            None => {
                // Forwarding was turned off meanwhile on a live connection:
                // the runtime still holds the stream.
                if self.ready() {
                    (self.inner.send)(json!({ "id": self.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
                }
                return;
            }
            Some(false) => {
                (self.inner.send)(json!({ "id": self.id("close"), "method": "ports.close", "params": { "streamId": stream_id } }));
                return;
            }
            Some(true) => {}
        }
        let (mut reader, mut writer) = tokio::io::split(socket);
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
                    if let Some(local_port) = local_port.filter(|_| !judged) {
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
        let mut socket = reader.unsplit(writer);
        if let Some(foreign) = foreign.as_ref().filter(|_| refused) {
            answer_and_close(&mut socket, foreign).await;
        } else {
            let _ = socket.shutdown().await;
        }
    }

    /// Fetch the host pin on the same E2EE transport that will carry SSH.
    #[cfg(unix)]
    pub(crate) async fn ssh_host_key(&self) -> Result<String, String> {
        if !self.ready() {
            return Err("cloud_port_not_connected".into());
        }
        let request = self.id("ssh-info");
        let (answer, receive) = oneshot::channel();
        let epoch = {
            let mut state = self.inner.state.lock().unwrap();
            state.opens.insert(request.clone(), answer);
            state.epoch
        };
        let sent = (self.inner.send)(json!({ "id": request, "method": "ssh.info", "params": {} }));
        let result = if sent { tokio::time::timeout(OPEN_TIMEOUT, receive).await.ok().and_then(Result::ok) } else { None };
        let mut state = self.inner.state.lock().unwrap();
        state.opens.remove(&request);
        if epoch != state.epoch {
            return Err("cloud_remote_identity_changed".into());
        }
        let result = result.ok_or("cloud_workspace_ssh_unavailable")??;
        result["hostKey"].as_str().and_then(crate::workspace_ssh::parse_public_key)
            .ok_or_else(|| "cloud_workspace_ssh_unavailable".into())
    }

    /// Use the authenticated SSH-specific open, keeping raw bytes out of
    /// the preview path and its HTTP request and response handling.
    #[cfg(unix)]
    pub(crate) async fn serve_ssh(&self, socket: tokio::net::UnixStream) {
        if self.inner.carried.fetch_add(1, Ordering::SeqCst) >= MAX_LOCAL_CONNECTIONS {
            self.inner.carried.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        self.serve(socket, 0, None).await;
        self.inner.carried.fetch_sub(1, Ordering::SeqCst);
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

/// The forwards, by workspace port.
fn listed(state: &State) -> Vec<Forward> {
    let mut forwards: Vec<Forward> = state.forwards.values().map(|listening| listening.forward.clone()).collect();
    forwards.sort_by_key(|forward| forward.port);
    forwards
}

/// Send `answer`, then close without a reset: what the client already sent
/// is read and dropped first, because closing a socket with unread data
/// resets it and the client would never see the answer.
async fn answer_and_close(socket: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin), answer: &[u8]) {
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

/// Listen on `127.0.0.1:port` (0: any free port), with `SO_REUSEADDR`.
///
/// Without it a forward that carried a connection could not come back on its
/// own port: closing it from this side (Forwarding off, a machine's link
/// dropping) leaves the port in TIME_WAIT, and a plain bind is refused until
/// that ends. With it, on macOS, a loopback bind would also succeed while
/// another program listens on the wildcard address of the same port, and take
/// that program's loopback traffic; that is why [`bind`] asks
/// [`taken_elsewhere`] first, whose probes (also with `SO_REUSEADDR`) still see
/// every listener on the IPv4 wildcard, IPv6 loopback and IPv6 wildcard. A
/// program on `127.0.0.1` itself is refused by this bind. On Windows the
/// option would let two listeners share the port, and TIME_WAIT does not hold
/// a listening port, so it is not set there. Windows also lets a later
/// listener on the wildcard address, or one that asks to share, take the same
/// port beside this one: the bind is made exclusive, so the port stays this
/// forward's alone for as long as it listens.
fn listen_on(port: u16) -> std::io::Result<TcpListener> {
    let socket = TcpSocket::new_v4()?;
    #[cfg(not(windows))]
    socket.set_reuseaddr(true)?;
    #[cfg(windows)]
    crate::win::net::bind_exclusively(&socket)?;
    socket.bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))?;
    socket.listen(128)
}

/// Whether another program already listens on `port` on an address that a
/// browser's `localhost`, or loopback traffic, could reach: the IPv4
/// wildcard, IPv6 loopback or the IPv6 wildcard. A connection of ours in
/// TIME_WAIT on the port does not count (`SO_REUSEADDR`); a listener does.
/// Windows answers a bind over another listener with access denied as well.
fn taken_elsewhere(port: u16) -> bool {
    let taken = |error: std::io::Error| crate::listen::port_taken(&error);
    let in_use = |socket: std::io::Result<TcpSocket>, address: SocketAddr| {
        socket
            .and_then(|socket| {
                #[cfg(not(windows))]
                socket.set_reuseaddr(true)?;
                socket.bind(address)?;
                Ok(())
            })
            .is_err_and(taken)
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

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_ssh_uses_the_private_open_and_carries_raw_bytes() {
        let (forwarder, mut requests) = forwarder();
        let (mut client, socket) = tokio::net::UnixStream::pair().unwrap();
        let owner = forwarder.clone();
        let relay = tokio::spawn(async move { owner.serve_ssh(socket).await });
        let first = tokio::time::timeout(Duration::from_secs(2), requests.recv()).await.unwrap().unwrap();
        assert_eq!(first["method"], "ssh.open");
        assert_eq!(first["params"], json!({}));
        assert!(forwarder.on_message(&json!({
            "id": first["id"], "ok": true, "result": { "streamId": "port-ssh", "window": DEFAULT_WINDOW }
        })));
        let bytes = b"SSH-2.0-test\r\n\0\xff";
        assert!(forwarder.on_message(&json!({
            "event": "ports.data", "params": { "streamId": "port-ssh", "data": general_purpose::STANDARD.encode(bytes) }
        })));
        let mut read = vec![0u8; bytes.len()];
        tokio::time::timeout(Duration::from_secs(2), client.read_exact(&mut read)).await.unwrap().unwrap();
        assert_eq!(read.as_slice(), bytes);
        drop(client);
        tokio::time::timeout(Duration::from_secs(2), relay).await.unwrap().unwrap();
    }

    /// A forwarder whose requests land in a channel, as the runtime would see them.
    fn forwarder() -> (PortForwarder, mpsc::UnboundedReceiver<Value>) {
        let (sent, requests) = mpsc::unbounded_channel();
        let forwarder = PortForwarder::new(move |frame| sent.send(frame).is_ok());
        forwarder.set_connected(Some(&["ports/1".to_string()]));
        (forwarder, requests)
    }

    /// A forwarder (a machine's when `machine`) whose requests and told
    /// changes land in channels.
    fn watched(machine: bool) -> (PortForwarder, mpsc::UnboundedReceiver<Value>, mpsc::UnboundedReceiver<ForwardsChanged>) {
        let (sent, requests) = mpsc::unbounded_channel();
        let send = move |frame| sent.send(frame).is_ok();
        let forwarder = if machine { PortForwarder::for_machine(send) } else { PortForwarder::new(send) };
        let (told, changes) = mpsc::unbounded_channel();
        forwarder.on_change(move |changed| {
            let _ = told.send(changed);
        });
        forwarder.set_connected(Some(&["ports/1".to_string()]));
        (forwarder, requests, changes)
    }

    /// Every change told so far.
    fn told(changes: &mut mpsc::UnboundedReceiver<ForwardsChanged>) -> Vec<ForwardsChanged> {
        std::iter::from_fn(|| changes.try_recv().ok()).collect()
    }

    fn ports(capabilities: &[&str]) -> Vec<String> {
        capabilities.iter().map(|capability| capability.to_string()).collect()
    }

    async fn closed(local: u16) -> bool {
        tokio::time::sleep(Duration::from_millis(200)).await;
        TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.is_err()
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
    async fn a_machines_forwards_wait_through_a_dropped_link_and_return_on_the_same_local_port() {
        let (forwarder, mut requests, mut changes) = watched(true);
        let forward = forwarder.forward(3000, None, false, None).await.unwrap();
        assert_eq!((forward.state, forward.auto), (ForwardState::Open, false));
        let local = forward.local_port;
        let waiting = Forward { state: ForwardState::Waiting, ..forward.clone() };
        let open = forward.clone();
        told(&mut changes);
        // A preview is open when the link drops: closing its connection from
        // this side leaves the local port in TIME_WAIT, which must not keep
        // the forward off its own port when it returns.
        let mut browser = connect(local).await;
        let opened = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": opened["id"], "ok": true, "result": { "streamId": "port-1" } }));
        tokio::time::sleep(Duration::from_millis(100)).await;

        // The link drops: the listener closes, the forward is kept as waiting.
        forwarder.set_connected(None);
        assert_eq!(read_all(&mut browser).await, "", "the preview's connection ended with the link");
        assert_eq!(forwarder.forwards(), vec![waiting.clone()]);
        assert!(closed(local).await, "nothing answers on this Mac while the machine is away");
        assert_eq!(told(&mut changes).last().map(|changed| changed.forwards.clone()), Some(vec![waiting.clone()]));
        // Asked for again meanwhile: as it is. A new one is refused.
        assert_eq!(forwarder.forward(3000, None, false, None).await.unwrap(), waiting);
        assert_eq!(forwarder.forward(4000, None, false, None).await.unwrap_err(), "cloud_port_not_connected");

        // Connected again: the same local port, and told as opened by itself.
        forwarder.set_connected(Some(&ports(&["ports/1"])));
        assert_eq!(forwarder.forwards(), vec![open.clone()]);
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.is_ok());
        let changed = told(&mut changes).pop().expect("the return is told");
        assert_eq!((changed.forwards, changed.opened), (vec![open.clone()], vec![open.clone()]));

        // Dropped again, and another program takes the local port meanwhile:
        // it returns on a new one and says so.
        forwarder.set_connected(None);
        assert!(closed(local).await);
        let other = listen_on(local).unwrap();
        forwarder.set_connected(Some(&ports(&["ports/1"])));
        let [moved] = forwarder.forwards().try_into().unwrap();
        assert!(moved.state == ForwardState::Open && moved.reassigned && moved.local_port != local, "{moved:?}");
        drop(other);

        // A link that comes back without `ports/1` keeps it waiting.
        forwarder.set_connected(None);
        forwarder.set_connected(Some(&ports(&["pty/1"])));
        assert_eq!(forwarder.forwards()[0].state, ForwardState::Waiting);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cloud_workspaces_forwards_do_not_return_after_a_dropped_link() {
        let (forwarder, _requests, mut changes) = watched(false);
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        forwarder.set_connected(None);
        assert!(forwarder.forwards().is_empty(), "dropped, not waiting");
        assert!(closed(local).await);
        forwarder.set_connected(Some(&ports(&["ports/1"])));
        assert!(forwarder.forwards().is_empty());
        assert!(closed(local).await);
        assert!(told(&mut changes).iter().all(|changed| changed.opened.is_empty()), "nothing opened by itself");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_machines_forwards_and_switches_are_forgotten_when_it_is_detached() {
        let (forwarder, _requests, _changes) = watched(true);
        let local = forwarder.forward(3000, None, false, None).await.unwrap().local_port;
        forwarder.set_settings(None, Some(true), None);
        forwarder.set_connected(None);
        assert_eq!(forwarder.forwards().len(), 1);
        // The registration loop ends: detached for good.
        forwarder.shutdown();
        assert!(forwarder.forwards().is_empty());
        assert_eq!(forwarder.settings(), PortSettings::default());
        forwarder.set_connected(Some(&ports(&["ports/1"])));
        assert!(forwarder.forwards().is_empty(), "nothing comes back");
        assert!(closed(local).await);
        // A machine's forwards are no organization's: a switch keeps them.
        forwarder.forward(3000, None, false, Some("org-a".into())).await.unwrap();
        forwarder.keep_scope(Some("org-b"));
        assert_eq!(forwarder.forwards().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forwarding_off_closes_every_listener_and_on_opens_them_again() {
        let (forwarder, mut requests, mut changes) = watched(false);
        assert_eq!(forwarder.settings(), PortSettings { enabled: true, auto: false });
        let forward = forwarder.forward(3000, None, false, None).await.unwrap();
        let local = forward.local_port;
        // A connection in flight is ended, and its stream closed in the workspace.
        let mut browser = connect(local).await;
        let open = next(&mut requests, "ports.open").await;
        forwarder.on_message(&json!({ "id": open["id"], "ok": true, "result": { "streamId": "port-1" } }));
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(forwarder.set_settings(Some(false), None, None), PortSettings { enabled: false, auto: false });
        assert_eq!(forwarder.forwards(), vec![Forward { state: ForwardState::Waiting, ..forward.clone() }]);
        assert_eq!(next(&mut requests, "ports.close").await["params"], json!({ "streamId": "port-1" }));
        assert_eq!(read_all(&mut browser).await, "");
        assert!(closed(local).await, "the listener is closed");
        assert_eq!(forwarder.forward(4000, None, false, None).await.unwrap_err(), "cloud_port_forwarding_off");
        let off = told(&mut changes).pop().unwrap();
        assert_eq!(off.settings, PortSettings { enabled: false, auto: false });

        // On again: the same forward, on the same local port.
        assert_eq!(forwarder.set_settings(Some(true), None, None), PortSettings { enabled: true, auto: false });
        assert_eq!(forwarder.forwards(), vec![forward]);
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, local)).await.is_ok());
        // Turned on by the person: nothing was "opened by itself".
        assert!(told(&mut changes).iter().all(|changed| changed.opened.is_empty()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn auto_forward_takes_only_ports_that_start_listening_after_it_is_turned_on() {
        let (forwarder, mut requests, mut changes) = watched(true);
        // Off by default: the runtime is not asked.
        assert!(tokio::time::timeout(AUTO_POLL + Duration::from_millis(500), requests.recv()).await.is_err());

        assert_eq!(forwarder.set_settings(None, Some(true), None), PortSettings { enabled: true, auto: true });
        // What already listens when it is turned on is left to the person.
        let list = next(&mut requests, "ports.list").await;
        assert!(list["id"].as_str().unwrap().starts_with(REQUEST_PREFIX), "the answer stays native");
        assert!(forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": { "detected": true, "ports": [{ "port": 3000 }], "streams": [] } })));
        assert!(forwarder.forwards().is_empty());

        // Two seconds later: 5173 and 40000 have started. 40000 is in the ephemeral range.
        let list = next(&mut requests, "ports.list").await;
        let listed = json!({ "detected": true, "ports": [{ "port": 3000 }, { "port": 5173, "process": { "name": "vite", "pid": 9 } }, { "port": 40000 }], "streams": [] });
        assert!(forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": listed })));
        let mut forwards = Vec::new();
        for _ in 0..100 {
            forwards = forwarder.forwards();
            if !forwards.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let [forward] = forwards.try_into().unwrap();
        assert!(forward.port == 5173 && forward.auto && forward.state == ForwardState::Open, "{forward:?}");
        // The same local port when it is free.
        assert!(forward.local_port == 5173 || forward.reassigned, "{forward:?}");
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, forward.local_port)).await.is_ok());
        assert!(told(&mut changes).iter().any(|changed| changed.opened == vec![forward.clone()]), "told for the toast");

        // Unforwarded by the person, it is not taken again while it keeps listening.
        assert!(forwarder.unforward(5173));
        let list = next(&mut requests, "ports.list").await;
        forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": listed }));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(forwarder.forwards().is_empty());

        // A list that cannot tell what listens forgets nothing.
        let list = next(&mut requests, "ports.list").await;
        forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": { "detected": false, "ports": [], "streams": [] } }));
        let list = next(&mut requests, "ports.list").await;
        forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": listed }));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(forwarder.forwards().is_empty(), "nothing looks new after a list that saw nothing");

        // Both servers stop, then start again: the one that listened before the
        // switch and the one the person stopped are new now, and taken.
        let list = next(&mut requests, "ports.list").await;
        forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": { "detected": true, "ports": [{ "port": 40000 }], "streams": [] } }));
        let list = next(&mut requests, "ports.list").await;
        forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": listed }));
        let mut taken = Vec::new();
        for _ in 0..100 {
            taken = forwarder.forwards().into_iter().map(|forward| forward.port).collect::<Vec<_>>();
            if taken.len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(taken, vec![3000, 5173], "a restarted server is auto-forwarded again; 40000 stays skipped");
        for port in [3000, 5173] {
            forwarder.unforward(port);
        }

        // Off: the runtime is no longer asked.
        forwarder.set_settings(None, Some(false), None);
        tokio::time::sleep(Duration::from_millis(100)).await;
        while requests.try_recv().is_ok() {}
        assert!(tokio::time::timeout(AUTO_POLL + Duration::from_millis(500), requests.recv()).await.is_err());
    }

    #[tokio::test]
    async fn a_cloud_dev_server_is_announced_promptly_and_skips_existing_and_ephemeral_ports() {
        let (forwarder, mut requests, mut changes) = watched(false);
        forwarder.forward(3000, None, false, None).await.unwrap();
        forwarder.set_settings(None, Some(true), Some("org-1".into()));
        let baseline = next(&mut requests, "ports.list").await;
        forwarder.on_message(&json!({ "id": baseline["id"], "ok": true, "result": { "detected": true, "ports": [] } }));

        let announced = tokio::time::timeout(Duration::from_secs(5), async {
            let list = next(&mut requests, "ports.list").await;
            forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": {
                "detected": true, "ports": [{ "port": 5173 }, { "port": 3000 }, { "port": 32768 }, { "port": 60999 }]
            } }));
            loop {
                let change = changes.recv().await.expect("forwarding change");
                if !change.opened.is_empty() {
                    break change;
                }
            }
        }).await.expect("5173 forwarded within five seconds");

        assert_eq!(announced.opened.len(), 1);
        let vite = &announced.opened[0];
        assert_eq!((vite.port, vite.auto, vite.state), (5173, true, ForwardState::Open));
        assert_eq!(announced.forwards.iter().map(|forward| forward.port).collect::<Vec<_>>(), vec![3000, 5173]);
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, vite.local_port)).await.is_ok());
    }

    #[tokio::test]
    async fn a_cancelled_poll_cannot_seed_or_open_for_a_new_poll() {
        let (forwarder, mut requests, _changes) = watched(false);
        forwarder.set_settings(None, Some(true), None);
        let old_poll = forwarder.inner.state.lock().unwrap().poll.clone().unwrap();
        forwarder.set_settings(None, Some(false), None);
        forwarder.set_settings(None, Some(true), None);
        forwarder.auto_forward(&json!({ "detected": true, "ports": [{ "port": 3000 }] }), &old_poll);
        assert!(forwarder.inner.state.lock().unwrap().seen.is_none());
        let _active = next(&mut requests, "ports.list").await;
        assert!(forwarder.open(5173, None, false, None, Some(&old_poll)).is_err());
        assert!(forwarder.forwards().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn auto_forward_takes_at_most_its_cap_and_never_a_privileged_local_port() {
        let (forwarder, mut requests, _changes) = watched(false);
        forwarder.set_settings(None, Some(true), None);
        let list = next(&mut requests, "ports.list").await;
        forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": { "detected": true, "ports": [], "streams": [] } }));
        // Then 80 and 30 ports start at once.
        let started: Vec<Value> = std::iter::once(80).chain(20000..20030).map(|port| json!({ "port": port })).collect();
        let list = next(&mut requests, "ports.list").await;
        forwarder.on_message(&json!({ "id": list["id"], "ok": true, "result": { "detected": true, "ports": started, "streams": [] } }));
        let mut forwards = Vec::new();
        for _ in 0..100 {
            forwards = forwarder.forwards();
            if !forwards.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(forwards.len(), MAX_AUTO_FORWARDS);
        let http = forwards.iter().find(|forward| forward.port == 80).expect("the lowest ports first");
        assert!(http.local_port >= 1024, "{http:?}");
        // The person may still forward more themselves.
        assert!(forwarder.forward(20031, None, false, None).await.is_ok());
    }

    #[test]
    fn auto_forward_skips_the_ephemeral_range() {
        for port in [32768, 45000, 60999] {
            assert!(AUTO_SKIPPED.contains(&port), "{port}");
        }
        for port in [3000, 5173, 8080, 32767, 61000] {
            assert!(!AUTO_SKIPPED.contains(&port), "{port}");
        }
    }

    #[tokio::test]
    async fn every_listener_binds_loopback_only() {
        assert_eq!(listen_on(0).unwrap().local_addr().unwrap().ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
        // Including one opened again on a named port (a forward that returns).
        let (listener, _) = bind(Some(listen_on(0).unwrap().local_addr().unwrap().port()), false).unwrap();
        assert_eq!(listener.local_addr().unwrap().ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
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
        assert_eq!(second.forward(5000, Some(free), true, None).await.unwrap(), Forward { port: 5000, local_port: free, reassigned: false, state: ForwardState::Open, auto: false });
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
