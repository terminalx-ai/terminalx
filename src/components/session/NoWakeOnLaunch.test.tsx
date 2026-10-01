import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient, type WorkspaceConnectionState, type WorkspaceTransport } from "@terminalx/portable/workspace";
import type { RpcWireRequest } from "@terminalx/portable/rpc";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import type { Project, SessionEntry, Workspace } from "@/types/session";
import { mouseClick } from "@/test/press";

// Looking never wakes compute. The app launches with a stopped cloud session
// selected; opening and closing the header's "+" menu (Escape, a press
// outside, the window losing focus) and collapsing an organization in the
// sidebar must not resume, wake or activate the workspace, nor send anything.
// Only choosing the menu's "Terminal: wakes the workspace" wakes it, once.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  status: null as unknown as AccountStatus,
  resume: vi.fn(),
  workspaceConnection: vi.fn(),
  createCloudTerminal: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set() }));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="xterm">{id}</div>, createTerminal: vi.fn() }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));
vi.mock("@/lib/models", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/models")>()), useModels: () => [], loadModels: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: { ...original.api, cloudWorkspaceResume: mocks.resume, cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn(), cloudAgentPurgeWorkspace: vi.fn() },
    workspaceConnection: mocks.workspaceConnection,
    hasWorkspaceConnection: () => true,
    closeWorkspaceConnection: vi.fn(),
  };
});
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
  bootAccount: vi.fn(),
}));
vi.mock("@/lib/cloudConnections", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cloudConnections")>();
  return { ...original, wakeCloudConnection: vi.fn(original.wakeCloudConnection), retainCloudConnection: vi.fn(original.retainCloudConnection) };
});
vi.mock("@/lib/cloudTerminals", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cloudTerminals")>();
  return { ...original, createCloudTerminal: mocks.createCloudTerminal };
});

const { ProjectRail } = await import("@/components/layout/ProjectRail");
const { CloudSessionHost } = await import("./CloudSessionHost");
const prefs = await import("@/lib/prefs");
const sessions = await import("@/lib/sessions");
const catalog = await import("@/lib/cloudCatalog");
const connections = await import("@/lib/cloudConnections");
const sessionBackend = await import("@/lib/sessionBackend");
const { resetCloudAgents } = await import("@/lib/cloudAgents");
const { resetCloudSessions } = await import("@/lib/cloudSessions");
const { resetCloudTerminals } = await import("@/lib/cloudTerminals");
const { cloudSessionKey } = await import("@/types/target");

const ORG = "org-a";
const WS = "ws-1";
const KEY = cloudSessionKey(ORG, WS, "s1");
const projectPath = "/repos/raccoon";
const workspace: Workspace = {
  path: projectPath, name: "raccoon", branch: "main", head: "abc1234", isMain: true, managed: false,
  uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0,
};
const projects: Project[] = [{ path: projectPath, name: "Raccoon" }];
const localSessions: SessionEntry[] = [];
const acmeApi = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
const stoppedItem = {
  workspace: { id: WS, orgId: ORG, name: "demo workspace", provider: "box", state: "suspended", accessMode: "organization", authority: "manage", createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [acmeApi] },
  latestOperation: null,
} as unknown as CloudWorkspaceListItem;
const cloudSession = {
  id: "s1", projectPath: "/workspace", cwd: "/workspace", title: "Check the current data", created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T11:00:00.000Z", archived: false, pinned: false,
  tabs: [{ id: "t1", harness: "claude", title: null, model: "opus", permissionMode: "default", status: "idle", created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
};
const cachedTab = {
  tab: {
    sessionId: "s1", tabId: "t1", title: "Check the current data", harness: "claude", model: "", effort: null, permissionMode: "bypassPermissions",
    status: "idle", process: "running", pendingPermissions: [], followUps: [], lastSeq: 1, created: "2026-09-30T10:00:00Z", modified: "2026-09-30T10:00:00Z",
  },
  events: [{ id: "e1", seq: 1, sessionId: "s1", tabId: "t1", harness: "claude", ts: "2026-09-30T10:00:00Z", payload: { type: "user_message", text: "check the current data", queued: false } }],
  cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1,
};

/** A workspace runtime that is stopped until something wakes it. */
class StoppedRuntime implements WorkspaceTransport {
  up = false;
  private states = new Set<(state: WorkspaceConnectionState) => void>();
  send(_frame: RpcWireRequest) {
    return this.up && false;
  }
  onMessage() {
    return () => undefined;
  }
  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
  close() {}
  emit(state: WorkspaceConnectionState) {
    this.up = state.state === "connected";
    for (const listener of this.states) listener(state);
  }
}

let runtime: StoppedRuntime;
let client: WorkspaceRpcClient;
const activate = vi.fn(async (_activation: string) => undefined);
const commands = () => mocks.invoke.mock.calls.map((call) => String(call[0]));

beforeAll(async () => {
  mocks.status = {
    state: "signed-in",
    identity: { name: "Ada", email: "ada@example.com", organization: "Demo New TerminalX", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "scope", revision: "scope:1" },
    multiOrg: true,
    organizations: [
      { id: ORG, name: "Demo New TerminalX", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: "org-b", name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ],
  } as AccountStatus;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects, lastSelected: projectPath };
    if (command === "list_sessions") return localSessions;
    if (command === "list_harnesses") return [{ id: "claude", name: "Claude", available: true }];
    if (command === "list_workspaces") return [workspace];
    if (command === "list_automations") return [];
    if (command === "cloud_agent_cache_load") return { tabs: { t1: cachedTab } };
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints") return [];
    return null;
  });
  await act(async () => {
    await sessions.bootSessions();
    await sessions.refreshEverything();
  });
});

beforeEach(async () => {
  prefs.setPrefs({ cloudSidebar: true, cloudProjects: {}, cloudBlankProjects: {}, cloudPinned: {}, cloudCollapsed: {}, sidebarSections: {} });
  await act(async () => {
    await catalog.ingestCloudList({ workspaces: [stoppedItem], quota: { used: 0, limit: 2 } }, ORG);
    await catalog.ingestCloudList({ workspaces: [], quota: { used: 0, limit: 2 } }, "org-b");
  });
  catalog.cacheCloudSessions(ORG, WS, [cloudSession] as never, ["session/2"]);
  runtime = new StoppedRuntime();
  client = new WorkspaceRpcClient(runtime);
  activate.mockReset();
  activate.mockImplementation(async (activation: string) => {
    // The runtime comes back only for a wake.
    if (activation === "wake") queueMicrotask(() => runtime.emit({ state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.3.0", capabilities: ["pty/1", "pty/2", "session/2"], authority: "manage" }));
  });
  mocks.workspaceConnection.mockReset();
  mocks.workspaceConnection.mockImplementation(async () => ({ target: { kind: "cloud", organizationId: ORG, workspaceId: WS }, client, activate, close: vi.fn() }));
  mocks.createCloudTerminal.mockReset();
  mocks.createCloudTerminal.mockResolvedValue({ id: `cloud:cloud:${ORG}:${WS}:p1` });
  for (const fn of [mocks.resume, connections.wakeCloudConnection, connections.retainCloudConnection]) vi.mocked(fn).mockClear();
  mocks.invoke.mockClear();
  // The last session selected before quitting comes back at launch.
  act(() => sessions.selectCloudSession(KEY));
});

afterEach(() => {
  cleanup();
  catalog.resetCloudCatalog();
  resetCloudAgents();
  resetCloudSessions();
  resetCloudTerminals();
  sessionBackend.resetCloudWakes();
  connections.resetCloudConnections();
  client.close();
});
afterAll(() => act(() => prefs.setPrefs({ sidebarSections: {} })));

const noop = () => {};
/** The app as it launches: the sidebar and the restored cloud session. */
async function launch() {
  render(
    <TooltipProvider>
      <ProjectRail onOpenSettings={noop} onOpenAccount={noop} onOpenIssues={noop} onOpenAgents={noop} onOpenStats={noop} onOpenAutomations={noop} onOpenSkills={noop} onSearch={noop} />
      <CloudSessionHost sessionKey={KEY} sidebarOpen onToggleSidebar={noop} />
    </TooltipProvider>,
  );
  await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
  await act(async () => runtime.emit({ state: "suspended" }));
  await screen.findByText("check the current data");
  await waitFor(() => expect(screen.getByTestId("session-connection").textContent).toContain("Stopped"));
}

// hidden: an open modal menu hides the rest of the page from the accessibility tree.
const plus = () => screen.getByRole("button", { name: "New tab", hidden: true });
async function openMenu() {
  mouseClick(plus());
  return screen.findByRole("menu");
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

/** Every way the desktop could wake, resume or activate a workspace, or send to it. */
function wakes() {
  return {
    resume: mocks.resume.mock.calls.length + commands().filter((command) => command === "cloud_workspace_resume").length,
    wake: vi.mocked(connections.wakeCloudConnection).mock.calls.length,
    retainWake: vi.mocked(connections.retainCloudConnection).mock.calls.filter((call) => call[1] === "wake").length,
    connectWake: mocks.workspaceConnection.mock.calls.filter((call) => call[1] === "wake").length,
    activate: activate.mock.calls.length + commands().filter((command) => command === "cloud_remote_activate").length,
    sent: commands().filter((command) => command === "cloud_agent_enqueue").length,
  };
}
const NONE = { resume: 0, wake: 0, retainWake: 0, connectWake: 0, activate: 0, sent: 0 };

describe("launching with a stopped cloud session selected", () => {
  it("never opens the + menu by itself, and opening, closing and collapsing never wake the workspace", async () => {
    await launch();
    // Launched: the menu is closed and the workspace is only looked at.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    expect(mocks.workspaceConnection.mock.calls.map((call) => call[1])).toEqual(["connect"]);

    // Open it: a stopped workspace says Terminal wakes it; nothing else is offered.
    let menu = await openMenu();
    expect(within(menu).getByText(/^Stopped:/)).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Terminal on the VM: wakes the workspace" })).toBeTruthy();
    for (const name of ["Claude", "Codex"]) expect(within(menu).getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");

    // Escape closes it, choosing nothing (even with Terminal highlighted).
    fireEvent.pointerMove(within(menu).getByRole("menuitem", { name: /wakes the workspace/ }));
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await settle();
    expect(wakes()).toEqual(NONE);

    // The window losing focus closes it, choosing nothing.
    menu = await openMenu();
    act(() => void fireEvent.blur(window));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await settle();
    expect(wakes()).toEqual(NONE);

    // A press outside closes it, choosing nothing.
    menu = await openMenu();
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await settle();
    expect(wakes()).toEqual(NONE);

    // Collapse and expand the organization in the sidebar.
    const org = screen.getByRole("treeitem", { name: "Demo New TerminalX organization" });
    mouseClick(within(org).getByRole("button", { name: "Collapse Demo New TerminalX organization" }));
    await waitFor(() => expect(org.getAttribute("aria-expanded")).toBe("false"));
    mouseClick(within(org).getByRole("button", { name: "Expand Demo New TerminalX organization" }));
    await settle();

    expect(wakes()).toEqual(NONE);
    expect(screen.getByTestId("session-connection").textContent).toContain("Stopped");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("wakes the stopped workspace once, and only when Terminal is chosen", async () => {
    await launch();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Terminal on the VM: wakes the workspace" }));
    await waitFor(() => expect(mocks.createCloudTerminal).toHaveBeenCalledTimes(1));
    expect(vi.mocked(connections.wakeCloudConnection)).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls).toEqual([["wake"]]);
    expect(mocks.createCloudTerminal.mock.calls[0][1]).toBe(client);
    expect(wakes().resume).toBe(0);
    expect(wakes().sent).toBe(0);
  });
});
