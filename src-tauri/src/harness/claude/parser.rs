#![allow(dead_code)] // typed wire fields document the protocol even where unread

//! Claude Code stream-json, wire → typed.
//!
//! Conventions:
//! - `Line` is externally tagged on `type`; `system` and `result` nest a second
//!   tag on `subtype`. Every enum carries a catch-all so an unknown kind costs
//!   one line's meaning, never the line.
//! - Fields the CLI may omit are `Option` or `default`; ones it may send as
//!   `null` where a value is expected go through `null_default`.
//! - Volatile payloads (`message.usage`, `tool_use_result`) stay `Value`.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Line {
    System(SystemLine),
    Assistant(MessageLine),
    User(MessageLine),
    Result(ResultLine),
    StreamEvent(StreamLine),
    ControlRequest(ControlRequestLine),
    ControlResponse(ControlResponseLine),
    ControlCancelRequest {
        request_id: String,
    },
    RateLimitEvent {
        rate_limit_info: RateLimitInfo,
    },
    ToolProgress(Value),
    KeepAlive,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SystemLine {
    Init(InitEvent),
    Status {
        #[serde(default)]
        status: Option<String>,
    },
    CompactBoundary {
        #[serde(default)]
        compact_metadata: Option<CompactMetadata>,
    },
    ApiRetry {
        #[serde(default)]
        attempt: u32,
        #[serde(default)]
        max_retries: u32,
        #[serde(default)]
        error: Option<String>,
    },
    PermissionDenied {
        tool_name: String,
        #[serde(default)]
        tool_use_id: Option<String>,
        #[serde(default)]
        message: String,
    },
    TaskStarted(TaskEvent),
    TaskProgress(TaskEvent),
    TaskNotification(TaskEvent),
    ThinkingTokens(Value),
    HookStarted(Value),
    HookProgress(Value),
    HookResponse(Value),
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
pub struct InitEvent {
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, rename = "permissionMode")]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub slash_commands: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub claude_code_version: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CompactMetadata {
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub pre_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TaskEvent {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub task_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MessageLine {
    pub message: Message,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub uuid: Option<String>,
    #[serde(default)]
    pub tool_use_result: Option<Value>,
    #[serde(default, rename = "isReplay")]
    pub is_replay: bool,
    #[serde(default, rename = "isSynthetic")]
    pub is_synthetic: bool,
}

#[derive(Debug, Deserialize)]
pub struct Message {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, deserialize_with = "content_blocks")]
    pub content: Vec<ContentBlock>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<Value>,
}

/// `content` is either a string or a list of blocks.
fn content_blocks<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<ContentBlock>, D::Error> {
    let v = Value::deserialize(d)?;
    match v {
        Value::String(s) => Ok(vec![ContentBlock::Text { text: s }]),
        Value::Array(items) => Ok(items
            .into_iter()
            .map(|i| serde_json::from_value(i).unwrap_or(ContentBlock::Unknown))
            .collect()),
        _ => Ok(Vec::new()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        #[serde(default)]
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    RedactedThinking {},
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default, deserialize_with = "null_default")]
        is_error: bool,
    },
    Image {
        #[serde(default)]
        source: Value,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
pub struct ResultLine {
    #[serde(default)]
    pub subtype: String,
    #[serde(default, deserialize_with = "null_default")]
    pub is_error: bool,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub total_cost_usd: Option<f64>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default, rename = "modelUsage")]
    pub model_usage: Option<Value>,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct StreamLine {
    pub event: StreamFrame,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamFrame {
    MessageStart {
        #[serde(default)]
        message: Value,
    },
    ContentBlockStart {
        index: u32,
        content_block: ContentBlock,
    },
    ContentBlockDelta {
        index: u32,
        delta: StreamDelta,
    },
    ContentBlockStop {
        index: u32,
    },
    MessageDelta {
        #[serde(default)]
        delta: Value,
        #[serde(default)]
        usage: Option<Value>,
    },
    MessageStop,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamDelta {
    TextDelta {
        #[serde(default)]
        text: String,
    },
    ThinkingDelta {
        #[serde(default)]
        thinking: String,
    },
    InputJsonDelta {
        #[serde(default)]
        partial_json: String,
    },
    SignatureDelta {},
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
pub struct ControlRequestLine {
    pub request_id: String,
    pub request: ControlRequest,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequest {
    CanUseTool(Box<CanUseTool>),
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
pub struct CanUseTool {
    pub tool_name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub permission_suggestions: Vec<Value>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub blocked_path: Option<String>,
    #[serde(default)]
    pub decision_reason: Option<Value>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub requires_user_interaction: bool,
}

#[derive(Debug, Deserialize)]
pub struct ControlResponseLine {
    pub response: ControlResponseBody,
}

#[derive(Debug, Deserialize)]
pub struct ControlResponseBody {
    #[serde(default)]
    pub subtype: String,
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub response: Value,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RateLimitInfo {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "resetsAt")]
    pub resets_at: Option<u64>,
    #[serde(default, rename = "rateLimitType")]
    pub rate_limit_type: Option<String>,
    #[serde(default, rename = "unifiedWindows")]
    pub unified_windows: Option<Value>,
}

impl RateLimitInfo {
    /// Only bad news is worth an event; `allowed` and `allowed_warning` are the
    /// ordinary states seen on every turn.
    pub fn is_noteworthy(&self) -> bool {
        !matches!(self.status.as_deref(), Some("allowed") | Some("allowed_warning"))
    }
}

pub fn parse_line(line: &str) -> Result<Line, serde_json::Error> {
    serde_json::from_str(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = include_str!("fixtures/simple_tools.jsonl");
    const PERMISSION: &str = include_str!("fixtures/permission_allow.jsonl");

    #[test]
    fn every_fixture_line_parses() {
        for (name, text) in [("simple", SIMPLE), ("permission", PERMISSION)] {
            let mut unknown = 0;
            for l in text.lines().filter(|l| !l.trim().is_empty()) {
                let parsed = parse_line(l).unwrap_or_else(|e| panic!("{name}: {e}: {}", &l[..l.len().min(120)]));
                if matches!(parsed, Line::Unknown) {
                    unknown += 1;
                }
            }
            assert_eq!(unknown, 0, "{name} has unknown line types");
        }
    }

    #[test]
    fn permission_request_shape() {
        let l = PERMISSION.lines().find(|l| l.contains("\"control_request\"")).unwrap();
        match parse_line(l).unwrap() {
            Line::ControlRequest(r) => match r.request {
                ControlRequest::CanUseTool(c) => {
                    assert_eq!(c.tool_name, "Write");
                    assert_eq!(c.permission_suggestions.len(), 1);
                    assert!(c.tool_use_id.is_some());
                }
                _ => panic!("not can_use_tool"),
            },
            _ => panic!("not a control request"),
        }
    }

    #[test]
    fn result_and_usage() {
        let l = SIMPLE.lines().find(|l| l.contains("\"type\":\"result\"")).unwrap();
        match parse_line(l).unwrap() {
            Line::Result(r) => {
                assert_eq!(r.subtype, "success");
                assert!(!r.is_error);
                assert!(r.model_usage.is_some());
                assert!(r.duration_ms.unwrap() > 0);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn string_content_and_null_is_error() {
        let l = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok","is_error":null}]}}"#;
        match parse_line(l).unwrap() {
            Line::User(m) => match &m.message.content[0] {
                ContentBlock::ToolResult { is_error, .. } => assert!(!is_error),
                _ => panic!(),
            },
            _ => panic!(),
        }
        let l = r#"{"type":"user","message":{"role":"user","content":"plain"}}"#;
        assert!(matches!(parse_line(l).unwrap(), Line::User(_)));
    }
}
