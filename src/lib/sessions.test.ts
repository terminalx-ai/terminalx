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
      if (command === "remove_workspace") return { sessions: [attached], keptBranch: null, rescuedBranch: null };
      if (command === "list_workspaces") return [main];
      if (command === "list_harnesses") return [];
      throw new Error(`Unexpected command: ${command}`);
    });

    await sessions.removeWorkspace(projectPath, worktreePath, { keepSessions: false, deleteBranch: true, confirmedDigest: null, expectedSessions: [] });

    expect(mocks.invoke).toHaveBeenCalledWith("remove_workspace", { projectPath, path: worktreePath, keepSessions: false, deleteBranch: true, confirmedDigest: null, expectedSessions: [] });
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

describe("cloud workspace selection (PRO-58)", () => {
  it("shows a cloud workspace until another session or view is chosen", () => {
    sessions.selectCloudWorkspace("cloud:org-a:ws-1");
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe("cloud:org-a:ws-1");
    expect(sessions.getSessionStore().selectedSessionId).toBeNull();
    sessions.openIssues();
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBeNull();
    sessions.selectCloudWorkspace("cloud:org-a:ws-1");
    sessions.selectSession(null);
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBeNull();
    sessions.selectCloudWorkspace("cloud:org-a:ws-1");
    // Focusing a local project in the sidebar is not navigation away.
    sessions.selectProjectInSidebar(null);
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe("cloud:org-a:ws-1");
  });
});

describe("a session's terminals", () => {
  async function withTerminals() {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (["pty_spawn", "pty_kill", "list_harnesses"].includes(command)) return command === "list_harnesses" ? [] : undefined;
      if (command === "list_workspaces") return [main, worktree];
      throw new Error(`Unexpected command: ${command}`);
    });
    const terminal = await import("./terminal");
    const shell = await terminal.openTerminal(attached.id, worktreePath);
    await terminal.adoptPane({ id: "tab:tab-with-transcript", sessionId: attached.id, title: "Agent", hidden: true, owned: true });
    const other = await terminal.openTerminal("another-session", projectPath);
    const killed = () => mocks.invoke.mock.calls.filter(([command]) => command === "pty_kill").map(([, args]) => (args as { id: string }).id);
    const panes = () => terminal.getTerminalState().panes.map((pane) => pane.id);
    return { shell, other, killed, panes };
  }

  it("are closed when the backend says the session was deleted", async () => {
    const { shell, other, killed, panes } = await withTerminals();
    mocks.listeners.get("session_deleted")?.({ payload: attached.id });
    expect(panes()).toEqual([other.id]);
    expect(killed().sort()).toEqual([shell.id, "tab:tab-with-transcript"].sort());
  });

  it("lose the shells, and keep the agent's pane, when the session's worktree is removed", async () => {
    const { shell, other, killed, panes } = await withTerminals();
    mocks.listeners.get("session_updated")?.({ payload: { ...attached, worktreeRemoved: true } });
    await vi.waitFor(() => expect(panes()).toEqual(["tab:tab-with-transcript", other.id]));
    expect(killed()).toEqual([shell.id]);
    // Said again (any later update of the same session): nothing more to close.
    mocks.listeners.get("session_updated")?.({ payload: { ...attached, worktreeRemoved: true, title: "Renamed" } });
    await Promise.resolve();
    expect(killed()).toEqual([shell.id]);
  });
});

describe("an agent tab's terminal", () => {
  async function withAgentPane() {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_workspaces") return [main, worktree];
      if (command === "list_harnesses") return [];
      if (command === "remove_tab") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    const terminal = await import("./terminal");
    await terminal.adoptPane({ id: "tab:tab-with-transcript", sessionId: attached.id, title: "Agent", hidden: true, owned: true });
    const dispose = vi.fn();
    terminal.getInstance("tab:tab-with-transcript", () => ({ el: document.createElement("div"), term: { write: vi.fn(), dispose }, fit: {} }) as never);
    return { terminal, dispose };
  }

  it("is dropped when the tab is closed here", async () => {
    const { terminal, dispose } = await withAgentPane();
    await sessions.removeTab(attached.id, "tab-with-transcript");
    await Promise.resolve();
    expect(sessions.getSessionStore().sessions[0].tabs).toEqual([]);
    expect(terminal.getTerminalState().panes).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is dropped when the backend says the session no longer has the tab", async () => {
    const { terminal, dispose } = await withAgentPane();
    mocks.listeners.get("session_updated")?.({ payload: { ...attached, tabs: [], activeTab: null } });
    await Promise.resolve();
    expect(terminal.getTerminalState().panes).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is kept through an update that keeps the tab", async () => {
    const { terminal, dispose } = await withAgentPane();
    mocks.listeners.get("session_updated")?.({ payload: { ...attached, title: "Renamed" } });
    await Promise.resolve();
    expect(terminal.getTerminalState().panes.map((pane) => pane.id)).toEqual(["tab:tab-with-transcript"]);
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe("a refreshed session list", () => {
  it("drops the terminals of the tabs and sessions that are no longer in it", async () => {
    const other: SessionEntry = { ...attached, id: "other-session", tabs: [], activeTab: null };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_workspaces") return [main, worktree];
      if (command === "list_harnesses" ) return [];
      if (command === "pty_spawn" || command === "pty_kill") return undefined;
      // The tab was closed and the other session deleted somewhere this window heard nothing of.
      if (command === "list_sessions") return [{ ...attached, tabs: [], activeTab: null }];
      throw new Error(`Unexpected command: ${command}`);
    });
    sessions.upsertSession(other);
    const terminal = await import("./terminal");
    await terminal.adoptPane({ id: "tab:tab-with-transcript", sessionId: attached.id, title: "Agent", hidden: true, owned: true });
    const kept = await terminal.openTerminal(attached.id, worktreePath);
    await terminal.openTerminal(other.id, projectPath);

    await sessions.refreshSessions();
    await Promise.resolve();

    expect(terminal.getTerminalState().panes.map((pane) => pane.id)).toEqual([kept.id]);
  });
});
