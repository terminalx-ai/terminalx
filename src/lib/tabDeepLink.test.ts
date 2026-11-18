import { beforeEach, describe, expect, it, vi } from "vitest";

// The native side: what `tab_link_take` hands out (once), and who listens for its ping.
const native = vi.hoisted(() => ({ pending: [] as unknown[], listeners: new Set<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "tab_link_take") return native.pending.shift() ?? null;
    if (command === "tab_link_for") return `terminalx://tab/${args?.sessionId}/${args?.tabId}`;
    throw new Error(`unexpected command ${command}`);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: () => void) => {
    native.listeners.add(handler);
    return () => native.listeners.delete(handler);
  }),
}));
const sessions = vi.hoisted(() => ({ state: { loaded: true, selectedSessionId: "x" as string | null, sessions: [{ id: "s1", tabs: [{ id: "t1" }] }] }, select: vi.fn(), activate: vi.fn() }));
vi.mock("@/lib/sessions", () => ({
  getSessionStore: () => sessions.state,
  selectSession: sessions.select,
  subscribeSessionStore: () => () => undefined,
}));
vi.mock("@/lib/sessionTabs", () => ({ activatePeer: sessions.activate }));

const { asTabDeepLink, bootTabDeepLinks, tabLinkFor } = await import("./tabDeepLink");
const { getErrorToasts, dismissErrorKey } = await import("@/lib/errorToasts");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  native.pending = [];
  native.listeners.clear();
  sessions.select.mockClear();
  sessions.activate.mockClear();
  dismissErrorKey("tab-link");
});

describe("tab links (PRO-381)", () => {
  it("are built by the native side, in this build's scheme", async () => {
    expect(await tabLinkFor("s1", "t1")).toBe("terminalx://tab/s1/t1");
  });

  it("take only { sessionId, tabId } from the native side", () => {
    expect(asTabDeepLink({ sessionId: "s1", tabId: "t1" })).toEqual({ sessionId: "s1", tabId: "t1" });
    for (const value of [null, [], { sessionId: "s1" }, { sessionId: "s1", tabId: 2 }, { sessionId: "s1", tabId: "t1", url: "x" }]) expect(asTabDeepLink(value)).toBeNull();
  });

  it("open the tab a link names, the one that launched the app and each one after", async () => {
    native.pending.push({ sessionId: "s1", tabId: "t1" });
    const stop = bootTabDeepLinks();
    await flush();
    await flush();
    expect(sessions.select).toHaveBeenCalledWith("s1");
    expect(sessions.activate).toHaveBeenCalledWith("s1", { kind: "agent", id: "t1" });
    // A link to a tab that is gone opens nothing and says so.
    native.pending.push({ sessionId: "s1", tabId: "gone" });
    for (const ping of native.listeners) ping();
    await flush();
    await flush();
    expect(sessions.activate).toHaveBeenCalledTimes(1);
    expect(getErrorToasts().find((toast) => toast.key === "tab-link")?.title).toBe("No open chat matches that link");
    stop();
  });
});
