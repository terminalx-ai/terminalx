export type DashboardTabStatus = "idle" | "in_progress" | "completed" | "waiting";

export interface DashboardTab {
  harness: string;
  status: DashboardTabStatus;
  lastMessageAt?: string | null;
  hasMessages?: boolean;
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
  created?: string;
  automation?: { id: string } | null;
  ownerId?: string | null;
  lastMessageAt?: string | null;
  hasMessages?: boolean;
  archived: boolean;
  tabs: DashboardTab[];
}

export type ColumnId = "needs" | "working" | "done" | "not-started";

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
  { id: "not-started", label: "Not started" },
];

export type DashboardState = ColumnId | "archived";
export const DASHBOARD_STATES: { id: DashboardState; label: string }[] = [...COLUMNS, { id: "archived", label: "Archived" }];

export const DONE_PAGE = 50;

export interface DashboardFilters {
  projects: string[];
  harnesses: string[];
  columns: DashboardState[];
  owners?: string[];
  automated?: boolean;
}

export const NO_FILTERS: DashboardFilters = { projects: [], harnesses: [], columns: [] };

export function hasFilters(filters: DashboardFilters): boolean {
  return filters.projects.length > 0 || filters.harnesses.length > 0 || filters.columns.length > 0 || !!filters.owners?.length || !!filters.automated;
}

export function toggleFilter<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function sessionColumn(session: DashboardSession): ColumnId {
  if (session.tabs.some((tab) => tab.status === "waiting")) return "needs";
  if (session.tabs.some((tab) => tab.status === "in_progress")) return "working";
  // Opening, renaming or configuring a chat changes `modified`, but starts no turn.
  if (session.hasMessages || session.lastMessageAt || session.tabs.some((tab) => tab.hasMessages || tab.lastMessageAt || tab.status === "completed")) return "done";
  return "not-started";
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
  if (session.archived ? !filters.columns.includes("archived") : filters.columns.length && !filters.columns.includes(sessionColumn(session))) return false;
  if (filters.automated && !session.automation) return false;
  if (filters.owners?.length && (!session.ownerId || !filters.owners.includes(session.ownerId))) return false;
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
  const buckets: Buckets<T> = { needs: [], working: [], done: [], "not-started": [] };
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

/** The same list feeds both views; archives appear only when explicitly requested. */
export function filterSessions<T extends DashboardSession>(sessions: readonly T[], options: BucketOptions): T[] {
  return sessions.filter((session) => session.tabs.length > 0
    && matchesFilters(session, options.filters)
    && matchesQuery(session, options.projectName(session.projectPath), options.query));
}

export const TABLE_COLUMNS = [
  { id: "status", label: "Status" },
  { id: "name", label: "Name" },
  { id: "project", label: "Project" },
  { id: "branch", label: "Branch" },
  { id: "agent", label: "Agent" },
  { id: "pr", label: "PR" },
  { id: "changes", label: "Changes" },
  { id: "owner", label: "Owner" },
  { id: "updated", label: "Updated" },
  { id: "created", label: "Created" },
] as const;
export type TableColumnId = typeof TABLE_COLUMNS[number]["id"];
export interface DashboardSort { column: TableColumnId; direction: "asc" | "desc" }
export interface DashboardPreferences {
  view: "board" | "table";
  sort: DashboardSort;
  hiddenColumns: TableColumnId[];
}
export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  view: "board", sort: { column: "updated", direction: "desc" }, hiddenColumns: [],
};
const isTableColumn = (value: unknown): value is TableColumnId => TABLE_COLUMNS.some((column) => column.id === value);

/** Ignore invalid/obsolete saved values; always leave at least one column visible. */
export function dashboardPreferences(value: unknown): DashboardPreferences {
  const saved = value && typeof value === "object" ? value as Partial<DashboardPreferences> : {};
  const hidden = Array.isArray(saved.hiddenColumns) ? [...new Set(saved.hiddenColumns.filter(isTableColumn))] : [];
  return {
    view: saved.view === "table" ? "table" : "board",
    sort: isTableColumn(saved.sort?.column) && (saved.sort?.direction === "asc" || saved.sort?.direction === "desc")
      ? { column: saved.sort.column, direction: saved.sort.direction } : DEFAULT_DASHBOARD_PREFERENCES.sort,
    hiddenColumns: hidden.length === TABLE_COLUMNS.length ? hidden.filter((id) => id !== "name") : hidden,
  };
}

export function toggleTableColumn(hidden: TableColumnId[], column: TableColumnId): TableColumnId[] {
  if (!hidden.includes(column) && TABLE_COLUMNS.every(({ id }) => id === column || hidden.includes(id))) return hidden;
  return toggleFilter(hidden, column);
}

export function nextDashboardSort(current: DashboardSort, column: TableColumnId): DashboardSort {
  return { column, direction: current.column === column && current.direction === "asc" ? "desc" : "asc" };
}

/** Values used for ordering are the same values rendered by the view. Unknowns sort last in either direction. */
export type DashboardTableRow = { id: string } & Record<TableColumnId, string | number | null>;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function sortDashboardRows<T extends DashboardTableRow>(rows: readonly T[], sort: DashboardSort): T[] {
  const value = (row: T): string | number | null => {
    const raw = row[sort.column];
    if (raw === null || raw === "") return null;
    if (sort.column === "updated" || sort.column === "created") {
      const date = Date.parse(String(raw));
      return Number.isFinite(date) ? date : null;
    }
    return raw;
  };
  return [...rows].sort((left, right) => {
    const a = value(left), b = value(right);
    if (a === null || b === null) return a === b ? left.id.localeCompare(right.id) : a === null ? 1 : -1;
    const compared = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
    return compared ? compared * (sort.direction === "asc" ? 1 : -1) : left.id.localeCompare(right.id);
  });
}
