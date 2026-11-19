//! What each paired-device connection has verified of a transcript log, so
//! the next `session.sync` page reads only what was appended since (#1283).
//!
//! A `session.sync` cursor is an offset and a hash of every record before it.
//! Checking one meant reading and hashing the whole log, so each page, and
//! each live event's catch-up, cost as much as the whole conversation. The
//! connection now keeps, for each cursor it last returned, the hash state at
//! that offset and where in the file its last record ends. A cursor that
//! matches is continued from there, as long as the file is the one that was
//! read: the same file (inode), no shorter, the bytes just before that point
//! unchanged, and only whole lines after it. Logs grow by appends; one
//! replaced (a new inode), truncated or rewritten under that point is read
//! and hashed whole again, as before.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use sha2::{Digest, Sha256};

use super::rpc::{SyncCursor, SyncedPage};
use crate::events::AgentEvent;

/// The bytes before a verified point compared again before reading on from it.
const FINGERPRINT_BYTES: usize = 4 * 1024;
/// Conversations one connection keeps a checkpoint for; the least recently used goes first.
const ENTRIES: usize = 64;
/// How long a page that said `hasMore` counts as one read under way: its next page skips the reconcile.
const CONTINUATION: Duration = Duration::from_secs(30);

/// A log's records, and where each one's line ends in the file.
pub(super) struct LogRead {
    pub events: Vec<AgentEvent>,
    ends: Vec<u64>,
    /// The file's bytes before the first record read, as far as the fingerprint needs them.
    bytes: Vec<u8>,
    /// Where `bytes` starts in the file.
    base: u64,
    identity: Option<FileIdentity>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity { device: u64, inode: u64 }

#[cfg(unix)]
fn identity(metadata: &std::fs::Metadata) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(FileIdentity { device: metadata.dev(), inode: metadata.ino() })
}

#[cfg(not(unix))]
fn identity(_: &std::fs::Metadata) -> Option<FileIdentity> { None }

/// A cursor this connection returned, and what continuing it needs.
#[derive(Clone)]
pub(super) struct Verified {
    pub offset: usize,
    digest: String,
    pub hash: Sha256,
    /// Where the `offset`th record's line ends; 0 before any record.
    bytes: u64,
    identity: Option<FileIdentity>,
    /// The file's last bytes before `bytes`.
    fingerprint: Vec<u8>,
    /// When the page that ended here said there was more.
    continued: Option<Instant>,
}

impl Verified {
    /// The checkpoint a page read from the whole log ends at.
    pub(super) fn of_log(page: &SyncedPage, log: &LogRead) -> Self {
        let bytes = if page.end == 0 { 0 } else { log.ends[page.end - 1] };
        Self::at(page, bytes, log.identity, fingerprint_of(&log.bytes, log.base, bytes))
    }

    /// The checkpoint a page read on from this one ends at.
    pub(super) fn advance(&self, page: &SyncedPage, tail: &Tail) -> Self {
        let count = page.end - self.offset;
        let bytes = if count == 0 { self.bytes } else { tail.ends[count - 1] };
        // The old fingerprint, then what was read after it, up to the new point.
        let mut seen = self.fingerprint.clone();
        seen.extend_from_slice(&tail.bytes[..(bytes - self.bytes) as usize]);
        let base = self.bytes - self.fingerprint.len() as u64;
        Self::at(page, bytes, self.identity, fingerprint_of(&seen, base, bytes))
    }

    fn at(page: &SyncedPage, bytes: u64, identity: Option<FileIdentity>, fingerprint: Vec<u8>) -> Self {
        Self {
            offset: page.end,
            digest: format!("{:x}", page.hash.clone().finalize()),
            hash: page.hash.clone(),
            bytes, identity, fingerprint,
            continued: page.has_more.then(Instant::now),
        }
    }
}

/// The last `FINGERPRINT_BYTES` before `end`, from `bytes`, which starts at `base` in the file.
fn fingerprint_of(bytes: &[u8], base: u64, end: u64) -> Vec<u8> {
    let end = (end - base) as usize;
    bytes[end.saturating_sub(FINGERPRINT_BYTES)..end].to_vec()
}

/// The records appended after a verified point.
pub(super) struct Tail {
    pub events: Vec<AgentEvent>,
    ends: Vec<u64>,
    /// The file from the verified point on.
    bytes: Vec<u8>,
}

#[derive(Default)]
pub(crate) struct SyncCache {
    entries: Mutex<HashMap<(String, String), (Verified, Instant)>>,
}

impl SyncCache {
    /// The checkpoint `cursor` names, if this connection returned it last for this conversation.
    pub(super) fn matching(&self, session: &str, tab: &str, cursor: &SyncCursor) -> Option<Verified> {
        let mut entries = self.entries.lock().unwrap();
        let (verified, used) = entries.get_mut(&(session.to_string(), tab.to_string()))?;
        if verified.offset != cursor.offset || verified.digest != cursor.digest { return None; }
        *used = Instant::now();
        Some(verified.clone())
    }

    /// Whether `cursor` ends a page that said there was more, a moment ago.
    pub(super) fn continuing(&self, session: &str, tab: &str, cursor: &SyncCursor) -> bool {
        self.entries.lock().unwrap().get(&(session.to_string(), tab.to_string())).is_some_and(|(verified, _)|
            verified.offset == cursor.offset && verified.digest == cursor.digest
                && verified.continued.is_some_and(|at| at.elapsed() < CONTINUATION))
    }

    /// The checkpoint stays, but no read is under way at it.
    pub(super) fn settle(&self, session: &str, tab: &str) {
        if let Some((verified, _)) = self.entries.lock().unwrap().get_mut(&(session.to_string(), tab.to_string())) {
            verified.continued = None;
        }
    }

    pub(super) fn store(&self, session: &str, tab: &str, verified: Verified) {
        let mut entries = self.entries.lock().unwrap();
        entries.insert((session.to_string(), tab.to_string()), (verified, Instant::now()));
        while entries.len() > ENTRIES {
            let Some(oldest) = entries.iter().min_by_key(|(_, (_, used))| *used).map(|(key, _)| key.clone()) else { break };
            entries.remove(&oldest);
        }
    }
}

/// Every record of a log, read as `store::read_lines` reads it: lines that
/// are blank or do not parse are skipped, and a log not there is empty.
pub(super) fn read_log(path: &Path) -> Result<LogRead> {
    let (bytes, identity) = match File::open(path) {
        Ok(mut file) => {
            let identity = identity(&file.metadata()?);
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            (bytes, identity)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
        Err(error) => return Err(error.into()),
    };
    let (events, ends) = parse_lines(std::str::from_utf8(&bytes)?, 0);
    Ok(LogRead { events, ends, bytes, base: 0, identity })
}

/// The records appended after `verified`, or `None` when the log is not the
/// one it was verified against plus whole lines: then it is read whole.
pub(super) fn read_after(path: &Path, verified: &Verified) -> Result<Option<Tail>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if identity(&metadata) != verified.identity || metadata.len() < verified.bytes {
        return Ok(None);
    }
    let from = verified.bytes - verified.fingerprint.len() as u64;
    file.seek(SeekFrom::Start(from))?;
    let mut bytes = Vec::with_capacity((metadata.len() - from) as usize);
    file.take(metadata.len() - from).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != metadata.len() - from || !bytes.starts_with(&verified.fingerprint) {
        return Ok(None);
    }
    let bytes = bytes.split_off(verified.fingerprint.len());
    // A line still being written is read with the whole log, which skips it
    // as it does today, rather than being stepped over here for good.
    if bytes.last().is_some_and(|last| *last != b'\n') {
        return Ok(None);
    }
    let Ok(text) = std::str::from_utf8(&bytes) else { return Ok(None) };
    let (events, ends) = parse_lines(text, verified.bytes);
    Ok(Some(Tail { events, ends, bytes }))
}

/// The records in `text`, and where each one's line ends, counting from `base`.
fn parse_lines(text: &str, base: u64) -> (Vec<AgentEvent>, Vec<u64>) {
    let (mut events, mut ends) = (Vec::new(), Vec::new());
    let mut at = base;
    for line in text.split_inclusive('\n') {
        at += line.len() as u64;
        let line = line.strip_suffix('\n').unwrap_or(line);
        if line.trim().is_empty() { continue; }
        if let Ok(event) = serde_json::from_str::<AgentEvent>(line) {
            events.push(event);
            ends.push(at);
        }
    }
    (events, ends)
}
