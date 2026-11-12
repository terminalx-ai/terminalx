import type { AppWindow } from "./appWindow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * Notifications off in macOS (PRO-327). A session that needs the reader while
 * macOS blocks the app's banners raises the card naming it; allowing them in
 * System Settings is noticed when the app has the focus again, and "Not now"
 * holds for the rest of the run.
 */
const mocks = vi.hoisted(() => ({ permission: "denied" as string, invoke: vi.fn(), sendNotification: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: vi.fn(async () => undefined) }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  // What the plugin says on desktop whatever macOS has: always granted.
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: mocks.sendNotification,
}));

const tab: TabEntry = { id: "t1", harness: "claude", model: "", permissionMode: "default", status: "in_progress", created: "x", modified: "x" };
const session: SessionEntry = {
  id: "s1",
  kind: "quick",
  projectPath: "/home/.raccoon/quick/s1",
  cwd: "/home/.raccoon/quick/s1",
  worktreeRemoved: false,
  title: "Show the diff inside edit approvals",
  created: "x",
  modified: "x",
  archived: false,
  pinned: false,
  tabs: [tab],
  activeTab: "t1",
};

async function boot({ label = "main", mac = true, focused = false }: { label?: AppWindow; mac?: boolean; focused?: boolean } = {}) {
  vi.resetModules();
  vi.spyOn(navigator, "platform", "get").mockReturnValue(mac ? "MacIntel" : "Win32");
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  (await import("./appWindow")).setAppWindowForTest(label);
  const sessions = await import("./sessions");
  sessions.upsertSession(session);
  const notify = await import("./notify");
  const card = await import("@/components/ui/NotificationsOffCard");
  notify.startNotifications();
  return { notify, card };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const added: [string, EventListenerOrEventListenerObject][] = [];
const realAdd = window.addEventListener.bind(window);
beforeEach(() => {
  localStorage.clear();
  mocks.permission = "denied";
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "notification_permission") return mocks.permission;
    if (command === "list_workspaces") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
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

const permissionChecks = () => mocks.invoke.mock.calls.filter(([command]) => command === "notification_permission").length;

describe("notifications off in macOS", () => {
  it("raises the card naming the session that needs the reader", async () => {
    const { notify, card } = await boot();
    notify.noteStatusChange(session, tab, "in_progress", "waiting");
    await settle();
    const { renderHook } = await import("@testing-library/react");
    const { result } = renderHook(() => card.useNotificationsOff());
    expect(result.current).toEqual({ sessionId: "s1", sessionTitle: "Show the diff inside edit approvals" });
  });

  it("says nothing while macOS allows notifications, or when the app cannot tell", async () => {
    mocks.permission = "granted";
    const allowed = await boot();
    allowed.notify.noteStatusChange(session, tab, "in_progress", "waiting");
    await settle();
    expect(permissionChecks()).toBe(1);
    expect(allowed.card.notificationsOffHidden()).toBe(false);
    const { renderHook } = await import("@testing-library/react");
    expect(renderHook(() => allowed.card.useNotificationsOff()).result.current).toBeNull();

    mocks.invoke.mockImplementation(async () => { throw new Error("Command notification_permission not found"); });
    const unknown = await boot();
    unknown.notify.noteStatusChange(session, tab, "in_progress", "waiting");
    await settle();
    expect(renderHook(() => unknown.card.useNotificationsOff()).result.current).toBeNull();
  });

  it("only asks for a session that needs the reader, not one that finished", async () => {
    const { notify } = await boot();
    notify.noteStatusChange(session, tab, "in_progress", "completed");
    await settle();
    expect(permissionChecks()).toBe(0);
  });

  it("is the main window's on macOS only", async () => {
    const floating = await boot({ label: "floating" });
    floating.notify.noteStatusChange(session, tab, "in_progress", "waiting");
    await settle();
    const windows = await boot({ mac: false });
    windows.notify.noteStatusChange(session, tab, "in_progress", "waiting");
    await settle();
    expect(permissionChecks()).toBe(0);
  });

  it("goes once notifications are allowed, re-checked when the app has the focus again", async () => {
    const { notify, card } = await boot();
    notify.noteStatusChange(session, tab, "in_progress", "waiting");
    await settle();
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => card.useNotificationsOff());
    expect(result.current?.sessionId).toBe("s1");

    // Still off: the card stays.
    await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); });
    expect(result.current?.sessionId).toBe("s1");

    // Allowed in System Settings, then back to the app.
    window.dispatchEvent(new Event("blur"));
    mocks.permission = "granted";
    await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); });
    expect(result.current).toBeNull();

    // Allowed, nothing more is checked on focus.
    const checks = permissionChecks();
    window.dispatchEvent(new Event("blur"));
    await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); });
    expect(permissionChecks()).toBe(checks);
  });

  it("\"Not now\" holds for the rest of the run, and a new run asks again", async () => {
    const first = await boot();
    first.notify.noteStatusChange(session, tab, "in_progress", "waiting");
    await settle();
    first.card.hideNotificationsOffForRun();
    const { renderHook } = await import("@testing-library/react");
    const { result } = renderHook(() => first.card.useNotificationsOff());
    expect(result.current).toBeNull();
    first.notify.noteStatusChange(session, { ...tab, id: "t2" }, "in_progress", "waiting");
    await settle();
    expect(result.current).toBeNull();

    // Started again: nothing was kept.
    const next = await boot();
    next.notify.noteStatusChange(session, tab, "in_progress", "waiting");
    await settle();
    expect(renderHook(() => next.card.useNotificationsOff()).result.current?.sessionId).toBe("s1");
  });

  it("names a cloud session that needs the reader", async () => {
    const { notify, card } = await boot();
    notify.raiseCloudAttention({
      kind: "waiting",
      session: { key: "cloud:org:ws:s9", title: "Seat-based Teams billing", orgName: "Procyon" },
      tab: { tabId: "c1", harness: "codex" },
    } as unknown as Parameters<typeof notify.raiseCloudAttention>[0]);
    await settle();
    const { renderHook } = await import("@testing-library/react");
    expect(renderHook(() => card.useNotificationsOff()).result.current).toEqual({ sessionId: "cloud:org:ws:s9", sessionTitle: "Seat-based Teams billing" });
  });
});
