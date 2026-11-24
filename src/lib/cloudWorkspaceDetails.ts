import { phase2Ready } from "@/lib/phase2Readiness";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import * as cloudApi from "@/lib/api";
import type { CloudWorkspace, CloudWorkspaceListItem, CloudWorkspaceOperation, CloudWorkspaceSnapshot } from "@/lib/api";
import { getAccount, subscribeAccount, useAccount } from "@/lib/account";
import { applyCloudSnapshot, refreshCloudCatalog } from "@/lib/cloudCatalog";
import { reconnectCloudWorkspace } from "@/lib/cloudConnections";
import { workspaceAuthority } from "@/lib/cloudCollab";
import { isArchived, isOpen, lifecycleErrorMessage } from "@/lib/cloudLifecycle";

export function workspaceRestarting(item: CloudWorkspaceListItem): boolean {
  return item.latestOperation?.transportAction === "restart" && isOpen(item.latestOperation);
}

export function provisioningLogUrl(details: CloudWorkspaceDetailsResponse["details"]): string | null {
  const url = details.provisioningLog?.url;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? url : null;
  } catch {
    return null;
  }
}

// Structural adapter for the accepted shared worker's public API. This worktree
// can compile before collection; absent methods keep entrypoints held. No native
// invocation or transport/projection fallback is implemented here.
export interface CloudWorkspaceDetailsResponse {
  workspace: CloudWorkspace;
  details: {
    organizationId: string;
    workspaceId: string;
    createdBy: string;
    provider: string;
    repositories: { identity: string | null; fullName: string | null; cloneUrl: string; ref: string | null; targetDirectory: string | null; primary: boolean }[];
    machineId: string | null;
    environmentVersionId: string | null;
    environmentVersion: { id: string; versionNumber: number; toolchainVersion: number } | null;
    runtime: { sha256: string; protocol: number | null; installedAt: number } | null;
    provisioningLog: { url: string; operationId: string | null } | null;
  };
}
interface RestartSnapshot {
  workspace: CloudWorkspace;
  operation: Omit<CloudWorkspaceOperation, "action"> & { action: CloudWorkspaceOperation["action"] | "restart" };
}
interface DetailsApi {
  cloudWorkspaceDetails(workspaceId: string, orgId?: string | null): Promise<CloudWorkspaceDetailsResponse>;
  cloudWorkspaceRestart(workspaceId: string, orgId?: string | null): Promise<RestartSnapshot>;
  cloudWorkspaceOperationDto(operationId: string, orgId?: string | null): Promise<RestartSnapshot>;
}
function publicContracts(): { api: DetailsApi; project: (snapshot: RestartSnapshot) => CloudWorkspaceSnapshot } | null {
  const candidate = cloudApi.api as typeof cloudApi.api & Partial<DetailsApi>;
  if (typeof candidate.cloudWorkspaceDetails !== "function"
    || typeof candidate.cloudWorkspaceRestart !== "function"
    || typeof candidate.cloudWorkspaceOperationDto !== "function"
    || !("projectCloudWorkspaceSnapshot" in cloudApi)) return null;
  const projection: unknown = Reflect.get(cloudApi, "projectCloudWorkspaceSnapshot");
  if (typeof projection !== "function") return null;
  return { api: candidate as DetailsApi, project: projection as (snapshot: RestartSnapshot) => CloudWorkspaceSnapshot };
}
function requireContracts() {
  const contracts = publicContracts();
  if (!contracts) throw { code: "cloud_workspace_runtime_not_ready" };
  return contracts;
}

/** Fence account/profile transitions; target routes authorize by membership. */
function accountScope(): string {
  const { status } = getAccount();
  return JSON.stringify([status?.state, status?.context, status?.identity?.email, status?.identity?.organizationId]);
}

// Remember transitions, including A -> B -> A between asynchronous observations.
let accountEpoch = 0;
let observedScope: string | undefined;
let observingAccount = false;
export function detailsScope(): string {
  if (!observingAccount) {
    observingAccount = true;
    observedScope = accountScope();
    subscribeAccount(() => {
      const next = accountScope();
      if (next !== observedScope) { observedScope = next; ++accountEpoch; }
    });
  }
  return JSON.stringify([accountEpoch, accountScope()]);
}

export function useWorkspaceDetailsAvailable(orgId: string): boolean {
  const { status } = useAccount();
  return !useDataPrivacy().enabled && publicContracts() !== null && phase2Ready(status, orgId, "restartDetails");
}

export async function loadWorkspaceDetails(item: CloudWorkspaceListItem): Promise<CloudWorkspaceDetailsResponse> {
  const scope = detailsScope();
  const { id, orgId } = item.workspace;
  const result = await requireContracts().api.cloudWorkspaceDetails(id, orgId);
  if (scope !== detailsScope() || result.workspace.id !== id || result.workspace.orgId !== orgId
    || result.details.workspaceId !== id || result.details.organizationId !== orgId) throw new Error("Workspace details are no longer available in this account.");
  return result;
}

/** Deliberate support fields only. No tokens, credentials, clone URLs or raw workspace serialization. */
export function workspaceInfo({ workspace: w, details: d }: CloudWorkspaceDetailsResponse): string {
  return [
    `Organisation ID: ${d.organizationId}`, `Workspace ID: ${d.workspaceId}`, `Provider: ${d.provider}`,
    `Machine ID: ${d.machineId ?? "Unavailable"}`, `Creator ID: ${d.createdBy}`,
    `Environment version: ${d.environmentVersion?.versionNumber ?? "Unavailable"}`,
    `Toolchain version: ${d.environmentVersion?.toolchainVersion ?? "Unavailable"}`,
    `Runtime SHA256: ${d.runtime?.sha256 ?? "Unavailable"}`,
    `Created: ${new Date(w.createdAt).toISOString()}`,
  ].join("\n");
}

export function canRestartWorkspace(item: CloudWorkspaceListItem): boolean {
  const w = item.workspace;
  const status = getAccount().status;
  if (status.state !== "signed-in" || !status.organizations?.some((org) => org.id === w.orgId)) return false;
  const role = status.organizations?.find((org) => org.id === w.orgId)?.role;
  const preparationAllowed = !w.preparation || role === "owner" || role === "admin";
  return workspaceAuthority(w).lifecycle && !isArchived(w) && !w.deletedAt && preparationAllowed
    && !isOpen(item.latestOperation) && (w.state === "ready" || w.state === "attention-required");
}

const restarts = new Set<string>();
export class RestartOperationError extends Error {}

/** Queued is pending. Keep held leases, then replace their transport using connect only. */
export async function restartCloudWorkspace(item: CloudWorkspaceListItem): Promise<void> {
  if (!canRestartWorkspace(item)) throw new Error("Restart is unavailable for this workspace.");
  const scope = detailsScope();
  const w = item.workspace;
  const key = JSON.stringify([scope, w.orgId, w.id]);
  if (restarts.has(key)) throw new Error("A restart is already pending.");
  restarts.add(key);
  const current = () => { if (detailsScope() !== scope) throw new Error("The account changed. Check the workspace in the current account."); };
  try {
    const { api, project } = requireContracts();
    const requestedAt = Date.now();
    let snapshot = await api.cloudWorkspaceRestart(w.id, w.orgId);
    current();
    const validate = (response: RestartSnapshot, operationId?: string) => {
      if (response.workspace.id !== w.id || response.workspace.orgId !== w.orgId
        || response.operation.workspaceId !== w.id || response.operation.action !== "restart"
        || response.operation.type !== "create" || (operationId && response.operation.id !== operationId)) {
        throw new Error("The restart response does not match this workspace. Check the workspace again.");
      }
    };
    validate(snapshot);
    applyCloudSnapshot(project(snapshot), requestedAt);
    const operationId = snapshot.operation.id;
    let pollDelay = 1500;
    while (["queued", "running", "cancel-requested"].includes(snapshot.operation.state)) {
      // An observation failure is not an operation failure. Retain ownership
      // until a matching terminal snapshot arrives (or the account changes),
      // even beyond five minutes, so eventual success still reattaches leases.
      await new Promise((resolve) => setTimeout(resolve, pollDelay));
      current();
      const polledAt = Date.now();
      try {
        const observed = await api.cloudWorkspaceOperationDto(operationId, w.orgId);
        current();
        validate(observed, operationId);
        snapshot = observed;
        pollDelay = 1500;
      } catch (error) {
        current();
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (["invalid_access_token", "active_organization_required", "cloud_workspace_not_found",
          "cloud_workspace_manager_required", "organization_admin_required", "account_context_changed",
          "account_context_changed_after_send"].includes(code)) {
          throw new Error(lifecycleErrorMessage(code));
        }
        // Retry this operation, never POST another restart. Invalid/mismatched
        // responses cannot settle it either. Bound traffic during outages.
        pollDelay = Math.min(pollDelay * 2, 30_000);
        continue;
      }
      applyCloudSnapshot(project(snapshot), polledAt);
    }
    if (snapshot.operation.state !== "succeeded") throw new RestartOperationError(lifecycleErrorMessage(snapshot.operation.errorCode ?? "cloud_workspace_unknown_error"));
    reconnectCloudWorkspace({ orgId: w.orgId, workspaceId: w.id });
  } finally {
    restarts.delete(key);
    if (scope === detailsScope()) void refreshCloudCatalog(w.orgId);
  }
}
