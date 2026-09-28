//! Cloud agent credential grants (PRO-17): how a cloud workspace runtime gets
//! the Claude Code, Codex and Cursor credentials its agents run with, without
//! a refresh token ever entering the VM.
//!
//! The API (terminalx-saas `apps/api`) is the only refresher. The runtime
//! enrolls an X25519 public key of its own
//! (`POST /v1/cloud-workspace-bootstrap/agent-grant-key`), then fetches
//! short-lived grants sealed to it (`POST .../agent-grants`) and fetches again
//! at the `refreshAfter` the server names, and before any grant expires.
//! Both calls authenticate with the runtime credential from
//! `cloud_bootstrap`.
//!
//! A sealed grant is `X25519-HKDF-SHA256/A256GCM-KW/A256GCM`: an ephemeral
//! X25519 agreement with the runtime's key derives a key-encryption key, which
//! unwraps a per-grant content key, which opens the plaintext. Every header
//! field is bound as AAD, and the runtime refuses a header that is not for its
//! own workspace, runtime generation and key, one that has expired, and one
//! whose epoch is lower than one it has already seen for that credential.
//! `fixtures/cloud_agent_grant_vector.json` is shared with the server.
//!
//! What lives where:
//!
//! - **The grant key** is held in memory and written only to a tmpfs
//!   directory ([`GRANT_DIR_ENV`], else `/dev/shm/terminalx-<uid>`, else
//!   `$XDG_RUNTIME_DIR/terminalx`, each with a `ws-<hash of the workspace
//!   id>` directory inside, so two runtimes under one account never share
//!   one), so a crash-restart within one runtime
//!   generation enrolls the same key again. Without a tmpfs directory it is
//!   memory-only: a restart then enrolls a new key, which the server refuses
//!   (`cloud_agent_grant_key_conflict`) until it rotates the generation, and
//!   the runtime serves without grants until then.
//! - **Grants** are held in memory only and wiped when replaced or dropped.
//!   Claude Code and Cursor take theirs from the environment of the agent
//!   process ([`agent_env`]).
//! - **Codex** reads its credential from `$CODEX_HOME/auth.json`. `CODEX_HOME`
//!   stays the managed home `harness::codex::home` builds in the data
//!   directory, because that is where the rollouts the transcript view and
//!   `codex resume` depend on live, and they must survive a restart. Only
//!   `auth.json` moves: in a cloud workspace the managed home's `auth.json` is
//!   a symlink to `<tmpfs>/agent-homes/codex/auth.json`, written 0600 from the
//!   grant, instead of a link to the reader's `~/.codex/auth.json`. The file
//!   carries an empty `refresh_token`, so Codex never tries to refresh (and so
//!   never writes back through the link). Without tmpfs no Codex auth file is
//!   written: an API key falls back to `CODEX_API_KEY`, ChatGPT tokens are
//!   skipped.
//!
//! Nothing here writes to the data directory, `~/.codex` or `~/.claude`.
//!
//! Time: a grant is judged by its own lifetime (`expiresAt - issuedAt`, less
//! a skew allowance) counted from when it arrived on this machine's
//! monotonic clock, and the next fetch by `refreshAfter - issuedAt`, so a VM
//! clock that is off neither refuses grants nor hammers the server. Only
//! when the server sent no grant at all is `refreshAfter` compared with the
//! wall clock (bounded, with a 30 s fallback).
//!
//! When the runtime credential is rejected (401, or `is_rejected()` from the
//! bootstrap refresh loop) or the server holds another key, every grant is
//! dropped at once, the Codex file removed and the enrollment forgotten.
//!
//! Known limitations, to verify against a real `claude`:
//!
//! - Variables are set in the PTY's environment before the login shell runs,
//!   so a profile that exports `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`
//!   or `CURSOR_API_KEY` itself overrides the grant. Unset names are removed
//!   after the profile (`env -u`), so those cannot shadow it.
//! - Claude Code may ask once whether to use an `ANTHROPIC_API_KEY` it finds
//!   in the environment, which would take the first prompt; and an
//!   `apiKeyHelper` in settings outranks `CLAUDE_CODE_OAUTH_TOKEN`, so a
//!   helper configured on the VM wins over an OAuth grant.
//!
//! A credential that is revoked, disconnected or unavailable, or that the
//! server stops sending a grant for, stops being injected into new sessions
//! and its Codex file is removed; running sessions are never killed. A rotated
//! credential (new version or epoch) is injected into new sessions at once;
//! sessions started with the old one keep it and are counted in
//! [`status_json`] as needing a restart. The count follows PTY tabs exactly
//! and ACP (Cursor) tabs until they are relaunched.

use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use hkdf::Hkdf;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

pub const ALG: &str = "X25519-HKDF-SHA256/A256GCM-KW/A256GCM";
const AAD_LABEL: &str = "terminalx-cloud-agent-grant-v1";
const KEK_INFO: &[u8] = b"terminalx-cloud-agent-grant-v1/kek";

/// Overrides where the grant key and Codex auth file live (a tmpfs mount).
pub const GRANT_DIR_ENV: &str = "TERMINALX_CLOUD_GRANT_DIR";
const KEY_FILE: &str = "grant-key.json";
const AGENT_HOMES: &str = "agent-homes";
const CODEX_AUTH_FILE: &str = "auth.json";

const ENROLL_PATH: &str = "/v1/cloud-workspace-bootstrap/agent-grant-key";
const FETCH_PATH: &str = "/v1/cloud-workspace-bootstrap/agent-grants";
const KEY_CONFLICT: &str = "cloud_agent_grant_key_conflict";
const KEY_REQUIRED: &str = "cloud_agent_grant_key_required";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Fetch again this long before a grant expires.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);
/// Taken off every grant's lifetime: the request's transit, and the server
/// stamping `issuedAt` a moment before the answer left.
const SKEW_ALLOWANCE: Duration = Duration::from_secs(30);
/// No grant is trusted for longer than this, whatever it says.
const MAX_GRANT_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
/// When the server sent no grant (so there is no server time to measure
/// `refreshAfter` from) and this VM's clock says it has already passed.
const FALLBACK_REFRESH: Duration = Duration::from_secs(30);
/// How long a Codex launch waits for the first sync.
const FIRST_SYNC_WAIT: Duration = Duration::from_secs(5);
const MIN_REFRESH: Duration = Duration::from_secs(5);
const MAX_REFRESH: Duration = Duration::from_secs(15 * 60);
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(5 * 60);
/// How often a paused loop looks again while the runtime credential is
/// rejected.
const REJECTED_PAUSE: Duration = Duration::from_secs(30);
const MAX_GRANTS: usize = 64;

const CLAUDE_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
const CLAUDE_AUTH_TOKEN_ENV: &str = "ANTHROPIC_AUTH_TOKEN";
const CLAUDE_OAUTH_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";
const CODEX_API_KEY_ENV: &str = "CODEX_API_KEY";
const CURSOR_API_KEY_ENV: &str = "CURSOR_API_KEY";

// ------------------------------------------------------------------ the wire

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Provider {
    Claude,
    Codex,
    Cursor,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "cursor" => Some(Self::Cursor),
            _ => None,
        }
    }
}

/// Everything the AAD binds. Counters are milliseconds or plain integers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantHeader {
    pub workspace_id: String,
    pub provider: String,
    pub credential_id: String,
    pub key_thumbprint: String,
    pub epoch: u64,
    pub runtime_generation: u64,
    pub grant_id: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// A grant as the server sends it; the byte fields are base64url, no padding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedGrant {
    pub v: u8,
    pub alg: String,
    pub header: GrantHeader,
    pub ephemeral_public_key: String,
    pub wrap_iv: String,
    pub wrapped_key: String,
    pub iv: String,
    pub ciphertext: String,
    pub tag: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrolled {
    pub v: u8,
    pub key_thumbprint: String,
    pub runtime_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialEntry {
    pub provider: String,
    pub credential_id: String,
    pub state: String,
    pub epoch: u64,
    pub version: u64,
    #[serde(default)]
    pub rotation: Option<String>,
    /// Why a credential is not connected (`shared-use-policy`,
    /// `token-expired`), when the server says.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub v: u8,
    pub workspace_id: String,
    pub runtime_generation: u64,
    pub key_thumbprint: String,
    pub refresh_after: u64,
    /// Parsed one by one, so one malformed grant does not cost the others.
    pub grants: Vec<Value>,
    pub credentials: Vec<Value>,
}

const CONNECTED: &str = "connected";

/// Why a grant call failed.
#[derive(Debug)]
pub enum GrantCallError {
    /// 401: the runtime credential is invalid or fenced.
    Rejected,
    /// 409 `cloud_agent_grant_key_conflict`: another key is enrolled for this
    /// runtime generation.
    KeyConflict,
    /// 409 `cloud_agent_grant_key_required`: no key (or another key) is
    /// enrolled for the current generation.
    KeyRequired,
    Transient(anyhow::Error),
}

impl std::fmt::Display for GrantCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected => f.write_str("the runtime credential was rejected"),
            Self::KeyConflict => f.write_str("another grant key is enrolled for this runtime generation"),
            Self::KeyRequired => f.write_str("the server has no grant key enrolled for this runtime"),
            Self::Transient(error) => write!(f, "{error:#}"),
        }
    }
}

/// The two calls the runtime makes; a trait so tests can stand in for the
/// server.
pub trait GrantApi {
    fn enroll(&self, grant_public_key_b64: &str) -> Result<Enrolled, GrantCallError>;
    fn fetch(&self, key_thumbprint: &str) -> Result<Fetched, GrantCallError>;
}

/// The API over HTTP, authenticated with the bootstrap session's current
/// runtime credential, read afresh for every call.
pub struct HttpGrantApi {
    origin: String,
    agent: ureq::Agent,
    cloud: Arc<crate::cloud_bootstrap::Bootstrapped>,
}

impl HttpGrantApi {
    pub fn new(origin: &str, cloud: Arc<crate::cloud_bootstrap::Bootstrapped>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(REQUEST_TIMEOUT)
            .redirects(0)
            .user_agent(&format!("terminalx-serve/{}", crate::cloud_bootstrap::VERSION))
            .build();
        Self { origin: origin.to_string(), agent, cloud }
    }

    fn post<T: serde::de::DeserializeOwned>(&self, path: &str, body: Value) -> Result<T, GrantCallError> {
        #[derive(Deserialize)]
        struct ErrorBody {
            error: String,
        }
        let credential = self.cloud.runtime_credential();
        let bearer = Zeroizing::new(format!("Bearer {}", credential.as_str()));
        let request = self
            .agent
            .post(&format!("{}{path}", self.origin))
            .set("authorization", &bearer)
            .set("content-type", "application/json")
            .set(crate::cloud_bootstrap::VERSION_HEADER, crate::cloud_bootstrap::VERSION);
        match request.send_json(body) {
            Ok(response) => response.into_json::<T>().map_err(|error| GrantCallError::Transient(anyhow!("{path}: unreadable response: {error}"))),
            Err(ureq::Error::Status(401, _)) => Err(GrantCallError::Rejected),
            Err(ureq::Error::Status(409, response)) => match response.into_json::<ErrorBody>().map(|body| body.error) {
                Ok(code) if code == KEY_CONFLICT => Err(GrantCallError::KeyConflict),
                Ok(code) if code == KEY_REQUIRED => Err(GrantCallError::KeyRequired),
                _ => Err(GrantCallError::Transient(anyhow!("{path}: HTTP 409"))),
            },
            Err(ureq::Error::Status(status, _)) => Err(GrantCallError::Transient(anyhow!("{path}: HTTP {status}"))),
            Err(ureq::Error::Transport(error)) => Err(GrantCallError::Transient(anyhow!("{path}: {error}"))),
        }
    }
}

impl GrantApi for HttpGrantApi {
    fn enroll(&self, grant_public_key_b64: &str) -> Result<Enrolled, GrantCallError> {
        self.post(ENROLL_PATH, json!({ "v": 1, "grantPublicKeyB64": grant_public_key_b64 }))
    }

    fn fetch(&self, key_thumbprint: &str) -> Result<Fetched, GrantCallError> {
        self.post(FETCH_PATH, json!({ "v": 1, "keyThumbprint": key_thumbprint }))
    }
}

// ---------------------------------------------------------------- the crypto

/// base64url-nopad SHA-256 of the raw public key, as the server derives it.
pub fn thumbprint(public: &[u8; 32]) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(public))
}

/// The additional data every AEAD operation is bound to.
pub fn aad(header: &GrantHeader) -> String {
    [
        AAD_LABEL,
        &header.workspace_id,
        &header.provider,
        &header.credential_id,
        &header.key_thumbprint,
        &header.epoch.to_string(),
        &header.runtime_generation.to_string(),
        &header.grant_id,
        &header.issued_at.to_string(),
        &header.expires_at.to_string(),
    ]
    .join("\n")
}

fn derive_kek(shared: &[u8; 32], ephemeral_public: &[u8; 32], recipient_public: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(ephemeral_public);
    salt[32..].copy_from_slice(recipient_public);
    let mut kek = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&salt), shared).expand(KEK_INFO, &mut kek[..]).expect("32 bytes is a valid HKDF-SHA256 length");
    kek
}

fn decode(value: &str, what: &str) -> Result<Vec<u8>> {
    general_purpose::URL_SAFE_NO_PAD.decode(value).map_err(|_| anyhow!("the grant's {what} is not base64url"))
}

fn decode_fixed<const N: usize>(value: &str, what: &str) -> Result<[u8; N]> {
    <[u8; N]>::try_from(decode(value, what)?.as_slice()).map_err(|_| anyhow!("the grant's {what} is not {N} bytes"))
}

/// Open a sealed grant with the recipient's static secret.
pub fn open(secret: &StaticSecret, sealed: &SealedGrant) -> Result<Zeroizing<Vec<u8>>> {
    if sealed.v != 1 || sealed.alg != ALG {
        bail!("unsupported grant format");
    }
    let header = &sealed.header;
    // A newline inside a field would let two headers share one AAD.
    if [&header.workspace_id, &header.provider, &header.credential_id, &header.key_thumbprint, &header.grant_id].iter().any(|field| field.contains('\n')) {
        bail!("the grant header has a newline in a field");
    }
    let ephemeral: [u8; 32] = decode_fixed(&sealed.ephemeral_public_key, "ephemeral public key")?;
    let wrap_iv: [u8; 12] = decode_fixed(&sealed.wrap_iv, "wrap iv")?;
    let wrapped: [u8; 48] = decode_fixed(&sealed.wrapped_key, "wrapped key")?;
    let iv: [u8; 12] = decode_fixed(&sealed.iv, "iv")?;
    let tag: [u8; 16] = decode_fixed(&sealed.tag, "tag")?;
    let mut body = decode(&sealed.ciphertext, "ciphertext")?;
    body.extend_from_slice(&tag);

    let recipient = PublicKey::from(secret).to_bytes();
    let shared = secret.diffie_hellman(&PublicKey::from(ephemeral));
    if !shared.was_contributory() {
        bail!("the grant's ephemeral key is a low-order point");
    }
    let kek = derive_kek(shared.as_bytes(), &ephemeral, &recipient);
    let aad = aad(header);
    let unwrap = Aes256Gcm::new_from_slice(&kek[..]).map_err(|_| anyhow!("bad key-encryption key"))?;
    let content_key = Zeroizing::new(
        unwrap.decrypt(Nonce::from_slice(&wrap_iv), Payload { msg: &wrapped, aad: aad.as_bytes() }).map_err(|_| anyhow!("the grant's content key does not unwrap"))?,
    );
    let cipher = Aes256Gcm::new_from_slice(&content_key).map_err(|_| anyhow!("the grant's content key is not 32 bytes"))?;
    let plaintext = cipher.decrypt(Nonce::from_slice(&iv), Payload { msg: &body, aad: aad.as_bytes() }).map_err(|_| anyhow!("the grant does not decrypt"))?;
    Ok(Zeroizing::new(plaintext))
}

/// Seal deterministically: the server's half, for the shared vector and the
/// fake server in the tests.
#[cfg(test)]
fn seal_with(ephemeral: [u8; 32], content_key: [u8; 32], wrap_iv: [u8; 12], iv: [u8; 12], recipient: &[u8; 32], header: GrantHeader, plaintext: &[u8]) -> SealedGrant {
    let secret = StaticSecret::from(ephemeral);
    let ephemeral_public = PublicKey::from(&secret).to_bytes();
    let shared = secret.diffie_hellman(&PublicKey::from(*recipient));
    let kek = derive_kek(shared.as_bytes(), &ephemeral_public, recipient);
    let aad = aad(&header);
    let wrapped = Aes256Gcm::new_from_slice(&kek[..]).unwrap().encrypt(Nonce::from_slice(&wrap_iv), Payload { msg: &content_key, aad: aad.as_bytes() }).unwrap();
    let mut body = Aes256Gcm::new_from_slice(&content_key).unwrap().encrypt(Nonce::from_slice(&iv), Payload { msg: plaintext, aad: aad.as_bytes() }).unwrap();
    let tag = body.split_off(body.len() - 16);
    let b64 = |bytes: &[u8]| general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    SealedGrant {
        v: 1,
        alg: ALG.into(),
        header,
        ephemeral_public_key: b64(&ephemeral_public),
        wrap_iv: b64(&wrap_iv),
        wrapped_key: b64(&wrapped),
        iv: b64(&iv),
        ciphertext: b64(&body),
        tag: b64(&tag),
    }
}

// ---------------------------------------------------------------- the key

/// The runtime's grant key, separate from the relay host key.
pub struct GrantKey {
    secret: StaticSecret,
    public: [u8; 32],
}

impl GrantKey {
    fn generate() -> Self {
        Self::from_secret(StaticSecret::random_from_rng(OsRng))
    }

    fn from_secret(secret: StaticSecret) -> Self {
        let public = PublicKey::from(&secret).to_bytes();
        Self { secret, public }
    }

    /// Standard base64 of the raw public key, as the enroll call takes it.
    pub fn public_key_b64(&self) -> String {
        general_purpose::STANDARD.encode(self.public)
    }

    pub fn thumbprint(&self) -> String {
        thumbprint(&self.public)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyFile {
    v: u8,
    secret: String,
}

impl Drop for KeyFile {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

/// The key persisted under `root`, or a new one written there. Memory-only
/// when there is no tmpfs root.
fn load_or_create_key(root: Option<&Path>) -> GrantKey {
    let Some(root) = root else {
        log::warn!(
            "no tmpfs directory for the agent grant key (set {GRANT_DIR_ENV}); it is kept in memory only, so after a restart the server refuses the new key until it rotates the runtime generation, and agents run without cloud credentials meanwhile"
        );
        return GrantKey::generate();
    };
    let path = root.join(KEY_FILE);
    match fs::read(&path) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            let secret = serde_json::from_slice::<KeyFile>(&bytes).ok().filter(|file| file.v == 1).and_then(|file| {
                let decoded = Zeroizing::new(general_purpose::URL_SAFE_NO_PAD.decode(&file.secret).ok()?);
                <[u8; 32]>::try_from(decoded.as_slice()).ok()
            });
            if let Some(mut secret) = secret {
                let key = GrantKey::from_secret(StaticSecret::from(secret));
                secret.zeroize();
                return key;
            }
            log::warn!("the agent grant key at {} is malformed; replacing it (the server may refuse the new key until the runtime generation rotates)", path.display());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("read the agent grant key at {}: {error}; generating a new one", path.display()),
    }
    let key = GrantKey::generate();
    let file = KeyFile { v: 1, secret: general_purpose::URL_SAFE_NO_PAD.encode(key.secret.as_bytes()) };
    match serde_json::to_vec(&file).map_err(anyhow::Error::from).and_then(|bytes| write_private(&path, &Zeroizing::new(bytes))) {
        Ok(()) => {}
        Err(error) => log::warn!("persist the agent grant key: {error:#}; a restart will need a new runtime generation"),
    }
    key
}

// ------------------------------------------------------------ tmpfs directory

/// The base directories the key and the Codex auth file may live under, in
/// order of preference: the override, `/dev/shm/terminalx-<uid>`,
/// `$XDG_RUNTIME_DIR/terminalx`. Each workspace gets its own directory
/// inside ([`workspace_dir`]).
fn candidate_roots(override_dir: Option<&str>, shm: &Path, xdg_runtime: Option<&str>, uid: u32) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = override_dir.map(str::trim).filter(|dir| !dir.is_empty()) {
        out.push(PathBuf::from(dir));
    }
    if shm.is_dir() {
        out.push(shm.join(format!("terminalx-{uid}")));
    }
    if let Some(dir) = xdg_runtime.map(str::trim).filter(|dir| !dir.is_empty()) {
        out.push(Path::new(dir).join("terminalx"));
    }
    out
}

/// One runtime's directory under a base: two runtimes under one account
/// never share a key or an auth file, and a restart of the same workspace
/// finds its own key again.
fn workspace_dir(base: &Path, workspace_id: &str) -> PathBuf {
    let digest = general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(workspace_id.as_bytes()));
    base.join(format!("ws-{}", &digest[..22]))
}

/// Create `dir` 0700 from the start and make sure it is a real directory this
/// user owns: `/dev/shm` is shared, and another user could have made the name
/// first.
pub(crate) fn prepare_private_dir(dir: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).with_context(|| format!("create {}", dir.display()))?;
    let meta = fs::symlink_metadata(dir).with_context(|| format!("inspect {}", dir.display()))?;
    if !meta.is_dir() {
        bail!("{} is not a directory", dir.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } {
            bail!("{} belongs to another user", dir.display());
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).with_context(|| format!("restrict {}", dir.display()))?;
    }
    Ok(())
}

/// The first base that can be made private, and this workspace's directory
/// inside it.
fn select_root(candidates: Vec<PathBuf>, workspace_id: &str) -> Option<PathBuf> {
    for base in candidates {
        let dir = workspace_dir(&base, workspace_id);
        match prepare_private_dir(&base).and_then(|()| prepare_private_dir(&dir)) {
            Ok(()) => return Some(dir),
            Err(error) => log::warn!("agent grant directory: {error:#}"),
        }
    }
    None
}

pub(crate) fn tmpfs_root(workspace_id: &str) -> Option<PathBuf> {
    #[cfg(unix)]
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    #[cfg(not(unix))]
    let uid = 0;
    let override_dir = std::env::var(GRANT_DIR_ENV).ok();
    let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
    select_root(candidate_roots(override_dir.as_deref(), Path::new("/dev/shm"), xdg.as_deref(), uid), workspace_id)
}

/// Write `bytes` to `path` as 0600: a new temp file with a random name,
/// created exclusively and never through a symlink, then renamed over `path`.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use rand_core::RngCore as _;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", general_purpose::URL_SAFE_NO_PAD.encode(nonce)));
    let written = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        file.write_all(bytes)?;
        fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

fn remove_if_present(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("remove {}: {error}", path.display()),
    }
}


// ------------------------------------------------------------ the plaintext

/// What a grant opens to. Never a refresh token.
enum Material {
    ClaudeApiKey(Zeroizing<String>),
    ClaudeOauth { access_token: Zeroizing<String>, expires_at: Option<u64> },
    CodexApiKey(Zeroizing<String>),
    CodexChatgpt { access_token: Zeroizing<String>, id_token: Zeroizing<String>, account_id: Option<String>, expires_at: Option<u64> },
    CursorApiKey(Zeroizing<String>),
}

impl Material {
    fn mode(&self) -> &'static str {
        match self {
            Self::ClaudeApiKey(_) | Self::CodexApiKey(_) | Self::CursorApiKey(_) => "api-key",
            Self::ClaudeOauth { .. } => "oauth-access-token",
            Self::CodexChatgpt { .. } => "chatgpt-tokens",
        }
    }

    /// When the credential inside stops working, if it says.
    fn expires_at(&self) -> Option<u64> {
        match self {
            Self::ClaudeOauth { expires_at, .. } | Self::CodexChatgpt { expires_at, .. } => *expires_at,
            _ => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plaintext {
    v: u8,
    provider: String,
    mode: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    expires_at: Option<u64>,
    version: u64,
}

impl Drop for Plaintext {
    fn drop(&mut self) {
        for secret in [&mut self.api_key, &mut self.access_token, &mut self.id_token].into_iter().flatten() {
            secret.zeroize();
        }
    }
}

/// Parse an opened grant. `Ok(None)` for a mode or provider this runtime does
/// not know. A plaintext that names a refresh token at all is refused: the
/// server is the only refresher, and such a grant means something is wrong.
fn parse_plaintext(bytes: &[u8]) -> Result<Option<(Material, u64, String)>> {
    let keys: HashMap<String, serde::de::IgnoredAny> = serde_json::from_slice(bytes).map_err(|_| anyhow!("the grant plaintext is not a JSON object"))?;
    if keys.keys().any(|key| key.to_ascii_lowercase().contains("refresh")) {
        bail!("the grant plaintext carries a refresh token");
    }
    let mut plain: Plaintext = serde_json::from_slice(bytes).map_err(|_| anyhow!("the grant plaintext is malformed"))?;
    if plain.v != 1 {
        bail!("unsupported grant plaintext version {}", plain.v);
    }
    let take = |value: &mut Option<String>, what: &str| -> Result<Zeroizing<String>> {
        match value.take() {
            Some(value) if !value.is_empty() => Ok(Zeroizing::new(value)),
            _ => Err(anyhow!("the grant plaintext lacks {what}")),
        }
    };
    let material = match (Provider::parse(&plain.provider), plain.mode.as_str()) {
        (Some(Provider::Claude), "api-key") => Material::ClaudeApiKey(take(&mut plain.api_key, "apiKey")?),
        (Some(Provider::Claude), "oauth-access-token") => {
            Material::ClaudeOauth { access_token: take(&mut plain.access_token, "accessToken")?, expires_at: plain.expires_at }
        }
        (Some(Provider::Codex), "api-key") => Material::CodexApiKey(take(&mut plain.api_key, "apiKey")?),
        (Some(Provider::Codex), "chatgpt-tokens") => Material::CodexChatgpt {
            access_token: take(&mut plain.access_token, "accessToken")?,
            id_token: take(&mut plain.id_token, "idToken")?,
            account_id: plain.account_id.take(),
            expires_at: plain.expires_at,
        },
        (Some(Provider::Cursor), "api-key") => Material::CursorApiKey(take(&mut plain.api_key, "apiKey")?),
        _ => {
            log::warn!("ignoring an agent grant with provider {:?} and mode {:?}", plain.provider, plain.mode);
            return Ok(None);
        }
    };
    Ok(Some((material, plain.version, std::mem::take(&mut plain.provider))))
}

#[derive(Serialize)]
struct CodexAuthFile<'a> {
    auth_mode: &'a str,
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens: Option<CodexTokens<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_refresh: Option<String>,
}

#[derive(Serialize)]
struct CodexTokens<'a> {
    id_token: &'a str,
    access_token: &'a str,
    refresh_token: &'a str,
    account_id: Option<&'a str>,
}

/// The Codex `auth.json` for a grant, or `None` for a grant Codex does not
/// read from a file.
fn codex_auth_json(material: &Material) -> Option<Zeroizing<Vec<u8>>> {
    let file = match material {
        Material::CodexApiKey(key) => CodexAuthFile { auth_mode: "apikey", openai_api_key: Some(key.as_str()), tokens: None, last_refresh: None },
        Material::CodexChatgpt { access_token, id_token, account_id, .. } => CodexAuthFile {
            auth_mode: "chatgpt",
            openai_api_key: None,
            tokens: Some(CodexTokens { id_token: id_token.as_str(), access_token: access_token.as_str(), refresh_token: "", account_id: account_id.as_deref() }),
            last_refresh: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        },
        _ => return None,
    };
    serde_json::to_vec_pretty(&file).ok().map(Zeroizing::new)
}

// ------------------------------------------------------------- the store

#[derive(Debug, Clone, PartialEq, Eq)]
struct Enrollment {
    thumbprint: String,
    runtime_generation: u64,
}

/// A grant the runtime accepted and injects into new sessions.
struct ActiveGrant {
    credential_id: String,
    grant_id: String,
    epoch: u64,
    version: u64,
    /// The server's clock, for the status snapshot only.
    expires_at: u64,
    /// When it stops being injected, on this machine's monotonic clock: the
    /// grant's own lifetime from when it arrived, less [`SKEW_ALLOWANCE`].
    usable_until: Instant,
    material: Material,
    /// The Codex `auth.json` written for it, if any.
    codex_file: Option<PathBuf>,
}

impl ActiveGrant {
    fn identity(&self) -> (String, u64, u64) {
        (self.credential_id.clone(), self.version, self.epoch)
    }

    fn usable(&self, now: Instant) -> bool {
        now < self.usable_until
    }
}

#[derive(Default)]
struct State {
    enrollment: Option<Enrollment>,
    active: HashMap<Provider, ActiveGrant>,
    credentials: HashMap<Provider, CredentialEntry>,
    /// The highest epoch accepted per credential id: a lower one is a rollback.
    highest_epoch: HashMap<String, u64>,
    /// Running sessions and the credential each was launched with.
    launches: HashMap<String, (Provider, (String, u64, u64))>,
    last_sync: Option<u64>,
    last_error: Option<String>,
}

/// The runtime's grants, for one workspace.
pub struct GrantStore {
    workspace_id: String,
    key: GrantKey,
    root: Option<PathBuf>,
    state: Mutex<State>,
    /// Set once the first sync has finished, either way; a Codex launch
    /// waits a moment for it ([`codex_auth_source`]).
    first_sync: Mutex<bool>,
    first_sync_done: Condvar,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

/// What one fetch left behind.
struct Applied {
    wait: Duration,
    offered: usize,
    accepted: usize,
}

impl GrantStore {
    /// The store for a bootstrapped workspace: its tmpfs directory, and the
    /// key persisted there (or a new one).
    pub fn open(workspace_id: String) -> Self {
        let root = tmpfs_root(&workspace_id);
        match &root {
            Some(root) => log::info!("agent grants keep their key and Codex auth file in {}", root.display()),
            None => log::warn!("no tmpfs directory for agent grants: Codex file credentials are skipped"),
        }
        let key = load_or_create_key(root.as_deref());
        Self::new(workspace_id, key, root)
    }

    fn new(workspace_id: String, key: GrantKey, root: Option<PathBuf>) -> Self {
        Self { workspace_id, key, root, state: Mutex::new(State::default()), first_sync: Mutex::new(false), first_sync_done: Condvar::new() }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn codex_auth_path(&self) -> Option<PathBuf> {
        self.root.as_ref().map(|root| root.join(AGENT_HOMES).join(Provider::Codex.as_str()).join(CODEX_AUTH_FILE))
    }

    fn mark_first_sync(&self) {
        let mut done = self.first_sync.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !*done {
            *done = true;
            self.first_sync_done.notify_all();
        }
    }

    /// Wait up to `timeout` for the first sync to finish. True once it has.
    pub fn wait_first_sync(&self, timeout: Duration) -> bool {
        let done = self.first_sync.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (done, _) = self.first_sync_done.wait_timeout_while(done, timeout, |done| !*done).unwrap_or_else(|poisoned| poisoned.into_inner());
        *done
    }

    /// Stop injecting everything, remove the Codex file and forget the
    /// enrollment: the runtime was fenced, or its key is not the one the
    /// server holds.
    pub fn drop_all(&self, reason: &str) {
        let mut state = self.state();
        if !state.active.is_empty() {
            log::warn!("{reason}: cloud agent credentials are no longer injected into new sessions");
        }
        state.active.clear();
        state.enrollment = None;
        if let Some(path) = self.codex_auth_path() {
            remove_if_present(&path);
        }
        drop(state);
        self.mark_first_sync();
    }

    fn ensure_enrolled(&self, api: &dyn GrantApi) -> Result<Enrollment, GrantCallError> {
        if let Some(enrollment) = self.state().enrollment.clone() {
            return Ok(enrollment);
        }
        let enrolled = api.enroll(&self.key.public_key_b64())?;
        let thumbprint = self.key.thumbprint();
        if enrolled.v != 1 || enrolled.key_thumbprint != thumbprint {
            return Err(GrantCallError::Transient(anyhow!("the server enrolled a different grant key")));
        }
        let enrollment = Enrollment { thumbprint, runtime_generation: enrolled.runtime_generation };
        log::info!("agent grant key {} enrolled for runtime generation {}", enrollment.thumbprint, enrollment.runtime_generation);
        self.state().enrollment = Some(enrollment.clone());
        Ok(enrollment)
    }

    /// Enroll if needed, fetch, and apply. `received` is the local monotonic
    /// time the answer is judged against; `wall` is only a fallback for
    /// scheduling when the server sent no grant. Returns how long to wait
    /// before the next fetch. Refusing every grant offered is an error, so the
    /// caller backs off.
    pub fn sync(&self, api: &dyn GrantApi, received: Instant, wall: u64) -> Result<Duration, GrantCallError> {
        let outcome = self.sync_inner(api, received, wall);
        match &outcome {
            Err(GrantCallError::Rejected) => self.drop_all("the grant API rejected the runtime credential"),
            Err(GrantCallError::KeyConflict) => self.drop_all("the server holds another grant key for this runtime generation"),
            _ => {}
        }
        let outcome = match outcome {
            Ok(applied) if applied.offered > 0 && applied.accepted == 0 => {
                Err(GrantCallError::Transient(anyhow!("every one of the {} agent grants offered was refused", applied.offered)))
            }
            Ok(applied) => Ok(applied.wait),
            Err(error) => Err(error),
        };
        {
            let mut state = self.state();
            match &outcome {
                Ok(_) => {
                    state.last_sync = Some(wall);
                    state.last_error = None;
                }
                Err(error) => state.last_error = Some(error.to_string()),
            }
        }
        self.mark_first_sync();
        outcome
    }

    fn sync_inner(&self, api: &dyn GrantApi, received: Instant, wall: u64) -> Result<Applied, GrantCallError> {
        let mut enrollment = self.ensure_enrolled(api)?;
        let fetched = match api.fetch(&enrollment.thumbprint) {
            // The generation rotated, or the server lost the key: enroll
            // again, once.
            Err(GrantCallError::KeyRequired) => {
                log::info!("the server asked for the agent grant key again; re-enrolling");
                self.state().enrollment = None;
                enrollment = self.ensure_enrolled(api)?;
                api.fetch(&enrollment.thumbprint)?
            }
            other => other?,
        };
        self.apply(fetched, &enrollment, received, wall).map_err(GrantCallError::Transient)
    }

    fn accept(
        &self,
        sealed: &SealedGrant,
        credentials: &HashMap<Provider, CredentialEntry>,
        enrollment: &Enrollment,
        highest: &HashMap<String, u64>,
        received: Instant,
    ) -> Result<Option<(Provider, ActiveGrant)>> {
        let header = &sealed.header;
        if header.workspace_id != self.workspace_id {
            bail!("the grant is for another workspace");
        }
        if header.runtime_generation != enrollment.runtime_generation {
            bail!("the grant is for runtime generation {}, not {}", header.runtime_generation, enrollment.runtime_generation);
        }
        if header.key_thumbprint != enrollment.thumbprint {
            bail!("the grant is sealed to another key");
        }
        if header.issued_at > header.expires_at {
            bail!("the grant was issued after it expires");
        }
        if highest.get(&header.credential_id).is_some_and(|seen| header.epoch < *seen) {
            bail!("the grant's epoch {} is lower than one already accepted", header.epoch);
        }
        let Some(provider) = Provider::parse(&header.provider) else {
            log::warn!("ignoring an agent grant for unknown provider {:?}", header.provider);
            return Ok(None);
        };
        let entry = credentials.get(&provider).filter(|entry| entry.credential_id == header.credential_id);
        match entry {
            Some(entry) if entry.state == CONNECTED => {
                if header.epoch < entry.epoch {
                    bail!("the grant's epoch {} is older than the credential's {}", header.epoch, entry.epoch);
                }
            }
            _ => bail!("the grant's credential is not connected"),
        }
        let plaintext = open(&self.key.secret, sealed)?;
        let Some((material, version, plain_provider)) = parse_plaintext(&plaintext)? else { return Ok(None) };
        if plain_provider != header.provider {
            bail!("the grant's plaintext is for another provider");
        }
        // Freshness is the grant's own lifetime from when it arrived, in the
        // server's terms, so a VM clock that is off cannot refuse (or extend)
        // it. A credential that says it ends sooner ends the grant sooner.
        let mut lifetime_ms = header.expires_at - header.issued_at;
        if let Some(material_expires) = material.expires_at() {
            lifetime_ms = lifetime_ms.min(material_expires.saturating_sub(header.issued_at));
        }
        let lifetime = Duration::from_millis(lifetime_ms).min(MAX_GRANT_LIFETIME);
        if lifetime <= SKEW_ALLOWANCE {
            bail!("the grant expires on arrival");
        }
        Ok(Some((
            provider,
            ActiveGrant {
                credential_id: header.credential_id.clone(),
                grant_id: header.grant_id.clone(),
                epoch: header.epoch,
                version,
                expires_at: header.expires_at,
                usable_until: received + (lifetime - SKEW_ALLOWANCE),
                material,
                codex_file: None,
            },
        )))
    }

    fn apply(&self, fetched: Fetched, enrollment: &Enrollment, received: Instant, wall: u64) -> Result<Applied> {
        if fetched.v != 1 {
            bail!("unsupported agent grants version {}", fetched.v);
        }
        if fetched.workspace_id != self.workspace_id {
            bail!("the server answered for another workspace");
        }
        if fetched.key_thumbprint != enrollment.thumbprint {
            bail!("the server answered for another grant key");
        }
        if fetched.runtime_generation != enrollment.runtime_generation {
            // Enroll again on the next sync.
            self.state().enrollment = None;
            bail!("the runtime generation moved from {} to {}", enrollment.runtime_generation, fetched.runtime_generation);
        }
        if fetched.grants.len() > MAX_GRANTS || fetched.credentials.len() > MAX_GRANTS {
            bail!("the server listed too many grants or credentials");
        }
        let mut credentials: HashMap<Provider, CredentialEntry> = HashMap::new();
        for (index, raw) in fetched.credentials.into_iter().enumerate() {
            let Ok(entry) = serde_json::from_value::<CredentialEntry>(raw) else {
                log::warn!("skipping malformed cloud agent credential #{index}");
                continue;
            };
            let Some(provider) = Provider::parse(&entry.provider) else {
                log::warn!("ignoring a cloud agent credential for unknown provider {:?}", entry.provider);
                continue;
            };
            // One credential per provider; a connected one wins over a stale row.
            let keep = credentials.get(&provider).is_none_or(|current| current.state != CONNECTED && entry.state == CONNECTED);
            if keep {
                credentials.insert(provider, entry);
            }
        }
        let offered = fetched.grants.len();
        let mut sealed_grants = Vec::with_capacity(offered);
        for (index, raw) in fetched.grants.into_iter().enumerate() {
            match serde_json::from_value::<SealedGrant>(raw) {
                Ok(sealed) => sealed_grants.push(sealed),
                // The value may hold key material; only its position is logged.
                Err(_) => log::warn!("skipping malformed agent grant #{index}"),
            }
        }

        let mut state = self.state();
        let mut next: HashMap<Provider, ActiveGrant> = HashMap::new();
        let mut accepted = 0;
        for sealed in &sealed_grants {
            match self.accept(sealed, &credentials, enrollment, &state.highest_epoch, received) {
                Ok(Some((provider, grant))) => {
                    accepted += 1;
                    let better = next.get(&provider).is_none_or(|current| (grant.epoch, grant.usable_until) > (current.epoch, current.usable_until));
                    if better {
                        next.insert(provider, grant);
                    }
                }
                Ok(None) => accepted += 1,
                Err(error) => log::warn!("refused agent grant {} for {}: {error:#}", sealed.header.grant_id, sealed.header.provider),
            }
        }

        for (provider, entry) in &credentials {
            let before = state.credentials.get(provider).map(|old| (old.state.as_str(), old.version, old.epoch));
            if before != Some((entry.state.as_str(), entry.version, entry.epoch)) {
                log::info!("cloud {} credential is {} (version {}, epoch {})", provider.as_str(), entry.state, entry.version, entry.epoch);
            }
        }
        for (provider, old) in &state.active {
            match next.get(provider) {
                None => log::info!("cloud {} credential no longer injected into new sessions; running sessions keep what they started with", provider.as_str()),
                Some(new) if new.identity() != old.identity() => {
                    let running = state.launches.values().filter(|(p, identity)| p == provider && *identity != new.identity()).count();
                    log::info!(
                        "cloud {} credential rotated to version {} (epoch {}); new sessions use it, {running} running session(s) need a restart to pick it up",
                        provider.as_str(),
                        new.version,
                        new.epoch
                    );
                }
                Some(_) => {}
            }
        }
        for (provider, grant) in &next {
            if !state.active.contains_key(provider) {
                log::info!("cloud {} credential ({}) injected into new sessions (version {}, epoch {})", provider.as_str(), grant.material.mode(), grant.version, grant.epoch);
            }
            let seen = state.highest_epoch.entry(grant.credential_id.clone()).or_insert(0);
            *seen = (*seen).max(grant.epoch);
        }

        self.materialize(&mut next);
        state.active = next;
        state.credentials = credentials;

        // `refreshAfter` is on the server's clock: measure it from the
        // server's "now" (the latest issuedAt), not from this VM's clock.
        let server_now = sealed_grants.iter().map(|sealed| sealed.header.issued_at).filter(|issued| *issued > 0).max();
        let mut wait = match server_now {
            Some(server_now) => Duration::from_millis(fetched.refresh_after.saturating_sub(server_now)),
            None => match fetched.refresh_after.saturating_sub(wall) {
                0 => FALLBACK_REFRESH,
                ms => Duration::from_millis(ms),
            },
        };
        for grant in state.active.values() {
            wait = wait.min(grant.usable_until.saturating_duration_since(received).saturating_sub(EXPIRY_MARGIN));
        }
        Ok(Applied { wait: wait.clamp(MIN_REFRESH, MAX_REFRESH), offered, accepted })
    }

    /// Write the Codex auth file for a Codex grant, or remove it when there is
    /// none. Only under the tmpfs root.
    fn materialize(&self, active: &mut HashMap<Provider, ActiveGrant>) {
        let Some(path) = self.codex_auth_path() else { return };
        let Some(grant) = active.get_mut(&Provider::Codex) else {
            remove_if_present(&path);
            return;
        };
        let Some(bytes) = codex_auth_json(&grant.material) else {
            remove_if_present(&path);
            return;
        };
        let written = path.parent().context("the Codex auth path has no parent").and_then(prepare_private_dir).and_then(|()| write_private(&path, &bytes));
        match written {
            Ok(()) => grant.codex_file = Some(path),
            Err(error) => {
                log::warn!("write the Codex auth file: {error:#}");
                remove_if_present(&path);
            }
        }
    }

    /// Drop grants that have expired, e.g. while the server was unreachable.
    pub fn prune(&self, now: Instant) {
        let mut state = self.state();
        let expired: Vec<Provider> = state.active.iter().filter(|(_, grant)| !grant.usable(now)).map(|(provider, _)| *provider).collect();
        for provider in expired {
            if let Some(grant) = state.active.remove(&provider) {
                log::info!("cloud {} credential grant expired; not injected until the next fetch", provider.as_str());
                if let Some(path) = &grant.codex_file {
                    remove_if_present(path);
                }
            }
        }
    }

    /// The environment for a new agent process: `Some` sets, `None` unsets.
    /// Empty when there is no usable grant for `provider`.
    pub fn agent_env(&self, provider: Provider, now: Instant) -> Vec<(String, Option<String>)> {
        let state = self.state();
        let Some(grant) = state.active.get(&provider).filter(|grant| grant.usable(now)) else { return Vec::new() };
        let set = |name: &str, value: &str| (name.to_string(), Some(value.to_string()));
        let unset = |name: &str| (name.to_string(), None);
        match &grant.material {
            // Claude Code prefers ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY,
            // then CLAUDE_CODE_OAUTH_TOKEN: the others must not shadow the grant.
            Material::ClaudeApiKey(key) => vec![set(CLAUDE_API_KEY_ENV, key), unset(CLAUDE_AUTH_TOKEN_ENV), unset(CLAUDE_OAUTH_ENV)],
            Material::ClaudeOauth { access_token, .. } => vec![set(CLAUDE_OAUTH_ENV, access_token), unset(CLAUDE_AUTH_TOKEN_ENV), unset(CLAUDE_API_KEY_ENV)],
            Material::CodexApiKey(key) if grant.codex_file.is_none() => vec![set(CODEX_API_KEY_ENV, key)],
            Material::CodexApiKey(_) | Material::CodexChatgpt { .. } if grant.codex_file.is_some() => vec![unset(CODEX_API_KEY_ENV)],
            Material::CodexChatgpt { .. } => Vec::new(),
            Material::CursorApiKey(key) => vec![set(CURSOR_API_KEY_ENV, key)],
            Material::CodexApiKey(_) => Vec::new(),
        }
    }

    /// [`Self::agent_env`], remembering which credential the session under
    /// `launch` started with.
    pub fn agent_env_for_launch(&self, provider: Provider, launch: &str, now: Instant) -> Vec<(String, Option<String>)> {
        let env = self.agent_env(provider, now);
        let mut state = self.state();
        let identity = if env.is_empty() { None } else { state.active.get(&provider).map(ActiveGrant::identity) };
        match identity {
            Some(identity) => {
                state.launches.insert(launch.to_string(), (provider, identity));
            }
            None => {
                state.launches.remove(launch);
            }
        }
        env
    }

    pub fn forget_launch(&self, launch: &str) {
        self.state().launches.remove(launch);
    }

    /// The Codex auth file new sessions should see, if there is a usable one.
    pub fn codex_auth_file(&self, now: Instant) -> Option<PathBuf> {
        self.state().active.get(&Provider::Codex).filter(|grant| grant.usable(now)).and_then(|grant| grant.codex_file.clone())
    }

    /// What the runtime knows about its cloud credentials. No secrets.
    pub fn status(&self, now: Instant) -> Value {
        let state = self.state();
        let mut providers: Vec<Provider> = state.credentials.keys().chain(state.active.keys()).copied().collect();
        providers.sort();
        providers.dedup();
        let rows: Vec<Value> = providers
            .into_iter()
            .map(|provider| {
                let entry = state.credentials.get(&provider);
                let grant = state.active.get(&provider);
                let current = grant.map(ActiveGrant::identity);
                let stale = state.launches.values().filter(|(p, identity)| *p == provider && current.as_ref().is_some_and(|current| current != identity)).count();
                json!({
                    "provider": provider.as_str(),
                    "credentialId": entry.map(|entry| entry.credential_id.clone()),
                    "state": entry.map(|entry| entry.state.clone()),
                    "version": entry.map(|entry| entry.version),
                    "epoch": entry.map(|entry| entry.epoch),
                    "reason": entry.and_then(|entry| entry.reason.clone()),
                    "mode": grant.map(|grant| grant.material.mode()),
                    "grantId": grant.map(|grant| grant.grant_id.clone()),
                    "grantExpiresAt": grant.map(|grant| grant.expires_at),
                    "injecting": grant.is_some_and(|grant| grant.usable(now)),
                    "restartRequired": stale > 0,
                    "restartRequiredSessions": stale,
                })
            })
            .collect();
        json!({
            "enrolled": state.enrollment.is_some(),
            "keyThumbprint": self.key.thumbprint(),
            "runtimeGeneration": state.enrollment.as_ref().map(|enrollment| enrollment.runtime_generation),
            "tmpfs": self.root.is_some(),
            "lastSync": state.last_sync,
            "lastError": state.last_error,
            "credentials": rows,
        })
    }
}

impl Drop for GrantStore {
    fn drop(&mut self) {
        if let Some(path) = self.codex_auth_path() {
            if self.state().active.values().any(|grant| grant.codex_file.is_some()) {
                remove_if_present(&path);
            }
        }
    }
}

// ------------------------------------------------------------ the loop

/// One turn of the loop; returns how long to sleep before the next. While
/// the runtime credential is rejected nothing is injected and nothing is
/// fetched. Errors back off exponentially from [`BACKOFF_START`].
fn step(store: &GrantStore, api: &dyn GrantApi, rejected: bool, backoff: &mut Duration) -> Duration {
    if rejected {
        store.drop_all("the runtime credential is rejected");
        return REJECTED_PAUSE;
    }
    match store.sync(api, Instant::now(), now_ms()) {
        Ok(wait) => {
            *backoff = BACKOFF_START;
            wait
        }
        Err(error) => {
            match &error {
                GrantCallError::KeyConflict => log::error!(
                    "the server holds a different agent grant key for this runtime generation (the key was lost in a restart); agents run without cloud credentials until the generation rotates"
                ),
                error => log::warn!("fetch agent grants: {error}; retrying in {}s", backoff.as_secs()),
            }
            store.prune(Instant::now());
            let wait = *backoff;
            *backoff = (*backoff * 2).min(BACKOFF_CAP);
            wait
        }
    }
}

/// Keep the grants fresh until the process ends: at the server's
/// `refreshAfter`, before any grant expires, with backoff on errors, and
/// paused (with nothing injected) while the runtime credential is rejected.
pub fn spawn_sync_loop(store: Arc<GrantStore>, api: Arc<dyn GrantApi + Send + Sync>, rejected: impl Fn() -> bool + Send + 'static) {
    let spawned = std::thread::Builder::new().name("cloud-agent-grants".into()).spawn(move || {
        let mut backoff = BACKOFF_START;
        loop {
            let wait = step(&store, api.as_ref(), rejected(), &mut backoff);
            std::thread::sleep(wait);
        }
    });
    if let Err(error) = spawned {
        log::error!("start the agent grant loop: {error}");
    }
}

// ------------------------------------------------------------ the hooks

static STORE: OnceLock<Arc<GrantStore>> = OnceLock::new();

/// Make `store` the one agent spawns consult. `terminalx-serve` does this in
/// a cloud workspace only; the desktop and a local runtime never do.
pub fn install(store: Arc<GrantStore>) {
    if STORE.set(store).is_err() {
        log::warn!("the agent grant store is already installed");
    }
}

fn installed() -> Option<&'static Arc<GrantStore>> {
    STORE.get()
}

/// The environment to apply to a new agent process for `harness`, recorded
/// under `launch` for restart tracking. Empty outside a cloud workspace.
pub fn agent_env_for_launch(harness: &str, launch: &str) -> Vec<(String, Option<String>)> {
    let (Some(store), Some(provider)) = (installed(), provider_of_harness(harness)) else { return Vec::new() };
    store.agent_env_for_launch(provider, launch, Instant::now())
}

/// A session launched under `launch` has ended.
pub fn forget_launch(launch: &str) {
    if let Some(store) = installed() {
        store.forget_launch(launch);
    }
}

fn provider_of_harness(harness: &str) -> Option<Provider> {
    match harness {
        "claude" => Some(Provider::Claude),
        "codex" => Some(Provider::Codex),
        "cursor" | "cursor-agent" => Some(Provider::Cursor),
        _ => None,
    }
}

/// `None` outside a cloud workspace: the Codex home links the reader's
/// `auth.json` as usual. Inside one, the grant's auth file, or `Some(None)`
/// when there is none and the home must have no `auth.json` at all. A launch
/// right after start waits briefly for the first sync, so it does not start
/// logged out (and tempt a `codex login` into the persistent home).
pub fn codex_auth_source() -> Option<Option<PathBuf>> {
    let store = installed()?;
    if !store.wait_first_sync(FIRST_SYNC_WAIT) {
        log::warn!("the first agent grant sync has not finished; starting Codex without a cloud credential");
    }
    Some(store.codex_auth_file(Instant::now()))
}

/// Point `<managed>/auth.json` at the grant's auth file, or remove whatever
/// is there (a link, or a regular file a `codex login` wrote): in a cloud
/// workspace the persistent home never holds a credential of its own.
pub fn link_codex_auth(managed: &Path, source: Option<&Path>) -> Result<()> {
    let target = managed.join(CODEX_AUTH_FILE);
    if let Some(source) = source {
        if fs::read_link(&target).is_ok_and(|current| current == source) {
            return Ok(());
        }
    }
    if target.symlink_metadata().is_ok() {
        fs::remove_file(&target).with_context(|| format!("remove {}", target.display()))?;
    }
    let Some(source) = source else { return Ok(()) };
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, &target).with_context(|| format!("link the cloud Codex credential into {}", managed.display()))
    }
    #[cfg(not(unix))]
    {
        let _ = source;
        bail!("cloud Codex credentials need a unix host")
    }
}

/// The status snapshot for the control socket, in a cloud workspace.
pub fn status_json() -> Option<Value> {
    installed().map(|store| store.status(Instant::now()))
}

/// Wrap `command` so `unset` names are removed from its environment after
/// the login shell has run its profile. The names are plain identifiers.
pub fn unset_prefix(command: &str, unset: &[String]) -> String {
    if unset.is_empty() || cfg!(not(unix)) {
        return command.to_string();
    }
    let mut out = String::from("env");
    for name in unset {
        out.push_str(" -u ");
        out.push_str(name);
    }
    out.push(' ');
    out.push_str(command);
    out
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const WORKSPACE: &str = "workspace_00000000-0000-4000-8000-000000000001";
    const GENERATION: u64 = 7;

    fn hex<const N: usize>(value: &str) -> [u8; N] {
        let bytes: Vec<u8> = (0..value.len()).step_by(2).map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap()).collect();
        bytes.try_into().unwrap()
    }

    fn vector() -> Value {
        serde_json::from_str(include_str!("fixtures/cloud_agent_grant_vector.json")).unwrap()
    }

    fn vector_sealed() -> SealedGrant {
        serde_json::from_value(vector()["sealed"].clone()).unwrap()
    }

    fn vector_secret() -> StaticSecret {
        StaticSecret::from(hex::<32>(vector()["recipientPrivateKeyHex"].as_str().unwrap()))
    }

    #[test]
    fn the_shared_vector_opens_to_its_plaintext() {
        let v = vector();
        let plaintext = open(&vector_secret(), &vector_sealed()).unwrap();
        assert_eq!(plaintext.as_slice(), v["plaintext"].as_str().unwrap().as_bytes());
        assert_eq!(aad(&vector_sealed().header), v["aad"].as_str().unwrap());
        let public = PublicKey::from(&vector_secret()).to_bytes();
        assert_eq!(general_purpose::STANDARD.encode(public), v["recipientPublicKeyB64"].as_str().unwrap());
        assert_eq!(thumbprint(&public), vector_sealed().header.key_thumbprint);
    }

    #[test]
    fn sealing_the_vector_inputs_reproduces_it_byte_for_byte() {
        let v = vector();
        let recipient = PublicKey::from(&vector_secret()).to_bytes();
        let sealed = seal_with(
            hex(v["ephemeralPrivateKeyHex"].as_str().unwrap()),
            hex(v["contentKeyHex"].as_str().unwrap()),
            hex(v["wrapIvHex"].as_str().unwrap()),
            hex(v["ivHex"].as_str().unwrap()),
            &recipient,
            vector_sealed().header,
            v["plaintext"].as_str().unwrap().as_bytes(),
        );
        assert_eq!(serde_json::to_value(&sealed).unwrap(), v["sealed"]);
    }

    #[test]
    fn any_tampering_fails_to_open() {
        let secret = vector_secret();
        let base = vector_sealed();
        let mut cases: Vec<(&str, SealedGrant)> = Vec::new();
        let mut with = |name: &'static str, edit: &dyn Fn(&mut SealedGrant)| {
            let mut sealed = base.clone();
            edit(&mut sealed);
            cases.push((name, sealed));
        };
        with("workspaceId", &|s| s.header.workspace_id.push('x'));
        with("provider", &|s| s.header.provider = "codex".into());
        with("credentialId", &|s| s.header.credential_id.push('x'));
        with("keyThumbprint", &|s| s.header.key_thumbprint.replace_range(0..1, "A"));
        with("epoch", &|s| s.header.epoch += 1);
        with("runtimeGeneration", &|s| s.header.runtime_generation += 1);
        with("grantId", &|s| s.header.grant_id.push('x'));
        with("issuedAt", &|s| s.header.issued_at += 1);
        with("expiresAt", &|s| s.header.expires_at += 1);
        let flip = |value: &str| {
            let mut bytes = general_purpose::URL_SAFE_NO_PAD.decode(value).unwrap();
            bytes[0] ^= 1;
            general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        };
        with("ciphertext", &|s| s.ciphertext = flip(&s.ciphertext));
        with("tag", &|s| s.tag = flip(&s.tag));
        with("wrappedKey", &|s| s.wrapped_key = flip(&s.wrapped_key));
        with("wrapIv", &|s| s.wrap_iv = flip(&s.wrap_iv));
        with("iv", &|s| s.iv = flip(&s.iv));
        with("ephemeralPublicKey", &|s| s.ephemeral_public_key = flip(&s.ephemeral_public_key));
        with("alg", &|s| s.alg = "none".into());
        for (name, sealed) in cases {
            assert!(open(&secret, &sealed).is_err(), "tampering with {name} must fail");
        }
        assert!(open(&StaticSecret::from([9u8; 32]), &base).is_err(), "another key must fail");
        let mut low_order = base.clone();
        low_order.ephemeral_public_key = general_purpose::URL_SAFE_NO_PAD.encode([0u8; 32]);
        assert!(open(&secret, &low_order).is_err(), "an all-zero shared secret is refused");
    }

    // ----------------------------------------------------------- fake server

    struct Grant {
        provider: &'static str,
        credential_id: &'static str,
        epoch: u64,
        issued_at: u64,
        expires_at: u64,
        plaintext: String,
        workspace_id: &'static str,
        generation: u64,
    }

    #[derive(Default)]
    struct FakeServer {
        enrolled: RefCell<Option<String>>,
        generation: RefCell<u64>,
        credentials: RefCell<Vec<CredentialEntry>>,
        grants: RefCell<Vec<Grant>>,
        /// Sent as-is after the sealed ones.
        raw_grants: RefCell<Vec<Value>>,
        enrolls: RefCell<usize>,
        fetches: RefCell<usize>,
        /// Answer the next fetch with key_required, as after a rotation.
        forget_key: RefCell<bool>,
        /// Answer everything with 401.
        reject: RefCell<bool>,
        refresh_after: RefCell<Option<u64>>,
        seq: RefCell<u8>,
    }

    impl FakeServer {
        fn new() -> Self {
            let server = Self::default();
            *server.generation.borrow_mut() = GENERATION;
            server
        }

        fn credential(&self, provider: &str, id: &str, state: &str, epoch: u64, version: u64) {
            let mut list = self.credentials.borrow_mut();
            list.retain(|entry| entry.provider != provider);
            list.push(CredentialEntry {
                provider: provider.into(),
                credential_id: id.into(),
                state: state.into(),
                epoch,
                version,
                rotation: Some("new-sessions".into()),
                reason: None,
            });
        }

        fn grant(&self, provider: &'static str, id: &'static str, epoch: u64, plaintext: Value) {
            self.grants.borrow_mut().retain(|grant| grant.provider != provider);
            self.grants.borrow_mut().push(Grant {
                provider,
                credential_id: id,
                epoch,
                issued_at: NOW,
                expires_at: NOW + 15 * 60_000,
                plaintext: plaintext.to_string(),
                workspace_id: WORKSPACE,
                generation: *self.generation.borrow(),
            });
        }
    }

    impl GrantApi for FakeServer {
        fn enroll(&self, key: &str) -> Result<Enrolled, GrantCallError> {
            if *self.reject.borrow() {
                return Err(GrantCallError::Rejected);
            }
            *self.enrolls.borrow_mut() += 1;
            let mut enrolled = self.enrolled.borrow_mut();
            match enrolled.as_deref() {
                Some(current) if current != key => return Err(GrantCallError::KeyConflict),
                _ => *enrolled = Some(key.to_string()),
            }
            let public: [u8; 32] = general_purpose::STANDARD.decode(key).unwrap().try_into().unwrap();
            Ok(Enrolled { v: 1, key_thumbprint: thumbprint(&public), runtime_generation: *self.generation.borrow() })
        }

        fn fetch(&self, key_thumbprint: &str) -> Result<Fetched, GrantCallError> {
            if *self.reject.borrow() {
                return Err(GrantCallError::Rejected);
            }
            *self.fetches.borrow_mut() += 1;
            if std::mem::take(&mut *self.forget_key.borrow_mut()) {
                *self.enrolled.borrow_mut() = None;
                return Err(GrantCallError::KeyRequired);
            }
            let Some(key) = self.enrolled.borrow().clone() else { return Err(GrantCallError::KeyRequired) };
            let public: [u8; 32] = general_purpose::STANDARD.decode(key).unwrap().try_into().unwrap();
            if thumbprint(&public) != key_thumbprint {
                return Err(GrantCallError::KeyRequired);
            }
            let mut grants: Vec<Value> = self
                .grants
                .borrow()
                .iter()
                .map(|grant| {
                    *self.seq.borrow_mut() += 1;
                    let seq = *self.seq.borrow();
                    let header = GrantHeader {
                        workspace_id: grant.workspace_id.into(),
                        provider: grant.provider.into(),
                        credential_id: grant.credential_id.into(),
                        key_thumbprint: key_thumbprint.into(),
                        epoch: grant.epoch,
                        runtime_generation: grant.generation,
                        grant_id: format!("grant_{seq}"),
                        issued_at: grant.issued_at,
                        expires_at: grant.expires_at,
                    };
                    let sealed = seal_with([seq; 32], [seq.wrapping_add(1); 32], [seq; 12], [seq.wrapping_add(2); 12], &public, header, grant.plaintext.as_bytes());
                    serde_json::to_value(sealed).unwrap()
                })
                .collect();
            grants.extend(self.raw_grants.borrow().iter().cloned());
            let credentials = self.credentials.borrow().iter().map(|entry| serde_json::to_value(entry).unwrap()).collect();
            Ok(Fetched {
                v: 1,
                workspace_id: WORKSPACE.into(),
                runtime_generation: *self.generation.borrow(),
                key_thumbprint: key_thumbprint.into(),
                refresh_after: self.refresh_after.borrow().unwrap_or(NOW + 5 * 60_000),
                grants,
                credentials,
            })
        }
    }

    const NOW: u64 = 1_790_985_600_000;
    const MINUTE: Duration = Duration::from_secs(60);

    fn store(root: Option<PathBuf>) -> GrantStore {
        GrantStore::new(WORKSPACE.into(), GrantKey::generate(), root)
    }

    fn claude_oauth(token: &str, version: u64) -> Value {
        json!({"v": 1, "provider": "claude", "mode": "oauth-access-token", "accessToken": token, "expiresAt": NOW + 3_600_000, "version": version})
    }

    fn codex_chatgpt(token: &str) -> Value {
        json!({"v": 1, "provider": "codex", "mode": "chatgpt-tokens", "accessToken": token, "idToken": "fake.id.token", "accountId": "acct_1", "expiresAt": NOW + 3_600_000, "version": 1})
    }

    fn cursor_key() -> Value {
        json!({"v": 1, "provider": "cursor", "mode": "api-key", "apiKey": "fake-cursor", "version": 1})
    }

    fn value_of<'a>(env: &'a [(String, Option<String>)], name: &str) -> Option<&'a Option<String>> {
        env.iter().find(|(key, _)| key == name).map(|(_, value)| value)
    }

    #[test]
    fn enrolls_fetches_and_injects() {
        let server = FakeServer::new();
        server.credential("claude", "cred_c", "connected", 3, 4);
        server.grant("claude", "cred_c", 3, claude_oauth("fake-oauth-1", 4));
        let store = store(None);
        let t0 = Instant::now();
        assert_eq!(store.sync(&server, t0, NOW).unwrap(), 5 * MINUTE, "refreshAfter measured from issuedAt");
        let env = store.agent_env(Provider::Claude, t0);
        assert_eq!(value_of(&env, CLAUDE_OAUTH_ENV), Some(&Some("fake-oauth-1".to_string())));
        assert_eq!(value_of(&env, CLAUDE_API_KEY_ENV), Some(&None));
        assert_eq!(value_of(&env, CLAUDE_AUTH_TOKEN_ENV), Some(&None));
        assert!(store.agent_env(Provider::Codex, t0).is_empty());
        let status = store.status(t0);
        assert_eq!(status["credentials"][0]["provider"], "claude");
        assert_eq!(status["credentials"][0]["injecting"], true);
        assert!(!status.to_string().contains("fake-oauth-1"), "the status carries no secret");
    }

    #[test]
    fn agent_env_matches_each_mode() {
        let server = FakeServer::new();
        server.credential("claude", "cred_c", "connected", 1, 1);
        server.grant("claude", "cred_c", 1, json!({"v": 1, "provider": "claude", "mode": "api-key", "apiKey": "fake-anthropic", "version": 1}));
        server.credential("cursor", "cred_u", "connected", 1, 1);
        server.grant("cursor", "cred_u", 1, cursor_key());
        server.credential("codex", "cred_x", "connected", 1, 1);
        server.grant("codex", "cred_x", 1, json!({"v": 1, "provider": "codex", "mode": "api-key", "apiKey": "fake-openai", "version": 1}));
        // Without tmpfs, a Codex API key goes through the environment.
        let store = store(None);
        let t0 = Instant::now();
        store.sync(&server, t0, NOW).unwrap();
        assert_eq!(
            store.agent_env(Provider::Claude, t0),
            vec![(CLAUDE_API_KEY_ENV.into(), Some("fake-anthropic".into())), (CLAUDE_AUTH_TOKEN_ENV.into(), None), (CLAUDE_OAUTH_ENV.into(), None)]
        );
        assert_eq!(store.agent_env(Provider::Cursor, t0), vec![(CURSOR_API_KEY_ENV.into(), Some("fake-cursor".into()))]);
        assert_eq!(store.agent_env(Provider::Codex, t0), vec![(CODEX_API_KEY_ENV.into(), Some("fake-openai".into()))]);
        assert!(store.codex_auth_file(t0).is_none());
        // ChatGPT tokens need the file, so without tmpfs there is nothing.
        server.grant("codex", "cred_x", 1, codex_chatgpt("fake-chatgpt"));
        store.sync(&server, t0, NOW).unwrap();
        assert!(store.agent_env(Provider::Codex, t0).is_empty());
        // Past the grant's lifetime (less the skew allowance) nothing is injected.
        assert!(!store.agent_env(Provider::Claude, t0 + 14 * MINUTE).is_empty());
        assert!(store.agent_env(Provider::Claude, t0 + 15 * MINUTE).is_empty());
    }

    #[test]
    fn codex_gets_an_isolated_auth_file_and_revocation_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let server = FakeServer::new();
        server.credential("codex", "cred_x", "connected", 2, 5);
        server.grant("codex", "cred_x", 2, codex_chatgpt("fake-chatgpt-access"));
        let store = store(Some(dir.path().to_path_buf()));
        let t0 = Instant::now();
        store.sync(&server, t0, NOW).unwrap();
        let path = store.codex_auth_file(t0).unwrap();
        assert_eq!(path, dir.path().join("agent-homes/codex/auth.json"));
        let auth: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(auth["auth_mode"], "chatgpt");
        assert_eq!(auth["OPENAI_API_KEY"], Value::Null);
        assert_eq!(auth["tokens"]["access_token"], "fake-chatgpt-access");
        assert_eq!(auth["tokens"]["id_token"], "fake.id.token");
        assert_eq!(auth["tokens"]["account_id"], "acct_1");
        assert_eq!(auth["tokens"]["refresh_token"], "");
        assert!(auth["last_refresh"].as_str().unwrap().ends_with('Z'));
        assert_eq!(store.agent_env(Provider::Codex, t0), vec![(CODEX_API_KEY_ENV.into(), None)]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // Only the auth file is left behind: no temp files.
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);

        // The managed home links to it, and unlinks when it is gone.
        let managed = tempfile::tempdir().unwrap();
        link_codex_auth(managed.path(), Some(&path)).unwrap();
        link_codex_auth(managed.path(), Some(&path)).unwrap();
        #[cfg(unix)]
        assert_eq!(fs::read_link(managed.path().join("auth.json")).unwrap(), path);

        server.credential("codex", "cred_x", "revoked", 2, 5);
        server.grants.borrow_mut().clear();
        store.sync(&server, t0, NOW).unwrap();
        assert!(!path.exists(), "a revoked credential's file is removed");
        assert!(store.agent_env(Provider::Codex, t0).is_empty());
        assert!(store.codex_auth_file(t0).is_none());
        link_codex_auth(managed.path(), None).unwrap();
        assert!(managed.path().join("auth.json").symlink_metadata().is_err());
    }

    #[test]
    fn a_regular_auth_file_in_the_managed_home_is_replaced_or_removed() {
        let managed = tempfile::tempdir().unwrap();
        let grant = tempfile::tempdir().unwrap();
        let source = grant.path().join("auth.json");
        fs::write(&source, "{}").unwrap();
        // What a `codex login` against the managed home would leave.
        fs::write(managed.path().join("auth.json"), "{\"tokens\":{\"refresh_token\":\"real\"}}").unwrap();
        link_codex_auth(managed.path(), None).unwrap();
        assert!(managed.path().join("auth.json").symlink_metadata().is_err());
        fs::write(managed.path().join("auth.json"), "{\"tokens\":{\"refresh_token\":\"real\"}}").unwrap();
        link_codex_auth(managed.path(), Some(&source)).unwrap();
        #[cfg(unix)]
        assert_eq!(fs::read_link(managed.path().join("auth.json")).unwrap(), source);
    }

    #[test]
    fn a_codex_api_key_is_written_as_an_apikey_auth_file() {
        let dir = tempfile::tempdir().unwrap();
        let server = FakeServer::new();
        server.credential("codex", "cred_x", "connected", 1, 1);
        server.grant("codex", "cred_x", 1, json!({"v": 1, "provider": "codex", "mode": "api-key", "apiKey": "fake-openai", "version": 1}));
        let store = store(Some(dir.path().to_path_buf()));
        let t0 = Instant::now();
        store.sync(&server, t0, NOW).unwrap();
        let auth: Value = serde_json::from_slice(&fs::read(store.codex_auth_file(t0).unwrap()).unwrap()).unwrap();
        assert_eq!(auth, json!({"auth_mode": "apikey", "OPENAI_API_KEY": "fake-openai"}));
    }

    #[test]
    fn a_grant_carrying_a_refresh_token_is_refused_and_written_nowhere() {
        let dir = tempfile::tempdir().unwrap();
        let server = FakeServer::new();
        server.credential("codex", "cred_x", "connected", 1, 1);
        let mut plaintext = codex_chatgpt("fake-access");
        plaintext["refreshToken"] = json!("fake-refresh-SECRET");
        server.grant("codex", "cred_x", 1, plaintext);
        let store = store(Some(dir.path().to_path_buf()));
        let t0 = Instant::now();
        assert!(store.sync(&server, t0, NOW).is_err(), "every grant refused is an error, for backoff");
        assert!(store.agent_env(Provider::Codex, t0).is_empty());
        for entry in walk(dir.path()) {
            let bytes = fs::read(&entry).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("fake-refresh-SECRET"), "{} holds the refresh token", entry.display());
        }
        assert!(!dir.path().join("agent-homes/codex/auth.json").exists());
        assert!(parse_plaintext(br#"{"v":1,"provider":"codex","mode":"api-key","apiKey":"k","version":1,"refresh_token":"r"}"#).is_err());
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    #[test]
    fn grants_that_do_not_bind_to_this_runtime_are_refused() {
        let server = FakeServer::new();
        server.credential("claude", "cred_c", "connected", 3, 1);
        let store = store(None);
        type Edit = Box<dyn Fn(&mut Grant)>;
        let cases: Vec<(&str, Edit)> = vec![
            ("workspace", Box::new(|g: &mut Grant| g.workspace_id = "workspace_other")),
            ("generation", Box::new(|g: &mut Grant| g.generation = GENERATION + 1)),
            ("no lifetime", Box::new(|g: &mut Grant| g.expires_at = g.issued_at)),
            ("lifetime within the skew allowance", Box::new(|g: &mut Grant| g.expires_at = g.issued_at + 20_000)),
            ("issued after it expires", Box::new(|g: &mut Grant| g.issued_at = g.expires_at + 1)),
            ("stale epoch", Box::new(|g: &mut Grant| g.epoch = 2)),
            ("other credential", Box::new(|g: &mut Grant| g.credential_id = "cred_other")),
        ];
        for (name, edit) in cases {
            server.grant("claude", "cred_c", 3, claude_oauth("fake", 1));
            edit(&mut server.grants.borrow_mut()[0]);
            assert!(store.sync(&server, Instant::now(), NOW).is_err(), "{name}: a fully refused fetch is an error");
            assert!(store.agent_env(Provider::Claude, Instant::now()).is_empty(), "{name} must be refused");
        }
        // A grant sealed to another key's thumbprint is refused as well.
        let state = store.state();
        let enrollment = state.enrollment.clone().unwrap();
        let other = GrantKey::generate();
        let header = GrantHeader {
            workspace_id: WORKSPACE.into(),
            provider: "claude".into(),
            credential_id: "cred_c".into(),
            key_thumbprint: other.thumbprint(),
            epoch: 3,
            runtime_generation: GENERATION,
            grant_id: "g".into(),
            issued_at: NOW,
            expires_at: NOW + 10 * 60_000,
        };
        let sealed = seal_with([1; 32], [2; 32], [3; 12], [4; 12], &store.key.public, header, claude_oauth("x", 1).to_string().as_bytes());
        let credentials = HashMap::from([(Provider::Claude, server.credentials.borrow()[0].clone())]);
        assert!(store.accept(&sealed, &credentials, &enrollment, &state.highest_epoch, Instant::now()).is_err());
    }

    #[test]
    fn a_skewed_vm_clock_neither_refuses_grants_nor_hot_loops() {
        let server = FakeServer::new();
        server.credential("claude", "cred_c", "connected", 1, 1);
        server.grant("claude", "cred_c", 1, claude_oauth("fake", 1));
        let t0 = Instant::now();
        for wall in [NOW + 60 * 60_000, NOW - 60 * 60_000] {
            *server.enrolled.borrow_mut() = None;
            let store = store(None);
            // The VM clock is an hour off; the grant is judged by its own
            // lifetime and the next fetch by refreshAfter - issuedAt.
            assert_eq!(store.sync(&server, t0, wall).unwrap(), 5 * MINUTE);
            assert!(!store.agent_env(Provider::Claude, t0).is_empty());
        }
        // A short grant brings the next fetch forward, before it lapses.
        server.grants.borrow_mut()[0].expires_at = NOW + 3 * 60_000;
        *server.enrolled.borrow_mut() = None;
        let store = store(None);
        assert_eq!(store.sync(&server, t0, NOW + 60 * 60_000).unwrap(), 3 * MINUTE - SKEW_ALLOWANCE - EXPIRY_MARGIN);
    }

    #[test]
    fn an_unavailable_credential_is_not_an_error_and_does_not_hot_loop() {
        let server = FakeServer::new();
        server.credential("claude", "cred_c", "unavailable", 1, 1);
        server.credentials.borrow_mut()[0].reason = Some("token-expired".into());
        *server.refresh_after.borrow_mut() = Some(NOW + 30_000);
        let store = store(None);
        let t0 = Instant::now();
        // No grant to read the server's time from: the wall clock decides,
        // and a clock already past refreshAfter waits the fallback.
        assert_eq!(store.sync(&server, t0, NOW).unwrap(), Duration::from_secs(30));
        assert_eq!(store.sync(&server, t0, NOW + 60 * 60_000).unwrap(), FALLBACK_REFRESH);
        assert!(store.sync(&server, t0, NOW + 29_000).unwrap() >= MIN_REFRESH);
        let status = store.status(t0);
        assert_eq!(status["credentials"][0]["state"], "unavailable");
        assert_eq!(status["credentials"][0]["reason"], "token-expired");
        assert!(status["lastError"].is_null());
    }

    #[test]
    fn one_malformed_grant_does_not_cost_the_others() {
        let server = FakeServer::new();
        server.credential("cursor", "cred_u", "connected", 1, 1);
        server.grant("cursor", "cred_u", 1, cursor_key());
        server.raw_grants.borrow_mut().push(json!({"v": 1, "alg": ALG, "header": {"workspaceId": WORKSPACE}, "ciphertext": "SECRET-LOOKING"}));
        server.raw_grants.borrow_mut().push(json!("not even an object"));
        let store = store(None);
        store.sync(&server, Instant::now(), NOW).unwrap();
        assert!(!store.agent_env(Provider::Cursor, Instant::now()).is_empty());
        // And a server that adds fields to the answer is still understood.
        let body = json!({"v": 1, "workspaceId": WORKSPACE, "runtimeGeneration": 7, "keyThumbprint": "t", "refreshAfter": 1, "grants": [], "credentials": [{"provider": "claude", "credentialId": "c", "state": "unavailable", "epoch": 1, "version": 1, "reason": "shared-use-policy", "futureField": true}], "futureField": {}});
        let fetched: Fetched = serde_json::from_value(body).unwrap();
        assert_eq!(fetched.credentials.len(), 1);
    }

    #[test]
    fn an_epoch_lower_than_one_seen_is_a_rollback() {
        let server = FakeServer::new();
        server.credential("claude", "cred_c", "connected", 5, 2);
        server.grant("claude", "cred_c", 5, claude_oauth("fake-new", 2));
        let store = store(None);
        let t0 = Instant::now();
        store.sync(&server, t0, NOW).unwrap();
        assert_eq!(value_of(&store.agent_env(Provider::Claude, t0), CLAUDE_OAUTH_ENV), Some(&Some("fake-new".into())));
        server.credential("claude", "cred_c", "connected", 4, 1);
        server.grant("claude", "cred_c", 4, claude_oauth("fake-old", 1));
        assert!(store.sync(&server, t0, NOW).is_err());
        assert!(store.agent_env(Provider::Claude, t0).is_empty(), "the rolled-back grant is not injected");
    }

    #[test]
    fn enrollment_is_idempotent_and_reenrolls_once_on_key_required() {
        let server = FakeServer::new();
        let store = store(None);
        let t0 = Instant::now();
        store.sync(&server, t0, NOW).unwrap();
        store.sync(&server, t0, NOW).unwrap();
        assert_eq!(*server.enrolls.borrow(), 1, "one enrollment serves every fetch");
        *server.forget_key.borrow_mut() = true;
        *server.generation.borrow_mut() = GENERATION + 1;
        store.sync(&server, t0, NOW).unwrap();
        assert_eq!(*server.enrolls.borrow(), 2);
        assert_eq!(store.status(t0)["runtimeGeneration"], GENERATION + 1);
        server.enroll(&store.key.public_key_b64()).unwrap();
        let other = self::store(None);
        assert!(matches!(other.sync(&server, t0, NOW), Err(GrantCallError::KeyConflict)));
        assert!(other.status(t0)["lastError"].is_string());
    }

    #[test]
    fn a_fenced_runtime_drops_every_grant_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let server = FakeServer::new();
        server.credential("codex", "cred_x", "connected", 1, 1);
        server.grant("codex", "cred_x", 1, codex_chatgpt("fake"));
        server.credential("cursor", "cred_u", "connected", 1, 1);
        server.grant("cursor", "cred_u", 1, cursor_key());
        let store = store(Some(dir.path().to_path_buf()));
        let mut backoff = BACKOFF_START;
        let fill = |store: &GrantStore, backoff: &mut Duration| {
            assert_eq!(step(store, &server, false, backoff), 5 * MINUTE);
            assert!(store.codex_auth_file(Instant::now()).is_some());
            assert!(!store.agent_env(Provider::Cursor, Instant::now()).is_empty());
        };
        let emptied = |store: &GrantStore| {
            let now = Instant::now();
            assert!(store.agent_env(Provider::Cursor, now).is_empty());
            assert!(store.agent_env(Provider::Codex, now).is_empty());
            assert!(!dir.path().join("agent-homes/codex/auth.json").exists());
            assert_eq!(store.status(now)["enrolled"], false);
        };

        // The bootstrap refresh loop saw the credential rejected.
        fill(&store, &mut backoff);
        assert_eq!(step(&store, &server, true, &mut backoff), REJECTED_PAUSE);
        emptied(&store);

        // The grant API itself answers 401.
        fill(&store, &mut backoff);
        *server.reject.borrow_mut() = true;
        assert_eq!(step(&store, &server, false, &mut backoff), BACKOFF_START);
        emptied(&store);
        assert_eq!(step(&store, &server, false, &mut backoff), BACKOFF_START * 2, "errors back off");
        *server.reject.borrow_mut() = false;

        // Another key holds the generation.
        fill(&store, &mut backoff);
        assert_eq!(backoff, BACKOFF_START, "a success resets the backoff");
        *server.enrolled.borrow_mut() = Some(GrantKey::generate().public_key_b64());
        *server.forget_key.borrow_mut() = false;
        store.state().enrollment = None;
        step(&store, &server, false, &mut backoff);
        emptied(&store);
    }

    #[test]
    fn refusing_every_grant_backs_off() {
        let server = FakeServer::new();
        server.credential("claude", "cred_c", "connected", 1, 1);
        server.grant("claude", "cred_c", 1, claude_oauth("fake", 1));
        server.grants.borrow_mut()[0].workspace_id = "workspace_other";
        let store = store(None);
        let mut backoff = BACKOFF_START;
        let waits: Vec<Duration> = (0..4).map(|_| step(&store, &server, false, &mut backoff)).collect();
        assert_eq!(waits, vec![BACKOFF_START, BACKOFF_START * 2, BACKOFF_START * 4, BACKOFF_START * 8]);
    }

    #[test]
    fn a_codex_launch_can_wait_for_the_first_sync() {
        let server = FakeServer::new();
        let store = Arc::new(store(None));
        assert!(!store.wait_first_sync(Duration::from_millis(10)));
        let waiter = {
            let store = store.clone();
            std::thread::spawn(move || store.wait_first_sync(Duration::from_secs(5)))
        };
        store.sync(&server, Instant::now(), NOW).unwrap();
        assert!(waiter.join().unwrap());
        assert!(store.wait_first_sync(Duration::ZERO));
    }

    #[test]
    fn rotation_reaches_new_sessions_and_flags_running_ones() {
        let server = FakeServer::new();
        server.credential("claude", "cred_c", "connected", 1, 1);
        server.grant("claude", "cred_c", 1, claude_oauth("fake-v1", 1));
        let store = store(None);
        let t0 = Instant::now();
        store.sync(&server, t0, NOW).unwrap();
        let first = store.agent_env_for_launch(Provider::Claude, "tab:a", t0);
        assert_eq!(value_of(&first, CLAUDE_OAUTH_ENV), Some(&Some("fake-v1".into())));
        assert_eq!(store.status(t0)["credentials"][0]["restartRequired"], false);

        server.credential("claude", "cred_c", "connected", 2, 2);
        server.grant("claude", "cred_c", 2, claude_oauth("fake-v2", 2));
        store.sync(&server, t0, NOW).unwrap();
        let second = store.agent_env_for_launch(Provider::Claude, "tab:b", t0);
        assert_eq!(value_of(&second, CLAUDE_OAUTH_ENV), Some(&Some("fake-v2".into())));
        let status = store.status(t0);
        assert_eq!(status["credentials"][0]["restartRequired"], true);
        assert_eq!(status["credentials"][0]["restartRequiredSessions"], 1);
        store.forget_launch("tab:a");
        assert_eq!(store.status(t0)["credentials"][0]["restartRequiredSessions"], 0);
    }

    #[test]
    fn disconnected_and_unavailable_credentials_are_dropped() {
        for state in ["disconnected", "unavailable", "revoked"] {
            let server = FakeServer::new();
            server.credential("cursor", "cred_u", "connected", 1, 1);
            server.grant("cursor", "cred_u", 1, cursor_key());
            let store = store(None);
            let t0 = Instant::now();
            store.sync(&server, t0, NOW).unwrap();
            assert!(!store.agent_env(Provider::Cursor, t0).is_empty());
            server.credential("cursor", "cred_u", state, 1, 1);
            server.grants.borrow_mut().clear();
            store.sync(&server, t0, NOW).unwrap();
            assert!(store.agent_env(Provider::Cursor, t0).is_empty(), "{state} is not injected");
            assert_eq!(store.status(t0)["credentials"][0]["state"], state);
        }
        // A connected credential the server sent no grant for is dropped too.
        let server = FakeServer::new();
        server.credential("cursor", "cred_u", "connected", 1, 1);
        server.grant("cursor", "cred_u", 1, cursor_key());
        let store = store(None);
        let t0 = Instant::now();
        store.sync(&server, t0, NOW).unwrap();
        server.grants.borrow_mut().clear();
        store.sync(&server, t0, NOW).unwrap();
        assert!(store.agent_env(Provider::Cursor, t0).is_empty());
    }

    #[test]
    fn unknown_modes_and_providers_are_ignored() {
        assert!(parse_plaintext(br#"{"v":1,"provider":"claude","mode":"telepathy","version":1}"#).unwrap().is_none());
        assert!(parse_plaintext(br#"{"v":1,"provider":"gemini","mode":"api-key","apiKey":"k","version":1}"#).unwrap().is_none());
        assert!(parse_plaintext(br#"{"v":1,"provider":"claude","mode":"api-key","version":1}"#).is_err(), "a missing key is an error");
    }

    #[test]
    fn expired_grants_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let server = FakeServer::new();
        server.credential("codex", "cred_x", "connected", 1, 1);
        server.grant("codex", "cred_x", 1, codex_chatgpt("fake"));
        let store = store(Some(dir.path().to_path_buf()));
        let t0 = Instant::now();
        store.sync(&server, t0, NOW).unwrap();
        let path = store.codex_auth_file(t0).unwrap();
        store.prune(t0 + 16 * MINUTE);
        assert!(!path.exists());
        assert!(store.codex_auth_file(t0).is_none());
    }

    #[test]
    fn the_grant_directory_prefers_the_override_then_shm_then_xdg() {
        let shm = tempfile::tempdir().unwrap();
        let roots = candidate_roots(Some("/run/grants"), shm.path(), Some("/run/user/1000"), 1000);
        assert_eq!(roots, vec![PathBuf::from("/run/grants"), shm.path().join("terminalx-1000"), PathBuf::from("/run/user/1000/terminalx")]);
        assert_eq!(candidate_roots(None, Path::new("/nonexistent-shm"), None, 1), Vec::<PathBuf>::new());
        assert_eq!(candidate_roots(Some(" "), Path::new("/nonexistent-shm"), Some("/x"), 1), vec![PathBuf::from("/x/terminalx")]);
    }

    #[cfg(unix)]
    #[test]
    fn each_workspace_gets_a_private_directory_and_keeps_its_key_across_a_restart() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("grants");
        // The first usable candidate wins; a file in the way is skipped.
        let blocked = dir.path().join("blocked");
        fs::write(&blocked, "").unwrap();
        let root = select_root(vec![blocked, base.clone()], WORKSPACE).unwrap();
        assert_eq!(root.parent(), Some(base.as_path()));
        assert_eq!(select_root(vec![base.clone()], WORKSPACE), Some(root.clone()), "a restart finds the same directory");
        let other = select_root(vec![base.clone()], "workspace_other").unwrap();
        assert_ne!(other, root, "two workspaces never share a directory");
        for dir in [&base, &root, &other] {
            assert_eq!(fs::metadata(dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let first = load_or_create_key(Some(&root));
        assert_eq!(fs::metadata(root.join(KEY_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        let second = load_or_create_key(Some(&root));
        assert_eq!(first.thumbprint(), second.thumbprint(), "a restart enrolls the same key");
        assert_ne!(load_or_create_key(Some(&other)).thumbprint(), first.thumbprint());
        assert_ne!(load_or_create_key(None).thumbprint(), first.thumbprint());
        // A symlink planted where the directory should be is refused.
        let planted = dir.path().join("planted");
        std::os::unix::fs::symlink(dir.path(), &planted).unwrap();
        assert!(prepare_private_dir(&planted).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_private_write_never_follows_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("elsewhere");
        fs::write(&target, "untouched").unwrap();
        let path = dir.path().join("auth.json");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        write_private(&path, b"new").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "untouched", "the rename replaces the link, not what it points at");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_file());
    }

    #[test]
    fn the_unset_prefix_runs_after_the_profile() {
        assert_eq!(unset_prefix("claude --resume x", &[]), "claude --resume x");
        if cfg!(unix) {
            assert_eq!(unset_prefix("claude", &["A".into(), "B".into()]), "env -u A -u B claude");
        }
        assert_eq!(provider_of_harness("cursor-agent"), Some(Provider::Cursor));
        assert_eq!(provider_of_harness("opencode"), None);
    }
}
