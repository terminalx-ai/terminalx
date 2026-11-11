import { invoke } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import { registerSelfUiPanel } from "@/lib/selfUi";
import { getIssuePipelines, upsertPipeline } from "@/lib/issuePipeline";
import type { StartedIssuePipeline } from "@/types/issuePipeline";
import { useLayoutEffect, useRef, useState } from "react";
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
  const root = useRef<HTMLDivElement>(null);
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
  const adopt = async () => {
    if (!tabId) return;
    setBusy(true);
    setError(null);
    try {
      const started = await invoke<StartedIssuePipeline>("issue_pipeline_attach", { sessionId: session.id, tabId, autoMerge: launch.value.autoMerge, resolveConflicts: launch.value.resolveConflicts });
      upsertPipeline(started.pipeline);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  useLayoutEffect(() => {
    if (!root.current || !tabId) return;
    const unavailable = busy || !launch.settings.enabled || !!launch.unavailable;
    return registerSelfUiPanel(session.id, {
      element: root.current,
      snapshot: () => {
        const current = getIssuePipelines().find((p) => p.author.sessionId === session.id) ?? pipeline;
        return { sessionId: session.id, tabId, pipelineId: current?.id ?? null, pipelineState: current?.state ?? null,
        controls: pipeline ? [] : [
          { id: "toggle-merge", enabled: !unavailable && !launch.settings.requirePerson && !launch.mergeUnavailable, checked: launch.value.autoMerge },
          { id: "toggle-conflicts", enabled: !unavailable, checked: launch.value.resolveConflicts },
          { id: "start-autopilot", enabled: !unavailable && chosen, checked: null },
          { id: "adopt-pr", enabled: !unavailable, checked: null },
        ] };
      },
      click: async (request) => {
        if (request.action === "toggle-merge") flushSync(() => launch.change({ autoMerge: !launch.value.autoMerge }));
        else if (request.action === "toggle-conflicts") flushSync(() => launch.change({ resolveConflicts: !launch.value.resolveConflicts }));
        else if (request.action === "start-autopilot" || request.action === "adopt-pr") {
          flushSync(() => setBusy(true));
          try {
            const started = await invoke<StartedIssuePipeline>("self_ui_start", { id: request.id, autoMerge: launch.value.autoMerge, resolveConflicts: launch.value.resolveConflicts });
            flushSync(() => upsertPipeline(started.pipeline));
          } finally { flushSync(() => setBusy(false)); }
        } else throw new Error("Unsupported session control");
      },
    });
  });
  return <div ref={root} className="flex flex-col gap-2">
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
    {!pipeline && <Button size="xs" disabled={busy || !tabId || !launch.settings.enabled} onClick={() => void adopt()}>Adopt existing PR</Button>}
  </div>;
}
