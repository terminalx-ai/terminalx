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
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

#[cfg(test)]
use super::files::WorkspaceFiles;
use super::machine::{self as machine, ServedProject};
use super::collab::{self, Access, Change, Collaboration, LeaseRefusal, Role};
use super::protocol::{self, Authority, IdempotencyCache, RpcError, PROTOCOL};
use crate::cloud_agents::{slash, CloudAgents};
use crate::events::AgentEvent;
use crate::harness::claude::commands::SlashCommand;
use crate::pty::{PaneSpec, PtyData, PtyExit, Terminals};
use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry};

/// `text` cut to at most `max` bytes at a character boundary, and whether
/// it was cut; a cut text says so at its end.
fn bounded_text(mut text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n\n… (cut short: the rest did not fit)\n");
    (text, true)
}

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_PTYS: usize = 16;
const MAX_EXITED_PTYS: usize = 8;
const PTY_RING_BYTES: usize = 1024 * 1024;
const PTY_PREFIX: &str = "remote-pty-";
/// Whose upload an attachment is: the person, as a mailbox command names
/// its actor; a connection without one (a development link) its device.
fn attachment_owner(peer: &Peer) -> String {
    peer.user_id.clone().unwrap_or_else(|| format!("device:{}", peer.device_id))
}

/// `session.files`: how long a query may be, and how many hits it answers.
const MAX_FILE_QUERY_BYTES: usize = 400;
const DEFAULT_FILE_HITS: usize = 30;
const MAX_FILE_HITS: usize = 50;
/// The most of a pull request's context file sent to a composer
/// (`session.prContext`): well inside a frame, and far more than a
/// description and a list of changed files usually take.
const MAX_PR_CONTEXT_BYTES: usize = 512 * 1024;

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
/// Longest session title `session.update` accepts, in characters.
const MAX_TITLE_CHARS: usize = 200;
/// Launch modes a tab may be given (`src/lib/models.ts` `PERMISSION_MODES`).
const PERMISSION_MODES: [&str; 5] = ["plan", "manual", "auto", "acceptEdits", "bypassPermissions"];
/// Sink events after which the session list is sent again (`session/2`).
const SESSION_EVENTS: [&str; 3] = ["session_created", "session_updated", crate::session_ops::SESSION_DELETED_EVENT];

/// What the phone app calls itself in `rpc.hello`.
const MOBILE_APP: &str = "terminalx-mobile";

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
    /// The API's key for this person's client installation in this
    /// workspace: the same at every mint, while the attachment and device
    /// are new each time (every wake of a stopped workspace). Absent from an
    /// API that does not send it (`attachment-installation-v1`).
    pub installation_key: Option<String>,
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
    /// Set once the connection has been disconnected from the runtime.
    gone: std::sync::atomic::AtomicBool,
    /// Remembered from `rpc.hello` so role refreshes still exclude phones
    /// from activity that holds compute.
    phone: std::sync::atomic::AtomicBool,
    /// Held while this connection counts as use of the workspace for idle
    /// suspend: only a client that can type does (contract 9.4.1).
    attached: Mutex<Option<crate::cloud_activity::Attached>>,
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
    pub(crate) fn disconnected(&self) -> bool { self.gone.load(Ordering::SeqCst) }

    pub fn new(device_id: String, authority: Authority) -> (Arc<Self>, Notifications) {
        Self::for_user(device_id, authority, None)
    }

    /// Whether this connection is reported as an attached client.
    #[cfg(test)]
    pub(crate) fn counts_as_attached(&self) -> bool {
        self.attached.lock().unwrap().is_some()
    }

    /// Whether this connection is counted as one that may answer a
    /// permission request.
    #[cfg(test)]
    pub(crate) fn counts_as_approver(&self) -> bool {
        self.attached.lock().unwrap().as_ref().is_some_and(crate::cloud_activity::Attached::approves)
    }

    pub fn for_user(device_id: String, authority: Authority, user_id: Option<String>) -> (Arc<Self>, Notifications) {
        Self::for_installation(device_id, authority, user_id, None)
    }

    pub fn for_installation(device_id: String, authority: Authority, user_id: Option<String>, installation_key: Option<String>) -> (Arc<Self>, Notifications) {
        let (outbound, receiver) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let peer = Arc::new(Self {
            id: NEXT_PEER.fetch_add(1, Ordering::Relaxed),
            device_id,
            authority,
            user_id: user_id.filter(|user| !user.is_empty()),
            installation_key: installation_key.filter(|key| !key.is_empty()),
            outbound,
            queued: queued.clone(),
            granted: Mutex::new(None),
            presence: Mutex::new(Presence { tab_id: None, activity: "viewing", since: crate::cloud_agents::now_ms() }),
            closed: tokio::sync::Notify::new(),
            gone: std::sync::atomic::AtomicBool::new(false),
            phone: std::sync::atomic::AtomicBool::new(false),
            attached: Mutex::new(None),
        });
        (peer, Notifications { receiver, queued })
    }

    /// Resolves once the runtime has closed this connection; the transport
    /// then hangs up.
    pub async fn closed(&self) {
        self.closed.notified().await
    }

    /// The person and their installation, when the API named both. The key
    /// is only ever compared together with the person: the API supplies the
    /// user id, so nobody else can present the pair.
    fn installation(&self) -> Option<(&str, &str)> {
        Some((self.user_id.as_deref()?, self.installation_key.as_deref()?))
    }

    /// Whose numbered terminal writes these are. A writer keeps its count
    /// when its installation comes back as a new device, so a resend is
    /// still recognised and the next write is still the next one. Without
    /// an installation key writes are counted per device, as before.
    fn input_scope(&self) -> String {
        match self.installation() {
            Some((user, key)) => format!("installation:{user}:{key}"),
            None => format!("device:{}", self.device_id),
        }
    }

    fn granted(&self, capability: &str) -> bool {
        self.granted.lock().unwrap().as_ref().is_some_and(|granted| granted.contains(capability))
    }

    pub(super) fn id(&self) -> u64 {
        self.id
    }

    /// The connection is over: it was disconnected, or nothing reads what is
    /// sent to it any more.
    pub(super) fn hung_up(&self) -> bool {
        self.gone.load(Ordering::SeqCst) || self.outbound.is_closed()
    }

    /// Send `value` in order with this connection's notifications.
    fn deliver(&self, value: Value) {
        let _ = self.outbound.send((value, 0));
    }

    pub(super) fn notify(&self, event: &str, params: Value) {
        self.notify_sized(event, params, 0);
    }

    pub(super) fn notify_sized(&self, event: &str, params: Value, size: usize) {
        self.queued.fetch_add(size, Ordering::SeqCst);
        if self.outbound.send((json!({ "event": event, "params": params }), size)).is_err() {
            self.queued.fetch_sub(size, Ordering::SeqCst);
        }
    }
}

/// Authority belongs to the keystroke, not the later writer thread.
struct PtyInput {
    collaboration: Option<collab::v2::Permit>,
    pid: Option<u32>,
    data: Vec<u8>,
    privacy: crate::data_privacy::Ticket,
}

impl PtyInput {
    fn write(&self, terminals: &crate::pty::Terminals, manager: Option<&SessionManager>, pane: &str) -> anyhow::Result<bool> {
        let write = || terminals.write_remote(pane, &self.data, &self.privacy, self.collaboration.as_ref(), self.pid);
        match manager {
            Some(manager) => manager.with_raw_terminal_input(pane, write),
            None => write(),
        }
    }
}


#[derive(Clone, Copy)]
enum RunDiscovery {
    Active,
    Backfill,
    Exit,
}

enum EvictedRun {
    Backfilled,
    Observed,
}

/// One remote terminal. Its bytes live only in `ring`: nothing here writes
/// terminal output into a session transcript.
struct PtyState {
    /// Issued in creation order; clients name tabs "Terminal <number>".
    number: u64,
    cwd: String,
    /// The session the terminal was opened for (`pty/2`), if any.
    session_id: Option<String>,
    /// The machine project it runs in (`machine/1`); `cwd` is relative to it.
    project_id: Option<String>,
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
    /// The controller's installation key, when the API named one: see
    /// [`WorkspaceRpc::resume_control`].
    controller_installation: Option<String>,
    ring: VecDeque<u8>,
    /// Byte offset one past the last byte ever written by the terminal.
    end: u64,
    exit: Option<Option<i32>>,
    /// When this server heard the exit. Historical backfill has no timestamp.
    exited_at: Option<Instant>,
    /// `pty.kill` was called; the entry goes once the exit is reported.
    closed: bool,
    /// A fallible cleanup must retain ownership metadata even after PTY exit.
    stop_pending: bool,
    /// Last applied `pty.write` seq per ([`Peer::input_scope`], writer): a
    /// resend is dropped and a gap is refused, so input is applied once and
    /// in order.
    applied_seq: HashMap<(String, String), (u64, Instant)>,
    /// Accepted input, written by the terminal's own writer thread so a
    /// program that stops reading never stalls the connection.
    input: std::sync::mpsc::Sender<PtyInput>,
    input_pending: Arc<AtomicUsize>,
    subscribers: HashMap<String, Arc<Peer>>,
    /// Set for an agent tab's own terminal (`agent-pty/1`): the pane the
    /// tab's CLI runs in. The session manager owns its process, so it is
    /// never listed, killed or evicted as a shell is, and it stays through
    /// every CLI the tab starts in it.
    agent: Option<AgentPty>,
    /// Set for an agent's install or sign-in on a machine (`machine/4`,
    /// PRO-350): never listed as a shell, and its exit makes the agents'
    /// logins be read again.
    setup: Option<SetupPty>,
    /// Set for a session's own script run on a machine (`machine/7`,
    /// PRO-403): the runtime's pane of one of its project's saved actions or
    /// of its workspace setup. The runtime owns the process, so this entry
    /// only records and relays it: it is listed with its session, never
    /// counted against [`MAX_PTYS`] and never ended by an eviction.
    run: Option<SessionRun>,
}

/// What a session's script run is (`machine/7`).
#[derive(Clone, Debug, PartialEq, Eq)]
enum SessionRun {
    Action { action_id: String, name: String },
    Setup,
}

impl SessionRun {
    /// The session and run a runtime pane id names: `<session>:action-…`
    /// ([`crate::action_runner`]) or `<session>:workspace-setup-…`
    /// ([`crate::workspace_setup`]). A cheap test first: every pane's output
    /// passes through here.
    fn of_pane(pane: &str, title: Option<&str>) -> Option<(String, Self)> {
        if !pane.contains(':') || pane.starts_with(AGENT_PTY_PREFIX) || pane.starts_with(PTY_PREFIX) {
            return None;
        }
        if let Some(session) = crate::workspace_setup::pane_session(pane) {
            return Some((session.to_string(), Self::Setup));
        }
        let (session, action_id) = crate::action_runner::parse_pane(pane)?;
        Some((session.to_string(), Self::Action { name: title.unwrap_or(&action_id).to_string(), action_id }))
    }

    fn wire(&self) -> Value {
        match self {
            Self::Action { action_id, name } => json!({ "kind": "action", "actionId": action_id, "name": name }),
            Self::Setup => json!({ "kind": "setup" }),
        }
    }
}

/// A workspace setup attempt on the wire (`machine/7`). Its pane, while the
/// runtime keeps it, is the terminal `pty.list` lists as its `run`.
fn setup_wire(setup: &crate::workspace_setup::Setup) -> Value {
    json!({
        "paneId": setup.pane_id,
        "command": setup.command,
        "status": setup.status,
        "exitCode": setup.exit_code,
        "error": setup.error,
        "hasPane": setup.has_pane,
    })
}

struct SetupPty {
    harness: String,
    step: crate::harness::setup::Step,
}

/// A shell-like terminal to start: where it runs and what it belongs to.
struct NewPty<'a> {
    /// Relative to its project, as `pty.list` shows it.
    cwd: String,
    /// Where the program starts.
    start_in: &'a str,
    command: Option<&'a str>,
    session_id: Option<String>,
    project_id: Option<String>,
    cols: u16,
    rows: u16,
    setup: Option<SetupPty>,
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
    /// `project` is the machine project watched (`machine/1`).
    Fs { peer: u64, project: Option<String>, _watcher: Box<dyn Send> },
}

impl Subscription {
    fn peer(&self) -> u64 {
        match self {
            Self::Pty { peer, .. } | Self::Session { peer } | Self::Fs { peer, .. } => *peer,
        }
    }
}

type Gate = Arc<tokio::sync::Mutex<()>>;

/// What a runtime serves (PRO-340, docs/MACHINES.md).
enum Scope {
    /// One root: a cloud workspace, or a runtime started with
    /// `--project-root`. Served exactly as before `machine/1`.
    Workspace { project: Arc<ServedProject>, mirror: super::mirror::WorkspaceMirror },
    /// Every project of the machine, each named by its `projectId`.
    Machine { projects: machine::Projects, identity: machine::Identity },
}

/// How often a machine looks again for a new name or project set, besides
/// the events that say so at once.
const MACHINE_CHANGE_POLL: Duration = Duration::from_secs(5);

/// How often a machine reads its update record and status again, besides
/// the changes it makes itself (`machine/3`).
const UPDATE_STATUS_POLL: Duration = Duration::from_secs(2);

pub struct WorkspaceRpc {
    scope: Scope,
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
    /// Runtime-owned run panes whose exited remote records were evicted.
    /// Accessed under the ptys lock so discovery cannot race eviction.
    evicted_runs: Mutex<HashMap<String, EvictedRun>>,
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
    /// Receipts of `agent-commands/1` (PRO-343): present only when the
    /// agents have no cloud mailbox, so the namespace is offered only then.
    agent_commands: OnceLock<super::agent_commands::Journal>,
    /// Connections that said hello, for workspace-wide notifications.
    peers: Mutex<HashMap<u64, Weak<Peer>>>,
    /// Streams to the workspace's own ports (PRO-28).
    pub(super) ports: Arc<super::ports::Ports>,
    tabs_changed: Arc<tokio::sync::Notify>,
    /// Raised when a session is created, updated or deleted; the list goes
    /// out as `session.sessions` to `session/2` connections.
    sessions_changed: Arc<tokio::sync::Notify>,
    /// Raised when a machine's projects or settings may have changed; a
    /// change goes out as `machine.changed` to `machine/1` connections.
    machine_changed: Arc<tokio::sync::Notify>,
    /// The machine host's direct endpoints and relay access (`machine/2`).
    machine_access: OnceLock<Arc<dyn machine::MachineAccess>>,
    /// The machine's version and updates (`machine/3`, PRO-354); absent on
    /// a workspace runtime, or one whose data directory cannot be named.
    machine_updates: Mutex<Option<Arc<super::machine_update::MachineUpdates>>>,
    /// The status as the served updates stood when they started being
    /// served (which updates, and what): the watcher's first compare.
    update_baseline: Mutex<Option<(usize, String)>>,
    /// Clones started from another computer (`machine/6`, PRO-351).
    machine_clones: Arc<super::machine_projects::Clones>,
    /// Stands in for the runtime user's home directory in tests (`machine/6`).
    #[cfg(test)]
    home_for_tests: Mutex<Option<std::path::PathBuf>>,
    /// Stands in for `harness::offered` in tests, which cannot install agents.
    #[cfg(test)]
    offered_for_tests: Mutex<Option<Vec<crate::harness::HarnessInfo>>>,
    /// Stands in for the agents' login probes in tests (PRO-350).
    #[cfg(test)]
    sign_ins_for_tests: Mutex<Option<HashMap<String, super::machine_agents::Probed>>>,
    /// Stands in for a setup step's installer or sign-in in tests (PRO-350).
    #[cfg(test)]
    setup_command_for_tests: Mutex<Option<String>>,
    #[cfg(test)]
    commands_for_tests: Mutex<Option<Option<Vec<SlashCommand>>>>,
    /// Terminal input this runtime counted as use of the workspace (the
    /// process-wide activity flag is shared by every test).
    #[cfg(test)]
    pub(super) input_activity: AtomicUsize,
}

impl WorkspaceRpc {
    /// One root (a cloud workspace, or `--project-root`). `sessions` is
    /// absent only in tests that do not need agents.
    pub fn new(
        root: &Path,
        generation: u64,
        sink: Arc<dyn EventSink>,
        terminals: Arc<Terminals>,
        sessions: Option<SessionManager>,
    ) -> anyhow::Result<Arc<Self>> {
        let root = std::fs::canonicalize(root)?;
        let scope = Scope::Workspace { mirror: super::mirror::WorkspaceMirror::new(root.clone()), project: Arc::new(ServedProject::workspace(root)) };
        Ok(Self::serving(scope, generation, sink, terminals, sessions))
    }

    /// Every project of this machine (`machine/1`, PRO-340), from the
    /// projects its store already knows. A client that does not ask for
    /// `machine/1` is served whatever names no project.
    pub fn machine(
        identity: machine::Identity,
        generation: u64,
        sink: Arc<dyn EventSink>,
        terminals: Arc<Terminals>,
        sessions: Option<SessionManager>,
    ) -> anyhow::Result<Arc<Self>> {
        let has_window = identity.has_window;
        let rpc = Self::serving(Scope::Machine { projects: machine::Projects::default(), identity }, generation, sink.clone(), terminals, sessions);
        match super::machine_update::Environment::of_this_runtime(has_window) {
            Ok(environment) => rpc.serve_updates(super::machine_update::MachineUpdates::new(environment, sink.clone())),
            Err(error) => log::warn!("machine/3: this runtime cannot report its updates: {error:#}"),
        }
        // A project added or removed here, and Settings (which holds the name).
        for event in ["projects_changed", "settings_file_changed"] {
            let notify = rpc.machine_changed.clone();
            sink.listen(event, Box::new(move |_| notify.notify_one()));
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let weak = Arc::downgrade(&rpc);
            let notify = rpc.machine_changed.clone();
            runtime.spawn(async move {
                // The name, the project set and (`machine/2`) the direct addresses.
                let look = |rpc: Option<Arc<WorkspaceRpc>>| move || machine::fingerprint().map(|known| format!("{known}\u{0}{:?}", rpc.map(|rpc| rpc.direct_endpoints()).unwrap_or_default()));
                let mut last = tokio::task::spawn_blocking(look(weak.upgrade())).await.ok().flatten();
                loop {
                    tokio::select! {
                        _ = notify.notified() => {}
                        _ = tokio::time::sleep(MACHINE_CHANGE_POLL) => {}
                    }
                    let Some(rpc) = weak.upgrade() else { return };
                    let Ok(Some(now)) = tokio::task::spawn_blocking(look(Some(rpc.clone()))).await else { continue };
                    if last.as_ref() != Some(&now) {
                        last = Some(now);
                        let _ = tokio::task::spawn_blocking(move || rpc.broadcast_machine()).await;
                    }
                }
            });
        }
        Ok(rpc)
    }

    fn serving(scope: Scope, generation: u64, sink: Arc<dyn EventSink>, terminals: Arc<Terminals>, sessions: Option<SessionManager>) -> Arc<Self> {
        let rpc = Arc::new(Self {
            scope,
            generation: AtomicU64::new(generation),
            epoch: format!("epoch-{}", uuid::Uuid::new_v4().simple()),
            next_pty_number: AtomicU64::new(1),
            version: env!("CARGO_PKG_VERSION").into(),
            sink: sink.clone(),
            terminals,
            sessions,
            ptys: Mutex::new(HashMap::new()),
            evicted_runs: Mutex::new(HashMap::new()),
            removed_agent_tabs: Mutex::new(VecDeque::new()),
            session_subs: Mutex::new(HashMap::new()),
            subscriptions: Mutex::new(HashMap::new()),
            idempotency: Mutex::new(IdempotencyCache::default()),
            in_flight: Mutex::new(HashMap::new()),
            collab: Arc::new(Collaboration::new()),
            agents: OnceLock::new(),
            agent_commands: OnceLock::new(),
            peers: Mutex::new(HashMap::new()),
            ports: Arc::new(super::ports::Ports::default()),
            tabs_changed: Arc::new(tokio::sync::Notify::new()),
            sessions_changed: Arc::new(tokio::sync::Notify::new()),
            machine_changed: Arc::new(tokio::sync::Notify::new()),
            machine_access: OnceLock::new(),
            machine_updates: Mutex::new(None),
            update_baseline: Mutex::new(None),
            machine_clones: Arc::new(super::machine_projects::Clones::default()),
            #[cfg(test)]
            home_for_tests: Mutex::new(None),
            #[cfg(test)]
            offered_for_tests: Mutex::new(None),
            #[cfg(test)]
            sign_ins_for_tests: Mutex::new(None),
            #[cfg(test)]
            setup_command_for_tests: Mutex::new(None),
            #[cfg(test)]
            commands_for_tests: Mutex::new(None),
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
            crate::issue_pipeline::host::CHANGED,
            Box::new(move |payload| {
                if let (Some(rpc), Ok(pipeline)) = (weak.upgrade(), serde_json::from_str::<Value>(payload)) {
                    rpc.broadcast_pipeline(pipeline_on_the_wire(pipeline));
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
        rpc
    }

    // ---- what this runtime serves (PRO-340) --------------------------------

    fn is_machine(&self) -> bool {
        matches!(self.scope, Scope::Machine { .. })
    }

    /// The project a call names: a workspace's one root, or on a machine the
    /// one its `projectId` names. A client without `machine/1` names none, so
    /// a machine refuses it the call (docs/MACHINES.md, Project scoping).
    fn project(&self, peer: &Peer, params: &Value) -> Result<Arc<ServedProject>, RpcError> {
        match &self.scope {
            Scope::Workspace { project, .. } => Ok(project.clone()),
            Scope::Machine { projects, .. } => {
                if !peer.granted(machine::MACHINE) {
                    return Err(RpcError::new("capability_not_granted", format!("this runtime serves several projects: the call needs {} and a projectId", machine::MACHINE)));
                }
                match params.get("projectId") {
                    Some(Value::String(id)) => projects.get(id),
                    None | Some(Value::Null) => Err(RpcError::invalid("projectId is required: this runtime serves several projects")),
                    Some(_) => Err(RpcError::invalid("projectId must be a string")),
                }
            }
        }
    }

    /// Every project served so far, where searches, uploads and watches live.
    fn served_projects(&self) -> Vec<Arc<ServedProject>> {
        match &self.scope {
            Scope::Workspace { project, .. } => vec![project.clone()],
            Scope::Machine { projects, .. } => projects.served(),
        }
    }

    /// Whether a session or pipeline in `project_path` is this runtime's:
    /// the workspace's own (with its nested checkouts), or one of the
    /// machine's projects (`ids`, from [`machine::ids_by_path`]).
    fn owns(&self, project_path: &str, ids: Option<&HashMap<String, String>>) -> bool {
        match &self.scope {
            Scope::Workspace { project, .. } => super::session_target::owns_project(&project.root, project_path),
            Scope::Machine { .. } => match ids {
                Some(ids) => ids.contains_key(project_path),
                None => machine::ids_by_path().contains_key(project_path),
            },
        }
    }

    /// The machine's projects by path; `None` for a workspace runtime.
    fn project_ids(&self) -> Option<HashMap<String, String>> {
        self.is_machine().then(machine::ids_by_path)
    }

    /// A session as it is sent: on a machine it names its project.
    fn session_wire(&self, session: &SessionEntry, ids: Option<&HashMap<String, String>>) -> Value {
        self.session_wire_with(session, ids, None)
    }

    /// Whether `peer` is told which account each tab runs on: a label can be
    /// an email address, so only a connection that manages the machine is.
    fn sees_accounts(&self, peer: &Peer) -> bool {
        self.is_machine() && self.authority(peer) == Authority::Manage
    }

    /// A session as it is sent. Given `accounts` (a machine, to a manage
    /// connection) each tab names the account it runs on when its agent has
    /// several there (`machine/8`, PRO-408); it holds what was read for the
    /// sessions sent together.
    fn session_wire_with(&self, session: &SessionEntry, ids: Option<&HashMap<String, String>>, accounts: Option<&mut super::machine_session::Accounts>) -> Value {
        let mut value = json!(session);
        if let (Scope::Machine { projects, .. }, Some(ids), Some(fields)) = (&self.scope, ids, value.as_object_mut()) {
            let id = ids.get(&session.project_path);
            fields.insert("projectId".into(), json!(id));
            let checkout = id.and_then(|id| projects.get_at(id, &session.project_path).ok())
                .and_then(|project| project.session_checkout(session));
            let (file_root, repository) = checkout.map_or((None, None), |(root, repo)| (Some(root), repo));
            fields.insert("fileRoot".into(), json!(file_root));
            fields.insert("fileRepository".into(), json!(repository));
        }
        if let Some(accounts) = accounts {
            super::machine_session::account_labels(&mut value, session, accounts);
        }
        value
    }

    /// A pipeline as it is sent: on a machine it names its project too.
    fn pipeline_wire(&self, pipeline: Value, ids: Option<&HashMap<String, String>>) -> Value {
        let mut pipeline = pipeline_on_the_wire(pipeline);
        if let Some(ids) = ids {
            let id = pipeline.get("projectPath").and_then(Value::as_str).and_then(|path| ids.get(path)).cloned();
            if let Some(fields) = pipeline.as_object_mut() {
                fields.insert("projectId".into(), json!(id));
            }
        }
        pipeline
    }

    /// On a machine, a call that names a session, terminal, pipeline or
    /// watch takes no `projectId`; one that is given must be that object's
    /// project, or the call is refused before anything is done.
    fn check_named_project(&self, method: &str, params: &Value) -> Result<(), RpcError> {
        if !self.is_machine() || machine::needs_project(method, params) {
            return Ok(());
        }
        let given = match params.get("projectId") {
            None | Some(Value::Null) => return Ok(()),
            Some(Value::String(given)) => given.as_str(),
            Some(_) => return Err(RpcError::invalid("projectId must be a string")),
        };
        let path_of_session = |id: &str| index::get(id).ok().map(|session| session.project_path);
        let named_path: Option<String> = if let Some(session_id) = params.get("sessionId").and_then(Value::as_str) {
            path_of_session(session_id)
        } else if let Some(pipeline) = params.get("pipeline").and_then(Value::as_str).filter(|_| method.starts_with("pipeline.")) {
            crate::issue_pipeline::store::get(pipeline).ok().map(|pipeline| pipeline.project_path)
        } else if let Some(pty_id) = params.get("ptyId").and_then(Value::as_str) {
            let ptys = self.ptys.lock().unwrap();
            match ptys.get(pty_id) {
                Some(pty) if pty.agent.is_none() => return self.same_project(given, pty.project_id.as_deref()),
                _ => pty_id.strip_prefix(AGENT_PTY_PREFIX).and_then(|tab| index::load().ok()?.into_iter().find(|session| session.tabs.iter().any(|entry| entry.id == tab))).map(|session| session.project_path),
            }
        } else if let Some(subscription) = params.get("subscriptionId").and_then(Value::as_str) {
            if let Some(Subscription::Fs { project, .. }) = self.subscriptions.lock().unwrap().get(subscription) {
                return self.same_project(given, project.as_deref());
            }
            None
        } else {
            None
        };
        match named_path {
            Some(path) => self.same_project(given, Some(&machine::project_id(&path))),
            None => Ok(()),
        }
    }

    fn same_project(&self, given: &str, named: Option<&str>) -> Result<(), RpcError> {
        match named {
            Some(named) if named != given => Err(RpcError::invalid(format!("projectId {given} is not the project of what this call names"))),
            _ => Ok(()),
        }
    }

    /// `machine.changed`: the machine's name or project set changed.
    fn broadcast_machine(&self) {
        let Scope::Machine { identity, .. } = &self.scope else { return };
        let projects = match machine::projects() {
            Ok(projects) => projects,
            Err(error) => {
                log::warn!("project list for machine.changed: {}", error.message);
                return;
            }
        };
        self.notify_granted(machine::MACHINE, "machine.changed", json!({ "machine": self.describe_machine(identity), "projects": projects["projects"] }));
    }

    /// The machine host's direct endpoints and relay access (`machine/2`,
    /// PRO-345). Set once, by the runtime that hosts the machine.
    pub fn set_machine_access(&self, access: Arc<dyn machine::MachineAccess>) {
        if self.machine_access.set(access).is_err() {
            log::warn!("machine access was already set");
        }
        self.machine_changed.notify_one();
    }

    fn direct_endpoints(&self) -> Vec<String> {
        self.machine_access.get().map(|access| access.direct_endpoints()).unwrap_or_default()
    }

    /// Serve `machine/3` from `updates`, and send `machine.updateChanged`
    /// to `machine/3` connections whenever the status changes: the helper's
    /// record (read every [`UPDATE_STATUS_POLL`]), a release check, the
    /// blockers and the connected computers.
    fn serve_updates(self: &Arc<Self>, updates: super::machine_update::MachineUpdates) {
        let updates = Arc::new(updates);
        let previous = self.machine_updates.lock().unwrap().replace(updates);
        // What the status is as these updates start being served, taken
        // now: a change made after this returns is sent, however late the
        // watcher's first look at them comes on a busy machine.
        *self.update_baseline.lock().unwrap() = self.update_fingerprint();
        // One watcher, whichever updates it serves (a test replaces them):
        // woken to take its first look at the new ones now.
        if let Some(previous) = previous {
            previous.changed.notify_one();
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let weak = Arc::downgrade(self);
        runtime.spawn(async move {
            // What was sent last, and from which updates.
            let mut last: Option<(usize, String)> = None;
            loop {
                // Held only while it looks: the runtime may drop meanwhile.
                let Some(rpc) = weak.upgrade() else { return };
                let looked = tokio::task::spawn_blocking(move || {
                    let fingerprint = rpc.update_fingerprint();
                    (fingerprint, rpc.update_baseline.lock().unwrap().clone())
                })
                .await
                .ok();
                if let Some((Some(now), baseline)) = looked {
                    // New updates are compared with how they stood when served.
                    if last.as_ref().is_none_or(|last| last.0 != now.0) {
                        last = baseline.filter(|baseline| baseline.0 == now.0).or_else(|| Some(now.clone()));
                    }
                    if last.as_ref() != Some(&now) {
                        let Some(rpc) = weak.upgrade() else { return };
                        let _ = tokio::task::spawn_blocking(move || rpc.broadcast_update_status()).await;
                        last = Some(now);
                    }
                }
                let Some(notify) = weak.upgrade().and_then(|rpc| rpc.updates()).map(|updates| updates.changed.clone()) else { return };
                tokio::select! {
                    _ = notify.notified() => {}
                    _ = tokio::time::sleep(UPDATE_STATUS_POLL) => {}
                }
            }
        });
    }

    /// The status as nobody in particular sees it, and which updates said it.
    fn update_fingerprint(&self) -> Option<(usize, String)> {
        let access = self.machine_access.get().map(|access| access.as_ref() as &dyn machine::MachineAccess);
        self.updates().map(|updates| (Arc::as_ptr(&updates) as usize, updates.fingerprint(access)))
    }

    fn updates(&self) -> Option<Arc<super::machine_update::MachineUpdates>> {
        self.machine_updates.lock().unwrap().clone()
    }

    /// `machine.updateChanged`: each `machine/3` connection gets the status
    /// as it sees it (the other computers are everyone but itself).
    fn broadcast_update_status(&self) {
        let Some(updates) = self.updates() else { return };
        let access = self.machine_access.get().map(|access| access.as_ref() as &dyn machine::MachineAccess);
        for peer in self.live_peers().into_iter().filter(|peer| peer.granted(machine::MACHINE_3)) {
            let status = updates.status(Some(&peer.device_id), access);
            peer.notify(super::machine_update::CHANGED, json!({ "status": status }));
        }
    }

    /// `machine.updateStatus` and `machine.update` (`machine/3`). Blocking.
    fn machine_update_call(&self, peer: &Peer, method: &str, params: &Value) -> Result<Value, RpcError> {
        if !self.is_machine() {
            return Err(RpcError::new("method_not_found", "this runtime serves one workspace"));
        }
        let updates = self.updates().ok_or_else(|| RpcError::new("update_unavailable", "this runtime cannot tell how it was installed"))?;
        let access = self.machine_access.get().map(|access| access.as_ref() as &dyn machine::MachineAccess);
        match method {
            "machine.updateStatus" => updates.update_status(params, &peer.device_id, access),
            _ => updates.update(params, &peer.device_id, access),
        }
    }

    #[cfg(test)]
    pub(super) fn set_machine_updates_for_tests(self: &Arc<Self>, updates: super::machine_update::MachineUpdates) {
        self.serve_updates(updates);
    }

    #[cfg(test)]
    pub(super) fn machine_updates_for_tests(&self) -> Arc<super::machine_update::MachineUpdates> {
        self.updates().expect("machine/3 is served")
    }

    /// `machine.describe`, with `directEndpoints` (`machine/2`).
    fn describe_machine(&self, identity: &machine::Identity) -> Value {
        let mut described = machine::describe(identity);
        described["directEndpoints"] = json!(self.direct_endpoints());
        described
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Serve agent tabs and keys from `agents`, and tell connections when
    /// the tab list changes. Call inside a Tokio runtime.
    pub fn set_agents(self: &Arc<Self>, agents: Arc<CloudAgents>) {
        agents.share_collaboration(self.collab.clone());
        // Without a mailbox, send, steer, stop and decisions are live calls
        // with receipts kept here (docs/MACHINES.md decision 3). With one,
        // they go through it only. A journal that cannot be opened offers
        // nothing: no live command without a durable receipt.
        if agents.api.is_none() && self.agents.get().is_none() {
            match super::agent_commands::Journal::open(agents.dir(), crate::cloud_agents::now_ms()) {
                Ok(journal) => {
                    let _ = self.agent_commands.set(journal);
                }
                Err(error) => log::error!("open the agent command receipts; agent-commands/1 is not offered: {error:#}"),
            }
        }
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
        let ids = self.project_ids();
        let wire: Vec<Value> = sessions.iter().map(|session| self.session_wire_with(session, ids.as_ref(), None)).collect();
        // The same list naming each tab's account, for the connections that manage the machine.
        let labelled: Option<Vec<Value>> = peers.iter().any(|peer| self.sees_accounts(peer)).then(|| {
            let mut accounts = super::machine_session::Accounts::default();
            sessions.iter().map(|session| self.session_wire_with(session, ids.as_ref(), Some(&mut accounts))).collect()
        });
        for peer in peers {
            // Workspace-wide, as `visible_sessions`.
            let visible: &[Value] = match (self.access(&peer).can_view(), &labelled) {
                (false, _) => &[],
                (true, Some(labelled)) if self.sees_accounts(&peer) => labelled,
                (true, _) => &wire,
            };
            peer.notify("session.sessions", json!({ "sessions": visible }));
        }
    }

    /// `pipeline.changed`: an issue's pipeline was written. Whoever may see
    /// the workspace's sessions may see the pipeline that names them.
    fn broadcast_pipeline(&self, pipeline: Value) {
        let pipeline = match self.project_ids() {
            Some(ids) => self.pipeline_wire(pipeline, Some(&ids)),
            None => pipeline,
        };
        for peer in self.live_peers() {
            if peer.granted("pipeline/1") && self.access(&peer).can_view() {
                peer.notify("pipeline.changed", json!({ "pipeline": pipeline }));
            }
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

    /// Looking does not hold compute (terminalx-saas contract 9.4.1): a
    /// connection keeps the workspace from idle suspending only while it
    /// can type, which is a manager's or a driver's desktop. A viewer reads,
    /// and a phone acts through the mailbox, where a command counts itself.
    /// Typing and agent turns are reported whoever is attached. Before the
    /// API has listed who has access there are no roles to go by, and every
    /// connection but a phone counts, as before.
    fn count_attachment(&self, peer: &Peer) {
        // Read access under the attachment lock: a concurrent hello must
        // not overwrite a role refresh with a decision from the old list.
        let mut attached = peer.attached.lock().unwrap();
        let access = self.access(peer);
        let types = !self.collab.known() || access.can_drive();
        // Whether it may answer the agent's permission requests; before
        // there are roles to go by, as for typing.
        let approves = !self.collab.known() || access.can_approve;
        if peer.phone.load(Ordering::SeqCst) || !types || peer.gone.load(Ordering::SeqCst) {
            *attached = None;
        } else if attached.as_ref().is_none_or(|current| current.approves() != approves) {
            // The old count goes before the new one is taken.
            *attached = None;
            *attached = Some(crate::cloud_activity::attached(approves));
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
    /// then refuses participants everything until it knows, and clients must
    /// not read the role as "not shared".
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
        let _admission = self.collab.enter_admission();
        let first = !self.collab.known();
        let diff = self.collab.set_members(map);
        self.reconcile_collaboration(diff, first);
    }

    /// Install the existing refresh response before processing its attachments.
    /// Capability advertisement remains v1-only pending coordinated rollout.
    pub(crate) fn set_refresh_collaboration(&self, value: Option<Value>, generation: u64, negotiated_v2: bool) -> anyhow::Result<()> {
        let _admission = self.collab.enter_admission();
        anyhow::ensure!(generation == self.generation.load(Ordering::SeqCst), "retired collaboration refresh generation");
        let first = !self.collab.known();
        let Some(value) = value else {
            if self.collab.runtime_policy.is_v2() {
                let diff = self.collab.set_members(Default::default());
                self.reconcile_collaboration(diff, first);
                anyhow::bail!("missing collaboration snapshot after v2");
            }
            return Ok(());
        };
        if value.get("v").and_then(Value::as_u64) == Some(2) {
            if !negotiated_v2 {
                let diff = self.collab.set_members(Default::default());
                self.reconcile_collaboration(diff, true);
                anyhow::bail!("collaboration-v2 was not negotiated by this native runtime");
            }
            anyhow::ensure!(self.collab.runtime_policy.matches_generation(generation), "collaboration policy generation changed");
            let before: Vec<_> = self.live_peers().into_iter().filter_map(|peer| {
                let user = peer.user_id.clone()?;
                Some((peer, self.collab.runtime_policy.stamp(&user)))
            }).collect();
            let result = serde_json::from_value::<collab::v2::Snapshot>(value)
                .map_err(anyhow::Error::from).and_then(|snapshot| self.collab.install_v2(snapshot));
            match result {
                Ok(diff) => {
                    // Same-role provenance changes also retire both workspace and
                    // session attachments. Pending work retains its old stamp.
                    for (peer, stamp) in before {
                        if stamp.as_ref().is_some_and(|old| !self.collab.runtime_policy.same_member(old)) {
                            peer.closed.notify_one();
                            self.disconnect(&peer);
                        }
                    }
                    self.reconcile_collaboration(diff, true);
                    Ok(())
                }
                Err(error) => {
                    for peer in self.live_peers() {
                        peer.closed.notify_one();
                        self.disconnect(&peer);
                    }
                    let diff = self.collab.set_members(Default::default());
                    self.reconcile_collaboration(diff, first);
                    Err(error)
                }
            }
        } else {
            let members = match serde_json::from_value::<collab::Members>(value) {
                Ok(members) => members,
                Err(error) => {
                    let diff = self.collab.set_members(Default::default());
                    self.reconcile_collaboration(diff, first);
                    return Err(error.into());
                }
            };
            let known_version = members.v == 1;
            self.set_collaboration(Some(members));
            anyhow::ensure!(known_version, "unknown collaboration snapshot version");
            anyhow::ensure!(!self.collab.runtime_policy.is_v2(), "legacy snapshot after v2");
            Ok(())
        }
    }

    fn reconcile_collaboration(&self, diff: collab::Diff, first: bool) {
        if diff.changed.is_empty() && !first {
            return;
        }
        for peer in &self.live_peers() {
            // Reconcile before any early return, including revoked access
            // and old attachments without a person. Promotions count too.
            self.count_attachment(peer);
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
        // A participant who may no longer open a port loses their streams.
        for peer in &self.live_peers() {
            let access = self.access(peer);
            if self.authority(peer) == Authority::Participate && !(access.can_drive() && access.can_configure()) {
                self.ports.revoke(peer);
            }
        }
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

    /// A participant who may no longer type into terminals (no longer a
    /// driver, or no longer an approver) loses the ones they control;
    /// everyone watching is told.
    fn revalidate_terminal_control(&self) {
        let mut released = Vec::new();
        let mut ptys = self.ptys.lock().unwrap();
        for (pty_id, pty) in ptys.iter_mut() {
            let Some((user, authority)) = pty.controller_user.clone() else { continue };
            // One rule for a shell and for an agent's own terminal, the same
            // as `authorize_participant` and `agent_input_refusal`.
            if self.collab.access_for(authority, user.as_deref()).can_configure() {
                continue;
            }
            pty.controller = None;
            pty.controller_user = None;
            pty.controller_installation = None;
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
        let _admission = self.collab.enter_admission();
        if generation < self.generation.load(Ordering::SeqCst) { return; }
        self.collab.runtime_policy.set_generation(generation);
        self.generation.store(generation, Ordering::SeqCst);
    }

    /// Answer one request. Returns the response frame; notifications for
    /// this peer go through its outbound queue.
    pub fn handle<'a>(self: &'a Arc<Self>, peer: &'a Arc<Peer>, request: &'a Value) -> impl std::future::Future<Output = Value> + Send + 'a {
        self.handle_admitted(peer, request, crate::github_process::ticket())
    }

    /// Capture at ingress, before the relay queues its first async task. The
    /// request retains this ticket through idempotency waits and blocking work.
    pub fn handle_owned(self: &Arc<Self>, peer: Arc<Peer>, request: Value) -> impl std::future::Future<Output = Value> + Send + 'static {
        let rpc = self.clone();
        let ticket = crate::github_process::ticket();
        async move { rpc.handle_admitted(&peer, &request, ticket).await }
    }

    async fn handle_admitted(self: &Arc<Self>, peer: &Arc<Peer>, request: &Value, ticket: crate::data_privacy::Ticket) -> Value {
        let id = request.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let method = request.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        match self.dispatch(peer, &method, params, ticket).await {
            Ok(result) => protocol::success(&id, result),
            Err(error) => protocol::failure(&id, &error),
        }
    }

    async fn dispatch(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value, ticket: crate::data_privacy::Ticket) -> Result<Value, RpcError> {
        if !ticket.valid() { return Err(RpcError::forbidden(crate::data_privacy::MESSAGE)); }
        if method == "rpc.hello" {
            let _privacy = ticket.scope().map_err(|error| RpcError::forbidden(error.to_string()))?;
            let granted = protocol::negotiate(&params, &self.offered())?;
            *peer.granted.lock().unwrap() = Some(granted.iter().cloned().collect());
            peer.phone.store(params["client"]["app"].as_str() == Some(MOBILE_APP), Ordering::SeqCst);
            if self.peers.lock().unwrap().insert(peer.id, Arc::downgrade(peer)).is_none() {
                if let Some(agents) = self.agents.get() {
                    agents.client_attached();
                }
            }
            // Register first so a concurrent role refresh either sees this
            // peer, or finishes before we read its current access here.
            self.count_attachment(peer);
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
                    "portStreams": super::ports::MAX_STREAMS_PER_PEER,
                    "portWindowBytes": super::ports::STREAM_WINDOW,
                },
            });
            if collab {
                hello["you"] = self.you(peer);
            }
            return Ok(hello);
        }
        // A machine does not serve the mailbox-only methods (`machine::UNSERVED`),
        // and a runtime with a mailbox has no live steer, stop or decision.
        let Some(spec) = protocol::find_method(method)
            .filter(|_| !(self.is_machine() && machine::UNSERVED.contains(&method)))
            .filter(|spec| spec.capability != protocol::AGENT_COMMANDS || self.agent_commands.get().is_some())
        else {
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
            return self.execute(peer, method, params, ticket).await;
        }
        let request_id = params
            .get("clientRequestId")
            .and_then(Value::as_str)
            .filter(|value| protocol::valid_client_request_id(value))
            .ok_or_else(|| RpcError::invalid("clientRequestId is required for this method"))?
            .to_string();
        let key = (peer.device_id.clone(), request_id.clone());
        let gate = self.in_flight.lock().unwrap().entry(key.clone()).or_default().clone();
        // Agent commands keep their own durable receipts (`agent_commands`):
        // the ten-minute cache would forget them across a sleep or a restart.
        let durable = self.durable_command(peer, spec);
        let result = {
            let _serial = gate.lock().await;
            let previous = if durable { None } else { self.idempotency.lock().unwrap().get(&peer.device_id, &request_id, Instant::now()) };
            match previous {
                Some(previous) => previous,
                None => {
                    let result = self.execute(peer, method, params, ticket).await;
                    if !durable {
                        self.idempotency.lock().unwrap().put(&peer.device_id, &request_id, &result, Instant::now());
                    }
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

    /// What a participant's role allows (contract §21.1). Until the API has
    /// listed members (after a restart, before the first list), nobody's
    /// role is known, so a participant is refused everything: a member whose
    /// share was revoked must not read the workspace in that window (#475).
    /// The list comes with the runtime's session, before any client can
    /// connect, and `collab.you` tells every connection when it arrives.
    fn authorize_participant(&self, peer: &Peer, spec: &protocol::Method) -> Result<(), RpcError> {
        let method = spec.name;
        if !self.collab.known() {
            return Err(RpcError::forbidden(format!("{method} needs the workspace's member list, which has not arrived yet"))
                .with_data(json!({ "role": Role::None, "reason": "access-unknown" })));
        }
        let needed = match method {
            "pty.write" | "pty.resize" | "pty.control" | "session.toTerminal" | "lease.acquire" | "lease.release" => Role::Driver,
            // Escape for a running turn is driving it, as a mailbox stop is.
            "session.interrupt" => Role::Driver,
            // Bytes sent to a port are input to whatever listens there.
            "ports.list" | "ports.open" | "ports.write" => Role::Driver,
            "lease.takeOver" => Role::Manager,
            _ => Role::Viewer,
        };
        let access = self.access(peer);
        // A shell is arbitrary code as the workspace's user: it can edit the
        // agent's settings, read its tokens or start an agent with other
        // flags. So typing into one needs what changing those settings
        // needs (PRO-88): a manager, or a driver who may approve permissions.
        if matches!(method, "pty.write" | "pty.resize" | "pty.control" | "session.toTerminal") && access.can_drive() && !access.can_configure() {
            return Err(RpcError::forbidden(format!("{method} needs the right to approve permissions: a terminal runs anything as the workspace's user"))
                .with_data(json!({ "role": access.role, "needs": "canApprove", "reason": "approval-required" })));
        }
        // A port is held to the terminal's rule (PRO-28): what listens on
        // the workspace's loopback includes debuggers and notebooks, which
        // run anything as the workspace's user for whoever connects.
        if matches!(method, "ports.list" | "ports.open" | "ports.write") && access.can_drive() && !access.can_configure() {
            return Err(RpcError::forbidden(format!("{method} needs the right to approve permissions: a local port can be a debugger or a notebook that runs anything"))
                .with_data(json!({ "role": access.role, "needs": "canApprove", "reason": "approval-required" })));
        }
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

    /// Whether `peer` may open ports now: the dispatcher's checks, read again.
    fn may_use_ports(&self, peer: &Peer) -> bool {
        let spec = protocol::find_method("ports.open").expect("ports.open is a method");
        let authority = self.authority(peer);
        let user = peer.user_id.as_deref().unwrap_or("");
        let stamp = self.collab.runtime_policy.stamp(user);
        authority >= spec.authority && self.access(peer).can_configure()
            && self.collab.runtime_policy.admit(user, stamp.as_ref(), collab::v2::Action::Configure, None).is_ok()
            && (authority != Authority::Participate || self.authorize_participant(peer, spec).is_ok())
    }

    /// Answer `ports.open` in order with the connection's notifications, and
    /// only then let the stream's data flow: an application that speaks
    /// first can never be heard before the client knows the stream's id.
    pub fn answer_port_open<'a>(self: &'a Arc<Self>, peer: &'a Arc<Peer>, request: &'a Value) -> impl std::future::Future<Output = ()> + Send + 'a {
        let response = self.handle(peer, request);
        async move {
            let response = response.await;
            let stream_id = response.pointer("/result/streamId").and_then(Value::as_str).map(str::to_string);
            peer.deliver(response);
            if let Some(stream_id) = stream_id { self.ports.start(peer, &stream_id); }
        }
    }

    /// Run an admitted call. On a machine, a session made, a terminal opened
    /// or an update asked for goes in the machine's activity log (PRO-357),
    /// with the project's name or the version and nothing else.
    async fn execute(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value, ticket: crate::data_privacy::Ticket) -> Result<Value, RpcError> {
        let noted = self.is_machine() && matches!(method, "session.create" | "pty.create" | "machine.update");
        let asked_project = params["projectId"].as_str().map(str::to_string);
        let asked_version = params["version"].as_str().filter(|_| method == "machine.update").map(str::to_string);
        let result = self.run_method(peer, method, params, ticket).await;
        if let (true, Ok(value), Some(access)) = (noted, &result, self.machine_access.get()) {
            let project = value["projectId"].as_str().or(value["session"]["projectId"].as_str()).map(str::to_string).or(asked_project);
            access.note(&peer.device_id, method, project.as_deref(), asked_version.as_deref());
        }
        result
    }

    async fn run_method(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value, ticket: crate::data_privacy::Ticket) -> Result<Value, RpcError> {
        // Native stamp, captured before handing work to the blocking pool.
        // Never read a stamp or generation supplied in request params.
        let policy_stamp = peer.user_id.as_deref().and_then(|user| self.collab.runtime_policy.stamp_for_peer(user, peer));
        if method == "environment.cancel" {
            return super::environment::cancel(peer.id(), &params);
        }
        if method == "environment.report" {
            // Retain admission until every probe and its I/O have ended.
            let _privacy = ticket.enter().map_err(|_| RpcError::forbidden("Environment report is unavailable"))?;
            return super::environment::report(peer.id(), &params, || {
                ticket.valid() && !peer.hung_up() && peer.granted("environment/1") &&
                    self.authority(peer) == Authority::Manage
            }).await;
        }
        // Sockets, not blocking work: answered on the async runtime.
        if method.starts_with("ports.") {
            if !self.may_use_ports(peer) {
                self.ports.revoke(peer);
                return Err(RpcError::forbidden("Ports require current explicit configuration authority"));
            }
            let permit = collab::v2::Permit::new(self.collab.clone(), peer.user_id.as_deref().unwrap_or(""), policy_stamp, collab::v2::Action::Configure).for_peer(peer);
            return self.ports.handle_admitted(peer, method, params, &|| self.may_use_ports(peer), ticket, Some(permit)).await;
        }
        // A fresh device token for the paired computer that asks (`machine/5`, PRO-357).
        if method == "machine.rotateCredential" {
            if !self.is_machine() {
                return Err(RpcError::new("method_not_found", "this runtime serves one workspace"));
            }
            return match self.machine_access.get() {
                Some(access) => access.rotate_credential(&peer.device_id).await,
                None => Err(RpcError::new("method_not_found", "this runtime does not host paired computers")),
            };
        }
        // A round trip to the relay, for a paired computer only (`machine/2`).
        if method == "machine.relayAccess" {
            if !self.is_machine() {
                return Err(RpcError::new("method_not_found", "this runtime serves one workspace"));
            }
            return match self.machine_access.get() {
                Some(access) => access.relay_access(&peer.device_id).await,
                None => Ok(json!({ "relay": null })),
            };
        }
        let rpc = self.clone();
        let peer = peer.clone();
        let method = method.to_string();
        // File, Git and process work blocks; keep it off the socket's task.
        tokio::task::spawn_blocking(move || {
            // Remote mutations, including deferred SessionManager deliveries,
            // need more than a thread-local GitHub ticket. Acquire before any
            // state change; retain the lease until all synchronous work ends.
            let _privacy = ticket.scope().map_err(|error| RpcError::forbidden(error.to_string()))?;
            #[cfg(test)]
            {
                let hook = BEFORE_REMOTE_WORK.lock().unwrap().take();
                if let Some(hook) = hook { hook(); }
            }
            let action = if matches!(method.as_str(), "session.decide") { collab::v2::Action::Approve }
                else if matches!(method.as_str(), "session.send" | "session.steer" | "session.stop" | "session.interrupt") { collab::v2::Action::Drive }
                else { collab::v2::Action::Configure };
            let permit = collab::v2::Permit::new(rpc.collab.clone(), peer.user_id.as_deref().unwrap_or(""), policy_stamp.clone(), action).for_peer(&peer);
            permit.with(|| crate::github_process::with_ticket(ticket, || rpc.execute_blocking(&peer, &method, params, policy_stamp)))
        })
            .await
            .map_err(RpcError::internal)?
    }

    fn execute_blocking(self: &Arc<Self>, peer: &Arc<Peer>, method: &str, params: Value, policy_stamp: Option<collab::v2::Stamp>) -> Result<Value, RpcError> {
        self.check_named_project(method, &params)?;
        let configuration = matches!(method, "session.configure" | "session.create" | "session.create.repository" | "session.addTab" | "session.toTerminal" | "pty.create" | "pty.write" | "pty.control" | "pty.resize");
        // Raw input only enters a queue here. Its final physical writer holds
        // admission after acquiring the PTY lock; taking it at ingress would
        // block acknowledgement of a queued request behind a partial write.
        let _configuration_admission = (configuration && method != "pty.write").then(|| self.collab.enter_admission());
        if configuration {
            if !self.access(peer).can_configure() {
                return Err(RpcError::forbidden("Agent settings and terminal input need independent approval rights"));
            }
            self.collab.runtime_policy.admit(peer.user_id.as_deref().unwrap_or(""), policy_stamp.as_ref(), collab::v2::Action::Configure, None)
                .map_err(|_| RpcError::forbidden("Agent settings and terminal input require current explicit configuration authority"))?;
        }
        // The project a call names, resolved once and checked before it runs.
        let project = || self.project(peer, &params);
        match method {
            "pty.create" => self.pty_create(peer, params),
            "pty.list" => self.pty_list(peer),
            "pty.write" => self.pty_write(peer, params),
            "pty.resize" => self.pty_resize(peer, params),
            "pty.control" => self.pty_control(peer, params),
            "pty.kill" => self.pty_kill(params),
            "pty.attach" => self.pty_attach(peer, params),
            "pty.detach" | "session.unsubscribe" | "fs.unwatch" => self.unsubscribe(peer, params),
            "fs.list" => project()?.files.list(&params),
            "fs.stat" => project()?.files.stat(&params),
            "fs.read" => project()?.files.read(&params),
            "fs.write" => project()?.files.write(&peer.device_id, &params),
            "fs.writePart" => project()?.files.write_part(&peer.device_id, &params),
            "fs.rename" => project()?.files.rename(&params),
            "fs.delete" => project()?.files.delete(&params),
            "fs.mkdir" => project()?.files.mkdir(&params),
            "fs.search" => project()?.files.search(peer.id, &params),
            "fs.cancel" => self.fs_cancel(peer, &params),
            "fs.watch" => self.fs_watch(peer, &project()?, params),
            "mirror.manifest" => match &self.scope {
                Scope::Workspace { project, mirror } => mirror.manifest(&project.git, &params),
                Scope::Machine { .. } => Err(RpcError::new("method_not_found", "a machine has no mirror")),
            },
            "lifecycle.dispositionFacts" => self.disposition_facts(),
            "lifecycle.resources" => Ok(match &self.scope {
                Scope::Workspace { project, .. } => crate::cloud_resources::observe(&project.root),
                // A machine's disk is the one its data directory is on.
                Scope::Machine { .. } => crate::cloud_resources::observe(&crate::store::root().map_err(RpcError::internal)?),
            }),
            "machine.describe" => match &self.scope {
                Scope::Machine { identity, .. } => Ok(self.describe_machine(identity)),
                Scope::Workspace { .. } => Err(RpcError::new("method_not_found", "this runtime serves one workspace")),
            },
            "machine.projects" => match &self.scope {
                Scope::Machine { .. } => machine::projects(),
                Scope::Workspace { .. } => Err(RpcError::new("method_not_found", "this runtime serves one workspace")),
            },
            "machine.updateStatus" | "machine.update" => self.machine_update_call(peer, method, &params),
            "machine.agentSetup" => match &self.scope {
                Scope::Machine { .. } => self.machine_agent_setup(peer, params),
                Scope::Workspace { .. } => Err(RpcError::new("method_not_found", "this runtime serves one workspace")),
            },
            "machine.agentSetupRunning" => match &self.scope {
                Scope::Machine { .. } => self.machine_agent_setup_running(&params),
                Scope::Workspace { .. } => Err(RpcError::new("method_not_found", "this runtime serves one workspace")),
            },
            "machine.browse" | "machine.addProject" | "machine.removeProject" | "machine.cloneProject" | "machine.cloneStatus" | "machine.cloneCancel" => match &self.scope {
                Scope::Machine { .. } => self.machine_projects_call(method, &params),
                Scope::Workspace { .. } => Err(RpcError::new("method_not_found", "this runtime serves one workspace")),
            },
            "machine.sessionActions" | "machine.runAction" | "machine.setupRerun" | "machine.setupStop" => match &self.scope {
                Scope::Machine { .. } => self.machine_session_run_call(peer, method, &params),
                Scope::Workspace { .. } => Err(RpcError::new("method_not_found", "this runtime serves one workspace")),
            },
            "session.usage" | "session.prepareContinuation" | "session.checkFailures" => match &self.scope {
                Scope::Machine { .. } => self.machine_session_call(peer, method, &params),
                Scope::Workspace { .. } => Err(RpcError::new("method_not_found", "this runtime serves one workspace")),
            },
            "cleanup.scan" => self.cleanup_scan(),
            "cleanup.size" => self.cleanup_size(peer, params),
            "cleanup.cancel" => self.cleanup_cancel(peer),
            "cleanup.remove" => self.cleanup_remove(peer, params),
            "workspace.disposition" => self.workspace_disposition(peer, params),
            "workspace.remove" => self.workspace_remove(peer, params),
            "workspace.sweepMerged" => self.workspace_sweep_merged(params),
            "workspace.holdMerged" => self.workspace_hold_merged(params),
            "workspace.removedRecords" => self.workspace_removed_records(),
            "workspace.restoreRemoved" => self.workspace_restore_removed(params),
            "pipeline.list" => self.pipeline_list(),
            "pipeline.reviewers" => self.pipeline_reviewers(&params),
            "pipeline.act" => self.pipeline_act(params),
            "pipeline.resolveConflicts" => {
                let pipeline = self.own_pipeline(&params)?;
                let value = params.get("value").and_then(Value::as_bool).ok_or_else(|| RpcError::invalid("value must be boolean"))?;
                let pipeline = crate::issue_pipeline::engine::set_resolve_conflicts_by(&self.pipeline_host()?, &pipeline.id, value, crate::issue_pipeline::SwitchActor::Person).map_err(RpcError::internal)?;
                Ok(json!({ "pipeline": pipeline_on_the_wire(json!(pipeline)) }))
            },
            "pipeline.noteMerge" => self.pipeline_note_merge(params),
            "pipeline.noteTracker" => self.pipeline_note_tracker(params),
            git if git.starts_with("git.") => project()?
                .git
                .handle_negotiated(git, &params, peer.granted(protocol::GIT_PR_TARGET))
                .unwrap_or_else(|| Err(RpcError::new("method_not_found", format!("{git} is not a workspace method")))),
            "session.list" => self.session_list(peer),
            "session.get" => self.session_get(peer, params),
            "session.create" => {
                if params.get("repository").is_some_and(|target| !target.is_null()) && !peer.granted("session-repository/1") {
                    return Err(RpcError::new("capability_not_granted", "Repository session routing was not negotiated."));
                }
                if params.get("baseRef").is_some_and(|base| !base.is_null()) && !peer.granted("session-base/1") {
                    return Err(RpcError::new("capability_not_granted", "Choosing the branch a session starts from was not negotiated."));
                }
                // On a machine, refused here without `machine/1` or a project.
                if self.is_machine() {
                    project()?;
                }
                self.session_create(params)
            },
            "session.close" => self.session_close(params),
            "session.send" if self.durable_command(peer, protocol::find_method("session.send").expect("session.send is a method")) => {
                self.agent_command(peer, "session.send", params, policy_stamp)
            }
            "session.send" => self.session_send(peer, params),
            "session.steer" | "session.stop" | "session.decide" => self.agent_command(peer, method, params, policy_stamp),
            "session.interrupt" => {
                let _admission = self.collab.enter_admission();
                if let Some(permit) = collab::v2::current().filter(|_| self.collab.runtime_policy.is_v2()) {
                    let (session, tab) = self.known_tab(&params)?;
                    permit.check(self.manager()?.collaboration_v2_witness(&session, &tab).as_ref()).map_err(|_| RpcError::forbidden("Collaboration policy or tab safety changed"))?;
                }
                self.session_interrupt(peer, params)
            },
            "session.toTerminal" => self.session_to_terminal(peer, params),
            "session.turnCheckpoint" => self.session_turn_checkpoint(peer, params),
            "session.keepTurn" | "session.undoTurn" | "session.restoreUndo" => self.session_review_turn(peer, method, params),
            "session.reset" => self.session_reset(peer, params),
            "session.fork" => self.session_fork(peer, params),
            "session.subscribe" => self.session_subscribe(peer, params),
            "session.tabs" => self.session_tabs(peer),
            "session.commands" => self.session_commands(peer, params),
            "session.files" => self.session_files(peer, params),
            "session.attach" => self.session_attach(peer, params),
            "session.prs" => self.session_prs(peer, params),
            "session.prContext" => self.session_pr_context(peer, params),
            "session.configure" => self.session_configure(peer, params),
            "session.markRead" => self.session_mark_read(peer, params),
            "session.update" => self.session_update(peer, params),
            "session.addTab" => self.session_add_tab(peer, params),
            "session.delete" => self.session_delete(peer, params),
            "runtime.agents" => self.runtime_agents(peer, &params),
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
        for project in self.served_projects() {
            project.files.disconnect(peer.id);
        }
        self.ports.revoke(peer);
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
        for project in self.served_projects() {
            project.files.disconnect(peer.id);
        }
        // Before its streams are ended, so an open still connecting sees it.
        peer.gone.store(true, Ordering::SeqCst);
        {
            // Publish cancellation before waiting for an admitted physical
            // write. Queued writers waiting for input capacity own no guard.
            let _admission = self.collab.enter_admission();
        }
        // Released here, not when the last reference to the peer goes: a
        // connection that ended must not keep the workspace awake.
        *peer.attached.lock().unwrap() = None;
        self.ports.disconnect(peer.id);
        if self.peers.lock().unwrap().remove(&peer.id).is_some() {
            if let Some(agents) = self.agents.get() {
                agents.client_detached();
            }
            if peer.granted("collab/1") {
                self.broadcast_presence();
            }
        }
        self.drop_peer_subscriptions(peer);
        self.hand_over_control(peer);
    }

    /// A connection ended. The same installation may already be back under
    /// its new device, watching a terminal the ended device controlled: once
    /// that device has no connection left, the terminal is theirs.
    fn hand_over_control(&self, gone: &Peer) {
        let connected = self.connected_devices();
        if connected.contains(&gone.device_id) {
            return;
        }
        // Who might take which terminal, read under the lock; whether they
        // may drive an agent's tab is asked outside it.
        // (terminal, its agent tab as `(sessionId, tabId)`, who is watching it)
        type Candidate = (String, Option<(String, String)>, Vec<Arc<Peer>>);
        let candidates: Vec<Candidate> = self
            .ptys
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, pty)| !pty.closed && pty.controller.as_deref() == Some(gone.device_id.as_str()))
            .map(|(pty_id, pty)| {
                let agent = pty.agent.as_ref().and_then(|agent| Some((agent.session_id.clone()?, agent.tab_id.clone())));
                // An agent's terminal whose tab was never resolved has nobody who may be asked about its lease.
                let askable = pty.agent.is_none() || agent.is_some();
                let heirs = pty.subscribers.values().filter(|heir| askable && !heir.hung_up() && heir.installation().is_some()).cloned().collect();
                (pty_id.clone(), agent, heirs)
            })
            .collect();
        for (pty_id, agent, heirs) in candidates {
            for heir in heirs {
                if agent.as_ref().is_some_and(|(session_id, tab_id)| self.agent_input_refusal(&heir, session_id, tab_id).is_some()) {
                    continue;
                }
                let mut ptys = self.ptys.lock().unwrap();
                let Some(pty) = ptys.get_mut(&pty_id).filter(|pty| !pty.closed) else { break };
                if self.resume_control(&pty_id, pty, &heir, &connected) {
                    break;
                }
            }
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
            let (input, queue) = std::sync::mpsc::channel::<PtyInput>();
            let input_pending = Arc::new(AtomicUsize::new(0));
            let terminals = self.terminals.clone();
            let pending = input_pending.clone();
            let pane = pty_id.to_string();
            let manager = self.manager().ok().cloned();
            std::thread::Builder::new()
                .name(format!("agent-pty-input-{tab_id}"))
                .spawn(move || {
                    // Ends when the entry (the sender) is dropped with its tab.
                    for data in queue {
                        // Between two CLIs there is nothing to type into.
                        let _ = data.write(&terminals, manager.as_ref(), &pane);
                        pending.fetch_sub(data.data.len(), Ordering::SeqCst);
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
                    // Its tab's session names the project.
                    project_id: None,
                    created_at_ms: crate::cloud_agents::now_ms(),
                    pid: None,
                    cols,
                    rows,
                    controller: None,
                    controller_user: None,
                    controller_installation: None,
                    ring: VecDeque::new(),
                    end: 0,
                    exit: None,
                    exited_at: None,
                    closed: false,
                    stop_pending: false,
                    applied_seq: HashMap::new(),
                    input,
                    input_pending,
                    subscribers: HashMap::new(),
                    agent: Some(AgentPty { tab_id: tab_id.to_string(), session_id: None }),
                    setup: None,
                    run: None,
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
        if !access.can_configure() {
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
        // `machine/1`: the project it runs in, which `cwd` is relative to.
        if let Some(project_id) = &pty.project_id {
            described["projectId"] = json!(project_id);
        }
        if let Some(agent) = &pty.agent {
            // The tab whose CLI this is, and whether one runs in it now.
            described["tabId"] = json!(agent.tab_id);
            described["running"] = json!(self.terminals.is_running(pty_id));
        }
        if let Some(setup) = &pty.setup {
            described["setup"] = json!({ "harness": setup.harness, "step": setup.step.name() });
        }
        // `machine/7`: one of its session's script runs, which the dock shows
        // under Setup and Run rather than as a numbered shell.
        if let Some(run) = &pty.run {
            described["run"] = run.wire();
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
            #[serde(default)]
            project_id: Option<String>,
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
        // Where its paths resolve: the workspace, or on a machine the
        // session's project, else the one the call names.
        let project = match (&self.scope, &session) {
            (Scope::Machine { projects, .. }, Some(session)) => projects.get(&machine::project_id(&session.project_path))?,
            _ => self.project(peer, &params_project(&p.project_id))?,
        };
        let cwd = match (&p.cwd, &session) {
            (Some(relative), _) => project.files.existing_path(relative)?,
            // A session's terminal opens in its checkout (its worktree), when
            // that is inside the workspace; otherwise at the root.
            (None, Some(session)) => std::fs::canonicalize(&session.cwd)
                .ok()
                .filter(|cwd| project.files.contains(cwd) && cwd.is_dir())
                .unwrap_or_else(|| project.root.clone()),
            (None, None) => project.root.clone(),
        };
        if !cwd.is_dir() {
            return Err(RpcError::invalid("cwd is not a directory"));
        }
        let start_in = cwd.to_string_lossy().into_owned();
        self.start_pty(
            peer,
            NewPty {
                cwd: project.files.relative(&cwd),
                start_in: &start_in,
                command: None,
                session_id: session.map(|session| session.id),
                project_id: project.id.clone(),
                cols: p.cols,
                rows: p.rows,
                setup: None,
            },
        )
        .map(|(_, described)| described)
    }

    /// Start a terminal this runtime's peers attach to, as `pty.create`
    /// does: its id and how `pty.list` describes it.
    fn start_pty(&self, peer: &Peer, new: NewPty<'_>) -> Result<(String, Value), RpcError> {
        let pty_id = format!("{PTY_PREFIX}{}", uuid::Uuid::new_v4().simple());
        let (input, queue) = std::sync::mpsc::channel::<PtyInput>();
        let input_pending = Arc::new(AtomicUsize::new(0));
        {
            let mut ptys = self.ptys.lock().unwrap();
            // A setup step is not one of the shells this limit is for.
            if new.setup.is_none() && ptys.values().filter(|pty| pty.agent.is_none() && pty.setup.is_none() && pty.run.is_none() && pty.exit.is_none() && !pty.closed).count() >= MAX_PTYS {
                return Err(RpcError::new("unavailable", format!("at most {MAX_PTYS} terminals may run at once")));
            }
            ptys.insert(
                pty_id.clone(),
                PtyState {
                    number: self.next_pty_number.fetch_add(1, Ordering::SeqCst),
                    cwd: new.cwd,
                    session_id: new.session_id,
                    project_id: new.project_id,
                    created_at_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|elapsed| elapsed.as_millis() as u64)
                        .unwrap_or(0),
                    pid: None,
                    cols: new.cols,
                    rows: new.rows,
                    controller: Some(peer.device_id.clone()),
                    controller_user: Some((peer.user_id.clone(), peer.authority)),
                    controller_installation: peer.installation_key.clone(),
                    ring: VecDeque::new(),
                    end: 0,
                    exit: None,
                    exited_at: None,
                    closed: false,
                    stop_pending: false,
                    applied_seq: HashMap::new(),
                    input,
                    input_pending: input_pending.clone(),
                    subscribers: HashMap::new(),
                    agent: None,
                    setup: new.setup,
                    run: None,
                },
            );
        }
        let scope = self.pty_session_scope(peer);
        // The machine's own environment: nothing of the caller's is passed.
        let spec = PaneSpec { cwd: new.start_in, cols: new.cols, rows: new.rows, command: new.command, env: &[] };
        if let Err(error) = self.terminals.spawn(self.sink.clone(), &pty_id, spec) {
            self.ptys.lock().unwrap().remove(&pty_id);
            return Err(RpcError::internal(error));
        }
        let terminals = self.terminals.clone();
        let writer_id = pty_id.clone();
        let manager = self.manager().ok().cloned();
        let spawned = std::thread::Builder::new().name(format!("pty-input-{pty_id}")).spawn(move || {
            // Ends when the terminal's entry (the sender) is dropped, or the
            // program is gone; its exit is reported through `pty.exit`.
            for data in queue {
                let written = data.write(&terminals, manager.as_ref(), &writer_id);
                input_pending.fetch_sub(data.data.len(), Ordering::SeqCst);
                // A program that stopped reading loses this input, not every
                // later keystroke: it may read again.
                if written.is_err_and(|error| !error.is::<crate::pty::InputStalled>()) {
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
        let described = self.describe_pty(&pty_id, pty, peer, scope.as_ref());
        Ok((pty_id, described))
    }

    /// Terminals of this runtime, oldest first; closed ones are gone.
    fn pty_list(&self, peer: &Peer) -> Result<Value, RpcError> {
        let scope = self.pty_session_scope(peer);
        let connected = self.connected_devices();
        // Read before the terminals are locked: the runtime's own panes.
        let shells = if self.is_machine() && scope.is_some() { self.terminals.shells() } else { Vec::new() };
        let mut ptys = self.ptys.lock().unwrap();
        self.record_session_runs(&mut ptys, &shells, scope.as_ref());
        for (pty_id, pty) in ptys.iter_mut().filter(|(_, pty)| !pty.closed && pty.agent.is_none()) {
            self.resume_control(pty_id, pty, peer, &connected);
        }
        let mut listed: Vec<(u64, Value)> = ptys
            .iter()
            // An agent tab's terminal is reached from its tab, never listed as a shell.
            // Nor is an agent's setup step: the machine's page shows it (PRO-350).
            .filter(|(_, pty)| !pty.closed && pty.agent.is_none() && pty.setup.is_none())
            // A session's script run is listed only to those who see its session.
            .filter(|(_, pty)| pty.run.is_none() || pty.session_id.as_ref().is_some_and(|id| scope.as_ref().is_some_and(|visible| visible.contains(id))))
            .map(|(id, pty)| (pty.number, self.describe_pty(id, pty, peer, scope.as_ref())))
            .collect();
        listed.sort_by_key(|(number, _)| *number);
        Ok(json!({
            "epoch": self.epoch,
            "runtimeGeneration": self.generation(),
            "terminals": listed.into_iter().map(|(_, pty)| pty).collect::<Vec<_>>(),
        }))
    }

    /// The devices with a connection now. Read before the terminals are locked.
    fn connected_devices(&self) -> HashSet<String> {
        self.live_peers().into_iter().filter(|peer| !peer.hung_up()).map(|peer| peer.device_id.clone()).collect()
    }

    /// The controller's device is gone and `peer` is the same person on the
    /// same installation under the device the API issued it since (a stopped
    /// workspace's attachments are revoked, so every wake brings a new
    /// attachment and device): the terminal is still theirs, and they are
    /// its controller again without asking. Nothing else moves control
    /// without `pty.control`: not another person, not another installation
    /// of the same person, not a controller with a connection still open,
    /// not a link without an installation key, and not someone who may no
    /// longer type into terminals.
    ///
    /// Called with the terminal's entry locked; `connected` is
    /// [`Self::connected_devices`]. The caller has already decided that
    /// `peer` may drive the tab of an agent's terminal
    /// ([`Self::agent_input_refusal`], which cannot be asked under the
    /// lock), and never calls this for what a terminal says by itself
    /// (`report`): only attaching, listing, typing and sizing resume.
    fn resume_control(&self, pty_id: &str, pty: &mut PtyState, peer: &Peer, connected: &HashSet<String>) -> bool {
        let Some(controller) = pty.controller.as_deref() else { return false };
        let Some((user, installation)) = peer.installation() else { return false };
        if controller == peer.device_id || connected.contains(controller) {
            return false;
        }
        let same_person = pty.controller_user.as_ref().is_some_and(|(controller_user, _)| controller_user.as_deref() == Some(user));
        if !same_person || pty.controller_installation.as_deref() != Some(installation) {
            return false;
        }
        // The rule `revalidate_terminal_control` keeps: only someone who may type holds a terminal.
        if !self.collab.access_for(peer.authority, peer.user_id.as_deref()).can_configure() {
            return false;
        }
        pty.controller = Some(peer.device_id.clone());
        pty.controller_user = Some((peer.user_id.clone(), peer.authority));
        // A stream this device already had open learns it; to everyone else nothing changed.
        for (subscription_id, subscriber) in &pty.subscribers {
            if subscriber.device_id == peer.device_id {
                subscriber.notify("pty.control", json!({ "subscriptionId": subscription_id, "ptyId": pty_id, "control": "you", "controllerId": peer.user_id }));
            }
        }
        true
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
        self.setup_pty_refusal(peer, &params)?;
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
        let connected = self.connected_devices();
        let mut ptys = self.ptys.lock().unwrap();
        let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
        let key = (peer.input_scope(), writer.to_string());
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
        // What a person typed may bring their own terminal back to their new
        // device; what the terminal emulator says by itself never moves control.
        if pty.controller.as_deref() != Some(peer.device_id.as_str()) && (report || !self.resume_control(&pty_id, pty, peer, &connected)) {
            return Err(RpcError::new("not_controller", "another device controls this terminal's input"));
        }
        if pty.input_pending.load(Ordering::SeqCst) + data.len() > MAX_PENDING_INPUT {
            return Err(RpcError::new("backpressure", "the program is not reading its input yet; retry"));
        }
        pty.input_pending.fetch_add(data.len(), Ordering::SeqCst);
        if pty.input.send(PtyInput { collaboration: collab::v2::current(), pid: self.terminals.pid(&pty_id), data: data.as_bytes().to_vec(), privacy: crate::data_privacy::remote_ticket().unwrap_or_else(crate::data_privacy::Ticket::denied) }).is_err() {
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
        self.setup_pty_refusal(peer, &params)?;
        let (cols, rows) = Self::size_params(&params)?.ok_or_else(|| RpcError::invalid("cols and rows must be between 1 and 1000"))?;
        if let Some((session_id, tab_id)) = self.agent_pty(peer, &params)? {
            if let Some(refusal) = self.agent_input_refusal(peer, &session_id, &tab_id) {
                return Err(refusal);
            }
        }
        let connected = self.connected_devices();
        let mut ptys = self.ptys.lock().unwrap();
        let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
        // A viewer's window size never reshapes the controller's program.
        if pty.controller.as_deref() != Some(peer.device_id.as_str()) && !self.resume_control(&pty_id, pty, peer, &connected) {
            return Err(RpcError::new("not_controller", "another device controls this terminal's size"));
        }
        if pty.exit.is_none() {
            self.apply_size(&pty_id, pty, cols, rows)?;
        }
        Ok(json!({ "cols": pty.cols, "rows": pty.rows }))
    }

    /// Take over a terminal's input and size, optionally at this client's size.
    fn pty_control(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        self.setup_pty_refusal(peer, &params)?;
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
        pty.controller_installation = peer.installation_key.clone();
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
        if !self.start_in_terminal(session_id, tab_id, None)? {
            return Err(RpcError::new("conflict", "Wait for Codex to finish this turn, or interrupt it, before opening its terminal."));
        }
        let mut ptys = self.ptys.lock().unwrap();
        let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
        // The CLI starts at its default size; the controller's applies from here.
        let _ = self.terminals.resize(&pty_id, pty.cols, pty.rows);
        pty.pid = self.terminals.pid(&pty_id);
        Ok(self.describe_pty(&pty_id, pty, peer, scope.as_ref()))
    }

    /// Native Codex's terminal view (#644): the tab moves to Codex's own
    /// terminal on the same thread, for good, as a Mac's `toTerminal` does, and
    /// that terminal starts, picking up the thread from the native home. Held
    /// to what starting an agent's terminal needs (`pty.control` with `start`):
    /// a driver who may approve, while nobody else holds the tab.
    fn session_to_terminal(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let tab = self.visible_tab(peer, &params)?;
        match self.agent_input_refusal(peer, &tab.session_id, &tab.tab_id) {
            Some(refusal) if refusal.code == "lease_held" && self.access(peer).role == Role::Manager => {
                let user = peer.user_id.as_deref().unwrap_or_default();
                let busy = agents_busy(&self.agents, &tab.session_id, &tab.tab_id);
                self.collab.claim(&tab.tab_id, user, crate::cloud_agents::now_ms(), busy, true).map_err(lease_refusal)?;
            }
            Some(refusal) => return Err(refusal),
            None => {}
        }
        let transition_id = serde_json::from_value(params["transitionId"].clone()).map_err(|_| RpcError::new("invalid_params", "transitionId must be a UUID"))?;
        let ready = self.start_in_terminal(&tab.session_id, &tab.tab_id, transition_id)?;
        if params["deferUntilIdle"] == true {
            Ok(json!({ "sessionId": tab.session_id, "tabId": tab.tab_id, "waitingForTurn": !ready }))
        } else if ready {
            Ok(json!({ "sessionId": tab.session_id, "tabId": tab.tab_id }))
        } else {
            // Existing session/3 clients treat any success as a completed
            // switch and cannot poll. Keep their original busy refusal.
            Err(RpcError::new("conflict", "Codex is still working. Wait or interrupt before opening Terminal view."))
        }
    }

    /// Start a tab's CLI in its terminal, moving native Codex there first.
    fn start_in_terminal(&self, session_id: &str, tab_id: &str, transition_id: Option<uuid::Uuid>) -> Result<bool, RpcError> {
        let manager = self.manager()?;
        if !manager.codex_stdio_to_terminal_reported(session_id, tab_id, transition_id).map_err(|error| RpcError::new("conflict", format!("{error:#}")))? { return Ok(false); }
        manager.ensure_started(session_id, tab_id).map_err(|error| RpcError::new("unavailable", format!("the agent did not start: {error:#}")))?;
        self.tabs_changed.notify_one();
        Ok(true)
    }

    fn pty_kill(&self, params: Value) -> Result<Value, RpcError> {
        if params.get("ptyId").and_then(Value::as_str).is_some_and(|id| id.starts_with(AGENT_PTY_PREFIX)) {
            return Err(RpcError::forbidden("an agent's terminal closes with its tab"));
        }
        let (pty_id, exited) = {
            let mut ptys = self.ptys.lock().unwrap();
            let (pty_id, pty) = self.live_pty(&mut ptys, &params)?;
            if pty.run == Some(SessionRun::Setup) {
                return Err(RpcError::forbidden("a workspace's setup is stopped with machine.setupStop"));
            }
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
        if pty.setup.is_some() {
            crate::harness::setup::ended_elsewhere(pty_id);
        }
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
        self.setup_pty_refusal(peer, &params)?;
        let since = params.get("sinceOffset").and_then(Value::as_u64);
        if since.is_some() {
            let generation = params.get("runtimeGeneration").and_then(Value::as_u64);
            let epoch = params.get("epoch").and_then(Value::as_str);
            if generation != Some(self.generation()) || epoch.is_some_and(|epoch| epoch != self.epoch) {
                return Err(RpcError::new("cursor_expired", "the offset belongs to another runtime generation or process"));
            }
        }
        // An agent tab's terminal exists from here on, even before its CLI runs.
        let agent = self.agent_pty(peer, &params)?;
        // Whether this person may drive the tab now (someone else may hold
        // its lease since): their terminal comes back to them only if so,
        // so the view never reads "you" while every write is refused.
        let may_resume = agent.as_ref().is_none_or(|(session_id, tab_id)| self.agent_input_refusal(peer, session_id, tab_id).is_none());
        let subscription_id = Self::subscription_id();
        let scope = self.pty_session_scope(peer);
        let connected = self.connected_devices();
        let mut ptys = self.ptys.lock().unwrap();
        let pty_id = required_str(&params, "ptyId")?.to_string();
        let pty = ptys.get_mut(&pty_id).filter(|pty| !pty.closed).ok_or_else(|| RpcError::not_found("no such terminal"))?;
        if may_resume {
            self.resume_control(&pty_id, pty, peer, &connected);
        }
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
        // Queue the snapshot at the PTY, behind unread/emitting output;
        // publishing it here would race the producer's pending batches.
        let _ = self.terminals.publish_size(&pty_id);
        self.subscriptions.lock().unwrap().insert(subscription_id, Subscription::Pty { peer: peer.id, pty_id });
        Ok(result)
    }

    /// The entry of a session's script run (`machine/7`), made on its first
    /// output, on the listing that first finds it, or when `machine.runAction`
    /// starts it. `title` is the pane's, which names the action. An entry made
    /// for a pane whose program has already exited (`backfill`) is given what
    /// the runtime kept of its output: nothing more can arrive to repeat it.
    /// A pane still running is recorded from here on, so one that started
    /// before this server existed shows its output from then. Called with the
    /// terminals locked; `None` for a pane of no session of this machine.
    fn run_entry<'a>(&self, ptys: &'a mut HashMap<String, PtyState>, pane: &str, title: Option<&str>, discovery: RunDiscovery) -> Option<&'a mut PtyState> {
        if !ptys.contains_key(pane) {
            let observed_exit = matches!(discovery, RunDiscovery::Exit);
            // The runtime can finish the pane before delivering its exit.
            // If listing found it in that interval, let the real exit take
            // its place in the retention order even after backfill eviction.
            if self.evicted_runs.lock().unwrap().get(pane)
                .is_some_and(|evicted| !observed_exit || matches!(evicted, EvictedRun::Observed))
            {
                return None;
            }
            let Scope::Machine { projects, .. } = &self.scope else { return None };
            let (session_id, run) = SessionRun::of_pane(pane, title.map(str::to_string).or_else(|| self.terminals.title(pane).map(|(title, _)| title)).as_deref())?;
            let session = index::get(&session_id).ok()?;
            let project = projects.get(&machine::project_id(&session.project_path)).ok()?;
            let running = !observed_exit && self.terminals.is_running(pane);
            if !running && self.terminals.shell(pane).is_none() {
                return None;
            }
            // Historical runs can fill spare slots. Only observed exits can
            // displace records, and an observed exit always outranks backfill.
            if !running && !observed_exit
                && ptys.values().filter(|pty| pty.exit.is_some() && !pty.stop_pending).count() >= MAX_EXITED_PTYS
            {
                return None;
            }
            let cwd = std::fs::canonicalize(&session.cwd).ok().filter(|cwd| project.files.contains(cwd)).map(|cwd| project.files.relative(&cwd)).unwrap_or_else(|| ".".into());
            let (input, queue) = std::sync::mpsc::channel::<PtyInput>();
            let input_pending = Arc::new(AtomicUsize::new(0));
            let terminals = self.terminals.clone();
            let pending = input_pending.clone();
            let writer = pane.to_string();
            let manager = self.manager().ok().cloned();
            std::thread::Builder::new()
                .name(format!("run-pty-input-{session_id}"))
                .spawn(move || {
                    for data in queue {
                        let written = data.write(&terminals, manager.as_ref(), &writer);
                        pending.fetch_sub(data.data.len(), Ordering::SeqCst);
                        if written.is_err_and(|error| !error.is::<crate::pty::InputStalled>()) {
                            break;
                        }
                    }
                })
                .ok()?;
            let ring: VecDeque<u8> = if !running && !matches!(discovery, RunDiscovery::Active) {
                let kept = self.terminals.read_output(pane).unwrap_or_default();
                kept[kept.len().saturating_sub(PTY_RING_BYTES)..].iter().copied().collect()
            } else {
                VecDeque::new()
            };
            ptys.insert(
                pane.to_string(),
                PtyState {
                    number: self.next_pty_number.fetch_add(1, Ordering::SeqCst),
                    cwd,
                    session_id: Some(session_id),
                    project_id: project.id.clone(),
                    created_at_ms: crate::cloud_agents::now_ms(),
                    pid: self.terminals.pid(pane),
                    cols: 120,
                    rows: 30,
                    controller: None,
                    controller_user: None,
                    controller_installation: None,
                    end: ring.len() as u64,
                    ring,
                    // Its code was the runtime's to hear; this server did not.
                    exit: (!running).then_some(None),
                    exited_at: None,
                    closed: false,
                    stop_pending: false,
                    applied_seq: HashMap::new(),
                    input,
                    input_pending,
                    subscribers: HashMap::new(),
                    agent: None,
                    setup: None,
                    run: Some(run),
                },
            );
        }
        ptys.get_mut(pane).filter(|pty| pty.run.is_some())
    }

    /// Discover live runs of visible sessions and fill spare exit slots from
    /// the runtime's history. Keep eviction history while the pane exists.
    /// Called with the terminals locked.
    fn record_session_runs(&self, ptys: &mut HashMap<String, PtyState>, shells: &[crate::pty::ShellPane], scope: Option<&HashSet<String>>) {
        let Some(visible) = scope else { return };
        self.evicted_runs.lock().unwrap().retain(|id, _| self.terminals.shell(id).is_some());
        for shell in shells {
            if visible.contains(&shell.session_id) && !ptys.contains_key(&shell.id) && SessionRun::of_pane(&shell.id, None).is_some() {
                self.run_entry(ptys, &shell.id, shell.title.as_deref(), RunDiscovery::Backfill);
            }
        }
    }

    fn on_pty_data(&self, data: PtyData) {
        let agent = data.id.starts_with(AGENT_PTY_PREFIX);
        // A session's script run on a machine is recorded from its first byte, as an agent's terminal is.
        let run = !agent && self.is_machine() && SessionRun::of_pane(&data.id, None).is_some();
        if !agent && !run && !data.id.starts_with(PTY_PREFIX) {
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
            } else if run {
                match self.run_entry(&mut ptys, &data.id, None, RunDiscovery::Active) {
                    Some(pty) => pty,
                    None => return,
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
                    if bytes.is_empty() && data.size.is_some() { "pty.resize-complete" } else { "pty.output" },
                    json!({ "subscriptionId": subscription_id, "ptyId": data.id, "offset": offset, "data": data.data, "size": data.size }),
                    data.data.len().max(256), // Size-only completions also consume the slow-peer budget.
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
            let pty = if ptys.contains_key(&exit.id) {
                ptys.get_mut(&exit.id)
            } else if self.is_machine() && SessionRun::of_pane(&exit.id, None).is_some() {
                self.run_entry(&mut ptys, &exit.id, None, RunDiscovery::Exit)
            } else {
                None
            };
            let Some(pty) = pty else { return };
            if pty.setup.is_some() {
                // Installed or signed in, or not: what the agents' logins say now is read again.
                crate::harness::setup::ended_elsewhere(&exit.id);
                super::machine_agents::forget();
            }
            if pty.run.is_some() {
                self.evicted_runs.lock().unwrap().remove(&exit.id);
            }
            pty.exit = Some(exit.code);
            pty.exited_at = Some(Instant::now());
            for (subscription_id, peer) in &pty.subscribers {
                peer.notify(
                    "pty.exit",
                    json!({ "subscriptionId": subscription_id, "ptyId": exit.id, "code": exit.code, "offset": pty.end }),
                );
            }
            if pty.closed && !pty.stop_pending {
                ended.extend(Self::remove_pty(&mut ptys, &exit.id));
            }
            // Exited terminals keep their output for a late reader, up to a
            // bound: the oldest are dropped first.
            let mut exited: Vec<_> = ptys.iter()
                .filter(|(_, pty)| pty.exit.is_some() && !pty.stop_pending)
                .map(|(id, pty)| (pty.exited_at, id.clone()))
                .collect();
            let mut evicted = Vec::new();
            if exited.len() > MAX_EXITED_PTYS {
                exited.sort();
                for (exited_at, id) in exited.drain(..exited.len() - MAX_EXITED_PTYS) {
                    // A session's script run is the runtime's pane: only this record of it goes.
                    let owned = ptys.get(&id).is_some_and(|pty| pty.run.is_none());
                    ended.extend(Self::remove_pty(&mut ptys, &id));
                    if owned {
                        evicted.push(id);
                    } else {
                        let eviction = if exited_at.is_some() { EvictedRun::Observed } else { EvictedRun::Backfilled };
                        self.evicted_runs.lock().unwrap().insert(id, eviction);
                    }
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

    #[cfg(test)]
    pub(super) fn files_for_tests(&self) -> Arc<WorkspaceFiles> {
        self.served_projects()[0].files.clone()
    }

    #[cfg(test)]
    pub(super) fn workspace_git_for_tests(&self) -> Arc<ServedProject> {
        self.served_projects()[0].clone()
    }

    /// `fs.cancel`: stop a search this connection started, in the project
    /// named, or in any where none is.
    fn fs_cancel(&self, peer: &Peer, params: &Value) -> Result<Value, RpcError> {
        let named = params.get("projectId").and_then(Value::as_str);
        let mut cancelled = false;
        for project in self.served_projects().into_iter().filter(|project| named.is_none() || project.id.as_deref() == named) {
            cancelled |= project.files.cancel(peer.id, params)?["cancelled"] == true;
        }
        if !cancelled && self.served_projects().is_empty() {
            required_str(params, "searchId")?;
        }
        Ok(json!({ "cancelled": cancelled }))
    }

    fn fs_watch(&self, peer: &Arc<Peer>, project: &Arc<ServedProject>, params: Value) -> Result<Value, RpcError> {
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
        let (watcher, path) = project.files.watcher(params.get("path").and_then(Value::as_str).unwrap_or(""), move |paths| {
            let params = match paths {
                Some(paths) => json!({ "subscriptionId": id, "paths": paths }),
                None => json!({ "subscriptionId": id, "paths": [], "overflow": true }),
            };
            notify_peer.notify("fs.changed", params);
        })?;
        self.subscriptions.lock().unwrap().insert(subscription_id.clone(), Subscription::Fs { peer: peer.id, project: project.id.clone(), _watcher: watcher });
        Ok(json!({ "subscriptionId": subscription_id, "path": path }))
    }

    // ---- lifecycle ---------------------------------------------------------

    /// What an archive or delete would lose (saas contract 10.2): unpublished
    /// work per repository, running agent turns and live terminals.
    fn disposition_facts(&self) -> Result<Value, RpcError> {
        let Scope::Workspace { project, .. } = &self.scope else { return Err(RpcError::new("method_not_found", "nothing archives a machine")) };
        let repositories = project.git.disposition_repositories();
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

    // ---- worktree clean-up ---------------------------------------------------

    /// Run `f` with what the clean-up reads about this workspace: each of its
    /// repositories is a project, and neither they nor the workspace root are
    /// ever removable. Only worktrees inside the workspace are its to remove.
    fn with_cleanup_host<R>(&self, f: impl FnOnce(&crate::worktree_cleanup::Host<'_>) -> R) -> Result<R, RpcError> {
        let project = match &self.scope {
            Scope::Workspace { project, .. } => project.clone(),
            // A machine's clean-up is the one this computer's own window runs:
            // every open project, archived ones protected (Settings → Storage).
            Scope::Machine { .. } => {
                let manager = self.manager()?;
                return crate::local_runtime::workspaces::host(manager, |host| Ok(f(host))).map_err(RpcError::internal);
            }
        };
        let root = &project.root;
        let (names, _) = project.git.repositories();
        let projects: Vec<crate::store::projects::Project> = names
            .iter()
            .map(|name| {
                let dir = if name == "." { root.clone() } else { root.join(name) };
                let label = dir.file_name().map(|file| file.to_string_lossy().into_owned()).unwrap_or_else(|| name.clone());
                serde_json::from_value(json!({ "path": dir, "name": label })).map_err(RpcError::internal)
            })
            .collect::<Result<_, _>>()?;
        let protected = [root.clone()];
        let tabs = self.agents.get().map(|agents| agents.tabs()).unwrap_or_default();
        // In a turn, or waiting on an answer: what keeps a worktree even from
        // a removal that stops the agents sitting idle in it.
        let turns: HashSet<(String, String)> = tabs
            .iter()
            .filter(|tab| !tab.pending_permissions.is_empty() || matches!(tab.status, index::TabStatus::InProgress | index::TabStatus::Waiting))
            .map(|tab| (tab.session_id.clone(), tab.tab_id.clone()))
            .collect();
        let busy: HashSet<(String, String)> = tabs.iter().filter(|tab| tab.process == "running").map(|tab| (tab.session_id.clone(), tab.tab_id.clone())).chain(turns.iter().cloned()).collect();
        let running = |session: &str, tab: &str| busy.contains(&(session.to_string(), tab.to_string())) || self.sessions.as_ref().is_some_and(|manager| manager.is_running(session, tab));
        let live = |sessions: &[SessionEntry]| crate::worktree_cleanup::Live { turns: turns.clone(), ..crate::worktree_cleanup::Live::observe(&self.terminals, sessions, &running) };
        let stop_agents = |entry: &SessionEntry| match self.sessions.as_ref() {
            Some(manager) => manager.stop_agents_confirmed(entry).map_err(|error| format!("{error:#}")),
            None => Ok(()),
        };
        Ok(f(&crate::worktree_cleanup::Host { projects: &projects, protected: &protected, confine: Some(root), live: &live, fetch: crate::landed::Fetch::Fresh, stop_agents: Some(&stop_agents), archive: None }))
    }

    /// `cleanup/1`: every worktree of the workspace's repositories with
    /// whether it may be removed, and why not. Reads only.
    fn cleanup_scan(&self) -> Result<Value, RpcError> {
        let projects = self.with_cleanup_host(|host| crate::worktree_cleanup::scan(host, None))?.map_err(RpcError::internal)?;
        // On a machine each row names its project.
        let mut projects = json!(projects);
        if let (Some(ids), Some(rows)) = (self.project_ids(), projects.as_array_mut()) {
            for row in rows {
                let id = row.get("path").and_then(Value::as_str).and_then(|path| ids.get(path)).cloned();
                row["projectId"] = json!(id);
            }
        }
        Ok(json!({ "projects": projects }))
    }

    /// `cleanup/1`: what removing one worktree would free; `null` when the
    /// caller cancelled.
    fn cleanup_size(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let job = format!("peer:{}:{}", peer.id, required_str(&params, "job")?);
        let (project, path) = (required_str(&params, "projectPath")?, required_str(&params, "path")?);
        let size = self
            .with_cleanup_host(|host| crate::worktree_cleanup::estimate_size(host, crate::worktree_cleanup::Jobs::sizes(), &job, project, path))?
            .map_err(|error| RpcError::invalid(format!("{error:#}")))?;
        Ok(json!({ "bytes": size }))
    }

    fn cleanup_cancel(&self, peer: &Peer) -> Result<Value, RpcError> {
        crate::worktree_cleanup::Jobs::sizes().cancel(&format!("peer:{}:", peer.id));
        Ok(json!({}))
    }

    /// `cleanup/1`: remove the named worktrees. Each is inspected again here,
    /// on the machine that holds it, and left alone unless it is still what
    /// its token stands for. Nothing running is stopped to make a worktree
    /// removable; only a worktree already gone has its sessions' agents
    /// stopped before they are filed under the project (`reconcile`, #696).
    /// Admission is held throughout, as on the desktop, so no prompt starts
    /// an agent between that stop and the filing.
    ///
    /// While it runs the caller, and nobody else, is sent `cleanup.progress`
    /// notifications: each worktree as it starts, the step it is on, and what
    /// it came to. `run` in them is the request's `clientRequestId`. The
    /// answer is what happened; a resent request gets it without them.
    fn cleanup_remove(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        use crate::worktree_cleanup::{OfRun, Progress, Watch};
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            items: Vec<crate::worktree_cleanup::RemoveItem>,
            #[serde(default)]
            client_request_id: String,
        }
        let p: Params = parse(params)?;
        let before = index::load().map_err(RpcError::internal)?;
        let report = |progress: &Progress| peer.notify("cleanup.progress", json!(OfRun { run: &p.client_request_id, progress }));
        // Each worktree is fenced from its last inspection to its removal, and
        // the sessions `stop_agents_confirmed` stops through their filing
        // (`worktree_cleanup::remove`): no other tab's prompt waits (#727).
        let results = self.with_cleanup_host(|host| crate::worktree_cleanup::remove(host, &*self.sink, &p.items, Watch { report: Some(&report), stop: None }))?;
        // What the runtime still holds for sessions that were deleted with
        // their worktree, as after `session.delete`.
        let deleted: HashSet<String> = results.iter().flat_map(|done| done.sessions_deleted.iter().cloned()).collect();
        let tabs: Vec<&String> = before.iter().filter(|session| deleted.contains(&session.id)).flat_map(|session| &session.tabs).map(|tab| &tab.id).collect();
        if let Some(agents) = self.agents.get() {
            for tab in &tabs {
                let _ = agents.follow_ups.clear(tab);
                agents.checkpoints.remove(tab);
            }
            agents.changed(None, false);
        }
        if !deleted.is_empty() {
            self.close_session_ptys(&deleted);
            self.close_agent_ptys(tabs.into_iter());
        }
        Ok(json!({ "results": results }))
    }

    // ---- sessions --------------------------------------------------------

    fn manager(&self) -> Result<&SessionManager, RpcError> {
        self.sessions.as_ref().ok_or_else(|| RpcError::new("unavailable", "agents are not running in this runtime"))
    }

    /// Every session of this workspace, whoever asks.
    fn workspace_sessions(&self) -> Result<Vec<SessionEntry>, RpcError> {
        crate::store::message_activity::backfill(self.sink.clone());
        let ids = self.project_ids();
        let mut sessions: Vec<_> = index::load().map_err(RpcError::internal)?.into_iter().filter(|session| self.owns(&session.project_path, ids.as_ref())).collect();
        // Sessions on one branch are in one project, so this workspace's sessions are every peer that matters.
        if let Ok(manager) = self.manager() { let stored = sessions.clone(); manager.annotate_row_statuses_among(&mut sessions, &stored); }
        Ok(sessions)
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
        let ids = self.project_ids();
        let mut accounts = self.sees_accounts(peer).then(super::machine_session::Accounts::default);
        let sessions: Vec<Value> = self.visible_sessions(peer)?.iter().map(|session| self.session_wire_with(session, ids.as_ref(), accounts.as_mut())).collect();
        Ok(json!({ "sessions": sessions }))
    }

    fn session_get(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let session = self.session_wire(&session, self.project_ids().as_ref());
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
            /// `pipeline/1`: the issue the session works on. Its worktree is
            /// named after it, and unless `pipeline` is false it is carried on
            /// to a pull request and a review (`issue_pipeline`).
            #[serde(default)]
            issue: Option<index::IssueRef>,
            /// The issue's text as the desktop read it, for the reviewer:
            /// this workspace cannot read the tracker itself.
            #[serde(default)]
            issue_body: Option<String>,
            #[serde(default)]
            pipeline: Option<bool>,
            #[serde(default)]
            pipeline_options: Option<crate::issue_pipeline::LaunchOptions>,
            /// The project's pipeline settings as the desktop keeps them for
            /// this cloud project; stored here, where each decision reads them.
            #[serde(default)]
            pipeline_settings: Option<crate::store::projects::IssuePipelineSettings>,
            #[serde(default)]
            worktree_name: Option<String>,
            #[serde(default)]
            repository: Option<super::session_target::RepositoryTarget>,
            /// The desktop's Settings → Experimental → Native Codex (#644): a
            /// Codex tab goes through the app server where it can. A runtime
            /// that does not know the field starts a terminal tab, as before.
            #[serde(default)]
            native_codex: bool,
            /// `machine/1`: the project the session runs in.
            #[serde(default)]
            project_id: Option<String>,
            /// `session-base/1` (PRO-348): the branch the new worktree is cut
            /// from, as `git.branches` lists it; the default branch without it.
            #[serde(default)]
            base_ref: Option<String>,
        }
        let mut p: Params = parse(params)?;
        let base_ref = p.base_ref.take().filter(|_| p.use_worktree).map(|base| check_base_ref(&base)).transpose()?;
        // A blank mode is no mode: the tab takes the default launch mode.
        p.mode = index::requested_mode(p.mode.take());
        let manager = self.manager()?;
        self.check_new_tab(&p.agent, &p.model, p.mode.as_deref())?;
        if let Some(issue) = &p.issue {
            check_issue(issue)?;
        }
        let (project, workspace_root) = match &self.scope {
            Scope::Workspace { project, .. } => (super::session_target::resolve(&project.root, p.repository.as_ref())?, Some(project.root.clone())),
            // A machine's project is named by its id and is already a project
            // here, with its own pipeline settings, which a caller does not
            // replace; it has no workspace checkout to route to.
            Scope::Machine { projects, .. } => {
                if p.repository.is_some() {
                    return Err(RpcError::invalid("a machine's session names its project with projectId, not a repository"));
                }
                p.pipeline_settings = None;
                let id = p.project_id.as_deref().ok_or_else(|| RpcError::invalid("projectId is required: this runtime serves several projects"))?;
                let project = projects.get(id)?;
                (project.root.clone(), None)
            }
        };
        let root = project.to_string_lossy().into_owned();
        // A checkout of the workspace's repository is a project of its own:
        // its issue pipeline's settings are stored and read under its path,
        // so it is registered like the root, which is at start. Unregistered,
        // an issue session there started with no pipeline (#461).
        if p.repository.is_some() {
            if let Err(error) = crate::store::projects::add(&root) {
                log::warn!("register the repository checkout {root}: {error:#}");
            }
        }
        if let Some(settings) = p.pipeline_settings.take() {
            let patch = crate::store::projects::ProjectPatch { issue_pipeline: Some(settings), ..Default::default() };
            if let Err(error) = crate::store::projects::update(&root, patch) {
                log::warn!("store the issue pipeline settings: {error:#}");
            }
        }
        if let (true, None, Some(workspace_root)) = (p.use_worktree, &p.repository, &workspace_root) {
            // A blank project made before its folder was set up with Git: set it up now, so a worktree can be cut.
            if let Err(error) = crate::cloud_agents::launch::init_blank_repository(workspace_root, "main") {
                log::warn!("prepare the blank project folder: {error:#}");
            }
        }
        let mut first_tab = crate::session_ops::NewTab { transport: Default::default(),
            harness: p.agent,
            model: p.model,
            effort: p.effort,
            permission_mode: p.mode,
        };
        // The desktop's Native Codex setting, under the same rules as a Mac's:
        // a session that carries a pipeline keeps the terminal engine.
        if p.native_codex {
            crate::session_ops::native_codex(&mut first_tab, p.issue.is_some() || p.pipeline == Some(true));
        }
        let entry = crate::session_ops::create_session_blocking(
            &*self.sink,
            crate::session_ops::NewSession {
                parent: None,
                section_id: None,
                project_path: root,
                title: p.title,
                use_worktree: p.use_worktree,
                on_main: !p.use_worktree,
                base_ref,
                checkout_branch: None,
                checkout_pr: None,
                worktree_name: p.worktree_name.filter(|_| p.use_worktree),
                issue: p.issue.clone(),
                automation: None,
                cwd: None,
                tab: Some(first_tab),
                orchestrate: false,
            },
        )
        .map_err(RpcError::internal)?;
        let tab = entry.tabs.first().cloned().ok_or_else(|| RpcError::internal("the new session has no tab"))?;
        // Started before the first prompt goes, which carries its brief: the
        // turn it starts must find its pipeline.
        let mut prompt = p.prompt.filter(|prompt| !prompt.trim().is_empty());
        let (mut pipeline, mut pipeline_note) = (Value::Null, Value::Null);
        if (p.issue.is_some() || p.pipeline == Some(true)) && p.pipeline != Some(false) {
            let started = self.pipeline_host().map_err(|error| anyhow::anyhow!(error.message)).and_then(|host| {
                let pipeline = crate::issue_pipeline::engine::start(&host, &entry.id, &tab.id, Some(false), p.issue_body.as_deref())?;
                match p.pipeline_options.as_ref() {
                    Some(options) => crate::issue_pipeline::engine::set_resolve_conflicts(&host, &pipeline.id, options.resolve_conflicts),
                    None => Ok(pipeline),
                }
            });
            match started {
                Ok(started) => {
                    let brief = crate::issue_pipeline::prompts::author_brief();
                    prompt = Some(match prompt {
                        Some(prompt) => format!("{prompt}\n\n{brief}"),
                        None => brief,
                    });
                    pipeline = pipeline_on_the_wire(json!(started));
                }
                // The session still starts; it just ends at the code, and says why.
                Err(error) => pipeline_note = json!(format!("{error:#}")),
            }
        }
        let mut start_error = None;
        let outcome = match prompt {
            Some(prompt) => match manager.send(&entry.id, &tab.id, prompt, Vec::new()) {
                Ok(outcome) => Some(outcome),
                Err(error) => {
                    start_error = Some(self.session_start_failed(manager, &entry.id, &tab.id, &mut pipeline, error));
                    None
                }
            },
            None => None,
        };
        let info = self.agents.get().and_then(|agents| {
            agents.changed(Some(&tab.id), true);
            agents.tab(&tab.id)
        });
        let session = self.session_wire(&entry, self.project_ids().as_ref());
        Ok(json!({ "sessionId": entry.id, "tabId": tab.id, "session": session, "outcome": outcome, "tab": info, "pipeline": pipeline, "pipelineNote": pipeline_note, "startError": start_error }))
    }

    fn session_start_failed(&self, manager: &SessionManager, session_id: &str, tab_id: &str, pipeline: &mut Value, error: anyhow::Error) -> String {
        // Creation succeeded, but delivery may have partially launched
        // the agent or written work. Keep the session discoverable;
        // never delete its checkout on a failed first send.
        let mut message = format!("The session was created, but its first prompt could not be sent: {error:#}");
        if let Some(id) = pipeline["id"].as_str() {
            let stopped = self.pipeline_host().map_err(|error| anyhow::anyhow!(error.message)).and_then(|host| {
                crate::issue_pipeline::engine::turn_failed(&host, session_id, tab_id, &message);
                crate::issue_pipeline::engine::act(&host, id, crate::issue_pipeline::engine::Action::Stop)
            });
            match stopped {
                Ok(stopped) => *pipeline = pipeline_on_the_wire(json!(stopped)),
                Err(error) => message.push_str(&format!(" Pipeline cleanup failed: {error:#}. Stop it before retrying.")),
            }
        }
        if let Err(error) = manager.stop(session_id, tab_id) {
            message.push_str(&format!(" Agent cleanup failed: {error:#}. Retry Stop before resuming."));
        }
        // Older clients open the returned tab and replay its transcript.
        // A runtime status preserves cleanup details; agent error events
        // are reduced to a recovery category by the session manager.
        if let Err(error) = manager.publish_external(session_id, tab_id, crate::events::Payload::Status { text: message.clone() }) {
            message.push_str(&format!(" Could not record the start failure: {error:#}."));
        }
        message
    }

    /// `pipeline/1`: a desktop moved the pipeline's Linear issue to review
    /// with its reader's own Linear key; `message` is what it did, for the record.
    fn pipeline_note_tracker(&self, params: Value) -> Result<Value, RpcError> {
        let pipeline = self.own_pipeline(&params)?;
        let message = required_str(&params, "message")?.trim();
        if message.is_empty() || message.chars().count() > 300 || message.chars().any(char::is_control) {
            return Err(RpcError::invalid("message must be one line of at most 300 characters"));
        }
        let host = self.pipeline_host()?;
        let noted = crate::issue_pipeline::engine::note_tracker(&host, &pipeline.id, message).map_err(|error| RpcError::new("conflict", format!("{error:#}")))?;
        Ok(json!({ "pipeline": pipeline_on_the_wire(json!(noted)) }))
    }

    // ---- an issue's pipeline (#433) ----------------------------------------------

    /// The pipeline's hands here: this runtime's sessions, git and `gh`. A
    /// session it opens is announced to the agent tabs like any other.
    fn pipeline_host(&self) -> Result<crate::issue_pipeline::host::LocalHost, RpcError> {
        let manager = self.manager()?.clone();
        let agents = self.agents.get().map(Arc::downgrade);
        let tab_added: crate::issue_pipeline::host::TabAdded = Arc::new(move |tab_id| {
            if let Some(agents) = agents.as_ref().and_then(Weak::upgrade) {
                agents.changed(Some(tab_id), true);
            }
        });
        Ok(match self.scope {
            // A machine's pipelines are its own: they merge with its `gh` and
            // move issues with its Linear key, as its window's do.
            Scope::Machine { .. } => crate::issue_pipeline::host::LocalHost::new(self.sink.clone(), manager),
            Scope::Workspace { .. } => crate::issue_pipeline::host::LocalHost::cloud_workspace(self.sink.clone(), manager, tab_added),
        })
    }

    /// One of this workspace's pipelines, by its id.
    fn own_pipeline(&self, params: &Value) -> Result<crate::issue_pipeline::Pipeline, RpcError> {
        let id = required_str(params, "pipeline")?;
        crate::issue_pipeline::store::get(id).ok().filter(|pipeline| self.owns(&pipeline.project_path, None)).ok_or_else(|| RpcError::not_found(format!("issue pipeline {id} not found")))
    }

    /// `pipeline/1`: this workspace's pipelines, newest first, as many as fit
    /// [`PIPELINE_LIST_BYTES`]; `truncated` when older ones were left out.
    fn pipeline_list(&self) -> Result<Value, RpcError> {
        let ids = self.project_ids();
        let mut pipelines: Vec<_> = crate::issue_pipeline::store::list().map_err(RpcError::internal)?.into_iter().filter(|pipeline| self.owns(&pipeline.project_path, ids.as_ref())).collect();
        pipelines.sort_by(|a, b| b.created.cmp(&a.created));
        let (mut listed, mut bytes) = (Vec::new(), 0);
        for pipeline in &pipelines {
            let wire = self.pipeline_wire(json!(pipeline), ids.as_ref());
            bytes += wire.to_string().len();
            if listed.len() == PIPELINE_LIST_MAX || bytes > PIPELINE_LIST_BYTES {
                break;
            }
            listed.push(wire);
        }
        Ok(json!({ "pipelines": listed, "truncated": listed.len() < pipelines.len() }))
    }

    /// Persistent reviewer identities for existing sessions in this workspace.
    /// Page independently of the bounded pipeline history, using stable ID order.
    fn pipeline_reviewers(&self, params: &Value) -> Result<Value, RpcError> {
        let after = params.get("after").and_then(Value::as_str).unwrap_or("");
        let reviewers = crate::issue_pipeline::store::reviewer_sessions().map_err(RpcError::internal)?;
        let projects = self.project_ids();
        let mut ids: Vec<_> = index::load().map_err(RpcError::internal)?.into_iter()
            .filter(|session| self.owns(&session.project_path, projects.as_ref()) && session.id.as_str() > after && reviewers.contains(&session.id))
            .map(|session| session.id).collect();
        ids.sort();
        let more = ids.len() > 500;
        ids.truncate(500);
        let next = if more { ids.last().cloned() } else { None };
        Ok(json!({ "sessionIds": ids, "next": next }))
    }

    /// `pipeline/1`: what a person can do from the issue page, less the
    /// merge, which a runtime never makes. A pipeline not in a position to
    /// do it is refused and left as it was.
    fn pipeline_act(&self, params: Value) -> Result<Value, RpcError> {
        use crate::issue_pipeline::engine::{self, Action};
        let pipeline = self.own_pipeline(&params)?;
        let action: Action = serde_json::from_value(params.get("action").cloned().unwrap_or(Value::Null)).map_err(|_| RpcError::invalid("action must be stop, resume, advance, review or refresh"))?;
        let host = self.pipeline_host()?;
        let acted = engine::act(&host, &pipeline.id, action).map_err(|error| RpcError::new("conflict", format!("{error:#}")))?;
        Ok(json!({ "pipeline": pipeline_on_the_wire(json!(acted)) }))
    }

    /// `pipeline/1`: the desktop merged the pull request with its reader's
    /// own `gh`, pinned to `commit`. The runtime reads the pull request itself
    /// and records the merge as theirs.
    fn pipeline_note_merge(&self, params: Value) -> Result<Value, RpcError> {
        let pipeline = self.own_pipeline(&params)?;
        let commit = required_str(&params, "commit")?;
        if !(7..=40).contains(&commit.len()) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(RpcError::invalid("commit must be a commit id"));
        }
        let host = self.pipeline_host()?;
        let noted = crate::issue_pipeline::engine::note_merge(&host, &pipeline.id, commit).map_err(|error| RpcError::new("conflict", format!("{error:#}")))?;
        Ok(json!({ "pipeline": pipeline_on_the_wire(json!(noted)) }))
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

    /// Refuse a new tab whose agent, model or permission mode is unavailable.
    fn check_new_tab(&self, agent: &str, model: &str, mode: Option<&str>) -> Result<(), RpcError> {
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
        crate::harness::claude::models::validate(&agent.id, model).map_err(|error| RpcError::invalid(error.to_string()))?;
        Ok(())
    }

    /// `agents/1`: the installed agents, each with its models (and their
    /// efforts) and the launch modes it takes. Paths on the VM stay here.
    fn runtime_agents(&self, peer: &Peer, params: &Value) -> Result<Value, RpcError> {
        let offered = self.offered_agents();
        // PRO-350: on a machine, each agent's version and login there, and
        // the agents it has no CLI for. A cloud workspace's agents sign in
        // through its own flows, so it starts no probe.
        let machine = matches!(self.scope, Scope::Machine { .. });
        // Each probe starts a process there: only a manager makes them run
        // now; anyone else is answered from the kept check.
        let refresh = params["refresh"].as_bool().unwrap_or(false) && peer.authority == Authority::Manage;
        let missing = machine.then(|| super::machine_agents::missing(&offered));
        let installed: Vec<crate::harness::HarnessInfo> = offered.into_iter().filter(|agent| agent.available).collect();
        let sign_ins: HashMap<String, super::machine_agents::SignIn> = if machine {
            let probe = self.sign_in_probe();
            installed.iter().map(|agent| (agent.id.clone(), super::machine_agents::sign_in(agent, refresh, &*probe))).collect()
        } else {
            HashMap::new()
        };
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
                let mut described = json!({
                    "id": agent.id,
                    "name": agent.name,
                    "caps": agent.caps,
                    "models": own,
                    "modes": modes,
                    "defaultMode": index::DEFAULT_PERMISSION_MODE,
                });
                if let Some(sign_in) = sign_ins.get(&agent.id) {
                    described["version"] = json!(sign_in.version);
                    described["signIn"] = json!(sign_in.state);
                    described["signInCheckedAt"] = json!(sign_in.checked_at);
                }
                described
            })
            .collect();
        let mut listed = json!({ "agents": agents });
        if let Some(missing) = missing {
            listed["missing"] = missing;
        }
        Ok(listed)
    }

    /// How an agent's login is read: its CLI, or a stand-in under test.
    fn sign_in_probe(&self) -> Box<dyn Fn(&crate::harness::HarnessInfo) -> super::machine_agents::Probed> {
        #[cfg(test)]
        if let Some(states) = self.sign_ins_for_tests.lock().unwrap().clone() {
            return Box::new(move |agent| states.get(&agent.id).cloned().unwrap_or((crate::harness::readiness::State::Unknown, None)));
        }
        Box::new(super::machine_agents::probe)
    }

    #[cfg(test)]
    pub(super) fn set_sign_ins_for_tests(&self, states: HashMap<String, super::machine_agents::Probed>) {
        *self.sign_ins_for_tests.lock().unwrap() = Some(states);
    }

    /// `machine/4`: an agent's install or sign-in in a terminal on the
    /// machine (PRO-350). The command is the registry's, made here; the
    /// caller names only the agent and the step. One step at a time per
    /// agent, whoever asks: the machine's own window included.
    fn machine_agent_setup(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        struct Params {
            harness: String,
            step: String,
            #[serde(default = "default_cols")]
            cols: u16,
            #[serde(default = "default_rows")]
            rows: u16,
        }
        let p: Params = parse(params)?;
        if p.cols == 0 || p.rows == 0 || p.cols > 1000 || p.rows > 1000 {
            return Err(RpcError::invalid("cols and rows must be between 1 and 1000"));
        }
        let step = crate::harness::setup::Step::parse(&p.step).map_err(|error| RpcError::invalid(error.to_string()))?;
        let command = self.setup_command(&p.harness, step)?;
        let home = dirs::home_dir().ok_or_else(|| RpcError::internal("no home directory"))?;
        let home = home.to_string_lossy().into_owned();
        let mut started: Option<(String, Value)> = None;
        let mut failed: Option<RpcError> = None;
        // Its terminal id is made as it starts: noted as a step for another
        // computer, which the window's own setup counts too.
        let begun = crate::harness::setup::begin(
            &p.harness,
            None,
            step,
            || self.setup_running(&p.harness),
            || {
                match self.start_pty(
                    peer,
                    NewPty { cwd: "~".into(), start_in: &home, command: Some(&command), session_id: None, project_id: None, cols: p.cols, rows: p.rows, setup: Some(SetupPty { harness: p.harness.clone(), step }) },
                ) {
                    Ok(pty) => {
                        crate::harness::setup::began_elsewhere(&p.harness, &pty.0);
                        started = Some(pty);
                    }
                    Err(error) => {
                        failed = Some(error);
                        anyhow::bail!("not started");
                    }
                }
                Ok(())
            },
        );
        if let Some(error) = failed {
            return Err(error);
        }
        if let Err(error) = begun {
            // Someone else's step of this agent runs: the caller follows it.
            let run = self.setup_run(&p.harness);
            let refused = RpcError::new("setup_busy", error.to_string());
            return Err(match run {
                Some(run) => refused.with_data(run),
                None => refused,
            });
        }
        let (_, described) = started.ok_or_else(|| RpcError::internal("the setup step did not start"))?;
        Ok(described)
    }

    /// An agent's setup terminal is the manager's alone (PRO-350): a sign-in
    /// shows a device code or a login address, and whoever completes it
    /// decides whose account the machine's CLI signs in to.
    fn setup_pty_refusal(&self, peer: &Peer, params: &Value) -> Result<(), RpcError> {
        let Some(pty_id) = params["ptyId"].as_str() else { return Ok(()) };
        let setup = self.ptys.lock().unwrap().get(pty_id).is_some_and(|pty| pty.setup.is_some());
        if setup && peer.authority != Authority::Manage {
            return Err(RpcError::new("forbidden", "only a manager may follow an agent's sign-in or install"));
        }
        Ok(())
    }

    /// `machine.agentSetupRunning`: the step of `harness` running in a
    /// terminal a peer can attach to.
    /// `machine/6` (PRO-351): a machine's projects from another computer.
    /// Adding or removing one emits `projects_changed`, as `projects.add`
    /// on the control socket does, so `machine.changed` goes out.
    fn machine_projects_call(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        use super::machine_projects as projects;
        match method {
            "machine.browse" => projects::browse(&self.machine_home()?, params),
            "machine.addProject" => {
                let added = projects::add(&self.machine_home()?, params)?;
                self.sink.emit("projects_changed", &());
                Ok(added)
            }
            "machine.removeProject" => {
                let removed = projects::remove(params)?;
                self.sink.emit("projects_changed", &());
                Ok(removed)
            }
            "machine.cloneProject" => self.machine_clones.start(&self.machine_home()?, params, self.sink.clone()),
            "machine.cloneStatus" => self.machine_clones.status(params),
            "machine.cloneCancel" => self.machine_clones.cancel(params),
            _ => Err(RpcError::new("method_not_found", format!("{method} is not a machine/6 method"))),
        }
    }

    /// `machine/8` (PRO-408): a machine session's usage, a tab's
    /// continuation context and a pull request's failed check logs, each for
    /// a session the caller may see. Usage read again that moved is told to
    /// every connection, as a turn's end tells it.
    fn machine_session_call(&self, peer: &Peer, method: &str, params: &Value) -> Result<Value, RpcError> {
        use super::machine_session as parity;
        let session = self.visible_session(peer, required_str(params, "sessionId")?)?;
        let tab = |session: &SessionEntry| -> Result<String, RpcError> {
            let tab_id = required_str(params, "tabId")?;
            match session.tab(tab_id) {
                Some(tab) if tab.is_terminal() => Err(RpcError::invalid("the tab is a terminal, not an agent tab")),
                Some(tab) => Ok(tab.id.clone()),
                None => Err(RpcError::not_found("no such tab")),
            }
        };
        match method {
            "session.usage" => {
                let (latest, changed) = crate::session_usage::refresh_session(&session.id).map_err(RpcError::internal)?;
                if changed {
                    self.sink.emit("session_updated", &latest);
                }
                let windows = self.manager().map(|manager| manager.usage_snapshot().windows).unwrap_or_default();
                Ok(parity::usage_answer(&latest, windows))
            }
            "session.prepareContinuation" => {
                let tab_id = tab(&session)?;
                let tracked = self.manager().ok().and_then(|manager| manager.tracked_transcript(&session.id, &tab_id));
                let context = crate::continuation::prepare(&session.id, &tab_id, tracked, false).map_err(RpcError::internal)?;
                Ok(json!(context))
            }
            "session.checkFailures" => {
                let tab_id = tab(&session)?;
                parity::check_failures(&session.id, &tab_id, required_str(params, "prUrl")?)
            }
            _ => Err(RpcError::new("method_not_found", format!("{method} is not a machine/8 method"))),
        }
    }

    /// The home directory `machine/6` stays under: the runtime user's.
    fn machine_home(&self) -> Result<std::path::PathBuf, RpcError> {
        #[cfg(test)]
        if let Some(home) = self.home_for_tests.lock().unwrap().clone() {
            return Ok(home);
        }
        super::machine_projects::home()
    }

    #[cfg(test)]
    pub(super) fn set_home_for_tests(&self, home: &Path) {
        *self.home_for_tests.lock().unwrap() = Some(std::fs::canonicalize(home).unwrap());
    }

    /// `machine/7` (PRO-403): a session's Setup and Run on this machine. The
    /// project's saved actions, preview URLs and setup script are read from
    /// this machine's own store, and every run is this runtime's, in the
    /// session's folder here, exactly as for a session of its own window.
    fn machine_session_run_call(&self, peer: &Peer, method: &str, params: &Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(params, "sessionId")?)?;
        if method == "machine.sessionActions" {
            return self.machine_session_actions(&session);
        }
        let manager = self.manager()?;
        // What the runtime refuses (a removed worktree, an action no longer saved, a restart still stopping) is the person's to read.
        let refused = |error: anyhow::Error| RpcError::new("conflict", format!("{error:#}"));
        match method {
            "machine.runAction" => {
                let action_id = required_str(params, "actionId")?;
                let restart = params.get("restart").and_then(Value::as_bool).unwrap_or(false);
                let outcome = crate::action_runner::run(manager, &session.id, action_id, crate::action_runner::RunOptions { restart }).map_err(refused)?;
                let scope = self.pty_session_scope(peer);
                let mut ptys = self.ptys.lock().unwrap();
                let terminal = self.run_entry(&mut ptys, &outcome.run.pane_id, Some(&outcome.run.name), RunDiscovery::Active).map(|pty| {
                    // The person who started it types into it (a Ctrl-C, an answer to a prompt).
                    if outcome.started {
                        pty.controller = Some(peer.device_id.clone());
                        pty.controller_user = Some((peer.user_id.clone(), peer.authority));
                        pty.controller_installation = peer.installation_key.clone();
                    }
                    self.describe_pty(&outcome.run.pane_id, pty, peer, scope.as_ref())
                });
                Ok(json!({
                    "started": outcome.started,
                    "run": {
                        "actionId": outcome.run.action_id,
                        "name": outcome.run.name,
                        "ptyId": outcome.run.pane_id,
                        "state": outcome.run.state,
                        "exitCode": outcome.run.exit_code,
                    },
                    "terminal": terminal,
                }))
            }
            "machine.setupRerun" => {
                let setup = crate::workspace_setup::start(manager, &session.id, true).map_err(refused)?;
                Ok(json!({ "setup": setup.as_ref().map(setup_wire) }))
            }
            "machine.setupStop" => {
                let setup = crate::workspace_setup::stop(manager, &session.id, required_str(params, "paneId")?).map_err(refused)?;
                Ok(json!({ "setup": setup.as_ref().map(setup_wire) }))
            }
            _ => Err(RpcError::new("method_not_found", format!("{method} is not a machine/7 method"))),
        }
    }

    /// `machine.sessionActions`: what the Run menu, the Open button and the
    /// dock's Setup and Run tabs show for `session`, as this machine has it.
    fn machine_session_actions(&self, session: &SessionEntry) -> Result<Value, RpcError> {
        let canonical = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
        let wanted = canonical(&session.project_path);
        let project = machine::registered()?.into_iter().find(|project| canonical(&project.path) == wanted);
        let (actions, preview_urls) = project.map(|project| (project.actions, project.preview_urls)).unwrap_or_default();
        let setup = match self.manager() {
            Ok(manager) => crate::workspace_setup::current(manager, &session.id).map_err(RpcError::internal)?,
            Err(_) => None,
        };
        Ok(json!({
            "actions": actions,
            "previewUrls": preview_urls,
            "setupScript": crate::workspace_setup::saved_script(&session.project_path),
            // A workspace's own checkout runs setup; the project's folder does not.
            "setupApplies": !session.worktree_removed && session.worktree_name.is_some() && session.cwd != session.project_path,
            "available": !session.worktree_removed,
            // What $PORT and $PORT_1..$PORT_9 are on the machine; null when not known.
            "ports": index::workspace_ports::ports(&session.cwd).ok().filter(|ports| !ports.is_empty()),
            "setup": setup.as_ref().map(setup_wire),
        }))
    }

    fn machine_agent_setup_running(&self, params: &Value) -> Result<Value, RpcError> {
        let harness = required_str(params, "harness")?;
        Ok(json!({ "run": self.setup_run(harness) }))
    }

    /// The command for a step started from another computer.
    fn setup_command(&self, harness: &str, step: crate::harness::setup::Step) -> Result<String, RpcError> {
        #[cfg(test)]
        if let Some(command) = self.setup_command_for_tests.lock().unwrap().clone() {
            return Ok(command);
        }
        crate::harness::setup::command_elsewhere(harness, step).map_err(|error| RpcError::invalid(error.to_string()))
    }

    #[cfg(test)]
    pub(super) fn set_setup_command_for_tests(&self, command: &str) {
        *self.setup_command_for_tests.lock().unwrap() = Some(command.to_string());
    }

    /// Every running setup step of `harness`: this runtime's peers' terminals
    /// and its own window's setup panes.
    fn setup_running(&self, harness: &str) -> Vec<String> {
        let mut running: Vec<String> = self
            .ptys
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, pty)| pty.setup.as_ref().is_some_and(|setup| setup.harness == harness) && pty.exit.is_none() && !pty.closed)
            .map(|(id, _)| id.clone())
            .collect();
        running.extend(
            self.terminals.panes().into_iter().filter(|pane| pane.running && crate::harness::setup::is_pane(harness, &pane.id)).map(|pane| pane.id),
        );
        running
    }

    /// `{ ptyId, step }` of the setup step of `harness` a peer can attach to, if one runs.
    fn setup_run(&self, harness: &str) -> Option<Value> {
        let ptys = self.ptys.lock().unwrap();
        ptys.iter()
            .filter(|(_, pty)| pty.exit.is_none() && !pty.closed)
            .find_map(|(id, pty)| pty.setup.as_ref().filter(|setup| setup.harness == harness).map(|setup| json!({ "ptyId": id, "step": setup.step.name() })))
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
            return Err(RpcError::invalid("name a title, pinned, archived or manualStatus"));
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
            /// As in `session.create`.
            #[serde(default)]
            native_codex: bool,
        }
        let p: Params = parse(params)?;
        let session = self.visible_session(peer, &p.session_id)?;
        let mode = index::requested_mode(p.mode);
        self.check_new_tab(&p.agent, &p.model, mode.as_deref())?;
        let mut new_tab = crate::session_ops::NewTab { transport: Default::default(), harness: p.agent, model: p.model, effort: p.effort, permission_mode: mode };
        if p.native_codex { crate::session_ops::native_codex(&mut new_tab, false); }
        // Through the session manager where there is one: it is the one place that refuses a Bypass tab in a shared session.
        let tab = match &self.sessions {
            Some(manager) => manager.add_tab(&session.id, &new_tab).map_err(|error| RpcError::new("refused", error.to_string()))?,
            None => crate::session_ops::add_tab_entry(&session.id, &new_tab).map_err(RpcError::internal)?,
        };
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
        let stop = |doomed: &SessionEntry| self.stop_before_removal(doomed);
        // Deleting a session deletes that session. Its worktree goes with it
        // only when asked, when no other session runs there, and through the
        // same checked path as every other workspace removal: one that is
        // not clean and merged needs `confirmedUnsafe`, the client's second
        // confirmation. A directory git cannot remove is reported, never
        // deleted directly.
        let workspace = if remove_worktree { crate::session_ops::sole_workspace_of(&session.id).map_err(RpcError::internal)? } else { None };
        let confirmed_unsafe = params.get("confirmedUnsafe").and_then(Value::as_bool).unwrap_or(false);
        let mut kept_branch = None;
        let removed = match &workspace {
            Some(path) => {
                let expected = vec![session.id.clone()];
                let request = crate::session_ops::WorkspaceRemoval {
                    project_path: &session.project_path,
                    path,
                    sessions: crate::session_ops::SessionsFate::Delete,
                    delete_branch: true,
                    confirmation: if confirmed_unsafe { crate::session_ops::Confirmation::Forced } else { crate::session_ops::Confirmation::Single },
                    // The client asked to delete this one session. If
                    // another has started in the worktree since, the
                    // worktree is not this session's alone to take.
                    expected_sessions: Some(&expected),
                    direct: crate::git::DirectDelete::Never,
                    fetch: crate::landed::Fetch::Fresh,
                    guard: None, archive: None, archive_failure: None, archive_retry: None, archive_started: None,
                };
                let removed = crate::session_ops::remove_workspace_fallible(&*self.sink, &request, &stop).map_err(RpcError::internal)?;
                kept_branch = removed.removal.kept_branch;
                removed.sessions
            }
            None => vec![crate::session_ops::delete_session_blocking_fallible(&*self.sink, &session.id, &stop).map_err(RpcError::internal)?],
        };
        // Said when the worktree was asked for and stayed because other
        // sessions still run in it.
        let worktree_kept = remove_worktree && workspace.is_none() && session.worktree_name.is_some() && !session.worktree_removed;
        let deleted = self.forget_deleted_sessions(&removed);
        Ok(json!({ "sessionId": session.id, "deleted": deleted, "keptBranch": kept_branch, "worktreeKept": worktree_kept }))
    }

    /// End what a session that is about to be deleted runs, and wait.
    fn stop_before_removal(&self, doomed: &SessionEntry) -> Result<(), String> {
        let mut failures = Vec::new();
        if let Some(manager) = &self.sessions {
            if let Err(error) = manager.stop_session_confirmed(doomed) { failures.push(format!("{error:#}")); }
        }
        if let Err(error) = self.close_session_ptys_waiting(&HashSet::from([doomed.id.clone()]), Some(std::time::Duration::from_secs(5))) {
            failures.push(error);
        }
        if failures.is_empty() { Ok(()) } else { Err(failures.join("; ")) }
    }

    /// Drop what the runtime still holds for sessions that were deleted, and
    /// say which they were.
    fn forget_deleted_sessions(&self, removed: &[SessionEntry]) -> Vec<String> {
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
        deleted
    }

    // ---- one session's worktree ----------------------------------------------

    /// `workspace/1`: where the checkout a session runs in stands, as the
    /// desktop's removal dialog reads a local one. The checkout is the
    /// session's own `cwd` from this runtime's index: a client names a
    /// session, never a path. A session in the repository's main directory
    /// answers `isMain`, and nothing of it can be removed.
    fn workspace_disposition(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let fetch = params.get("fetch").and_then(Value::as_bool).unwrap_or(false);
        let project = Path::new(&session.project_path);
        Self::require_no_pending_pr_creation(project, Path::new(&session.cwd))?;
        let disposition = crate::session_ops::workspace_disposition(project, Path::new(&session.cwd), fetch).map_err(RpcError::internal)?;
        if disposition.exists && !disposition.is_main {
            crate::archive_script::require_no_script(project).map_err(RpcError::internal)?;
        }
        Ok(json!({ "disposition": disposition }))
    }

    /// A create whose pull request was never verified blocks reading and
    /// removing its checkout. Named with its URL, so the client can offer
    /// `git.prReconcileCreation` instead of only the original Create form.
    fn require_no_pending_pr_creation(project: &Path, cwd: &Path) -> Result<(), RpcError> {
        match crate::session_ops::pending_pr_creation_for(project, cwd).map_err(RpcError::internal)? {
            Some(url) => Err(RpcError::new("pending_pr_creation", format!("Verify the pull request at {url} before removing this workspace."))
                .with_data(json!({ "url": url }))),
            None => Ok(()),
        }
    }

    /// `workspace/1`: remove the worktree a session runs in, with every
    /// session in it, through the same checked path as every other workspace
    /// removal. `expectedSessions` are the ones the dialog named, and
    /// `confirmedDigest` its second confirmation for exactly what it showed;
    /// without one, only a worktree found clean and merged goes. A directory
    /// git cannot remove is reported, never deleted directly.
    fn workspace_remove(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            session_id: String,
            #[serde(default)]
            delete_branch: bool,
            #[serde(default)]
            confirmed_digest: Option<String>,
            expected_sessions: Vec<String>,
        }
        let p: Params = parse(params)?;
        let session = self.visible_session(peer, &p.session_id)?;
        if session.worktree_name.is_none() || session.worktree_removed {
            return Err(RpcError::invalid("this session does not run in a worktree"));
        }
        Self::require_no_pending_pr_creation(Path::new(&session.project_path), Path::new(&session.cwd))?;
        let request = crate::session_ops::WorkspaceRemoval {
            project_path: &session.project_path,
            path: &session.cwd,
            sessions: crate::session_ops::SessionsFate::Delete,
            delete_branch: p.delete_branch,
            confirmation: p.confirmed_digest.map(crate::session_ops::Confirmation::Shown).unwrap_or(crate::session_ops::Confirmation::Single),
            expected_sessions: Some(&p.expected_sessions),
            direct: crate::git::DirectDelete::Never,
            fetch: crate::landed::Fetch::Fresh,
            guard: None, archive: None, archive_failure: None, archive_retry: None, archive_started: None,
        };
        let stop = |doomed: &SessionEntry| self.stop_before_removal(doomed);
        let removed = crate::session_ops::remove_workspace_fallible(&*self.sink, &request, &stop).map_err(RpcError::internal)?;
        let deleted = self.forget_deleted_sessions(&removed.sessions);
        Ok(json!({ "deleted": deleted, "keptBranch": removed.removal.kept_branch, "rescuedBranch": removed.removal.rescued_branch }))
    }

    // ---- the removal that follows a merged pull request -------------------------

    /// `workspace/2`: one pass over this workspace's repositories: which
    /// worktrees' pull requests merged, which stay and why, and the removal
    /// of those that are safe and due, with their branches. The caller says
    /// only that it is on, whether conversations go too, and how long the
    /// grace period is; when a merge was first seen is kept here. With
    /// `enabled: false` nothing is looked at and what was seen is forgotten:
    /// the caller's way of saying it has been turned off.
    fn workspace_sweep_merged(&self, params: Value) -> Result<Value, RpcError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            enabled: Option<bool>,
            #[serde(default)]
            delete_sessions: bool,
            grace_seconds: u64,
        }
        let p: Params = parse(params)?;
        let before = index::load().map_err(RpcError::internal)?;
        let swept = self
            .with_cleanup_host(|host| {
                let scope = crate::merged_cleanup::Scope {
                    projects: host.projects.iter().filter(|_| p.enabled != Some(false)).map(|project| project.path.clone()).collect(),
                    delete_sessions: p.delete_sessions,
                    grace_seconds: p.grace_seconds,
                };
                let stop = |doomed: &SessionEntry| self.stop_before_removal(doomed);
                let pull_requests = |cwd: &Path, branches: &[String]| crate::github::branch_prs(cwd, branches);
                let run = crate::merged_cleanup::FallibleSweep { host, sink: &*self.sink, stop: &stop, pull_requests: &pull_requests, now: chrono::Utc::now() };
                crate::merged_cleanup::sweep_fallible(&run, &scope)
            })?
            .map_err(RpcError::internal)?;
        // What the runtime still holds for sessions deleted with their
        // worktree, as after `session.delete`.
        let deleted: HashSet<&String> = swept.statuses.iter().filter_map(|status| status.record.as_ref()).flat_map(|record| &record.sessions_deleted).collect();
        if !deleted.is_empty() {
            let removed: Vec<SessionEntry> = before.into_iter().filter(|session| deleted.contains(&session.id)).collect();
            self.forget_deleted_sessions(&removed);
        }
        Ok(json!({ "statuses": swept.statuses, "unreadable": swept.unreadable }))
    }

    /// `workspace/2`: keep a worktree that is waiting to be removed, or let
    /// it go again. The path only names an entry of what this runtime has
    /// itself seen merged.
    fn workspace_hold_merged(&self, params: Value) -> Result<Value, RpcError> {
        let held = params.get("held").and_then(Value::as_bool).ok_or_else(|| RpcError::invalid("held is required"))?;
        crate::merged_cleanup::hold(required_str(&params, "path")?, held, chrono::Utc::now()).map_err(|error| RpcError::not_found(format!("{error:#}")))?;
        Ok(json!({}))
    }

    /// `workspace/2`: what was removed here, newest first, with whether each
    /// can still be brought back.
    fn workspace_removed_records(&self) -> Result<Value, RpcError> {
        let records = self.with_cleanup_host(crate::merged_cleanup::records)?.map_err(RpcError::internal)?;
        Ok(json!({ "records": records }))
    }

    /// `workspace/2`: undo one recorded removal, where it was.
    fn workspace_restore_removed(&self, params: Value) -> Result<Value, RpcError> {
        let id = required_str(&params, "id")?;
        let restored = self
            .with_cleanup_host(|host| crate::merged_cleanup::restore(host, &*self.sink, id, chrono::Utc::now()))?
            .map_err(|error| RpcError::invalid(format!("{error:#}")))?;
        Ok(json!({ "record": restored.record, "notes": restored.notes }))
    }

    /// Close the terminals opened for sessions that are gone.
    fn close_session_ptys(&self, sessions: &HashSet<String>) {
        let _ = self.close_session_ptys_waiting(sessions, None);
    }

    /// Close the sessions' terminals; with `wait`, also wait that long for
    /// their processes to exit.
    fn close_session_ptys_waiting(&self, sessions: &HashSet<String>, wait: Option<std::time::Duration>) -> Result<(), String> {
        if let Some(timeout) = wait {
            let ids = self.ptys.lock().unwrap().iter()
                .filter(|(_, pty)| pty.session_id.as_ref().is_some_and(|id| sessions.contains(id)))
                .map(|(id, _)| id.clone()).collect::<Vec<_>>();
            return self.close_selected_ptys_waiting(&ids, timeout);
        }
        // Nonwaiting teardown retains its existing close/forget semantics.
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
        for id in killed { self.terminals.kill(&id); }
        self.forget_subscriptions(ended);
        Ok(())
    }

    /// Retain the remote entry, output and subscriptions until the captured
    /// launches have actually stopped. A retry still knows which panes belong
    /// to the session even though their local Pane objects were detached.
    fn close_selected_ptys_waiting(&self, ids: &[String], timeout: std::time::Duration) -> Result<(), String> {
        let identities: Vec<_> = {
            let mut ptys = self.ptys.lock().unwrap();
            ids.iter().filter_map(|id| ptys.get_mut(id).map(|pty| {
                pty.stop_pending = true;
                (id.clone(), pty.input_pending.clone(), pty.pid)
            })).collect()
        };
        self.terminals.kill_all_and_wait_confirmed(ids, timeout).map_err(|error| format!("{error:#}"))?;
        self.finish_selected_ptys_stop(identities)
    }

    fn finish_selected_ptys_stop(&self, identities: Vec<(String, Arc<AtomicUsize>, Option<u32>)>) -> Result<(), String> {
        let ended = {
            let mut ptys = self.ptys.lock().unwrap();
            if identities.iter().any(|(id, identity, pid)| self.terminals.is_live(id) || !self.terminals.pending_stops(id).is_empty()
                || ptys.get(id).is_some_and(|pty| !Arc::ptr_eq(&pty.input_pending, identity) || pty.pid != *pid)) {
                return Err("A terminal changed while stopping; its session was retained. Retry the operation.".into());
            }
            let mut ended = Vec::new();
            for (id, _, _) in identities {
                if let Some(pty) = ptys.get_mut(&id) {
                    pty.stop_pending = false;
                    pty.closed = true;
                    if pty.exit.is_some() { ended.extend(Self::remove_pty(&mut ptys, &id)); }
                }
            }
            ended
        };
        self.forget_subscriptions(ended);
        Ok(())
    }

    fn session_close(&self, params: Value) -> Result<Value, RpcError> {
        let session = index::load()
            .map_err(RpcError::internal)?
            .into_iter()
            .find(|session| Some(session.id.as_str()) == params.get("sessionId").and_then(Value::as_str))
            .filter(|session| self.owns(&session.project_path, None))
            .ok_or_else(|| RpcError::not_found("no such session"))?;
        let only = params.get("tabId").and_then(Value::as_str);
        let closing: Vec<String> = session.tabs.iter().filter(|tab| only.is_none_or(|id| id == tab.id)).map(|tab| tab.id.clone()).collect();
        // Without agents (tests) nothing is running to stop.
        if let Some(manager) = &self.sessions {
            for tab_id in &closing {
                // As main: an idle tab has nothing to stop, and stopping it
                // would post "Session closed" into its log and read an
                // unread reply. A running one, or one whose earlier stop is
                // still unconfirmed (#467), is stopped and must confirm.
                if manager.is_running(&session.id, tab_id) || manager.stop_unconfirmed(&session.id, tab_id) {
                    manager.stop(&session.id, tab_id).map_err(RpcError::internal)?;
                }
            }
        }
        if params.get("remove").and_then(Value::as_bool) == Some(true) {
            let pane_ids: Vec<_> = session.tabs.iter().filter(|tab| closing.contains(&tab.id)).map(crate::store::index::TabEntry::pane_id).collect();
            self.terminals.kill_all_and_wait_confirmed(&pane_ids, std::time::Duration::from_secs(5)).map_err(RpcError::internal)?;
            if closing.len() == session.tabs.len() {
                self.close_session_ptys_waiting(&HashSet::from([session.id.clone()]), Some(std::time::Duration::from_secs(5))).map_err(RpcError::internal)?;
            } else {
                let agent_ids: Vec<_> = closing.iter().map(|id| format!("{AGENT_PTY_PREFIX}{id}")).collect();
                self.close_selected_ptys_waiting(&agent_ids, std::time::Duration::from_secs(5)).map_err(RpcError::internal)?;
            }
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
        let _policy = self.collab.enter_admission();
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let tab_id = required_str(&params, "tabId")?;
        let tab = session.tabs.iter().find(|tab| tab.id == tab_id).ok_or_else(|| RpcError::not_found("no such tab"))?;
        if self.collab.runtime_policy.is_v2() {
            let permit = collab::v2::current().ok_or_else(|| RpcError::forbidden("Collaboration provenance missing"))?;
            permit.check(self.manager()?.collaboration_v2_witness(&session.id, &tab.id).as_ref()).map_err(|_| RpcError::forbidden("Collaboration policy or tab safety changed"))?;
            if self.collab.runtime_policy.everyone(peer.user_id.as_deref().unwrap_or("")) && slash::is_command(params.get("text").and_then(Value::as_str).unwrap_or("")) {
                permit.check_configuration().map_err(|_| RpcError::forbidden("Explicit configuration authority required"))?;
            }
        }
        // Images and files uploaded with `session.attach` ride with the text, or alone.
        let image_ids = crate::cloud_agents::attachments::named(&params).ok_or_else(|| RpcError::invalid("images is a list of at most 8 uploaded attachments"))?;
        let file_ids = crate::cloud_agents::attachments::named_files(&params).ok_or_else(|| RpcError::invalid("files is a list of uploaded attachments; with the images, at most 10"))?;
        let attached = !image_ids.is_empty() || !file_ids.is_empty();
        let text = match params.get("text").and_then(Value::as_str) {
            Some(text) => text,
            None if attached => "",
            None => return Err(RpcError::invalid("text is required")),
        };
        if text.trim().is_empty() && !attached {
            return Err(RpcError::invalid("text is empty"));
        }
        // The same rule as a mailbox send (contract §21.5), for managers
        // too: they take a held lease over explicitly.
        if self.authority(peer) == Authority::Participate && !self.access(peer).can_drive() {
            return Err(RpcError::forbidden("sending needs driver access to the workspace"));
        }
        let busy = agents_busy(&self.agents, &session.id, &tab.id);
        // And the same rule for what the CLI runs by itself (PRO-88): a
        // slash command, a `!` shell command, an `@/path` mention.
        if !self.access(peer).can_configure() {
            if let Err(refusal) = slash::check(text, &tab.harness, Some(Path::new(&session.cwd))) {
                return Err(RpcError::forbidden(refusal.message()).with_data(json!({ "reason": refusal.category(), "command": refusal.command })));
            }
        }
        // A slash or `!` command never waits in the session's own queue,
        // whoever sends it: nothing re-checks that queue if they lose the
        // right before the running turn ends (the mailbox's follow-up queue
        // is re-checked). Prose queues as before, mentions included.
        if slash::is_command(text) && (busy || self.sessions.as_ref().is_some_and(|sessions| sessions.turn_open(&session.id, &tab.id))) {
            return Err(RpcError::new("conflict", slash::NOT_QUEUED_MESSAGE).with_data(json!({ "reason": slash::NOT_QUEUED_CATEGORY })));
        }
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
        let images = if image_ids.is_empty() {
            Vec::new()
        } else {
            self.agents()?.attachments.load(&attachment_owner(peer), &image_ids).map_err(|_| {
                RpcError::invalid("Not sent: an image of this message did not reach the workspace. Attach it and send again.").with_data(json!({ "reason": "attachment-missing" }))
            })?
        };
        // Into the session's attachments folder on this computer (PRO-407):
        // the agent is handed their paths here, as a local tab's files are.
        let files = if file_ids.is_empty() {
            Vec::new()
        } else {
            use crate::cloud_agents::attachments::FilesError;
            match self.agents()?.attachments.take_files(&attachment_owner(peer), &session.id, &file_ids) {
                Ok(files) => files,
                Err(error) => {
                    self.agents()?.attachments.remove(&image_ids);
                    return Err(match error {
                        FilesError::Missing(_) => RpcError::invalid(crate::cloud_agents::mailbox::FILE_MISSING_MESSAGE).with_data(json!({ "reason": "attachment-missing" })),
                        FilesError::Failed(error) => RpcError::internal(error),
                    });
                }
            }
        };
        let sent = self.manager().and_then(|manager| manager.send_pressed(&session.id, &tab.id, text.to_string(), images, None, files).map_err(RpcError::internal));
        if !image_ids.is_empty() {
            self.agents()?.attachments.remove(&image_ids);
        }
        let outcome = sent?;
        // Only what reached the agent claims the tab.
        if let Some(user) = peer.user_id.as_deref() {
            // As busy as it was before this send: an expired lease of someone
            // else never blocks it (their idle lease is not live, this turn is).
            let _ = self.collab.claim(&tab.id, user, now, busy, false);
        }
        Ok(json!({ "sessionId": session.id, "tabId": tab.id, "outcome": outcome }))
    }

    /// What this runtime offers in `rpc.hello`: what it serves as a
    /// workspace or a machine (`protocol::served`), less `agent-commands/1`
    /// beside a mailbox.
    fn offered(&self) -> Vec<&'static str> {
        protocol::served(self.is_machine()).into_iter().filter(|capability| *capability != protocol::AGENT_COMMANDS || self.agent_commands.get().is_some()).collect()
    }

    /// Whether `spec` is answered from the durable receipts of
    /// `agent-commands/1`: its own methods, and `session.send` once a
    /// connection was granted it.
    fn durable_command(&self, peer: &Peer, spec: &protocol::Method) -> bool {
        self.agent_commands.get().is_some()
            && (spec.capability == protocol::AGENT_COMMANDS || (spec.name == "session.send" && peer.granted(protocol::AGENT_COMMANDS)))
    }

    /// `agent-commands/1` (PRO-343): send, steer, stop or a permission
    /// decision, decided and applied by the mailbox's own rules
    /// (`cloud_agents::mailbox::decide`) and answered once per device and
    /// `clientRequestId`:
    /// - A repeat gets the first reply and touches nothing; the same id
    ///   with another body is refused (`conflict`, `id-reused`).
    /// - An id whose first try was cut off by a restart is answered
    ///   `outcome_unknown`, except a stop, which is applied again.
    /// - A send that arrives while a turn runs, or behind earlier queued
    ///   ones, waits in the tab's durable follow-up queue and says
    ///   `queued: true`; its receipt answers a repeat, so it is never queued
    ///   twice. A steer goes into the running turn.
    /// - A decision names its `requestId`; one already answered, or gone,
    ///   is refused (`conflict`, `request-not-pending`).
    fn agent_command(&self, peer: &Peer, method: &str, params: Value, policy_stamp: Option<collab::v2::Stamp>) -> Result<Value, RpcError> {
        use super::agent_commands::{self as receipts, Known};
        let journal = self.agent_commands.get().ok_or_else(|| RpcError::new("method_not_found", format!("{method} is not a workspace method")))?;
        let agents = self.agents()?;
        let kind = match method {
            "session.send" => "send",
            "session.steer" => "steer",
            "session.stop" => "stop",
            "session.decide" => "permission-decision",
            other => return Err(RpcError::new("method_not_found", format!("{other} is not a workspace method"))),
        };
        // Checked by the dispatcher already.
        let request_id = required_str(&params, "clientRequestId")?.to_string();
        let key = receipts::Key { device: peer.device_id.clone(), id: request_id.clone() };
        let digest = receipts::digest(method, &params);
        let now = crate::cloud_agents::now_ms();
        match journal.known(&key, now) {
            Known::Receipt { digest: first, reply } => return if first == digest { reply } else { Err(receipts::id_reused()) },
            Known::Interrupted { digest: first } if first != digest => return Err(receipts::id_reused()),
            // Cut off mid-apply: it may have reached the agent. Only a stop
            // is safe to apply again.
            Known::Interrupted { .. } if kind != "stop" => {
                let unknown = Err(receipts::outcome_unknown());
                if let Err(error) = journal.record(&key, &digest, &unknown, now) {
                    log::error!("record agent command receipt {request_id}: {error:#}");
                }
                return unknown;
            }
            Known::Interrupted { .. } | Known::New => {}
        }
        let tab = self.visible_tab(peer, &params)?;
        if kind == "permission-decision" && params.get("requestId").and_then(Value::as_str).is_none_or(str::is_empty) {
            return Err(RpcError::invalid("requestId names the request this decision answers"));
        }
        let actor = attachment_owner(peer);
        let command = crate::cloud_agents::mailbox::Command {
            kind,
            tab_id: &tab.tab_id,
            client_command_id: &request_id,
            actor_id: &actor,
            // As the live `session.send` always did: only a person takes part
            // in tab leases.
            leases: peer.user_id.is_some(),
            access: self.access(peer),
            policy_stamp,
            plaintext: &params,
        };
        match crate::cloud_agents::mailbox::decide(agents, &command, || journal.applying(&key, &digest, now)) {
            // Nothing reached the agent: decided again if sent again.
            crate::cloud_agents::mailbox::Decided::Refused((outcome, category, extra)) => receipts::reply(&tab.session_id, &tab.tab_id, outcome, category, extra),
            crate::cloud_agents::mailbox::Decided::MarkFailed => {
                Err(RpcError::new("unavailable", "the runtime could not record this command, so it did not apply it; send it again"))
            }
            crate::cloud_agents::mailbox::Decided::Applied((outcome, category, extra)) => {
                let reply = receipts::reply(&tab.session_id, &tab.tab_id, outcome, category, extra);
                // The agent was (or was not) touched; without a durable
                // receipt the `applying` mark answers a repeat as unknown.
                if let Err(error) = journal.record(&key, &digest, &reply, crate::cloud_agents::now_ms()) {
                    log::error!("record agent command receipt {request_id}: {error:#}");
                }
                reply
            }
        }
    }

    /// `session/3` (#427): Escape for a tab's running turn. The turn is
    /// interrupted and the agent's process stays up. The follow-up queue is
    /// not touched, so the next queued message goes out once the turn has
    /// settled (a mailbox `stop` is what drops it). Live only, and never a
    /// mailbox command: queued, it would land in some later turn.
    ///
    /// Whoever may stop the tab may interrupt it: a driver while nobody else
    /// holds its lease, a manager always. It claims no lease and is not use
    /// of the workspace that keeps it awake.
    fn session_interrupt(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let tab = self.visible_tab(peer, &params)?;
        let access = self.access(peer);
        if self.authority(peer) == Authority::Participate && !access.can_drive() {
            return Err(RpcError::forbidden("interrupting needs driver access to the workspace"));
        }
        match peer.user_id.as_deref() {
            Some(user) if access.role != Role::Manager => {
                let busy = agents_busy(&self.agents, &tab.session_id, &tab.tab_id);
                if let Some(held) = self.collab.held_by_other(&tab.tab_id, user, crate::cloud_agents::now_ms(), busy) {
                    return Err(lease_refusal(LeaseRefusal::Held(held)));
                }
            }
            None if self.authority(peer) == Authority::Participate => return Err(RpcError::forbidden("interrupting needs a signed-in person")),
            _ => {}
        }
        let interrupted = self.agents()?.ops.interrupt(&tab.session_id, &tab.tab_id).map_err(RpcError::internal)?;
        Ok(json!({ "interrupted": interrupted }))
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

    /// The slash commands the composer of an agent tab offers the caller
    /// (`composer/1`, PRO-22): what the tab's CLI lists in the session's
    /// directory, as a local tab's composer shows them. Someone who may not
    /// decide what the agent does on its own is offered only the commands
    /// they may send (PRO-88, `slash::allows`), and `restricted` says so;
    /// someone who may not send at all is offered none. Reading it starts
    /// no agent and no turn.
    fn session_commands(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let tab_id = required_str(&params, "tabId")?;
        let tab = session.tabs.iter().find(|tab| tab.id == tab_id).ok_or_else(|| RpcError::not_found("no such tab"))?;
        let access = self.access(peer);
        let may_send = self.authority(peer) == Authority::Manage || access.can_drive();
        let restricted = !access.can_configure();
        let commands: Vec<SlashCommand> = if may_send {
            let listed = self.listed_commands(&tab.harness, Path::new(&session.cwd))?;
            listed.into_iter().filter(|command| !restricted || slash::allows(&tab.harness, &command.name)).collect()
        } else {
            Vec::new()
        };
        Ok(json!({ "commands": commands, "restricted": restricted }))
    }

    /// One part of an image the caller attaches to the message they are
    /// about to send to an agent tab (`composer/3`, PRO-22). The image waits
    /// in the runtime's private state until that message names it, and only
    /// its uploader's message can. Needs what sending needs.
    fn session_attach(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let tab_id = required_str(&params, "tabId")?;
        if !session.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err(RpcError::not_found("no such tab"));
        }
        // `kind: "file"` (`composer/4`, PRO-407): a file other than an image.
        let file = match params.get("kind").and_then(Value::as_str) {
            None | Some("image") => false,
            Some("file") => true,
            Some(_) => return Err(RpcError::invalid("kind is image or file")),
        };
        if self.authority(peer) == Authority::Participate && !self.access(peer).can_drive() {
            return Err(RpcError::forbidden(if file { "attaching a file needs driver access to the workspace" } else { "attaching an image needs driver access to the workspace" }));
        }
        let id = required_str(&params, "attachmentId")?;
        let media_type = required_str(&params, "mediaType")?;
        let offset = params.get("offset").and_then(Value::as_u64).ok_or_else(|| RpcError::invalid("offset is required"))?;
        let data = STANDARD.decode(required_str(&params, "data")?).map_err(|_| RpcError::invalid("data is not base64"))?;
        let last = params.get("last").and_then(Value::as_bool).unwrap_or(false);
        let name = params.get("name").and_then(Value::as_str);
        use crate::cloud_agents::attachments::AttachError;
        match self.agents()?.attach_part(&attachment_owner(peer), id, offset, &data, media_type, name, file, last) {
            Ok(size) => Ok(json!({ "attachmentId": id, "size": size, "complete": last })),
            Err(AttachError::Invalid(why)) => Err(RpcError::invalid(why)),
            Err(AttachError::Refused(why)) => Err(RpcError::invalid(why).with_data(json!({ "reason": "file-refused" }))),
            Err(AttachError::TooLarge) if file => Err(RpcError::invalid(format!("the file is larger than {} MB", crate::attachments::MAX_ATTACHMENT_BYTES / 1024 / 1024)).with_data(json!({ "reason": "file-too-large" }))),
            Err(AttachError::TooLarge) => Err(RpcError::invalid("the image is larger than 5 MB").with_data(json!({ "reason": "image-too-large" }))),
            Err(AttachError::Full) => Err(RpcError::new("conflict", "too many attachments are waiting to be sent here; try again later").with_data(json!({ "reason": "attachments-full" }))),
            Err(AttachError::Failed(error)) => Err(RpcError::internal(error)),
        }
    }

    /// The pull requests a session's composer `#` list offers for `query`
    /// (`composer/5`, #1329): a number names one, open or not; words match
    /// open pull requests' titles and authors. Read with the workspace's own
    /// `gh` in the session's checkout, so they are the workspace's pull
    /// requests, not those of a checkout on the reader's computer. Anyone who
    /// may see the session may ask.
    fn session_prs(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let query = params.get("query").and_then(Value::as_str).unwrap_or("");
        if query.len() > MAX_FILE_QUERY_BYTES {
            return Err(RpcError::invalid("the query is too long"));
        }
        let (project, dir) = self.session_checkout(&session)?;
        Ok(json!({ "prs": project.git.mention_prs(&dir, query)? }))
    }

    /// The context file a `#` mention attaches for pull request `number`: its
    /// title, description and changed files as Markdown, named
    /// `pr-<number>.md` (`composer/5`, #1329). The composer attaches it as a
    /// file (`composer/4`), so it reaches the agent as a local tab's PR
    /// context does, stored in the session's attachments folder here. Needs
    /// what attaching needs.
    fn session_pr_context(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        if self.authority(peer) == Authority::Participate && !self.access(peer).can_drive() {
            return Err(RpcError::forbidden("attaching a pull request needs driver access to the workspace"));
        }
        let number = params.get("number").and_then(Value::as_u64).ok_or_else(|| RpcError::invalid("number is required"))?;
        let (project, dir) = self.session_checkout(&session)?;
        let (text, truncated) = bounded_text(project.git.mention_pr_context(&dir, number)?, MAX_PR_CONTEXT_BYTES);
        Ok(json!({ "number": number, "name": format!("pr-{number}.md"), "text": text, "truncated": truncated }))
    }

    /// The Git of the project a session belongs to, and the directory its
    /// agent runs in there (its worktree), or the project's root when that
    /// directory is gone or outside it.
    fn session_checkout(&self, session: &SessionEntry) -> Result<(Arc<ServedProject>, std::path::PathBuf), RpcError> {
        let project = match &self.scope {
            Scope::Machine { projects, .. } => projects.get(&machine::project_id(&session.project_path))?,
            Scope::Workspace { project, .. } => project.clone(),
        };
        let dir = std::fs::canonicalize(&session.cwd)
            .ok()
            .filter(|cwd| project.files.contains(cwd) && cwd.is_dir())
            .unwrap_or_else(|| project.root.clone());
        Ok((project, dir))
    }

    /// The files of a session's directory whose path matches `query`, best
    /// first, for the composer's `@` list (`composer/2`, PRO-22): the same
    /// index and ranking as a local tab's (`files::search`), so paths are
    /// relative to the session's directory, ignored files are left out and
    /// an empty query lists the shallowest files. Names only, never
    /// contents; anyone who may see the session may ask.
    fn session_files(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, required_str(&params, "sessionId")?)?;
        let query = params.get("query").and_then(Value::as_str).unwrap_or("");
        if query.len() > MAX_FILE_QUERY_BYTES {
            return Err(RpcError::invalid("the query is too long"));
        }
        let limit = params.get("limit").and_then(Value::as_u64).map_or(DEFAULT_FILE_HITS, |limit| limit as usize).clamp(1, MAX_FILE_HITS);
        let files = crate::files::search(Path::new(&session.cwd), query, limit, false).map_err(RpcError::internal)?;
        Ok(json!({ "files": files }))
    }

    /// What the CLI of `harness` lists in `cwd`, as `list_slash_commands`
    /// does for a local tab: only Claude Code is asked. A CLI that is not
    /// installed or did not answer (a just-woken machine can be slow) is an
    /// error, `unavailable`, never an empty list: the composer would keep
    /// "no commands" as the answer, and it asks again instead.
    fn listed_commands(&self, harness: &str, cwd: &Path) -> Result<Vec<SlashCommand>, RpcError> {
        #[cfg(test)]
        if let Some(commands) = self.commands_for_tests.lock().unwrap().clone() {
            return commands.ok_or_else(|| RpcError::new("unavailable", "the agent's command list could not be read"));
        }
        if harness != "claude" {
            return Ok(Vec::new());
        }
        crate::harness::claude::commands::list(cwd).map_err(|error| {
            log::warn!("list slash commands: {error:#}");
            RpcError::new("unavailable", "the agent's command list could not be read").with_data(json!({ "reason": "commands-unavailable" }))
        })
    }

    #[cfg(test)]
    pub(super) fn set_commands_for_tests(&self, commands: Option<Vec<SlashCommand>>) {
        *self.commands_for_tests.lock().unwrap() = Some(commands);
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
        if let Some(model) = &settings.model {
            crate::harness::claude::models::validate(&tab.harness, model).map_err(|error| RpcError::invalid(error.to_string()))?;
        }
        let agents = self.agents()?;
        agents.ops.configure(&tab.session_id, &tab.tab_id, &settings).map_err(RpcError::internal)?;
        agents.changed(Some(&tab.tab_id), true);
        Ok(json!({ "tab": agents.tab(&tab.tab_id) }))
    }

    /// What a finished turn changed, from the checkpoint this runtime kept of
    /// it (`checkpoints/1`, #1326), as a local tab's turn card reads it: null
    /// for a turn with no checkpoint (not a Git checkout, or still running).
    fn session_turn_checkpoint(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let tab = self.visible_tab(peer, &params)?;
        let seq = required_seq(&params, "seq")?;
        let Some(turn) = crate::checkpoints::get(&tab.session_id, &tab.tab_id, seq).map_err(RpcError::internal)? else { return Ok(json!({ "checkpoint": null })) };
        let saved = serde_json::to_value(&turn).map_err(RpcError::internal)?;
        // Only what the card shows: the checkpoint's trees and paths stay on the runtime.
        let mut checkpoint = serde_json::Map::new();
        for key in ["number", "reviewed", "undone", "files", "restored", "backupRef", "unavailableReason"] {
            if let Some(value) = saved.get(key) {
                checkpoint.insert(key.into(), value.clone());
            }
        }
        Ok(json!({ "checkpoint": checkpoint }))
    }

    /// Keep a turn's changes, undo them, or put back what an undo removed
    /// (`checkpoints/1`), as a local tab's turn card does. An undo or restore
    /// that would overwrite other changes is answered with them and a token
    /// (`undone: false`); sent again with that token as `confirmed`, it goes ahead.
    fn session_review_turn(&self, peer: &Peer, method: &str, params: Value) -> Result<Value, RpcError> {
        let tab = self.visible_tab(peer, &params)?;
        let seq = required_seq(&params, "seq")?;
        let confirmed = params.get("confirmed").and_then(Value::as_str);
        let refused = |error: anyhow::Error| RpcError::new("refused", format!("{error:#}"));
        let result = match method {
            "session.keepTurn" => {
                crate::checkpoints::keep(&tab.session_id, &tab.tab_id, seq).map_err(refused)?;
                return Ok(json!({}));
            }
            "session.undoTurn" => crate::checkpoints::undo(&tab.session_id, &tab.tab_id, seq, confirmed),
            _ => crate::checkpoints::restore_undo(&tab.session_id, &tab.tab_id, seq, confirmed),
        };
        serde_json::to_value(result.map_err(refused)?).map_err(RpcError::internal)
    }

    /// Reset a tab's chat to the end of the turn `endSeq`, or with `endSeq`
    /// null undo the last reset (`checkpoints/1`), through the same
    /// `SessionManager::reset_chat` a local tab's reset takes. `resetFiles`
    /// also puts the checkout back to that turn; one that would overwrite
    /// other changes is refused with them and a token (`session_reset::OVERLAP`),
    /// and goes ahead when sent again with that token as `confirm`. The tab's
    /// `history` changes, so every reader drops the turns that went.
    fn session_reset(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let tab = self.visible_tab(peer, &params)?;
        let end_seq = match params.get("endSeq") {
            None | Some(Value::Null) => None,
            Some(seq) => Some(seq.as_u64().ok_or_else(|| RpcError::invalid("endSeq is a sequence number, or null to undo the last reset"))?),
        };
        let reset_files = params.get("resetFiles").and_then(Value::as_bool).unwrap_or(false);
        let confirm = params.get("confirm").and_then(Value::as_str);
        let warning = self
            .manager()?
            .reset_chat(&tab.session_id, &tab.tab_id, end_seq, reset_files, confirm)
            .map_err(|error| RpcError::new("refused", format!("{error:#}")))?;
        if let Ok(session) = index::get(&tab.session_id) {
            self.sink.emit("session_updated", &session);
        }
        let agents = self.agents()?;
        agents.changed(Some(&tab.tab_id), true);
        Ok(json!({ "warning": warning, "tab": agents.tab(&tab.tab_id) }))
    }

    /// Fork a tab's conversation as it stood at the end of the turn `endSeq`
    /// (`checkpoints/1`, PRO-379): `into: "tab"` beside it in the same
    /// checkout, `into: "session"` as a new session on a worktree of its own
    /// with that turn's files where they were kept. The same `session_fork`
    /// a local fork takes; `note` says when the files are not the turn's.
    fn session_fork(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let tab = self.visible_tab(peer, &params)?;
        let end_seq = required_seq(&params, "endSeq")?;
        let into: crate::session_fork::ForkInto =
            serde_json::from_value(params.get("into").cloned().unwrap_or(Value::Null)).map_err(|_| RpcError::invalid("into is \"tab\" or \"session\""))?;
        let agents = self.agents()?;
        let (session_id, tab_id, note) = match into {
            crate::session_fork::ForkInto::Tab => {
                let (session, new_tab) = crate::session_fork::fork_into_tab_contents(&tab.session_id, &tab.tab_id, end_seq).map_err(|error| RpcError::new("refused", error))?;
                self.sink.emit("session_updated", &session);
                (session.id, new_tab, None)
            }
            crate::session_fork::ForkInto::Session => {
                let (entry, note) = crate::session_fork::fork_session_contents(&tab.session_id, &tab.tab_id, Some(end_seq)).map_err(|error| RpcError::new("refused", error))?;
                self.sink.emit("session_created", &entry);
                // A worktree made for the fork runs the project's setup, as a new session's does.
                if entry.worktree_name.is_some() {
                    self.sink.emit(crate::workspace_setup::CREATED_EVENT, &entry);
                }
                (entry.id.clone(), entry.active_tab.clone().unwrap_or_default(), note)
            }
        };
        agents.changed(Some(&tab_id), true);
        Ok(json!({ "sessionId": session_id, "tabId": tab_id, "note": note, "tab": agents.tab(&tab_id) }))
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

/// A base branch for `session.create` (`session-base/1`): a branch name as
/// `git.branches` lists it, never something git could read as an option or a
/// revision expression. Whether it exists is git's to say when the worktree
/// is cut.
fn check_base_ref(base: &str) -> Result<String, RpcError> {
    let base = base.trim();
    let valid = !base.is_empty()
        && base.len() <= 255
        && !base.starts_with('-')
        && !base.starts_with('/')
        && !base.ends_with('/')
        && !base.ends_with(".lock")
        && !base.contains("..")
        && !base.contains("@{")
        && !base.contains("//")
        && base.chars().all(|c| !c.is_control() && !c.is_whitespace() && !matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'));
    if valid {
        Ok(base.to_string())
    } else {
        Err(RpcError::invalid("baseRef is not a branch name"))
    }
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|error| RpcError::invalid(error.to_string()))
}

fn required_str<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    params.get(name).and_then(Value::as_str).ok_or_else(|| RpcError::invalid(format!("{name} is required")))
}

/// An event's sequence number in a tab's log.
fn required_seq(params: &Value, name: &str) -> Result<u64, RpcError> {
    params.get(name).and_then(Value::as_u64).ok_or_else(|| RpcError::invalid(format!("{name} is required")))
}

/// The most pipelines `pipeline.list` sends, and the bytes they may take: well
/// inside [`MAX_FRAME_BYTES`] with room for the envelope.
const PIPELINE_LIST_MAX: usize = 50;
const PIPELINE_LIST_BYTES: usize = 512 * 1024;

/// A pipeline as a desktop is sent it: without the issue's text, which is the
/// reviewer's and is never shown.
/// The `projectId` a `pty.create` named, as params [`WorkspaceRpc::project`] reads.
fn params_project(project_id: &Option<String>) -> Value {
    json!({ "projectId": project_id })
}

fn pipeline_on_the_wire(mut pipeline: Value) -> Value {
    if let Some(fields) = pipeline.as_object_mut() {
        fields.remove("issueBody");
    }
    pipeline
}

/// An issue a session is started from. It names the session, its worktree and
/// the pull request that closes it, so it is held to what a tracker gives.
fn check_issue(issue: &index::IssueRef) -> Result<(), RpcError> {
    if !matches!(issue.provider.as_str(), "github" | "linear") {
        return Err(RpcError::invalid("issue.provider must be github or linear"));
    }
    let fits = |value: &str, limit: usize| !value.trim().is_empty() && value.chars().count() <= limit && !value.chars().any(char::is_control);
    if !fits(&issue.id, 128) || !fits(&issue.identifier, 64) || !fits(&issue.title, 512) {
        return Err(RpcError::invalid("issue needs an id, an identifier and a title"));
    }
    if !(issue.url.starts_with("https://") && fits(&issue.url, 2048)) {
        return Err(RpcError::invalid("issue.url must be an https link"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "machine_tests.rs"]
mod machine_tests;

#[cfg(test)]
#[path = "cleanup_tests.rs"]
mod cleanup_tests;

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod pipeline_tests;

#[cfg(test)]
#[path = "pipeline_reviewer_tests.rs"]
mod pipeline_reviewer_tests;

#[cfg(test)]
pub(crate) static BEFORE_REMOTE_WORK: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

#[cfg(test)]
mod environment_tests {
    use super::*;

    #[tokio::test]
    async fn environment_rpc_preserves_handshake_capability_and_member_gates() {
        let dir = tempfile::tempdir().unwrap();
        let rpc = WorkspaceRpc::new(dir.path(), 1, Arc::new(crate::sink::BroadcastSink::new(64)), Arc::new(Terminals::new()), None).unwrap();
        let (peer, _events) = Peer::for_user("environment-viewer".into(), Authority::Participate, Some("viewer".into()));
        let call = |method: &'static str, params: Value| {
            let rpc = rpc.clone();
            let peer = peer.clone();
            async move { rpc.handle(&peer, &json!({"id": "env-test", "method": method, "params": params})).await }
        };
        let params = json!({"requestId": uuid::Uuid::new_v4().to_string()});
        assert_eq!(call("environment.report", params.clone()).await["error"]["code"], "hello_required");
        call("rpc.hello", json!({"protocol": PROTOCOL, "want": ["fs/1"]})).await;
        assert_eq!(call("environment.report", params.clone()).await["error"]["code"], "capability_not_granted");
        call("rpc.hello", json!({"protocol": PROTOCOL, "want": ["environment/1"]})).await;
        assert_eq!(call("environment.report", params.clone()).await["error"]["code"], "forbidden");
        rpc.set_collaboration(Some(serde_json::from_value(json!({"v": 1, "members": [{"userId": "viewer", "role": "viewer"}]})).unwrap()));
        for role in ["viewer", "driver", "manager"] {
            rpc.set_collaboration(Some(serde_json::from_value(json!({"v": 1, "members": [{"userId": "viewer", "role": role}]})).unwrap()));
            assert_eq!(call("environment.report", params.clone()).await["error"]["code"], "forbidden", "a listed {role} cannot consume the manager probe slot");
            assert_eq!(call("environment.cancel", params.clone()).await["error"]["code"], "forbidden");
        }
        rpc.set_collaboration(Some(serde_json::from_value(json!({"v": 1, "members": [{"userId": "owner", "role": "manager"}]})).unwrap()));
        let (manager, _events) = Peer::for_user("environment-owner".into(), Authority::Manage, Some("owner".into()));
        let invoke = |method: &str, params: Value| json!({"id": "owner-env", "method": method, "params": params});
        rpc.handle(&manager, &invoke("rpc.hello", json!({"protocol": PROTOCOL, "want": ["environment/1"]}))).await;
        assert_eq!(rpc.handle(&manager, &invoke("environment.cancel", params.clone())).await["ok"], true);
        assert_eq!(rpc.handle(&manager, &invoke("environment.report", json!({"requestId": "bad", "command": "env"}))).await["error"]["code"], "invalid_params");
        rpc.set_collaboration(Some(serde_json::from_value(json!({"v": 1, "members": []})).unwrap()));
        assert_eq!(call("environment.report", params).await["error"]["code"], "forbidden");
    }
}
