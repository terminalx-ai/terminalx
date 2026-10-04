//! Where the backend's events go. Sessions, terminals and pairing publish
//! through an `EventSink` rather than a Tauri `AppHandle`, so the same code
//! runs inside the desktop app and inside the headless `terminalx-serve`
//! runtime a cloud workspace boots.
//!
//! The desktop sink is the `AppHandle` itself: an emit reaches the webview and
//! every Rust listener exactly as a direct `app.emit` did, except PTY output:
//! that stays in process for backend consumers, beside the raw view channels.
//! The headless sink
//! keeps the Rust-listener half in process and fans every event out on a
//! broadcast channel for whatever serves remote clients (the relay host, see
//! PRO-13).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::value::RawValue;

use crate::events::AgentEvent;
use crate::store::index::TabStatus;

pub type Handler = Box<dyn Fn(&str) + Send + Sync>;
type Listeners = HashMap<String, Vec<(ListenerId, Arc<Handler>)>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ListenerId {
    Event(u64),
    #[cfg(feature = "desktop")]
    Pty(u64),
}

pub trait EventSink: Send + Sync {
    /// Publish one event whose payload is already JSON.
    fn emit_raw(&self, event: &str, payload: Box<RawValue>);
    /// Backend consumers of PTY output (mobile and remote clients). Desktop
    /// xterms already receive raw channels and must not receive this again.
    fn emit_pty(&self, id: &str, bytes: &[u8]) {
        use base64::Engine as _;
        let payload = crate::pty::PtyData {
            id: id.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        };
        if let Ok(raw) = serde_json::value::to_raw_value(&payload) {
            self.emit_raw("pty_data", raw);
        }
    }
    /// Call `handler` with the JSON payload of every later `event`.
    fn listen(&self, event: &str, handler: Handler) -> ListenerId;
    fn unlisten(&self, id: ListenerId);
}

impl<'a> dyn EventSink + 'a {
    pub fn emit<S: Serialize + ?Sized>(&self, event: &str, payload: &S) {
        match serde_json::value::to_raw_value(payload) {
            Ok(raw) => self.emit_raw(event, raw),
            Err(error) => log::warn!("serialize {event} event: {error}"),
        }
    }
}

/// What the desktop does on the side when a session moves: the GitHub star
/// reminder and scheduled automation runs. Neither exists headless, where
/// every method is a no-op.
pub trait SessionObserver: Send + Sync {
    fn agent_event(&self, _event: &AgentEvent) {}
    fn work_started(&self, _total_work_starts: u64) {}
    fn tab_status(&self, _key: String, _status: TabStatus) {}
    fn interrupted(&self, _key: &str) {}
    fn automation_running(&self, _session_id: &str, _tab_id: &str) {}
    fn automation_completed(&self, _session_id: &str, _tab_id: &str, _final_message: Option<String>) {}
    fn automation_failed(&self, _session_id: &str, _tab_id: &str, _message: &str) {}
}

pub struct NoObserver;

impl SessionObserver for NoObserver {}

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

    /// Separate from Tauri's event bus: even an `Any` JavaScript listener
    /// cannot accidentally subscribe to the legacy base64 stream.
    struct PtyListeners {
        sink: BroadcastSink,
    }

    impl<R: Runtime> EventSink for AppHandle<R> {
        fn emit_raw(&self, event: &str, payload: Box<RawValue>) {
            if event == "pty_data" {
                if let Some(listeners) = self.try_state::<PtyListeners>() {
                    listeners.sink.emit_raw(event, payload);
                }
                return;
            }
            // Already JSON: hand Tauri the buffer rather than serializing it again.
            let _ = Emitter::emit_str(self, event, String::from(Box::<str>::from(payload)));
        }

        fn emit_pty(&self, id: &str, bytes: &[u8]) {
            if let Some(listeners) = self.try_state::<PtyListeners>() {
                // No mobile subscriber: no base64 allocation or JSON serialization.
                let subscribed = listeners
                    .sink
                    .listeners
                    .lock()
                    .unwrap()
                    .get("pty_data")
                    .is_some_and(|entries| !entries.is_empty());
                if subscribed {
                    listeners.sink.emit_pty(id, bytes);
                }
            }
        }

        fn listen(&self, event: &str, handler: Handler) -> ListenerId {
            if event == "pty_data" {
                self.manage(PtyListeners { sink: BroadcastSink::new(1) });
                let ListenerId::Event(id) = self.state::<PtyListeners>().sink.listen(event, handler)
                else {
                    unreachable!()
                };
                return ListenerId::Pty(id);
            }
            ListenerId::Event(u64::from(Listener::listen(
                self,
                event.to_string(),
                move |e| handler(e.payload()),
            )))
        }

        fn unlisten(&self, id: ListenerId) {
            match id {
                ListenerId::Pty(id) => {
                    if let Some(listeners) = self.try_state::<PtyListeners>() {
                        listeners.sink.unlisten(ListenerId::Event(id));
                    }
                }
                ListenerId::Event(id) => {
                    if let Ok(id) = u32::try_from(id) {
                        Listener::unlisten(self, id);
                    }
                }
            }
        }
    }

    impl SessionObserver for AppHandle {
        fn agent_event(&self, event: &AgentEvent) {
            self.state::<crate::AppState>().star_nag.observe(self, event);
        }

        fn work_started(&self, total_work_starts: u64) {
            self.state::<crate::AppState>().star_nag.work_started(self, total_work_starts);
        }

        fn tab_status(&self, key: String, status: TabStatus) {
            self.state::<crate::AppState>().star_nag.status(self, key, status);
        }

        fn interrupted(&self, key: &str) {
            self.state::<crate::AppState>().star_nag.interrupted(key);
        }

        fn automation_running(&self, session_id: &str, tab_id: &str) {
            crate::automations::mark_running_from_hook(self, session_id, tab_id);
        }

        fn automation_completed(&self, session_id: &str, tab_id: &str, final_message: Option<String>) {
            crate::automations::complete_from_hook(self, session_id, tab_id, final_message);
        }

        fn automation_failed(&self, session_id: &str, tab_id: &str, message: &str) {
            crate::automations::fail_from_hook(self, session_id, tab_id, message);
        }
    }
}

/// One event as the headless runtime publishes it.
#[derive(Debug, Clone)]
pub struct Published {
    pub event: Arc<str>,
    pub payload: Arc<str>,
}

/// The headless sink: Rust listeners run inline, as Tauri runs them, and
/// every event is also offered to broadcast subscribers. A subscriber that
/// falls behind loses the oldest events, never blocks the emitter.
pub struct BroadcastSink {
    next_id: AtomicU64,
    listeners: Mutex<Listeners>,
    tx: tokio::sync::broadcast::Sender<Published>,
}

impl BroadcastSink {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(capacity.max(1));
        Self { next_id: AtomicU64::new(1), listeners: Mutex::new(HashMap::new()), tx }
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Published> {
        self.tx.subscribe()
    }
}

impl EventSink for BroadcastSink {
    fn emit_raw(&self, event: &str, payload: Box<RawValue>) {
        let payload: Arc<str> = Arc::from(payload.get());
        // Handlers are called outside the lock so one may listen or unlisten.
        let handlers: Vec<Arc<Handler>> = self
            .listeners
            .lock()
            .unwrap()
            .get(event)
            .map(|registered| registered.iter().map(|(_, handler)| handler.clone()).collect())
            .unwrap_or_default();
        for handler in handlers {
            handler(&payload);
        }
        let _ = self.tx.send(Published { event: Arc::from(event), payload });
    }

    fn listen(&self, event: &str, handler: Handler) -> ListenerId {
        let id = ListenerId::Event(self.next_id.fetch_add(1, Ordering::Relaxed));
        self.listeners
            .lock()
            .unwrap()
            .entry(event.to_string())
            .or_default()
            .push((id, Arc::new(handler)));
        id
    }

    fn unlisten(&self, id: ListenerId) {
        for registered in self.listeners.lock().unwrap().values_mut() {
            registered.retain(|(listener, _)| *listener != id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "desktop")]
    #[test]
    fn desktop_pty_output_stays_off_the_tauri_event_bus() {
        let app = tauri::test::mock_app();
        let handle = app.handle();
        let global = Arc::new(AtomicU64::new(0));
        let seen = global.clone();
        tauri::Listener::listen_any(handle, "pty_data", move |_| {
            seen.fetch_add(1, Ordering::Relaxed);
        });
        let backend = Arc::new(Mutex::new(Vec::new()));
        let received = backend.clone();
        let sink: &dyn EventSink = handle;
        let id = sink.listen(
            "pty_data",
            Box::new(move |payload| received.lock().unwrap().push(payload.to_string())),
        );
        sink.emit_pty("pane", &[0, 255, 27]);
        assert_eq!(global.load(Ordering::Relaxed), 0);
        assert_eq!(backend.lock().unwrap().len(), 1);
        let data: crate::pty::PtyData = serde_json::from_str(&backend.lock().unwrap()[0]).unwrap();
        assert_eq!(data.id, "pane");
        assert_eq!(data.data, "AP8b");
        sink.unlisten(id);
        sink.emit_pty("pane", b"later");
        assert_eq!(backend.lock().unwrap().len(), 1);
    }

    #[test]
    fn headless_pty_output_reaches_remote_consumers() {
        let sink = BroadcastSink::new(1);
        let mut rx = sink.subscribe();
        sink.emit_pty("pane", b"hello");
        let event = rx.try_recv().unwrap();
        assert_eq!(&*event.event, "pty_data");
        let data: crate::pty::PtyData = serde_json::from_str(&event.payload).unwrap();
        assert_eq!(data.data, "aGVsbG8=");
    }

    #[test]
    fn broadcast_sink_runs_listeners_and_publishes_the_same_json() {
        let sink = BroadcastSink::new(8);
        let mut rx = sink.subscribe();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let heard = seen.clone();
        let id = sink.listen("pty_exit", Box::new(move |payload| heard.lock().unwrap().push(payload.to_string())));
        let dyn_sink: &dyn EventSink = &sink;
        dyn_sink.emit("pty_exit", &serde_json::json!({ "id": "pane", "code": 0 }));
        dyn_sink.emit("pty_data", &serde_json::json!({ "id": "pane" }));
        sink.unlisten(id);
        dyn_sink.emit("pty_exit", &serde_json::json!({ "id": "later" }));

        assert_eq!(*seen.lock().unwrap(), vec![r#"{"code":0,"id":"pane"}"#.to_string()]);
        let first = rx.try_recv().unwrap();
        assert_eq!(&*first.event, "pty_exit");
        assert_eq!(&*first.payload, r#"{"code":0,"id":"pane"}"#);
        assert_eq!(&*rx.try_recv().unwrap().event, "pty_data");
        assert_eq!(&*rx.try_recv().unwrap().event, "pty_exit");
    }

    #[test]
    fn a_listener_may_unlisten_itself_while_handling() {
        let sink = Arc::new(BroadcastSink::new(1));
        let slot = Arc::new(Mutex::new(None::<ListenerId>));
        let (inner, owner) = (sink.clone(), slot.clone());
        let id = sink.listen(
            "once",
            Box::new(move |_| {
                if let Some(id) = owner.lock().unwrap().take() {
                    inner.unlisten(id);
                }
            }),
        );
        *slot.lock().unwrap() = Some(id);
        let dyn_sink: &dyn EventSink = &*sink;
        dyn_sink.emit("once", &());
        assert!(sink.listeners.lock().unwrap()["once"].is_empty());
    }
}
