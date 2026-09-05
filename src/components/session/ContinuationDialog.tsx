import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { agent, api, errorMessage } from "@/lib/api";
import { continuationPrompt, launchContinuation, selectContinuationProvider, type ContextMode, type ContinuationContext } from "@/lib/continuation";
import { getPrefs } from "@/lib/prefs";
import type { HarnessInfo, SessionEntry, TabEntry } from "@/types/session";

/** Mounted afresh for each opening: no stale selection, mode, or errors. The
 * source stays pinned even when creation selects the destination underneath. */
export function ContinuationDialog({ session, source, onClose }: {
  session: SessionEntry; source: TabEntry; onClose: () => void;
}) {
  const [context, setContext] = useState<ContinuationContext | null>(null);
  const [providers, setProviders] = useState<HarnessInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [mode, setMode] = useState<ContextMode>("focused");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [destination, setDestination] = useState<TabEntry>();
  const [deliveryFailed, setDeliveryFailed] = useState(false);
  const startingRef = useRef(false);
  const preparedPrompt = useRef<string | undefined>(undefined);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    setContext(null);
    setProviders([]);
    setProvider("");
    Promise.allSettled([agent.prepareContinuation(session.id, source.id), api.listHarnesses()]).then(([prepared, detected]) => {
      if (canceled) return;
      const errors: string[] = [];
      if (prepared.status === "fulfilled") setContext(prepared.value);
      else errors.push(`Could not prepare context: ${errorMessage(prepared.reason)}`);
      if (detected.status === "fulfilled") {
        setProviders(detected.value);
        const selected = selectContinuationProvider(detected.value, source.harness, getPrefs().lastAgent);
        setProvider(selected);
        if (!selected) errors.push("No installed, available providers were found. Install Claude Code or Codex, then retry.");
      } else errors.push(`Could not detect providers: ${errorMessage(detected.reason)}`);
      setError(errors.join(" ") || null);
      setLoading(false);
    });
    return () => { canceled = true; };
  }, [session.id, source.id, source.harness, attempt]);

  const start = async () => {
    if (startingRef.current || !context || !provider || deliveryFailed) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const prompt = preparedPrompt.current ?? continuationPrompt(context, mode);
      preparedPrompt.current = prompt;
      const result = await launchContinuation(context, provider, prompt, setDestination, destination);
      if (result.stage === "delivered") onClose();
      else {
        setError(result.error);
        setDeliveryFailed(result.stage === "delivery");
        if (!result.tab) preparedPrompt.current = undefined;
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };
  const sourceActive = context?.sourceActive || source.status === "in_progress" || source.status === "waiting";
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !startingRef.current) onClose(); }}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto" showClose={!starting} onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Continue in New Session</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">Start a fresh agent conversation in this workspace with context from the current conversation.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Source conversation</dt><dd className="break-words">{context?.title ?? source.title ?? session.title}</dd>
          <dt className="text-muted-foreground">Original provider</dt><dd>{providers.find((p) => p.id === source.harness)?.name ?? source.harness}</dd>
          <dt className="text-muted-foreground">Working directory</dt><dd className="break-all font-mono">{context?.cwd ?? session.cwd}</dd>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">The source conversation stays open. Both conversations share the same branch, files, and uncommitted changes.</p>
        {sourceActive && <p role="status" className="mt-2 text-xs text-muted-foreground">Source work may still be progressing. This uses available saved context without interrupting the source turn or answering its pending permissions.</p>}
        {loading ? <p role="status" className="mt-4 flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />Preparing context and detecting providers…</p> : <>
          <label className="mt-4 flex flex-col gap-1.5 text-sm">Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={starting || !!destination} className="rounded-md border border-border bg-popover px-2 py-2">
              {!provider && <option value="">No available provider</option>}
              {providers.map((p) => <option key={p.id} value={p.id} disabled={!p.available}>{p.name}{!p.available ? " — not available" : ""}</option>)}
            </select>
          </label>
          <fieldset disabled={starting || !!destination} className="mt-4 space-y-3">
            <legend className="mb-2 text-sm font-medium">Context mode</legend>
            <label className="flex items-start gap-2 text-sm"><input type="radio" name="continuation-mode" value="focused" checked={mode === "focused"} onChange={() => setMode("focused")} className="mt-1" /><span>Focused handoff (Recommended)<span className="mt-1 block text-xs text-muted-foreground">Start with recent status and the current workspace; read older history only when needed. No extra AI summary step.</span></span></label>
            <label className="flex items-start gap-2 text-sm"><input type="radio" name="continuation-mode" value="full" checked={mode === "full"} disabled={!context?.transcriptPath} aria-describedby="full-context-help" onChange={() => setMode("full")} className="mt-1" /><span>Full session transcript<span id="full-context-help" className="mt-1 block text-xs text-muted-foreground">{context?.transcriptPath ? "Read the complete saved history before continuing. This can take longer and consume more context, plan usage, or API credits." : context?.fullUnavailableReason ?? "Complete transcript availability could not be established."}</span></span></label>
          </fieldset>
          {context?.partialCapture && <p className="mt-3 text-xs text-muted-foreground">Focused mode will use a bounded partial capture of recent saved conversation history. Older content is omitted.</p>}
        </>}
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={starting} onClick={onClose}>{deliveryFailed ? "Open New Session" : "Cancel"}</Button>
          {!loading && (!context || !provider) && <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
          {!deliveryFailed && <Button disabled={loading || starting || !context || !provider} onClick={() => void start()}>{starting ? <><LoaderCircle className="size-4 animate-spin" />Starting…</> : destination ? "Retry Start" : "Start New Session"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
