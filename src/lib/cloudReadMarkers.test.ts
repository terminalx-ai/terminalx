// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { flushReadMarkers, isServerRead, mergeReadMarkers, queueReadMarker, setReadMarkerAccount } from "./cloudReadMarkers";
const marker = { orgId: "org", workspaceId: "ws", sessionId: "session", tabId: "tab", readSeq: 10 };
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); invoke.mockReset(); setReadMarkerAccount(null); setReadMarkerAccount("A"); });
afterEach(() => { setReadMarkerAccount(null); vi.useRealTimers(); });
describe("server read reconciliation", () => {
  it("clears the observed reply, preserving later replies and other tabs", () => {
    mergeReadMarkers([marker]);
    expect(isServerRead(marker)).toBe(true);
    expect(isServerRead({ ...marker, readSeq: 11 })).toBe(false);
    expect(isServerRead({ ...marker, tabId: "other" })).toBe(false);
    mergeReadMarkers([{ ...marker, readSeq: 2 }]);
    expect(isServerRead(marker)).toBe(true);
  });
  it("retries offline reads from storage without affecting another account", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    queueReadMarker(marker); await Promise.resolve(); await Promise.resolve();
    expect(isServerRead(marker)).toBe(true);
    setReadMarkerAccount("B"); expect(isServerRead(marker)).toBe(false);
    invoke.mockResolvedValue(marker); setReadMarkerAccount("A");
    await Promise.resolve(); await Promise.resolve(); await flushReadMarkers();
    expect(isServerRead(marker)).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("desktop_read_marker", { owner: "A", marker });
  });
  it("discards late responses after a switch including A to B to A", async () => {
    let resolve!: (m: typeof marker) => void;
    invoke.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(marker);
    queueReadMarker(marker);
    setReadMarkerAccount("B"); setReadMarkerAccount("A");
    resolve({ ...marker, readSeq: 100 }); await Promise.resolve(); await Promise.resolve();
    expect(isServerRead({ ...marker, readSeq: 100 })).toBe(false);
  });
  it("sends a newer observed reply immediately after an in-flight older marker", async () => {
    let resolve!: (m: typeof marker) => void;
    invoke.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ ...marker, readSeq: 11 });
    queueReadMarker(marker);
    queueReadMarker({ ...marker, readSeq: 11 });
    resolve(marker);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("desktop_read_marker", { owner: "A", marker: { ...marker, readSeq: 11 } });
  });

  it.each(["desktop_inbox_http_403", "desktop_inbox_http_404", "offline"])("does not block other workspaces after %s", async (failure) => {
    const other = { ...marker, workspaceId: "still-authorized" };
    invoke.mockImplementation((_cmd, { marker: incoming }) => incoming.workspaceId === marker.workspaceId ? Promise.reject(new Error(failure)) : Promise.resolve(incoming));
    queueReadMarker(marker);
    queueReadMarker(other);
    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke).toHaveBeenCalledWith("desktop_read_marker", { owner: "A", marker: other });
    const persisted = JSON.parse(localStorage.getItem("terminalx.read-markers.A") ?? "[]");
    expect(persisted).toEqual(failure === "offline" ? [marker] : []);
    invoke.mockResolvedValue(marker);
    setReadMarkerAccount(null); setReadMarkerAccount("A");
    await flushReadMarkers();
    expect(JSON.parse(localStorage.getItem("terminalx.read-markers.A") ?? "[]")).toEqual([]);
  });

});
