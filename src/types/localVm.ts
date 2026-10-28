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
  computer?: import("./computer").ComputerTarget;
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
  transport?: { kind: "macosLume" } | { kind: "linuxContainer"; runtime: "docker" | "podman"; id: string; runtimeSha256?: string };
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
  /** Cached owner report. Reading it never starts setup or requests guest interaction. */
  setup?: LocalVmSetupReport | null;
}

export type LocalVmSetupHarness = "codex" | "claude";
export type LocalVmSetupStatus = "queued" | "working" | "needsAttention" | "ready" | "outcomeUnknown" | "failed";
export type LocalVmSetupStepState = "pending" | "working" | "waiting" | "complete" | "failed" | "unknown";
export type LocalVmSetupAction = "driver.start" | "driver.requestPermissions" | "provider.codexDeviceLogin.start" | "provider.codexDeviceLogin.cancel" | "provider.codexAccount.verify" | "desktop.verify";

export interface LocalVmCreateRequest {
  name: string;
  vmName: string;
  harness: LocalVmSetupHarness;
  idempotencyKey: string;
  confirm: true;
}

export interface LocalVmSetupRequest {
  environmentId: string;
  generation: string;
  harness: LocalVmSetupHarness;
  idempotencyKey: string;
  confirm: true;
}

export interface LocalVmSetupActionRequest {
  environmentId: string;
  generation: string;
  action: LocalVmSetupAction;
  idempotencyKey: string;
  confirm: true;
  /** Cancellation only: identifies the exact guest-owned sign-in actor. */
  loginId?: string;
}

export interface LocalVmReadinessCheck {
  state: string;
  reasonCode: string;
  actionCode: string | null;
}

/** Guest protocol 1 observations. Running services and passive checks do not prove capture. */
export interface LocalVmSetupReadiness {
  protocol: 1;
  environmentId: string;
  generation: string;
  runtime: { version: string; identity: { protocol: number; environmentId: string; generation: string }; state: string };
  driver: LocalVmReadinessCheck & { installedVersion: string | null; requiredVersion: string; runtimeVersion: null };
  accessibility: LocalVmReadinessCheck;
  screenRecording: LocalVmReadinessCheck;
  session: LocalVmReadinessCheck;
  desktop: LocalVmReadinessCheck;
  capture: LocalVmReadinessCheck;
  provider: LocalVmReadinessCheck & { harness: LocalVmSetupHarness; evidence: LocalVmJson; validUntil?: string };
  manualControl: boolean;
  activeTaskTargets: LocalVmTaskTarget[];
  actionAdmission: LocalVmReadinessCheck;
}

export interface LocalVmSetupReport {
  protocol: 1;
  environmentId: string;
  generation: string;
  harness: LocalVmSetupHarness;
  status: LocalVmSetupStatus;
  steps: { id: string; label: string; state: LocalVmSetupStepState; detail?: string | null; actionCode?: string | null }[];
  readiness?: LocalVmSetupReadiness | null;
  lastCheckedAt: string | null;
  detail: string | null;
  /** Owner verified a different serving runtime; an explicit setup recovery can update it. */
  runtimeUpdateAvailable?: boolean;
  /** Receipt of the initial, explicitly confirmed setup request, when retained by the owner. */
  idempotencyKey?: string;
  action?: LocalVmSetupActionReceipt | null;
  /** Keyed canonical receipts survive a newer current action and setup recovery. */
  operations?: Record<string, { receipt: LocalVmSetupActionReceipt }>;
  /** Prior setup requests retained by the owner when recovery queues a new request. */
  history?: LocalVmSetupReport[];
  /** A refused creation remains unavailable through setup recovery or recheck. */
  creationCapability?: LocalVmCreationCapability;
}

export interface LocalVmSetupActionReceipt {
  action: LocalVmSetupAction;
  idempotencyKey: string;
  status: "working" | "needsAttention" | "complete" | "outcomeUnknown" | "failed";
  detail?: string | null;
}

/** Ephemeral reply from the same live guest actor. Never persist this challenge. */
export interface LocalVmSetupAuth {
  protocol: 1;
  environmentId: string;
  generation: string;
  idempotencyKey: string;
  status: "pending" | "awaitingUser" | "complete" | "outcomeUnknown" | "failed" | "none";
  challenge?: { loginId: string; verificationUrl: string; userCode: string; expiresAt?: string | null } | null;
}

export interface LocalVmState {
  enabled?: boolean;
  /** The owner's pinned profile capability, never inferred from VM health. */
  creation?: LocalVmCreationCapability;
  /** Host heartbeat observation only; disconnection says nothing about task outcomes. */
  supervisor?: { connected: boolean; lastSeenAt: string | null; detail: string | null };
  environments: Record<string, LocalVmEnvironment>;
  tasks: Record<string, LocalVmTask>;
}

export interface LocalVmCreationCapability {
  protocol: 1;
  profileId: string;
  available: boolean;
  firstAccountPersonalization: boolean;
  accountBoundTransport: boolean;
  reasonCode: string;
}

/** Reported by the host/guest; missing readiness is never treated as success. */
export interface LocalVmEnvironmentInspection {
  status: string;
  stages: { id: string; label: string; status: string; detail?: string | null }[];
  detail?: string | null;
  deletion?: LocalVmDeletionInspection | null;
  reconciliation?: LocalVmProvisionReview | null;
  /** Durable disposition; the original unknown provisioning record is retained inside evidence. */
  reconciliationReceipt?: LocalVmJson;
}

export interface LocalVmProvisionProposal {
  environmentId: string;
  generation: string;
  sandbox: string;
  evidenceDigest: string;
  observedAt: string;
}

export interface LocalVmProvisionReview {
  available: boolean;
  reason: string | null;
  proposal?: LocalVmProvisionProposal | null;
  evidence?: LocalVmJson;
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
  /** Required for new tasks; absent only on retained pre-selection receipts. */
  target?: import("./computer").ComputerTarget;
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
