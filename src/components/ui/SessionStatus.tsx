import { Check, Circle, CircleAlert, Clock, FileText, GitBranch, GitMerge, GitPullRequest, GitPullRequestDraft, ListOrdered, Loader2, MessageCircleQuestion, ShieldQuestion, Square, TriangleAlert } from "@/icons";
import type { StatusDescription } from "@terminalx/portable/sessionStatus";
import { useSessionRowStatus, type StatusSession } from "@/lib/sessionRowStatus";
import { cn } from "@/lib/cn";
import { Working } from "./StatusMark";

const icons: Record<string, typeof Circle> = { shield: ShieldQuestion, question: MessageCircleQuestion, plan: FileText, error: CircleAlert, attention: TriangleAlert, stop: Square, loader: Loader2, clock: Clock, merged: GitMerge, conflict: TriangleAlert, draft: GitPullRequestDraft, queue: ListOrdered, check: Check, pr: GitPullRequest, branch: GitBranch, circle: Circle };
const colors: Record<string, string> = { warning: "text-warning", destructive: "text-destructive", info: "text-info", success: "text-add", merged: "text-merged", muted: "text-faint" };

export function StatusBadge({ status, className }: { status: StatusDescription; className?: string }) {
  const Icon = icons[status.icon] ?? Circle;
  return <span title={status.tooltip} data-session-status={status.id} className={cn("inline-flex min-w-0 items-center gap-1 text-[10px]", colors[status.color], className)}>
    {status.icon === "working" ? <Working className="size-3" /> : <Icon aria-hidden className="size-3 shrink-0" />}
    <span className="truncate">{status.label}</span>
  </span>;
}

export function SessionStatus({ session, peers, className }: { session: StatusSession; peers?: readonly StatusSession[]; className?: string }) {
  return <StatusBadge status={useSessionRowStatus(peers ?? [session])} className={className} />;
}
