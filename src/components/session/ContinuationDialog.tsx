import { useEffect, useRef, useState } from "react";
import { GitBranch, LoaderCircle } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { agent, api, errorMessage } from "@/lib/api";
import { continuationPrompt, launchContinuation, moveChatToProject, type ContextMode, type ContinuationContext, type Launched } from "@/lib/continuation";
import { loadModels, useModels } from "@/lib/models";
import { usePrefs } from "@/lib/prefs";
import { handoffStart, launchSettingsOf, useSessionAgent, type LaunchSettings } from "@/lib/useSessionAgent";
import { SessionAgentControls } from "./SessionAgentControls";
import type { HarnessInfo, Project, SessionEntry, TabEntry } from "@/types/session";

/**
 * A new agent conversation with the context of an existing one, launched with
 * the same settings controls as New Session. Without `into` it is Continue in
 * New Session: a tab beside the source, in the same workspace. With it, a chat
 * moves into a project: a new session starts there, and the chat is archived
 * once it has. The settings are this launch's own: what is picked here is not
 * saved as a preference.
 *
 * Mounted afresh for each opening: no stale selection, mode, or errors. The
 * source stays pinned even when creation selects the destination underneath.
 * Once the destination exists the reader may leave while it starts; a failure
 * after that goes to `onLateError`, if given, rather than nowhere.
 */
export function ContinuationDialog({ session, source, into, onClose, onLateError }: {
  session: SessionEntry; source: TabEntry; onClose: () => void;
  into?: { project: Project; worktree: boolean };
  onLateError?: (error: string) => void;
}) {
  const [context, setContext] = useState<ContinuationContext | null>(null);
  const [providers, setProviders] = useState<HarnessInfo[]>([]);
  const [mode, setMode] = useState<ContextMode>("focused");
  const [worktree, setWorktree] = useState(into?.worktree ?? false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [destination, setDestination] = useState<Launched>();
  // The prompt went, or may have: nothing is left to retry, only the destination to open.
  const [sent, setSent] = useState(false);
  const startingRef = useRef(false);
  const preparedPrompt = useRef<string | undefined>(undefined);
  const active = useRef(true);
  const [chosen, setChosen] = useState<LaunchSettings | null>(null);
  const models = useModels();
  const prefs = usePrefs();
  // Until the reader changes something, the source conversation's own settings, as valid as they can be made.
  const value = chosen ?? (loading ? null : handoffStart(launchSettingsOf(source), providers, models, prefs));
  const selection = useSessionAgent(providers, true, null, value ? { value, onChange: setChosen } : undefined);
  const settings = value && selection.harness
    ? { harness: selection.harness.id, model: selection.modelId, effort: selection.effort, permissionMode: selection.mode }
    : null;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const close = () => {
    if (!active.current) return;
    active.current = false;
    onClose();
  };

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    setContext(null);
    setProviders([]);
    // The model list too, so the source's model is checked against it before anything can start.
    Promise.allSettled([agent.prepareContinuation(session.id, source.id), api.listHarnesses(), loadModels()]).then(([prepared, detected]) => {
      if (canceled) return;
      const errors: string[] = [];
      if (prepared.status === "fulfilled") setContext(prepared.value);
      else errors.push(`Could not prepare context: ${errorMessage(prepared.reason)}`);
      if (detected.status === "fulfilled") {
        setProviders(detected.value);
        if (!detected.value.some((p) => p.available)) errors.push("No installed, available providers were found. Install Claude Code or Codex, then retry.");
      } else errors.push(`Could not detect providers: ${errorMessage(detected.reason)}`);
      setError(errors.join(" ") || null);
      setLoading(false);
    });
    return () => { canceled = true; };
  }, [session.id, source.id, attempt]);

  const start = async () => {
    if (startingRef.current || !context || !settings || sent) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const prompt = preparedPrompt.current ?? continuationPrompt(context, mode, into?.project.path);
      preparedPrompt.current = prompt;
      const created = (launched: Launched) => {
        if (active.current) setDestination(launched);
      };
      const result = into
        ? await moveChatToProject({ id: session.id, title: source.title?.trim() || session.title }, { projectPath: into.project.path, worktree }, settings, prompt, created, destination)
        : await launchContinuation(context, settings, prompt, created, destination);
      if (!active.current) {
        if (result.stage !== "delivered") onLateError?.(result.error);
        return;
      }
      if (result.stage === "delivered") close();
      else {
        setError(result.error);
        setSent(result.stage !== "launch");
        if (!result.launched) preparedPrompt.current = undefined;
      }
    } catch (e) {
      if (active.current) setError(errorMessage(e));
      else onLateError?.(errorMessage(e));
    } finally {
      startingRef.current = false;
      if (active.current) setStarting(false);
    }
  };
  const sourceActive = context?.sourceActive || source.status === "in_progress" || source.status === "waiting";
  const canClose = !starting || !!destination;
  const locked = starting || !!destination;
  const isGit = into?.project.kind !== "folder";
  return (
    <Dialog open onOpenChange={(open) => { if (!open && canClose) close(); }}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto" showClose={canClose} onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{into ? "Link to a Project" : "Continue in New Session"}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {into
              ? `Start a new session in ${into.project.name} with context from this chat. The chat is archived once the new session has started.`
              : "Start a fresh agent conversation in this workspace with context from the current conversation."}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Source conversation</dt><dd className="break-words">{context?.title ?? source.title ?? session.title}</dd>
          <dt className="text-muted-foreground">Original provider</dt><dd>{providers.find((p) => p.id === source.harness)?.name ?? source.harness}</dd>
          {into ? <>
            <dt className="text-muted-foreground">Project</dt><dd className="break-words">{into.project.name}</dd>
            <dt className="text-muted-foreground">Folder</dt><dd className="break-all font-mono">{into.project.path}</dd>
          </> : <>
            <dt className="text-muted-foreground">Working directory</dt><dd className="break-all font-mono">{context?.cwd ?? session.cwd}</dd>
          </>}
        </dl>
        {into ? (
          isGit ? (
            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Switch size="sm" checked={worktree} onCheckedChange={setWorktree} disabled={locked} aria-label="Start on a new branch in a worktree" />
              <span className="flex items-center gap-1"><GitBranch className="size-3.5" />{worktree ? "On a new branch (worktree)" : "In its main checkout, shared with its other conversations"}</span>
            </label>
          ) : <p className="mt-3 text-xs text-muted-foreground">In the folder · no Git</p>
        ) : <p className="mt-3 text-xs text-muted-foreground">The source conversation stays open. Both conversations share the same branch, files, and uncommitted changes.</p>}
        {sourceActive && <p role="status" className="mt-2 text-xs text-muted-foreground">Source work may still be progressing. This uses available saved context without interrupting the source turn or answering its pending permissions.</p>}
        {loading ? <p role="status" className="mt-4 flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />Preparing context and detecting providers…</p> : <>
          <div role="group" aria-label="New session settings" className="mt-4 flex flex-col gap-1.5">
            <span className="text-sm font-medium">New session</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <SessionAgentControls selection={selection} disabled={locked} />
            </div>
          </div>
          <fieldset disabled={locked} className="mt-4 space-y-3">
            <legend className="mb-2 text-sm font-medium">Context mode</legend>
            <label className="flex items-start gap-2 text-sm"><input type="radio" name="continuation-mode" value="focused" checked={mode === "focused"} onChange={() => setMode("focused")} className="mt-1" /><span>Focused handoff (Recommended)<span className="mt-1 block text-xs text-muted-foreground">Start with recent status and the current workspace; read older history only when needed. No extra AI summary step.</span></span></label>
            <label className="flex items-start gap-2 text-sm"><input type="radio" name="continuation-mode" value="full" checked={mode === "full"} disabled={!context?.transcriptPath} aria-describedby="full-context-help" onChange={() => setMode("full")} className="mt-1" /><span>Full session transcript<span id="full-context-help" className="mt-1 block text-xs text-muted-foreground">{context?.transcriptPath ? "Read the complete saved history before continuing. This can take longer and consume more context, plan usage, or API credits." : context?.fullUnavailableReason ?? "Complete transcript availability could not be established."}</span></span></label>
          </fieldset>
          {context?.partialCapture && <p className="mt-3 text-xs text-muted-foreground">Focused mode will use a bounded partial capture of recent saved conversation history. Older content is omitted.</p>}
        </>}
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={!canClose} onClick={close}>{destination ? "Open New Session" : "Cancel"}</Button>
          {!loading && (!context || !settings) && <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
          {!sent && <Button disabled={loading || starting || !context || !settings} onClick={() => void start()}>{starting ? <><LoaderCircle className="size-4 animate-spin" />Starting…</> : destination ? "Retry Start" : into ? "Link and Start" : "Start New Session"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
