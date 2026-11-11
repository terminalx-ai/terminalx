import { useEffect, useState } from "react";
import { errorMessage, gh, type PullRequest } from "./api";

export function usePrSearch(cwd: string | null, query: string | null) {
  const key = cwd && query !== null ? JSON.stringify([cwd, query]) : null;
  const [result, setResult] = useState<{ key: string; items: PullRequest[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!cwd || query === null || !key) return;
    let live = true;
    const timer = window.setTimeout(
      () => {
        gh.search(cwd, query).then(
          (items) => live && setResult({ key, items, error: null }),
          (error) => live && setResult({ key, items: [], error: errorMessage(error) }),
        );
      },
      query ? 200 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [cwd, query, key]);
  return result?.key === key ? { ...result, loading: false } : { items: [], error: null, loading: key !== null };
}
