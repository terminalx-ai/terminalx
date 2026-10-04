import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Cloud, FolderOpen, FolderGit2, GitBranch, Loader2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { DictationStatus, MicButton, NEW_SESSION_TARGET, useDictationInto, useDictationShortcuts } from "@/components/chat/Dictation";
import { insertNewLine } from "@/components/chat/Composer";
import { AttachButton, AttachmentThumbs, DropHint, useImageAttachments } from "@/components/chat/useImageAttachments";
import { RaccoonScene } from "@/components/raccoon/Raccoon";
import { isRoleRefusal, refreshAccountRoles } from "@/lib/accountRoles";
import { api, errorMessage, type ImageInput } from "@/lib/api";
import { addProject, clearNewSessionPreset, startCloudSessionIn, selectProject, selectProjectInSidebar, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { PERMISSION_MODES } from "@/lib/models";
import { useSessionAgent } from "@/lib/useSessionAgent";
import { SessionAgentControls } from "./SessionAgentControls";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { chooseMode } from "@/lib/dialogs";
import { keycaps, matchesShortcut, useKeymap } from "@/lib/shortcuts";
import { stopDictation } from "@/lib/dictation";
import { cn } from "@/lib/cn";
import type { WorkStatus } from "@/types/session";
import { WorkspaceNameEditor } from "./WorkspaceNameEditor";
import { CloudCreateConfirm, cloudStartError, useCloudDraft, useCloudProjectChoices } from "./CloudNewSession";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { RunningLimitNotice } from "@/components/cloud/RunningLimitNotice";
import { NEW_SESSION_ADMIN_REASON } from "@/lib/cloudCollab";
import { RUNNING_LIMIT_CODE, runningLimitMessage, runningLimitReached } from "@/lib/runningLimit";
import { confirmCloudCreate, planCloudStart, prepareCloudCreate, startInWorkspace, type CloudSessionRequest, type PreparedCreate } from "@/lib/cloudNewSession";

/**
 * Where a session is born. The box sits at the bottom, where the composer
 * will be once the session exists, so the first prompt and every follow-up
 * are typed in the same place; the raccoon keeps the empty space above.
 */
export function NewSessionView({
  onCreated,
  useWorktree: controlledUseWorktree,
  onUseWorktreeChange,
}: {
  onCreated?: (sessionId: string, tabId: string, firstPrompt: string, images: ImageInput[]) => void;
  useWorktree?: boolean;
  onUseWorktreeChange?: (value: boolean) => void;
}) {
  const store = useSessionStore();
  const prefs = usePrefs();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The organization whose running limit refused the last cloud start, to offer stopping a workspace. */
  const [limitOrg, setLimitOrg] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [localUseWorktree, setLocalUseWorktree] = useState(prefs.useWorktree);
  const ref = useRef<HTMLTextAreaElement>(null);
  const setUseWorktree = onUseWorktreeChange ?? setLocalUseWorktree;
  // A cloud project's `+` (PRO-23): the same form, run in the organization's cloud.
  const cloud = useCloudDraft();
  const cloudChoices = useCloudProjectChoices();
  // Opens on a click (also one sent through the accessibility tree), not only on pointerdown or Enter.
  const projectMenu = useRowMenu();
  const modeMenu = useRowMenu();
  const [confirm, setConfirm] = useState<PreparedCreate | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const preset = store.newSessionPreset;
  // The rail is what the reader last pointed at, so it beats the project they
  // happened to start a session in some other day; a preset beats both.
  const wanted = preset?.projectPath ?? store.selectedProject ?? prefs.lastProject;
  const project = store.projects.find((p) => p.path === wanted) ?? store.projects[0] ?? null;
  const isGit = cloud ? true : project?.kind !== "folder";
  const useWorktree = isGit && (controlledUseWorktree ?? localUseWorktree);
  const agentSelection = useSessionAgent(store.harnesses, !cloud);
  const { harness, modelId, effort } = agentSelection;
  // A cloud session runs the agent installed on the workspace, not on this computer.
  const available = cloud ? !!harness : (harness?.available ?? false);
  const mode = PERMISSION_MODES.find((m) => m.id === prefs.lastMode)
    ?? PERMISSION_MODES.find((m) => m.id === "bypassPermissions")!;
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

  const pickProject = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Choose a project" });
      if (typeof dir === "string") {
        const p = await addProject(dir);
        setPrefs({ lastProject: p.path });
        selectProjectInSidebar(p.path);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const dictation = useDictationInto(NEW_SESSION_TARGET, text, setText, ref);
  useDictationShortcuts(dictation);
  const keymap = useKeymap();
  const sendKeys = keymap["composer.send"][0];
  const newLineKeys = keymap["composer.newLine"][0];
  const attach = useImageAttachments({ textareaRef: ref, draft: text, onDraftChange: setText });
  const hasImages = attach.attachments.length > 0;

  // A screenshot alone is a prompt, as it is in the session composer.
  const canSend = useMemo(
    () =>
      cloud
        ? !!cloud.project && !!harness && text.trim().length > 0 && !hasImages && !busy && !confirm && cloud.project.selected && cloud.mayStart === true
        : !!project && !!harness && available && (text.trim().length > 0 || hasImages) && (!useWorktree || !!preset?.cwd || !!workspaceName) && !busy,
    [cloud, project, harness, available, text, hasImages, useWorktree, preset?.cwd, workspaceName, busy, confirm],
  );

  const cloudRequest = (): CloudSessionRequest => ({
    agent: harness!.id,
    model: modelId,
    effort,
    mode: prefs.lastMode,
    prompt: text,
    useWorktree,
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
    setError(atRunningLimit ? runningLimitMessage(orgId) : cloudStartError(e));
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

  const create = async () => {
    if (cloud) return createCloud();
    if (!project || !harness || !canSend) return;
    if (dictation.dictating) await stopDictation();
    setBusy(true);
    setError(null);
    try {
      // The backend names an untitled session itself, so an image-only prompt
      // sends an empty title rather than inventing one here.
      const title = text.trim().split("\n")[0].slice(0, 60);
      const images = attach.images;
      const s = await api.createSession({
        projectPath: project.path,
        title,
        useWorktree: preset?.cwd ? false : useWorktree,
        onMain: !preset?.cwd && !useWorktree,
        worktreeName: !preset?.cwd && useWorktree ? workspaceName : null,
        cwd: preset?.cwd ?? null,
        tab: { harness: harness.id, model: modelId, effort, permissionMode: prefs.lastMode },
      });
      upsertSession(s);
      setText("");
      attach.clear();
      selectSession(s.id);
      onCreated?.(s.id, s.tabs[0].id, text, images);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pill = "gap-1.5";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-end px-6">
        <div className="w-full max-w-3xl">
          <div className="mb-2 flex items-baseline gap-3 px-1">
            <h1 className="text-xl font-semibold tracking-tight">What are we working on?</h1>
            {cloud ? (
              <span className="flex min-w-0 items-center gap-2 truncate text-sm text-muted-foreground">
                in <span className="truncate text-foreground">{cloud.project?.fullName ?? "a cloud project"}</span>
              </span>
            ) : project && (
              <span className="truncate text-sm text-muted-foreground">
                in <span className="text-foreground">{project.name}</span>
                {workspace && (
                  <>
                    {" "}
                    · <span className="font-mono text-foreground">{workspace.branch ?? workspace.name}</span>
                  </>
                )}
              </span>
            )}
          </div>
          <RaccoonScene className="mb-2" />
        </div>
      </div>

      <div className="shrink-0 px-6 pb-4">
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <DropdownMenu {...projectMenu.root}>
              <DropdownMenuTrigger asChild {...projectMenu.trigger}>
                <Button variant="secondary" size="sm" className={pill}>
                  {cloud ? <Cloud /> : isGit ? <FolderGit2 /> : <FolderOpen />}
                  {cloud ? (cloud.project?.fullName ?? "Cloud project") : (project?.name ?? "Choose project")}
                  <ChevronDown className="text-faint" />
                </Button>
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

            <SessionAgentControls selection={agentSelection} />

            <DropdownMenu {...modeMenu.root}>
              <DropdownMenuTrigger asChild {...modeMenu.trigger}>
                <Button variant="secondary" size="sm" className={pill}>
                  {mode.label}
                  <ChevronDown className="text-faint" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[14rem]">
                <DropdownMenuLabel>Permissions</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={mode.id} onValueChange={(v) => chooseMode(harness?.id ?? "", v, (m) => setPrefs({ lastMode: m }))}>
                  {PERMISSION_MODES.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-col items-start gap-0">
                      <span>{m.label}</span>
                      <span className="text-[11px] text-faint">{m.hint}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {cloud ? (
              <>
                <span className="ml-1 flex items-center gap-1 rounded-full border border-hairline px-2 py-0.5 text-xs text-muted-foreground" data-testid="cloud-runs-in" title="The agent, its terminals and its files run on a cloud workspace of the organization, not on this computer.">
                  <Cloud className="size-3.5" /> Runs in: <span className="text-foreground">{cloud.orgName} cloud</span>
                </span>
                <div className="ml-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch size="sm" checked={useWorktree} onCheckedChange={setUseWorktree} aria-label="New worktree on the cloud workspace" />
                  <span className="flex items-center gap-1">
                    <GitBranch className="size-3.5" />
                    {useWorktree ? "New worktree on the workspace" : "Work in the workspace's checkout"}
                  </span>
                </div>
              </>
            ) : !isGit ? (
              <span className="ml-1 flex items-center gap-1 text-xs text-muted-foreground" title="Agents, terminals, and files are available. Git features require a repository.">
                <FolderOpen className="size-3.5" /> Folder · no Git
              </span>
            ) : preset?.cwd ? (
              <span className="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3.5" />
                In workspace <span className="font-mono text-foreground">{workspace?.name ?? preset.cwd.split("/").pop()}</span>
              </span>
            ) : (
              <div className="ml-1 flex items-center gap-2 text-xs text-muted-foreground">
                <Switch size="sm" checked={useWorktree} onCheckedChange={setUseWorktree} />
                <span className="flex items-center gap-1">
                  <GitBranch className="size-3.5" />
                  {useWorktree ? (
                    <>
                      New worktree from <span className="text-foreground">{status?.defaultBranch ?? "default"}</span>
                      {workspaceName && project && (
                        <>
                          <span className="text-faint">·</span>
                          <WorkspaceNameEditor
                            value={workspaceName}
                            onCommit={async (requested) => {
                              const canonical = await api.previewWorkspaceName(project.path, requested);
                              setWorkspaceName(canonical);
                              return canonical;
                            }}
                            onError={setError}
                            className="max-w-48 text-foreground"
                          />
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      Work on <span className="text-foreground">{status?.branch ?? "current branch"}</span>
                    </>
                  )}
                </span>
              </div>
            )}
          </div>

          <DictationStatus dictation={dictation} />
          {cloud && confirm && (
            <CloudCreateConfirm prepared={confirm} orgName={cloud.orgName} busy={busy} onConfirm={() => void confirmCreate()} onCancel={() => setConfirm(null)} />
          )}
          {cloud && starting && (
            <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground" role="status" data-testid="cloud-start-status">
              {busy && <Loader2 className="size-3.5 animate-spin" />} {starting}
            </div>
          )}

          <div className={cn("relative rounded-2xl bg-composer glass p-3 shadow-surface hairline", attach.dragging && "ring-2 ring-accent/60")} {...attach.dropZoneProps}>
            <DropHint dragging={attach.dragging} />
            <AttachmentThumbs attach={attach} />
            <textarea
              ref={ref}
              autoFocus
              data-new-session-prompt
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
              rows={3}
              placeholder={
                cloud
                  ? "Describe the task. It runs in the cloud."
                  : !project
                  ? "Add a project to get started."
                  : preset?.cwd
                    ? "Describe the task. It runs in this workspace."
                    : useWorktree
                      ? "Describe the task. A worktree is created when you send."
                      : "Describe the task."
              }
              className="w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-faint"
            />
            <div className="flex items-center gap-1 pt-1">
              {!cloud && <AttachButton attach={attach} />}
              <MicButton dictation={dictation} />
              <div className="min-w-0 text-xs text-faint">
                {!cloud && harness && !available ? (
                  <span className="text-warning">
                    {harness.name} isn't installed. <code className="font-mono">{harness.installHint}</code>
                  </span>
                ) : (
                  <>
                    {sendKeys && (
                      <>
                        <kbd className="rounded-sm bg-veil-raised px-1 font-sans">{keycaps(sendKeys).join("")}</kbd> to send
                      </>
                    )}
                    {sendKeys && newLineKeys && ", "}
                    {newLineKeys && (
                      <>
                        <kbd className="rounded-sm bg-veil-raised px-1 font-sans">{keycaps(newLineKeys).join("")}</kbd> for a new line
                      </>
                    )}
                  </>
                )}
              </div>
              <Button size="sm" variant="accent" className="ml-auto" disabled={!canSend} onClick={create}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                Start
              </Button>
            </div>
          </div>
          {/* Reached with a role that changed meanwhile (demoted while drafting): Start is off, with the reason. */}
          {cloud && cloud.mayStart === false && (
            <div className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning" role="note" data-testid="cloud-start-locked">
              {NEW_SESSION_ADMIN_REASON}
            </div>
          )}
          {error && <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
          {cloud && error && limitOrg && <RunningLimitNotice orgId={limitOrg} />}
        </div>
      </div>
    </div>
  );
}
