//! The one event vocabulary every harness maps onto.
//!
//! Two rules the whole design rests on:
//! - `seq` is the ordering key, not `ts`. One counter per tab; events the app
//!   synthesizes (the reader's own prompt) are numbered through it too.
//! - Deltas are a preview; the committed event wins. Consumers must render
//!   correctly with no deltas at all, since some harnesses send none.
//!
//! The TypeScript twin lives in `src/types/events.ts` and is kept in step by
//! hand; `serde` names here are the contract.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub id: String,
    pub session_id: String,
    pub tab_id: String,
    pub harness: String,
    pub seq: u64,
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<SubagentRef>,
    pub payload: Payload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRef {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockRef {
    pub message_id: String,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    /// Path under the attachments directory, or a data: URL before archiving.
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolType {
    Shell,
    FileRead,
    FileEdit,
    FileWrite,
    Search,
    Web,
    Mcp,
    SubagentSpawn,
    Plan,
    Question,
    Other,
}

impl ToolType {
    /// A rendering hint only; nothing depends on it for correctness.
    pub fn from_tool_name(name: &str) -> Self {
        match name {
            "Bash" | "shell" | "local_shell" | "command_execution" | "exec_command" | "terminal" => Self::Shell,
            "Read" | "read_file" | "NotebookRead" => Self::FileRead,
            "Edit" | "MultiEdit" | "NotebookEdit" | "apply_patch" | "file_change" => Self::FileEdit,
            "Write" | "write_file" | "create_file" => Self::FileWrite,
            "Glob" | "Grep" | "LS" | "search" | "file_search" | "grep" | "glob" => Self::Search,
            "WebFetch" | "WebSearch" | "web_search" | "web.search" => Self::Web,
            "Agent" | "Task" | "spawn_agent" | "subagent" => Self::SubagentSpawn,
            "ExitPlanMode" | "TodoWrite" | "update_plan" | "plan" => Self::Plan,
            "AskUserQuestion" => Self::Question,
            n if n.starts_with("mcp__") => Self::Mcp,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Occupancy of the context window after this reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_max: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Ok,
    Error,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
    /// A unified diff when the harness gives one directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unified: Option<String>,
    #[serde(default)]
    pub kind: EditKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum EditKind {
    #[default]
    Update,
    Create,
    Delete,
    Rename,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub kind: PermissionOptionKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    AllowSession,
    Deny,
    SwitchMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub free_text: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Payload {
    // ---- lifecycle
    TurnStarted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
    },
    TurnCompleted {
        status: TurnStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        /// Tree id of the checkout when the turn closed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        head: Option<String>,
        #[serde(default)]
        auth_failed: bool,
    },
    SettingsChanged {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        permission_mode: Option<String>,
    },

    // ---- conversation
    UserMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        /// Tree id of the checkout when the prompt was sent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        baseline: Option<String>,
        #[serde(default)]
        queued: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    AssistantText {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block: Option<BlockRef>,
        text: String,
    },
    Reasoning {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block: Option<BlockRef>,
        text: String,
    },
    Delta(Delta),

    // ---- tools
    ToolCallStarted {
        call_id: String,
        name: String,
        tool_type: ToolType,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    ToolCallCompleted {
        call_id: String,
        result: ToolResult,
    },
    FileEdits {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        edits: Vec<FileEdit>,
    },

    // ---- subagents and tasks
    SubagentStarted {
        agent_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    SubagentCompleted {
        agent_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    BackgroundTasksChanged {
        tasks: Vec<BackgroundTask>,
    },

    // ---- asks
    PermissionRequested {
        request_id: String,
        tool_use_id: String,
        tool_name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        options: Vec<PermissionOption>,
    },
    QuestionsAsked {
        request_id: String,
        tool_use_id: String,
        questions: Vec<Question>,
    },
    PermissionDecided {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        allowed: bool,
        label: String,
        #[serde(default)]
        automatic: bool,
    },
    PermissionDenied {
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        message: String,
    },

    // ---- indicators
    ModelRequestStarted,
    UsageUpdate(Usage),
    ContextCompactionStarted,
    ContextCompacted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pre_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        post_tokens: Option<u64>,
    },
    ApiRetry {
        attempt: u32,
        max_retries: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    RateLimited {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resets_at: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Status {
        text: String,
    },
    Error {
        message: String,
        #[serde(default)]
        fatal: bool,
    },
    Unknown {
        kind: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "delta", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[allow(clippy::enum_variant_names)] // the wire names are the contract
pub enum Delta {
    BlockStart { block: BlockRef, block_type: String },
    TextDelta { block: BlockRef, text: String },
    ThinkingDelta { block: BlockRef, text: String },
    InputDelta { block: BlockRef, partial_json: String },
    BlockStop { block: BlockRef },
}

impl Payload {
    /// Previews and running counters are superseded by their committed event,
    /// so they are emitted but never written to the log.
    pub fn is_persisted(&self) -> bool {
        !matches!(self, Payload::Delta(_) | Payload::UsageUpdate(_) | Payload::ModelRequestStarted)
    }

    pub fn is_turn_boundary(&self) -> bool {
        matches!(self, Payload::TurnCompleted { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_is_internally_tagged_snake_case() {
        let p = Payload::ToolCallStarted {
            call_id: "c1".into(),
            name: "Read".into(),
            tool_type: ToolType::FileRead,
            input: serde_json::json!({"file_path": "/a"}),
            title: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["type"], "tool_call_started");
        assert_eq!(v["toolType"], "file_read");
        assert_eq!(v["callId"], "c1");
        let back: Payload = serde_json::from_value(v).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn delta_round_trips() {
        let d = Payload::Delta(Delta::TextDelta {
            block: BlockRef { message_id: "m".into(), index: 0 },
            text: "hi".into(),
        });
        let s = serde_json::to_string(&d).unwrap();
        assert!(s.contains("\"delta\":\"text_delta\""));
        assert_eq!(serde_json::from_str::<Payload>(&s).unwrap(), d);
        assert!(!d.is_persisted());
    }

    #[test]
    fn tool_type_maps_common_names() {
        assert_eq!(ToolType::from_tool_name("Bash"), ToolType::Shell);
        assert_eq!(ToolType::from_tool_name("mcp__linear__list"), ToolType::Mcp);
        assert_eq!(ToolType::from_tool_name("Whatever"), ToolType::Other);
    }
}
