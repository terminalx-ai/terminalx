import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, CircleDot, ExternalLink, FolderGit2, GitBranch, Loader2, RefreshCw, Search, Settings2, UserRound } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Segmented, Switch } from "@/components/ui/controls";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { Markdown } from "@/components/chat/Markdown";
import { api, errorMessage, gh, issues as issuesApi, type Issue, type IssueTeam, type LinearStatus } from "@/lib/api";
import { selectProject, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { PERMISSION_MODES } from "@/lib/models";
import { chooseMode } from "@/lib/dialogs";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { WorkStatus } from "@/types/session";

type Provider = "github" | "linear";

/** The worktree name a session gets from an issue: `eng-42-fix-login-timeout`. */
export function issueWorktreeName(identifier: string, title: string): string {
  return `${identifier} ${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** The first prompt of a session started from an issue. */
export function issuePrompt(issue: Issue): string {
  const body = issue.body?.trim() ? `\n\n${issue.body.trim()}` : "";
  const provider = issue.provider === "github" ? "GitHub" : "Linear";
  return `Work on ${provider} issue ${issue.identifier}: ${issue.title}${body}\n\nIssue link: ${issue.url}\nWhen done, summarise what changed.`;
}

/**
 * Issues from the project's tracker, and a way to start a session on one.
 * The list is the tracker's own order (most recently updated first); the
 * detail column shows the body so the reader can judge before an agent
 * spends a worktree on it.
 */
export function IssuesView({
  onCreated,
  useWorktree: controlledUseWorktree,
  onUseWorktreeChange,
  onTargetProjectChange,
}: {
  onCreated?: (sessionId: string, tabId: string, firstPrompt: string) => void;
  useWorktree?: boolean;
  onUseWorktreeChange?: (value: boolean) => void;
  onTargetProjectChange?: (projectPath: string | null) => void;
}) {
  const store = useSessionStore();
  const prefs = usePrefs();
  const [provider, setProvider] = useState<Provider>(prefs.issueProvider);
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teams, setTeams] = useState<IssueTeam[]>([]);
  const [search, setSearch] = useState("");
  const [list, setList] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Issue | null>(null);
  const [detail, setDetail] = useState<Issue | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [linear, setLinear] = useState<LinearStatus | null>(null);
  const [ghOk, setGhOk] = useState<boolean | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [localUseWorktree, setLocalUseWorktree] = useState(prefs.useWorktree);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [tick, setTick] = useState(0);
  const useWorktree = controlledUseWorktree ?? localUseWorktree;
  const setUseWorktree = onUseWorktreeChange ?? setLocalUseWorktree;

  const project = store.projects.find((p) => p.path === prefs.lastProject) ?? store.projects[0] ?? null;
  const harness = store.harnesses.find((h) => h.id === prefs.lastAgent) ?? store.harnesses[0] ?? null;

  useEffect(() => {
    onTargetProjectChange?.(selected && project ? project.path : null);
  }, [onTargetProjectChange, project?.path, selected?.provider, selected?.id]);
  useEffect(() => () => onTargetProjectChange?.(null), [onTargetProjectChange]);

  useEffect(() => {
    setPrefs({ issueProvider: provider });
  }, [provider]);

  // Who is connected, and to what.
  useEffect(() => {
    let live = true;
    issuesApi.linearStatus().then((s) => live && setLinear(s)).catch(() => {});
    gh.available().then((ok) => live && setGhOk(ok)).catch(() => live && setGhOk(false));
    return () => {
      live = false;
    };
  }, [tick]);
  useEffect(() => {
    let live = true;
    if (!project) return setRepo(null);
    issuesApi.githubRepo(project.path).then((r) => live && setRepo(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, [project]);
  useEffect(() => {
    let live = true;
    if (!project) return setStatus(null);
    setStatus(null);
    api.workStatus(project.path).then((s) => live && setStatus(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, [project]);
  useEffect(() => {
    if (provider !== "linear" || !linear?.connected) return;
    let live = true;
    issuesApi.linearTeams().then((t) => live && setTeams(t)).catch(() => {});
    return () => {
      live = false;
    };
  }, [provider, linear?.connected]);

  // The list itself. Search is debounced because GitHub runs it server-side.
  useEffect(() => {
    if (!project) return;
    if (provider === "linear" && !linear?.connected) {
      setList([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await issuesApi.list(project.path, provider, { assignedToMe, teamId, search });
        if (live) setList(r);
      } catch (e) {
        if (live) {
          setList([]);
          setError(errorMessage(e));
        }
      } finally {
        if (live) setLoading(false);
      }
    }, provider === "github" ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [project, provider, assignedToMe, teamId, search, linear?.connected, tick]);

  // Body on demand: GitHub lists come without it.
  useEffect(() => {
    setDetail(null);
    if (!selected || !project) return;
    if (selected.body != null && selected.provider === "linear") {
      setDetail(selected);
      return;
    }
    let live = true;
    setDetailLoading(true);
    issuesApi
      .details(project.path, selected.provider, selected.id)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setDetailLoading(false));
    return () => {
      live = false;
    };
  }, [selected, project]);

  const start = useCallback(async () => {
    const issue = detail ?? selected;
    if (!issue || !project || !harness) return;
    setStarting(true);
    setError(null);
    try {
      const s = await api.createSession({
        projectPath: project.path,
        title: `${issue.identifier} ${issue.title}`.slice(0, 80),
        useWorktree,
        onMain: !useWorktree,
        worktreeName: issueWorktreeName(issue.identifier, issue.title),
        issue: { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
        tab: {
          harness: harness.id,
          model: prefs.lastModel[harness.id] ?? "",
          effort: prefs.lastEffort[harness.id] ?? null,
          permissionMode: prefs.lastMode,
        },
      });
      upsertSession(s);
      selectSession(s.id);
      onCreated?.(s.id, s.tabs[0].id, issuePrompt(issue));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [detail, selected, project, harness, prefs, useWorktree, onCreated]);

  const emptyReason = useMemo(() => {
    if (!project) return "Add a project to see its issues.";
    if (provider === "github") {
      if (ghOk === false) return "Issues need the GitHub CLI. Install gh and run gh auth login.";
      if (repo === null) return "Add a GitHub remote named origin to see this project's issues.";
    } else if (linear && !linear.connected) {
      return "Linear is not connected. Add an API key in Settings → Integrations.";
    }
    return null;
  }, [project, provider, ghOk, repo, linear]);

  const mode = PERMISSION_MODES.find((m) => m.id === prefs.lastMode);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col border-r border-hairline">
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 pt-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" className="gap-1.5">
                <FolderGit2 />
                {project?.name ?? "Choose project"}
                <ChevronDown className="text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              {store.projects.map((p) => (
                <DropdownMenuItem
                  key={p.path}
                  onSelect={() => {
                    setSelected(null);
                    setPrefs({ lastProject: p.path });
                    void selectProject(p.path);
                  }}
                >
                  <FolderGit2 className={cn(p.path === project?.path && "text-foreground")} />
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Segmented<Provider>
            aria-label="Provider"
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setSelected(null);
            }}
            options={[
              { value: "github", label: "GitHub" },
              { value: "linear", label: "Linear" },
            ]}
          />
          <button
            type="button"
            aria-pressed={assignedToMe}
            onClick={() => setAssignedToMe((v) => !v)}
            className={cn(
              "flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors",
              assignedToMe ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
            )}
          >
            <UserRound className="size-3.5" /> Assigned to me
          </button>
          {provider === "linear" && teams.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 text-xs">
                  {teams.find((t) => t.id === teamId)?.name ?? "All teams"}
                  <ChevronDown className="text-faint" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setTeamId(null)}>All teams</DropdownMenuItem>
                {teams.map((t) => (
                  <DropdownMenuItem key={t.id} onSelect={() => setTeamId(t.id)}>
                    <span className="font-mono text-[11px] text-faint">{t.key}</span>
                    <span>{t.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div className="ml-auto flex items-center gap-1">
            <div className="flex h-7 items-center gap-1 rounded-md bg-well px-2">
              <Search className="size-3.5 text-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="w-36 bg-transparent text-xs outline-none placeholder:text-faint"
              />
            </div>
            <WithTooltip label="Refresh">
              <Button variant="ghost" size="icon-xs" aria-label="Refresh" onClick={() => setTick((t) => t + 1)}>
                {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </WithTooltip>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {error && <div className="mx-4 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
          {emptyReason ? (
            <div className="flex flex-col items-start gap-2 px-4 py-6 text-sm text-muted-foreground">
              <span>{emptyReason}</span>
              {provider === "linear" && linear && !linear.connected && (
                <span className="flex items-center gap-1 text-xs text-faint">
                  <Settings2 className="size-3.5" /> Press ⌘, then Integrations.
                </span>
              )}
            </div>
          ) : list.length === 0 && !loading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No open issues match.</div>
          ) : (
            <ul className="px-2 pb-4">
              {list.map((i) => (
                <li key={`${i.provider}:${i.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(i);
                      setUseWorktree(prefs.useWorktree);
                    }}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                      selected?.id === i.id && selected.provider === i.provider ? "bg-selected" : "hover:bg-selected/50",
                    )}
                  >
                    <CircleDot className={cn("mt-0.5 size-3.5 shrink-0", i.stateType === "started" ? "text-warning" : "text-add")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 font-mono text-[11px] text-faint">{i.identifier}</span>
                        <span className="truncate text-[13px] text-foreground">{i.title}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
                        <span>{i.state}</span>
                        {i.labels.slice(0, 4).map((l) => (
                          <span key={l.name} className="flex items-center gap-1">
                            <span className="size-2 rounded-full" style={{ background: l.color ? `#${l.color}` : "var(--ink-faint)" }} />
                            {l.name}
                          </span>
                        ))}
                        {i.assignee && <span>· {i.assignee.name}</span>}
                        {i.updatedAt && <span>· {relativeTime(i.updatedAt)}</span>}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex w-[46%] min-w-[20rem] max-w-[40rem] flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-faint">Pick an issue to read it and start a session on it.</div>
        ) : (
          <>
            <div className="flex shrink-0 flex-col gap-2 border-b border-hairline px-5 pb-3 pt-4">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-faint">{selected.identifier}</span>
                <h2 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">{selected.title}</h2>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>{selected.state}</span>
                {selected.team && <span>{selected.team.name}</span>}
                {selected.assignee && <span>Assigned to {selected.assignee.name}</span>}
                <button type="button" onClick={() => void openUrl(selected.url)} className="flex items-center gap-1 hover:text-foreground">
                  Open in browser <ExternalLink className="size-3" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" size="sm" className="gap-1.5">
                      {harness && <AgentMark id={harness.id} className="size-3.5" />}
                      {harness?.name ?? "Agent"}
                      <ChevronDown className="text-faint" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {store.harnesses.map((h) => (
                      <DropdownMenuItem key={h.id} disabled={!h.available} onSelect={() => setPrefs({ lastAgent: h.id })}>
                        <AgentMark id={h.id} />
                        <span>{h.name}</span>
                        {!h.available && <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span>}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="gap-1 text-xs">
                      {mode?.label ?? prefs.lastMode}
                      <ChevronDown className="text-faint" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {PERMISSION_MODES.map((m) => (
                      <DropdownMenuItem key={m.id} onSelect={() => chooseMode(harness?.id ?? "", m.id, (v) => setPrefs({ lastMode: v }))}>
                        {m.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex min-w-0 items-center gap-2 text-[11px] text-faint">
                  <Switch aria-label="Start issue in a new worktree" size="sm" checked={useWorktree} onCheckedChange={setUseWorktree} />
                  <span className={cn("flex min-w-0 items-center gap-1", !useWorktree && "text-warning")}>
                    <GitBranch className="size-3.5 shrink-0" />
                    {useWorktree ? (
                      <>
                        in new worktree <span className="truncate font-mono text-foreground">{issueWorktreeName(selected.identifier, selected.title)}</span> from{" "}
                        <span className="font-mono text-foreground">{status?.defaultBranch ?? "default"}</span>
                      </>
                    ) : (
                      <>
                        on <span className="font-mono">{status?.branch ?? "main"}</span>
                      </>
                    )}
                  </span>
                </label>
                <Button size="sm" variant="accent" className="ml-auto shrink-0" disabled={starting || !harness?.available || detailLoading} onClick={() => void start()}>
                  {starting ? <Loader2 className="animate-spin" /> : null}
                  Start session
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
              {detailLoading && <div className="text-xs text-faint">Loading…</div>}
              {detail && (detail.body?.trim() ? <Markdown text={detail.body} /> : <div className="text-sm text-faint">No description.</div>)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
