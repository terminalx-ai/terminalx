//! Dormant admission boundary for a future owned Codex app-server transport.
//!
//! Implements the actual Host Sink, but does not spawn, attach, send or publish.
//! A session manager must share ONE registry across its owned Codex launches,
//! bind once before passing a sink to Host::spawn, and never reuse that sink
//! for another child. Replies/approvals require a separate protocol dispatcher
//! before this can become an engine. The existing PTY path never calls this.
//!
//! The gate covers replacement, stdout, exit and synchronous admission. Host
//! wait/stdout threads have no drain ordering: exit closes start admission,
//! but a buffered completion remains evidence until the binding is replaced.
//! A prior binding never calls the current admission target, even for success.
//! Historical reconciliation must use a separately authorized history path.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::harness::host::Sink;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Owner {
    pub session_id: String,
    pub tab_id: String,
    pub subagent_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Scope {
    pub owner: Owner,
    pub conversation_id: Option<String>,
    pub thread_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Observation {
    /// Admission must cover loss of the previous scope and the new binding
    /// together. In particular, switching conversation cannot orphan its state.
    Bound { replaces: Option<(Scope, u64)> },
    Released,
    ItemStarted { turn_id: String, item_id: String },
    ItemCompleted { turn_id: String, item_id: String },
    TurnError { turn_id: String, will_retry: bool },
    TurnEnded { turn_id: String, outcome: TurnOutcome },
    Exited { pid: u32, code: Option<i32> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum TurnOutcome { Completed, Failed, Interrupted }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Envelope {
    pub scope: Scope,
    /// Process-local fence, NOT a durable generation, cursor or dedupe key.
    pub launch: u64,
    pub observation: Observation,
}

/// Admission is synchronous under the ownership gate. It MUST NOT reenter
/// this registry. A future implementation must journal before returning Ok
/// and before publishing; Ok here alone supplies no durability guarantee.
/// Err latches this binding blocked: no later callback can publish through it.
/// No raw stderr, error message, summary, token count or model input is passed.
pub(crate) trait Admission: Send {
    fn accept(&mut self, envelope: Envelope) -> Result<(), ()>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status { Open, Exited, Blocked, Superseded }

struct Binding {
    scope: Scope,
    launch: u64,
    status: Status,
}

struct Gate {
    next_launch: u64,
    bindings: HashMap<Owner, Binding>,
    admission: Box<dyn Admission>,
}

pub(crate) struct OwnedTransport(Arc<Mutex<Gate>>);

pub(crate) struct BoundSink {
    gate: Arc<Mutex<Gate>>,
    owner: Owner,
    launch: u64,
}

impl OwnedTransport {
    pub fn new(admission: impl Admission + 'static) -> Self {
        Self(Arc::new(Mutex::new(Gate { next_launch: 0, bindings: HashMap::new(), admission: Box::new(admission) })))
    }

    /// Explicitly replace this owner's binding, invalidating its old callbacks
    /// before accepting any new evidence. A different owner cannot steal a
    /// thread, including after exit: release must be explicit.
    pub fn bind(&self, scope: Scope) -> Result<Arc<BoundSink>, &'static str> {
        if scope.thread_id.is_empty() || scope.owner.session_id.is_empty() || scope.owner.tab_id.is_empty() {
            return Err("missing owner or thread identity");
        }
        let mut gate = self.0.lock().map_err(|_| "admission gate poisoned")?;
        if gate.bindings.values().any(|b| b.scope.thread_id == scope.thread_id && b.scope.owner != scope.owner) {
            return Err("provider thread already owned");
        }
        let launch = gate.next_launch.checked_add(1).ok_or("launch identity exhausted")?;
        gate.next_launch = launch;
        let owner = scope.owner.clone();
        let replaces = gate.bindings.insert(owner.clone(), Binding { scope: scope.clone(), launch, status: Status::Open })
            .map(|previous| (previous.scope, previous.launch));
        let sink = Arc::new(BoundSink { gate: self.0.clone(), owner, launch });
        if gate.admission.accept(Envelope { scope, launch, observation: Observation::Bound { replaces } }).is_err() {
            gate.bindings.get_mut(&sink.owner).unwrap().status = Status::Blocked;
        }
        // Return even on admission rejection so the caller can inspect/release
        // the blocked reservation. It must check status before starting a child.
        Ok(sink)
    }
}

impl BoundSink {
    pub fn status(&self) -> Status {
        let Ok(gate) = self.gate.lock() else { return Status::Blocked };
        gate.bindings.get(&self.owner).filter(|b| b.launch == self.launch).map_or(Status::Superseded, |b| b.status)
    }

    /// For cancelled/failed launches or explicit owner teardown. An old token
    /// cannot release a replacement. Admission must record continuity loss;
    /// rejection retains blocked ownership. Does not kill or drain the child.
    pub fn release(&self) -> Result<(), &'static str> {
        let mut gate = self.gate.lock().map_err(|_| "admission gate poisoned")?;
        let Some(binding) = gate.bindings.get(&self.owner).filter(|b| b.launch == self.launch) else { return Ok(()) };
        let envelope = Envelope { scope: binding.scope.clone(), launch: self.launch, observation: Observation::Released };
        if gate.admission.accept(envelope).is_err() {
            gate.bindings.get_mut(&self.owner).unwrap().status = Status::Blocked;
            return Err("release admission rejected");
        }
        gate.bindings.remove(&self.owner);
        Ok(())
    }

    fn admit(&self, notification: impl FnOnce(&Scope) -> Option<Observation>) {
        let Ok(mut gate) = self.gate.lock() else { return };
        let Some(binding) = gate.bindings.get_mut(&self.owner).filter(|b| b.launch == self.launch) else { return };
        if binding.status == Status::Blocked { return; }
        let Some(observation) = notification(&binding.scope) else { return };
        if binding.status == Status::Exited && !matches!(observation, Observation::ItemCompleted { .. }) { return; }
        if matches!(observation, Observation::Exited { .. }) { binding.status = Status::Exited; }
        let envelope = Envelope { scope: binding.scope.clone(), launch: self.launch, observation };
        if gate.admission.accept(envelope).is_err() {
            gate.bindings.get_mut(&self.owner).unwrap().status = Status::Blocked;
        }
    }
}

impl Sink for BoundSink {
    fn stdout_line(&self, line: String) {
        // Parse only after generation admission; old-child bytes never reach
        // the replacement decoder or its admission target.
        self.admit(|scope| decode(&line, &scope.thread_id));
    }

    fn stderr_line(&self, _line: String) {
        // Diagnostics are not lifecycle evidence; never forward raw secrets.
    }

    fn exited(&self, pid: u32, code: Option<i32>) {
        self.admit(|_| Some(Observation::Exited { pid, code }));
    }
}

/// Selected notification fields from rust-v0.164.0 v2 item/turn/notification
/// schemas. This is not a full JSON-RPC dispatcher or validation of provider
/// emission semantics. Unknown/malformed input produces no positive evidence.
fn decode(line: &str, thread_id: &str) -> Option<Observation> {
    let value: Value = serde_json::from_str(line).ok()?;
    // Requests (even id:null) and responses are never lifecycle notifications.
    if value.get("id").is_some() { return None; }
    let params = value.get("params")?;
    if params.get("threadId")?.as_str()? != thread_id { return None; }
    let text = |v: &Value, key: &str| v.get(key)?.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    match value.get("method")?.as_str()? {
        method @ ("item/started" | "item/completed") => {
            let item = params.get("item")?;
            if item.get("type")?.as_str()? != "contextCompaction" { return None; }
            let turn_id = text(params, "turnId")?;
            let item_id = text(item, "id")?;
            Some(if method == "item/started" { Observation::ItemStarted { turn_id, item_id } }
                else { Observation::ItemCompleted { turn_id, item_id } })
        }
        "error" => Some(Observation::TurnError {
            turn_id: text(params, "turnId")?, will_retry: params.get("willRetry")?.as_bool()?,
        }),
        "turn/completed" => {
            let turn = params.get("turn")?;
            let outcome = match turn.get("status")?.as_str()? {
                "completed" => TurnOutcome::Completed,
                "failed" => TurnOutcome::Failed,
                "interrupted" => TurnOutcome::Interrupted,
                _ => return None,
            };
            Some(Observation::TurnEnded { turn_id: text(turn, "id")?, outcome })
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "owned_transport_tests.rs"]
mod tests;
