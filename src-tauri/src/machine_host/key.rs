//! The machine's one host key (docs/MACHINES.md decision 4).
//!
//! On a Mac the key is the phone pairing key the app keeps in its Keychain
//! item `<app identifier>.pairing` / `host-e2ee-key`. That item trusts only
//! the app that made it, and this runtime is another executable, so the
//! window hands the runtime the item's bytes once ([`KeyStore::adopt`]) and
//! the runtime keeps them in an item of its own,
//! `<app identifier>.machine-host` / `host-e2ee-key`. It never makes a key of
//! its own there: a new key would be a new machine to every phone.
//!
//! A runtime the app did not launch (a headless server, a test) owns its key
//! outright, in `<data dir>/machine-host/host-key.json`, mode 0600, made the
//! first time it is needed and never made again.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::keychain::SecretStore;
use crate::relay_e2ee::HostKeypair;

const ACCOUNT: &str = "host-e2ee-key";
const FILE: &str = "host-key.json";

/// Where the key lives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Location {
    /// The runtime's own Keychain item; filled only by the window.
    Keychain { service: String },
    /// A file this runtime owns.
    File { path: PathBuf },
}

pub(crate) struct KeyStore {
    location: Location,
    secrets: Arc<dyn SecretStore>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyFile {
    v: u8,
    secret_b64: String,
}

/// The Keychain service of a desktop-launched runtime, from the variables the
/// app's launcher sets (`local_runtime/launch.rs`). `None` elsewhere.
fn desktop_service(desktop: Option<&str>, application: Option<&str>) -> Option<String> {
    if !cfg!(target_os = "macos") || desktop != Some("1") {
        return None;
    }
    let application = application?;
    let valid = application.len() <= 255
        && application.contains('.')
        && application.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
    valid.then(|| format!("{application}.machine-host"))
}

/// [`desktop_service`] for this runtime.
fn runtime_service() -> Option<String> {
    desktop_service(
        std::env::var("TERMINALX_LOCAL_DESKTOP").ok().as_deref(),
        std::env::var("TERMINALX_LOCAL_APPLICATION").ok().as_deref(),
    )
}

/// Whether this runtime's host key is the window's, handed over from the
/// app's Keychain item, rather than one it keeps itself.
pub(crate) fn window_owned() -> bool {
    runtime_service().is_some()
}

impl KeyStore {
    /// The store this runtime uses, under `data_dir`.
    pub(crate) fn for_runtime(data_dir: &Path) -> Self {
        let service = runtime_service();
        let location = match service {
            Some(service) => Location::Keychain { service },
            None => Location::File { path: data_dir.join(super::DIR).join(FILE) },
        };
        Self { location, secrets: Arc::new(crate::keychain::Keychain) }
    }

    #[cfg(test)]
    pub(crate) fn at(location: Location, secrets: Arc<dyn SecretStore>) -> Self {
        Self { location, secrets }
    }

    #[cfg(all(test, feature = "desktop", target_os = "macos"))]
    pub(super) fn with_secrets_for_test(mut self, secrets: Arc<dyn SecretStore>) -> Self {
        self.secrets = secrets;
        self
    }

    /// Whether the window owns the key and must hand it over.
    pub(crate) fn needs_window(&self) -> bool {
        matches!(self.location, Location::Keychain { .. })
    }

    /// The key, making one first where this runtime owns it. `None` while a
    /// desktop-launched runtime waits for the window's bytes. Blocking: a
    /// Keychain call can wait on the system.
    pub(crate) fn load(&self) -> Result<Option<HostKeypair>> {
        if let Some(secret) = self.read()? {
            return Ok(Some(HostKeypair::from_secret(secret)));
        }
        match &self.location {
            Location::Keychain { .. } => Ok(None),
            Location::File { .. } => {
                let keypair = HostKeypair::generate();
                self.write(keypair.secret())?;
                Ok(Some(keypair))
            }
        }
    }

    /// Keep the window's key. The same bytes again change nothing; other
    /// bytes than the key already kept are refused, so a machine never
    /// changes its identity underneath its paired computers and phones.
    pub(crate) fn adopt(&self, secret: [u8; 32]) -> Result<HostKeypair> {
        if !self.needs_window() {
            bail!("this runtime keeps its own host key");
        }
        if let Some(held) = self.read()? {
            if !bool::from(held.ct_eq(&secret)) {
                bail!("the window's host key differs from the one this runtime keeps");
            }
            return Ok(HostKeypair::from_secret(held));
        }
        self.write(&secret)?;
        Ok(HostKeypair::from_secret(secret))
    }

    /// Whether a key is kept already.
    pub(crate) fn exists(&self) -> Result<bool> {
        Ok(self.read()?.is_some())
    }

    /// Keep `secret` as this runtime's own key if it has none yet: a server
    /// first started with `--relay-link` takes the link's key, so the relay
    /// and the direct listener answer with one key.
    pub(crate) fn seed(&self, secret: [u8; 32]) -> Result<()> {
        if self.needs_window() {
            bail!("the window owns this machine's host key");
        }
        if self.exists()? {
            bail!("this runtime keeps a host key already");
        }
        self.write(&secret)
    }

    fn read(&self) -> Result<Option<[u8; 32]>> {
        let bytes = match &self.location {
            Location::Keychain { service } => self.secrets.get(service, ACCOUNT).context("read the machine host key from the Keychain")?,
            Location::File { path } => match std::fs::read(path) {
                Ok(bytes) => {
                    let file: KeyFile = serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
                    if file.v != 1 {
                        bail!("unsupported host key file version {}", file.v);
                    }
                    Some(STANDARD.decode(file.secret_b64).context("decode the machine host key")?)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
            },
        };
        bytes
            .map(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| anyhow!("the machine host key has an invalid length")))
            .transpose()
    }

    fn write(&self, secret: &[u8; 32]) -> Result<()> {
        match &self.location {
            Location::Keychain { service } => self.secrets.set(service, ACCOUNT, secret).context("keep the machine host key in the Keychain"),
            Location::File { path } => {
                super::private_dir(path.parent().ok_or_else(|| anyhow!("host key path has no parent"))?)?;
                let file = KeyFile { v: 1, secret_b64: STANDARD.encode(secret) };
                crate::cloud_bootstrap::write_durable(path, &zeroize::Zeroizing::new(serde_json::to_vec(&file)?))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::testing::MemorySecrets;

    #[test]
    fn a_runtime_the_app_launched_uses_its_own_keychain_item_and_others_a_file() {
        let expected = cfg!(target_os = "macos").then(|| "com.terminalx.next.machine-host".to_string());
        assert_eq!(desktop_service(Some("1"), Some("com.terminalx.next")), expected);
        assert_eq!(desktop_service(None, Some("com.terminalx.next")), None);
        assert_eq!(desktop_service(Some("1"), None), None);
        assert_eq!(desktop_service(Some("1"), Some("no-dot")), None);
        assert_eq!(desktop_service(Some("1"), Some("com.x/../y")), None);
    }

    #[test]
    fn a_file_key_is_made_once_kept_private_and_never_made_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(super::super::DIR).join(FILE);
        let store = KeyStore::at(Location::File { path: path.clone() }, Arc::new(MemorySecrets::default()));
        let first = store.load().unwrap().unwrap();
        let again = store.load().unwrap().unwrap();
        assert_eq!(first.public(), again.public());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert!(store.adopt([1; 32]).is_err(), "a runtime that owns its key takes none from a window");
    }

    #[test]
    fn a_desktop_runtime_waits_for_the_windows_key_and_keeps_its_bytes() {
        let secrets = Arc::new(MemorySecrets::default());
        let store = KeyStore::at(Location::Keychain { service: "com.terminalx.next.machine-host".into() }, secrets.clone());
        assert!(store.load().unwrap().is_none(), "never made here");
        let adopted = store.adopt([1; 32]).unwrap();
        // Test vector from docs/MACHINES.md: the machineId of a key is its relay host id.
        assert_eq!(HostKeypair::from_secret([1; 32]).host_id(), adopted.host_id());
        assert_eq!(store.load().unwrap().unwrap().secret(), &[1; 32]);
        assert!(store.adopt([1; 32]).is_ok(), "the same bytes again");
        assert!(store.adopt([2; 32]).is_err(), "other bytes are refused");
        assert_eq!(store.load().unwrap().unwrap().secret(), &[1; 32]);
    }
}
