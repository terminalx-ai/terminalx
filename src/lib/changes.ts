import { useEffect, useState } from "react";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import type { AgentEvent } from "@/types/events";
import type { ChangedFile } from "@/types/session";

/**
 * What a turn changed = the tree at send time against the tree when the turn
 * closed. Both are content-addressed snapshots, so a pair diffs to one
 * immutable answer and can be cached forever; a turn still open diffs its
 * baseline against a live snapshot instead.
 */
export interface ChangeRange {
  base: string;
  head: string | null;
}

export function changeRange(events: AgentEvent[], fallbackBase?: string | null): ChangeRange | null {
  let base: string | null = null;
  let head: string | null = null;
  let baseSeq = -1;
  for (const ev of events) {
    const p = ev.payload;
    if (p.type === "turn_checkpoint") {
      base = p.base;
      head = p.head;
      baseSeq = ev.seq;
    } else if (p.type === "user_message" && !p.queued && p.baseline) {
      base = p.baseline;
      baseSeq = ev.seq;
      head = null;
    } else if (p.type === "turn_completed" && p.head && ev.seq > baseSeq) {
      head = p.head;
    }
  }
  if (!base) base = fallbackBase ?? null;
  if (!base) return null;
  return { base, head };
}

const MAX_CHANGES_CACHE = 100;
const cache = new Map<string, ChangedFile[]>();

function cacheGet(key: string): ChangedFile[] | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: ChangedFile[]): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CHANGES_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * What a turn changed in a local checkout or a cloud repository: the
 * source's diff over the turn's range. A closed range (both ends are
 * snapshots) is cached (LRU-bounded) under the source's key.
 */
export function useChanges(source: GitSource | undefined, range: ChangeRange | null, active: boolean, tick = 0) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!source || !range || !active) return;
    const key = `${source.key}|${range.base}|${range.head ?? "live"}`;
    if (range.head) {
      const hit = cacheGet(key);
      if (hit) {
        setFiles(hit);
        return;
      }
    }
    let cancelled = false;
    setLoading(true);
    source
      .changesBetween(range.base, range.head)
      .then((f) => {
        if (cancelled) return;
        if (range.head) cacheSet(key, f);
        setFiles(f);
        setError(null);
      })
      .catch((e) => !cancelled && setError(source.cloud ? source.errorMessage(e) : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [source, range?.base, range?.head, active, tick]);
  return { files, loading, error };
}

export function useWorkingChanges(cwd: string | undefined, active: boolean, tick = 0) {
  return useGitWorkingChanges(cwd ? localGitSource(cwd) : undefined, active, tick);
}

/** Uncommitted changes of a local checkout or a cloud repository. */
export function useGitWorkingChanges(source: GitSource | undefined, active: boolean, tick = 0, hideWhitespace = false) {
  const [state, setState] = useState<{ key: string | null; head: string | null; index: string | null; files: ChangedFile[]; staged: ChangedFile[]; unstaged: ChangedFile[] }>({ key: null, head: null, index: null, files: [], staged: [], unstaged: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!source || !active) return;
    let cancelled = false;
    setLoading(true);
    (source.workingChangeSets ? source.workingChangeSets(hideWhitespace).then(({ head, index, staged, unstaged }) => ({ head, index, staged, unstaged, files: [...new Map([...staged, ...unstaged].map((file) => [file.path, file])).values()] })) : source.workingChanges(hideWhitespace).then(({ head, files }) => ({ head, index: null, files, staged: [], unstaged: files })))
      .then(({ head, index, files, staged, unstaged }) => {
        if (cancelled) return;
        setState({ key: source.key, head, index, files, staged, unstaged });
        setError(null);
      })
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [source, active, tick, hideWhitespace]);
  // Never show one repository's changes under another.
  const current = state.key === (source?.key ?? null);
  return { head: current ? state.head : null, index: current ? state.index : null, files: current ? state.files : [], staged: current ? state.staged : [], unstaged: current ? state.unstaged : [], loading, error };
}
