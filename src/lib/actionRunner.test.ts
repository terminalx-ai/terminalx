import { beforeEach, expect, it, vi } from "vitest";
import type { ActionRun } from "./actionRunner";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return mocks.unlisten;
  }),
}));

const run = (patch: Partial<ActionRun> = {}): ActionRun => ({
  sessionId: "s1", actionId: "dev", name: "Dev", paneId: "s1:action-1-6465", state: "running",
  exitCode: null, started: "2026-11-13T00:00:00Z", ended: null, ...patch,
});
const emit = (event: string, payload: unknown) => mocks.listeners.get(event)!({ payload });

beforeEach(() => {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.listeners.clear();
  mocks.unlisten.mockReset();
});

it("runs an action through the native command, restart off unless asked", async () => {
  const { runAction } = await import("./actionRunner");
  mocks.invoke.mockResolvedValue({ run: run(), started: true });
  await expect(runAction("s1", "dev")).resolves.toEqual({ run: run(), started: true });
  expect(mocks.invoke).toHaveBeenLastCalledWith("action_run", { sessionId: "s1", actionId: "dev", restart: false });

  // A second run of a running single-run action: the running tab comes back.
  mocks.invoke.mockResolvedValue({ run: run(), started: false });
  const again = await runAction("s1", "dev");
  expect(again.started).toBe(false);
  expect(again.run.paneId).toBe("s1:action-1-6465");

  mocks.invoke.mockResolvedValue({ run: run({ paneId: "s1:action-2-6465" }), started: true });
  await runAction("s1", "dev", { restart: true });
  expect(mocks.invoke).toHaveBeenLastCalledWith("action_run", { sessionId: "s1", actionId: "dev", restart: true });
});

it("lists a session's action states", async () => {
  const { actionStates } = await import("./actionRunner");
  mocks.invoke.mockResolvedValue([run({ state: "exited", exitCode: 7 })]);
  await expect(actionStates("s1")).resolves.toEqual([run({ state: "exited", exitCode: 7 })]);
  expect(mocks.invoke).toHaveBeenCalledWith("action_states", { sessionId: "s1" });
});

it("tells action tabs of a session from other tabs", async () => {
  const { isActionPane } = await import("./actionRunner");
  expect(isActionPane("s1", "s1:action-1-6465")).toBe(true);
  expect(isActionPane("s1", "s1:0190abcd")).toBe(false);
  expect(isActionPane("s1", "s10:action-1-6465")).toBe(false);
  expect(isActionPane("s1", "tab:action-1")).toBe(false);
});

it("re-reads one session's runs when one of its action tabs opens, exits or closes", async () => {
  const { watchActionStates } = await import("./actionRunner");
  let lists: ActionRun[][] = [[run()]];
  mocks.invoke.mockImplementation(async () => lists.shift() ?? []);
  const seen: ActionRun[][] = [];
  const stop = await watchActionStates("s1", (runs) => seen.push(runs));
  expect(seen).toEqual([[run()]]);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);

  // Other sessions' tabs and plain terminals are not this session's runs.
  emit("pty_exit", { id: "s2:action-1-6465", code: 0 });
  emit("pty_opened", { id: "s1:0190abcd" });
  await Promise.resolve();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);

  // The exit code arrives with the action change event.
  lists = [[run({ state: "exited", exitCode: 3, ended: "later" })]];
  emit("action_state_changed", { sessionId: "s1", paneId: "s1:action-1-6465" });
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen[1]).toEqual([run({ state: "exited", exitCode: 3, ended: "later" })]);

  lists = [[]];
  emit("pty_closed", "s1:action-1-6465");
  await vi.waitFor(() => expect(seen).toHaveLength(3));
  expect(seen[2]).toEqual([]);

  stop();
  expect(mocks.unlisten).toHaveBeenCalledTimes(5);
  emit("pty_opened", { id: "s1:action-3-6465" });
  await Promise.resolve();
  expect(seen).toHaveLength(3);
});

it("reads again after a change heard during a read, handing on only the newer list", async () => {
  const { watchActionStates } = await import("./actionRunner");
  const replies: ((runs: ActionRun[]) => void)[] = [];
  mocks.invoke.mockImplementation(() => new Promise<ActionRun[]>((resolve) => { replies.push(resolve); }));
  const seen: ActionRun[][] = [];
  const watching = watchActionStates("s1", (runs) => seen.push(runs));
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  // The tab opens while the first read is still out: that read's answer may predate it.
  emit("pty_opened", { id: "s1:action-2-6465" });
  replies[0]([]);
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  replies[1]([run({ paneId: "s1:action-2-6465" })]);
  const stop = await watching;
  expect(seen).toEqual([[run({ paneId: "s1:action-2-6465" })]]);
  stop();
});

it("picks the running run of an action over an exited one", async () => {
  const { latestByAction } = await import("./actionRunner");
  const exited = run({ paneId: "s1:action-1-6465", state: "exited", exitCode: 1 });
  const running = run({ paneId: "s1:action-2-6465" });
  const later = run({ paneId: "s1:action-3-6465", state: "exited", exitCode: 0 });
  expect(latestByAction([exited, running, later]).get("dev")).toBe(running);
  expect(latestByAction([exited]).get("dev")).toBe(exited);
});
