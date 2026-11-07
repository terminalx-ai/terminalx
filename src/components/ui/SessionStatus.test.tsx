import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStatus } from "./SessionStatus";
import { api } from "@/lib/api";
import type { SessionEntry } from "@/types/session";
import type { SessionStatusInput } from "@terminalx/portable/sessionStatus";

vi.mock("@/lib/api", () => ({ api: { sessionRowStatuses: vi.fn() } }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => ({ animations: false }) }));
const session = (id: string) => ({ id, tabs: [{ status: "idle" }], branch: "feature" }) as SessionEntry;
beforeEach(() => { vi.useFakeTimers(); vi.mocked(api.sessionRowStatuses).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("visible session rows", () => {
  it("batches all views, updates within a poll, and stops when no rows are mounted", async () => {
    let input: SessionStatusInput = { tabs: [{ status: "waiting", activity: "needs_permission" }] };
    vi.mocked(api.sessionRowStatuses).mockImplementation(async (ids) => Object.fromEntries(ids.map((id) => [id, input])));
    const entries = Array.from({ length: 50 }, (_, i) => session(`s${i}`));
    render(<>{entries.map((s) => <SessionStatus key={s.id} session={s} />)}<SessionStatus session={entries[0]} /></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.sessionRowStatuses).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.sessionRowStatuses).mock.calls[0][0]).toHaveLength(50);
    expect(screen.getAllByText("Needs permission")).toHaveLength(51);
    input = { tabs: [{ status: "waiting", activity: "needs_answer" }] };
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getAllByText("Needs answer")).toHaveLength(51);
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.sessionRowStatuses).toHaveBeenCalledTimes(2);
  });

  it("drops stale PR readiness after losing the runtime", async () => {
    vi.mocked(api.sessionRowStatuses).mockResolvedValueOnce({ one: {
      tabs: [{ status: "idle" }], branch: "feature", branchStatus: { branch: "feature", checked: true, pr: { number: 1, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false } },
    } }).mockRejectedValue(new Error("disconnected"));
    render(<SessionStatus session={session("one")} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Ready to merge")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.queryByText("Ready to merge")).toBeNull();
    expect(screen.getByText("Idle")).toBeTruthy();
  });
});
