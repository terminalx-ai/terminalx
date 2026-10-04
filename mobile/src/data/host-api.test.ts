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

describe("mobile transcript pages", () => {
  it("preserves refusals and transport failures instead of reporting empty history", async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, refusal: { code: "unavailable", message: "Transcript event 12 is too large to load on mobile." } });
    await expect(hostApi(request).tail("session", "tab")).rejects.toThrow("event 12 is too large");
    request.mockRejectedValueOnce(new Error("Connection closed"));
    await expect(hostApi(request).tail("session", "tab")).rejects.toThrow("Connection closed");
  });

  it.each([null, {}, { events: [], hasMore: true }, { events: [] }, { events: [{}], hasMore: false }])("rejects malformed pages: %j", async (value) => {
    const request = vi.fn().mockResolvedValue({ ok: true, value });
    await expect(hostApi(request).tail("session", "tab")).rejects.toThrow("invalid transcript page");
  });

  it("accepts empty history and forwards the exclusive event cursor", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { events: [], hasMore: false } });
    await expect(hostApi(request).tail("session", "tab", 12)).resolves.toEqual({ events: [], hasMore: false });
    expect(request).toHaveBeenCalledWith("session.tail", { sessionId: "session", tabId: "tab", before: 12, limit: 20 });
  });
});

describe("mobile chat sends", () => {
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

// PRO-87
describe("the computer's name and unpairing", () => {
  it("asks the computer what it is called, and takes no answer from an older desktop", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { name: "Paresh’s Mac mini" } });
    await expect(hostApi(request).describe()).resolves.toBe("Paresh’s Mac mini");
    expect(request).toHaveBeenCalledWith("host.describe");
    // An older desktop refuses the method; one with no name answers null.
    await expect(hostApi(vi.fn().mockResolvedValue({ ok: false, refusal: { code: "forbidden", message: "no" } })).describe()).resolves.toBeNull();
    await expect(hostApi(vi.fn().mockResolvedValue({ ok: true, value: { name: null } })).describe()).resolves.toBeNull();
    await expect(hostApi(vi.fn().mockResolvedValue({ ok: true, value: { name: { evil: true } } })).describe()).resolves.toBeNull();
  });

  it("reports whether the computer dropped this phone", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { forgotten: true } });
    await expect(hostApi(request).forgetPairing()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("pairing.forget");
    await expect(hostApi(vi.fn().mockResolvedValue({ ok: false, refusal: { code: "forbidden", message: "no" } })).forgetPairing()).resolves.toBe(false);
  });
});

describe("conditional lists", () => {
  it("negotiates once, coalesces concurrent reads, and reuses unchanged notes", async () => {
    const note = { id: "n", body: "synthetic", createdAt: 1, author: { userId: "synthetic" } };
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { conditionalLists: 1 } })
      .mockResolvedValueOnce({ ok: true, value: { messages: [note], version: "v1" } })
      .mockResolvedValueOnce({ ok: true, value: { notModified: true, version: "v1" } });
    const api = hostApi(request);
    expect(await Promise.all([api.listNotes("session"), api.listNotes("session")])).toEqual([[note], [note]]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await api.listNotes("session")).toEqual([note]);
    expect(request).toHaveBeenLastCalledWith("chat.list", { worktreeId: "session", limit: 100, version: "v1" });
  });

  it("renegotiates after reconnect and drops conditional versions on host switches", async () => {
    const request = vi.fn(async (method: string) => ({ ok: true, value: method === "sync.capabilities" ? { conditionalLists: 1 } : { sessions: [], version: "v1" } }));
    const api = hostApi(request);
    await api.summaries(); api.resetConnection(); await api.summaries();
    expect(request).toHaveBeenLastCalledWith("sessions.summaries", { version: "v1" });
    api.resetConnection(true); await api.summaries();
    expect(request).toHaveBeenLastCalledWith("sessions.summaries", {});
    expect(request.mock.calls.filter(([method]) => method === "sync.capabilities")).toHaveLength(3);
  });

  it("never sends conditional fields to an older host", async () => {
    const request = vi.fn(async (method: string) => method === "sync.capabilities"
      ? { ok: false, refusal: { code: "forbidden", message: "unsupported" } }
      : { ok: true, value: { messages: [], version: "ignored" } });
    const api = hostApi(request);
    await api.listNotes("session"); await api.listNotes("session");
    expect(request).toHaveBeenLastCalledWith("chat.list", { worktreeId: "session", limit: 100 });
  });
});
