/**
 * The way from a message elsewhere in the app to an organization's page in
 * Settings → Organizations (PRO-107), and on it to its Agent logins. The
 * shell opens Settings on the request; the Organizations section opens the
 * page of the organization it names, and the logins section scrolls itself
 * into view when it takes the request, which may be after it has mounted.
 */
const OPEN_ORGANIZATION_SETTINGS = "terminalx:open-organization-settings";

/** The page asked for: an organization's id, or null for the active one. Undefined: none asked for. */
let wantedOrganization: string | null | undefined;
/** Whose Agent logins should come into view: an organization's id, or null for whichever page opens. */
let wantedLogins: { organizationId: string | null } | null = null;

function request(organizationId: string | null, logins: boolean): void {
  wantedOrganization = organizationId;
  // A request replaces whatever an earlier one asked for, the logins coming into view included.
  wantedLogins = logins ? { organizationId } : null;
  window.dispatchEvent(new Event(OPEN_ORGANIZATION_SETTINGS));
}

/** Open `organizationId`'s page in Settings (the active organization's when null). */
export function openOrganizationSettings(organizationId: string | null): void {
  request(organizationId, false);
}

/** Open `organizationId`'s page at its Agent logins: the organization a workspace or message belongs to. */
export function openAgentLogins(organizationId: string | null): void {
  request(organizationId, true);
}

export function onOpenOrganizationSettings(listener: () => void): () => void {
  window.addEventListener(OPEN_ORGANIZATION_SETTINGS, listener);
  return () => window.removeEventListener(OPEN_ORGANIZATION_SETTINGS, listener);
}

/** The page asked for, once per request: an organization's id, null for the active one, undefined when none was. */
export function takeOrganizationRequest(): string | null | undefined {
  const was = wantedOrganization;
  wantedOrganization = undefined;
  return was;
}

/**
 * Drop a request for the logins to come into view that no page will take
 * (the organization it named has no page here), so it never scrolls a page
 * opened later by hand.
 */
export function forgetAgentLoginsRequest(): void {
  wantedLogins = null;
}

/** True once per request, and only for the organization it named (any, when it named none). */
export function takeAgentLoginsRequest(organizationId: string): boolean {
  if (!wantedLogins || (wantedLogins.organizationId !== null && wantedLogins.organizationId !== organizationId)) return false;
  wantedLogins = null;
  return true;
}
