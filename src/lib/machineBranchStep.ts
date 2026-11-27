import type { PullRequest } from "@/lib/api";
import { withActionPrompt } from "@/lib/sharedSetups";
import { FAILING_CHECKS } from "@/lib/checks";
import type { SourceStatus } from "@/lib/gitSource";
import type { BranchAction, BranchState } from "@/lib/branchStep";

/**
 * The session header's next Git step for a session on a paired machine
 * (PRO-404). A local session's comes from `branch_step.rs`, which runs git and
 * gh on this computer; a machine's is read through the machine's `git/1`
 * (`git.status`, `git.prs`) and its actions run there, with the machine's Git
 * sign-in. The rules are `branch_step::resolve`, `branch_step::actions` and
 * `branch_overview::next_step`, in the same order: local work takes
 * precedence over hosted readiness, and nothing unread turns into Merge.
 */

/** The pull request the header reads for the branch, as the machine's `git.prs` gives it. */
export type MachinePr = PullRequest;

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
export function branchPr(prs: readonly PullRequest[], branch: string): MachinePr | null {
  const mine = prs.filter((pr) => pr.head === branch);
  return mine.find((pr) => pr.state === "OPEN") ?? mine[0] ?? null;
}

export function machineBranchBase(work: SourceStatus, pr: MachinePr | null, baseRef?: string | null): string | null {
  if (pr?.state === "OPEN") return pr.base;
  const recorded = baseRef?.replace(/^(refs\/heads\/|(?:refs\/remotes\/)?origin\/)/, "");
  return recorded && recorded !== "HEAD" ? recorded : work.defaultBranch;
}

type Bucket = "pass" | "fail" | "pending";
/** `issue_pipeline::gate::check_bucket`: anything not passed or failed is pending. */
function bucket(state: string): Bucket {
  if (state === "success" || state === "neutral" || state === "skipped") return "pass";
  return FAILING_CHECKS.includes(state) ? "fail" : "pending";
}

type LocalStep = "conflicts" | "reconcile" | "pull" | "commit" | "push" | null;

/** `branch_overview::next_step` for a supported branch (named, not the default, with a remote). */
function localStep(work: SourceStatus, baseConflicts: boolean, aheadOfBase: number | null): LocalStep {
  if (work.conflicted?.length || work.operation) return "conflicts";
  if (work.ahead > 0 && work.behind > 0) return "reconcile";
  if (work.behind > 0) return "pull";
  if (baseConflicts) return "conflicts";
  if (work.dirty) return "commit";
  if (work.ahead > 0 || (!work.upstream && (aheadOfBase ?? 0) > 0)) return "push";
  return null;
}

/** `branch_step::resolve`. */
export function resolveMachineStep(work: SourceStatus, pr: MachinePr | null, working: boolean, aheadOfBase: number | null): BranchState {
  if (working) return "agentWorking";
  // GitHub describes the published head; a local resolution waiting to be pushed must not inherit its conflicts.
  const current = pr && pr.state === "OPEN" && !!pr.headSha && work.head === pr.headSha ? pr : null;
  const baseConflicts = !!current && (current.mergeable === "CONFLICTING" || current.mergeState === "DIRTY");
  const baseBehind = !!current && current.mergeState === "BEHIND";
  const local = localStep(work, baseConflicts, aheadOfBase);
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
export function composeMachineSnapshot(input: { work: SourceStatus; remote: string | null; pr: MachinePr | null; known: boolean; working: boolean; baseRef?: string | null; aheadOfBase?: number | null }): MachineBranchSnapshot | null {
  const { work, known, working } = input;
  if (!work.isRepo || !work.branch || !work.head || work.branch === work.defaultBranch || !isGithubRemote(input.remote)) return null;
  const pr = known ? input.pr : null;
  const base = machineBranchBase(work, pr, input.baseRef);
  if (!base || base === work.branch) return null;
  const aheadOfBase = input.aheadOfBase === undefined ? (base === work.defaultBranch ? work.aheadOfBase : null) : input.aheadOfBase;
  const canCreate = known && (aheadOfBase ?? 0) > 0;
  const state = resolveMachineStep(work, pr, working, aheadOfBase);
  if (!known && !["agentWorking", "conflicts", "diverged", "behind", "uncommitted", "ahead"].includes(state)) return null;
  if (state === "noPr" && !canCreate) return null;
  if (state === "hidden") return null;
  let actions = machineActions(state, pr);
  if (!canCreate) actions = actions.filter((action) => action !== "createPr");
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
export function agentPrompt(action: BranchAction, snapshot: MachineBranchSnapshot, target: string | null = null): string {
  const prompt = stepPrompt(action, snapshot);
  // PRO-154: the instructions for the action, the session's organization's then the person's. A pull is not a conflict step.
  if (action === "resolveConflicts") return withActionPrompt(prompt, "resolveConflicts", target);
  return action === "fixChecks" ? withActionPrompt(prompt, "fixChecks", target) : prompt;
}

function stepPrompt(action: BranchAction, snapshot: MachineBranchSnapshot): string {
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

/** The two snapshots describe the same branch state, so an action prepared on one may run on the other. */
export function sameBranchState(expected: MachineBranchSnapshot, now: MachineBranchSnapshot | null): boolean {
  return !!now && now.branch === expected.branch && now.head === expected.head && now.base === expected.base && now.state === expected.state
    && now.pr?.number === expected.pr?.number && now.pr?.url === expected.pr?.url && now.pr?.headSha === expected.pr?.headSha
    && now.pullNeedsAgent === expected.pullNeedsAgent;
}
