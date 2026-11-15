import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmState } from "@/types/localVm";
import { environment, task } from "./localVm.testSupport";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/localVm", () => ({ localVmRequest: mocks.request }));
vi.mock("@/lib/api", () => ({ errorMessage: (error: unknown) => String(error) }));

beforeEach(() => { vi.resetModules(); mocks.request.mockReset(); });
afterEach(cleanup);

describe("local VM journal refresh", () => {
  it("does not erase an acknowledged task when an older in-flight poll returns", async () => {
    const state: LocalVmState = { enabled: true, environments: { env: environment }, tasks: {} };
    mocks.request.mockResolvedValueOnce(state);
    const store = await import("./useLocalVmState");
    const view = renderHook(() => store.useLocalVmState());
    await waitFor(() => expect(view.result.current.state).toEqual(state));
    let finishPoll!: (state: LocalVmState) => void;
    mocks.request.mockImplementationOnce(() => new Promise<LocalVmState>((resolve) => { finishPoll = resolve; }));
    let poll!: Promise<void>;
    act(() => { poll = store.refreshLocalVmState(); });
    const acknowledged = task();
    act(() => store.acknowledgeLocalVmTask(acknowledged));
    expect(view.result.current.state?.tasks.task).toEqual(acknowledged);
    await act(async () => { finishPoll(state); await poll; });
    expect(view.result.current.state?.tasks.task).toEqual(acknowledged);
  });

  it("reports a lost state reply while retaining the last known task history", async () => {
    const state: LocalVmState = { enabled: true, environments: { env: environment }, tasks: { task: task() } };
    mocks.request.mockResolvedValueOnce(state);
    const store = await import("./useLocalVmState");
    const view = renderHook(() => store.useLocalVmState());
    await waitFor(() => expect(view.result.current.state).toEqual(state));
    mocks.request.mockRejectedValueOnce(new Error("host journal unavailable"));
    await act(async () => { await store.refreshLocalVmState(); });
    expect(view.result.current.error).toContain("host journal unavailable");
    expect(view.result.current.state?.tasks.task).toEqual(state.tasks.task);
  });
});
