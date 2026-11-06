// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus } from "./api";
const mocks = vi.hoisted(() => ({
  status: { state: "signed-out" } as AccountStatus,
  listeners: [] as (() => void)[],
  subscribe: vi.fn(), stop: vi.fn(), markers: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: mocks.status }), subscribeAccount: (fn: () => void) => mocks.listeners.push(fn) }));
vi.mock("@/lib/cloudCatalog", () => ({ refreshCloudFeed: mocks.refresh, refreshCloudCatalog: mocks.refresh }));
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
    mocks.status = { state: "signed-in", desktopInbox: inbox, context: { account, scope: "org", revision: "1" } } as AccountStatus;
    mocks.listeners[0]();
  };
  update("A", false); expect(mocks.subscribe).not.toHaveBeenCalled();
  update("A"); expect(mocks.subscribe).toHaveBeenCalledOnce();
  update("A"); expect(mocks.subscribe).toHaveBeenCalledOnce();
  update("B"); expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  mocks.status = { state: "signed-out" } as AccountStatus; mocks.listeners[0]();
  expect(mocks.stop).toHaveBeenCalledTimes(2);
  expect(mocks.markers).toHaveBeenLastCalledWith(null);
});
