import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceSetup } from "./workspaceSetup";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => { mocks.listeners.set(event, handler); return () => {}; }) }));
const run: WorkspaceSetup = { sessionId: "s1", paneId: "s1:workspace-setup-1", command: "install", status: "running", exitCode: null, error: null, hasPane: true };

beforeEach(() => { vi.resetModules(); mocks.listeners.clear(); mocks.invoke.mockReset(); });
afterEach(cleanup);

it("contacts the local runtime only when a local session is selected", async () => {
  mocks.invoke.mockResolvedValue([run]);
  const store = await import("./workspaceSetup");
  const { result, rerender } = renderHook(({ sessionId }) => store.useWorkspaceSetup(sessionId), {
    initialProps: { sessionId: null as string | null },
  });
  expect(result.current).toBeUndefined();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.listeners.size).toBe(0);

  rerender({ sessionId: "s1" });
  await waitFor(() => expect(result.current).toEqual(run));
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("workspace_setup", { operation: "list" });

  rerender({ sessionId: null });
  expect(result.current).toBeUndefined();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("keeps an exit received while the initial listing is in flight", async () => {
  let reply!: (runs: WorkspaceSetup[]) => void;
  mocks.invoke.mockImplementation(() => new Promise<WorkspaceSetup[]>((resolve) => { reply = resolve; }));
  const store = await import("./workspaceSetup");
  const ready = store.bootWorkspaceSetup();
  const { result } = renderHook(store.useWorkspaceSetups);
  await act(async () => { await vi.waitFor(() => expect(reply).toBeTypeOf("function")); });
  act(() => mocks.listeners.get("workspace_setup_changed")!({ payload: { ...run, status: "failed", exitCode: 7 } }));
  await act(async () => { reply([run]); await ready; });
  expect(result.current.runs[0].status).toBe("failed");
});

it("does not resurrect a deleted session from an old refresh response", async () => {
  mocks.invoke.mockResolvedValue([run]);
  const store = await import("./workspaceSetup");
  await store.bootWorkspaceSetup();
  const { result } = renderHook(store.useWorkspaceSetups);
  let reply!: (runs: WorkspaceSetup[]) => void;
  mocks.invoke.mockImplementation(() => new Promise<WorkspaceSetup[]>((resolve) => { reply = resolve; }));
  const refreshing = store.refreshWorkspaceSetup();
  act(() => mocks.listeners.get("session_deleted")!({ payload: "s1" }));
  await act(async () => { reply([run]); await refreshing; });
  expect(result.current.runs).toEqual([]);
});
