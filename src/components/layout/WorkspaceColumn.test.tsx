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
const { bootSessions, getSessionStore } = await import("@/lib/sessions");

const projectPath = "/repos/raccoon";
const externalPath = "/tmp/raccoon-external";
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
  it("opens an external workspace when its name is clicked", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_projects") {
        return { projects: [{ path: projectPath, name: "Raccoon", pinned: false, archived: false }], lastSelected: projectPath };
      }
      if (command === "list_sessions" || command === "list_harnesses") return [];
      if (command === "list_workspaces") return [workspace];
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
