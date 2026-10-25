//! One native window connection. PTY callbacks receive the same bytes and
//! cumulative acknowledgements as an in-process tap. Dropping this connection
//! releases views and its UI lease, never the processes that produced them.

use std::collections::HashMap;
use std::io::Write;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Result};
use base64::Engine as _;
use serde_json::{json, Value};

use crate::pty::Tap;
use crate::sink::EventSink;
use super::client::Client;

type Views = HashMap<String, (String, Tap)>;

struct State {
    write: UnixStream,
    views: Views,
    connected: bool,
    detached: bool,
}

impl State {
    fn send(&mut self, message: Value) -> Result<()> {
        if !self.connected { bail!("local runtime event connection is closed"); }
        let sent = (|| {
            serde_json::to_writer(&mut self.write, &message)?;
            self.write.write_all(b"\n")?;
            Ok(())
        })();
        if sent.is_err() { self.close(); }
        sent
    }

    fn close(&mut self) {
        self.connected = false;
        self.views.clear();
        let _ = self.write.shutdown(Shutdown::Both);
    }
}

pub struct Bridge {
    attachment: super::client::AttachmentIdentity,
    state: Arc<Mutex<State>>,
}

impl Bridge {
    pub fn connect(client: &Client, sink: Arc<dyn EventSink>) -> Result<Self> {
        Self::open(client, sink, true)
    }

    /// Additional windows need independent flow control, but must not publish
    /// another copy of the owner's app-wide events into the desktop event bus.
    pub fn connect_views(client: &Client, sink: Arc<dyn EventSink>) -> Result<Self> {
        Self::open(client, sink, false)
    }

    fn open(client: &Client, sink: Arc<dyn EventSink>, publish_events: bool) -> Result<Self> {
        let mut connection = client.stream()?;
        let attachment = connection.attachment().clone();
        let state = Arc::new(Mutex::new(State { write: connection.writer()?, views: HashMap::new(), connected: true, detached: false }));
        let reader = state.clone();
        std::thread::Builder::new().name("local-runtime-events".into()).spawn(move || {
            let outcome: Result<()> = (|| {
                loop {
                    let frame = connection.receive()?;
                    match frame["type"].as_str() {
                        Some("event") => {
                            let event = frame["event"].as_str().ok_or_else(|| anyhow::anyhow!("event name is missing"))?;
                            if publish_events {
                                sink.emit_raw(event, serde_json::value::to_raw_value(&frame["payload"])?);
                            }
                        }
                        Some("pty") => {
                            let id = frame["id"].as_str().ok_or_else(|| anyhow::anyhow!("pane id is missing"))?;
                            let token = frame["token"].as_str().ok_or_else(|| anyhow::anyhow!("view token is missing"))?;
                            let bytes = base64::engine::general_purpose::STANDARD.decode(frame["data"].as_str().unwrap_or_default())?;
                            let mut state = reader.lock().unwrap();
                            if let Some((current, tap)) = state.views.get(id) {
                                // A replaced view must never consume an old view's
                                // replay or acknowledge its bytes.
                                if current == token && !tap(&bytes) {
                                    state.views.remove(id);
                                    state.send(json!({"method":"detach", "id":id,"token":token}))?;
                                }
                            }
                        }
                        Some("pong") => {}
                        _ => bail!("unknown local runtime event frame"),
                    }
                }
            })();
            let detached = {
                let mut state = reader.lock().unwrap();
                state.close();
                state.detached
            };
            if let Err(error) = outcome {
                if detached { return; }
                log::debug!("local runtime bridge disconnected: {error}");
                // Do not synthesize terminal exits or recoveries: the owner
                // may still be running. A new bridge starts with new taps.
                let event = if publish_events { "local_runtime_disconnected" } else { "local_runtime_view_disconnected" };
                sink.emit(event, &json!({"reattachRequired":true}));
            }
        })?;
        Ok(Self { state, attachment })
    }

    /// The original lease is retained only so reconnect can revoke it even
    /// after transport loss; this does not assert that the view is live.
    pub(super) fn identity(&self) -> super::client::AttachmentIdentity { self.attachment.clone() }

    pub fn disconnect(&self) {
        let mut state = self.state.lock().unwrap();
        state.detached = true;
        state.close();
    }

    pub fn attachment(&self) -> Result<super::client::AttachmentIdentity> {
        if !self.state.lock().unwrap().connected { bail!("local runtime event connection is closed"); }
        Ok(self.attachment.clone())
    }

    pub fn attach(&self, id: &str, token: &str, tap: Tap) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        state.views.insert(id.into(), (token.into(), tap));
        state.send(json!({"method":"attach","id":id,"token":token}))
    }

    pub fn ack(&self, id: &str, token: &str, drawn: u64) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.views.get(id).is_some_and(|(current, _)| current == token) {
            state.send(json!({"method":"ack","id":id,"token":token,"drawn":drawn}))?;
        }
        Ok(())
    }

    pub fn detach(&self, id: &str, token: &str) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.views.get(id).is_some_and(|(current, _)| current == token) {
            state.views.remove(id);
            state.send(json!({"method":"detach","id":id,"token":token}))?;
        }
        Ok(())
    }

    pub fn detach_all(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        for (id, (token, _)) in std::mem::take(&mut state.views) {
            state.send(json!({"method":"detach","id":id,"token":token}))?;
        }
        Ok(())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) { self.disconnect(); }
}
