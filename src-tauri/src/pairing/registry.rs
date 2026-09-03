use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use subtle::ConstantTimeEq;

use super::crypto::{token_hash, HostKeypair};
use super::model::{AccountMirror, DeviceEntry, DeviceFile, DeviceProvenance};

const HOST_KEY_ACCOUNT: &str = "host-e2ee-key";
const KEYCHAIN_NOT_FOUND: i32 = -25_300;

#[derive(Default)]
pub struct PairingSecrets {
    service: OnceLock<String>,
}

impl PairingSecrets {
    pub fn configure(&self, app_identifier: &str) -> Result<()> {
        let wanted = format!("{app_identifier}.pairing");
        if let Some(current) = self.service.get() {
            return (current == &wanted)
                .then_some(())
                .ok_or_else(|| anyhow!("pairing secret service was already configured"));
        }
        self.service
            .set(wanted)
            .map_err(|_| anyhow!("pairing secret service was already configured"))
    }

    pub fn host_key(&self, create: bool) -> Result<Option<HostKeypair>> {
        if let Some(bytes) = self.read(HOST_KEY_ACCOUNT)? {
            let secret: [u8; 32] = bytes
                .try_into()
                .map_err(|_| anyhow!("saved host E2EE key has an invalid length"))?;
            return Ok(Some(HostKeypair::from_secret(secret)));
        }
        if !create {
            return Ok(None);
        }
        let keypair = HostKeypair::generate();
        self.write(HOST_KEY_ACCOUNT, keypair.secret())?;
        Ok(Some(keypair))
    }

    pub fn save_device_token(&self, device_id: &str, token: &str) -> Result<()> {
        self.write(&device_account(device_id), token.as_bytes())
    }

    pub fn delete_device_token(&self, device_id: &str) -> Result<()> {
        self.delete(&device_account(device_id))
    }

    fn service(&self) -> Result<&str> {
        self.service
            .get()
            .map(String::as_str)
            .ok_or_else(|| anyhow!("pairing secret service is not configured"))
    }

    #[cfg(target_os = "macos")]
    fn read(&self, account: &str) -> Result<Option<Vec<u8>>> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(self.service()?, account) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.code() == KEYCHAIN_NOT_FOUND => Ok(None),
            Err(error) => Err(error).context("read pairing secret from Keychain"),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn read(&self, _account: &str) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }

    #[cfg(target_os = "macos")]
    fn write(&self, account: &str, bytes: &[u8]) -> Result<()> {
        use security_framework::passwords::set_generic_password;
        set_generic_password(self.service()?, account, bytes)
            .context("save pairing secret to Keychain")
    }

    #[cfg(not(target_os = "macos"))]
    fn write(&self, _account: &str, _bytes: &[u8]) -> Result<()> {
        Err(anyhow!("macOS Keychain is unavailable"))
    }

    #[cfg(target_os = "macos")]
    fn delete(&self, account: &str) -> Result<()> {
        use security_framework::passwords::delete_generic_password;
        match delete_generic_password(self.service()?, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == KEYCHAIN_NOT_FOUND => Ok(()),
            Err(error) => Err(error).context("delete pairing secret from Keychain"),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn delete(&self, _account: &str) -> Result<()> {
        Ok(())
    }
}

fn device_account(device_id: &str) -> String {
    format!("device-{device_id}")
}

#[derive(Default)]
pub struct DeviceRegistry {
    inner: Mutex<Option<DeviceFile>>,
}

impl DeviceRegistry {
    pub fn list(&self) -> Result<Vec<DeviceEntry>> {
        let mut inner = self.inner.lock().unwrap();
        let file = ensure_loaded(&mut inner)?;
        Ok(file
            .devices
            .iter()
            .filter(|device| device.revoked_at.is_none())
            .cloned()
            .collect())
    }

    pub fn add(&self, entry: DeviceEntry) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let file = ensure_loaded(&mut inner)?;
        file.devices.retain(|device| device.id != entry.id);
        file.devices.push(entry);
        save(file)
    }

    pub fn remove_unclaimed(&self) -> Result<Vec<String>> {
        let mut inner = self.inner.lock().unwrap();
        let file = ensure_loaded(&mut inner)?;
        let mut removed = Vec::new();
        file.devices.retain(|device| {
            let unclaimed = device.last_seen_at.is_none();
            if unclaimed {
                removed.push(device.id.clone());
            }
            !unclaimed
        });
        if !removed.is_empty() {
            save(file)?;
        }
        Ok(removed)
    }

    pub fn is_unclaimed(&self, device_id: &str) -> Result<bool> {
        Ok(self
            .list()?
            .into_iter()
            .any(|device| device.id == device_id && device.last_seen_at.is_none()))
    }

    pub fn discard_unclaimed(&self, device_id: &str) -> Result<bool> {
        let mut inner = self.inner.lock().unwrap();
        let file = ensure_loaded(&mut inner)?;
        let before = file.devices.len();
        file.devices
            .retain(|device| device.id != device_id || device.last_seen_at.is_some());
        let discarded = file.devices.len() != before;
        if discarded {
            save(file)?;
        }
        Ok(discarded)
    }

    pub fn find_by_token(
        &self,
        token: &str,
        binding_generation: Option<u64>,
    ) -> Result<Option<DeviceEntry>> {
        let candidate = token_hash(token);
        Ok(self.list()?.into_iter().find(|device| {
            device.token.as_bytes().ct_eq(candidate.as_bytes()).into()
                && binding_generation.is_none_or(|generation| {
                    device.provenance == DeviceProvenance::Explicit
                        || device.binding_generation == generation
                })
        }))
    }

    pub fn touch(&self, device_id: &str, public_key: &str) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let file = ensure_loaded(&mut inner)?;
        let device = file
            .devices
            .iter_mut()
            .find(|device| device.id == device_id && device.revoked_at.is_none())
            .ok_or_else(|| anyhow!("paired device was revoked"))?;
        if !device.public_key.is_empty() && device.public_key != public_key {
            return Err(anyhow!("paired device public key changed"));
        }
        device.public_key = public_key.into();
        device.last_seen_at = Some(Utc::now().to_rfc3339());
        save(file)
    }

    pub fn revoke(&self, device_id: &str) -> Result<Option<DeviceEntry>> {
        let mut inner = self.inner.lock().unwrap();
        let file = ensure_loaded(&mut inner)?;
        let entry = file
            .devices
            .iter_mut()
            .find(|device| device.id == device_id && device.revoked_at.is_none());
        let Some(entry) = entry else {
            return Ok(None);
        };
        entry.revoked_at = Some(Utc::now().to_rfc3339());
        let result = entry.clone();
        save(file)?;
        Ok(Some(result))
    }

    pub fn revoke_automatic_for_user(&self, user_id: &str) -> Result<Vec<DeviceEntry>> {
        let mut inner = self.inner.lock().unwrap();
        let file = ensure_loaded(&mut inner)?;
        let mut removed = Vec::new();
        file.devices.retain(|device| {
            let matches = device.provenance == DeviceProvenance::Automatic
                && device.bound_user_id.as_deref() == Some(user_id);
            if matches {
                removed.push(device.clone());
            }
            !matches
        });
        save(file)?;
        Ok(removed)
    }

    pub fn automatic_for_grant(
        &self,
        user_id: &str,
        installation_id: &str,
        request_id: &str,
    ) -> Result<Option<DeviceEntry>> {
        Ok(self.list()?.into_iter().find(|device| {
            device.provenance == DeviceProvenance::Automatic
                && device.bound_user_id.as_deref() == Some(user_id)
                && device.installation_id.as_deref() == Some(installation_id)
                && device.created_request_id.as_deref() == Some(request_id)
        }))
    }

    pub fn revoke_automatic_grant(
        &self,
        user_id: &str,
        installation_id: &str,
        request_id: &str,
    ) -> Result<Option<DeviceEntry>> {
        let found = self.automatic_for_grant(user_id, installation_id, request_id)?;
        if let Some(device) = found {
            self.revoke(&device.id)
        } else {
            Ok(None)
        }
    }
}

fn ensure_loaded(inner: &mut Option<DeviceFile>) -> Result<&mut DeviceFile> {
    if inner.is_none() {
        let path = crate::store::root()?.join("devices.json");
        *inner = Some(crate::store::read_json(&path)?.unwrap_or_default());
    }
    Ok(inner.as_mut().unwrap())
}

fn save(file: &DeviceFile) -> Result<()> {
    crate::store::write_json(&crate::store::root()?.join("devices.json"), file)
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
    use crate::pairing::model::{DeviceProvenance, DeviceScope};

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
        }
    }

    #[test]
    fn binding_generation_fences_only_account_pairings() {
        let _home = crate::store::temp_home();
        let registry = DeviceRegistry::default();
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
        let registry = DeviceRegistry::default();
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
        let registry = DeviceRegistry::default();
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
        let registry = DeviceRegistry::default();
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
}
