import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

/** The app's own confirmation (PRO-400): one request object, answered true or false. */
const ask = vi.fn();
/** Its three-way form, answered "action", "alternative" or "cancel". */
const choose = vi.fn();
/** The system alert, which only reports a failure now. */
const message = vi.fn();
const deleteSession = vi.fn();
const soleWorkspaceOf = vi.fn();
const openWorkspaceDelete = vi.fn();
const quickChatScratch = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) => message(...args),
}));
vi.mock("@/lib/confirm", () => ({
  confirmInApp: (...args: unknown[]) => ask(...args),
  chooseInApp: (...args: unknown[]) => choose(...args),
}));
vi.mock("@/lib/sessions", () => ({ deleteSession: (...args: unknown[]) => deleteSession(...args) }));
vi.mock("@/lib/dialogs", () => ({ openWorkspaceDelete: (...args: unknown[]) => openWorkspaceDelete(...args) }));
vi.mock("@/lib/api", () => ({
  api: { soleWorkspaceOf: (...args: unknown[]) => soleWorkspaceOf(...args), quickChatScratch: (...args: unknown[]) => quickChatScratch(...args) },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { CONVERSATION_DELETION } from "./conversationRetention";
import { confirmDeleteSession, confirmDeleteSessions } from "./deleteSessionFlow";

const cwd = "/p/.raccoon/worktrees/quiet-amber-fox";
const session = { id: "s1", title: "Fix login", projectPath: "/p", cwd, worktreeName: "quiet-amber-fox", worktreeRemoved: false } as SessionEntry;
const atRoot = { id: "s2", title: "At the root", projectPath: "/p", cwd: "/p", worktreeName: null, worktreeRemoved: false } as SessionEntry;

describe("confirmDeleteSession", () => {
  beforeEach(() => {
    for (const mock of [ask, choose, message, deleteSession, soleWorkspaceOf, openWorkspaceDelete, quickChatScratch]) mock.mockReset();
    quickChatScratch.mockResolvedValue({ path: "/home/.raccoon/quick/q1", files: 0, more: false, inUse: true });
    deleteSession.mockResolvedValue(undefined);
    message.mockResolvedValue(undefined);
    soleWorkspaceOf.mockResolvedValue(null);
  });

  it("deletes only the session when others share its workspace, and says the workspace stays", async () => {
    ask.mockResolvedValue(true);
    await confirmDeleteSession(session);
    expect(soleWorkspaceOf).toHaveBeenCalledWith("s1");
    const request = ask.mock.calls[0][0];
    // The question is the title; what happens is the body; the action is red and on the right.
    expect(request).toMatchObject({ title: 'Delete "Fix login"?', action: "Delete", destructive: true });
    expect(request.body).toContain("provider-side usage");
    expect(request.body).toContain("managed Codex rollout files");
    expect(request.body).toContain("Its workspace quiet-amber-fox stays, with the other sessions in it.");
    expect(choose).not.toHaveBeenCalled();
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
    expect(ask.mock.calls[0][0].body).not.toContain("stays");
    expect(deleteSession).toHaveBeenCalledWith("s2");
  });

  it("offers the workspace too when it is the last session there, and deletes only the session by default", async () => {
    soleWorkspaceOf.mockResolvedValue(cwd);
    choose.mockResolvedValue("action");
    await confirmDeleteSession(session);
    const request = choose.mock.calls[0][0];
    expect(request.body).toContain("It is the last session in the workspace quiet-amber-fox");
    expect(request).toMatchObject({ title: 'Delete "Fix login"?', action: "Delete session", alternative: "Also delete the workspace…", destructive: true });
    expect(message).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(openWorkspaceDelete).not.toHaveBeenCalled();
  });

  it("hands the workspace to the shared workspace dialog rather than deleting it itself", async () => {
    soleWorkspaceOf.mockResolvedValue(cwd);
    choose.mockResolvedValue("alternative");
    await confirmDeleteSession(session);
    expect(openWorkspaceDelete).toHaveBeenCalledWith("/p", cwd, "quiet-amber-fox");
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("cancels from the last-session dialog", async () => {
    soleWorkspaceOf.mockResolvedValue(cwd);
    choose.mockResolvedValue("cancel");
    await confirmDeleteSession(session);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(openWorkspaceDelete).not.toHaveBeenCalled();
  });

  it("leaves the workspace alone when the backend cannot say whether it is shared", async () => {
    soleWorkspaceOf.mockRejectedValue(new Error("boom"));
    ask.mockResolvedValue(true);
    await confirmDeleteSession(session);
    expect(choose).not.toHaveBeenCalled();
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
      expect(ask.mock.calls[0][0]).toEqual({
        title: 'Delete "What is a monad?"?',
        body: `Its transcript and attachments are removed.\n\n${CONVERSATION_DELETION}`,
        action: "Delete",
        destructive: true,
      });
      expect(deleteSession).toHaveBeenCalledWith("q1");
    });

    it("names the files in its scratch folder before they are deleted with it", async () => {
      quickChatScratch.mockResolvedValue({ path: scratch, files: 3, more: false, inUse: true });
      ask.mockResolvedValue(false);
      await confirmDeleteSession(quick);
      const { body: text, action } = ask.mock.calls[0][0];
      expect(text).toContain("Its scratch folder holds 3 files, which are deleted with it:");
      expect(text).toContain(scratch);
      expect(action).toBe("Delete chat and files");
      // Declined: nothing goes.
      expect(deleteSession).not.toHaveBeenCalled();

      quickChatScratch.mockResolvedValue({ path: scratch, files: 1, more: false, inUse: true });
      await confirmDeleteSession(quick);
      expect(ask.mock.calls[1][0].body).toContain("holds 1 file, which is deleted with it");
      quickChatScratch.mockResolvedValue({ path: scratch, files: 1000, more: true, inUse: true });
      await confirmDeleteSession(quick);
      expect(ask.mock.calls[2][0].body).toContain("holds 1000 or more files, which are deleted with it");
    });

    it("says a folder it was pointed at is the reader's and stays", async () => {
      ask.mockResolvedValue(true);
      await confirmDeleteSession({ ...quick, cwd: "/Users/me/notes" });
      expect(ask.mock.calls[0][0].body).toContain("The folder it runs in (/Users/me/notes) is yours and is not touched.");
      expect(deleteSession).toHaveBeenCalledWith("q1");
    });
  });
});

describe("confirmDeleteSessions: several at once (#718)", () => {
  /** A quick chat, in its scratch folder unless it was pointed at `cwd`. */
  const chat = (id: string, cwd = `/home/.raccoon/quick/${id}`) =>
    ({ id, kind: "quick", title: `Chat ${id}`, projectPath: `/home/.raccoon/quick/${id}`, cwd, worktreeName: null, worktreeRemoved: false }) as SessionEntry;
  const folder = (id: string, files: number, more = false) => ({ path: `/home/.raccoon/quick/${id}`, files, more, inUse: true });

  beforeEach(() => {
    for (const mock of [ask, choose, message, deleteSession, soleWorkspaceOf, openWorkspaceDelete, quickChatScratch]) mock.mockReset();
    deleteSession.mockResolvedValue(undefined);
    message.mockResolvedValue(undefined);
  });

  it("names the files in the quick chats' scratch folders before deleting them, as the dialog for one does", async () => {
    const scratches: Record<string, ReturnType<typeof folder>> = { a: folder("a", 2), b: folder("b", 0) };
    quickChatScratch.mockImplementation(async (id: string) => scratches[id]);
    ask.mockResolvedValue(true);

    expect(await confirmDeleteSessions([chat("a"), chat("b"), atRoot])).toBe(true);
    const { title, body: text, action } = ask.mock.calls[0][0];
    expect(text).toContain("A quick chat's scratch folder holds 2 files, which are deleted with it:\n/home/.raccoon/quick/a");
    // The empty one needs no mention, and nothing here is unknown or the reader's own.
    expect(text).not.toContain("/home/.raccoon/quick/b");
    expect(text).not.toMatch(/could not be read|not touched/);
    expect(title).toBe("Delete 3 sessions?");
    expect(action).toBe("Delete 3 and files");
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual(["a", "b", "s2"]);
  });

  it("says which folders could not be read and which are the reader's own, and deletes nothing when cancelled", async () => {
    const scratches: Record<string, ReturnType<typeof folder>> = { c: folder("c", 1, true), d: folder("d", 3) };
    quickChatScratch.mockImplementation(async (id: string) => {
      if (id === "e") throw new Error("gone");
      return scratches[id];
    });
    ask.mockResolvedValue(false);

    expect(await confirmDeleteSessions([chat("c", "/Users/me/notes"), chat("d"), chat("e")])).toBe(false);
    const { title, body: text, action } = ask.mock.calls[0][0];
    expect(text).toContain("2 quick chats' scratch folders hold 4 or more files, which are deleted with them:\n/home/.raccoon/quick/c\n/home/.raccoon/quick/d");
    expect(text).toContain("One quick chat's scratch folder could not be read; it is deleted with whatever is in it.");
    expect(text).toContain("The folder one of them runs in is yours and is not touched.");
    expect(title).toBe("Delete 3 sessions?");
    expect(action).toBe("Delete 3 and files");
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("keeps the plain wording when no scratch folder holds anything", async () => {
    quickChatScratch.mockImplementation(async (id: string) => folder(id, 0));
    ask.mockResolvedValue(true);

    await confirmDeleteSessions([chat("f"), session]);
    const { title, body: text, action } = ask.mock.calls[0][0];
    expect(title).toBe("Delete 2 sessions?");
    expect(text).toBe(`Their transcripts and attachments are removed. Their workspaces stay on disk.\n\n${CONVERSATION_DELETION}`);
    expect(action).toBe("Delete 2");
  });
});
