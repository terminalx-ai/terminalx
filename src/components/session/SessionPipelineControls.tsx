import { useState } from "react";
import { agent, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { IssuePipelinePanel } from "@/components/issues/IssuePipelinePanel";
import { PipelineLaunchControls } from "./PipelineLaunchControls";
import { pipelineSettings, preparePipelineLaunch, usePipelineLaunch } from "@/lib/pipelineLaunch";
import type { IssuePipeline } from "@/types/issuePipeline";
import type { Project, SessionEntry } from "@/types/session";

/** Enable the same launch contract later, without interrupting an active turn. */
export function SessionPipelineControls({ session, project, tabId, pipeline, plain = false }: { session: SessionEntry; project?: Project; tabId?: string; pipeline?: IssuePipeline; plain?: boolean }) {
  // Shown only while the session has no pipeline; one started from an issue offers the issue's defaults (#700).
  const launch = usePipelineLaunch(project?.path ?? null, pipelineSettings(project), !tabId ? "Choose an agent conversation first." : undefined, undefined, session.issue ? "issue" : "session");
  const [busy, setBusy] = useState(false);
  const chosen = launch.value.autoMerge || launch.value.resolveConflicts;
  const [error, setError] = useState<string | null>(null);
  const enable = async () => {
    if (!tabId) return;
    setBusy(true);
    setError(null);
    try {
      const brief = await preparePipelineLaunch(session.id, tabId, "", launch.value);
      await agent.send(session.id, tabId, brief);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {pipeline ? <IssuePipelinePanel pipeline={pipeline} /> : plain ? <>
      <PipelineLaunchControls launch={launch} disabled={busy} plain />
      {/* Nothing to press until a switch is on; then one small button, and when it starts. */}
      {chosen && tabId && <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-faint">Starts after the current turn</span>
        <Button size="xs" variant="accent" disabled={busy} onClick={() => void enable()}>Turn on autopilot</Button>
      </div>}
    </> : <>
      <PipelineLaunchControls launch={launch} disabled={busy} />
      <p className="text-xs text-faint">It starts after the current turn. A session on the base branch cannot use it.</p>
      {/* Why the button cannot be pressed, beside it rather than in the faint note above. */}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || !tabId || !chosen} onClick={() => void enable()}>Turn on autopilot</Button>
        {!tabId ? <span className="text-xs text-muted-foreground">Open a conversation first.</span> : !chosen ? <span className="text-xs text-muted-foreground">Turn on a switch above first.</span> : null}
      </div>
    </>}
  </>;
}
