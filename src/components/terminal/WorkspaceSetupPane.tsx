import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { rerunSetup, setupLog, type WorkspaceSetup } from "@/lib/workspaceSetup";
import { TerminalView } from "./TerminalView";
import { disposeInstance } from "@/lib/terminal";

export const setupStatus = (run: WorkspaceSetup) => ({ pending: "Setup running", running: "Setup running", succeeded: "Setup succeeded", failed: "Setup failed" })[run.status];

export function WorkspaceSetupPane({ run }: { run: WorkspaceSetup }) {
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const running = run.status === "pending" || run.status === "running";
  useEffect(() => () => { disposeInstance(run.paneId); }, [run.paneId]);
  useEffect(() => {
    let current = true;
    if (!run.hasPane) setupLog(run.sessionId, run.paneId).then((log) => { if (current) setLog(log); }).catch((error) => { if (current) setError(errorMessage(error)); });
    return () => { current = false; };
  }, [run.sessionId, run.paneId, run.hasPane, run.status]);
  return <div className="flex h-full flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1">
      <span role="status" className="flex-1 text-xs text-muted-foreground">{setupStatus(run)}{run.exitCode != null && ` · Exit ${run.exitCode}`}</span>
      <Button size="xs" variant="ghost" disabled={running || starting} onClick={async () => {
        setStarting(true); setError(null);
        try { await rerunSetup(run.sessionId); } catch (error) { setError(errorMessage(error)); }
        finally { setStarting(false); }
      }}>Rerun</Button>
    </div>
    {(error || run.error) && <p role="alert" className="px-3 py-1 text-xs text-destructive">{error ?? run.error}</p>}
    <div className="min-h-0 flex-1">
      {run.hasPane ? <TerminalView key={run.paneId} id={run.paneId} visible redraw={false} /> : <pre className="h-full overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs">{log}</pre>}
    </div>
  </div>;
}
