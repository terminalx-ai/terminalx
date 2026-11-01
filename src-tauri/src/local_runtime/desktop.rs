//! One desktop attachment and independent PTY views for each of its windows.
//! All connections of one attachment reach the same owner. A closed view is
//! not a process stop, and a failed owner connection is never replaced behind
//! a pending request: losses are reported, and the supervisor replaces the
//! whole attachment or just one window's view (`supervisor.rs`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::Result;

use super::{bridge::Bridge, client::{AttachmentIdentity, Blocked, Client, LIFECYCLE_TIMEOUT, QUICK_TIMEOUT}, sessions::Sessions};
use crate::{pty::Tap, sink::EventSink};

/// How long the owner's loop may go without finishing a pass before a window
/// says it is not responding. A pass normally takes a quarter of a second, but
/// the loop shares the sharing and tab locks with prompt delivery, which holds
/// them through a shared or mobile prompt's writes (each at most
/// `pty::INPUT_DEADLINE`, 30 s) and two paste waits (10 s each). This is well
/// past that, so a slow delivery that is still working is never taken for a
/// wedge, and restarting, which stops every agent, is not offered for one.
const LOOP_STALL: Duration = Duration::from_secs(120);

/// How long the owner's loop has gone without finishing a pass, once that is
/// past [`LOOP_STALL`]. An owner too old to say is taken at its word.
fn loop_stalled(liveness: &serde_json::Value) -> Option<Duration> {
    liveness["localRuntime"]["loopAgeMs"].as_u64().map(Duration::from_millis).filter(|age| *age >= LOOP_STALL)
}

/// Attachments, view connections and view renewals are numbered from one
/// sequence, so a later one always has a larger number than an earlier one.
static SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next() -> u64 { SEQUENCE.fetch_add(1, Ordering::Relaxed) }

/// A connection that ended by itself, or an attachment dropped on purpose
/// while the app goes on running (the sharing fence), and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lost {
    Events { generation: u64, reason: String },
    View { generation: u64, window: String, reason: String },
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
        let lost = watch.clone().map(|watch| -> super::bridge::Lost { Box::new(move |reason| watch(Lost::Events { generation, reason })) });
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
        if let Some(watch) = &self.watch {
            watch(Lost::Events { generation: self.generation, reason: "the desktop let the attachment go".into() });
        }
    }

    pub fn attachment(&self) -> Result<AttachmentIdentity> { self.events.attachment() }

    /// The owner this desktop is pinned to, whether or not its events still flow.
    pub fn epoch(&self) -> &str { self.client.epoch() }

    /// The owner's build: its version, and what it can serve a phone (#730).
    pub fn build(&self) -> &super::client::Build { self.client.build() }

    /// The owner's full status. See [`Client::status`].
    pub fn status(&self) -> Result<serde_json::Value> { self.client.status() }

    /// Whether the owner answers, and its own loop still turns. A loop held
    /// up behind a lock is a wedged owner even while it answers (#661). The
    /// question waits on nothing of the owner's, so a probe of a wedged owner
    /// never takes one of its request places for good.
    pub fn probe(&self) -> Result<()> {
        if let Some(age) = loop_stalled(&self.client.liveness(QUICK_TIMEOUT)?) {
            anyhow::bail!("The TerminalX runtime answers, but its work loop has been stuck for {} seconds.", age.as_secs());
        }
        Ok(())
    }

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
        // Registering and reading the share are quick; changes such as a stop
        // may wait for the agents they act on.
        if method != "clear" {
            let _: serde_json::Value = self.client.quick("runtime.sharing.register", json!({"actor": actor}))?;
        }
        let object = params.as_object_mut().ok_or_else(|| anyhow::anyhow!("Sharing parameters must be an object."))?;
        object.insert("actor".into(), actor);
        let command = format!("runtime.sharing.{method}");
        if matches!(method, "status" | "clear") { self.client.quick(&command, params) } else { self.client.call(&command, params) }
    }


    #[cfg(feature = "desktop")]
    pub(crate) fn mobile(&self, actor: &super::mobile::Actor, method: &str, mut params: serde_json::Value) -> Result<serde_json::Value> {
        let attachment = self.attachment()?;
        if actor.epoch != attachment.epoch || actor.lease != attachment.lease {
            anyhow::bail!("The paired-device attachment changed. Reconnect the device.");
        }
        params.as_object_mut().ok_or_else(|| anyhow::anyhow!("Mobile parameters must be an object."))?
            .insert("actor".into(), serde_json::to_value(actor)?);
        // Fences and checks are quick; they also run as the app quits.
        let command = format!("runtime.mobile.{method}");
        if matches!(method, "clear" | "revoke" | "check") { self.client.quick(&command, params) } else { self.client.call(&command, params) }
    }

    /// A view connection for `window`. When it ends by itself it leaves the
    /// window, so the next attach opens another, and the loss is reported.
    fn view(&self, window: &str) -> Result<(u64, Bridge)> {
        let id = next();
        let windows = Arc::downgrade(&self.windows);
        let (watch, generation, label) = (self.watch.clone(), self.generation, window.to_owned());
        let lost: super::bridge::Lost = Box::new(move |reason| {
            let Some(windows) = Weak::upgrade(&windows) else { return };
            let dead = {
                let mut windows = windows.lock().unwrap();
                if windows.bridges.get(&label).is_some_and(|(current, _)| *current == id) { windows.bridges.remove(&label) } else { None }
            };
            // Dropped outside the lock: dropping a bridge takes its own lock.
            drop(dead);
            // Reported even when an attach already replaced it: views attached
            // over the dead one still have to move to the new one.
            if let Some(watch) = watch { watch(Lost::View { generation, window: label, reason }); }
        });
        Ok((id, Bridge::connect_views(&self.client, self.sink.clone(), window, Some(lost))?))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_loop_stuck_past_the_limit_is_a_wedge() {
        let age = |ms: u64| json!({"localRuntime": {"loopAgeMs": ms}});
        assert_eq!(loop_stalled(&age(250)), None);
        assert_eq!(loop_stalled(&age(LOOP_STALL.as_millis() as u64 - 1)), None, "a slow delivery that still works");
        assert_eq!(loop_stalled(&age(LOOP_STALL.as_millis() as u64)), Some(LOOP_STALL));
        assert_eq!(loop_stalled(&age(7 * 3600 * 1000)), Some(Duration::from_secs(7 * 3600)));
        // An owner still starting, or too old to say, is not judged by it.
        assert_eq!(loop_stalled(&json!({"localRuntime": {"loopAgeMs": null}})), None);
        assert_eq!(loop_stalled(&json!({"localRuntime": {}})), None);
    }
}
