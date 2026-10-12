import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CleanupCandidate, CleanupProgress, CleanupRemoveItem, CleanupResult } from "@terminalx/portable/workspace";
import type { Leftover, LeftoverProgress, LeftoverRemoval } from "@/types/session";

const leftovers = { remove: vi.fn(), listener: null as ((progress: LeftoverProgress) => void) | null };

vi.mock("@/lib/api", () => ({
  api: {
    setQuitWarning: async () => undefined,
    removeLeftovers: (ids: string[]) => leftovers.remove(ids),
    onLeftoverProgress: async (_run: string, onProgress: (progress: LeftoverProgress) => void) => {
      leftovers.listener = onProgress;
      return () => (leftovers.listener = null);
    },
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/lib/cloudConnections", () => ({ connectedCloudClient: () => null }));
vi.mock("@/lib/cloudSessions", () => ({ managesOf: () => true }));
vi.mock("@/lib/workspaceSizes", () => ({ forgetWorkspaceSize: () => undefined, formatSize: (bytes: number) => `${bytes} B` }));

import { getCleanupRun, resetCleanupRun, startCleanupRun } from "@/lib/cleanupRun";
import { closeWorktreeCleanup, openWorktreeCleanup, useDialogs } from "@/lib/dialogs";
import { resetLeftoverRun, startLeftoverRun, useLeftoverRun, watchLeftoverRun } from "@/lib/leftoverRun";
import { LOCAL_HOST, type CleanupHost, type RemoveOptions } from "@/lib/worktreeCleanup";
import { CLEAN_RESULT_MS, CleanupIndicator, liftClearOf } from "./CleanupIndicator";

function candidate(name: string): CleanupCandidate {
  return { projectPath: "/p", path: `/p/.raccoon/worktrees/${name}`, name, branch: `raccoon/${name}`, head: "abc", managed: true, verdict: "eligible", reason: null, lastActivity: null, sessions: [], disposable: [], ignoredData: [], token: `token-${name}` };
}
const result = (name: string, patch: Partial<CleanupResult> = {}): CleanupResult => ({ projectPath: "/p", path: candidate(name).path, outcome: "removed", reason: null, freedBytes: 1_000, keptBranch: "b", sessionsKept: [], sessionsDeleted: [], ...patch });

/** Start a run of `names` on this computer; the host answers and reports by hand. */
function started(...names: string[]) {
  let call!: { options: RemoveOptions; answer: (results: CleanupResult[]) => void };
  const host: CleanupHost = {
    id: LOCAL_HOST,
    kind: "local",
    name: "This computer",
    unavailable: null,
    scan: async () => [],
    size: async () => null,
    cancelSizes: async () => undefined,
    remove: (_items: CleanupRemoveItem[], options = {}) => new Promise((answer) => (call = { options, answer })),
  };
  act(() => void startCleanupRun([host], names.map((name) => ({ hostId: LOCAL_HOST, candidate: candidate(name), deleteSessions: false, estimatedBytes: 1_000 }))));
  return {
    tell: (progress: CleanupProgress) => act(() => void call.options.onProgress?.(progress)),
    answer: (results: CleanupResult[]) =>
      act(async () => {
        call.answer(results);
        await Promise.resolve();
        await Promise.resolve();
      }),
  };
}

const onOpenStorage = vi.fn();
/** The indicator beside what else reads the same stores, as in the app. */
function Probe() {
  const dialogs = useDialogs();
  const leftoverRun = useLeftoverRun();
  return (
    <>
      <CleanupIndicator onOpenStorage={onOpenStorage} />
      <output data-testid="dialog">{String(dialogs.worktreeCleanup)}</output>
      <output data-testid="leftovers">{leftoverRun?.status ?? "none"}</output>
    </>
  );
}

const card = (name = "Worktree clean-up") => screen.getByRole("region", { name });
const leftover = (name: string, sizeBytes = 500): Leftover => ({ id: `worktree:/p:${name}`, kind: "worktree", projectPath: "/p", projectName: "p", name, agent: null, paths: [`/p/.raccoon/worktrees/${name}`], sizeBytes, keptBecause: null });

describe("CleanupIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onOpenStorage.mockReset();
    leftovers.remove.mockReset();
    leftovers.listener = null;
  });
  afterEach(() => {
    cleanup();
    act(() => {
      resetCleanupRun();
      resetLeftoverRun();
      closeWorktreeCleanup();
    });
    vi.useRealTimers();
  });

  it("shows nothing when no clean-up runs, and nothing while the dialog shows the run itself", () => {
    render(<Probe />);
    expect(screen.queryByRole("region")).toBeNull();
    act(() => openWorktreeCleanup());
    started("a", "b");
    expect(screen.queryByRole("region")).toBeNull();
    // Hidden: now the corner is the only view of it.
    act(() => closeWorktreeCleanup());
    expect(card()).toBeTruthy();
  });

  it("while it runs: the worktree it is on, the space freed, and a way back to the dialog", () => {
    render(<Probe />);
    const run = started("a", "b", "c");
    const ring = within(card()).getByRole("progressbar");
    expect(ring.getAttribute("aria-valuenow")).toBe("0");
    expect(ring.getAttribute("aria-valuemax")).toBe("3");
    expect(ring.getAttribute("aria-valuetext")).toBe("0 of 3 worktrees done");
    expect(within(card()).getByText("Cleaning up 1 of 3")).toBeTruthy();
    expect(within(card()).getByText("0 B freed")).toBeTruthy();

    run.tell({ kind: "finished", index: 0, total: 3, result: result("a") });
    run.tell({ kind: "finished", index: 1, total: 3, result: result("b", { outcome: "skipped", reason: "It changed.", freedBytes: 0 }) });
    expect(within(card()).getByText("Cleaning up 3 of 3")).toBeTruthy();
    expect(within(card()).getByText("1000 B freed")).toBeTruthy();
    expect(within(card()).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
    // It cannot be dismissed while it runs, and time does not take it away.
    expect(within(card()).queryByRole("button", { name: "Dismiss" })).toBeNull();
    act(() => void vi.advanceTimersByTime(CLEAN_RESULT_MS * 3));
    expect(card()).toBeTruthy();

    // Reachable by keyboard: a real button opens the dialog at the run as it is.
    const show = within(card()).getByRole("button", { name: "Show" });
    show.focus();
    expect(document.activeElement).toBe(show);
    fireEvent.click(show);
    expect(screen.getByTestId("dialog").textContent).toBe("true");
    expect(screen.queryByRole("region")).toBeNull();
    expect(getCleanupRun()?.status).toBe("running");
  });

  it("a run where everything was removed is summed up, then goes by itself", async () => {
    render(<Probe />);
    const run = started("a", "b");
    await run.answer([result("a"), result("b", { freedEstimated: true })]);
    expect(within(card()).getByText("Removed 2, freed about 2000 B")).toBeTruthy();
    expect(within(card()).queryByRole("progressbar")).toBeNull();
    act(() => void vi.advanceTimersByTime(CLEAN_RESULT_MS - 1));
    expect(card()).toBeTruthy();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByRole("region")).toBeNull();
    expect(getCleanupRun()).toBeNull();
  });

  it("a run with anything skipped, failed or not known stays until it is dismissed or read", async () => {
    render(<Probe />);
    const run = started("a", "b", "c", "d");
    await run.answer([result("a"), result("b", { outcome: "skipped", reason: "It changed.", freedBytes: 0 }), result("c", { outcome: "failed", reason: "Git refused.", freedBytes: 0 }), { ...result("d", { freedBytes: 0 }), outcome: "failed" }]);
    expect(within(card()).getByText("Removed 1, freed 1000 B")).toBeTruthy();
    expect(within(card()).getByText("1 skipped, 2 failed")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(CLEAN_RESULT_MS * 20));
    expect(card()).toBeTruthy();
    expect(getCleanupRun()?.status).toBe("done");

    // Opening it shows the full result; the run is kept for the dialog to show.
    fireEvent.click(within(card()).getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("dialog").textContent).toBe("true");
    expect(getCleanupRun()?.status).toBe("done");
    act(() => closeWorktreeCleanup());
    fireEvent.click(within(card()).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(getCleanupRun()).toBeNull();
    expect(screen.getByTestId("dialog").textContent).toBe("false");
  });

  it("a host that stopped answering is never dismissed silently", async () => {
    render(<Probe />);
    let fail!: (error: Error) => void;
    const host: CleanupHost = { id: "cloud:org:box", kind: "cloud", name: "Build box", unavailable: null, scan: async () => [], size: async () => null, cancelSizes: async () => undefined, remove: () => new Promise((_, reject) => (fail = reject)) };
    act(() => void startCleanupRun([host], [{ hostId: host.id, candidate: candidate("a"), deleteSessions: false }, { hostId: host.id, candidate: candidate("b"), deleteSessions: false }]));
    await act(async () => {
      fail(new Error("Workspace runtime did not reconnect"));
      await Promise.resolve();
      await Promise.resolve();
    });
    // One not known (counted with the failures) and one never attempted.
    expect(within(card()).getByText("Removed 0, freed 0 B")).toBeTruthy();
    expect(within(card()).getByText("1 skipped, 1 failed")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(CLEAN_RESULT_MS * 20));
    expect(card()).toBeTruthy();
  });

  it("follows a deletion of leftovers once Settings is left, and leads back to it", async () => {
    let answer!: (removal: LeftoverRemoval) => void;
    leftovers.remove.mockImplementation(() => new Promise<LeftoverRemoval>((resolve) => (answer = resolve)));
    render(<Probe />);
    // The Storage tab is on screen and shows the run itself.
    let leave!: () => void;
    act(() => void (leave = watchLeftoverRun()));
    await act(async () => {
      void startLeftoverRun([leftover("one"), leftover("two")].map((item) => ({ item, label: item.name })));
      await Promise.resolve();
    });
    expect(screen.queryByRole("region")).toBeNull();
    act(() => leave());
    expect(within(card("Leftover clean-up")).getByText("Checking leftovers again")).toBeTruthy();
    act(() => leftovers.listener?.({ kind: "started", index: 0, total: 2, id: "worktree:/p:one" }));
    act(() => leftovers.listener?.({ kind: "finished", index: 0, total: 2, id: "worktree:/p:one", freedBytes: 500, error: null }));
    expect(within(card("Leftover clean-up")).getByText("Deleting leftovers, 2 of 2")).toBeTruthy();
    expect(within(card("Leftover clean-up")).getByText("500 B freed")).toBeTruthy();
    expect(within(card("Leftover clean-up")).getByRole("progressbar").getAttribute("aria-valuetext")).toBe("1 of 2 leftovers done");

    await act(async () => {
      answer({ removed: ["worktree:/p:one"], failed: [{ id: "worktree:/p:two", error: "Has 1 uncommitted file." }], freedBytes: 500 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(card("Leftover clean-up")).getByText("Deleted 1, freed 500 B")).toBeTruthy();
    expect(within(card("Leftover clean-up")).getByText("1 kept")).toBeTruthy();
    // Something was kept: it stays, and opens Settings at Storage.
    act(() => void vi.advanceTimersByTime(CLEAN_RESULT_MS * 20));
    fireEvent.click(within(card("Leftover clean-up")).getByRole("button", { name: "Details" }));
    expect(onOpenStorage).toHaveBeenCalledTimes(1);
    // The tab opens and shows the result: the corner has nothing left to say.
    act(() => void watchLeftoverRun());
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByTestId("leftovers").textContent).toBe("done");
  });

  it("lifts clear of a composer and of nothing else", () => {
    const own = { left: 600, right: 960, top: 620, bottom: 668 };
    // Nothing there, or controls beside, above or below it: it rests in the corner.
    expect(liftClearOf(own, [])).toBe(0);
    expect(liftClearOf(own, [{ left: 500, right: 590, top: 630, bottom: 658 }])).toBe(0);
    expect(liftClearOf(own, [{ left: 900, right: 940, top: 560, bottom: 600 }])).toBe(0);
    expect(liftClearOf(own, [{ left: 900, right: 940, top: 670, bottom: 690 }])).toBe(0);
    // A composer under it: it moves up until its bottom edge clears the composer's top, with a gap.
    expect(liftClearOf(own, [{ left: 900, right: 940, top: 630, bottom: 658 }])).toBe(668 - 630 + 8);
    // Clearing one must not land it on another.
    const lifted = liftClearOf(own, [
      { left: 900, right: 940, top: 630, bottom: 658 },
      { left: 700, right: 740, top: 590, bottom: 618 },
    ]);
    expect(lifted).toBe(668 - 590 + 8);
  });
});
