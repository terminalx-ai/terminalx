/** Wire contract: src-tauri/src/local_vm/journal.rs (camelCase serde). */
export type LocalVmJson = null | boolean | number | string | LocalVmJson[] | { [key: string]: LocalVmJson };

export interface LocalVmTaskTarget {
  environmentId: string;
  workspaceId: string;
  taskId: string;
  generation: string;
}

export interface LocalVmInputFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface LocalVmTaskInput {
  parentSessionId: string;
  parentTabId: string;
  parentMessageId: string;
  environmentId: string;
  prompt: string;
  harness: string;
  /** Empty means the provider chooses its default, retained unchanged through submission. */
  model: string;
  effort: string | null;
  permissionMode: string;
  files: LocalVmInputFile[];
  desktop: boolean;
}

export type LocalVmTaskStatus = "queued" | "starting" | "running" | "waiting" | "canceling" | "completed" | "failed" | "canceled" | "outcomeUnknown";

export interface LocalVmTaskEvent {
  seq: number;
  timestamp: string;
  payload: LocalVmJson;
}

export interface LocalVmArtifact {
  id: string;
  name: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  expiresAt: string | null;
}

export interface LocalVmTask {
  target: LocalVmTaskTarget;
  input: LocalVmTaskInput;
  idempotencyKey: string;
  inputDigest: string;
  guestCwd: string;
  workerSessionId: string | null;
  workerTabId: string | null;
  providerConversationId: string | null;
  status: LocalVmTaskStatus;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
  events: LocalVmTaskEvent[];
  artifacts: LocalVmArtifact[];
  outcome: string | null;
  detail: string | null;
}

export interface LocalVmEnvironment {
  id: string;
  name: string;
  sandbox: string;
  generation: string;
  createdAt: string;
  deletedAt: string | null;
  keepAwake: boolean;
  /** Retained guest desktop hold; viewer closure does not return control to queued tasks. */
  manualControl?: boolean;
  provision?: LocalVmEnvironmentInspection;
}

export interface LocalVmState {
  enabled?: boolean;
  /** Host heartbeat observation only; disconnection says nothing about task outcomes. */
  supervisor?: { connected: boolean; lastSeenAt: string | null; detail: string | null };
  environments: Record<string, LocalVmEnvironment>;
  tasks: Record<string, LocalVmTask>;
}

/** Reported by the host/guest; missing readiness is never treated as success. */
export interface LocalVmEnvironmentInspection {
  status: string;
  stages: { id: string; label: string; status: string; detail?: string | null }[];
  detail?: string | null;
  deletion?: LocalVmDeletionInspection | null;
}

export interface LocalVmDeletionInspection {
  canDelete: boolean;
  reason: string | null;
  tasks: Pick<LocalVmTask, "target" | "status" | "workerSessionId" | "workerTabId" | "providerConversationId" | "guestCwd">[];
  guestWork: LocalVmJson;
}

export interface LocalVmDescription {
  available: boolean;
  reason: string | null;
  capabilities: string[];
  harnesses: {
    id: string;
    /** An id of "" explicitly advertises provider-default selection; clients never infer it. */
    models: { id: string; efforts?: string[] }[];
    permissionModes: string[];
  }[];
}

export interface LocalVmArtifactContent {
  name: string;
  mediaType: string;
  content?: string;
  contentBase64?: string;
  url?: string;
}

export interface LocalVmPatchResult {
  applied: boolean;
  conflicts: string[];
  detail: string;
}

export interface LocalVmSubmission {
  idempotencyKey: string;
  input: LocalVmTaskInput;
  sourceRoot: string;
}

export interface LocalVmRecoveryRequest {
  target: LocalVmTaskTarget;
  text: string;
  idempotencyKey: string;
  confirm: true;
}

export interface LocalVmTakeoverResult {
  ready: boolean;
  manualControl: boolean;
  task: LocalVmTask;
}
