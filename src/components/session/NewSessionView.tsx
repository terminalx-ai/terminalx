import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderGit2, GitBranch, Loader2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { DictationStatus, MicButton, NEW_SESSION_TARGET, useDictationInto } from "@/components/chat/Dictation";
import { RaccoonScene } from "@/components/raccoon/Raccoon";
import { api, errorMessage } from "@/lib/api";
import { addProject, clearNewSessionPreset, selectProject, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { EFFORT_LABEL, PERMISSION_MODES, refreshModels, upgradeHint, useModels } from "@/lib/models";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { chooseMode } from "@/lib/dialogs";
import { useHotkey } from "@/lib/hotkeys";
import { stopDictation } from "@/lib/dictation";
import { cn } from "@/lib/cn";
import type { WorkStatus } from "@/types/session";

/**
 * Where a session is born. The box sits at the bottom, where the composer
 * will be once the session exists, so the first prompt and every follow-up
 * are typed in the same place; the raccoon keeps the empty space above.
 */
export function NewSessionView({ onCreated }: { onCreated?: (sessionId: string, tabId: string, firstPrompt: string) => void }) {
  const store = useSessionStore();
  const prefs = usePrefs();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const preset = store.newSessionPreset;
  // The rail is what the reader last pointed at, so it beats the project they
  // happened to start a session in some other day; a preset beats both.
  const wanted = preset?.projectPath ?? store.selectedProject ?? prefs.lastProject;
  const project = store.projects.find((p) => p.path === wanted) ?? store.projects[0] ?? null;
  const harness = store.harnesses.find((h) => h.id === prefs.lastAgent) ?? store.harnesses[0] ?? null;
  const available = harness?.available ?? false;
  const models = useModels(harness?.id);
  const modelId = harness ? (prefs.lastModel[harness.id] ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? "") : "";
  const model = models.find((m) => m.id === modelId) ?? null;
  const effort = harness ? (prefs.lastEffort[harness.id] ?? model?.defaultEffort ?? null) : null;
  const mode = PERMISSION_MODES.find((m) => m.id === prefs.lastMode) ?? PERMISSION_MODES[0];
  const workspace = preset?.cwd ? (store.workspaces[preset.projectPath] ?? []).find((w) => w.path === preset.cwd) ?? null : null;

  useEffect(() => () => clearNewSessionPreset(), []);

  useEffect(() => {
    let cancelled = false;
    const at = preset?.cwd ?? project?.path;
    if (!at) return setStatus(null);
    api.workStatus(at).then((s) => !cancelled && setStatus(s)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, preset]);

  const pickProject = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Choose a project" });
      if (typeof dir === "string") {
        const p = await addProject(dir);
        setPrefs({ lastProject: p.path });
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const focusInput = useCallback(() => ref.current?.focus(), []);
  const dictation = useDictationInto(NEW_SESSION_TARGET, text, setText, focusInput);
  useHotkey("mod+shift+d", dictation.toggle);

  const canSend = useMemo(() => !!project && !!harness && available && text.trim().length > 0 && !busy, [project, harness, available, text, busy]);

  const create = async () => {
    if (!project || !harness || !canSend) return;
    if (dictation.dictating) await stopDictation();
    setBusy(true);
    setError(null);
    try {
      const title = text.trim().split("\n")[0].slice(0, 60);
      const s = await api.createSession({
        projectPath: project.path,
        title,
        useWorktree: preset?.cwd ? false : prefs.useWorktree,
        cwd: preset?.cwd ?? null,
        tab: { harness: harness.id, model: modelId, effort, permissionMode: prefs.lastMode },
      });
      upsertSession(s);
      setText("");
      selectSession(s.id);
      onCreated?.(s.id, s.tabs[0].id, text);
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
            {project && (
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className={pill}>
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
                      clearNewSessionPreset();
                      setPrefs({ lastProject: p.path });
                      void selectProject(p.path);
                    }}
                  >
                    <FolderGit2 className={cn(p.path === project?.path && "text-foreground")} />
                    <span className="truncate">{p.name}</span>
                  </DropdownMenuItem>
                ))}
                {store.projects.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={pickProject}>Add a project…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className={pill}>
                  {harness && <AgentMark id={harness.id} className="size-3.5" />}
                  {harness?.name ?? "Agent"}
                  <ChevronDown className="text-faint" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Agent</DropdownMenuLabel>
                {store.harnesses.map((h) => (
                  <DropdownMenuItem key={h.id} disabled={!h.available} onSelect={() => setPrefs({ lastAgent: h.id })}>
                    <AgentMark id={h.id} />
                    <span>{h.name}</span>
                    {!h.available && <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {harness && models.length > 0 && (
              <DropdownMenu onOpenChange={(open) => open && void refreshModels()}>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" className={pill}>
                    {model?.label ?? modelId ?? "Model"}
                    <ChevronDown className="text-faint" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[12rem]">
                  <DropdownMenuLabel>Model</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={modelId} onValueChange={(v) => setPrefs({ lastModel: { ...prefs.lastModel, [harness.id]: v } })}>
                    {models.map((m) => {
                      const upgrade = upgradeHint(m, models);
                      return (
                        <DropdownMenuRadioItem key={m.id} value={m.id}>
                          {m.label}
                          {upgrade ? <span className="ml-1.5 text-faint">→ {upgrade}</span> : null}
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {harness && model && model.efforts.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" className={pill}>
                    {effort ? (EFFORT_LABEL[effort] ?? effort) : "Effort"}
                    <ChevronDown className="text-faint" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>Effort</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={effort ?? ""} onValueChange={(v) => setPrefs({ lastEffort: { ...prefs.lastEffort, [harness.id]: v } })}>
                    {model.efforts.map((e) => (
                      <DropdownMenuRadioItem key={e} value={e}>
                        {EFFORT_LABEL[e] ?? e}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
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

            {preset?.cwd ? (
              <span className="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3.5" />
                In workspace <span className="font-mono text-foreground">{workspace?.name ?? preset.cwd.split("/").pop()}</span>
              </span>
            ) : (
              <label className="ml-1 flex items-center gap-2 text-xs text-muted-foreground">
                <Switch size="sm" checked={prefs.useWorktree} onCheckedChange={(v) => setPrefs({ useWorktree: v })} />
                <span className="flex items-center gap-1">
                  <GitBranch className="size-3.5" />
                  {prefs.useWorktree ? (
                    <>
                      New worktree from <span className="text-foreground">{status?.defaultBranch ?? "default"}</span>
                    </>
                  ) : (
                    <>
                      Work on <span className="text-foreground">{status?.branch ?? "current branch"}</span>
                    </>
                  )}
                </span>
              </label>
            )}
          </div>

          <DictationStatus dictation={dictation} />

          <div className="rounded-2xl bg-composer glass p-3 shadow-surface hairline">
            <textarea
              ref={ref}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void create();
                }
              }}
              rows={3}
              placeholder={
                !project
                  ? "Add a project to get started."
                  : preset?.cwd
                    ? "Describe the task. It runs in this workspace."
                    : prefs.useWorktree
                      ? "Describe the task. A worktree is created when you send."
                      : "Describe the task."
              }
              className="w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-faint"
            />
            <div className="flex items-center gap-1 pt-1">
              <MicButton dictation={dictation} />
              <div className="min-w-0 text-xs text-faint">
                {harness && !available ? (
                  <span className="text-warning">
                    {harness.name} isn't installed. <code className="font-mono">{harness.installHint}</code>
                  </span>
                ) : (
                  <>
                    <kbd className="rounded-sm bg-veil-raised px-1 font-sans">⏎</kbd> to send, <kbd className="rounded-sm bg-veil-raised px-1 font-sans">⇧⏎</kbd> for a new line
                  </>
                )}
              </div>
              <Button size="sm" variant="accent" className="ml-auto" disabled={!canSend} onClick={create}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                Start
              </Button>
            </div>
          </div>
          {error && <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
        </div>
      </div>
    </div>
  );
}
