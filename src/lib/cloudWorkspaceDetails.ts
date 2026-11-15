import { useEffect, useState } from "react";
import { api, projectCloudWorkspaceSnapshot, type CloudWorkspaceDetailsResponse, type CloudWorkspaceListItem } from "@/lib/api";
import { getAccount, subscribeAccount } from "@/lib/account";
import { applyCloudSnapshot, refreshCloudCatalog } from "@/lib/cloudCatalog";
import { reconnectCloudWorkspace } from "@/lib/cloudConnections";
import { workspaceAuthority } from "@/lib/cloudCollab";
import { isArchived, isOpen, lifecycleErrorMessage } from "@/lib/cloudLifecycle";

/** Scope includes active profile: these APIs require the active organization. */
export function detailsScope(): string {
  const { status } = getAccount();
  return JSON.stringify([status.state, status.context, status.identity?.email, status.identity?.organizationId]);
}

export function useWorkspaceDetailsAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let generation = 0;
    const check = () => {
      const request = ++generation;
      setAvailable(false);
      // Optional only until the shared contracts worker is collected. No readiness inference.
      if (!("phase2DesktopContractsAvailable" in api)) return;
      void api.phase2DesktopContractsAvailable().then((ready) => {
        if (generation === request) setAvailable(ready === true);
      }).catch(() => {});
    };
    check();
    const stop = subscribeAccount(check);
    return () => { ++generation; stop(); };
  }, []);
  return available;
}

export async function loadWorkspaceDetails(item: CloudWorkspaceListItem): Promise<CloudWorkspaceDetailsResponse> {
  const scope = detailsScope();
  const { id, orgId } = item.workspace;
  const result = await api.cloudWorkspaceDetails(id, orgId);
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
  const role = getAccount().status.organizations?.find((org) => org.id === w.orgId)?.role;
  const preparationAllowed = !w.preparation || role === "owner" || role === "admin";
  return workspaceAuthority(w).lifecycle && !isArchived(w) && !w.deletedAt && preparationAllowed
    && !isOpen(item.latestOperation) && (w.state === "ready" || w.state === "attention-required");
}

const restarts = new Set<string>();
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
    const requestedAt = Date.now();
    let snapshot = await api.cloudWorkspaceRestart(w.id, w.orgId);
    current();
    applyCloudSnapshot(projectCloudWorkspaceSnapshot(snapshot), requestedAt);
    const operationId = snapshot.operation.id;
    const deadline = Date.now() + 5 * 60_000;
    while (snapshot.operation.state === "queued" || snapshot.operation.state === "running") {
      if (Date.now() >= deadline) throw new Error("The restart is still pending. Check the workspace again.");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      current();
      const polledAt = Date.now();
      snapshot = await api.cloudWorkspaceOperationDto(operationId, w.orgId);
      current();
      applyCloudSnapshot(projectCloudWorkspaceSnapshot(snapshot), polledAt);
    }
    if (snapshot.operation.state !== "succeeded") throw new Error(lifecycleErrorMessage(snapshot.operation.errorCode ?? "cloud_workspace_unknown_error"));
    reconnectCloudWorkspace({ orgId: w.orgId, workspaceId: w.id });
  } finally {
    restarts.delete(key);
    if (scope === detailsScope()) void refreshCloudCatalog(w.orgId);
  }
}
