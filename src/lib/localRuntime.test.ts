import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntimeState } from "@/lib/api";

const native = vi.hoisted(() => ({ status: vi.fn(), reconnect: vi.fn(), listeners: new Map<string, () => void>() }));
const terminals = vi.hoisted(() => ({ reattachLocalTerminals: vi.fn() }));
vi.mock("@/lib/api", () => ({ localRuntime: native, errorMessage: (error: unknown) => String(error) }));
vi.mock("@/lib/terminal", () => terminals);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    native.listeners.set(event, callback);
    return () => native.listeners.delete(event);
  }),
}));

const connected = (generation: number, view = 0): LocalRuntimeState => ({ state: "connected", epoch: "owner", generation, view });
const connecting: LocalRuntimeState = { state: "connecting", terminal: false, attempt: 1, retryInMs: 250, downMs: 0, message: "closed" };

async function booted(first: LocalRuntimeState) {
  vi.resetModules();
  native.status.mockResolvedValue(first);
  const store = await import("./localRuntime");
  await store.bootLocalRuntime();
  return store;
}
async function changed(state: LocalRuntimeState) {
  native.status.mockResolvedValue(state);
  native.listeners.get("local_runtime_state")!();
  // The read and what it applies settle within one macrotask.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  native.status.mockReset();
  native.reconnect.mockReset().mockResolvedValue(undefined);
  native.listeners.clear();
  terminals.reattachLocalTerminals.mockReset();
});

describe("a window's terminals follow its live connection", () => {
  it("attach again once over a new attachment, and not for a repeated status", async () => {
    await booted(connected(1));
    expect(terminals.reattachLocalTerminals).not.toHaveBeenCalled();
    await changed(connecting);
    await changed(connected(2));
    expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
    await changed(connected(2));
    expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
  });

  it("attach again when only this window's terminal output was re-established", async () => {
    await booted(connected(4, 0));
    await changed(connected(4, 9));
    expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
  });

  it("attach once connected when the window opened while the connection was down", async () => {
    await booted(connecting);
    expect(terminals.reattachLocalTerminals).not.toHaveBeenCalled();
    await changed(connected(3));
    expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
  });

  it("answer hints that arrive during a read with one more read, never one each", async () => {
    let finish!: (state: LocalRuntimeState) => void;
    vi.resetModules();
    native.status.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const store = await import("./localRuntime");
    const boot = store.bootLocalRuntime();
    await vi.waitFor(() => expect(native.listeners.has("local_runtime_state")).toBe(true));
    native.status.mockResolvedValue(connected(2));
    for (let i = 0; i < 5; i++) native.listeners.get("local_runtime_state")!();
    finish(connected(1));
    await boot;
    expect(native.status).toHaveBeenCalledTimes(2);
  });

  it("ask the desktop to try now, then read what it says", async () => {
    const store = await booted(connecting);
    native.status.mockResolvedValue(connected(2));
    await store.reconnectLocalRuntime();
    expect(native.reconnect).toHaveBeenCalledOnce();
    expect(native.status.mock.invocationCallOrder.at(-1)).toBeGreaterThan(native.reconnect.mock.invocationCallOrder[0]);
    expect(terminals.reattachLocalTerminals).toHaveBeenCalledOnce();
  });
});
