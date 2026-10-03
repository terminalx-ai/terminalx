//! Claude Code's own transcript, read as it is written.
//!
//! The CLI appends one JSON record per message to
//! `~/.claude/projects/<encoded cwd>/<session-id>.jsonl`, whether it is driven
//! headless or run interactively in a terminal. A PTY-first tab has no wire
//! protocol to read, so this file **is** the conversation: the tailer follows
//! it from wherever it stood when the CLI was spawned and turns each new
//! record into the app's own payloads.
//!
//! Records are written per message, not per token, so assistant prose lands a
//! message at a time and there are no deltas to preview.
//!
//! The CLI's bookkeeping records (`queue-operation`, `last-prompt`, `mode`,
//! `attachment`, …) carry nothing the transcript view would draw and are
//! skipped, as are sidechain (subagent) and meta records.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::events::{Payload, ToolResult, ToolType, TurnStatus, Usage};
use crate::harness::tui::TurnMark;

/// Where the CLI keeps the transcript for a session run in `cwd`. Every
/// character outside `[A-Za-z0-9-]` becomes `-`, which is why a dot-folder
/// yields a double dash.
pub fn cli_transcript_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    Some(projects_root()?.join(encoded_cwd(cwd)).join(format!("{session_id}.jsonl")))
}

/// Where the CLI keeps every project's transcripts: `projects` under
/// `CLAUDE_CONFIG_DIR` when that is set, else under `~/.claude`. Reading a
/// transcript and deleting one both go through here, so they cannot disagree
/// about where the CLI wrote.
pub fn projects_root() -> Option<PathBuf> {
    projects_root_from(std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(), dirs::home_dir().as_deref())
}

pub fn projects_root_from(config_dir: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    match config_dir.filter(|dir| !dir.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir).join("projects")),
        None => home.map(|home| home.join(".claude").join("projects")),
    }
}

/// Every record uuid in a session's transcript. A fork copies those records
/// into its own file, so this is what the copy will look like.
pub fn record_uuids(cwd: &str, session_id: &str) -> Option<HashSet<String>> {
    let path = cli_transcript_path(cwd, session_id)?;
    let text = std::fs::read_to_string(path).ok()?;
    Some(uuids_in(&text))
}

fn uuids_in(text: &str) -> HashSet<String> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v["uuid"].as_str().map(String::from))
        .collect()
}

/// The folder name the CLI gives a working directory under `~/.claude/projects`.
/// The encoding loses information: two different paths can share a name.
pub fn encoded_cwd(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect()
}

/// Path check without the home lookup, for tests.
#[cfg(test)]
pub fn transcript_under(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    home.join(".claude").join("projects").join(encoded_cwd(cwd)).join(format!("{session_id}.jsonl"))
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| if p["type"] == "text" { p["text"].as_str().map(String::from) } else { None })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The CLI records a stop as a user turn reading `[Request interrupted by
/// user]`; it is a turn boundary, not something the reader said.
fn interruption(text: &str) -> bool {
    text.starts_with("[Request interrupted by user")
}

/// Occupancy after one message: the four token counts of that message summed.
/// A running total would double-count the cache.
fn occupancy(usage: &Value) -> Option<u64> {
    let sum: u64 = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]
        .iter()
        .filter_map(|k| usage.get(k).and_then(|v| v.as_u64()))
        .sum();
    (sum > 0).then_some(sum)
}

/// One transcript record as payloads. Unknown record types yield nothing.
pub fn decode_line(line: &str, skip: &HashSet<String>, out: &mut Vec<Payload>) {
    decode_marked(line, skip, out);
}

/// [`decode_line`], and what the record says about the turn, for the session
/// watcher: a prompt opens one; the `turn_duration` record the CLI writes
/// when it prints "Worked for …", or an interruption, ends it. Both come from
/// the one parse of the record.
pub fn decode_marked(line: &str, skip: &HashSet<String>, out: &mut Vec<Payload>) -> Option<TurnMark> {
    if line.trim().is_empty() {
        return None;
    }
    let v = serde_json::from_str::<Value>(line).ok()?;
    if v["isSidechain"].as_bool().unwrap_or(false) || v["isMeta"].as_bool().unwrap_or(false) {
        return None;
    }
    if v["uuid"].as_str().is_some_and(|u| skip.contains(u)) {
        return None;
    }
    match v["type"].as_str().unwrap_or("") {
        "user" => {
            let before = out.len();
            decode_user(&v, out);
            return match out.get(before)? {
                Payload::UserMessage { .. } => Some(TurnMark::Opened),
                Payload::TurnCompleted { .. } => Some(TurnMark::Ended),
                _ => None,
            };
        }
        "assistant" if v["isApiErrorMessage"].as_bool() == Some(true) => {
            out.push(Payload::Error { message: text_of(&v["message"]["content"]), fatal: false });
        }
        "assistant" => decode_assistant(&v, out),
        "system" if v["subtype"] == "api_error" => {
            let message = v["error"]["message"].as_str().or_else(|| v["message"].as_str()).unwrap_or("Provider request failed");
            out.push(Payload::Error { message: message.into(), fatal: false });
        }
        "system" if v["subtype"] == "compact_boundary" => {
            let meta = &v["compactMetadata"];
            out.push(Payload::ContextCompacted {
                pre_tokens: meta["preTokens"].as_u64(),
                post_tokens: meta["postTokens"].as_u64(),
            });
        }
        "system" if v["subtype"] == "turn_duration" => return Some(TurnMark::Ended),
        _ => {}
    }
    None
}

/// The mark alone.
#[cfg(test)]
fn turn_mark(line: &str) -> Option<TurnMark> {
    decode_marked(line, &HashSet::new(), &mut Vec::new())
}

fn decode_user(v: &Value, out: &mut Vec<Payload>) {
    let content = &v["message"]["content"];
    let parts = content.as_array().cloned().unwrap_or_default();
    let results: Vec<&Value> = parts.iter().filter(|p| p["type"] == "tool_result").collect();
    if !results.is_empty() {
        for r in results {
            out.push(Payload::ToolCallCompleted {
                call_id: r["tool_use_id"].as_str().unwrap_or("").to_string(),
                result: ToolResult { text: text_of(&r["content"]), is_error: r["is_error"].as_bool().unwrap_or(false), ..Default::default() },
            });
        }
        return;
    }
    let prompt = text_of(content);
    if prompt.trim().is_empty() {
        return;
    }
    if interruption(&prompt) {
        out.push(Payload::TurnCompleted { status: TurnStatus::Aborted, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false });
        return;
    }
    out.push(Payload::UserMessage { text: prompt, images: Vec::new(), baseline: None, queued: false, cwd: v["cwd"].as_str().map(String::from) });
}

fn decode_assistant(v: &Value, out: &mut Vec<Payload>) {
    for p in v["message"]["content"].as_array().into_iter().flatten() {
        match p["type"].as_str().unwrap_or("") {
            "text" => {
                let t = p["text"].as_str().unwrap_or("");
                if !t.trim().is_empty() {
                    out.push(Payload::AssistantText { block: None, text: t.to_string() });
                }
            }
            "thinking" => {
                let t = p["thinking"].as_str().unwrap_or("");
                if !t.trim().is_empty() {
                    out.push(Payload::Reasoning { block: None, text: t.to_string() });
                }
            }
            "tool_use" => {
                let name = p["name"].as_str().unwrap_or("tool").to_string();
                let input = p["input"].clone();
                let call_id = p["id"].as_str().unwrap_or("").to_string();
                let title = Some(super::mapper::tool_title(&name, &input));
                let edits = super::mapper::file_edits_from_input(&name, &input);
                out.push(Payload::ToolCallStarted { call_id: call_id.clone(), tool_type: ToolType::from_tool_name(&name), input, title, name });
                if let Some(edits) = edits {
                    out.push(Payload::FileEdits { call_id: Some(call_id), edits });
                }
            }
            _ => {}
        }
    }
    if let Some(used) = v["message"]["usage"].as_object().and_then(|_| occupancy(&v["message"]["usage"])) {
        out.push(Payload::UsageUpdate(Usage { context_used: Some(used), ..Default::default() }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::tui::Streamer;

    const FIXTURE: &str = r#"{"type":"queue-operation","timestamp":"2026-09-02T02:41:16.631Z","sessionId":"s"}
{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u1","timestamp":"2026-09-02T02:41:18.686Z","userType":"external","cwd":"/tmp/x","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"Add multiply"}]}}
{"parentUuid":"u1","isSidechain":false,"type":"assistant","uuid":"a1","timestamp":"2026-09-02T02:41:23.156Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}
{"parentUuid":"a1","isSidechain":false,"type":"assistant","uuid":"a2","timestamp":"2026-09-02T02:41:23.158Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Looking first."}],"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":5}}}
{"parentUuid":"a2","isSidechain":false,"type":"assistant","uuid":"a3","timestamp":"2026-09-02T02:41:24.816Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"cat src/math.js"}}]}}
{"parentUuid":"a3","isSidechain":false,"type":"user","uuid":"u2","timestamp":"2026-09-02T02:41:26.219Z","cwd":"/tmp/x","sessionId":"s","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"export const x = 1;"}]}}
{"parentUuid":"u2","isSidechain":true,"type":"assistant","uuid":"a4b","timestamp":"2026-09-02T02:41:29.000Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m9","role":"assistant","content":[{"type":"text","text":"subagent chatter"}]}}
{"parentUuid":"u2","isSidechain":false,"type":"assistant","uuid":"a4","timestamp":"2026-09-02T02:41:30.000Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Write","input":{"file_path":"/tmp/x/math.js","content":"export const y = 2;"}}]}}
{"type":"last-prompt","sessionId":"s"}
{"parentUuid":"a4","isSidechain":false,"type":"user","uuid":"u3","timestamp":"2026-09-02T02:45:00.000Z","cwd":"/tmp/x","sessionId":"s","message":{"role":"user","content":"Thanks, now add divide"}}
{"parentUuid":"u3","isSidechain":false,"type":"user","uuid":"u4","timestamp":"2026-09-02T02:45:02.000Z","cwd":"/tmp/x","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}
"#;

    fn kinds(p: &[Payload]) -> Vec<&'static str> {
        p.iter()
            .map(|x| match x {
                Payload::UserMessage { .. } => "user",
                Payload::AssistantText { .. } => "text",
                Payload::Reasoning { .. } => "thinking",
                Payload::ToolCallStarted { .. } => "tool",
                Payload::FileEdits { .. } => "edits",
                Payload::ToolCallCompleted { .. } => "result",
                Payload::UsageUpdate(_) => "usage",
                Payload::TurnCompleted { .. } => "end",
                Payload::ContextCompacted { .. } => "compacted",
                _ => "other",
            })
            .collect()
    }

    /// The whole file at once and the same file in awkward chunks — one of
    /// which splits a record mid-line — must decode identically.
    #[test]
    fn streams_the_same_payloads_however_the_file_is_chunked() {
        let mut whole = Streamer::at(0, decode_line);
        let expected = kinds(&whole.push(FIXTURE.as_bytes()));
        assert_eq!(expected, vec!["user", "thinking", "text", "usage", "tool", "result", "tool", "edits", "user", "end"]);
        assert_eq!(whole.offset(), FIXTURE.len() as u64);

        // Cut inside the fourth record, so a line arrives across two chunks.
        let cut = FIXTURE.find("Looking first").unwrap() + 4;
        let mut split = Streamer::at(0, decode_line);
        let mut got = split.push(&FIXTURE.as_bytes()[..cut]);
        got.extend(split.push(&FIXTURE.as_bytes()[cut..]));
        assert_eq!(kinds(&got), expected);
        assert_eq!(split.offset(), FIXTURE.len() as u64);
    }

    #[test]
    fn a_trailing_fragment_is_held_until_its_newline() {
        let one_and_a_half = FIXTURE.find("\"a1\"").unwrap();
        let mut s = Streamer::at(0, decode_line);
        assert_eq!(kinds(&s.push(&FIXTURE.as_bytes()[..one_and_a_half])), vec!["user"]);
        assert_eq!(kinds(&s.push(&FIXTURE.as_bytes()[one_and_a_half..])).len(), 9);
    }

    #[test]
    fn decodes_prose_tools_and_occupancy() {
        let mut s = Streamer::at(0, decode_line);
        let p = s.push(FIXTURE.as_bytes());
        assert!(matches!(&p[0], Payload::UserMessage { text, .. } if text == "Add multiply"));
        assert!(matches!(&p[3], Payload::UsageUpdate(u) if u.context_used == Some(105)));
        assert!(matches!(&p[4], Payload::ToolCallStarted { tool_type: ToolType::Shell, name, .. } if name == "Bash"));
        assert!(matches!(&p[7], Payload::FileEdits { edits, .. } if edits[0].path == "/tmp/x/math.js"));
        assert!(matches!(&p[8], Payload::UserMessage { text, .. } if text == "Thanks, now add divide"));
        assert!(matches!(&p[9], Payload::TurnCompleted { status: TurnStatus::Aborted, .. }));
    }

    /// A file the installed CLI wrote itself, running interactively in a PTY:
    /// one turn, then a second after `--resume` reopened the same session.
    /// Everything between the two prompts is the CLI's own bookkeeping.
    #[test]
    fn decodes_a_real_interactive_session_including_its_resume() {
        const REAL: &str = include_str!("fixtures/interactive_session.jsonl");
        let mut s = Streamer::at(0, decode_line);
        let p = s.push(REAL.as_bytes());
        // The redacted `thinking` blocks the CLI writes carry no text, so they
        // draw nothing; `mode`, `last-prompt` and the rest are bookkeeping.
        assert_eq!(kinds(&p), vec!["user", "usage", "text", "usage", "user", "usage", "text", "usage"]);
        assert!(matches!(&p[0], Payload::UserMessage { text, .. } if text == "Reply with exactly: pong"));
        assert!(matches!(&p[2], Payload::AssistantText { text, .. } if text == "pong"));
        assert!(matches!(&p[4], Payload::UserMessage { text, .. } if text == "Reply with exactly: second"));
        assert!(matches!(&p[6], Payload::AssistantText { text, .. } if text == "second"));
    }

    /// The same file, read for what it says about its turns: each prompt
    /// opens one and each `turn_duration` ends it. The bookkeeping records
    /// and the replies in between say nothing either way.
    #[test]
    fn marks_where_a_real_sessions_turns_open_and_end() {
        const REAL: &str = include_str!("fixtures/interactive_session.jsonl");
        let marks: Vec<TurnMark> = REAL.lines().filter_map(turn_mark).collect();
        assert_eq!(marks, vec![TurnMark::Opened, TurnMark::Ended, TurnMark::Opened, TurnMark::Ended]);

        // A tail keeps the last mark of what it read, and hands it over once.
        let mut s = Streamer::at(0, decode_line).marking(Some(decode_marked));
        let first_end = REAL.find(r#""subtype":"turn_duration""#).unwrap();
        s.push(&REAL.as_bytes()[..first_end]);
        assert_eq!(s.take_mark(), Some(TurnMark::Opened));
        assert_eq!(s.take_mark(), None);
        s.push(&REAL.as_bytes()[first_end..]);
        assert_eq!(s.take_mark(), Some(TurnMark::Ended));

        // A tool's result is a `user` record too and opens nothing, a
        // subagent's records are not this turn's, and an interruption ends
        // the turn as surely as finishing it does.
        let marks: Vec<TurnMark> = FIXTURE.lines().filter_map(turn_mark).collect();
        assert_eq!(marks, vec![TurnMark::Opened, TurnMark::Opened, TurnMark::Ended]);
    }

    /// A forked tab's log already holds the parent conversation, and the CLI
    /// writes a copy of it into the fork's own file. The copy keeps each
    /// record's uuid, which is what tells it apart from what is new.
    #[test]
    fn a_forks_copy_of_the_parent_conversation_is_not_logged_again() {
        let carried = uuids_in(FIXTURE);
        assert!(carried.contains("u1") && carried.contains("a2"));
        let mut s = Streamer::skipping(0, decode_line, carried);
        assert!(s.push(FIXTURE.as_bytes()).is_empty(), "every record was carried over");

        let fresh = "{\"type\":\"user\",\"uuid\":\"u9\",\"message\":{\"content\":\"after the fork\"}}\n";
        assert!(matches!(&s.push(fresh.as_bytes())[0], Payload::UserMessage { text, .. } if text == "after the fork"));
    }

    #[test]
    fn the_projects_root_follows_claude_config_dir() {
        let home = Path::new("/Users/me");
        assert_eq!(projects_root_from(None, Some(home)), Some(PathBuf::from("/Users/me/.claude/projects")));
        assert_eq!(projects_root_from(Some(""), Some(home)), Some(PathBuf::from("/Users/me/.claude/projects")));
        assert_eq!(projects_root_from(Some("/opt/claude"), Some(home)), Some(PathBuf::from("/opt/claude/projects")));
        assert_eq!(projects_root_from(Some("/opt/claude"), None), Some(PathBuf::from("/opt/claude/projects")));
        assert_eq!(projects_root_from(None, None), None);
    }

    #[test]
    fn encodes_the_project_folder_like_the_cli() {
        let p = transcript_under(Path::new("/h"), "/Users/dev/code/ai/raccoon-e2e/.raccoon/worktrees/sly-ochre-hare", "abc");
        assert_eq!(p, Path::new("/h/.claude/projects/-Users-dev-code-ai-raccoon-e2e--raccoon-worktrees-sly-ochre-hare/abc.jsonl"));
    }
}
