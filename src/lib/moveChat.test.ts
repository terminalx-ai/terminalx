import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import type { LaunchSettings } from "@/lib/useSessionAgent";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { moveChatToProject, continuationPrompt } = await import("./continuation");
const sessions = await import("./sessions");
const { getDraft, setDraft } = await import("./drafts");

const chat: SessionEntry = {
  id: "chat-1", projectPath: "/store/Chats", cwd: "/store/Chats", title: "Plan the login page", created: "", modified: "", pinned: false, archived: false, worktreeRemoved: false, activeTab: "chat-tab",
  tabs: [{ id: "chat-tab", harness: "claude", model: "opus", permissionMode: "auto", status: "idle", created: "", modified: "" }],
};
const context = { sessionId: "chat-1", tabId: "chat-tab", title: "Plan the login page", provider: "claude", providerSessionId: "p1", cwd: "/store/Chats", sourceActive: false, transcriptPath: "/t/p1.jsonl", fullUnavailableReason: null, lastPrompt: "make it", lastUpdate: "ok", partialCapture: null };
const created = { ...chat, id: "work-1", projectPath: "/repos/web", cwd: "/repos/web/.raccoon/worktrees/x", tabs: [{ ...chat.tabs[0], id: "work-tab", harness: "codex" }] };
// Another provider than the chat's, with its own model, effort and mode.
const selected: LaunchSettings = { harness: "codex", model: "gpt-6", effort: "high", permissionMode: "plan" };
const prompt = continuationPrompt(context, "full", "/repos/web");

function answer({ startFails = 0, sendFails = false, archiveFails = false } = {}) {
  let starts = 0;
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_harnesses") return [{ id: "claude", available: true }, { id: "codex", available: true }];
    if (command === "create_session") return created;
    if (command === "ensure_tab_started" && ++starts <= startFails) throw new Error("spawn failed");
    if (command === "set_session_archived" && archiveFails) throw new Error("store is read-only");
    if (command === "set_session_archived" || command === "ensure_tab_started") return;
    if (command === "send_message") {
      if (sendFails) throw new Error("no echo");
      return { events: [] };
    }
    return undefined;
  });
}
const calls = (name: string) => mocks.invoke.mock.calls.filter(([command]) => command === name);
const order = (name: string) => mocks.invoke.mock.invocationCallOrder[mocks.invoke.mock.calls.findIndex(([command]) => command === name)];

beforeEach(() => {
  sessions.upsertSession(chat);
});

describe("moving a chat into a project", () => {
  it("starts exactly the selected settings in the project, hands it the chat, then archives the chat", async () => {
    answer();
    const onCreated = vi.fn();
    const moved = await moveChatToProject({ id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: true }, selected, prompt, onCreated);

    expect(moved).toEqual({ stage: "delivered", launched: { sessionId: "work-1", tab: created.tabs[0] } });
    expect(onCreated).toHaveBeenCalledWith({ sessionId: "work-1", tab: created.tabs[0] });
    expect(mocks.invoke).toHaveBeenCalledWith("create_session", {
      req: { projectPath: "/repos/web", title: "Plan the login page", useWorktree: true, onMain: false, tab: { harness: "codex", model: "gpt-6", effort: "high", permissionMode: "plan" } },
    });
    const send = calls("send_message")[0]!;
    expect(send[1]).toMatchObject({ sessionId: "work-1", tabId: "work-tab", text: prompt, confirmDelivery: true });
    expect(mocks.invoke).toHaveBeenCalledWith("set_session_archived", { sessionId: "chat-1", archived: true });
    expect(order("ensure_tab_started")).toBeLessThan(order("set_session_archived"));
    expect(sessions.getSessionStore().selectedSessionId).toBe("work-1");
    expect(getDraft("work-tab")).toBe("");
  });

  it("runs in the project's main checkout when asked", async () => {
    answer();
    await moveChatToProject({ id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: false }, selected, prompt, vi.fn());
    expect(calls("create_session")[0]![1]).toMatchObject({ req: { useWorktree: false, onMain: true } });
  });

  it("leaves the chat unarchived when the new session cannot start, and retries that session without creating another", async () => {
    answer({ startFails: 1 });
    const failed = await moveChatToProject({ id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: true }, selected, prompt, vi.fn());

    expect(failed.stage).toBe("launch");
    expect(failed.stage !== "delivered" && failed.error).toMatch(/Could not start the new session: .*spawn failed.* The chat has not been archived\./);
    expect(calls("set_session_archived")).toHaveLength(0);
    expect(calls("send_message")).toHaveLength(0);
    expect(getDraft("work-tab")).toBe(prompt);

    const retried = await moveChatToProject({ id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: true }, selected, prompt, vi.fn(), failed.launched);
    expect(retried.stage).toBe("delivered");
    expect(calls("create_session")).toHaveLength(1);
    expect(calls("set_session_archived")).toHaveLength(1);
  });

  it("creates nothing when the selected provider is no longer available", async () => {
    answer();
    const gone = await moveChatToProject({ id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: true }, { ...selected, harness: "gemini" }, prompt, vi.fn());
    expect(gone).toMatchObject({ stage: "launch", launched: undefined });
    expect(calls("create_session")).toHaveLength(0);
    expect(calls("set_session_archived")).toHaveLength(0);
  });

  it("still hands over the context when the chat cannot be archived, and says the chat is still listed", async () => {
    answer({ archiveFails: true });
    const moved = await moveChatToProject({ id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: true }, selected, prompt, vi.fn());
    expect(moved.stage).toBe("archive");
    expect(moved.stage !== "delivered" && moved.error).toBe("The new session started and has the chat's context. The chat could not be archived, so it is still in the list: store is read-only");
    expect(calls("send_message")).toHaveLength(1);
    expect(getDraft("work-tab")).toBe("");
  });

  it("names both failures when neither the archive nor the delivery went through", async () => {
    answer({ archiveFails: true, sendFails: true });
    const moved = await moveChatToProject({ id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: true }, selected, prompt, vi.fn());
    expect(moved.stage).toBe("delivery");
    expect(moved.stage !== "delivered" && moved.error).toMatch(/prepared prompt is in its composer.*no echo The chat could not be archived, so it is still in the list/);
    expect(getDraft("work-tab")).toBe(prompt);
  });

  it("keeps the move and leaves the handoff in the composer when delivery is not confirmed", async () => {
    answer({ sendFails: true });
    const moved = await moveChatToProject({ id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: false }, selected, prompt, vi.fn());
    expect(moved.stage).toBe("delivery");
    expect(calls("set_session_archived")).toHaveLength(1);
    expect(getDraft("work-tab")).toBe(prompt);
  });

  it("does not call a moved conversation the same workspace", () => {
    expect(continuationPrompt(context, "focused", "/repos/web")).not.toContain("This is the same shared workspace");
    expect(continuationPrompt(context, "focused")).toContain("This is the same shared workspace");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it.each(["archive", "retry"].flatMap((phase) => ["delivered", "delivery"].flatMap((stage) => ["untouched", "identical", "empty"].map((edit) => ({ phase, stage, edit })))))(
  "preserves move ownership across $phase: $edit, $stage", async ({ phase, stage, edit }) => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const sending = deferred<void>();
    const delivery = deferred<{ events: [] }>();
    let starts = 0;
    mocks.invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === "list_harnesses") return [{ id: "codex", available: true }];
      if (command === "create_session") return created;
      if (command === "ensure_tab_started" && ++starts === 1 && phase === "retry") {
        entered.resolve();
        return gate.promise;
      }
      if (command === "set_session_archived" && phase === "archive") {
        entered.resolve();
        return gate.promise;
      }
      if (command === "send_message") { sending.resolve(); return delivery.promise; }
      return undefined;
    });
    const run = (existing?: Parameters<typeof moveChatToProject>[5]) => moveChatToProject(
      { id: chat.id, title: chat.title }, { projectPath: "/repos/web", worktree: true }, selected, prompt, vi.fn(), existing,
    );
    let running = run();
    await entered.promise;
    expect(getDraft("work-tab")).toBe(prompt);
    expect(calls("send_message")).toHaveLength(0);
    if (edit !== "untouched") setDraft("work-tab", "user edit");
    if (phase === "retry") {
      gate.reject(new Error("spawn failed"));
      const failed = await running;
      expect(failed.stage).toBe("launch");
      expect(calls("set_session_archived")).toHaveLength(0);
      if (edit !== "untouched") setDraft("work-tab", edit === "empty" ? "" : prompt);
      running = run(failed.launched);
    } else {
      if (edit !== "untouched") setDraft("work-tab", edit === "empty" ? "" : prompt);
      gate.resolve();
    }
    await sending.promise;
    const expected = edit === "identical" ? prompt : "";
    expect(getDraft("work-tab")).toBe(expected);
    if (stage === "delivered") delivery.resolve({ events: [] });
    else delivery.reject(new Error("uncertain delivery"));
    const result = await running;
    expect(result.stage).toBe(stage);
    expect(getDraft("work-tab")).toBe(edit === "untouched" && stage === "delivery" ? prompt : expected);
    expect(calls("create_session")).toHaveLength(1);
    expect(calls("send_message")).toHaveLength(1);
    expect(calls("send_message")[0][1]).toMatchObject({ text: prompt, confirmDelivery: true });
    expect(order("ensure_tab_started")).toBeLessThan(order("set_session_archived"));
  },
);
