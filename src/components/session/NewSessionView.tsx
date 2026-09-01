import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FolderGit2, GitBranch, Loader2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { api, errorMessage } from "@/lib/api";
import { addProject, selectProject, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import type { WorkStatus } from "@/types/session";

/**
 * The empty state: where a session is born. Reading order is top to bottom —
 * the settings, then the box they apply to — so the toolbar sits above the
 * textarea here, unlike the composer inside a session.
 */
export function NewSessionView({ onCreated }: { onCreated?: (sessionId: string, tabId: string, firstPrompt: string) => void }) {
  const store = useSessionStore();
  const prefs = usePrefs();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkStatus | null>(null);

  const project = store.projects.find((p) => p.path === prefs.lastProject) ?? store.projects[0] ?? null;
  const harness = store.harnesses.find((h) => h.id === prefs.lastAgent) ?? store.harnesses[0] ?? null;
  const available = harness?.available ?? false;

  useEffect(() => {
    let cancelled = false;
    if (!project) return setStatus(null);
    api.workStatus(project.path).then((s) => !cancelled && setStatus(s)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project]);

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

  const canSend = useMemo(() => !!project && !!harness && available && text.trim().length > 0 && !busy, [
    project,
    harness,
    available,
    text,
    busy,
  ]);

  const create = async () => {
    if (!project || !harness || !canSend) return;
    setBusy(true);
    setError(null);
    try {
      const title = text.trim().split("\n")[0].slice(0, 60);
      const s = await api.createSession({
        projectPath: project.path,
        title,
        useWorktree: prefs.useWorktree,
        tab: {
          harness: harness.id,
          model: prefs.lastModel[harness.id] ?? "",
          effort: prefs.lastEffort[harness.id] ?? null,
          permissionMode: prefs.lastMode,
        },
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

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto scrollbar-thin px-6 pt-[13vh]">
      <div className="w-full max-w-2xl">
        <div className="mb-5 flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">What are we working on?</h1>
          {project && (
            <span className="truncate text-sm text-muted-foreground">
              in <span className="text-foreground">{project.name}</span>
            </span>
          )}
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-1.5">
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
              <Button variant="secondary" size="sm" className="gap-1.5">
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
        </div>

        <div className="rounded-2xl bg-composer glass p-3 shadow-surface hairline">
          <textarea
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
              project
                ? "Describe the task. A worktree is created when you send."
                : "Add a project to get started."
            }
            className="w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-faint"
          />
          <div className="flex items-center justify-between pt-1">
            <div className="text-xs text-faint">
              {harness && !available ? (
                <span className="text-warning">
                  {harness.name} isn't installed. <code className="font-mono">{harness.installHint}</code>
                </span>
              ) : (
                <>
                  <kbd className="rounded-sm bg-veil-raised px-1 font-sans">⏎</kbd> to send,{" "}
                  <kbd className="rounded-sm bg-veil-raised px-1 font-sans">⇧⏎</kbd> for a new line
                </>
              )}
            </div>
            <Button size="sm" variant="accent" disabled={!canSend} onClick={create}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Start
            </Button>
          </div>
        </div>
        {error && <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      </div>
    </div>
  );
}
