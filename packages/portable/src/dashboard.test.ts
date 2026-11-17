import { describe, expect, it } from "vitest";
import { dashboardPreferences, DEFAULT_DASHBOARD_PREFERENCES, filterSessions, nextDashboardSort, NO_FILTERS, sortDashboardRows, TABLE_COLUMNS, tableColumns, toggleTableColumn, WHERE_COLUMN, type DashboardSession, type DashboardTableRow } from "./dashboard";

const row = (id: string, patch: Partial<DashboardTableRow> = {}): DashboardTableRow => ({
  id, status: "Needs you", name: "Task 2", project: "Api", where: "Cloud", branch: "feature/2", agent: "Claude", pr: 2, changes: 9, owner: "Amy",
  updated: "2026-11-01T12:00:00Z", created: "2026-10-01T12:00:00Z", ...patch,
});

describe("table sorting", () => {
  it.each(TABLE_COLUMNS)("sorts $id in both directions without changing the input", ({ id }) => {
    const larger = row("b", { status: "Working", name: "Task 10", project: "Site", where: "Local", branch: "feature/10", agent: "Codex", pr: 10, changes: 100, owner: "Zoe", updated: "2026-11-02T12:00:00Z", created: "2026-10-02T12:00:00Z" });
    const input = [larger, row("a")];
    const ascending = nextDashboardSort({ column: id, direction: "desc" }, id);
    expect(sortDashboardRows(input, ascending).map((r) => r.id)).toEqual(["a", "b"]);
    expect(sortDashboardRows(input, nextDashboardSort(ascending, id)).map((r) => r.id)).toEqual(["b", "a"]);
    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });
  it("compares instants with timezone offsets and always puts missing/invalid values last", () => {
    const rows = [row("unknown", { updated: "invalid" }), row("later", { updated: "2026-11-01T10:00:00-04:00" }), row("earlier")];
    expect(sortDashboardRows(rows, { column: "updated", direction: "asc" }).map((r) => r.id)).toEqual(["earlier", "later", "unknown"]);
    expect(sortDashboardRows(rows, { column: "updated", direction: "desc" }).map((r) => r.id)).toEqual(["later", "earlier", "unknown"]);
    expect(sortDashboardRows([row("unknown", { pr: null }), row("known")], { column: "pr", direction: "desc" }).map((r) => r.id)).toEqual(["known", "unknown"]);
  });
  it("breaks ties by identity consistently and starts a newly chosen column ascending", () => {
    expect(sortDashboardRows([row("b"), row("a")], { column: "name", direction: "desc" }).map((r) => r.id)).toEqual(["a", "b"]);
    expect(nextDashboardSort({ column: "updated", direction: "asc" }, "name")).toEqual({ column: "name", direction: "asc" });
  });
});

describe("column preferences", () => {
  it.each(TABLE_COLUMNS.filter((c) => c.id !== "name"))("hides and restores $id without changing the original", ({ id }) => {
    const hidden = toggleTableColumn([], id);
    expect(hidden).toEqual([id]);
    expect(toggleTableColumn(hidden, id)).toEqual([]);
    expect(hidden).toEqual([id]);
    const saved = { view: "table", sort: { column: id, direction: "asc" }, hiddenColumns: hidden, compact: true, owners: ["amy"], columnSet: 2 };
    expect(dashboardPreferences(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
  it("never hides the session column and sanitizes persisted data", () => {
    expect(toggleTableColumn([], "name")).toEqual([]);
    expect(dashboardPreferences({ hiddenColumns: TABLE_COLUMNS.map((c) => c.id), columnSet: 2 }).hiddenColumns).not.toContain("name");
    expect(dashboardPreferences({ view: "bad", sort: { column: "bad" }, hiddenColumns: ["bad", "pr", "pr"], compact: "yes", owners: [1, "amy", "amy"], columnSet: 2 }))
      .toEqual({ ...DEFAULT_DASHBOARD_PREFERENCES, hiddenColumns: ["pr"], owners: ["amy"] });
    expect(dashboardPreferences(null)).toEqual(DEFAULT_DASHBOARD_PREFERENCES);
  });
  it("hides the PR and Created columns once for choices saved before them, so the default set fits 1440 wide", () => {
    expect(dashboardPreferences({ view: "table", hiddenColumns: ["branch"] }).hiddenColumns).toEqual(["branch", "pr", "created"]);
    expect(dashboardPreferences({ view: "table", hiddenColumns: [], columnSet: 2 }).hiddenColumns).toEqual([]);
  });
});

describe("status sorting", () => {
  it("orders by the session's own status, what needs the reader first, whatever PR it names", () => {
    const rows = ["Merged", "In review · PR #212", "Needs approval", "Checks failing · PR #781", "Working"].map((status, index) => row(String(index), { status }));
    expect(sortDashboardRows(rows, { column: "status", direction: "asc" }).map((r) => r.status)).toEqual(["Needs approval", "Working", "Checks failing · PR #781", "In review · PR #212", "Merged"]);
  });
});

it("shares archive, automation, owner, agent, project and search filters across both views", () => {
  const session: DashboardSession = { id: "live", title: "Fix login", projectPath: "/api", cwd: "/api", modified: "2026-11-01", archived: false, tabs: [{ harness: "codex", status: "in_progress" }], automation: { id: "auto" }, ownerId: "amy" };
  const archived = { ...session, id: "archived", archived: true };
  const options = { query: "login api", projectName: () => "Api", filters: { ...NO_FILTERS, projects: ["/api"], harnesses: ["codex"], owners: ["amy"], automations: "only" as const } };
  expect(filterSessions([session, archived], options)).toEqual([session]);
  expect(filterSessions([session, archived], { ...options, filters: { ...options.filters, archived: "only" } })).toEqual([archived]);
  expect(filterSessions([session, archived], { ...options, filters: { ...options.filters, columns: ["working"], archived: "show" } })).toEqual([session, archived]);
  // Automations are hidden unless asked for, as the toolbar's chip says.
  expect(filterSessions([session], { ...options, filters: { ...options.filters, automations: undefined } })).toEqual([]);
  expect(filterSessions([session, { ...session, id: "plain", automation: null }], { ...options, filters: { ...options.filters, automations: "show" } }).map((s) => s.id)).toEqual(["live", "plain"]);
  expect(filterSessions([{ ...session, automation: null }, { ...session, ownerId: "zoe" }, { ...session, tabs: [] }], options)).toEqual([]);
  expect(filterSessions([session], { ...options, query: "nothing" })).toEqual([]);
});

describe("the Where column (PRO-346)", () => {
  it("is offered after Project only when asked, leaving the usual columns as they were", () => {
    expect(tableColumns(true)).toBe(TABLE_COLUMNS);
    expect(tableColumns(false).map((c) => c.id)).toEqual(TABLE_COLUMNS.map((c) => c.id).filter((id) => id !== "where"));
    expect(tableColumns(true).map((c) => c.id).indexOf("where")).toBe(tableColumns(true).map((c) => c.id).indexOf("project") + 1);
    expect(WHERE_COLUMN.label).toBe("Where");
  });
  it("sorts by where a session runs, rows without it last", () => {
    const rows = [row("a", { where: "This Mac" }), row("b", { where: "Cloud" }), row("c", { where: null }), row("d", { where: "Mac mini" })];
    expect(sortDashboardRows(rows, { column: "where", direction: "asc" }).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
    expect(sortDashboardRows(rows, { column: "where", direction: "desc" }).map((r) => r.id)).toEqual(["a", "d", "b", "c"]);
  });
  it("keeps a saved Where choice, and the last column offered stays shown", () => {
    expect(dashboardPreferences({ sort: { column: "where", direction: "asc" }, hiddenColumns: ["where"], columnSet: DEFAULT_DASHBOARD_PREFERENCES.columnSet })).toMatchObject({ sort: { column: "where", direction: "asc" }, hiddenColumns: ["where"] });
    const allButWhere = tableColumns(true).filter((c) => c.id !== "where").map((c) => c.id);
    expect(toggleTableColumn(allButWhere, "where", tableColumns(true))).toEqual(allButWhere);
    // Where hidden too still leaves Name, as Where is not always offered.
    expect(dashboardPreferences({ hiddenColumns: [...allButWhere, "where"] }).hiddenColumns).not.toContain("name");
  });
});
