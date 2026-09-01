import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { api, errorMessage, git } from "@/lib/api";
import { useWorkingChanges } from "@/lib/changes";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { Segmented } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import type { CommitInfo, WorkStatus } from "@/types/session";
import { DiffPane } from "./DiffPane";
import { FileList } from "./FileList";

type Sub = "uncommitted" | "history";

/**
 * The whole repository: uncommitted changes with a commit box, and history
 * opening commits in place. Reads live; commit, push and pull are the only
 * writes, and each refetches.
 */
export function RepoPanel({ cwd, active }: { cwd: string; active: boolean }) {
  const [sub, setSub] = useState<Sub>("uncommitted");
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const { head, files, loading } = useWorkingChanges(cwd, active && sub === "uncommitted", tick);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pair, setPair] = useState<{ path: string; before: string; after: string } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [openCommit, setOpenCommit] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    api.workStatus(cwd).then(setStatus).catch(() => {});
  }, [cwd, active, tick]);

  useEffect(() => {
    if (!active || sub !== "history") return;
    api.logCommits(cwd, null, 60).then(setCommits).catch(() => {});
  }, [cwd, active, sub, tick]);

  useEffect(() => {
    if (!selected || !head) {
      setPair(null);
      return;
    }
    let cancelled = false;
    api
      .fileContentsAt(cwd, selected, head, null)
      .then((r) => !cancelled && setPair({ path: selected, before: r.before ?? "", after: r.after ?? "" }))
      .catch((e) => setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [cwd, selected, head, tick]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <Segmented<Sub>
          aria-label="Repository view"
          value={sub}
          onChange={setSub}
          options={[
            { value: "uncommitted", label: `Uncommitted${files.length ? ` · ${files.length}` : ""}` },
            { value: "history", label: "History" },
          ]}
        />
        <div className="ml-auto flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {status?.branch && <span className="truncate font-mono" title={status.branch}>{status.branch}</span>}
          {status && status.ahead > 0 && <span className="text-faint">↑{status.ahead}</span>}
          {status && status.behind > 0 && <span className="text-faint">↓{status.behind}</span>}
        </div>
      </div>
      {error && <div className="mx-3 mb-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}

      {sub === "uncommitted" && (
        <>
          <div className="px-3 pb-2">
            <div className="rounded-lg bg-well p-2">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && message.trim()) {
                    e.preventDefault();
                    void run("commit", () => git.commit(cwd, message.trim())).then(() => setMessage(""));
                  }
                }}
                rows={2}
                placeholder="Commit message (⌘⏎ to commit)"
                className="w-full resize-none bg-transparent px-1 text-[13px] outline-none placeholder:text-faint"
              />
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="accent"
                  disabled={!message.trim() || !files.length || !!busy}
                  onClick={() => void run("commit", () => git.commit(cwd, message.trim())).then(() => setMessage(""))}
                >
                  {busy === "commit" ? <Loader2 className="animate-spin" /> : <Check />} Commit
                </Button>
                <WithTooltip label="Push">
                  <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run("push", () => git.push(cwd))}>
                    {busy === "push" ? <Loader2 className="animate-spin" /> : <ArrowUpFromLine />} Push
                  </Button>
                </WithTooltip>
                <WithTooltip label="Pull (fast-forward only)">
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run("pull", () => git.pull(cwd))}>
                    {busy === "pull" ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
                  </Button>
                </WithTooltip>
                {loading && <span className="ml-auto text-xs text-faint">…</span>}
              </div>
            </div>
          </div>
          <div className={cn("shrink-0 overflow-y-auto scrollbar-thin", pair ? "max-h-[35%] border-b border-hairline" : "flex-1")}>
            <FileList
              files={files}
              selected={selected}
              onSelect={(p) => setSelected((s) => (s === p ? null : p))}
              empty="Working tree is clean."
              trailing={(f) => (
                <span
                  role="button"
                  aria-label="Discard changes"
                  title="Discard changes to this file"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Discard changes to ${f.path}? This cannot be undone.`)) void run("discard", () => git.discard(cwd, f.path));
                  }}
                  className="hidden shrink-0 rounded p-0.5 text-faint hover:bg-veil-strong hover:text-destructive group-hover:inline-flex"
                >
                  <RotateCcw className="size-3" />
                </span>
              )}
            />
          </div>
          {pair && (
            <div className="min-h-0 flex-1">
              <DiffPane path={pair.path} before={pair.before} after={pair.after} mode="unified" />
            </div>
          )}
        </>
      )}

      {sub === "history" && (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-1.5 py-1">
          {commits.length === 0 && <div className="px-2 py-4 text-xs text-muted-foreground">No commits yet.</div>}
          {commits.map((c) => (
            <CommitRow key={c.sha} cwd={cwd} commit={c} open={openCommit === c.sha} onToggle={() => setOpenCommit((o) => (o === c.sha ? null : c.sha))} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommitRow({ cwd, commit, open, onToggle }: { cwd: string; commit: CommitInfo; open: boolean; onToggle: () => void }) {
  const [files, setFiles] = useState<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pair, setPair] = useState<{ path: string; before: string; after: string } | null>(null);
  const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const parentTree = commit.parent ? (await api.logCommits(cwd, commit.parent, 1))[0]?.tree ?? EMPTY : EMPTY;
      const f = await api.changesBetween(cwd, parentTree, commit.tree);
      if (!cancelled) {
        setFiles(f);
        setSelected(f[0]?.path ?? null);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, cwd, commit.sha]);
  useEffect(() => {
    if (!open || !selected) {
      setPair(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const parentTree = commit.parent ? (await api.logCommits(cwd, commit.parent, 1))[0]?.tree ?? EMPTY : EMPTY;
      const r = await api.fileContentsAt(cwd, selected, parentTree, commit.tree);
      if (!cancelled) setPair({ path: selected, before: r.before ?? "", after: r.after ?? "" });
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, selected, cwd, commit.sha]);
  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={onToggle}
        className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40", open ? "bg-selected" : "hover:bg-selected/50")}
      >
        <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px]">{commit.subject}</div>
          <div className="truncate text-[11px] text-faint">
            <span className="font-mono">{commit.shortSha}</span> · {commit.author} · {relativeTime(commit.date)}
          </div>
        </div>
      </button>
      {open && (
        <div className="ml-3 border-l border-hairline">
          {commit.body && <div className="px-3 py-1 text-xs text-muted-foreground whitespace-pre-wrap select-text">{commit.body}</div>}
          <FileList files={files} selected={selected} onSelect={setSelected} empty="No files." />
          {pair && (
            <div className="h-72 border-t border-hairline">
              <DiffPane path={pair.path} before={pair.before} after={pair.after} mode="unified" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
