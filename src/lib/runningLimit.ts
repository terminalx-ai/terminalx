import type { CloudWorkspaceListItem } from "@/lib/api";
import { getCloudCatalog, type CloudCatalogState } from "@/lib/cloudCatalog";

/**
 * The organization's running-workspace limit (saas PRO-76). A server refuses
 * a create or resume at the limit with this code; it is a definite answer,
 * never "outcome unknown", and stopping a workspace frees a slot.
 */
export const RUNNING_LIMIT_CODE = "cloud_workspace_concurrency_exceeded";

interface LimitUsage {
  used: number;
  limit: number;
}

/** The list's quota; since PRO-76 it also carries `running` and `total`, and `used`/`limit` mirror `running`. */
type ListQuota = LimitUsage & { running?: LimitUsage; total?: LimitUsage };

function quotaOf(orgId: string, catalog: CloudCatalogState): ListQuota | null {
  return (catalog.orgs[orgId]?.quota as ListQuota | null | undefined) ?? null;
}

/** Whether the last live list says the running limit is reached (only servers that report `running`). */
export function runningLimitReached(orgId: string, catalog: CloudCatalogState = getCloudCatalog()): boolean {
  const running = quotaOf(orgId, catalog)?.running;
  return Boolean(running && running.used >= running.limit);
}

/** The sentence for a refusal at the running limit, with the limit when the list reported it. */
export function runningLimitMessage(orgId: string | null, catalog: CloudCatalogState = getCloudCatalog()): string {
  const quota = orgId ? quotaOf(orgId, catalog) : null;
  // The refusal is the fresher fact: the org is at its limit whatever the last list counted.
  const limit = quota?.running?.limit ?? quota?.limit ?? null;
  return limit
    ? `Your organization is running ${limit} of ${limit} cloud workspaces. Stop one to start another.`
    : "Your organization is running as many cloud workspaces as its limit allows. Stop one to start another.";
}

/**
 * What the organization header's quota chip says, from the last list: the
 * running slots (PRO-76: only running workspaces count), and the total
 * ceiling when the server reports one. Null on a server that sends no quota,
 * or one from before PRO-76 that does not count running workspaces apart.
 */
export function workspaceUsage(orgId: string, catalog: CloudCatalogState = getCloudCatalog()): { used: number; limit: number; atLimit: boolean; label: string; card: string } | null {
  // Only a server that counts running workspaces apart (PRO-76) says "running":
  // before it, `used`/`limit` counted every workspace, stopped ones included.
  const quota = quotaOf(orgId, catalog);
  if (!quota?.running) return null;
  const { used, limit } = quota.running;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const atLimit = used >= limit;
  const lines = [`${used} of ${limit} cloud workspaces running${atLimit ? ". Stop one to start another." : ""}`];
  if (quota.total) lines.push(`${quota.total.used} of ${quota.total.limit} workspaces in all, stopped ones included`);
  return { used, limit, atLimit, label: `${used} of ${limit} running`, card: lines.join("\n") };
}

const RUNNING_STATES = new Set(["ready", "provisioning", "attention-required"]);

/** The organization's workspaces that hold a running slot, from the catalog, for an offer to stop one. */
export function runningWorkspaces(orgId: string, catalog: CloudCatalogState = getCloudCatalog(), exceptId?: string): CloudWorkspaceListItem[] {
  return (catalog.orgs[orgId]?.workspaces ?? []).filter(
    (item) => item.workspace.id !== exceptId && !item.workspace.archivedAt && RUNNING_STATES.has(item.workspace.state),
  );
}
