import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import { launchFailureStands, resolveCloudAttention, type CloudAttentionInput } from "@/lib/cloudAttention";
import { liveCloudOrgIds } from "@/lib/cloudCatalog";
import { workspaceAuthority } from "@/lib/cloudCollab";
import { launchFailed } from "@/lib/cloudCreate";
import { isOpen, operationFailureStands } from "@/lib/cloudLifecycle";
import { privacyEnabled } from "@/lib/dataPrivacy";

export const CLOUD_START_RECOVERY = "cloud.workspaces.start-recovery.v1";

export function startRecoveryAvailable(status: AccountStatus, orgId: string): boolean {
  const features = status.phase2Readiness?.[orgId];
  return !privacyEnabled() && liveCloudOrgIds(status).includes(orgId)
    && Array.isArray(features) && features.includes(CLOUD_START_RECOVERY);
}

const GITHUB_ACCESS_FAILURES = new Set([
  "repository-access-denied",
  "cloud_workspace_repository_not_accessible",
  "cloud_workspace_repository_credential_required",
  "github_repository_not_accessible",
  "github_repository_not_authorized",
  "github_repository_not_granted",
]);

export function resolveCloudStartFailure(item: CloudWorkspaceListItem, input: CloudAttentionInput = {}) {
  const { workspace, latestOperation: operation } = item;
  if (!["ready", "attention-required", "provisioning", "suspended"].includes(workspace.state)
    || workspace.you?.role === "none" || isOpen(operation)) return null;
  const attention = resolveCloudAttention(item, { ...input, canRetryFirstTask: false });
  if (!attention || attention.recovery.action === "update-runtime") return null;

  const failedOperation = operationFailureStands(item) && attention.code === (operation?.errorCode ?? "cloud_workspace_operation_failed");
  if (failedOperation && (operation?.transportAction === "restart" || (operation?.action && operation.action !== "resume"))) return null;
  const failedLaunch = launchFailed(item) && launchFailureStands(item, input);
  if (!failedOperation && !failedLaunch) return null;

  const timings = failedLaunch ? workspace.launch?.timings : null;
  const setupFailed = (timings?.syncingAt != null || timings?.startingAgentAt != null)
    || (failedOperation && operation?.action === null && (operation.stage === "bootstrapping"
      || operation.stage === "connecting-relay" || !!operation.events?.some((event) => event.code === "runtime-installation-started")));
  return {
    attention,
    label: setupFailed ? "Setup failed" : "Didn't start",
    title: setupFailed ? `Setup failed for ${workspace.name}` : "The cloud workspace didn't start",
    githubAccess: GITHUB_ACCESS_FAILURES.has(attention.code),
    retryResume: attention.recovery.operationAction === "resume" && workspaceAuthority(workspace).lifecycle,
  };
}
