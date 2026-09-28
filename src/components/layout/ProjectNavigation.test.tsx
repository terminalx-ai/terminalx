import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project, SessionEntry, Workspace } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { ProjectRail } = await import("./ProjectRail");
const store = await import("@/lib/sessions");
const terminals = await import("@/lib/terminal");
const { groupProjectWorkspaces } = await import("./SidebarTree");
const projects: Project[] = [{ path: "/alpha", name: "Alpha" }, { path: "/beta", name: "Beta" }];
const workspace = (path: string): Workspace => ({ path, name: path.slice(1), branch: "main", isMain: true, managed: false, head: "abc", additions: 0, deletions: 0, uncommitted: 0, unpushed: 0, ahead: 0, behind: 0 });
const makeSession = (id: string, projectPath = "/alpha"): SessionEntry => ({
  id, projectPath, cwd: projectPath, title: `Session ${id}`, created: "2026-09-05", modified: "2026-09-05", pinned: false, archived: false, worktreeRemoved: false, activeTab: `${id}-tab`,
  tabs: [{ id: `${id}-tab`, title: `Conversation ${id}`, harness: "codex", model: "", permissionMode: "auto", status: "idle", created: "", modified: "" }],
});
let sessions: SessionEntry[];
let workspaces: Record<string, Workspace[]>;

function mount(onOpenAgents = () => {}) {
  return render(<TooltipProvider><ProjectRail onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenIssues={() => {}} onOpenAgents={onOpenAgents} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /></TooltipProvider>);
}

beforeEach(async () => {
  sessions = [makeSession("one"), makeSession("two", "/beta")];
  workspaces = { "/alpha": [workspace("/alpha")], "/beta": [workspace("/beta")] };
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, string>) => {
    if (command === "list_projects") return { projects, lastSelected: "/alpha" };
    if (command === "list_sessions") return sessions;
    if (command === "list_workspaces") return workspaces[args!.projectPath] ?? [];
    if (command === "list_harnesses") return [];
    if (command === "set_active_tab" || command === "delete_session" || command === "pty_spawn" || command === "pty_kill") return;
    throw new Error(`Unexpected command: ${command}`);
  });
  await act(async () => {
    await store.refreshEverything();
    store.setShowArchived(false);
    store.clearNewSessionPreset();
    store.selectSession("one");
  });
});
afterEach(cleanup);

describe("complete navigation hierarchy", () => {
  it("shows all dashboard totals, including read completions and zero needs-you sessions", async () => {
    sessions = Array.from({ length: 11 }, (_, i) => {
      const entry = makeSession(`dashboard-${i}`, i % 2 ? "/alpha" : "/beta");
      entry.tabs[0].status = i < 2 ? "in_progress" : i === 2 ? "completed" : "idle";
      return entry;
    });
    await act(async () => { await store.refreshSessions(); });
    const openAgents = vi.fn();
    mount(openAgents);
    const row = screen.getByRole("button", { name: /Agent Dashboard/ });
    expect(row.textContent).toBe("Agent Dashboard029");
    for (const [label, color] of [["0 needs you", "warning"], ["2 working", "info"], ["9 done", "add"]]) {
      const badge = within(row).getByRole("img", { name: label });
      expect(badge.getAttribute("title")).toBe(label);
      expect(badge.className).toContain(`text-${color}`);
    }
    fireEvent.click(row);
    expect(openAgents).toHaveBeenCalledOnce();
  });

  it("keeps all zero totals visible", async () => {
    sessions = [];
    await act(async () => { await store.refreshSessions(); });
    mount();
    const row = screen.getByRole("button", { name: /Agent Dashboard/ });
    expect(within(row).getAllByRole("img").map((badge) => badge.getAttribute("aria-label")))
      .toEqual(["0 needs you", "0 working", "0 done"]);
  });

  it("updates totals from the live store through reads, status changes, navigation and eligibility changes", async () => {
    mount();
    const totals = () => within(screen.getByRole("button", { name: /Agent Dashboard/ }))
      .getAllByRole("img").map((badge) => badge.getAttribute("aria-label"));
    expect(totals()).toEqual(["0 needs you", "0 working", "2 done"]);
    act(() => store.patchTab("one", "one-tab", { status: "completed" }));
    expect(totals()).toEqual(["0 needs you", "0 working", "2 done"]);
    act(() => store.patchTab("one", "one-tab", { status: "idle" }));
    expect(totals()).toEqual(["0 needs you", "0 working", "2 done"]);
    act(() => store.patchTab("one", "one-tab", { status: "in_progress" }));
    expect(totals()).toEqual(["0 needs you", "1 working", "1 done"]);
    act(() => store.patchTab("one", "one-tab", { status: "waiting" }));
    expect(totals()).toEqual(["1 needs you", "0 working", "1 done"]);
    act(() => store.patchTab("one", "one-tab", { status: "completed" }));
    expect(totals()).toEqual(["0 needs you", "0 working", "2 done"]);
    await act(async () => { store.openAgents(); store.selectSession("two"); store.setShowArchived(true); });
    expect(totals()).toEqual(["0 needs you", "0 working", "2 done"]);
    act(() => store.patchSession("one", { archived: true }));
    expect(totals()).toEqual(["0 needs you", "0 working", "1 done"]);
    act(() => store.patchSession("one", { archived: false }));
    expect(totals()).toEqual(["0 needs you", "0 working", "2 done"]);
    act(() => store.removeSessions(["one"]));
    expect(totals()).toEqual(["0 needs you", "0 working", "1 done"]);
    act(() => store.upsertSession(makeSession("one")));
    expect(totals()).toEqual(["0 needs you", "0 working", "2 done"]);
    act(() => store.patchSession("one", { tabs: [] }));
    expect(totals()).toEqual(["0 needs you", "0 working", "1 done"]);
    await act(async () => { await store.refreshSessions(); });
    expect(totals()).toEqual(["0 needs you", "0 working", "2 done"]);
  });

  it("opens shell peers in the tree without exposing agent-owned panes", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Session one" }));
    let shellId = "";
    await act(async () => {
      shellId = (await terminals.openTerminal("one", "/alpha", 80, 24, { title: "Shell peer" })).id;
      await terminals.adoptPane({ id: "owned-test", sessionId: "one", title: "Agent PTY", hidden: true, owned: true });
    });
    const shell = screen.getByRole("treeitem", { name: "Shell peer", selected: true });
    expect(screen.queryByRole("treeitem", { name: "Agent PTY" })).toBeNull();
    shell.focus();
    fireEvent.keyDown(shell, { key: "ArrowUp" });
    const agent = screen.getByRole("treeitem", { name: "Conversation one" });
    expect(document.activeElement).toBe(agent);
    expect(terminals.getTerminalState().selected.one).toEqual({ kind: "terminal", id: shellId });
    await act(async () => fireEvent.keyDown(agent, { key: "Enter" }));
    expect(terminals.getTerminalState().selected.one).toEqual({ kind: "agent", id: "one-tab" });
    fireEvent.click(shell);
    expect(shell.getAttribute("aria-selected")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close Shell peer terminal tab" })));
    expect(screen.queryByRole("treeitem", { name: "Shell peer" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "Conversation one", selected: true })).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill", { id: shellId });
    expect(mocks.invoke).not.toHaveBeenCalledWith("pty_kill", { id: "owned-test" });
  });

  it("opens the clicked project while preserving another project's conversation", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(await screen.findByRole("button", { name: "Collapse Beta" })).toBeTruthy();
    expect(store.getSessionStore().selectedSessionId).toBe("one");
  });

  it("walks all four levels with arrows without activating destinations", async () => {
    mount();
    const alpha = screen.getByRole("button", { name: "Alpha" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("main");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Session one");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("Conversation one");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement?.textContent).toBe("Session one");
    expect(store.getSessionStore().selectedSessionId).toBe("one");
  });

  it("reveals a selected historical session whose checkout is absent", async () => {
    const missing = { ...makeSession("missing"), cwd: "/gone" };
    await act(async () => { store.upsertSession(missing); store.selectSession(missing.id); });
    mount();
    expect(await screen.findByRole("treeitem", { name: "Conversation missing", selected: true })).toBeTruthy();
  });

  it("keeps legacy removed sessions distinct from the operational main checkout", () => {
    const relocated = { ...makeSession("relocated"), worktreeRemoved: true };
    const groups = groupProjectWorkspaces("/alpha", [workspace("/alpha")], [relocated], false);
    expect(groups).toHaveLength(2);
    expect(groups[0].workspace?.isMain).toBe(true);
    expect(groups[0].sessions).toEqual([]);
    expect(groups[1].removed).toBe(true);
    expect(groups[1].sessions).toEqual([relocated]);
  });

  it("removes every session of a deleted workspace from the tree and drops the selection", async () => {
    const path = "/alpha/deleted";
    const doomed = [makeSession("one"), makeSession("other")].map((session) => ({ ...session, cwd: path }));
    const bystander = makeSession("kept");
    workspaces["/alpha"].push({ ...workspace(path), name: "deleted-feature", isMain: false, managed: true });
    await act(async () => { [...doomed, bystander].forEach(store.upsertSession); await store.refreshWorkspaces("/alpha"); });
    mount();
    expect(screen.getByRole("treeitem", { name: "deleted-feature" })).toBeTruthy();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "delete_workspace") return doomed;
      if (command === "list_workspaces") return [workspace("/alpha")];
      throw new Error(`Unexpected command: ${command}`);
    });
    await act(async () => store.deleteWorkspace("/alpha", path, false));
    expect(screen.queryByRole("treeitem", { name: "deleted-feature" })).toBeNull();
    expect(screen.queryByText("Session one")).toBeNull();
    expect(screen.queryByText("Session other")).toBeNull();
    expect(screen.queryByText("removed")).toBeNull();
    const main = within(screen.getByRole("treeitem", { name: "Alpha" })).getByRole("treeitem", { name: "main" });
    expect(within(main).getByText("Session kept")).toBeTruthy();
    expect(store.getSessionStore().sessions.map((session) => session.id)).toEqual(["two", "kept"]);
    expect(store.getSessionStore().selectedSessionId).toBeNull();
  });

  it("reopens the same selected session after its tabs were collapsed", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Session one" }));
    fireEvent.click(screen.getByRole("button", { name: "Session one" }));
    expect(await screen.findByRole("button", { name: "Collapse Session one" })).toBeTruthy();
  });

  it("updates navigation after live additions, title changes, and deletion", async () => {
    mount();
    const fresh = makeSession("fresh");
    await act(async () => { store.upsertSession(fresh); store.selectSession(fresh.id); });
    expect(await screen.findByText("Conversation fresh")).toBeTruthy();
    act(() => store.patchTab(fresh.id, fresh.tabs[0].id, { title: "Renamed conversation" }));
    expect(screen.queryByText("Conversation fresh")).toBeNull();
    expect(screen.getByText("Renamed conversation")).toBeTruthy();
    await act(async () => store.deleteSession(fresh.id, false));
    expect(screen.queryByText("Renamed conversation")).toBeNull();
    expect(within(screen.getByRole("tree")).getByRole("button", { name: "Session one" })).toBeTruthy();
  });

  it("lets every branch collapse without being reopened by status updates", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Session one" }));
    expect(screen.queryByRole("treeitem", { name: "Conversation one" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse main" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Alpha" }));
    act(() => store.patchTab("one", "one-tab", { status: "waiting" }));
    expect(screen.getByRole("button", { name: "Expand Alpha" })).toBeTruthy();
    expect(store.getSessionStore().selectedSessionId).toBe("one");
    fireEvent.click(screen.getByRole("button", { name: "Expand Alpha" }));
    expect(screen.getByRole("button", { name: "Expand main" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand main" }));
    expect(screen.getByRole("button", { name: "Expand Session one" })).toBeTruthy();
  });

  it("keeps an archived destination reachable when selected externally", async () => {
    await act(async () => {
      store.patchSession("two", { archived: true });
      store.selectSession("two");
    });
    mount();
    expect(await screen.findByRole("treeitem", { name: "Conversation two", selected: true })).toBeTruthy();
    expect(screen.getByLabelText("Archived session")).toBeTruthy();
  });

  it("does not activate a tab when Enter is pressed on its close button", async () => {
    const extra = { ...sessions[1], tabs: [...sessions[1].tabs, { ...sessions[1].tabs[0], id: "extra", title: "Extra" }] };
    await act(async () => store.upsertSession(extra));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Expand Beta" }));
    const beta = screen.getByRole("treeitem", { name: "Beta" });
    fireEvent.click(within(beta).getByRole("button", { name: "Expand main" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Session two" }));
    const close = screen.getByRole("button", { name: "Close Extra" });
    close.focus();
    fireEvent.keyDown(close, { key: "Enter" });
    expect(store.getSessionStore().selectedSessionId).toBe("one");
  });

  it("follows a renamed pre-session workspace and falls back to main after deletion", async () => {
    const managed = { ...workspace("/alpha/old"), name: "old", isMain: false, managed: true };
    workspaces["/alpha"].push(managed);
    await act(async () => { await store.refreshWorkspaces("/alpha"); store.startSessionIn("/alpha", managed.path); });
    mount();
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, string>) => {
      if (command === "rename_workspace") {
        workspaces["/alpha"][1] = { ...managed, name: "renamed", path: "/alpha/renamed" };
        return { name: "renamed", path: "/alpha/renamed", branch: "renamed", sessions: [] };
      }
      if (command === "list_workspaces") return [...workspaces[args!.projectPath]];
      if (command === "delete_workspace") { workspaces["/alpha"] = [workspace("/alpha")]; return []; }
      throw new Error(`Unexpected command: ${command}`);
    });
    await act(async () => store.renameWorkspace("/alpha", managed.path, "renamed"));
    expect(store.getSessionStore().newSessionPreset?.cwd).toBe("/alpha/renamed");
    expect(screen.getByRole("button", { name: /Workspace renamed/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Workspace old/ })).toBeNull();
    await act(async () => store.deleteWorkspace("/alpha", "/alpha/renamed", false));
    expect(screen.queryByRole("button", { name: /Workspace renamed/ })).toBeNull();
    expect(store.getSessionStore().newSessionPreset?.cwd).toBe("/alpha");
  });
});


it("opens an empty folder from the project rail and shows folder navigation", async () => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(open).mockResolvedValue("/tmp/empty-folder");
  const folder: Project = { path: "/tmp/empty-folder", name: "empty-folder", kind: "folder" };
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, string>) => {
    if (cmd === "add_project") return folder;
    if (cmd === "list_workspaces" && args?.projectPath === folder.path) return [{ ...workspace(folder.path), branch: null, head: null }];
    return original(cmd, args);
  });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));
  await screen.findByText("folder", { selector: "span" });
  expect(mocks.invoke).toHaveBeenCalledWith("add_project", { path: folder.path });
  expect(store.getSessions().selectedProject).toBe(folder.path);
  expect(store.getSessions().projects.find((p) => p.path === folder.path)?.kind).toBe("folder");
});
