import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { dispositionFacts, hasUnpublishedWork, type DispositionFacts, type RepositoryFacts } from "@terminalx/portable/workspaceGit";
import {
  api,
  closeWorkspaceConnection,
  workspaceConnection,
  workspaceTargetKey,
  type CloudWorkspace,
  type CloudWorkspaceCleanup,
  type CloudWorkspaceDisposition,
  type CloudWorkspaceListItem,
  type CloudWorkspaceOperation,
  type CloudWorkspaceTombstone,
} from "@/lib/api";
import { dropCloudAgents } from "@/lib/cloudAgents";
import { dropCloudTerminals } from "@/lib/cloudTerminals";
import { dropEditors, getEditors } from "@/lib/editors";

/**
 * Stop, archive and delete of a cloud workspace (terminalx-saas contract
 * §10): what each keeps, what a destructive action would put at risk, the
 * cleanup report until the provider confirms, and purging what this Mac
 * kept of a workspace once its tombstone arrives.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** In the archive: archived, or an archive that failed and stays listed there to retry. */
export function isArchived(workspace: CloudWorkspace): boolean {
  return workspace.state === "archived" || typeof workspace.archivedAt === "number";
}

function open(operation: CloudWorkspaceOperation | null | undefined): boolean {
  return !!operation && ["queued", "running", "cancel-requested"].includes(operation.state);
}

/** A permanent delete still cleaning up, or one that stopped and can be resumed. */
export function deletion(item: CloudWorkspaceListItem): "running" | "failed" | null {
  const operation = item.latestOperation;
  if (operation?.action !== "delete") return null;
  if (open(operation)) return "running";
  if (operation.state === "failed") return "failed";
  return null;
}

/** An archive still quiescing, checkpointing or suspending. */
export function archiving(item: CloudWorkspaceListItem): boolean {
  return item.latestOperation?.action === "archive" && open(item.latestOperation);
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

const MESSAGES: Record<string, string> = {
  cloud_workspace_active_work: "An agent is still working in this workspace.",
  cloud_workspace_archived: "This workspace is archived. Unarchive it first.",
  cloud_teardown_in_progress: "Your organization is shutting down its cloud workspaces; this cannot change now.",
  cloud_workspace_operation_in_progress: "Another action on this workspace is still running. Try again when it finishes.",
  cloud_provider_connection_attention_required: "The provider connection needs attention (it is being disconnected or its credential failed).",
  cloud_provider_credential_invalid: "The provider credential is no longer valid. An admin can repair it, then retry.",
  cloud_provider_unavailable: "The provider did not answer. Retry resumes where it stopped.",
  cloud_provider_rate_limited: "The provider is rate limiting. Retry resumes where it stopped.",
  provider_permanent_delete_unavailable: "This provider connection cannot delete workspaces permanently.",
  provider_cleanup_pending: "The provider is still removing resources.",
  cloud_workspace_request_outcome_unknown: "No answer arrived. The action may have been applied; the list below is the source of truth.",
  cloud_workspace_not_found: "This workspace no longer exists.",
  organization_admin_required: "Only an organization admin can do this.",
};

export function lifecycleErrorMessage(code: string): string {
  return MESSAGES[code] ?? `The action failed (${code}).`;
}

// ---- what a destructive action would put at risk

export type RuntimeCheck =
  | { kind: "checked"; facts: DispositionFacts }
  /** Not running: nothing can be asked without waking it. */
  | { kind: "offline" }
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

/** One line per thing at risk in a repository. */
export function repositoryRiskLines(repo: RepositoryFacts): string[] {
  const lines: string[] = [];
  if (repo.dirtyFiles) lines.push(`${repo.dirtyFiles} uncommitted file${repo.dirtyFiles === 1 ? "" : "s"}`);
  if (repo.unpushedCommits) lines.push(`${repo.unpushedCommits} unpushed commit${repo.unpushedCommits === 1 ? "" : "s"}`);
  else if (repo.localOnlyCommits) lines.push(`${repo.localOnlyCommits} commit${repo.localOnlyCommits === 1 ? "" : "s"} on no remote branch`);
  for (const pr of repo.openPullRequests ?? []) lines.push(`Open pull request #${pr.number}`);
  return lines;
}

function waitConnected(client: WorkspaceRpcClient, withinMs: number): Promise<boolean> {
  if (client.connection.state === "connected") return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      stop();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), withinMs);
    const stop = client.onState((state) => {
      if (state.state === "connected") done(true);
      else if (["suspended", "stopped", "updateRequired"].includes(state.state)) done(false);
    });
  });
}

/**
 * Ask a running workspace's runtime what an archive or delete would lose
 * (`lifecycle.dispositionFacts`). Never wakes suspended compute: a workspace
 * that is not running is reported offline instead of guessed at.
 */
export async function checkRuntime(workspace: CloudWorkspace, server: CloudWorkspaceDisposition | null, withinMs = 15_000): Promise<RuntimeCheck> {
  if (server && !server.runtimeFacts.available) return { kind: "unsupported" };
  if (workspace.state !== "ready") return { kind: "offline" };
  const target = { kind: "cloud" as const, organizationId: workspace.orgId, workspaceId: workspace.id };
  try {
    const connection = await workspaceConnection(target, "connect");
    if (!connection || !(await waitConnected(connection.client, withinMs))) return { kind: "offline" };
    const facts = await dispositionFacts(connection.client);
    return facts ? { kind: "checked", facts } : { kind: "unsupported" };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    // Asked from the workspace list, where nothing else holds a connection;
    // an archive or delete revokes it anyway.
    closeWorkspaceConnection(target);
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
    const scope = { organizationId: tombstone.orgId, workspaceId: tombstone.id };
    const target = { kind: "cloud" as const, ...scope };
    const key = workspaceTargetKey(target);
    closeWorkspaceConnection(target);
    const editors = getEditors().editors.filter((entry) => entry.sessionId === key);
    const unsavedFiles = editors.filter((entry) => entry.dirty).length;
    if (editors.length) dropEditors((entry) => entry.sessionId === key);
    dropCloudTerminals(key);
    const tabs = dropCloudAgents(scope);
    let native;
    try {
      native = await api.cloudAgentPurgeWorkspace(tombstone.orgId, tombstone.id);
    } catch {
      continue;
    }
    purged.add(id);
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
