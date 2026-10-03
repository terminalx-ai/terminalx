import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const ask = vi.fn();
const deleteSession = vi.fn();
const worktreeDisposition = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...args: unknown[]) => ask(...args) }));
vi.mock("@/lib/sessions", () => ({ deleteSession: (...args: unknown[]) => deleteSession(...args) }));
vi.mock("@/lib/api", () => ({
  api: { worktreeDisposition: (...args: unknown[]) => worktreeDisposition(...args) },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { confirmDeleteSession } from "./deleteSessionFlow";

const session = { id: "s1", title: "Fix login", worktreeName: "quiet-amber-fox", worktreeRemoved: false } as SessionEntry;

describe("confirmDeleteSession", () => {
  beforeEach(() => {
    ask.mockReset();
    deleteSession.mockReset();
    worktreeDisposition.mockReset().mockResolvedValue({ exists: true, uncommitted: 0, unpushed: 0, branch: "raccoon/quiet-amber-fox" });
  });

  it("says the directory is deleted rather than moved to the Trash", async () => {
    ask.mockResolvedValueOnce(false);
    await confirmDeleteSession(session);
    expect(ask.mock.calls[0][0]).toContain("This deletes the directory; it is not moved to the Trash.");
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("warns about unpushed and uncommitted work", async () => {
    worktreeDisposition.mockResolvedValue({ exists: true, uncommitted: 2, unpushed: 1, branch: null });
    ask.mockResolvedValueOnce(false);
    await confirmDeleteSession(session);
    expect(ask.mock.calls[0][0]).toContain("1 unpushed commit and 2 uncommitted files");
  });

  it("shows why a delete failed and retries it when asked", async () => {
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    deleteSession.mockRejectedValueOnce(new Error("Could not remove the worktree at /p/.raccoon/worktrees/quiet-amber-fox: Permission denied")).mockResolvedValueOnce(undefined);
    await confirmDeleteSession(session);
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]).toContain("/p/.raccoon/worktrees/quiet-amber-fox: Permission denied");
    expect(ask.mock.calls[1][1]).toMatchObject({ okLabel: "Retry", cancelLabel: "Keep session" });
  });

  it("stops retrying when the person keeps the session", async () => {
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    deleteSession.mockRejectedValue(new Error("Permission denied"));
    await confirmDeleteSession(session);
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });
});
