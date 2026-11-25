import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspace, CloudWorkspaceList, DesktopInboxEvent } from "./api";
import type { CloudCatalogState } from "./cloudCatalog";

const f = vi.hoisted(() => ({
  status: { state: "signed-in", context: { account: "a", revision: "1" }, phase2Readiness: undefined as Record<string, string[]> | undefined },
  listeners: new Set<() => void>(), privacyListeners: new Set<() => void>(), private: false,
  catalogListeners: new Set<() => void>(), liveOrgs: ["org"],
  api: { phase2DesktopContractsAvailable: vi.fn(), desktopInboxStream: vi.fn(), desktopInbox: vi.fn(), desktopInboxReceipts: vi.fn(), cloudWorkspaceReadMarker: vi.fn(), cloudWorkspaces: vi.fn<(org: string) => Promise<CloudWorkspaceList>>() },
  presence: vi.fn(), catalog: { revision: "1", viewerUserId: "target", orgs: {} } as CloudCatalogState,
  notify: vi.fn((_kind: string, _authorized: () => boolean) => new Promise<void>(() => {})),
  notifyMention: vi.fn(async (_name: string, _workspace: string, _authorized: () => boolean) => {}),
  roster: vi.fn(async (_org: string) => ({ members: [{ userId: "actor", email: "aisha@example.test", displayName: "Aisha Khan", role: "member" }] })),
  quote: vi.fn(async (_where: unknown): Promise<string | null> => "can you check the widths?"),
  prefs: { mentionNotifications: true },
  resync: vi.fn(async (): Promise<void> => {}), invoke: vi.fn(), invalidate: vi.fn(), reconcile: vi.fn(), configure: vi.fn(), enable: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: f.api, invoke: f.invoke }));
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
  cloudOrgArg: (org: string) => org, liveCloudOrgIds: () => f.liveOrgs,
  subscribeCloudCatalog: (fn: () => void) => { f.catalogListeners.add(fn); return () => f.catalogListeners.delete(fn); },
}));
vi.mock("@/lib/cloudPresence", () => ({ cloudPresence: { hint: f.presence } }));
vi.mock("@/lib/notify", () => ({ notifyOrganizationEvent: f.notify, notifyMention: f.notifyMention }));
vi.mock("@/lib/organizationRoster", () => ({ readOrganizationRoster: f.roster }));
vi.mock("@/lib/prefs", () => ({ getPrefs: () => f.prefs }));
vi.mock("@/lib/mentionNotices", async (original) => {
  const actual = await original<typeof import("./mentionNotices")>();
  return { ...actual, lookUpMentionQuote: f.quote };
});
vi.mock("@/lib/cloudAgents", () => ({ loadCloudAgents: vi.fn(), refreshFromCheckpoint: vi.fn() }));
vi.mock("@/lib/cloudDashboard", () => ({ openCloudSession: vi.fn() }));
vi.mock("@/lib/cloudReadMarkers", async (original) => {
  const actual = await original<typeof import("./cloudReadMarkers")>();
  f.configure.mockImplementation(actual.configureCloudReadMarkers);
  f.reconcile.mockImplementation(actual.reconcileCloudReadMarker);
  f.enable.mockImplementation(actual.enableCloudReadMarkerWrites);
  return { ...actual, configureCloudReadMarkers: f.configure, reconcileCloudReadMarker: f.reconcile, enableCloudReadMarkerWrites: f.enable };
});
import { cloudActivityRead, reconcileCloudReadMarker, writeCloudReadMarker } from "./cloudReadMarkers";
import { getMentionNotices, mentionMarked } from "./mentionNotices";
import { applyDesktopInboxEvent, bootDesktopInbox, resetDesktopInbox, desktopInboxTransport, getReassignedNotices } from "./desktopInbox";
const sync = () => f.listeners.forEach((fn) => fn());
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
  f.catalog = { revision: "1", viewerUserId: "target", orgs: {} } as CloudCatalogState;
  f.private = false; f.liveOrgs = ["org"]; f.prefs.mentionNotifications = true;
  f.status = { state: "signed-in", context: { account: "a", revision: "1" }, phase2Readiness: undefined };
  f.api.desktopInbox.mockReset().mockImplementation(async (after: string) => ({ cursor: after, events: [], hasMore: false }));
  f.api.desktopInboxStream.mockReset().mockImplementation(() => new Promise(() => {}));
  f.api.cloudWorkspaces.mockReset().mockResolvedValue({ workspaces: [] });
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
  it("leaves production held when the authoritative gate is false", async () => {
    deliver([share], false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.api.phase2DesktopContractsAvailable).toHaveBeenCalledTimes(1);
    expect(f.api.desktopInboxStream).not.toHaveBeenCalled(); expect(f.api.desktopInbox).not.toHaveBeenCalled();
    expect(f.api.cloudWorkspaces).not.toHaveBeenCalled();
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
const readiness = { org: ["team.events.v1", "team.follow-reassign.v1"] };

function listWorkspace(overrides: Partial<CloudWorkspace> = {}): CloudWorkspaceList {
  return { workspaces: [{
    workspace: {
      id: share.workspaceId, orgId: "org", name: "Visible", accessMode: "organization", provider: "mac",
      state: "ready", createdAt: 0, updatedAt: 0, releaseDisposition: null, createdBy: "target",
      you: { role: "driver", canApprove: true }, ...overrides,
    },
    latestOperation: null,
  }] };
}

function setCatalogList(list: CloudWorkspaceList, source: "live" | "cache" = "live") {
  f.catalog.orgs = {
    org: {
      orgId: "org", source, error: null, workspaces: list.workspaces,
      requestedAt: Date.now(), fetchedAt: Date.now(), sessions: {}, quota: null, repositories: null, repositoriesAt: null,
    },
  };
  f.catalogListeners.forEach((fn) => fn());
}

function deliver(events: DesktopInboxEvent[], ready = true, phase2Readiness: Record<string, string[]> = readiness) {
  f.status.phase2Readiness = phase2Readiness;
  f.api.phase2DesktopContractsAvailable.mockResolvedValue(ready);
  f.api.desktopInboxStream.mockResolvedValueOnce({ cursor: events.at(-1)!.id, events });
  bootDesktopInbox();
}

it("accepts a fresh request in the same millisecond as the old list and deduplicates replay", async () => {
  setCatalogList(listWorkspace());
  let oldRequestTime: number;
  let newRequestTime: number;
  let finish!: (list: CloudWorkspaceList) => void;
  f.api.cloudWorkspaces.mockImplementationOnce(() => {
    newRequestTime = Date.now();
    expect(JSON.parse(localStorage.getItem(inboxKey)!)).toEqual({ cursor: "8", seen: [], receipts: ["8"] });
    return new Promise((resolve) => { finish = resolve; });
  });
  f.status.phase2Readiness = readiness;
  f.api.phase2DesktopContractsAvailable.mockResolvedValue(true);
  f.api.desktopInboxStream.mockImplementationOnce(async () => {
    oldRequestTime = Date.now();
    f.catalog.orgs.org.requestedAt = oldRequestTime;
    return { cursor: "8", events: [share, share] };
  });
  bootDesktopInbox();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.api.cloudWorkspaces).toHaveBeenCalledExactlyOnceWith("org");
  expect(newRequestTime!).toBe(oldRequestTime!);
  finish(listWorkspace());
  await vi.advanceTimersByTimeAsync(1);
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("share-added", expect.any(Function));
  expect(f.notify.mock.calls[0][1]()).toBe(true);
  expect(getReassignedNotices()).toEqual([]);

  resetDesktopInbox();
  deliver([share]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.cloudWorkspaces).toHaveBeenCalledOnce();
  expect(f.notify).toHaveBeenCalledOnce();
});

it.each(["privacy", "account switch"] as const)("reconciles replay quietly after %s clears the checkpoint", async (transition) => {
  setCatalogList(listWorkspace());
  f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
  deliver([share]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.notify).toHaveBeenCalledOnce();
  if (transition === "privacy") {
    f.private = true;
    f.privacyListeners.forEach((fn) => fn());
  } else {
    f.status.context.account = "b";
    sync();
  }
  expect(localStorage.getItem(inboxKey)).toBeNull();
  f.api.desktopInbox
    .mockResolvedValueOnce({ cursor: "8", events: [share], hasMore: true })
    .mockResolvedValueOnce({ cursor: "9", events: [{ ...share, id: "9" }], hasMore: false });
  f.api.desktopInboxStream.mockResolvedValueOnce({ cursor: "10", events: [{ ...share, id: "10" }] });
  f.invalidate.mockClear();
  if (transition === "privacy") {
    f.private = false;
    f.privacyListeners.forEach((fn) => fn());
  } else {
    f.status.context.account = "a";
    sync();
  }
  await vi.advanceTimersByTimeAsync(2);
  expect(f.api.desktopInbox).toHaveBeenCalledWith("8", 0);
  expect(f.api.desktopInboxStream).toHaveBeenLastCalledWith("9", "9");
  expect(f.invalidate).toHaveBeenCalledTimes(3);
  expect(f.notify).toHaveBeenCalledTimes(2);
});

it("reauthorizes a targeted reassignment and preserves its plain-text actor and note", async () => {
  f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
  f.catalog.viewerUserId = undefined;
  deliver([reassignment]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.notify).not.toHaveBeenCalled();
  expect(getReassignedNotices()).toEqual([]);
  f.catalog.viewerUserId = "target";
  setCatalogList(listWorkspace());
  await vi.advanceTimersByTimeAsync(1);
  expect(f.resync).toHaveBeenCalled();
  expect(f.invalidate).toHaveBeenCalledWith("workspace", "org");
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("reassigned", expect.any(Function));
  expect(getReassignedNotices()).toEqual([{ id: "8", organizationId: "org", workspaceId: "workspace", name: "Visible", actorId: "actor", previousOwnerId: "old", note: "Away until Monday" }]);
  expect(localStorage.getItem(inboxKey)).not.toContain("Away until Monday");
});

it("does not let a later catalog row override a different owner in the authorization response", async () => {
  f.api.cloudWorkspaces.mockResolvedValue(listWorkspace({ createdBy: "someone-else" }));
  f.catalog.viewerUserId = undefined;
  deliver([reassignment]);
  await vi.advanceTimersByTimeAsync(1);
  f.catalog.viewerUserId = "target";
  setCatalogList(listWorkspace());
  expect(f.notify).not.toHaveBeenCalled();
  expect(getReassignedNotices()).toEqual([]);
});

it.each([
  { event: share, list: { workspaces: [] } },
  { event: share, list: listWorkspace({ accessMode: "private" }) },
  { event: share, list: listWorkspace({ you: { role: "none", canApprove: false } }) },
  { event: share, list: listWorkspace({ orgId: "other" }) },
  { event: share, list: { ...listWorkspace(), tombstones: [{ id: share.workspaceId, orgId: "org", deletedAt: 1, expiresAt: 2 }] } },
  { event: reassignment, list: listWorkspace({ createdBy: "someone-else" }) },
])("keeps cached content quiet when the fresh response does not authorize $event.type", async ({ event, list }) => {
  setCatalogList(listWorkspace(), "cache");
  f.api.cloudWorkspaces.mockResolvedValue(list);
  deliver([event]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.notify).not.toHaveBeenCalled();
  expect(getReassignedNotices()).toEqual([]);
});

it.each([
  { event: share, features: [] },
  { event: reassignment, features: ["team.events.v1"] },
])("keeps $event.type quiet without readiness for its organization and feature", async ({ event, features }) => {
  deliver([event], true, { org: features, other: ["team.events.v1", "team.follow-reassign.v1"] });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.invalidate).toHaveBeenCalledWith(share.workspaceId, "org");
  expect(f.api.cloudWorkspaces).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
});

it.each([share, reassignment])("discards a stale $type response after a concurrent catalog revocation", async (event) => {
  setCatalogList(listWorkspace());
  let finish!: (list: CloudWorkspaceList) => void;
  f.api.cloudWorkspaces.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  deliver([event]);
  await vi.advanceTimersByTimeAsync(1);
  setCatalogList({ workspaces: [] });
  finish(listWorkspace());
  await vi.advanceTimersByTimeAsync(1);
  expect(f.notify).not.toHaveBeenCalled();
  expect(getReassignedNotices()).toEqual([]);
});

it.each(["membership", "workspace", "owner", "organization"] as const)(
  "removes a published reassignment after banner completion on loss of %s access",
  async (change) => {
    f.notify.mockResolvedValueOnce(undefined);
    f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
    deliver([reassignment]);
    await vi.advanceTimersByTimeAsync(1);
    setCatalogList(listWorkspace());
    expect(getReassignedNotices()[0]?.note).toBe(reassignment.payload.note);
    switch (change) {
      case "membership": f.liveOrgs = []; sync(); break;
      case "workspace": setCatalogList({ workspaces: [] }); break;
      case "owner": setCatalogList(listWorkspace({ createdBy: "other" })); break;
      case "organization": f.catalog.orgs = {}; f.catalogListeners.forEach((fn) => fn()); break;
    }
    expect(getReassignedNotices()).toEqual([]);
  },
);

it("requires explicit target organization readiness even when the account inbox is available", async () => {
  deliver([share]);
  f.status.phase2Readiness = undefined;
  sync();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.desktopInboxStream).toHaveBeenCalled();
  expect(f.api.cloudWorkspaces).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
});

it("rejects authorization returned after switching accounts", async () => {
  let finish!: (list: CloudWorkspaceList) => void;
  f.api.cloudWorkspaces.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  deliver([reassignment]);
  await vi.advanceTimersByTimeAsync(1);
  f.status.context.account = "b"; sync();
  finish(listWorkspace());
  await vi.advanceTimersByTimeAsync(1);
  expect(f.notify).not.toHaveBeenCalled();
  expect(getReassignedNotices()).toEqual([]);
});

it.each(["privacy", "membership", "context", "organization gate", "catalog loss", "revocation"] as const)(
  "fences a banner waiting on permission after %s changes",
  async (change) => {
    setCatalogList(listWorkspace());
    f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
    deliver([reassignment]);
    await vi.advanceTimersByTimeAsync(1);
    const authorized = f.notify.mock.calls[0][1];
    expect(authorized()).toBe(true);
    switch (change) {
      case "privacy": f.private = true; f.privacyListeners.forEach((fn) => fn()); break;
      case "membership": f.liveOrgs = []; sync(); break;
      case "context": f.status.context.revision = "2"; sync(); break;
      case "organization gate": f.status.phase2Readiness = { org: ["team.events.v1"] }; sync(); break;
      case "catalog loss": setCatalogList({ workspaces: [] }); break;
      case "revocation": applyDesktopInboxEvent(removal); expect(getReassignedNotices()).toEqual([]); break;
    }
    expect(authorized()).toBe(false);
    expect(getReassignedNotices()).toEqual([]);
  },
);

it("drops a queued share revoked in the same page", async () => {
  deliver([share, removal]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.cloudWorkspaces).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
});

it("checks multiple saved events for the same organization with one live list", async () => {
  f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
  deliver([share, { ...reassignment, id: "9" }]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.cloudWorkspaces).toHaveBeenCalledExactlyOnceWith("org");
  expect(f.notify.mock.calls.map(([kind]) => kind)).toEqual(["share-added", "reassigned"]);
});

it("skips a banner when the event ID could not be saved", async () => {
  const setItem = Storage.prototype.setItem;
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (value.includes('"8"')) throw new Error("disk full");
    setItem.call(this, key, value);
  });
  try {
    deliver([share]);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(localStorage.getItem(inboxKey)!).cursor).toBe("0");
    expect(f.api.cloudWorkspaces).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
});

it("checkpoints mixed presence and coalesced marker hints while retaining startup resync", async () => {
  f.api.phase2DesktopContractsAvailable.mockResolvedValue(true);
  f.api.desktopInboxStream.mockResolvedValueOnce({ cursor: "22", events: [
    { id: "21", type: "workspace.presence-changed", organizationId: "org", workspaceId: "workspace", payload: {}, createdAt: "2026-11-15T12:00:00Z" },
    { id: "22", type: "workspace.read-marker-changed", organizationId: "org", workspaceId: "workspace", payload: { sessionId: "session", readAt: "2026-11-15T12:00:00Z" }, createdAt: "2026-11-15T12:00:00Z" },
  ] });
  bootDesktopInbox(); await vi.advanceTimersByTimeAsync(1);
  expect(f.resync).toHaveBeenCalled();
  expect(f.presence).toHaveBeenCalledWith("org");
  expect(f.reconcile).toHaveBeenCalledWith("org", "workspace", { sessionId: "session", readAt: "2026-11-15T12:00:00Z" });
  expect(JSON.parse(localStorage.getItem("terminalx.inbox.v1:a")!).cursor).toBe("22");
  expect(getReassignedNotices()).toEqual([]);
  expect(f.notify).not.toHaveBeenCalled();
});

describe("mentions (PRO-141)", () => {
  const mention = { id: "21", type: "workspace.mentioned", organizationId: "org", workspaceId: "workspace", payload: { actorId: "actor", sessionId: "sess-1", tabId: "tab-1", messageId: "msg-1" }, createdAt: "2026-11-25T10:00:00Z" } as const;
  const mentionReadiness = { org: ["team.events.v1", "team.mentions.v1"] };
  const rowKey = "cloud:org:workspace:sess-1";

  it("confirms access, then marks the row, shows the quoted notice, and bans the quote from the banner", async () => {
    f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
    deliver([mention], true, mentionReadiness);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.api.cloudWorkspaces).toHaveBeenCalledWith("org");
    expect(f.invalidate).toHaveBeenCalledWith("workspace", "org");
    expect(mentionMarked(rowKey)).toBe(true);
    expect(f.quote).toHaveBeenCalledWith({ organizationId: "org", workspaceId: "workspace", sessionId: "sess-1", tabId: "tab-1", messageId: "msg-1" });
    expect(getMentionNotices()).toMatchObject([{ id: "21", actorName: "Aisha Khan", workspaceName: "Visible", quote: "can you check the widths?", tabId: "tab-1" }]);
    expect(f.notifyMention).toHaveBeenCalledExactlyOnceWith("Aisha Khan", "Visible", expect.any(Function));
    expect(f.notify).not.toHaveBeenCalled();
    expect(localStorage.getItem(inboxKey)).not.toContain("widths");
  });

  it("with Mention notifications off: no notice and no banner, but the catalog still learns of the follow", async () => {
    f.prefs.mentionNotifications = false;
    f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
    deliver([mention], true, mentionReadiness);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.invalidate).toHaveBeenCalledWith("workspace", "org");
    expect(getMentionNotices()).toEqual([]);
    expect(f.notifyMention).not.toHaveBeenCalled();
    expect(f.quote).not.toHaveBeenCalled();
  });

  it.each([
    { name: "without the mentions readiness", features: ["team.events.v1"], list: listWorkspace() },
    { name: "when the live list no longer grants the workspace", features: mentionReadiness.org, list: listWorkspace({ you: { role: "none", canApprove: false } }) },
  ])("stays quiet $name", async ({ features, list }) => {
    f.api.cloudWorkspaces.mockResolvedValue(list);
    deliver([mention], true, { org: features });
    await vi.advanceTimersByTimeAsync(1);
    expect(getMentionNotices()).toEqual([]);
    expect(mentionMarked(rowKey)).toBe(false);
    expect(f.notifyMention).not.toHaveBeenCalled();
  });

  it("ignores a mention with malformed ids", async () => {
    f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
    deliver([{ ...mention, payload: { ...mention.payload, messageId: "bad id with spaces" } }], true, mentionReadiness);
    await vi.advanceTimersByTimeAsync(1);
    expect(getMentionNotices()).toEqual([]);
    expect(mentionMarked(rowKey)).toBe(false);
  });

  it("drops the mark and notice when the share is removed", async () => {
    f.api.cloudWorkspaces.mockResolvedValue(listWorkspace());
    deliver([mention], true, mentionReadiness);
    await vi.advanceTimersByTimeAsync(1);
    expect(mentionMarked(rowKey)).toBe(true);
    applyDesktopInboxEvent(removal);
    expect(mentionMarked(rowKey)).toBe(false);
    expect(getMentionNotices()).toEqual([]);
  });
});
