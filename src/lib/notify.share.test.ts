import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import type { ShareState } from "./localSharing";

/**
 * Every new share link approves each person (PRO-162), so a guest who asks to
 * join waits for the host, who may have closed Share long ago. The request is
 * raised like an agent's: a banner when nobody is looking, else a notice that
 * opens Share on the session.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sendNotification: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: vi.fn(async () => undefined) }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: mocks.sendNotification,
}));

const shared = {
  id: "shared-1",
  kind: "quick",
  projectPath: "/home/.raccoon/quick/shared-1",
  cwd: "/home/.raccoon/quick/shared-1",
  worktreeRemoved: false,
  title: "Pair on the login page",
  created: "x",
  modified: "x",
  archived: false,
  pinned: false,
  tabs: [],
  activeTab: null,
} as unknown as SessionEntry;

const kim = (admitted: boolean, pendingLinkIds?: string[]): ShareState["people"][number] => ({
  person: { userId: "kim", displayName: "Kim", email: "kim@example.com", emailVerified: true },
  role: "viewer",
  canApprove: false,
  admitted,
  connections: 1,
  viewing: [],
  typing: false,
  linkIds: ["link-1"],
  ...(pendingLinkIds ? { pendingLinkIds } : {}),
});
const shareWith = (people: ShareState["people"]): ShareState => ({ active: true, links: [], people, leases: [], notes: [], activity: [], queue: [] });
/** What the runtime pushes after each guest request. */
const pushed = (state: ShareState) => mocks.listeners.get("session_share_changed")!({ payload: { sessionId: shared.id, state } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The notices the toasts would show now. */
const noticesOf = (notify: typeof import("./notify")) => renderHook(() => notify.useNotices()).result.current;

async function openWindow(label: "main" | "floating", focused: boolean) {
  vi.resetModules();
  mocks.listeners.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  (await import("./appWindow")).setAppWindowForTest(label);
  const sessions = await import("./sessions");
  sessions.upsertSession(shared);
  const sharing = await import("./localSharing");
  const notify = await import("./notify");
  notify.startNotifications();
  await settle();
  return { sessions, sharing, notify };
}

beforeEach(() => {
  localStorage.clear();
  mocks.sendNotification.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_workspaces") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("someone asking to join a shared session (PRO-162)", () => {
  it("raises one notice per wait, which opens Share on the session", async () => {
    const { notify, sharing, sessions } = await openWindow("main", true);
    pushed(shareWith([kim(false)]));
    expect(noticesOf(notify)).toEqual([
      expect.objectContaining({ sessionId: shared.id, kind: "waiting", opens: "share", title: "Kim asked to join", body: "Pair on the login page. Open Share to admit or decline them." }),
    ]);

    // Still waiting: the same request, not another one.
    pushed(shareWith([kim(false)]));
    expect(noticesOf(notify)).toHaveLength(1);

    notify.openNotice(noticesOf(notify)[0]);
    expect(sessions.getSessions().selectedSessionId).toBe(shared.id);
    expect(sharing.shownShareDialog()).toBe(shared.id);
    expect(noticesOf(notify)).toHaveLength(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("asks again when an admitted person waits on one more link, and stays quiet while Share lists them", async () => {
    const { notify, sharing } = await openWindow("main", true);
    pushed(shareWith([kim(true)]));
    expect(noticesOf(notify)).toHaveLength(0);
    pushed(shareWith([kim(true, ["link-2"])]));
    expect(noticesOf(notify)).toEqual([expect.objectContaining({ opens: "share", title: "Kim asked to join" })]);

    notify.dismissNotice(noticesOf(notify)[0].id);
    sharing.openSessionShare(shared.id);
    pushed(shareWith([kim(true)]));
    pushed(shareWith([kim(false)]));
    expect(noticesOf(notify)).toHaveLength(0);
  });

  it("sends one desktop banner, from the main window, when nobody is looking", async () => {
    const main = await openWindow("main", false);
    pushed(shareWith([kim(false)]));
    await settle();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification.mock.calls[0][0]).toEqual({ title: "Kim asked to join", body: "Pair on the login page. Open Share to admit or decline them." });
    expect(noticesOf(main.notify)).toHaveLength(0);

    // The floating window does not listen, so it never speaks for the same request.
    await openWindow("floating", false);
    expect(mocks.listeners.has("session_share_changed")).toBe(false);
  });
});
