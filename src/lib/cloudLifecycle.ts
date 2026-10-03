import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { dispositionFacts, hasUnpublishedWork, type DispositionFacts, type RepositoryFacts } from "@terminalx/portable/workspaceGit";
import {
  api,
  closeWorkspaceConnection,
  workspaceTargetKey,
  type CloudWorkspace,
  type CloudWorkspaceCleanup,
  type CloudWorkspaceDisposition,
  type CloudWorkspaceListItem,
  type CloudWorkspaceOperation,
  type CloudWorkspaceTombstone,
} from "@/lib/api";
import { roleRefusedMessage } from "@/lib/accountRoles";
import { closeCloudConnection } from "@/lib/cloudConnections";
import { dropCloudAgents } from "@/lib/cloudAgents";
import { dropCloudTerminals } from "@/lib/cloudTerminals";
import { dropEditors, getEditors } from "@/lib/editors";
import { retainCloudConnection, waitCloudConnected, type CloudLease } from "@/lib/cloudConnections";

/**
 * Stop, archive and delete of a cloud workspace (terminalx-saas contract
 * §10): what each keeps, what a destructive action would put at risk, the
 * cleanup report until the provider confirms, and purging what this Mac
 * kept of a workspace once its tombstone arrives.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** In the archive: archived, or an archive that failed and stays listed there to retry. */
export function isArchived(workspace: CloudWorkspace): boolean {
  return workspace.state === "archived" || typeof workspace.archivedAt === "number";
}

/** Queued, running or being canceled. */
export function isOpen(operation: CloudWorkspaceOperation | null | undefined): boolean {
  return !!operation && ["queued", "running", "cancel-requested"].includes(operation.state);
}

/** A stop still running: the machine is on its way down, whoever asked. */
export function stopping(item: Pick<CloudWorkspaceListItem, "latestOperation">): boolean {
  return isOpen(item.latestOperation) && item.latestOperation?.action === "suspend";
}

/** The machine runs as far as the list knows: ready, with no stop, archive or delete taking it down. */
export function machineRunning(item: CloudWorkspaceListItem): boolean {
  const operation = item.latestOperation;
  const goingDown = isOpen(operation) && (operation?.action === "suspend" || operation?.action === "archive" || operation?.action === "delete");
  return item.workspace.state === "ready" && !goingDown;
}

/** A permanent delete still cleaning up, or one that stopped and can be resumed. */
export function deletion(item: CloudWorkspaceListItem): "running" | "failed" | null {
  const operation = item.latestOperation;
  if (operation?.action !== "delete") return null;
  if (isOpen(operation)) return "running";
  if (operation.state === "failed") return "failed";
  return null;
}

/** An archive still quiescing, checkpointing or suspending. */
export function archiving(item: CloudWorkspaceListItem): boolean {
  return item.latestOperation?.action === "archive" && isOpen(item.latestOperation);
}

/** "in 29 days", "in 5 hours", "within the hour", or "overdue". */
export function deadlineText(deleteAfter: number, now = Date.now()): string {
  const left = deleteAfter - now;
  if (left <= 0) return "any moment now";
  const days = Math.floor(left / DAY_MS);
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(left / (60 * 60 * 1000));
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "within the hour";
}

export function dateText(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const CLEANUP_KINDS: Record<string, string> = {
  "runtime-credentials": "Workspace credentials",
  "client-attachments": "Device connections",
  "provider-compute": "Machine",
  "provider-storage": "Disk and snapshots",
  "workspace-content": "Saved conversations, settings and secrets",
};

export function cleanupKindText(kind: string): string {
  return CLEANUP_KINDS[kind] ?? kind;
}

/** One cleanup line's state, in words. */
export function cleanupStateText(item: CloudWorkspaceCleanup["items"][number], now = Date.now()): string {
  switch (item.state) {
    case "removed":
      return "Removed";
    case "pending": {
      const stage = item.providerStage ? ` (${item.providerStage.replace(/_/g, " ")})` : "";
      const expected = item.expectedBy && item.expectedBy > now ? `, expected ${deadlineText(item.expectedBy, now)}` : "";
      return `Waiting for the provider to confirm${stage}${expected}`;
    }
    case "retained-by-provider":
      return "Kept by the provider under its own retention; it may still be billed there";
    case "unconfirmed":
      return "The provider no longer reports it but never confirmed it was deleted";
    default:
      return item.state;
  }
}

/** What remains until the provider confirms, for a one-line summary. */
export function remaining(cleanup: CloudWorkspaceCleanup): CloudWorkspaceCleanup["items"] {
  return cleanup.items.filter((item) => item.state !== "removed");
}

export function checkpointText(checkpoint: CloudWorkspaceOperation["checkpoint"]): string | null {
  switch (checkpoint) {
    case "committed":
      return "The runtime saved its conversations before stopping.";
    case "failed":
      return "The runtime could not save its conversations before stopping; the disk was still kept.";
    case "timed-out":
      return "The runtime did not finish saving within a minute; the disk was still kept.";
    case "skipped":
      return "The workspace was not running, so there was nothing more to save.";
    case null:
    case undefined:
      return null;
    default:
      return String(checkpoint);
  }
}

/**
 * What a stopped workspace's last stop saved, from the stop itself: when its
 * conversations were saved, or that the save did not finish. Null when the
 * workspace is not stopped, when something happened to it since, or when the
 * server said nothing about a save. The disk is kept by a stop either way.
 */
export function lastSavedText(item: CloudWorkspaceListItem): string | null {
  const operation = item.latestOperation;
  if (item.workspace.state !== "suspended" || operation?.action !== "suspend" || operation.state !== "succeeded") return null;
  switch (operation.checkpoint) {
    case "committed":
      return operation.checkpointAt ? `Last saved ${dateTimeText(operation.checkpointAt)}.` : "Its conversations were saved before it stopped.";
    case "failed":
    case "timed-out":
      return "The save before it stopped did not finish; conversations may end earlier than the work did. The disk was kept as it was.";
    default:
      return null;
  }
}

export function dateTimeText(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * What resuming a stopped workspace brings back, in the provider's terms
 * (PRO-33): the same processes again, or a cold boot from the disk. `name`
 * is the provider's display name; `null` is a server that does not say.
 */
export function resumeBehaviourText(name: string, preservesProcesses: boolean | null | undefined): string {
  if (preservesProcesses === true) return `Resume at any time. ${name} freezes the machine as it is: programs and terminals that are running continue where they were.`;
  if (preservesProcesses === false)
    return `Resume at any time. ${name} starts the machine again from its disk (a cold boot): files, repositories and conversations come back; programs and terminals that are running now do not.`;
  return "Resume at any time. Files, repositories and conversations come back; programs and terminals that are running now may not.";
}

const MESSAGES: Record<string, string> = {
  cloud_workspace_concurrency_exceeded: "Your organization is running as many cloud workspaces as its limit allows. Stop one to start another.",
  cloud_workspace_active_work: "An agent is still working in this workspace.",
  cloud_workspace_archived: "This workspace is archived. Unarchive it first.",
  cloud_teardown_in_progress: "Your organization is shutting down its cloud workspaces; this cannot change now.",
  cloud_workspace_operation_in_progress: "Another action on this workspace is still running. Try again when it finishes.",
  cloud_provider_connection_attention_required: "The provider connection needs attention (it is being disconnected or its credential failed).",
  cloud_provider_credential_invalid: "The provider credential is no longer valid. An admin can repair it, then retry.",
  cloud_provider_permission_denied: "The provider refused this action, though its credential is still valid. Retry, or check the key's permissions at the provider.",
  cloud_workspace_runtime_bootstrap_failed: "The workspace's runtime could not be set up on its machine. Retry; the provider credential is fine.",
  cloud_provider_state_conflict: "The provider reports this resource in a state that does not allow the action yet. Retry in a moment; if it keeps failing, check the resource in the provider's console.",
  cloud_provider_unavailable: "The provider did not answer. Retry resumes where it stopped.",
  cloud_provider_rate_limited: "The provider is rate limiting. Retry resumes where it stopped.",
  provider_permanent_delete_unavailable: "This provider connection cannot delete workspaces permanently.",
  provider_cleanup_pending: "The provider is still removing resources.",
  cloud_workspace_request_outcome_unknown: "No answer arrived. The action may have been applied; the list below is the source of truth.",
  cloud_workspace_not_found: "This workspace no longer exists.",
  // Offered because the app still held an owner's or admin's role: it changed since.
  organization_admin_required: roleRefusedMessage("stop, resume, archive or delete a cloud workspace"),
  forbidden: roleRefusedMessage("stop, resume, archive or delete a cloud workspace"),
};

export function lifecycleErrorMessage(code: string): string {
  return MESSAGES[code] ?? `The action failed (${code}).`;
}

/**
 * Why a lifecycle operation stopped: the message for its code, followed by
 * the provider's own safe error code when the server reports one.
 */
export function operationFailureText(operation: Pick<CloudWorkspaceOperation, "errorCode" | "providerErrorCode">): string {
  const message = lifecycleErrorMessage(operation.errorCode ?? "cloud_workspace_unknown_error");
  return operation.providerErrorCode ? `${message} (Provider code: ${operation.providerErrorCode})` : message;
}

/** Boat's provider id. */
const BOAT = "box";
/** Boat accepted a deletion but still reports the sandbox: only Boat can finish it. */
const DELETED_SANDBOX_PRESENT = "box_deleted_sandbox_present";
/** What a scoped Boat key needs before TerminalX can delete a sandbox. */
const BOAT_DELETE_SCOPES = "sandbox.read and sandbox.delete";

/**
 * Why a permanent delete stopped, and whether deleting again can help
 * (PRO-52). The sentence names only what the row shows: "Retry delete" is the
 * one button under it, and it is named only when it is offered.
 *
 * - Boat accepted the deletion but still reports the sandbox
 *   (`box_deleted_sandbox_present`): neither a retry nor a broader key helps,
 *   so neither is advised and no retry is offered. The deletion's operation
 *   id is what Boat's support asks for; the server gives it to admins only.
 * - Boat refused the delete (or the read of its sandbox): the connected key's
 *   scope is what is missing.
 */
export function deleteFailure(
  operation: Pick<CloudWorkspaceOperation, "errorCode" | "providerErrorCode" | "detailCode" | "cleanup">,
  provider: string,
  /**
   * `idRead`: the operation was read with its cleanup report, so a missing
   * id means this person may not see it. Until then (a list row, or before
   * the first read) nothing is said about who can, so the sentence does not
   * change under an admin once the id arrives.
   */
  options: { idRead?: boolean } = {},
): { text: string; retry: boolean } {
  if (deleteAwaitsProvider(operation)) {
    const id = operation.cleanup?.items.find((entry) => entry.providerOperationId)?.providerOperationId;
    const which = id ? `: ${id}` : options.idRead ? "; an organization owner or admin can see it here" : "";
    return { text: `Boat accepted the deletion but still reports the sandbox. Contact Boat support with the deletion operation id${which}.`, retry: false };
  }
  if (provider === BOAT && operation.errorCode === "cloud_provider_permission_denied") {
    return {
      // Boat's own code when it sent one; never a made-up one in its place.
      text: `Boat refused to delete this workspace${operation.providerErrorCode ? ` (${operation.providerErrorCode})` : ""}: the connected key is not allowed to read or delete it. An owner or admin can connect a key with ${BOAT_DELETE_SCOPES} that covers all sandboxes in Settings, then press ${RETRY_DELETE}.`,
      retry: true,
    };
  }
  return { text: operationFailureText(operation), retry: true };
}

/** The one button under a stopped delete; a failure sentence that names a button names this one. */
export const RETRY_DELETE = "Retry delete";

/** A delete only the provider can finish: deleting again, from anywhere, cannot help. */
export function deleteAwaitsProvider(operation: Pick<CloudWorkspaceOperation, "detailCode"> | null | undefined): boolean {
  return operation?.detailCode === DELETED_SANDBOX_PRESENT;
}

/**
 * Why a workspace's last operation failed, wherever it is said (the stopped
 * delete's own line, the row's tooltip, the main view): a failed delete gets
 * the same sentence in all of them.
 */
export function workspaceFailureText(item: Pick<CloudWorkspaceListItem, "workspace">, operation: CloudWorkspaceOperation): string {
  return operation.action === "delete" ? deleteFailure(operation, item.workspace.provider).text : operationFailureText(operation);
}

// ---- what a destructive action would put at risk

export type RuntimeCheck =
  | { kind: "checked"; facts: DispositionFacts }
  /** Not running (stopped, archived, starting): nothing can be asked without waking it. */
  | { kind: "offline" }
  /**
   * Running by the server's account, but this desktop could not reach its
   * runtime in time (the relay was slow, the connection kept dropping).
   * Nothing is known about its work, which is not the same as it being off.
   */
  | { kind: "unreachable" }
  /** The runtime predates `lifecycle.dispositionFacts`. */
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export interface Risks {
  repositories: RepositoryFacts[];
  /** Agent turns running, by the runtime's count or else the server's activity report. */
  activeTurns: number;
  pendingApprovals: number;
  runningProcesses: number;
  operationInProgress: boolean;
  /** Archive refuses, and a lifecycle client's delete refuses, without `force` (§10.2). */
  needsForce: boolean;
}

export function risksOf(server: CloudWorkspaceDisposition | null, runtime: RuntimeCheck | null): Risks {
  const facts = runtime?.kind === "checked" ? runtime.facts : null;
  const activeTurns = Math.max(facts?.activeTasks.length ?? 0, server?.runtime.activeTurns ?? 0);
  const pendingApprovals = server?.runtime.pendingApprovals ?? 0;
  return {
    repositories: facts?.repositories.filter(hasUnpublishedWork) ?? [],
    activeTurns,
    pendingApprovals,
    runningProcesses: facts?.runningProcesses ?? 0,
    operationInProgress: server?.blockers.includes("operation-in-progress") ?? false,
    needsForce:
      activeTurns > 0 ||
      pendingApprovals > 0 ||
      !!server?.blockers.some((blocker) => blocker === "active-turns" || blocker === "pending-approvals"),
  };
}

/**
 * What to call a repository in a list of work at risk. The runtime reports
 * paths relative to the workspace, so a blank project's one repository (the
 * workspace folder itself) comes back as ".": that shows as the workspace's
 * name, or "Project folder" without one.
 */
export function repositoryLabel(repo: Pick<RepositoryFacts, "path">, workspaceName?: string | null): string {
  const path = repo.path.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (path === "" || path === ".") return workspaceName?.trim() || "Project folder";
  return path;
}

/** One line per thing at risk in a repository. */
export function repositoryRiskLines(repo: RepositoryFacts): string[] {
  const lines: string[] = [];
  if (repo.dirtyFiles) lines.push(`${repo.dirtyFiles} uncommitted file${repo.dirtyFiles === 1 ? "" : "s"}`);
  if (repo.unpushedCommits) lines.push(`${repo.unpushedCommits} unpushed commit${repo.unpushedCommits === 1 ? "" : "s"}`);
  else if (repo.localOnlyCommits) lines.push(`${repo.localOnlyCommits} commit${repo.localOnlyCommits === 1 ? "" : "s"} on no remote branch`);
  for (const pr of repo.openPullRequests ?? []) lines.push(`Open pull request #${pr.number}`);
  return lines;
}

/**
 * Ask a running workspace's runtime what an archive or delete would lose
 * (`lifecycle.dispositionFacts`). Looking never wakes compute: only a
 * workspace the server reports ready is connected to, with `connect`. A
 * workspace that is not running is reported `offline`; one that is running
 * but could not be reached in time is `unreachable`, never "not running".
 *
 * The connection is a lease from the connection manager, given back after
 * the check: it shares the one an open session holds and never closes it
 * underneath that session (closing the api's connection here left the
 * session on a dead client that still read connected).
 */
export async function checkRuntime(workspace: CloudWorkspace, server: CloudWorkspaceDisposition | null, withinMs = 15_000): Promise<RuntimeCheck> {
  if (server && !server.runtimeFacts.available) return { kind: "unsupported" };
  // The server's just-read state is fresher than the list row's.
  if ((server?.state ?? workspace.state) !== "ready") return { kind: "offline" };
  let lease: CloudLease | null = null;
  try {
    lease = await retainCloudConnection({ orgId: workspace.orgId, workspaceId: workspace.id }, "connect");
    let client: WorkspaceRpcClient;
    try {
      client = await waitCloudConnected(lease, withinMs, { stoppedIsError: true });
    } catch (error) {
      // `suspended` is the native side's answer from the API that compute is not running; anything else never got there.
      return error instanceof Error && error.message === "cloud_workspace_stopped" ? { kind: "offline" } : { kind: "unreachable" };
    }
    const facts = await dispositionFacts(client);
    return facts ? { kind: "checked", facts } : { kind: "unsupported" };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    lease?.release();
  }
}

// ---- tombstones

export interface PurgeNotice {
  workspaceId: string;
  /** From an earlier list; a tombstone itself carries no name. */
  name: string | null;
  unsentCommands: number;
  unsavedFiles: number;
}

/** `organization:workspace` ids already purged in this run of the app. */
const purged = new Set<string>();

/**
 * Drop everything this Mac kept of deleted workspaces: the agent outbox,
 * transcript cache and keys (native), the open connection, terminals, agent
 * tabs and cloud editors with their unsaved text. Returns a notice for each
 * workspace that had something here, so the page can say what went with it.
 * A native purge that fails is tried again on the next list.
 */
export async function purgeTombstones(tombstones: CloudWorkspaceTombstone[], names: ReadonlyMap<string, string>): Promise<PurgeNotice[]> {
  const notices: PurgeNotice[] = [];
  for (const tombstone of tombstones) {
    const id = `${tombstone.orgId}:${tombstone.id}`;
    if (purged.has(id)) continue;
    // Claimed now, so an overlapping list reload skips it.
    purged.add(id);
    let native;
    try {
      native = await api.cloudAgentPurgeWorkspace(tombstone.orgId, tombstone.id);
    } catch {
      // Nothing here is dropped yet; the next list tries it all again.
      purged.delete(id);
      continue;
    }
    const scope = { organizationId: tombstone.orgId, workspaceId: tombstone.id };
    const target = { kind: "cloud" as const, ...scope };
    const key = workspaceTargetKey(target);
    closeCloudConnection({ orgId: tombstone.orgId, workspaceId: tombstone.id });
    closeWorkspaceConnection(target);
    const editors = getEditors().editors.filter((entry) => entry.sessionId === key);
    const unsavedFiles = editors.filter((entry) => entry.dirty).length;
    if (editors.length) dropEditors((entry) => entry.sessionId === key);
    dropCloudTerminals(key);
    const tabs = dropCloudAgents(scope);
    const name = names.get(tombstone.id) ?? null;
    if (native.removed || unsavedFiles > 0 || editors.length > 0 || tabs > 0 || name) {
      notices.push({ workspaceId: tombstone.id, name, unsentCommands: native.unsentCommands, unsavedFiles });
    }
  }
  return notices;
}

/** For tests. */
export function resetPurged(): void {
  purged.clear();
}

export function purgeNoticeText(notice: PurgeNotice): string {
  const what = notice.name ? `“${notice.name}”` : "A cloud workspace";
  const lost: string[] = [];
  if (notice.unsentCommands) lost.push(`${notice.unsentCommands} agent message${notice.unsentCommands === 1 ? "" : "s"} that never reached it`);
  if (notice.unsavedFiles) lost.push(`unsaved edits in ${notice.unsavedFiles} file${notice.unsavedFiles === 1 ? "" : "s"}`);
  const tail = lost.length ? `, including ${lost.join(" and ")}` : "";
  return `${what} was permanently deleted. TerminalX removed what this Mac kept of it${tail}.`;
}
