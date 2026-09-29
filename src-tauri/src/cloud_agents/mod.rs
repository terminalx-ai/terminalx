//! Cloud agent tabs (PRO-22): the runtime half of the command mailbox and
//! transcript checkpoints, and the crypto the desktop shares. See
//! `docs/CLOUD-AGENT-TABS.md` and terminalx-saas
//! `cloud-workspace-remote-runtime-contract.md` §11-13.
//!
//! The runtime is the only writer of a tab's transcript. Commands whose
//! replay would be harmful (send, steer, stop, permission decisions) arrive
//! only through the API mailbox and are applied once, with a durable
//! receipt; the live workspace RPC reads tabs and changes their settings.

pub mod api;
pub mod checkpoints;
pub mod crypto;
pub mod keys;
pub mod launch;
pub mod mailbox;
pub mod receipts;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::events::Payload;
use crate::remote::collab::{self, Access, Collaboration};
use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, TabStatus};

pub use receipts::FollowUp;

/// Emitted on the sink when the tab list or a tab's runtime state changed,
/// so the workspace RPC tells attached clients.
pub const TABS_CHANGED: &str = "cloud_agent_tabs_changed";
/// Emitted when the workspace content key rotated, so connected clients
/// fetch the new one (`keys.changed`).
pub const KEYS_CHANGED: &str = "cloud_agent_keys_changed";

/// The workspace the mailbox and checkpoints belong to; part of every AAD.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub organization_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    pub options: Vec<String>,
}

/// One agent tab as `session.tabs` and checkpoints describe it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTabInfo {
    pub session_id: String,
    pub tab_id: String,
    pub title: Option<String>,
    pub harness: String,
    pub model: String,
    pub effort: Option<String>,
    pub permission_mode: String,
    pub status: TabStatus,
    /// `running`, `exited` (it ran and its process is gone; the saved
    /// conversation resumes on the next send) or `not-started`.
    pub process: &'static str,
    pub pending_permissions: Vec<PendingRequest>,
    pub follow_ups: Vec<FollowUpView>,
    /// Who is driving the tab (contract §20.5), if anyone.
    pub lease: Option<crate::remote::collab::TabLease>,
    pub last_seq: u64,
    pub created: String,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpView {
    pub client_command_id: String,
    pub text: String,
    /// Who sent it; empty for one queued before sharing existed.
    pub actor_id: String,
}

/// Why a permission decision could not be delivered.
#[derive(Debug)]
pub enum DecisionError {
    /// The request is not waiting (answered, lapsed, or the agent stopped).
    NotPending,
    Failed(anyhow::Error),
}

/// What the mailbox and checkpoints need from the agents. The real one is
/// [`ManagerOps`]; tests stand in for it.
pub trait AgentOps: Send + Sync {
    /// Agent tabs of this workspace, without follow-ups.
    fn tabs(&self) -> Vec<AgentTabInfo>;
    fn busy(&self, session_id: &str, tab_id: &str) -> bool;
    fn send(&self, session_id: &str, tab_id: &str, text: &str) -> Result<()>;
    fn stop(&self, session_id: &str, tab_id: &str) -> Result<()>;
    fn respond(&self, session_id: &str, tab_id: &str, request_id: &str, option_id: &str) -> Result<(), DecisionError>;
    fn answer(&self, session_id: &str, tab_id: &str, request_id: &str, answers: HashMap<String, String>) -> Result<(), DecisionError>;
    fn configure(&self, session_id: &str, tab_id: &str, settings: &Settings) -> Result<()>;
    fn note(&self, session_id: &str, tab_id: &str, text: &str);
    /// Committed events, oldest first (checkpoint projection).
    fn events(&self, session_id: &str, tab_id: &str) -> Result<Vec<Value>>;
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Settings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: Option<String>,
}

impl Settings {
    pub fn from_json(value: &Value) -> Result<Self> {
        let text = |name: &str| -> Result<Option<String>> {
            match value.get(name) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(text)) if text.len() <= 200 => Ok(Some(text.clone())),
                Some(_) => Err(anyhow!("{name} must be a short string")),
            }
        };
        let settings = Self { model: text("model")?, effort: text("effort")?, mode: text("mode")? };
        if let Some(mode) = settings.mode.as_deref() {
            if !matches!(mode, "plan" | "manual" | "auto" | "acceptEdits" | "bypassPermissions" | "default") {
                return Err(anyhow!("unknown permission mode {mode}"));
            }
        }
        Ok(settings)
    }

    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.effort.is_none() && self.mode.is_none()
    }
}

/// [`AgentOps`] over the runtime's [`SessionManager`], limited to the
/// sessions of one project root.
pub struct ManagerOps {
    pub manager: SessionManager,
    pub root: String,
}

impl ManagerOps {
    fn entries(&self) -> Vec<index::SessionEntry> {
        index::load().unwrap_or_default().into_iter().filter(|entry| entry.project_path == self.root).collect()
    }
}

impl AgentOps for ManagerOps {
    fn tabs(&self) -> Vec<AgentTabInfo> {
        let pending = self.manager.pending_permissions();
        let mut out = Vec::new();
        for entry in self.entries() {
            for tab in &entry.tabs {
                let running = self.manager.is_running(&entry.id, &tab.id);
                let last_seq = crate::store::log_path(&entry.id, &tab.id).and_then(|path| crate::store::last_seq(&path)).unwrap_or(0);
                out.push(AgentTabInfo {
                    session_id: entry.id.clone(),
                    tab_id: tab.id.clone(),
                    title: tab.title.clone().or_else(|| Some(entry.title.clone()).filter(|title| !title.is_empty())),
                    harness: tab.harness.clone(),
                    model: tab.model.clone(),
                    effort: tab.effort.clone(),
                    permission_mode: tab.permission_mode.clone(),
                    status: tab.status,
                    process: if running {
                        "running"
                    } else if tab.provider_session_id.is_some() || last_seq > 0 {
                        "exited"
                    } else {
                        "not-started"
                    },
                    pending_permissions: pending
                        .iter()
                        .filter(|request| request.session_id == entry.id && request.tab_id == tab.id)
                        .map(|request| PendingRequest {
                            request_id: request.request_id.clone(),
                            tool_name: request.tool_name.clone(),
                            input: request.input.clone(),
                            options: request.options.clone(),
                        })
                        .collect(),
                    follow_ups: Vec::new(),
                    lease: None,
                    last_seq,
                    created: tab.created.clone(),
                    modified: tab.modified.clone(),
                });
            }
        }
        out
    }

    fn busy(&self, session_id: &str, tab_id: &str) -> bool {
        // A tab left `waiting` by a lapsed request after a restart has no
        // process and no turn: it is not busy, and a prompt goes straight in.
        self.manager.turn_open(session_id, tab_id)
            || (self.manager.is_running(session_id, tab_id)
                && matches!(self.manager.status_of(session_id, tab_id), TabStatus::InProgress | TabStatus::Waiting))
    }

    fn send(&self, session_id: &str, tab_id: &str, text: &str) -> Result<()> {
        self.manager.send(session_id, tab_id, text.to_string(), Vec::new()).map(|_| ())
    }

    fn stop(&self, session_id: &str, tab_id: &str) -> Result<()> {
        match self.manager.stop(session_id, tab_id) {
            // A stop racing another stop is the same stop.
            Err(error) if error.to_string().contains("already in progress") => Ok(()),
            other => other,
        }
    }

    fn respond(&self, session_id: &str, tab_id: &str, request_id: &str, option_id: &str) -> Result<(), DecisionError> {
        if !self.manager.pending_permissions().iter().any(|p| p.session_id == session_id && p.tab_id == tab_id && p.request_id == request_id) {
            return Err(DecisionError::NotPending);
        }
        self.manager.respond_permission(session_id, tab_id, request_id, option_id).map_err(classify_decision)
    }

    fn answer(&self, session_id: &str, tab_id: &str, request_id: &str, answers: HashMap<String, String>) -> Result<(), DecisionError> {
        self.manager.answer_questions(session_id, tab_id, request_id, answers).map_err(classify_decision)
    }

    fn configure(&self, session_id: &str, tab_id: &str, settings: &Settings) -> Result<()> {
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("no such tab"))?;
        if let Some(model) = settings.model.as_deref().filter(|model| *model != tab.model) {
            self.manager.set_model(session_id, tab_id, model)?;
        }
        if let Some(effort) = settings.effort.as_deref().filter(|effort| Some(*effort) != tab.effort.as_deref()) {
            self.manager.set_effort(session_id, tab_id, Some(effort))?;
        }
        if let Some(mode) = settings.mode.as_deref().filter(|mode| *mode != tab.permission_mode) {
            self.manager.set_permission_mode(session_id, tab_id, mode)?;
        }
        Ok(())
    }

    fn note(&self, session_id: &str, tab_id: &str, text: &str) {
        if let Err(error) = self.manager.publish_external(session_id, tab_id, Payload::Status { text: text.to_string() }) {
            log::warn!("note in {tab_id}: {error:#}");
        }
    }

    fn events(&self, session_id: &str, tab_id: &str) -> Result<Vec<Value>> {
        let events = self.manager.load_events(session_id, tab_id)?;
        Ok(events.into_iter().filter_map(|event| serde_json::to_value(event).ok()).collect())
    }
}

fn classify_decision(error: anyhow::Error) -> DecisionError {
    let text = error.to_string();
    if text.contains("no longer open") || text.contains("stopped waiting") || text.contains("lapsed") {
        DecisionError::NotPending
    } else {
        DecisionError::Failed(error)
    }
}

/// A wake-up flag the background loops wait on.
#[derive(Default)]
pub struct Signal {
    raised: Mutex<bool>,
    changed: Condvar,
}

impl Signal {
    pub fn raise(&self) {
        *self.raised.lock().unwrap() = true;
        self.changed.notify_all();
    }

    /// Wait until raised or `timeout`; true when raised. Clears the flag.
    pub fn wait(&self, timeout: Duration) -> bool {
        let guard = self.raised.lock().unwrap();
        let (mut guard, _) = self.changed.wait_timeout_while(guard, timeout, |raised| !*raised).unwrap();
        std::mem::take(&mut *guard)
    }
}

pub struct CloudAgents {
    pub ops: Arc<dyn AgentOps>,
    pub keys: keys::Keys,
    pub receipts: receipts::Receipts,
    pub follow_ups: receipts::FollowUps,
    /// Present when the runtime has an API to lease from and upload to.
    pub identity: Option<Identity>,
    pub api: Option<Arc<dyn api::MailboxApi>>,
    pub checkpoints: checkpoints::Checkpoints,
    sink: Option<Arc<dyn EventSink>>,
    /// Attached clients; the mailbox polls faster while any is attached.
    attached: AtomicUsize,
    pub poll: Signal,
    /// Tabs with follow-ups to try sending (their turn may have ended).
    dispatch: Mutex<Vec<String>>,
    dispatch_signal: Signal,
    generation: AtomicU64,
    /// Set while an archive waits for the final checkpoint (contract §10.3):
    /// no command is leased and no follow-up typed until it is lifted.
    quiesced: AtomicBool,
    /// Roles and tab leases, shared with the workspace RPC (PRO-30). Absent
    /// in tests without one: actors then have the role the API stamped.
    collab: OnceLock<Arc<Collaboration>>,
    dir: PathBuf,
    holders_lock: Mutex<()>,
}

/// Who was handed the current workspace content key.
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyHolders {
    key_id: String,
    users: Vec<String>,
}

impl CloudAgents {
    /// Open the state under `<dir>` (created 0700). `api` and `identity`
    /// are absent for a runtime without a cloud identity: tabs and keys
    /// still work, nothing is leased or uploaded.
    pub fn open(
        dir: &Path,
        ops: Arc<dyn AgentOps>,
        sink: Option<Arc<dyn EventSink>>,
        api: Option<(Arc<dyn api::MailboxApi>, Identity)>,
        generation: u64,
    ) -> Result<Arc<Self>> {
        crate::cloud_bootstrap::ensure_private_dir(dir)?;
        let now = now_ms();
        let (api, identity) = match api {
            Some((api, identity)) => (Some(api), Some(identity)),
            None => (None, None),
        };
        Ok(Arc::new(Self {
            ops,
            keys: keys::Keys::open(dir, now).context("open the workspace content keys")?,
            receipts: receipts::Receipts::open(dir).context("open the receipt store")?,
            follow_ups: receipts::FollowUps::open(dir).context("open the follow-up queue")?,
            identity,
            api,
            checkpoints: checkpoints::Checkpoints::open(dir, generation)?,
            sink,
            attached: AtomicUsize::new(0),
            poll: Signal::default(),
            dispatch: Mutex::new(Vec::new()),
            dispatch_signal: Signal::default(),
            generation: AtomicU64::new(generation),
            quiesced: AtomicBool::new(false),
            collab: OnceLock::new(),
            dir: dir.to_path_buf(),
            holders_lock: Mutex::new(()),
        }))
    }

    /// Use the workspace RPC's roles and leases, and keep notes next to the
    /// rest of the agent state.
    pub fn share_collaboration(&self, collab: Arc<Collaboration>) {
        collab.store_notes_in(&self.dir.join("notes"));
        let _ = self.collab.set(collab);
    }

    pub fn collab(&self) -> Option<&Arc<Collaboration>> {
        self.collab.get()
    }

    /// Record that `user` was handed the current workspace content key
    /// (`keys.get`), durably in `key-holders.json`. A new key starts a new
    /// record.
    pub fn note_key_holder(&self, user: &str) {
        let Some((key_id, _)) = self.keys.current() else { return };
        let _guard = self.holders_lock.lock().unwrap();
        let mut record = self.holders_record();
        if record.key_id != key_id {
            record = KeyHolders { key_id, users: Vec::new() };
        }
        if record.users.iter().any(|known| known == user) {
            return;
        }
        record.users.push(user.to_string());
        let path = self.dir.join("key-holders.json");
        match serde_json::to_vec(&record) {
            Ok(bytes) => {
                if let Err(error) = crate::cloud_bootstrap::write_durable(&path, &bytes) {
                    log::warn!("record who holds the workspace content key: {error:#}");
                }
            }
            Err(error) => log::warn!("record who holds the workspace content key: {error}"),
        }
    }

    /// The people the current key was handed to (across restarts).
    pub fn key_holders(&self) -> Vec<String> {
        let Some((key_id, _)) = self.keys.current() else { return Vec::new() };
        let record = self.holders_record();
        if record.key_id == key_id {
            record.users
        } else {
            Vec::new()
        }
    }

    fn holders_record(&self) -> KeyHolders {
        std::fs::read(self.dir.join("key-holders.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    /// What a mailbox actor may do now (contract §20.4-20.5).
    pub fn actor_access(&self, actor: &api::Actor) -> Access {
        let stamped = collab::stamped_access(actor.role.as_deref(), actor.can_approve);
        match self.collab.get() {
            Some(collab) => collab.actor_access(&actor.authority, &actor.user_id, stamped),
            None => stamped.unwrap_or(if actor.authority == "manage" { Access::MANAGER } else { Access::NONE }),
        }
    }

    /// Whether a queued follow-up's sender may still drive. One queued
    /// before sharing existed, or before the API listed anyone, is kept.
    fn follow_up_allowed(&self, follow_up: &FollowUp) -> bool {
        match self.collab.get() {
            Some(collab) if collab.known() && !follow_up.actor_id.is_empty() => collab.access_of(Some(&follow_up.actor_id)).can_drive(),
            _ => true,
        }
    }

    /// Drop queued follow-ups whose sender lost driver access, saying so in
    /// their transcripts (contract §20.5). False when the queue could not
    /// be rewritten.
    pub fn revalidate_follow_ups(&self) -> bool {
        let dropped = match self.follow_ups.retain(|follow_up| self.follow_up_allowed(follow_up)) {
            Ok(dropped) => dropped,
            Err(error) => {
                log::warn!("revalidate queued follow-ups: {error:#}");
                return false;
            }
        };
        for (tab_id, follow_up) in dropped {
            self.ops.note(&follow_up.session_id, &tab_id, "Dropped a queued message from a person who no longer has driver access.");
            self.changed(Some(&tab_id), true);
        }
        true
    }

    pub fn state_dir(data_dir: &Path) -> PathBuf {
        data_dir.join("cloud-agent")
    }

    /// Stop taking new work: leave commands in the mailbox and follow-ups
    /// queued. The running turn is not interrupted.
    pub fn quiesce(&self) {
        self.quiesced.store(true, Ordering::SeqCst);
    }

    /// The archive did not stop this runtime after all (it failed or was
    /// undone): take work again.
    pub fn resume_work(&self) {
        if self.quiesced.swap(false, Ordering::SeqCst) {
            self.poll.raise();
            self.dispatch_signal.raise();
        }
    }

    pub fn quiesced(&self) -> bool {
        self.quiesced.load(Ordering::SeqCst)
    }

    pub fn set_generation(&self, generation: u64) {
        self.generation.store(generation, Ordering::SeqCst);
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn client_attached(&self) {
        self.attached.fetch_add(1, Ordering::SeqCst);
        self.poll.raise();
    }

    pub fn client_detached(&self) {
        let _ = self.attached.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| count.checked_sub(1));
    }

    pub fn attached(&self) -> usize {
        self.attached.load(Ordering::SeqCst)
    }

    /// Tabs with their queued follow-ups.
    pub fn tabs(&self) -> Vec<AgentTabInfo> {
        let mut tabs = self.ops.tabs();
        for tab in &mut tabs {
            tab.follow_ups = self
                .follow_ups
                .list(&tab.tab_id)
                .into_iter()
                .map(|follow_up| FollowUpView { client_command_id: follow_up.client_command_id, text: follow_up.text, actor_id: follow_up.actor_id })
                .collect();
            if let Some(collab) = self.collab.get() {
                let busy = matches!(tab.status, TabStatus::InProgress | TabStatus::Waiting) && tab.process == "running";
                tab.lease = collab.lease(&tab.tab_id, now_ms(), busy);
            }
        }
        tabs
    }

    pub fn tab(&self, tab_id: &str) -> Option<AgentTabInfo> {
        self.tabs().into_iter().find(|tab| tab.tab_id == tab_id)
    }

    /// Something about the tabs changed: tell clients, refresh checkpoints.
    pub fn changed(&self, tab_id: Option<&str>, urgent: bool) {
        if let Some(sink) = &self.sink {
            sink.emit(TABS_CHANGED, &serde_json::json!({ "tabId": tab_id }));
        }
        if let Some(tab_id) = tab_id {
            self.checkpoints.mark(tab_id, urgent);
        }
    }

    /// Retire the current key for a new one: new checkpoints are sealed
    /// with it and connected clients are told to fetch it.
    pub fn rotate_key(&self) -> Result<String> {
        let key_id = self.keys.rotate(now_ms())?;
        if let Some(sink) = &self.sink {
            sink.emit(KEYS_CHANGED, &serde_json::json!({ "currentKeyId": key_id }));
        }
        for tab in self.tabs() {
            self.checkpoints.mark(&tab.tab_id, true);
        }
        Ok(key_id)
    }

    /// A tab's turn may have ended: send its next follow-up if so.
    pub fn nudge_follow_ups(&self, tab_id: &str) {
        let mut pending = self.dispatch.lock().unwrap();
        if !pending.iter().any(|pending| pending == tab_id) {
            pending.push(tab_id.to_string());
        }
        drop(pending);
        self.dispatch_signal.raise();
    }

    /// Send the next follow-up of each nudged tab whose turn has ended.
    /// Returns how many were sent.
    pub fn dispatch_follow_ups(&self) -> usize {
        if self.quiesced() {
            return 0;
        }
        let tabs: Vec<String> = std::mem::take(&mut *self.dispatch.lock().unwrap());
        let mut sent = 0;
        for tab_id in tabs {
            let Some(next) = self.follow_ups.list(&tab_id).into_iter().next() else { continue };
            if self.ops.busy(&next.session_id, &tab_id) {
                continue;
            }
            // Checked again right before it is typed: the sender's access
            // may have changed while it waited.
            // Never typed while it may not be; if the queue cannot be
            // rewritten it waits for the next nudge rather than spinning.
            if !self.follow_up_allowed(&next) {
                if self.revalidate_follow_ups() {
                    self.nudge_follow_ups(&tab_id);
                }
                continue;
            }
            // Taken durably before it is typed: a crash in between loses
            // the follow-up rather than sending it twice.
            match self.follow_ups.pop(&tab_id) {
                Ok(Some(follow_up)) => {
                    if let Err(error) = self.ops.send(&follow_up.session_id, &tab_id, &follow_up.text) {
                        log::warn!("send follow-up {}: {error:#}", follow_up.client_command_id);
                        self.ops.note(&follow_up.session_id, &tab_id, &format!("A queued message could not be sent: {error:#}"));
                    }
                    sent += 1;
                    self.changed(Some(&tab_id), true);
                }
                Ok(None) => {}
                Err(error) => log::warn!("take follow-up of {tab_id}: {error:#}"),
            }
        }
        sent
    }

    /// Start the background loops: follow-up dispatch, the mailbox and
    /// checkpoint uploads. Listens to the sink for turn and status changes.
    pub fn start(self: &Arc<Self>) {
        if let Some(sink) = &self.sink {
            let weak = Arc::downgrade(self);
            sink.listen(
                "tab_status",
                Box::new(move |payload| {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Status {
                        tab_id: String,
                        status: TabStatus,
                    }
                    let (Some(agents), Ok(status)) = (weak.upgrade(), serde_json::from_str::<Status>(payload)) else { return };
                    // Listeners run on the emitting thread, under the tab's
                    // lock: only queue work here.
                    // Any change may end a turn; the dispatcher checks.
                    let _ = status.status;
                    agents.nudge_follow_ups(&status.tab_id);
                    agents.changed(Some(&status.tab_id), true);
                }),
            );
            let weak = Arc::downgrade(self);
            sink.listen(
                "agent_event",
                Box::new(move |payload| {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Event {
                        tab_id: String,
                        payload: Tagged,
                    }
                    #[derive(serde::Deserialize)]
                    struct Tagged {
                        #[serde(rename = "type")]
                        kind: String,
                    }
                    let (Some(agents), Ok(event)) = (weak.upgrade(), serde_json::from_str::<Event>(payload)) else { return };
                    match event.payload.kind.as_str() {
                        "delta" | "usage_update" | "model_request_started" => {}
                        "turn_completed" | "permission_requested" | "questions_asked" | "permission_decided" => {
                            agents.checkpoints.mark(&event.tab_id, true)
                        }
                        _ => agents.checkpoints.mark(&event.tab_id, false),
                    }
                }),
            );
        }
        // Follow-ups accepted before a restart go out once their tab is idle.
        for tab_id in self.follow_ups.tabs() {
            self.nudge_follow_ups(&tab_id);
        }
        let agents = self.clone();
        let _ = std::thread::Builder::new().name("cloud-follow-ups".into()).spawn(move || loop {
            agents.dispatch_signal.wait(Duration::from_secs(5));
            agents.dispatch_follow_ups();
        });
        if self.api.is_some() {
            let agents = self.clone();
            let _ = std::thread::Builder::new().name("cloud-mailbox".into()).spawn(move || mailbox::run(&agents));
            let agents = self.clone();
            let _ = std::thread::Builder::new().name("cloud-checkpoints".into()).spawn(move || checkpoints::run(&agents));
        }
    }

    /// After a runtime restart: turns that were running died with the
    /// previous process. Say so in their transcripts instead of letting
    /// them look like they are still going.
    pub fn mark_interrupted_turns(&self, tabs: &[(String, String)]) {
        for (session_id, tab_id) in tabs {
            self.ops.note(
                session_id,
                tab_id,
                "The workspace runtime restarted and the agent process running this turn ended. \
                 Its saved conversation resumes when you send the next message.",
            );
            self.changed(Some(tab_id), true);
        }
    }
}

/// Tabs of `root` that were mid-turn when the index was last written; call
/// before `idle_orphaned_tabs` resets them.
pub fn interrupted_tabs(root: &str) -> Vec<(String, String)> {
    index::load()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.project_path == root)
        .flat_map(|entry| {
            let session_id = entry.id.clone();
            entry
                .tabs
                .into_iter()
                .filter(|tab| matches!(tab.status, TabStatus::InProgress | TabStatus::Waiting))
                .map(move |tab| (session_id.clone(), tab.id))
        })
        .collect()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}
