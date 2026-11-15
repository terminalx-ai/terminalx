//! Dormant coordinated PRO-167 contract. No production capability advertises
//! this implementation. In particular a snapshot is not a mode witness, and
//! an admission at dispatch is not a permit at the final asynchronous writer.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};

use super::{Access, Role, MAX_MEMBERS};
use crate::harness::settings::Stance;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WriteSource {
    Explicit,
    Everyone,
    Implicit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Member {
    pub user_id: String,
    pub role: Role,
    pub can_approve: bool,
    // Required even when null: omission must not become explicit drive.
    #[serde(deserialize_with = "required_source")]
    pub write_source: Option<WriteSource>,
}

fn required_source<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<WriteSource>, D::Error> {
    Option::<WriteSource>::deserialize(d)
}

impl Member {
    pub fn access(&self) -> Access {
        Access { role: self.role, can_approve: self.can_approve }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub v: u8,
    pub revision: String,
    pub members: Vec<Member>,
}

fn canonical_revision(revision: &str) -> bool {
    !revision.is_empty() && revision.bytes().all(|b| b.is_ascii_digit()) && (revision == "0" || !revision.starts_with('0'))
}

fn revision_order(a: &str, b: &str) -> std::cmp::Ordering {
    // Decimal integers, without a float/JS-number conversion or overflow.
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

impl Snapshot {
    fn validate(&mut self) -> Result<()> {
        ensure!(self.v == 2 && canonical_revision(&self.revision), "invalid collaboration version or revision");
        ensure!(self.members.len() <= MAX_MEMBERS, "too many collaboration members");
        let mut users = HashSet::new();
        for member in &self.members {
            ensure!(!member.user_id.is_empty() && users.insert(&member.user_id), "invalid or duplicate collaboration member");
            let valid = match (member.role, member.write_source) {
                (Role::None | Role::Viewer, None) => true,
                (Role::Driver, Some(_)) => true,
                (Role::Manager, Some(WriteSource::Explicit | WriteSource::Implicit)) => true,
                _ => false,
            };
            ensure!(valid, "invalid collaboration drive provenance");
        }
        self.members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
        Ok(())
    }

    fn map(&self) -> HashMap<String, Access> {
        self.members.iter().filter(|m| m.role != Role::None).map(|m| (m.user_id.clone(), m.access())).collect()
    }
}

/// Local durable queue stamp; never a new HTTP response field or an authority
/// supplied by a caller. Approval stays independent of DRIVE provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stamp {
    revision: String,
    generation: u64,
    epoch: String,
    member: Member,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Action {
    Drive,
    Approve,
    Configure,
}

/// A current owned supported engine's raw report, kept distinct from saved
/// settings and next-start intent. None, adopted/by-hand/shell or unsupported
/// engines provide no witness. Approval counts do not appear here.
#[derive(Debug, Clone)]
pub(crate) struct TabWitness {
    pub owned: bool,
    pub harness: String,
    pub stored_mode: String,
    pub pending_mode: Option<String>,
    pub actual: Option<Stance>,
}

impl TabWitness {
    pub fn allows_everyone(&self) -> bool {
        let known = |mode: &str| matches!(mode, "plan" | "manual" | "default" | "ask" | "auto" | "acceptEdits" | "accept_edits");
        if !self.owned || !known(&self.stored_mode) || self.pending_mode.as_deref().is_some_and(|mode| !known(mode)) {
            return false;
        }
        match (self.harness.as_str(), &self.actual) {
            ("claude", Some(Stance::Mode { mode })) => known(mode),
            ("codex", Some(Stance::Sandboxed { approval, sandbox })) => {
                approval == "on-request" && matches!(sandbox.as_str(), "read-only" | "workspace-write")
            }
            _ => false,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    high_water: Snapshot,
    poisoned: bool,
}

struct State {
    record: Option<Record>,
    active: Option<Snapshot>,
    seen_v2: bool,
    epoch: String,
    generation: u64,
    path: Option<PathBuf>,
    store_failed: bool,
}

pub(crate) struct RuntimePolicy(Mutex<State>);

impl Default for RuntimePolicy {
    fn default() -> Self {
        Self(Mutex::new(State {
            record: None, active: None, seen_v2: false, epoch: uuid::Uuid::new_v4().to_string(),
            generation: 0, path: None, store_failed: false,
        }))
    }
}

impl RuntimePolicy {
    /// Bind only to the existing native authenticated runtime identity. A
    /// persisted record is a revision floor, never startup authorization.
    pub fn bind(&self, dir: &Path, generation: u64) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        ensure!(state.path.is_none(), "collaboration policy already bound");
        state.generation = generation;
        let path = dir.join("collaboration-v2-policy.json");
        state.path = Some(path.clone());
        let loaded = match std::fs::read(&path) {
            Ok(bytes) => (|| -> Result<Record> {
                let mut record: Record = serde_json::from_slice(&bytes)?;
                record.high_water.validate()?;
                Ok(record)
            })().map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        };
        match loaded {
            Ok(record) => {
                state.seen_v2 = record.is_some();
                state.record = record;
                Ok(())
            }
            Err(error) => {
                state.seen_v2 = true;
                state.store_failed = true;
                Err(error.context("load collaboration revision floor"))
            }
        }
    }

    pub fn set_generation(&self, generation: u64) {
        let mut state = self.0.lock().unwrap();
        if generation != state.generation {
            state.active = None;
            state.epoch = uuid::Uuid::new_v4().to_string();
            // A delayed callback cannot retire a newer identity and later
            // make work stamped under the older generation current again.
            state.generation = state.generation.max(generation);
        }
    }

    pub fn invalidate_for_legacy(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.seen_v2 {
            state.active = None;
            state.epoch = uuid::Uuid::new_v4().to_string();
        }
        state.seen_v2
    }

    /// Caller holds Collaboration::admission across this and member-map
    /// replacement. Nothing is authorized until the revision is durable.
    #[allow(dead_code)]
    pub fn install(&self, mut snapshot: Snapshot) -> Result<HashMap<String, Access>> {
        let mut state = self.0.lock().unwrap();
        state.seen_v2 = true;
        if let Err(error) = snapshot.validate() {
            state.active = None;
            state.epoch = uuid::Uuid::new_v4().to_string();
            return Err(error);
        }
        ensure!(!state.store_failed, "collaboration policy store unavailable");
        ensure!(state.generation != 0, "collaboration runtime generation unknown");
        let Some(path) = state.path.clone() else {
            state.active = None;
            bail!("collaboration policy store not bound");
        };
        if let Some(record) = &state.record {
            let order = revision_order(&snapshot.revision, &record.high_water.revision);
            if order.is_lt() || (order.is_eq() && (snapshot != record.high_water || record.poisoned)) {
                state.active = None;
                state.record.as_mut().unwrap().poisoned = true;
                if let Err(error) = crate::cloud_bootstrap::write_durable(&path, &serde_json::to_vec(&state.record.as_ref().unwrap())?) {
                    state.store_failed = true;
                    return Err(error);
                }
                bail!("stale or conflicting collaboration revision");
            }
        }
        let record = Record { high_water: snapshot.clone(), poisoned: false };
        if let Err(error) = crate::cloud_bootstrap::write_durable(&path, &serde_json::to_vec(&record)?) {
            state.active = None;
            state.store_failed = true;
            return Err(error);
        }
        let map = snapshot.map();
        state.record = Some(record);
        state.active = Some(snapshot);
        Ok(map)
    }

    pub fn stamp(&self, actor: &str) -> Option<Stamp> {
        let state = self.0.lock().unwrap();
        let snapshot = state.active.as_ref()?;
        let member = snapshot.members.iter().find(|m| m.user_id == actor)?.clone();
        Some(Stamp { revision: snapshot.revision.clone(), generation: state.generation, epoch: state.epoch.clone(), member })
    }

    pub fn is_v2(&self) -> bool {
        self.0.lock().unwrap().seen_v2
    }

    pub fn admit(&self, actor: &str, stamp: Option<&Stamp>, action: Action, witness: Option<&TabWitness>) -> Result<()> {
        let state = self.0.lock().unwrap();
        if !state.seen_v2 {
            return Ok(());
        }
        let snapshot = state.active.as_ref().context("collaboration policy unavailable")?;
        let stamp = stamp.context("collaboration provenance stamp missing")?;
        ensure!(stamp.generation == state.generation && stamp.epoch == state.epoch && stamp.revision == snapshot.revision,
            "collaboration policy changed before input");
        let member = snapshot.members.iter().find(|m| m.user_id == actor).context("collaboration member revoked")?;
        ensure!(&stamp.member == member, "collaboration provenance changed before input");
        match action {
            Action::Approve => ensure!(member.can_approve, "approval required"),
            Action::Configure => ensure!(member.access().can_configure() && member.write_source != Some(WriteSource::Everyone), "explicit configuration authority required"),
            Action::Drive => {
                ensure!(member.access().can_drive(), "driver access required");
                if member.write_source == Some(WriteSource::Everyone) {
                    ensure!(witness.is_some_and(TabWitness::allows_everyone), "Everyone drive requires a current safe owned tab");
                }
            }
        }
        Ok(())
    }
}
