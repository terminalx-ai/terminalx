/** MCP servers, slash commands and skills compared across Claude Code's and Codex's homes (PRO-153, `src-tauri/src/agent_configs.rs`). */
export type AgentConfigKind = "mcp" | "command" | "skill";
export type AgentConfigStatus = "onlyClaude" | "different" | "onlyCodex" | "same";
export type AgentConfigDirection = "toCodex" | "toClaude";

export interface AgentConfigItem {
  kind: AgentConfigKind;
  name: string;
  status: AgentConfigStatus;
  claudeSummary: string | null;
  codexSummary: string | null;
  /** Why the item cannot be copied that way, when it cannot. */
  toCodexBlocked: string | null;
  toClaudeBlocked: string | null;
}

export interface AgentConfigComparison {
  claudeFile: string;
  codexFile: string;
  items: AgentConfigItem[];
  /** A source that could not be read; its items are missing from the list. */
  problems: string[];
}

export interface AgentConfigChange {
  kind: AgentConfigKind;
  name: string;
  direction: AgentConfigDirection;
}

export interface AgentConfigPreviewFile {
  path: string;
  backup: string | null;
  text: string;
}

export interface AgentConfigCounts {
  mcp: number;
  command: number;
  skill: number;
}

export interface AgentConfigPreview {
  files: AgentConfigPreviewFile[];
  notes: { kind: AgentConfigKind; name: string; text: string }[];
  added: AgentConfigCounts;
  replaced: AgentConfigCounts;
  /** Apply passes it back; the backend refuses it once the files have changed. */
  token: string;
}

export interface AgentConfigWritten {
  path: string;
  backup: string | null;
}
