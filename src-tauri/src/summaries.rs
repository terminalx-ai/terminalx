//! What a session was last saying, for the agent dashboard.
//!
//! A dashboard card wants three short strings per session: the reader's last
//! prompt, the agent's last reply, and — when the tab is waiting — what it is
//! waiting on. All three live near the end of a tab's log, which is
//! append-only JSONL and can run to megabytes after a long session. So the
//! reader walks the file **backwards** in 64 KB blocks and stops as soon as it
//! has what a card shows; opening the dashboard on fifty sessions then costs
//! about one block per tab rather than fifty whole transcripts.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

use crate::store::{self, index};
use crate::store::index::{SessionEntry, TabEntry, TabStatus};

/// How much is pulled from the file per seek. One block holds hundreds of
/// events, so the common case is a single read.
const BLOCK: u64 = 64 * 1024;
/// A log with no user message in its last few megabytes gets no snippet
/// rather than a full scan; nothing on a card is worth reading 100 MB for.
const MAX_SCAN: u64 = 4 * 1024 * 1024;
/// Snippets are drawn on one truncated line, so the wire carries a line's worth.
const SNIPPET_CHARS: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub tab_id: String,
    pub last_prompt: Option<String>,
    pub last_reply: Option<String>,
    /// The pending permission or question, set only for a waiting tab.
    pub waiting_on: Option<String>,
    pub updated_at: String,
}

/// Whole lines from the end of a file, newest first.
///
/// Blocks are read from before whatever has been read so far and prepended to
/// the buffer, so a line split across a block boundary is only handed out once
/// its beginning arrives.
pub struct TailLines {
    file: fs::File,
    /// Offset of the earliest byte read; the next block is taken from before it.
    start: u64,
    /// Bytes read but not yet handed out, ending where the last line began.
    buf: Vec<u8>,
    scanned: u64,
}

impl TailLines {
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = fs::File::open(path)?;
        let start = file.metadata()?.len();
        Ok(Self { file, start, buf: Vec::new(), scanned: 0 })
    }

    /// The next line counting back from the end, or `None` at the start of the
    /// file or once the scan cap is reached. Blank lines are skipped.
    pub fn next_line(&mut self) -> io::Result<Option<String>> {
        loop {
            if let Some(i) = self.buf.iter().rposition(|b| *b == b'\n') {
                let line = self.buf.split_off(i + 1);
                self.buf.pop(); // the newline itself belongs to neither line
                if line.is_empty() {
                    continue;
                }
                return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
            }
            if self.start == 0 || self.scanned >= MAX_SCAN {
                if self.buf.is_empty() {
                    return Ok(None);
                }
                // Whatever is left is the first line of the file, or — at the
                // cap — a fragment, which simply fails to parse as an event.
                let line = std::mem::take(&mut self.buf);
                return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
            }
            let take = BLOCK.min(self.start);
            self.start -= take;
            let mut block = vec![0u8; take as usize];
            self.file.seek(SeekFrom::Start(self.start))?;
            self.file.read_exact(&mut block)?;
            block.append(&mut self.buf);
            self.buf = block;
            self.scanned += take;
        }
    }
}

/// Something said, with when it was said. The stamp is what lets lines from
/// different tabs of one session be ordered against each other.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Said {
    pub text: String,
    pub ts: String,
}

/// What a card shows, read from one tab's log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LogTail {
    pub last_prompt: Option<Said>,
    pub last_reply: Option<Said>,
    pub waiting_on: Option<String>,
}

impl LogTail {
    fn wants_more(&self, waiting: bool) -> bool {
        self.last_prompt.is_none() || self.last_reply.is_none() || (waiting && self.waiting_on.is_none())
    }
}

/// Keep whichever line was said later. Stamps are RFC 3339 in UTC, so they
/// compare as strings; a line with no stamp only wins an empty slot.
fn keep_newer(slot: &mut Option<Said>, found: Option<Said>) {
    if let Some(f) = found {
        if slot.as_ref().is_none_or(|cur| cur.ts <= f.ts) {
            *slot = Some(f);
        }
    }
}

/// Read the tail of `path`. `waiting` says whether the tab is parked on an
/// ask; when it is not, the ask bookkeeping is skipped entirely.
pub fn read_log_tail(path: &Path, waiting: bool) -> LogTail {
    let mut out = LogTail::default();
    let mut tail = match TailLines::open(path) {
        Ok(t) => t,
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                log::warn!("summary tail {}: {e}", path.display());
            }
            return out;
        }
    };
    // Asks are closed by a `permission_decided` carrying their request id, and
    // that decision is written after the ask, so walking backwards means every
    // answered id is already known by the time its request comes past.
    let mut decided: HashSet<String> = HashSet::new();
    while out.wants_more(waiting) {
        let line = match tail.next_line() {
            Ok(Some(l)) => l,
            Ok(None) => break,
            Err(e) => {
                log::warn!("summary tail {}: {e}", path.display());
                break;
            }
        };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        // Subagent chatter is not what the session said to the reader.
        if v.get("subagent").is_some_and(|s| !s.is_null()) {
            continue;
        }
        let Some(payload) = v.get("payload") else { continue };
        let ts = || v.get("ts").and_then(Value::as_str).unwrap_or_default().to_string();
        match payload.get("type").and_then(Value::as_str).unwrap_or_default() {
            "user_message" if out.last_prompt.is_none() => {
                out.last_prompt = said(payload.get("text").and_then(Value::as_str).unwrap_or_default(), ts());
            }
            "assistant_text" if out.last_reply.is_none() => {
                out.last_reply = said(payload.get("text").and_then(Value::as_str).unwrap_or_default(), ts());
            }
            "permission_decided" if waiting => {
                if let Some(id) = payload.get("requestId").and_then(Value::as_str) {
                    decided.insert(id.to_string());
                }
            }
            kind @ ("permission_requested" | "questions_asked") if waiting && out.waiting_on.is_none() => {
                let id = payload.get("requestId").and_then(Value::as_str).unwrap_or_default();
                if !decided.contains(id) {
                    out.waiting_on = if kind == "permission_requested" { permission_title(payload) } else { question_title(payload) };
                }
            }
            _ => {}
        }
    }
    out
}

/// The card line for a permission: the harness's own title, else the tool name.
fn permission_title(payload: &Value) -> Option<String> {
    payload
        .get("title")
        .and_then(Value::as_str)
        .and_then(snippet)
        .or_else(|| payload.get("toolName").and_then(Value::as_str).and_then(snippet))
}

/// The card line for a question form: its header, else the first question.
fn question_title(payload: &Value) -> Option<String> {
    let first = payload.get("questions").and_then(Value::as_array).and_then(|q| q.first())?;
    first
        .get("question")
        .and_then(Value::as_str)
        .and_then(snippet)
        .or_else(|| first.get("header").and_then(Value::as_str).and_then(snippet))
}

fn said(text: &str, ts: String) -> Option<Said> {
    snippet(text).map(|text| Said { text, ts })
}

/// One line's worth of text: whitespace collapsed, capped, empty means none.
fn snippet(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = 0usize;
    for word in text.split_whitespace() {
        if chars >= SNIPPET_CHARS {
            out.push('…');
            return Some(out);
        }
        if !out.is_empty() {
            out.push(' ');
            chars += 1;
        }
        for c in word.chars() {
            if chars >= SNIPPET_CHARS {
                out.push('…');
                return Some(out);
            }
            out.push(c);
            chars += 1;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// The tab a card speaks for: whichever one explains the session's status, so
/// a waiting tab's question is never hidden behind a quiet active tab.
fn card_tab(s: &SessionEntry) -> Option<&TabEntry> {
    let by_status = |want: TabStatus| s.tabs.iter().find(|t| t.status == want);
    by_status(TabStatus::Waiting)
        .or_else(|| by_status(TabStatus::InProgress))
        .or_else(|| s.active_tab.as_ref().and_then(|id| s.tab(id)))
        .or_else(|| s.tabs.iter().max_by(|a, b| a.modified.cmp(&b.modified)))
}

/// Summaries for the given sessions, or for every session when `None`.
pub fn collect(session_ids: Option<Vec<String>>) -> Result<Vec<SessionSummary>> {
    let wanted: Option<HashSet<String>> = session_ids.map(|ids| ids.into_iter().collect());
    let mut out = Vec::new();
    for s in index::load()? {
        if wanted.as_ref().is_some_and(|w| !w.contains(&s.id)) {
            continue;
        }
        let Some(card) = card_tab(&s) else { continue };
        // Every tab is tailed, not only the one the card speaks for. A session
        // often holds an older tab with the whole conversation beside a newer
        // one barely started, and the card should show what was last said
        // wherever it was said. Each tail stops as soon as it has its lines, so
        // a second tab costs about one block read.
        let mut merged = LogTail::default();
        for tab in &s.tabs {
            let path = store::log_path(&s.id, &tab.id)?;
            let tail = read_log_tail(&path, tab.status == TabStatus::Waiting);
            keep_newer(&mut merged.last_prompt, tail.last_prompt);
            keep_newer(&mut merged.last_reply, tail.last_reply);
            // Only a waiting tab yields one, and a session shows the first.
            if merged.waiting_on.is_none() {
                merged.waiting_on = tail.waiting_on;
            }
        }
        out.push(SessionSummary {
            session_id: s.id.clone(),
            tab_id: card.id.clone(),
            last_prompt: merged.last_prompt.map(|l| l.text),
            last_reply: merged.last_reply.map(|l| l.text),
            waiting_on: merged.waiting_on,
            updated_at: if card.modified.is_empty() { s.modified.clone() } else { card.modified.clone() },
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, lines: &[String]) {
        fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
    }

    #[test]
    fn tail_reader_walks_a_file_backwards_across_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        // 500 lines of ~300 bytes is several 64 KB blocks, so this exercises
        // the join of a line split across a block boundary.
        let lines: Vec<String> = (1..=500).map(|i| format!("{i} {}", "x".repeat(300))).collect();
        write(&p, &lines);
        let mut tail = TailLines::open(&p).unwrap();
        let mut seen = Vec::new();
        while let Some(l) = tail.next_line().unwrap() {
            seen.push(l);
        }
        assert_eq!(seen.len(), 500);
        assert_eq!(seen[0], lines[499]);
        assert_eq!(seen[499], lines[0]);
        assert!(tail.next_line().unwrap().is_none());
    }

    #[test]
    fn tail_reader_handles_no_trailing_newline_and_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        fs::write(&p, "first\n\n\nlast").unwrap();
        let mut tail = TailLines::open(&p).unwrap();
        assert_eq!(tail.next_line().unwrap().as_deref(), Some("last"));
        assert_eq!(tail.next_line().unwrap().as_deref(), Some("first"));
        assert!(tail.next_line().unwrap().is_none());
    }

    #[test]
    fn missing_file_reads_as_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_log_tail(&dir.path().join("gone.jsonl"), true), LogTail::default());
    }

    fn event_at(ts: &str, payload: serde_json::Value) -> String {
        serde_json::json!({ "id": "e", "sessionId": "s", "tabId": "t", "harness": "claude", "seq": 1, "ts": ts, "payload": payload }).to_string()
    }

    fn event(payload: serde_json::Value) -> String {
        event_at("2026-01-01T00:00:00.000Z", payload)
    }

    fn text(said: &Option<Said>) -> Option<&str> {
        said.as_ref().map(|s| s.text.as_str())
    }

    #[test]
    fn tail_takes_the_last_prompt_and_reply_and_ignores_subagents() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        let mut sub = serde_json::from_str::<Value>(&event(serde_json::json!({"type": "assistant_text", "text": "from a subagent"}))).unwrap();
        sub["subagent"] = serde_json::json!({ "id": "a1" });
        write(
            &p,
            &[
                event(serde_json::json!({"type": "user_message", "text": "first ask"})),
                event(serde_json::json!({"type": "assistant_text", "text": "first answer"})),
                event(serde_json::json!({"type": "user_message", "text": "  now   fix\nthe  build  "})),
                sub.to_string(),
                event(serde_json::json!({"type": "assistant_text", "text": "Fixed the build."})),
                event(serde_json::json!({"type": "turn_completed", "status": "ok"})),
            ],
        );
        let tail = read_log_tail(&p, false);
        assert_eq!(text(&tail.last_prompt), Some("now fix the build"));
        assert_eq!(text(&tail.last_reply), Some("Fixed the build."));
        assert!(tail.waiting_on.is_none());
    }

    #[test]
    fn long_replies_are_capped() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        write(
            &p,
            &[
                event(serde_json::json!({"type": "user_message", "text": "go"})),
                event(serde_json::json!({"type": "assistant_text", "text": "word ".repeat(200)})),
            ],
        );
        let reply = read_log_tail(&p, false).last_reply.unwrap().text;
        assert_eq!(reply.chars().count(), SNIPPET_CHARS + 1); // the cap plus its ellipsis
        assert!(reply.ends_with('…'));
    }

    #[test]
    fn waiting_on_is_the_newest_unanswered_ask() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        write(
            &p,
            &[
                event(serde_json::json!({"type": "user_message", "text": "go"})),
                event(serde_json::json!({"type": "permission_requested", "requestId": "r1", "toolUseId": "u1", "toolName": "Bash", "input": {}, "title": "Run the tests", "options": []})),
                event(serde_json::json!({"type": "permission_decided", "requestId": "r1", "allowed": true, "label": "Allow"})),
                event(serde_json::json!({"type": "assistant_text", "text": "Tests pass."})),
                event(serde_json::json!({"type": "questions_asked", "requestId": "r2", "toolUseId": "u2", "questions": [{"question": "Which database?", "options": []}]})),
            ],
        );
        let tail = read_log_tail(&p, true);
        assert_eq!(tail.waiting_on.as_deref(), Some("Which database?"));
        // An answered ask is not what anyone is waiting on.
        assert_eq!(read_log_tail(&p, true).waiting_on.as_deref(), Some("Which database?"));
        // And when the tab is not waiting the asks are not read at all.
        assert!(read_log_tail(&p, false).waiting_on.is_none());
    }

    #[test]
    fn an_answered_ask_leaves_nothing_pending() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        write(
            &p,
            &[
                event(serde_json::json!({"type": "user_message", "text": "go"})),
                event(serde_json::json!({"type": "permission_requested", "requestId": "r1", "toolUseId": "u1", "toolName": "Bash", "input": {}, "options": []})),
                event(serde_json::json!({"type": "permission_decided", "requestId": "r1", "allowed": true, "label": "Allow"})),
            ],
        );
        assert!(read_log_tail(&p, true).waiting_on.is_none());
    }

    #[test]
    fn a_permission_without_a_title_falls_back_to_its_tool() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        write(
            &p,
            &[event(serde_json::json!({"type": "permission_requested", "requestId": "r1", "toolUseId": "u1", "toolName": "Bash", "input": {}, "options": []}))],
        );
        assert_eq!(read_log_tail(&p, true).waiting_on.as_deref(), Some("Bash"));
    }

    fn a_tab(id: &str, status: TabStatus) -> TabEntry {
        TabEntry {
            id: id.into(),
            harness: "claude".into(),
            title: None,
            model: String::new(),
            effort: None,
            permission_mode: "auto".into(),
            provider_session_id: None,
            status,
            created: index::now(),
            modified: index::now(),
            context_used: None,
            context_max: None,
            fork_from: None,
            unknown: Default::default(),
        }
    }

    /// The first tab is the active one, as a session's own tab strip has it.
    fn a_session(id: &str, tabs: Vec<TabEntry>) -> SessionEntry {
        SessionEntry {
            id: id.into(),
            project_path: "/p".into(),
            cwd: "/p".into(),
            worktree_name: None,
            branch: None,
            base_ref: None,
            worktree_removed: false,
            issue: None,
            title: "t".into(),
            created: index::now(),
            modified: index::now(),
            archived: false,
            pinned: false,
            active_tab: tabs.first().map(|t| t.id.clone()),
            tabs,
            unknown: Default::default(),
        }
    }

    #[test]
    fn collect_picks_the_waiting_tab_and_skips_unasked_sessions() {
        let _home = store::temp_home();
        let s = a_session("s1", vec![a_tab("t1", TabStatus::Idle), a_tab("t2", TabStatus::Waiting)]);
        let mut other = s.clone();
        other.id = "s2".into();
        index::save(&[s, other]).unwrap();
        write(
            &store::log_path("s1", "t2").unwrap(),
            &[event(serde_json::json!({"type": "permission_requested", "requestId": "r1", "toolUseId": "u1", "toolName": "Bash", "input": {}, "title": "Delete the branch", "options": []}))],
        );

        let all = collect(None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].tab_id, "t2");
        assert_eq!(all[0].waiting_on.as_deref(), Some("Delete the branch"));

        let one = collect(Some(vec!["s2".into()])).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].session_id, "s2");
        assert!(one[0].waiting_on.is_none());
    }

    #[test]
    fn a_quiet_active_tab_borrows_the_text_from_the_tab_that_spoke() {
        let _home = store::temp_home();
        // The real shape this fixes: a new active tab holding two bookkeeping
        // lines beside an older tab that holds the whole conversation.
        index::save(&[a_session("s1", vec![a_tab("new", TabStatus::Idle), a_tab("old", TabStatus::Idle)])]).unwrap();
        write(
            &store::log_path("s1", "new").unwrap(),
            &[
                event_at("2026-03-02T00:00:00.000Z", serde_json::json!({"type": "settings_changed", "model": "opus"})),
                event_at("2026-03-02T00:00:01.000Z", serde_json::json!({"type": "status", "text": "ready"})),
            ],
        );
        write(
            &store::log_path("s1", "old").unwrap(),
            &[
                event_at("2026-03-01T00:00:00.000Z", serde_json::json!({"type": "user_message", "text": "ship the parser"})),
                event_at("2026-03-01T00:00:05.000Z", serde_json::json!({"type": "assistant_text", "text": "Parser shipped."})),
            ],
        );

        let out = collect(None).unwrap();
        assert_eq!(out[0].tab_id, "new"); // the card still speaks for the active tab
        assert_eq!(out[0].last_prompt.as_deref(), Some("ship the parser"));
        assert_eq!(out[0].last_reply.as_deref(), Some("Parser shipped."));
    }

    #[test]
    fn the_newer_line_wins_when_both_tabs_spoke() {
        let _home = store::temp_home();
        index::save(&[a_session("s1", vec![a_tab("t1", TabStatus::Idle), a_tab("t2", TabStatus::Idle)])]).unwrap();
        write(
            &store::log_path("s1", "t1").unwrap(),
            &[
                event_at("2026-03-01T00:00:00.000Z", serde_json::json!({"type": "user_message", "text": "older ask"})),
                event_at("2026-03-01T00:00:01.000Z", serde_json::json!({"type": "assistant_text", "text": "older answer"})),
            ],
        );
        write(
            &store::log_path("s1", "t2").unwrap(),
            &[
                event_at("2026-03-03T00:00:00.000Z", serde_json::json!({"type": "user_message", "text": "newer ask"})),
                event_at("2026-03-03T00:00:01.000Z", serde_json::json!({"type": "assistant_text", "text": "newer answer"})),
            ],
        );

        let out = collect(None).unwrap();
        assert_eq!(out[0].last_prompt.as_deref(), Some("newer ask"));
        assert_eq!(out[0].last_reply.as_deref(), Some("newer answer"));
    }
}
