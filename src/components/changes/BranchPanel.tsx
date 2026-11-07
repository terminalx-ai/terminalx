import { useEffect, useId, useState, type ReactNode } from "react";
import { GitBranch, Loader2, Sparkles } from "@/icons";
import { WithTooltip } from "@/components/ui/tooltip";
import { api, errorMessage, git, type BranchOverview, type PullRequest } from "@/lib/api";
import { localGitSource } from "@/lib/gitSource";
import { useGithubIdentity } from "@/lib/githubIdentity";
import { setDraft } from "@/lib/drafts";
import { showPanelTab } from "@/lib/panelTab";
import { useSessionStore } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { CommitInfo } from "@/types/session";
import { localStep, NextLine } from "./NextStep";

/**
 * Where the reader is working, read top down: the branch, the one thing to
 * do next, its pull request (`children`), then the branch drawn against the
 * one it came from, each commit its author's face. Read from refs on this
 * computer; what others pushed is fetched on opening and every few minutes.
 */
/** How often the Branch tab, while shown, asks the remote what others pushed. */
export const FETCH_EVERY = 5 * 60_000;

export function BranchPanel({
  cwd,
  active,
  version = 0,
  sessionId,
  from,
  onStep,
  inline = false,
  children,
}: {
  cwd: string;
  active: boolean;
  version?: number;
  sessionId?: string;
  /** The ref the session's worktree was made from: read against instead of the default branch. */
  from?: string | null;
  /** Whether the branch itself has a step to take first; the pull request's own step waits on it. */
  onStep?: (held: boolean) => void;
  inline?: boolean;
  /** The pull request, placed under the next step. */
  children?: ReactNode;
}) {
  const [overview, setOverview] = useState<BranchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pr, setPr] = useState<PullRequest | null | undefined>(undefined);
  const [me, setMe] = useState<string | null>(null);
  const [reread, setReread] = useState(0);
  const [working, setWorking] = useState<"pull" | "push" | "merge" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const github = useGithubIdentity(cwd)?.remoteHost === "github";
  const session = useSessionStore().sessions.find((s) => s.id === sessionId);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // An agent's turn changes the branch as it works: read again, but not on every event.
    const id = window.setTimeout(() => {
      api
        .branchOverview(cwd, from)
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
  }, [cwd, from, active, version, reread]); // eslint-disable-line react-hooks/exhaustive-deps

  // What others pushed shows only once fetched: on opening, then every five minutes while shown.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const check = () =>
      api
        .branchFetch(cwd)
        .then((fetched) => fetched && !cancelled && setReread((n) => n + 1))
        .catch(() => {});
    void check();
    const id = window.setInterval(check, FETCH_EVERY);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cwd, active]);

  useEffect(() => {
    let cancelled = false;
    api.gitIdentity().then((id) => !cancelled && setMe(id?.email.toLowerCase() ?? null)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const branch = overview?.branch ?? null;
  // Only whether a pull request exists: what it says, and does, is the pull request's own section.
  useEffect(() => {
    if (!active || !branch || overview?.onBase || !overview?.hasRemote) return;
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
  }, [cwd, branch, active, overview?.onBase, overview?.hasRemote, reread]);

  const baseName = overview?.base?.replace(/^origin\//, "") ?? "the base";
  const step = overview ? localStep(overview, pr, baseName) : null;
  // Until the branch is read, nothing below it is the next step either.
  const held = !overview || !!step || overview.onBase || !overview.hasRemote;
  useEffect(() => onStep?.(held), [held, onStep]);

  if (error && !overview) return <p className="p-4 text-xs text-destructive">{error}</p>;
  if (!overview) {
    return (
      <p role="status" className="animate-panel-content flex items-center gap-1.5 p-4 text-xs text-faint">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Reading the branch…
      </p>
    );
  }
  const who = (c: CommitInfo) => (me && c.email.toLowerCase() === me ? "You" : c.author);
  const here = branch ?? "this branch";

  const run = (what: "pull" | "push" | "merge") => {
    setWorking(what);
    setActionError(null);
    setDone(null);
    (what === "pull" ? git.pull(cwd) : what === "push" ? git.push(cwd) : api.branchMergeInto(cwd, baseName))
      .then((said) => {
        if (what === "merge") setDone(said);
        setReread((n) => n + 1);
      })
      .catch((e) => setActionError(errorMessage(e)))
      .finally(() => setWorking(null));
  };
  const ask = (key: string, message: string) => {
    if (!session?.activeTab) return;
    setDraft(session.activeTab, message);
    setAsked(key);
  };
  const askButton = (key: string, message: string, label = "Ask agent") =>
    session?.activeTab && (
      <button type="button" onClick={() => ask(key, message)} title="Write a message asking the agent in this chat" aria-label={`${label}: ${key}`} className={AGENT_BUTTON}>
        <Sparkles className="size-3" aria-hidden />
        {asked === key ? "In your message" : label}
      </button>
    );
  const doButton = (what: "pull" | "push" | "merge", label: string) => (
    <button
      type="button"
      onClick={() => run(what)}
      disabled={!!working}
      className="flex shrink-0 items-center gap-1 h-6 rounded-md bg-accent/15 px-2.5 text-[11px] font-medium text-accent hover:bg-accent/25 disabled:opacity-60"
    >
      {working === what && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {label}
    </button>
  );

  const actions =
    step?.kind === "pull" ? (
      <>
        {doButton("pull", "Pull")}
        {askButton("pull", `Pull the latest commits on ${here} from ${overview.upstream ?? "its upstream"}, and resolve anything that conflicts with my work.`)}
      </>
    ) : step?.kind === "conflicts" ? (
      askButton("conflicts", `Merge the latest ${overview.base ?? baseName} into ${here}, and resolve the conflicts.`, "Resolve")
    ) : step?.kind === "commit" ? (
      <>
        <button type="button" onClick={() => showPanelTab("changes")} className="flex shrink-0 items-center gap-1 h-6 rounded-md bg-accent/15 px-2.5 text-[11px] font-medium text-accent hover:bg-accent/25">
          Review &amp; commit
        </button>
        {askButton("commit", "Commit the changes in this worktree with a clear message.")}
      </>
    ) : step?.kind === "local" ? (
      <>
        {doButton("merge", `Merge into ${baseName}`)}
        {askButton("publish", "Publish this project to GitHub: create a repository for it with `gh repo create`, add it as origin, and push the main branch and this one. Ask me before making it public.", "Publish")}
      </>
    ) : step?.kind === "push" ? (
      doButton("push", "Push")
    ) : null;
  // Back at where it started is "no commits yet"; anywhere else with nothing of its own, its work is in the base.
  const started = session?.worktreeBase?.commit;
  const landed = overview.ahead === 0 && !overview.onBase && !!started && !!overview.forkPoint && !overview.forkPoint.sha.startsWith(started) && !started.startsWith(overview.forkPoint.sha);

  return (
    <div className={cn("animate-panel-content", !inline && "h-full overflow-y-auto scrollbar-thin")} data-testid="branch-panel">
      {/* One left edge for the tab, 24px from the panel: the branch icon, each box's own edge, the graph's dots and every row
          start on it. Only what is inside a box is indented. */}
      <div className="flex flex-col gap-3 px-6 py-4">
        <header className="flex min-h-6 min-w-0 items-center gap-2">
          {/* The glyph's drawing starts 3px into its box: pulled left by that, its ink lines up with the text and dots below. */}
          <GitBranch className="-ml-[3px] size-4 shrink-0 text-accent" aria-hidden />
          <h3 className="truncate font-mono text-[13px] text-foreground" title={branch ?? "Detached HEAD"} data-testid="branch-name">
            {branch ?? "Detached HEAD"}
          </h3>
          {!overview.hasRemote && (
            <span className="ml-auto shrink-0 rounded-full bg-veil-raised px-2.5 py-0.5 text-[10.5px] text-muted-foreground" title="This repository has no remote: nothing is pushed or shared from it" data-testid="branch-local-only">
              This computer only
            </span>
          )}
        </header>

        {done && !step && (
          <p role="status" className="text-xs text-success">
            {done}
          </p>
        )}

        {step && step.kind !== "empty" && (
          <NextLine tone={step.tone} text={step.text} why={step.why} actions={actions}>
            {step.kind === "conflicts" && (
              <ul className="pl-3.5" data-testid="branch-conflicts">
                {overview.merge.conflicted.slice(0, 6).map((path) => (
                  <li key={path} className="truncate font-mono text-[11px] text-muted-foreground" title={path}>
                    {path}
                  </li>
                ))}
                {overview.merge.conflicted.length > 6 && <li className="text-[11px] text-faint">and {overview.merge.conflicted.length - 6} more</li>}
              </ul>
            )}
            {actionError && (
              <p role="alert" className="pl-3.5 text-[11px] text-destructive">
                {actionError}
              </p>
            )}
          </NextLine>
        )}

        {!overview.onBase && overview.hasRemote && children}

        <BranchGraph overview={overview} baseName={baseName} branch={branch} who={who} github={github} landed={landed} />

        {/* The base moving on blocks nothing until it conflicts, which is the step above. */}
        {!overview.onBase && overview.behind > 0 && step?.kind !== "conflicts" && (
          <div className="flex items-center gap-1.5" data-testid="branch-behind">
            <span className="min-w-0 flex-1 text-xs text-faint">
              {baseName} is {count(overview.behind)} ahead
            </span>
            {askButton("base", `Merge the latest ${overview.base ?? baseName} into ${here}, and resolve anything that conflicts with my work.`, `Update from ${baseName}`)}
          </div>
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

const AGENT_BUTTON = "flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-veil-raised hover:text-foreground";

/** Commits of the base drawn on its line; older ones are counted above them. */
const BASE_SHOWN = 12;
const ROW = 30;
/**
 * The base's line, then the branch's, from where the tab's content starts. The base's dots are 10px wide, so
 * at 5 their left edge is that start: in line with the branch icon above and every row's text.
 */
const BASE_X = 5;
const BRANCH_X = 29;

function count(n: number): string {
  return `${n} ${n === 1 ? "commit" : "commits"}`;
}

type GraphRow =
  | { kind: "base" }
  | { kind: "you" }
  | { kind: "commit"; lane: "base" | "branch"; commit: CommitInfo; incoming?: boolean }
  | { kind: "more"; label: string };

/**
 * Oldest first, as the line is read down: where the branch left the base,
 * the branch itself, what others pushed to it since, then what the base
 * gained since. On the base itself: the base, then what is not pulled yet.
 */
export function graphRows(overview: BranchOverview, baseName: string): GraphRow[] {
  const oldestFirst = (commits: CommitInfo[]) => [...commits].reverse();
  if (overview.onBase || !overview.base) {
    return [{ kind: "base" }, ...oldestFirst(overview.incoming ?? []).map((commit): GraphRow => ({ kind: "commit", lane: "base", commit, incoming: true }))];
  }
  const rows: GraphRow[] = [{ kind: "base" }, { kind: "you" }];
  rows.push(...oldestFirst(overview.incoming ?? []).map((commit): GraphRow => ({ kind: "commit", lane: "branch", commit, incoming: true })));
  const shown = overview.baseCommits.slice(0, BASE_SHOWN);
  const earlier = overview.behind - shown.length;
  if (earlier > 0) rows.push({ kind: "more", label: `${earlier} earlier on ${baseName}` });
  rows.push(...oldestFirst(shown).map((commit): GraphRow => ({ kind: "commit", lane: "base", commit })));
  return rows;
}

/**
 * The branch read down from where it left the base: a dot per commit on
 * its line, with its author's face at the end of the row, named on hover.
 */
function BranchGraph({ overview, baseName, branch, who, github, landed }: { overview: BranchOverview; baseName: string; branch: string | null; who: (c: CommitInfo) => string; github: boolean; landed: boolean }) {
  const rows = graphRows(overview, baseName);
  const y = (i: number) => i * ROW + ROW / 2;
  const you = rows.findIndex((r) => r.kind === "you");
  const lastBase = rows.reduce((last, r, i) => (r.kind === "base" || r.kind === "more" || (r.kind === "commit" && r.lane === "base") ? i : last), 0);
  const lastBranch = rows.reduce((last, r, i) => (r.kind === "you" || (r.kind === "commit" && r.lane === "branch") ? i : last), -1);
  // Where the base is now: its newest commit, at the end of its line.
  const newestBase = overview.onBase || !overview.base ? -1 : rows.reduce((last, r, i) => (r.kind === "commit" && r.lane === "base" ? i : last), -1);
  const height = rows.length * ROW;
  const forkY = y(0) + ROW * 0.55;
  const fade = `branch-fade-${useId().replace(/:/g, "")}`;
  return (
    <section aria-label="Commits" data-testid="branch-graph">
      <div className="relative" style={{ height }}>
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={BRANCH_X + 8} height={height} aria-hidden>
          {lastBase > 0 && <line x1={BASE_X} x2={BASE_X} y1={y(0)} y2={y(lastBase)} className="stroke-muted-foreground/60" strokeWidth={1.5} />}
          {you >= 0 && (
            // The branch leaves the base in its grey and arrives at you in the accent.
            <defs>
              <linearGradient id={fade} gradientUnits="userSpaceOnUse" x1={0} y1={y(0)} x2={0} y2={y(you)}>
                <stop offset="0" stopColor="var(--color-muted-foreground)" stopOpacity={0.6} />
                <stop offset="1" stopColor="var(--color-accent)" />
              </linearGradient>
            </defs>
          )}
          {you >= 0 && (
            <path
              d={`M ${BASE_X} ${y(0)} L ${BASE_X} ${forkY - 6} Q ${BASE_X} ${forkY} ${BASE_X + 6} ${forkY} L ${BRANCH_X - 6} ${forkY} Q ${BRANCH_X} ${forkY} ${BRANCH_X} ${forkY + 6} L ${BRANCH_X} ${y(Math.max(you, lastBranch))}`}
              fill="none"
              stroke={`url(#${fade})`}
              strokeWidth={1.5}
            />
          )}
        </svg>
        <ol className="relative">
          {rows.map((row, i) => {
            const x = row.kind === "you" || (row.kind === "commit" && row.lane === "branch") ? BRANCH_X : BASE_X;
            const testId = row.kind === "commit" ? "branch-commit" : row.kind === "base" ? "branch-fork" : row.kind === "you" ? "branch-you" : undefined;
            return (
              <li
                key={row.kind === "commit" ? row.commit.sha : row.kind}
                className="flex items-center gap-2"
                style={{ height: ROW, paddingLeft: x + 12 }}
                data-testid={testId}
                data-lane={row.kind === "commit" ? row.lane : undefined}
              >
                <span
                  className={cn(
                    "absolute -translate-x-1/2 -translate-y-1/2 rounded-full",
                    row.kind === "more" ? "size-1.5 bg-muted-foreground/60" : "size-2.5",
                    row.kind === "you" || (row.kind === "commit" && row.lane === "branch") ? "bg-accent" : row.kind !== "more" && "bg-muted-foreground",
                    row.kind === "commit" && row.incoming && "ring-2 ring-accent/30",
                  )}
                  style={{ left: x, top: y(i) }}
                  aria-hidden
                />
                {row.kind === "base" ? (
                  <span className="min-w-0 truncate text-xs text-foreground">
                    {overview.onBase || !overview.base ? branch ?? baseName : `Branched from ${baseName}`}
                    {overview.forkPoint && !overview.onBase && overview.base && (
                      <span className="text-faint">
                        {" "}
                        · {since(overview.forkPoint.date)} · <span className="font-mono">{overview.forkPoint.shortSha}</span>
                      </span>
                    )}
                  </span>
                ) : row.kind === "you" ? (
                  <span className="min-w-0 truncate text-xs text-foreground">
                    You
                    <span className="text-faint">
                      {" "}
                      · {overview.ahead ? count(overview.ahead) : landed ? `all in ${baseName}` : "no commits yet"}
                    </span>
                  </span>
                ) : row.kind === "more" ? (
                  <span className="text-[11px] text-faint">{row.label}</span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-xs" title={`${row.commit.subject}\n${row.commit.author} · ${relativeTime(row.commit.date)}`}>
                      <span className="font-mono text-foreground">#{row.commit.shortSha}</span>
                      <span className="text-faint"> {row.commit.subject}</span>
                    </span>
                    {i === newestBase && (
                      <span className="shrink-0 rounded bg-veil-raised px-1 text-[10px] text-muted-foreground" data-testid="branch-base-now">
                        {baseName} now
                      </span>
                    )}
                    <Face name={row.commit.author} label={who(row.commit) === "You" ? `You · ${row.commit.author}` : row.commit.author} email={row.commit.email} github={github} />
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

const HUES = [210, 150, 30, 280, 340, 190, 90, 0];

/**
 * A GitHub address (`123+login@users.noreply.github.com`) names its account
 * outright; on a GitHub project any other address is looked up there too.
 * Anything else, or a picture that will not load, is the author's initials.
 */
export function avatarUrl(email: string, github: boolean): string | null {
  const noreply = email.match(/^(\d+)\+[^@]+@users\.noreply\.github\.com$/i);
  if (noreply) return `https://avatars.githubusercontent.com/u/${noreply[1]}?s=48`;
  return github && email.includes("@") ? `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=48` : null;
}

function Face({ name, label = name, email, github, size = 20 }: { name: string; label?: string; email: string; github: boolean; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : avatarUrl(email, github);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  const hue = HUES[[...email.toLowerCase()].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % HUES.length];
  return (
    <WithTooltip label={label} side="left">
      <span
        className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-full text-[8.5px] font-semibold text-white")}
        style={{ width: size, height: size, background: `hsl(${hue} 45% 45%)` }}
        role="img"
        aria-label={label}
      >
        {url ? <img src={url} alt="" className="size-full object-cover" onError={() => setFailed(true)} /> : initials}
      </span>
    </WithTooltip>
  );
}
