import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatsUsageState } from "./api";
import { createStatsUsageStore } from "./statsUsageStore";

const saved = (patch: Partial<StatsUsageState> = {}): StatsUsageState => ({
  scope: "home-a", generation: 1, snapshot: null, refreshing: false, error: null, ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("stats refresh subscription lifecycle", () => {
  it("coalesces simultaneous opens and clicks into one request", async () => {
    const read = deferred<StatsUsageState>();
    const source = {
      statsUsageSnapshot: vi.fn().mockReturnValue(read.promise),
      statsUsageRefresh: vi.fn().mockResolvedValue(saved({ generation: 2 })),
    };
    const store = createStatsUsageStore(source);
    const first = store.refresh();
    expect(store.refresh()).toBe(first);
    expect(store.refresh()).toBe(first);
    read.resolve(saved());
    await first;
    expect(source.statsUsageSnapshot).toHaveBeenCalledTimes(1);
    expect(source.statsUsageRefresh).toHaveBeenCalledExactlyOnceWith("home-a", 1);
    expect(store.getSnapshot().refreshing).toBe(false);
  });

  it("joins a backend refresh after a renderer restart and keeps polling without subscribers", async () => {
    vi.useFakeTimers();
    const source = {
      statsUsageSnapshot: vi.fn()
        .mockResolvedValueOnce(saved({ generation: 2, refreshing: true }))
        .mockResolvedValueOnce(saved({ generation: 2 })),
      statsUsageRefresh: vi.fn(),
    };
    const store = createStatsUsageStore(source);
    const unsubscribe = store.subscribe(vi.fn());
    const result = store.refresh();
    await Promise.resolve();
    expect(store.getSnapshot().refreshing).toBe(true);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(source.statsUsageRefresh).not.toHaveBeenCalled();
    expect(store.getSnapshot().refreshing).toBe(false);
  });

  it("ignores an out-of-order refresh from a retired scope, including its finally handler", async () => {
    const oldRefresh = deferred<StatsUsageState>();
    const newRefresh = deferred<StatsUsageState>();
    const source = {
      statsUsageSnapshot: vi.fn().mockResolvedValueOnce(saved())
        .mockResolvedValueOnce(saved({ scope: "home-b", generation: 3 })),
      statsUsageRefresh: vi.fn().mockReturnValueOnce(oldRefresh.promise)
        .mockReturnValueOnce(newRefresh.promise),
    };
    const store = createStatsUsageStore(source);
    const old = store.refresh();
    await Promise.resolve();
    store.dispose();
    const current = store.refresh();
    await Promise.resolve();
    oldRefresh.resolve(saved({ generation: 2, error: "old error" }));
    await old;
    expect(store.getSnapshot().scope).toBe("home-b");
    expect(store.getSnapshot().error).toBeNull();
    expect(store.refresh()).toBe(current);
    newRefresh.resolve(saved({ scope: "home-b", generation: 4 }));
    await current;
    expect(store.getSnapshot().scope).toBe("home-b");
    expect(store.getSnapshot().generation).toBe(4);
  });

  it("ignores an old cached read that arrives after a new scope result", async () => {
    const oldRead = deferred<StatsUsageState>();
    const source = {
      statsUsageSnapshot: vi.fn().mockReturnValueOnce(oldRead.promise)
        .mockResolvedValueOnce(saved({ scope: "home-b" })),
      statsUsageRefresh: vi.fn().mockResolvedValue(saved({ scope: "home-b", generation: 2 })),
    };
    const store = createStatsUsageStore(source);
    const old = store.refresh();
    store.dispose();
    await store.refresh();
    oldRead.resolve(saved());
    await old;
    expect(store.getSnapshot().scope).toBe("home-b");
    expect(source.statsUsageRefresh).toHaveBeenCalledTimes(1);
  });
});
