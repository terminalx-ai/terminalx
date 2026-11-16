import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleDot, ExternalLink, Maximize2, GitMerge, GitPullRequest, GitPullRequestDraft, Loader2, RefreshCw, Unplug, X } from "@/icons";
import type { PrConversation as Conversation } from "@terminalx/portable/workspaceGit";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { api, type GitHubConnectionStatus, type PullRequest, type PrAssociation } from "@/lib/api";
import { openPr } from "@/lib/editors";
import { WithTooltip } from "@/components/ui/tooltip";
import { prErrorKind } from "@/lib/prErrors";
import { AddRemote, CommandDetails, GitError, GitHubSetup } from "./GitRecovery";
import { prIdentity, sessionPrs, type SessionPr } from "@/lib/sessionPrs";
import { onPrLinksChanged, unlinkPr } from "@/lib/prLinks";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { getMergedCleanup, holdMergedWorkspace, LOCAL_HOST, mergedCleanupOn, requestMergedSweep, useMergedCleanup } from "@/lib/mergedCleanup";
import { noteMerge } from "@/lib/mergeMethods";
import { useSessionStore } from "@/lib/sessions";
import { pipelineSettings } from "@/lib/issuePipeline";
import { canDeleteMergedWorkspace } from "@/lib/workspaceRemoval";
import type { Landed, WorkspaceDisposition, WorkStatus } from "@/types/session";
import { Deployments, PrChecks } from "./PrChecks";
import { actionsRuns, checkCounts, checkSummary, isFailingCheck, runSignature, withPendingChecks, type PendingCheckRun } from "@/lib/checks";
import { NextLine } from "./NextStep";
import { PrConversation, SectionHead, useDocumentVisible } from "./PrConversation";
import { MergeMenu, type MergeChoices } from "./MergeMenu";
import { MergedWorkspaceStep } from "./MergedWorkspaceStep";
import { ReviewThreads } from "./ReviewThreads";
import { noteSessionPrs } from "@/lib/reviewThreads";

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
  onFixErrors,
  fixBusy = false,
}: {
  cwd?: string;
  /** A centre tab stays on this exact PR, even after the branch changes. */
  selectedPr?: PrAssociation;
  onFixErrors?: (pr: PullRequest) => Promise<unknown>;
  fixBusy?: boolean;
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
  const documentVisible = useDocumentVisible();
  active = active && documentVisible;
  const source = useMemo(() => given ?? localGitSource(cwd ?? ""), [given, cwd]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<GitHubConnectionStatus | null>(null);
  const [loginSource, setLoginSource] = useState<GitSource | null>(null);
  const connecting = loginSource === source;
  const [hasRemote, setHasRemote] = useState<boolean | null>(null);
  const [pendingRuns, setPendingRuns] = useState<PendingCheckRun[]>([]);
  const [rows, setRows] = useState<SessionPr[]>([]);
  const selection = `${sessionId ?? ""}\0${source.key}\0${branch ?? ""}\0${selectedPr?.url ?? ""}`;
  const selected = useRef({ key: selection, generation: 0 });
  if (selected.current.key !== selection) selected.current = { key: selection, generation: selected.current.generation + 1 };
  const generation = selected.current.generation;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [loadedSelection, setLoadedSelection] = useState<string | null>(null);
  const visibleRows = loadedSelection === selection ? rows.map((row) => row.pr ? { ...row, pr: withPendingChecks(row.pr, pendingRuns) } : row) : [];
  const prs = visibleRows.flatMap((row) => row.pr ? [row.pr] : []);
  const [landed, setLanded] = useState<Pick<Landed, "safe" | "head" | "branch"> | null>(null);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [checkedWorkspace, setCheckedWorkspace] = useState<{ key: string; disposition: WorkspaceDisposition } | null>(null);
  // Loading from the start: no pull requests is only said once they have been read.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** A failed read is said quietly inline; a failed click, plainly. */
  const [errorFrom, setErrorFrom] = useState<"load" | "action">("load");
  const actionError = useRef<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [base, setBase] = useState<string | null>(null);
  const [bases, setBases] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Conversation pagination is independent of check/discovery polling.
  const [conversationRefresh, setConversationRefresh] = useState(0);
  // What each conversation read said that the panel shows outside it: the merge menu's methods, who approved.
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const cleanup = useMergedCleanup();
  const store = useSessionStore();
  const project = store.projects.find((entry) => entry.path === store.sessions.find((entry) => entry.id === sessionId)?.projectPath);
  const shortcutMethod = project ? pipelineSettings(project).mergeMethod : null;
  const workspaceKey = workspace ? `${workspace.projectPath}\0${cwd}\0${branch ?? ""}` : null;

  useEffect(() => { setLoginSource(null); }, [source]);
  // A pull request linked or unlinked from the session's menu shows at once.
  useEffect(() => sessionId ? onPrLinksChanged((changed) => { if (changed === sessionId) setTick((t) => t + 1); }) : undefined, [sessionId]);

  useEffect(() => {
    // Returning from browser authentication must not unmount the login PTY.
    // Recheck after its dialog closes, even if credentials become valid sooner.
    if (!active || connecting) return;
    let cancelled = false;
    setAvailable(null);
    setConnection(null);
    setHasRemote(null);
    if (source.githubStatus) {
      Promise.all([source.githubStatus(), source.hasRemote?.() ?? Promise.resolve(true)]).then(([status, remote]) => {
        if (cancelled) return;
        setConnection(status);
        setHasRemote(remote);
        setAvailable(status.state === "connected" && remote);
      }).catch((error: unknown) => {
        if (!cancelled) setConnection({ state: "unavailable", details: source.errorMessage(error) });
      });
    } else {
      source.ghAvailable().then((value) => !cancelled && setAvailable(value)).catch(() => !cancelled && setAvailable(false));
    }
    return () => { cancelled = true; };
  }, [source, active, tick, connecting]);

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
        // The Changes view finds the same PR for its review threads without asking GitHub again (PRO-234).
        if (!selectedPr) noteSessionPrs(source, sessionId, pullRequests.rows.flatMap((row) => row.pr ? [row.pr] : []));
        setLoadedSelection(selection);
        setStatus(workStatus);
        setLanded(landedWork);
        setCheckedWorkspace(workspaceCheck);
        setError(pullRequests.error ?? actionError.current);
        setErrorFrom(pullRequests.error || !actionError.current ? "load" : "action");
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
    setPendingRuns([]);
    actionError.current = null;
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
    const id = window.setTimeout(() => setTick((t) => t + 1), pendingRuns.some((p) => p.until > Date.now()) ? 5_000 : 30_000);
    return () => window.clearTimeout(id);
  }, [active, loading, working, tick, pendingRuns]);

  const actionLock = useRef<number | null>(null);
  const act = async (label: string, fn: () => Promise<string | null | void>, reconcile = true) => {
    if (actionLock.current === generation) return false;
    actionLock.current = generation;
    actionError.current = null;
    setWorking(label);
    setError(null);
    setNotice(null);
    try {
      const said = await fn();
      if (!mounted.current || selected.current.generation !== generation) return false;
      if (said) setNotice(said);
      if (reconcile) setTick((t) => t + 1);
      return true;
    } catch (e) {
      if (!mounted.current || selected.current.generation !== generation) return false;
      actionError.current = source.errorMessage(e);
      setError(actionError.current);
      setErrorFrom("action");
      // Reconcile a lost answer, but a revoked action cannot start a fresh
      // generation of reads. Normal refresh/new actions remain available.
      if (reconcile && !actionError.current.includes(PRIVACY_MESSAGE)) setTick((t) => t + 1);
      return false;
    } finally {
      if (actionLock.current === generation) actionLock.current = null;
      if (mounted.current && selected.current.generation === generation) setWorking(null);
    }
  };

  const rerun = (pr: PullRequest, failedOnly: boolean) => void act("rerun", async () => {
    if (!source.canWrite || !source.rerunCheck || !source.checkAuthority) throw new Error("Re-running checks is unavailable here.");
    const checks = actionsRuns(pr, failedOnly);
    const authority = await source.checkAuthority();
    for (const check of checks) {
      // A navigation during a batch cancels the remaining outward actions.
      if (!mounted.current || selected.current.generation !== generation) return;
      await source.rerunCheck(pr.url, check.url!, failedOnly, authority);
      if (!mounted.current || selected.current.generation !== generation) return;
      const runId = check.actions!.runId;
      setPendingRuns((old) => [...old.filter((p) => p.until > Date.now() && !(p.prUrl === pr.url && p.runId === runId)), {
        prUrl: pr.url, runId, failedOnly, signature: runSignature(pr, runId), until: Date.now() + 60_000,
      }]);
    }
    return `Re-run requested for ${checks.length} Actions ${checks.length === 1 ? "run" : "runs"}.`;
  // An Actions reply can arrive after its ticket expires, including success or
  // an ordinary error. Keep its result, then let independent polling/manual
  // refresh read again; this old action cannot initiate unscoped reconciliation.
  }, false);

  /** Only a link made with "Link pull request…" (PRO-294) is undone; a PR the session opened stays. */
  const unlink = (row: SessionPr): (() => void) | undefined => {
    const association = row.association;
    if (selectedPr || !sessionId || !association?.linked) return undefined;
    return () => void act("unlink", async () => {
      await unlinkPr(sessionId, association.url);
      return `Unlinked #${association.number}. Its checks and review are no longer shown here.`;
    });
  };

  /** Merged from here: where workspaces are removed once merged, this one is looked at now rather than at the next pass. */
  const merge = (row: SessionPr, method: "merge" | "squash" | "rebase" | "queue", choices?: MergeChoices) =>
    void act("merge", async () => {
      await (row.association && source.prAccess ? source.prAccess(row.association).merge(method) : source.mergePr(row.pr!.number, method));
      if (method === "queue") return;
      noteMerge(row.pr!.url, method);
      if (choices?.deleteBranch && source.deleteMergedBranch) {
        try { await source.deleteMergedBranch(row.pr!.number, row.association?.url); }
        catch (e) { return `Merged. Its branch on GitHub was kept: ${source.errorMessage(e)}.`; }
      }
    }).then(async (done) => {
      if (!done) return;
      await requestMergedSweep();
      // "Archive this session after merge": where clean-up archives merged workspaces, unticking keeps this one;
      // where it does not, ticking opens the archive dialog, which says what would be lost first.
      if (!choices || !workspace || !cwd) return;
      const on = mergedCleanupOn(getMergedCleanup().settings, workspace.projectPath);
      if (!choices.archive && on) await holdMergedWorkspace(LOCAL_HOST, cwd, true).catch(() => {});
      else if (choices.archive && !on) workspace.onDelete();
    });
  const archiveDefault = (row: SessionPr) => workspace && cwd && row.current ? mergedCleanupOn(cleanup.settings, workspace.projectPath) : null;
  const mergeMenu = (row: SessionPr, size: "xs" | "sm", disabled: boolean) => {
    const pr = row.pr!;
    const read = conversations[row.identity];
    return <MergeMenu url={pr.url} base={pr.base} methods={read?.mergeMethods} commits={read?.commits} size={size} disabled={disabled} working={working === "merge"}
      archive={archiveDefault(row)} canDeleteBranch={!!source.deleteMergedBranch && !source.cloud} shortcutMethod={row.current ? shortcutMethod : null}
      onMerge={(method, choices) => merge(row, method, choices)} />;
  };

  if (connection && connection.state !== "connected") {
    return <GitHubSetup key={source.key} status={connection} onConnectingChange={(value) => setLoginSource(value ? source : null)} onRefresh={() => setTick((value) => value + 1)} />;
  }
  if (connection?.state === "connected" && hasRemote === false && source.addRemote) {
    return <AddRemote key={source.key} source={source} onDone={() => setTick((value) => value + 1)} />;
  }
  if (available === false) {
    if (inline) return held ? null : <div><NextLine tone="muted" text={<>Install <span className="font-mono">gh</span> and run <span className="font-mono">gh auth login</span> to open a pull request</>} /></div>;
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        GitHub is unavailable. Check the workspace’s GitHub connection and refresh.
      </div>
    );
  }

  const openInTab = !selectedPr && !source.cloud && cwd ? (row: SessionPr) => {
    const pr = row.pr!;
    openPr(sessionId ?? `checkout:${cwd}`, cwd, row.association ?? { url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd } });
  } : undefined;
  // The session's own pull requests: one linked from another branch (PRO-294) is only shown here, and says nothing of whether this branch is done.
  const ownWork = (row: SessionPr) => row.current || !row.association?.linked;
  const open = visibleRows.filter((row) => ownWork(row) && row.pr?.state === "OPEN");
  const currentBranch = status?.branch ?? branch;
  const fresh = loadedSelection === selection && !loading && (!error || errorFrom === "action") && !visibleRows.some((row) => row.error);
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
          <Button size="xs" variant="ghost" disabled={loading || !!working} onClick={() => { setTick((t) => t + 1); setConversationRefresh((value) => value + 1); }} aria-label="Refresh pull requests">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      )}
      {error && inline && errorFrom === "load" && !prErrorKind(error) ? (
        // Not reaching GitHub is no fault of the reader's: said once, quietly, the detail on hover.
        <p className="px-4 text-[11px] text-faint" title={error} data-testid="pr-unreachable">Can't reach GitHub right now. Pull requests will show when it answers.</p>
      ) : error && (source.cloud ? <div role="alert" className="mx-3 mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div> : <GitError details={error} onRetry={() => setTick((value) => value + 1)} onConnect={() => setConnection({ state: "signed_out", details: null, hostname: connection?.hostname })} />)}
      {notice && <div role="status" className="mx-3 mt-2 rounded-md bg-well px-2 py-1 text-xs text-muted-foreground">{notice}</div>}
      {/* In the Branch tab, the merged card's WHAT NEXT says this (design 05.12). */}
      {!inline && (workspace || onSettle) && merged && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-md bg-merged/10 px-2 py-1.5 text-xs">
          <GitMerge className="size-3.5 shrink-0 text-merged" />
          <span className="flex-1 text-foreground">This branch has been merged.</span>
          {canDelete ? (
            <Button size="xs" variant="outline" onClick={workspace?.onDelete}>
              Archive the session
            </Button>
          ) : onSettle && !workspace ? (
            <Button size="xs" variant="outline" onClick={onSettle}>
              Settle worktree
            </Button>
          ) : null}
        </div>
      )}
      {/* Clean-up's word on a merged workspace goes under the merged pull request's WHAT NEXT; with no such row shown
          (GitHub unreachable, say), it stands on its own here. */}
      {inline && cwd && !source.cloud && !visibleRows.some((row) => row.current && row.pr?.state === "MERGED") && <div className="px-3"><MergedWorkspaceStep cwd={cwd} /></div>}
      {loading && prs.length === 0 && !inline && <div className="px-3 py-3 text-xs text-faint">Loading…</div>}
      {visibleRows.map((row) => {
        const pr = row.pr;
        if (!pr) return <div key={row.identity} role="alert" className="border-b border-hairline px-3 py-3 text-xs">
          <button type="button" onClick={() => void openUrl(row.identity)} className="hover:underline">{row.identity}</button>
          <div className="text-destructive">Could not refresh this pull request.</div>
          <CommandDetails details={row.error} />
        </div>;
        const ready = mergeReadiness(pr);
        const reviews = <ReviewThreads source={source} url={pr.url} number={pr.number} sessionId={sessionId} active={active} prState={pr.state} />;
        const checks = <PrChecks pr={pr} source={source} showSummary={!inline} disabled={!!working || loading || !fresh} fixBusy={fixBusy}
          onRerun={(failedOnly) => rerun(pr, failedOnly)}
          onFix={onFixErrors && pr.state === "OPEN" && ownWork(row) ? () => { void onFixErrors(pr).catch(() => {}); } : undefined} />;
        const isMerged = pr.state === "MERGED";
        // Once merged: what to do with this session next, said under WHAT NEXT (design 05.12).
        const whatNext = isMerged && inline && row.current && cwd && !source.cloud
          ? <MergedWorkspaceStep cwd={cwd} embedded onArchive={canDelete && merged ? workspace?.onDelete : undefined} />
          : undefined;
        // This owns the description as well as its editor, including in a PR tab.
        const conversation = <PrConversation key={`${selection}:${row.identity}`} source={source} row={row} active={active} refresh={conversationRefresh}
          merged={isMerged} whatNext={whatNext}
          checks={inline ? <InlineChecks pr={pr} checks={checks} reviews={reviews} /> : undefined}
          onRead={(read) => { if (selected.current.generation === generation) setConversations((previous) => previous[row.identity] === read ? previous : { ...previous, [row.identity]: read }); }}
          onEdited={(title, body) => {
            if (selected.current.generation !== generation) return;
            setRows((previous) => previous.map((entry) => entry.identity === row.identity && entry.pr && (entry.pr.title !== title || entry.pr.body !== body) ? { ...entry, pr: { ...entry.pr, title, body } } : entry));
          }} />;
        const onUnlink = unlink(row);
        const approvedBy = (conversations[row.identity]?.reviewers ?? []).filter((reviewer) => reviewer.state === "APPROVED").map((reviewer) => reviewer.name ?? reviewer.login);
        if (inline) return <div key={row.identity}><InlinePr onUnlink={onUnlink} unlinkDisabled={!!working} onOpen={openInTab ? () => openInTab(row) : undefined} pr={pr} ready={ready} held={held} approvedBy={approvedBy} conversation={conversation} actions={pr.state === "OPEN" && source.canWrite && (
          <>
            {pr.isDraft && (
              <Button size="xs" variant="secondary" disabled={!!working || loading || !fresh} onClick={() => void act("ready", () => row.association && source.prAccess ? source.prAccess(row.association).ready() : source.readyPr(pr.number))}>
                {working === "ready" && <Loader2 className="animate-spin" />} Mark ready
              </Button>
            )}
            {canQueue(pr) && <Button size="xs" disabled={!!working || loading || !fresh} onClick={() => merge(row, "queue")}>Add to merge queue</Button>}
            {ready.ok && !pr.mergeQueueEnabled && mergeMenu(row, "xs", !!working || loading || !fresh)}
          </>
        )} /></div>;
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
              {onUnlink && <WithTooltip label={`Unlink #${pr.number}`}><Button size="icon-xs" variant="ghost" aria-label={`Unlink #${pr.number}`} disabled={!!working} onClick={onUnlink}><Unplug /></Button></WithTooltip>}
              <div className="min-w-0 flex-1">
                <button type="button" onClick={() => void openUrl(pr.url)} className="group flex items-center gap-1 text-left text-[13px] font-medium hover:underline">
                  <span className="truncate">{pr.title}</span>
                  <ExternalLink className="size-3 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
                </button>
                <div className="text-[11px] text-faint">
                  {row.association?.linked && <LinkedTag />}
                  #{pr.number} · {pr.state === "OPEN" ? (pr.isDraft ? "Draft" : "Open") : pr.state === "MERGED" ? "Merged" : "Closed"} · {pr.url.replace(/^https:\/\//, "").replace(/\/pull\/\d+\/?$/, "")}
                  <br /><span className="font-mono">{pr.head}</span> into <span className="font-mono">{pr.base}</span> · <span className="text-add">+{pr.additions}</span>{" "}
                  <span className="text-destructive">−{pr.deletions}</span>
                </div>
              </div>
            </div>
            {pr.state === "OPEN" && pr.mergeQueueEntry && <p className="mt-2 text-[11px] text-faint">Queue position {pr.mergeQueueEntry.position}</p>}
            {pr.checks.length > 0 && <div className="mt-2">{checks}</div>}
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
                  {source.canWrite && !pr.mergeQueueEnabled && mergeMenu(row, "sm", !!working || loading || !fresh || !ready.ok)}
                </div>
              </div>
            )}
            <div className="mt-3">{conversation}</div>
            {!isMerged && reviews}
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
      {!inline && !loading && !error && prs.length === 0 && !canCreate && status && (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          {status.branch === status.defaultBranch ? "On the default branch; nothing to open a pull request from." : "Nothing here yet."}
        </div>
      )}
    </div>
  );
}

function reviewLabel(decision: string): string {
  return decision === "APPROVED" ? "approved" : decision === "CHANGES_REQUESTED" ? "changes requested" : decision === "REVIEW_REQUIRED" ? "review required" : decision.toLowerCase();
}

/**
 * A pull request as one line of the Branch tab: its title (opens it), its
 * number and state, its checks folded into a count (unfolded when one fails),
 * then, unless the branch has a step first, what to do with it now.
 */
/** Said of a pull request linked by hand from another branch (PRO-294). */
function LinkedTag() {
  return (
    <span className="mr-1 rounded bg-muted px-1.5 text-[10.5px] text-muted-foreground" title="Linked to this session. Its checks and review show here; Push still goes to this session's branch." data-testid="pr-linked">
      Linked
    </span>
  );
}

const PILL = {
  Ready: "bg-add/15 text-add",
  Open: "bg-info/15 text-info",
  Draft: "bg-muted text-muted-foreground",
  Merged: "bg-merged/15 text-merged",
  Closed: "bg-destructive/15 text-destructive",
} as const;

/** The pull request's state as a pill before its title (design 05.08, 05.10): Ready once it can merge. */
function StatePill({ pr, ready }: { pr: PullRequest; ready: boolean }) {
  const state = pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.isDraft ? "Draft" : ready ? "Ready" : "Open";
  const Icon = state === "Merged" || state === "Ready" ? GitMerge : state === "Closed" ? X : state === "Draft" ? GitPullRequestDraft : GitPullRequest;
  return (
    <span className={cn("flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]", PILL[state])} data-testid="pr-state-pill">
      <Icon aria-hidden className="size-3" />
      {state}
    </span>
  );
}

/** CHECKS between REVIEW and DESCRIPTION (design 05.08): the count, unfolded on asking or when one fails. */
function InlineChecks({ pr, checks, reviews }: { pr: PullRequest; checks: ReactNode; reviews: ReactNode }) {
  const failing = pr.checks.filter(isFailingCheck).length;
  const [open, setOpen] = useState(failing > 0);
  useEffect(() => {
    if (failing > 0) setOpen(true);
  }, [failing]);
  const counts = checkCounts(pr.checks);
  return (
    <section aria-label="Checks" className="flex min-w-0 flex-col gap-1">
      <SectionHead
        title="Checks"
        summary={pr.checks.length ? (
          <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} data-testid="branch-pr-checks" title={open ? "Hide checks" : "Show checks"}
            className={cn("flex min-w-0 items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring", counts.failed ? "text-destructive" : !counts.running && counts.passed === counts.total ? "text-add" : undefined)}>
            <span className="truncate">{checkSummary(pr.checks)}</span>
            {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
          </button>
        ) : "None reported"}
      />
      {open && <div>{checks}</div>}
      {reviews}
      <Deployments pr={pr} />
    </section>
  );
}

function InlinePr({ pr, ready, held, actions, conversation, approvedBy, onOpen, onUnlink, unlinkDisabled = false }: { onOpen?: () => void; onUnlink?: () => void; unlinkDisabled?: boolean; pr: PullRequest; ready: { ok: boolean; label: string }; held: boolean; actions: ReactNode; conversation: ReactNode; approvedBy: string[] }) {
  const failing = pr.checks.filter(isFailingCheck).length;
  const good = ready.ok && pr.mergeState !== "UNSTABLE";
  const tone = good ? "good" : failing > 0 || pr.mergeable === "CONFLICTING" || pr.reviewDecision === "CHANGES_REQUESTED" ? "bad" : "muted";
  const counts = checkCounts(pr.checks);
  const readyDetail = [
    counts.total ? `${counts.passed} of ${counts.total} checks passed` : null,
    approvedBy.length ? `approved by ${approvedBy.slice(0, 2).join(", ")}${approvedBy.length > 2 ? ` and ${approvedBy.length - 2} more` : ""}` : pr.reviewDecision ? reviewLabel(pr.reviewDecision) : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-3 px-3 pb-3" data-testid="branch-pr">
      <div className="flex min-w-0 items-center gap-2 px-1">
        <StatePill pr={pr} ready={pr.state === "OPEN" && !pr.isDraft && good} />
        <button type="button" onClick={() => void openUrl(pr.url)} className="group flex min-w-0 flex-1 items-center gap-1 text-left text-[13px] font-medium hover:underline" title={pr.title}>
          <span className="truncate text-foreground">{pr.title}</span>
          <ExternalLink className="size-3 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
        </button>
        <span className="shrink-0 font-mono text-[12px] text-faint">
          {onUnlink && <LinkedTag />}
          #{pr.number}
        </span>
        {onOpen && <WithTooltip label={`Open PR #${pr.number} in centre tab`}><Button size="icon-xs" variant="ghost" aria-label={`Open PR #${pr.number} in centre tab`} onClick={onOpen}><Maximize2 /></Button></WithTooltip>}
        {onUnlink && <WithTooltip label={`Unlink #${pr.number}`}><Button size="icon-xs" variant="ghost" aria-label={`Unlink #${pr.number}`} disabled={unlinkDisabled} onClick={onUnlink}><Unplug /></Button></WithTooltip>}
      </div>
      {pr.detailsError && <p role="alert" className="px-1 text-xs text-destructive">Could not refresh merge details: {pr.detailsError}</p>}
      {pr.state === "OPEN" && held && pr.mergeQueueEntry && <p className="px-1 text-[11px] text-muted-foreground">{ready.label}</p>}
      {pr.state === "OPEN" && pr.mergeQueueEntry && pr.mergeQueueEntry.state !== "QUEUED" && pr.mergeQueueEntry.state !== "MERGEABLE" && <p className="px-1 text-[11px] text-faint">Queue position {pr.mergeQueueEntry.position}</p>}
      {pr.state === "OPEN" && !held && (good ? (
        <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-add/30 bg-add/5 px-3 py-2.5" data-testid="next-step" data-tone="good">
          <CircleCheck aria-hidden className="size-4 shrink-0 text-add" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-foreground">{ready.label}</div>
            {readyDetail && <div className="truncate text-[11.5px] text-muted-foreground" title={readyDetail}>{readyDetail}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      ) : (
        <NextLine tone={tone} text={`${ready.label}${pr.reviewDecision ? ` · ${reviewLabel(pr.reviewDecision)}` : ""}`} actions={actions || undefined} />
      ))}
      <div className="px-1">{conversation}</div>
    </div>
  );
}
