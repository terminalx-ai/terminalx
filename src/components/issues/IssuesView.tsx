import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ExternalLink, FolderGit2, GitBranch, Loader2, RefreshCw, Search, Settings2, UserRound } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { bindingText, matchesShortcut, useKeymap } from "@/lib/shortcuts";
import { Segmented, Switch } from "@/components/ui/controls";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/menu";
import { AutomationEditor, type AutomationEditorPrefill } from "@/components/automations/AutomationEditor";
import { AssigneePicker } from "@/components/issues/AssigneePicker";
import { IssueListItem } from "@/components/issues/IssueListItem";
import { IssuePipelinePanel } from "@/components/issues/IssuePipelinePanel";
import { IssueCommentComposer } from "@/components/issues/IssueCommentComposer";
import { IssueCommentThread } from "@/components/issues/IssueCommentThread";
import { IssueStatusPicker } from "@/components/issues/IssueStatusPicker";
import { issueKey as writeKey, useIssueWrites } from "@/components/issues/issueWrites";
import { IssueDescription, IssueLabels, IssuePriority, IssueTitle, editableIssue, useIssueEdits } from "@/components/issues/IssueFields";
import { SessionAgentControls } from "@/components/session/SessionAgentControls";
import { useSessionAgent } from "@/lib/useSessionAgent";
import { Markdown } from "@/components/chat/Markdown";
import { api, errorMessage, gh, issues as issuesApi, type Issue, type IssueTeam, type LinearStatus } from "@/lib/api";
import { openAutomation, selectProject, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { PERMISSION_MODES } from "@/lib/models";
import { chooseMode } from "@/lib/dialogs";
import { cn } from "@/lib/cn";
import { issuePrompt, issuePromptWithComments, issueWorktreeName } from "@/lib/issueSession";
import type { IssueThread } from "@/lib/issueComments";
import type { IssueDetails } from "@/lib/issueOps";
import { useIssueViewer } from "@/lib/issueViewer";
import { pipelineForIssue, pipelineSettings, startPipeline, unlistedPipelines, useIssuePipelines } from "@/lib/issuePipeline";
import type { IssuePipeline } from "@/types/issuePipeline";
import type { WorkStatus } from "@/types/session";

type Provider = "github" | "linear";

/**
 * GitHub closes an issue a moment after the pull request that closes it is
 * merged. The list is read again once that has had time to happen.
 */
const AFTER_MERGE_MS = 3000;

/**
 * A row for an issue the tracker's list no longer holds, from what its
 * pipeline remembers of it. What the tracker says of it now is read when the
 * issue is opened, so the row claims no state.
 */
function issueOfPipeline(pipeline: IssuePipeline): Issue {
  const { provider, id, identifier, title, url } = pipeline.issue;
  return { provider: provider === "linear" ? "linear" : "github", id, identifier, number: Number(id) || 0, title, url, state: "", stateType: "completed", labels: [], updatedAt: pipeline.modified };
}

/** True when the target of a key is somewhere text is typed. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || !!target.closest('[contenteditable]:not([contenteditable="false"])');
}

/** A row as read, with the state a later write gave it kept when the read is older than that write. */
const keepState = (read: Issue, shown: Issue | undefined): Issue =>
  shown ? { ...read, state: shown.state, stateType: shown.stateType, updatedAt: shown.updatedAt } : read;

/**
 * `next`, unless `now` is the same issue read later: an answer that was
 * slower than a write must not put back what the write changed.
 */
function newer(now: Issue | null, next: Issue): Issue {
  const same = now && now.provider === next.provider && now.id === next.id;
  return same && Date.parse(now.updatedAt) > Date.parse(next.updatedAt) ? now : next;
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
  const settingsKeys = useKeymap()["app.settings"][0];
  const [provider, setProvider] = useState<Provider>(prefs.issueProvider);
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teams, setTeams] = useState<IssueTeam[]>([]);
  const [search, setSearch] = useState("");
  const [list, setList] = useState<Issue[]>([]);
  // Which project and tracker `list` was read for. Until it is this one, nothing can be said to be missing from it.
  const [listOf, setListOf] = useState<string | null>(null);
  // Who has each issue whose assignees changed here since the list was read, by `provider:id`. A row of the
  // "Assigned to me" list assigned away from the reader stays until the next read, marked, rather than vanish under the pointer.
  const [assignedHere, setAssignedHere] = useState<ReadonlyMap<string, string[]>>(new Map());
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
  const [automationPrefill, setAutomationPrefill] = useState<AutomationEditorPrefill | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const writes = useIssueWrites();
  const setUseWorktree = onUseWorktreeChange ?? setLocalUseWorktree;

  const project = store.projects.find((p) => p.path === prefs.lastProject) ?? store.projects[0] ?? null;
  const isGit = project?.kind !== "folder";
  const useWorktree = isGit && (controlledUseWorktree ?? localUseWorktree);
  const pipelines = useIssuePipelines();
  const pipelineDefaults = pipelineSettings(project);
  // The issue's own switch, before its session exists. It starts at the project's default.
  const [autoMerge, setAutoMerge] = useState(pipelineDefaults.autoMerge);
  // A pull request needs a branch of its own, so a session on the project's checkout ends at the code.
  const pipelineOffered = isGit && useWorktree && pipelineDefaults.enabled;
  const pipeline = selected && project ? pipelineForIssue(pipelines, project.path, selected.url) : null;
  // Once an issue has a pipeline its switch is the pipeline's, on the panel
  // below; a session started on it again keeps what was chosen there.
  const mergeChoice = pipeline ? pipeline.autoMerge : autoMerge;
  // Read again when the Linear key or its connection changes, and on a refresh (another `gh` login, or a failed read).
  const viewer = useIssueViewer(project?.path, provider, provider === "linear" ? `${linear?.connected}:${linear?.viewer ?? ""}` : `${ghOk}:${tick}`);
  const agentSelection = useSessionAgent(store.harnesses);
  const { harness, modelId, effort } = agentSelection;
  const linkedIssueUrls = useMemo(
    () => new Set(store.sessions.flatMap((session) => session.issue?.url ? [session.issue.url] : [])),
    [store.sessions],
  );
  // Issues with a pipeline here that the list does not hold: closed by their
  // merge, or outside the search. They stay below it, so the record of what
  // happened to them can still be read on their page.
  const unlisted = useMemo(() => {
    if (!project || listOf !== `${project.path}\n${provider}`) return [];
    const words = search.trim().toLowerCase();
    return unlistedPipelines(pipelines, project.path, provider, list.map((issue) => issue.url))
      .filter((value) => !words || `${value.issue.identifier} ${value.issue.title}`.toLowerCase().includes(words))
      .map((value) => ({ issue: issueOfPipeline(value), pipeline: value }));
  }, [pipelines, project, provider, list, listOf, search]);
  // A merge closes the issue on the tracker. The list and the open issue are
  // read again when a pipeline of this project gets there.
  const mergedHere = pipelines.filter((value) => value.projectPath === project?.path && value.state === "merged").length;
  const mergedSeen = useRef({ project: project?.path, count: mergedHere });
  useEffect(() => {
    const before = mergedSeen.current;
    mergedSeen.current = { project: project?.path, count: mergedHere };
    // Another project's count is not a merge that happened in this one.
    if (before.project !== project?.path || mergedHere <= before.count) return;
    const timer = window.setTimeout(() => setTick((t) => t + 1), AFTER_MERGE_MS);
    return () => window.clearTimeout(timer);
  }, [mergedHere, project?.path]);

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
    if (!project || project.kind === "folder") return setRepo(null);
    issuesApi.githubRepo(project.path).then((r) => live && setRepo(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, [project]);
  useEffect(() => {
    let live = true;
    if (!project || project.kind === "folder") return setStatus(null);
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
      const started = writes.readStarted();
      try {
        const r = await issuesApi.list(project.path, provider, { assignedToMe, teamId, search });
        if (live) {
          // A row written to since the read started keeps the state the write gave it.
          setList((rows) => r.map((row) => (writes.outdated(writeKey(row), started) ? keepState(row, rows.find((each) => writeKey(each) === writeKey(row))) : row)));
          setListOf(`${project.path}\n${provider}`);
          setAssignedHere(new Map());
        }
      } catch (e) {
        if (live) {
          setList([]);
          setListOf(`${project.path}\n${provider}`);
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

  // Body on demand: GitHub lists come without it. A refresh reads the open
  // issue again as well, since its state may have moved; what is on the page
  // stays there until the answer comes.
  const shown = useRef<string | null>(null);
  const selectedAtTick = useRef(tick);
  useEffect(() => {
    const key = selected && project ? `${project.path}:${selected.provider}:${selected.id}` : null;
    const again = key != null && shown.current === key;
    shown.current = key;
    if (!again) {
      setDetail(null);
      selectedAtTick.current = tick;
    }
    if (!selected || !project) return;
    // A Linear row carries its body, so it is shown while the issue is read
    // whole: what editing it needs comes only with that.
    const rowFirst = !again && selected.body != null && selected.provider === "linear" && selectedAtTick.current === tick;
    if (rowFirst) setDetail(selected);
    let live = true;
    const started = writes.readStarted();
    if (!again && !rowFirst) setDetailLoading(true);
    issuesApi
      .details(project.path, selected.provider, selected.id)
      // Not over a status change that began or ended since the read started.
      .then((d) => live && setDetail((now) => (now && writeKey(now) === writeKey(d) && writes.outdated(writeKey(d), started) ? now : newer(now, d))))
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setDetailLoading(false));
    return () => {
      live = false;
    };
  }, [selected, project, tick]);

  // The open issue's thread as the pane last read it, for the agent's prompt; named by the issue it belongs to.
  const thread = useRef<{ key: string; thread: IssueThread } | null>(null);
  const threadKey = selected && project ? `${project.path}\n${selected.provider}\n${selected.id}` : null;
  const onThread = useCallback((key: string, value: IssueThread) => {
    thread.current = { key, thread: value };
  }, []);

  const start = useCallback(async () => {
    const issue = detail ?? selected;
    if (!issue || !project || !harness) return;
    setStarting(true);
    setError(null);
    try {
      // The discussion goes with the first prompt: the pane's thread when it was read, else read now, before the session exists.
      const key = `${project.path}\n${issue.provider}\n${issue.id}`;
      const read = thread.current?.key === key ? thread.current.thread : null;
      let prompt = read ? issuePrompt(issue, read) : await issuePromptWithComments(project.path, issue);
      const s = await api.createSession({
        projectPath: project.path,
        title: `${issue.identifier} ${issue.title}`.slice(0, 80),
        useWorktree,
        onMain: !useWorktree,
        worktreeName: isGit ? issueWorktreeName(issue.identifier, issue.title) : null,
        issue: { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
        tab: {
          harness: harness.id,
          model: modelId,
          effort,
          permissionMode: prefs.lastMode,
        },
      });
      upsertSession(s);
      // The pipeline starts with the session, and tells the author how to hand
      // its work over. A session it cannot serve still starts, as it always did.
      if (pipelineOffered) {
        try {
          const started = await startPipeline(s.id, s.tabs[0].id, mergeChoice && !pipelineDefaults.requirePerson);
          prompt = `${prompt}\n\n${started.authorBrief}`;
        } catch (e) {
          console.error("issue pipeline did not start", e);
        }
      }
      selectSession(s.id);
      onCreated?.(s.id, s.tabs[0].id, prompt);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [detail, selected, project, harness, modelId, effort, prefs.lastMode, useWorktree, isGit, onCreated, pipelineOffered, mergeChoice, pipelineDefaults.requirePerson]);

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
  const open = (issue: Issue) => {
    setSelected(issue);
    setStatusOpen(false);
    setUseWorktree(prefs.useWorktree);
    setAutoMerge(pipelineDefaults.autoMerge);
  };
  // The description alone: a Linear issue read whole carries its first comments pasted under its body, and the thread shows them.
  const detailText = detail ? ((detail as Partial<IssueDetails>).description ?? detail.body ?? "") : null;
  const isOpen = (issue: Issue) => selected?.id === issue.id && selected.provider === issue.provider;
  // A status change, as it shows while on its way and then as the tracker answers: the page and its row together.
  const statusChanged = (issue: Issue) => {
    const same = (each: Issue) => each.id === issue.id && each.provider === issue.provider;
    setDetail((d) => (d && same(d) ? { ...d, ...issue } : d));
    setList((rows) => rows.map((row) => (same(row) ? { ...row, state: issue.state, stateType: issue.stateType, updatedAt: issue.updatedAt } : row)));
  };
  // An issue as a write answered with it: the open one shows it (even before its details came), and its row shows who has it now.
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const assigned = (changed: IssueDetails) => {
    const same = (issue: Issue) => issue.provider === changed.provider && issue.id === changed.id;
    setDetail((now) => (selectedNow.current && same(selectedNow.current) ? newer(now, changed) : now));
    setList((rows) => rows.map((row) => (same(row) ? { ...row, assignee: changed.assignee, assignees: changed.assignees, updatedAt: changed.updatedAt } : row)));
    setAssignedHere((map) => new Map(map).set(`${changed.provider}:${changed.id}`, changed.assignees.map((person) => person.id)));
  };
  const notMine = (issue: Issue) => {
    const who = assignedHere.get(`${issue.provider}:${issue.id}`);
    return assignedToMe && !!viewer && !!who && !who.includes(viewer.id);
  };
  // What the tracker says of the open issue now, once that has been read; the row it was opened from until then.
  const current = detail && isOpen(detail) ? detail : selected;
  // A write answers with the issue as the provider has it now: the page and its row follow.
  const changed = useCallback((next: IssueDetails) => {
    const same = (issue: Issue | null) => !!issue && issue.provider === next.provider && issue.id === next.id;
    setDetail((now) => (same(now) ? newer(now, next) : now));
    setList((rows) => rows.map((row) => (same(row) ? { ...row, title: next.title, labels: next.labels, state: next.state, stateType: next.stateType, assignee: next.assignee, assignees: next.assignees, updatedAt: next.updatedAt } : row)));
  }, []);
  const edits = useIssueEdits(project?.path ?? null, editableIssue(current), changed);
  // The editors are the open issue's own: a switch starts them afresh.
  const issueKey = selected ? `${project?.path}:${selected.provider}:${selected.id}` : "";
  // The session working on the issue: the pipeline's author, never its reviewer.
  const linkedSession = selected
    ? store.sessions.find((session) => session.id === pipeline?.author.sessionId) ?? store.sessions.find((session) => session.issue?.url === selected.url)
    : null;

  if (automationPrefill) {
    return (
      <AutomationEditor
        open
        automation={null}
        prefill={automationPrefill}
        backLabel="Issues"
        onOpenChange={(open) => {
          if (!open) setAutomationPrefill(null);
        }}
        onSaved={(automation) => openAutomation(automation.id)}
      />
    );
  }

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
                  <Settings2 className="size-3.5" /> {settingsKeys ? `Press ${bindingText(settingsKeys)}, then Integrations.` : "Open Settings, then Integrations."}
                </span>
              )}
            </div>
          ) : list.length === 0 && !loading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No open issues match.</div>
          ) : (
            <ul className="px-2 pb-4">
              {list.map((i) => (
                <li key={`${i.provider}:${i.id}`}>
                  <ContextMenu>
                    <ContextMenuTrigger className="block">
                      <IssueListItem
                        issue={i}
                        selected={isOpen(i)}
                        linked={linkedIssueUrls.has(i.url)}
                        notMine={notMine(i)}
                        pipeline={project ? pipelineForIssue(pipelines, project.path, i.url) : null}
                        onSelect={() => open(i)}
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {i.provider === "github" && i.labels.length > 0 ? i.labels.map((label) => (
                        <ContextMenuItem
                          key={label.name}
                          onSelect={() => setAutomationPrefill({
                            projectPath: project?.path ?? "",
                            repo: repo ?? "",
                            query: `label:${label.name}`,
                            label: label.name,
                          })}
                        >
                          Automate this label: {label.name}…
                        </ContextMenuItem>
                      )) : <ContextMenuItem disabled>Add a label before automating</ContextMenuItem>}
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              ))}
            </ul>
          )}
          {!emptyReason && unlisted.length > 0 && (
            <section aria-label="Pipelines on issues not listed above" data-testid="issues-unlisted">
              <h3 className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">Pipelines on issues not listed above</h3>
              <ul className="px-2 pb-4">
                {unlisted.map(({ issue, pipeline: its }) => (
                  <li key={`${issue.provider}:${issue.id}`}>
                    <IssueListItem issue={issue} selected={isOpen(issue)} pipeline={its} onSelect={() => open(issue)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      <div
        className="flex w-[46%] min-w-[20rem] max-w-[40rem] flex-col outline-none"
        tabIndex={-1}
        data-testid="issue-detail"
        onKeyDown={(e) => {
          if (!current || typingIn(e.target) || !matchesShortcut(e.nativeEvent, "issues.status")) return;
          // Only an issue read whole has a picker to open, and not while a change to it is on its way.
          const capabilities = (current as Partial<IssueDetails>).capabilities;
          if (!capabilities || !(capabilities.workflowStates || capabilities.closeReasons) || writes.writing.has(writeKey(current))) return;
          e.preventDefault();
          setStatusOpen(true);
        }}
      >
        {!selected ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-faint">Pick an issue to read it and start a session on it.</div>
        ) : (
          <>
            <div className="flex shrink-0 flex-col gap-2 border-b border-hairline px-5 pb-3 pt-4">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-faint">{selected.identifier}</span>
                <IssueTitle key={issueKey} edits={edits} title={current?.title ?? selected.title} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {current && project && (
                  <IssueStatusPicker
                    key={`status:${writeKey(current)}`}
                    projectPath={project.path}
                    issue={current}
                    pipeline={pipeline}
                    open={statusOpen}
                    onOpenChange={setStatusOpen}
                    busy={writes.writing.has(writeKey(current))}
                    onWriting={(on) => {
                      // The menu is closed by the choice; it never comes back on its own once the answer is in.
                      if (on) setStatusOpen(false);
                      (on ? writes.begin : writes.end)(writeKey(current));
                    }}
                    onChange={statusChanged}
                  />
                )}
                {current?.team && <span>{current.team.name}</span>}
                {project && current && (current.assignees || current.assignee || !detailLoading) && (
                  <AssigneePicker key={`${current.provider}:${current.id}`} projectPath={project.path} issue={current} viewer={viewer} onChange={assigned} />
                )}
                <button type="button" onClick={() => void openUrl(selected.url)} className="flex items-center gap-1 hover:text-foreground">
                  Open in browser <ExternalLink className="size-3" />
                </button>
              </div>
              {(edits.issue || (current?.labels.length ?? 0) > 0) && (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <IssuePriority key={issueKey} edits={edits} />
                  <IssueLabels key={issueKey} edits={edits} labels={current?.labels ?? []} />
                </div>
              )}
              {edits.error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{edits.error}</div>}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <SessionAgentControls selection={agentSelection} />
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
              {/* Where it runs, and the buttons. The buttons take a line of their own
                  when the pane is too narrow for both, rather than sit on the words. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid="issue-start-row">
                {!isGit ? <span className="text-xs text-faint">In folder · no Git</span> : <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-[11px] text-faint">
                  <Switch aria-label="Start issue in a new worktree" size="sm" checked={useWorktree} onCheckedChange={setUseWorktree} />
                  <span className={cn("flex min-w-0 items-center gap-1 whitespace-nowrap", !useWorktree && "text-warning")}>
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
                </label>}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {linkedSession && (
                    <Button variant="secondary" size="sm" onClick={() => selectSession(linkedSession.id)}>
                      Open session
                    </Button>
                  )}
                  <Button size="sm" variant="accent" disabled={starting || !harness?.available || detailLoading} onClick={() => void start()}>
                    {starting ? <Loader2 className="animate-spin" /> : null}
                    Start session
                  </Button>
                </div>
              </div>
              {pipeline ? null : pipelineOffered ? (
                <label className="flex min-w-0 items-start gap-2 text-[11px] text-faint">
                  <Switch
                    aria-label="Merge automatically when the review is addressed"
                    size="sm"
                    className="mt-px shrink-0"
                    checked={autoMerge && !pipelineDefaults.requirePerson}
                    disabled={pipelineDefaults.requirePerson}
                    onCheckedChange={setAutoMerge}
                  />
                  <span className="min-w-0 text-muted-foreground">
                    Merge automatically when the review is addressed
                    <span className="block text-faint">
                      {pipelineDefaults.requirePerson
                        ? "A pull request is opened and reviewed when the work is done. This project has a person do the merge."
                        : "A pull request is opened and reviewed when the work is done. Off, it stops at Ready to merge."}
                    </span>
                  </span>
                </label>
              ) : (
                isGit && pipelineDefaults.enabled && <span className="text-[11px] text-faint">No pull request is opened for a session on the project’s own checkout.</span>
              )}
            </div>
            {/* The pipeline scrolls with the issue: its findings and record can be long. */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {pipeline && <IssuePipelinePanel key={pipeline.id} pipeline={pipeline} />}
              <div className="px-5 py-4">
                {detailLoading && <div className="text-xs text-faint">Loading…</div>}
                {detailText != null && (
                  <IssueDescription key={issueKey} edits={edits}>
                    {detailText.trim() ? <Markdown text={detailText} /> : <div className="text-sm text-faint">No description.</div>}
                  </IssueDescription>
                )}
              </div>
              {project && (
                <div className="border-t border-hairline px-5 pb-5 pt-3">
                  <IssueCommentThread
                    key={threadKey}
                    projectPath={project.path}
                    provider={selected.provider}
                    issueId={selected.id}
                    refreshKey={tick}
                    onComments={(value) => threadKey && onThread(threadKey, value)}
                    footer={(controls) => (
                      <IssueCommentComposer
                        projectPath={project.path}
                        issue={current ?? selected}
                        controls={controls}
                        viewer={viewer}
                        busy={writes.writing.has(writeKey(selected))}
                        hooks={{ begin: writes.begin, end: writes.end, onIssue: changed }}
                      />
                    )}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
