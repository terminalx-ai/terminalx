import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  native.status.mockReset().mockResolvedValue({ state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 });
  native.reconnect.mockReset();
  native.listeners.clear();
});
afterEach(cleanup);

async function mounted(reload = vi.fn()) {
  const view = render(<LocalRuntimeNotice reload={reload} />);
  await waitFor(() => expect(native.status).toHaveBeenCalledOnce());
  return { ...view, reload };
}

it("leaves a connected session alone and does not take keyboard focus", async () => {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  const { reload } = await mounted();
  expect(screen.queryByRole("status")).toBeNull();
  act(() => native.listeners.get("local_runtime_disconnected")?.());
  expect(screen.getByRole("status").textContent).toContain("may still be running");
  expect(document.activeElement).toBe(input);
  expect(native.reconnect).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  input.remove();
});

it("does not let an older successful status read erase a newer disconnect", async () => {
  let resolve!: (state: unknown) => void;
  native.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await mounted();
  act(() => native.listeners.get("local_runtime_view_disconnected")?.());
  await act(async () => resolve({ state: "connected", epoch: "old", runningAgents: 1, terminals: 1 }));
  expect(screen.getByRole("status").textContent).toContain("Live connection unavailable");
  expect(native.reconnect).not.toHaveBeenCalled();
});

it("keeps an owner-loss error visible and retries only when explicitly asked", async () => {
  native.status.mockResolvedValue({ state: "unavailable", message: "Owner connection closed." });
  native.reconnect.mockRejectedValue("Owner is no longer available. Reopen TerminalX.");
  const { reload } = await mounted();
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Owner is no longer available"));
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(false);
});

it("reloads views once after confirmed reattachment, without replaying commands", async () => {
  native.status.mockResolvedValue({ state: "unavailable", message: "Disconnected." });
  let resolve!: (state: unknown) => void;
  native.reconnect.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { reload } = await mounted();
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  expect((screen.getByRole("button", { name: "Reconnecting…" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => native.listeners.get("local_runtime_reattached")?.());
  await act(async () => resolve({ state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 }));
  expect(reload).toHaveBeenCalledOnce();
  expect(native.reconnect).toHaveBeenCalledOnce();
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
