//! The one place this process calls the macOS Keychain.
//!
//! Every call is made one at a time. Security.framework's file-keychain code
//! deadlocks against itself when a write and a read of the same item overlap:
//! `SecItemAdd` of an item that already exists holds the keychain's mutex and
//! then waits for the existing item's (`KeychainImpl::add` → `ItemImpl::doChange`
//! → `checkIntegrity` → `dbUniqueRecord`), while `SecItemCopyMatching` of that
//! item holds the item's mutex and waits for the keychain's
//! (`ItemImpl::getContent` → `checkIntegrity` →
//! `KeychainImpl::hasIntegrityProtection`). Neither ever returns, and every
//! later Keychain call in the process waits behind them.
//!
//! A call can also simply be slow (a locked keychain, a permission prompt).
//! Callers therefore never make one on the main thread, and never while
//! holding a lock that the main thread or a cheap read takes.

use anyhow::Result;

/// A secret store addressed like the Keychain's generic passwords. The account
/// session goes through this so tests can stand in a slow or blocked store.
pub(crate) trait SecretStore: Send + Sync {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>>;
    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<()>;
    fn delete(&self, service: &str, account: &str) -> Result<()>;
}

/// The login Keychain on macOS, and a DPAPI-sealed store of this account's
/// own on Windows. Elsewhere nothing is stored: reads find nothing and writes
/// fail.
pub(crate) struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>> {
        get(service, account)
    }

    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<()> {
        set(service, account, secret)
    }

    fn delete(&self, service: &str, account: &str) -> Result<()> {
        delete(service, account)
    }
}

#[cfg(all(target_os = "macos", not(test)))]
mod imp {
    use std::sync::{Mutex, MutexGuard, PoisonError};

    use anyhow::Result;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    const NOT_FOUND: i32 = -25_300; // errSecItemNotFound

    /// Held for the length of one Security.framework call, and never while
    /// taking another lock.
    fn gate() -> MutexGuard<'static, ()> {
        static GATE: Mutex<()> = Mutex::new(());
        GATE.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
        let _gate = gate();
        match get_generic_password(service, account) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.code() == NOT_FOUND => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<()> {
        let _gate = gate();
        Ok(set_generic_password(service, account, secret)?)
    }

    pub fn delete(service: &str, account: &str) -> Result<()> {
        let _gate = gate();
        match delete_generic_password(service, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == NOT_FOUND => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

/// Windows: each secret sealed with DPAPI for this account on this machine,
/// in an owner-only folder of its own (see [`windows_store`]).
#[cfg(all(windows, not(test)))]
mod imp {
    use anyhow::{Context, Result};

    fn store() -> Result<std::path::PathBuf> {
        Ok(dirs::data_local_dir().context("this account has no local application data folder")?.join("TerminalX").join("secrets"))
    }

    pub fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
        super::windows_store::get(&store()?, service, account)
    }

    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<()> {
        super::windows_store::set(&store()?, service, account, secret)
    }

    pub fn delete(service: &str, account: &str) -> Result<()> {
        super::windows_store::delete(&store()?, service, account)
    }
}

/// The Windows secret store, in a folder given by the caller (tests use their
/// own). The Keychain's generic passwords are per user and keyed by service
/// and account; so is this:
///
/// - each secret is one file, named by a SHA-256 of its service and account,
///   so the names say nothing about what is kept;
/// - its content is the secret sealed with DPAPI for this Windows account on
///   this machine, with the service and account as the sealing's entropy, so
///   a sealed secret moved to another entry's file does not open there;
/// - the folder and every file are owner-only (`win::fs`), files are replaced
///   in one rename, and a link or a file another account can open is refused.
#[cfg(windows)]
mod windows_store {
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, PoisonError};

    use anyhow::{Context, Result};
    use sha2::{Digest, Sha256};

    /// One call at a time, as on macOS: a read never sees half of a replace.
    static GATE: Mutex<()> = Mutex::new(());

    fn entropy(service: &str, account: &str) -> Vec<u8> {
        format!("terminalx secret v1\0{service}\0{account}").into_bytes()
    }

    fn file(store: &Path, service: &str, account: &str) -> PathBuf {
        let digest = Sha256::digest(format!("{service}\0{account}").as_bytes());
        store.join(format!("{digest:x}.secret"))
    }

    pub fn get(store: &Path, service: &str, account: &str) -> Result<Option<Vec<u8>>> {
        let _gate = GATE.lock().unwrap_or_else(PoisonError::into_inner);
        let path = file(store, service, account);
        if std::fs::symlink_metadata(&path).is_err() {
            return Ok(None);
        }
        let mut sealed = Vec::new();
        crate::win::fs::open_private(&path).context("read a stored secret")?.read_to_end(&mut sealed)?;
        let secret = crate::win::dpapi::unprotect(&sealed, &entropy(service, account)).context("open a stored secret")?;
        Ok(Some(secret))
    }

    pub fn set(store: &Path, service: &str, account: &str, secret: &[u8]) -> Result<()> {
        let _gate = GATE.lock().unwrap_or_else(PoisonError::into_inner);
        crate::win::fs::create_private_dir_all(store).context("create the secret store")?;
        let sealed = crate::win::dpapi::protect(secret, &entropy(service, account)).context("seal a secret")?;
        let path = file(store, service, account);
        let staged = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4().simple()));
        let written = (|| -> Result<()> {
            let mut out = crate::win::fs::create_private(&staged, true)?;
            out.write_all(&sealed)?;
            out.sync_all()?;
            drop(out);
            std::fs::rename(&staged, &path)?;
            Ok(())
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&staged);
        }
        written.context("store a secret")
    }

    pub fn delete(store: &Path, service: &str, account: &str) -> Result<()> {
        let _gate = GATE.lock().unwrap_or_else(PoisonError::into_inner);
        match std::fs::remove_file(file(store, service, account)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("remove a stored secret"),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_secret_is_kept_sealed_private_and_only_for_its_own_entry() {
            let dir = tempfile::tempdir().unwrap();
            let store = dir.path().join("secrets");
            assert_eq!(get(&store, "svc", "acct").unwrap(), None);
            set(&store, "svc", "acct", b"refresh-token-1").unwrap();
            set(&store, "svc", "acct", b"refresh-token-2").unwrap();
            assert_eq!(get(&store, "svc", "acct").unwrap().as_deref(), Some(&b"refresh-token-2"[..]));
            assert_eq!(get(&store, "svc", "other").unwrap(), None);
            crate::win::security::verify_private(&store).unwrap();
            let path = file(&store, "svc", "acct");
            crate::win::security::verify_private(&path).unwrap();
            let raw = std::fs::read(&path).unwrap();
            assert!(!raw.windows(15).any(|window| window == b"refresh-token-2"), "sealed, not plain");
            assert_eq!(std::fs::read_dir(&store).unwrap().count(), 1, "no staged file is left behind");
            // Sealed for one entry, it does not open as another.
            std::fs::copy(&path, file(&store, "svc", "moved")).unwrap();
            assert!(get(&store, "svc", "moved").is_err());
            delete(&store, "svc", "acct").unwrap();
            delete(&store, "svc", "acct").unwrap();
            assert_eq!(get(&store, "svc", "acct").unwrap(), None);
        }
    }
}

/// Linux: the desktop's keyring, through the Secret Service (GNOME Keyring,
/// KWallet), one item per service and account. With no keyring running, or one
/// left locked, a call fails with what to do ([`keyring_message`]): nothing
/// secret is ever written to a file instead.
#[cfg(all(target_os = "linux", feature = "desktop", not(test)))]
mod imp {
    pub use super::linux_store::{delete, get, set};
}

/// The Linux store itself, built in tests too so CI can run it against a real keyring
/// (`linux_store_tests`, under `dbus-run-session` with GNOME Keyring).
#[cfg(all(target_os = "linux", feature = "desktop"))]
mod linux_store {
    use std::collections::HashMap;
    use std::sync::{Mutex, MutexGuard, PoisonError};

    use anyhow::{anyhow, Result};
    use secret_service::blocking::{Collection, Item, SecretService};
    use secret_service::{EncryptionType, Error};

    use super::{keyring_message, KeyringProblem};

    const CONTENT_TYPE: &str = "application/octet-stream";

    /// One call at a time, as on macOS: an unlock prompt is answered once.
    fn gate() -> MutexGuard<'static, ()> {
        static GATE: Mutex<()> = Mutex::new(());
        GATE.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn attributes<'a>(service: &'a str, account: &'a str) -> HashMap<&'a str, &'a str> {
        HashMap::from([("service", service), ("account", account)])
    }

    fn explain(error: Error) -> anyhow::Error {
        let problem = match error {
            Error::Unavailable => KeyringProblem::Missing,
            Error::Locked | Error::Prompt | Error::PromptDisconnected => KeyringProblem::Locked,
            _ => KeyringProblem::Failed,
        };
        anyhow!(keyring_message(problem, &error.to_string()))
    }

    /// No session bus or no keyring on it: either way there is no keyring to use.
    fn connect() -> Result<SecretService<'static>> {
        SecretService::connect(EncryptionType::Dh).map_err(|error| anyhow!(keyring_message(KeyringProblem::Missing, &error.to_string())))
    }

    fn unlocked(item: &Item<'_>) -> Result<()> {
        if item.is_locked().map_err(explain)? {
            item.unlock().map_err(explain)?;
        }
        Ok(())
    }

    /// The default collection (the login keyring), or any there is, unlocked.
    fn collection<'a>(store: &'a SecretService<'a>) -> Result<Collection<'a>> {
        let collection = store.get_default_collection().or_else(|_| store.get_any_collection()).map_err(explain)?;
        if collection.is_locked().map_err(explain)? {
            collection.unlock().map_err(explain)?;
        }
        Ok(collection)
    }

    fn found<'a>(store: &'a SecretService<'a>, service: &str, account: &str) -> Result<Vec<Item<'a>>> {
        let result = store.search_items(attributes(service, account)).map_err(explain)?;
        Ok(result.unlocked.into_iter().chain(result.locked).collect())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
        let _gate = gate();
        let store = connect()?;
        let items = found(&store, service, account)?;
        let Some(item) = items.first() else { return Ok(None) };
        unlocked(item)?;
        Ok(Some(item.get_secret().map_err(explain)?))
    }

    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<()> {
        let _gate = gate();
        let store = connect()?;
        let label = format!("TerminalX: {service} ({account})");
        collection(&store)?.create_item(&label, attributes(service, account), secret, true, CONTENT_TYPE).map_err(explain)?;
        Ok(())
    }

    pub fn delete(service: &str, account: &str) -> Result<()> {
        let _gate = gate();
        let store = connect()?;
        for item in found(&store, service, account)? {
            unlocked(&item)?;
            item.delete().map_err(explain)?;
        }
        Ok(())
    }
}

/// A round trip through the desktop's keyring. Ignored by default: CI runs it on
/// Linux with `--ignored` inside `dbus-run-session`, GNOME Keyring unlocked.
#[cfg(all(target_os = "linux", feature = "desktop", test))]
mod linux_store_tests {
    #[test]
    #[ignore = "needs a running, unlocked Secret Service"]
    fn a_secret_round_trips_through_the_system_keyring() {
        let (service, account) = ("terminalx-ci-test", "round-trip");
        super::linux_store::delete(service, account).unwrap();
        assert_eq!(super::linux_store::get(service, account).unwrap(), None);
        super::linux_store::set(service, account, b"first").unwrap();
        super::linux_store::set(service, account, b"second").unwrap();
        assert_eq!(super::linux_store::get(service, account).unwrap().as_deref(), Some(&b"second"[..]));
        super::linux_store::delete(service, account).unwrap();
        assert_eq!(super::linux_store::get(service, account).unwrap(), None);
    }
}

/// Why the Linux keyring could not be used.
#[cfg_attr(not(all(target_os = "linux", feature = "desktop")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyringProblem {
    /// No Secret Service on the session bus, or no session bus.
    Missing,
    /// The keyring is locked and its unlock prompt was dismissed.
    Locked,
    /// Any other failure, with the keyring's own words.
    Failed,
}

/// What a keyring failure says, and what to do about it.
#[cfg_attr(not(all(target_os = "linux", feature = "desktop")), allow(dead_code))]
fn keyring_message(problem: KeyringProblem, detail: &str) -> String {
    match problem {
        KeyringProblem::Missing => format!(
            "No system keyring is running. TerminalX keeps your sign-in and keys in the desktop's keyring (the Secret Service, such as GNOME Keyring or KWallet), never in a plain file. Install or start one, sign in to the desktop again, then try again. ({detail})"
        ),
        KeyringProblem::Locked => "The system keyring is locked and was not unlocked. Unlock it when it asks, then try again.".to_string(),
        KeyringProblem::Failed => format!("The system keyring could not be used: {detail}"),
    }
}

/// Tests never reach the real login Keychain: they use an in-memory store.
#[cfg(any(not(any(target_os = "macos", windows, all(target_os = "linux", feature = "desktop"))), test))]
mod imp {
    use anyhow::{anyhow, Result};

    pub fn get(_service: &str, _account: &str) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }

    pub fn set(_service: &str, _account: &str, _secret: &[u8]) -> Result<()> {
        Err(anyhow!("no secret store is available on this system"))
    }

    pub fn delete(_service: &str, _account: &str) -> Result<()> {
        Ok(())
    }
}

/// The secret stored for `(service, account)`, or `None` when there is none.
pub(crate) fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
    imp::get(service, account)
}

/// Store (or replace) the secret for `(service, account)`.
pub(crate) fn set(service: &str, account: &str, secret: &[u8]) -> Result<()> {
    imp::set(service, account, secret)
}

/// Remove the secret for `(service, account)`; removing a missing one succeeds.
pub(crate) fn delete(service: &str, account: &str) -> Result<()> {
    imp::delete(service, account)
}

/// An in-memory [`SecretStore`] for tests. It can be told to block inside a
/// write, as a Keychain call waiting on a prompt or on Security.framework would.
#[cfg(test)]
pub(crate) mod testing {
    use std::collections::HashMap;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    use anyhow::Result;

    use super::SecretStore;

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(crate) enum Call {
        Get,
        Set(Vec<u8>),
        Delete,
    }

    #[derive(Default)]
    struct State {
        secrets: HashMap<(String, String), Vec<u8>>,
        calls: Vec<Call>,
        /// Writes block while this is set.
        blocked: bool,
        /// How many calls are waiting inside the store right now.
        waiting: usize,
        fail_writes: bool,
        #[cfg(all(feature = "desktop", target_os = "macos"))]
        fail_reads: bool,
    }

    type Check = Box<dyn Fn() + Send>;

    #[derive(Clone, Default)]
    pub(crate) struct MemorySecrets {
        state: Arc<(Mutex<State>, Condvar)>,
        /// Run at the start of every call, e.g. to check a lock is not held.
        on_call: Arc<Mutex<Option<Check>>>,
    }

    impl MemorySecrets {
        pub fn block_writes(&self) {
            self.state.0.lock().unwrap().blocked = true;
        }

        pub fn release(&self) {
            self.state.0.lock().unwrap().blocked = false;
            self.state.1.notify_all();
        }

        #[cfg(all(feature = "desktop", target_os = "macos"))]
        pub fn fail_reads(&self, fail: bool) {
            self.state.0.lock().unwrap().fail_reads = fail;
        }

        pub fn fail_writes(&self, fail: bool) {
            self.state.0.lock().unwrap().fail_writes = fail;
        }

        pub fn on_call(&self, check: impl Fn() + Send + 'static) {
            *self.on_call.lock().unwrap() = Some(Box::new(check));
        }

        /// Wait until `count` writes are blocked inside the store.
        pub fn wait_for_blocked(&self, count: usize) {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut state = self.state.0.lock().unwrap();
            while state.waiting < count {
                let left = deadline.checked_duration_since(Instant::now()).expect("a write reached the store");
                state = self.state.1.wait_timeout(state, left).unwrap().0;
            }
        }

        pub fn calls(&self) -> Vec<Call> {
            self.state.0.lock().unwrap().calls.clone()
        }

        pub fn stored(&self, service: &str, account: &str) -> Option<Vec<u8>> {
            self.state.0.lock().unwrap().secrets.get(&(service.to_string(), account.to_string())).cloned()
        }

        fn enter(&self, call: Call, write: bool) -> std::sync::MutexGuard<'_, State> {
            if let Some(check) = self.on_call.lock().unwrap().as_ref() {
                check();
            }
            let mut state = self.state.0.lock().unwrap();
            state.calls.push(call);
            if write {
                state.waiting += 1;
                self.state.1.notify_all();
                while state.blocked {
                    state = self.state.1.wait(state).unwrap();
                }
                state.waiting -= 1;
            }
            state
        }
    }

    impl SecretStore for MemorySecrets {
        fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>> {
            let state = self.enter(Call::Get, false);
            #[cfg(all(feature = "desktop", target_os = "macos"))]
            if state.fail_reads {
                anyhow::bail!("the store refused the read");
            }
            Ok(state.secrets.get(&(service.to_string(), account.to_string())).cloned())
        }

        fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<()> {
            let mut state = self.enter(Call::Set(secret.to_vec()), true);
            if state.fail_writes {
                anyhow::bail!("the store refused the write");
            }
            state.secrets.insert((service.to_string(), account.to_string()), secret.to_vec());
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<()> {
            let mut state = self.enter(Call::Delete, true);
            if state.fail_writes {
                anyhow::bail!("the store refused the delete");
            }
            state.secrets.remove(&(service.to_string(), account.to_string()));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_missing_or_locked_linux_keyring_says_what_to_do_and_keeps_nothing_elsewhere() {
        let missing = super::keyring_message(super::KeyringProblem::Missing, "no secret service provider or dbus session found");
        assert!(missing.starts_with("No system keyring is running."), "{missing}");
        assert!(missing.contains("GNOME Keyring or KWallet") && missing.contains("never in a plain file"), "{missing}");
        assert!(super::keyring_message(super::KeyringProblem::Locked, "").contains("Unlock it when it asks"));
        assert_eq!(super::keyring_message(super::KeyringProblem::Failed, "zbus error"), "The system keyring could not be used: zbus error");
    }

    /// A synchronous Tauri command runs on the main thread. These reach the
    /// Keychain (or wait for something that does), so each must be `async`
    /// and do its work on a blocking thread.
    #[test]
    fn no_command_that_reaches_the_keychain_runs_on_the_main_thread() {
        let sources = [include_str!("commands.rs"), include_str!("cloud_remote.rs"), include_str!("cloud_agent_client.rs")].concat();
        let commands = [
            "account_status",
            "account_refresh_roles",
            "account_sign_in",
            "account_paste_callback",
            "account_sign_out",
            "organization_create",
            "organization_select",
            "organization_computer_save",
            "pairing_status",
            "pairing_generate",
            "pairing_revoke",
            "cloud_remote_attach",
            "cloud_remote_activate",
            "cloud_remote_detach",
            "cloud_agent_enqueue",
            "cloud_agent_checkpoint",
            "cloud_agent_has_key",
            "cloud_agent_outbox_sync",
            "cloud_agent_purge_workspace",
        ];
        for command in commands {
            assert!(sources.contains(&format!("pub async fn {command}(")), "{command} must be an async command");
            assert!(!sources.contains(&format!("pub fn {command}(")), "{command} must not run on the main thread");
        }
        // The launch-time cleanup of unclaimed device tokens is handed to a blocking thread.
        let pairing = include_str!("pairing/mod.rs");
        let configure = &pairing[pairing.find("pub fn configure(").unwrap()..pairing.find("pub fn attach_sessions").unwrap()];
        assert!(!configure.contains("delete_device_token"), "configure runs on the main thread");
        assert!(configure.contains("spawn_blocking(move || manager.forget_device_tokens"));
    }
}
