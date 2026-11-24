import { useEffect, useState } from "react";
import { normalizeRepositoryIdentity } from "@terminalx/portable/repositoryIdentity";
import { useAccount } from "@/lib/account";
import { issues } from "@/lib/api";
import { defaultOrgId, liveCloudOrgIds, useCloudCatalog } from "@/lib/cloudCatalog";
import { connectedCloudClient, useCloudConnectionsVersion } from "@/lib/cloudConnections";
import { isArchived, machineRunning } from "@/lib/cloudLifecycle";
import { workspaceRestarting } from "@/lib/cloudWorkspaceDetails";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { canReadEnvironment } from "@/lib/environmentInfo";
import { managesOrganization } from "@/lib/multiOrg";
import { cloudWorkspaceKey } from "@/types/target";

export const ENVIRONMENT_INFO_FEATURE = "cloud.environment-info.v1";

type Placement =
  | { organizationId: string | null; provider: string; contextRevision: string }
  | { projectPath: string };

export function useEnvironmentInfoRuntime(placement: Placement) {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const catalog = useCloudCatalog();
  useCloudConnectionsVersion();
  const orgId = defaultOrgId(status);
  const context = status.context;
  const path = "projectPath" in placement ? placement.projectPath : null;
  const features = orgId ? status.phase2Readiness?.[orgId] : undefined;
  const enabled = !!(privacy.ready && !privacy.enabled && status.state === "signed-in" && context?.revision && orgId
    && liveCloudOrgIds(status).includes(orgId)
    && Array.isArray(features) && features.includes(ENVIRONMENT_INFO_FEATURE)
    && ("projectPath" in placement || (placement.organizationId === orgId && placement.contextRevision === context.revision
      && managesOrganization(status, orgId) === true)));
  const scopeKey = JSON.stringify([context?.account, context?.scope, context?.revision, orgId, placement]);
  const [repository, setRepository] = useState<{ scopeKey: string; identity: string | null } | null>(null);

  useEffect(() => {
    setRepository(null);
    if (!enabled || !path) return;
    let active = true;
    void Promise.resolve().then(() => active ? issues.githubRepo(path) : null).then((name) => {
      if (active) setRepository({ scopeKey, identity: name ? normalizeRepositoryIdentity(`github.com/${name}`) : null });
    }, () => {});
    return () => { active = false; };
  }, [enabled, path, scopeKey]);

  const org = orgId ? catalog.orgs[orgId] : null;
  const identity = repository?.scopeKey === scopeKey ? repository.identity : null;
  if (!enabled || !orgId || catalog.owner !== status.identity?.email || catalog.revision !== context?.revision
    || org?.source !== "live" || org.error || (path && !identity)) return { enabled, scopeKey, target: null };

  // Prefer a stable order so catalog activity alone cannot switch an open report.
  for (const item of [...org.workspaces].sort((a, b) => a.workspace.id.localeCompare(b.workspace.id))) {
    const { workspace } = item;
    if (workspace.orgId !== orgId || workspace.preparation || isArchived(workspace) || !machineRunning(item)
      || workspaceRestarting(item)
      || (workspace.authority != null && workspace.authority !== "manage")
      || (workspace.you && workspace.you.role !== "manager")) continue;

    if ("provider" in placement ? workspace.provider !== placement.provider : !workspace.repositories?.some((repo) =>
      !!repo.fullName && (normalizeRepositoryIdentity(repo.identity) ?? normalizeRepositoryIdentity(repo.cloneUrl)) === identity)) continue;

    const key = cloudWorkspaceKey(orgId, workspace.id);
    const client = connectedCloudClient(key);
    const state = client?.connection;
    if (!client || !state || state.state !== "connected" || !canReadEnvironment(state)
      || !state.capabilities.includes("environment/1")) continue;
    return { enabled, scopeKey: JSON.stringify([scopeKey, key]), target: { client, state, workspaceName: workspace.name } };
  }
  return { enabled, scopeKey, target: null };
}
