import type { CloudLimitUsage, CloudWorkspaceListItem, CloudWorkspaceQuota } from "@/lib/api";
import { getCloudCatalog, type CloudCatalogState } from "@/lib/cloudCatalog";

/**
 * The organization's running-workspace limit (saas PRO-76). A server refuses
 * a create or resume at the limit with this code; it is a definite answer,
 * never "outcome unknown", and stopping a workspace frees a slot.
 */
export const RUNNING_LIMIT_CODE = "cloud_workspace_concurrency_exceeded";

/** The limit a count is held to, or null where the organization has none (PRO-371: the key is absent, or null). */
export function limitOf(usage: CloudLimitUsage | null | undefined): number | null {
  const limit = usage?.limit;
  return typeof limit === "number" && Number.isFinite(limit) ? limit : null;
}

/** Whether a count has reached its limit; never where there is no limit. */
export function atLimit(usage: CloudLimitUsage | null | undefined): boolean {
  const limit = limitOf(usage);
  return limit !== null && usage!.used >= limit;
}

function quotaOf(orgId: string, catalog: CloudCatalogState): CloudWorkspaceQuota | null {
  return catalog.orgs[orgId]?.quota ?? null;
}

/** Whether the last live list says the running limit is reached (only servers that report `running`, and only where there is a limit). */
export function runningLimitReached(orgId: string, catalog: CloudCatalogState = getCloudCatalog()): boolean {
  return atLimit(quotaOf(orgId, catalog)?.running);
}

/** The sentence for a refusal at the running limit, with the limit when the list reported it. */
export function runningLimitMessage(orgId: string | null, catalog: CloudCatalogState = getCloudCatalog()): string {
  const quota = orgId ? quotaOf(orgId, catalog) : null;
  // The refusal is the fresher fact: the org is at its limit whatever the last list counted.
  const limit = limitOf(quota?.running) ?? limitOf(quota);
  return limit
    ? `Your organization is running ${limit} of ${limit} cloud workspaces. Stop one to start another.`
    : "Your organization is running as many cloud workspaces as its limit allows. Stop one to start another.";
}

/** "3 of 5 things" against a limit, "3 things" where there is none. */
const counted = (usage: CloudLimitUsage, things: string) => {
  const limit = limitOf(usage);
  return limit === null ? `${usage.used} ${things}` : `${usage.used} of ${limit} ${things}`;
};

/**
 * What the organization header's quota chip says, from the last list: the
 * running slots (PRO-76: only running workspaces count), and the total
 * ceiling when the server reports one. Null on a server that sends no quota,
 * or one from before PRO-76 that does not count running workspaces apart.
 *
 * Where the organization has no running limit (PRO-371), `limit` is null and
 * the chip only counts: nothing is "of" anything, and it is never at a limit.
 */
export function workspaceUsage(orgId: string, catalog: CloudCatalogState = getCloudCatalog()): { used: number; limit: number | null; atLimit: boolean; label: string; card: string } | null {
  // Only a server that counts running workspaces apart (PRO-76) says "running":
  // before it, `used`/`limit` counted every workspace, stopped ones included.
  const quota = quotaOf(orgId, catalog);
  if (!quota?.running) return null;
  const { used } = quota.running;
  if (!Number.isFinite(used)) return null;
  const limit = limitOf(quota.running);
  if (limit !== null && limit <= 0) return null;
  const reached = atLimit(quota.running);
  const lines = [`${counted(quota.running, "cloud workspaces running")}${reached ? ". Stop one to start another." : ""}`];
  if (quota.total && Number.isFinite(quota.total.used)) lines.push(`${counted(quota.total, "workspaces in all")}, stopped ones included`);
  return { used, limit, atLimit: reached, label: counted(quota.running, "running"), card: lines.join("\n") };
}

const RUNNING_STATES = new Set(["ready", "provisioning", "attention-required"]);

/** The organization's workspaces that hold a running slot, from the catalog, for an offer to stop one. */
export function runningWorkspaces(orgId: string, catalog: CloudCatalogState = getCloudCatalog(), exceptId?: string): CloudWorkspaceListItem[] {
  return (catalog.orgs[orgId]?.workspaces ?? []).filter(
    (item) => item.workspace.id !== exceptId && !item.workspace.archivedAt && RUNNING_STATES.has(item.workspace.state),
  );
}
