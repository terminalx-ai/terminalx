import { MANUAL_STATUSES, type ManualStatus } from "@terminalx/portable/manualStatus";
import { compareMessageActivity } from "@/lib/messageActivity";
import type { SessionEntry } from "@/types/session";

export type SidebarSort = "updated" | "created";
export const canonicalProject = (path: string) => path === "/" ? path : path.replace(/\/+$/, "");

/** Chats follow the project they are linked to, as in the project sidebar. */
export function sidebarProjectOf(session: Pick<SessionEntry, "kind" | "projectPath" | "link">, chatsPath: string | null): string | null {
  if (session.kind === "quick" || canonicalProject(session.projectPath) === (chatsPath && canonicalProject(chatsPath))) {
    return session.link ? canonicalProject(session.link.path) : null;
  }
  return canonicalProject(session.projectPath);
}

/** Preserve the sidebar's message chronology for Updated; both orders keep pins first. */
export function compareSidebarSessions(a: SessionEntry, b: SessionEntry, sort: SidebarSort): number {
  if (sort === "updated") return compareMessageActivity(a, b, a.id, b.id);
  return Number(b.pinned) - Number(a.pinned)
    || (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0)
    || a.id.localeCompare(b.id);
}

/** Input is already filtered and sorted; buckets retain that order and omit empty statuses. */
export function groupSessionsByStatus<T extends { manualStatus?: ManualStatus }>(sessions: readonly T[]): { status: ManualStatus; sessions: T[] }[] {
  return MANUAL_STATUSES.map((status) => ({ status, sessions: sessions.filter((session) => (session.manualStatus ?? "backlog") === status) }))
    .filter((group) => group.sessions.length > 0);
}
