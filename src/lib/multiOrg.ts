import type { AccountStatus } from "@/lib/api";

/**
 * Every organization live at once (PRO-23 CS-18). A server that advertises
 * `cloud.desktop.multi-org.v1` authorizes desktop cloud routes by membership
 * in the path organization, so the desktop lists, opens and works in every
 * member organization without switching its default one. Without it, only
 * the default (active) organization is live, exactly as before.
 */

/** Whether the server lets this desktop work in every member organization at once. */
export function isMultiOrg(status: AccountStatus): boolean {
  return status.state === "signed-in" && status.multiOrg === true;
}

/** The organizations whose cloud state this desktop keeps: every member one with the capability, else the default one. */
export function keptCloudOrgs(status: AccountStatus): Set<string> {
  if (status.state !== "signed-in" || !status.identity) return new Set();
  const kept = new Set<string>();
  if (isMultiOrg(status)) for (const org of status.organizations ?? []) kept.add(org.id);
  if (status.identity.organizationId) kept.add(status.identity.organizationId);
  return kept;
}
