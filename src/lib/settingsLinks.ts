/**
 * The way from a message elsewhere in the app to an organization's page in
 * Settings → Organizations (PRO-107), and on it to its Agent logins. The
 * shell opens Settings on the request; the Organizations section opens the
 * page of the organization it names, and the logins section scrolls itself
 * into view when it takes the request, which may be after it has mounted.
 */
import type { AgentLoginProvider } from "@/lib/api";
import { settingById, type SettingId } from "@/components/settings/settingsRegistry";
import { showSettingEnabled, showSettingNotLinkable } from "@/lib/settingsToasts";

const OPEN_ORGANIZATION_SETTINGS = "terminalx:open-organization-settings";

/** The page asked for: an organization's id, or null for the active one. Undefined: none asked for. */
let wantedOrganization: string | null | undefined;
/** Whose Agent logins should come into view: an organization's id, or null for whichever page opens; and an agent to sign in again there. */
let wantedLogins: { organizationId: string | null; signIn: AgentLoginProvider | null } | null = null;
/** The agent a taken request asked to sign in again, for the logins section that took it. */
let wantedSignIn: { organizationId: string; agent: AgentLoginProvider } | null = null;

function request(organizationId: string | null, logins: boolean, signIn: AgentLoginProvider | null = null): void {
  wantedOrganization = organizationId;
  // A request replaces whatever an earlier one asked for, the logins coming into view included.
  wantedLogins = logins ? { organizationId, signIn } : null;
  wantedSignIn = null;
  window.dispatchEvent(new CustomEvent(OPEN_ORGANIZATION_SETTINGS, { detail: logins ? "organizations.agentLogins" : "organizations.overview" }));
}

/** Open `organizationId`'s page in Settings (the active organization's when null). */
export function openOrganizationSettings(organizationId: string | null): void {
  request(organizationId, false);
}

/**
 * Open `organizationId`'s page at its Agent logins: the organization a workspace or message belongs to. With `signIn`,
 * that agent's sign-in is opened there too (#667), at the consent it always asks for first.
 */
export function openAgentLogins(organizationId: string | null, signIn: AgentLoginProvider | null = null): void {
  request(organizationId, true, signIn);
}

export function onOpenOrganizationSettings(listener: (row: "organizations.overview" | "organizations.agentLogins") => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<"organizations.overview" | "organizations.agentLogins">).detail);
  window.addEventListener(OPEN_ORGANIZATION_SETTINGS, handler);
  return () => window.removeEventListener(OPEN_ORGANIZATION_SETTINGS, handler);
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
  wantedSignIn = null;
}

/** True once per request, and only for the organization it named (any, when it named none). */
export function takeAgentLoginsRequest(organizationId: string): boolean {
  if (!wantedLogins || (wantedLogins.organizationId !== null && wantedLogins.organizationId !== organizationId)) return false;
  wantedSignIn = wantedLogins.signIn ? { organizationId, agent: wantedLogins.signIn } : null;
  wantedLogins = null;
  return true;
}

/** The agent the request just taken for `organizationId` asked to sign in again, once; null when it asked for none. */
export function takeAgentLoginsSignIn(organizationId: string): AgentLoginProvider | null {
  if (wantedSignIn?.organizationId !== organizationId) return null;
  const agent = wantedSignIn.agent;
  wantedSignIn = null;
  return agent;
}

// ---- Links to any setting row (PRO-127): terminalx://settings/<row-id>[?enable=1]

/** The scheme and host every setting link starts with. */
export const SETTING_LINK_PREFIX = "terminalx://settings/";
const OPEN_SETTING_ROW = "terminalx:open-setting-row";

/** `terminalx://settings/<row-id>`: opens Settings at that row. The id is a registry row id, e.g. `general.sounds`. */
export function buildSettingLink(id: SettingId): string {
  return `${SETTING_LINK_PREFIX}${id}`;
}

export interface ParsedSettingLink {
  id: SettingId;
  /** The link asks to turn the setting on (`?enable=1`); only a linkable row ever is. */
  enable: boolean;
}

/**
 * A setting link, or null for anything else: scheme `terminalx:`, host
 * `settings`, exactly one path segment that is a registry row id, no
 * credentials, port or fragment, and no query other than `enable=1`.
 * Strict on purpose: the link may come from any other app.
 */
export function parseSettingLink(url: string): ParsedSettingLink | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "terminalx:" || parsed.host !== "settings" || parsed.username || parsed.password || parsed.port) return null;
  if (parsed.hash || url.includes("#")) return null;
  const segments = parsed.pathname.split("/");
  if (segments.length !== 2 || segments[0] !== "") return null;
  const id = segments[1];
  if (!settingById(id)) return null;
  // An empty "?" leaves `search` empty, so the raw link is checked too.
  const enable = url.includes("?");
  if (enable && parsed.search !== "?enable=1") return null;
  return { id: id as SettingId, enable };
}

export type EnableSettingResult = "enabled" | "not-linkable" | "unknown";

/**
 * Turn a setting on through its row's existing setter. Only rows the registry
 * marks `linkable` can be: every other row, and any id that is not a row,
 * changes nothing. The allowlist is the boundary for links from other apps.
 */
export async function enableSetting(id: string): Promise<EnableSettingResult> {
  const row = typeof id === "string" ? settingById(id) : undefined;
  if (!row) return "unknown";
  if (!row.linkable) return "not-linkable";
  await row.linkable.enable();
  return "enabled";
}

/** Ask the shell to open Settings at a row (the toast's Open setting, a followed link). */
export function openSettingRow(id: SettingId): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTING_ROW, { detail: id }));
}

export function onOpenSettingRow(listener: (id: SettingId) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<SettingId>).detail);
  window.addEventListener(OPEN_SETTING_ROW, handler);
  return () => window.removeEventListener(OPEN_SETTING_ROW, handler);
}

/**
 * Follow a setting link from outside the app: open Settings at its row and,
 * with `enable=1`, turn a linkable row on and say so; an unlinkable row is
 * opened unchanged with a toast saying the link can't turn it on. Returns
 * false for anything that is not a setting link (nothing opens).
 */
export async function followSettingLink(url: string): Promise<boolean> {
  const link = parseSettingLink(url);
  if (!link) return false;
  const row = settingById(link.id)!;
  openSettingRow(link.id);
  if (!link.enable) return true;
  const result = await enableSetting(link.id);
  if (result === "enabled") showSettingEnabled(row.id, row.title);
  else if (result === "not-linkable") showSettingNotLinkable(row.id, row.title);
  return true;
}
