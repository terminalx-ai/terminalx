import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergedRemoval, MergedStatus } from "@terminalx/portable/workspace";

// #432: a workspace about to be removed after its pull request merged is
// announced with Keep, and one that was removed with Undo.
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { MergedCleanupNotices } = await import("./MergedCleanupNotices");
const { bootMergedCleanup, getMergedCleanup, requestMergedSweep, resetMergedCleanupForTest } = await import("@/lib/mergedCleanup");

const path = "/repos/app/.raccoon/worktrees/quiet-amber-fox";
const record: MergedRemoval = {
  id: "removal-1",
  removedAt: "2026-10-12T10:11:00Z",
  projectPath: "/repos/app",
  path,
  name: "quiet-amber-fox",
  branch: "raccoon/quiet-amber-fox",
  commit: "a".repeat(40),
  pr: { number: 62, title: "Fix login", url: "https://github.com/o/r/pull/62", head: "a".repeat(40) },
  localBranch: { outcome: "deleted" },
  remoteBranch: { outcome: "moved", at: "b".repeat(40) },
  sessionsKept: ["s1"],
  sessionsDeleted: [],
};
const status = (patch: Partial<MergedStatus>): MergedStatus => ({
  projectPath: "/repos/app",
  path,
  name: "quiet-amber-fox",
  branch: "raccoon/quiet-amber-fox",
  pr: record.pr,
  phase: "scheduled",
  reason: null,
  detail: null,
  due: null,
  fresh: false,
  sessions: ["s1"],
  record: null,
  ...patch,
});

let found: MergedStatus[] = [];
let restore: () => Promise<unknown> = async () => ({ record, notes: [] });

async function pass(next: MergedStatus[]) {
  found = next;
  await act(async () => requestMergedSweep());
}

beforeEach(async () => {
  found = [];
  restore = async () => ({ record, notes: [] });
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "merged_cleanup_settings") return { enabled: true, projects: {}, deleteConversations: false, graceMinutes: 10 };
    if (command === "merged_cleanup_sweep") return { statuses: found, unreadable: [] };
    if (command === "merged_cleanup_restore") return restore();
    return undefined;
  });
  await act(async () => bootMergedCleanup());
});

afterEach(() => {
  cleanup();
  resetMergedCleanupForTest();
});

describe("merged workspace notices", () => {
  it("shows nothing until a workspace is about to go, then offers to keep it", async () => {
    render(<MergedCleanupNotices />);
    expect(screen.queryByTestId("merged-notice")).toBeNull();

    await pass([status({ fresh: true, due: new Date(Date.now() + 10 * 60_000).toISOString() })]);
    const notice = screen.getByTestId("merged-notice");
    expect(notice.textContent).toContain("Pull request #62 merged");
    expect(notice.textContent).toContain("The workspace quiet-amber-fox and its branch will be deleted in 10 min.");

    found = [status({ phase: "held" })];
    fireEvent.click(within(notice).getByRole("button", { name: "Keep workspace" }));
    await waitFor(() => expect(screen.queryByTestId("merged-notice")).toBeNull());
    expect(mocks.invoke).toHaveBeenCalledWith("merged_cleanup_hold", { path, held: true });
  });

  it("says what was deleted and what became of the branches, and undoes it", async () => {
    render(<MergedCleanupNotices />);
    await pass([status({ phase: "removed", record })]);
    const notice = screen.getByTestId("merged-notice");
    expect(notice.textContent).toContain("Deleted workspace quiet-amber-fox");
    // A remote branch that moved is kept, and that is said.
    expect(notice.textContent).toContain("The local branch raccoon/quiet-amber-fox was deleted. Its branch on the remote was kept: it has moved to bbbbbbb since the merge.");

    // A removal is reported by the one pass that made it.
    found = [];
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.queryByTestId("merged-notice")).toBeNull());
    expect(mocks.invoke).toHaveBeenCalledWith("merged_cleanup_restore", { id: "removal-1" });
  });

  it("stays to say what an undo could not put back, or why it could not be done", async () => {
    render(<MergedCleanupNotices />);
    await pass([status({ phase: "removed", record })]);
    found = [];
    restore = async () => {
      throw new Error("Something is at its path again.");
    };
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Something is at its path again.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();

    restore = async () => ({ record, notes: ['The session "Fix login" has been used since and stays under the project.'] });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByTestId("merged-notice").textContent).toContain("Brought back quiet-amber-fox"));
    expect(screen.getByTestId("merged-notice").textContent).toContain('The session "Fix login" has been used since and stays under the project.');
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("merged-notice")).toBeNull();
  });

  it("shows the newest three and says how many more there are", async () => {
    render(<MergedCleanupNotices />);
    await pass([1, 2, 3, 4, 5].map((n) => status({ phase: "removed", path: `${path}-${n}`, name: `fox-${n}`, record: { ...record, id: `removal-${n}`, name: `fox-${n}`, path: `${path}-${n}` } })));
    expect(getMergedCleanup().notices).toHaveLength(5);
    expect(screen.getAllByTestId("merged-notice").map((notice) => notice.textContent?.match(/fox-\d/)?.[0])).toEqual(["fox-3", "fox-4", "fox-5"]);
    expect(screen.getByText("2 more workspaces; see Settings → Storage.")).toBeTruthy();
  });
});
