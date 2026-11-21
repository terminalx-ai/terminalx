import { describe, expect, it, vi } from "vitest";
import type { HostConnection } from "../transport/connection";
import { HostApi } from "./host-api";

vi.mock("expo-crypto", () => ({ randomUUID: () => "client-id" }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

function hostApi(request: ReturnType<typeof vi.fn>, fitted = false) {
  return new HostApi({ request, onEvent: () => () => {}, reassemblesFragments: async () => fitted } as unknown as HostConnection);
}

describe("mobile transcript pages", () => {
  it("loads large histories one turn at a time, including earlier pages", async () => {
    const page = { events: [{ id: "event-1", sessionId: "session-1", tabId: "tab-1", harness: "codex", seq: 99, ts: "2026-09-15T00:00:00Z", payload: { type: "user_message", text: "Synthetic turn", queued: false } }], hasMore: true };
    const request = vi.fn(async (_method: string, params: { limit: number }) => {
      if (params.limit > 1) throw new Error("transcript response exceeds the host transport limit");
      return { ok: true, value: page };
    });
    const api = hostApi(request);
    await expect(api.tail("session-1", "tab-1")).resolves.toEqual(page);
    await expect(api.tail("session-1", "tab-1", 100)).resolves.toEqual(page);
    expect(request).toHaveBeenLastCalledWith("session.tail", { sessionId: "session-1", tabId: "tab-1", before: 100, limit: 1 });
  });

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
    expect(request).toHaveBeenCalledWith("session.tail", { sessionId: "session", tabId: "tab", before: 12, limit: 1 });
  });
});

describe("phone caching and sending ahead (#1283)", () => {
  const syncEvent = (seq: number) => ({ id: `event-${seq}`, sessionId: "session", tabId: "tab", harness: "codex", seq, ts: "2026-11-19T00:00:00Z", payload: { type: "user_message", text: `turn ${seq}` } });
  const cursor = (offset: number) => ({ offset, digest: String(offset % 10).repeat(64) });

  it("asks a Mac that bounds its pages for several earlier turns at a time", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { events: [], hasMore: false } });
    await hostApi(request, true).tail("session", "tab", 40);
    expect(request).toHaveBeenLastCalledWith("session.tail", { sessionId: "session", tabId: "tab", before: 40, limit: 10 });
  });

  it("sends a session list version kept from an earlier launch, and shows that list when it did not change", async () => {
    const sessions = [{ id: "kept" }];
    const request = vi.fn(async (method: string) => method === "sync.capabilities"
      ? { ok: true, value: { conditionalLists: 1 } }
      : { ok: true, value: { notModified: true, version: "v-launch" } });
    const api = hostApi(request);
    api.rememberList("sessions.summaries", {}, "v-launch", { sessions });
    expect(api.listVersion("sessions.summaries")).toBe("v-launch");
    expect(await (api as unknown as { list(method: string): Promise<unknown> }).list("sessions.summaries")).toEqual({ sessions, version: "v-launch" });
    expect(request).toHaveBeenLastCalledWith("sessions.summaries", { version: "v-launch" });
  });

  it("does not let a kept list replace one already read on this connection", async () => {
    const request = vi.fn(async (method: string) => method === "sync.capabilities"
      ? { ok: true, value: { conditionalLists: 1 } }
      : { ok: true, value: { sessions: [], version: "v-now" } });
    const api = hostApi(request);
    await api.summaries();
    api.rememberList("sessions.summaries", {}, "v-old", { sessions: [] });
    expect(api.listVersion("sessions.summaries")).toBe("v-now");
  });

  it("asks for a prefetch only from a Mac that names it, and stops it the same way", async () => {
    const older = vi.fn().mockResolvedValue({ ok: true, value: { transcript: 1 } });
    expect(await hostApi(older).prefetch(true, [])).toBe(false);
    expect(older).toHaveBeenCalledTimes(1);
    const request = vi.fn(async (method: string, params?: { enabled?: boolean }) => method === "sync.capabilities"
      ? { ok: true, value: { transcript: 1, prefetch: 1 } }
      : { ok: true, value: { enabled: params?.enabled } });
    const api = hostApi(request);
    const known = [{ sessionId: "session", tabId: "tab", cursor: cursor(20) }];
    expect(await api.prefetch(true, known)).toBe(true);
    expect(request).toHaveBeenLastCalledWith("sync.prefetch", { enabled: true, known });
    expect(await api.prefetch(false)).toBe(false);
    expect(request).toHaveBeenLastCalledWith("sync.prefetch", { enabled: false });
  });

  it("names the conversations on screen only to a Mac that takes them (#1337)", async () => {
    const open = [{ sessionId: "session", tabId: "tab" }];
    const mac = (features: Record<string, number>) => vi.fn(async (method: string, params?: { enabled?: boolean }) => method === "sync.capabilities"
      ? { ok: true, value: features }
      : { ok: true, value: { enabled: params?.enabled } });
    // A Mac that refuses fields it does not know is not sent one.
    const older = mac({ transcript: 1, prefetch: 1 });
    expect(await hostApi(older).prefetch(true, [], open)).toBe(true);
    expect(older).toHaveBeenLastCalledWith("sync.prefetch", { enabled: true, known: [] });
    const newer = mac({ transcript: 1, prefetch: 1, prefetchOpen: 1 });
    expect(await hostApi(newer).prefetch(true, [], open)).toBe(true);
    expect(newer).toHaveBeenLastCalledWith("sync.prefetch", { enabled: true, known: [], open });
    await hostApi(newer).prefetch(true, [], []);
    expect(newer).toHaveBeenLastCalledWith("sync.prefetch", { enabled: true, known: [] });
  });

  it("passes on only prefetched pages that are contiguous with the checkpoint they continue", () => {
    let emit: (event: { method: string; params?: unknown }) => void = () => {};
    const api = new HostApi({ request: vi.fn(), onEvent: (listener: typeof emit) => { emit = listener; return () => {}; } } as unknown as HostConnection);
    const seen: unknown[] = [];
    api.onPrefetched((prefetched) => seen.push(prefetched));
    const page = { events: [syncEvent(21)], cursor: cursor(21), reset: false, hasMore: false, hasEarlier: true };
    emit({ method: "session.prefetch", params: { sessionId: "session", tabId: "tab", after: cursor(20), page } });
    // Not contiguous, another conversation's events, and no checkpoint for a forward page: all dropped.
    emit({ method: "session.prefetch", params: { sessionId: "session", tabId: "tab", after: cursor(19), page } });
    emit({ method: "session.prefetch", params: { sessionId: "session", tabId: "other", after: cursor(20), page } });
    emit({ method: "session.prefetch", params: { sessionId: "session", tabId: "tab", after: null, page } });
    const reset = { ...page, reset: true };
    emit({ method: "session.prefetch", params: { sessionId: "session", tabId: "tab", after: null, page: reset } });
    expect(seen).toEqual([
      { sessionId: "session", tabId: "tab", after: cursor(20), page },
      { sessionId: "session", tabId: "tab", after: undefined, page: reset },
    ]);
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

  it("sends a message's text to the agent and preserves whether it was queued (#541)", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { status: "sent", queued: true } });

    await expect(hostApi(request).sendSession("tab-1", "hello")).resolves.toEqual({ sent: true, queued: true });
    expect(request).toHaveBeenCalledWith("session.send", { tabId: "tab-1", text: "hello" });
  });

  it("lists which tab a note was promoted to, keeping a note whose promotion it cannot read (#541)", async () => {
    const plain = { id: "plain", body: "hello", createdAt: 1, author: { userId: "user-1" } };
    const promoted = { ...plain, id: "promoted", createdAt: 2, promotedTo: [{ tabId: "tab-1", seq: 7 }, { tabId: "tab-2" }] };
    const unreadable = { ...plain, id: "unreadable", createdAt: 3, promotedTo: "tab-1" };
    const request = vi.fn().mockResolvedValue({ ok: true, value: { messages: [promoted, unreadable, plain] } });

    await expect(hostApi(request).listNotes("session-1")).resolves.toEqual([
      plain,
      { ...promoted, promotedTo: [{ tabId: "tab-1", seq: 7 }] },
      { ...plain, id: "unreadable", createdAt: 3 },
    ]);
  });

  it("forwards selected attachments with a session message", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { status: "sent", queued: false } });
    const attachment = { mediaType: "application/pdf", data: "cGRm", name: "brief.pdf" };

    await expect(hostApi(request).sendSession("tab-1", "", [attachment])).resolves.toEqual({ sent: true, queued: false });
    expect(request).toHaveBeenCalledWith("session.send", { tabId: "tab-1", text: "", attachments: [attachment] });
  });
});

describe("a draft's id (#675)", () => {
  const note = { id: "note-1", body: "hello", createdAt: 1, author: { userId: "user-1" } };
  // A Mac answering `sync.capabilities` with `capabilities`, and every send and note as sent.
  const mac = (capabilities: unknown) => vi.fn(async (method: string) => method === "sync.capabilities"
    ? capabilities
    : { ok: true, value: method === "chat.post" ? { status: "sent", message: note } : { status: "sent", queued: false } });
  // Older Macs refuse fields they do not know: one predating the id, and one predating capabilities.
  const older = [{ ok: true, value: { transcript: 1, conditionalLists: 1 } }, { ok: false, refusal: { code: "forbidden", message: "unsupported" } }];

  it("goes with a message for the agent only to a Mac that understands it", async () => {
    const current = mac({ ok: true, value: { transcript: 1, conditionalLists: 1, sendIds: 1 } });
    await expect(hostApi(current).sendSession("tab-1", "hello", [], "draft-1")).resolves.toEqual({ sent: true, queued: false });
    expect(current).toHaveBeenLastCalledWith("session.send", { tabId: "tab-1", text: "hello", clientMessageId: "draft-1" });
    for (const capabilities of older) {
      const request = mac(capabilities);
      await expect(hostApi(request).sendSession("tab-1", "hello", [], "draft-1")).resolves.toEqual({ sent: true, queued: false });
      expect(request).toHaveBeenLastCalledWith("session.send", { tabId: "tab-1", text: "hello" });
    }
  });

  it("goes with a worktree note only to a Mac that understands it", async () => {
    const current = mac({ ok: true, value: { sendIds: 1 } });
    await expect(hostApi(current).postNote("worktree", "hello", "draft-1")).resolves.toEqual({ sent: true, note });
    expect(current).toHaveBeenLastCalledWith("chat.post", { worktreeId: "worktree", body: "hello", clientMessageId: "draft-1" });
    for (const capabilities of older) {
      const request = mac(capabilities);
      await expect(hostApi(request).postNote("worktree", "hello", "draft-1")).resolves.toEqual({ sent: true, note });
      expect(request).toHaveBeenLastCalledWith("chat.post", { worktreeId: "worktree", body: "hello" });
    }
  });

  it("asks what the Mac understands once per connection", async () => {
    const request = mac({ ok: true, value: { sendIds: 1 } });
    const api = hostApi(request);
    await api.sendSession("tab-1", "one", [], "draft-1");
    await api.postNote("worktree", "two", "draft-2");
    expect(request.mock.calls.filter(([method]) => method === "sync.capabilities")).toHaveLength(1);
    // A Mac updated while the phone was away is asked again after the reconnect.
    api.resetConnection();
    await api.sendSession("tab-1", "three", [], "draft-3");
    expect(request.mock.calls.filter(([method]) => method === "sync.capabilities")).toHaveLength(2);
  });

  // #730: an update replaces the Mac's runtime while the phone stays connected.
  it("asks again, and tells whoever shows a feature, when the Mac says its runtime changed or after a reconnect", async () => {
    let event: (value: { method: string; params?: unknown }) => void = () => {};
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { transcript: 1 } })
      .mockResolvedValueOnce({ ok: true, value: { transcript: 1, terminal: 1, sendIds: 1 } })
      .mockResolvedValue({ ok: true, value: { transcript: 1, terminal: 1, sendIds: 1, sessionCreate: 1 } });
    const api = new HostApi({ request, onEvent: (listener: typeof event) => { event = listener; return () => {}; } } as unknown as HostConnection);
    const changed = vi.fn();
    const stop = api.onFeaturesChanged(changed);
    expect((await api.features()).terminal).toBeUndefined();
    expect(await api.features()).toEqual({ transcript: 1 });
    event({ method: "sessions.changed" });
    expect(changed).not.toHaveBeenCalled();
    event({ method: "sync.capabilitiesChanged" });
    expect(changed).toHaveBeenCalledOnce();
    expect((await api.features()).terminal).toBe(1);
    api.resetConnection();
    expect(changed).toHaveBeenCalledTimes(2);
    expect((await api.features()).sessionCreate).toBe(1);
    stop();
    event({ method: "sync.capabilitiesChanged" });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([method]) => method === "sync.capabilities")).toHaveLength(3);
  });

  it("sends a draft's id only once the Mac's runtime takes it", async () => {
    let event: (value: { method: string }) => void = () => {};
    const request = vi.fn(async (method: string, _params?: unknown) => method === "sync.capabilities"
      ? { ok: true, value: request.mock.calls.filter(([called]) => called === "sync.capabilities").length > 1 ? { sendIds: 1 } : {} }
      : { ok: true, value: { status: "sent", queued: false } });
    const api = new HostApi({ request, onEvent: (listener: typeof event) => { event = listener; return () => {}; } } as unknown as HostConnection);
    await api.sendSession("tab-1", "one", [], "draft-1");
    expect(request.mock.calls.find(([method]) => method === "session.send")?.[1]).not.toHaveProperty("clientMessageId");
    event({ method: "sync.capabilitiesChanged" });
    await api.sendSession("tab-1", "two", [], "draft-2");
    expect(request.mock.calls.filter(([method]) => method === "session.send")[1]?.[1]).toMatchObject({ clientMessageId: "draft-2" });
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

  it("hears whether a TerminalX window runs there and the OS, and nothing of either from an older computer (PRO-359)", async () => {
    const answer = (value: unknown) => hostApi(vi.fn().mockResolvedValue({ ok: true, value })).describeHost();
    await expect(answer({ name: "build-01", hasWindow: false, platform: "linux" })).resolves.toEqual({ name: "build-01", hasWindow: false, platform: "linux" });
    await expect(answer({ name: "Paresh’s Mac mini" })).resolves.toEqual({ name: "Paresh’s Mac mini", hasWindow: null, platform: null });
    await expect(answer({ name: "x", hasWindow: "no", platform: "Linux\u0000; rm" })).resolves.toEqual({ name: "x", hasWindow: null, platform: null });
    await expect(hostApi(vi.fn().mockResolvedValue({ ok: false, refusal: { code: "forbidden", message: "no" } })).describeHost()).resolves.toBeNull();
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

  it("reads a tab's generated title, and summaries from older Macs without one", async () => {
    const tab = { id: "t", harness: "claude", status: "idle", title: "You are a worker in a run led" };
    const sessions = [
      { id: "new", title: "Tabs show the generated title", project: "TerminalX", worktree: "w", modified: "x", tabs: [{ ...tab, generatedTitle: "Tabs show the generated title" }] },
      { id: "old", title: "Older Mac", project: "TerminalX", worktree: "w", modified: "x", tabs: [tab] },
      { id: "none", title: "Nothing made yet", project: "TerminalX", worktree: "w", modified: "x", tabs: [{ ...tab, generatedTitle: null }] },
    ];
    const request = vi.fn(async (method: string) => method === "sync.capabilities"
      ? { ok: false, refusal: { code: "forbidden", message: "unsupported" } }
      : { ok: true, value: { sessions } });
    const summaries = await hostApi(request).summaries();
    expect(summaries?.map((summary) => [summary.id, summary.tabs[0].generatedTitle])).toEqual([
      ["new", "Tabs show the generated title"], ["old", undefined], ["none", null],
    ]);
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

describe("the terminal view's requests", () => {
  it("opens a tab's terminal on the Mac, and says why when it cannot", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: true, value: { opened: true } })
      .mockResolvedValueOnce({ ok: false, refusal: { code: "unavailable", message: "Wait for Codex to finish this turn, or interrupt it, before opening its terminal." } });
    const api = hostApi(request);
    await expect(api.openTerminal("worktree", "tab")).resolves.toEqual({ opened: true });
    expect(request).toHaveBeenLastCalledWith("terminal.open", { worktreeId: "worktree", tabId: "tab" });
    await expect(api.openTerminal("worktree", "tab")).resolves.toEqual({ opened: false, message: "Wait for Codex to finish this turn, or interrupt it, before opening its terminal." });
  });

  it("passes the Mac's reason when typing is refused", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: true, value: { accepted: true } })
      .mockResolvedValueOnce({ ok: false, refusal: { code: "unavailable", message: "Another mobile client or terminal instance owns this driver lease." } });
    const api = hostApi(request);
    await expect(api.queueInput("worktree", "tab", "ls\r")).resolves.toEqual({ accepted: true });
    expect(request).toHaveBeenLastCalledWith("steerLease.queueInput", { worktreeId: "worktree", tabId: "tab", text: "ls\r" });
    await expect(api.queueInput("worktree", "tab", "x")).resolves.toEqual({ accepted: false, message: "Another mobile client or terminal instance owns this driver lease." });
  });

  it("hands on the pane's size and the Mac ending the view, and drops a size that is not one", () => {
    let deliver: (value: unknown) => void = () => {};
    const subscribe = vi.fn((_method: string, _params: unknown, listener: (value: unknown) => void) => { deliver = listener; return () => {}; });
    const api = new HostApi({ request: vi.fn(), subscribe, onEvent: () => () => {} } as unknown as HostConnection);
    const packets: unknown[] = [];
    api.subscribeTerminal("worktree", "tab", (packet) => packets.push(packet));
    expect(subscribe).toHaveBeenCalledWith("terminal.subscribe", expect.objectContaining({ worktreeId: "worktree", tabId: "tab", attachMode: "observe" }), expect.any(Function));
    deliver({ subscriptionId: "s", type: "scrollback", serialized: "\x1b[31mhi", cols: 120, rows: 40 });
    deliver({ type: "resized", cols: 100, rows: 30 });
    deliver({ type: "resized", cols: 0, rows: 30 });
    deliver({ type: "data", chunk: "more" });
    deliver({ type: "error", error: { code: "unavailable", message: "Terminal output is unavailable." } });
    expect(packets).toEqual([
      { type: "scrollback", serialized: "\x1b[31mhi", cols: 120, rows: 40 },
      { type: "resized", cols: 100, rows: 30 },
      { type: "resized" },
      { type: "data", chunk: "more" },
      { type: "error", message: "Terminal output is unavailable." },
    ]);
  });
});

it("clears a reminder on the host and preserves a refusal", async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, value: null });
  await hostApi(request).markRead("session", "tab");
  expect(request).toHaveBeenCalledWith("session.markRead", { sessionId: "session", tabId: "tab" });
  request.mockResolvedValue({ ok: false, refusal: { message: "Device revoked" } });
  await expect(hostApi(request).markRead("session", "tab")).rejects.toThrow("Device revoked");
});

describe("answering an agent's question (#979)", () => {
  it("sends the answers as the desktop's card words them, and passes on the Mac's refusal", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { status: "answered" } });
    const api = hostApi(request);
    const answers = { "Which checks should run?": "Tests, Lint, format", "Which branch?": "release/1.0" };
    await expect(api.answerQuestions("session", "tab", "q1", answers)).resolves.toEqual({ answered: true });
    expect(request).toHaveBeenLastCalledWith("questions.respond", { sessionId: "session", tabId: "tab", requestId: "q1", answers });
    // Skip is an empty answer set.
    await api.answerQuestions("session", "tab", "q1", {});
    expect(request).toHaveBeenLastCalledWith("questions.respond", { sessionId: "session", tabId: "tab", requestId: "q1", answers: {} });

    // The Mac, or another device, answered first.
    request.mockResolvedValueOnce({ ok: false, refusal: { code: "unavailable", message: "internal: that question is no longer open" } });
    await expect(api.answerQuestions("session", "tab", "q1", answers)).resolves.toEqual({ answered: false, message: "internal: that question is no longer open" });
    request.mockResolvedValueOnce({ ok: true, value: {} });
    await expect(api.answerQuestions("session", "tab", "q1", answers)).resolves.toEqual({ answered: false, message: "The host did not answer this question." });
  });
});

// PRO-479: the bots, only from a Mac that names them; a person's answer goes as `bots.answer`.
describe("bots", () => {
  const overview = { bots: { revision: 1, bots: [{ id: "b1", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto" }], unreadable: 0 }, needsYou: { entries: [], counts: [] }, team: [] };
  const mac = (features: Record<string, number>, answer: (method: string, params: unknown) => unknown) => {
    const listeners = new Set<(event: { method: string }) => void>();
    const request = vi.fn(async (method: string, params?: unknown) => method === "sync.capabilities" ? { ok: true, value: features } : answer(method, params));
    const api = new HostApi({ request, onEvent: (listener: (event: { method: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); }, reassemblesFragments: async () => false } as unknown as HostConnection);
    return { api, request, emit: (method: string) => { for (const listener of listeners) listener({ method }); } };
  };

  it("reads nothing from a Mac that does not name bots", async () => {
    const { api, request } = mac({}, () => ({ ok: true, value: overview }));
    await expect(api.botsOverview()).resolves.toBeNull();
    await expect(api.answerBot("b1", 4, { answer: 0 }, "q1")).rejects.toThrow("Bots are off on this Mac");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["sync.capabilities"]);
  });

  it("reads the team and a bot's home, and refuses what it cannot read", async () => {
    const { api } = mac({ bots: 1 }, (method) => method === "bots.list" ? { ok: true, value: overview } : { ok: true, value: { bot: {} } });
    await expect(api.botsOverview()).resolves.toMatchObject({ bots: { bots: [{ id: "b1" }] } });
    await expect(api.botHome("b1")).rejects.toThrow("cannot read");
  });

  it("answers by index or in words, to the question shown, and passes the Mac's refusal on", async () => {
    const { api, request } = mac({ bots: 1 }, (method, params) => {
      if ((params as { number?: number }).number === 9) return { ok: false, refusal: { code: "refused", message: "Atlas no longer asks this on item #9." } };
      return method === "bots.answer" ? { ok: true, value: { item: null, delivery: { sent: true } } } : { ok: true, value: null };
    });
    await expect(api.answerBot("b1", 4, { answer: 1 }, "q1")).resolves.toEqual({ item: null, delivery: { sent: true } });
    await api.answerBot("b1", 4, { text: "File it" }, "q1");
    await expect(api.answerBot("b1", 9, { answer: 0 }, "q1")).rejects.toThrow("no longer asks");
    await api.pauseBot("b1");
    await api.resumeBot("b1");
    await api.pauseAllBots();
    expect(request.mock.calls.filter(([method]) => method !== "sync.capabilities")).toEqual([
      ["bots.answer", { id: "b1", number: 4, answer: 1, question: "q1" }],
      ["bots.answer", { id: "b1", number: 4, text: "File it", question: "q1" }],
      ["bots.answer", { id: "b1", number: 9, answer: 0, question: "q1" }],
      ["bots.pause", { id: "b1" }],
      ["bots.resume", { id: "b1" }],
      ["bots.pauseAll", {}],
    ]);
  });

  it("tells what is on screen to read again when the Mac says the bots changed", () => {
    const { api, emit } = mac({ bots: 1 }, () => ({ ok: true, value: null }));
    const heard = vi.fn();
    const stop = api.onBotsChanged(heard);
    emit("bots.changed");
    emit("sessions.changed");
    stop();
    emit("bots.changed");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("pins on the Mac (#1403)", () => {
  const mac = (features: Record<string, number>, answer: (method: string, params: unknown) => unknown) => vi.fn(async (method: string, params?: unknown) => method === "sync.capabilities"
    ? { ok: true, value: features }
    : answer(method, params));

  it("pins and unpins through a Mac that names pin, and says its refusal in its own words", async () => {
    const request = mac({ pin: 1 }, (_method, params) => (params as { sessionId?: string }).sessionId === "gone"
      ? { ok: false, refusal: { code: "internal", message: "This session is no longer on this Mac." } }
      : { ok: true, value: { sessionId: "s1", pinned: true } });
    const api = hostApi(request);
    await expect(api.pins()).resolves.toBe(true);
    await expect(api.setPinned("s1", true)).resolves.toEqual({ done: true });
    expect(request).toHaveBeenCalledWith("sessions.pin", { sessionId: "s1", pinned: true });
    await expect(api.setPinned("gone", false)).resolves.toEqual({ done: false, message: "This session is no longer on this Mac.", code: "internal" });
    await expect(api.setCloudPinned("org-1", "github.com/acme/web", true)).resolves.toEqual({ done: true });
    expect(request).toHaveBeenCalledWith("cloud.pin", { orgId: "org-1", identity: "github.com/acme/web", pinned: true });
  });

  it("reads the Mac's cloud pins, keeping only lists of names, and asks an older Mac for none", async () => {
    const request = mac({ pin: 1 }, () => ({ ok: true, value: { orgs: { "org-1": ["github.com/acme/web", 7, ""], "org-2": "not a list", "org-3": [] } } }));
    await expect(hostApi(request).cloudPins()).resolves.toEqual({ "org-1": ["github.com/acme/web"] });
    const refused = mac({ pin: 1 }, () => ({ ok: false, refusal: { code: "internal", message: "Not now." } }));
    await expect(hostApi(refused).cloudPins()).resolves.toBeNull();
    const older = mac({ closeTab: 1 }, () => { throw new Error("an older Mac is never asked"); });
    const api = hostApi(older);
    await expect(api.pins()).resolves.toBe(false);
    await expect(api.cloudPins()).resolves.toEqual({});
    expect(older.mock.calls.map(([method]) => method)).toEqual(["sync.capabilities"]);
  });
});
