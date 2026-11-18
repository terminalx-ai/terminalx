export type DashboardTabStatus = "idle" | "in_progress" | "completed" | "waiting";

export interface DashboardTab {
  harness: string;
  status: DashboardTabStatus;
  markedUnread?: boolean;
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
  rowStatus?: { tabs: readonly { activity?: string | null }[] } | null;
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

/** Whether a kind of session is left out (the default), shown with the rest, or shown alone. */
export type Inclusion = "hide" | "show" | "only";

export interface DashboardFilters {
  projects: string[];
  harnesses: string[];
  columns: ColumnId[];
  owners?: string[];
  /** Sessions an automation started. Absent: hidden, as the toolbar's "Hiding automations" says. */
  automations?: Inclusion;
  /** Archived sessions. Absent: hidden. */
  archived?: Inclusion;
}

export const NO_FILTERS: DashboardFilters = { projects: [], harnesses: [], columns: [] };

/** The Filter menu's own choices: project, agent and status. Owners, automations and archives have their own chips. */
export function hasFilters(filters: DashboardFilters): boolean {
  return filters.projects.length > 0 || filters.harnesses.length > 0 || filters.columns.length > 0;
}

export function toggleFilter<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function sessionColumn(session: DashboardSession): ColumnId {
  if (session.tabs.some((tab) => tab.status === "waiting")) return "needs";
  if (session.tabs.some((tab) => tab.status === "in_progress") || session.rowStatus?.tabs.some((tab) => tab.activity === "background")) return "working";
  // Opening, renaming or configuring a chat changes `modified`, but starts no turn.
  if (session.hasMessages || session.lastMessageAt || session.tabs.some((tab) => tab.hasMessages || tab.lastMessageAt || tab.status === "completed")) return "done";
  return "not-started";
}

export function isUnread(session: DashboardSession): boolean {
  return session.tabs.some((tab) => tab.markedUnread) || (sessionColumn(session) === "done" && session.tabs.some((tab) => tab.status === "completed"));
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
  const archived = filters.archived ?? "hide";
  if (session.archived ? archived === "hide" : archived === "only") return false;
  if (!session.archived && filters.columns.length && !filters.columns.includes(sessionColumn(session))) return false;
  const automations = filters.automations ?? "hide";
  if (session.automation ? automations === "hide" : automations === "only") return false;
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

/**
 * The overview table's columns in the order shown (02.01, 02.05). `menu` is
 * the Display menu's name where the header's is too short to stand alone.
 * Status is the session's own status (Checks failing · PR #781), not the board bucket.
 */
export const TABLE_COLUMNS = [
  { id: "name", label: "Session", menu: "Session" },
  { id: "project", label: "Project", menu: "Project" },
  { id: "where", label: "Where", menu: "Where" },
  { id: "branch", label: "Branch", menu: "Branch" },
  { id: "changes", label: "Changes", menu: "Line changes" },
  { id: "status", label: "Status", menu: "Status" },
  { id: "agent", label: "Agent", menu: "Agent" },
  { id: "pr", label: "PR", menu: "Pull request" },
  { id: "owner", label: "Owner", menu: "Owner" },
  { id: "updated", label: "Active", menu: "Last active" },
  { id: "created", label: "Created", menu: "Created" },
] as const;
/**
 * Where a session runs: This Mac, a paired machine's name, or Cloud (PRO-346).
 * The table offers it only while a machine is paired and Experimental →
 * Machines is on, right after Project; otherwise the table is
 * {@link TABLE_COLUMNS} without it.
 */
export type TableColumnId = typeof TABLE_COLUMNS[number]["id"];
export type TableColumn = typeof TABLE_COLUMNS[number];
export const WHERE_COLUMN = TABLE_COLUMNS.find((column) => column.id === "where")!;
const WITHOUT_WHERE: readonly TableColumn[] = TABLE_COLUMNS.filter((column) => column.id !== "where");
/** The columns the table offers: with Where only when `where` (a machine paired, Machines on). */
export function tableColumns(where: boolean): readonly TableColumn[] {
  return where ? TABLE_COLUMNS : WITHOUT_WHERE;
}
/** The session name is the row; it cannot be hidden. */
export const REQUIRED_COLUMN: TableColumnId = "name";
/** Off until chosen, so the default set fits a 1440-wide window: the status already names the PR. */
export const DEFAULT_HIDDEN_COLUMNS: TableColumnId[] = ["pr", "created"];
/** Bumped when a column joins the default-hidden set, so saved choices from before take it too. */
const COLUMN_SET = 2;
export interface DashboardSort { column: TableColumnId; direction: "asc" | "desc" }
export interface DashboardPreferences {
  view: "board" | "table";
  sort: DashboardSort;
  hiddenColumns: TableColumnId[];
  /** 36px rows instead of 44px. */
  compact: boolean;
  /** The people filter is kept on this Mac (02.05). */
  owners: string[];
  columnSet: number;
}
export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  view: "board", sort: { column: "updated", direction: "desc" }, hiddenColumns: DEFAULT_HIDDEN_COLUMNS, compact: false, owners: [], columnSet: COLUMN_SET,
};
const isTableColumn = (value: unknown): value is TableColumnId => TABLE_COLUMNS.some((column) => column.id === value);

/** Ignore invalid/obsolete saved values; the session column is always shown. */
export function dashboardPreferences(value: unknown): DashboardPreferences {
  const saved = value && typeof value === "object" ? value as Partial<DashboardPreferences> : {};
  const listed = Array.isArray(saved.hiddenColumns) ? saved.hiddenColumns.filter(isTableColumn) : DEFAULT_HIDDEN_COLUMNS;
  const current = typeof saved.columnSet === "number" && saved.columnSet >= COLUMN_SET;
  const hidden = [...new Set(current ? listed : [...listed, ...DEFAULT_HIDDEN_COLUMNS])].filter((id) => id !== REQUIRED_COLUMN);
  return {
    view: saved.view === "table" ? "table" : "board",
    sort: isTableColumn(saved.sort?.column) && (saved.sort?.direction === "asc" || saved.sort?.direction === "desc")
      ? { column: saved.sort.column, direction: saved.sort.direction } : DEFAULT_DASHBOARD_PREFERENCES.sort,
    hiddenColumns: hidden,
    compact: saved.compact === true,
    owners: Array.isArray(saved.owners) ? [...new Set(saved.owners.filter((id): id is string => typeof id === "string" && !!id))] : [],
    columnSet: COLUMN_SET,
  };
}

/** Hide or show a column; the session column stays, and so does the last one shown among `columns` (the ones offered). */
export function toggleTableColumn(hidden: TableColumnId[], column: TableColumnId, columns: readonly TableColumn[] = TABLE_COLUMNS): TableColumnId[] {
  if (column === REQUIRED_COLUMN) return hidden.filter((id) => id !== column);
  if (!hidden.includes(column) && columns.every(({ id }) => id === column || hidden.includes(id))) return hidden;
  return toggleFilter(hidden, column);
}

export function nextDashboardSort(current: DashboardSort, column: TableColumnId): DashboardSort {
  return { column, direction: current.column === column && current.direction === "asc" ? "desc" : "asc" };
}

/** The status labels in the order the status column sorts: what needs the reader first, then work, then PRs. */
const STATUS_ORDER = ["Needs approval", "Needs you", "Working", "Checks failing", "Draft PR", "In review", "Ready to merge", "Uncommitted", "Not started", "No changes", "Merged"];

/** Values used for ordering are the same values rendered by the view. Unknowns sort last in either direction. */
export type DashboardTableRow = { id: string } & Record<Exclude<TableColumnId, "where">, string | number | null> & { where?: string | null };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function sortDashboardRows<T extends DashboardTableRow>(rows: readonly T[], sort: DashboardSort): T[] {
  const value = (row: T): string | number | null => {
    const raw = row[sort.column];
    if (raw === null || raw === undefined || raw === "") return null;
    if (sort.column === "updated" || sort.column === "created") {
      const date = Date.parse(String(raw));
      return Number.isFinite(date) ? date : null;
    }
    if (sort.column === "status") {
      const label = String(raw).split(" · ")[0];
      const rank = STATUS_ORDER.indexOf(label);
      return rank < 0 ? STATUS_ORDER.length : rank;
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
