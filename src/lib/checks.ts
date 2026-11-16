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

/** How long a check ran, or has run so far while it runs. Null where GitHub gave no start. */
export function checkDurationMs(check: PrCheck, now: number): number | null {
  const started = check.startedAt ? Date.parse(check.startedAt) : NaN;
  if (Number.isNaN(started)) return null;
  const ended = check.completedAt ? Date.parse(check.completedAt) : NaN;
  const until = checkBucket(check.state) === "running" || Number.isNaN(ended) ? now : ended;
  return Math.max(0, until - started);
}

/** "41s", "3m 12s", "1h 4m": a finished check's time to the second. */
export function durationLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`;
}

/** A running check's time so far, to the minute: "<1m", "4m". */
function runningLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "<1m" : minutes < 60 ? `${minutes}m` : durationLabel(minutes * 60_000);
}

/**
 * A check's second line (PRO-394): its state and time, then GitHub's own line
 * when it gave one. "Failed after 3m 12s · 2 tests failing", "Running · 4m",
 * "Passed in 2m 48s", "Skipped".
 */
export function checkLine(check: PrCheck, now: number): string {
  const bucket = checkBucket(check.state);
  const ms = checkDurationMs(check, now);
  const label = checkStateLabel(check.state);
  const state = bucket === "running"
    ? `${label}${ms == null ? "" : ` · ${runningLabel(ms)}`}`
    : bucket === "failed"
      ? `${label}${ms == null ? "" : ` after ${durationLabel(ms)}`}`
      : bucket === "passed"
        ? `Passed${ms == null ? "" : ` in ${durationLabel(ms)}`}`
        : label;
  const summary = check.summary?.trim();
  return summary && bucket !== "skipped" ? `${state} · ${summary}` : state;
}

/** A finished or running check's time alone, for the short rows: "41s", "running · 3m". */
export function checkTime(check: PrCheck, now: number): string {
  const ms = checkDurationMs(check, now);
  const bucket = checkBucket(check.state);
  if (bucket === "running") return ms == null ? checkStateLabel(check.state).toLowerCase() : `${checkStateLabel(check.state).toLowerCase()} · ${runningLabel(ms)}`;
  if (bucket === "skipped") return "skipped";
  return ms == null ? "" : durationLabel(ms);
}

/** Whether `name` is a check the merge needs. Unknown requirements say nothing. */
export const isRequiredCheck = (pr: Pick<PullRequest, "requiredChecks">, name: string) => !!pr.requiredChecks?.includes(name);

/** Provider URLs are untrusted data; only web links may leave the app. */
export function webUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
