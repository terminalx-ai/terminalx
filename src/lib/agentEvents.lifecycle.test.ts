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
