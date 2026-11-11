import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import { DEFAULT_DASHBOARD_PREFERENCES, TABLE_COLUMNS } from "@terminalx/portable/dashboard";
import { setPrefs, getPrefs } from "@/lib/prefs";
import { AgentDashboard } from "./AgentDashboard";

const state = vi.hoisted(() => ({ sessions: [] as SessionEntry[], select: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: state.sessions, loaded: true, projects: [], harnesses: [] }), selectSession: state.select }));
vi.mock("@/lib/summaries", () => ({ useSessionSummaries: () => ({ get: () => undefined, loading: false }) }));
vi.mock("@/lib/cloudDashboard", () => ({ useCloudDashboard: () => [], isCloudDashboardSession: () => false }));
vi.mock("@/lib/organizationVisibility", () => ({ useOrganizationVisibility: () => ({ visibleIds: new Set() }) }));
vi.mock("@/lib/dashboardPrs", () => ({ useDashboardPrs: () => new Map() }));
vi.mock("@/lib/cloudPeople", () => ({ usePeople: () => (id: string) => id, loadRosterIn: vi.fn(async () => []) }));
vi.mock("@/components/dashboard/AgentCard", () => ({
  AgentCard: ({ session }: { session: SessionEntry }) => <div>{session.title}</div>,
  AgentCardSkeleton: () => null,
}));
beforeEach(() => {
  setPrefs({ dashboard: DEFAULT_DASHBOARD_PREFERENCES });
  state.sessions = [];
  state.select.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

it("renders empty chats under Not started and moves a chat after its first message", () => {
  const at = "2026-11-05T12:00:00Z";
  const empty: SessionEntry = {
    id: "empty", kind: "quick", projectPath: "/scratch", cwd: "/scratch", worktreeRemoved: false,
    title: "Empty chat", created: at, modified: at, archived: false, pinned: false,
    tabs: [{ id: "tab", harness: "codex", model: "", permissionMode: "auto", status: "idle", created: at, modified: at }],
  };
  const read = { ...empty, id: "read", title: "Read chat", hasMessages: true };
  state.sessions = [empty, read];
  const view = render(<AgentDashboard />);
  const column = (name: string) => within(screen.getByRole("region", { name }));
  expect(column("Not started").getByText("Empty chat")).toBeDefined();
  expect(column("Done").queryByText("Empty chat")).toBeNull();
  expect(column("Done").getByText("Read chat")).toBeDefined();

  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "Empty" } });
  expect(column("Not started").getByText("Empty chat")).toBeDefined();
  expect(column("Done").queryByText("Read chat")).toBeNull();

  state.sessions = [{ ...empty, lastMessageAt: at }, read];
  view.rerender(<AgentDashboard />);
  expect(column("Not started").queryByText("Empty chat")).toBeNull();
  expect(column("Done").getByText("Empty chat")).toBeDefined();
});

const at = "2026-11-01T12:00:00Z";
function session(id: string, patch: Partial<SessionEntry> = {}): SessionEntry {
  return { id, title: id, projectPath: "/api", cwd: "/api", worktreeRemoved: false, created: at, modified: at, archived: false, pinned: false,
    tabs: [{ id: `${id}-tab`, harness: "codex", status: "in_progress", created: at, modified: at, model: "", permissionMode: "auto" }], ...patch };
}
const rowNames = () => within(screen.getByRole("table", { name: "Sessions" })).getAllByRole("row").slice(1).map((r) => r.querySelector("[data-session-title]")?.textContent);
const openMenu = (name: string) => fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0, ctrlKey: false, pointerType: "mouse" });
const closeMenu = () => fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

it("shows detailed automatic statuses in the table while preserving workflow states", () => {
  const branchStatus = { branch: "feature", checked: true, headMatches: true, pr: { number: 7, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "FAILURE", inMergeQueue: false } };
  state.sessions = [
    session("Needs approval", { rowStatus: { tabs: [{ status: "waiting", activity: "needs_permission" }], branch: "feature", branchStatus } }),
    session("Failed build", { rowStatus: { tabs: [{ status: "idle" }], branch: "feature", branchStatus } }),
  ];
  render(<AgentDashboard />);
  fireEvent.click(screen.getByRole("button", { name: "Table" }));
  const table = within(screen.getByRole("table", { name: "Sessions" }));
  // One label for every kind of waiting; the tooltip says it is a permission. The PR number follows its state.
  expect(table.getByTitle(/permission to run a tool/).textContent).toBe("Needs approval");
  expect(table.getByText("Checks failing · PR #7")).toBeTruthy();
  expect(table.getAllByText("Working")).toHaveLength(2);
  expect(rowNames()).toEqual(["Failed build", "Needs approval"]);
});

it("keeps search and filters across views, includes archived automations, and clears filters", async () => {
  state.sessions = [session("Fix live"), session("Fix archived", { archived: true, automation: { id: "auto", name: "Daily", runId: "run", runNumber: 1 } }), session("Other")];
  render(<AgentDashboard />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "Fix" } });
  openMenu("Filter");
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Archived" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Started by automation" }));
  closeMenu();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(within(screen.getByRole("region", { name: "Archived" })).getByText("Fix archived")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Table" }));
  expect(rowNames()).toEqual(["Fix archived"]);
  expect((screen.getByRole("textbox", { name: "Search sessions" }) as HTMLInputElement).value).toBe("Fix");
  openMenu("Filter2");
  fireEvent.click(screen.getByRole("menuitem", { name: "Clear filters" }));
  expect(rowNames()).toEqual(["Fix live"]);
});

it.each(TABLE_COLUMNS)("sorts and toggles the $label column", async ({ id, label }) => {
  state.sessions = [session("Task 10"), session("Task 2")];
  render(<AgentDashboard />);
  fireEvent.click(screen.getByRole("button", { name: "Table" }));
  const table = within(screen.getByRole("table", { name: "Sessions" }));
  // Start another column so the first click is always ascending.
  fireEvent.click(table.getByRole("button", { name: id === "name" ? "Project" : "Name" }));
  fireEvent.click(table.getByRole("button", { name: label }));
  expect(table.getByRole("columnheader", { name: label }).getAttribute("aria-sort")).toBe("ascending");
  fireEvent.click(table.getByRole("button", { name: label }));
  expect(table.getByRole("columnheader", { name: label }).getAttribute("aria-sort")).toBe("descending");
  openMenu("Columns");
  const checkbox = await screen.findByRole("menuitemcheckbox", { name: label });
  fireEvent.click(checkbox);
  expect(table.queryByRole("columnheader", { name: label, hidden: true })).toBeNull();
  fireEvent.click(checkbox);
  expect(table.getByRole("columnheader", { name: label, hidden: true })).toBeDefined();
  closeMenu();
}, 20_000);

it("remembers the view, sorting and hidden columns, preserving natural name order", async () => {
  state.sessions = [session("Task 10"), session("Task 2")];
  let view = render(<AgentDashboard />);
  fireEvent.click(screen.getByRole("button", { name: "Table" }));
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(rowNames()).toEqual(["Task 2", "Task 10"]);
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(rowNames()).toEqual(["Task 10", "Task 2"]);
  openMenu("Columns");
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Branch" }));
  closeMenu();
  view.unmount();
  view = render(<AgentDashboard />);
  expect(rowNames()).toEqual(["Task 10", "Task 2"]);
  expect(screen.queryByRole("columnheader", { name: "Branch" })).toBeNull();
  expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).dashboard).toEqual(getPrefs().dashboard);
}, 20_000);

it("moves and opens in sorted order, preserves selection after sorting, and leaves inputs and menus their keys", async () => {
  state.sessions = [session("Alpha"), session("Beta")];
  render(<AgentDashboard />);
  fireEvent.click(screen.getByRole("button", { name: "Table" }));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  expect(screen.getByRole("row", { name: /Alpha/ }).getAttribute("data-focused")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("row", { name: /Alpha/ }));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(state.select).toHaveBeenLastCalledWith("Beta");
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(screen.getByRole("row", { name: /Beta/ }).getAttribute("data-focused")).toBe("true");
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(state.select).toHaveBeenLastCalledWith("Alpha");
  state.select.mockClear();
  fireEvent.keyDown(screen.getByRole("button", { name: "Name" }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Search sessions" }), { key: "Enter" });
  openMenu("Columns");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
  expect(state.select).not.toHaveBeenCalled();
  closeMenu();
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "Beta" } });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(state.select).not.toHaveBeenCalled(); // filtered-out cursor cannot open a different session
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(state.select).toHaveBeenCalledWith("Beta");
});
