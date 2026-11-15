import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  status: { state: "signed-in", context: { account: "a", revision: "1" } },
  listeners: new Set<() => void>(), privacyListeners: new Set<() => void>(), private: false,
  api: { phase2DesktopContractsAvailable: vi.fn(), desktopInboxStream: vi.fn(), desktopInbox: vi.fn(), desktopInboxReceipts: vi.fn(), cloudWorkspaceReadMarker: vi.fn() },
  resync: vi.fn(), invoke: vi.fn(), invalidate: vi.fn(), reconcile: vi.fn(), configure: vi.fn(), enable: vi.fn(),
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
vi.mock("@/lib/cloudCatalog", () => ({ invalidateCloudInboxWorkspace: f.invalidate, resyncCloudInboxCatalog: f.resync }));
vi.mock("@/lib/cloudReadMarkers", async (original) => {
  const actual = await original<typeof import("./cloudReadMarkers")>();
  f.configure.mockImplementation(actual.configureCloudReadMarkers);
  f.reconcile.mockImplementation(actual.reconcileCloudReadMarker);
  f.enable.mockImplementation(actual.enableCloudReadMarkerWrites);
  return { ...actual, configureCloudReadMarkers: f.configure, reconcileCloudReadMarker: f.reconcile, enableCloudReadMarkerWrites: f.enable };
});
import { cloudActivityRead, reconcileCloudReadMarker, writeCloudReadMarker } from "./cloudReadMarkers";
import { applyDesktopInboxEvent, bootDesktopInbox, resetDesktopInbox, desktopInboxTransport } from "./desktopInbox";
const sync = () => f.listeners.forEach((fn) => fn());
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear(); f.private = false; f.status = { state: "signed-in", context: { account: "a", revision: "1" } }; f.api.desktopInboxStream.mockImplementation(() => new Promise(() => {})); });
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
    f.api.phase2DesktopContractsAvailable.mockResolvedValue(false);
    bootDesktopInbox(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.api.phase2DesktopContractsAvailable).toHaveBeenCalledTimes(1);
    expect(f.api.desktopInboxStream).not.toHaveBeenCalled(); expect(f.api.desktopInbox).not.toHaveBeenCalled();
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
