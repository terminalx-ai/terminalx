//! Read-only context preparation. Never starts or loads a source runtime, and
//! never reads an entire transcript just to open the continuation dialog.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Result};
use serde::Serialize;

use crate::events::Payload;
use crate::harness::{claude, codex};
use crate::store::{self, index};
use crate::summaries::TailLines;

const CAPTURE_CHARS: usize = 36_000;
const HINT_CHARS: usize = 6_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub session_id: String,
    pub tab_id: String,
    pub title: String,
    pub provider: String,
    pub provider_session_id: Option<String>,
    pub cwd: String,
    pub source_active: bool,
    pub transcript_path: Option<String>,
    pub full_unavailable_reason: Option<String>,
    pub last_prompt: Option<String>,
    pub last_update: Option<String>,
    pub partial_capture: Option<String>,
}

pub fn prepare(session_id: &str, tab_id: &str, tracked: Option<PathBuf>) -> Result<Context> {
    let entry = index::get(session_id)?;
    let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("Source conversation no longer exists."))?;
    let native = tracked.filter(|p| !p.as_os_str().is_empty()).or_else(|| resolve(&entry.cwd, tab));
    let log = store::log_path(session_id, tab_id)?;
    prepare_from_paths(&entry, tab, native.as_deref(), &log)
}

fn resolve(cwd: &str, tab: &index::TabEntry) -> Option<PathBuf> {
    let id = tab.provider_session_id.as_deref()?;
    // Index ids are provider identities, never relative filesystem paths.
    if id.contains(['/', '\\']) || id == "." || id == ".." { return None; }
    match tab.harness.as_str() {
        "claude" => claude::transcript::cli_transcript_path(cwd, id),
        "codex" => codex::home::managed_root().ok().and_then(|home| codex::home::find_rollout(&home, id))
            .or_else(|| codex::home::user_root().and_then(|home| codex::home::find_rollout(&home, id))),
        _ => None,
    }
}

/// Probe a native saved file, without exporting or truncating it. The native
/// file is the complete saved history; the app log is only a projection and
/// cannot establish completeness. A live source may append after this probe.
fn readable_transcript(path: &Path) -> Result<PathBuf> {
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() == 0 { bail!("The saved transcript is empty."); }
    // Readability/encoding probes stay bounded even for multi-GB histories.
    let mut head = vec![0; meta.len().min(8192) as usize];
    file.read_exact(&mut head)?;
    if std::str::from_utf8(&head).is_err_and(|e| e.error_len().is_some()) {
        bail!("The saved transcript is not readable UTF-8.");
    }
    if let Some(end) = head.iter().position(|b| *b == b'\n') {
        serde_json::from_slice::<serde_json::Value>(&head[..end])
            .map_err(|_| anyhow!("The saved transcript is not readable JSONL."))?;
    }
    let prefix = String::from_utf8_lossy(&head);
    if !prefix.trim_start().starts_with('{') || head.contains(&0) { bail!("The saved transcript is not readable JSONL."); }
    file.seek(SeekFrom::Start(meta.len().saturating_sub(8192)))?;
    let mut tail = Vec::new();
    file.take(8192).read_to_end(&mut tail)?;
    if tail.contains(&0) { bail!("The saved transcript is not readable text."); }
    Ok(path.canonicalize()?)
}

fn prepare_from_paths(entry: &index::SessionEntry, tab: &index::TabEntry, native: Option<&Path>, log: &Path) -> Result<Context> {
    let (transcript_path, reason) = match native.map(readable_transcript) {
        Some(Ok(path)) => (Some(path.to_string_lossy().into_owned()), None),
        Some(Err(e)) => (None, Some(format!("The complete saved provider transcript is unreadable: {e}"))),
        None => (None, Some("No complete saved provider transcript is available. Focused handoff can use partial recent history.".into())),
    };
    let mut recent = Recent::default();
    // Persisted app history supplies status even if the native file was lost.
    if let Ok(mut lines) = TailLines::open(log) {
        while let Some(line) = lines.next_line()? {
            let Ok(event) = serde_json::from_str::<crate::events::AgentEvent>(&line) else { continue };
            if event.tab_id != tab.id || event.session_id != entry.id || event.subagent.is_some() { continue; }
            recent.observe(&event.payload);
            if recent.done(transcript_path.is_some()) { break; }
        }
    }
    // Native history also works for tabs whose app projection was never loaded.
    if recent.last_prompt.is_none() || recent.last_update.is_none() {
        if let Some(path) = transcript_path.as_deref() {
            if let Ok(mut lines) = TailLines::open(Path::new(path)) {
                let mut native_recent = Recent::default();
                while let Some(line) = lines.next_line()? {
                    let mut payloads = Vec::new();
                    match tab.harness.as_str() {
                        "claude" => claude::transcript::decode_line(&line, &Default::default(), &mut payloads),
                        "codex" => codex::rollout::decode_line(&line, &Default::default(), &mut payloads),
                        _ => {}
                    }
                    for payload in payloads.iter().rev() { native_recent.observe(payload); }
                    if native_recent.done(true) { break; }
                }
                recent.last_prompt = recent.last_prompt.or(native_recent.last_prompt);
                recent.last_update = recent.last_update.or(native_recent.last_update);
            }
        }
    }
    if transcript_path.is_none() && recent.capture.is_empty() {
        bail!("No usable saved context exists for this conversation. Send a message in the source conversation first, then try again.");
    }
    let partial_capture = transcript_path.is_none().then(|| {
        recent.capture.reverse();
        format!("[Partial recent conversation capture; older history and omitted content are not included.]\n{}", recent.capture.join("\n\n"))
    });
    Ok(Context {
        session_id: entry.id.clone(), tab_id: tab.id.clone(),
        title: tab.title.clone().unwrap_or_else(|| entry.title.clone()),
        provider: tab.harness.clone(), provider_session_id: tab.provider_session_id.clone(),
        cwd: entry.cwd.clone(), source_active: matches!(tab.status, index::TabStatus::InProgress | index::TabStatus::Waiting),
        transcript_path, full_unavailable_reason: reason,
        last_prompt: recent.last_prompt, last_update: recent.last_update, partial_capture,
    })
}

#[derive(Default)]
struct Recent {
    last_prompt: Option<String>,
    last_update: Option<String>,
    capture: Vec<String>,
    chars: usize,
}
impl Recent {
    fn done(&self, full: bool) -> bool {
        self.last_prompt.is_some() && self.last_update.is_some() && (full || self.chars >= CAPTURE_CHARS)
    }
    fn observe(&mut self, payload: &Payload) {
        let (role, text) = match payload {
            Payload::UserMessage { text, .. } => ("User", text),
            Payload::AssistantText { text, .. } => ("Assistant", text),
            Payload::TurnCompleted { final_text: Some(text), .. } => ("Assistant", text),
            _ => return,
        };
        let text = clean(text);
        if text.trim().is_empty() { return; }
        let slot = if role == "User" { &mut self.last_prompt } else { &mut self.last_update };
        if slot.is_none() { *slot = Some(bounded(&text, HINT_CHARS)); }
        let remaining = CAPTURE_CHARS.saturating_sub(self.chars + role.len() + 4);
        if remaining == 0 { self.chars = CAPTURE_CHARS; return; }
        let text = bounded(&text, remaining);
        self.chars += text.chars().count() + role.len() + 4;
        self.capture.push(format!("{role}: {text}"));
    }
}

/// Strip terminal CSI/OSC sequences before hints become agent input.
pub fn clean(text: &str) -> String {
    static ANSI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let ansi = ANSI.get_or_init(|| regex::Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])").unwrap());
    ansi.replace_all(text, "").chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect()
}
fn bounded(text: &str, budget: usize) -> String {
    const MARK: &str = "[Earlier text omitted]\n";
    if text.chars().count() <= budget { return text.into(); }
    let tail: String = text.chars().rev().take(budget.saturating_sub(MARK.len())).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{MARK}{tail}").chars().take(budget).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(provider: &str) -> index::SessionEntry {
        serde_json::from_value(json!({
            "id":"workspace", "projectPath":"/workspace", "cwd":"/workspace/checkout",
            "title":"Issue 109", "created":"now", "modified":"now",
            "tabs":[{"id":"source", "harness":provider, "providerSessionId":"original-identity",
                "status":"waiting", "created":"now", "modified":"now"}]
        })).unwrap()
    }
    fn event(text: &str, role: &str, tab: &str) -> String {
        json!({"id":"e", "seq":1, "ts":"now", "sessionId":"workspace", "tabId":tab,
            "harness":"claude", "payload":{"type":role,"text":text, "images":[], "queued":false,
            "block":{"messageId":"m", "index":0}}}).to_string()
    }

    #[test]
    fn both_providers_reference_whole_large_files_without_changing_source() {
        for provider in ["claude", "codex"] {
            let dir = tempfile::tempdir().unwrap();
            let native = dir.path().join("native.jsonl");
            let log = dir.path().join("app.jsonl");
            let data = format!("{{\"early\":\"must remain readable\"}}\n{}{{\"last\":true}}\n", "{\"padding\":true}\n".repeat(300_000));
            std::fs::write(&native, &data).unwrap();
            std::fs::write(&log, format!("{}\n{}\n", event("Latest request", "user_message", "source"), event("Latest reply", "assistant_text", "source"))).unwrap();
            let entry = source(provider);
            let before = entry.clone();
            let context = prepare_from_paths(&entry, &entry.tabs[0], Some(&native), &log).unwrap();
            assert!(context.full_unavailable_reason.is_none());
            assert!(context.partial_capture.is_none());
            assert_eq!(context.last_prompt.as_deref(), Some("Latest request"));
            assert_eq!(context.last_update.as_deref(), Some("Latest reply"));
            assert!(context.source_active);
            assert_eq!(context.cwd, "/workspace/checkout");
            assert_eq!(context.provider_session_id.as_deref(), Some("original-identity"));
            assert_eq!(std::fs::read_to_string(context.transcript_path.unwrap()).unwrap(), data);
            assert_eq!(entry, before);
        }
    }

    #[test]
    fn missing_and_unreadable_native_history_only_allow_bounded_partial_context() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("app.jsonl");
        let entry = source("claude");
        let long = format!("early omitted {} recent work\u{1b}[31m red\u{1b}[0m ```", "é".repeat(50_000));
        std::fs::write(&log, format!("{}\n{}\n", event(&long, "user_message", "source"), event("wrong tab secret", "user_message", "other"))).unwrap();
        for path in [None, Some(dir.path())] {
            let context = prepare_from_paths(&entry, &entry.tabs[0], path, &log).unwrap();
            assert!(context.transcript_path.is_none());
            assert!(context.full_unavailable_reason.is_some());
            let capture = context.partial_capture.unwrap();
            assert!(capture.contains("Partial recent"));
            assert!(capture.contains("Earlier text omitted"));
            assert!(capture.contains("recent work red ```"));
            assert!(!capture.contains("wrong tab"));
            assert!(!capture.contains('\u{1b}'));
            assert!(capture.chars().count() <= CAPTURE_CHARS + 100);
        }
    }

    #[test]
    fn empty_context_rejects_and_native_history_supplies_missing_status() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("missing");
        let entry = source("claude");
        assert!(prepare_from_paths(&entry, &entry.tabs[0], None, &log).is_err());
        let native = dir.path().join("native.jsonl");
        std::fs::write(&native, "{\"type\":\"user\",\"uuid\":\"u\",\"message\":{\"role\":\"user\",\"content\":\"Persisted request\"}}\n").unwrap();
        let context = prepare_from_paths(&entry, &entry.tabs[0], Some(&native), &log).unwrap();
        assert_eq!(context.last_prompt.as_deref(), Some("Persisted request"));
    }

    #[test]
    fn control_sequences_and_unicode_are_safe() {
        assert_eq!(clean("\u{1b}]0;title\u{7}a\u{1b}[31mb\u{1b}[0m\u{0}\n😺"), "ab\n😺");
        assert!(bounded(&"😺".repeat(100), 30).chars().count() <= 30);
    }
}
