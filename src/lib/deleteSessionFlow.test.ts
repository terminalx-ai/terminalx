import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const ask = vi.fn();
const message = vi.fn();
const deleteSession = vi.fn();
const soleWorkspaceOf = vi.fn();
const openWorkspaceDelete = vi.fn();
const quickChatScratch = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => ask(...args),
  message: (...args: unknown[]) => message(...args),
}));
vi.mock("@/lib/sessions", () => ({ deleteSession: (...args: unknown[]) => deleteSession(...args) }));
vi.mock("@/lib/dialogs", () => ({ openWorkspaceDelete: (...args: unknown[]) => openWorkspaceDelete(...args) }));
vi.mock("@/lib/api", () => ({
  api: { soleWorkspaceOf: (...args: unknown[]) => soleWorkspaceOf(...args), quickChatScratch: (...args: unknown[]) => quickChatScratch(...args) },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { confirmDeleteSession } from "./deleteSessionFlow";

const cwd = "/p/.raccoon/worktrees/quiet-amber-fox";
const session = { id: "s1", title: "Fix login", projectPath: "/p", cwd, worktreeName: "quiet-amber-fox", worktreeRemoved: false } as SessionEntry;
const atRoot = { id: "s2", title: "At the root", projectPath: "/p", cwd: "/p", worktreeName: null, worktreeRemoved: false } as SessionEntry;

describe("confirmDeleteSession", () => {
  beforeEach(() => {
    for (const mock of [ask, message, deleteSession, soleWorkspaceOf, openWorkspaceDelete, quickChatScratch]) mock.mockReset();
    quickChatScratch.mockResolvedValue({ path: "/home/.raccoon/quick/q1", files: 0, more: false, inUse: true });
    deleteSession.mockResolvedValue(undefined);
    message.mockResolvedValue(undefined);
    soleWorkspaceOf.mockResolvedValue(null);
  });

  it("deletes only the session when others share its workspace, and says the workspace stays", async () => {
    ask.mockResolvedValue(true);
    await confirmDeleteSession(session);
    expect(soleWorkspaceOf).toHaveBeenCalledWith("s1");
    expect(ask.mock.calls[0][0]).toContain("Its workspace quiet-amber-fox stays, with the other sessions in it.");
    expect(message).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(openWorkspaceDelete).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is declined", async () => {
    ask.mockResolvedValue(false);
    await confirmDeleteSession(session);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("does not look for a workspace for a session at the project root", async () => {
    ask.mockResolvedValue(true);
    await confirmDeleteSession(atRoot);
    expect(soleWorkspaceOf).not.toHaveBeenCalled();
    expect(ask.mock.calls[0][0]).not.toContain("stays");
    expect(deleteSession).toHaveBeenCalledWith("s2");
  });

  it("offers the workspace too when it is the last session there, and deletes only the session by default", async () => {
    soleWorkspaceOf.mockResolvedValue(cwd);
    message.mockResolvedValue("Delete session");
    await confirmDeleteSession(session);
    const [text, options] = message.mock.calls[0];
    expect(text).toContain("It is the last session in the workspace quiet-amber-fox");
    expect(options).toMatchObject({ buttons: { yes: "Delete session", no: "Also delete the workspace…", cancel: "Cancel" } });
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(openWorkspaceDelete).not.toHaveBeenCalled();
  });

  it("hands the workspace to the shared workspace dialog rather than deleting it itself", async () => {
    soleWorkspaceOf.mockResolvedValue(cwd);
    message.mockResolvedValue("Also delete the workspace…");
    await confirmDeleteSession(session);
    expect(openWorkspaceDelete).toHaveBeenCalledWith("/p", cwd, "quiet-amber-fox");
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("cancels from the last-session dialog", async () => {
    soleWorkspaceOf.mockResolvedValue(cwd);
    message.mockResolvedValue("Cancel");
    await confirmDeleteSession(session);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(openWorkspaceDelete).not.toHaveBeenCalled();
  });

  it("leaves the workspace alone when the backend cannot say whether it is shared", async () => {
    soleWorkspaceOf.mockRejectedValue(new Error("boom"));
    ask.mockResolvedValue(true);
    await confirmDeleteSession(session);
    expect(message).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(openWorkspaceDelete).not.toHaveBeenCalled();
  });

  it("shows why a delete failed", async () => {
    ask.mockResolvedValue(true);
    deleteSession.mockRejectedValue(new Error("index is locked"));
    await confirmDeleteSession(atRoot);
    expect(message.mock.calls[0][0]).toContain("index is locked");
  });

  describe("a quick chat", () => {
    const scratch = "/home/.raccoon/quick/q1";
    const quick = { id: "q1", kind: "quick", title: "What is a monad?", projectPath: scratch, cwd: scratch, worktreeName: null, worktreeRemoved: false } as SessionEntry;

    it("is deleted after one plain confirmation when its scratch folder is empty", async () => {
      ask.mockResolvedValue(true);
      await confirmDeleteSession(quick);
      expect(quickChatScratch).toHaveBeenCalledWith("q1");
      expect(soleWorkspaceOf).not.toHaveBeenCalled();
      const [text, options] = ask.mock.calls[0];
      expect(text).toBe('Delete "What is a monad?"? Its transcript and attachments are removed.');
      expect(options).toMatchObject({ title: "Delete quick chat", okLabel: "Delete" });
      expect(deleteSession).toHaveBeenCalledWith("q1");
    });

    it("names the files in its scratch folder before they are deleted with it", async () => {
      quickChatScratch.mockResolvedValue({ path: scratch, files: 3, more: false, inUse: true });
      ask.mockResolvedValue(false);
      await confirmDeleteSession(quick);
      const [text, options] = ask.mock.calls[0];
      expect(text).toContain("Its scratch folder holds 3 files, which are deleted with it:");
      expect(text).toContain(scratch);
      expect(options.okLabel).toBe("Delete chat and files");
      // Declined: nothing goes.
      expect(deleteSession).not.toHaveBeenCalled();

      quickChatScratch.mockResolvedValue({ path: scratch, files: 1, more: false, inUse: true });
      await confirmDeleteSession(quick);
      expect(ask.mock.calls[1][0]).toContain("holds 1 file, which is deleted with it");
      quickChatScratch.mockResolvedValue({ path: scratch, files: 1000, more: true, inUse: true });
      await confirmDeleteSession(quick);
      expect(ask.mock.calls[2][0]).toContain("holds 1000 or more files, which are deleted with it");
    });

    it("says a folder it was pointed at is the reader's and stays", async () => {
      ask.mockResolvedValue(true);
      await confirmDeleteSession({ ...quick, cwd: "/Users/me/notes" });
      expect(ask.mock.calls[0][0]).toContain("The folder it runs in (/Users/me/notes) is yours and is not touched.");
      expect(deleteSession).toHaveBeenCalledWith("q1");
    });
  });
});

