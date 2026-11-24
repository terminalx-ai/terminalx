import { privacyEnabled, useDataPrivacy } from "@/lib/dataPrivacy";
import { useEffect, useMemo } from "react";
import { confirmInApp } from "@/lib/confirm";
import { getAccount, useAccount } from "@/lib/account";
import type { AccountStatus, OrganizationSummary } from "@/lib/api";
import { cloudOrganizations, defaultOrgId, getCloudCatalog, liveCloudOrgIds, type CloudCatalogState } from "@/lib/cloudCatalog";
import { getPrefs, setPrefs, usePrefs, type Prefs } from "@/lib/prefs";
import { runningWorkspaces, workspaceUsage } from "@/lib/runningLimit";
import { getSessionStore, selectSession, useSessionStore } from "@/lib/sessions";
import { organizationSwitchingEnabled, useOrganizationSwitchingEnabled } from "@/lib/organizationVisibilityGate";
import { parseCloudWorkspaceKey } from "@/types/target";

type VisibilityPrefs = Pick<Prefs, "hiddenOrganizations" | "organizationDisplay" | "selectedOrganization">;

export function organizationName(org: OrganizationSummary): string {
  return org.isPersonal ? "Personal" : org.name;
}

// Stored in the existing One organization preference. This value cannot be a membership ID.
export const ONLY_THIS_MAC = "@only-this-mac";

function orderedOrganizations(orgs: OrganizationSummary[], defaultOrg: string | null) {
  return [...orgs].sort((a, b) => Number(b.id === defaultOrg) - Number(a.id === defaultOrg)
    || organizationName(a).localeCompare(organizationName(b)));
}

export function organizationSwitchTargets(status: AccountStatus) {
  if (privacyEnabled() || status.state !== "signed-in") return [];
  return [...orderedOrganizations(status.organizations ?? [], defaultOrgId(status)).map((org) => ({ id: org.id, org })),
    { id: ONLY_THIS_MAC, org: null }];
}

export function switchOrganization(id: string): boolean {
  if (!organizationSwitchingEnabled() || !organizationSwitchTargets(getAccount().status).some((target) => target.id === id)) return false;
  setPrefs({ organizationDisplay: "one", selectedOrganization: id });
  const selected = parseCloudWorkspaceKey(getSessionStore().selectedSessionId ?? "");
  // Match the sidebar's One organization picker when leaving a cloud session.
  if (id !== ONLY_THIS_MAC && selected && selected.orgId !== id) selectSession(null);
  return true;
}

/** The sole visibility rule. All organizations remain in the catalog for attention and explicit lookup. */
export function organizationVisibility(status: AccountStatus, prefs: VisibilityPrefs, selectedKey: string | null = null, switchingEnabled = organizationSwitchingEnabled()) {
  const defaultOrg = defaultOrgId(status);
  const all = orderedOrganizations(cloudOrganizations(status), defaultOrg);
  const choices = switchingEnabled && status.state === "signed-in" && !privacyEnabled()
    ? orderedOrganizations(status.organizations ?? [], defaultOrg) : all;
  const onlyThisMac = switchingEnabled && prefs.organizationDisplay === "one" && prefs.selectedOrganization === ONLY_THIS_MAC;
  const selectedOrganization = onlyThisMac ? ONLY_THIS_MAC : choices.find((org) => org.id === prefs.selectedOrganization)?.id ?? all.find((org) => org.id === defaultOrg)?.id ?? all[0]?.id ?? null;
  const hiddenIds = new Set(prefs.hiddenOrganizations);
  const normallyVisible = all.filter((org) => prefs.organizationDisplay === "one" ? org.id === selectedOrganization : !hiddenIds.has(org.id));
  const visibleIds = new Set(normallyVisible.map((org) => org.id));
  const selectedOrg = selectedKey ? parseCloudWorkspaceKey(selectedKey)?.orgId : null;
  const temporaryOrganization = !onlyThisMac && selectedOrg && !visibleIds.has(selectedOrg) && all.some((org) => org.id === selectedOrg) ? selectedOrg : null;
  const orgs = all.filter((org) => visibleIds.has(org.id) || org.id === temporaryOrganization);
  const selectedMembership = prefs.organizationDisplay === "one"
    ? choices.find((org) => org.id === selectedOrganization && org.cloud?.enabled !== true) : undefined;
  if (selectedMembership) orgs.push(selectedMembership);
  return { all, orgs, choices, hidden: all.filter((org) => !visibleIds.has(org.id)), visibleIds: new Set(orgs.map((org) => org.id)), defaultOrg, selectedOrganization, temporaryOrganization, live: new Set(liveCloudOrgIds(status)) };
}

/** Prune only an authoritative signed-in membership list, never a sign-out or a failed account load. */
export function reconcileOrganizationPrefs(status: AccountStatus, switchingEnabled = organizationSwitchingEnabled()) {
  if (privacyEnabled() || status.state !== "signed-in" || !status.organizations) return;
  const prefs = getPrefs();
  const ids = new Set(status.organizations.map((org) => org.id));
  const hiddenOrganizations = prefs.hiddenOrganizations.filter((id) => ids.has(id));
  const selectedOrganization = organizationVisibility(status, prefs, null, switchingEnabled).selectedOrganization;
  const patch: Partial<Prefs> = {};
  if (hiddenOrganizations.length !== prefs.hiddenOrganizations.length) patch.hiddenOrganizations = hiddenOrganizations;
  // Keep the saved local choice if this build starts with the capability off.
  if (prefs.selectedOrganization !== ONLY_THIS_MAC && prefs.selectedOrganization !== selectedOrganization
    && (prefs.selectedOrganization ? !ids.has(prefs.selectedOrganization) : prefs.organizationDisplay === "one")) {
    patch.selectedOrganization = selectedOrganization;
  }
  if (Object.keys(patch).length) setPrefs(patch);
}

export function useOrganizationVisibility() {
  const privacy = useDataPrivacy();
  const switchingEnabled = useOrganizationSwitchingEnabled();
  const { status } = useAccount();
  const prefs = usePrefs();
  const { selectedSessionId } = useSessionStore();
  useEffect(() => reconcileOrganizationPrefs(status, switchingEnabled), [status, prefs.hiddenOrganizations, prefs.organizationDisplay, prefs.selectedOrganization, switchingEnabled]);
  return useMemo(() => organizationVisibility(status, prefs, selectedSessionId, switchingEnabled), [status, prefs.hiddenOrganizations, prefs.organizationDisplay, prefs.selectedOrganization, selectedSessionId, privacy.enabled, switchingEnabled]);
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
    const confirmed = await confirmInApp({
      title: `Hide ${organizationName(org)}?`,
      body: `It has ${running} running workspace${running === 1 ? "" : "s"}. ${running === 1 ? "It keeps" : "They keep"} running and costing money while this organization is hidden from the sidebar on this desktop.`,
      action: "Hide organization",
    });
    if (!confirmed) return false;
  }
  if (getPrefs().organizationDisplay === "one" || !cloudOrganizations(getAccount().status).some((entry) => entry.id === orgId)) return false;
  const ids = new Set(getPrefs().hiddenOrganizations);
  if (hidden) ids.add(orgId);
  else ids.delete(orgId);
  setPrefs({ hiddenOrganizations: [...ids] });
  return true;
}
