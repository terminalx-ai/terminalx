import { CloudApiError, type CloudCredential, type CloudCredentialAuthKind, type CloudCredentialProvider, type CloudRefusal } from "./api";

/**
 * Agent logins on the phone (board 25.04): which agents an organization signs
 * in, and every sentence the screens say about them. The server answers with
 * codes only, so the words are here: the web console's where it has one.
 */

export interface LoginAgent {
  provider: CloudCredentialProvider;
  /** The agent's name as the console writes it. */
  name: string;
  /** The list's section: the agents, or what clones repositories. */
  group: "agents" | "repositories";
  /** How it can sign in, said on its row while nothing is connected. */
  how: string;
  /** The label over the field its key or token is pasted into. */
  keyLabel: string;
  keyKind: Extract<CloudCredentialAuthKind, "api-key" | "personal-access-token">;
  /** What is pasted, in a sentence. */
  noun: "key" | "token";
  /** Who checks the login, and who stops accepting one. */
  issuer: string;
}

/** The four logins the server keeps for an organization, in the order the list shows them. */
export const LOGIN_AGENTS: readonly LoginAgent[] = [
  { provider: "codex", name: "Codex", group: "agents", how: "ChatGPT sign-in or API key", keyLabel: "Codex API key", keyKind: "api-key", noun: "key", issuer: "OpenAI" },
  { provider: "claude", name: "Claude Code", group: "agents", how: "API key", keyLabel: "Claude Code API key", keyKind: "api-key", noun: "key", issuer: "Anthropic" },
  { provider: "cursor", name: "Cursor", group: "agents", how: "API key", keyLabel: "Cursor API key", keyKind: "api-key", noun: "key", issuer: "Cursor" },
  { provider: "github", name: "GitHub", group: "repositories", how: "A token, for private repositories", keyLabel: "GitHub personal access token", keyKind: "personal-access-token", noun: "token", issuer: "GitHub" },
];

/** The agent a route names; null for anything else. */
export function loginAgent(provider: string | null | undefined): LoginAgent | null {
  return LOGIN_AGENTS.find((agent) => agent.provider === provider) ?? null;
}

/** The login the server stores for an agent, if it stores one: a `disconnected` row is none. */
export function storedLogin(credentials: readonly CloudCredential[], provider: CloudCredentialProvider): CloudCredential | null {
  const credential = credentials.find((entry) => entry.provider === provider);
  return credential && credential.state !== "disconnected" ? credential : null;
}

/** Whether a login is the person's ChatGPT or Claude plan rather than a key. */
export const isSubscription = (credential: Pick<CloudCredential, "authKind">): boolean => credential.authKind === "oauth-credentials-json";

/** The kind of a stored login, in the console's words. */
export function loginKind(authKind: string): string {
  if (authKind === "api-key") return "API key";
  if (authKind === "oauth-credentials-json") return "Subscription login";
  if (authKind === "personal-access-token") return "Personal access token";
  return "Login";
}

/** What a stored login is called in a sentence: a key, a token, or a login. */
export function loginNoun(credential: Pick<CloudCredential, "authKind">): "key" | "token" | "login" {
  return credential.authKind === "api-key" ? "key" : credential.authKind === "personal-access-token" ? "token" : "login";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A day as the boards write it: "2 Nov", and with its year "23 Nov 2026". */
export function dayText(at: number, year = false): string {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year ? ` ${date.getFullYear()}` : ""}`;
}

/** The line under an agent's name in the list: how it can sign in, or what is stored and whose it is. */
export function loginDetail(agent: LoginAgent, credential: CloudCredential | null): string {
  if (!credential) return agent.how;
  return `${loginKind(credential.authKind)} · ${credential.displayIdentity || `Updated ${dayText(credential.updatedAt)}`}`;
}

/** The console's authorization, word for word: the server takes no login without it. */
export const LOGIN_CONSENT = "I am an organization admin and authorize these credentials to be encrypted and installed at runtime on organization machines. Members can use the connected accounts through agents and Git.";

export const LOGINS_INTRO = "What each agent signs in with on this organization’s cloud workspaces. Members use these logins; they do not sign in themselves.";
export const LOGINS_ONE_IS_ENOUGH = "One agent is enough to launch a workspace.";
export const memberNote = (organization: string): string => `Owners and admins manage agent logins. You use them when you launch a workspace in ${organization}.`;
export const LOGINS_UNREAD = { title: "Agent logins could not be read", detail: "The service could not be reached. Nothing was changed." };

/** The line over a form: what the login is for. */
export function loginPurpose(agent: LoginAgent, organization: string): string {
  return agent.group === "repositories" ? `What clones private repositories into ${organization}’s cloud workspaces.` : `How ${agent.name} signs in on ${organization}’s cloud workspaces.`;
}

export const KEY_HELP = "Sent once, encrypted, and never shown again. It is checked before it is saved.";
export const FINGERPRINT_HELP = "The login itself is never shown again. The line above is a fingerprint, to tell one login from another.";
export const checkingText = (agent: LoginAgent): string => `Checking the ${agent.noun}…`;

/** Under a login its issuer stopped accepting: what to do so the agent keeps working. */
export function signInRequiredNote(agent: LoginAgent, credential: Pick<CloudCredential, "authKind">, organization: string): string {
  return `${agent.issuer} no longer accepts this login. ${isSubscription(credential) ? "Sign in again" : "Replace it"} to keep ${agent.name} working in ${organization}’s workspaces.`;
}

export const CODEX_WORDS = {
  chatgpt: { label: "Sign in with ChatGPT", detail: "Your ChatGPT plan. Shows a one-time code to enter on OpenAI’s page." },
  key: { label: "API key", detail: "Billed per token by OpenAI." },
  hint: "Needs “Allow device code login” switched on in ChatGPT’s security settings.",
  starting: "Getting a code from OpenAI…",
  shown: "Open OpenAI’s sign-in page, sign in with the ChatGPT account the organization pays for, and enter this code. Then come back here.",
  waiting: "Waiting for approval… Open the link, sign in, and enter the code.",
  expired: "The code expired. Start device login again.",
  failed: "Device login failed. Start it again.",
  canceled: "Sign-in canceled. Nothing was saved.",
  unavailable: "OpenAI’s device sign-in is not answering right now. Try again in a moment, or use an API key.",
  notCanceled: "The service could not be reached. The sign-in was not canceled.",
  pageNotOpened: "The sign-in page could not be opened. Copy the code and open the page in a browser.",
} as const;

/** While the phone is offline: the code is still good until this time of day. */
export function offlineText(expiresAt: number): string {
  const date = new Date(expiresAt);
  return `Offline. The code is still good until ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}; this page carries on when the phone is back online.`;
}

export function connectedText(credential: Pick<CloudCredential, "displayIdentity">, organization: string): { title: string; detail: string } {
  return { title: credential.displayIdentity ? `Codex connected as ${credential.displayIdentity}.` : "Codex connected.", detail: `${organization}’s cloud workspaces sign Codex in with this ChatGPT plan.` };
}

/** What kind of refusal an error is; anything that is not the service's own answer is `unknown`. */
export function refusalOf(error: unknown): CloudRefusal {
  return error instanceof CloudApiError ? error.refusal : "unknown";
}

/** Whether the service, not the request, was the trouble: no answer, or one that says to try again. */
export const transient = (error: unknown): boolean => error instanceof CloudApiError && error.unreachable;

const ADMIN_ONLY = "Only an organization owner or administrator can manage agent logins.";

/**
 * Why a device sign-in could not start. The service's own "unavailable" is
 * OpenAI not answering; anything else is said for what it is.
 */
export function deviceStartText(refusal: CloudRefusal): string {
  if (refusal === "device-login-unavailable") return CODEX_WORDS.unavailable;
  if (refusal === "admin-required") return ADMIN_ONLY;
  if (refusal === "signed-out") return "Sign in again to manage agent logins.";
  if (refusal === "rate-limited") return "Too many sign-ins were started in a short time. Wait a while, then try again.";
  return "The service could not be reached. No code was made. Try again in a moment, or use an API key.";
}

/** Why a device sign-in ended without a login. */
export function deviceFailedText(refusal: CloudRefusal | null): string {
  if (refusal === "admin-required") return ADMIN_ONLY;
  if (refusal === "signed-out") return "Sign in again to manage agent logins.";
  return CODEX_WORDS.failed;
}

/**
 * Why a key or token was not saved. `field` is said under the field, which
 * was emptied for a fresh one; anything else is said under the form.
 */
export function saveRefusal(error: unknown, agent: LoginAgent): { where: "field" | "form"; text: string } {
  const refusal = refusalOf(error);
  if (refusal === "login-invalid") return { where: "field", text: `The ${agent.name} credential failed verification. It may have expired. Paste a fresh ${agent.noun}.` };
  if (refusal === "invalid-request") return { where: "field", text: "That is not a login this agent can use. Nothing was changed." };
  if (refusal === "login-check-unavailable") return { where: "form", text: `Verification is temporarily unavailable. The ${agent.noun} was not saved. Try again in a moment.` };
  if (refusal === "admin-required") return { where: "form", text: ADMIN_ONLY };
  if (refusal === "signed-out") return { where: "form", text: "Sign in again to manage agent logins." };
  if (refusal === "rate-limited") return { where: "form", text: "Too many requests just now. Try again in a moment." };
  // No answer, or one that says nothing of the login: it may or may not have been stored.
  if (transient(error)) return { where: "form", text: `The service could not be reached. The ${agent.noun} may not have been saved: check ${agent.name} in Agent logins before trying again.` };
  return { where: "form", text: "That did not work. Try again in a moment." };
}

/** Why a stored login was not revoked or removed. */
export function changeRefusal(error: unknown): string {
  const refusal = refusalOf(error);
  if (refusal === "admin-required") return ADMIN_ONLY;
  if (refusal === "signed-out") return "Sign in again to manage agent logins.";
  if (refusal === "login-missing") return "This login is no longer stored. Nothing was changed.";
  if (refusal === "rate-limited") return "Too many requests just now. Try again in a moment.";
  if (transient(error)) return "The service could not be reached. Nothing was changed.";
  return "That did not work. Try again in a moment.";
}

/**
 * The confirmations before a stored login is revoked or removed. The Revoke
 * sentence is the desktop's own, until the owner words one for the phone (PRO-523).
 */
export function revokeQuestion(agent: LoginAgent): { title: string; body: string } {
  return { title: `Revoke ${agent.name}’s login?`, body: "Workspaces no longer receive it. Replace it to use this agent again." };
}

export function removeQuestion(agent: LoginAgent, credential: Pick<CloudCredential, "authKind">): { title: string; body: string } {
  const noun = loginNoun(credential);
  return { title: `Remove ${agent.name}’s login?`, body: `The stored ${noun} is deleted. ${agent.name} shows as not connected until a new ${noun === "login" ? "one" : noun} is saved.` };
}

/** `cloud_workspace_credential_in_use`: a workspace that still exists was set up with this very login. */
export const STILL_IN_USE = { title: "Still in use", body: "A workspace was set up with this login. Delete that workspace first, or replace the login instead." };
