import { cloudPipelineSettings } from "@/lib/issuePipeline";
import { usePipelineLaunch, pipelineSettings, preparePipelineLaunch } from "@/lib/pipelineLaunch";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Cloud, FolderOpen, FolderGit2, GitBranch, Github, Loader2, LogoLinear, MessageCircle, X } from "@/icons";
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
import { AttachButton, AttachmentThumbs, DropHint, useImageAttachments } from "@/components/chat/useImageAttachments";
import { RaccoonScene } from "@/components/raccoon/Raccoon";
import { isRoleRefusal, refreshAccountRoles } from "@/lib/accountRoles";
import { api, errorMessage, type ImageInput, type Issue } from "@/lib/api";
import { issuePromptWithComments, issueWorktreeName } from "@/lib/issueSession";
import { worktreeNameFromPrompt } from "@/lib/worktreeNames";
import { clearNewSessionPreset, createQuickChat, linkSessionIssue, startSessionIn, startCloudSessionIn, selectProject, selectProjectInSidebar, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { useCloudModelClient } from "@/lib/cloudModels";
import { useSessionAgent } from "@/lib/useSessionAgent";
import { AgentMenu } from "./AgentMenu";
import { BranchPicker, type BranchTarget } from "./BranchPicker";
import { IssuePicker } from "./IssuePicker";
import { SessionOptions } from "./SessionOptions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { usePromptTextProps } from "@/lib/autocorrect";
import { openLocalProject } from "@/lib/projectStart";
import { keycaps, matchesShortcut, useKeymap } from "@/lib/shortcuts";
import { stopDictation } from "@/lib/dictation";
import { cn } from "@/lib/cn";
import type { WorkStatus } from "@/types/session";
import { CloudCreateConfirm, cloudStartError, useCloudDraft, useCloudProjectChoices } from "./CloudNewSession";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { RunningLimitNotice } from "@/components/cloud/RunningLimitNotice";
import { AgentLoginsLink } from "@/components/cloud/AgentLoginsLink";
import { NEW_SESSION_ADMIN_REASON } from "@/lib/cloudCollab";
import { RUNNING_LIMIT_CODE, runningLimitMessage, runningLimitReached } from "@/lib/runningLimit";
import { confirmCloudCreate, planCloudStart, prepareCloudCreate, startInWorkspace, type CloudSessionRequest, type PreparedCreate } from "@/lib/cloudNewSession";

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
  quick = false,
  compact = false,
  modal = false,
}: {
  onCreated?: (sessionId: string, tabId: string, firstPrompt: string, images: ImageInput[]) => void;
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
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [localUseWorktree, setLocalUseWorktree] = useState(prefs.useWorktree);
  const ref = useRef<HTMLTextAreaElement>(null);
  const textProps = usePromptTextProps();
  const setUseWorktree = onUseWorktreeChange ?? setLocalUseWorktree;
  // A cloud project's `+` (PRO-23): the same form, run in the organization's cloud. A quick chat is local.
  const cloudDraft = useCloudDraft();
  const cloud = quick ? null : cloudDraft;
  /** A folder the quick chat runs in instead of its scratch folder; it does not become a project. */
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

  const preset = store.newSessionPreset;
  // The rail is what the reader last pointed at, so it beats the project they
  // happened to start a session in some other day; a preset beats both.
  const wanted = preset?.projectPath ?? store.selectedProject ?? prefs.lastProject;
  const project = quick ? null : (store.projects.find((p) => p.path === wanted) ?? store.projects[0] ?? null);
  // A quick chat cuts no worktree, whatever the folder it is pointed at.
  const isGit = quick ? false : cloud ? true : project?.kind !== "folder";
  const useWorktree = isGit && (controlledUseWorktree ?? localUseWorktree);
  const cloudPlan = cloud?.project && cloud.mayStart ? planCloudStart(cloud.project) : null;
  const modelClient = useCloudModelClient(cloudPlan?.kind === "reuse" && cloud?.mayStart
    ? { orgId: cloudPlan.node.item.workspace.orgId, workspaceId: cloudPlan.node.item.workspace.id } : null);
  const agentSelection = useSessionAgent(store.harnesses, !cloud, modelClient);
  const { harness, modelId, effort, mode } = agentSelection;
  const pipelineLaunch = usePipelineLaunch(cloud?.project?.key ?? project?.path ?? null,
    cloud?.project ? cloudPipelineSettings(cloud.project.key) : pipelineSettings(project),
    quick ? "Attach a Git project to automate this session." : !isGit || (!useWorktree && !preset?.cwd) ? "Start on a worktree branch to automate this session." : cloudPlan?.kind === "create" ? "The first cloud session starts on the base branch. Automate a worktree session after the workspace starts." : undefined,
    cloud ? "Cloud workspaces require a person to merge." : undefined);
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
  }, [project?.path, !!cloud, quick]); // eslint-disable-line react-hooks/exhaustive-deps

  const branchTarget: BranchTarget = preset?.cwd
    ? { kind: "open", cwd: preset.cwd }
    : checkoutBranch
      ? { kind: "existing", branch: checkoutBranch }
      : useWorktree
        ? { kind: "new" }
        : { kind: "open", cwd: project?.path ?? "" };
  const pickBranch = (next: BranchTarget) => {
    if (!project) return;
    setCheckoutBranch(next.kind === "existing" ? next.branch : null);
    if (next.kind === "open" && next.cwd !== project.path) return startSessionIn(project.path, next.cwd);
    clearNewSessionPreset();
    setUseWorktree(next.kind !== "open");
  };

  const pickProject = async () => {
    try {
      await openLocalProject();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const dictation = useDictationInto(NEW_SESSION_TARGET, text, setText, ref);
  useDictationShortcuts(dictation);
  const keymap = useKeymap();
  const sendKeys = keymap["composer.send"][0];
  const attach = useImageAttachments({ textareaRef: ref, draft: text, onDraftChange: setText });
  const hasImages = attach.attachments.length > 0;

  // A screenshot alone is a prompt, as it is in the session composer.
  const canSend = useMemo(
    () =>
      cloud
        ? !!cloud.project && !!harness && text.trim().length > 0 && !hasImages && !busy && !confirm && cloud.project.selected && cloud.mayStart === true
        : quick
          ? !!harness && available && (text.trim().length > 0 || hasImages) && !busy
          : !!project && !!harness && available && (text.trim().length > 0 || hasImages || !!issue) && (!useWorktree || !!preset?.cwd || !!workspaceName) && !busy,
    [cloud, quick, project, harness, available, text, hasImages, issue, useWorktree, preset?.cwd, workspaceName, busy, confirm],
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

  /** Start a quick chat: no project, no worktree; the first prompt is sent as for any session. */
  const createQuick = async () => {
    if (!harness || !canSend) return;
    if (dictation.dictating) await stopDictation();
    setBusy(true);
    setError(null);
    try {
      const title = text.trim().split("\n")[0].slice(0, 60);
      const images = attach.images;
      const s = await createQuickChat({ title, cwd: quickCwd, tab: { harness: harness.id, model: modelId, effort, permissionMode: mode } });
      setText("");
      attach.clear();
      setQuickCwd(null);
      selectSession(s.id);
      onCreated?.(s.id, s.tabs[0].id, text, images);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (quick) return createQuick();
    if (cloud) return createCloud();
    if (!project || !harness || !canSend) return;
    if (dictation.dictating) await stopDictation();
    setBusy(true);
    setError(null);
    try {
      // The backend names an untitled session itself, so an image-only prompt
      // sends an empty title rather than inventing one here.
      const title = (text.trim().split("\n")[0] || issue?.title || "").slice(0, 60);
      const images = attach.images;
      // Named for the work: the issue's name when there is one, else the prompt's words; the drawn name when they say nothing.
      // An existing branch's worktree is named after the branch.
      const named = checkoutBranch ? (checkoutBranch.split("/").pop() ?? "") : !preset?.cwd && useWorktree && !issue ? worktreeNameFromPrompt(text) : "";
      const worktreeName = named ? await api.previewWorkspaceName(project.path, named).catch(() => workspaceName) : workspaceName;
      const s = await api.createSession({
        projectPath: project.path,
        title,
        useWorktree: preset?.cwd ? false : useWorktree,
        onMain: !preset?.cwd && !useWorktree,
        worktreeName: !preset?.cwd && useWorktree ? worktreeName : null,
        checkoutBranch: !preset?.cwd && useWorktree ? checkoutBranch : null,
        cwd: preset?.cwd ?? null,
        tab: { harness: harness.id, model: modelId, effort, permissionMode: mode },
      });
      upsertSession(s);
      let first = text;
      if (issue) {
        const ref = { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url };
        // The link is a convenience; a session that could not be linked still starts.
        await linkSessionIssue(s.id, ref).catch((cause) => console.error("the new session was not linked to its issue", cause));
        first = [text.trim(), await issuePromptWithComments(project.path, issue)].filter(Boolean).join("\n\n");
      }
      const prompt = await preparePipelineLaunch(s.id, s.tabs[0].id, first, pipelineLaunch.value);
      setText("");
      setIssue(null);
      attach.clear();
      selectSession(s.id);
      onCreated?.(s.id, s.tabs[0].id, prompt, images);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const projectButton = "flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[14px] font-medium text-foreground transition-colors hover:bg-veil-raised";
  const localGit = !quick && !cloud && isGit && !!project;
  const branchInfo = quick ? null : cloud ? (
    <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground" data-testid="cloud-runs-in" title="The agent, its terminals and its files run on a cloud workspace of the organization, not on this computer.">
      <Cloud className="size-3.5 shrink-0" /> {cloud.orgName} cloud
    </span>
  ) : !isGit ? (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Agents, terminals, and files are available. Git features require a repository.">
      <FolderOpen className="size-3.5" /> No Git
    </span>
  ) : preset?.cwd ? (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate font-mono">{workspace?.name ?? preset.cwd.split("/").pop()}</span>
    </span>
  ) : useWorktree ? (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={`Works on a new branch of its own, made from ${status?.defaultBranch ?? "the default branch"}, so it never touches your other work.`}>
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate">New branch</span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate font-mono">{status?.branch ?? "current branch"}</span>
    </span>
  );

  return (
    <div className={cn("flex min-h-0 flex-col", !modal && "h-full")} data-quick-start={quick ? "" : undefined}>
      <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center", !modal && "overflow-y-auto", modal ? "" : compact ? "p-3" : "px-6 py-8")}>
        <div className="w-full max-w-3xl">
          {/* The scene needs room a small window does not have. */}
          {!compact && !modal && <RaccoonScene className="mb-1" />}
          <DictationStatus dictation={dictation} />
          {cloud && confirm && (
            <CloudCreateConfirm prepared={confirm} orgName={cloud.orgName} busy={busy} onConfirm={() => void confirmCreate()} onCancel={() => setConfirm(null)} />
          )}
          {cloud && starting && (
            <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground" role="status" data-testid="cloud-start-status">
              {busy && <Loader2 className="size-3.5 animate-spin" />} {starting}
            </div>
          )}

          <div className={cn("relative overflow-hidden rounded-2xl bg-composer glass shadow-surface hairline", modal && "shadow-2xl", attach.dragging && "ring-2 ring-accent/60")} data-composer-box {...attach.dropZoneProps}>
            <DropHint dragging={attach.dragging} />

            <div className="flex h-12 items-center gap-1 border-b border-hairline px-2">
              {quick ? (
                <DropdownMenu {...folderMenu.root}>
                  <DropdownMenuTrigger asChild {...folderMenu.trigger}>
                    <button type="button" className={projectButton} title={quickCwd ?? "A scratch folder made for this chat"} aria-label="Working directory">
                      {quickCwd ? <FolderOpen className="size-4 text-muted-foreground" /> : <MessageCircle className="size-4 text-muted-foreground" />}
                      <span className="truncate">{quickCwd ? (quickCwd.replace(/\/+$/, "").split("/").pop() || quickCwd) : "Scratch folder"}</span>
                      <ChevronDown className="size-3.5 text-faint" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-w-[18rem]">
                    <DropdownMenuLabel>Runs in</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => setQuickCwd(null)}>
                      <MessageCircle />
                      <span>Scratch folder</span>
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
                    <button type="button" className={projectButton}>
                      {cloud ? <Cloud className="size-4 text-muted-foreground" /> : isGit ? <FolderGit2 className="size-4 text-muted-foreground" /> : <FolderOpen className="size-4 text-muted-foreground" />}
                      <span className="truncate">{cloud ? (cloud.project?.fullName ?? "Cloud project") : (project?.name ?? "Choose project")}</span>
                      <ChevronDown className="size-3.5 text-faint" />
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
              {localGit && project ? (
                <BranchPicker projectPath={project.path} defaultBranch={status?.defaultBranch ?? "main"} target={branchTarget} onChange={pickBranch} />
              ) : (
                branchInfo
              )}
              {!quick && isGit && !preset?.cwd && (
                <SessionOptions
                  useWorktree={useWorktree}
                  onUseWorktreeChange={cloud ? setUseWorktree : undefined}
                  switchLabel={cloud ? "New worktree on the cloud workspace" : undefined}
                  worktreeLabel={cloud ? "New worktree on the workspace" : `New branch from ${status?.defaultBranch ?? "the default branch"}`}
                  currentBranch={cloud ? "the workspace's checkout" : (status?.branch ?? "the current branch")}
                  pipeline={pipelineLaunch}
                />
              )}
              {!quick && isGit && preset?.cwd && <SessionOptions pipeline={pipelineLaunch} />}
              <div className="ml-auto flex shrink-0 items-center">
                {localGit && project && <IssuePicker projectPath={project.path} picked={issue} onPick={pickIssue} disabled={busy} />}
              </div>
            </div>

            <div className="px-4 pt-3">
              {issue && (
                <div className="mb-2 flex max-w-full items-center gap-1.5 self-start rounded-md bg-veil-raised py-1 pl-2 pr-1 text-xs" data-testid="picked-issue">
                  {issue.provider === "github" ? <Github className="size-3.5 shrink-0" /> : <LogoLinear className="size-3.5 shrink-0" />}
                  <span className="shrink-0 font-mono text-muted-foreground">{issue.identifier}</span>
                  <span className="min-w-0 truncate">{issue.title}</span>
                  <button type="button" aria-label="Remove issue" onClick={clearIssue} className="ml-0.5 shrink-0 rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground">
                    <X className="size-3" />
                  </button>
                </div>
              )}
              <AttachmentThumbs attach={attach} />
              <textarea
                ref={ref}
                autoFocus
                data-new-session-prompt
                {...textProps}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
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
                  quick
                    ? "Ask anything"
                    : !project && !cloud
                      ? "Add a project to get started"
                      : issue
                        ? "Add notes for the agent (optional)"
                        : "What do you want to work on?"
                }
                className="w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-faint"
              />
            </div>

            <div className="flex items-center gap-1 px-2 pb-2">
              <AgentMenu selection={agentSelection} disabled={busy} />
              {!cloud && harness && !available && (
                <span className="min-w-0 truncate text-xs text-warning" title={harness.installHint}>
                  {harness.name} isn't installed
                </span>
              )}
              <div className="ml-auto flex items-center gap-0.5">
                <MicButton dictation={dictation} />
                {!cloud && <AttachButton attach={attach} />}
                <Button size="sm" variant="accent" className="ml-1 gap-1.5" disabled={!canSend} onClick={create} aria-label={quick ? "Ask" : "Create"} title={sendKeys ? `Create (${keycaps(sendKeys).join("")})` : "Create"}>
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  {quick ? "Ask" : "Create"}
                  {sendKeys && !busy && <span className="font-sans opacity-70">{keycaps(sendKeys).join("")}</span>}
                </Button>
              </div>
            </div>
          </div>

          {!cloud && harness && !available && (
            <p className="mt-2 px-1 text-xs text-muted-foreground">
              Install it with <code className="font-mono">{harness.installHint}</code>
            </p>
          )}
          {/* Reached with a role that changed meanwhile (demoted while drafting): Create is off, with the reason. */}
          {cloud && cloud.mayStart === false && (
            <div className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning" role="note" data-testid="cloud-start-locked">
              {NEW_SESSION_ADMIN_REASON}
            </div>
          )}
          {error && (
            <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error} <AgentLoginsLink message={error} organizationId={errorOrg} className="ml-1 align-baseline text-foreground" />
            </div>
          )}
          {cloud && error && limitOrg && <RunningLimitNotice orgId={limitOrg} />}
        </div>
      </div>
    </div>
  );
}
