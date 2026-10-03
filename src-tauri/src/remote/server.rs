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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::files::WorkspaceFiles;
use super::git::WorkspaceGit;
use super::collab::{self, Access, Change, Collaboration, LeaseRefusal, Role};
use super::protocol::{self, Authority, IdempotencyCache, RpcError, PROTOCOL};
use crate::cloud_agents::CloudAgents;
use crate::events::AgentEvent;
use crate::pty::{PaneSpec, PtyData, PtyExit, Terminals};
use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_PTYS: usize = 16;
const MAX_EXITED_PTYS: usize = 8;
const PTY_RING_BYTES: usize = 1024 * 1024;
const PTY_PREFIX: &str = "remote-pty-";
/// An agent tab's own terminal (`agent-pty/1`, PRO-86) is the pane its CLI
/// runs in, `tab:<tabId>` ([`SessionManager::pane_id`]).
const AGENT_PTY_PREFIX: &str = "tab:";
/// Typing into an agent's terminal extends the typist's tab lease once it
/// has less than the full idle time minus this left, not on every keystroke.
const AGENT_LEASE_REFRESH_MS: u64 = 15_000;
/// Removed agent tabs whose late output is still turned away.
const MAX_REMOVED_AGENT_TABS: usize = 256;
/// Largest single `pty.write`; a paste is split by the client.
pub const MAX_WRITE_BYTES: usize = 64 * 1024;
/// Input accepted but not yet read by the program. Past it a write is
/// refused with `backpressure` and the client retries the same seq.
const MAX_PENDING_INPUT: usize = 256 * 1024;
/// Terminal output (base64) queued for one connection before its streams
/// are ended with `pty.lagged` and resumed from the ring by offset.
pub const MAX_QUEUED_OUTPUT: usize = 4 * 1024 * 1024;
/// Replay bytes per frame (base64 grows it by a third; well under the frame limit).
const REPLAY_CHUNK: usize = 256 * 1024;
/// Distinct writers remembered per terminal for resend detection.
const MAX_WRITERS: usize = 64;
/// Methods a `participate` attachment could not call before PRO-30. With no
/// member list from the API (an older API) they stay closed to it.
const SHARED_ONLY: &[&str] = &["keys.get", "pty.write", "pty.resize", "pty.control"];
/// Longest session title `session.update` accepts, in characters.
const MAX_TITLE_CHARS: usize = 200;
/// Launch modes a tab may be given (`src/lib/models.ts` `PERMISSION_MODES`).
const PERMISSION_MODES: [&str; 5] = ["plan", "manual", "auto", "acceptEdits", "bypassPermissions"];
/// Sink events after which the session list is sent again (`session/2`).
const SESSION_EVENTS: [&str; 3] = ["session_created", "session_updated", crate::session_ops::SESSION_DELETED_EVENT];

/// One attached client connection.
pub struct Peer {
    id: u64,
    /// The attachment's device; idempotency results are scoped to it so a
    /// reconnect of the same attachment replays, another attachment cannot.
    pub device_id: String,
    pub authority: Authority,
    /// The person the attachment belongs to (the API's `userId`); absent
    /// from an older API or a development link without it.
    pub user_id: Option<String>,
    outbound: mpsc::UnboundedSender<(Value, usize)>,
    /// Terminal output bytes queued for this connection that its transport
    /// has not taken yet. Past [`MAX_QUEUED_OUTPUT`] a terminal stream is
    /// ended with `pty.lagged` instead of growing without bound.
    queued: Arc<AtomicUsize>,
    granted: Mutex<Option<HashSet<String>>>,
    /// What this connection is looking at (`presence.update`).
    presence: Mutex<Presence>,
    /// Raised when the runtime closes the connection (access revoked).
    closed: tokio::sync::Notify,
}

#[derive(Clone)]
struct Presence {
    tab_id: Option<String>,
    activity: &'static str,
    since: u64,
}

static NEXT_PEER: AtomicU64 = AtomicU64::new(1);

/// A connection's notifications, in order, as its transport sends them.
pub struct Notifications {
    receiver: mpsc::UnboundedReceiver<(Value, usize)>,
    queued: Arc<AtomicUsize>,
}

impl Notifications {
    pub async fn recv(&mut self) -> Option<Value> {
        let (value, size) = self.receiver.recv().await?;
        self.queued.fetch_sub(size, Ordering::SeqCst);
        Some(value)
    }
}

impl Peer {
    pub fn new(device_id: String, authority: Authority) -> (Arc<Self>, Notifications) {
        Self::for_user(device_id, authority, None)
    }

    pub fn for_user(device_id: String, authority: Authority, user_id: Option<String>) -> (Arc<Self>, Notifications) {
        let (outbound, receiver) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let peer = Arc::new(Self {
            id: NEXT_PEER.fetch_add(1, Ordering::Relaxed),
            device_id,
            authority,
            user_id: user_id.filter(|user| !user.is_empty()),
            outbound,
            queued: queued.clone(),
            granted: Mutex::new(None),
            presence: Mutex::new(Presence { tab_id: None, activity: "viewing", since: crate::cloud_agents::now_ms() }),
            closed: tokio::sync::Notify::new(),
        });
        (peer, Notifications { receiver, queued })
    }

    /// Resolves once the runtime has closed this connection; the transport
    /// then hangs up.
    pub async fn closed(&self) {
        self.closed.notified().await
    }

    fn granted(&self, capability: &str) -> bool {
        self.granted.lock().unwrap().as_ref().is_some_and(|granted| granted.contains(capability))
    }

    fn notify(&self, event: &str, params: Value) {
        self.notify_sized(event, params, 0);
    }

    fn notify_sized(&self, event: &str, params: Value, size: usize) {
        self.queued.fetch_add(size, Ordering::SeqCst);
        if self.outbound.send((json!({ "event": event, "params": params }), size)).is_err() {
            self.queued.fetch_sub(size, Ordering::SeqCst);
        }
    }
}

/// One remote terminal. Its bytes live only in `ring`: nothing here writes
/// terminal output into a session transcript.
struct PtyState {
    /// Issued in creation order; clients name tabs "Terminal <number>".
    number: u64,
    cwd: String,
    /// The session the terminal was opened for (`pty/2`), if any.
    session_id: Option<String>,
    created_at_ms: u64,
    pid: Option<u32>,
    cols: u16,
    rows: u16,
    /// The device whose input and size the terminal follows. Only it may
    /// write or resize; another manage attachment, or a participant the
    /// workspace is shared with as a driver, takes over with `pty.control`.
    controller: Option<String>,
    /// The controlling person and their attachment's authority, shown to
    /// everyone watching and re-checked when roles change.
    controller_user: Option<(Option<String>, Authority)>,
    ring: VecDeque<u8>,
    /// Byte offset one past the last byte ever written by the terminal.
    end: u64,
    exit: Option<Option<i32>>,
    exited_at: Option<Instant>,
    /// `pty.kill` was called; the entry goes once the exit is reported.
    closed: bool,
    /// Last applied `pty.write` seq per (device, writer): a resend is
    /// dropped and a gap is refused, so input is applied once and in order.
    applied_seq: HashMap<(String, String), (u64, Instant)>,
    /// Accepted input, written by the terminal's own writer thread so a
    /// program that stops reading never stalls the connection.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    input_pending: Arc<AtomicUsize>,
    subscribers: HashMap<String, Arc<Peer>>,
    /// Set for an agent tab's own terminal (`agent-pty/1`): the pane the
    /// tab's CLI runs in. The session manager owns its process, so it is
    /// never listed, killed or evicted as a shell is, and it stays through
    /// every CLI the tab starts in it.
    agent: Option<AgentPty>,
}

struct AgentPty {
    tab_id: String,
    /// The tab's session, once a caller's access to the tab was checked.
    session_id: Option<String>,
}

impl PtyState {
    fn start(&self) -> u64 {
        self.end - self.ring.len() as u64
    }

    fn control_for(&self, peer: &Peer) -> &'static str {
        match &self.controller {
            Some(device) if *device == peer.device_id => "you",
            Some(_) => "other",
            None => "none",
        }
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
    files: Arc<WorkspaceFiles>,
    git: WorkspaceGit,
    /// The generation the relay host registered with; offsets and cursors
    /// are bound to it.
    generation: AtomicU64,
    /// This runtime process. Terminals, offsets and write seqs belong to
    /// it: a restarted runtime (same generation, e.g. after a resume) has
    /// none of them, and says so with a new epoch.
    epoch: String,
    next_pty_number: AtomicU64,
    version: String,
    sink: Arc<dyn EventSink>,
    terminals: Arc<Terminals>,
    sessions: Option<SessionManager>,
    ptys: Mutex<HashMap<String, PtyState>>,
    /// Agent tabs that were removed. Tab ids are never reused, and the last
    /// output of a CLI that was just stopped must not bring its terminal back.
    /// The newest [`MAX_REMOVED_AGENT_TABS`] are remembered: by the time one
    /// falls off, its CLI has long stopped writing.
    removed_agent_tabs: Mutex<VecDeque<String>>,
    session_subs: Mutex<HashMap<String, SessionSubscription>>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    idempotency: Mutex<IdempotencyCache>,
    /// One lock per `(attachment, clientRequestId)` in flight, so a resend
    /// racing its original waits for the cached result instead of running
    /// twice, while unrelated mutations proceed.
    in_flight: Mutex<HashMap<(String, String), Gate>>,
    /// Roles, tab leases and notes (PRO-30). A `participate` attachment sees
    /// sessions only while the workspace is shared with its person.
    pub collab: Arc<Collaboration>,
    /// Agent tabs, keys and the mailbox (PRO-22); absent in tests without them.
    agents: OnceLock<Arc<CloudAgents>>,
    /// Connections that said hello, for workspace-wide notifications.
    peers: Mutex<HashMap<u64, Weak<Peer>>>,
    tabs_changed: Arc<tokio::sync::Notify>,
    /// Raised when a session is created, updated or deleted; the list goes
    /// out as `session.sessions` to `session/2` connections.
    sessions_changed: Arc<tokio::sync::Notify>,
    /// Stands in for `harness::offered` in tests, which cannot install agents.
    #[cfg(test)]
    offered_for_tests: Mutex<Option<Vec<crate::harness::HarnessInfo>>>,
    /// Terminal input this runtime counted as use of the workspace (the
    /// process-wide activity flag is shared by every test).
    #[cfg(test)]
    pub(super) input_activity: AtomicUsize,
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
        let files = Arc::new(WorkspaceFiles::new(root.clone()));
        let rpc = Arc::new(Self {
            git: WorkspaceGit::new(root.clone(), files.clone()),
            files,
            root,
            generation: AtomicU64::new(generation),
            epoch: format!("epoch-{}", uuid::Uuid::new_v4().simple()),
            next_pty_number: AtomicU64::new(1),
            version: env!("CARGO_PKG_VERSION").into(),
            sink: sink.clone(),
            terminals,
            sessions,
            ptys: Mutex::new(HashMap::new()),
            removed_agent_tabs: Mutex::new(VecDeque::new()),
            session_subs: Mutex::new(HashMap::new()),
            subscriptions: Mutex::new(HashMap::new()),
            idempotency: Mutex::new(IdempotencyCache::default()),
            in_flight: Mutex::new(HashMap::new()),
            collab: Arc::new(Collaboration::new()),
            agents: OnceLock::new(),
            peers: Mutex::new(HashMap::new()),
            tabs_changed: Arc::new(tokio::sync::Notify::new()),
            sessions_changed: Arc::new(tokio::sync::Notify::new()),
            #[cfg(test)]
            offered_for_tests: Mutex::new(None),
            #[cfg(test)]
            input_activity: AtomicUsize::new(0),
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
            "tab_status",
            Box::new(move |payload| {
                if let (Some(rpc), Ok(status)) = (weak.upgrade(), serde_json::from_str::<Value>(payload)) {
                    rpc.on_tab_status(status);
                }
            }),
        );
        let notify = rpc.tabs_changed.clone();
        sink.listen(crate::cloud_agents::TABS_CHANGED, Box::new(move |_| notify.notify_one()));
        let weak = Arc::downgrade(&rpc);
        rpc.collab.listen(Box::new(move |change| {
            if let Some(rpc) = weak.upgrade() {
                rpc.on_collab_change(change);
            }
        }));
        let weak = Arc::downgrade(&rpc);
        sink.listen(
            crate::cloud_agents::KEYS_CHANGED,
            Box::new(move |_| {
                if let Some(rpc) = weak.upgrade() {
                    rpc.notify_granted("keys/1", "keys.changed", json!({}));
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
        for event in SESSION_EVENTS {
            let weak = Arc::downgrade(&rpc);
            let updated = event == "session_updated";
            sink.listen(
                event,
                Box::new(move |payload| {
                    let Some(rpc) = weak.upgrade() else { return };
                    // A new title or branch is in every checkpoint of the session.
                    if let (true, Some(agents), Ok(session)) =
                        (updated, rpc.agents.get(), serde_json::from_str::<SessionEntry>(payload))
                    {
                        for tab in &session.tabs {
                            agents.checkpoints.mark(&tab.id, false);
                        }
                    }
                    rpc.sessions_changed.notify_one();
                }),
            );
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let weak = Arc::downgrade(&rpc);
            let notify = rpc.sessions_changed.clone();
            runtime.spawn(async move {
                loop {
                    notify.notified().await;
                    // Coalesce a burst (a worktree delete removes several).
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let Some(rpc) = weak.upgrade() else { return };
                    let _ = tokio::task::spawn_blocking(move || rpc.broadcast_sessions()).await;
                }
            });
        }
        Ok(rpc)
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Serve agent tabs and keys from `agents`, and tell connections when
    /// the tab list changes. Call inside a Tokio runtime.
    pub fn set_agents(self: &Arc<Self>, agents: Arc<CloudAgents>) {
        agents.share_collaboration(self.collab.clone());
        if self.agents.set(agents).is_err() {
            return;
        }
        let weak = Arc::downgrade(self);
        let notify = self.tabs_changed.clone();
        tokio::spawn(async move {
            loop {
                notify.notified().await;
                // Coalesce a burst (a turn settling changes several things).
                tokio::time::sleep(Duration::from_millis(150)).await;
                let Some(rpc) = weak.upgrade() else { return };
                let Some(agents) = rpc.agents.get().cloned() else { continue };
                let Ok(tabs) = tokio::task::spawn_blocking(move || agents.tabs()).await else { continue };
                rpc.broadcast_tabs(&tabs);
            }
        });
    }

    fn agents(&self) -> Result<&Arc<CloudAgents>, RpcError> {
        self.agents.get().ok_or_else(|| RpcError::new("unavailable", "agent tabs are not served by this runtime"))
    }

    fn live_peers(&self) -> Vec<Arc<Peer>> {
        let mut peers = self.peers.lock().unwrap();
        peers.retain(|_, peer| peer.strong_count() > 0);
        peers.values().filter_map(Weak::upgrade).collect()
    }

    /// Tell every connection that was granted `capability`.
    fn notify_granted(&self, capability: &str, event: &str, params: Value) {
        for peer in self.live_peers() {
            if peer.granted.lock().unwrap().as_ref().is_some_and(|granted| granted.contains(capability)) {
                peer.notify(event, params.clone());
            }
        }
    }

    /// `session.sessions`: every `session/2` connection gets the sessions it
    /// may see, by the same rule as `session.list`.
    fn broadcast_sessions(&self) {
        let peers: Vec<Arc<Peer>> = self.live_peers().into_iter().filter(|peer| peer.granted("session/2")).collect();
        if peers.is_empty() {
            return;
        }
        let sessions = match self.workspace_sessions() {
            Ok(sessions) => sessions,
            Err(error) => {
                log::warn!("session list for session.sessions: {}", error.message);
                return;
            }
        };
        for peer in peers {
            // Workspace-wide, as `visible_sessions`.
            let visible: Vec<&SessionEntry> = if self.access(&peer).can_view() { sessions.iter().collect() } else { Vec::new() };
            peer.notify("session.sessions", json!({ "sessions": visible }));
        }
    }

    fn broadcast_tabs(&self, tabs: &[crate::cloud_agents::AgentTabInfo]) {
        for peer in self.live_peers() {
            if !peer.granted("session/1") {
                continue;
            }
            let visible: Vec<_> = if self.access(&peer).can_view() { tabs.iter().collect() } else { Vec::new() };
            peer.notify("session.tabs", json!({ "tabs": visible }));
        }
    }

    /// A connection's access: its attachment's authority and, for a
    /// participant, the role the workspace is shared with them in.
    pub fn access(&self, peer: &Peer) -> Access {
        self.collab.access_for(peer.authority, peer.user_id.as_deref())
    }

    /// The authority a connection acts with now: its attachment's, except
    /// that a `manage` attachment whose person is no longer a manager (an
    /// admin demoted since it was issued) acts as a participant.
    fn authority(&self, peer: &Peer) -> Authority {
        match peer.authority {
            Authority::Manage if self.access(peer).role == Role::Manager => Authority::Manage,
            _ => Authority::Participate,
        }
    }

    /// `listed` is false until the API has said who has access: the runtime
    /// then serves participants what it did before sharing existed, and
    /// clients must not read the role as "not shared".
    fn you(&self, peer: &Peer) -> Value {
        let access = self.access(peer);
        json!({ "userId": peer.user_id, "role": access.role, "canApprove": access.can_approve, "listed": self.collab.known() })
    }

    /// Apply the API's latest member list (`collaboration` on `/refresh`):
    /// close connections of people who lost access, take terminal control
    /// and tab leases from people who may no longer drive, drop their queued
    /// follow-ups, and rotate the content key when anyone lost access.
    /// `None` (the API did not say) changes nothing.
    pub fn set_collaboration(&self, members: Option<collab::Members>) {
        let Some(members) = members else { return };
        // A version this runtime cannot read fails closed.
        let map = members.into_map().unwrap_or_else(|| {
            log::warn!("a collaboration list of an unknown version gives participants no access");
            Default::default()
        });
        let first = !self.collab.known();
        let diff = self.collab.set_members(map);
        if diff.changed.is_empty() && !first {
            return;
        }
        for peer in &self.live_peers() {
            let Some(user) = peer.user_id.as_deref() else {
                // A `manage` attachment that names no person (saved before
                // attachments carried one) cannot be matched to the list, so
                // it may be someone who lost access: it is closed (review N1).
                if peer.authority == Authority::Manage {
                    log::info!("closing a manage connection that names no person now that the member list is known");
                    peer.closed.notify_one();
                } else {
                    self.drop_peer_subscriptions(peer);
                }
                continue;
            };
            if diff.lost.iter().any(|lost| lost == user) {
                // Whatever the attachment: a demoted admin's `manage`
                // connection goes too.
                log::info!("closing a connection whose person no longer has access to the workspace");
                peer.closed.notify_one();
                continue;
            }
            if !self.access(peer).can_view() {
                // Anything it opened before the list said so (the first list
                // after a start, or a demotion) stops streaming now.
                self.drop_peer_subscriptions(peer);
            }
            if peer.granted("collab/1") && (first || diff.changed.iter().any(|changed| changed == user)) {
                peer.notify("collab.you", json!({ "you": self.you(peer) }));
            }
        }
        self.revalidate_terminal_control();
        if let Some(agents) = self.agents.get() {
            agents.revalidate_follow_ups();
            // Also after a restart, when nothing is known about the previous
            // list: anyone the current key was handed to who has no access now.
            let holder_gone = agents.key_holders().iter().any(|user| !self.collab.access_of(Some(user)).can_view());
            if !diff.lost.is_empty() || holder_gone {
                match agents.rotate_key() {
                    Ok(key_id) => log::info!("rotated the workspace content key to {key_id} after access was revoked"),
                    Err(error) => log::error!("rotate the workspace content key: {error:#}"),
                }
            }
        }
        self.broadcast_presence();
        self.tabs_changed.notify_one();
    }

    /// A participant who may no longer drive loses the terminals they
    /// control; everyone watching is told.
    fn revalidate_terminal_control(&self) {
        let mut released = Vec::new();
        let mut ptys = self.ptys.lock().unwrap();
        for (pty_id, pty) in ptys.iter_mut() {
            let Some((user, authority)) = pty.controller_user.clone() else { continue };
            let access = self.collab.access_for(authority, user.as_deref());
            // An agent's terminal also needs the right to approve (`agent_input_refusal`).
            let may_type = access.can_drive() && (pty.agent.is_none() || access.role == Role::Manager || access.can_approve);
            if may_type {
                continue;
            }
            pty.controller = None;
            pty.controller_user = None;
            for (subscription_id, subscriber) in &pty.subscribers {
                subscriber.notify(
                    "pty.control",
                    json!({ "subscriptionId": subscription_id, "ptyId": pty_id, "control": "none", "controllerId": Value::Null }),
                );
            }
            if let (Some(agent), Some(user)) = (&pty.agent, user) {
                released.push((agent.tab_id.clone(), user));
            }
        }
        drop(ptys);
        // The tab they held by typing into its terminal is free again.
        for (tab_id, user) in released {
            self.collab.release(&tab_id, &user, false);
        }
    }

    fn on_collab_change(&self, change: Change) {
        let (event, params) = match change {
            Change::Lease { tab_id, lease } => {
                self.tabs_changed.notify_one();
                ("collab.lease", json!({ "tabId": tab_id, "lease": lease }))
            }
            Change::Note(note) => ("notes.posted", json!({ "note": note })),
        };
        for peer in self.live_peers() {
            if peer.granted("collab/1") && self.access(&peer).can_view() {
                peer.notify(event, params.clone());
            }
        }
    }

    /// One row per person with access, over all their connections.
    fn participants(&self) -> Vec<Value> {
        let mut people: std::collections::BTreeMap<String, (Access, usize, Presence)> = std::collections::BTreeMap::new();
        for peer in self.live_peers() {
            let Some(user) = peer.user_id.clone() else { continue };
            let access = self.access(&peer);
            if !peer.granted("collab/1") || !access.can_view() {
                continue;
            }
            let presence = peer.presence.lock().unwrap().clone();
            let entry = people.entry(user).or_insert((access, 0, presence.clone()));
            entry.1 += 1;
            if access.role > entry.0.role {
                entry.0 = access;
            }
            if presence.since > entry.2.since {
                entry.2 = presence;
            }
        }
        people
            .into_iter()
            .map(|(user, (access, surfaces, presence))| {
                json!({
                    "userId": user,
                    "role": access.role,
                    "canApprove": access.can_approve,
                    "surfaces": surfaces,
                    "tabId": presence.tab_id,
                    "activity": presence.activity,
                    "since": presence.since,
                })
            })
            .collect()
    }

    fn broadcast_presence(&self) {
        let participants = self.participants();
        for peer in self.live_peers() {
            if peer.granted("collab/1") && self.access(&peer).can_view() {
                peer.notify("collab.presence", json!({ "participants": participants }));
            }
        }
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
            if self.peers.lock().unwrap().insert(peer.id, Arc::downgrade(peer)).is_none() {
                if let Some(agents) = self.agents.get() {
                    agents.client_attached();
                }
            }
            let collab = granted.iter().any(|capability| capability == "collab/1");
            if collab {
                self.broadcast_presence();
            }
            let mut hello = json!({
                "protocol": PROTOCOL,
                "runtime": { "version": self.version, "runtimeGeneration": self.generation(), "epoch": self.epoch },
                "capabilities": granted,
                "authority": self.authority(peer),
                "limits": {
                    "maxFrameBytes": MAX_FRAME_BYTES,
                    "maxPtys": MAX_PTYS,
                    "maxWriteBytes": MAX_WRITE_BYTES,
                    "fsPartBytes": super::files::PART_BYTES,
                    "fsMaxFileBytes": super::files::MAX_FILE_BYTES,
                },
            });
            if collab {
                hello["you"] = self.you(peer);
            }
            return Ok(hello);
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
        let authority = self.authority(peer);
        if authority < spec.authority {
            return Err(RpcError::forbidden(format!("{method} needs manage authority")));
        }
        if authority == Authority::Participate {
            self.authorize_participant(peer, spec)?;
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

    /// What a participant's role allows (contract §21.1). Before the API
    /// has listed members, participants keep exactly what they had before
    /// sharing existed.
    fn authorize_participant(&self, peer: &Peer, spec: &protocol::Method) -> Result<(), RpcError> {
        let method = spec.name;
        if !self.collab.known() && spec.capability != "collab/1" && !SHARED_ONLY.contains(&method) {
            return Ok(());
        }
        let needed = match method {
            "pty.write" | "pty.resize" | "pty.control" | "lease.acquire" | "lease.release" => Role::Driver,
            "lease.takeOver" => Role::Manager,
            _ => Role::Viewer,
        };
        let access = self.access(peer);
        if access.role >= needed {
            return Ok(());
        }
        let what = match needed {
            Role::Manager => "a workspace manager",
            Role::Driver => "driver access to the workspace",
            _ => "the workspace to be shared with you",
        };
        Err(RpcError::forbidden(format!("{method} needs {what}")).with_data(json!({ "role": access.role })))
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
            "pty.create" => self.pty_create(peer, params),
            "pty.list" => self.pty_list(peer),
            "pty.write" => self.pty_write(peer, params),
            "pty.resize" => self.pty_resize(peer, params),
            "pty.control" => self.pty_control(peer, params),
            "pty.kill" => self.pty_kill(params),
            "pty.attach" => self.pty_attach(peer, params),
            "pty.detach" | "session.unsubscribe" | "fs.unwatch" => self.unsubscribe(peer, params),
            "fs.list" => self.files.list(&params),
            "fs.stat" => self.files.stat(&params),
            "fs.read" => self.files.read(&params),
            "fs.write" => self.files.write(&peer.device_id, &params),
            "fs.writePart" => self.files.write_part(&peer.device_id, &params),
            "fs.rename" => self.files.rename(&params),
            "fs.delete" => self.files.delete(&params),
            "fs.mkdir" => self.files.mkdir(&params),
            "fs.search" => self.files.search(peer.id, &params),
            "fs.cancel" => self.files.cancel(peer.id, &params),
            "fs.watch" => self.fs_watch(peer, params),
            "lifecycle.dispositionFacts" => self.disposition_facts(),
            "lifecycle.resources" => Ok(crate::cloud_resources::observe(&self.root)),
            git if git.starts_with("git.") => self
                .git
                .handle(git, &params)
                .unwrap_or_else(|| Err(RpcError::new("method_not_found", format!("{git} is not a workspace method")))),
            "session.list" => self.session_list(peer),
            "session.get" => self.session_get(peer, params),
            "session.create" => self.session_create(params),
            "session.close" => self.session_close(params),
            "session.send" => self.session_send(peer, params),
            "session.subscribe" => self.session_subscribe(peer, params),
            "session.tabs" => self.session_tabs(peer),
            "session.configure" => self.session_configure(peer, params),
            "session.markRead" => self.session_mark_read(peer, params),
            "session.update" => self.session_update(peer, params),
            "session.addTab" => self.session_add_tab(peer, params),
            "session.delete" => self.session_delete(peer, params),
            "runtime.agents" => self.runtime_agents(),
            "session.nudge" => {
                self.agents()?.poll.raise();
                Ok(json!({}))
            }
            "keys.get" => {
                let agents = self.agents()?;
                // Authorized before this blocking task ran; access may have
                // changed since. Checked again under the rotation lock, so a
                // rotation for a revocation cannot slip between the check
                // and the handout (review N3).
                let spec = protocol::find_method("keys.get").expect("keys.get is a method");
                agents
                    .hand_out_key(peer.user_id.as_deref(), || self.key_access(peer, spec))
                    .map_err(|refusal| match refusal {
                        crate::cloud_agents::HandoutRefusal::Forbidden(error) => error,
                        crate::cloud_agents::HandoutRefusal::HolderNotRecorded => {
                            RpcError::new("unavailable", "the key handout could not be recorded; try again")
                        }
                    })
            }
            "collab.state" => self.collab_state(peer),
            "presence.update" => self.presence_update(peer, params),
            "notes.list" => self.notes_list(params),
            "notes.post" => self.notes_post(peer, params),
            "lease.acquire" => self.lease_acquire(peer, params, false),
            "lease.takeOver" => self.lease_acquire(peer, params, true),
            "lease.release" => self.lease_release(peer, params),
            "keys.rotate" => {
                let key_id = self.agents()?.rotate_key().map_err(RpcError::internal)?;
                Ok(json!({ "currentKeyId": key_id }))
            }
            other => Err(RpcError::new("method_not_found", format!("{other} is not a workspace method"))),
        }
    }

    /// Whether `peer` may be handed the content key now: the same checks as
    /// the dispatcher's, read again.
    fn key_access(&self, peer: &Peer, spec: &protocol::Method) -> Result<(), RpcError> {
        let authority = self.authority(peer);
        if authority < spec.authority {
            return Err(RpcError::forbidden("keys.get needs the workspace to be shared with you"));
        }
        if authority == Authority::Participate {
            self.authorize_participant(peer, spec)?;
        }
        Ok(())
    }

    /// End every stream a connection opened, keeping the connection.
    fn drop_peer_subscriptions(&self, peer: &Peer) {
        self.files.disconnect(peer.id);
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

    /// Drop everything a closed connection subscribed to.
    pub fn disconnect(&self, peer: &Peer) {
        self.files.disconnect(peer.id);
        if self.peers.lock().unwrap().remove(&peer.id).is_some() {
            if let Some(agents) = self.agents.get() {
                agents.client_detached();
            }
            if peer.granted("collab/1") {
                self.broadcast_presence();
            }
        }
        self.drop_peer_subscriptions(peer);
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

    // ---- collaboration (collab/1, PRO-30) -----------------------------------

    /// An agent tab of this runtime, named by exact id: `(sessionId, tabId)`.
    fn known_tab(&self, params: &Value) -> Result<(String, String), RpcError> {
        let tab_id = required_str(params, "tabId")?;
        self.agents()?
            .ops
            .tabs()
            .into_iter()
            .find(|tab| tab.tab_id == tab_id)
            .map(|tab| (tab.session_id, tab.tab_id))
            .ok_or_else(|| RpcError::not_found("no such tab"))
    }

    fn collab_state(&self, peer: &Peer) -> Result<Value, RpcError> {
        let now = crate::cloud_agents::now_ms();
        // One read of the tabs for every lease; a running turn keeps its
        // lease past the idle expiry.
        let sessions: HashMap<String, String> =
            self.agents.get().map(|agents| agents.ops.tabs().into_iter().map(|tab| (tab.tab_id, tab.session_id)).collect()).unwrap_or_default();
        let leases = self.collab.leases(now, &|tab_id| sessions.get(tab_id).is_some_and(|session| agents_busy(&self.agents, session, tab_id)));
        Ok(json!({ "you": self.you(peer), "participants": self.participants(), "leases": leases }))
    }

    fn presence_update(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let tab_id = match params.get("tabId") {
            None | Some(Value::Null) => None,
            Some(Value::String(tab)) if (1..=128).contains(&tab.len()) => Some(tab.clone()),
            Some(_) => return Err(RpcError::invalid("tabId must be a tab id or null")),
        };
        let activity = match params.get("activity").and_then(Value::as_str) {
            None | Some("viewing") => "viewing",
            Some("typing") => "typing",
            Some(_) => return Err(RpcError::invalid("activity must be viewing or typing")),
        };
        let changed = {
            let mut presence = peer.presence.lock().unwrap();
            let changed = presence.tab_id != tab_id || presence.activity != activity;
            *presence = Presence { tab_id, activity, since: crate::cloud_agents::now_ms() };
            changed
        };
        if changed {
            self.broadcast_presence();
        }
        Ok(json!({}))
    }

    fn notes_list(&self, params: Value) -> Result<Value, RpcError> {
        let (_, tab_id) = self.known_tab(&params)?;
        let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(100).clamp(1, 200) as usize;
        let (notes, more) = self.collab.notes(&tab_id, params.get("beforeId").and_then(Value::as_str), limit);
        Ok(json!({ "notes": notes, "more": more }))
    }

    /// A note for the people in the workspace. It never reaches the agent:
    /// it is not typed, queued or checkpointed.
    fn notes_post(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let (_, tab_id) = self.known_tab(&params)?;
        let author = peer.user_id.as_deref().ok_or_else(|| RpcError::forbidden("notes need a signed-in person"))?;
        let text = required_str(&params, "text")?;
        if text.trim().is_empty() || text.chars().count() > collab::MAX_NOTE_CHARS {
            return Err(RpcError::invalid(format!("a note is 1 to {} characters", collab::MAX_NOTE_CHARS)));
        }
        let note = self.collab.post_note(&tab_id, author, text, crate::cloud_agents::now_ms()).map_err(RpcError::internal)?;
        Ok(json!({ "note": note }))
    }

    fn lease_acquire(&self, peer: &Peer, params: Value, take_over: bool) -> Result<Value, RpcError> {
        let (session_id, tab_id) = self.known_tab(&params)?;
        let user = peer.user_id.as_deref().ok_or_else(|| RpcError::forbidden("driving needs a signed-in person"))?;
        let access = self.access(peer);
        if !access.can_drive() || take_over && access.role != Role::Manager {
            return Err(lease_refusal(LeaseRefusal::Forbidden));
        }
        let busy = agents_busy(&self.agents, &session_id, &tab_id);
        let now = crate::cloud_agents::now_ms();
        let lease = if take_over {
            self.collab.claim(&tab_id, user, now, busy, true)
        } else {
            self.collab.acquire_idle(&tab_id, user, now, busy)
        }
        .map_err(lease_refusal)?;
        Ok(json!({ "lease": lease }))
    }

    fn lease_release(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let (_, tab_id) = self.known_tab(&params)?;
        let user = peer.user_id.as_deref().unwrap_or("");
        let force = self.access(peer).role == Role::Manager;
        if !self.collab.release(&tab_id, user, force) && self.collab.lease(&tab_id, crate::cloud_agents::now_ms(), true).is_some() {
            return Err(RpcError::forbidden("only the driver or a manager releases the lease"));
        }
        Ok(json!({}))
    }

    // ---- terminals -------------------------------------------------------

    /// The entry of an agent tab's terminal, made on its first output or its
    /// first caller. Its input goes to whichever CLI the tab runs in the pane
    /// at that moment. Called with the terminals locked.
    fn agent_entry<'a>(&self, ptys: &'a mut HashMap<String, PtyState>, pty_id: &str) -> Result<&'a mut PtyState, RpcError> {
        if !ptys.contains_key(pty_id) {
            let tab_id = pty_id.strip_prefix(AGENT_PTY_PREFIX).ok_or_else(|| RpcError::not_found("no such terminal"))?;
            if self.removed_agent_tabs.lock().unwrap().iter().any(|removed| removed == tab_id) {
                return Err(RpcError::not_found("the terminal closed with its tab"));
            }
            let (input, queue) = std::sync::mpsc::channel::<Vec<u8>>();
            let input_pending = Arc::new(AtomicUsize::new(0));
            let terminals = self.terminals.clone();
            let pending = input_pending.clone();
            let pane = pty_id.to_string();
            std::thread::Builder::new()
                .name(format!("agent-pty-input-{tab_id}"))
                .spawn(move || {
                    // Ends when the entry (the sender) is dropped with its tab.
                    for data in queue {
                        // Between two CLIs there is nothing to type into.
                        let _ = terminals.write(&pane, &data);
                        pending.fetch_sub(data.len(), Ordering::SeqCst);
                    }
                })
                .map_err(RpcError::internal)?;
            let (cols, rows) = crate::session::CLI_PANE_SIZE;
            ptys.insert(
                pty_id.to_string(),
                PtyState {
                    number: 0,
                    cwd: String::new(),
                    session_id: None,
                    created_at_ms: crate::cloud_agents::now_ms(),
                    pid: None,
                    cols,
                    rows,
                    controller: None,
                    controller_user: None,
                    ring: VecDeque::new(),
                    end: 0,
                    exit: None,
                    exited_at: None,
                    closed: false,
                    applied_seq: HashMap::new(),
                    input,
                    input_pending,
                    subscribers: HashMap::new(),
                    agent: Some(AgentPty { tab_id: tab_id.to_string(), session_id: None }),
                },
            );
        }
        Ok(ptys.get_mut(pty_id).expect("the entry was just made"))
    }

    /// `params.ptyId` as an agent tab's terminal: `None` for a shell,
    /// otherwise the tab's `(sessionId, tabId)`. The caller must have been
    /// granted `agent-pty/1` and must see the tab: an agent's screen is its
    /// conversation, so only people the workspace is shared with reach it.
    fn agent_pty(&self, peer: &Peer, params: &Value) -> Result<Option<(String, String)>, RpcError> {
        let Some(pty_id) = params.get("ptyId").and_then(Value::as_str).filter(|id| id.starts_with(AGENT_PTY_PREFIX)) else { return Ok(None) };
        let tab_id = &pty_id[AGENT_PTY_PREFIX.len()..];
        if !peer.granted(protocol::AGENT_PTY) {
            return Err(RpcError::new("capability_not_granted", format!("{} was not granted", protocol::AGENT_PTY)));
        }
        if !self.access(peer).can_view() {
            return Err(RpcError::not_found("no such terminal"));
        }
        let known = self.ptys.lock().unwrap().get(pty_id).and_then(|pty| pty.agent.as_ref()).and_then(|agent| agent.session_id.clone());
        let session_id = match known {
            Some(session_id) => session_id,
            None => {
                // Named by exact id, and only a tab whose agent runs in a terminal.
                let tab = self
                    .agents()?
                    .ops
                    .tabs()
                    .into_iter()
                    .find(|tab| tab.tab_id == tab_id)
                    .ok_or_else(|| RpcError::not_found("no such terminal"))?;
                if crate::session::pty_first(&tab.harness).is_none() {
                    return Err(RpcError::new("unavailable", "this agent does not run in a terminal"));
                }
                let mut ptys = self.ptys.lock().unwrap();
                if let Some(agent) = &mut self.agent_entry(&mut ptys, pty_id)?.agent {
                    agent.session_id = Some(tab.session_id.clone());
                }
                tab.session_id
            }
        };
        Ok(Some((session_id, tab_id.to_string())))
    }

    /// Typing into an agent's terminal, or sizing it, is driving its tab:
    /// refused while someone else holds the tab's lease, exactly as a send
    /// is (managers included; they take the tab over explicitly).
    ///
    /// It also needs the right to approve. The agent's own screen answers
    /// its permission prompts and changes its mode and model, which a send
    /// from a plain driver never does (their settings are ignored and their
    /// decisions refused): a driver who may not approve watches.
    fn agent_input_refusal(&self, peer: &Peer, session_id: &str, tab_id: &str) -> Option<RpcError> {
        let access = self.access(peer);
        if self.authority(peer) == Authority::Participate && !access.can_drive() {
            return Some(RpcError::forbidden("typing needs driver access to the workspace"));
        }
        if access.role != Role::Manager && !access.can_approve {
            return Some(
                RpcError::forbidden("typing into an agent's terminal can approve its permission requests: it needs approval rights")
                    .with_data(json!({ "role": access.role, "needs": "canApprove" })),
            );
        }
        match peer.user_id.as_deref() {
            Some(user) => self
                .collab
                .held_by_other(tab_id, user, crate::cloud_agents::now_ms(), agents_busy(&self.agents, session_id, tab_id))
                .map(|held| lease_refusal(LeaseRefusal::Held(held))),
            None if self.authority(peer) == Authority::Participate => Some(RpcError::forbidden("typing needs a signed-in person")),
            None => None,
        }
    }

    /// The terminals of tabs that are gone go with them.
    fn close_agent_ptys<'a>(&self, tab_ids: impl Iterator<Item = &'a String>) {
        let tab_ids: Vec<&String> = tab_ids.collect();
        {
            let mut removed = self.removed_agent_tabs.lock().unwrap();
            for tab_id in &tab_ids {
                if !removed.iter().any(|known| known == *tab_id) {
                    removed.push_back(tab_id.to_string());
                }
            }
            let excess = removed.len().saturating_sub(MAX_REMOVED_AGENT_TABS);
            removed.drain(..excess);
        }
        let ended: Vec<String> = {
            let mut ptys = self.ptys.lock().unwrap();
            tab_ids.into_iter().flat_map(|tab_id| Self::remove_pty(&mut ptys, &format!("{AGENT_PTY_PREFIX}{tab_id}"))).collect()
        };
        self.forget_subscriptions(ended);
    }

    /// The sessions whose terminals `peer` may see tied to them: `None`
    /// without `pty/2`, otherwise its `visible_sessions`. Read before the
    /// terminals are locked.
    fn pty_session_scope(&self, peer: &Peer) -> Option<HashSet<String>> {
        if !peer.granted("pty/2") {
            return None;
        }
        Some(self.visible_sessions(peer).map(|sessions| sessions.into_iter().map(|session| session.id).collect()).unwrap_or_default())
    }

    /// What a client needs to show and resume one terminal. `scope` is
    /// [`Self::pty_session_scope`] for `peer`.
    fn describe_pty(&self, pty_id: &str, pty: &PtyState, peer: &Peer, scope: Option<&HashSet<String>>) -> Value {
        let mut described = json!({
            "ptyId": pty_id,
            "number": pty.number,
            "epoch": self.epoch,
            "pid": pty.pid,
            "cwd": pty.cwd,
            "cols": pty.cols,
            "rows": pty.rows,
            "createdAt": pty.created_at_ms,
            "offset": pty.end,
            "exited": pty.exit.is_some(),
            "exitCode": pty.exit.flatten(),
            "control": pty.control_for(peer),
            "controllerId": pty.controller_user.as_ref().and_then(|(user, _)| user.clone()),
        });
        if let Some(agent) = &pty.agent {
            // The tab whose CLI this is, and whether one runs in it now.
            described["tabId"] = json!(agent.tab_id);
            described["running"] = json!(self.terminals.is_running(pty_id));
        }
        // `pty/2`, and only a session this peer may see; absent for a
        // terminal that belongs to no session.
        if let Some(session_id) = pty.session_id.as_ref().filter(|id| scope.is_some_and(|visible| visible.contains(*id))) {
            described["sessionId"] = json!(session_id);
        }
        described
    }

    fn pty_create(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            #[serde(default = "default_cols")]
            cols: u16,
            #[serde(default = "default_rows")]
            rows: u16,
            #[serde(default)]
            cwd: Option<String>,
            #[serde(default)]
            session_id: Option<String>,
            #[allow(dead_code)]
            client_request_id: String,
        }
        let p: Params = parse(params)?;
        if p.cols == 0 || p.rows == 0 || p.cols > 1000 || p.rows > 1000 {
            return Err(RpcError::invalid("cols and rows must be between 1 and 1000"));
        }
        let session = match &p.session_id {
            Some(_) if !peer.granted("pty/2") => return Err(RpcError::invalid("sessionId needs pty/2")),
            Some(session_id) => Some(self.visible_session(peer, session_id)?),
            None => None,
        };
        let cwd = match (&p.cwd, &session) {
            (Some(relative), _) => self.existing_path(relative)?,
            // A session's terminal opens in its checkout (its worktree), when
            // that is inside the workspace; otherwise at the root.
            (None, Some(session)) => std::fs::canonicalize(&session.cwd)
                .ok()
                .filter(|cwd| cwd.starts_with(&self.root) && cwd.is_dir())
                .unwrap_or_else(|| self.root.clone()),
            (None, None) => self.root.clone(),
        };
        if !cwd.is_dir() {
            return Err(RpcError::invalid("cwd is not a directory"));
        }
        let pty_id = format!("{PTY_PREFIX}{}", uuid::Uuid::new_v4().simple());
        let (input, queue) = std::sync::mpsc::channel::<Vec<u8>>();
        let input_pending = Arc::new(AtomicUsize::new(0));
        {
            let mut ptys = self.ptys.lock().unwrap();
            if ptys.values().filter(|pty| pty.agent.is_none() && pty.exit.is_none() && !pty.closed).count() >= MAX_PTYS {
                return Err(RpcError::new("unavailable", format!("at most {MAX_PTYS} terminals may run at once")));
            }
            ptys.insert(
                pty_id.clone(),
                PtyState {
                    number: self.next_pty_number.fetch_add(1, Ordering::SeqCst),
                    cwd: self.relative(&cwd),
                    session_id: session.map(|session| session.id),
                    created_at_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|elapsed| elapsed.as_millis() as u64)
                        .unwrap_or(0),
                    pid: None,
                    cols: p.cols,
                    rows: p.rows,
                    controller: Some(peer.device_id.clone()),
                    controller_user: Some((peer.user_id.clone(), peer.authority)),
                    ring: VecDeque::new(),
                    end: 0,
                    exit: None,
                    exited_at: None,
                    closed: false,
                    applied_seq: HashMap::new(),
                    input,
                    input_pending: input_pending.clone(),
                    subscribers: HashMap::new(),
                    agent: None,
                },
            );
        }
        let scope = self.pty_session_scope(peer);
        let cwd = cwd.to_string_lossy().into_owned();
        let spec = PaneSpec { cwd: &cwd, cols: p.cols, rows: p.rows, command: None, env: &[] };
        if let Err(error) = self.terminals.spawn(self.sink.clone(), &pty_id, spec) {
            self.ptys.lock().unwrap().remove(&pty_id);
            return Err(RpcError::internal(error));
        }
        let terminals = self.terminals.clone();
        let writer_id = pty_id.clone();
        let spawned = std::thread::Builder::new().name(format!("pty-input-{pty_id}")).spawn(move || {
            // Ends when the terminal's entry (the sender) is dropped, or the
            // program is gone; its exit is reported through `pty.exit`.
            for data in queue {
                let written = terminals.write(&writer_id, &data);
                input_pending.fetch_sub(data.len(), Ordering::SeqCst);
                if written.is_err() {
                    break;
                }
            }
        });
        if let Err(error) = spawned {
            self.ptys.lock().unwrap().remove(&pty_id);
            self.terminals.kill(&pty_id);
            return Err(RpcError::internal(error));
        }
        let mut ptys = self.ptys.lock().unwrap();
        let pty = ptys.get_mut(&pty_id).ok_or_else(|| RpcError::internal("the terminal exited while starting"))?;
        pty.pid = self.terminals.pid(&pty_id);
        Ok(self.describe_pty(&pty_id, pty, peer, scope.as_ref()))
    }

    /// Terminals of this runtime, oldest first; closed ones are gone.
    fn pty_list(&self, peer: &Peer) -> Result<Value, RpcError> {
        let scope = self.pty_session_scope(peer);
        let ptys = self.ptys.lock().unwrap();
        let mut listed: Vec<(u64, Value)> = ptys
            .iter()
            // An agent tab's terminal is reached from its tab, never listed as a shell.
            .filter(|(_, pty)| !pty.closed && pty.agent.is_none())
            .map(|(id, pty)| (pty.number, self.describe_pty(id, pty, peer, scope.as_ref())))
            .collect();
        listed.sort_by_key(|(number, _)| *number);
        Ok(json!({
            "epoch": self.epoch,
            "runtimeGeneration": self.generation(),
            "terminals": listed.into_iter().map(|(_, pty)| pty).collect::<Vec<_>>(),
        }))
    }

    /// A terminal addressed by exact id in this runtime process. A client
    /// that names the epoch it created or attached in never reaches a
    /// terminal of a restarted runtime.
    fn live_pty<'a>(&self, ptys: &'a mut HashMap<String, PtyState>, params: &Value) -> Result<(String, &'a mut PtyState), RpcError> {
        let pty_id = required_str(params, "ptyId")?;
        if let Some(epoch) = params.get("epoch").and_then(Value::as_str) {
            if epoch != self.epoch {
                return Err(RpcError::not_found("the terminal belonged to an earlier runtime"));
            }
        }
        match ptys.get_mut(pty_id) {
            Some(pty) if !pty.closed => Ok((pty_id.to_string(), pty)),
            _ => Err(RpcError::not_found("no such terminal")),
        }
    }

    fn pty_write(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let seq = params.get("seq").and_then(Value::as_u64).filter(|seq| *seq > 0).ok_or_else(|| RpcError::invalid("seq must be a positive integer"))?;
        let data = required_str(&params, "data")?;
        if data.len() > MAX_WRITE_BYTES {
            return Err(RpcError::new("too_large", format!("write at most {MAX_WRITE_BYTES} bytes at a time")));
        }
        let writer = params.get("writerId").and_then(Value::as_str).unwrap_or("");
        if writer.len() > 128 {
            return Err(RpcError::invalid("writerId is too long"));
        }
        // `report`: bytes the client's terminal emulator produced by itself
        // (a focus report, the answer to a device or colour query), not
        // something a person typed. The program still needs them, so the
        // controller's are delivered, but they are neither use of the
        // workspace nor driving: no activity, and no lease claimed or extended.
        let report = params.get("report").and_then(Value::as_bool) == Some(true);
        let agent = self.agent_pty(peer, &params)?;
        // Decided before the terminals are locked: it reads the tab's own
        // state, which a restarting CLI can hold for seconds.
        let refusal = agent.as_ref().and_then(|(session_id, tab_id)| self.agent_input_refusal(peer, session_id, tab_id));
        let mut ptys = self.ptys.lock().unwrap();
        let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
        let key = (peer.device_id.clone(), writer.to_string());
        let applied = pty.applied_seq.get(&key).map(|(seq, _)| *seq).unwrap_or(0);
        // A resend of what was applied is answered, never typed again, even
        // after control moved or the program exited.
        if seq <= applied {
            return Ok(json!({ "applied": false, "seq": applied }));
        }
        if seq != applied + 1 {
            return Err(RpcError::new("conflict", format!("expected seq {}", applied + 1)));
        }
        if pty.exit.is_some() {
            return Err(RpcError::new("unavailable", "the terminal has exited"));
        }
        if let Some(refusal) = refusal {
            return Err(refusal);
        }
        if agent.is_some() && !self.terminals.is_running(&pty_id) {
            return Err(RpcError::new("unavailable", "the agent is not running"));
        }
        if pty.controller.as_deref() != Some(peer.device_id.as_str()) {
            return Err(RpcError::new("not_controller", "another device controls this terminal's input"));
        }
        if pty.input_pending.load(Ordering::SeqCst) + data.len() > MAX_PENDING_INPUT {
            return Err(RpcError::new("backpressure", "the program is not reading its input yet; retry"));
        }
        pty.input_pending.fetch_add(data.len(), Ordering::SeqCst);
        if pty.input.send(data.as_bytes().to_vec()).is_err() {
            pty.input_pending.fetch_sub(data.len(), Ordering::SeqCst);
            return Err(RpcError::new("unavailable", "the terminal has exited"));
        }
        pty.applied_seq.insert(key, (seq, Instant::now()));
        if pty.applied_seq.len() > MAX_WRITERS {
            if let Some(oldest) = pty.applied_seq.iter().min_by_key(|(_, (_, at))| *at).map(|(key, _)| key.clone()) {
                pty.applied_seq.remove(&oldest);
            }
        }
        drop(ptys);
        if report {
            return Ok(json!({ "applied": true, "seq": seq }));
        }
        // Accepted input is use of the workspace (a resend, a refusal or a terminal's own report is not).
        crate::cloud_activity::note(crate::cloud_activity::Kind::TerminalInput);
        #[cfg(test)]
        self.input_activity.fetch_add(1, Ordering::SeqCst);
        // Only what a person typed to the agent claims its tab, as with a send.
        if let (Some((session_id, tab_id)), Some(user)) = (&agent, peer.user_id.as_deref()) {
            let now = crate::cloud_agents::now_ms();
            let busy = agents_busy(&self.agents, session_id, tab_id);
            let fresh = self
                .collab
                .lease(tab_id, now, busy)
                .is_some_and(|lease| lease.holder_id == user && lease.expires_at + AGENT_LEASE_REFRESH_MS >= now + collab::LEASE_IDLE_MS);
            if !fresh {
                let _ = self.collab.claim(tab_id, user, now, busy, false);
            }
        }
        Ok(json!({ "applied": true, "seq": seq }))
    }

    fn size_params(params: &Value) -> Result<Option<(u16, u16)>, RpcError> {
        match (params.get("cols"), params.get("rows")) {
            (None, None) => Ok(None),
            (cols, rows) => {
                let valid = |value: Option<&Value>| value.and_then(Value::as_u64).filter(|v| (1..=1000).contains(v));
                match (valid(cols), valid(rows)) {
                    (Some(cols), Some(rows)) => Ok(Some((cols as u16, rows as u16))),
                    _ => Err(RpcError::invalid("cols and rows must be between 1 and 1000")),
                }
            }
        }
    }

    /// Apply a size and tell every other viewer, so their view matches the
    /// program's. Called with the terminal's entry locked.
    fn apply_size(&self, pty_id: &str, pty: &mut PtyState, cols: u16, rows: u16) -> Result<(), RpcError> {
        if (pty.cols, pty.rows) == (cols, rows) {
            return Ok(());
        }
        match self.terminals.resize(pty_id, cols, rows) {
            // An agent's terminal between two CLIs: the next one starts at this size.
            Err(_) if pty.agent.is_some() => {}
            other => other.map_err(RpcError::internal)?,
        }
        pty.cols = cols;
        pty.rows = rows;
        for (subscription_id, subscriber) in &pty.subscribers {
            subscriber.notify("pty.resized", json!({ "subscriptionId": subscription_id, "ptyId": pty_id, "cols": cols, "rows": rows }));
        }
        Ok(())
    }

    fn pty_resize(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let (cols, rows) = Self::size_params(&params)?.ok_or_else(|| RpcError::invalid("cols and rows must be between 1 and 1000"))?;
        if let Some((session_id, tab_id)) = self.agent_pty(peer, &params)? {
            if let Some(refusal) = self.agent_input_refusal(peer, &session_id, &tab_id) {
                return Err(refusal);
            }
        }
        let mut ptys = self.ptys.lock().unwrap();
        let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
        // A viewer's window size never reshapes the controller's program.
        if pty.controller.as_deref() != Some(peer.device_id.as_str()) {
            return Err(RpcError::new("not_controller", "another device controls this terminal's size"));
        }
        if pty.exit.is_none() {
            self.apply_size(&pty_id, pty, cols, rows)?;
        }
        Ok(json!({ "cols": pty.cols, "rows": pty.rows }))
    }

    /// Take over a terminal's input and size, optionally at this client's size.
    fn pty_control(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let size = Self::size_params(&params)?;
        let scope = self.pty_session_scope(peer);
        let agent = self.agent_pty(peer, &params)?;
        let wants_start = params.get("start").and_then(Value::as_bool) == Some(true);
        if let Some((session_id, tab_id)) = &agent {
            // Everything that can refuse the call is checked before anything
            // moves: the terminal named (its runtime process), and that a
            // start can be served at all.
            let pty_id = {
                let mut ptys = self.ptys.lock().unwrap();
                self.live_pty(&mut ptys, &params)?.0
            };
            if wants_start && !self.terminals.is_running(&pty_id) {
                self.manager()?;
            }
            match self.agent_input_refusal(peer, session_id, tab_id) {
                // Taking the terminal is how a manager takes the tab over.
                Some(refusal) if refusal.code == "lease_held" && self.access(peer).role == Role::Manager => {
                    let user = peer.user_id.as_deref().unwrap_or_default();
                    let busy = agents_busy(&self.agents, session_id, tab_id);
                    self.collab.claim(tab_id, user, crate::cloud_agents::now_ms(), busy, true).map_err(lease_refusal)?;
                }
                Some(refusal) => return Err(refusal),
                None => {}
            }
        }
        let mut ptys = self.ptys.lock().unwrap();
        let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
        let changed = pty.controller.as_deref() != Some(peer.device_id.as_str());
        pty.controller = Some(peer.device_id.clone());
        pty.controller_user = Some((peer.user_id.clone(), peer.authority));
        // Control first, so a device that just lost it takes the new size as
        // a viewer instead of ignoring it as its own.
        if changed {
            for (subscription_id, subscriber) in &pty.subscribers {
                subscriber.notify(
                    "pty.control",
                    json!({
                        "subscriptionId": subscription_id,
                        "ptyId": pty_id,
                        "control": pty.control_for(subscriber),
                        "controllerId": peer.user_id,
                    }),
                );
            }
        }
        if let (Some((cols, rows)), None) = (size, pty.exit) {
            self.apply_size(&pty_id, pty, cols, rows)?;
        }
        // `start`: the controller asks for the tab's CLI to run (a keystroke
        // or "Start" in the terminal view), as opening a local tab does.
        // Watching, or taking control without it, never starts a process.
        let start = match &agent {
            Some(tab) if wants_start && !self.terminals.is_running(&pty_id) => Some(tab),
            _ => None,
        };
        let Some((session_id, tab_id)) = start else { return Ok(self.describe_pty(&pty_id, pty, peer, scope.as_ref())) };
        // Outside the lock: the CLI's first output is recorded under it.
        drop(ptys);
        self.manager()?
            .ensure_started(session_id, tab_id)
            .map_err(|error| RpcError::new("unavailable", format!("the agent did not start: {error:#}")))?;
        self.tabs_changed.notify_one();
        let mut ptys = self.ptys.lock().unwrap();
        let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
        // The CLI starts at its default size; the controller's applies from here.
        let _ = self.terminals.resize(&pty_id, pty.cols, pty.rows);
        pty.pid = self.terminals.pid(&pty_id);
        Ok(self.describe_pty(&pty_id, pty, peer, scope.as_ref()))
    }

    fn pty_kill(&self, params: Value) -> Result<Value, RpcError> {
        if params.get("ptyId").and_then(Value::as_str).is_some_and(|id| id.starts_with(AGENT_PTY_PREFIX)) {
            return Err(RpcError::forbidden("an agent's terminal closes with its tab"));
        }
        let (pty_id, exited) = {
            let mut ptys = self.ptys.lock().unwrap();
            let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
            pty.closed = true;
            (pty_id, pty.exit.is_some())
        };
        // SIGTERM, then SIGKILL after a grace period, to the whole group.
        self.terminals.kill(&pty_id);
        if exited {
            let ended = Self::remove_pty(&mut self.ptys.lock().unwrap(), &pty_id);
            self.forget_subscriptions(ended);
        }
        Ok(json!({ "ptyId": pty_id }))
    }

    /// Drop a terminal's entry, telling everyone still watching it that it
    /// is gone. Returns their subscriptions, to forget once unlocked.
    fn remove_pty(ptys: &mut HashMap<String, PtyState>, pty_id: &str) -> Vec<String> {
        let Some(pty) = ptys.remove(pty_id) else { return Vec::new() };
        for (subscription_id, peer) in &pty.subscribers {
            peer.notify("pty.closed", json!({ "subscriptionId": subscription_id, "ptyId": pty_id }));
        }
        pty.subscribers.into_keys().collect()
    }

    fn forget_subscriptions(&self, ended: Vec<String>) {
        if ended.is_empty() {
            return;
        }
        let mut subscriptions = self.subscriptions.lock().unwrap();
        for subscription_id in ended {
            subscriptions.remove(&subscription_id);
        }
    }

    fn pty_attach(&self, peer: &Arc<Peer>, params: Value) -> Result<Value, RpcError> {
        let since = params.get("sinceOffset").and_then(Value::as_u64);
        if since.is_some() {
            let generation = params.get("runtimeGeneration").and_then(Value::as_u64);
            let epoch = params.get("epoch").and_then(Value::as_str);
            if generation != Some(self.generation()) || epoch.is_some_and(|epoch| epoch != self.epoch) {
                return Err(RpcError::new("cursor_expired", "the offset belongs to another runtime generation or process"));
            }
        }
        // An agent tab's terminal exists from here on, even before its CLI runs.
        self.agent_pty(peer, &params)?;
        let subscription_id = Self::subscription_id();
        let scope = self.pty_session_scope(peer);
        let mut ptys = self.ptys.lock().unwrap();
        let pty_id = required_str(&params, "ptyId")?.to_string();
        let pty = ptys.get_mut(&pty_id).filter(|pty| !pty.closed).ok_or_else(|| RpcError::not_found("no such terminal"))?;
        let start = pty.start();
        let from = since.unwrap_or(start).clamp(start, pty.end);
        let skip = (from - start) as usize;
        let replay: Vec<u8> = pty.ring.iter().skip(skip).copied().collect();
        // The answer carries the first slice of the replay; the rest follows
        // as ordinary output ahead of anything live, so no frame outgrows the
        // limit. The transport sends an answer before notifications queued
        // while it was made.
        let (first, rest) = replay.split_at(replay.len().min(REPLAY_CHUNK));
        let mut at = from + first.len() as u64;
        for chunk in rest.chunks(REPLAY_CHUNK) {
            // Bounded by the ring, so it does not count toward the lag
            // threshold: attaching several full terminals at once is not a
            // slow link.
            peer.notify("pty.output", json!({ "subscriptionId": subscription_id, "ptyId": pty_id, "offset": at, "data": STANDARD.encode(chunk) }));
            at += chunk.len() as u64;
        }
        pty.subscribers.insert(subscription_id.clone(), peer.clone());
        let mut result = self.describe_pty(&pty_id, pty, peer, scope.as_ref());
        result["subscriptionId"] = json!(subscription_id);
        result["offset"] = json!(from);
        result["end"] = json!(from + first.len() as u64);
        // Everything before this was written before the attach: a client's
        // terminal must not answer queries it finds in it.
        result["replayEnd"] = json!(pty.end);
        result["data"] = json!(STANDARD.encode(first));
        result["truncated"] = json!(since.is_some_and(|since| since < start));
        result["runtimeGeneration"] = json!(self.generation());
        drop(ptys);
        self.subscriptions.lock().unwrap().insert(subscription_id, Subscription::Pty { peer: peer.id, pty_id });
        Ok(result)
    }

    fn on_pty_data(&self, data: PtyData) {
        let agent = data.id.starts_with(AGENT_PTY_PREFIX);
        if !agent && !data.id.starts_with(PTY_PREFIX) {
            return;
        }
        let Ok(bytes) = STANDARD.decode(&data.data) else { return };
        // Read before the terminals are locked.
        let pid = if agent { self.terminals.pid(&data.id) } else { None };
        let mut lagged = Vec::new();
        {
            let mut ptys = self.ptys.lock().unwrap();
            let pty = if agent {
                // Recorded from the CLI's first byte, so whoever attaches
                // later is replayed the screen it drew.
                match self.agent_entry(&mut ptys, &data.id) {
                    Ok(pty) => pty,
                    // Its tab is gone (the last bytes of a CLI that was just stopped).
                    Err(_) => return,
                }
            } else {
                let Some(pty) = ptys.get_mut(&data.id) else { return };
                pty
            };
            if agent && pid.is_some() && pty.pid != pid {
                // Another CLI in the same pane (a restart for a setting, or a
                // resume): it starts at the default size, so the controller's
                // is applied again, and the tab's process state is sent.
                pty.pid = pid;
                if (pty.cols, pty.rows) != crate::session::CLI_PANE_SIZE {
                    let _ = self.terminals.resize(&data.id, pty.cols, pty.rows);
                }
                self.tabs_changed.notify_one();
            }
            let offset = pty.end;
            pty.end += bytes.len() as u64;
            pty.ring.extend(bytes.iter().copied());
            let excess = pty.ring.len().saturating_sub(PTY_RING_BYTES);
            pty.ring.drain(..excess);
            for (subscription_id, peer) in &pty.subscribers {
                // A connection that cannot keep up is not fed without bound:
                // its stream ends here and it resumes from this offset,
                // replayed from the ring (or marked truncated past it).
                if peer.queued.load(Ordering::SeqCst) > MAX_QUEUED_OUTPUT {
                    peer.notify("pty.lagged", json!({ "subscriptionId": subscription_id, "ptyId": data.id, "offset": offset }));
                    lagged.push(subscription_id.clone());
                    continue;
                }
                peer.notify_sized(
                    "pty.output",
                    json!({ "subscriptionId": subscription_id, "ptyId": data.id, "offset": offset, "data": data.data }),
                    data.data.len(),
                );
            }
            for subscription_id in &lagged {
                pty.subscribers.remove(subscription_id);
            }
        }
        if !lagged.is_empty() {
            let mut subscriptions = self.subscriptions.lock().unwrap();
            for subscription_id in lagged {
                subscriptions.remove(&subscription_id);
            }
        }
    }

    fn on_pty_exit(&self, exit: PtyExit) {
        if exit.id.starts_with(AGENT_PTY_PREFIX) {
            // The terminal stays for the tab's next CLI; that this one ended
            // is the tab's process state (`session.tabs`).
            self.tabs_changed.notify_one();
            return;
        }
        let mut ended = Vec::new();
        let evicted = {
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
            if pty.closed {
                ended.extend(Self::remove_pty(&mut ptys, &exit.id));
            }
            // Exited terminals keep their output for a late reader, up to a
            // bound: the oldest are dropped first.
            let mut exited: Vec<(Instant, String)> =
                ptys.iter().filter_map(|(id, pty)| pty.exited_at.map(|at| (at, id.clone()))).collect();
            let mut evicted = Vec::new();
            if exited.len() > MAX_EXITED_PTYS {
                exited.sort();
                for (_, id) in exited.drain(..exited.len() - MAX_EXITED_PTYS) {
                    ended.extend(Self::remove_pty(&mut ptys, &id));
                    evicted.push(id);
                }
            }
            evicted
        };
        self.forget_subscriptions(ended);
        // Release the evicted terminals' PTYs too, not only their output.
        for id in evicted {
            self.terminals.kill(&id);
        }
    }

    // ---- files (remote/files.rs) -------------------------------------------

    fn existing_path(&self, relative: &str) -> Result<PathBuf, RpcError> {
        self.files.existing_path(relative)
    }

    #[cfg(test)]
    pub(super) fn files_for_tests(&self) -> Arc<WorkspaceFiles> {
        self.files.clone()
    }

    fn relative(&self, path: &Path) -> String {
        self.files.relative(path)
    }

    fn fs_watch(&self, peer: &Arc<Peer>, params: Value) -> Result<Value, RpcError> {
        let watching = self
            .subscriptions
            .lock()
            .unwrap()
            .values()
            .filter(|sub| matches!(sub, Subscription::Fs { peer: owner, .. } if *owner == peer.id))
            .count();
        if watching >= super::files::MAX_WATCHES_PER_PEER {
            return Err(RpcError::new("backpressure", "too many file watches on this connection"));
        }
        let subscription_id = Self::subscription_id();
        let notify_peer = peer.clone();
        let id = subscription_id.clone();
        let (watcher, path) = self.files.watcher(params.get("path").and_then(Value::as_str).unwrap_or(""), move |paths| {
            let params = match paths {
                Some(paths) => json!({ "subscriptionId": id, "paths": paths }),
                None => json!({ "subscriptionId": id, "paths": [], "overflow": true }),
            };
            notify_peer.notify("fs.changed", params);
        })?;
        self.subscriptions.lock().unwrap().insert(subscription_id.clone(), Subscription::Fs { peer: peer.id, _watcher: watcher });
        Ok(json!({ "subscriptionId": subscription_id, "path": path }))
    }

    // ---- lifecycle ---------------------------------------------------------

    /// What an archive or delete would lose (saas contract 10.2): unpublished
    /// work per repository, running agent turns and live terminals.
    fn disposition_facts(&self) -> Result<Value, RpcError> {
        let repositories = self.git.disposition_repositories();
        let active_tasks: Vec<Value> = self
            .agents
            .get()
            .map(|agents| agents.tabs())
            .unwrap_or_default()
            .into_iter()
            .filter(|tab| matches!(tab.status, crate::store::index::TabStatus::InProgress | crate::store::index::TabStatus::Waiting))
            .map(|tab| json!({ "sessionId": tab.session_id, "tabId": tab.tab_id, "kind": "agent-turn", "startedAt": tab.modified }))
            .collect();
        // Shells only: an agent's own terminal is its turn, counted above.
        let running_processes = self.ptys.lock().unwrap().values().filter(|pty| pty.agent.is_none() && pty.exit.is_none() && !pty.closed).count();
        Ok(json!({
            "v": 1,
            "repositories": repositories,
            "activeTasks": active_tasks,
            "runningProcesses": running_processes,
            "observedAt": crate::cloud_agents::now_ms(),
        }))
    }

    // ---- sessions --------------------------------------------------------

    fn manager(&self) -> Result<&SessionManager, RpcError> {
        self.sessions.as_ref().ok_or_else(|| RpcError::new("unavailable", "agents are not running in this runtime"))
    }

    /// Every session of this workspace, whoever asks.
    fn workspace_sessions(&self) -> Result<Vec<SessionEntry>, RpcError> {
        let root = self.root.to_string_lossy();
        Ok(index::load().map_err(RpcError::internal)?.into_iter().filter(|session| session.project_path == root).collect())
    }

    /// Sharing is workspace-wide (PRO-30): a person it is shared with sees
    /// every session, anyone else none. `session.list`, `session.sessions`
    /// and the terminals' `sessionId` all follow this rule.
    fn visible_sessions(&self, peer: &Peer) -> Result<Vec<SessionEntry>, RpcError> {
        if !self.access(peer).can_view() {
            return Ok(Vec::new());
        }
        self.workspace_sessions()
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
        let mut p: Params = parse(params)?;
        // A blank mode is no mode: the tab takes the default launch mode.
        p.mode = index::requested_mode(p.mode.take());
        let manager = self.manager()?;
        self.check_new_tab(&p.agent, p.mode.as_deref())?;
        if p.use_worktree {
            // A blank project made before its folder was set up with Git: set it up now, so a worktree can be cut.
            if let Err(error) = crate::cloud_agents::launch::init_blank_repository(&self.root, "main") {
                log::warn!("prepare the blank project folder: {error:#}");
            }
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
        let info = self.agents.get().and_then(|agents| {
            agents.changed(Some(&tab.id), true);
            agents.tab(&tab.id)
        });
        Ok(json!({ "sessionId": entry.id, "tabId": tab.id, "session": entry, "outcome": outcome, "tab": info }))
    }

    /// The agents a new tab may run: offered and installed here.
    fn offered_agents(&self) -> Vec<crate::harness::HarnessInfo> {
        #[cfg(test)]
        if let Some(offered) = self.offered_for_tests.lock().unwrap().clone() {
            return offered;
        }
        crate::harness::offered()
    }

    #[cfg(test)]
    pub(super) fn set_offered_for_tests(&self, offered: Vec<crate::harness::HarnessInfo>) {
        *self.offered_for_tests.lock().unwrap() = Some(offered);
    }

    /// Refuse a new tab whose agent is not installed or whose mode is unknown.
    fn check_new_tab(&self, agent: &str, mode: Option<&str>) -> Result<(), RpcError> {
        if let Some(mode) = mode {
            if !PERMISSION_MODES.contains(&mode) {
                return Err(RpcError::invalid(format!("unknown permission mode {mode}")));
            }
        }
        let agent = self
            .offered_agents()
            .into_iter()
            .find(|harness| harness.id == agent)
            .ok_or_else(|| RpcError::invalid(format!("agent {agent} is not offered")))?;
        if !agent.available {
            return Err(RpcError::new("unavailable", format!("{} is not installed in this workspace", agent.name)));
        }
        Ok(())
    }

    /// `agents/1`: the installed agents, each with its models (and their
    /// efforts) and the launch modes it takes. Paths on the VM stay here.
    fn runtime_agents(&self) -> Result<Value, RpcError> {
        let installed: Vec<crate::harness::HarnessInfo> = self.offered_agents().into_iter().filter(|agent| agent.available).collect();
        // Codex's list depends on the signed-in account; ask only when it can run.
        let codex = if installed.iter().any(|agent| agent.id == "codex") {
            match &self.sessions {
                Some(manager) => manager.codex_models().get(false),
                None => crate::harness::codex::models::fallback(),
            }
        } else {
            Vec::new()
        };
        // This runtime's own CLI, which need not be the desktop's version. A
        // VM lives long: the list is re-read once it has aged, as the desktop
        // does when a picker opens, so a CLI update here is noticed.
        let claude = if installed.iter().any(|agent| agent.id == "claude") { crate::harness::claude::models::get(true) } else { Vec::new() };
        let models = crate::models::offered(claude, codex);
        let agents: Vec<Value> = installed
            .into_iter()
            .map(|agent| {
                let own: Vec<Value> = models
                    .iter()
                    .filter(|model| model.harness == agent.id)
                    .map(|model| {
                        json!({
                            "id": model.id,
                            "label": model.label,
                            "efforts": model.efforts,
                            "defaultEffort": model.default_effort,
                            "acceptsImages": model.accepts_images,
                            "isDefault": model.is_default,
                            "upgrade": model.upgrade,
                            "description": model.description,
                            "alias": model.alias,
                            "resolved": model.resolved,
                        })
                    })
                    .collect();
                let modes: &[&str] = if agent.caps.permission_modes { &PERMISSION_MODES } else { &[] };
                json!({
                    "id": agent.id,
                    "name": agent.name,
                    "caps": agent.caps,
                    "models": own,
                    "modes": modes,
                    "defaultMode": index::DEFAULT_PERMISSION_MODE,
                })
            })
            .collect();
        Ok(json!({ "agents": agents }))
    }

    /// `session/2`: rename, pin or archive a session. Archiving only hides it.
    fn session_update(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let mut patch: crate::session_ops::SessionPatch = parse(params)?;
        if let Some(title) = patch.title.take() {
            let title = title.trim().to_string();
            if title.is_empty() {
                return Err(RpcError::invalid("title is empty"));
            }
            if title.chars().count() > MAX_TITLE_CHARS {
                return Err(RpcError::invalid(format!("title is longer than {MAX_TITLE_CHARS} characters")));
            }
            patch.title = Some(title);
        }
        if patch.is_empty() {
            return Err(RpcError::invalid("name a title, pinned or archived"));
        }
        let updated = crate::session_ops::update_session_meta(&session.id, &patch).map_err(RpcError::internal)?;
        self.sink.emit("session_updated", &updated);
        if let Some(agents) = self.agents.get() {
            // Tab titles fall back to the session's.
            agents.changed(None, false);
        }
        Ok(json!({ "session": updated }))
    }

    /// `session/2`: another agent tab in an existing session.
    fn session_add_tab(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            session_id: String,
            agent: String,
            #[serde(default)]
            model: String,
            #[serde(default)]
            effort: Option<String>,
            #[serde(default)]
            mode: Option<String>,
        }
        let p: Params = parse(params)?;
        let session = self.visible_session(peer, &p.session_id)?;
        let mode = index::requested_mode(p.mode);
        self.check_new_tab(&p.agent, mode.as_deref())?;
        let tab = crate::session_ops::add_tab_entry(
            &session.id,
            &crate::session_ops::NewTab { harness: p.agent, model: p.model, effort: p.effort, permission_mode: mode },
        )
        .map_err(RpcError::internal)?;
        let updated = index::get(&session.id).map_err(RpcError::internal)?;
        self.sink.emit("session_updated", &updated);
        let info = self.agents.get().and_then(|agents| {
            agents.changed(Some(&tab.id), true);
            agents.tab(&tab.id)
        });
        Ok(json!({ "sessionId": session.id, "tabId": tab.id, "session": updated, "tab": info }))
    }

    /// `session/2`: delete a session, its transcripts and, when asked, its
    /// worktree (with every session that ran in it). Its agents are stopped
    /// and its terminals closed first.
    fn session_delete(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let remove_worktree = params.get("removeWorktree").and_then(Value::as_bool).unwrap_or(false);
        let stop = |doomed: &SessionEntry| {
            for tab in &doomed.tabs {
                let Some(manager) = &self.sessions else { break };
                if manager.is_running(&doomed.id, &tab.id) {
                    if let Err(error) = manager.stop(&doomed.id, &tab.id) {
                        log::warn!("stop {}/{} before delete: {error:#}", doomed.id, tab.id);
                    }
                }
            }
            // Its shells go before the worktree does, and are waited for, so
            // nothing holds the directory.
            self.close_session_ptys_waiting(&HashSet::from([doomed.id.clone()]), Some(std::time::Duration::from_secs(5)));
        };
        // A remote caller was shown nothing of what the worktree holds, so a
        // directory git cannot remove is reported, never deleted directly.
        let deleted = crate::session_ops::delete_session_blocking(&*self.sink, &session.id, remove_worktree, crate::git::DirectDelete::Never, &stop)
            .map_err(RpcError::internal)?;
        let kept_branch = deleted.removal.kept_branch;
        let removed = deleted.sessions;
        let removed_ids: HashSet<String> = removed.iter().map(|session| session.id.clone()).collect();
        if let Some(agents) = self.agents.get() {
            for tab in removed.iter().flat_map(|session| &session.tabs) {
                let _ = agents.follow_ups.clear(&tab.id);
                agents.checkpoints.remove(&tab.id);
            }
            agents.changed(None, false);
        }
        self.close_session_ptys(&removed_ids);
        self.close_agent_ptys(removed.iter().flat_map(|session| &session.tabs).map(|tab| &tab.id));
        let mut deleted: Vec<String> = removed_ids.into_iter().collect();
        deleted.sort();
        Ok(json!({ "sessionId": session.id, "deleted": deleted, "keptBranch": kept_branch }))
    }

    /// Close the terminals opened for sessions that are gone.
    fn close_session_ptys(&self, sessions: &HashSet<String>) {
        self.close_session_ptys_waiting(sessions, None);
    }

    /// Close the sessions' terminals; with `wait`, also wait that long for
    /// their processes to exit.
    fn close_session_ptys_waiting(&self, sessions: &HashSet<String>, wait: Option<std::time::Duration>) {
        let (killed, ended) = {
            let mut ptys = self.ptys.lock().unwrap();
            let doomed: Vec<(String, bool)> = ptys
                .iter_mut()
                .filter(|(_, pty)| !pty.closed && pty.session_id.as_ref().is_some_and(|id| sessions.contains(id)))
                .map(|(id, pty)| {
                    pty.closed = true;
                    (id.clone(), pty.exit.is_some())
                })
                .collect();
            let mut ended = Vec::new();
            for (id, exited) in &doomed {
                if *exited {
                    ended.extend(Self::remove_pty(&mut ptys, id));
                }
            }
            (doomed.into_iter().map(|(id, _)| id).collect::<Vec<_>>(), ended)
        };
        match wait {
            Some(timeout) => self.terminals.kill_all_and_wait(&killed, timeout),
            None => {
                for id in killed {
                    self.terminals.kill(&id);
                }
            }
        }
        self.forget_subscriptions(ended);
    }

    fn session_close(&self, params: Value) -> Result<Value, RpcError> {
        let session = index::load()
            .map_err(RpcError::internal)?
            .into_iter()
            .find(|session| Some(session.id.as_str()) == params.get("sessionId").and_then(Value::as_str))
            .filter(|session| session.project_path == self.root.to_string_lossy())
            .ok_or_else(|| RpcError::not_found("no such session"))?;
        let only = params.get("tabId").and_then(Value::as_str);
        let closing: Vec<String> = session.tabs.iter().filter(|tab| only.is_none_or(|id| id == tab.id)).map(|tab| tab.id.clone()).collect();
        // Without agents (tests) nothing is running to stop.
        if let Some(manager) = &self.sessions {
            for tab_id in &closing {
                if manager.is_running(&session.id, tab_id) {
                    manager.stop(&session.id, tab_id).map_err(RpcError::internal)?;
                }
            }
        }
        if params.get("remove").and_then(Value::as_bool) == Some(true) {
            index::update(|sessions| {
                if let Some(entry) = sessions.iter_mut().find(|entry| entry.id == session.id) {
                    entry.tabs.retain(|tab| !closing.contains(&tab.id));
                }
                sessions.retain(|entry| entry.id != session.id || !entry.tabs.is_empty());
                Ok(())
            })
            .map_err(RpcError::internal)?;
            if let Some(agents) = self.agents.get() {
                for tab_id in &closing {
                    let _ = agents.follow_ups.clear(tab_id);
                    agents.checkpoints.remove(tab_id);
                }
            }
            // A removed tab's notes, lease and terminal go with it.
            for tab_id in &closing {
                self.collab.forget_tab(tab_id);
            }
            self.close_agent_ptys(closing.iter());
            match index::get(&session.id) {
                Ok(remaining) => self.sink.emit("session_updated", &remaining),
                Err(_) => {
                    // Its last tab went: the session is gone, and so are its terminals.
                    crate::session_ops::notify_sessions_deleted(&*self.sink, std::slice::from_ref(&session));
                    self.close_session_ptys(&HashSet::from([session.id.clone()]));
                }
            }
        }
        if let Some(agents) = self.agents.get() {
            agents.changed(None, false);
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
        // The same rule as a mailbox send (contract §21.5), for managers
        // too: they take a held lease over explicitly.
        if self.authority(peer) == Authority::Participate && !self.access(peer).can_drive() {
            return Err(RpcError::forbidden("sending needs driver access to the workspace"));
        }
        let busy = agents_busy(&self.agents, &session.id, &tab.id);
        let now = crate::cloud_agents::now_ms();
        match peer.user_id.as_deref() {
            Some(user) => {
                if let Some(held) = self.collab.held_by_other(&tab.id, user, now, busy) {
                    return Err(lease_refusal(LeaseRefusal::Held(held)));
                }
            }
            None if self.authority(peer) == Authority::Participate => return Err(RpcError::forbidden("sending needs a signed-in person")),
            None => {}
        }
        let outcome = self.manager()?.send(&session.id, &tab.id, text.to_string(), Vec::new()).map_err(RpcError::internal)?;
        // Only what reached the agent claims the tab.
        if let Some(user) = peer.user_id.as_deref() {
            // As busy as it was before this send: an expired lease of someone
            // else never blocks it (their idle lease is not live, this turn is).
            let _ = self.collab.claim(&tab.id, user, now, busy, false);
        }
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

    fn session_tabs(&self, peer: &Peer) -> Result<Value, RpcError> {
        let tabs = if self.access(peer).can_view() { self.agents()?.tabs() } else { Vec::new() };
        Ok(json!({ "tabs": tabs }))
    }

    /// The agent tab `(sessionId, tabId)` names, if the caller may see it.
    fn visible_tab(&self, peer: &Peer, params: &Value) -> Result<crate::cloud_agents::AgentTabInfo, RpcError> {
        let session = self.visible_session(peer, required_str(params, "sessionId")?)?;
        let tab_id = required_str(params, "tabId")?;
        self.agents()?
            .tab(tab_id)
            .filter(|tab| tab.session_id == session.id)
            .ok_or_else(|| RpcError::not_found("no such tab"))
    }

    fn session_configure(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let tab = self.visible_tab(peer, &params)?;
        let settings = crate::cloud_agents::Settings::from_json(&params).map_err(|error| RpcError::invalid(error.to_string()))?;
        let agents = self.agents()?;
        agents.ops.configure(&tab.session_id, &tab.tab_id, &settings).map_err(RpcError::internal)?;
        agents.changed(Some(&tab.tab_id), true);
        Ok(json!({ "tab": agents.tab(&tab.tab_id) }))
    }

    fn session_mark_read(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let tab = self.visible_tab(peer, &params)?;
        self.manager()?.mark_read(&tab.session_id, &tab.tab_id).map_err(RpcError::internal)?;
        Ok(json!({}))
    }

    /// Runs on the emitting thread under the tab's lock: only notify.
    fn on_tab_status(&self, status: Value) {
        let (Some(session_id), Some(tab_id)) = (status["sessionId"].as_str(), status["tabId"].as_str()) else { return };
        if !matches!(status["status"].as_str(), Some("in_progress" | "waiting")) {
            self.collab.turn_settled(tab_id, crate::cloud_agents::now_ms());
        }
        let subs = self.session_subs.lock().unwrap();
        for (subscription_id, sub) in subs.iter() {
            if sub.session_id == session_id && sub.tab_id == tab_id {
                sub.peer.notify(
                    "session.status",
                    json!({ "subscriptionId": subscription_id, "sessionId": session_id, "tabId": tab_id, "status": status["status"] }),
                );
            }
        }
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

    /// Cursors are opaque to clients and bound to this runtime generation
    /// and process: a restarted runtime numbers events again from the last
    /// saved one, so a live-only event seen before the restart can share its
    /// seq with a new one after it. Such a cursor is expired, not resumed.
    fn cursor(&self, seq: u64) -> String {
        format!("{}:{}:{seq}", self.generation(), self.epoch)
    }

    fn parse_cursor(&self, cursor: &str) -> Result<u64, RpcError> {
        let expired = || RpcError::new("cursor_expired", "the cursor belongs to another runtime generation or process");
        let mut parts = cursor.splitn(3, ':');
        let (Some(generation), Some(epoch), Some(seq)) = (parts.next(), parts.next(), parts.next()) else { return Err(expired()) };
        if generation.parse::<u64>().ok() != Some(self.generation()) || epoch != self.epoch {
            return Err(expired());
        }
        seq.parse().map_err(|_| expired())
    }
}

fn agents_busy(agents: &OnceLock<Arc<CloudAgents>>, session_id: &str, tab_id: &str) -> bool {
    agents.get().is_some_and(|agents| agents.ops.busy(session_id, tab_id))
}

fn lease_refusal(refusal: LeaseRefusal) -> RpcError {
    match refusal {
        LeaseRefusal::Held(lease) => {
            RpcError::new("lease_held", "someone else is driving this tab").with_data(json!({ "lease": lease }))
        }
        LeaseRefusal::Forbidden => RpcError::forbidden("driving needs driver access to the workspace"),
        LeaseRefusal::Cooldown { until } => RpcError::new("lease_cooldown", "you drove this tab moments ago; others get the first chance")
            .with_data(json!({ "retryAt": until })),
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

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
