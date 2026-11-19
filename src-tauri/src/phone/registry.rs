//! The paired phones, `devices.json` in the store root.
//!
//! Two processes write it since PRO-359: the window, which pairs phones from
//! Settings → Devices and serves them while it is open, and the runtime,
//! which serves them while no window does and pairs them on a headless
//! server (`terminalx-serve pair --phone`). So nothing here is cached: each
//! read loads the file, and each change reads, changes and writes it under
//! one cross-process lock (`devices.lock`), so neither process undoes the
//! other's change.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use chrono::Utc;
use subtle::ConstantTimeEq;

use crate::local_runtime::mobile::model::{AccountMirror, DeviceEntry, DeviceFile, DeviceProvenance, DeviceScope, PairingTransport};
use crate::relay_e2ee::token_hash;

const FILE: &str = "devices.json";
const LOCK: &str = "devices.lock";
/// How long a change waits for the other process's.
const LOCK_WAIT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct DeviceRegistry;

/// An approved phone can keep its Mac's runtime available after the window closes.
pub(crate) fn has_paired_phone() -> Result<bool> {
    Ok(DeviceRegistry.list()?.iter().any(|device| {
        device.scope != DeviceScope::Session
            && (device.approved_at.is_some() || device.last_seen_at.is_some())
    }))
}

fn root() -> Result<PathBuf> {
    crate::store::root()
}

fn read_in(root: &Path) -> Result<DeviceFile> {
    Ok(crate::store::read_json(&root.join(FILE))?.unwrap_or_default())
}

/// Read, change and write the file under the cross-process lock. `change`
/// says whether it changed anything; an unchanged file is not written.
fn rewrite<T>(change: impl FnOnce(&mut DeviceFile) -> Result<(T, bool)>) -> Result<T> {
    rewrite_in(&root()?, change)
}

fn rewrite_in<T>(root: &Path, change: impl FnOnce(&mut DeviceFile) -> Result<(T, bool)>) -> Result<T> {
    crate::store::transaction::run(&root.join(LOCK), LOCK_WAIT, || {
        let mut file = read_in(root)?;
        let (result, changed) = change(&mut file)?;
        if changed {
            crate::store::write_json(&root.join(FILE), &file)?;
        }
        Ok(result)
    })
}

impl DeviceRegistry {
    pub fn list(&self) -> Result<Vec<DeviceEntry>> {
        list_in(&root()?)
    }

    pub fn add(&self, mut entry: DeviceEntry) -> Result<()> {
        // A live connection is the status's to report, never the file's.
        entry.connection = None;
        rewrite(|file| {
            file.devices.retain(|device| device.id != entry.id);
            file.devices.push(entry);
            Ok(((), true))
        })
    }

    pub fn remove_unclaimed(&self) -> Result<Vec<String>> {
        rewrite(|file| {
            let mut removed = Vec::new();
            file.devices.retain(|device| {
                let unclaimed = device.last_seen_at.is_none();
                if unclaimed {
                    removed.push(device.id.clone());
                }
                !unclaimed
            });
            let changed = !removed.is_empty();
            Ok((removed, changed))
        })
    }

    pub fn is_unclaimed(&self, device_id: &str) -> Result<bool> {
        Ok(self.list()?.into_iter().any(|device| device.id == device_id && device.last_seen_at.is_none()))
    }

    pub fn discard_unclaimed(&self, device_id: &str) -> Result<bool> {
        rewrite(|file| {
            let before = file.devices.len();
            file.devices.retain(|device| device.id != device_id || device.last_seen_at.is_some());
            let discarded = file.devices.len() != before;
            Ok((discarded, discarded))
        })
    }

    pub fn find_by_token(&self, token: &str, binding_generation: Option<u64>) -> Result<Option<DeviceEntry>> {
        let candidate = token_hash(token);
        Ok(self.list()?.into_iter().find(|device| {
            device.token.as_bytes().ct_eq(candidate.as_bytes()).into()
                && binding_generation.is_none_or(|generation| device.provenance == DeviceProvenance::Explicit || device.binding_generation == generation)
        }))
    }

    /// A connection from the device opened: its key, the fingerprint of that
    /// key (kept once known), and how it came.
    pub fn touch(&self, device_id: &str, public_key: &str, fingerprint: &str, transport: PairingTransport) -> Result<()> {
        self.update(device_id, |device| {
            if !device.public_key.is_empty() && device.public_key != public_key {
                return Err(anyhow!("paired device public key changed"));
            }
            device.public_key = public_key.into();
            device.fingerprint.get_or_insert_with(|| fingerprint.into());
            device.last_seen_at = Some(Utc::now().to_rfc3339());
            device.last_seen_transport = Some(transport);
            Ok(())
        })
    }

    /// The person approved this pairing on the Mac, for the phone key whose
    /// fingerprint they compared: the device is pinned to that key at once,
    /// so the code's token alone, with another key, cannot claim it.
    pub fn approve(&self, device_id: &str, fingerprint: &str, public_key: &str) -> Result<()> {
        self.update(device_id, |device| {
            if !device.public_key.is_empty() && device.public_key != public_key {
                return Err(anyhow!("paired device public key changed"));
            }
            device.public_key = public_key.into();
            device.approved_at = Some(Utc::now().to_rfc3339());
            device.fingerprint = Some(fingerprint.into());
            Ok(())
        })
    }

    /// What the phone calls itself (`device.describe`), already cleaned.
    pub fn describe(&self, device_id: &str, label: &str, platform: &str) -> Result<()> {
        self.update(device_id, |device| {
            device.label = label.into();
            device.platform = platform.into();
            Ok(())
        })
    }

    fn update(&self, device_id: &str, change: impl FnOnce(&mut DeviceEntry) -> Result<()>) -> Result<()> {
        rewrite(|file| {
            let device = file
                .devices
                .iter_mut()
                .find(|device| device.id == device_id && device.revoked_at.is_none())
                .ok_or_else(|| anyhow!("paired device was revoked"))?;
            change(device)?;
            Ok(((), true))
        })
    }

    pub fn revoke(&self, device_id: &str) -> Result<Option<DeviceEntry>> {
        revoke_in(&root()?, device_id)
    }

    pub fn revoke_automatic_for_user(&self, user_id: &str) -> Result<Vec<DeviceEntry>> {
        rewrite(|file| {
            let mut removed = Vec::new();
            file.devices.retain(|device| {
                let matches = device.provenance == DeviceProvenance::Automatic && device.bound_user_id.as_deref() == Some(user_id);
                if matches {
                    removed.push(device.clone());
                }
                !matches
            });
            Ok((removed, true))
        })
    }

    pub fn automatic_for_grant(&self, user_id: &str, installation_id: &str, request_id: &str) -> Result<Option<DeviceEntry>> {
        Ok(self.list()?.into_iter().find(|device| {
            device.provenance == DeviceProvenance::Automatic
                && device.bound_user_id.as_deref() == Some(user_id)
                && device.installation_id.as_deref() == Some(installation_id)
                && device.created_request_id.as_deref() == Some(request_id)
        }))
    }

    pub fn revoke_automatic_grant(&self, user_id: &str, installation_id: &str, request_id: &str) -> Result<Option<DeviceEntry>> {
        match self.automatic_for_grant(user_id, installation_id, request_id)? {
            Some(device) => self.revoke(&device.id),
            None => Ok(None),
        }
    }
}

/// The paired phones in the store at `root` (`terminalx-serve devices --data-dir`).
pub fn list_in(root: &Path) -> Result<Vec<DeviceEntry>> {
    Ok(read_in(root)?.devices.into_iter().filter(|device| device.revoked_at.is_none()).collect())
}

/// Revoke a paired phone in the store at `root`: the revoked record, if it was paired.
pub fn revoke_in(root: &Path, device_id: &str) -> Result<Option<DeviceEntry>> {
    rewrite_in(root, |file| {
        let Some(entry) = file.devices.iter_mut().find(|device| device.id == device_id && device.revoked_at.is_none()) else {
            return Ok((None, false));
        };
        entry.revoked_at = Some(Utc::now().to_rfc3339());
        Ok((Some(entry.clone()), true))
    })
}

pub fn load_account_mirror() -> Result<Option<AccountMirror>> {
    crate::store::read_json(&crate::store::root()?.join("account.json"))
}

pub fn save_account_mirror(mirror: &AccountMirror) -> Result<()> {
    crate::store::write_json(&crate::store::root()?.join("account.json"), mirror)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::mobile::model::DeviceScope;

    fn device(id: &str, token: &str, provenance: DeviceProvenance) -> DeviceEntry {
        DeviceEntry {
            id: id.into(),
            label: "Phone".into(),
            platform: "ios".into(),
            token: token_hash(token),
            scope: DeviceScope::Driver,
            provenance,
            bound_user_id: (provenance == DeviceProvenance::Automatic).then(|| "user".into()),
            binding_generation: 4,
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
        }
    }

    #[test]
    fn binding_generation_fences_only_account_pairings() {
        let _home = crate::store::temp_home();
        let registry = DeviceRegistry;
        registry
            .add(device("automatic", "auto", DeviceProvenance::Automatic))
            .unwrap();
        registry
            .add(device("explicit", "qr", DeviceProvenance::Explicit))
            .unwrap();

        assert!(registry.find_by_token("auto", Some(4)).unwrap().is_some());
        assert!(registry.find_by_token("auto", Some(5)).unwrap().is_none());
        assert!(registry.find_by_token("qr", Some(5)).unwrap().is_some());
    }

    #[test]
    fn sign_out_removes_only_automatic_devices() {
        let _home = crate::store::temp_home();
        let registry = DeviceRegistry;
        registry
            .add(device("a", "a", DeviceProvenance::Automatic))
            .unwrap();
        registry
            .add(device("e", "e", DeviceProvenance::Explicit))
            .unwrap();

        let removed = registry.revoke_automatic_for_user("user").unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(registry.list().unwrap()[0].id, "e");
    }

    #[test]
    fn startup_removes_only_credentials_that_never_authenticated() {
        let _home = crate::store::temp_home();
        let registry = DeviceRegistry;
        let mut connected = device("connected", "one", DeviceProvenance::Explicit);
        connected.last_seen_at = Some(Utc::now().to_rfc3339());
        registry.add(connected).unwrap();
        registry
            .add(device("pending", "two", DeviceProvenance::Explicit))
            .unwrap();

        assert_eq!(registry.remove_unclaimed().unwrap(), ["pending"]);
        assert_eq!(registry.list().unwrap()[0].id, "connected");
    }

    #[test]
    fn failed_pairing_discards_only_an_unclaimed_device() {
        let _home = crate::store::temp_home();
        let registry = DeviceRegistry;
        let mut connected = device("connected", "one", DeviceProvenance::Explicit);
        connected.last_seen_at = Some(Utc::now().to_rfc3339());
        registry.add(connected).unwrap();
        registry
            .add(device("pending", "two", DeviceProvenance::Explicit))
            .unwrap();

        assert!(registry.discard_unclaimed("pending").unwrap());
        assert!(!registry.discard_unclaimed("connected").unwrap());
        assert_eq!(registry.list().unwrap()[0].id, "connected");
    }

    #[test]
    fn a_change_by_one_process_is_never_undone_by_the_other() {
        // The window and the runtime each hold a registry; neither may write
        // back a stale copy over the other's change (PRO-359).
        let _home = crate::store::temp_home();
        let (window, runtime) = (DeviceRegistry, DeviceRegistry);
        window.add(device("phone", "one", DeviceProvenance::Explicit)).unwrap();
        window.add(device("tablet", "two", DeviceProvenance::Explicit)).unwrap();
        assert!(runtime.find_by_token("one", None).unwrap().is_some(), "a device the window added is admitted by the runtime");

        window.revoke("tablet").unwrap();
        runtime.touch("phone", "key", "fingerprint", PairingTransport::Direct).unwrap();
        let listed = window.list().unwrap();
        assert_eq!(listed.iter().map(|device| device.id.as_str()).collect::<Vec<_>>(), ["phone"], "the revoke stays");
        assert!(listed[0].last_seen_at.is_some(), "and so does the runtime's touch");
        assert!(runtime.find_by_token("two", None).unwrap().is_none(), "a revoked device is refused at once");
    }
}
