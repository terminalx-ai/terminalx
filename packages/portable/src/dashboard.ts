export type DashboardTabStatus = "idle" | "in_progress" | "completed" | "waiting";

export interface DashboardTab {
  harness: string;
  status: DashboardTabStatus;
}

export interface DashboardSession {
  id: string;
  projectPath: string;
  cwd: string;
  worktreeName?: string | null;
  branch?: string | null;
  worktreeRemoved?: boolean;
  removedWorkspace?: { path: string; name: string; branch?: string | null } | null;
  issue?: { identifier: string } | null;
  title: string;
  modified: string;
  archived: boolean;
  tabs: DashboardTab[];
}

export type ColumnId = "needs" | "working" | "done";

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
];

export const DONE_PAGE = 50;

export interface DashboardFilters {
  projects: string[];
  harnesses: string[];
  columns: ColumnId[];
}

export const NO_FILTERS: DashboardFilters = { projects: [], harnesses: [], columns: [] };

export function hasFilters(filters: DashboardFilters): boolean {
  return filters.projects.length > 0 || filters.harnesses.length > 0 || filters.columns.length > 0;
}

export function toggleFilter<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function sessionColumn(session: DashboardSession): ColumnId {
  if (session.tabs.some((tab) => tab.status === "waiting")) return "needs";
  if (session.tabs.some((tab) => tab.status === "in_progress")) return "working";
  return "done";
}

export function isUnread(session: DashboardSession): boolean {
  return sessionColumn(session) === "done" && session.tabs.some((tab) => tab.status === "completed");
}

export function workspaceName(session: DashboardSession): string {
  if (session.worktreeRemoved) {
    return session.removedWorkspace?.name ?? session.removedWorkspace?.branch ?? "Removed workspace";
  }
  return session.worktreeName ?? session.branch ?? session.cwd.replace(/\/+$/, "").split("/").pop() ?? session.cwd;
}

export function matchesQuery(session: DashboardSession, projectName: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [
    session.title,
    workspaceName(session),
    session.branch ?? "",
    session.removedWorkspace?.branch ?? "",
    session.removedWorkspace?.path ?? "",
    projectName,
    session.issue?.identifier ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return normalized.split(/\s+/).every((word) => haystack.includes(word));
}

export function matchesFilters(session: DashboardSession, filters: DashboardFilters): boolean {
  if (filters.projects.length && !filters.projects.includes(session.projectPath)) return false;
  if (filters.harnesses.length && !session.tabs.some((tab) => filters.harnesses.includes(tab.harness))) return false;
  if (filters.columns.length && !filters.columns.includes(sessionColumn(session))) return false;
  return true;
}

export interface BucketOptions {
  query: string;
  filters: DashboardFilters;
  projectName: (path: string) => string;
}

export type Buckets<T extends DashboardSession = DashboardSession> = Record<ColumnId, T[]>;

/** Omit options for the global totals, independent of dashboard-local filters. */
export function bucketSessions<T extends DashboardSession>(sessions: T[], options?: BucketOptions): Buckets<T> {
  const buckets: Buckets<T> = { needs: [], working: [], done: [] };
  for (const session of sessions) {
    if (session.archived || !session.tabs.length) continue;
    if (options && !matchesFilters(session, options.filters)) continue;
    if (options && !matchesQuery(session, options.projectName(session.projectPath), options.query)) continue;
    buckets[sessionColumn(session)].push(session);
  }
  for (const id of Object.keys(buckets) as ColumnId[]) {
    buckets[id].sort((left, right) => right.modified.localeCompare(left.modified));
  }
  return buckets;
}
