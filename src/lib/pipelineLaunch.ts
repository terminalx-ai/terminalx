import { useState } from "react";
import { pipelineSettings, pipelineLaunchDefaults, continuePipeline, startPipeline, setPipelineResolveConflicts } from "@/lib/issuePipeline";
import type { IssuePipelineSettings } from "@/types/issuePipeline";

export interface PipelineLaunch {
  autoMerge: boolean;
  resolveConflicts: boolean;
}

/**
 * Where the launch switches start until someone changes them: the project's
 * defaults for a session started from an issue (both on unless the project
 * turned them off, `pipelineLaunchDefaults`) or for any other session, or the
 * switches a pipeline the launch carries on already holds.
 */
export type PipelineLaunchStart = "issue" | "session" | PipelineLaunch;

export function usePipelineLaunch(projectPath: string | null, settings: IssuePipelineSettings, unavailable?: string, mergeUnavailable?: string, start: PipelineLaunchStart = "session") {
  const [choice, setChoice] = useState<{ projectPath: string | null; value: PipelineLaunch } | null>(null);
  const value = choice?.projectPath === projectPath ? choice.value : typeof start === "string" ? pipelineLaunchDefaults(settings, start === "issue") : start;
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
