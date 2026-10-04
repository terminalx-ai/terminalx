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
    finish([event("before", 1), event("missed", 2)]);
    await recovery;
  });
  expect(hook.result.current.events.map((e) => e.id)).toEqual(["before", "missed", "live"]);
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
  expect(mocks.patchTab).not.toHaveBeenCalled();
  mocks.loadEvents.mockResolvedValueOnce([event("before", 1), event("after", 2)]);
  await act(() => store.reconcileAgentEvents());
  expect(hook.result.current.events.map((e) => e.id)).toEqual(["before", "after"]);
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
