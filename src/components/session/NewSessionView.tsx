import { AllowNewMachines } from "@/components/cloud/AllowNewMachines";
import { ProvidersPaused } from "@/lib/hiddenProviders";
import type { CloudProviderSummary } from "@/lib/api";
import { useDictationContext } from "@/lib/dictationContext";
import { cloudPipelineSettings } from "@/lib/issuePipeline";
import { usePipelineLaunch, pipelineSettings, preparePipelineLaunch } from "@/lib/pipelineLaunch";
import { useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Check, ChevronDown, CircleDot, Cloud, FileCode2, FolderOpen, FolderGit2, GitBranch, Github, GitPullRequest, Loader2, LogoLinear, MessageCircle, X } from "@/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { DictationStatus, MicButton, NEW_SESSION_TARGET, useDictationInto, useDictationShortcuts } from "@/components/chat/Dictation";
import { insertNewLine } from "@/components/chat/Composer";
import { AttachButton, DropHint, useAttachments } from "@/components/chat/useImageAttachments";
import { AttachmentChips } from "@/components/chat/ComposerAttachments";
import { RaccoonScene } from "@/components/raccoon/Raccoon";
import { isRoleRefusal, refreshAccountRoles } from "@/lib/accountRoles";
import { api, errorMessage, type FileInput, type ImageInput, type Issue, type PullRequest } from "@/lib/api";
import { issuePromptWithComments, issueWorktreeName } from "@/lib/issueSession";
import { worktreeNameFromPrompt } from "@/lib/worktreeNames";
import { clearNewSessionPreset, createChat, createQuickChat, linkSessionIssue, refreshHarnesses, startSessionIn, startCloudSessionIn, selectProject, selectProjectInSidebar, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { useCloudModelClient } from "@/lib/cloudModels";
import { useSessionAgent } from "@/lib/useSessionAgent";
import { readinessBlock, useAgentReadinessList } from "@/lib/agentReadiness";
import { AgentSetup } from "./AgentSetup";
import { AgentMenu } from "./AgentMenu";
import { StartFromPicker, type BranchTarget, type StartFromTab } from "./StartFromPicker";
import { BaseBranchMenu } from "./BaseBranchMenu";
import { usePrMention } from "@/components/chat/usePrMention";
import { useFileMention } from "@/components/chat/useFileMention";
import { SessionOptions } from "./SessionOptions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { usePromptTextProps } from "@/lib/autocorrect";
import { openLocalProject } from "@/lib/projectStart";
import { keycaps, matchesShortcut, useKeymap } from "@/lib/shortcuts";
import { stopDictation } from "@/lib/dictation";
import { cn } from "@/lib/cn";
import { ORCHESTRATE_TITLE, orchestratePrompt, useOrchestrateOffered } from "@/lib/orchestrateStart";
import { showRunView } from "@/lib/orchestration";
import { WithTooltip } from "@/components/ui/tooltip";
import type { WorkStatus } from "@/types/session";
import { CloudCreateConfirm, cloudStartError, useCloudDraft, useCloudProjectChoices } from "./CloudNewSession";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { RunningLimitNotice } from "@/components/cloud/RunningLimitNotice";
import { AgentLoginsLink } from "@/components/cloud/AgentLoginsLink";
import { NEW_SESSION_ADMIN_REASON } from "@/lib/cloudCollab";
import { RUNNING_LIMIT_CODE, runningLimitMessage, runningLimitReached } from "@/lib/runningLimit";
import { confirmCloudCreate, planCloudStart, prepareCloudCreate, startInWorkspace, type CloudSessionRequest, type PreparedCreate } from "@/lib/cloudNewSession";

/** The first line of a setup script, with a mark when there is more, or null when none is saved. */
function setupScriptSummary(script: string | undefined): string | null {
  const lines = (script ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[0] + (lines.length > 1 ? " …" : "") : null;
}

/** The dialog's unsent prompt (see `modal`). */
let dialogDraft = "";

/**
 * Where a session is born. The box sits at the bottom, where the composer
 * will be once the session exists, so the first prompt and every follow-up
 * are typed in the same place; the raccoon keeps the empty space above.
 *
 * With `quick` it starts a quick chat instead: no project is chosen or
 * needed, so the project picker and the worktree options are not offered, and
 * the session runs in a scratch folder of its own unless the reader picks a
 * folder. `compact` is the same form in a small window.
 */
export function NewSessionView({
  onCreated,
  useWorktree: controlledUseWorktree,
  onUseWorktreeChange,
  quick: quickOverride,
  compact = false,
  modal = false,
}: {
  /** `files`: attached files besides images (PRO-290), passed only when there are any, to be stored once the session exists. */
  onCreated?: (sessionId: string, tabId: string, firstPrompt: string, images: ImageInput[], files?: FileInput[]) => void;
  useWorktree?: boolean;
  onUseWorktreeChange?: (value: boolean) => void;
  /** Start a quick chat: a session with no project. */
  quick?: boolean;
  /** Laid out for a narrow window. */
  compact?: boolean;
  /** Drawn in a dialog over a session: the card alone. */
  modal?: boolean;
}) {
  const store = useSessionStore();
  const quick = quickOverride ?? false;
  const projectless = quick || (quickOverride === undefined && store.newSessionChat);
  const defaultFolder = quick ? "Scratch folder" : "Chats folder";
  const prefs = usePrefs();
  // In the dialog, an unsent prompt outlives a stray Escape or click outside: it is there again when the dialog reopens.
  const [text, setText] = useState(() => (modal ? dialogDraft : ""));
  useEffect(() => {
    if (modal) dialogDraft = text;
  }, [modal, text]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The organization whose running limit refused the last cloud start, to offer stopping a workspace. */
  const [limitOrg, setLimitOrg] = useState<string | null>(null);
  /** The organization the last cloud start's error is about, so a missing login opens that organization's page. */
  const [errorOrg, setErrorOrg] = useState<string | null>(null);
  // A create refused because new machines are paused on these connected providers (PRO-372): a manager allows them here.
  const [pausedFor, setPausedFor] = useState<CloudProviderSummary[] | null>(null);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [localUseWorktree, setLocalUseWorktree] = useState(prefs.useWorktree);
  const ref = useRef<HTMLTextAreaElement>(null);
  const textProps = usePromptTextProps();
  const setUseWorktree = onUseWorktreeChange ?? setLocalUseWorktree;
  // A cloud project's `+` (PRO-23): the same form, run in the organization's cloud. A projectless chat is local.
  const cloudDraft = useCloudDraft();
  const cloud = projectless ? null : cloudDraft;
  /** A folder the chat runs in instead of its default directory; it does not become a project. */
  const [quickCwd, setQuickCwd] = useState<string | null>(null);
  const folderMenu = useRowMenu();
  const cloudChoices = useCloudProjectChoices();
  // Opens on a click (also one sent through the accessibility tree), not only on pointerdown or Enter.
  const projectMenu = useRowMenu();
  const [confirm, setConfirm] = useState<PreparedCreate | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  /** An existing branch, not open anywhere, to check out in the session's worktree. */
  const [checkoutBranch, setCheckoutBranch] = useState<string | null>(null);
  /** The issue the session starts from: its prompt, branch name and link. */
  const [issue, setIssue] = useState<Issue | null>(null);
  const [pullRequest, setPullRequest] = useState<PullRequest | null>(null);
  const [startFromOpen, setStartFromOpen] = useState(!!store.startFromRequest);
  /** The list Start from opens on: pull requests, or issues from the header's Issue chip. */
  const [startFromTab, setStartFromTab] = useState<StartFromTab>("prs");
  const openStartFrom = (tab: StartFromTab) => { setStartFromTab(tab); setStartFromOpen(true); };
  useEffect(() => { if (store.startFromRequest) openStartFrom("prs"); }, [store.startFromRequest]);
  const createMenu = useRowMenu();
  const [caret, setCaret] = useState(0);

  const preset = store.newSessionPreset;
  // The rail is what the reader last pointed at, so it beats the project they
  // happened to start a session in some other day; a preset beats both.
  const wanted = preset?.projectPath ?? store.selectedProject ?? prefs.lastProject;
  const project = projectless ? null : (store.projects.find((p) => p.path === wanted) ?? (preset ? null : store.projects[0]) ?? null);
  // A projectless chat cuts no worktree, whatever the folder it is pointed at.
  const isGit = projectless ? false : cloud ? true : project?.kind !== "folder";
  const useWorktree = isGit && (!!pullRequest || !!preset?.fromBranch || (controlledUseWorktree ?? localUseWorktree));
  const cloudPlan = cloud?.project && cloud.mayStart ? planCloudStart(cloud.project) : null;
  const modelClient = useCloudModelClient(cloudPlan?.kind === "reuse" && cloud?.mayStart
    ? { orgId: cloudPlan.node.item.workspace.orgId, workspaceId: cloudPlan.node.item.workspace.id } : null);
  const readiness = useAgentReadinessList(store.harnesses, !cloud);
  // Fresh local probes take precedence over discovery cached before an install or removal.
  const harnesses = store.harnesses.map((item) => {
    const state = readiness.values?.[item.id]?.state;
    return state && state !== "unknown" ? { ...item, available: state !== "missing" } : item;
  });
  // Only the agents that are installed and whose local login was found just now: a guess is not "signed in".
  const signedIn = cloud ? [] : harnesses.filter((item) => item.available && readiness.values?.[item.id]?.state === "ready");
  const setupCommand = !projectless && !cloud ? setupScriptSummary(project?.scripts?.setup) : null;
  // A project's own default account comes first (#980); a chat has none.
  const agentSelection = useSessionAgent(harnesses, !cloud, modelClient, undefined, cloud ? undefined : readiness.values, projectless || cloud ? null : project?.path ?? null);
  const { harness, modelId, effort, mode, accountId } = agentSelection;
  // Only with several accounts does a start name one; with one, the request is as it always was.
  const onAccount = accountId ? { account: accountId } : {};
  const pipelineLaunch = usePipelineLaunch(cloud?.project?.key ?? project?.path ?? null,
    cloud?.project ? cloudPipelineSettings(cloud.project.key) : pipelineSettings(project),
    projectless ? "Attach a Git project to automate this session." : !isGit || (!useWorktree && !preset?.cwd) ? "Start on a worktree branch to automate this session." : cloudPlan?.kind === "create" ? "The first cloud session starts on the base branch. Automate a worktree session after the workspace starts." : undefined,
    cloud ? "Cloud workspaces require a person to merge." : undefined,
    // A picked issue makes this a session started from an issue: switches nobody touched follow it.
    issue ? "issue" : "session");
  // Orchestrate (PRO-337): a session of a local git project can lead a run; a cloud draft, a chat or the compact window cannot.
  const orchestrateShown = useOrchestrateOffered({ local: !projectless && !cloud && !!project, git: isGit, cloud: !!cloud, quick: projectless, compact });
  /** The start in progress is an Orchestrate start. */
  const [orchestrating, setOrchestrating] = useState(false);
  // A cloud session runs the agent installed on the workspace, not on this computer.
  const available = cloud ? !!harness : (harness?.available ?? false);
  const workspace = preset?.cwd ? (store.workspaces[preset.projectPath] ?? []).find((w) => w.path === preset.cwd) ?? null : null;

  useEffect(() => {
    let cancelled = false;
    const at = preset?.cwd ?? project?.path;
    // Never a local path for a cloud draft.
    if (!at || !isGit || cloud) return setStatus(null);
    api.workStatus(at).then((s) => !cancelled && setStatus(s)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, preset, isGit, cloud]);

  useEffect(() => {
    let cancelled = false;
    if (!project || preset?.cwd || !useWorktree || cloud) {
      setWorkspaceName(null);
      return;
    }
    setWorkspaceName(null);
    api
      .previewWorkspaceName(project.path)
      .then((name) => !cancelled && setWorkspaceName(name))
      .catch((cause) => !cancelled && setError(errorMessage(cause)));
    return () => {
      cancelled = true;
    };
  }, [project?.path, preset?.cwd, useWorktree, !!cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  /** An issue names the branch after itself, as a session started from the Issues list does. */
  const pickIssue = (picked: Issue) => {
    setIssue(picked);
    setPullRequest(null);
    if (!project || preset?.cwd || !useWorktree) return;
    api
      .previewWorkspaceName(project.path, issueWorktreeName(picked.identifier, picked.title))
      .then(setWorkspaceName)
      .catch((cause) => setError(errorMessage(cause)));
  };
  const clearIssue = () => {
    setIssue(null);
    if (!project || preset?.cwd || !useWorktree) return;
    api.previewWorkspaceName(project.path).then(setWorkspaceName).catch(() => {});
  };
  // Another project's issue means nothing here.
  useEffect(() => {
    setIssue(null);
    setCheckoutBranch(null);
    setPullRequest(null);
  }, [project?.path, !!cloud, projectless]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickBranch = (next: BranchTarget) => {
    if (!project) return;
    setPullRequest(null);
    setCheckoutBranch(next.kind === "existing" ? next.branch : null);
    if (next.kind === "open" && next.cwd !== project.path) return startSessionIn(project.path, next.cwd);
    startSessionIn(project.path, null, next.kind === "new" ? preset?.fromBranch : undefined);
    setUseWorktree(next.kind !== "open");
  };

  const pickPr = (pr: PullRequest) => {
    clearNewSessionPreset();
    setCheckoutBranch(null);
    setIssue(null);
    setUseWorktree(true);
    setPullRequest(pr);
  };
  const prMention = usePrMention(!cloud && !projectless && isGit && !busy ? project?.path ?? null : null, text, caret, setText, ref, setCaret, { floating: true });
  // `@` names a file of the folder the session will work in; a cloud draft or a chat with no folder has none to list here.
  const fileMention = useFileMention(!cloud && !busy ? (projectless ? quickCwd : preset?.cwd ?? project?.path ?? null) : null, text, caret, setText, ref, setCaret);
  /** What Start from picked, shown as a chip in the header; `clear` goes back to a new branch. */
  const picked = pullRequest
    ? { testId: "picked-pr", icon: <GitPullRequest className="size-[13px] shrink-0" aria-hidden />, text: `#${pullRequest.number} ${pullRequest.title}`, remove: "Remove pull request", clear: () => setPullRequest(null) }
    : issue
      ? { testId: "picked-issue", icon: issue.provider === "github" ? <Github className="size-[13px] shrink-0" aria-hidden /> : <LogoLinear className="size-[13px] shrink-0" aria-hidden />, text: `${issue.identifier} ${issue.title}`, remove: "Remove issue", clear: clearIssue }
      : checkoutBranch
        ? { testId: "picked-branch", icon: <GitBranch className="size-[13px] shrink-0" aria-hidden />, text: checkoutBranch, remove: "Remove branch", clear: () => pickBranch({ kind: "new" }) }
        : null;

  const pickProject = async () => {
    try {
      await openLocalProject();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const dictationContext = useDictationContext(NEW_SESSION_TARGET, cloud ? undefined : preset?.cwd ?? project?.path ?? quickCwd ?? undefined, !!cloud, text);
  const dictation = useDictationInto(NEW_SESSION_TARGET, text, setText, ref, dictationContext);
  useDictationShortcuts(dictation);
  const keymap = useKeymap();
  const sendKeys = keymap["composer.send"][0];
  const attach = useAttachments({ textareaRef: ref, draft: text, onDraftChange: setText });
  // Refused chips are never sent, and alone make no prompt.
  const hasImages = attach.images.length + attach.files.length > 0;

  // A screenshot or a file alone is a prompt, as it is in the session composer.
  const canSend = useMemo(
    () =>
      cloud
        ? !!cloud.project && !!harness && text.trim().length > 0 && !hasImages && !busy && !confirm && cloud.project.selected && cloud.mayStart === true
        : projectless
          ? !!harness && available && (text.trim().length > 0 || hasImages) && !busy
          : !!project && !!harness && available && (text.trim().length > 0 || hasImages || !!issue || !!pullRequest) && (!useWorktree || !!preset?.cwd || !!workspaceName) && !busy && !prMention.attaching,
    [cloud, projectless, project, harness, available, text, hasImages, issue, pullRequest, useWorktree, preset?.cwd, workspaceName, busy, prMention.attaching, confirm],
  );

  const cloudRequest = (): CloudSessionRequest => ({
    agent: harness!.id,
    model: modelId,
    effort,
    mode,
    prompt: text,
    useWorktree,
    ...(pipelineLaunch.value.resolveConflicts ? { pipeline: pipelineLaunch.value, pipelineSettings: pipelineLaunch.settings } : {}),
  });

  /**
   * A cloud start's error. At the running limit (the server's code, or the
   * quota pre-check while the list shows running slots full), say how many
   * run and offer to stop one.
   */
  const showCloudError = (e: unknown, orgId: string) => {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : null;
    const atRunningLimit = code === RUNNING_LIMIT_CODE || (code === "cloud_workspace_quota_exceeded" && runningLimitReached(orgId));
    setLimitOrg(atRunningLimit ? orgId : null);
    setErrorOrg(orgId);
    setPausedFor(e instanceof ProvidersPaused ? e.providers : null);
    setError(atRunningLimit ? runningLimitMessage(orgId) : cloudStartError(e, orgId));
    // Refused for lack of role: read the roles again, so the form and the menus stop offering it.
    if (isRoleRefusal(e)) void refreshAccountRoles(true);
  };

  /** Start in the cloud: reuse or wake a workspace of the project, or prepare a new one for confirmation. */
  const createCloud = async () => {
    if (!cloud?.project || !harness || !canSend) return;
    if (dictation.dictating) await stopDictation();
    setBusy(true);
    setError(null);
    setLimitOrg(null);
    setPausedFor(null);
    const plan = planCloudStart(cloud.project);
    try {
      if (plan.kind === "create") {
        setStarting("Checking your organization's limits…");
        setConfirm(await prepareCloudCreate(cloud.project, cloudRequest()));
      } else {
        setStarting(plan.kind === "wake" ? `Resuming ${plan.node.item.workspace.name}…` : "Starting the session…");
        await startInWorkspace(plan, cloudRequest());
        setText("");
      }
    } catch (e) {
      showCloudError(e, cloud.project.orgId);
    } finally {
      setStarting(null);
      setBusy(false);
    }
  };

  const confirmCreate = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    setLimitOrg(null);
    setStarting("Creating the workspace…");
    try {
      await confirmCloudCreate(confirm);
      setConfirm(null);
      setText("");
      setStarting("Starting the workspace. The session opens when its agent is running.");
    } catch (e) {
      showCloudError(e, confirm.orgId);
      setStarting(null);
    } finally {
      setBusy(false);
    }
  };

  const pickQuickFolder = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Choose a folder for this chat" });
      if (typeof dir === "string") setQuickCwd(dir);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /** Share the composer without changing ordinary chats into disposable quick chats. */
  const createProjectless = async () => {
    if (!harness || !canSend) return;
    if (dictation.dictating) await stopDictation();
    setBusy(true);
    setError(null);
    try {
      const checked = await readiness.refreshAgent(harness.id);
      const blocked = checked && readinessBlock(harness.name, checked);
      if (blocked) { setError(blocked); return; }
      const title = text.trim().split("\n")[0].slice(0, 60);
      const images = attach.images;
      const files = attach.files;
      const s = await (quick ? createQuickChat : createChat)({ title, cwd: quickCwd, ...(store.newSessionSectionId ? { sectionId: store.newSessionSectionId } : {}), tab: { harness: harness.id, model: modelId, effort, permissionMode: mode }, ...onAccount });
      setText("");
      attach.clear();
      setQuickCwd(null);
      selectSession(s.id);
      if (files.length) onCreated?.(s.id, s.tabs[0].id, text, images, files);
      else onCreated?.(s.id, s.tabs[0].id, text, images);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async (orchestrateAsked = false) => {
    if (projectless) return createProjectless();
    if (cloud) return createCloud();
    if (!project || !harness || !canSend) return;
    const orchestrate = orchestrateAsked && orchestrateShown;
    if (dictation.dictating) await stopDictation();
    setOrchestrating(orchestrate);
    setBusy(true);
    setError(null);
    try {
      const checked = await readiness.refreshAgent(harness.id);
      const blocked = checked && readinessBlock(harness.name, checked);
      if (blocked) { setError(blocked); return; }
      // The backend names an untitled session itself, so an image-only prompt
      // sends an empty title rather than inventing one here.
      const title = (text.trim().split("\n")[0] || issue?.title || pullRequest?.title || "").slice(0, 60);
      const images = attach.images;
      const files = attach.files;
      // Named for the work: the issue's name when there is one, else the prompt's words; the drawn name when they say nothing.
      // An existing branch's worktree is named after the branch.
      const named = pullRequest ? `pr-${pullRequest.number}-${pullRequest.title}` : checkoutBranch ? (checkoutBranch.split("/").pop() ?? "") : !preset?.cwd && useWorktree && !issue ? worktreeNameFromPrompt(text) : "";
      const worktreeName = named ? await api.previewWorkspaceName(project.path, named).catch(() => workspaceName) : workspaceName;
      const s = await api.createSession({
        ...(store.newSessionSectionId ? { sectionId: store.newSessionSectionId } : {}),
        projectPath: project.path,
        title,
        useWorktree: preset?.cwd ? false : useWorktree,
        onMain: !preset?.cwd && !useWorktree,
        worktreeName: !preset?.cwd && useWorktree ? worktreeName : null,
        checkoutBranch: !preset?.cwd && useWorktree ? checkoutBranch : null,
        ...(pullRequest ? { checkoutPr: pullRequest.number } : {}),
        baseRef: !preset?.cwd && useWorktree ? preset?.fromBranch ?? null : null,
        cwd: preset?.cwd ?? null,
        tab: { harness: harness.id, model: modelId, effort, permissionMode: mode },
        ...onAccount,
        // Any run it leads waits for the person's Approve, whatever the project's setting.
        ...(orchestrate ? { orchestrate: true } : {}),
      });
      upsertSession(s);
      let first = pullRequest ? [text.trim(), `Continue work on pull request #${pullRequest.number}: ${pullRequest.title}\n${pullRequest.url}`].filter(Boolean).join("\n\n") : text;
      if (issue) {
        const ref = { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url };
        // The link is a convenience; a session that could not be linked still starts.
        await linkSessionIssue(s.id, ref).catch((cause) => console.error("the new session was not linked to its issue", cause));
        first = [text.trim(), await issuePromptWithComments(project.path, issue)].filter(Boolean).join("\n\n");
      }
      const launched = await preparePipelineLaunch(s.id, s.tabs[0].id, first, pipelineLaunch.value);
      // The plan-a-run request ends the first prompt, and the session opens on its Run tab.
      const prompt = orchestrate ? orchestratePrompt(launched) : launched;
      if (orchestrate) showRunView(s.id, true);
      setText("");
      setIssue(null);
      attach.clear();
      selectSession(s.id);
      if (files.length) onCreated?.(s.id, s.tabs[0].id, prompt, images, files);
      else onCreated?.(s.id, s.tabs[0].id, prompt, images);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const projectButton = "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground transition-colors hover:bg-veil-raised";
  const chip = "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-veil-raised hover:text-foreground disabled:opacity-50";
  const createLabel = projectless ? "Ask" : "Create";
  const localGit = !projectless && !cloud && isGit && !!project;
  const branchInfo = projectless ? null : cloud ? (
    <span className="flex min-w-0 items-center gap-1.5 truncate px-2 text-[12.5px] text-muted-foreground" data-testid="cloud-runs-in" title="The agent, its terminals and its files run on a cloud workspace of the organization, not on this computer.">
      <Cloud className="size-3.5 shrink-0" /> {cloud.orgName} cloud
    </span>
  ) : !isGit ? (
    <span className="flex items-center gap-1.5 px-2 text-[12.5px] text-muted-foreground" title="Agents, terminals, and files are available. Git features require a repository.">
      <FolderOpen className="size-3.5" /> No Git
    </span>
  ) : preset?.cwd ? (
    <span className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate font-mono">{workspace?.name ?? preset.cwd.split("/").pop()}</span>
    </span>
  ) : useWorktree ? (
    <span className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground" title={`Works on a new branch of its own, made from ${preset?.fromBranch ?? status?.defaultBranch ?? "the default branch"}, so it never touches your other work.`}>
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate">New branch</span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate font-mono">{status?.branch ?? "current branch"}</span>
    </span>
  );

  return (
    <div className={cn("flex min-h-0 flex-col", !modal && "h-full")} data-quick-start={quick ? "" : undefined}>
      <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center", !modal && "overflow-y-auto", modal ? "" : compact ? "p-3" : "px-6 py-8")}>
        <div className="w-full max-w-[720px]">
          {/* The scene needs room a small window does not have. */}
          {!compact && !modal && <RaccoonScene className="mb-1" />}
          <DictationStatus dictation={dictation} />
          {!cloud && (
            <div className="mb-3 space-y-2 empty:hidden">
              {(harness ? [harness] : store.harnesses).map((item) => (
                <AgentSetup newSession key={item.id} harness={item} value={readiness.values?.[item.id] ?? null} checking={readiness.checking || busy} onRefresh={() => {
                  void Promise.all([readiness.refresh(), refreshHarnesses()]).catch(() => setError("Could not re-check installed agents. Try again."));
                }} />
              ))}
            </div>
          )}
          {cloud && confirm && (
            <CloudCreateConfirm prepared={confirm} orgName={cloud.orgName} busy={busy} onConfirm={() => void confirmCreate()} onCancel={() => setConfirm(null)} />
          )}

          {/* Everything the form says is drawn inside this box: over a dimmed session there is nothing behind it to read text against. */}
          <div className={cn("relative overflow-hidden rounded-[12px] bg-composer shadow-surface hairline", modal && "border border-border shadow-2xl", attach.dragging && "ring-2 ring-accent/60")} data-composer-box {...attach.dropZoneProps}>
            <DropHint dragging={attach.dragging} />

            <div className="flex h-11 items-center gap-1 border-b border-hairline px-3" data-testid="new-session-header">
              {projectless ? (
                <DropdownMenu {...folderMenu.root}>
                  <DropdownMenuTrigger asChild {...folderMenu.trigger}>
                    <button type="button" className={projectButton} title={quickCwd ?? (quick ? "A scratch folder made for this chat" : "The shared folder for ordinary chats")} aria-label="Working directory">
                      {quickCwd ? <FolderOpen className="size-[13px] text-muted-foreground" /> : <MessageCircle className="size-[13px] text-muted-foreground" />}
                      <span className="truncate">{quickCwd ? (quickCwd.replace(/\/+$/, "").split("/").pop() || quickCwd) : defaultFolder}</span>
                      <ChevronDown className="size-3 shrink-0 text-faint" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-w-[18rem]">
                    <DropdownMenuLabel>Runs in</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => setQuickCwd(null)}>
                      <MessageCircle />
                      <span>{defaultFolder}</span>
                      <span className="ml-auto pl-3 text-[11px] text-faint">default</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void pickQuickFolder()}>
                      <FolderOpen />
                      <span>Choose folder…</span>
                    </DropdownMenuItem>
                    <div role="note" className="px-2 pb-1 pt-1 text-[11px] leading-snug text-muted-foreground">
                      A folder you choose is used as it is. It is not added as a project.
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <DropdownMenu {...projectMenu.root}>
                  <DropdownMenuTrigger asChild {...projectMenu.trigger}>
                    <button type="button" className={projectButton} data-testid="project-chip">
                      {cloud ? <Cloud className="size-[13px] shrink-0 text-muted-foreground" /> : isGit ? <FolderGit2 className="size-[13px] shrink-0 text-muted-foreground" /> : <FolderOpen className="size-[13px] shrink-0 text-muted-foreground" />}
                      <span className="truncate">{cloud ? (cloud.project?.fullName ?? "Cloud project") : (project?.name ?? "Choose project")}</span>
                      <ChevronDown className="size-3 shrink-0 text-faint" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {/* A heading only over something: no "Local" above nothing when there are no local projects. */}
                    {store.projects.length > 0 && <DropdownMenuLabel>{cloudChoices.length ? "Local" : "Projects"}</DropdownMenuLabel>}
                    {store.projects.map((p) => (
                      <DropdownMenuItem
                        key={p.path}
                        onSelect={() => {
                          clearNewSessionPreset();
                          setPrefs({ lastProject: p.path });
                          selectProjectInSidebar(p.path);
                          void selectProject(p.path);
                        }}
                      >
                        {p.kind === "folder" ? <FolderOpen /> : <FolderGit2 className={cn(p.path === project?.path && "text-foreground")} />}
                        <span className="truncate">{p.name}</span>
                      </DropdownMenuItem>
                    ))}
                    {cloudChoices.map((section, index) => (
                      <DropdownMenuGroup key={section.orgId} aria-label={`${section.orgName} cloud projects`}>
                        {(index > 0 || store.projects.length > 0) && <DropdownMenuSeparator />}
                        <DropdownMenuLabel>{section.orgName} cloud</DropdownMenuLabel>
                        {/* A member's cloud projects are listed but not startable: the server keeps new cloud sessions for owners and admins. */}
                        {section.mayStart === false && (
                          // Helper text, not a section header: sentence case, as the reason reads everywhere else.
                          <div role="note" className="max-w-64 px-2 pb-1 text-[11px] leading-snug text-muted-foreground" data-testid="cloud-start-locked">
                            {NEW_SESSION_ADMIN_REASON}.
                          </div>
                        )}
                        {section.projects.map((choice) => (
                          <DropdownMenuItem
                            key={choice.key}
                            disabled={!choice.selected || section.mayStart !== true}
                            title={section.mayStart === false ? NEW_SESSION_ADMIN_REASON : undefined}
                            onSelect={() => startCloudSessionIn(choice.key)}
                          >
                            <Cloud className={cn(choice.key === cloud?.project?.key && "text-foreground")} />
                            <span className="truncate">{choice.fullName}</span>
                            {choice.blank && <span className="ml-auto pl-3 text-[11px] text-faint">no repo</span>}
                          </DropdownMenuItem>
                        ))}
                        {section.projects.length === 0 && <DropdownMenuItem disabled>No cloud projects yet</DropdownMenuItem>}
                      </DropdownMenuGroup>
                    ))}
                    {(store.projects.length > 0 || cloudChoices.length > 0) && <DropdownMenuSeparator />}
                    <DropdownMenuItem onSelect={pickProject}>Add a project…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {/* A new worktree's branch is made from a base the reader can change; anything else names the checkout it uses. */}
              {localGit && project && !preset?.cwd && useWorktree && !pullRequest && !checkoutBranch ? (
                <BaseBranchMenu
                  projectPath={project.path}
                  value={preset?.fromBranch ?? status?.defaultBranch ?? "main"}
                  defaultBranch={status?.defaultBranch ?? "main"}
                  onChange={(branch) => startSessionIn(project.path, null, branch)}
                  disabled={busy}
                />
              ) : localGit && (pullRequest || checkoutBranch) ? null : (
                branchInfo
              )}
              {!projectless && isGit && !preset?.cwd && (
                <SessionOptions
                  chip={useWorktree ? "New worktree" : "Current checkout"}
                  useWorktree={useWorktree}
                  // A pull request or an existing branch is checked out in a worktree of its own; there is no other way to start from one.
                  onUseWorktreeChange={cloud ? setUseWorktree : project && !pullRequest && !checkoutBranch ? (on) => pickBranch(on ? { kind: "new" } : { kind: "open", cwd: project.path }) : undefined}
                  switchLabel={cloud ? "New worktree on the cloud workspace" : undefined}
                  worktreeLabel={cloud ? "New worktree on the workspace" : `New branch from ${preset?.fromBranch ?? status?.defaultBranch ?? "the default branch"}`}
                  currentBranch={cloud ? "the workspace's checkout" : (status?.branch ?? "the current branch")}
                  pipeline={pipelineLaunch}
                />
              )}
              {!projectless && isGit && preset?.cwd && <SessionOptions pipeline={pipelineLaunch} />}
              {localGit && project && !issue && (
                <button type="button" className={cn(chip, startFromOpen && startFromTab === "issues" && "bg-veil-raised text-foreground")} disabled={busy} data-testid="issue-chip" title="Start from an issue" onClick={() => openStartFrom("issues")}>
                  <CircleDot className="size-[13px]" aria-hidden />
                  Issue
                  <ChevronDown className="size-3 text-faint" aria-hidden />
                </button>
              )}
              {localGit && project && (
                <div className="ml-auto flex min-w-0 items-center">
                  <StartFromPicker
                    projectPath={project.path}
                    defaultBranch={preset?.fromBranch ?? status?.defaultBranch ?? "main"}
                    initialTab={startFromTab}
                    open={startFromOpen}
                    onOpenChange={setStartFromOpen}
                    onBranch={pickBranch}
                    onIssue={pickIssue}
                    onPr={pickPr}
                    onSession={selectSession}
                    disabled={busy}
                    picked={
                      picked ? (
                        <div className="flex h-7 min-w-0 max-w-[17rem] items-center rounded-md bg-info/10 text-[12.5px] text-info" data-start-pick data-testid={picked.testId}>
                          <button type="button" aria-label="Start from" title={picked.text} disabled={busy} onClick={() => openStartFrom("prs")} className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md pl-2 pr-1 hover:bg-info/10">
                            {picked.icon}
                            <span className="min-w-0 truncate">{picked.text}</span>
                          </button>
                          <button type="button" aria-label={picked.remove} disabled={busy} onClick={picked.clear} className="flex h-full shrink-0 items-center rounded-r-md pl-1 pr-1.5 hover:bg-info/10">
                            <X className="size-3" aria-hidden />
                          </button>
                        </div>
                      ) : undefined
                    }
                  />
                </div>
              )}
            </div>

            <div className="relative px-4 pb-4 pt-4">
              {prMention.menu}
              {fileMention.menu}
              <AttachmentChips attach={attach} />
              <textarea
                ref={ref}
                autoFocus
                data-new-session-prompt
                {...textProps}
                value={text}
                onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (prMention.onKeyDown(e) || fileMention.onKeyDown(e)) return;
                  // Escape takes back what Start from picked before it closes the form.
                  if (e.key === "Escape" && picked && !busy) {
                    e.preventDefault();
                    e.stopPropagation();
                    picked.clear();
                    return;
                  }
                  if (matchesShortcut(e.nativeEvent, "composer.send")) {
                    e.preventDefault();
                    void create();
                  } else if (matchesShortcut(e.nativeEvent, "composer.newLine") && e.key !== "Enter") {
                    e.preventDefault();
                    insertNewLine(e.currentTarget);
                  }
                }}
                rows={compact ? 3 : 5}
                placeholder={
                  projectless
                    ? "Ask anything"
                    : !project && !cloud
                      ? "Add a project to get started"
                      : issue
                        ? "Add notes for the agent (optional)"
                        : "What do you want to work on?"
                }
                className="block w-full resize-none bg-transparent text-[14px] leading-6 outline-none placeholder:text-faint"
              />
              {setupCommand && (
                <p className="mt-3 flex min-w-0 items-center gap-2 pb-2 text-xs text-muted-foreground" data-testid="setup-script-line">
                  <FileCode2 className="size-[13px] shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">
                    Setup script found · <code className="font-mono text-foreground">{setupCommand}</code> runs by itself in each new worktree, without asking
                  </span>
                </p>
              )}
            </div>

            <div className="flex items-center gap-1 px-2.5 pb-2.5">
              <AgentMenu split selection={agentSelection} disabled={busy} />
              {!cloud && harness && !available && (
                <span className="min-w-0 truncate text-xs text-warning" title={harness.installHint}>
                  {harness.name} isn't installed
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                {!cloud && (projectless ? !!quickCwd : !!project) && (
                  <WithTooltip label="Mention a file" side="top">
                    <Button variant="ghost" size="icon-sm" aria-label="Mention a file" disabled={busy} onClick={fileMention.start}>
                      <AtSign />
                    </Button>
                  </WithTooltip>
                )}
                {!cloud && <AttachButton attach={attach} />}
                <MicButton dictation={dictation} />
                {/* One button in two parts: Create, and the other ways to start behind the chevron. */}
                <div className={cn("ml-1.5 flex h-8 items-stretch overflow-hidden rounded-md", canSend ? "bg-accent text-accent-foreground shadow-button" : "bg-veil-strong text-muted-foreground")} data-testid="create-button">
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={() => void create()}
                    aria-label={createLabel}
                    title={sendKeys ? `${createLabel} (${keycaps(sendKeys).join("")})` : createLabel}
                    className="flex items-center gap-2 px-3 text-[12.5px] font-semibold transition-colors enabled:hover:bg-black/10 [&_svg]:size-3.5"
                  >
                    {busy && !orchestrating ? <Loader2 className="animate-spin" /> : null}
                    {createLabel}
                    {sendKeys && !busy && <span className="rounded border border-current/30 px-1 font-sans text-[11px] font-medium leading-4">{keycaps(sendKeys).join("")}</span>}
                  </button>
                  {orchestrateShown && (
                    <DropdownMenu {...createMenu.root}>
                      <DropdownMenuTrigger asChild {...createMenu.trigger}>
                        <button type="button" disabled={!canSend} aria-label="More ways to create" className="flex items-center border-l border-black/15 px-1.5 transition-colors enabled:hover:bg-black/10">
                          {busy && orchestrating ? <Loader2 className="size-[13px] animate-spin" /> : <ChevronDown className="size-[13px]" aria-hidden />}
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="max-w-[20rem]">
                        <DropdownMenuItem onSelect={() => void create()}>
                          <span>Create</span>
                          {sendKeys && <span className="ml-auto pl-3 text-[11px] text-faint">{keycaps(sendKeys).join("")}</span>}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void create(true)} className="flex-col items-start gap-0">
                          <span>Orchestrate</span>
                          <span className="whitespace-normal text-[11px] leading-snug text-faint">{ORCHESTRATE_TITLE}</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            </div>

            {/* What stands in the way of a start, said in the box, above its footer. */}
            <div className="space-y-2 px-4 pb-3 empty:hidden" data-testid="new-session-notices">
              {!cloud && !projectless && preset && !project && <p role="alert" className="text-xs text-destructive">The requested project is no longer attached. Add it again or choose a project before sending.</p>}
              {!cloud && !harness && <p role="status" className="text-xs text-muted-foreground">{readiness.checking ? "Checking agents…" : "Sign in to an agent to start a chat. Your draft is kept."}</p>}
              {cloud && starting && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" data-testid="cloud-start-status">
                  {busy && <Loader2 className="size-3.5 animate-spin" />} {starting}
                </div>
              )}
              {!cloud && harness && !available && (
                <p className="text-xs text-muted-foreground">
                  {harness.installable ? <>Install it with <span className="font-medium text-foreground">Install and sign in</span> above, or run </> : "Install it with "}
                  <code className="font-mono">{harness.installHint}</code>
                </p>
              )}
              {/* Reached with a role that changed meanwhile (demoted while drafting): Create is off, with the reason. */}
              {cloud && cloud.mayStart === false && (
                <div className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning" role="note" data-testid="cloud-start-locked">
                  {NEW_SESSION_ADMIN_REASON}
                </div>
              )}
              {error && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error} <AgentLoginsLink message={error} organizationId={errorOrg} className="ml-1 align-baseline text-foreground" />
                </div>
              )}
              {cloud && error && limitOrg && <RunningLimitNotice orgId={limitOrg} />}
              {cloud && error && pausedFor && (
                <AllowNewMachines
                  providers={pausedFor}
                  onAllowed={() => {
                    setPausedFor(null);
                    setError(null);
                    void createCloud();
                  }}
                />
              )}
            </div>

            {!cloud && (
              <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-hairline px-4 py-1.5 text-[11.5px] text-faint" data-testid="new-session-footer">
                {signedIn.map((item) => (
                  <span key={item.id} className="flex items-center gap-1 whitespace-nowrap" data-testid="agent-signed-in"><Check className="size-3 text-add" aria-hidden />{item.name} signed in</span>
                ))}
                <p className="ml-auto whitespace-nowrap">Nothing starts until you press {createLabel}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
