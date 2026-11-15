//! Isolated PRO-220 foundation; deliberately not registered in the application.
//!
//! This module neither executes commands nor establishes physical-human consent. Future lead
//! integration must supply authenticated origin/current approval context and monotonic time,
//! and implement the native person-only boundary, revocation fencing and execution checks.
//! Runtime-supplied identity/roles are never a trusted context source. ReadyForLeadIntegration
//! is an observation of this model only, NOT an execution capability or durable authorization.
//! Keep one Policy for the integration lifetime: its bounded replay tombstones are not persisted
//! across fresh instances/restarts. A restart must obtain a new trusted runtime generation.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

pub const MAX_REQUESTS: usize = 256;
pub const MAX_REQUEST_BYTES: usize = 32_768;
pub const MAX_ARGUMENTS: usize = 128;
pub const MAX_TTL_MS: u64 = 60_000;
/// Conservative isolated-model bound, not the product timeout/executor contract.
pub const MAX_TIMEOUT_MS: u64 = 30_000;
pub const MAX_OUTPUT_BYTES: u64 = 1_048_576;

#[derive(Clone, PartialEq, Eq)]
pub struct Origin {
    pub mac: String,
    pub account: String,
    pub organization: String,
    pub workspace: String,
    pub tab: String,
    pub turn: String,
}

impl Origin {
    fn valid(&self) -> bool {
        [&self.mac, &self.account, &self.organization, &self.workspace, &self.tab, &self.turn]
            .iter().all(|value| identifier(value))
    }
}

/// Supplied ONLY by future trusted desktop integration, never decoded from a runtime request.
/// `origin` describes the CURRENT active account/org/workspace/tab/live turn, with its Mac
/// captured by trusted turn-start attribution; `local_mac` is this desktop's trusted identity.
/// None represents missing/unknown state and denies. Revision includes membership/approval
/// rights and attribution changes, including changes away and back between observations.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct TrustedContext {
    pub enabled: Option<bool>,
    pub local_mac: Option<String>,
    pub origin: Option<Origin>,
    pub generation: Option<u64>,
    pub approval_revision: Option<u64>,
    pub can_approve: Option<bool>,
    pub turn_active: Option<bool>,
}

/// Untrusted proposal. Strings are exact bytes; no shell parsing, path resolution or environment
/// inheritance is defined here. Bounds are policy limits, not an execution/sandbox contract.
#[derive(Clone)]
pub struct RequestInput {
    pub id: String,
    pub origin: Origin,
    pub generation: u64,
    pub approval_revision: u64,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub executable: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub timeout_ms: u64,
    pub output_limit_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    InvalidRequest,
    ContextUnavailable,
    ContextMismatch,
    Expired,
    ClockReversed,
    Replay,
    Capacity,
    Busy,
    InvalidTransition,
    DecisionMismatch,
    Poisoned,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Approved,
    ReadyForLeadIntegration,
    Denied,
    Expired,
    Cancelled,
    Revoked,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum LocalDecision {
    #[default]
    Deny,
    AllowOnce,
}

struct Entry {
    input: Arc<RequestInput>,
    state: State,
}

struct Registry {
    context: TrustedContext,
    last_now_ms: u64,
    entries: HashMap<String, Entry>,
}

/// Clones share the SAME registry, context and single-use gates. No machine can be constructed
/// from a copied request. No reset/removal API exists; full capacity denies further admissions.
#[derive(Clone)]
pub struct Policy {
    shared: Arc<Mutex<Registry>>,
}

impl Default for Policy {
    fn default() -> Self {
        Self { shared: Arc::new(Mutex::new(Registry {
            context: TrustedContext::default(), last_now_ms: 0, entries: HashMap::new(),
        })) }
    }
}

/// An immutable request handle; clones share state, never independently copy a machine.
/// Deliberately no Debug/serialization of potentially sensitive command or identity values.
#[derive(Clone)]
pub struct Request {
    policy: Policy,
    input: Arc<RequestInput>,
}

/// Opaque exact-request binding, not proof of consent. Only trusted future native integration
/// may use this API to record a local decision. It must not expose it as a remote/webview RPC.
pub struct LocalDecisionBinding {
    input: Arc<RequestInput>,
}

impl Policy {
    fn lock(&self) -> Result<MutexGuard<'_, Registry>, Rejection> {
        self.shared.lock().map_err(|_| Rejection::Poisoned)
    }

    /// Context changes revoke every live/ready request atomically with respect to transitions.
    /// Restoring the previous context does not restore any request. Revocation that occurs
    /// after a Ready observation still needs a future executor's coordinated fence.
    pub fn update_trusted_context(&self, context: TrustedContext, now_ms: u64) -> Result<(), Rejection> {
        let mut registry = self.lock()?;
        advance_clock(&mut registry, now_ms)?;
        if registry.context != context {
            for entry in registry.entries.values_mut() {
                if matches!(entry.state, State::Pending | State::Approved | State::ReadyForLeadIntegration) {
                    entry.state = State::Revoked;
                }
            }
            registry.context = context;
        }
        Ok(())
    }

    pub fn submit(&self, input: RequestInput, now_ms: u64) -> Result<Request, Rejection> {
        let mut registry = self.lock()?;
        advance_clock(&mut registry, now_ms)?;
        validate_input(&input)?;
        // IDs remain occupied even after terminal states. Changed content cannot reuse an ID.
        if registry.entries.contains_key(&input.id) { return Err(Rejection::Replay); }
        if registry.entries.len() >= MAX_REQUESTS { return Err(Rejection::Capacity); }
        check_context(&registry.context, &input, now_ms)?;
        for entry in registry.entries.values_mut() {
            if live(entry.state) && now_ms >= entry.input.expires_at_ms {
                entry.state = State::Expired;
            }
        }
        // One command at a time, including a consumed ready observation until cancellation,
        // expiry or context revocation. There is deliberately no executor completion API.
        if registry.entries.values().any(|entry| live(entry.state)) {
            return Err(Rejection::Busy);
        }
        let input = Arc::new(input);
        registry.entries.insert(input.id.clone(), Entry { input: input.clone(), state: State::Pending });
        Ok(Request { policy: self.clone(), input })
    }
}

impl Request {
    /// Read-only exact immutable values for presentation; callers cannot replace this snapshot.
    pub fn input(&self) -> &RequestInput { &self.input }

    fn checked<'a>(&self, registry: &'a mut Registry, now_ms: u64) -> Result<&'a mut Entry, Rejection> {
        advance_clock(registry, now_ms)?;
        let check = check_context(&registry.context, &self.input, now_ms);
        let entry = registry.entries.get_mut(&self.input.id).ok_or(Rejection::InvalidTransition)?;
        if !Arc::ptr_eq(&entry.input, &self.input) { return Err(Rejection::DecisionMismatch); }
        if let Err(reason) = check {
            if matches!(entry.state, State::Pending | State::Approved | State::ReadyForLeadIntegration) {
                entry.state = if reason == Rejection::Expired { State::Expired } else { State::Revoked };
            }
            return Err(reason);
        }
        Ok(entry)
    }

    pub fn state(&self, now_ms: u64) -> Result<State, Rejection> {
        let mut registry = self.policy.lock()?;
        Ok(self.checked(&mut registry, now_ms)?.state)
    }

    pub fn prepare_local_decision(&self, now_ms: u64) -> Result<LocalDecisionBinding, Rejection> {
        let mut registry = self.policy.lock()?;
        let entry = self.checked(&mut registry, now_ms)?;
        if entry.state != State::Pending { return Err(Rejection::InvalidTransition); }
        Ok(LocalDecisionBinding { input: self.input.clone() })
    }

    pub fn record_local_decision(&self, binding: LocalDecisionBinding, decision: LocalDecision, now_ms: u64)
        -> Result<State, Rejection>
    {
        let mut registry = self.policy.lock()?;
        let entry = self.checked(&mut registry, now_ms)?;
        if !Arc::ptr_eq(&binding.input, &self.input) {
            entry.state = State::Denied;
            return Err(Rejection::DecisionMismatch);
        }
        if entry.state != State::Pending { return Err(Rejection::InvalidTransition); }
        entry.state = match decision { LocalDecision::Deny => State::Denied, LocalDecision::AllowOnce => State::Approved };
        Ok(entry.state)
    }

    /// One successful observation across ALL cloned handles. This does not spawn, issue an
    /// execution token, assert a person clicked, or authorize any future integration action.
    pub fn take_ready_for_lead_integration(&self, now_ms: u64) -> Result<State, Rejection> {
        let mut registry = self.policy.lock()?;
        let entry = self.checked(&mut registry, now_ms)?;
        if entry.state != State::Approved { return Err(Rejection::InvalidTransition); }
        entry.state = State::ReadyForLeadIntegration;
        Ok(entry.state)
    }

    /// Closing a prompt/cancel is terminal even before a decision. It also fences a ready
    /// observation in this model; stopping real processes is outside this isolated module.
    pub fn cancel(&self, now_ms: u64) -> Result<State, Rejection> {
        let mut registry = self.policy.lock()?;
        let entry = self.checked(&mut registry, now_ms)?;
        if !matches!(entry.state, State::Pending | State::Approved | State::ReadyForLeadIntegration) {
            return Err(Rejection::InvalidTransition);
        }
        entry.state = State::Cancelled;
        Ok(entry.state)
    }
}

fn advance_clock(registry: &mut Registry, now_ms: u64) -> Result<(), Rejection> {
    if now_ms < registry.last_now_ms {
        // Even a subsequent corrected time cannot resurrect an outstanding approval.
        for entry in registry.entries.values_mut() { entry.state = State::Revoked; }
        registry.context = TrustedContext::default();
        return Err(Rejection::ClockReversed);
    }
    registry.last_now_ms = now_ms;
    Ok(())
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn live(state: State) -> bool {
    matches!(state, State::Pending | State::Approved | State::ReadyForLeadIntegration)
}

fn text(value: &str, max: usize, empty: bool) -> bool {
    (empty || !value.is_empty()) && value.len() <= max && !value.contains('\0')
}

fn validate_input(input: &RequestInput) -> Result<(), Rejection> {
    let mut strings = std::iter::once(input.executable.as_str()).chain(std::iter::once(input.cwd.as_str()))
        .chain(input.arguments.iter().map(String::as_str));
    let bytes = strings.try_fold(0_usize, |sum, value| sum.checked_add(value.len()));
    let lifetime = input.expires_at_ms.checked_sub(input.issued_at_ms);
    if !identifier(&input.id) || !input.origin.valid() || input.generation == 0 || input.approval_revision == 0
        || !text(&input.executable, 4096, false) || !text(&input.cwd, 4096, false)
        || input.arguments.len() > MAX_ARGUMENTS || input.arguments.iter().any(|arg| !text(arg, 8192, true))
        || bytes.map_or(true, |bytes| bytes > MAX_REQUEST_BYTES)
        || !matches!(lifetime, Some(1..=MAX_TTL_MS))
        || !(1..=MAX_TIMEOUT_MS).contains(&input.timeout_ms)
        || !(1..=MAX_OUTPUT_BYTES).contains(&input.output_limit_bytes)
    { return Err(Rejection::InvalidRequest); }
    Ok(())
}

fn check_context(context: &TrustedContext, input: &RequestInput, now_ms: u64) -> Result<(), Rejection> {
    let origin = context.origin.as_ref().ok_or(Rejection::ContextUnavailable)?;
    let local_mac = context.local_mac.as_ref().ok_or(Rejection::ContextUnavailable)?;
    if context.enabled != Some(true) || context.can_approve != Some(true) || context.turn_active != Some(true)
        || !origin.valid() || !identifier(local_mac)
        || context.generation.filter(|n| *n > 0).is_none()
        || context.approval_revision.filter(|n| *n > 0).is_none()
    { return Err(Rejection::ContextUnavailable); }
    if local_mac != &origin.mac || origin != &input.origin
        || context.generation != Some(input.generation)
        || context.approval_revision != Some(input.approval_revision)
    { return Err(Rejection::ContextMismatch); }
    if now_ms < input.issued_at_ms || now_ms >= input.expires_at_ms { return Err(Rejection::Expired); }
    Ok(())
}

// Preserve standalone std-only rustc --test support; no application/module registration.
#[cfg(test)]
#[path = "host_command_policy_tests.rs"]
mod tests;
