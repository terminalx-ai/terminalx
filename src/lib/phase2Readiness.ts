import type { AccountStatus } from "@/lib/api";

export const phase2Features = {
  events: "team.events.v1",
  presence: "team.presence.v1",
  followReassign: "team.follow-reassign.v1",
  nudges: "team.nudges.v1",
  teamArtifacts: "team.artifacts.v1",
  sharedSetups: "team.shared-setups.v1",
  mentions: "team.mentions.v1",
  restartDetails: "cloud.workspaces.restart-details.v1",
  workspaceGroups: "cloud.workspace-groups.v1",
  organizationAutomations: "cloud.automations.organization.v1",
  freshWorkspace: "cloud.automations.fresh-workspace.v1",
  githubTrigger: "cloud.automations.github-trigger.v1",
  precreateUsage: "cloud.workspaces.precreate-usage.v1",
  workspaceTransferToLocal: "cloud.workspaces.transfer-to-local.v1",
  workspaceAccessRequest: "cloud.workspaces.access-request-copy.v1",
  agentLoginAffectedWorkspaces: "cloud.agent-logins.affected-workspaces.v1",
  webhookTrigger: "cloud.automations.webhook-trigger.v1",
  cloudDesktop: "cloud.desktop.v1",
  workspaceSsh: "cloud.workspaces.ssh.v1",
  adminShare: "cloud.workspaces.admin-share.v1",
  generalAccess: "cloud.workspaces.general-access.v1",
  invitesWelcome: "organization.invites-welcome.v1",
  mcpServers: "organization.mcp-servers.v1",
  desktopBilling: "organization.desktop-billing.v1",
  announcements: "desktop.announcements.v1",
} as const;

export function phase2Ready(status: AccountStatus, orgId: string, feature: keyof typeof phase2Features): boolean {
  const features = status.phase2Readiness?.[orgId];
  return status.state === "signed-in" && Array.isArray(features) && features.includes(phase2Features[feature]);
}

/**
 * A feature about joining an organization (PRO-175): the invitee is not a
 * member of it yet, so it is on when any of their organizations says so. The
 * server applies the same rule to the routes it guards.
 */
export function phase2ReadyAnywhere(status: AccountStatus, feature: keyof typeof phase2Features): boolean {
  return Object.keys(status.phase2Readiness ?? {}).some((orgId) => phase2Ready(status, orgId, feature));
}
