//! Dormant, bounded journal for atomic batches and persisted owner generations.
//!
//! Legacy AgentEvent append/read/publication is deliberately unchanged. This
//! primitive uses the real store transaction lock and write_atomic, not the
//! two-write append_line API. Every transaction replaces the bounded file with
//! its exact old bytes plus one complete batch; readers use the same lock.
//! O(file size) commits are intentional and capped. Capacity exhaustion blocks
//! admission; no automatic history deletion, truncation or compaction occurs.
//!
//! A batch can carry old-scope unknown and new-scope bound together. It is the
//! future Admission bridge's job to construct those typed changes, apply them
//! to a snapshot and emit ONLY after commit returns. No subscriber exists here.
//! A new owner durably records its generation before receiving this handle;
//! prior-generation unfinished work must be projected unknown, never resumed.
//!
//! Guarantee: serialized atomic visibility and process-restart recovery on the
//! existing store filesystem, after write_atomic's file sync + rename succeeds.
//! That helper does not fsync the parent directory; power-loss durability and
//! distributed/network-filesystem locking are NOT promised. An error is never
//! permission to emit, even if a filesystem failure has an ambiguous outcome.

use std::fs;
use std::io::Read;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Batch<T> {
    pub version: u32,
    pub sequence: u64,
    pub backend_generation: u64,
    /// Empty only for a new backend-generation barrier. Nonempty changes are
    /// accepted together; an old-unknown/new-bound pair is never split.
    pub changes: Vec<T>,
}

#[derive(Debug)]
pub(crate) struct Snapshot<T> {
    pub watermark: u64,
    pub backend_generation: u64,
    pub batches: Vec<Batch<T>>,
}

pub(crate) struct Journal<T> {
    path: PathBuf,
    backend_generation: u64,
    degraded: bool,
    payload: PhantomData<T>,
}

impl<T: Serialize + DeserializeOwned> Journal<T> {
    /// Only for an explicitly new storage identity. Existing files are never
    /// overwritten; reconnect/restart must use begin, not create-on-error.
    pub fn create(path: &Path) -> Result<Self> { Self::start(path, true) }

    /// Explicit new owner, NOT a UI reconnect/read operation. Paths must belong
    /// to a private store directory; caller owns directory creation and retains
    /// the stable .lock sidecar. Never point this at a legacy AgentEvent log.
    pub fn begin(path: &Path) -> Result<Self> {
        Self::start(path, false)
    }

    fn start(path: &Path, create: bool) -> Result<Self> {
        let generation = super::transaction::run(&path.with_extension("lock"), LOCK_TIMEOUT, || {
            let (bytes, snapshot) = read::<T>(path, create)?;
            if create && snapshot.watermark != 0 { bail!("journal already exists"); }
            let sequence = snapshot.watermark.checked_add(1).context("journal sequence exhausted")?;
            let barrier = Batch::<T> { version: VERSION, sequence, backend_generation: sequence, changes: Vec::new() };
            replace(path, bytes, &barrier)?;
            Ok(sequence)
        })?;
        Ok(Self { path: path.into(), backend_generation: generation, degraded: false, payload: PhantomData })
    }

    pub fn backend_generation(&self) -> u64 { self.backend_generation }

    /// Latches on any commit/read failure, including a newer backend owner.
    /// A reader must stop projecting continuous work when this becomes true.
    /// Only an explicit new begin can recover; there is no automatic retry.
    pub fn is_degraded(&self) -> bool { self.degraded }

    pub fn commit(&mut self, changes: Vec<T>) -> Result<Batch<T>> {
        if self.degraded { bail!("journal continuity is degraded"); }
        let result = super::transaction::run(&self.path.with_extension("lock"), LOCK_TIMEOUT, || {
            if changes.is_empty() { bail!("empty journal change batch"); }
            let (bytes, snapshot) = read::<T>(&self.path, false)?;
            if snapshot.backend_generation != self.backend_generation { bail!("journal owner superseded"); }
            let sequence = snapshot.watermark.checked_add(1).context("journal sequence exhausted")?;
            let batch = Batch { version: VERSION, sequence, backend_generation: self.backend_generation, changes };
            replace(&self.path, bytes, &batch)?;
            Ok(batch) // The only receipt; no receipt on write, sync or rename failure.
        });
        if result.is_err() { self.degraded = true; }
        result
    }

    /// Read and watermark share the commit serialization boundary. This alone
    /// is not a subscribe-buffer/snapshot protocol or a lifecycle projection.
    pub fn snapshot(&mut self) -> Result<Snapshot<T>> {
        if self.degraded { bail!("journal continuity is degraded"); }
        let result = super::transaction::run(&self.path.with_extension("lock"), LOCK_TIMEOUT, || {
            let (_, snapshot) = read::<T>(&self.path, false)?;
            if snapshot.backend_generation != self.backend_generation { bail!("journal owner superseded"); }
            Ok(snapshot)
        });
        if result.is_err() { self.degraded = true; }
        result
    }
}

fn read<T: DeserializeOwned>(path: &Path, allow_missing: bool) -> Result<(Vec<u8>, Snapshot<T>)> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), Snapshot { watermark: 0, backend_generation: 0, batches: Vec::new() }));
        }
        Err(error) => return Err(error).context("open batch journal"),
    };
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES || bytes.last() != Some(&b'\n') {
        bail!("empty, oversized or incomplete batch journal; preserved without repair");
    }
    let mut snapshot = Snapshot { watermark: 0u64, backend_generation: 0u64, batches: Vec::new() };
    for line in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        // Never skip corruption or unknown versions: doing so could reuse a
        // generation or admit half of a scope replacement on recovery.
        let batch: Batch<T> = serde_json::from_slice(line).context("decode batch journal")?;
        let next = snapshot.watermark.checked_add(1).context("journal sequence exhausted")?;
        if batch.version != VERSION || batch.sequence != next { bail!("invalid journal version or sequence"); }
        if batch.changes.is_empty() {
            if batch.backend_generation != batch.sequence { bail!("invalid backend generation barrier"); }
            snapshot.backend_generation = batch.backend_generation;
        } else if snapshot.backend_generation == 0 || batch.backend_generation != snapshot.backend_generation {
            bail!("journal batch has no matching backend generation");
        }
        snapshot.watermark = batch.sequence;
        snapshot.batches.push(batch);
    }
    Ok((bytes, snapshot))
}

fn replace<T: Serialize>(path: &Path, mut bytes: Vec<u8>, batch: &Batch<T>) -> Result<()> {
    let encoded = serde_json::to_vec(batch)?;
    if encoded.len() >= MAX_BYTES || bytes.len() > MAX_BYTES - encoded.len() - 1 {
        bail!("batch journal capacity exhausted; preserved without truncation");
    }
    bytes.extend_from_slice(&encoded);
    bytes.push(b'\n');
    super::write_atomic(path, &bytes)
}

#[cfg(test)]
#[path = "batch_journal_tests.rs"]
mod tests;
