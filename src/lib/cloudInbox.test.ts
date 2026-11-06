// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus } from "./api";
const mocks = vi.hoisted(() => ({
  status: { state: "signed-out" } as AccountStatus,
  listeners: [] as (() => void)[],
  subscribe: vi.fn(), stop: vi.fn(), markers: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: mocks.status }), subscribeAccount: (fn: () => void) => mocks.listeners.push(fn) }));
vi.mock("@/lib/cloudCatalog", () => ({ invalidateCloudCatalog: mocks.refresh }));
vi.mock("@/lib/desktopInbox", () => ({ subscribeInbox: mocks.subscribe }));
vi.mock("@/lib/cloudReadMarkers", () => ({ setReadMarkerAccount: mocks.markers, mergeReadMarkers: vi.fn(), flushReadMarkers: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteOrganizationEvent: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const { bootCloudInbox } = await import("./cloudInbox");
beforeEach(() => { mocks.subscribe.mockReturnValue(mocks.stop); });
it("owns one subscriber per account, preserving it across organization switches and cancelling on sign-out", () => {
  bootCloudInbox(); bootCloudInbox();
  expect(mocks.listeners).toHaveLength(1);
  const update = (account: string, inbox = true) => {
    mocks.status = { state: "signed-in", desktopInbox: inbox, organizations: [{ id: "org", cloud: { enabled: true, flags: { "team.events.v1": true } } }], context: { account, scope: "org", revision: "1" } } as AccountStatus;
    mocks.listeners[0]();
  };
  update("A", false); expect(mocks.subscribe).not.toHaveBeenCalled();
  update("A"); expect(mocks.subscribe).toHaveBeenCalledOnce();
  update("A"); expect(mocks.subscribe).toHaveBeenCalledOnce();
  update("B"); expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  mocks.status = { state: "signed-out" } as AccountStatus; mocks.listeners[0]();
  expect(mocks.stop).toHaveBeenCalledTimes(2);
  expect(mocks.markers).toHaveBeenLastCalledWith(null, expect.any(Function));
});

it("retains and replays an event when its required catalog invalidation fails", async () => {
  vi.useFakeTimers();
  const { subscribeInbox } = await vi.importActual<typeof import("./desktopInbox")>("./desktopInbox");
  mocks.status = { state: "signed-in", desktopInbox: true, catalogFeed: true, organizations: [{ id: "org", cloud: { enabled: true, flags: { "team.events.v1": true } } }], context: { account: "retry", scope: "org", revision: "1" } } as AccountStatus;
  mocks.listeners[0]();
  const effects = mocks.subscribe.mock.calls.at(-1)![1];
  const batch = { cursor: "1", more: false, events: [{ id: "1", orgId: "org", workspaceId: "ws", type: "share.added", payload: {} }] };
  const receipt = vi.fn().mockResolvedValue(undefined);
  mocks.refresh.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const cancel = subscribeInbox({
    stream: async (_cursor, receive, signal) => {
      receive(batch);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    poll: vi.fn().mockResolvedValue(batch), receipt,
  }, { ...effects, fallback: () => undefined });
  try {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(receipt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(receipt).toHaveBeenCalledWith("1");
    expect(mocks.refresh).toHaveBeenCalledWith("org");
  } finally { cancel(); vi.useRealTimers(); }
});

it("pauses the account subscriber when all organization event flags turn off and resumes when enabled", () => {
  const stopCount = mocks.stop.mock.calls.length;
  const subscribeCount = mocks.subscribe.mock.calls.length;
  mocks.status = { ...mocks.status, organizations: [{ id: "org", cloud: { enabled: true, flags: {} } }] } as AccountStatus;
  mocks.listeners[0]();
  expect(mocks.stop).toHaveBeenCalledTimes(stopCount + 1);
  expect(mocks.markers).toHaveBeenLastCalledWith(null, expect.any(Function));
  mocks.status = { ...mocks.status, organizations: [{ id: "org", cloud: { enabled: true, flags: { "team.events.v1": true } } }] } as AccountStatus;
  mocks.listeners[0]();
  expect(mocks.subscribe).toHaveBeenCalledTimes(subscribeCount + 1);
});
