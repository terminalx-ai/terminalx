import { compareMessageActivity, type MessageActivity } from "./messageActivity";
import { getAccount } from "./account";
import { getCloudDashboard, openCloudSession } from "./cloudDashboard";
import { organizationVisibility } from "./organizationVisibility";
import { getPrefs } from "./prefs";
import { getSessionStore, selectSession } from "./sessions";
import { customSessionOrder, getSidebarOrder, type SidebarOrder } from "./sidebarOrder";
import { isCloudKey } from "@/types/target";

interface SessionDestination extends MessageActivity {
  id: string;
  archived?: boolean;
}

/** Follow the sidebar ordering preference. Wrap in either direction; skip archives. */
export function adjacentSession(sessions: readonly SessionDestination[], current: string | null, direction: 1 | -1, order: SidebarOrder = getSidebarOrder()): string | null {
  const active = sessions.filter((session) => !session.archived);
  const recent = (a: SessionDestination, b: SessionDestination) => compareMessageActivity(a, b, a.id, b.id);
  const visible = order.custom
    ? [...customSessionOrder(active.filter((s) => !isCloudKey(s.id)), order), ...active.filter((s) => isCloudKey(s.id)).sort(recent)]
    : active.sort(recent);
  if (!visible.length) return null;
  const index = visible.findIndex((session) => session.id === current);
  const next = index < 0 ? (direction === 1 ? 0 : visible.length - 1) : (index + direction + visible.length) % visible.length;
  return visible[next].id;
}

export function stepVisibleSession(direction: 1 | -1) {
  const store = getSessionStore();
  const hiddenProjects = new Set(store.projects.filter((project) => project.archived).map((project) => project.path));
  const { visibleIds } = organizationVisibility(getAccount().status, getPrefs(), store.selectedSessionId);
  const sessions = [
    ...store.sessions.filter((session) => !hiddenProjects.has(session.projectPath)),
    ...getCloudDashboard().filter((session) => visibleIds.has(session.orgId)),
  ];
  const next = adjacentSession(sessions, store.selectedSessionId, direction);
  if (next) {
    if (isCloudKey(next)) openCloudSession(next);
    else selectSession(next);
  }
}
