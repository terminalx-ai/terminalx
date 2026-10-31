import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalRuntimeState } from "@/lib/api";

const native = vi.hoisted(() => ({ status: vi.fn(), reconnect: vi.fn(), restart: vi.fn(), listeners: new Map<string, () => void>() }));
const terminals = vi.hoisted(() => ({ reattachLocalTerminals: vi.fn() }));
vi.mock("@/lib/api", () => ({ localRuntime: native, errorMessage: (error: unknown) => String(error) }));
vi.mock("@/lib/terminal", () => terminals);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    native.listeners.set(event, callback);
    return () => native.listeners.delete(event);
  }),
}));

const connected: LocalRuntimeState = { state: "connected", epoch: "owner", generation: 1, view: 0 };
const connecting = (downMs: number, attempt = 2, terminal = false): LocalRuntimeState => ({
  state: "connecting", terminal, attempt, retryInMs: 500, downMs,
  message: "Could not reconnect to the background runtime: connection refused",
});
const unresponsive: LocalRuntimeState = { state: "unresponsive", message: "The TerminalX runtime did not answer runtime.liveness within 15 seconds.", epoch: "owner" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  native.status.mockReset().mockResolvedValue(connected);
  native.reconnect.mockReset().mockResolvedValue(connected);
  // The desktop stops the runtime, then attaches a fresh one by itself.
  native.restart.mockReset().mockImplementation(async () => {
    native.status.mockResolvedValue({ ...connected, epoch: "fresh", generation: 2 });
    return connecting(0, 1);
  });
  native.listeners.clear();
  terminals.reattachLocalTerminals.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mounted() {
  // A fresh store per test: it is module state, as in a window.
  const { LocalRuntimeNotice } = await import("./LocalRuntimeNotice");
  await act(async () => { render(<LocalRuntimeNotice />); });
}
/** The desktop's state changed: windows read their status again. */
async function changed(state: LocalRuntimeState) {
  native.status.mockResolvedValue(state);
  await act(async () => native.listeners.get("local_runtime_state")?.());
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

it("says nothing about a short gap that recovers by itself", async () => {
  await mounted();
  await changed(connecting(0, 1));
  await advance(2_000);
  expect(screen.queryByRole("status")).toBeNull();
  await changed({ ...connected, generation: 2 });
  await advance(60_000);
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.reconnect).not.toHaveBeenCalled();
});

it("after a few seconds says it is reconnecting, asks for nothing, and clears by itself", async () => {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  await mounted();
  await changed(connecting(0, 3));
  await advance(3_000);
  expect(screen.getByRole("status").textContent).toContain("Reconnecting… (attempt 3)");
  expect(screen.getByRole("status").textContent).toContain("Agents and terminal commands keep running.");
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.activeElement).toBe(input);
  await changed(connecting(4_000, 4));
  expect(screen.getByRole("status").textContent).toContain("(attempt 4)");
  await changed({ ...connected, generation: 2 });
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.reconnect).not.toHaveBeenCalled();
  input.remove();
});

it("names a gap in this window's terminal output alone", async () => {
  await mounted();
  await changed(connecting(5_000, 2, true));
  expect(screen.getByRole("status").textContent).toContain("Reconnecting terminal output… (attempt 2)");
});

it("offers Try again once a failure has lasted minutes, and trying asks the desktop, never the page", async () => {
  await mounted();
  await changed(connecting(119_000, 12));
  expect(screen.queryByRole("button")).toBeNull();
  await advance(1_000);
  expect(screen.getByRole("status").textContent).toContain("Live connection unavailable");
  expect(screen.getByRole("status").textContent).toContain("connection refused");
  native.status.mockResolvedValue({ ...connected, generation: 2 });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status")).toBeNull();
});

it("says at once when retrying cannot help, and clears when it later succeeds", async () => {
  await mounted();
  await changed({ state: "unavailable", message: "Another TerminalX window is connected to this background runtime. Close it, then try again." });
  expect(screen.getByRole("status").textContent).toContain("Another TerminalX window is connected");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  await changed({ ...connected, generation: 2 });
  expect(screen.queryByRole("status")).toBeNull();
});

it("a late disconnect hint after recovery cannot bring the notice back while status is healthy", async () => {
  await mounted();
  await changed(connecting(10_000));
  expect(screen.getByRole("status")).toBeTruthy();
  await changed({ ...connected, generation: 2 });
  for (let i = 0; i < 3; i++) await changed({ ...connected, generation: 2 });
  await advance(180_000);
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.reconnect).not.toHaveBeenCalled();
});

it("offers a restart, never Try again, for a runtime that stopped answering, and the fresh one attaches in place", async () => {
  await mounted();
  await changed(unresponsive);
  expect(screen.getByRole("status").textContent).toContain("TerminalX runtime is not responding");
  expect(screen.getByRole("status").textContent).toContain("within 15 seconds");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await advance(180_000);
  expect(native.reconnect).not.toHaveBeenCalled();
  expect(native.restart).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart runtime" })); });
  // Only the runtime this window found not responding.
  expect(native.restart).toHaveBeenCalledExactlyOnceWith("owner");
  expect(screen.queryByRole("status")).toBeNull();
  // Its terminals move to the fresh runtime without a reload.
  expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
});

it("shows the watchdog's finding as soon as it reports one, and clears once the runtime answers again", async () => {
  await mounted();
  expect(screen.queryByRole("status")).toBeNull();
  await changed(unresponsive);
  expect(screen.getByRole("status").textContent).toContain("TerminalX runtime is not responding");
  await changed(connected);
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.restart).not.toHaveBeenCalled();
  expect(terminals.reattachLocalTerminals).not.toHaveBeenCalled();
});

it("says why a restart failed and leaves it to be tried again", async () => {
  native.restart.mockRejectedValue("Could not stop the TerminalX runtime: it was left running.");
  await mounted();
  await changed(unresponsive);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart runtime" })); });
  expect(screen.getByRole("alert").textContent).toContain("Could not stop the TerminalX runtime");
  expect((screen.getByRole("button", { name: "Restart runtime" }) as HTMLButtonElement).disabled).toBe(false);
  // Once it answers again, the failure is old news.
  await changed(connected);
  await changed(unresponsive);
  expect(screen.queryByRole("alert")).toBeNull();
});
