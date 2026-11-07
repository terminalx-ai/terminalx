import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { branchStep, useBranchStep, type BranchSnapshot } from "./branchStep";

const mocks = vi.hoisted(() => ({ listener: null as null | ((event: { payload: unknown }) => void), stop: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name: string, listener: (event: { payload: unknown }) => void) => { mocks.listener = listener; return mocks.stop; }) }));
const value = (revision: number, state: BranchSnapshot["state"]): BranchSnapshot => ({ revision, sessionId: "s1", cwd: "/repo", branch: "feature", head: "abc", base: "main", mergeMethod: "merge", state, actions: state === "ready" ? ["merge"] : [], pr: null, behindUpstream: false });

beforeEach(() => { vi.useFakeTimers(); mocks.stop.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("observes check results after one polling refresh and cleans up the event stream", async () => {
  const read = vi.spyOn(branchStep, "refresh").mockResolvedValueOnce(value(1, "checksPending")).mockResolvedValue(value(2, "ready"));
  const view = renderHook(() => useBranchStep("s1", "completed"));
  await act(async () => {});
  expect(view.result.current.snapshot?.state).toBe("checksPending");
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.result.current.snapshot?.state).toBe("ready");
  view.unmount();
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(read).toHaveBeenCalledTimes(2);
});

it("coalesces refresh requests and reads again when a turn ends during a read", async () => {
  let finish!: (snapshot: BranchSnapshot) => void;
  const read = vi.spyOn(branchStep, "refresh").mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValue(value(2, "ready"));
  const view = renderHook(({ status }) => useBranchStep("s1", status), { initialProps: { status: "in_progress" } });
  view.rerender({ status: "completed" });
  act(() => { view.result.current.refresh(); view.result.current.refresh(); });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => finish(value(1, "agentWorking")));
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.result.current.snapshot?.state).toBe("ready");
});

it("keeps a newer event when an older read fails and disables stale state on a current read failure", async () => {
  let reject!: (reason: Error) => void;
  const read = vi.spyOn(branchStep, "refresh").mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const view = renderHook(() => useBranchStep("s1", "completed"));
  await act(async () => mocks.listener?.({ payload: value(2, "ready") }));
  await act(async () => reject(new Error("Old request timed out")));
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.snapshot?.state).toBe("ready");
  read.mockRejectedValue(new Error("Offline"));
  await act(async () => view.result.current.refresh());
  expect(view.result.current.error).toBe("Offline");
});
