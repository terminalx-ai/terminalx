//! Ownership and client lifetime of a local `terminalx-serve` process.
//!
//! The hook publication lock elects a discovery endpoint, not a store owner.
//! This lock is acquired before stores are opened and held until shutdown.
//! Client leases are independent of agent lifetime: losing a window is never
//! a stop request. Commands and idle shutdown serialize through one gate.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::control::ControlError;

#[cfg(unix)]
pub mod stream;
#[cfg(unix)]
pub(crate) mod window;
pub mod calls;
pub(crate) mod history;
pub mod mobile;
pub mod mobile_output;
#[cfg(all(target_os = "macos", feature = "local-ui"))]
pub(crate) mod platform;

fn native_tray() -> bool {
    #[cfg(all(target_os = "macos", feature = "local-ui"))]
    { platform::running() }
    #[cfg(not(all(target_os = "macos", feature = "local-ui")))]
    { false }
}
pub(crate) mod workspaces;
pub(crate) mod permissions;
pub(crate) mod scrollback;
pub(crate) mod idle;
#[cfg(unix)]
pub mod client;
#[cfg(unix)]
pub mod sessions;
#[cfg(unix)]
pub mod launch;
#[cfg(unix)]
pub mod bridge;
#[cfg(unix)]
pub mod desktop;
#[cfg(unix)]
pub mod terminals;
#[cfg(all(unix, feature = "desktop"))]
pub mod ui;

pub const PROTOCOL: u64 = 1;
pub const IDLE_GRACE: Duration = Duration::from_secs(60);
const LEASE_TIME: Duration = Duration::from_secs(20);
const MAX_CLIENTS: usize = 64;

pub struct Owner {
    _file: std::fs::File,
}

impl Owner {
    #[cfg(unix)]
    pub fn acquire(root: &Path) -> Result<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

        let run = root.join("run");
        match std::fs::DirBuilder::new().mode(0o700).create(&run) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error).context("create local runtime directory"),
        }
        let metadata = std::fs::symlink_metadata(&run)?;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            bail!("local runtime directory must be an owner-only directory, not a symlink");
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(run.join("local-runtime.lock"))
            .context("open local runtime ownership lock")?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            bail!("local runtime lock must be a private regular file with one link");
        }
        // SAFETY: the descriptor belongs to `file`, which stays open in Owner.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error()).context("another local runtime owns this data directory");
        }
        // An older desktop does not hold our new lock. Never reset its stores
        // or rotate its credentials while it is serving this home.
        if std::os::unix::net::UnixStream::connect(run.join("hooks.sock")).is_ok() {
            bail!("another TerminalX process is serving this data directory; attach to it or close it first");
        }
        Ok(Self { _file: file })
    }

    #[cfg(not(unix))]
    pub fn acquire(_root: &Path) -> Result<Self> {
        bail!("local background runtime ownership is not supported on this platform yet")
    }
}

struct State {
    starting: bool,
    leases: HashMap<String, Arc<Attachment>>,
    requests: usize,
    idle_since: Option<Instant>,
    stop_requested: bool,
    stop_failed: bool,
    exiting: bool,
}

/// A live UI attachment can delegate scoped sharing operations. Its grant
/// is checked again at the writer without acquiring the lifetime mutex.
/// Disconnect revokes this same object; renewal cannot resurrect a removed
/// attachment or a permit from another owner generation.
pub(crate) struct Attachment(Mutex<Option<Instant>>);

impl Attachment {
    pub(crate) fn valid(&self) -> bool { self.valid_at(Instant::now()) }

    fn valid_at(&self, now: Instant) -> bool {
        self.0.lock().unwrap().is_some_and(|deadline| deadline > now)
    }

    /// Linearize a write against detach/stop. The writer acquires this only
    /// after its sharing checks, and retains it through the actual write.
    pub(crate) fn enter(&self) -> Result<std::sync::MutexGuard<'_, Option<Instant>>> {
        let deadline = self.0.lock().unwrap();
        if deadline.is_none_or(|deadline| deadline <= Instant::now()) {
            bail!("The sharing attachment expired or disconnected before delivery.");
        }
        Ok(deadline)
    }

    fn revoke(&self) { *self.0.lock().unwrap() = None; }
}

pub struct Lifetime {
    #[cfg(unix)]
    pub(crate) window: window::Registry,
    epoch: String,
    stream_socket: std::sync::OnceLock<std::path::PathBuf>,
    grace: Duration,
    state: Mutex<State>,
}

pub struct RequestGuard(Arc<Lifetime>);

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().requests -= 1;
    }
}

fn unavailable() -> ControlError {
    ControlError::new("runtime_stopping", "The local runtime is stopping; no new work was accepted.", None::<String>)
}

impl Lifetime {
    pub fn new(grace: Duration) -> Arc<Self> {
        Arc::new(Self {
            #[cfg(unix)]
            window: window::Registry::default(),
            epoch: uuid::Uuid::new_v4().to_string(),
            stream_socket: std::sync::OnceLock::new(),
            grace,
            state: Mutex::new(State {
                starting: false,
                leases: HashMap::new(), requests: 0, idle_since: Some(Instant::now()),
                stop_requested: false, stop_failed: false, exiting: false,
            }),
        })
    }

    pub(crate) fn starting(grace: Duration) -> Arc<Self> {
        let lifetime = Self::new(grace);
        lifetime.state.lock().unwrap().starting = true;
        lifetime
    }

    pub(crate) fn ready(&self) {
        let mut state = self.state.lock().unwrap();
        state.starting = false;
        state.idle_since = Some(Instant::now());
    }

    pub fn enter(self: &Arc<Self>) -> Result<RequestGuard, ControlError> {
        self.enter_command(false)
    }

    pub(crate) fn enter_command(self: &Arc<Self>, stop_retry: bool) -> Result<RequestGuard, ControlError> {
        let mut state = self.state.lock().unwrap();
        if state.starting {
            return Err(ControlError::new("runtime_starting", "The local runtime is restoring its stores.", None::<String>));
        }
        if state.exiting || (state.stop_requested && !(stop_retry && state.stop_failed)) {
            return Err(unavailable());
        }
        state.requests += 1;
        Ok(RequestGuard(self.clone()))
    }

    pub fn status(&self) -> Value {
        let mut state = self.state.lock().unwrap();
        let now = Instant::now();
        state.leases.retain(|_, attachment| attachment.valid_at(now));
        json!({ "protocol": PROTOCOL, "epoch": self.epoch, "attachedClients": state.leases.len(),
            "stopping": state.stop_requested || state.exiting, "idleGraceSeconds": self.grace.as_secs(),
            "eventSocket": self.stream_socket.get(), "nativeTray": native_tray() })
    }

    pub(crate) fn attachment(&self, epoch: &str, lease: &str) -> anyhow::Result<Arc<Attachment>> {
        let state = self.state.lock().unwrap();
        if epoch != self.epoch || state.starting || state.exiting || state.stop_requested {
            bail!("The runtime attachment is no longer current.");
        }
        state.leases.get(lease).filter(|attachment| attachment.valid()).cloned()
            .ok_or_else(|| anyhow::anyhow!("The runtime attachment expired or disconnected."))
    }

    pub fn is_stopping(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.stop_requested || state.exiting
    }

    #[cfg(unix)]
    pub fn set_stream_socket(&self, path: std::path::PathBuf) {
        let _ = self.stream_socket.set(path);
    }

    pub fn command(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap();
        state.leases.retain(|_, attachment| attachment.valid_at(now));
        if state.starting {
            return Err(ControlError::new("runtime_starting", "The local runtime is restoring its stores.", None::<String>));
        }
        if state.exiting || (state.stop_requested && !(command == "runtime.stopAll" && state.stop_failed)) {
            return Err(unavailable());
        }
        match command {
            "runtime.attach" => {
                if params["protocol"].as_u64() != Some(PROTOCOL) {
                    return Err(ControlError::new("runtime_incompatible", "No compatible local runtime protocol was requested.", None::<String>));
                }
                if state.leases.len() >= MAX_CLIENTS {
                    return Err(ControlError::new("busy", "Too many attached local clients.", None::<String>));
                }
                let lease = uuid::Uuid::new_v4().to_string();
                state.leases.insert(lease.clone(), Arc::new(Attachment(Mutex::new(Some(now + LEASE_TIME)))));
                state.idle_since = None;
                Ok(json!({ "protocol": PROTOCOL, "epoch": self.epoch, "lease": lease,
                    "leaseSeconds": LEASE_TIME.as_secs(), "heartbeatSeconds": 5 }))
            }
            "runtime.heartbeat" | "runtime.detach" => {
                if params["epoch"].as_str() != Some(&self.epoch) {
                    return Err(ControlError::new("runtime_restarted", "This attachment belongs to another runtime.", None::<String>));
                }
                let lease = params["lease"].as_str().ok_or_else(|| ControlError::invalid("lease is required"))?;
                let attachment = state.leases.get(lease).ok_or_else(|| ControlError::new("attachment_expired", "Attach again before using this lease.", None::<String>))?;
                if command == "runtime.heartbeat" {
                    *attachment.0.lock().unwrap() = Some(now + LEASE_TIME);
                } else {
                    attachment.revoke();
                    state.leases.remove(lease);
                    if state.leases.is_empty() {
                        state.idle_since = Some(now);
                    }
                }
                Ok(json!({ "ok": true }))
            }
            "runtime.stopAll" => {
                // Bind a destructive request to the owner the client saw, so a
                // delayed request cannot stop a replacement runtime.
                if params["epoch"].as_str() != Some(&self.epoch) {
                    return Err(ControlError::new("runtime_restarted", "Refresh runtime status before stopping all work.", None::<String>));
                }
                state.stop_requested = true;
                state.stop_failed = false;
                for attachment in state.leases.values() { attachment.revoke(); }
                Ok(json!({ "stopping": true }))
            }
            _ => Err(ControlError::new("unsupported", "Unknown local runtime lifecycle command.", None::<String>)),
        }
    }

    pub(crate) fn stop_failed(&self) {
        self.state.lock().unwrap().stop_failed = true;
    }

    /// Commit shutdown under the same lock that admits commands. Callers
    /// must include unknown/live terminal work rather than guessing from silence.
    pub fn should_exit(&self, busy: impl FnOnce() -> bool) -> bool {
        self.should_exit_at(Instant::now(), busy)
    }

    pub(crate) fn should_exit_checked(&self, busy: impl FnOnce() -> bool, confirm: impl FnOnce() -> bool) -> bool {
        self.should_exit_confirmed(Instant::now(), busy, confirm)
    }

    fn should_exit_at(&self, now: Instant, busy: impl FnOnce() -> bool) -> bool {
        self.should_exit_confirmed(now, busy, || true)
    }

    fn should_exit_confirmed(&self, now: Instant, busy: impl FnOnce() -> bool, confirm: impl FnOnce() -> bool) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.starting { return false; }
        if state.requests != 0 { return false; }
        if state.stop_requested {
            if state.stop_failed { return false; }
            state.exiting = true;
            return true;
        }
        let had_clients = !state.leases.is_empty();
        state.leases.retain(|_, attachment| attachment.valid_at(now));
        if !state.leases.is_empty() || busy() {
            state.idle_since = None;
            return false;
        }
        if had_clients { state.idle_since = Some(now); }
        let since = *state.idle_since.get_or_insert(now);
        if now.saturating_duration_since(since) >= self.grace {
            if !confirm() {
                state.idle_since = Some(now);
                return false;
            }
            state.exiting = true;
        }
        state.exiting
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_stop_stays_available_only_for_an_explicit_retry() {
        let life = Lifetime::new(Duration::ZERO);
        let request = life.enter().unwrap();
        life.command("runtime.stopAll", json!({"epoch":life.epoch})).unwrap();
        life.stop_failed();
        drop(request);
        assert!(!life.should_exit(|| false));
        assert!(life.enter().is_err());
        assert!(life.command("runtime.attach", json!({"protocol":PROTOCOL})).is_err());
        let retry = life.enter_command(true).unwrap();
        assert!(life.command("runtime.stopAll", json!({"epoch":"old-owner"})).is_err());
        assert!(!life.should_exit(|| false));
        life.command("runtime.stopAll", json!({"epoch":life.epoch})).unwrap();
        assert!(!life.should_exit(|| false), "the stop acknowledgement is still being prepared");
        drop(retry);
        assert!(life.should_exit(|| false));
    }

    #[test]
    fn detach_serializes_with_an_admitted_write_and_refuses_the_next_one() {
        let life = Lifetime::new(IDLE_GRACE);
        let attached = life.command("runtime.attach", json!({"protocol": PROTOCOL})).unwrap();
        let grant = life.attachment(&life.epoch, attached["lease"].as_str().unwrap()).unwrap();
        let write = grant.enter().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let detached = life.clone();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            detached.command("runtime.detach", attached).unwrap();
            done_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(write);
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        assert!(grant.enter().is_err());
    }

    #[test]
    fn scoped_attachment_is_revoked_on_disconnect_and_cannot_follow_a_new_lease() {
        let life = Lifetime::new(IDLE_GRACE);
        let attached = life.command("runtime.attach", json!({"protocol": PROTOCOL})).unwrap();
        let grant = life.attachment(&life.epoch, attached["lease"].as_str().unwrap()).unwrap();
        assert!(grant.valid());
        assert!(!grant.valid_at(Instant::now() + LEASE_TIME));
        assert!(life.attachment("wrong-owner", attached["lease"].as_str().unwrap()).is_err());
        life.command("runtime.detach", attached.clone()).unwrap();
        assert!(!grant.valid());
        assert!(life.command("runtime.heartbeat", attached).is_err());
        let next = life.command("runtime.attach", json!({"protocol": PROTOCOL})).unwrap();
        let next_grant = life.attachment(&life.epoch, next["lease"].as_str().unwrap()).unwrap();
        assert!(next_grant.valid());
        assert!(!grant.valid());
        life.command("runtime.stopAll", json!({"epoch":life.epoch})).unwrap();
        assert!(!next_grant.valid());
    }

    #[test]
    fn startup_recovery_precedes_admission_and_idle_exit() {
        let life = Lifetime::starting(Duration::ZERO);
        assert!(life.enter().is_err());
        assert!(life.command("runtime.attach", json!({"protocol": PROTOCOL})).is_err());
        assert!(!life.should_exit_at(Instant::now() + Duration::from_secs(100), || false));
        life.ready();
        assert!(life.enter().is_ok());
        assert!(life.command("runtime.attach", json!({"protocol": PROTOCOL})).is_ok());
        assert_eq!(life.status()["attachedClients"], 1);
    }

    #[test]
    fn detach_and_expiry_never_end_busy_work() {
        let life = Lifetime::new(Duration::from_secs(1));
        let attached = life.command("runtime.attach", json!({"protocol": PROTOCOL})).unwrap();
        assert!(!life.should_exit_at(Instant::now() + Duration::from_secs(100), || true));
        assert!(life.command("runtime.heartbeat", attached).is_err());
        let now = Instant::now() + Duration::from_secs(101);
        assert!(!life.should_exit_at(now, || false));
        assert!(life.should_exit_at(now + Duration::from_secs(1), || false));
        assert!(life.enter().is_err());
    }

    #[test]
    fn stop_waits_for_accepted_requests_and_refuses_new_work() {
        let life = Lifetime::new(IDLE_GRACE);
        let request = life.enter().unwrap();
        assert!(life.command("runtime.stopAll", json!({"epoch":"stale"})).is_err());
        life.command("runtime.stopAll", json!({"epoch":life.epoch})).unwrap();
        assert!(life.enter().is_err());
        assert!(!life.should_exit(|| true));
        drop(request);
        assert!(life.should_exit(|| true));
    }

    #[test]
    fn compatibility_failure_does_not_attach_or_stop() {
        let life = Lifetime::new(IDLE_GRACE);
        assert!(life.command("runtime.attach", json!({"protocol": PROTOCOL + 1})).is_err());
        assert_eq!(life.status()["attachedClients"], 0);
        assert!(life.enter().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn ownership_is_exclusive_and_survives_lock_path_reuse() {
        let home = tempfile::tempdir().unwrap();
        let owner = Owner::acquire(home.path()).unwrap();
        assert!(Owner::acquire(home.path()).is_err());
        drop(owner);
        assert!(Owner::acquire(home.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn refuse_symlink_and_legacy_live_owner() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), home.path().join("run")).unwrap();
        assert!(Owner::acquire(home.path()).is_err());
        std::fs::remove_file(home.path().join("run")).unwrap();
        drop(Owner::acquire(home.path()).unwrap());
        let _listener = std::os::unix::net::UnixListener::bind(home.path().join("run/hooks.sock")).unwrap();
        assert!(Owner::acquire(home.path()).is_err());
    }
}
