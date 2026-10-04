import { afterEach, expect, it, vi } from "vitest";
import { onAppResume } from "./appResume";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("coalesces unlock visibility/focus hints and removes pending work on disposal", () => {
  vi.useFakeTimers();
  let hidden = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const recover = vi.fn();
  const stop = onAppResume(recover);
  window.dispatchEvent(new Event("focus"));
  vi.advanceTimersByTime(200);
  expect(recover).not.toHaveBeenCalled();
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("pageshow"));
  vi.advanceTimersByTime(100);
  expect(recover).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("focus"));
  stop();
  vi.advanceTimersByTime(20_000);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("recovers after suspension without requiring a visibility or focus event", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const recover = vi.fn();
  const stop = onAppResume(recover);
  vi.advanceTimersByTime(10_000);
  expect(recover).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 3_600_000);
  vi.advanceTimersByTime(5_100);
  expect(recover).toHaveBeenCalledTimes(1);
  stop();
});
