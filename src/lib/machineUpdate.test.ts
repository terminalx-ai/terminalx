import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcError, type WorkspaceConnectionState, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { pairedMachine } from "@/components/machines/machineFixtures.test-utils";
import type { MachineUpdateStatus } from "@/types/machines";

// The app's own updater and the Tauri bus, as the window sees them.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  update: { kind: "idle" } as { kind: string; [key: string]: unknown },
  updateListeners: new Set<() => void>(),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.33" }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, handler);
    return () => mocks.handlers.delete(name);
  }),
}));
vi.mock("@/lib/machineConnections", () => ({
  getMachineConnections: () => ({ ready: true, machines: [], states: {}, connections: {}, attachErrors: {}, error: null }),
  useMachineConnections: () => ({ ready: true, machines: [], states: {}, connections: {}, attachErrors: {}, error: null }),
  machineConnection: () => ({ machine: null, state: { state: "idle" }, connection: null, attachError: null }),
}));
vi.mock("@/lib/updates", () => ({
  checkForUpdate: mocks.checkForUpdate,
  installUpdate: mocks.installUpdate,
  getUpdateState: () => mocks.update,
  subscribeUpdate: (listener: () => void) => {
    mocks.updateListeners.add(listener);
    return () => mocks.updateListeners.delete(listener);
  },
}));

const update = await import("./machineUpdate");

function setUpdate(next: { kind: string; [key: string]: unknown }) {
  mocks.update = next;
  for (const listener of [...mocks.updateListeners]) listener();
}

function status(patch: Partial<MachineUpdateStatus> = {}): MachineUpdateStatus {
  return { method: "installer", current: "0.2.27", available: { version: "0.2.33" }, checkedAt: 1, blockers: [], otherComputers: [], kept: ["0.2.27"], progress: { phase: "idle" }, ...patch };
}

const connectedState = (capabilities: string[], runtimeVersion = "0.2.27"): WorkspaceConnectionState => ({ state: "connected", runtimeGeneration: 0, runtimeVersion, capabilities, authority: "manage", link: 1 });
const ALL = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "session/3", "session-status/1", "session-repository/1", "lifecycle/1", "agents/1", "agent-pty/1", "composer/1", "composer/2", "composer/3", "composer/4", "ports/1", "cleanup/1", "workspace/1", "workspace/2", "pipeline/1", "pipeline/2", "agent-commands/1", "machine/1", "machine/2", "machine/3", "machine/4", "machine/5", "machine/6", "machine/7", "machine/8"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.updateListeners.clear();
  mocks.update = { kind: "idle" };
  mocks.invoke.mockResolvedValue(null);
  update.resetMachineUpdateForTests();
});
afterEach(() => vi.useRealTimers());

ALL.push("machine/7");

describe("a machine's version view", () => {
  it("says Needs update on the chip when a connected machine hides a feature, and names the side", () => {
    const machine = pairedMachine({ machineId: "m1", name: "ci-box", version: "0.2.27" });
    const live = { state: "direct", route: { kind: "lan", endpoint: null }, since: 1, rttMs: 3 } as const;
    const view = update.machineVersionView(machine, live, null, connectedState(ALL.filter((name) => name !== "ports/1")), "0.2.33");
    expect(view.gap?.hidden.map((feature) => feature.id)).toEqual(["ports"]);
    expect(view.shownState).toEqual({ state: "needsUpdate", version: "0.2.27", side: "machine" });
    // Everything granted: the chip shows the connection as it is.
    expect(update.machineVersionView(machine, live, null, connectedState(ALL), "0.2.33").shownState).toBe(live);
    expect(update.machineVersionView(machine, live, null, connectedState(ALL.filter((name) => name !== "machine/7")), "0.2.33").gap?.hidden.map((feature) => feature.id)).toEqual(["sessionRuns"]);
  });

  it("shows the connection state, not Needs update, once a machine that hid a feature is no longer connected", () => {
    const machine = pairedMachine({ machineId: "m1", name: "ci-box", version: "0.2.27" });
    const lastConnected = connectedState(ALL.filter((name) => name !== "ports/1"));
    for (const state of [{ state: "connecting" }, { state: "offline", since: 1, reason: "" }, { state: "idle" }] as const) {
      const view = update.machineVersionView(machine, state as never, null, lastConnected, "0.2.33");
      expect(view.shownState).toBe(state);
      expect(view.gap).toBeNull();
    }
  });

  it("keeps Updating while the machine hands over", () => {
    const updating = { state: "updating", version: "0.2.34", since: 5 } as const;
    expect(update.machineVersionView(pairedMachine(), updating, null, { state: "reconnecting", attempt: 1, reason: "", retryInMs: 500 }, "0.2.33").shownState).toBe(updating);
  });

  it("offers this Mac's update for a newer machine that hides nothing", () => {
    const live = { state: "relay", route: { kind: "relay", endpoint: null }, since: 1, rttMs: null } as const;
    const view = update.machineVersionView(pairedMachine(), live, null, connectedState(ALL, "0.2.35"), "0.2.33");
    expect(view.gap).toBeNull();
    expect(view.newer).toBe(true);
    expect(view.version).toBe("0.2.35");
  });
});

describe("machine.update", () => {
  it("answers update_confirm with the status to confirm, and the confirmed request stops every blocker", async () => {
    const asked = status({ blockers: [{ id: "run-1", kind: "terminal", title: "npm run dev in tx-review-lab" }], otherComputers: [{ id: "c2", label: "Paresh’s MacBook Air" }] });
    const client = { updateMachine: vi.fn().mockRejectedValueOnce(new WorkspaceRpcError("update_confirm", "confirm", "machine.update", asked)) } as unknown as WorkspaceRpcClient;
    const outcome = await update.requestMachineUpdate("m1", client, { version: "0.2.33" }, "dev-server");
    expect(outcome).toEqual({ kind: "confirm", status: asked });
    expect(update.needsConfirmation(asked)).toBe(true);
    expect(update.needsConfirmation(status())).toBe(false);
    expect(update.confirmedRequest("0.2.33", asked)).toEqual({ version: "0.2.33", stop: ["run-1"], confirmedOthers: ["c2"] });
    expect(update.getMachineUpdate("m1").status).toEqual(asked);
  });

  it("says why a machine cannot update from here", async () => {
    const client = { updateMachine: vi.fn().mockRejectedValue(new WorkspaceRpcError("update_unavailable", "no", "machine.update")) } as unknown as WorkspaceRpcClient;
    const outcome = await update.requestMachineUpdate("m1", client, { version: "0.2.33" }, "dev-server");
    expect(outcome).toEqual({ kind: "failed", message: "dev-server cannot update from here. Update it the way it was installed, or open TerminalX on it." });
    expect(update.getMachineUpdate("m1").error).toBe(outcome.kind === "failed" ? outcome.message : null);
  });

  it("updates to what the machine offers; an installer machine offering nothing has no newer TerminalX yet", () => {
    expect(update.updateTarget(status({ available: { version: "0.2.34" } }), "0.2.33")).toBe("0.2.34");
    expect(update.updateTarget(status({ available: null }), "0.2.33")).toBeNull();
    // An app machine's own updater finds its version: it is asked to catch up to this desktop's.
    expect(update.updateTarget(status({ method: "app", available: null }), "0.2.33")).toBe("0.2.33");
    expect(update.updateTarget(null, null)).toBeNull();
  });
});

describe("another computer asks this Mac to update its app", () => {
  const reports = () => mocks.invoke.mock.calls.filter(([command]) => command === "machines_app_update_report").map(([, args]) => args);

  it("runs this Mac's updater and reports each step", async () => {
    mocks.checkForUpdate.mockImplementation(async () => {
      setUpdate({ kind: "available", update: { version: "0.2.34" } });
      return mocks.update;
    });
    mocks.installUpdate.mockImplementation(async () => {
      setUpdate({ kind: "installing", version: "0.2.34", pct: 40 });
      setUpdate({ kind: "installing", version: "0.2.34", pct: 100 });
    });
    await update.startAppUpdateResponder();
    mocks.handlers.get("machines_app_update_requested")!({ payload: { version: "0.2.34" } });
    await vi.waitFor(() => expect(reports()).toHaveLength(3));
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.installUpdate).toHaveBeenCalledTimes(1);
    expect(reports()).toEqual([
      { phase: "checking", step: null, message: null, available: null },
      { phase: "downloading", step: "0.2.34", message: null, available: "0.2.34" },
      { phase: "restarting", step: "0.2.34", message: null, available: null },
    ]);
  });

  it("reports up to date, and a failed check", async () => {
    mocks.checkForUpdate.mockResolvedValueOnce({ kind: "none" });
    await update.answerAppUpdateRequest();
    mocks.checkForUpdate.mockResolvedValueOnce({ kind: "error", message: "offline" });
    await update.answerAppUpdateRequest();
    expect(mocks.installUpdate).not.toHaveBeenCalled();
    expect(reports()).toEqual([
      { phase: "checking", step: null, message: null, available: null },
      { phase: "upToDate", step: null, message: null, available: null },
      { phase: "checking", step: null, message: null, available: null },
      { phase: "failed", step: null, message: "offline", available: null },
    ]);
  });
});
