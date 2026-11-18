import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatSetupDuration, rerunSetup, setupActive, setupDuration, stopSetup, setupLog, useWorkspaceSetups, type WorkspaceSetup } from "@/lib/workspaceSetup";
import { TerminalView } from "./TerminalView";
import { disposeInstance } from "@/lib/terminal";

export const setupStatus = (run: Pick<WorkspaceSetup, "status">) => ({ pending: "Setup queued", running: "Setup running", stopping: "Stopping setup…", stopped: "Setup stopped", succeeded: "Setup succeeded", failed: "Setup failed" })[run.status];

/** Where a workspace's setup script is saved, for the empty states. */
export const SETUP_SCRIPT_PLACE = "Settings → Projects → Scripts";

/** "✓ Last setup finished in 14s · exit 0", "✗ Last setup failed after 3s · exit 7", "Setup running · 12s". */
export function setupOutcome(run: Pick<WorkspaceSetup, "status" | "exitCode">, duration: number | null): string {
  const took = duration == null ? null : formatSetupDuration(duration);
  const exit = run.exitCode == null ? "" : ` · exit ${run.exitCode}`;
  switch (run.status) {
    case "succeeded": return `✓ Last setup finished${took ? ` in ${took}` : ""}${exit}`;
    case "failed": return `✗ Last setup failed${took ? ` after ${took}` : ""}${exit}`;
    case "stopped": return `Last setup stopped${took ? ` after ${took}` : ""}${exit}`;
    case "running": return `Setup running${took ? ` · ${took}` : "…"}`;
    default: return setupStatus(run);
  }
}

const Label = ({ children }: { children: string }) => <h3 className="text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase">{children}</h3>;

/** The script, in the mono block the design shows under "After setup". */
function Script({ text }: { text: string }) {
  return <pre data-testid="setup-script" className="max-h-32 shrink-0 overflow-auto rounded-md border border-hairline bg-veil-card px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-foreground">{text}</pre>;
}

/**
 * A workspace's setup: the script that runs after the worktree is created,
 * the last run's outcome, Stop and Rerun, and that run's output (its live
 * terminal while it has one, else the saved log). Without a run, the
 * configured script with an offer to run it; without a script, where to add one.
 */
export function WorkspaceSetupPane({ run, sessionId, script }: { run?: WorkspaceSetup; sessionId?: string; script?: string | null }) {
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const { times } = useWorkspaceSetups(!!run);
  const running = !!run && setupActive(run);
  const session = run?.sessionId ?? sessionId;
  const [now, setNow] = useState(() => Date.now());
  const ticking = run?.status === "running" && setupDuration(run, times) != null;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  useEffect(() => () => { if (run) disposeInstance(run.paneId); }, [run?.paneId]);
  useEffect(() => {
    let current = true;
    if (run && !run.hasPane) setupLog(run.sessionId, run.paneId).then((log) => { if (current) setLog(log); }).catch((error) => { if (current) setError(errorMessage(error)); });
    return () => { current = false; };
  }, [run?.sessionId, run?.paneId, run?.hasPane, run?.status]);
  const rerun = async () => {
    if (!session) return;
    setStarting(true); setError(null);
    try { await rerunSetup(session); } catch (error) { setError(errorMessage(error)); }
    finally { setStarting(false); }
  };
  const text = run?.command || script?.trim() || "";

  if (!run && !text) {
    return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="setup-empty">
      <Label>After setup</Label>
      <p className="text-xs text-muted-foreground">No setup script yet. Add one in <span className="text-foreground">{SETUP_SCRIPT_PLACE}</span>: it runs once when a workspace is created, to install dependencies and copy local files.</p>
    </div>;
  }

  return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="setup-pane">
    <div className="flex shrink-0 items-center gap-2">
      <div className="flex-1"><Label>After setup</Label></div>
      {running && <Button size="xs" variant="outline" disabled={starting || run.status === "stopping"} onClick={async () => {
        setStarting(true); setError(null);
        try { await stopSetup(run.sessionId, run.paneId); } catch (error) { setError(errorMessage(error)); }
        finally { setStarting(false); }
      }}>{run.status === "stopping" ? "Stopping…" : "Stop"}</Button>}
      {session && <Button size="xs" variant="outline" disabled={running || starting} onClick={() => void rerun()}>{run ? "Rerun" : "Run setup"}</Button>}
    </div>
    <Script text={text} />
    {run
      ? <p role="status" data-testid="setup-outcome" className={cn("shrink-0 text-xs", run.status === "succeeded" ? "text-add" : run.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{setupOutcome(run, setupDuration(run, times, now))}</p>
      : <p role="status" data-testid="setup-outcome" className="shrink-0 text-xs text-muted-foreground">Not run in this workspace yet.</p>}
    {(error || run?.error) && <p role="alert" className="shrink-0 text-xs text-destructive">{error ?? run?.error}</p>}
    {run && <>
      <Label>Output</Label>
      <div className="min-h-32 flex-1 overflow-hidden rounded-md border border-hairline" data-testid="setup-output">
        {run.hasPane ? <TerminalView key={run.paneId} id={run.paneId} visible redraw={false} /> : <pre className="h-full overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs">{log}</pre>}
      </div>
    </>}
  </div>;
}
