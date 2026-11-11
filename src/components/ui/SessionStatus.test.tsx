import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rowMeta, SessionStatus, SessionStatusMark } from "./SessionStatus";
import { api } from "@/lib/api";
import type { SessionEntry } from "@/types/session";
import { useSessionRowStatus } from "@/lib/sessionRowStatus";
import type { SessionStatusInput, StatusDescription } from "@terminalx/portable/sessionStatus";

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
    expect(screen.getAllByText("Needs approval")).toHaveLength(51);
    expect(screen.getAllByTitle(/permission to run a tool/)).toHaveLength(51);
    input = { tabs: [{ status: "waiting", activity: "needs_answer" }] };
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    // One label for every kind of waiting; the tooltip names which one.
    expect(screen.getAllByText("Needs approval")).toHaveLength(51);
    expect(screen.getAllByTitle(/asked a question/)).toHaveLength(51);
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.sessionRowStatuses).toHaveBeenCalledTimes(2);
  });

  it("does not rerender an unchanged row when another row changes", async () => {
    const counts = new Map<string, number>();
    function Row({ entry }: { entry: SessionEntry }) {
      const status = useSessionRowStatus([entry]);
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
      return <span>{status.label}</span>;
    }
    let rows: Record<string, SessionStatusInput> = { one: { tabs: [{ status: "idle" }] }, two: { tabs: [{ status: "idle" }] } };
    vi.mocked(api.sessionRowStatuses).mockImplementation(async () => rows);
    render(<><Row entry={session("one")} /><Row entry={session("two")} /></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const before = counts.get("two");
    rows = { ...rows, one: { tabs: [{ status: "waiting", activity: "needs_permission" }] } };
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("Needs approval")).toBeTruthy();
    expect(counts.get("two")).toBe(before);
  });

  it("drops stale PR readiness after losing the runtime", async () => {
    vi.mocked(api.sessionRowStatuses).mockResolvedValueOnce({ one: {
      tabs: [{ status: "idle" }], branch: "feature", branchStatus: { branch: "feature", checked: true, headMatches: true, pr: { number: 1, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false } },
    } }).mockRejectedValue(new Error("disconnected"));
    render(<SessionStatus session={session("one")} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Ready to merge · PR #1")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByText(/Ready to merge/)).toBeNull();
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("a sidebar mark has no label, only the mark and a tooltip", async () => {
    vi.mocked(api.sessionRowStatuses).mockResolvedValue({ one: {
      tabs: [{ status: "idle" }], branch: "feature", branchStatus: { branch: "feature", checked: true, headMatches: true, pr: { number: 781, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "FAILURE", inMergeQueue: false } },
    } });
    const { container } = render(<SessionStatusMark session={session("one")} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const mark = screen.getByRole("img", { name: "Checks failing · PR #781" });
    expect(mark.getAttribute("data-session-status")).toBe("checks_failing");
    expect(mark.title).toMatch(/failing\. PR #781\.$/);
    expect(container.textContent).toBe("");
  });

  it.each([
    [{ label: "Checks failing", pr: 781 }, { additions: 5, deletions: 1 }, { kind: "pr", number: 781 }],
    [{ label: "Working", pr: null }, { additions: 93, deletions: 10 }, { kind: "time" }],
    [{ label: "Merged", pr: null }, { additions: 24, deletions: 1 }, { kind: "time" }],
    [{ label: "Needs approval", pr: null }, { additions: 48, deletions: 6 }, { kind: "lines" }],
    [{ label: "Uncommitted", pr: null }, { additions: 120, deletions: 14 }, { kind: "lines" }],
    [{ label: "No changes", pr: null }, { additions: 0, deletions: 0 }, { kind: "time" }],
  ])("a %o row with %o shows %o after its title, as in 02.04", (status, lines, meta) => {
    expect(rowMeta(status as StatusDescription, lines)).toEqual(meta);
  });
});
