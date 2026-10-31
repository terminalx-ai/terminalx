//! Sends a phone names with a `clientMessageId`, answered once (#675).
//!
//! The phone learns that a message reached the agent only from the Mac's
//! reply. When the connection drops before the reply gets back, the phone
//! cannot tell whether the Mac has the message, and it offers to send it
//! again under the same id. A repeat of a send the agent has gets the first
//! reply and does nothing else, so the agent never gets the prompt twice.
//!
//! Only settled replies answer a repeat. A send that failed here is not one
//! the Mac has: sending it again tries it in full. A send queued behind the
//! agent's turn is not settled either: the queued copy is dropped if the
//! connection it came over closes first, so a repeat goes through to the
//! runtime again, which finds that copy instead of queueing a second one.
//! The replies outlive the app (a quit or an update between the dropped
//! reply and the retry) for a day.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long a reply is kept: a draft left in the box overnight still matches.
const KEEP_MILLIS: i64 = 24 * 60 * 60 * 1000;
/// At most this many replies are kept; the oldest go first.
const KEEP_COUNT: usize = 1_000;

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

/// What a send came to, and whether that answers a repeat.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Reply {
    /// The agent has the message: a repeat gets this reply and sends nothing.
    Settled(Value),
    /// Queued behind the agent's turn, where the copy can still be dropped:
    /// a repeat goes through again.
    Unsettled(Value),
}

impl Reply {
    pub(super) fn into_value(self) -> Value {
        match self {
            Reply::Settled(value) | Reply::Unsettled(value) => value,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sent {
    key: SendKey,
    /// What was sent, so an id that comes back with another message is
    /// refused, whether or not its reply is settled.
    digest: String,
    /// The settled reply; none while the send waits in the agent's queue.
    #[serde(default)]
    reply: Option<Value>,
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
    /// Oldest first; one entry per key.
    sent: VecDeque<Sent>,
    /// Sends under way, by digest.
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
        self.sent.iter().find(|sent| sent.key == *key)
    }
}

pub(super) struct SendIds {
    path: Box<dyn Fn() -> Result<PathBuf> + Send + Sync>,
    clock: fn() -> i64,
    state: Mutex<State>,
}

impl SendIds {
    pub(super) fn new() -> Self {
        Self::with(Box::new(|| Ok(crate::store::root()?.join("mobile-sends.json"))), now)
    }

    #[cfg(test)]
    pub(super) fn at(path: PathBuf) -> Self {
        Self::with(Box::new(move || Ok(path.clone())), now)
    }

    fn with(path: Box<dyn Fn() -> Result<PathBuf> + Send + Sync>, clock: fn() -> i64) -> Self {
        Self { path, clock, state: Mutex::new(State::default()) }
    }

    /// Run `send` once for `key`, unless its settled reply is known. A repeat
    /// of the same message (`digest`) gets that reply. One that arrives while
    /// the first is still being sent is refused at once rather than made to
    /// wait: the connection it came over must keep answering meanwhile. The
    /// same id with another message is refused.
    pub(super) fn once(&self, key: SendKey, digest: String, send: impl FnOnce() -> Result<Reply>) -> Result<Value> {
        let mut state = self.state();
        state.prune((self.clock)());
        if let Some(first) = state.sending.get(&key) {
            bail!(if *first == digest { STILL_SENDING } else { ID_REUSED });
        }
        if let Some(sent) = state.find(&key) {
            if sent.digest != digest {
                bail!(ID_REUSED);
            }
            if let Some(reply) = &sent.reply {
                return Ok(reply.clone());
            }
        }
        state.sending.insert(key.clone(), digest.clone());
        drop(state);
        let mut sending = Sending { ids: self, key: Some(key) };
        let reply = send()?;
        sending.done(digest, &reply);
        Ok(reply.into_value())
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

/// A send under way. Dropped without `done` (an error, or a panic), it lets
/// a later try send in full.
struct Sending<'a> {
    ids: &'a SendIds,
    key: Option<SendKey>,
}

impl Sending<'_> {
    fn done(&mut self, digest: String, reply: &Reply) {
        let Some(key) = self.key.take() else { return };
        let reply = match reply {
            Reply::Settled(value) => Some(value.clone()),
            Reply::Unsettled(_) => None,
        };
        let mut state = self.ids.state();
        state.sending.remove(&key);
        state.sent.retain(|sent| sent.key != key);
        state.sent.push_back(Sent { key, digest, reply, at: (self.ids.clock)() });
        state.prune((self.ids.clock)());
        self.ids.save(&state);
    }
}

impl Drop for Sending<'_> {
    fn drop(&mut self) {
        let Some(key) = self.key.take() else { return };
        self.ids.state().sending.remove(&key);
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

    fn ids(path: PathBuf) -> SendIds {
        SendIds::with(Box::new(move || Ok(path.clone())), test_clock)
    }

    fn key(id: &str) -> SendKey {
        SendKey { tab_id: "tab".into(), client_message_id: id.into() }
    }

    fn sent() -> Value {
        json!({ "status": "sent", "queued": false })
    }

    fn queued() -> Value {
        json!({ "status": "sent", "queued": true })
    }

    #[test]
    fn a_repeat_gets_the_settled_reply_and_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"));
        let sends = AtomicUsize::new(0);
        let send = || {
            sends.fetch_add(1, Ordering::SeqCst);
            Ok(Reply::Settled(sent()))
        };
        assert_eq!(ids.once(key("a"), "d".into(), send).unwrap(), sent());
        assert_eq!(ids.once(key("a"), "d".into(), send).unwrap(), sent());
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        // Another id, or the same id for another tab, is another message.
        ids.once(key("b"), "d".into(), send).unwrap();
        ids.once(SendKey { tab_id: "other".into(), client_message_id: "a".into() }, "d".into(), send).unwrap();
        assert_eq!(sends.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_queued_send_goes_through_again_until_it_settles() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"));
        let sends = AtomicUsize::new(0);
        // The runtime finds its queued copy on the repeat, and then that the
        // agent has it: each try is asked, until a reply settles it.
        let answers = [Reply::Unsettled(queued()), Reply::Unsettled(queued()), Reply::Settled(sent())];
        for answer in answers {
            let reply = answer.clone().into_value();
            assert_eq!(ids.once(key("a"), "d".into(), || { sends.fetch_add(1, Ordering::SeqCst); Ok(answer) }).unwrap(), reply);
        }
        assert_eq!(sends.load(Ordering::SeqCst), 3);
        assert_eq!(ids.once(key("a"), "d".into(), || panic!("settled: must not send")).unwrap(), sent());
        // Unsettled, the id is still held to its message.
        ids.once(key("b"), "first".into(), || Ok(Reply::Unsettled(queued()))).unwrap();
        assert_eq!(ids.once(key("b"), "second".into(), || panic!("must not send")).unwrap_err().to_string(), ID_REUSED);
    }

    #[test]
    fn a_failed_send_is_not_remembered_and_sending_again_tries_it() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"));
        let error = ids.once(key("a"), "d".into(), || bail!("the agent is restarting")).unwrap_err();
        assert_eq!(error.to_string(), "the agent is restarting");
        assert_eq!(ids.once(key("a"), "d".into(), || Ok(Reply::Settled(sent()))).unwrap(), sent());
    }

    #[test]
    fn an_id_that_comes_back_with_another_message_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"));
        ids.once(key("a"), "first".into(), || Ok(Reply::Settled(sent()))).unwrap();
        let error = ids.once(key("a"), "second".into(), || panic!("must not send")).unwrap_err();
        assert_eq!(error.to_string(), ID_REUSED);
    }

    #[test]
    fn a_repeat_while_the_first_is_still_sending_is_refused_at_once_without_sending() {
        let dir = tempfile::tempdir().unwrap();
        let ids = Arc::new(ids(dir.path().join("sends.json")));
        let (started, wait_started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let first = std::thread::spawn({
            let ids = ids.clone();
            move || ids.once(key("a"), "d".into(), || {
                started.send(()).unwrap();
                released.recv().unwrap();
                Ok(Reply::Settled(sent()))
            })
        });
        wait_started.recv().unwrap();
        // No wait: the connection the repeat came over keeps answering.
        assert_eq!(ids.once(key("a"), "d".into(), || panic!("must not send")).unwrap_err().to_string(), STILL_SENDING);
        assert_eq!(ids.once(key("a"), "other".into(), || panic!("must not send")).unwrap_err().to_string(), ID_REUSED);
        release.send(()).unwrap();
        first.join().unwrap().unwrap();
        // Once it has finished, the same id gets its reply.
        assert_eq!(ids.once(key("a"), "d".into(), || panic!("must not send")).unwrap(), sent());
    }

    #[test]
    fn a_send_that_panics_lets_a_later_try_send() {
        let dir = tempfile::tempdir().unwrap();
        let ids = ids(dir.path().join("sends.json"));
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = ids.once(key("a"), "d".into(), || panic!("writer crashed"));
        }));
        assert!(panicked.is_err());
        assert_eq!(ids.once(key("a"), "d".into(), || Ok(Reply::Settled(sent()))).unwrap(), sent());
    }

    #[test]
    fn replies_outlive_a_restart_for_a_day_and_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sends.json");
        let start = test_clock();
        ids(path.clone()).once(key("a"), "d".into(), || Ok(Reply::Settled(sent()))).unwrap();
        ids(path.clone()).once(key("q"), "d".into(), || Ok(Reply::Unsettled(queued()))).unwrap();

        // The app quit; the replies are read back from disk.
        let restarted = ids(path.clone());
        assert_eq!(restarted.once(key("a"), "d".into(), || panic!("must not send")).unwrap(), sent());
        // A queued send stays unsettled, and held to its message.
        assert_eq!(restarted.once(key("q"), "other".into(), || panic!("must not send")).unwrap_err().to_string(), ID_REUSED);
        assert_eq!(restarted.once(key("q"), "d".into(), || Ok(Reply::Settled(sent()))).unwrap(), sent());

        // A file that cannot be read loses only what was in it.
        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(ids(path.clone()).once(key("a"), "d".into(), || Ok(Reply::Settled(json!({ "again": true })))).unwrap(), json!({ "again": true }));

        // Older than a day: forgotten.
        let file = SentFile { sent: vec![Sent { key: key("old"), digest: "d".into(), reply: Some(sent()), at: start - KEEP_MILLIS }] };
        crate::store::write_json(&path, &file).unwrap();
        assert_eq!(ids(path.clone()).once(key("old"), "d".into(), || Ok(Reply::Settled(json!({ "again": true })))).unwrap(), json!({ "again": true }));

        // At most KEEP_COUNT, the oldest dropped first.
        let full = ids(path.clone());
        for index in 0..=KEEP_COUNT {
            full.once(key(&format!("id-{index}")), "d".into(), || Ok(Reply::Settled(json!(index)))).unwrap();
        }
        let saved: SentFile = crate::store::read_json(&path).unwrap().unwrap();
        assert_eq!(saved.sent.len(), KEEP_COUNT);
        assert_eq!(full.once(key("id-0"), "d".into(), || Ok(Reply::Settled(json!("again")))).unwrap(), json!("again"));
        assert_eq!(full.once(key(&format!("id-{KEEP_COUNT}")), "d".into(), || panic!("must not send")).unwrap(), json!(KEEP_COUNT));
    }
}
