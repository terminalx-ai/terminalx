//! Dormant PRO-220 policy and executor. The native owner must authenticate turn-start attribution
//! and publish authority changes synchronously through this policy. Only the trusted local
//! AppKit prompt may approve a command. This module exposes no transport boundary.

#[path = "host_command_executor.rs"]
mod executor;

use std::collections::{HashMap, VecDeque};
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
const PROMPT_WINDOW_MS: u64 = 60_000;
const MAX_PROMPTS_PER_WINDOW: usize = 3;
const MAX_GLOBAL_PROMPTS_PER_WINDOW: usize = 3;
const MAX_REQUESTS_PER_ORIGIN: usize = 32;

#[derive(Clone, PartialEq, Eq)]
struct Origin {
    mac: String,
    account: String,
    organization: String,
    workspace: String,
    tab: String,
    turn: String,
}

#[derive(Clone, PartialEq, Eq)]
struct OriginBudget {
    mac: String,
    account: String,
    workspace: String,
}

impl From<&Origin> for OriginBudget {
    fn from(origin: &Origin) -> Self {
        Self {
            mac: origin.mac.clone(),
            account: origin.account.clone(),
            workspace: origin.workspace.clone(),
        }
    }
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
/// Remains private until there is an authenticated native attribution path.
#[derive(Clone, Default, PartialEq, Eq)]
struct TrustedContext {
    enabled: Option<bool>,
    local_mac: Option<String>,
    local_account: Option<String>,
    origin: Option<Origin>,
    generation: Option<u64>,
    approval_revision: Option<u64>,
    can_approve: Option<bool>,
    turn_active: Option<bool>,
    cwd_root: Option<String>,
}

/// Proposal identity is checked against native authority. The policy stamps the deadline
/// at receipt using its local monotonic clock.
#[derive(Clone)]
struct RequestInput {
    pub id: String,
    origin: Origin,
    pub generation: u64,
    pub approval_revision: u64,
    ttl_ms: u64,
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
    PromptRateLimited,
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
    TouchIdUnavailable,
    RevokedAfterLaunch,
    ExpiredBeforeLaunch,
    /// The OS accepted the sandboxed launch and output was withheld on expiry.
    ExpiredAfterLaunch,
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
    TouchIdUnavailable,
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
    retire_at_ms: u64,
    budget: OriginBudget,
    state: State,
    paths: Option<executor::ApprovedPaths>,
}

impl Entry {
    fn expire(&mut self, now: u64) {
        if now >= self.expires_at_ms && self.state.live() {
            self.stop(if self.state == State::Running {
                State::ExpiredAfterLaunch
            } else {
                State::ExpiredBeforeLaunch
            });
        }
    }

    fn stop(&mut self, state: State) {
        self.state = state;
        self.paths = None;
    }
}

struct Registry {
    context: TrustedContext,
    epoch: Arc<()>,
    entries: HashMap<String, Arc<Mutex<Entry>>>,
    prompt_open: bool,
    prompt_times: VecDeque<(OriginBudget, u64)>,
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
                prompt_open: false,
                prompt_times: VecDeque::new(),
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
    entry: Arc<Mutex<Entry>>,
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

    fn now_ms(&self) -> u64 {
        #[cfg(test)]
        if let Some(clock) = &self.test_clock {
            return clock.load(std::sync::atomic::Ordering::Relaxed);
        }
        self.started_at.elapsed().as_millis() as u64
    }

    /// Call on every native authority change, including disconnect, sign-out, disable and turn
    /// end. This update and the actual OS spawn have the same serialization point.
    fn update_trusted_context(&self, context: TrustedContext) -> Result<(), Rejection> {
        let mut registry = self.lock()?;
        if registry.context != context {
            for entry in registry.entries.values() {
                let mut entry = entry.lock().map_err(|_| Rejection::Poisoned)?;
                entry.expire(self.now_ms());
                if entry.state.live() {
                    let reason = if entry.state == State::Running {
                        State::RevokedAfterLaunch
                    } else {
                        State::Revoked
                    };
                    entry.stop(reason);
                }
            }
            registry.context = context;
            registry.epoch = Arc::new(());
        }
        Ok(())
    }

    fn submit(&self, input: RequestInput) -> Result<Request, Rejection> {
        let mut registry = self.lock()?;
        let now = self.now_ms();
        validate_input(&input)?;
        check_context(&registry.context, &input)?;
        // Keep replay tombstones for the maximum request lifetime. A fresh admission
        // after that window still needs a new exact native approval.
        registry.entries.retain(|_, entry| {
            let Ok(mut entry) = entry.lock() else {
                return true;
            };
            entry.expire(now);
            now < entry.retire_at_ms
        });
        if registry.entries.contains_key(&input.id) {
            return Err(Rejection::Replay);
        }
        let budget = OriginBudget::from(&input.origin);
        if registry.entries.len() >= MAX_REQUESTS
            || registry
                .entries
                .values()
                .filter(|entry| entry.lock().map_or(true, |entry| entry.budget == budget))
                .count()
                >= MAX_REQUESTS_PER_ORIGIN
        {
            return Err(Rejection::Capacity);
        }
        if registry.in_flight
            || registry
                .entries
                .values()
                .any(|entry| entry.lock().map_or(true, |entry| entry.state.live()))
        {
            return Err(Rejection::Busy);
        }
        let input = Arc::new(input);
        let entry = Arc::new(Mutex::new(Entry {
            expires_at_ms: now.saturating_add(input.ttl_ms),
            retire_at_ms: now.saturating_add(MAX_TTL_MS),
            budget,
            state: State::Pending,
            paths: None,
        }));
        registry.entries.insert(input.id.clone(), entry.clone());
        Ok(Request {
            policy: self.clone(),
            input,
            entry,
            epoch: registry.epoch.clone(),
        })
    }

    /// Present the exact request in an AppKit modal on the main thread.
    #[cfg(all(target_os = "macos", feature = "desktop"))]
    #[allow(dead_code, reason = "The native executor is dormant")]
    fn prompt_once(
        &self,
        request: &Request,
        parent: &objc2_app_kit::NSWindow,
    ) -> Result<mpsc::Receiver<Result<State, Rejection>>, Rejection> {
        consent::prompt(self, request, parent)
    }

    fn reserve_prompt(&self, request: &Request) -> Result<PromptSlot, Rejection> {
        self.require_owner(request)?;
        let mut registry = self.lock()?;
        drop(request.checked(&registry, State::Pending)?);
        let now = self.now_ms();
        while registry
            .prompt_times
            .front()
            .is_some_and(|(_, time)| now.saturating_sub(*time) >= PROMPT_WINDOW_MS)
        {
            registry.prompt_times.pop_front();
        }
        let budget = OriginBudget::from(&request.input.origin);
        if registry.prompt_open
            || registry.prompt_times.len() >= MAX_GLOBAL_PROMPTS_PER_WINDOW
            || registry
                .prompt_times
                .iter()
                .filter(|(key, _)| key == &budget)
                .count()
                >= MAX_PROMPTS_PER_WINDOW
        {
            return Err(Rejection::PromptRateLimited);
        }
        registry.prompt_times.push_back((budget, now));
        registry.prompt_open = true;
        Ok(PromptSlot(self.clone()))
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
        let registry = self.lock()?;
        let mut entry = request.checked(&registry, State::Pending)?;
        if !Arc::ptr_eq(&binding.input, &request.input) {
            entry.stop(State::Denied);
            return Err(Rejection::DecisionMismatch);
        }
        match decision {
            LocalDecision::Deny => entry.stop(State::Denied),
            LocalDecision::TouchIdUnavailable => entry.stop(State::TouchIdUnavailable),
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
    fn start(&self, request: &Request) -> Result<Execution, Rejection> {
        self.require_owner(request)?;
        let mut registry = self.lock()?;
        let mut entry = request.checked(&registry, State::Approved)?;
        let paths = entry.paths.take().ok_or(Rejection::InvalidTransition)?;
        entry.state = State::Starting;
        drop(entry);
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
            request.entry()?.stop(State::Failed);
            return Err(Rejection::WorkerUnavailable);
        }
        Ok(Execution {
            request: request.clone(),
            receiver,
        })
    }
}

impl Request {
    fn input(&self) -> &RequestInput {
        &self.input
    }

    fn entry(&self) -> Result<MutexGuard<'_, Entry>, Rejection> {
        self.entry.lock().map_err(|_| Rejection::Poisoned)
    }

    fn checked(
        &self,
        registry: &Registry,
        expected: State,
    ) -> Result<MutexGuard<'_, Entry>, Rejection> {
        let mut entry = self.entry()?;
        entry.expire(self.policy.now_ms());
        if matches!(
            entry.state,
            State::ExpiredBeforeLaunch | State::ExpiredAfterLaunch
        ) {
            return Err(Rejection::Expired);
        }
        if entry.state != expected {
            return Err(Rejection::InvalidTransition);
        }
        if !Arc::ptr_eq(&self.epoch, &registry.epoch) {
            entry.stop(State::Revoked);
            return Err(Rejection::ContextMismatch);
        }
        if let Err(reason) = check_context(&registry.context, &self.input) {
            entry.stop(State::Revoked);
            return Err(reason);
        }
        Ok(entry)
    }

    fn require_pending(&self) -> Result<(), Rejection> {
        let registry = self.policy.lock()?;
        drop(self.checked(&registry, State::Pending)?);
        Ok(())
    }

    pub fn state(&self) -> Result<State, Rejection> {
        let mut entry = self.entry()?;
        entry.expire(self.policy.now_ms());
        Ok(entry.state)
    }

    pub fn cancel(&self) -> Result<State, Rejection> {
        let _registry = self.policy.lock()?;
        let mut entry = self.entry()?;
        if !entry.state.live() {
            return Err(Rejection::InvalidTransition);
        }
        entry.expire(self.policy.now_ms());
        if !entry.state.live() {
            return Err(Rejection::Expired);
        }
        entry.stop(State::Cancelled);
        Ok(State::Cancelled)
    }

    fn finish(&self, state: State) -> State {
        let Ok(_registry) = self.policy.lock() else {
            return State::Revoked;
        };
        let Ok(mut entry) = self.entry() else {
            return State::Revoked;
        };
        entry.expire(self.policy.now_ms());
        if entry.state.live() {
            entry.stop(state);
        }
        entry.state
    }
}

struct PromptSlot(Policy);

impl Drop for PromptSlot {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.0.lock() {
            registry.prompt_open = false;
        }
    }
}

struct ExecutionSlot<'a>(&'a Request);

impl Drop for ExecutionSlot<'_> {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.0.policy.lock() {
            if let Ok(mut entry) = self.0.entry() {
                if entry.state.live() {
                    entry.stop(State::Failed);
                }
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
            let mut entry = self.request.entry()?;
            let reason = if !Arc::ptr_eq(&registry.epoch, &self.request.epoch)
                || check_context(&registry.context, &self.request.input).is_err()
            {
                entry.stop(State::RevokedAfterLaunch);
                Some(State::RevokedAfterLaunch)
            } else if self.request.policy.now_ms() >= entry.expires_at_ms {
                entry.stop(State::ExpiredAfterLaunch);
                Some(State::ExpiredAfterLaunch)
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

fn quote_prompt_value(value: &str) -> String {
    let mut escaped = String::from("\"");
    for character in value.chars() {
        if character == ' ' {
            escaped.push_str(r"\x20");
        } else {
            escaped.extend(character.escape_default());
        }
    }
    escaped.push('"');
    escaped
}

fn command_text(input: &RequestInput) -> Result<String, Rejection> {
    use std::fmt::Write;
    let mut text = format!(
        "Program: {}\nWorking directory: {}",
        quote_prompt_value(&input.executable),
        quote_prompt_value(&input.cwd),
    );
    for (index, arg) in input.arguments.iter().enumerate() {
        write!(
            text,
            "\nArgument {}: {}",
            index + 1,
            quote_prompt_value(arg)
        )
        .expect("writing to a String cannot fail");
    }
    if text.len() > 512 {
        return Err(Rejection::InvalidRequest);
    }
    Ok(text)
}

fn prompt_text(input: &RequestInput) -> Result<String, Rejection> {
    Ok(format!(
        "Account: {}\nOrganization: {}\nWorkspace: {}\n{}\nTimeout: {} ms\nOutput limit: {} bytes",
        quote_prompt_value(&input.origin.account),
        quote_prompt_value(&input.origin.organization),
        quote_prompt_value(&input.origin.workspace),
        command_text(input)?,
        input.timeout_ms,
        input.output_limit_bytes,
    ))
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

    #[cfg(any(test, all(target_os = "macos", feature = "desktop")))]
    pub(super) struct PromptLifetime {
        request: Request,
        _slot: PromptSlot,
    }

    #[cfg(any(test, all(target_os = "macos", feature = "desktop")))]
    impl PromptLifetime {
        pub(super) fn begin(policy: &Policy, request: &Request) -> Result<Self, Rejection> {
            Ok(Self {
                request: request.clone(),
                _slot: policy.reserve_prompt(request)?,
            })
        }

        pub(super) fn poll<T>(&self, replies: &mpsc::Receiver<T>) -> Option<Result<T, Rejection>> {
            if let Err(reason) = self.request.require_pending() {
                return Some(Err(reason));
            }
            match replies.try_recv() {
                Ok(reply) => Some(Ok(reply)),
                Err(mpsc::TryRecvError::Disconnected) => Some(Err(Rejection::WorkerUnavailable)),
                Err(mpsc::TryRecvError::Empty) => None,
            }
        }
    }

    #[cfg(all(target_os = "macos", feature = "desktop"))]
    mod cocoa {
        use super::*;
        use block2::{DynBlock, RcBlock};
        use objc2::rc::Retained;
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{class, msg_send, MainThreadMarker, Message};
        use objc2_app_kit::{
            NSAlert, NSAlertSecondButtonReturn, NSAlertStyle, NSModalResponse, NSWindow,
        };
        use objc2_foundation::{NSError, NSString};
        use std::cell::Cell;
        use std::ffi::c_void;

        const BIOMETRICS_ONLY: isize = 1;

        #[link(name = "LocalAuthentication", kind = "framework")]
        extern "C" {
            static LAErrorDomain: &'static NSString;
        }

        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            static kCFRunLoopCommonModes: *const c_void;
            fn CFAbsoluteTimeGetCurrent() -> f64;
            fn CFRunLoopGetMain() -> *mut c_void;
            fn CFRunLoopTimerCreateWithHandler(
                allocator: *const c_void,
                fire_date: f64,
                interval: f64,
                flags: usize,
                order: isize,
                handler: &DynBlock<dyn Fn(*mut c_void)>,
            ) -> *mut c_void;
            fn CFRunLoopAddTimer(run_loop: *mut c_void, timer: *mut c_void, mode: *const c_void);
            fn CFRunLoopTimerInvalidate(timer: *mut c_void);
            fn CFRelease(object: *const c_void);
        }

        enum Stage {
            Alert {
                parent: Retained<NSWindow>,
                alert: Retained<NSAlert>,
                replies: mpsc::Receiver<NSModalResponse>,
            },
            Biometric {
                context: Retained<AnyObject>,
                replies: mpsc::Receiver<LocalDecision>,
            },
        }

        impl Stage {
            fn dismiss(self) {
                match self {
                    Self::Alert { parent, alert, .. } => {
                        let sheet = alert.window();
                        if sheet.sheetParent().is_some() {
                            parent.endSheet(&sheet);
                        }
                    }
                    Self::Biometric { context, .. } => {
                        // SAFETY: the object is the LAContext owned by this flow.
                        unsafe {
                            let _: () = msg_send![&*context, invalidate];
                        }
                    }
                }
            }
        }

        struct Flow {
            lifetime: PromptLifetime,
            policy: Policy,
            binding: LocalDecisionBinding,
            sender: mpsc::SyncSender<Result<State, Rejection>>,
            stage: Stage,
        }

        impl Flow {
            fn advance(mut self) -> Option<Self> {
                let choice = match &self.stage {
                    Stage::Alert { replies, .. } => match self.lifetime.poll(replies) {
                        None => return Some(self),
                        Some(reply) => match reply {
                            Ok(response) if response == NSAlertSecondButtonReturn => {
                                match start_biometric(&self.binding.input) {
                                    Ok(stage) => {
                                        self.stage = stage;
                                        return Some(self);
                                    }
                                    Err(choice) => Ok(choice),
                                }
                            }
                            Ok(_) => Ok(LocalDecision::Deny),
                            Err(reason) => Err(reason),
                        },
                    },
                    Stage::Biometric { replies, .. } => match self.lifetime.poll(replies) {
                        Some(result) => result,
                        None => return Some(self),
                    },
                };
                self.stage.dismiss();
                let result = choice.and_then(|choice| {
                    self.policy.record_local_decision(
                        &self.lifetime.request,
                        Decision {
                            binding: self.binding,
                            choice,
                        },
                    )
                });
                drop(self.lifetime);
                let _ = self.sender.try_send(result);
                None
            }
        }

        fn start_biometric(input: &RequestInput) -> Result<Stage, LocalDecision> {
            let reason = command_text(input).map_err(|_| LocalDecision::Deny)?;
            // SAFETY: LAContext selectors use their SDK signatures. Each
            // request gets its own context, held and invalidated on the main thread.
            let context: Retained<AnyObject> = unsafe { msg_send![class!(LAContext), new] };
            let available: Bool = unsafe {
                msg_send![&*context, canEvaluatePolicy: BIOMETRICS_ONLY, error: std::ptr::null_mut::<*mut NSError>()]
            };
            if !available.as_bool() {
                return Err(LocalDecision::TouchIdUnavailable);
            }
            let (reply, replies) = mpsc::sync_channel(1);
            let callback = RcBlock::new(move |success: Bool, error: *mut NSError| {
                let choice = if success.as_bool() {
                    LocalDecision::AllowOnce
                } else if unsafe { error.as_ref() }.is_some_and(|error| {
                    error.domain().isEqualToString(unsafe { LAErrorDomain })
                        && matches!(error.code(), -8..=-6)
                }) {
                    LocalDecision::TouchIdUnavailable
                } else {
                    LocalDecision::Deny
                };
                let _ = reply.try_send(choice);
            });
            let empty = NSString::from_str("");
            let reason = NSString::from_str(&reason);
            unsafe {
                let _: () = msg_send![&*context, setLocalizedFallbackTitle: &*empty];
                let _: () =
                    msg_send![&*context, setTouchIDAuthenticationAllowableReuseDuration: 0.0_f64];
                let _: () = msg_send![&*context, evaluatePolicy: BIOMETRICS_ONLY, localizedReason: &*reason, reply: &*callback];
            }
            Ok(Stage::Biometric { context, replies })
        }

        pub(in super::super) fn prompt(
            policy: &Policy,
            request: &Request,
            parent: &NSWindow,
        ) -> Result<mpsc::Receiver<Result<State, Rejection>>, Rejection> {
            let main = MainThreadMarker::new().ok_or(Rejection::ContextUnavailable)?;
            if parent.attachedSheet().is_some() {
                return Err(Rejection::Busy);
            }
            let lifetime = PromptLifetime::begin(policy, request)?;
            let binding = policy.prepare_local_decision(request)?;
            let (sender, result) = mpsc::sync_channel(1);
            let (reply, replies) = mpsc::sync_channel(1);
            let completion = RcBlock::new(move |response: NSModalResponse| {
                let _ = reply.try_send(response);
            });
            let alert = NSAlert::new(main);
            alert.setAlertStyle(NSAlertStyle::Warning);
            alert.setMessageText(&NSString::from_str("Run this command on your Mac?"));
            alert.setInformativeText(&NSString::from_str(&prompt_text(&binding.input)?));
            alert.addButtonWithTitle(&NSString::from_str("Cancel"));
            alert.addButtonWithTitle(&NSString::from_str("Continue to Touch ID"));
            let flow = Cell::new(Some(Flow {
                lifetime,
                policy: policy.clone(),
                binding,
                sender,
                stage: Stage::Alert {
                    parent: parent.retain(),
                    alert: alert.clone(),
                    replies,
                },
            }));
            let tick = RcBlock::new(move |timer: *mut c_void| {
                // Take ownership before any AppKit call. If AppKit re-enters
                // this timer while dismissing a sheet, there is no flow to advance.
                if let Some(active) = flow.take() {
                    match active.advance() {
                        Some(active) => flow.set(Some(active)),
                        // SAFETY: this is the live timer passed by Core Foundation.
                        None => unsafe { CFRunLoopTimerInvalidate(timer) },
                    }
                }
            });
            // SAFETY: Core Foundation copies the block. The timer is added
            // only to the main run loop and that loop retains it until invalidation.
            unsafe {
                let timer = CFRunLoopTimerCreateWithHandler(
                    std::ptr::null(),
                    CFAbsoluteTimeGetCurrent() + 0.05,
                    0.05,
                    0,
                    0,
                    &tick,
                );
                if timer.is_null() {
                    return Err(Rejection::WorkerUnavailable);
                }
                alert.beginSheetModalForWindow_completionHandler(parent, Some(&completion));
                CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
                CFRelease(timer);
            }
            Ok(result)
        }
    }

    #[cfg(all(target_os = "macos", feature = "desktop"))]
    pub(super) use cocoa::prompt;
}

fn validate_input(input: &RequestInput) -> Result<(), Rejection> {
    let bytes = [input.executable.as_str(), input.cwd.as_str()]
        .into_iter()
        .chain(input.arguments.iter().map(String::as_str))
        .try_fold(0_usize, |sum, value| sum.checked_add(value.len()));
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
        || !(1..=MAX_TTL_MS).contains(&input.ttl_ms)
        || !(1..=MAX_TIMEOUT_MS).contains(&input.timeout_ms)
        || !(1..=MAX_OUTPUT_BYTES).contains(&input.output_limit_bytes)
    {
        return Err(Rejection::InvalidRequest);
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
