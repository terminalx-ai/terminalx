import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: {} }));
vi.mock("./account", () => ({ getAccount: () => ({ status: { state: "signed-out" } }), subscribeAccount: () => () => {} }));
vi.mock("./cloudCatalog", () => ({ getCloudCatalog: () => ({ orgs: {} }), liveCloudOrgIds: () => [], subscribeCloudCatalog: () => () => {} }));
vi.mock("./cloudConnections", () => ({ cloudConnectionInfo: () => ({ state: "idle" }), liveCloudConnections: () => [], subscribeCloudConnections: () => () => {} }));
vi.mock("./dataPrivacy", () => ({ privacyEnabled: () => false, subscribeDataPrivacy: () => () => {} }));
vi.mock("./sessions", () => ({ getSessionStore: () => ({}), subscribeSessionStore: () => () => {} }));
import { PresenceController, type PresenceTransport } from "./cloudPresence";
const uuid = "01234567-89ab-4cde-8fab-0123456789ab";
const uuid2 = "01234567-89ab-4cde-9fab-0123456789ab";
const person = { userId: "person", displayName: "Person", photoUrl: null };
const read = (ids: string[], online = true) => ({ ttlSeconds: 45 as const, activeMembers: online ? [person] : [], workspaces: ids.map((workspaceId) => ({ workspaceId, owner: person, activeMembers: online ? [person] : [] })) });
let controller: PresenceController;
let transport: { put: ReturnType<typeof vi.fn<PresenceTransport["put"]>>; read: ReturnType<typeof vi.fn<PresenceTransport["read"]>> };
beforeEach(() => { vi.useFakeTimers(); transport = { put: vi.fn(async () => ({})), read: vi.fn(async (_org, ids) => read(ids)) }; controller = new PresenceController(transport, Date.now, vi.fn().mockReturnValueOnce(uuid).mockReturnValue(uuid2)); });
afterEach(() => { controller.dispose(); vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(0);
describe("PRO-133 current presence lifecycle", () => {
  it("does nothing until explicitly scoped, heartbeats every15s, clears and retires launch UUIDs", async () => {
    controller.setTarget({ orgId: "org", workspaceId: "first" }); await flush(); expect(transport.put).not.toHaveBeenCalled();
    controller.setScope("account/profile/session/revision"); controller.setTarget({ orgId: "org", workspaceId: "first" }); await flush();
    expect(transport.put).toHaveBeenLastCalledWith("org", { deviceId: uuid, sequence: 1, workspaceId: "first" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(transport.put).toHaveBeenLastCalledWith("org", { deviceId: uuid, sequence: 2, workspaceId: "first" });
    controller.setTarget({ orgId: "org", workspaceId: "second" }); await flush();
    expect(transport.put.mock.calls.slice(-2)).toEqual([["org", { deviceId: uuid, sequence: 3, workspaceId: null }], ["org", { deviceId: uuid2, sequence: 1, workspaceId: "second" }]]);
    controller.leave(); await flush(); expect(transport.put).toHaveBeenLastCalledWith("org", { deviceId: uuid2, sequence: 2, workspaceId: null });
  });
  it("retains a rate-limited leave and honors Retry-After without another UUID", async () => {
    controller.setScope("one"); controller.setTarget({ orgId: "org", workspaceId: "first" }); await flush();
    transport.put.mockRejectedValueOnce({ status: 429, retryAfterSeconds: 30 });
    controller.setTarget({ orgId: "org", workspaceId: "second" }); await flush();
    const count = transport.put.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000); expect(transport.put).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(transport.put.mock.calls[count]).toEqual(["org", { deviceId: uuid, sequence: 3, workspaceId: null }]);
    expect(transport.put).toHaveBeenLastCalledWith("org", { deviceId: uuid2, sequence: 1, workspaceId: "second" });
  });
  it("reads at15s, distinguishes a failed read from successful expired/offline presence", async () => {
    controller.setScope("one"); controller.watch("org", ["workspace"]); await flush();
    expect(controller.snapshot("org").state).toBe("live");
    transport.read.mockRejectedValueOnce(new Error("network")); await vi.advanceTimersByTimeAsync(15_000);
    expect(controller.snapshot("org")).toMatchObject({ state: "unavailable", activeMembers: [], at: null });
    transport.read.mockResolvedValueOnce(read(["workspace"], false)); await vi.advanceTimersByTimeAsync(15_000);
    expect(controller.snapshot("org")).toMatchObject({ state: "live", activeMembers: [], workspaces: [{ activeMembers: [] }] });
  });
  it("never accepts late account/session/target replies, including A-B-A and removed/readded orgs", async () => {
    let resolve!: (value: ReturnType<typeof read>) => void;
    transport.read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    controller.setScope("A"); controller.watch("org", ["private"]);
    controller.setScope("B"); controller.setScope("A"); controller.watch("org", ["visible"]); await flush();
    resolve(read(["private"])); await flush();
    expect(controller.snapshot("org").workspaces.map((row) => row.workspaceId)).toEqual(["visible"]);
    transport.read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    controller.hint("org"); controller.forget("org"); controller.watch("org", ["other"]); await flush(); resolve(read(["visible"])); await flush();
    expect(controller.snapshot("org").workspaces.map((row) => row.workspaceId)).toEqual(["other"]);
  });
  it("batches100 IDs, deduplicates authorized aggregate and immediately refreshes hints", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `workspace-${i}`);
    controller.setScope("one"); controller.watch("org", [...ids, ids[0]!]); await flush();
    expect(transport.read.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 1]);
    expect(controller.snapshot("org").activeMembers).toEqual([person]);
    controller.hint("org"); await flush(); expect(transport.read).toHaveBeenCalledTimes(6);
  });
  it("clears expired display while a refresh hangs and never labels unavailable offline", async () => {
    controller.setScope("one"); controller.watch("org", ["workspace"]); await flush();
    transport.read.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(controller.snapshot("org")).toMatchObject({ state: "stale", activeMembers: [] });
    controller.setScope(null); expect(controller.snapshot("org").state).toBe("unavailable");
  });
});

it("finishes a refused leave before returning to the same workspace with a fresh launch", async () => {
  controller.setScope("account:one");
  controller.setTarget({ orgId: "org", workspaceId: "workspace" }); await flush();
  transport.put.mockRejectedValueOnce({ status: 429, retryAfterSeconds: 30 });
  controller.leave(); await flush();
  controller.setTarget({ orgId: "org", workspaceId: "workspace" }); await flush();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(transport.put.mock.calls.slice(-2)).toEqual([
    ["org", { deviceId: uuid, sequence: 3, workspaceId: null }],
    ["org", { deviceId: uuid2, sequence: 1, workspaceId: "workspace" }],
  ]);
});
it("clears an old private attachment immediately when the authorized catalog drops it", async () => {
  controller.setScope("account:one"); controller.watch("org", ["private"]); await flush();
  expect(controller.snapshot("org").workspaces[0]?.workspaceId).toBe("private");
  let finish!: (value: ReturnType<typeof read>) => void;
  transport.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  controller.watch("org", []);
  expect(controller.snapshot("org")).toMatchObject({ state: "loading", activeMembers: [], workspaces: [] });
  controller.forget("org"); finish(read([])); await flush();
  expect(controller.snapshot("org").state).toBe("unavailable");
});
it("does not let a late write in an old account replace the new launch", async () => {
  let finish!: () => void;
  transport.put.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  controller.setScope("a:1"); controller.setTarget({ orgId: "org", workspaceId: "private" });
  controller.setScope("b:2"); controller.setScope("a:3");
  controller.setTarget({ orgId: "org", workspaceId: "visible" });
  finish(); await flush();
  expect(transport.put).toHaveBeenLastCalledWith("org", { deviceId: uuid2, sequence: 1, workspaceId: "visible" });
  expect(transport.put.mock.calls.filter(([, input]) => input.workspaceId === "private")).toHaveLength(1);
});

it("retains a leave queued behind a heartbeat even when selection returns before it settles", async () => {
  controller.setScope("account:one");
  controller.setTarget({ orgId: "org", workspaceId: "workspace" }); await flush();
  let finish!: () => void;
  transport.put.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(15_000);
  controller.setTarget({ orgId: "org", workspaceId: "other" });
  controller.setTarget({ orgId: "org", workspaceId: "workspace" });
  expect(transport.put).toHaveBeenCalledTimes(2);
  finish(); await flush();
  expect(transport.put.mock.calls.slice(-2)).toEqual([
    ["org", { deviceId: uuid, sequence: 3, workspaceId: null }],
    ["org", { deviceId: uuid2, sequence: 1, workspaceId: "workspace" }],
  ]);
});
it("retains a departure queued during heartbeat backoff before returning to the same target", async () => {
  controller.setScope("account:one");
  transport.put.mockRejectedValueOnce({ status: 429, retryAfterSeconds: 30 });
  controller.setTarget({ orgId: "org", workspaceId: "workspace" }); await flush();
  controller.leave();
  controller.setTarget({ orgId: "org", workspaceId: "workspace" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(transport.put.mock.calls.slice(-2)).toEqual([
    ["org", { deviceId: uuid, sequence: 2, workspaceId: null }],
    ["org", { deviceId: uuid2, sequence: 1, workspaceId: "workspace" }],
  ]);
});
