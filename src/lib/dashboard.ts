import type { SessionEntry } from "@/types/session";

/**
 * How the agent dashboard divides sessions.
 *
 * The three columns answer one question each: what wants me, what is running,
 * what is finished. A session lands in exactly one, decided by its tabs — a
 * session with any waiting tab needs the reader whatever else is going on, and
 * only then does a running tab count. Everything else is done, newest first.
 *
 * These are pure so the view can stay about layout and so the rules are
 * testable without a webview.
 */

export type ColumnId = "needs" | "working" | "done";

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
];

/** How many done cards are drawn before the column offers "show more". */
export const DONE_PAGE = 50;

export interface DashboardFilters {
  /** Project paths; empty means every project. */
  projects: string[];
  /** Harness ids; empty means every agent. */
  harnesses: string[];
  /** Columns; empty means all three. */
  columns: ColumnId[];
}

export const NO_FILTERS: DashboardFilters = { projects: [], harnesses: [], columns: [] };

export function hasFilters(f: DashboardFilters): boolean {
  return f.projects.length > 0 || f.harnesses.length > 0 || f.columns.length > 0;
}

/** Toggle one value of a filter list, keeping the array stable to compare. */
export function toggleFilter<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function sessionColumn(s: SessionEntry): ColumnId {
  if (s.tabs.some((t) => t.status === "waiting")) return "needs";
  if (s.tabs.some((t) => t.status === "in_progress")) return "working";
  return "done";
}

/** Finished and not yet read: the green count beside the rail entry. */
export function isUnread(s: SessionEntry): boolean {
  return sessionColumn(s) === "done" && s.tabs.some((t) => t.status === "completed");
}

/** The checkout a session runs in, as a reader would name it. */
export function workspaceName(s: SessionEntry): string {
  return s.worktreeName ?? s.branch ?? s.cwd.replace(/\/+$/, "").split("/").pop() ?? s.cwd;
}

/** Search covers what the card shows: its title, its checkout, its project. */
export function matchesQuery(s: SessionEntry, projectName: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [s.title, workspaceName(s), s.branch ?? "", projectName, s.issue?.identifier ?? ""].join(" ").toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

export function matchesFilters(s: SessionEntry, f: DashboardFilters): boolean {
  if (f.projects.length && !f.projects.includes(s.projectPath)) return false;
  if (f.harnesses.length && !s.tabs.some((t) => f.harnesses.includes(t.harness))) return false;
  if (f.columns.length && !f.columns.includes(sessionColumn(s))) return false;
  return true;
}

export interface BucketOptions {
  query: string;
  filters: DashboardFilters;
  projectName: (path: string) => string;
}

export type Buckets = Record<ColumnId, SessionEntry[]>;

/** Archived sessions never appear; the dashboard is about live work. */
export function bucketSessions(sessions: SessionEntry[], opts: BucketOptions): Buckets {
  const out: Buckets = { needs: [], working: [], done: [] };
  for (const s of sessions) {
    if (s.archived) continue;
    if (!matchesFilters(s, opts.filters)) continue;
    if (!matchesQuery(s, opts.projectName(s.projectPath), opts.query)) continue;
    out[sessionColumn(s)].push(s);
  }
  for (const id of Object.keys(out) as ColumnId[]) out[id].sort((a, b) => b.modified.localeCompare(a.modified));
  return out;
}
