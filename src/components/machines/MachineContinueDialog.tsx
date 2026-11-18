import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SessionAgentControls } from "@/components/session/SessionAgentControls";
import { HandoffScene } from "@/components/session/HandoffScene";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { continuationPrompt, type ContextMode, type ContinuationContext } from "@/lib/continuation";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { launchSettingsOf, useSessionAgent, type LaunchSettings } from "@/lib/useSessionAgent";
import { useSessionStore } from "@/lib/sessions";
import { selectSessionTab } from "@/lib/terminal";
import type { TabEntry } from "@/types/session";

/**
 * Continue in a new tab, for a machine session (PRO-408): a new agent tab in
 * the same session on the machine, handed the context of `source`'s
 * conversation. The context is read on the machine (`session.prepareContinuation`),
 * so its transcript path is one the new tab's agent can open there; the tab
 * is added (`session.addTab`) and sent the handoff as any message to it is.
 * The agent, model, effort and mode are the machine's, as its "+" offers
 * them; nothing chosen here is saved as a preference.
 *
 * Mounted afresh for each opening. Once the tab exists the handoff is sent
 * once: a send that fails leaves the tab open, never a second tab.
 */
export function MachineContinueDialog({ cloud, source, onClose }: { cloud: CloudSessionModel; source: TabEntry; onClose: () => void }) {
  const name = cloud.machine?.name ?? "the machine";
  const client = cloud.client;
  const runtimeSessionId = cloud.backend.logSessionId;
  const [context, setContext] = useState<ContinuationContext | null>(null);
  const [mode, setMode] = useState<ContextMode>("focused");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  // The tab the handoff went to, or was meant for: it is never made twice.
  const [made, setMade] = useState<string | null>(null);
  const startingRef = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  // The agents are the machine's: those its runtime offers, each available there.
  const { harnesses: known } = useSessionStore();
  const harnesses = useMemo(
    () => known.filter((harness) => cloud.agents.some((agent) => agent.id === harness.id)).map((harness) => ({ ...harness, available: true })),
    [cloud.agents, known],
  );
  const [launch, setLaunch] = useState<LaunchSettings>(() => launchSettingsOf(source));
  const selection = useSessionAgent(harnesses, false, client, { value: launch, onChange: setLaunch });

  const generation = cloud.backend.generation;
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    setContext(null);
    if (!client) {
      setError(`Continue in a new tab works once ${name} is connected.`);
      setLoading(false);
      return;
    }
    void client.prepareContinuation(runtimeSessionId, source.id).then(
      (prepared) => { if (!canceled) setContext(prepared); },
      (e) => { if (!canceled) setError(`Could not prepare context on ${name}: ${errorMessage(e)}`); },
    ).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [client, runtimeSessionId, source.id, attempt, generation, name]);

  const close = () => {
    if (!active.current) return;
    active.current = false;
    onClose();
  };

  const start = async () => {
    if (startingRef.current || !context || !selection.harness) return;
    const blocked = cloud.backend.sendHeldReason ?? cloud.backend.readOnlyReason;
    if (blocked) {
      setError(blocked);
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const prompt = continuationPrompt(context, mode);
      let tabId = made;
      if (!tabId) {
        const added = await cloud.addAgentTab({ agent: selection.harness.id, model: selection.modelId || undefined, effort: selection.effort, mode: selection.mode });
        if (!added) throw new Error(`${name} did not name the new tab.`);
        tabId = added;
        setMade(added);
      }
      await cloud.backend.send(tabId, prompt, []);
      selectSessionTab(cloud.backend.key, { kind: "agent", id: tabId });
      close();
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      startingRef.current = false;
      if (active.current) setStarting(false);
    }
  };

  const agentName = selection.harness?.name ?? "the agent";
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !starting) close(); }}>
      <DialogContent width="max-w-[34rem]" className="max-h-[calc(100vh-2rem)] overflow-y-auto p-6" showClose={!starting} onEscapeKeyDown={(e) => e.stopPropagation()}>
        <div data-testid="machine-continue" className="contents">
        <HandoffScene className="mb-8 mt-6" />
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Continue in a new tab</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            Opens a new agent tab in this session on {name} that carries over this tab's conversation, so the agent picks up where it left off. This tab stays open.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p role="status" className="mt-5 flex items-center gap-2 text-xs text-faint"><LoaderCircle className="size-3 animate-spin" />Preparing context on {name}…</p>
        ) : context && (
          <>
            <div role="group" aria-label="New tab settings" className="mt-5 flex flex-col gap-2">
              <span className="text-xs font-medium text-foreground">Agent</span>
              <div className="flex min-w-0 flex-nowrap items-center gap-1.5">
                <SessionAgentControls selection={selection} disabled={starting || !!made} fill />
              </div>
            </div>
            <fieldset disabled={starting} className="mt-4 flex flex-col gap-2">
              <legend className="mb-2 text-xs font-medium text-foreground">Context</legend>
              <div className="grid h-8 grid-cols-2 gap-0.5 rounded-md bg-veil-raised p-0.5 text-xs">
                <Choice checked={mode === "focused"} onChange={() => setMode("focused")} label="Recent context" />
                <Choice checked={mode === "full"} disabled={!context.transcriptPath} onChange={() => setMode("full")} label="Full transcript" />
              </div>
              <p id="machine-full-context-help" className="text-xs text-faint">
                {mode === "focused" ? "Recent status and the workspace; older history is read only when needed." : `Reads the whole saved history on ${name} first: slower, and uses more context.`}
                {!context.transcriptPath && <> <span>{context.fullUnavailableReason ?? "The full transcript is not available."}</span></>}
                {context.partialCapture && " Older content is left out."}
              </p>
            </fieldset>
          </>
        )}
        {starting && <p role="status" className="mt-4 text-sm text-muted-foreground">{made ? `Sending the handoff to ${agentName} on ${name}…` : `Opening a new tab on ${name}…`}</p>}
        {made && !starting && error && <p className="mt-4 text-xs text-muted-foreground">The new tab is open. Try again to send it the handoff, or open it to check.</p>}
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <DialogFooter className="mt-6">
          <Button variant="ghost" disabled={starting} onClick={() => { if (made) selectSessionTab(cloud.backend.key, { kind: "agent", id: made }); close(); }}>{made ? "Open New Tab" : "Cancel"}</Button>
          {!loading && !context && <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
          <Button disabled={loading || starting || !context || !selection.harness || !cloud.connected} onClick={() => void start()}>
            {starting && <LoaderCircle className="size-3.5 animate-spin" />}
            {made ? "Send Handoff" : "Continue"}
          </Button>
        </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Choice({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return (
    <label className={cn("flex cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40", checked && "bg-card text-foreground shadow-sm", disabled && "cursor-not-allowed opacity-50")}>
      <input type="radio" name="machine-continuation-mode" checked={checked} disabled={disabled} onChange={onChange} aria-describedby="machine-full-context-help" className="sr-only" />
      {label}
    </label>
  );
}
