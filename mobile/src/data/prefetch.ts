import { mergeEvents, type HostApi, type Prefetched } from "./host-api";
import { cacheEpoch, readCache, reclaimOrphanChunks, savedCursors, writeCache } from "./transcript-cache";
import { appendedCount, transcriptOpen } from "./transcript-sync";

/** The checkpoints a phone names: the Mac takes at most 256. */
const KNOWN_LIMIT = 128;

/** Asks the connected Mac to start sending, from the checkpoints this phone keeps for it. */
export async function startPrefetch(api: HostApi, host: string): Promise<boolean> {
  const known = await savedCursors(host, KNOWN_LIMIT);
  named.set(host, new Set(known.map(({ sessionId, tabId }) => JSON.stringify([sessionId, tabId]))));
  // Chunks left by a save cut short go before the pages that follow are kept (#1340).
  void reclaimOrphanChunks(host).catch(() => undefined);
  return api.prefetch(true, known);
}

/** The conversations whose checkpoints the last prefetch named, by Mac. */
const named = new Map<string, Set<string>>();

/** Stops a prefetch under way; a Mac that never started one is not asked. */
export async function stopPrefetch(api: HostApi): Promise<void> {
  await api.prefetch(false).catch(() => undefined);
}

/**
 * Keeps what a prefetch sent (#1283): a page from the phone's own checkpoint
 * is added to its copy, and the newest part, sent when the phone kept none,
 * becomes its copy. A conversation open on screen reads for itself, and a
 * page from a checkpoint the phone no longer holds is left: it opens as it
 * would have without one. Saved in the order received, one at a time.
 */
let applying: Promise<unknown> = Promise.resolve();
export function keepPrefetched(host: string, prefetched: Prefetched, epoch = cacheEpoch(host)): Promise<void> {
  const operation = applying.catch(() => undefined).then(async () => {
    const { sessionId, tabId, after, page } = prefetched;
    if (epoch !== cacheEpoch(host) || transcriptOpen(host, sessionId, tabId)) return;
    const cached = await readCache(host, sessionId, tabId);
    if (epoch !== cacheEpoch(host) || transcriptOpen(host, sessionId, tabId)) return;
    if (page.reset) {
      // The newest part replaces a copy whose checkpoint the Mac found stale,
      // or a copy without one; not a copy the phone did not name, which may hold more.
      if (cached.cursor && !named.get(host)?.has(JSON.stringify([sessionId, tabId]))) return;
      await writeCache(host, sessionId, tabId, { events: page.events, cursor: page.cursor, hasEarlier: page.hasEarlier }, epoch);
      return;
    }
    if (!after || cached.cursor?.offset !== after.offset || cached.cursor.digest !== after.digest) return;
    const appended = appendedCount(cached.events, page.events);
    const merged = mergeEvents(cached.events, page.events);
    await writeCache(host, sessionId, tabId, { events: merged.slice(-500), cursor: page.cursor, hasEarlier: cached.hasEarlier || merged.length > 500 }, epoch, appended);
  });
  applying = operation;
  return operation.catch(() => undefined);
}
