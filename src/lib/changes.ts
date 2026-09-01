import { useEffect, useState } from "react";
import { api, git } from "@/lib/api";
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
    if (p.type === "user_message" && !p.queued && p.baseline) {
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

const cache = new Map<string, ChangedFile[]>();

export function useChanges(cwd: string | undefined, range: ChangeRange | null, active: boolean, tick = 0) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!cwd || !range || !active) return;
    const key = `${cwd}|${range.base}|${range.head ?? "live"}`;
    if (range.head && cache.has(key)) {
      setFiles(cache.get(key)!);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .changesBetween(cwd, range.base, range.head)
      .then((f) => {
        if (cancelled) return;
        if (range.head) cache.set(key, f);
        setFiles(f);
        setError(null);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [cwd, range?.base, range?.head, active, tick]);
  return { files, loading, error };
}

export function useWorkingChanges(cwd: string | undefined, active: boolean, tick = 0) {
  const [state, setState] = useState<{ head: string | null; files: ChangedFile[] }>({ head: null, files: [] });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!cwd || !active) return;
    let cancelled = false;
    setLoading(true);
    git
      .workingChanges(cwd)
      .then(([head, files]) => !cancelled && setState({ head, files }))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [cwd, active, tick]);
  return { ...state, loading };
}
