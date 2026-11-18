import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTabInfo, MachineProject, RuntimeSession, WorkspaceConnectionState, WorkspaceNotification } from "@terminalx/portable/workspace";
import type { CloudWorkspaceConnection } from "@/lib/api";
import type { MachineConnectionsState } from "@/lib/machineConnections";
import { pairedMachine } from "@/components/machines/machineFixtures.test-utils";

/**
 * Sessions on paired machines (PRO-346) want the reader back as local ones do:
 * in the dock badge and as notices.
 */
const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setBadgeCount: vi.fn(async (_count?: number) => undefined),
  connections: null as unknown as MachineConnectionsState,
  listeners: new Set<() => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "notification_permission") return "granted";
    if (command === "list_workspaces") return [];
    throw new Error(`no native side: ${command}`);
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: mocks.setBadgeCount }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: mocks.sendNotification,
}));
vi.mock("@/lib/machineConnections", () => ({
  getMachineConnections: () => mocks.connections,
  subscribeMachineConnections: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

const MINI = pairedMachine({ name: "Mac mini" });
const KEY = `machine:${MINI.machineId}:P1:s1`;

/** A machine's runtime as the catalog follows it: projects, sessions and agent tabs, with their notifications. */
class FakeMachine {
  connection: WorkspaceConnectionState = { state: "connecting" } as WorkspaceConnectionState;
  projects: MachineProject[] = [{ projectId: "P1", name: "terminalx", path: "/Users/me/code/terminalx", kind: "git", defaultBranch: "main", archived: false }];
  sessions: RuntimeSession[] = [];
  tabs: AgentTabInfo[] = [];
  private stateListeners = new Set<(state: WorkspaceConnectionState) => void>();
  private notificationListeners = new Set<(notification: WorkspaceNotification) => void>();
  hasCapability(capability: string) {
    return this.connection.state === "connected" && capability === "machine/1";
  }
  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }
  onNotification(listener: (notification: WorkspaceNotification) => void) {
    this.notificationListeners.add(listener);
    return () => void this.notificationListeners.delete(listener);
  }
  onSessions(listener: (sessions: RuntimeSession[]) => void) {
    return this.onNotification((n) => n.event === "session.sessions" && listener(n.params.sessions as RuntimeSession[]));
  }
  onMachineChanged(listener: (change: { projects: MachineProject[] | null }) => void) {
    return this.onNotification((n) => n.event === "machine.changed" && listener({ projects: null }));
  }
  async machineProjects() {
    return this.projects;
  }
  async listSessions() {
    return this.sessions;
  }
  async listAgentTabs() {
    return this.tabs;
  }
  connect() {
    this.connection = { state: "connected", capabilities: ["machine/1", "session/2"], authority: "manage" } as unknown as WorkspaceConnectionState;
    for (const listener of [...this.stateListeners]) listener(this.connection);
  }
  /** The runtime says a session's tab changed: its sessions list again, as it sends them. */
  setTab(status: RuntimeSession["tabs"][number]["status"]) {
    this.sessions = [session(status)];
    for (const listener of [...this.notificationListeners]) listener({ event: "session.sessions", params: { sessions: this.sessions } } as WorkspaceNotification);
  }
  asConnection(): CloudWorkspaceConnection {
    return { target: { kind: "machine", machineId: MINI.machineId }, client: this as never, activate: async () => {}, close: () => {} };
  }
}

function session(status: RuntimeSession["tabs"][number]["status"]): RuntimeSession {
  return {
    id: "s1",
    projectId: "P1",
    projectPath: "/Users/me/code/terminalx",
    cwd: "/Users/me/code/terminalx",
    title: "Bisect the flaky relay e2e",
    created: "2026-11-14T10:00:00Z",
    modified: "2026-11-14T10:00:00Z",
    lastMessageAt: "2026-11-14T10:05:00Z",
    archived: false,
    pinned: false,
    tabs: [{ id: "t1", harness: "claude", model: "opus", permissionMode: "default", status, created: "2026-11-14T10:00:00Z", modified: "2026-11-14T10:00:00Z" }],
  };
}

function pair(machine: FakeMachine | null) {
  mocks.connections = { ready: true, error: null, machines: [MINI], states: {}, attachErrors: {}, connections: machine ? { [MINI.machineId]: machine.asConnection() } : {} };
  for (const listener of [...mocks.listeners]) listener();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastBadge = () => mocks.setBadgeCount.mock.calls.at(-1)?.[0];

async function boot(focused: boolean) {
  vi.resetModules();
  mocks.listeners.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  (await import("./appWindow")).setAppWindowForTest("main");
  const machineDashboard = await import("./machineDashboard");
  const sessions = await import("./sessions");
  const notify = await import("./notify");
  notify.startNotifications();
  return { machineDashboard, sessions, notify };
}

beforeEach(() => {
  localStorage.clear();
  mocks.sendNotification.mockReset();
  mocks.setBadgeCount.mockClear();
  mocks.connections = { ready: false, error: null, machines: [], states: {}, attachErrors: {}, connections: {} };
});
afterEach(() => vi.restoreAllMocks());

describe("machine sessions in the dock badge", () => {
  it("count a saved wait and an unread finish while the machine is paired, and nothing once it is removed", async () => {
    localStorage.setItem("terminalx.machineCatalog.v1", JSON.stringify({
      [MINI.machineId]: {
        projects: [{ projectId: "P1", name: "terminalx", path: "/x", kind: "git", defaultBranch: "main", archived: false }],
        sessions: [{ ...session("waiting"), id: "s1" }, { ...session("completed"), id: "s2", tabs: [{ ...session("completed").tabs[0], id: "t2" }] }, { ...session("completed"), id: "s3", tabs: [{ ...session("completed").tabs[0], id: "t3" }] }],
        unread: ["t2"],
        syncedAt: 1,
      },
    }));
    await boot(true);
    await settle();
    // The paired machines are not read yet: nothing counts.
    expect(lastBadge()).toBeUndefined();

    pair(null);
    await settle();
    // s1 waits, s2 finished unread; s3 was read.
    expect(lastBadge()).toBe(2);

    // Removed: the machine and its sessions leave the count.
    mocks.connections = { ready: true, error: null, machines: [], states: {}, attachErrors: {}, connections: {} };
    for (const listener of [...mocks.listeners]) listener();
    await settle();
    await settle();
    expect(lastBadge()).toBeUndefined();
  });
});

describe("machine session notices", () => {
  it("say what a waiting session waits for (21.09)", async () => {
    const { notify } = await boot(true);
    expect(notify.machineWaitText("Bisect the flaky relay e2e", 1)).toBe("Bisect the flaky relay e2e is waiting for an approval.");
    expect(notify.machineWaitText("Bisect the flaky relay e2e", 0)).toBe("Bisect the flaky relay e2e is waiting for you.");
  });

  it("raise a new wait on a connected machine, and the notice opens the machine session", async () => {
    const mini = new FakeMachine();
    mini.sessions = [session("in_progress")];
    const { sessions, notify } = await boot(true);
    pair(mini);
    mini.connect();
    await settle();
    await settle();
    const { renderHook } = await import("@testing-library/react");
    const { result } = renderHook(() => notify.useNotices());
    // The first connected pass is what is known: the working tab raises nothing.
    expect(result.current.filter((n) => n.sessionId === KEY)).toEqual([]);

    mini.setTab("waiting");
    await settle();
    await settle();
    const notice = result.current.find((n) => n.sessionId === KEY);
    // 21.09: the machine needs the person, with Open.
    expect(notice).toMatchObject({ kind: "waiting", tabId: "t1", title: "Mac mini needs you", action: "open" });
    expect(notice?.body).toMatch(/^Bisect the flaky relay e2e is waiting for (an approval|you)\.$/);

    notify.openNotice(notice!);
    expect(sessions.getSessions().selectedSessionId).toBe(KEY);
  });

  it("send a banner when nobody is looking", async () => {
    const mini = new FakeMachine();
    mini.sessions = [session("in_progress")];
    await boot(false);
    pair(mini);
    mini.connect();
    await settle();
    await settle();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    mini.setTab("waiting");
    await settle();
    await settle();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification.mock.calls[0][0]).toMatchObject({ title: expect.stringContaining("needs attention"), body: expect.stringContaining("Mac mini") });
  });
});
