import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover, Tabs } from "radix-ui";
import { ChevronDown, Circle, CircleCheck, CircleDashed, CircleDot, CircleX, GitBranch, GitBranchPlus, Github, GitPullRequest, GitPullRequestArrow, LogoLinear, Search } from "@/icons";
import { Button } from "@/components/ui/button";
import { PrStateIcon } from "@/components/chat/PrStateIcon";
import { Avatar } from "@/components/issues/People";
import { api, errorMessage, issues, type Issue, type PullRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/cloudPeople";
import { prChecksLine, prRowState } from "@/lib/prRow";
import { prErrorKind } from "@/lib/prErrors";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { refreshWorkspaces, useSessionStore } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import { usePrSearch } from "@/lib/usePrSearch";
import type { BranchInfo } from "@/types/session";
import { ConnectLinear } from "./ConnectLinear";

export type BranchTarget = { kind: "new" } | { kind: "open"; cwd: string } | { kind: "existing"; branch: string };

export type StartFromTab = "prs" | "branches" | "issues";
/** `label` is the row's accessible name: everything it shows, in reading order. */
type Row = { id: string; label: string; pick: () => void; body: ReactNode };

const TABS = [
  ["prs", "Pull requests", GitPullRequest],
  ["branches", "Branches", GitBranch],
  ["issues", "Issues", CircleDot],
] as const;
const PLACEHOLDER: Record<StartFromTab, string> = {
  prs: "Search by title, number or author",
  branches: "Search branches",
  issues: "Search by issue key, title or description",
};
const LIST_NAME: Record<StartFromTab, string> = { prs: "Pull requests", branches: "Branches", issues: "Issues" };

/** "updated 2h ago" from a commit time; a date once it is a week old; nothing when the time is unknown. */
export function updatedLine(iso: string | undefined, now = Date.now()): string | null {
  const age = iso ? relativeTime(iso, now) : "";
  if (!age) return null;
  return age === "now" ? "updated just now" : /^\d+[mhd]$/.test(age) ? `updated ${age} ago` : `updated ${age}`;
}

/** Who last committed and how long ago, as the right of a branch row says it: "AK · 3d". */
export function branchByline(branch: Pick<BranchInfo, "updated" | "author">, now = Date.now()): string {
  return [branch.author ? initials(branch.author) : "", branch.updated ? relativeTime(branch.updated, now) : ""].filter(Boolean).join(" · ");
}

const IN_USE = "shrink-0 whitespace-nowrap rounded bg-warning/15 px-1.5 text-[11px] leading-5 text-warning";
const SECOND_LINE = "truncate text-[11px] leading-4 text-faint";

function Initials({ name }: { name: string }) {
  return (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[9px] font-semibold text-accent">
      {initials(name)}
    </span>
  );
}

function IssueStateIcon({ issue }: { issue: Issue }) {
  const [Icon, tone] =
    issue.stateType === "started"
      ? [CircleDot, "text-warning"]
      : issue.stateType === "completed"
        ? [CircleCheck, "text-add"]
        : issue.stateType === "canceled"
          ? [CircleX, "text-faint"]
          : issue.workflowStateType === "backlog" || issue.workflowStateType === "triage"
            ? [CircleDashed, "text-faint"]
            : [Circle, "text-muted-foreground"];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", tone)} />;
}

/** An empty or failed list, said as a card: what it is, why, and what to do about it. */
function StateCard({ role, icon, title, text, action }: { role: "status" | "alert"; icon: ReactNode; title: string; text: string; action?: { label: string; run: () => void } }) {
  return (
    <div role={role} className="m-2 grid justify-items-center gap-0.5 rounded-lg border border-hairline px-4 py-4 text-center" data-testid="start-from-state">
      <span className="text-faint [&_svg]:size-[18px]">{icon}</span>
      <p className="mt-1 text-[12.5px] font-medium text-foreground">{title}</p>
      <p className="max-w-[44ch] break-words text-[11.5px] leading-relaxed text-muted-foreground">{text}</p>
      {action && (
        <Button size="sm" variant="outline" className="mt-2" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/**
 * One search field across pull requests, branches and issues. Arrows + Enter
 * choose, Tab goes to the next list. The trigger is the header's "Start from"
 * chip; once something is picked the caller shows it as `picked` instead, and
 * the list still opens under it.
 */
export function StartFromPicker({
  projectPath,
  defaultBranch,
  picked,
  open,
  onOpenChange,
  initialTab = "prs",
  onBranch,
  onIssue,
  onPr,
  onSession,
  disabled,
}: {
  projectPath: string;
  defaultBranch: string;
  /** What was picked, drawn where the trigger would be. */
  picked?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The list it opens on. */
  initialTab?: StartFromTab;
  onBranch: (target: BranchTarget) => void;
  onIssue: (issue: Issue) => void;
  onPr: (pr: PullRequest) => void;
  onSession: (id: string) => void;
  disabled: boolean;
}) {
  const store = useSessionStore();
  const prefs = usePrefs();
  const [tab, setTab] = useState<StartFromTab>(initialTab);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<"github" | "linear">(prefs.issueProvider ?? "github");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [issueResult, setIssueResult] = useState<{ key: string; items: Issue[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linearConnected, setLinearConnected] = useState<boolean | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** Bumped by "Try again": reads the open list once more. */
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const prs = usePrSearch(open && tab === "prs" ? projectPath : null, query, attempt);
  const searchQuery = tab === "branches" ? "" : query;
  const issueKey = JSON.stringify([projectPath, provider, searchQuery]);
  const needsLinear = provider === "linear" && linearConnected === false;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setQuery("");
    setTab(initialTab);
    void refreshWorkspaces(projectPath).catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, projectPath, initialTab]);
  useEffect(() => {
    setHighlight(0);
  }, [query, tab, projectPath, provider]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  useEffect(() => {
    if (!open || tab !== "issues" || provider !== "linear") return;
    let live = true;
    issues
      .linearStatus()
      .then((status) => live && setLinearConnected(status.connected))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, tab, provider]);
  useEffect(() => {
    if (!open || tab === "prs" || (tab === "issues" && needsLinear)) return;
    let live = true;
    setError(null);
    setLoading(true);
    setBranches([]);
    setIssueResult(null);
    const timer = window.setTimeout(
      () => {
        const request =
          tab === "branches"
            ? api.listBranches(projectPath).then((items) => {
                if (live) setBranches(items);
              })
            : issues.list(projectPath, provider, { search: searchQuery }).then((items) => {
                if (live) setIssueResult({ key: issueKey, items });
              });
        request.catch((e) => live && setError(errorMessage(e))).finally(() => live && setLoading(false));
      },
      tab === "issues" && searchQuery ? 200 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, tab, projectPath, provider, searchQuery, needsLinear, issueKey, attempt]);

  const rows = useMemo<Row[]>(() => {
    const workspaces = store.workspaces[projectPath] ?? [];
    /** The newest session open on a checkout. */
    const sessionAt = (cwd: string) =>
      (store.sessions ?? [])
        .filter((s) => s.projectPath === projectPath && s.cwd === cwd && !s.archived && !s.worktreeRemoved)
        .sort((a, b) => b.modified.localeCompare(a.modified))[0];

    if (tab === "prs")
      return prs.items.map((pr) => {
        const state = prRowState(pr);
        // A head on a fork is another repository's branch, whatever its name.
        const checkout = pr.headRepository ? undefined : workspaces.find((ws) => !!ws.branch && ws.branch === pr.head);
        const session = checkout && sessionAt(checkout.path);
        const badge = checkout ? (session ? "In use · Open session" : "In use · Use checkout") : pr.state === "OPEN" ? (pr.isDraft ? "Draft" : "Open") : pr.state === "MERGED" ? "Merged" : "Closed";
        const second = [pr.head, prChecksLine(pr)].filter(Boolean).join(" · ");
        return {
          id: String(pr.number),
          label: [`#${pr.number} ${pr.title}`, pr.headRepository && `from ${pr.headRepository}`, second, [pr.author, badge].filter(Boolean).join(" · ")].filter(Boolean).join(" "),
          pick: () => (session ? onSession(session.id) : checkout ? onBranch({ kind: "open", cwd: checkout.path }) : onPr(pr)),
          body: (
            <>
              <PrStateIcon state={state} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-mono text-xs text-faint">#{pr.number}</span>
                  <span className="min-w-0 truncate">{pr.title}</span>
                  {pr.headRepository && <span className="shrink-0 whitespace-nowrap rounded bg-veil-strong px-1.5 text-[10.5px] leading-4 text-muted-foreground">from {pr.headRepository}</span>}
                </span>
                {second && <span className={cn(SECOND_LINE, "block font-mono")}>{second}</span>}
              </span>
              {checkout ? <span className={IN_USE}>{badge}</span> : <span className={cn("shrink-0 text-[11.5px]", pr.state === "OPEN" && !pr.isDraft ? "text-info" : "text-faint")}>{badge}</span>}
              {pr.author && <Initials name={pr.author} />}
            </>
          ),
        };
      });

    if (tab === "issues")
      return needsLinear || issueResult?.key !== issueKey
        ? []
        : issueResult.items.map((issue) => ({
            id: issue.id,
            label: [`${issue.identifier} ${issue.title}`, issue.state].filter(Boolean).join(" "),
            pick: () => onIssue(issue),
            body: (
              <>
                <IssueStateIcon issue={issue} />
                <span className="min-w-[3.5rem] shrink-0 font-mono text-[11.5px] text-faint">{issue.identifier}</span>
                <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                {issue.state && <span className="max-w-32 shrink-0 truncate text-[11px] text-faint">{issue.state}</span>}
                {issue.assignee && <Avatar person={issue.assignee} />}
              </>
            ),
          }));

    const q = query.trim().toLowerCase();
    const taken = new Set(workspaces.flatMap((ws) => (ws.branch ? [ws.branch] : [])));
    const seen = new Set<string>();
    const branchRow = (name: string, second: string | null, right: ReactNode) => (
      <>
        <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{name}</span>
          {second && <span className={cn(SECOND_LINE, "block")}>{second}</span>}
        </span>
        {right}
      </>
    );
    const result: Row[] =
      !q || "new branch".includes(q)
        ? [
            {
              id: "new",
              label: `New branch from ${defaultBranch}`,
              pick: () => onBranch({ kind: "new" }),
              body: (
                <>
                  <GitBranchPlus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">New branch</span>
                    <span className={cn(SECOND_LINE, "block")}>
                      from <span className="font-mono">{defaultBranch}</span>
                    </span>
                  </span>
                </>
              ),
            },
          ]
        : [];
    for (const ws of workspaces) {
      if (!ws.branch || !`${ws.branch} ${ws.name}`.toLowerCase().includes(q)) continue;
      const session = sessionAt(ws.path);
      const badge = session ? "In use · Open session" : "In use · Use checkout";
      result.push({
        id: ws.path,
        label: `${ws.branch} ${badge}`,
        pick: () => (session ? onSession(session.id) : onBranch({ kind: "open", cwd: ws.path })),
        body: branchRow(ws.branch, session?.title ? `In use by “${session.title}”` : `Checked out in ${ws.name}`, <span className={IN_USE}>{badge}</span>),
      });
    }
    for (const branch of [...branches].sort((a, b) => Number(a.remote) - Number(b.remote))) {
      const local = branch.remote ? branch.name.split("/").slice(1).join("/") : branch.name;
      if (!local || taken.has(local) || seen.has(local)) continue;
      seen.add(local);
      if (!branch.name.toLowerCase().includes(q)) continue;
      const updated = updatedLine(branch.updated);
      const byline = branchByline(branch);
      result.push({
        id: branch.name,
        label: `${branch.name} ${branch.remote ? "Remote · " : ""}New worktree`,
        pick: () => onBranch({ kind: "existing", branch: branch.name }),
        body: branchRow(
          branch.name,
          local === defaultBranch ? ["default branch", updated].filter(Boolean).join(" · ") : null,
          byline ? <span className="shrink-0 whitespace-nowrap text-[11px] text-faint">{byline}</span> : null,
        ),
      });
    }
    return result.slice(0, 100);
  }, [
    tab,
    prs.items,
    needsLinear,
    issueResult,
    issueKey,
    query,
    store.workspaces,
    store.sessions,
    projectPath,
    branches,
    defaultBranch,
    onBranch,
    onIssue,
    onPr,
    onSession,
  ]);
  const active = Math.min(highlight, Math.max(0, rows.length - 1));
  const choose = (row: Row) => {
    row.pick();
    onOpenChange(false);
  };
  const chooseProvider = (next: "github" | "linear") => {
    setProvider(next);
    setPrefs({ issueProvider: next });
    setTab("issues");
    input.current?.focus();
  };
  const waiting = tab === "prs" ? prs.loading : loading;
  const failure = tab === "prs" ? prs.error : error;
  const asked = query.trim();
  const retry = { label: "Try again", run: () => setAttempt((n) => n + 1) };
  const tracker = provider === "linear" ? "Linear" : "GitHub";
  const state = waiting ? null : failure ? (
    tab === "prs" ? (
      prErrorKind(failure) === "access" ? (
        <StateCard role="alert" icon={<Github />} title="GitHub isn’t connected" text={`Sign in with the GitHub CLI (gh auth login), then try again. ${failure}`} action={retry} />
      ) : (
        <StateCard role="alert" icon={<GitPullRequest />} title="Pull requests couldn’t load" text={failure} action={retry} />
      )
    ) : tab === "issues" ? (
      provider === "linear" ? (
        <StateCard role="alert" icon={<LogoLinear />} title="Linear couldn’t load" text={failure} action={{ label: "Set up Linear", run: () => setLinearConnected(false) }} />
      ) : (
        <StateCard role="alert" icon={<Github />} title="GitHub issues couldn’t load" text={failure} action={retry} />
      )
    ) : (
      <StateCard role="alert" icon={<GitBranch />} title="Branches couldn’t load" text={failure} action={retry} />
    )
  ) : rows.length ? null : tab === "prs" ? (
    <StateCard role="status" icon={<GitPullRequest />} title="No pull requests found" text={asked ? `Nothing open in this repository matches “${asked}”.` : "This repository has no open pull requests."} />
  ) : tab === "issues" ? (
    <StateCard role="status" icon={<CircleDot />} title="No issues found" text={asked ? `Nothing open in ${tracker} matches “${asked}”.` : `${tracker} has no open issues for this project.`} />
  ) : (
    <StateCard role="status" icon={<GitBranch />} title="No branches found" text={`No branch matches “${asked}”.`} />
  );

  return (
    <Popover.Root modal open={open} onOpenChange={onOpenChange}>
      {picked ? (
        <Popover.Anchor asChild>{picked}</Popover.Anchor>
      ) : (
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Start from"
            title="Start from a pull request, a branch or an issue"
            className={cn("flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-veil-raised hover:text-foreground disabled:opacity-50", open && "bg-veil-raised text-foreground")}
          >
            <GitPullRequestArrow className="size-[13px]" aria-hidden />
            Start from
            <ChevronDown className="size-3 text-faint" aria-hidden />
          </button>
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          data-testid="start-from-popover"
          className="z-(--z-menu) w-[540px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-surface hairline"
        >
          <Tabs.Root value={tab} onValueChange={(value) => setTab(value as StartFromTab)}>
            <div className="flex h-10 items-center gap-1 border-b border-hairline px-2">
              <Tabs.List aria-label="Start from source" className="flex min-w-0 gap-1">
                {TABS.map(([value, title, Icon]) => (
                  <Tabs.Trigger
                    key={value}
                    value={value}
                    className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12.5px] text-muted-foreground data-[state=active]:bg-veil-strong data-[state=active]:text-foreground"
                  >
                    <Icon className="size-[13px]" aria-hidden />
                    {title}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              {/* Where issues come from. Choosing one shows its issues. */}
              <div role="group" aria-label="Issue tracker" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-well p-0.5 text-[11.5px]">
                {(
                  [
                    ["linear", "Linear", LogoLinear],
                    ["github", "GitHub", Github],
                  ] as const
                ).map(([value, title, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={provider === value}
                    onClick={() => chooseProvider(value)}
                    className={cn("flex h-6 items-center gap-1 rounded px-2 text-muted-foreground", provider === value && "bg-veil-strong text-foreground")}
                  >
                    <Icon className="size-[11px]" aria-hidden />
                    {title}
                  </button>
                ))}
              </div>
            </div>
            <Tabs.Content value={tab} tabIndex={-1}>
              <div className="flex h-9 items-center gap-2 border-b border-hairline px-3">
                <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
                <input
                  ref={input}
                  role="combobox"
                  aria-label="Search branches, issues or pull requests"
                  aria-autocomplete="list"
                  aria-expanded
                  aria-controls={`${id}-list`}
                  aria-activedescendant={rows.length ? `${id}-${active}` : undefined}
                  value={query}
                  placeholder={PLACEHOLDER[tab]}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      setHighlight(rows.length ? (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : 0);
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (rows[active]) choose(rows[active]);
                    }
                    // Tab goes to the next list; Shift+Tab still walks back to the tabs and the tracker.
                    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                      e.preventDefault();
                      setTab(TABS[(TABS.findIndex(([value]) => value === tab) + 1) % TABS.length][0]);
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
                />
              </div>
              {tab === "issues" && needsLinear ? (
                <ConnectLinear onConnected={() => setLinearConnected(true)} />
              ) : (
                <>
                  <div ref={list} id={`${id}-list`} role="listbox" aria-label={LIST_NAME[tab]} className={cn("max-h-[min(22rem,50dvh)] overflow-y-auto scrollbar-thin", rows.length > 0 && "p-1")}>
                    {rows.map((row, index) => (
                      <button
                        key={row.id}
                        id={`${id}-${index}`}
                        type="button"
                        role="option"
                        aria-label={row.label}
                        aria-selected={index === active}
                        onMouseMove={() => setHighlight(index)}
                        onClick={() => choose(row)}
                        className={cn("flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-[13px] focus-visible:outline-ring", index === active && "bg-veil-strong")}
                      >
                        {row.body}
                      </button>
                    ))}
                  </div>
                  {waiting && (
                    <p role="status" className="px-3 py-3 text-xs text-faint">
                      Loading…
                    </p>
                  )}
                  {state}
                </>
              )}
            </Tabs.Content>
          </Tabs.Root>
          <div className="flex h-8 items-center gap-3 border-t border-hairline px-3 text-[11px] text-faint" data-testid="start-from-keys">
            <span>↑↓ move</span>
            <span>↵ select</span>
            <span>Tab next list</span>
            <span className="ml-auto">esc close</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
