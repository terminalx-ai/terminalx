import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageRevalidation, useResourceSampling } from "./statusPolling";
import { formatResetCountdown, useCountdownNow } from "./statusTime";

function CountdownProbe({ resets }: { resets: Array<number | null> }) {
  const now = useCountdownNow(resets);
  return <div>{now}</div>;
}

describe("status countdown", () => {
  afterEach(() => vi.useRealTimers());

  it("uses one boundary timer instead of an interval and falls back when no reset is supplied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:30.000Z"));
    const reset = Date.now() + 2 * 60 * 60_000 + 14 * 60_000 + 30_000;
    render(<CountdownProbe resets={[reset, reset + 60_000]} />);
    expect(vi.getTimerCount()).toBe(1);
    expect(formatResetCountdown(reset, Date.now(), "5h")).toBe("2h 14m");
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(vi.getTimerCount()).toBe(1);
    expect(formatResetCountdown(reset, Date.now(), "5h")).toBe("2h 13m");
    expect(formatResetCountdown(null, Date.now(), "weekly")).toBe("weekly");
  });
});

function Probe({ open, sample }: { open: boolean; sample: () => void }) {
  useResourceSampling(open, sample);
  return null;
}

describe("resource sampling guard", () => {
  afterEach(() => vi.useRealTimers());

  it("never invokes the ps-backed sample while the popover is closed", async () => {
    vi.useFakeTimers();
    const sample = vi.fn();
    const view = render(<Probe open={false} sample={sample} />);
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(sample).not.toHaveBeenCalled();

    view.rerender(<Probe open sample={sample} />);
    expect(sample).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(sample).toHaveBeenCalledTimes(3);

    view.rerender(<Probe open={false} sample={sample} />);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(sample).toHaveBeenCalledTimes(3);
  });
});

describe("usage reset revalidation", () => {
  afterEach(() => vi.useRealTimers());

  it("checks once at the deadline, consumes unchanged expired replies, and rearms for the next window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const refresh = vi.fn();
    const scheduler = createUsageRevalidation(refresh);
    scheduler.update("account", 11_000);
    scheduler.update("account", 11_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.update("account", 11_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.update("account", 71_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    scheduler.update("account", null);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.dispose();
  });

  it("handles an overdue deadline, account changes and disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const refresh = vi.fn();
    const scheduler = createUsageRevalidation(refresh);
    scheduler.update("a", 10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.update("b", 10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    scheduler.update("b", 30_000);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
