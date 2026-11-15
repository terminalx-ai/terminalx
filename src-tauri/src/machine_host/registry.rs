//! The computers this machine lets operate it (docs/MACHINES.md decision 4):
//! `<data dir>/machine-host/paired-computers.json`, mode 0600, token hashes
//! only. It is never `devices.json`: that file's strict scope enum would make
//! an older build drop every phone pairing on one unknown value.
//!
//! The file is read again for every admission, so a computer removed by
//! another process is refused on its next connection. Fields this build does
//! not know are kept when it rewrites the file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const FILE: &str = "paired-computers.json";

/// One paired computer. Its device token is never stored, only its SHA-256.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedComputer {
    pub id: String,
    #[serde(with = "hash_b64")]
    pub token_hash: [u8; 32],
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_public_key_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    pub approved_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    /// Its device id at the relay, when it was given relay access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_device_id: Option<String>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

impl PairedComputer {
    /// Whether `token` is this computer's, in constant time.
    pub fn proves(&self, token: &str) -> bool {
        bool::from(self.token_hash.ct_eq(&token_hash(token)))
    }
}

pub fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

mod hash_b64 {
    use super::*;

    pub fn serialize<S: serde::Serializer>(hash: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(hash))
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<[u8; 32], D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD.decode(text).ok().and_then(|bytes| bytes.try_into().ok()).ok_or_else(|| serde::de::Error::custom("invalid token hash"))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    v: u8,
    #[serde(default)]
    computers: Vec<PairedComputer>,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

impl Default for File {
    fn default() -> Self {
        Self { v: 1, computers: Vec::new(), other: Default::default() }
    }
}

pub struct Registry {
    path: PathBuf,
    /// Serializes this process's read-modify-write cycles.
    writing: Mutex<()>,
}

impl Registry {
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self::at(data_dir.join(super::DIR).join(FILE))
    }

    pub fn at(path: PathBuf) -> Self {
        Self { path, writing: Mutex::new(()) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read(&self) -> Result<File> {
        match std::fs::read(&self.path) {
            Ok(bytes) => {
                let file: File = serde_json::from_slice(&bytes).with_context(|| format!("parse {}", self.path.display()))?;
                if file.v != 1 {
                    bail!("unsupported paired computer file version {}", file.v);
                }
                Ok(file)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(File::default()),
            Err(error) => Err(error).with_context(|| format!("read {}", self.path.display())),
        }
    }

    fn write(&self, file: &File) -> Result<()> {
        super::private_dir(self.path.parent().context("registry path has no parent")?)?;
        crate::cloud_bootstrap::write_durable(&self.path, &serde_json::to_vec_pretty(file)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<PairedComputer>> {
        Ok(self.read()?.computers)
    }

    /// The computer whose token this is. Every record is compared, so the
    /// time taken does not say which one matched.
    pub fn find_by_token(&self, token: &str) -> Result<Option<PairedComputer>> {
        let mut found = None;
        for computer in self.read()?.computers {
            if computer.proves(token) && found.is_none() {
                found = Some(computer);
            }
        }
        Ok(found)
    }

    /// The computer the relay named, if `token` is its token.
    pub fn find_by_relay_device(&self, relay_device_id: &str, token: &str) -> Result<Option<PairedComputer>> {
        Ok(self.read()?.computers.into_iter().find(|computer| computer.relay_device_id.as_deref() == Some(relay_device_id)).filter(|computer| computer.proves(token)))
    }

    /// Whether the relay device id belongs to a paired computer.
    pub fn knows_relay_device(&self, relay_device_id: &str) -> Result<bool> {
        Ok(self.read()?.computers.iter().any(|computer| computer.relay_device_id.as_deref() == Some(relay_device_id)))
    }

    /// Add or replace a computer by id (PRO-342 pairs them).
    pub fn put(&self, computer: PairedComputer) -> Result<()> {
        let _writing = self.writing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.read()?;
        file.computers.retain(|existing| existing.id != computer.id);
        file.computers.push(computer);
        self.write(&file)
    }

    /// Remove a computer. Whether it was there.
    pub fn remove(&self, id: &str) -> Result<bool> {
        let _writing = self.writing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.read()?;
        let before = file.computers.len();
        file.computers.retain(|computer| computer.id != id);
        if file.computers.len() == before {
            return Ok(false);
        }
        self.write(&file)?;
        Ok(true)
    }

    /// Note when a computer last connected.
    pub fn touch(&self, id: &str, at: i64) -> Result<()> {
        let _writing = self.writing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.read()?;
        let Some(computer) = file.computers.iter_mut().find(|computer| computer.id == id) else { return Ok(()) };
        computer.last_seen_at = Some(at);
        self.write(&file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn computer(id: &str, token: &str) -> PairedComputer {
        PairedComputer {
            id: id.into(),
            token_hash: token_hash(token),
            label: format!("{id}'s MacBook"),
            platform: Some("macos".into()),
            client_public_key_b64: None,
            fingerprint: None,
            approved_at: 1,
            last_seen_at: None,
            relay_device_id: Some(format!("relay-{id}")),
            other: Default::default(),
        }
    }

    #[test]
    fn computers_are_found_by_token_and_relay_device_and_only_hashes_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::in_data_dir(dir.path());
        assert!(registry.list().unwrap().is_empty(), "no file is no computers");
        registry.put(computer("a", "token-a-token-a-token-a")).unwrap();
        registry.put(computer("b", "token-b-token-b-token-b")).unwrap();
        assert_eq!(registry.find_by_token("token-b-token-b-token-b").unwrap().unwrap().id, "b");
        assert!(registry.find_by_token("token-c").unwrap().is_none());
        assert_eq!(registry.find_by_relay_device("relay-a", "token-a-token-a-token-a").unwrap().unwrap().id, "a");
        assert!(registry.find_by_relay_device("relay-a", "token-b-token-b-token-b").unwrap().is_none(), "another computer's token");
        assert!(registry.knows_relay_device("relay-b").unwrap());
        let text = std::fs::read_to_string(registry.path()).unwrap();
        assert!(!text.contains("token-a"), "never the token itself");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(registry.path()).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(registry.remove("a").unwrap());
        assert!(!registry.remove("a").unwrap());
        assert!(registry.find_by_token("token-a-token-a-token-a").unwrap().is_none(), "a removed computer is refused");
    }

    #[test]
    fn fields_of_a_newer_build_survive_a_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::in_data_dir(dir.path());
        std::fs::create_dir_all(registry.path().parent().unwrap()).unwrap();
        let mut record = serde_json::to_value(computer("a", "token-a-token-a-token-a")).unwrap();
        record["futureRole"] = json!("reviewer");
        std::fs::write(registry.path(), json!({ "v": 1, "computers": [record], "futureTop": 7 }).to_string()).unwrap();
        registry.touch("a", 42).unwrap();
        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(registry.path()).unwrap()).unwrap();
        assert_eq!(written["futureTop"], 7);
        assert_eq!(written["computers"][0]["futureRole"], "reviewer");
        assert_eq!(written["computers"][0]["lastSeenAt"], 42);
        std::fs::write(registry.path(), json!({ "v": 2, "computers": [] }).to_string()).unwrap();
        assert!(registry.list().is_err(), "a version this build cannot read is not read as empty");
    }
}
