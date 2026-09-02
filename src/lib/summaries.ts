import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SessionSummary } from "@/lib/api";
import { sessionStatus, type SessionEntry } from "@/types/session";

/**
 * The card snippets, fetched once and kept.
 *
 * The store holds no transcript, so what a session last said comes from the
 * backend reading log tails. That is a file read per session, so it is cached
 * and only redone when the session itself moved: the key carries the session's
 * modified stamp *and* its folded status, because a tab going from working to
 * waiting changes what the card must say while the frontend patches status
 * without touching `modified`.
 *
 * The cache is module state on purpose: leaving and re-entering the dashboard
 * then draws the cards it had, and only asks about what changed meanwhile.
 */

/** Slow enough to cost nothing, quick enough that a card is never stale for long. */
const REFRESH_MS = 30_000;

const cache = new Map<string, { key: string; summary: SessionSummary }>();

export function cacheKey(s: SessionEntry): string {
  return `${s.modified}:${sessionStatus(s)}`;
}

function empty(s: SessionEntry): SessionSummary {
  return { sessionId: s.id, tabId: s.activeTab ?? "", lastPrompt: null, lastReply: null, waitingOn: null, updatedAt: s.modified };
}

export interface Summaries {
  get: (sessionId: string) => SessionSummary | undefined;
  /** True only while the first fetch is in flight, so cards can hold skeletons. */
  loading: boolean;
}

export function useSessionSummaries(sessions: SessionEntry[], enabled: boolean): Summaries {
  const [version, setVersion] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [tick, setTick] = useState(0);
  // The effect reads the sessions through a ref so its dependency can be the
  // signature string rather than an array that is new on every render.
  const latest = useRef(sessions);
  latest.current = sessions;
  const lastTick = useRef(tick);
  const signature = sessions.map((s) => `${s.id}@${cacheKey(s)}`).join("|");

  useEffect(() => {
    if (!enabled) return;
    const wanted = latest.current;
    // A timer tick refreshes everything; a store change only what moved.
    const refreshAll = tick !== lastTick.current;
    lastTick.current = tick;
    const stale = refreshAll ? wanted : wanted.filter((s) => cache.get(s.id)?.key !== cacheKey(s));
    if (!stale.length) return;
    let live = true;
    setFetching(true);
    void api
      .sessionSummaries(stale.map((s) => s.id))
      .then((list) => {
        if (!live) return;
        const keys = new Map(stale.map((s) => [s.id, cacheKey(s)]));
        for (const summary of list) {
          cache.set(summary.sessionId, { key: keys.get(summary.sessionId) ?? "", summary });
        }
        // A session whose tab has never been written answers with nothing;
        // remember that too, or it is asked about on every render.
        for (const s of stale) {
          if (!list.some((x) => x.sessionId === s.id)) cache.set(s.id, { key: cacheKey(s), summary: empty(s) });
        }
        setVersion((v) => v + 1);
      })
      .catch(() => {
        /* outside a webview, or the index moved under us; cards degrade to titles */
      })
      .finally(() => {
        if (live) setFetching(false);
      });
    return () => {
      live = false;
    };
  }, [signature, enabled, tick]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      // Nothing changes while the window is hidden, so nothing needs re-reading.
      if (typeof document === "undefined" || document.visibilityState === "visible") setTick((t) => t + 1);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [enabled]);

  return useMemo(() => {
    const known = sessions.some((s) => cache.has(s.id));
    return {
      get: (sessionId: string) => cache.get(sessionId)?.summary,
      loading: fetching && !known,
    };
    // `signature` stands in for the sessions and `version` says the cache moved,
    // so neither the array's identity nor the cache needs watching directly.
  }, [signature, version, fetching]);
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
