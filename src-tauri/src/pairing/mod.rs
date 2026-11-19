//! Optional account binding, pairing, and end-to-end encrypted transport.
//!
//! Network I/O starts for saved pairings, an account session, or an explicitly
//! requested pairing code.

mod cloud;
mod crypto;
mod diagnostics;
mod direct;
use crate::pairing_fingerprint as fingerprint;
mod guest;
mod host_poll;
mod machine_grants;
mod machine_route;
use crate::phone::rpc as mobile;
use crate::local_runtime::mobile::model;
use crate::machine_name::{computer_name, recent_computer_name, resolve_machine_name, PLACEHOLDER_HOST_NAME};
#[cfg(test)]
use crate::machine_name::presentable_name;
#[cfg(test)]
use crate::machine_name::{COMPUTER_NAME_MAX_CHARS, UNNAMED_HOST};
mod registry;
mod relay;
pub(crate) mod sharing;
use crate::phone::wire;
use crate::phone::{
    allowed_method, decode_canonical_base64, error_response, host_description, pairing_refused,
    pairing_websocket_config, request_id, send_encrypted_text, static_rpc_response, ConnectionSignal, E2eeAuth,
    PhoneHost,
};
#[cfg(test)]
use crate::phone::disconnected_notification;
#[cfg(test)]
use self::crypto::PayloadKind;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    tungstenite::Message,
    WebSocketStream,
};
use uuid::Uuid;

use crate::account::{AccountContext, AccountManager};
use crate::session::SessionManager;
use crate::sink::EventSink;

use self::crypto::{
    begin_e2ee_session, encode_pairing_offer, random_token, seal_account_offer, token_hash,
    E2eeHello, HostKeypair,
};
use self::model::{
    AccountMirror, AccountPairingGrant, DeviceEntry, DeviceProvenance, DeviceScope,
    HostBindingPayload, HostMetadata, PairedDeviceConnection, PairingApprovalRequest, PairingCode,
    PairingOffer, PairingTransport, RelayStatus, APPROVAL_TTL_MS, OFFER_TTL_MS,
};
pub use self::model::{MachineName, PairingConnectionMode, PairingStatus, RelayPhase};
use self::registry::{DeviceRegistry, PairingSecrets};
use crate::direct_endpoints::advertised_endpoints;
use self::relay::{ConnectionOpen, DeviceCredentialInstallAuthorization, RelayLive};

pub const STATUS_EVENT: &str = "pairing_status";

#[derive(Default)]
struct Inner {
    relay: Option<RelayLive>,
    relay_status: RelayStatus,
    host: Option<HostMetadata>,
    active_pairing: Option<PairingCode>,
    pending_pairing_device: Option<String>,
    /// The pending device's phone waits for the person to approve it here.
    /// Dropping it declines every connection that waits on it.
    pending_approval: Option<PendingApproval>,
    /// Phones can reach this window directly: on its own listener, or
    /// through the runtime's (`direct_via_runtime`, PRO-341).
    direct_listener_started: bool,
    direct_listener_retrying: bool,
    /// Something asked for direct connections (saved phones, a pairing code),
    /// so they come back when the runtime gives the port up again.
    direct_wanted: bool,
    direct_via_runtime: bool,
    /// The window's own listener on the port.
    direct_accept: Option<tauri::async_runtime::JoinHandle<()>>,
    last_error: Option<String>,
}

impl Inner {
    /// The device's code is spent: no approval waits on it any more.
    fn forget_pending(&mut self, device_id: &str) {
        if self.pending_approval.as_ref().is_some_and(|pending| pending.request.device_id == device_id) {
            self.pending_approval = None;
        }
        if self.pending_pairing_device.as_deref() == Some(device_id) {
            self.pending_pairing_device = None;
            self.active_pairing = None;
        }
    }
}

pub struct PairingManager {
    guest: guest::GuestClient,
    account: Arc<AccountManager>,
    diagnostics: Mutex<diagnostics::DiagnosticLog>,
    secrets: PairingSecrets,
    registry: DeviceRegistry,
    /// Fixed in the app; startup fixtures use an isolated port.
    direct_port: u16,
    sink: OnceLock<Arc<dyn EventSink>>,
    /// Set once the session manager exists, which is after `configure`.
    sessions: OnceLock<SessionManager>,
    runtime: Mutex<Option<Arc<crate::local_runtime::desktop::Desktop>>>,
    inner: Mutex<Inner>,
    epoch: AtomicU64,
    sharing_blocked_generation: AtomicU64,
    stopped: AtomicBool,
    relay_retry: tokio::sync::Notify,
    suspended_account_token: Mutex<Option<String>>,
    /// Live connections by device id. Released before any other lock of the
    /// manager is taken, as `keep_awake` is.
    connections: Mutex<HashMap<String, Vec<LiveConnection>>>,
    connection_serial: AtomicU64,
    /// The phone protocol this window serves (`crate::phone`).
    phone: Arc<PhoneHost>,
    /// `APPROVAL_TTL_MS` in the app; fixtures wait less.
    approval_ttl_ms: i64,
    /// This Mac's public key once it was read, so a status can show the
    /// fingerprint of a phone paired before PRO-314 without a Keychain call.
    host_public: Mutex<Option<[u8; 32]>>,
    keep_awake: Mutex<KeepAwake>,
    /// Whether the runtime hosts operating computers, and so owns the port.
    machine: Mutex<machine_route::MachineSide>,
}

/// Reasons a `pairing_refused` message gives the phone.
const REFUSED_NOT_APPROVED: &str = "not-approved";
const REFUSED_ANOTHER_PHONE: &str = "another-phone";
const REFUSED_CODE_INACTIVE: &str = "code-inactive";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Approval {
    Waiting,
    Approved,
    Declined,
}

struct PendingApproval {
    request: PairingApprovalRequest,
    /// The phone key the first waiting connection presented; another key is refused.
    phone_key: String,
    outcome: tokio::sync::watch::Sender<Approval>,
}

struct LiveConnection {
    serial: u64,
    signal: mpsc::UnboundedSender<ConnectionSignal>,
    transport: PairingTransport,
    since: DateTime<Utc>,
}

/// Untracks its connection when the connection's handler returns.
struct ConnectionGuard {
    manager: Arc<PairingManager>,
    device_id: String,
    serial: u64,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.manager.untrack_connection(&self.device_id, self.serial);
    }
}

#[derive(Default)]
struct KeepAwake {
    /// `settings.pairing.keepAwake`, read once and after the file changes.
    enabled: Option<bool>,
    assertion: Option<crate::power::Assertion>,
}

#[derive(Clone, Debug)]
enum PairingConnectionContext {
    Direct {
        direct_auth_id: String,
        forwarded_id: Option<String>,
    },
    Relay {
        relay_host_id: String,
        credential_kind: String,
        basis_conn_id: String,
    },
}

impl PairingManager {
    pub fn new(account: Arc<AccountManager>) -> Self {
        let phone = Arc::new(PhoneHost::new({
            let account = account.clone();
            move || account.current_generation()
        }));
        Self {
            guest: guest::GuestClient::default(),
            account,
            diagnostics: Mutex::new(diagnostics::DiagnosticLog::default()),
            secrets: PairingSecrets::default(),
            registry: DeviceRegistry,
            direct_port: direct::PORT,
            sink: OnceLock::new(),
            sessions: OnceLock::new(),
            runtime: Mutex::new(None),
            inner: Mutex::new(Inner::default()),
            epoch: AtomicU64::new(0),
            sharing_blocked_generation: AtomicU64::new(u64::MAX),
            stopped: AtomicBool::new(false),
            relay_retry: tokio::sync::Notify::new(),
            suspended_account_token: Mutex::new(None),
            connections: Mutex::new(HashMap::new()),
            connection_serial: AtomicU64::new(1),
            phone,
            approval_ttl_ms: APPROVAL_TTL_MS,
            host_public: Mutex::new(None),
            keep_awake: Mutex::new(KeepAwake::default()),
            machine: Mutex::default(),
        }
    }

    pub fn configure(
        self: &Arc<Self>,
        sink: Arc<dyn EventSink>,
        log_dir: Option<std::path::PathBuf>,
        app_identifier: &str,
    ) -> Result<()> {
        match log_dir {
            Some(directory) => {
                if self.diagnostics.lock().unwrap().configure(directory).is_err() {
                    log::warn!("relay diagnostics unavailable (category=local-storage)");
                }
            }
            None => log::warn!("relay diagnostics unavailable (category=local-storage)"),
        }
        self.secrets.configure(app_identifier)?;
        let unclaimed = self.registry.remove_unclaimed()?;
        if !unclaimed.is_empty() {
            // This runs on the main thread at launch; the Keychain is not
            // called from it. The devices are already gone from the registry,
            // so a token that stays behind authenticates nothing.
            let manager = self.clone();
            tauri::async_runtime::spawn_blocking(move || manager.forget_device_tokens(&unclaimed));
        }
        self.sink
            .set(sink.clone())
            .map_err(|_| anyhow!("pairing manager was already configured"))?;
        self.phone.configure(sink.clone())?;
        let settings = self.clone();
        sink.listen("settings_file_changed", Box::new(move |_| {
            settings.phone.mobile.broadcast_settings_changed();
            settings.reload_keep_awake();
        }));
        let machine = Arc::downgrade(self);
        sink.listen(
            crate::machine_wire::CHANGED_EVENT,
            Box::new(move |payload| {
                if let Some(manager) = machine.upgrade() {
                    manager.machine_host_changed(payload);
                }
            }),
        );
        // The relay's hint on the runtime's registration (PRO-368), as on the
        // window's own: the account pairing grants changed.
        let hinted = Arc::downgrade(self);
        sink.listen(
            crate::machine_wire::RELAY_HINT_EVENT,
            Box::new(move |_| {
                if let Some(relay) = hinted.upgrade().and_then(|manager| manager.current_relay()) {
                    relay.signals.hint_pairing_changed();
                }
            }),
        );
        if !self.registry.list()?.is_empty() {
            // Tauri setup runs outside Tokio. Restore the listener on the
            // runtime so saved LAN pairings work without a new code or Relay.
            let manager = self.clone();
            tauri::async_runtime::spawn(async move {
                if manager.is_stopped() {
                    return;
                }
                if let Err(error) = manager.ensure_direct_listener() {
                    log::debug!("saved-device LAN listener unavailable: {error}");
                    manager.retry_direct_listener();
                }
            });
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move { relay::supervise(manager).await });
        Ok(())
    }

    /// Mobile clients read and drive tabs through the session manager.
    pub fn attach_sessions(&self, sessions: SessionManager) {
        let _ = self.sessions.set(sessions);
    }

    /// A phone starting a session chooses from the models the desktop offers.
    pub fn attach_models(&self, cache: Arc<crate::harness::codex::models::Cache>) {
        self.phone.mobile.attach_models(cache);
    }

    pub(crate) fn attach_runtime(self: &Arc<Self>, runtime: Arc<crate::local_runtime::desktop::Desktop>) {
        *self.runtime.lock().unwrap() = Some(runtime.clone());
        // What a phone may be offered is the attached runtime's (#730), and
        // the connections the previous attachment admitted are done.
        self.phone.set_owner(Some(runtime));
        // A runtime that hosts operating computers owns the port (PRO-341).
        self.reconcile_machine_soon();
    }

    /// No desktop sharing mutex spans an RPC. Once attached, transport failure
    /// is an error, never permission to use the obsolete in-process owner.
    fn runtime_sharing(&self, method: &str, params: serde_json::Value) -> Option<Result<serde_json::Value>> {
        let runtime = self.runtime.lock().unwrap().clone()?;
        Some((|| {
            let context = self.account.context().context("Sign in to share a session.")?;
            if method != "clear" && (self.is_stopped() || context.generation == self.sharing_blocked_generation.load(Ordering::SeqCst)) {
                bail!("The sharing account is no longer active.");
            }
            let result = runtime.sharing(&context, method, params);
            if method != "clear" && !self.account.is_current(&context) {
                // Do not expose an old account response to its replacement.
                if runtime.sharing(&context, "clear", serde_json::json!({})).is_err() { runtime.disconnect(); }
                bail!("The sharing account changed during this request.");
            }
            result
        })())
    }

    fn fence_runtime_mobile(&self, method: &str, params: serde_json::Value) -> Result<()> {
        let Some(runtime) = self.runtime.lock().unwrap().clone() else { return Ok(()) };
        let result = (|| {
            let attachment = runtime.attachment()?;
            let actor = crate::local_runtime::mobile::Actor {
                epoch:attachment.epoch, lease:attachment.lease,
                generation:self.account.current_generation(),
                user_id:registry::load_account_mirror()?.map(|mirror| mirror.user_id),
            };
            runtime.mobile(&actor, method, params)?;
            Ok(())
        })();
        if result.is_err() { runtime.disconnect(); }
        result
    }

    fn clear_runtime_sharing(&self) {
        if let Err(error) = self.fence_runtime_mobile("clear", serde_json::json!({})) {
            log::warn!("clear owner mobile grants: {error:#}");
        }
        if let Some(Err(error)) = self.runtime_sharing("clear", serde_json::json!({})) {
            // Drop the authoritative lease if the owner cannot acknowledge the
            // account fence. Never keep forwarding against uncertain grants.
            if let Some(runtime) = self.runtime.lock().unwrap().clone() { runtime.disconnect(); }
            log::warn!("clear owner sharing: {error:#}");
        }
    }

    pub fn status(&self) -> PairingStatus {
        self.expire_pairing_if_needed();
        self.snapshot()
    }

    pub async fn generate_pairing(
        self: &Arc<Self>,
        connection_mode: PairingConnectionMode,
    ) -> Result<PairingStatus> {
        crate::data_privacy::require_network()?;
        let previous = self.inner.lock().unwrap().pending_pairing_device.clone();
        if let Some(previous) = previous {
            self.discard_unclaimed_pairing(&previous)?;
            if let Some(relay) = self.current_relay() {
                relay.revoke(previous);
            }
        }
        let relay = match connection_mode {
            PairingConnectionMode::Automatic => Some(self.current_relay().ok_or_else(|| {
                anyhow!(
                    "TerminalX Relay is not connected. Use LAN (this Wi-Fi or Tailscale), or try Relay again."
                )
            })?),
            PairingConnectionMode::LocalOnly => None,
        };
        if !direct::prepare(connection_mode, || self.ensure_direct_listener()).await? {
            self.retry_direct_listener();
        }
        let keypair = self.host_key(true)?;
        let device_id = Uuid::new_v4().simple().to_string();
        let token = random_token();
        self.secrets.save_device_token(&device_id, &token)?;
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
        if let Err(error) = self.registry.add(entry) {
            let _ = self.secrets.delete_device_token(&device_id);
            return Err(error);
        }
        let relay_offer = match relay.as_ref() {
            Some(relay) => match relay.create_invite(device_id.clone()).await {
                Ok(offer) => Some(offer),
                Err(error) => {
                    let _ = self.discard_unclaimed_pairing(&device_id);
                    return Err(error).context(
                        "TerminalX Relay could not create a pairing invite; use LAN or retry Relay",
                    );
                }
            },
            None => None,
        };
        let expires_at = relay_offer
            .as_ref()
            .map(|relay| relay.invite_expires_at)
            .unwrap_or_else(|| Utc::now().timestamp_millis() + OFFER_TTL_MS)
            .min(Utc::now().timestamp_millis() + OFFER_TTL_MS);
        // Version-2 phones require a direct endpoint and race it against Relay.
        // Keep the stable addresses even while binding retries in the background,
        // so this offer and saved pairings regain LAN access when the port frees.
        let direct_endpoints = advertised_endpoints();
        let offer = PairingOffer {
            v: 2,
            endpoint: direct_endpoints[0].clone(),
            direct_endpoints,
            device_token: token,
            public_key_b64: keypair.public_key_b64(),
            paired_device_id: device_id.clone(),
            scope: "mobile".into(),
            identity_mode: "inherit".into(),
            relay: relay_offer,
        };
        let pairing_url = match encode_pairing_offer(&offer, computer_name().as_deref()) {
            Ok(pairing_url) => pairing_url,
            Err(error) => {
                if let Some(relay) = relay {
                    relay.revoke(device_id.clone());
                }
                let _ = self.discard_unclaimed_pairing(&device_id);
                return Err(error);
            }
        };
        let pairing = PairingCode {
            pairing_url,
            expires_at,
            connection_mode,
            direct_available: self.inner.lock().unwrap().direct_listener_started,
            transport: match connection_mode {
                PairingConnectionMode::Automatic => PairingTransport::Relay,
                PairingConnectionMode::LocalOnly => PairingTransport::Direct,
            },
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.active_pairing = Some(pairing);
            inner.pending_pairing_device = Some(device_id.clone());
            inner.last_error = None;
        }
        self.emit();
        self.schedule_unclaimed_expiration(device_id, expires_at);
        Ok(self.snapshot())
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<PairingStatus> {
        self.revoke_local(device_id)?;
        if let Some(relay) = self.current_relay() {
            relay.revoke(device_id.into());
        }
        self.emit();
        Ok(self.snapshot())
    }

    /// Local-first destructive fence. The cloud calls below are best effort;
    /// automatic credentials are already unusable before either starts.
    pub async fn sign_out(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.sharing_blocked_generation.store(self.account.current_generation(), Ordering::SeqCst);
        self.leave_guest();
        self.clear_runtime_sharing();
        if let Some(sessions) = self.sessions.get() {
            let ids: Vec<_> = sessions.sharing.lock().unwrap().sessions.keys().cloned().collect();
            for id in ids { let _ = self.change_share(&id, "stop", serde_json::json!({})); }
        }
        let context = self.account_context();
        if let Some(context) = context.as_ref() {
            *self.suspended_account_token.lock().unwrap() = Some(context.access_token.clone());
        }
        let mirror = registry::load_account_mirror().ok().flatten();
        if let Some(current) = mirror.as_ref() {
            let next = AccountMirror {
                user_id: current.user_id.clone(),
                email: current.email.clone(),
                display_name: current.display_name.clone(),
                host_display_name: current.host_display_name.clone(),
                binding_generation: current.binding_generation.saturating_add(1),
            };
            if let Err(error) = registry::save_account_mirror(&next) {
                log::warn!("could not advance the host binding fence: {error:#}");
            }
        }
        if let Some(context) = context.as_ref() {
            if let Ok(removed) = self.registry.revoke_automatic_for_user(&context.user_id) {
                for device in removed {
                    let _ = self.secrets.delete_device_token(&device.id);
                    self.cancel_connections(&device.id);
                    if let Some(relay) = self.current_relay() {
                        relay.revoke(device.id);
                    }
                }
            }
        }
        if let Some(relay) = self.inner.lock().unwrap().relay.take() {
            relay.shutdown();
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.relay_status = RelayStatus::default();
            inner.host = None;
        }
        self.emit();
        if let (Some(context), Some(mirror)) = (context, mirror) {
            if context.user_id == mirror.user_id {
                let host_id = self
                    .secrets
                    .host_key(false)
                    .ok()
                    .flatten()
                    .map(|key| key.host_id());
                if let Some(host_id) = host_id {
                    let _ = tokio::task::spawn_blocking(move || {
                        cloud::unbind(
                            &context,
                            &host_id,
                            mirror.binding_generation.saturating_add(1),
                        )
                    })
                    .await;
                }
            }
        }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.release_direct_port();
        self.leave_guest();
        self.clear_runtime_sharing();
        if let Some(sessions) = self.sessions.get() {
            let ids: Vec<_> = sessions.sharing.lock().unwrap().sessions.keys().cloned().collect();
            for id in ids { let _ = self.change_share(&id, "stop", serde_json::json!({})); }
        }
        self.stopped.store(true, Ordering::SeqCst);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(relay) = self.inner.lock().unwrap().relay.take() {
            relay.shutdown();
        }
        for connections in self.connections.lock().unwrap().values() {
            for connection in connections {
                let _ = connection.signal.send(ConnectionSignal::Cancel);
            }
        }
        self.keep_awake.lock().unwrap().assertion = None;
        // The runtime passes no more phones to a stopped window.
        self.machine.lock().unwrap().stop();
    }

    /// Name this Mac for the user's other devices, or with `None` let it follow
    /// the computer's own name again. Relay need not be on (#686); when this
    /// Mac is bound, the account directory takes the name first, so a phone
    /// never lists one it refused.
    pub async fn set_host_name(&self, display_name: Option<&str>) -> Result<MachineName> {
        let chosen = display_name.map(chosen_host_name).transpose()?;
        let computer_name = tokio::task::spawn_blocking(recent_computer_name).await?;
        let named = resolve_machine_name(chosen.clone(), None, computer_name);
        let bound = self.inner.lock().unwrap().host.is_some();
        let context = self.account_context();
        let mirror = registry::load_account_mirror()?;
        let binding = context.zip(mirror.clone()).filter(|(context, mirror)| bound && context.user_id == mirror.user_id);
        if let Some((context, mirror)) = binding {
            let keypair = self.host_key(false)?;
            let payload = HostBindingPayload {
                host_id: keypair.host_id(),
                host_public_key_b64: keypair.public_key_b64(),
                binding_generation: mirror.binding_generation,
                display_name: named.name.clone(),
                platform: "darwin".into(),
                environment_kind: "native".into(),
                capabilities: self.host_capabilities(),
            };
            tokio::task::spawn_blocking(move || cloud::register_host(&context, &payload)).await??;
        }
        let mut settings = crate::store::settings::load();
        settings.machine_name = chosen;
        crate::store::settings::save(&settings)?;
        // The name is the Mac's now, whoever signs in. One an earlier version
        // kept for an account must not come back when this one is cleared.
        // Read again: sign-out may have advanced the binding fence meanwhile.
        if let Some(mut mirror) = registry::load_account_mirror()?.filter(|mirror| mirror.host_display_name.is_some()) {
            mirror.host_display_name = None;
            registry::save_account_mirror(&mirror)?;
        }
        if let Some(host) = self.inner.lock().unwrap().host.as_mut() {
            host.display_name = named.name.clone();
            host.last_seen_at = Some(Utc::now().to_rfc3339());
        }
        self.emit();
        Ok(named)
    }

    pub(super) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub(super) fn account_context(&self) -> Option<AccountContext> {
        self.account.context()
    }

    pub(super) fn relay_permitted(&self, context: &AccountContext) -> bool {
        if crate::data_privacy::enabled() { return false; }
        let mut suspended = self.suspended_account_token.lock().unwrap();
        if suspended.as_deref() == Some(&context.access_token) {
            return false;
        }
        if suspended.is_some() {
            *suspended = None;
        }
        true
    }

    /// The id this Mac is paired by, which its work status is published
    /// under too (#441). Made now if it was never needed before.
    pub(crate) fn host_id(&self) -> Option<String> {
        self.host_key(false).or_else(|_| self.host_key(true)).ok().map(|keypair| keypair.host_id())
    }

    /// This Mac's name as Settings → Account shows it to `user_id`, and as
    /// their other devices see it.
    pub(crate) fn host_name(user_id: &str) -> String {
        Self::machine_name_for(Some(user_id)).name
    }

    /// This Mac's name as Settings → Account shows it to whoever is signed in.
    pub fn machine_name(&self) -> MachineName {
        Self::machine_name_for(self.account_context().map(|context| context.user_id).as_deref())
    }

    fn machine_name_for(user_id: Option<&str>) -> MachineName {
        let saved = user_id.and_then(|user_id| saved_host_name(registry::load_account_mirror().ok().flatten().as_ref(), user_id));
        resolve_machine_name(crate::store::settings::load().machine_name, saved, recent_computer_name())
    }

    #[cfg(test)]
    pub(crate) fn with_secrets_for_test(identifier: &str, store: Arc<dyn crate::keychain::SecretStore>) -> Arc<Self> {
        let mut manager = Self::new(Arc::new(AccountManager::default()));
        manager.secrets = PairingSecrets::with_store(store);
        manager.secrets.configure(identifier).unwrap();
        Arc::new(manager)
    }

    #[cfg(test)]
    pub(crate) fn set_phone_owner_for_test(&self, owner: Arc<dyn crate::phone::Owner>) {
        self.phone.set_owner(Some(owner));
    }

    #[cfg(test)]
    pub(crate) fn set_phone_port_for_test(self: &mut Arc<Self>, port: u16) {
        Arc::get_mut(self).unwrap().direct_port = port;
    }

    /// The window's signing key for runtime consent. Reading it can block
    /// on the Keychain. A runtime launch may create it if absent.
    #[cfg(target_os = "macos")]
    pub(crate) fn consent_key(&self, create: bool) -> Result<ring::signature::Ed25519KeyPair> {
        self.secrets.window_consent_key(create)
            .map_err(|_| {
                anyhow!("TerminalX couldn’t access the window consent key in Keychain. Unlock your login Keychain, allow TerminalX access if prompted, then try again.")
            })?
            .ok_or_else(|| {
                anyhow!("The window consent key is missing from Keychain. Restart the local runtime from TerminalX and try again.")
            })
    }

    pub(super) fn host_key(&self, create: bool) -> Result<HostKeypair> {
        let keypair = self
            .secrets
            .host_key(create)?
            .ok_or_else(|| anyhow!("host identity is unavailable"))?;
        *self.host_public.lock().unwrap() = Some(*keypair.public());
        Ok(keypair)
    }

    fn record_relay_diagnostic(
        &self,
        event: diagnostics::Event,
        attempt: u32,
        failure: Option<diagnostics::Failure>,
    ) {
        // Only typed allowlisted data reaches either sink. A disk error must not
        // stop connection recovery or reveal the user's filesystem path.
        if let Some(failure) = failure {
            log::warn!(
                "relay failure stage={:?} category={:?} http_status={:?} attempt={}",
                failure.stage, failure.category, failure.http_status, attempt
            );
        }
        if self
            .diagnostics
            .lock()
            .unwrap()
            .record(event, attempt, failure)
            .is_err()
        {
            log::warn!("relay diagnostics write failed (category=local-storage)");
        }
    }

    pub(super) fn set_relay_off(&self) {
        let changed = {
            let mut inner = self.inner.lock().unwrap();
            let changed = inner.relay_status.phase != RelayPhase::Off || inner.host.is_some();
            inner.relay = None;
            inner.relay_status = RelayStatus::default();
            inner.host = None;
            changed
        };
        if changed {
            self.emit();
        }
    }

    pub(super) fn set_relay_connecting(&self, attempt: u32) {
        let mut inner = self.inner.lock().unwrap();
        // Keep the last failure visible while the next connection is attempted.
        let message = match inner.relay_status.phase {
            RelayPhase::Offline | RelayPhase::Connecting => inner.relay_status.message.clone(),
            _ => None,
        };
        inner.relay_status = RelayStatus {
            phase: RelayPhase::Connecting,
            message: message.or_else(|| Some("Connecting securely…".into())),
            attempt,
        };
        drop(inner);
        self.emit();
    }

    /// Wake the existing supervisor. Never start a second control connection
    /// or tear down a connection that recovered just before the click arrived.
    pub fn retry_relay(&self) -> Result<PairingStatus> {
        crate::data_privacy::require_network()?;
        let mut inner = self.inner.lock().unwrap();
        if self.is_stopped() || inner.relay_status.phase == RelayPhase::Off {
            bail!("Relay is not configured. Check Settings → Account.");
        }
        if inner.relay_status.phase == RelayPhase::Offline {
            inner.relay_status.phase = RelayPhase::Connecting;
            let attempt = inner.relay_status.attempt;
            drop(inner);
            self.record_relay_diagnostic(diagnostics::Event::RetryRequested, attempt, None);
            self.relay_retry.notify_one();
            self.emit();
        } else {
            drop(inner);
        }
        Ok(self.status())
    }

    pub(super) fn set_relay_unavailable(&self, message: &str, attempt: u32) {
        self.inner.lock().unwrap().relay_status = RelayStatus {
            phase: RelayPhase::Offline,
            message: Some(message.into()),
            attempt,
        };
        self.emit();
    }

    pub(super) fn set_relay_connected(&self, relay: RelayLive) {
        let mut inner = self.inner.lock().unwrap();
        inner.relay = Some(relay);
        inner.relay_status = RelayStatus {
            phase: RelayPhase::Connected,
            message: Some("Connected".into()),
            attempt: 0,
        };
        drop(inner);
        self.emit();
    }

    pub(super) fn clear_relay(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.inner.lock().unwrap().relay = None;
    }

    pub(super) async fn relay_ready(self: &Arc<Self>, context: AccountContext, relay: RelayLive) {
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        if let Err(error) = self.ensure_direct_listener() {
            log::debug!("nearby pairing unavailable; continuing Relay setup: {error}");
            self.retry_direct_listener();
        }
        let keypair = match self.host_key(true) {
            Ok(keypair) => keypair,
            Err(error) => {
                self.set_error(format!("Host identity failed: {error:#}"));
                return;
            }
        };
        let previous = registry::load_account_mirror().ok().flatten();
        let generation = previous
            .as_ref()
            .map(|mirror| {
                if mirror.user_id == context.user_id {
                    mirror.binding_generation
                } else {
                    mirror.binding_generation.saturating_add(1)
                }
            })
            .unwrap_or(1);
        // Only a name someone chose is kept here; the computer's own is read
        // again each time, so a rename in System Settings reaches the directory (#686).
        let saved = saved_host_name(previous.as_ref(), &context.user_id);
        let display_name = resolve_machine_name(crate::store::settings::load().machine_name, saved.clone(), recent_computer_name()).name;
        let mirror = AccountMirror {
            user_id: context.user_id.clone(),
            email: context.email.clone(),
            display_name: context.display_name.clone(),
            host_display_name: saved,
            binding_generation: generation,
        };
        if let Err(error) = registry::save_account_mirror(&mirror) {
            self.set_error(format!("Could not save host binding fence: {error:#}"));
            return;
        }
        let capabilities = self.host_capabilities();
        let payload = HostBindingPayload {
            host_id: keypair.host_id(),
            host_public_key_b64: keypair.public_key_b64(),
            binding_generation: generation,
            display_name: display_name.clone(),
            platform: "darwin".into(),
            environment_kind: "native".into(),
            capabilities: capabilities.clone(),
        };
        let context_for_bind = context.clone();
        let bind =
            tokio::task::spawn_blocking(move || cloud::register_host(&context_for_bind, &payload))
                .await;
        if !matches!(bind, Ok(Ok(()))) || !self.is_epoch(epoch) {
            if let Ok(Err(error)) = bind {
                self.set_error(format!("Could not bind this Mac: {error:#}"));
            }
            return;
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.host = Some(HostMetadata {
                host_id: keypair.host_id(),
                public_key: keypair.public_key_b64(),
                binding_generation: generation,
                display_name,
                platform: "darwin".into(),
                environment_kind: "native".into(),
                capabilities,
                app_version: env!("CARGO_PKG_VERSION").into(),
                last_seen_at: Some(Utc::now().to_rfc3339()),
            });
            inner.last_error = None;
        }
        self.emit();
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.host_poll(epoch, context.user_id, relay, generation).await;
        });
    }

    async fn fulfill_grant(
        self: &Arc<Self>,
        epoch: u64,
        context: &AccountContext,
        relay: &RelayLive,
        generation: u64,
        grant: AccountPairingGrant,
    ) {
        if !valid_grant(&grant, context, &relay.relay_host_id, generation, "mobile") {
            return;
        }
        let result = self
            .build_automatic_offer(epoch, context, relay, generation, &grant)
            .await;
        match result {
            Ok((device_id, envelope)) if self.is_epoch(epoch) => {
                let context = context.clone();
                let host_id = relay.relay_host_id.clone();
                let request_id = grant.grant_request_id.clone();
                let published = tokio::task::spawn_blocking(move || {
                    cloud::publish_envelope(&context, &host_id, &request_id, &envelope)
                })
                .await;
                if !matches!(published, Ok(Ok(()))) || !self.is_epoch(epoch) {
                    let _ = self.revoke_local(&device_id);
                } else if let Ok(expires_at) = DateTime::parse_from_rfc3339(&grant.expires_at) {
                    self.schedule_unclaimed_expiration(device_id, expires_at.timestamp_millis());
                }
            }
            Ok((device_id, _)) => {
                let _ = self.revoke_local(&device_id);
            }
            Err(error) => {
                log::warn!("automatic pairing grant failed: {error:#}");
                let context = context.clone();
                let host_id = relay.relay_host_id.clone();
                let request_id = grant.grant_request_id;
                let _ = tokio::task::spawn_blocking(move || {
                    cloud::reject_grant(&context, &host_id, &request_id, generation)
                })
                .await;
            }
        }
    }

    async fn build_automatic_offer(
        &self,
        epoch: u64,
        context: &AccountContext,
        relay: &RelayLive,
        generation: u64,
        grant: &AccountPairingGrant,
    ) -> Result<(String, model::AccountPairingEnvelope)> {
        if !self.is_epoch(epoch) {
            bail!("pairing was fenced by sign-out");
        }
        let keypair = self.host_key(true)?;
        let device_id = Uuid::new_v4().simple().to_string();
        let token = random_token();
        self.secrets.save_device_token(&device_id, &token)?;
        let entry = DeviceEntry {
            id: device_id.clone(),
            label: "TerminalX Mobile".into(),
            platform: "mobile".into(),
            token: token_hash(&token),
            scope: DeviceScope::Driver,
            provenance: DeviceProvenance::Automatic,
            bound_user_id: Some(context.user_id.clone()),
            binding_generation: generation,
            public_key: String::new(),
            created_at: Utc::now().to_rfc3339(),
            last_seen_at: None,
            revoked_at: None,
            installation_id: Some(grant.client_installation_id.clone()),
            created_request_id: Some(grant.grant_request_id.clone()),
            fingerprint: None,
            approved_at: None,
            connection: None,
            last_seen_transport: None,
        };
        if let Err(error) = self.registry.add(entry) {
            let _ = self.secrets.delete_device_token(&device_id);
            return Err(error);
        }
        let outcome = async {
            let relay_offer = relay.create_invite(device_id.clone()).await?;
            if !self.is_epoch(epoch) {
                bail!("pairing was fenced by sign-out");
            }
            let direct_endpoints = advertised_endpoints();
            let offer = PairingOffer {
                v: 2,
                endpoint: direct_endpoints[0].clone(),
                direct_endpoints,
                device_token: token,
                public_key_b64: keypair.public_key_b64(),
                paired_device_id: device_id.clone(),
                scope: "mobile".into(),
                identity_mode: "authenticate".into(),
                relay: Some(relay_offer),
            };
            if offer.public_key_b64 != keypair.public_key_b64() {
                bail!("pairing offer host key did not match this host");
            }
            seal_account_offer(
                &grant.client_ephemeral_public_key,
                &grant.associated_data,
                generation,
                &offer,
            )
        }
        .await;
        match outcome {
            Ok(envelope) => Ok((device_id, envelope)),
            Err(error) => {
                let _ = self.revoke_local(&device_id);
                Err(error)
            }
        }
    }

    fn retry_direct_listener(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.direct_listener_started || inner.direct_listener_retrying {
            return;
        }
        inner.direct_listener_retrying = true;
        drop(inner);
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(direct::RETRY_DELAY).await;
                if manager.is_stopped() {
                    break;
                }
                // The runtime took the port meanwhile (PRO-341).
                if manager.runtime_owns_direct() {
                    break;
                }
                match manager.ensure_direct_listener() {
                    Ok(()) => {
                        manager.emit();
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
                    Err(error) => {
                        log::debug!("nearby pairing listener retry failed: {error}");
                        break;
                    }
                }
            }
            manager.inner.lock().unwrap().direct_listener_retrying = false;
        });
    }

    fn ensure_direct_listener(self: &Arc<Self>) -> std::io::Result<()> {
        // Serialize binding; only listener lifetime is cached, never interface addresses.
        let mut inner = self.inner.lock().unwrap();
        inner.direct_wanted = true;
        if inner.direct_listener_started {
            return Ok(());
        }
        if self.runtime_owns_direct() {
            // The runtime holds the port and passes phones here (PRO-341).
            drop(inner);
            return self.take_phones_from_runtime();
        }
        let listener = direct::bind(self.direct_port)?;
        inner.direct_listener_started = true;
        let manager = self.clone();
        inner.direct_accept = Some(tauri::async_runtime::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let manager = manager.clone();
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let socket = tokio_tungstenite::accept_async_with_config(
                            crate::data_privacy::NetworkIo::new(&mut stream),
                            Some(pairing_websocket_config()),
                        )
                        .await?;
                        manager
                            .handle_e2ee_socket(
                                socket,
                                PairingConnectionContext::Direct {
                                    direct_auth_id: Uuid::new_v4().simple().to_string(),
                                    forwarded_id: None,
                                },
                                None,
                                None,
                            )
                            .await
                    }
                    .await;
                    if manager.is_stopped() || manager.runtime_owns_direct() {
                        // Let the runtime bind this same port when the window
                        // closes. A normal server-side FIN leaves TIME_WAIT.
                        let _ = stream.set_zero_linger();
                    }
                    if let Err(error) = result {
                        log::debug!("direct paired-device connection ended: {error:#}");
                    }
                });
            }
        }));
        Ok(())
    }

    pub(super) async fn handle_relay_connection(
        self: Arc<Self>,
        cell_url: String,
        relay_host_id: String,
        generation: u64,
        keypair: HostKeypair,
        connection: ConnectionOpen,
    ) -> Result<()> {
        if keypair.host_id() != relay_host_id {
            return Err(anyhow!("relay connection named a different host key")
                .context(diagnostics::Stage::PhoneAttach));
        }
        let expected_device = connection.relay_device_id.clone();
        let socket = relay::open_data_socket(&cell_url, generation, &connection)
            .await
            .context(diagnostics::Stage::PhoneAttach)?;
        self.record_relay_diagnostic(diagnostics::Event::PhoneAttached, 0, None);
        // The plaintext relay hello is sent to the phone only. The host data
        // leg starts with the phone's E2EE hello after its one auth frame.
        let context = PairingConnectionContext::Relay {
            relay_host_id,
            credential_kind: connection.kind,
            basis_conn_id: connection.conn_id,
        };
        let logged_in = AtomicBool::new(false);
        self.handle_e2ee_socket(socket, context, Some(expected_device), Some(&logged_in))
            .await
            .with_context(|| {
                if logged_in.load(Ordering::SeqCst) {
                    diagnostics::Stage::PhoneSession
                } else {
                    diagnostics::Stage::PhoneHandshake
                }
            })
    }

    /// A relay leg passes `logged_in`, which is set, and recorded in the
    /// relay diagnostics, once the device has logged in.
    async fn handle_e2ee_socket<S>(
        self: &Arc<Self>,
        mut socket: WebSocketStream<S>,
        connection: PairingConnectionContext,
        expected_device_id: Option<String>,
        logged_in: Option<&AtomicBool>,
    ) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let hello = socket
            .next()
            .await
            .ok_or_else(|| anyhow!("device closed before E2EE handshake"))??;
        let Message::Text(hello) = hello else {
            bail!("E2EE hello was not text");
        };
        let hello: E2eeHello = serde_json::from_str(&hello).context("decode E2EE hello")?;
        let keypair = self.host_key(false)?;
        let (transport, relay_host_id, wire_transport) = match &connection {
            PairingConnectionContext::Direct { .. } => ("direct", None, wire::Transport::Direct),
            PairingConnectionContext::Relay { relay_host_id, .. } => {
                ("relay", Some(relay_host_id.as_str()), wire::Transport::Relay)
            }
        };
        let (ready, mut session) = begin_e2ee_session(&keypair, hello, transport, relay_host_id)?;
        socket
            .send(Message::Text(serde_json::to_string(&ready)?.into()))
            .await?;
        let auth_frame = socket
            .next()
            .await
            .ok_or_else(|| anyhow!("device closed before E2EE authentication"))??;
        let auth = E2eeAuth::open(auth_frame, &mut session)?;
        let generation = registry::load_account_mirror()
            .ok()
            .flatten()
            .map(|mirror| mirror.binding_generation);
        let mark_logged_in = || {
            if let Some(logged_in) = logged_in {
                logged_in.store(true, Ordering::SeqCst);
                self.record_relay_diagnostic(diagnostics::Event::PhoneAuthenticated, 0, None);
            }
        };
        if let Some((session_id, link_id)) = self.share_for_token(&auth.device_token, expected_device_id.as_deref()) {
            crate::phone::send_authenticated(&mut socket, &mut session).await?;
            mark_logged_in();
            return self.share_socket(socket, session, session_id, link_id).await;
        }
        let device = self
            .registry
            .find_by_token(&auth.device_token, generation)?
            .ok_or_else(|| {
                anyhow!(diagnostics::Category::Authentication)
                    .context("paired-device credential was refused")
            })?;
        // Session invitations are process-local and must never subscribe to
        // the mobile runtime's host-wide broadcasts, even via a disk entry.
        if device.scope == DeviceScope::Session {
            bail!("Session credentials are valid only for an active session invitation.");
        }
        if expected_device_id
            .as_deref()
            .is_some_and(|id| id != device.id)
        {
            return Err(anyhow!(diagnostics::Category::Authentication)
                .context("relay invite was used by a different device credential"));
        }
        let transport = match &connection {
            PairingConnectionContext::Direct { .. } => PairingTransport::Direct,
            PairingConnectionContext::Relay { .. } => PairingTransport::Relay,
        };
        let fingerprint =
            fingerprint::fingerprint_b64(keypair.public(), &session.client_public_key_b64, &device.token)?;
        if let Some(reason) = self
            .await_approval(&mut socket, &device, &session.client_public_key_b64, &fingerprint, transport)
            .await?
        {
            // Said in so many words, so the phone can tell a refusal from a
            // dropped connection it should retry (docs/PAIRING-APPROVAL.md).
            let _ = send_encrypted_text(&mut socket, &mut session, &pairing_refused(reason).to_string()).await;
            let _ = socket.close(None).await;
            return Err(anyhow!(diagnostics::Category::Authentication)
                .context(format!("the pairing was refused on this Mac ({reason})")));
        }
        self.registry
            .touch(&device.id, &session.client_public_key_b64, &fingerprint, transport)?;
        if device.last_seen_at.is_none() && device.scope != DeviceScope::Session {
            let manager = self.clone();
            let _ = tokio::task::spawn_blocking(move || manager.keep_new_phone_available()).await;
        }
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.pending_pairing_device.as_deref() == Some(&device.id) {
                inner.pending_pairing_device = None;
                inner.active_pairing = None;
            }
        }
        // Tracked before the runtime registers it, so a revoke meanwhile is not missed.
        let (_tracked, signal_rx) = self.track_connection(&device.id, transport);
        let (outbound_tx, outbound_rx) = mpsc::channel(8);
        let forwarded_id = match &connection {
            PairingConnectionContext::Direct { forwarded_id, .. } => forwarded_id.clone(),
            PairingConnectionContext::Relay { .. } => None,
        };
        let mobile_connection = Arc::new(
            mobile::MobileConnection::open(&self.phone, &device, outbound_tx, wire_transport, forwarded_id)
                .await
                .context(diagnostics::Category::LocalRuntime)?,
        );
        crate::phone::send_with_grant(&self.phone, &mobile_connection,
            crate::phone::send_authenticated(&mut socket, &mut session)).await?;
        mark_logged_in();
        crate::phone::serve_connection(&mut socket, &mut session, &self.phone, &mobile_connection, outbound_rx, signal_rx, |request| {
            let (connection, device, mobile_connection) = (&connection, &device, &mobile_connection);
            async move { self.rpc_response(&request, device, connection, mobile_connection).await }
        })
        .await
    }

    async fn rpc_response(
        self: &Arc<Self>,
        request: &serde_json::Value,
        device: &DeviceEntry,
        connection: &PairingConnectionContext,
        mobile_connection: &Arc<mobile::MobileConnection>,
    ) -> serde_json::Value {
        if device.scope == DeviceScope::Session {
            return serde_json::json!({ "id": request["id"], "ok": false, "error": { "code": "forbidden", "message": "Session credentials require the scoped session router." } });
        }
        let id = request_id(request);
        let method = request
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let result = match method {
            "pairing.provisionRelay" if allowed_method(device.scope, method) => {
                self.provision_relay(device, connection, request.get("params"))
                    .await
            }
            "pairing.getEndpoints" if allowed_method(device.scope, method) => {
                self.get_pairing_endpoints(device, connection, request.get("params"))
                    .await
            }
            // What the phone calls this computer (PRO-87). Asked on every
            // connection, so a computer renamed in System Settings, and a
            // phone paired before names were sent, both catch up.
            "host.describe" if allowed_method(device.scope, method) => Ok(host_description(computer_name(), true)),
            // The phone unpairs itself: only ever the device this connection
            // authenticated as, so it is removed from this computer's paired
            // devices too instead of lingering after the phone forgot it.
            "pairing.forget" if allowed_method(device.scope, method) => {
                self.revoke_device(&device.id).await.map(|_| serde_json::json!({ "forgotten": true }))
            }
            // What the phone calls itself, sent after pairing and on every connection (PRO-314).
            "device.describe" if allowed_method(device.scope, method) => {
                self.describe_device(device, request.get("params"))
            }
            method if allowed_method(device.scope, method) => {
                // Not abandoned on a timeout: a late `session.send` would still run.
                let dispatched = mobile::off_runtime({
                    let (manager, connection) = (self.clone(), mobile_connection.clone());
                    let (request, device) = (request.clone(), device.clone());
                    move || Ok(mobile::dispatch(&manager.phone, &connection, &request, &device))
                })
                .await;
                match dispatched {
                    Ok(Some(result)) => result,
                    Ok(None) => return static_rpc_response(request, device.scope),
                    Err(error) => Err(error),
                }
            }
            _ => return static_rpc_response(request, device.scope),
        };
        match result {
            Ok(result) => mobile::success_response(&id, result),
            Err(error) => error_response(&id, &error),
        }
    }

    async fn provision_relay(
        &self,
        device: &DeviceEntry,
        connection: &PairingConnectionContext,
        params: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let params: PairingProvisionRelayParams =
            serde_json::from_value(params.cloned().unwrap_or_else(|| serde_json::json!({})))
                .context("invalid pairing.provisionRelay params")?;
        validate_opaque_id(&params.req_id)?;
        validate_base64url_32(&params.new_resume_token_hash)?;
        if let Some(hash) = params.expected_current_hash.as_deref() {
            validate_base64url_32(hash)?;
        }
        let relay = self
            .current_relay()
            .ok_or_else(|| anyhow!("relay control is not active"))?;
        let authorization = match connection {
            PairingConnectionContext::Direct { direct_auth_id, .. } => {
                DeviceCredentialInstallAuthorization::AuthenticatedDirect {
                    direct_auth_id: direct_auth_id.clone(),
                }
            }
            PairingConnectionContext::Relay {
                relay_host_id,
                credential_kind,
                basis_conn_id,
            } if relay_host_id == &relay.relay_host_id && credential_kind == "invite" => {
                DeviceCredentialInstallAuthorization::RelayBasis {
                    basis_conn_id: basis_conn_id.clone(),
                }
            }
            PairingConnectionContext::Relay { .. } => {
                bail!("relay provisioning is unavailable on this connection")
            }
        };
        let installed = relay
            .install_credential(
                params.req_id,
                device.id.clone(),
                params.new_resume_token_hash,
                params.expected_current_hash,
                authorization,
            )
            .await?;
        Ok(serde_json::to_value(installed)?)
    }

    async fn get_pairing_endpoints(
        &self,
        device: &DeviceEntry,
        connection: &PairingConnectionContext,
        params: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let params: PairingGetEndpointsParams =
            serde_json::from_value(params.cloned().unwrap_or_else(|| serde_json::json!({})))
                .context("invalid pairing.getEndpoints params")?;
        if let Some(req_id) = params.install_req_id.as_deref() {
            validate_opaque_id(req_id)?;
        }
        if let Some(req_id) = params.resume_confirm_req_id.as_deref() {
            validate_opaque_id(req_id)?;
        }
        let Some(relay) = self.current_relay() else {
            return Ok(
                serde_json::json!({ "v": 1, "directEndpoints": advertised_endpoints(), "relay": null }),
            );
        };
        if let PairingConnectionContext::Relay { relay_host_id, .. } = connection {
            if relay_host_id != &relay.relay_host_id {
                bail!("relay connection belongs to a stale host assignment");
            }
        }
        let mut result = serde_json::json!({
            "v": 1,
            "directEndpoints": advertised_endpoints(),
            "relay": {
                "v": 1,
                "directorUrl": relay.director_url,
                "cellUrl": relay.cell_url,
                "assignmentEpoch": relay.assignment_epoch,
                "relayHostId": relay.relay_host_id,
                "e2eeFraming": 2,
            }
        });
        if let Some(req_id) = params.install_req_id {
            result["installStatus"] = serde_json::to_value(
                relay
                    .credential_install_status(req_id, device.id.clone())
                    .await?,
            )?;
        }
        if let Some(req_id) = params.resume_confirm_req_id {
            let PairingConnectionContext::Relay {
                credential_kind,
                basis_conn_id,
                ..
            } = connection
            else {
                bail!("resume confirmation is unavailable on a direct connection");
            };
            if credential_kind != "resume" {
                bail!("resume confirmation requires a resume credential");
            }
            result["resumeConfirmation"] =
                serde_json::to_value(relay.confirm_resume(req_id, basis_conn_id.clone()).await?)?;
        }
        Ok(result)
    }

    fn forget_device_tokens(&self, device_ids: &[String]) {
        for device_id in device_ids {
            if let Err(error) = self.secrets.delete_device_token(device_id) {
                log::warn!("could not remove an unclaimed device token from Keychain: {error:#}");
            }
        }
    }

    fn revoke_local(&self, device_id: &str) -> Result<()> {
        self.fence_runtime_mobile("revoke", serde_json::json!({"deviceId":device_id}))?;
        let _ = self.registry.revoke(device_id)?;
        self.account.sync_runtime_copy();
        self.secrets.delete_device_token(device_id)?;
        self.cancel_connections(device_id);
        self.inner.lock().unwrap().forget_pending(device_id);
        Ok(())
    }

    fn discard_unclaimed_pairing(&self, device_id: &str) -> Result<()> {
        if self.registry.discard_unclaimed(device_id)? {
            self.account.sync_runtime_copy();
        }
        self.secrets.delete_device_token(device_id)?;
        self.inner.lock().unwrap().forget_pending(device_id);
        Ok(())
    }

    fn cancel_connections(&self, device_id: &str) {
        let removed = self.connections.lock().unwrap().remove(device_id);
        if let Some(connections) = removed {
            for connection in connections {
                let _ = connection.signal.send(ConnectionSignal::Cancel);
            }
            self.refresh_keep_awake();
        }
    }

    fn current_relay(&self) -> Option<RelayLive> {
        self.inner.lock().unwrap().relay.clone()
    }

    fn snapshot(&self) -> PairingStatus {
        let live = self.live_connections();
        let host_public = *self.host_public.lock().unwrap();
        let keep_awake = self.keep_awake_enabled();
        let inner = self.inner.lock().unwrap();
        PairingStatus {
            relay: inner.relay_status.clone(),
            host: inner.host.clone(),
            devices: self
                .registry
                .list()
                .unwrap_or_default()
                .into_iter()
                .filter(|device| device.last_seen_at.is_some())
                .map(|mut device| {
                    // Paired before PRO-314: the key it last connected with names it.
                    if device.fingerprint.is_none() && !device.public_key.is_empty() {
                        device.fingerprint = host_public
                            .and_then(|host| fingerprint::fingerprint_b64(&host, &device.public_key, &device.token).ok());
                    }
                    device.connection = live.get(&device.id).cloned();
                    device
                })
                .collect(),
            active_pairing: inner.active_pairing.clone().map(|mut pairing| {
                pairing.direct_available = inner.direct_listener_started;
                pairing
            }),
            pending_approval: inner.pending_approval.as_ref().map(|pending| pending.request.clone()),
            keep_awake,
            last_error: inner.last_error.clone(),
        }
    }

    fn emit(&self) {
        if let Some(sink) = self.sink.get() {
            sink.emit(STATUS_EVENT, &self.snapshot());
        }
    }

    fn set_error(&self, message: String) {
        self.inner.lock().unwrap().last_error = Some(message);
        self.emit();
    }

    fn expire_pairing_if_needed(&self) {
        let expired = {
            let mut inner = self.inner.lock().unwrap();
            // The code's own expiry does not cut a pending approval short.
            if inner.pending_approval.is_none()
                && inner
                    .active_pairing
                    .as_ref()
                    .is_some_and(|pairing| pairing.expires_at <= Utc::now().timestamp_millis())
            {
                inner.active_pairing = None;
                inner.pending_pairing_device.take()
            } else {
                None
            }
        };
        if let Some(device_id) = expired {
            let _ = self.revoke_local(&device_id);
            if let Some(relay) = self.current_relay() {
                relay.revoke(device_id);
            }
        }
    }

    fn schedule_unclaimed_expiration(self: &Arc<Self>, device_id: String, expires_at: i64) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let wait_ms = expires_at
                .saturating_sub(Utc::now().timestamp_millis())
                .max(0) as u64;
            tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
            // A pending approval ends by its own deadline, approved or not.
            if !manager.approval_pending_for(&device_id)
                && manager.registry.is_unclaimed(&device_id).unwrap_or(false)
            {
                let _ = manager.revoke_local(&device_id);
                if let Some(relay) = manager.current_relay() {
                    relay.revoke(device_id);
                }
                manager.emit();
            }
        });
    }

    /// A QR pairing waits here until the person approves it on this Mac
    /// (docs/PAIRING-APPROVAL.md). Every connection of the scanning phone,
    /// direct and Relay alike, waits on the one request; a different phone
    /// key is refused. Paired devices, and account-bound ones, pass.
    ///
    /// `Ok(Some(reason))` is the Mac's own refusal, which the caller tells the
    /// phone in a `pairing_refused` message before closing; an `Err` is the
    /// connection failing, which the phone may retry.
    async fn await_approval<S>(
        self: &Arc<Self>,
        socket: &mut WebSocketStream<S>,
        device: &DeviceEntry,
        phone_key: &str,
        fingerprint: &str,
        transport: PairingTransport,
    ) -> Result<Option<&'static str>>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        if device.provenance != DeviceProvenance::Explicit
            || device.approved_at.is_some()
            || device.last_seen_at.is_some()
        {
            return Ok(None);
        }
        let (mut outcome, started) = {
            let mut inner = self.inner.lock().unwrap();
            // Read again under the lock `approve_pairing` saves under: the
            // device may have been approved since it was looked up, by a
            // racing candidate of the same phone. `touch` then holds it to
            // the approved key.
            let current = self.registry.list()?.into_iter().find(|saved| saved.id == device.id);
            if current.is_some_and(|saved| saved.approved_at.is_some() || saved.last_seen_at.is_some()) {
                return Ok(None);
            }
            if inner.pending_pairing_device.as_deref() != Some(device.id.as_str()) {
                return Ok(Some(REFUSED_CODE_INACTIVE));
            }
            match inner.pending_approval.as_ref() {
                Some(pending) if pending.request.device_id == device.id => {
                    if pending.phone_key != phone_key {
                        return Ok(Some(REFUSED_ANOTHER_PHONE));
                    }
                    (pending.outcome.subscribe(), None)
                }
                Some(_) => return Ok(Some(REFUSED_ANOTHER_PHONE)),
                None => {
                    let now = Utc::now().timestamp_millis();
                    if !inner.active_pairing.as_ref().is_some_and(|code| code.expires_at > now) {
                        return Ok(Some(REFUSED_CODE_INACTIVE));
                    }
                    let (sender, receiver) = tokio::sync::watch::channel(Approval::Waiting);
                    let request = PairingApprovalRequest {
                        request_id: Uuid::new_v4().simple().to_string(),
                        device_id: device.id.clone(),
                        fingerprint: fingerprint.into(),
                        transport,
                        requested_at: now,
                        expires_at: now + self.approval_ttl_ms,
                    };
                    let request_id = request.request_id.clone();
                    inner.pending_approval = Some(PendingApproval {
                        request,
                        phone_key: phone_key.into(),
                        outcome: sender,
                    });
                    (receiver, Some(request_id))
                }
            }
        };
        if let Some(request_id) = started {
            self.emit();
            self.schedule_approval_expiry(request_id);
        }
        loop {
            tokio::select! {
                // Copied out at once: the watch guard must not be held across an await.
                decided = async { outcome.wait_for(|state| *state != Approval::Waiting).await.map(|state| *state) } => {
                    // A request dropped without an answer is declined too.
                    return Ok(match decided {
                        Ok(Approval::Approved) => None,
                        Ok(_) => Some(REFUSED_NOT_APPROVED),
                        // The request was dropped without an answer: the Mac is
                        // going away, so this is the connection failing.
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

    /// The person approved the phone whose fingerprint the request shows:
    /// every connection waiting on it finishes pairing.
    pub fn approve_pairing(self: &Arc<Self>, request_id: &str) -> Result<PairingStatus> {
        let (pending, saved) = {
            let mut inner = self.inner.lock().unwrap();
            let Some(waiting) =
                inner.pending_approval.as_ref().filter(|pending| pending.request.request_id == request_id)
            else {
                bail!("This pairing request is no longer waiting for approval.");
            };
            // Saved before the request leaves `Inner`, under the same lock the
            // gate reads both under: a candidate that reaches the gate now
            // either joins the request or finds the device approved.
            let saved = self.registry.approve(&waiting.request.device_id, &waiting.request.fingerprint, &waiting.phone_key);
            (inner.pending_approval.take().unwrap(), saved)
        };
        let device_id = pending.request.device_id.clone();
        if let Err(error) = saved {
            drop(pending);
            self.discard_pending_device(&device_id);
            self.emit();
            return Err(error.context("The phone's pairing could not be saved. Generate a new code."));
        }
        let _ = pending.outcome.send(Approval::Approved);
        // Should every waiting connection have closed meanwhile, the phone
        // may come back with its credential; one that never does is removed.
        self.schedule_unclaimed_expiration(device_id, Utc::now().timestamp_millis() + self.approval_ttl_ms);
        self.emit();
        Ok(self.snapshot())
    }

    /// Not this phone: no device is left behind and the code is spent.
    pub fn decline_pairing(&self, request_id: &str) -> Result<PairingStatus> {
        let pending = self.take_pending_approval(request_id)?;
        let _ = pending.outcome.send(Approval::Declined);
        self.discard_pending_device(&pending.request.device_id);
        self.emit();
        Ok(self.snapshot())
    }

    /// The declined request and its code leave together, so no status shows
    /// the code still active once the request is gone. The device and its
    /// Keychain token are discarded after, outside the lock.
    fn take_pending_approval(&self, request_id: &str) -> Result<PendingApproval> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.pending_approval.as_ref().is_some_and(|pending| pending.request.request_id == request_id) {
            bail!("This pairing request is no longer waiting for approval.");
        }
        let pending = inner.pending_approval.take().unwrap();
        inner.forget_pending(&pending.request.device_id);
        Ok(pending)
    }

    /// The device, its Keychain token and its Relay invite are discarded and
    /// the active code is cleared.
    fn discard_pending_device(&self, device_id: &str) {
        if let Err(error) = self.discard_unclaimed_pairing(device_id) {
            log::warn!("could not discard a declined pairing: {error:#}");
        }
        if let Some(relay) = self.current_relay() {
            relay.revoke(device_id.into());
        }
    }

    fn schedule_approval_expiry(self: &Arc<Self>, request_id: String) {
        let manager = self.clone();
        let wait = std::time::Duration::from_millis(self.approval_ttl_ms.max(0) as u64);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(wait).await;
            if manager.decline_pairing(&request_id).is_ok() {
                log::info!("a pairing nobody approved within its time was declined");
            }
        });
    }

    fn approval_pending_for(&self, device_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .pending_approval
            .as_ref()
            .is_some_and(|pending| pending.request.device_id == device_id)
    }

    fn track_connection(
        self: &Arc<Self>,
        device_id: &str,
        transport: PairingTransport,
    ) -> (ConnectionGuard, mpsc::UnboundedReceiver<ConnectionSignal>) {
        let (signal, receiver) = mpsc::unbounded_channel();
        let serial = self.connection_serial.fetch_add(1, Ordering::SeqCst);
        self.connections
            .lock()
            .unwrap()
            .entry(device_id.into())
            .or_default()
            .push(LiveConnection { serial, signal, transport, since: Utc::now() });
        self.refresh_keep_awake();
        self.emit();
        let guard = ConnectionGuard { manager: self.clone(), device_id: device_id.into(), serial };
        (guard, receiver)
    }

    fn untrack_connection(&self, device_id: &str, serial: u64) {
        let removed = {
            let mut connections = self.connections.lock().unwrap();
            let Some(live) = connections.get_mut(device_id) else { return };
            let before = live.len();
            live.retain(|connection| connection.serial != serial);
            let removed = live.len() != before;
            if live.is_empty() {
                connections.remove(device_id);
            }
            removed
        };
        if removed {
            self.refresh_keep_awake();
            self.emit();
        }
    }

    /// Each device's most recent live connection.
    fn live_connections(&self) -> HashMap<String, PairedDeviceConnection> {
        self.connections
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(device_id, live)| {
                let latest = live.iter().max_by_key(|connection| (connection.since, connection.serial))?;
                Some((
                    device_id.clone(),
                    PairedDeviceConnection { transport: latest.transport, since: latest.since.to_rfc3339() },
                ))
            })
            .collect()
    }

    /// End the device's connections and keep its pairing. The phone is told
    /// first, so it stops reconnecting until the person reconnects it.
    pub fn disconnect_device(&self, device_id: &str) -> Result<PairingStatus> {
        if !self.registry.list()?.iter().any(|device| device.id == device_id) {
            bail!("That device is not paired with this Mac.");
        }
        let removed = self.connections.lock().unwrap().remove(device_id);
        for connection in removed.into_iter().flatten() {
            let _ = connection.signal.send(ConnectionSignal::Disconnect);
        }
        self.refresh_keep_awake();
        self.emit();
        Ok(self.snapshot())
    }

    fn keep_awake_enabled(&self) -> bool {
        let mut keep_awake = self.keep_awake.lock().unwrap();
        *keep_awake.enabled.get_or_insert_with(|| crate::store::settings::load().pairing.keep_awake)
    }

    pub fn set_keep_awake(&self, enabled: bool) -> Result<PairingStatus> {
        let mut settings = crate::store::settings::load();
        settings.pairing.keep_awake = enabled;
        crate::store::settings::save(&settings)?;
        self.keep_awake.lock().unwrap().enabled = Some(enabled);
        self.refresh_keep_awake();
        self.emit();
        Ok(self.snapshot())
    }

    /// The settings file changed, perhaps by hand.
    fn reload_keep_awake(&self) {
        let before = self.keep_awake.lock().unwrap().enabled.take();
        if before != Some(self.keep_awake_enabled()) {
            self.refresh_keep_awake();
            self.emit();
        }
    }

    /// Hold the power assertion exactly while the setting is on and a phone
    /// connection is live.
    fn refresh_keep_awake(&self) {
        let live = !self.connections.lock().unwrap().is_empty();
        let wanted = live && !self.is_stopped() && self.keep_awake_enabled();
        let mut keep_awake = self.keep_awake.lock().unwrap();
        if !wanted {
            keep_awake.assertion = None;
        } else if keep_awake.assertion.is_none() {
            match crate::power::Assertion::hold(crate::power::PHONE_CONNECTED) {
                Ok(assertion) => keep_awake.assertion = Some(assertion),
                Err(error) => log::warn!("could not keep this Mac awake for a connected phone: {error:#}"),
            }
        }
    }

    /// `device.describe`: what the phone calls itself, cleaned as a name
    /// shown on another device is.
    fn describe_device(&self, device: &DeviceEntry, params: Option<&serde_json::Value>) -> Result<serde_json::Value> {
        let (label, platform) = crate::phone::device_description(params)?;
        self.registry.describe(&device.id, &label, &platform)?;
        self.emit();
        Ok(serde_json::json!({ "ok": true }))
    }

    fn is_epoch(&self, epoch: u64) -> bool {
        !self.is_stopped() && self.epoch.load(Ordering::SeqCst) == epoch
    }

    pub fn mobile_driven_tabs(&self) -> Result<Vec<String>> {
        let runtime = self.runtime.lock().unwrap().clone().context("The local runtime is unavailable.")?;
        runtime.terminals()?.mobile_drivers()
    }

}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingProvisionRelayParams {
    req_id: String,
    new_resume_token_hash: String,
    #[serde(default)]
    expected_current_hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingGetEndpointsParams {
    #[serde(default)]
    install_req_id: Option<String>,
    #[serde(default)]
    resume_confirm_req_id: Option<String>,
}

fn valid_grant(
    grant: &AccountPairingGrant,
    context: &AccountContext,
    host_id: &str,
    generation: u64,
    scope: &str,
) -> bool {
    grant.user_id == context.user_id
        && grant.host_id == host_id
        && grant.binding_generation == generation
        && grant.installation_generation > 0
        && grant.associated_data_version == 1
        && grant.requested_scope == scope
        && grant.state == "pending"
        && DateTime::parse_from_rfc3339(&grant.expires_at).is_ok_and(|expiry| expiry > Utc::now())
}

/// The name an earlier version kept in `account.json` for `user_id`: one the
/// user chose in Settings → Account, or the host name it found, but never the
/// placeholder it saved when it found none.
fn saved_host_name(mirror: Option<&AccountMirror>, user_id: &str) -> Option<String> {
    mirror
        .filter(|mirror| mirror.user_id == user_id)
        .and_then(|mirror| mirror.host_display_name.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != PLACEHOLDER_HOST_NAME)
        .map(str::to_string)
}

/// A name the user typed for this Mac, as it may be sent: 1 to 80 visible characters.
fn chosen_host_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        bail!("machine name must contain 1 to 80 visible characters");
    }
    Ok(name.into())
}


fn validate_opaque_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 128 {
        bail!("request id must contain 1 to 128 characters");
    }
    Ok(())
}

fn validate_base64url_32(value: &str) -> Result<()> {
    if value.len() != 43
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("resume token hash must be unpadded base64url for 32 bytes");
    }
    Ok(())
}

#[cfg(test)]
mod startup_tests;

#[cfg(test)]
mod approval_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_device_scopes_are_deny_by_default() {
        assert!(allowed_method(DeviceScope::Viewer, "terminal.read"));
        assert!(allowed_method(DeviceScope::Viewer, "sessions.summaries"));
        // PRO-87: any paired device may ask this computer's name and unpair itself.
        for scope in [DeviceScope::Viewer, DeviceScope::Driver] {
            assert!(allowed_method(scope, "host.describe"));
            assert!(allowed_method(scope, "pairing.forget"));
        }
        assert!(allowed_method(DeviceScope::Viewer, "session.tail"));
        assert!(!allowed_method(DeviceScope::Viewer, "terminal.send"));
        assert!(!allowed_method(DeviceScope::Viewer, "session.send"));
        assert!(!allowed_method(DeviceScope::Viewer, "terminal.open"));
        assert!(allowed_method(DeviceScope::Driver, "terminal.open"));
        // Every method the phone dispatch answers is reachable through this
        // gate, which runs first: one left out is refused before its handler.
        // Reads are a viewer's; whatever changes a session is a driver's only.
        for read in ["session.tab", "models.list", "session.prepareContinuation", "terminal.read", "terminal.subscribe"] {
            assert!(allowed_method(DeviceScope::Viewer, read), "{read}");
        }
        for control in ["session.stop", "session.interrupt", "session.resendUnsent", "session.setModel", "session.setEffort",
            "session.setMode", "session.continue", "session.closeTab", "terminal.open", "steerLease.queueInput"] {
            assert!(allowed_method(DeviceScope::Driver, control), "{control}");
            assert!(!allowed_method(DeviceScope::Viewer, control), "{control} is a driver's");
        }
        assert!(allowed_method(DeviceScope::Driver, "terminal.send"));
        assert!(allowed_method(DeviceScope::Driver, "session.send"));
        assert!(allowed_method(DeviceScope::Driver, "permission.respond"));
        assert!(!allowed_method(DeviceScope::Viewer, "permission.respond"));
        // #979: a question is answered by whoever may answer a permission request.
        assert!(allowed_method(DeviceScope::Driver, "questions.respond"));
        assert!(!allowed_method(DeviceScope::Viewer, "questions.respond"));
        assert!(allowed_method(
            DeviceScope::Driver,
            "pairing.provisionRelay"
        ));
        // Starting a session and changing this Mac's settings: any paired
        // phone may see the choices, only a driver may act on them.
        for read in ["sessions.options", "mac.settings"] {
            assert!(allowed_method(DeviceScope::Viewer, read), "{read}");
            assert!(allowed_method(DeviceScope::Driver, read), "{read}");
        }
        for write in ["sessions.create", "mac.setSettings"] {
            assert!(!allowed_method(DeviceScope::Viewer, write), "{write}");
            assert!(allowed_method(DeviceScope::Driver, write), "{write}");
        }
        for denied in [
            "files.read",
            "git.push",
            "settings.update",
            "session.create",
            "terminal.create",
        ] {
            assert!(!allowed_method(DeviceScope::Driver, denied), "{denied}");
        }
    }

    /// Through the router a phone actually reaches, with a real local runtime
    /// as owner: a viewer may read the new-session choices and the settings but
    /// neither start a session nor change one, a driver may do all four, and a
    /// revoked phone none.
    #[test]
    fn a_phone_starts_sessions_and_changes_settings_only_as_its_scope_allows() {
        use std::os::unix::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let log = std::fs::File::create(root.path().join("router.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "pairing::tests::phone_router_child_fixture", "--nocapture"])
            .env("TERMINALX_TEST_PHONE_ROUTER", "1")
            .env("TERMINALX_HOME", root.path().join("store"))
            .env("CLAUDE_CONFIG_DIR", root.path().join("claude"))
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log)
            .process_group(0).spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let result = loop {
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if std::time::Instant::now() >= deadline {
                // SAFETY: the private process group just made for this fixture,
                // its disposable runtime owner included.
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                child.wait().unwrap();
                panic!("phone router fixture exceeded its deadline: {}", std::fs::read_to_string(root.path().join("router.log")).unwrap());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        assert!(result.success(), "{}", std::fs::read_to_string(root.path().join("router.log")).unwrap());
    }

    #[tokio::test]
    async fn phone_router_child_fixture() {
        if std::env::var("TERMINALX_TEST_PHONE_ROUTER").as_deref() != Ok("1") { return; }
        use serde_json::json;
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let root = crate::store::root().unwrap();
        // Installed agents as far as the owner can tell: the stand-ins only exit.
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for agent in ["codex", "claude"] {
            std::fs::write(bin.join(agent), "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(bin.join(agent), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // The desktop side answers `sessions.options` from its own lookup.
        assert!(crate::binpath::set_priority_dir(&bin));
        let devices = json!({"devices":[
            {"id":"driver","label":"Phone","platform":"test","token":"fixture-hash","scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":"2026-11-01T00:00:00Z"},
            {"id":"viewer","label":"Tablet","platform":"test","token":"fixture-hash-2","scope":"viewer","provenance":"explicit","bindingGeneration":0,"createdAt":"2026-11-01T00:00:00Z"},
        ]});
        crate::store::write_json(&root.join("devices.json"), &devices).unwrap();
        struct Child(std::process::Child);
        impl Drop for Child { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
        let log = std::fs::File::create(root.join("owner.log")).unwrap();
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        // The runtime the desktop reaches its phones through, as `serve` runs it.
        let mut owner = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "serve::tests::sharing_reply_owner_fixture", "--nocapture"])
            .env("TERMINALX_TEST_SHARING_REPLY_OWNER", &root)
            .env("TERMINALX_HOME", &root).env("CLAUDE_CONFIG_DIR", root.join("claude")).env("PATH", path)
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap());
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let client = loop {
            if let Ok(client) = crate::local_runtime::client::Client::connect(&root) { break client; }
            assert!(owner.0.try_wait().unwrap().is_none(), "owner exited: {}", std::fs::read_to_string(root.join("owner.log")).unwrap());
            assert!(std::time::Instant::now() < until, "owner startup deadline");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };
        let runtime = Arc::new(crate::local_runtime::desktop::Desktop::connect(client, Arc::new(crate::sink::BroadcastSink::new(256))).unwrap());
        let pairing = Arc::new(PairingManager::new(Arc::new(crate::account::AccountManager::default())));
        pairing.attach_runtime(runtime.clone());
        let device = |index: usize| -> DeviceEntry { serde_json::from_value(devices["devices"][index].clone()).unwrap() };
        let (driver, viewer) = (device(0), device(1));
        let connect = |device: DeviceEntry| {
            let pairing = pairing.clone();
            async move {
                let (outbound, inbound) = mpsc::channel(64);
                (Arc::new(mobile::MobileConnection::open(&pairing.phone, &device, outbound, wire::Transport::Direct, None).await.unwrap()), inbound)
            }
        };
        let ((phone, _phone_inbound), (tablet, _tablet_inbound)) = (connect(driver.clone()).await, connect(viewer.clone()).await);
        let context = PairingConnectionContext::Direct { direct_auth_id: "fixture".into(), forwarded_id: None };
        let ask = |device: &DeviceEntry, connection: &Arc<mobile::MobileConnection>, method: &str, params: serde_json::Value| {
            let request = json!({"id": method, "method": method, "params": params});
            let (pairing, device, connection, context) = (pairing.clone(), device.clone(), connection.clone(), context.clone());
            async move { pairing.rpc_response(&request, &device, &context, &connection).await }
        };
        let refused = |response: &serde_json::Value| (response["ok"].clone(), response["error"]["code"].clone());
        let create = json!({"quick": true, "agent": "claude", "text": "Hi from the phone", "clientMessageId": "0b8f6a52-0c1f-4c35-9d0e-1d5d5a7d1c11"});

        // A viewer reads the choices and the settings, and acts on neither.
        assert_eq!(ask(&viewer, &tablet, "sync.capabilities", json!({})).await["result"]["sessionCreate"], 1);
        let options = ask(&viewer, &tablet, "sessions.options", json!({})).await;
        assert_eq!(options["ok"], true, "{options}");
        assert!(options["result"]["agents"].as_array().unwrap().iter().any(|agent| agent["id"] == "claude" && agent["available"] == true), "{options}");
        // The phone's form opens in Ask every time, as a fresh profile's New Session does (PRO-162).
        assert_eq!(options["result"]["defaultMode"], "manual", "{options}");
        assert_eq!(ask(&viewer, &tablet, "mac.settings", json!({})).await["result"], json!({"nativeCodex": false}));
        assert_eq!(refused(&ask(&viewer, &tablet, "sessions.create", create.clone()).await), (json!(false), json!("forbidden")));
        assert_eq!(refused(&ask(&viewer, &tablet, "mac.setSettings", json!({"nativeCodex": true})).await), (json!(false), json!("forbidden")));
        assert!(crate::store::index::load().unwrap().is_empty());
        assert!(!crate::store::settings::load().experimental.native_codex);

        // A driver does both, and starting the same draft again finds the first session.
        assert_eq!(ask(&driver, &phone, "mac.setSettings", json!({"nativeCodex": true})).await["result"], json!({"nativeCodex": true}));
        assert!(crate::store::settings::load().experimental.native_codex);
        let started = ask(&driver, &phone, "sessions.create", create.clone()).await;
        assert_eq!(started["ok"], true, "{started}");
        let session = started["result"]["sessionId"].as_str().unwrap().to_string();
        assert!(crate::store::index::get(&session).unwrap().is_quick());
        assert_eq!(ask(&driver, &phone, "sessions.create", create.clone()).await["result"]["sessionId"], session.as_str());
        assert_eq!(crate::store::index::load().unwrap().len(), 1);

        // A revoked phone reads and changes nothing, and starts nothing.
        pairing.fence_runtime_mobile("revoke", json!({"deviceId": "driver"})).unwrap();
        for (method, params) in [("mac.settings", json!({})), ("sessions.options", json!({})), ("mac.setSettings", json!({"nativeCodex": false})),
            ("sessions.create", json!({"quick": true, "agent": "claude", "text": "Again"}))] {
            assert_eq!(ask(&driver, &phone, method, params).await["ok"], false, "{method}");
        }
        assert!(crate::store::settings::load().experimental.native_codex);
        assert_eq!(crate::store::index::load().unwrap().len(), 1);
        runtime.stop_all().unwrap();
        drop(owner);
    }

    #[test]
    fn refusal_is_renderable_protocol_data() {
        let response = static_rpc_response(
            &serde_json::json!({ "id": "one", "method": "files.read" }),
            DeviceScope::Driver,
        );
        assert_eq!(response["id"], "one");
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "forbidden");
    }

    #[test]
    fn generated_offer_pins_the_host_public_key() {
        let key = HostKeypair::from_secret([9; 32]);
        let offer = PairingOffer {
            v: 2,
            endpoint: "ws://127.0.0.1:1".into(),
            direct_endpoints: vec![],
            device_token: "token".into(),
            public_key_b64: key.public_key_b64(),
            paired_device_id: "device".into(),
            scope: "mobile".into(),
            identity_mode: "inherit".into(),
            relay: None,
        };
        assert_eq!(offer.public_key_b64, key.public_key_b64());
        assert!(encode_pairing_offer(&offer, None)
            .unwrap()
            .starts_with("terminalx://pair?code="));
        // PRO-87: the computer's name rides beside the offer, where a phone that predates it does not look.
        let named = encode_pairing_offer(&offer, Some("Paresh\u{2019}s Mac mini & co")).unwrap();
        let (code, name) = named.split_once("&name=").unwrap();
        assert_eq!(code, encode_pairing_offer(&offer, None).unwrap());
        assert_eq!(url::form_urlencoded::parse(format!("name={name}").as_bytes()).next().unwrap().1, "Paresh\u{2019}s Mac mini & co");
        assert!(!name.contains(' ') && !name.contains('&'));
        assert_eq!(encode_pairing_offer(&offer, Some("")).unwrap(), code);
    }

    // PRO-87: a name shown on another device is cleaned and bounded.
    #[test]
    fn a_computer_name_is_made_presentable_before_it_is_sent() {
        assert_eq!(presentable_name("  Paresh\u{2019}s  Mac\tmini \n").as_deref(), Some("Paresh\u{2019}s Mac mini"));
        assert_eq!(presentable_name("Mac\u{0007}\u{202E}evil\u{200B}").as_deref(), Some("Macevil"));
        assert_eq!(presentable_name(&"n".repeat(200)).map(|name| name.chars().count()), Some(COMPUTER_NAME_MAX_CHARS));
        assert_eq!(presentable_name(" \u{0000}\n "), None);
        // Whatever this machine is called, what is sent obeys the same rules.
        if let Some(name) = computer_name() {
            assert!(!name.is_empty() && name.chars().count() <= COMPUTER_NAME_MAX_CHARS && !name.chars().any(char::is_control));
        }
    }

    fn mirror(user_id: &str, host_display_name: Option<&str>) -> AccountMirror {
        AccountMirror {
            user_id: user_id.into(),
            email: format!("{user_id}@example.invalid"),
            display_name: user_id.into(),
            host_display_name: host_display_name.map(str::to_string),
            binding_generation: 7,
        }
    }

    // #686: every Mac opened from Finder saved and published "This Mac", which
    // another Mac then showed as "You · on This Mac".
    #[test]
    fn a_mac_is_named_by_its_choice_then_its_computer_name_and_never_this_mac() {
        let studio = || Some("Studio".to_string());
        let resolve = |chosen: Option<&str>, saved: Option<&str>, computer: Option<&str>| {
            resolve_machine_name(chosen.map(str::to_string), saved.map(str::to_string), computer.map(str::to_string))
        };
        assert_eq!(resolve(None, None, Some("Studio")), MachineName { name: "Studio".into(), chosen: false, computer_name: studio() });
        assert_eq!(resolve(Some(" Desk "), Some("Old"), Some("Studio")), MachineName { name: "Desk".into(), chosen: true, computer_name: studio() });
        // A name saved by an earlier version stays, and is the user's while it differs from the computer's.
        assert_eq!(resolve(None, Some("Old"), Some("Studio")), MachineName { name: "Old".into(), chosen: true, computer_name: studio() });
        assert!(!resolve(None, Some("Studio"), Some("Studio")).chosen);
        assert_eq!(resolve(Some("  "), None, Some("Studio")).name, "Studio");
        // Nothing names this computer: a name that reads true on any computer.
        assert_eq!(resolve(None, None, None), MachineName { name: UNNAMED_HOST.into(), chosen: false, computer_name: None });
        assert_ne!(UNNAMED_HOST, PLACEHOLDER_HOST_NAME);

        // The placeholder is no saved name; neither is another account's.
        assert_eq!(saved_host_name(Some(&mirror("u1", Some("This Mac"))), "u1"), None);
        assert_eq!(saved_host_name(Some(&mirror("u1", Some(" Studio "))), "u1").as_deref(), Some("Studio"));
        assert_eq!(saved_host_name(Some(&mirror("u1", Some("Studio"))), "u2"), None);
        assert_eq!(saved_host_name(Some(&mirror("u1", None)), "u1"), None);
        assert_eq!(saved_host_name(None, "u1"), None);

        assert!(chosen_host_name(" \t ").is_err());
        assert!(chosen_host_name(&"n".repeat(81)).is_err());
        assert!(chosen_host_name("Desk\u{0007}").is_err());
        assert_eq!(chosen_host_name("  Desk Mac ").unwrap(), "Desk Mac");
    }

    #[tokio::test]
    async fn a_mac_that_saved_this_mac_is_named_and_renamed_without_relay() {
        let _home = crate::store::temp_home();
        let account = Arc::new(crate::account::AccountManager::default());
        account.set_context_for_test(Some(AccountContext {
            access_token: "token".into(),
            user_id: "u1".into(),
            email: "u1@example.invalid".into(),
            display_name: "U1".into(),
            profile_id: "profile".into(),
            organization_id: "org".into(),
            relay_entitled: true,
            generation: 1,
        }));
        let manager = PairingManager::new(account);
        let computer = recent_computer_name();
        let own_name = computer.clone().unwrap_or_else(|| UNNAMED_HOST.into());

        // What 0.2.21 left behind when opened from Finder or the Dock.
        registry::save_account_mirror(&mirror("u1", Some("This Mac"))).unwrap();
        assert_eq!(PairingManager::host_name("u1"), own_name);
        assert_eq!(manager.machine_name(), MachineName { name: own_name.clone(), chosen: false, computer_name: computer.clone() });

        // Relay is off: no host is bound and nothing is sent anywhere.
        assert!(manager.inner.lock().unwrap().host.is_none());
        let named = manager.set_host_name(Some("  Desk Mac ")).await.unwrap();
        assert_eq!(named, MachineName { name: "Desk Mac".into(), chosen: true, computer_name: computer.clone() });
        assert_eq!(PairingManager::host_name("u1"), "Desk Mac");
        // The name is the Mac's, whoever signs in next.
        assert_eq!(PairingManager::host_name("someone-else"), "Desk Mac");
        assert_eq!(crate::store::settings::load().machine_name.as_deref(), Some("Desk Mac"));
        let kept = registry::load_account_mirror().unwrap().unwrap();
        assert_eq!((kept.host_display_name, kept.binding_generation, kept.user_id.as_str()), (None, 7, "u1"));

        assert!(manager.set_host_name(Some("   ")).await.is_err());
        assert_eq!(PairingManager::host_name("u1"), "Desk Mac");

        // Cleared, it follows the computer's own name again.
        let named = manager.set_host_name(None).await.unwrap();
        assert_eq!(named, MachineName { name: own_name.clone(), chosen: false, computer_name: computer });
        assert_eq!(PairingManager::host_name("u1"), own_name);
        assert_eq!(crate::store::settings::load().machine_name, None);
    }

    #[test]
    fn removing_the_last_phone_with_the_window_open_removes_the_runtime_session() {
        use crate::keychain::testing::MemorySecrets;
        use serde_json::json;

        let _home = crate::store::temp_home();
        let root = crate::store::root().unwrap();
        let manager = PairingManager::with_secrets_for_test("com.terminalx.fixture", Arc::new(MemorySecrets::default()));
        manager.account.set_context_for_test(Some(AccountContext {
            access_token: "fixture-token".into(), user_id: "u1".into(), email: "u1@example.invalid".into(),
            display_name: "U1".into(), profile_id: "profile".into(), organization_id: "org".into(),
            relay_entitled: true, generation: 1,
        }));
        assert!(!crate::store::settings::load().machines.allow_operating);
        let devices = json!({"devices":[{
            "id":"phone", "label":"Phone", "platform":"ios", "token":"fixture-hash",
            "scope":"driver", "provenance":"explicit", "bindingGeneration":0,
            "createdAt":"2026-11-01T00:00:00Z", "approvedAt":"2026-11-01T00:00:00Z",
        }]});
        crate::store::write_json(&root.join("devices.json"), &devices).unwrap();
        manager.account.sync_runtime_copy();
        assert!(crate::machine_account::load(&root).unwrap().is_some());
        manager.revoke_local("phone").unwrap();
        assert!(crate::machine_account::load(&root).unwrap().is_none());
    }

    #[test]
    fn a_name_chosen_in_an_earlier_version_is_kept() {
        let _home = crate::store::temp_home();
        registry::save_account_mirror(&mirror("u1", Some("Studio"))).unwrap();
        assert_eq!(PairingManager::host_name("u1"), "Studio");
        // Another account on this Mac never saw that name.
        assert_ne!(PairingManager::host_name("u2"), "Studio");
    }
}
