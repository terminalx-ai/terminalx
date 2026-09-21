//! Stable conversation titles, derived locally from each tab's first request.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;
use serde_json::Value;

use super::index::{self, SessionEntry, TabEntry};

const MAX_SCAN: u64 = 1024 * 1024;
const MAX_TITLE_CHARS: usize = 48;
const MAX_TITLE_WORDS: usize = 8;

fn unnamed(tab: &TabEntry) -> bool {
    tab.title
        .as_deref()
        .is_none_or(|title| title.trim().is_empty())
}

/// A short excerpt, not an extra model request. Keep the user's own task words.
fn request_title(request: &str) -> Option<String> {
    let mut request = request.trim();
    if let Some(attributed) = request.strip_prefix("[TerminalX Effective User v1] ") {
        if let Some((envelope, text)) = attributed.split_once('\n') {
            if serde_json::from_str::<Value>(envelope)
                .ok()
                .is_some_and(|value| {
                    value["authority"] == "host"
                        && value["userId"].as_str().is_some_and(|id| !id.is_empty())
                })
            {
                request = text.trim();
            }
        }
    }
    let line = request.lines().find(|line| !line.trim().is_empty())?.trim();
    let line = line.trim_start_matches(['#', '*', '-', ' ']);
    static ISSUE_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^work on (?:GitHub|Linear) (?:issue|pull request) [^:]+:\s*").unwrap()
    });
    static REQUEST_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:(?:please|can you|could you|would you|i want you to|i'd like you to|help me)\s+)+").unwrap()
    });
    let line = ISSUE_PREFIX.replace(line, "");
    let line = REQUEST_PREFIX.replace(&line, "");
    let mut title = String::new();
    for word in line.split_whitespace().take(MAX_TITLE_WORDS) {
        if !title.is_empty() && title.chars().count() + 1 + word.chars().count() > MAX_TITLE_CHARS {
            break;
        }
        if !title.is_empty() {
            title.push(' ');
        }
        title.push_str(word);
        if word.ends_with(['.', '?', '!']) {
            break;
        }
    }
    let title = title.trim_end_matches(['.', '?', '!', ':', ',', ';']);
    let mut chars = title.chars();
    let first = chars.next()?;
    let title = first.to_uppercase().chain(chars).collect::<String>();
    if title.chars().count() > MAX_TITLE_CHARS {
        Some(
            title
                .chars()
                .take(MAX_TITLE_CHARS - 1)
                .chain(['…'])
                .collect(),
        )
    } else {
        Some(title)
    }
}

/// Read forwards: later requests and subagent prompts must never rename a tab.
fn read_title(path: &Path) -> Option<String> {
    let reader = BufReader::new(File::open(path).ok()?.take(MAX_SCAN));
    for line in reader.lines() {
        let line = line.ok()?;
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("subagent").is_some_and(|value| !value.is_null()) {
            continue;
        }
        let payload = &event["payload"];
        if payload["type"] == "user_message" {
            if let Some(title) = payload["text"].as_str().and_then(request_title) {
                return Some(title);
            }
        }
    }
    None
}

/// Backfill existing tabs when either app asks for the session list. Titles are
/// persisted once; future refreshes only inspect tabs that still lack a name.
pub fn backfill() -> Result<Vec<SessionEntry>> {
    let sessions = index::load()?;
    let mut titles = Vec::new();
    for session in &sessions {
        for tab in session.tabs.iter().filter(|tab| unnamed(tab)) {
            if let Some(title) = read_title(&super::log_path(&session.id, &tab.id)?) {
                titles.push((session.id.clone(), tab.id.clone(), title));
            }
        }
    }
    if titles.is_empty() {
        return Ok(sessions);
    }
    index::update(|sessions| {
        for (session_id, tab_id, title) in titles {
            if let Some(tab) = sessions
                .iter_mut()
                .find(|session| session.id == session_id)
                .and_then(|session| session.tab_mut(&tab_id))
            {
                if unnamed(tab) {
                    tab.title = Some(title);
                }
            }
        }
        // Naming is metadata; do not reorder worktrees by touching modified.
        Ok(sessions.clone())
    })
}

/// Called after a top-level user message is persisted, including provider TUI
/// messages. Return the updated session so the desktop sidebar can update live.
pub fn name_tab(session_id: &str, tab_id: &str) -> Result<Option<SessionEntry>> {
    let session = index::get(session_id)?;
    if !session.tab(tab_id).is_some_and(unnamed) {
        return Ok(None);
    }
    let Some(title) = read_title(&super::log_path(session_id, tab_id)?) else {
        return Ok(None);
    };
    index::update(|sessions| {
        let Some(session) = sessions.iter_mut().find(|session| session.id == session_id) else {
            return Ok(None);
        };
        let Some(tab) = session.tab_mut(tab_id).filter(|tab| unnamed(tab)) else {
            return Ok(None);
        };
        tab.title = Some(title);
        Ok(Some(session.clone()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seed() {
        let session: SessionEntry = serde_json::from_value(json!({
            "id":"session", "projectPath":"/project", "cwd":"/project", "title":"Worktree",
            "created":"before", "modified":"before", "tabs":[
                {"id":"claude", "harness":"claude", "created":"before", "modified":"before"},
                {"id":"codex", "harness":"codex", "created":"before", "modified":"before"}
            ]
        }))
        .unwrap();
        index::save(&[session]).unwrap();
    }

    fn prompt(tab_id: &str, text: &str) {
        let path = super::super::log_path("session", tab_id).unwrap();
        super::super::append_line(
            &path,
            &json!({"payload":{"type":"user_message","text":text}}).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn uses_task_words_and_removes_request_boilerplate() {
        assert_eq!(
            request_title("Can you please fix login redirect? Then add tests."),
            Some("Fix login redirect".into())
        );
        assert_eq!(
            request_title(
                "Work on GitHub issue #132: Mobile conversation names\n\nDetailed issue body"
            ),
            Some("Mobile conversation names".into())
        );
        assert_eq!(
            request_title("# Refactor app.ts loading\nIgnore this line"),
            Some("Refactor app.ts loading".into())
        );
        assert_eq!(request_title(" \n "), None);
    }

    #[test]
    fn strips_only_valid_mobile_attribution_and_bounds_unicode_titles() {
        assert_eq!(request_title("[TerminalX Effective User v1] {\"authority\":\"host\",\"userId\":\"user\"}\nPlease fix sign in"), Some("Fix sign in".into()));
        assert!(
            request_title("[TerminalX Effective User v1] not-json\nFix sign in")
                .unwrap()
                .starts_with("[TerminalX")
        );
        let title = request_title(&"修".repeat(100)).unwrap();
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
        assert!(title.ends_with('…'));
        assert!(
            request_title("one two three four five six seven eight nine ten")
                .unwrap()
                .split_whitespace()
                .count()
                <= MAX_TITLE_WORDS
        );
    }

    #[test]
    fn each_tab_uses_its_first_request_and_stays_named_across_refreshes() {
        let _home = super::super::temp_home();
        seed();
        prompt("claude", "Please fix login redirect");
        prompt("codex", "Add billing export");
        let named = name_tab("session", "claude").unwrap().unwrap();
        assert_eq!(
            named.tab("claude").unwrap().title.as_deref(),
            Some("Fix login redirect")
        );
        prompt("claude", "Now rewrite everything");
        let sessions = backfill().unwrap();
        assert_eq!(
            sessions[0].tab("claude").unwrap().title.as_deref(),
            Some("Fix login redirect")
        );
        assert_eq!(
            sessions[0].tab("codex").unwrap().title.as_deref(),
            Some("Add billing export")
        );
        assert_eq!(sessions[0].modified, "before");
        assert_eq!(backfill().unwrap(), sessions);
        assert!(name_tab("session", "claude").unwrap().is_none());
    }

    #[test]
    fn backfill_preserves_custom_names_and_ignores_subagent_chatter() {
        let _home = super::super::temp_home();
        seed();
        index::update_tab("session", "claude", |tab| {
            tab.title = Some("My review".into());
            Ok(())
        })
        .unwrap();
        prompt("claude", "Ignore my custom name");
        let path = super::super::log_path("session", "codex").unwrap();
        super::super::append_line(&path, &json!({"subagent":{"id":"child"},"payload":{"type":"user_message","text":"Private subtask"}}).to_string()).unwrap();
        super::super::append_line(&path, "invalid partial event").unwrap();
        prompt("codex", "");
        prompt("codex", "Check deployment settings");
        let sessions = backfill().unwrap();
        assert_eq!(
            sessions[0].tab("claude").unwrap().title.as_deref(),
            Some("My review")
        );
        assert_eq!(
            sessions[0].tab("codex").unwrap().title.as_deref(),
            Some("Check deployment settings")
        );
    }

    #[test]
    fn missing_and_oversized_logs_do_not_require_an_unbounded_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        assert_eq!(read_title(&path), None);
        std::fs::write(&path, " ".repeat(MAX_SCAN as usize + 1)).unwrap();
        assert_eq!(read_title(&path), None);
    }
}
