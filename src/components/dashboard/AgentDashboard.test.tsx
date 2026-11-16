import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import { DEFAULT_DASHBOARD_PREFERENCES, TABLE_COLUMNS } from "@terminalx/portable/dashboard";
import { setPrefs, getPrefs } from "@/lib/prefs";
import { AgentDashboard } from "./AgentDashboard";

const state = vi.hoisted(() => ({ sessions: [] as SessionEntry[], select: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: state.sessions, loaded: true, projects: [], harnesses: [] }), selectSession: state.select, openNewSession: vi.fn() }));
vi.mock("@/lib/summaries", () => ({ useSessionSummaries: () => ({ get: () => undefined, loading: false }) }));
vi.mock("@/lib/cloudDashboard", () => ({ useCloudDashboard: () => [], isCloudDashboardSession: () => false }));
vi.mock("@/lib/organizationVisibility", () => ({ useOrganizationVisibility: () => ({ visibleIds: new Set() }) }));
vi.mock("@/lib/dashboardPrs", () => ({ useDashboardPrs: () => new Map() }));
vi.mock("@/lib/cloudPeople", () => ({ usePeople: () => (id: string) => id, loadRosterIn: vi.fn(async () => []), userIdForEmail: () => null, initials: (name: string) => name.slice(0, 2).toUpperCase() }));
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
/** The view lives in the Display menu (02.15). */
async function showView(name: "Table" | "Board") {
  openMenu("Display");
  fireEvent.click(await screen.findByRole("button", { name }));
  closeMenu();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

it("shows each row's own status in the Status column, never the board's bucket", async () => {
  const branchStatus = { branch: "feature", checked: true, headMatches: true, pr: { number: 7, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "FAILURE", inMergeQueue: false } };
  state.sessions = [
    session("Needs approval", { rowStatus: { tabs: [{ status: "waiting", activity: "needs_permission" }], branch: "feature", branchStatus } }),
    session("Failed build", { rowStatus: { tabs: [{ status: "idle" }], branch: "feature", branchStatus } }),
  ];
  render(<AgentDashboard />);
  await showView("Table");
  const table = within(screen.getByRole("table", { name: "Sessions" }));
  // One label for every kind of waiting; the tooltip says it is a permission. The PR number follows its state.
  expect(table.getByTitle(/permission to run a tool/).textContent).toBe("Needs approval");
  expect(table.getByText("Checks failing · PR #7")).toBeTruthy();
  // The bucket ("Working", "Done") is the board's; the table names the state itself.
  expect(table.queryByText("Working")).toBeNull();
  expect(table.queryByText("Done")).toBeNull();
  expect(rowNames()).toEqual(["Failed build", "Needs approval"]);
  fireEvent.click(table.getByRole("button", { name: "Status" }));
  expect(rowNames()).toEqual(["Needs approval", "Failed build"]);
});

it("keeps search and filters across views, hides automations and archives until asked, and clears filters", async () => {
  const automation = { id: "auto", name: "Daily", runId: "run", runNumber: 1 };
  state.sessions = [session("Fix live"), session("Fix archived", { archived: true, automation }), session("Fix nightly", { automation }), session("Other")];
  render(<AgentDashboard />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "Fix" } });
  expect(screen.queryByText("Fix nightly")).toBeNull();
  openMenu("Hiding archived");
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Only archived" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  openMenu("Hiding automations");
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Only automations" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(within(screen.getByRole("region", { name: "Archived" })).getByText("Fix archived")).toBeDefined();
  await showView("Table");
  expect(rowNames()).toEqual(["Fix archived"]);
  expect((screen.getByRole("textbox", { name: "Search sessions" }) as HTMLInputElement).value).toBe("Fix");
  openMenu("Only archived");
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Hide archived" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(rowNames()).toEqual(["Fix nightly"]);
  openMenu("Filter");
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Done" }));
  closeMenu();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(screen.getByText("No sessions match your search and filters.")).toBeDefined();
  openMenu("Filter, 1 on");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Clear filters" }));
  await waitFor(() => expect(rowNames()).toEqual(["Fix nightly"]));
});

it.each(TABLE_COLUMNS)("sorts and toggles the $label column", async ({ id, label, menu }) => {
  state.sessions = [session("Task 10"), session("Task 2")];
  setPrefs({ dashboard: { ...DEFAULT_DASHBOARD_PREFERENCES, hiddenColumns: [] } });
  render(<AgentDashboard />);
  await showView("Table");
  const table = within(screen.getByRole("table", { name: "Sessions" }));
  // Start another column so the first click is always ascending.
  fireEvent.click(table.getByRole("button", { name: id === "name" ? "Project" : "Session" }));
  fireEvent.click(table.getByRole("button", { name: label }));
  expect(table.getByRole("columnheader", { name: label }).getAttribute("aria-sort")).toBe("ascending");
  fireEvent.click(table.getByRole("button", { name: label }));
  expect(table.getByRole("columnheader", { name: label }).getAttribute("aria-sort")).toBe("descending");
  openMenu("Display");
  if (id === "name") {
    // The session names the row: it is not offered to hide.
    await screen.findByRole("menuitemcheckbox", { name: "Project" });
    expect(screen.queryByRole("menuitemcheckbox", { name: "Session" })).toBeNull();
  } else {
    const checkbox = await screen.findByRole("menuitemcheckbox", { name: menu });
    fireEvent.click(checkbox);
    expect(table.queryByRole("columnheader", { name: label, hidden: true })).toBeNull();
    fireEvent.click(checkbox);
    expect(table.getByRole("columnheader", { name: label, hidden: true })).toBeDefined();
  }
  closeMenu();
}, 20_000);

it("shows the designed default columns, people and the toolbar", async () => {
  state.sessions = [session("Task")];
  render(<AgentDashboard />);
  expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  expect(screen.getByRole("button", { name: /New session/ })).toBeDefined();
  expect(screen.getByRole("textbox", { name: "Search sessions" }).getAttribute("placeholder")).toBe("Search sessions, branches, PRs");
  await showView("Table");
  const headers = within(screen.getByRole("table", { name: "Sessions" })).getAllByRole("columnheader").map((header) => header.textContent);
  expect(headers).toEqual(["Session", "Project", "Where", "Branch", "Changes", "Status", "Agent", "Owner", "Active"]);
  expect(screen.getByRole("img", { name: "You" })).toBeDefined();
  fireEvent.keyDown(window, { key: "/" });
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search sessions" }));
});

it("remembers the view, sorting, hidden columns and density, preserving natural name order", async () => {
  state.sessions = [session("Task 10"), session("Task 2")];
  let view = render(<AgentDashboard />);
  await showView("Table");
  fireEvent.click(screen.getByRole("button", { name: "Session" }));
  expect(rowNames()).toEqual(["Task 2", "Task 10"]);
  fireEvent.click(screen.getByRole("button", { name: "Session" }));
  expect(rowNames()).toEqual(["Task 10", "Task 2"]);
  openMenu("Display");
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Branch" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Compact rows" }));
  closeMenu();
  expect(screen.getByRole("row", { name: /Task 10/ }).style.height).toBe("36px");
  view.unmount();
  view = render(<AgentDashboard />);
  expect(rowNames()).toEqual(["Task 10", "Task 2"]);
  expect(screen.queryByRole("columnheader", { name: "Branch" })).toBeNull();
  expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).dashboard).toEqual(getPrefs().dashboard);
}, 20_000);

it("moves and opens in sorted order, preserves selection after sorting, and leaves inputs and menus their keys", async () => {
  state.sessions = [session("Alpha"), session("Beta")];
  render(<AgentDashboard />);
  await showView("Table");
  fireEvent.keyDown(window, { key: "ArrowDown" });
  expect(screen.getByRole("row", { name: /Alpha/ }).getAttribute("data-focused")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("row", { name: /Alpha/ }));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(state.select).toHaveBeenLastCalledWith("Beta");
  fireEvent.click(screen.getByRole("button", { name: "Session" }));
  fireEvent.click(screen.getByRole("button", { name: "Session" }));
  expect(screen.getByRole("row", { name: /Beta/ }).getAttribute("data-focused")).toBe("true");
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(state.select).toHaveBeenLastCalledWith("Alpha");
  state.select.mockClear();
  fireEvent.keyDown(screen.getByRole("button", { name: "Session" }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Search sessions" }), { key: "Enter" });
  openMenu("Display");
  fireEvent.keyDown(await screen.findByRole("menu"), { key: "ArrowDown" });
  expect(state.select).not.toHaveBeenCalled();
  closeMenu();
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "Beta" } });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(state.select).not.toHaveBeenCalled(); // filtered-out cursor cannot open a different session
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(state.select).toHaveBeenCalledWith("Beta");
});
