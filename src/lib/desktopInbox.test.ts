import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  status: { state: "signed-in", context: { account: "a", revision: "1" }, phase2Readiness: undefined as Record<string, string[]> | undefined },
  listeners: new Set<() => void>(), privacyListeners: new Set<() => void>(), catalogListeners: new Set<() => void>(), private: false,
  liveOrgs: ["org"], notify: vi.fn(async (_kind: string, _authorized: () => boolean) => {}),
  api: { phase2DesktopContractsAvailable: vi.fn(), desktopInboxStream: vi.fn(), desktopInbox: vi.fn(), desktopInboxReceipts: vi.fn(), cloudWorkspaceReadMarker: vi.fn() },
  presence: vi.fn(), catalog: { viewerUserId: "target", orgs: {} } as import("./cloudCatalog").CloudCatalogState,
  resync: vi.fn(async (): Promise<void> => {}), invoke: vi.fn(), invalidate: vi.fn(), reconcile: vi.fn(), configure: vi.fn(), enable: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ invoke: f.invoke }));
f.invoke.mockImplementation((command, args) => {
  switch (command) {
    case "phase2_desktop_contracts_available": return f.api.phase2DesktopContractsAvailable();
    case "desktop_inbox": return f.api.desktopInbox(args.after, args.waitMs);
    case "desktop_inbox_stream": return f.api.desktopInboxStream(args.after, args.lastEventId);
    case "desktop_inbox_receipts": return f.api.desktopInboxReceipts(args.eventIds);
    case "cloud_workspace_read_marker": return f.api.cloudWorkspaceReadMarker(args.orgId, args.workspaceId, args.readAt, args.sessionId);
    default: throw new Error(`Unexpected command: ${command}`);
  }
});
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: f.status }), subscribeAccount: (fn: () => void) => { f.listeners.add(fn); return () => f.listeners.delete(fn); } }));
vi.mock("@/lib/dataPrivacy", () => ({ PRIVACY_MESSAGE: "Turned off by data privacy mode", privacyEnabled: () => f.private, subscribeDataPrivacy: (fn: () => void) => { f.privacyListeners.add(fn); return () => f.privacyListeners.delete(fn); } }));
vi.mock("@/lib/cloudCatalog", () => ({
  invalidateCloudInboxWorkspace: f.invalidate, resyncCloudInboxCatalog: f.resync, getCloudCatalog: () => f.catalog,
  liveCloudOrgIds: () => f.liveOrgs,
  subscribeCloudCatalog: (fn: () => void) => { f.catalogListeners.add(fn); return () => f.catalogListeners.delete(fn); },
}));
vi.mock("@/lib/cloudPresence", () => ({ cloudPresence: { hint: f.presence } }));
vi.mock("@/lib/notify", () => ({ notifyOrganizationEvent: f.notify }));
vi.mock("@/lib/cloudReadMarkers", async (original) => {
  const actual = await original<typeof import("./cloudReadMarkers")>();
  f.configure.mockImplementation(actual.configureCloudReadMarkers);
  f.reconcile.mockImplementation(actual.reconcileCloudReadMarker);
  f.enable.mockImplementation(actual.enableCloudReadMarkerWrites);
  return { ...actual, configureCloudReadMarkers: f.configure, reconcileCloudReadMarker: f.reconcile, enableCloudReadMarkerWrites: f.enable };
});
import { cloudActivityRead, reconcileCloudReadMarker, writeCloudReadMarker } from "./cloudReadMarkers";
import { applyDesktopInboxEvent, bootDesktopInbox, resetDesktopInbox, desktopInboxTransport, getReassignedNotices } from "./desktopInbox";
const sync = () => f.listeners.forEach((fn) => fn());
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
  f.catalog = { viewerUserId: "target", orgs: {} } as import("./cloudCatalog").CloudCatalogState;
  f.private = false; f.liveOrgs = ["org"];
  f.status = { state: "signed-in", context: { account: "a", revision: "1" }, phase2Readiness: undefined };
  f.api.desktopInboxStream.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => { resetDesktopInbox(); vi.useRealTimers(); });
describe("desktop inbox integration", () => {
  it("invokes the accepted native commands with exact arguments without API casts", async () => {
    f.api.desktopInboxStream.mockResolvedValueOnce({ cursor: "7", events: [] });
    await desktopInboxTransport.phase2DesktopContractsAvailable();
    await desktopInboxTransport.desktopInbox("7", 25000);
    await desktopInboxTransport.desktopInboxStream("7");
    await desktopInboxTransport.desktopInboxReceipts(["7"]);
    await desktopInboxTransport.cloudWorkspaceReadMarker("o", "w", "2026-11-14T10:00:00Z");
    expect(f.invoke.mock.calls).toEqual([
      ["phase2_desktop_contracts_available", undefined],
      ["desktop_inbox", { after: "7", waitMs: 25000 }],
      ["desktop_inbox_stream", { after: "7", lastEventId: null }],
      ["desktop_inbox_receipts", { eventIds: ["7"] }],
      ["cloud_workspace_read_marker", { orgId: "o", workspaceId: "w", readAt: "2026-11-14T10:00:00Z", sessionId: null }],
    ]);
  });
  it("leaves inbox requests disabled when the native readiness command is absent", async () => {
    f.api.phase2DesktopContractsAvailable.mockRejectedValue(new Error("command not found"));
    bootDesktopInbox(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.api.phase2DesktopContractsAvailable).toHaveBeenCalledTimes(1);
    expect(f.api.desktopInbox).not.toHaveBeenCalled();
    expect(f.api.desktopInboxStream).not.toHaveBeenCalled();
  });
  it("blocks every transport command in privacy mode before native invocation", async () => {
    f.private = true;
    const calls = [
      desktopInboxTransport.phase2DesktopContractsAvailable(),
      desktopInboxTransport.desktopInbox("0", 25000),
      desktopInboxTransport.desktopInboxStream("0"),
      desktopInboxTransport.desktopInboxReceipts(["1"]),
      desktopInboxTransport.cloudWorkspaceReadMarker("o", "w", "2026-11-14T10:00:00Z", "s"),
    ];
    for (const call of calls) await expect(call).rejects.toThrow("Turned off by data privacy mode");
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("leaves production held when the authoritative gate is false even with organization readiness", async () => {
    f.status.phase2Readiness = { org: ["team.events.v1"] };
    f.api.phase2DesktopContractsAvailable.mockResolvedValue(false);
    bootDesktopInbox(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.api.phase2DesktopContractsAvailable).toHaveBeenCalledTimes(1);
    expect(f.api.desktopInboxStream).not.toHaveBeenCalled(); expect(f.api.desktopInbox).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });
  it.each([true, false])("retains catalog markers ingested before readiness resolves to %s", async (ready) => {
    let resolve!: (value: boolean) => void;
    f.api.phase2DesktopContractsAvailable.mockReturnValue(new Promise((r) => { resolve = r; }));
    localStorage.setItem("terminalx.inbox.v1:a", '{"cursor":"20","seen":[],"receipts":[]}');
    bootDesktopInbox();
    expect(f.configure).toHaveBeenLastCalledWith("a", null);
    const at = "2026-11-14T10:00:00Z";
    // The catalog can arrive before the native gate; the marker event is below the saved checkpoint.
    reconcileCloudReadMarker("o", "w", { sessionId: "s", readAt: at });
    expect(cloudActivityRead("o", "w", "s", at)).toBe(true);
    await writeCloudReadMarker("o", "w", "s", at);
    expect(f.api.cloudWorkspaceReadMarker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0); resolve(ready); await vi.advanceTimersByTimeAsync(0);
    expect(cloudActivityRead("o", "w", "s", at)).toBe(true);
    if (ready) expect(f.api.desktopInboxStream).toHaveBeenCalledWith("20", "20");
    else expect(f.api.desktopInboxStream).not.toHaveBeenCalled();
  });
  it("discards delayed readiness for a previous account", async () => {
    let resolve!: (value: boolean) => void;
    f.api.phase2DesktopContractsAvailable.mockReturnValueOnce(new Promise((r) => { resolve = r; })).mockResolvedValue(false);
    bootDesktopInbox(); await vi.advanceTimersByTimeAsync(0);
    f.status.context.account = "b"; sync(); resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(f.api.desktopInboxStream).not.toHaveBeenCalled();
  });
  it("stops on privacy and clears old account cursor state", async () => {
    f.api.phase2DesktopContractsAvailable.mockResolvedValue(true);
    bootDesktopInbox(); await vi.advanceTimersByTimeAsync(0);
    localStorage.setItem("terminalx.inbox.v1:a", '{"cursor":"5","seen":[],"receipts":[]}');
    f.private = true; f.privacyListeners.forEach((fn) => fn());
    expect(localStorage.getItem("terminalx.inbox.v1:a")).toBeNull();
    expect(f.configure).toHaveBeenLastCalledWith(null, null);
  });
  it("clears saved state on an identity change while readiness is still pending", async () => {
    f.api.phase2DesktopContractsAvailable.mockImplementation(() => new Promise(() => {}));
    localStorage.setItem("terminalx.inbox.v1:a", '{"cursor":"20","seen":[],"receipts":["20"]}');
    bootDesktopInbox(); await vi.advanceTimersByTimeAsync(0);
    f.status.context.account = "b"; sync();
    expect(localStorage.getItem("terminalx.inbox.v1:a")).toBeNull();
    expect(f.configure).toHaveBeenLastCalledWith("b", null);
  });
  it("treats minimal removal as invalidation without inventing organization/content or notifications", () => {
    applyDesktopInboxEvent({ id: "1", workspaceId: "private", type: "workspace.share-removed", createdAt: "2026-11-14T10:00:00Z" });
    expect(f.invalidate).toHaveBeenCalledWith("private", undefined, true);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });
});

it("treats a coalesced marker as a catalog invalidation, retaining the monotonic hint", () => {
  const payload = { sessionId: "runtime-session", readAt: "2026-11-14T10:00:00Z" };
  applyDesktopInboxEvent({ id: "40", workspaceId: "w", organizationId: "o", type: "workspace.read-marker-changed", payload, createdAt: payload.readAt });
  expect(f.reconcile).toHaveBeenCalledWith("o", "w", payload);
  expect(f.invalidate).toHaveBeenCalledWith("w", "o");
});
it("resyncs startup even beyond retained history, but never while held or private", async () => {
  localStorage.setItem("terminalx.inbox.v1:a", '{"cursor":"9223372036854775807","seen":[],"receipts":[]}');
  f.api.phase2DesktopContractsAvailable.mockResolvedValue(true);
  bootDesktopInbox(); await vi.advanceTimersByTimeAsync(0);
  expect(f.resync).toHaveBeenCalledTimes(1);
  expect(f.api.desktopInboxStream).toHaveBeenCalledWith("9223372036854775807", "9223372036854775807");
  resetDesktopInbox(); f.resync.mockClear();
  f.api.phase2DesktopContractsAvailable.mockResolvedValue(false);
  bootDesktopInbox(); await vi.advanceTimersByTimeAsync(0);
  expect(f.resync).not.toHaveBeenCalled();
  resetDesktopInbox(); f.private = true;
  bootDesktopInbox(); await vi.advanceTimersByTimeAsync(0);
  expect(f.resync).not.toHaveBeenCalled();
});


it("treats presence as an authorized refresh hint and retains checkpoints through the subscriber", () => {
  applyDesktopInboxEvent({ id: "9007199254740993", type: "workspace.presence-changed", organizationId: "org", workspaceId: "workspace", payload: {}, createdAt: "2026-11-15T12:00:00Z" });
  expect(f.presence).toHaveBeenCalledWith("org");
  expect(f.invalidate).toHaveBeenCalledWith("workspace", "org");
});

const share = { id: "8", type: "workspace.share-added", organizationId: "org", workspaceId: "workspace", payload: {}, createdAt: "2026-11-15T12:00:00Z" } as const;
const reassignment = { ...share, type: "workspace.reassigned", payload: { actorId: "actor", previousOwnerId: "old", note: "Away until Monday" } } as const;
const removal = { id: "9", type: "workspace.share-removed", workspaceId: share.workspaceId, createdAt: share.createdAt } as const;
const inboxKey = "terminalx.inbox.v1:a";

function deliver(...events: import("./api").DesktopInboxEvent[]) {
  f.status.phase2Readiness = { org: ["team.events.v1", "team.follow-reassign.v1"] };
  f.api.phase2DesktopContractsAvailable.mockResolvedValue(true);
  f.api.desktopInboxStream.mockResolvedValueOnce({ cursor: events.at(-1)!.id, events });
  bootDesktopInbox();
}

function setWorkspace({ createdBy = "target", accessMode = "organization", source = "live", role = "driver" } = {}) {
  f.catalog = {
    revision: "1", viewerUserId: "target",
    orgs: { org: { source, error: null, requestedAt: Date.now(), workspaces: [
      { workspace: { id: share.workspaceId, orgId: "org", accessMode, createdBy, name: "Visible", you: { role } } },
    ] } },
  } as unknown as import("./cloudCatalog").CloudCatalogState;
  f.catalogListeners.forEach((fn) => fn());
}

it("notifies a share after a fresh live list and deduplicates replay after relaunch", async () => {
  setWorkspace();
  deliver(share, share);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.notify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  setWorkspace({ source: "saved" });
  expect(f.notify).not.toHaveBeenCalled();
  setWorkspace();
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("share-added", expect.any(Function));
  expect(f.notify.mock.calls[0][1]()).toBe(true);
  expect(getReassignedNotices()).toEqual([]);
  expect(JSON.parse(localStorage.getItem(inboxKey)!)).toEqual({ cursor: "8", seen: [], receipts: ["8"] });
  resetDesktopInbox();
  deliver(share);
  await vi.advanceTimersByTimeAsync(1);
  setWorkspace();
  expect(f.notify).toHaveBeenCalledTimes(1);
});

it("keeps the authorized reassignment notice and routes a generic banner", async () => {
  deliver(reassignment);
  await vi.advanceTimersByTimeAsync(0);
  setWorkspace();
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("reassigned", expect.any(Function));
  expect(getReassignedNotices()).toEqual([{ id: "8", organizationId: "org", workspaceId: "workspace", name: "Visible", actorId: "actor", previousOwnerId: "old", note: "Away until Monday" }]);
  expect(localStorage.getItem(inboxKey)).not.toContain("Away until Monday");
});

it.each([
  { event: share, workspace: { accessMode: "private" } },
  { event: share, workspace: { role: "none" } },
  { event: reassignment, workspace: { createdBy: "someone-else" } },
])("drops a notice when a fresh list denies access", async ({ event, workspace }) => {
  deliver(event);
  await vi.advanceTimersByTimeAsync(0);
  setWorkspace(workspace);
  setWorkspace();
  expect(f.notify).not.toHaveBeenCalled();
  expect(getReassignedNotices()).toEqual([]);
});

it.each(["account", "privacy", "membership", "organization gate", "revocation"] as const)(
  "fences a pending native banner after %s changes", async (change) => {
    deliver(reassignment);
    await vi.advanceTimersByTimeAsync(0);
    setWorkspace();
    const authorized = f.notify.mock.calls[0][1];
    expect(authorized()).toBe(true);
    switch (change) {
      case "account": f.status.context.account = "b"; sync(); break;
      case "privacy": f.private = true; f.privacyListeners.forEach((fn) => fn()); break;
      case "membership": f.liveOrgs = []; break;
      case "organization gate": f.status.phase2Readiness = { other: ["team.events.v1"] }; sync(); break;
      case "revocation": applyDesktopInboxEvent(removal); expect(getReassignedNotices()).toEqual([]); break;
    }
    expect(authorized()).toBe(false);
  },
);

it("keeps a share for an organization without event readiness quiet when another organization enables the inbox", async () => {
  deliver(share);
  f.status.phase2Readiness = { other: ["team.events.v1"] };
  await vi.advanceTimersByTimeAsync(0);
  setWorkspace();
  expect(f.invalidate).toHaveBeenCalledWith(share.workspaceId, "org");
  expect(f.notify).not.toHaveBeenCalled();
});

it("invalidates a queued share revoked within the same page", async () => {
  deliver(share, removal);
  await vi.advanceTimersByTimeAsync(0);
  setWorkspace();
  expect(f.notify).not.toHaveBeenCalled();
});

it("does not notify when recording delivery fails", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("disk full"); });
  try {
    deliver(share);
    await vi.advanceTimersByTimeAsync(0);
    setWorkspace();
    expect(localStorage.getItem(inboxKey)).toBeNull();
    expect(f.notify).not.toHaveBeenCalled();
  } finally { setItem.mockRestore(); }
});

it("checkpoints mixed presence and coalesced marker hints while retaining startup resync", async () => {
  f.api.phase2DesktopContractsAvailable.mockResolvedValue(true);
  f.api.desktopInboxStream.mockResolvedValueOnce({ cursor: "22", events: [
    { id: "21", type: "workspace.presence-changed", organizationId: "org", workspaceId: "workspace", payload: {}, createdAt: "2026-11-15T12:00:00Z" },
    { id: "22", type: "workspace.read-marker-changed", organizationId: "org", workspaceId: "workspace", payload: { sessionId: "session", readAt: "2026-11-15T12:00:00Z" }, createdAt: "2026-11-15T12:00:00Z" },
  ] });
  bootDesktopInbox(); await vi.advanceTimersByTimeAsync(0);
  expect(f.resync).toHaveBeenCalled();
  expect(f.presence).toHaveBeenCalledWith("org");
  expect(f.reconcile).toHaveBeenCalledWith("org", "workspace", { sessionId: "session", readAt: "2026-11-15T12:00:00Z" });
  expect(JSON.parse(localStorage.getItem("terminalx.inbox.v1:a")!).cursor).toBe("22");
  expect(getReassignedNotices()).toEqual([]);
  expect(f.notify).not.toHaveBeenCalled();
});
