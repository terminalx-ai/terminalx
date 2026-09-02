//! Codex's own rollout, read as it is written.
//!
//! Codex appends one JSON record per event to
//! `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, interactive or
//! not. A PTY-first tab has no wire protocol to read, so this file **is** the
//! conversation.
//!
//! Each record is `{"timestamp", "ordinal", "type", "payload"}` and there are
//! two kinds worth knowing apart:
//!
//! - **`event_msg`** is the stream the TUI itself draws from: typed items
//!   (`UserMessage`, `AgentMessage`, `CommandExecution`, `FileChange`,
//!   `Reasoning`…) plus turn and usage bookkeeping. This is the conversation.
//! - **`response_item`** is the model's input tape: the same messages again,
//!   but also the developer prompts, the environment context, the encrypted
//!   reasoning blobs and the `exec` wrapper Codex builds around every shell
//!   command. Drawing it would show the reader the harness rather than the
//!   conversation, so it is skipped whole.
//!
//! `session_meta`, `turn_context`, `world_state` and `thread_settings_applied`
//! are configuration snapshots and carry nothing the transcript view draws.
//!
//! Every shape here came out of rollouts written by codex-cli 0.152.0 driven
//! through a PTY; one of them is the fixture this module is tested on.

use serde_json::Value;

use crate::events::{BlockRef, EditKind, FileEdit, Payload, ToolResult, ToolType, Usage};

fn block(id: &str) -> BlockRef {
    BlockRef { message_id: id.to_string(), index: 0 }
}

/// The text of an item's `content` array. Codex capitalises the variant in
/// the item stream (`Text`) and lower-cases it on the wire (`text`,
/// `input_text`, `output_text`); all of them are prose.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| match p["type"].as_str().unwrap_or("") {
                "Text" | "text" | "input_text" | "output_text" => p["text"].as_str().map(String::from),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A `Reasoning` item's prose. The summary is what the reader is meant to
/// see; `raw_content` is only present when the model was asked for it.
fn reasoning_text(item: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for key in ["summary_text", "raw_content"] {
        for p in item[key].as_array().into_iter().flatten() {
            let t = p.as_str().map(String::from).or_else(|| p["text"].as_str().map(String::from)).unwrap_or_default();
            if !t.is_empty() {
                parts.push(t);
            }
        }
    }
    parts.join("\n")
}

/// The command a `CommandExecution` ran. Codex records the argv it handed the
/// shell (`["/bin/zsh", "-lc", "…"]`); the last element is the command the
/// reader meant.
fn command_of(item: &Value) -> String {
    let argv = item["command"].as_array();
    match argv {
        Some(a) if a.len() > 1 => a.last().and_then(|c| c.as_str()).unwrap_or_default().to_string(),
        Some(a) => a.iter().filter_map(|c| c.as_str()).collect::<Vec<_>>().join(" "),
        None => item["command"].as_str().unwrap_or_default().to_string(),
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

/// `file:///a/b` as Codex writes an item's cwd, back to a path.
fn plain_path(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    Some(s.strip_prefix("file://").unwrap_or(s).to_string())
}

/// One rollout record as payloads. Unknown records yield nothing.
///
/// `_skip` is the tail's list of records already logged under another id; it
/// is a Claude fork's problem and Codex has no equivalent, since a Codex
/// conversation is only ever appended to.
pub fn decode_line(line: &str, _skip: &std::collections::HashSet<String>, out: &mut Vec<Payload>) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    if v["type"].as_str() != Some("event_msg") {
        return;
    }
    let p = &v["payload"];
    match p["type"].as_str().unwrap_or("") {
        "task_started" => out.push(Payload::ModelRequestStarted),
        // `task_complete` and `turn_aborted` say the turn ended, and so do the
        // `Stop` and `Interrupt` hooks — with the same reply and moments
        // apart. Two closers is one too many: the second lands as a turn with
        // no prompt in front of it and draws the reply again under a second
        // "worked for" line. The hooks are the authority (they are what closes
        // a Claude turn too, and they carry the same `last_assistant_message`),
        // so these records only carry the tail forward to them.
        "task_complete" | "turn_aborted" => {}
        "token_count" => {
            let info = &p["info"];
            // `last` is what the next request will carry, which is occupancy;
            // `total` is cumulative over the turn and would over-report it
            // several times.
            let last = &info["last_token_usage"];
            if let Some(used) = last["total_tokens"].as_u64() {
                out.push(Payload::UsageUpdate(Usage {
                    input_tokens: last["input_tokens"].as_u64(),
                    output_tokens: last["output_tokens"].as_u64(),
                    context_used: Some(used),
                    context_max: info["model_context_window"].as_u64(),
                    cost_usd: None,
                }));
            }
        }
        "context_compacted" => out.push(Payload::ContextCompacted { pre_tokens: None, post_tokens: None }),
        "stream_error" | "error" => {
            let message = p["message"].as_str().or_else(|| p["error"]["message"].as_str()).unwrap_or("Codex reported an error");
            out.push(Payload::Error { message: message.to_string(), fatal: false });
        }
        "item_completed" => decode_item(&p["item"], out),
        _ => {}
    }
}

fn decode_item(item: &Value, out: &mut Vec<Payload>) {
    let id = item["id"].as_str().unwrap_or_default().to_string();
    match item["type"].as_str().unwrap_or("") {
        "UserMessage" => {
            let text = text_of(&item["content"]);
            if !text.is_empty() {
                out.push(Payload::UserMessage { text, images: Vec::new(), baseline: None, queued: false, cwd: None });
            }
        }
        "AgentMessage" => {
            let text = text_of(&item["content"]);
            if !text.is_empty() {
                out.push(Payload::AssistantText { block: Some(block(&id)), text });
            }
        }
        "Reasoning" => {
            let text = reasoning_text(item);
            if !text.is_empty() {
                out.push(Payload::Reasoning { block: Some(block(&id)), text });
            }
        }
        "CommandExecution" => {
            let command = command_of(item);
            out.push(Payload::ToolCallStarted {
                call_id: id.clone(),
                name: "shell".into(),
                tool_type: ToolType::Shell,
                input: serde_json::json!({"command": command, "cwd": plain_path(&item["cwd"])}),
                title: Some(format!("shell {}", first_line(&command))),
            });
            let status = item["status"].as_str().unwrap_or("completed");
            let exit_code = item["exit_code"].as_i64().map(|c| c as i32);
            let is_error = status != "completed" || exit_code.is_some_and(|c| c != 0);
            let text = item["aggregated_output"]
                .as_str()
                .or_else(|| item["formatted_output"].as_str())
                .map(String::from)
                .unwrap_or_else(|| if is_error { format!("Command {status}") } else { String::new() });
            out.push(Payload::ToolCallCompleted { call_id: id, result: ToolResult { text, is_error, exit_code, ..Default::default() } });
        }
        "FileChange" => {
            let edits = file_edits(&item["changes"]);
            let paths: Vec<&str> = edits.iter().map(|e| e.path.as_str()).collect();
            out.push(Payload::ToolCallStarted {
                call_id: id.clone(),
                name: "apply_patch".into(),
                tool_type: ToolType::FileEdit,
                input: serde_json::json!({"paths": paths}),
                title: Some(match paths.as_slice() {
                    [one] => format!("apply_patch {one}"),
                    many => format!("apply_patch {} files", many.len()),
                }),
            });
            if !edits.is_empty() {
                out.push(Payload::FileEdits { call_id: Some(id.clone()), edits });
            }
            let failed = item["status"].as_str().unwrap_or("completed") != "completed";
            let text = item["stderr"].as_str().filter(|s| !s.is_empty()).or_else(|| item["stdout"].as_str()).unwrap_or_default().to_string();
            out.push(Payload::ToolCallCompleted { call_id: id, result: ToolResult { text, is_error: failed, ..Default::default() } });
        }
        "McpToolCall" => {
            let name = format!("mcp__{}__{}", item["server"].as_str().unwrap_or("mcp"), item["tool"].as_str().unwrap_or("call"));
            out.push(Payload::ToolCallStarted {
                call_id: id.clone(),
                name: name.clone(),
                tool_type: ToolType::Mcp,
                input: item["arguments"].clone(),
                title: Some(name),
            });
            let failed = item["status"].as_str().unwrap_or("completed") != "completed";
            out.push(Payload::ToolCallCompleted {
                call_id: id,
                result: ToolResult { text: text_of(&item["result"]), is_error: failed, ..Default::default() },
            });
        }
        "WebSearch" => {
            let query = item["query"].as_str().unwrap_or_default().to_string();
            out.push(Payload::ToolCallStarted {
                call_id: id.clone(),
                name: "web_search".into(),
                tool_type: ToolType::Web,
                input: serde_json::json!({"query": query}),
                title: Some(format!("web_search {query}")),
            });
            out.push(Payload::ToolCallCompleted { call_id: id, result: ToolResult::default() });
        }
        "Error" => out.push(Payload::Error { message: item["message"].as_str().unwrap_or("Codex reported an error").to_string(), fatal: false }),
        _ => {}
    }
}

/// A `FileChange` item's `changes`: a map of path to what happened to it,
/// with the diff already made.
fn file_edits(changes: &Value) -> Vec<FileEdit> {
    let Some(map) = changes.as_object() else { return Vec::new() };
    let mut edits: Vec<FileEdit> = map
        .iter()
        .map(|(path, change)| FileEdit {
            path: path.clone(),
            old_text: None,
            new_text: None,
            unified: change["unified_diff"].as_str().map(String::from),
            kind: match change["type"].as_str().unwrap_or("update") {
                "add" => EditKind::Create,
                "delete" => EditKind::Delete,
                _ if change["move_path"].as_str().is_some() => EditKind::Rename,
                _ => EditKind::Update,
            },
        })
        .collect();
    edits.sort_by(|a, b| a.path.cmp(&b.path));
    edits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::tui::Streamer;

    fn none() -> std::collections::HashSet<String> {
        std::collections::HashSet::new()
    }

    /// A rollout the installed CLI wrote itself, running interactively in a
    /// PTY: one turn, then two more after `codex resume` reopened the same
    /// conversation. The model's standing instructions and the environment
    /// preamble are trimmed for size, and everything that described the
    /// account or the machine that recorded it is gone: the `rate_limits`
    /// records (plan, usage, credit balance) were removed whole, the local
    /// timezone reads `UTC` and every `process_id` reads `0`. Every record,
    /// key and value the decoder actually reads is exactly as Codex wrote it.
    const FIXTURE: &str = include_str!("fixtures/rollout.jsonl");

    fn kinds(payloads: &[Payload]) -> Vec<&'static str> {
        payloads
            .iter()
            .map(|p| match p {
                Payload::UserMessage { .. } => "user",
                Payload::AssistantText { .. } => "text",
                Payload::Reasoning { .. } => "thinking",
                Payload::ToolCallStarted { .. } => "tool",
                Payload::ToolCallCompleted { .. } => "result",
                Payload::FileEdits { .. } => "edits",
                Payload::UsageUpdate(_) => "usage",
                Payload::ModelRequestStarted => "start",
                Payload::TurnCompleted { .. } => "end",
                Payload::ContextCompacted { .. } => "compacted",
                Payload::Error { .. } => "error",
                _ => "other",
            })
            .collect()
    }

    #[test]
    fn decodes_three_real_turns_from_the_item_stream() {
        let mut s = Streamer::at(0, decode_line);
        let p = s.push(FIXTURE.as_bytes());
        assert_eq!(
            kinds(&p),
            vec![
                // "reply with the word ok"
                "start", "user", "text", "usage",
                // `date`, then a write outside the workspace that was approved
                "start", "user", "text", "tool", "result", "usage", "tool", "result", "usage", "text", "usage",
                // an apply_patch, then a sentence about it
                "start", "user", "text", "tool", "result", "usage", "tool", "edits", "result", "usage", "text", "usage",
            ]
        );
        assert!(matches!(&p[1], Payload::UserMessage { text, .. } if text == "reply with the word ok"));
        assert!(matches!(&p[2], Payload::AssistantText { text, .. } if text == "ok"));
    }

    /// Three turns end in this file, and none of them closes a turn here: the
    /// `Stop` hook does that, carrying the same reply, and two closers for one
    /// turn draw the reply twice — once as itself and once as the final text
    /// of a turn that had no prompt in front of it.
    #[test]
    fn the_turn_end_records_leave_the_closing_to_the_hook() {
        assert_eq!(FIXTURE.matches(r#""type": "task_complete""#).count(), 3);
        let mut s = Streamer::at(0, decode_line);
        let p = s.push(FIXTURE.as_bytes());
        assert!(!p.iter().any(|p| matches!(p, Payload::TurnCompleted { .. })));

        let mut out = Vec::new();
        decode_line(r#"{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t"}}"#, &none(), &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn the_same_file_in_awkward_chunks_decodes_identically() {
        let mut whole = Streamer::at(0, decode_line);
        let expected = kinds(&whole.push(FIXTURE.as_bytes()));
        assert_eq!(whole.offset(), FIXTURE.len() as u64);

        // Cuts inside a record, inside a multi-byte character, and at a
        // newline: a line that arrives in three pieces is one line.
        let mid = FIXTURE.find("Wed Sep").unwrap() + 3;
        let curly = FIXTURE.find('\u{2019}').unwrap() + 1;
        let newline = FIXTURE.find('\n').unwrap() + 1;
        let mut cuts = [newline, mid, curly];
        cuts.sort_unstable();
        let mut got = Vec::new();
        let mut split = Streamer::at(0, decode_line);
        let mut from = 0;
        for cut in cuts.into_iter().chain(std::iter::once(FIXTURE.len())) {
            got.extend(split.push(&FIXTURE.as_bytes()[from..cut]));
            from = cut;
        }
        assert_eq!(kinds(&got), expected);
        assert_eq!(split.offset(), FIXTURE.len() as u64);
    }

    #[test]
    fn a_shell_call_carries_its_command_output_and_exit_code() {
        let mut s = Streamer::at(0, decode_line);
        let p = s.push(FIXTURE.as_bytes());
        let tool = p.iter().find(|p| matches!(p, Payload::ToolCallStarted { name, .. } if name == "shell")).unwrap();
        let Payload::ToolCallStarted { call_id, input, tool_type, title, .. } = tool else { panic!() };
        assert_eq!(*tool_type, ToolType::Shell);
        // The argv Codex handed the shell is `["/bin/zsh", "-lc", "date"]`;
        // the reader meant the last of those.
        assert_eq!(input["command"], "date");
        assert_eq!(input["cwd"], "/w/demo");
        assert_eq!(title.as_deref(), Some("shell date"));
        let done = p
            .iter()
            .find_map(|p| match p {
                Payload::ToolCallCompleted { call_id: c, result } if c == call_id => Some(result),
                _ => None,
            })
            .unwrap();
        assert!(done.text.contains("Wed Sep  2 15:51:33"));
        assert_eq!(done.exit_code, Some(0));
        assert!(!done.is_error);
    }

    #[test]
    fn an_edit_arrives_as_a_diff_against_its_own_tool_row() {
        let mut s = Streamer::at(0, decode_line);
        let p = s.push(FIXTURE.as_bytes());
        let edits = p
            .iter()
            .find_map(|p| match p {
                Payload::FileEdits { call_id, edits } => Some((call_id.clone(), edits.clone())),
                _ => None,
            })
            .unwrap();
        assert_eq!(edits.1.len(), 1);
        assert_eq!(edits.1[0].path, "/w/demo/README.md");
        assert_eq!(edits.1[0].kind, EditKind::Update);
        assert_eq!(edits.1[0].unified.as_deref(), Some("@@ -1 +1 @@\n-hello\n+hello raccoon\n"));
        // The diff hangs off the apply_patch row, not off nothing.
        assert!(p.iter().any(|x| matches!(x, Payload::ToolCallStarted { call_id, name, .. } if Some(call_id) == edits.0.as_ref() && name == "apply_patch")));
    }

    #[test]
    fn occupancy_is_the_last_request_not_the_running_total() {
        let mut s = Streamer::at(0, decode_line);
        let p = s.push(FIXTURE.as_bytes());
        let usages: Vec<&Usage> = p
            .iter()
            .filter_map(|p| match p {
                Payload::UsageUpdate(u) => Some(u),
                _ => None,
            })
            .collect();
        assert_eq!(usages[0].context_used, Some(18287));
        assert_eq!(usages[0].context_max, Some(258400));
        // The third reading's cumulative total is 37099; occupancy is 18640.
        assert_eq!(usages[2].context_used, Some(18640));
    }

    #[test]
    fn the_models_own_input_tape_is_never_drawn() {
        // Every `response_item` in the fixture — the developer prompts, the
        // environment context, the encrypted reasoning, the `exec` wrapper
        // Codex builds around a shell command — decodes to nothing.
        for line in FIXTURE.lines() {
            let v: Value = serde_json::from_str(line).unwrap();
            if v["type"] == "response_item" || v["type"] == "session_meta" || v["type"] == "turn_context" || v["type"] == "world_state" {
                let mut out = Vec::new();
                decode_line(line, &none(), &mut out);
                assert!(out.is_empty(), "{} drew something", v["type"]);
            }
        }
        // And nothing anywhere leaks the wrapper or the standing instructions.
        let mut s = Streamer::at(0, decode_line);
        let text = format!("{:?}", s.push(FIXTURE.as_bytes()));
        assert!(!text.contains("tools.exec_command"));
        assert!(!text.contains("environment_context"));
    }

    #[test]
    fn a_record_that_is_not_json_or_not_an_event_is_skipped() {
        let mut out = Vec::new();
        decode_line("not json at all", &none(), &mut out);
        decode_line(r#"{"type":"response_item","payload":{"type":"message"}}"#, &none(), &mut out);
        decode_line(r#"{"type":"event_msg","payload":{"type":"something_new"}}"#, &none(), &mut out);
        decode_line(r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Whatever"}}}"#, &none(), &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn a_failed_command_and_a_deleted_file_still_read_correctly() {
        let mut out = Vec::new();
        decode_line(
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"e1","command":["/bin/zsh","-lc","false"],"cwd":"file:///w/demo","status":"failed","exit_code":1,"aggregated_output":""}}}"#,
            &none(),
            &mut out,
        );
        let Payload::ToolCallCompleted { result, .. } = &out[1] else { panic!() };
        assert!(result.is_error);
        assert_eq!(result.exit_code, Some(1));

        let mut out = Vec::new();
        decode_line(
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"f1","status":"completed","changes":{"/w/demo/gone.rs":{"type":"delete","unified_diff":"@@\n-x\n","move_path":null},"/w/demo/new.rs":{"type":"add","unified_diff":"@@\n+y\n","move_path":null}}}}}"#,
            &none(),
            &mut out,
        );
        let Payload::FileEdits { edits, .. } = &out[1] else { panic!() };
        assert_eq!(edits[0].kind, EditKind::Delete);
        assert_eq!(edits[1].kind, EditKind::Create);
    }
}
