import type { RuntimeSession, WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { agentLoginFailure, createErrorMessage, failureMessage, launchFailed, PROVISIONING_TIMEOUT_CODE } from "@/lib/cloudCreate";
import { archiving, deleteFailure, deletion, operationFailureStands, workspaceFailureText } from "@/lib/cloudLifecycle";
import type { TabStatus } from "@/types/session";

export interface CloudAttentionInput {
  connection?: WorkspaceConnectionState["state"] | null;
  tabs?: readonly { status: TabStatus; live?: boolean; created?: string; lastMessageAt?: string | null }[];
  /** Explicit caller evidence that an agent ran; affects this read only, never durable recovery. */
  agentRan?: boolean;
  /** Cached tabs alone are not live caller evidence. */
  fromCache?: boolean;
  /** Verified agent creation/message time (epoch ms), not cache fetch or session modification time. */
  agentActivityAt?: number;
  /** Explicit support from the caller's authorized recovery path; never inferred from a stored login. */
  canRetryFirstTask?: boolean;
}

export type CloudRecoveryAction =
  | "open-agent-logins" | "check-github-access" | "retry-first-task"
  | "open-session" | "update-runtime" | "retry-operation"
  | "open-provider-settings" | "contact-provider" | "create-workspace";

/** Serializable advice, not authority to perform an action or replay a prompt. */
export interface CloudRecovery {
  action: CloudRecoveryAction;
  label: string;
  instructions: string;
  operationAction?: "suspend" | "resume" | "archive" | "delete";
}

export interface CloudAttention {
  /** The launch category, operation error code, or stable fallback code. */
  code: string;
  message: string;
  recovery: CloudRecovery;
}

/** Local catalog evidence; saved with the row, never sent as authority to a runtime. */
type ObservedItem = CloudWorkspaceListItem & {
  resolvedLaunchFailure?: string;
  launchFailureObservation?: { key: string; at: number };
};

function finiteTime(at: unknown): at is number {
  return typeof at === "number" && Number.isFinite(at);
}

function observation(item: CloudWorkspaceListItem | undefined, key: string) {
  const known = (item as ObservedItem | undefined)?.launchFailureObservation;
  return known?.key === key && finiteTime(known.at) ? known : undefined;
}

function sessionActivityTimes(sessions: readonly RuntimeSession[]): number[] {
  return sessions.filter((session) => session.tabs?.length > 0).flatMap((session) => [
    Date.parse(session.created), Date.parse(session.lastMessageAt ?? ""),
    ...session.tabs.flatMap((tab) => [Date.parse(tab.created), Date.parse(tab.lastMessageAt ?? "")]),
  ]).filter(finiteTime);
}

function launchFailureKey(item: CloudWorkspaceListItem): string {
  const launch = item.workspace.launch;
  return JSON.stringify([item.workspace.orgId, item.workspace.id, launch?.launchId, launch?.timings?.requestedAt, launch?.timings?.failedAt, launch?.category, launch?.state, launch?.phase]);
}

function runtimeAgentRan(item: CloudWorkspaceListItem): boolean {
  const runtime = item.workspace.runtimeActivity;
  const failedAt = item.workspace.launch?.timings?.failedAt;
  return !!(runtime?.online && !runtime.stale && runtime.reporting !== false
    && (runtime.activeTurns > 0 || runtime.pendingApprovals > 0)
    && (failedAt == null || (runtime.reportedAt != null && runtime.reportedAt > failedAt)));
}

/**
 * Catalog ingestion records authoritative agent activity for this exact failure.
 * Carry it across list/snapshot replacement so going idle/offline cannot revive
 * the historical failure. A different launch/failure starts with no such evidence.
 * Current runtime activity also counts when older launch reports omit failedAt.
 * Without failedAt, earlier launch milestones are only lower bounds, not proof
 * of failure time. Record the first observation time, at least as late as those
 * milestones and all initially cached activity (including clock skew). Keep that
 * boundary for the exact failure across unchanged snapshots; never advance it
 * on later refreshes. Cached sessions must have activity after this boundary.
 * Credential installation and an online idle runtime deliberately do not count.
 */
export function reconcileCloudAttention(item: CloudWorkspaceListItem, previous?: CloudWorkspaceListItem, sessions: readonly RuntimeSession[] = [], observedAt = Date.now()): CloudWorkspaceListItem {
  const key = launchFailureKey(item);
  const { resolvedLaunchFailure: _old, launchFailureObservation: _observation, ...clean } = item as ObservedItem;
  if (!launchFailed(item)) return clean;
  const boundary = finiteTime(item.workspace.launch?.timings?.failedAt) ? undefined
    : observation(item, key) ?? observation(previous, key) ?? {
      key,
      at: Math.max(observedAt, ...Object.values(item.workspace.launch?.timings ?? {}).filter(finiteTime), ...sessionActivityTimes(sessions)),
    };
  const candidate: ObservedItem = boundary ? { ...clean, launchFailureObservation: boundary } : clean;
  const laterSession = sessions.some((session) => session.tabs?.length > 0 && (
    afterFailure(candidate, Date.parse(session.created))
    || afterFailure(candidate, Date.parse(session.lastMessageAt ?? ""))
    || session.tabs.some((tab) => tabAfterFailure(candidate, tab))
  ));
  const resolved = laterSession || runtimeAgentRan(item)
    || (item as ObservedItem).resolvedLaunchFailure === key
    || (previous as ObservedItem | undefined)?.resolvedLaunchFailure === key;
  return resolved ? { ...candidate, resolvedLaunchFailure: key } as ObservedItem : candidate;
}

/** Dated activity must follow the authoritative failure or its stable observation boundary. */
function afterFailure(item: CloudWorkspaceListItem, at: number | undefined): boolean {
  const failedAt = item.workspace.launch?.timings?.failedAt;
  const boundary = finiteTime(failedAt) ? failedAt : observation(item, launchFailureKey(item))?.at;
  return finiteTime(boundary) && finiteTime(at) && at > boundary;
}

function tabAfterFailure(item: CloudWorkspaceListItem, tab: { created?: string; lastMessageAt?: string | null }): boolean {
  return afterFailure(item, Date.parse(tab.created ?? "")) || afterFailure(item, Date.parse(tab.lastMessageAt ?? ""));
}

/**
 * Preserve explicit agentRan assertions for this read without changing the item.
 * All tabs require dated evidence, including live tabs: connection liveness does
 * not establish when an agent ran. Only reconciliation records durable recovery, using
 * dated activity after the failure or current runtime activity when failedAt is
 * absent; these caller hints never set its marker.
 */
export function launchFailureStands(item: CloudWorkspaceListItem, input: Pick<CloudAttentionInput, "tabs" | "agentRan" | "agentActivityAt" | "fromCache"> = {}): boolean {
  if (input.agentRan) return false;
  if (afterFailure(item, input.agentActivityAt) || input.tabs?.some((tab) => tabAfterFailure(item, tab))) return false;
  if ((item as ObservedItem).resolvedLaunchFailure === launchFailureKey(item)) return false;
  return !runtimeAgentRan(item);
}

const recovery = (action: CloudRecoveryAction, label: string, instructions: string): CloudRecovery => ({ action, label, instructions });
const openSession = (instructions: string) => recovery("open-session", "Open session", instructions);

function launchRecovery(code: string, input: CloudAttentionInput): CloudRecovery {
  if (agentLoginFailure(code)) {
    return recovery("open-agent-logins", "Open Agent logins", "Open Settings → Organizations → this workspace's organization → Agent logins. An owner or admin can repair the agent login. Then open the session and start the agent; adding a login does not send the failed first prompt.");
  }
  if (code === "repository-access-denied") return recovery("check-github-access", "Check GitHub access", "Open this workspace's organization in Settings → Organizations and check that its GitHub connection can access the repository. Then open the session to check the checkout before starting the agent.");
  if (["runtime-interrupted", "runtime-storage-replaced", "launch-intent-unavailable", "runtime-unsupported"].includes(code)) {
    return input.canRetryFirstTask
      ? recovery("retry-first-task", "Retry first task", "Check the session first: the prompt may already have been sent. Use the supported first-task retry only after confirming it is safe to send again.")
      : openSession("Open the session to start the agent yourself. Check whether the first prompt was sent before sending it again.");
  }
  const instructions: Record<string, string> = {
    "agent-unavailable": "Open the session and install or choose an agent available in the workspace image, then start it yourself.",
    "repository-clone-failed": "Open the session and inspect the repository clone error. Repair the checkout before starting the agent.",
    "repository-branch-not-found": "Open the session and choose an existing base branch before starting the agent.",
    "repository-clone-timed-out": "Open the session and check network access and the checkout before retrying the clone.",
    "repository-path-occupied": "Open the session and inspect the occupied repository folder. Preserve its files before choosing another path or repairing the checkout.",
    "repository-empty": "Add a commit to the repository, then open the session to clone it and start the agent.",
    "workspace-disk-full": "Open the session and free disk space before retrying the checkout.",
    "repository-sync-failed": "Open the session and repair the repository checkout before starting the agent.",
    "branch-create-failed": "Open the session and inspect the repository and work branch before starting the agent.",
    "agent-start-failed": "Open the session and inspect the agent startup error before starting it yourself.",
    "agent-model-unavailable": "Open the session and choose a model listed by the workspace's agent CLI, then start the agent.",
    "payload-invalid": "Open the session and choose supported agent settings before starting the agent yourself.",
    "launch-expired": "Open the session and start the agent with your prompt. The expired first prompt cannot be recovered automatically.",
  };
  return openSession(instructions[code] ?? "Open the session and inspect the failure before starting the agent yourself. Check whether the first prompt was sent before sending it again.");
}

/**
 * Shared UI/CLI attention decision. Pass current catalog and agent activity on
 * every render/read. Catalog ingestion retains launch recovery evidence with
 * `reconcileCloudAttention`; this resolver has no process-global memory.
 * Archived rows expose failed deletion recovery; other historical failures are
 * hidden there. Recovery handlers must preserve the item's orgId,
 * existing authorization checks and lifecycle confirmations.
 */
export function resolveCloudAttention(item: CloudWorkspaceListItem, input: CloudAttentionInput = {}): CloudAttention | null {
  const { workspace, latestOperation: operation } = item;
  if (deletion(item) === "running" || archiving(item) || workspace.state === "destroyed") return null;
  if (workspace.state === "archived" && deletion(item) !== "failed") return null;
  if (input.connection === "updateRequired" && deletion(item) !== "failed") return {
    code: "runtime-update-required",
    message: "The app and workspace runtime versions are incompatible. Update TerminalX before reconnecting.",
    recovery: recovery("update-runtime", "Update runtime", "Update TerminalX to a version compatible with the workspace runtime, then reconnect to this workspace."),
  };
  const failedLaunch = launchFailed(item);
  const launchNeedsAttention = failedLaunch && launchFailureStands(item, input);
  // Prefer the specific launch reason while it stands. Once recovered, a failed
  // operation must still be evaluated independently of that historical reason.
  const launchHasReason = launchNeedsAttention && (workspace.launch?.category || workspace.launch?.state === "expired");
  if (operationFailureStands(item) && operation && (operation.action || !launchHasReason || operation.errorCode === PROVISIONING_TIMEOUT_CODE)) {
    const code = operation.errorCode ?? "cloud_workspace_operation_failed";
    let next: CloudRecovery;
    if (code === PROVISIONING_TIMEOUT_CODE) next = recovery("create-workspace", "Create workspace again", "The timed-out machine was deleted. Create a new workspace after reviewing the provider and spend confirmation.");
    else if (operation.action === "delete" && !deleteFailure(operation, workspace.provider).retry) next = recovery("contact-provider", "Contact provider support", workspaceFailureText(item, operation));
    else if (code === "provider_permanent_delete_unavailable") next = recovery("contact-provider", "Contact provider support", "This provider connection cannot delete the workspace permanently. Check the resource in the provider's console or contact its support to finish removing it; retrying this unsupported action will not help.");
    else if (agentLoginFailure(code)) next = launchRecovery(code, input);
    else if (code === "cloud_provider_credential_invalid" || code === "cloud_provider_connection_attention_required") next = recovery("open-provider-settings", "Check provider connection", "An owner or admin can repair this organization's provider connection in Settings, then retry the failed action.");
    else if (operation.action) next = { ...recovery("retry-operation", operation.action === "delete" ? "Retry delete" : `Retry ${operation.action}`, "Review the failure and retry through the workspace's lifecycle action, including its permission checks and confirmations."), operationAction: operation.action };
    else next = recovery("create-workspace", "Create workspace again", "Review the provisioning failure and provider connection before creating a workspace again. Check the provider for any resources left by the failed attempt.");
    return { code, message: agentLoginFailure(code) ? createErrorMessage(code) : workspaceFailureText(item, operation), recovery: next };
  }
  if (launchNeedsAttention) {
    const loginCode = operation?.action == null && operation?.errorCode && agentLoginFailure(operation.errorCode) ? operation.errorCode : null;
    const code = workspace.launch?.category ?? (workspace.launch?.state === "expired" ? "launch-expired" : loginCode ?? "launch-failed");
    return { code, message: failureMessage(item), recovery: launchRecovery(code, input) };
  }
  // The server can retain its coarse attention state after agent recovery.
  // Independent operation/runtime errors were handled above; do not turn a
  // recovered failed launch back into an unexplained generic failure.
  if (workspace.state === "attention-required" && !failedLaunch) return {
    code: "cloud_workspace_attention_required",
    message: "The workspace needs attention. Open it to inspect its runtime and provider state.",
    recovery: openSession("Open the workspace to inspect its runtime and provider state. If it cannot connect, an owner or admin can check the organization's provider connection in Settings."),
  };
  return null;
}
