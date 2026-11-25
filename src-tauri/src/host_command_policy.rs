//! Dormant PRO-220 policy and executor. The native owner must authenticate turn-start attribution
//! and publish authority changes synchronously through this policy. Only the trusted local
//! AppKit prompt may approve a command. This module exposes no transport boundary.

#[path = "host_command_executor.rs"]
mod executor;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Instant;

pub const MAX_REQUESTS: usize = 256;
pub const MAX_REQUEST_BYTES: usize = 32_768;
pub const MAX_ARGUMENTS: usize = 128;
pub const MAX_TTL_MS: u64 = 60_000;
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
        [
            &self.mac,
            &self.account,
            &self.organization,
            &self.workspace,
            &self.tab,
            &self.turn,
        ]
        .iter()
        .all(|value| identifier(value))
    }
}

/// Native-only authority. Origin must come from authenticated turn-start attribution for the
/// current live turn and account. Generation and revision must advance across reconnects and
/// authority changes. cwd_root is an explicit local workspace mapping. Unknown state denies.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct TrustedContext {
    pub enabled: Option<bool>,
    pub local_mac: Option<String>,
    pub local_account: Option<String>,
    pub origin: Option<Origin>,
    pub generation: Option<u64>,
    pub approval_revision: Option<u64>,
    pub can_approve: Option<bool>,
    pub turn_active: Option<bool>,
    pub cwd_root: Option<String>,
}

/// Proposal identity is checked against native authority. Stamp times in the desktop's
/// Policy::now_ms clock domain at receipt. The approved executable, argv and cwd are exact.
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
    Replay,
    Capacity,
    Busy,
    InvalidTransition,
    DecisionMismatch,
    InvalidDirectory,
    ExecutableUnavailable,
    #[cfg(not(target_os = "macos"))]
    UnsupportedPlatform,
    WorkerUnavailable,
    Poisoned,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Approved,
    Starting,
    Running,
    Denied,
    Expired,
    Cancelled,
    Revoked,
    TimedOut,
    OutputLimitExceeded,
    SpawnFailed,
    Failed,
    Completed,
}

impl State {
    fn queued(self) -> bool {
        matches!(self, Self::Pending | Self::Approved | Self::Starting)
    }

    fn live(self) -> bool {
        self.queued() || self == Self::Running
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum LocalDecision {
    #[default]
    Deny,
    AllowOnce,
}

/// Raw, bounded output goes only to the trusted caller. No Debug or serialization.
pub enum ExecutionOutcome {
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    /// The OS accepted the sandboxed launch, but output could not be handed off.
    /// A status is available only when the worker observed the process exit.
    LaunchedWithOutputWithheld {
        code: Option<i32>,
        signal: Option<i32>,
        reason: State,
    },
    /// Execution was refused or expired before a sandboxed launch was admitted.
    Stopped(State),
}

struct Entry {
    expires_at_ms: u64,
    state: State,
    paths: Option<executor::ApprovedPaths>,
}

impl Entry {
    fn stop(&mut self, state: State) {
        self.state = state;
        self.paths = None;
    }
}

struct Registry {
    context: TrustedContext,
    epoch: Arc<()>,
    entries: HashMap<String, Entry>,
    in_flight: bool,
}

/// Clones share authority, replay tombstones and the single execution slot. The slot stays
/// occupied through process cleanup. On restart the trusted owner must use a new generation.
#[derive(Clone)]
pub struct Policy {
    shared: Arc<Mutex<Registry>>,
    started_at: Instant,
    #[cfg(test)]
    test_clock: Option<Arc<std::sync::atomic::AtomicU64>>,
    #[cfg(all(test, target_os = "macos"))]
    test_before_spawn: Option<Arc<dyn Fn() + Send + Sync>>,
    #[cfg(all(test, target_os = "macos"))]
    test_group_events: Option<Arc<Mutex<Vec<executor::GroupEvent>>>>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Registry {
                context: TrustedContext::default(),
                epoch: Arc::new(()),
                entries: HashMap::new(),
                in_flight: false,
            })),
            started_at: Instant::now(),
            #[cfg(test)]
            test_clock: None,
            #[cfg(all(test, target_os = "macos"))]
            test_before_spawn: None,
            #[cfg(all(test, target_os = "macos"))]
            test_group_events: None,
        }
    }
}

/// Immutable request snapshot. Only this Policy can construct a handle for an admitted ID.
#[derive(Clone)]
pub struct Request {
    policy: Policy,
    input: Arc<RequestInput>,
    epoch: Arc<()>,
}

/// One exact prompt binding. The trusted native prompt displays input() and consumes the binding
/// on a human decision. Closing a prompt should call cancel. Keep this out of automation/RPC.
struct LocalDecisionBinding {
    input: Arc<RequestInput>,
    paths: executor::ApprovedPaths,
}

#[cfg(test)]
impl LocalDecisionBinding {
    fn input(&self) -> &RequestInput {
        &self.input
    }
}

pub struct Execution {
    request: Request,
    receiver: mpsc::Receiver<ExecutionOutcome>,
}

impl Policy {
    fn lock(&self) -> Result<MutexGuard<'_, Registry>, Rejection> {
        self.shared.lock().map_err(|_| Rejection::Poisoned)
    }

    pub fn now_ms(&self) -> u64 {
        #[cfg(test)]
        if let Some(clock) = &self.test_clock {
            return clock.load(std::sync::atomic::Ordering::Relaxed);
        }
        self.started_at.elapsed().as_millis() as u64
    }

    /// Call on every native authority change, including disconnect, sign-out, disable and turn
    /// end. This update and the actual OS spawn have the same serialization point.
    pub fn update_trusted_context(&self, context: TrustedContext) -> Result<(), Rejection> {
        let mut registry = self.lock()?;
        if registry.context != context {
            for entry in registry
                .entries
                .values_mut()
                .filter(|entry| entry.state.live())
            {
                entry.stop(State::Revoked);
            }
            registry.context = context;
            registry.epoch = Arc::new(());
        }
        Ok(())
    }

    pub fn submit(&self, input: RequestInput) -> Result<Request, Rejection> {
        let mut registry = self.lock()?;
        let now = self.now_ms();
        validate_input(&input)?;
        if registry.entries.contains_key(&input.id) {
            return Err(Rejection::Replay);
        }
        if registry.entries.len() >= MAX_REQUESTS {
            return Err(Rejection::Capacity);
        }
        check_context(&registry.context, &input)?;
        check_fresh(&input, now)?;
        for entry in registry.entries.values_mut() {
            if entry.state.queued() && now >= entry.expires_at_ms {
                entry.stop(State::Expired);
            }
        }
        if registry.in_flight || registry.entries.values().any(|entry| entry.state.live()) {
            return Err(Rejection::Busy);
        }
        let input = Arc::new(input);
        registry.entries.insert(
            input.id.clone(),
            Entry {
                expires_at_ms: input.expires_at_ms,
                state: State::Pending,
                paths: None,
            },
        );
        Ok(Request {
            policy: self.clone(),
            input,
            epoch: registry.epoch.clone(),
        })
    }

    /// Present the exact request in an AppKit modal on the main thread.
    #[cfg(all(target_os = "macos", feature = "desktop"))]
    #[allow(dead_code, reason = "The native executor is dormant")]
    pub fn prompt_once(&self, request: &Request) -> Result<State, Rejection> {
        consent::prompt(self, request)
    }

    fn prepare_local_decision(&self, request: &Request) -> Result<LocalDecisionBinding, Rejection> {
        self.require_owner(request)?;
        request.require_pending()?;
        approved_program(&request.input)?;
        prompt_text(&request.input)?;
        let paths = executor::ApprovedPaths::open(&request.input)?;
        request.require_pending()?;
        Ok(LocalDecisionBinding {
            input: request.input.clone(),
            paths,
        })
    }

    fn record_local_decision(
        &self,
        request: &Request,
        approval: consent::Decision,
    ) -> Result<State, Rejection> {
        let (binding, decision) = approval.into_parts();
        self.require_owner(request)?;
        let mut registry = self.lock()?;
        let entry = request.checked(&mut registry, State::Pending)?;
        if !Arc::ptr_eq(&binding.input, &request.input) {
            entry.stop(State::Denied);
            return Err(Rejection::DecisionMismatch);
        }
        match decision {
            LocalDecision::Deny => entry.stop(State::Denied),
            LocalDecision::AllowOnce => {
                entry.paths = Some(binding.paths);
                entry.state = State::Approved;
            }
        }
        Ok(entry.state)
    }

    fn require_owner(&self, request: &Request) -> Result<(), Rejection> {
        if !Arc::ptr_eq(&self.shared, &request.policy.shared) {
            return Err(Rejection::DecisionMismatch);
        }
        Ok(())
    }

    /// Reserve the single-use approval and start a local worker. The worker rechecks authority
    /// and expiry again under the registry lock immediately before the OS spawn.
    pub fn start(&self, request: &Request) -> Result<Execution, Rejection> {
        self.require_owner(request)?;
        let mut registry = self.lock()?;
        let entry = request.checked(&mut registry, State::Approved)?;
        let paths = entry.paths.take().ok_or(Rejection::InvalidTransition)?;
        entry.state = State::Starting;
        registry.in_flight = true;
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = request.clone();
        let result = thread::Builder::new()
            .name("host-command".into())
            .spawn(move || {
                let slot = ExecutionSlot(&worker);
                executor::run(&worker, paths, sender, slot);
            });
        if result.is_err() {
            registry.in_flight = false;
            request.entry(&mut registry).stop(State::Failed);
            return Err(Rejection::WorkerUnavailable);
        }
        Ok(Execution {
            request: request.clone(),
            receiver,
        })
    }
}

impl Request {
    pub fn input(&self) -> &RequestInput {
        &self.input
    }

    fn entry<'a>(&self, registry: &'a mut Registry) -> &'a mut Entry {
        // Only submit constructs handles and tombstones are retained for this policy's lifetime.
        registry
            .entries
            .get_mut(&self.input.id)
            .expect("admitted request")
    }

    fn checked<'a>(
        &self,
        registry: &'a mut Registry,
        expected: State,
    ) -> Result<&'a mut Entry, Rejection> {
        let now = self.policy.now_ms();
        let authority = check_context(&registry.context, &self.input);
        let same_epoch = Arc::ptr_eq(&self.epoch, &registry.epoch);
        let entry = self.entry(registry);
        if entry.state == State::Expired {
            return Err(Rejection::Expired);
        }
        if entry.state != expected {
            return Err(Rejection::InvalidTransition);
        }
        if let Err(reason) = authority.and(if same_epoch {
            Ok(())
        } else {
            Err(Rejection::ContextMismatch)
        }) {
            entry.stop(State::Revoked);
            return Err(reason);
        }
        if let Err(reason) = check_fresh(&self.input, now) {
            entry.stop(State::Expired);
            return Err(reason);
        }
        Ok(entry)
    }

    fn require_pending(&self) -> Result<(), Rejection> {
        let mut registry = self.policy.lock()?;
        self.checked(&mut registry, State::Pending)?;
        Ok(())
    }

    pub fn state(&self) -> Result<State, Rejection> {
        let mut registry = self.policy.lock()?;
        let entry = self.entry(&mut registry);
        if entry.state.live() && self.policy.now_ms() >= entry.expires_at_ms {
            entry.stop(State::Expired);
        }
        Ok(entry.state)
    }

    pub fn cancel(&self) -> Result<State, Rejection> {
        let mut registry = self.policy.lock()?;
        let entry = self.entry(&mut registry);
        if !entry.state.live() {
            return Err(Rejection::InvalidTransition);
        }
        if self.policy.now_ms() >= entry.expires_at_ms {
            entry.stop(State::Expired);
            return Err(Rejection::Expired);
        }
        entry.stop(State::Cancelled);
        Ok(State::Cancelled)
    }

    fn finish(&self, state: State) -> State {
        let Ok(mut registry) = self.policy.lock() else {
            return State::Revoked;
        };
        let entry = self.entry(&mut registry);
        if entry.state.live() {
            let state = if self.policy.now_ms() >= entry.expires_at_ms {
                State::Expired
            } else {
                state
            };
            entry.stop(state);
        }
        entry.state
    }
}

struct ExecutionSlot<'a>(&'a Request);

impl Drop for ExecutionSlot<'_> {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.0.policy.lock() {
            let entry = self.0.entry(&mut registry);
            if entry.state.live() {
                entry.stop(State::Failed);
            }
            registry.in_flight = false;
        }
    }
}

impl Execution {
    /// Intended for a trusted worker thread. Recheck authority on output handoff, including
    /// an away-and-back change after the process finished. A future transport must fence its
    /// own delivery. Dropping an uncollected execution cancels it.
    pub fn wait(self) -> Result<ExecutionOutcome, Rejection> {
        let outcome = self
            .receiver
            .recv()
            .map_err(|_| Rejection::WorkerUnavailable)?;
        if let ExecutionOutcome::Exited { code, signal, .. } = &outcome {
            let registry = self.request.policy.lock()?;
            let reason = if !Arc::ptr_eq(&registry.epoch, &self.request.epoch)
                || check_context(&registry.context, &self.request.input).is_err()
            {
                Some(State::Revoked)
            } else if check_fresh(&self.request.input, self.request.policy.now_ms()).is_err() {
                Some(State::Expired)
            } else {
                None
            };
            if let Some(reason) = reason {
                return Ok(ExecutionOutcome::LaunchedWithOutputWithheld {
                    code: *code,
                    signal: *signal,
                    reason,
                });
            }
        }
        Ok(outcome)
    }
}

impl Drop for Execution {
    fn drop(&mut self) {
        let _ = self.request.cancel();
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn clean_absolute(value: &str) -> bool {
    value == "/"
        || value.strip_prefix('/').is_some_and(|rest| {
            rest.split('/').all(|part| !matches!(part, "" | "." | "..")) && !rest.contains('\0')
        })
}

/// Resolve only exact spellings to fixed system images. In particular the caller
/// cannot supply a PATH lookup, shell, file operand, or an option-bearing format.
fn approved_program(input: &RequestInput) -> Result<&'static str, Rejection> {
    let arguments = input.arguments.as_slice();
    match (input.executable.as_str(), arguments) {
        ("/usr/bin/printf", [format, values @ ..])
            if format == "%s" && (1..=4).contains(&values.len()) =>
        {
            Ok("/usr/bin/printf")
        }
        ("/bin/sleep", [seconds])
            if !seconds.is_empty()
                && seconds.bytes().all(|byte| byte.is_ascii_digit())
                && seconds
                    .parse::<u64>()
                    .is_ok_and(|n| n <= MAX_TIMEOUT_MS / 1000) =>
        {
            Ok("/bin/sleep")
        }
        ("/usr/bin/true", []) => Ok("/usr/bin/true"),
        ("/usr/bin/false", []) => Ok("/usr/bin/false"),
        _ => Err(Rejection::ExecutableUnavailable),
    }
}

fn prompt_text(input: &RequestInput) -> Result<String, Rejection> {
    fn quoted(value: &str) -> String {
        format!(
            "\"{}\"",
            value
                .chars()
                .flat_map(char::escape_default)
                .collect::<String>()
        )
    }
    let mut text = format!(
        "Account: {}\nOrganization: {}\nWorkspace: {}\nProgram: {}\nWorking directory: {}\nTimeout: {} ms\nOutput limit: {} bytes",
        quoted(&input.origin.account),
        quoted(&input.origin.organization),
        quoted(&input.origin.workspace),
        quoted(&input.executable),
        quoted(&input.cwd),
        input.timeout_ms,
        input.output_limit_bytes,
    );
    for (index, arg) in input.arguments.iter().enumerate() {
        use std::fmt::Write;
        write!(text, "\nArgument {}: {}", index + 1, quoted(arg))
            .expect("writing to a String cannot fail");
    }
    if text.len() > 1_024 {
        return Err(Rejection::InvalidRequest);
    }
    Ok(text)
}

mod consent {
    use super::*;

    // The fields and constructors live in this module. The production path can
    // construct a decision only after the native AppKit modal returns.
    pub(super) struct Decision {
        binding: LocalDecisionBinding,
        choice: LocalDecision,
    }

    impl Decision {
        pub(super) fn into_parts(self) -> (LocalDecisionBinding, LocalDecision) {
            (self.binding, self.choice)
        }

        #[cfg(test)]
        pub(super) fn fixture(binding: LocalDecisionBinding, choice: LocalDecision) -> Self {
            Self { binding, choice }
        }
    }

    #[cfg(all(target_os = "macos", feature = "desktop"))]
    pub(super) fn prompt(policy: &Policy, request: &Request) -> Result<State, Rejection> {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSAlert, NSAlertSecondButtonReturn, NSAlertStyle};
        use objc2_foundation::NSString;

        let main = MainThreadMarker::new().ok_or(Rejection::ContextUnavailable)?;
        let binding = policy.prepare_local_decision(request)?;
        let text = prompt_text(&binding.input)?;
        let alert = NSAlert::new(main);
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.setMessageText(&NSString::from_str("Run this command on your Mac?"));
        alert.setInformativeText(&NSString::from_str(&text));
        alert.addButtonWithTitle(&NSString::from_str("Cancel"));
        alert.addButtonWithTitle(&NSString::from_str("Run Once"));
        let choice = if alert.runModal() == NSAlertSecondButtonReturn {
            LocalDecision::AllowOnce
        } else {
            LocalDecision::Deny
        };
        policy.record_local_decision(request, Decision { binding, choice })
    }
}

fn validate_input(input: &RequestInput) -> Result<(), Rejection> {
    let bytes = [input.executable.as_str(), input.cwd.as_str()]
        .into_iter()
        .chain(input.arguments.iter().map(String::as_str))
        .try_fold(0_usize, |sum, value| sum.checked_add(value.len()));
    let lifetime = input.expires_at_ms.checked_sub(input.issued_at_ms);
    if !identifier(&input.id)
        || !input.origin.valid()
        || input.generation == 0
        || input.approval_revision == 0
        || !clean_absolute(&input.executable)
        || input.executable.len() > 4096
        || !clean_absolute(&input.cwd)
        || input.cwd.len() > 4096
        || input.arguments.len() > MAX_ARGUMENTS
        || input
            .arguments
            .iter()
            .any(|arg| arg.len() > 8192 || arg.contains('\0'))
        || bytes.is_none_or(|bytes| bytes > MAX_REQUEST_BYTES)
        || !matches!(lifetime, Some(1..=MAX_TTL_MS))
        || !(1..=MAX_TIMEOUT_MS).contains(&input.timeout_ms)
        || !(1..=MAX_OUTPUT_BYTES).contains(&input.output_limit_bytes)
    {
        return Err(Rejection::InvalidRequest);
    }
    Ok(())
}

fn check_fresh(input: &RequestInput, now_ms: u64) -> Result<(), Rejection> {
    if !(input.issued_at_ms..input.expires_at_ms).contains(&now_ms) {
        return Err(Rejection::Expired);
    }
    Ok(())
}

fn check_context(context: &TrustedContext, input: &RequestInput) -> Result<(), Rejection> {
    let origin = context
        .origin
        .as_ref()
        .ok_or(Rejection::ContextUnavailable)?;
    let local_mac = context
        .local_mac
        .as_ref()
        .ok_or(Rejection::ContextUnavailable)?;
    let local_account = context
        .local_account
        .as_ref()
        .ok_or(Rejection::ContextUnavailable)?;
    let root = context
        .cwd_root
        .as_deref()
        .ok_or(Rejection::ContextUnavailable)?;
    if context.enabled != Some(true)
        || context.can_approve != Some(true)
        || context.turn_active != Some(true)
        || !origin.valid()
        || !identifier(local_mac)
        || !identifier(local_account)
        || root == "/"
        || !clean_absolute(root)
        || context.generation.filter(|n| *n > 0).is_none()
        || context.approval_revision.filter(|n| *n > 0).is_none()
    {
        return Err(Rejection::ContextUnavailable);
    }
    if local_mac != &origin.mac
        || local_account != &origin.account
        || origin != &input.origin
        || context.generation != Some(input.generation)
        || context.approval_revision != Some(input.approval_revision)
    {
        return Err(Rejection::ContextMismatch);
    }
    if !Path::new(&input.cwd).starts_with(root) {
        return Err(Rejection::InvalidDirectory);
    }
    Ok(())
}

#[cfg(test)]
#[path = "host_command_policy_tests.rs"]
mod tests;
