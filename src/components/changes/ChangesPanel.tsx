import { useEffect, useMemo, useState } from "react";
import { Columns2, Rows2 } from "lucide-react";
import { api } from "@/lib/api";
import { changeRange, useChanges, useWorkingChanges, type ChangeRange } from "@/lib/changes";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import type { AgentEvent } from "@/types/events";
import type { ChangedFile } from "@/types/session";
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
  workingTree = false,
}: {
  cwd: string;
  events: AgentEvent[];
  /** Bumps when the log grows; the array itself is reused, so this drives the range. */
  version: number;
  baseRef?: string | null;
  active: boolean;
  live: boolean;
  /** Show the checkout's uncommitted diff outside an agent turn. */
  workingTree?: boolean;
}) {
  if (workingTree) return <WorkingTreeChanges cwd={cwd} active={active} />;
  return <TurnChanges cwd={cwd} events={events} version={version} baseRef={baseRef} active={active} live={live} />;
}

function TurnChanges({
  cwd,
  events,
  version,
  baseRef,
  active,
  live,
}: {
  cwd: string;
  events: AgentEvent[];
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
  return (
    <ChangesBody
      cwd={cwd}
      files={files}
      loading={loading}
      error={error}
      range={range}
      label={live ? "This turn, so far" : "Last turn"}
      empty="No files changed."
      noRange="Send a prompt to see what a turn changes."
      refreshKey={tick}
    />
  );
}

function WorkingTreeChanges({ cwd, active }: { cwd: string; active: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((value) => value + 1), 4000);
    return () => window.clearInterval(id);
  }, [active]);
  const { head, files, loading } = useWorkingChanges(cwd, active, tick);
  const range = head ? { base: head, head: null } : null;
  return (
    <ChangesBody
      cwd={cwd}
      files={files}
      loading={loading}
      error={null}
      range={range}
      label="Working tree"
      empty="Working tree is clean."
      noRange="Reading working tree…"
      refreshKey={tick}
    />
  );
}

function ChangesBody({
  cwd,
  files,
  loading,
  error,
  range,
  label,
  empty,
  noRange,
  refreshKey,
}: {
  cwd: string;
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
  range: ChangeRange | null;
  label: string;
  empty: string;
  noRange: string;
  refreshKey: number;
}) {
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
  }, [cwd, current?.path, range?.base, range?.head, refreshKey]);

  const totals = sumChanges(files);

  if (!range) return <div className="px-3 py-4 text-xs text-muted-foreground">{noRange}</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span>{label}</span>
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
        <FileList files={files} selected={selected} onSelect={(p) => setSelected((s) => (s === p ? null : p))} empty={empty} />
      </div>
      {pair && (
        <div className="min-h-0 flex-1">
          <DiffPane path={pair.path} before={pair.before} after={pair.after} mode={mode} />
        </div>
      )}
    </div>
  );
}
