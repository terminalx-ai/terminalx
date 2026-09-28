//! Where the backend's events go. Sessions, terminals and pairing publish
//! through an `EventSink` rather than a Tauri `AppHandle`, so the same code
//! runs inside the desktop app and inside the headless `terminalx-serve`
//! runtime a cloud workspace boots.
//!
//! The desktop sink is the `AppHandle` itself: an emit reaches the webview and
//! every Rust listener exactly as a direct `app.emit` did. The headless sink
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
pub struct ListenerId(u64);

pub trait EventSink: Send + Sync {
    /// Publish one event whose payload is already JSON.
    fn emit_raw(&self, event: &str, payload: Box<RawValue>);
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

    impl<R: Runtime> EventSink for AppHandle<R> {
        fn emit_raw(&self, event: &str, payload: Box<RawValue>) {
            let _ = Emitter::emit(self, event, payload);
        }

        fn listen(&self, event: &str, handler: Handler) -> ListenerId {
            ListenerId(u64::from(Listener::listen(self, event.to_string(), move |e| handler(e.payload()))))
        }

        fn unlisten(&self, id: ListenerId) {
            if let Ok(id) = u32::try_from(id.0) {
                Listener::unlisten(self, id);
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
        let id = ListenerId(self.next_id.fetch_add(1, Ordering::Relaxed));
        self.listeners.lock().unwrap().entry(event.to_string()).or_default().push((id, Arc::new(handler)));
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
