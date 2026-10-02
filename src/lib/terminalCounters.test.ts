import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("./terminalCounters");
}

afterEach(() => vi.restoreAllMocks());

describe("terminal data rate", () => {
  it("totals since load and averages the last whole seconds per transport", async () => {
    const now = vi.spyOn(performance, "now");
    const counters = await load();
    // 3 events of 1000 bytes in each of seconds 10..14, then the reader asks during second 15.
    for (let second = 10; second < 15; second++) {
      now.mockReturnValue(second * 1000 + 5);
      for (let i = 0; i < 3; i++) counters.countTerminalData("local", 1000);
    }
    now.mockReturnValue(15_200);
    counters.countTerminalData("local", 7);
    expect(counters.dataRate("local")).toEqual({ events: 16, bytes: 15_007, eventsPerSecond: 3, bytesPerSecond: 3000 });
    expect(counters.dataRate("cloud")).toEqual({ events: 0, bytes: 0, eventsPerSecond: 0, bytesPerSecond: 0 });

    // Quiet since: the rate falls to nothing while the totals stay.
    now.mockReturnValue(60_000);
    expect(counters.dataRate("local")).toMatchObject({ events: 16, eventsPerSecond: 0, bytesPerSecond: 0 });
  });

  it("calls a terminal nobody gave WebGL to a DOM-rendered one", async () => {
    const counters = await load();
    const term = {} as never;
    expect(counters.rendererOf(term)).toBe("dom");
    counters.setRenderer(term, "webgl");
    expect(counters.rendererOf(term)).toBe("webgl");
  });
});
