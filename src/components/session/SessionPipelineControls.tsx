import { useState } from "react";
import { agent, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { IssuePipelinePanel } from "@/components/issues/IssuePipelinePanel";
import { PipelineLaunchControls } from "./PipelineLaunchControls";
import { pipelineSettings, preparePipelineLaunch, usePipelineLaunch } from "@/lib/pipelineLaunch";
import type { IssuePipeline } from "@/types/issuePipeline";
import type { Project, SessionEntry } from "@/types/session";

/** Enable the same launch contract later, without interrupting an active turn. */
export function SessionPipelineControls({ session, project, tabId, pipeline }: { session: SessionEntry; project?: Project; tabId?: string; pipeline?: IssuePipeline }) {
  const launch = usePipelineLaunch(project?.path ?? null, pipelineSettings(project), !tabId ? "Choose an agent conversation first." : undefined);
  const [busy, setBusy] = useState(false);
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
    {pipeline ? <IssuePipelinePanel pipeline={pipeline} /> : <>
      <PipelineLaunchControls launch={launch} disabled={busy} />
      <p className="text-xs text-faint">The handoff brief is queued after the current turn. A session on the base branch cannot start a pipeline.</p>
      <Button disabled={busy || !tabId || (!launch.value.autoMerge && !launch.value.resolveConflicts)} onClick={() => void enable()}>Enable automation</Button>
    </>}
  </>;
}
