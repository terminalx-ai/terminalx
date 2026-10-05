import { describe, expect, it, vi } from "vitest";
import type { HostConnection } from "../transport/connection";
import { HostApi } from "./host-api";

vi.mock("expo-crypto", () => ({ randomUUID: () => "client-id" }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

function hostApi(request: ReturnType<typeof vi.fn>) {
  return new HostApi({ request } as unknown as HostConnection);
}

describe("mobile chat sends", () => {
  it("loads large histories one turn at a time, including earlier pages", async () => {
    const page = { events: [], hasMore: true };
    const request = vi.fn(async (_method: string, params: { limit: number }) => {
      if (params.limit > 1) throw new Error("transcript response exceeds the host transport limit");
      return { ok: true, value: page };
    });
    const api = hostApi(request);
    await expect(api.tail("session-1", "tab-1")).resolves.toEqual(page);
    await expect(api.tail("session-1", "tab-1", 100)).resolves.toEqual(page);
    expect(request).toHaveBeenLastCalledWith("session.tail", { sessionId: "session-1", tabId: "tab-1", before: 100, limit: 1 });
  });

  it("returns the created note instead of discarding the host result", async () => {
    const note = { id: "note-1", body: "hello", createdAt: 1, author: { userId: "user-1", displayName: "Paresh" } };
    const request = vi.fn().mockResolvedValue({ ok: true, value: { status: "sent", message: note } });

    await expect(hostApi(request).postNote("session-1", "hello")).resolves.toEqual({ sent: true, note });
  });

  it("preserves a host refusal for the Session screen", async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, refusal: { code: "unavailable", message: "host identity is unavailable" } });

    await expect(hostApi(request).postNote("session-1", "hello")).resolves.toEqual({ sent: false, message: "host identity is unavailable" });
  });

  it("preserves whether promotion was queued", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { status: "sent", queued: true } });

    await expect(hostApi(request).promoteNote("session-1", "tab-1", "note-1")).resolves.toEqual({ sent: true, queued: true });
  });

  it("forwards selected attachments with a session message", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { status: "sent", queued: false } });
    const attachment = { mediaType: "application/pdf", data: "cGRm", name: "brief.pdf" };

    await expect(hostApi(request).sendSession("tab-1", "", [attachment])).resolves.toEqual({ sent: true, queued: false });
    expect(request).toHaveBeenCalledWith("session.send", { tabId: "tab-1", text: "", attachments: [attachment] });
  });
});
