//! Lossless native transcript copies for conversation reset. Display decoders
//! deliberately skip unknown records; this writer must instead fail closed.
use anyhow::{bail, ensure, Context, Result};
use serde_json::Value;

use crate::events::{AgentEvent, Payload, TurnStatus};

pub struct Anchor<'a> {
    pub timestamp: &'a str,
    pub text: &'a str,
    pub message_id: Option<&'a str>,
}

pub fn anchor(events: &[AgentEvent], end_seq: u64) -> Result<(usize, Anchor<'_>)> {
    let end = events.iter().position(|e| e.seq == end_seq && e.subagent.is_none()
        && matches!(e.payload, Payload::TurnCompleted { status: TurnStatus::Ok, .. }))
        .context("Choose a successfully completed turn to reset to.")?;
    for event in events[..end].iter().rev().filter(|e| e.subagent.is_none()) {
        match &event.payload {
            Payload::AssistantText { text, block } => return Ok((end, Anchor {
                timestamp: event.message_ts.as_deref().unwrap_or(&event.ts), text,
                message_id: block.as_ref().map(|b| b.message_id.as_str()),
            })),
            Payload::TurnStarted { .. } | Payload::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    bail!("This turn has no recorded answer that can be matched to the agent's transcript.")
}

fn same_time(a: &str, b: &str) -> bool {
    match (chrono::DateTime::parse_from_rfc3339(a), chrono::DateTime::parse_from_rfc3339(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// None copies the complete saved original for Undo. Never rewrite arbitrary
/// strings: messages, tool output and encrypted model context stay verbatim.
pub fn duplicate(harness: &str, source: &str, old_id: &str, new_id: &str, anchor: Option<&Anchor<'_>>) -> Result<String> {
    ensure!(uuid::Uuid::parse_str(old_id).is_ok() && uuid::Uuid::parse_str(new_id).is_ok(), "Invalid conversation id.");
    let mut records: Vec<Value> = source.lines().filter(|l| !l.trim().is_empty())
        .map(|line| serde_json::from_str(line).context("Unknown transcript format: invalid JSON. Nothing was reset."))
        .collect::<Result<_>>()?;
    ensure!(!records.is_empty(), "The agent's transcript is empty. Nothing was reset.");
    let end = match harness {
        "claude" => claude(&records, old_id, anchor)?,
        "codex" => codex(&records, old_id, anchor)?,
        _ => bail!("Reset supports Claude Code and Codex CLI conversations only."),
    };
    records.truncate(end);
    let mut out = String::new();
    for mut record in records {
        if harness == "claude" {
            // Bookkeeping can name a leaf from a later branch. The CLI derives
            // the leaf from the retained messages; never carry those hints.
            if matches!(record["type"].as_str(), Some("last-prompt" | "ai-title" | "custom-title" | "summary" | "session-owner" | "api-request" | "api-request-blob" | "api-request-shape" | "cost-state" | "queue-operation")) { continue; }
            if record.get("sessionId").is_some() { record["sessionId"] = new_id.into(); }
        } else {
            if record["type"] == "session_meta" {
                record["payload"]["id"] = new_id.into();
                if record["payload"].get("session_id").is_some() { record["payload"]["session_id"] = new_id.into(); }
                // A reset is an independent conversation, never a fork that
                // might load additional context from its parent.
                if let Some(p) = record["payload"].as_object_mut() { p.remove("forked_from_id"); }
            }
            for key in ["thread_id", "session_id"] {
                if record["payload"][key] == old_id { record["payload"][key] = new_id.into(); }
            }
        }
        out.push_str(&serde_json::to_string(&record)?);
        out.push('\n');
    }
    Ok(out)
}

fn claude(records: &[Value], id: &str, anchor: Option<&Anchor<'_>>) -> Result<usize> {
    let mut matched = Vec::new();
    let mut messages = false;
    for (i, v) in records.iter().enumerate() {
        let kind = v["type"].as_str().context("Unknown Claude transcript format: missing record type.")?;
        ensure!(matches!(kind, "user" | "assistant" | "system" | "attachment" | "progress" | "queue-operation" | "last-prompt" | "mode" | "permission-mode" | "atis-latch" | "file-history-snapshot" | "summary" | "ai-title" | "custom-title" | "tag" | "agent-name" | "agent-color" | "session-owner" | "api-request" | "api-request-blob" | "api-request-shape" | "cost-state"),
            "Unknown Claude transcript record '{kind}'. Nothing was reset.");
        ensure!(v.get("sessionId").is_none_or(|s| s == id), "Claude transcript contains another conversation. Nothing was reset.");
        if matches!(kind, "user" | "assistant") {
            messages = true;
            ensure!(v["uuid"].as_str().is_some() && v["message"].is_object() && v["sessionId"] == id,
                "Unknown Claude message format. Nothing was reset.");
        }
        if kind == "assistant" && v["isSidechain"] != true {
            if let Some(a) = anchor {
                if same_time(v["timestamp"].as_str().unwrap_or(""), a.timestamp)
                    && v["message"]["stop_reason"] == "end_turn"
                    && v["message"]["content"].as_array().is_some_and(|parts| parts.iter().any(|p| p["type"] == "text" && p["text"] == a.text)) {
                    matched.push(i + 1);
                }
            }
        }
    }
    ensure!(messages, "Unknown Claude transcript format: no messages.");
    match anchor {
        None => Ok(records.len()),
        Some(_) => { ensure!(matched.len() == 1, "Cannot uniquely locate this turn's final answer in the Claude transcript. Nothing was reset."); Ok(matched[0]) }
    }
}

fn codex(records: &[Value], id: &str, anchor: Option<&Anchor<'_>>) -> Result<usize> {
    ensure!(records[0]["type"] == "session_meta" && records[0]["payload"]["id"] == id
        && records[0]["payload"]["cli_version"].as_str().is_some(), "Unknown Codex rollout header. Nothing was reset.");
    let mut matches = Vec::new();
    for (i, v) in records.iter().enumerate() {
        let kind = v["type"].as_str().context("Unknown Codex rollout record.")?;
        ensure!(matches!(kind, "session_meta" | "event_msg" | "response_item" | "turn_context" | "world_state" | "compacted" | "token_usage_record"), "Unknown Codex rollout record '{kind}'. Nothing was reset.");
        ensure!(v["payload"].is_object() && (i == 0 || kind != "session_meta"), "Unknown Codex rollout structure. Nothing was reset.");
        let payload_type = v["payload"]["type"].as_str().unwrap_or("");
        if kind == "event_msg" {
            ensure!(matches!(payload_type, "task_started" | "task_complete" | "turn_aborted" | "token_count" | "context_compacted"
                | "thread_settings_applied" | "stream_error" | "error" | "warning" | "item_started" | "item_completed"
                | "user_message" | "agent_message" | "agent_reasoning" | "agent_reasoning_raw_content"
                | "exec_command_begin" | "exec_command_end" | "patch_apply_begin" | "patch_apply_end"
                | "web_search_begin" | "web_search_end" | "entered_review_mode" | "exited_review_mode"
                | "collab_agent_spawn_begin" | "collab_agent_spawn_end" | "collab_agent_interaction_begin" | "collab_agent_interaction_end"
                | "collab_waiting_begin" | "collab_waiting_end" | "collab_close_begin" | "collab_close_end"
                | "collab_resume_begin" | "collab_resume_end"),
                "Unknown Codex event '{payload_type}'. Nothing was reset.");
        }
        if kind == "response_item" {
            ensure!(matches!(payload_type, "message" | "reasoning" | "function_call" | "function_call_output"
                | "custom_tool_call" | "custom_tool_call_output" | "web_search_call" | "image_generation_call"
                | "local_shell_call" | "ghost_snapshot" | "compaction" | "additional_tools"),
                "Unknown Codex model input '{payload_type}'. Nothing was reset.");
        }
        if let Some(a) = anchor {
            let p = &v["payload"];
            if kind == "response_item" && p["type"] == "message" && p["role"] == "assistant"
                && a.message_id.is_some_and(|mid| p["id"] == mid)
                && p["content"].as_array().is_some_and(|parts| parts.iter().any(|p| p["text"] == a.text)) {
                // Include the model's final answer on its input tape, then the
                // task_complete that follows. The display event alone is too early.
                let turn = p["internal_chat_message_metadata_passthrough"]["turn_id"].as_str();
                let mut end = None;
                for (j, later) in records.iter().enumerate().skip(i + 1) {
                    if later["type"] == "event_msg" && later["payload"]["type"] == "task_complete"
                        && turn.is_some_and(|t| later["payload"]["turn_id"] == t) { end = Some(j + 1); break; }
                    if later["type"] != "token_usage_record" && !(later["type"] == "event_msg" && later["payload"]["type"] == "token_count") { break; }
                }
                if let Some(end) = end { matches.push(end); }
            }
        }
    }
    match anchor {
        None => Ok(records.len()),
        Some(_) => { ensure!(matches.len() == 1, "Cannot uniquely locate this completed turn in the Codex rollout. Nothing was reset."); Ok(matches[0]) }
    }
}

#[cfg(test)]
#[path = "reset_tests.rs"]
mod tests;
