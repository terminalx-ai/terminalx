import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatResetCountdown, useCountdownNow } from "./statusTime";

function Probe({ resets }: { resets: Array<number | null> }) {
  const now = useCountdownNow(resets);
  return <div>{now}</div>;
}

describe("status countdown", () => {
  afterEach(() => vi.useRealTimers());

  it("uses one boundary timer instead of an interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:30.000Z"));
    const reset = Date.now() + 2 * 60 * 60_000 + 14 * 60_000 + 30_000;
    render(<Probe resets={[reset, reset + 60_000]} />);
    expect(vi.getTimerCount()).toBe(1);
    expect(formatResetCountdown(reset, Date.now(), "5h")).toBe("2h 14m");
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(vi.getTimerCount()).toBe(1);
    expect(formatResetCountdown(reset, Date.now(), "5h")).toBe("2h 13m");
  });

  it("falls back to the known window label when no reset is supplied", () => {
    expect(formatResetCountdown(null, Date.now(), "weekly")).toBe("weekly");
  });
});
