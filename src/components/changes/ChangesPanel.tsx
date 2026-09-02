import { useEffect, useMemo, useState } from "react";
import { Columns2, Rows2 } from "lucide-react";
import { api } from "@/lib/api";
import { changeRange, useChanges } from "@/lib/changes";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import type { AgentEvent } from "@/types/events";
import { DiffPane } from "./DiffPane";
import { FileList, sumChanges } from "./FileList";

/**
 * "What did this turn touch": the tree at send time against the tree when
 * the turn closed (or a live snapshot while it runs). Nothing opens by
 * default; the list is the answer and a diff above it would push it away.
 */
export function ChangesPanel({
  cwd,
  events,
  version,
  baseRef,
  active,
  live,
}: {
  cwd: string;
  events: AgentEvent[];
  /** Bumps when the log grows; the array itself is reused, so this drives the range. */
  version: number;
  baseRef?: string | null;
  active: boolean;
  live: boolean;
}) {
  const range = useMemo(() => changeRange(events, baseRef), [events, version, baseRef]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!live || !active) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 4000);
    return () => window.clearInterval(id);
  }, [live, active]);
  const { files, loading, error } = useChanges(cwd, range, active, tick);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [pair, setPair] = useState<{ path: string; before: string; after: string } | null>(null);
  const current = files.find((f) => f.path === selected) ?? null;

  useEffect(() => {
    if (!current || !range) {
      setPair(null);
      return;
    }
    let cancelled = false;
    api
      .fileContentsAt(cwd, current.path, range.base, range.head)
      .then((r) => !cancelled && setPair({ path: current.path, before: r.before ?? "", after: r.after ?? "" }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd, current?.path, range?.base, range?.head, tick]);

  const totals = sumChanges(files);

  if (!range) return <div className="px-3 py-4 text-xs text-muted-foreground">Send a prompt to see what a turn changes.</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span>{live ? "This turn, so far" : "Last turn"}</span>
        <span className="font-mono tabular-nums">
          {totals.additions > 0 && <span className="text-add">+{totals.additions}</span>}{" "}
          {totals.deletions > 0 && <span className="text-destructive">−{totals.deletions}</span>}
        </span>
        {loading && <span className="text-faint">…</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <WithTooltip label="Unified">
            <Button variant={mode === "unified" ? "secondary" : "ghost"} size="icon-xs" aria-label="Unified" onClick={() => setMode("unified")}>
              <Rows2 />
            </Button>
          </WithTooltip>
          <WithTooltip label="Split">
            <Button variant={mode === "split" ? "secondary" : "ghost"} size="icon-xs" aria-label="Split" onClick={() => setMode("split")}>
              <Columns2 />
            </Button>
          </WithTooltip>
        </div>
      </div>
      {error && <div className="mx-3 mb-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
      <div className={cn("shrink-0 overflow-y-auto scrollbar-thin", pair ? "max-h-[40%] border-b border-hairline" : "flex-1")}>
        <FileList files={files} selected={selected} onSelect={(p) => setSelected((s) => (s === p ? null : p))} empty="No files changed." />
      </div>
      {pair && (
        <div className="min-h-0 flex-1">
          <DiffPane path={pair.path} before={pair.before} after={pair.after} mode={mode} />
        </div>
      )}
    </div>
  );
}
