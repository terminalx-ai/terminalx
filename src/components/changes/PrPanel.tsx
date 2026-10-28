import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, CircleDot, ExternalLink, GitMerge, GitPullRequestDraft, Loader2, RefreshCw, X } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type PullRequest } from "@/lib/api";
import { sessionPrs, type SessionPr } from "@/lib/sessionPrs";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { requestMergedSweep } from "@/lib/mergedCleanup";
import { canDeleteMergedWorkspace } from "@/lib/workspaceRemoval";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import type { Landed, WorkspaceDisposition, WorkStatus } from "@/types/session";

type WorkspaceCleanup = {
  projectPath: string;
  onDelete: () => void;
};

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

export function PrPanel({
  cwd,
  sessionId,
  source: given,
  branch,
  active,
  busy,
  onSettle,
  workspace,
}: {
  cwd?: string;
  sessionId?: string;
  /** A cloud repository (PRO-27); without it, the local checkout at `cwd`. */
  source?: GitSource;
  branch: string | null;
  active: boolean;
  busy: boolean;
  /** Offered when a PR from this branch has merged and a worktree remains. */
  onSettle?: () => void;
  /** A managed workspace that can use the guarded workspace cleanup flow. */
  workspace?: WorkspaceCleanup;
}) {
  const source = useMemo(() => given ?? localGitSource(cwd ?? ""), [given, cwd]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [rows, setRows] = useState<SessionPr[]>([]);
  const selection = `${sessionId ?? ""}\0${source.key}\0${branch ?? ""}`;
  const selected = useRef({ key: selection, generation: 0 });
  if (selected.current.key !== selection) selected.current = { key: selection, generation: selected.current.generation + 1 };
  const generation = selected.current.generation;
  const [loadedSelection, setLoadedSelection] = useState<string | null>(null);
  const visibleRows = loadedSelection === selection ? rows : [];
  const prs = visibleRows.flatMap((row) => row.pr ? [row.pr] : []);
  const [landed, setLanded] = useState<Pick<Landed, "safe" | "head" | "branch"> | null>(null);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [checkedWorkspace, setCheckedWorkspace] = useState<{ key: string; disposition: WorkspaceDisposition } | null>(null);
  // Loading from the start: no pull requests is only said once they have been read.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [base, setBase] = useState<string | null>(null);
  const [bases, setBases] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const workspaceKey = workspace ? `${workspace.projectPath}\0${cwd}\0${branch ?? ""}` : null;

  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    source.ghAvailable().then((value) => !cancelled && setAvailable(value)).catch(() => !cancelled && setAvailable(false));
    return () => { cancelled = true; };
  }, [source]);

  useEffect(() => {
    if (!active || !available) return;
    let cancelled = false;
    setLoading(true);
    setCheckedWorkspace(null);
    const dispositionRequest = workspace && workspaceKey
      ? api.workspaceDisposition(workspace.projectPath, cwd ?? "").then((disposition) => ({ key: workspaceKey, disposition }))
      : Promise.resolve(null);
    Promise.all([
      source.workStatus().then(async (workStatus) => {
        const pullRequests = await sessionPrs(source, sessionId, workStatus.branch !== workStatus.defaultBranch ? workStatus.branch : null, () => !cancelled);
        const needsLandedCheck = (workStatus.aheadOfBase ?? 0) > 0
          && pullRequests.rows.some((row) => row.current && row.pr?.state === "MERGED");
        const landedWork = !cancelled && needsLandedCheck && source.landed ? await source.landed() : null;
        return { workStatus, pullRequests, landedWork };
      }),
      dispositionRequest,
    ])
      .then(([{ pullRequests, workStatus, landedWork }, workspaceCheck]) => {
        if (cancelled) return;
        setRows(pullRequests.rows);
        setLoadedSelection(selection);
        setStatus(workStatus);
        setLanded(landedWork);
        setCheckedWorkspace(workspaceCheck);
        setError(pullRequests.error ?? null);
      })
      .catch((e) => {
        if (cancelled) return;
        setCheckedWorkspace(null);
        setError(source.errorMessage(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [source, sessionId, selection, branch, active, available, tick, busy, workspaceKey]);

  useEffect(() => {
    setStatus(null);
    setLanded(null);
    setError(null);
    setNotice(null);
    setCreating(false);
    setTitle("");
    setBody("");
    setWorking(null);
  }, [selection]);

  // Base branches to choose from when creating: the remote's, then local ones.
  useEffect(() => {
    if (!creating) return;
    let cancelled = false;
    source
      .branches()
      .then((all) => {
        if (cancelled || !Array.isArray(all)) return;
        const names = new Set<string>();
        for (const b of all) if (b.remote && b.name.startsWith("origin/")) names.add(b.name.slice("origin/".length));
        for (const b of all) if (!b.remote) names.add(b.name);
        if (branch) names.delete(branch);
        setBases([...names].sort());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, creating, branch]);

  // Also discover externally created follow-ups when all known PRs are closed.
  useEffect(() => {
    if (!active || loading || working) return;
    const id = window.setTimeout(() => setTick((t) => t + 1), 30_000);
    return () => window.clearTimeout(id);
  }, [active, loading, working, tick]);

  const act = async (label: string, fn: () => Promise<string | null | void>) => {
    setWorking(label);
    setError(null);
    setNotice(null);
    try {
      const said = await fn();
      if (selected.current.generation !== generation) return false;
      if (said) setNotice(said);
      setTick((t) => t + 1);
      return true;
    } catch (e) {
      if (selected.current.generation !== generation) return false;
      setError(source.errorMessage(e));
      // A refusal may still have changed something (a lost answer): read GitHub again.
      setTick((t) => t + 1);
      return false;
    } finally {
      if (selected.current.generation === generation) setWorking(null);
    }
  };

  /** Merged from here: where workspaces are removed once merged, this one is looked at now rather than at the next pass. */
  const merge = (row: SessionPr, method: "merge" | "squash" | "rebase") =>
    void act("merge", () => row.association && source.prAccess ? source.prAccess(row.association).merge(method) : source.mergePr(row.pr!.number, method)).then((done) => {
      if (done) void requestMergedSweep();
    });

  if (available === false) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        Pull requests need the GitHub CLI. Install <span className="font-mono">gh</span> and run <span className="font-mono">gh auth login</span>.
      </div>
    );
  }

  const open = prs.filter((p) => p.state === "OPEN");
  const currentBranch = status?.branch ?? branch;
  const fresh = loadedSelection === selection && !loading && !error && !visibleRows.some((row) => row.error);
  const currentOpen = visibleRows.some((row) => row.current && row.pr?.state === "OPEN");
  const workLanded = status?.aheadOfBase === 0 || !!(landed?.safe && landed.head === status?.head && landed.branch === currentBranch);
  const needsLandedProof = visibleRows.some((row) => row.current && row.pr?.state === "MERGED");
  const canCreate = fresh && (!needsLandedProof || landed !== null) && !workLanded && !currentOpen && status && status.defaultBranch && currentBranch && currentBranch !== status.defaultBranch && (status.aheadOfBase ?? 0) > 0;
  const latestCurrent = visibleRows.filter((row) => row.current && row.pr?.head === currentBranch).sort((a, b) => (b.pr?.number ?? 0) - (a.pr?.number ?? 0))[0]?.pr;
  const merged = fresh && !busy && latestCurrent?.state === "MERGED" && open.length === 0
    && status && !status.dirty && status.ahead === 0 && workLanded;
  const canDelete = !!workspaceKey && checkedWorkspace?.key === workspaceKey
    && checkedWorkspace.disposition.branch === currentBranch && checkedWorkspace.disposition.pr?.url === latestCurrent?.url
    && canDeleteMergedWorkspace(checkedWorkspace.disposition);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto scrollbar-thin">
      <div className="flex justify-end px-3 pt-2">
        <Button size="xs" variant="ghost" disabled={loading || !!working} onClick={() => setTick((t) => t + 1)} aria-label="Refresh pull requests">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
        </Button>
      </div>
      {error && <div role="alert" className="mx-3 mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
      {notice && <div role="status" className="mx-3 mt-2 rounded-md bg-well px-2 py-1 text-xs text-muted-foreground">{notice}</div>}
      {(workspace || onSettle) && merged && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-md bg-merged/10 px-2 py-1.5 text-xs">
          <GitMerge className="size-3.5 shrink-0 text-merged" />
          <span className="flex-1 text-foreground">This branch has been merged.</span>
          {canDelete ? (
            <Button size="xs" variant="outline" onClick={workspace?.onDelete}>
              Delete workspace
            </Button>
          ) : onSettle && !workspace ? (
            <Button size="xs" variant="outline" onClick={onSettle}>
              Settle worktree
            </Button>
          ) : null}
        </div>
      )}
      {loading && prs.length === 0 && <div className="px-3 py-3 text-xs text-faint">Loading…</div>}
      {visibleRows.map((row) => {
        const pr = row.pr;
        if (!pr) return <div key={row.identity} role="alert" className="border-b border-hairline px-3 py-3 text-xs">
          <button type="button" onClick={() => void openUrl(row.identity)} className="hover:underline">{row.identity}</button>
          <div className="text-destructive">Could not refresh: {row.error}</div>
        </div>;
        const ready = mergeReadiness(pr);
        return (
          <div key={row.identity} className="border-b border-hairline px-3 py-3">
            <div className="flex items-start gap-2">
              {pr.state === "MERGED" ? (
                <GitMerge className="mt-0.5 size-4 shrink-0 text-merged" />
              ) : pr.state === "OPEN" && pr.isDraft ? (
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
                  #{pr.number} · {pr.state === "OPEN" ? (pr.isDraft ? "Draft" : "Open") : pr.state === "MERGED" ? "Merged" : "Closed"} · {pr.url.replace(/^https:\/\//, "").replace(/\/pull\/\d+\/?$/, "")}
                  <br /><span className="font-mono">{pr.head}</span> into <span className="font-mono">{pr.base}</span> · <span className="text-add">+{pr.additions}</span>{" "}
                  <span className="text-destructive">−{pr.deletions}</span>
                </div>
              </div>
            </div>
            {pr.checks.length > 0 && (
              <div className="mt-2 flex flex-col gap-0.5">
                {pr.checks.map((c) => (
                  <div key={c.name} aria-label={`${c.name}: ${c.state}`} className="flex items-center gap-2 text-xs">
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
                  {pr.isDraft && source.canWrite && (
                    <Button size="sm" variant="secondary" disabled={!!working || loading || !fresh} onClick={() => void act("ready", () => row.association && source.prAccess ? source.prAccess(row.association).ready() : source.readyPr(pr.number))}>
                      Mark ready
                    </Button>
                  )}
                  {source.canWrite && <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" className={cn("bg-merge text-merge-foreground hover:opacity-90", !ready.ok && "opacity-60")} disabled={!!working || loading || !fresh || !ready.ok}>
                        {working === "merge" ? <Loader2 className="animate-spin" /> : <GitMerge />} Merge
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => merge(row, "merge")}>Merge commit</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => merge(row, "squash")}>Squash and merge</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => merge(row, "rebase")}>Rebase and merge</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {canCreate && !creating && source.canWrite && (
        <div className="px-3 py-3">
          <div className="mb-2 text-xs text-muted-foreground">
            No pull request for <span className="font-mono">{currentBranch}</span>.
            {status?.aheadOfBase != null && ` ${status.aheadOfBase} commit${status.aheadOfBase === 1 ? "" : "s"} ahead of ${status.defaultBranch}.`}
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setBase(status?.defaultBranch ?? null);
              setCreating(true);
            }}
            disabled={!status?.aheadOfBase}
          >
            Create pull request
          </Button>
        </div>
      )}
      {creating && (
        <form
          className="flex flex-col gap-2 px-3 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act("create", () => source.createPr({ title: title.trim(), body, base: base ?? status?.defaultBranch ?? null, draft, sessionId })).then((ok) => {
              if (!ok) return;
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
            Into
            <select
              aria-label="Base branch"
              value={base ?? ""}
              onChange={(e) => setBase(e.target.value || null)}
              className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-1 font-mono text-xs outline-none focus:border-ring"
            >
              {[...new Set([base ?? status?.defaultBranch ?? "", ...bases])].filter(Boolean).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
          </label>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="accent" type="submit" disabled={!title.trim() || !!working || !fresh || !!currentOpen}>
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
