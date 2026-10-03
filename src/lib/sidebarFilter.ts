import { useMemo } from "react";
import { isUnread, sessionColumn, type DashboardSession } from "@/lib/dashboard";
import { useCloudDashboard } from "@/lib/cloudDashboard";
import { useSessionStore } from "@/lib/sessions";

/**
 * The sidebar's session filter (PRO-23): everything, only sessions with an
 * answer nobody has read yet, or only sessions waiting for a person. It
 * covers local and cloud sessions alike and uses the Agent Dashboard's own
 * rules (`sessionColumn`, `isUnread`), so the sidebar, the dashboard's
 * columns and the totals beside "Agent Dashboard" never disagree.
 *
 * Cloud sessions are read from the same projection as the dashboard: the
 * catalog and this desktop's caches. Filtering never attaches to, resumes or
 * wakes a workspace.
 */
export type SidebarFilter = "all" | "unread" | "needs";

export const SIDEBAR_FILTERS: { id: SidebarFilter; label: string; empty: string }[] = [
  { id: "all", label: "All sessions", empty: "" },
  { id: "unread", label: "Unread", empty: "No unread sessions." },
  { id: "needs", label: "Needs you", empty: "Nothing needs you." },
];

/** Whether a session passes the filter. Archived sessions never do: the archive has its own toggle. */
export function sessionPassesFilter(filter: SidebarFilter, session: DashboardSession): boolean {
  if (filter === "all") return true;
  if (session.archived || !session.tabs.length) return false;
  return filter === "needs" ? sessionColumn(session) === "needs" : isUnread(session);
}

export interface SidebarFilterState {
  filter: SidebarFilter;
  /** Something other than "all" is chosen. */
  active: boolean;
  /** Whether a session (a local id or a cloud session key) is shown. The selected session always is, so reading it does not make it vanish. */
  shows: (sessionId: string) => boolean;
  /** Whether a project (a local path or a cloud project key) has a session to show. */
  showsProject: (projectKey: string) => boolean;
  /** How many sessions pass, the selected one aside. */
  count: number;
  empty: string;
}

const EVERYTHING: Omit<SidebarFilterState, "count"> = { filter: "all", active: false, shows: () => true, showsProject: () => true, empty: "" };

export function useSidebarFilter(): SidebarFilterState {
  const store = useSessionStore();
  const cloud = useCloudDashboard();
  const filter = store.sidebarFilter;
  const selected = store.selectedSessionId;
  return useMemo(() => {
    if (filter === "all") return { ...EVERYTHING, count: 0 };
    const sessions = new Set<string>();
    const projects = new Set<string>();
    let count = 0;
    for (const session of [...store.sessions, ...cloud] as DashboardSession[]) {
      const passes = sessionPassesFilter(filter, session);
      if (passes) count++;
      if (!passes && session.id !== selected) continue;
      sessions.add(session.id);
      projects.add(session.projectPath);
    }
    return {
      filter,
      active: true,
      shows: (sessionId) => sessions.has(sessionId),
      showsProject: (projectKey) => projects.has(projectKey),
      count,
      empty: SIDEBAR_FILTERS.find((entry) => entry.id === filter)?.empty ?? "",
    };
  }, [filter, selected, store.sessions, cloud]);
}
