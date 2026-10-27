/** Allowlisted native error codes; never render arbitrary backend payloads or follow cleanup URLs. */
export function organizationDeletionError(failure: unknown): string {
  const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
  const messages: Record<string, string> = {
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
  const blockerMessages: Record<string, string> = {
    cloud_cleanup_required: "Use Cloud cleanup to finish removing cloud resources.",
    provider_disconnect_required: "Disconnect the organization's provider connections after their resources are cleaned up.",
    teardown_in_progress: "Wait for the existing cloud cleanup to finish.",
    github_disconnect_required: "Disconnect this organization's GitHub connection; do not uninstall a shared installation.",
  };
  const blockers = code === "organization_delete_blocked" && failure && typeof failure === "object" && "blockers" in failure && Array.isArray(failure.blockers)
    ? failure.blockers.filter((value): value is string => typeof value === "string").map((value) => blockerMessages[value]).filter(Boolean)
    : [];
  return [messages[code] ?? messages.organization_delete_outcome_unknown, ...blockers].join(" ");
}
