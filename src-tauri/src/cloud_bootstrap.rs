//! The cloud workspace bootstrap for `terminalx-serve` (PRO-42): trade the
//! one-time bootstrap token the VM was provisioned with for a runtime
//! credential, then keep the relay session fresh with it.
//!
//! The wire contract is the one the legacy AppImage runtime speaks with
//! terminalx-saas `apps/api` (`POST /v1/cloud-workspace-bootstrap/redeem` and
//! `/refresh`). What this module adds is replay safety, step by step:
//!
//! 1. The relay host key is generated once and written durably before the
//!    token is ever sent, so the relay host id the server binds to the token
//!    is the same on every attempt. A restart can never register a second
//!    identity.
//! 2. The token file is left alone until the runtime credential it bought is
//!    durably on disk (temp file, fsync, rename, fsync of the directory).
//!    Only then is the token deleted.
//! 3. A restart with a stored credential refreshes instead of redeeming, and
//!    finishes deleting a token a previous run left behind. A token that is
//!    not the one already spent was delivered by a fenced restart
//!    (terminalx-saas PRO-33) and is redeemed first, replacing the stored
//!    credential the server revoked.
//! 4. A restart between the server committing the redeem and the credential
//!    reaching the disk redeems again with the same token and the same host
//!    key; the server replays the redeem for that identity (terminalx-saas
//!    PRO-42) instead of treating the token as spent.
//!
//! Relay host registration with the session this produces is PRO-13.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

pub const ORIGIN_ENV: &str = "TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_ORIGIN";
pub const TOKEN_PATH_ENV: &str = "TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_TOKEN_PATH";

/// Advertised on refresh. The server adds a response field only for a
/// capability the runtime names, because the refresh schema is strict.
/// `organization-setup-v*` (first-run credentials and repository clone) is
/// left out until this runtime can apply it.
pub const CAPABILITIES: &str = "organization-access-v1";
const CAPABILITIES_HEADER: &str = "x-terminalx-cloud-workspace-runtime-capabilities";
pub(crate) const VERSION_HEADER: &str = "x-terminalx-cloud-workspace-runtime-version";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const STATE_DIR: &str = "cloud-workspace";
const HOST_KEY_FILE: &str = "host-key.json";
const STATE_FILE: &str = "runtime.json";
/// Next to the bootstrap token, in the runtime's state root
/// (`/var/lib/terminalx`), where the worker's memory probe reads it.
const BASELINE_FILE: &str = "memory-baseline.json";
const MAX_LIST: usize = 256;

/// The server refused the token or the credential. Retrying cannot help:
/// the process exits with [`REJECTED_EXIT_CODE`] so systemd stops restarting
/// it until a new token is provisioned.
#[derive(Debug)]
pub struct Rejected(pub &'static str);

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Rejected {}

pub const REJECTED_EXIT_CODE: i32 = 3;

/// Where the bootstrap talks to and keeps its state.
#[derive(Debug, Clone)]
pub struct Config {
    pub origin: String,
    pub token_path: PathBuf,
    pub state_dir: PathBuf,
}

impl Config {
    /// `None` when the environment names no bootstrap at all (a cloud
    /// workspace runtime started by hand); an error when it is half set.
    pub fn from_env(data_dir: &Path) -> Result<Option<Self>> {
        let origin = std::env::var(ORIGIN_ENV).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        let token_path = std::env::var(TOKEN_PATH_ENV).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        match (origin, token_path) {
            (None, None) => Ok(None),
            (Some(origin), Some(token_path)) => {
                if !canonical_origin(&origin) {
                    bail!("{ORIGIN_ENV} must be an https origin (or http on loopback)");
                }
                Ok(Some(Self { origin, token_path: token_path.into(), state_dir: data_dir.join(STATE_DIR) }))
            }
            _ => bail!("set both {ORIGIN_ENV} and {TOKEN_PATH_ENV}, or neither"),
        }
    }

    /// Where the memory baseline goes (`memory_baseline`).
    pub fn baseline_path(&self) -> PathBuf {
        self.token_path.with_file_name(BASELINE_FILE)
    }
}

/// The relay host key: X25519, like the desktop's pairing key.
#[derive(Clone)]
pub struct HostKey {
    secret: [u8; 32],
    public: [u8; 32],
}

impl HostKey {
    fn generate() -> Self {
        let mut secret = StaticSecret::random_from_rng(OsRng).to_bytes();
        let key = Self::from_secret(secret);
        secret.zeroize();
        key
    }

    fn from_secret(secret: [u8; 32]) -> Self {
        // StaticSecret wipes itself on drop.
        let public = PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        Self { secret, public }
    }

    pub fn public_key_b64(&self) -> String {
        general_purpose::STANDARD.encode(self.public)
    }

    /// The secret, for the relay host's proof and E2EE (PRO-13).
    pub(crate) fn secret(&self) -> [u8; 32] {
        self.secret
    }

    /// Matches the server's `deriveRelayHostId`.
    pub fn relay_host_id(&self) -> String {
        general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(self.public))[..16].to_string()
    }
}

impl Drop for HostKey {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostKeyFile {
    v: u8,
    secret: String,
}

impl Zeroize for HostKeyFile {
    fn zeroize(&mut self) {
        self.secret.zeroize();
    }
}

/// What survives a restart once the token is spent.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredIdentity {
    v: u8,
    workspace_id: String,
    organization_id: String,
    relay_host_id: String,
    /// Which token bought the credential, so only that one is deleted.
    token_sha256: String,
    runtime_credential: String,
}

impl Drop for StoredIdentity {
    fn drop(&mut self) {
        self.runtime_credential.zeroize();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    Private,
    Organization,
}

/// The relay session the runtime registers with (PRO-13). Not `Debug`: it
/// carries the relay token and the attached devices' tokens.
// TODO(PRO-13): the relay host reads the token, director and attachments.
#[allow(dead_code)]
#[derive(Clone)]
pub struct Session {
    pub workspace_id: String,
    pub organization_id: String,
    pub relay_host_id: String,
    pub relay_token: String,
    pub relay_token_expires_at: u64,
    pub director_url: String,
    /// Absent from an older server, which means the closed default.
    pub access_mode: AccessMode,
    /// Pending attachments and revocations, handed to the relay host (PRO-13).
    pub attachments: Vec<serde_json::Value>,
    pub revocations: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Redeemed {
    v: u8,
    workspace_id: String,
    organization_id: String,
    relay_token: String,
    relay_token_expires_at: u64,
    director_url: String,
    runtime_credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Refreshed {
    v: u8,
    workspace_id: String,
    organization_id: String,
    relay_token: String,
    relay_token_expires_at: u64,
    director_url: String,
    attachments: Vec<serde_json::Value>,
    revocations: Vec<serde_json::Value>,
    // Sent only to a runtime that advertises `organization-setup-*`, which
    // this one does not; tolerated so a server that sends it anyway does not
    // take the workspace down.
    #[serde(default)]
    setup: Option<serde_json::Value>,
    #[serde(default)]
    access_mode: Option<AccessMode>,
}

impl Drop for Redeemed {
    fn drop(&mut self) {
        self.runtime_credential.zeroize();
        self.relay_token.zeroize();
    }
}

impl Drop for Refreshed {
    fn drop(&mut self) {
        self.relay_token.zeroize();
    }
}

/// Why a call failed: the server said no, or it could not be asked.
#[derive(Debug)]
pub enum CallError {
    Rejected,
    Transient(anyhow::Error),
}

/// The two calls the bootstrap makes; a trait so tests can stand in for the
/// server.
pub trait Api {
    fn redeem(&self, token: &str, key: &HostKey) -> Result<Redeemed, CallError>;
    fn refresh(&self, credential: &str) -> Result<Refreshed, CallError>;
}

pub struct HttpApi {
    origin: String,
    agent: ureq::Agent,
}

impl HttpApi {
    pub fn new(origin: &str) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).redirects(0).user_agent(&format!("terminalx-serve/{VERSION}")).build();
        Self { origin: origin.to_string(), agent }
    }

    fn post<T: serde::de::DeserializeOwned>(&self, path: &str, bearer: &str, body: serde_json::Value, extra: Option<(&str, &str)>) -> Result<T, CallError> {
        let mut request = self
            .agent
            .post(&format!("{}{path}", self.origin))
            .set("authorization", &format!("Bearer {bearer}"))
            .set("content-type", "application/json")
            .set(VERSION_HEADER, VERSION);
        if let Some((name, value)) = extra {
            request = request.set(name, value);
        }
        match request.send_json(body) {
            Ok(response) => response.into_json::<T>().map_err(|error| CallError::Transient(anyhow!("{path}: unreadable response: {error}"))),
            Err(ureq::Error::Status(401, _)) => Err(CallError::Rejected),
            Err(ureq::Error::Status(status, _)) => Err(CallError::Transient(anyhow!("{path}: HTTP {status}"))),
            // The URL carries no secret; the transport error is safe to log.
            Err(ureq::Error::Transport(error)) => Err(CallError::Transient(anyhow!("{path}: {error}"))),
        }
    }
}

impl Api for HttpApi {
    fn redeem(&self, token: &str, key: &HostKey) -> Result<Redeemed, CallError> {
        let body = serde_json::json!({ "relayHostId": key.relay_host_id(), "hostPublicKeyB64": key.public_key_b64() });
        self.post("/v1/cloud-workspace-bootstrap/redeem", token, body, None)
    }

    fn refresh(&self, credential: &str) -> Result<Refreshed, CallError> {
        self.post("/v1/cloud-workspace-bootstrap/refresh", credential, serde_json::json!({}), Some((CAPABILITIES_HEADER, CAPABILITIES)))
    }
}

/// A bootstrapped runtime: its session and what it needs to refresh it.
pub struct Bootstrapped {
    pub key: HostKey,
    pub session: Mutex<Session>,
    credential: Zeroizing<String>,
    /// Set while the server rejects the runtime credential (the workspace
    /// was revoked or rotated); the relay host stops serving meanwhile.
    rejected: std::sync::atomic::AtomicBool,
    baseline_path: PathBuf,
    /// The generation the baseline was last recorded for.
    baseline_generation: std::sync::atomic::AtomicU64,
    // Held for the life of the process: one runtime per state directory.
    _lock: StateLock,
}

/// How long `establish` keeps trying.
#[derive(Debug, Clone)]
pub struct Policy {
    pub backoff_start: Duration,
    pub backoff_cap: Duration,
    /// A 401 is also what the server answers while the workspace is briefly in
    /// another state or its relay signing key is missing, so a rejection only
    /// becomes permanent once it has lasted this long: the bootstrap token's
    /// own lifetime.
    pub rejected_window: Duration,
    /// Stop retrying altogether after this long. `None` in production: a
    /// cloud workspace has nothing better to do than wait for its API.
    pub give_up_after: Option<Duration>,
}

impl Default for Policy {
    fn default() -> Self {
        Self { backoff_start: Duration::from_secs(1), backoff_cap: Duration::from_secs(30), rejected_window: Duration::from_secs(10 * 60), give_up_after: None }
    }
}

impl Policy {
    /// The default, except that debug builds let the tests shorten the
    /// rejection window with `TERMINALX_SERVE_TEST_REJECTED_WINDOW_MS`.
    pub fn from_env() -> Self {
        #[allow(unused_mut)]
        let mut policy = Self::default();
        #[cfg(debug_assertions)]
        if let Some(ms) = std::env::var("TERMINALX_SERVE_TEST_REJECTED_WINDOW_MS").ok().and_then(|value| value.parse().ok()) {
            policy.rejected_window = Duration::from_millis(ms);
            policy.backoff_start = Duration::from_millis(50);
        }
        policy
    }
}

/// One attempt's failure.
enum Failure {
    /// Retry: the server could not be reached, or it said no (which lasts
    /// only so long before it counts).
    Retry { error: anyhow::Error, rejected: Option<&'static str> },
    /// No retry can help.
    Fatal(anyhow::Error),
}

/// Establish the runtime's identity: refresh with the stored credential, or
/// redeem the bootstrap token for one. Every step can be killed and retried,
/// and a failure that may clear up is retried here, with backoff, rather than
/// by systemd, whose start limit would give up within a minute.
pub fn establish(config: &Config, api: &dyn Api, policy: &Policy) -> Result<Bootstrapped> {
    ensure_private_dir(&config.state_dir)?;
    let lock = StateLock::acquire(&config.state_dir)?;
    let key = load_or_create_host_key(&config.state_dir)?;
    crash_point("host-key-persisted");
    let mut delay = policy.backoff_start;
    let mut rejected_since: Option<Instant> = None;
    let started = Instant::now();
    loop {
        let (error, rejected) = match attempt(config, api, &key) {
            Ok((session, credential)) => {
                return Ok(Bootstrapped {
                    key,
                    session: Mutex::new(session),
                    credential,
                    rejected: std::sync::atomic::AtomicBool::new(false),
                    baseline_path: config.baseline_path(),
                    baseline_generation: std::sync::atomic::AtomicU64::new(u64::MAX),
                    _lock: lock,
                })
            }
            Err(Failure::Fatal(error)) => return Err(error),
            Err(Failure::Retry { error, rejected }) => (error, rejected),
        };
        match rejected {
            Some(code) => {
                let since = *rejected_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= policy.rejected_window {
                    return Err(anyhow::Error::new(Rejected(code)).context(format!("{error:#}")));
                }
            }
            None => rejected_since = None,
        }
        if policy.give_up_after.is_some_and(|limit| started.elapsed() >= limit) {
            return Err(error.context("gave up retrying"));
        }
        log::warn!("cloud workspace bootstrap: {error:#}; retrying in {}ms", delay.as_millis());
        std::thread::sleep(delay);
        delay = (delay * 2).min(policy.backoff_cap);
    }
}

fn attempt(config: &Config, api: &dyn Api, key: &HostKey) -> Result<(Session, Zeroizing<String>), Failure> {
    let relay_host_id = key.relay_host_id();
    let Some(stored) = read_identity(&config.state_dir).map_err(Failure::Fatal)? else {
        return redeem(config, api, key, None);
    };
    if stored.relay_host_id != relay_host_id {
        // Only a hand-edited state dir gets here; guessing which half is
        // right could register a second identity.
        return Err(Failure::Fatal(anyhow!("the stored runtime identity belongs to a different host key")));
    }
    // A fenced restart (terminalx-saas PRO-33) delivers a new token and
    // revokes the stored credential, so a delivered token goes first. If it
    // does not work, the stored credential still may: a stale or foreign
    // token must not take down a runtime whose credential is live. Such a
    // token stays on disk (a 401 can be temporary) and is tried again on
    // the next start.
    let delivered = if token_is_new(&config.token_path, &stored.token_sha256) {
        match redeem(config, api, key, Some((&stored.workspace_id, &stored.organization_id))) {
            Err(Failure::Retry { error, rejected }) => {
                log::warn!("{error:#}; refreshing with the stored runtime credential instead");
                Some(Failure::Retry { error, rejected })
            }
            other => return other,
        }
    } else {
        None
    };
    // When both fail, the delivered token's failure is the one reported:
    // it is the way back in once the stored credential was revoked.
    let refused = |failure: Failure| Err(delivered.unwrap_or(failure));
    match api.refresh(&stored.runtime_credential) {
        Ok(refreshed) => {
            let session = session_from_refresh(refreshed, &relay_host_id).map_err(Failure::Fatal)?;
            if session.workspace_id != stored.workspace_id || session.organization_id != stored.organization_id {
                return Err(Failure::Fatal(anyhow!("the server answered for a different workspace")));
            }
            // A previous run stored the credential but was stopped before
            // it could delete the token it spent. A different token is a
            // newly provisioned one and stays.
            remove_spent_token(&config.token_path, &stored.token_sha256).map_err(Failure::Fatal)?;
            Ok((session, Zeroizing::new(stored.runtime_credential.clone())))
        }
        Err(CallError::Rejected) => {
            refused(Failure::Retry { error: anyhow!("the stored runtime credential was rejected"), rejected: Some("cloud_workspace_runtime_credential_rejected") })
        }
        Err(CallError::Transient(error)) => refused(Failure::Retry { error: error.context("refresh the runtime session"), rejected: None }),
    }
}

/// Trade the token on disk for a credential, store it durably (replacing any
/// stored identity, which must be for the same workspace), and only then
/// delete the token.
fn redeem(config: &Config, api: &dyn Api, key: &HostKey, stored: Option<(&str, &str)>) -> Result<(Session, Zeroizing<String>), Failure> {
    let relay_host_id = key.relay_host_id();
    let token = read_token(&config.token_path).map_err(Failure::Fatal)?;
    crash_point("before-redeem");
    let mut redeemed = match api.redeem(&token, key) {
        Ok(redeemed) => redeemed,
        // Kept on disk either way: the token is the only way in.
        Err(CallError::Rejected) => {
            return Err(Failure::Retry { error: anyhow!("the bootstrap token was rejected"), rejected: Some("cloud_workspace_bootstrap_token_rejected") });
        }
        Err(CallError::Transient(error)) => return Err(Failure::Retry { error: error.context("redeem the bootstrap token"), rejected: None }),
    };
    crash_point("after-redeem-response");
    validate_redeemed(&redeemed).map_err(Failure::Fatal)?;
    if stored.is_some_and(|(workspace, organization)| redeemed.workspace_id != workspace || redeemed.organization_id != organization) {
        // Treated like a refused token: the stored identity stays.
        return Err(Failure::Retry {
            error: anyhow!("the delivered bootstrap token is for a different workspace"),
            rejected: Some("cloud_workspace_bootstrap_token_foreign"),
        });
    }
    let stored = StoredIdentity {
        v: 1,
        workspace_id: redeemed.workspace_id.clone(),
        organization_id: redeemed.organization_id.clone(),
        relay_host_id: relay_host_id.clone(),
        token_sha256: token_sha256(&token),
        runtime_credential: redeemed.runtime_credential.clone(),
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&stored).map_err(|error| Failure::Fatal(error.into()))?);
    write_durable(&config.state_dir.join(STATE_FILE), &bytes).map_err(Failure::Fatal)?;
    crash_point("identity-persisted");
    remove_spent_token(&config.token_path, &stored.token_sha256).map_err(Failure::Fatal)?;
    crash_point("token-removed");
    // The redeem answer has no attachments; ask for them now rather than at
    // the first tick.
    let session = match api.refresh(&stored.runtime_credential) {
        Ok(refreshed) => session_from_refresh(refreshed, &relay_host_id).map_err(Failure::Fatal)?,
        Err(error) => {
            log::warn!("first refresh after redeem failed: {}", describe(&error));
            Session {
                workspace_id: std::mem::take(&mut redeemed.workspace_id),
                organization_id: std::mem::take(&mut redeemed.organization_id),
                relay_host_id,
                relay_token: std::mem::take(&mut redeemed.relay_token),
                relay_token_expires_at: redeemed.relay_token_expires_at,
                director_url: std::mem::take(&mut redeemed.director_url),
                access_mode: AccessMode::Private,
                attachments: Vec::new(),
                revocations: Vec::new(),
            }
        }
    };
    Ok((session, Zeroizing::new(stored.runtime_credential.clone())))
}

impl Bootstrapped {
    /// Refresh once, replacing the session on success.
    pub fn refresh(&self, api: &dyn Api) -> Result<(), CallError> {
        let refreshed = match api.refresh(&self.credential) {
            Err(CallError::Rejected) => {
                self.rejected.store(true, std::sync::atomic::Ordering::SeqCst);
                return Err(CallError::Rejected);
            }
            other => other?,
        };
        self.rejected.store(false, std::sync::atomic::Ordering::SeqCst);
        let relay_host_id = self.key.relay_host_id();
        let session = session_from_refresh(refreshed, &relay_host_id).map_err(CallError::Transient)?;
        let mut current = self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if session.workspace_id != current.workspace_id || session.organization_id != current.organization_id {
            return Err(CallError::Transient(anyhow!("the server answered for a different workspace")));
        }
        *current = session;
        Ok(())
    }

    /// The runtime credential, for calls made outside this module
    /// (`cloud_grants`).
    pub(crate) fn runtime_credential(&self) -> Zeroizing<String> {
        self.credential.clone()
    }

    /// Whether the server currently rejects the runtime credential.
    pub fn is_rejected(&self) -> bool {
        self.rejected.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Publish the pairing code the relay host made for an attachment
    /// (`POST /v1/cloud-workspace-bootstrap/attachments/:id/complete`, PRO-13).
    pub fn complete_attachment(&self, api: &HttpApi, attachment_id: &str, pairing_code: &str) -> Result<(), CallError> {
        if !attachment_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) || attachment_id.is_empty() || attachment_id.len() > 128 {
            return Err(CallError::Transient(anyhow!("invalid attachment id")));
        }
        let _: serde_json::Value = api.post(
            &format!("/v1/cloud-workspace-bootstrap/attachments/{attachment_id}/complete"),
            &self.credential,
            serde_json::json!({ "pairingCode": pairing_code }),
            None,
        )?;
        Ok(())
    }

    /// Tell the API what the runtime has been doing
    /// (`POST /v1/cloud-workspace-bootstrap/activity`, see `cloud_activity`).
    pub fn report_activity(&self, api: &HttpApi, report: &serde_json::Value) -> Result<(), CallError> {
        let _: serde_json::Value = api.post("/v1/cloud-workspace-bootstrap/activity", &self.credential, report.clone(), None)?;
        Ok(())
    }

    /// Record the memory baseline for the current session's runtime
    /// generation, once per boot and generation (`memory_baseline`).
    pub fn record_memory_baseline(&self) {
        use std::sync::atomic::Ordering;
        let token = self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).relay_token.clone();
        // Absent (a pre-PRO-11 grant) or unreadable is generation 0, as the
        // relay host reads it.
        let generation = crate::remote::host::token_identity(&token).map(|identity| identity.runtime_generation).unwrap_or(0);
        // The boot cannot change under a running process, so one record per
        // generation is enough.
        if self.baseline_generation.load(Ordering::Relaxed) == generation {
            return;
        }
        match crate::memory_baseline::record(&self.baseline_path, generation) {
            Ok(()) => self.baseline_generation.store(generation, Ordering::Relaxed),
            Err(error) => log::warn!("record the memory baseline at {}: {error:#}", self.baseline_path.display()),
        }
    }

    /// Keep the relay token fresh in the background until the process ends.
    pub fn spawn_refresh_loop(self: Arc<Self>, api: Arc<dyn Api + Send + Sync>) {
        let spawned = std::thread::Builder::new().name("cloud-refresh".into()).spawn(move || loop {
            std::thread::sleep(REFRESH_INTERVAL);
            match self.refresh(api.as_ref()) {
                // A rotated session may carry a new runtime generation.
                Ok(()) => self.record_memory_baseline(),
                // A rejection also sets `rejected`, which stops the relay host.
                Err(error) => log::warn!("refresh the cloud workspace session: {}", describe(&error)),
            }
        });
        if let Err(error) = spawned {
            log::error!("start the cloud workspace refresh loop: {error}");
        }
    }
}

pub fn describe(error: &CallError) -> String {
    match error {
        CallError::Rejected => "rejected".into(),
        CallError::Transient(error) => format!("{error:#}"),
    }
}

fn session_from_refresh(mut refreshed: Refreshed, relay_host_id: &str) -> Result<Session> {
    if refreshed.v != 1 {
        bail!("unsupported refresh version {}", refreshed.v);
    }
    validate_session(&refreshed.workspace_id, &refreshed.organization_id, &refreshed.relay_token, refreshed.relay_token_expires_at, &refreshed.director_url)?;
    if refreshed.attachments.len() > MAX_LIST || refreshed.revocations.len() > MAX_LIST {
        bail!("refresh listed too many attachments or revocations");
    }
    if refreshed.setup.is_some() {
        log::warn!("the server sent first-run setup, which this runtime does not apply yet");
    }
    Ok(Session {
        workspace_id: std::mem::take(&mut refreshed.workspace_id),
        organization_id: std::mem::take(&mut refreshed.organization_id),
        relay_host_id: relay_host_id.to_string(),
        relay_token: std::mem::take(&mut refreshed.relay_token),
        relay_token_expires_at: refreshed.relay_token_expires_at,
        director_url: std::mem::take(&mut refreshed.director_url),
        access_mode: refreshed.access_mode.unwrap_or(AccessMode::Private),
        attachments: std::mem::take(&mut refreshed.attachments),
        revocations: std::mem::take(&mut refreshed.revocations),
    })
}

fn validate_redeemed(redeemed: &Redeemed) -> Result<()> {
    if redeemed.v != 1 {
        bail!("unsupported redeem version {}", redeemed.v);
    }
    if !is_base64url_32(&redeemed.runtime_credential) {
        bail!("the server returned a malformed runtime credential");
    }
    validate_session(&redeemed.workspace_id, &redeemed.organization_id, &redeemed.relay_token, redeemed.relay_token_expires_at, &redeemed.director_url)
}

fn validate_session(workspace_id: &str, organization_id: &str, relay_token: &str, expires_at: u64, director_url: &str) -> Result<()> {
    if !opaque_id(workspace_id) || !opaque_id(organization_id) {
        bail!("the server returned a malformed workspace or organization id");
    }
    if relay_token.is_empty() || relay_token.len() > 16 * 1024 || expires_at == 0 {
        bail!("the server returned a malformed relay token");
    }
    if !canonical_origin(director_url) {
        bail!("the server returned a relay director that is not an https origin");
    }
    Ok(())
}

fn opaque_id(value: &str) -> bool {
    (1..=256).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

fn is_base64url_32(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An origin exactly as `URL.origin` prints it: https, or http on loopback.
fn canonical_origin(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    scheme_ok && url.origin().ascii_serialization() == value
}

fn read_token(path: &Path) -> Result<Zeroizing<String>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => Zeroizing::new(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Rejected("cloud_workspace_bootstrap_token_missing").into());
        }
        Err(error) => return Err(anyhow::Error::new(error).context("read the bootstrap token")),
    };
    let token = raw.trim();
    if !is_base64url_32(token) {
        return Err(Rejected("cloud_workspace_bootstrap_token_invalid").into());
    }
    Ok(Zeroizing::new(token.to_string()))
}

fn token_sha256(token: &str) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

/// The hash of the token file's token, if it holds a well-formed one.
fn token_file_sha256(path: &Path) -> Option<String> {
    let raw = Zeroizing::new(fs::read_to_string(path).ok()?);
    let token = raw.trim();
    is_base64url_32(token).then(|| token_sha256(token))
}

/// A token is on disk and it is not the one already spent.
fn token_is_new(path: &Path, spent_sha256: &str) -> bool {
    token_file_sha256(path).is_some_and(|sha| sha != spent_sha256)
}

/// Delete the token file only if it still holds the token that was spent: a
/// token provisioned since then is the way back in once this credential dies.
fn remove_spent_token(path: &Path, spent_sha256: &str) -> Result<()> {
    if token_file_sha256(path).as_deref() != Some(spent_sha256) {
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => sync_parent(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::Error::new(error).context("delete the spent bootstrap token")),
    }
}

/// An exclusive lock on the state directory. Two runtimes on one directory
/// could each generate a host key and leave the one on disk disagreeing with
/// the one the server bound the token to.
struct StateLock {
    #[cfg(unix)]
    _file: fs::File,
}

impl StateLock {
    fn acquire(dir: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let path = dir.join("lock");
            let file = fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path).with_context(|| format!("open {}", path.display()))?;
            // SAFETY: flock on a descriptor this function owns.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                bail!("another terminalx-serve is using {}", dir.display());
            }
            Ok(Self { _file: file })
        }
        #[cfg(not(unix))]
        {
            let _ = dir;
            Ok(Self {})
        }
    }
}

fn load_or_create_host_key(dir: &Path) -> Result<HostKey> {
    let path = dir.join(HOST_KEY_FILE);
    match fs::read(&path) {
        Ok(bytes) => {
            // Never regenerated over a bad file: a new key is a new relay
            // host id, and the server has the old one on record.
            let bytes = Zeroizing::new(bytes);
            let file: HostKeyFile = serde_json::from_slice(&bytes).context("parse the relay host key")?;
            let file = Zeroizing::new(file);
            let decoded = general_purpose::URL_SAFE_NO_PAD.decode(&file.secret).ok().map(Zeroizing::new);
            let secret = decoded.as_deref().and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok());
            match (file.v, secret) {
                (1, Some(mut secret)) => {
                    let key = HostKey::from_secret(secret);
                    secret.zeroize();
                    Ok(key)
                }
                _ => bail!("the relay host key file is malformed"),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let key = HostKey::generate();
            let file = Zeroizing::new(HostKeyFile { v: 1, secret: general_purpose::URL_SAFE_NO_PAD.encode(key.secret) });
            write_durable(&path, &Zeroizing::new(serde_json::to_vec(&*file)?))?;
            Ok(key)
        }
        Err(error) => Err(anyhow::Error::new(error).context("read the relay host key")),
    }
}

fn read_identity(dir: &Path) -> Result<Option<StoredIdentity>> {
    match fs::read(dir.join(STATE_FILE)) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            let stored: StoredIdentity = serde_json::from_slice(&bytes).context("parse the stored runtime identity")?;
            if stored.v != 1 || !is_base64url_32(&stored.runtime_credential) {
                bail!("the stored runtime identity is malformed");
            }
            Ok(Some(stored))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(anyhow::Error::new(error).context("read the stored runtime identity")),
    }
}

fn ensure_private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).with_context(|| format!("restrict {}", dir.display()))?;
    }
    Ok(())
}

/// Replace `path` so that after a crash at any instant it holds either the
/// old bytes or the new ones, and once this returns the new ones survive a
/// power cut: temp file, fsync, rename, fsync the directory.
pub(crate) fn write_durable(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    crash_point("temp-written");
    fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
    sync_parent(path)
}

fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        // `bootstrap-token` alone has the empty path as its parent.
        let parent = if parent.as_os_str().is_empty() { Path::new(".") } else { parent };
        fs::File::open(parent).and_then(|dir| dir.sync_all()).with_context(|| format!("sync {}", parent.display()))?;
    }
    Ok(())
}

/// Debug builds only: `TERMINALX_SERVE_TEST_CRASH_AT=<step>` SIGKILLs the
/// process at that step, so the tests can prove a `kill -9` there is safe.
/// `temp-written` fires inside every durable write; `<n>:temp-written` fires
/// at the n-th one.
#[cfg(all(debug_assertions, unix))]
fn crash_point(step: &str) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEEN: AtomicUsize = AtomicUsize::new(0);
    let Ok(target) = std::env::var("TERMINALX_SERVE_TEST_CRASH_AT") else { return };
    let hit = match target.split_once(':') {
        Some((nth, name)) if name == step => nth.parse::<usize>().ok() == Some(SEEN.fetch_add(1, Ordering::SeqCst) + 1),
        None => target == step,
        _ => false,
    };
    if hit {
        // SAFETY: plain libc calls on our own pid.
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
    }
}

#[cfg(not(all(debug_assertions, unix)))]
fn crash_point(_step: &str) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const WORKSPACE: &str = "ws_1";

    /// The server's semantics: a token redeems once, except that the same
    /// host key may replay it; each redeem rotates the credential.
    #[derive(Default)]
    struct FakeServer {
        tokens: RefCell<HashMap<String, Option<String>>>,
        credential: RefCell<Option<String>>,
        redeems: RefCell<Vec<String>>,
        refreshes: RefCell<usize>,
        no_replay: bool,
        down: RefCell<bool>,
    }

    impl FakeServer {
        fn with_token(token: &str) -> Self {
            let server = Self::default();
            server.tokens.borrow_mut().insert(token.into(), None);
            server
        }
    }

    fn session_fields() -> (String, String, String, u64, String) {
        (WORKSPACE.into(), "org_1".into(), "relay.token.jwt".into(), 1, "https://relay.example".into())
    }

    impl Api for FakeServer {
        fn redeem(&self, token: &str, key: &HostKey) -> Result<Redeemed, CallError> {
            if *self.down.borrow() {
                return Err(CallError::Transient(anyhow!("down")));
            }
            let host = key.relay_host_id();
            let mut tokens = self.tokens.borrow_mut();
            match tokens.get(token) {
                Some(None) => {}
                Some(Some(bound)) if *bound == host && !self.no_replay => {}
                _ => return Err(CallError::Rejected),
            }
            tokens.insert(token.into(), Some(host.clone()));
            self.redeems.borrow_mut().push(host);
            let credential = random_credential();
            *self.credential.borrow_mut() = Some(credential.clone());
            let (workspace_id, organization_id, relay_token, relay_token_expires_at, director_url) = session_fields();
            Ok(Redeemed { v: 1, workspace_id, organization_id, relay_token, relay_token_expires_at, director_url, runtime_credential: credential })
        }

        fn refresh(&self, credential: &str) -> Result<Refreshed, CallError> {
            if *self.down.borrow() {
                return Err(CallError::Transient(anyhow!("down")));
            }
            if self.credential.borrow().as_deref() != Some(credential) {
                return Err(CallError::Rejected);
            }
            *self.refreshes.borrow_mut() += 1;
            let (workspace_id, organization_id, relay_token, relay_token_expires_at, director_url) = session_fields();
            Ok(Refreshed {
                v: 1,
                workspace_id,
                organization_id,
                relay_token,
                relay_token_expires_at,
                director_url,
                attachments: vec![],
                revocations: vec![],
                setup: None,
                access_mode: Some(AccessMode::Organization),
            })
        }
    }

    fn random_credential() -> String {
        general_purpose::URL_SAFE_NO_PAD.encode(StaticSecret::random_from_rng(OsRng).to_bytes())
    }

    /// No waiting: the first failure is final, so no test can spin.
    fn quick() -> Policy {
        Policy { backoff_start: Duration::ZERO, backoff_cap: Duration::ZERO, rejected_window: Duration::ZERO, give_up_after: Some(Duration::ZERO) }
    }

    fn setup(token: &str) -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("bootstrap-token");
        fs::write(&token_path, format!("{token}\n")).unwrap();
        let config = Config { origin: "https://api.example".into(), token_path, state_dir: dir.path().join("state") };
        (dir, config)
    }

    #[test]
    fn redeems_once_then_refreshes_with_the_stored_credential() {
        let token = random_credential();
        let server = FakeServer::with_token(&token);
        let (_dir, config) = setup(&token);
        let first = establish(&config, &server, &quick()).unwrap();
        assert!(!config.token_path.exists(), "the spent token is deleted");
        assert_eq!(first.session.lock().unwrap().access_mode, AccessMode::Organization);
        let first_host = first.key.relay_host_id();
        drop(first);
        let second = establish(&config, &server, &quick()).unwrap();
        assert_eq!(server.redeems.borrow().len(), 1, "a restart refreshes instead of redeeming");
        assert_eq!(first_host, second.key.relay_host_id());
        assert_eq!(*server.refreshes.borrow(), 2);
    }

    #[test]
    fn a_transient_failure_is_retried_until_it_clears() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Flaky(FakeServer, AtomicUsize);
        impl Api for Flaky {
            fn redeem(&self, token: &str, key: &HostKey) -> Result<Redeemed, CallError> {
                if self.1.fetch_add(1, Ordering::SeqCst) < 3 {
                    return Err(CallError::Transient(anyhow!("down")));
                }
                self.0.redeem(token, key)
            }
            fn refresh(&self, credential: &str) -> Result<Refreshed, CallError> {
                self.0.refresh(credential)
            }
        }
        let token = random_credential();
        let server = Flaky(FakeServer::with_token(&token), AtomicUsize::new(0));
        let (_dir, config) = setup(&token);
        let policy = Policy { backoff_start: Duration::from_millis(1), backoff_cap: Duration::from_millis(5), rejected_window: Duration::ZERO, give_up_after: Some(Duration::from_secs(5)) };
        establish(&config, &server, &policy).unwrap();
        assert_eq!(server.1.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn a_transient_failure_keeps_the_token() {
        let token = random_credential();
        let server = FakeServer::with_token(&token);
        *server.down.borrow_mut() = true;
        let (_dir, config) = setup(&token);
        assert!(establish(&config, &server, &quick()).is_err());
        assert!(config.token_path.exists());
        *server.down.borrow_mut() = false;
        establish(&config, &server, &quick()).unwrap();
        assert!(!config.token_path.exists());
    }

    #[test]
    fn a_rejected_token_is_kept_and_reported_as_permanent() {
        let (_dir, config) = setup(&random_credential());
        let error = establish(&config, &FakeServer::default(), &quick()).err().unwrap();
        assert!(error.downcast_ref::<Rejected>().is_some());
        assert!(config.token_path.exists());
    }

    #[test]
    fn a_missing_token_without_identity_is_permanent() {
        let (_dir, config) = setup("x");
        fs::remove_file(&config.token_path).unwrap();
        let error = establish(&config, &FakeServer::default(), &quick()).err().unwrap();
        assert_eq!(error.downcast_ref::<Rejected>().unwrap().0, "cloud_workspace_bootstrap_token_missing");
    }

    #[test]
    fn a_revoked_credential_falls_back_to_a_newly_provisioned_token() {
        let token = random_credential();
        let server = FakeServer::with_token(&token);
        let (_dir, config) = setup(&token);
        let first_host = establish(&config, &server, &quick()).unwrap().key.relay_host_id();
        // The worker re-issues on resume: a new token, the old credential dead.
        let fresh = random_credential();
        server.tokens.borrow_mut().insert(fresh.clone(), None);
        *server.credential.borrow_mut() = None;
        fs::write(&config.token_path, &fresh).unwrap();
        let second = establish(&config, &server, &quick()).unwrap();
        assert_eq!(first_host, second.key.relay_host_id(), "same host identity after re-issue");
        assert_eq!(server.redeems.borrow().len(), 2);
        assert!(!config.token_path.exists());
        drop(second);
        // And without a new token a dead credential is permanent.
        *server.credential.borrow_mut() = None;
        let error = establish(&config, &server, &quick()).err().unwrap();
        assert!(error.downcast_ref::<Rejected>().is_some());
    }

    #[test]
    fn a_newly_provisioned_token_survives_a_successful_refresh() {
        let token = random_credential();
        let server = FakeServer::with_token(&token);
        let (_dir, config) = setup(&token);
        drop(establish(&config, &server, &quick()).unwrap());
        let fresh = random_credential();
        fs::write(&config.token_path, &fresh).unwrap();
        drop(establish(&config, &server, &quick()).unwrap());
        assert_eq!(fs::read_to_string(&config.token_path).unwrap(), fresh, "only the spent token is deleted");
        assert_eq!(server.redeems.borrow().len(), 1);
    }

    #[test]
    fn a_delivered_token_takes_precedence_over_a_live_credential() {
        let token = random_credential();
        let server = FakeServer::with_token(&token);
        let (_dir, config) = setup(&token);
        let first_host = establish(&config, &server, &quick()).unwrap().key.relay_host_id();
        let old_credential = server.credential.borrow().clone().unwrap();
        // A fenced restart delivered a token; the stored credential would
        // still refresh, but the delivered token wins.
        let fresh = random_credential();
        server.tokens.borrow_mut().insert(fresh.clone(), None);
        fs::write(&config.token_path, &fresh).unwrap();
        let second = establish(&config, &server, &quick()).unwrap();
        assert_eq!(server.redeems.borrow().len(), 2);
        assert_eq!(first_host, second.key.relay_host_id(), "same host identity after the fenced restart");
        assert!(!config.token_path.exists(), "the delivered token is spent");
        let stored = read_identity(&config.state_dir).unwrap().unwrap();
        assert_ne!(stored.runtime_credential, old_credential, "the stored credential is replaced");
        assert_eq!(Some(&stored.runtime_credential), server.credential.borrow().as_ref());
        assert_eq!(stored.token_sha256, token_sha256(&fresh));
        drop(second);
        // The next restart refreshes with the new credential.
        establish(&config, &server, &quick()).unwrap();
        assert_eq!(server.redeems.borrow().len(), 2);
    }

    #[test]
    fn a_delivered_token_the_server_cannot_redeem_now_falls_back_to_the_stored_credential() {
        struct RedeemDown(FakeServer, RefCell<bool>);
        impl Api for RedeemDown {
            fn redeem(&self, token: &str, key: &HostKey) -> Result<Redeemed, CallError> {
                if *self.1.borrow() {
                    return Err(CallError::Transient(anyhow!("HTTP 503")));
                }
                self.0.redeem(token, key)
            }
            fn refresh(&self, credential: &str) -> Result<Refreshed, CallError> {
                self.0.refresh(credential)
            }
        }
        let token = random_credential();
        let server = RedeemDown(FakeServer::with_token(&token), RefCell::new(false));
        let (_dir, config) = setup(&token);
        drop(establish(&config, &server, &quick()).unwrap());
        let fresh = random_credential();
        server.0.tokens.borrow_mut().insert(fresh.clone(), None);
        fs::write(&config.token_path, &fresh).unwrap();
        *server.1.borrow_mut() = true;
        drop(establish(&config, &server, &quick()).unwrap());
        assert!(config.token_path.exists(), "the token is kept for a later start");
        // Once the stored credential is revoked too, the redeem's failure is
        // the one reported, and it is not a permanent rejection.
        *server.0.credential.borrow_mut() = None;
        let error = establish(&config, &server, &quick()).err().unwrap();
        assert!(error.downcast_ref::<Rejected>().is_none(), "{error:#}");
        *server.1.borrow_mut() = false;
        drop(establish(&config, &server, &quick()).unwrap());
        assert!(!config.token_path.exists());
    }

    #[test]
    fn a_delivered_token_for_another_workspace_leaves_the_identity_alone() {
        struct Elsewhere(FakeServer, RefCell<bool>);
        impl Api for Elsewhere {
            fn redeem(&self, token: &str, key: &HostKey) -> Result<Redeemed, CallError> {
                // Another workspace's redeem leaves this one's credential alone.
                let live = self.0.credential.borrow().clone();
                let mut redeemed = self.0.redeem(token, key)?;
                if *self.1.borrow() {
                    redeemed.workspace_id = "ws_other".into();
                    *self.0.credential.borrow_mut() = live;
                }
                Ok(redeemed)
            }
            fn refresh(&self, credential: &str) -> Result<Refreshed, CallError> {
                self.0.refresh(credential)
            }
        }
        let token = random_credential();
        let server = Elsewhere(FakeServer::with_token(&token), RefCell::new(false));
        let (_dir, config) = setup(&token);
        drop(establish(&config, &server, &quick()).unwrap());
        let before = read_identity(&config.state_dir).unwrap().unwrap().runtime_credential.clone();
        let fresh = random_credential();
        server.0.tokens.borrow_mut().insert(fresh.clone(), None);
        fs::write(&config.token_path, &fresh).unwrap();
        *server.1.borrow_mut() = true;
        // The stored credential still works, so the runtime still starts.
        let running = establish(&config, &server, &quick()).unwrap();
        assert_eq!(running.session.lock().unwrap().workspace_id, WORKSPACE);
        assert_eq!(read_identity(&config.state_dir).unwrap().unwrap().runtime_credential, before, "the stored identity is untouched");
        assert!(config.token_path.exists());
    }

    #[test]
    fn the_baseline_sits_next_to_the_token() {
        let (_dir, config) = setup("x");
        assert_eq!(config.baseline_path(), config.token_path.parent().unwrap().join("memory-baseline.json"));
    }

    #[test]
    fn a_rejection_is_retried_within_the_window() {
        let token = random_credential();
        let server = FakeServer::default();
        let (_dir, config) = setup(&token);
        let policy = Policy {
            backoff_start: Duration::from_millis(10),
            backoff_cap: Duration::from_millis(20),
            rejected_window: Duration::from_millis(200),
            give_up_after: Some(Duration::from_secs(5)),
        };
        let started = Instant::now();
        let error = establish(&config, &server, &policy).err().unwrap();
        assert!(error.downcast_ref::<Rejected>().is_some());
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[test]
    fn one_runtime_per_state_directory() {
        let token = random_credential();
        let server = FakeServer::with_token(&token);
        let (_dir, config) = setup(&token);
        let running = establish(&config, &server, &quick()).unwrap();
        let error = establish(&config, &server, &quick()).err().unwrap();
        assert!(format!("{error:#}").contains("another terminalx-serve"), "{error:#}");
        drop(running);
        establish(&config, &server, &quick()).unwrap();
    }

    #[test]
    fn a_bare_token_file_name_syncs_the_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let token = random_credential();
        let path = dir.path().join("bootstrap-token");
        fs::write(&path, &token).unwrap();
        // The parent of a bare file name is the empty path.
        assert_eq!(Path::new("bootstrap-token").parent(), Some(Path::new("")));
        sync_parent(Path::new("bootstrap-token")).unwrap();
        remove_spent_token(&path, &token_sha256(&token)).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn a_replayed_redeem_for_the_same_host_recovers_a_lost_response() {
        let token = random_credential();
        let server = FakeServer::with_token(&token);
        let (_dir, config) = setup(&token);
        // The server committed a redeem whose answer never reached the disk.
        ensure_private_dir(&config.state_dir).unwrap();
        let key = load_or_create_host_key(&config.state_dir).unwrap();
        server.redeem(&token, &key).map_err(|_| ()).unwrap();
        establish(&config, &server, &quick()).unwrap();
        assert_eq!(*server.redeems.borrow(), vec![key.relay_host_id(); 2]);
    }

    #[test]
    fn a_different_host_key_cannot_replay() {
        let token = random_credential();
        let server = FakeServer::with_token(&token);
        server.redeem(&token, &HostKey::generate()).map_err(|_| ()).unwrap();
        let (_dir, config) = setup(&token);
        let error = establish(&config, &server, &quick()).err().unwrap();
        assert!(error.downcast_ref::<Rejected>().is_some());
        assert!(config.token_path.exists());
    }

    #[test]
    fn the_host_key_is_stable_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_host_key(dir.path()).unwrap();
        let second = load_or_create_host_key(dir.path()).unwrap();
        assert_eq!(first.public_key_b64(), second.public_key_b64());
        assert_eq!(first.public_key_b64().len(), 44);
        assert_eq!(first.relay_host_id().len(), 16);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(HOST_KEY_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::write(dir.path().join(HOST_KEY_FILE), b"{").unwrap();
        assert!(load_or_create_host_key(dir.path()).is_err(), "a damaged key is never silently replaced");
    }

    #[test]
    fn relay_host_id_matches_the_server_derivation() {
        // deriveRelayHostId(publicKeyB64) = base64url(sha256(key))[0..16].
        let key = HostKey::from_secret([7u8; 32]);
        let expected = general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(key.public))[..16].to_string();
        assert_eq!(key.relay_host_id(), expected);
        assert!(key.public_key_b64().ends_with('='));
    }

    #[test]
    fn strict_decoding_matches_the_contract() {
        let redeem = r#"{"v":1,"workspaceId":"w","organizationId":"o","relayToken":"t","relayTokenExpiresAt":5,"directorUrl":"https://d.example","runtimeCredential":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
        validate_redeemed(&serde_json::from_str::<Redeemed>(redeem).unwrap()).unwrap();
        assert!(serde_json::from_str::<Redeemed>(&redeem.replace("\"v\":1", "\"v\":1,\"extra\":1")).is_err());
        let insecure = redeem.replace("https://d.example", "http://d.example");
        assert!(validate_redeemed(&serde_json::from_str::<Redeemed>(&insecure).unwrap()).is_err());
        let refresh = r#"{"v":1,"workspaceId":"w","organizationId":"o","relayToken":"t","relayTokenExpiresAt":5,"directorUrl":"http://127.0.0.1:9","attachments":[],"revocations":[]}"#;
        let session = session_from_refresh(serde_json::from_str(refresh).unwrap(), "h").unwrap();
        assert_eq!(session.access_mode, AccessMode::Private, "absent access mode is the closed default");
    }

    #[test]
    fn origins_must_be_canonical() {
        assert!(canonical_origin("https://api.terminalx.dev"));
        assert!(canonical_origin("http://127.0.0.1:8787"));
        assert!(!canonical_origin("http://api.terminalx.dev"));
        assert!(!canonical_origin("https://api.terminalx.dev/"));
        assert!(!canonical_origin("https://api.terminalx.dev/v1"));
    }
}
