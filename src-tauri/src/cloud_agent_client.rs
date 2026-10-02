//! The desktop half of the cloud agent command mailbox and transcript
//! checkpoints (PRO-22, `docs/CLOUD-AGENT-TABS.md`; terminalx-saas contract
//! §11-13).
//!
//! - **Keys.** Workspace content keys arrive over the relay E2EE channel
//!   (`keys.get`, called by `cloud_remote` itself) and are kept in the OS
//!   keychain. The web view never sees them. A non-secret index names the
//!   known key ids and the current one.
//! - **Outbox.** A command is encrypted once. Its envelope is written durably
//!   before the first POST and resent byte for byte until the API has it, so
//!   a lost response never becomes a second command.
//! - **Checkpoints.** Fetched only when newer, verified (sha256, AES-GCM with
//!   the bound metadata), inflated under a limit and handed to the UI.
//! - **Cache.** The UI's per-tab cache (ordered events, cursor, unread), kept
//!   in the store rather than in web storage.
//!
//! Everything lives under `<store root>/cloud-agent/<user>/<organization>/<workspace>/`
//! and is dropped when the signed-in identity changes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;
use zeroize::Zeroizing;

use crate::cloud_agents::crypto;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A checkpoint is at most 1 MiB decoded, so about 1.4 MiB of base64url.
const RESPONSE_LIMIT: u64 = 4 * 1024 * 1024;
const CHECKPOINT_INFLATE_LIMIT: usize = 8 * 1024 * 1024;
const CACHE_ENTRY_LIMIT: usize = 4 * 1024 * 1024;
const CACHE_TOTAL_LIMIT: usize = 32 * 1024 * 1024;
const SETTLED_KEPT_PER_TAB: usize = 20;
const STATUS_BATCH: usize = 100;
const KINDS: [&str; 4] = ["send", "steer", "stop", "permission-decision"];
const TERMINAL_STATES: [&str; 4] = ["applied", "rejected", "cancelled", "outcome-unknown"];

/// The signed-in user and the Organizations whose cloud agent data is kept.
pub type KeptIdentity = (String, BTreeSet<String>);

/// The account a call is made for.
#[derive(Clone)]
pub struct Ctx {
    pub user_id: String,
    pub organization_id: String,
    pub access_token: Zeroizing<String>,
}

pub trait AccountSource: Send + Sync {
    /// The account for a call in `organization_id`: the active Organization,
    /// or (CS-18) any member Organization on a server that authorizes desktop
    /// cloud routes by membership. Errors are `account_signed_out` or
    /// `cloud_remote_organization_mismatch`.
    fn context_in(&self, organization_id: &str) -> Result<Ctx, String>;

    /// Whether `user_id` may still write in `organization_id`, checked right
    /// before a write so a call that began before a membership loss or a user
    /// change never recreates what was purged. Must not block on the network.
    fn still_allowed(&self, user_id: &str, organization_id: &str) -> bool {
        self.context_in(organization_id).is_ok_and(|ctx| ctx.user_id == user_id)
    }
}

impl AccountSource for crate::account::AccountManager {
    fn context_in(&self, organization_id: &str) -> Result<Ctx, String> {
        let (context, _) = crate::account::AccountManager::context_in(self, organization_id).map_err(|code| {
            if code == "account_signed_out" { code.to_string() } else { "cloud_remote_organization_mismatch".to_string() }
        })?;
        Ok(Ctx { user_id: context.user_id, organization_id: context.organization_id, access_token: Zeroizing::new(context.access_token) })
    }

    fn still_allowed(&self, user_id: &str, organization_id: &str) -> bool {
        self.current_scope().is_some_and(|scope| scope.user_id == user_id && scope.allows(organization_id))
    }
}

/// Workspace content keys, by `(organization, workspace, keyId)`.
pub trait KeyStore: Send + Sync {
    fn put(&self, organization_id: &str, workspace_id: &str, key_id: &str, key: &[u8; crypto::KEY_LEN]) -> Result<()>;
    fn get(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<Option<[u8; crypto::KEY_LEN]>>;
    fn delete(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<()>;
    /// Drop whatever is held in memory (the identity changed). Stored keys stay.
    fn forget(&self) {}
}

/// macOS keychain generic passwords under `<app identifier>.cloud-agent-keys`.
#[derive(Default)]
pub struct KeychainKeys {
    service: OnceLock<String>,
}

/// The Keychain service workspace keys are kept under. A debug build that was
/// given its own service (`RACCOON_DEV_KEYCHAIN_SERVICE`, as the account
/// session uses) keeps its keys under that one: two development instances on
/// one Mac otherwise share `<app identifier>.cloud-agent-keys`, and each
/// overwrites or deletes the other's keys for the same workspace. Release
/// builds never have a development service.
fn key_service_name(app_identifier: &str, dev_service: Option<&str>) -> String {
    format!("{}.cloud-agent-keys", dev_service.unwrap_or(app_identifier))
}

impl KeychainKeys {
    pub fn configure(&self, app_identifier: &str) {
        let _ = self.service.set(key_service_name(app_identifier, crate::account::dev_keychain_service().as_deref()));
    }

    #[cfg(target_os = "macos")]
    fn service(&self) -> Result<&str> {
        self.service.get().map(String::as_str).ok_or_else(|| anyhow!("the key store is not configured"))
    }
}

fn key_account(organization_id: &str, workspace_id: &str, key_id: &str) -> String {
    format!("{organization_id}/{workspace_id}/{key_id}")
}

// Through `crate::keychain`, which makes Keychain calls one at a time.
#[cfg(target_os = "macos")]
impl KeyStore for KeychainKeys {
    fn put(&self, organization_id: &str, workspace_id: &str, key_id: &str, key: &[u8; crypto::KEY_LEN]) -> Result<()> {
        crate::keychain::set(self.service()?, &key_account(organization_id, workspace_id, key_id), key).context("save a workspace key to Keychain")
    }

    fn get(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<Option<[u8; crypto::KEY_LEN]>> {
        let Some(bytes) = crate::keychain::get(self.service()?, &key_account(organization_id, workspace_id, key_id)).context("read a workspace key from Keychain")? else {
            return Ok(None);
        };
        let bytes = Zeroizing::new(bytes);
        Ok(Some(bytes.as_slice().try_into().map_err(|_| anyhow!("a stored workspace key is not 32 bytes"))?))
    }

    fn delete(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<()> {
        crate::keychain::delete(self.service()?, &key_account(organization_id, workspace_id, key_id)).context("delete a workspace key from Keychain")
    }
}

/// Elsewhere: a 0600 file per workspace next to the index.
#[cfg(not(target_os = "macos"))]
impl KeyStore for KeychainKeys {
    fn put(&self, organization_id: &str, workspace_id: &str, key_id: &str, key: &[u8; crypto::KEY_LEN]) -> Result<()> {
        let path = secret_file(organization_id, workspace_id)?;
        let mut keys: BTreeMap<String, String> = read_json(&path)?.unwrap_or_default();
        keys.insert(key_id.to_string(), crypto::b64(key));
        write_atomic(&path, &serde_json::to_vec(&keys)?)
    }

    fn get(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<Option<[u8; crypto::KEY_LEN]>> {
        let keys: BTreeMap<String, String> = read_json(&secret_file(organization_id, workspace_id)?)?.unwrap_or_default();
        keys.get(key_id).map(|key| crypto::key_from_b64(key)).transpose()
    }

    fn delete(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<()> {
        let path = secret_file(organization_id, workspace_id)?;
        let mut keys: BTreeMap<String, String> = read_json(&path)?.unwrap_or_default();
        if keys.remove(key_id).is_some() {
            write_atomic(&path, &serde_json::to_vec(&keys)?)?;
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn secret_file(organization_id: &str, workspace_id: &str) -> Result<PathBuf> {
    let dir = crate::store::root()?.join("cloud-agent-keys");
    crate::cloud_bootstrap::ensure_private_dir(&dir)?;
    Ok(dir.join(format!("{organization_id}--{workspace_id}.json")))
}

/// A [`KeyStore`] in front of another that remembers, in this process's
/// memory, each key it stored or read.
///
/// A send, a checkpoint and a receipt each need the workspace key, and every
/// connect is answered (`keys.get`) with keys this Mac nearly always has
/// already. Without this each of those is a Keychain call, several at once
/// after a wake; with it a key is read from the Keychain once per run and
/// written only when it is new or changed.
///
/// Nothing about where keys are kept changes: the Keychain stays the only
/// place a key is stored, and a key already crosses this process's memory
/// each time it is used (it arrives over the relay channel and is handed to
/// AES-GCM here). The copies held are zeroed when dropped; a key's copy is
/// dropped when the key is deleted, and all of them when the identity changes.
pub struct CachedKeys {
    store: Arc<dyn KeyStore>,
    held: Mutex<Held>,
}

#[derive(Default)]
struct Held {
    keys: HashMap<String, Zeroizing<[u8; crypto::KEY_LEN]>>,
    /// Counts puts, deletes and forgets, so a read that was under way during
    /// one does not keep what it read.
    changes: u64,
}

impl CachedKeys {
    pub fn new(store: Arc<dyn KeyStore>) -> Self {
        Self { store, held: Mutex::new(Held::default()) }
    }

    /// Drop the held copy before the stored key changes. Never held across a
    /// call to the store.
    fn invalidate(&self, account: &str) -> u64 {
        let mut held = self.held.lock().unwrap();
        held.keys.remove(account);
        held.changes = held.changes.wrapping_add(1);
        held.changes
    }

    fn keep(&self, account: String, key: &[u8; crypto::KEY_LEN], as_of: u64) {
        let mut held = self.held.lock().unwrap();
        if held.changes == as_of {
            held.keys.insert(account, Zeroizing::new(*key));
        }
    }
}

impl KeyStore for CachedKeys {
    fn put(&self, organization_id: &str, workspace_id: &str, key_id: &str, key: &[u8; crypto::KEY_LEN]) -> Result<()> {
        use subtle::ConstantTimeEq;
        let account = key_account(organization_id, workspace_id, key_id);
        if self.held.lock().unwrap().keys.get(&account).is_some_and(|held| bool::from(held.as_slice().ct_eq(key.as_slice()))) {
            return Ok(());
        }
        let as_of = self.invalidate(&account);
        self.store.put(organization_id, workspace_id, key_id, key)?;
        self.keep(account, key, as_of);
        Ok(())
    }

    fn get(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<Option<[u8; crypto::KEY_LEN]>> {
        let account = key_account(organization_id, workspace_id, key_id);
        let as_of = {
            let held = self.held.lock().unwrap();
            if let Some(key) = held.keys.get(&account) {
                return Ok(Some(**key));
            }
            held.changes
        };
        let found = self.store.get(organization_id, workspace_id, key_id)?;
        if let Some(key) = &found {
            self.keep(account, key, as_of);
        }
        Ok(found)
    }

    fn delete(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<()> {
        self.invalidate(&key_account(organization_id, workspace_id, key_id));
        self.store.delete(organization_id, workspace_id, key_id)
    }

    fn forget(&self) {
        let mut held = self.held.lock().unwrap();
        held.keys.clear();
        held.changes = held.changes.wrapping_add(1);
        drop(held);
        self.store.forget();
    }
}

/// For tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryKeys(Mutex<HashMap<String, [u8; crypto::KEY_LEN]>>);

#[cfg(test)]
impl KeyStore for MemoryKeys {
    fn put(&self, organization_id: &str, workspace_id: &str, key_id: &str, key: &[u8; crypto::KEY_LEN]) -> Result<()> {
        self.0.lock().unwrap().insert(key_account(organization_id, workspace_id, key_id), *key);
        Ok(())
    }
    fn get(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<Option<[u8; crypto::KEY_LEN]>> {
        Ok(self.0.lock().unwrap().get(&key_account(organization_id, workspace_id, key_id)).copied())
    }
    fn delete(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<()> {
        self.0.lock().unwrap().remove(&key_account(organization_id, workspace_id, key_id));
        Ok(())
    }
}

/// Which keys a workspace has and which one encrypts new commands. No secrets.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyIndex {
    current_key_id: Option<String>,
    keys: Vec<KeyMeta>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyMeta {
    key_id: String,
    #[serde(default)]
    created_at: Option<Value>,
    #[serde(default)]
    retired_at: Option<Value>,
}

/// An outbox entry as stored: the exact envelope plus what is known of it.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    client_command_id: String,
    tab_id: String,
    kind: String,
    key_id: String,
    iv: String,
    ciphertext: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    state: String,
    #[serde(default)]
    wake: Option<String>,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    receipt: Option<Value>,
    #[serde(default)]
    sequence: Option<u64>,
    created_at: u64,
    updated_at: u64,
    #[serde(default)]
    error: Option<String>,
}

impl Stored {
    fn envelope(&self) -> Value {
        json!({
            "v": 1,
            "clientCommandId": self.client_command_id,
            "tabId": self.tab_id,
            "kind": self.kind,
            "keyId": self.key_id,
            "iv": self.iv,
            "ciphertext": self.ciphertext,
        })
    }

    fn pending(&self) -> bool {
        !TERMINAL_STATES.contains(&self.state.as_str())
    }

    fn view(&self) -> OutboxEntry {
        OutboxEntry {
            client_command_id: self.client_command_id.clone(),
            tab_id: self.tab_id.clone(),
            kind: self.kind.clone(),
            text: self.text.clone(),
            request_id: self.request_id.clone(),
            state: self.state.clone(),
            wake: self.wake.clone(),
            outcome: self.outcome.clone(),
            category: self.category.clone(),
            receipt: self.receipt.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            error: self.error.clone(),
        }
    }
}

/// What `purge_workspace` removed.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Purged {
    pub removed: bool,
    /// Commands that never reached the runtime.
    pub unsent_commands: usize,
    pub cached_tabs: usize,
}

/// What the UI sees of an outbox entry: never the envelope.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEntry {
    pub client_command_id: String,
    pub tab_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// `unsent`, or the server's `queued | leased | applied | rejected | cancelled | outcome-unknown`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake: Option<String>,
    /// The runtime's receipt outcome, once decrypted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Value>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub epoch: u64,
    pub version: u64,
    pub schema_version: u64,
    pub projection: Value,
}

/// The server's `command` object, as far as the outbox reads it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerCommand {
    client_command_id: String,
    state: String,
    #[serde(default)]
    sequence: Option<u64>,
    #[serde(default)]
    outcome_category: Option<String>,
    #[serde(default)]
    result_iv: Option<String>,
    #[serde(default)]
    result_ciphertext: Option<String>,
}

enum Reply {
    Ok(Value),
    /// An HTTP error with the API's `{ "error": code }`.
    Refused(u16, String),
    /// No answer: the request may or may not have arrived.
    Unreachable,
}

fn valid_id(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

use crate::cloud_agents::now_ms;

/// Whether an HTTP refusal is worth retrying with the same envelope: the API
/// may simply not have taken it yet. Everything else is final.
fn retryable(status: u16, code: &str) -> bool {
    match status {
        401 | 408 | 425 => true,
        // A full mailbox is a definite answer; other 429s are rate limits.
        429 => code != "cloud_workspace_agent_mailbox_full",
        _ => status >= 500,
    }
}

pub struct CloudAgentClient {
    accounts: Arc<dyn AccountSource>,
    keys: Arc<dyn KeyStore>,
    base: Url,
    root: PathBuf,
    /// Serializes every read-modify-write of the stored files.
    lock: Mutex<()>,
    /// Per workspace directory: held across "is it still unsent?" and its
    /// POST, and across a cancel, so a cancelled command is never posted.
    send_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    agent: ureq::Agent,
    /// The identity last observed (the user and the Organizations whose data
    /// is kept), so a change drops what no longer belongs to it.
    observed: Mutex<Option<KeptIdentity>>,
}

impl CloudAgentClient {
    pub fn new(accounts: Arc<dyn AccountSource>, keys: Arc<dyn KeyStore>) -> Result<Self> {
        let base = Url::parse(&crate::account::api_base_url()).context("account service URL")?;
        Ok(Self::with(accounts, keys, base, crate::store::root()?.join("cloud-agent")))
    }

    pub fn with(accounts: Arc<dyn AccountSource>, keys: Arc<dyn KeyStore>, base: Url, root: PathBuf) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).redirects(0).build();
        Self { accounts, keys, base, root, lock: Mutex::new(()), send_locks: Mutex::new(HashMap::new()), agent, observed: Mutex::new(None) }
    }

    /// The current account, allowed in `organization_id` (CS-18: by
    /// membership when the server supports it, else the active Organization).
    fn ctx(&self, organization_id: &str) -> Result<Ctx, String> {
        if organization_id.is_empty() {
            return Err("cloud_remote_organization_mismatch".into());
        }
        let ctx = self.accounts.context_in(organization_id)?;
        if ctx.organization_id != organization_id {
            return Err("cloud_remote_organization_mismatch".into());
        }
        Ok(ctx)
    }

    /// Whether a workspace directory (`<root>/<user>/<org>/<workspace>`) still
    /// belongs to the signed-in user and a reachable organization. Checked
    /// under `self.lock` right before a write, the lock a purge holds.
    fn writable(&self, dir: &Path) -> bool {
        let Ok(relative) = dir.strip_prefix(&self.root) else { return false };
        let mut parts = relative.components().map(|part| part.as_os_str().to_string_lossy().into_owned());
        match (parts.next(), parts.next()) {
            (Some(user), Some(org)) => self.accounts.still_allowed(&user, &org),
            _ => false,
        }
    }

    fn send_lock(&self, dir: &Path) -> Arc<Mutex<()>> {
        self.send_locks.lock().unwrap().entry(dir.to_path_buf()).or_default().clone()
    }

    fn dir(&self, ctx: &Ctx, workspace_id: &str) -> Result<PathBuf, String> {
        if !valid_id(workspace_id) || !valid_id(&ctx.user_id) || !valid_id(&ctx.organization_id) {
            return Err("cloud_agent_request_invalid".into());
        }
        Ok(self.root.join(&ctx.user_id).join(&ctx.organization_id).join(workspace_id))
    }

    // ------------------------------------------------------------ keys

    /// Store what `keys.get` answered for a workspace. Called by
    /// `cloud_remote` for the identity the connection was made for.
    pub fn store_keys(&self, user_id: &str, organization_id: &str, workspace_id: &str, result: &Value) -> Result<()> {
        let current = self.accounts.context_in(organization_id).map_err(|_| anyhow!("the identity changed before the keys arrived"))?;
        if current.user_id != user_id || current.organization_id != organization_id {
            return Err(anyhow!("the identity changed before the keys arrived"));
        }
        let dir = self.dir(&current, workspace_id).map_err(anyhow::Error::msg)?;
        // Held from the first key written: a purge (which takes the same lock)
        // runs wholly before or after, and after it nothing is written back.
        let _guard = self.lock.lock().unwrap();
        if !self.writable(&dir) {
            return Err(anyhow!("the identity changed before the keys arrived"));
        }
        let current_key_id = result.get("currentKeyId").and_then(Value::as_str).filter(|id| valid_id(id)).map(str::to_string);
        let mut metas = Vec::new();
        for key in result.get("keys").and_then(Value::as_array).into_iter().flatten() {
            let key_id = key.get("keyId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or_else(|| anyhow!("a key has no valid keyId"))?;
            let bytes = Zeroizing::new(crypto::key_from_b64(key.get("key").and_then(Value::as_str).unwrap_or_default())?);
            self.keys.put(organization_id, workspace_id, key_id, &bytes)?;
            metas.push(KeyMeta { key_id: key_id.to_string(), created_at: key.get("createdAt").cloned(), retired_at: key.get("retiredAt").cloned() });
        }
        if current_key_id.as_ref().is_some_and(|id| !metas.iter().any(|meta| &meta.key_id == id)) {
            return Err(anyhow!("currentKeyId is not among the keys"));
        }
        let path = dir.join("keys.json");
        let mut index: KeyIndex = read_json(&path)?.unwrap_or_default();
        // Keys the runtime no longer lists are forgotten, secret included.
        for old in &index.keys {
            if !metas.iter().any(|meta| meta.key_id == old.key_id) {
                let _ = self.keys.delete(organization_id, workspace_id, &old.key_id);
            }
        }
        index.keys = metas;
        index.current_key_id = current_key_id;
        write_atomic(&path, &serde_json::to_vec(&index)?)
    }

    fn index(&self, dir: &Path) -> Result<KeyIndex, String> {
        read_json(&dir.join("keys.json")).map_err(|_| "cloud_agent_store_unreadable".to_string()).map(Option::unwrap_or_default)
    }

    fn key(&self, organization_id: &str, workspace_id: &str, key_id: &str) -> Result<[u8; crypto::KEY_LEN], String> {
        match self.keys.get(organization_id, workspace_id, key_id) {
            Ok(Some(key)) => Ok(key),
            Ok(None) => Err("cloud_agent_key_missing".into()),
            Err(error) => {
                log::warn!("read workspace key: {error:#}");
                Err("cloud_agent_key_store_unavailable".into())
            }
        }
    }

    pub fn has_key(&self, organization_id: &str, workspace_id: &str) -> Result<bool, String> {
        let ctx = self.ctx(organization_id)?;
        let dir = self.dir(&ctx, workspace_id)?;
        let Some(current) = self.index(&dir)?.current_key_id else { return Ok(false) };
        // A store that cannot be read is not "no key": connecting again would not help.
        match self.key(organization_id, workspace_id, &current).map(Zeroizing::new) {
            Ok(_) => Ok(true),
            Err(code) if code == "cloud_agent_key_missing" => Ok(false),
            Err(code) => Err(code),
        }
    }

    // ------------------------------------------------------------ outbox

    fn load_outbox(&self, dir: &Path) -> Result<Vec<Stored>, String> {
        read_json(&dir.join("outbox.json")).map_err(|_| "cloud_agent_store_unreadable".to_string()).map(Option::unwrap_or_default)
    }

    /// Callers hold `self.lock`.
    fn save_outbox(&self, dir: &Path, entries: &[Stored]) -> Result<(), String> {
        if !self.writable(dir) {
            return Err("cloud_remote_organization_mismatch".into());
        }
        let bytes = serde_json::to_vec(entries).map_err(|_| "cloud_agent_store_unwritable".to_string())?;
        write_atomic(&dir.join("outbox.json"), &bytes).map_err(|error| {
            log::warn!("write the cloud agent outbox: {error:#}");
            "cloud_agent_store_unwritable".to_string()
        })
    }

    /// Update stored entries under the lock.
    fn edit_outbox<R>(&self, dir: &Path, edit: impl FnOnce(&mut Vec<Stored>) -> R) -> Result<R, String> {
        let _guard = self.lock.lock().unwrap();
        let mut entries = self.load_outbox(dir)?;
        let result = edit(&mut entries);
        prune(&mut entries);
        self.save_outbox(dir, &entries)?;
        Ok(result)
    }

    /// Encrypt a command, store its envelope, then hand it to the API. A
    /// command the API could not be asked about stays `unsent` and is resent
    /// by `outbox_sync`; it is never re-encrypted.
    pub fn enqueue(&self, organization_id: &str, workspace_id: &str, tab_id: &str, kind: &str, payload: Value) -> Result<OutboxEntry, String> {
        let ctx = self.ctx(organization_id)?;
        let dir = self.dir(&ctx, workspace_id)?;
        if !valid_id(tab_id) || !KINDS.contains(&kind) {
            return Err("cloud_agent_request_invalid".into());
        }
        let Value::Object(mut plaintext) = payload else { return Err("cloud_agent_request_invalid".into()) };
        let text = plaintext.get("text").and_then(Value::as_str).map(str::to_string);
        let request_id = plaintext.get("requestId").and_then(Value::as_str).map(str::to_string);
        let valid = match kind {
            "send" | "steer" => text.as_deref().is_some_and(|text| !text.trim().is_empty()),
            "permission-decision" => {
                request_id.as_deref().is_some_and(|id| !id.is_empty())
                    && (plaintext.get("optionId").is_some_and(Value::is_string) || plaintext.get("answers").is_some_and(Value::is_object))
            }
            _ => true,
        };
        if !valid {
            return Err("cloud_agent_request_invalid".into());
        }
        plaintext.insert("v".into(), json!(1));
        let key_id = self.index(&dir)?.current_key_id.ok_or("cloud_agent_key_missing")?;
        let key = Zeroizing::new(self.key(organization_id, workspace_id, &key_id)?);
        let client_command_id = uuid::Uuid::new_v4().to_string();
        let aad = crypto::command_aad(organization_id, workspace_id, tab_id, &client_command_id, kind, &key_id);
        let bytes = Zeroizing::new(serde_json::to_vec(&Value::Object(plaintext)).map_err(|_| "cloud_agent_request_invalid".to_string())?);
        let (iv, ciphertext) = crypto::seal(&key, &bytes, &aad).map_err(|_| "cloud_agent_encrypt_failed".to_string())?;
        if ciphertext.len() > crypto::MAX_COMMAND_CIPHERTEXT {
            return Err("cloud_agent_command_too_large".into());
        }
        let now = now_ms();
        let stored = Stored {
            client_command_id: client_command_id.clone(),
            tab_id: tab_id.to_string(),
            kind: kind.to_string(),
            key_id,
            iv,
            ciphertext,
            text,
            request_id,
            state: "unsent".into(),
            wake: None,
            outcome: None,
            category: None,
            receipt: None,
            sequence: None,
            created_at: now,
            updated_at: now,
            error: None,
        };
        // Durable before the network: a crash after the POST still resends it.
        self.edit_outbox(&dir, |entries| entries.push(stored.clone()))?;
        self.post_envelope(&ctx, workspace_id, &dir, &stored.client_command_id)?.ok_or_else(|| "cloud_agent_command_unknown".into())
    }

    /// POST a stored envelope if it is still unsent. `None` when it is not
    /// (sent meanwhile, or cancelled).
    fn post_envelope(&self, ctx: &Ctx, workspace_id: &str, dir: &Path, client_command_id: &str) -> Result<Option<OutboxEntry>, String> {
        let send_lock = self.send_lock(dir);
        let _sending = send_lock.lock().unwrap();
        let stored = {
            let _guard = self.lock.lock().unwrap();
            self.load_outbox(dir)?.into_iter().find(|entry| entry.client_command_id == client_command_id)
        };
        let Some(stored) = stored.filter(|entry| entry.state == "unsent") else { return Ok(None) };
        let reply = self.call(ctx, "POST", workspace_id, &["agent-commands"], &[], Some(&stored.envelope()));
        let id = stored.client_command_id.clone();
        self.edit_outbox(dir, |entries| {
            let entry = entries.iter_mut().find(|entry| entry.client_command_id == id)?;
            entry.updated_at = now_ms();
            match reply {
                Reply::Ok(body) => {
                    entry.error = None;
                    entry.wake = body.get("wake").and_then(Value::as_str).map(str::to_string);
                    if let Some(command) = body.get("command").cloned().and_then(|c| serde_json::from_value::<ServerCommand>(c).ok()) {
                        self.apply_server(&ctx.organization_id, workspace_id, dir, entry, command);
                    } else {
                        entry.state = "queued".into();
                    }
                }
                // Kept unsent: nothing proves the API has or lacks it.
                Reply::Unreachable => entry.error = Some("cloud_agent_command_pending_retry".into()),
                Reply::Refused(status, code) if retryable(status, &code) => entry.error = Some(code),
                // The API refused it for good and stored nothing (or stored
                // another payload under this id): it will never run.
                Reply::Refused(_, code) => {
                    entry.state = "rejected".into();
                    entry.category = Some(code.clone());
                    entry.error = Some(code);
                }
            }
            Some(entry.view())
        })
    }

    fn apply_server(&self, organization_id: &str, workspace_id: &str, dir: &Path, entry: &mut Stored, command: ServerCommand) {
        if command.client_command_id != entry.client_command_id {
            return;
        }
        entry.state = command.state;
        entry.sequence = command.sequence.or(entry.sequence);
        if command.outcome_category.is_some() {
            entry.category = command.outcome_category;
        }
        if let (Some(iv), Some(ciphertext)) = (command.result_iv.filter(|v| !v.is_empty()), command.result_ciphertext.filter(|v| !v.is_empty())) {
            if entry.receipt.is_none() {
                entry.receipt = self.open_receipt(organization_id, workspace_id, dir, entry, &iv, &ciphertext);
                entry.outcome = entry.receipt.as_ref().and_then(|r| r.get("outcome")).and_then(Value::as_str).map(str::to_string);
            }
        }
    }

    /// The receipt names its outcome and key only inside its AAD, so each
    /// outcome and known key (the command's own first) is tried.
    fn open_receipt(&self, organization_id: &str, workspace_id: &str, dir: &Path, entry: &Stored, iv: &str, ciphertext: &str) -> Option<Value> {
        let mut key_ids = vec![entry.key_id.clone()];
        for meta in read_json::<KeyIndex>(&dir.join("keys.json")).ok().flatten().unwrap_or_default().keys {
            if !key_ids.contains(&meta.key_id) {
                key_ids.push(meta.key_id);
            }
        }
        for key_id in key_ids {
            let Ok(Some(key)) = self.keys.get(organization_id, workspace_id, &key_id) else { continue };
            let key = Zeroizing::new(key);
            for outcome in ["applied", "rejected", "outcome-unknown"] {
                let aad = crypto::receipt_aad(organization_id, workspace_id, &entry.client_command_id, outcome, &key_id);
                if let Ok(bytes) = crypto::open(&key, iv, ciphertext, &aad) {
                    let mut receipt = crypto::parse_v1(&bytes).ok()?;
                    receipt["outcome"] = json!(outcome);
                    return Some(receipt);
                }
            }
        }
        None
    }

    /// Resend what the API has not confirmed, then refresh every pending
    /// entry's state.
    pub fn outbox_sync(&self, organization_id: &str, workspace_id: &str) -> Result<Vec<OutboxEntry>, String> {
        let ctx = self.ctx(organization_id)?;
        let dir = self.dir(&ctx, workspace_id)?;
        let unsent: Vec<Stored> = {
            let _guard = self.lock.lock().unwrap();
            self.load_outbox(&dir)?.into_iter().filter(|entry| entry.state == "unsent").collect()
        };
        for entry in &unsent {
            self.post_envelope(&ctx, workspace_id, &dir, &entry.client_command_id)?;
        }
        let pending: Vec<String> = {
            let _guard = self.lock.lock().unwrap();
            self.load_outbox(&dir)?.into_iter().filter(|entry| entry.pending() && entry.state != "unsent").map(|entry| entry.client_command_id).collect()
        };
        for batch in pending.chunks(STATUS_BATCH) {
            let body = json!({ "v": 1, "clientCommandIds": batch });
            match self.call(&ctx, "POST", workspace_id, &["agent-commands", "status"], &[], Some(&body)) {
                Reply::Ok(body) => {
                    let commands: Vec<ServerCommand> =
                        body.get("commands").cloned().and_then(|c| serde_json::from_value(c).ok()).unwrap_or_default();
                    self.edit_outbox(&dir, |entries| {
                        for command in commands {
                            if let Some(entry) = entries.iter_mut().find(|entry| entry.client_command_id == command.client_command_id) {
                                entry.updated_at = now_ms();
                                entry.error = None;
                                self.apply_server(organization_id, workspace_id, &dir, entry, command);
                            }
                        }
                    })?;
                }
                Reply::Unreachable => return Err("cloud_workspace_unavailable".into()),
                Reply::Refused(_, code) => return Err(code),
            }
        }
        self.outbox(organization_id, workspace_id, None)
    }

    /// Pending entries first (oldest first), then settled ones, newest first.
    pub fn outbox(&self, organization_id: &str, workspace_id: &str, tab_id: Option<&str>) -> Result<Vec<OutboxEntry>, String> {
        let ctx = self.ctx(organization_id)?;
        let dir = self.dir(&ctx, workspace_id)?;
        let _guard = self.lock.lock().unwrap();
        let mut entries: Vec<Stored> = self.load_outbox(&dir)?.into_iter().filter(|entry| tab_id.is_none_or(|tab| entry.tab_id == tab)).collect();
        entries.sort_by_key(|entry| (!entry.pending(), if entry.pending() { entry.created_at as i64 } else { -(entry.updated_at as i64) }));
        Ok(entries.iter().map(Stored::view).collect())
    }

    pub fn cancel(&self, organization_id: &str, workspace_id: &str, client_command_id: &str) -> Result<OutboxEntry, String> {
        let ctx = self.ctx(organization_id)?;
        let dir = self.dir(&ctx, workspace_id)?;
        if !valid_id(client_command_id) {
            return Err("cloud_agent_request_invalid".into());
        }
        // No resend of this workspace's envelopes runs while a cancel does.
        let send_lock = self.send_lock(&dir);
        let _sending = send_lock.lock().unwrap();
        let known = self.outbox(organization_id, workspace_id, None)?.into_iter().find(|entry| entry.client_command_id == client_command_id);
        let known = known.ok_or("cloud_agent_command_unknown")?;
        if !TERMINAL_STATES.contains(&known.state.as_str()) {
            let reply = self.call(&ctx, "POST", workspace_id, &["agent-commands", client_command_id, "cancel"], &[], Some(&json!({})));
            let id = client_command_id.to_string();
            let outcome = self.edit_outbox(&dir, |entries| {
                let entry = entries.iter_mut().find(|entry| entry.client_command_id == id)?;
                entry.updated_at = now_ms();
                Some(match reply {
                    Reply::Ok(body) => {
                        if let Some(command) = body.get("command").cloned().and_then(|c| serde_json::from_value::<ServerCommand>(c).ok()) {
                            self.apply_server(organization_id, workspace_id, &dir, entry, command);
                        }
                        Ok(())
                    }
                    // Never reached the API: nothing to cancel there.
                    Reply::Refused(404, _) if entry.state == "unsent" => {
                        entry.state = "cancelled".into();
                        entry.category = Some("cancelled-by-user".into());
                        Ok(())
                    }
                    Reply::Refused(_, code) => Err(code),
                    Reply::Unreachable => Err("cloud_workspace_unavailable".into()),
                })
            })?;
            match outcome {
                Some(Err(code)) => return Err(code),
                None => return Err("cloud_agent_command_unknown".into()),
                Some(Ok(())) => {}
            }
        }
        self.outbox(organization_id, workspace_id, None)?
            .into_iter()
            .find(|entry| entry.client_command_id == client_command_id)
            .ok_or_else(|| "cloud_agent_command_unknown".into())
    }

    // ------------------------------------------------------------ checkpoints

    pub fn checkpoints(&self, organization_id: &str, workspace_id: &str) -> Result<Vec<Value>, String> {
        let ctx = self.ctx(organization_id)?;
        self.dir(&ctx, workspace_id)?;
        match self.call(&ctx, "GET", workspace_id, &["transcript-checkpoints"], &[], None) {
            Reply::Ok(body) => Ok(body.get("checkpoints").and_then(Value::as_array).cloned().unwrap_or_default()),
            Reply::Refused(_, code) => Err(code),
            Reply::Unreachable => Err("cloud_workspace_unavailable".into()),
        }
    }

    /// The tab's checkpoint when it is newer than `(after_epoch, after_version)`.
    pub fn checkpoint(&self, organization_id: &str, workspace_id: &str, tab_id: &str, after: Option<(u64, u64)>) -> Result<Option<Checkpoint>, String> {
        let ctx = self.ctx(organization_id)?;
        self.dir(&ctx, workspace_id)?;
        if !valid_id(tab_id) {
            return Err("cloud_agent_request_invalid".into());
        }
        let query: Vec<(&str, String)> = after.map(|(epoch, version)| vec![("afterEpoch", epoch.to_string()), ("afterVersion", version.to_string())]).unwrap_or_default();
        let body = match self.call(&ctx, "GET", workspace_id, &["transcript-checkpoints", tab_id], &query, None) {
            Reply::Ok(body) => body,
            Reply::Refused(404, code) if code == "cloud_workspace_transcript_checkpoint_not_found" => return Ok(None),
            Reply::Refused(_, code) => return Err(code),
            Reply::Unreachable => return Err("cloud_workspace_unavailable".into()),
        };
        let Some(checkpoint) = body.get("checkpoint").filter(|value| !value.is_null()) else { return Ok(None) };
        self.open_checkpoint(organization_id, workspace_id, tab_id, checkpoint, after)
    }

    fn open_checkpoint(&self, organization_id: &str, workspace_id: &str, tab_id: &str, checkpoint: &Value, after: Option<(u64, u64)>) -> Result<Option<Checkpoint>, String> {
        let invalid = || "cloud_agent_checkpoint_invalid".to_string();
        let number = |name: &str| checkpoint.get(name).and_then(Value::as_u64).ok_or_else(invalid);
        let text = |name: &str| checkpoint.get(name).and_then(Value::as_str).ok_or_else(invalid);
        let (epoch, version, schema_version) = (number("epoch")?, number("version")?, number("schemaVersion")?);
        if checkpoint.get("tabId").and_then(Value::as_str).is_some_and(|id| id != tab_id) {
            return Err(invalid());
        }
        // A live projection or the cache is always stronger than an older checkpoint.
        if after.is_some_and(|after| (epoch, version) <= after) {
            return Ok(None);
        }
        if schema_version != crypto::CHECKPOINT_SCHEMA {
            return Err("cloud_agent_checkpoint_schema_unsupported".into());
        }
        let key_id = text("keyId")?;
        let iv = crypto::unb64(text("iv")?).map_err(|_| invalid())?;
        let ciphertext = crypto::unb64(text("ciphertext")?).map_err(|_| invalid())?;
        if iv.len() != crypto::IV_LEN || ciphertext.len() > crypto::MAX_CHECKPOINT_CIPHERTEXT {
            return Err(invalid());
        }
        if !crypto::sha256_hex(&ciphertext).eq_ignore_ascii_case(text("sha256")?) {
            return Err("cloud_agent_checkpoint_hash_mismatch".into());
        }
        let key = Zeroizing::new(self.key(organization_id, workspace_id, key_id)?);
        let aad = crypto::checkpoint_aad(organization_id, workspace_id, tab_id, epoch, version, schema_version, key_id);
        let packed = crypto::open_raw(&key, &iv, &ciphertext, &aad).map_err(|_| "cloud_agent_checkpoint_decrypt_failed".to_string())?;
        let json = crypto::gunzip(&packed, CHECKPOINT_INFLATE_LIMIT).map_err(|_| invalid())?;
        let projection = crypto::parse_v1(&json).map_err(|_| invalid())?;
        Ok(Some(Checkpoint { epoch, version, schema_version, projection }))
    }

    // ------------------------------------------------------------ cache

    pub fn cache_load(&self, organization_id: &str, workspace_id: &str) -> Result<Value, String> {
        let ctx = self.ctx(organization_id)?;
        let dir = self.dir(&ctx, workspace_id)?;
        let _guard = self.lock.lock().unwrap();
        let tabs: BTreeMap<String, Value> = read_json(&dir.join("cache.json")).ok().flatten().unwrap_or_default();
        Ok(json!({ "tabs": tabs }))
    }

    pub fn cache_save(&self, organization_id: &str, workspace_id: &str, tab_id: &str, entry: Option<Value>) -> Result<(), String> {
        let ctx = self.ctx(organization_id)?;
        let dir = self.dir(&ctx, workspace_id)?;
        if !valid_id(tab_id) {
            return Err("cloud_agent_request_invalid".into());
        }
        if entry.as_ref().is_some_and(|entry| serde_json::to_vec(entry).map(|bytes| bytes.len()).unwrap_or(usize::MAX) > CACHE_ENTRY_LIMIT) {
            return Err("cloud_agent_cache_too_large".into());
        }
        let _guard = self.lock.lock().unwrap();
        if !self.writable(&dir) {
            return Err("cloud_remote_organization_mismatch".into());
        }
        let path = dir.join("cache.json");
        let mut tabs: BTreeMap<String, Value> = read_json(&path).ok().flatten().unwrap_or_default();
        match entry {
            Some(entry) => tabs.insert(tab_id.to_string(), entry),
            None => tabs.remove(tab_id),
        };
        let bytes = serde_json::to_vec(&tabs).map_err(|_| "cloud_agent_store_unwritable".to_string())?;
        if bytes.len() > CACHE_TOTAL_LIMIT {
            return Err("cloud_agent_cache_too_large".into());
        }
        write_atomic(&path, &bytes).map_err(|_| "cloud_agent_store_unwritable".to_string())
    }

    // ------------------------------------------------------------ tombstones

    /// The workspace was deleted (a tombstone, contract §10.5): drop its
    /// outbox, transcript cache and content keys. Says what was there, so the
    /// page can tell the person what went with it; purging again is a no-op.
    pub fn purge_workspace(&self, organization_id: &str, workspace_id: &str) -> Result<Purged, String> {
        let ctx = self.ctx(organization_id)?;
        let dir = self.dir(&ctx, workspace_id)?;
        // No send or cancel of this workspace runs while its files go.
        let send = self.send_lock(&dir);
        let _send = send.lock().unwrap();
        let _guard = self.lock.lock().unwrap();
        if !dir.exists() {
            return Ok(Purged::default());
        }
        let unsent_commands = self.load_outbox(&dir).unwrap_or_default().iter().filter(|entry| entry.pending()).count();
        let cached_tabs = read_json::<BTreeMap<String, Value>>(&dir.join("cache.json")).ok().flatten().map_or(0, |tabs| tabs.len());
        for meta in self.index(&dir).unwrap_or_default().keys {
            if let Err(error) = self.keys.delete(organization_id, workspace_id, &meta.key_id) {
                log::warn!("drop a deleted workspace's key: {error:#}");
            }
        }
        std::fs::remove_dir_all(&dir).map_err(|error| {
            log::warn!("drop a deleted workspace's agent data: {error}");
            "cloud_agent_store_unwritable".to_string()
        })?;
        Ok(Purged { removed: true, unsent_commands, cached_tabs })
    }

    // ------------------------------------------------------------ identity

    /// Called with the signed-in user and the Organizations whose data is
    /// kept whenever it is read. Everything stored for another user, or for an
    /// Organization that is no longer kept, is dropped, keys included.
    ///
    /// With every member Organization live (CS-18) the kept set is the
    /// membership list, so a change of the default Organization drops nothing
    /// and only a membership loss (or another user) prunes. Without it the set
    /// is the active Organization alone, as before.
    pub fn observe_identity(&self, current: Option<KeptIdentity>) {
        let changed = {
            let mut observed = self.observed.lock().unwrap();
            let changed = *observed != current;
            let had = observed.is_some();
            *observed = current.clone();
            // Before the account loads the identity reads as none; only a
            // real change (or the first real identity) prunes.
            changed && (had || current.is_some())
        };
        if changed {
            self.retain_only(current.as_ref());
        }
    }

    fn retain_only(&self, keep: Option<&KeptIdentity>) {
        let _guard = self.lock.lock().unwrap();
        // No key of the previous identity stays in memory; the ones still
        // kept are read again when next used.
        self.keys.forget();
        let Ok(users) = std::fs::read_dir(&self.root) else { return };
        for user in users.flatten() {
            let user_id = user.file_name().to_string_lossy().into_owned();
            let Ok(orgs) = std::fs::read_dir(user.path()) else { continue };
            for org in orgs.flatten() {
                let organization_id = org.file_name().to_string_lossy().into_owned();
                if keep.is_some_and(|(u, orgs)| *u == user_id && orgs.contains(&organization_id)) {
                    continue;
                }
                for workspace in std::fs::read_dir(org.path()).into_iter().flatten().flatten() {
                    let workspace_id = workspace.file_name().to_string_lossy().into_owned();
                    let index: KeyIndex = read_json(&workspace.path().join("keys.json")).ok().flatten().unwrap_or_default();
                    for meta in index.keys {
                        if let Err(error) = self.keys.delete(&organization_id, &workspace_id, &meta.key_id) {
                            log::warn!("drop a workspace key: {error:#}");
                        }
                    }
                }
                if let Err(error) = std::fs::remove_dir_all(org.path()) {
                    log::warn!("drop cloud agent data for a previous identity: {error}");
                }
            }
        }
    }

    // ------------------------------------------------------------ HTTP

    fn call(&self, ctx: &Ctx, method: &str, workspace_id: &str, tail: &[&str], query: &[(&str, String)], body: Option<&Value>) -> Reply {
        let mut url = self.base.clone();
        {
            let Ok(mut segments) = url.path_segments_mut() else { return Reply::Unreachable };
            segments.pop_if_empty();
            segments.extend(["v1", "desktop", "orgs", ctx.organization_id.as_str(), "cloud-workspaces", workspace_id]);
            segments.extend(tail.iter().copied());
        }
        for (name, value) in query {
            url.query_pairs_mut().append_pair(name, value);
        }
        let request = self
            .agent
            .request(method, url.as_str())
            .set("authorization", &format!("Bearer {}", ctx.access_token.as_str()))
            .set("content-type", "application/json");
        let response = match body {
            Some(body) => request.send_bytes(&serde_json::to_vec(body).unwrap_or_default()),
            None => request.call(),
        };
        let read = |response: ureq::Response| -> Option<Value> {
            let mut bytes = Vec::new();
            response.into_reader().take(RESPONSE_LIMIT + 1).read_to_end(&mut bytes).ok()?;
            (bytes.len() as u64 <= RESPONSE_LIMIT).then(|| serde_json::from_slice(&bytes).ok()).flatten()
        };
        match response {
            Ok(response) => read(response).map(Reply::Ok).unwrap_or(Reply::Unreachable),
            Err(ureq::Error::Status(status, response)) => {
                let code = read(response)
                    .and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_string))
                    .filter(|code| code.len() <= 96 && code.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
                    .unwrap_or_else(|| "cloud_workspace_unavailable".into());
                Reply::Refused(status, code)
            }
            Err(ureq::Error::Transport(_)) => Reply::Unreachable,
        }
    }
}

/// Keep every pending entry and the newest settled ones per tab.
fn prune(entries: &mut Vec<Stored>) {
    let mut settled: HashMap<String, Vec<(u64, String)>> = HashMap::new();
    for entry in entries.iter().filter(|entry| !entry.pending()) {
        settled.entry(entry.tab_id.clone()).or_default().push((entry.updated_at, entry.client_command_id.clone()));
    }
    let mut dropped = std::collections::HashSet::new();
    for (_, mut list) in settled {
        list.sort_by(|a, b| b.cmp(a));
        dropped.extend(list.into_iter().skip(SETTLED_KEPT_PER_TAB).map(|(_, id)| id));
    }
    entries.retain(|entry| !dropped.contains(&entry.client_command_id));
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

/// Durable replace (`cloud_bootstrap::write_durable`) in a private directory.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow!("no parent directory"))?;
    crate::cloud_bootstrap::ensure_private_dir(dir)?;
    crate::cloud_bootstrap::write_durable(path, bytes)
}

// ---------------------------------------------------------------- Tauri

type Client<'a> = tauri::State<'a, Arc<CloudAgentClient>>;

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "cloud_agent_task_failed".to_string())?
}

#[tauri::command]
pub async fn cloud_agent_enqueue(client: Client<'_>, organization_id: String, workspace_id: String, tab_id: String, kind: String, payload: Value) -> Result<OutboxEntry, String> {
    let client = client.inner().clone();
    blocking(move || client.enqueue(&organization_id, &workspace_id, &tab_id, &kind, payload)).await
}

#[tauri::command]
pub async fn cloud_agent_outbox(client: Client<'_>, organization_id: String, workspace_id: String, tab_id: Option<String>) -> Result<Vec<OutboxEntry>, String> {
    let client = client.inner().clone();
    blocking(move || client.outbox(&organization_id, &workspace_id, tab_id.as_deref())).await
}

#[tauri::command]
pub async fn cloud_agent_outbox_sync(client: Client<'_>, organization_id: String, workspace_id: String) -> Result<Vec<OutboxEntry>, String> {
    let client = client.inner().clone();
    blocking(move || client.outbox_sync(&organization_id, &workspace_id)).await
}

#[tauri::command]
pub async fn cloud_agent_cancel(client: Client<'_>, organization_id: String, workspace_id: String, client_command_id: String) -> Result<OutboxEntry, String> {
    let client = client.inner().clone();
    blocking(move || client.cancel(&organization_id, &workspace_id, &client_command_id)).await
}

#[tauri::command]
pub async fn cloud_agent_checkpoints(client: Client<'_>, organization_id: String, workspace_id: String) -> Result<Vec<Value>, String> {
    let client = client.inner().clone();
    blocking(move || client.checkpoints(&organization_id, &workspace_id)).await
}

#[tauri::command]
pub async fn cloud_agent_checkpoint(
    client: Client<'_>,
    organization_id: String,
    workspace_id: String,
    tab_id: String,
    after_epoch: Option<u64>,
    after_version: Option<u64>,
) -> Result<Option<Checkpoint>, String> {
    let client = client.inner().clone();
    let after = after_epoch.zip(after_version);
    blocking(move || client.checkpoint(&organization_id, &workspace_id, &tab_id, after)).await
}

#[tauri::command]
pub async fn cloud_agent_has_key(client: Client<'_>, organization_id: String, workspace_id: String) -> Result<bool, String> {
    let client = client.inner().clone();
    blocking(move || client.has_key(&organization_id, &workspace_id)).await
}

#[tauri::command]
pub async fn cloud_agent_cache_load(client: Client<'_>, organization_id: String, workspace_id: String) -> Result<Value, String> {
    let client = client.inner().clone();
    blocking(move || client.cache_load(&organization_id, &workspace_id)).await
}

#[tauri::command]
pub async fn cloud_agent_cache_save(client: Client<'_>, organization_id: String, workspace_id: String, tab_id: String, entry: Option<Value>) -> Result<(), String> {
    let client = client.inner().clone();
    blocking(move || client.cache_save(&organization_id, &workspace_id, &tab_id, entry)).await
}

#[tauri::command]
pub async fn cloud_agent_purge_workspace(client: Client<'_>, organization_id: String, workspace_id: String) -> Result<Purged, String> {
    let client = client.inner().clone();
    blocking(move || client.purge_workspace(&organization_id, &workspace_id)).await
}

#[cfg(test)]
#[path = "cloud_agent_client_tests.rs"]
mod tests;
