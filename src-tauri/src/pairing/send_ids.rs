//! Sends a phone names with a `clientMessageId`, answered once (#675).
//!
//! The phone learns that a message reached the agent only from the Mac's
//! reply. When the connection drops before the reply gets back, the phone
//! cannot tell whether the Mac has the message, and it offers to send it
//! again under the same id. A repeat gets the first reply and does nothing
//! else, so the agent never gets the prompt twice.
//!
//! Only replies are kept. A send that failed here is not one the Mac has, and
//! sending it again tries it in full. The replies outlive the app (a quit or an
//! update between the dropped reply and the retry) for a day.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long a reply is kept: a draft left in the box overnight still matches.
const KEEP_MILLIS: i64 = 24 * 60 * 60 * 1000;
/// At most this many replies are kept; the oldest go first.
const KEEP_COUNT: usize = 1_000;
/// How long a repeat waits for the first copy still being sent. The phone
/// gives up on a request after 30 seconds; this answers before it does.
const WAIT_FOR_FIRST: Duration = Duration::from_secs(20);

/// Shown after "Message not sent: ". The id still matches, so sending again
/// later gets the first copy's reply instead of a second prompt.
pub(super) const STILL_SENDING: &str =
    "your Mac is still sending an earlier try of this message; send it again in a moment to see whether it arrived";
/// The phone gives each draft its own id; this one came with other text.
pub(super) const ID_REUSED: &str =
    "your Mac already has a different message with this message's id; change the message and send it again";

/// One send: the tab it went to and the id the phone gave it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendKey {
    pub tab_id: String,
    pub client_message_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sent {
    key: SendKey,
    /// What was sent, so an id that comes back with another message is refused.
    digest: String,
    reply: Value,
    /// Unix milliseconds: kept across restarts, unlike an `Instant`.
    at: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct SentFile {
    #[serde(default)]
    sent: Vec<Sent>,
}

#[derive(Default)]
struct State {
    loaded: bool,
    /// Oldest first.
    sent: VecDeque<Sent>,
    /// Sends under way, by digest: a repeat waits for these instead of sending.
    sending: HashMap<SendKey, String>,
}

impl State {
    fn prune(&mut self, now: i64) {
        self.sent.retain(|sent| now - sent.at < KEEP_MILLIS);
        while self.sent.len() > KEEP_COUNT {
            self.sent.pop_front();
        }
    }

    fn find(&self, key: &SendKey) -> Option<&Sent> {
        self.sent.iter().rev().find(|sent| sent.key == *key)
    }
}

pub(super) struct SendIds {
    path: Box<dyn Fn() -> Result<PathBuf> + Send + Sync>,
    wait: Duration,
    clock: fn() -> i64,
    state: Mutex<State>,
    settled: Condvar,
}

impl SendIds {
    pub(super) fn new() -> Self {
        Self::with(Box::new(|| Ok(crate::store::root()?.join("mobile-sends.json"))), WAIT_FOR_FIRST, now)
    }

    fn with(path: Box<dyn Fn() -> Result<PathBuf> + Send + Sync>, wait: Duration, clock: fn() -> i64) -> Self {
        Self { path, wait, clock, state: Mutex::new(State::default()), settled: Condvar::new() }
    }

    /// Run `send` once for `key`. A repeat of the same message (`digest`) gets
    /// the first reply; one that arrives while the first is still being sent
    /// waits for it. The same id with another message is refused.
    pub(super) fn once(&self, key: SendKey, digest: String, send: impl FnOnce() -> Result<Value>) -> Result<Value> {
        let deadline = Instant::now() + self.wait;
        let mut state = self.state();
        loop {
            state.prune((self.clock)());
            if let Some(sent) = state.find(&key) {
                if sent.digest != digest {
                    bail!(ID_REUSED);
                }
                return Ok(sent.reply.clone());
            }
            let Some(first) = state.sending.get(&key) else { break };
            if *first != digest {
                bail!(ID_REUSED);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                bail!(STILL_SENDING);
            }
            state = self.settled.wait_timeout(state, left).unwrap_or_else(PoisonError::into_inner).0;
        }
        state.sending.insert(key.clone(), digest.clone());
        drop(state);
        let mut sending = Sending { ids: self, key: Some(key) };
        let reply = send()?;
        sending.done(digest, reply.clone());
        Ok(reply)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if !state.loaded {
            state.loaded = true;
            // A file this cannot read costs only the replies in it: sending
            // must not stop because an earlier day's replies are unreadable.
            match self.load() {
                Ok(sent) => state.sent = sent.into(),
                Err(error) => log::warn!("read remembered mobile sends: {error:#}"),
            }
        }
        state
    }

    fn load(&self) -> Result<Vec<Sent>> {
        Ok(crate::store::read_json::<SentFile>(&(self.path)()?)?.unwrap_or_default().sent)
    }

    fn save(&self, state: &State) {
        let file = SentFile { sent: state.sent.iter().cloned().collect() };
        // The agent has the message. Failing to write that down must not read
        // as a failed send; a repeat while the app runs is still answered.
        if let Err(error) = (self.path)().and_then(|path| crate::store::write_json(&path, &file)) {
            log::warn!("remember mobile send: {error:#}");
        }
    }
}

/// A send under way. Dropped without `done` (an error, or a panic), it lets a
/// waiting repeat go ahead and try the send itself.
struct Sending<'a> {
    ids: &'a SendIds,
    key: Option<SendKey>,
}

impl Sending<'_> {
    fn done(&mut self, digest: String, reply: Value) {
        let Some(key) = self.key.take() else { return };
        let mut state = self.ids.state();
        state.sending.remove(&key);
        state.sent.push_back(Sent { key, digest, reply, at: (self.ids.clock)() });
        state.prune((self.ids.clock)());
        self.ids.save(&state);
        drop(state);
        self.ids.settled.notify_all();
    }
}

impl Drop for Sending<'_> {
    fn drop(&mut self) {
        let Some(key) = self.key.take() else { return };
        self.ids.state().sending.remove(&key);
        self.ids.settled.notify_all();
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};

    fn test_clock() -> i64 {
        1_000_000_000
    }

    fn ids(path: PathBuf, wait: Duration) -> SendIds {
        SendIds::with(Box::new(move || Ok(path.clone())), wait, test_clock)
    }

    fn key(id: &str) -> SendKey {
        SendKey { tab_id: "tab".into(), client_message_id: id.into() }
    }

    #[test]
    fn a_repeat_gets_the_first_reply_and_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"), Duration::from_secs(1));
        let sends = AtomicUsize::new(0);
        let send = || {
            sends.fetch_add(1, Ordering::SeqCst);
            Ok(json!({ "status": "sent", "queued": true }))
        };
        assert_eq!(ids.once(key("a"), "d".into(), send).unwrap(), json!({ "status": "sent", "queued": true }));
        assert_eq!(ids.once(key("a"), "d".into(), send).unwrap(), json!({ "status": "sent", "queued": true }));
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        // Another id, or the same id for another tab, is another message.
        ids.once(key("b"), "d".into(), send).unwrap();
        ids.once(SendKey { tab_id: "other".into(), client_message_id: "a".into() }, "d".into(), send).unwrap();
        assert_eq!(sends.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_failed_send_is_not_remembered_and_sending_again_tries_it() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"), Duration::from_secs(1));
        let error = ids.once(key("a"), "d".into(), || bail!("the agent is restarting")).unwrap_err();
        assert_eq!(error.to_string(), "the agent is restarting");
        assert_eq!(ids.once(key("a"), "d".into(), || Ok(json!({ "status": "sent" }))).unwrap(), json!({ "status": "sent" }));
    }

    #[test]
    fn an_id_that_comes_back_with_another_message_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"), Duration::from_secs(1));
        ids.once(key("a"), "first".into(), || Ok(json!({ "status": "sent" }))).unwrap();
        let error = ids.once(key("a"), "second".into(), || panic!("must not send")).unwrap_err();
        assert_eq!(error.to_string(), ID_REUSED);
    }

    #[test]
    fn a_repeat_while_the_first_is_still_sending_waits_for_its_reply() {
        let dir = tempfile::tempdir().unwrap();
        let ids = Arc::new(ids(dir.path().join("sends.json"), Duration::from_secs(10)));
        let (started, wait_started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let first = std::thread::spawn({
            let ids = ids.clone();
            move || ids.once(key("a"), "d".into(), || {
                started.send(()).unwrap();
                released.recv().unwrap();
                Ok(json!({ "status": "sent", "queued": false }))
            })
        });
        wait_started.recv().unwrap();
        let repeat = std::thread::spawn({
            let ids = ids.clone();
            move || ids.once(key("a"), "d".into(), || panic!("the repeat must not send"))
        });
        // The repeat is waiting, not sending; let the first finish.
        std::thread::sleep(Duration::from_millis(50));
        assert!(!repeat.is_finished());
        release.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap(), json!({ "status": "sent", "queued": false }));
        assert_eq!(repeat.join().unwrap().unwrap(), json!({ "status": "sent", "queued": false }));
    }

    #[test]
    fn a_repeat_after_the_first_failed_sends_it_itself() {
        let dir = tempfile::tempdir().unwrap();
        let ids = Arc::new(ids(dir.path().join("sends.json"), Duration::from_secs(10)));
        let (started, wait_started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let first = std::thread::spawn({
            let ids = ids.clone();
            move || ids.once(key("a"), "d".into(), || {
                started.send(()).unwrap();
                released.recv().unwrap();
                bail!("tab not found")
            })
        });
        wait_started.recv().unwrap();
        let repeat = std::thread::spawn({
            let ids = ids.clone();
            move || ids.once(key("a"), "d".into(), || Ok(json!({ "status": "sent" })))
        });
        std::thread::sleep(Duration::from_millis(50));
        release.send(()).unwrap();
        assert!(first.join().unwrap().is_err());
        assert_eq!(repeat.join().unwrap().unwrap(), json!({ "status": "sent" }));
    }

    #[test]
    fn a_repeat_that_waits_too_long_is_refused_without_sending() {
        let dir = tempfile::tempdir().unwrap();
        let ids = Arc::new(ids(dir.path().join("sends.json"), Duration::from_millis(50)));
        let (started, wait_started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let first = std::thread::spawn({
            let ids = ids.clone();
            move || ids.once(key("a"), "d".into(), || {
                started.send(()).unwrap();
                released.recv().unwrap();
                Ok(json!({ "status": "sent" }))
            })
        });
        wait_started.recv().unwrap();
        let error = ids.once(key("a"), "d".into(), || panic!("must not send")).unwrap_err();
        assert_eq!(error.to_string(), STILL_SENDING);
        release.send(()).unwrap();
        first.join().unwrap().unwrap();
        // Once it has finished, the same id gets its reply.
        assert_eq!(ids.once(key("a"), "d".into(), || panic!("must not send")).unwrap(), json!({ "status": "sent" }));
    }

    #[test]
    fn a_send_that_panics_lets_a_later_try_send() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"), Duration::from_millis(50));
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = ids.once(key("a"), "d".into(), || panic!("writer crashed"));
        }));
        assert!(panicked.is_err());
        assert_eq!(ids.once(key("a"), "d".into(), || Ok(json!({ "status": "sent" }))).unwrap(), json!({ "status": "sent" }));
    }

    #[test]
    fn replies_outlive_a_restart_for_a_day_and_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sends.json");
        let start = test_clock();
        ids(path.clone(), Duration::from_secs(1)).once(key("a"), "d".into(), || Ok(json!({ "status": "sent" }))).unwrap();

        // The app quit; the reply is read back from disk.
        let restarted = ids(path.clone(), Duration::from_secs(1));
        assert_eq!(restarted.once(key("a"), "d".into(), || panic!("must not send")).unwrap(), json!({ "status": "sent" }));

        // A file that cannot be read loses only what was in it.
        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(ids(path.clone(), Duration::from_secs(1)).once(key("a"), "d".into(), || Ok(json!({ "again": true }))).unwrap(), json!({ "again": true }));

        // Older than a day: forgotten.
        let file = SentFile { sent: vec![Sent { key: key("old"), digest: "d".into(), reply: json!({ "status": "sent" }), at: start - KEEP_MILLIS }] };
        crate::store::write_json(&path, &file).unwrap();
        assert_eq!(ids(path.clone(), Duration::from_secs(1)).once(key("old"), "d".into(), || Ok(json!({ "again": true }))).unwrap(), json!({ "again": true }));

        // At most KEEP_COUNT, the oldest dropped first.
        let full = ids(path.clone(), Duration::from_secs(1));
        for index in 0..=KEEP_COUNT {
            full.once(key(&format!("id-{index}")), "d".into(), || Ok(json!(index))).unwrap();
        }
        let saved: SentFile = crate::store::read_json(&path).unwrap().unwrap();
        assert_eq!(saved.sent.len(), KEEP_COUNT);
        assert_eq!(full.once(key("id-0"), "d".into(), || Ok(json!("again"))).unwrap(), json!("again"));
        assert_eq!(full.once(key(&format!("id-{KEEP_COUNT}")), "d".into(), || panic!("must not send")).unwrap(), json!(KEEP_COUNT));
    }
}
