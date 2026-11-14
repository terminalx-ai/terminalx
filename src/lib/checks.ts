import type { PrCheck, PullRequest } from "./api";

export const FAILING_CHECKS = ["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"];
export const RUNNING_CHECKS = ["pending", "in_progress", "queued", "expected", "waiting", "requested"];
export const isFailingCheck = (check: PrCheck) => FAILING_CHECKS.includes(check.state);

export function checkBucket(state: string): "passed" | "failed" | "running" | "skipped" | "unknown" {
  if (FAILING_CHECKS.includes(state)) return "failed";
  if (RUNNING_CHECKS.includes(state)) return "running";
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

/** A check's state in the words the pipeline panel says it in. */
export function checkStateLabel(state: string): string {
  if (state === "in_progress" || state === "pending") return "Running";
  if (RUNNING_CHECKS.includes(state)) return "Queued";
  if (state === "success") return "Passed";
  if (state === "cancelled") return "Cancelled";
  if (state === "neutral" || state === "skipped") return "Skipped";
  if (FAILING_CHECKS.includes(state)) return "Failed";
  return state ? state[0].toUpperCase() + state.slice(1).replace(/_/g, " ") : "Unknown";
}

/**
 * Whole minutes a check has been in its state: running since it started, or
 * how long it ran once finished. Null where GitHub gave no start, as it does
 * not for a check still queued.
 */
export function checkMinutes(check: PrCheck, now: number): number | null {
  const started = check.startedAt ? Date.parse(check.startedAt) : NaN;
  if (Number.isNaN(started)) return null;
  const ended = check.completedAt ? Date.parse(check.completedAt) : NaN;
  const until = checkBucket(check.state) === "running" || Number.isNaN(ended) ? now : ended;
  return Math.max(0, Math.floor((until - started) / 60_000));
}

export function minutesLabel(minutes: number): string {
  return minutes < 1 ? "<1 min" : `${minutes} min`;
}

/**
 * Where the checks a merge waits on stand, as the merge gate counts them: by
 * name, with a check run more than once on the commit counted by its worst run.
 * Checks outside `required` never change it.
 */
export function requiredCheckCounts(checks: PrCheck[], required: string[]) {
  const counts = { total: required.length, passed: 0, failed: [] as string[], waiting: 0 };
  for (const name of required) {
    const buckets = checks.filter((check) => check.name === name).map((check) => checkBucket(check.state));
    if (buckets.includes("failed")) counts.failed.push(name);
    else if (buckets.length && buckets.every((bucket) => bucket === "passed" || bucket === "skipped")) counts.passed++;
    else counts.waiting++;
  }
  return counts;
}

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
