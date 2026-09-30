import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";

// CS-7 (PRO-61): the cloud connection manager. One connection per workspace
// however many surfaces hold it, one wake however many ask, idle close after
// five minutes, and at most four live connections, never closing the
// selected one.

const mocks = vi.hoisted(() => ({
  workspaceConnection: vi.fn(),
  hasWorkspaceConnection: vi.fn(() => true),
  detachCloudTerminals: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  workspaceConnection: mocks.workspaceConnection,
  hasWorkspaceConnection: mocks.hasWorkspaceConnection,
}));
vi.mock("@/lib/cloudTerminals", () => ({ detachCloudTerminals: mocks.detachCloudTerminals }));

const manager = await import("./cloudConnections");

/** A fake native connection: a client whose state the test drives. */
function fakeConnection(workspaceId: string) {
  const listeners = new Set<(state: WorkspaceConnectionState) => void>();
  let current: WorkspaceConnectionState = { state: "connecting", attempt: 1 };
  const client = {
    get connection() {
      return current;
    },
    onState: (listener: (state: WorkspaceConnectionState) => void) => {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
  };
  return {
    target: { kind: "cloud", organizationId: "org", workspaceId },
    client,
    activate: vi.fn(async () => undefined),
    close: vi.fn(),
    emit(state: WorkspaceConnectionState) {
      current = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
}

const connected: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: ["session/1", "session/2"], authority: "manage" };
const opened = new Map<string, ReturnType<typeof fakeConnection>>();

beforeEach(() => {
  opened.clear();
  mocks.workspaceConnection.mockReset().mockImplementation(async (target: { workspaceId: string }) => {
    let connection = opened.get(target.workspaceId);
    if (!connection) opened.set(target.workspaceId, (connection = fakeConnection(target.workspaceId)));
    return connection;
  });
  mocks.hasWorkspaceConnection.mockReset().mockReturnValue(true);
});

afterEach(() => {
  manager.resetCloudConnections();
  manager.setCloudConnectionClock(null);
  vi.useRealTimers();
});

const target = (workspaceId: string) => ({ orgId: "org", workspaceId });

describe("leases", () => {
  it("shares one connection among every surface that holds it", async () => {
    const [a, b] = await Promise.all([manager.retainCloudConnection(target("w1")), manager.retainCloudConnection(target("w1"))]);
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org", workspaceId: "w1" }, "connect");
    expect(a.client).toBe(b.client);
    expect(manager.cloudConnectionInfo("cloud:org:w1").refs).toBe(2);
    a.release();
    a.release();
    expect(manager.cloudConnectionInfo("cloud:org:w1").refs).toBe(1);
  });

  it("closes a connection five minutes after the last release, and keeps it when retained again in time", async () => {
    vi.useFakeTimers();
    const lease = await manager.retainCloudConnection(target("w1"));
    lease.release();
    vi.advanceTimersByTime(manager.IDLE_CLOSE_MS - 1);
    expect(opened.get("w1")!.close).not.toHaveBeenCalled();
    const again = await manager.retainCloudConnection(target("w1"));
    vi.advanceTimersByTime(manager.IDLE_CLOSE_MS * 2);
    expect(opened.get("w1")!.close).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    again.release();
    vi.advanceTimersByTime(manager.IDLE_CLOSE_MS);
    expect(opened.get("w1")!.close).toHaveBeenCalledTimes(1);
    expect(mocks.detachCloudTerminals).toHaveBeenCalledWith("cloud:org:w1");
    expect(manager.liveCloudConnections()).toEqual([]);
  });

  it("beyond four live connections closes the least recently used unheld one, never the selected one", async () => {
    let now = 0;
    manager.setCloudConnectionClock(() => now);
    const leases = [];
    for (const id of ["w1", "w2", "w3", "w4"]) {
      now += 10;
      leases.push(await manager.retainCloudConnection(target(id)));
    }
    // w1 is the oldest, but it is what the main slot shows.
    manager.setSelectedCloudConnection("cloud:org:w1");
    for (const lease of leases) {
      now += 10;
      lease.release();
    }
    now += 10;
    await manager.retainCloudConnection(target("w5"));
    expect(opened.get("w1")!.close).not.toHaveBeenCalled();
    expect(opened.get("w2")!.close).toHaveBeenCalledTimes(1);
    expect(manager.liveCloudConnections().sort()).toEqual(["cloud:org:w1", "cloud:org:w3", "cloud:org:w4", "cloud:org:w5"]);
  });
});

describe("wake", () => {
  it("two surfaces asking to wake produce exactly one wake", async () => {
    const [a, b, c] = await Promise.all([
      manager.wakeCloudConnection(target("w1")),
      manager.wakeCloudConnection(target("w1")),
      manager.wakeCloudConnection(target("w1")),
    ]);
    const wakes = mocks.workspaceConnection.mock.calls.filter((call) => call[1] === "wake").length + opened.get("w1")!.activate.mock.calls.length;
    expect(wakes).toBe(1);
    expect(a.client).toBe(b.client);
    expect(c.client).toBe(a.client);
    // A later wake of the same connection does not ask again.
    await manager.wakeCloudConnection(target("w1"));
    expect(mocks.workspaceConnection.mock.calls.filter((call) => call[1] === "wake").length + opened.get("w1")!.activate.mock.calls.length).toBe(1);
  });

  it("raises a connection opened to look (connect) to wake once", async () => {
    const looking = await manager.retainCloudConnection(target("w1"));
    await Promise.all([manager.wakeCloudConnection(target("w1")), manager.wakeCloudConnection(target("w1"))]);
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(opened.get("w1")!.activate).toHaveBeenCalledTimes(1);
    expect(opened.get("w1")!.activate).toHaveBeenCalledWith("wake");
    looking.release();
  });

  it("looking never wakes: retaining with connect makes no wake", async () => {
    await manager.retainCloudConnection(target("w1"));
    await manager.retainCloudConnection(target("w1"));
    expect(mocks.workspaceConnection.mock.calls.every((call) => call[1] === "connect")).toBe(true);
    expect(opened.get("w1")!.activate).not.toHaveBeenCalled();
  });
});

describe("connected listeners", () => {
  it("run on every connect and are undone when it goes away", async () => {
    const undo = vi.fn();
    const seen = vi.fn(() => undo);
    const stop = manager.onCloudConnected(seen);
    const lease = await manager.retainCloudConnection(target("w1"));
    const connection = opened.get("w1")!;
    connection.emit(connected);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(manager.cloudConnectionInfo("cloud:org:w1").capabilities).toEqual(["session/1", "session/2"]);
    connection.emit({ state: "suspended" });
    expect(undo).toHaveBeenCalledTimes(1);
    connection.emit(connected);
    expect(seen).toHaveBeenCalledTimes(2);
    lease.release();
    stop();
  });

  it("waits for connected, and refuses a stopped workspace only when asked to", async () => {
    const lease = await manager.retainCloudConnection(target("w1"));
    const connection = opened.get("w1")!;
    connection.emit({ state: "suspended" });
    await expect(manager.waitCloudConnected(lease.client, 1000, { stoppedIsError: true })).rejects.toThrow("cloud_workspace_stopped");
    const waiting = manager.waitCloudConnected(lease.client, 1000);
    connection.emit(connected);
    await expect(waiting).resolves.toBeUndefined();
  });
});
