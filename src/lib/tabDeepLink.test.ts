import { beforeEach, describe, expect, it, vi } from "vitest";

// The native side builds a tab's link in this build's scheme; links reach `followTabDeepLink` through the router.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "tab_link_for") return `terminalx://tab/${args?.sessionId}/${args?.tabId}`;
    throw new Error(`unexpected command ${command}`);
  }),
}));
const sessions = vi.hoisted(() => ({ state: { loaded: true, selectedSessionId: "x" as string | null, sessions: [{ id: "s1", tabs: [{ id: "t1" }] }] }, select: vi.fn(), activate: vi.fn() }));
vi.mock("@/lib/sessions", () => ({
  getSessionStore: () => sessions.state,
  selectSession: sessions.select,
  subscribeSessionStore: () => () => undefined,
}));
vi.mock("@/lib/sessionTabs", () => ({ activatePeer: sessions.activate }));

const { followTabDeepLink, tabLinkFor } = await import("./tabDeepLink");
const { getErrorToasts, dismissErrorKey } = await import("@/lib/errorToasts");

beforeEach(() => {
  sessions.select.mockClear();
  sessions.activate.mockClear();
  dismissErrorKey("tab-link");
});

describe("tab links (PRO-381)", () => {
  it("are built by the native side, in this build's scheme", async () => {
    expect(await tabLinkFor("s1", "t1")).toBe("terminalx://tab/s1/t1");
  });

  it("open the tab a link names, and say so when it is gone", async () => {
    expect(await followTabDeepLink({ sessionId: "s1", tabId: "t1" })).toBe(true);
    expect(sessions.select).toHaveBeenCalledWith("s1");
    expect(sessions.activate).toHaveBeenCalledWith("s1", { kind: "agent", id: "t1" });
    // A link to a tab that is gone opens nothing and says so.
    expect(await followTabDeepLink({ sessionId: "s1", tabId: "gone" })).toBe(false);
    expect(sessions.activate).toHaveBeenCalledTimes(1);
    expect(getErrorToasts().find((toast) => toast.key === "tab-link")?.title).toBe("No open chat matches that link");
  });
});
