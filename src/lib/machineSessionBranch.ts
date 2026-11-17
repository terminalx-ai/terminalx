import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PullRequest } from "@/lib/api";
import { FAILING_CHECKS } from "@/lib/checks";
import type { GitSource, SourceStatus } from "@/lib/gitSource";
import type { BranchAction, BranchState } from "@/lib/branchStep";

/**
 * The session header's branch for a session on a paired machine (PRO-404):
 * its branch, diff size, pull requests and next Git step, read live from the
 * machine's `git/1` (`git.status`, `git.prs`, `git.reviewRange`), and its
 * push, pull request and merge run there (`git.push`, `git.prCreate`,
 * `git.prReady`, `git.prMerge`, pinned to the head the person saw with
 * `machine/9`).
 *
 * The next Git step for such a session. A local session's comes from `branch_step.rs`, which runs git and
 * gh on this computer; a machine's is read through the machine's `git/1`
 * (`git.status`, `git.prs`) and its actions run there, with the machine's Git
 * sign-in. The rules are `branch_step::resolve`, `branch_step::actions` and
 * `branch_overview::next_step`, in the same order: local work takes
 * precedence over hosted readiness, and nothing unread turns into Merge.
 */

/** The pull request the header reads for the branch, as the machine's `git.prs` gives it, with the head commit GitHub has. */
export type MachinePr = PullRequest & { headSha?: string };

export interface MachineBranchSnapshot {
  branch: string;
  head: string;
  base: string;
  state: BranchState;
  actions: BranchAction[];
  pr: MachinePr | null;
  /** Pull fast-forwards from the branch's upstream (`git.pull`). */
  behindUpstream: boolean;
  /** Pull goes to the agent: uncommitted work to keep, or a base that has to be merged in (the machine only fast-forwards). */
  pullNeedsAgent: boolean;
}

/** Whether `origin` is on GitHub, as `github_identity::classify_remote_host` reads it: an opaque alias or custom domain is not. */
export function isGithubRemote(url: string | null | undefined): boolean {
  const remote = url?.trim();
  if (!remote) return false;
  let host: string;
  if (remote.includes("://")) {
    let parsed: URL;
    try { parsed = new URL(remote); } catch { return false; }
    if (parsed.protocol === "file:" || !parsed.hostname) return false;
    host = parsed.hostname;
  } else {
    // `git@github.com:owner/name.git`: SCP-like SSH. A plain path has no host.
    const match = /^(?:[^@/]+@)?([^:/]+):/.exec(remote);
    if (!match) return false;
    host = match[1];
  }
  host = host.replace(/\.+$/, "").toLowerCase();
  const alias = (name: string) => !host.includes(".") && (host === name || (host.startsWith(`${name}-`) && host.length > name.length + 1));
  const named = (name: string) => host.split(".").includes(name) || alias(name);
  if (named("gitlab") || named("bitbucket") || named("gitea") || named("gogs")) return false;
  if (host === "codeberg.org" || host.endsWith(".codeberg.org") || host === "sr.ht" || host.endsWith(".sr.ht")) return false;
  return host === "github.com" || host.endsWith(".github.com") || alias("github") || (host.startsWith("github.") && !host.startsWith("github.com."));
}

/** The branch's pull request among `git.prs`'s answer: the open one, else the latest. */
export function branchPr(prs: readonly MachinePr[], branch: string): MachinePr | null {
  const mine = prs.filter((pr) => pr.head === branch);
  return mine.find((pr) => pr.state === "OPEN") ?? mine[0] ?? null;
}

type Bucket = "pass" | "fail" | "pending";
/** `issue_pipeline::gate::check_bucket`: anything not passed or failed is pending. */
function bucket(state: string): Bucket {
  if (state === "success" || state === "neutral" || state === "skipped") return "pass";
  return FAILING_CHECKS.includes(state) ? "fail" : "pending";
}

type LocalStep = "conflicts" | "reconcile" | "pull" | "commit" | "push" | null;

/** `branch_overview::next_step` for a supported branch (named, not the default, with a remote). */
function localStep(work: SourceStatus, baseConflicts: boolean, aheadOfBase: number): LocalStep {
  if (work.conflicted?.length || work.operation) return "conflicts";
  if (work.ahead > 0 && work.behind > 0) return "reconcile";
  if (work.behind > 0) return "pull";
  if (baseConflicts) return "conflicts";
  if (work.dirty) return "commit";
  if (aheadOfBase === 0 && work.ahead === 0) return null;
  if (work.ahead > 0 || !work.upstream) return "push";
  return null;
}

/** `branch_step::resolve`. */
export function resolveMachineStep(work: SourceStatus, pr: MachinePr | null, working: boolean, aheadOfBase: number | null): BranchState {
  if (working) return "agentWorking";
  // GitHub describes the published head; a local resolution waiting to be pushed must not inherit its conflicts.
  const current = pr && pr.state === "OPEN" && !!pr.headSha && work.head === pr.headSha ? pr : null;
  const baseConflicts = !!current && (current.mergeable === "CONFLICTING" || current.mergeState === "DIRTY");
  const baseBehind = !!current && current.mergeState === "BEHIND";
  const local = localStep(work, baseConflicts, aheadOfBase ?? 1);
  if (local === "conflicts") return "conflicts";
  if (local === "reconcile") return "diverged";
  if (local === "pull") return "behind";
  if (baseBehind) return "behind";
  if (local === "commit") return "uncommitted";
  if (local === "push") return "ahead";
  if (!pr) return "noPr";
  if (pr.state === "MERGED") return work.head === pr.headSha ? "merged" : "noPr";
  if (pr.state !== "OPEN") return "noPr";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changesRequested";
  if (pr.isDraft) return "draft";
  if (!pr.headSha || work.head !== pr.headSha) return "checksPending";
  if (pr.checks.some((check) => bucket(check.state) === "fail")) return "checksFailing";
  if (pr.checks.some((check) => bucket(check.state) === "pending")
    || (pr.requiredChecks ?? []).some((name) => !pr.checks.some((check) => check.name === name))) return "checksPending";
  if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.mergeState === "BLOCKED") return "reviewRequired";
  if (pr.mergeable !== "MERGEABLE" || pr.mergeState !== "CLEAN") return "checksPending";
  return "ready";
}

/** `branch_step::actions`: the primary step first, then other applicable PR actions for the menu. */
export function machineActions(step: BranchState, pr: MachinePr | null): BranchAction[] {
  const primary: Record<BranchState, BranchAction[]> = {
    hidden: [], agentWorking: [], merged: [],
    uncommitted: ["commitPush"], ahead: ["push"], behind: ["pull"],
    diverged: ["resolveConflicts"], conflicts: ["resolveConflicts"],
    changesRequested: ["addressReview"], checksFailing: ["fixChecks"], draft: ["markReady"], ready: ["merge"],
    noPr: ["createPr"], checksPending: [], reviewRequired: [],
  };
  const available = [...primary[step]];
  if (step === "ahead" && (!pr || pr.state !== "OPEN")) available.push("createPr");
  if (pr?.state === "OPEN" && ["changesRequested", "draft", "checksFailing", "checksPending", "reviewRequired", "ready"].includes(step)) {
    if (pr.isDraft && !available.includes("markReady")) available.push("markReady");
    if (pr.checks.some((check) => bucket(check.state) === "fail") && !available.includes("fixChecks")) available.push("fixChecks");
  }
  return available;
}

/**
 * The header's snapshot, or null where it shows nothing: no branch, the
 * default branch, no commits, or an `origin` that is not GitHub. `known` says
 * the PR read succeeded; without it only local steps show, never Create PR or
 * a hosted state (`branch_step::compose`).
 */
export function composeMachineSnapshot(input: { work: SourceStatus; remote: string | null; pr: MachinePr | null; known: boolean; working: boolean; baseRef?: string | null }): MachineBranchSnapshot | null {
  const { work, known, working } = input;
  if (!work.isRepo || !work.branch || !work.head || work.branch === work.defaultBranch || !isGithubRemote(input.remote)) return null;
  const pr = known ? input.pr : null;
  const recorded = input.baseRef && input.baseRef !== "HEAD" ? input.baseRef.replace(/^origin\//, "") : null;
  const base = (pr?.state === "OPEN" ? pr.base : null) ?? recorded ?? work.defaultBranch;
  if (!base) return null;
  // `aheadOfBase` is counted against the default branch; another base is not counted, as branch_step's unwrap_or(1).
  const aheadOfBase = base === work.defaultBranch ? work.aheadOfBase : null;
  let state = resolveMachineStep(work, pr, working, aheadOfBase);
  if (!known && !["agentWorking", "conflicts", "diverged", "behind", "uncommitted", "ahead"].includes(state)) return null;
  if (state === "noPr" && aheadOfBase === 0) return null;
  if (state === "hidden") return null;
  let actions = machineActions(state, pr);
  if (!known) actions = actions.filter((action) => action !== "createPr");
  return {
    branch: work.branch,
    head: work.head,
    base,
    state,
    actions,
    pr,
    behindUpstream: work.behind > 0,
    // The machine's `git.pull` only fast-forwards: a base to merge in, like uncommitted work to keep, is the agent's.
    pullNeedsAgent: state === "behind" && (work.dirty || work.behind === 0),
  };
}

/** What the agent is asked for each step it takes (the same words as `branch_step::act`). */
export function agentPrompt(action: BranchAction, snapshot: MachineBranchSnapshot): string {
  const branch = JSON.stringify(snapshot.branch);
  const base = JSON.stringify(snapshot.base);
  if (action === "pull") {
    return snapshot.behindUpstream
      ? `Pull the latest commits into branch ${branch} (base ${base}). Preserve all uncommitted, staged and untracked work; reconcile both sides and resolve conflicts. Do not discard changes, force push, push, merge a pull request or open a new pull request. Report the result.`
      : `Merge the latest ${base} into branch ${branch}. Preserve all uncommitted, staged and untracked work; reconcile both sides and resolve conflicts. Do not discard changes, force push, push, merge a pull request or open a new pull request. Report the result.`;
  }
  const task = action === "resolveConflicts"
    ? "Reconcile this branch with its upstream and base, and resolve any conflicts while preserving both sides' work. Do not force push."
    : action === "fixChecks"
      ? "Inspect the pull request's failing checks, fix their causes and run the relevant checks locally."
      : "Read the pull request's requested changes, address them and run the relevant checks locally.";
  return `${task}\nBranch: ${branch}. Base: ${base}. Pull request: ${snapshot.pr ? JSON.stringify(snapshot.pr.url) : "null"}.\nDo not push, merge a pull request or open a new pull request. Report the changes and any remaining failures.`;
}

/** Whether the action is the agent's to take in this snapshot. */
export function isAgentAction(action: BranchAction, snapshot: MachineBranchSnapshot | null): boolean {
  return action === "resolveConflicts" || action === "fixChecks" || action === "addressReview" || (action === "pull" && !!snapshot?.pullNeedsAgent);
}

/**
 * Lines added and removed on the branch against its base, uncommitted work
 * included: `git.reviewRange` from the merge base with `origin/<base>` (else
 * the local `<base>`) to the working tree. Null where it cannot be counted.
 */
export async function branchDiffSize(source: GitSource, base: string): Promise<{ additions: number; deletions: number } | null> {
  let range: { base: string; head: string } | null = null;
  for (const target of [`origin/${base}`, base]) {
    try { range = await source.reviewRange(target, false); break; } catch { /* the next candidate */ }
  }
  if (!range) return null;
  try {
    const files = await source.changesBetween(range.base, range.head);
    return files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
  } catch {
    // Too many files to answer completely: no number rather than a wrong one.
    return null;
  }
}

/** The two snapshots describe the same branch state, so an action prepared on one may run on the other. */
export function sameBranchState(expected: MachineBranchSnapshot, now: MachineBranchSnapshot | null): boolean {
  return !!now && now.branch === expected.branch && now.head === expected.head && now.base === expected.base && now.state === expected.state
    && (now.pr?.number ?? null) === (expected.pr?.number ?? null) && (now.pr?.headSha ?? null) === (expected.pr?.headSha ?? null)
    && now.pullNeedsAgent === expected.pullNeedsAgent;
}

/** The namespace that pins a merge to the head the person saw. */
export const MACHINE_MERGE_PIN = "machine/9";
/** How often the header's branch is read again while the session is shown: a pull request changes on GitHub too. */
export const BRANCH_POLL_MS = 30_000;

/** What `CloudSessionModel.branch` is for a machine session. */
export interface MachineSessionBranch {
  /** The session's repository on the machine is read: connected, with a Git source. */
  served: boolean;
  /** The header's snapshot; null where it shows nothing (no branch, the default branch, not GitHub) or before the first read. */
  snapshot: MachineBranchSnapshot | null;
  /** The branch's name as `git.status` reads it, even where no step is shown. */
  branchName: string | null;
  /** Lines added and removed against the base, uncommitted work included; null where not counted. */
  diff: { additions: number; deletions: number } | null;
  /** The branch's pull requests on GitHub, the open one first; empty when none or not read. */
  prs: MachinePr[];
  /** The pull request read succeeded: an empty `prs` means none. */
  prsKnown: boolean;
  loading: boolean;
  error: string | null;
  /** The machine pins a merge to the head the person saw (`machine/9`). */
  headPinned: boolean;
  refresh(): Promise<MachineBranchSnapshot | null>;
  /** `git.push` on the machine, with its Git sign-in. Resolves to a notice worth showing, or null. */
  push(): Promise<string | null>;
  /** `git.pull` on the machine: a fast-forward only; anything else is the agent's (`snapshot.pullNeedsAgent`). */
  pull(): Promise<string | null>;
  /** `git.commit` of all the work, then `git.push`. */
  commitPush(message: string): Promise<string | null>;
  /** `git.prCreate` for the branch, into `snapshot.base` unless `base` is named. */
  createPr(input: { title: string; body: string; draft: boolean; base?: string | null }): Promise<string | null>;
  /** `git.prReady` for the branch's open draft. */
  markReady(): Promise<void>;
  /**
   * `git.prMerge` of the branch's open pull request, once a fresh read finds
   * the state the person saw (`expected`): the same head, base, pull request
   * and step. With `machine/9` GitHub refuses it too if the head moved since.
   */
  merge(method: "merge" | "squash" | "rebase" | "queue", expected: MachineBranchSnapshot): Promise<void>;
  /** What a tab's agent is asked for an agent step of the current snapshot; null when there is none to ask. */
  agentPrompt(action: BranchAction): string | null;
  isAgentAction(action: BranchAction): boolean;
}

interface BranchRead {
  key: string;
  work: SourceStatus | null;
  snapshot: MachineBranchSnapshot | null;
  prs: MachinePr[];
  prsKnown: boolean;
  diff: { additions: number; deletions: number } | null;
  error: string | null;
}

/** Everything the header shows of the branch, from one read of the machine. */
export async function readMachineBranch(source: GitSource, input: { remote: string | null; working: boolean; baseRef?: string | null }): Promise<Omit<BranchRead, "key" | "error">> {
  const work = await source.workStatus();
  let prs: MachinePr[] = [];
  let prsKnown = false;
  if (work.isRepo && work.branch) {
    try {
      const listed = (await source.prs(work.branch)) as MachinePr[];
      prs = [...listed].sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN"));
      prsKnown = true;
    } catch {
      // Not read (no gh sign-in, offline): local steps only, never Create PR.
    }
  }
  const snapshot = composeMachineSnapshot({ work, remote: input.remote, pr: branchPr(prs, work.branch ?? ""), known: prsKnown, working: input.working, baseRef: input.baseRef });
  const diff = snapshot ? await branchDiffSize(source, snapshot.base) : null;
  return { work, snapshot, prs, prsKnown, diff };
}

/**
 * The model's `branch`: read on each connect and when the Git source
 * changes, again when an agent turn in the session ends, every
 * {@link BRANCH_POLL_MS} while shown, and after each of its own actions.
 */
export function useMachineSessionBranch(input: {
  gitSource: GitSource | undefined;
  /** `origin`'s URL on the machine, as `git.repositories` lists it; null when not known. */
  remote: string | null;
  /** An agent turn runs in the session. */
  working: boolean;
  baseRef?: string | null;
  headPinned: boolean;
  generation: string | null;
}): MachineSessionBranch {
  const { gitSource, remote, working, baseRef, headPinned, generation } = input;
  const key = gitSource ? `${gitSource.key}|${remote ?? ""}|${baseRef ?? ""}` : "";
  const [read, setRead] = useState<BranchRead | null>(null);
  const [loading, setLoading] = useState(false);
  const own = read?.key === key ? read : null;
  const live = useRef({ gitSource, remote, working, baseRef, key });
  live.current = { gitSource, remote, working, baseRef, key };
  const inflight = useRef<Promise<MachineBranchSnapshot | null> | null>(null);

  const refresh = useCallback(async () => {
    const now = live.current;
    if (!now.gitSource) return null;
    if (inflight.current) return inflight.current;
    setLoading(true);
    const reading = readMachineBranch(now.gitSource, { remote: now.remote, working: now.working, baseRef: now.baseRef })
      .then((found) => {
        if (live.current.key === now.key) setRead({ key: now.key, ...found, error: null });
        return found.snapshot;
      })
      .catch((cause: unknown) => {
        if (live.current.key === now.key)
          setRead((last) => ({ ...(last?.key === now.key ? last : { work: null, snapshot: null, prs: [], prsKnown: false, diff: null }), key: now.key, error: now.gitSource!.errorMessage(cause) }));
        return null;
      })
      .finally(() => {
        inflight.current = null;
        setLoading(false);
      });
    inflight.current = reading;
    return reading;
  }, []);

  useEffect(() => {
    if (!gitSource || !generation) return;
    void refresh();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
    }, BRANCH_POLL_MS);
    return () => clearInterval(timer);
  }, [gitSource, generation, key, working, refresh]);

  const source = useCallback(() => {
    if (!gitSource) throw new Error("The session's repository is read once its machine is connected.");
    if (!gitSource.canWrite) throw new Error("Only a computer paired with the machine changes its Git.");
    return gitSource;
  }, [gitSource]);
  const after = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } finally {
        await refresh();
      }
    },
    [refresh],
  );
  const snapshot = own?.snapshot ?? null;
  const open = snapshot?.pr?.state === "OPEN" ? snapshot.pr : null;

  const push = useCallback(() => after(() => source().push()), [after, source]);
  const pull = useCallback(() => after(() => source().pull()), [after, source]);
  const commitPush = useCallback(
    (message: string) =>
      after(async () => {
        const git = source();
        const committed = await git.commit(message);
        const pushed = await git.push();
        return pushed ?? committed;
      }),
    [after, source],
  );
  const createPr = useCallback(
    (pr: { title: string; body: string; draft: boolean; base?: string | null }) => after(() => source().createPr({ title: pr.title, body: pr.body, draft: pr.draft, base: pr.base ?? snapshot?.base ?? null })),
    [after, source, snapshot?.base],
  );
  const markReady = useCallback(async () => {
    if (!open) throw new Error("This branch has no open pull request.");
    await after(() => source().readyPr(open.number));
  }, [after, source, open]);
  const merge = useCallback(
    async (method: "merge" | "squash" | "rebase" | "queue", expected: MachineBranchSnapshot) => {
      const git = source();
      const now = await refresh();
      if (!sameBranchState(expected, now) || !now?.pr || now.pr.state !== "OPEN") throw new Error("The branch changed since it was shown. Look at it again before merging.");
      await after(() => git.mergePr(now.pr!.number, method, headPinned && now.pr!.headSha ? now.pr!.headSha : undefined));
    },
    [source, refresh, after, headPinned],
  );
  const agentPromptFor = useCallback((action: BranchAction) => (snapshot && isAgentAction(action, snapshot) ? agentPrompt(action, snapshot) : null), [snapshot]);
  const isAgent = useCallback((action: BranchAction) => isAgentAction(action, snapshot), [snapshot]);

  return useMemo(
    () => ({
      served: !!gitSource,
      snapshot,
      branchName: own?.work?.branch ?? null,
      diff: own?.diff ?? null,
      prs: own?.prs ?? [],
      prsKnown: own?.prsKnown ?? false,
      loading,
      error: own?.error ?? null,
      headPinned,
      refresh,
      push,
      pull,
      commitPush,
      createPr,
      markReady,
      merge,
      agentPrompt: agentPromptFor,
      isAgentAction: isAgent,
    }),
    [gitSource, snapshot, own, loading, headPinned, refresh, push, pull, commitPush, createPr, markReady, merge, agentPromptFor, isAgent],
  );
}
