import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const ask = vi.fn();
const message = vi.fn();
const deleteSession = vi.fn();
const worktreeDisposition = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => ask(...args),
  message: (...args: unknown[]) => message(...args),
}));
vi.mock("@/lib/sessions", () => ({ deleteSession: (...args: unknown[]) => deleteSession(...args) }));
vi.mock("@/lib/api", () => ({
  api: { worktreeDisposition: (...args: unknown[]) => worktreeDisposition(...args) },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { confirmDeleteSession } from "./deleteSessionFlow";

const session = { id: "s1", title: "Fix login", worktreeName: "quiet-amber-fox", worktreeRemoved: false } as SessionEntry;
const clean = { exists: true, checked: true, uncommitted: 0, unpushed: 0, branch: "raccoon/quiet-amber-fox" };

describe("confirmDeleteSession", () => {
  beforeEach(() => {
    ask.mockReset();
    message.mockReset().mockResolvedValue(undefined);
    deleteSession.mockReset().mockResolvedValue({ keptBranch: null });
    worktreeDisposition.mockReset().mockResolvedValue(clean);
  });

  it("says the directory is deleted rather than moved to the Trash", async () => {
    ask.mockResolvedValueOnce(false);
    await confirmDeleteSession(session);
    expect(ask.mock.calls[0][0]).toContain("This deletes the directory; it is not moved to the Trash.");
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("warns about unpushed and uncommitted work", async () => {
    worktreeDisposition.mockResolvedValue({ ...clean, uncommitted: 2, unpushed: 1 });
    ask.mockResolvedValueOnce(false);
    await confirmDeleteSession(session);
    expect(ask.mock.calls[0][0]).toContain("1 unpushed commit and 2 uncommitted files");
  });

  it("never calls a worktree it could not check clean, and asks twice", async () => {
    worktreeDisposition.mockResolvedValue({ ...clean, checked: false });
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await confirmDeleteSession(session);
    expect(ask.mock.calls[0][0]).toContain("cannot be checked for uncommitted or unpushed work");
    expect(ask.mock.calls[0][0]).not.toContain("Its worktree, transcript and attachments are removed.");
    expect(ask.mock.calls[1][1]).toMatchObject({ okLabel: "Delete anyway" });
    expect(deleteSession).not.toHaveBeenCalled();

    ask.mockReset().mockResolvedValue(true);
    await confirmDeleteSession(session);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("asks twice when the state cannot be read at all", async () => {
    worktreeDisposition.mockRejectedValue(new Error("boom"));
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await confirmDeleteSession(session);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("shows why a delete failed without claiming nothing was deleted", async () => {
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    deleteSession.mockRejectedValueOnce(new Error("Could not remove the worktree at /p/.raccoon/worktrees/quiet-amber-fox: Permission denied. It was partly removed: 12 MB remain on disk and it is no longer a usable checkout."));
    await confirmDeleteSession(session);
    const [text, options] = ask.mock.calls[1];
    expect(text).toContain("It was partly removed: 12 MB remain on disk");
    expect(text).not.toContain("Nothing was deleted");
    expect(options).toMatchObject({ okLabel: "Retry", cancelLabel: "Close" });
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("reads the worktree's state again and asks again before a retry", async () => {
    deleteSession.mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce({ keptBranch: null });
    worktreeDisposition.mockResolvedValueOnce(clean).mockResolvedValueOnce({ ...clean, uncommitted: 3 });
    // Confirm, retry, then decline once the new work is shown.
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await confirmDeleteSession(session);
    expect(worktreeDisposition).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[2][0]).toContain("3 uncommitted files");
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("retries when confirmed again", async () => {
    deleteSession.mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce({ keptBranch: null });
    ask.mockResolvedValue(true);
    await confirmDeleteSession(session);
    expect(deleteSession).toHaveBeenCalledTimes(2);
  });

  it("says when the branch was kept", async () => {
    ask.mockResolvedValue(true);
    deleteSession.mockResolvedValue({ keptBranch: "raccoon/quiet-amber-fox" });
    await confirmDeleteSession(session);
    expect(message.mock.calls[0][0]).toContain("raccoon/quiet-amber-fox was kept");
  });
});
