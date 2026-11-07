import { api, type CloudWorkspaceListItem } from "@/lib/api";
import { getAccount } from "@/lib/account";
import { applyCloudSnapshot, cloudOrgArg } from "@/lib/cloudCatalog";
import { cloudConnectionInfo } from "@/lib/cloudConnections";
import { noteWorkspaceAction } from "@/lib/notify";
import { cloudWorkspaceKey } from "@/types/target";

/** Deliberate support fields only; never serialize a workspace or connection. */
export function workspaceInfo(item: CloudWorkspaceListItem): string {
  const w = item.workspace;
  const org = getAccount().status.organizations?.find((entry) => entry.id === w.orgId);
  const version = cloudConnectionInfo(cloudWorkspaceKey(w.orgId, w.id)).runtimeVersion;
  return [
    `Organisation: ${org?.name ?? w.orgId}`,
    `Organisation ID: ${w.orgId}`,
    `Workspace ID: ${w.id}`,
    `Workspace number: ${w.number ?? "Unavailable"}`,
    `Provider: ${w.provider}`,
    `Machine ID: ${w.details?.machineId ?? "Unavailable"}`,
    `Runtime version: ${version ?? "Unavailable"}`,
    `Environment version: ${w.details?.environmentVersion ?? w.details?.environmentVersionId ?? "None"}`,
  ].join("\n");
}

/** Keep held connections alive: their supervisors reattach to the new generation. */
export async function restartCloudWorkspace(item: CloudWorkspaceListItem): Promise<void> {
  const w = item.workspace;
  const requestedAt = Date.now();
  let snapshot = await api.cloudWorkspaceRestart(w.id, cloudOrgArg(w.orgId));
  applyCloudSnapshot(snapshot, requestedAt);
  const operationId = snapshot.operation.id;
  const deadline = Date.now() + 5 * 60_000;
  while (snapshot.operation.state === "queued" || snapshot.operation.state === "running") {
    if (Date.now() >= deadline) throw new Error("The restart is still running. Check the provisioning log.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const polledAt = Date.now();
    snapshot = await api.cloudWorkspaceOperation(operationId, cloudOrgArg(w.orgId));
    applyCloudSnapshot(snapshot, polledAt);
  }
  if (snapshot.operation.state !== "succeeded") throw { code: snapshot.operation.errorCode ?? "cloud_workspace_unavailable" };
  noteWorkspaceAction(cloudWorkspaceKey(w.orgId, w.id), "Restarted workspace", w.name);
}
