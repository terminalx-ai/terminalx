import { afterEach, describe, expect, it, vi } from "vitest";

const screencast = vi.fn(async () => undefined);
vi.mock("@/lib/api", () => ({ browser: { screencast: (...args: unknown[]) => screencast(...(args as [])) } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/terminal", () => ({ setSelectedBrowser: vi.fn(), clearSelectedBrowser: vi.fn() }));

import { watchScreencast } from "./browser";

afterEach(() => {
  vi.useRealTimers();
  screencast.mockClear();
});

describe("a page's preview stream", () => {
  it("survives a view that unmounts and mounts again at once, and stops a moment after the last view", async () => {
    vi.useFakeTimers();
    const first = watchScreencast("p1");
    expect(screencast).toHaveBeenCalledWith("p1", true);
    first();
    const second = watchScreencast("p1");
    await vi.advanceTimersByTimeAsync(1000);
    // Still one start, and no stop: the remount kept the stream.
    expect(screencast.mock.calls).toEqual([["p1", true]]);
    second();
    await vi.advanceTimersByTimeAsync(1000);
    expect(screencast.mock.calls).toEqual([["p1", true], ["p1", false]]);
  });

  it("keeps streaming while a second view still shows the page", async () => {
    vi.useFakeTimers();
    const tab = watchScreencast("p2");
    const panel = watchScreencast("p2");
    tab();
    await vi.advanceTimersByTimeAsync(1000);
    expect(screencast.mock.calls).toEqual([["p2", true]]);
    panel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(screencast.mock.calls).toEqual([["p2", true], ["p2", false]]);
  });
});
