import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, WorkspaceDisposition } from "@/types/session";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
  workspaceDisposition: vi.fn(),
  settleSession: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, message: mocks.message }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { workspaceDisposition: mocks.workspaceDisposition },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
const session = { id: "s1", projectPath: "/p", title: "Fix login", cwd: "/p/.raccoon/worktrees/quiet-amber-fox", worktreeName: "quiet-amber-fox", branch: "raccoon/quiet-amber-fox" } as SessionEntry;
vi.mock("@/lib/sessions", () => ({
  deleteSession: vi.fn(),
  settleSession: mocks.settleSession,
  deleteWorkspace: mocks.deleteWorkspace,
  useSessionStore: () => ({ sessions: [session] }),
}));

import { closeSettle, closeWorkspaceDelete, openSettle, openWorkspaceDelete } from "@/lib/dialogs";
import { SettleDialog } from "./SettleDialog";
import { WorkspaceDeleteDialog } from "./WorkspaceDeleteDialog";

const workspace: WorkspaceDisposition = {
  exists: true,
  checked: true,
  safe: true, merged: true, pushed: true, defaultBranch: "main", stashes: 0, verificationError: null,
  isMain: false,
  branch: "raccoon/quiet-amber-fox",
  uncommitted: 0,
  unpushed: 0,
  aheadOfBase: 0,
  pr: null,
  prChecked: true,
  sessions: 2,
  sessionTitles: ["Fix login", "Review the fix"],
};
const deleteButton = () => screen.getByRole("button", { name: /Settle and delete workspace|Delete workspace|Delete anyway/ }) as HTMLButtonElement;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.message.mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => {
    closeSettle();
    closeWorkspaceDelete();
  });
  cleanup();
});

describe("SettleDialog", () => {
  it("keeps Delete disabled until the tree's state is known", async () => {
    let resolve!: (d: WorkspaceDisposition) => void;
    mocks.workspaceDisposition.mockReturnValue(new Promise<WorkspaceDisposition>((r) => (resolve = r)));
    render(<SettleDialog />);
    act(() => openSettle("s1"));
    expect(deleteButton().disabled).toBe(true);
    await act(async () => resolve(workspace));
    expect(deleteButton().disabled).toBe(false);
    expect(deleteButton().textContent).toContain("Settle and delete workspace");
  });

  it("treats a state that cannot be read as unchecked and asks a second time, naming the path", async () => {
    mocks.workspaceDisposition.mockResolvedValue({ ...workspace, safe: false, verificationError: "git exploded", merged: null });
    mocks.ask.mockResolvedValue(false);
    render(<SettleDialog />);
    act(() => openSettle("s1"));
    await screen.findByText("Not verified: git exploded");
    fireEvent.click(deleteButton());
    expect(screen.getByText(/Explicitly confirm deleting \/p\/\.raccoon\/worktrees\/quiet-amber-fox/)).toBeTruthy();
    expect(mocks.settleSession).not.toHaveBeenCalled();
  });

  it("asks a second time for a tree git cannot check, and settles once confirmed", async () => {
    mocks.workspaceDisposition.mockResolvedValue({ ...workspace, checked: false, safe: false, verificationError: "not a working git checkout of this project" });
    mocks.ask.mockResolvedValue(true);
    mocks.settleSession.mockResolvedValue({ session, keptBranch: "raccoon/quiet-amber-fox", rescuedBranch: null });
    render(<SettleDialog />);
    act(() => openSettle("s1"));
    await screen.findByText(/not a working git checkout of this project/);
    fireEvent.click(deleteButton());
    expect(mocks.settleSession).not.toHaveBeenCalled();
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mocks.settleSession).toHaveBeenCalledWith("s1", "delete", true));
    // The kept branch is said, not just logged.
    await waitFor(() => expect(mocks.message).toHaveBeenCalled());
    expect(mocks.message.mock.calls[0][0]).toContain("raccoon/quiet-amber-fox was kept");
  });

  it("does not ask twice for a checked tree, and reads the state again after a failure", async () => {
    mocks.workspaceDisposition.mockResolvedValueOnce(workspace).mockResolvedValueOnce({ ...workspace, uncommitted: 2, safe: false });
    mocks.settleSession.mockRejectedValue(new Error("Could not remove the worktree"));
    render(<SettleDialog />);
    act(() => openSettle("s1"));
    await screen.findByText("Merged and clean: safe to delete.");
    fireEvent.click(deleteButton());
    await screen.findByText("Could not remove the worktree");
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.workspaceDisposition).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/2 uncommitted or untracked files/)).toBeTruthy();
    expect(deleteButton().textContent).toContain("Settle and delete workspace");
  });
});

describe("WorkspaceDeleteDialog", () => {
  const open = () => act(() => openWorkspaceDelete("/p", "/p/.raccoon/worktrees/quiet-amber-fox", "quiet-amber-fox"));

  it("asks a second time for a directory that cannot be checked, naming the path", async () => {
    mocks.workspaceDisposition.mockResolvedValue({ ...workspace, checked: false, branch: null, safe: false, verificationError: "not a working git checkout of this project" });
    mocks.ask.mockResolvedValue(false);
    render(<WorkspaceDeleteDialog />);
    open();
    await screen.findByText(/not a working git checkout of this project/);
    fireEvent.click(deleteButton());
    expect(screen.getByText(/Explicitly confirm deleting \/p\/\.raccoon\/worktrees\/quiet-amber-fox/)).toBeTruthy();
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("deletes a checked workspace without the second question and says when the branch was kept", async () => {
    mocks.workspaceDisposition.mockResolvedValue(workspace);
    mocks.deleteWorkspace.mockResolvedValue({ sessions: [], keptBranch: "raccoon/quiet-amber-fox", rescuedBranch: null });
    render(<WorkspaceDeleteDialog />);
    open();
    await screen.findByText("0 uncommitted or untracked files.");
    // Every session that goes is named, not just counted.
    expect(screen.getByText("2 sessions will be deleted with their transcripts:")).toBeTruthy();
    expect(screen.getByText("Fix login")).toBeTruthy();
    expect(screen.getByText("Review the fix")).toBeTruthy();
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mocks.deleteWorkspace).toHaveBeenCalledWith("/p", "/p/.raccoon/worktrees/quiet-amber-fox", true, false));
    expect(mocks.ask).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.message).toHaveBeenCalled());
  });

  it("reads the state again after a failure", async () => {
    mocks.workspaceDisposition.mockResolvedValueOnce(workspace).mockResolvedValueOnce({ ...workspace, uncommitted: 1, safe: false });
    mocks.deleteWorkspace.mockRejectedValue(new Error("Could not remove the worktree"));
    render(<WorkspaceDeleteDialog />);
    open();
    await screen.findByText("0 uncommitted or untracked files.");
    fireEvent.click(deleteButton());
    await screen.findByText("Could not remove the worktree");
    expect(mocks.workspaceDisposition).toHaveBeenCalledTimes(2);
    expect(screen.getByText("1 uncommitted or untracked files will be lost.")).toBeTruthy();
  });
});
