import { useMemo } from "react";
import { isUnread, sessionColumn, type DashboardSession } from "@/lib/dashboard";
import { getAccount, useAccount } from "@/lib/account";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import { blankIdentity, liveCloudOrgIds, repositoryOf, useCloudCatalog, type CloudCatalogState } from "@/lib/cloudCatalog";
import { useCloudDashboard } from "@/lib/cloudDashboard";
import { isArchived } from "@/lib/cloudLifecycle";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { useSessionStore } from "@/lib/sessions";
import { useOrganizationVisibility } from "@/lib/organizationVisibility";
import { cloudProjectKey, cloudWorkspaceKey } from "@/types/target";

/**
 * The sidebar's session filter (PRO-23): everything, only sessions with an
 * answer nobody has read yet, or only sessions waiting for a person. It
 * covers local and cloud sessions alike and uses the Agent Dashboard's own
 * rules (`sessionColumn`, `isUnread`). Filter counts cover visible sidebar
 * organizations; the dashboard's Needs you total deliberately includes hidden ones.
 *
 * Cloud sessions are read from the same projection as the dashboard: the
 * catalog and this desktop's caches. Filtering never attaches to, resumes or
 * wakes a workspace.
 *
 * The choice is kept per person (prefs), so it survives a relaunch and one
 * account's filter is never applied to another's sidebar.
 */
export type SidebarFilter = "all" | "unread" | "needs";

export const SIDEBAR_FILTERS: { id: SidebarFilter; label: string; empty: string }[] = [
  { id: "all", label: "All sessions", empty: "" },
  { id: "unread", label: "Unread", empty: "No unread sessions." },
  { id: "needs", label: "Needs you", empty: "Nothing needs you." },
];

/** Whose sidebar this is: the signed-in account, else this computer's own. */
function filterOwner(status: AccountStatus): string {
  return status.state === "signed-in" && status.identity?.email ? status.identity.email : "local";
}

export function getSidebarFilter(): SidebarFilter {
  return (getPrefs().sidebarFilters[filterOwner(getAccount().status)] as SidebarFilter | undefined) ?? "all";
}

export function setSidebarFilter(filter: SidebarFilter) {
  const owner = filterOwner(getAccount().status);
  const next = { ...getPrefs().sidebarFilters };
  if (filter === "all") delete next[owner];
  else next[owner] = filter;
  setPrefs({ sidebarFilters: next });
}

/** Whether a session passes the filter. Archived sessions never do: the archive has its own toggle. */
export function sessionPassesFilter(filter: SidebarFilter, session: DashboardSession): boolean {
  if (filter === "all") return true;
  if (session.archived || !session.tabs.length) return false;
  return filter === "needs" ? sessionColumn(session) === "needs" : isUnread(session);
}

/**
 * Whether the server's list alone says a workspace waits for a person: its
 * runtime is online and reports pending approvals. That is what gives the
 * row its Needs-you dot (`deriveCloudActivity`), also for a workspace this
 * desktop has never opened and so holds no session of.
 */
export function workspaceNeedsYou(item: CloudWorkspaceListItem): boolean {
  const runtime = item.workspace.runtimeActivity;
  return !!runtime?.online && runtime.pendingApprovals > 0 && item.workspace.state === "ready" && !isArchived(item.workspace) && item.workspace.you?.role !== "none";
}

/** The workspaces that pass "Needs you" on the list's word alone, with the project each is listed under. */
export function workspacesNeedingYou(catalog: CloudCatalogState, orgIds: readonly string[]): { workspaceKey: string; projectKey: string }[] {
  return orgIds.flatMap((orgId) =>
    (catalog.orgs[orgId]?.workspaces ?? []).filter(workspaceNeedsYou).map((item) => {
      const repository = repositoryOf(item, catalog.createMemory);
      return { workspaceKey: cloudWorkspaceKey(orgId, item.workspace.id), projectKey: cloudProjectKey(orgId, repository?.identity ?? blankIdentity(item.workspace.name)) };
    }),
  );
}

export interface SidebarFilterState {
  filter: SidebarFilter;
  /** Something other than "all" is chosen. */
  active: boolean;
  /** Whether a session (a local id or a cloud session key) is shown. The selected session always is, so reading it does not make it vanish. */
  shows: (sessionId: string) => boolean;
  /** Whether a project (a local path or a cloud project key) has something to show. */
  showsProject: (projectKey: string) => boolean;
  /** Whether a cloud workspace passes on the server's list alone (pending approvals), whatever sessions of it are known here. */
  showsWorkspace: (workspaceKey: string) => boolean;
  /** How many sessions pass, the selected one aside. */
  count: number;
  empty: string;
}

const EVERYTHING: Omit<SidebarFilterState, "count"> = { filter: "all", active: false, shows: () => true, showsProject: () => true, showsWorkspace: () => true, empty: "" };

export function useSidebarFilter(): SidebarFilterState {
  const store = useSessionStore();
  const cloud = useCloudDashboard();
  const catalog = useCloudCatalog();
  const { status } = useAccount();
  const filter: SidebarFilter = (usePrefs().sidebarFilters[filterOwner(status)] as SidebarFilter | undefined) ?? "all";
  const selected = store.selectedSessionId;
  const { visibleIds } = useOrganizationVisibility();
  return useMemo(() => {
    if (filter === "all") return { ...EVERYTHING, count: 0 };
    const sessions = new Set<string>();
    const projects = new Set<string>();
    const workspaces = new Set<string>();
    let count = 0;
    for (const session of [...store.sessions, ...cloud.filter((session) => visibleIds.has(session.orgId))] as DashboardSession[]) {
      const passes = sessionPassesFilter(filter, session);
      if (passes) count++;
      if (!passes && session.id !== selected) continue;
      sessions.add(session.id);
      projects.add(session.projectPath);
    }
    if (filter === "needs") {
      for (const { workspaceKey, projectKey } of workspacesNeedingYou(catalog, liveCloudOrgIds(status).filter((id) => visibleIds.has(id)))) {
        workspaces.add(workspaceKey);
        projects.add(projectKey);
      }
    }
    return {
      filter,
      active: true,
      shows: (sessionId) => sessions.has(sessionId),
      showsProject: (projectKey) => projects.has(projectKey),
      showsWorkspace: (workspaceKey) => workspaces.has(workspaceKey),
      count,
      empty: SIDEBAR_FILTERS.find((entry) => entry.id === filter)?.empty ?? "",
    };
  }, [filter, selected, store.sessions, cloud, catalog, status, visibleIds]);
}
