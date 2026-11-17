import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTabInfo, MachineProject, RuntimeSession, WorkspaceConnectionState, WorkspaceNotification } from "@terminalx/portable/workspace";
import type { MachineConnectionsState } from "@/lib/machineConnections";
import type { CloudWorkspaceConnection } from "@/lib/api";

// The catalog follows the connections `machineConnections` holds. Those are
// replaced here by a fake machine runtime that answers the `machine/1` and
// session calls and sends their notifications; the agents store is the real one.
const fake = vi.hoisted(() => ({
  state: null as unknown as MachineConnectionsState,
  listeners: new Set<() => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("no native side"); }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/machineConnections", () => ({
  getMachineConnections: () => fake.state,
  subscribeMachineConnections: (listener: () => void) => {
    fake.listeners.add(listener);
    return () => fake.listeners.delete(listener);
  },
}));

const catalog = await import("./machineCatalog");
const agents = await import("./cloudAgents");

class FakeMachine {
  connection: WorkspaceConnectionState = { state: "connecting" } as WorkspaceConnectionState;
  projects: MachineProject[] = [];
  sessions: RuntimeSession[] = [];
  tabs: AgentTabInfo[] = [];
  updates: { sessionId: string; patch: unknown }[] = [];
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
    return this.onNotification((notification) => notification.event === "session.sessions" && listener(notification.params.sessions as RuntimeSession[]));
  }
  onMachineChanged(listener: (change: { projects: MachineProject[] | null }) => void) {
    return this.onNotification((notification) => notification.event === "machine.changed" && listener({ projects: (notification.params.projects as MachineProject[]) ?? null }));
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
  async updateSession(sessionId: string, patch: Record<string, unknown>) {
    this.updates.push({ sessionId, patch });
    const session = { ...this.sessions.find((item) => item.id === sessionId)!, ...patch } as RuntimeSession;
    this.sessions = this.sessions.map((item) => (item.id === sessionId ? session : item));
    return session;
  }
  setState(state: WorkspaceConnectionState) {
    this.connection = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }
  connect() {
    this.setState({ state: "connected", capabilities: ["machine/1", "session/2"], authority: "manage" } as unknown as WorkspaceConnectionState);
  }
  notify(event: string, params: Record<string, unknown>) {
    for (const listener of [...this.notificationListeners]) listener({ event, params } as WorkspaceNotification);
  }
  asConnection(machineId: string): CloudWorkspaceConnection {
    return { target: { kind: "machine", machineId }, client: this as never, activate: async () => {}, close: () => {} };
  }
}

const project = (projectId: string, name: string, path = `/Users/me/code/${name}`): MachineProject => ({ projectId, name, path, kind: "git", defaultBranch: "main", archived: false });

const session = (id: string, projectId: string, title: string, extra: Partial<RuntimeSession> = {}): RuntimeSession => ({
  id,
  projectId,
  projectPath: "/Users/me/code/x",
  cwd: "/Users/me/code/x",
  title,
  created: "2026-11-14T10:00:00Z",
  modified: "2026-11-14T10:00:00Z",
  archived: false,
  pinned: false,
  tabs: [{ id: `${id}-tab`, harness: "claude", model: "opus", permissionMode: "default", status: "idle", created: "2026-11-14T10:00:00Z", modified: "2026-11-14T10:00:00Z" }],
  ...extra,
});

const tab = (sessionId: string, status: AgentTabInfo["status"], extra: Partial<AgentTabInfo> = {}): AgentTabInfo =>
  ({ sessionId, tabId: `${sessionId}-tab`, title: null, harness: "claude", model: "opus", effort: null, permissionMode: "default", status, process: "running", pendingPermissions: [], followUps: [], lastSeq: 1, created: "2026-11-14T10:00:00Z", modified: "2026-11-14T10:00:00Z", ...extra }) as AgentTabInfo;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function hold(connections: Record<string, FakeMachine>, paired = Object.keys(connections)) {
  fake.state = {
    ready: true,
    error: null,
    machines: paired.map((machineId) => ({ machineId, name: machineId }) as never),
    states: {},
    attachErrors: {},
    connections: Object.fromEntries(Object.entries(connections).map(([machineId, machine]) => [machineId, machine.asConnection(machineId)])),
  };
  for (const listener of [...fake.listeners]) listener();
}

beforeEach(() => {
  localStorage.clear();
  fake.listeners.clear();
  fake.state = { ready: false, error: null, machines: [], states: {}, attachErrors: {}, connections: {} };
  agents.resetCloudAgents();
  catalog.resetMachineCatalogForTests();
});

afterEach(() => catalog.resetMachineCatalogForTests());

describe("machine catalog", () => {
  it("lists a connected machine's projects and sessions under machine keys, and follows its changes without a reload", async () => {
    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx"), project("P2", "terminalx-server")];
    mini.sessions = [session("s1", "P1", "Add read markers"), session("s2", "P2", "Seat-based billing")];
    catalog.getMachineCatalog();
    hold({ m1: mini });
    mini.connect();
    await flush();

    const rows = catalog.allMachineSessions();
    expect(rows.map((row) => row.key).sort()).toEqual(["machine:m1:P1:s1", "machine:m1:P2:s2"]);
    expect(rows.every((row) => row.source === "live")).toBe(true);
    const nodes = catalog.buildMachineProjects("m1", catalog.getMachineCatalog().machines.m1, rows);
    expect(nodes.map((node) => [node.key, node.sessions.map((row) => row.title)])).toEqual([
      ["machine:m1:P1", ["Add read markers"]],
      ["machine:m1:P2", ["Seat-based billing"]],
    ]);

    // A session started there, and a project added there, arrive as notifications.
    mini.notify("session.sessions", { sessions: [...mini.sessions, session("s3", "P1", "Bisect the flaky relay e2e")] });
    mini.notify("machine.changed", { machine: {}, projects: [...mini.projects, project("P3", "tx-review-lab")] });
    expect(catalog.allMachineSessions().map((row) => row.sessionId).sort()).toEqual(["s1", "s2", "s3"]);
    expect(catalog.getMachineCatalog().machines.m1.projects.map((item) => item.projectId)).toEqual(["P1", "P2", "P3"]);
  });

  it("keeps two machines' projects of the same name apart", async () => {
    const mini = new FakeMachine();
    const server = new FakeMachine();
    mini.projects = [project("Pa", "terminalx")];
    server.projects = [project("Pb", "terminalx", "/home/me/terminalx")];
    mini.sessions = [session("s1", "Pa", "On the mini")];
    server.sessions = [session("s2", "Pb", "On the server")];
    catalog.getMachineCatalog();
    hold({ m1: mini, m2: server });
    mini.connect();
    server.connect();
    await flush();

    const { machines } = catalog.getMachineCatalog();
    const keys = ["m1", "m2"].flatMap((machineId) => catalog.buildMachineProjects(machineId, machines[machineId], catalog.allMachineSessions().filter((row) => row.machineId === machineId)).map((node) => [node.key, node.project.name, node.sessions.map((row) => row.key)]));
    expect(keys).toEqual([
      ["machine:m1:Pa", "terminalx", ["machine:m1:Pa:s1"]],
      ["machine:m2:Pb", "terminalx", ["machine:m2:Pb:s2"]],
    ]);
  });

  it("takes tab states from the runtime's tab list, and the most urgent tab gives the row its mark", async () => {
    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    mini.sessions = [session("s1", "P1", "Working one"), session("s2", "P1", "Asking one")];
    mini.tabs = [tab("s1", "in_progress"), tab("s2", "idle", { pendingPermissions: [{ requestId: "r", toolName: "Bash", input: {}, options: [] }] })];
    catalog.getMachineCatalog();
    hold({ m1: mini });
    mini.connect();
    await flush();

    const byId = Object.fromEntries(catalog.allMachineSessions().map((row) => [row.sessionId, catalog.machineSessionStatus(row)]));
    expect(byId).toEqual({ s1: "in_progress", s2: "waiting" });

    // A `session.tabs` broadcast moves the first to done-and-unread.
    mini.notify("session.tabs", { tabs: [tab("s1", "completed"), tab("s2", "idle")] });
    const s1 = catalog.allMachineSessions().find((row) => row.sessionId === "s1")!;
    expect(s1.tabs[0]).toMatchObject({ status: "completed", unread: true });
    expect(catalog.machineSessionStatus(s1)).toBe("completed");
  });

  it("keeps a machine that cannot be reached with its last known sessions, across a relaunch", async () => {
    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    mini.sessions = [session("s1", "P1", "Nightly soak run")];
    mini.tabs = [tab("s1", "completed")];
    catalog.getMachineCatalog();
    hold({ m1: mini });
    mini.connect();
    await flush();
    expect(catalog.allMachineSessions()[0]).toMatchObject({ source: "live" });

    // The link drops: the rows stay, read from what was last heard.
    mini.setState({ state: "reconnecting" } as WorkspaceConnectionState);
    expect(catalog.allMachineSessions()).toMatchObject([{ key: "machine:m1:P1:s1", title: "Nightly soak run", source: "cache" }]);
    catalog.flushMachineCatalogForTests();

    // A relaunch with the machine away: the save brings back the section and the unread mark.
    catalog.resetMachineCatalogForTests();
    agents.resetCloudAgents();
    fake.state = { ...fake.state, connections: {} };
    const rows = catalog.allMachineSessions();
    expect(rows).toMatchObject([{ key: "machine:m1:P1:s1", source: "cache" }]);
    expect(rows[0].tabs[0]).toMatchObject({ unread: true });
    expect(catalog.getMachineCatalog().machines.m1.projects.map((item) => item.name)).toEqual(["terminalx"]);
  });

  it("forgets a machine once it is no longer paired", async () => {
    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    mini.sessions = [session("s1", "P1", "One")];
    catalog.getMachineCatalog();
    hold({ m1: mini });
    mini.connect();
    await flush();
    expect(catalog.getMachineCatalog().machines.m1).toBeDefined();

    hold({}, []);
    expect(catalog.getMachineCatalog().machines.m1).toBeUndefined();
    catalog.flushMachineCatalogForTests();
    expect(JSON.parse(localStorage.getItem("terminalx.machineCatalog.v1") ?? "{}")).toEqual({});
  });

  it("leaves out sessions with no project and refuses saved ids that would break a key", async () => {
    localStorage.setItem(
      "terminalx.machineCatalog.v1",
      JSON.stringify({ "bad:id": { projects: [], sessions: [] }, m1: { projects: [project("P1", "terminalx"), { projectId: "a/b", name: "x" }], sessions: [session("s1", "P1", "Kept"), session("s:2", "P1", "Dropped")], unread: [] } }),
    );
    expect(Object.keys(catalog.getMachineCatalog().machines)).toEqual(["m1"]);
    expect(catalog.getMachineCatalog().machines.m1.projects.map((item) => item.projectId)).toEqual(["P1"]);
    expect(catalog.allMachineSessions().map((row) => row.key)).toEqual(["machine:m1:P1:s1"]);

    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    mini.sessions = [session("s1", "P1", "Has a project"), { ...session("s9", "P1", "No project"), projectId: undefined }];
    hold({ m1: mini });
    mini.connect();
    await flush();
    expect(catalog.allMachineSessions().map((row) => row.sessionId)).toEqual(["s1"]);
  });

  it("pins and archives a session on the machine, and refuses while it is not connected", async () => {
    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    mini.sessions = [session("s1", "P1", "One")];
    catalog.getMachineCatalog();
    hold({ m1: mini });
    mini.connect();
    await flush();

    await catalog.updateMachineSession("machine:m1:P1:s1", { pinned: true });
    expect(mini.updates).toEqual([{ sessionId: "s1", patch: { pinned: true } }]);
    expect(catalog.findMachineSession("machine:m1:P1:s1")).toMatchObject({ pinned: true });

    mini.setState({ state: "reconnecting" } as WorkspaceConnectionState);
    await expect(catalog.updateMachineSession("machine:m1:P1:s1", { archived: true })).rejects.toThrow(/not connected/);
  });

  // PRO-406: a worktree removed on the machine takes its sessions' rows with it, before the machine's list says so.
  it("drops the sessions a removed worktree took with it, on that machine only", async () => {
    const mini = new FakeMachine();
    const server = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    server.projects = [project("P1", "terminalx")];
    mini.sessions = [session("s1", "P1", "In the worktree"), session("s2", "P1", "Also there"), session("s3", "P1", "Elsewhere")];
    server.sessions = [session("s1", "P1", "Same id, other machine")];
    catalog.getMachineCatalog();
    hold({ m1: mini, m2: server });
    mini.connect();
    server.connect();
    await flush();

    catalog.forgetMachineSessions("m1", ["s1", "s2"]);
    expect(catalog.allMachineSessions().map((row) => row.key).sort()).toEqual(["machine:m1:P1:s3", "machine:m2:P1:s1"]);
    // Nothing to drop, or a machine not known: nothing changes.
    catalog.forgetMachineSessions("m1", []);
    catalog.forgetMachineSessions("gone", ["s3"]);
    expect(catalog.allMachineSessions()).toHaveLength(2);
  });

  it("puts a pinned session first in its project, above newer ones, once the machine has pinned it", async () => {
    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    mini.sessions = [session("old", "P1", "Older", { lastMessageAt: "2026-11-14T09:00:00Z" }), session("new", "P1", "Newer", { lastMessageAt: "2026-11-14T11:00:00Z" })];
    catalog.getMachineCatalog();
    hold({ m1: mini });
    mini.connect();
    await flush();
    const order = () => catalog.buildMachineProjects("m1", catalog.getMachineCatalog().machines.m1, catalog.allMachineSessions())[0].sessions.map((row) => row.sessionId);
    expect(order()).toEqual(["new", "old"]);

    await catalog.updateMachineSession("machine:m1:P1:old", { pinned: true });
    expect(order()).toEqual(["old", "new"]);
    // The same when the machine's own list says so.
    mini.notify("session.sessions", { sessions: mini.sessions });
    expect(order()).toEqual(["old", "new"]);
  });

  it("reads a working turn on a machine that cannot be reached as idle, keeping what needs the person", async () => {
    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    mini.sessions = [session("s1", "P1", "Working one"), session("s2", "P1", "Asking one")];
    mini.tabs = [tab("s1", "in_progress"), tab("s2", "waiting")];
    catalog.getMachineCatalog();
    hold({ m1: mini });
    mini.connect();
    await flush();
    const marks = () => Object.fromEntries(catalog.allMachineSessions().map((row) => [row.sessionId, [catalog.machineSessionStatus(row), row.tabs[0].status]]));
    expect(marks()).toEqual({ s1: ["in_progress", "in_progress"], s2: ["waiting", "waiting"] });

    mini.setState({ state: "reconnecting" } as WorkspaceConnectionState);
    expect(marks()).toEqual({ s1: ["idle", "idle"], s2: ["waiting", "waiting"] });

    // Back: the machine's answer is what counts again.
    mini.connect();
    await flush();
    expect(marks().s1).toEqual(["in_progress", "in_progress"]);
  });

  it("keeps a saved row status's branch and PR while the machine is away, but not its running turn", async () => {
    const mini = new FakeMachine();
    mini.projects = [project("P1", "terminalx")];
    const rowStatus = { tabs: [{ status: "in_progress" as const }], branch: "seats", started: true };
    mini.sessions = [session("s1", "P1", "Seats", { rowStatus })];
    catalog.getMachineCatalog();
    hold({ m1: mini });
    mini.connect();
    await flush();
    expect(catalog.allMachineSessions()[0].rowStatus).toEqual(rowStatus);

    mini.setState({ state: "reconnecting" } as WorkspaceConnectionState);
    expect(catalog.allMachineSessions()[0].rowStatus).toEqual({ tabs: [{ status: "idle", activity: null }], branch: "seats", started: true });
  });

  it("orders a machine's sessions as the local sidebar does: pinned first, then the newest message", () => {
    const entry = {
      projects: [project("P1", "terminalx")],
      sessions: [
        session("newest", "P1", "Newest", { lastMessageAt: "2026-11-14T12:00:00Z" }),
        session("pinned-old", "P1", "Pinned, oldest", { lastMessageAt: "2026-11-14T08:00:00Z", pinned: true }),
        session("middle", "P1", "Middle", { lastMessageAt: "2026-11-14T10:00:00Z" }),
      ],
      unread: [],
      source: "cache" as const,
      syncedAt: null,
    };
    expect(catalog.buildMachineSessions("m1", entry, []).map((row) => row.sessionId)).toEqual(["pinned-old", "newest", "middle"]);
  });
});
