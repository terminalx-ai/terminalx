import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTabInfo, MachineProject, RuntimeSession } from "@terminalx/portable/workspace";
import type { MachineConnectionsState } from "@/lib/machineConnections";
import type { MachineCatalogEntry, MachineCatalogState } from "@/lib/machineCatalog";
import { pairedMachine } from "@/components/machines/machineFixtures.test-utils";

// The paired machines come from a fake `machineConnections`; the catalog and the agents store are the real ones.
const fake = vi.hoisted(() => ({ state: null as unknown as MachineConnectionsState, listeners: new Set<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("no native side"); }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/machineConnections", () => ({
  getMachineConnections: () => fake.state,
  subscribeMachineConnections: (listener: () => void) => {
    fake.listeners.add(listener);
    return () => fake.listeners.delete(listener);
  },
}));

const dashboard = await import("./machineDashboard");
const catalog = await import("./machineCatalog");
const agents = await import("./cloudAgents");

const MINI = pairedMachine({ machineId: "cs1uhCLEB_ttCYaQ", name: "Mac mini" });
const SERVER = pairedMachine({ machineId: "dYd7tB05O1-4RVzm", name: "dev-server", os: { family: "linux", version: null } });

const project = (projectId: string, name: string): MachineProject => ({ projectId, name, path: `/Users/me/code/${name}`, kind: "git", defaultBranch: "main", archived: false });

function session(id: string, status: RuntimeSession["tabs"][number]["status"], extra: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id,
    projectId: "P1",
    projectPath: "/Users/me/code/terminalx",
    cwd: "/Users/me/code/terminalx",
    title: `Session ${id}`,
    created: "2026-11-14T10:00:00Z",
    modified: "2026-11-14T10:00:00Z",
    lastMessageAt: "2026-11-14T10:05:00Z",
    archived: false,
    pinned: false,
    tabs: [{ id: `${id}-tab`, harness: "claude", model: "opus", permissionMode: "default", status, created: "2026-11-14T10:00:00Z", modified: "2026-11-14T10:00:00Z" }],
    ...extra,
  };
}

function entry(sessions: RuntimeSession[], source: "live" | "cache", unread: string[] = []): MachineCatalogEntry {
  return { projects: [project("P1", "terminalx")], sessions, unread, source, syncedAt: 1 };
}

function project_(catalogState: MachineCatalogState, machines = [MINI], includeArchived = false) {
  return dashboard.projectMachineSessions({ machines, catalog: catalogState, agentTabs: () => [], includeArchived });
}

function pair(machines = [MINI]) {
  fake.state = { ready: true, error: null, machines, states: {}, attachErrors: {}, connections: {} };
  for (const listener of [...fake.listeners]) listener();
}

/** What a previous launch saved, read by the catalog as `cache`. */
function saved(machines: Record<string, { sessions: RuntimeSession[]; unread?: string[] }>) {
  localStorage.setItem(
    "terminalx.machineCatalog.v1",
    JSON.stringify(Object.fromEntries(Object.entries(machines).map(([id, m]) => [id, { projects: [project("P1", "terminalx")], sessions: m.sessions, unread: m.unread ?? [], syncedAt: 1 }]))),
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  fake.listeners.clear();
  fake.state = { ready: false, error: null, machines: [], states: {}, attachErrors: {}, connections: {} };
  agents.resetCloudAgents();
  catalog.resetMachineCatalogForTests();
  dashboard.resetMachineDashboardForTests();
});
afterEach(() => {
  dashboard.resetMachineDashboardForTests();
  catalog.resetMachineCatalogForTests();
});

describe("projecting machine sessions", () => {
  it("keys each session by its machine and names its project and machine, never a path on this Mac", () => {
    const [row] = project_({ machines: { [MINI.machineId]: entry([session("s1", "idle")], "live") } });
    expect(row).toMatchObject({
      kind: "machine",
      id: "machine:cs1uhCLEB_ttCYaQ:P1:s1",
      key: "machine:cs1uhCLEB_ttCYaQ:P1:s1",
      projectPath: "machine:cs1uhCLEB_ttCYaQ:P1",
      projectName: "terminalx",
      machineName: "Mac mini",
      cwd: "terminalx",
      connected: true,
      ownerId: null,
    });
    expect(dashboard.isMachineDashboardSession(row)).toBe(true);
    expect(dashboard.isMachineDashboardSession({ kind: "cloud" })).toBe(false);
  });

  it("believes a live machine, keeps a saved wait, and drops a saved 'working'", () => {
    const sessions = [session("wait", "waiting"), session("work", "in_progress"), session("done", "completed"), session("read", "completed")];
    const live = project_({ machines: { [MINI.machineId]: entry(sessions, "live", ["done-tab"]) } });
    const status = (rows: typeof live) => Object.fromEntries(rows.map((row) => [row.sessionId, row.tabs[0].status]));
    // Unread is what the agents store knows; with none known, the saved marks decide.
    expect(status(live)).toEqual({ wait: "waiting", work: "in_progress", done: "completed", read: "idle" });
    const cached = project_({ machines: { [MINI.machineId]: entry(sessions, "cache", ["done-tab"]) } });
    expect(status(cached)).toEqual({ wait: "waiting", work: "idle", done: "completed", read: "idle" });
    expect(cached.every((row) => !row.connected && !row.tabs[0].live)).toBe(true);
  });

  it("leaves out machines that are not paired, and archived sessions unless asked", () => {
    const catalogState: MachineCatalogState = {
      machines: { [MINI.machineId]: entry([session("s1", "idle"), session("old", "idle", { archived: true })], "live"), gone: entry([session("x", "waiting")], "cache") },
    };
    expect(project_(catalogState).map((row) => row.sessionId)).toEqual(["s1"]);
    expect(project_(catalogState, [MINI], true).map((row) => row.sessionId).sort()).toEqual(["old", "s1"]);
    expect(project_(catalogState, [])).toEqual([]);
  });

  it("marks and opens on the most urgent tab", () => {
    const [row] = project_({ machines: { [MINI.machineId]: entry([session("s1", "in_progress", { tabs: [
      { id: "a", harness: "codex", model: "", permissionMode: "default", status: "in_progress", created: "x", modified: "x" },
      { id: "b", harness: "claude", model: "", permissionMode: "default", status: "waiting", created: "x", modified: "x" },
    ] })], "live") } });
    expect(dashboard.machineSessionMark(row)).toBe("waiting");
    expect(dashboard.machineAttentionTab(row)?.tabId).toBe("b");
  });
});

describe("waking after the machine finished a turn (PRO-352)", () => {
  it("shows a turn that finished while this Mac slept as finished, with its unread mark, once the machine is back", () => {
    const scope = catalog.machineAgentScope(MINI.machineId);
    const tab = (status: "in_progress" | "completed") =>
      ({ sessionId: "s1", tabId: "s1-tab", title: null, harness: "claude", model: "opus", effort: null, permissionMode: "default", status, process: "running", pendingPermissions: [], followUps: [], lastSeq: 0 }) as unknown as AgentTabInfo;
    const live = { machines: [MINI], agentTabs: (machineId: string) => agents.getCloudAgents(catalog.machineAgentScope(machineId)).tabs };

    // Before sleep: the machine said the turn was working.
    agents.applyLiveTabs(scope, [tab("in_progress")]);
    const before = dashboard.projectMachineSessions({ ...live, catalog: { machines: { [MINI.machineId]: entry([session("s1", "in_progress")], "live") } } });
    expect(before[0].tabs[0].status).toBe("in_progress");

    // Asleep: only what was saved, and a saved "working" is not believed.
    const asleep = dashboard.projectMachineSessions({ ...live, catalog: { machines: { [MINI.machineId]: entry([session("s1", "in_progress")], "cache") } } });
    expect(asleep[0].tabs[0].status).toBe("idle");

    // Awake: the reconnect lists the tab again, finished.
    agents.applyLiveTabs(scope, [tab("completed")]);
    const awake = { [MINI.machineId]: entry([session("s1", "completed")], "live") };
    const after = dashboard.projectMachineSessions({ ...live, catalog: { machines: awake } });
    expect(after[0].tabs[0].status).toBe("completed");
    expect(dashboard.machineSessionMark(after[0])).toBe("completed");
    // The sidebar row carries the unread mark.
    const [row] = catalog.buildMachineSessions(MINI.machineId, awake[MINI.machineId], live.agentTabs(MINI.machineId));
    expect(row.tabs[0].unread).toBe(true);
  });
});

describe("paired machines", () => {
  it("gives the sessions of each paired machine, follows them as machines come and go, and nothing with none paired", async () => {
    saved({ [MINI.machineId]: { sessions: [session("s1", "waiting")] }, [SERVER.machineId]: { sessions: [session("s2", "idle")] } });
    pair([MINI, SERVER]);
    const heard = vi.fn();
    dashboard.subscribeMachineDashboard(heard);
    await flush();
    expect(dashboard.getMachineDashboard().map((row) => `${row.machineName}/${row.sessionId}`).sort()).toEqual(["Mac mini/s1", "dev-server/s2"]);

    // A machine unpaired leaves the list with its sessions.
    heard.mockClear();
    pair([MINI]);
    await flush();
    expect(dashboard.getMachineDashboard().map((row) => row.sessionId)).toEqual(["s1"]);
    expect(heard).toHaveBeenCalled();

    // With no machine paired there is nothing, and readers are told.
    heard.mockClear();
    pair([]);
    await flush();
    expect(heard).toHaveBeenCalled();
    expect(dashboard.getMachineDashboard()).toEqual([]);
  });
});

describe("machine attention", () => {
  const live = (sessions: RuntimeSession[], unread: string[] = []) => project_({ machines: { [MINI.machineId]: entry(sessions, "live", unread) } });
  const cached = (sessions: RuntimeSession[]) => project_({ machines: { [MINI.machineId]: entry(sessions, "cache") } });

  it("takes the first connected pass as known, then raises a new wait and a finish once each", () => {
    const observe = dashboard.createMachineAttentionTracker();
    expect(observe(cached([session("s1", "waiting"), session("s2", "idle")]))).toEqual([]);
    // Connected: what it shows now (s1 still waiting, s2 waiting since it was away) is known.
    expect(observe(live([session("s1", "waiting"), session("s2", "waiting")]))).toEqual([]);
    expect(observe(live([session("s1", "waiting"), session("s2", "waiting"), session("s3", "in_progress")]))).toEqual([]);

    const raised = observe(live([session("s1", "idle"), session("s2", "waiting"), session("s3", "waiting")]));
    expect(raised.map((event) => `${event.kind}:${event.session.sessionId}`)).toEqual(["waiting:s3"]);
    // Seen again: nothing new.
    expect(observe(live([session("s1", "idle"), session("s2", "waiting"), session("s3", "waiting")]))).toEqual([]);

    const back = observe(live([session("s1", "waiting"), session("s2", "waiting"), session("s3", "in_progress")]));
    expect(back.map((event) => `${event.kind}:${event.session.sessionId}`)).toEqual(["waiting:s1"]);
    const done = observe(live([session("s1", "waiting"), session("s2", "waiting"), session("s3", "completed")], ["s3-tab"]));
    expect(done.map((event) => `${event.kind}:${event.session.sessionId}`)).toEqual(["done:s3"]);
  });

  it("raises nothing from the save, and starts over after a reconnect or once the machine is removed", () => {
    const observe = dashboard.createMachineAttentionTracker();
    observe(live([session("s1", "idle")]));
    observe(live([session("s1", "idle")]));
    // Disconnected: the save speaks, and it raises nothing.
    expect(observe(cached([session("s1", "waiting")]))).toEqual([]);
    // Back: the first connected pass is known again.
    expect(observe(live([session("s1", "waiting"), session("s2", "waiting")]))).toEqual([]);
    // Removed: nothing seen, everything forgotten; paired again, nothing old is raised.
    expect(observe([])).toEqual([]);
    expect(observe(live([session("s1", "waiting")]))).toEqual([]);
  });

  it("raises one wait per session when several of its tabs start waiting together", () => {
    const observe = dashboard.createMachineAttentionTracker();
    const two = (status: "idle" | "waiting") => session("s1", status, { tabs: [
      { id: "a", harness: "claude", model: "", permissionMode: "default", status, created: "x", modified: "x" },
      { id: "b", harness: "codex", model: "", permissionMode: "default", status, created: "x", modified: "x" },
    ] });
    observe(live([two("idle")]));
    expect(observe(live([two("waiting")]))).toHaveLength(1);
  });
});
