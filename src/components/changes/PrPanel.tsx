import { useEffect, useState } from "react";
import { Check, CircleAlert, CircleDot, ExternalLink, GitMerge, GitPullRequestDraft, Loader2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, gh, type PullRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import type { WorkStatus } from "@/types/session";

/** Readiness in one fixed order: state, then conflicts, then checks. */
export function mergeReadiness(pr: PullRequest): { ok: boolean; label: string } {
  if (pr.state === "MERGED") return { ok: false, label: "Merged" };
  if (pr.state === "CLOSED") return { ok: false, label: "Closed" };
  if (pr.isDraft) return { ok: false, label: "Draft" };
  if (pr.mergeable === "CONFLICTING") return { ok: false, label: "Has conflicts" };
  const failing = pr.checks.some((c) => ["failure", "error", "cancelled", "timed_out", "action_required"].includes(c.state));
  if (failing) return { ok: false, label: "Checks failing" };
  const running = pr.checks.some((c) => ["pending", "in_progress", "queued", "expected", "waiting"].includes(c.state));
  if (running) return { ok: false, label: "Checks running" };
  if (pr.mergeable === "UNKNOWN") return { ok: false, label: "Checking mergeability" };
  return { ok: true, label: "Ready to merge" };
}

export function PrPanel({ cwd, branch, active, busy }: { cwd: string; branch: string | null; active: boolean; busy: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    gh.available().then(setAvailable).catch(() => setAvailable(false));
  }, []);

  useEffect(() => {
    if (!active || !branch || !available) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([gh.list(cwd, branch), api.workStatus(cwd)])
      .then(([p, s]) => {
        if (cancelled) return;
        setPrs(p);
        setStatus(s);
        setError(null);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [cwd, branch, active, available, tick, busy]);

  // Poll while something is in flight.
  useEffect(() => {
    if (!active || !prs.some((p) => p.state === "OPEN")) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, [active, prs]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setWorking(label);
    setError(null);
    try {
      await fn();
      setTick((t) => t + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  };

  if (available === false) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        Pull requests need the GitHub CLI. Install <span className="font-mono">gh</span> and run <span className="font-mono">gh auth login</span>.
      </div>
    );
  }
  if (!branch) return <div className="px-3 py-4 text-xs text-muted-foreground">This session has no branch.</div>;

  const open = prs.filter((p) => p.state === "OPEN");
  const canCreate = open.length === 0 && status && status.defaultBranch && status.branch !== status.defaultBranch;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto scrollbar-thin">
      {error && <div className="mx-3 mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
      {loading && prs.length === 0 && <div className="px-3 py-3 text-xs text-faint">Loading…</div>}
      {prs.map((pr) => {
        const ready = mergeReadiness(pr);
        return (
          <div key={pr.number} className="border-b border-hairline px-3 py-3">
            <div className="flex items-start gap-2">
              {pr.state === "MERGED" ? (
                <GitMerge className="mt-0.5 size-4 shrink-0 text-merged" />
              ) : pr.isDraft ? (
                <GitPullRequestDraft className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : pr.state === "OPEN" ? (
                <CircleDot className="mt-0.5 size-4 shrink-0 text-add" />
              ) : (
                <X className="mt-0.5 size-4 shrink-0 text-destructive" />
              )}
              <div className="min-w-0 flex-1">
                <button type="button" onClick={() => void openUrl(pr.url)} className="group flex items-center gap-1 text-left text-[13px] font-medium hover:underline">
                  <span className="truncate">{pr.title}</span>
                  <ExternalLink className="size-3 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
                </button>
                <div className="text-[11px] text-faint">
                  #{pr.number} into <span className="font-mono">{pr.base}</span> · <span className="text-add">+{pr.additions}</span>{" "}
                  <span className="text-destructive">−{pr.deletions}</span>
                </div>
              </div>
            </div>
            {pr.checks.length > 0 && (
              <div className="mt-2 flex flex-col gap-0.5">
                {pr.checks.map((c) => (
                  <div key={c.name} className="flex items-center gap-2 text-xs">
                    {["success", "neutral", "skipped"].includes(c.state) ? (
                      <Check className="size-3.5 text-add" />
                    ) : ["pending", "in_progress", "queued", "expected", "waiting"].includes(c.state) ? (
                      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <CircleAlert className="size-3.5 text-destructive" />
                    )}
                    <span className="truncate text-muted-foreground">{c.name}</span>
                  </div>
                ))}
              </div>
            )}
            {pr.state === "OPEN" && (
              <div className="mt-3 flex items-center gap-2">
                <span className={cn("text-xs", ready.ok ? "text-add" : "text-muted-foreground")}>{ready.label}</span>
                <div className="ml-auto flex items-center gap-1">
                  {pr.isDraft && (
                    <Button size="sm" variant="secondary" disabled={!!working} onClick={() => void act("ready", () => gh.ready(cwd, pr.number))}>
                      Mark ready
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" className={cn("bg-merge text-merge-foreground hover:opacity-90", !ready.ok && "opacity-60")} disabled={!!working}>
                        {working === "merge" ? <Loader2 className="animate-spin" /> : <GitMerge />} Merge
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void act("merge", () => gh.merge(cwd, pr.number, "merge"))}>Merge commit</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void act("merge", () => gh.merge(cwd, pr.number, "squash"))}>Squash and merge</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void act("merge", () => gh.merge(cwd, pr.number, "rebase"))}>Rebase and merge</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {canCreate && !creating && (
        <div className="px-3 py-3">
          <div className="mb-2 text-xs text-muted-foreground">
            No pull request for <span className="font-mono">{branch}</span>.
            {status?.aheadOfBase != null && ` ${status.aheadOfBase} commit${status.aheadOfBase === 1 ? "" : "s"} ahead of ${status.defaultBranch}.`}
          </div>
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)} disabled={!status?.aheadOfBase}>
            Create pull request
          </Button>
        </div>
      )}
      {creating && (
        <form
          className="flex flex-col gap-2 px-3 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act("create", () => gh.create(cwd, title.trim(), body, status?.defaultBranch ?? null, draft)).then(() => {
              setCreating(false);
              setTitle("");
              setBody("");
            });
          }}
        >
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            className="h-8 rounded-md border border-hairline bg-transparent px-2 text-[13px] outline-none focus:border-ring"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Description (markdown)"
            className="rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-ring"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
          </label>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="accent" type="submit" disabled={!title.trim() || !!working}>
              {working === "create" ? <Loader2 className="animate-spin" /> : null} Create
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!loading && prs.length === 0 && !canCreate && status && (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          {status.branch === status.defaultBranch ? "On the default branch; nothing to open a pull request from." : "Nothing here yet."}
        </div>
      )}
    </div>
  );
}
