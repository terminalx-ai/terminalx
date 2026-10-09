import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StatusBarSettings, UsageSnapshot } from "./api";

const mocks = vi.hoisted(() => ({
  settings: { visible: true, usage: true, resources: false, percent: "used", usageMode: "detailed", usageRefreshMinutes: 1 } as StatusBarSettings,
  refresh: vi.fn<(...args: unknown[]) => Promise<UsageSnapshot>>(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  // Never focused: periodic usage must not depend on it.
  getCurrentWindow: () => ({ isFocused: async () => false, isMinimized: async () => false }),
}));
vi.mock("@/lib/api", () => ({
  statusBar: {
    settings: async () => mocks.settings,
    setSettings: async (patch: Partial<StatusBarSettings>) => (mocks.settings = { ...mocks.settings, ...patch }),
    usage: async () => ({ windows: [] }),
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

const MINUTE = 60_000;

it("refreshes usage on one timer at the chosen interval, through slow requests, hiding, and changes of setting", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const snapshot: UsageSnapshot = { revision: 1, windows: [] };
  mocks.refresh.mockResolvedValue(snapshot);
  const { bootStatus, refreshUsage, setStatusSettings, useStatus } = await import("./status");
  let observed: ReturnType<typeof useStatus> | undefined;
  function Probe() { observed = useStatus(); return null; }
  render(<Probe />);
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const calls = () => mocks.refresh.mock.calls.length;
  const choose = (patch: Partial<StatusBarSettings>) => act(async () => { await setStatusSettings(patch); });

  // The default minute, with no popover, focus or interaction involved.
  await act(async () => { await bootStatus(); await refreshUsage(); });
  expect(calls()).toBe(1);
  await advance(MINUTE - 1);
  expect(calls()).toBe(1);
  await advance(1);
  expect(calls()).toBe(2);
  await advance(3 * MINUTE);
  expect(calls()).toBe(5);
  expect(mocks.refresh.mock.calls.every(([manual]) => manual === false)).toBe(true);

  // A slow request holds the timer; nothing overlaps it or queues behind it.
  let finish!: (value: UsageSnapshot) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await advance(MINUTE);
  expect(calls()).toBe(6);
  expect(observed?.usageRefreshing).toBe(true);
  await advance(10 * MINUTE);
  expect(calls()).toBe(6);
  await act(async () => { finish(snapshot); await vi.advanceTimersByTimeAsync(0); });
  expect(calls()).toBe(6);
  await advance(MINUTE - 1);
  expect(calls()).toBe(6);
  await advance(1);
  expect(calls()).toBe(7);

  // Hidden (or asleep) windows do not poll, and coming back is one catch-up
  // however many ticks were missed and however many events announce it.
  hidden.mockReturnValue(true);
  await advance(30 * MINUTE);
  expect(calls()).toBe(7);
  hidden.mockReturnValue(false);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(calls()).toBe(8);

  // Step to just past a tick so the phase below is known.
  const before = calls();
  for (let step = 0; step < 61 && calls() === before; step += 1) await advance(1000);
  expect(calls()).toBe(before + 1);
  let count = calls();

  // A longer interval applies to the tick already pending.
  await choose({ usageRefreshMinutes: 5 });
  await advance(4 * MINUTE);
  expect(calls()).toBe(count);
  await advance(MINUTE);
  expect(calls()).toBe(count += 1);

  // A shorter one is due at once when the last tick is already that old.
  await advance(3 * MINUTE);
  expect(calls()).toBe(count);
  await choose({ usageRefreshMinutes: 1 });
  await advance(0);
  expect(calls()).toBe(count += 1);

  // Flipping through values leaves exactly one timer behind.
  await choose({ usageRefreshMinutes: 15 });
  await choose({ usageRefreshMinutes: 2 });
  await choose({ usageRefreshMinutes: 1 });
  await advance(MINUTE);
  expect(calls()).toBe(count += 1);
  await advance(5 * MINUTE);
  expect(calls()).toBe(count += 5);

  // Off stops the timer and nothing else.
  await choose({ usageRefreshMinutes: 0 });
  await advance(60 * MINUTE);
  expect(calls()).toBe(count);
  await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(0); });
  expect(calls()).toBe(count += 1);
  await act(async () => { await refreshUsage(true); });
  expect(calls()).toBe(count += 1);
  expect(mocks.refresh).toHaveBeenLastCalledWith(true);

  // A failed tick keeps the timer alive and the last usage on screen.
  await choose({ usageRefreshMinutes: 1 });
  await advance(0);
  expect(calls()).toBe(count += 1);
  mocks.refresh.mockRejectedValueOnce(new Error("transport offline"));
  await advance(MINUTE);
  expect(calls()).toBe(count += 1);
  expect(observed?.usageError).toContain("Showing last known usage");
  await advance(MINUTE);
  expect(calls()).toBe(count += 1);
  expect(observed?.usageError).toBeNull();

  // With the usage indicator hidden there is nothing to keep fresh.
  await choose({ usage: false });
  await advance(10 * MINUTE);
  expect(calls()).toBe(count);
  await choose({ usage: true });
  await advance(0);
  expect(calls()).toBe(count += 1);
  await advance(MINUTE);
  expect(calls()).toBe(count + 1);
});
