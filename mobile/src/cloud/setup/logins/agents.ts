import type { CloudCredential, CloudCredentialAuthKind, CloudCredentialProvider } from "../../api";
import { credentialBadge, type BadgeState } from "../../../ui/StateBadge";

/**
 * The four logins an organization keeps for its cloud workspaces (25.04), as
 * the phone offers them. The owner's decisions on the phone: Claude Code by
 * API key only; Codex by ChatGPT device sign-in or API key; Cursor by API
 * key; GitHub by personal access token. No pasted auth files.
 */
export interface AgentLogin {
  provider: CloudCredentialProvider;
  name: string;
  /** Who checks the key or answers the sign-in, for "OpenAI no longer accepts this login." */
  vendor: string;
  /** Where it sits on the list. */
  section: "agents" | "repositories";
  /** Under the name on the list while nothing is saved: how it can sign in. */
  how: string;
  /** What the form sends: one secret of this kind. */
  authKind: Extract<CloudCredentialAuthKind, "api-key" | "personal-access-token">;
  /** "key" or "token", for the field's sentences. */
  secretWord: "key" | "token";
  /** The field's label and placeholder. */
  fieldLabel: string;
}

export const AGENT_LOGINS: readonly AgentLogin[] = [
  { provider: "codex", name: "Codex", vendor: "OpenAI", section: "agents", how: "ChatGPT sign-in or API key", authKind: "api-key", secretWord: "key", fieldLabel: "Codex API key" },
  { provider: "claude", name: "Claude Code", vendor: "Anthropic", section: "agents", how: "API key", authKind: "api-key", secretWord: "key", fieldLabel: "Claude Code API key" },
  { provider: "cursor", name: "Cursor", vendor: "Cursor", section: "agents", how: "API key", authKind: "api-key", secretWord: "key", fieldLabel: "Cursor API key" },
  { provider: "github", name: "GitHub", vendor: "GitHub", section: "repositories", how: "A token, for private repositories", authKind: "personal-access-token", secretWord: "token", fieldLabel: "GitHub personal access token" },
];

/** The login a route names; null for anything else, which the page says is not there. */
export function agentLogin(provider: string | null | undefined): AgentLogin | null {
  return AGENT_LOGINS.find((entry) => entry.provider === provider) ?? null;
}

/** The kind of a stored login, in words; a kind this app does not know reads as "Login". */
export function kindLabel(authKind: string): string {
  if (authKind === "api-key") return "API key";
  if (authKind === "personal-access-token") return "Personal access token";
  // A Codex device sign-in is stored as the ChatGPT plan's login.
  if (authKind === "oauth-credentials-json") return "Subscription login";
  return "Login";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2 Nov" on the list; "23 Nov 2026" on the login's own page. */
export function dayText(at: number, withYear = false): string {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${withYear ? ` ${date.getFullYear()}` : ""}`;
}

/** "10:40": when a code stops working, on the phone's clock, in its own 24-hour form as the boards write it. */
export function clockAt(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** A login that is saved and listed as something other than not connected. */
export function savedLogin(credential: CloudCredential | null | undefined): credential is CloudCredential {
  return !!credential && credential.state !== "disconnected";
}

/** One row of the list: the state pill, and the line under the name. */
export function listRow(entry: AgentLogin, credential: CloudCredential | null | undefined): { badge: BadgeState | null; detail: string } {
  if (!savedLogin(credential)) return { badge: "not-connected", detail: entry.how };
  // The kind, then whose account it is, or when it last changed when the server keeps no name for it.
  const who = credential.displayIdentity?.trim() ? credential.displayIdentity.trim() : `Updated ${dayText(credential.stateChangedAt ?? credential.updatedAt)}`;
  return { badge: credentialBadge(credential.state), detail: `${kindLabel(credential.authKind)} · ${who}` };
}

/** Owners and admins manage agent logins; a role the app does not know is left to the server to decide. */
export function managesLogins(role: string | null | undefined): boolean | null {
  if (role === "owner" || role === "admin") return true;
  if (role === "member") return false;
  return null;
}
