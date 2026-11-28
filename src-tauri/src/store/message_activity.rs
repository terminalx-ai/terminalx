//! Message chronology, separate from mutable session metadata. The sidecar holds
//! message presence, verified times and scan progress, never message contents.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::index::{self, SessionEntry};
use crate::events::{AgentEvent, Delta, Payload};
use crate::sink::EventSink;
use anyhow::Result;
use serde::{Deserialize, Serialize};

static SCANNING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
const FIELD: &str = "lastMessageAt";
const PRESENCE_FIELD: &str = "hasMessages";
const BATCH: usize = 128;
// Yield after this many bytes, at a record boundary (never split a message).
const BATCH_BYTES: u64 = 256 * 1024;
const FLUSH_DEBOUNCE: Duration = Duration::from_millis(500);
const MAX_CACHE_ENTRIES: usize = 256;

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    last_message_at: Option<String>,
    tabs: BTreeMap<String, TabActivity>,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabActivity {
    #[serde(default)]
    log_file: Option<String>,
    last_message_at: Option<String>,
    #[serde(default)]
    has_messages: bool,
    // Old sidecars may have scanned the entire log without tracking presence.
    #[serde(default)]
    presence_scanned: bool,
    live: Flow,
    history: Flow,
    offset: u64,
}
#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
struct Flow {
    assistant: bool,
}

struct CachedActivity {
    activity: Activity,
    disk_stamp: Option<super::FileStamp>,
    dirty: bool,
    dirty_since: Option<Instant>,
    generation: u64,
    last_used: u64,
}

#[derive(Default)]
struct ActivityCache {
    tick: u64,
    entries: HashMap<PathBuf, CachedActivity>,
}

impl ActivityCache {
    fn next_tick(&mut self) -> u64 {
        self.tick = self.tick.wrapping_add(1);
        self.tick
    }

    fn evict_if_needed(&mut self, incoming: &Path) {
        if self.entries.contains_key(incoming) || self.entries.len() < MAX_CACHE_ENTRIES {
            return;
        }
        if let Some(oldest) = self
            .entries
            .iter()
            .filter(|(_, entry)| !entry.dirty)
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(path, _)| path.clone())
        {
            self.entries.remove(&oldest);
        }
    }
}

static CACHE: LazyLock<Mutex<ActivityCache>> = LazyLock::new(Default::default);
static FLUSH_NOTIFY: LazyLock<(Mutex<u64>, Condvar)> =
    LazyLock::new(|| (Mutex::new(0), Condvar::new()));
static FLUSHER: OnceLock<()> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static TEST_DISK_READS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn read_disk_activity(sidecar: &Path) -> Result<(Activity, Option<super::FileStamp>)> {
    #[cfg(test)]
    TEST_DISK_READS.with(|count| count.set(count.get() + 1));
    let stamp = super::file_stamp(sidecar)?;
    let activity = match stamp {
        Some(_) => super::read_json(sidecar)?.unwrap_or_default(),
        None => Activity::default(),
    };
    Ok((activity, stamp))
}

/// Read a session's activity from the in-memory cache, refreshing from disk
/// only on a cold miss or when the on-disk file changed externally.
fn read_cached(sidecar: &Path) -> Result<Activity> {
    let cached = {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let tick = cache.next_tick();
        if let Some(entry) = cache.entries.get_mut(sidecar) {
            entry.last_used = tick;
            if entry.dirty {
                return Ok(entry.activity.clone());
            }
            Some((entry.disk_stamp, entry.activity.clone()))
        } else {
            None
        }
    };
    if let Some((saved_stamp, activity)) = cached {
        if super::file_stamp(sidecar)? == saved_stamp {
            return Ok(activity);
        }
    }
    let (activity, stamp) = read_disk_activity(sidecar)?;
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let tick = cache.next_tick();
    if let Some(existing) = cache.entries.get_mut(sidecar) {
        if existing.dirty {
            existing.last_used = tick;
            return Ok(existing.activity.clone());
        }
        existing.activity = activity.clone();
        existing.disk_stamp = stamp;
        existing.last_used = tick;
    } else {
        cache.evict_if_needed(sidecar);
        cache.entries.insert(
            sidecar.to_path_buf(),
            CachedActivity {
                activity: activity.clone(),
                disk_stamp: stamp,
                dirty: false,
                dirty_since: None,
                generation: 0,
                last_used: tick,
            },
        );
    }
    Ok(activity)
}

fn write_sidecar(sidecar: &Path, activity: &Activity) -> Result<Option<super::FileStamp>> {
    // Guard against background flushes resurrecting a removed TempDir in tests.
    let home = sidecar.parent().and_then(Path::parent).and_then(Path::parent);
    if home.is_some_and(|dir| !dir.exists()) {
        return Ok(None);
    }
    if let Some(parent) = sidecar.parent() {
        super::ensure_dir(parent.to_path_buf())?;
    }
    super::write_json_nosync(sidecar, activity)?;
    Ok(super::file_stamp(sidecar)?)
}

fn ensure_flusher() {
    FLUSHER.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("message-activity-flush".into())
            .spawn(flusher_loop);
    });
}

fn notify_flusher() {
    ensure_flusher();
    let (lock, cvar) = &*FLUSH_NOTIFY;
    let mut seq = lock.lock().unwrap_or_else(|e| e.into_inner());
    *seq = seq.wrapping_add(1);
    cvar.notify_one();
}

fn flush_entries(only_due: bool) -> Option<Duration> {
    let now = Instant::now();
    let mut to_write = Vec::new();
    let mut next_wait: Option<Duration> = None;
    {
        let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        for (path, entry) in &cache.entries {
            if !entry.dirty {
                continue;
            }
            if only_due {
                let elapsed = entry.dirty_since.map_or(FLUSH_DEBOUNCE, |t| now.saturating_duration_since(t));
                if elapsed < FLUSH_DEBOUNCE {
                    let rem = FLUSH_DEBOUNCE - elapsed;
                    next_wait = Some(next_wait.map_or(rem, |cur| cur.min(rem)));
                    continue;
                }
            }
            to_write.push((path.clone(), entry.activity.clone(), entry.generation));
        }
    }
    for (path, activity, gen) in to_write {
        match write_sidecar(&path, &activity) {
            Ok(stamp) => {
                let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(entry) = cache.entries.get_mut(&path) {
                    if entry.generation == gen {
                        entry.dirty = false;
                        entry.dirty_since = None;
                        entry.disk_stamp = stamp;
                    }
                }
            }
            Err(error) => {
                log::warn!("flush message activity {}: {error:#}", path.display());
            }
        }
    }
    next_wait
}

fn flusher_loop() {
    let (lock, cvar) = &*FLUSH_NOTIFY;
    let mut seen = *lock.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let wait = flush_entries(true);
        let seq = lock.lock().unwrap_or_else(|e| e.into_inner());
        if *seq != seen {
            seen = *seq;
            continue;
        }
        match wait {
            Some(duration) => {
                let (guard, _) = cvar.wait_timeout(seq, duration).unwrap_or_else(|e| e.into_inner());
                seen = *guard;
            }
            None => {
                let guard = cvar.wait(seq).unwrap_or_else(|e| e.into_inner());
                seen = *guard;
            }
        }
    }
}

/// Flush all pending in-memory message activity updates to disk immediately.
#[allow(dead_code)]
pub fn flush() {
    let _ = flush_entries(false);
}

fn select_log(tab: &mut TabActivity, path: &Path) {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned());
    let changed = tab.log_file.as_ref().is_some_and(|old| Some(old) != name.as_ref())
        || (tab.log_file.is_none() && name.as_ref().is_some_and(|name| name.contains(".reset-")));
    if changed { *tab = TabActivity::default(); }
    tab.log_file = name;
}

fn canonical(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| {
            time.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
}
fn advance(current: &mut Option<String>, incoming: Option<String>) -> bool {
    if let Some(incoming) = incoming {
        if current.as_ref().is_none_or(|old| &incoming > old) {
            *current = Some(incoming);
            return true;
        }
    }
    false
}
impl Flow {
    fn message(&mut self, event: &AgentEvent) -> bool {
        if event.subagent.is_some() {
            return false;
        }
        match &event.payload {
            Payload::TurnStarted { .. } => {
                self.assistant = false;
                false
            }
            Payload::UserMessage { queued, .. } => {
                if !queued {
                    self.assistant = false;
                }
                true
            }
            Payload::AssistantText { text, .. } | Payload::Delta(Delta::TextDelta { text, .. }) => {
                if text.is_empty() {
                    return false;
                }
                self.assistant = true;
                true
            }
            // Some harnesses send only a final answer. A completion that repeats
            // an already published answer is not another message.
            Payload::TurnCompleted { final_text, .. } => {
                let message =
                    !self.assistant && final_text.as_ref().is_some_and(|text| !text.is_empty());
                self.assistant = true;
                message
            }
            _ => false,
        }
    }
}
fn activity_path(root: &Path, session: &str) -> PathBuf {
    root.join("sessions")
        .join(session)
        .join("message-activity.json")
}
#[cfg(test)]
fn path(session: &str) -> Result<PathBuf> {
    Ok(activity_path(&super::root()?, session))
}
#[cfg(test)]
fn read(session: &str) -> Result<Activity> {
    Ok(super::read_json(&path(session)?)?.unwrap_or_default())
}

/// Use the index's forward-compatible metadata map, so older writers preserve
/// the optional projection. The sidecar remains authoritative across renames.
pub fn project(sessions: &mut [SessionEntry]) -> Result<()> {
    project_at(&super::root()?, sessions)
}
fn project_at(root: &Path, sessions: &mut [SessionEntry]) -> Result<()> {
    for session in sessions {
        let activity = read_cached(&activity_path(root, &session.id))?;
        let matches = |tab: &index::TabEntry, saved: &TabActivity| {
            let expected = tab.unknown.get("resetLogId").and_then(serde_json::Value::as_str)
                .map(|id| format!("{}.reset-{id}.jsonl", tab.id));
            match &expected {
                Some(name) => saved.log_file.as_deref() == Some(name.as_str()),
                None => saved.log_file.as_ref().is_none_or(|name| name == &format!("{}.jsonl", tab.id)),
            }
        };
        // Closed tabs still count as conversation activity. Only a replaced
        // log's obsolete projection is excluded.
        let current = |id: &String, saved: &TabActivity| session.tabs.iter().find(|tab| &tab.id == id).is_none_or(|tab| matches(tab, saved));
        if activity.tabs.iter().any(|(id, saved)| current(id, saved) && saved.has_messages) {
            session.unknown.insert(PRESENCE_FIELD.into(), true.into());
        }
        let latest = activity.tabs.iter().filter(|(id, saved)| current(id, saved))
            .filter_map(|(_, saved)| saved.last_message_at.clone()).max();
        project_time(&mut session.unknown, latest);
        for tab in &mut session.tabs {
            if activity.tabs.get(&tab.id).is_some_and(|saved| !matches(tab, saved)) { continue; }
            if activity
                .tabs
                .get(&tab.id)
                .is_some_and(|activity| activity.has_messages)
            {
                tab.unknown.insert(PRESENCE_FIELD.into(), true.into());
            }
            if let Some(time) = activity
                .tabs
                .get(&tab.id)
                .and_then(|tab| tab.last_message_at.as_ref())
            {
                project_time(&mut tab.unknown, Some(time.clone()));
            }
        }
    }
    Ok(())
}

/// When the newest message in any of a session's tabs was written, as
/// [`project`] put it on the entry; `None` for an entry read without it, or
/// a session none of whose messages carried a time.
pub fn last_message_at(session: &SessionEntry) -> Option<chrono::DateTime<chrono::Utc>> {
    let time = session.unknown.get(FIELD)?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(time)
        .ok()
        .map(|time| time.with_timezone(&chrono::Utc))
}

fn project_time(metadata: &mut BTreeMap<String, serde_json::Value>, time: Option<String>) {
    let mut newest = metadata
        .get(FIELD)
        .and_then(|value| value.as_str())
        .and_then(canonical);
    advance(&mut newest, time);
    if let Some(time) = newest {
        metadata.insert(FIELD.into(), time.into());
    }
}

/// Publish when presence is first established or chronology advances. #600 pins streamed chunks to their
/// first text time; metadata and repeated chunks never produce list updates.
pub fn record(event: &AgentEvent) -> Result<Option<SessionEntry>> {
    if event.subagent.is_some()
        || !matches!(
            &event.payload,
            Payload::TurnStarted { .. }
                | Payload::UserMessage { .. }
                | Payload::AssistantText { .. }
                | Payload::Delta(Delta::TextDelta { .. })
                | Payload::TurnCompleted { .. }
        )
    {
        return Ok(None);
    }
    let root = super::root()?;
    let sidecar = activity_path(&root, &event.session_id);
    let log = super::log_path_in(&root, &event.session_id, &event.tab_id)?;

    // Ensure the session's activity is warm in memory (never holding CACHE across disk I/O).
    // Retry if a clean entry is evicted by another thread between the stamp check and re-lock.
    let (publish, should_flush) = loop {
        let needs_load = {
            let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            match cache.entries.get(&sidecar) {
                Some(entry) if entry.dirty => None,
                Some(entry) => Some(Some(entry.disk_stamp)),
                None => Some(None),
            }
        };
        let loaded = match needs_load {
            None => None,
            Some(Some(saved_stamp)) if super::file_stamp(&sidecar)? == saved_stamp => None,
            Some(_) => Some(read_disk_activity(&sidecar)?),
        };

        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let tick = cache.next_tick();
        if let Some((disk_activity, disk_stamp)) = loaded {
            match cache.entries.get_mut(&sidecar) {
                Some(entry) if !entry.dirty => {
                    entry.activity = disk_activity;
                    entry.disk_stamp = disk_stamp;
                }
                Some(_) => {}
                None => {
                    cache.evict_if_needed(&sidecar);
                    cache.entries.insert(
                        sidecar.clone(),
                        CachedActivity {
                            activity: disk_activity,
                            disk_stamp,
                            dirty: false,
                            dirty_since: None,
                            generation: 0,
                            last_used: tick,
                        },
                    );
                }
            }
        }
        let Some(entry) = cache.entries.get_mut(&sidecar) else {
            continue;
        };
        entry.last_used = tick;
        let tab = entry.activity.tabs.entry(event.tab_id.clone()).or_default();
        select_log(tab, &log);
        let before = tab.live.assistant;
        let message = tab.live.message(event);
        let time = message
            .then(|| event.message_ts.as_deref().and_then(canonical))
            .flatten();
        let presence_changed = message && !tab.has_messages;
        tab.has_messages |= message;
        let tab_changed = advance(&mut tab.last_message_at, time.clone()) || presence_changed;
        let flow_changed = before != tab.live.assistant;
        let changed = advance(&mut entry.activity.last_message_at, time);
        let mutated = changed || tab_changed || flow_changed;
        if mutated {
            entry.dirty = true;
            entry.dirty_since.get_or_insert_with(Instant::now);
            entry.generation = entry.generation.wrapping_add(1);
        }
        break (changed || tab_changed, mutated);
    };
    if should_flush {
        notify_flusher();
    }
    if publish {
        Ok(Some(index::get(&event.session_id)?))
    } else {
        Ok(None)
    }
}

/// A reset selected a complete new log. Rebuild its small projection in one
/// write; a crash before this completes is detected by the log generation.
pub(crate) fn replaced(session: &str, tab_id: &str, events: &[AgentEvent]) -> Result<()> {
    let root = super::root()?;
    let sidecar = activity_path(&root, session);
    let log = super::log_path(session, tab_id)?;
    let mut tab = TabActivity::default();
    select_log(&mut tab, &log);
    tab.presence_scanned = true;
    for event in events {
        if tab.history.message(event) {
            tab.has_messages = true;
            advance(&mut tab.last_message_at, event.message_ts.as_deref().and_then(canonical));
        }
    }
    tab.offset = std::fs::metadata(log)?.len();
    let mut activity = read_cached(&sidecar)?;
    activity.tabs.insert(tab_id.into(), tab);
    activity.last_message_at = activity.tabs.values().filter_map(|tab| tab.last_message_at.clone()).max();
    let stamp = write_sidecar(&sidecar, &activity)?;
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let tick = cache.next_tick();
    cache.evict_if_needed(&sidecar);
    let gen = cache.entries.get(&sidecar).map_or(1, |e| e.generation.wrapping_add(1));
    cache.entries.insert(
        sidecar,
        CachedActivity {
            activity,
            disk_stamp: stamp,
            dirty: false,
            dirty_since: None,
            generation: gen,
            last_used: tick,
        },
    );
    Ok(())
}

/// One bounded batch per tab; persistent offsets make later launches idempotent.
/// Read one record at a time, never a whole transcript. A partial trailing line
/// is retried after the writer finishes it; legacy `ts` is never promoted.
#[cfg(test)]
fn scan(session: &str, tab_id: &str) -> Result<(bool, bool)> {
    scan_at(&super::root()?, session, tab_id)
}
fn scan_at(root: &Path, session: &str, tab_id: &str) -> Result<(bool, bool)> {
    let sidecar = activity_path(root, session);
    let mut activity = read_cached(&sidecar)?;
    let tab = activity.tabs.entry(tab_id.into()).or_default();
    let log = super::log_path_in(root, session, tab_id)?;
    select_log(tab, &log);
    let file = match File::open(log) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((false, false)),
        Err(error) => return Err(error.into()),
    };
    let length = file.metadata()?.len();
    let migrate_presence = !tab.presence_scanned;
    if migrate_presence {
        tab.offset = 0;
        tab.history = Flow::default();
        tab.presence_scanned = true;
    }
    if tab.offset == length {
        if migrate_presence {
            let stamp = write_sidecar(&sidecar, &activity)?;
            let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            let tick = cache.next_tick();
            let gen = cache.entries.get(&sidecar).map_or(1, |e| e.generation.wrapping_add(1));
            cache.evict_if_needed(&sidecar);
            cache.entries.insert(
                sidecar,
                CachedActivity {
                    activity,
                    disk_stamp: stamp,
                    dirty: false,
                    dirty_since: None,
                    generation: gen,
                    last_used: tick,
                },
            );
        }
        return Ok((false, false));
    }
    if tab.offset > length {
        tab.offset = 0;
        tab.history = Flow::default();
    }
    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(tab.offset))?;
    let mut line = String::new();
    let mut changed = false;
    let start = tab.offset;
    for _ in 0..BATCH {
        if tab.offset - start >= BATCH_BYTES {
            break;
        }
        line.clear();
        let bytes = reader.read_line(&mut line)?;
        if bytes == 0 || !line.ends_with('\n') {
            break;
        }
        tab.offset += bytes as u64;
        if let Ok(event) = serde_json::from_str::<AgentEvent>(&line) {
            if event.session_id != session || event.tab_id != tab_id {
                continue;
            }
            let message = tab.history.message(&event);
            changed |= message && !tab.has_messages;
            tab.has_messages |= message;
            let time = message
                .then(|| event.message_ts.as_deref().and_then(canonical))
                .flatten();
            changed |= advance(&mut tab.last_message_at, time);
        }
    }
    let scanned_tab = tab.clone();
    let more = scanned_tab.offset < length && line.ends_with('\n');
    // Merge scanned history fields back into the latest cached entry so concurrent
    // live `record()` updates to `live` or newer `last_message_at` are never lost.
    let (merged, gen) = {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let tick = cache.next_tick();
        if let Some(entry) = cache.entries.get_mut(&sidecar) {
            entry.last_used = tick;
            let live_tab = entry.activity.tabs.entry(tab_id.into()).or_default();
            if live_tab.log_file == scanned_tab.log_file {
                live_tab.history = scanned_tab.history;
                live_tab.offset = scanned_tab.offset;
                live_tab.presence_scanned = scanned_tab.presence_scanned;
                live_tab.has_messages |= scanned_tab.has_messages;
                advance(&mut live_tab.last_message_at, scanned_tab.last_message_at);
            } else {
                *live_tab = scanned_tab;
            }
            let tab_time = live_tab.last_message_at.clone();
            changed |= advance(&mut entry.activity.last_message_at, tab_time);
            entry.generation = entry.generation.wrapping_add(1);
            (entry.activity.clone(), entry.generation)
        } else {
            let tab_time = scanned_tab.last_message_at.clone();
            changed |= advance(&mut activity.last_message_at, tab_time);
            cache.evict_if_needed(&sidecar);
            cache.entries.insert(
                sidecar.clone(),
                CachedActivity {
                    activity: activity.clone(),
                    disk_stamp: None,
                    dirty: true,
                    dirty_since: Some(Instant::now()),
                    generation: 1,
                    last_used: tick,
                },
            );
            (activity, 1)
        }
    };
    let stamp = write_sidecar(&sidecar, &merged)?;
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.entries.get_mut(&sidecar) {
        if entry.generation == gen {
            entry.dirty = false;
            entry.dirty_since = None;
            entry.disk_stamp = stamp;
        }
    }
    Ok((changed, more))
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionList {
    #[serde(default)]
    sessions: Vec<SessionEntry>,
    #[serde(default)]
    closed_tabs: Vec<index::ClosedTab>,
}
fn load_at(root: &Path) -> Result<Vec<SessionEntry>> {
    let mut list: SessionList =
        super::read_json(&root.join("sessions/index.json"))?.unwrap_or_default();
    project_at(root, &mut list.sessions)?;
    Ok(list.sessions)
}

/// Local and remote list readers schedule the same migration. Work yields
/// between bounded batches; only small metadata and session updates cross IPC.
pub fn backfill(sink: Arc<dyn EventSink>) {
    let Ok(root) = super::root() else { return };
    if !SCANNING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(root.clone())
    {
        return;
    }
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let list: SessionList =
                super::read_json(&root.join("sessions/index.json"))?.unwrap_or_default();
            let mut pending: Vec<_> = list
                .sessions
                .iter()
                .flat_map(|session| {
                    session
                        .tabs
                        .iter()
                        .map(|tab| (session.id.clone(), tab.id.clone()))
                })
                .collect();
            pending.extend(
                list.closed_tabs
                    .iter()
                    .filter(|closed| {
                        list.sessions
                            .iter()
                            .any(|session| session.id == closed.session_id)
                    })
                    .map(|closed| (closed.session_id.clone(), closed.tab.id.clone())),
            );
            while !pending.is_empty() {
                let mut next = Vec::new();
                for (session, tab) in pending {
                    match scan_at(&root, &session, &tab) {
                        Ok((changed, more)) => {
                            if changed {
                                if let Ok(sessions) = load_at(&root) {
                                    if let Some(session) =
                                        sessions.iter().find(|entry| entry.id == session)
                                    {
                                        sink.emit("session_updated", session);
                                    }
                                }
                            }
                            if more {
                                next.push((session, tab));
                            }
                        }
                        Err(error) => log::warn!("backfill message activity: {error:#}"),
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                pending = next;
            }
            Ok(())
        })();
        if let Err(error) = result {
            log::warn!("backfill message activity: {error:#}");
        }
        SCANNING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&root);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seed() {
        let session: SessionEntry = serde_json::from_value(json!({
            "id":"synthetic", "projectPath":"/synthetic", "cwd":"/synthetic", "title":"Synthetic",
            "created":"2026-10-01T00:00:00Z", "modified":"2026-10-01T00:00:00Z",
            "tabs":[{"id":"tab", "harness":"claude", "created":"2026-10-01T00:00:00Z"}]
        }))
        .unwrap();
        index::save(&[session]).unwrap();
    }
    fn event(seq: u64, time: Option<&str>, payload: serde_json::Value) -> AgentEvent {
        serde_json::from_value(
            json!({"id":format!("e{seq}"), "sessionId":"synthetic", "tabId":"tab", "seq":seq,
            "harness":"claude", "ts":"2099-01-01T00:00:00Z", "messageTs":time, "payload":payload}),
        )
        .unwrap()
    }
    fn at(day: u32) -> String {
        format!("2026-10-{day:02}T00:00:00.000Z")
    }
    fn prompt(seq: u64, day: u32) -> AgentEvent {
        event(
            seq,
            Some(&at(day)),
            json!({"type":"user_message","text":"Synthetic prompt","queued":false}),
        )
    }
    fn reply(seq: u64, day: u32) -> AgentEvent {
        event(
            seq,
            Some(&at(day)),
            json!({"type":"assistant_text","text":"Synthetic reply"}),
        )
    }

    #[test]
    fn legacy_message_presence_survives_reading_without_a_verified_time() {
        let _home = super::super::temp_home();
        seed();
        let log = super::super::log_path("synthetic", "tab").unwrap();
        let legacy = event(
            1,
            None,
            json!({"type":"user_message","text":"Legacy prompt","queued":false}),
        );
        super::super::append_line(&log, &serde_json::to_string(&legacy).unwrap()).unwrap();
        // A pre-upgrade sidecar already scanned this log but could not verify its time.
        super::super::write_json(&path("synthetic").unwrap(), &json!({
            "lastMessageAt": null,
            "tabs": {"tab": {"lastMessageAt": null, "live": {"assistant": false},
                "history": {"assistant": false}, "offset": std::fs::metadata(&log).unwrap().len()}}
        })).unwrap();
        assert_eq!(scan("synthetic", "tab").unwrap(), (true, false));
        index::update_session("synthetic", |session| {
            session.tabs[0].status = index::TabStatus::Idle;
            Ok(())
        })
        .unwrap();
        let read = index::get("synthetic").unwrap();
        assert_eq!(read.unknown.get("hasMessages"), Some(&json!(true)));
        assert_eq!(read.tabs[0].unknown.get("hasMessages"), Some(&json!(true)));
        assert!(!read.unknown.contains_key(FIELD));
        assert!(!read.tabs[0].unknown.contains_key(FIELD));
        assert_eq!(scan("synthetic", "tab").unwrap(), (false, false));
    }

    #[test]
    fn live_legacy_messages_publish_presence_once_and_ignore_non_messages() {
        let _home = super::super::temp_home();
        seed();
        let mut child = reply(1, 1);
        child.subagent = Some(crate::events::SubagentRef {
            id: "child".into(),
            label: None,
        });
        assert!(record(&child).unwrap().is_none());
        assert!(record(&event(
            2,
            None,
            json!({"type":"turn_completed","status":"ok"})
        ))
        .unwrap()
        .is_none());
        assert!(
            record(&event(3, None, json!({"type":"assistant_text","text":""})))
                .unwrap()
                .is_none()
        );
        assert!(!index::get("synthetic")
            .unwrap()
            .unknown
            .contains_key(PRESENCE_FIELD));

        let message = event(
            4,
            None,
            json!({"type":"user_message","text":"Legacy prompt","queued":false}),
        );
        let published = record(&message).unwrap().unwrap();
        assert_eq!(published.unknown[PRESENCE_FIELD], true);
        assert_eq!(published.tabs[0].unknown[PRESENCE_FIELD], true);
        assert!(!published.unknown.contains_key(FIELD));
        assert!(record(&message).unwrap().is_none());
        flush();
        let saved = std::fs::read_to_string(path("synthetic").unwrap()).unwrap();
        assert!(!saved.contains("Legacy prompt"));
    }

    #[test]
    fn reset_log_rebuilds_message_activity_without_later_messages() {
        let _home = super::super::temp_home();
        seed();
        record(&prompt(1, 2)).unwrap();
        record(&reply(2, 9)).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        index::update_tab("synthetic", "tab", |tab| {
            tab.unknown.insert("resetLogId".into(), id.into());
            Ok(())
        }).unwrap();
        assert!(!index::get("synthetic").unwrap().tabs[0].unknown.contains_key(FIELD));
        let log = super::super::log_path("synthetic", "tab").unwrap();
        super::super::append_line(&log, &serde_json::to_string(&prompt(1, 2)).unwrap()).unwrap();
        scan("synthetic", "tab").unwrap();
        assert_eq!(index::get("synthetic").unwrap().tabs[0].unknown[FIELD], at(2));
        record(&reply(3, 3)).unwrap();
        assert_eq!(index::get("synthetic").unwrap().tabs[0].unknown[FIELD], at(3));
    }

    #[test]
    fn messages_survive_metadata_edits_reload_and_out_of_order_events() {
        let _home = super::super::temp_home();
        seed();
        assert!(!index::get("synthetic").unwrap().unknown.contains_key(FIELD));
        assert!(record(&prompt(1, 2)).unwrap().is_some());
        // No selected tab or UI subscription is needed for a background answer.
        let updated = record(&reply(2, 4)).unwrap().unwrap();
        assert_eq!(updated.unknown[FIELD], at(4));
        assert_eq!(updated.modified, "2026-10-01T00:00:00Z");
        index::update_session("synthetic", |session| {
            session.title = "Renamed".into();
            session.active_tab = Some("tab".into());
            session.tabs[0].model = "synthetic-model".into();
            Ok(())
        })
        .unwrap();
        assert!(record(&prompt(3, 3)).unwrap().is_none());
        assert_eq!(index::get("synthetic").unwrap().unknown[FIELD], at(4));
        // After flush, a fresh disk read projects the same time.
        flush();
        assert_eq!(read("synthetic").unwrap().last_message_at, Some(at(4)));
        let saved = std::fs::read_to_string(path("synthetic").unwrap()).unwrap();
        assert!(!saved.contains("Synthetic prompt"));
        assert!(!saved.contains("Synthetic reply"));
    }

    #[test]
    fn title_backfill_on_restart_preserves_all_projected_message_times() {
        let _home = super::super::temp_home();
        seed();
        index::update(|sessions| {
            let mut other = sessions[0].clone();
            other.id = "other".into();
            other.created = at(2);
            other.tabs[0].title = Some("Existing title".into());
            sessions.push(other);
            Ok(())
        })
        .unwrap();
        for (id, day) in [("synthetic", 4), ("other", 3)] {
            let mut message = prompt(1, day);
            message.session_id = id.into();
            let log = super::super::log_path(id, "tab").unwrap();
            super::super::append_line(&log, &serde_json::to_string(&message).unwrap()).unwrap();
            assert_eq!(scan(id, "tab").unwrap(), (true, false));
        }
        super::super::conversation_titles::backfill().unwrap();
        index::update(|sessions| {
            sessions[0].tabs[0].title = None;
            Ok(())
        })
        .unwrap();

        // The startup list must retain persisted activity even when naming one
        // tab rewrites the raw index. No new message will repair the snapshot.
        let sessions = super::super::conversation_titles::backfill().unwrap();
        assert_eq!(
            sessions[0].tabs[0].title.as_deref(),
            Some("Synthetic prompt")
        );
        assert_eq!(sessions[1].tabs[0].title.as_deref(), Some("Existing title"));
        for (session, day) in sessions.iter().zip([4, 3]) {
            assert_eq!(session.unknown[FIELD], at(day));
            assert_eq!(session.tabs[0].unknown[FIELD], at(day));
            assert_eq!(session.modified, "2026-10-01T00:00:00Z");
            assert_eq!(scan(&session.id, "tab").unwrap(), (false, false));
        }
        let again = super::super::conversation_titles::backfill().unwrap();
        assert_eq!(
            serde_json::to_value(sessions).unwrap(),
            serde_json::to_value(again).unwrap()
        );
    }

    #[test]
    fn streaming_repeats_and_completion_do_not_bump_the_list() {
        let _home = super::super::temp_home();
        seed();
        record(&prompt(1, 1)).unwrap();
        let delta = json!({"type":"delta","delta":"text_delta","block":{"messageId":"answer","index":0},"text":"Synthetic"});
        assert!(record(&event(2, Some(&at(2)), delta.clone()))
            .unwrap()
            .is_some());
        flush();
        let saved = std::fs::read(path("synthetic").unwrap()).unwrap();
        for seq in 3..20 {
            assert!(record(&event(seq, Some(&at(2)), delta.clone()))
                .unwrap()
                .is_none());
        }
        flush();
        assert_eq!(std::fs::read(path("synthetic").unwrap()).unwrap(), saved);
        assert!(record(&reply(20, 2)).unwrap().is_none());
        let completed =
            json!({"type":"turn_completed","status":"ok","finalText":"Synthetic reply"});
        assert!(record(&event(21, Some(&at(9)), completed.clone()))
            .unwrap()
            .is_none());
        record(&prompt(22, 3)).unwrap();
        assert!(record(&event(23, Some(&at(4)), completed))
            .unwrap()
            .is_some());
        assert_eq!(index::get("synthetic").unwrap().unknown[FIELD], at(4));
    }

    #[test]
    fn backfill_is_batched_idempotent_and_never_uses_legacy_import_time() {
        let _home = super::super::temp_home();
        seed();
        let log = super::super::log_path("synthetic", "tab").unwrap();
        let legacy = event(
            1,
            None,
            json!({"type":"assistant_text","text":"Synthetic legacy"}),
        );
        for _ in 0..BATCH + 1 {
            super::super::append_line(&log, &serde_json::to_string(&legacy).unwrap()).unwrap();
        }
        assert_eq!(scan("synthetic", "tab").unwrap(), (true, true));
        assert!(!index::get("synthetic").unwrap().unknown.contains_key(FIELD));
        super::super::append_line(&log, &serde_json::to_string(&reply(2, 3)).unwrap()).unwrap();
        super::super::append_line(&log, &serde_json::to_string(&reply(3, 2)).unwrap()).unwrap();
        assert_eq!(scan("synthetic", "tab").unwrap(), (true, false));
        let saved = std::fs::read(path("synthetic").unwrap()).unwrap();
        assert_eq!(scan("synthetic", "tab").unwrap(), (false, false));
        assert_eq!(std::fs::read(path("synthetic").unwrap()).unwrap(), saved);
        assert_eq!(index::get("synthetic").unwrap().unknown[FIELD], at(3));
    }

    #[test]
    fn background_backfill_publishes_closed_tab_history_without_metadata_activity() {
        let _home = super::super::temp_home();
        seed();
        let log = super::super::log_path("synthetic", "tab").unwrap();
        super::super::append_line(&log, &serde_json::to_string(&reply(1, 3)).unwrap()).unwrap();
        index::close_tab("synthetic", "tab", true).unwrap();
        let modified = index::get("synthetic").unwrap().modified;
        let sink = Arc::new(crate::sink::BroadcastSink::new(8));
        let (tx, rx) = std::sync::mpsc::channel();
        sink.listen(
            "session_updated",
            Box::new(move |payload| {
                tx.send(serde_json::from_str::<SessionEntry>(payload).unwrap())
                    .unwrap();
            }),
        );
        backfill(sink);
        let published = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert_eq!(published.unknown[FIELD], at(3));
        assert_eq!(published.modified, modified);
        assert!(published.tabs.is_empty());
        assert_eq!(index::get("synthetic").unwrap().unknown[FIELD], at(3));
    }

    #[test]
    fn rejects_invalid_times_subagents_and_non_message_activity() {
        let _home = super::super::temp_home();
        seed();
        assert!(record(&event(
            1,
            Some("bad"),
            json!({"type":"assistant_text","text":"Synthetic"})
        ))
        .unwrap()
        .is_some());
        let mut subagent = reply(2, 3);
        subagent.subagent = Some(crate::events::SubagentRef {
            id: "child".into(),
            label: None,
        });
        assert!(record(&subagent).unwrap().is_none());
        assert!(record(&event(
            3,
            Some(&at(3)),
            json!({"type":"turn_completed","status":"ok"})
        ))
        .unwrap()
        .is_none());
        assert!(!index::get("synthetic").unwrap().unknown.contains_key(FIELD));
        assert_eq!(canonical("2026-10-02T04:00:00+04:00"), Some(at(2)));
    }

    #[test]
    fn streaming_deltas_hit_in_memory_cache_and_index_get_reads_only_requested_session() {
        let _home = super::super::temp_home();
        // Seed multiple sessions to verify index::get only projects the requested one.
        let sessions: Vec<SessionEntry> = ["s1", "s2", "s3", "s4"].iter().map(|id| {
            serde_json::from_value(json!({
                "id": id, "projectPath": "/synthetic", "cwd": "/synthetic", "title": id,
                "created": "2026-10-01T00:00:00Z", "modified": "2026-10-01T00:00:00Z",
                "tabs": [{"id": "tab", "harness": "claude", "created": "2026-10-01T00:00:00Z"}]
            })).unwrap()
        }).collect();
        index::save(&sessions).unwrap();

        TEST_DISK_READS.with(|c| c.set(0));
        let _ = index::get("s1").unwrap();
        assert_eq!(TEST_DISK_READS.with(|c| c.get()), 1, "index::get must only read the requested session's sidecar");

        // Record a prompt + 100 streaming text deltas: zero additional sidecar reads and no sync write storm.
        let mut p = prompt(1, 5);
        p.session_id = "s1".into();
        assert!(record(&p).unwrap().is_some());
        let delta = json!({"type":"delta","delta":"text_delta","block":{"messageId":"m","index":0},"text":"chunk"});
        let mut first_delta = event(2, Some(&at(6)), delta.clone());
        first_delta.session_id = "s1".into();
        assert!(record(&first_delta).unwrap().is_some());

        TEST_DISK_READS.with(|c| c.set(0));
        super::super::TEST_LOG_PATH_PARSES.with(|c| c.set(0));
        for seq in 3..103 {
            let mut ev = event(seq, Some(&at(6)), delta.clone());
            ev.session_id = "s1".into();
            assert!(record(&ev).unwrap().is_none());
        }
        assert_eq!(TEST_DISK_READS.with(|c| c.get()), 0, "streaming deltas must not re-read message-activity.json");
        assert_eq!(super::super::TEST_LOG_PATH_PARSES.with(|c| c.get()), 0, "streaming deltas must not re-parse index.json");

        // In-memory projection is immediately visible before flush.
        assert_eq!(index::get("s1").unwrap().unknown[FIELD], at(6));
        flush();
        assert_eq!(read("s1").unwrap().last_message_at, Some(at(6)));
    }

    #[test]
    fn record_handles_eviction_under_cache_pressure_without_panicking() {
        let _home = super::super::temp_home();
        seed();
        assert!(record(&prompt(1, 2)).unwrap().is_some());
        flush();

        // Populate more than MAX_CACHE_ENTRIES clean sessions so "synthetic" is evicted,
        // and race concurrent cache evictions against repeated record() calls.
        let root = super::super::root().unwrap();
        let pressure_root = root.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_evictor = Arc::clone(&stop);
        let evictor = std::thread::spawn(move || {
            let mut i = 0usize;
            while !stop_evictor.load(std::sync::atomic::Ordering::Relaxed) {
                let sidecar = activity_path(&pressure_root, &format!("evict-{i}"));
                let _ = read_cached(&sidecar);
                i = (i + 1) % (MAX_CACHE_ENTRIES + 64);
            }
        });

        for i in 0..(MAX_CACHE_ENTRIES + 32) {
            let _ = read_cached(&activity_path(&root, &format!("fill-{i}")));
        }
        for seq in 2..40 {
            let _ = record(&reply(seq, 3 + (seq as u32 % 5))).unwrap();
            flush();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        evictor.join().unwrap();

        flush();
        assert_eq!(index::get("synthetic").unwrap().unknown[FIELD], at(7));
        assert_eq!(read("synthetic").unwrap().last_message_at, Some(at(7)));
    }
}
