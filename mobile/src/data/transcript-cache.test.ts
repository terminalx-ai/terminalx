import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { AgentEvent } from "@terminalx/portable/events";
import { clearTranscriptCaches, readCache, reclaimOrphanChunks, savedCursors, writeCache, type SyncCursor } from "./transcript-cache";
import { keepPrefetched } from "./prefetch";

const storage = vi.hoisted(() => new Map<string, string>());
/** Every key written, in order: what a save costs. */
const written = vi.hoisted(() => [] as string[]);
vi.mock("expo-crypto", () => ({ randomUUID: () => "client" }));
/** The next call of each named storage method fails, as a process stopped at that write would leave it. */
const failNext = vi.hoisted(() => new Set<string>());
const fail = (method: string) => { if (failNext.delete(method)) throw new Error(`${method} interrupted`); };
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => { fail("getItem"); return storage.get(key) ?? null; },
  setItem: async (key: string, value: string) => { fail("setItem"); written.push(key); storage.set(key, value); },
  removeItem: async (key: string) => { storage.delete(key); },
  getAllKeys: async () => { fail("getAllKeys"); return [...storage.keys()]; },
  multiRemove: async (keys: string[]) => { fail("multiRemove"); keys.forEach((key) => storage.delete(key)); },
  multiGet: async (keys: string[]) => { fail("multiGet"); return keys.map((key) => [key, storage.get(key) ?? null]); },
  multiSet: async (pairs: [string, string][]) => { fail("multiSet"); pairs.forEach(([key, value]) => { written.push(key); storage.set(key, value); }); },
} }));

const event = (seq: number, tab = "tab"): AgentEvent => ({ id: `event-${seq}`, seq, sessionId: "session", tabId: tab, harness: "codex", ts: "2026-11-19T00:00:00Z", payload: { type: "user_message", text: `turn ${seq}` } } as AgentEvent);
const range = (from: number, to: number, tab = "tab") => Array.from({ length: to - from + 1 }, (_, i) => event(from + i, tab));
const cursor = (offset: number): SyncCursor => ({ offset, digest: createHash("sha256").update(String(offset)).digest("hex") });
const bytesWritten = () => written.reduce((sum, key) => sum + (storage.get(key)?.length ?? 0), 0);

beforeEach(async () => { failNext.clear(); storage.clear(); await clearTranscriptCaches(); written.length = 0; });

describe("a transcript kept in chunks (#1283)", () => {
  it("writes only the last chunk and the index when a page adds events", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 480), cursor: cursor(480), hasEarlier: false });
    const whole = bytesWritten();
    written.length = 0;
    await writeCache("host", "session", "tab", { events: range(1, 482), cursor: cursor(482), hasEarlier: false }, undefined, 2);
    // One chunk of at most 50 events and the index, not 482 events.
    expect(written).toHaveLength(2);
    expect(bytesWritten()).toBeLessThan(whole / 5);
    expect(await readCache("host", "session", "tab")).toEqual({ events: range(1, 482), cursor: cursor(482), hasEarlier: false });
  });

  it("keeps the newest 500 as pages add up, and says there are earlier ones", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 20), cursor: cursor(20), hasEarlier: false });
    let events = range(1, 20);
    for (let end = 20; end < 1000; end += 70) {
      const added = range(end + 1, end + 70);
      events = [...events, ...added].slice(-500);
      await writeCache("host", "session", "tab", { events, cursor: cursor(end + 70), hasEarlier: end + 70 > 500 }, undefined, added.length);
    }
    const cache = await readCache("host", "session", "tab");
    expect(cache.events).toEqual(events);
    expect(cache.cursor).toEqual(cursor(1000));
    expect(cache.hasEarlier).toBe(true);
    // Dropped chunks are removed: what is kept stays near 500 events.
    const chunks = [...storage.keys()].filter((key) => key.startsWith("terminalx:transcript:v3c:"));
    expect(chunks.length).toBeLessThanOrEqual(11);
  });

  it("does not write when a poll found nothing new", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 20), cursor: cursor(20), hasEarlier: false });
    written.length = 0;
    await writeCache("host", "session", "tab", { events: range(1, 20), cursor: cursor(20), hasEarlier: false }, undefined, 0);
    expect(written).toEqual([]);
  });

  it("saves the whole transcript when the events before the new ones are not what it kept", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 100), cursor: cursor(100), hasEarlier: false });
    const other = [...range(1, 99), { ...event(100), id: "rewritten" }, event(101)];
    await writeCache("host", "session", "tab", { events: other, cursor: cursor(101), hasEarlier: false }, undefined, 1);
    expect((await readCache("host", "session", "tab")).events).toEqual(other);
  });

  it("reads an empty copy rather than a part when a chunk is lost or changed", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 120), cursor: cursor(120), hasEarlier: false });
    const chunk = [...storage.keys()].find((key) => key.startsWith("terminalx:transcript:v3c:"))!;
    storage.set(chunk, storage.get(chunk)!.replace("turn 1", "turn one"));
    expect(await readCache("host", "session", "tab")).toEqual({ events: [], hasEarlier: false });
    storage.delete(chunk);
    expect(await readCache("host", "session", "tab")).toEqual({ events: [], hasEarlier: false });
  });

  it("still reads a transcript saved whole by an earlier version, and replaces it on the next save", async () => {
    const data = JSON.stringify({ events: range(1, 30), cursor: cursor(30), hasEarlier: true });
    const v2 = "terminalx:transcript:v2:" + JSON.stringify(["host", "session", "tab"]);
    storage.set(v2, JSON.stringify({ schema: 2, data, checksum: createHash("sha256").update(data).digest("hex") }));
    expect(await readCache("host", "session", "tab")).toEqual({ events: range(1, 30), cursor: cursor(30), hasEarlier: true });
    await writeCache("host", "session", "tab", { events: range(1, 31), cursor: cursor(31), hasEarlier: true }, undefined, 1);
    expect(storage.has(v2)).toBe(false);
    expect(await readCache("host", "session", "tab")).toEqual({ events: range(1, 31), cursor: cursor(31), hasEarlier: true });
  });

  it("lists a Mac's checkpoints, newest saved first, and only that Mac's", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000); await writeCache("host", "s-old", "tab", { events: [], cursor: cursor(1), hasEarlier: false });
      vi.setSystemTime(2_000); await writeCache("host", "s-new", "tab", { events: [], cursor: cursor(2), hasEarlier: false });
      await writeCache("other", "s-other", "tab", { events: [], cursor: cursor(3), hasEarlier: false });
      await writeCache("host", "s-none", "tab", { events: [], hasEarlier: false });
    } finally { vi.useRealTimers(); }
    expect(await savedCursors("host", 10)).toEqual([
      { sessionId: "s-new", tabId: "tab", cursor: cursor(2) },
      { sessionId: "s-old", tabId: "tab", cursor: cursor(1) },
    ]);
    expect(await savedCursors("host", 1)).toHaveLength(1);
  });

  it("clears a forgotten Mac's chunks with its transcripts", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 120), cursor: cursor(120), hasEarlier: false });
    await writeCache("other", "session", "tab", { events: range(1, 10), cursor: cursor(10), hasEarlier: false });
    await clearTranscriptCaches("host");
    expect([...storage.keys()].some((key) => key.includes('"host"'))).toBe(false);
    expect((await readCache("other", "session", "tab")).events).toHaveLength(10);
  });
});

describe("keeping what a prefetch sent (#1283)", () => {
  const forward = (after: number, events: AgentEvent[]) => ({
    sessionId: "session", tabId: "tab", after: cursor(after),
    page: { events, cursor: cursor(after + events.length), reset: false, hasMore: false, hasEarlier: true },
  });

  it("adds a page from the phone's own checkpoint to its copy", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 20), cursor: cursor(20), hasEarlier: false });
    await keepPrefetched("host", forward(20, range(21, 25)));
    expect(await readCache("host", "session", "tab")).toEqual({ events: range(1, 25), cursor: cursor(25), hasEarlier: false });
  });

  it("leaves a copy whose checkpoint moved on since", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 22), cursor: cursor(22), hasEarlier: false });
    await keepPrefetched("host", forward(20, range(21, 25)));
    expect((await readCache("host", "session", "tab")).cursor).toEqual(cursor(22));
  });

  it("keeps the newest part as the copy of a conversation the phone had none of", async () => {
    await keepPrefetched("host", { sessionId: "session", tabId: "tab", page: { events: range(81, 100), cursor: cursor(100), reset: true, hasMore: false, hasEarlier: true } });
    expect(await readCache("host", "session", "tab")).toEqual({ events: range(81, 100), cursor: cursor(100), hasEarlier: true });
  });

  it("does not replace a copy with a checkpoint the prefetch did not name", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 300), cursor: cursor(300), hasEarlier: false });
    await keepPrefetched("host", { sessionId: "session", tabId: "tab", page: { events: range(281, 310), cursor: cursor(310), reset: true, hasMore: false, hasEarlier: true } });
    expect((await readCache("host", "session", "tab")).events).toHaveLength(300);
  });

  it("writes nothing for a Mac forgotten while the page was on its way", async () => {
    const epoch = 0;
    await clearTranscriptCaches("host");
    await keepPrefetched("host", { sessionId: "session", tabId: "tab", page: { events: range(1, 5), cursor: cursor(5), reset: true, hasMore: false, hasEarlier: false } }, epoch);
    expect(storage.size).toBe(0);
  });
});

describe("reclaiming chunks a save cut short left behind (#1340)", () => {
  const chunkKeys = (host = "host") => [...storage.keys()].filter((key) => key.startsWith("terminalx:transcript:v3c:") && key.includes(`["${host}"`)).sort();
  const indexKey = (session = "session", tab = "tab") => "terminalx:transcript:v3:" + JSON.stringify(["host", session, tab]);
  /** The ids the index on disk names. */
  const indexed = (session = "session", tab = "tab") => {
    const envelope = JSON.parse(storage.get(indexKey(session, tab))!);
    return (JSON.parse(envelope.data).chunks as { id: string }[]).map((c) => c.id).sort();
  };
  const idOf = (key: string) => JSON.parse(key.slice("terminalx:transcript:v3c:".length))[3] as string;
  /** A process that stopped and started again: nothing kept in memory. */
  const restart = async () => { vi.resetModules(); return await import("./transcript-cache"); };

  it("removes chunks written before an index that was never saved, and keeps the history that index replaced", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 120), cursor: cursor(120), hasEarlier: false });
    const before = chunkKeys();
    failNext.add("setItem");
    await expect(writeCache("host", "session", "tab", { events: range(1, 200), cursor: cursor(200), hasEarlier: false })).rejects.toThrow("setItem interrupted");
    expect(chunkKeys().length).toBeGreaterThan(before.length);
    const cache = await restart();
    expect(await cache.reclaimOrphanChunks("host")).toBe(4);
    expect(chunkKeys()).toEqual(before);
    expect(await cache.readCache("host", "session", "tab")).toEqual({ events: range(1, 120), cursor: cursor(120), hasEarlier: false });
  });

  it("removes the chunks an append wrote when its index write stopped", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 60), cursor: cursor(60), hasEarlier: false });
    failNext.add("setItem");
    await expect(writeCache("host", "session", "tab", { events: range(1, 75), cursor: cursor(75), hasEarlier: false }, undefined, 15)).rejects.toThrow();
    expect(await reclaimOrphanChunks("host")).toBe(1);
    expect(chunkKeys().map(idOf).sort()).toEqual(indexed());
    expect((await readCache("host", "session", "tab")).events).toEqual(range(1, 60));
    // The next append still builds on what is kept.
    await writeCache("host", "session", "tab", { events: range(1, 75), cursor: cursor(75), hasEarlier: false }, undefined, 15);
    expect(await readCache("host", "session", "tab")).toEqual({ events: range(1, 75), cursor: cursor(75), hasEarlier: false });
  });

  it("removes chunks an index dropped but a save stopped before removing", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 120), cursor: cursor(120), hasEarlier: false });
    const replaced = chunkKeys();
    failNext.add("multiRemove");
    await expect(writeCache("host", "session", "tab", { events: range(500, 560), cursor: cursor(560), hasEarlier: true })).rejects.toThrow("multiRemove interrupted");
    const cache = await restart();
    expect(await cache.reclaimOrphanChunks("host")).toBe(replaced.length);
    expect(chunkKeys().some((key) => replaced.includes(key))).toBe(false);
    expect(chunkKeys().map(idOf).sort()).toEqual(indexed());
    expect(await cache.readCache("host", "session", "tab")).toEqual({ events: range(500, 560), cursor: cursor(560), hasEarlier: true });
  });

  it("removes the chunks of a first save that never wrote its index", async () => {
    failNext.add("setItem");
    await expect(writeCache("host", "session", "tab", { events: range(1, 80), cursor: cursor(80), hasEarlier: false })).rejects.toThrow();
    expect(chunkKeys()).toHaveLength(2);
    expect(await (await restart()).reclaimOrphanChunks("host")).toBe(2);
    expect(storage.size).toBe(0);
  });

  it("removes the chunks under an index that cannot be read, which then reads empty and not as old history", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 120), cursor: cursor(120), hasEarlier: false });
    storage.set(indexKey(), storage.get(indexKey())!.slice(0, 40));
    const cache = await restart();
    expect(await cache.reclaimOrphanChunks("host")).toBe(3);
    expect(chunkKeys()).toEqual([]);
    expect(await cache.readCache("host", "session", "tab")).toEqual({ events: [], hasEarlier: false });
    await cache.writeCache("host", "session", "tab", { events: range(1, 10), cursor: cursor(10), hasEarlier: false });
    expect(await cache.readCache("host", "session", "tab")).toEqual({ events: range(1, 10), cursor: cursor(10), hasEarlier: false });
  });

  it("drops every chunk of a transcript whose index cannot be read when the whole transcript is saved again", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 120), cursor: cursor(120), hasEarlier: false });
    const envelope = JSON.parse(storage.get(indexKey())!);
    storage.set(indexKey(), JSON.stringify({ ...envelope, checksum: "0".repeat(64) }));
    const cache = await restart();
    await cache.writeCache("host", "session", "tab", { events: range(1, 30), cursor: cursor(30), hasEarlier: false });
    expect(chunkKeys().map(idOf).sort()).toEqual(indexed());
    expect(chunkKeys()).toHaveLength(1);
    expect(await cache.readCache("host", "session", "tab")).toEqual({ events: range(1, 30), cursor: cursor(30), hasEarlier: false });
  });

  it("keeps every indexed chunk of every transcript, and another Mac's", async () => {
    for (const session of ["a", "b", "c"]) await writeCache("host", session, "tab", { events: range(1, 130).map((e) => ({ ...e, sessionId: session })), cursor: cursor(130), hasEarlier: false });
    await writeCache("other", "session", "tab", { events: range(1, 10), cursor: cursor(10), hasEarlier: false });
    const orphan = "terminalx:transcript:v3c:" + JSON.stringify(["other", "session", "tab", "orphan"]);
    storage.set(orphan, "[]");
    const before = new Map(storage);
    expect(await reclaimOrphanChunks("host")).toBe(0);
    expect(new Map(storage)).toEqual(before);
    for (const session of ["a", "b", "c"]) expect((await readCache("host", session, "tab")).events).toHaveLength(130);
  });

  it("does not remove the chunks of a save queued before it", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 50), cursor: cursor(50), hasEarlier: false });
    const save = writeCache("host", "session", "tab", { events: range(1, 260), cursor: cursor(260), hasEarlier: false });
    const sweep = reclaimOrphanChunks("host");
    const append = writeCache("host", "session", "tab", { events: range(1, 270), cursor: cursor(270), hasEarlier: false }, undefined, 10);
    await Promise.all([save, sweep, append]);
    expect(await sweep).toBe(0);
    expect(chunkKeys().map(idOf).sort()).toEqual(indexed());
    expect(await readCache("host", "session", "tab")).toEqual({ events: range(1, 270), cursor: cursor(270), hasEarlier: false });
  });

  it("does nothing for a Mac forgotten since it was asked, and writes nothing back", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 120), cursor: cursor(120), hasEarlier: false });
    failNext.add("setItem");
    await expect(writeCache("host", "session", "tab", { events: range(1, 200), cursor: cursor(200), hasEarlier: false })).rejects.toThrow();
    const epoch = 0;
    await clearTranscriptCaches("host");
    expect(await reclaimOrphanChunks("host", epoch)).toBe(0);
    expect(storage.size).toBe(0);
  });

  it("removes nothing when the indexes cannot be read", async () => {
    await writeCache("host", "session", "tab", { events: range(1, 120), cursor: cursor(120), hasEarlier: false });
    const before = new Map(storage);
    const cache = await restart();
    failNext.add("multiGet");
    await expect(cache.reclaimOrphanChunks("host")).rejects.toThrow("multiGet interrupted");
    expect(new Map(storage)).toEqual(before);
    expect((await cache.readCache("host", "session", "tab")).events).toEqual(range(1, 120));
  });

  it("checks a bounded number of transcripts each pass, continuing where the last stopped", async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => `s${i}`);
    for (const session of sessions) {
      await writeCache("host", session, "tab", { events: [{ ...event(1), sessionId: session }], cursor: cursor(1), hasEarlier: false });
      storage.set("terminalx:transcript:v3c:" + JSON.stringify(["host", session, "tab", "orphan"]), "[]");
    }
    const orphans = () => chunkKeys().filter((key) => key.endsWith('"orphan"]')).length;
    expect(await reclaimOrphanChunks("host", undefined, 2)).toBe(2);
    expect(orphans()).toBe(3);
    expect(await reclaimOrphanChunks("host", undefined, 2)).toBe(2);
    expect(await reclaimOrphanChunks("host", undefined, 2)).toBe(1);
    expect(orphans()).toBe(0);
    for (const session of sessions) expect((await readCache("host", session, "tab")).events).toHaveLength(1);
  });
});
