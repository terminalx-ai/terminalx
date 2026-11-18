//! The computers this machine lets operate it (docs/MACHINES.md decision 4):
//! `<data dir>/machine-host/paired-computers.json`, mode 0600, token hashes
//! only. It is never `devices.json`: that file's strict scope enum would make
//! an older build drop every phone pairing on one unknown value.
//!
//! The file is read again for every admission, so a computer removed by
//! another process is refused on its next connection. Every rewrite reads and
//! writes it under one cross-process lock (`paired-computers.lock`), so no
//! process undoes another's change. Fields this build does not know are kept
//! when it rewrites the file.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const FILE: &str = "paired-computers.json";
const LOCK: &str = "paired-computers.lock";
/// How long a rewrite waits for another process's.
const LOCK_WAIT: Duration = Duration::from_secs(10);
/// A credential unused this long expires (PRO-357): the computer pairs again.
pub const UNUSED_EXPIRY_MS: i64 = 90 * 24 * 60 * 60 * 1000;

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
    /// The token handed out by `machine.rotateCredential` and not yet used
    /// (PRO-357). Admission with it makes it the token; admission with the
    /// current token drops it, since the computer evidently never kept it.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hash_b64")]
    pub next_token_hash: Option<[u8; 32]>,
    /// When the person on this machine pressed Disconnect: refused until they
    /// let it reconnect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disconnected_at: Option<i64>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

/// The key of [`PairedComputer::grant_request_id`] among its other fields.
const GRANT_REQUEST_ID: &str = "grantRequestId";

impl PairedComputer {
    /// The account pairing grant it was allowed through (PRO-349), so a
    /// removal on either side ends the other; `None` when paired by code.
    /// Kept among the record's other fields, so the record keeps its shape
    /// for everything that builds one.
    pub fn grant_request_id(&self) -> Option<&str> {
        self.other.get(GRANT_REQUEST_ID).and_then(serde_json::Value::as_str)
    }

    /// Link it to the grant it was allowed through, or to none.
    pub fn set_grant_request_id(&mut self, grant_request_id: Option<String>) {
        match grant_request_id {
            Some(grant) => self.other.insert(GRANT_REQUEST_ID.into(), grant.into()),
            None => self.other.remove(GRANT_REQUEST_ID),
        };
    }

    /// Whether `token` is this computer's (its token, or the rotated one it
    /// has not used yet), in constant time.
    pub fn proves(&self, token: &str) -> bool {
        let hash = token_hash(token);
        let current = bool::from(self.token_hash.ct_eq(&hash));
        let next = self.next_token_hash.map(|next| bool::from(next.ct_eq(&hash))).unwrap_or(false);
        current | next
    }

    /// When its credential was last used: its last connection, else Allow.
    pub fn last_used_at(&self) -> i64 {
        self.last_seen_at.unwrap_or(self.approved_at).max(self.approved_at)
    }

    /// Unused for [`UNUSED_EXPIRY_MS`] at `now`.
    pub fn expired(&self, now: i64) -> bool {
        now.saturating_sub(self.last_used_at()) >= UNUSED_EXPIRY_MS
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

mod opt_hash_b64 {
    use super::*;

    pub fn serialize<S: serde::Serializer>(hash: &Option<[u8; 32]>, serializer: S) -> Result<S::Ok, S::Error> {
        match hash {
            Some(hash) => serializer.serialize_some(&STANDARD.encode(hash)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<[u8; 32]>, D::Error> {
        let Some(text) = Option::<String>::deserialize(deserializer)? else { return Ok(None) };
        STANDARD.decode(text).ok().and_then(|bytes| bytes.try_into().ok()).map(Some).ok_or_else(|| serde::de::Error::custom("invalid token hash"))
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
}

impl Registry {
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self::at(data_dir.join(super::DIR).join(FILE))
    }

    pub fn at(path: PathBuf) -> Self {
        Self { path }
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

    /// Read, change and write the file under the cross-process lock.
    fn rewrite<T>(&self, change: impl FnOnce(&mut File) -> Result<Option<T>>) -> Result<Option<T>> {
        let dir = self.path.parent().context("registry path has no parent")?;
        super::private_dir(dir)?;
        crate::store::transaction::run(&dir.join(LOCK), LOCK_WAIT, || {
            let mut file = self.read()?;
            let changed = change(&mut file)?;
            if changed.is_some() {
                self.write(&file)?;
            }
            Ok(changed)
        })
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
        self.rewrite(|file| {
            file.computers.retain(|existing| existing.id != computer.id);
            file.computers.push(computer);
            Ok(Some(()))
        })?;
        Ok(())
    }

    /// The computer allowed through the account grant `grant_request_id`.
    pub fn find_by_grant(&self, grant_request_id: &str) -> Result<Option<PairedComputer>> {
        Ok(self.read()?.computers.into_iter().find(|computer| computer.grant_request_id() == Some(grant_request_id)))
    }

    /// Remove a computer. Whether it was there.
    pub fn remove(&self, id: &str) -> Result<bool> {
        let removed = self.rewrite(|file| {
            let before = file.computers.len();
            file.computers.retain(|computer| computer.id != id);
            Ok((file.computers.len() != before).then_some(()))
        })?;
        Ok(removed.is_some())
    }

    /// The computer's relay device id, given once (`machine.relayAccess`,
    /// PRO-345): the one it has, else `fresh`. `None` when it is not paired.
    pub fn give_relay_device(&self, id: &str, fresh: &str) -> Result<Option<String>> {
        self.rewrite(|file| {
            let Some(computer) = file.computers.iter_mut().find(|computer| computer.id == id) else { return Ok(None) };
            Ok(Some(computer.relay_device_id.get_or_insert_with(|| fresh.to_string()).clone()))
        })
    }

    /// Note when a computer last connected.
    /// A computer removed meanwhile, by any process, stays removed.
    pub fn touch(&self, id: &str, at: i64) -> Result<()> {
        self.rewrite(|file| {
            let Some(computer) = file.computers.iter_mut().find(|computer| computer.id == id) else { return Ok(None) };
            computer.last_seen_at = Some(at);
            Ok(Some(()))
        })?;
        Ok(())
    }

    /// A computer was let in with `token` at `at` (PRO-357): note the time,
    /// and settle a rotation. The rotated token, once used, becomes the token
    /// and the old one stops working. The old token used instead means the
    /// computer never kept the rotated one, which is dropped.
    pub fn admitted(&self, id: &str, token: &str, at: i64) -> Result<()> {
        let hash = token_hash(token);
        self.rewrite(|file| {
            let Some(computer) = file.computers.iter_mut().find(|computer| computer.id == id) else { return Ok(None) };
            computer.last_seen_at = Some(at);
            if let Some(next) = computer.next_token_hash.take() {
                if bool::from(next.ct_eq(&hash)) {
                    computer.token_hash = next;
                }
            }
            Ok(Some(()))
        })?;
        Ok(())
    }

    /// Keep `next` as the computer's rotated token. Whether it is paired.
    pub fn rotate(&self, id: &str, next: [u8; 32]) -> Result<bool> {
        let rotated = self.rewrite(|file| {
            let Some(computer) = file.computers.iter_mut().find(|computer| computer.id == id) else { return Ok(None) };
            computer.next_token_hash = Some(next);
            Ok(Some(()))
        })?;
        Ok(rotated.is_some())
    }

    /// Hold a computer off (`Some(at)`) or let it reconnect (`None`). The
    /// computer, when it is paired and the hold changed.
    pub fn set_disconnected(&self, id: &str, at: Option<i64>) -> Result<Option<PairedComputer>> {
        self.rewrite(|file| {
            let Some(computer) = file.computers.iter_mut().find(|computer| computer.id == id) else { return Ok(None) };
            if computer.disconnected_at.is_some() == at.is_some() {
                return Ok(None);
            }
            computer.disconnected_at = at;
            Ok(Some(computer.clone()))
        })
    }

    /// Remove every computer whose credential went unused for 90 days at
    /// `now`, but those in `keep` (connected now). The ones removed.
    pub fn remove_expired(&self, now: i64, keep: &[String]) -> Result<Vec<PairedComputer>> {
        if !self.read()?.computers.iter().any(|computer| computer.expired(now) && !keep.contains(&computer.id)) {
            return Ok(Vec::new());
        }
        let removed = self.rewrite(|file| {
            let (expired, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut file.computers).into_iter().partition(|computer| computer.expired(now) && !keep.contains(&computer.id));
            file.computers = kept;
            Ok((!expired.is_empty()).then_some(expired))
        })?;
        Ok(removed.unwrap_or_default())
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
            next_token_hash: None,
            disconnected_at: None,
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
    fn a_removal_by_another_process_is_never_undone() {
        let dir = tempfile::tempdir().unwrap();
        let here = Registry::in_data_dir(dir.path());
        let there = Registry::in_data_dir(dir.path());
        here.put(computer("a", "token-a-token-a-token-a")).unwrap();
        here.put(computer("b", "token-b-token-b-token-b")).unwrap();
        // Another process removes "a" while this one holds the lock: its
        // rewrite waits, then reads the file this one wrote.
        let lock = dir.path().join(super::super::DIR).join(LOCK);
        let path = there.path().to_path_buf();
        let (started, wait) = std::sync::mpsc::channel();
        let remover = crate::store::transaction::run(&lock, LOCK_WAIT, || {
            let remover = std::thread::spawn(move || {
                started.send(()).unwrap();
                Registry::at(path).remove("a").unwrap()
            });
            wait.recv().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            let mut file = here.read()?;
            file.computers.iter_mut().for_each(|computer| computer.last_seen_at = Some(9));
            here.write(&file)?;
            Ok(remover)
        })
        .unwrap();
        assert!(remover.join().unwrap(), "removed after the other rewrite finished");
        here.touch("a", 10).unwrap();
        let ids: Vec<String> = there.list().unwrap().into_iter().map(|computer| computer.id).collect();
        assert_eq!(ids, ["b"], "a touch of a removed computer does not bring it back");
        assert_eq!(there.list().unwrap()[0].last_seen_at, Some(9));
    }

    #[test]
    fn a_computer_is_found_by_its_grant_and_an_older_record_has_none() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::in_data_dir(dir.path());
        let mut linked = computer("a", "token-a-token-a-token-a");
        linked.set_grant_request_id(Some("grant-1".into()));
        registry.put(linked).unwrap();
        registry.put(computer("b", "token-b-token-b-token-b")).unwrap();
        assert_eq!(registry.find_by_grant("grant-1").unwrap().unwrap().id, "a");
        assert!(registry.find_by_grant("grant-2").unwrap().is_none());
        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(registry.path()).unwrap()).unwrap();
        assert_eq!(written["computers"][0]["grantRequestId"], "grant-1");
        assert!(written["computers"][1].get("grantRequestId").is_none(), "paired by code: no grant");

        // Paired again by code: the old record's link does not carry over.
        let mut again = registry.find_by_grant("grant-1").unwrap().unwrap();
        again.set_grant_request_id(None);
        registry.put(again).unwrap();
        assert!(registry.find_by_grant("grant-1").unwrap().is_none());
        assert_eq!(registry.list().unwrap().iter().filter_map(PairedComputer::grant_request_id).count(), 0);
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

    /// PRO-357: a rotated token works beside the old one until it is used,
    /// then alone; a computer that never kept it goes on with the old one.
    #[test]
    fn a_rotated_token_replaces_the_old_one_once_it_is_used() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::in_data_dir(dir.path());
        registry.put(computer("a", "token-old")).unwrap();
        assert!(registry.rotate("a", token_hash("token-new")).unwrap());
        assert!(!registry.rotate("gone", token_hash("token-x")).unwrap(), "not paired");
        assert_eq!(registry.find_by_token("token-old").unwrap().unwrap().id, "a", "the old token works until the new one is used");
        assert_eq!(registry.find_by_token("token-new").unwrap().unwrap().id, "a");
        assert!(!std::fs::read_to_string(registry.path()).unwrap().contains("token-new"), "only its hash is kept");
        registry.admitted("a", "token-new", 50).unwrap();
        assert!(registry.find_by_token("token-old").unwrap().is_none(), "the old token stops working once the new one was used");
        assert_eq!(registry.find_by_token("token-new").unwrap().unwrap().last_seen_at, Some(50));
        assert!(registry.find_by_relay_device("relay-a", "token-new").unwrap().is_some(), "the relay route takes it too");

        // The reply with the next token was lost: the computer comes back
        // with the token it has, and the one it never kept is dropped.
        registry.rotate("a", token_hash("token-lost")).unwrap();
        registry.admitted("a", "token-new", 60).unwrap();
        assert!(registry.find_by_token("token-lost").unwrap().is_none(), "a rotated token the computer never used is dropped");
        assert!(registry.find_by_token("token-new").unwrap().is_some());
    }

    #[test]
    fn a_held_computer_is_marked_until_it_is_let_back() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::in_data_dir(dir.path());
        registry.put(computer("a", "token-a")).unwrap();
        assert_eq!(registry.set_disconnected("a", Some(7)).unwrap().unwrap().disconnected_at, Some(7));
        assert!(registry.set_disconnected("a", Some(8)).unwrap().is_none(), "already held");
        assert_eq!(registry.list().unwrap()[0].disconnected_at, Some(7));
        assert!(registry.set_disconnected("a", None).unwrap().is_some());
        assert_eq!(registry.list().unwrap()[0].disconnected_at, None);
        assert!(registry.set_disconnected("gone", Some(1)).unwrap().is_none());
    }

    /// PRO-357: a credential unused for 90 days expires; one in use does not.
    #[test]
    fn a_credential_unused_for_ninety_days_expires() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::in_data_dir(dir.path());
        let day = 24 * 60 * 60 * 1000;
        let mut old = computer("old", "token-old");
        old.approved_at = 0;
        old.last_seen_at = Some(10 * day);
        let mut connected = computer("connected", "token-connected");
        connected.approved_at = 0;
        let mut recent = computer("recent", "token-recent");
        recent.approved_at = 0;
        recent.last_seen_at = Some(95 * day);
        for computer in [old, connected, recent] {
            registry.put(computer).unwrap();
        }
        let now = 100 * day;
        assert!(registry.list().unwrap().iter().find(|computer| computer.id == "old").unwrap().expired(now));
        assert!(!registry.list().unwrap().iter().find(|computer| computer.id == "old").unwrap().expired(99 * day), "89 days unused is not expired");
        let removed: Vec<String> = registry.remove_expired(now, &["connected".to_string()]).unwrap().into_iter().map(|computer| computer.id).collect();
        assert_eq!(removed, ["old"]);
        let left: Vec<String> = registry.list().unwrap().into_iter().map(|computer| computer.id).collect();
        assert_eq!(left, ["connected", "recent"], "a computer connected now is not expired under it");
        assert!(registry.remove_expired(now, &[]).unwrap().iter().any(|computer| computer.id == "connected"), "once it is gone, it expires too");
    }
}
