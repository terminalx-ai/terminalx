import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";

// A guest's Stop in a shared session (#427). It used to be the host's hard
// stop: it ended the host's agent process and put "Session closed" over the
// host's tab. It is Escape first, as the host's own Stop is, and asks for the
// stop that ends the process only when the interrupt went unanswered.

const mocks = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> }[],
  tabStatus: "in_progress",
  role: "driver",
  events: [] as unknown[],
  listeners: new Set<(method: string, params: unknown) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string) => (command === "session_join_pending" ? "terminalx://join/abc" : undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: { state: "signed-in" } }), signIn: vi.fn() }));
vi.mock("@/components/chat/Chat", () => ({ Chat: () => <div>Chat</div> }));
vi.mock("@/lib/sessionGuest", () => ({
  SessionGuestClient: {
    join: async () => ({
      sessionId: "shared",
      close: () => undefined,
      subscribe: (listener: (method: string, params: unknown) => void) => {
        mocks.listeners.add(listener);
        return () => void mocks.listeners.delete(listener);
      },
      request: async (method: string, params: Record<string, unknown> = {}) => {
        mocks.requests.push({ method, params });
        const me = { userId: "alice", displayName: "Alice", email: "alice@example.com" };
        if (method === "session.status") return { admitted: true, you: { person: me, role: mocks.role, canApprove: false }, state: { active: true, links: null, people: [], leases: [], notes: [], activity: [], queue: [] } };
        if (method === "session.tabs.list") return { title: "Shared", tabs: [{ id: "tab-1", kind: "agent", title: "Agent", harness: "claude", status: mocks.tabStatus }, { id: "tab-2", kind: "agent", title: "Other agent", harness: "codex", status: mocks.tabStatus }] };
        if (method === "session.tail") return { events: mocks.events, hasMore: false };
        return {};
      },
    }),
  },
}));

import { GuestSessionHost } from "./GuestSession";

let seq = 0;
const event = (payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: "shared", tabId: "tab-1", harness: "claude", ts: new Date().toISOString(), payload });
/** The host publishes an event of the shared tab. */
const hostSays = (payload: Payload) => act(() => { const next = { event: event(payload) }; for (const listener of [...mocks.listeners]) listener("session.event", next); });
const stops = () => mocks.requests.filter((request) => request.method === "session.stop").map((request) => request.params);
const open = async () => {
  const firstRequest = mocks.requests.length;
  render(<GuestSessionHost />);
  await screen.findByLabelText("Prompt to agent");
  // A previous mount's tail must not mark this guest ready before its tabs load.
  await waitFor(() => expect(mocks.requests.slice(firstRequest).some((request) => request.method === "session.tail")).toBe(true));
};
const click = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  // The request settles and the button is enabled again.
  await waitFor(() => expect(screen.queryAllByRole("button").some((button) => (button as HTMLButtonElement).disabled && /^Stop/.test(button.textContent ?? ""))).toBe(false));
};

beforeEach(() => {
  seq = 0;
  mocks.requests = [];
  mocks.listeners.clear();
  mocks.tabStatus = "in_progress";
  mocks.role = "driver";
  mocks.events = [event({ type: "user_message", text: "start", images: [], queued: false } as Payload)];
});
afterEach(cleanup);

describe("a guest's Stop in a shared session", () => {
  it("interrupts first, and asks for the stop that ends the host's agent only when that went unanswered", async () => {
    await open();
    await click("Stop");
    expect(stops()).toEqual([{ tabId: "tab-1" }]);

    // The turn it was sent to is still running: the same button now says what it will do.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await click("Stop session");
    expect(stops()).toEqual([{ tabId: "tab-1" }, { tabId: "tab-1", force: true }]);
  });

  it("goes back to an interrupt once the agent has answered and another turn runs", async () => {
    await open();
    await click("Stop");
    hostSays({ type: "turn_completed", status: "aborted" } as Payload);
    hostSays({ type: "user_message", text: "again", images: [], queued: false } as Payload);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop session" })).toBeNull());
    await click("Stop");
    expect(stops()).toEqual([{ tabId: "tab-1" }, { tabId: "tab-1" }]);
  });

  it("starts with an interrupt on another tab, whatever was sent to the first", async () => {
    await open();
    await click("Stop");
    expect(screen.getByRole("button", { name: "Stop session" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Other agent" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop session" })).toBeNull());
    await click("Stop");
    expect(stops()).toEqual([{ tabId: "tab-1" }, { tabId: "tab-2" }]);
  });

  it("offers no Stop while nothing runs, and none that works to a viewer", async () => {
    mocks.tabStatus = "idle";
    await open();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    cleanup();

    mocks.tabStatus = "in_progress";
    mocks.role = "viewer";
    await open();
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    expect(stops()).toEqual([]);
  });
});
