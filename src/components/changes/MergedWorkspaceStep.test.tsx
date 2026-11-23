import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedStatus } from "@/lib/mergedCleanup";

const mocks = vi.hoisted(() => ({
  status: undefined as HostedStatus | undefined,
  hold: vi.fn(async () => undefined),
  remove: vi.fn(),
  settle: vi.fn(),
  size: vi.fn(async () => 7.2 * 1024 ** 3),
}));
vi.mock("@/lib/mergedCleanup", () => ({
  LOCAL_HOST: "local",
  useMergedStatus: () => mocks.status,
  holdMergedWorkspace: mocks.hold,
  mergedDue: () => "in 8 min",
}));
vi.mock("@/lib/dialogs", () => ({ openWorkspaceDelete: mocks.remove, openWorkspaceRemove: mocks.settle }));
vi.mock("@/lib/api", () => ({ api: { workspaceSize: mocks.size }, errorMessage: String }));

const { MergedWorkspaceStep } = await import("./MergedWorkspaceStep");

const status = (patch: Partial<HostedStatus>): HostedStatus => ({
  hostId: "local", projectPath: "/p", path: "/p/.raccoon/worktrees/w", name: "w", branch: "w",
  pr: { number: 870, title: "x", url: "u", head: "h" }, phase: "kept", reason: "2 unpushed commits",
  detail: "2 commits are only on this machine.", due: null, fresh: false, sessions: [], record: null, ...patch,
} as HostedStatus);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the merged workspace card", () => {
  it("says why archive on merge was skipped and what archiving frees, and keeps or archives it", async () => {
    mocks.status = status({});
    render(<MergedWorkspaceStep cwd="/p/.raccoon/worktrees/w" />);
    expect(screen.getByText("Pull request #870 merged")).toBeTruthy();
    expect(screen.getByText("Archive on merge skipped: 2 unpushed commits.")).toBeTruthy();
    expect(await screen.findByText(/Archiving it frees 7\.2 GB/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive anyway" }));
    expect(mocks.remove).toHaveBeenCalledWith("/p", "/p/.raccoon/worktrees/w", "w");
    // Keep holds the buttons while it is asked.
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(mocks.hold).toHaveBeenCalledWith("local", "/p/.raccoon/worktrees/w", true);
  });

  it("offers to let clean-up archive one the reader kept", () => {
    mocks.status = status({ phase: "held", reason: null });
    render(<MergedWorkspaceStep cwd="/p/.raccoon/worktrees/w" />);
    fireEvent.click(screen.getByRole("button", { name: "Let clean-up archive it" }));
    expect(mocks.hold).toHaveBeenCalledWith("local", "/p/.raccoon/worktrees/w", false);
  });

  it("deletes one whose conversations could not be filed away through the dialog that settles them", () => {
    mocks.status = status({ archiveBlocked: true, detail: "Its conversations could not be archived." });
    render(<MergedWorkspaceStep cwd="/p/.raccoon/worktrees/w" />);
    fireEvent.click(screen.getByRole("button", { name: "Archive anyway" }));
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ path: "/p/.raccoon/worktrees/w", mode: "settle", archiveNotice: "Its conversations could not be archived." }));
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("says archiving soon, and under WHAT NEXT leaves the merge to the merged card", () => {
    mocks.status = status({ phase: "scheduled", reason: null, due: "x" });
    render(<MergedWorkspaceStep cwd="/p/.raccoon/worktrees/w" embedded />);
    expect(screen.getByText("Archiving in 8 min")).toBeTruthy();
    expect(screen.getByText(/Runs the archive script and removes the worktree.*Chats stay searchable\./)).toBeTruthy();
    expect(screen.queryByText("Pull request #870 merged")).toBeNull();
  });

  it("offers the archive by hand where clean-up does not archive merged sessions", () => {
    mocks.status = undefined;
    const archive = vi.fn();
    render(<MergedWorkspaceStep cwd="/p" embedded onArchive={archive} />);
    expect(screen.getByText("Archive the session")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(archive).toHaveBeenCalled();
  });

  it("is not there for a workspace that is not merged", () => {
    mocks.status = undefined;
    const { container } = render(<MergedWorkspaceStep cwd="/p" />);
    expect(container.textContent).toBe("");
  });
});
