import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BrowserPage } from "@/lib/api";
import type { Project, SessionEntry, TabEntry, Workspace } from "@/types/session";

// A DOM snapshot of every row the local sidebar tree can draw. The snapshot
// was recorded before the row building blocks moved into SidebarRows, so a
// change here is a change to what users see, not a refactor.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set(["tab-waiting"]) }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: { "tab-done": "terminal" } }) }));

const { ProjectNavigation } = await import("./SidebarTree");
const sessions = await import("@/lib/sessions");
const terminals = await import("@/lib/terminal");
const browser = await import("@/lib/browser");

const NOW = new Date("2026-09-30T12:00:00.000Z");
const projectPath = "/repos/raccoon";
const featurePath = "/repos/raccoon/.worktrees/feature";

const baseWorkspace: Workspace = {
  path: projectPath, name: "raccoon", branch: "main", head: "abc1234", isMain: true, managed: false,
  uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0, state: "merged", sizeBytes: 4096,
};
const workspaces: Workspace[] = [
  baseWorkspace,
  { ...baseWorkspace, path: featurePath, name: "quiet-amber-fox", branch: "feature/sidebar", isMain: false, managed: true, state: "uncommitted", additions: 12, deletions: 3, unpushed: 1 },
  { ...baseWorkspace, path: "/tmp/external", name: "external", branch: "hotfix", isMain: false, managed: false, state: "unmerged", deletions: 4, unpushed: 2 },
];

const tab = (id: string, patch: Partial<TabEntry>): TabEntry => ({
  id, harness: "codex", title: null, model: "gpt-5", permissionMode: "auto", status: "idle",
  created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z", ...patch,
});
const session = (id: string, patch: Partial<SessionEntry>): SessionEntry => ({
  id, projectPath, cwd: projectPath, worktreeRemoved: false, title: `Session ${id}`,
  created: "2026-09-29T00:00:00.000Z", modified: "2026-09-30T11:58:00.000Z", archived: false, pinned: false,
  tabs: [tab(`${id}-tab`, {})], activeTab: `${id}-tab`, ...patch,
});

const fixtureSessions: SessionEntry[] = [
  session("feature", {
    cwd: featurePath, worktreeName: "quiet-amber-fox", branch: "feature/sidebar", pinned: true,
    title: "Consolidate a very long navigation hierarchy title",
    activeTab: "tab-running",
    tabs: [
      tab("tab-running", { status: "in_progress", created: "2026-09-30T09:00:00.000Z" }),
      tab("tab-waiting", { harness: "claude", title: "Research notes", status: "waiting", created: "2026-09-30T09:01:00.000Z" }),
      tab("tab-done", { harness: "claude", title: "  ", status: "completed", created: "2026-09-30T09:02:00.000Z" }),
      tab("tab-unknown", { harness: "mystery", status: "idle", created: "2026-09-30T09:03:00.000Z" }),
    ],
  }),
  session("issue", {
    issue: { provider: "linear", id: "1", identifier: "PRO-1", title: "Issue", url: "https://example.com" },
    branch: "pro-1-issue-branch", modified: "2026-09-30T08:00:00.000Z",
  }),
  session("automation", {
    automation: { id: "auto", name: "Nightly triage", runId: "run", runNumber: 7 }, modified: "2026-09-27T12:00:00.000Z",
  }),
  session("empty", { cwd: "/tmp/external", tabs: [], activeTab: null, modified: "2026-09-01T12:00:00.000Z" }),
  session("missing", { cwd: "/tmp/missing-checkout", modified: "2026-09-30T11:59:50.000Z" }),
  session("removed", {
    cwd: "/tmp/removed-cwd", worktreeRemoved: true, worktreeName: "gone-worktree",
    removedWorkspace: { path: "/tmp/removed-checkout", name: "gone-worktree", branch: "gone" },
  }),
];

const project: Project = { path: projectPath, name: "Raccoon" };
const folder: Project = { path: "/notes", name: "Notes", kind: "folder" };
const emptyProject: Project = { path: "/empty", name: "Empty" };

const pages: BrowserPage[] = [
  { id: "page-docs", browserPageId: "page-docs", profileId: "default", tabId: "t1", url: "https://example.com/docs", title: "Docs", workspacePath: featurePath, created: "2026-09-30T09:05:00.000Z", active: true, index: 0 },
  { id: "page-blank", browserPageId: "page-blank", profileId: "default", tabId: "t2", url: "", title: "", workspacePath: featurePath, created: "2026-09-30T09:06:00.000Z", active: false, index: 1 },
];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, string>) => {
    if (command === "list_projects") return { projects: [project, folder, emptyProject], lastSelected: projectPath };
    if (command === "list_sessions") return fixtureSessions;
    if (command === "list_harnesses") return [{ id: "codex", name: "Codex", available: true }, { id: "claude", name: "Claude", available: true }];
    if (command === "list_workspaces") {
      if (args?.projectPath === projectPath) return workspaces;
      if (args?.projectPath === "/notes") return [{ ...baseWorkspace, path: "/notes", name: "notes", branch: "" }];
      return [];
    }
    if (command === "browser_pages") return pages;
    throw new Error(`Unexpected command: ${command}`);
  });
  await act(async () => {
    await sessions.bootSessions();
    await sessions.refreshEverything();
    await browser.refreshBrowserPages();
    await terminals.adoptPane({ id: "shell-live", sessionId: "feature", title: "Terminal 1" });
    await terminals.adoptPane({ id: "shell-exited", sessionId: "feature", title: "Terminal 2" });
    await terminals.adoptPane({ id: "owned-pty", sessionId: "feature", title: "Agent PTY", hidden: true, owned: true });
    mocks.listeners.get("pty_exit")?.({ payload: { id: "shell-exited", code: 0 } });
    sessions.selectSession("feature");
  });
});
afterEach(cleanup);
afterAll(() => vi.useRealTimers());

const mount = (target: Project, expanded = true) => render(
  <TooltipProvider>
    <ProjectNavigation project={target} expanded={expanded} />
  </TooltipProvider>,
);

describe("sidebar tree DOM", () => {
  it("draws every workspace, session and tab row kind", () => {
    const { container } = mount(project);
    expect(container).toMatchSnapshot();
  });

  it("draws folder projects", () => {
    const { container } = mount(folder);
    expect(container).toMatchSnapshot();
  });

  it("draws an empty and a collapsed project", () => {
    const empty = mount(emptyProject);
    expect(empty.container).toMatchSnapshot();
    cleanup();
    const collapsed = mount(project, false);
    expect(collapsed.container).toMatchSnapshot();
  });

  it("draws archived sessions when archived sessions are shown", () => {
    act(() => {
      sessions.patchSession("automation", { archived: true });
      sessions.setShowArchived(true);
    });
    const { container } = mount(project);
    expect(container).toMatchSnapshot();
    act(() => {
      sessions.setShowArchived(false);
      sessions.patchSession("automation", { archived: false });
    });
  });
});
