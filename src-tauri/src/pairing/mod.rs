//! Optional account binding, pairing, and end-to-end encrypted transport.
//!
//! Nothing in this module performs network I/O until an account session exists
//! or the user explicitly asks for a pairing code.

mod cloud;
mod crypto;
mod model;
mod registry;
mod relay;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use uuid::Uuid;

use crate::account::{AccountContext, AccountManager};

use self::crypto::{
    begin_e2ee_session, encode_pairing_offer, random_token, seal_account_offer, token_hash,
    E2eeHello, HostKeypair, PayloadKind,
};
use self::model::{
    AccountMirror, AccountPairingGrant, DeviceEntry, DeviceProvenance, DeviceScope,
    HostBindingPayload, HostMetadata, PairingCode, PairingOffer, PairingTransport, RelayStatus,
    CAPABILITY, OFFER_TTL_MS,
};
pub use self::model::{PairingStatus, RelayPhase};
use self::registry::{DeviceRegistry, PairingSecrets};
use self::relay::{ConnectionOpen, DeviceCredentialInstallAuthorization, RelayLive};

pub const STATUS_EVENT: &str = "pairing_status";

#[derive(Default)]
struct Inner {
    relay: Option<RelayLive>,
    relay_status: RelayStatus,
    host: Option<HostMetadata>,
    active_pairing: Option<PairingCode>,
    pending_pairing_device: Option<String>,
    direct_endpoint: Option<String>,
    last_error: Option<String>,
}

pub struct PairingManager {
    account: Arc<AccountManager>,
    secrets: PairingSecrets,
    registry: DeviceRegistry,
    app: OnceLock<AppHandle>,
    inner: Mutex<Inner>,
    epoch: AtomicU64,
    stopped: AtomicBool,
    suspended_account_token: Mutex<Option<String>>,
    connections: Mutex<HashMap<String, Vec<mpsc::UnboundedSender<()>>>>,
}

#[derive(Clone, Debug)]
enum PairingConnectionContext {
    Direct {
        direct_auth_id: String,
    },
    Relay {
        relay_host_id: String,
        credential_kind: String,
        basis_conn_id: String,
    },
}

impl PairingManager {
    pub fn new(account: Arc<AccountManager>) -> Self {
        Self {
            account,
            secrets: PairingSecrets::default(),
            registry: DeviceRegistry::default(),
            app: OnceLock::new(),
            inner: Mutex::new(Inner::default()),
            epoch: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
            suspended_account_token: Mutex::new(None),
            connections: Mutex::new(HashMap::new()),
        }
    }

    pub fn configure(self: &Arc<Self>, app: &AppHandle, app_identifier: &str) -> Result<()> {
        self.secrets.configure(app_identifier)?;
        self.app
            .set(app.clone())
            .map_err(|_| anyhow!("pairing manager was already configured"))?;
        let manager = self.clone();
        tauri::async_runtime::spawn(async move { relay::supervise(manager).await });
        Ok(())
    }

    pub fn status(&self) -> PairingStatus {
        self.expire_pairing_if_needed();
        self.snapshot()
    }

    pub async fn generate_pairing(self: &Arc<Self>) -> Result<PairingStatus> {
        let endpoint = self.ensure_direct_listener().await?;
        let keypair = self.host_key(true)?;
        if let Some(previous) = self.inner.lock().unwrap().pending_pairing_device.take() {
            self.revoke_local(&previous)?;
        }
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
        };
        if let Err(error) = self.registry.add(entry) {
            let _ = self.secrets.delete_device_token(&device_id);
            return Err(error);
        }
        let relay = self.current_relay();
        let relay_offer = if let Some(relay) = relay {
            match relay.create_invite(device_id.clone()).await {
                Ok(offer) => Some(offer),
                Err(error) => {
                    log::warn!("could not add relay reachability to pairing code: {error:#}");
                    None
                }
            }
        } else {
            None
        };
        let expires_at = relay_offer
            .as_ref()
            .map(|relay| relay.invite_expires_at)
            .unwrap_or_else(|| Utc::now().timestamp_millis() + OFFER_TTL_MS)
            .min(Utc::now().timestamp_millis() + OFFER_TTL_MS);
        let offer = PairingOffer {
            v: 2,
            endpoint,
            device_token: token,
            public_key_b64: keypair.public_key_b64(),
            paired_device_id: device_id.clone(),
            scope: "mobile".into(),
            identity_mode: "inherit".into(),
            relay: relay_offer,
        };
        let pairing = PairingCode {
            pairing_url: encode_pairing_offer(&offer)?,
            expires_at,
            transport: if offer.relay.is_some() {
                PairingTransport::Relay
            } else {
                PairingTransport::Direct
            },
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.active_pairing = Some(pairing);
            inner.pending_pairing_device = Some(device_id);
            inner.last_error = None;
        }
        self.emit();
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
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(relay) = self.inner.lock().unwrap().relay.take() {
            relay.shutdown();
        }
        for senders in self.connections.lock().unwrap().values() {
            for sender in senders {
                let _ = sender.send(());
            }
        }
    }

    pub async fn set_host_name(&self, display_name: &str) -> Result<PairingStatus> {
        let display_name = display_name.trim();
        if display_name.is_empty()
            || display_name.chars().count() > 80
            || display_name.chars().any(char::is_control)
        {
            bail!("machine name must contain 1 to 80 visible characters");
        }
        let context = self
            .account_context()
            .ok_or_else(|| anyhow!("sign in before changing this Mac’s name"))?;
        let mut mirror = registry::load_account_mirror()?
            .filter(|mirror| mirror.user_id == context.user_id)
            .ok_or_else(|| anyhow!("host binding is not ready"))?;
        let keypair = self.host_key(false)?;
        let payload = HostBindingPayload {
            host_id: keypair.host_id(),
            host_public_key_b64: keypair.public_key_b64(),
            binding_generation: mirror.binding_generation,
            display_name: display_name.into(),
            platform: "darwin".into(),
            environment_kind: "native".into(),
            capabilities: vec![CAPABILITY.into()],
        };
        let context_for_bind = context.clone();
        let payload_for_bind = payload.clone();
        tokio::task::spawn_blocking(move || {
            cloud::register_host(&context_for_bind, &payload_for_bind)
        })
        .await??;
        mirror.host_display_name = Some(display_name.into());
        registry::save_account_mirror(&mirror)?;
        if let Some(host) = self.inner.lock().unwrap().host.as_mut() {
            host.display_name = display_name.into();
            host.last_seen_at = Some(Utc::now().to_rfc3339());
        }
        self.emit();
        Ok(self.snapshot())
    }

    pub(super) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub(super) fn account_context(&self) -> Option<AccountContext> {
        self.account.context()
    }

    pub(super) fn relay_permitted(&self, context: &AccountContext) -> bool {
        let mut suspended = self.suspended_account_token.lock().unwrap();
        if suspended.as_deref() == Some(&context.access_token) {
            return false;
        }
        if suspended.is_some() {
            *suspended = None;
        }
        true
    }

    pub(super) fn host_key(&self, create: bool) -> Result<HostKeypair> {
        self.secrets
            .host_key(create)?
            .ok_or_else(|| anyhow!("host identity is unavailable"))
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
        self.inner.lock().unwrap().relay_status = RelayStatus {
            phase: RelayPhase::Connecting,
            message: Some("Connecting securely…".into()),
            attempt,
        };
        self.emit();
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
        let endpoint = match self.ensure_direct_listener().await {
            Ok(endpoint) => endpoint,
            Err(error) => {
                self.set_error(format!("Direct pairing listener failed: {error:#}"));
                return;
            }
        };
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
        let display_name = previous
            .as_ref()
            .filter(|mirror| mirror.user_id == context.user_id)
            .and_then(|mirror| mirror.host_display_name.clone())
            .unwrap_or_else(host_display_name);
        let mirror = AccountMirror {
            user_id: context.user_id.clone(),
            email: context.email.clone(),
            display_name: context.display_name.clone(),
            host_display_name: Some(display_name.clone()),
            binding_generation: generation,
        };
        if let Err(error) = registry::save_account_mirror(&mirror) {
            self.set_error(format!("Could not save host binding fence: {error:#}"));
            return;
        }
        let payload = HostBindingPayload {
            host_id: keypair.host_id(),
            host_public_key_b64: keypair.public_key_b64(),
            binding_generation: generation,
            display_name: display_name.clone(),
            platform: "darwin".into(),
            environment_kind: "native".into(),
            capabilities: vec![CAPABILITY.into()],
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
                display_name,
                platform: "macOS".into(),
                app_version: env!("CARGO_PKG_VERSION").into(),
                last_seen_at: Some(Utc::now().to_rfc3339()),
            });
            inner.last_error = None;
        }
        self.emit();
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager
                .host_poll(epoch, context, relay, endpoint, generation)
                .await;
        });
    }

    async fn host_poll(
        self: Arc<Self>,
        epoch: u64,
        context: AccountContext,
        relay: RelayLive,
        endpoint: String,
        generation: u64,
    ) {
        let host_id = relay.relay_host_id.clone();
        let mut last_heartbeat = 0i64;
        while self.is_epoch(epoch) && !self.is_stopped() {
            let now = Utc::now().timestamp_millis();
            let context_for_request = context.clone();
            let host_for_request = host_id.clone();
            let poll = tokio::task::spawn_blocking(move || -> Result<_> {
                if now - last_heartbeat >= 30_000 {
                    cloud::heartbeat(&context_for_request, &host_for_request, generation, "live")?;
                }
                let grants =
                    cloud::pending_grants(&context_for_request, &host_for_request, generation)?;
                let revocations = cloud::pending_revocations(
                    &context_for_request,
                    &host_for_request,
                    generation,
                )?;
                Ok((grants, revocations))
            })
            .await;
            match poll {
                Ok(Ok((grants, revocations))) => {
                    if now - last_heartbeat >= 30_000 {
                        last_heartbeat = now;
                        if let Some(host) = self.inner.lock().unwrap().host.as_mut() {
                            host.last_seen_at = Some(Utc::now().to_rfc3339());
                        }
                    }
                    for grant in grants {
                        self.fulfill_grant(epoch, &context, &relay, &endpoint, generation, grant)
                            .await;
                    }
                    for revocation in revocations {
                        if revocation.user_id != context.user_id
                            || revocation.host_id != host_id
                            || revocation.binding_generation != generation
                        {
                            continue;
                        }
                        if let Ok(Some(device)) = self.registry.revoke_automatic_grant(
                            &context.user_id,
                            &revocation.client_installation_id,
                            &revocation.grant_request_id,
                        ) {
                            let _ = self.secrets.delete_device_token(&device.id);
                            self.cancel_connections(&device.id);
                            relay.revoke(device.id);
                        }
                        let context = context.clone();
                        let host_id = host_id.clone();
                        let revocation_id = revocation.revocation_id;
                        let _ = tokio::task::spawn_blocking(move || {
                            cloud::acknowledge_revocation(
                                &context,
                                &host_id,
                                &revocation_id,
                                generation,
                            )
                        })
                        .await;
                    }
                    self.emit();
                }
                Ok(Err(error)) => {
                    log::debug!("host binding poll failed: {error:#}");
                }
                Err(error) => log::warn!("host binding poll task failed: {error}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }

    async fn fulfill_grant(
        &self,
        epoch: u64,
        context: &AccountContext,
        relay: &RelayLive,
        endpoint: &str,
        generation: u64,
        grant: AccountPairingGrant,
    ) {
        if !valid_grant(&grant, context, &relay.relay_host_id, generation) {
            return;
        }
        let result = self
            .build_automatic_offer(epoch, context, relay, endpoint, generation, &grant)
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
        endpoint: &str,
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
            let offer = PairingOffer {
                v: 2,
                endpoint: endpoint.into(),
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

    async fn ensure_direct_listener(self: &Arc<Self>) -> Result<String> {
        if let Some(endpoint) = self.inner.lock().unwrap().direct_endpoint.clone() {
            return Ok(endpoint);
        }
        // The direct endpoint is part of the durable pairing contract. The
        // stable deployed port keeps it valid across app restarts.
        let listener =
            tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 6768)).await?;
        let port = listener.local_addr()?.port();
        let address = advertised_ipv4().unwrap_or(std::net::Ipv4Addr::LOCALHOST);
        let endpoint = format!("ws://{address}:{port}");
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(existing) = inner.direct_endpoint.as_ref() {
                return Ok(existing.clone());
            }
            inner.direct_endpoint = Some(endpoint.clone());
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let manager = manager.clone();
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let socket = tokio_tungstenite::accept_async(stream).await?;
                        manager
                            .handle_e2ee_socket(
                                socket,
                                PairingConnectionContext::Direct {
                                    direct_auth_id: Uuid::new_v4().simple().to_string(),
                                },
                                None,
                            )
                            .await
                    }
                    .await;
                    if let Err(error) = result {
                        log::debug!("direct paired-device connection ended: {error:#}");
                    }
                });
            }
        });
        Ok(endpoint)
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
            bail!("relay connection named a different host key");
        }
        let expected_device = connection.relay_device_id.clone();
        let socket = relay::open_data_socket(&cell_url, generation, &connection).await?;
        // The plaintext relay hello is sent to the phone only. The host data
        // leg starts with the phone's E2EE hello after its one auth frame.
        let context = PairingConnectionContext::Relay {
            relay_host_id,
            credential_kind: connection.kind,
            basis_conn_id: connection.conn_id,
        };
        self.handle_e2ee_socket(socket, context, Some(expected_device))
            .await
    }

    async fn handle_e2ee_socket<S>(
        &self,
        mut socket: WebSocketStream<S>,
        connection: PairingConnectionContext,
        expected_device_id: Option<String>,
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
        let (transport, relay_host_id) = match &connection {
            PairingConnectionContext::Direct { .. } => ("direct", None),
            PairingConnectionContext::Relay { relay_host_id, .. } => {
                ("relay", Some(relay_host_id.as_str()))
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
        let frame = text_frame_bytes(auth_frame)?;
        let auth_plaintext = session.open(&frame, PayloadKind::Text)?;
        let auth: E2eeAuth = serde_json::from_slice(&auth_plaintext)?;
        if auth.kind != "e2ee_auth"
            || auth.v != Some(2)
            || auth.transcript_hash_b64.as_deref() != Some(&session.transcript_hash_b64)
        {
            bail!("E2EE authentication was not bound to the handshake");
        }
        let generation = registry::load_account_mirror()
            .ok()
            .flatten()
            .map(|mirror| mirror.binding_generation);
        let device = self
            .registry
            .find_by_token(&auth.device_token, generation)?
            .ok_or_else(|| anyhow!("paired-device credential was refused"))?;
        if expected_device_id
            .as_deref()
            .is_some_and(|id| id != device.id)
        {
            bail!("relay invite was used by a different device credential");
        }
        self.registry
            .touch(&device.id, &session.client_public_key_b64)?;
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.pending_pairing_device.as_deref() == Some(&device.id) {
                inner.pending_pairing_device = None;
                inner.active_pairing = None;
            }
        }
        let authenticated = serde_json::json!({
            "type": "e2ee_authenticated",
            "v": 2,
            "transcriptHashB64": session.transcript_hash_b64,
        });
        send_encrypted_text(&mut socket, &mut session, &authenticated.to_string()).await?;
        let (cancel_tx, mut cancel_rx) = mpsc::unbounded_channel();
        self.connections
            .lock()
            .unwrap()
            .entry(device.id.clone())
            .or_default()
            .push(cancel_tx);
        self.emit();
        loop {
            tokio::select! {
                _ = cancel_rx.recv() => {
                    let _ = socket.close(None).await;
                    return Ok(());
                }
                incoming = socket.next() => {
                    let Some(incoming) = incoming else { return Ok(()); };
                    let incoming = incoming?;
                    match incoming {
                        Message::Text(text) => {
                            let bytes = decode_canonical_base64(&text)?;
                            let plaintext = session.open(&bytes, PayloadKind::Text)?;
                            let request: serde_json::Value = serde_json::from_slice(&plaintext)?;
                            let response = self.rpc_response(&request, &device, &connection).await;
                            send_encrypted_text(&mut socket, &mut session, &response.to_string()).await?;
                        }
                        Message::Binary(bytes) => {
                            // Binary application streams are deliberately not attached to a
                            // workspace in this foundation. Authentication and framing still
                            // fail closed and the socket remains usable for RPC refusals.
                            let _ = session.open(&bytes, PayloadKind::Binary)?;
                        }
                        Message::Close(_) => return Ok(()),
                        Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
                        Message::Pong(_) | Message::Frame(_) => {}
                    }
                }
            }
        }
    }

    async fn rpc_response(
        &self,
        request: &serde_json::Value,
        device: &DeviceEntry,
        connection: &PairingConnectionContext,
    ) -> serde_json::Value {
        let id = request
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
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
            _ => return static_rpc_response(request, device.scope),
        };
        match result {
            Ok(result) => serde_json::json!({
                "id": id,
                "ok": true,
                "result": result,
                "_meta": { "runtimeId": "desktop" }
            }),
            Err(error) => serde_json::json!({
                "id": id,
                "ok": false,
                "error": { "code": "unavailable", "message": error.to_string() },
                "_meta": { "runtimeId": "desktop" }
            }),
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
            PairingConnectionContext::Direct { direct_auth_id } => {
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
            return Ok(serde_json::json!({ "v": 1, "relay": null }));
        };
        if let PairingConnectionContext::Relay { relay_host_id, .. } = connection {
            if relay_host_id != &relay.relay_host_id {
                bail!("relay connection belongs to a stale host assignment");
            }
        }
        let mut result = serde_json::json!({
            "v": 1,
            "relay": {
                "v": 1,
                "directorUrl": cloud::RELAY_DIRECTOR_URL,
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

    fn revoke_local(&self, device_id: &str) -> Result<()> {
        let _ = self.registry.revoke(device_id)?;
        self.secrets.delete_device_token(device_id)?;
        self.cancel_connections(device_id);
        let mut inner = self.inner.lock().unwrap();
        if inner.pending_pairing_device.as_deref() == Some(device_id) {
            inner.pending_pairing_device = None;
            inner.active_pairing = None;
        }
        Ok(())
    }

    fn cancel_connections(&self, device_id: &str) {
        if let Some(senders) = self.connections.lock().unwrap().remove(device_id) {
            for sender in senders {
                let _ = sender.send(());
            }
        }
    }

    fn current_relay(&self) -> Option<RelayLive> {
        self.inner.lock().unwrap().relay.clone()
    }

    fn snapshot(&self) -> PairingStatus {
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
                .collect(),
            active_pairing: inner.active_pairing.clone(),
            last_error: inner.last_error.clone(),
        }
    }

    fn emit(&self) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(STATUS_EVENT, self.snapshot());
        }
    }

    fn set_error(&self, message: String) {
        self.inner.lock().unwrap().last_error = Some(message);
        self.emit();
    }

    fn expire_pairing_if_needed(&self) {
        let expired = {
            let mut inner = self.inner.lock().unwrap();
            if inner
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
        }
    }

    fn is_epoch(&self, epoch: u64) -> bool {
        !self.is_stopped() && self.epoch.load(Ordering::SeqCst) == epoch
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct E2eeAuth {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    v: Option<u8>,
    #[serde(default)]
    transcript_hash_b64: Option<String>,
    device_token: String,
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
) -> bool {
    grant.user_id == context.user_id
        && grant.host_id == host_id
        && grant.binding_generation == generation
        && grant.installation_generation > 0
        && grant.associated_data_version == 1
        && grant.requested_scope == "mobile"
        && grant.state == "pending"
        && DateTime::parse_from_rfc3339(&grant.expires_at).is_ok_and(|expiry| expiry > Utc::now())
}

fn host_display_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .and_then(|name| name.split('.').next().map(str::to_string))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "This Mac".into())
}

fn advertised_ipv4() -> Option<std::net::Ipv4Addr> {
    if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .find_map(|interface| {
            let std::net::IpAddr::V4(address) = interface.ip() else {
                return None;
            };
            (!address.is_loopback() && !address.is_link_local()).then_some(address)
        })
}

fn text_frame_bytes(message: Message) -> Result<Vec<u8>> {
    match message {
        Message::Text(text) => decode_canonical_base64(&text),
        _ => bail!("encrypted authentication frame was not text"),
    }
}

fn decode_canonical_base64(value: &str) -> Result<Vec<u8>> {
    let bytes = general_purpose::STANDARD.decode(value)?;
    if general_purpose::STANDARD.encode(&bytes) != value {
        bail!("encrypted text frame was not canonical base64");
    }
    Ok(bytes)
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

async fn send_encrypted_text<S>(
    socket: &mut WebSocketStream<S>,
    session: &mut crypto::E2eeSession,
    plaintext: &str,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let frame = session.seal(plaintext.as_bytes(), PayloadKind::Text)?;
    socket
        .send(Message::Text(
            general_purpose::STANDARD.encode(frame).into(),
        ))
        .await?;
    Ok(())
}

fn static_rpc_response(request: &serde_json::Value, scope: DeviceScope) -> serde_json::Value {
    let id = request
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let method = request
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if method == "status.get" && allowed_method(scope, method) {
        return serde_json::json!({
            "id": id,
            "ok": true,
            "result": { "protocolVersion": 2, "product": "TerminalX", "deviceScope": scope },
            "_meta": { "runtimeId": "desktop" }
        });
    }
    let (code, message) = if allowed_method(scope, method) {
        (
            "unavailable",
            "This paired-device method is not connected to a workspace yet".into(),
        )
    } else {
        (
            "forbidden",
            format!("Method '{method}' is not available to this paired device"),
        )
    };
    serde_json::json!({
        "id": id,
        "ok": false,
        "error": { "code": code, "message": message },
        "_meta": { "runtimeId": "desktop" }
    })
}

fn allowed_method(scope: DeviceScope, method: &str) -> bool {
    const VIEWER: &[&str] = &[
        "status.get",
        "presence.join",
        "presence.leave",
        "presence.heartbeat",
        "presence.list",
        "chat.post",
        "chat.list",
        "session.status",
        "session.roster",
        "session.tabs.list",
        "terminal.read",
        "terminal.subscribe",
        "terminal.unsubscribe",
    ];
    const DRIVER: &[&str] = &[
        "pairing.getEndpoints",
        "pairing.provisionRelay",
        "terminal.send",
        "terminal.control.get",
        "terminal.control.acquire",
        "terminal.control.release",
        "steerLease.get",
        "steerLease.acquire",
        "steerLease.release",
        "steerLease.queueInput",
    ];
    VIEWER.contains(&method) || (scope == DeviceScope::Driver && DRIVER.contains(&method))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_device_scopes_are_deny_by_default() {
        assert!(allowed_method(DeviceScope::Viewer, "terminal.read"));
        assert!(!allowed_method(DeviceScope::Viewer, "terminal.send"));
        assert!(allowed_method(DeviceScope::Driver, "terminal.send"));
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
            device_token: "token".into(),
            public_key_b64: key.public_key_b64(),
            paired_device_id: "device".into(),
            scope: "mobile".into(),
            identity_mode: "inherit".into(),
            relay: None,
        };
        assert_eq!(offer.public_key_b64, key.public_key_b64());
        assert!(encode_pairing_offer(&offer)
            .unwrap()
            .starts_with("terminalx://pair?code="));
    }
}
