//! Native collaboration v2 and PRO-587 per-tab enforcement. A snapshot is
//! distinct from a mode witness, and
//! an admission at dispatch is not a permit at the final asynchronous writer.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    // The coordinated source is a PostgreSQL signed BIGINT sequence. Keep
    // the comparison in decimal strings, including above JS's exact range.
    const MAX: &str = "9223372036854775807";
    !revision.is_empty() && revision.bytes().all(|b| b.is_ascii_digit())
        && (revision == "0" || !revision.starts_with('0'))
        && !revision_order(revision, MAX).is_gt()
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
            let valid = matches!((member.role, member.write_source),
                (Role::None | Role::Viewer, None)
                | (Role::Driver, Some(_))
                | (Role::Manager, Some(WriteSource::Explicit | WriteSource::Implicit)));
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
    // Local connection id, meaningful only within this stamp's local epoch.
    // Durable mailbox leases omit it; direct queued work keeps it on disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attachment: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Action {
    Drive,
    Approve,
    Configure,
}

pub(crate) const EVERYONE_TAB_READ_ONLY: &str = "everyone-tab-read-only";
pub(crate) const EVERYONE_EXPLICIT_ACCESS_REQUIRED: &str = "everyone-explicit-access-required";

#[derive(Debug, thiserror::Error)]
#[error("Everyone Write requires an owned tab that asks before running commands")]
pub(crate) struct EveryoneTabReadOnly;

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
        let asks = |mode: &str| matches!(mode, "plan" | "manual" | "default" | "ask" | "acceptEdits" | "accept_edits");
        if !self.owned || !asks(&self.stored_mode) || self.pending_mode.as_deref().is_some_and(|mode| !asks(mode)) {
            return false;
        }
        match (self.harness.as_str(), &self.actual) {
            ("claude", Some(Stance::Mode { mode })) => asks(mode),
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
    attachments: HashMap<u64, std::sync::Weak<super::super::server::Peer>>,
}

pub(crate) struct RuntimePolicy(Mutex<State>);

impl Default for RuntimePolicy {
    fn default() -> Self {
        Self(Mutex::new(State {
            record: None, active: None, seen_v2: false, epoch: uuid::Uuid::new_v4().to_string(),
            generation: 0, path: None, store_failed: false, attachments: HashMap::new(),
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

    pub fn matches_generation(&self, generation: u64) -> bool {
        generation != 0 && self.0.lock().unwrap().generation == generation
    }

    pub fn set_generation(&self, generation: u64) {
        let mut state = self.0.lock().unwrap();
        if generation > state.generation {
            state.active = None;
            state.epoch = uuid::Uuid::new_v4().to_string();
            // A delayed callback cannot retire a newer identity and later
            // make work stamped under the older generation current again.
            state.generation = generation;
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

    /// A server lease must agree with the entire installed authoritative
    /// snapshot. A role-only stamp cannot supply provenance, and a newer
    /// Everyone lease cannot inherit stale local explicit authority.
    pub fn lease_stamp(&self, revision: &str, generation: u64, member: Member) -> Result<Stamp> {
        let state = self.0.lock().unwrap();
        let snapshot = state.active.as_ref().context("collaboration policy unavailable")?;
        ensure!(canonical_revision(revision) && revision == snapshot.revision && generation == state.generation,
            "collaboration lease revision or generation mismatch");
        ensure!(snapshot.members.iter().any(|current| current == &member), "collaboration lease member or source mismatch");
        Ok(Stamp { revision: revision.into(), generation: state.generation, epoch: state.epoch.clone(), member, attachment: None })
    }

    pub fn stamp(&self, actor: &str) -> Option<Stamp> {
        let state = self.0.lock().unwrap();
        let snapshot = state.active.as_ref()?;
        let member = snapshot.members.iter().find(|m| m.user_id == actor)?.clone();
        Some(Stamp { revision: snapshot.revision.clone(), generation: state.generation, epoch: state.epoch.clone(), member, attachment: None })
    }

    /// Stamp a direct call with native connection identity too. This fence
    /// survives durable follow-up serialization, and cannot rebind to a new
    /// peer after restart or reconnect merely because its user/role matches.
    pub fn stamp_for_peer(&self, actor: &str, peer: &Arc<super::super::server::Peer>) -> Option<Stamp> {
        let mut state = self.0.lock().unwrap();
        let snapshot = state.active.as_ref()?;
        let member = snapshot.members.iter().find(|m| m.user_id == actor)?.clone();
        let stamp = Stamp { revision: snapshot.revision.clone(), generation: state.generation,
            epoch: state.epoch.clone(), member, attachment: Some(peer.id()) };
        state.attachments.retain(|_, peer| peer.strong_count() > 0);
        state.attachments.insert(peer.id(), Arc::downgrade(peer));
        Some(stamp)
    }

    /// An attachment may survive an unrelated policy revision, but never a
    /// changed member, source, runtime generation or process incarnation.
    pub fn attachment_current(&self, stamp: Option<&Stamp>) -> bool {
        let state = self.0.lock().unwrap();
        if !state.seen_v2 { return true; }
        let Some(stamp) = stamp else { return false };
        stamp.generation == state.generation && stamp.epoch == state.epoch
            && state.active.as_ref().is_some_and(|snapshot| snapshot.members.iter().any(|member| member == &stamp.member))
    }

    pub fn same_member(&self, stamp: &Stamp) -> bool {
        self.0.lock().unwrap().active.as_ref().is_some_and(|snapshot|
            snapshot.members.iter().any(|member| member == &stamp.member))
    }

    pub fn everyone(&self, actor: &str) -> bool {
        self.0.lock().unwrap().active.as_ref().is_some_and(|snapshot| snapshot.members.iter()
            .any(|member| member.user_id == actor && member.write_source == Some(WriteSource::Everyone)))
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
        if let Some(attachment) = stamp.attachment {
            ensure!(state.attachments.get(&attachment).and_then(std::sync::Weak::upgrade)
                .is_some_and(|peer| !peer.disconnected()), "collaboration attachment disconnected before input");
        }
        let member = snapshot.members.iter().find(|m| m.user_id == actor).context("collaboration member revoked")?;
        ensure!(&stamp.member == member, "collaboration provenance changed before input");
        match action {
            Action::Approve => ensure!(member.can_approve, "approval required"),
            Action::Configure => ensure!(member.access().can_configure() && member.write_source != Some(WriteSource::Everyone), "explicit configuration authority required"),
            Action::Drive => {
                ensure!(member.access().can_drive(), "driver access required");
                if member.write_source == Some(WriteSource::Everyone) && !witness.is_some_and(TabWitness::allows_everyone) {
                    return Err(EveryoneTabReadOnly.into());
                }
            }
        }
        Ok(())
    }
}

/// Authenticated native provenance carried across asynchronous handoffs. This
/// is never deserialized from RPC parameters or minted again by a queue.
#[derive(Clone)]
pub(crate) struct Permit {
    pub collaboration: Arc<super::Collaboration>,
    actor: String,
    stamp: Option<Stamp>,
    action: Action,
    // Direct RPC work belongs to its observed native attachment. Mailbox
    // leases have independent durable authority and never carry this fence.
    peer: Option<std::sync::Weak<super::super::server::Peer>>,
}

thread_local! {
    static CURRENT: std::cell::RefCell<Option<Permit>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn current() -> Option<Permit> { CURRENT.with(|current| current.borrow().clone()) }

impl Permit {
    pub fn new(collaboration: Arc<super::Collaboration>, actor: &str, stamp: Option<Stamp>, action: Action) -> Self {
        Self { collaboration, actor: actor.into(), stamp, action, peer: None }
    }

    pub fn for_peer(mut self, peer: &Arc<super::super::server::Peer>) -> Self {
        self.peer = Some(Arc::downgrade(peer));
        self
    }

    fn check_attachment(&self) -> Result<()> {
        if self.collaboration.runtime_policy.is_v2() {
            if let Some(peer) = &self.peer {
                ensure!(peer.upgrade().is_some_and(|peer| !peer.disconnected()), "collaboration attachment disconnected before input");
            }
        }
        Ok(())
    }

    pub fn check_approval(&self) -> Result<()> {
        self.check_attachment()?;
        self.collaboration.runtime_policy.admit(&self.actor, self.stamp.as_ref(), Action::Approve, None)
    }

    pub fn check_configuration(&self) -> Result<()> {
        self.check_attachment()?;
        self.collaboration.runtime_policy.admit(&self.actor, self.stamp.as_ref(), Action::Configure, None)
    }

    pub fn check(&self, witness: Option<&TabWitness>) -> Result<()> {
        self.check_attachment()?;
        self.collaboration.runtime_policy.admit(&self.actor, self.stamp.as_ref(), self.action, witness)
    }

    pub fn with<R>(&self, run: impl FnOnce() -> R) -> R {
        struct Restore(Option<Permit>);
        impl Drop for Restore {
            fn drop(&mut self) { CURRENT.with(|current| *current.borrow_mut() = self.0.take()); }
        }
        let _restore = Restore(CURRENT.with(|current| current.replace(Some(self.clone()))));
        run()
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase2_collaboration_v2_revision_matches_canonical_nonnegative_postgres_bigint() {
        for revision in ["0", "1", "9007199254740993", "9223372036854775806", "9223372036854775807"] {
            assert!(canonical_revision(revision), "{revision}");
        }
        for revision in ["", "00", "01", "-1", "+1", " 1", "1 ", "1.0", "1e3", "9223372036854775808", "9999999999999999999", "10000000000000000000"] {
            assert!(!canonical_revision(revision), "{revision}");
        }
        assert!(!canonical_revision(&"1".repeat(4096)));
    }
}
