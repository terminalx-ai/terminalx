import { useEffect, useRef, useState } from "react";
import { errorMessage, gh, type PullRequest } from "./api";

/** `attempt`: a number the caller bumps to read the same search once more. */
export function usePrSearch(cwd: string | null, query: string | null, attempt = 0) {
  return usePrSearchIn(cwd, cwd ? (text) => gh.search(cwd, text) : null, query, attempt);
}

/**
 * The pull requests `search` finds for `query`, lightly debounced. `key`
 * names where it searches (a directory here, a session on a runtime): the
 * list is read again whenever it or the query changes, and an answer for an
 * earlier one is never shown.
 */
export function usePrSearchIn(key: string | null, search: ((query: string) => Promise<PullRequest[]>) | null, query: string | null, attempt = 0) {
  const searchKey = key && search && query !== null ? JSON.stringify([key, query, attempt]) : null;
  const [result, setResult] = useState<{ key: string; items: PullRequest[]; error: string | null } | null>(null);
  // The search of the latest render: a caller may build it anew each time, and only `key` says it changed.
  const latest = useRef(search);
  latest.current = search;
  useEffect(() => {
    if (!searchKey || query === null) return;
    let live = true;
    const timer = window.setTimeout(
      () => {
        const run = latest.current;
        if (!run) return;
        run(query).then(
          (items) => live && setResult({ key: searchKey, items, error: null }),
          (error) => live && setResult({ key: searchKey, items: [], error: errorMessage(error) }),
        );
      },
      query ? 200 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, searchKey]);
  return result?.key === searchKey ? { ...result, loading: false } : { items: [], error: null, loading: searchKey !== null };
}
