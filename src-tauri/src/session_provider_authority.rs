//! Native-only provider authority. This is a carrier, never a new admission.
//! ACP/OpenCode use session-owned streaming paths behind retained V2 entry blocks.
//! Source-only and unvalidated; availability and activation remain withheld.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};

use super::{CollaborationPermit, collaboration_v2};
use crate::harness::host::LiveChild;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RequiredAction { Drive, Configure, Approve }

#[derive(Clone)]
enum CollaborationSource {
    Local,
    Remote { permit: CollaborationPermit, admitted: RequiredAction },
    MissingRemote,
}

/// All four constraints travel independently. Local collaboration does not
/// erase a privacy, mobile, or local-sharing restriction.
#[derive(Clone)]
pub(crate) struct SenderAuthority {
    collaboration: CollaborationSource,
    pub(super) privacy: Option<crate::data_privacy::Ticket>,
    pub(super) mobile: Option<crate::local_runtime::mobile::WritePermit>,
    pub(super) local_share: Option<crate::local_sharing::WritePermit>,
}

impl SenderAuthority {
    /// Native ingress supplies the action it admitted and its ORIGINAL permit.
    /// Never call current(), stamp(), or Permit::new from a queue or callback.
    pub(super) fn capture(permit: Option<CollaborationPermit>, admitted: RequiredAction,
        privacy: Option<crate::data_privacy::Ticket>, mobile: Option<crate::local_runtime::mobile::WritePermit>,
        local_share: Option<crate::local_sharing::WritePermit>) -> Self {
        Self { collaboration: match permit {
            Some(permit) => CollaborationSource::Remote { permit, admitted },
            None => CollaborationSource::Local,
        }, privacy, mobile, local_share }
    }

    fn missing(privacy: Option<crate::data_privacy::Ticket>) -> Self {
        Self { collaboration: CollaborationSource::MissingRemote, privacy, mobile: None, local_share: None }
    }

    pub(super) fn permit(&self) -> Option<&CollaborationPermit> {
        match &self.collaboration { CollaborationSource::Remote { permit, .. } => Some(permit), _ => None }
    }

    pub(super) fn is_remote(&self) -> bool { !matches!(self.collaboration, CollaborationSource::Local) }

    fn needs_carrier(&self) -> bool { self.is_remote() || self.mobile.is_some() || self.local_share.is_some() }

    pub(super) fn check(&self, required: RequiredAction, witness: Option<&collaboration_v2::TabWitness>) -> Result<()> {
        for ticket in self.privacy.iter()
            .chain(self.mobile.iter().map(|permit| &permit.grant.privacy))
            .chain(self.local_share.iter().map(|permit| &permit.privacy)) {
            ensure!(ticket.valid(), crate::data_privacy::MESSAGE);
        }
        match &self.collaboration {
            CollaborationSource::Local => Ok(()),
            CollaborationSource::MissingRemote => bail!("original provider sender carrier is missing"),
            CollaborationSource::Remote { permit, admitted } => {
                ensure!(*admitted == required, "provider operation cannot broaden its original action");
                // Check the original action as well as the requested action. A
                // native Configure/Approve admission cannot borrow Drive here.
                permit.check(witness)?;
                match required {
                    RequiredAction::Drive => Ok(()),
                    RequiredAction::Configure => permit.check_configuration(),
                    RequiredAction::Approve => permit.check_approval(),
                }
            }
        }
    }
}

/// Persisted requirement only. It is not an actor, permit, or association.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum QueueRequirement { #[default] Legacy, Local, NeedsOriginalCarrier }

// PendingMessage has literal constructors in independently owned native code.
// Reserve an opaque ID namespace instead of adding a required Rust field there.
// Serialization also writes a named requirement; restored IDs retain the fence.
const ORIGINAL: &str = "provider-original:";
const LOCAL: &str = "provider-local:";

pub(super) fn queue_requirement(id: &str) -> QueueRequirement {
    if id.starts_with(ORIGINAL) { QueueRequirement::NeedsOriginalCarrier }
    else if id.starts_with(LOCAL) { QueueRequirement::Local }
    else { QueueRequirement::Legacy }
}

pub(super) fn restore_queue_id(id: String, required: QueueRequirement) -> String {
    // A conflicting local/legacy field cannot downgrade the ID's requirement.
    if required == QueueRequirement::NeedsOriginalCarrier && !id.starts_with(ORIGINAL) {
        format!("{ORIGINAL}{id}")
    } else { id }
}

#[derive(Clone)]
enum AssociationFence {
    Owned { child: Weak<LiveChild>, epoch: u64 },
    // The token is the native admitted transport identity, never PID/port or a
    // saved provider session ID. No production adopted-provider route is added.
    #[cfg(test)]
    Associated(Weak<()>),
}

impl AssociationFence {
    fn current(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Owned { child: a, epoch: ae }, Self::Owned { child: b, epoch: be }) =>
                ae == be && a.upgrade().zip(b.upgrade()).is_some_and(|(a, b)| Arc::ptr_eq(&a, &b)),
            #[cfg(test)]
            (Self::Associated(a), Self::Associated(b)) =>
                a.upgrade().zip(b.upgrade()).is_some_and(|(a, b)| Arc::ptr_eq(&a, &b)),
            #[cfg(test)]
            _ => false,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ProviderBinding {
    session: String,
    tab: String,
    association: AssociationFence,
    incarnation: Arc<()>,
}

impl ProviderBinding {
    pub(super) fn owned(session: &str, tab: &str, child: &Arc<LiveChild>) -> Self {
        Self { session: session.into(), tab: tab.into(),
            association: AssociationFence::Owned { child: Arc::downgrade(child), epoch: child.epoch }, incarnation: Arc::new(()) }
    }

    pub(super) fn matches_child(&self, child: &Arc<LiveChild>) -> bool {
        self.association.current(&AssociationFence::Owned { child: Arc::downgrade(child), epoch: child.epoch })
    }

    pub(super) fn current(&self, live: &Self) -> bool {
        self.session == live.session && self.tab == live.tab
            && Arc::ptr_eq(&self.incarnation, &live.incarnation) && self.association.current(&live.association)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Correlation {
    Prompt { seq: u64, request: String },
    Setting { setting: String, request_id: String, adapter_request: String },
    Approval { ask_id: String, provider_request: String, attempt: String },
    Opening { request: String, parent_operation: String },
    Control { request: String, kind: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase { Pending, DispatchStarted, AwaitingCallback, CallbackStarted, Delivered, Withdrawn, UnknownOutcome }

#[derive(Clone)]
pub(crate) struct OperationContext {
    id: String,
    sender: SenderAuthority,
    required: RequiredAction,
    binding: ProviderBinding,
    correlation: Correlation,
    state: Arc<Mutex<Phase>>,
    parents: Vec<Arc<Mutex<Phase>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Attempt { Applied, Deferred, Withdrawn }

impl OperationContext {
    pub(super) fn new(sender: SenderAuthority, required: RequiredAction, binding: ProviderBinding, correlation: Correlation) -> Self {
        Self { id: uuid::Uuid::new_v4().to_string(), sender, required, binding, correlation,
            state: Arc::new(Mutex::new(Phase::Pending)), parents: Vec::new() }
    }

    /// Ingress-only parents have handed their one prompt to a derived wire
    /// operation. Seal against deriving/replaying another prompt; existing
    /// children retain the original sender and their own cancellation gate.
    pub(super) fn seal_origin(&self) {
        let mut phase = self.state.lock().unwrap();
        if *phase == Phase::Pending { *phase = Phase::Delivered; }
    }
    pub(super) fn callback_finished(&self) -> bool { *self.state.lock().unwrap() == Phase::Delivered }
    pub(super) fn retired(&self) -> bool {
        matches!(*self.state.lock().unwrap(), Phase::Withdrawn | Phase::UnknownOutcome)
            || self.parents.iter().any(|p| matches!(*p.lock().unwrap(), Phase::Withdrawn | Phase::UnknownOutcome))
    }
    pub(super) fn destination(&self) -> (&str, &str) { (&self.binding.session, &self.binding.tab) }
    pub(super) fn sender(&self) -> &SenderAuthority { &self.sender }
    pub(crate) fn operation_id(&self) -> &str { &self.id }
    pub(crate) fn correlation(&self) -> &Correlation { &self.correlation }

    fn check(&self, live: &ProviderBinding, request: &Correlation, witness: Option<&collaboration_v2::TabWitness>) -> Result<()> {
        ensure!(self.binding.current(live), "provider association or engine incarnation changed");
        ensure!(&self.correlation == request, "provider callback request changed");
        ensure!(self.parents.iter().all(|parent| !matches!(*parent.lock().unwrap(), Phase::Withdrawn | Phase::UnknownOutcome)), "provider parent operation retired");
        self.sender.check(self.required, witness)
    }

    pub(crate) fn withdraw(&self) {
        let mut state = self.state.lock().unwrap();
        *state = match *state {
            Phase::Pending => Phase::Withdrawn,
            Phase::DispatchStarted | Phase::AwaitingCallback | Phase::CallbackStarted => Phase::UnknownOutcome,
            terminal => terminal,
        };
    }

    pub(crate) fn derive_follow_on(&self, correlation: Correlation) -> Result<Self> {
        let state = self.state.lock().unwrap();
        ensure!(matches!(*state, Phase::Pending | Phase::DispatchStarted | Phase::AwaitingCallback | Phase::CallbackStarted), "provider parent is retired");
        ensure!(self.parents.iter().all(|parent| !matches!(*parent.lock().unwrap(), Phase::Withdrawn | Phase::UnknownOutcome)), "provider ancestor is retired");
        let mut child = Self::new(self.sender.clone(), self.required, self.binding.clone(), correlation);
        child.parents = self.parents.clone();
        child.parents.push(self.state.clone());
        Ok(child)
    }

    /// Runtime-held callers MUST use try admission, never wait for policy in
    /// reverse order. The closure is a SHORT synchronous final mutation only.
    /// Caller has already acquired session/sender/attachment gates in order;
    /// admit_sender verifies those exact original constraints, not new tickets.
    /// HTTP/blocking transport must not be passed to this function.
    pub(super) fn try_dispatch(&self, live: &ProviderBinding, request: &Correlation,
        witness: Option<&collaboration_v2::TabWitness>, admit_sender: impl FnOnce(&SenderAuthority) -> Result<()>,
        mutation: impl FnOnce() -> Result<()>) -> Result<Attempt> {
        let permit = self.sender.permit();
        let _policy = match permit {
            Some(permit) => match permit.collaboration.try_enter_admission() {
                Some(admission) => Some(admission), None => return Ok(Attempt::Deferred),
            },
            None => None,
        };
        let mut state = self.state.lock().unwrap();
        if *state != Phase::Pending { return Ok(Attempt::Withdrawn); }
        if self.check(live, request, witness).and_then(|()| admit_sender(&self.sender)).is_err() {
            *state = Phase::Withdrawn;
            return Ok(Attempt::Withdrawn);
        }
        let _privacy = self.sender.privacy.as_ref().map(|ticket| ticket.enter()).transpose()?;
        *state = Phase::DispatchStarted; // exact attempt's linearization point
        drop(state);
        // Do not hold the lifecycle mutex while invoking native code: an
        // opening continuation may derive a child with the same original sender.
        let result = mutation();
        let mut state = self.state.lock().unwrap();
        match result {
            Ok(()) => {
                if *state == Phase::DispatchStarted { *state = Phase::AwaitingCallback; }
                Ok(Attempt::Applied)
            },
            Err(error) => { *state = Phase::UnknownOutcome; Err(error) },
        }
    }

    /// Consume an exact callback once, under the same short admission as its
    /// setting/UI mutation. A duplicate cannot settle a newer equal value.
    pub(super) fn try_callback(&self, live: &ProviderBinding, request: &Correlation,
        witness: Option<&collaboration_v2::TabWitness>, admit_sender: impl FnOnce(&SenderAuthority) -> Result<()>,
        mutation: impl FnOnce() -> Result<()>) -> Result<Attempt> {
        let permit = self.sender.permit();
        let _policy = match permit {
            Some(permit) => match permit.collaboration.try_enter_admission() {
                Some(admission) => Some(admission), None => return Ok(Attempt::Deferred),
            },
            None => None,
        };
        if &self.correlation != request { return Ok(Attempt::Withdrawn); }
        let mut state = self.state.lock().unwrap();
        if *state != Phase::AwaitingCallback { return Ok(Attempt::Withdrawn); }
        if self.check(live, request, witness).and_then(|()| admit_sender(&self.sender)).is_err() {
            *state = Phase::UnknownOutcome;
            return Ok(Attempt::Withdrawn);
        }
        let _privacy = self.sender.privacy.as_ref().map(|ticket| ticket.enter()).transpose()?;
        // Reserve once before native code; a callback may derive its follow-on
        // without reentering this mutex. Cancellation of an in-flight attempt
        // is UnknownOutcome and must not be overwritten by its late success.
        *state = Phase::CallbackStarted;
        drop(state);
        let result = mutation();
        let mut state = self.state.lock().unwrap();
        match result {
            Ok(()) => {
                if *state == Phase::CallbackStarted { *state = Phase::Delivered; }
                Ok(Attempt::Applied)
            },
            Err(error) => { *state = Phase::UnknownOutcome; Err(error) },
        }
    }
}

/// Owned by ONE writer; never cloneable and contains no admission guard.
/// Reserve once, admit the SAME context per syscall, finish once. Adapters
/// cannot create reservations: the session owner supplies their final hook.
pub(super) struct StreamReservation {
    context: OperationContext,
    written: usize,
    finished: bool,
}

#[derive(Clone, Copy)]
pub(super) enum StreamOutcome { Refused, Unknown, Response, Complete }

impl OperationContext {
    pub(super) fn reserve_stream(&self) -> Result<StreamReservation> {
        let mut phase = self.state.lock().unwrap();
        ensure!(*phase == Phase::Pending, "provider operation already reserved or retired");
        *phase = Phase::DispatchStarted;
        Ok(StreamReservation { context: self.clone(), written: 0, finished: false })
    }

    /// An undispatched queued item may follow a retired opening onto a new
    /// association. Its original sender/id/cancellation are preserved; started
    /// streams and callback children can never be rebound or replayed.
    pub(super) fn bind_queued(mut self, binding: ProviderBinding) -> Result<Self> {
        ensure!(*self.state.lock().unwrap() == Phase::Pending && self.parents.is_empty(), "only undispatched original queue items can bind a new association");
        self.binding = binding;
        Ok(self)
    }

    /// Cancellation/association polling only, NEVER physical authorization.
    pub(super) fn stream_current(&self, live: &ProviderBinding) -> bool {
        self.binding.current(live)
            && *self.state.lock().unwrap() == Phase::DispatchStarted
            && self.parents.iter().all(|parent| !matches!(*parent.lock().unwrap(), Phase::Withdrawn | Phase::UnknownOutcome))
    }

    /// Identity only, including the native incarnation. This never authorizes
    /// a byte or callback; those still need try_chunk/try_callback admission.
    pub(super) fn association_current(&self, live: &ProviderBinding) -> bool {
        self.binding.current(live)
    }
}

impl StreamReservation {
    pub(super) fn written(&self) -> usize { self.written }

    /// The owner holds policy -> session -> original sender -> runtime.
    /// Policy uses try admission here too, so runtime-held test/native users
    /// never wait in reverse order. The one syscall runs synchronously while
    /// the lifecycle lock prevents cancel from interleaving its linearization.
    /// WouldBlock/Interrupted leave DispatchStarted; all guards drop on return.
    pub(super) fn try_chunk(&mut self, live: &ProviderBinding, request: &Correlation,
        witness: Option<&collaboration_v2::TabWitness>,
        admit_sender: impl FnOnce(&SenderAuthority) -> Result<()>,
        syscall: impl FnOnce() -> std::io::Result<usize>,
    ) -> Result<(Attempt, Option<std::io::Result<usize>>)> {
        let _policy = match self.context.sender.permit() {
            Some(permit) => match permit.collaboration.try_enter_admission() {
                Some(guard) => Some(guard), None => return Ok((Attempt::Deferred, None)),
            }, None => None,
        };
        let mut phase = self.context.state.lock().unwrap();
        if self.finished || *phase != Phase::DispatchStarted { return Ok((Attempt::Withdrawn, None)); }
        if self.context.check(live, request, witness).and_then(|()| admit_sender(&self.context.sender)).is_err() {
            *phase = if self.written == 0 { Phase::Withdrawn } else { Phase::UnknownOutcome };
            return Ok((Attempt::Withdrawn, None));
        }
        let _privacy = self.context.sender.privacy.as_ref().map(|ticket| ticket.enter()).transpose()?;
        let result = syscall(); // exactly ONE nonblocking syscall, including WouldBlock
        match &result {
            Ok(n) if *n > 0 => self.written += *n,
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {},
            _ => *phase = Phase::UnknownOutcome,
        }
        Ok((Attempt::Applied, Some(result)))
    }

    /// A known no-wire setting confirmation uses the same exact sender and
    /// lifecycle, without fabricating a successful physical syscall.
    pub(super) fn try_confirm(&mut self, live: &ProviderBinding, witness: Option<&collaboration_v2::TabWitness>) -> Result<Attempt> {
        let _policy = match self.context.sender.permit() {
            Some(permit) => match permit.collaboration.try_enter_admission() {
                Some(guard) => Some(guard), None => return Ok(Attempt::Deferred),
            }, None => None,
        };
        let mut phase = self.context.state.lock().unwrap();
        if self.finished || *phase != Phase::DispatchStarted { return Ok(Attempt::Withdrawn); }
        if self.context.check(live, self.context.correlation(), witness).is_err() {
            *phase = Phase::Withdrawn;
            return Ok(Attempt::Withdrawn);
        }
        *phase = Phase::Delivered;
        self.finished = true;
        Ok(Attempt::Applied)
    }

    /// Response means a complete newline/HTTP request and a real response may
    /// now be admitted once. Complete is a no-response control/approval. Call
    /// under the final original admission before publishing delivery events.
    pub(super) fn finish(&mut self, outcome: StreamOutcome) -> bool {
        if self.finished { return false; }
        self.finished = true;
        let mut phase = self.context.state.lock().unwrap();
        if *phase != Phase::DispatchStarted {
            // Adapter support may already have called withdraw on zero-byte
            // refusal. This reservation knows no syscall wrote any bytes.
            if self.written == 0 && matches!(outcome, StreamOutcome::Refused) && *phase == Phase::UnknownOutcome {
                *phase = Phase::Withdrawn;
            }
            return false;
        }
        *phase = match outcome {
            StreamOutcome::Refused if self.written == 0 => Phase::Withdrawn,
            StreamOutcome::Refused | StreamOutcome::Unknown => Phase::UnknownOutcome,
            StreamOutcome::Response => Phase::AwaitingCallback,
            StreamOutcome::Complete => Phase::Delivered,
        };
        matches!(outcome, StreamOutcome::Response | StreamOutcome::Complete)
    }
}

impl Drop for StreamReservation {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(if self.written == 0 { StreamOutcome::Refused } else { StreamOutcome::Unknown });
        }
    }
}

/// Tab-scoped original queue carriers. Pop/cancel/Stop remove only their
/// entries; callback clones continue to share the operation's cancellation.
#[derive(Default)]
pub(super) struct QueueCarriers(HashMap<(u64, String), OperationContext>);

impl QueueCarriers {
    pub(super) fn insert(&mut self, seq: u64, operation: OperationContext) -> String {
        let prefix = if operation.sender.needs_carrier() { ORIGINAL } else { LOCAL };
        let id = format!("{prefix}{}", operation.id);
        self.0.insert((seq, id.clone()), operation);
        id
    }

    pub(super) fn take(&mut self, seq: u64, id: &str, privacy: Option<crate::data_privacy::Ticket>, binding: ProviderBinding) -> OperationContext {
        self.0.remove(&(seq, id.into())).unwrap_or_else(|| {
            let sender = if queue_requirement(id) == QueueRequirement::NeedsOriginalCarrier { SenderAuthority::missing(privacy) }
                else { SenderAuthority::capture(None, RequiredAction::Drive, privacy, None, None) };
            OperationContext::new(sender, RequiredAction::Drive, binding, Correlation::Prompt { seq, request: id.into() })
        })
    }

    pub(super) fn remove(&mut self, seq: u64, id: &str) -> Option<OperationContext> {
        self.0.remove(&(seq, id.into()))
    }

    pub(super) fn reinsert(&mut self, seq: u64, id: String, operation: OperationContext) {
        self.0.insert((seq, id), operation);
    }

    pub(super) fn cancel(&mut self, seq: u64, id: &str) {
        if let Some(operation) = self.0.remove(&(seq, id.into())) { operation.withdraw(); }
    }

    pub(super) fn clear(&mut self) {
        for (_, operation) in self.0.drain() { operation.withdraw(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::collab::{Collaboration, v2::{Action, Permit, Snapshot}};
    use crate::harness::settings::Settings;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Policy {
        policy: Arc<Collaboration>,
        _dir: tempfile::TempDir,
    }

    impl Policy {
        fn new() -> Self {
            let policy = Arc::new(Collaboration::new());
            let dir = tempfile::tempdir().unwrap();
            policy.runtime_policy.bind(dir.path(), 1).unwrap();
            let fixture = Self { policy, _dir: dir };
            fixture.install("1");
            fixture
        }

        fn install(&self, revision: &str) {
            let snapshot: Snapshot = serde_json::from_value(serde_json::json!({
                "v": 2, "revision": revision, "members": [
                    {"userId":"explicit", "role":"manager", "canApprove":true, "writeSource":"explicit"},
                    {"userId":"everyone", "role":"driver", "canApprove":false, "writeSource":"everyone"}
                ]
            })).unwrap();
            self.policy.install_v2(snapshot).unwrap();
        }

        fn permit(&self, actor: &str, action: Action) -> Permit {
            Permit::new(self.policy.clone(), actor, self.policy.runtime_policy.stamp(actor), action)
        }

        fn sender(&self, action: RequiredAction) -> SenderAuthority {
            let native = match action { RequiredAction::Drive => Action::Drive, RequiredAction::Configure => Action::Configure, RequiredAction::Approve => Action::Approve };
            SenderAuthority::capture(Some(self.permit("explicit", native)), action, None, None, None)
        }
    }

    fn association(token: &Arc<()>) -> ProviderBinding {
        ProviderBinding { session: "session".into(), tab: "tab".into(),
            association: AssociationFence::Associated(Arc::downgrade(token)), incarnation: Arc::new(()) }
    }

    fn local() -> SenderAuthority { SenderAuthority::capture(None, RequiredAction::Drive, None, None, None) }
    fn prompt(seq: u64) -> Correlation { Correlation::Prompt { seq, request: format!("adapter-{seq}") } }
    fn operation(sender: SenderAuthority, binding: &ProviderBinding, seq: u64) -> OperationContext {
        OperationContext::new(sender, RequiredAction::Drive, binding.clone(), prompt(seq))
    }

    fn dispatch(context: &OperationContext, binding: &ProviderBinding, writes: &AtomicUsize) -> Attempt {
        context.try_dispatch(binding, context.correlation(), None, |sender| {
            ensure!(sender.mobile.is_none() && sender.local_share.is_none(), "missing sender gates");
            Ok(())
        }, || { writes.fetch_add(1, Ordering::SeqCst); Ok(()) }).unwrap()
    }

    #[test]
    fn provider_authority_queue_originals_survive_unrelated_callback_tls() {
        let a = Policy::new();
        let c = Policy::new();
        let token = Arc::new(());
        let binding = association(&token);
        let mut queue = QueueCarriers::default();
        let ids = [queue.insert(1, operation(a.sender(RequiredAction::Drive), &binding, 1)),
            queue.insert(2, operation(local(), &binding, 2)),
            queue.insert(3, operation(c.sender(RequiredAction::Drive), &binding, 3))];
        a.install("2");
        let writes = AtomicUsize::new(0);
        // This actual dequeue/dispatch occurs inside an unrelated remote TLS
        // scope. In particular Local B cannot inherit Everyone from callback C.
        let unrelated = c.permit("everyone", Action::Drive);
        unrelated.with(|| {
            for (index, expected) in [Attempt::Withdrawn, Attempt::Applied, Attempt::Applied].into_iter().enumerate() {
                let context = queue.take(index as u64 + 1, &ids[index], None, binding.clone());
                assert_eq!(dispatch(&context, &binding, &writes), expected);
                if index == 1 { assert!(!context.sender().is_remote()); }
            }
        });
        assert_eq!(writes.load(Ordering::SeqCst), 2);
        assert!(queue.0.is_empty());
    }

    #[test]
    fn provider_authority_serialized_requirement_withdraws_without_native_sidecar() {
        use super::super::{PendingMessage, QueuedMessage};
        let policy = Policy::new();
        let token = Arc::new(());
        let binding = association(&token);
        for remote in [true, false] {
            let mut queue = QueueCarriers::default();
            let sender = if remote { policy.sender(RequiredAction::Drive) } else { local() };
            let id = queue.insert(7, operation(sender, &binding, 7));
            let pending = PendingMessage { message: QueuedMessage { id, text: "queued".into(), images: vec![] }, privacy: None, seq: 7 };
            let mut encoded = serde_json::to_value(&pending).unwrap();
            assert_eq!(encoded["provider_authority"], if remote { "needsOriginalCarrier" } else { "local" });
            // Even a conflicting downgraded field cannot erase the ID fence.
            if remote { encoded["provider_authority"] = serde_json::json!("local"); }
            let restored: PendingMessage = serde_json::from_value(encoded).unwrap();
            let mut empty_native = QueueCarriers::default();
            let context = empty_native.take(restored.seq, &restored.message.id, restored.privacy, binding.clone());
            let writes = AtomicUsize::new(0);
            assert_eq!(dispatch(&context, &binding, &writes), if remote { Attempt::Withdrawn } else { Attempt::Applied });
            assert_eq!(writes.load(Ordering::SeqCst), usize::from(!remote));
        }
        // Historical native/v1 literal layout still restores without a new
        // blanket rejection or a native permit synthesized from JSON.
        let restored: PendingMessage = serde_json::from_value(serde_json::json!({"id":"legacy", "text":"v1"})).unwrap();
        let mut queue = QueueCarriers::default();
        let context = queue.take(restored.seq, &restored.message.id, restored.privacy, binding.clone());
        assert_eq!(dispatch(&context, &binding, &AtomicUsize::new(0)), Attempt::Applied);
    }

    #[test]
    fn provider_authority_prewrite_barrier_rechecks_revision_generation_attachment_and_association() {
        for change in ["revision", "generation", "attachment", "association", "incarnation"] {
            let policy = Policy::new();
            let token = Arc::new(());
            let binding = association(&token);
            let (peer, _notifications) = crate::remote::server::Peer::for_user("original".into(), crate::remote::protocol::Authority::Manage, Some("explicit".into()));
            let permit = Permit::new(policy.policy.clone(), "explicit", policy.policy.runtime_policy.stamp_for_peer("explicit", &peer), Action::Drive).for_peer(&peer);
            let context = operation(SenderAuthority::capture(Some(permit), RequiredAction::Drive, None, None, None), &binding, 1);
            let writes = Arc::new(AtomicUsize::new(0));
            let (paused, waiting) = std::sync::mpsc::channel();
            let (resume, resumed) = std::sync::mpsc::channel();
            let sent = context.clone();
            let recording = writes.clone();
            let worker = std::thread::spawn(move || {
                paused.send(()).unwrap();
                let current = resumed.recv().unwrap();
                dispatch(&sent, &current, &recording)
            });
            waiting.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
            let mut current = binding.clone();
            let replacement_token = Arc::new(());
            match change {
                "revision" => policy.install("2"),
                "generation" => policy.policy.runtime_policy.set_generation(2),
                "attachment" => drop(peer),
                "association" => current = association(&replacement_token),
                "incarnation" => current.incarnation = Arc::new(()),
                _ => unreachable!(),
            }
            // A same-user new peer is not the original attachment.
            let (_new_peer, _new_notifications) = crate::remote::server::Peer::for_user("replacement".into(), crate::remote::protocol::Authority::Manage, Some("explicit".into()));
            resume.send(current).unwrap();
            assert_eq!(worker.join().unwrap(), Attempt::Withdrawn, "{change}");
            assert_eq!(writes.load(Ordering::SeqCst), 0, "{change}");
            assert_eq!(dispatch(&context, &binding, &writes), Attempt::Withdrawn);
        }
    }

    #[test]
    fn provider_authority_old_association_callback_cannot_settle_replacement() {
        let old_token = Arc::new(());
        let new_token = Arc::new(());
        let old_binding = association(&old_token);
        let new_binding = association(&new_token);
        let old = operation(local(), &old_binding, 1);
        let new = operation(local(), &new_binding, 1); // same sequence/provider ID is insufficient
        let writes = AtomicUsize::new(0);
        assert_eq!(dispatch(&old, &old_binding, &writes), Attempt::Applied);
        assert_eq!(dispatch(&new, &new_binding, &writes), Attempt::Applied);
        let callbacks = AtomicUsize::new(0);
        let apply = |context: &OperationContext| context.try_callback(&new_binding, context.correlation(), None, |_| Ok(()), || {
            callbacks.fetch_add(1, Ordering::SeqCst); Ok(())
        }).unwrap();
        assert_eq!(apply(&old), Attempt::Withdrawn);
        assert_eq!(apply(&new), Attempt::Applied);
        assert_eq!(apply(&new), Attempt::Withdrawn);
        assert_eq!(callbacks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn provider_authority_cancelled_opening_cannot_spawn_and_local_successor_proceeds() {
        let policy = Policy::new();
        let token = Arc::new(());
        let binding = association(&token);
        let parent = operation(policy.sender(RequiredAction::Drive), &binding, 1);
        let writes = AtomicUsize::new(0);
        assert_eq!(dispatch(&parent, &binding, &writes), Attempt::Applied);
        let child = parent.derive_follow_on(Correlation::Opening { request: "new".into(), parent_operation: parent.id.clone() }).unwrap();
        parent.withdraw();
        parent.withdraw();
        assert!(parent.derive_follow_on(prompt(2)).is_err());
        assert_eq!(dispatch(&child, &binding, &writes), Attempt::Withdrawn);
        let callback = parent.try_callback(&binding, parent.correlation(), None, |_| Ok(()), || panic!("cancelled callback dispatched fallback")).unwrap();
        assert_eq!(callback, Attempt::Withdrawn);
        assert_eq!(dispatch(&operation(local(), &binding, 3), &binding, &writes), Attempt::Applied);
        assert_eq!(writes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn provider_authority_setting_ack_requires_original_permit_and_exact_request() {
        let policy = Policy::new();
        let token = Arc::new(());
        let binding = association(&token);
        let old_permit = policy.permit("explicit", Action::Configure);
        let mut settings = Settings { model: "base".into(), permission_mode: "plan".into(), ..Default::default() };
        settings.request_model_explicit("same", true, Some(&old_permit), None);
        let old_id = settings.collaboration_requests()["model"].clone();
        let setting = |id: &str| Correlation::Setting { setting: "model".into(), request_id: id.into(), adapter_request: "same-provider-id".into() };
        let old = OperationContext::new(policy.sender(RequiredAction::Configure), RequiredAction::Configure, binding.clone(), setting(&old_id));
        let writes = AtomicUsize::new(0);
        assert_eq!(dispatch(&old, &binding, &writes), Attempt::Applied);
        policy.install("2");
        let new_permit = policy.permit("explicit", Action::Configure);
        settings.request_model_explicit("same", true, Some(&new_permit), None);
        let new_id = settings.collaboration_requests()["model"].clone();
        assert_ne!(old_id, new_id);
        // Explicit Local remains Local even inside an unrelated remote callback.
        new_permit.with(|| settings.request_mode_explicit("auto", true, None, None));
        assert!(!settings.collaboration_requests().contains_key("mode"));
        let new = OperationContext::new(policy.sender(RequiredAction::Configure), RequiredAction::Configure, binding.clone(), setting(&new_id));
        assert_eq!(dispatch(&new, &binding, &writes), Attempt::Applied);
        assert_eq!(old.try_callback(&binding, &setting(&old_id), None, |_| Ok(()), || {
            settings.settle_provider_request("model", &old_id); Ok(())
        }).unwrap(), Attempt::Withdrawn);
        assert_eq!(settings.collaboration_requests()["model"], new_id);
        assert_eq!(settings.requested_permission_mode.as_deref(), Some("auto"));
        assert!(!settings.settle_provider_request("model", &old_id));
        assert_eq!(new.try_callback(&binding, &setting(&new_id), None, |_| Ok(()), || {
            assert!(settings.settle_provider_request("model", &new_id)); Ok(())
        }).unwrap(), Attempt::Applied);
        assert!(settings.requested_model.is_none());
        assert_eq!(settings.model, "same");
        assert_eq!(settings.requested_permission_mode.as_deref(), Some("auto"));
        assert_eq!(new.try_callback(&binding, &setting(&new_id), None, |_| Ok(()), || panic!("duplicate settlement")).unwrap(), Attempt::Withdrawn);
    }

    #[test]
    fn provider_authority_explicit_association_does_not_upgrade_everyone_or_action() {
        let policy = Policy::new();
        let token = Arc::new(());
        let binding = association(&token); // admitted association, no owned/safe-mode assertion
        let writes = AtomicUsize::new(0);
        let explicit = operation(policy.sender(RequiredAction::Drive), &binding, 1);
        assert_eq!(dispatch(&explicit, &binding, &writes), Attempt::Applied);
        let everyone = operation(SenderAuthority::capture(Some(policy.permit("everyone", Action::Drive)), RequiredAction::Drive, None, None, None), &binding, 2);
        assert_eq!(dispatch(&everyone, &binding, &writes), Attempt::Withdrawn);
        let broadened = OperationContext::new(policy.sender(RequiredAction::Drive), RequiredAction::Configure, binding.clone(), prompt(3));
        assert_eq!(dispatch(&broadened, &binding, &writes), Attempt::Withdrawn);
        let approval = OperationContext::new(policy.sender(RequiredAction::Approve), RequiredAction::Approve, binding.clone(),
            Correlation::Approval { ask_id: "ask".into(), provider_request: "request".into(), attempt: "allow-1".into() });
        assert_eq!(dispatch(&approval, &binding, &writes), Attempt::Applied);
        let changed = Arc::new(());
        let new_binding = association(&changed);
        assert_eq!(dispatch(&operation(policy.sender(RequiredAction::Drive), &binding, 4), &new_binding, &writes), Attempt::Withdrawn);
        assert_eq!(writes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn provider_authority_callback_defers_policy_contention_without_holding_runtime_wait() {
        let policy = Policy::new();
        let token = Arc::new(());
        let binding = association(&token);
        let context = operation(policy.sender(RequiredAction::Drive), &binding, 1);
        let writes = AtomicUsize::new(0);
        assert_eq!(dispatch(&context, &binding, &writes), Attempt::Applied);
        let runtime = Arc::new(Mutex::new(()));
        let policy_owner = policy.policy.clone();
        let worker_runtime = runtime.clone();
        let (locked, waiting) = std::sync::mpsc::channel();
        let (finish, finished) = std::sync::mpsc::channel();
        let held_runtime = runtime.lock().unwrap();
        let worker = std::thread::spawn(move || {
            let _policy = policy_owner.enter_admission();
            locked.send(()).unwrap();
            let _runtime = worker_runtime.lock().unwrap();
            policy_owner.runtime_policy.set_generation(2);
            finish.send(()).unwrap();
        });
        waiting.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        assert_eq!(context.try_callback(&binding, context.correlation(), None, |_| Ok(()), || panic!("mutation under contention")).unwrap(), Attempt::Deferred);
        drop(held_runtime);
        finished.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert_eq!(context.try_callback(&binding, context.correlation(), None, |_| Ok(()), || panic!("revoked after deferral")).unwrap(), Attempt::Withdrawn);
        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn provider_authority_unknown_dispatch_and_queue_cancel_are_never_replayed() {
        let token = Arc::new(());
        let binding = association(&token);
        let context = operation(local(), &binding, 1);
        let clone = context.clone();
        let writes = AtomicUsize::new(0);
        assert!(context.try_dispatch(&binding, context.correlation(), None, |_| Ok(()), || {
            writes.fetch_add(1, Ordering::SeqCst); bail!("uncertain transport outcome")
        }).is_err());
        assert_eq!(dispatch(&clone, &binding, &writes), Attempt::Withdrawn);
        assert!(clone.derive_follow_on(prompt(2)).is_err());
        let policy = Policy::new();
        let mut queue = QueueCarriers::default();
        let queued = operation(policy.sender(RequiredAction::Drive), &binding, 3);
        let callback_clone = queued.clone();
        let id = queue.insert(3, queued);
        queue.cancel(3, &id);
        queue.cancel(3, &id);
        assert_eq!(dispatch(&callback_clone, &binding, &writes), Attempt::Withdrawn);
        assert_eq!(dispatch(&queue.take(3, &id, None, binding.clone()), &binding, &writes), Attempt::Withdrawn);
        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
mod independent_constraint_tests {
    use super::*;

    #[test]
    fn provider_authority_local_preserves_independent_privacy_and_local_share_constraint() {
        let token = Arc::new(());
        let binding = ProviderBinding { session: "session".into(), tab: "tab".into(),
            association: AssociationFence::Associated(Arc::downgrade(&token)), incarnation: Arc::new(()) };
        for share in [false, true] {
            let sender = if share {
                SenderAuthority::capture(None, RequiredAction::Drive, None, None, Some(crate::local_sharing::WritePermit {
                    privacy: crate::data_privacy::Ticket::denied(), share_generation: "original".into(), connection_id: "original".into(), revision: 1, tab_epoch: 1,
                }))
            } else { SenderAuthority::capture(None, RequiredAction::Drive, Some(crate::data_privacy::Ticket::denied()), None, None) };
            let context = OperationContext::new(sender, RequiredAction::Drive, binding.clone(), Correlation::Control { request: "local".into(), kind: "control".into() });
            assert_eq!(context.try_dispatch(&binding, context.correlation(), None, |_| Ok(()), || panic!("independent privacy constraint was dropped")).unwrap(), Attempt::Withdrawn);
        }
    }

    #[test]
    fn provider_authority_wrong_approval_attempt_does_not_consume_new_deny() {
        let token = Arc::new(());
        let binding = ProviderBinding { session: "session".into(), tab: "tab".into(),
            association: AssociationFence::Associated(Arc::downgrade(&token)), incarnation: Arc::new(()) };
        let correlation = |attempt: &str| Correlation::Approval { ask_id: "same-ask".into(), provider_request: "same-request".into(), attempt: attempt.into() };
        let context = OperationContext::new(SenderAuthority::capture(None, RequiredAction::Approve, None, None, None), RequiredAction::Approve, binding.clone(), correlation("deny-2"));
        assert_eq!(context.try_dispatch(&binding, context.correlation(), None, |_| Ok(()), || Ok(())).unwrap(), Attempt::Applied);
        assert_eq!(context.try_callback(&binding, &correlation("allow-1"), None, |_| Ok(()), || panic!("old allow consumed new deny")).unwrap(), Attempt::Withdrawn);
        assert_eq!(context.try_callback(&binding, &correlation("deny-2"), None, |_| Ok(()), || Ok(())).unwrap(), Attempt::Applied);
    }
}

#[cfg(test)]
mod continuation_tests {
    use super::*;

    #[test]
    fn provider_authority_callback_derives_original_follow_on_once_without_reentrant_lock() {
        let token = Arc::new(());
        let binding = ProviderBinding { session: "session".into(), tab: "tab".into(),
            association: AssociationFence::Associated(Arc::downgrade(&token)), incarnation: Arc::new(()) };
        let context = OperationContext::new(SenderAuthority::capture(None, RequiredAction::Drive, None, None, None),
            RequiredAction::Drive, binding.clone(), Correlation::Opening { request: "opening".into(), parent_operation: "ingress".into() });
        assert_eq!(context.try_dispatch(&binding, context.correlation(), None, |_| Ok(()), || Ok(())).unwrap(), Attempt::Applied);
        let mut child = None;
        assert_eq!(context.try_callback(&binding, context.correlation(), None, |_| Ok(()), || {
            child = Some(context.derive_follow_on(Correlation::Prompt { seq: 2, request: "prompt".into() })?);
            Ok(())
        }).unwrap(), Attempt::Applied);
        assert!(context.derive_follow_on(Correlation::Prompt { seq: 3, request: "duplicate".into() }).is_err());
        let child = child.unwrap();
        assert_eq!(child.try_dispatch(&binding, child.correlation(), None, |_| Ok(()), || Ok(())).unwrap(), Attempt::Applied);
        assert_eq!(context.try_callback(&binding, context.correlation(), None, |_| Ok(()), || panic!("duplicate callback derived twice")).unwrap(), Attempt::Withdrawn);
    }
}
