//! Encrypted transcript checkpoints (contract §12): the newest whole events
//! of each tab, projected, gzipped, encrypted under the workspace content key
//! and uploaded, so a client can read a suspended workspace without waking it.
//!
//! `(epoch, version)` lives in `checkpoints.json`: `version` grows with every
//! upload, and a lost file starts a new epoch at the current runtime
//! generation. Uploads are coalesced while a turn streams and go at once
//! when it settles; a failed upload never blocks the agent.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::api::{CallError, Checkpoint, PutOutcome};
use super::{crypto, now_ms, CloudAgents, Signal};

/// Projection JSON budget before compression.
pub const PROJECTION_BUDGET: usize = 1024 * 1024;
const COALESCE: Duration = Duration::from_secs(5);
const RETRY: Duration = Duration::from_secs(15);

#[derive(Default, Clone, Serialize, Deserialize)]
struct Cursors {
    epoch: u64,
    versions: BTreeMap<String, u64>,
}

struct Dirty {
    urgent: bool,
    not_before: Option<Instant>,
}

pub struct Checkpoints {
    path: PathBuf,
    cursors: Mutex<Cursors>,
    dirty: Mutex<HashMap<String, Dirty>>,
    last_upload: Mutex<HashMap<String, Instant>>,
    /// Removed tabs: whether their checkpoints are deleted yet, and when to
    /// try again. A removed tab never uploads again.
    removed: Mutex<HashMap<String, (bool, Option<Instant>)>>,
    signal: Signal,
}

impl Checkpoints {
    pub fn open(dir: &Path, generation: u64) -> Result<Self> {
        let path = dir.join("checkpoints.json");
        let cursors = match std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Cursors>(&bytes).ok()) {
            Some(cursors) => cursors,
            // Lost: a new epoch larger than any used before (§12).
            None => Cursors { epoch: generation, versions: BTreeMap::new() },
        };
        Ok(Self {
            path,
            cursors: Mutex::new(cursors),
            dirty: Mutex::new(HashMap::new()),
            last_upload: Mutex::new(HashMap::new()),
            removed: Mutex::new(HashMap::new()),
            signal: Signal::default(),
        })
    }

    /// The tab changed. `urgent` uploads now; otherwise at most once per
    /// coalescing window.
    pub fn mark(&self, tab_id: &str, urgent: bool) {
        // A removed tab's late events (its process exiting) upload nothing.
        if self.removed.lock().unwrap().contains_key(tab_id) {
            return;
        }
        let mut dirty = self.dirty.lock().unwrap();
        let entry = dirty.entry(tab_id.to_string()).or_insert(Dirty { urgent: false, not_before: None });
        entry.urgent |= urgent;
        drop(dirty);
        self.signal.raise();
    }

    /// The tab was removed: drop its checkpoints on the server.
    pub fn remove(&self, tab_id: &str) {
        self.removed.lock().unwrap().insert(tab_id.to_string(), (false, None));
        self.dirty.lock().unwrap().remove(tab_id);
        self.signal.raise();
    }

    /// Tabs due for an upload now.
    fn due(&self, now: Instant) -> Vec<String> {
        let last = self.last_upload.lock().unwrap();
        let mut dirty = self.dirty.lock().unwrap();
        let due: Vec<String> = dirty
            .iter()
            .filter(|(tab, entry)| {
                entry.not_before.is_none_or(|at| now >= at)
                    && (entry.urgent || last.get(*tab).is_none_or(|at| now.duration_since(*at) >= COALESCE))
            })
            .map(|(tab, _)| tab.clone())
            .collect();
        for tab in &due {
            dirty.remove(tab);
        }
        due
    }

    /// The next cursor for a tab, persisted before it is used so a version
    /// is never reused.
    fn next_cursor(&self, tab_id: &str) -> Result<(u64, u64)> {
        let mut cursors = self.cursors.lock().unwrap();
        let mut next = cursors.clone();
        let version = next.versions.get(tab_id).copied().unwrap_or(0) + 1;
        next.versions.insert(tab_id.to_string(), version);
        crate::cloud_bootstrap::write_durable(&self.path, &serde_json::to_vec(&next)?)?;
        *cursors = next;
        Ok((cursors.epoch, version))
    }

    /// The server holds a newer cursor than ours: move to a new epoch.
    fn next_epoch(&self, at_least: u64) -> Result<()> {
        let mut cursors = self.cursors.lock().unwrap();
        let next = Cursors { epoch: (cursors.epoch + 1).max(at_least), versions: BTreeMap::new() };
        crate::cloud_bootstrap::write_durable(&self.path, &serde_json::to_vec(&next)?)?;
        *cursors = next;
        Ok(())
    }
}

/// The tab's projection (schema 1): its settings and state, and the newest
/// whole committed events within `budget` bytes of JSON.
pub fn projection(agents: &CloudAgents, tab_id: &str, budget: usize) -> Result<Value> {
    let tab = agents.tab(tab_id).ok_or_else(|| anyhow!("no such tab"))?;
    let events = agents.ops.events(&tab.session_id, tab_id)?;
    Ok(project(&tab, &events, budget))
}

fn project(tab: &super::AgentTabInfo, events: &[Value], budget: usize) -> Value {
    let mut kept = Vec::new();
    let mut size = 0;
    for event in events.iter().rev() {
        let len = event.to_string().len() + 1;
        if size + len > budget {
            break;
        }
        size += len;
        kept.push(event.clone());
    }
    let truncated = kept.len() < events.len();
    kept.reverse();
    json!({
        "v": 1,
        "sessionId": tab.session_id,
        "tabId": tab.tab_id,
        "title": tab.title,
        "harness": tab.harness,
        "model": tab.model,
        "effort": tab.effort,
        "permissionMode": tab.permission_mode,
        "status": tab.status,
        "process": tab.process,
        "pendingPermissions": tab.pending_permissions,
        "followUps": tab.follow_ups,
        "lastSeq": tab.last_seq,
        "events": kept,
        "truncated": truncated,
        "updatedAt": now_ms(),
    })
}

/// Build, seal and upload one tab's checkpoint.
pub fn upload(agents: &CloudAgents, tab_id: &str) -> Result<(), CallError> {
    let transient = |error: anyhow::Error| CallError::Transient(error);
    let (Some(api), Some(identity)) = (agents.api.as_ref(), agents.identity.as_ref()) else { return Ok(()) };
    if !super::api::valid_tab_id(tab_id) {
        return Ok(());
    }
    let (key_id, key) = agents.keys.current().ok_or_else(|| transient(anyhow!("no workspace content key")))?;
    // Removed meanwhile: nothing to upload.
    let Some(tab) = agents.tab(tab_id) else { return Ok(()) };
    let events = agents.ops.events(&tab.session_id, tab_id).map_err(transient)?;
    // Halve the event budget until the compressed ciphertext fits.
    let mut budget = PROJECTION_BUDGET;
    let packed = loop {
        let projection = project(&tab, &events, budget);
        let packed = crypto::gzip(projection.to_string().as_bytes()).map_err(transient)?;
        if packed.len() + 16 <= crypto::MAX_CHECKPOINT_CIPHERTEXT || budget < 4096 {
            break packed;
        }
        budget /= 2;
    };
    for attempt in 0..2 {
        let (epoch, version) = agents.checkpoints.next_cursor(tab_id).map_err(transient)?;
        let aad = crypto::checkpoint_aad(&identity.organization_id, &identity.workspace_id, tab_id, epoch, version, crypto::CHECKPOINT_SCHEMA, &key_id);
        let iv = crypto::random_bytes::<{ crypto::IV_LEN }>();
        let ciphertext = crypto::seal_raw(&key, &iv, &packed, &aad).map_err(transient)?;
        let checkpoint = Checkpoint {
            epoch,
            version,
            schema_version: crypto::CHECKPOINT_SCHEMA,
            key_id: key_id.clone(),
            iv: crypto::b64(&iv),
            sha256: crypto::sha256_hex(&ciphertext),
            ciphertext: crypto::b64(&ciphertext),
        };
        match api.put_checkpoint(tab_id, &checkpoint)? {
            PutOutcome::Stored => return Ok(()),
            PutOutcome::Stale | PutOutcome::Conflict if attempt == 0 => {
                agents.checkpoints.next_epoch(agents.generation()).map_err(transient)?;
            }
            PutOutcome::TabLimit => {
                log::warn!("checkpoint {tab_id}: the workspace already has checkpoints for 64 tabs");
                return Ok(());
            }
            other => return Err(transient(anyhow!("checkpoint {tab_id}: {other:?}"))),
        }
    }
    Ok(())
}

pub fn run(agents: &CloudAgents) {
    loop {
        agents.checkpoints.signal.wait(Duration::from_secs(1));
        flush(agents, Instant::now());
    }
}

/// Upload every due tab and delete removed ones.
pub fn flush(agents: &CloudAgents, now: Instant) {
    let removed: Vec<String> = agents
        .checkpoints
        .removed
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, (deleted, retry))| !deleted && retry.is_none_or(|at| now >= at))
        .map(|(tab, _)| tab.clone())
        .collect();
    for tab_id in removed {
        let Some(api) = &agents.api else { break };
        let outcome = api.delete_checkpoint(&tab_id);
        let mut pending = agents.checkpoints.removed.lock().unwrap();
        match outcome {
            Ok(()) => {
                pending.insert(tab_id, (true, None));
            }
            Err(error) => {
                log::warn!("delete checkpoints of {tab_id}: {error}");
                pending.insert(tab_id, (false, Some(now + RETRY)));
            }
        }
    }
    for tab_id in agents.checkpoints.due(now) {
        match upload(agents, &tab_id) {
            Ok(()) => {
                agents.checkpoints.last_upload.lock().unwrap().insert(tab_id, now);
            }
            Err(error) => {
                log::warn!("upload checkpoint of {tab_id}: {error}");
                agents
                    .checkpoints
                    .dirty
                    .lock()
                    .unwrap()
                    .entry(tab_id)
                    .or_insert(Dirty { urgent: false, not_before: None })
                    .not_before = Some(now + RETRY);
            }
        }
    }
}
