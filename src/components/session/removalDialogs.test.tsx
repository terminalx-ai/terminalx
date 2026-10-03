import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, WorkspaceDisposition, WorktreeDisposition } from "@/types/session";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
  worktreeDisposition: vi.fn(),
  workspaceDisposition: vi.fn(),
  settleSession: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, message: mocks.message }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { worktreeDisposition: mocks.worktreeDisposition, workspaceDisposition: mocks.workspaceDisposition },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
const session = { id: "s1", title: "Fix login", cwd: "/p/.raccoon/worktrees/quiet-amber-fox", worktreeName: "quiet-amber-fox", branch: "raccoon/quiet-amber-fox" } as SessionEntry;
vi.mock("@/lib/sessions", () => ({
  settleSession: mocks.settleSession,
  deleteWorkspace: mocks.deleteWorkspace,
  useSessionStore: () => ({ sessions: [session] }),
}));

import { closeSettle, closeWorkspaceDelete, openSettle, openWorkspaceDelete } from "@/lib/dialogs";
import { SettleDialog } from "./SettleDialog";
import { WorkspaceDeleteDialog } from "./WorkspaceDeleteDialog";

const clean: WorktreeDisposition = { exists: true, checked: true, uncommitted: 0, unpushed: 0, branch: "raccoon/quiet-amber-fox" };
const workspace: WorkspaceDisposition = {
  exists: true,
  checked: true,
  isMain: false,
  branch: "raccoon/quiet-amber-fox",
  uncommitted: 0,
  unpushed: 0,
  aheadOfBase: 0,
  pr: null,
  prChecked: true,
  sessions: 1,
};
const deleteButton = () => screen.getByRole("button", { name: /Delete (worktree|workspace|anyway)/ }) as HTMLButtonElement;

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
    let resolve!: (d: WorktreeDisposition) => void;
    mocks.worktreeDisposition.mockReturnValue(new Promise<WorktreeDisposition>((r) => (resolve = r)));
    render(<SettleDialog />);
    act(() => openSettle("s1"));
    expect(deleteButton().disabled).toBe(true);
    await act(async () => resolve(clean));
    expect(deleteButton().disabled).toBe(false);
    expect(deleteButton().textContent).toContain("Delete worktree");
  });

  it("treats a state that cannot be read as unchecked and asks a second time, naming the path", async () => {
    mocks.worktreeDisposition.mockRejectedValue(new Error("git exploded"));
    mocks.ask.mockResolvedValue(false);
    render(<SettleDialog />);
    act(() => openSettle("s1"));
    await screen.findByText("The worktree could not be checked for uncommitted or unpushed work.");
    expect(deleteButton().textContent).toContain("Delete anyway");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    expect(mocks.ask.mock.calls[0][0]).toContain("/p/.raccoon/worktrees/quiet-amber-fox");
    expect(mocks.settleSession).not.toHaveBeenCalled();
  });

  it("asks a second time for a tree git cannot check, and settles once confirmed", async () => {
    mocks.worktreeDisposition.mockResolvedValue({ ...clean, checked: false });
    mocks.ask.mockResolvedValue(true);
    mocks.settleSession.mockResolvedValue({ session, keptBranch: "raccoon/quiet-amber-fox", rescuedBranch: null });
    render(<SettleDialog />);
    act(() => openSettle("s1"));
    await screen.findByText(/not a working git checkout of this project/);
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mocks.settleSession).toHaveBeenCalledWith("s1", "delete"));
    // The kept branch is said, not just logged.
    await waitFor(() => expect(mocks.message).toHaveBeenCalled());
    expect(mocks.message.mock.calls[0][0]).toContain("raccoon/quiet-amber-fox was kept");
  });

  it("does not ask twice for a checked tree, and reads the state again after a failure", async () => {
    mocks.worktreeDisposition.mockResolvedValueOnce(clean).mockResolvedValueOnce({ ...clean, uncommitted: 2 });
    mocks.settleSession.mockRejectedValue(new Error("Could not remove the worktree"));
    render(<SettleDialog />);
    act(() => openSettle("s1"));
    await screen.findByText("Everything is committed and pushed. Safe to delete.");
    fireEvent.click(deleteButton());
    await screen.findByText("Could not remove the worktree");
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.worktreeDisposition).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/2 files have uncommitted changes/)).toBeTruthy();
    expect(deleteButton().textContent).toContain("Delete anyway");
  });
});

describe("WorkspaceDeleteDialog", () => {
  const open = () => act(() => openWorkspaceDelete("/p", "/p/.raccoon/worktrees/quiet-amber-fox", "quiet-amber-fox"));

  it("asks a second time for a directory that cannot be checked, naming the path", async () => {
    mocks.workspaceDisposition.mockResolvedValue({ ...workspace, checked: false, branch: null });
    mocks.ask.mockResolvedValue(false);
    render(<WorkspaceDeleteDialog />);
    open();
    await screen.findByText(/not a working git checkout of this project/);
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    expect(mocks.ask.mock.calls[0][0]).toContain("/p/.raccoon/worktrees/quiet-amber-fox");
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("deletes a checked workspace without the second question and says when the branch was kept", async () => {
    mocks.workspaceDisposition.mockResolvedValue(workspace);
    mocks.deleteWorkspace.mockResolvedValue({ sessions: [], keptBranch: "raccoon/quiet-amber-fox", rescuedBranch: null });
    render(<WorkspaceDeleteDialog />);
    open();
    await screen.findByText("No uncommitted changes.");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mocks.deleteWorkspace).toHaveBeenCalledWith("/p", "/p/.raccoon/worktrees/quiet-amber-fox", true));
    expect(mocks.ask).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.message).toHaveBeenCalled());
  });

  it("reads the state again after a failure", async () => {
    mocks.workspaceDisposition.mockResolvedValueOnce(workspace).mockResolvedValueOnce({ ...workspace, uncommitted: 1 });
    mocks.deleteWorkspace.mockRejectedValue(new Error("Could not remove the worktree"));
    render(<WorkspaceDeleteDialog />);
    open();
    await screen.findByText("No uncommitted changes.");
    fireEvent.click(deleteButton());
    await screen.findByText("Could not remove the worktree");
    expect(mocks.workspaceDisposition).toHaveBeenCalledTimes(2);
    expect(screen.getByText("1 file with uncommitted changes.")).toBeTruthy();
  });
});
