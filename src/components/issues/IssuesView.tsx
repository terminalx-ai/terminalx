import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Cloud, Copy, ExternalLink, FolderGit2, GitBranch, Loader2, Plus, RefreshCw, Search, Settings2, Users } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { bindingText, matchesShortcut, useKeymap } from "@/lib/shortcuts";
import { Segmented, Switch } from "@/components/ui/controls";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/menu";
import { AutomationEditor, type AutomationEditorPrefill } from "@/components/automations/AutomationEditor";
import { AssigneePicker } from "@/components/issues/AssigneePicker";
import { NewIssueForm } from "@/components/issues/NewIssueForm";
import { IssueListItem } from "@/components/issues/IssueListItem";
import { IssueListFilters } from "@/components/issues/IssueListFilters";
import { IssuePipelinePanel } from "@/components/issues/IssuePipelinePanel";
import { IssueCommentComposer } from "@/components/issues/IssueCommentComposer";
import { IssueCommentThread } from "@/components/issues/IssueCommentThread";
import { IssueStatusPicker } from "@/components/issues/IssueStatusPicker";
import { IssueWorkPanel, TakenIssueDialog } from "@/components/issues/IssueWork";
import { issueKey as writeKey, useIssueWrites } from "@/components/issues/issueWrites";
import { IssueDescription, IssueLabels, IssuePriority, IssueTitle, editableIssue, useIssueEdits } from "@/components/issues/IssueFields";
import { SessionAgentControls } from "@/components/session/SessionAgentControls";
import { cloudStartError, useCloudProjectChoices } from "@/components/session/CloudNewSession";
import { useSessionAgent } from "@/lib/useSessionAgent";
import { Markdown } from "@/components/chat/Markdown";
import { api, errorMessage, gh, issues as issuesApi, type Issue, type IssueTeam, type LinearStatus } from "@/lib/api";
import { filterMiss, issueFilterFor, issueFilterKey, wireFilter, type IssueListFilter } from "@/lib/issueListFilter";
import { openAutomation, selectProject, selectSession, startCloudSessionIn, takeNewIssueRequest, upsertSession, useSessionStore } from "@/lib/sessions";
import { openCloudSession } from "@/lib/cloudDashboard";
import { useCloudModelClient } from "@/lib/cloudModels";
import { planCloudStart, startInWorkspace, type CloudIssueOutcome } from "@/lib/cloudNewSession";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { issuePrompt, issuePromptWithComments, issueWorktreeName } from "@/lib/issueSession";
import type { IssueThread } from "@/lib/issueComments";
import type { IssueDetails } from "@/lib/issueOps";
import { useIssueViewer } from "@/lib/issueViewer";
import { mine, taken, unavailableText, useIssueWork, workKeyOf, workToWarnAbout, type IssueWorker } from "@/lib/issueWork";
import { cloudPipelineSettings, pipelineForIssue, pipelineSettings, startPipeline, unlistedPipelines, useIssuePipelines } from "@/lib/issuePipeline";
import type { IssuePipeline } from "@/types/issuePipeline";
import type { Project, WorkStatus } from "@/types/session";
import type { CloudProject } from "@/types/target";

type Provider = "github" | "linear";
/** Which issues the list shows by who works on them (#441). */
type WorkFilter = "all" | "free" | "mine";
const WORK_FILTERS: { value: WorkFilter; label: string }[] = [
  { value: "all", label: "All issues" },
  { value: "free", label: "Hide issues someone is working on" },
  { value: "mine", label: "Only mine" },
];

/**
 * What the Issues view lists issues of and starts sessions in: a project on
 * this computer, or a cloud project. A cloud project's issues are its
 * repository's, read with the reader's own `gh`; its sessions start in one of
 * its workspaces, where the runtime carries them on to a pull request.
 */
interface IssueTarget {
  /** The project's path, or the cloud project's key: what every issue call is given. */
  path: string;
  name: string;
  isGit: boolean;
  local: Project | null;
  cloud: { project: CloudProject; orgName: string; mayStart: boolean | null } | null;
}

/** Why an issue's cloud session will not be carried on to a pull request, when it will not be. */
function cloudIssueNote(outcome: CloudIssueOutcome): string | null {
  if (!outcome.supported) return "The session started. Its workspace runs an older TerminalX, so no pull request is opened for it.";
  if (!outcome.pipeline && outcome.note) return `The session started. No pull request is opened for it: ${outcome.note}`;
  return null;
}

/**
 * GitHub closes an issue a moment after the pull request that closes it is
 * merged, and its lists show that some seconds later still. The list is read
 * again once that has had time to happen, and once more after.
 */
const AFTER_MERGE_MS = [3000, 12000];

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

/** A row as read, with what a later change made here kept: its status, assignees, labels and title. */
const keepEdits = (read: Issue, shown: Issue): Issue => ({
  ...read,
  title: shown.title,
  state: shown.state,
  stateType: shown.stateType,
  workflowStateType: shown.workflowStateType,
  labels: shown.labels,
  assignee: shown.assignee,
  assignees: shown.assignees,
  updatedAt: shown.updatedAt,
});

/** True when the row shown holds a change the provider made after the row read: its lists lag a write by a few seconds. */
const newerHere = (read: Issue, shown: Issue | undefined) => !!shown && Date.parse(shown.updatedAt) > Date.parse(read.updatedAt);

/**
 * `next`, unless `now` is the same issue read later: an answer that was
 * slower than a write must not put back what the write changed.
 */
function newer(now: Issue | null, next: Issue): Issue {
  const same = now && now.provider === next.provider && now.id === next.id;
  return same && Date.parse(now.updatedAt) > Date.parse(next.updatedAt) ? now : next;
}

/** True when an arrow key on `target` already means something there: a menu, a list box, a radio group. */
function arrowsTaken(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('[role="menu"],[role="listbox"],[role="radiogroup"],[role="tablist"],[role="slider"]');
}

/**
 * Issues from the project's tracker, and a way to start a session on one.
 * The list is filtered and sorted by the tracker (most recently updated
 * first, unless the reader chose otherwise); the detail column shows the
 * body so the reader can judge before an agent spends a worktree on it. A
 * change made in the detail column shows on its row at once, and a row that
 * no longer matches the filter stays, dimmed, until the next refresh.
 *
 * Keys, while the focus is in the view and not in a text field: Up and Down
 * move through the list (from the list's side; in the detail pane they
 * scroll); the `issues.*` shortcuts open the open issue's
 * status, assignee and label pickers and go to its comment box.
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
  const [teams, setTeams] = useState<IssueTeam[]>([]);
  const [search, setSearch] = useState("");
  const [list, setList] = useState<Issue[]>([]);
  const listNow = useRef(list);
  listNow.current = list;
  // Which project and tracker `list` was read for. Until it is this one, nothing can be said to be missing from it.
  const [listOf, setListOf] = useState<string | null>(null);
  // The issues changed here since the list was read, by `provider:id`. One that no longer matches the filter stays
  // until the next read, dimmed, rather than vanish under the pointer.
  const [changedHere, setChangedHere] = useState<ReadonlySet<string>>(new Set());
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
  const [workFilter, setWorkFilter] = useState<WorkFilter>("all");
  // Work on the issue to say before a session starts on it.
  const [takenBy, setTakenBy] = useState<IssueWorker[] | null>(null);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  const listColumn = useRef<HTMLDivElement>(null);
  // The new-issue form, in the detail column in place of the open issue.
  const [composing, setComposing] = useState(false);
  // The issue created here last: listed and open even when the list read since doesn't hold it yet, under
  // the filter it was made under. Let go of once a read holds it or the filter changes.
  const created = useRef<{ projectPath: string; filter: string; issue: Issue } | null>(null);
  const [copied, setCopied] = useState(false);
  const writes = useIssueWrites();
  const setUseWorktree = onUseWorktreeChange ?? setLocalUseWorktree;

  const localProject = store.projects.find((p) => p.path === prefs.lastProject) ?? store.projects[0] ?? null;
  // Cloud projects with a GitHub repository: a blank one has no issues to list.
  const cloudChoices = useCloudProjectChoices();
  const cloudGroups = useMemo(
    () => cloudChoices.map((choice) => ({ ...choice, projects: choice.projects.filter((p) => !p.blank && p.identity.startsWith("github.com/")) })).filter((choice) => choice.projects.length > 0),
    [cloudChoices],
  );
  const cloudChoice = useMemo(() => {
    for (const choice of cloudGroups) {
      const found = choice.projects.find((p) => p.key === prefs.issueCloudProject);
      if (found) return { project: found, orgName: choice.orgName, mayStart: choice.mayStart };
    }
    return null;
  }, [cloudGroups, prefs.issueCloudProject]);
  const project: IssueTarget | null = cloudChoice
    ? { path: cloudChoice.project.key, name: cloudChoice.project.fullName, isGit: true, local: null, cloud: cloudChoice }
    : localProject
      ? { path: localProject.path, name: localProject.name, isGit: localProject.kind !== "folder", local: localProject, cloud: null }
      : null;
  // What the effects below follow: the target, not a copy of it that a catalog poll renews.
  const projectPath = project?.path ?? null;
  const cloud = project?.cloud ?? null;
  const isGit = project?.isGit ?? true;
  // A cloud issue always gets a worktree of its own: it is what its pull request is opened from.
  const useWorktree = isGit && (cloud ? true : (controlledUseWorktree ?? localUseWorktree));
  // The list's filter, as the reader left it for this project and tracker.
  const filterKey = projectPath ? issueFilterKey(projectPath, provider) : null;
  const filter = issueFilterFor(filterKey ? prefs.issueFilters[filterKey] : undefined, provider);
  const filterAsked = JSON.stringify(wireFilter(filter, ""));
  const pinFilter = `${filterAsked}\n${search}`;
  const setFilter = (next: IssueListFilter) => {
    if (filterKey) setPrefs({ issueFilters: { ...getPrefs().issueFilters, [filterKey]: next } });
  };
  const pipelines = useIssuePipelines();
  const pipelineDefaults = cloud ? cloudPipelineSettings(cloud.project.key, prefs) : pipelineSettings(project?.local);
  // The issue's own switch, before its session exists. It starts at the project's default.
  const [autoMerge, setAutoMerge] = useState(pipelineDefaults.autoMerge);
  // A pull request needs a branch of its own, so a session on the project's checkout ends at the code.
  const pipelineOffered = isGit && useWorktree && pipelineDefaults.enabled;
  const pipeline = selected && projectPath ? pipelineForIssue(pipelines, projectPath, selected.url) : null;
  // Once an issue has a pipeline its switch is the pipeline's, on the panel
  // below; a session started on it again keeps what was chosen there.
  const mergeChoice = pipeline ? pipeline.autoMerge : autoMerge;
  // Read again when the Linear key or its connection changes, and on a refresh (another `gh` login, or a failed read).
  const viewer = useIssueViewer(projectPath ?? undefined, provider, provider === "linear" ? `${linear?.connected}:${linear?.viewer ?? ""}` : `${ghOk}:${tick}`);
  // A cloud session runs the agents and models installed in its workspace, not this computer's. They are
  // read from a running workspace while an issue is open, where they are chosen: browsing the list keeps nothing up.
  const cloudPlan = cloud?.mayStart ? planCloudStart(cloud.project) : null;
  const modelClient = useCloudModelClient(cloudPlan?.kind === "reuse" && selected ? { orgId: cloudPlan.node.item.workspace.orgId, workspaceId: cloudPlan.node.item.workspace.id } : null);
  const agentSelection = useSessionAgent(store.harnesses, !cloud, modelClient);
  const { harness, modelId, effort, mode } = agentSelection;
  const [startNote, setStartNote] = useState<string | null>(null);
  const linkedIssueUrls = useMemo(
    () => new Set([...store.sessions.flatMap((session) => session.issue?.url ? [session.issue.url] : []), ...pipelines.filter((value) => value.projectPath === projectPath).map((value) => value.issue.url)]),
    [store.sessions, pipelines, projectPath],
  );
  // Who works on each listed issue: this Mac's sessions, the reader's other machines, teammates.
  const work = useIssueWork(projectPath, provider, list, store.sessions, tick);
  const workOf = (issue: Issue) => work.byIssue.get(workKeyOf(issue));
  // The issue just created here stays listed while it is pinned, whoever works on it (PRO-99).
  const pinnedKey = created.current ? writeKey(created.current.issue) : null;
  const shownList = workFilter === "all" ? list : list.filter((issue) => writeKey(issue) === pinnedKey || (workFilter === "free" ? !taken(workOf(issue)) : mine(workOf(issue))));
  const workNote = unavailableText(work.answer);
  // Issues with a pipeline here that the list does not hold: closed by their
  // merge, or outside the search. They stay below it, so the record of what
  // happened to them can still be read on their page.
  const unlisted = useMemo(() => {
    if (!projectPath || listOf !== `${projectPath}\n${provider}`) return [];
    const words = search.trim().toLowerCase();
    return unlistedPipelines(pipelines, projectPath, provider, list.map((issue) => issue.url))
      .filter((value) => !words || `${value.issue.identifier} ${value.issue.title}`.toLowerCase().includes(words))
      .map((value) => ({ issue: issueOfPipeline(value), pipeline: value }));
  }, [pipelines, projectPath, provider, list, listOf, search]);
  // A merge closes the issue on the tracker. The list and the open issue are
  // read again when a pipeline of this project gets there.
  const mergedHere = pipelines.filter((value) => value.projectPath === projectPath && value.state === "merged").length;
  const mergedSeen = useRef({ project: projectPath, count: mergedHere });
  useEffect(() => {
    const before = mergedSeen.current;
    mergedSeen.current = { project: projectPath, count: mergedHere };
    // Another project's count is not a merge that happened in this one.
    if (before.project !== projectPath || mergedHere <= before.count) return;
    const timers = AFTER_MERGE_MS.map((ms) => window.setTimeout(() => setTick((t) => t + 1), ms));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [mergedHere, projectPath]);

  // The side panel shows a project on this computer; a cloud project has none here.
  const localPath = project?.local?.path ?? null;
  useEffect(() => {
    onTargetProjectChange?.(selected && localPath ? localPath : null);
  }, [onTargetProjectChange, localPath, selected?.provider, selected?.id]);
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
    if (!projectPath || !isGit) return setRepo(null);
    issuesApi.githubRepo(projectPath).then((r) => live && setRepo(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, isGit]);
  useEffect(() => {
    let live = true;
    // A cloud project's branches are its workspaces': nothing here to read.
    if (!localPath || !isGit) return setStatus(null);
    setStatus(null);
    api.workStatus(localPath).then((s) => live && setStatus(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, [localPath, isGit]);
  useEffect(() => {
    if (provider !== "linear" || !linear?.connected) return;
    let live = true;
    issuesApi.linearTeams().then((t) => live && setTeams(t)).catch(() => {});
    return () => {
      live = false;
    };
  }, [provider, linear?.connected]);

  // The command palette's "New issue…".
  useEffect(() => {
    if (!store.newIssueRequested) return;
    takeNewIssueRequest();
    setComposing(true);
  }, [store.newIssueRequested]);

  // The list itself. Search is debounced because GitHub runs it server-side.
  useEffect(() => {
    if (!projectPath) return;
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
        const r = await issuesApi.list(projectPath, provider, wireFilter(filter, search));
        if (live) {
          // A row changed here since the read started, or whose change the read doesn't hold yet, keeps the change;
          // it stays marked as changed until a read that has it.
          const shown = new Map(listNow.current.map((row) => [writeKey(row), row]));
          const kept = new Set<string>();
          const rows = r.map((row) => {
            const key = writeKey(row);
            const here = shown.get(key);
            if (!here || !(writes.outdated(key, started) || newerHere(row, here))) return row;
            kept.add(key);
            return keepEdits(row, here);
          });
          // An issue just created here may not be in a list read so soon after; it stays at the top until it is.
          const mine = created.current;
          const pinned = mine && mine.projectPath === projectPath && mine.issue.provider === provider && mine.filter === pinFilter ? mine.issue : null;
          if (!pinned || rows.some((row) => writeKey(row) === writeKey(pinned))) created.current = null;
          setList(created.current && pinned ? [shown.get(writeKey(pinned)) ?? pinned, ...rows] : rows);
          setListOf(`${projectPath}\n${provider}`);
          setChangedHere(kept);
        }
      } catch (e) {
        if (live) {
          setList([]);
          setListOf(`${projectPath}\n${provider}`);
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
  }, [projectPath, provider, filterAsked, search, pinFilter, linear?.connected, tick]);

  // Body on demand: GitHub lists come without it. A refresh reads the open
  // issue again as well, since its state may have moved; what is on the page
  // stays there until the answer comes.
  const shown = useRef<string | null>(null);
  const selectedAtTick = useRef(tick);
  useEffect(() => {
    const key = selected && projectPath ? `${projectPath}:${selected.provider}:${selected.id}` : null;
    const again = key != null && shown.current === key;
    shown.current = key;
    if (!again) {
      setDetail(null);
      selectedAtTick.current = tick;
    }
    if (!selected || !projectPath) return;
    // A Linear row carries its body, so it is shown while the issue is read
    // whole: what editing it needs comes only with that.
    const rowFirst = !again && selected.body != null && selected.provider === "linear" && selectedAtTick.current === tick;
    if (rowFirst) setDetail(selected);
    let live = true;
    const started = writes.readStarted();
    if (!again && !rowFirst) setDetailLoading(true);
    issuesApi
      .details(projectPath, selected.provider, selected.id)
      // Not over a status change that began or ended since the read started.
      .then((d) => live && setDetail((now) => (now && writeKey(now) === writeKey(d) && writes.outdated(writeKey(d), started) ? now : newer(now, d))))
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setDetailLoading(false));
    return () => {
      live = false;
    };
  }, [selected, projectPath, tick]);

  // The open issue's thread as the pane last read it, for the agent's prompt; named by the issue it belongs to.
  const thread = useRef<{ key: string; thread: IssueThread } | null>(null);
  const threadKey = selected && projectPath ? `${projectPath}\n${selected.provider}\n${selected.id}` : null;
  const onThread = useCallback((key: string, value: IssueThread) => {
    thread.current = { key, thread: value };
  }, []);

  const start = useCallback(async (anyway = false) => {
    const issue = detail ?? selected;
    if (!issue || !projectPath || !harness) return;
    // A warning, not a lock: the reader may start anyway.
    const busy = workToWarnAbout(work.byIssue.get(workKeyOf(issue)));
    if (!anyway && busy.length > 0) {
      setTakenBy(busy);
      return;
    }
    setTakenBy(null);
    setStarting(true);
    setError(null);
    setStartNote(null);
    try {
      // The discussion goes with the first prompt: the pane's thread when it was read, else read now, before the session exists.
      const key = `${projectPath}\n${issue.provider}\n${issue.id}`;
      const read = thread.current?.key === key ? thread.current.thread : null;
      let prompt = read ? issuePrompt(issue, read) : await issuePromptWithComments(projectPath, issue);
      if (cloud) {
        // In one of the project's workspaces: the runtime starts the session and carries it on (its pipeline).
        const plan = planCloudStart(cloud.project);
        if (plan.kind === "create") {
          setStartNote("This cloud project has no workspace to start in. Start one from the project's +, then start the issue here.");
          return;
        }
        const body = (issue as Partial<IssueDetails>).description ?? issue.body ?? null;
        await startInWorkspace(
          plan,
          {
            agent: harness.id,
            model: modelId,
            effort,
            mode,
            prompt,
            useWorktree: true,
            title: `${issue.identifier} ${issue.title}`.slice(0, 80),
            issue: {
              ref: { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
              body,
              worktreeName: issueWorktreeName(issue.identifier, issue.title),
              pipeline: pipelineDefaults.enabled,
              settings: pipelineDefaults,
            },
          },
          { onIssue: (outcome) => setStartNote(cloudIssueNote(outcome)) },
        );
        return;
      }
      const s = await api.createSession({
        projectPath,
        title: `${issue.identifier} ${issue.title}`.slice(0, 80),
        useWorktree,
        onMain: !useWorktree,
        worktreeName: isGit ? issueWorktreeName(issue.identifier, issue.title) : null,
        issue: { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
        tab: {
          harness: harness.id,
          model: modelId,
          effort,
          permissionMode: mode,
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
      setError(cloud ? cloudStartError(e, cloud.project.orgId) : errorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [detail, selected, projectPath, cloud, harness, modelId, effort, mode, useWorktree, isGit, onCreated, pipelineOffered, mergeChoice, pipelineDefaults, work.byIssue]);

  const emptyReason = useMemo(() => {
    if (!projectPath) return "Add a project to see its issues.";
    if (provider === "github") {
      if (ghOk === false) return "Issues need the GitHub CLI. Install gh and run gh auth login.";
      if (repo === null) return "Add a GitHub remote named origin to see this project's issues.";
    } else if (linear && !linear.connected) {
      return "Linear is not connected. Add an API key in Settings → Integrations.";
    }
    return null;
  }, [projectPath, provider, ghOk, repo, linear]);

  const open = (issue: Issue) => {
    setComposing(false);
    setSelected(issue);
    setStatusOpen(false);
    setAssigneeOpen(false);
    setLabelsOpen(false);
    setStartNote(null);
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
    setList((rows) => rows.map((row) => (same(row) ? { ...row, state: issue.state, stateType: issue.stateType, workflowStateType: issue.workflowStateType, updatedAt: issue.updatedAt } : row)));
    writes.touch(writeKey(issue));
    setChangedHere((keys) => new Set(keys).add(writeKey(issue)));
  };
  // An issue as a write answered with it: the open one shows it (even before its details came), and its row shows who has it now.
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const assigned = (changed: IssueDetails) => {
    const same = (issue: Issue) => issue.provider === changed.provider && issue.id === changed.id;
    setDetail((now) => (selectedNow.current && same(selectedNow.current) ? newer(now, changed) : now));
    setList((rows) => rows.map((row) => (same(row) ? { ...row, assignee: changed.assignee, assignees: changed.assignees, updatedAt: changed.updatedAt } : row)));
    writes.touch(writeKey(changed));
    setChangedHere((keys) => new Set(keys).add(writeKey(changed)));
  };
  const outOfFilter = (issue: Issue) => (changedHere.has(writeKey(issue)) ? filterMiss(issue, filter, provider, viewer?.id ?? null) : null);
  // What the tracker says of the open issue now, once that has been read; the row it was opened from until then.
  const current = detail && isOpen(detail) ? detail : selected;
  // A write answers with the issue as the provider has it now: the page and its row follow.
  const changed = useCallback((next: IssueDetails) => {
    const same = (issue: Issue | null) => !!issue && issue.provider === next.provider && issue.id === next.id;
    setDetail((now) => (same(now) ? newer(now, next) : now));
    setList((rows) => rows.map((row) => (same(row) ? { ...row, title: next.title, labels: next.labels, state: next.state, stateType: next.stateType, workflowStateType: next.workflowStateType, assignee: next.assignee, assignees: next.assignees, updatedAt: next.updatedAt } : row)));
    writes.touch(writeKey(next));
    setChangedHere((keys) => new Set(keys).add(writeKey(next)));
    const mine = created.current;
    if (mine && same(mine.issue)) created.current = { ...mine, issue: next };
  }, [writes.touch]);
  const edits = useIssueEdits(projectPath, editableIssue(current), changed);
  const projectNow = useRef(projectPath);
  projectNow.current = projectPath;
  const pinFilterNow = useRef(pinFilter);
  pinFilterNow.current = pinFilter;
  // Created: selected in the list and open beside it, ready for "Start session".
  const onIssueCreated = useCallback((projectPath: string, issue: IssueDetails) => {
    if (projectNow.current !== projectPath) return;
    created.current = { projectPath, filter: pinFilterNow.current, issue };
    setComposing(false);
    setProvider(issue.provider);
    setList((rows) => [issue, ...rows.filter((row) => writeKey(row) !== writeKey(issue))]);
    setSelected(issue);
    setDetail(issue);
    setStatusOpen(false);
  }, []);
  useEffect(() => setCopied(false), [selected?.provider, selected?.id]);
  const copyIdentifier = () => {
    if (!selected) return;
    void navigator.clipboard?.writeText(selected.identifier).then(() => setCopied(true), () => {});
  };
  // The editors are the open issue's own: a switch starts them afresh.
  const issueKey = selected ? `${projectPath}:${selected.provider}:${selected.id}` : "";
  // The session working on the issue: the pipeline's author, never its reviewer. A cloud one is its workspace's.
  const linkedSession = selected
    ? store.sessions.find((session) => session.id === pipeline?.author.sessionId) ?? store.sessions.find((session) => session.issue?.url === selected.url)
    : null;
  const openLinked = linkedSession ? () => selectSession(linkedSession.id) : pipeline?.place ? () => openCloudSession(pipeline.author.sessionId, pipeline.author.tabId) : null;

  // Who has the issue shows once that is known: from the row, or from its details.
  const assigneeShown = !!current && !!(current.assignees || current.assignee || !detailLoading);
  // Up and Down through the rows shown, the listed ones and then those below them; the row moved to takes the focus.
  const move = (by: 1 | -1) => {
    const rows = [...shownList, ...unlisted.map((each) => each.issue)];
    if (!rows.length) return;
    const at = rows.findIndex(isOpen);
    const next = at < 0 ? (by > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + by));
    if (next !== at) open(rows[next]);
    const row = root.current?.querySelector<HTMLElement>(`[data-issue-row="${writeKey(rows[next])}"]`);
    row?.focus();
    row?.scrollIntoView?.({ block: "nearest" });
  };
  const onViewKeyDown = (e: ReactKeyboardEvent) => {
    // Not while typing or composing, not for a key something inside already took, and not from a menu
    // opened out of the view (its keys reach here through React, though it is elsewhere on the page).
    if (e.defaultPrevented || e.nativeEvent.isComposing || typingIn(e.target) || !(e.target instanceof Node) || !root.current?.contains(e.target)) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      // The list's own keys: in the detail pane they scroll the issue, as anywhere else.
      if (arrowsTaken(e.target) || !(e.target === root.current || listColumn.current?.contains(e.target))) return;
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // The open issue's keys are not the new-issue form's, shown in its place.
    if (!current || !projectPath || composing) return;
    const native = e.nativeEvent;
    if (matchesShortcut(native, "issues.status")) {
      // Only an issue read whole has a picker to open, and not while a change to it is on its way.
      const capabilities = (current as Partial<IssueDetails>).capabilities;
      if (!capabilities || !(capabilities.workflowStates || capabilities.closeReasons) || writes.writing.has(writeKey(current))) return;
      e.preventDefault();
      setStatusOpen(true);
    } else if (matchesShortcut(native, "issues.assignee")) {
      // Only once the picker is on the page; it would otherwise open by itself when it came.
      if (!assigneeShown) return;
      e.preventDefault();
      setAssigneeOpen(true);
    } else if (matchesShortcut(native, "issues.labels")) {
      // The label picker needs the issue read whole.
      if (!edits.issue) return;
      e.preventDefault();
      setLabelsOpen(true);
    } else if (matchesShortcut(native, "issues.comment")) {
      // The composer's box under the comments, else the thread's last text box; without one, the thread is shown.
      const thread = detailPane.current?.querySelector<HTMLElement>('section[aria-label="Comments"]');
      if (!thread) return;
      e.preventDefault();
      const boxes = thread.querySelectorAll<HTMLTextAreaElement>("textarea");
      const box = thread.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]') ?? boxes[boxes.length - 1];
      if (box) box.focus();
      else thread.scrollIntoView?.({ block: "nearest" });
    }
  };

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
    <div ref={root} className="flex h-full min-h-0 outline-none" tabIndex={-1} onKeyDown={onViewKeyDown} data-testid="issues-view">
      <div ref={listColumn} className="@container flex min-w-0 flex-1 flex-col border-r border-hairline">
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 pt-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" className="gap-1.5">
                {cloud ? <Cloud /> : <FolderGit2 />}
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
                    setPrefs({ lastProject: p.path, issueCloudProject: null });
                    void selectProject(p.path);
                  }}
                >
                  <FolderGit2 className={cn(p.path === projectPath && "text-foreground")} />
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
              {cloudGroups.map((group) => (
                <DropdownMenuGroup key={group.orgId} aria-label={`Cloud · ${group.orgName}`}>
                  <DropdownMenuLabel>Cloud · {group.orgName}</DropdownMenuLabel>
                  {group.projects.map((p) => (
                    <DropdownMenuItem
                      key={p.key}
                      onSelect={() => {
                        setSelected(null);
                        setPrefs({ issueCloudProject: p.key });
                      }}
                    >
                      <Cloud className={cn(p.key === projectPath && "text-foreground")} />
                      <span className="truncate">{p.fullName}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Segmented<Provider>
            aria-label="Provider"
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setSelected(null);
              created.current = null;
            }}
            options={[
              { value: "github", label: "GitHub" },
              { value: "linear", label: "Linear" },
            ]}
          />
          <div className="ml-auto flex min-w-0 max-w-full items-center gap-1">
            <div className="flex h-7 min-w-0 items-center gap-1 rounded-md bg-well px-2">
              <Search className="size-3.5 text-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                aria-label="Search issues"
                className="w-28 min-w-0 bg-transparent text-xs outline-none placeholder:text-faint sm:w-36"
              />
            </div>
            {/* A narrow list column keeps the icon alone, so the toolbar stays on its side. */}
            <WithTooltip label="New issue">
              <Button variant="secondary" size="sm" className="shrink-0 gap-1" aria-label="New issue" onClick={() => setComposing(true)} disabled={!projectPath}>
                <Plus />
                <span className="hidden @lg:inline">New issue</span>
              </Button>
            </WithTooltip>
            <WithTooltip label="Refresh">
              <Button variant="ghost" size="icon-xs" aria-label="Refresh" onClick={() => setTick((t) => t + 1)}>
                {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </WithTooltip>
          </div>
        </div>
        {!emptyReason && (
          <div className="flex flex-wrap items-center gap-1 px-4 pb-2" role="toolbar" aria-label="Filter issues">
            <IssueListFilters key={filterKey ?? ""} projectPath={projectPath} provider={provider} filter={filter} onChange={setFilter} teams={provider === "linear" ? teams : []} viewer={viewer} />
            {/* Who works on them (#441): what this Mac, the reader's other machines and the team say, not the tracker. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Working: ${WORK_FILTERS.find((option) => option.value === workFilter)?.label}`} className={cn("gap-1 text-xs", workFilter !== "all" && "bg-veil-strong text-foreground")}>
                  <Users className="size-3.5" />
                  {workFilter === "all" ? "Anyone working" : workFilter === "free" ? "Nobody working" : "Only mine"}
                  <ChevronDown className="text-faint" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {WORK_FILTERS.map((option) => (
                  <DropdownMenuItem key={option.value} onSelect={() => setWorkFilter(option.value)}>
                    <Check className={cn("size-3.5", workFilter !== option.value && "invisible")} />
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {workNote && !emptyReason && <div className="px-4 pb-1.5 text-[11px] text-faint" data-testid="issues-work-note">{workNote}</div>}
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
          ) : shownList.length === 0 && !loading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              {list.length > 0 && workFilter === "free"
                ? "Someone is working on every issue listed."
                : list.length > 0 && workFilter === "mine"
                  ? "You are not working on any of these issues."
                  : filter.state === "open"
                    ? "No open issues match."
                    : "No issues match."}
            </div>
          ) : (
            <ul className="px-2 pb-4">
              {shownList.map((i) => (
                <li key={`${i.provider}:${i.id}`}>
                  <ContextMenu>
                    <ContextMenuTrigger className="block">
                      <IssueListItem
                        issue={i}
                        selected={isOpen(i)}
                        linked={linkedIssueUrls.has(i.url)}
                        outOfFilter={outOfFilter(i)}
                        pipeline={projectPath ? pipelineForIssue(pipelines, projectPath, i.url) : null}
                        work={workOf(i)}
                        now={work.now}
                        onSelect={() => open(i)}
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {cloud ? (
                        <ContextMenuItem disabled>Automations run in projects on this computer</ContextMenuItem>
                      ) : i.provider === "github" && i.labels.length > 0 ? i.labels.map((label) => (
                        <ContextMenuItem
                          key={label.name}
                          onSelect={() => setAutomationPrefill({
                            projectPath: projectPath ?? "",
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

      <div ref={detailPane} className="flex w-[46%] min-w-[18rem] max-w-[40rem] flex-col outline-none" tabIndex={-1} data-testid="issue-detail">
        {composing && projectPath ? (
          <NewIssueForm
            key={`${projectPath}\n${provider}`}
            projectPath={projectPath}
            provider={provider}
            onProviderChange={(value) => {
              setProvider(value);
              setSelected(null);
            }}
            repo={repo}
            teams={teams}
            defaultTeamId={filter.teamId}
            viewer={viewer}
            unavailable={emptyReason}
            onCreated={onIssueCreated}
            onClose={() => setComposing(false)}
          />
        ) : !selected ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-faint">Pick an issue to read it and start a session on it.</div>
        ) : (
          <>
            <div className="flex shrink-0 flex-col gap-2 border-b border-hairline px-5 pb-3 pt-4">
              <div className="flex items-baseline gap-2">
                <WithTooltip label={copied ? "Copied" : "Copy identifier"}>
                  <button
                    type="button"
                    aria-label={`Copy ${selected.identifier}`}
                    onClick={copyIdentifier}
                    className="group -mx-1 flex shrink-0 items-center gap-1 self-center rounded px-1 font-mono text-xs text-faint hover:bg-veil-raised hover:text-foreground"
                  >
                    {selected.identifier}
                    {copied ? <Check className="size-3" /> : <Copy className="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />}
                  </button>
                </WithTooltip>
                <IssueTitle key={issueKey} edits={edits} title={current?.title ?? selected.title} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {current && projectPath && (
                  <IssueStatusPicker
                    key={`status:${writeKey(current)}`}
                    projectPath={projectPath}
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
                {projectPath && current && assigneeShown && (
                  <AssigneePicker key={`${current.provider}:${current.id}`} projectPath={projectPath} issue={current} viewer={viewer} onChange={assigned} open={assigneeOpen} onOpenChange={setAssigneeOpen} />
                )}
                <button type="button" onClick={() => void openUrl(selected.url)} className="flex items-center gap-1 hover:text-foreground">
                  Open in browser <ExternalLink className="size-3" />
                </button>
              </div>
              {(edits.issue || (current?.labels.length ?? 0) > 0) && (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <IssuePriority key={issueKey} edits={edits} />
                  <IssueLabels key={issueKey} edits={edits} labels={current?.labels ?? []} open={labelsOpen} onOpenChange={setLabelsOpen} />
                </div>
              )}
              {edits.error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{edits.error}</div>}
              {current && <IssueWorkPanel workers={workOf(current) ?? []} now={work.now} />}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <SessionAgentControls selection={agentSelection} />
              </div>
              {/* Where it runs, and the buttons. The buttons take a line of their own
                  when the pane is too narrow for both, rather than sit on the words. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid="issue-start-row">
                {cloud ? (
                  <span className="flex min-w-0 flex-1 basis-56 items-center gap-1 whitespace-nowrap text-[11px] text-faint">
                    <Cloud className="size-3.5 shrink-0" />
                    in new worktree <span className="truncate font-mono text-foreground">{issueWorktreeName(selected.identifier, selected.title)}</span> of a cloud workspace
                  </span>
                ) : !isGit ? <span className="text-xs text-faint">In folder · no Git</span> : <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-[11px] text-faint">
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
                  {openLinked && (
                    <Button variant="secondary" size="sm" onClick={openLinked}>
                      Open session
                    </Button>
                  )}
                  <Button size="sm" variant="accent" disabled={starting || detailLoading || (cloud ? !harness || cloud.mayStart !== true || !cloud.project.selected : !harness?.available)} onClick={() => void start(false)}>
                    {starting ? <Loader2 className="animate-spin" /> : null}
                    Start session
                  </Button>
                </div>
              </div>
              {cloud && cloud.mayStart === false && (
                <span className="text-[11px] text-faint">Starting a session in this organization's cloud workspaces needs an owner or admin.</span>
              )}
              {cloud && cloud.mayStart !== false && !cloud.project.selected && (
                <span className="text-[11px] text-faint">This repository is no longer selected for cloud workspaces in its organization, so no session starts in them.</span>
              )}
              {startNote && (
                <p role="status" className="flex items-start gap-1.5 text-[11px] text-muted-foreground" data-testid="issue-start-note">
                  <span>{startNote}</span>
                  {cloud && cloudPlan?.kind === "create" && (
                    <button type="button" className="shrink-0 text-foreground underline-offset-2 hover:underline" onClick={() => startCloudSessionIn(cloud.project.key)}>
                      New session…
                    </button>
                  )}
                </p>
              )}
              {pipeline ? null : cloud ? (
                pipelineDefaults.enabled && (
                  <span className="text-[11px] text-faint" data-testid="issue-cloud-pipeline">
                    A pull request is opened and reviewed in the workspace when the work is done. It stops at Ready to merge, and you merge it here.
                  </span>
                )
              ) : pipelineOffered ? (
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
              {projectPath && (
                <div className="border-t border-hairline px-5 pb-5 pt-3">
                  <IssueCommentThread
                    key={threadKey}
                    projectPath={projectPath}
                    provider={selected.provider}
                    issueId={selected.id}
                    refreshKey={tick}
                    onComments={(value) => threadKey && onThread(threadKey, value)}
                    footer={(controls) => (
                      <IssueCommentComposer
                        projectPath={projectPath}
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
      {takenBy && (
        <TakenIssueDialog
          workers={takenBy}
          now={work.now}
          onStart={() => void start(true)}
          onOpen={(sessionId) => {
            setTakenBy(null);
            selectSession(sessionId);
          }}
          onCancel={() => setTakenBy(null)}
        />
      )}
    </div>
  );
}
