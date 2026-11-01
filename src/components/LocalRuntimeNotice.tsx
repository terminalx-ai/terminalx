import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage, type LocalRuntimeOutdated } from "@/lib/api";
import { bootLocalRuntime, reconnectLocalRuntime, replaceLocalRuntime, restartLocalRuntime, useLocalRuntime } from "@/lib/localRuntime";

/** A short gap says nothing: most reconnect before anyone would notice. */
export const QUIET_MS = 3_000;
/** Past this a failure is no blip, and asking for an attempt now may help. */
export const STALLED_MS = 2 * 60_000;

/** Connection health only: a gap never means an agent stopped (#643). The
 * desktop reconnects by itself; this says so, and asks for nothing unless
 * retrying cannot help or has not helped for minutes. A runtime that stopped
 * answering is the exception: only restarting it helps (#661). So is one
 * older than the app (#730), which the desktop replaces once its agents'
 * turns are done, and which this offers to restart now. */
export function LocalRuntimeNotice() {
  const { state, readAt } = useLocalRuntime();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** The older runtime whose notice was hidden: it comes back for another. */
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => { void bootLocalRuntime(); }, []);
  // A failed restart is news only while the runtime is still not answering.
  useEffect(() => { if (state?.state !== "unresponsive") setFailure(null); }, [state]);
  const down = state?.state === "connecting" ? state.downMs + Math.max(0, now - readAt) : 0;
  // Shown again as the gap crosses each threshold, without asking again.
  useEffect(() => {
    if (state?.state !== "connecting") return;
    const next = [QUIET_MS, STALLED_MS].find((threshold) => threshold > down);
    if (next === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), next - down);
    return () => clearTimeout(timer);
  }, [state, readAt, down]);

  if (state?.state === "updating") {
    return (
      <aside aria-label="Local runtime version" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-medium">Updating the TerminalX runtime</div>
          <p className="mt-1 text-muted-foreground">Stopping the {state.from ?? "older"} runtime and starting {state.to}, the one this app came with. Each agent picks up its conversation again when its tab starts.</p>
        </div>
      </aside>
    );
  }
  if (state?.state === "connected" && state.outdated && hidden !== state.epoch) {
    const { epoch } = state;
    return <OutdatedNotice key={epoch} epoch={epoch} outdated={state.outdated} onHide={() => setHidden(epoch)} />;
  }
  if (state?.state === "unresponsive") {
    // Reconnecting would reach the same wedged process; only a restart
    // recovers, and that stops its agents, so it is the reader's call. Only
    // the runtime this window found not responding: another window may
    // already have replaced it.
    const { epoch } = state;
    const restart = async () => {
      setRestarting(true);
      setFailure(null);
      try { await restartLocalRuntime(epoch); }
      catch (error) { setFailure(errorMessage(error)); }
      finally { setRestarting(false); }
    };
    return (
      <aside aria-label="Local runtime connection" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-medium">TerminalX runtime is not responding</div>
          <p className="mt-1 text-muted-foreground">{state.message} Restarting it stops the agents and terminals it runs; each agent picks up its conversation again when its tab starts.</p>
          {failure && <p role="alert" className="mt-1 text-destructive">{failure}</p>}
        </div>
        <Button variant="outline" size="sm" disabled={restarting} onClick={() => void restart()}>{restarting ? "Restarting…" : "Restart runtime"}</Button>
      </aside>
    );
  }
  if (state?.state !== "connecting" && state?.state !== "unavailable") return null;
  if (state.state === "connecting" && down < QUIET_MS) return null;
  const retry = async () => {
    setBusy(true);
    try { await reconnectLocalRuntime(); } finally { setBusy(false); }
  };
  const reconnecting = state.state === "connecting" && down < STALLED_MS
    ? `${state.terminal ? "Reconnecting terminal output" : "Reconnecting"}… (attempt ${state.attempt})`
    : null;
  return (
    <aside aria-label="Local runtime connection" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">{reconnecting ?? "Live connection unavailable"}</div>
        <p className="mt-1 text-muted-foreground">{reconnecting ? "Agents and terminal commands keep running." : state.message}</p>
      </div>
      {!reconnecting && <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>{busy ? "Reconnecting…" : "Try again"}</Button>}
    </aside>
  );
}

/** A runtime older than the app (#730): which agents' turns the switch waits
 * for, and a restart now, which stops them. Each picks up its conversation
 * again when its tab starts. Only the runtime this window was told about:
 * another window may already have replaced it. */
function OutdatedNotice({ epoch, outdated, onHide }: { epoch: string; outdated: LocalRuntimeOutdated; onHide: () => void }) {
  const [restarting, setRestarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { running, app, turns, problem } = outdated;
  const restart = async () => {
    setRestarting(true);
    setFailure(null);
    try { await replaceLocalRuntime(epoch); }
    catch (error) { setFailure(errorMessage(error)); }
    finally { setRestarting(false); }
  };
  const waiting = turns === null
    ? `It restarts with ${app} once it has checked that no agent is in the middle of a turn.`
    : turns.length === 0 ? `It restarts with ${app} now.`
    : turns.length === 1 ? `It restarts with ${app} when this agent finishes its turn:`
    : `It restarts with ${app} when these agents finish their turns:`;
  return (
    <aside aria-label="Local runtime version" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">TerminalX runtime is older than the app</div>
        <p className="mt-1 text-muted-foreground">The runtime running your agents is {running ? `version ${running}` : "an earlier version"}; this app is {app}. {waiting}</p>
        {turns && turns.length > 0 && <ul className="mt-1 list-disc pl-4 text-muted-foreground">{turns.map((turn, index) => <li key={index}>{turn}</li>)}</ul>}
        <p className="mt-1 text-muted-foreground">Restarting now stops {turns && turns.length > 0 ? (turns.length === 1 ? "it" : "them") : "its agents"} and its terminals; each agent picks up its conversation again when its tab starts.</p>
        {(failure ?? problem) && <p role="alert" className="mt-1 text-destructive">{failure ?? problem}</p>}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <Button variant="outline" size="sm" disabled={restarting} onClick={() => void restart()}>{restarting ? "Restarting…" : "Restart now"}</Button>
        <Button variant="ghost" size="sm" onClick={onHide}>Hide</Button>
      </div>
    </aside>
  );
}
