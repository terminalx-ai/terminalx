import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleDot, ExternalLink, Maximize2, GitMerge, GitPullRequestDraft, Loader2, RefreshCw, X } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type PrCheck, type PullRequest, type PrAssociation } from "@/lib/api";
import { openPr } from "@/lib/editors";
import { WithTooltip } from "@/components/ui/tooltip";
import { Markdown } from "@/components/chat/Markdown";
import { prIdentity, sessionPrs, type SessionPr } from "@/lib/sessionPrs";
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
import { NextLine } from "./NextStep";

type WorkspaceCleanup = {
  projectPath: string;
  onDelete: () => void;
};

/** GitHub's lifecycle and queue take precedence over head-branch checks. */
export function mergeReadiness(pr: PullRequest): { ok: boolean; label: string } {
  const blocked = (label: string) => ({ ok: false, label });
  if (pr.state === "MERGED") return blocked("Merged");
  if (pr.state === "CLOSED") return blocked("Closed");
  if (pr.isDraft) return blocked("Draft");
  if (pr.detailsError) return blocked("Merge details unavailable");
  if (pr.mergeQueueEntry) {
    switch (pr.mergeQueueEntry.state) {
      case "AWAITING_CHECKS": return blocked("Checks running in queue");
      case "UNMERGEABLE": return blocked("Blocked in queue");
      case "LOCKED": return blocked("Locked");
      default: return blocked(`Queued (position ${pr.mergeQueueEntry.position})`);
    }
  }
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") return blocked("Has conflicts");
  if (pr.mergeQueueEnabled && pr.autoMergeEnabled) return blocked("Waiting to enter merge queue");
  if (pr.mergeState === "BLOCKED") return blocked("Blocked");
  if (pr.mergeState === "BEHIND") return blocked("Behind base");
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") return blocked("Blocked");
  const counts = checkCounts(pr.checks.filter((check) => pr.requiredChecks == null || pr.requiredChecks.includes(check.name)));
  if (pr.mergeState === "UNSTABLE" && !counts.failed && !counts.running && !counts.unknown && pr.mergeable === "MERGEABLE") {
    return { ok: true, label: "Unstable: optional checks failing" };
  }
  if (counts.failed) return blocked("Checks failing");
  if (counts.running) return blocked("Checks running");
  if (counts.unknown || pr.mergeable === "UNKNOWN" || pr.mergeState === "UNKNOWN") return blocked("Checking mergeability");
  return { ok: true, label: "Ready to merge" };
}

function canQueue(pr: PullRequest): boolean {
  return pr.state === "OPEN" && pr.mergeQueueEnabled === true && !pr.mergeQueueEntry && !pr.autoMergeEnabled
    && !pr.isDraft && !pr.detailsError && pr.mergeable !== "CONFLICTING" && pr.mergeState !== "DIRTY";
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
  inline = false,
  held = false,
  selectedPr,
}: {
  cwd?: string;
  /** A centre tab stays on this exact PR, even after the branch changes. */
  selectedPr?: PrAssociation;
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
  /** A section of the Branch tab, scrolled with it, rather than a panel of its own. */
  inline?: boolean;
  /**
   * The branch has a step of its own to take first (inline only): the pull
   * request is shown, but what to do with it (open one, mark ready, merge)
   * waits, so there is one next step on the tab, not two.
   */
  held?: boolean;
}) {
  const source = useMemo(() => given ?? localGitSource(cwd ?? ""), [given, cwd]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [rows, setRows] = useState<SessionPr[]>([]);
  const selection = `${sessionId ?? ""}\0${source.key}\0${branch ?? ""}\0${selectedPr?.url ?? ""}`;
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
  /** A failed read is said quietly inline; a failed click, plainly. */
  const [errorFrom, setErrorFrom] = useState<"load" | "action">("load");
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
        const pullRequests: { rows: SessionPr[]; error?: string } = selectedPr
          ? { rows: [{ identity: selectedPr.url, association: selectedPr, current: workStatus.branch === selectedPr.head, pr: await source.prAccess!(selectedPr).read() }] }
          : await sessionPrs(source, sessionId, workStatus.branch !== workStatus.defaultBranch ? workStatus.branch : null, () => !cancelled);
        if (selectedPr && prIdentity(pullRequests.rows[0].pr!.url) !== prIdentity(selectedPr.url)) throw new Error("GitHub returned a different pull request.");
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
        setErrorFrom("load");
      })
      .catch((e) => {
        if (cancelled) return;
        setCheckedWorkspace(null);
        setError(source.errorMessage(e));
        setErrorFrom("load");
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
      setErrorFrom("action");
      // A refusal may still have changed something (a lost answer): read GitHub again.
      setTick((t) => t + 1);
      return false;
    } finally {
      if (selected.current.generation === generation) setWorking(null);
    }
  };

  /** Merged from here: where workspaces are removed once merged, this one is looked at now rather than at the next pass. */
  const merge = (row: SessionPr, method: "merge" | "squash" | "rebase" | "queue") =>
    void act("merge", () => row.association && source.prAccess ? source.prAccess(row.association).merge(method) : source.mergePr(row.pr!.number, method)).then((done) => {
      if (done) void requestMergedSweep();
    });

  if (available === false) {
    if (inline) return held ? null : <div><NextLine tone="muted" text={<>Install <span className="font-mono">gh</span> and run <span className="font-mono">gh auth login</span> to open a pull request</>} /></div>;
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        Pull requests need the GitHub CLI. Install <span className="font-mono">gh</span> and run <span className="font-mono">gh auth login</span>.
      </div>
    );
  }

  const openInTab = !selectedPr && !source.cloud && cwd ? (row: SessionPr) => {
    const pr = row.pr!;
    openPr(sessionId ?? `checkout:${cwd}`, cwd, row.association ?? { url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd } });
  } : undefined;
  const open = prs.filter((p) => p.state === "OPEN");
  const currentBranch = status?.branch ?? branch;
  const fresh = loadedSelection === selection && !loading && !error && !visibleRows.some((row) => row.error);
  const currentOpen = visibleRows.some((row) => row.current && row.pr?.state === "OPEN");
  const workLanded = status?.aheadOfBase === 0 || !!(landed?.safe && landed.head === status?.head && landed.branch === currentBranch);
  const needsLandedProof = visibleRows.some((row) => row.current && row.pr?.state === "MERGED");
  const canCreate = !selectedPr && fresh && (!needsLandedProof || landed !== null) && !workLanded && !currentOpen && status && status.defaultBranch && currentBranch && currentBranch !== status.defaultBranch && (status.aheadOfBase ?? 0) > 0;
  const latestCurrent = visibleRows.filter((row) => row.current && row.pr?.head === currentBranch).sort((a, b) => (b.pr?.number ?? 0) - (a.pr?.number ?? 0))[0]?.pr;
  const merged = fresh && !busy && latestCurrent?.state === "MERGED" && open.length === 0
    && status && !status.dirty && status.ahead === 0 && workLanded;
  const canDelete = !!workspaceKey && checkedWorkspace?.key === workspaceKey
    && checkedWorkspace.disposition.branch === currentBranch && checkedWorkspace.disposition.pr?.url === latestCurrent?.url
    && canDeleteMergedWorkspace(checkedWorkspace.disposition);

  return (
    <div className={cn("flex flex-col", inline ? "gap-2" : "h-full min-h-0 overflow-y-auto scrollbar-thin")}>
      {/* Inline, the tab's own refresh reads it again, and it is read every 30 seconds besides. */}
      {!inline && (
        <div className="flex items-center justify-end px-3 pt-2">
          <Button size="xs" variant="ghost" disabled={loading || !!working} onClick={() => setTick((t) => t + 1)} aria-label="Refresh pull requests">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      )}
      {error && inline && errorFrom === "load" ? (
        // Not reaching GitHub is no fault of the reader's: said once, quietly, the detail on hover.
        <p className="px-4 text-[11px] text-faint" title={error} data-testid="pr-unreachable">Can't reach GitHub right now. Pull requests will show when it answers.</p>
      ) : error && <div role="alert" className="mx-3 mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
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
      {loading && prs.length === 0 && !inline && <div className="px-3 py-3 text-xs text-faint">Loading…</div>}
      {visibleRows.map((row) => {
        const pr = row.pr;
        if (!pr) return <div key={row.identity} role="alert" className="border-b border-hairline px-3 py-3 text-xs">
          <button type="button" onClick={() => void openUrl(row.identity)} className="hover:underline">{row.identity}</button>
          <div className="text-destructive">Could not refresh: {row.error}</div>
        </div>;
        const ready = mergeReadiness(pr);
        if (inline) return <InlinePr key={row.identity} onOpen={openInTab ? () => openInTab(row) : undefined} pr={pr} ready={ready} held={held} actions={pr.state === "OPEN" && source.canWrite && (
          <>
            {pr.isDraft && (
              <Button size="xs" variant="secondary" disabled={!!working || loading || !fresh} onClick={() => void act("ready", () => row.association && source.prAccess ? source.prAccess(row.association).ready() : source.readyPr(pr.number))}>
                {working === "ready" && <Loader2 className="animate-spin" />} Mark ready
              </Button>
            )}
            {canQueue(pr) && <Button size="xs" disabled={!!working || loading || !fresh} onClick={() => merge(row, "queue")}>Add to merge queue</Button>}
            {ready.ok && !pr.mergeQueueEnabled && <MergeMenu disabled={!!working || loading || !fresh} working={working === "merge"} onMerge={(method) => merge(row, method)} />}
          </>
        )} />;
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
              {openInTab && <WithTooltip label={`Open PR #${pr.number} in centre tab`}><Button size="icon-xs" variant="ghost" aria-label={`Open PR #${pr.number} in centre tab`} onClick={() => openInTab(row)}><Maximize2 /></Button></WithTooltip>}
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
            {selectedPr && pr.body && <div className="my-3 select-text"><Markdown text={pr.body} className="prose-chat" remoteImages={false} /></div>}
            {pr.state === "OPEN" && pr.mergeQueueEntry && <p className="mt-2 text-[11px] text-faint">Queue position {pr.mergeQueueEntry.position}</p>}
            <PrChecks pr={pr} />
            <Deployments pr={pr} />
            {pr.detailsError && <p role="alert" className="mt-2 text-xs text-destructive">Could not refresh merge details: {pr.detailsError}</p>}
            {pr.state === "OPEN" && (
              <div className="mt-3 flex items-center gap-2">
                <span className={cn("text-xs", ready.ok && pr.mergeState !== "UNSTABLE" ? "text-add" : "text-muted-foreground")}>{ready.label}</span>
                <div className="ml-auto flex items-center gap-1">
                  {pr.isDraft && source.canWrite && (
                    <Button size="sm" variant="secondary" disabled={!!working || loading || !fresh} onClick={() => void act("ready", () => row.association && source.prAccess ? source.prAccess(row.association).ready() : source.readyPr(pr.number))}>
                      Mark ready
                    </Button>
                  )}
                  {source.canWrite && canQueue(pr) && <Button size="sm" disabled={!!working || loading || !fresh} onClick={() => merge(row, "queue")}>Add to merge queue</Button>}
                  {source.canWrite && !pr.mergeQueueEnabled && <DropdownMenu>
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

      {inline && canCreate && !creating && source.canWrite && !held && (
        <div>
          <NextLine
            tone="good"
            text={`Open a pull request into ${status?.defaultBranch ?? "the base"}`}
            actions={
              <Button size="xs" variant="accent" onClick={() => { setBase(status?.defaultBranch ?? null); setCreating(true); }} disabled={!status?.aheadOfBase}>
                Create pull request
              </Button>
            }
          />
        </div>
      )}
      {!inline && canCreate && !creating && source.canWrite && (
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
      {!inline && !loading && prs.length === 0 && !canCreate && status && (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          {status.branch === status.defaultBranch ? "On the default branch; nothing to open a pull request from." : "Nothing here yet."}
        </div>
      )}
    </div>
  );
}

const FAILING = ["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"];
const RUNNING = ["pending", "in_progress", "queued", "expected", "waiting", "requested"];

function checkBucket(state: string): "passed" | "failed" | "running" | "skipped" | "unknown" {
  if (FAILING.includes(state)) return "failed";
  if (RUNNING.includes(state)) return "running";
  if (state === "success") return "passed";
  if (state === "neutral" || state === "skipped") return "skipped";
  return "unknown";
}

export function checkCounts(checks: PrCheck[]) {
  const counts = { total: checks.length, passed: 0, failed: 0, running: 0, skipped: 0, unknown: 0 };
  for (const check of checks) counts[checkBucket(check.state)]++;
  return counts;
}

export function checkSummary(checks: PrCheck[]): string {
  const c = checkCounts(checks);
  const result = c.failed ? `${c.failed} of ${c.total} failed` : `${c.passed} of ${c.total} passed`;
  return [result, c.running && `${c.running} running`, c.skipped && `${c.skipped} skipped`, c.unknown && `${c.unknown} unknown`].filter(Boolean).join(" · ");
}

function CheckIcon({ state }: { state: string }) {
  const bucket = checkBucket(state);
  if (bucket === "running") return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  if (bucket === "passed") return <Check className="size-3.5 shrink-0 text-add" />;
  if (bucket === "skipped") return <CircleDot className="size-3.5 shrink-0 text-faint" />;
  return <CircleAlert className={cn("size-3.5 shrink-0", bucket === "failed" ? "text-destructive" : "text-faint")} />;
}

/** Provider URLs are untrusted data; only web links may leave the app. */
function webUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function CheckRows({ pr }: { pr: PullRequest }) {
  return <>{pr.checks.map((check, index) => {
    const requirement = pr.requiredChecks == null ? "Requirement unknown" : pr.requiredChecks.includes(check.name) ? "Required" : "Optional";
    const url = webUrl(check.url);
    return <div key={`${check.name}:${index}`} aria-label={`${check.name}: ${check.state}`} className="flex items-center gap-2 text-xs">
      <CheckIcon state={check.state} />
      {url ? <button type="button" onClick={() => void openUrl(url)} className="truncate text-left text-muted-foreground hover:underline">{check.name}</button> : <span className="truncate text-muted-foreground">{check.name}</span>}
      <span className="ml-auto shrink-0 text-[10px] text-faint">{requirement}</span>
    </div>;
  })}</>;
}

function PrChecks({ pr }: { pr: PullRequest }) {
  if (!pr.checks.length) return null;
  return <div className="mt-2 flex flex-col gap-0.5">
    <p className="mb-1 text-[11px] text-muted-foreground">{checkSummary(pr.checks)}</p>
    <CheckRows pr={pr} />
  </div>;
}

function Deployments({ pr }: { pr: PullRequest }) {
  if (!pr.deployments?.length) return null;
  return <section aria-label="Deployments" className="mt-2 flex flex-col gap-1">
    <h4 className="text-[11px] font-medium text-muted-foreground">Deployments</h4>
    {pr.deployments.map((deployment, index) => {
      const url = webUrl(deployment.url);
      return <div key={`${deployment.name}:${index}`} className="flex min-w-0 items-center gap-2 text-xs">
        <CheckIcon state={deployment.state} />
        <span className="truncate text-muted-foreground">{deployment.name}</span>
        {url && <button type="button" onClick={() => void openUrl(url)} title={url} className="min-w-0 truncate text-faint hover:underline">{url}</button>}
      </div>;
    })}
  </section>;
}

function reviewLabel(decision: string): string {
  return decision === "APPROVED" ? "approved" : decision === "CHANGES_REQUESTED" ? "changes requested" : decision === "REVIEW_REQUIRED" ? "review required" : decision.toLowerCase();
}

/**
 * A pull request as one line of the Branch tab: its title (opens it), its
 * number and state, its checks folded into a count (unfolded when one fails),
 * then, unless the branch has a step first, what to do with it now.
 */
function InlinePr({ pr, ready, held, actions, onOpen }: { onOpen?: () => void; pr: PullRequest; ready: { ok: boolean; label: string }; held: boolean; actions: ReactNode }) {
  const failing = pr.checks.filter((c) => FAILING.includes(c.state)).length;
  const [checksOpen, setChecksOpen] = useState(failing > 0);
  useEffect(() => {
    if (failing > 0) setChecksOpen(true);
  }, [failing]);
  const state = pr.state === "OPEN" ? (pr.isDraft ? "Draft" : "Open") : pr.state === "MERGED" ? "Merged" : "Closed";
  const tone = ready.ok && pr.mergeState !== "UNSTABLE" ? "good" : failing > 0 || pr.mergeable === "CONFLICTING" || pr.reviewDecision === "CHANGES_REQUESTED" ? "bad" : "muted";
  return (
    <div className="flex flex-col gap-1.5 px-3" data-testid="branch-pr">
      <div className="flex min-w-0 items-center gap-2 px-1">
        {pr.state === "MERGED" ? (
          <GitMerge className="size-3.5 shrink-0 text-merged" />
        ) : pr.state === "OPEN" && pr.isDraft ? (
          <GitPullRequestDraft className="size-3.5 shrink-0 text-muted-foreground" />
        ) : pr.state === "OPEN" ? (
          <CircleDot className="size-3.5 shrink-0 text-add" />
        ) : (
          <X className="size-3.5 shrink-0 text-destructive" />
        )}
        <button type="button" onClick={() => void openUrl(pr.url)} className="group flex min-w-0 flex-1 items-center gap-1 text-left text-xs hover:underline" title={pr.title}>
          <span className="truncate text-foreground">{pr.title}</span>
          <ExternalLink className="size-3 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
        </button>
        {onOpen && <WithTooltip label={`Open PR #${pr.number} in centre tab`}><Button size="icon-xs" variant="ghost" aria-label={`Open PR #${pr.number} in centre tab`} onClick={onOpen}><Maximize2 /></Button></WithTooltip>}
        <span className="shrink-0 text-[11px] text-faint">
          #{pr.number} · {state}
        </span>
      </div>
      {pr.checks.length > 0 && (
        <div className="px-1 pl-6.5">
          <button type="button" onClick={() => setChecksOpen((v) => !v)} aria-expanded={checksOpen} className="flex items-center gap-1 text-[11px] text-faint hover:text-foreground" data-testid="branch-pr-checks">
            {checksOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {checkSummary(pr.checks)}
          </button>
          {checksOpen && <div className="mt-0.5 flex flex-col gap-0.5"><CheckRows pr={pr} /></div>}
        </div>
      )}
      <Deployments pr={pr} />
      {pr.detailsError && <p role="alert" className="text-xs text-destructive">Could not refresh merge details: {pr.detailsError}</p>}
      {pr.state === "OPEN" && held && pr.mergeQueueEntry && <p className="px-1 text-[11px] text-muted-foreground">{ready.label}</p>}
      {pr.state === "OPEN" && pr.mergeQueueEntry && pr.mergeQueueEntry.state !== "QUEUED" && pr.mergeQueueEntry.state !== "MERGEABLE" && <p className="px-1 text-[11px] text-faint">Queue position {pr.mergeQueueEntry.position}</p>}
      {pr.state === "OPEN" && !held && (
        <NextLine tone={tone} text={`${ready.label}${pr.reviewDecision ? ` · ${reviewLabel(pr.reviewDecision)}` : ""}`} actions={actions || undefined} />
      )}
    </div>
  );
}

function MergeMenu({ disabled, working, onMerge }: { disabled: boolean; working: boolean; onMerge: (method: "merge" | "squash" | "rebase") => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" className="bg-merge text-merge-foreground hover:opacity-90" disabled={disabled}>
          {working ? <Loader2 className="animate-spin" /> : <GitMerge />} Merge
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onMerge("merge")}>Merge commit</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMerge("squash")}>Squash and merge</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMerge("rebase")}>Rebase and merge</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
