import { Circle, CircleAlert, CircleDashed, CircleDot, CircleX, GitMerge, GitPullRequest, GitPullRequestDraft, LoaderCircle, ShieldAlert } from "@/icons";
import { statusText, statusTooltip, type StatusDescription } from "@terminalx/portable/sessionStatus";
import { useSessionRowStatus, type StatusSession } from "@/lib/sessionRowStatus";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";

/** The 17.07 status-mark catalogue: one glyph and colour per row label. */
const icons: Record<string, typeof Circle> = {
  approval: ShieldAlert, attention: CircleAlert, working: LoaderCircle, pr: GitPullRequest, failing: CircleX,
  ready: GitMerge, draft: GitPullRequestDraft, merged: GitMerge, none: Circle, uncommitted: CircleDot, not_started: CircleDashed,
};
export const STATUS_COLORS: Record<string, string> = {
  accent: "text-accent", info: "text-info", del: "text-destructive", add: "text-add", soft: "text-muted-foreground", merged: "text-merged", faint: "text-faint",
};

/**
 * A session's status mark alone, as sidebar rows lead with it (02.04). The
 * tooltip names the state behind the label: which kind of approval, a
 * merge queue, a setup step.
 */
export function StatusMarkIcon({ status, className, decorative = false }: { status: StatusDescription; className?: string; decorative?: boolean }) {
  const { animations } = usePrefs();
  const Icon = icons[status.icon] ?? Circle;
  // Inside a row's button the row names itself; the status is then the row's description, not part of its name.
  const label = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": statusText(status) };
  return <span {...label} title={statusTooltip(status)} data-session-status={status.id} data-status-label={status.label} data-testid={`status-${status.label.toLowerCase().replaceAll(" ", "-")}`} className={cn("inline-flex shrink-0", STATUS_COLORS[status.color], className)}>
    <Icon aria-hidden className={cn("size-3.5", status.icon === "working" && animations && "animate-spin")} />
  </span>;
}

/** The mark with its full label, as the overview shows it: 'Checks failing · PR #781'. */
export function StatusBadge({ status, className }: { status: StatusDescription; className?: string }) {
  const { animations } = usePrefs();
  const Icon = icons[status.icon] ?? Circle;
  return <span title={statusTooltip(status)} data-session-status={status.id} data-status-label={status.label} data-testid={`status-${status.label.toLowerCase().replaceAll(" ", "-")}`} className={cn("inline-flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground", className)}>
    <Icon aria-hidden className={cn("size-3.5 shrink-0", STATUS_COLORS[status.color], status.icon === "working" && animations && "animate-spin")} />
    <span className="truncate">{statusText(status)}</span>
  </span>;
}

/** Full label for one session, or a collapsed row's sessions. */
export function SessionStatus({ session, peers, className }: { session: StatusSession; peers?: readonly StatusSession[]; className?: string }) {
  return <StatusBadge status={useSessionRowStatus(peers ?? [session])} className={className} />;
}

/** Mark only, for sidebar rows. */
export function SessionStatusMark({ session, peers, className }: { session: StatusSession; peers?: readonly StatusSession[]; className?: string }) {
  return <StatusMarkIcon status={useSessionRowStatus(peers ?? [session])} className={className} />;
}

/**
 * What a sidebar row shows after its title (02.04): the open PR's number, the
 * line counts, or how long ago it was active. A working agent and a merged
 * branch show the time; a row waiting on you or with work in hand shows its lines.
 */
export type RowMeta = { kind: "pr"; number: number } | { kind: "lines" } | { kind: "time" };
export function rowMeta(status: StatusDescription, lines: { additions: number; deletions: number }): RowMeta {
  if (status.pr) return { kind: "pr", number: status.pr };
  if (status.label === "Working" || status.label === "Merged") return { kind: "time" };
  return lines.additions || lines.deletions ? { kind: "lines" } : { kind: "time" };
}
