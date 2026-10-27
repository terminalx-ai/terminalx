import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ status: vi.fn(), reconnect: vi.fn(), listeners: new Map<string, () => void>() }));
const localIndex = vi.hoisted(() => ({ loaded: true, sessions: [{ tabs: [{ id: "local-tab-a" }, { id: "local-tab-b" }, { id: "local-tab" }] }] }));
vi.mock("@/lib/sessions", () => ({ getSessionStore: () => localIndex }));
vi.mock("@/lib/cloudAgents", () => ({ cloudDraftsReadyForRecovery: () => true }));
vi.mock("@/lib/api", () => ({ localRuntime: native, errorMessage: (error: unknown) => String(error) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    native.listeners.set(event, callback);
    return () => native.listeners.delete(event);
  }),
}));

import { LocalRuntimeNotice } from "./LocalRuntimeNotice";
import { clearDrafts, getDraft, setDraft } from "@/lib/drafts";

const connected = { state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 };
const unavailable = { state: "unavailable", message: "Live terminal output in window main is disconnected. Agents and terminal commands may still be running." };
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  localIndex.loaded = true;
  clearDrafts(() => true);
  native.status.mockReset().mockResolvedValue(connected);
  native.reconnect.mockReset().mockImplementation(async () => {
    native.status.mockResolvedValue(connected);
    return connected;
  });
  native.listeners.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mounted(reload = vi.fn()) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<LocalRuntimeNotice reload={reload} />); });
  return { ...view, reload };
}
async function disconnect(event = "local_runtime_disconnected") {
  await act(async () => native.listeners.get(event)?.());
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

it("ignores another window's failure and delayed disconnects when current transport is healthy", async () => {
  const { reload } = await mounted();
  await disconnect("local_runtime_view_disconnected");
  await disconnect();
  await advance(30_000);
  expect(screen.queryByRole("status")).toBeNull();
  expect(native.reconnect).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("automatically reattaches once and clears the notice without moving focus", async () => {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  const { reload } = await mounted();
  native.status.mockResolvedValue(unavailable);
  await disconnect("local_runtime_view_disconnected");
  expect(screen.getByRole("status").textContent).toContain("window main");
  expect(document.activeElement).toBe(input);
  await advance(1_000);
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status")).toBeNull();
  await disconnect();
  await advance(30_000);
  expect(native.reconnect).toHaveBeenCalledOnce();
  input.remove();
});

it("bounds retries, keeps checking health, and clears after independent recovery", async () => {
  native.status.mockResolvedValue(unavailable);
  native.reconnect.mockRejectedValue("Owner unavailable");
  const { reload } = await mounted();
  await advance(60_000);
  expect(native.reconnect).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  native.status.mockResolvedValue(connected);
  await advance(5_000);
  expect(screen.queryByRole("status")).toBeNull();
  expect(reload).not.toHaveBeenCalled();
  expect(native.reconnect).toHaveBeenCalledTimes(3);
});

it("allows manual recovery after exhausting automatic attempts", async () => {
  native.status.mockResolvedValue(unavailable);
  native.reconnect.mockRejectedValue("Owner unavailable");
  const { reload } = await mounted();
  await advance(60_000);
  native.reconnect.mockImplementation(async () => {
    native.status.mockResolvedValue(connected);
    return connected;
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reconnect" })));
  expect(native.reconnect).toHaveBeenCalledTimes(4);
  expect(reload).toHaveBeenCalledOnce();
});

it("does not let an older healthy status erase a newer failure", async () => {
  let resolve!: (state: unknown) => void;
  native.status.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await mounted();
  native.status.mockResolvedValue(unavailable);
  await disconnect();
  await act(async () => resolve(connected));
  expect(screen.getByRole("status").textContent).toContain("Live connection unavailable");
  expect(native.reconnect).not.toHaveBeenCalled();
});

it("serializes recovery and reloads once when the event precedes its reply", async () => {
  native.status.mockResolvedValue(unavailable);
  let resolve!: (state: unknown) => void;
  native.reconnect.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { reload } = await mounted();
  await advance(1_000);
  expect((screen.getByRole("button", { name: "Reconnecting…" }) as HTMLButtonElement).disabled).toBe(true);
  await disconnect();
  await disconnect("local_runtime_reattached");
  native.status.mockResolvedValue(connected);
  await act(async () => resolve(connected));
  expect(reload).toHaveBeenCalledOnce();
  expect(native.reconnect).toHaveBeenCalledOnce();
});

it.each(["view", "shared"])("F1 preserves unsent local text across a %s recovery document boundary", async (kind) => {
  const text = "Unsent local prompt\nKeep exactly, including 🦊";
  setDraft("local-tab-a", text);
  setDraft("local-tab-b", "Another tab's unsent prompt");
  native.status.mockResolvedValue(kind === "view" ? unavailable : connected);
  const { unmount, reload } = await mounted();
  if (kind === "view") await advance(1_000);
  else await disconnect("local_runtime_reattached");
  expect(reload).toHaveBeenCalledOnce();
  unmount();
  // Reset the module registry, retaining only per-window browser storage:
  // the old in-memory Map cannot satisfy these assertions.
  vi.resetModules();
  const restored = await import("@/lib/drafts");
  expect(restored.getDraft("local-tab-a")).toBe(text);
  expect(restored.getDraft("local-tab-b")).toBe("Another tab's unsent prompt");
  expect(restored.getDraft("unrelated-tab")).toBe("");
  restored.setDraft("local-tab-a", ""); // Composer's existing clear-on-send path.
  restored.clearDrafts((id) => id === "local-tab-b");
  restored.checkpointDraftsForRecovery(["local-tab-a", "local-tab-b"]);
  vi.resetModules();
  const afterAnotherReload = await import("@/lib/drafts");
  expect(afterAnotherReload.getDraft("local-tab-a")).toBe("");
  expect(afterAnotherReload.getDraft("local-tab-b")).toBe("");
  // The native mock exposes only status/reconnect; any prompt dispatch is an
  // unexpected API call. A shared event doesn't reconnect unrelated readers.
  expect(native.reconnect).toHaveBeenCalledTimes(kind === "view" ? 1 : 0);
});

it("waits for positive local ownership before checkpointing a fresh document", async () => {
  localIndex.loaded = false;
  setDraft("local-tab", "Keep while the local index loads");
  const { reload } = await mounted();
  await disconnect("local_runtime_reattached");
  expect(reload).not.toHaveBeenCalled();
  expect(getDraft("local-tab")).toBe("Keep while the local index loads");
  localIndex.loaded = true;
  await advance(1_000);
  expect(reload).toHaveBeenCalledOnce();
  expect(native.reconnect).not.toHaveBeenCalled();
});

it("does not hydrate legacy unclassified recovery text", async () => {
  sessionStorage.setItem("terminalx.localRuntime.drafts.v1", JSON.stringify([["t-1", "A's cloud text"]]));
  vi.resetModules();
  const restored = await import("@/lib/drafts");
  expect(restored.getDraft("t-1")).toBe("");
  expect(sessionStorage.getItem("terminalx.localRuntime.drafts.v1")).toBeNull();
});

it("F1 preserves in-memory text and refuses reload if its checkpoint cannot be stored", async () => {
  setDraft("local-tab", "Do not discard");
  const { reload } = await mounted();
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
  try {
    await disconnect("local_runtime_reattached");
    expect(reload).not.toHaveBeenCalled();
    expect(getDraft("local-tab")).toBe("Do not discard");
    expect(screen.getByRole("status").textContent).toContain("Storage full");
  } finally { write.mockRestore(); }
});

it("F2 coalesces manual clicks during a held health poll into exactly one retry", async () => {
  native.status.mockResolvedValue(unavailable);
  native.reconnect.mockRejectedValue("Owner unavailable");
  await mounted();
  await advance(7_000);
  expect(native.reconnect).toHaveBeenCalledTimes(3);
  let resolve!: (state: unknown) => void;
  native.status.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await advance(5_000);
  act(() => {
    const button = screen.getByRole("button", { name: "Reconnect" });
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(native.reconnect).toHaveBeenCalledTimes(3);
  await act(async () => resolve(unavailable));
  expect(native.reconnect).toHaveBeenCalledTimes(4);
  await advance(60_000);
  expect(native.reconnect).toHaveBeenCalledTimes(4);
});

it("F3 retains the total attempt budget across release/reload/remount and initial absent-reader health", async () => {
  for (const delay of [1_000, 2_000, 4_000]) {
    native.status.mockResolvedValue(connected); // Page loaded, no replacement tap yet.
    const { unmount, reload } = await mounted();
    native.status.mockResolvedValue(unavailable); // Replacement reader EOF after handshake.
    await disconnect("local_runtime_view_disconnected");
    await advance(delay);
    expect(reload).toHaveBeenCalledOnce();
    unmount();
    vi.resetModules();
    const lifetime = await import("@/lib/localRuntimeRecovery");
    expect(lifetime.recoveryAttempts()).toBe(native.reconnect.mock.calls.length);
  }
  const { reload } = await mounted();
  native.status.mockResolvedValue(unavailable);
  await disconnect("local_runtime_view_disconnected");
  await advance(60_000);
  expect(native.reconnect).toHaveBeenCalledTimes(3);
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
});

it("F4 rechecks a superseded successful release instead of clearing a newer disconnect", async () => {
  native.status.mockResolvedValue(unavailable);
  let resolve!: (state: unknown) => void;
  native.reconnect.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { reload } = await mounted();
  await advance(1_000);
  await disconnect(); // No reattached event to mask the ordering defect.
  const reads = native.status.mock.calls.length;
  await act(async () => resolve(connected));
  expect(native.status.mock.calls.length).toBeGreaterThan(reads);
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("disconnected");
  native.status.mockResolvedValue(connected);
  await disconnect();
  expect(reload).toHaveBeenCalledOnce();
  expect(native.reconnect).toHaveBeenCalledOnce();
});

it("cancels timers and ignores an in-flight recovery after unmount", async () => {
  native.status.mockResolvedValue(unavailable);
  let resolve!: (state: unknown) => void;
  native.reconnect.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { unmount, reload } = await mounted();
  await advance(1_000);
  unmount();
  await act(async () => resolve(connected));
  await advance(60_000);
  expect(native.listeners.size).toBe(0);
  expect(native.reconnect).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  vi.resetModules();
  const nextDocument = await import("@/lib/localRuntimeRecovery");
  expect(nextDocument.recoveryAttempts()).toBe(1);
});
