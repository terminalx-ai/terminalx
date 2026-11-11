import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RuntimeStartFailedDialog } from "@/components/RuntimeStartFailedDialog";
import { errorMessage, type LocalRuntimeOutdated, type LocalRuntimeRestart, type LocalRuntimeRestartRefused, type LocalRuntimeWorkItem } from "@/lib/api";
import { bootLocalRuntime, reconnectLocalRuntime, replaceLocalRuntime, restartLocalRuntime, useLocalRuntime } from "@/lib/localRuntime";

/** A short gap says nothing: most reconnect before anyone would notice. */
export const QUIET_MS = 3_000;
/** Past this a failure is no blip, and asking for an attempt now may help. */
export const STALLED_MS = 2 * 60_000;

/** Connection health only: a gap never means an agent stopped (#643). The
 * desktop reconnects by itself; this says so, and asks for nothing unless
 * retrying cannot help or has not helped for minutes. A runtime that stopped
 * answering is the exception: only restarting it helps (#661). So is one
 * older than the app (#730) that the desktop failed to replace: it is never
 * left behind silently (#766). One still waiting to be replaced, handed over
 * at once when it can be (#765) or once its agents' turns are done, is the
 * status bar's to show (`RuntimeStatus`), as an update chose before it
 * installed. A runtime that exited while starting holds the window with a
 * dialog of its own (PRO-287). */
export function LocalRuntimeNotice() {
  const { state, readAt } = useLocalRuntime();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  /** The older runtime whose notice was hidden: it comes back for another. */
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => { void bootLocalRuntime(); }, []);
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
    const doing = state.keeping
      ? `Handing what the ${state.from ?? "older"} runtime runs over to ${state.to}, the one this app came with. Its agents and terminals keep running.`
      : `Stopping the ${state.from ?? "older"} runtime and starting ${state.to}, the one this app came with. Each agent picks up its conversation again when its tab starts.`;
    return (
      <aside aria-label="Local runtime version" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-medium">Updating the TerminalX runtime</div>
          <p className="mt-1 text-muted-foreground">{doing}</p>
        </div>
      </aside>
    );
  }
  if (state?.state === "connected" && state.outdated?.failed && hidden !== state.epoch) {
    const { epoch } = state;
    return <SwitchFailedNotice key={epoch} epoch={epoch} outdated={state.outdated} onHide={() => setHidden(epoch)} />;
  }
  if (state?.state === "unresponsive") {
    // Reconnecting would reach the same wedged process; only a restart
    // recovers. Only the runtime this window found not responding: another
    // window may already have replaced it.
    return <UnresponsiveNotice key={state.epoch ?? ""} epoch={state.epoch} message={state.message} keeps={state.keeps} />;
  }
  // A runtime that exited as it started fails again on every attempt: this
  // says what failed and holds the window (PRO-287). A gap does not.
  if (state?.state === "unavailable" && state.startFailed) return <RuntimeStartFailedDialog failed={state.startFailed} />;
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

/** A runtime that stopped answering (#661). One that can be handed over is
 * restarted keeping what it runs (#765); when that cannot be done, nothing is
 * stopped, and the reader is asked: to stop only what the handover cannot
 * carry, or everything it runs. Any other runtime is restarted by stopping
 * it, with its agents and terminals, as it says. */
function UnresponsiveNotice({ epoch, message, keeps }: { epoch: string | null; message: string; keeps: boolean }) {
  const [restarting, setRestarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** A restart keeping what it runs was refused: it is the reader's call now. */
  const [refused, setRefused] = useState(false);
  const [unkept, setUnkept] = useState<string[]>([]);
  /** What it named, as the runtime names it: what stopping those sends back. */
  const [stop, setStop] = useState<LocalRuntimeWorkItem[]>([]);
  const restart = async (how: LocalRuntimeRestart) => {
    setRestarting(true);
    setFailure(null);
    try {
      await restartLocalRuntime(epoch, how, how === "stoppingUnkept" ? stop : []);
    } catch (error) {
      setFailure(errorMessage(error));
      const refusal = error as Partial<LocalRuntimeRestartRefused> | null;
      setUnkept(Array.isArray(refusal?.unkept) ? refusal.unkept : []);
      setStop(Array.isArray(refusal?.stop) ? refusal.stop : []);
      setRefused(keeps && how !== "stoppingAll");
    } finally {
      setRestarting(false);
    }
  };
  const offer = keeps
    ? "Restarting it hands its agents and terminals to a fresh runtime, and they keep running."
    : "Restarting it stops the agents and terminals it runs; each agent picks up its conversation again when its tab starts.";
  return (
    <aside aria-label="Local runtime connection" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">TerminalX runtime is not responding</div>
        <p className="mt-1 text-muted-foreground">{message} {offer}</p>
        {failure && <p role="alert" className="mt-1 text-destructive">{failure}</p>}
        {refused && unkept.length > 0 && <ul className="mt-1 list-disc pl-4 text-muted-foreground">{unkept.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        {refused && <p className="mt-1 text-muted-foreground">{unkept.length > 0 ? `Restarting it stopping ${unkept.length === 1 ? "that" : "those"} keeps everything else running. ` : ""}Stopping it instead stops everything it runs; each agent picks up its conversation again when its tab starts.</p>}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        {!refused && <Button variant="outline" size="sm" disabled={restarting} onClick={() => void restart(keeps ? "keeping" : "stoppingAll")}>{restarting ? "Restarting…" : "Restart runtime"}</Button>}
        {refused && unkept.length > 0 && <Button variant="outline" size="sm" disabled={restarting} onClick={() => void restart("stoppingUnkept")}>{restarting ? "Restarting…" : unkept.length === 1 ? "Restart, stopping that" : "Restart, stopping those"}</Button>}
        {refused && <Button variant="ghost" size="sm" disabled={restarting} onClick={() => void restart("stoppingAll")}>Stop and restart</Button>}
      </div>
    </aside>
  );
}

/** The desktop failed to replace a runtime older than the app (#730), by
 * itself or as an update chose (#766): why, and a retry. One that can be
 * handed over keeps what it runs (#765); any other is stopped with it, and
 * each agent picks up its conversation again when its tab starts. Only the
 * runtime this window was told about: another window may already have
 * replaced it. Hidden, the status bar still says so. */
function SwitchFailedNotice({ epoch, outdated, onHide }: { epoch: string; outdated: LocalRuntimeOutdated; onHide: () => void }) {
  const [restarting, setRestarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { running, app, problem, keeps, work, unkept } = outdated;
  // Handed over, trying again stops only what is listed here, and that is
  // what is sent: anything else it cannot carry is refused, and listed.
  const listed = keeps && work !== null && work.length > 0 ? work : [];
  const restart = async () => {
    setRestarting(true);
    setFailure(null);
    try { await replaceLocalRuntime(epoch, keeps ? unkept : []); }
    catch (error) { setFailure(errorMessage(error)); }
    finally { setRestarting(false); }
  };
  return (
    <aside aria-label="Local runtime version" role="status" aria-live="polite" className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">TerminalX runtime was not updated</div>
        <p className="mt-1 text-muted-foreground">The runtime running your agents is {running ? `version ${running}` : "an earlier version"}; this app is {app}. {keeps ? "Handing it over" : "Moving"} to {app} failed, and it does not try again by itself.</p>
        {(failure ?? problem) && <p role="alert" className="mt-1 text-destructive">{failure ?? problem}</p>}
        {listed.length > 0 && <ul className="mt-1 list-disc pl-4 text-muted-foreground">{listed.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        <p className="mt-1 text-muted-foreground">{!keeps ? "Trying again stops its agents, and its terminals and whatever they run; each agent picks up its conversation again when its tab starts."
          : listed.length > 0 ? `Trying again stops only ${listed.length === 1 ? "that, which it cannot carry over" : "those, which it cannot carry over"}, and keeps everything else running.`
          : "Trying again keeps its agents and terminals running."}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <Button variant="outline" size="sm" disabled={restarting} onClick={() => void restart()}>{restarting ? "Restarting…" : "Try again"}</Button>
        <Button variant="ghost" size="sm" onClick={onHide}>Hide</Button>
      </div>
    </aside>
  );
}
