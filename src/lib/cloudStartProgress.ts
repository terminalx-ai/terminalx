import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { PHASES, phaseOf } from "@/lib/cloudCreate";
import { formatDuration } from "@/lib/time";

export const CLOUD_START_PROGRESS = "cloud.workspaces.start-progress.v1";

export function cloudStartProgressReady(status: AccountStatus, orgId: string): boolean {
  const features = status.phase2Readiness?.[orgId];
  return status.state === "signed-in" && Array.isArray(features) && features.includes(CLOUD_START_PROGRESS);
}

export function cloudStartOperation(item: CloudWorkspaceListItem | null) {
  const operation = item?.latestOperation;
  return operation?.workspaceId === item?.workspace.id && operation?.type === "create" && !operation.action && !operation.transportAction ? operation : null;
}

export function cloudStartPhase(item: CloudWorkspaceListItem) {
  const { workspace } = item;
  const operation = cloudStartOperation(item);
  // The launch view calls cancel-requested "canceled" while compute is still being cleaned up.
  if (operation?.state === "cancel-requested") return "canceling";
  if (operation?.state === "canceled") return "canceled";
  if (workspace.state !== "provisioning" && workspace.state !== "ready") return null;
  if (!workspace.launch && !(workspace.state === "provisioning" && operation)) return null;
  const phase = workspace.launch?.phase ?? phaseOf(item);
  return PHASES.slice(0, -1).find((step) => step.id === phase)?.id ?? null;
}

export function cloudStartSteps(item: CloudWorkspaceListItem, phase: NonNullable<ReturnType<typeof cloudStartPhase>>, provider: string) {
  const { workspace } = item;
  const launch = workspace.launch;
  const timings = item.latestOperation?.action || item.latestOperation?.transportAction ? null : launch?.timings;
  const current = PHASES.findIndex((step) => step.id === phase);
  const repository = workspace.repositories?.find((repo) => repo.primary) ?? workspace.repositories?.[0];
  const repositoryDetail = [repository?.fullName, launch?.workBranch, repository?.ref ? `from ${repository.ref}` : null].filter(Boolean).join(" · ");
  const agentDetail = launch?.agent ? [cloudAgentLabel(launch.agent), launch.model, launch.effort].filter(Boolean).join(" · ") : null;
  const steps = [
    { label: "Allocate the cloud machine", detail: provider, at: timings?.requestedAt },
    { label: "Start the machine", detail: null, at: timings?.bootingAt },
    { label: "Connect the runtime through Relay", detail: workspace.runtime?.protocol ? `Runtime protocol ${workspace.runtime.protocol}` : null, at: timings?.authenticatingAt },
    { label: "Sync the repositories", detail: repositoryDetail, at: timings?.syncingAt },
    { label: launch?.hasPrompt ? "Start the agent and send your first message" : "Start the agent", detail: agentDetail, at: timings?.startingAgentAt },
  ];
  return steps.flatMap(({ label, detail, at }, index) => {
    // An explicit empty repo list plus no sync report lets us omit that row.
    if (index === 3 && workspace.repositories?.length === 0 && at == null && current !== index) return [];
    if (index === 4 && !launch) return [];
    const nextAt = steps[index + 1]?.at;
    const done = index < current;
    const duration = done && typeof at === "number" && typeof nextAt === "number" && Number.isFinite(at) && Number.isFinite(nextAt) && nextAt >= at
      ? formatDuration(nextAt - at)
      : null;
    return [{ label, detail, duration, state: done ? "done" : index === current ? "current" : "waiting" }];
  });
}
