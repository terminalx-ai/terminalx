//! Workspace content keys (contract §13): created here, stored only in the
//! runtime's state directory, and handed to attached clients over the relay
//! E2EE channel with `keys.get`. The API only ever sees their ids.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroize;

use super::crypto::{self, KEY_LEN};

/// Retired keys stay listed this long, so queued commands and old
/// checkpoints still open on the client.
const LISTED_AFTER_RETIREMENT_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// A command encrypted under a retired key is still accepted if it was
/// queued within this long after the key was retired.
pub const COMMAND_GRACE_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredKey {
    key_id: String,
    key: String,
    created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retired_at: Option<u64>,
}

impl Drop for StoredKey {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    v: u8,
    keys: Vec<StoredKey>,
}

pub struct Keys {
    path: PathBuf,
    state: Mutex<Stored>,
}

impl Keys {
    /// Load the key file, creating a first key when there is none.
    pub fn open(dir: &Path, now_ms: u64) -> Result<Self> {
        let path = dir.join("keys.json");
        let state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Stored>(&bytes).with_context(|| format!("parse {}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored { v: 1, keys: Vec::new() },
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        let keys = Self { path, state: Mutex::new(state) };
        if keys.current().is_none() {
            keys.rotate(now_ms)?;
        }
        Ok(keys)
    }

    /// The key new ciphertext is made with: `(keyId, key)`.
    pub fn current(&self) -> Option<(String, [u8; KEY_LEN])> {
        let state = self.state.lock().unwrap();
        let key = state.keys.iter().rev().find(|key| key.retired_at.is_none())?;
        Some((key.key_id.clone(), crypto::key_from_b64(&key.key).ok()?))
    }

    /// A key by id, if it may still open a command created at `created_at`.
    pub fn for_command(&self, key_id: &str, created_at: u64) -> Option<[u8; KEY_LEN]> {
        let state = self.state.lock().unwrap();
        let key = state.keys.iter().find(|key| key.key_id == key_id)?;
        if key.retired_at.is_some_and(|retired| created_at > retired.saturating_add(COMMAND_GRACE_MS)) {
            return None;
        }
        crypto::key_from_b64(&key.key).ok()
    }

    /// Any known key by id (receipts answer under the command's own key).
    pub fn get(&self, key_id: &str) -> Option<[u8; KEY_LEN]> {
        let state = self.state.lock().unwrap();
        crypto::key_from_b64(&state.keys.iter().find(|key| key.key_id == key_id)?.key).ok()
    }

    /// Retire the current key and make a new one. Returns the new key id.
    pub fn rotate(&self, now_ms: u64) -> Result<String> {
        let mut state = self.state.lock().unwrap();
        let mut next: Vec<StoredKey> = state
            .keys
            .iter()
            .filter(|key| key.retired_at.is_none_or(|retired| now_ms.saturating_sub(retired) < LISTED_AFTER_RETIREMENT_MS))
            .cloned()
            .collect();
        for key in next.iter_mut().filter(|key| key.retired_at.is_none()) {
            key.retired_at = Some(now_ms);
        }
        let mut secret = crypto::random_bytes::<KEY_LEN>();
        let key_id = crypto::random_id();
        next.push(StoredKey { key_id: key_id.clone(), key: crypto::b64(&secret), created_at: now_ms, retired_at: None });
        secret.zeroize();
        let stored = Stored { v: 1, keys: next };
        let mut bytes = serde_json::to_vec(&stored)?;
        let written = crate::cloud_bootstrap::write_durable(&self.path, &bytes);
        bytes.zeroize();
        written?;
        *state = stored;
        Ok(key_id)
    }

    /// `keys.get`: the current key and the retired ones still listed.
    pub fn handout(&self, now_ms: u64) -> Value {
        let state = self.state.lock().unwrap();
        let keys: Vec<Value> = state
            .keys
            .iter()
            .filter(|key| key.retired_at.is_none_or(|retired| now_ms.saturating_sub(retired) < LISTED_AFTER_RETIREMENT_MS))
            .map(|key| json!({ "keyId": key.key_id, "key": key.key, "createdAt": key.created_at, "retiredAt": key.retired_at }))
            .collect();
        let current = state.keys.iter().rev().find(|key| key.retired_at.is_none()).map(|key| key.key_id.clone());
        json!({ "currentKeyId": current, "keys": keys })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_created_once_and_survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::open(dir.path(), 1_000).unwrap();
        let (id, key) = keys.current().unwrap();
        let reopened = Keys::open(dir.path(), 2_000).unwrap();
        assert_eq!(reopened.current().unwrap(), (id, key));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join("keys.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn rotation_keeps_old_keys_for_a_grace_and_then_refuses_new_commands_under_them() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::open(dir.path(), 1_000).unwrap();
        let (old, _) = keys.current().unwrap();
        let new = keys.rotate(10_000).unwrap();
        assert_ne!(old, new);
        assert_eq!(keys.current().unwrap().0, new);
        assert!(keys.for_command(&old, 9_000).is_some(), "queued before the rotation");
        assert!(keys.for_command(&old, 10_000 + COMMAND_GRACE_MS).is_some(), "within the grace");
        assert!(keys.for_command(&old, 10_001 + COMMAND_GRACE_MS).is_none(), "after the grace");
        assert!(keys.for_command("nope", 0).is_none());
        let handout = keys.handout(20_000);
        assert_eq!(handout["currentKeyId"], new);
        assert_eq!(handout["keys"].as_array().unwrap().len(), 2);
        // Long after, the retired key is no longer handed out.
        assert_eq!(keys.handout(10_000 + LISTED_AFTER_RETIREMENT_MS)["keys"].as_array().unwrap().len(), 1);
    }
}
