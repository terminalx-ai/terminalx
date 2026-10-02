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

/// The login Keychain. Elsewhere than macOS nothing is stored: reads find
/// nothing and writes fail.
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

/// Tests never reach the real login Keychain: they use an in-memory store.
#[cfg(any(not(target_os = "macos"), test))]
mod imp {
    use anyhow::{anyhow, Result};

    pub fn get(_service: &str, _account: &str) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }

    pub fn set(_service: &str, _account: &str, _secret: &[u8]) -> Result<()> {
        Err(anyhow!("macOS Keychain is unavailable"))
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
            Ok(self.enter(Call::Get, false).secrets.get(&(service.to_string(), account.to_string())).cloned())
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
            "account_sign_out",
            "organization_create",
            "organization_select",
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
