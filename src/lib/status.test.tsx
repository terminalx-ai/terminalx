import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "./api";

const mocks = vi.hoisted(() => ({
  events: new Map<string, (event: { payload: UsageSnapshot }) => void>(),
  refresh: vi.fn<(...args: unknown[]) => Promise<UsageSnapshot>>(),
  usage: vi.fn<() => Promise<UsageSnapshot>>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: UsageSnapshot }) => void) => {
    mocks.events.set(name, callback);
    return () => mocks.events.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => true, isMinimized: async () => false }),
}));
vi.mock("@/lib/api", () => ({
  statusBar: {
    settings: async () => ({ visible: true, usage: true, resources: false, percent: "used", usageMode: "detailed" }),
    usage: mocks.usage,
    refreshUsage: mocks.refresh,
    resourceOverview: async () => ({ agentCount: 0, orphanCount: 0, rssBytes: null, pressure: null }),
    sampleResources: async () => ({ host: {}, processes: [], totalRssBytes: null }),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("revalidates on expiry and activation, and never lets a delayed command roll back a live publication", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const initial: UsageSnapshot = {
    revision: 1,
    claudeAccount: "account",
    claude: { retryAt: null, revalidateAt: 11_000, error: null },
    windows: [{ agent: "claude", key: "five_hour", label: "5h", usedPercent: 100, resetsAt: 11_000, updatedAt: 10_000, windowMinutes: 300, stale: false }],
  };
  mocks.usage.mockResolvedValue(initial);
  mocks.refresh.mockResolvedValue(initial);
  const { bootStatus, refreshUsage, useStatus } = await import("./status");
  let observed: ReturnType<typeof useStatus> | undefined;
  function Probe() { observed = useStatus(); return null; }
  render(<Probe />);
  await act(async () => { await bootStatus(); await refreshUsage(); });
  expect(mocks.refresh).toHaveBeenCalledTimes(1);

  let finish!: (snapshot: UsageSnapshot) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(observed?.usageRefreshing).toBe(true);
  const next: UsageSnapshot = {
    ...initial, revision: 3,
    claude: { retryAt: null, revalidateAt: 12_000, error: null },
    windows: [{ ...initial.windows[0], usedPercent: 1, resetsAt: 12_000, updatedAt: 11_000 }],
  };
  await act(async () => { mocks.events.get("status_usage")!({ payload: next }); });
  expect(observed?.usage.windows[0].usedPercent).toBe(1);
  await act(async () => { finish({ ...initial, revision: 2 }); await refreshUsage(); });
  expect(observed?.usage.windows[0].usedPercent).toBe(1);

  hidden.mockReturnValue(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  // A sleep/background deadline is retried on activation even though its
  // timer was consumed while polling was unavailable.
  vi.setSystemTime(20_000);
  hidden.mockReturnValue(false);
  const retry: UsageSnapshot = {
    ...next, revision: 4,
    claude: { retryAt: 80_000, revalidateAt: 80_000, error: "Rate limited" },
  };
  mocks.refresh.mockResolvedValue(retry);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await refreshUsage();
  });
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mocks.refresh).toHaveBeenCalledTimes(4);
  // Replaying that same expired retry deadline cannot make a hot loop.
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mocks.refresh).toHaveBeenCalledTimes(4);

  mocks.refresh.mockRejectedValueOnce(new Error("transport offline"));
  await act(async () => { await refreshUsage(true); });
  expect(observed?.usageError).toContain("Usage refresh failed");
  expect(observed?.usage.windows[0].usedPercent).toBe(1);

  // An explicit refresh during a background request waits, then gets its own
  // manual attempt rather than silently reusing the background promise.
  mocks.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let background!: Promise<void>;
  let manual!: Promise<void>;
  await act(async () => {
    background = refreshUsage();
    manual = refreshUsage(true);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(mocks.refresh).toHaveBeenCalledTimes(6);
  await act(async () => { finish(retry); await background; await manual; });
  expect(mocks.refresh).toHaveBeenCalledTimes(7);
  expect(mocks.refresh).toHaveBeenLastCalledWith(true);
});
