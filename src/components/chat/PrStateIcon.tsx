import { GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "@/icons";
import { cn } from "@/lib/cn";
import type { PrRowState } from "@/lib/prRow";

const TONE: Record<PrRowState, string> = {
  merged: "text-merged",
  closed: "text-destructive",
  draft: "text-faint",
  failing: "text-destructive",
  running: "text-warning",
  ready: "text-add",
  open: "text-info",
};

/** The pull request mark, coloured by where the pull request stands. */
export function PrStateIcon({ state, className }: { state: PrRowState; className?: string }) {
  const Icon = state === "draft" ? GitPullRequestDraft : state === "closed" ? GitPullRequestClosed : GitPullRequest;
  return <Icon aria-hidden data-pr-state={state} className={cn("size-3.5 shrink-0", TONE[state], className)} />;
}
