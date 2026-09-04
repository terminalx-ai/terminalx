import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionEntry, Workspace } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

const { WorkspaceColumn } = await import("./WorkspaceColumn");
const { bootSessions, deleteWorkspace, getSessionStore } = await import("@/lib/sessions");

const projectPath = "/repos/raccoon";
const externalPath = "/tmp/raccoon-external";
const deletedPath = "/repos/.raccoon/worktrees/deleted-feature";
const mainWorkspace: Workspace = {
  path: projectPath,
  name: "raccoon",
  branch: "main",
  head: "abc1234",
  isMain: true,
  managed: false,
  uncommitted: 0,
  additions: 0,
  deletions: 0,
  unpushed: 0,
  ahead: 0,
  behind: 0,
};
const workspace: Workspace = {
  path: externalPath,
  name: "raccoon-external",
  branch: "feature/external",
  head: "abc1234",
  isMain: false,
  managed: false,
  uncommitted: 1,
  additions: 3,
  deletions: 1,
  unpushed: 0,
  ahead: 0,
  behind: 0,
};
const deletedWorkspace: Workspace = {
  ...workspace,
  path: deletedPath,
  name: "deleted-feature",
  branch: "raccoon/deleted-feature",
  managed: true,
};
const opened: SessionEntry = {
  id: "workspace-session",
  projectPath,
  cwd: externalPath,
  worktreeName: null,
  branch: "feature/external",
  baseRef: null,
  worktreeRemoved: false,
  title: "feature/external",
  created: "2026-09-03T00:00:00.000Z",
  modified: "2026-09-03T00:00:00.000Z",
  archived: false,
  pinned: false,
  tabs: [],
  activeTab: null,
};

afterEach(() => cleanup());

describe("WorkspaceColumn", () => {
  it("keeps deleted-worktree sessions out of main while preserving every transcript", async () => {
    const removedSessions: SessionEntry[] = [
      {
        ...opened,
        id: "removed-selected",
        cwd: projectPath,
        worktreeName: null,
        branch: "main",
        worktreeRemoved: true,
        removedWorkspace: {
          path: deletedPath,
          name: "deleted-feature",
          branch: "raccoon/deleted-feature",
        },
        title: "Selected removed session",
      },
      {
        ...opened,
        id: "removed-other",
        cwd: projectPath,
        worktreeName: null,
        branch: "main",
        worktreeRemoved: true,
        removedWorkspace: {
          path: deletedPath,
          name: "deleted-feature",
          branch: "raccoon/deleted-feature",
        },
        title: "Other removed session",
      },
      {
        ...opened,
        id: "removed-legacy",
        cwd: projectPath,
        worktreeName: null,
        branch: "main",
        worktreeRemoved: true,
        title: "Legacy removed session",
      },
    ];
    const activeSessions = removedSessions.slice(0, 2).map((session, index) => ({
      ...session,
      cwd: deletedPath,
      worktreeName: index === 0 ? "deleted-feature" : null,
      branch: "raccoon/deleted-feature",
      worktreeRemoved: false,
      removedWorkspace: null,
    }));
    let deleted = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_projects") {
        return { projects: [{ path: projectPath, name: "Raccoon", pinned: false, archived: false }], lastSelected: projectPath };
      }
      if (command === "list_sessions") return [...activeSessions, removedSessions[2]];
      if (command === "list_harnesses") return [];
      if (command === "list_workspaces") return deleted ? [mainWorkspace, workspace] : [mainWorkspace, deletedWorkspace, workspace];
      if (command === "select_session") return undefined;
      if (command === "delete_workspace") {
        deleted = true;
        return removedSessions.slice(0, 2);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => bootSessions());
    render(
      <TooltipProvider>
        <WorkspaceColumn projectPath={projectPath} onNewSession={() => {}} />
      </TooltipProvider>,
    );
    await screen.findByRole("button", { name: "Collapse main" });
    fireEvent.click(screen.getByText("Selected removed session"));
    await act(async () => deleteWorkspace(projectPath, deletedPath, false));

    const mainGroup = screen.getByRole("button", { name: "Collapse main" }).closest(".mb-1\\.5");
    expect(mainGroup?.textContent).not.toContain("Selected removed session");
    expect(mainGroup?.textContent).not.toContain("Other removed session");
    expect(mainGroup?.textContent).not.toContain("Legacy removed session");
    const removedGroup = screen.getByRole("button", { name: "Collapse deleted-feature" }).closest(".mb-1\\.5");
    expect(removedGroup?.textContent).toContain("Selected removed session");
    expect(removedGroup?.textContent).toContain("Other removed session");
    const legacyGroup = screen.getByRole("button", { name: "Collapse Removed workspace" }).closest(".mb-1\\.5");
    expect(legacyGroup?.textContent).toContain("Legacy removed session");
    expect(getSessionStore().selectedSessionId).toBe("removed-selected");
  });

  it("opens an external workspace when its name is clicked", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_projects") {
        return { projects: [{ path: projectPath, name: "Raccoon", pinned: false, archived: false }], lastSelected: projectPath };
      }
      if (command === "list_sessions" || command === "list_harnesses") return [];
      if (command === "list_workspaces") return [mainWorkspace, workspace];
      if (command === "create_session") return opened;
      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => bootSessions());
    render(
      <TooltipProvider>
        <WorkspaceColumn projectPath={projectPath} onNewSession={() => {}} />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "feature/external" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("create_session", {
        req: { projectPath, cwd: externalPath, useWorktree: false },
      });
      expect(getSessionStore().selectedSessionId).toBe(opened.id);
      expect(getSessionStore().sessions).toContainEqual(opened);
    });
  });
});
