import type { PrCheck, PullRequest } from "./api";

export const FAILING_CHECKS = ["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"];
export const RUNNING_CHECKS = ["pending", "in_progress", "queued", "expected", "waiting", "requested"];
export const isFailingCheck = (check: PrCheck) => FAILING_CHECKS.includes(check.state);

export function actionsRuns(pr: PullRequest, failedOnly = false): PrCheck[] {
  const runs = new Map<number, PrCheck>();
  for (const check of pr.checks) {
    if (check.actions && check.url && (!failedOnly || isFailingCheck(check))) runs.set(check.actions.runId, check);
  }
  return [...runs.values()];
}

export interface PendingCheckRun {
  prUrl: string;
  runId: number;
  failedOnly: boolean;
  signature: string;
  until: number;
}

export function runSignature(pr: PullRequest, runId: number): string {
  return JSON.stringify(pr.checks.filter((c) => c.actions?.runId === runId).map((c) => [c.name, c.url, c.state]).sort());
}

/** Bridge GitHub's eventual consistency without leaving a run pending forever. */
export function withPendingChecks(pr: PullRequest, pending: PendingCheckRun[], now = Date.now()): PullRequest {
  const runs = pending.filter((p) => p.prUrl === pr.url && p.until > now && p.signature === runSignature(pr, p.runId));
  if (!runs.length) return pr;
  return { ...pr, checks: pr.checks.map((check) => runs.some((p) => p.runId === check.actions?.runId && (!p.failedOnly || isFailingCheck(check))) ? { ...check, state: "queued" } : check) };
}
