import type { AgentEvent } from "@terminalx/portable/events";
import { mergeEvents, type HostApi } from "./host-api";
import { cacheEpoch, emptyTranscript, readCache, writeCache, type TranscriptCache } from "./transcript-cache";

/** Subscribe before reading; live delivery is an invalidation, never a checkpoint.
 * A single worker drains every forward page and persists each contiguous page.
 * Duplicate/out-of-order live notifications only request another conditional read.
 */
export function watchTranscript(
  api: HostApi, host: string, session: string, tab: string, connected: boolean,
  update: (cache: TranscriptCache, replace: boolean, source: "cache" | "live" | "page") => void,
  error: (cause: unknown) => void,
): () => void {
  let active = true;
  const epoch = cacheEpoch(host);
  let state = emptyTranscript();
  let initialized = false;
  let incremental: boolean | undefined;
  let legacyDuringRead: AgentEvent[] | null = null;
  let running = false;
  let dirty = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const current = () => active && epoch === cacheEpoch(host);

  const save = async () => {
    await writeCache(host, session, tab, state, epoch);
  };
  const drain = async () => {
    if (!current() || !initialized || running || !connected) return;
    running = true;
    try {
      if (incremental === undefined) {
        incremental = (await api.features()).transcript === 1;
        if (!current()) return;
        unsubscribe = api.subscribeSession(tab, (event) => {
          if (!current() || event.sessionId !== session) return;
          if (incremental) invalidate();
          else {
            legacyDuringRead?.push(event);
            state = { events: mergeEvents(state.events, [event]).slice(-500), hasEarlier: state.hasEarlier };
            update(state, false, "live");
            void save().catch(error);
          }
        }, invalidate);
      }
      let resets = 0;
      while (dirty && current()) {
        dirty = false;
        if (!incremental) {
          legacyDuringRead = [];
          const page = await api.tail(session, tab);
          if (!current() || !page) return;
          // An old host cannot prove continuity. Replace its bounded window
          // rather than visually joining two ranges that may have a gap.
          state = { events: mergeEvents(page.events, legacyDuringRead), hasEarlier: page.hasMore };
          legacyDuringRead = null;
          update(state, true, "page");
          await save();
          continue;
        }
        const page = await api.syncTranscript(session, tab, state.cursor);
        if (!current()) return;
        if (page.deleted) {
          state = emptyTranscript();
          update(state, true, "page");
          await save();
          return;
        }
        if (page.reset && ++resets > 2) throw new Error("Transcript changed repeatedly during sync; retrying later");
        const merged = page.reset ? page.events : mergeEvents(state.events, page.events);
        state = {
          events: merged.slice(-500), cursor: page.cursor,
          hasEarlier: page.reset ? page.hasEarlier : state.hasEarlier || merged.length > 500,
        };
        update(state, page.reset, "page");
        await save();
        dirty ||= page.hasMore;
      }
    } catch (cause) {
      if (current()) error(cause);
      // The last persisted page stays valid. Retry without jumping to a tail.
    } finally { running = false; legacyDuringRead = null; }
  };
  const invalidate = () => {
    dirty = true;
    if (!timer) timer = setTimeout(() => { timer = undefined; void drain(); }, 100);
  };

  void (async () => {
    state = await readCache(host, session, tab);
    if (!current()) return;
    update(state, false, "cache");
    if (!connected) return;
    initialized = true;
    await drain();
  })().catch((cause) => { if (current()) error(cause); });

  // Also repairs missed stream notifications and host-side reconciliations.
  const poll = connected ? setInterval(() => { if (incremental !== false) invalidate(); }, 15_000) : undefined;
  return () => { active = false; unsubscribe(); clearTimeout(timer); clearInterval(poll); };
}
