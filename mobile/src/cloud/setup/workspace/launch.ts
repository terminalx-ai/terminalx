import type { CloudOperation, CloudWorkspace, CloudWorkspaceItem } from "../../api";
import { EVENT_SENTENCES, LAUNCH, LAUNCH_STAGES, LEFT, NEXT, launchCause, type LaunchFailureKind } from "./sentences";

/**
 * A launch as the workspace page shows it (25.05, its last two rows): the
 * operation's stages, how far it is, and, when it did not finish, why, what
 * it left at the provider, and what can be done next. Everything here comes
 * from the operation the server answers; nothing is guessed.
 */

/** Queued, running or being canceled: the server is still at it. */
export function operationOpen(operation: { state: string } | null | undefined): boolean {
  return !!operation && (operation.state === "queued" || operation.state === "running" || operation.state === "cancel-requested");
}

/**
 * The list's latest operation when it is this workspace's launch (a create,
 * not a later stop, start or delete), and the page should show it: while it
 * runs, and once it failed or was canceled without the workspace running.
 */
export function listedLaunch(item: CloudWorkspaceItem | null | undefined): { id: string; state: string } | null {
  const operation = item?.latestOperation as ({ id: string; state: string; action?: string | null; type?: unknown } | null | undefined);
  if (!item || !operation || operation.type !== "create" || operation.action) return null;
  if (operationOpen(operation)) return operation;
  const state = item.workspace.state;
  if ((operation.state === "failed" || operation.state === "canceled") && state !== "ready" && state !== "suspended" && state !== "suspending" && state !== "resuming") return operation;
  return null;
}

const STAGE_INDEX: Readonly<Record<string, number>> = { queued: 0, preflight: 1, "creating-machine": 2, bootstrapping: 3, "connecting-relay": 4, ready: 5 };
const EVENT_STAGE: Readonly<Record<string, number>> = {
  "operation-queued": 0,
  "provider-preflight-started": 1,
  "machine-allocation-started": 2,
  "runtime-installation-started": 3,
  "credentials-installing": 3,
  "credentials-ready": 3,
  "repository-cloning": 3,
  "repository-ready": 3,
  "repository-clone-failed": 3,
  "relay-connection-started": 4,
  "workspace-ready": 5,
};

/**
 * The stage the operation is at. While it cleans up (after a cancel or a
 * failure) its stage says only that, so the stage it had reached is the
 * furthest one its events name.
 */
export function stageIndex(operation: Pick<CloudOperation, "stage" | "events">): number {
  const named = operation.stage ? STAGE_INDEX[operation.stage] : undefined;
  if (named !== undefined) return named;
  return (operation.events ?? []).reduce((furthest, event) => Math.max(furthest, EVENT_STAGE[event.code] ?? -1), 0);
}

/** The newest event that belongs to the stage under way and has words, else nothing. */
function stageEvent(operation: Pick<CloudOperation, "events">, stage: number): string | undefined {
  const events = [...(operation.events ?? [])].sort((left, right) => right.occurredAt - left.occurredAt);
  for (const event of events) {
    if (EVENT_STAGE[event.code] !== stage) continue;
    return EVENT_SENTENCES[event.code];
  }
  return undefined;
}

/** What a launch that ended left at the provider, from its cleanup report and the stage it reached. */
export function leftAtProvider(operation: Pick<CloudOperation, "cleanup" | "reason" | "stage" | "events">, provider: string): { text: string; costs: boolean } {
  const compute = operation.cleanup?.items.find((item) => item.kind === "provider-compute");
  if (compute?.state === "removed") return { text: LEFT.removed, costs: false };
  if (operation.reason === "attention-stopped") return { text: LEFT.stopped, costs: true };
  // It stopped before a machine was asked for, and the report names none.
  if (!compute && stageIndex(operation) < STAGE_INDEX["creating-machine"]!) return { text: LEFT.none, costs: false };
  return { text: LEFT.unknown(provider), costs: true };
}

export type LaunchPhase = "running" | "canceling" | "finished" | "canceled" | "failed";

export interface LaunchView {
  phase: LaunchPhase;
  /** The heading over the stages. */
  title: string;
  stages: readonly string[];
  current: number;
  status: "running" | "failed" | "finished";
  /** Under the current stage: the latest event, or why it stopped. */
  detail?: string;
  /** Under the stages: what the person may do now, or what was left. `warning` when something may still cost money. */
  note: { text: string; tone: "plain" | "warning" } | null;
  /** The server says the operation can still be canceled. */
  cancelable: boolean;
  /** Why it did not finish, for the actions under it. */
  failure: LaunchFailureKind | "canceled" | null;
}

/** The launch page for an operation as the server last answered it. */
export function launchView(operation: CloudOperation, workspace: Pick<CloudWorkspace, "name">, provider: string): LaunchView {
  const current = stageIndex(operation);
  const base = { stages: LAUNCH_STAGES, current };
  if (operation.state === "succeeded") {
    return { ...base, phase: "finished", title: LAUNCH.running(workspace.name), current: LAUNCH_STAGES.length - 1, status: "finished", note: { text: LAUNCH.opening, tone: "plain" }, cancelable: false, failure: null };
  }
  if (operation.state === "cancel-requested" || (operationOpen(operation) && operation.stage === "cleanup")) {
    return { ...base, phase: "canceling", title: LAUNCH.canceling, status: "running", detail: LAUNCH.cleaningUp, note: { text: LAUNCH.removing, tone: "plain" }, cancelable: false, failure: null };
  }
  if (operation.state === "canceled") {
    const left = leftAtProvider(operation, provider);
    return { ...base, phase: "canceled", title: LAUNCH.canceled, status: "failed", detail: LAUNCH.canceledStage, note: { text: `${left.text} ${NEXT.canceled}`, tone: left.costs ? "warning" : "plain" }, cancelable: false, failure: "canceled" };
  }
  if (operation.state === "failed") {
    const cause = launchCause(operation.errorCode);
    const left = leftAtProvider(operation, provider);
    const text = cause.kind === "runtime" ? `${left.text} ${NEXT.runtime}`
      : cause.kind === "key" ? `${left.text} ${NEXT.key}`
      : `${NEXT.startOver} ${left.text}`;
    return { ...base, phase: "failed", title: LAUNCH.failed, status: "failed", detail: cause.text, note: { text, tone: left.costs ? "warning" : "plain" }, cancelable: false, failure: cause.kind };
  }
  return { ...base, phase: "running", title: LAUNCH.launching, status: "running", detail: stageEvent(operation, current), note: { text: operation.cancelable ? LAUNCH.mayLeave : LAUNCH.noLongerCancelable, tone: "plain" }, cancelable: operation.cancelable, failure: null };
}
