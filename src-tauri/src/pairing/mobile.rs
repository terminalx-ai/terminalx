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
use tauri::{AppHandle, Emitter, EventId, Listener, Manager};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::{DeviceEntry, DeviceScope, PairingManager};
use crate::events::{AgentEvent, Payload};
use crate::pty::PtyData;
use crate::store::index::{self, SessionEntry, TabEntry};
use crate::{store, summaries, AppState};

const NOTES_LIMIT: usize = 1_000;
const NOTE_BYTES_LIMIT: usize = 16 * 1024;
const INPUT_BYTES_LIMIT: usize = 64 * 1024;
const NOTIFICATION_LIMIT: usize = 512;
const TAIL_EVENT_LIMIT: usize = 5_000;

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

#[derive(Debug, Clone)]
struct DriverLease {
    connection_id: String,
    pane_id: String,
    session_id: String,
    tab_id: String,
}

pub(super) struct MobileRuntime {
    app: OnceLock<AppHandle>,
    clients: Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>,
    drivers: Mutex<HashMap<String, DriverLease>>,
    notifications: Mutex<VecDeque<MobileNotification>>,
    notification_epoch: String,
    notification_seq: std::sync::atomic::AtomicU64,
    notes: Mutex<()>,
}

impl MobileRuntime {
    pub(super) fn new() -> Self {
        Self {
            app: OnceLock::new(),
            clients: Mutex::new(HashMap::new()),
            drivers: Mutex::new(HashMap::new()),
            notifications: Mutex::new(VecDeque::new()),
            notification_epoch: Uuid::new_v4().to_string(),
            notification_seq: std::sync::atomic::AtomicU64::new(0),
            notes: Mutex::new(()),
        }
    }

    pub(super) fn configure(&self, app: &AppHandle) -> Result<()> {
        self.app
            .set(app.clone())
            .map_err(|_| anyhow!("mobile runtime was already configured"))
    }

    fn register_client(&self, id: &str, outbound: mpsc::UnboundedSender<Value>) {
        self.clients.lock().unwrap().insert(id.into(), outbound);
    }

    fn unregister_client(&self, id: &str) {
        self.clients.lock().unwrap().remove(id);
        self.release_connection(id);
    }

    fn broadcast(&self, value: Value) {
        self.clients
            .lock()
            .unwrap()
            .retain(|_, sender| sender.send(value.clone()).is_ok());
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
        if let Some(app) = manager.app.get() {
            let _ = app.emit("mobile_notification", &notification);
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

    fn claim_driver(&self, connection_id: &str, session_id: &str, tab_id: &str, pane_id: &str) -> Result<()> {
        let key = tab_key(session_id, tab_id);
        let mut drivers = self.drivers.lock().unwrap();
        if let Some(current) = drivers.get(&key) {
            if current.connection_id != connection_id || current.pane_id != pane_id {
                bail!("another mobile client is driving this terminal");
            }
            return Ok(());
        }
        let lease = DriverLease {
            connection_id: connection_id.into(),
            pane_id: pane_id.into(),
            session_id: session_id.into(),
            tab_id: tab_id.into(),
        };
        drivers.insert(key, lease.clone());
        drop(drivers);
        self.emit_driver(&lease, true);
        Ok(())
    }

    fn release_driver(&self, connection_id: &str, session_id: &str, tab_id: &str) {
        let key = tab_key(session_id, tab_id);
        let removed = {
            let mut drivers = self.drivers.lock().unwrap();
            drivers
                .get(&key)
                .filter(|lease| lease.connection_id == connection_id)
                .cloned()
                .and_then(|lease| drivers.remove(&key).map(|_| lease))
        };
        if let Some(lease) = removed {
            self.emit_driver(&lease, false);
        }
    }

    fn release_connection(&self, connection_id: &str) {
        let removed = {
            let mut drivers = self.drivers.lock().unwrap();
            let keys: Vec<_> = drivers
                .iter()
                .filter(|(_, lease)| lease.connection_id == connection_id)
                .map(|(key, _)| key.clone())
                .collect();
            keys.into_iter().filter_map(|key| drivers.remove(&key)).collect::<Vec<_>>()
        };
        for lease in removed {
            self.emit_driver(&lease, false);
        }
    }

    fn emit_driver(&self, lease: &DriverLease, active: bool) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(
                "mobile_terminal_driver",
                json!({
                    "sessionId": lease.session_id,
                    "tabId": lease.tab_id,
                    "active": active,
                }),
            );
        }
    }

    pub(super) fn is_mobile_driven(&self, pane_id: &str) -> bool {
        self.drivers
            .lock()
            .unwrap()
            .values()
            .any(|lease| lease.pane_id == pane_id)
    }

    pub(super) fn driven_tab_ids(&self) -> Vec<String> {
        let mut ids = self
            .drivers
            .lock()
            .unwrap()
            .values()
            .map(|lease| lease.tab_id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        ids
    }
}

pub(super) struct MobileConnection {
    id: String,
    runtime: Arc<MobileRuntime>,
    outbound: mpsc::UnboundedSender<Value>,
    subscriptions: Mutex<HashMap<String, EventId>>,
    closed: std::sync::atomic::AtomicBool,
}

impl MobileConnection {
    pub(super) fn new(runtime: Arc<MobileRuntime>, outbound: mpsc::UnboundedSender<Value>) -> Self {
        let id = Uuid::new_v4().to_string();
        runtime.register_client(&id, outbound.clone());
        Self {
            id,
            runtime,
            outbound,
            subscriptions: Mutex::new(HashMap::new()),
            closed: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(super) fn close(&self, _manager: &PairingManager) {
        if self
            .closed
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        if let Some(app) = self.runtime.app.get() {
            for (_, listener) in self.subscriptions.lock().unwrap().drain() {
                app.unlisten(listener);
            }
        }
        self.runtime.unregister_client(&self.id);
    }

    fn stream(&self, request_id: &str, result: Value) {
        let _ = self.outbound.send(success_response(request_id, result));
    }

    fn insert_subscription(&self, subscription_id: String, event_id: EventId) {
        self.subscriptions.lock().unwrap().insert(subscription_id, event_id);
    }

    fn unsubscribe(&self, subscription_id: &str) -> bool {
        let listener = self.subscriptions.lock().unwrap().remove(subscription_id);
        if let (Some(app), Some(listener)) = (self.runtime.app.get(), listener) {
            app.unlisten(listener);
            true
        } else {
            false
        }
    }
}

impl Drop for MobileConnection {
    fn drop(&mut self) {
        if !self
            .closed
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            if let Some(app) = self.runtime.app.get() {
                for (_, listener) in self.subscriptions.lock().unwrap().drain() {
                    app.unlisten(listener);
                }
            }
            self.runtime.unregister_client(&self.id);
        }
    }
}

pub(super) async fn dispatch(
    manager: &PairingManager,
    connection: &Arc<MobileConnection>,
    request: &Value,
    device: &DeviceEntry,
) -> Option<Result<Value>> {
    let method = request.get("method")?.as_str()?;
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let app = manager.app.get().cloned();
    let result = match method {
        "sessions.summaries" => no_params(&params).and_then(|_| session_summaries()),
        "session.tail" => parse_params(params).and_then(|params| session_tail(manager, params)),
        "session.subscribe" => app
            .context("app is unavailable")
            .and_then(|app| parse_params(params).and_then(|params| subscribe_session(&app, connection, request_id(request), params))),
        "session.unsubscribe" | "terminal.unsubscribe" | "notifications.unsubscribe" => {
            parse_params(params).map(|params: UnsubscribeParams| json!({ "removed": connection.unsubscribe(&params.subscription_id) }))
        }
        "session.send" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| send_session(manager, device, params)))
        }
        "permission.respond" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| respond_permission(manager, params)))
        }
        "chat.list" => parse_params(params).and_then(|params| list_notes(manager, params)),
        "chat.post" => parse_params(params).and_then(|params| post_note(manager, device, params)),
        "chat.promoteToAgent" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| promote_notes(manager, device, params)))
        }
        "terminal.read" => parse_params(params).and_then(|params| read_terminal(manager, params)),
        "terminal.subscribe" => app
            .context("app is unavailable")
            .and_then(|app| parse_params(params).and_then(|params| subscribe_terminal(manager, &app, connection, request_id(request), params))),
        "steerLease.queueInput" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| queue_input(manager, connection, params)))
        }
        "steerLease.release" => parse_params(params).map(|params| release_input(connection, params)),
        "notifications.missedSince" => parse_params(params).map(|params| missed_notifications(manager, params)),
        "notifications.subscribe" => app
            .context("app is unavailable")
            .and_then(|app| no_params(&params).and_then(|_| subscribe_notifications(&app, connection, request_id(request)))),
        _ => return None,
    };
    Some(result)
}

fn request_id(request: &Value) -> &str {
    request.get("id").and_then(Value::as_str).unwrap_or("")
}

fn success_response(id: &str, result: Value) -> Value {
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

fn session_summaries() -> Result<Value> {
    let snippets: HashMap<_, _> = summaries::collect(None)?
        .into_iter()
        .map(|summary| (summary.session_id.clone(), summary))
        .collect();
    let mut sessions = Vec::new();
    for session in index::load()?.into_iter().filter(|session| !session.archived) {
        let summary = snippets.get(&session.id);
        let project = file_name(&session.project_path);
        let worktree = session
            .worktree_name
            .clone()
            .or_else(|| session.branch.clone())
            .unwrap_or_else(|| file_name(&session.cwd));
        sessions.push(json!({
            "id": session.id,
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

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Project")
        .into()
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

fn session_tail(manager: &PairingManager, params: SessionTailParams) -> Result<Value> {
    validate_session_tab(&params.session_id, &params.tab_id)?;
    if !(1..=20).contains(&params.limit) {
        bail!("tail limit must be between 1 and 20 turns");
    }
    let session_manager = app_state(manager)?.manager().context("session manager is unavailable")?;
    let path = store::log_path(&params.session_id, &params.tab_id)?;
    let (mut events, has_more) = read_event_tail(&path, params.before, params.limit)?;
    if params.before.is_none() {
        session_manager.reconcile_lapsed_events(&params.session_id, &params.tab_id, &mut events)?;
    }
    Ok(json!({ "events": events, "hasMore": has_more }))
}

fn read_event_tail(path: &Path, before: Option<u64>, turn_limit: usize) -> Result<(Vec<AgentEvent>, bool)> {
    let mut lines = match summaries::TailLines::open_unbounded(path) {
        Ok(lines) => lines,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(error) => return Err(error.into()),
    };
    let mut events = Vec::new();
    let mut turns = 0usize;
    let mut has_more = false;
    while let Some(event) = next_tail_event(&mut lines)? {
        if before.is_some_and(|before| event.seq >= before) {
            continue;
        }
        let is_prompt = matches!(event.payload, Payload::UserMessage { .. });
        events.push(event);
        if is_prompt {
            turns += 1;
        }
        if turns >= turn_limit || events.len() >= TAIL_EVENT_LIMIT {
            has_more = next_tail_event(&mut lines)?.is_some();
            break;
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

#[cfg(test)]
fn event_tail(events: Vec<AgentEvent>, turn_limit: usize) -> (Vec<AgentEvent>, bool) {
    if events.is_empty() {
        return (events, false);
    }
    let mut turns = 0usize;
    let mut start = 0usize;
    for (index, event) in events.iter().enumerate().rev() {
        if matches!(event.payload, Payload::UserMessage { .. }) {
            turns += 1;
            if turns == turn_limit {
                start = index;
                break;
            }
        }
    }
    let has_more = start > 0;
    (events.into_iter().skip(start).collect(), has_more)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSubscribeParams {
    tab_id: String,
}

fn subscribe_session(
    app: &AppHandle,
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
    let listener = app.listen("agent_event", move |event| {
        let Ok(event) = serde_json::from_str::<AgentEvent>(event.payload()) else { return };
        if event.session_id == session_id && event.tab_id == tab_id {
            if let Some(stream) = stream.upgrade() {
                stream.stream(&response_id, json!({ "event": event }));
            }
        }
    });
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
struct SessionSendParams {
    tab_id: String,
    text: String,
}

fn send_session(manager: &PairingManager, device: &DeviceEntry, params: SessionSendParams) -> Result<Value> {
    let (session, _) = find_tab(&params.tab_id)?;
    send_attributed(manager, device, &session.id, &params.tab_id, &params.text)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionRespondParams {
    session_id: String,
    tab_id: String,
    request_id: String,
    option_id: String,
}

fn respond_permission(manager: &PairingManager, params: PermissionRespondParams) -> Result<Value> {
    validate_session_tab(&params.session_id, &params.tab_id)?;
    app_state(manager)?
        .manager()
        .context("session manager is unavailable")?
        .respond_permission(
            &params.session_id,
            &params.tab_id,
            &params.request_id,
            &params.option_id,
        )?;
    Ok(json!({ "status": "answered" }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatNote {
    id: String,
    body: String,
    created_at: i64,
    author: NoteAuthor,
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
    Ok(json!({ "messages": notes }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatPostParams {
    worktree_id: String,
    body: String,
}

fn post_note(manager: &PairingManager, device: &DeviceEntry, params: ChatPostParams) -> Result<Value> {
    index::get(&params.worktree_id)?;
    let body = validate_note(&params.body)?;
    let author = effective_user(device)?;
    let note = ChatNote {
        id: Uuid::now_v7().to_string(),
        body,
        created_at: Utc::now().timestamp_millis(),
        author,
    };
    {
        let _guard = manager.mobile.notes.lock().unwrap();
        let mut file = load_notes()?;
        let notes = file.sessions.entry(params.worktree_id.clone()).or_default();
        notes.push(note.clone());
        if notes.len() > NOTES_LIMIT {
            notes.drain(..notes.len() - NOTES_LIMIT);
        }
        save_notes(&file)?;
    }
    manager.mobile.broadcast(json!({
        "method": "chat.changed",
        "params": { "worktreeId": params.worktree_id },
    }));
    Ok(json!({ "status": "sent", "message": note }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatPromoteParams {
    worktree_id: String,
    tab_id: String,
    message_ids: Vec<String>,
}

fn promote_notes(manager: &PairingManager, device: &DeviceEntry, params: ChatPromoteParams) -> Result<Value> {
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
    send_attributed(manager, device, &params.worktree_id, &params.tab_id, &text.join("\n\n"))
}

fn send_attributed(
    manager: &PairingManager,
    device: &DeviceEntry,
    session_id: &str,
    tab_id: &str,
    text: &str,
) -> Result<Value> {
    validate_session_tab(session_id, tab_id)?;
    let text = validate_note(text)?;
    let author = effective_user(device)?;
    let envelope = json!({
        "userId": author.user_id,
        "displayName": author.display_name,
        "authority": "host",
    });
    let attributed = format!("[TerminalX Effective User v1] {envelope}\n{text}");
    let session_manager = app_state(manager)?.manager().context("session manager is unavailable")?;
    let outcome = session_manager.send(session_id, tab_id, attributed, Vec::new())?;
    Ok(json!({ "status": "sent", "queued": outcome.queued }))
}

fn validate_note(body: &str) -> Result<String> {
    let body = body.trim();
    if body.is_empty() || body.len() > NOTE_BYTES_LIMIT {
        bail!("message must contain 1 to {NOTE_BYTES_LIMIT} bytes");
    }
    Ok(body.into())
}

fn effective_user(device: &DeviceEntry) -> Result<NoteAuthor> {
    let mirror = super::registry::load_account_mirror()?.context("host identity is unavailable")?;
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

fn read_terminal(manager: &PairingManager, params: TerminalParams) -> Result<Value> {
    let pane = resolve_live_pane(manager, &params.worktree_id, &params.tab_id)?;
    let state = app_state(manager)?;
    let bytes = state
        .terminals
        .read_output(&pane)
        .context("terminal output is unavailable")?;
    Ok(json!({ "text": String::from_utf8_lossy(&bytes) }))
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

fn subscribe_terminal(
    manager: &PairingManager,
    app: &AppHandle,
    connection: &Arc<MobileConnection>,
    request_id: &str,
    params: TerminalSubscribeParams,
) -> Result<Value> {
    if params.attach_mode != "observe"
        || params.client.get("type").and_then(Value::as_str) != Some("mobile")
        || !params.capabilities.is_object()
    {
        bail!("terminal subscription capabilities are invalid");
    }
    let pane = resolve_live_pane(manager, &params.worktree_id, &params.tab_id)?;
    let state = app_state(manager)?;
    let initial = state
        .terminals
        .read_output(&pane)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    let subscription_id = Uuid::new_v4().to_string();
    let stream = Arc::downgrade(connection);
    let response_id = request_id.to_string();
    let listener = app.listen("pty_data", move |event| {
        let Ok(data) = serde_json::from_str::<PtyData>(event.payload()) else { return };
        if data.id != pane {
            return;
        }
        let Ok(bytes) = general_purpose::STANDARD.decode(data.data) else { return };
        if let Some(stream) = stream.upgrade() {
            stream.stream(
                &response_id,
                json!({ "type": "data", "chunk": String::from_utf8_lossy(&bytes) }),
            );
        }
    });
    connection.insert_subscription(subscription_id.clone(), listener);
    Ok(json!({
        "subscriptionId": subscription_id,
        "type": "scrollback",
        "serialized": initial,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueInputParams {
    worktree_id: String,
    tab_id: String,
    text: String,
}

fn queue_input(
    manager: &PairingManager,
    connection: &Arc<MobileConnection>,
    params: QueueInputParams,
) -> Result<Value> {
    if params.text.is_empty() || params.text.len() > INPUT_BYTES_LIMIT {
        bail!("terminal input must contain 1 to {INPUT_BYTES_LIMIT} bytes");
    }
    let pane = resolve_live_pane(manager, &params.worktree_id, &params.tab_id)?;
    connection.runtime.claim_driver(
        &connection.id,
        &params.worktree_id,
        &params.tab_id,
        &pane,
    )?;
    // Resolve again immediately before the write so replacing a tab runtime
    // cannot redirect a stale request into another process.
    let current = resolve_live_pane(manager, &params.worktree_id, &params.tab_id)?;
    if current != pane {
        connection
            .runtime
            .release_driver(&connection.id, &params.worktree_id, &params.tab_id);
        bail!("agent instance was replaced");
    }
    app_state(manager)?
        .terminals
        .write(&current, params.text.as_bytes())?;
    Ok(json!({ "accepted": true, "bytesWritten": params.text.len() }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseInputParams {
    worktree_id: String,
    tab_id: String,
}

fn release_input(connection: &Arc<MobileConnection>, params: ReleaseInputParams) -> Value {
    connection
        .runtime
        .release_driver(&connection.id, &params.worktree_id, &params.tab_id);
    json!({ "released": true })
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
    app: &AppHandle,
    connection: &Arc<MobileConnection>,
    request_id: &str,
) -> Result<Value> {
    let subscription_id = Uuid::new_v4().to_string();
    let stream = Arc::downgrade(connection);
    let response_id = request_id.to_string();
    let listener = app.listen("mobile_notification", move |event| {
        let Ok(event) = serde_json::from_str::<MobileNotification>(event.payload()) else { return };
        if let Some(stream) = stream.upgrade() {
            stream.stream(&response_id, json!({ "event": event }));
        }
    });
    connection.insert_subscription(subscription_id.clone(), listener);
    Ok(json!({ "subscriptionId": subscription_id }))
}

fn app_state(manager: &PairingManager) -> Result<tauri::State<'_, AppState>> {
    manager
        .app
        .get()
        .context("app is unavailable")
        .map(Manager::state::<AppState>)
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

fn resolve_live_pane(manager: &PairingManager, session_id: &str, tab_id: &str) -> Result<String> {
    validate_session_tab(session_id, tab_id)?;
    let state = app_state(manager)?;
    let session_manager = state.manager().context("session manager is unavailable")?;
    let pane = session_manager
        .pane_of(session_id, tab_id)
        .context("terminal is not running")?;
    if !state.terminals.is_running(&pane.pane_id) {
        bail!("terminal is not running");
    }
    Ok(pane.pane_id)
}

fn tab_key(session_id: &str, tab_id: &str) -> String {
    format!("{session_id}/{tab_id}")
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

    fn event(seq: u64, payload: Payload) -> AgentEvent {
        AgentEvent {
            id: format!("event-{seq}"),
            session_id: "session".into(),
            tab_id: "tab".into(),
            harness: "codex".into(),
            seq,
            ts: "2026-09-03T00:00:00Z".into(),
            subagent: None,
            payload,
        }
    }

    fn prompt(seq: u64) -> AgentEvent {
        event(
            seq,
            Payload::UserMessage {
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
            event(2, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false }),
            prompt(3),
            event(4, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false }),
            prompt(5),
            event(6, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false }),
        ];
        let (tail, has_more) = event_tail(events, 2);
        assert!(has_more);
        assert_eq!(tail.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
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
}
