import type { CloudShareRole, CloudWorkspaceShares } from "@/lib/api";

/**
 * This person's access in words: Owner, Admin, Creator, Driver or Viewer.
 * Organization and creator provenance must come from their own evidence.
 */
export function yourAccessText(
  you: CloudWorkspaceShares["you"],
  /** This person's role in the workspace's organization (`owner`, `admin`, `member`); null when not known. */
  orgRole: string | null,
  /** Whether they created the workspace; null when not known. */
  creator: boolean | null = null,
): string {
  const approves = you.canApprove ? ", can approve permissions" : "";
  switch (you.role) {
    case "manager":
      if (creator) return `Creator (you created this workspace: manages this workspace and who it is shared with)${approves}`;
      if (orgRole === "owner") return "Owner (the organization's owner: manages this workspace and who it is shared with)";
      if (orgRole === "admin") return "Admin (an organization admin: manages this workspace and who it is shared with)";
      return `${orgRole === "member" ? "Workspace Admin" : "Admin"} (manages this workspace and who it is shared with)${approves}`;
    case "driver":
      if (creator) return you.canApprove
        ? "Creator (you created this workspace: can send to agents, type in terminals, approve permissions and manage who it is shared with)"
        : "Creator (you created this workspace: can send to agents and manage who it is shared with; typing in terminals also needs the right to approve permissions)";
      // Typing in a terminal (a shell, or an agent's own) needs the approval right too (PRO-88).
      return you.canApprove ? `Driver (can send to agents and type in terminals)${approves}` : "Driver (can send to agents; typing in terminals also needs the right to approve permissions)";
    case "viewer":
      return `Viewer (can read everything, not send)${approves}`;
    case "none":
      return "No access to this workspace's content";
    default:
      return String(you.role);
  }
}

/** Owners, admins and the workspace's creator see it without a share; the server refuses one for them. */
export function alwaysHasAccess(member: { userId: string; role: string }, createdBy: string | null): boolean {
  return member.role === "owner" || member.role === "admin" || (!!createdBy && member.userId === createdBy);
}

export function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.message : String(error);
}

/** What a refused share change means, in words. */
export function shareErrorMessage(error: unknown, who?: string): string {
  const code = codeOf(error);
  switch (code) {
    case "cloud_workspace_share_redundant":
      return `${who ?? "This person"} already has access as owner/admin/creator.`;
    case "cloud_workspace_share_credential_restricted":
      return "Can send is not available here while the organization has an agent login that only owners and admins may use. Share as view only, or share that login with the whole organization first (Settings → Organizations → Agent logins).";
    case "cloud_workspace_share_personal_route":
      return "This workspace was handed its creator's own model credential (Settings → Organizations → Your model access) since it last started, and its sessions may still hold it, so it can't be opened to the organization or shared with Can send yet. Share as view only, or the creator switches that agent to the organization login or a credential helper and then stops and resumes the workspace.";
    case "cloud_workspace_share_requires_organization_access":
      return "Make the workspace visible to the organization first.";
    case "cloud_workspace_share_limit":
      return "This workspace is already shared with the maximum number of people (64). Revoke someone first.";
    case "cloud_workspace_share_forbidden":
      return "Only organization admins and the workspace's creator can change who it is shared with.";
    case "organization_member_not_found":
      return `${who ?? "This person"} is no longer a member of this organization.`;
    case "cloud_workspace_share_not_found":
      return "That share was already revoked.";
    case "cloud_workspace_last_admin":
      return "A workspace must have at least one admin.";
    case "cloud_workspace_group_manager_unsupported":
      return "Admin access can only be granted to a person.";
    case "cloud_workspace_runtime_not_ready":
      return "Admin grants are unavailable for this organization.";
    case "cloud_workspace_runtime_unsupported":
      return MANAGER_APPROVAL_REASON;
    case "cloud_workspace_not_found":
      return "This workspace no longer exists.";
    case "cloud_workspace_manager_required":
      return "Only this workspace's creator or an organization owner or admin can change whether it is private or visible to the organization. Ask one of them to change it.";
    case "organization_admin_required":
      return "Only an organization owner or admin can change whether a workspace is private or visible to the organization. Ask one to change it.";
    case "cloud_workspace_request_outcome_unknown":
      return "The server did not answer, so it is unknown whether this changed. Check the list and try again.";
    default:
      return `Could not change the share (${code}).`;
  }
}

export function shareRoleLabel(role: CloudShareRole): string {
  switch (role) {
    case "viewer": return "Viewer";
    case "driver": return "Driver";
    case "manager": return "Admin";
  }
}

export const ADMIN_SHARE_LABEL = "Admin";
export const MANAGER_APPROVAL_REASON = "Admin without permission approval is not supported by this workspace runtime.";

export const OUTCOME_UNKNOWN = "cloud_workspace_request_outcome_unknown";
