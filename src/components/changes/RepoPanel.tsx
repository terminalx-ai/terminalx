import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, CloudDownload, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useGitWorkingChanges } from "@/lib/changes";
import { localGitSource, type GitSource, type SourceStatus } from "@/lib/gitSource";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { Segmented } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import type { CommitInfo } from "@/types/session";
import { DiffPane } from "./DiffPane";
import { FileList } from "./FileList";

export type RepoView = "uncommitted" | "history";

/**
 * The whole repository: uncommitted changes with a commit box, and history
 * opening commits in place. Reads live; commit, push and pull are the only
 * writes, and each refetches. `source` is a cloud repository (PRO-27);
 * without it this is the local checkout at `cwd`.
 */
export function RepoPanel({ cwd, source: given, active, view: sub, onViewChange: setSub, author }: {
  cwd?: string;
  source?: GitSource;
  active: boolean;
  view: RepoView;
  onViewChange: (view: RepoView) => void;
  /** Shown above the commit box: whose identity a cloud commit carries. */
  author?: string | null;
}) {
  const source = useMemo(() => given ?? localGitSource(cwd ?? ""), [given, cwd]);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const { head, files, loading, error: readError } = useGitWorkingChanges(source, active && sub === "uncommitted", tick);
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pair, setPair] = useState<{ path: string; before: string; after: string } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [openCommit, setOpenCommit] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    setCommits([]);
    setSelected(null);
    setNotice(null);
    setError(null);
  }, [source]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    source.workStatus().then((next) => !cancelled && setStatus(next)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, active, tick]);

  useEffect(() => {
    if (!active || sub !== "history") return;
    let cancelled = false;
    source.logCommits(null, 60).then((next) => !cancelled && setCommits(next)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, active, sub, tick]);

  useEffect(() => {
    if (!selected || !head) {
      setPair(null);
      return;
    }
    let cancelled = false;
    source
      .fileContentsAt(selected, head, null)
      .then((r) => !cancelled && setPair({ path: selected, before: r.before ?? "", after: r.after ?? "" }))
      .catch((e) => !cancelled && setError(source.errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [source, selected, head, tick]);

  const run = async (label: string, fn: () => Promise<string | null | void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const said = await fn();
      if (said) setNotice(said);
      refresh();
      return true;
    } catch (e) {
      setError(source.errorMessage(e));
      refresh();
      return false;
    } finally {
      setBusy(null);
    }
  };
  const commit = () => void run("commit", () => source.commit(message.trim())).then((ok) => ok && setMessage(""));
  const writable = source.canWrite;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <Segmented<RepoView>
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
      {error && <div role="alert" className="mx-3 mb-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
      {!error && readError != null && (
        <div role="alert" className="mx-3 mb-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{source.errorMessage(readError)}</div>
      )}
      {notice && <div role="status" className="mx-3 mb-2 rounded-md bg-well px-2 py-1 text-xs text-muted-foreground">{notice}</div>}
      {(status?.operation || !!status?.conflicted?.length) && (
        <div role="alert" className="mx-3 mb-2 flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-xs text-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            {status?.operation ? `A ${status.operation} is in progress. ` : ""}
            {status?.conflicted?.length
              ? `Conflicts in ${status.conflicted.join(", ")}: resolve them in the workspace before committing.`
              : "Finish or abort it in the workspace's terminal."}
          </span>
        </div>
      )}

      {sub === "uncommitted" && (
        <>
          {writable && <div className="px-3 pb-2">
            {author !== undefined && (
              <div className="mb-1 truncate px-1 text-[11px] text-faint" data-testid="commit-author">
                {author ? `Committing as ${author}` : "No Git identity on this computer: set user.name and user.email to commit."}
              </div>
            )}
            <div className="rounded-lg bg-well p-2">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && message.trim() && !busy) {
                    e.preventDefault();
                    commit();
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
                  onClick={commit}
                >
                  {busy === "commit" ? <Loader2 className="animate-spin" /> : <Check />} Commit
                </Button>
                <WithTooltip label="Push">
                  <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run("push", () => source.push())}>
                    {busy === "push" ? <Loader2 className="animate-spin" /> : <ArrowUpFromLine />} Push
                  </Button>
                </WithTooltip>
                <WithTooltip label="Pull (fast-forward only)">
                  <Button size="sm" variant="ghost" aria-label="Pull" disabled={!!busy} onClick={() => void run("pull", () => source.pull())}>
                    {busy === "pull" ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
                  </Button>
                </WithTooltip>
                {source.fetch && (
                  <WithTooltip label="Fetch">
                    <Button size="sm" variant="ghost" aria-label="Fetch" disabled={!!busy} onClick={() => void run("fetch", () => source.fetch!())}>
                      {busy === "fetch" ? <Loader2 className="animate-spin" /> : <CloudDownload />}
                    </Button>
                  </WithTooltip>
                )}
                {loading && <span className="ml-auto text-xs text-faint">…</span>}
              </div>
            </div>
          </div>}
          <div className={cn("shrink-0 overflow-y-auto scrollbar-thin", pair ? "max-h-[35%] border-b border-hairline" : "flex-1")}>
            <FileList
              files={files}
              selected={selected}
              onSelect={(p) => setSelected((s) => (s === p ? null : p))}
              empty="Working tree is clean."
              trailing={(f) => source.discard && writable && (
                <span
                  role="button"
                  aria-label="Discard changes"
                  title="Discard changes to this file"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Discard changes to ${f.path}? This cannot be undone.`)) void run("discard", () => source.discard!(f.path));
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
            <CommitRow key={c.sha} source={source} commit={c} open={openCommit === c.sha} onToggle={() => setOpenCommit((o) => (o === c.sha ? null : c.sha))} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommitRow({ source, commit, open, onToggle }: { source: GitSource; commit: CommitInfo; open: boolean; onToggle: () => void }) {
  const [files, setFiles] = useState<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pair, setPair] = useState<{ path: string; before: string; after: string } | null>(null);
  const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const parentTree = commit.parent ? (await source.logCommits(commit.parent, 1))[0]?.tree ?? EMPTY : EMPTY;
      const f = await source.changesBetween(parentTree, commit.tree);
      if (!cancelled) {
        setFiles(f);
        setSelected(f[0]?.path ?? null);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, source, commit.sha]);
  useEffect(() => {
    if (!open || !selected) {
      setPair(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const parentTree = commit.parent ? (await source.logCommits(commit.parent, 1))[0]?.tree ?? EMPTY : EMPTY;
      const r = await source.fileContentsAt(selected, parentTree, commit.tree);
      if (!cancelled) setPair({ path: selected, before: r.before ?? "", after: r.after ?? "" });
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, selected, source, commit.sha]);
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
