import { openUrl } from "@tauri-apps/plugin-opener";
import { AllowNewMachines } from "@/components/cloud/AllowNewMachines";
import { useDataPrivacy } from "@/lib/dataPrivacy";
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
import { useAccount } from "@/lib/account";
import { api, errorMessage, experimental, type FileInput, type ImageInput, type Issue, type PullRequest } from "@/lib/api";
import { issuePrompt, issuePromptWithComments, issueWorktreeName } from "@/lib/issueSession";
import { worktreeNameFromPrompt } from "@/lib/worktreeNames";
import { clearNewSessionPreset, createChat, createQuickChat, linkSessionIssue, refreshHarnesses, runNewSessionHere, startSessionIn, startCloudSessionIn, selectProject, selectProjectInSidebar, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { useCloudModelClient } from "@/lib/cloudModels";
import { useSessionAgent } from "@/lib/useSessionAgent";
import { readinessBlock, useAgentReadinessList } from "@/lib/agentReadiness";
import { AgentSetupNotice } from "./AgentSetup";
import { AgentMenu } from "./AgentMenu";
import { StartFromPicker, type BranchTarget, type StartFromTab } from "./StartFromPicker";
import { BaseBranchMenu } from "./BaseBranchMenu";
import { usePrMention } from "@/components/chat/usePrMention";
import { useFileMention } from "@/components/chat/useFileMention";
import { SessionOptions } from "./SessionOptions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { usePromptTextProps } from "@/lib/autocorrect";
import { openLocalProject } from "@/lib/projectStart";
import { keycaps, matchesShortcut, useKeymap, joinKeycaps } from "@/lib/shortcuts";
import { stopDictation } from "@/lib/dictation";
import { cn } from "@/lib/cn";
import { ORCHESTRATE_TITLE, orchestratePrompt, useOrchestrateOffered } from "@/lib/orchestrateStart";
import { showRunView } from "@/lib/orchestration";
import { WithTooltip } from "@/components/ui/tooltip";
import type { WorkStatus } from "@/types/session";
import { cloudPlacementError, cloudStartError, quoteText, useCloudDraft, useCloudIdleOptions, useCloudProjectChoices } from "./CloudNewSession";
import { CloudStartSession, useCloudStart } from "./CloudStartSession";
import { IdleSuspendSelect } from "@/components/cloud/IdleSuspendSelect";
import { initialIdleSuspend } from "@/lib/idleSuspend";
import { findCloudWorkspace, useCloudCatalog } from "@/lib/cloudCatalog";
import { PHASES, failureMessage, isClientError, phaseOf } from "@/lib/cloudCreate";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { RunningLimitNotice } from "@/components/cloud/RunningLimitNotice";
import { AgentLoginsLink } from "@/components/cloud/AgentLoginsLink";
import { NEW_SESSION_ADMIN_REASON } from "@/lib/cloudCollab";
import { RUNNING_LIMIT_CODE, runningLimitMessage, runningLimitReached } from "@/lib/runningLimit";
import { confirmCloudCreate, planCloudStart, prepareCloudCreate, sessionPlacementReady, startInWorkspace, type CloudCreatePlacement, type CloudSessionRequest, type PreparedCreate } from "@/lib/cloudNewSession";
import { CloudPlacementChips, CloudPlacementReadiness, useCloudPlacement, type PlacementChoice } from "./CloudPlacement";
import { WorkspaceRpcError } from "@terminalx/portable/workspace";
import { refreshPairedMachines, useMachineConnections } from "@/lib/machineConnections";
import { CreateAttempt, agentSignIn, createMachineSession } from "@/lib/machineNewSession";
import { AddMachineDialog } from "@/components/machines/AddMachineDialog";
import { MachineBranchMenu, MachineFormLine, MachineProjectMenu, WhereMenu, takeNewSessionSeed, useMachineDraft, useNewSessionSeed, type CloudWhere } from "./MachineNewSession";

/** Why a create on a machine did not happen, in words; a lost answer says pressing Create again is safe. */
export function machineStartError(error: unknown, name: string): string {
  if (error instanceof WorkspaceRpcError) {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    return message ? message.slice(0, 300) : `${name} refused the new session (${error.code}).`;
  }
  return `${name} stopped answering before it confirmed the session. Press Create again: it does not start a second one.`;
}

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
  // A machine chosen in "Where it runs" (PRO-348): the same form, run on that machine.
  // The menu is offered once a machine is paired; until then the form is as it was before Machines (PRO-360).
  const machinesPaired = useMachineConnections().machines.length > 0;
  const localWanted = store.newSessionPreset?.projectPath ?? store.selectedProject ?? prefs.lastProject;
  const machineDraft = useMachineDraft(store.harnesses, store.projects.find((p) => p.path === localWanted)?.name ?? null);
  const machine = projectless ? null : machineDraft;
  const cloud = projectless || machine ? null : cloudDraft;
  const [addingMachine, setAddingMachine] = useState(false);
  /** The branch a machine session's worktree is cut from; null is its project's default. */
  const [machineBase, setMachineBase] = useState<string | null>(null);
  /** The create's idempotency id, kept across a Create pressed again after a lost answer. */
  const [machineAttempt] = useState(() => new CreateAttempt(() => crypto.randomUUID()));
  const machineKey = machine ? `${machine.machineId}:${machine.project?.projectId ?? ""}` : null;
  useEffect(() => {
    // Another machine or project, or This Mac again: nothing of the last one carries over.
    setMachineBase(null);
    machineAttempt.reset();
  }, [machineKey, machineAttempt]);
  // An issue's start or a handoff opened the form on a machine with something in it: taken once.
  const seed = useNewSessionSeed();
  const [issueSource, setIssueSource] = useState<string | null>(null);
  /** A folder the chat runs in instead of its default directory; it does not become a project. */
  const [quickCwd, setQuickCwd] = useState<string | null>(null);
  const folderMenu = useRowMenu();
  const cloudChoices = useCloudProjectChoices();
  // Opens on a click (also one sent through the accessibility tree), not only on pointerdown or Enter.
  const projectMenu = useRowMenu();
  /**
   * A create whose outcome is not known (the server stopped answering): the
   * next Create resends this exact request, so its key cannot make a second
   * workspace (PRO-409).
   */
  const unsettledCreate = useRef<PreparedCreate | null>(null);
  /** The workspace Create just made: the form stays busy until its first session opens or its start fails. */
  const [launching, setLaunching] = useState<{ orgId: string; workspaceId: string; projectKey: string } | null>(null);
  const launchSeen = useRef(false);
  const catalog = useCloudCatalog();
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
  const isGit = projectless ? false : machine ? machine.project?.kind !== "folder" : cloud ? true : project?.kind !== "folder";
  // On a machine a session always gets a new worktree beside its project there.
  const useWorktree = isGit && (!!machine || !!pullRequest || !!preset?.fromBranch || (controlledUseWorktree ?? localUseWorktree));
  const defaultCloudPlan = cloud?.project && cloud.mayStart ? planCloudStart(cloud.project) : null;
  const [placementChoice, setPlacementChoice] = useState<PlacementChoice | null>(null);
  const [visibility, setVisibility] = useState<{ orgId: string; mode: CloudCreatePlacement["accessMode"] } | null>(null);
  const { status: account } = useAccount();
  const accessMode = visibility && visibility.orgId === cloud?.project?.orgId ? visibility.mode : "private";
  const [idleChoice, setIdleChoice] = useState<number | null>(null);
  const privacy = useDataPrivacy();
  const selectedProvider = privacy.ready && !privacy.enabled && placementChoice?.orgId === cloud?.project?.orgId
    && placementChoice && sessionPlacementReady(account, placementChoice.orgId) ? placementChoice.provider : null;
  const cloudModelClient = useCloudModelClient(!selectedProvider && defaultCloudPlan?.kind === "reuse" && cloud?.mayStart
    ? { orgId: defaultCloudPlan.node.item.workspace.orgId, workspaceId: defaultCloudPlan.node.item.workspace.id } : null);
  // A machine's agents, models and efforts are its own.
  const modelClient = machine ? machine.client : cloudModelClient;
  const remote = !!cloud || !!machine;
  const readiness = useAgentReadinessList(store.harnesses, !remote);
  // Fresh local probes take precedence over discovery cached before an install or removal.
  const harnesses = machine ? machine.harnesses : store.harnesses.map((item) => {
    const state = readiness.values?.[item.id]?.state;
    return state && state !== "unknown" ? { ...item, available: state !== "missing" } : item;
  });
  // Only the agents that are installed and whose local login was found just now: a guess is not "signed in".
  const signedIn = remote ? [] : harnesses.filter((item) => item.available && readiness.values?.[item.id]?.state === "ready");
  const setupCommand = !projectless && !remote ? setupScriptSummary(project?.scripts?.setup) : null;
  // A project's own default account comes first (#980); a chat has none.
  const agentSelection = useSessionAgent(harnesses, !remote, modelClient, undefined, remote ? undefined : readiness.values, projectless || remote ? null : project?.path ?? null);
  const { harness, modelId, effort, mode, accountId } = agentSelection;
  const placement = useCloudPlacement({
    sections: projectless ? [] : cloudChoices,
    cloudProject: cloud?.project ?? null,
    localPath: project?.path ?? null,
    agent: harness?.id ?? null,
    selection: placementChoice,
    defaultCreate: defaultCloudPlan?.kind === "create",
    idleChoice,
  });
  const cloudPlan = placement.startsNew ? { kind: "create" as const } : defaultCloudPlan;
  // A reused or woken workspace keeps its own idle window.
  const legacyIdleOptions = useCloudIdleOptions(!placement.readyHere && cloudPlan?.kind === "create" ? cloud?.project?.orgId ?? null : null);
  const idleOptions = placement.startsNew ? placement.idleOptions : legacyIdleOptions;
  const idleMinutes = placement.startsNew ? placement.idleMinutes
    : idleOptions ? initialIdleSuspend(idleOptions.choices, idleOptions.defaultMinutes, idleChoice) : null;
  // Only with several accounts does a start name one; with one, the request is as it always was.
  const onAccount = accountId ? { account: accountId } : {};
  const pipelineLaunch = usePipelineLaunch(machine ? null : cloud?.project?.key ?? project?.path ?? null,
    cloud?.project ? cloudPipelineSettings(cloud.project.key) : pipelineSettings(project),
    projectless ? "Attach a Git project to automate this session." : !isGit || (!useWorktree && !preset?.cwd) ? "Start on a worktree branch to automate this session." : cloudPlan?.kind === "create" ? "The first cloud session starts on the base branch. Automate a worktree session after the workspace starts." : undefined,
    cloud ? "Cloud workspaces require a person to merge." : undefined,
    // A picked issue makes this a session started from an issue: switches nobody touched follow it.
    issue ? "issue" : "session");
  // Orchestrate (PRO-337): a session of a local git project can lead a run; a cloud draft, a chat or the compact window cannot.
  const orchestrateShown = useOrchestrateOffered({ local: !projectless && !remote && !!project, git: isGit, cloud: remote, quick: projectless, compact });
  /** The start in progress is an Orchestrate start. */
  const [orchestrating, setOrchestrating] = useState(false);
  // A cloud session runs the agent installed on the workspace, not on this computer.
  const available = remote ? !!harness : (harness?.available ?? false);
  // The chosen agent's login on the machine, when it says (PRO-350); a definite "signed out" holds Create back.
  const machineSignIn = machine ? agentSignIn(machine.agents, harness?.id) : null;
  const workspace = preset?.cwd ? (store.workspaces[preset.projectPath] ?? []).find((w) => w.path === preset.cwd) ?? null : null;
  // Setup belongs to the agent the person picks (#1064): one notice, for one agent, only when this Mac
  // knows it is missing or signed out. The first check under way (no answer yet) or an unverified login
  // shows nothing; a re-check keeps the last answer, so the notice and its open card stay put.
  const [setupPick, setSetupPick] = useState<string | null>(null);
  const needsSetup = (id: string) => {
    const state = readiness.values?.[id]?.state;
    return state === "missing" || state === "signed_out";
  };
  const setupTarget = remote ? null
    : store.harnesses.find((item) => item.id === setupPick && needsSetup(item.id))
      ?? (harness ? (needsSetup(harness.id) ? harness : null)
      // Nothing can start: the agent last used, else the first, once a check has answered.
      : store.harnesses.find((item) => item.id === prefs.lastAgent && needsSetup(item.id)) ?? store.harnesses.find((item) => needsSetup(item.id)) ?? null);
  // The agent picked for setup is ready now: it is the one the chat starts with.
  const pickedReady = !!setupPick && readiness.values?.[setupPick]?.state === "ready";
  useEffect(() => {
    if (!pickedReady || !setupPick) return;
    agentSelection.selectHarness(setupPick);
    setSetupPick(null);
  }, [pickedReady, setupPick]); // eslint-disable-line react-hooks/exhaustive-deps
  // Picking an agent that can start drops the setup pick: a later sign-in elsewhere never overrides that choice.
  const menuSelection = setupPick ? { ...agentSelection, selectHarness: (id: string) => { setSetupPick(null); agentSelection.selectHarness(id); } } : agentSelection;

  useEffect(() => {
    let cancelled = false;
    const at = preset?.cwd ?? project?.path;
    // Never a local path for a cloud or machine draft.
    if (!at || !isGit || cloud || machine) return setStatus(null);
    api.workStatus(at).then((s) => !cancelled && setStatus(s)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, preset, isGit, cloud, !!machine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    if (!project || preset?.cwd || !useWorktree || cloud || machine) {
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
  }, [project?.path, preset?.cwd, useWorktree, !!cloud, !!machine]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setIssueSource(null);
  }, [project?.path, !!cloud, projectless]); // eslint-disable-line react-hooks/exhaustive-deps
  // A branch or pull request of this Mac's checkout means nothing on a machine; an issue goes along.
  useEffect(() => {
    if (!machine) return;
    setCheckoutBranch(null);
    setPullRequest(null);
  }, [!!machine]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!seed || !machine) return;
    takeNewSessionSeed(seed);
    if (seed.prompt) setText(seed.prompt);
    setIssue(seed.issue);
    setIssueSource(seed.issueProjectPath);
  }, [seed, !!machine]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const prMention = usePrMention(!remote && !projectless && isGit && !busy ? project?.path ?? null : null, text, caret, setText, ref, setCaret, { floating: true });
  // `@` names a file of the folder the session will work in; a cloud draft or a chat with no folder has none to list here.
  const fileMention = useFileMention(!remote && !busy ? (projectless ? quickCwd : preset?.cwd ?? project?.path ?? null) : null, text, caret, setText, ref, setCaret);
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

  const dictationContext = useDictationContext(NEW_SESSION_TARGET, remote ? undefined : preset?.cwd ?? project?.path ?? quickCwd ?? undefined, remote, text);
  const dictation = useDictationInto(NEW_SESSION_TARGET, text, setText, ref, dictationContext);
  useDictationShortcuts(dictation);
  const keymap = useKeymap();
  const sendKeys = keymap["composer.send"][0];
  const attach = useAttachments({ textareaRef: ref, draft: text, onDraftChange: setText });
  // Refused chips are never sent, and alone make no prompt.
  const hasImages = attach.images.length + attach.files.length > 0;

  const pending = unsettledCreate.current;
  const retryingCloudCreate = !!pending && pending.project.key === cloud?.project?.key &&
    pending.form.prompt === text && pending.form.agent === harness?.id && pending.form.model === modelId &&
    pending.form.effort === (effort ?? "") && pending.form.mode === mode &&
    (pending.form.idleSuspendMinutes ?? null) === idleMinutes &&
    (!placement.startsNew || (pending.form.provider === (placement.offer?.id ?? selectedProvider) && pending.form.accessMode === accessMode));

  // A screenshot or a file alone is a prompt, as it is in the session composer.
  const canSend = useMemo(
    () =>
      machine
        ? !!machine.client && !!machine.project && !!harness && (text.trim().length > 0 || !!issue) && !hasImages && !busy && machineSignIn !== "signedOut"
        : cloud
        ? !!cloud.project && !!harness && text.trim().length > 0 && !hasImages && !busy && cloud.project.selected && cloud.mayStart === true && (!placement.blocked || retryingCloudCreate)
        : projectless
          ? !!harness && available && (text.trim().length > 0 || hasImages) && !busy
          : !!project && !!harness && available && (text.trim().length > 0 || hasImages || !!issue || !!pullRequest) && (!useWorktree || !!preset?.cwd || !!workspaceName) && !busy && !prMention.attaching,
    [machine, machineSignIn, cloud, projectless, project, harness, available, text, hasImages, issue, pullRequest, useWorktree, preset?.cwd, workspaceName, busy, prMention.attaching, placement.blocked, retryingCloudCreate],
  );

  const cloudRequest = (): CloudSessionRequest => ({
    agent: harness!.id,
    model: modelId,
    effort,
    mode,
    // The person's own words: a retry compares them, and the shared prompts are added once, as the request leaves (cloudNewSession).
    prompt: text,
    useWorktree,
    ...(pipelineLaunch.value.resolveConflicts ? { pipeline: pipelineLaunch.value, pipelineSettings: pipelineLaunch.settings } : {}),
    ...(idleMinutes !== null ? { idleSuspendMinutes: idleMinutes } : {}),
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
    setError(atRunningLimit ? runningLimitMessage(orgId) : (placement.startsNew ? cloudPlacementError : cloudStartError)(e, orgId));
    // Refused for lack of role: read the roles again, so the form and the menus stop offering it.
    if (isRoleRefusal(e)) void refreshAccountRoles(true);
  };

  /**
   * Start in the cloud: reuse or wake a workspace of the project, or create
   * one. Pressing Create is the decision to create: nothing asks again
   * (PRO-409), and the button stays busy until the session opens.
   */
  const createCloud = async () => {
    if (!cloud?.project || !harness || !canSend || !cloudPlan) return;
    if (dictation.dictating) await stopDictation();
    setBusy(true);
    setError(null);
    setLimitOrg(null);
    setPausedFor(null);
    const project = cloud.project;
    const plan = placement.startsNew ? cloudPlan : planCloudStart(project);
    // Held past this call while a new workspace starts; `followLaunch` opens its session.
    let held = false;
    try {
      if (plan.kind === "create") {
        // The limits are still checked first; the wait reads as one step, the create the person asked for.
        setStarting("Creating the workspace…");
        const request = cloudRequest();
        const prepared = pending && retryingCloudCreate ? pending
          : placement.startsNew && placement.quote && placement.idleOptions ? await prepareCloudCreate(project, request, {
            quote: placement.quote, defaultIdleSuspendMinutes: placement.idleOptions.defaultMinutes, accessMode,
          })
          : await prepareCloudCreate(project, request);
        unsettledCreate.current = null;
        setStarting(`Creating the workspace on ${quoteText(prepared.quote, placement.offer?.label ?? prepared.providerLabel).machine}…`);
        let snapshot;
        try {
          snapshot = await confirmCloudCreate(prepared);
        } catch (e) {
          if (isClientError(e) && e.retryWithSameIdempotencyKey) unsettledCreate.current = prepared;
          throw e;
        }
        setText("");
        launchSeen.current = false;
        setLaunching({ orgId: prepared.orgId, workspaceId: snapshot.workspace.id, projectKey: project.key });
        setStarting("Starting the workspace…");
        held = true;
      } else {
        setStarting(plan.kind === "wake" ? `Resuming ${plan.node.item.workspace.name}…` : "Starting the session…");
        await startInWorkspace(plan, cloudRequest());
        setText("");
      }
    } catch (e) {
      showCloudError(e, project.orgId);
    } finally {
      if (!held) {
        setStarting(null);
        setBusy(false);
      }
    }
  };

  // The new workspace's start, read from the catalog: where it is, and the
  // end of the wait (its session is there, it failed, or the form moved on).
  const launchProjectKey = cloud?.project?.key ?? null;
  useEffect(() => {
    if (!launching) return;
    const release = (failure: string | null = null) => {
      launchSeen.current = false;
      setLaunching(null);
      setStarting(null);
      setBusy(false);
      if (failure) {
        setErrorOrg(launching.orgId);
        setError(failure);
      }
    };
    if (launchProjectKey !== launching.projectKey) return release();
    const item = findCloudWorkspace(catalog, launching.orgId, launching.workspaceId);
    // Not listed yet; once it was, gone means deleted or archived elsewhere.
    if (!item) return launchSeen.current ? release() : undefined;
    launchSeen.current = true;
    if (item.workspace.launch?.sessionId) return release();
    const phase = phaseOf(item);
    if (phase === "failed") return release(failureMessage(item));
    if (phase === "canceled") return release("The workspace's start was canceled.");
    // Up with no first session to open (an older server): the sidebar row is the way in.
    if (phase === "running") return release();
    const label = PHASES.find((entry) => entry.id === phase)?.label ?? "Starting";
    setStarting(`Starting the workspace: ${label.toLowerCase()}…`);
  }, [launching, catalog, launchProjectKey]);

  /**
   * Create on the chosen machine: `session.create` with its project, in a new
   * worktree there, the first prompt inside the one idempotent call. A Create
   * pressed again after a lost answer reuses the id, so the session and its
   * first prompt happen once; the session opens in the machine session view.
   */
  const createOnMachine = async () => {
    if (!machine?.client || !machine.project || !harness || !canSend) return;
    if (dictation.dictating) await stopDictation();
    const client = machine.client;
    const projectId = machine.project.projectId;
    const baseRef = useWorktree ? machineBase : null;
    // The id follows what the person asked for, not the prompt read below: an issue's comments may change between tries.
    const id = machineAttempt.idFor({ machine: machine.machineId, projectId, agent: harness.id, model: modelId, effort, mode, text, issue: issue?.id ?? null, baseRef, useWorktree });
    setBusy(true);
    setError(null);
    try {
      let prompt = text;
      if (issue) {
        const read = issueSource ?? project?.path ?? null;
        const about = read ? await issuePromptWithComments(read, issue) : issuePrompt(issue);
        prompt = [text.trim(), about].filter(Boolean).join("\n\n");
      }
      const title = (issue ? `${issue.identifier} ${issue.title}` : text.trim().split("\n")[0] ?? "").slice(0, 80);
      const nativeCodex = (await experimental.nativeCodexFor(harness.id)) || undefined;
      const made = await createMachineSession(client, {
        machineId: machine.machineId,
        projectId,
        agent: harness.id,
        model: modelId,
        effort,
        mode,
        prompt,
        title,
        useWorktree,
        worktreeName: issue ? issueWorktreeName(issue.identifier, issue.title) : null,
        baseRef,
        issue: issue ? { ref: { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url }, body: ("description" in issue && typeof issue.description === "string" ? issue.description : null) ?? issue.body ?? null, pipeline: true } : null,
        nativeCodex,
      }, id);
      machineAttempt.settle(null);
      setText("");
      setIssue(null);
      setIssueSource(null);
      // The session is there and open; a first prompt that did not go says why in its transcript too.
      if (made.startError) console.error("the first prompt on the machine did not go", made.startError);
    } catch (e) {
      machineAttempt.settle(e);
      setError(machineStartError(e, machine.name));
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
    if (machine) return createOnMachine();
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

  // "Where it runs" (PRO-348): This Mac, each paired machine, each organization's cloud. Only once a machine is paired.
  const whereShown = (machinesPaired || !!machine || placement.ready.length > 0) && !projectless;
  const cloudWhere: CloudWhere[] = cloudChoices.flatMap((section) => {
    if (placement.ready.some(({ orgId }) => orgId === section.orgId)) {
      const rows = placement.rows.filter(({ orgId }) => orgId === section.orgId);
      if (cloud?.project?.orgId === section.orgId && defaultCloudPlan && defaultCloudPlan.kind !== "create") {
        return [{ orgId: section.orgId, orgName: section.orgName, startKey: cloud.project.key, projectCount: 0, locked: null,
          detail: `${defaultCloudPlan.kind === "wake" ? "Resume" : "Use"} ${defaultCloudPlan.node.item.workspace.name}` }, ...rows.filter(({ provider }) => provider)];
      }
      return rows;
    }
    if (!machinesPaired && !machine) return [];
    const startable = section.mayStart === true ? section.projects.find((choice) => choice.selected) : undefined;
    const current = cloud?.project && cloud.project.orgId === section.orgId ? cloud.project.key : null;
    return [{
      orgId: section.orgId,
      orgName: section.orgName,
      startKey: current ?? startable?.key ?? null,
      projectCount: section.projects.length,
      locked: section.mayStart === false ? NEW_SESSION_ADMIN_REASON : !startable && !current ? "No cloud projects yet" : null,
    }];
  });
  const whereMenu = whereShown ? (
    <WhereMenu
      lead={!!machine}
      current={machine ? { kind: "machine", machineId: machine.machineId, name: machine.name, machine: machine.machine } : cloud?.project ? { kind: "cloud", orgId: cloud.project.orgId, orgName: cloud.orgName, provider: placement.offer?.id ?? selectedProvider ?? undefined, providerLabel: placement.offer?.label } : { kind: "local" }}
      localProject={project ? { name: project.name, path: project.path } : null}
      localWorktree={useWorktree}
      cloud={cloudWhere}
      showCloudPlacementNote={placement.ready.length > 0}
      onRecheckCloud={placement.ready.length ? placement.recheck : undefined}
      onHere={placement.ready.length ? () => {
        setPlacementChoice(null);
        setVisibility(null);
        runNewSessionHere();
      } : undefined}
      onCloud={placement.ready.length ? (row) => {
        if (!row.startKey) return;
        setPlacementChoice({ orgId: row.orgId, provider: row.provider ?? null });
        if (cloud?.project?.key === row.startKey) return;
        startCloudSessionIn(row.startKey);
      } : undefined}
      disabled={busy}
      onAddMachine={() => setAddingMachine(true)}
    />
  ) : null;
  const projectButton = "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground transition-colors hover:bg-veil-raised";
  const chip = "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-veil-raised hover:text-foreground disabled:opacity-50";
  const createLabel = projectless ? "Ask" : machine ? `Create on ${machine.name}` : placement.readyHere ? "Create in cloud" : "Create";
  const localGit = !projectless && !remote && isGit && !!project;
  const launchProgress = useCloudStart(undefined, launching?.projectKey === launchProjectKey ? launching : null);
  const branchInfo = projectless ? null : cloud ? (whereShown ? null : (
    <span className="flex min-w-0 items-center gap-1.5 truncate px-2 text-[12.5px] text-muted-foreground" data-testid="cloud-runs-in" title="The agent, its terminals and its files run on a cloud workspace of the organization, not on this computer.">
      <Cloud className="size-3.5 shrink-0" /> {cloud.orgName} cloud
    </span>
  )) : !isGit ? (
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

  if (launchProgress) return <div className={cn("flex min-h-64 flex-col", !modal && "h-full")}><CloudStartSession start={launchProgress} /></div>;

  return (
    <div className={cn("flex min-h-0 flex-col", !modal && "h-full")} data-quick-start={quick ? "" : undefined}>
      <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center", !modal && "overflow-y-auto", modal ? "" : compact ? "p-3" : "px-6 py-8")}>
        <div className="w-full max-w-[720px]">
          {/* The scene needs room a small window does not have. */}
          {!compact && !modal && <RaccoonScene className="mb-1" />}
          <DictationStatus dictation={dictation} />

          {/* Everything the form says is drawn inside this box: over a dimmed session there is nothing behind it to read text against. */}
          <div className={cn("relative overflow-hidden rounded-[12px] bg-composer shadow-surface hairline", modal && "border border-border shadow-2xl", attach.dragging && "ring-2 ring-accent/60")} data-composer-box {...attach.dropZoneProps}>
            <DropHint dragging={attach.dragging} />

            <div className={cn("flex items-center gap-1 border-b border-hairline px-3", placement.ready.length ? "min-h-11 flex-wrap py-1.5" : "h-11")} data-testid="new-session-header">
              {machine ? (
                <>
                  {whereMenu}
                  <MachineProjectMenu draft={machine} disabled={busy} />
                  <MachineBranchMenu draft={machine} base={machineBase} onBase={setMachineBase} disabled={busy} />
                </>
              ) : projectless ? (
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
              {machine ? null : localGit && project && !preset?.cwd && useWorktree && !pullRequest && !checkoutBranch ? (
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
              {!machine && !projectless && isGit && !preset?.cwd && (
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
              {!machine && !projectless && isGit && preset?.cwd && <SessionOptions pipeline={pipelineLaunch} />}
              {!machine && whereMenu}
              {placement.startsNew && cloud?.project && <CloudPlacementChips
                orgName={cloud.orgName}
                quote={placement.quote}
                checkingPrice={placement.checkingPrice}
                accessMode={accessMode}
                onAccessMode={(next) => setVisibility({ orgId: cloud.project!.orgId, mode: next })}
                disabled={busy}
              />}
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
                    : machine && !machine.project
                      ? `Add a project on ${machine.name} to get started`
                      : !project && !remote
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
              <AgentMenu split selection={menuSelection} disabled={busy} onSetup={remote ? undefined : setSetupPick} />
              {!remote && harness && !available && (
                <span className="min-w-0 truncate text-xs text-warning" title={harness.installHint || undefined}>
                  {harness.name} isn't installed
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                {!remote && (projectless ? !!quickCwd : !!project) && (
                  <WithTooltip label="Mention a file" side="top">
                    <Button variant="ghost" size="icon-sm" aria-label="Mention a file" disabled={busy} onClick={fileMention.start}>
                      <AtSign />
                    </Button>
                  </WithTooltip>
                )}
                {!remote && <AttachButton attach={attach} />}
                <MicButton dictation={dictation} />
                {/* One button in two parts: Create, and the other ways to start behind the chevron. */}
                <div className={cn("ml-1.5 flex h-8 items-stretch overflow-hidden rounded-md", canSend ? "bg-accent text-accent-foreground shadow-button" : "bg-veil-strong text-muted-foreground")} data-testid="create-button">
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={() => void create()}
                    aria-label={createLabel}
                    data-testid="new-session-create"
                    title={sendKeys ? `${createLabel} (${joinKeycaps(keycaps(sendKeys))})` : createLabel}
                    className="flex items-center gap-2 px-3 text-[12.5px] font-semibold transition-colors enabled:hover:bg-black/10 [&_svg]:size-3.5"
                  >
                    {busy && !orchestrating ? <Loader2 className="animate-spin" /> : null}
                    {createLabel}
                    {sendKeys && !busy && <span className="rounded border border-current/30 px-1 font-sans text-[11px] font-medium leading-4">{joinKeycaps(keycaps(sendKeys))}</span>}
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
                          {sendKeys && <span className="ml-auto pl-3 text-[11px] text-faint">{joinKeycaps(keycaps(sendKeys))}</span>}
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
              {!remote && !projectless && preset && !project && <p role="alert" className="text-xs text-destructive">The requested project is no longer attached. Add it again or choose a project before sending.</p>}
              {/* One notice, for one agent, only when it is known missing or signed out (#1064): never a card per agent, nothing while checking. */}
              {setupTarget && (
                <AgentSetupNotice key={setupTarget.id} harness={setupTarget} value={readiness.values?.[setupTarget.id] ?? null} checking={readiness.checking || busy} blocking={!harness}
                  onDismiss={setupTarget.id === setupPick ? () => setSetupPick(null) : undefined} onRefresh={() => {
                  void Promise.all([readiness.refresh(), refreshHarnesses()]).catch(() => setError("Could not re-check installed agents. Try again."));
                }} />
              )}
              {cloud && starting && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" data-testid="cloud-start-status">
                  {busy && <Loader2 className="size-3.5 animate-spin" />} {starting}
                </div>
              )}
              {/* The notice above already offers the install when it is for this agent. */}
              {!remote && harness && !available && setupTarget?.id !== harness.id && (
                <p className="text-xs text-muted-foreground">
                  {harness.installHint
                    ? <>Install {harness.name} by running <code className="font-mono">{harness.installHint}</code></>
                    : <>Install {harness.name} with its <button type="button" className="underline" onClick={() => void openUrl(harness.installUrl)}>setup guide</button>.</>}
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

            {!remote && (
              <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-hairline px-4 py-1.5 text-xs text-faint" data-testid="new-session-footer">
                {signedIn.map((item) => (
                  <span key={item.id} className="flex items-center gap-1 whitespace-nowrap" data-testid="agent-signed-in"><Check className="size-3 text-add" aria-hidden />{item.name} signed in</span>
                ))}
                <p className="ml-auto whitespace-nowrap">Nothing starts until you press {createLabel}</p>
              </div>
            )}
          </div>
          {machine && <MachineFormLine draft={machine} agentId={harness?.id ?? null} agentName={harness?.name ?? null} />}
          {placement.startsNew && cloud?.project && <CloudPlacementReadiness blocked={placement.blocked} orgId={cloud.project.orgId}
            orgName={cloud.orgName} agentName={harness?.name ?? "Agent"} onRecheck={placement.recheck}>
            {placement.pausedFor.length > 0 && <AllowNewMachines
              key={`${cloud.project.orgId}:${account.context?.revision ?? ""}`}
              providers={placement.pausedFor}
              onAllowed={placement.recheck}
            />}
            {runningLimitReached(cloud.project.orgId, catalog) && <RunningLimitNotice orgId={cloud.project.orgId} />}
          </CloudPlacementReadiness>}
          {placement.usageSummary && <p className="mt-2 px-1 text-xs text-muted-foreground" data-testid="cloud-placement-usage">{placement.usageSummary}</p>}
          {cloudPlan?.kind === "create" && idleOptions && idleMinutes !== null && (
            <div className="mt-2 px-1" data-testid="cloud-idle-line">
              <IdleSuspendSelect choices={idleOptions.choices} value={idleMinutes} cap={idleOptions.cap} disabled={busy} onChange={setIdleChoice} testId="cloud-idle-suspend" />
            </div>
          )}
        </div>
      </div>
      {whereShown && <AddMachineDialog open={addingMachine} onOpenChange={setAddingMachine} onPaired={() => void refreshPairedMachines()} />}
    </div>
  );
}
