import { CloudApiError } from "../../api";
import { refusalText } from "../../words";
import type { AgentLogin } from "./agents";

/** Board 25.04's sentences, word for word, with the organization and agent the server names. */

export const LIST_INTRO = "What each agent signs in with on this organization’s cloud workspaces. Members use these logins; they do not sign in themselves.";
export const ONE_IS_ENOUGH = "One agent is enough to launch a workspace.";
export const memberNotice = (organization: string) => `Owners and admins manage agent logins. You use them when you launch a workspace in ${organization}.`;
export const LIST_UNREADABLE = "Agent logins could not be read";

/** The authorization the console asks for, as the switch's sentence. */
export const AUTHORIZATION = "I am an organization admin and authorize these credentials to be encrypted and installed at runtime on organization machines. Members can use the connected accounts through agents and Git.";

export const formIntro = (entry: AgentLogin, organization: string) =>
  entry.provider === "github" ? `What clones private repositories into ${organization}’s cloud workspaces.` : `How ${entry.name} signs in on ${organization}’s cloud workspaces.`;
export const SECRET_HELPER = "Sent once, encrypted, and never shown again. It is checked before it is saved.";
export const IDENTITY_LABEL = "Whose account this is";
export const IDENTITY_PLACEHOLDER = "A name or email, shown to admins";
export const checkingLabel = (entry: AgentLogin) => `Checking the ${entry.secretWord}…`;
/** cloud_workspace_credential_invalid, the console's sentence. */
export const failedCheck = (entry: AgentLogin) => `The ${entry.name} credential failed verification. It may have expired. Paste a fresh ${entry.secretWord}.`;
/** cloud_workspace_credential_verification_unavailable. */
export const checkUnavailable = (entry: AgentLogin) => `Verification is temporarily unavailable. The ${entry.secretWord} was not saved. Try again in a moment.`;

export const CHATGPT = { title: "Sign in with ChatGPT", detail: "Your ChatGPT plan. Shows a one-time code to enter on OpenAI’s page." };
export const CODEX_KEY = { title: "API key", detail: "Billed per token by OpenAI." };
export const DEVICE_CODE_SETTING = "Needs “Allow device code login” switched on in ChatGPT’s security settings.";

export const GETTING_CODE = "Getting a code from OpenAI…";
export const CODE_INSTRUCTIONS = "Open OpenAI’s sign-in page, sign in with the ChatGPT account the organization pays for, and enter this code. Then come back here.";
/** The console's waiting sentence. */
export const WAITING = "Waiting for approval… Open the link, sign in, and enter the code.";
export const connectedAs = (identity: string | null | undefined) => (identity?.trim() ? `Codex connected as ${identity.trim()}.` : "Codex connected.");
export const connectedDetail = (organization: string) => `${organization}’s cloud workspaces sign Codex in with this ChatGPT plan.`;
export const CANCEL_TITLE = "Cancel this sign-in?";
export const CANCEL_TEXT = "The code stops working. Nothing is saved.";
export const CANCELED = "Sign-in canceled. Nothing was saved.";
export const EXPIRED = "The code expired. Start device login again.";
export const REFUSED = "Device login failed. Start it again.";
export const offline = (until: string) => `Offline. The code is still good until ${until}; this page carries on when the phone is back online.`;

export const SAVED_NOTE = "The login itself is never shown again. The line above is a fingerprint, to tell one login from another.";
export const signInRequired = (entry: AgentLogin, organization: string) =>
  entry.provider === "codex"
    ? `${entry.vendor} no longer accepts this login. Sign in again to keep ${entry.name} working in ${organization}’s workspaces.`
    : `${entry.vendor} no longer accepts this login. Replace it to keep ${entry.name} working in ${organization}’s workspaces.`;
export const revokeTitle = (entry: AgentLogin) => `Revoke ${entry.name}’s login?`;
/** The owner's sentence, word for word. */
export const REVOKE_TEXT = "New workspaces and new sessions stop getting it. Sessions already running keep the access they were given until it expires.";
export const removeTitle = (entry: AgentLogin) => `Remove ${entry.name}’s login?`;
export const removeText = (entry: AgentLogin) => `The stored ${entry.secretWord} is deleted. ${entry.name} shows as not connected until a new ${entry.secretWord} is saved.`;
export const IN_USE_TITLE = "Still in use";

/** Why a request failed, as one sentence: the board's own where it has one, never the code. */
export function failure(error: CloudApiError): string {
  return refusalText(error);
}

/** The list's failed read: the board's sentence when the service could not be reached. */
export function listFailure(error: CloudApiError): string {
  return error.refusal === "unreachable" ? "The service could not be reached. Nothing was changed." : refusalText(error);
}

/**
 * What the key form says after Save failed, and whether the field keeps what
 * was entered. A key that failed the check is emptied; one whose check could
 * not run, or that never reached the service, stays for another try.
 */
export function saveFailure(entry: AgentLogin, error: CloudApiError): { field: string | null; notice: string | null; keep: boolean } {
  switch (error.refusal) {
    case "login-invalid": return { field: failedCheck(entry), notice: null, keep: false };
    case "login-check-unavailable": return { field: null, notice: checkUnavailable(entry), keep: true };
    case "unreachable":
    case "rate-limited": return { field: null, notice: refusalText(error), keep: true };
    default: return { field: null, notice: refusalText(error), keep: false };
  }
}
