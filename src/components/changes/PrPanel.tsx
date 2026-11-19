import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Circle, CircleCheck, CircleDot, CircleX, Clock, ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, ListChecks, Loader2, Maximize2, MessageSquare, RefreshCw, Unplug, Users, X } from "@/icons";
import type { PrConversation as Conversation } from "@terminalx/portable/workspaceGit";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { api, fs, type GitHubConnectionStatus, type PullRequest, type PrAssociation } from "@/lib/api";
import { openCheckLog, openPr, useEditors } from "@/lib/editors";
import { useVisibleSessionTab } from "@/lib/visibleTab";
import { checksMarkOf, noteChecksMark, noteDraftPushes } from "@/lib/panelMarks";
import { showRerunFailed } from "@/lib/checkToasts";
import type { PrReviewer } from "@terminalx/portable/workspaceGit";
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
import { openWorkspaceDelete } from "@/lib/dialogs";
import { canDeleteMergedWorkspace, offersWorkspaceDelete, type RemovableWorkspace } from "@/lib/workspaceRemoval";
import type { Landed, WorkspaceDisposition, WorkStatus } from "@/types/session";
import { Deployments, PrChecks, webUrl } from "./PrChecks";
import { actionsRuns, checkCounts, isFailingCheck, runSignature, withPendingChecks, type PendingCheckRun } from "@/lib/checks";
import type { PrCheck } from "@/lib/api";
import { NextLine } from "./NextStep";
import { PrConversation, useDocumentVisible } from "./PrConversation";
import { MergeMenu, type MergeChoices } from "./MergeMenu";
import { MergedWorkspaceStep } from "./MergedWorkspaceStep";
import { ReviewThreads } from "./ReviewThreads";
import { noteSessionPrs } from "@/lib/reviewThreads";

type WorkspaceCleanup = {
  projectPath: string;
  onDelete: () => void;
};

/**
 * What "Archive this session after merge" asks of this session's workspace once the merge is through: where clean-up
 * archives merged sessions, unticking it keeps this one; where it does not, ticking it opens the archive dialog. Only
 * the session's own pull request offers the choice: merging a linked one says nothing about this workspace.
 */
export function afterMerge(current: boolean, choices: MergeChoices | undefined, cleanupOn: boolean): "hold" | "archive" | null {
  if (!current || !choices) return null;
  if (!choices.archive && cleanupOn) return "hold";
  if (choices.archive && !cleanupOn) return "archive";
  return null;
}

/** GitHub's lifecycle and queue take precedence over head-branch checks. */
export function mergeReadiness(pr: PullRequest): { ok: boolean; label: string; waiting?: number } {
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
  const counts = checkCounts(pr.checks.filter((check) => pr.requiredChecks == null || pr.requiredChecks.includes(check.name)));
  if (counts.failed) return blocked("Checks failing");
  // Checks still running are the wait only when nothing else holds the PR: review and a stale base
  // are said first. GitHub reports BLOCKED while required checks run, so that alone is still a wait.
  if (pr.mergeState === "BEHIND") return blocked("Behind base");
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") return blocked("Blocked");
  if (counts.running) return { ok: false, label: `Waiting for ${counts.running} ${counts.running === 1 ? "check" : "checks"}`, waiting: counts.running };
  if (pr.mergeState === "BLOCKED") return blocked("Blocked");
  if (pr.mergeState === "UNSTABLE" && !counts.unknown && pr.mergeable === "MERGEABLE") {
    return { ok: true, label: "Unstable: optional checks failing" };
  }
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
  machineWorkspace,
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
  machineWorkspace?: RemovableWorkspace;
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
  const [branchPrLinks, setBranchPrLinks] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
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
  /** Each PR's reviewers and open threads, as its conversation read them, for its header line. */
  const [summaries, setSummaries] = useState<Record<string, PrSummary>>({});
  /** The repository's pull request template, filled into a new PR's description (PRO-394, design 05.06). */
  const [template, setTemplate] = useState<{ path: string; text: string } | null>(null);
  const editors = useEditors();
  const shownTab = useVisibleSessionTab(sessionId ?? "");
  // Conversation pagination is independent of check/discovery polling.
  const [conversationRefresh, setConversationRefresh] = useState(0);
  // What each conversation read said that the panel shows outside it: the merge menu's methods, who approved.
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const cleanup = useMergedCleanup();
  const store = useSessionStore();
  const project = store.projects.find((entry) => entry.path === store.sessions.find((entry) => entry.id === sessionId)?.projectPath);
  const shortcutMethod = project ? pipelineSettings(project).mergeMethod : null;
  const workspaceKey = machineWorkspace
    ? `${machineWorkspace.host.key}\0${machineWorkspace.path}\0${selection}`
    : workspace ? `${workspace.projectPath}\0${cwd}\0${branch ?? ""}` : null;

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
        const pullRequests: Awaited<ReturnType<typeof sessionPrs>> = selectedPr
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
        setBranchPrLinks(pullRequests.branchPrLinks === true);
        // The Changes view finds the same PR for its review threads without asking GitHub again (PRO-234).
        if (!selectedPr) noteSessionPrs(source, sessionId, pullRequests.rows.flatMap((row) => row.pr ? [row.pr] : []));
        // The panel's Checks tab carries a red dot while the session's own open PR has a failing check (PRO-394).
        if (!selectedPr && sessionId) noteChecksMark(sessionId, checksMarkOf(pullRequests.rows.flatMap((row) => row.pr?.state === "OPEN" && (row.current || !row.association?.linked) ? row.pr.checks : [])));
        setLoadedSelection(selection);
        setStatus(workStatus);
        setLanded(landedWork);
        setCheckedWorkspace(workspaceCheck);
        setError(pullRequests.error ?? actionError.current);
        setErrorFrom(pullRequests.error || !actionError.current ? "load" : "action");
        // The machine's cleanup check can finish independently of PR loading and actions.
        if (machineWorkspace && workspaceKey && pullRequests.rows.some((row) => row.current && row.pr?.state === "MERGED")) {
          void machineWorkspace.host.disposition().then((disposition) => {
            if (!cancelled) setCheckedWorkspace({ key: workspaceKey, disposition });
          }).catch(() => {});
        }
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
    setLinkUrl(null);
    setTitle("");
    setBody("");
    setWorking(null);
  }, [selection]);

  // A new pull request's description starts from the repository's template, as GitHub's own form does.
  const wantsTemplate = !!(cwd && !source.cloud && !selectedPr && inline && status && status.branch && status.branch !== status.defaultBranch);
  useEffect(() => {
    if (!wantsTemplate || !cwd) return;
    let cancelled = false;
    void (async () => {
      for (const path of [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"]) {
        try {
          const file = await fs.readText(`${cwd.replace(/\/$/, "")}/${path}`);
          if (cancelled) return;
          if (!file.binary && file.content.trim()) {
            setTemplate({ path, text: file.content });
            setBody((old) => old || file.content);
            return;
          }
        } catch { /* Not there: the next place GitHub looks. */ }
      }
    })();
    return () => { cancelled = true; };
  }, [wantsTemplate, cwd]);

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

  /**
   * Re-run a PR's Actions runs (its failed jobs, with `failedOnly`), or one
   * check's run. GitHub refusing is said as a toast naming the PR with
   * GitHub's reason and the run (PRO-394, design 05.17), not as a Git error.
   */
  const rerun = (pr: PullRequest, failedOnly: boolean, only?: PrCheck) => void act("rerun", async () => {
    if (!source.canWrite || !source.rerunCheck || !source.checkAuthority) throw new Error("Re-running checks is unavailable here.");
    const checks = only ? [only] : actionsRuns(pr, failedOnly);
    let at: PrCheck | undefined = checks[0];
    try {
      const authority = await source.checkAuthority();
      for (const check of checks) {
        at = check;
        // A navigation during a batch cancels the remaining outward actions.
        if (!mounted.current || selected.current.generation !== generation) return;
        await source.rerunCheck(pr.url, check.url!, failedOnly, authority);
        if (!mounted.current || selected.current.generation !== generation) return;
        const runId = check.actions!.runId;
        setPendingRuns((old) => [...old.filter((p) => p.until > Date.now() && !(p.prUrl === pr.url && p.runId === runId)), {
          prUrl: pr.url, runId, failedOnly, signature: runSignature(pr, runId), until: Date.now() + 60_000,
        }]);
      }
    } catch (error) {
      if (mounted.current && selected.current.generation === generation) showRerunFailed({ prNumber: pr.number, error: source.errorMessage(error), runUrl: webUrl(at?.url) });
      return null;
    }
    return `Re-run requested for ${checks.length} Actions ${checks.length === 1 ? "run" : "runs"}.`;
  // An Actions reply can arrive after its ticket expires, including success or
  // an ordinary error. Keep its result, then let independent polling/manual
  // refresh read again; this old action cannot initiate unscoped reconciliation.
  }, false);

  /** Only a link made with "Link pull request…" (PRO-294) is undone; a PR the session opened stays. */
  const unlink = (row: SessionPr): (() => void) | undefined => {
    const association = row.association;
    if (selectedPr || !sessionId || !association?.linked || (source.cloud && (!branchPrLinks || !source.unlinkPr))) return undefined;
    return () => void act("unlink", async () => {
      await (source.unlinkPr ? source.unlinkPr(sessionId, association.url) : unlinkPr(sessionId, association.url));
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
      if (!workspace || !cwd) return;
      const next = afterMerge(row.current, choices, mergedCleanupOn(getMergedCleanup().settings, workspace.projectPath));
      if (next === "hold") await holdMergedWorkspace(LOCAL_HOST, cwd, true).catch(() => {});
      else if (next === "archive") workspace.onDelete();
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
  const showDraft = inline && !selectedPr && fresh && !!status && !!currentBranch && !!status.defaultBranch && currentBranch !== status.defaultBranch && !currentOpen && !merged;
  const linkBranchPr = source.linkBranchPr;
  const canLinkBranchPr = branchPrLinks && !selectedPr && fresh && !currentOpen && sessionId && currentBranch && status?.defaultBranch && currentBranch !== status.defaultBranch && linkBranchPr;
  const disposition = !!workspaceKey && checkedWorkspace?.key === workspaceKey
    && checkedWorkspace.disposition.branch === currentBranch && checkedWorkspace.disposition.pr?.url === latestCurrent?.url
    ? checkedWorkspace.disposition : null;
  const canDelete = canDeleteMergedWorkspace(disposition);
  const deleteOnMachine = machineWorkspace && fresh && open.length === 0 && offersWorkspaceDelete(
    disposition, busy || machineWorkspace.host.turnRunning(disposition?.sessionIds ?? []),
  ) ? () => openWorkspaceDelete(machineWorkspace.projectPath, machineWorkspace.path, machineWorkspace.name, machineWorkspace.host) : undefined;

  return (
    <div className={cn("flex flex-col", inline ? "gap-2" : "h-full min-h-0 overflow-y-auto scrollbar-thin")}>
      {/* Inline, the tab's own refresh reads it again, and it is read every 30 seconds besides. */}
      {!inline && (
        <div className="flex items-center justify-end px-3 pt-2">
          <Button size="xs" className="text-xs" variant="ghost" disabled={loading || !!working} onClick={() => { setTick((t) => t + 1); setConversationRefresh((value) => value + 1); }} aria-label="Refresh pull requests">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      )}
      {error && inline && errorFrom === "load" && !prErrorKind(error) ? (
        // Not reaching GitHub is no fault of the reader's: said once, quietly, the detail on hover.
        <p className="px-4 text-xs text-faint" title={error} data-testid="pr-unreachable">Can't reach GitHub right now. Pull requests will show when it answers.</p>
      ) : error && (source.cloud ? <div role="alert" className="mx-3 mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div> : <GitError details={error} onRetry={() => setTick((value) => value + 1)} onConnect={() => setConnection({ state: "signed_out", details: null, hostname: connection?.hostname })} />)}
      {notice && <div role="status" className="mx-3 mt-2 rounded-md bg-well px-2 py-1 text-xs text-muted-foreground">{notice}</div>}
      {canLinkBranchPr && (linkUrl === null ? (
        <Button size="xs" variant="outline" className="mx-3 self-start" disabled={!!working} onClick={() => setLinkUrl("")}>Link existing branch PR</Button>
      ) : (
        <form className="mx-3 space-y-2 rounded-md bg-well p-2 text-xs" onSubmit={(event) => {
          event.preventDefault();
          const url = linkUrl.trim();
          if (url) void act("link", () => linkBranchPr(sessionId, url, currentBranch)).then((saved) => { if (saved) setLinkUrl(null); });
        }}>
          <label className="flex flex-col gap-1">
            Pull request URL
            <input className="min-w-0 rounded-md border border-hairline bg-background px-2 py-1" type="url" value={linkUrl} disabled={!!working} onChange={(event) => setLinkUrl(event.target.value)} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="xs" variant="secondary" disabled={!!working || !linkUrl.trim()}>Link pull request</Button>
            <Button type="button" size="xs" variant="ghost" disabled={!!working} onClick={() => setLinkUrl(null)}>Cancel</Button>
          </div>
        </form>
      ))}
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
            <Button size="xs" className="text-xs" variant="outline" onClick={onSettle}>
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
        const onUnlink = unlink(row);
        if (!pr) return <div key={row.identity} role="alert" className="border-b border-hairline px-3 py-3 text-xs">
          <button type="button" onClick={() => void openUrl(row.identity)} className="hover:underline">{row.identity}</button>
          <div className="text-destructive">Could not refresh this pull request.</div>
          <CommandDetails details={row.error} />
          {onUnlink && <Button size="xs" variant="outline" disabled={!!working} onClick={onUnlink}>Unlink #{row.association?.number}</Button>}
        </div>;
        const ready = mergeReadiness(pr);
        const reviews = <ReviewThreads source={source} url={pr.url} number={pr.number} sessionId={sessionId} active={active} prState={pr.state} />;
        // A check's log opens in a centre tab beside the chat (PRO-394, design 05.09); a cloud workspace's under the list.
        const logSession = sessionId ?? (cwd ? `checkout:${cwd}` : undefined);
        const failures = pr.checks.filter(isFailingCheck).length;
        const onOpenLog = !source.cloud && cwd && logSession ? (check: PrCheck) => {
          if (!check.url || !check.actions) return;
          openCheckLog(logSession, cwd, pr, { name: check.name, url: check.url, state: check.state, runId: check.actions.runId, jobId: check.actions.jobId, startedAt: check.startedAt, completedAt: check.completedAt, summary: check.summary }, failures);
        } : undefined;
        const shown = editors.editors.find((entry) => entry.kind === "checkLog" && entry.sessionId === logSession && shownTab?.kind === "review" && shownTab.id === entry.id);
        const checks = <PrChecks pr={pr} source={source} disabled={!!working || loading || !fresh} fixBusy={fixBusy}
          onRerun={(failedOnly) => rerun(pr, failedOnly)}
          onRerunCheck={(check) => rerun(pr, isFailingCheck(check), check)}
          onOpenLog={onOpenLog}
          viewing={shown?.kind === "checkLog" && shown.check.prUrl === pr.url ? shown.check.url : null}
          onFix={onFixErrors && pr.state === "OPEN" && ownWork(row) ? () => { void onFixErrors(pr).catch(() => {}); } : undefined} />;
        const isMerged = pr.state === "MERGED";
        // Once merged: what to do with this session next, said under WHAT NEXT (design 05.12).
        const whatNext = isMerged && inline && row.current
          ? deleteOnMachine && pr.url === latestCurrent?.url
            ? <Button size="xs" variant="outline" className="self-start" onClick={deleteOnMachine}>Delete workspace</Button>
            : cwd && !source.cloud
              ? <MergedWorkspaceStep cwd={cwd} embedded onArchive={canDelete && merged ? workspace?.onDelete : undefined} />
              : undefined
          : undefined;
        // This owns the description as well as its editor, including in a PR tab.
        const conversation = <PrConversation key={`${selection}:${row.identity}`} source={source} row={row} active={active} refresh={conversationRefresh}
          merged={isMerged} whatNext={whatNext}
          onSummary={(summary) => { if (selected.current.generation === generation) setSummaries((old) => ({ ...old, [row.identity]: summary })); }}
          onRead={(read) => { if (selected.current.generation === generation) setConversations((previous) => previous[row.identity] === read ? previous : { ...previous, [row.identity]: read }); }}
          onEdited={(title, body) => {
            if (selected.current.generation !== generation) return;
            setRows((previous) => previous.map((entry) => entry.identity === row.identity && entry.pr && (entry.pr.title !== title || entry.pr.body !== body) ? { ...entry, pr: { ...entry.pr, title, body } } : entry));
          }} />;
        if (inline) return <div key={row.identity}><InlinePr linked={row.association?.linked} onUnlink={onUnlink} unlinkDisabled={!!working} reviews={reviews} onOpen={openInTab ? () => openInTab(row) : undefined} pr={pr} ready={ready} held={held} checks={checks}
          commits={row.current && status?.branch === pr.head ? status.aheadOfBase : null} summary={summaries[row.identity]} actions={pr.state === "OPEN" && source.canWrite && (pr.isDraft || canQueue(pr) || (ready.ok && !pr.mergeQueueEnabled)) && (
          <>
            {pr.isDraft && (
              <Button size="sm" variant="secondary" disabled={!!working || loading || !fresh} onClick={() => void act("ready", () => row.association && source.prAccess ? source.prAccess(row.association).ready() : source.readyPr(pr.number))}>
                {working === "ready" && <Loader2 className="animate-spin" />} Mark ready
              </Button>
            )}
            {canQueue(pr) && <Button size="xs" disabled={!!working || loading || !fresh} onClick={() => merge(row, "queue")}>Add to merge queue</Button>}
            {ready.ok && !pr.mergeQueueEnabled && mergeMenu(row, "xs", !!working || loading || !fresh)}
          </>
        )} /><div className="px-3 pb-3">{conversation}</div></div>;
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
                <div className="text-xs text-faint">
                  {row.association?.linked && <LinkedTag />}
                  #{pr.number} · {pr.state === "OPEN" ? (pr.isDraft ? "Draft" : "Open") : pr.state === "MERGED" ? "Merged" : "Closed"} · {pr.url.replace(/^https:\/\//, "").replace(/\/pull\/\d+\/?$/, "")}
                  <br /><span className="font-mono">{pr.head}</span> into <span className="font-mono">{pr.base}</span> · <span className="text-add">+{pr.additions}</span>{" "}
                  <span className="text-destructive">−{pr.deletions}</span>
                </div>
              </div>
            </div>
            {pr.state === "OPEN" && pr.mergeQueueEntry && <p className="mt-2 text-xs text-faint">Queue position {pr.mergeQueueEntry.position}</p>}
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

      {/* No pull request yet: its draft, filled in here, in place of a step to push first (PRO-394, design 05.06). */}
      {showDraft && status && currentBranch && status.defaultBranch && (
        <PrDraft
          cwd={cwd}
          head={currentBranch}
          base={base ?? status.defaultBranch}
          bases={[...new Set([base ?? status.defaultBranch, ...bases])]}
          onBase={setBase}
          onOpenBases={() => setCreating(true)}
          ahead={status.aheadOfBase ?? 0}
          pushed={!!status.upstream && status.ahead === 0}
          title={title}
          body={body}
          template={template?.path ?? null}
          onTitle={setTitle}
          onBody={setBody}
          draft={draft}
          onDraft={setDraft}
          canCreate={!!canCreate && source.canWrite}
          working={working === "create"}
          disabled={!!working || !fresh || !!currentOpen}
          onCreate={() => void act("create", async () => {
            // Unpushed commits go up first: GitHub opens a pull request from what it has.
            if (!status.upstream || status.ahead > 0) await source.push();
            return source.createPr({ title: title.trim(), body, base: base ?? status.defaultBranch ?? null, draft, sessionId });
          }).then((ok) => {
            if (!ok) return;
            setTitle("");
            setBody(template?.text ?? "");
          })}
        />
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
      {creating && !inline && (
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

/** Said of a pull request linked by hand from another branch (PRO-294). */
function LinkedTag() {
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 text-xs text-muted-foreground" title="Linked to this session. Its checks and review show here; Push still goes to this session's branch." data-testid="pr-linked">
      Linked
    </span>
  );
}

type PrSummary = { reviewers: PrReviewer[]; unresolvedThreads: number };

/** A pull request's state as a pill: Open, Draft, Merged, Closed (PRO-394). */
function StatePill({ pr }: { pr: PullRequest }) {
  const [label, Icon, tone] = pr.state === "MERGED" ? ["Merged", GitMerge, "bg-merged/15 text-merged"] as const
    : pr.state === "CLOSED" ? ["Closed", GitPullRequestClosed, "bg-destructive/15 text-destructive"] as const
    : pr.isDraft ? ["Draft", GitPullRequestDraft, "bg-veil-strong text-muted-foreground"] as const
    : ["Open", GitPullRequest, "bg-info/15 text-info"] as const;
  return <span className={cn("flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-xs", tone)} data-testid="pr-state"><Icon className="size-3" aria-hidden />{label}</span>;
}

const initials = (login: string) => login.replace(/\[bot\]$/i, "").split(/[-_.\s/]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || login.slice(0, 2).toUpperCase();

/** "Review requested: SR, AK", or who approved or asked for changes, when nobody is still asked. */
function reviewLine(reviewers: PrReviewer[]): string | null {
  const people = reviewers.filter((reviewer) => reviewer.kind !== "bot");
  const requested = people.filter((reviewer) => reviewer.requested);
  if (requested.length) return `Review requested: ${requested.map((reviewer) => initials(reviewer.login)).join(", ")}`;
  const changes = people.filter((reviewer) => reviewer.state === "CHANGES_REQUESTED");
  if (changes.length) return `Changes requested by ${changes.map((reviewer) => reviewer.login).join(", ")}`;
  const approved = people.filter((reviewer) => reviewer.state === "APPROVED");
  if (approved.length) return `Approved by ${approved.map((reviewer) => reviewer.login).join(", ")}`;
  return null;
}

/**
 * The pull request at the top of the Checks tab (PRO-394, design 05.02): its
 * state pill, title and number; its branch into the base, commits and size;
 * who reviews it and its open threads.
 */
function PrHeader({ pr, commits, summary, linked, onOpen, onUnlink, unlinkDisabled }: { pr: PullRequest; commits?: number | null; summary?: PrSummary; linked?: boolean; onOpen?: () => void; onUnlink?: () => void; unlinkDisabled: boolean }) {
  const review = summary ? reviewLine(summary.reviewers) : null;
  const threads = summary?.unresolvedThreads ?? 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-b border-hairline p-3" data-testid="pr-header">
      <div className="flex min-w-0 items-center gap-2">
        <StatePill pr={pr} />
        <button type="button" onClick={() => void openUrl(pr.url)} className="min-w-0 truncate text-left text-[13px] font-medium text-foreground hover:underline" title={pr.title}>{pr.title}</button>
        <span className="shrink-0 font-mono text-xs text-faint">#{pr.number}</span>
        {linked && <LinkedTag />}
        <span className="ml-auto flex shrink-0 items-center">
          {onOpen && <WithTooltip label={`Open PR #${pr.number} in centre tab`}><Button size="icon-xs" variant="ghost" aria-label={`Open PR #${pr.number} in centre tab`} onClick={onOpen}><Maximize2 /></Button></WithTooltip>}
          {onUnlink && <WithTooltip label={`Unlink #${pr.number}`}><Button size="icon-xs" variant="ghost" aria-label={`Unlink #${pr.number}`} disabled={unlinkDisabled} onClick={onUnlink}><Unplug /></Button></WithTooltip>}
          <WithTooltip label="Open on GitHub"><Button size="icon-xs" variant="ghost" aria-label={`Open #${pr.number} on GitHub`} onClick={() => void openUrl(pr.url)}><ExternalLink /></Button></WithTooltip>
        </span>
      </div>
      <div className="min-w-0 truncate text-xs text-muted-foreground" data-testid="pr-branch-line">
        <span className="font-mono">{pr.head}</span> → <span className="font-mono">{pr.base}</span>
        {commits != null && commits > 0 && <> · {commits} {commits === 1 ? "commit" : "commits"}</>}
        {" · "}<span className="font-mono text-add">+{pr.additions}</span> <span className="font-mono text-destructive">−{pr.deletions}</span>
      </div>
      {(review || threads > 0) && (
        <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground" data-testid="pr-review-line">
          {review && <span className="flex min-w-0 items-center gap-1 truncate"><Users className="size-3 shrink-0" aria-hidden />{review}</span>}
          {threads > 0 && <span className="flex shrink-0 items-center gap-1"><MessageSquare className="size-3" aria-hidden />{threads} {threads === 1 ? "thread" : "threads"}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Where the pull request stands for merging and what to do with it: a clock
 * while checks run ("Waiting for 2 checks"), never "Blocked" for that
 * (PRO-394, design 05.08), with its review and head commit under it.
 */
function StatusCard({ pr, ready, actions }: { pr: PullRequest; ready: ReturnType<typeof mergeReadiness>; actions: ReactNode }) {
  const tone = ready.ok && pr.mergeState !== "UNSTABLE" ? "good" : ready.waiting ? "warn" : pr.mergeable === "CONFLICTING" || pr.reviewDecision === "CHANGES_REQUESTED" || ready.label === "Checks failing" ? "bad" : "muted";
  const Icon = tone === "good" ? CircleCheck : tone === "warn" ? Clock : tone === "bad" ? CircleX : CircleDot;
  const detail = [pr.reviewDecision && reviewLabel(pr.reviewDecision), pr.headSha && `head ${pr.headSha.slice(0, 7)}`].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-2.5 border-b border-hairline px-3 py-2" data-testid="next-step" data-tone={tone}>
      <Icon className={cn("size-[15px] shrink-0", tone === "good" && "text-add", tone === "warn" && "text-warning", tone === "bad" && "text-destructive", tone === "muted" && "text-muted-foreground")} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-foreground" data-testid="pr-status">{ready.label}</div>
        {detail && <div className="truncate text-xs text-faint">{detail}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

function InlinePr({ pr, ready, held, actions, checks, reviews, linked, onOpen, onUnlink, unlinkDisabled = false, commits, summary }: { linked?: boolean; onOpen?: () => void; onUnlink?: () => void; unlinkDisabled?: boolean; pr: PullRequest; ready: ReturnType<typeof mergeReadiness>; held: boolean; actions: ReactNode; checks: ReactNode; reviews: ReactNode; commits?: number | null; summary?: PrSummary }) {
  const failing = pr.checks.some(isFailingCheck);
  return (
    <div className="flex min-w-0 flex-col" data-testid="branch-pr">
      <PrHeader pr={pr} commits={commits} summary={summary} linked={linked} onOpen={onOpen} onUnlink={onUnlink} unlinkDisabled={unlinkDisabled} />
      {/* With a check failing, the red band under it is the status; the card stays only for what can be done besides (Mark ready). */}
      {pr.state === "OPEN" && !held && (!failing || actions) && <StatusCard pr={pr} ready={ready} actions={actions || undefined} />}
      {pr.state === "OPEN" && held && pr.mergeQueueEntry && <p className="px-3 pt-2 text-xs text-muted-foreground">{ready.label}</p>}
      {pr.state === "OPEN" && pr.mergeQueueEntry && pr.mergeQueueEntry.state !== "QUEUED" && pr.mergeQueueEntry.state !== "MERGEABLE" && <p className="px-3 pt-2 text-xs text-faint">Queue position {pr.mergeQueueEntry.position}</p>}
      {pr.detailsError && <p role="alert" className="px-3 pt-2 text-xs text-destructive">Could not refresh merge details: {pr.detailsError}</p>}
      {checks}
      <div className="flex min-w-0 flex-col gap-2 px-3 pt-2">
        <Deployments pr={pr} />
        {reviews}
      </div>
    </div>
  );
}

/**
 * No pull request yet (PRO-394, design 05.06): its draft in place of a step
 * to push first. The title and the description (from the repository's
 * template when it has one), the branch against its base, and where checks
 * will show. Creating pushes unpushed commits first.
 */
function PrDraft({ cwd, head, base, bases, onBase, onOpenBases, ahead, pushed, title, body, template, onTitle, onBody, draft, onDraft, canCreate, working, disabled, onCreate }: {
  head: string; base: string; bases: string[]; onBase: (base: string) => void; onOpenBases: () => void;
  ahead: number; pushed: boolean; title: string; body: string; template: string | null;
  onTitle: (title: string) => void; onBody: (body: string) => void; draft: boolean; onDraft: (draft: boolean) => void;
  canCreate: boolean; working: boolean; disabled: boolean; onCreate: () => void; cwd?: string;
}) {
  // While this draft can push and create itself, the branch's Push step below is left to it (PRO-394).
  // Here, not in PrPanel: the panel returns early for GitHub setup, so a hook there would change its hook count.
  useEffect(() => {
    if (!cwd || !canCreate) return;
    noteDraftPushes(cwd, true);
    return () => noteDraftPushes(cwd, false);
  }, [cwd, canCreate]);
  const [changingBase, setChangingBase] = useState(false);
  return (
    <form className="flex min-w-0 flex-col gap-3 p-3" data-testid="pr-draft" onSubmit={(event) => { event.preventDefault(); if (canCreate && title.trim()) onCreate(); }}>
      <div className="flex min-w-0 items-center gap-2">
        <Circle className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="shrink-0 text-[13px] font-medium">No PR open</span>
        <span className="min-w-0 truncate font-mono text-xs text-faint">{head} → {base}</span>
      </div>
      {canCreate && <>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Title
          <input value={title} onChange={(event) => onTitle(event.target.value)} placeholder="What this pull request does" disabled={disabled}
            className="h-8 rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground outline-none placeholder:text-faint focus:border-ring" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">Description{template && <span className="ml-auto truncate font-mono text-faint" title={template}>{template}</span>}</span>
          <textarea value={body} onChange={(event) => onBody(event.target.value)} rows={8} placeholder="Description (Markdown)" disabled={disabled}
            className="min-h-32 rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs leading-[18px] text-foreground outline-none placeholder:text-faint focus:border-ring" />
        </label>
      </>}
      <div className="flex flex-col gap-1.5">
        <h4 className="text-xs font-medium uppercase tracking-[.08em] text-faint">Branch</h4>
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="pr-draft-ahead">
          <GitCommitHorizontal className="size-3.5 shrink-0" aria-hidden />
          {ahead} {ahead === 1 ? "commit" : "commits"} ahead of {base}
          <span className="text-faint">· {pushed ? "pushed" : "not pushed"}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <GitBranch className="size-3.5 shrink-0" aria-hidden />
          Base
          {changingBase ? (
            <select aria-label="Base branch" autoFocus value={base} onChange={(event) => { onBase(event.target.value); setChangingBase(false); }} onBlur={() => setChangingBase(false)}
              className="h-6 min-w-0 rounded-md border border-border bg-transparent px-1 font-mono text-xs outline-none focus:border-ring">
              {bases.filter(Boolean).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          ) : <span className="font-mono text-foreground">{base}</span>}
          {canCreate && !changingBase && <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => { onOpenBases(); setChangingBase(true); }}>Change</button>}
        </div>
      </div>
      {canCreate && (
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" variant="accent" disabled={disabled || !title.trim()}>
            {working ? <Loader2 className="animate-spin" /> : <GitPullRequest />}{pushed ? "Create pull request" : "Push and create pull request"}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={draft} onChange={(event) => onDraft(event.target.checked)} /> Draft</label>
        </div>
      )}
      <p className="flex items-center gap-2 text-xs text-faint"><ListChecks className="size-3.5 shrink-0" aria-hidden />Checks show up here once the PR is open.</p>
    </form>
  );
}
