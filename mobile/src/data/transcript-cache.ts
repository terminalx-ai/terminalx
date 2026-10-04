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
export async function readCache(host: string, session: string, tab: string): Promise<TranscriptCache> {
  try {
    const raw = await AsyncStorage.getItem(key(host, session, tab));
    if (!raw) {
      // Display the existing v1 cache immediately, but establish a fresh cursor.
      const legacy = JSON.parse(await AsyncStorage.getItem(`terminalx:transcript:${host}:${session}:${tab}`) ?? "null");
      return Array.isArray(legacy) && legacy.every((e) => isAgentEvent(e) && e.sessionId === session && e.tabId === tab)
        ? { events: legacy.slice(-500), hasEarlier: true } : emptyTranscript();
    }
    const envelope = JSON.parse(raw);
    if (envelope.schema !== 2 || typeof envelope.data !== "string" || checksum(envelope.data) !== envelope.checksum) return emptyTranscript();
    const data = JSON.parse(envelope.data);
    if (!Array.isArray(data.events) || data.events.length > 500 || !data.events.every((e: unknown) => isAgentEvent(e) && e.sessionId === session && e.tabId === tab) || (data.cursor !== undefined && !isSyncCursor(data.cursor)) || typeof data.hasEarlier !== "boolean") return emptyTranscript();
    return data;
  } catch { return emptyTranscript(); }
}

// Serialize writes and deletion, so an in-flight save cannot resurrect an
// unpaired host. A record contains both data and checkpoint atomically.
let writes: Promise<unknown> = Promise.resolve();
export function writeCache(host: string, session: string, tab: string, value: TranscriptCache, epoch = cacheEpoch(host)): Promise<void> {
  const events = value.events.slice(-500);
  const data = JSON.stringify({ ...value, events, hasEarlier: value.hasEarlier || value.events.length > events.length });
  const operation = writes.catch(() => undefined).then(async () => {
    if (epoch !== cacheEpoch(host)) return;
    await AsyncStorage.setItem(key(host, session, tab), JSON.stringify({ schema: 2, data, checksum: checksum(data) }));
    await AsyncStorage.removeItem(`terminalx:transcript:${host}:${session}:${tab}`);
  });
  writes = operation;
  return operation;
}

export function clearTranscriptCaches(host?: string): Promise<void> {
  if (host) hostEpochs.set(host, ++cleanupCounter);
  else { allHostsEpoch = ++cleanupCounter; hostEpochs.clear(); }
  const operation = writes.catch(() => undefined).then(async () => {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter((k) => {
      if (k.startsWith(prefix)) {
        try { return !host || JSON.parse(k.slice(prefix.length))[0] === host; } catch { return true; }
      }
      return k.startsWith(host ? `terminalx:transcript:${host}:` : "terminalx:transcript:") || k.startsWith(host ? `terminalx:draft:${host}:` : "terminalx:draft:");
    }));
  });
  writes = operation;
  return operation;
}
