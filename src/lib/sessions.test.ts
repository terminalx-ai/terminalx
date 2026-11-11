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

describe("new chat", () => {
  it("creates an ordinary session in Chats on send, without the disposable quick-chat kind", async () => {
    const chatsPath = "/Users/me/.raccoon/Chats";
    const chat: SessionEntry = { ...attached, id: "ordinary-chat", projectPath: chatsPath, cwd: chatsPath, branch: null, worktreeName: null };
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "chats_dir" ? Promise.resolve(chatsPath)
      : command === "create_session" ? Promise.resolve(chat) : original(command, args));
    const tab = { harness: "codex", model: "gpt-6-astra", effort: "high", permissionMode: "bypassPermissions" };
    const saved = await sessions.createChat({ title: "Keep this chat", tab });
    expect(mocks.invoke).toHaveBeenCalledWith("create_session", { req: { projectPath: chatsPath, cwd: chatsPath, title: "Keep this chat", useWorktree: false, tab } });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_quick_chat" || command === "add_project")).toBe(false);
    expect(saved.kind).toBeUndefined();
    expect(sessions.getSessionStore().chatsPath).toBe(chatsPath);
    expect(sessions.getSessionStore().sessions).toContainEqual(chat);
  });

  it("keeps a chosen folder and personal section when creating an ordinary chat", async () => {
    const chatsPath = "/Users/me/.raccoon/Chats";
    const chat = { ...attached, projectPath: chatsPath, cwd: "/notes" };
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "chats_dir" ? Promise.resolve(chatsPath)
      : command === "create_session" ? Promise.resolve(chat) : original(command, args));
    await sessions.createChat({ title: "Keep my notes", cwd: "/notes", sectionId: "release" });
    expect(mocks.invoke).toHaveBeenCalledWith("create_session", { req: {
      projectPath: chatsPath, cwd: "/notes", title: "Keep my notes", sectionId: "release", useWorktree: false, tab: undefined,
    } });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_quick_chat" || command === "add_project")).toBe(false);
  });

  it("resolves a removed conversation's project before opening its branch composer", async () => {
    const removed = "/repos/removed";
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "add_project"
      ? Promise.resolve({ path: removed, name: "removed", kind: "git" }) : original(command, args));
    await sessions.startChat({ projectPath: removed, cwd: `${removed}/worktrees/task` });
    expect(mocks.invoke).toHaveBeenCalledWith("add_project", { path: removed });
    expect(sessions.getSessionStore().projects.some((p) => p.path === removed)).toBe(true);
    expect(sessions.getSessionStore().newSessionPreset).toEqual({ projectPath: removed, cwd: `${removed}/worktrees/task` });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
  });

  it("keeps the existing conversation selected when its removed project cannot be resolved", async () => {
    sessions.selectSession(attached.id);
    await expect(sessions.startChat({ projectPath: "/gone", fromBranch: "feature/login" })).rejects.toThrow();
    expect(sessions.getSessionStore()).toMatchObject({ selectedSessionId: attached.id, newSessionPreset: null });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
  });

  it("opens the shared composer without creating a session or scratch folder, even with no agents", async () => {
    sessions.selectSession(attached.id);
    mocks.invoke.mockClear();
    await sessions.startChat();
    expect(sessions.getSessionStore()).toMatchObject({ view: "new", selectedSessionId: null, newSessionChat: true, newSessionReturn: { sessionId: attached.id } });
    expect(sessions.getSessionStore().sessions).toEqual([attached]);
    expect(mocks.invoke.mock.calls.some(([command]) => ["create_session", "create_quick_chat", "chats_dir", "add_project"].includes(command))).toBe(false);
    sessions.closeNewSession();
    expect(sessions.getSessionStore()).toMatchObject({ selectedSessionId: attached.id, newSessionChat: false });
  });

  it("switches between project and project-less destinations without starting anything", async () => {
    mocks.invoke.mockClear();
    await sessions.startChat();
    sessions.startSessionIn(projectPath, null);
    expect(sessions.getSessionStore()).toMatchObject({ view: "new", newSessionChat: false, newSessionPreset: { projectPath, cwd: null } });
    await sessions.startChat();
    expect(sessions.getSessionStore()).toMatchObject({ newSessionChat: true, newSessionPreset: null, cloudSessionPreset: null });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
  });

  it("keeps the project branch or checkout as an unsent composer destination", async () => {
    await sessions.startChat({ projectPath, fromBranch: "feature/login" });
    expect(sessions.getSessionStore()).toMatchObject({ view: "new", newSessionChat: false, newSessionPreset: { projectPath, cwd: null, fromBranch: "feature/login" } });
    await sessions.startChat({ projectPath, cwd: worktreePath });
    expect(sessions.getSessionStore().newSessionPreset).toEqual({ projectPath, cwd: worktreePath });
    expect(sessions.getSessionStore().sessions).toEqual([attached]);
  });
});

describe("resting navigation", () => {
  it("boots at welcome and keeps explicit creation and deep links", () => {
    expect(sessions.getSessionStore().view).toBe("welcome");
    sessions.selectSession(null);
    expect(sessions.getSessionStore().view).toBe("new");
    sessions.startSessionIn(projectPath, worktreePath);
    expect(sessions.getSessionStore().newSessionPreset).toEqual({ projectPath, cwd: worktreePath });
    sessions.openTarget({ sessionId: attached.id, tabId: attached.tabs[0].id });
    expect(sessions.getSessionStore().selectedSessionId).toBe(attached.id);
  });

  it("returns to welcome when the selection is deleted or archived", () => {
    sessions.selectSession(attached.id);
    sessions.patchSession(attached.id, { archived: true });
    expect(sessions.getSessionStore()).toMatchObject({ view: "welcome", selectedSessionId: null });
    sessions.selectSession(attached.id);
    sessions.removeSessions([attached.id]);
    expect(sessions.getSessionStore()).toMatchObject({ view: "welcome", selectedSessionId: null });
  });

  it("handles background deletion during refresh", async () => {
    sessions.selectSession(attached.id);
    mocks.invoke.mockResolvedValueOnce([]);
    await sessions.refreshSessions();
    expect(sessions.getSessionStore()).toMatchObject({ view: "welcome", selectedSessionId: null });
  });

  it("keeps a replacement selection and unrelated destinations", () => {
    const other = { ...attached, id: "other" };
    sessions.upsertSession(other);
    sessions.selectSession(other.id);
    sessions.removeSessions([attached.id]);
    expect(sessions.getSessionStore().selectedSessionId).toBe(other.id);
    sessions.openIssues();
    sessions.patchSession(other.id, { archived: true });
    expect(sessions.getSessionStore().view).toBe("issues");
    sessions.selectSession(null);
    sessions.removeSessions([other.id]);
    expect(sessions.getSessionStore().view).toBe("new");
  });
});

it("retains newer message time when delayed metadata events and refreshes arrive", async () => {
  const latest = "2026-10-05T00:00:00Z";
  mocks.listeners.get("session_updated")?.({ payload: { ...attached, lastMessageAt: latest } });
  mocks.listeners.get("session_updated")?.({ payload: { ...attached, title: "Renamed", lastMessageAt: "2026-10-02T00:00:00Z" } });
  expect(sessions.getSessionStore().sessions[0]).toMatchObject({ title: "Renamed", lastMessageAt: latest });
  await sessions.refreshSessions();
  expect(sessions.getSessionStore().sessions[0].lastMessageAt).toBe(latest);
});

it.each([true, false])("retains boot backfill activity across a stale list (verified timestamps: %s)", async (verified) => {
  vi.resetModules();
  mocks.listeners.clear();
  sessions = await import("./sessions");
  let resolveList!: (entries: SessionEntry[]) => void;
  const pending = new Promise<SessionEntry[]>((resolve) => { resolveList = resolve; });
  const initial = { ...attached, lastMessageAt: verified ? "2026-10-02T00:00:00Z" : undefined };
  const newer = { ...attached, lastMessageAt: verified ? "2026-10-05T00:00:00Z" : undefined, hasMessages: true };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [{ path: projectPath, name: "Synthetic" }], lastSelected: projectPath };
    if (command === "list_sessions") {
      expect(mocks.listeners.has("session_updated")).toBe(true);
      mocks.listeners.get("session_updated")!({ payload: newer });
      // A delayed older backfill event must not displace the newest one.
      mocks.listeners.get("session_updated")!({ payload: initial });
      return pending;
    }
    if (command === "list_harnesses") return [];
    if (command === "list_workspaces") return [main, worktree];
    return undefined;
  });
  const boot = sessions.bootSessions();
  await vi.waitFor(() => expect(mocks.listeners.has("session_updated")).toBe(true));
  expect(sessions.getSessionStore()).toMatchObject({ loaded: false, sessions: [], selectedSessionId: null });
  resolveList([initial]);
  await boot;
  expect(sessions.getSessionStore()).toMatchObject({ loaded: true, selectedSessionId: null });
  expect(sessions.getSessionStore().sessions[0]).toEqual(newer);
  // The same listener continues normal updates after initialization.
  mocks.listeners.get("session_updated")!({ payload: { ...initial, title: "Synthetic rename" } });
  expect(sessions.getSessionStore().sessions[0]).toMatchObject({ title: "Synthetic rename", lastMessageAt: newer.lastMessageAt, hasMessages: true });
});

describe("a new live connection", () => {
  const reads = ["list_projects", "list_sessions", "list_harnesses", "list_workspaces", "chats_dir"];

  it("re-reads the sessions, projects and checkouts the gap hid, and sends nothing", async () => {
    const renamed = { ...attached, title: "Renamed while disconnected" };
    const added = { path: "/repos/other", name: "Other" };
    mocks.invoke.mockClear();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_projects") return { projects: [{ path: projectPath, name: "Raccoon" }, added], lastSelected: projectPath };
      if (command === "list_sessions") return [renamed];
      if (command === "list_harnesses") return [];
      if (command === "list_workspaces") return [main];
      throw new Error(`Unexpected command: ${command}`);
    });
    mocks.listeners.get("local_runtime_reattached")!({ payload: { generation: 2 } });
    await vi.waitFor(() => expect(sessions.getSessionStore().workspaces[projectPath]).toEqual([main]));
    const store = sessions.getSessionStore();
    expect(store.sessions.map((session) => session.title)).toEqual(["Renamed while disconnected"]);
    expect(store.projects.map((project) => project.path)).toEqual([projectPath, added.path]);
    expect(mocks.invoke.mock.calls.every(([command]) => reads.includes(command))).toBe(true);
  });

  it("loads the index of a window that opened while the runtime was out of reach", async () => {
    vi.resetModules();
    mocks.listeners.clear();
    const working = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, ...rest: unknown[]) => {
      if (command === "list_sessions") throw new Error("local runtime event connection is closed");
      return working(command, ...rest);
    });
    const fresh = await import("./sessions");
    await expect(fresh.bootSessions()).rejects.toThrow("connection is closed");
    expect(fresh.getSessionStore().loaded).toBe(false);
    expect(mocks.listeners.has("session_deleted")).toBe(false);
    mocks.invoke.mockImplementation(working);
    mocks.listeners.get("local_runtime_reattached")!({ payload: { generation: 1 } });
    await vi.waitFor(() => expect(fresh.getSessionStore().loaded).toBe(true));
    expect(fresh.getSessionStore().sessions.map((session) => session.id)).toEqual([attached.id]);
    // And it hears of later changes from then on.
    mocks.listeners.get("session_deleted")!({ payload: attached.id });
    expect(fresh.getSessionStore().sessions).toEqual([]);
  });
});

describe("Home navigation (PRO-183)", () => {
  it.each([
    "session", "cloud session", "cloud workspace", "draft", "issues", "automation", "closed workspace",
  ])("leaves the %s for Home and preserves projects and sessions", (from) => {
    if (from === "session") sessions.selectSession(attached.id);
    if (from === "cloud session") sessions.selectCloudSession("cloud:org-a:ws-1:session-1");
    if (from === "cloud workspace") sessions.selectCloudWorkspace("cloud:org-a:ws-1");
    if (from === "draft") sessions.startSessionIn(projectPath, worktreePath);
    if (from === "issues") sessions.openIssues();
    if (from === "automation") sessions.openAutomation("automation-1");
    if (from === "closed workspace") sessions.openWelcome(attached.id);
    const before = sessions.getSessionStore();

    sessions.openHome();

    expect(sessions.getSessionStore()).toMatchObject({
      view: "home", selectedSessionId: null, selectedCloudWorkspace: null,
      selectedAutomationId: null, closedWorkspaceSessionId: null,
      newSessionPreset: null, cloudSessionPreset: null, newSessionReturn: null,
      projects: before.projects, sessions: before.sessions,
    });
    sessions.selectSession(attached.id);
    expect(sessions.getSessionStore().selectedSessionId).toBe(attached.id);
  });

  it("returns to Home when a new-session draft opened there is cancelled", () => {
    sessions.openHome();
    sessions.openNewSession();
    sessions.closeNewSession();
    expect(sessions.getSessionStore().view).toBe("home");
  });
});

it("requests Start from only for that new-session navigation", () => {
  sessions.openNewSession(true);
  const first = sessions.getSessionStore().startFromRequest;
  expect(first).toBeGreaterThan(0);
  sessions.openNewSession(true);
  expect(sessions.getSessionStore().startFromRequest).toBeGreaterThan(first);
  sessions.openIssues();
  expect(sessions.getSessionStore()).toMatchObject({ view: "issues", startFromRequest: 0 });
  sessions.openNewSession();
  expect(sessions.getSessionStore().startFromRequest).toBe(0);
});
