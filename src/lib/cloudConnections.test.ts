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

describe("every organization live (CS-18)", () => {
  it("holds sessions from two organizations open at the same time", async () => {
    const a = await manager.retainCloudConnection({ orgId: "org-a", workspaceId: "wa" });
    const b = await manager.retainCloudConnection({ orgId: "org-b", workspaceId: "wb" });
    opened.get("wa")!.emit(connected);
    opened.get("wb")!.emit(connected);
    expect(mocks.workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-a", workspaceId: "wa" }, "connect");
    expect(mocks.workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-b", workspaceId: "wb" }, "connect");
    expect(manager.liveCloudConnections().sort()).toEqual(["cloud:org-a:wa", "cloud:org-b:wb"]);
    expect(manager.cloudConnectionInfo("cloud:org-a:wa").state).toBe("connected");
    expect(manager.cloudConnectionInfo("cloud:org-b:wb").state).toBe("connected");
    a.release();
    b.release();
  });

  it("leaving an organization closes only its connections", async () => {
    await manager.retainCloudConnection({ orgId: "org-a", workspaceId: "wa" });
    await manager.retainCloudConnection({ orgId: "org-b", workspaceId: "wb" });
    manager.closeCloudConnectionsIn("org-b");
    expect(opened.get("wb")!.close).toHaveBeenCalled();
    expect(opened.get("wa")!.close).not.toHaveBeenCalled();
    expect(manager.liveCloudConnections()).toEqual(["cloud:org-a:wa"]);
  });
});

// Found in a live two-user test: the owner stopped the workspace with its
// session open, someone else woke it, and the owner's pane stayed on a dead
// client ("RPC transport unavailable") until the app was restarted.
describe("a workspace that stops and comes back", () => {
  /** Every attach is a new native connection, as in the app; closing one ends it. */
  let attached: ReturnType<typeof fakeConnection>[];
  let now: number;
  const key = "cloud:org:w1";
  const flush = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const wakes = () => mocks.workspaceConnection.mock.calls.filter((call) => call[1] === "wake").length + attached.reduce((sum, connection) => sum + connection.activate.mock.calls.length, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    attached = [];
    now = 1_000;
    manager.setCloudConnectionClock(() => now);
    mocks.workspaceConnection.mockReset().mockImplementation(async (connectionTarget: { workspaceId: string }) => {
      const connection = fakeConnection(connectionTarget.workspaceId);
      attached.push(connection);
      return connection;
    });
  });

  /** Held and connected, then stopped: the list said so, and the transport parked. */
  async function heldThenStopped() {
    const lease = await manager.retainCloudConnection(target("w1"));
    attached[0]!.emit(connected);
    manager.noteCloudWorkspaceListed(target("w1"), { running: true, at: now });
    now += 100;
    manager.noteCloudWorkspaceListed(target("w1"), { running: false, at: now });
    now += 100;
    attached[0]!.emit({ state: "suspended" });
    await flush();
    return lease;
  }

  it("attaches a held connection fresh with connect when a newer list says it runs again, and never wakes", async () => {
    const undo = vi.fn();
    const seen = vi.fn(() => undo);
    const stop = manager.onCloudConnected(seen);
    const lease = await heldThenStopped();
    expect(lease.state()).toEqual({ state: "suspended" });
    expect(attached).toHaveLength(1);

    // Someone else woke it: a list asked for after the transport parked says it runs.
    now += 5_000;
    manager.noteCloudWorkspaceListed(target("w1"), { running: true, at: now });
    await flush();
    expect(attached).toHaveLength(2);
    expect(attached[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceConnection.mock.calls.map((call) => call[1])).toEqual(["connect", "connect"]);
    expect(mocks.detachCloudTerminals).toHaveBeenCalledWith(key);
    // The lease follows to the new connection, which is not live yet.
    expect(lease.current()).toBe(attached[1]);
    expect(lease.state().state).toBe("connecting");
    expect(manager.cloudConnectionInfo(key)).toMatchObject({ reattaching: true, refs: 1, woke: false });
    expect(manager.connectedCloudClient(key)).toBeNull();

    attached[1]!.emit({ ...connected, runtimeGeneration: 2 });
    expect(lease.state()).toMatchObject({ state: "connected", runtimeGeneration: 2 });
    expect(manager.cloudConnectionInfo(key)).toMatchObject({ state: "connected", reattaching: false, connects: 2 });
    expect(manager.connectedCloudClient(key)).toBe(attached[1]!.client);
    // Whoever follows connections reads everything again from the new client.
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith(target("w1"), attached[1]!.client);
    expect(wakes()).toBe(0);
    lease.release();
    stop();
  });

  it("does nothing on a list that was asked for before the transport parked", async () => {
    const lease = await manager.retainCloudConnection(target("w1"));
    attached[0]!.emit(connected);
    const asked = now;
    now += 100;
    // Stopped by someone else: this desktop's list still says ready.
    attached[0]!.emit({ state: "suspended" });
    manager.noteCloudWorkspaceListed(target("w1"), { running: true, at: asked });
    await flush(60_000);
    expect(attached).toHaveLength(1);
    expect(lease.state()).toEqual({ state: "suspended" });
    lease.release();
  });

  it("replaces a connection that still reads connected from before the stop", async () => {
    const lease = await manager.retainCloudConnection(target("w1"));
    attached[0]!.emit(connected);
    now += 100;
    manager.noteCloudWorkspaceListed(target("w1"), { running: false, at: now });
    now += 100;
    manager.noteCloudWorkspaceListed(target("w1"), { running: true, at: now });
    await flush();
    expect(attached).toHaveLength(2);
    expect(attached[0]!.close).toHaveBeenCalledTimes(1);
    expect(lease.current()).toBe(attached[1]);
    expect(wakes()).toBe(0);
    lease.release();
  });

  it("leaves alone a connection made after the stop (this desktop woke it)", async () => {
    const lease = await manager.retainCloudConnection(target("w1"));
    now += 100;
    manager.noteCloudWorkspaceListed(target("w1"), { running: false, at: now });
    attached[0]!.emit({ state: "waitingForRuntime" });
    now += 100;
    attached[0]!.emit(connected);
    now += 100;
    manager.noteCloudWorkspaceListed(target("w1"), { running: true, at: now });
    await flush(60_000);
    expect(attached).toHaveLength(1);
    expect(lease.state().state).toBe("connected");
    lease.release();
  });

  it("backs off while an attach keeps ending stopped, and only tries again on a newer list", async () => {
    const lease = await heldThenStopped();
    const relist = () => {
      now += 10;
      manager.noteCloudWorkspaceListed(target("w1"), { running: true, at: now });
    };
    relist();
    await flush();
    expect(attached).toHaveLength(2);
    // The new attach finds it stopped as well.
    attached[1]!.emit({ state: "suspended" });
    await flush(manager.REATTACH_MAX_MS);
    expect(attached).toHaveLength(2);
    relist();
    await flush(manager.REATTACH_FIRST_MS - 100);
    expect(attached).toHaveLength(2);
    await flush(200);
    expect(attached).toHaveLength(3);
    attached[2]!.emit({ state: "suspended" });
    relist();
    await flush(manager.REATTACH_FIRST_MS * 2 - 100);
    expect(attached).toHaveLength(3);
    await flush(200);
    expect(attached).toHaveLength(4);
    expect(wakes()).toBe(0);
    lease.release();
  });

  it("closes a parked connection nobody holds, so the next lease attaches fresh", async () => {
    const lease = await heldThenStopped();
    lease.release();
    now += 1_000;
    manager.noteCloudWorkspaceListed(target("w1"), { running: true, at: now });
    await flush();
    expect(attached[0]!.close).toHaveBeenCalledTimes(1);
    expect(attached).toHaveLength(1);
    expect(manager.liveCloudConnections()).toEqual([]);
    const again = await manager.retainCloudConnection(target("w1"));
    expect(again.current()).toBe(attached[1]);
    again.release();
  });

  it("forgets the wake that started it once the list says it stopped: the next action wakes anew", async () => {
    const lease = await manager.wakeCloudConnection(target("w1"));
    attached[0]!.emit(connected);
    manager.noteCloudWorkspaceListed(target("w1"), { running: true, at: now });
    expect(manager.cloudConnectionInfo(key).woke).toBe(true);
    now += 100;
    manager.noteCloudWorkspaceListed(target("w1"), { running: false, at: now });
    expect(manager.cloudConnectionInfo(key).woke).toBe(false);
    const again = await manager.wakeCloudConnection(target("w1"));
    expect(attached[0]!.activate).toHaveBeenCalledTimes(1);
    expect(attached[0]!.activate).toHaveBeenCalledWith("wake");
    lease.release();
    again.release();
  });

  it("a lease never reads connected once its connection was closed for good", async () => {
    const lease = await manager.retainCloudConnection(target("w1"));
    attached[0]!.emit(connected);
    expect(lease.state().state).toBe("connected");
    manager.closeCloudConnection(target("w1"));
    expect(lease.current()).toBeNull();
    expect(lease.state()).toEqual({ state: "idle" });
    // Another surface's later connection is not this lease's.
    const other = await manager.retainCloudConnection(target("w1"));
    attached[1]!.emit(connected);
    expect(lease.current()).toBeNull();
    expect(lease.state()).toEqual({ state: "idle" });
    other.release();
  });
});
