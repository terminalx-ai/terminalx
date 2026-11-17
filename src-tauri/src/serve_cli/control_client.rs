//! The runtime, as `pair` and `devices` reach it: over its control socket
//! (`<data dir>/run/hooks.sock`, authenticated by `run/control.token`) with
//! the desktop's own client, attached like a window for the commands that
//! name an attachment.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use crate::local_runtime::client::{Client, Refused, LIFECYCLE_TIMEOUT, QUICK_TIMEOUT};
use crate::machine_wire;

/// How often an attachment is renewed (docs/HEADLESS-SERVE.md: every five
/// seconds; it lapses after twenty without).
const HEARTBEAT: Duration = Duration::from_secs(5);

/// How long `pair` waits for a runtime the service manager was asked to start.
const START_WAIT: Duration = Duration::from_secs(30);

/// The runtime serving one data directory.
pub struct Runtime {
    client: Arc<Client>,
    data: PathBuf,
}

/// Whether the runtime of `data` is up: something answers on its socket.
pub fn running(data: &Path) -> bool {
    Client::connect(data).is_ok()
}

impl Runtime {
    /// The runtime serving `data`, which must be running.
    pub fn connect(data: &Path) -> Result<Self> {
        let client = Client::connect(data).map_err(|error| not_running(data, error))?;
        Ok(Self { client, data: data.to_path_buf() })
    }

    /// The runtime serving `data`; if none is, the installed service for
    /// `data` is started and waited for. With hosting off an idle runtime
    /// exits, so a service that started at boot may have stopped since.
    pub fn connect_or_start(data: &Path) -> Result<Self> {
        if let Ok(client) = Client::connect(data) {
            return Ok(Self { client, data: data.to_path_buf() });
        }
        if !super::service::start_for(data)? {
            return Self::connect(data);
        }
        let deadline = Instant::now() + START_WAIT;
        loop {
            match Client::connect(data) {
                Ok(client) => return Ok(Self { client, data: data.to_path_buf() }),
                Err(error) if Instant::now() >= deadline => return Err(not_running(data, error)),
                Err(_) => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    }

    pub fn data(&self) -> &Path {
        &self.data
    }

    /// `runtime.machineHost.status`.
    pub fn status(&self) -> Result<machine_wire::Status> {
        let status: Value = self.client.call_within(machine_wire::STATUS, json!({}), QUICK_TIMEOUT).map_err(said)?;
        serde_json::from_value(status).context("read the machine host's status")
    }

    /// The runtime's own `status`: its version.
    pub fn version(&self) -> Option<String> {
        self.client.build().version.as_ref().map(ToString::to_string)
    }

    /// A control command that names no attachment.
    pub fn call(&self, command: &str, params: Value) -> Result<Value> {
        self.client.call_within(command, params, QUICK_TIMEOUT).map_err(said)
    }

    /// Attach as a window does, for the commands that need it.
    pub fn attach(&self) -> Result<Attachment> {
        let attached: Value = self.client.call_within("runtime.attach", json!({ "protocol": 1 }), LIFECYCLE_TIMEOUT).map_err(said)?;
        let epoch = attached["epoch"].as_str().context("the runtime's attachment has no epoch")?.to_string();
        let lease = attached["lease"].as_str().context("the runtime's attachment has no lease")?.to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (client, stop, identity) = (self.client.clone(), stop.clone(), json!({ "epoch": epoch, "lease": lease }));
            std::thread::Builder::new().name("attachment-heartbeat".into()).spawn(move || {
                let mut last = Instant::now();
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                    if last.elapsed() < HEARTBEAT {
                        continue;
                    }
                    last = Instant::now();
                    if let Err(error) = client.call_within::<Value>("runtime.heartbeat", identity.clone(), LIFECYCLE_TIMEOUT) {
                        log::warn!("renew the runtime attachment: {error:#}");
                    }
                }
            })?
        };
        Ok(Attachment { client: self.client.clone(), epoch, lease, stop, thread: Some(thread) })
    }
}

/// An attachment, renewed until dropped, then detached.
pub struct Attachment {
    client: Arc<Client>,
    epoch: String,
    lease: String,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Attachment {
    /// A machine host command that names this attachment.
    pub fn call(&self, command: &str, mut params: Value) -> Result<Value> {
        let object = params.as_object_mut().context("machine host parameters must be an object")?;
        object.insert("epoch".into(), self.epoch.clone().into());
        object.insert("lease".into(), self.lease.clone().into());
        self.client.call_within(command, params, QUICK_TIMEOUT).map_err(said)
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _: Result<Value> = self.client.call_within("runtime.detach", json!({ "epoch": self.epoch, "lease": self.lease }), LIFECYCLE_TIMEOUT);
    }
}

/// The code a refusal came with, if the runtime refused.
pub fn refusal_code(error: &anyhow::Error) -> Option<&str> {
    error.chain().find_map(|cause| cause.downcast_ref::<Refused>()).map(|refused| refused.code.as_str())
}

/// A refusal reads as what the runtime said, with its code kept for callers.
fn said(error: anyhow::Error) -> anyhow::Error {
    match error.downcast_ref::<Refused>() {
        Some(refused) => {
            let message = refused.message.clone();
            error.context(message)
        }
        None => error,
    }
}

fn not_running(data: &Path, error: anyhow::Error) -> anyhow::Error {
    anyhow!(
        "The TerminalX runtime is not running for {} ({error:#}). Install it as a service with `terminalx-serve service install`, or start it with `terminalx-serve --data-dir {}`.",
        data.display(),
        data.display()
    )
}
