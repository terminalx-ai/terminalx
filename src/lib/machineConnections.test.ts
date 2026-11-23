import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairedMachine } from "@/components/machines/machineFixtures.test-utils";
import type { MachineConnectionState, MachineConnectionView } from "@/types/machines";

// The store against the real `workspaceConnection` and `NativeWorkspaceTransport`,
// with the Tauri commands and the event bus mocked as the native side answers them.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, ((event: { payload: unknown }) => void)[]>(),
  detachCloudTerminals: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, [...(mocks.handlers.get(name) ?? []), handler]);
    return () => mocks.handlers.set(name, (mocks.handlers.get(name) ?? []).filter((entry) => entry !== handler));
  }),
}));
vi.mock("@/lib/cloudTerminals", () => ({ detachCloudTerminals: mocks.detachCloudTerminals, errorCode: () => "unknown" }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: { state: "signed-out" } }) }));
vi.mock("@/lib/terminal", () => ({
  closeSessionShells: vi.fn(), dropSessionTerminals: vi.fn(), dropTabTerminals: vi.fn(),
  setArchivedTerminalSessions: vi.fn(), setSelectedAgent: vi.fn(),
}));
vi.mock("@/lib/tabLayouts", () => ({ bootTabLayouts: vi.fn() }));

const store = await import("./machineConnections");
const api = await import("@/lib/api");
const sessions = await import("@/lib/sessions");

const MAC_MINI = pairedMachine({ machineId: "m1", name: "Mac mini" });
const DEV_SERVER = pairedMachine({ machineId: "m2", name: "dev-server", os: { family: "linux", version: null } });

function emit(name: string, payload: unknown) {
  for (const handler of mocks.handlers.get(name) ?? []) handler({ payload });
}
const changed = (view: MachineConnectionView) => emit("machines_connection_changed", view);
const remote = (payload: unknown) => emit("cloud_remote_event", payload);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let paired = [MAC_MINI, DEV_SERVER];
let views: MachineConnectionView[] = [];
let attachRefusal: Record<string, string> = {};
let stop: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  store.resetMachineConnectionsForTests();
  api.closeWorkspaceConnections();
  for (const machineId of ["m1", "m2", "m3"]) api.closeWorkspaceConnection({ kind: "machine", machineId });
  sessions.selectCloudWorkspace(null);
  paired = [MAC_MINI, DEV_SERVER];
  views = [
    { machineId: "m1", state: { state: "idle" } },
    { machineId: "m2", state: { state: "idle" } },
  ];
  attachRefusal = {};
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "machines_list":
        return paired;
      case "machines_connections":
        return views;
      case "machine_remote_attach": {
        const machineId = String(args?.machineId);
        if (attachRefusal[machineId]) throw attachRefusal[machineId];
        return `conn-${machineId}`;
      }
      case "machines_reconnect":
      case "cloud_remote_detach":
      case "cloud_remote_send":
        return null;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  sessions.selectCloudWorkspace(null);
});

async function started() {
  stop = store.startMachineConnections();
  await vi.waitFor(() => expect(Object.keys(store.getMachineConnections().connections).sort()).toEqual(["m1", "m2"]));
}

const commands = (name: string) => mocks.invoke.mock.calls.filter(([command]) => command === name);

describe("machine connections", () => {
  it("reads nothing and attaches nothing until a window starts them", async () => {
    await flush();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(store.getMachineConnections()).toMatchObject({ ready: false, machines: [], connections: {} });
  });

  it("with no machine paired reads the empty list and attaches nothing (PRO-360)", async () => {
    paired = [];
    views = [];
    stop = store.startMachineConnections();
    await vi.waitFor(() => expect(store.getMachineConnections().ready).toBe(true));
    await flush();
    expect(store.getMachineConnections()).toMatchObject({ machines: [], connections: {}, error: null });
    expect(commands("machine_remote_attach")).toEqual([]);
    expect(commands("machines_reconnect")).toEqual([]);
  });

  it("attaches every paired machine once, with its connection keyed machine:<id>", async () => {
    await started();
    expect(commands("machine_remote_attach").map(([, args]) => args)).toEqual([{ machineId: "m1" }, { machineId: "m2" }]);
    const state = store.getMachineConnections();
    expect(state.ready).toBe(true);
    expect(state.machines.map((machine) => machine.name)).toEqual(["Mac mini", "dev-server"]);
    expect(state.connections.m1!.target).toEqual({ kind: "machine", machineId: "m1" });
    expect(api.workspaceTargetKey(state.connections.m1!.target)).toBe("machine:m1");
    expect(api.hasWorkspaceConnection({ kind: "machine", machineId: "m1", projectId: "p1" })).toBe(true);
    // A project on the machine shares the machine's connection.
    expect(await api.workspaceConnection({ kind: "machine", machineId: "m1", projectId: "p1" })).toBe(state.connections.m1);
    // A read again attaches nothing twice.
    await store.refreshPairedMachines();
    expect(commands("machine_remote_attach")).toHaveLength(2);
  });

  it("follows machines_connection_changed for each machine, and a slower read never overwrites a newer event", async () => {
    let answer!: (value: MachineConnectionView[]) => void;
    mocks.invoke.mockImplementationOnce(async () => paired);
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    stop = store.startMachineConnections();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    changed({ machineId: "m1", state: { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.2:6768/machine/1" }, since: 1, rttMs: 9 } });
    answer([
      { machineId: "m1", state: { state: "connecting", trying: ["lan"] } },
      { machineId: "m2", state: { state: "relay", route: { kind: "relay", endpoint: null }, since: 1, rttMs: null } },
    ]);
    await vi.waitFor(() => expect(store.getMachineConnections().states.m2?.state).toBe("relay"));
    expect(store.getMachineConnections().states.m1).toMatchObject({ state: "direct", rttMs: 9 });

    changed({ machineId: "m1", state: { state: "reconnecting", lostAt: 5, attempt: 1, retryInMs: 250, trying: ["lan", "relay"] } });
    expect(store.getMachineConnections().states.m1).toMatchObject({ state: "reconnecting", lostAt: 5 });
    changed({ machineId: "m1", state: { state: "offline", lastSeenAt: 7, retryInMs: 10_000 } });
    changed({ machineId: "m2", state: { state: "accessRemoved" } });
    expect(store.getMachineConnections().states).toMatchObject({ m1: { state: "offline", lastSeenAt: 7 }, m2: { state: "accessRemoved" } });
    // Malformed events are ignored.
    emit("machines_connection_changed", { machineId: 3 });
    expect(Object.keys(store.getMachineConnections().states).sort()).toEqual(["m1", "m2"]);
  });

  it("reads the list again for a machine it did not know, and attaches it", async () => {
    await started();
    const STUDIO = pairedMachine({ machineId: "m3", name: "Studio" });
    paired = [MAC_MINI, DEV_SERVER, STUDIO];
    changed({ machineId: "m3", state: { state: "connecting", trying: ["lan"] } });
    await vi.waitFor(() => expect(store.getMachineConnections().connections.m3).toBeTruthy());
    expect(store.getMachineConnections().machines.map((machine) => machine.name)).toContain("Studio");
  });

  it("delivers the native connection's states and messages to that machine's client only", async () => {
    await started();
    const { m1, m2 } = store.getMachineConnections().connections;
    const seen: string[] = [];
    m1!.client.onState((state) => seen.push(`m1:${state.state}`));
    m2!.client.onState((state) => seen.push(`m2:${state.state}`));
    remote({ kind: "state", connectionId: "conn-m1", state: { state: "connected", runtimeGeneration: 1, runtimeVersion: "0.2.33", capabilities: ["machine/1", "pty/1"], authority: "manage", link: 1 } });
    expect(seen).toEqual(["m1:idle", "m2:idle", "m1:connected"]);
    // activate is a no-op for a machine: there is no compute to wake.
    await m1!.activate("wake");
    expect(commands("cloud_remote_activate")).toHaveLength(0);
  });

  it("keeps a machine's connection through access removed, and Try again nudges the same owner", async () => {
    await started();
    const { m1 } = store.getMachineConnections().connections;
    remote({ kind: "state", connectionId: "conn-m1", state: { state: "stopped" } });
    expect(commands("cloud_remote_detach")).toHaveLength(0);
    expect(api.hasWorkspaceConnection({ kind: "machine", machineId: "m1" })).toBe(true);
    await store.reconnectMachine("m1");
    expect(commands("machines_reconnect").map(([, args]) => args)).toEqual([{ machineId: "m1" }]);
    expect(store.getMachineConnections().connections.m1).toBe(m1);
  });

  it("says why a machine could not be attached, and attaches it on Try again", async () => {
    attachRefusal = { m2: "machine_token_missing" };
    stop = store.startMachineConnections();
    await vi.waitFor(() => expect(store.getMachineConnections().attachErrors.m2).toBe("machine_token_missing"));
    expect(store.getMachineConnections().connections.m2).toBeUndefined();
    attachRefusal = {};
    await store.reconnectMachine("m2");
    expect(store.getMachineConnections().connections.m2).toBeTruthy();
    expect(store.getMachineConnections().attachErrors.m2).toBeUndefined();
    expect(commands("machines_reconnect")).toHaveLength(0);
  });

  it("closes every machine connection when Machines is turned off, and leaves a machine's view", async () => {
    await started();
    sessions.selectCloudWorkspace("machine:m1");
    stop!();
    stop = null;
    expect(store.getMachineConnections().connections).toEqual({});
    expect(mocks.detachCloudTerminals).toHaveBeenCalledWith("machine:m1");
    expect(mocks.detachCloudTerminals).toHaveBeenCalledWith("machine:m2");
    expect(api.hasWorkspaceConnection({ kind: "machine", machineId: "m1" })).toBe(false);
    await vi.waitFor(() => expect(commands("cloud_remote_detach").map(([, args]) => args).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ connectionId: "conn-m1" }, { connectionId: "conn-m2" }]));
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBeNull();
  });

  it("closes a machine no longer paired", async () => {
    await started();
    paired = [MAC_MINI];
    await store.refreshPairedMachines();
    expect(Object.keys(store.getMachineConnections().connections)).toEqual(["m1"]);
    expect(api.hasWorkspaceConnection({ kind: "machine", machineId: "m2" })).toBe(false);
  });

  it("keeps machine connections through sign-out and an organization switch", async () => {
    await started();
    api.closeWorkspaceConnections();
    api.closeWorkspaceConnectionsIn("org-1");
    expect(api.hasWorkspaceConnection({ kind: "machine", machineId: "m1" })).toBe(true);
    expect(api.hasWorkspaceConnection({ kind: "machine", machineId: "m2" })).toBe(true);
    expect(commands("cloud_remote_detach")).toHaveLength(0);
  });

  it("says why the paired machines could not be read", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "machines_list") throw "machines_store_unreadable";
      return [];
    });
    stop = store.startMachineConnections();
    await vi.waitFor(() => expect(store.getMachineConnections()).toMatchObject({ ready: true, error: "machines_store_unreadable", machines: [] }));
  });
});

describe("connection states the person sees (PRO-352, 21.09)", () => {
  const DIRECT = { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.2:6768/machine/1" }, since: 1, rttMs: 9 } as const;
  const RELAY = { state: "relay", route: { kind: "relay", endpoint: null }, since: 1, rttMs: 40 } as const;

  it("counts a link as coming back only after the machine was away, or after Try again", () => {
    expect(store.machineCameBack(undefined, DIRECT, false)).toBe(false);
    expect(store.machineCameBack({ state: "connecting", trying: ["lan"] }, DIRECT, false)).toBe(false);
    expect(store.machineCameBack({ state: "connecting", trying: ["lan"] }, DIRECT, true)).toBe(true);
    const away: MachineConnectionState[] = [
      { state: "reconnecting", lostAt: 1, attempt: 1, retryInMs: 250, trying: ["lan"] },
      { state: "offline", lastSeenAt: 1, retryInMs: 10_000 },
      { state: "updating", version: "0.2.34", since: 1 },
      { state: "accessRemoved" },
    ];
    for (const before of away) {
      expect(store.machineCameBack(before, RELAY, false)).toBe(true);
    }
    // Moving between direct and the relay is not news.
    expect(store.machineCameBack(RELAY, DIRECT, true)).toBe(false);
    expect(store.machineCameBack({ state: "offline", lastSeenAt: 1, retryInMs: 10_000 }, { state: "reconnecting", lostAt: 1, attempt: 1, retryInMs: 250, trying: [] }, true)).toBe(false);
  });

  it("raises Connected to the machine when it comes back, and not on the first link", async () => {
    const toasts = await import("@/lib/machineToasts");
    toasts.resetMachineToastsForTests();
    await started();
    changed({ machineId: "m1", state: { state: "connecting", trying: ["lan"] } });
    changed({ machineId: "m1", state: DIRECT });
    expect(toasts.getMachineToasts()).toEqual([]);

    changed({ machineId: "m1", state: { state: "offline", lastSeenAt: 7, retryInMs: 10_000 } });
    changed({ machineId: "m1", state: DIRECT });
    expect(toasts.getMachineToasts()).toMatchObject([{ kind: "connected", machineId: "m1", name: "Mac mini", route: { kind: "tailscale" } }]);
    // Lost again: the toast goes with the link.
    changed({ machineId: "m1", state: { state: "reconnecting", lostAt: 9, attempt: 1, retryInMs: 250, trying: ["lan"] } });
    expect(toasts.getMachineToasts()).toEqual([]);
  });

  it("Disconnect pressed while an attach is under way lets go of that attach", async () => {
    let answer!: (id: string) => void;
    const plain = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "machine_remote_attach" && args?.machineId === "m1") return new Promise<string>((resolve) => (answer = resolve));
      return plain(command, args);
    });
    stop = store.startMachineConnections();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    store.disconnectMachine("m1");
    answer("conn-m1");
    await vi.waitFor(() => expect(store.getMachineConnections().connections.m2).toBeTruthy());
    await flush();
    expect(store.getMachineConnections().connections.m1).toBeUndefined();
    expect(api.hasWorkspaceConnection({ kind: "machine", machineId: "m1" })).toBe(false);
    expect(store.getMachineConnections().states.m1).toEqual({ state: "idle" });
  });

  it("keeps a disconnected machine Not connected here whatever later events and reads say, until Try again", async () => {
    await started();
    store.disconnectMachine("m1");
    // Another window still holds it: the owner keeps reporting it connected.
    changed({ machineId: "m1", state: DIRECT });
    views = [{ machineId: "m1", state: DIRECT }, { machineId: "m2", state: { state: "idle" } }];
    await store.refreshPairedMachines();
    expect(store.getMachineConnections().states.m1).toEqual({ state: "idle" });

    await store.reconnectMachine("m1");
    changed({ machineId: "m1", state: DIRECT });
    expect(store.getMachineConnections().states.m1).toMatchObject({ state: "direct" });
  });

  it("Disconnect lets go of the machine until Try again, and a read of the list does not attach it again", async () => {
    await started();
    changed({ machineId: "m1", state: DIRECT });
    store.disconnectMachine("m1");
    expect(store.getMachineConnections().connections.m1).toBeUndefined();
    expect(store.getMachineConnections().states.m1).toEqual({ state: "idle" });
    expect(store.isMachineDisconnected("m1")).toBe(true);
    await vi.waitFor(() => expect(commands("cloud_remote_detach").map(([, args]) => args)).toEqual([{ connectionId: "conn-m1" }]));

    await store.refreshPairedMachines();
    expect(store.getMachineConnections().connections.m1).toBeUndefined();
    expect(commands("machine_remote_attach").filter(([, args]) => (args as { machineId: string }).machineId === "m1")).toHaveLength(1);

    await store.reconnectMachine("m1");
    expect(store.isMachineDisconnected("m1")).toBe(false);
    expect(store.getMachineConnections().connections.m1).toBeTruthy();
    expect(commands("machine_remote_attach").filter(([, args]) => (args as { machineId: string }).machineId === "m1")).toHaveLength(2);
  });
});
