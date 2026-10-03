import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus } from "@/lib/api";
import type { Project, SessionEntry, Workspace } from "@/types/session";

// PRO-23: the sidebar's Unread / Needs you filter, on local projects. (The
// cloud half is in cloud/CloudProjects.test.tsx.)

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));

const { ProjectRail } = await import("./ProjectRail");
const sessions = await import("@/lib/sessions");
const account = await import("@/lib/account");

const workspaceOf = (path: string, name: string): Workspace => ({ path, name, branch: "main", head: "abc1234", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 });
const projects: Project[] = [
  { path: "/repos/api", name: "Api" },
  { path: "/repos/web", name: "Web" },
  { path: "/repos/quiet", name: "Quiet" },
];
const session = (id: string, projectPath: string, title: string, status: string, fields: Partial<SessionEntry> = {}): SessionEntry =>
  ({
    id,
    projectPath,
    cwd: projectPath,
    worktreeRemoved: false,
    title,
    created: "2026-10-01T00:00:00.000Z",
    modified: "2026-10-03T10:00:00.000Z",
    archived: false,
    pinned: false,
    tabs: [{ id: `${id}-t`, harness: "claude", title: null, model: "opus", permissionMode: "auto", status, created: "2026-10-01T00:00:00.000Z", modified: "2026-10-01T00:00:00.000Z" }],
    activeTab: `${id}-t`,
    ...fields,
  }) as SessionEntry;
const sessionList: SessionEntry[] = [
  session("needs", "/repos/api", "Approve the migration", "waiting"),
  session("working", "/repos/api", "Refactor the router", "in_progress"),
  session("unread", "/repos/web", "Landing page copy", "completed"),
  session("read", "/repos/web", "Old chat", "idle"),
  session("quiet", "/repos/quiet", "Nothing to see", "idle"),
  session("archived-waiting", "/repos/quiet", "Archived and waiting", "waiting", { archived: true }),
];

beforeAll(async () => {
  mocks.invoke.mockImplementation(async (command: string, args: { projectPath?: string } = {}) => {
    if (command === "list_projects") return { projects, lastSelected: "/repos/quiet" };
    if (command === "list_sessions") return sessionList;
    if (command === "list_harnesses") return [{ id: "claude", name: "Claude", available: true }];
    if (command === "list_workspaces") return [workspaceOf(args.projectPath ?? "/repos/api", "main")];
    if (command === "account_status") return { state: "signed-out", identity: null, expiresAt: null, lastError: null } satisfies AccountStatus;
    if (command === "list_automations") return [];
    return null;
  });
  await act(async () => {
    await sessions.bootSessions();
    await sessions.refreshEverything();
    await account.bootAccount();
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    sessions.setSidebarFilter("all");
    sessions.selectSession(null);
  });
});

const noop = () => {};
const mount = () =>
  render(
    <TooltipProvider>
      <ProjectRail onOpenSettings={noop} onOpenAccount={noop} onOpenIssues={noop} onOpenAgents={noop} onOpenStats={noop} onOpenAutomations={noop} onOpenSkills={noop} onSearch={noop} />
    </TooltipProvider>,
  );

const projectNames = () => screen.queryAllByRole("treeitem").flatMap((node) => (["Api", "Web", "Quiet"].includes(node.getAttribute("aria-label") ?? "") ? [node.getAttribute("aria-label")] : []));
const shown = (title: string) => screen.queryAllByText(title).length > 0;

async function choose(label: string) {
  const trigger = screen.getByTestId("sidebar-filter");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: label }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

describe("the sidebar's session filter (local)", () => {
  it("lists every project by default, and the control says no filter is on", () => {
    mount();
    expect(projectNames()).toEqual(["Api", "Quiet", "Web"]);
    const control = screen.getByTestId("sidebar-filter");
    expect(control.getAttribute("data-filter")).toBe("all");
    expect(control.getAttribute("aria-label")).toBe("Filter sessions");
  });

  it("Needs you shows only the sessions waiting for a person, with their projects opened", async () => {
    mount();
    await choose("Needs you");
    expect(sessions.getSessionStore().sidebarFilter).toBe("needs");
    expect(projectNames()).toEqual(["Api"]);
    expect(shown("Approve the migration")).toBe(true);
    // Not one that is only working, and never an archived one.
    expect(shown("Refactor the router")).toBe(false);
    expect(shown("Archived and waiting")).toBe(false);
    const control = screen.getByTestId("sidebar-filter");
    expect(control.getAttribute("aria-label")).toBe("Filter sessions: Needs you");
    expect(control.className).toContain("bg-veil-strong");
  });

  it("Unread shows only finished answers nobody has read", async () => {
    mount();
    await choose("Unread");
    expect(projectNames()).toEqual(["Web"]);
    expect(shown("Landing page copy")).toBe(true);
    expect(shown("Old chat")).toBe(false);
  });

  it("keeps the selected session in view although it does not match, so reading it does not make it vanish", async () => {
    mount();
    act(() => sessions.selectSession("read"));
    await choose("Needs you");
    expect(projectNames()).toEqual(["Api", "Web"]);
    expect(shown("Old chat")).toBe(true);
    expect(shown("Landing page copy")).toBe(false);
  });

  it("says when nothing matches and offers the way back", async () => {
    mount();
    act(() => sessions.setSidebarFilter("needs"));
    // The waiting session is answered.
    const answered = sessionList.map((entry) => (entry.id === "needs" ? { ...entry, tabs: entry.tabs.map((tab) => ({ ...tab, status: "idle" as const })) } : entry));
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: { projectPath?: string } = {}) => (command === "list_sessions" ? answered : original(command, args)));
    try {
      await act(async () => {
        await sessions.refreshEverything();
      });
      const empty = await screen.findByTestId("sidebar-filter-empty");
      expect(empty.textContent).toContain("Nothing needs you.");
      expect(projectNames()).toEqual([]);
      fireEvent.click(within(empty).getByRole("button", { name: "Show all sessions" }));
      expect(sessions.getSessionStore().sidebarFilter).toBe("all");
      expect(projectNames()).toEqual(["Api", "Quiet", "Web"]);
    } finally {
      mocks.invoke.mockImplementation(original);
      await act(async () => {
        await sessions.refreshEverything();
      });
    }
  });
});
