//! One desktop attachment and independent PTY views for each of its windows.
//! All connections pin the same owner. A closed view is not a process stop,
//! and a failed owner connection is never replaced behind a pending request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;

use super::{bridge::Bridge, client::{AttachmentIdentity, Client}, sessions::Sessions};
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

pub struct Desktop {
    client: Arc<Client>,
    events: Bridge,
    sink: Arc<dyn EventSink>,
    windows: Mutex<HashMap<String, Bridge>>,
}

impl Desktop {
    pub fn connect(client: Arc<Client>, sink: Arc<dyn EventSink>) -> Result<Self> {
        let events = Bridge::connect(&client, sink.clone())?;
        Ok(Self { client, events, sink, windows: Mutex::new(HashMap::new()) })
    }

    /// Reconnect only to this exact owner, never rediscover or replay a request.
    pub fn reconnect(&self) -> Result<Self> {
        // End the old event publisher before opening another, and revoke old
        // sharing leases even if the new connection fails. Session processes
        // remain owned by the runtime throughout.
        let previous = self.events.identity();
        self.disconnect();
        // Socket EOF cleanup runs on another owner thread. Complete a control
        // round trip before registering the replacement, so it cannot race a
        // still-valid old window lease. An already-expired lease is harmless;
        // owner loss is independently rejected by the pinned stream handshake.
        let _: Result<serde_json::Value> = self.client.quick("runtime.detach", serde_json::to_value(previous)?);
        // The caller must publish the new identity before exposing services.
        Self::connect(self.client.clone(), self.sink.clone())
    }

    /// Install the attachment used to validate incoming calls before the owner
    /// can dispatch any. Failure revokes this attachment, including when the
    /// owner accepted registration but its response was lost.
    pub fn activate_window(self: &Arc<Self>, endpoint: crate::hooks::ControlEndpoint,
        publish: impl FnOnce(&Arc<Self>) -> Result<()>) -> Result<()> {
        let result = publish(self).and_then(|()| self.register_window(endpoint));
        if result.is_err() { self.disconnect(); }
        result
    }

    /// The listener is private to this window. Only the owner publishes home discovery.
    fn register_window(&self, endpoint: crate::hooks::ControlEndpoint) -> Result<()> {
        let attachment = self.attachment()?;
        let _: serde_json::Value = self.client.quick("runtime.window.register", serde_json::json!({
            "epoch":attachment.epoch,"lease":attachment.lease,"socket":endpoint.socket,"token":endpoint.token
        }))?;
        Ok(())
    }

    pub fn disconnect(&self) {
        self.events.disconnect();
        self.windows.lock().unwrap().clear();
    }

    pub fn attachment(&self) -> Result<AttachmentIdentity> { self.events.attachment() }

    /// The owner this desktop is pinned to, whether or not its events still flow.
    pub fn epoch(&self) -> &str { self.client.epoch() }

    /// Whether the owner answers, and its own loop still turns. A loop held
    /// up behind a lock is a wedged owner even while it answers (#661). The
    /// question waits on nothing of the owner's, so a probe of a wedged owner
    /// never takes one of its request places for good.
    pub fn probe(&self) -> Result<()> {
        if let Some(age) = loop_stalled(&self.client.liveness()?) {
            anyhow::bail!("The TerminalX runtime answers, but its work loop has been stuck for {} seconds.", age.as_secs());
        }
        Ok(())
    }

    /// PTY transport is shared by this window's panes, not by every session
    /// or every window. A healthy event publisher does not prove it is live.
    pub fn window_connection(&self, window: &str) -> Result<()> {
        self.attachment()?;
        if let Some(bridge) = self.windows.lock().unwrap().get(window) {
            bridge.attachment().map_err(|_| anyhow::anyhow!(
                "Live terminal output in window {window} is disconnected. Agents and terminal commands may still be running."
            ))?;
        }
        Ok(())
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

    pub fn attach(&self, window: &str, id: &str, token: &str, tap: Tap) -> Result<()> {
        self.attachment()?;
        let mut windows = self.windows.lock().unwrap();
        if !windows.contains_key(window) {
            windows.insert(window.into(), Bridge::connect_views(&self.client, self.sink.clone())?);
        }
        windows[window].attach(id, token, tap)
    }

    pub fn ack(&self, window: &str, id: &str, token: &str, drawn: u64) -> Result<()> {
        if let Some(bridge) = self.windows.lock().unwrap().get(window) {
            bridge.ack(id, token, drawn)?;
        }
        Ok(())
    }

    pub fn detach(&self, window: &str, id: &str, token: &str) -> Result<()> {
        if let Some(bridge) = self.windows.lock().unwrap().get(window) {
            bridge.detach(id, token)?;
        }
        Ok(())
    }

    /// Page reload or window destruction releases just that window's lease and
    /// outstanding bytes. A new page obtains a fresh connection and replay.
    pub fn detach_window(&self, window: &str) {
        self.windows.lock().unwrap().remove(window);
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
