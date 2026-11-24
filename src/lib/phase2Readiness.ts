import type { AccountStatus } from "@/lib/api";

export const phase2Features = {
  events: "team.events.v1",
  presence: "team.presence.v1",
  followReassign: "team.follow-reassign.v1",
  restartDetails: "cloud.workspaces.restart-details.v1",
  freshWorkspace: "cloud.automations.fresh-workspace.v1",
  githubTrigger: "cloud.automations.github-trigger.v1",
  workspaceAccessRequest: "cloud.workspaces.access-request-copy.v1",
  webhookTrigger: "cloud.automations.webhook-trigger.v1",
} as const;

export function phase2Ready(status: AccountStatus, orgId: string, feature: keyof typeof phase2Features): boolean {
  const features = status.phase2Readiness?.[orgId];
  return status.state === "signed-in" && Array.isArray(features) && features.includes(phase2Features[feature]);
}
