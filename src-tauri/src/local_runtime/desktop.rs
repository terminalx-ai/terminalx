//! One desktop attachment and independent PTY views for each of its windows.
//! All connections pin the same owner. A closed view is not a process stop,
//! and a failed owner connection is never replaced behind a pending request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;

use super::{bridge::Bridge, client::{AttachmentIdentity, Client}, sessions::Sessions};
use crate::{pty::Tap, sink::EventSink};

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
        let _: Result<serde_json::Value> = self.client.call("runtime.detach", serde_json::to_value(previous)?);
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
        let _: serde_json::Value = self.client.call("runtime.window.register", serde_json::json!({
            "epoch":attachment.epoch,"lease":attachment.lease,"socket":endpoint.socket,"token":endpoint.token
        }))?;
        Ok(())
    }

    pub fn disconnect(&self) {
        self.events.disconnect();
        self.windows.lock().unwrap().clear();
    }

    pub fn attachment(&self) -> Result<AttachmentIdentity> { self.events.attachment() }

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
