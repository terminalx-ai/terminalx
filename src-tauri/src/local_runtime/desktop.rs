//! One desktop attachment and independent PTY views for each of its windows.
//! All connections of one attachment reach the same owner. A closed view is
//! not a process stop, and a failed owner connection is never replaced behind
//! a pending request: losses are reported, and the supervisor replaces the
//! whole attachment or just one window's view (`supervisor.rs`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use anyhow::Result;

use super::{bridge::Bridge, client::{AttachmentIdentity, Blocked, Client, LIFECYCLE_TIMEOUT}, sessions::Sessions};
use crate::{pty::Tap, sink::EventSink};

/// Attachments, view connections and view renewals are numbered from one
/// sequence, so a later one always has a larger number than an earlier one.
static SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next() -> u64 { SEQUENCE.fetch_add(1, Ordering::Relaxed) }

/// A connection that ended by itself, or an attachment dropped on purpose
/// while the app goes on running (the sharing fence).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lost {
    Events { generation: u64 },
    View { generation: u64, window: String },
}

pub type Watch = Arc<dyn Fn(Lost) + Send + Sync>;

#[derive(Default)]
struct Windows {
    bridges: HashMap<String, (u64, Bridge)>,
    /// When each window's view connection was last re-established. Its page
    /// re-attaches its terminals when this changes.
    renewed: HashMap<String, u64>,
}

pub struct Desktop {
    client: Arc<Client>,
    events: Bridge,
    sink: Arc<dyn EventSink>,
    watch: Option<Watch>,
    generation: u64,
    windows: Arc<Mutex<Windows>>,
}

impl Desktop {
    pub fn connect(client: Arc<Client>, sink: Arc<dyn EventSink>) -> Result<Self> {
        Self::connect_watched(client, sink, None)
    }

    pub fn connect_watched(client: Arc<Client>, sink: Arc<dyn EventSink>, watch: Option<Watch>) -> Result<Self> {
        let generation = next();
        let lost = watch.clone().map(|watch| -> super::bridge::Lost { Box::new(move || watch(Lost::Events { generation })) });
        let events = Bridge::connect(&client, sink.clone(), lost)?;
        Ok(Self { client, events, sink, watch, generation, windows: Arc::default() })
    }

    /// Attach again through `client`, which discovery found: the same owner,
    /// or one that replaced it. No request is replayed.
    pub fn reconnect(&self, client: Arc<Client>) -> Result<Self> {
        // End the old event publisher before opening another, and revoke old
        // sharing leases even if the new connection fails. Session processes
        // remain owned by the runtime throughout.
        let previous = self.events.identity();
        self.close();
        // Socket EOF cleanup runs on another owner thread. Complete a control
        // round trip before registering the replacement, so it cannot race a
        // still-valid old window lease. An already-expired lease is harmless;
        // a replaced owner refuses the old epoch, and a hung one times out.
        let _: Result<serde_json::Value> = self.client.call_within("runtime.detach", serde_json::to_value(previous)?, LIFECYCLE_TIMEOUT);
        // The caller must publish the new identity before exposing services.
        Self::connect_watched(client, self.sink.clone(), self.watch.clone())
    }

    /// Install the attachment used to validate incoming calls before the owner
    /// can dispatch any. Failure revokes this attachment, including when the
    /// owner accepted registration but its response was lost.
    pub fn activate_window(self: &Arc<Self>, endpoint: crate::hooks::ControlEndpoint,
        publish: impl FnOnce(&Arc<Self>) -> Result<()>) -> Result<()> {
        let result = publish(self).and_then(|()| self.register_window(endpoint));
        if result.is_err() { self.close(); }
        result
    }

    /// The listener is private to this window. Only the owner publishes home discovery.
    fn register_window(&self, endpoint: crate::hooks::ControlEndpoint) -> Result<()> {
        let attachment = self.attachment()?;
        let registered: Result<serde_json::Value> = self.client.call_within("runtime.window.register", serde_json::json!({
            "epoch":attachment.epoch,"lease":attachment.lease,"socket":endpoint.socket,"token":endpoint.token
        }), LIFECYCLE_TIMEOUT);
        match registered {
            // Its own earlier lease was revoked before this one was taken, so
            // the window services belong to a different desktop process.
            Err(error) if format!("{error:#}").contains("Another desktop currently provides") =>
                Err(Blocked("Another TerminalX window is connected to this background runtime. Close it, then try again.".into()).into()),
            other => other.map(drop),
        }
    }

    /// Drop the attachment without reporting it: replacing it, or failing to publish it.
    fn close(&self) {
        self.events.disconnect();
        self.windows.lock().unwrap().bridges.clear();
    }

    /// Drop the attachment on purpose. The app goes on, so the supervisor
    /// attaches again with a new lease; on quit it has been halted first.
    pub fn disconnect(&self) {
        self.close();
        if let Some(watch) = &self.watch { watch(Lost::Events { generation: self.generation }); }
    }

    pub fn attachment(&self) -> Result<AttachmentIdentity> { self.events.attachment() }

    pub fn generation(&self) -> u64 { self.generation }

    /// When `window`'s view connection was last re-established (0: never).
    pub fn renewed(&self, window: &str) -> u64 {
        self.windows.lock().unwrap().renewed.get(window).copied().unwrap_or(0)
    }

    pub fn sessions(&self) -> Result<Sessions> {
        self.attachment()?;
        Ok(Sessions::new(self.client.clone()))
    }

    pub fn terminals(&self) -> Result<super::terminals::Terminals> {
        self.attachment()?;
        Ok(super::terminals::Terminals::new(self.client.clone()))
    }

    pub fn stop_all(&self) -> Result<()> { self.client.stop_all() }

    /// Internal owner RPC only. Identity comes from the desktop's verified
    /// account, never from a guest frame; owner-side admission remains final.
    #[cfg(feature = "desktop")]
    pub(crate) fn sharing(&self, context: &crate::account::AccountContext, method: &str, mut params: serde_json::Value) -> Result<serde_json::Value> {
        use serde_json::json;
        let attachment = self.attachment()?;
        let actor = json!({ "epoch": attachment.epoch, "lease": attachment.lease,
            "generation": context.generation, "userId": context.user_id,
            "profileId": context.profile_id, "organizationId": context.organization_id });
        if method != "clear" {
            let _: serde_json::Value = self.client.call("runtime.sharing.register", json!({"actor": actor}))?;
        }
        let object = params.as_object_mut().ok_or_else(|| anyhow::anyhow!("Sharing parameters must be an object."))?;
        object.insert("actor".into(), actor);
        self.client.call(&format!("runtime.sharing.{method}"), params)
    }


    #[cfg(feature = "desktop")]
    pub(crate) fn mobile(&self, actor: &super::mobile::Actor, method: &str, mut params: serde_json::Value) -> Result<serde_json::Value> {
        let attachment = self.attachment()?;
        if actor.epoch != attachment.epoch || actor.lease != attachment.lease {
            anyhow::bail!("The paired-device attachment changed. Reconnect the device.");
        }
        params.as_object_mut().ok_or_else(|| anyhow::anyhow!("Mobile parameters must be an object."))?
            .insert("actor".into(), serde_json::to_value(actor)?);
        self.client.call(&format!("runtime.mobile.{method}"), params)
    }

    /// A view connection for `window`. When it ends by itself it leaves the
    /// window, so the next attach opens another, and the loss is reported.
    fn view(&self, window: &str) -> Result<(u64, Bridge)> {
        let id = next();
        let windows = Arc::downgrade(&self.windows);
        let (watch, generation, label) = (self.watch.clone(), self.generation, window.to_owned());
        let lost: super::bridge::Lost = Box::new(move || {
            let Some(windows) = Weak::upgrade(&windows) else { return };
            let dead = {
                let mut windows = windows.lock().unwrap();
                if windows.bridges.get(&label).is_some_and(|(current, _)| *current == id) { windows.bridges.remove(&label) } else { None }
            };
            // Dropped outside the lock: dropping a bridge takes its own lock.
            drop(dead);
            // Reported even when an attach already replaced it: views attached
            // over the dead one still have to move to the new one.
            if let Some(watch) = watch { watch(Lost::View { generation, window: label }); }
        });
        Ok((id, Bridge::connect_views(&self.client, self.sink.clone(), Some(lost))?))
    }

    pub fn attach(&self, window: &str, id: &str, token: &str, tap: Tap) -> Result<()> {
        self.attachment()?;
        let mut windows = self.windows.lock().unwrap();
        if !windows.bridges.get(window).is_some_and(|(_, bridge)| bridge.attachment().is_ok()) {
            let view = self.view(window)?;
            windows.bridges.insert(window.into(), view);
        }
        windows.bridges[window].1.attach(id, token, tap)
    }

    /// Re-establish `window`'s view connection after a loss, and mark it
    /// renewed so the window's page attaches its terminals to it.
    pub fn reopen_view(&self, window: &str) -> Result<u64> {
        self.attachment()?;
        let mut windows = self.windows.lock().unwrap();
        if !windows.bridges.get(window).is_some_and(|(_, bridge)| bridge.attachment().is_ok()) {
            let view = self.view(window)?;
            windows.bridges.insert(window.into(), view);
        }
        let renewed = next();
        windows.renewed.insert(window.into(), renewed);
        Ok(renewed)
    }

    pub fn ack(&self, window: &str, id: &str, token: &str, drawn: u64) -> Result<()> {
        if let Some((_, bridge)) = self.windows.lock().unwrap().bridges.get(window) {
            bridge.ack(id, token, drawn)?;
        }
        Ok(())
    }

    pub fn detach(&self, window: &str, id: &str, token: &str) -> Result<()> {
        if let Some((_, bridge)) = self.windows.lock().unwrap().bridges.get(window) {
            bridge.detach(id, token)?;
        }
        Ok(())
    }

    /// Page reload or window destruction releases just that window's lease and
    /// outstanding bytes. A new page obtains a fresh connection and replay.
    pub fn detach_window(&self, window: &str) {
        let dropped = self.windows.lock().unwrap().bridges.remove(window);
        drop(dropped);
    }
}
