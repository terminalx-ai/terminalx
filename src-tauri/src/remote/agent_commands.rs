//! Receipts of `agent-commands/1` (PRO-343, docs/MACHINES.md decision 3).
//!
//! A runtime with no cloud mailbox takes send, steer, stop and the
//! permission decision as live calls. The caller learns what came of one
//! only from the reply, and a dropped connection loses it; the caller then
//! sends it again under the same `clientRequestId`. This journal answers the
//! repeat with the first outcome, so nothing reaches the agent twice.
//!
//! It keeps the mailbox's exactly-once rules (`cloud_agents/receipts.rs`):
//! - `applying` is fsynced before the agent is touched, the receipt after.
//! - An id with `applying` and no receipt (the runtime died in between) is
//!   answered `outcome_unknown`, except a stop, which is safe to apply again.
//! - A receipt is keyed by the connection's device and the id, and stores a
//!   digest of the method, session, tab and body: the same id with another
//!   body is refused as `conflict` with `data.reason` `id-reused`.
//! - Nothing acknowledges a receipt, so receipts are kept by age: a day, and
//!   at most [`KEEP_COUNT`], as the phone's sends are (`pairing/send_ids.rs`).
//!
//! A refusal made before `applying` (not allowed, a held lease, a malformed
//! body) touched nothing and is not kept: sending it again decides it again.
//! Only digests and outcomes are written here, never a message's text.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::protocol::{self, RpcError};

/// How long a receipt answers a repeat: a laptop that slept overnight, or a
/// runtime restarted for an update, still finds it.
pub const KEEP_MILLIS: u64 = 24 * 60 * 60 * 1000;
/// At most this many receipts are kept; the oldest go first.
pub const KEEP_COUNT: usize = if cfg!(test) { 64 } else { 4096 };

/// `data.reason` of an id that came back with another command.
pub const ID_REUSED: &str = "id-reused";
/// `data.reason` of an id whose first try was cut off mid-apply.
pub const RUNTIME_INTERRUPTED: &str = "runtime-interrupted";

/// One command: the device it came from and the id it was given.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Key {
    pub device: String,
    pub id: String,
}

/// What a command came to, as its reply carries it: an error keeps its
/// `data`, which the in-memory idempotency cache does not.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Stored {
    Result(Value),
    Error {
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
}

impl Stored {
    fn of(result: &Result<Value, RpcError>) -> Self {
        match result {
            Ok(value) => Self::Result(value.clone()),
            Err(error) => Self::Error { code: error.code.to_string(), message: error.message.clone(), data: error.data.clone() },
        }
    }

    fn reply(&self) -> Result<Value, RpcError> {
        match self {
            Self::Result(value) => Ok(value.clone()),
            Self::Error { code, message, data } => {
                let error = RpcError::new(protocol::leak_code(code), message.clone());
                Err(match data {
                    Some(data) => error.with_data(data.clone()),
                    None => error,
                })
            }
        }
    }
}

/// One line of `agent-commands.jsonl`.
#[derive(Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Record {
    Applying { key: Key, digest: String, at: u64 },
    Receipt { key: Key, digest: String, at: u64, outcome: Stored },
}

#[derive(Clone)]
struct Entry {
    digest: String,
    /// When it was first marked: its age, for keeping and for the count.
    at: u64,
    receipt: Option<Stored>,
}

/// What the journal knows of an id.
#[derive(Debug)]
pub enum Known {
    New,
    /// Applied before, with the reply it got.
    Receipt { digest: String, reply: Result<Value, RpcError> },
    /// Marked `applying` and never finished: the runtime stopped mid-apply.
    Interrupted { digest: String },
}

struct State {
    file: File,
    entries: HashMap<Key, Entry>,
    /// Lines in the file, live or not: past twice the live entries (plus
    /// slack) it is rewritten.
    records: usize,
}

pub struct Journal {
    path: PathBuf,
    state: Mutex<State>,
}

impl Journal {
    /// Open `<dir>/agent-commands.jsonl`. `now` is Unix milliseconds.
    pub fn open(dir: &Path, now: u64) -> Result<Self> {
        let path = dir.join("agent-commands.jsonl");
        let mut entries: HashMap<Key, Entry> = HashMap::new();
        let mut records = 0;
        if let Ok(file) = File::open(&path) {
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else { break };
                // A torn last line (a crash mid-append) never finished its step.
                let Ok(record) = serde_json::from_str::<Record>(&line) else { continue };
                records += 1;
                match record {
                    Record::Applying { key, digest, at } => {
                        // A stop marked again after a restart keeps its first age.
                        let entry = entries.entry(key).or_insert(Entry { digest: digest.clone(), at, receipt: None });
                        entry.digest = digest;
                    }
                    Record::Receipt { key, digest, at, outcome } => {
                        let entry = entries.entry(key).or_insert(Entry { digest: digest.clone(), at, receipt: None });
                        entry.digest = digest;
                        entry.receipt = Some(outcome);
                    }
                }
            }
        }
        let mut file = append_file(&path)?;
        // Start after a torn last line, never on it.
        if fs::read(&path).is_ok_and(|bytes| bytes.last().is_some_and(|last| *last != b'\n')) {
            file.write_all(b"\n")?;
        }
        let journal = Self { path, state: Mutex::new(State { file, entries, records }) };
        {
            let mut state = journal.state.lock().unwrap();
            prune(&mut state.entries, now);
            journal.compact_if_due(&mut state)?;
        }
        Ok(journal)
    }

    pub fn known(&self, key: &Key, now: u64) -> Known {
        let mut state = self.state.lock().unwrap();
        prune(&mut state.entries, now);
        match state.entries.get(key) {
            None => Known::New,
            Some(Entry { digest, receipt: Some(receipt), .. }) => Known::Receipt { digest: digest.clone(), reply: receipt.reply() },
            Some(Entry { digest, receipt: None, .. }) => Known::Interrupted { digest: digest.clone() },
        }
    }

    /// Fsynced before the command reaches the agent.
    pub fn applying(&self, key: &Key, digest: &str, now: u64) -> Result<()> {
        let record = Record::Applying { key: key.clone(), digest: digest.to_string(), at: now };
        self.append(&record, |entries| {
            let entry = entries.entry(key.clone()).or_insert(Entry { digest: digest.to_string(), at: now, receipt: None });
            entry.digest = digest.to_string();
        })
    }

    /// Fsynced after: from now on a repeat gets `reply`.
    pub fn record(&self, key: &Key, digest: &str, reply: &Result<Value, RpcError>, now: u64) -> Result<()> {
        let outcome = Stored::of(reply);
        let record = Record::Receipt { key: key.clone(), digest: digest.to_string(), at: now, outcome: outcome.clone() };
        self.append(&record, |entries| {
            let entry = entries.entry(key.clone()).or_insert(Entry { digest: digest.to_string(), at: now, receipt: None });
            entry.digest = digest.to_string();
            entry.receipt = Some(outcome);
        })
    }

    fn append(&self, record: &Record, apply: impl FnOnce(&mut HashMap<Key, Entry>)) -> Result<()> {
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        let mut state = self.state.lock().unwrap();
        state.file.write_all(&line).and_then(|()| state.file.sync_data()).with_context(|| format!("append to {}", self.path.display()))?;
        // Only what is on disk is known: a failed write leaves the entry as
        // it was, so a repeat is never answered from memory alone.
        apply(&mut state.entries);
        state.records += 1;
        bound(&mut state.entries);
        // The step is durable; a rewrite that fails only leaves a longer file.
        if let Err(error) = self.compact_if_due(&mut state) {
            log::warn!("compact {}: {error:#}", self.path.display());
        }
        Ok(())
    }

    fn compact_if_due(&self, state: &mut State) -> Result<()> {
        if state.records <= 2 * state.entries.len() + KEEP_COUNT {
            return Ok(());
        }
        let mut bytes = Vec::new();
        let mut kept: Vec<(&Key, &Entry)> = state.entries.iter().collect();
        kept.sort_by_key(|(_, entry)| entry.at);
        let mut records = 0;
        for (key, entry) in kept {
            let record = match &entry.receipt {
                Some(outcome) => Record::Receipt { key: key.clone(), digest: entry.digest.clone(), at: entry.at, outcome: outcome.clone() },
                None => Record::Applying { key: key.clone(), digest: entry.digest.clone(), at: entry.at },
            };
            bytes.extend(serde_json::to_vec(&record)?);
            bytes.push(b'\n');
            records += 1;
        }
        crate::cloud_bootstrap::write_durable(&self.path, &bytes)?;
        state.file = append_file(&self.path)?;
        state.records = records;
        Ok(())
    }
}

fn prune(entries: &mut HashMap<Key, Entry>, now: u64) {
    entries.retain(|_, entry| now.saturating_sub(entry.at) < KEEP_MILLIS);
    bound(entries);
}

fn bound(entries: &mut HashMap<Key, Entry>) {
    while entries.len() > KEEP_COUNT {
        let Some(oldest) = entries.iter().min_by_key(|(_, entry)| entry.at).map(|(key, _)| key.clone()) else { break };
        entries.remove(&oldest);
    }
}

fn append_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).with_context(|| format!("open {}", path.display()))
}

/// What a command is, for telling a repeat from another command under the
/// same id: its method and every parameter but the id, with object keys in
/// a fixed order.
pub fn digest(method: &str, params: &Value) -> String {
    let mut body = params.clone();
    if let Some(fields) = body.as_object_mut() {
        fields.remove("clientRequestId");
    }
    let canonical = serde_json::to_vec(&json!([method, canonical(&body)])).expect("a JSON value serializes");
    format!("{:x}", Sha256::digest(canonical))
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut sorted: Vec<(&String, &Value)> = fields.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(b.0));
            // An array of pairs keeps the order whatever map type serde uses.
            Value::Array(sorted.into_iter().map(|(name, value)| json!([name, canonical(value)])).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// The refusal of an id that came back with another command.
pub fn id_reused() -> RpcError {
    RpcError::new("conflict", "this request id was already used for a different command; send it with a new id")
        .with_data(json!({ "reason": ID_REUSED }))
}

/// The answer to an id whose first try was cut off mid-apply: it may or may
/// not have reached the agent, and it is not tried again.
pub fn outcome_unknown() -> RpcError {
    RpcError::new("outcome_unknown", "the runtime stopped while applying this command; it may or may not have reached the agent")
        .with_data(json!({ "reason": RUNTIME_INTERRUPTED }))
}

/// The reply to a command the mailbox's rules decided: `applied` is the
/// result, `rejected` an error with the receipt's category as `data.reason`.
pub fn reply(session_id: &str, tab_id: &str, outcome: &str, category: Option<&str>, extra: Value) -> Result<Value, RpcError> {
    if outcome == "applied" {
        let mut result = json!({ "sessionId": session_id, "tabId": tab_id });
        if let Value::Object(fields) = extra {
            for (name, value) in fields {
                result[name] = value;
            }
        }
        return Ok(result);
    }
    let reason = category.unwrap_or("rejected");
    let message = extra.get("message").and_then(Value::as_str).map(str::to_string);
    let (code, fallback) = match reason {
        "tab-unknown" => ("not_found", "no such tab"),
        "forbidden" => ("forbidden", "this needs driver access to the tab, or the right to approve for a decision"),
        super::collab::v2::EVERYONE_TAB_READ_ONLY => ("forbidden", "Everyone Write requires an owned tab that asks before running commands"),
        "lease-held" => ("lease_held", "someone else is driving this tab"),
        "payload-invalid" => ("invalid_params", "the command is malformed"),
        crate::cloud_agents::mailbox::ATTACHMENT_MISSING => ("invalid_params", "an image of this message did not reach the runtime"),
        "request-not-pending" => ("conflict", "this request was already answered, or it is gone"),
        crate::cloud_agents::mailbox::FOLLOW_UP_GONE => ("conflict", crate::cloud_agents::mailbox::FOLLOW_UP_GONE_MESSAGE),
        "apply-failed" => ("internal", "the agent could not take the command"),
        crate::cloud_agents::slash::NOT_QUEUED_CATEGORY => ("conflict", crate::cloud_agents::slash::NOT_QUEUED_MESSAGE),
        // The slash, shell and file-mention refusals of PRO-88, with their sentence.
        _ => ("forbidden", "this command is not allowed here"),
    };
    let mut data = json!({ "reason": reason });
    if let Value::Object(fields) = extra {
        for (name, value) in fields {
            if name != "message" {
                data[name] = value;
            }
        }
    }
    Err(RpcError::new(code, message.unwrap_or_else(|| fallback.to_string())).with_data(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str) -> Key {
        Key { device: "computer-a".into(), id: id.into() }
    }

    const NOW: u64 = 1_800_000_000_000;

    #[test]
    fn a_receipt_answers_a_repeat_across_a_restart_with_its_error_data() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path(), NOW).unwrap();
        assert!(matches!(journal.known(&key("request-0001"), NOW), Known::New));
        journal.applying(&key("request-0001"), "digest-1", NOW).unwrap();
        journal.record(&key("request-0001"), "digest-1", &Ok(json!({ "queued": true })), NOW).unwrap();
        let refused = RpcError::new("conflict", "gone").with_data(json!({ "reason": "request-not-pending", "requestId": "r1" }));
        journal.applying(&key("request-0002"), "digest-2", NOW).unwrap();
        journal.record(&key("request-0002"), "digest-2", &Err(refused.clone()), NOW).unwrap();
        drop(journal);
        let reopened = Journal::open(dir.path(), NOW + 1).unwrap();
        match reopened.known(&key("request-0001"), NOW + 1) {
            Known::Receipt { digest, reply } => assert_eq!((digest.as_str(), reply.unwrap()), ("digest-1", json!({ "queued": true }))),
            other => panic!("{other:?}"),
        }
        match reopened.known(&key("request-0002"), NOW + 1) {
            Known::Receipt { reply, .. } => assert_eq!(reply.unwrap_err(), refused),
            other => panic!("{other:?}"),
        }
        // Another device's id is its own.
        assert!(matches!(reopened.known(&Key { device: "computer-b".into(), id: "request-0001".into() }, NOW), Known::New));
    }

    #[test]
    fn an_id_marked_applying_without_a_receipt_reads_as_interrupted_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path(), NOW).unwrap();
        journal.applying(&key("request-0001"), "digest-1", NOW).unwrap();
        drop(journal);
        // A crash mid-append leaves a torn line, which never finished its step.
        let path = dir.path().join("agent-commands.jsonl");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(br#"{"t":"receipt","key":{"device":"computer-a","id":"request-0001"},"dig"#).unwrap();
        drop(file);
        let reopened = Journal::open(dir.path(), NOW).unwrap();
        assert!(matches!(reopened.known(&key("request-0001"), NOW), Known::Interrupted { digest } if digest == "digest-1"));
        // The next line starts after the torn one.
        reopened.record(&key("request-0001"), "digest-1", &Err(outcome_unknown()), NOW).unwrap();
        drop(reopened);
        let again = Journal::open(dir.path(), NOW).unwrap();
        match again.known(&key("request-0001"), NOW) {
            Known::Receipt { reply, .. } => assert_eq!(reply.unwrap_err().code, "outcome_unknown"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn receipts_are_kept_a_day_and_at_most_the_count_and_the_file_is_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path(), NOW).unwrap();
        journal.applying(&key("request-old1"), "d", NOW).unwrap();
        journal.record(&key("request-old1"), "d", &Ok(json!({})), NOW).unwrap();
        assert!(matches!(journal.known(&key("request-old1"), NOW + KEEP_MILLIS - 1), Known::Receipt { .. }));
        assert!(matches!(journal.known(&key("request-old1"), NOW + KEEP_MILLIS), Known::New));
        for index in 0..(KEEP_COUNT * 4) {
            let id = format!("request-{index:04}");
            journal.applying(&key(&id), "d", NOW + index as u64).unwrap();
            journal.record(&key(&id), "d", &Ok(json!({})), NOW + index as u64).unwrap();
        }
        let last = NOW + (KEEP_COUNT * 4) as u64;
        assert!(matches!(journal.known(&key("request-0000"), last), Known::New), "the oldest go first");
        assert!(matches!(journal.known(&key(&format!("request-{:04}", KEEP_COUNT * 4 - 1)), last), Known::Receipt { .. }));
        let lines = fs::read_to_string(dir.path().join("agent-commands.jsonl")).unwrap().lines().count();
        assert!(lines <= 3 * KEEP_COUNT + 2, "rewritten, not grown without bound: {lines} lines");
        drop(journal);
        let reopened = Journal::open(dir.path(), last).unwrap();
        assert!(matches!(reopened.known(&key(&format!("request-{:04}", KEEP_COUNT * 4 - 1)), last), Known::Receipt { .. }));
    }

    #[test]
    fn the_digest_ignores_the_request_id_and_key_order_but_nothing_else() {
        let a = digest("session.send", &json!({ "sessionId": "s", "tabId": "t", "text": "hi", "clientRequestId": "request-0001" }));
        let b = digest("session.send", &json!({ "text": "hi", "tabId": "t", "sessionId": "s", "clientRequestId": "request-9999" }));
        assert_eq!(a, b);
        assert_ne!(a, digest("session.send", &json!({ "sessionId": "s", "tabId": "t", "text": "hi!" })));
        assert_ne!(a, digest("session.steer", &json!({ "sessionId": "s", "tabId": "t", "text": "hi" })));
        assert_ne!(a, digest("session.send", &json!({ "sessionId": "s", "tabId": "t2", "text": "hi" })));
    }

    #[test]
    fn a_rejected_receipt_becomes_its_code_with_the_reason() {
        let stale = reply("s", "t", "rejected", Some("request-not-pending"), json!({ "requestId": "r1" })).unwrap_err();
        assert_eq!((stale.code, stale.data.clone().unwrap()), ("conflict", json!({ "reason": "request-not-pending", "requestId": "r1" })));
        let slash = reply("s", "t", "rejected", Some("slash-command-forbidden"), json!({ "command": "/model", "message": "Not sent: /model" })).unwrap_err();
        assert_eq!((slash.code, slash.message.as_str()), ("forbidden", "Not sent: /model"));
        assert_eq!(slash.data.unwrap(), json!({ "reason": "slash-command-forbidden", "command": "/model" }));
        assert_eq!(reply("s", "t", "applied", None, json!({ "queued": true })).unwrap(), json!({ "sessionId": "s", "tabId": "t", "queued": true }));
    }
}
