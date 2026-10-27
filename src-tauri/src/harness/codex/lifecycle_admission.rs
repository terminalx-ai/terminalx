//! Dormant typed admission for owned_transport. No provider/Engine opts in.
//! B is a persisted owner barrier, L is local to one registry, C is the Bound
//! batch sequence. Replay produces portable reducer evidence, not another
//! operation state machine. item_started remains an observation, not proof of
//! provider work. This module never invokes handlers or releases delivery.
//!
//! B2/B3 remain: a coordinator must drain receipts ONLY after outer gates are
//! released, arrange pending-ticket wakeups, fence owner streams, and perform
//! subscribe/buffer/watermark handoff. snapshot is a local accepted prefix,
//! NOT subscription registration or a claim that another owner hasn't begun.

use std::sync::{mpsc::SyncSender, Arc, Mutex};
use anyhow::{bail, Result};
use serde::Serialize;
use super::owned_transport::{Admission, Envelope, Observation, Scope, TurnOutcome};
use crate::store::batch_journal::{Accepted, Batch, Journal, PendingBatch, Publication, Snapshot};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_UNCLAIMED: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportScope {
    session_id: String, tab_id: String, conversation_id: Option<String>,
    provider: &'static str, thread_id: String, subagent_id: Option<String>,
}
impl From<&Scope> for ExportScope {
    fn from(s: &Scope) -> Self {
        Self { session_id: s.owner.session_id.clone(), tab_id: s.owner.tab_id.clone(),
            conversation_id: s.conversation_id.clone(), provider: "codex",
            thread_id: s.thread_id.clone(), subagent_id: s.owner.subagent_id.clone() }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Signal {
    ConnectionOpened,
    ContinuityLost { reason: Loss },
    ItemStarted { #[serde(rename = "turnId")] turn_id: String, #[serde(rename = "itemId")] item_id: String },
    ItemCompleted { #[serde(rename = "turnId")] turn_id: String, #[serde(rename = "itemId")] item_id: String },
    TurnError { #[serde(rename = "turnId")] turn_id: String, #[serde(rename = "willRetry")] will_retry: bool },
    TurnEnded { #[serde(rename = "turnId")] turn_id: String, outcome: TurnOutcome },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Loss { Disconnected, Exited, Restarted }
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Evidence {
    scope: ExportScope,
    generation: u64,
    #[serde(flatten)]
    signal: Signal,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Frame {
    backend_generation: u64, watermark: u64, evidence: Vec<Evidence>,
}
#[derive(Clone)]
struct Binding { scope: Scope, launch: u64, connection: u64, exited: bool }
#[derive(Clone, Default)]
struct Projection {
    backend: u64, watermark: u64, last_launch: u64,
    bindings: Vec<Binding>, frames: Vec<Frame>,
}

impl Projection {
    fn replay(snapshot: &Snapshot<Envelope>) -> Result<Self> {
        let mut state = Self::default();
        for batch in &snapshot.batches { state.apply(batch)?; }
        if state.watermark != snapshot.watermark || state.backend != snapshot.backend_generation {
            bail!("lifecycle snapshot header mismatch");
        }
        Ok(state)
    }

    // Called on a candidate clone; failure never exposes a partial transition.
    fn apply(&mut self, batch: &Batch<Envelope>) -> Result<()> {
        if batch.version != 1 || batch.sequence > MAX_SAFE_INTEGER
            || self.watermark.checked_add(1) != Some(batch.sequence) {
            bail!("invalid or non-exportable lifecycle sequence");
        }
        let mut evidence = Vec::new();
        let mut emit = |binding: &Binding, signal| evidence.push(Evidence {
            scope: (&binding.scope).into(), generation: binding.connection, signal,
        });
        if batch.changes.is_empty() {
            if batch.backend_generation != batch.sequence { bail!("invalid lifecycle barrier"); }
            for binding in &self.bindings { emit(binding, Signal::ContinuityLost { reason: Loss::Restarted }); }
            self.bindings.clear();
            self.last_launch = 0;
            self.backend = batch.backend_generation;
        } else {
            if batch.backend_generation != self.backend || self.backend == 0 || batch.changes.len() != 1 {
                bail!("invalid typed lifecycle batch");
            }
            let e = &batch.changes[0];
            if e.launch == 0 || e.scope.thread_id.is_empty() || e.scope.owner.session_id.is_empty()
                || e.scope.owner.tab_id.is_empty() { bail!("invalid lifecycle identity"); }
            let index = self.bindings.iter().position(|b| b.scope.owner == e.scope.owner);
            if let Observation::Bound { replaces } = &e.observation {
                let actual = index.map(|i| (self.bindings[i].scope.clone(), self.bindings[i].launch));
                if &actual != replaces || e.launch <= self.last_launch
                    || self.bindings.iter().any(|b| b.scope.thread_id == e.scope.thread_id && b.scope.owner != e.scope.owner) {
                    bail!("stale lifecycle replacement");
                }
                if let Some(i) = index {
                    emit(&self.bindings.remove(i), Signal::ContinuityLost { reason: Loss::Restarted });
                }
                let binding = Binding { scope: e.scope.clone(), launch: e.launch, connection: batch.sequence, exited: false };
                emit(&binding, Signal::ConnectionOpened);
                self.bindings.push(binding);
                self.last_launch = e.launch;
            } else {
                let i = index.ok_or_else(|| anyhow::anyhow!("unbound lifecycle observation"))?;
                let b = &mut self.bindings[i];
                if b.launch != e.launch || b.scope != e.scope { bail!("stale lifecycle observation"); }
                if b.exited && !matches!(&e.observation, Observation::ItemCompleted { .. } | Observation::Released) {
                    bail!("lifecycle observation after exit");
                }
                let signal = match &e.observation {
                    Observation::Released => Signal::ContinuityLost { reason: Loss::Disconnected },
                    Observation::Exited { .. } => { b.exited = true; Signal::ContinuityLost { reason: Loss::Exited } }
                    Observation::ItemStarted { turn_id, item_id } | Observation::ItemCompleted { turn_id, item_id } => {
                        if turn_id.is_empty() || item_id.is_empty() { bail!("missing lifecycle item identity"); }
                        if matches!(&e.observation, Observation::ItemStarted { .. }) {
                            Signal::ItemStarted { turn_id: turn_id.clone(), item_id: item_id.clone() }
                        } else { Signal::ItemCompleted { turn_id: turn_id.clone(), item_id: item_id.clone() } }
                    }
                    Observation::TurnError { turn_id, will_retry } => {
                        if turn_id.is_empty() { bail!("missing lifecycle turn identity"); }
                        Signal::TurnError { turn_id: turn_id.clone(), will_retry: *will_retry }
                    }
                    Observation::TurnEnded { turn_id, outcome } => {
                        if turn_id.is_empty() { bail!("missing lifecycle turn identity"); }
                        Signal::TurnEnded { turn_id: turn_id.clone(), outcome: outcome.clone() }
                    }
                    Observation::Bound { .. } => unreachable!(),
                };
                emit(b, signal);
                if matches!(&e.observation, Observation::Released) { self.bindings.remove(i); }
            }
        }
        self.watermark = batch.sequence;
        self.frames.push(Frame { backend_generation: self.backend, watermark: self.watermark, evidence });
        Ok(())
    }
}

/// Explicitly volatile loss status; not fabricated journal evidence. Includes
/// the proposed scope even if a replacement could not be persisted.
#[derive(Clone)]
pub(crate) struct View {
    pub backend_generation: u64, pub watermark: u64, pub frames: Vec<Frame>,
    pub degraded: bool, pub affected_scopes: Vec<Scope>,
}
struct State {
    journal: Journal<Envelope>, projection: Projection,
    queue: SyncSender<PendingBatch<Envelope>>, receipts: Vec<Accepted<Envelope>>,
    degraded: bool, affected: Vec<Scope>,
}
#[derive(Clone)]
pub(crate) struct TypedAdmission(Arc<Mutex<State>>);
impl TypedAdmission {
    /// Requires an explicitly created/begun, unused owner handle. A viewer
    /// must never call begin to refresh. One adapter belongs to ONE transport
    /// registry; cloning shares state for inspection, not a second registry.
    pub fn new(mut journal: Journal<Envelope>, queue: SyncSender<PendingBatch<Envelope>>) -> Result<Self> {
        let projection = Projection::replay(&journal.snapshot()?)?;
        if projection.watermark != journal.backend_generation() { bail!("owner already admitted lifecycle records"); }
        Ok(Self(Arc::new(Mutex::new(State { journal, projection, queue, receipts: Vec::new(), degraded: false, affected: Vec::new() }))))
    }

    /// Accepted local prefix only; B3 subscriber/watermark handoff is absent.
    pub fn snapshot(&self) -> Result<View> {
        let s = self.0.lock().map_err(|_| anyhow::anyhow!("lifecycle bridge poisoned"))?;
        Ok(View { backend_generation: s.projection.backend, watermark: s.projection.watermark,
            frames: s.projection.frames.clone(), degraded: s.degraded, affected_scopes: s.affected.clone() })
    }

    /// Transfers immutable receipts, including Lost/Panicked outcomes. Does
    /// NOT release delivery. B2 caller must exit ALL outer locks before release,
    /// arrange a wakeup, and authorize the stream. No production caller exists.
    pub fn take_receipts(&self) -> Result<Vec<Accepted<Envelope>>> {
        let mut s = self.0.lock().map_err(|_| anyhow::anyhow!("lifecycle bridge poisoned"))?;
        Ok(std::mem::take(&mut s.receipts))
    }
}
impl Admission for TypedAdmission {
    fn accept(&mut self, envelope: Envelope) -> std::result::Result<(), ()> {
        let mut s = self.0.lock().map_err(|_| ())?;
        if s.degraded { return Err(()); }
        // Stage every projection check before storage. Receipt retention is
        // bounded; backpressure fails closed rather than silently losing one.
        let previous_scopes: Vec<_> = s.projection.bindings.iter().map(|b| b.scope.clone()).collect();
        let result = (|| -> Result<()> {
            if s.receipts.len() >= MAX_UNCLAIMED { bail!("unclaimed lifecycle receipts"); }
            let sequence = s.projection.watermark.checked_add(1).ok_or_else(|| anyhow::anyhow!("sequence exhausted"))?;
            let mut next = s.projection.clone();
            next.apply(&Batch { version: 1, sequence, backend_generation: s.projection.backend, changes: vec![envelope.clone()] })?;
            let queue = s.queue.clone();
            let accepted = s.journal.commit_ordered(vec![envelope.clone()], &queue)?;
            let matches = accepted.receipt().sequence == sequence && accepted.receipt().backend_generation == next.backend;
            let queued = accepted.publication() == Publication::Queued;
            // Even postcommit failure retains the immutable receipt: Err here
            // blocks transport; it never means permission to retry provider work.
            s.receipts.push(accepted);
            if !matches { bail!("accepted lifecycle prefix changed"); }
            s.projection = next;
            if !queued { bail!("persisted lifecycle publication unavailable"); }
            Ok(())
        })();
        if result.is_err() {
            s.degraded = true;
            s.affected = previous_scopes;
            let current_scopes: Vec<_> = s.projection.bindings.iter().map(|b| b.scope.clone()).collect();
            for scope in current_scopes {
                if !s.affected.contains(&scope) { s.affected.push(scope); }
            }
            if !s.affected.contains(&envelope.scope) { s.affected.push(envelope.scope); }
            return Err(());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "lifecycle_admission_tests.rs"]
mod tests;

// Dormant coordinator; no Engine, provider or UI constructs it.
#[path = "lifecycle_coordinator.rs"]
pub(crate) mod coordinator;
