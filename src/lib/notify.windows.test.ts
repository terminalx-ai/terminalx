import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * One reader, two windows. Every window hears a tab finish; exactly one of
 * them says so, and a banner about the floating window's session brings that
 * window back.
 */
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), sendNotification: vi.fn(), setBadgeCount: vi.fn(async () => undefined) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: mocks.setBadgeCount }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: mocks.sendNotification,
}));

const tab: TabEntry = { id: "t1", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "completed", created: "x", modified: "x" };
const chat: SessionEntry = {
  id: "chat-1",
  kind: "quick",
  projectPath: "/home/.raccoon/quick/chat-1",
  cwd: "/home/.raccoon/quick/chat-1",
  worktreeRemoved: false,
  title: "What is a monad?",
  created: "x",
  modified: "x",
  archived: false,
  pinned: false,
  tabs: [tab],
  activeTab: "t1",
};

async function openWindow(label: "main" | "floating", focused: boolean) {
  vi.resetModules();
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  (await import("./appWindow")).setAppWindowForTest(label);
  const sessions = await import("./sessions");
  sessions.upsertSession(chat);
  const notify = await import("./notify");
  const floating = await import("./floating");
  notify.startNotifications();
  return { sessions, notify, floating };
}

/** What the other window last wrote about itself. */
function elsewhere(label: "main" | "floating", presence: { focused: boolean; sessionId: string | null }) {
  localStorage.setItem(`raccoon.presence.${label}`, JSON.stringify(presence));
  window.dispatchEvent(new StorageEvent("storage", { key: `raccoon.presence.${label}`, newValue: JSON.stringify(presence), storageArea: localStorage }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  mocks.sendNotification.mockReset();
  mocks.setBadgeCount.mockClear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_workspaces") return [];
    if (command === "floating_show") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
});

/**
 * Each window opened here is a fresh copy of the modules, and each copy
 * listens on the one test `window`. A copy left listening after its test
 * would answer the next test's focus and storage events as a window that
 * does not exist any more, so every listener a test adds is taken off again.
 */
const added: [string, EventListenerOrEventListenerObject][] = [];
const realAdd = window.addEventListener.bind(window);
beforeEach(() => {
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    added.push([type, listener]);
    realAdd(type, listener, options);
  }) as typeof window.addEventListener;
});

afterEach(() => {
  for (const [type, listener] of added.splice(0)) window.removeEventListener(type, listener);
  window.addEventListener = realAdd;
  vi.restoreAllMocks();
});

describe("attention across two windows", () => {
  it("sends one desktop banner, from the main window, when nobody is looking", async () => {
    const main = await openWindow("main", false);
    main.notify.noteStatusChange(chat, tab, "in_progress", "completed");
    await settle();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification.mock.calls[0][0].title).toContain("finished");

    // The floating window heard the same change. It never sends one of its own.
    mocks.sendNotification.mockClear();
    const floating = await openWindow("floating", false);
    floating.notify.noteStatusChange(chat, tab, "in_progress", "completed");
    await settle();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(floating.notify.useNotices).toBeDefined();
  });

  it("stays quiet in the main window while the reader is in the floating one", async () => {
    const main = await openWindow("main", false);
    elsewhere("floating", { focused: true, sessionId: "chat-1" });
    main.notify.noteStatusChange(chat, tab, "in_progress", "completed");
    await settle();
    // No banner over a window the reader is typing in.
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("ignores what an earlier run of the app left written for the floating window", async () => {
    // The app quit with the floating window focused; this run has not made one.
    localStorage.setItem("raccoon.presence.floating", JSON.stringify({ focused: true, sessionId: "chat-1" }));
    const main = await openWindow("main", false);
    main.notify.noteStatusChange(chat, tab, "in_progress", "completed");
    await settle();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("says where the reader is: the session on screen, and nothing while a floating window is hidden", async () => {
    const floating = await openWindow("floating", true);
    floating.sessions.selectSession("chat-1");
    expect(JSON.parse(localStorage.getItem("raccoon.presence.floating")!)).toEqual({ focused: true, sessionId: "chat-1" });
    // Hidden by the shortcut: its page still runs, but nobody sees it.
    floating.floating.resetFloating({ visible: false, sessionId: "chat-1" });
    expect(JSON.parse(localStorage.getItem("raccoon.presence.floating")!).focused).toBe(false);
  });

  it("brings the floating window back on the session a banner was about", async () => {
    const main = await openWindow("main", false);
    // The floating window shows this chat, and is hidden.
    elsewhere("floating", { focused: false, sessionId: "chat-1" });
    main.notify.noteStatusChange(chat, { ...tab, status: "waiting" }, "in_progress", "waiting");
    await settle();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);

    // The reader clicks the banner: the app comes forward.
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith("floating_show", { sessionId: "chat-1", tabId: "t1" });

    // Once, not on every later return.
    mocks.invoke.mockClear();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(mocks.invoke).not.toHaveBeenCalledWith("floating_show", expect.anything());
  });

  it("leaves the main window where it was for a banner about one of its own sessions", async () => {
    const main = await openWindow("main", false);
    main.floating.resetFloating({ visible: true, sessionId: null });
    main.notify.noteStatusChange(chat, tab, "in_progress", "completed");
    await settle();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(mocks.invoke).not.toHaveBeenCalledWith("floating_show", expect.anything());
    expect(main.sessions.getSessionStore().selectedSessionId).toBeNull();
  });

  it("does not raise the floating window again when the reader already came back through it", async () => {
    const main = await openWindow("main", false);
    elsewhere("floating", { focused: false, sessionId: "chat-1" });
    main.notify.noteStatusChange(chat, tab, "in_progress", "completed");
    await settle();
    // They press the shortcut: the floating window takes the focus and shows the chat.
    elsewhere("floating", { focused: true, sessionId: "chat-1" });
    // Later they click the main window.
    elsewhere("floating", { focused: false, sessionId: "chat-1" });
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(mocks.invoke).not.toHaveBeenCalledWith("floating_show", expect.anything());
  });

  it("does not raise the floating window over a main window that already shows the session", async () => {
    const main = await openWindow("main", false);
    // "Open in main window": the floating window still has the chat selected, and is hidden.
    elsewhere("floating", { focused: false, sessionId: "chat-1" });
    main.sessions.selectSession("chat-1");
    main.notify.noteStatusChange(chat, tab, "in_progress", "completed");
    await settle();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(mocks.invoke).not.toHaveBeenCalledWith("floating_show", expect.anything());
  });

  it("does not raise a floating window that only showed the session in an earlier run", async () => {
    // Remembered from last week; no floating window has been opened in this run.
    localStorage.setItem("raccoon.floating.session", "chat-1");
    const main = await openWindow("main", false);
    main.notify.noteStatusChange(chat, tab, "in_progress", "completed");
    await settle();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(mocks.invoke).not.toHaveBeenCalledWith("floating_show", expect.anything());
  });

  it("keeps the dock badge in the main window only", async () => {
    await openWindow("floating", true);
    await settle();
    expect(mocks.setBadgeCount).not.toHaveBeenCalled();
    await openWindow("main", true);
    await settle();
    expect(mocks.setBadgeCount).toHaveBeenCalled();
  });
});
