import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, CircleDot, GitBranch, GitMerge, GitPullRequest, Loader2, MessageSquare } from "@/icons";
import { api, errorMessage, type BranchContributor, type BranchOverview, type PullRequest } from "@/lib/api";
import { localGitSource } from "@/lib/gitSource";
import { selectSession, useSessionStore } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { CommitInfo } from "@/types/session";
import { mergeReadiness } from "./PrPanel";

/** Commits drawn as dots on either line of the picture; the rest are counted beside it. */
const DOTS = 6;

/**
 * Where the reader is working: the branch against the one it merges into,
 * drawn as two lines from the fork, then whether it would merge, who wrote
 * it, the chats on it here, and its commits. Read from refs on this
 * computer (Refresh after a fetch to see the remote's latest).
 */
export function BranchPanel({ cwd, active, version = 0, sessionId, onOpenPr }: { cwd: string; active: boolean; version?: number; sessionId?: string; onOpenPr: () => void }) {
  const [overview, setOverview] = useState<BranchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pr, setPr] = useState<PullRequest | null | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // An agent's turn changes the branch as it works: read again, but not on every event.
    const id = window.setTimeout(() => {
      api
        .branchOverview(cwd)
        .then((next) => {
          if (cancelled) return;
          setOverview(next);
          setError(null);
        })
        .catch((e) => !cancelled && setError(errorMessage(e)));
    }, overview ? 600 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [cwd, active, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const branch = overview?.branch ?? null;
  useEffect(() => {
    if (!active || !branch || overview?.onBase) return;
    let cancelled = false;
    const source = localGitSource(cwd);
    source
      .ghAvailable()
      .then((ok) => (ok ? source.prs(branch) : []))
      .then((prs) => !cancelled && setPr(prs.find((p) => p.state === "OPEN") ?? prs[0] ?? null))
      .catch(() => !cancelled && setPr(null));
    return () => {
      cancelled = true;
    };
  }, [cwd, branch, active, overview?.onBase]);

  const store = useSessionStore();
  const chats = useMemo(() => store.sessions.filter((s) => s.cwd === cwd && !s.archived && !s.worktreeRemoved), [store.sessions, cwd]);

  if (error && !overview) return <p className="p-4 text-xs text-destructive">{error}</p>;
  if (!overview) {
    return (
      <p role="status" className="flex items-center gap-1.5 p-4 text-xs text-faint">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Reading the branch…
      </p>
    );
  }
  const baseName = overview.base?.replace(/^origin\//, "") ?? "the base";

  return (
    <div className="h-full overflow-y-auto scrollbar-thin" data-testid="branch-panel">
      <div className="flex flex-col gap-4 p-3">
        <header className="flex flex-col gap-1 px-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="size-4 shrink-0 text-accent" aria-hidden />
            <h3 className="truncate font-mono text-[13px] text-foreground" title={branch ?? "Detached HEAD"} data-testid="branch-name">
              {branch ?? "Detached HEAD"}
            </h3>
            <StatusPill overview={overview} pr={pr} />
          </div>
          {overview.base && (
            <p className="text-[11px] text-faint">
              {overview.onBase ? (
                <>This is the branch others merge into.</>
              ) : (
                <>
                  Merges into <span className="font-mono text-muted-foreground">{overview.base}</span>
                  {overview.forkPoint && (
                    <>
                      {" "}· branched {since(overview.forkPoint.date)} at <span className="font-mono">{overview.forkPoint.shortSha}</span>
                    </>
                  )}
                </>
              )}
            </p>
          )}
        </header>

        {overview.base && !overview.onBase && <BranchPicture overview={overview} baseName={baseName} />}

        <Section title="Merge status">
          {!overview.onBase && (
            <Row
              icon={<GitPullRequest />}
              tone={pr ? (pr.state === "MERGED" ? "good" : mergeReadiness(pr).ok ? "good" : "muted") : "muted"}
              testId="branch-pr"
              action={
                <button type="button" className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={onOpenPr}>
                  {pr ? "Open" : "Create"}
                </button>
              }
            >
              {pr === undefined ? "Looking for a pull request…" : pr ? `#${pr.number} · ${pr.state === "OPEN" ? mergeReadiness(pr).label : pr.state === "MERGED" ? "Merged" : "Closed"}` : "No pull request yet"}
              {pr && pr.reviewDecision ? <span className="text-faint"> · {reviewLabel(pr.reviewDecision)}</span> : null}
            </Row>
          )}
          {!overview.onBase && overview.base && (
            <Row icon={overview.merge.state === "conflicts" ? <AlertTriangle /> : <GitMerge />} tone={overview.merge.state === "conflicts" ? "bad" : overview.merge.state === "clean" ? "good" : "muted"} testId="branch-merge">
              {overview.merge.state === "clean"
                ? `Merges cleanly into ${baseName}`
                : overview.merge.state === "conflicts"
                  ? `Conflicts with ${baseName} in ${overview.merge.conflicted.length} ${overview.merge.conflicted.length === 1 ? "file" : "files"}`
                  : overview.merge.state === "merged"
                    ? `Nothing left to merge into ${baseName}`
                    : `Can't tell whether it merges into ${baseName}`}
              {overview.merge.state === "conflicts" && overview.merge.conflicted.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {overview.merge.conflicted.slice(0, 6).map((path) => (
                    <li key={path} className="truncate font-mono text-[11px] text-muted-foreground" title={path}>
                      {path}
                    </li>
                  ))}
                  {overview.merge.conflicted.length > 6 && <li className="text-[11px] text-faint">and {overview.merge.conflicted.length - 6} more</li>}
                </ul>
              )}
            </Row>
          )}
          {!overview.onBase && overview.behind > 0 && (
            <Row icon={<ArrowDown />} tone="warn" testId="branch-behind">
              {baseName} has {overview.behind} new {overview.behind === 1 ? "commit" : "commits"} since you branched
            </Row>
          )}
          <Row icon={<ArrowUp />} tone={!overview.upstream || overview.unpushed > 0 ? "warn" : "good"} testId="branch-remote">
            {!overview.upstream
              ? "Not pushed yet"
              : overview.unpushed > 0 || overview.unpulled > 0
                ? [overview.unpushed > 0 && `${overview.unpushed} to push`, overview.unpulled > 0 && `${overview.unpulled} to pull`].filter(Boolean).join(" · ")
                : `Up to date with ${overview.upstream}`}
          </Row>
          {overview.dirty && (
            <Row icon={<CircleDot />} tone="warn" testId="branch-dirty">
              Uncommitted changes
            </Row>
          )}
        </Section>

        {(overview.contributors.length > 0 || overview.baseContributors.length > 0) && (
          <Section title="People">
            {overview.contributors.map((person) => (
              <Person key={person.email} person={person} />
            ))}
            {overview.baseContributors.length > 0 && !overview.onBase && (
              <p className="px-1 pt-1 text-[11px] text-faint" data-testid="branch-base-people">
                Also on {baseName} since you branched: {overview.baseContributors.map((p) => p.name).join(", ")}
              </p>
            )}
          </Section>
        )}

        {chats.length > 0 && (
          <Section title="Chats on this branch">
            {chats.map((chat) => (
              <button
                key={chat.id}
                type="button"
                onClick={() => selectSession(chat.id)}
                className={cn("flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-veil-raised", chat.id === sessionId && "text-foreground")}
              >
                <MessageSquare className="size-3.5 shrink-0 text-faint" aria-hidden />
                <span className="truncate">{chat.title || "Untitled"}</span>
                {chat.id === sessionId && <span className="ml-auto shrink-0 text-[11px] text-faint">this chat</span>}
              </button>
            ))}
          </Section>
        )}

        {!overview.onBase && (
          <Section title={`Commits on this branch · ${overview.ahead}`}>
            {overview.commits.length === 0 ? <p className="px-1 text-xs text-faint">No commits of its own yet.</p> : overview.commits.map((c) => <Commit key={c.sha} commit={c} />)}
            {overview.ahead > overview.commits.length && <p className="px-1 text-[11px] text-faint">and {overview.ahead - overview.commits.length} older</p>}
          </Section>
        )}
      </div>
    </div>
  );
}

/** "3d ago", "just now", or "on Oct 3" past a week. */
function since(iso: string): string {
  const r = relativeTime(iso);
  return r === "now" ? "just now" : /^\d/.test(r) ? `${r} ago` : `on ${r}`;
}

function reviewLabel(decision: string): string {
  return decision === "APPROVED" ? "Approved" : decision === "CHANGES_REQUESTED" ? "Changes requested" : decision === "REVIEW_REQUIRED" ? "Review required" : decision.toLowerCase();
}

/** One word for where the branch stands, beside its name. */
function StatusPill({ overview, pr }: { overview: BranchOverview; pr: PullRequest | null | undefined }) {
  const [label, tone] = overview.onBase
    ? ["Base", "muted"]
    : pr?.state === "MERGED"
      ? ["Merged", "good"]
      : overview.merge.state === "conflicts"
        ? ["Conflicts", "bad"]
        : overview.ahead === 0
          ? ["No commits", "muted"]
          : pr?.state === "OPEN"
            ? [mergeReadiness(pr).ok ? "Ready" : pr.isDraft ? "Draft PR" : "In review", mergeReadiness(pr).ok ? "good" : "muted"]
            : overview.behind > 0
              ? ["Behind", "warn"]
              : ["In progress", "muted"];
  return (
    <span
      data-testid="branch-status"
      className={cn(
        "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        tone === "good" && "bg-success/15 text-success",
        tone === "bad" && "bg-destructive/15 text-destructive",
        tone === "warn" && "bg-warning/15 text-warning",
        tone === "muted" && "bg-veil-raised text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

/**
 * The base along the top, the branch dropping from the fork below it: a dot
 * per commit (up to a few), with the counts at the ends.
 */
function BranchPicture({ overview, baseName }: { overview: BranchOverview; baseName: string }) {
  const W = 260;
  const forkX = 22;
  const baseY = 14;
  const branchY = 44;
  const mine = Math.min(overview.ahead, DOTS);
  const theirs = Math.min(overview.behind, DOTS);
  const step = (W - forkX - 70) / DOTS;
  const dotsAt = (n: number) => Array.from({ length: n }, (_, i) => forkX + 24 + i * step);
  const mineX = dotsAt(mine);
  const theirsX = dotsAt(theirs);
  const branchEnd = (mineX[mineX.length - 1] ?? forkX + 24) + 8;
  const baseEnd = Math.max((theirsX[theirsX.length - 1] ?? forkX + 24) + 8, forkX + 40);
  return (
    <figure className="rounded-lg bg-well/60 px-2 py-2 hairline" aria-label={`${overview.ahead} commits on this branch; ${baseName} moved ${overview.behind} since the fork`} data-testid="branch-picture">
      <svg viewBox={`0 0 ${W} 58`} className="h-auto w-full" role="img" aria-hidden>
        <line x1={4} y1={baseY} x2={baseEnd} y2={baseY} className="stroke-faint" strokeWidth={2} strokeLinecap="round" />
        <path d={`M ${forkX} ${baseY} C ${forkX + 10} ${baseY}, ${forkX + 6} ${branchY}, ${forkX + 18} ${branchY} L ${branchEnd} ${branchY}`} fill="none" className="stroke-accent" strokeWidth={2} strokeLinecap="round" />
        <circle cx={forkX} cy={baseY} r={3.5} className="fill-faint" />
        {theirsX.map((x) => (
          <circle key={`b${x}`} cx={x} cy={baseY} r={3.5} className="fill-muted-foreground" />
        ))}
        {mineX.map((x, i) => (
          <circle key={`m${x}`} cx={x} cy={branchY} r={i === mineX.length - 1 ? 4.5 : 3.5} className={i === mineX.length - 1 ? "fill-accent stroke-background" : "fill-accent"} strokeWidth={i === mineX.length - 1 ? 2 : 0} />
        ))}
        <text x={baseEnd + 8} y={baseY + 3.5} className="fill-muted-foreground text-[10px]">
          {baseName}
          {overview.behind > 0 ? ` +${overview.behind}` : ""}
        </text>
        <text x={branchEnd + 8} y={branchY + 3.5} className="fill-foreground text-[10px]">
          you {overview.ahead > 0 ? `+${overview.ahead}` : ""}
        </text>
      </svg>
    </figure>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1" aria-label={title}>
      <h4 className="px-1 text-[11px] font-medium text-faint">{title}</h4>
      {children}
    </section>
  );
}

function Row({ icon, tone, children, action, testId }: { icon: ReactNode; tone: "good" | "bad" | "warn" | "muted"; children: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md px-1 py-1 text-xs" data-testid={testId}>
      <span
        className={cn(
          "mt-px shrink-0 [&_svg]:size-3.5",
          tone === "good" && "text-success",
          tone === "bad" && "text-destructive",
          tone === "warn" && "text-warning",
          tone === "muted" && "text-faint",
        )}
        aria-hidden
      >
        {tone === "good" && !icon ? <Check /> : icon}
      </span>
      <div className="min-w-0 flex-1 text-muted-foreground">{children}</div>
      {action}
    </div>
  );
}

const HUES = [210, 150, 30, 280, 340, 190, 90, 0];

function Person({ person }: { person: BranchContributor }) {
  const initials = person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  const hue = HUES[[...person.email].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % HUES.length];
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-xs" title={person.email}>
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white" style={{ background: `hsl(${hue} 45% 45%)` }} aria-hidden>
        {initials}
      </span>
      <span className="truncate text-foreground">{person.name}</span>
      <span className="ml-auto shrink-0 text-[11px] text-faint">
        {person.commits} {person.commits === 1 ? "commit" : "commits"} · {relativeTime(person.last)}
      </span>
    </div>
  );
}

function Commit({ commit }: { commit: CommitInfo }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-1 py-0.5 text-xs" title={`${commit.subject}\n${commit.author} · ${commit.shortSha}`}>
      <span className="shrink-0 font-mono text-[11px] text-faint">{commit.shortSha}</span>
      <span className="truncate text-muted-foreground">{commit.subject}</span>
      <span className="ml-auto shrink-0 text-[11px] text-faint">{relativeTime(commit.date)}</span>
    </div>
  );
}
