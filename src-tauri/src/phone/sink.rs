//! The runtime's phone notices stay in the runtime (PRO-359).
//!
//! The phone RPC publishes each notice as a `mobile_notification` event, and a
//! phone's notification subscription listens for it on the same sink. In the
//! window that sink is the window's own bus. In the runtime it is the runtime's
//! sink, whose every event also streams to the window, which publishes it on
//! its bus. The window's phones would then get each notice twice: once from
//! the window, and once, with the runtime's epoch and sequence, from the
//! runtime. So the runtime's phone host publishes and hears its notices on
//! this sink, which keeps them in process and passes every other event, and
//! every other listener, to the runtime's sink.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;

use crate::sink::{EventSink, Handler, ListenerId};

/// The event kept in process.
pub(crate) const NOTICE: &str = "mobile_notification";

/// Ids of listeners kept here: the top bit set, which the sink behind never
/// reaches by counting up from 1.
const LOCAL: u64 = 1 << 63;

pub(crate) struct NoticesInProcess {
    inner: Arc<dyn EventSink>,
    next: AtomicU64,
    listeners: Mutex<HashMap<u64, Arc<Handler>>>,
}

impl NoticesInProcess {
    pub(crate) fn new(inner: Arc<dyn EventSink>) -> Self {
        Self { inner, next: AtomicU64::new(1), listeners: Mutex::new(HashMap::new()) }
    }
}

impl EventSink for NoticesInProcess {
    fn emit_raw(&self, event: &str, payload: Box<RawValue>) {
        if event != NOTICE {
            return self.inner.emit_raw(event, payload);
        }
        // Called outside the lock, so a handler may listen or unlisten.
        let handlers: Vec<Arc<Handler>> = self.listeners.lock().unwrap().values().cloned().collect();
        for handler in handlers {
            handler(payload.get());
        }
    }

    fn emit_pty_sized(&self, id: &str, bytes: &[u8], size: Option<crate::pty::OutputSize>) {
        self.inner.emit_pty_sized(id, bytes, size);
    }

    fn listen(&self, event: &str, handler: Handler) -> ListenerId {
        if event != NOTICE {
            return self.inner.listen(event, handler);
        }
        let id = LOCAL | self.next.fetch_add(1, Ordering::Relaxed);
        self.listeners.lock().unwrap().insert(id, Arc::new(handler));
        ListenerId::Event(id)
    }

    fn unlisten(&self, id: ListenerId) {
        match id {
            ListenerId::Event(local) if local & LOCAL != 0 => {
                self.listeners.lock().unwrap().remove(&local);
            }
            other => self.inner.unlisten(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sink::BroadcastSink;

    #[test]
    fn notices_stay_in_process_and_everything_else_passes_through() {
        let runtime = Arc::new(BroadcastSink::new(16));
        // What streams to the window.
        let mut window = runtime.subscribe_app();
        let sink = NoticesInProcess::new(runtime.clone());
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let notices = heard.clone();
        let listener = sink.listen(NOTICE, Box::new(move |payload| notices.lock().unwrap().push(payload.to_string())));
        let passed = Arc::new(Mutex::new(0));
        let count = passed.clone();
        sink.listen("session_updated", Box::new(move |_| *count.lock().unwrap() += 1));

        sink.emit_raw(NOTICE, RawValue::from_string("{\"seq\":1}".into()).unwrap());
        sink.emit_raw("session_updated", RawValue::from_string("{}".into()).unwrap());

        assert_eq!(*heard.lock().unwrap(), ["{\"seq\":1}"], "the runtime's phones hear the notice");
        assert_eq!(*passed.lock().unwrap(), 1, "other listeners are the runtime's");
        let streamed = window.try_recv().unwrap();
        assert_eq!(&*streamed.event, "session_updated", "the window gets every other event, and never the notice");
        assert!(window.try_recv().is_err());

        sink.unlisten(listener);
        sink.emit_raw(NOTICE, RawValue::from_string("{\"seq\":2}".into()).unwrap());
        assert_eq!(heard.lock().unwrap().len(), 1, "an ended listener hears nothing more");
    }
}
