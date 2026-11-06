import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, errorMessage: String }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => { mocks.handlers.set(name, handler); return () => {}; }) }));
import { bySavedOrder, customSessionOrder, DEFAULT_SIDEBAR_ORDER, bootSidebarOrder, saveSidebarOrder, useSidebarOrder } from "./sidebarOrder";
import { act, renderHook } from "@testing-library/react";

const entry = (id: string, created: string, extra: Partial<SessionEntry> = {}) => ({ id, created, ...extra }) as SessionEntry;

describe("custom sidebar ordering", () => {
  it("ignores pins and message activity, with new sessions first by creation", () => {
    const rows = [entry("a", "2026-01-01"), entry("b", "2026-01-02", { pinned: true, lastMessageAt: "2027-01-01" }), entry("new", "2026-02-01"), entry("newer", "2026-03-01")];
    expect(customSessionOrder(rows, { ...DEFAULT_SIDEBAR_ORDER, sessions: ["a", "b"] }).map((s) => s.id)).toEqual(["newer", "new", "a", "b"]);
    expect(rows.map((s) => s.id)).toEqual(["a", "b", "new", "newer"]);
  });
  it("keeps the relative order through filters and stale/deleted keys", () => {
    expect(bySavedOrder(["b", "a", "new"], ["gone", "a", "hidden", "b"], (id) => id, (a, b) => a.localeCompare(b))).toEqual(["new", "a", "b"]);
  });
  it("subscribes before reading, rejects stale snapshots, retains order on save failure and resyncs after reconnect", async () => {
    let resolveRead!: (order: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const hook = renderHook(useSidebarOrder);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const remote = { custom: true, sessions: ["b", "a"], projects: ["/b", "/a"], revision: 2 };
    await act(async () => {
      mocks.handlers.get("sidebar_order_changed")!({ payload: remote });
      resolveRead({ ...DEFAULT_SIDEBAR_ORDER, revision: 1 });
      await bootSidebarOrder();
    });
    expect(hook.result.current).toMatchObject(remote);
    mocks.invoke.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => { await saveSidebarOrder({ sessions: ["a", "b"] }); });
    expect(hook.result.current.sessions).toEqual(["b", "a"]);
    expect(hook.result.current.error).toContain("disk full");
    mocks.invoke.mockResolvedValueOnce({ ...remote, custom: false, revision: 3 });
    await act(async () => { await saveSidebarOrder({ custom: false }); });
    expect(hook.result.current).toMatchObject({ custom: false, sessions: ["b", "a"], error: null });
    mocks.invoke.mockResolvedValueOnce({ ...remote, revision: 4 });
    await act(async () => { mocks.handlers.get("local_runtime_reattached")!({ payload: null }); });
    expect(hook.result.current).toMatchObject({ ...remote, revision: 4 });
    hook.unmount();
  });
});
