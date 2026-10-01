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

/**
 * Whether this account may start a cloud session in an organization: true for
 * its owner or an admin, false for a member, null while the account's role
 * there is not known yet (so nothing is offered that may turn out refused).
 * Creating a workspace, resuming one from the sidebar and adding a session to
 * a running one are all the API's owner-or-admin actions.
 */
export function mayStartCloudSessions(status: AccountStatus, orgId: string | null | undefined): boolean | null {
  if (!orgId || status.state !== "signed-in") return null;
  const role = status.organizations?.find((org) => org.id === orgId)?.role;
  if (!role) return null;
  return role === "owner" || role === "admin";
}

/** The organization of a cloud project, workspace or session key (`cloud:<orgId>:…`); null for anything else. */
export function cloudKeyOrgId(key: string | null | undefined): string | null {
  if (!key?.startsWith("cloud:")) return null;
  return key.slice("cloud:".length).split(":")[0] || null;
}
