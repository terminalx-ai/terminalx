//! Cloud workspace sessions in the desktop app (PRO-13): the Tauri face of
//! [`crate::remote::client`].
//!
//! The web view never sees relay credentials or E2EE keys. It attaches a
//! `WorkspaceTarget::Cloud` and gets a connection id; frames it sends are
//! workspace RPC requests, and everything the runtime answers or streams
//! comes back as `cloud_remote_event`. On an organization or account change
//! every connection is stopped, so nothing attached for the old identity
//! keeps running (the web view drops its caches on the same event).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::account::AccountManager;
use crate::cloud_agent_client::CloudAgentClient;
use crate::cloud_diagnostics::ConnectionCloseLog;
use crate::cloud_workspaces::{CloudWorkspaceService, WorkspaceState};
use crate::remote::client::{open_outcome, AttachSource, ClientEvent, ClientState, OpenOutcome, Supervisor};
use crate::remote::protocol::Activation;

pub const EVENT: &str = "cloud_remote_event";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum RemoteEvent {
    State { connection_id: String, state: ClientState },
    Message { connection_id: String, message: Value },
    /// The account or organization changed; every connection was stopped.
    IdentityChanged { connection_ids: Vec<String> },
}

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    user_id: String,
    organization_id: String,
}

struct Attached {
    supervisor: Supervisor,
    /// None only for a debug-build attach by pairing code, which no account owns.
    identity: Option<Identity>,
}

pub struct CloudRemote {
    account: Arc<AccountManager>,
    service: Arc<CloudWorkspaceService>,
    agents: Arc<CloudAgentClient>,
    connections: Mutex<HashMap<String, Attached>>,
    /// Typed relay closes (4100-4104) met by any connection; memory only.
    closes: Arc<ConnectionCloseLog>,
}

/// Request ids the desktop itself sends; their answers never reach the web view.
const KEYS_REQUEST_PREFIX: &str = "keys-";

impl CloudRemote {
    pub fn new(account: Arc<AccountManager>, service: Arc<CloudWorkspaceService>, agents: Arc<CloudAgentClient>) -> Arc<Self> {
        Arc::new(Self { account, service, agents, connections: Mutex::new(HashMap::new()), closes: ConnectionCloseLog::new() })
    }

    pub fn close_log(&self) -> Arc<ConnectionCloseLog> {
        self.closes.clone()
    }

    /// Cheap: no Keychain load or token refresh, so it can run per frame.
    fn identity(&self) -> Option<Identity> {
        self.account.current_identity().map(|(user_id, organization_id)| Identity { user_id, organization_id })
    }

    /// Stop connections made for an identity that is no longer current.
    pub fn watch_identity(self: &Arc<Self>, app: AppHandle) {
        let remote = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                // Keys, outbox and cache of a previous identity are dropped.
                let agents = remote.agents.clone();
                let observed = remote.account.current_identity();
                let _ = tauri::async_runtime::spawn_blocking(move || agents.observe_identity(observed)).await;
                if remote.connections.lock().unwrap().is_empty() {
                    continue;
                }
                let current = remote.identity();
                let stale: Vec<String> = {
                    let mut connections = remote.connections.lock().unwrap();
                    let ids: Vec<String> = connections
                        .iter()
                        .filter(|(_, attached)| attached.identity.is_some() && current != attached.identity)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in &ids {
                        if let Some(attached) = connections.remove(id) {
                            attached.supervisor.stop();
                        }
                    }
                    ids
                };
                if !stale.is_empty() {
                    let _ = app.emit(EVENT, RemoteEvent::IdentityChanged { connection_ids: stale });
                }
            }
        });
    }

    /// Called from an async command, so inside the Tauri runtime.
    /// `workspace_id` names the cloud workspace whose content keys this
    /// connection fetches (`keys.get`) once connected; none for a dev attach.
    fn start(&self, app: &AppHandle, identity: Option<Identity>, workspace_id: Option<String>, source: Arc<dyn AttachSource>, activation: Activation) -> String {
        let connection_id = format!("cloud-{}", uuid::Uuid::new_v4().simple());
        let (events, mut receiver) = mpsc::unbounded_channel();
        let supervisor = Supervisor::start(source, activation, events);
        self.connections.lock().unwrap().insert(connection_id.clone(), Attached { supervisor: supervisor.clone(), identity: identity.clone() });
        let app = app.clone();
        let id = connection_id.clone();
        let agents = self.agents.clone();
        let closes = self.closes.clone();
        tauri::async_runtime::spawn(async move {
            let mut keys_request: Option<String> = None;
            // Whether this connection was granted `keys/1` (fetch keys on it).
            let mut keys_granted = false;
            let fetch_keys = |keys_request: &mut Option<String>| {
                let request = format!("{KEYS_REQUEST_PREFIX}{}", uuid::Uuid::new_v4().simple());
                if supervisor.send(serde_json::json!({ "id": request, "method": "keys.get", "params": {} })) {
                    *keys_request = Some(request);
                }
            };
            while let Some(event) = receiver.recv().await {
                let payload = match event {
                    ClientEvent::State(state) => {
                        if let Some(code) = close_code(&state) {
                            closes.record(workspace_id.as_deref(), code, chrono::Utc::now().timestamp_millis());
                        }
                        keys_granted = matches!(&state, ClientState::Connected { capabilities, .. } if capabilities.iter().any(|capability| capability == "keys/1"))
                            && identity.is_some()
                            && workspace_id.is_some();
                        if keys_granted {
                            fetch_keys(&mut keys_request);
                        }
                        RemoteEvent::State { connection_id: id.clone(), state }
                    }
                    ClientEvent::Message(message) => match intercept(&message) {
                        Intercept::KeysAnswer => {
                            if message.get("id").and_then(Value::as_str) == keys_request.as_deref() {
                                keys_request = None;
                                store_keys(&agents, identity.as_ref(), workspace_id.as_deref(), message);
                            }
                            continue;
                        }
                        // The runtime rotated the workspace key: take the new one.
                        Intercept::KeysChanged => {
                            if keys_granted {
                                fetch_keys(&mut keys_request);
                            }
                            continue;
                        }
                        Intercept::Forward => RemoteEvent::Message { connection_id: id.clone(), message },
                    },
                };
                let _ = app.emit(EVENT, payload);
            }
        });
        connection_id
    }

    fn supervisor(&self, connection_id: &str) -> Result<Supervisor, String> {
        let connections = self.connections.lock().unwrap();
        let attached = connections.get(connection_id).ok_or("cloud_remote_connection_unknown")?;
        // A connection made for another identity is never used, even before
        // the watcher has stopped it.
        if attached.identity.is_some() && self.identity() != attached.identity {
            return Err("cloud_remote_identity_changed".into());
        }
        Ok(attached.supervisor.clone())
    }
}

/// The API's `open`, for one workspace of one organization and account.
struct ApiSource {
    service: Arc<CloudWorkspaceService>,
    identity: Identity,
    workspace_id: String,
    installation_id: String,
}

impl AttachSource for ApiSource {
    fn open(&self, refresh_pairing: bool, activation: Activation) -> anyhow::Result<OpenOutcome> {
        let error = |code: String| anyhow::anyhow!(code);
        let list = self.service.workspaces().map_err(|e| error(e.code))?;
        let workspace = list
            .workspaces
            .iter()
            .find(|item| item.workspace.id == self.workspace_id)
            .ok_or_else(|| anyhow::anyhow!("cloud_workspace_not_found"))?;
        if workspace.workspace.org_id != self.identity.organization_id {
            anyhow::bail!("cloud_remote_identity_changed");
        }
        let resuming = workspace.latest_operation.as_ref().is_some_and(|operation| {
            matches!(operation.action, Some(crate::cloud_workspaces::OperationAction::Resume))
                && matches!(
                    operation.state,
                    crate::cloud_workspaces::OperationState::Queued
                        | crate::cloud_workspaces::OperationState::Running
                        | crate::cloud_workspaces::OperationState::CancelRequested
                )
        });
        match workspace.workspace.state {
            // Already waking (this or another client asked): wait, never ask twice.
            WorkspaceState::Suspended if resuming => return Ok(OpenOutcome::WaitingForRuntime),
            WorkspaceState::Suspended if activation < Activation::Wake => return Ok(OpenOutcome::Suspended),
            WorkspaceState::Suspended => {
                // Only an interactive action wakes compute.
                self.service
                    .lifecycle(&self.workspace_id, crate::cloud_workspaces::OperationAction::Resume)
                    .map_err(|e| error(e.code))?;
                return Ok(OpenOutcome::WaitingForRuntime);
            }
            // In the archive: its saved conversations are read without
            // compute, and nothing wakes it until it is unarchived (§10.1).
            WorkspaceState::Archived if activation < Activation::Wake => return Ok(OpenOutcome::Suspended),
            WorkspaceState::Archived => anyhow::bail!("cloud_workspace_archived"),
            WorkspaceState::Provisioning => return Ok(OpenOutcome::WaitingForRuntime),
            WorkspaceState::Destroyed | WorkspaceState::AttentionRequired => anyhow::bail!("cloud_workspace_unavailable"),
            WorkspaceState::Ready => {}
        }
        let (organization_id, response) =
            self.service.open_attachment(&self.workspace_id, &self.installation_id, refresh_pairing).map_err(|e| error(e.code))?;
        if organization_id != self.identity.organization_id {
            anyhow::bail!("cloud_remote_identity_changed");
        }
        open_outcome(&response)
    }
}

/// A stable id for this desktop installation, sent as `clientInstallationId`.
fn installation_id() -> Result<String, String> {
    let path = crate::store::root().map_err(|e| e.to_string())?.join("cloud-installation-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() && existing.len() <= 128 && existing.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-')) {
            return Ok(existing);
        }
    }
    let id = format!("desktop-{}", uuid::Uuid::new_v4().simple());
    std::fs::write(&path, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTarget {
    organization_id: String,
    workspace_id: String,
    /// The generation the caller last saw; informational, the ticket decides.
    #[serde(default)]
    #[allow(dead_code)]
    runtime_generation: Option<u64>,
}

#[tauri::command]
pub async fn cloud_remote_attach(
    app: AppHandle,
    remote: tauri::State<'_, Arc<CloudRemote>>,
    target: CloudTarget,
    activation: Activation,
) -> Result<String, String> {
    let identity = remote.identity().ok_or("account_signed_out")?;
    if identity.organization_id != target.organization_id {
        return Err("cloud_remote_organization_mismatch".into());
    }
    let source = Arc::new(ApiSource {
        service: remote.service.clone(),
        identity: identity.clone(),
        workspace_id: target.workspace_id,
        installation_id: installation_id()?,
    });
    let workspace_id = source.workspace_id.clone();
    Ok(remote.start(&app, Some(identity), Some(workspace_id), source, activation))
}

/// Debug builds only: attach with a pairing code (and optional ticket)
/// straight from a local runtime, without the API. Used with
/// `terminalx-serve --relay-link` and `scripts/remote-runtime/relay-harness.ts`.
#[tauri::command]
pub async fn cloud_remote_attach_dev(
    app: AppHandle,
    remote: tauri::State<'_, Arc<CloudRemote>>,
    pairing_code: String,
    ticket: Option<crate::remote::client::AttachTicket>,
) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err("cloud_remote_dev_attach_unavailable".into());
    }
    struct DevSource(crate::remote::client::AttachGrant);
    impl AttachSource for DevSource {
        fn open(&self, _refresh: bool, _activation: Activation) -> anyhow::Result<OpenOutcome> {
            Ok(OpenOutcome::Ready(Box::new(self.0.clone())))
        }
    }
    let offer = crate::remote::client::decode_pairing_code(&pairing_code).map_err(|e| e.to_string())?;
    let grant = crate::remote::client::AttachGrant { attachment_id: "dev".into(), offer, ticket };
    Ok(remote.start(&app, None, None, Arc::new(DevSource(grant)), Activation::Connect))
}

#[tauri::command]
pub fn cloud_remote_send(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String, frame: Value) -> Result<bool, String> {
    if frame.get("id").and_then(Value::as_str).is_none() || frame.get("method").and_then(Value::as_str).is_none() {
        return Err("cloud_remote_frame_invalid".into());
    }
    Ok(remote.supervisor(&connection_id)?.send(frame))
}

#[tauri::command]
pub fn cloud_remote_activate(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String, activation: Activation) -> Result<(), String> {
    remote.supervisor(&connection_id)?.set_activation(activation);
    Ok(())
}

#[tauri::command]
pub fn cloud_remote_detach(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String) -> Result<(), String> {
    if let Some(attached) = remote.connections.lock().unwrap().remove(&connection_id) {
        attached.supervisor.stop();
    }
    Ok(())
}

/// Keep what `keys.get` answered, for the identity the connection was made for.
fn store_keys(agents: &Arc<CloudAgentClient>, identity: Option<&Identity>, workspace_id: Option<&str>, message: Value) {
    let (Some(identity), Some(workspace_id)) = (identity.cloned(), workspace_id.map(str::to_string)) else { return };
    if message.get("ok").and_then(Value::as_bool) != Some(true) {
        log::warn!("keys.get refused: {}", message.pointer("/error/code").and_then(Value::as_str).unwrap_or("unknown"));
        return;
    }
    let agents = agents.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = message.get("result").cloned().unwrap_or(Value::Null);
        if let Err(error) = agents.store_keys(&identity.user_id, &identity.organization_id, &workspace_id, &result) {
            log::warn!("store cloud workspace keys: {error:#}");
        }
    });
}

/// The relay close code a state change reports, if any. `UpdateRequired`
/// only follows a 4103 close.
fn close_code(state: &ClientState) -> Option<u16> {
    match state {
        ClientState::Reconnecting { close_code, .. } => *close_code,
        ClientState::UpdateRequired => Some(4103),
        _ => None,
    }
}

/// What the desktop does with a frame from the runtime before the web view
/// sees it: key traffic stays in Rust.
#[derive(Debug, PartialEq, Eq)]
enum Intercept {
    /// The answer to a `keys.get` this module sent.
    KeysAnswer,
    /// `keys.changed`: the workspace key rotated; fetch it again.
    KeysChanged,
    Forward,
}

fn intercept(message: &Value) -> Intercept {
    if message.get("id").and_then(Value::as_str).is_some_and(|id| id.starts_with(KEYS_REQUEST_PREFIX)) {
        return Intercept::KeysAnswer;
    }
    if message.get("event").and_then(Value::as_str) == Some("keys.changed") {
        return Intercept::KeysChanged;
    }
    Intercept::Forward
}

#[cfg(test)]
mod intercept_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn typed_relay_closes_reach_the_diagnostics_log() {
        let reconnecting = |close_code| ClientState::Reconnecting { attempt: 1, reason: "4101 stale".into(), retry_in_ms: 250, close_code };
        assert_eq!(close_code(&reconnecting(Some(4101))), Some(4101));
        assert_eq!(close_code(&reconnecting(None)), None);
        assert_eq!(close_code(&ClientState::UpdateRequired), Some(4103));
        assert_eq!(close_code(&ClientState::Opening), None);
        // The web view's state is unchanged: the code is not serialized.
        assert!(serde_json::to_value(reconnecting(Some(4101))).unwrap().get("closeCode").is_none());
    }

    #[test]
    fn key_answers_and_rotations_never_reach_the_web_view() {
        assert_eq!(intercept(&json!({ "id": "keys-abc", "ok": true, "result": { "keys": [] } })), Intercept::KeysAnswer);
        assert_eq!(intercept(&json!({ "event": "keys.changed", "params": {} })), Intercept::KeysChanged);
        assert_eq!(intercept(&json!({ "id": "req-1", "ok": true, "result": {} })), Intercept::Forward);
        assert_eq!(intercept(&json!({ "event": "session.tabs", "params": { "tabs": [] } })), Intercept::Forward);
    }
}
