//! The runtime's side of `terminalx-workspace-rpc/1`: terminals, files, Git
//! and agent sessions of one workspace, served to attached clients.
//!
//! The transport (relay E2EE, or a test harness) hands each decrypted request
//! to [`WorkspaceRpc::handle`] with the [`Peer`] it arrived on and sends the
//! peer's queued notifications back. Nothing here trusts the client:
//! - Every call is authorized against the attachment's authority and the
//!   capabilities granted in `rpc.hello`, not only at attach time.
//! - Paths are workspace-relative and may not leave the workspace, through
//!   `..` or a symlink.
//! - Terminals and sessions are addressed by exact ids the runtime issued;
//!   there is no prefix matching.
//! - Mutations are answered from the idempotency cache when resent.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use super::protocol::{self, Authority, IdempotencyCache, RpcError, PROTOCOL};
use crate::events::AgentEvent;
use crate::pty::{PaneSpec, PtyData, PtyExit, Terminals};
use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_PTYS: usize = 16;
const MAX_EXITED_PTYS: usize = 8;
const PTY_RING_BYTES: usize = 1024 * 1024;
const MAX_READ_BYTES: u64 = 768 * 1024;
const MAX_DIFF_BYTES: usize = 768 * 1024;
const MAX_LIST_ENTRIES: usize = 5000;
const PTY_PREFIX: &str = "remote-pty-";

/// One attached client connection.
pub struct Peer {
    id: u64,
    /// The attachment's device; idempotency results are scoped to it so a
    /// reconnect of the same attachment replays, another attachment cannot.
    pub device_id: String,
    pub authority: Authority,
    outbound: mpsc::UnboundedSender<Value>,
    granted: Mutex<Option<HashSet<String>>>,
}

static NEXT_PEER: AtomicU64 = AtomicU64::new(1);

impl Peer {
    pub fn new(device_id: String, authority: Authority) -> (Arc<Self>, mpsc::UnboundedReceiver<Value>) {
        let (outbound, receiver) = mpsc::unbounded_channel();
        let peer = Arc::new(Self {
            id: NEXT_PEER.fetch_add(1, Ordering::Relaxed),
            device_id,
            authority,
            outbound,
            granted: Mutex::new(None),
        });
        (peer, receiver)
    }

    fn notify(&self, event: &str, params: Value) {
        let _ = self.outbound.send(json!({ "event": event, "params": params }));
    }
}

struct PtyState {
    ring: VecDeque<u8>,
    /// Byte offset one past the last byte ever written by the terminal.
    end: u64,
    exit: Option<Option<i32>>,
    exited_at: Option<Instant>,
    /// Last applied `pty.write` seq per device, so a resend is dropped.
    applied_seq: HashMap<String, u64>,
    subscribers: HashMap<String, Arc<Peer>>,
}

impl PtyState {
    fn start(&self) -> u64 {
        self.end - self.ring.len() as u64
    }
}

struct SessionSubscription {
    peer: Arc<Peer>,
    session_id: String,
    tab_id: String,
    /// Live events that arrived while the replay was being read.
    buffered: Option<Vec<AgentEvent>>,
    last_seq: u64,
}

enum Subscription {
    Pty { peer: u64, pty_id: String },
    Session { peer: u64 },
    Fs { peer: u64, _watcher: Box<dyn Send> },
}

impl Subscription {
    fn peer(&self) -> u64 {
        match self {
            Self::Pty { peer, .. } | Self::Session { peer } | Self::Fs { peer, .. } => *peer,
        }
    }
}

type Gate = Arc<tokio::sync::Mutex<()>>;

pub struct WorkspaceRpc {
    root: PathBuf,
    /// The generation the relay host registered with; offsets and cursors
    /// are bound to it.
    generation: AtomicU64,
    version: String,
    sink: Arc<dyn EventSink>,
    terminals: Arc<Terminals>,
    sessions: Option<SessionManager>,
    ptys: Mutex<HashMap<String, PtyState>>,
    session_subs: Mutex<HashMap<String, SessionSubscription>>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    idempotency: Mutex<IdempotencyCache>,
    /// One lock per `(attachment, clientRequestId)` in flight, so a resend
    /// racing its original waits for the cached result instead of running
    /// twice, while unrelated mutations proceed.
    in_flight: Mutex<HashMap<(String, String), Gate>>,
    /// Sessions a `participate` attachment may see. Nothing shares a session
    /// yet, so participants see none (fail closed).
    shared_sessions: Mutex<HashSet<String>>,
}

impl WorkspaceRpc {
    /// `sessions` is absent only in tests that do not need agents.
    pub fn new(
        root: &Path,
        generation: u64,
        sink: Arc<dyn EventSink>,
        terminals: Arc<Terminals>,
        sessions: Option<SessionManager>,
    ) -> anyhow::Result<Arc<Self>> {
        let root = std::fs::canonicalize(root)?;
        let rpc = Arc::new(Self {
            root,
            generation: AtomicU64::new(generation),
            version: env!("CARGO_PKG_VERSION").into(),
            sink: sink.clone(),
            terminals,
            sessions,
            ptys: Mutex::new(HashMap::new()),
            session_subs: Mutex::new(HashMap::new()),
            subscriptions: Mutex::new(HashMap::new()),
            idempotency: Mutex::new(IdempotencyCache::default()),
            in_flight: Mutex::new(HashMap::new()),
            shared_sessions: Mutex::new(HashSet::new()),
        });
        // Listeners run inline on the emitting thread, so no output is lost
        // to a lagging broadcast and offsets stay exact.
        let weak = Arc::downgrade(&rpc);
        sink.listen(
            "pty_data",
            Box::new(move |payload| {
                if let (Some(rpc), Ok(data)) = (weak.upgrade(), serde_json::from_str::<PtyData>(payload)) {
                    rpc.on_pty_data(data);
                }
            }),
        );
        let weak = Arc::downgrade(&rpc);
        sink.listen(
            "pty_exit",
            Box::new(move |payload| {
                if let (Some(rpc), Ok(exit)) = (weak.upgrade(), serde_json::from_str::<PtyExit>(payload)) {
                    rpc.on_pty_exit(exit);
                }
            }),
        );
        let weak = Arc::downgrade(&rpc);
        sink.listen(
            "agent_event",
            Box::new(move |payload| {
                if let (Some(rpc), Ok(event)) = (weak.upgrade(), serde_json::from_str::<AgentEvent>(payload)) {
                    rpc.on_agent_event(event);
                }
            }),
        );
        Ok(rpc)
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Follow the relay host when it registers a newer generation.
    pub fn set_generation(&self, generation: u64) {
        self.generation.store(generation, Ordering::SeqCst);
    }

    /// Answer one request. Returns the response frame; notifications for
    /// this peer go through its outbound queue.
    pub async fn handle(self: &Arc<Self>, peer: &Arc<Peer>, request: &Value) -> Value {
        let id = request.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let method = request.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        match self.dispatch(peer, &method, params).await {
            Ok(result) => protocol::success(&id, result),
            Err(error) => protocol::failure(&id, &error),
        }
    }

    async fn dispatch(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, RpcError> {
        if method == "rpc.hello" {
            let granted = protocol::negotiate(&params)?;
            *peer.granted.lock().unwrap() = Some(granted.iter().cloned().collect());
            return Ok(json!({
                "protocol": PROTOCOL,
                "runtime": { "version": self.version, "runtimeGeneration": self.generation() },
                "capabilities": granted,
                "authority": peer.authority,
                "limits": { "maxFrameBytes": MAX_FRAME_BYTES, "maxPtys": MAX_PTYS },
            }));
        }
        let Some(spec) = protocol::find_method(method) else {
            return Err(RpcError::new("method_not_found", format!("{method} is not a workspace method")));
        };
        match &*peer.granted.lock().unwrap() {
            None => return Err(RpcError::new("hello_required", "call rpc.hello first")),
            Some(granted) if !granted.contains(spec.capability) => {
                return Err(RpcError::new("capability_not_granted", format!("{} was not granted", spec.capability)))
            }
            Some(_) => {}
        }
        if peer.authority < spec.authority {
            return Err(RpcError::forbidden(format!("{method} needs manage authority")));
        }
        if !spec.idempotent {
            return self.execute(peer, method, params).await;
        }
        let request_id = params
            .get("clientRequestId")
            .and_then(Value::as_str)
            .filter(|value| protocol::valid_client_request_id(value))
            .ok_or_else(|| RpcError::invalid("clientRequestId is required for this method"))?
            .to_string();
        let key = (peer.device_id.clone(), request_id.clone());
        let gate = self.in_flight.lock().unwrap().entry(key.clone()).or_default().clone();
        let result = {
            let _serial = gate.lock().await;
            let previous = self.idempotency.lock().unwrap().get(&peer.device_id, &request_id, Instant::now());
            match previous {
                Some(previous) => previous,
                None => {
                    let result = self.execute(peer, method, params).await;
                    self.idempotency.lock().unwrap().put(&peer.device_id, &request_id, &result, Instant::now());
                    result
                }
            }
        };
        let mut in_flight = self.in_flight.lock().unwrap();
        if in_flight.get(&key).is_some_and(|current| Arc::ptr_eq(current, &gate) && Arc::strong_count(&gate) <= 2) {
            in_flight.remove(&key);
        }
        result
    }

    async fn execute(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, RpcError> {
        let rpc = self.clone();
        let peer = peer.clone();
        let method = method.to_string();
        // File, Git and process work blocks; keep it off the socket's task.
        tokio::task::spawn_blocking(move || rpc.execute_blocking(&peer, &method, params))
            .await
            .map_err(RpcError::internal)?
    }

    fn execute_blocking(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "pty.create" => self.pty_create(params),
            "pty.write" => self.pty_write(peer, params),
            "pty.resize" => self.pty_resize(params),
            "pty.kill" => self.pty_kill(params),
            "pty.attach" => self.pty_attach(peer, params),
            "pty.detach" | "session.unsubscribe" | "fs.unwatch" => self.unsubscribe(peer, params),
            "fs.list" => self.fs_list(params),
            "fs.stat" => self.fs_stat(params),
            "fs.read" => self.fs_read(params),
            "fs.write" => self.fs_write(params),
            "fs.rename" => self.fs_rename(params),
            "fs.delete" => self.fs_delete(params),
            "fs.mkdir" => self.fs_mkdir(params),
            "fs.watch" => self.fs_watch(peer, params),
            "git.status" => self.git_status(params),
            "git.diff" => self.git_diff(params),
            "git.log" => self.git_log(params),
            "git.branches" => self.git_branches(),
            "git.checkout" => self.git_checkout(params),
            "git.commit" => self.git_commit(params),
            "git.stage" => self.git_paths(params, &["add", "--"]),
            "git.unstage" => self.git_paths(params, &["restore", "--staged", "--"]),
            "git.push" => crate::git::push(&self.root).map(|output| json!({ "output": output })).map_err(git_error),
            "git.pull" => crate::git::pull(&self.root).map(|output| json!({ "output": output })).map_err(git_error),
            "session.list" => self.session_list(peer),
            "session.get" => self.session_get(peer, params),
            "session.create" => self.session_create(params),
            "session.close" => self.session_close(params),
            "session.send" => self.session_send(peer, params),
            "session.subscribe" => self.session_subscribe(peer, params),
            other => Err(RpcError::new("method_not_found", format!("{other} is not a workspace method"))),
        }
    }

    /// Drop everything a closed connection subscribed to.
    pub fn disconnect(&self, peer: &Peer) {
        let doomed: Vec<(String, Subscription)> = {
            let mut subscriptions = self.subscriptions.lock().unwrap();
            let ids: Vec<String> =
                subscriptions.iter().filter(|(_, sub)| sub.peer() == peer.id).map(|(id, _)| id.clone()).collect();
            ids.into_iter().filter_map(|id| subscriptions.remove(&id).map(|sub| (id, sub))).collect()
        };
        for (id, subscription) in doomed {
            self.drop_subscription(&id, subscription);
        }
    }

    fn drop_subscription(&self, id: &str, subscription: Subscription) {
        match subscription {
            Subscription::Pty { pty_id, .. } => {
                if let Some(pty) = self.ptys.lock().unwrap().get_mut(&pty_id) {
                    pty.subscribers.remove(id);
                }
            }
            Subscription::Session { .. } => {
                self.session_subs.lock().unwrap().remove(id);
            }
            Subscription::Fs { .. } => {}
        }
    }

    fn unsubscribe(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let id = required_str(&params, "subscriptionId")?;
        let mut subscriptions = self.subscriptions.lock().unwrap();
        match subscriptions.get(id) {
            Some(subscription) if subscription.peer() == peer.id => {
                let subscription = subscriptions.remove(id).unwrap();
                drop(subscriptions);
                self.drop_subscription(id, subscription);
                Ok(json!({}))
            }
            _ => Err(RpcError::not_found("no such subscription on this connection")),
        }
    }

    fn subscription_id() -> String {
        format!("sub-{}", uuid::Uuid::new_v4().simple())
    }

    // ---- terminals -------------------------------------------------------

    fn pty_create(&self, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            #[serde(default = "default_cols")]
            cols: u16,
            #[serde(default = "default_rows")]
            rows: u16,
            #[serde(default)]
            cwd: Option<String>,
            #[allow(dead_code)]
            client_request_id: String,
        }
        let p: Params = parse(params)?;
        if p.cols == 0 || p.rows == 0 || p.cols > 1000 || p.rows > 1000 {
            return Err(RpcError::invalid("cols and rows must be between 1 and 1000"));
        }
        let cwd = match &p.cwd {
            Some(relative) => self.existing_path(relative)?,
            None => self.root.clone(),
        };
        if !cwd.is_dir() {
            return Err(RpcError::invalid("cwd is not a directory"));
        }
        let pty_id = format!("{PTY_PREFIX}{}", uuid::Uuid::new_v4().simple());
        {
            let mut ptys = self.ptys.lock().unwrap();
            if ptys.values().filter(|pty| pty.exit.is_none()).count() >= MAX_PTYS {
                return Err(RpcError::new("unavailable", format!("at most {MAX_PTYS} terminals may run at once")));
            }
            ptys.insert(
                pty_id.clone(),
                PtyState {
                    ring: VecDeque::new(),
                    end: 0,
                    exit: None,
                    exited_at: None,
                    applied_seq: HashMap::new(),
                    subscribers: HashMap::new(),
                },
            );
        }
        let cwd = cwd.to_string_lossy().into_owned();
        let spec = PaneSpec { cwd: &cwd, cols: p.cols, rows: p.rows, command: None, env: &[] };
        if let Err(error) = self.terminals.spawn(self.sink.clone(), &pty_id, spec) {
            self.ptys.lock().unwrap().remove(&pty_id);
            return Err(RpcError::internal(error));
        }
        Ok(json!({ "ptyId": pty_id }))
    }

    fn pty_write(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            pty_id: String,
            data: String,
            seq: u64,
        }
        let p: Params = parse(params)?;
        {
            let mut ptys = self.ptys.lock().unwrap();
            let pty = ptys.get_mut(&p.pty_id).ok_or_else(|| RpcError::not_found("no such terminal"))?;
            if pty.exit.is_some() {
                return Err(RpcError::new("unavailable", "the terminal has exited"));
            }
            let applied = pty.applied_seq.entry(peer.device_id.clone()).or_insert(0);
            if p.seq <= *applied {
                return Ok(json!({ "applied": false, "seq": *applied }));
            }
            *applied = p.seq;
        }
        self.terminals.write(&p.pty_id, p.data.as_bytes()).map_err(RpcError::internal)?;
        Ok(json!({ "applied": true, "seq": p.seq }))
    }

    fn pty_resize(&self, params: Value) -> Result<Value, RpcError> {
        let pty_id = self.known_pty(&params)?;
        let cols = params.get("cols").and_then(Value::as_u64).filter(|v| (1..=1000).contains(v));
        let rows = params.get("rows").and_then(Value::as_u64).filter(|v| (1..=1000).contains(v));
        let (Some(cols), Some(rows)) = (cols, rows) else {
            return Err(RpcError::invalid("cols and rows must be between 1 and 1000"));
        };
        self.terminals.resize(&pty_id, cols as u16, rows as u16).map_err(RpcError::internal)?;
        Ok(json!({}))
    }

    fn pty_kill(&self, params: Value) -> Result<Value, RpcError> {
        let pty_id = self.known_pty(&params)?;
        self.terminals.kill(&pty_id);
        Ok(json!({}))
    }

    fn known_pty(&self, params: &Value) -> Result<String, RpcError> {
        let pty_id = required_str(params, "ptyId")?;
        if !self.ptys.lock().unwrap().contains_key(pty_id) {
            return Err(RpcError::not_found("no such terminal"));
        }
        Ok(pty_id.to_string())
    }

    fn pty_attach(&self, peer: &Arc<Peer>, params: Value) -> Result<Value, RpcError> {
        let pty_id = required_str(&params, "ptyId")?.to_string();
        let since = params.get("sinceOffset").and_then(Value::as_u64);
        if since.is_some() && params.get("runtimeGeneration").and_then(Value::as_u64) != Some(self.generation()) {
            return Err(RpcError::new("cursor_expired", "the offset belongs to another runtime generation"));
        }
        let subscription_id = Self::subscription_id();
        let mut ptys = self.ptys.lock().unwrap();
        let pty = ptys.get_mut(&pty_id).ok_or_else(|| RpcError::not_found("no such terminal"))?;
        let start = pty.start();
        let from = since.unwrap_or(start).clamp(start, pty.end);
        let skip = (from - start) as usize;
        let replay: Vec<u8> = pty.ring.iter().skip(skip).copied().collect();
        pty.subscribers.insert(subscription_id.clone(), peer.clone());
        let result = json!({
            "subscriptionId": subscription_id,
            "ptyId": pty_id,
            "offset": from,
            "data": STANDARD.encode(&replay),
            "truncated": since.is_some_and(|since| since < start),
            "exited": pty.exit.is_some(),
            "exitCode": pty.exit.flatten(),
            "runtimeGeneration": self.generation(),
        });
        drop(ptys);
        self.subscriptions.lock().unwrap().insert(subscription_id, Subscription::Pty { peer: peer.id, pty_id });
        Ok(result)
    }

    fn on_pty_data(&self, data: PtyData) {
        if !data.id.starts_with(PTY_PREFIX) {
            return;
        }
        let Ok(bytes) = STANDARD.decode(&data.data) else { return };
        let mut ptys = self.ptys.lock().unwrap();
        let Some(pty) = ptys.get_mut(&data.id) else { return };
        let offset = pty.end;
        pty.end += bytes.len() as u64;
        pty.ring.extend(bytes.iter().copied());
        let excess = pty.ring.len().saturating_sub(PTY_RING_BYTES);
        pty.ring.drain(..excess);
        for (subscription_id, peer) in &pty.subscribers {
            peer.notify(
                "pty.output",
                json!({ "subscriptionId": subscription_id, "ptyId": data.id, "offset": offset, "data": data.data }),
            );
        }
    }

    fn on_pty_exit(&self, exit: PtyExit) {
        let mut ptys = self.ptys.lock().unwrap();
        let Some(pty) = ptys.get_mut(&exit.id) else { return };
        pty.exit = Some(exit.code);
        pty.exited_at = Some(Instant::now());
        for (subscription_id, peer) in &pty.subscribers {
            peer.notify(
                "pty.exit",
                json!({ "subscriptionId": subscription_id, "ptyId": exit.id, "code": exit.code, "offset": pty.end }),
            );
        }
        // Exited terminals keep their output for a late reader, up to a
        // bound: the oldest are dropped first.
        let mut exited: Vec<(Instant, String)> =
            ptys.iter().filter_map(|(id, pty)| pty.exited_at.map(|at| (at, id.clone()))).collect();
        if exited.len() > MAX_EXITED_PTYS {
            exited.sort();
            for (_, id) in exited.drain(..exited.len() - MAX_EXITED_PTYS) {
                ptys.remove(&id);
            }
        }
    }

    // ---- files -----------------------------------------------------------

    /// A workspace-relative path, lexically: no root, drive or `..`.
    fn lexical(&self, relative: &str) -> Result<PathBuf, RpcError> {
        if relative.len() > 4096 || relative.contains('\0') {
            return Err(RpcError::new("path_forbidden", "invalid path"));
        }
        let mut clean = PathBuf::new();
        for component in Path::new(relative).components() {
            match component {
                Component::Normal(part) => clean.push(part),
                Component::CurDir => {}
                _ => return Err(RpcError::new("path_forbidden", "paths are workspace-relative and may not leave it")),
            }
        }
        Ok(self.root.join(clean))
    }

    /// An existing path, resolved through symlinks, still inside the workspace.
    fn existing_path(&self, relative: &str) -> Result<PathBuf, RpcError> {
        let path = self.lexical(relative)?;
        let resolved = std::fs::canonicalize(&path).map_err(|_| RpcError::not_found("no such path"))?;
        if !resolved.starts_with(&self.root) {
            return Err(RpcError::new("path_forbidden", "the path resolves outside the workspace"));
        }
        Ok(resolved)
    }

    /// A directory entry itself, not what it may link to: its parent must
    /// resolve inside the workspace.
    fn entry_path(&self, relative: &str) -> Result<PathBuf, RpcError> {
        let path = self.lexical(relative)?;
        if path == self.root {
            return Err(RpcError::new("path_forbidden", "the workspace root cannot be replaced"));
        }
        let parent = path.parent().ok_or_else(|| RpcError::new("path_forbidden", "invalid path"))?;
        let parent = std::fs::canonicalize(parent).map_err(|_| RpcError::not_found("the parent directory does not exist"))?;
        if !parent.starts_with(&self.root) {
            return Err(RpcError::new("path_forbidden", "the path resolves outside the workspace"));
        }
        Ok(parent.join(path.file_name().expect("a normal component")))
    }

    /// A path to write through: a symlink there must point inside the workspace.
    fn new_path(&self, relative: &str) -> Result<PathBuf, RpcError> {
        let path = self.entry_path(relative)?;
        if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return self.existing_path(relative);
        }
        Ok(path)
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root).unwrap_or(path).to_string_lossy().into_owned()
    }

    fn fs_list(&self, params: Value) -> Result<Value, RpcError> {
        let dir = self.existing_path(params.get("path").and_then(Value::as_str).unwrap_or(""))?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(RpcError::internal)? {
            let Ok(entry) = entry else { continue };
            let Ok(meta) = entry.metadata() else { continue };
            entries.push(stat_json(&entry.file_name().to_string_lossy(), &meta));
            if entries.len() >= MAX_LIST_ENTRIES {
                break;
            }
        }
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(json!({ "path": self.relative(&dir), "entries": entries, "truncated": entries.len() >= MAX_LIST_ENTRIES }))
    }

    fn fs_stat(&self, params: Value) -> Result<Value, RpcError> {
        let path = self.existing_path(required_str(&params, "path")?)?;
        let meta = std::fs::metadata(&path).map_err(RpcError::internal)?;
        let mut stat = stat_json(&self.relative(&path), &meta);
        if meta.is_file() && meta.len() <= MAX_READ_BYTES {
            stat["etag"] = json!(etag(&std::fs::read(&path).map_err(RpcError::internal)?));
        }
        Ok(stat)
    }

    fn fs_read(&self, params: Value) -> Result<Value, RpcError> {
        let path = self.existing_path(required_str(&params, "path")?)?;
        let meta = std::fs::metadata(&path).map_err(RpcError::internal)?;
        if !meta.is_file() {
            return Err(RpcError::invalid("not a file"));
        }
        if meta.len() > MAX_READ_BYTES {
            return Err(RpcError::new("too_large", format!("files over {MAX_READ_BYTES} bytes cannot be read remotely")));
        }
        let bytes = std::fs::read(&path).map_err(RpcError::internal)?;
        let tag = etag(&bytes);
        Ok(match String::from_utf8(bytes) {
            Ok(text) => json!({ "path": self.relative(&path), "text": text, "etag": tag, "size": meta.len() }),
            Err(error) => json!({ "path": self.relative(&path), "dataB64": STANDARD.encode(error.as_bytes()), "etag": tag, "size": meta.len() }),
        })
    }

    fn fs_write(&self, params: Value) -> Result<Value, RpcError> {
        let path = self.new_path(required_str(&params, "path")?)?;
        let bytes = match (params.get("text").and_then(Value::as_str), params.get("dataB64").and_then(Value::as_str)) {
            (Some(text), None) => text.as_bytes().to_vec(),
            (None, Some(data)) => STANDARD.decode(data).map_err(|_| RpcError::invalid("dataB64 is not base64"))?,
            _ => return Err(RpcError::invalid("pass exactly one of text or dataB64")),
        };
        if bytes.len() as u64 > MAX_READ_BYTES {
            return Err(RpcError::new("too_large", "the file is too large to write remotely"));
        }
        // `expectedEtag`: a string must match the current file, null means the
        // file must not exist yet, absent writes unconditionally.
        if let Some(expected) = params.get("expectedEtag") {
            let current = match std::fs::read(&path) {
                Ok(current) => Some(etag(&current)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(RpcError::internal(error)),
            };
            if expected.as_str().map(str::to_string) != current {
                return Err(RpcError::new("conflict", "the file changed since it was read"));
            }
        }
        if path.is_dir() {
            return Err(RpcError::invalid("the path is a directory"));
        }
        let temporary = path.with_file_name(format!(
            ".{}.terminalx-{}",
            path.file_name().unwrap().to_string_lossy(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&temporary, &bytes).map_err(RpcError::internal)?;
        if let Err(error) = std::fs::rename(&temporary, &path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(RpcError::internal(error));
        }
        Ok(json!({ "path": self.relative(&path), "etag": etag(&bytes), "size": bytes.len() }))
    }

    fn fs_rename(&self, params: Value) -> Result<Value, RpcError> {
        let from = self.entry_path(required_str(&params, "from")?)?;
        let to = self.entry_path(required_str(&params, "to")?)?;
        if std::fs::symlink_metadata(&from).is_err() {
            return Err(RpcError::not_found("no such path"));
        }
        if std::fs::symlink_metadata(&to).is_ok() {
            return Err(RpcError::new("conflict", "the destination exists"));
        }
        std::fs::rename(&from, &to).map_err(RpcError::internal)?;
        Ok(json!({ "from": self.relative(&from), "to": self.relative(&to) }))
    }

    fn fs_delete(&self, params: Value) -> Result<Value, RpcError> {
        let relative = required_str(&params, "path")?;
        // Delete the link itself, never what it points at.
        let path = self.entry_path(relative)?;
        let meta = std::fs::symlink_metadata(&path).map_err(|_| RpcError::not_found("no such path"))?;
        if meta.is_dir() {
            if params.get("recursive").and_then(Value::as_bool) == Some(true) {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_dir(&path)
            }
        } else {
            std::fs::remove_file(&path)
        }
        .map_err(RpcError::internal)?;
        Ok(json!({ "path": self.relative(&path) }))
    }

    fn fs_mkdir(&self, params: Value) -> Result<Value, RpcError> {
        let path = self.new_path(required_str(&params, "path")?)?;
        match std::fs::create_dir(&path) {
            Ok(()) => Ok(json!({ "path": self.relative(&path), "created": true })),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => {
                Ok(json!({ "path": self.relative(&path), "created": false }))
            }
            Err(error) => Err(RpcError::internal(error)),
        }
    }

    fn fs_watch(&self, peer: &Arc<Peer>, params: Value) -> Result<Value, RpcError> {
        use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
        let path = self.existing_path(params.get("path").and_then(Value::as_str).unwrap_or(""))?;
        let subscription_id = Self::subscription_id();
        let root = self.root.clone();
        let notify_peer = peer.clone();
        let id = subscription_id.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(250), move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let paths: Vec<String> = events
                .iter()
                .filter_map(|event| event.path.strip_prefix(&root).ok())
                .filter(|path| !path.starts_with(".git"))
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                notify_peer.notify("fs.changed", json!({ "subscriptionId": id, "paths": paths }));
            }
        })
        .map_err(RpcError::internal)?;
        debouncer.watcher().watch(&path, RecursiveMode::Recursive).map_err(RpcError::internal)?;
        self.subscriptions
            .lock()
            .unwrap()
            .insert(subscription_id.clone(), Subscription::Fs { peer: peer.id, _watcher: Box::new(debouncer) });
        Ok(json!({ "subscriptionId": subscription_id, "path": self.relative(&path) }))
    }

    // ---- git -------------------------------------------------------------

    fn git_status(&self, _params: Value) -> Result<Value, RpcError> {
        if !crate::git::is_repo(&self.root) {
            return Ok(json!({ "repository": false }));
        }
        let porcelain = crate::git::run(&self.root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])
            .map_err(git_error)?;
        let mut files = Vec::new();
        let mut parts = porcelain.split('\0').filter(|part| !part.is_empty());
        while let Some(entry) = parts.next() {
            if entry.len() < 4 {
                continue;
            }
            let (index, worktree, path) = (&entry[0..1], &entry[1..2], &entry[3..]);
            let mut file = json!({ "path": path, "index": index, "worktree": worktree });
            if index == "R" || index == "C" {
                file["from"] = json!(parts.next());
            }
            files.push(file);
        }
        let (ahead, behind) = crate::git::upstream_counts(&self.root);
        Ok(json!({
            "repository": true,
            "branch": crate::git::current_branch(&self.root),
            "head": crate::git::head_commit(&self.root),
            "ahead": ahead,
            "behind": behind,
            "files": files,
        }))
    }

    fn git_diff(&self, params: Value) -> Result<Value, RpcError> {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
        if params.get("staged").and_then(Value::as_bool) == Some(true) {
            args.push("--cached");
        }
        args.push("--");
        let path = match params.get("path").and_then(Value::as_str) {
            Some(path) => Some(self.git_path(path)?),
            None => None,
        };
        if let Some(path) = &path {
            args.push(path);
        }
        let mut diff = crate::git::run(&self.root, &args).map_err(git_error)?;
        let truncated = diff.len() > MAX_DIFF_BYTES;
        if truncated {
            let mut cut = MAX_DIFF_BYTES;
            while !diff.is_char_boundary(cut) {
                cut -= 1;
            }
            diff.truncate(cut);
        }
        Ok(json!({ "diff": diff, "truncated": truncated }))
    }

    fn git_log(&self, params: Value) -> Result<Value, RpcError> {
        let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 500) as u32;
        let commits = crate::git::log_commits(&self.root, None, limit).map_err(git_error)?;
        Ok(json!({ "commits": commits }))
    }

    fn git_branches(&self) -> Result<Value, RpcError> {
        let branches = crate::git::list_branches(&self.root).map_err(git_error)?;
        Ok(json!({ "branches": branches, "current": crate::git::current_branch(&self.root) }))
    }

    fn git_checkout(&self, params: Value) -> Result<Value, RpcError> {
        let branch = required_str(&params, "branch")?;
        if !valid_ref_name(branch) {
            return Err(RpcError::invalid("invalid branch name"));
        }
        let create = params.get("create").and_then(Value::as_bool).unwrap_or(false);
        crate::git::checkout_branch(&self.root, branch, create).map_err(git_error)?;
        Ok(json!({ "branch": branch }))
    }

    fn git_commit(&self, params: Value) -> Result<Value, RpcError> {
        let message = required_str(&params, "message")?;
        if message.trim().is_empty() || message.len() > 64 * 1024 {
            return Err(RpcError::invalid("a commit message is required"));
        }
        let paths = match params.get("paths").and_then(Value::as_array) {
            Some(paths) => Some(
                paths
                    .iter()
                    .map(|path| path.as_str().ok_or_else(|| RpcError::invalid("paths must be strings")).and_then(|p| self.git_path(p)))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            None => None,
        };
        let commit = crate::git::commit_all(&self.root, message, paths.as_deref()).map_err(git_error)?;
        Ok(json!({ "commit": commit }))
    }

    fn git_paths(&self, params: Value, prefix: &[&str]) -> Result<Value, RpcError> {
        let paths = params
            .get("paths")
            .and_then(Value::as_array)
            .filter(|paths| !paths.is_empty() && paths.len() <= 1000)
            .ok_or_else(|| RpcError::invalid("paths must list 1 to 1000 paths"))?
            .iter()
            .map(|path| path.as_str().ok_or_else(|| RpcError::invalid("paths must be strings")).and_then(|p| self.git_path(p)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut args: Vec<&str> = prefix.to_vec();
        args.extend(paths.iter().map(String::as_str));
        crate::git::run(&self.root, &args).map_err(git_error)?;
        Ok(json!({ "paths": paths }))
    }

    /// A path for Git: workspace-relative and lexically inside it. Git
    /// itself refuses paths outside the repository.
    fn git_path(&self, relative: &str) -> Result<String, RpcError> {
        let path = self.lexical(relative)?;
        let relative = self.relative(&path);
        Ok(if relative.is_empty() { ".".into() } else { relative })
    }

    // ---- sessions --------------------------------------------------------

    fn manager(&self) -> Result<&SessionManager, RpcError> {
        self.sessions.as_ref().ok_or_else(|| RpcError::new("unavailable", "agents are not running in this runtime"))
    }

    fn visible_sessions(&self, peer: &Peer) -> Result<Vec<SessionEntry>, RpcError> {
        let root = self.root.to_string_lossy();
        let shared = self.shared_sessions.lock().unwrap().clone();
        Ok(index::load()
            .map_err(RpcError::internal)?
            .into_iter()
            .filter(|session| session.project_path == root)
            .filter(|session| peer.authority == Authority::Manage || shared.contains(&session.id))
            .collect())
    }

    fn visible_session(&self, peer: &Peer, session_id: &str) -> Result<SessionEntry, RpcError> {
        self.visible_sessions(peer)?
            .into_iter()
            .find(|session| session.id == session_id)
            .ok_or_else(|| RpcError::not_found("no such session"))
    }

    fn session_list(&self, peer: &Peer) -> Result<Value, RpcError> {
        Ok(json!({ "sessions": self.visible_sessions(peer)? }))
    }

    fn session_get(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        Ok(json!({ "session": session, "runningTabs": self.manager().map(|m| m.running_tabs()).unwrap_or_default() }))
    }

    fn session_create(&self, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            agent: String,
            #[serde(default)]
            prompt: Option<String>,
            #[serde(default)]
            model: String,
            #[serde(default)]
            effort: Option<String>,
            #[serde(default)]
            mode: Option<String>,
            #[serde(default)]
            use_worktree: bool,
            #[serde(default)]
            title: Option<String>,
        }
        let p: Params = parse(params)?;
        let manager = self.manager()?;
        if let Some(mode) = p.mode.as_deref() {
            if !matches!(mode, "plan" | "manual" | "auto" | "acceptEdits" | "bypassPermissions") {
                return Err(RpcError::invalid(format!("unknown permission mode {mode}")));
            }
        }
        let agent = crate::harness::offered()
            .into_iter()
            .find(|harness| harness.id == p.agent)
            .ok_or_else(|| RpcError::invalid(format!("agent {} is not offered", p.agent)))?;
        if !agent.available {
            return Err(RpcError::new("unavailable", format!("{} is not installed in this workspace", agent.name)));
        }
        let entry = crate::session_ops::create_session_blocking(
            &*self.sink,
            crate::session_ops::NewSession {
                project_path: self.root.to_string_lossy().into_owned(),
                title: p.title,
                use_worktree: p.use_worktree,
                on_main: !p.use_worktree,
                base_ref: None,
                worktree_name: None,
                issue: None,
                automation: None,
                cwd: None,
                tab: Some(crate::session_ops::NewTab {
                    harness: p.agent,
                    model: p.model,
                    effort: p.effort,
                    permission_mode: p.mode,
                }),
            },
        )
        .map_err(RpcError::internal)?;
        let tab = entry.tabs.first().cloned().ok_or_else(|| RpcError::internal("the new session has no tab"))?;
        let outcome = match p.prompt.filter(|prompt| !prompt.trim().is_empty()) {
            Some(prompt) => Some(manager.send(&entry.id, &tab.id, prompt, Vec::new()).map_err(RpcError::internal)?),
            None => None,
        };
        Ok(json!({ "sessionId": entry.id, "tabId": tab.id, "session": entry, "outcome": outcome }))
    }

    fn session_close(&self, params: Value) -> Result<Value, RpcError> {
        let manager = self.manager()?;
        let session = index::load()
            .map_err(RpcError::internal)?
            .into_iter()
            .find(|session| Some(session.id.as_str()) == params.get("sessionId").and_then(Value::as_str))
            .filter(|session| session.project_path == self.root.to_string_lossy())
            .ok_or_else(|| RpcError::not_found("no such session"))?;
        let only = params.get("tabId").and_then(Value::as_str);
        for tab in session.tabs.iter().filter(|tab| only.is_none_or(|id| id == tab.id)) {
            manager.stop(&session.id, &tab.id).map_err(RpcError::internal)?;
        }
        Ok(json!({ "sessionId": session.id }))
    }

    fn session_send(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let tab_id = required_str(&params, "tabId")?;
        let tab = session.tabs.iter().find(|tab| tab.id == tab_id).ok_or_else(|| RpcError::not_found("no such tab"))?;
        let text = required_str(&params, "text")?;
        if text.trim().is_empty() {
            return Err(RpcError::invalid("text is empty"));
        }
        let outcome = self.manager()?.send(&session.id, &tab.id, text.to_string(), Vec::new()).map_err(RpcError::internal)?;
        Ok(json!({ "sessionId": session.id, "tabId": tab.id, "outcome": outcome }))
    }

    /// Replay a tab's events after `sinceCursor`, then stream live ones.
    fn session_subscribe(&self, peer: &Arc<Peer>, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let tab_id = required_str(&params, "tabId")?.to_string();
        if !session.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err(RpcError::not_found("no such tab"));
        }
        let since = match params.get("sinceCursor").and_then(Value::as_str) {
            Some(cursor) => Some(self.parse_cursor(cursor)?),
            None => None,
        };
        let subscription_id = Self::subscription_id();
        // Register first and buffer, so an event emitted during the replay
        // read is neither lost nor sent twice.
        self.session_subs.lock().unwrap().insert(
            subscription_id.clone(),
            SessionSubscription {
                peer: peer.clone(),
                session_id: session.id.clone(),
                tab_id: tab_id.clone(),
                buffered: Some(Vec::new()),
                last_seq: 0,
            },
        );
        self.subscriptions.lock().unwrap().insert(subscription_id.clone(), Subscription::Session { peer: peer.id });
        let events = match self.manager().and_then(|m| m.load_events(&session.id, &tab_id).map_err(RpcError::internal)) {
            Ok(events) => events,
            Err(error) => {
                self.session_subs.lock().unwrap().remove(&subscription_id);
                self.subscriptions.lock().unwrap().remove(&subscription_id);
                return Err(error);
            }
        };
        let replay: Vec<Value> = events
            .into_iter()
            .filter(|event| since.is_none_or(|since| event.seq > since))
            .map(|event| json!({ "cursor": self.cursor(event.seq), "event": event }))
            .collect();
        let last_seq = replay
            .last()
            .and_then(|last| last["event"]["seq"].as_u64())
            .unwrap_or(since.unwrap_or(0));
        {
            let mut subs = self.session_subs.lock().unwrap();
            if let Some(sub) = subs.get_mut(&subscription_id) {
                sub.last_seq = last_seq;
                for event in sub.buffered.take().unwrap_or_default() {
                    if event.seq > sub.last_seq {
                        sub.last_seq = event.seq;
                        sub.peer.notify(
                            "session.event",
                            json!({ "subscriptionId": subscription_id, "cursor": self.cursor(event.seq), "event": event }),
                        );
                    }
                }
            }
        }
        Ok(json!({
            "subscriptionId": subscription_id,
            "sessionId": session.id,
            "tabId": tab_id,
            "events": replay,
            "cursor": self.cursor(last_seq),
        }))
    }

    fn on_agent_event(&self, event: AgentEvent) {
        let mut subs = self.session_subs.lock().unwrap();
        for (subscription_id, sub) in subs.iter_mut() {
            if sub.session_id != event.session_id || sub.tab_id != event.tab_id {
                continue;
            }
            match &mut sub.buffered {
                Some(buffer) => buffer.push(event.clone()),
                None if event.seq > sub.last_seq => {
                    sub.last_seq = event.seq;
                    sub.peer.notify(
                        "session.event",
                        json!({ "subscriptionId": subscription_id, "cursor": self.cursor(event.seq), "event": event }),
                    );
                }
                None => {}
            }
        }
    }

    /// Cursors are opaque to clients and bound to this runtime generation.
    fn cursor(&self, seq: u64) -> String {
        format!("{}:{seq}", self.generation())
    }

    fn parse_cursor(&self, cursor: &str) -> Result<u64, RpcError> {
        let expired = || RpcError::new("cursor_expired", "the cursor belongs to another runtime generation");
        let (generation, seq) = cursor.split_once(':').ok_or_else(expired)?;
        if generation.parse::<u64>().ok() != Some(self.generation()) {
            return Err(expired());
        }
        seq.parse().map_err(|_| expired())
    }
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|error| RpcError::invalid(error.to_string()))
}

fn required_str<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    params.get(name).and_then(Value::as_str).ok_or_else(|| RpcError::invalid(format!("{name} is required")))
}

fn etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

fn stat_json(name: &str, meta: &std::fs::Metadata) -> Value {
    let kind = if meta.is_dir() {
        "directory"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64);
    json!({ "name": name, "kind": kind, "size": meta.len(), "modifiedMs": modified })
}

fn valid_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.contains("..")
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
}

fn git_error(error: anyhow::Error) -> RpcError {
    RpcError::new("git_failed", format!("{error:#}"))
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
