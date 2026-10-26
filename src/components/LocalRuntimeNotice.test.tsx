import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ status: vi.fn(), reconnect: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock("@/lib/api", () => ({ localRuntime: native, errorMessage: (error: unknown) => String(error) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    native.listeners.set(event, callback);
    return () => native.listeners.delete(event);
  }),
}));

import { LocalRuntimeNotice } from "./LocalRuntimeNotice";

beforeEach(() => {
  vi.useFakeTimers();
  native.status.mockReset().mockResolvedValue({ state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 });
  native.reconnect.mockReset().mockRejectedValue("Owner is unavailable.");
  native.listeners.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mounted(reload = vi.fn()) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<LocalRuntimeNotice reload={reload} />); });
  expect(native.status).toHaveBeenCalledOnce();
  return { ...view, reload };
}

it("leaves a connected session alone and does not take keyboard focus", async () => {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  const { reload } = await mounted();
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.reconnect).not.toHaveBeenCalled();
  await act(async () => native.listeners.get("local_runtime_disconnected")?.());
  expect(screen.queryByRole("status")).toBeNull();
  expect(document.activeElement).toBe(input);
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  input.remove();
});

it("does not let an older successful status read erase a newer disconnect", async () => {
  let resolve!: (state: unknown) => void;
  native.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await mounted();
  await act(async () => native.listeners.get("local_runtime_view_disconnected")?.());
  await act(async () => resolve({ state: "connected", epoch: "old", runningAgents: 1, terminals: 1 }));
  await act(async () => vi.runAllTimersAsync());
  expect(screen.getByRole("status").textContent).toContain("Owner is unavailable");
  expect(native.reconnect).toHaveBeenCalledTimes(5);
});

it("tries five times before showing recovery and waits for a manual retry after exhaustion", async () => {
  native.status.mockResolvedValue({ state: "unavailable", message: "Owner connection closed." });
  native.reconnect.mockRejectedValue("Owner is no longer available. Reopen TerminalX.");
  const { reload } = await mounted();
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status")).toBeNull();
  for (const [index, delay] of [250, 500, 1000, 2000].entries()) {
    await act(async () => vi.advanceTimersByTimeAsync(delay));
    expect(native.reconnect).toHaveBeenCalledTimes(index + 2);
    if (index < 3) expect(screen.queryByRole("status")).toBeNull();
  }
  expect(screen.getByRole("status").textContent).toContain("Owner is no longer available");
  await act(async () => {
    native.listeners.get("local_runtime_disconnected")?.();
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(native.reconnect).toHaveBeenCalledTimes(5);
  expect(reload).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(false);
  native.reconnect.mockResolvedValue({ state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reconnect" })));
  expect(native.reconnect).toHaveBeenCalledTimes(6);
  expect(reload).toHaveBeenCalledOnce();
});

it("coalesces disconnects and reloads once after confirmed reattachment", async () => {
  native.status.mockResolvedValue({ state: "unavailable", message: "Disconnected." });
  let resolve!: (state: unknown) => void;
  native.reconnect.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { reload } = await mounted();
  await act(async () => {
    native.listeners.get("local_runtime_disconnected")?.();
    native.listeners.get("local_runtime_view_disconnected")?.();
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status")).toBeNull();
  act(() => native.listeners.get("local_runtime_reattached")?.());
  await act(async () => resolve({ state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 }));
  expect(reload).toHaveBeenCalledOnce();
  expect(native.reconnect).toHaveBeenCalledOnce();
});

it("reconnects on opening an unavailable runtime without showing recovery on success", async () => {
  native.status.mockResolvedValue({ state: "unavailable", message: "Disconnected." });
  native.reconnect.mockResolvedValue({ state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 });
  const { reload } = await mounted();
  await act(async () => vi.runAllTimersAsync());
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status")).toBeNull();
});

it("counts unavailable replies as failures and also recovers from an initial status error", async () => {
  native.status.mockRejectedValue("Status connection closed.");
  native.reconnect.mockResolvedValue({ state: "unavailable", message: "Still unavailable." });
  const { reload } = await mounted();
  await act(async () => vi.runAllTimersAsync());
  expect(native.reconnect).toHaveBeenCalledTimes(5);
  expect(screen.getByRole("status").textContent).toContain("Still unavailable");
  expect(reload).not.toHaveBeenCalled();
});

it("cancels scheduled retries when the window unmounts", async () => {
  native.status.mockResolvedValue({ state: "unavailable", message: "Disconnected." });
  const { unmount, reload } = await mounted();
  expect(native.reconnect).toHaveBeenCalledOnce();
  unmount();
  await act(async () => vi.runAllTimersAsync());
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(native.listeners.size).toBe(0);
  expect(reload).not.toHaveBeenCalled();
});

it("ignores a reconnect that finishes after the window unmounts", async () => {
  native.status.mockResolvedValue({ state: "unavailable", message: "Disconnected." });
  let resolve!: (state: unknown) => void;
  native.reconnect.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { unmount, reload } = await mounted();
  unmount();
  await act(async () => resolve({ state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 }));
  expect(reload).not.toHaveBeenCalled();
});

it("unsubscribes when a window unmounts and leaves legacy startup quiet", async () => {
  native.status.mockResolvedValue({ state: "inProcess" });
  const { unmount, reload } = await mounted();
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.listeners.size).toBe(3);
  unmount();
  expect(native.listeners.size).toBe(0);
  expect(reload).not.toHaveBeenCalled();
});
