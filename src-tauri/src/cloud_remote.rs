//! Cloud workspace sessions in the desktop app (PRO-13): the Tauri face of
//! [`crate::remote::client`].
//!
//! The web view never sees relay credentials or E2EE keys. It attaches a
//! `WorkspaceTarget::Cloud` and gets a connection id; frames it sends are
//! workspace RPC requests, and everything the runtime answers or streams
//! comes back as `cloud_remote_event`. A connection belongs to one user,
//! profile and Organization. On an account change every connection is
//! stopped; when the user leaves an Organization, only that Organization's
//! connections are. On a server that authorizes by membership (CS-18) a
//! change of the default Organization stops nothing; without it, as before,
//! only the active Organization's connections survive.
//!
//! A paired machine's connection (PRO-345, `machine_remote_attach` in
//! `machines::connect`) lives in the same table and speaks through the same
//! event, so `cloud_remote_send`, `cloud_remote_detach` and `cloud_port_*`
//! work on it. No account owns it: a machine paired by code stays connected
//! through a sign-out, and only its relay link closes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::account::{AccountManager, CloudScope};
use crate::cloud_agent_client::CloudAgentClient;
use crate::cloud_diagnostics::ConnectionCloseLog;
use crate::cloud_ports::{Forward, ForwardsChanged, PortForwarder, PortSettings};
use crate::cloud_workspaces::{CloudWorkspaceService, WorkspaceState};
use crate::remote::client::{open_outcome, AttachSource, ClientEvent, ClientState, OpenOutcome, Supervisor};
use crate::remote::machine_client::{MachineEnv, MachineSupervisor, NetDialer, OnState};
use crate::remote::protocol::Activation;

pub const EVENT: &str = "cloud_remote_event";
/// A connection's forwards or switches changed (`CloudPortForwardsChanged`, PRO-355).
pub const PORTS_EVENT: &str = "cloud_port_forwards_changed";

/// `cloud_port_forwards_changed`'s payload, as `CloudPortForwardsChanged`
/// in src/lib/api.ts reads it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PortForwardsChanged {
    connection_id: String,
    forwards: Vec<Forward>,
    settings: PortSettings,
    opened: Vec<Forward>,
}

impl PortForwardsChanged {
    fn new(connection_id: &str, changed: ForwardsChanged) -> Self {
        Self { connection_id: connection_id.to_string(), forwards: changed.forwards, settings: changed.settings, opened: changed.opened }
    }
}

/// The web view's `NativeWorkspaceTransport` reads `kind`, `connectionId`,
/// `state`, `message` and `connectionIds`: `rename_all` only renames the
/// variant tags, so the fields need `rename_all_fields` too.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
enum RemoteEvent {
    State { connection_id: String, state: ClientState },
    Message { connection_id: String, message: Value },
    /// The account changed or an Organization is no longer reachable; these
    /// connections were stopped.
    IdentityChanged { connection_ids: Vec<String> },
}

/// Who a connection was made for.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    user_id: String,
    profile_id: String,
    organization_id: String,
}

impl Identity {
    /// Whether this connection may still be used under `scope`: the same user
    /// and profile, and an Organization the scope still reaches.
    fn allowed_by(&self, scope: Option<&CloudScope>) -> bool {
        scope.is_some_and(|scope| scope.user_id == self.user_id && scope.profile_id == self.profile_id && scope.allows(&self.organization_id))
    }
}

/// What keeps one connection: a cloud workspace's supervisor, or a paired
/// machine's (PRO-345).
#[derive(Clone)]
enum Handle {
    Cloud(Supervisor),
    Machine(MachineSupervisor),
}

impl Handle {
    fn send(&self, frame: Value) -> bool {
        match self {
            Handle::Cloud(supervisor) => supervisor.send(frame),
            Handle::Machine(supervisor) => supervisor.send(frame),
        }
    }

    fn stop(&self) {
        match self {
            Handle::Cloud(supervisor) => supervisor.stop(),
            Handle::Machine(supervisor) => supervisor.stop(),
        }
    }
}

struct Attached {
    supervisor: Handle,
    /// This connection's local port forwards (PRO-28).
    ports: PortForwarder,
    /// None only for a paired machine's connection, which no account owns.
    identity: Option<Identity>,
    #[cfg_attr(not(unix), allow(dead_code))]
    workspace_id: Option<String>,
}

pub struct CloudRemote {
    account: Arc<AccountManager>,
    service: Arc<CloudWorkspaceService>,
    agents: Arc<CloudAgentClient>,
    /// Never held across a call into the account or anything that can wait.
    connections: Mutex<HashMap<String, Attached>>,
    /// Typed relay closes (4100-4104) met by any connection; memory only.
    closes: Arc<ConnectionCloseLog>,
    /// What the web view asked of its connections, in the order it asked.
    /// `cloud_remote_send` runs on the main thread and only puts the frame
    /// here; one thread takes them out and does the work, so the window never
    /// waits on a lock and frames (keystrokes) keep their order.
    outgoing: std::sync::mpsc::Sender<Outgoing>,
}

enum Outgoing {
    Frame { connection_id: String, frame: Value },
    /// After every frame sent before it. `holder` is the web view letting go.
    Detach { connection_id: String, holder: Option<String>, done: tokio::sync::oneshot::Sender<()> },
}

/// Request ids the desktop itself sends; their answers never reach the web view.
const KEYS_REQUEST_PREFIX: &str = "keys-";

impl CloudRemote {
    pub fn new(account: Arc<AccountManager>, service: Arc<CloudWorkspaceService>, agents: Arc<CloudAgentClient>) -> Arc<Self> {
        let (outgoing, queued) = std::sync::mpsc::channel();
        let remote = Arc::new(Self { account, service, agents, connections: Mutex::new(HashMap::new()), closes: ConnectionCloseLog::new(), outgoing });
        // Ends when the last `CloudRemote` handle (and so the sender) is gone.
        let weak = Arc::downgrade(&remote);
        std::thread::Builder::new()
            .name("cloud-remote-send".into())
            .spawn(move || {
                while let Ok(next) = queued.recv() {
                    let Some(remote) = weak.upgrade() else { break };
                    remote.deliver(next);
                }
            })
            .expect("start the cloud send thread");
        remote
    }

    /// Hand a frame over for delivery. Takes no lock and never waits; false
    /// only when nothing delivers any more.
    fn queue_frame(&self, connection_id: String, frame: Value) -> bool {
        self.outgoing.send(Outgoing::Frame { connection_id, frame }).is_ok()
    }

    fn deliver(&self, next: Outgoing) {
        match next {
            // A frame for a connection that is gone, not connected or made for
            // another identity is dropped; the web view resends what matters
            // after the next `connected` state.
            Outgoing::Frame { connection_id, frame } => {
                if let Ok(supervisor) = self.supervisor(&connection_id) {
                    supervisor.send(frame);
                }
            }
            Outgoing::Detach { connection_id, holder, done } => {
                self.detach(&connection_id, holder.as_deref());
                let _ = done.send(());
            }
        }
    }

    /// A machine's connection is shared by every web view that attached it,
    /// and ends when the last of them (`holder`) lets go; `None` ends it.
    fn detach(&self, connection_id: &str, holder: Option<&str>) {
        let attached = {
            let mut connections = self.connections.lock().unwrap();
            let last = match connections.get(connection_id).map(|attached| &attached.supervisor) {
                Some(Handle::Machine(supervisor)) => supervisor.release(holder),
                _ => true,
            };
            if !last {
                return;
            }
            connections.remove(connection_id)
        };
        if let Some(attached) = attached {
            attached.ports.shutdown();
            attached.supervisor.stop();
        }
    }

    /// A window closed: it lets go of every machine connection it held, and
    /// those nobody else holds end. A closed window runs no cleanup of its
    /// own, so without this its hold would keep a machine connecting after
    /// the last window that wanted it has gone.
    pub fn release_holder(&self, holder: &str) {
        let ended: Vec<Attached> = {
            let mut connections = self.connections.lock().unwrap();
            let held: Vec<String> = connections
                .iter()
                .filter(|(_, attached)| matches!(&attached.supervisor, Handle::Machine(supervisor) if supervisor.holds(holder)))
                .map(|(id, _)| id.clone())
                .collect();
            let last: Vec<String> = held.into_iter().filter(|id| matches!(&connections[id].supervisor, Handle::Machine(supervisor) if supervisor.release(Some(holder)))).collect();
            last.into_iter().filter_map(|id| connections.remove(&id)).collect()
        };
        for attached in ended {
            attached.ports.shutdown();
            attached.supervisor.stop();
        }
    }

    pub fn close_log(&self) -> Arc<ConnectionCloseLog> {
        self.closes.clone()
    }

    /// Cheap: no Keychain load or token refresh, so it can run per frame.
    fn scope(&self) -> Option<CloudScope> {
        self.account.current_scope()
    }

    /// Stop connections made for an identity that is no longer current.
    pub fn watch_identity(self: &Arc<Self>, app: AppHandle) {
        let remote = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let watched = remote.clone();
                let stale = tauri::async_runtime::spawn_blocking(move || watched.drop_previous_identity()).await.unwrap_or_default();
                if !stale.is_empty() {
                    let _ = app.emit(EVENT, RemoteEvent::IdentityChanged { connection_ids: stale });
                }
            }
        });
    }

    /// One look at who is signed in: keys, outbox and cache of a previous
    /// identity are dropped and its connections stopped. Returns the
    /// connections stopped.
    ///
    /// Nothing is done while a sign-out waits for the Keychain. The session is
    /// out of memory then, but a Keychain that refuses puts it back, and
    /// unsent commands dropped in between would be lost to someone who is
    /// still signed in. (Nothing is sent meanwhile either: `supervisor`
    /// reads the scope as it is.)
    fn drop_previous_identity(&self) -> Vec<String> {
        let Some(scope) = self.account.settled_scope() else { return Vec::new() };
        // A port forward does not outlive a switch of the active
        // organization, even where the connection itself does (CS-18).
        {
            let active = scope.as_ref().map(|scope| scope.active_org_id.as_str());
            for attached in self.connections.lock().unwrap().values() {
                attached.ports.keep_scope(active);
            }
        }
        self.agents.observe_identity(scope.as_ref().map(|scope| (scope.user_id.clone(), scope.kept_orgs())));
        let stopped: Vec<(String, Attached)> = {
            let mut connections = self.connections.lock().unwrap();
            let ids: Vec<String> = connections
                .iter()
                .filter(|(_, attached)| attached.identity.as_ref().is_some_and(|identity| !identity.allowed_by(scope.as_ref())))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| connections.remove(&id).map(|attached| (id, attached))).collect()
        };
        stopped
            .into_iter()
            .map(|(id, attached)| {
                attached.ports.shutdown();
                attached.supervisor.stop();
                id
            })
            .collect()
    }

    /// Called from an async command, so inside the Tauri runtime.
    /// `workspace_id` names the cloud workspace whose content keys this
    /// connection fetches (`keys.get`) once connected.
    fn start(&self, app: &AppHandle, identity: Option<Identity>, workspace_id: Option<String>, source: Arc<dyn AttachSource>, activation: Activation) -> String {
        let connection_id = format!("cloud-{}", uuid::Uuid::new_v4().simple());
        let (events, receiver) = mpsc::unbounded_channel();
        let supervisor = Handle::Cloud(Supervisor::start(source, activation, events));
        self.register(app, connection_id.clone(), identity, workspace_id, supervisor, receiver);
        connection_id
    }

    /// A paired machine's connection (PRO-345): its one supervisor, in this
    /// table, its states and messages as `cloud_remote_event`. Called inside
    /// the Tauri runtime; `machines::connect` keeps it to one per machine.
    pub(crate) fn start_machine(&self, app: &AppHandle, machine_id: &str, env: Arc<dyn MachineEnv>, on_state: OnState) -> (String, MachineSupervisor) {
        let connection_id = format!("machine-{}", uuid::Uuid::new_v4().simple());
        let (events, receiver) = mpsc::unbounded_channel();
        let supervisor = MachineSupervisor::start(machine_id, env, Arc::new(NetDialer), events, on_state);
        self.register(app, connection_id.clone(), None, None, Handle::Machine(supervisor.clone()), receiver);
        (connection_id, supervisor)
    }

    fn register(&self, app: &AppHandle, connection_id: String, identity: Option<Identity>, workspace_id: Option<String>, supervisor: Handle, mut receiver: mpsc::UnboundedReceiver<ClientEvent>) {
        let ports = {
            // Under the same rule as every frame the web view sends: nothing
            // goes out for an identity that is no longer current, a pending
            // sign-out included.
            let (sender, account, made_for) = (supervisor.clone(), self.account.clone(), identity.clone());
            let send = move |frame| made_for.as_ref().is_none_or(|identity| identity.allowed_by(account.current_scope().as_ref())) && sender.send(frame);
            // A machine's forwards wait through a dropped link and return
            // with it; a cloud workspace's end with the connection (PRO-355).
            let ports = if matches!(supervisor, Handle::Machine(_)) { PortForwarder::for_machine(send) } else { PortForwarder::new(send) };
            let (app, id) = (app.clone(), connection_id.clone());
            ports.on_change(move |changed| {
                let _ = app.emit(PORTS_EVENT, PortForwardsChanged::new(&id, changed));
            });
            ports
        };
        self.connections.lock().unwrap().insert(connection_id.clone(), Attached { supervisor: supervisor.clone(), ports: ports.clone(), identity: identity.clone(), workspace_id: workspace_id.clone() });
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
                            // A machine has no identity: its close is recorded without an Organization and never exported.
                            closes.record_for(
                                identity.as_ref().map(|identity| (identity.user_id.as_str(), identity.profile_id.as_str())),
                                identity.as_ref().map(|identity| identity.organization_id.as_str()),
                                workspace_id.as_deref(), code, chrono::Utc::now().timestamp_millis(),
                            );
                        }
                        // A participant gets the key only while the workspace
                        // is shared with them (saas contract §21.5).
                        keys_granted = matches!(&state, ClientState::Connected { capabilities, authority, you, .. }
                                if capabilities.iter().any(|capability| capability == "keys/1") && may_hold_keys(authority, you.as_ref()))
                            && identity.is_some()
                            && workspace_id.is_some();
                        if keys_granted {
                            fetch_keys(&mut keys_request);
                        }
                        // Port streams live and end with the connection; a
                        // machine's forwards wait for it to return.
                        ports.set_connected(match &state {
                            ClientState::Connected { capabilities, .. } => Some(capabilities.as_slice()),
                            _ => None,
                        });
                        RemoteEvent::State { connection_id: id.clone(), state }
                    }
                    // The forwarder's own answers and port data stay native.
                    ClientEvent::Message(message) if ports.on_message(&message) => continue,
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
                        // Shared with this person now (or no longer): fetch
                        // the key, which the runtime answers only while shared.
                        Intercept::RoleChanged => {
                            if identity.is_some() && workspace_id.is_some() && may_hold_keys("participate", message.pointer("/params/you")) {
                                keys_granted = true;
                                fetch_keys(&mut keys_request);
                            }
                            RemoteEvent::Message { connection_id: id.clone(), message }
                        }
                        Intercept::Forward => RemoteEvent::Message { connection_id: id.clone(), message },
                    },
                };
                let _ = app.emit(EVENT, payload);
            }
            // Detached for good: everything is forgotten, a machine's waiting forwards too.
            ports.shutdown();
        });
    }

    /// The connection's port forwarder, under the same identity rule as
    /// [`Self::supervisor`].
    fn ports(&self, connection_id: &str) -> Result<PortForwarder, String> {
        let scope = self.scope();
        let connections = self.connections.lock().unwrap();
        let attached = connections.get(connection_id).ok_or("cloud_remote_connection_unknown")?;
        if attached.identity.as_ref().is_some_and(|identity| !identity.allowed_by(scope.as_ref())) {
            return Err("cloud_remote_identity_changed".into());
        }
        Ok(attached.ports.clone())
    }

    #[cfg(unix)]
    fn ssh_ports(&self, connection_id: &str, org: &str, workspace: &str) -> Result<PortForwarder, String> {
        crate::data_privacy::require_network().map_err(|error| error.to_string())?;
        let scope = self.scope();
        let connections = self.connections.lock().unwrap();
        let attached = connections.get(connection_id).ok_or("cloud_remote_connection_unknown")?;
        if attached.workspace_id.as_deref() != Some(workspace)
            || !attached.identity.as_ref().is_some_and(|identity|
                identity.organization_id == org && identity.allowed_by(scope.as_ref()))
        {
            return Err("cloud_remote_identity_changed".into());
        }
        Ok(attached.ports.clone())
    }

    fn supervisor(&self, connection_id: &str) -> Result<Handle, String> {
        crate::data_privacy::require_network().map_err(|error| error.to_string())?;
        // Read before the connections are locked: one lock at a time.
        let scope = self.scope();
        let connections = self.connections.lock().unwrap();
        let attached = connections.get(connection_id).ok_or("cloud_remote_connection_unknown")?;
        // A connection made for another identity is never used, even before
        // the watcher has stopped it.
        if attached.identity.as_ref().is_some_and(|identity| !identity.allowed_by(scope.as_ref())) {
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
        let organization = Some(self.identity.organization_id.as_str());
        let list = self.service.workspaces(organization).map_err(|e| error(e.code))?;
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
        match open_gate(workspace.workspace.state, resuming, activation) {
            Gate::Answer(outcome) => return Ok(outcome),
            Gate::Fail(code) => anyhow::bail!(code),
            Gate::Resume => {
                self.service
                    .lifecycle(organization, &self.workspace_id, crate::cloud_workspaces::OperationAction::Resume)
                    .map_err(|e| error(e.code))?;
                return Ok(OpenOutcome::WaitingForRuntime);
            }
            Gate::Attach => {}
        }
        let (organization_id, response) =
            self.service.open_attachment(organization, &self.workspace_id, &self.installation_id, refresh_pairing).map_err(|e| error(e.code))?;
        if organization_id != self.identity.organization_id {
            anyhow::bail!("cloud_remote_identity_changed");
        }
        open_outcome(&response)
    }
}

/// What `open` does with a workspace in the list's state, before any attach.
enum Gate {
    /// Answered from the state alone; nothing is asked of the API.
    Answer(OpenOutcome),
    Fail(&'static str),
    /// Ask the API to resume compute, then wait for the runtime.
    Resume,
    /// Ready: ask for an attachment.
    Attach,
}

fn open_gate(state: WorkspaceState, resuming: bool, activation: Activation) -> Gate {
    match state {
        // Already waking (this or another client asked): wait, never ask twice.
        WorkspaceState::Suspended if resuming => Gate::Answer(OpenOutcome::WaitingForRuntime),
        WorkspaceState::Suspended if activation < Activation::Wake => Gate::Answer(OpenOutcome::Suspended),
        // Only an interactive action wakes compute.
        WorkspaceState::Suspended => Gate::Resume,
        // In the archive: its saved conversations are read without
        // compute, and nothing wakes it until it is unarchived (§10.1).
        WorkspaceState::Archived if activation < Activation::Wake => Gate::Answer(OpenOutcome::Suspended),
        WorkspaceState::Archived => Gate::Fail("cloud_workspace_archived"),
        WorkspaceState::Provisioning => Gate::Answer(OpenOutcome::WaitingForRuntime),
        // Nothing to attach to, and retrying cannot change that: the
        // supervisor parks until the workspace's state changes (#1582).
        WorkspaceState::AttentionRequired => Gate::Answer(OpenOutcome::Unavailable { reason: "attention-required".into() }),
        WorkspaceState::Destroyed => Gate::Answer(OpenOutcome::Unavailable { reason: "destroyed".into() }),
        WorkspaceState::Ready => Gate::Attach,
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
    #[serde(default)]
    ssh: bool,
}

#[tauri::command]
pub async fn cloud_remote_attach(
    app: AppHandle,
    remote: tauri::State<'_, Arc<CloudRemote>>,
    target: CloudTarget,
    activation: Activation,
) -> Result<String, String> {
    crate::data_privacy::require_network().map_err(|error| error.to_string())?;
    let scope = remote.scope().ok_or("account_signed_out")?;
    // The target's Organization is checked against the membership list (on a
    // server that authorizes by membership) or the active one, never assumed.
    if !scope.allows(&target.organization_id) {
        return Err("cloud_remote_organization_mismatch".into());
    }
    let identity = Identity { user_id: scope.user_id, profile_id: scope.profile_id, organization_id: target.organization_id };
    let mut installation = installation_id()?;
    if target.ssh {
        installation.push_str("-ssh");
    }
    let source = Arc::new(ApiSource {
        service: remote.service.clone(),
        identity: identity.clone(),
        workspace_id: target.workspace_id,
        installation_id: installation,
    });
    let workspace_id = source.workspace_id.clone();
    Ok(remote.start(&app, Some(identity), Some(workspace_id), source, activation))
}

/// Runs on the main thread, in the order the web view sent: it checks the
/// frame's shape and hands it over (see [`CloudRemote::outgoing`]), touching
/// no lock. True means accepted for delivery, not delivered: a frame for a
/// connection that is gone or not connected is dropped, as it was before
/// (the web view never waited for this answer).
#[tauri::command]
pub fn cloud_remote_send(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String, frame: Value) -> Result<bool, String> {
    if frame.get("id").and_then(Value::as_str).is_none() || frame.get("method").and_then(Value::as_str).is_none() {
        return Err("cloud_remote_frame_invalid".into());
    }
    Ok(remote.queue_frame(connection_id, frame))
}

#[tauri::command]
pub async fn cloud_remote_activate(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String, activation: Activation) -> Result<(), String> {
    // A machine has no compute to wake: it connects while attached.
    if let Handle::Cloud(supervisor) = remote.supervisor(&connection_id)? {
        supervisor.set_activation(activation);
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_remote_detach(webview: tauri::Webview, remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String) -> Result<(), String> {
    // Behind the frames already handed over, so none of them is lost.
    let holder = webview.label().to_string();
    let (done, detached) = tokio::sync::oneshot::channel();
    if remote.outgoing.send(Outgoing::Detach { connection_id: connection_id.clone(), holder: Some(holder.clone()), done }).is_err() || detached.await.is_err() {
        remote.detach(&connection_id, Some(&holder));
    }
    Ok(())
}

#[cfg(unix)]
#[tauri::command]
pub async fn cloud_ssh_prepare(remote: tauri::State<'_, Arc<CloudRemote>>, org_id: String, workspace_id: String) -> Result<String, String> {
    let service = remote.service.clone();
    tokio::task::spawn_blocking(move || service.prepare_workspace_ssh(&org_id, &workspace_id).map_err(|error| error.code))
        .await.map_err(|error| error.to_string())?
}

#[cfg(unix)]
#[tauri::command]
pub async fn cloud_ssh_finish(
    remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String,
    org_id: String, workspace_id: String, revision: String,
) -> Result<String, String> {
    let host_key = remote.ssh_ports(&connection_id, &org_id, &workspace_id)?.ssh_host_key().await?;
    remote.ssh_ports(&connection_id, &org_id, &workspace_id)?;
    let service = remote.service.clone();
    tokio::task::spawn_blocking(move || service.finish_workspace_ssh(&org_id, &workspace_id, &revision, &host_key).map_err(|error| error.code))
        .await.map_err(|error| error.to_string())?
}

#[cfg(unix)]
#[tauri::command]
pub async fn cloud_ssh_remove(remote: tauri::State<'_, Arc<CloudRemote>>, org_id: String, workspace_id: String) -> Result<(), String> {
    let service = remote.service.clone();
    tokio::task::spawn_blocking(move || service.remove_workspace_ssh(&org_id, &workspace_id).map_err(|error| error.code))
        .await.map_err(|error| error.to_string())?
}

#[cfg(unix)]
fn private_ssh_proxy_socket(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let invalid = || "cloud_workspace_ssh_proxy_socket_invalid".to_string();
    let uid = unsafe { libc::geteuid() };
    let parent = path.parent().ok_or_else(invalid)?;
    let meta = std::fs::symlink_metadata(parent).map_err(|_| invalid())?;
    let socket = std::fs::symlink_metadata(path).map_err(|_| invalid())?;
    let root = std::path::Path::new("/tmp").canonicalize().map_err(|_| invalid())?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o777 != 0o700
        || !socket.file_type().is_socket() || socket.uid() != uid
        || parent.canonicalize().map_err(|_| invalid())?.parent() != Some(root.as_path())
        || !parent.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("terminalx-ssh-"))
        || path.file_name() != Some(std::ffi::OsStr::new("stream"))
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(unix)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStreamRequest {
    connection_id: String,
    org_id: String,
    workspace_id: String,
    scope: String,
    socket: std::path::PathBuf,
    nonce: String,
}

#[cfg(unix)]
#[tauri::command]
pub async fn cloud_ssh_stream(
    remote: tauri::State<'_, Arc<CloudRemote>>, request: SshStreamRequest,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt as _;
    let SshStreamRequest { connection_id, org_id, workspace_id, scope, socket, nonce } = request;
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("cloud_workspace_ssh_proxy_socket_invalid".into());
    }
    let ports = remote.ssh_ports(&connection_id, &org_id, &workspace_id)?;
    let service = remote.service.clone();
    tokio::task::spawn_blocking(move || service.check_workspace_ssh_scope(&org_id, &workspace_id, &scope).map_err(|error| error.code))
        .await.map_err(|error| error.to_string())??;
    private_ssh_proxy_socket(&socket)?;
    let mut stream = tokio::time::timeout(std::time::Duration::from_secs(5), tokio::net::UnixStream::connect(socket))
        .await.map_err(|_| "cloud_workspace_ssh_unavailable")?.map_err(|_| "cloud_workspace_ssh_unavailable")?;
    tokio::time::timeout(std::time::Duration::from_secs(5), stream.write_all(nonce.as_bytes()))
        .await.map_err(|_| "cloud_workspace_ssh_unavailable")?.map_err(|_| "cloud_workspace_ssh_unavailable")?;
    ports.serve_ssh(stream).await;
    Ok(())
}

/// Forward a port of the connection's workspace to this Mac's loopback
/// (PRO-28), on a random free port unless `local_port` names one. Never
/// wakes the workspace: `cloud_port_not_connected` when the connection is
/// not live. `local_port` taken and not `exact`: a random one is used and
/// the answer says `reassigned`. The forward closes when the connection
/// stops being live or the active organization changes.
#[tauri::command]
pub async fn cloud_port_forward(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String, port: u16, local_port: Option<u16>, exact: Option<bool>) -> Result<Forward, String> {
    let scope = remote.scope().map(|scope| scope.active_org_id);
    remote.ports(&connection_id)?.forward(port, local_port, exact.unwrap_or(false), scope).await
}

#[tauri::command]
pub async fn cloud_port_unforward(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String, port: u16) -> Result<bool, String> {
    Ok(remote.ports(&connection_id)?.unforward(port))
}

/// The connection's forwards, each `open` or `waiting`, and whether
/// auto-forward opened it.
#[tauri::command]
pub async fn cloud_port_forwards(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String) -> Result<Vec<Forward>, String> {
    Ok(remote.ports(&connection_id)?.forwards())
}

/// The connection's forwarding switches (PRO-355).
#[tauri::command]
pub async fn cloud_port_settings(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String) -> Result<PortSettings, String> {
    Ok(remote.ports(&connection_id)?.settings())
}

/// Change either switch; answers the switches as they now are. Forwarding
/// off closes every listener and keeps the forwards waiting; auto-forward on
/// forwards ports that start listening from now on. Neither wakes the
/// workspace.
#[tauri::command]
pub async fn cloud_port_set_settings(remote: tauri::State<'_, Arc<CloudRemote>>, connection_id: String, enabled: Option<bool>, auto: Option<bool>) -> Result<PortSettings, String> {
    let scope = remote.scope().map(|scope| scope.active_org_id);
    Ok(remote.ports(&connection_id)?.set_settings(enabled, auto, scope))
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
        ClientState::Reconnecting { close_code, .. } | ClientState::WaitingForRuntime { close_code } => *close_code,
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
    /// `collab.you`: this person's role changed; forwarded, and the key is
    /// fetched if they may now hold it.
    RoleChanged,
    Forward,
}

/// Whether a connection may ask for the workspace content key: a manage
/// attachment always, a participant while its role is not `none`.
fn may_hold_keys(authority: &str, you: Option<&Value>) -> bool {
    authority == "manage" || you.and_then(|you| you.get("role")).and_then(Value::as_str).is_some_and(|role| role != "none")
}

fn intercept(message: &Value) -> Intercept {
    if message.get("id").and_then(Value::as_str).is_some_and(|id| id.starts_with(KEYS_REQUEST_PREFIX)) {
        return Intercept::KeysAnswer;
    }
    if message.get("event").and_then(Value::as_str) == Some("keys.changed") {
        return Intercept::KeysChanged;
    }
    if message.get("event").and_then(Value::as_str) == Some("collab.you") {
        return Intercept::RoleChanged;
    }
    Intercept::Forward
}

#[cfg(test)]
mod intercept_tests {
    use super::*;
    use serde_json::json;

    fn scope(active: &str, members: &[&str], multi_org: bool) -> CloudScope {
        CloudScope {
            user_id: "user".into(),
            profile_id: "profile".into(),
            active_org_id: active.into(),
            multi_org,
            members: members.iter().map(|org| org.to_string()).collect(),
        }
    }

    fn made_in(org: &str) -> Identity {
        Identity { user_id: "user".into(), profile_id: "profile".into(), organization_id: org.into() }
    }

    #[test]
    fn a_default_organization_change_stops_no_connection_on_a_multi_org_server() {
        let (a, b) = (made_in("org-a"), made_in("org-b"));
        let before = scope("org-a", &["org-a", "org-b"], true);
        let after = scope("org-b", &["org-a", "org-b"], true);
        assert!(a.allowed_by(Some(&before)) && b.allowed_by(Some(&before)));
        assert!(a.allowed_by(Some(&after)) && b.allowed_by(Some(&after)), "sessions from both organizations stay open");
    }

    #[test]
    fn a_membership_loss_stops_only_that_organizations_connections() {
        let (a, b) = (made_in("org-a"), made_in("org-b"));
        let left_b = scope("org-a", &["org-a"], true);
        assert!(a.allowed_by(Some(&left_b)));
        assert!(!b.allowed_by(Some(&left_b)));
    }

    #[test]
    fn without_the_capability_only_the_active_organizations_connections_survive() {
        let (a, b) = (made_in("org-a"), made_in("org-b"));
        let switched = scope("org-b", &["org-a", "org-b"], false);
        assert!(!a.allowed_by(Some(&switched)));
        assert!(b.allowed_by(Some(&switched)));
    }

    #[test]
    fn another_user_profile_or_a_sign_out_stops_everything() {
        let a = made_in("org-a");
        let mut other = scope("org-a", &["org-a"], true);
        other.user_id = "user-2".into();
        assert!(!a.allowed_by(Some(&other)));
        let mut profile = scope("org-a", &["org-a"], true);
        profile.profile_id = "profile-2".into();
        assert!(!a.allowed_by(Some(&profile)));
        assert!(!a.allowed_by(None));
    }

    #[test]
    fn a_workspace_that_needs_attention_or_was_deleted_parks_instead_of_failing_the_open() {
        // #1582: a failed open is retried on a backoff for ever; these states never attach, so they park.
        for (state, reason) in [(WorkspaceState::AttentionRequired, "attention-required"), (WorkspaceState::Destroyed, "destroyed")] {
            for activation in [Activation::Connect, Activation::Wake] {
                match open_gate(state, false, activation) {
                    Gate::Answer(OpenOutcome::Unavailable { reason: got }) => assert_eq!(got, reason),
                    _ => panic!("{state:?} at {activation:?} must answer unavailable"),
                }
            }
        }
        // The other states keep their answers.
        assert!(matches!(open_gate(WorkspaceState::Ready, false, Activation::Connect), Gate::Attach));
        assert!(matches!(open_gate(WorkspaceState::Suspended, false, Activation::Connect), Gate::Answer(OpenOutcome::Suspended)));
        assert!(matches!(open_gate(WorkspaceState::Suspended, true, Activation::Connect), Gate::Answer(OpenOutcome::WaitingForRuntime)));
        assert!(matches!(open_gate(WorkspaceState::Suspended, false, Activation::Wake), Gate::Resume));
        assert!(matches!(open_gate(WorkspaceState::Archived, false, Activation::Wake), Gate::Fail("cloud_workspace_archived")));
        assert!(matches!(open_gate(WorkspaceState::Provisioning, false, Activation::Connect), Gate::Answer(OpenOutcome::WaitingForRuntime)));
    }

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
        assert_eq!(intercept(&json!({ "event": "collab.you", "params": { "you": { "role": "viewer" } } })), Intercept::RoleChanged);
    }

    #[test]
    fn only_a_shared_participant_asks_for_keys() {
        assert!(may_hold_keys("manage", None));
        assert!(!may_hold_keys("participate", None));
        assert!(!may_hold_keys("participate", Some(&json!({ "role": "none" }))));
        assert!(may_hold_keys("participate", Some(&json!({ "role": "viewer" }))));
    }

    /// The freeze after a stop and wake: a role refresh was inside a Keychain
    /// write that never returned, and the next send from the window waited
    /// for the account behind it, on the main thread.
    #[test]
    fn a_send_returns_at_once_and_is_delivered_in_order_while_a_role_refresh_is_stuck_saving() {
        use crate::account::AccountContext;
        use crate::keychain::testing::MemorySecrets;
        use std::time::Instant;

        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(AccountContext {
            access_token: "a".into(),
            user_id: "user".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            profile_id: "profile".into(),
            organization_id: "org-a".into(),
            relay_entitled: false,
            generation: 1,
        }));
        let store = MemorySecrets::default();
        account.use_secrets_for_test(Arc::new(store.clone()));
        let dir = tempfile::tempdir().unwrap();
        let agents = Arc::new(CloudAgentClient::with(
            account.clone(),
            Arc::new(crate::cloud_agent_client::MemoryKeys::default()),
            url::Url::parse("http://127.0.0.1:9/").unwrap(),
            dir.path().join("cloud-agent"),
        ));
        let remote = CloudRemote::new(account.clone(), Arc::new(CloudWorkspaceService::new(account.clone())), agents);
        let (supervisor, mut frames) = Supervisor::connected_for_test();
        remote.connections.lock().unwrap().insert("cloud-1".into(), Attached { supervisor: Handle::Cloud(supervisor), ports: PortForwarder::new(|_| false), identity: Some(made_in("org-a")), workspace_id: None });

        store.block_writes();
        let refreshing = {
            let account = account.clone();
            std::thread::spawn(move || account.refresh_roles_for_test("member"))
        };
        store.wait_for_blocked(1);

        // What the main thread does for `cloud_remote_send`.
        let started = Instant::now();
        for n in 0..50 {
            assert!(remote.queue_frame("cloud-1".into(), json!({ "id": format!("r{n}"), "method": "session.input" })));
        }
        assert!(started.elapsed() < Duration::from_secs(1), "the main thread waited");
        // Delivered, in the order sent, with the Keychain still not answering.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut delivered = Vec::new();
        while delivered.len() < 50 {
            match frames.try_recv() {
                Ok(frame) => delivered.push(frame["id"].as_str().unwrap().to_string()),
                Err(_) => {
                    assert!(Instant::now() < deadline, "a send waited for the Keychain: {} of 50 delivered", delivered.len());
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
        }
        assert_eq!(delivered, (0..50).map(|n| format!("r{n}")).collect::<Vec<_>>());
        // A frame for a connection that is not there is dropped, not an error to wait for.
        assert!(remote.queue_frame("cloud-gone".into(), json!({ "id": "x", "method": "session.input" })));

        // A sign-out stops the connection being used at once, Keychain or not.
        account.set_context_for_test(None);
        assert_eq!(remote.supervisor("cloud-1").err().as_deref(), Some("cloud_remote_identity_changed"));

        store.release();
        refreshing.join().unwrap();
    }

    /// A sign-out the Keychain refuses leaves the person signed in. The
    /// watcher looking in the meantime must not have dropped their unsent
    /// commands, transcript cache and keys.
    #[test]
    fn a_refused_sign_out_drops_nothing_even_when_the_watcher_looks_in_the_middle_of_it() {
        use crate::account::AccountContext;
        use crate::cloud_agent_client::{KeyStore, MemoryKeys};
        use crate::keychain::testing::MemorySecrets;

        const KEY_ID: &str = "key-aaaaaaaaaaaaaaaaaaaaaa";
        let account = Arc::new(AccountManager::default());
        account.set_context_for_test(Some(AccountContext {
            access_token: "a".into(),
            user_id: "user".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            profile_id: "profile".into(),
            organization_id: "org-a".into(),
            relay_entitled: false,
            generation: 1,
        }));
        let store = MemorySecrets::default();
        account.use_secrets_for_test(Arc::new(store.clone()));
        let dir = tempfile::tempdir().unwrap();
        let keys = Arc::new(MemoryKeys::default());
        let agents = Arc::new(CloudAgentClient::with(account.clone(), keys.clone(), url::Url::parse("http://127.0.0.1:9/").unwrap(), dir.path().join("cloud-agent")));
        let remote = CloudRemote::new(account.clone(), Arc::new(CloudWorkspaceService::new(account.clone())), agents.clone());
        let attach = |id: &str| {
            let (supervisor, frames) = Supervisor::connected_for_test();
            remote.connections.lock().unwrap().insert(id.into(), Attached { supervisor: Handle::Cloud(supervisor), ports: PortForwarder::new(|_| false), identity: Some(made_in("org-a")), workspace_id: None });
            frames
        };
        let _frames = attach("cloud-1");
        let key = crate::cloud_agents::crypto::b64(&[7u8; 32]);
        let answer = json!({ "currentKeyId": KEY_ID, "keys": [{ "keyId": KEY_ID, "key": key, "createdAt": 1 }] });
        agents.store_keys("user", "org-a", "ws_1", &answer).unwrap();
        agents.cache_save(&account.current_account_key().unwrap(), "org-a", "ws_1", "tab-1", Some(json!({ "events": [1] }))).unwrap();
        let kept_dir = dir.path().join("cloud-agent").join("user").join("org-a").join("ws_1");
        let intact = || kept_dir.join("keys.json").exists() && kept_dir.join("cache.json").exists() && keys.get("org-a", "ws_1", KEY_ID).unwrap().is_some();
        // The watcher has seen who is signed in.
        assert!(remote.drop_previous_identity().is_empty());
        assert!(intact());

        // Sign out; the Keychain takes its time and then refuses.
        store.fail_writes(true);
        store.block_writes();
        let signing_out = {
            let account = account.clone();
            std::thread::spawn(move || account.sign_out_for_test())
        };
        store.wait_for_blocked(1);
        assert!(account.current_scope().is_none(), "out of memory while the Keychain is asked");
        // The watcher looks, more than once: nothing is dropped or stopped.
        for _ in 0..3 {
            assert!(remote.drop_previous_identity().is_empty());
        }
        assert!(intact(), "nothing was purged for a sign-out that is not confirmed");
        assert!(remote.connections.lock().unwrap().contains_key("cloud-1"));
        // Nothing is sent for the account meanwhile.
        assert_eq!(remote.supervisor("cloud-1").err().as_deref(), Some("cloud_remote_identity_changed"));

        store.release();
        assert!(!signing_out.join().unwrap(), "the Keychain refused");
        assert!(account.current_scope().is_some(), "still signed in");
        assert!(remote.drop_previous_identity().is_empty());
        assert!(intact());
        assert!(remote.supervisor("cloud-1").is_ok(), "and the connection is usable again");

        // A sign-out the Keychain confirms does drop it all.
        store.fail_writes(false);
        assert!(account.sign_out_for_test());
        assert_eq!(remote.drop_previous_identity(), vec!["cloud-1".to_string()]);
        assert!(!kept_dir.exists() && keys.get("org-a", "ws_1", KEY_ID).unwrap().is_none());
    }

    /// The exact shape `NativeWorkspaceTransport.route` (src/lib/api.ts) reads;
    /// with snake_case fields it dropped every state and message, so an
    /// opened cloud session stayed "Not connected".
    #[test]
    fn events_reach_the_web_view_in_its_field_names() {
        let state = serde_json::to_value(RemoteEvent::State {
            connection_id: "cloud-1".into(),
            state: ClientState::Connecting { attempt: 2 },
        })
        .unwrap();
        assert_eq!(state, json!({ "kind": "state", "connectionId": "cloud-1", "state": { "state": "connecting", "attempt": 2 } }));
        let message = serde_json::to_value(RemoteEvent::Message { connection_id: "cloud-1".into(), message: json!({ "id": "r1" }) }).unwrap();
        assert_eq!(message, json!({ "kind": "message", "connectionId": "cloud-1", "message": { "id": "r1" } }));
        let changed = serde_json::to_value(RemoteEvent::IdentityChanged { connection_ids: vec!["cloud-1".into()] }).unwrap();
        assert_eq!(changed, json!({ "kind": "identityChanged", "connectionIds": ["cloud-1"] }));
    }

    /// `CloudPortForwardsChanged`, `CloudPortForward` and `CloudPortSettings`
    /// in src/lib/api.ts, field for field.
    #[test]
    fn port_changes_reach_the_web_view_in_its_field_names() {
        use crate::cloud_ports::ForwardState;
        let returned = Forward { port: 5173, local_port: 5173, reassigned: false, state: ForwardState::Open, auto: true };
        let waiting = Forward { port: 3000, local_port: 51234, reassigned: true, state: ForwardState::Waiting, auto: false };
        let changed = PortForwardsChanged::new(
            "machine-1",
            ForwardsChanged { forwards: vec![waiting, returned.clone()], settings: PortSettings { enabled: true, auto: true }, opened: vec![returned] },
        );
        assert_eq!(
            serde_json::to_value(changed).unwrap(),
            json!({
                "connectionId": "machine-1",
                "forwards": [
                    { "port": 3000, "localPort": 51234, "reassigned": true, "state": "waiting", "auto": false },
                    { "port": 5173, "localPort": 5173, "reassigned": false, "state": "open", "auto": true },
                ],
                "settings": { "enabled": true, "auto": true },
                "opened": [{ "port": 5173, "localPort": 5173, "reassigned": false, "state": "open", "auto": true }],
            })
        );
        assert_eq!(PORTS_EVENT, "cloud_port_forwards_changed");
    }
}
