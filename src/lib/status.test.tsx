import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResourceOverview, ResourceSnapshot, UsageSnapshot } from "./api";

const mocks = vi.hoisted(() => ({
  events: new Map<string, (event: { payload: UsageSnapshot }) => void>(),
  refresh: vi.fn<(...args: unknown[]) => Promise<UsageSnapshot>>(),
  usage: vi.fn<() => Promise<UsageSnapshot>>(),
  overview: vi.fn<() => Promise<ResourceOverview>>(async () => ({ agentCount: 0, orphanCount: 0, rssBytes: null, pressure: null })),
  sample: vi.fn<() => Promise<ResourceSnapshot>>(async () => ({
    host: { totalBytes: null, availableBytes: null, cores: 1 }, processes: [], totalRssBytes: null,
    totalCpuPercent: null, sampledAt: 0,
    app: { mainPid: 1, mainCpuPercent: null, mainRssBytes: null, webviewCpuPercent: null, webviewRssBytes: null, webviewProcessCount: 0 },
  })),
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
    settings: async () => ({ visible: true, usage: true, resources: false, percent: "used", usageMode: "detailed", usageRefreshMinutes: 0 }),
    usage: mocks.usage,
    refreshUsage: mocks.refresh,
    resourceOverview: mocks.overview,
    sampleResources: mocks.sample,
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

it("invalidates resource authority across disconnect and fences old boot, overview and sample replies", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const usage: UsageSnapshot = { revision: 20, windows: [], claudeAccount: "unchanged-account" };
  mocks.usage.mockResolvedValue(usage);
  mocks.refresh.mockResolvedValue(usage);
  const overview = (agentCount: number): ResourceOverview => ({ agentCount, orphanCount: 0, rssBytes: 1024, pressure: null });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  const bootRead = deferred<ResourceOverview>();
  const bootSample = deferred<ResourceSnapshot>();
  mocks.overview.mockImplementationOnce(() => bootRead.promise);
  mocks.sample.mockImplementationOnce(() => bootSample.promise);
  const store = await import("./status");
  let observed!: ReturnType<typeof store.useStatus>;
  function Probe() { observed = store.useStatus(); return null; }
  render(<Probe />);
  let boot!: Promise<void>;
  await act(async () => { boot = store.bootStatus(); });
  await act(async () => { mocks.events.get("local_runtime_disconnected")!({ payload: usage }); });
  await act(async () => { bootRead.resolve(overview(8)); await boot; });
  expect(observed.resourcesAvailable).toBe(false);
  expect(observed.resourceSample).toBeNull();
  expect(observed.usage).toEqual(usage);

  mocks.overview.mockResolvedValue(overview(2));
  await act(async () => { await store.refreshResourceOverview(); });
  expect(observed.resourcesAvailable).toBe(true);
  // An older detailed failure cannot erase a newer successful overview.
  await act(async () => { bootSample.reject(new Error("old owner")); await store.refreshResourceSample(); });
  expect(observed.resourcesAvailable).toBe(true);
  expect(observed.resources.agentCount).toBe(2);

  const oldFailure = deferred<ResourceOverview>();
  mocks.overview.mockImplementationOnce(() => oldFailure.promise);
  const oldRead = store.refreshResourceOverview();
  mocks.overview.mockResolvedValue(overview(3));
  await act(async () => { await store.refreshResourceOverview(); oldFailure.reject(new Error("late failure")); await oldRead; });
  expect(observed.resourcesAvailable).toBe(true);
  expect(observed.resources.agentCount).toBe(3);

  const lateOverview = deferred<ResourceOverview>();
  mocks.overview.mockImplementationOnce(() => lateOverview.promise);
  const reading = store.refreshResourceOverview();
  await act(async () => { mocks.events.get("local_runtime_disconnected")!({ payload: usage }); lateOverview.resolve(overview(99)); await reading; });
  expect(observed.resourcesAvailable).toBe(false);
  expect(observed.resourceSample).toBeNull();

  const lateSample = deferred<ResourceSnapshot>();
  mocks.sample.mockImplementationOnce(() => lateSample.promise);
  let sampling!: Promise<void>;
  await act(async () => { sampling = store.refreshResourceSample(); });
  const sample: ResourceSnapshot = {
    host: { totalBytes: null, availableBytes: null, cores: 1 }, processes: [], totalRssBytes: 8192,
    totalCpuPercent: null, sampledAt: 1,
    app: { mainPid: 1, mainCpuPercent: null, mainRssBytes: null, webviewCpuPercent: null, webviewRssBytes: null, webviewProcessCount: 0 },
  };
  await act(async () => { mocks.events.get("local_runtime_view_disconnected")!({ payload: usage }); lateSample.resolve(sample); await sampling; });
  expect(observed.resourcesAvailable).toBe(false);
  expect(observed.resourceSample).toBeNull();
  mocks.sample.mockResolvedValue(sample);
  await act(async () => { await store.refreshResourceSample(); });
  expect(observed.resourcesAvailable).toBe(true);
  expect(observed.resourceSample).toEqual(sample);

  mocks.overview.mockRejectedValueOnce(new Error("current read failed"));
  await act(async () => { await store.refreshResourceOverview(); });
  expect(observed.resourcesAvailable).toBe(false);
  expect(observed.resourceSample).toBeNull();
  const invalidatedGeneration = observed.resourceGeneration;
  expect(store.resourceGenerationIsCurrent(invalidatedGeneration)).toBe(false);
  mocks.overview.mockResolvedValue(overview(4));
  await act(async () => { mocks.events.get("local_runtime_reattached")!({ payload: usage }); });
  expect(observed.resourcesAvailable).toBe(true);
  expect(observed.resources.agentCount).toBe(4);
  expect(observed.resourceGeneration).toBeGreaterThan(invalidatedGeneration);
  expect(store.resourceGenerationIsCurrent(invalidatedGeneration)).toBe(false);
  expect(store.resourceGenerationIsCurrent(observed.resourceGeneration)).toBe(true);
  expect(observed.usage).toEqual(usage);
});
