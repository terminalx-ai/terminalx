use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Context, Result};

use super::crypto::HostKeypair;
use crate::keychain::SecretStore;

const HOST_KEY_ACCOUNT: &str = "host-e2ee-key";

pub struct PairingSecrets {
    service: OnceLock<String>,
    store: Arc<dyn SecretStore>,
}

impl Default for PairingSecrets {
    fn default() -> Self {
        Self { service: OnceLock::new(), store: Arc::new(crate::keychain::Keychain) }
    }
}

impl PairingSecrets {
    /// Secrets kept in `store` instead of the login Keychain, for tests.
    #[cfg(test)]
    pub fn with_store(store: Arc<dyn SecretStore>) -> Self {
        Self { service: OnceLock::new(), store }
    }

    #[cfg(test)]
    pub fn service_name(&self) -> Option<&str> {
        self.service.get().map(String::as_str)
    }

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

    #[cfg(any(target_os = "macos", windows))]
    pub(super) fn window_consent_key(&self, create: bool) -> Result<Option<ring::signature::Ed25519KeyPair>> {
        use ring::signature::Ed25519KeyPair;
        use ring::rand::{SecureRandom, SystemRandom};

        const ACCOUNT: &str = "window-consent-signing-key";
        static INITIALIZE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _initialize = INITIALIZE.lock().unwrap();
        if let Some(bytes) = self.read(ACCOUNT)? {
            let seed = zeroize::Zeroizing::new(bytes);
            let key = Ed25519KeyPair::from_seed_unchecked(&seed)
                .map_err(|_| anyhow!("saved window consent key is invalid"))?;
            return Ok(Some(key));
        }
        if !create {
            return Ok(None);
        }

        let mut seed = zeroize::Zeroizing::new([0; 32]);
        SystemRandom::new().fill(seed.as_mut())
            .map_err(|_| anyhow!("generate window consent signing key"))?;
        let key = Ed25519KeyPair::from_seed_unchecked(seed.as_ref())
            .map_err(|_| anyhow!("initialize window consent signing key"))?;
        self.write(ACCOUNT, seed.as_ref())?;
        Ok(Some(key))
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

    // The login Keychain through `crate::keychain`, which makes Keychain calls
    // one at a time; tests use an in-memory store. Elsewhere than macOS
    // nothing is stored: reads find nothing, writes fail.
    fn read(&self, account: &str) -> Result<Option<Vec<u8>>> {
        self.store.get(self.service()?, account).context("read pairing secret from Keychain")
    }

    fn write(&self, account: &str, bytes: &[u8]) -> Result<()> {
        self.store.set(self.service()?, account, bytes).context("save pairing secret to Keychain")
    }

    fn delete(&self, account: &str) -> Result<()> {
        self.store.delete(self.service()?, account).context("delete pairing secret from Keychain")
    }
}

fn device_account(device_id: &str) -> String {
    format!("device-{device_id}")
}

/// The paired phones (`devices.json`), shared with the runtime's phone host.
pub use crate::phone::registry::{load_account_mirror, save_account_mirror, DeviceRegistry};
