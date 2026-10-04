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
 * Whether this account may start a cloud session in an organization, which
 * is what creates a workspace: null while its role there is not known yet
 * (so nothing is offered that may turn out refused).
 *
 * Any member may (PRO-73): they create workspaces and manage the ones they
 * created, within the organization's limits. Against a server from before
 * that rule (it does not report `memberWorkspaces`) only an owner or admin
 * may, as that server enforces. Which existing workspace a new session may
 * be added to is a separate question, answered per workspace
 * (`workspaceAuthority`).
 */
export function mayStartCloudSessions(status: AccountStatus, orgId: string | null | undefined): boolean | null {
  if (!orgId || status.state !== "signed-in") return null;
  const role = status.organizations?.find((org) => org.id === orgId)?.role;
  if (!role) return null;
  return role === "owner" || role === "admin" || status.memberWorkspaces === true;
}

/** The organization of a cloud project, workspace or session key (`cloud:<orgId>:…`); null for anything else. */
export function cloudKeyOrgId(key: string | null | undefined): string | null {
  if (!key?.startsWith("cloud:")) return null;
  return key.slice("cloud:".length).split(":")[0] || null;
}
