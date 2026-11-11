import { useEffect, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Loader2, Plus, RefreshCw, SquarePen } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { ProjectGlyph } from "@/components/layout/ProjectRail";
import { api, errorMessage, type ProjectOverview as Overview } from "@/lib/api";
import { cn } from "@/lib/cn";
import { githubAvatarUrl, useGithubIdentity } from "@/lib/githubIdentity";
import { startChat, startSessionIn, useSessionStore } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import { ProjectLeftovers } from "./ProjectLeftovers";

/** One accent per contributor's strip, in order. */
const STRIP = ["bg-warning", "bg-info", "bg-add", "bg-accent", "bg-destructive", "bg-muted-foreground"];

/**
 * A project at a glance, opened from its name in the sidebar: what lately
 * happened in it (commits, pull requests), who did it, its branches, and the
 * two ways to start work there.
 */
export function ProjectOverview({ path }: { path: string }) {
  const store = useSessionStore();
  const project = store.projects.find((entry) => entry.path === path) ?? null;
  const identity = useGithubIdentity(project?.kind === "folder" ? null : path);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.projectOverview(path).then(
      (next) => live && setOverview(next),
      (cause) => live && setError(errorMessage(cause)),
    ).finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, reloads]);

  const name = project?.name ?? path.split("/").pop() ?? path;
  const checkouts = store.workspaces[path] ?? [];
  const startOn = (branch: string) => {
    const checkout = checkouts.find((workspace) => workspace.branch === branch);
    void startChat(checkout ? { projectPath: path, cwd: checkout.path } : { projectPath: path, fromBranch: branch }).catch((cause) => setError(errorMessage(cause)));
  };
  const prs = overview?.pullRequests ?? null;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-chat scrollbar-thin" data-testid="project-overview">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-8 pb-16 pt-12">
        <header className="flex items-start gap-4">
          {project ? <ProjectGlyph project={project} size={36} /> : null}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[26px] font-semibold leading-tight tracking-tight text-foreground">{name}</h1>
            <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] text-faint">
              {identity?.repo ? (
                <button type="button" onClick={() => void openUrl(`https://github.com/${identity.repo}`)} className="truncate hover:text-foreground">
                  github.com/{identity.repo}
                </button>
              ) : (
                <span className="min-w-0 truncate font-mono" title={path}>{path.replace(/^\/Users\/[^/]+/, "~")}</span>
              )}
              {overview?.defaultBranch ? (
                <>
                  <span aria-hidden className="shrink-0">·</span>
                  <span className="flex shrink-0 items-center gap-1 font-mono">
                    <GitBranch className="size-3" />
                    {overview.defaultBranch}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <WithTooltip label="Reveal in Finder">
              <Button variant="ghost" size="icon-sm" aria-label="Reveal in Finder" onClick={() => void revealItemInDir(path)}>
                <FolderOpen />
              </Button>
            </WithTooltip>
            <WithTooltip label="Read again">
              <Button variant="ghost" size="icon-sm" aria-label="Refresh overview" disabled={loading} onClick={() => setReloads((n) => n + 1)}>
                <RefreshCw className={cn(loading && "animate-spin")} />
              </Button>
            </WithTooltip>
            {project?.kind !== "folder" ? (
              <Button variant="secondary" size="sm" onClick={() => startSessionIn(path, null)} title="A new chat on a branch of its own, in a new worktree">
                <GitBranch /> New branch
              </Button>
            ) : null}
            <Button variant="accent" size="sm" onClick={() => startSessionIn(path, path)} title="A new chat in the project's own folder">
              <SquarePen /> New chat
            </Button>
          </div>
        </header>

        {error ? <div role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div> : null}

        <section aria-label="At a glance" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat value={overview?.recentCommits} label="Commits" hint="On the default branch, last 30 days" icon={GitCommitHorizontal} loading={loading} />
          <Stat value={prs?.open} label="Open PRs" icon={GitPullRequest} loading={loading} />
          <Stat value={prs?.merged} label="Merged PRs" hint="Last 30 days" icon={GitMerge} loading={loading} />
          <Stat value={overview?.branches.length} label="Branches" hint="Local branches" icon={GitBranch} loading={loading} />
        </section>

        {/* What earlier sessions left behind, when there is something safe to remove. */}
        <ProjectLeftovers path={path} />

        <Section title="Top contributors" note="Last 30 days">
          {overview?.contributors.length ? (
            <ul className="flex flex-col">
              {overview.contributors.map((person, index) => (
                <li key={person.email} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-5 py-2">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar login={person.login} name={person.name} />
                    <span className="truncate text-[13px] text-foreground" title={person.email}>{person.name}</span>
                  </span>
                  <ActivityStrip days={person.days} tone={STRIP[index % STRIP.length]} />
                  <span className="text-right text-[12px] tabular-nums text-muted-foreground">
                    {person.commits} {person.commits === 1 ? "commit" : "commits"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty loading={loading}>No commits in the last 30 days.</Empty>
          )}
        </Section>

        <Section title="Pull requests" note={prs ? "Open and recently merged" : undefined}>
          {prs?.recent.length ? (
            <ul className="flex flex-col gap-1">
              {prs.recent.map((pr) => (
                <li key={pr.number}>
                  <button type="button" onClick={() => void openUrl(pr.url)} className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-veil-raised">
                    <Avatar login={pr.author} name={pr.author} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">
                        <span className="text-faint">#{pr.number}</span> {pr.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[11.5px] text-faint">
                        {pr.state === "MERGED" ? "Merged" : pr.isDraft ? "Draft" : "Opened"} by {pr.author} · {relativeTime(pr.at)}
                      </span>
                    </span>
                    <PrState state={pr.state} draft={pr.isDraft} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty loading={loading}>{overview?.pullRequestNote ?? "No open or recently merged pull requests."}</Empty>
          )}
        </Section>

        <Section title="Branches" note="Most recent first">
          {overview?.branches.length ? (
            <ul className="flex flex-col">
              {overview.branches.map((branch) => (
                <li key={branch.name} className="group/branch -mx-2 flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-veil-raised">
                  <GitBranch className="size-3.5 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] text-foreground">{branch.name}</span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-faint">
                      {branch.subject} · {branch.author} · {relativeTime(branch.committedAt)}
                    </span>
                  </span>
                  {branch.name !== overview.defaultBranch && (branch.ahead || branch.behind) ? (
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint" title={`${branch.ahead} ahead of, ${branch.behind} behind ${overview.defaultBranch ?? "the default branch"}`}>
                      ↑{branch.ahead} ↓{branch.behind}
                    </span>
                  ) : null}
                  <WithTooltip label={`New chat on ${branch.name}`}>
                    <Button variant="ghost" size="icon-xs" aria-label={`New chat on ${branch.name}`} className="opacity-0 group-hover/branch:opacity-100 focus-visible:opacity-100" onClick={() => startOn(branch.name)}>
                      <Plus />
                    </Button>
                  </WithTooltip>
                </li>
              ))}
            </ul>
          ) : (
            <Empty loading={loading}>No branches yet.</Empty>
          )}
        </Section>

        <Section title="Latest" note={overview?.defaultBranch ? `On ${overview.defaultBranch}` : undefined}>
          {overview?.latest.length ? (
            <ul className="flex flex-col">
              {overview.latest.map((commit) => (
                <li key={commit.sha} className="flex items-center gap-3 py-1.5">
                  <span className="w-16 shrink-0 font-mono text-[11.5px] text-faint">{commit.sha}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{commit.subject}</span>
                  <span className="shrink-0 text-[11.5px] text-faint">
                    {commit.author} · {relativeTime(commit.at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty loading={loading}>No commits on the default branch yet.</Empty>
          )}
        </Section>
      </div>
    </div>
  );
}

function Stat({ value, label, hint, icon: Icon, loading }: { value: number | undefined; label: string; hint?: string; icon: typeof GitBranch; loading: boolean }) {
  return (
    <div className="flex flex-col gap-5 rounded-xl bg-well/50 p-4 ring-1 ring-inset ring-hairline" title={hint}>
      <span className="text-[24px] font-semibold leading-none tabular-nums text-foreground">
        {value ?? (loading ? <Loader2 className="size-4 animate-spin text-faint" /> : "—")}
      </span>
      <span className="flex flex-col gap-1.5 text-[12px] text-muted-foreground">
        <Icon className="size-3.5 text-faint" />
        {label}
      </span>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="mb-3 flex items-baseline gap-2 border-b border-hairline pb-2">
        <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
        {note ? <span className="text-[11.5px] text-faint">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  return <div className="py-3 text-[12.5px] text-faint">{loading ? "Reading…" : children}</div>;
}

/** Their GitHub picture when their login is known, else their initials. */
function Avatar({ login, name }: { login: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (login && !failed) {
    return <img src={githubAvatarUrl(login, 28)} alt="" onError={() => setFailed(true)} className="size-7 shrink-0 rounded-full bg-well ring-1 ring-hairline" />;
  }
  const initials = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";
  return <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-veil-strong text-[10.5px] font-medium text-muted-foreground">{initials}</span>;
}

/** Commits a day over two weeks, today at the right: a dot a day, brighter for more. */
function ActivityStrip({ days, tone }: { days: number[]; tone: string }) {
  const most = Math.max(1, ...days);
  return (
    <span className="flex items-center justify-between gap-1" aria-label={`${days.reduce((a, b) => a + b, 0)} commits in the last two weeks`}>
      {days.map((count, index) => (
        <span
          key={index}
          className={cn("size-1.5 shrink-0 rounded-[2px]", count ? tone : "bg-hairline-strong")}
          style={count ? { opacity: 0.45 + 0.55 * (count / most) } : undefined}
          title={count ? `${count} ${count === 1 ? "commit" : "commits"}, ${days.length - 1 - index === 0 ? "today" : `${days.length - 1 - index}d ago`}` : undefined}
        />
      ))}
    </span>
  );
}

function PrState({ state, draft }: { state: string; draft: boolean }) {
  const label = state === "MERGED" ? "Merged" : state === "CLOSED" ? "Closed" : draft ? "Draft" : "Open";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
        state === "MERGED" ? "text-accent ring-accent/30" : state === "CLOSED" ? "text-faint ring-hairline-strong" : draft ? "text-muted-foreground ring-hairline-strong" : "text-add ring-add/30",
      )}
    >
      {label}
    </span>
  );
}
