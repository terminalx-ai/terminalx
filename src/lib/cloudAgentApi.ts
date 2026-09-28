import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent } from "@/types/events";
import type { AgentProcessState, AgentTabInfo, AgentTabStatus } from "@terminalx/portable/workspace";

export type { AgentProcessState, AgentTabInfo, AgentTabStatus };

/**
 * The desktop's half of the cloud agent command mailbox and transcript
 * checkpoints (docs/CLOUD-AGENT-TABS.md). The Rust side encrypts commands
 * with the workspace content key, keeps the outbox durably and resends it
 * byte for byte; the web view only ever sees plaintext it wrote itself and
 * decrypted projections, never a key.
 */
export interface CloudAgentScope {
  organizationId: string;
  workspaceId: string;
}

export type OutboxKind = "send" | "steer" | "stop" | "permission-decision";
export type OutboxState = "unsent" | "queued" | "leased" | "applied" | "rejected" | "cancelled" | "outcome-unknown";
/** What enqueueing did to the workspace's compute (contract §11.2). */
export type WakeResult = "not-requested" | "not-needed" | "queued" | "in-progress" | "unavailable";

export const TERMINAL_OUTBOX_STATES: ReadonlySet<OutboxState> = new Set(["applied", "rejected", "cancelled", "outcome-unknown"]);

export interface OutboxEntry {
  clientCommandId: string;
  tabId: string;
  kind: OutboxKind;
  /** From the local plaintext, for display. */
  text?: string | null;
  requestId?: string | null;
  state: OutboxState;
  wake?: WakeResult | null;
  outcome?: string | null;
  category?: string | null;
  /** The runtime's decrypted receipt. */
  receipt?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  /** The last delivery error while the entry is still unsent. */
  error?: string | null;
}

/** The plaintext of a command, without its `v`. */
export type OutboxPayload =
  | { text: string; model?: string; effort?: string | null; mode?: string }
  | { requestId: string; optionId: string }
  | { requestId: string; answers: Record<string, string> }
  | Record<string, never>;

export interface CheckpointMeta {
  tabId: string;
  epoch: number;
  version: number;
  schemaVersion?: number;
  keyId?: string;
  sha256?: string;
  byteSize?: number;
  runtimeGeneration?: number;
  createdAt?: number;
}

/** A decrypted checkpoint projection, schema 1. */
export interface Projection {
  v: 1;
  sessionId: string;
  tabId: string;
  title: string | null;
  harness: string;
  model: string;
  effort: string | null;
  permissionMode: string;
  status: AgentTabStatus;
  process: AgentProcessState;
  events: AgentEvent[];
  truncated: boolean;
  followUps: { clientCommandId: string; text: string }[];
  updatedAt: number;
}

export interface Checkpoint {
  epoch: number;
  version: number;
  projection: Projection;
}

/** What the desktop keeps of a tab between runs. */
export interface CachedTab {
  tab: AgentTabInfo;
  /** Committed events in seq order. */
  events: AgentEvent[];
  /** The live stream's resume point (bound to a runtime generation). */
  cursor: string | null;
  /** The newest checkpoint applied. */
  checkpoint: { epoch: number; version: number } | null;
  unread: boolean;
  completed: boolean;
  updatedAt: number;
}

export const cloudAgentApi = {
  enqueue: (scope: CloudAgentScope, tabId: string, kind: OutboxKind, payload: OutboxPayload) =>
    invoke<OutboxEntry>("cloud_agent_enqueue", { ...scope, tabId, kind, payload }),
  outbox: (scope: CloudAgentScope, tabId?: string) => invoke<OutboxEntry[]>("cloud_agent_outbox", { ...scope, tabId: tabId ?? null }),
  outboxSync: (scope: CloudAgentScope) => invoke<OutboxEntry[]>("cloud_agent_outbox_sync", { ...scope }),
  cancel: (scope: CloudAgentScope, clientCommandId: string) => invoke<OutboxEntry>("cloud_agent_cancel", { ...scope, clientCommandId }),
  checkpoints: (scope: CloudAgentScope) => invoke<CheckpointMeta[]>("cloud_agent_checkpoints", { ...scope }),
  checkpoint: (scope: CloudAgentScope, tabId: string, after?: { epoch: number; version: number } | null) =>
    invoke<Checkpoint | null>("cloud_agent_checkpoint", {
      ...scope,
      tabId,
      afterEpoch: after?.epoch ?? null,
      afterVersion: after?.version ?? null,
    }),
  hasKey: (scope: CloudAgentScope) => invoke<boolean>("cloud_agent_has_key", { ...scope }),
  cacheLoad: (scope: CloudAgentScope) => invoke<{ tabs: Record<string, CachedTab> }>("cloud_agent_cache_load", { ...scope }),
  cacheSave: (scope: CloudAgentScope, tabId: string, entry: CachedTab | null) => invoke<void>("cloud_agent_cache_save", { ...scope, tabId, entry }),
};
