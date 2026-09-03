/**
 * Portable twin of src-tauri/src/events.rs. Field names are the serde wire
 * contract: payload `type` and enum values are snake_case, fields camelCase.
 */
export interface AgentEvent {
  id: string;
  sessionId: string;
  tabId: string;
  harness: string;
  seq: number;
  ts: string;
  subagent?: SubagentRef;
  payload: Payload;
}

export interface SubagentRef {
  id: string;
  label?: string;
}

export interface BlockRef {
  messageId: string;
  index: number;
}

export interface ImageRef {
  url: string;
  mediaType?: string;
  name?: string;
}

export type ToolType =
  | "shell"
  | "file_read"
  | "file_edit"
  | "file_write"
  | "search"
  | "web"
  | "mcp"
  | "subagent_spawn"
  | "plan"
  | "question"
  | "other";

export interface ToolResult {
  text: string;
  isError: boolean;
  structured?: unknown;
  exitCode?: number;
  images?: ImageRef[];
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  contextUsed?: number;
  contextMax?: number;
  costUsd?: number;
}

export type TurnStatus = "ok" | "error" | "aborted";
export type EditKind = "update" | "create" | "delete" | "rename";

export interface FileEdit {
  path: string;
  oldText?: string;
  newText?: string;
  unified?: string;
  kind: EditKind;
}

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "allow_session"
  | "deny"
  | "switch_mode";

export interface PermissionOption {
  id: string;
  label: string;
  kind: PermissionOptionKind;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
  freeText: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface BackgroundTask {
  id: string;
  label?: string;
  kind?: string;
}

export type Delta =
  | { delta: "block_start"; block: BlockRef; blockType: string }
  | { delta: "text_delta"; block: BlockRef; text: string }
  | { delta: "thinking_delta"; block: BlockRef; text: string }
  | { delta: "input_delta"; block: BlockRef; partialJson: string }
  | { delta: "block_stop"; block: BlockRef };

export type Payload =
  | { type: "turn_started"; model?: string; providerSessionId?: string }
  | {
      type: "turn_completed";
      status: TurnStatus;
      finalText?: string;
      usage?: Usage;
      durationMs?: number;
      head?: string;
      authFailed: boolean;
    }
  | { type: "settings_changed"; model?: string; effort?: string; permissionMode?: string }
  | {
      type: "user_message";
      text: string;
      images?: ImageRef[];
      baseline?: string;
      queued: boolean;
      cwd?: string;
    }
  | { type: "assistant_text"; block?: BlockRef; text: string }
  | { type: "reasoning"; block?: BlockRef; text: string }
  | ({ type: "delta" } & Delta)
  | {
      type: "tool_call_started";
      callId: string;
      name: string;
      toolType: ToolType;
      input: unknown;
      title?: string;
    }
  | { type: "tool_call_completed"; callId: string; result: ToolResult }
  | { type: "file_edits"; callId?: string; edits: FileEdit[] }
  | { type: "subagent_started"; agentId: string; callId?: string; label?: string }
  | { type: "subagent_completed"; agentId: string; callId?: string; summary?: string }
  | { type: "background_tasks_changed"; tasks: BackgroundTask[] }
  | {
      type: "permission_requested";
      requestId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      title?: string;
      description?: string;
      options: PermissionOption[];
    }
  | { type: "questions_asked"; requestId: string; toolUseId: string; questions: Question[] }
  | {
      type: "permission_decided";
      requestId: string;
      toolUseId?: string;
      allowed: boolean;
      label: string;
      automatic: boolean;
    }
  | { type: "permission_denied"; toolName: string; toolUseId?: string; message: string }
  | { type: "model_request_started" }
  | ({ type: "usage_update" } & Usage)
  | { type: "context_compaction_started" }
  | { type: "context_compacted"; preTokens?: number; postTokens?: number }
  | { type: "api_retry"; attempt: number; maxRetries: number; reason?: string }
  | { type: "rate_limited"; status?: string; resetsAt?: number; message?: string }
  | { type: "status"; text: string }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "unknown"; kind: string };

export type PayloadType = Payload["type"];
