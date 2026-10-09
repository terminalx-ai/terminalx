import { useEffect, useMemo } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { getAccount, useAccount } from "@/lib/account";
import type { AccountStatus, OrganizationSummary } from "@/lib/api";
import { cloudOrganizations, defaultOrgId, getCloudCatalog, liveCloudOrgIds, type CloudCatalogState } from "@/lib/cloudCatalog";
import { getPrefs, setPrefs, usePrefs, type Prefs } from "@/lib/prefs";
import { runningWorkspaces, workspaceUsage } from "@/lib/runningLimit";
import { useSessionStore } from "@/lib/sessions";
import { parseCloudWorkspaceKey } from "@/types/target";

type VisibilityPrefs = Pick<Prefs, "hiddenOrganizations" | "organizationDisplay" | "selectedOrganization">;

export function organizationName(org: OrganizationSummary): string {
  return org.isPersonal ? "Personal" : org.name;
}

/** The sole visibility rule. All organizations remain in the catalog for attention and explicit lookup. */
export function organizationVisibility(status: AccountStatus, prefs: VisibilityPrefs, selectedKey: string | null = null) {
  const defaultOrg = defaultOrgId(status);
  const all = cloudOrganizations(status).sort((a, b) => Number(b.id === defaultOrg) - Number(a.id === defaultOrg) || organizationName(a).localeCompare(organizationName(b)));
  const selectedOrganization = all.find((org) => org.id === prefs.selectedOrganization)?.id ?? all.find((org) => org.id === defaultOrg)?.id ?? all[0]?.id ?? null;
  const hiddenIds = new Set(prefs.hiddenOrganizations);
  const normallyVisible = all.filter((org) => prefs.organizationDisplay === "one" ? org.id === selectedOrganization : !hiddenIds.has(org.id));
  const visibleIds = new Set(normallyVisible.map((org) => org.id));
  const selectedOrg = selectedKey ? parseCloudWorkspaceKey(selectedKey)?.orgId : null;
  const temporaryOrganization = selectedOrg && !visibleIds.has(selectedOrg) && all.some((org) => org.id === selectedOrg) ? selectedOrg : null;
  const orgs = all.filter((org) => visibleIds.has(org.id) || org.id === temporaryOrganization);
  return { all, orgs, hidden: all.filter((org) => !visibleIds.has(org.id)), visibleIds: new Set(orgs.map((org) => org.id)), defaultOrg, selectedOrganization, temporaryOrganization, live: new Set(liveCloudOrgIds(status)) };
}

/** Prune only an authoritative signed-in membership list, never a sign-out or a failed account load. */
export function reconcileOrganizationPrefs(status: AccountStatus) {
  if (status.state !== "signed-in" || !status.organizations) return;
  const prefs = getPrefs();
  const ids = new Set(status.organizations.map((org) => org.id));
  const hiddenOrganizations = prefs.hiddenOrganizations.filter((id) => ids.has(id));
  const selectedOrganization = organizationVisibility(status, prefs).selectedOrganization;
  const patch: Partial<Prefs> = {};
  if (hiddenOrganizations.length !== prefs.hiddenOrganizations.length) patch.hiddenOrganizations = hiddenOrganizations;
  if (prefs.selectedOrganization && !ids.has(prefs.selectedOrganization)) patch.selectedOrganization = selectedOrganization;
  if (prefs.organizationDisplay === "one" && prefs.selectedOrganization !== selectedOrganization) patch.selectedOrganization = selectedOrganization;
  if (Object.keys(patch).length) setPrefs(patch);
}

export function useOrganizationVisibility() {
  const { status } = useAccount();
  const prefs = usePrefs();
  const { selectedSessionId } = useSessionStore();
  useEffect(() => reconcileOrganizationPrefs(status), [status, prefs.hiddenOrganizations, prefs.organizationDisplay, prefs.selectedOrganization]);
  return useMemo(() => organizationVisibility(status, prefs, selectedSessionId), [status, prefs.hiddenOrganizations, prefs.organizationDisplay, prefs.selectedOrganization, selectedSessionId]);
}

/** Count running machines even when the member's workspace list is incomplete. Reading never connects. */
export function organizationRunningCount(orgId: string, catalog: CloudCatalogState = getCloudCatalog()): number {
  return Math.max(workspaceUsage(orgId, catalog)?.used ?? 0, runningWorkspaces(orgId, catalog).length);
}

/** Both Settings and the section menus use the same confirmation and update the latest preferences. */
export async function setOrganizationHidden(orgId: string, hidden: boolean): Promise<boolean> {
  const org = cloudOrganizations(getAccount().status).find((entry) => entry.id === orgId);
  if (!org || getPrefs().organizationDisplay === "one") return false;
  const running = hidden ? organizationRunningCount(orgId) : 0;
  if (running > 0) {
    const confirmed = await ask(`${organizationName(org)} has ${running} running workspace${running === 1 ? "" : "s"}. They will keep running and costing money while this organization is hidden. Hide it from the sidebar on this desktop?`, { title: "Hide organization", kind: "warning", okLabel: "Hide organization", cancelLabel: "Cancel" }).catch(() => false);
    if (!confirmed) return false;
  }
  if (getPrefs().organizationDisplay === "one" || !cloudOrganizations(getAccount().status).some((entry) => entry.id === orgId)) return false;
  const ids = new Set(getPrefs().hiddenOrganizations);
  if (hidden) ids.add(orgId);
  else ids.delete(orgId);
  setPrefs({ hiddenOrganizations: [...ids] });
  return true;
}
