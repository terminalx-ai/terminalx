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
}

export interface LocalVmState {
  environments: Record<string, LocalVmEnvironment>;
  tasks: Record<string, LocalVmTask>;
}

export interface LocalVmSubmission {
  idempotencyKey: string;
  input: LocalVmTaskInput;
  sourceRoot: string;
}
