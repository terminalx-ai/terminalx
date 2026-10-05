import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { AgentEvent } from "@terminalx/portable/events";
import type { HostConnection } from "../transport/connection";
import { HostApi } from "./host-api";
import { cacheEpoch, clearTranscriptCaches, readCache, writeCache, type SyncCursor, type TranscriptCache } from "./transcript-cache";
import { watchTranscript } from "./transcript-sync";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-crypto", () => ({ randomUUID: () => "client" }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
  removeItem: async (key: string) => { storage.delete(key); },
  getAllKeys: async () => [...storage.keys()],
  multiRemove: async (keys: string[]) => { keys.forEach((key) => storage.delete(key)); },
} }));
const event = (seq: number, text = `synthetic ${seq}`): AgentEvent => ({ id: `event-${seq}`, seq, sessionId: "session", tabId: "tab", harness: "codex", ts: "2026-01-01T00:00:00Z", payload: { type: "user_message", text } } as AgentEvent);
const stops: (() => void)[] = [];
const settle = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };

function host(initial = 20, supported = true) {
  let events = Array.from({ length: initial }, (_, i) => event(i + 1));
  let listener: (event: unknown) => void = () => {};
  let ready = () => {};
  let failOffset = -1;
  let afterPage: (() => void) | undefined;
  const digest = (offset: number) => createHash("sha256").update(JSON.stringify(events.slice(0, offset))).digest("hex");
  const request = vi.fn(async (method: string, params: any = {}): Promise<any> => {
    if (method === "sync.capabilities") return { ok: true, value: supported ? { transcript: 1, conditionalLists: 1 } : {} };
    if (method === "session.tail") return { ok: true, value: { events: events.slice(-20), hasMore: events.length > 20 } };
    if (method !== "session.sync") throw new Error(method);
    if (params.cursor?.offset === failOffset) throw new Error("interrupted");
    const c = params.cursor as SyncCursor | undefined;
    const reset = !c || c.offset > events.length || digest(c.offset) !== c.digest;
    const start = reset ? Math.max(0, events.length - 20) : c!.offset;
    const end = Math.min(events.length, start + 500);
    const value = { reset, events: events.slice(start, end), cursor: { offset: end, digest: digest(end) }, hasMore: end < events.length, hasEarlier: start > 0 };
    const callback = afterPage; afterPage = undefined; callback?.();
    return { ok: true, value };
  });
  const subscribe = vi.fn((_method, _params, callback) => { listener = callback; ready = () => callback({ subscriptionId: "subscription" }); return () => { listener = () => {}; }; });
  const connection = { request, subscribe } as unknown as HostConnection;
  let api = new HostApi(connection);
  const updates: { state: TranscriptCache; replace: boolean }[] = [];
  const error = vi.fn();
  const start = (connected = true, hostId = "host") => {
    const stop = watchTranscript(api, hostId, "session", "tab", connected, (state, replace) => updates.push({ state, replace }), error);
    stops.push(stop); return stop;
  };
  return { request, subscribe, updates, error, start, restartApi: () => { api = new HostApi(connection); }, ready: () => ready(), live: (e: AgentEvent) => listener({ event: e }), append: (count: number) => { events.push(...Array.from({ length: count }, (_, i) => event(events.length + i + 1))); }, edit: () => { events[events.length - 1] = event(events.length, "reconciled"); }, fail: (offset: number) => { failOffset = offset; }, race: (callback: () => void) => { afterPage = callback; } };
}

beforeEach(() => { storage.clear(); vi.useFakeTimers(); });
afterEach(() => { stops.splice(0).forEach((stop) => stop()); vi.useRealTimers(); });

describe("incremental transcript sync", () => {
  it("cold loads, renders cache offline, and sends only a checkpoint on unchanged restart", async () => {
    const h = host(100); const stop = h.start(); await settle(); stop();
    expect(h.updates.at(-1)!.state.events).toHaveLength(20);
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["sync.capabilities", "session.sync"]);
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    h.request.mockClear();
    const offline = h.start(false); await settle(); offline();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.updates.at(-1)!.state.events[0].seq).toBe(81);
    h.start(); await settle();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][1].cursor.offset).toBe(100);
    expect(h.updates.at(-1)!.state.cursor?.offset).toBe(100);
    stops.splice(0).forEach((stop) => stop());
    h.restartApi(); h.request.mockClear(); h.start(); await settle();
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["sync.capabilities", "session.sync"]);
    expect(h.request.mock.calls[1][1].cursor.offset).toBe(100);
  });

  it("drains a gap larger than the old 5000-event cap and resumes interrupted pages", async () => {
    const h = host(20); let stop = h.start(); await settle(); stop();
    h.append(6100); h.fail(520); h.request.mockClear();
    stop = h.start(); await settle(); stop();
    expect(h.error).toHaveBeenCalledTimes(1);
    expect((await readCache("host", "session", "tab")).cursor?.offset).toBe(520);
    h.fail(-1); h.request.mockClear(); h.start(); await settle();
    const offsets = h.request.mock.calls.filter(([m]) => m === "session.sync").map(([, p]) => p.cursor.offset);
    expect(offsets).toEqual([520, 1020, 1520, 2020, 2520, 3020, 3520, 4020, 4520, 5020, 5520, 6020]);
    const cache = await readCache("host", "session", "tab");
    expect(cache.cursor?.offset).toBe(6120);
    expect(cache.events).toHaveLength(500);
    expect(cache.events.at(-1)?.seq).toBe(6120);
    expect(cache.hasEarlier).toBe(true);
  });

  it("repairs subscription setup races and duplicate/out-of-order delivery without advancing from live seq", async () => {
    const h = host();
    h.race(() => h.append(2)); // Snapshot produced before subscription acknowledgement.
    h.start(); await settle();
    expect(h.updates.at(-1)!.state.cursor?.offset).toBe(20);
    h.ready(); await vi.advanceTimersByTimeAsync(100); await settle();
    expect(h.updates.at(-1)!.state.cursor?.offset).toBe(22);
    h.append(1);
    h.live(event(999999)); h.live(event(22)); h.live(event(23)); h.live(event(22));
    await vi.advanceTimersByTimeAsync(100); await settle();
    const cache = await readCache("host", "session", "tab");
    expect(cache.cursor?.offset).toBe(23);
    expect(cache.events.map((e) => e.seq)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it("replaces stale same-sequence content and clears deleted conversations", async () => {
    const h = host(); const stop = h.start(); await settle(); stop();
    h.edit(); const stop2 = h.start(); await settle(); stop2();
    expect(h.updates.at(-1)!.replace).toBe(true);
    expect(h.updates.at(-1)!.state.events.at(-1)!.payload).toMatchObject({ text: "reconciled" });
    h.request.mockResolvedValueOnce({ ok: true, value: { deleted: true } });
    h.start(); await settle();
    expect((await readCache("host", "session", "tab")).events).toEqual([]);
  });

  it("continues catch-up when events arrive while a page is being read", async () => {
    const h = host(); const stop = h.start(); await settle(); stop();
    h.append(600);
    h.race(() => { h.append(1); h.live(event(621)); });
    h.start(); await settle();
    expect((await readCache("host", "session", "tab")).cursor?.offset).toBe(621);
    expect(h.updates.at(-1)!.state.events.at(-1)?.seq).toBe(621);
  });

  it("retries failed capability negotiation and ignores late results after navigation", async () => {
    const h = host();
    h.request.mockRejectedValueOnce(new Error("offline"));
    h.start(); await settle();
    expect(h.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_100); await settle();
    expect((await readCache("host", "session", "tab")).cursor?.offset).toBe(20);
    stops.splice(0).forEach((stop) => stop());
    let resolve!: (value: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const stop = h.start(); await settle(); stop();
    const count = h.updates.length;
    resolve({ ok: true, value: { deleted: true } }); await settle();
    expect(h.updates).toHaveLength(count);
    expect((await readCache("host", "session", "tab")).cursor?.offset).toBe(20);
  });

  it("uses only the supported bounded-tail fields on old hosts", async () => {
    const h = host(100, false); h.start(); await settle();
    expect(h.request.mock.calls.map(([m]) => m)).toEqual(["sync.capabilities", "session.tail"]);
    expect(h.request.mock.calls[1][1]).toEqual({ sessionId: "session", tabId: "tab", limit: 20 });
    expect((await readCache("host", "session", "tab")).cursor).toBeUndefined();
  });

  it("merges an overlapping old-host catch-up but replaces an unverified cache on reconnect", async () => {
    const h = host(100, false); const stop = h.start(); await settle();
    expect(h.updates.at(-1)!.replace).toBe(true);
    // Live envelopes do not decide whether authoritative history was rewritten.
    h.live({ ...event(100), id: "live-100" });
    h.append(2); h.ready(); await vi.advanceTimersByTimeAsync(100); await settle();
    expect(h.updates.at(-1)!.replace).toBe(false);
    expect(h.updates.at(-1)!.state.events.at(-1)?.seq).toBe(102);
    stop(); h.start(); await settle();
    expect(h.updates.at(-1)!.replace).toBe(true);
  });

  it.each(["changed overlap", "missing overlap"])("replaces an old-host catch-up with %s", async (kind) => {
    const h = host(100, false); h.start(); await settle();
    if (kind === "changed overlap") h.edit();
    else h.append(20);
    h.ready(); await vi.advanceTimersByTimeAsync(100); await settle();
    expect(h.updates.at(-1)!.replace).toBe(true);
    expect(h.updates.at(-1)!.state.events.at(-1)?.seq).toBe(kind === "changed overlap" ? 100 : 120);
  });

  it("does not advance the checkpoint on a malformed or non-contiguous page", async () => {
    const h = host(); const stop = h.start(); await settle(); stop();
    const original = await readCache("host", "session", "tab");
    h.request.mockResolvedValueOnce({ ok: true, value: { events: [event(22)], cursor: { offset: 22, digest: "a".repeat(64) }, reset: false, hasMore: false, hasEarlier: true } });
    h.start(); await settle();
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(await readCache("host", "session", "tab")).toEqual(original);
  });

  it("isolates hosts/tabs and rejects corrupt cache/checkpoints with a bounded cold sync", async () => {
    const h = host(100); const stop = h.start(); await settle(); stop();
    expect((await readCache("other", "session", "tab")).events).toEqual([]);
    expect((await readCache("host", "session", "other")).events).toEqual([]);
    const key = [...storage.keys()][0];
    storage.set(key, storage.get(key)!.replace('synthetic', 'corrupted'));
    expect((await readCache("host", "session", "tab")).cursor).toBeUndefined();
    h.start(); await settle();
    expect(h.updates.at(-1)!.state.events).toHaveLength(20);
    expect(h.updates.at(-1)!.replace).toBe(true);
  });

  it("unpair/sign-out clear scoped data and prevent late writes from resurrecting it", async () => {
    const value = { events: [event(1)], hasEarlier: false };
    await writeCache("host", "session", "tab", value);
    await writeCache("other", "session", "tab", value);
    const epoch = cacheEpoch("host");
    await clearTranscriptCaches("host");
    await writeCache("host", "session", "tab", value, epoch);
    expect((await readCache("host", "session", "tab")).events).toEqual([]);
    expect((await readCache("other", "session", "tab")).events).toHaveLength(1);
    await clearTranscriptCaches(); expect(storage.size).toBe(0);
  });
});
