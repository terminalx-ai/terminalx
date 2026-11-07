import { bucketSessions, type DashboardSession } from "./dashboard";
import { setSelectedAgent } from "./terminal";
import { compareMessageActivity, type MessageActivity } from "./messageActivity";
import { getAccount } from "./account";
import { attentionTab, isCloudDashboardSession, getCloudDashboard, openCloudSession } from "./cloudDashboard";
import { organizationVisibility } from "./organizationVisibility";
import { getPrefs } from "./prefs";
import { getSessionStore, selectSession } from "./sessions";
import { isCloudKey } from "@/types/target";

interface SessionDestination extends MessageActivity {
  id: string;
  archived?: boolean;
}

/** Pinned, then recent, as in the sidebar. Wrap in either direction; skip archives. */
export function adjacentSession(sessions: readonly SessionDestination[], current: string | null, direction: 1 | -1): string | null {
  const visible = sessions.filter((session) => !session.archived).sort((a, b) =>
    compareMessageActivity(a, b, a.id, b.id));
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

/** The Needs you column's order, wrapping once and excluding archives. */
export function nextAttentionSession<T extends DashboardSession>(sessions: T[], current: string | null): T | null {
  const waiting = bucketSessions(sessions).needs;
  if (!waiting.length) return null;
  return waiting[(waiting.findIndex((session) => session.id === current) + 1) % waiting.length];
}

export function stepAttentionSession() {
  const store = getSessionStore();
  const { visibleIds } = organizationVisibility(getAccount().status, getPrefs(), store.selectedSessionId);
  const next = nextAttentionSession<DashboardSession>([
    ...store.sessions,
    ...getCloudDashboard().filter((session) => visibleIds.has(session.orgId)),
  ], store.selectedSessionId);
  if (!next) return;
  if (isCloudDashboardSession(next)) openCloudSession(next.key, attentionTab(next)?.tabId);
  else {
    selectSession(next.id);
    const session = store.sessions.find((entry) => entry.id === next.id);
    const tab = session?.tabs.find((entry) => entry.status === "waiting");
    if (tab) setSelectedAgent(next.id, tab.id);
  }
}
