import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Landed, SessionEntry, WorkspaceDisposition } from "@/types/session";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
  workspaceDisposition: vi.fn(),
  removeWorkspace: vi.fn(),
  relocateSession: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, message: mocks.message }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { workspaceDisposition: mocks.workspaceDisposition },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/lib/sessions", () => ({ removeWorkspace: mocks.removeWorkspace, relocateSession: mocks.relocateSession }));

import { closeWorkspaceRemove, openSettle, openWorkspaceDelete } from "@/lib/dialogs";
import { WorkspaceRemoveDialog } from "./WorkspaceRemoveDialog";

const path = "/p/.raccoon/worktrees/quiet-amber-fox";
const session = { id: "s1", title: "Fix login", projectPath: "/p", cwd: path, worktreeName: "quiet-amber-fox" } as SessionEntry;
const safe: Landed = {
  checked: true,
  branch: "raccoon/quiet-amber-fox",
  head: "0123abcd",
  base: "origin/main",
  uncommitted: 0,
  stashes: 0,
  clean: true,
  merged: "squash",
  unmergedCommits: 0,
  pushed: true,
  fresh: true,
  notVerified: null,
  safe: true,
  losses: [],
  digest: "safe-digest",
};
const workspace = (landed: Landed, extra: Partial<WorkspaceDisposition> = {}): WorkspaceDisposition => ({
  exists: true,
  checked: landed.checked,
  isMain: false,
  branch: landed.branch,
  uncommitted: landed.uncommitted,
  unpushed: 0,
  aheadOfBase: 0,
  pr: null,
  prChecked: true,
  sessions: 2,
  sessionTitles: ["Fix login", "Review the fix"],
  sessionIds: ["s1", "s9"],
  landed,
  ...extra,
});
const dirty: Landed = { ...safe, digest: "dirty-digest", uncommitted: 2, clean: false, safe: false, losses: ["2 uncommitted files would be lost."] };
const unmerged: Landed = { ...safe, digest: "unmerged-digest", merged: null, unmergedCommits: 3, safe: false, losses: ["3 commits are not in origin/main. The branch is pushed, but not merged."] };
const unverified: Landed = { ...safe, digest: "unverified-digest", merged: "ancestor", notVerified: "origin/main could not be fetched (timed out).", safe: false, losses: ["Not verified: origin/main could not be fetched (timed out)."] };
const unchecked: Landed = { ...safe, digest: "unchecked-digest", checked: false, clean: false, merged: null, safe: false, losses: ["This folder is not a working git checkout of this project, so it cannot be checked for uncommitted or unmerged work."] };

const removeButton = () => screen.getByRole("button", { name: /^(Delete|Settle) (workspace|anyway…)$/ }) as HTMLButtonElement;
const openDelete = () => act(() => openWorkspaceDelete("/p", path, "quiet-amber-fox"));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.message.mockResolvedValue(undefined);
  mocks.removeWorkspace.mockResolvedValue({ sessions: [], keptBranch: null, rescuedBranch: null });
});
afterEach(() => {
  act(() => closeWorkspaceRemove());
  cleanup();
});

describe("WorkspaceRemoveDialog", () => {
  it("keeps the button disabled until the check has answered", async () => {
    let resolve!: (d: WorkspaceDisposition) => void;
    mocks.workspaceDisposition.mockReturnValue(new Promise<WorkspaceDisposition>((r) => (resolve = r)));
    render(<WorkspaceRemoveDialog />);
    openDelete();
    expect(removeButton().disabled).toBe(true);
    await act(async () => resolve(workspace(safe)));
    expect(removeButton().disabled).toBe(false);
  });

  it("deletes a clean, merged workspace with one confirmation, naming the sessions that go", async () => {
    mocks.workspaceDisposition.mockResolvedValue(workspace(safe));
    render(<WorkspaceRemoveDialog />);
    openDelete();
    await screen.findByText("Clean and merged: safe to remove.");
    expect(screen.getByText("Merged: the branch was squash-merged into origin/main.")).toBeTruthy();
    expect(screen.getByText("2 sessions and their transcripts will be deleted:")).toBeTruthy();
    const sessions = within(screen.getByRole("list", { name: "Sessions in this workspace" }));
    expect(sessions.getByText("Fix login")).toBeTruthy();
    expect(sessions.getByText("Review the fix")).toBeTruthy();
    expect(removeButton().textContent).toContain("Delete workspace");
    // This dialog is the caller that asks for the fetch.
    expect(mocks.workspaceDisposition).toHaveBeenCalledWith("/p", path, { fetch: true });

    fireEvent.click(removeButton());
    // The sessions it named are the ones the removal is told to expect.
    await waitFor(() =>
      expect(mocks.removeWorkspace).toHaveBeenCalledWith("/p", path, { keepSessions: false, deleteBranch: true, confirmedDigest: null, expectedSessions: ["s1", "s9"] }),
    );
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  for (const [name, landed, line] of [
    ["uncommitted changes", dirty, "2 uncommitted files would be lost."],
    ["unmerged commits", unmerged, "3 commits are not in origin/main. The branch is pushed, but not merged."],
    ["a check that could not be verified", unverified, "Not verified: origin/main could not be fetched (timed out)."],
    ["a folder that cannot be checked", unchecked, "This folder is not a working git checkout of this project, so it cannot be checked for uncommitted or unmerged work."],
  ] as const) {
    it(`shows what would be lost and asks a second time for ${name}`, async () => {
      mocks.workspaceDisposition.mockResolvedValue(workspace(landed));
      mocks.ask.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      render(<WorkspaceRemoveDialog />);
      openDelete();
      await screen.findByText("Removing it now needs a second confirmation.");
      expect(within(screen.getByRole("list", { name: "What would be lost" })).getByText(line)).toBeTruthy();
      expect(removeButton().textContent).toContain("Delete anyway…");

      // Declining the second confirmation removes nothing.
      fireEvent.click(removeButton());
      await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
      expect(mocks.ask.mock.calls[0][0]).toContain(path);
      expect(mocks.ask.mock.calls[0][0]).toContain(line);
      expect(mocks.removeWorkspace).not.toHaveBeenCalled();

      // The branch is not deleted by default with a workspace that is not
      // safe, and the confirmation says what really happens to it.
      expect(mocks.ask.mock.calls[0][0]).toContain("Its branch is kept if it holds commits that no other branch, remote or tag has");
      expect((screen.getByRole("switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");

      fireEvent.click(removeButton());
      // The second confirmation is sent as the digest of what was shown.
      await waitFor(() =>
        expect(mocks.removeWorkspace).toHaveBeenCalledWith("/p", path, { keepSessions: false, deleteBranch: false, confirmedDigest: landed.digest, expectedSessions: ["s1", "s9"] }),
      );
    });
  }

  it("removes nothing when the check fails outright: there is nothing to confirm against", async () => {
    mocks.workspaceDisposition.mockRejectedValue(new Error("git exploded"));
    render(<WorkspaceRemoveDialog />);
    openDelete();
    await screen.findByText(/could not be checked, so it cannot be removed from here/);
    expect(removeButton().disabled).toBe(true);
    expect(mocks.removeWorkspace).not.toHaveBeenCalled();
  });

  it("names the sessions of a folder that is not on disk and asks the second time", async () => {
    mocks.workspaceDisposition.mockResolvedValue(workspace(unchecked, { exists: false, branch: null }));
    mocks.ask.mockResolvedValue(false);
    render(<WorkspaceRemoveDialog />);
    openDelete();
    await screen.findByText(/The workspace folder is not on disk/);
    expect(within(screen.getByRole("list", { name: "Sessions in this workspace" })).getByText("Review the fix")).toBeTruthy();
    expect(removeButton().textContent).toContain("Delete anyway…");
    fireEvent.click(removeButton());
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    expect(mocks.removeWorkspace).not.toHaveBeenCalled();
  });

  it("settles through the same check, keeping the sessions and saying how that differs from deleting", async () => {
    mocks.workspaceDisposition.mockResolvedValue(workspace(safe));
    mocks.removeWorkspace.mockResolvedValue({ sessions: [session], keptBranch: "raccoon/quiet-amber-fox", rescuedBranch: null });
    render(<WorkspaceRemoveDialog />);
    act(() => openSettle(session));
    await screen.findByText("Clean and merged: safe to remove.");
    expect(screen.getByText(/its sessions are kept, with their conversations/)).toBeTruthy();
    expect(screen.getByText(/Deleting the workspace instead would delete its sessions too/)).toBeTruthy();
    expect(screen.getByText("2 sessions are kept and move to the project:")).toBeTruthy();
    expect(removeButton().textContent).toContain("Settle workspace");

    fireEvent.click(removeButton());
    await waitFor(() =>
      expect(mocks.removeWorkspace).toHaveBeenCalledWith("/p", path, { keepSessions: true, deleteBranch: true, confirmedDigest: null, expectedSessions: ["s1", "s9"] }),
    );
    // A kept branch is said, not just logged.
    await waitFor(() => expect(mocks.message).toHaveBeenCalled());
    expect(mocks.message.mock.calls[0][0]).toContain("raccoon/quiet-amber-fox was kept");
  });

  it("settling an unmerged workspace asks the same second confirmation", async () => {
    mocks.workspaceDisposition.mockResolvedValue(workspace(unmerged));
    mocks.ask.mockResolvedValue(false);
    render(<WorkspaceRemoveDialog />);
    act(() => openSettle(session));
    await screen.findByText("Removing it now needs a second confirmation.");
    expect(removeButton().textContent).toContain("Settle anyway…");
    fireEvent.click(removeButton());
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    expect(mocks.removeWorkspace).not.toHaveBeenCalled();
  });

  it("can move the session to the project and leave the workspace on disk", async () => {
    mocks.workspaceDisposition.mockResolvedValue(workspace(unmerged));
    mocks.relocateSession.mockResolvedValue(session);
    render(<WorkspaceRemoveDialog />);
    act(() => openSettle(session));
    await screen.findByText("Removing it now needs a second confirmation.");
    fireEvent.click(screen.getByRole("button", { name: /Move session to project/ }));
    await waitFor(() => expect(mocks.relocateSession).toHaveBeenCalledWith("s1"));
    expect(mocks.removeWorkspace).not.toHaveBeenCalled();
  });

  it("offers no move for a plain workspace delete", async () => {
    mocks.workspaceDisposition.mockResolvedValue(workspace(safe, { sessions: 0, sessionTitles: [] }));
    render(<WorkspaceRemoveDialog />);
    openDelete();
    await screen.findByText("No sessions run here.");
    expect(screen.queryByRole("button", { name: /Move session to project/ })).toBeNull();
  });

  it("shows the reason and reads the state again when the removal is refused", async () => {
    mocks.workspaceDisposition.mockResolvedValueOnce(workspace(safe)).mockResolvedValueOnce(workspace(dirty));
    mocks.removeWorkspace.mockRejectedValue(new Error("This workspace needs a second confirmation before it is removed:\n• 2 uncommitted files would be lost."));
    render(<WorkspaceRemoveDialog />);
    openDelete();
    await screen.findByText("Clean and merged: safe to remove.");
    fireEvent.click(removeButton());
    await screen.findByText(/needs a second confirmation before it is removed/);
    expect(mocks.workspaceDisposition).toHaveBeenCalledTimes(2);
    expect(removeButton().textContent).toContain("Delete anyway…");
  });
});
