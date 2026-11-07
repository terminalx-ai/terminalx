import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  sessions: [{ id: "s1", tabs: [{ id: "t1" }, { id: "t2" }] }],
  loadEvents: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ agent: { loadEvents: mocks.loadEvents } }));
vi.mock("@/lib/sessions", () => ({ getSessions: () => ({ sessions: mocks.sessions }), patchTab: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => { mocks.handlers.set(name, handler); return () => {}; }) }));

beforeEach(() => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.sessions = [{ id: "s1", tabs: [{ id: "t1" }, { id: "t2" }] }];
});

it("drops closed local tab and session transcripts, and ignores their late events", async () => {
  const events = await import("./agentEvents");
  await events.subscribeAgentEvents();
  events.setTabStatus("s1", "t1", "idle");
  events.setTabStatus("s1", "t2", "idle");
  mocks.sessions[0].tabs = [{ id: "t2" }];
  mocks.handlers.get("session_updated")!({ payload: mocks.sessions[0] });
  expect(events.getTabLog("s1", "t1").version).toBe(0);
  expect(events.getTabLog("s1", "t2").version).toBeGreaterThan(0);
  mocks.handlers.get("tab_status")!({ payload: { sessionId: "s1", tabId: "t1", status: "completed" } });
  expect(events.getTabLog("s1", "t1").version).toBe(0);
  mocks.sessions = [];
  mocks.handlers.get("session_deleted")!({ payload: "s1" });
  expect(events.getTabLog("s1", "t2").version).toBe(0);
});

it("does not resurrect a transcript whose history finishes loading after it closed", async () => {
  const events = await import("./agentEvents");
  let finish!: (value: unknown[]) => void;
  mocks.loadEvents.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const loading = events.loadTab("s1", "t1");
  events.dropTabLog("s1", "t1");
  finish([]);
  await loading;
  expect(events.getTabLog("s1", "t1").loaded).toBe(false);
});

it("replaces reset history and rejects a read started before the reset", async () => {
  const store = await import("./agentEvents");
  await store.subscribeAgentEvents();
  let finish!: (value: unknown[]) => void;
  mocks.loadEvents.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const loading = store.loadTab("s1", "t1");
  const first = { id: "first", sessionId: "s1", tabId: "t1", harness: "claude", seq: 1, ts: "now", payload: { type: "assistant_text" as const, text: "retained" } };
  const later = { ...first, id: "later", seq: 2, payload: { type: "assistant_text" as const, text: "removed" } };
  store.mergeTabEvents("s1", "t1", [first, later]);
  mocks.loadEvents.mockResolvedValueOnce([first]);
  mocks.handlers.get("tab_history_reset")!({ payload: { sessionId: "s1", tabId: "t1" } });
  await vi.waitFor(() => expect(store.getTabLog("s1", "t1").events).toEqual([first]));
  finish([first, later]);
  await loading;
  expect(store.getTabLog("s1", "t1").events).toEqual([first]);
});
