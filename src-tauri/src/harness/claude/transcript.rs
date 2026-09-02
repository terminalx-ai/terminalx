//! Claude Code's own transcript, read back after a terminal-view spell.
//!
//! The CLI writes every session to `~/.claude/projects/<encoded cwd>/<id>.jsonl`
//! whether it was driven headless by the app or interactively in a terminal.
//! When a tab comes back from the terminal, the entries newer than the app's
//! last recorded event are exactly what was said there; they are turned into
//! the app's own events so the chat view shows the whole conversation.
//!
//! Only prose and tool calls are imported. Thinking blocks, attachments and
//! the CLI's bookkeeping records (`queue-operation`, `last-prompt`, …) are
//! skipped; they carry nothing the transcript view would draw.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::events::{Payload, ToolResult, ToolType, TurnStatus};

/// Where the CLI keeps the transcript for a session run in `cwd`. Every
/// character outside `[A-Za-z0-9-]` becomes `-`, which is why a dot-folder
/// yields a double dash.
pub fn cli_transcript_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let encoded: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    Some(home.join(".claude").join("projects").join(encoded).join(format!("{session_id}.jsonl")))
}

fn tool_type(name: &str) -> ToolType {
    match name {
        "Bash" => ToolType::Shell,
        "Read" => ToolType::FileRead,
        "Edit" | "MultiEdit" | "NotebookEdit" => ToolType::FileEdit,
        "Write" => ToolType::FileWrite,
        "Grep" | "Glob" | "LS" => ToolType::Search,
        "WebFetch" | "WebSearch" => ToolType::Web,
        "Task" => ToolType::SubagentSpawn,
        "AskUserQuestion" => ToolType::Question,
        n if n.starts_with("mcp__") => ToolType::Mcp,
        _ => ToolType::Other,
    }
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

/// Events for everything the CLI recorded after `after_ts` (an RFC 3339
/// timestamp, compared lexically, which is sound for the CLI's UTC `Z` form).
/// A turn closes when the next prompt arrives or the file ends.
pub fn import_after(text: &str, after_ts: Option<&str>) -> Vec<Payload> {
    let mut out = Vec::new();
    let mut turn_open = false;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let ts = v["timestamp"].as_str().unwrap_or("");
        if let Some(after) = after_ts {
            if ts.is_empty() || ts <= after {
                continue;
            }
        }
        if v["isSidechain"].as_bool().unwrap_or(false) || v["isMeta"].as_bool().unwrap_or(false) {
            continue;
        }
        let kind = v["type"].as_str().unwrap_or("");
        let content = &v["message"]["content"];
        match kind {
            "user" => {
                let parts = content.as_array().cloned().unwrap_or_else(|| vec![serde_json::json!({"type": "text", "text": content.as_str().unwrap_or("")})]);
                let results: Vec<&Value> = parts.iter().filter(|p| p["type"] == "tool_result").collect();
                if !results.is_empty() {
                    for r in results {
                        let call_id = r["tool_use_id"].as_str().unwrap_or("").to_string();
                        let is_error = r["is_error"].as_bool().unwrap_or(false);
                        out.push(Payload::ToolCallCompleted { call_id, result: ToolResult { text: text_of(&r["content"]), is_error, ..Default::default() } });
                    }
                    continue;
                }
                let prompt = text_of(content);
                if prompt.trim().is_empty() {
                    continue;
                }
                if turn_open {
                    out.push(Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false });
                }
                out.push(Payload::UserMessage { text: prompt, images: Vec::new(), baseline: None, queued: false, cwd: v["cwd"].as_str().map(String::from) });
                turn_open = true;
            }
            "assistant" => {
                for p in content.as_array().into_iter().flatten() {
                    match p["type"].as_str().unwrap_or("") {
                        "text" => {
                            let t = p["text"].as_str().unwrap_or("");
                            if !t.trim().is_empty() {
                                out.push(Payload::AssistantText { block: None, text: t.to_string() });
                                turn_open = true;
                            }
                        }
                        "tool_use" => {
                            let name = p["name"].as_str().unwrap_or("tool").to_string();
                            out.push(Payload::ToolCallStarted {
                                call_id: p["id"].as_str().unwrap_or("").to_string(),
                                tool_type: tool_type(&name),
                                input: p["input"].clone(),
                                title: Some(super::mapper::tool_title(&name, &p["input"])),
                                name,
                            });
                            turn_open = true;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if turn_open {
        out.push(Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false });
    }
    out
}

/// Path check without the home lookup, for tests and callers that have one.
#[allow(dead_code)]
pub fn transcript_under(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    let encoded: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    home.join(".claude").join("projects").join(encoded).join(format!("{session_id}.jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{"type":"queue-operation","timestamp":"2026-09-02T02:41:16.631Z","sessionId":"s"}
{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u1","timestamp":"2026-09-02T02:41:18.686Z","userType":"external","cwd":"/tmp/x","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"Add multiply"}]}}
{"parentUuid":"u1","isSidechain":false,"type":"assistant","uuid":"a1","timestamp":"2026-09-02T02:41:23.156Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}
{"parentUuid":"a1","isSidechain":false,"type":"assistant","uuid":"a2","timestamp":"2026-09-02T02:41:23.158Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Looking first."}]}}
{"parentUuid":"a2","isSidechain":false,"type":"assistant","uuid":"a3","timestamp":"2026-09-02T02:41:24.816Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"cat src/math.js"}}]}}
{"parentUuid":"a3","isSidechain":false,"type":"user","uuid":"u2","timestamp":"2026-09-02T02:41:26.219Z","cwd":"/tmp/x","sessionId":"s","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"export const x = 1;"}]}}
{"parentUuid":"u2","isSidechain":false,"type":"assistant","uuid":"a4","timestamp":"2026-09-02T02:41:30.000Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"Done."}]}}
{"type":"last-prompt","sessionId":"s"}
{"parentUuid":"a4","isSidechain":false,"type":"user","uuid":"u3","timestamp":"2026-09-02T02:45:00.000Z","cwd":"/tmp/x","sessionId":"s","message":{"role":"user","content":"Thanks, now add divide"}}
{"parentUuid":"u3","isSidechain":false,"type":"assistant","uuid":"a5","timestamp":"2026-09-02T02:45:05.000Z","cwd":"/tmp/x","sessionId":"s","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"Added divide."}]}}
"#;

    #[test]
    fn imports_turns_tools_and_closes_them() {
        let p = import_after(FIXTURE, None);
        let kinds: Vec<&str> = p
            .iter()
            .map(|x| match x {
                Payload::UserMessage { .. } => "user",
                Payload::AssistantText { .. } => "text",
                Payload::ToolCallStarted { .. } => "tool",
                Payload::ToolCallCompleted { .. } => "result",
                Payload::TurnCompleted { .. } => "end",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["user", "text", "tool", "result", "text", "end", "user", "text", "end"]);
        assert!(matches!(&p[2], Payload::ToolCallStarted { tool_type: ToolType::Shell, name, .. } if name == "Bash"));
        assert!(matches!(&p[6], Payload::UserMessage { text, .. } if text == "Thanks, now add divide"));
    }

    #[test]
    fn only_entries_after_the_cursor_are_imported() {
        let p = import_after(FIXTURE, Some("2026-09-02T02:41:30.000Z"));
        assert_eq!(p.len(), 3);
        assert!(matches!(&p[0], Payload::UserMessage { text, .. } if text == "Thanks, now add divide"));
        assert!(matches!(&p[2], Payload::TurnCompleted { status: TurnStatus::Ok, .. }));
    }

    #[test]
    fn encodes_the_project_folder_like_the_cli() {
        let p = transcript_under(Path::new("/h"), "/Users/dev/code/ai/raccoon-e2e/.raccoon/worktrees/sly-ochre-hare", "abc");
        assert_eq!(p, Path::new("/h/.claude/projects/-Users-dev-code-ai-raccoon-e2e--raccoon-worktrees-sly-ochre-hare/abc.jsonl"));
    }
}
