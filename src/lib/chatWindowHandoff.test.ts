import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Separate module instances stand in for separate webviews; only the event bus
// crosses between them, just as it does in Tauri.
const bus = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn().mockResolvedValue(undefined),
  emitTo: vi.fn(),
  holdReplies: false,
  reply: null as null | { target: string; event: string; payload: unknown },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bus.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: bus.emitTo,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void, options: { target: { label: string } }) => {
    const key = `${options.target.label}:${event}`;
    bus.listeners.set(key, handler);
    return () => bus.listeners.delete(key);
  }),
}));

async function windowModules(label: "main" | `chat-${string}`) {
  vi.resetModules();
  (await import("./appWindow")).setAppWindowForTest(label);
  return { drafts: await import("./drafts"), handoff: await import("./chatWindowHandoff") };
}
function releaseReply() {
  const reply = bus.reply!;
  bus.listeners.get(`${reply.target}:${reply.event}`)?.({ payload: reply.payload });
}

beforeEach(() => {
  bus.listeners.clear();
  bus.invoke.mockClear();
  bus.holdReplies = false;
  bus.reply = null;
  bus.emitTo.mockReset().mockImplementation(async (target: string, event: string, payload: unknown) => {
    if (bus.holdReplies && event === "chat-window-drafts-result") {
      bus.reply = { target, event, payload };
      return;
    }
    bus.listeners.get(`${target}:${event}`)?.({ payload });
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("drafts moving from an independent window to main", () => {
  it("copies every unsent tab into the real destination store before closing the source", async () => {
    const main = await windowModules("main");
    await main.handoff.listenForChatWindowDrafts();
    main.drafts.setDraft("main-only", "Keep this draft too");
    const source = await windowModules("chat-one");
    source.drafts.setDraft("active", "An unsent message\nwith two lines");
    source.drafts.setDraft("inactive", "Another tab's draft");
    source.drafts.setDraft("main-only", "");
    bus.holdReplies = true;
    const moving = source.handoff.openChatWindowInMain("session", "active");
    await vi.waitFor(() => expect(bus.reply).not.toBeNull());
    expect(main.drafts.getDraft("active")).toBe("An unsent message\nwith two lines");
    expect(main.drafts.getDraft("inactive")).toBe("Another tab's draft");
    expect(main.drafts.getDraft("main-only")).toBe("Keep this draft too");
    expect(bus.invoke).not.toHaveBeenCalled();
    releaseReply();
    await moving;
    expect(bus.invoke).toHaveBeenCalledExactlyOnceWith("chat_window_open_in_main", { sessionId: "session", tabId: "active", closeSource: true });
    expect(bus.listeners.has("chat-one:chat-window-drafts-result")).toBe(false);
  });

  it("keeps both windows' drafts on conflict, without partially copying other tabs", async () => {
    const main = await windowModules("main");
    await main.handoff.listenForChatWindowDrafts();
    main.drafts.setDraft("active", "Main window's unsent message");
    const source = await windowModules("chat-one");
    source.drafts.setDraft("other", "Another tab");
    source.drafts.setDraft("active", "Source window's unsent message");
    await expect(source.handoff.openChatWindowInMain("session", "active")).rejects.toThrow("different unsent draft");
    expect(main.drafts.getDraft("active")).toBe("Main window's unsent message");
    expect(main.drafts.getDraft("other")).toBe("");
    expect(source.drafts.getDraft("active")).toBe("Source window's unsent message");
    expect(bus.invoke).not.toHaveBeenCalled();
  });

  it("keeps edits made while the receiver is acknowledging the transfer", async () => {
    const main = await windowModules("main");
    await main.handoff.listenForChatWindowDrafts();
    const source = await windowModules("chat-one");
    source.drafts.setDraft("active", "Before the click");
    bus.holdReplies = true;
    const moving = source.handoff.openChatWindowInMain("session", "active");
    const rejected = expect(moving).rejects.toThrow("draft changed");
    await vi.waitFor(() => expect(bus.reply).not.toBeNull());
    source.drafts.setDraft("active", "After the click");
    releaseReply();
    await rejected;
    expect(source.drafts.getDraft("active")).toBe("After the click");
    expect(bus.invoke).not.toHaveBeenCalled();
  });

  it("keeps the source on a missing acknowledgment and ignores replies to another transfer", async () => {
    vi.useFakeTimers();
    const source = await windowModules("chat-one");
    source.drafts.setDraft("active", "Still here");
    const moving = source.handoff.openChatWindowInMain("session", "active");
    const rejected = expect(moving).rejects.toThrow("did not accept your drafts");
    await vi.advanceTimersByTimeAsync(0);
    bus.listeners.get("chat-one:chat-window-drafts-result")?.({ payload: { id: "someone-else" } });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(source.drafts.getDraft("active")).toBe("Still here");
    expect(bus.invoke).not.toHaveBeenCalled();
    expect(bus.listeners.has("chat-one:chat-window-drafts-result")).toBe(false);
  });

  it("keeps the source if sending the transfer fails", async () => {
    const source = await windowModules("chat-one");
    source.drafts.setDraft("active", "Still here");
    bus.emitTo.mockRejectedValueOnce(new Error("Destination unavailable"));
    await expect(source.handoff.openChatWindowInMain("session", "active")).rejects.toThrow("Destination unavailable");
    expect(source.drafts.getDraft("active")).toBe("Still here");
    expect(bus.invoke).not.toHaveBeenCalled();
    expect(bus.listeners.has("chat-one:chat-window-drafts-result")).toBe(false);
  });
});
