//! Transcripts followed across reads (PRO-273): a tab's totals are read again
//! at every turn end, and only what its agent appended since the last read is
//! parsed. Each file keeps its parser's state (requests met so far, Codex's
//! cumulative baseline) and how far it was read. A file that shrank, or whose
//! first bytes changed (a conversation reset rewrites its transcript), is read
//! again from its start.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};

use super::{priced, ClaudeParser, CodexParser, PricedRequest};

/// What a followed file is read for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Use {
    /// Claude's requests; `filtered` when a fork's copied records are left out.
    Claude { filtered: bool },
    Codex,
    /// The uuids a Claude transcript holds: what a fork of it copied.
    Uuids,
}

#[derive(Debug, Clone)]
enum State {
    Claude(ClaudeParser),
    Codex(CodexParser),
    Uuids(HashSet<String>),
}

#[derive(Debug, Clone)]
struct Followed {
    /// Bytes of complete lines read so far. A line still being written is
    /// left for the next read.
    offset: u64,
    /// The file's first bytes when it was first read, to tell a rewrite.
    head: Vec<u8>,
    state: State,
}

const HEAD: usize = 1024;
/// Files kept; past it the oldest reads start again from scratch.
const KEPT: usize = 512;

static FOLLOWED: Mutex<Option<HashMap<(PathBuf, Use), Followed>>> = Mutex::new(None);

fn fresh(path: &Path, purpose: Use) -> State {
    match purpose {
        Use::Claude { .. } => State::Claude(ClaudeParser::new(path)),
        Use::Codex => State::Codex(CodexParser::new(path)),
        Use::Uuids => State::Uuids(HashSet::new()),
    }
}

/// Bring `path`'s state up to date and hand it to `answer`. The state is out
/// of the shared map while the file is read, so other files are not held up.
fn follow<R>(path: &Path, purpose: Use, skip: &HashSet<String>, answer: impl FnOnce(&State) -> R) -> Result<R> {
    let key = (path.to_path_buf(), purpose);
    let held = FOLLOWED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).remove(&key);
    let mut file = File::open(path).with_context(|| format!("open usage transcript {}", path.display()))?;
    let len = file.metadata()?.len();
    let mut head = vec![0; HEAD.min(len as usize)];
    file.read_exact(&mut head)?;
    let mut followed = match held {
        Some(followed) if followed.offset <= len && head.starts_with(&followed.head[..followed.head.len().min(head.len())]) && followed.head.len() <= head.len() => followed,
        _ => Followed { offset: 0, head: head.clone(), state: fresh(path, purpose) },
    };
    // A file first read while shorter than `HEAD` keeps the longer head now.
    if followed.head.len() < head.len() {
        followed.head = head;
    }
    file.seek(SeekFrom::Start(followed.offset))?;
    let mut appended = Vec::new();
    file.take(len - followed.offset).read_to_end(&mut appended)?;
    if let Some(end) = appended.iter().rposition(|byte| *byte == b'\n') {
        for line in appended[..end].split(|byte| *byte == b'\n') {
            let Ok(line) = std::str::from_utf8(line) else { continue };
            let line = line.trim_end_matches('\r');
            match &mut followed.state {
                State::Claude(parser) => parser.line(line, skip),
                State::Codex(parser) => parser.line(line),
                State::Uuids(uuids) => {
                    if line.contains("\"uuid\"") {
                        if let Some(uuid) = serde_json::from_str::<serde_json::Value>(line).ok().and_then(|record| record["uuid"].as_str().map(String::from)) {
                            uuids.insert(uuid);
                        }
                    }
                }
            }
        }
        followed.offset += end as u64 + 1;
    }
    let result = answer(&followed.state);
    let mut map = FOLLOWED.lock().unwrap_or_else(|e| e.into_inner());
    let map = map.get_or_insert_with(HashMap::new);
    if map.len() >= KEPT {
        map.clear();
    }
    map.insert(key, followed);
    Ok(result)
}

/// The requests in a Claude transcript, leaving out records whose uuid is in
/// `skip` (a fork's copy of its parent). `skip` must be the same, or grow,
/// from one read of a file to the next: a fork's copied records come first.
pub(crate) fn claude_requests(path: &Path, skip: &HashSet<String>) -> Result<Vec<PricedRequest>> {
    follow(path, Use::Claude { filtered: !skip.is_empty() }, skip, |state| match state {
        State::Claude(parser) => priced(parser.events.clone()),
        _ => Vec::new(),
    })
}

pub(crate) fn codex_requests(path: &Path) -> Result<Vec<PricedRequest>> {
    follow(path, Use::Codex, &HashSet::new(), |state| match state {
        State::Codex(parser) => priced(parser.events.clone()),
        _ => Vec::new(),
    })
}

/// Every record uuid in a Claude transcript.
pub(crate) fn claude_uuids(path: &Path) -> Result<HashSet<String>> {
    follow(path, Use::Uuids, &HashSet::new(), |state| match state {
        State::Uuids(uuids) => uuids.clone(),
        _ => HashSet::new(),
    })
}

/// How far each followed file has been read, for tests.
#[cfg(test)]
pub(crate) fn offset(path: &Path) -> Option<u64> {
    let map = FOLLOWED.lock().unwrap_or_else(|e| e.into_inner());
    map.as_ref()?.iter().find(|((held, _), _)| held == path).map(|(_, followed)| followed.offset)
}
