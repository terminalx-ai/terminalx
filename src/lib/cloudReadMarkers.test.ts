import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudActivityRead, configureCloudReadMarkers, forgetCloudReadMarkers, enableCloudReadMarkerWrites, reconcileCloudReadMarker, writeCloudReadMarker } from "./cloudReadMarkers";
const early = "2026-11-14T10:00:00Z", late = "2026-11-14T11:00:00Z";
afterEach(() => configureCloudReadMarkers(null, null));
describe("read marker reconciliation", () => {
  it("keeps the newest catalog/event/write response and preserves independent session/workspace markers", () => {
    configureCloudReadMarkers("a", null);
    reconcileCloudReadMarker("o", "w", { sessionId: "s", readAt: late });
    reconcileCloudReadMarker("o", "w", { sessionId: "s", readAt: early });
    expect(cloudActivityRead("o", "w", "s", late)).toBe(true);
    expect(cloudActivityRead("o", "w", "another", early)).toBe(false);
    expect(cloudActivityRead("o", "w", "", early)).toBe(false);
    expect(cloudActivityRead("o", "w", "s", "2026-11-14T12:00:00Z")).toBe(false);
    forgetCloudReadMarkers("w"); expect(cloudActivityRead("o", "w", "s", late)).toBe(false);
  });
  it("uses the actual session ID and rendered activity time, accepting a newer stored server marker", async () => {
    const send = vi.fn().mockResolvedValue({ sessionId: "runtime-session", readAt: late });
    configureCloudReadMarkers("a", send);
    await writeCloudReadMarker("inactive-org", "w", "runtime-session", early);
    expect(send).toHaveBeenCalledWith("inactive-org", "w", "2026-11-14T10:00:00.000Z", "runtime-session");
    expect(cloudActivityRead("inactive-org", "w", "runtime-session", late)).toBe(true);
  });
  it("never applies a late read response across A -> B -> A", async () => {
    let resolve!: (value: { sessionId: string; readAt: string }) => void;
    configureCloudReadMarkers("a", () => new Promise((r) => { resolve = r; }));
    const write = writeCloudReadMarker("o", "w", "s", early);
    configureCloudReadMarkers("b", null); configureCloudReadMarkers("a", null);
    resolve({ sessionId: "s", readAt: late }); await write;
    expect(cloudActivityRead("o", "w", "s", early)).toBe(false);
  });
  it("ignores invalid/future dates, arbitrary tab paths and denied writes", async () => {
    const send = vi.fn().mockRejectedValue({ code: "cloud_workspace_not_found" });
    configureCloudReadMarkers("a", send);
    for (const at of ["invalid", "2999-01-01T00:00:00Z"]) await writeCloudReadMarker("o", "w", "s", at);
    await writeCloudReadMarker("o", "w", "cloud:o:w/tab", early);
    expect(send).not.toHaveBeenCalled();
    await writeCloudReadMarker("o", "w", "s", early);
    expect(cloudActivityRead("o", "w", "s", early)).toBe(false);
  });
});

it("discards a successful marker write that was in flight when sharing was revoked", async () => {
  let resolve!: (value: { sessionId: string; readAt: string }) => void;
  configureCloudReadMarkers("a", () => new Promise((r) => { resolve = r; }));
  const writing = writeCloudReadMarker("o", "w", "s", early);
  forgetCloudReadMarkers("w");
  resolve({ sessionId: "s", readAt: late }); await writing;
  expect(cloudActivityRead("o", "w", "s", early)).toBe(false);
});


it("enables writes without losing startup catalog markers and fences writes during a context refresh", async () => {
  configureCloudReadMarkers("a", null);
  reconcileCloudReadMarker("o", "w", { sessionId: "s", readAt: late });
  const send = vi.fn().mockResolvedValue({ sessionId: "s", readAt: early });
  enableCloudReadMarkerWrites("a", send);
  await writeCloudReadMarker("o", "w", "s", early);
  expect(cloudActivityRead("o", "w", "s", late)).toBe(true);
  configureCloudReadMarkers("a", null);
  expect(cloudActivityRead("o", "w", "s", late)).toBe(true);
  await writeCloudReadMarker("o", "w", "s", early);
  expect(send).toHaveBeenCalledOnce();
  configureCloudReadMarkers("b", null);
  expect(cloudActivityRead("o", "w", "s", early)).toBe(false);
});
