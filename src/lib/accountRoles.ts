/**
 * Keeping the account's organizations and roles current.
 *
 * The organizations and the role in each are part of the desktop session,
 * which the token refresh renews only every half hour. So that a role changed
 * elsewhere (an owner demoting this admin) shows here, they are read again
 * from the account service (`account_refresh_roles`, no token rotates):
 *
 * - on launch, and when the window gets the focus (at most once a minute);
 * - on "Refresh all" and "Refresh cloud workspaces";
 * - at once when a cloud call is refused for lack of role or membership;
 * - at once when a workspace list says otherwise (`noteListedOrgRole`).
 *
 * This module has no dependencies, so the API layer and the catalog can ask
 * without importing the account store, which registers itself here.
 */

export interface AccountRoleHandlers {
  /** Read the organizations and roles again; `force` skips the once-a-minute throttle. */
  refresh: (force: boolean) => Promise<void>;
  /** A workspace list, asked for at `askedAt` (a `roleAskStamp()`), says whether this person manages the organization. */
  listed: (orgId: string, manages: boolean | null, askedAt: number) => void;
}

let handlers: AccountRoleHandlers | null = null;

let asks = 0;

/**
 * A stamp for a question about the roles (a read of the account's roles, or a
 * workspace list), taken when it is asked. Each is greater than every one
 * before it, so which of two questions was asked later is never in doubt.
 * The wall clock cannot say: two asked in the same millisecond read the same
 * `Date.now()`, and the clock can be set back.
 */
export function roleAskStamp(): number {
  return ++asks;
}

/** The account store registers itself; null unregisters (tests). */
export function registerAccountRoles(next: AccountRoleHandlers | null) {
  handlers = next;
}

export function refreshAccountRoles(force = false): Promise<void> {
  return handlers ? handlers.refresh(force) : Promise.resolve();
}

/**
 * A workspace list reports this person's role on every workspace (`manager`
 * is an organization owner's or admin's) and is read every 30 seconds, so it
 * is usually the freshest word on the role. When it contradicts the role the
 * account holds, the menus follow the list at once and the account's roles
 * are read again. `askedAt` is the `roleAskStamp()` taken when the list was
 * asked for.
 */
export function noteListedOrgRole(orgId: string, manages: boolean | null, askedAt: number) {
  handlers?.listed(orgId, manages, askedAt);
}

function codeOf(error: unknown): string | null {
  const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
  return typeof code === "string" ? code : null;
}

/**
 * A refusal for lack of role: the server's `organization_admin_required`, or
 * `forbidden` from the organization routes and from a runtime that does not
 * let this connection manage. This person is not, or is no longer, an owner
 * or admin, so the role the app holds is older than the server's.
 */
export function isRoleRefusal(error: unknown): boolean {
  const code = codeOf(error);
  return code === "organization_admin_required" || code === "forbidden";
}

/**
 * A refusal because this account is not a member of the organization named
 * (or the server's active organization is another one): the organizations
 * the app holds are older than the server's.
 */
export function isMembershipRefusal(error: unknown): boolean {
  const code = codeOf(error);
  return code === "cloud_organization_unavailable" || code === "active_organization_required" || code === "not_found";
}

/** Every native call's failure passes here: a refusal for lack of role or membership reads the roles again at once. */
export function noteCallFailure(error: unknown) {
  if (isRoleRefusal(error) || isMembershipRefusal(error)) void refreshAccountRoles(true);
}

/** A refusal for lack of role, in the words of what was attempted. The app only offers these to an owner or admin, so the role it held has changed. */
export function roleRefusedMessage(action: string): string {
  return `Only an organization owner or admin can ${action} (your role changed).`;
}
