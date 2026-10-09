import { sessionColumn } from "@/lib/dashboard";
import type { CloudDashboardSession } from "@/lib/cloudDashboard";

/** Needs you spans every organization. Browsing Working and Done follows the sidebar; search spans all. */
export function visibleDashboardSessions(sessions: readonly CloudDashboardSession[], visibleIds: ReadonlySet<string>, query = ""): CloudDashboardSession[] {
  return sessions.filter((session) => query.trim() || visibleIds.has(session.orgId) || sessionColumn(session) === "needs");
}

/** Empty-query palette recents follow the sidebar; typing can find any organization's sessions. */
export function visiblePaletteSessions(sessions: readonly CloudDashboardSession[], visibleIds: ReadonlySet<string>, query = ""): CloudDashboardSession[] {
  return sessions.filter((session) => query.trim() || visibleIds.has(session.orgId));
}
