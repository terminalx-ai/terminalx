import { useState } from "react";
import { pipelineSettings, continuePipeline, startPipeline, setPipelineResolveConflicts } from "@/lib/issuePipeline";
import type { IssuePipelineSettings } from "@/types/issuePipeline";

export interface PipelineLaunch {
  autoMerge: boolean;
  resolveConflicts: boolean;
}

export function usePipelineLaunch(projectPath: string | null, settings: IssuePipelineSettings, unavailable?: string, mergeUnavailable?: string) {
  const [choice, setChoice] = useState<{ projectPath: string | null; value: PipelineLaunch } | null>(null);
  const value = choice?.projectPath === projectPath ? choice.value : { autoMerge: settings.autoMerge, resolveConflicts: settings.resolveConflicts ?? false };
  return {
    projectPath, settings, unavailable, mergeUnavailable,
    reset: () => setChoice(null),
    value: { autoMerge: settings.enabled && !unavailable && !mergeUnavailable && !settings.requirePerson && value.autoMerge, resolveConflicts: settings.enabled && !unavailable && value.resolveConflicts },
    change: (patch: Partial<PipelineLaunch>) => setChoice({ projectPath, value: { ...value, ...patch } }),
  };
}

export async function preparePipelineLaunch(sessionId: string, tabId: string, prompt: string, choice?: PipelineLaunch): Promise<string> {
  if (!choice || (!choice.autoMerge && !choice.resolveConflicts)) return prompt;
  const started = await startPipeline(sessionId, tabId, choice.autoMerge);
  await setPipelineResolveConflicts(started.pipeline.id, choice.resolveConflicts);
  return `${prompt}\n\n${started.authorBrief}`;
}

/** Unlike a new launch, explicit off choices may revoke an existing pipeline. */
export async function preparePipelineContinuation(sessionId: string, tabId: string, prompt: string, choice?: PipelineLaunch): Promise<string> {
  if (!choice) return prompt;
  const started = await continuePipeline(sessionId, tabId, choice);
  return started ? `${prompt}\n\n${started.authorBrief}` : prompt;
}

export { pipelineSettings };
