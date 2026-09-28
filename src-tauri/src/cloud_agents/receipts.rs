//! The runtime's durable half of exactly-once (contract §11.4): which
//! commands it started applying, what came of them, and the follow-ups it
//! accepted but has not sent yet.
//!
//! `receipts.jsonl` is append-only; every record is fsynced before the step
//! it guards. `incarnation` names this store to the API: a new one tells the
//! server that receipts which could prove an earlier outcome are gone.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::crypto;

/// Past this many records the log is rewritten without acknowledged ones.
const COMPACT_AFTER: usize = if cfg!(test) { 64 } else { 4096 };

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// The encrypted receipt body, kept so every ack of this command sends
    /// the same bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_iv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_ciphertext: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Record {
    Applying { id: String },
    Receipt { id: String, receipt: Receipt },
    Acked { id: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Known {
    /// Applied before: ack this again, never apply twice.
    Receipt(Receipt),
    /// Started applying and never finished: the process died mid-apply.
    Interrupted,
    New,
}

#[derive(Default)]
struct Entry {
    applying: bool,
    receipt: Option<Receipt>,
    acked: bool,
}

pub struct Receipts {
    path: PathBuf,
    incarnation: String,
    state: Mutex<(File, HashMap<String, Entry>, usize)>,
}

impl Receipts {
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("receipts.jsonl");
        let incarnation_path = dir.join("incarnation");
        let existing = fs::read_to_string(&incarnation_path).ok().map(|text| text.trim().to_string()).filter(|id| valid_incarnation(id));
        // Receipts without their incarnation (or the reverse) cannot prove
        // anything to the server: start a new store.
        let incarnation = match (existing, path.exists()) {
            (Some(id), true) => id,
            _ => {
                let id = crypto::random_id();
                let _ = fs::remove_file(&path);
                crate::cloud_bootstrap::write_durable(&incarnation_path, id.as_bytes())?;
                id
            }
        };
        let mut entries: HashMap<String, Entry> = HashMap::new();
        let mut records = 0;
        if let Ok(file) = File::open(&path) {
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else { break };
                // A torn last line (a crash mid-append) never finished its step.
                let Ok(record) = serde_json::from_str::<Record>(&line) else { continue };
                records += 1;
                match record {
                    Record::Applying { id } => entries.entry(id).or_default().applying = true,
                    Record::Receipt { id, receipt } => entries.entry(id).or_default().receipt = Some(receipt),
                    Record::Acked { id } => entries.entry(id).or_default().acked = true,
                }
            }
        }
        let mut file = append_file(&path)?;
        // Start after a torn last line, never on it.
        if fs::read(&path).is_ok_and(|bytes| bytes.last().is_some_and(|last| *last != b'\n')) {
            file.write_all(b"\n")?;
        }
        let receipts = Self { path, incarnation, state: Mutex::new((file, entries, records)) };
        if records > COMPACT_AFTER {
            receipts.compact()?;
        }
        Ok(receipts)
    }

    pub fn incarnation(&self) -> &str {
        &self.incarnation
    }

    pub fn known(&self, client_command_id: &str) -> Known {
        let state = self.state.lock().unwrap();
        match state.1.get(client_command_id) {
            Some(Entry { receipt: Some(receipt), .. }) => Known::Receipt(receipt.clone()),
            Some(Entry { applying: true, .. }) => Known::Interrupted,
            _ => Known::New,
        }
    }

    pub fn applying(&self, client_command_id: &str) -> Result<()> {
        self.append(client_command_id, Record::Applying { id: client_command_id.into() }, |entry| entry.applying = true)
    }

    pub fn record(&self, client_command_id: &str, receipt: &Receipt) -> Result<()> {
        let stored = receipt.clone();
        self.append(client_command_id, Record::Receipt { id: client_command_id.into(), receipt: receipt.clone() }, move |entry| {
            entry.receipt = Some(stored)
        })
    }

    /// The server settled it; the receipt may be compacted away later.
    pub fn acked(&self, client_command_id: &str) -> Result<()> {
        self.append(client_command_id, Record::Acked { id: client_command_id.into() }, |entry| entry.acked = true)
    }

    fn append(&self, id: &str, record: Record, apply: impl FnOnce(&mut Entry)) -> Result<()> {
        let mut line = serde_json::to_vec(&record)?;
        line.push(b'\n');
        let mut state = self.state.lock().unwrap();
        state.0.write_all(&line).and_then(|()| state.0.sync_data()).with_context(|| format!("append to {}", self.path.display()))?;
        apply(state.1.entry(id.to_string()).or_default());
        state.2 += 1;
        Ok(())
    }

    /// Rewrite the log with only what a redelivery could still ask about.
    fn compact(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        state.1.retain(|_, entry| !entry.acked);
        let mut bytes = Vec::new();
        for (id, entry) in &state.1 {
            if entry.applying {
                bytes.extend(serde_json::to_vec(&Record::Applying { id: id.clone() })?);
                bytes.push(b'\n');
            }
            if let Some(receipt) = &entry.receipt {
                bytes.extend(serde_json::to_vec(&Record::Receipt { id: id.clone(), receipt: receipt.clone() })?);
                bytes.push(b'\n');
            }
        }
        crate::cloud_bootstrap::write_durable(&self.path, &bytes)?;
        state.0 = append_file(&self.path)?;
        state.2 = state.1.len();
        Ok(())
    }
}

fn valid_incarnation(id: &str) -> bool {
    (16..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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

/// A follow-up accepted while its tab was mid-turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUp {
    pub client_command_id: String,
    pub session_id: String,
    pub text: String,
}

/// Follow-ups per tab, in order, rewritten durably on every change so an
/// accepted (`applied`) follow-up survives a runtime restart.
pub struct FollowUps {
    path: PathBuf,
    tabs: Mutex<BTreeMap<String, Vec<FollowUp>>>,
}

impl FollowUps {
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("followups.json");
        let tabs = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        Ok(Self { path, tabs: Mutex::new(tabs) })
    }

    pub fn list(&self, tab_id: &str) -> Vec<FollowUp> {
        self.tabs.lock().unwrap().get(tab_id).cloned().unwrap_or_default()
    }

    pub fn tabs(&self) -> Vec<String> {
        self.tabs.lock().unwrap().iter().filter(|(_, queue)| !queue.is_empty()).map(|(tab, _)| tab.clone()).collect()
    }

    pub fn push(&self, tab_id: &str, follow_up: FollowUp) -> Result<()> {
        self.change(|tabs| tabs.entry(tab_id.to_string()).or_default().push(follow_up))
    }

    /// Take the next follow-up of a tab, durably.
    pub fn pop(&self, tab_id: &str) -> Result<Option<FollowUp>> {
        let mut taken = None;
        self.change(|tabs| {
            if let Some(queue) = tabs.get_mut(tab_id) {
                if !queue.is_empty() {
                    taken = Some(queue.remove(0));
                }
                if queue.is_empty() {
                    tabs.remove(tab_id);
                }
            }
        })?;
        Ok(taken)
    }

    /// Drop every follow-up of a tab (a stop); returns what was dropped.
    pub fn clear(&self, tab_id: &str) -> Result<Vec<FollowUp>> {
        let mut dropped = Vec::new();
        self.change(|tabs| dropped = tabs.remove(tab_id).unwrap_or_default())?;
        Ok(dropped)
    }

    fn change(&self, f: impl FnOnce(&mut BTreeMap<String, Vec<FollowUp>>)) -> Result<()> {
        let mut tabs = self.tabs.lock().unwrap();
        let mut next = tabs.clone();
        f(&mut next);
        if next == *tabs {
            return Ok(());
        }
        crate::cloud_bootstrap::write_durable(&self.path, &serde_json::to_vec(&next)?)?;
        *tabs = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn applied() -> Receipt {
        Receipt { outcome: "applied".into(), category: None, result_iv: Some("iv".into()), result_ciphertext: Some("ct".into()) }
    }

    #[test]
    fn receipts_and_interrupted_applies_survive_a_restart_with_the_same_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Receipts::open(dir.path()).unwrap();
        let incarnation = store.incarnation().to_string();
        store.applying("a").unwrap();
        store.record("a", &applied()).unwrap();
        store.applying("b").unwrap();
        drop(store);
        let store = Receipts::open(dir.path()).unwrap();
        assert_eq!(store.incarnation(), incarnation);
        assert_eq!(store.known("a"), Known::Receipt(applied()));
        assert_eq!(store.known("b"), Known::Interrupted);
        assert_eq!(store.known("c"), Known::New);
    }

    #[test]
    fn a_torn_last_line_is_an_unfinished_step_and_a_lost_log_is_a_new_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Receipts::open(dir.path()).unwrap();
        let first = store.incarnation().to_string();
        store.applying("a").unwrap();
        drop(store);
        let mut file = OpenOptions::new().append(true).open(dir.path().join("receipts.jsonl")).unwrap();
        file.write_all(br#"{"t":"receipt","id":"a","rece"#).unwrap();
        drop(file);
        let store = Receipts::open(dir.path()).unwrap();
        assert_eq!(store.known("a"), Known::Interrupted);
        // Appending after a torn line still works.
        store.record("a", &applied()).unwrap();
        drop(store);
        assert_eq!(Receipts::open(dir.path()).unwrap().known("a"), Known::Receipt(applied()));
        fs::remove_file(dir.path().join("receipts.jsonl")).unwrap();
        let store = Receipts::open(dir.path()).unwrap();
        assert_ne!(store.incarnation(), first);
        assert_eq!(store.known("a"), Known::New);
    }

    #[test]
    fn compaction_keeps_what_a_redelivery_could_ask_about() {
        let dir = tempfile::tempdir().unwrap();
        let store = Receipts::open(dir.path()).unwrap();
        for i in 0..COMPACT_AFTER {
            let id = format!("c{i}");
            store.record(&id, &applied()).unwrap();
            store.acked(&id).unwrap();
        }
        store.applying("open").unwrap();
        store.record("unacked", &applied()).unwrap();
        drop(store);
        let store = Receipts::open(dir.path()).unwrap();
        assert_eq!(store.known("c1"), Known::New, "acked receipts are compacted away");
        assert_eq!(store.known("unacked"), Known::Receipt(applied()));
        assert_eq!(store.known("open"), Known::Interrupted);
        assert!(fs::read_to_string(dir.path().join("receipts.jsonl")).unwrap().lines().count() < 10);
    }

    #[test]
    fn follow_ups_are_ordered_per_tab_and_durable() {
        let dir = tempfile::tempdir().unwrap();
        let queue = FollowUps::open(dir.path()).unwrap();
        let item = |id: &str| FollowUp { client_command_id: id.into(), session_id: "s".into(), text: id.into() };
        queue.push("t1", item("a")).unwrap();
        queue.push("t1", item("b")).unwrap();
        queue.push("t2", item("c")).unwrap();
        drop(queue);
        let queue = FollowUps::open(dir.path()).unwrap();
        assert_eq!(queue.pop("t1").unwrap(), Some(item("a")));
        assert_eq!(queue.clear("t2").unwrap(), vec![item("c")]);
        drop(queue);
        let queue = FollowUps::open(dir.path()).unwrap();
        assert_eq!(queue.list("t1"), vec![item("b")]);
        assert_eq!(queue.tabs(), vec!["t1".to_string()]);
    }
}
