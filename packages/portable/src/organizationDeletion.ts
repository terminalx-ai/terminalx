/**
 * Deleting an organization, as every TerminalX client words and checks it
 * (#1292): the desktop app and the phone app import this, and the web console
 * in the account service mirrors it. Only an owner is offered deletion, never
 * for a personal organization, and the person types the organization's name.
 *
 * The server re-checks ownership and compares the name exactly; the client
 * always sends the organization's own name (`confirmationName`), never the
 * typed text, so trimming the typed text below cannot weaken that check.
 */

export const organizationDeletionText = {
  title: "Delete organization",
  start: "Delete organization…",
  warning: (name: string) =>
    `Permanently delete ${name}. Members will lose access. This cannot be undone. Shutting down cloud workspaces alone does not delete the organization.`,
  prompt: "Type this name to confirm deletion:",
  inputLabel: "Organization name to delete",
  copy: "Copy name",
  copied: "Copied",
  confirm: (name: string) => `Delete ${name} permanently`,
  cancel: "Cancel",
} as const;

/** Whether deletion may be offered: owners only, never a personal organization, and only one with a name to type. */
export function organizationDeletionOffered(organization: { role: string; isPersonal?: boolean | null; name: string }): boolean {
  return organization.role === "owner" && organization.isPersonal !== true && organization.name.trim() !== "";
}

/** The typed text confirms the organization's name; leading and trailing spaces are ignored, case is not. */
export function organizationNameConfirmed(typed: string, name: string): boolean {
  const expected = name.trim();
  return expected !== "" && typed.trim() === expected;
}

const MESSAGES: Record<string, string> = {
  account_signed_out: "Sign in again before deleting an organization.",
  invalid_access_token: "Refresh your account or sign in again before deleting the organization.",
  account_context_changed: "Your account or organization changed. Refresh the organization settings and confirm again.",
  account_context_changed_after_send: "Your account changed after the request was sent. Deletion may have completed; refresh the original account before trying again.",
  organization_not_found: "The organization no longer exists or you are no longer a member. Refresh the organization list.",
  organization_owner_required: "Only the current organization owner can delete it. Refresh your role before trying again.",
  organization_personal_protected: "Personal/default organizations cannot be deleted.",
  organization_confirmation_invalid: "The name no longer matches. Refresh the organization settings and type its current name exactly.",
  organization_delete_blocked: "Finish cloud cleanup and disconnect remaining provider or GitHub connections in this organization's settings before deleting it. Deletion does not start resource cleanup automatically.",
  organization_delete_busy: "The organization changed or still has dependent resources. Refresh its settings and finish cleanup before trying again.",
  organization_delete_unavailable: "Deletion is unavailable. Refresh the account before trying again.",
  organization_delete_outcome_unknown: "The deletion result could not be confirmed. It may have completed. Refresh the organization list before trying again; do not assume the organization still exists.",
};

const BLOCKERS: Record<string, string> = {
  cloud_cleanup_required: "Use Cloud cleanup to finish removing cloud resources.",
  provider_disconnect_required: "Disconnect the organization's provider connections after their resources are cleaned up.",
  teardown_in_progress: "Wait for the existing cloud cleanup to finish.",
  github_disconnect_required: "Disconnect this organization's GitHub connection; do not uninstall a shared installation.",
};

/** The server's refusal codes the deletion knows; any other answer may have deleted it. */
export const ORGANIZATION_DELETION_REFUSALS = [
  "invalid_access_token", "organization_not_found", "organization_owner_required", "organization_personal_protected",
  "organization_confirmation_invalid", "organization_delete_blocked", "organization_delete_busy",
] as const;

/** Allowlisted error codes; never render arbitrary backend payloads or follow cleanup URLs. */
export function organizationDeletionError(failure: unknown): string {
  const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
  const blockers = code === "organization_delete_blocked" && failure && typeof failure === "object" && "blockers" in failure && Array.isArray(failure.blockers)
    ? failure.blockers.filter((value): value is string => typeof value === "string").map((value) => BLOCKERS[value]).filter(Boolean)
    : [];
  return [MESSAGES[code] ?? MESSAGES.organization_delete_outcome_unknown, ...blockers].join(" ");
}

/** The blocker codes of a server refusal body (`{ blockers: [{ code }] }`), allowlisted. */
export function organizationDeletionBlockers(body: unknown): string[] {
  const list = body && typeof body === "object" && "blockers" in body && Array.isArray(body.blockers) ? body.blockers : [];
  return list
    .map((entry: unknown) => (entry && typeof entry === "object" && "code" in entry && typeof entry.code === "string" ? entry.code : ""))
    .filter((value: string) => Object.prototype.hasOwnProperty.call(BLOCKERS, value));
}
