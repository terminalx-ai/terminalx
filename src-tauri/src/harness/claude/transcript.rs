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
//! most `attachment`s, …) carry nothing the transcript view would draw and
//! are skipped, as are sidechain (subagent) and meta records.
//!
//! A prompt reaches the file in one of two shapes, and both are the reader
//! speaking (#250): a `user` record when the CLI was idle, and a
//! `queued_command` attachment when it was typed while a turn was running —
//! the CLI hands that one to the model with the next tool result and never
//! writes a `user` record for it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::events::{Payload, ToolResult, ToolType, TurnStatus, Usage};
use crate::harness::tui::TurnMark;

/// Where a session's transcript actually is.
///
/// The folder is named for the directory the conversation was *started* in,
/// and the CLI goes on appending to that file when the conversation is
/// resumed from somewhere else: a workspace that was renamed, a path reached
/// through a symlink. So a file that exists under the session's id wins over
/// the path derived from where the checkout is now (#250). With no file
/// anywhere — a conversation that has yet to be written — it is the derived
/// path.
pub fn locate(cwd: &str, session_id: &str) -> Option<PathBuf> {
    Some(locate_in(&projects_root()?, cwd, session_id))
}

/// [`locate`] within a given projects folder.
pub fn locate_in(projects: &Path, cwd: &str, session_id: &str) -> PathBuf {
    let derived = transcript_in(projects, cwd, session_id);
    // An id is a file name here, never a path.
    if derived.exists() || session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.starts_with('.') {
        return derived;
    }
    let name = format!("{session_id}.jsonl");
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    std::fs::read_dir(projects)
        .into_iter()
        .flatten()
        .flatten()
        .map(|folder| folder.path().join(&name))
        // A regular file: a link of that name is somebody else's file.
        .filter(|candidate| std::fs::symlink_metadata(candidate).is_ok_and(|m| m.file_type().is_file()))
        // The same conversation in two folders is one the CLI moved on from;
        // the copy it is still writing is the newer.
        .max_by_key(|candidate| modified(candidate))
        .unwrap_or(derived)
}

/// Put a conversation's transcript where the CLI will look for it when it is
/// resumed in `to`.
///
/// `--resume <id>` reads the folder named for the directory it is run in.
/// That is the same folder for a renamed checkout or another worktree of the
/// repository, but not when a session moves to an unrelated directory: a
/// quick chat pointed at a folder, or moved into a project. `keep_source`
/// leaves the original where it was, for a fork, whose parent goes on being
/// used from there.
///
/// Returns whether anything was put there. A conversation with no file yet,
/// or one that is already in `to`'s folder, needs nothing.
pub fn rehome_in(projects: &Path, from: &str, to: &str, session_id: &str, keep_source: bool) -> std::io::Result<bool> {
    let source = locate_in(projects, from, session_id);
    let target = transcript_in(projects, to, session_id);
    let is_file = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file());
    if source == target || !is_file(&source) || std::fs::symlink_metadata(&target).is_ok() {
        return Ok(false);
    }
    let folder = target.parent().expect("a transcript is in a folder");
    std::fs::create_dir_all(folder)?;
    // What the CLI keeps beside a transcript (subagent logs, tool results) is
    // in a directory named for the conversation.
    let side = source.with_extension("");
    let side_target = target.with_extension("");
    if keep_source {
        std::fs::copy(&source, &target)?;
    } else if std::fs::rename(&source, &target).is_err() {
        // Another volume: copy, then let go of the original.
        std::fs::copy(&source, &target)?;
        let _ = std::fs::remove_file(&source);
    }
    if !keep_source && std::fs::symlink_metadata(&side).is_ok_and(|meta| meta.is_dir()) && std::fs::symlink_metadata(&side_target).is_err() {
        // Best effort: the conversation resumes without it.
        let _ = std::fs::rename(&side, &side_target);
    }
    Ok(true)
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
    let path = locate(cwd, session_id)?;
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
/// Every character outside `[A-Za-z0-9-]` becomes `-`, which is why a
/// dot-folder yields a double dash. The encoding loses information: two
/// different paths can share a name.
pub fn encoded_cwd(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect()
}

/// Where the CLI files the transcript of a session started in `cwd`.
pub fn transcript_in(projects: &Path, cwd: &str, session_id: &str) -> PathBuf {
    projects.join(encoded_cwd(cwd)).join(format!("{session_id}.jsonl"))
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

/// What a local slash command prints (`/model`'s "Set model to …") and the
/// caveat the CLI writes ahead of it. They are `user` records only because
/// that is where the CLI keeps what the model should see next; nobody typed
/// them.
fn command_output(text: &str) -> bool {
    let text = text.trim_start();
    ["<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>"].iter().any(|tag| text.starts_with(tag))
}

/// The text of a prompt without the wrapper the CLI puts round a large
/// paste: `<pasted_content id="7">`, the text, `</pasted_content id="7">`.
/// The wrapper is the CLI's note to the model; the reader pasted the text.
fn without_paste_wrappers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = ["<pasted_content id=\"", "</pasted_content"].iter().filter_map(|tag| rest.find(tag)).min() {
        let Some(len) = rest[at..].find('>') else { break };
        let tag = &rest[at..=at + len];
        // Only the CLI's own tag: a short one, on one line.
        if tag.len() > 64 || tag.contains('\n') {
            out.push_str(&rest[..=at]);
            rest = &rest[at + 1..];
            continue;
        }
        let closing = tag.starts_with("</");
        let before = &rest[..at];
        out.push_str(if closing { before.strip_suffix('\n').unwrap_or(before) } else { before });
        rest = &rest[at + len + 1..];
        if !closing {
            rest = rest.strip_prefix('\n').unwrap_or(rest);
        }
    }
    out.push_str(rest);
    out
}

/// A prompt as the reader typed it: a slash command by its name, anything
/// else without the CLI's paste wrappers.
fn as_typed(prompt: String) -> String {
    slash_command(&prompt).unwrap_or_else(|| if prompt.contains("pasted_content") { without_paste_wrappers(&prompt) } else { prompt })
}

fn tagged<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let from = text.find(&open)? + open.len();
    let to = from + text[from..].find(&close)?;
    Some(text[from..to].trim())
}

/// A slash command as the reader typed it. The CLI records `/model opus` as
/// `<command-name>/model</command-name> … <command-args>opus</command-args>`;
/// the chat shows what was typed, which is also what the composer published
/// if the command was sent from there.
fn slash_command(text: &str) -> Option<String> {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("<command-name>") && !trimmed.starts_with("<command-message>") {
        return None;
    }
    let name = tagged(trimmed, "command-name").filter(|n| !n.is_empty())?;
    let slash = if name.starts_with('/') { "" } else { "/" };
    Some(match tagged(trimmed, "command-args").filter(|a| !a.is_empty()) {
        Some(args) => format!("{slash}{name} {args}"),
        None => format!("{slash}{name}"),
    })
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
        "attachment" => {
            let before = out.len();
            decode_queued_prompt(&v, out);
            return (out.len() > before).then_some(TurnMark::Opened);
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
    if command_output(&prompt) {
        return;
    }
    let text = as_typed(prompt);
    out.push(Payload::UserMessage { text, images: Vec::new(), baseline: None, queued: false, cwd: v["cwd"].as_str().map(String::from) });
}

/// A prompt typed while a turn was running. The CLI queues it, hands it to
/// the model alongside the next tool result, and records it as a
/// `queued_command` attachment instead of a `user` record — so this is the
/// only place a prompt typed into the terminal mid-turn is ever written.
///
/// The same attachment carries things nobody typed: a background task
/// reporting in (`commandMode: "task-notification"`) and a message from
/// another agent (`origin.kind: "peer"`, marked meta). Those stay out.
fn decode_queued_prompt(v: &Value, out: &mut Vec<Payload>) {
    let a = &v["attachment"];
    if a["type"] != "queued_command" || a["commandMode"] != "prompt" || a["isMeta"].as_bool().unwrap_or(false) {
        return;
    }
    // Older CLIs wrote no origin at all on a typed prompt.
    if !matches!(a["origin"]["kind"].as_str(), None | Some("human")) {
        return;
    }
    let prompt = text_of(&a["prompt"]);
    if prompt.trim().is_empty() || command_output(&prompt) {
        return;
    }
    let text = as_typed(prompt);
    out.push(Payload::UserMessage { text, images: Vec::new(), baseline: None, queued: false, cwd: v["cwd"].as_str().map(String::from) });
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
        // The record names the model that answered; `<synthetic>` is the CLI speaking for itself.
        let model = v["message"]["model"].as_str().filter(|m| m.starts_with("claude-")).map(String::from);
        out.push(Payload::UsageUpdate(Usage { context_used: Some(used), model, ..Default::default() }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::tui::Streamer;

    const FIXTURE: &str = r#"{"type":"queue-operation","timestamp":"2026-09-02T02:41:16.631Z","sessionId":"s"}
{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u1","timestamp":"2026-09-02T02:41:18.686Z","userType":"external","cwd":"/tmp/x","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"Add multiply"}]}}
{"parentUuid":"u1","isSidechain":false,"type":"assistant","uuid":"a1","timestamp":"2026-09-02T02:41:23.156Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}
{"parentUuid":"a1","isSidechain":false,"type":"assistant","uuid":"a2","timestamp":"2026-09-02T02:41:23.158Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m1","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"Looking first."}],"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":5}}}
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
        assert!(matches!(&p[3], Payload::UsageUpdate(u) if u.context_used == Some(105) && u.model.as_deref() == Some("claude-opus-5-5")));
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

    /// The records below are the shapes Claude Code 2.1.283–2.1.287 wrote in
    /// real interactive sessions, cut down to the keys the decoder reads and
    /// with the text replaced.
    fn queued(prompt: &str, mode: &str, attachment_extra: &str) -> String {
        format!(
            r#"{{"parentUuid":"a1","isSidechain":false,"attachment":{{"type":"queued_command","prompt":"{prompt}","source_uuid":"q1","commandMode":"{mode}"{attachment_extra}}},"type":"attachment","uuid":"q-{mode}","userType":"external","cwd":"/tmp/x","sessionId":"s","version":"2.1.287"}}"#
        )
    }

    /// #250. A prompt typed into the terminal while a turn is running is
    /// never written as a `user` record: the CLI queues it and records a
    /// `queued_command` attachment when it hands it to the model. Decoding
    /// only `user` records left it out of the chat altogether.
    #[test]
    fn a_prompt_typed_while_a_turn_was_running_is_a_prompt() {
        let typed = queued("also check the tests", "prompt", r#","origin":{"kind":"human"},"humanTurn":true"#);
        let mut out = Vec::new();
        let mark = decode_marked(&typed, &HashSet::new(), &mut out);
        assert!(matches!(out.as_slice(), [Payload::UserMessage { text, queued: false, baseline: None, cwd: Some(cwd), .. }] if text == "also check the tests" && cwd == "/tmp/x"));
        assert_eq!(mark, Some(TurnMark::Opened));

        // An older CLI wrote no origin on what the reader typed.
        let mut out = Vec::new();
        decode_line(&queued("no origin", "prompt", ""), &HashSet::new(), &mut out);
        assert!(matches!(out.as_slice(), [Payload::UserMessage { text, .. }] if text == "no origin"));

        // A fork's copy of it is history like any other record.
        let mut out = Vec::new();
        decode_line(&typed, &HashSet::from(["q-prompt".to_string()]), &mut out);
        assert!(out.is_empty());
    }

    /// The same attachment carries what nobody typed: a background task
    /// reporting in, and another agent's message. Neither is the reader's.
    #[test]
    fn what_was_queued_by_something_other_than_the_reader_is_not_a_prompt() {
        for record in [
            queued("<task-notification>done</task-notification>", "task-notification", r#","origin":{"kind":"task-notification"}"#),
            queued("<task-notification>done</task-notification>", "task-notification", ""),
            queued("from another agent", "prompt", r#","origin":{"kind":"peer"},"isMeta":true"#),
            queued("from another agent", "prompt", r#","origin":{"kind":"peer"}"#),
            queued("   ", "prompt", r#","origin":{"kind":"human"}"#),
            r#"{"type":"attachment","uuid":"h1","attachment":{"type":"hook_success","content":"ok"}}"#.to_string(),
        ] {
            let mut out = Vec::new();
            assert_eq!(decode_marked(&record, &HashSet::new(), &mut out), None, "{record}");
            assert!(out.is_empty(), "{record}");
        }
    }

    /// A slash command reads as it was typed, which is what the composer
    /// shows for one sent from there; what the command printed is not a
    /// message from anybody.
    #[test]
    fn a_slash_command_reads_as_typed_and_its_output_is_not_a_prompt() {
        let user = |content: &str| format!(r#"{{"parentUuid":"a1","isSidechain":false,"type":"user","uuid":"c1","userType":"external","cwd":"/tmp/x","sessionId":"s","message":{{"role":"user","content":"{content}"}}}}"#);
        let decode = |line: String| {
            let mut out = Vec::new();
            decode_line(&line, &HashSet::new(), &mut out);
            out
        };
        let typed = |line: String| match decode(line).as_slice() {
            [Payload::UserMessage { text, .. }] => text.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(typed(user(r"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>")), "/model");
        assert_eq!(typed(user(r"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>")), "/model opus");
        assert_eq!(typed(user(r"<command-message>review is running…</command-message>\n<command-name>review</command-name>\n<command-args>the last commit</command-args>")), "/review the last commit");
        // Prose that merely mentions a tag is prose.
        assert_eq!(typed(user("what does <command-name> mean?")), "what does <command-name> mean?");

        assert!(decode(user(r"<local-command-stdout>Set model to opus</local-command-stdout>")).is_empty());
        assert!(decode(user(r"<local-command-stderr>no such model</local-command-stderr>")).is_empty());
        assert!(decode(user(r"<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>")).is_empty());
    }

    /// #250. The CLI files a transcript under the folder the conversation
    /// began in and keeps writing there when it is resumed from another. A
    /// renamed workspace derives a folder the CLI never wrote to, the tab
    /// followed a file that did not exist, and nothing the transcript said —
    /// the reader's own prompts included — reached the chat.
    #[test]
    fn a_resumed_conversation_is_followed_where_the_cli_keeps_it() {
        let config = tempfile::tempdir().unwrap();
        let home = &config.path().join("projects");
        let (began, now) = ("/Users/dev/repo/.raccoon/worktrees/eager-moss-panda", "/Users/dev/repo/.raccoon/worktrees/cloud-vm");

        // Nothing written yet: a new conversation goes where the CLI will put it.
        let derived = transcript_in(home, now, "abc");
        assert_eq!(locate_in(home, now, "abc"), derived);

        let kept = transcript_in(home, began, "abc");
        std::fs::create_dir_all(kept.parent().unwrap()).unwrap();
        std::fs::write(&kept, "{}\n").unwrap();
        std::fs::write(kept.with_file_name("other.jsonl"), "{}\n").unwrap();
        assert_eq!(locate_in(home, now, "abc"), kept, "the file that exists, not the one the folder's name derives");
        assert_eq!(locate_in(home, began, "abc"), kept);
        assert_eq!(locate_in(home, now, "missing"), transcript_in(home, now, "missing"));

        // Once the CLI does write under the new folder, that is the one.
        std::fs::create_dir_all(derived.parent().unwrap()).unwrap();
        std::fs::write(&derived, "{}\n").unwrap();
        assert_eq!(locate_in(home, now, "abc"), derived);

        // A link of the conversation's name is not the conversation.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&kept, kept.with_file_name("linked.jsonl")).unwrap();
            assert_eq!(locate_in(home, now, "linked"), transcript_in(home, now, "linked"));
        }

        // An id is a file name; it is never used to walk somewhere else.
        for id in ["../other", "a/b", "", ".."] {
            assert_eq!(locate_in(home, now, id), transcript_in(home, now, id));
        }
    }

    #[test]
    fn a_transcript_follows_its_conversation_to_an_unrelated_directory() {
        let config = tempfile::tempdir().unwrap();
        let home = &config.path().join("projects");
        let (scratch, project) = ("/Users/dev/.raccoon/quick/0198", "/Users/dev/code/api");
        // Nothing written yet: nothing to carry.
        assert!(!rehome_in(home, scratch, project, "abc", false).unwrap());

        let began = transcript_in(home, scratch, "abc");
        std::fs::create_dir_all(began.with_extension("")).unwrap();
        std::fs::write(&began, "{\"type\":\"user\"}\n").unwrap();
        std::fs::write(began.with_extension("").join("subagent.jsonl"), "{}\n").unwrap();

        // A fork leaves its parent where the parent is still used from.
        assert!(rehome_in(home, scratch, "/Users/dev/.raccoon/quick/0199", "abc", true).unwrap());
        assert!(began.exists());
        assert_eq!(std::fs::read_to_string(transcript_in(home, "/Users/dev/.raccoon/quick/0199", "abc")).unwrap(), "{\"type\":\"user\"}\n");
        std::fs::remove_file(transcript_in(home, "/Users/dev/.raccoon/quick/0199", "abc")).unwrap();

        // A move takes the file, and what the CLI kept beside it, along.
        assert!(rehome_in(home, scratch, project, "abc", false).unwrap());
        let moved = transcript_in(home, project, "abc");
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "{\"type\":\"user\"}\n");
        assert!(moved.with_extension("").join("subagent.jsonl").exists());
        assert!(!began.exists());
        assert_eq!(locate_in(home, project, "abc"), moved);

        // Already where it is wanted, or asked for under a name that is a path: nothing happens.
        assert!(!rehome_in(home, scratch, project, "abc", false).unwrap());
        assert!(!rehome_in(home, project, project, "abc", false).unwrap());
        assert!(!rehome_in(home, project, scratch, "../abc", false).unwrap());
        assert!(moved.exists());

        // What is already in the destination is never overwritten.
        std::fs::create_dir_all(began.parent().unwrap()).unwrap();
        std::fs::write(&began, "other\n").unwrap();
        assert!(!rehome_in(home, project, scratch, "abc", false).unwrap());
        assert_eq!(std::fs::read_to_string(&began).unwrap(), "other\n");
    }

    /// The CLI wraps a large paste in a tag of its own. The reader pasted
    /// the text, and a composer send of the same text has to match it.
    #[test]
    fn a_pasted_prompt_reads_without_the_cli_s_wrapper() {
        let user = |content: &str| format!(r#"{{"type":"user","uuid":"p1","cwd":"/tmp/x","message":{{"role":"user","content":"{content}"}}}}"#);
        let typed = |line: String| {
            let mut out = Vec::new();
            decode_line(&line, &HashSet::new(), &mut out);
            match out.as_slice() {
                [Payload::UserMessage { text, .. }] => text.clone(),
                other => panic!("{other:?}"),
            }
        };
        // The shape Claude Code 2.1.285 writes: the closing tag repeats the id.
        assert_eq!(typed(user(r#"<pasted_content id=\"6997\">\nYou are reviewing\na long paste\n</pasted_content id=\"6997\">"#)), "You are reviewing\na long paste");
        assert_eq!(typed(user(r#"see this:\n<pasted_content id=\"1\">\nfirst\n</pasted_content>\nand this:\n<pasted_content id=\"2\">\nsecond\n</pasted_content id=\"2\">\nthanks"#)), "see this:\nfirst\nand this:\nsecond\nthanks");
        // Prose about the tag, and a tag that never closes, are left alone.
        assert_eq!(typed(user("what is pasted_content for?")), "what is pasted_content for?");
        assert_eq!(typed(user(r#"a <pasted_content id=\"3 that never ends"#)), r#"a <pasted_content id="3 that never ends"#);
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
        let p = transcript_in(Path::new("/h/.claude/projects"), "/Users/dev/code/ai/raccoon-e2e/.raccoon/worktrees/sly-ochre-hare", "abc");
        assert_eq!(p, Path::new("/h/.claude/projects/-Users-dev-code-ai-raccoon-e2e--raccoon-worktrees-sly-ochre-hare/abc.jsonl"));
    }
}
