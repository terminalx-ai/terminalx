import type { PullRequest } from "./api";
import { checkCounts } from "./checks";

/** What a pull request's row says about it at a glance, worst news first. */
export type PrRowState = "merged" | "closed" | "draft" | "failing" | "running" | "ready" | "open";

/** Rows built from a search carry every field; older runtimes and tests may leave some out. */
export function prRowState(pr: Pick<PullRequest, "state"> & Partial<Pick<PullRequest, "isDraft" | "checks">>): PrRowState {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  const counts = checkCounts(pr.checks ?? []);
  if (counts.failed) return "failing";
  if (counts.running) return "running";
  return counts.passed ? "ready" : "open";
}

export const PR_ROW_LABEL: Record<PrRowState, string> = {
  merged: "merged",
  closed: "closed",
  draft: "draft",
  failing: "checks failing",
  running: "checks running",
  ready: "ready",
  open: "open",
};

/** The checks in a few words for a row's second line: "2 checks failing", "checks running", "checks passed"; null with no checks. */
export function prChecksLine(pr: Partial<Pick<PullRequest, "checks">>): string | null {
  const counts = checkCounts(pr.checks ?? []);
  if (counts.failed) return `${counts.failed} check${counts.failed === 1 ? "" : "s"} failing`;
  if (counts.running) return "checks running";
  return counts.passed ? "checks passed" : null;
}
