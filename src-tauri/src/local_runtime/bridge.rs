//! One native window connection. PTY callbacks receive the same bytes and
//! cumulative acknowledgements as an in-process tap. Dropping this connection
//! releases views and its UI lease, never the processes that produced them.
//! It pings the owner, so a hung owner is noticed as a lost connection.
//!
//! It carries one stream (#716): the app's events, or one window's terminal
//! output. When the owner says a view fell behind, that view alone is let go
//! and its window told (`pty_view_lagged`) to attach it again from the pane's
//! scrollback. When it says events were missed, every window is told to
//! re-read what it shows (`local_runtime_reattached`), as after a reconnect.

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
use super::client::{Client, Stream};

type Views = HashMap<String, (String, Tap)>;
/// Told once, with why, when the connection ends by itself; never after
/// `disconnect`. Whoever is told logs it: without one, the bridge does.
pub type Lost = Box<dyn FnOnce(String) + Send>;

struct State {
    write: UnixStream,
    views: Views,
    connected: bool,
    detached: bool,
    /// Why a write ended the connection: the reader then only sees it closed.
    failed: Option<String>,
}

impl State {
    fn send(&mut self, message: Value) -> Result<()> {
        if !self.connected { bail!("local runtime event connection is closed"); }
        let sent: Result<()> = (|| {
            serde_json::to_writer(&mut self.write, &message)?;
            self.write.write_all(b"\n")?;
            Ok(())
        })();
        if let Err(error) = &sent {
            self.failed.get_or_insert_with(|| format!("writing to the background runtime failed: {error:#}"));
            self.close();
        }
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
    pub fn connect(client: &Client, sink: Arc<dyn EventSink>, lost: Option<Lost>) -> Result<Self> {
        Self::open(client, sink, Stream::Events, lost)
    }

    /// Each window's terminals have a connection of their own, for flow
    /// control of their own. It takes no events: an owner too old to leave
    /// them out still sends them, and they are dropped here, never published
    /// again into the desktop event bus.
    pub fn connect_views(client: &Client, sink: Arc<dyn EventSink>, window: &str, lost: Option<Lost>) -> Result<Self> {
        Self::open(client, sink, Stream::Terminals { window: window.into() }, lost)
    }

    fn open(client: &Client, sink: Arc<dyn EventSink>, stream: Stream, lost: Option<Lost>) -> Result<Self> {
        let publish_events = stream == Stream::Events;
        let mut connection = client.stream(&stream)?;
        let attachment = connection.attachment().clone();
        let state = Arc::new(Mutex::new(State { write: connection.writer()?, views: HashMap::new(), connected: true, detached: false, failed: None }));
        // A failed ping closes the socket, which ends the reader below. Silence
        // ends it too, at the stream's read deadline.
        let pinger = Arc::downgrade(&state);
        let interval = client.ping_interval();
        std::thread::Builder::new().name("local-runtime-ping".into()).spawn(move || loop {
            std::thread::sleep(interval);
            let Some(state) = pinger.upgrade() else { return };
            let mut state = state.lock().unwrap();
            if !state.connected || state.send(json!({"method":"ping"})).is_err() { return; }
        })?;
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
                        Some("lagged") => {
                            let id = frame["id"].as_str().ok_or_else(|| anyhow::anyhow!("pane id is missing"))?;
                            let token = frame["token"].as_str().ok_or_else(|| anyhow::anyhow!("view token is missing"))?;
                            let mut state = reader.lock().unwrap();
                            // A view replaced since is not the one that fell behind.
                            if state.views.get(id).is_some_and(|(current, _)| current == token) {
                                state.views.remove(id);
                                drop(state);
                                log::info!("{stream}: the view of pane {id:?} fell behind; it is drawn again from the pane's scrollback");
                                sink.emit("pty_view_lagged", &json!({"id":id, "token":token}));
                            }
                        }
                        Some("missed") => {
                            let missed = frame["events"].as_u64().unwrap_or(0);
                            log::warn!("{stream}: {missed} events were not delivered; every window re-reads what it shows");
                            sink.emit("local_runtime_reattached", &json!({"missedEvents":missed}));
                        }
                        Some("pong") => {}
                        _ => bail!("unknown local runtime event frame"),
                    }
                }
            })();
            let (detached, failed) = {
                let mut state = reader.lock().unwrap();
                state.close();
                (state.detached, state.failed.take())
            };
            if let Err(error) = outcome {
                if detached { return; }
                let reason = failed.unwrap_or_else(|| format!("{error:#}"));
                // Do not synthesize terminal exits or recoveries: the owner
                // may still be running. A new bridge starts with new taps.
                let event = if publish_events { "local_runtime_disconnected" } else { "local_runtime_view_disconnected" };
                sink.emit(event, &json!({"reattachRequired":true}));
                match lost {
                    Some(lost) => lost(reason),
                    None => log::warn!("lost {stream}: {reason}"),
                }
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
