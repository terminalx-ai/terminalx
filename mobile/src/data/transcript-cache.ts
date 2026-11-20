import AsyncStorage from "@react-native-async-storage/async-storage";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { AgentEvent } from "@terminalx/portable/events";

export interface SyncCursor { offset: number; digest: string }
export interface TranscriptCache { events: AgentEvent[]; cursor?: SyncCursor; hasEarlier: boolean }
export const emptyTranscript = (): TranscriptCache => ({ events: [], hasEarlier: false });
const prefix = "terminalx:transcript:v2:";
const key = (host: string, session: string, tab: string) => prefix + JSON.stringify([host, session, tab]);
const checksum = (value: string) => bytesToHex(sha256(utf8ToBytes(value)));
let cleanupCounter = 0;
let allHostsEpoch = 0;
const hostEpochs = new Map<string, number>();
export const cacheEpoch = (host: string) => Math.max(allHostsEpoch, hostEpochs.get(host) ?? 0);

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as AgentEvent;
  return typeof e.id === "string" && typeof e.sessionId === "string" && typeof e.tabId === "string" && typeof e.harness === "string" && Number.isSafeInteger(e.seq) && typeof e.ts === "string" && !!e.payload && typeof e.payload.type === "string";
}
export function isSyncCursor(value: unknown): value is SyncCursor {
  const c = value as SyncCursor | null;
  return !!c && Number.isSafeInteger(c.offset) && c.offset >= 0 && typeof c.digest === "string" && /^[a-f0-9]{64}$/.test(c.digest);
}
/**
 * A transcript is kept as an index and chunks of `CHUNK` events (#1283), so
 * a page that only adds events rewrites the last chunk and the small index,
 * not the whole conversation. Chunks are written under new keys before the
 * index that names them, and dropped after, so an index always names chunks
 * that are there, each checked against the checksum it records. A save cut
 * short between those writes leaves chunks no index names; a sweep on
 * connect removes them (#1340, `reclaimOrphanChunks`).
 */
const indexPrefix = "terminalx:transcript:v3:";
const chunkPrefix = "terminalx:transcript:v3c:";
const CHUNK = 50;
const LIMIT = 500;
const indexKey = (host: string, session: string, tab: string) => indexPrefix + JSON.stringify([host, session, tab]);
const chunkKey = (host: string, session: string, tab: string, id: string) => chunkPrefix + JSON.stringify([host, session, tab, id]);
interface ChunkRef { id: string; count: number; checksum: string }
interface TranscriptIndex { cursor?: SyncCursor; hasEarlier: boolean; chunks: ChunkRef[]; savedAt: number }
/** What was last written or read of each transcript: an append starts from it. */
interface Layout { index: TranscriptIndex; last: AgentEvent[]; lastId: string | null }
const layouts = new Map<string, Layout>();
/** Bumped by each write, so a read that raced one does not leave its older layout behind. */
const generations = new Map<string, number>();
let chunkCounter = 0;
const newChunkId = () => `${Date.now().toString(36)}-${(chunkCounter++).toString(36)}`;

function isChunkRef(value: unknown): value is ChunkRef {
  const c = value as ChunkRef | null;
  return !!c && typeof c.id === "string" && /^[a-z0-9-]{1,40}$/.test(c.id) && Number.isSafeInteger(c.count) && c.count > 0 && c.count <= CHUNK && typeof c.checksum === "string";
}

function readIndex(raw: string | null): TranscriptIndex | null {
  if (!raw) return null;
  const envelope = JSON.parse(raw);
  if (envelope?.schema !== 3 || typeof envelope.data !== "string" || checksum(envelope.data) !== envelope.checksum) return null;
  const index = JSON.parse(envelope.data) as TranscriptIndex;
  if (!Array.isArray(index.chunks) || !index.chunks.every(isChunkRef) || index.chunks.reduce((sum, c) => sum + c.count, 0) > LIMIT + CHUNK
    || (index.cursor !== undefined && !isSyncCursor(index.cursor)) || typeof index.hasEarlier !== "boolean" || typeof index.savedAt !== "number") return null;
  return index;
}

export async function readCache(host: string, session: string, tab: string): Promise<TranscriptCache> {
  const k = indexKey(host, session, tab);
  const generation = generations.get(k) ?? 0;
  try {
    const index = readIndex(await AsyncStorage.getItem(k));
    if (!index) return await readCacheV2(host, session, tab);
    const stored = index.chunks.length ? await AsyncStorage.multiGet(index.chunks.map((c) => chunkKey(host, session, tab, c.id))) : [];
    const chunks: AgentEvent[][] = [];
    for (const [i, ref] of index.chunks.entries()) {
      const raw = stored[i]?.[1];
      if (typeof raw !== "string" || checksum(raw) !== ref.checksum) return emptyTranscript();
      const events: unknown = JSON.parse(raw);
      if (!Array.isArray(events) || events.length !== ref.count || !events.every((e: unknown) => isAgentEvent(e) && e.sessionId === session && e.tabId === tab)) return emptyTranscript();
      chunks.push(events);
    }
    const events = chunks.flat();
    if ((generations.get(k) ?? 0) === generation) layouts.set(k, { index, last: chunks.at(-1) ?? [], lastId: events.at(-1)?.id ?? null });
    return { events: events.slice(-LIMIT), ...(index.cursor ? { cursor: index.cursor } : {}), hasEarlier: index.hasEarlier || events.length > LIMIT };
  } catch { return emptyTranscript(); }
}

/** A transcript saved before #1283, as one value; and before that, without a cursor. */
async function readCacheV2(host: string, session: string, tab: string): Promise<TranscriptCache> {
  const raw = await AsyncStorage.getItem(key(host, session, tab));
  if (!raw) {
    // Display the existing v1 cache immediately, but establish a fresh cursor.
    const legacy = JSON.parse(await AsyncStorage.getItem(`terminalx:transcript:${host}:${session}:${tab}`) ?? "null");
    return Array.isArray(legacy) && legacy.every((e) => isAgentEvent(e) && e.sessionId === session && e.tabId === tab)
      ? { events: legacy.slice(-LIMIT), hasEarlier: true } : emptyTranscript();
  }
  const envelope = JSON.parse(raw);
  if (envelope.schema !== 2 || typeof envelope.data !== "string" || checksum(envelope.data) !== envelope.checksum) return emptyTranscript();
  const data = JSON.parse(envelope.data);
  if (!Array.isArray(data.events) || data.events.length > LIMIT || !data.events.every((e: unknown) => isAgentEvent(e) && e.sessionId === session && e.tabId === tab) || (data.cursor !== undefined && !isSyncCursor(data.cursor)) || typeof data.hasEarlier !== "boolean") return emptyTranscript();
  return data;
}

/** The checkpoints of the transcripts kept for a Mac, newest saved first (#1283): a prefetch continues from them. */
export async function savedCursors(host: string, limit: number): Promise<{ sessionId: string; tabId: string; cursor: SyncCursor }[]> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(indexPrefix));
    const found: { sessionId: string; tabId: string; cursor: SyncCursor; savedAt: number }[] = [];
    for (const [k, raw] of await AsyncStorage.multiGet(keys)) {
      try {
        const [owner, sessionId, tabId] = JSON.parse(k.slice(indexPrefix.length)) as unknown[];
        const index = readIndex(raw);
        if (owner === host && typeof sessionId === "string" && typeof tabId === "string" && index?.cursor) found.push({ sessionId, tabId, cursor: index.cursor, savedAt: index.savedAt });
      } catch { /* A broken entry is read again, and replaced, when its conversation opens. */ }
    }
    return found.sort((left, right) => right.savedAt - left.savedAt).slice(0, limit).map(({ sessionId, tabId, cursor }) => ({ sessionId, tabId, cursor }));
  } catch { return []; }
}

const sameCursor = (left?: SyncCursor, right?: SyncCursor) => left?.offset === right?.offset && left?.digest === right?.digest;

// Serialize writes and deletion, so an in-flight save cannot resurrect an
// unpaired host. An index names its chunks and checkpoint together.
let writes: Promise<unknown> = Promise.resolve();
/**
 * Saves a transcript. `appended`: the last that many of `value.events` are
 * new, and the rest are what was last saved or read here (#1283). Then only
 * the last chunk and the index are written; otherwise, or when that does not
 * hold after all, the whole transcript is.
 */
export function writeCache(host: string, session: string, tab: string, value: TranscriptCache, epoch = cacheEpoch(host), appended?: number): Promise<void> {
  const k = indexKey(host, session, tab);
  const operation = writes.catch(() => undefined).then(async () => {
    if (epoch !== cacheEpoch(host)) return;
    generations.set(k, (generations.get(k) ?? 0) + 1);
    const hasEarlier = value.hasEarlier || value.events.length > LIMIT;
    const layout = layouts.get(k);
    const before = appended === undefined ? -1 : value.events.length - appended;
    if (layout && appended !== undefined && appended < LIMIT && before >= 0 && (value.events[before - 1]?.id ?? null) === layout.lastId
      && (before > 0 || layout.index.chunks.length === 0)) {
      if (appended === 0 && sameCursor(layout.index.cursor, value.cursor) && layout.index.hasEarlier === hasEarlier) return;
      await appendChunks(host, session, tab, layout, value.events.slice(before), value.cursor, hasEarlier);
      return;
    }
    await replaceChunks(host, session, tab, value.events.slice(-LIMIT), value.cursor, hasEarlier);
  });
  writes = operation;
  return operation;
}

async function saveIndex(host: string, session: string, tab: string, index: TranscriptIndex, written: [string, string][], dropped: string[], last: AgentEvent[], lastId: string | null): Promise<void> {
  const k = indexKey(host, session, tab);
  if (written.length) await AsyncStorage.multiSet(written);
  const data = JSON.stringify(index);
  await AsyncStorage.setItem(k, JSON.stringify({ schema: 3, data, checksum: checksum(data) }));
  layouts.set(k, { index, last, lastId });
  if (dropped.length) await AsyncStorage.multiRemove(dropped.map((id) => chunkKey(host, session, tab, id)));
}

function chunkOf(events: AgentEvent[], written: [string, string][], host: string, session: string, tab: string): ChunkRef {
  const id = newChunkId();
  const raw = JSON.stringify(events);
  written.push([chunkKey(host, session, tab, id), raw]);
  return { id, count: events.length, checksum: checksum(raw) };
}

async function appendChunks(host: string, session: string, tab: string, layout: Layout, added: AgentEvent[], cursor: SyncCursor | undefined, hasEarlier: boolean): Promise<void> {
  const chunks = [...layout.index.chunks];
  const written: [string, string][] = [];
  const dropped: string[] = [];
  let last = layout.last;
  let rest = added;
  const open = chunks.at(-1);
  if (open && last.length < CHUNK && rest.length) {
    last = [...last, ...rest.slice(0, CHUNK - last.length)];
    rest = rest.slice(CHUNK - layout.last.length);
    dropped.push(open.id);
    chunks[chunks.length - 1] = chunkOf(last, written, host, session, tab);
  }
  for (let at = 0; at < rest.length; at += CHUNK) {
    last = rest.slice(at, at + CHUNK);
    chunks.push(chunkOf(last, written, host, session, tab));
  }
  let total = chunks.reduce((sum, c) => sum + c.count, 0);
  while (chunks.length > 1 && total - chunks[0].count >= LIMIT) {
    const first = chunks.shift()!;
    total -= first.count;
    dropped.push(first.id);
  }
  await saveIndex(host, session, tab, { ...(cursor ? { cursor } : {}), hasEarlier: hasEarlier || total > LIMIT, chunks, savedAt: Date.now() }, written, dropped, last, added.at(-1)?.id ?? layout.lastId);
}

async function replaceChunks(host: string, session: string, tab: string, events: AgentEvent[], cursor: SyncCursor | undefined, hasEarlier: boolean): Promise<void> {
  const k = indexKey(host, session, tab);
  let previous = layouts.get(k)?.index.chunks.map((c) => c.id);
  // An index that is there but cannot be read no longer names its chunks
  // (#1340): every chunk kept for this transcript is found by its key instead.
  let unreadable = false;
  if (!previous) {
    try {
      const raw = await AsyncStorage.getItem(k);
      try { previous = readIndex(raw)?.chunks.map((c) => c.id); unreadable = raw !== null && !previous; } catch { unreadable = true; }
    } catch { /* Storage failed: nothing known to drop; a sweep reclaims it later. */ }
  }
  const written: [string, string][] = [];
  const chunks: ChunkRef[] = [];
  for (let at = 0; at < events.length; at += CHUNK) chunks.push(chunkOf(events.slice(at, at + CHUNK), written, host, session, tab));
  const last = events.length ? events.slice(Math.floor((events.length - 1) / CHUNK) * CHUNK) : [];
  if (unreadable) {
    const kept = new Set(chunks.map((c) => c.id));
    previous = (await AsyncStorage.getAllKeys()).flatMap((stored) => {
      const id = chunkIdOf(stored, host, session, tab);
      return id !== null && !kept.has(id) ? [id] : [];
    });
  }
  await saveIndex(host, session, tab, { ...(cursor ? { cursor } : {}), hasEarlier, chunks, savedAt: Date.now() }, written, previous ?? [], last, events.at(-1)?.id ?? null);
  await AsyncStorage.multiRemove([key(host, session, tab), `terminalx:transcript:${host}:${session}:${tab}`]);
}

/** The chunk id a stored key names for this transcript, or null when it is another key. */
function chunkIdOf(stored: string, host: string, session: string, tab: string): string | null {
  if (!stored.startsWith(chunkPrefix)) return null;
  try {
    const parts: unknown = JSON.parse(stored.slice(chunkPrefix.length));
    return Array.isArray(parts) && parts.length === 4 && parts[0] === host && parts[1] === session && parts[2] === tab && typeof parts[3] === "string" ? parts[3] : null;
  } catch { return null; }
}

/** Transcripts whose chunks one sweep checks, so a phone holding many does each pass in bounded work. */
export const SWEEP_TRANSCRIPTS = 64;
/** Where the last sweep of each Mac stopped: the next continues after it. */
const sweptTo = new Map<string, string>();

/**
 * Removes a Mac's chunks that no index names (#1340). A save writes its
 * chunks before the index that names them and drops replaced ones after, so
 * a save cut short between those writes leaves chunks nothing reads again.
 * A chunk named by a readable index, or by the last index this process
 * committed, is kept; one under an index that cannot be read is never read
 * either (the transcript reads empty), so it goes. Runs in the same queue as
 * saves and host removal: a save's chunks are never seen before their index,
 * and a forgotten Mac's are already gone. Checks at most `budget`
 * transcripts, continuing where the last pass stopped. Returns how many
 * chunks it removed.
 */
export function reclaimOrphanChunks(host: string, epoch = cacheEpoch(host), budget = SWEEP_TRANSCRIPTS): Promise<number> {
  const operation = writes.catch(() => undefined).then(async () => {
    if (epoch !== cacheEpoch(host)) return 0;
    const byTranscript = new Map<string, { session: string; tab: string; chunks: [string, string][] }>();
    for (const stored of await AsyncStorage.getAllKeys()) {
      if (!stored.startsWith(chunkPrefix)) continue;
      let parts: unknown;
      try { parts = JSON.parse(stored.slice(chunkPrefix.length)); } catch { continue; }
      if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== host || typeof parts[1] !== "string" || typeof parts[2] !== "string" || typeof parts[3] !== "string") continue;
      const k = indexKey(host, parts[1], parts[2]);
      const entry = byTranscript.get(k) ?? { session: parts[1], tab: parts[2], chunks: [] };
      entry.chunks.push([parts[3], stored]);
      byTranscript.set(k, entry);
    }
    const all = [...byTranscript.keys()].sort();
    const after = sweptTo.get(host);
    const start = after === undefined ? 0 : all.findIndex((k) => k > after);
    const order = start <= 0 ? all : [...all.slice(start), ...all.slice(0, start)];
    const picked = order.slice(0, Math.max(0, budget));
    if (!picked.length) return 0;
    // A read that fails leaves everything: only a missing or unreadable index lets chunks go.
    const indexes = await AsyncStorage.multiGet(picked);
    const orphaned: string[] = [];
    for (const [i, k] of picked.entries()) {
      const raw = indexes[i]?.[1] ?? null;
      let live: Set<string>;
      try { live = new Set(readIndex(raw)?.chunks.map((c) => c.id) ?? []); } catch { live = new Set(); }
      for (const c of layouts.get(k)?.index.chunks ?? []) live.add(c.id);
      for (const [id, stored] of byTranscript.get(k)!.chunks) if (!live.has(id)) orphaned.push(stored);
    }
    if (orphaned.length) await AsyncStorage.multiRemove(orphaned);
    sweptTo.set(host, picked.at(-1)!);
    return orphaned.length;
  });
  writes = operation;
  return operation;
}

export function clearTranscriptCaches(host?: string): Promise<void> {
  if (host) { hostEpochs.set(host, ++cleanupCounter); sweptTo.delete(host); }
  else { allHostsEpoch = ++cleanupCounter; hostEpochs.clear(); sweptTo.clear(); }
  for (const k of [...layouts.keys()]) {
    try { if (!host || JSON.parse(k.slice(indexPrefix.length))[0] === host) layouts.delete(k); } catch { layouts.delete(k); }
  }
  const operation = writes.catch(() => undefined).then(async () => {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter((k) => {
      for (const scoped of [indexPrefix, chunkPrefix, prefix, savedPrefix]) if (k.startsWith(scoped)) {
        try { return !host || JSON.parse(k.slice(scoped.length))[0] === host; } catch { return true; }
      }
      return k.startsWith(host ? `terminalx:transcript:${host}:` : "terminalx:transcript:") || k.startsWith(host ? `terminalx:draft:${host}:` : "terminalx:draft:");
    }));
  });
  writes = operation;
  return operation;
}

/**
 * What a screen showed last time, kept per Mac so it shows again at once on
 * the next open, before the phone has connected (#983): the session list,
 * what the Mac offers, a tab's model and mode. Cleared with the transcripts,
 * and written in the same order with them, so a forgotten Mac's are not
 * written back by a save still on its way.
 */
const savedPrefix = "terminalx:saved:v1:";
const savedKey = (host: string, name: string) => savedPrefix + JSON.stringify([host, name]);

export async function readSaved<T>(host: string, name: string, valid: (value: unknown) => value is T): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(savedKey(host, name));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : null;
  } catch { return null; }
}

/**
 * Saves a value for a Mac. `epoch` is `cacheEpoch(host)` taken before the request that read the value,
 * so a Mac forgotten (or a sign-out) while that request was under way is not written back (#983).
 */
export function writeSaved(host: string, name: string, value: unknown, epoch: number): Promise<void> {
  const data = JSON.stringify(value);
  const operation = writes.catch(() => undefined).then(async () => {
    if (epoch !== cacheEpoch(host)) return;
    await AsyncStorage.setItem(savedKey(host, name), data);
  });
  writes = operation;
  return operation.catch(() => undefined);
}
