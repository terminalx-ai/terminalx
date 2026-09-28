import { invoke } from "@tauri-apps/api/core";

// Member management for the account's active organization. Authentication and
// organization scope are resolved natively; mutations carry the roster's
// contextRevision so a request started under one account or organization is
// refused after a switch instead of landing somewhere else.

export type AssignableRole = "admin" | "member";

export interface OrganizationMember {
  userId: string;
  email: string;
  displayName?: string;
  photoUrl?: string;
  role: string;
}

export interface PendingInvite {
  email: string;
  role: string;
  createdAt: number;
  expiresAt?: number;
  status?: "pending" | "expired";
}

export interface IssuedInvite {
  email: string;
  role: string;
  inviteUrl?: string;
  emailSent: boolean;
  deduplicated: boolean;
}

export interface OrganizationRoster {
  members: OrganizationMember[];
  pendingInvites: PendingInvite[];
  viewerRole: string;
  canManageMembers: boolean;
  invite?: IssuedInvite;
  contextRevision: string;
}

export interface OrganizationMembersError {
  code: string;
  status: number | null;
  retryAfterSeconds: number | null;
}

export const organizationMembers = {
  list: () => invoke<OrganizationRoster>("organization_members"),
  invite: (email: string, role: AssignableRole, contextRevision: string) =>
    invoke<OrganizationRoster>("organization_member_invite", { email, role, contextRevision }),
  revokeInvite: (email: string, contextRevision: string) =>
    invoke<OrganizationRoster>("organization_invite_revoke", { email, contextRevision }),
  updateRole: (userId: string, role: AssignableRole, contextRevision: string) =>
    invoke<OrganizationRoster>("organization_member_role_update", { userId, role, contextRevision }),
  remove: (userId: string, contextRevision: string) =>
    invoke<OrganizationRoster>("organization_member_remove", { userId, contextRevision }),
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isInvitableEmail(email: string): boolean {
  const value = email.trim();
  return value.length <= 320 && EMAIL_PATTERN.test(value);
}

export function membersErrorMessage(error: unknown): string {
  const failure = error as Partial<OrganizationMembersError> | null;
  const code = typeof failure?.code === "string" ? failure.code : "";
  const wait = failure?.retryAfterSeconds;
  switch (code) {
    case "invalid_email":
      return "Enter a valid email address.";
    case "already_member":
      return "That person is already a member of this organization.";
    case "invite_recently_sent":
      return `An invite was just sent to that address. Try again in ${wait ?? 60} seconds.`;
    case "invite_rate_limited":
      return "This organization has sent too many invites recently. Try again later.";
    case "personal_org_no_invites":
      return "Personal organizations cannot invite members.";
    case "organization_requires_pro":
      return "Inviting and changing roles requires TerminalX Pro.";
    case "forbidden":
      return "Only organization owners and admins can manage members.";
    case "cannot_change_own_role":
      return "You cannot change your own role.";
    case "cannot_change_owner_role":
      return "The owner's role cannot be changed.";
    case "cannot_remove_owner":
      return "The owner cannot be removed.";
    case "cannot_remove_self":
      return "You cannot remove yourself.";
    case "not_found":
      return "That member or organization is no longer available. The list has been refreshed.";
    case "account_context_changed":
      return "Your account or organization changed. The list has been refreshed.";
    case "account_signed_out":
      return "Sign in to manage organization members.";
    case "account_organization_unavailable":
      return "Select an organization to manage its members.";
    case "unauthorized":
      return "Your session expired. Sign in again.";
    default:
      return "TerminalX could not reach the account service. Try again.";
  }
}
