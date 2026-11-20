import { useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceRpcError, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { LoaderCircle } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useRuntimeModels } from "@/lib/cloudModels";
import { continuationPrompt, type ContextMode, type ContinuationContext } from "@/lib/continuation";
import type { HandoffActions } from "@/lib/sessionBackend";
import { useSessionStore } from "@/lib/sessions";
import { launchSettingsOf, useSessionAgent, type LaunchSettings } from "@/lib/useSessionAgent";
import type { TabEntry } from "@/types/session";
import { HandoffScene } from "./HandoffScene";
import { SessionAgentControls } from "./SessionAgentControls";

/**
 * What a remote handoff hands on (#1327): a finished turn for a second
 * opinion, a failed turn's prompt to retry in a new chat, or the whole
 * conversation, continued by another agent (the composer's agent handoff).
 */
export type RemoteHandoffPurpose =
  | { kind: "review"; prompt: string }
  | { kind: "retry"; prompt: string }
  | { kind: "continue" };

/**
 * A second opinion, Retry in a new chat or the agent handoff, for a cloud or
 * machine session (#1327): a new tab in the session on its runtime, opened
 * with its first prompt in one call (`HandoffActions.open`, `session.handoff`).
 * The local `ContinuationDialog` does the same on this computer.
 *
 * A review or a retry starts as soon as the runtime's models are read, as a
 * local one does: the review on Plan (read-only), the retry in the source
 * tab's own mode. A handoff first reads the conversation on the runtime
 * (`session.handoffContext`), so its transcript path is one the new tab's
 * agent can open there, and starts when the reader presses Continue.
 *
 * The agent and models are the runtime's; nothing chosen here is saved as a
 * preference. Mounted afresh for each opening. Once the tab exists it is
 * never made again: a prompt the runtime could not send is said in its chat
 * and here, and the reader opens the tab rather than starting another.
 */
export function RemoteHandoffDialog({ handoff, source, agent, modelClient, purpose, where, onClose }: {
  handoff: HandoffActions;
  source: TabEntry;
  /** The agent the new tab runs: the other one for a review or a handoff, the source's own for a retry. */
  agent: string;
  /** The runtime, for its models. */
  modelClient: WorkspaceRpcClient | null;
  purpose: RemoteHandoffPurpose;
  /** Where the session runs, for the dialog's words: "the workspace", or a machine's name. */
  where: string;
  onClose: () => void;
}) {
  const review = purpose.kind === "review";
  const prompted = purpose.kind !== "continue";
  // The runtime's agent: it offered it, so it is available there.
  const { harnesses: known } = useSessionStore();
  const harnesses = useMemo(
    () => known.filter((harness) => harness.id === agent).map((harness) => ({ ...harness, available: true })),
    [known, agent],
  );
  // The source's settings; another agent's model is its own default, and a review only reads.
  const [launch, setLaunch] = useState<LaunchSettings>(() => {
    const own = launchSettingsOf(source);
    const same = agent === own.harness;
    return { harness: agent, model: same ? own.model : "", effort: same ? own.effort : null, permissionMode: review ? "plan" : own.permissionMode };
  });
  const selection = useSessionAgent(harnesses, false, modelClient, { value: launch, onChange: setLaunch });
  // Until the runtime has said its models, a start would take whatever the picker guessed.
  const runtime = useRuntimeModels(modelClient);
  const modelsRead = !!runtime || !modelClient?.hasCapability("agents/1");

  const [context, setContext] = useState<ContinuationContext | null>(null);
  const [mode, setMode] = useState<ContextMode>("focused");
  const [loading, setLoading] = useState(!prompted);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The tab the handoff opened: it is never made twice.
  const [made, setMade] = useState<string | null>(null);
  const startingRef = useRef(false);
  // One request for this handoff while its outcome is unknown (a timeout, a dropped connection): trying
  // again is answered from the runtime's cache with the tab it may already have made, never a second.
  const requestId = useRef(newHandoffRequest());
  const autoStarted = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    if (prompted) return;
    let canceled = false;
    setLoading(true);
    setError(null);
    setContext(null);
    void handoff.context(source.id).then(
      (prepared) => { if (!canceled) setContext(prepared); },
      (e) => { if (!canceled) setError(`Could not prepare context on ${where}: ${errorMessage(e)}`); },
    ).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [handoff, source.id, attempt, prompted, where]);

  const close = () => {
    if (!active.current) return;
    active.current = false;
    onClose();
  };

  const start = async () => {
    if (startingRef.current || made || !selection.harness || (!prompted && !context)) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const prompt = purpose.kind === "continue" ? continuationPrompt(context!, mode) : purpose.prompt;
      const opened = await handoff.open({ agent: selection.harness.id, model: selection.modelId || undefined, effort: selection.effort, mode: selection.mode, prompt, requestId: requestId.current });
      if (!active.current) return;
      if (opened.startError) {
        setMade(opened.tabId);
        setError(opened.startError);
      } else close();
    } catch (e) {
      // The runtime answered and made nothing (the cache would replay that refusal): the next try is a new request.
      if (e instanceof WorkspaceRpcError && e.code !== "outcome_unknown") requestId.current = newHandoffRequest();
      if (active.current) setError(errorMessage(e));
    } finally {
      startingRef.current = false;
      if (active.current) setStarting(false);
    }
  };

  // A review or a retry starts once, as soon as it can; trying again after a failure is the reader's.
  const ready = prompted && modelsRead && !!selection.harness;
  useEffect(() => {
    if (!ready || autoStarted.current) return;
    autoStarted.current = true;
    void start();
    // Only the transition to ready schedules a start; later renders must not schedule another.
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const agentName = selection.harness?.name ?? "the agent";
  const title = review ? "Second opinion" : purpose.kind === "retry" ? "Retry in a new chat" : `Hand off to ${agentName}`;
  const description = review
    ? `Share the selected turn's prompt, answer and recorded file diffs with ${agentName} for review in a new tab in this session on ${where}.`
    : purpose.kind === "retry"
      ? `Sends the failed turn's prompt to ${agentName} again, in a new tab in this session on ${where}.`
      : `Opens a new ${agentName} tab in this session on ${where} that carries over this tab's conversation, so the agent picks up where it left off. This tab stays open.`;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !starting) close(); }}>
      <DialogContent width="max-w-[34rem]" className="max-h-[calc(100vh-2rem)] overflow-y-auto p-6" showClose={!starting} onEscapeKeyDown={(e) => e.stopPropagation()}>
        <div data-testid="remote-handoff" className="contents">
        <HandoffScene className="mb-8 mt-6" />
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">{description}</DialogDescription>
        </DialogHeader>
        {prompted ? (
          <>
            {selection.harness && <p role="status" className="mt-4 text-xs text-muted-foreground" data-testid="review-settings">
              {agentName} · {selection.model?.label ?? (selection.modelId || "Agent default")}{review ? " · Plan (read-only)" : ""}
            </p>}
            {!modelsRead && !error && <p role="status" className="mt-5 flex items-center gap-2 text-xs text-faint"><LoaderCircle className="size-3 animate-spin" />Reading {where}'s models…</p>}
          </>
        ) : loading ? (
          <p role="status" className="mt-5 flex items-center gap-2 text-xs text-faint"><LoaderCircle className="size-3 animate-spin" />Preparing context on {where}…</p>
        ) : context && (
          <>
            <div role="group" aria-label="New tab settings" className="mt-5 flex flex-col gap-2">
              <span className="text-xs font-medium text-foreground">Agent</span>
              <div className="flex min-w-0 flex-nowrap items-center gap-1.5">
                <SessionAgentControls selection={selection} disabled={starting || !!made} fill />
              </div>
            </div>
            <fieldset disabled={starting || !!made} className="mt-4 flex flex-col gap-2">
              <legend className="mb-2 text-xs font-medium text-foreground">Context</legend>
              <div className="grid h-8 grid-cols-2 gap-0.5 rounded-md bg-veil-raised p-0.5 text-xs">
                <Choice checked={mode === "focused"} onChange={() => setMode("focused")} label="Recent context" />
                <Choice checked={mode === "full"} disabled={!context.transcriptPath} onChange={() => setMode("full")} label="Full transcript" />
              </div>
              <p id="remote-full-context-help" className="text-xs text-faint">
                {mode === "focused" ? "Recent status and the workspace; older history is read only when needed." : `Reads the whole saved history on ${where} first: slower, and uses more context.`}
                {!context.transcriptPath && <> <span>{context.fullUnavailableReason ?? "The full transcript is not available."}</span></>}
                {context.partialCapture && " Older content is left out."}
              </p>
            </fieldset>
          </>
        )}
        {starting && <p role="status" className="mt-4 text-sm text-muted-foreground">Opening a new {agentName} tab on {where}…</p>}
        {made && <p className="mt-4 text-xs text-muted-foreground">The new tab is open; its chat says what went wrong.</p>}
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <DialogFooter className="mt-6">
          <Button variant="ghost" disabled={starting} onClick={close}>{made ? "Done" : "Cancel"}</Button>
          {!prompted && !loading && !context && <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
          {!made && (!prompted || (error && !starting)) && (
            <Button disabled={starting || !selection.harness || (prompted ? !modelsRead : loading || !context)} onClick={() => void start()}>
              {starting && <LoaderCircle className="size-3.5 animate-spin" />}
              {prompted ? "Try Again" : "Continue"}
            </Button>
          )}
        </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function newHandoffRequest(): string {
  return `handoff-${crypto.randomUUID()}`;
}

function Choice({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return (
    <label className={cn("flex cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40", checked && "bg-card text-foreground shadow-sm", disabled && "cursor-not-allowed opacity-50")}>
      <input type="radio" name="remote-continuation-mode" checked={checked} disabled={disabled} onChange={onChange} aria-describedby="remote-full-context-help" className="sr-only" />
      {label}
    </label>
  );
}
