import { MANUAL_STATUSES, normalizeManualStatus, type ManualStatus } from "@terminalx/portable/manualStatus";
import { compareMessageActivity } from "@/lib/messageActivity";
import type { Project, SessionEntry, Workspace } from "@/types/session";

export type SidebarSort = "updated" | "created" | "custom";
export const canonicalProject = (path: string) => path === "/" ? path : path.replace(/\/+$/, "");

const holds = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * The listed project a quick chat was pointed into, its folder or one of its
 * worktrees, with the branch checked out there; a chat is linked to the
 * repository its agent works in the same way, and the folder never becomes a
 * project. In its scratch folder, or pointed anywhere else, it is in none
 * (#1464). The deepest folder that holds it wins, so a worktree kept inside
 * its project's folder names its own branch.
 */
export function quickChatProject(
  session: Pick<SessionEntry, "kind" | "projectPath" | "cwd">,
  projects: readonly Project[],
  chatsPath: string | null,
  workspaces: Readonly<Record<string, Workspace[]>>,
): { project: Project; branch: string | null } | null {
  const cwd = canonicalProject(session.cwd);
  if (session.kind !== "quick" || cwd === canonicalProject(session.projectPath)) return null;
  const chats = chatsPath && canonicalProject(chatsPath);
  let best: { depth: number; project: Project; branch: string | null } | null = null;
  for (const project of projects) {
    const root = canonicalProject(project.path);
    if (project.archived || root === chats) continue;
    const checkouts = workspaces[project.path] ?? workspaces[root] ?? [];
    const places = [{ path: root, branch: checkouts.find((checkout) => checkout.isMain)?.branch ?? null }, ...checkouts.map((checkout) => ({ path: canonicalProject(checkout.path), branch: checkout.branch }))];
    for (const place of places) {
      if (!place.path || !holds(place.path, cwd) || (best && best.depth >= place.path.length)) continue;
      best = { depth: place.path.length, project, branch: place.branch };
    }
  }
  return best && { project: best.project, branch: best.branch };
}

/**
 * Chats follow the project they are linked to, as in the project sidebar. A
 * quick chat is in the listed project it was pointed into (`quickChatProject`),
 * when the projects are given, else in the one it is linked to.
 */
export function sidebarProjectOf(
  session: Pick<SessionEntry, "kind" | "projectPath" | "link"> & Partial<Pick<SessionEntry, "cwd">>,
  chatsPath: string | null,
  listed?: { projects: readonly Project[]; workspaces: Readonly<Record<string, Workspace[]>> },
): string | null {
  if (session.kind === "quick" && listed && session.cwd != null) {
    const inside = quickChatProject({ kind: session.kind, projectPath: session.projectPath, cwd: session.cwd }, listed.projects, chatsPath, listed.workspaces);
    if (inside) return canonicalProject(inside.project.path);
  }
  if (session.kind === "quick" || canonicalProject(session.projectPath) === (chatsPath && canonicalProject(chatsPath))) {
    return session.link ? canonicalProject(session.link.path) : null;
  }
  return canonicalProject(session.projectPath);
}

/** Preserve the sidebar's message chronology for Updated; both orders keep pins first. */
/** What the sidebar orders by: a local session, or any row with the same fields (a machine session, PRO-346). */
export type SidebarOrderable = Pick<SessionEntry, "id" | "pinned" | "created" | "lastMessageAt" | "hasMessages">;

export function compareSidebarSessions(a: SidebarOrderable, b: SidebarOrderable, sort: SidebarSort): number {
  if (sort !== "created") return compareMessageActivity(a, b, a.id, b.id);
  return Number(b.pinned) - Number(a.pinned)
    || (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0)
    || a.id.localeCompare(b.id);
}

/** Input is already filtered and sorted; buckets retain that order and omit empty statuses. */
export function groupSessionsByStatus<T extends { manualStatus?: unknown }>(sessions: readonly T[]): { status: ManualStatus; sessions: T[] }[] {
  return MANUAL_STATUSES.map((status) => ({ status, sessions: sessions.filter((session) => normalizeManualStatus(session.manualStatus) === status) }))
    .filter((group) => group.sessions.length > 0);
}
