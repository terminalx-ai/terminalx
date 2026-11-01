//! The deliberately small paired-device application RPC.
//!
//! Hosted services only move ciphertext. This module resolves public session
//! and tab identifiers against local state on every operation, and it never
//! returns a checkout path, pane id, or process handle to the phone.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::model::{AccountMirror, DeviceProvenance};
use super::send_ids::{Reply, SendIds, SendKey, ID_REUSED, STILL_SENDING};
use crate::local_runtime::mobile::Repeat;
use super::wire::{megabytes, ReplyLimits, Transport, Wire};
use super::{DeviceEntry, DeviceScope, PairingManager};
use crate::events::{AgentEvent, Payload};
use crate::store::index::{self, SessionEntry, TabEntry};
use crate::sink::{EventSink, ListenerId};
use crate::{store, summaries};

const NOTES_LIMIT: usize = 1_000;
const NOTE_BYTES_LIMIT: usize = 16 * 1024;
const INPUT_BYTES_LIMIT: usize = 64 * 1024;
const ATTACHMENT_BYTES_LIMIT: usize = 5 * 1024 * 1024;
const ATTACHMENT_COUNT_LIMIT: usize = 8;
const NOTIFICATION_LIMIT: usize = 512;
const TAIL_EVENT_LIMIT: usize = 5_000;
// What one encrypted text frame carries on a direct connection: 6 MiB for the
// entire serialized RPC response, including its envelope. No transcript reply
// is larger on any transport; on Relay a page is held to one Relay frame.
const TAIL_RESPONSE_BYTES_LIMIT: usize = Transport::Direct.text_plaintext_limit();
/// How long a connection waits for the runtime to register or check it.
const RUNTIME_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Runtime calls block on a local socket for up to two minutes. They run on
/// the blocking pool, so a stalled runtime cannot hold the async workers that
/// Relay's control channel also runs on (#666, #661).
pub(super) async fn off_runtime<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(work).await.context("a paired-device runtime call stopped")?
}

/// `off_runtime` for a call that may be abandoned: one that changes nothing,
/// or whose result undoes itself when dropped, as a `MobileConnection` does.
async fn off_runtime_within<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::time::timeout(RUNTIME_CALL_TIMEOUT, off_runtime(work)).await.map_err(|_| {
        anyhow!(super::diagnostics::Category::LocalRuntime)
            .context(format!("The local runtime did not answer within {} s.", RUNTIME_CALL_TIMEOUT.as_secs()))
    })?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileNotification {
    seq: u64,
    epoch: String,
    title: String,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_id: Option<String>,
}

struct MobileClient {
    sender: mpsc::Sender<Value>,
    overflowed: Arc<std::sync::atomic::AtomicBool>,
}

pub(super) struct MobileRuntime {
    sink: OnceLock<Arc<dyn EventSink>>,
    clients: Mutex<HashMap<String, MobileClient>>,
    notifications: Mutex<VecDeque<MobileNotification>>,
    notification_epoch: String,
    notification_seq: std::sync::atomic::AtomicU64,
    notes: Mutex<()>,
    /// Shared by every connection: the retry of a send whose reply was lost
    /// comes over the connection that replaced the one that dropped (#675).
    send_ids: SendIds,
}

impl MobileRuntime {
    pub(super) fn new() -> Self {
        Self {
            sink: OnceLock::new(),
            clients: Mutex::new(HashMap::new()),
            notifications: Mutex::new(VecDeque::new()),
            notification_epoch: Uuid::new_v4().to_string(),
            notification_seq: std::sync::atomic::AtomicU64::new(0),
            notes: Mutex::new(()),
            send_ids: SendIds::new(),
        }
    }

    pub(super) fn configure(&self, sink: Arc<dyn EventSink>) -> Result<()> {
        self.sink
            .set(sink)
            .map_err(|_| anyhow!("mobile runtime was already configured"))
    }

    fn register_client(&self, id: &str, outbound: mpsc::Sender<Value>, overflowed: Arc<std::sync::atomic::AtomicBool>) {
        self.clients.lock().unwrap().insert(id.into(), MobileClient { sender:outbound, overflowed });
    }

    fn unregister_client(&self, id: &str) {
        self.clients.lock().unwrap().remove(id);
    }

    fn broadcast(&self, value: Value) {
        self.clients
            .lock()
            .unwrap()
            .retain(|_, client| {
                if client.sender.try_send(value.clone()).is_ok() { true } else {
                    client.overflowed.store(true,std::sync::atomic::Ordering::SeqCst);
                    false
                }
            });
    }

    pub(super) fn broadcast_sessions_changed(&self) {
        self.broadcast(json!({ "method": "sessions.changed" }));
    }

    pub(super) fn capture_agent_event(&self, manager: &PairingManager, payload: &str) {
        let Ok(event) = serde_json::from_str::<AgentEvent>(payload) else { return };
        self.broadcast(json!({ "method": "session.event", "params": { "event": event } }));
        self.broadcast_sessions_changed();
        let Payload::TurnCompleted { final_text, .. } = &event.payload else { return };
        let body = final_text
            .as_deref()
            .map(collapse_notification_text)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "An agent turn finished on your Mac.".into());
        let notification = MobileNotification {
            seq: self
                .notification_seq
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1,
            epoch: self.notification_epoch.clone(),
            title: "Agent finished".into(),
            body,
            session_id: Some(event.session_id.clone()),
            tab_id: Some(event.tab_id.clone()),
        };
        {
            let mut events = self.notifications.lock().unwrap();
            events.push_back(notification.clone());
            while events.len() > NOTIFICATION_LIMIT {
                events.pop_front();
            }
        }
        if let Some(sink) = manager.sink.get() {
            sink.emit("mobile_notification", &notification);
        }
        self.broadcast(json!({ "method": "notifications.event", "params": notification }));
    }

    fn missed_notifications(&self, epoch: Option<&str>, last_seen_seq: u64) -> Vec<MobileNotification> {
        self.notifications
            .lock()
            .unwrap()
            .iter()
            .filter(|event| epoch != Some(self.notification_epoch.as_str()) || event.seq > last_seen_seq)
            .cloned()
            .collect()
    }

}

pub(super) struct MobileConnection {
    id: String,
    owner: Arc<crate::local_runtime::desktop::Desktop>,
    actor: crate::local_runtime::mobile::Actor,
    runtime: Arc<MobileRuntime>,
    outbound: mpsc::Sender<Value>,
    wire: Wire,
    subscriptions: Mutex<HashMap<String, ListenerId>>,
    terminal_subscriptions: Mutex<HashMap<String,String>>,
    polling: std::sync::atomic::AtomicBool,
    overflowed: Arc<std::sync::atomic::AtomicBool>,
    closed: std::sync::atomic::AtomicBool,
}

impl MobileConnection {
    /// `new`, with the runtime's `register` round trip off the async workers.
    pub(super) async fn open(manager: &Arc<PairingManager>, device: &DeviceEntry, outbound: mpsc::Sender<Value>, transport: Transport) -> Result<Self> {
        let (manager, device) = (manager.clone(), device.clone());
        off_runtime_within(move || Self::new(&manager, &device, manager.mobile.clone(), outbound, transport)).await
    }

    fn new(manager: &PairingManager, device: &DeviceEntry, runtime: Arc<MobileRuntime>, outbound: mpsc::Sender<Value>, transport: Transport) -> Result<Self> {
        let id = Uuid::new_v4().to_string();
        let owner = manager.runtime.lock().unwrap().clone().context("The local runtime is unavailable.")?;
        let attachment = owner.attachment()?;
        let actor = crate::local_runtime::mobile::Actor {
            epoch: attachment.epoch, lease: attachment.lease,
            generation: manager.account.current_generation(),
            user_id: super::registry::load_account_mirror()?.map(|mirror| mirror.user_id),
        };
        owner.mobile(&actor, "register", json!({"connection":id,"deviceId":device.id}))?;
        let overflowed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        runtime.register_client(&id, outbound.clone(), overflowed.clone());
        Ok(Self {
            id, owner, actor, overflowed,
            runtime,
            outbound,
            wire: Wire::new(transport),
            subscriptions: Mutex::new(HashMap::new()),
            terminal_subscriptions: Mutex::new(HashMap::new()),
            polling: std::sync::atomic::AtomicBool::new(false),
            closed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub(super) fn wire(&self) -> &Wire {
        &self.wire
    }

    pub(super) fn check_buffer(&self) -> Result<()> {
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) || self.overflowed.load(std::sync::atomic::Ordering::SeqCst) {
            bail!("The mobile stream disconnected or fell behind. Reconnect to load retained history.");
        }
        Ok(())
    }

    pub(super) fn check(&self, manager: &PairingManager) -> Result<()> {
        self.check_current(manager)?;
        self.call("check", json!({}))?;
        Ok(())
    }

    /// `check`, with the runtime round trip off the async workers.
    pub(super) async fn check_off_runtime(self: &Arc<Self>, manager: &PairingManager) -> Result<()> {
        self.check_current(manager)?;
        let connection = self.clone();
        off_runtime_within(move || connection.call("check", json!({})).map(drop)).await
    }

    fn check_current(&self, manager: &PairingManager) -> Result<()> {
        self.check_buffer()?;
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) || self.actor.generation != manager.account.current_generation() {
            bail!("The paired-device connection or account changed.");
        }
        Ok(())
    }

    fn call(&self, method: &str, mut params: Value) -> Result<Value> {
        params.as_object_mut().context("Mobile parameters must be an object.")?.insert("connection".into(), json!(self.id));
        self.owner.mobile(&self.actor, method, params)
    }

    pub(super) fn close(&self, _manager: &PairingManager) { self.finish(); }

    fn finish(&self) {
        if self
            .closed
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        if let Some(sink) = self.runtime.sink.get() {
            for (_, listener) in self.subscriptions.lock().unwrap().drain() {
                sink.unlisten(listener);
            }
        }
        self.runtime.unregister_client(&self.id);
        let (owner, actor, id) = (self.owner.clone(), self.actor.clone(), self.id.clone());
        let close = move || {
            if owner.mobile(&actor, "close", json!({"connection": id})).is_err() { owner.disconnect(); }
        };
        // Closing runs on async workers and in Drop: keep the round trip off them (#666).
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => { runtime.spawn_blocking(close); }
            Err(_) => close(),
        }
    }

    fn stream(&self, request_id: &str, result: Value) {
        if !self.closed.load(std::sync::atomic::Ordering::SeqCst)
            && self.outbound.try_send(success_response(request_id, result)).is_err() { self.finish(); }
    }

    /// A live event, cut down when this connection cannot carry it whole: a
    /// reply it cannot carry would end the subscription (#669).
    fn stream_event(&self, request_id: &str, event: &AgentEvent) -> Result<()> {
        let envelope = serde_json::to_vec(&success_response(request_id, json!({ "event": null })))?.len();
        let event = fit_event(event, self.wire.message_limit().saturating_sub(envelope))?;
        self.stream(request_id, json!({ "event": event }));
        Ok(())
    }

    fn insert_subscription(&self, subscription_id: String, event_id: ListenerId) {
        self.subscriptions.lock().unwrap().insert(subscription_id, event_id);
    }

    fn unsubscribe(&self, subscription_id: &str) -> Result<bool> {
        if self.terminal_subscriptions.lock().unwrap().contains_key(subscription_id) {
            let result = self.call("unobserve", json!({"subscriptionId":subscription_id}))?;
            self.terminal_subscriptions.lock().unwrap().remove(subscription_id);
            return Ok(result["removed"].as_bool().unwrap_or(false));
        }
        let listener = self.subscriptions.lock().unwrap().remove(subscription_id);
        if let (Some(sink), Some(listener)) = (self.runtime.sink.get(), listener) {
            sink.unlisten(listener);
            Ok(true)
        } else { Ok(false) }
    }

    fn start_polling(self: &Arc<Self>) -> Result<()> {
        if self.polling.swap(true,std::sync::atomic::Ordering::SeqCst) { return Ok(()); }
        let weak = Arc::downgrade(self);
        let spawned = std::thread::Builder::new().name("mobile-output".into()).spawn(move || loop {
            let Some(connection) = weak.upgrade() else { return };
            if connection.closed.load(std::sync::atomic::Ordering::SeqCst) { return; }
            if !connection.terminal_subscriptions.lock().unwrap().is_empty() {
                match connection.call("output",json!({})) {
                    Ok(packets) => {
                        for packet in packets.as_array().into_iter().flatten() {
                            let request = connection.terminal_subscriptions.lock().unwrap()
                                .get(packet["subscriptionId"].as_str().unwrap_or_default()).cloned();
                            if let Some(request) = request {
                                connection.stream(&request,json!({"type":"data","chunk":packet["text"]}));
                            }
                        }
                    }
                    Err(error) => {
                        let _ = connection.outbound.try_send(json!({"method":"terminal.closed","params":{"message":error.to_string()}}));
                        connection.finish();
                        return;
                    }
                }
            }
            drop(connection);
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        if let Err(error) = spawned {
            self.polling.store(false,std::sync::atomic::Ordering::SeqCst);
            self.finish();
            return Err(error.into());
        }
        Ok(())
    }

}

impl Drop for MobileConnection {
    fn drop(&mut self) { self.finish(); }
}

/// Synchronous throughout: callers run it with `off_runtime`.
pub(super) fn dispatch(
    manager: &PairingManager,
    connection: &Arc<MobileConnection>,
    request: &Value,
    device: &DeviceEntry,
) -> Option<Result<Value>> {
    if let Err(error) = connection.check(manager) { return Some(Err(error)); }
    let method = request.get("method")?.as_str()?;
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let sink = manager.sink.get().cloned();
    let result = match method {
        "sync.capabilities" => no_params(&params).map(|_| capabilities()),
        "transport.negotiate" => parse_params(params).map(|params| negotiate(connection, params)),
        "sessions.summaries" => parse_params(params).and_then(|params: ConditionalParams| conditional(session_summaries()?, params.version)),
        "session.sync" => parse_params(params).and_then(|params| session_sync(connection, request_id(request), params)),
        "session.tail" => parse_params(params).and_then(|params| session_tail(connection, request_id(request), params)),
        "session.subscribe" => sink
            .as_ref()
            .context("app is unavailable")
            .and_then(|sink| parse_params(params).and_then(|params| subscribe_session(&**sink, connection, request_id(request), params))),
        "session.unsubscribe" | "terminal.unsubscribe" | "notifications.unsubscribe" => {
            parse_params(params).and_then(|params: UnsubscribeParams| Ok(json!({ "removed": connection.unsubscribe(&params.subscription_id)? })))
        }
        "session.send" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| send_session(manager, connection, params)))
        }
        "permission.respond" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| respond_permission(connection, params)))
        }
        "chat.list" => parse_params(params).and_then(|params| list_notes(manager, params)),
        "chat.post" => parse_params(params).and_then(|params| post_note(manager, device, params)),
        "chat.promoteToAgent" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| promote_notes(manager, connection, params)))
        }
        "terminal.read" => parse_params(params).and_then(|params| read_terminal(connection, params)),
        "terminal.subscribe" => parse_params(params).and_then(|params| subscribe_terminal(connection, request_id(request), params)),
        "steerLease.queueInput" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| queue_input(connection, params)))
        }
        "steerLease.release" => parse_params(params).and_then(|params| release_input(connection, params)),
        "notifications.missedSince" => parse_params(params).map(|params| missed_notifications(manager, params)),
        "notifications.subscribe" => sink
            .as_ref()
            .context("app is unavailable")
            .and_then(|sink| no_params(&params).and_then(|_| subscribe_notifications(&**sink, connection, request_id(request)))),
        _ => return None,
    };
    Some(result)
}

/// What this Mac understands beyond the first phone protocol. A phone sends
/// a field only to a Mac that names it here: every params type refuses
/// fields it does not know.
fn capabilities() -> Value {
    // `sendIds`: `session.send` and `chat.post` take a `clientMessageId` (#675).
    json!({ "transcript": 1, "conditionalLists": 1, "sendIds": 1 })
}

fn request_id(request: &Value) -> &str {
    request.get("id").and_then(Value::as_str).unwrap_or("")
}

pub(super) fn success_response(id: &str, result: Value) -> Value {
    json!({ "id": id, "ok": true, "result": result, "_meta": { "runtimeId": "desktop" } })
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).context("invalid paired-device RPC params")
}

fn no_params(params: &Value) -> Result<()> {
    if params.as_object().is_some_and(serde_json::Map::is_empty) {
        Ok(())
    } else {
        bail!("this method accepts no params")
    }
}

fn require_driver(device: &DeviceEntry) -> Result<()> {
    if device.scope == DeviceScope::Driver {
        Ok(())
    } else {
        bail!("this paired device is read-only")
    }
}

/// The group a paired phone files quick chats under.
const QUICK_CHATS_PROJECT: &str = "Quick chats";

fn session_summaries() -> Result<Value> {
    let snippets: HashMap<_, _> = summaries::collect(None)?
        .into_iter()
        .map(|summary| (summary.session_id.clone(), summary))
        .collect();
    let mut sessions = Vec::new();
    for session in store::conversation_titles::backfill()?.into_iter().filter(|session| !session.archived) {
        let summary = snippets.get(&session.id);
        // A quick chat has no project: its path is a scratch directory named
        // for the session, which would give the phone one group per chat.
        let quick = session.is_quick();
        let project = if quick { QUICK_CHATS_PROJECT.to_string() } else { file_name(&session.project_path) };
        let worktree = if quick && store::quick::is_scratch(&session.id, &session.cwd) {
            "scratch".to_string()
        } else {
            session
                .worktree_name
                .clone()
                .or_else(|| session.branch.clone())
                .unwrap_or_else(|| file_name(&session.cwd))
        };
        sessions.push(json!({
            "id": session.id,
            "kind": if quick { "quick" } else { "project" },
            "title": session.title,
            "project": project,
            "worktree": worktree,
            "modified": summary.map(|row| row.updated_at.clone()).unwrap_or(session.modified),
            "lastPrompt": summary.and_then(|row| row.last_prompt.clone()),
            "lastReply": summary.and_then(|row| row.last_reply.clone()),
            "issueRef": session.issue.as_ref().map(|issue| issue.identifier.clone()),
            "tabs": session.tabs.into_iter().map(|tab| json!({
                "id": tab.id,
                "title": tab.title,
                "harness": tab.harness,
                "status": tab.status,
            })).collect::<Vec<_>>(),
        }));
    }
    sessions.sort_by(|left, right| {
        right
            .get("modified")
            .and_then(Value::as_str)
            .cmp(&left.get("modified").and_then(Value::as_str))
    });
    Ok(json!({ "sessions": sessions }))
}

/// What the phone's end of the connection can do (#669). Unknown fields are
/// ignored: a phone newer than this desktop may offer more than it knows.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NegotiateParams {
    #[serde(default)]
    fragments: Option<u64>,
}

fn negotiate(connection: &MobileConnection, params: NegotiateParams) -> Value {
    if connection.wire.negotiate(params.fragments) {
        json!({ "fragments": super::wire::FRAGMENTS_VERSION })
    } else {
        json!({})
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Project")
        .into()
}

// A content checkpoint, not a maximum event sequence: rewrites, reconciliation,
// truncation and replacement logs must never silently keep stale cached events.
const SYNC_PAGE_EVENTS: usize = 500;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncCursor {
    offset: usize,
    digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSyncParams {
    session_id: String,
    tab_id: String,
    cursor: Option<SyncCursor>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConditionalParams {
    version: Option<String>,
}

fn conditional(mut value: Value, previous: Option<String>) -> Result<Value> {
    let version = format!("{:x}", Sha256::digest(serde_json::to_vec(&value)?));
    if previous.as_deref() == Some(&version) {
        return Ok(json!({ "notModified": true, "version": version }));
    }
    value["version"] = json!(version);
    Ok(value)
}

fn session_sync(connection: &MobileConnection, request_id: &str, params: SessionSyncParams) -> Result<Value> {
    // Read errors are not deletions. Only an authoritative index absence clears
    // the phone's copy.
    let present = index::load()?.iter().any(|session|
        session.id == params.session_id && session.tab(&params.tab_id).is_some());
    if !present {
        return Ok(json!({ "deleted": true }));
    }
    let path = store::log_path(&params.session_id, &params.tab_id)?;
    connection.call("reconcile", json!({"sessionId":params.session_id,"tabId":params.tab_id}))?;
    // Reconciliation publishes to the log. Read canonical file order again:
    // another publisher may have appended between the first read and publish.
    let events: Vec<AgentEvent> = store::read_lines(&path)?;
    let limits = connection.wire.reply_limits(TAIL_RESPONSE_BYTES_LIMIT);
    sync_page(&events, params.cursor.as_ref(), &params.session_id, &params.tab_id, request_id, limits)
}

fn sync_page(events: &[AgentEvent], cursor: Option<&SyncCursor>, session: &str, tab: &str, request_id: &str, limits: ReplyLimits) -> Result<Value> {
    // Hash canonical records with explicit boundaries, including conversation
    // identity and protocol generation. Stable across desktop restarts.
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&(1, session, tab))?);
    let offset = cursor.map_or(0, |c| c.offset);
    for event in events.iter().take(offset) {
        hash.update(serde_json::to_vec(event)?);
        hash.update(b"\n");
    }
    let valid = cursor.is_some_and(|c| c.offset <= events.len()
        && c.digest == format!("{:x}", hash.clone().finalize()));
    let mut start = if valid { offset } else {
        let mut start = events.len();
        let mut turns = 0;
        for event in events.iter().rev().take(SYNC_PAGE_EVENTS) {
            start -= 1;
            if matches!(event.payload, Payload::UserMessage { .. }) { turns += 1; }
            if turns == 20 { break; }
        }
        start
    };
    // Count the escaped request id and worst-case sync metadata too. The
    // largest possible offset is the log length, and false is longer than true.
    let envelope = success_response(request_id, json!({
        "events": [], "reset": false, "hasMore": false, "hasEarlier": false,
        "cursor": SyncCursor { offset: events.len(), digest: "0".repeat(64) },
    }));
    let envelope = serde_json::to_vec(&envelope)?.len();
    let budget = limits.page.checked_sub(envelope).context("transcript request envelope is too large")?;
    let single = limits.single.checked_sub(envelope).context("transcript request envelope is too large")?;
    let end = if valid {
        start + sync_event_count(events[start..].iter().take(SYNC_PAGE_EVENTS), budget)?
    } else {
        // A reset is a recent contiguous suffix; forward pages are prefixes of
        // the remaining records. Neither direction can skip an oversized event:
        // it is sent alone, and cut down to fit if it must be.
        start = events.len() - sync_event_count(events[start..].iter().rev(), budget)?;
        events.len()
    };
    if !valid {
        hash = Sha256::new();
        hash.update(serde_json::to_vec(&(1, session, tab))?);
        for event in events.iter().take(start) {
            hash.update(serde_json::to_vec(event)?);
            hash.update(b"\n");
        }
    }
    for event in &events[start..end] {
        hash.update(serde_json::to_vec(event)?);
        hash.update(b"\n");
    }
    let page = events[start..end].iter().map(|event| fit_event(event, single)).collect::<Result<Vec<_>>>()?;
    Ok(json!({
        "events": page, "reset": !valid,
        "cursor": SyncCursor { offset: end, digest: format!("{:x}", hash.finalize()) },
        "hasMore": end < events.len(), "hasEarlier": start > 0,
    }))
}

/// How many of `events` fill a page. The first is always taken: one larger
/// than a page on its own is the whole page.
fn sync_event_count<'a>(events: impl Iterator<Item = &'a AgentEvent>, budget: usize) -> Result<usize> {
    let mut count = 0;
    let mut bytes = 0;
    for event in events {
        let size = serde_json::to_vec(event)?.len() + usize::from(count > 0);
        if count > 0 && bytes + size > budget {
            break;
        }
        bytes += size;
        count += 1;
    }
    Ok(count)
}

/// The note that ends a string cut short to fit.
fn cut_note(omitted: usize) -> String {
    format!("\n\n[Too large to show on mobile: {} not shown. Open this conversation on your Mac to see all of it.]", megabytes(omitted))
}

/// An event as JSON of at most `budget` bytes (#669). In one that is larger,
/// the longest strings are cut short, longest first, each ending in a note of
/// what is missing. Everything else about the event is kept, so the phone
/// still pairs a tool's result with its call. One made of many small parts
/// becomes a status line saying it is too large.
fn fit_event(event: &AgentEvent, budget: usize) -> Result<Value> {
    let mut value = serde_json::to_value(event)?;
    let size = serde_json::to_vec(&value)?.len();
    if size <= budget {
        return Ok(value);
    }
    // No cut omits more than the whole event, so no note is longer than this.
    let note = json_escaped_len(&cut_note(size));
    let mut excess = size - budget;
    {
        let mut strings = Vec::new();
        if let Some(payload) = value.get_mut("payload") {
            strings_mut(payload, &mut strings);
        }
        let mut strings: Vec<_> = strings.into_iter().map(|text| (json_escaped_len(text), text)).collect();
        strings.sort_by_key(|(length, _)| std::cmp::Reverse(*length));
        for (length, text) in strings {
            if excess == 0 || length <= note {
                break;
            }
            let keep = length.saturating_sub(excess + note);
            excess = excess.saturating_sub(length - keep - note);
            let end = escaped_prefix_end(text, keep);
            let omitted = text.len() - end;
            text.truncate(end);
            text.push_str(&cut_note(omitted));
        }
    }
    if excess > 0 || serde_json::to_vec(&value)?.len() > budget {
        value["payload"] = json!({
            "type": "status",
            "text": format!("This item is too large to show on mobile ({}). Open this conversation on your Mac to see it.", megabytes(size)),
        });
    }
    Ok(value)
}

fn strings_mut<'a>(value: &'a mut Value, found: &mut Vec<&'a mut String>) {
    match value {
        Value::String(text) => found.push(text),
        Value::Array(items) => items.iter_mut().for_each(|item| strings_mut(item, found)),
        Value::Object(fields) => fields.values_mut().for_each(|item| strings_mut(item, found)),
        _ => {}
    }
}

/// The bytes `c` takes inside a JSON string, as serde_json writes it.
fn escaped_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
        '\0'..='\u{1f}' => 6,
        c => c.len_utf8(),
    }
}

fn json_escaped_len(text: &str) -> usize {
    text.chars().map(escaped_len).sum()
}

/// Where the longest prefix of `text` that escapes to at most `limit` bytes ends.
fn escaped_prefix_end(text: &str, limit: usize) -> usize {
    let mut used = 0;
    for (index, c) in text.char_indices() {
        used += escaped_len(c);
        if used > limit {
            return index;
        }
    }
    text.len()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionTailParams {
    session_id: String,
    tab_id: String,
    #[serde(default)]
    before: Option<u64>,
    limit: usize,
}

fn session_tail(connection: &MobileConnection, request_id: &str, params: SessionTailParams) -> Result<Value> {
    validate_session_tab(&params.session_id, &params.tab_id)?;
    if !(1..=20).contains(&params.limit) {
        bail!("tail limit must be between 1 and 20 turns");
    }
    let path = store::log_path(&params.session_id, &params.tab_id)?;
    let limits = connection.wire.reply_limits(TAIL_RESPONSE_BYTES_LIMIT);
    let byte_limit = tail_event_byte_limit(request_id, limits.page)?;
    let single = tail_event_byte_limit(request_id, limits.single)?;
    if params.before.is_none() {
        connection.call("reconcile", json!({"sessionId":params.session_id,"tabId":params.tab_id}))?;
    }
    let (events, has_more) = read_event_tail(&path, params.before, params.limit, byte_limit)?;
    let events = events.iter().map(|event| fit_event(event, single)).collect::<Result<Vec<_>>>()?;
    Ok(json!({ "events": events, "hasMore": has_more }))
}

fn tail_event_byte_limit(request_id: &str, response_limit: usize) -> Result<usize> {
    // `false` is longer than `true`; count the request id after JSON escaping too.
    let envelope = success_response(request_id, json!({ "events": [], "hasMore": false }));
    response_limit.checked_sub(serde_json::to_vec(&envelope)?.len())
        .context("transcript request envelope is too large")
}

fn read_event_tail(path: &Path, before: Option<u64>, turn_limit: usize, byte_limit: usize) -> Result<(Vec<AgentEvent>, bool)> {
    let mut lines = match summaries::TailLines::open_unbounded(path) {
        Ok(lines) => lines,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(error) => return Err(error.into()),
    };
    select_event_tail(std::iter::from_fn(|| next_tail_event(&mut lines).transpose()), before, turn_limit, byte_limit)
}

/// Read newest first and return a contiguous suffix in sequence order. Limits may split a turn;
/// the first returned sequence remains the exclusive `before` cursor for the
/// next page. Never skip an event to make a page fit: one larger than a page
/// on its own is the whole page, for the caller to cut down if it must.
fn select_event_tail(
    source: impl IntoIterator<Item = Result<AgentEvent>>,
    before: Option<u64>,
    turn_limit: usize,
    byte_limit: usize,
) -> Result<(Vec<AgentEvent>, bool)> {
    let mut events = Vec::new();
    let mut turns = 0usize;
    let mut has_more = false;
    let mut bytes = 0usize;
    for event in source {
        let event = event?;
        if before.is_some_and(|before| event.seq >= before) {
            continue;
        }
        if turns >= turn_limit || events.len() >= TAIL_EVENT_LIMIT {
            has_more = true;
            break;
        }
        let event_bytes = serde_json::to_vec(&event)?.len() + usize::from(!events.is_empty());
        if !events.is_empty() && bytes + event_bytes > byte_limit {
            has_more = true;
            break;
        }
        bytes += event_bytes;
        let is_prompt = matches!(event.payload, Payload::UserMessage { .. });
        events.push(event);
        if is_prompt {
            turns += 1;
        }
    }
    events.reverse();
    Ok((events, has_more))
}

fn next_tail_event(lines: &mut summaries::TailLines) -> Result<Option<AgentEvent>> {
    loop {
        let Some(line) = lines.next_line()? else { return Ok(None) };
        if let Ok(event) = serde_json::from_str(&line) {
            return Ok(Some(event));
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSubscribeParams {
    tab_id: String,
}

fn subscribe_session(
    sink: &dyn EventSink,
    connection: &Arc<MobileConnection>,
    request_id: &str,
    params: SessionSubscribeParams,
) -> Result<Value> {
    let (session, _) = find_tab(&params.tab_id)?;
    let subscription_id = Uuid::new_v4().to_string();
    let stream = Arc::downgrade(connection);
    let response_id = request_id.to_string();
    let session_id = session.id;
    let tab_id = params.tab_id;
    let listener = sink.listen(
        "agent_event",
        Box::new(move |payload| {
            let Ok(event) = serde_json::from_str::<AgentEvent>(payload) else { return };
            if event.session_id == session_id && event.tab_id == tab_id {
                if let Some(stream) = stream.upgrade() {
                    let _ = stream.stream_event(&response_id, &event);
                }
            }
        }),
    );
    connection.insert_subscription(subscription_id.clone(), listener);
    Ok(json!({ "subscriptionId": subscription_id }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnsubscribeParams {
    subscription_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteAttachmentInput {
    media_type: String,
    data: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSendParams {
    tab_id: String,
    text: String,
    #[serde(default)]
    attachments: Vec<RemoteAttachmentInput>,
    /// The phone's id for this draft; sent only to a Mac with `sendIds` (#675).
    #[serde(default)]
    client_message_id: Option<String>,
}

fn send_session(manager: &PairingManager, connection: &MobileConnection, params: SessionSendParams) -> Result<Value> {
    send_once(&manager.mobile.send_ids, params, |tab_id, text, attachments, message| {
        let (session, _) = find_tab(tab_id)?;
        send_attributed(connection, &session.id, tab_id, text, attachments, message)
    })
}

/// A phone's send, once per message id (#675). `owner_send` is the
/// runtime's send, given the id too: a queued send is answered by the
/// runtime on every repeat, since only it knows where that copy is.
fn send_once(
    ids: &SendIds,
    params: SessionSendParams,
    owner_send: impl FnOnce(&str, &str, Vec<RemoteAttachmentInput>, Option<&str>) -> Result<OwnerSend>,
) -> Result<Value> {
    let SessionSendParams { tab_id, text, attachments, client_message_id } = params;
    let Some(id) = checked_message_id(client_message_id)? else {
        return Ok(settle(owner_send(&tab_id, &text, attachments, None)?)?.into_value());
    };
    let digest = send_digest(&text, &attachments);
    let key = SendKey { tab_id: tab_id.clone(), client_message_id: id.clone() };
    ids.once(key, digest, || settle(owner_send(&tab_id, &text, attachments, Some(&id))?))
}

/// The phone's reply to what the runtime made of a send.
fn settle(sent: OwnerSend) -> Result<Reply> {
    // The first copy is being typed to the agent right now. The draft keeps
    // its id, so the next try learns whether it arrived.
    if sent.repeat == Some(Repeat::Delivering) {
        bail!(STILL_SENDING);
    }
    let reply = json!({ "status": "sent", "queued": sent.outcome.queued });
    // A queued copy is dropped if the connection it came over closes before
    // the agent's turn ends, and that is the connection whose drop lost this
    // reply. So a queued reply answers no repeat: each goes to the runtime,
    // which delivers, re-queues or reports that copy instead of adding one.
    Ok(if sent.outcome.queued { Reply::Unsettled(reply) } else { Reply::Settled(reply) })
}

/// The runtime's answer to a send: its outcome and, for a phone message sent
/// again, what it found of the first copy (#675). An older runtime ignores the
/// id and never reports `repeat`; its outcome reads as it always has.
#[derive(Deserialize)]
struct OwnerSend {
    #[serde(flatten)]
    outcome: crate::session::SendOutcome,
    #[serde(default)]
    repeat: Option<Repeat>,
}

/// The id a phone gave a message (#675): a UUID, held to what fits a key.
fn checked_message_id(id: Option<String>) -> Result<Option<String>> {
    match id {
        Some(id) if !(8..=128).contains(&id.len()) || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') => {
            bail!("invalid client message id")
        }
        id => Ok(id),
    }
}

/// What a send carries, as the agent gets it: trimmed text and every
/// attachment whole. Equal for a repeat, different for any edit.
fn send_digest(text: &str, attachments: &[RemoteAttachmentInput]) -> String {
    let attachments: Vec<_> = attachments
        .iter()
        .map(|attachment| json!([attachment.media_type, attachment.name, attachment.data]))
        .collect();
    let canonical = serde_json::to_vec(&json!([text.trim(), attachments])).expect("a JSON value serializes");
    format!("{:x}", Sha256::digest(canonical))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionRespondParams {
    session_id: String,
    tab_id: String,
    request_id: String,
    option_id: String,
}

fn respond_permission(connection: &MobileConnection, params: PermissionRespondParams) -> Result<Value> {
    connection.call("permission", json!({"sessionId":params.session_id,"tabId":params.tab_id,
        "requestId":params.request_id,"optionId":params.option_id}))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatNote {
    id: String,
    body: String,
    created_at: i64,
    author: NoteAuthor,
    /// The agent messages this note was sent as, one per tab (#541). That
    /// tab's transcript shows the text as its user message, so a client
    /// leaves the note out of that tab's conversation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    promoted_to: Vec<NotePromotion>,
    /// The phone's id for the draft this note was posted from (#675). The
    /// same draft posted again finds this note instead of adding another.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotePromotion {
    tab_id: String,
    /// The `seq` of the tab's `UserMessage` that carried the note.
    seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteAuthor {
    user_id: String,
    display_name: String,
}

#[derive(Default, Serialize, Deserialize)]
struct NotesFile {
    #[serde(default)]
    sessions: HashMap<String, Vec<ChatNote>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatListParams {
    version: Option<String>,
    worktree_id: String,
    limit: usize,
}

fn list_notes(manager: &PairingManager, params: ChatListParams) -> Result<Value> {
    index::get(&params.worktree_id)?;
    if !(1..=100).contains(&params.limit) {
        bail!("chat limit must be between 1 and 100");
    }
    let _guard = manager.mobile.notes.lock().unwrap();
    let mut notes = load_notes()?
        .sessions
        .remove(&params.worktree_id)
        .unwrap_or_default();
    if notes.len() > params.limit {
        notes.drain(..notes.len() - params.limit);
    }
    conditional(json!({ "messages": notes }), params.version)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatPostParams {
    worktree_id: String,
    body: String,
    /// The phone's id for this draft; sent only to a Mac with `sendIds` (#675).
    #[serde(default)]
    client_message_id: Option<String>,
}

fn post_note(manager: &PairingManager, device: &DeviceEntry, params: ChatPostParams) -> Result<Value> {
    index::get(&params.worktree_id)?;
    let body = validate_note(&params.body)?;
    let client_message_id = checked_message_id(params.client_message_id)?;
    let author = effective_user(device)?;
    let note = ChatNote {
        id: Uuid::now_v7().to_string(),
        body,
        created_at: Utc::now().timestamp_millis(),
        author,
        promoted_to: Vec::new(),
        client_message_id,
    };
    let (note, added) = add_note(&manager.mobile.notes, &params.worktree_id, note)?;
    if added {
        manager.mobile.broadcast(json!({
            "method": "chat.changed",
            "params": { "worktreeId": params.worktree_id },
        }));
    }
    Ok(json!({ "status": "sent", "message": note }))
}

/// Add `note` to its worktree's notes, unless its draft was already posted
/// (#675): then that note, and false. Looked up under the same lock that
/// adds notes, so two tries of one draft cannot both miss each other.
fn add_note(lock: &Mutex<()>, worktree_id: &str, note: ChatNote) -> Result<(ChatNote, bool)> {
    let _guard = lock.lock().unwrap();
    let mut file = load_notes()?;
    let notes = file.sessions.entry(worktree_id.to_string()).or_default();
    if let Some(earlier) = posted_before(notes, &note)? {
        return Ok((earlier.clone(), false));
    }
    notes.push(note.clone());
    if notes.len() > NOTES_LIMIT {
        notes.drain(..notes.len() - NOTES_LIMIT);
    }
    save_notes(&file)?;
    Ok((note, true))
}

/// The note this draft was already posted as, if it was (#675): returned as
/// it is now, promotions included, as if the first reply had arrived. The id
/// with other text is refused rather than answered with the wrong note.
fn posted_before<'a>(notes: &'a [ChatNote], note: &ChatNote) -> Result<Option<&'a ChatNote>> {
    let Some(id) = &note.client_message_id else { return Ok(None) };
    let Some(earlier) = notes.iter().find(|earlier| earlier.client_message_id.as_ref() == Some(id)) else {
        return Ok(None);
    };
    if earlier.body != note.body {
        bail!(ID_REUSED);
    }
    Ok(Some(earlier))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatPromoteParams {
    worktree_id: String,
    tab_id: String,
    message_ids: Vec<String>,
    #[serde(default)]
    attachments: Vec<RemoteAttachmentInput>,
}

fn promote_notes(manager: &PairingManager, connection: &MobileConnection, params: ChatPromoteParams) -> Result<Value> {
    validate_session_tab(&params.worktree_id, &params.tab_id)?;
    if params.message_ids.is_empty() || params.message_ids.len() > 20 {
        bail!("promotion must name between 1 and 20 notes");
    }
    let wanted: HashSet<_> = params.message_ids.iter().collect();
    if wanted.len() != params.message_ids.len() {
        bail!("promotion contains duplicate note ids");
    }
    let _guard = manager.mobile.notes.lock().unwrap();
    let file = load_notes()?;
    let notes = file.sessions.get(&params.worktree_id).cloned().unwrap_or_default();
    let by_id: HashMap<_, _> = notes.into_iter().map(|note| (note.id.clone(), note)).collect();
    let mut text = Vec::new();
    for id in &params.message_ids {
        let note = by_id.get(id).ok_or_else(|| anyhow!("note no longer exists"))?;
        text.push(note.body.clone());
    }
    drop(_guard);
    let outcome = send_attributed(connection, &params.worktree_id, &params.tab_id, &text.join("\n\n"), params.attachments, None)?.outcome;
    let message = outcome.events.iter().find(|event| matches!(event.payload, Payload::UserMessage { .. }));
    if let Some(message) = message {
        let promotion = NotePromotion { tab_id: params.tab_id.clone(), seq: message.seq };
        // The agent has the message now. Failing to record that must not
        // read as a failed send, or the phone would offer to send it again.
        match record_promotion(manager, &params.worktree_id, &wanted, &promotion) {
            Ok(true) => manager.mobile.broadcast(json!({
                "method": "chat.changed",
                "params": { "worktreeId": params.worktree_id },
            })),
            Ok(false) => {}
            Err(error) => log::warn!("record note promotion for {}: {error:#}", params.worktree_id),
        }
    }
    Ok(json!({ "status": "sent", "queued": outcome.queued }))
}

fn record_promotion(manager: &PairingManager, worktree_id: &str, ids: &HashSet<&String>, promotion: &NotePromotion) -> Result<bool> {
    let _guard = manager.mobile.notes.lock().unwrap();
    let mut file = load_notes()?;
    let Some(notes) = file.sessions.get_mut(worktree_id) else { return Ok(false) };
    if !mark_promoted(notes, ids, promotion) {
        return Ok(false);
    }
    save_notes(&file)?;
    Ok(true)
}

/// Note on each of `ids` that it went to the agent as `promotion`, replacing
/// an earlier promotion to the same tab so the list stays one per tab. A
/// note trimmed away while the message was sent is skipped.
fn mark_promoted(notes: &mut [ChatNote], ids: &HashSet<&String>, promotion: &NotePromotion) -> bool {
    let mut changed = false;
    for note in notes.iter_mut().filter(|note| ids.contains(&note.id)) {
        note.promoted_to.retain(|earlier| earlier.tab_id != promotion.tab_id);
        note.promoted_to.push(promotion.clone());
        changed = true;
    }
    changed
}

fn send_attributed(
    connection: &MobileConnection,
    session_id: &str,
    tab_id: &str,
    text: &str,
    attachments: Vec<RemoteAttachmentInput>,
    message: Option<&str>,
) -> Result<OwnerSend> {
    validate_session_tab(session_id, tab_id)?;
    let text = text.trim();
    if text.is_empty() && attachments.is_empty() {
        bail!("message must contain text or an attachment");
    }
    if !text.is_empty() {
        validate_note(text)?;
    }
    let (images, paths) = prepare_attachments(session_id, attachments)?;
    let mut prompt = text.to_string();
    for path in paths {
        if !prompt.is_empty() {
            prompt.push(' ');
        }
        prompt.push('@');
        prompt.push_str(&path);
    }
    let mut params = json!({"sessionId":session_id,"tabId":tab_id,"text":text,"prompt":prompt,"images":images});
    if let Some(message) = message {
        params["clientMessageId"] = json!(message);
    }
    serde_json::from_value(connection.call("send", params)?).context("Invalid owner send result")
}

fn prepare_attachments(session_id: &str, attachments: Vec<RemoteAttachmentInput>) -> Result<(Vec<crate::session::ImageInput>, Vec<String>)> {
    let decoded = validate_attachment_payloads(&attachments)?;
    let mut images = Vec::new();
    let mut paths = Vec::new();
    for (attachment, bytes) in attachments.into_iter().zip(decoded) {
        if matches!(attachment.media_type.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
            images.push(crate::session::ImageInput { media_type: attachment.media_type, data: attachment.data, name: attachment.name });
            continue;
        }
        let name = safe_attachment_name(attachment.name.as_deref());
        let path = store::attachments_dir(session_id)?.join(format!("{}-{name}", Uuid::now_v7()));
        std::fs::write(&path, bytes)?;
        paths.push(path.to_string_lossy().into_owned());
    }
    Ok((images, paths))
}

fn validate_attachment_payloads(attachments: &[RemoteAttachmentInput]) -> Result<Vec<Vec<u8>>> {
    if attachments.len() > ATTACHMENT_COUNT_LIMIT {
        bail!("a message may contain at most {ATTACHMENT_COUNT_LIMIT} attachments");
    }
    let mut total = 0usize;
    let mut decoded = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        if attachment.media_type.is_empty() || attachment.media_type.len() > 127 || !attachment.media_type.is_ascii() {
            bail!("invalid attachment type");
        }
        if attachment.name.as_ref().is_some_and(|name| name.len() > 255) {
            bail!("attachment name is too long");
        }
        let bytes = general_purpose::STANDARD
            .decode(&attachment.data)
            .context("attachment is not valid base64")?;
        total = total.checked_add(bytes.len()).context("attachment size overflow")?;
        if total > ATTACHMENT_BYTES_LIMIT {
            bail!("attachments may total at most 5 MB");
        }
        decoded.push(bytes);
    }
    Ok(decoded)
}

fn safe_attachment_name(name: Option<&str>) -> String {
    let name = name
        .and_then(|name| Path::new(name).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("attachment");
    name.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') { ch } else { '_' })
        .collect()
}

fn validate_note(body: &str) -> Result<String> {
    let body = body.trim();
    if body.is_empty() || body.len() > NOTE_BYTES_LIMIT {
        bail!("message must contain 1 to {NOTE_BYTES_LIMIT} bytes");
    }
    Ok(body.into())
}

fn effective_user(device: &DeviceEntry) -> Result<NoteAuthor> {
    effective_user_from_mirror(device, super::registry::load_account_mirror()?)
}

fn effective_user_from_mirror(device: &DeviceEntry, mirror: Option<AccountMirror>) -> Result<NoteAuthor> {
    let Some(mirror) = mirror else {
        if device.provenance != DeviceProvenance::Explicit || device.bound_user_id.is_some() {
            bail!("host identity is unavailable");
        }
        return Ok(NoteAuthor {
            user_id: device.id.clone(),
            display_name: if device.label.trim().is_empty() {
                "Paired mobile device".into()
            } else {
                device.label.clone()
            },
        });
    };
    if device
        .bound_user_id
        .as_ref()
        .is_some_and(|user_id| user_id != &mirror.user_id)
    {
        bail!("paired-device identity no longer matches the host");
    }
    Ok(NoteAuthor {
        user_id: mirror.user_id,
        display_name: if mirror.display_name.trim().is_empty() {
            mirror.email
        } else {
            mirror.display_name
        },
    })
}

fn notes_path() -> Result<std::path::PathBuf> {
    Ok(store::root()?.join("mobile-notes.json"))
}

fn load_notes() -> Result<NotesFile> {
    Ok(store::read_json(&notes_path()?)?.unwrap_or_default())
}

fn save_notes(file: &NotesFile) -> Result<()> {
    store::write_json(&notes_path()?, file)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalParams {
    worktree_id: String,
    tab_id: String,
}

fn read_terminal(connection: &MobileConnection, params: TerminalParams) -> Result<Value> {
    connection.call("terminalRead", json!({"sessionId":params.worktree_id,"tabId":params.tab_id}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalSubscribeParams {
    worktree_id: String,
    tab_id: String,
    attach_mode: String,
    client: Value,
    capabilities: Value,
}

fn subscribe_terminal(connection: &Arc<MobileConnection>, request_id: &str, params: TerminalSubscribeParams) -> Result<Value> {
    let result = connection.call("observe",json!({"sessionId":params.worktree_id,"tabId":params.tab_id,
        "attachMode":params.attach_mode,"client":params.client,"capabilities":params.capabilities}))?;
    let id = result["subscriptionId"].as_str().context("Owner returned no terminal subscription.")?.to_string();
    connection.terminal_subscriptions.lock().unwrap().insert(id,request_id.into());
    connection.start_polling()?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueInputParams {
    worktree_id: String,
    tab_id: String,
    text: String,
}

fn queue_input(connection: &MobileConnection, params: QueueInputParams) -> Result<Value> {
    if params.text.is_empty() || params.text.len() > INPUT_BYTES_LIMIT { bail!("terminal input must contain 1 to {INPUT_BYTES_LIMIT} bytes"); }
    connection.call("input",json!({"sessionId":params.worktree_id,"tabId":params.tab_id,"text":params.text}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseInputParams {
    worktree_id: String,
    tab_id: String,
}

fn release_input(connection: &MobileConnection, params: ReleaseInputParams) -> Result<Value> {
    connection.call("release",json!({"sessionId":params.worktree_id,"tabId":params.tab_id}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MissedNotificationsParams {
    last_seen_seq: u64,
    #[serde(default)]
    epoch: Option<String>,
}

fn missed_notifications(manager: &PairingManager, params: MissedNotificationsParams) -> Value {
    json!({
        "epoch": manager.mobile.notification_epoch,
        "events": manager
            .mobile
            .missed_notifications(params.epoch.as_deref(), params.last_seen_seq),
    })
}

fn subscribe_notifications(
    sink: &dyn EventSink,
    connection: &Arc<MobileConnection>,
    request_id: &str,
) -> Result<Value> {
    let subscription_id = Uuid::new_v4().to_string();
    let stream = Arc::downgrade(connection);
    let response_id = request_id.to_string();
    let listener = sink.listen(
        "mobile_notification",
        Box::new(move |payload| {
            let Ok(event) = serde_json::from_str::<MobileNotification>(payload) else { return };
            if let Some(stream) = stream.upgrade() {
                stream.stream(&response_id, json!({ "event": event }));
            }
        }),
    );
    connection.insert_subscription(subscription_id.clone(), listener);
    Ok(json!({ "subscriptionId": subscription_id }))
}

fn validate_session_tab(session_id: &str, tab_id: &str) -> Result<(SessionEntry, TabEntry)> {
    let session = index::get(session_id)?;
    let tab = session
        .tab(tab_id)
        .cloned()
        .ok_or_else(|| anyhow!("tab does not belong to this session"))?;
    Ok((session, tab))
}

fn find_tab(tab_id: &str) -> Result<(SessionEntry, TabEntry)> {
    let mut found = index::load()?
        .into_iter()
        .filter_map(|session| session.tab(tab_id).cloned().map(|tab| (session, tab)));
    let result = found.next().ok_or_else(|| anyhow!("tab not found"))?;
    if found.next().is_some() {
        bail!("tab id is ambiguous");
    }
    Ok(result)
}

fn collapse_notification_text(text: &str) -> String {
    let mut out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > 160 {
        out = out.chars().take(159).collect::<String>();
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::TurnStatus;

    fn device(provenance: DeviceProvenance, bound_user_id: Option<&str>) -> DeviceEntry {
        DeviceEntry {
            id: "device-1".into(),
            label: "Paresh's phone".into(),
            platform: "ios".into(),
            token: "token-hash".into(),
            scope: DeviceScope::Driver,
            provenance,
            bound_user_id: bound_user_id.map(str::to_owned),
            binding_generation: 0,
            public_key: String::new(),
            created_at: "2026-09-04T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
            installation_id: None,
            created_request_id: None,
        }
    }

    fn account() -> AccountMirror {
        AccountMirror {
            user_id: "user-1".into(),
            email: "paresh@example.test".into(),
            display_name: "Paresh".into(),
            host_display_name: None,
            binding_generation: 0,
        }
    }

    fn direct() -> ReplyLimits {
        Wire::new(Transport::Direct).reply_limits(TAIL_RESPONSE_BYTES_LIMIT)
    }

    fn relay(fragments: bool) -> ReplyLimits {
        let wire = Wire::new(Transport::Relay);
        if fragments {
            wire.negotiate(Some(super::super::wire::FRAGMENTS_VERSION.into()));
        }
        wire.reply_limits(TAIL_RESPONSE_BYTES_LIMIT)
    }

    fn cursor(page: &Value) -> SyncCursor {
        serde_json::from_value(page["cursor"].clone()).unwrap()
    }

    #[test]
    fn sync_cold_unchanged_and_large_gap_are_contiguous() {
        let mut events: Vec<_> = (1..=100).map(prompt).collect();
        let cold = sync_page(&events, None, "session", "tab", "test", direct()).unwrap();
        assert_eq!(cold["events"].as_array().unwrap().len(), 20);
        assert_eq!(cold["reset"], true);
        let mut checkpoint = cursor(&cold);
        let warm = sync_page(&events, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        assert_eq!(warm["events"], json!([]));
        assert_eq!(warm["reset"], false);
        events.extend((101..=6200).map(prompt));
        let mut received = Vec::new();
        loop {
            let page = sync_page(&events, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
            assert_eq!(page["reset"], false);
            received.extend(page["events"].as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()));
            checkpoint = cursor(&page);
            if page["hasMore"] == false { break; }
        }
        assert_eq!(received, (101..=6200).collect::<Vec<_>>());
    }

    #[test]
    fn sync_rewrites_truncations_and_wrong_generation_reset_boundedly() {
        let mut events: Vec<_> = (1..=600).map(prompt).collect();
        let checkpoint = cursor(&sync_page(&events, None, "session", "tab", "test", direct()).unwrap());
        // Same seq/id and length, different content: max-seq cursors miss this.
        events[599].ts = "changed".into();
        for (history, session) in [(&events[..], "session"), (&events[..10], "session"), (&events[..], "other")] {
            let reset = sync_page(history, Some(&checkpoint), session, "tab", "test", direct()).unwrap();
            assert_eq!(reset["reset"], true);
            assert!(reset["events"].as_array().unwrap().len() <= SYNC_PAGE_EVENTS);
        }
        let empty = sync_page(&[], Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        assert_eq!(empty["events"], json!([]));
        assert_eq!(empty["reset"], true);
    }

    #[test]
    fn sync_pages_bound_the_rpc_response_without_skipping_forward_records() {
        let events: Vec<_> = std::iter::once(prompt(1))
            .chain((2..=17).map(|seq| output(seq, "🦝\n\"".repeat(128 * 1024))))
            .collect();
        let request_id = "\"\n🦝".repeat(20);
        let cold = sync_page(&events, None, "session", "tab", &request_id, direct()).unwrap();
        assert_eq!(cold["reset"], true);
        assert_eq!(cold["hasEarlier"], true);
        assert_eq!(cold["events"].as_array().unwrap().last().unwrap()["seq"], 17);
        assert!(success_response(&request_id, cold).to_string().len() <= TAIL_RESPONSE_BYTES_LIMIT);

        let mut checkpoint = cursor(&sync_page(&[], None, "session", "tab", &request_id, direct()).unwrap());
        let mut received = Vec::new();
        let mut pages = 0;
        loop {
            let page = sync_page(&events, Some(&checkpoint), "session", "tab", &request_id, direct()).unwrap();
            assert_eq!(page["reset"], false);
            assert!(success_response(&request_id, page.clone()).to_string().len() <= TAIL_RESPONSE_BYTES_LIMIT);
            let rows = page["events"].as_array().unwrap();
            assert!(!rows.is_empty());
            let next = cursor(&page);
            assert_eq!(next.offset, checkpoint.offset + rows.len());
            received.extend(rows.iter().map(|event| event["seq"].as_u64().unwrap()));
            checkpoint = next;
            pages += 1;
            if page["hasMore"] == false { break; }
        }
        assert!(pages > 1);
        assert_eq!(received, (1..=17).collect::<Vec<_>>());
    }

    #[test]
    fn sync_sends_an_oversized_event_alone_cut_down_and_advances_past_it() {
        let initial = cursor(&sync_page(&[], None, "session", "tab", "test", direct()).unwrap());
        let events = vec![prompt(1), output(2, "x".repeat(TAIL_RESPONSE_BYTES_LIMIT)), prompt(3)];
        let first = sync_page(&events, Some(&initial), "session", "tab", "test", direct()).unwrap();
        assert_eq!(first["events"].as_array().unwrap().len(), 1);
        assert_eq!(first["hasMore"], true);
        let checkpoint = cursor(&first);
        assert_eq!(checkpoint.offset, 1);
        let second = sync_page(&events, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        assert!(success_response("test", second.clone()).to_string().len() <= TAIL_RESPONSE_BYTES_LIMIT);
        let rows = second["events"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["seq"], 2);
        assert_eq!(rows[0]["payload"]["callId"], "call-2");
        let text = rows[0]["payload"]["result"]["text"].as_str().unwrap();
        assert!(text.starts_with("xxxx"));
        assert!(text.ends_with("not shown. Open this conversation on your Mac to see all of it.]"));
        // The cursor covers the whole event: the next page starts after it.
        let third = sync_page(&events, Some(&cursor(&second)), "session", "tab", "test", direct()).unwrap();
        assert_eq!(third["events"][0]["seq"], 3);
        assert_eq!(third["hasMore"], false);
        let reset = sync_page(&events[..2], None, "session", "tab", "test", direct()).unwrap();
        assert_eq!(reset["events"][0]["seq"], 2);
        assert_eq!(reset["hasEarlier"], true);
    }

    /// The conversation from #669: 500 recent events, about 0.8 MiB of JSON,
    /// on a phone with nothing cached. On Relay every reply must fit one
    /// 1 MiB cell message, and the history still loads in full.
    #[test]
    fn a_long_conversation_loads_over_relay_one_frame_at_a_time() {
        let events: Vec<_> = (1..=600).map(|seq| {
            if seq % 25 == 1 { prompt(seq) } else { output(seq, "🦝 tool output \"line\"\n".repeat(80)) }
        }).collect();
        assert!(serde_json::to_vec(&events[100..]).unwrap().len() > 1024 * 1024);
        let request_id = "mobile-1761756316000-42";
        for limits in [relay(false), relay(true)] {
            assert!(limits.page < 1024 * 1024 / 4 * 3);
            let cold = sync_page(&events, None, "session", "tab", request_id, limits).unwrap();
            assert!(success_response(request_id, cold.clone()).to_string().len() <= limits.page);
            assert_eq!(cold["reset"], true);
            assert_eq!(cold["hasEarlier"], true);
            assert_eq!(cold["events"].as_array().unwrap().last().unwrap()["seq"], 600);
            // Load earlier pages back to the first event, each one frame.
            let mut seen: Vec<u64> = cold["events"].as_array().unwrap().iter().map(|event| event["seq"].as_u64().unwrap()).collect();
            let byte_limit = tail_event_byte_limit(request_id, limits.page).unwrap();
            let mut before = Some(seen[0]);
            let source = tail_log(&events);
            loop {
                let (page, more) = read_event_tail(source.path(), before, 20, byte_limit).unwrap();
                let response = success_response(request_id, json!({ "events": page, "hasMore": more })).to_string();
                assert!(response.len() <= limits.page);
                before = Some(page[0].seq);
                seen.splice(0..0, page.iter().map(|event| event.seq));
                if !more { break; }
            }
            assert_eq!(seen, (1..=600).collect::<Vec<_>>());
        }
    }

    #[test]
    fn over_relay_an_event_larger_than_a_page_is_whole_only_when_it_can_be_fragmented() {
        let large = output(2, "y".repeat(2 * 1024 * 1024));
        let events = vec![prompt(1), large.clone()];
        let legacy = sync_page(&events, None, "session", "tab", "test", relay(false)).unwrap();
        assert!(success_response("test", legacy.clone()).to_string().len() <= relay(false).page);
        assert_eq!(legacy["events"].as_array().unwrap().len(), 1);
        assert!(legacy["events"][0]["payload"]["result"]["text"].as_str().unwrap().contains("Too large to show on mobile"));
        let fragmented = sync_page(&events, None, "session", "tab", "test", relay(true)).unwrap();
        assert_eq!(fragmented["events"].as_array().unwrap().len(), 1);
        assert_eq!(fragmented["events"][0], serde_json::to_value(&large).unwrap());
        assert_eq!(fragmented["hasEarlier"], true);
    }

    #[test]
    fn fit_event_cuts_the_longest_strings_on_character_boundaries() {
        let large = event(7, Payload::ToolCallStarted {
            call_id: "call-7".into(),
            name: "Write".into(),
            tool_type: crate::events::ToolType::Other,
            input: json!({ "path": "notes.md", "content": "🦝\"\\\n\u{1}".repeat(40_000), "old": "z".repeat(30_000) }),
            title: Some("Write notes.md".into()),
        });
        let whole = serde_json::to_vec(&large).unwrap().len();
        for budget in [whole, whole - 1, whole / 2, 40_000, 2_000] {
            let fitted = fit_event(&large, budget).unwrap();
            let size = serde_json::to_vec(&fitted).unwrap().len();
            assert!(size <= budget, "{size} > {budget}");
            assert_eq!(fitted["seq"], 7);
            assert_eq!(fitted["id"], "event-7");
            assert_eq!(fitted["payload"]["type"], "tool_call_started");
            assert_eq!(fitted["payload"]["callId"], "call-7");
            assert_eq!(fitted["payload"]["input"]["path"], "notes.md");
            let content = fitted["payload"]["input"]["content"].as_str().unwrap();
            if budget == whole {
                assert_eq!(fitted, serde_json::to_value(&large).unwrap());
            } else {
                assert!(content.ends_with("to see all of it.]"));
                // What is kept is a prefix of the original, cut between characters.
                let kept = &content[..content.find("\n\n[Too large").unwrap()];
                assert!("🦝\"\\\n\u{1}".repeat(40_000).starts_with(kept));
            }
        }
        // The longest string goes first; a small excess leaves the rest alone.
        let fitted = fit_event(&large, whole - 1).unwrap();
        assert_eq!(fitted["payload"]["input"]["old"], "z".repeat(30_000));
    }

    #[test]
    fn fit_event_falls_back_to_a_status_line_when_no_string_is_large() {
        let many = event(9, Payload::ToolCallCompleted {
            call_id: "call-9".into(),
            result: crate::events::ToolResult {
                structured: Some(json!((0..20_000).collect::<Vec<_>>())),
                ..Default::default()
            },
        });
        let fitted = fit_event(&many, 4_096).unwrap();
        assert!(serde_json::to_vec(&fitted).unwrap().len() <= 4_096);
        assert_eq!(fitted["seq"], 9);
        assert_eq!(fitted["payload"]["type"], "status");
        assert!(fitted["payload"]["text"].as_str().unwrap().starts_with("This item is too large to show on mobile"));
        assert!(serde_json::from_value::<AgentEvent>(fitted).is_ok());
    }

    #[test]
    fn conditional_lists_return_only_versions_when_unchanged() {
        let initial = conditional(json!({"messages": [{"body": "synthetic"}]}), None).unwrap();
        let version = initial["version"].as_str().unwrap().to_string();
        let same = conditional(json!({"messages": [{"body": "synthetic"}]}), Some(version.clone())).unwrap();
        assert_eq!(same, json!({"notModified": true, "version": version}));
        assert!(conditional(json!({"messages": []}), Some(version)).unwrap().get("messages").is_some());
    }

    #[test]
    fn synthetic_sync_payload_measurement() {
        // 2,000 turns, six events per turn, no private content.
        let events: Vec<_> = (1..=12000).map(|seq| {
            if seq % 6 == 1 { prompt(seq) }
            else { event(seq, Payload::AssistantText { text: "x".repeat(512), block: None }) }
        }).collect();
        let cold = sync_page(&events, None, "session", "tab", "test", direct()).unwrap();
        let checkpoint = cursor(&cold);
        let warm = sync_page(&events, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        let mut changed = events.clone();
        changed.push(prompt(12001));
        let delta = sync_page(&changed, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        let (tail, more) = select_event_tail(events.into_iter().rev().map(Ok), None, 20, tail_event_byte_limit("test", TAIL_RESPONSE_BYTES_LIMIT).unwrap()).unwrap();
        let legacy = json!({ "events": tail, "hasMore": more });
        let bytes = |v: &Value| serde_json::to_vec(v).unwrap().len();
        let request = |method: &str, params: Value| bytes(&json!({ "method": method, "params": params }));
        let cold_request = request("session.sync", json!({"sessionId": "session", "tabId": "tab"}));
        let warm_request = request("session.sync", json!({"sessionId": "session", "tabId": "tab", "cursor": checkpoint}));
        let tail_request = request("session.tail", json!({"sessionId": "session", "tabId": "tab", "limit": 20}));
        println!("synthetic transcript result bytes (one page each): legacy={}, cold={}, warm={}, delta={}", bytes(&legacy), bytes(&cold), bytes(&warm), bytes(&delta));
        println!("synthetic request bytes (method + params): legacy={tail_request}, cold={cold_request}, warm={warm_request}, delta={warm_request}");
        assert!(bytes(&warm) * 100 < bytes(&legacy));
        assert!(bytes(&delta) * 50 < bytes(&legacy));
    }

    fn event(seq: u64, payload: Payload) -> AgentEvent {
        AgentEvent {
            id: format!("event-{seq}"),
            session_id: "session".into(),
            tab_id: "tab".into(),
            harness: "codex".into(),
            seq,
            ts: "2026-09-03T00:00:00Z".into(),
            message_ts: Some("2026-09-02T23:59:00Z".into()),
            subagent: None,
            payload,
        }
    }

    fn prompt(seq: u64) -> AgentEvent {
        event(
            seq,
            Payload::UserMessage { author: None,
                text: format!("prompt {seq}"),
                images: Vec::new(),
                baseline: None,
                queued: false,
                cwd: None,
            },
        )
    }

    #[test]
    fn paged_tail_keeps_whole_turns_in_sequence_order() {
        let events = vec![
            prompt(1),
            event(2, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false, detail: None }),
            prompt(3),
            event(4, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false, detail: None }),
            prompt(5),
            event(6, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false, detail: None }),
        ];
        let (tail, has_more) = select_event_tail(events.into_iter().rev().map(Ok), None, 2, tail_event_byte_limit("test", TAIL_RESPONSE_BYTES_LIMIT).unwrap()).unwrap();
        assert!(has_more);
        assert_eq!(tail.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
    }

    fn tail_log(events: &[AgentEvent]) -> tempfile::NamedTempFile {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        for event in events {
            serde_json::to_writer(&mut file, event).unwrap();
            writeln!(file).unwrap();
        }
        file
    }

    fn output(seq: u64, text: String) -> AgentEvent {
        event(seq, Payload::ToolCallCompleted { call_id: format!("call-{seq}"), result: crate::events::ToolResult { text, ..Default::default() } })
    }

    #[test]
    fn tail_counts_serialized_utf8_and_json_escapes_at_the_exact_boundary() {
        let events = vec![prompt(1), output(2, "🦝\n\"\\".repeat(100)), output(3, "tail".into())];
        let file = tail_log(&events);
        let budget = serde_json::to_vec(&events[1]).unwrap().len() + 1 + serde_json::to_vec(&events[2]).unwrap().len();
        let (page, more) = read_event_tail(file.path(), None, 20, budget).unwrap();
        assert_eq!(page.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), None, 20, budget - 1).unwrap();
        assert_eq!(page.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![3]);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), Some(2), 20, budget).unwrap();
        assert_eq!(page[0].seq, 1);
        assert!(!more);
        let (page, more) = read_event_tail(file.path(), Some(1), 20, budget).unwrap();
        assert!(page.is_empty());
        assert!(!more);
    }

    #[test]
    fn tail_budget_includes_the_complete_rpc_envelope() {
        let id = "\"\n🦝".repeat(20);
        let budget = tail_event_byte_limit(&id, TAIL_RESPONSE_BYTES_LIMIT).unwrap();
        let overhead = serde_json::to_vec(&output(1, String::new())).unwrap().len();
        let file = tail_log(&[output(1, "x".repeat(budget - overhead))]);
        let (page, more) = read_event_tail(file.path(), None, 20, budget).unwrap();
        assert!(!more);
        assert_eq!(success_response(&id, json!({ "events": page, "hasMore": more })).to_string().len(), TAIL_RESPONSE_BYTES_LIMIT);
        // One byte over: still the whole page, for the caller to cut down.
        let (page, more) = read_event_tail(file.path(), None, 20, budget - 1).unwrap();
        assert_eq!(page.len(), 1);
        assert!(!more);
        let fitted = fit_event(&page[0], budget - 1).unwrap();
        assert!(serde_json::to_vec(&fitted).unwrap().len() < budget);
    }

    #[test]
    fn tail_sends_a_single_oversized_event_alone_without_skipping_it() {
        let events = vec![prompt(1), output(2, "large tool result".repeat(100)), prompt(3)];
        let file = tail_log(&events);
        let (page, more) = read_event_tail(file.path(), None, 20, 1024).unwrap();
        assert_eq!(page.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![3]);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), Some(3), 20, 1024).unwrap();
        assert_eq!(page, vec![events[1].clone()]);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), Some(2), 20, 1024).unwrap();
        assert_eq!(page[0].seq, 1);
        assert!(!more);
        let file = tail_log(&events[..2]);
        let (page, more) = read_event_tail(file.path(), None, 20, 1024).unwrap();
        assert_eq!(page[0].seq, 2);
        assert!(more);
    }

    #[test]
    fn tail_event_limit_can_split_a_single_turn_without_losing_the_prompt() {
        let events: Vec<_> = std::iter::once(prompt(1))
            .chain((2..=TAIL_EVENT_LIMIT as u64 + 1).map(|seq| output(seq, String::new())))
            .collect();
        let file = tail_log(&events);
        let budget = tail_event_byte_limit("test", TAIL_RESPONSE_BYTES_LIMIT).unwrap();
        let (page, more) = read_event_tail(file.path(), None, 20, budget).unwrap();
        assert_eq!(page.len(), TAIL_EVENT_LIMIT);
        assert_eq!(page[0].seq, 2);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), Some(2), 20, budget).unwrap();
        assert_eq!(page[0].seq, 1);
        assert!(!more);
    }

    #[test]
    fn tail_ignores_invalid_lines_and_handles_empty_or_missing_logs() {
        use std::io::Write;
        let mut file = tail_log(&[prompt(1)]);
        writeln!(file, "not an event").unwrap();
        writeln!(file, "{{\"partial\":").unwrap();
        let (page, more) = read_event_tail(file.path(), None, 1, 1024).unwrap();
        assert_eq!(page[0].seq, 1);
        assert!(!more);
        let empty = tempfile::NamedTempFile::new().unwrap();
        let (page, more) = read_event_tail(empty.path(), None, 20, 1024).unwrap();
        assert!(page.is_empty() && !more);
        let missing = empty.path().to_owned();
        drop(empty);
        let (page, more) = read_event_tail(&missing, None, 20, 1024).unwrap();
        assert!(page.is_empty() && !more);
    }

    #[test]
    fn tail_rebounds_events_appended_by_permission_reconciliation() {
        let mut events = vec![prompt(1), output(2, "result".into())];
        let budget = serde_json::to_vec(&events[0]).unwrap().len() + 1 + serde_json::to_vec(&events[1]).unwrap().len();
        events.push(event(3, Payload::PermissionDecided { request_id: "request".into(), tool_use_id: Some("tool".into()), allowed: false, label: "Lapsed".into(), automatic: true }));
        let (page, more) = select_event_tail(events.into_iter().rev().map(Ok), None, usize::MAX, budget).unwrap();
        assert!(more);
        assert_eq!(page.last().unwrap().seq, 3);
        // All returned sequences still form a suffix, so the next cursor cannot
        // jump over an event displaced by the appended decision.
        assert_eq!(page.iter().map(|event| event.seq).collect::<Vec<_>>(), (page[0].seq..=3).collect::<Vec<_>>());
        assert!(serde_json::to_vec(&page).unwrap().len() <= budget + 2);
    }

    #[tokio::test]
    async fn large_history_pages_fit_the_encrypted_websocket_and_preserve_every_cursor() {
        use super::super::{crypto::{begin_e2ee_session, E2eeClientHandshake, HostKeypair, PayloadKind}, pairing_websocket_config, send_encrypted_text};
        use futures_util::StreamExt;
        use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};

        // A single turn, larger than both the plaintext and the 10 MiB wire
        // limits. Turn limits alone cannot bound it.
        let events: Vec<_> = std::iter::once(prompt(1))
            .chain((2..=16).map(|seq| output(seq, "x".repeat(1024 * 1024))))
            .collect();
        let file = tail_log(&events);
        let id = "\"\n🦝".repeat(20);
        let budget = tail_event_byte_limit(&id, TAIL_RESPONSE_BYTES_LIMIT).unwrap();
        let key = HostKeypair::from_secret([7; 32]);
        let handshake = E2eeClientHandshake::new(&key.public_key_b64(), "direct", None).unwrap();
        let (ready, mut host) = begin_e2ee_session(&key, handshake.hello().clone(), "direct", None).unwrap();
        let mut phone = handshake.accept_ready(&serde_json::to_string(&ready).unwrap()).unwrap();
        let (host_io, phone_io) = tokio::io::duplex(64 * 1024);
        let mut host_socket = WebSocketStream::from_raw_socket(host_io, Role::Server, Some(pairing_websocket_config())).await;
        let mut phone_socket = WebSocketStream::from_raw_socket(phone_io, Role::Client, Some(pairing_websocket_config())).await;
        let mut before = None;
        let mut seen = Vec::new();
        let mut pages = 0;
        loop {
            let (page, more) = read_event_tail(file.path(), before, 20, budget).unwrap();
            assert!(!page.is_empty());
            assert!(page.windows(2).all(|pair| pair[0].seq < pair[1].seq));
            assert!(page.iter().all(|event| before.is_none_or(|cursor| event.seq < cursor)));
            before = Some(page[0].seq);
            seen.extend(page.iter().rev().map(|event| event.seq));
            let response = success_response(&id, json!({ "events": page, "hasMore": more })).to_string();
            assert!(response.len() <= TAIL_RESPONSE_BYTES_LIMIT);
            let (sent, received) = tokio::join!(send_encrypted_text(&mut host_socket, &mut host, &response), phone_socket.next());
            sent.unwrap();
            let text = received.unwrap().unwrap().into_text().unwrap();
            assert!(text.len() < super::super::PAIRING_MESSAGE_BYTES_LIMIT);
            let frame = general_purpose::STANDARD.decode(text.as_bytes()).unwrap();
            assert_eq!(phone.open(&frame, PayloadKind::Text).unwrap(), response.as_bytes());
            pages += 1;
            if !more { break; }
        }
        assert!(pages > 1);
        assert_eq!(seen, (1..=16).rev().collect::<Vec<_>>());
        // The same encrypted connection remains usable after all the pages.
        let response = success_response("status", json!({ "ready": true })).to_string();
        let (sent, received) = tokio::join!(send_encrypted_text(&mut host_socket, &mut host, &response), phone_socket.next());
        sent.unwrap();
        let text = received.unwrap().unwrap().into_text().unwrap();
        assert_eq!(phone.open(&general_purpose::STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap(), response.as_bytes());
    }

    #[tokio::test]
    async fn over_relay_no_frame_exceeds_the_cell_and_an_oversized_reply_fails_alone() {
        use super::super::{crypto::{begin_e2ee_session, E2eeClientHandshake, HostKeypair, PayloadKind}, pairing_websocket_config, send_message, wire::{Reassembly, RELAY_MESSAGE_BYTES_LIMIT}};
        use futures_util::StreamExt;
        use tokio_tungstenite::{tungstenite::{protocol::Role, Message}, WebSocketStream};

        let key = HostKeypair::from_secret([7; 32]);
        let handshake = E2eeClientHandshake::new(&key.public_key_b64(), "direct", None).unwrap();
        let (ready, mut host) = begin_e2ee_session(&key, handshake.hello().clone(), "direct", None).unwrap();
        let mut phone = handshake.accept_ready(&serde_json::to_string(&ready).unwrap()).unwrap();
        let (host_io, phone_io) = tokio::io::duplex(64 * 1024);
        let mut host_socket = WebSocketStream::from_raw_socket(host_io, Role::Server, Some(pairing_websocket_config())).await;
        let mut phone_socket = WebSocketStream::from_raw_socket(phone_io, Role::Client, Some(pairing_websocket_config())).await;
        let wire = Wire::new(Transport::Relay);
        let reply = success_response("request-1", json!({ "events": [], "blob": "🦝 \"x\"\n".repeat(400_000) }));
        let notification = json!({ "method": "session.event", "params": { "blob": "y".repeat(2 * 1024 * 1024) } });
        let small = success_response("request-2", json!({ "ready": true }));

        // A phone that does not reassemble fragments: the reply becomes that
        // request's error, the notification is not sent, and the next message
        // opens in counter order.
        for message in [&reply, &notification, &small] {
            send_message(&mut host_socket, &mut host, message, &wire).await.unwrap();
        }
        let mut texts = Vec::new();
        for _ in 0..2 {
            let text = phone_socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(text.len() <= RELAY_MESSAGE_BYTES_LIMIT);
            let opened = phone.open(&general_purpose::STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap();
            texts.push(serde_json::from_slice::<Value>(&opened).unwrap());
        }
        assert_eq!(texts[0]["id"], "request-1");
        assert_eq!(texts[0]["error"]["code"], "message_too_large");
        assert_eq!(texts[1], small);

        // Once it does, the same reply crosses whole, in binary fragments.
        assert!(wire.negotiate(Some(super::super::wire::FRAGMENTS_VERSION.into())));
        let receive = async {
            let mut reassembly = Reassembly::default();
            loop {
                let Message::Binary(frame) = phone_socket.next().await.unwrap().unwrap() else { panic!("expected a fragment") };
                assert!(frame.len() <= RELAY_MESSAGE_BYTES_LIMIT);
                if let Some(message) = reassembly.push(&phone.open(&frame, PayloadKind::Binary).unwrap()).unwrap() {
                    return message;
                }
            }
        };
        let (sent, received) = tokio::join!(send_message(&mut host_socket, &mut host, &reply, &wire), receive);
        sent.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&received).unwrap(), reply);
        let (sent, received) = tokio::join!(send_message(&mut host_socket, &mut host, &small, &wire), phone_socket.next());
        sent.unwrap();
        let text = received.unwrap().unwrap().into_text().unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&phone.open(&general_purpose::STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap(), small);
    }

    #[test]
    fn notification_text_is_bounded_and_single_line() {
        let text = format!("first\n{}", "word ".repeat(80));
        let collapsed = collapse_notification_text(&text);
        assert!(!collapsed.contains('\n'));
        assert!(collapsed.chars().count() <= 160);
        assert!(collapsed.ends_with('…'));
    }

    #[test]
    fn permission_response_params_are_closed_and_session_scoped() {
        let parsed: PermissionRespondParams = serde_json::from_value(json!({
            "sessionId": "session",
            "tabId": "tab",
            "requestId": "request",
            "optionId": "allow",
        }))
        .unwrap();
        assert_eq!(parsed.session_id, "session");
        assert_eq!(parsed.tab_id, "tab");
        assert_eq!(parsed.request_id, "request");
        assert_eq!(parsed.option_id, "allow");
        assert!(serde_json::from_value::<PermissionRespondParams>(json!({
            "sessionId": "session",
            "tabId": "tab",
            "requestId": "request",
            "optionId": "allow",
            "paneId": "not accepted",
        }))
        .is_err());
    }

    #[test]
    fn explicit_pairing_uses_its_authenticated_device_identity_without_an_account() {
        let author = effective_user_from_mirror(&device(DeviceProvenance::Explicit, None), None).unwrap();
        assert_eq!(author.user_id, "device-1");
        assert_eq!(author.display_name, "Paresh's phone");
    }

    #[test]
    fn account_pairing_still_requires_its_bound_account() {
        assert!(effective_user_from_mirror(&device(DeviceProvenance::Automatic, Some("user-1")), None).is_err());
        assert!(effective_user_from_mirror(&device(DeviceProvenance::Automatic, Some("other-user")), Some(account())).is_err());
    }

    #[test]
    fn session_send_attachments_are_optional_for_old_clients() {
        let old: SessionSendParams = serde_json::from_value(json!({
            "tabId": "tab",
            "text": "hello",
        }))
        .unwrap();
        assert!(old.attachments.is_empty());

        let with_attachment: SessionSendParams = serde_json::from_value(json!({
            "tabId": "tab",
            "text": "hello",
            "attachments": [{
                "mediaType": "image/png",
                "data": general_purpose::STANDARD.encode([1, 2, 3]),
                "name": "proof.png",
            }],
        }))
        .unwrap();
        assert_eq!(with_attachment.attachments.len(), 1);
        assert!(validate_attachment_payloads(&with_attachment.attachments).is_ok());
    }

    #[test]
    fn sends_and_notes_take_a_message_id_only_this_mac_reports_it_understands() {
        // A phone sends the id only after `sync.capabilities` names it (#675).
        assert_eq!(capabilities()["sendIds"], 1);
        let id = "0b8f6a52-0c1f-4c35-9d0e-1d5d5a7d1c11";
        let send: SessionSendParams = serde_json::from_value(json!({ "tabId": "tab", "text": "hello", "clientMessageId": id })).unwrap();
        assert_eq!(send.client_message_id.as_deref(), Some(id));
        let post: ChatPostParams = serde_json::from_value(json!({ "worktreeId": "worktree", "body": "hello", "clientMessageId": id })).unwrap();
        assert_eq!(post.client_message_id.as_deref(), Some(id));
        // Older phones send neither; other unknown fields are still refused.
        let old: ChatPostParams = serde_json::from_value(json!({ "worktreeId": "worktree", "body": "hello" })).unwrap();
        assert_eq!(old.client_message_id, None);
        assert!(serde_json::from_value::<SessionSendParams>(json!({ "tabId": "tab", "text": "hello", "messageId": id })).is_err());

        assert_eq!(checked_message_id(Some(id.into())).unwrap().as_deref(), Some(id));
        assert_eq!(checked_message_id(None).unwrap(), None);
        for bad in ["short", &"x".repeat(129), "has space in it", "../../etc/passwd"] {
            assert!(checked_message_id(Some(bad.into())).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_send_digest_matches_a_repeat_and_changes_with_any_edit() {
        let attachment = |name: &str, data: &[u8]| RemoteAttachmentInput {
            media_type: "image/png".into(),
            data: general_purpose::STANDARD.encode(data),
            name: Some(name.into()),
        };
        let first = send_digest("Run the tests", &[attachment("a.png", &[1])]);
        // The agent gets trimmed text: surrounding space is the same message.
        assert_eq!(first, send_digest("  Run the tests\n", &[attachment("a.png", &[1])]));
        for edited in [
            send_digest("Run the tests again", &[attachment("a.png", &[1])]),
            send_digest("Run the tests", &[]),
            send_digest("Run the tests", &[attachment("a.png", &[2])]),
            send_digest("Run the tests", &[attachment("b.png", &[1])]),
            send_digest("Run the tests", &[attachment("a.png", &[1]), attachment("a.png", &[1])]),
        ] {
            assert_ne!(first, edited);
        }
    }

    /// What the runtime was asked to send: tab, text, attachment count and id.
    type OwnerCalls = std::cell::RefCell<Vec<(String, String, usize, Option<String>)>>;

    /// A phone send through `send_once`, against a runtime answering
    /// `answer` as its JSON would read. Records what the runtime was asked.
    fn sends(ids: &SendIds, calls: &OwnerCalls, text: &str, id: Option<&str>, answer: Value) -> Result<Value> {
        let params: SessionSendParams = serde_json::from_value(json!({
            "tabId": "tab", "text": text, "clientMessageId": id,
            "attachments": [{ "mediaType": "image/png", "data": general_purpose::STANDARD.encode([1]), "name": "a.png" }],
        })).unwrap();
        send_once(ids, params, |tab_id, text, attachments, message| {
            calls.borrow_mut().push((tab_id.into(), text.into(), attachments.len(), message.map(str::to_owned)));
            Ok(serde_json::from_value(answer)?)
        })
    }

    #[test]
    fn a_send_the_agent_has_is_answered_again_without_sending() {
        let dir = tempfile::tempdir().unwrap();
        let ids = SendIds::at(dir.path().join("sends.json"));
        let calls = std::cell::RefCell::new(Vec::new());
        let sent = json!({ "status": "sent", "queued": false });
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": false, "events": [] })).unwrap(), sent);
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": false, "events": [] })).unwrap(), sent);
        assert_eq!(*calls.borrow(), vec![("tab".into(), "Ship it".into(), 1, Some("draft-0001".into()))]);
        // The same id with another message is refused before the runtime sees it.
        assert_eq!(sends(&ids, &calls, "Ship it now", Some("draft-0001"), json!({ "queued": false, "events": [] })).unwrap_err().to_string(), ID_REUSED);
        // Without an id (an older phone) every send goes through.
        sends(&ids, &calls, "Ship it", None, json!({ "queued": false, "events": [] })).unwrap();
        sends(&ids, &calls, "Ship it", None, json!({ "queued": false, "events": [] })).unwrap();
        assert_eq!(calls.borrow()[1..], [("tab".into(), "Ship it".into(), 1, None), ("tab".into(), "Ship it".into(), 1, None)]);
    }

    #[test]
    fn a_queued_send_goes_to_the_runtime_on_every_repeat_until_it_is_delivered() {
        let dir = tempfile::tempdir().unwrap();
        let ids = SendIds::at(dir.path().join("sends.json"));
        let calls = std::cell::RefCell::new(Vec::new());
        let queued = json!({ "status": "sent", "queued": true });
        // The agent's turn is open, and the reply saying so is lost.
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": true, "events": [] })).unwrap(), queued);
        // Not answered from here: the runtime is asked, with the id, and finds
        // the copy queued under the dropped connection.
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": true, "events": [], "repeat": "requeued" })).unwrap(), queued);
        // An older runtime knows no ids, and queues it again: as on a Mac
        // before #675, never lost.
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": true, "events": [] })).unwrap(), queued);
        // Being typed to the agent right now: not known yet, so not sent.
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": true, "events": [], "repeat": "delivering" })).unwrap_err().to_string(), STILL_SENDING);
        // Delivered: that settles it, and later repeats are answered here.
        let sent = json!({ "status": "sent", "queued": false });
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": false, "events": [], "repeat": "delivered" })).unwrap(), sent);
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": false, "events": [] })).unwrap(), sent);
        assert_eq!(calls.borrow().len(), 5);
        assert!(calls.borrow().iter().all(|call| *call == ("tab".into(), "Ship it".into(), 1, Some("draft-0001".into()))));
    }

    #[test]
    fn a_note_posted_again_adds_nothing_and_returns_the_first() {
        let _home = store::temp_home();
        let lock = Mutex::new(());
        let note = |id: &str, body: &str, client: Option<&str>| ChatNote {
            id: id.into(),
            body: body.into(),
            created_at: 1,
            author: NoteAuthor { user_id: "user-1".into(), display_name: "Paresh".into() },
            promoted_to: Vec::new(),
            client_message_id: client.map(str::to_owned),
        };
        let saved = || load_notes().unwrap().sessions.remove("worktree").unwrap_or_default().into_iter().map(|note| note.id).collect::<Vec<_>>();

        let (first, added) = add_note(&lock, "worktree", note("note-1", "Deploying at 5", Some("draft-1"))).unwrap();
        assert!(added);
        let (again, added) = add_note(&lock, "worktree", note("note-2", "Deploying at 5", Some("draft-1"))).unwrap();
        assert!(!added);
        assert_eq!(again.id, first.id);
        assert_eq!(saved(), vec!["note-1"]);

        // Another draft, a phone that sends no id, or another worktree: added.
        assert!(add_note(&lock, "worktree", note("note-3", "Deploying at 5", Some("draft-2"))).unwrap().1);
        assert!(add_note(&lock, "worktree", note("note-4", "Deploying at 5", None)).unwrap().1);
        assert!(add_note(&lock, "worktree", note("note-5", "Deploying at 5", None)).unwrap().1);
        assert!(add_note(&lock, "elsewhere", note("note-6", "Deploying at 5", Some("draft-1"))).unwrap().1);
        // The id with other text: refused, and nothing written.
        assert_eq!(add_note(&lock, "worktree", note("note-7", "Deploying at 6", Some("draft-1"))).unwrap_err().to_string(), ID_REUSED);
        assert_eq!(saved(), vec!["note-1", "note-3", "note-4", "note-5"]);
    }

    #[test]
    fn a_note_posted_again_is_found_with_its_promotions_and_not_added_twice() {
        let note = |id: &str, body: &str, client: Option<&str>| ChatNote {
            id: id.into(),
            body: body.into(),
            created_at: 1,
            author: NoteAuthor { user_id: "user-1".into(), display_name: "Paresh".into() },
            promoted_to: Vec::new(),
            client_message_id: client.map(str::to_owned),
        };
        let mut first = note("note-1", "Deploying at 5", Some("draft-1"));
        first.promoted_to.push(NotePromotion { tab_id: "claude".into(), seq: 4 });
        let notes = vec![note("note-0", "Deploying at 5", None), first];

        let repeat = note("note-2", "Deploying at 5", Some("draft-1"));
        let found = posted_before(&notes, &repeat).unwrap().expect("the note posted first");
        assert_eq!(found.id, "note-1");
        assert_eq!(found.promoted_to, vec![NotePromotion { tab_id: "claude".into(), seq: 4 }]);

        // A new draft, or a phone that sends no id, adds a note as before.
        assert!(posted_before(&notes, &note("note-3", "Deploying at 5", Some("draft-2"))).unwrap().is_none());
        assert!(posted_before(&notes, &note("note-4", "Deploying at 5", None)).unwrap().is_none());
        // The same id with other text is refused, not answered with this note.
        let error = posted_before(&notes, &note("note-5", "Deploying at 6", Some("draft-1"))).unwrap_err();
        assert_eq!(error.to_string(), ID_REUSED);

        // Older phones list notes too; one posted without an id carries no new key.
        assert_eq!(serde_json::to_value(&notes[0]).unwrap().get("clientMessageId"), None);
        assert_eq!(serde_json::to_value(&notes[1]).unwrap()["clientMessageId"], "draft-1");
    }

    #[test]
    fn notes_saved_before_promotions_were_recorded_still_load_and_list_unchanged() {
        let saved: NotesFile = serde_json::from_value(json!({ "sessions": { "worktree": [{
            "id": "note-1",
            "body": "hello",
            "createdAt": 1,
            "author": { "userId": "user-1", "displayName": "Paresh" },
        }] } }))
        .unwrap();
        let note = &saved.sessions["worktree"][0];
        assert!(note.promoted_to.is_empty());
        // Old phones read `chat.list` too; a note never sent carries no new key.
        assert_eq!(serde_json::to_value(note).unwrap().get("promotedTo"), None);
    }

    #[test]
    fn promoting_notes_records_one_promotion_per_tab() {
        let note = |id: &str| ChatNote {
            id: id.into(),
            body: format!("{id} body"),
            created_at: 1,
            author: NoteAuthor { user_id: "user-1".into(), display_name: "Paresh".into() },
            promoted_to: Vec::new(),
            client_message_id: None,
        };
        let mut notes = vec![note("a"), note("b"), note("c")];
        let (a, c, gone) = ("a".to_string(), "c".to_string(), "gone".to_string());
        let promotion = |tab_id: &str, seq| NotePromotion { tab_id: tab_id.into(), seq };

        assert!(mark_promoted(&mut notes, &HashSet::from([&a, &c]), &promotion("claude", 4)));
        assert!(mark_promoted(&mut notes, &HashSet::from([&a]), &promotion("codex", 9)));
        assert!(mark_promoted(&mut notes, &HashSet::from([&a]), &promotion("claude", 12)));
        assert_eq!(notes[0].promoted_to, vec![promotion("codex", 9), promotion("claude", 12)]);
        assert!(notes[1].promoted_to.is_empty());
        assert_eq!(notes[2].promoted_to, vec![promotion("claude", 4)]);
        assert_eq!(
            serde_json::to_value(&notes[2]).unwrap()["promotedTo"],
            json!([{ "tabId": "claude", "seq": 4 }]),
        );

        // A note trimmed away while its message was being sent is skipped.
        assert!(!mark_promoted(&mut notes, &HashSet::from([&gone]), &promotion("claude", 20)));
    }

    #[test]
    fn remote_attachments_are_type_count_and_size_bounded() {
        let attachment = |media_type: &str, data: String| RemoteAttachmentInput {
            media_type: media_type.into(),
            data,
            name: Some("image.png".into()),
        };
        assert!(validate_attachment_payloads(&[attachment("application/pdf", general_purpose::STANDARD.encode([1]))]).is_ok());
        assert!(validate_attachment_payloads(&[attachment("", general_purpose::STANDARD.encode([1]))]).is_err());
        let too_many = (0..=ATTACHMENT_COUNT_LIMIT)
            .map(|_| attachment("image/png", general_purpose::STANDARD.encode([1])))
            .collect::<Vec<_>>();
        assert!(validate_attachment_payloads(&too_many).is_err());
        assert!(validate_attachment_payloads(&[attachment(
            "image/png",
            general_purpose::STANDARD.encode(vec![0; ATTACHMENT_BYTES_LIMIT + 1]),
        )])
        .is_err());
        assert_eq!(safe_attachment_name(Some("../../design brief.pdf")), "design_brief.pdf");
    }
}
