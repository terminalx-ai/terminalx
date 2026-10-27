import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/events";

const mocks = vi.hoisted(() => ({
  loadEvents: vi.fn(), listSessions: vi.fn(), patchTab: vi.fn(),
  sessions: [{ id: "synthetic", tabs: [{ id: "tab", status: "in_progress" }] }],
}));
vi.mock("@/lib/api", () => ({ agent: { loadEvents: mocks.loadEvents }, api: { listSessions: mocks.listSessions } }));
vi.mock("@/lib/sessions", () => ({ getSessions: () => ({ sessions: mocks.sessions }), patchTab: mocks.patchTab }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const event = (id: string, seq: number): AgentEvent => ({
  id, seq, sessionId: "synthetic", tabId: "tab", harness: "synthetic", ts: "", subagent: undefined,
  payload: { type: "status", text: id },
});

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

it("merges missed chat history with concurrent events and verified status without replacing the view", async () => {
  const store = await import("./agentEvents");
  mocks.loadEvents.mockResolvedValueOnce([event("before", 1)]);
  await store.loadTab("synthetic", "tab");
  const hook = renderHook(() => store.useTabLog("synthetic", "tab"));
  let finish!: (events: AgentEvent[]) => void;
  mocks.loadEvents.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mocks.listSessions.mockResolvedValue([{ id: "synthetic", tabs: [{ id: "tab", status: "waiting" }] }]);
  await act(async () => {
    const recovery = store.reconcileAgentEvents();
    await Promise.resolve();
    await store.reconcileAgentEvents(); // overlapping focus/visibility signal
    store.applyEvent(event("live", 3));
    const beforeFlush = store.getTabLog("synthetic", "tab");
    store.mergeTabEvents("synthetic", "tab", []); // ordinary flush must not retire this read's token
    expect(store.getTabLog("synthetic", "tab")).not.toBe(beforeFlush);
    finish([event("before", 1), event("missed", 2)]);
    await recovery;
  });
  expect(hook.result.current.events.map((e) => e.id)).toEqual(["before", "missed", "live"]);
  expect(hook.result.current.compactionContinuityKnown).toBe(true);
  expect(mocks.loadEvents).toHaveBeenCalledTimes(2);
  expect(mocks.patchTab).toHaveBeenCalledWith("synthetic", "tab", { status: "waiting" });
  hook.unmount();
});

it("retains history on failed recovery and retries on the next resume", async () => {
  const store = await import("./agentEvents");
  mocks.loadEvents.mockResolvedValueOnce([event("before", 1)]);
  await store.loadTab("synthetic", "tab");
  const hook = renderHook(() => store.useTabLog("synthetic", "tab"));
  mocks.listSessions.mockRejectedValue(new Error("unavailable"));
  mocks.loadEvents.mockRejectedValueOnce(new Error("unavailable"));
  await act(() => store.reconcileAgentEvents());
  expect(hook.result.current.events.map((e) => e.id)).toEqual(["before"]);
  expect(hook.result.current.compactionContinuityKnown).toBe(false);
  expect(mocks.patchTab).not.toHaveBeenCalled();
  mocks.loadEvents.mockResolvedValueOnce([event("before", 1), event("after", 2)]);
  await act(() => store.reconcileAgentEvents());
  expect(hook.result.current.events.map((e) => e.id)).toEqual(["before", "after"]);
  expect(hook.result.current.compactionContinuityKnown).toBe(true);
  hook.unmount();
});

it("does not overwrite a live status update with an older resume snapshot", async () => {
  const store = await import("./agentEvents");
  let finish!: (sessions: unknown[]) => void;
  mocks.listSessions.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const recovery = store.reconcileAgentEvents();
  mocks.sessions = [{ id: "synthetic", tabs: [{ id: "tab", status: "completed" }] }];
  finish([{ id: "synthetic", tabs: [{ id: "tab", status: "waiting" }] }]);
  await recovery;
  expect(mocks.patchTab).not.toHaveBeenCalled();
});

it("keeps compaction unknown during a pending reconnect read, then restores only reconciled history", async () => {
  const store = await import("./agentEvents");
  const { buildTranscript } = await import("./transcript");
  mocks.sessions = [{ id: "synthetic", tabs: [{ id: "tab", status: "in_progress" }] }];
  const scope = { sessionId: "synthetic", tabId: "tab", conversationId: null, provider: "synthetic", threadId: "thread", subagentId: null };
  const history: AgentEvent[] = [
    { ...event("open", 1), payload: { type: "context_compaction_lifecycle", persisted: true, evidence: { scope, type: "connection_opened", generation: 1 } } },
    { ...event("start", 2), payload: { type: "context_compaction_lifecycle", persisted: true, confirmedStart: true, evidence: { scope, type: "item_started", generation: 1, turnId: "turn", itemId: "item" } } },
  ];
  mocks.loadEvents.mockResolvedValueOnce(history);
  await store.loadTab("synthetic", "tab");
  const hook = renderHook(() => store.useTabLog("synthetic", "tab"));
  const projection = () => {
    const log = store.getTabLog("synthetic", "tab");
    return buildTranscript(log.events, false, { compactionContinuityKnown: log.compactionContinuityKnown });
  };
  expect(projection().compacting).toBe(true);
  let finish!: (events: AgentEvent[]) => void;
  mocks.listSessions.mockResolvedValue(mocks.sessions);
  mocks.loadEvents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => {
    const pending = store.reconcileAgentEvents();
    await Promise.resolve();
    expect(projection().compacting).toBe(false);
    finish([...history, { ...event("lost", 3), payload: { type: "context_compaction_lifecycle", persisted: true, evidence: { scope, type: "continuity_lost", generation: 1, reason: "restarted" } } }]);
    await pending;
  });
  expect(projection().compacting).toBe(false);
  expect(projection().turns.flatMap(t => t.work)).toContainEqual(expect.objectContaining({ kind: "compaction", lifecycle: expect.objectContaining({ state: "unknown" }) }));
  hook.unmount();
});

// Source-derived races from the #644 independent review. Promise resolution
// supplies the schedule; these do not use provider events or timer deadlines.
function compactionHistory(): AgentEvent[] {
  const scope = { sessionId: "synthetic", tabId: "tab", conversationId: null, provider: "synthetic", threadId: "thread", subagentId: null };
  return [
    { ...event("open", 1), payload: { type: "context_compaction_lifecycle", persisted: true, evidence: { scope, type: "connection_opened", generation: 1 } } },
    { ...event("start", 2), payload: { type: "context_compaction_lifecycle", persisted: true, confirmedStart: true, evidence: { scope, type: "item_started", generation: 1, turnId: "turn", itemId: "item" } } },
  ];
}

it("rejects an initial pre-invalidation response but admits a current read across ordinary flushes", async () => {
  const store = await import("./agentEvents");
  const { buildTranscript } = await import("./transcript");
  mocks.sessions = [{ id: "synthetic", tabs: [{ id: "tab", status: "in_progress" }] }];
  mocks.listSessions.mockResolvedValue(mocks.sessions);
  let finishOld!: (events: AgentEvent[]) => void;
  mocks.loadEvents.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const initial = store.loadTab("synthetic", "tab");
  await store.reconcileAgentEvents(); // unloaded log is invalidated, not read
  expect(mocks.loadEvents).toHaveBeenCalledTimes(1);
  finishOld(compactionHistory());
  await initial;
  const stale = store.getTabLog("synthetic", "tab");
  expect(stale.compactionContinuityKnown).toBe(false);
  expect(stale.loaded).toBe(false);
  expect(buildTranscript(stale.events, false, { compactionContinuityKnown: stale.compactionContinuityKnown }).compacting).toBe(false);

  let finishCurrent!: (events: AgentEvent[]) => void;
  mocks.loadEvents.mockImplementationOnce(() => new Promise(resolve => { finishCurrent = resolve; }));
  const current = store.loadTab("synthetic", "tab");
  const beforeFlush = store.getTabLog("synthetic", "tab");
  store.mergeTabEvents("synthetic", "tab", [event("concurrent", 3)]); // immediate flush replaces TabLog
  expect(store.getTabLog("synthetic", "tab")).not.toBe(beforeFlush);
  finishCurrent(compactionHistory());
  await current;
  const admitted = store.getTabLog("synthetic", "tab");
  expect(admitted.compactionContinuityKnown).toBe(true);
  expect(admitted.events.map(e => e.id)).toEqual(["open", "start", "concurrent"]);
  expect(buildTranscript(admitted.events, false, { compactionContinuityKnown: admitted.compactionContinuityKnown }).compacting).toBe(true);
});

it("rejects an initial-load response for a dropped and recreated log at the same key", async () => {
  const store = await import("./agentEvents");
  let finish!: (events: AgentEvent[]) => void;
  mocks.loadEvents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.loadTab("synthetic", "tab");
  store.dropTabLog("synthetic", "tab");
  store.mergeTabEvents("synthetic", "tab", [event("replacement", 7)]);
  finish(compactionHistory());
  await pending;
  const recreated = store.getTabLog("synthetic", "tab");
  expect(recreated.compactionContinuityKnown).not.toBe(true);
  expect(recreated.events.map(e => e.id)).toEqual(["replacement"]);
});

it("rejects a reconciliation response for a dropped and recreated log at the same key", async () => {
  const store = await import("./agentEvents");
  mocks.sessions = [{ id: "synthetic", tabs: [{ id: "tab", status: "in_progress" }] }];
  mocks.loadEvents.mockResolvedValueOnce(compactionHistory());
  await store.loadTab("synthetic", "tab");
  const hook = renderHook(() => store.useTabLog("synthetic", "tab"));
  mocks.listSessions.mockResolvedValue(mocks.sessions);
  let finish!: (events: AgentEvent[]) => void;
  mocks.loadEvents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => {
    const pending = store.reconcileAgentEvents();
    await Promise.resolve(); // history read has captured its token
    store.dropTabLog("synthetic", "tab");
    store.mergeTabEvents("synthetic", "tab", [event("replacement", 7)]);
    finish(compactionHistory());
    await pending;
  });
  expect(hook.result.current.compactionContinuityKnown).not.toBe(true);
  expect(hook.result.current.events.map(e => e.id)).toEqual(["replacement"]);
  hook.unmount();
});
