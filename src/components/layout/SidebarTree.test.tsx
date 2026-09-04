import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionEntry, Workspace } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));

const { ProjectNavigation, groupProjectWorkspaces } = await import("./SidebarTree");
const { bootSessions, getSessionStore, selectSession } = await import("@/lib/sessions");

const projectPath = "/repos/raccoon";
const workspacePath = "/repos/raccoon/.worktrees/feature";
const workspace: Workspace = {
  path: workspacePath,
  name: "quiet-amber-fox",
  branch: "feature/sidebar-tree",
  head: "abc1234",
  isMain: false,
  managed: true,
  uncommitted: 2,
  additions: 5,
  deletions: 1,
  unpushed: 1,
  ahead: 1,
  behind: 0,
};
const session: SessionEntry = {
  id: "session-1",
  projectPath,
  cwd: workspacePath,
  worktreeName: "quiet-amber-fox",
  branch: "feature/sidebar-tree",
  worktreeRemoved: false,
  title: "Consolidate a very long navigation hierarchy title",
  created: "2026-09-04T00:00:00.000Z",
  modified: "2026-09-04T00:00:00.000Z",
  archived: false,
  pinned: true,
  activeTab: "tab-1",
  tabs: [
    {
      id: "tab-1",
      harness: "codex",
      title: null,
      model: "gpt-5",
      permissionMode: "bypassPermissions",
      status: "in_progress",
      created: "2026-09-04T00:00:00.000Z",
      modified: "2026-09-04T00:00:00.000Z",
    },
    {
      id: "tab-2",
      harness: "claude",
      title: "Research notes with a long title",
      model: "sonnet",
      permissionMode: "bypassPermissions",
      status: "waiting",
      created: "2026-09-04T00:00:00.000Z",
      modified: "2026-09-04T00:00:00.000Z",
    },
  ],
};

afterEach(cleanup);

describe("sidebar navigation tree", () => {
  it("groups main, managed, external, and historical missing workspaces", () => {
    const main = { ...workspace, path: projectPath, name: "raccoon", isMain: true, managed: false };
    const external = { ...workspace, path: "/tmp/external", name: "external", managed: false };
    const missingSession = { ...session, id: "gone", cwd: "/tmp/gone", worktreeRemoved: true };

    const groups = groupProjectWorkspaces(projectPath, [main, workspace, external], [session, missingSession], false);

    expect(groups.map((group) => group.workspace?.path ?? `missing:${group.path}`)).toEqual([
      projectPath,
      workspacePath,
      "/tmp/external",
      "missing:/tmp/gone",
    ]);
  });

  it("reveals the selected path, uses the agent fallback, and opens tabs from pointer or keyboard", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_projects") return { projects: [{ path: projectPath, name: "Raccoon" }], lastSelected: projectPath };
      if (command === "list_sessions") return [session];
      if (command === "list_harnesses") {
        return [
          { id: "codex", name: "Codex", available: true },
          { id: "claude", name: "Claude", available: true },
        ];
      }
      if (command === "list_workspaces") return [workspace];
      if (command === "set_active_tab") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => bootSessions());
    act(() => selectSession(session.id));
    render(
      <TooltipProvider>
        <ProjectNavigation project={{ path: projectPath, name: "Raccoon" }} expanded />
      </TooltipProvider>,
    );

    expect(await screen.findByText("Codex")).toBeTruthy();
    const selectedTab = screen.getByText("Codex").closest('[role="treeitem"]');
    expect(selectedTab?.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: `Collapse ${session.title}` }));
    expect(getSessionStore().selectedSessionId).toBe(session.id);
    fireEvent.click(screen.getByRole("button", { name: `Expand ${session.title}` }));

    const otherTab = screen.getByText("Research notes with a long title").closest('[role="treeitem"]');
    fireEvent.keyDown(otherTab!, { key: "Enter" });
    await waitFor(() => expect(getSessionStore().sessions[0].activeTab).toBe("tab-2"));
    expect(mocks.invoke).toHaveBeenCalledWith("set_active_tab", { sessionId: session.id, tabId: "tab-2" });
  });

  it("opens a workspace destination before a session exists", async () => {
    render(
      <TooltipProvider>
        <ProjectNavigation project={{ path: projectPath, name: "Raccoon" }} expanded />
      </TooltipProvider>,
    );

    const name = await screen.findByRole("button", { name: /Workspace quiet-amber-fox/ });
    fireEvent.keyDown(name, { key: "Enter" });

    await waitFor(() => {
      expect(getSessionStore().selectedSessionId).toBeNull();
      expect(getSessionStore().newSessionPreset).toEqual({ projectPath, cwd: workspacePath });
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("create_session", expect.anything());
  });
});
