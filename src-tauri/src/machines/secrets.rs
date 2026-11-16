//! The operating computer's secrets in the login Keychain (docs/MACHINES.md,
//! "As built (PRO-342)"), service `<app identifier>.machines`:
//!
//! - `client-e2ee-key`: one long-lived X25519 key per installation, the E2EE
//!   client key on every connection to every machine. Each machine pins it.
//! - `machine:<machineId>`: the device token that machine paired this computer with.
//!
//! Tests keep them in memory (`keychain::tests::MemorySecrets`), never in the real Keychain.

use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Context, Result};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

use crate::keychain::SecretStore;

const CLIENT_KEY_ACCOUNT: &str = "client-e2ee-key";

pub struct MachineSecrets {
    service: OnceLock<String>,
    store: Arc<dyn SecretStore>,
}

impl Default for MachineSecrets {
    fn default() -> Self {
        Self { service: OnceLock::new(), store: Arc::new(crate::keychain::Keychain) }
    }
}

impl MachineSecrets {
    #[cfg(test)]
    pub fn with_store(store: Arc<dyn SecretStore>) -> Self {
        Self { service: OnceLock::new(), store }
    }

    pub fn configure(&self, app_identifier: &str) -> Result<()> {
        let wanted = format!("{app_identifier}.machines");
        match self.service.get() {
            Some(current) if *current == wanted => Ok(()),
            Some(_) => Err(anyhow!("machine secret service was already configured")),
            None => self.service.set(wanted).map_err(|_| anyhow!("machine secret service was already configured")),
        }
    }

    fn service(&self) -> Result<&str> {
        self.service.get().map(String::as_str).ok_or_else(|| anyhow!("machine secret service is not configured"))
    }

    /// This installation's client key, made the first time. Blocking.
    pub fn client_secret(&self) -> Result<Zeroizing<[u8; 32]>> {
        let service = self.service()?;
        if let Some(bytes) = self.store.get(service, CLIENT_KEY_ACCOUNT).context("read the client key from the Keychain")? {
            let bytes = Zeroizing::new(bytes);
            let secret: [u8; 32] = bytes.as_slice().try_into().map_err(|_| anyhow!("the saved client key has an invalid length"))?;
            return Ok(Zeroizing::new(secret));
        }
        let mut secret = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(secret.as_mut());
        self.store.set(service, CLIENT_KEY_ACCOUNT, secret.as_ref()).context("save the client key to the Keychain")?;
        Ok(secret)
    }

    pub fn save_token(&self, machine_id: &str, token: &str) -> Result<()> {
        self.store.set(self.service()?, &machine_account(machine_id), token.as_bytes()).context("save the machine's device token to the Keychain")
    }
}

fn machine_account(machine_id: &str) -> String {
    format!("machine:{machine_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::testing::MemorySecrets;

    #[test]
    fn one_client_key_per_installation_and_a_token_per_machine() {
        let store = Arc::new(MemorySecrets::default());
        let secrets = MachineSecrets::with_store(store.clone());
        assert!(secrets.client_secret().is_err(), "not configured");
        secrets.configure("ai.terminalx.app").unwrap();
        let first = secrets.client_secret().unwrap();
        assert_eq!(*secrets.client_secret().unwrap(), *first, "made once, then kept");
        assert!(store.get("ai.terminalx.app.machines", "client-e2ee-key").unwrap().is_some());
        secrets.save_token("cs1uhCLEB_ttCYaQ", "token").unwrap();
        assert_eq!(store.get("ai.terminalx.app.machines", "machine:cs1uhCLEB_ttCYaQ").unwrap().unwrap(), b"token");
        assert!(secrets.configure("another.app").is_err());
    }
}
