import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, Workspace } from "@/types/session";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));

let sessions: typeof import("./sessions");

const projectPath = "/repos/raccoon";
const worktreePath = "/repos/raccoon/.raccoon/worktrees/issue-67";
const main: Workspace = {
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
const worktree: Workspace = {
  ...main,
  path: worktreePath,
  name: "issue-67",
  branch: "raccoon/issue-67",
  isMain: false,
  managed: true,
};
const attached: SessionEntry = {
  id: "session-67",
  projectPath,
  cwd: worktreePath,
  worktreeName: "issue-67",
  branch: "raccoon/issue-67",
  baseRef: "main",
  worktreeRemoved: false,
  title: "Fix stale workspace",
  created: "2026-09-04T00:00:00.000Z",
  modified: "2026-09-04T00:00:00.000Z",
  archived: false,
  pinned: false,
  tabs: [
    {
      id: "tab-with-transcript",
      harness: "codex",
      model: "gpt-5",
      permissionMode: "auto",
      status: "idle",
      created: "2026-09-04T00:00:00.000Z",
      modified: "2026-09-04T00:00:00.000Z",
    },
  ],
  activeTab: "tab-with-transcript",
};

beforeEach(async () => {
  vi.resetModules();
  mocks.listeners.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [{ path: projectPath, name: "Raccoon" }], lastSelected: projectPath };
    if (command === "list_sessions") return [attached];
    if (command === "list_harnesses") return [];
    if (command === "list_workspaces") return [main, worktree];
    throw new Error(`Unexpected command: ${command}`);
  });
  sessions = await import("./sessions");
  await sessions.bootSessions();
  await sessions.refreshWorkspaces(projectPath);
});

describe("worktree deletion events", () => {
  it("forgets sessions the backend deleted with their worktree and removes the cached workspace", async () => {
    expect(sessions.getSessionStore().workspaces[projectPath]).toEqual([main, worktree]);
    sessions.selectSession(attached.id);

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_workspaces") return [main];
      if (command === "list_harnesses") return [];
      throw new Error(`Unexpected command: ${command}`);
    });

    mocks.listeners.get("session_deleted")?.({ payload: attached.id });
    mocks.listeners.get("workspaces_changed")?.({ payload: projectPath });
    await vi.waitFor(() => expect(sessions.getSessionStore().workspaces[projectPath]).toEqual([main]));

    expect(sessions.getSessionStore().sessions).toEqual([]);
    expect(sessions.getSessionStore().selectedSessionId).toBeNull();
  });

  it("removes the sessions a workspace deletion returns and keeps the rest", async () => {
    const other: SessionEntry = { ...attached, id: "session-main", cwd: projectPath, worktreeName: null, branch: "main", title: "On main" };
    sessions.upsertSession(other);
    sessions.selectSession(other.id);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "delete_workspace") return [attached];
      if (command === "list_workspaces") return [main];
      if (command === "list_harnesses") return [];
      throw new Error(`Unexpected command: ${command}`);
    });

    await sessions.deleteWorkspace(projectPath, worktreePath, true);

    expect(mocks.invoke).toHaveBeenCalledWith("delete_workspace", { projectPath, path: worktreePath, deleteBranch: true });
    expect(sessions.getSessionStore().sessions.map((session) => session.id)).toEqual([other.id]);
    expect(sessions.getSessionStore().selectedSessionId).toBe(other.id);
    expect(sessions.getSessionStore().workspaces[projectPath]).toEqual([main]);
  });

  it("removes the cached workspace when no session was attached", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_sessions") return [];
      if (command === "list_workspaces") return [main];
      if (command === "list_harnesses") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    await sessions.refreshSessions();
    expect(sessions.getSessionStore().sessions).toEqual([]);

    mocks.listeners.get("workspaces_changed")?.({ payload: projectPath });
    await vi.waitFor(() => expect(sessions.getSessionStore().workspaces[projectPath]).toEqual([main]));
  });

  it("does not let an older refresh restore a workspace after deletion", async () => {
    let resolveOlder!: (workspaces: Workspace[]) => void;
    let resolveDeletion!: (workspaces: Workspace[]) => void;
    const older = new Promise<Workspace[]>((resolve) => {
      resolveOlder = resolve;
    });
    const deletion = new Promise<Workspace[]>((resolve) => {
      resolveDeletion = resolve;
    });
    mocks.invoke.mockImplementationOnce(() => older).mockImplementationOnce(() => deletion);

    const pendingOlder = sessions.refreshWorkspaces(projectPath);
    mocks.listeners.get("workspaces_changed")?.({ payload: projectPath });
    resolveDeletion([main]);
    await vi.waitFor(() => expect(sessions.getSessionStore().workspaces[projectPath]).toEqual([main]));

    resolveOlder([main, worktree]);
    await pendingOlder;
    expect(sessions.getSessionStore().workspaces[projectPath]).toEqual([main]);
  });
});
