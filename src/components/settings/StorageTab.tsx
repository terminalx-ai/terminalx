import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { openWorktreeCleanup } from "@/lib/dialogs";
import { leftoverTotals, startLeftoverRun, useLeftoverRun, watchLeftoverRun } from "@/lib/leftoverRun";
import { formatSize } from "@/lib/workspaceSizes";
import type { Leftover } from "@/types/session";

const KIND_LABEL: Record<Leftover["kind"], string> = {
  worktree: "Workspace with no session",
  agentData: "Agent conversations for a removed workspace",
  branch: "Branch with no worktree",
};

function describe(item: Leftover): string {
  if (item.kind === "agentData") return `${item.agent ?? "Agent"} data · ${item.name}`;
  return item.name;
}

/**
 * What earlier deletes left on disk, per project, with sizes. Nothing is
 * selected to begin with and nothing is deleted without the confirmation;
 * rows holding uncommitted or unpushed work cannot be selected at all.
 *
 * The deletion is a run that lives outside this tab (`leftoverRun.ts`): it
 * is followed here while it goes, and carries on, shown in the corner of the
 * window, when Settings is left.
 */
export function StorageTab() {
  const [items, setItems] = useState<Leftover[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const run = useLeftoverRun();
  const removing = run?.status === "running";
  const busy = scanning || removing;
  const done = run?.status === "done" ? run : null;

  useEffect(() => watchLeftoverRun(), []);

  const scan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const found = await api.scanLeftovers();
      setItems(found);
      const removable = new Set(found.filter((item) => !item.keptBecause).map((item) => item.id));
      setSelected((current) => new Set([...current].filter((id) => removable.has(id))));
    } catch (e) {
      setScanError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  }, []);

  // When the tab opens, and again once a deletion is over. Not during one: the list would be read mid-change.
  useEffect(() => {
    if (!removing) void scan();
  }, [removing, scan]);

  const removable = useMemo(() => (items ?? []).filter((item) => !item.keptBecause), [items]);
  const chosen = removable.filter((item) => selected.has(item.id));
  const chosenBytes = chosen.reduce((sum, item) => sum + item.sizeBytes, 0);
  const totalBytes = (items ?? []).reduce((sum, item) => sum + item.sizeBytes, 0);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const count = `${chosen.length} item${chosen.length === 1 ? "" : "s"}`;

  const remove = () => {
    setConfirming(false);
    if (!chosen.length) return;
    setScanError(null);
    void startLeftoverRun(chosen.map((item) => ({ item, label: describe(item) })));
    setSelected(new Set());
  };

  const failures = useMemo(() => Object.fromEntries((done?.finished ?? []).flatMap((item) => (item.error ? [[item.id, item.error]] : []))), [done]);
  const error = scanError ?? done?.error ?? null;
  const result = useMemo(() => {
    if (!done || done.error) return null;
    const sum = leftoverTotals(done);
    const kept = sum.kept ? ` ${sum.kept} could not be deleted and ${sum.kept === 1 ? "was" : "were"} kept.` : "";
    return `Deleted ${sum.deleted} item${sum.deleted === 1 ? "" : "s"} and freed ${formatSize(sum.freedBytes)}.${kept}`;
  }, [done]);
  const progress = removing ? { ...leftoverTotals(run), finished: run.finished.length, total: run.items.length, current: run.items.find((item) => item.id === run.current) } : null;

  const projects = useMemo(() => {
    const groups = new Map<string, { name: string; items: Leftover[] }>();
    for (const item of items ?? []) {
      const group = groups.get(item.projectPath) ?? { name: item.projectName, items: [] };
      group.items.push(item);
      groups.set(item.projectPath, group);
    }
    return [...groups.entries()];
  }, [items]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Deleting a session or workspace can leave things behind: a workspace no session uses, an agent's conversations for a workspace that is gone, a
        branch with no workspace. They are listed here with what they take on disk. Only what is clean and merged into the default branch can be
        deleted from here; the rest says why it is kept, and can still be deleted from the sidebar, which asks a second time. Deleting is permanent;
        nothing is moved to the Trash.
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Agent conversations are matched to a removed workspace by the folder they say they were written in. If another install of the app (a
        development build, for example) still has a session from that workspace, its conversations are among them.
      </p>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-well px-3 py-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          Worktrees that still have sessions are not leftovers. To review and remove the safe ones across all open projects, on this computer and on
          connected cloud workspaces, use the worktree clean-up.
        </p>
        <Button variant="secondary" size="sm" onClick={() => openWorktreeCleanup()}>
          Clean up worktrees…
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void scan()}>
          {scanning ? <Loader2 className="animate-spin" /> : <RefreshCw />} Scan again
        </Button>
        <Button variant="secondary" size="sm" disabled={busy || !removable.length} onClick={() => setSelected(new Set(removable.map((item) => item.id)))}>
          Select all removable
        </Button>
        <Button variant="destructive" size="sm" disabled={busy || !chosen.length} onClick={() => setConfirming(true)}>
          <Trash2 /> Delete selected{chosen.length ? ` (${formatSize(chosenBytes)})` : ""}
        </Button>
        {items && items.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{formatSize(totalBytes)} in total</span>}
      </div>

      {progress && (
        <div className="rounded-lg bg-well px-3 py-2.5" aria-label="Deleting leftovers">
          <div
            role="progressbar"
            aria-label="Leftovers deleted"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.finished}
            aria-valuetext={`${progress.finished} of ${progress.total} done`}
            className="h-1.5 overflow-hidden rounded-full bg-veil-strong"
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${progress.total ? (progress.finished / progress.total) * 100 : 0}%` }} />
          </div>
          <div role="status" className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            <span className="text-foreground">
              {progress.finished} of {progress.total} done
            </span>
            <span className="tabular-nums text-muted-foreground">{formatSize(progress.freedBytes)} freed so far</span>
            <span className="tabular-nums text-muted-foreground">
              {progress.deleted} deleted · {progress.kept} kept
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 truncate">
              {run?.checking ? "Checking everything again before anything is deleted…" : progress.current ? `Deleting ${progress.current.label}…` : "Working…"}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">You can leave Settings: this carries on, and shows in the corner of the window.</p>
        </div>
      )}

      {error && (
        <div role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}
      {result && (
        <div role="status" className="text-xs text-foreground">
          {result}
        </div>
      )}

      {items === null && !error && !removing && <div className="text-xs text-muted-foreground">Looking for leftovers…</div>}
      {items?.length === 0 && <div className="text-xs text-muted-foreground">Nothing left behind.</div>}

      {projects.map(([path, group]) => (
        <section key={path} aria-label={group.name} className="flex flex-col gap-1">
          <h3 className="text-[13px] font-medium">{group.name}</h3>
          <div className="truncate font-mono text-[11px] text-faint">{path}</div>
          <ul className="mt-1 flex flex-col divide-y divide-hairline rounded-lg bg-well">
            {group.items.map((item) => {
              const reason = failures[item.id] ?? item.keptBecause;
              const inputId = `leftover-${item.id}`;
              return (
                <li key={item.id} className="flex items-start gap-3 px-3 py-2">
                  <input
                    id={inputId}
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-foreground"
                    checked={selected.has(item.id)}
                    disabled={busy || !!item.keptBecause}
                    onChange={() => toggle(item.id)}
                  />
                  <label htmlFor={inputId} className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground">{describe(item)}</span>
                    <span className="block text-[11px] text-muted-foreground">{KIND_LABEL[item.kind]}</span>
                    {item.paths[0] && item.kind !== "branch" && (
                      <span className="block truncate font-mono text-[11px] text-faint">
                        {item.paths[0]}
                        {item.paths.length > 1 ? ` and ${item.paths.length - 1} more` : ""}
                      </span>
                    )}
                    {reason && <span className="block text-[11px] text-warning">Kept: {reason}</span>}
                  </label>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{item.kind === "branch" ? "" : formatSize(item.sizeBytes)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <Dialog open={confirming && chosen.length > 0} onOpenChange={(next) => !next && setConfirming(false)}>
        <DialogContent
          width="max-w-[36rem]"
          layout="pinned"
          aria-describedby="leftover-cleanup-description"
          // Focus starts on Cancel, so Enter or Space cannot delete by accident.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">Clean up leftovers</DialogTitle>
            <DialogDescription id="leftover-cleanup-description" className="text-xs leading-relaxed text-muted-foreground">
              Delete {count} ({formatSize(chosenBytes)})? This is everything that will be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogScrollArea aria-label="Items to delete, scrollable">
            <ul aria-label="Items to delete" className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
              {chosen.map((item) => (
                <li key={item.id} className="flex items-start gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-xs text-foreground">{describe(item)}</div>
                    <div className="break-words text-[11px] text-muted-foreground">
                      {item.projectName} · {KIND_LABEL[item.kind]}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{item.kind === "branch" ? "" : formatSize(item.sizeBytes)}</span>
                </li>
              ))}
            </ul>
          </DialogScrollArea>
          <p className="mt-3 shrink-0 text-xs leading-relaxed text-muted-foreground">
            This deletes them from disk; they are not moved to the Trash. Each is checked again first: anything not clean and merged, or in use, is kept.
          </p>
          <DialogFooter>
            <Button ref={cancelRef} variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove}>
              <Trash2 /> Delete {count}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
