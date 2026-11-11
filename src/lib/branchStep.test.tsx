import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { branchStep, useBranchStep, type BranchSnapshot } from "./branchStep";

const mocks = vi.hoisted(() => ({ listener: null as null | ((event: { payload: unknown }) => void), stop: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name: string, listener: (event: { payload: unknown }) => void) => { mocks.listener = listener; return mocks.stop; }) }));
const value = (revision: number, state: BranchSnapshot["state"]): BranchSnapshot => ({ revision, sessionId: "s1", cwd: "/repo", branch: "feature", head: "abc", base: "main", mergeMethod: "merge", state, actions: state === "ready" ? ["merge"] : [], pr: null, behindUpstream: false });

beforeEach(() => { vi.useFakeTimers(); mocks.stop.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("reads local changes every 15 seconds and hosted checks only every five minutes", async () => {
  let revision = 0;
  let checked = false;
  const read = vi.spyOn(branchStep, "refresh").mockImplementation(async (_session, mode) => {
    if (mode === "auto" && revision > 1) checked = true;
    return value(++revision, checked ? "ready" : "checksPending");
  });
  const view = renderHook(() => useBranchStep("s1", "completed"));
  await act(async () => {});
  expect(read.mock.calls.map((call) => call[1])).toEqual(["local", "auto"]);
  await act(async () => vi.advanceTimersByTimeAsync(299_999));
  expect(view.result.current.snapshot?.state).toBe("checksPending");
  expect(read.mock.calls.filter((call) => call[1] !== "local")).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(view.result.current.snapshot?.state).toBe("ready");
  expect(read.mock.calls.filter((call) => call[1] === "auto")).toHaveLength(2);
  view.unmount();
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  const count = read.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(300_000));
  expect(read).toHaveBeenCalledTimes(count);
});

it("waits five minutes from hosted completion so network latency cannot skip every other refresh", async () => {
  let finish!: (snapshot: BranchSnapshot) => void;
  const read = vi.spyOn(branchStep, "refresh").mockImplementation((_session, mode) => mode === "auto"
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(value(1, "checksPending")));
  renderHook(() => useBranchStep("s1", "completed"));
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => finish(value(2, "checksPending")));
  await act(async () => vi.advanceTimersByTimeAsync(299_999));
  expect(read.mock.calls.filter((call) => call[1] === "auto")).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(read.mock.calls.filter((call) => call[1] === "auto")).toHaveLength(2);
});

it("debounces focus/resume and leaves status changes local", async () => {
  const read = vi.spyOn(branchStep, "refresh").mockResolvedValue(value(1, "ready"));
  const view = renderHook(({ status }) => useBranchStep("s1", status), { initialProps: { status: "in_progress" } });
  await act(async () => {});
  read.mockClear();
  view.rerender({ status: "completed" });
  await act(async () => {});
  expect(read.mock.calls.map((call) => call[1])).toEqual(["local"]);
  act(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await act(async () => vi.advanceTimersByTimeAsync(599));
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(read.mock.calls.map((call) => call[1])).toEqual(["local", "auto"]);
  await act(async () => view.result.current.refresh());
  expect(read).toHaveBeenLastCalledWith("s1", "remote");
});

it("keeps local polling responsive during a hosted read and coalesces remote requests", async () => {
  let finish!: (snapshot: BranchSnapshot) => void;
  let revision = 0;
  const read = vi.spyOn(branchStep, "refresh").mockImplementation((_session, mode) => mode === "auto"
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(value(++revision, "uncommitted")));
  const view = renderHook(({ status }) => useBranchStep("s1", status), { initialProps: { status: "in_progress" } });
  await act(async () => {});
  expect(read.mock.calls.map((call) => call[1])).toEqual(["local", "auto"]);
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(read).toHaveBeenLastCalledWith("s1", "local");
  expect(view.result.current.snapshot?.state).toBe("uncommitted");
  act(() => { view.result.current.refresh(); view.result.current.refresh(); });
  view.rerender({ status: "completed" });
  await act(async () => {});
  expect(read.mock.calls.filter((call) => call[1] === "remote")).toHaveLength(0);
  await act(async () => finish(value(1, "agentWorking")));
  expect(read.mock.calls.filter((call) => call[1] === "remote")).toHaveLength(1);
  expect(view.result.current.snapshot?.state).toBe("uncommitted");
});

it("keeps newer events over failed reads and removes stale state when a current read fails", async () => {
  const read = vi.spyOn(branchStep, "refresh").mockResolvedValue(value(1, "ready"));
  const view = renderHook(() => useBranchStep("s1", "completed"));
  await act(async () => {});
  let reject!: (reason: Error) => void;
  read.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  act(() => view.result.current.refresh());
  await act(async () => mocks.listener?.({ payload: value(2, "ready") }));
  await act(async () => reject(new Error("Old request timed out")));
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.snapshot?.state).toBe("ready");
  read.mockRejectedValue(new Error("Offline"));
  await act(async () => view.result.current.refresh());
  expect(view.result.current.error).toBe("Offline");
  expect(view.result.current.snapshot).toBeNull();
});
