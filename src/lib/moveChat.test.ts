import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { moveChatToProject, continuationPrompt } = await import("./continuation");
const sessions = await import("./sessions");
const { getDraft } = await import("./drafts");

const chat: SessionEntry = {
  id: "chat-1", projectPath: "/store/Chats", cwd: "/store/Chats", title: "Plan the login page", created: "", modified: "", pinned: false, archived: false, worktreeRemoved: false, activeTab: "chat-tab",
  tabs: [{ id: "chat-tab", harness: "claude", model: "opus", permissionMode: "auto", status: "idle", created: "", modified: "" }],
};
const context = { sessionId: "chat-1", tabId: "chat-tab", title: "Plan the login page", provider: "claude", providerSessionId: "p1", cwd: "/store/Chats", sourceActive: false, transcriptPath: "/t/p1.jsonl", fullUnavailableReason: null, lastPrompt: "make it", lastUpdate: "ok", partialCapture: null };
const created = { ...chat, id: "work-1", projectPath: "/repos/web", cwd: "/repos/web/.raccoon/worktrees/x", tabs: [{ ...chat.tabs[0], id: "work-tab" }] };

function answer(sendFails = false) {
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "prepare_continuation") return context;
    if (command === "create_session") return created;
    if (command === "set_session_archived" || command === "ensure_tab_started") return;
    if (command === "send_message") {
      if (sendFails) throw new Error("no echo");
      return { events: [] };
    }
    return undefined;
  });
}

beforeEach(() => {
  sessions.upsertSession(chat);
});

describe("moving a chat into a project", () => {
  it("starts the same agent in the project on a new branch, hands it the chat, and archives the chat", async () => {
    answer();
    const moved = await moveChatToProject(chat, "/repos/web", true);

    expect(moved).toEqual({ sessionId: "work-1", delivered: true });
    expect(mocks.invoke).toHaveBeenCalledWith("create_session", {
      req: expect.objectContaining({ projectPath: "/repos/web", title: "Plan the login page", useWorktree: true, onMain: false, tab: expect.objectContaining({ harness: "claude", model: "opus" }) }),
    });
    const send = mocks.invoke.mock.calls.find(([command]) => command === "send_message")!;
    expect(send[1]).toMatchObject({ sessionId: "work-1", tabId: "work-tab", confirmDelivery: true });
    expect((send[1] as { text: string }).text).toContain("into the project at /repos/web");
    expect(mocks.invoke).toHaveBeenCalledWith("set_session_archived", { sessionId: "chat-1", archived: true });
    expect(sessions.getSessionStore().selectedSessionId).toBe("work-1");
  });

  it("keeps the move and leaves the handoff in the composer when delivery is not confirmed", async () => {
    answer(true);
    const moved = await moveChatToProject(chat, "/repos/web", false);
    expect(moved.delivered).toBe(false);
    expect(getDraft("work-tab")).toContain("Continue work from the prior TerminalX conversation");
  });

  it("does not call a moved conversation the same workspace", () => {
    expect(continuationPrompt(context, "focused", "/repos/web")).not.toContain("This is the same shared workspace");
    expect(continuationPrompt(context, "focused")).toContain("This is the same shared workspace");
  });
});
