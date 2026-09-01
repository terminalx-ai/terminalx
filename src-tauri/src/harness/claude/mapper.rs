//! Claude Code typed lines → normalized payloads.
//!
//! One `Mapper` per tab. It remembers what the wire leaves implicit: the block
//! index of each committed content block (counted per message id), the model
//! named by `init` (to index the usage map), and the last main-thread
//! occupancy reading.

use std::collections::HashMap;

use serde_json::Value;

use super::parser::*;
use crate::events::*;

#[derive(Default)]
pub struct Mapper {
    block_counts: HashMap<String, u32>,
    current_stream_message: Option<String>,
    pub model: Option<String>,
    pub provider_session_id: Option<String>,
    last_occupancy: Option<(u64, Option<u64>)>,
    turn_started: Option<std::time::Instant>,
    /// Raw `permission_suggestions` of the last request, indexed by option id.
    pub last_suggestions: Vec<Value>,
    /// Input of the last ask, so an answer can be written back into it.
    pub last_ask_input: Value,
}

/// What a line turned into: zero or more payloads, plus whether the line was
/// a subagent's (so the caller can stamp the envelope).
pub struct Mapped {
    pub payloads: Vec<Payload>,
    pub subagent: Option<SubagentRef>,
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

fn opt_u64(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|x| x.as_u64())
}

impl Mapper {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin_turn(&mut self) {
        self.turn_started = Some(std::time::Instant::now());
    }

    fn next_block(&mut self, message_id: &str) -> BlockRef {
        let n = self.block_counts.entry(message_id.to_string()).or_insert(0);
        let index = *n;
        *n += 1;
        BlockRef { message_id: message_id.to_string(), index }
    }

    /// Occupancy = one message's four counts summed, from the last main-thread
    /// assistant message. `result.usage` is a per-turn sum and must not be used.
    fn note_usage(&mut self, usage: &Value) {
        let sum = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]
            .iter()
            .filter_map(|k| opt_u64(usage, k))
            .sum::<u64>();
        if sum > 0 {
            let max = self.last_occupancy.and_then(|(_, m)| m);
            self.last_occupancy = Some((sum, max));
        }
    }

    pub fn map(&mut self, line: Line) -> Mapped {
        let mut out = Vec::new();
        let mut subagent = None;
        match line {
            Line::System(s) => self.map_system(s, &mut out),
            Line::StreamEvent(s) => {
                subagent = s.parent_tool_use_id.clone().map(|id| SubagentRef { id, label: None });
                self.map_stream(s.event, &mut out);
            }
            Line::Assistant(m) => {
                subagent = m.parent_tool_use_id.clone().map(|id| SubagentRef { id, label: None });
                if subagent.is_none() {
                    if let Some(u) = &m.message.usage {
                        self.note_usage(u);
                    }
                }
                let mid = m.message.id.clone().unwrap_or_else(|| "msg".into());
                for block in m.message.content {
                    match block {
                        ContentBlock::Text { text } => {
                            let b = self.next_block(&mid);
                            if !text.is_empty() {
                                out.push(Payload::AssistantText { block: Some(b), text });
                            }
                        }
                        ContentBlock::Thinking { thinking } => {
                            let b = self.next_block(&mid);
                            out.push(Payload::Reasoning { block: Some(b), text: thinking });
                        }
                        ContentBlock::RedactedThinking {} => {
                            let _ = self.next_block(&mid);
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            let _ = self.next_block(&mid);
                            let title = tool_title(&name, &input);
                            let tool_type = ToolType::from_tool_name(&name);
                            if let Some(edits) = file_edits_from_input(&name, &input) {
                                out.push(Payload::ToolCallStarted {
                                    call_id: id.clone(),
                                    name,
                                    tool_type,
                                    input,
                                    title: Some(title),
                                });
                                out.push(Payload::FileEdits { call_id: Some(id), edits });
                            } else {
                                out.push(Payload::ToolCallStarted { call_id: id, name, tool_type, input, title: Some(title) });
                            }
                        }
                        _ => {}
                    }
                }
            }
            Line::User(m) => {
                if m.is_replay || m.is_synthetic {
                    return Mapped { payloads: out, subagent };
                }
                subagent = m.parent_tool_use_id.clone().map(|id| SubagentRef { id, label: None });
                for block in m.message.content {
                    if let ContentBlock::ToolResult { tool_use_id, content, is_error } = block {
                        let (text, images) = flatten_result(&content);
                        let structured = m
                            .tool_use_result
                            .as_ref()
                            .map(strip_image_bytes)
                            .filter(|v| !v.is_null());
                        out.push(Payload::ToolCallCompleted {
                            call_id: tool_use_id,
                            result: ToolResult { text, is_error, structured, exit_code: None, images },
                        });
                    }
                }
            }
            Line::Result(r) => {
                let status = if r.is_error {
                    TurnStatus::Error
                } else if r.subtype == "success" {
                    TurnStatus::Ok
                } else {
                    TurnStatus::Error
                };
                let (used, max) = self.occupancy_from_result(&r);
                let usage = Some(Usage {
                    input_tokens: r.usage.as_ref().and_then(|u| opt_u64(u, "input_tokens")),
                    output_tokens: r.usage.as_ref().and_then(|u| opt_u64(u, "output_tokens")),
                    context_used: used,
                    context_max: max,
                    cost_usd: r.total_cost_usd,
                });
                let final_text = r.result.filter(|t| !t.is_empty());
                let auth_failed = final_text
                    .as_deref()
                    .map(|t| t.contains("Invalid API key") || t.contains("not logged in") || t.contains("/login"))
                    .unwrap_or(false)
                    && status == TurnStatus::Error;
                let duration_ms = r.duration_ms.or_else(|| self.turn_started.map(|t| t.elapsed().as_millis() as u64));
                self.turn_started = None;
                out.push(Payload::TurnCompleted { status, final_text, usage, duration_ms, head: None, auth_failed });
            }
            Line::ControlRequest(req) => match req.request {
                ControlRequest::CanUseTool(c) => {
                    let c = *c;
                    let tool_use_id = c.tool_use_id.clone().unwrap_or_default();
                    self.last_suggestions = c.permission_suggestions.clone();
                    self.last_ask_input = c.input.clone();
                    if c.tool_name == "AskUserQuestion" {
                        out.push(Payload::QuestionsAsked {
                            request_id: req.request_id,
                            tool_use_id,
                            questions: questions_from_input(&c.input),
                        });
                    } else {
                        out.push(Payload::PermissionRequested {
                            request_id: req.request_id,
                            tool_use_id,
                            title: Some(tool_title(&c.tool_name, &c.input)),
                            description: c.description.clone().or_else(|| {
                                c.decision_reason.as_ref().and_then(|d| opt_str(d, "reason").or_else(|| opt_str(d, "message")))
                            }),
                            options: build_options(&c.permission_suggestions),
                            tool_name: c.tool_name,
                            input: c.input,
                        });
                    }
                }
                ControlRequest::Unknown => {}
            },
            Line::ControlResponse(_) => {}
            Line::ControlCancelRequest { request_id } => {
                out.push(Payload::PermissionDecided {
                    request_id,
                    tool_use_id: None,
                    allowed: false,
                    label: "Withdrawn".into(),
                    automatic: true,
                });
            }
            Line::RateLimitEvent { rate_limit_info } => {
                if rate_limit_info.is_noteworthy() {
                    out.push(Payload::RateLimited {
                        status: rate_limit_info.status.clone(),
                        resets_at: rate_limit_info.resets_at,
                        message: None,
                    });
                }
                out.push(Payload::Status { text: format!("rate_limit:{}", serde_json::to_string(&rate_limit_info.unified_windows.unwrap_or(Value::Null)).unwrap_or_default()) });
            }
            Line::ToolProgress(_) | Line::KeepAlive | Line::Unknown => {}
        }
        Mapped { payloads: out, subagent }
    }

    fn occupancy_from_result(&mut self, r: &ResultLine) -> (Option<u64>, Option<u64>) {
        let mut max = None;
        if let Some(mu) = &r.model_usage {
            let key = self.model.clone();
            let entry = key
                .as_ref()
                .and_then(|k| mu.get(k))
                .or_else(|| mu.as_object().and_then(|o| o.values().next()));
            max = entry.and_then(|e| opt_u64(e, "contextWindow"));
        }
        let used = self.last_occupancy.map(|(u, _)| u);
        if let Some(u) = used {
            self.last_occupancy = Some((u, max));
        }
        (used, max)
    }

    fn map_system(&mut self, s: SystemLine, out: &mut Vec<Payload>) {
        match s {
            SystemLine::Init(i) => {
                self.model = Some(i.model.clone());
                self.provider_session_id = Some(i.session_id.clone());
                out.push(Payload::TurnStarted { model: Some(i.model), provider_session_id: Some(i.session_id) });
            }
            SystemLine::Status { status } => match status.as_deref() {
                Some("compacting") => out.push(Payload::ContextCompactionStarted),
                Some("requesting") => out.push(Payload::ModelRequestStarted),
                _ => {}
            },
            SystemLine::CompactBoundary { compact_metadata } => {
                self.last_occupancy = None;
                out.push(Payload::ContextCompacted {
                    pre_tokens: compact_metadata.as_ref().and_then(|m| m.pre_tokens),
                    post_tokens: None,
                });
            }
            SystemLine::ApiRetry { attempt, max_retries, error } => {
                out.push(Payload::ApiRetry { attempt, max_retries, reason: error.filter(|e| e != "unknown") });
            }
            SystemLine::PermissionDenied { tool_name, tool_use_id, message } => {
                out.push(Payload::PermissionDenied { tool_name, tool_use_id, message });
            }
            SystemLine::TaskStarted(t) => {
                if let Some(id) = t.task_id.or(t.tool_use_id.clone()) {
                    out.push(Payload::SubagentStarted { agent_id: id, call_id: t.tool_use_id, label: t.description });
                }
            }
            SystemLine::TaskNotification(t) => {
                if let Some(id) = t.task_id.or(t.tool_use_id.clone()) {
                    out.push(Payload::SubagentCompleted { agent_id: id, call_id: t.tool_use_id, summary: t.summary });
                }
            }
            SystemLine::TaskProgress(_)
            | SystemLine::ThinkingTokens(_)
            | SystemLine::HookStarted(_)
            | SystemLine::HookProgress(_)
            | SystemLine::HookResponse(_)
            | SystemLine::Unknown => {}
        }
    }

    fn map_stream(&mut self, frame: StreamFrame, out: &mut Vec<Payload>) {
        // Streaming block refs use the message id from message_start; the CLI
        // carries it on every committed message too, so both sides agree.
        match frame {
            StreamFrame::MessageStart { message } => {
                self.current_stream_message = opt_str(&message, "id");
            }
            StreamFrame::ContentBlockStart { index, content_block } => {
                let block = BlockRef { message_id: self.stream_message_id(), index };
                let block_type = match &content_block {
                    ContentBlock::Text { .. } => "text",
                    ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking {} => "thinking",
                    ContentBlock::ToolUse { .. } => "tool_use",
                    _ => "other",
                };
                out.push(Payload::Delta(Delta::BlockStart { block, block_type: block_type.into() }));
                if let ContentBlock::ToolUse { id, name, .. } = content_block {
                    // Announce the call before its arguments arrive so the row
                    // can draw a header immediately.
                    out.push(Payload::Status { text: format!("tool_pending:{id}:{name}") });
                }
            }
            StreamFrame::ContentBlockDelta { index, delta } => {
                let block = BlockRef { message_id: self.stream_message_id(), index };
                match delta {
                    StreamDelta::TextDelta { text } => out.push(Payload::Delta(Delta::TextDelta { block, text })),
                    StreamDelta::ThinkingDelta { thinking } => {
                        out.push(Payload::Delta(Delta::ThinkingDelta { block, text: thinking }))
                    }
                    StreamDelta::InputJsonDelta { partial_json } => {
                        out.push(Payload::Delta(Delta::InputDelta { block, partial_json }))
                    }
                    StreamDelta::SignatureDelta {} | StreamDelta::Unknown => {}
                }
            }
            StreamFrame::ContentBlockStop { index } => {
                let block = BlockRef { message_id: self.stream_message_id(), index };
                out.push(Payload::Delta(Delta::BlockStop { block }));
            }
            StreamFrame::MessageDelta { usage, .. } => {
                if let Some(u) = usage {
                    self.note_usage(&u);
                    if let Some((used, max)) = self.last_occupancy {
                        out.push(Payload::UsageUpdate(Usage {
                            input_tokens: None,
                            output_tokens: opt_u64(&u, "output_tokens"),
                            context_used: Some(used),
                            context_max: max,
                            cost_usd: None,
                        }));
                    }
                }
            }
            StreamFrame::MessageStop | StreamFrame::Unknown => {}
        }
    }

    fn stream_message_id(&self) -> String {
        self.current_stream_message.clone().unwrap_or_else(|| "stream".into())
    }
}

/// A short label for a tool row: verb-ish tool name plus its main target.
pub fn tool_title(name: &str, input: &Value) -> String {
    let target = ["file_path", "path", "command", "pattern", "query", "url", "description", "prompt", "notebook_path"]
        .iter()
        .find_map(|k| opt_str(input, k))
        .map(|s| {
            let s = s.lines().next().unwrap_or("").to_string();
            if s.chars().count() > 120 {
                format!("{}…", s.chars().take(120).collect::<String>())
            } else {
                s
            }
        });
    match target {
        Some(t) => format!("{name} {t}"),
        None => name.to_string(),
    }
}

fn file_edits_from_input(name: &str, input: &Value) -> Option<Vec<FileEdit>> {
    match name {
        "Edit" => Some(vec![FileEdit {
            path: opt_str(input, "file_path")?,
            old_text: opt_str(input, "old_string"),
            new_text: opt_str(input, "new_string"),
            unified: None,
            kind: EditKind::Update,
        }]),
        "MultiEdit" => {
            let path = opt_str(input, "file_path")?;
            let edits = input.get("edits")?.as_array()?;
            Some(
                edits
                    .iter()
                    .map(|e| FileEdit {
                        path: path.clone(),
                        old_text: opt_str(e, "old_string"),
                        new_text: opt_str(e, "new_string"),
                        unified: None,
                        kind: EditKind::Update,
                    })
                    .collect(),
            )
        }
        "Write" => Some(vec![FileEdit {
            path: opt_str(input, "file_path")?,
            old_text: None,
            new_text: opt_str(input, "content"),
            unified: None,
            kind: EditKind::Create,
        }]),
        _ => None,
    }
}

/// Tool result content is a string or a list of text/image blocks.
fn flatten_result(content: &Value) -> (String, Vec<ImageRef>) {
    match content {
        Value::String(s) => (s.clone(), Vec::new()),
        Value::Array(items) => {
            let mut text = String::new();
            let mut images = Vec::new();
            for item in items {
                match item.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(item.get("text").and_then(|t| t.as_str()).unwrap_or(""));
                    }
                    Some("image") => {
                        let src = item.get("source").cloned().unwrap_or(Value::Null);
                        let media = opt_str(&src, "media_type").unwrap_or_else(|| "image/png".into());
                        if let Some(data) = opt_str(&src, "data") {
                            images.push(ImageRef { url: format!("data:{media};base64,{data}"), media_type: Some(media), name: None });
                        }
                    }
                    _ => {}
                }
            }
            (text, images)
        }
        Value::Null => (String::new(), Vec::new()),
        other => (other.to_string(), Vec::new()),
    }
}

/// The sidecar carries image bytes a second time; drop them before persisting.
fn strip_image_bytes(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(file) = v.get_mut("file").and_then(|f| f.as_object_mut()) {
        file.remove("base64");
    }
    if let Some(obj) = v.as_object_mut() {
        obj.remove("base64");
        // Big tool payloads (file contents) are already in the result text.
        if let Some(f) = obj.get_mut("file").and_then(|f| f.as_object_mut()) {
            f.remove("content");
        }
        obj.remove("content");
        obj.remove("oldTodos");
        obj.remove("newTodos");
    }
    v
}

fn questions_from_input(input: &Value) -> Vec<Question> {
    input
        .get("questions")
        .and_then(|q| q.as_array())
        .map(|qs| {
            qs.iter()
                .map(|q| Question {
                    question: opt_str(q, "question").unwrap_or_default(),
                    header: opt_str(q, "header"),
                    multi_select: q.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false),
                    options: q
                        .get("options")
                        .and_then(|o| o.as_array())
                        .map(|os| {
                            os.iter()
                                .map(|o| QuestionOption { label: opt_str(o, "label").unwrap_or_default(), description: opt_str(o, "description") })
                                .collect()
                        })
                        .unwrap_or_default(),
                    free_text: true,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Options for a permission card. The first is always "allow once", the last
/// always "deny"; suggestions in between carry the CLI's own rule payloads,
/// which stay in Rust (keyed by option id) and never reach the frontend.
pub fn build_options(suggestions: &[Value]) -> Vec<PermissionOption> {
    let mut out = vec![PermissionOption { id: "allow".into(), label: "Allow".into(), kind: PermissionOptionKind::AllowOnce }];
    for (i, s) in suggestions.iter().enumerate() {
        let id = format!("suggest:{i}");
        match s.get("type").and_then(|t| t.as_str()) {
            Some("setMode") => {
                let mode = opt_str(s, "mode").unwrap_or_default();
                out.push(PermissionOption {
                    id,
                    label: format!("Allow and switch to {}", mode_label(&mode)),
                    kind: PermissionOptionKind::SwitchMode,
                });
            }
            Some("addRules") => {
                let rules: Vec<String> = s
                    .get("rules")
                    .and_then(|r| r.as_array())
                    .map(|rs| rs.iter().filter_map(|r| opt_str(r, "ruleContent").or_else(|| opt_str(r, "toolName"))).collect())
                    .unwrap_or_default();
                let label = match rules.as_slice() {
                    [] => "Always allow".to_string(),
                    [one] if one.chars().count() <= 48 => format!("Always allow {one}"),
                    [one] => format!("Always allow {}…", one.chars().take(40).collect::<String>().trim_end()),
                    many => format!("Always allow {} rules", many.len()),
                };
                out.push(PermissionOption { id, label, kind: PermissionOptionKind::AllowAlways });
            }
            Some("addDirectories") => {
                let dirs: Vec<String> = s
                    .get("directories")
                    .and_then(|d| d.as_array())
                    .map(|ds| ds.iter().filter_map(|d| d.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                out.push(PermissionOption {
                    id,
                    label: format!("Allow access to {}", dirs.join(", ")),
                    kind: PermissionOptionKind::AllowSession,
                });
            }
            _ => {}
        }
    }
    out.push(PermissionOption { id: "deny".into(), label: "Deny".into(), kind: PermissionOptionKind::Deny });
    out
}

pub fn mode_label(mode: &str) -> &'static str {
    match mode {
        "plan" => "Plan",
        "manual" => "Ask every time",
        "auto" => "Auto",
        "acceptEdits" => "Accept edits",
        "dontAsk" => "Don't ask",
        "bypassPermissions" => "Bypass permissions",
        _ => "Auto",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = include_str!("fixtures/simple_tools.jsonl");
    const PERMISSION: &str = include_str!("fixtures/permission_allow.jsonl");

    fn run(text: &str) -> Vec<Payload> {
        let mut m = Mapper::new();
        let mut out = Vec::new();
        for l in text.lines().filter(|l| !l.trim().is_empty()) {
            out.extend(m.map(parse_line(l).unwrap()).payloads);
        }
        out
    }

    #[test]
    fn simple_fixture_maps_to_expected_sequence() {
        let events = run(SIMPLE);
        let kinds: Vec<&str> = events
            .iter()
            .filter(|p| p.is_persisted())
            .map(|p| match p {
                Payload::TurnStarted { .. } => "turn_started",
                Payload::Reasoning { .. } => "reasoning",
                Payload::ToolCallStarted { .. } => "tool_call_started",
                Payload::ToolCallCompleted { .. } => "tool_call_completed",
                Payload::AssistantText { .. } => "assistant_text",
                Payload::TurnCompleted { .. } => "turn_completed",
                Payload::Status { .. } => "status",
                _ => "other",
            })
            .filter(|k| *k != "status")
            .collect();
        assert_eq!(
            kinds,
            vec![
                "turn_started",
                "reasoning",
                "tool_call_started",
                "tool_call_completed",
                "reasoning",
                "assistant_text",
                "tool_call_started",
                "tool_call_completed",
                "reasoning",
                "assistant_text",
                "turn_completed"
            ]
        );
        let started: Vec<_> = events.iter().filter(|p| matches!(p, Payload::ToolCallStarted { .. })).collect();
        if let Payload::ToolCallStarted { name, tool_type, title, .. } = started[0] {
            assert_eq!(name, "Read");
            assert_eq!(*tool_type, ToolType::FileRead);
            assert_eq!(title.as_deref(), Some("Read /tmp/repo/notes.txt"));
        }
        if let Payload::ToolCallStarted { name, tool_type, .. } = started[1] {
            assert_eq!(name, "Bash");
            assert_eq!(*tool_type, ToolType::Shell);
        }
        let done = events.iter().find(|p| matches!(p, Payload::TurnCompleted { .. })).unwrap();
        if let Payload::TurnCompleted { status, usage, final_text, .. } = done {
            assert_eq!(*status, TurnStatus::Ok);
            let u = usage.as_ref().unwrap();
            assert_eq!(u.context_max, Some(200000));
            assert!(u.context_used.unwrap() > 10_000 && u.context_used.unwrap() < 200_000, "{:?}", u.context_used);
            assert!(final_text.is_some());
        }
        // Deltas exist and are not persisted.
        assert!(events.iter().any(|p| matches!(p, Payload::Delta(Delta::TextDelta { .. }))));
        assert!(events.iter().any(|p| matches!(p, Payload::Delta(Delta::ThinkingDelta { text, .. }) if !text.is_empty())));
    }

    #[test]
    fn permission_fixture_builds_options_and_edits() {
        let events = run(PERMISSION);
        let req = events.iter().find(|p| matches!(p, Payload::PermissionRequested { .. })).unwrap();
        if let Payload::PermissionRequested { tool_name, options, .. } = req {
            assert_eq!(tool_name, "Write");
            let kinds: Vec<_> = options.iter().map(|o| o.kind).collect();
            assert_eq!(kinds, vec![PermissionOptionKind::AllowOnce, PermissionOptionKind::SwitchMode, PermissionOptionKind::Deny]);
            assert_eq!(options[1].label, "Allow and switch to Accept edits");
        }
        let edits = events.iter().find(|p| matches!(p, Payload::FileEdits { .. })).unwrap();
        if let Payload::FileEdits { edits, .. } = edits {
            assert_eq!(edits[0].kind, EditKind::Create);
            assert_eq!(edits[0].new_text.as_deref(), Some("hi"));
        }
    }

    #[test]
    fn questions_and_cancel() {
        let mut m = Mapper::new();
        let l = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Tabs or spaces?","header":"Style","multiSelect":false,"options":[{"label":"Tabs"},{"label":"Spaces","description":"two"}]}]},"tool_use_id":"t1"}}"#;
        let p = m.map(parse_line(l).unwrap()).payloads;
        match &p[0] {
            Payload::QuestionsAsked { questions, .. } => {
                assert_eq!(questions[0].options.len(), 2);
                assert_eq!(questions[0].header.as_deref(), Some("Style"));
            }
            _ => panic!(),
        }
        let p = m.map(parse_line(r#"{"type":"control_cancel_request","request_id":"r1"}"#).unwrap()).payloads;
        assert!(matches!(&p[0], Payload::PermissionDecided { automatic: true, .. }));
    }
}
