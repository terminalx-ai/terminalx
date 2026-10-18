import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { issuePipelines as pipelinesApi } from "@/lib/api";
import { actOnCloudPipeline, getCloudPipelines, mergeCloudPipeline, subscribeCloudPipelines } from "@/lib/cloudPipelines";
import { notePipelineState } from "@/lib/notify";
import { getPrefs } from "@/lib/prefs";
import type { IssuePipeline, IssuePipelineSettings, PipelineAction, PipelineStage, StartedIssuePipeline } from "@/types/issuePipeline";

/**
 * Issue pipelines as the Rust side reports them. The pipeline itself runs
 * there: it moves when a session's turn ends or a check finishes, whether or
 * not a window is showing it. This is only what the window knows of it.
 * A cloud workspace's pipelines run in its runtime (`@/lib/cloudPipelines`),
 * and are listed here beside this computer's, under their cloud project.
 */
interface State {
  loaded: boolean;
  pipelines: IssuePipeline[];
}

let state: State = { loaded: false, pipelines: [] };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function upsertPipeline(pipeline: IssuePipeline) {
  const previous = state.pipelines.find((value) => value.id === pipeline.id);
  set({ pipelines: previous ? state.pipelines.map((value) => (value.id === pipeline.id ? pipeline : value)) : [...state.pipelines, pipeline] });
  // A pipeline first heard of at rest is not news; one that came to rest is.
  if (previous && previous.state !== pipeline.state) notePipelineState(pipeline);
}

let booted = false;
export async function bootIssuePipelines() {
  if (booted) return;
  booted = true;
  try {
    await listen<IssuePipeline>("issue_pipeline", (event) => upsertPipeline(event.payload));
  } catch {
    /* outside a webview */
  }
  try {
    const listed = await pipelinesApi.list();
    // Anything announced while the list was on its way is newer than the list.
    const heard = new Set(state.pipelines.map((value) => value.id));
    set({ pipelines: [...listed.filter((value) => !heard.has(value.id)), ...state.pipelines], loaded: true });
  } catch {
    set({ loaded: true });
  }
}

let combined: { local: IssuePipeline[]; cloud: IssuePipeline[]; all: IssuePipeline[] } | null = null;

/** This computer's pipelines, then the cloud workspaces'. The same array until either changes. */
function allPipelines(): IssuePipeline[] {
  const cloud = getCloudPipelines();
  if (combined?.local !== state.pipelines || combined.cloud !== cloud) {
    combined = { local: state.pipelines, cloud, all: cloud.length ? [...state.pipelines, ...cloud] : state.pipelines };
  }
  return combined.all;
}

export function useIssuePipelines(): IssuePipeline[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const stopCloud = subscribeCloudPipelines(listener);
      return () => {
        listeners.delete(listener);
        stopCloud();
      };
    },
    allPipelines,
    allPipelines,
  );
}

export function getIssuePipelines(): IssuePipeline[] {
  return allPipelines();
}

/** Start the pipeline for a session that was just created from an issue. */
export async function startPipeline(sessionId: string, tabId: string, autoMerge: boolean | null): Promise<StartedIssuePipeline> {
  const started = await pipelinesApi.start(sessionId, tabId, autoMerge);
  upsertPipeline(started.pipeline);
  return started;
}

export async function setPipelineAutoMerge(id: string, value: boolean): Promise<IssuePipeline> {
  const pipeline = await pipelinesApi.setAutoMerge(id, value);
  upsertPipeline(pipeline);
  return pipeline;
}

export async function actOnPipeline(id: string, action: PipelineAction): Promise<IssuePipeline> {
  const pipeline = await pipelinesApi.act(id, action);
  upsertPipeline(pipeline);
  return pipeline;
}

/**
 * What a button on the issue page does, wherever the pipeline runs: on this
 * computer, or in its cloud workspace's runtime. A cloud workspace's merge is
 * made here, with the reader's own `gh`; when nothing is merged, the reason
 * is the error.
 */
export async function actOnAnyPipeline(pipeline: IssuePipeline, action: PipelineAction): Promise<void> {
  if (!pipeline.place) {
    await actOnPipeline(pipeline.id, action);
    return;
  }
  if (action !== "merge") return actOnCloudPipeline(pipeline, action);
  const refused = await mergeCloudPipeline(pipeline, cloudPipelineSettings(pipeline.place.projectKey));
  if (refused) throw new Error(refused);
}

// ---- reading a pipeline

const newest = (a: IssuePipeline, b: IssuePipeline) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0);

/** The pipeline of an issue in a project: the newest, when it was worked on more than once. */
export function pipelineForIssue(pipelines: IssuePipeline[], projectPath: string, issueUrl: string): IssuePipeline | null {
  return pipelines.filter((value) => value.projectPath === projectPath && value.issue.url === issueUrl).sort(newest)[0] ?? null;
}

/**
 * A project's pipelines on issues the tracker's list does not hold, one per
 * issue, newest first. A merge closes its issue, and a closed issue leaves a
 * list of open ones, while its page is where the record of that merge is read.
 */
export function unlistedPipelines(pipelines: IssuePipeline[], projectPath: string, provider: IssuePipeline["issue"]["provider"], listedUrls: Iterable<string>, limit = 20): IssuePipeline[] {
  const seen = new Set(listedUrls);
  const found: IssuePipeline[] = [];
  for (const value of pipelines.filter((value) => value.projectPath === projectPath && value.issue.provider === provider).sort(newest)) {
    if (seen.has(value.issue.url)) continue;
    seen.add(value.issue.url);
    found.push(value);
  }
  return found.slice(0, limit);
}

/** The pipeline a session takes part in, and as what. */
export function pipelineForSession(pipelines: IssuePipeline[], sessionId: string): { pipeline: IssuePipeline; role: "author" | "reviewer" } | null {
  const found = pipelines.filter((value) => value.author.sessionId === sessionId || value.reviewer?.sessionId === sessionId).sort(newest)[0];
  return found ? { pipeline: found, role: found.author.sessionId === sessionId ? "author" : "reviewer" } : null;
}

export type PipelineTone = "add" | "warning" | "info" | "merged" | "faint";

/** Where a pipeline stands, in the two or three words a chip can hold. */
export function pipelineHeadline(pipeline: IssuePipeline): { label: string; tone: PipelineTone } {
  switch (pipeline.state) {
    case "merged":
      return { label: "Merged", tone: "merged" };
    case "readyToMerge":
      return { label: "Ready to merge", tone: "add" };
    case "needsYou":
      return { label: "Needs you", tone: "warning" };
    case "stopped":
      return { label: "Stopped", tone: "faint" };
    case "waiting":
      // Checks running, or not listed yet; otherwise it is GitHub itself: mergeability, a merge queue.
      return { label: pipeline.note?.includes("checks") ? "Waiting for checks" : "Waiting for GitHub", tone: "info" };
    case "working":
      return { label: WORKING[pipeline.stage], tone: "info" };
  }
}

const WORKING: Record<PipelineStage, string> = {
  work: "Working",
  pullRequest: "Opening pull request",
  review: "In review",
  address: "Addressing findings",
  merge: "Checking",
};

export const PIPELINE_STAGES: { stage: PipelineStage; label: string }[] = [
  { stage: "work", label: "Work" },
  { stage: "pullRequest", label: "Pull request" },
  { stage: "review", label: "Review" },
  { stage: "address", label: "Address" },
  { stage: "merge", label: "Merge" },
];

export type StepStatus = "done" | "current" | "attention" | "stopped" | "pending" | "skipped";

export interface PipelineStep {
  stage: PipelineStage;
  label: string;
  status: StepStatus;
  /** What there is to say beside the stage's name. */
  detail: string | null;
}

/**
 * The five stages with where each stands. Review and Address alternate, so
 * "done" for Address means the last review asked for nothing more, and a
 * pipeline that went straight from its first review to the merge skipped it.
 */
export function pipelineSteps(pipeline: IssuePipeline): PipelineStep[] {
  const at = PIPELINE_STAGES.findIndex((value) => value.stage === pipeline.stage);
  const here: StepStatus = pipeline.state === "needsYou" ? "attention" : pipeline.state === "stopped" ? "stopped" : pipeline.state === "merged" || pipeline.state === "readyToMerge" ? "done" : "current";
  return PIPELINE_STAGES.map(({ stage, label }, index) => {
    let status: StepStatus = index < at ? "done" : index === at ? here : "pending";
    // Past the reviews without ever sending findings back.
    if (stage === "address" && index < at && pipeline.round <= 1) status = "skipped";
    // In a later review, the round of fixes before it is behind us.
    if (stage === "address" && pipeline.stage === "review" && pipeline.round > 1) status = "done";
    return { stage, label, status, detail: stepDetail(pipeline, stage, status) };
  });
}

function stepDetail(pipeline: IssuePipeline, stage: PipelineStage, status: StepStatus): string | null {
  if (status === "pending") return null;
  const short = (commit: string) => commit.slice(0, 7);
  switch (stage) {
    case "pullRequest":
      return pipeline.pr ? `#${pipeline.pr.number}` : null;
    case "review":
      if (pipeline.round === 0) return null;
      if (status === "current") return `Round ${pipeline.round} of ${pipeline.maxRounds}`;
      return pipeline.verdict ? `${pipeline.verdict.findings.length === 0 ? "No findings" : countOf(pipeline.verdict.findings.length, "finding")} at ${short(pipeline.verdict.commit)}` : `Round ${pipeline.round} of ${pipeline.maxRounds}`;
    case "address":
      return status === "skipped" ? "Nothing to address" : null;
    case "merge":
      return pipeline.merged ? `${short(pipeline.merged.commit)} into ${pipeline.pr?.base ?? "the base branch"}` : pipeline.state === "readyToMerge" ? "Ready" : null;
    default:
      return null;
  }
}

export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface PipelineActionButton {
  action: PipelineAction;
  label: string;
}

/**
 * What the issue page offers for a pipeline: at most one thing that moves it
 * forward, and the lesser ones beside it. Merging by hand is only offered
 * where the pipeline itself says the change is ready.
 */
export function pipelineActions(pipeline: IssuePipeline): { primary: PipelineActionButton | null; secondary: PipelineActionButton[] } {
  const stop: PipelineActionButton = { action: "stop", label: "Stop" };
  switch (pipeline.state) {
    case "merged":
      return { primary: null, secondary: [] };
    case "stopped":
      return { primary: { action: "resume", label: "Resume" }, secondary: [] };
    case "readyToMerge":
      return { primary: { action: "merge", label: "Merge" }, secondary: [{ action: "refresh", label: "Check again" }, stop] };
    case "waiting":
      return { primary: null, secondary: [{ action: "refresh", label: "Check again" }, stop] };
    case "working":
      // The author may be done and not have said so, or have said so while the pipeline was stopped.
      if (pipeline.stage === "work") return { primary: null, secondary: [{ action: "advance", label: "Open pull request now" }, stop] };
      if (pipeline.stage === "address") return { primary: null, secondary: [{ action: "advance", label: "Review the changes now" }, stop] };
      return { primary: null, secondary: [stop] };
    case "needsYou": {
      const kind = pipeline.reason?.kind;
      // A head nobody reviewed, or a review that never produced a verdict: the fix is a review.
      if (pipeline.stage === "merge" && (kind === "headMoved" || kind === "noVerdict")) {
        return { primary: { action: "review", label: "Review the new commit" }, secondary: [{ action: "refresh", label: "Check again" }, stop] };
      }
      // Findings left open at the round limit: one more round is the reader's to grant.
      if (kind === "roundLimit") return { primary: { action: "advance", label: "Review once more" }, secondary: [stop] };
      return { primary: { action: "advance", label: ADVANCE[pipeline.stage] }, secondary: [stop] };
    }
  }
}

const ADVANCE: Record<PipelineStage, string> = {
  work: "Open pull request",
  pullRequest: "Try again",
  review: "Review again",
  address: "Review the changes",
  merge: "Check again",
};

export const DEFAULT_PIPELINE_SETTINGS: IssuePipelineSettings = {
  enabled: true,
  autoMerge: false,
  requirePerson: false,
  maxRounds: 3,
  mergeMethod: "merge",
  protected: { migrations: true, deploy: true, security: true, paths: [] },
  ignoredChecks: [],
};

/** A project's pipeline settings, with the defaults for whatever it has not set. */
export function pipelineSettings(project: { issuePipeline?: IssuePipelineSettings | null } | null | undefined): IssuePipelineSettings {
  const stored = project?.issuePipeline;
  return stored ? { ...DEFAULT_PIPELINE_SETTINGS, ...stored, protected: { ...DEFAULT_PIPELINE_SETTINGS.protected, ...stored.protected } } : DEFAULT_PIPELINE_SETTINGS;
}

/**
 * A cloud project's pipeline settings (`cloud:<orgId>:<identity>`). They are
 * kept on this computer and given to the workspace with each issue session
 * started from here, where its runtime reads them at each decision. A cloud
 * workspace never merges by itself, so the switches that decide that do not apply.
 */
export function cloudPipelineSettings(projectKey: string, prefs = getPrefs()): IssuePipelineSettings {
  return { ...pipelineSettings({ issuePipeline: prefs.cloudIssuePipelines[projectKey] }), autoMerge: false, requirePerson: false };
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
