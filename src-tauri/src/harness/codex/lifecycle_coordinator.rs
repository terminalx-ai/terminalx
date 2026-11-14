//! Process-local dormant delivery boundary. One Domain per private journal
//! namespace; adoption fences old logical streams, NOT physical providers or
//! independent processes. No live constructor, EventSink or user callbacks.
//! Lock order: domain -> coordinator -> transport -> bridge -> journal.
//! Receipts leave ALL those gates before release/wake. Only Ready whole batches
//! enter the delivered prefix; subscriber installation and snapshot share its
//! gate. Returned data is historical evidence tagged with an opaque stream,
//! never a lease proving that the persisted backend is still current.

use super::*;
use std::collections::{HashMap, VecDeque};
use std::sync::{mpsc, Condvar};
use std::time::Duration;
use crate::harness::host::Sink;
use super::super::owned_transport::{BoundSink, OwnedTransport, Status};
use crate::store::batch_journal::DeliveryState;

const CAPACITY: usize = 64;

/// Opaque in-process capability. Arc identity prevents ABA or cross-domain
/// aliasing even when backend numbers match. Not a serializable wire token.
#[derive(Clone)]
pub(crate) struct Stream { identity: Arc<()>, pub backend: u64, namespace: Option<std::path::PathBuf> }
impl Stream {
    /// Compare with the reader's adopted token when handling queued data.
    /// Equality is logical stream identity, never a physical ownership lease.
    pub fn matches(&self, other: &Self) -> bool {
        self.backend == other.backend && Arc::ptr_eq(&self.identity, &other.identity)
    }
}
#[derive(Clone)]
pub(crate) struct WakeToken(Arc<()>);
#[derive(Default)]
struct Wake { token: Mutex<Arc<()>>, changed: Condvar }
impl Wake {
    fn signal(&self) {
        if let Ok(mut token) = self.token.lock() {
            *token = Arc::new(());
            self.changed.notify_all();
        }
    }
}
/// Shared explicitly by replacement coordinators for ONE journal namespace.
/// Retain this domain across owner adoption; a fresh domain is not a migration.
#[derive(Clone, Default)]
pub(crate) struct Domain { current: Arc<Mutex<Option<Stream>>>, wake: Arc<Wake> }
impl Domain {
    pub fn wake_token(&self) -> Result<WakeToken> {
        Ok(WakeToken(self.wake.token.lock().map_err(|_| anyhow::anyhow!("wake poisoned"))?.clone()))
    }
    /// Capture token BEFORE polling, then wait. Release updates the predicate
    /// before notifying, so a consumer which saw Pending cannot lose the wake.
    /// No transport/bridge/domain/coordinator gate is held while waiting.
    pub fn wait_after(&self, token: &WakeToken, timeout: Duration) -> Result<WakeToken> {
        let guard = self.wake.token.lock().map_err(|_| anyhow::anyhow!("wake poisoned"))?;
        let (guard, _) = self.wake.changed.wait_timeout_while(guard, timeout,
            |current| Arc::ptr_eq(current, &token.0)).map_err(|_| anyhow::anyhow!("wake poisoned"))?;
        Ok(WakeToken(guard.clone()))
    }
}
struct Buffer { next: u64, frames: VecDeque<Frame>, resync: bool }
struct Delivery {
    transport: OwnedTransport, bridge: TypedAdmission,
    receiver: mpsc::Receiver<PendingBatch<Envelope>>, pending: VecDeque<PendingBatch<Envelope>>,
    projection: Projection, subscribers: HashMap<u64, Buffer>, next_subscriber: u64, degraded: bool,
}
impl Delivery {
    fn fail(&mut self) {
        self.degraded = true;
        for buffer in self.subscribers.values_mut() { buffer.frames.clear(); buffer.resync = true; }
        if let Ok(mut s) = self.bridge.0.lock() {
            s.degraded = true;
            let scopes: Vec<_> = s.projection.bindings.iter().map(|b| b.scope.clone()).collect();
            for scope in scopes { if !s.affected.contains(&scope) { s.affected.push(scope); } }
        }
    }
    fn pump(&mut self) -> Result<()> {
        if self.degraded { bail!("delivery requires resync"); }
        // Checks persisted ownership at this read only, never a lifetime lease.
        let healthy = {
            let mut s = self.bridge.0.lock().map_err(|_| anyhow::anyhow!("bridge poisoned"))?;
            !s.degraded && s.journal.snapshot().is_ok()
        };
        if !healthy { bail!("admission continuity lost"); }
        loop {
            match self.receiver.try_recv() {
                Ok(ticket) => {
                    if self.pending.len() == CAPACITY { bail!("pending delivery overflow"); }
                    self.pending.push_back(ticket);
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => bail!("admission queue closed"),
            }
        }
        while let Some(ticket) = self.pending.front() {
            match ticket.state() {
                DeliveryState::Pending => break, // keep ordering; finish signals again
                DeliveryState::Abandoned => bail!("accepted delivery lost"),
                DeliveryState::Ready => {}
            }
            let batch = ticket.receipt().ok_or_else(|| anyhow::anyhow!("delivery unavailable"))?;
            if batch.backend_generation != self.projection.backend { bail!("delivery owner mismatch"); }
            let mut next = self.projection.clone();
            next.apply(batch)?; // exact next sequence; a gap is never skipped
            let frame = next.frames.last().unwrap().clone();
            self.projection = next;
            self.pending.pop_front();
            for buffer in self.subscribers.values_mut() {
                if buffer.resync { continue; }
                if frame.watermark != buffer.next || buffer.frames.len() == CAPACITY {
                    buffer.frames.clear(); buffer.resync = true;
                } else {
                    buffer.next += 1; // projection already enforces JS-safe sequence
                    buffer.frames.push_back(frame.clone());
                }
            }
        }
        Ok(())
    }
    fn pump_or_degrade(&mut self) {
        if self.pump().is_err() { self.fail(); }
    }
}
#[derive(Clone)]
pub(crate) struct Coordinator { domain: Domain, stream: Stream, delivery: Arc<Mutex<Delivery>> }
pub(crate) struct CoordinatedSink { coordinator: Coordinator, inner: Arc<BoundSink> }
pub(crate) struct Subscription { coordinator: Coordinator, id: u64 }
pub(crate) struct Installed {
    pub stream: Stream, pub watermark: u64, pub frames: Vec<Frame>, pub subscription: Subscription,
}
pub(crate) enum Update {
    /// Whole later batches, never a current-owner assertion. Consumer must
    /// discard data from any stream other than its explicitly adopted token.
    Frames { stream: Stream, frames: Vec<Frame> },
    Resync,
}
pub(crate) enum OwnerOpen { Create, Restart }
impl Coordinator {
    /// Dormant physical backend-lease entry point. Never call for a viewer
    /// reconnect. A retained sink/subscription prevents a replacement owner.
    pub fn open_owned(domain: Domain, path: &std::path::Path, mode: OwnerOpen) -> Result<Self> {
        let journal = match mode {
            OwnerOpen::Create => Journal::create_owned(path)?,
            OwnerOpen::Restart => Journal::begin_owned(path)?,
        };
        Self::adopt(domain, journal)
    }

    /// Explicit process-local adoption after caller obtained a fresh persisted
    /// owner handle. Does not begin a journal or spawn/stop/migrate a provider.
    pub fn adopt(domain: Domain, journal: Journal<Envelope>) -> Result<Self> {
        let namespace = journal.owned_namespace().map(std::path::Path::to_path_buf);
        let (tx, rx) = mpsc::sync_channel(CAPACITY);
        let bridge = TypedAdmission::new(journal, tx)?;
        let projection = bridge.0.lock().map_err(|_| anyhow::anyhow!("bridge poisoned"))?.projection.clone();
        let stream = Stream { identity: Arc::new(()), backend: projection.backend, namespace };
        let coordinator = Self { domain, stream, delivery: Arc::new(Mutex::new(Delivery {
            transport: OwnedTransport::new(bridge.clone()), bridge, receiver: rx, pending: VecDeque::new(),
            projection, subscribers: HashMap::new(), next_subscriber: 0, degraded: false,
        })) };
        // Domain gate serializes adoption against every operation/install/poll.
        {
            let mut current = coordinator.domain.current.lock().map_err(|_| anyhow::anyhow!("domain poisoned"))?;
            if current.as_ref().is_some_and(|old| old.backend >= coordinator.stream.backend) {
                bail!("nonmonotonic backend adoption");
            }
            if current.as_ref().is_some_and(|old| old.namespace != coordinator.stream.namespace) {
                bail!("delivery domain journal namespace changed");
            }
            *current = Some(coordinator.stream.clone());
        }
        coordinator.domain.wake.signal();
        Ok(coordinator)
    }
    fn current(&self, current: &Option<Stream>) -> bool {
        current.as_ref().is_some_and(|s| s.matches(&self.stream))
    }
    // Private closures are fixed source operations below, never user handlers.
    // Collect receipts before dropping gates so another callback cannot steal
    // a receipt whose originating transport gate has not yet exited.
    fn perform<R>(&self, action: impl FnOnce(&mut Delivery) -> R) -> Result<(R, Vec<Accepted<Envelope>>)> {
        let current = self.domain.current.lock().map_err(|_| anyhow::anyhow!("domain poisoned"))?;
        if !self.current(&current) { bail!("stream superseded"); }
        let mut d = self.delivery.lock().map_err(|_| anyhow::anyhow!("coordinator poisoned"))?;
        d.pump_or_degrade();
        if d.degraded { bail!("delivery requires resync"); }
        let result = action(&mut d); // transport call returns before receipt transfer
        let receipts = d.bridge.take_receipts()?;
        Ok((result, receipts)) // all guards drop before finish can run
    }
    fn finish(&self, receipts: Vec<Accepted<Envelope>>) {
        for receipt in receipts { receipt.release_delivery(); }
        // Wake even when loss/abandonment needs resync instead of Ready data.
        self.domain.wake.signal();
        if let Ok(current) = self.domain.current.lock() {
            if self.current(&current) {
                if let Ok(mut d) = self.delivery.lock() { d.pump_or_degrade(); }
            }
        }
    }
    pub fn bind(&self, scope: Scope) -> Result<CoordinatedSink> {
        let (sink, receipts) = match self.perform(|d| d.transport.bind(scope)) {
            Ok(result) => result,
            Err(error) => { self.domain.wake.signal(); return Err(error); }
        };
        self.finish(receipts);
        Ok(CoordinatedSink { coordinator: self.clone(), inner: sink.map_err(anyhow::Error::msg)? })
    }
    pub fn subscribe(&self) -> Result<Installed> {
        let current = self.domain.current.lock().map_err(|_| anyhow::anyhow!("domain poisoned"))?;
        if !self.current(&current) { bail!("stream superseded"); }
        let mut d = self.delivery.lock().map_err(|_| anyhow::anyhow!("coordinator poisoned"))?;
        d.pump_or_degrade();
        if d.degraded || d.subscribers.len() == CAPACITY { bail!("subscription unavailable; resync required"); }
        let id = d.next_subscriber.checked_add(1).ok_or_else(|| anyhow::anyhow!("subscriber identity exhausted"))?;
        d.next_subscriber = id;
        let watermark = d.projection.watermark;
        // Register before copying snapshot. All later pumps use this same gate;
        // pending/unreleased batches are buffered only when eligible after W.
        d.subscribers.insert(id, Buffer { next: watermark + 1, frames: VecDeque::new(), resync: false });
        Ok(Installed { stream: self.stream.clone(), watermark, frames: d.projection.frames.clone(),
            subscription: Subscription { coordinator: self.clone(), id } })
    }
}
impl CoordinatedSink {
    fn run(&self, action: impl FnOnce(&BoundSink)) {
        if let Ok(((), receipts)) = self.coordinator.perform(|_| action(&self.inner)) {
            self.coordinator.finish(receipts);
        } else { self.coordinator.domain.wake.signal(); }
    }
    pub fn status(&self) -> Status {
        let Ok(current) = self.coordinator.domain.current.lock() else { return Status::Blocked };
        if !self.coordinator.current(&current) { return Status::Superseded; }
        let Ok(d) = self.coordinator.delivery.lock() else { return Status::Blocked };
        if d.degraded { Status::Blocked } else { self.inner.status() }
    }
    pub fn release(&self) { self.run(|sink| { let _ = sink.release(); }); }
}
impl Sink for CoordinatedSink {
    fn stdout_line(&self, line: String) { self.run(|sink| sink.stdout_line(line)); }
    fn stderr_line(&self, _line: String) {} // no diagnostic evidence
    fn exited(&self, pid: u32, code: Option<i32>) { self.run(|sink| sink.exited(pid, code)); }
}
impl Subscription {
    /// Pass the reader's CURRENT adopted token, never a token saved with an old
    /// queued message. Old subscriptions fail closed after domain adoption.
    pub fn poll(&self, adopted: &Stream) -> Update {
        let c = &self.coordinator;
        if !adopted.matches(&c.stream) { return Update::Resync; }
        let Ok(current) = c.domain.current.lock() else { return Update::Resync };
        if !c.current(&current) { return Update::Resync; }
        let Ok(mut d) = c.delivery.lock() else { return Update::Resync };
        d.pump_or_degrade();
        if d.degraded { return Update::Resync; }
        let Some(buffer) = d.subscribers.get_mut(&self.id) else { return Update::Resync };
        if buffer.resync { return Update::Resync; }
        Update::Frames { stream: c.stream.clone(), frames: buffer.frames.drain(..).collect() }
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Ok(mut d) = self.coordinator.delivery.lock() { d.subscribers.remove(&self.id); }
    }
}

#[cfg(test)]
#[path = "lifecycle_coordinator_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "lifecycle_ownership_tests.rs"]
mod ownership_tests;
