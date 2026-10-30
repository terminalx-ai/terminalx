import type { AgentEvent } from "@terminalx/portable/events";
import { connectionProblem } from "../transport/connection-errors";
import { RelayOuterError } from "../transport/relay-client";
import { mergeEvents, type HostApi } from "./host-api";
import { cacheEpoch, emptyTranscript, readCache, writeCache, type TranscriptCache } from "./transcript-cache";

type TransportPath = "direct" | "relay";

/** Connection losses in a row, with the same read in flight, before that read stops being sent on its own. */
const LOSSES_BEFORE_HALT = 2;
/** The relay's typed close for a message over its size limit (#669 fix 5): the first one says enough. */
const MESSAGE_TOO_LARGE = 4413;
const haltAfter = (code: number) => code === MESSAGE_TOO_LARGE ? 1 : LOSSES_BEFORE_HALT;

/**
 * Reads that were in flight when the connection dropped, per conversation.
 * Kept outside any one watcher: every reconnect starts a new one, and this
 * count is what stops a page that breaks the connection from being asked for
 * again on each reconnect (#670). Another path (Wi-Fi instead of Relay) starts
 * a fresh count.
 */
const losses = new Map<string, { request: string; path: TransportPath | null; count: number; code: number }>();
const lossKey = (host: string, session: string, tab: string) => JSON.stringify([host, session, tab]);

/** The same read was in flight each time the connection dropped: it is not sent again over this path until someone asks. */
export class TranscriptHaltedError extends Error {
  constructor(readonly path: TransportPath | null, readonly code: number) {
    super(path === "relay" || code === MESSAGE_TOO_LARGE
      ? "This conversation is too large to load over Relay; open it on the same Wi-Fi as your Mac."
      : "Loading this conversation dropped the connection to your Mac twice, so the phone stopped asking. Retry to ask once more.");
    this.name = "TranscriptHaltedError";
  }
}

/** Someone pressed Retry: a halted read goes out once more, and halts again if that drops the connection too. */
export function retryHaltedTranscript(host: string, session: string, tab: string): void {
  const loss = losses.get(lossKey(host, session, tab));
  if (loss) loss.count = Math.min(loss.count, haltAfter(loss.code) - 1);
}

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
  let legacyPage: AgentEvent[] | undefined;
  let running = false;
  let halted = false;
  let dirty = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const current = () => active && epoch === cacheEpoch(host);

  const save = async () => {
    await writeCache(host, session, tab, state, epoch);
  };
  // Every read that can break the connection goes through here, so a lost
  // connection is counted against the read that was in flight.
  const read = async <T>(request: string, send: () => Promise<T>): Promise<T> => {
    const key = lossKey(host, session, tab);
    const path = api.transport();
    const loss = losses.get(key);
    if (loss && loss.request === request && loss.path === path && loss.count >= haltAfter(loss.code)) throw new TranscriptHaltedError(path, loss.code);
    try {
      const result = await send();
      losses.delete(key);
      return result;
    } catch (cause) {
      if (cause instanceof RelayOuterError) {
        const previous = losses.get(key);
        const count = previous && previous.request === request && previous.path === path ? previous.count + 1 : 1;
        losses.set(key, { request, path, count, code: cause.code });
        if (count >= haltAfter(cause.code)) throw new TranscriptHaltedError(path, cause.code);
      } else if (!connectionProblem(cause)) {
        // The Mac answered, if with a refusal: the read did not take the connection down.
        losses.delete(key);
      }
      throw cause;
    }
  };
  const drain = async () => {
    if (!current() || !initialized || running || halted || !connected) return;
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
          const page = await read("tail", () => api.tail(session, tab));
          if (!current() || !page) return;
          // The first page replaces an unverified cache. A subscription catch-up
          // with unchanged overlap belongs to the same history: merge it into
          // the pane so a late response cannot discard Load earlier pages.
          const replace = !legacyPage || !hasUnchangedOverlap(legacyPage, page.events);
          state = { events: mergeEvents(page.events, legacyDuringRead), hasEarlier: page.hasMore };
          legacyDuringRead = null;
          legacyPage = page.events;
          update(state, replace, "page");
          await save();
          continue;
        }
        const cursor = state.cursor;
        const page = await read(`sync:${JSON.stringify(cursor ?? null)}`, () => api.syncTranscript(session, tab, cursor));
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
      // Halted: the poll and live notifications stop asking until Retry starts a new watcher.
      if (cause instanceof TranscriptHaltedError) halted = true;
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

function hasUnchangedOverlap(existing: AgentEvent[], incoming: AgentEvent[]): boolean {
  const bySequence = new Map(existing.map((event) => [event.seq, event]));
  let overlap = false;
  for (const event of incoming) {
    const previous = bySequence.get(event.seq);
    if (!previous) continue;
    if (JSON.stringify(previous) !== JSON.stringify(event)) return false;
    overlap = true;
  }
  return overlap;
}
