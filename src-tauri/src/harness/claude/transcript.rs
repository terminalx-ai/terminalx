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

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::events::{Payload, ToolResult, ToolType, TurnStatus, Usage};

/// Where the CLI keeps the transcript for a session run in `cwd`. Every
/// character outside `[A-Za-z0-9-]` becomes `-`, which is why a dot-folder
/// yields a double dash.
pub fn cli_transcript_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    Some(transcript_under(&dirs::home_dir()?, cwd, session_id))
}

/// Path check without the home lookup, for tests and callers that have one.
pub fn transcript_under(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    let encoded: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    home.join(".claude").join("projects").join(encoded).join(format!("{session_id}.jsonl"))
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

/// A cursor into one transcript file: how far it has been read, and the bytes
/// after the last newline, which are a record still being written.
///
/// It works in bytes, not text: a read can land in the middle of a record and
/// therefore in the middle of a multi-byte character, so nothing is decoded
/// until its newline has arrived.
pub struct Streamer {
    offset: u64,
    partial: Vec<u8>,
}

impl Streamer {
    /// Start reading at `offset` — the file's length when the CLI was spawned,
    /// so a resumed conversation is not replayed into the log twice.
    pub fn at(offset: u64) -> Self {
        Self { offset, partial: Vec::new() }
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// Feed the bytes read after `offset()`. Complete lines are decoded; the
    /// tail after the last newline is kept for the next chunk.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Payload> {
        self.offset += chunk.len() as u64;
        self.partial.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.partial.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=nl).collect();
            if let Ok(text) = std::str::from_utf8(&line) {
                decode_line(text.trim_end_matches(['\n', '\r']), &mut out);
            }
        }
        out
    }
}

/// One transcript record as payloads. Unknown record types yield nothing.
fn decode_line(line: &str, out: &mut Vec<Payload>) {
    if line.trim().is_empty() {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    if v["isSidechain"].as_bool().unwrap_or(false) || v["isMeta"].as_bool().unwrap_or(false) {
        return;
    }
    match v["type"].as_str().unwrap_or("") {
        "user" => decode_user(&v, out),
        "assistant" => decode_assistant(&v, out),
        "system" if v["subtype"] == "compact_boundary" => {
            let meta = &v["compactMetadata"];
            out.push(Payload::ContextCompacted {
                pre_tokens: meta["preTokens"].as_u64(),
                post_tokens: meta["postTokens"].as_u64(),
            });
        }
        _ => {}
    }
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
        let mut whole = Streamer::at(0);
        let expected = kinds(&whole.push(FIXTURE.as_bytes()));
        assert_eq!(expected, vec!["user", "thinking", "text", "usage", "tool", "result", "tool", "edits", "user", "end"]);
        assert_eq!(whole.offset(), FIXTURE.len() as u64);

        // Cut inside the fourth record, so a line arrives across two chunks.
        let cut = FIXTURE.find("Looking first").unwrap() + 4;
        let mut split = Streamer::at(0);
        let mut got = split.push(&FIXTURE.as_bytes()[..cut]);
        got.extend(split.push(&FIXTURE.as_bytes()[cut..]));
        assert_eq!(kinds(&got), expected);
        assert_eq!(split.offset(), FIXTURE.len() as u64);
    }

    #[test]
    fn a_trailing_fragment_is_held_until_its_newline() {
        let one_and_a_half = FIXTURE.find("\"a1\"").unwrap();
        let mut s = Streamer::at(0);
        assert_eq!(kinds(&s.push(&FIXTURE.as_bytes()[..one_and_a_half])), vec!["user"]);
        assert_eq!(kinds(&s.push(&FIXTURE.as_bytes()[one_and_a_half..])).len(), 9);
    }

    #[test]
    fn decodes_prose_tools_and_occupancy() {
        let mut s = Streamer::at(0);
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
        let mut s = Streamer::at(0);
        let p = s.push(REAL.as_bytes());
        // The redacted `thinking` blocks the CLI writes carry no text, so they
        // draw nothing; `mode`, `last-prompt` and the rest are bookkeeping.
        assert_eq!(kinds(&p), vec!["user", "usage", "text", "usage", "user", "usage", "text", "usage"]);
        assert!(matches!(&p[0], Payload::UserMessage { text, .. } if text == "Reply with exactly: pong"));
        assert!(matches!(&p[2], Payload::AssistantText { text, .. } if text == "pong"));
        assert!(matches!(&p[4], Payload::UserMessage { text, .. } if text == "Reply with exactly: second"));
        assert!(matches!(&p[6], Payload::AssistantText { text, .. } if text == "second"));
    }

    #[test]
    fn encodes_the_project_folder_like_the_cli() {
        let p = transcript_under(Path::new("/h"), "/Users/dev/code/ai/raccoon-e2e/.raccoon/worktrees/sly-ochre-hare", "abc");
        assert_eq!(p, Path::new("/h/.claude/projects/-Users-dev-code-ai-raccoon-e2e--raccoon-worktrees-sly-ochre-hare/abc.jsonl"));
    }
}
