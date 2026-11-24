import type { CloudOrganization, CloudWorkspaceItem } from "./api";
import type { CatalogOrganization } from "./catalog";

/** An organization's section in the Cloud list. */
export interface CloudSection {
  key: string;
  title: string;
  /** Why its list could not be read just now (a code). */
  error: string | null;
  data: CloudWorkspaceItem[];
}

/**
 * The Cloud list's order (#988): organizations that have workspaces first, in
 * the order the account lists them, then those whose list could not be read
 * (they may have some). Organizations with no workspaces take no section: they
 * fold into one row at the end, `empty`.
 */
export function cloudSections(organizations: readonly CatalogOrganization[]): { sections: CloudSection[]; empty: CloudOrganization[] } {
  const section = (entry: CatalogOrganization): CloudSection => ({ key: entry.organization.orgId, title: entry.organization.name, error: entry.error, data: entry.workspaces });
  const withWorkspaces = organizations.filter((entry) => entry.workspaces.length > 0);
  const unread = organizations.filter((entry) => entry.workspaces.length === 0 && entry.error);
  const empty = organizations.filter((entry) => entry.workspaces.length === 0 && !entry.error).map((entry) => entry.organization);
  return { sections: [...withWorkspaces, ...unread].map(section), empty };
}

/** The folded row's words: "5 organizations with no workspaces". */
export function emptyOrganizationsLabel(count: number): string {
  return `${count} ${count === 1 ? "organization" : "organizations"} with no workspaces`;
}

/**
 * The organizations whose setup the Cloud tab reads (25.01): those with no
 * workspaces whose list was read. One whose list could not be read may have
 * workspaces, so it is not taken for one being set up.
 */
export function setupCandidates(organizations: readonly CatalogOrganization[]): CloudOrganization[] {
  return organizations.filter((entry) => entry.workspaces.length === 0 && !entry.error).map((entry) => entry.organization);
}
