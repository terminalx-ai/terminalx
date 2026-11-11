import { usePipelineLaunch, pipelineSettings } from "@/lib/pipelineLaunch";
import { pipelineForSession, useIssuePipelines } from "@/lib/issuePipeline";
import { useSessionStore } from "@/lib/sessions";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { GitBranch, LoaderCircle } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { agent, api, errorMessage, onPromptDelivery, type DeliveryStage } from "@/lib/api";
import { continuationPrompt, launchContinuation, moveChatToProject, type ContextMode, type ContinuationContext, type Launched } from "@/lib/continuation";
import { loadModels, useModels } from "@/lib/models";
import { usePrefs } from "@/lib/prefs";
import { handoffStart, launchSettingsOf, useSessionAgent, type LaunchSettings } from "@/lib/useSessionAgent";
import { SessionAgentControls } from "./SessionAgentControls";
import { PipelineLaunchControls } from "./PipelineLaunchControls";
import { HandoffScene } from "./HandoffScene";
import { Fold } from "@/components/ui/Fold";
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
 *
 * While the handoff is delivered the dialog says where it has got to, as the
 * new tab tells it. A handoff the agent has not taken but holds in its input
 * is one Enter from sent, and the dialog offers that Enter. Whenever the agent
 * does take it, even after the dialog said it could not confirm it, the
 * dialog closes as it would have on success (#662).
 */
export function ContinuationDialog({ session, source, into, initialHarness, reviewPrompt, onClose, onLateError, onDelivered }: {
  session: SessionEntry; source: TabEntry; onClose: () => void;
  /** The new session took the handoff, just before the dialog closes: where it went (#815). */
  onDelivered?: (to: { sessionId: string; tabId: string }) => void;
  into?: { project: Project; worktree: boolean };
  /** The installed counterpart selected by a handoff entry point. */
  initialHarness?: string;
  /** A finished turn's review starts immediately, without taking over its pipeline. */
  reviewPrompt?: string;
  onLateError?: (error: string) => void;
}) {
  const [context, setContext] = useState<ContinuationContext | null>(null);
  const [providers, setProviders] = useState<HarnessInfo[]>([]);
  const [mode, setMode] = useState<ContextMode>("focused");
  const [worktree, setWorktree] = useState(into?.worktree ?? false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [destination, setDestination] = useState<Launched>();
  // The prompt went, or may have: nothing is left to retry, only the destination to open.
  const [sent, setSent] = useState(false);
  // How far the handoff has got; "delivered" closes the dialog instead.
  const [progress, setProgress] = useState<Exclude<DeliveryStage, "delivered"> | null>(null);
  // The handoff the agent holds in its input, for the Enter that sends it.
  const [inInput, setInInput] = useState<{ seq: number; pressed: boolean } | null>(null);
  const [pressing, setPressing] = useState(false);
  const startingRef = useRef(false);
  const autoStarted = useRef(false);
  const preparedPrompt = useRef<string | undefined>(undefined);
  const active = useRef(true);
  const [chosen, setChosen] = useState<LaunchSettings | null>(null);
  const models = useModels();
  const prefs = usePrefs();
  // Until the reader changes something, the source conversation's own settings, as valid as they can be made.
  const value = chosen ?? (loading ? null : handoffStart(
    { ...launchSettingsOf(source), ...(reviewPrompt ? { permissionMode: "plan" } : {}) },
    initialHarness ? providers.filter((provider) => provider.id === initialHarness) : providers, models, prefs,
  ));
  const selection = useSessionAgent(providers, true, null, value ? { value, onChange: setChosen } : undefined);
  const store = useSessionStore();
  const project = into?.project ?? store.projects.find((project) => project.path === session.projectPath);
  const pipelines = useIssuePipelines();
  // Continuing here hands this session's pipeline to the new conversation, and
  // an off sent with it is a revocation: the switches start as the pipeline
  // holds them, so leaving them alone changes nothing (#700). A merged one is
  // history and is not handed on; with none, they start at the project's
  // defaults for a session, as automation is not what is being started here.
  const held = !into ? pipelineForSession(pipelines, session.id) : null;
  const carried = held?.role === "author" && held.pipeline.state !== "merged" ? { autoMerge: held.pipeline.autoMerge, resolveConflicts: held.pipeline.resolveConflicts ?? false } : "session";
  const pipelineLaunch = usePipelineLaunch(project?.path ?? null, pipelineSettings(project), !project || (into && !worktree) ? "Choose a worktree branch to automate this session." : undefined, undefined, carried);
  const settings = value && selection.harness
    ? { harness: selection.harness.id, model: selection.modelId, effort: selection.effort, permissionMode: selection.mode, ...(!reviewPrompt && (!into || pipelineLaunch.value.autoMerge || pipelineLaunch.value.resolveConflicts) ? { pipeline: pipelineLaunch.value } : {}) }
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
  // Where the handoff went, told once it is delivered.
  const launched = useRef<Launched | undefined>(undefined);
  const delivered = () => {
    if (active.current && launched.current) onDelivered?.({ sessionId: launched.current.sessionId, tabId: launched.current.tab.id });
    close();
  };

  useEffect(() => {
    if (!destination) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void onPromptDelivery(destination.sessionId, destination.tab.id, (stage) => {
      if (stage === "delivered") delivered();
      else setProgress(stage);
    }).then((unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    });
    return () => {
      gone = true;
      stop?.();
    };
    // `close` reads refs only; the subscription follows the destination.
  }, [destination]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    setContext(null);
    setProviders([]);
    // The model list too, so the source's model is checked against it before anything can start.
    // A turn review needs only that turn's saved content; no full-history export.
    const prepare = reviewPrompt ? Promise.resolve<ContinuationContext>({
      sessionId: session.id, tabId: source.id, title: source.title || session.title,
      cwd: session.cwd, provider: source.harness, providerSessionId: source.providerSessionId ?? null,
      sourceActive: false, transcriptPath: null, fullUnavailableReason: null,
      lastPrompt: null, lastUpdate: null, partialCapture: null,
    }) : agent.prepareContinuation(session.id, source.id);
    Promise.allSettled([prepare, api.listHarnesses(), loadModels()]).then(([prepared, detected]) => {
      if (canceled) return;
      const errors: string[] = [];
      if (prepared.status === "fulfilled") setContext(prepared.value);
      else errors.push(`Could not prepare context: ${errorMessage(prepared.reason)}`);
      if (detected.status === "fulfilled") {
        setProviders(detected.value);
        if (!detected.value.some((p) => p.available)) errors.push("No installed, available providers were found. Install Claude Code or Codex, then retry.");
        else if (initialHarness && !detected.value.some((p) => p.id === initialHarness && p.available)) errors.push("The other agent is no longer installed or available. Retry after installing it.");
      } else errors.push(`Could not detect providers: ${errorMessage(detected.reason)}`);
      setError(errors.join(" ") || null);
      setLoading(false);
    });
    return () => { canceled = true; };
  }, [session.id, source.id, attempt, initialHarness, reviewPrompt]);

  const start = async () => {
    if (startingRef.current || !context || !settings || sent) return;
    startingRef.current = true;
    setStarting(true);
    setDelivering(false);
    setProgress(null);
    setError(null);
    try {
      const prompt = preparedPrompt.current ?? reviewPrompt ?? continuationPrompt(context, mode, into?.project.path);
      preparedPrompt.current = prompt;
      const created = (made: Launched) => {
        launched.current = made;
        if (active.current) setDestination(made);
      };
      const confirming = () => { if (active.current) setDelivering(true); };
      const result = into
        ? await moveChatToProject({ id: session.id, title: source.title?.trim() || session.title }, { projectPath: into.project.path, worktree }, settings, prompt, created, destination, confirming)
        : reviewPrompt
          ? await launchContinuation(context, settings, prompt, created, destination, confirming, "review")
          : await launchContinuation(context, settings, prompt, created, destination, confirming);
      if (!active.current) {
        if (result.stage !== "delivered") onLateError?.(result.error);
        return;
      }
      if (result.stage === "delivered") delivered();
      else if (result.stage === "input") {
        setSent(true);
        setInInput({ seq: result.seq, pressed: false });
      } else {
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
  const readyReview = !!reviewPrompt && !loading && !error && !!settings;
  useEffect(() => {
    if (!active.current || !readyReview || autoStarted.current) return;
    autoStarted.current = true;
    void start();
    // Only the transition to a prepared review schedules a launch. Later
    // settings/delivery renders must not schedule another; retries are explicit.
  }, [readyReview]); // eslint-disable-line react-hooks/exhaustive-deps
  const pressEnter = async () => {
    if (!destination || !inInput || pressing) return;
    setPressing(true);
    setError(null);
    try {
      const pressed = await agent.submitWaiting(destination.sessionId, destination.tab.id, inInput.seq);
      if (!active.current) return;
      if (pressed) setInInput({ ...inInput, pressed: true });
      else {
        setInInput(null);
        setError("The handoff is no longer waiting in the new session's input. Open it to check its chat and terminal.");
      }
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      if (active.current) setPressing(false);
    }
  };
  const agentName = providers.find((p) => p.id === settings?.harness)?.name ?? "the agent";
  const delivery = {
    input_occupied: `Holding off: ${agentName}'s input box already has text in it. Send or clear that text in its terminal, and the handoff follows…`,
    body_written: `Typing the handoff into ${agentName}…`,
    submit_written: `Waiting for ${agentName} to take the handoff…`,
    nudged: `Pressed Enter again: ${agentName} had not taken the handoff yet…`,
    stalled: `Holding off: ${agentName} is not reading its input…`,
  }[progress ?? "body_written"];
  const canClose = !starting || !!destination;
  const locked = starting || !!destination;
  const isGit = into?.project.kind !== "folder";
  return (
    <Dialog open onOpenChange={(open) => { if (!open && canClose) close(); }}>
      <DialogContent width="max-w-[34rem]" className="max-h-[calc(100vh-2rem)] overflow-y-auto p-6" showClose={canClose} onEscapeKeyDown={(e) => e.stopPropagation()}>
        {/* Only what the reader decides here: which agent picks it up and how much context it carries, both in
            view; Autopilot, set less often, is folded away. Where it runs and what it came from are the session they are in; the rest is said
            once, in the line under the title. */}
        <HandoffScene className="mb-8 mt-6" />
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{reviewPrompt ? "Second opinion" : into ? "Link to a Project" : "Continue in New Session"}</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            {reviewPrompt ? `Share the selected turn's prompt, answer and recorded file diffs with ${agentName} for review in a new tab in this workspace.` : into
              ? `Opens a new session in ${into.project.name} that carries over this chat's context. This chat is archived once it starts.`
              : "Opens a new conversation that carries over this chat's context, so the agent picks up where it left off. This chat stays open."}
          </DialogDescription>
        </DialogHeader>
        {reviewPrompt && !loading && settings && <p role="status" className="mt-4 text-xs text-muted-foreground" data-testid="review-settings">
          {agentName} · {selection.model?.label ?? (settings.model || "Agent default")} · Plan (read-only)
        </p>}
        {into && (isGit ? (
          <label className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Switch size="sm" checked={worktree} onCheckedChange={setWorktree} disabled={locked} aria-label="Start on a new branch in a worktree" />
            <span className="flex items-center gap-1"><GitBranch className="size-3.5" />{worktree ? "On a new branch (worktree)" : "In its main checkout, shared with its other conversations"}</span>
          </label>
        ) : <p className="mt-4 text-xs text-muted-foreground">In the folder · no Git</p>)}
        {/* While it reads the context, the same rows with placeholders where the pills will be: the dialog opens at
            its final height and nothing moves when they arrive. */}
        {loading && reviewPrompt ? <p role="status" className="mt-5 flex items-center gap-2 text-xs text-faint"><LoaderCircle className="size-3 animate-spin" />Preparing the review…</p> : loading ? <div className="mt-5 flex flex-col gap-2" data-testid="continuation-loading">
          <span className="flex items-center gap-2 text-xs font-medium text-foreground">Agent<span role="status" className="flex items-center gap-1.5 font-normal text-faint"><LoaderCircle className="size-3 animate-spin" />Preparing context…</span></span>
          <div className="flex gap-1.5" aria-hidden>
            {/* In proportion to the pills they stand for (agent, model, effort, permissions), not fixed widths. */}
            {[8, 6, 4, 10].map((grow) => <span key={grow} className="h-8 basis-0 animate-pulse-soft rounded-md bg-secondary" style={{ flexGrow: grow }} />)}
          </div>
          <span className="mt-4 mb-2 text-xs font-medium text-foreground">Context</span>
          <div className="h-8 animate-pulse-soft rounded-md bg-veil-raised" aria-hidden />
          <p className="text-xs text-faint" aria-hidden>&nbsp;</p>
          <span className="mt-3 h-0" aria-hidden />
        </div> : !reviewPrompt && <>
          {/* Two rows of the same make: a label, then controls across the full width at one height, so the
              pills and the context switch line up edge to edge. */}
          <div role="group" aria-label="New session settings" className="mt-5 flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground">Agent</span>
            <div className="flex min-w-0 flex-nowrap items-center gap-1.5">
              <SessionAgentControls selection={selection} disabled={locked} fill />
            </div>
          </div>
          <fieldset disabled={locked} className="mt-4 flex flex-col gap-2">
            <legend className="mb-2 text-xs font-medium text-foreground">Context</legend>
            <div className="grid h-8 grid-cols-2 gap-0.5 rounded-md bg-veil-raised p-0.5 text-xs">
              <Choice name="continuation-mode" checked={mode === "focused"} onChange={() => setMode("focused")} label="Recent context" />
              <Choice name="continuation-mode" checked={mode === "full"} disabled={!context?.transcriptPath} onChange={() => setMode("full")} label="Full transcript" />
            </div>
            <p id="full-context-help" className="text-xs text-faint">
              {mode === "focused"
                ? "Recent status and the workspace; older history is read only when needed."
                : "Reads the whole saved history first: slower, and uses more context."}
              {!context?.transcriptPath && <> <span>{context?.fullUnavailableReason ?? "The full transcript is not available."}</span></>}
              {context?.partialCapture && " Older content is left out."}
            </p>
          </fieldset>
          {/* The one setting left to fold away, so the fold is named for it rather than "More settings". */}
          {project?.kind !== "folder" && project && (
            <Fold label="Autopilot" className="mt-3" testId="continuation-autopilot">
              <div className="pt-2 pb-1">
                <PipelineLaunchControls launch={pipelineLaunch} disabled={locked} plain />
              </div>
            </Fold>
          )}
        </>}
        {starting && delivering && <p role="status" className="mt-4 text-sm text-muted-foreground">{progress ? delivery : `Waiting for ${agentName} to start…`} You can open it to follow progress; do not send the handoff again.</p>}
        {inInput && <p role="status" className="mt-4 text-sm">{inInput.pressed
          ? `Pressed Enter. Waiting for ${agentName} to take the handoff… If nothing happens, open the new session and check its terminal.`
          : `The handoff is in ${agentName}'s input but has not been sent yet. Press Enter to send it.`}</p>}
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <DialogFooter className="mt-6">
          <Button variant="ghost" disabled={!canClose} onClick={close}>{destination ? "Open New Session" : "Cancel"}</Button>
          {!loading && (!context || !settings) && <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
          {inInput && <Button disabled={pressing} onClick={() => void pressEnter()}>{pressing ? <><LoaderCircle className="size-4 animate-spin" />Pressing Enter…</> : inInput.pressed ? "Press Enter Again" : "Press Enter"}</Button>}
          {!sent && <Button disabled={loading || starting || !context || !settings} onClick={() => void start()}>{starting ? <><LoaderCircle className="size-4 animate-spin" />{delivering ? "Confirming delivery…" : "Starting…"}</> : destination ? "Retry Start" : into ? "Link and Start" : "Start New Session"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One side of a two-way choice drawn as a segmented control; a real radio underneath. */
function Choice({ name, checked, disabled, onChange, label }: { name: string; checked: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return (
    <label className={cn("flex cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40", checked && "bg-card text-foreground shadow-sm", disabled && "cursor-not-allowed opacity-50")}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} aria-describedby="full-context-help" className="sr-only" />
      {label}
    </label>
  );
}
