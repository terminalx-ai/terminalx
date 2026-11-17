//! Phones the runtime serves itself (PRO-359; docs/MACHINES.md, decision 4
//! and "As built (PRO-359)").
//!
//! While a window takes phones (`runtime.machineHost.phoneRoute`) the direct
//! listener passes each phone to it, as since PRO-341. While none does (a
//! Mac whose window is closed, or a headless server) the runtime serves the
//! phone here: the same E2EE v2 handshake with the machine's one host key,
//! the same `devices.json` records, the same RPC (`crate::phone`). The
//! owner's operations are called in process, under a lease the runtime holds
//! for the phones it serves, as a window holds one for its own.
//!
//! A headless server pairs a phone from its own terminal
//! (`terminalx-serve pair --phone`): the code is the link Settings → Devices
//! shows, and the person answers Allow in that terminal, after comparing the
//! fingerprint the phone shows.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::control::ControlError;
use crate::local_runtime::client::{AttachmentIdentity, Build};
use crate::local_runtime::mobile::model::{
    AccountMirror, DeviceEntry, DeviceProvenance, DeviceScope, PairingOffer, PairingTransport, APPROVAL_TTL_MS, OFFER_TTL_MS,
};
use crate::local_runtime::mobile::Actor;
use crate::local_runtime::Lifetime;
use crate::machine_wire::{CodeExpiry, CreatedPhoneCode, PendingPhone, PhoneStatus};
use crate::phone::registry::{load_account_mirror, DeviceRegistry};
use crate::phone::rpc::{self, MobileConnection};
use crate::phone::{self, ConnectionSignal, E2eeAuth, Owner, PhoneHost};
use crate::relay_e2ee::{begin_e2ee_session, random_token, token_hash, E2eeHello, HostKeypair};
use crate::session::SessionManager;
use crate::sink::EventSink;

/// How long a phone has for each step of the handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Reasons a `pairing_refused` message gives the phone, as the window's.
const REFUSED_NOT_APPROVED: &str = "not-approved";
const REFUSED_ANOTHER_PHONE: &str = "another-phone";
const REFUSED_CODE_INACTIVE: &str = "code-inactive";

/// The binding generation of the account this Mac is signed in to, as the
/// window last wrote it (`account.json`); 0 signed out. An error when the
/// file cannot be read: nothing is decided on a guess.
fn read_account_generation() -> Result<u64> {
    Ok(load_account_mirror()?.map(|mirror| mirror.binding_generation).unwrap_or(0))
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Whether a desktop app launched this runtime, as `machine.describe` says
/// (`remote::host`). A phone shows a machine without one as a server.
fn has_window() -> bool {
    std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() == Ok("1")
}

/// The owner a phone served here writes through: this runtime's own owner
/// operations (`local_runtime::mobile::execute`), as the actor of the lease
/// held for phones.
struct RuntimeOwner {
    sessions: SessionManager,
    lifetime: Arc<Lifetime>,
    identity: AttachmentIdentity,
    build: Build,
}

impl Owner for RuntimeOwner {
    fn attachment(&self) -> Result<AttachmentIdentity> {
        Ok(self.identity.clone())
    }

    fn mobile(&self, actor: &Actor, method: &str, mut params: Value) -> Result<Value> {
        if actor.epoch != self.identity.epoch || actor.lease != self.identity.lease {
            bail!("The paired-device attachment changed. Reconnect the device.");
        }
        params.as_object_mut().context("Mobile parameters must be an object.")?.insert("actor".into(), serde_json::to_value(actor)?);
        // Admitted as a request on the control socket is.
        let _request = self.lifetime.enter().map_err(|error| anyhow!(error.message))?;
        crate::local_runtime::mobile::execute(&self.sessions, &self.lifetime, method, params)
    }

    fn build(&self) -> &Build {
        &self.build
    }

    fn disconnect(&self) {
        self.lifetime.release(&self.identity.lease);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Approval {
    Waiting,
    Approved,
    Declined,
}

/// A phone that used the live code, waiting for the person's answer.
struct Pending {
    view: PendingPhone,
    /// The key the first waiting connection presented; another is refused.
    phone_key: String,
    outcome: watch::Sender<Approval>,
}

/// The live phone pairing code: the unclaimed device it pairs.
struct Code {
    device_id: String,
    expires_at: i64,
    pending: Option<Pending>,
}

#[derive(Default)]
struct State {
    /// The owner the served phones' grants belong to, once one connected.
    owner: Option<Arc<RuntimeOwner>>,
    /// Open connections per device: their id and how to end them.
    connections: HashMap<String, Vec<(u64, mpsc::UnboundedSender<ConnectionSignal>)>>,
    code: Option<Code>,
}

pub(super) struct TrackedPhone {
    phones: Arc<Phones>,
    device_id: String,
    id: u64,
    revoke_relay_on_close: Arc<AtomicBool>,
}

impl Drop for TrackedPhone {
    fn drop(&mut self) {
        if self.revoke_relay_on_close.load(Ordering::SeqCst) {
            self.phones.revoke_relay(&self.device_id);
        }
        self.phones.untrack(&self.device_id, self.id);
    }
}

#[derive(Clone)]
enum PhoneConnection {
    Direct { auth_id: String },
    Relay { host_id: String, generation: u64, connection: crate::machine_wire::RelayConnection },
}

impl PhoneConnection {
    fn host_id(&self) -> Option<&str> { match self { Self::Direct { .. } => None, Self::Relay { host_id, .. } => Some(host_id) } }
    fn transport_name(&self) -> &'static str { if self.host_id().is_some() { "relay" } else { "direct" } }
    fn transport(&self) -> PairingTransport { if self.host_id().is_some() { PairingTransport::Relay } else { PairingTransport::Direct } }
    fn wire_transport(&self) -> phone::wire::Transport { if self.host_id().is_some() { phone::wire::Transport::Relay } else { phone::wire::Transport::Direct } }
}

pub(crate) struct Phones {
    host: Arc<PhoneHost>,
    sessions: SessionManager,
    lifetime: Arc<Lifetime>,
    registry: DeviceRegistry,
    state: Mutex<State>,
    next: AtomicU64,
    /// [`read_account_generation`] as last read, each tick: the phone RPC
    /// asks for it on every request and event, which must not read a file.
    generation: Arc<AtomicU64>,
    /// Whether the last read succeeded; phones are not judged on a failed one.
    generation_known: AtomicBool,
    /// Tells the machine host its status changed.
    changed: Box<dyn Fn() + Send + Sync>,
    relay: Mutex<Option<Weak<crate::remote::host::RelayHost>>>,
    stopped: watch::Sender<u64>,
}

impl Phones {
    pub(crate) fn new(sessions: SessionManager, sink: Arc<dyn EventSink>, lifetime: Arc<Lifetime>, changed: impl Fn() + Send + Sync + 'static) -> Result<Arc<Self>> {
        // The account binding is the window's, in the shared `account.json`:
        // a sign-out or another account there ends every phone served here at
        // its next request or event, as it does the window's.
        let first = read_account_generation();
        let generation = Arc::new(AtomicU64::new(*first.as_ref().unwrap_or(&0)));
        let current = generation.clone();
        let host = Arc::new(PhoneHost::new(move || current.load(Ordering::SeqCst)));
        // Its notices stay in this process: the window has its own (`phone::sink`).
        host.configure(Arc::new(crate::phone::sink::NoticesInProcess::new(sink)))?;
        Ok(Arc::new(Self {
            host,
            sessions,
            lifetime,
            registry: DeviceRegistry,
            state: Mutex::new(State::default()),
            next: AtomicU64::new(1),
            generation,
            generation_known: AtomicBool::new(first.is_ok()),
            changed: Box::new(changed),
            relay: Mutex::new(None),
            stopped: watch::channel(0).0,
        }))
    }

    pub(crate) fn status(&self) -> PhoneStatus {
        let state = self.state.lock().unwrap();
        let mut connected: Vec<String> = state.connections.iter().filter(|(_, open)| !open.is_empty()).map(|(id, _)| id.clone()).collect();
        connected.sort();
        PhoneStatus {
            connected,
            code: state.code.as_ref().map(|code| CodeExpiry { expires_at: code.expires_at }),
            pending: state.code.as_ref().and_then(|code| code.pending.as_ref()).map(|pending| pending.view.clone()),
            // The machine host knows about windows.
            window_open: false,
        }
    }

    /// The owner of the phones served here, holding a lease for them the
    /// first time one connects, or again after the last one was let go.
    fn owner(&self, epoch: u64, device_id: &str, tracked: u64) -> Result<Arc<RuntimeOwner>> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(*self.stopped.borrow() == epoch, "phone ownership changed during admission");
        anyhow::ensure!(state.connections.get(device_id).is_some_and(|open| open.iter().any(|(id, _)| *id == tracked)), "phone admission was cancelled");
        if let Some(owner) = &state.owner {
            if self.lifetime.attachment(&owner.identity.epoch, &owner.identity.lease).is_ok() {
                return Ok(owner.clone());
            }
        }
        let lease = self.lifetime.hold()?;
        let owner = Arc::new(RuntimeOwner {
            sessions: self.sessions.clone(),
            lifetime: self.lifetime.clone(),
            identity: AttachmentIdentity { epoch: self.lifetime.epoch().to_string(), lease },
            build: Build {
                version: semver::Version::parse(env!("CARGO_PKG_VERSION")).ok(),
                mobile: crate::local_runtime::mobile::features().as_object().cloned().unwrap_or_default(),
                handover: None,
            },
        });
        if let Some(previous) = state.owner.replace(owner.clone()) {
            self.lifetime.release(&previous.identity.lease);
        }
        self.host.set_owner(Some(owner.clone()));
        drop(state);
        Ok(owner)
    }

    /// Fence in-flight admission synchronously with a route or switch change.
    pub(crate) fn invalidate(&self) {
        let _state = self.state.lock().unwrap();
        self.stopped.send_modify(|epoch| *epoch += 1);
    }

    pub(crate) fn use_relay(&self, relay: &Arc<crate::remote::host::RelayHost>) {
        *self.relay.lock().unwrap() = Some(Arc::downgrade(relay));
    }

    pub(crate) fn stopped(&self) -> watch::Receiver<u64> {
        self.stopped.subscribe()
    }

    /// End connections, the live code, and the owner lease and its grants.
    pub(crate) fn stop(&self) {
        self.invalidate();
        let (connections, code) = {
            let mut state = self.state.lock().unwrap();
            if let Some(owner) = state.owner.take() {
                self.host.set_owner(None);
                self.lifetime.release(&owner.identity.lease);
            }
            (std::mem::take(&mut state.connections), state.code.take())
        };
        for (_, signal) in connections.into_values().flatten() {
            let _ = signal.send(ConnectionSignal::Cancel);
        }
        if let Some(code) = code {
            self.end_code(code);
        }
        (self.changed)();
    }

    /// A code ended unused: its device goes, and a phone waiting is refused.
    fn end_code(&self, code: Code) {
        if let Some(pending) = code.pending {
            let _ = pending.outcome.send(Approval::Declined);
        }
        if let Err(error) = self.registry.discard_unclaimed(&code.device_id) {
            log::warn!("machine host: discard an unused phone code: {error:#}");
        }
    }

    /// Close the connections of phones no longer paired: revoked from the
    /// window or `devices revoke` with no runtime to ask, or removed at
    /// sign-out. Their requests are refused already; this ends the idle ones
    /// and their grants too. Blocking: it reads `devices.json`.
    fn close_unpaired(&self) {
        let connected: Vec<String> = self.state.lock().unwrap().connections.keys().cloned().collect();
        if connected.is_empty() || !self.generation_known.load(Ordering::SeqCst) {
            return;
        }
        let paired = match self.registry.list() {
            Ok(paired) => paired,
            Err(error) => {
                log::warn!("machine host: read the paired phones: {error:#}");
                return;
            }
        };
        let generation = self.generation.load(Ordering::SeqCst);
        for device_id in connected {
            let current = paired.iter().find(|device| device.id == device_id);
            let stale = current.is_none_or(|device| device.provenance == DeviceProvenance::Automatic && device.binding_generation != generation);
            if stale {
                log::info!("machine host: phone {device_id} is no longer paired; closing it");
                self.end_grants(&device_id);
                self.close(&device_id, ConnectionSignal::Cancel);
                self.revoke_relay(&device_id);
            }
        }
    }

    fn revoke_relay(&self, device_id: &str) {
        if let Some(relay) = self.relay.lock().unwrap().as_ref().and_then(Weak::upgrade) {
            relay.revoke_device(device_id);
        }
    }

    /// Read the account generation again. A failed read keeps the last one
    /// and judges no phone by it.
    fn read_generation(&self) -> bool {
        match read_account_generation() {
            Ok(generation) => {
                let changed = self.generation.swap(generation, Ordering::SeqCst) != generation;
                self.generation_known.store(true, Ordering::SeqCst);
                changed
            }
            Err(error) => {
                if self.generation_known.swap(false, Ordering::SeqCst) {
                    log::warn!("machine host: read the account for phones: {error:#}");
                }
                false
            }
        }
    }

    /// A code or a request that ran out ends, and phones no longer paired
    /// are let go. Blocking: it may write `devices.json`.
    pub(crate) fn tick(&self, now: i64) {
        let account_changed = self.read_generation();
        self.close_unpaired();
        if account_changed {
            // Retire stale automatic relay credentials before cancelling all
            // streams, so their tracking guards cannot hide them from the tick.
            // Fence handshakes too, and give reconnects a fresh lease: generation
            // 0 at sign-out cannot reuse earlier signed-in mobile authority.
            let mut state = self.state.lock().unwrap();
            self.stopped.send_modify(|epoch| *epoch += 1);
            if let Some(owner) = state.owner.take() {
                self.host.set_owner(None);
                self.lifetime.release(&owner.identity.lease);
            }
        }
        let ended = {
            let mut state = self.state.lock().unwrap();
            if let Some(pending) = state.code.as_ref().and_then(|code| code.pending.as_ref()) {
                if pending.view.expires_at <= now {
                    let _ = pending.outcome.send(Approval::Declined);
                    let code = state.code.take();
                    code.map(|mut code| {
                        code.pending = None;
                        code
                    })
                } else {
                    None
                }
            } else if state.code.as_ref().is_some_and(|code| code.expires_at <= now) {
                state.code.take()
            } else {
                None
            }
        };
        if let Some(code) = ended {
            self.end_code(code);
            (self.changed)();
        }
    }

    /// Make a phone pairing code, ending any made before. `port` is the
    /// direct listener's. Blocking: it writes `devices.json`.
    pub(crate) fn create_code(&self, keypair: &HostKeypair, port: u16) -> Result<CreatedPhoneCode, ControlError> {
        crate::data_privacy::require_network().map_err(|error| ControlError::new("not_enabled", format!("{error:#}"), None::<String>))?;
        let endpoints = crate::direct_endpoints::machine_endpoints(port, "");
        let Some(endpoint) = endpoints.first().cloned() else {
            return Err(ControlError::new("no_address", "This machine has no network address a phone can reach.", None::<String>));
        };
        if let Some(previous) = self.state.lock().unwrap().code.take() {
            self.end_code(previous);
        }
        let device_id = uuid::Uuid::new_v4().simple().to_string();
        let token = random_token();
        let entry = DeviceEntry {
            id: device_id.clone(),
            label: "TerminalX Mobile".into(),
            platform: "mobile".into(),
            token: token_hash(&token),
            scope: DeviceScope::Driver,
            provenance: DeviceProvenance::Explicit,
            bound_user_id: None,
            binding_generation: 0,
            public_key: String::new(),
            created_at: Utc::now().to_rfc3339(),
            last_seen_at: None,
            revoked_at: None,
            installation_id: None,
            created_request_id: None,
            fingerprint: None,
            approved_at: None,
            connection: None,
            last_seen_transport: None,
        };
        self.registry.add(entry).map_err(ControlError::internal)?;
        // Start with a direct pairing. Once authenticated, the phone can
        // discover the runtime's relay and provision its resume credential.
        let offer = PairingOffer {
            v: 2,
            endpoint,
            direct_endpoints: endpoints,
            device_token: token,
            public_key_b64: keypair.public_key_b64(),
            paired_device_id: device_id.clone(),
            scope: "mobile".into(),
            identity_mode: "inherit".into(),
            relay: None,
        };
        let link = match phone::encode_pairing_offer(&offer, crate::machine_name::computer_name().as_deref()) {
            Ok(link) => link,
            Err(error) => {
                let _ = self.registry.discard_unclaimed(&device_id);
                return Err(ControlError::internal(error));
            }
        };
        let expires_at = now_ms() + OFFER_TTL_MS;
        self.state.lock().unwrap().code = Some(Code { device_id, expires_at, pending: None });
        (self.changed)();
        Ok(CreatedPhoneCode { link, expires_at, machine_id: keypair.host_id() })
    }

    /// The person allowed the phone waiting with `request_id`: it is pinned
    /// to the key whose fingerprint they compared. Blocking.
    pub(crate) fn approve(&self, request_id: &str) -> Result<(), ControlError> {
        let mut state = self.state.lock().unwrap();
        let not_found = || ControlError::new("not_found", "No phone is waiting with that request.", None::<String>);
        let code = state.code.as_ref().ok_or_else(not_found)?;
        let pending = code.pending.as_ref().filter(|pending| pending.view.request_id == request_id && pending.view.expires_at > now_ms()).ok_or_else(not_found)?;
        self.registry
            .approve(&pending.view.device_id, &pending.view.fingerprint, &pending.phone_key)
            .map_err(ControlError::internal)?;
        let _ = pending.outcome.send(Approval::Approved);
        // Approved, the device connects as any paired phone: the code is done.
        state.code = None;
        drop(state);
        (self.changed)();
        Ok(())
    }

    /// The person did not allow it: the phone is refused and the code ends.
    pub(crate) fn decline(&self, request_id: &str) {
        let code = {
            let mut state = self.state.lock().unwrap();
            if state.code.as_ref().and_then(|code| code.pending.as_ref()).is_some_and(|pending| pending.view.request_id == request_id) {
                state.code.take()
            } else {
                None
            }
        };
        if let Some(code) = code {
            self.end_code(code);
            (self.changed)();
        }
    }

    /// Remove a paired phone: its record is revoked, its grants end and its
    /// connections close. Whether it was paired. Blocking.
    pub(crate) fn revoke(&self, device_id: &str) -> Result<bool> {
        let revoked = self.registry.revoke(device_id)?.is_some();
        self.end_grants(device_id);
        self.close(device_id, ConnectionSignal::Cancel);
        self.revoke_relay(device_id);
        Ok(revoked)
    }

    /// The device's grants under the phones' lease end, with any input they queued.
    fn end_grants(&self, device_id: &str) {
        let Some(owner) = self.state.lock().unwrap().owner.clone() else { return };
        let actor = Actor {
            epoch: owner.identity.epoch.clone(),
            lease: owner.identity.lease.clone(),
            generation: self.generation.load(Ordering::SeqCst),
            user_id: load_account_mirror().ok().flatten().map(|mirror| mirror.user_id),
        };
        if let Err(error) = owner.mobile(&actor, "revoke", json!({ "deviceId": device_id })) {
            log::warn!("machine host: end a revoked phone's grants: {error:#}");
            owner.disconnect();
        }
    }

    fn close(&self, device_id: &str, signal: ConnectionSignal) {
        let open = self.state.lock().unwrap().connections.remove(device_id).unwrap_or_default();
        for (_, sender) in open {
            let _ = sender.send(signal);
        }
        (self.changed)();
    }

    fn track(&self, device_id: &str) -> (u64, mpsc::UnboundedReceiver<ConnectionSignal>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::unbounded_channel();
        self.state.lock().unwrap().connections.entry(device_id.to_string()).or_default().push((id, sender));
        (self.changed)();
        (id, receiver)
    }

    /// Track before rereading credentials and account binding. If a revoke or
    /// account-change tick already ran, the fresh read rejects the snapshot;
    /// if it runs after tracking, it sees this connection and cancels it.
    /// Blocking: admission reads both shared files before acquiring an owner.
    pub(super) fn admit(self: &Arc<Self>, device: &DeviceEntry, client_key: &str, epoch: u64) -> Result<(TrackedPhone, mpsc::UnboundedReceiver<ConnectionSignal>)> {
        let (id, signals) = self.track(&device.id);
        let tracked = TrackedPhone { phones: self.clone(), device_id: device.id.clone(), id, revoke_relay_on_close: Arc::new(AtomicBool::new(false)) };
        let account = load_account_mirror().context("reread the account during phone admission")?;
        let current = self.registry.list()?.into_iter().find(|current| current.id == device.id).context("paired device was revoked during admission")?;
        anyhow::ensure!(current.token == device.token
            && current.scope == device.scope
            && current.provenance == device.provenance
            && current.bound_user_id == device.bound_user_id
            && current.binding_generation == device.binding_generation
            && current.public_key == client_key, "paired-device identity changed during admission");
        anyhow::ensure!(account_allows(&current, account.as_ref()), "paired-device account changed during admission");
        self.owner(epoch, &device.id, id)?;
        Ok((tracked, signals))
    }

    fn untrack(&self, device_id: &str, id: u64) {
        {
            let mut state = self.state.lock().unwrap();
            if let Some(open) = state.connections.get_mut(device_id) {
                open.retain(|(tracked, _)| *tracked != id);
                if open.is_empty() {
                    state.connections.remove(device_id);
                }
            }
            if state.connections.is_empty() {
                if let Some(owner) = state.owner.take() {
                    self.host.set_owner(None);
                    self.lifetime.release(&owner.identity.lease);
                }
            }
        }
        (self.changed)();
    }

    /// Serve one phone that reached the direct listener on `port`.
    pub(crate) async fn serve<S>(self: Arc<Self>, keypair: HostKeypair, stream: S, port: u16, mut stopped: watch::Receiver<u64>, epoch: u64) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        tokio::select! {
            biased;
            _ = stopped.changed() => Ok(()),
            result = async {
                let socket = tokio_tungstenite::accept_async_with_config(stream, Some(phone::pairing_websocket_config())).await?;
                self.serve_socket(keypair, socket, port, PhoneConnection::Direct { auth_id: uuid::Uuid::new_v4().to_string() }, epoch).await
            } => result,
        }
    }

    pub(crate) async fn serve_relay(self: Arc<Self>, keypair: HostKeypair, forwarded: crate::machine_wire::Forwarded, port: u16, epoch: u64) -> Result<()> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let crate::machine_wire::Forwarded::Relay { cell_url, relay_host_id, generation, connection } = forwarded else {
            bail!("expected a relay connection");
        };
        anyhow::ensure!(keypair.host_id() == relay_host_id, "relay connection named a different host key");
        anyhow::ensure!(crate::remote::host::valid_opaque_id(&connection.conn_id)
            && crate::remote::host::valid_opaque_id(&connection.relay_device_id)
            && crate::remote::host::valid_base64url_32(&connection.conn_ticket)
            && matches!(connection.kind.as_str(), "invite" | "resume")
            && (1..=60_000).contains(&connection.attach_deadline_ms), "invalid relay connection");
        let context = PhoneConnection::Relay { host_id: relay_host_id, generation, connection: connection.clone() };
        self.current_relay(&context)?;
        let url = crate::remote::host::websocket_url(&cell_url, &format!("/v1/host/data/{}", connection.conn_id))?;
        let request = url.into_client_request()?;
        let (mut socket, _) = tokio::time::timeout(Duration::from_millis(connection.attach_deadline_ms),
            crate::data_privacy::connect(request, Some(phone::pairing_websocket_config()), false)).await??;
        socket.send(Message::Text(json!({ "type":"host-data-auth", "v":1, "connTicket":connection.conn_ticket, "generation":generation }).to_string().into())).await?;
        self.serve_socket(keypair, socket, port, context, epoch).await
    }

    async fn serve_socket<S>(self: Arc<Self>, keypair: HostKeypair, mut socket: WebSocketStream<S>, port: u16, context: PhoneConnection, epoch: u64) -> Result<()>
    where S: AsyncRead + AsyncWrite + Unpin,
    {
        let hello = match tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.next()).await.context("no E2EE hello")? {
            Some(Ok(Message::Text(text))) => text,
            _ => bail!("closed before the E2EE hello"),
        };
        let hello: E2eeHello = serde_json::from_str(&hello).context("decode E2EE hello")?;
        let (ready, mut session) = begin_e2ee_session(&keypair, hello, context.transport_name(), context.host_id())?;
        socket.send(Message::Text(serde_json::to_string(&ready)?.into())).await?;
        let auth = match tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.next()).await.context("no E2EE authentication")? {
            Some(Ok(frame)) => E2eeAuth::open(frame, &mut session)?,
            _ => bail!("closed before E2EE authentication"),
        };
        let lookup = self.clone();
        let device = tokio::task::spawn_blocking(move || {
            // An unreadable account admits nobody, rather than every generation.
            let account = load_account_mirror().context("read the account for a phone")?;
            let generation = account.as_ref().map(|mirror| mirror.binding_generation).unwrap_or(0);
            let device = lookup.registry.find_by_token(&auth.device_token, Some(generation))?;
            Ok::<_, anyhow::Error>(device.filter(|device| account_allows(device, account.as_ref())))
        })
        .await??
        .ok_or_else(|| anyhow!("paired-device credential was refused"))?;
        if let PhoneConnection::Relay { connection, .. } = &context {
            anyhow::ensure!(connection.relay_device_id == device.id, "relay invite was used by a different device credential");
        }
        // Session invitations belong to the window that shared the session.
        if device.scope == DeviceScope::Session {
            bail!("Session credentials are valid only for an active session invitation.");
        }
        let client_key = session.client_public_key_b64.clone();
        let fingerprint = crate::pairing_fingerprint::fingerprint_b64(keypair.public(), &client_key, &device.token)?;
        if let Some(reason) = self.await_approval(&mut socket, &device, &client_key, &fingerprint).await? {
            let _ = phone::send_encrypted_text(&mut socket, &mut session, &phone::pairing_refused(reason).to_string()).await;
            let _ = socket.close(None).await;
            bail!("the pairing was refused on this machine ({reason})");
        }
        let transport = context.transport();
        let touch = self.clone();
        let (device_id, key, print) = (device.id.clone(), client_key.clone(), fingerprint.clone());
        tokio::task::spawn_blocking(move || touch.registry.touch(&device_id, &key, &print, transport)).await??;
        anyhow::ensure!(*self.stopped.borrow() == epoch, "phone ownership changed during authentication");
        if matches!(context, PhoneConnection::Relay { .. }) { self.current_relay(&context)?; }
        let admitting = self.clone();
        let (admitting_device, admitting_key) = (device.clone(), client_key);
        let (_tracked, signals) = tokio::task::spawn_blocking(move || admitting.admit(&admitting_device, &admitting_key, epoch)).await??;
        let result = async {
            let (outbound, inbound) = mpsc::channel(8);
            let connection = Arc::new(MobileConnection::open(&self.host, &device, outbound, context.wire_transport()).await?);
            connection.check_off_runtime(&self.host).await?;
            phone::send_authenticated(&mut socket, &mut session).await?;
            log::info!("machine host: phone {} connected through {}", device.id, context.transport_name());
            phone::serve_connection(&mut socket, &mut session, &self.host, &connection, inbound, signals, |request| {
                let (phones, device, connection, context, revoke_relay_on_close) = (self.clone(), &device, &connection, &context, &_tracked.revoke_relay_on_close);
                async move { phones.respond(&request, device, connection, port, context, revoke_relay_on_close).await }
            })
            .await
        }
        .await;
        result
    }

    /// Hold a phone that used the code until the person answers in the
    /// terminal. `None` lets it in; otherwise the reason it is refused.
    async fn await_approval<S>(&self, socket: &mut WebSocketStream<S>, device: &DeviceEntry, phone_key: &str, fingerprint: &str) -> Result<Option<&'static str>>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        if device.provenance != DeviceProvenance::Explicit || device.approved_at.is_some() || device.last_seen_at.is_some() {
            return Ok(None);
        }
        let mut outcome = {
            let mut state = self.state.lock().unwrap();
            // Read again under the lock `approve` saves under: a racing
            // connection of the same phone may have been allowed since.
            let current = self.registry.list()?.into_iter().find(|saved| saved.id == device.id);
            if current.is_some_and(|saved| saved.approved_at.is_some() || saved.last_seen_at.is_some()) {
                return Ok(None);
            }
            let now = now_ms();
            let Some(code) = state.code.as_mut().filter(|code| code.device_id == device.id && code.expires_at > now) else {
                return Ok(Some(REFUSED_CODE_INACTIVE));
            };
            match &code.pending {
                Some(pending) if pending.phone_key != phone_key => return Ok(Some(REFUSED_ANOTHER_PHONE)),
                Some(pending) => pending.outcome.subscribe(),
                None => {
                    let (sender, receiver) = watch::channel(Approval::Waiting);
                    code.pending = Some(Pending {
                        view: PendingPhone {
                            request_id: uuid::Uuid::new_v4().simple().to_string(),
                            device_id: device.id.clone(),
                            fingerprint: fingerprint.into(),
                            requested_at: now,
                            expires_at: now + APPROVAL_TTL_MS,
                        },
                        phone_key: phone_key.into(),
                        outcome: sender,
                    });
                    receiver
                }
            }
        };
        (self.changed)();
        loop {
            tokio::select! {
                // Copied out at once: the watch guard must not be held across an await.
                decided = async { outcome.wait_for(|state| *state != Approval::Waiting).await.map(|state| *state) } => {
                    return Ok(match decided {
                        Ok(Approval::Approved) => None,
                        Ok(_) => Some(REFUSED_NOT_APPROVED),
                        Err(_) => bail!("the pairing request ended without an answer"),
                    });
                }
                incoming = socket.next() => match incoming {
                    Some(Ok(Message::Ping(bytes))) => socket.send(Message::Pong(bytes)).await?,
                    Some(Ok(Message::Pong(_) | Message::Frame(_))) => {}
                    _ => bail!("the phone closed or spoke before the pairing was approved"),
                },
            }
        }
    }

    fn current_relay(&self, context: &PhoneConnection) -> Result<(Arc<crate::remote::host::RelayHost>, crate::remote::host::Registration)> {
        let relay = self.relay.lock().unwrap().as_ref().and_then(Weak::upgrade).context("relay control is not active")?;
        let registration = relay.registration().context("relay control is not active")?;
        if let PhoneConnection::Relay { host_id, generation, .. } = context {
            anyhow::ensure!(registration.relay_host_id == *host_id && registration.generation == *generation, "relay connection belongs to a stale host assignment");
        }
        Ok((relay, registration))
    }

    async fn control(&self, context: &PhoneConnection, frame: Value) -> Result<Value> {
        let (relay, registration) = self.current_relay(context)?;
        let receive = relay.forward_control(frame)?;
        let reply = rpc::off_runtime(move || receive.recv_timeout(HANDSHAKE_TIMEOUT).context("relay control did not answer")?).await?;
        let (_, current) = self.current_relay(context)?;
        anyhow::ensure!(current == registration, "relay registration changed during the request");
        anyhow::ensure!(reply["type"] != "control-error", "relay control refused the request");
        let mut reply = reply;
        if let Some(object) = reply.as_object_mut() { object.remove("type"); }
        if let Some(object) = reply.get_mut("result").and_then(Value::as_object_mut) { object.remove("type"); }
        Ok(reply)
    }

    async fn provision_relay(&self, device: &DeviceEntry, context: &PhoneConnection, params: &Value) -> Result<Value> {
        let req_id = opaque_param(params, "reqId")?;
        let hash = params["newResumeTokenHash"].as_str().filter(|value| crate::remote::host::valid_base64url_32(value)).context("newResumeTokenHash is required")?;
        let authorization = match context {
            PhoneConnection::Direct { auth_id } => json!({"mode":"authenticated-direct", "directAuthId":auth_id}),
            PhoneConnection::Relay { connection, .. } if connection.kind == "invite" => json!({"mode":"relay-basis", "basisConnId":connection.conn_id}),
            _ => bail!("relay provisioning is unavailable on this connection"),
        };
        let mut frame = json!({"type":"device-credential-install", "v":1, "reqId":req_id, "relayDeviceId":device.id, "newResumeTokenHash":hash, "authorization":authorization});
        if let Some(expected) = params.get("expectedCurrentHash").filter(|value| !value.is_null()) {
            anyhow::ensure!(expected.as_str().is_some_and(crate::remote::host::valid_base64url_32), "invalid expectedCurrentHash");
            frame["expectedCurrentHash"] = expected.clone();
        }
        self.control(context, frame).await
    }

    async fn endpoints(&self, device: &DeviceEntry, context: &PhoneConnection, params: &Value, port: u16) -> Result<Value> {
        let mut result = json!({"v":1, "directEndpoints":crate::direct_endpoints::machine_endpoints(port, ""), "relay":null});
        if self.relay.lock().unwrap().as_ref().and_then(Weak::upgrade).is_none_or(|relay| !relay.is_registered()) {
            return Ok(result);
        }
        let (_, registration) = self.current_relay(context)?;
        result["relay"] = json!({"v":1, "directorUrl":registration.director_url, "cellUrl":registration.cell_url, "assignmentEpoch":registration.assignment_epoch, "relayHostId":registration.relay_host_id, "e2eeFraming":2});
        if params.get("installReqId").is_some_and(|value| !value.is_null()) {
            result["installStatus"] = self.control(context, json!({"type":"device-credential-install-status", "v":1, "reqId":opaque_param(params, "installReqId")?, "relayDeviceId":device.id})).await?;
        }
        if params.get("resumeConfirmReqId").is_some_and(|value| !value.is_null()) {
            let PhoneConnection::Relay { connection, .. } = context else { bail!("resume confirmation is unavailable on a direct connection") };
            anyhow::ensure!(connection.kind == "resume", "resume confirmation requires a resume credential");
            result["resumeConfirmation"] = self.control(context, json!({"type":"device-resume-confirm", "v":1, "reqId":opaque_param(params, "resumeConfirmReqId")?, "basisConnId":connection.conn_id})).await?;
        }
        Ok(result)
    }

    /// One request of a phone served here.
    async fn respond(self: Arc<Self>, request: &Value, device: &DeviceEntry, connection: &Arc<MobileConnection>, port: u16, context: &PhoneConnection, revoke_relay_on_close: &AtomicBool) -> Value {
        let id = phone::request_id(request);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if !phone::allowed_method(device.scope, method) {
            return phone::static_rpc_response(request, device.scope);
        }
        let result = match method {
            "pairing.provisionRelay" => self.provision_relay(device, context, &request["params"]).await,
            "pairing.getEndpoints" => self.endpoints(device, context, &request["params"], port).await,
            "host.describe" => Ok(phone::host_description(crate::machine_name::computer_name(), has_window())),
            // The phone unpairs itself, and only itself.
            "pairing.forget" => {
                // The local fence applies now. Retire the relay credential when
                // this connection closes, so its cancellation cannot race the
                // shared phone loop's acknowledgement of the forget request.
                revoke_relay_on_close.store(true, Ordering::SeqCst);
                let (phones, device_id) = (self.clone(), device.id.clone());
                rpc::off_runtime(move || {
                    phones.registry.revoke(&device_id)?;
                    phones.end_grants(&device_id);
                    Ok(())
                })
                .await
                .map(|()| {
                    // Closed after this reply goes out.
                    self.close(&device.id, ConnectionSignal::Cancel);
                    json!({ "forgotten": true })
                })
            }
            "device.describe" => match phone::device_description(request.get("params")) {
                Ok((label, platform)) => {
                    let (phones, device_id) = (self.clone(), device.id.clone());
                    rpc::off_runtime(move || phones.registry.describe(&device_id, &label, &platform)).await.map(|()| json!({ "ok": true }))
                }
                Err(error) => Err(error),
            },
            _ => {
                let (host, connection, asked, asking) = (self.host.clone(), connection.clone(), request.clone(), device.clone());
                match rpc::off_runtime(move || Ok(rpc::dispatch(&host, &connection, &asked, &asking))).await {
                    Ok(Some(result)) => result,
                    Ok(None) => return phone::static_rpc_response(request, device.scope),
                    Err(error) => Err(error),
                }
            }
        };
        match result {
            Ok(result) => rpc::success_response(&id, result),
            Err(error) => phone::error_response(&id, &error),
        }
    }
}

fn opaque_param<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params[name].as_str().filter(|value| crate::remote::host::valid_opaque_id(value)).with_context(|| format!("{name} is required"))
}

fn account_allows(device: &DeviceEntry, account: Option<&AccountMirror>) -> bool {
    match account {
        Some(account) => device.bound_user_id.as_deref().is_none_or(|user| user == account.user_id)
            && (device.provenance == DeviceProvenance::Explicit
                || (device.bound_user_id.as_deref() == Some(account.user_id.as_str())
                    && device.binding_generation == account.binding_generation)),
        None => device.provenance == DeviceProvenance::Explicit && device.bound_user_id.is_none(),
    }
}
