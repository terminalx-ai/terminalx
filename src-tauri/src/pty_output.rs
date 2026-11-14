//! The PTY reader and resize path publish to the same ordered, bounded queue.
//! The resize path must never wait for the emitter: its caller may hold the
//! remote terminal registry which the emitter's event listener needs.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::sync::mpsc::{RecvError, RecvTimeoutError};
use std::time::{Duration, Instant};

use super::OutputSize;

pub(super) const READ_BYTES: usize = 16 * 1024;
const READ_BATCHES: usize = 64;
const MAX_BATCHES: usize = READ_BATCHES * 2;
const MAX_BYTES: usize = READ_BYTES * READ_BATCHES + super::SCROLLBACK_BYTES;
pub(super) type Batch = (Vec<u8>, OutputSize);

#[derive(Default)]
struct Pending {
    batches: VecDeque<Batch>,
    bytes: usize,
    closed: bool,
}

#[derive(Default)]
pub(super) struct OutputQueue {
    pending: Mutex<Pending>,
    data: Condvar,
    room: Condvar,
}

pub(super) struct QueueEnd(Arc<OutputQueue>);
impl Drop for QueueEnd {
    fn drop(&mut self) { self.0.close(); }
}

impl OutputQueue {
    /// Preserve channel disconnect semantics on thread exit, including panic
    /// and failure to start the other end of the pipe.
    pub(super) fn close_on_drop(self: &Arc<Self>) -> QueueEnd { QueueEnd(self.clone()) }

    /// Regular reads wait outside the PTY read lock. Spare capacity is
    /// reserved for a resize to drain the kernel without blocking on events.
    pub(super) fn wait_read_room(&self) -> bool {
        let mut pending = self.pending.lock().unwrap();
        while !pending.closed && (pending.batches.len() >= READ_BATCHES || pending.bytes >= READ_BYTES * READ_BATCHES) {
            pending = self.room.wait(pending).unwrap();
        }
        !pending.closed
    }

    pub(super) fn has_read_room(&self) -> bool {
        let pending = self.pending.lock().unwrap();
        !pending.closed && pending.batches.len() < READ_BATCHES && pending.bytes < READ_BYTES * READ_BATCHES
    }

    /// Called under the shared read lock, before consuming any kernel bytes
    /// or changing the PTY size. The emitter can only make more room meanwhile.
    pub(super) fn can_resize(&self, bytes: usize) -> bool {
        let pending = self.pending.lock().unwrap();
        !pending.closed
            && pending.bytes.saturating_add(bytes) <= MAX_BYTES
            && pending.batches.len().saturating_add(bytes.div_ceil(READ_BYTES)).saturating_add(1) <= MAX_BATCHES
    }

    /// Producers hold the read lock; this never waits for queue capacity.
    pub(super) fn send(&self, batch: Batch) -> bool {
        let mut pending = self.pending.lock().unwrap();
        if pending.closed { return false; }
        pending.bytes += batch.0.len();
        pending.batches.push_back(batch);
        self.data.notify_one();
        true
    }

    fn take(&self, pending: &mut Pending) -> Option<Batch> {
        let batch = pending.batches.pop_front()?;
        pending.bytes -= batch.0.len();
        self.room.notify_one();
        Some(batch)
    }

    pub(super) fn recv(&self) -> Result<Batch, RecvError> {
        let mut pending = self.pending.lock().unwrap();
        loop {
            if let Some(batch) = self.take(&mut pending) { return Ok(batch); }
            if pending.closed { return Err(RecvError); }
            pending = self.data.wait(pending).unwrap();
        }
    }

    pub(super) fn recv_timeout(&self, timeout: Duration) -> Result<Batch, RecvTimeoutError> {
        let deadline = Instant::now() + timeout;
        let mut pending = self.pending.lock().unwrap();
        loop {
            if let Some(batch) = self.take(&mut pending) { return Ok(batch); }
            if pending.closed { return Err(RecvTimeoutError::Disconnected); }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { return Err(RecvTimeoutError::Timeout); }
            pending = self.data.wait_timeout(pending, left).unwrap().0;
        }
    }

    pub(super) fn close(&self) {
        self.pending.lock().unwrap().closed = true;
        self.data.notify_all();
        self.room.notify_all();
    }
}
