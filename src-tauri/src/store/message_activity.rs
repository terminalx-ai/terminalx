//! Message chronology, separate from mutable session metadata. The sidecar holds
//! only verified times and scan progress, never prompt or response contents.
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use super::index::{self, SessionEntry};
use crate::events::{AgentEvent, Delta, Payload};
use crate::sink::EventSink;
use anyhow::Result;
use serde::{Deserialize, Serialize};

static LOCK: Mutex<()> = Mutex::new(());
static SCANNING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
const FIELD: &str = "lastMessageAt";
const BATCH: usize = 128;
// Yield after this many bytes, at a record boundary (never split a message).
const BATCH_BYTES: u64 = 256 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    last_message_at: Option<String>,
    tabs: BTreeMap<String, TabActivity>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabActivity {
    last_message_at: Option<String>,
    live: Flow,
    history: Flow,
    offset: u64,
}
#[derive(Default, Serialize, Deserialize, PartialEq)]
struct Flow {
    assistant: bool,
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
    fn message(&mut self, event: &AgentEvent) -> Option<String> {
        if event.subagent.is_some() {
            return None;
        }
        let message = match &event.payload {
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
                    return None;
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
        };
        message
            .then(|| event.message_ts.as_deref().and_then(canonical))
            .flatten()
    }
}
fn activity_path(root: &Path, session: &str) -> PathBuf {
    root.join("sessions")
        .join(session)
        .join("message-activity.json")
}
fn path(session: &str) -> Result<PathBuf> {
    Ok(activity_path(&super::root()?, session))
}
fn read(session: &str) -> Result<Activity> {
    Ok(super::read_json(&path(session)?)?.unwrap_or_default())
}
fn write(session: &str, activity: &Activity) -> Result<()> {
    super::session_dir(session)?;
    super::write_json(&path(session)?, activity)
}

/// Use the index's forward-compatible metadata map, so older writers preserve
/// the optional projection. The sidecar remains authoritative across renames.
pub fn project(sessions: &mut [SessionEntry]) -> Result<()> {
    project_at(&super::root()?, sessions)
}
fn project_at(root: &Path, sessions: &mut [SessionEntry]) -> Result<()> {
    for session in sessions {
        let activity: Activity =
            super::read_json(&activity_path(root, &session.id))?.unwrap_or_default();
        project_time(&mut session.unknown, activity.last_message_at);
        for tab in &mut session.tabs {
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
    chrono::DateTime::parse_from_rfc3339(time).ok().map(|time| time.with_timezone(&chrono::Utc))
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

/// Publish only when chronology advances. #600 pins streamed chunks to their
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
    let changed = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut activity = read(&event.session_id)?;
        let tab = activity.tabs.entry(event.tab_id.clone()).or_default();
        let before = tab.live.assistant;
        let time = tab.live.message(event);
        let tab_changed = advance(&mut tab.last_message_at, time.clone());
        let flow_changed = before != tab.live.assistant;
        let changed = advance(&mut activity.last_message_at, time);
        if changed || tab_changed || flow_changed {
            write(&event.session_id, &activity)?;
        }
        changed || tab_changed
    };
    if changed {
        Ok(Some(index::get(&event.session_id)?))
    } else {
        Ok(None)
    }
}

/// One bounded batch per tab; persistent offsets make later launches idempotent.
/// Read one record at a time, never a whole transcript. A partial trailing line
/// is retried after the writer finishes it; legacy `ts` is never promoted.
#[cfg(test)]
fn scan(session: &str, tab_id: &str) -> Result<(bool, bool)> {
    scan_at(&super::root()?, session, tab_id)
}
fn scan_at(root: &Path, session: &str, tab_id: &str) -> Result<(bool, bool)> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let sidecar = activity_path(root, session);
    let mut activity: Activity = super::read_json(&sidecar)?.unwrap_or_default();
    let tab = activity.tabs.entry(tab_id.into()).or_default();
    let log = root
        .join("sessions")
        .join(session)
        .join(format!("{tab_id}.jsonl"));
    let file = match File::open(log) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((false, false)),
        Err(error) => return Err(error.into()),
    };
    let length = file.metadata()?.len();
    if tab.offset == length {
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
            let time = tab.history.message(&event);
            changed |= advance(&mut tab.last_message_at, time);
        }
    }
    let time = tab.last_message_at.clone();
    let more = tab.offset < length && line.ends_with('\n');
    changed |= advance(&mut activity.last_message_at, time);
    super::write_json(&sidecar, &activity)?;
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
        // No process cache: a fresh disk read projects the same time.
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
        assert_eq!(sessions[0].tabs[0].title.as_deref(), Some("Synthetic prompt"));
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
        let saved = std::fs::read(path("synthetic").unwrap()).unwrap();
        for seq in 3..20 {
            assert!(record(&event(seq, Some(&at(2)), delta.clone()))
                .unwrap()
                .is_none());
        }
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
        assert_eq!(scan("synthetic", "tab").unwrap(), (false, true));
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
        .is_none());
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
}
