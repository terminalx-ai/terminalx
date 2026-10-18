import { useCallback, useRef, useState } from "react";
import type { Issue } from "@/lib/api";

export const issueKey = (issue: Pick<Issue, "provider" | "id">) => `${issue.provider}:${issue.id}`;

/**
 * The writes to issues that are on their way, by issue, and when each issue
 * was last written to. A read of the list or of an issue that started before
 * a write began or ended reads the issue as it was, so what it says of that
 * issue is not shown over the write. Kept by the view, not by a picker, so an
 * issue opened again while its write is on its way still shows it busy.
 */
export function useIssueWrites() {
  const clock = useRef(0);
  const lastWrite = useRef(new Map<string, number>());
  const counts = useRef(new Map<string, number>());
  const [writing, setWriting] = useState<ReadonlySet<string>>(new Set());

  const mark = useCallback((key: string, by: number) => {
    lastWrite.current.set(key, ++clock.current);
    const count = (counts.current.get(key) ?? 0) + by;
    if (count > 0) counts.current.set(key, count);
    else counts.current.delete(key);
    setWriting(new Set(counts.current.keys()));
  }, []);
  const begin = useCallback((key: string) => mark(key, 1), [mark]);
  const end = useCallback((key: string) => mark(key, -1), [mark]);
  /** The moment a read starts, to hand back to `outdated` with its answer. */
  const readStarted = useCallback(() => clock.current, []);
  /** True when what a read that started at `started` says of the issue is older than what is shown. */
  const outdated = useCallback((key: string, started: number) => counts.current.has(key) || (lastWrite.current.get(key) ?? 0) > started, []);

  return { writing, begin, end, readStarted, outdated };
}
