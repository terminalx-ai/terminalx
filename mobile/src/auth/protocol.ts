export const MOBILE_REDIRECT_URI = "terminalx://auth/callback";

export interface AuthConfig {
  authorizeEndpoint: string;
  sessionEndpoint: string;
  refreshEndpoint: string;
  logoutEndpoint: string;
  /** Where a held sign-in redeems its private-beta access code (PRO-550). */
  accessCodeEndpoint: string;
  clientId: string;
}

export interface CloudSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: { userId: string; email: string; displayName?: string };
}

/**
 * A sign-in the server holds at the private beta (PRO-550): no account yet,
 * and no access for the address. `ticket` is a bearer secret for 30 minutes
 * that only the redeem route takes: it is kept in memory only, never logged
 * and never written to disk. `expiresAt` is milliseconds since the epoch on
 * the server's clock; `email` is the address the code would give access to.
 */
export interface AccessHold {
  ticket: string;
  expiresAt: number;
  email: string;
}

export type ExchangeOutcome =
  | { ok: true; session: CloudSession }
  | { ok: false; reason: string; hold?: undefined }
  | { ok: false; reason: "access_code_required"; hold: AccessHold };

/**
 * The server's answer to an access code, in the phone's terms. `unanswered`
 * is every answer that says nothing about the code: no network, no answer in
 * time, a server error, or a request the server could not read.
 */
export type RedeemOutcome =
  | { status: "accepted"; session: CloudSession }
  | { status: "invalid" | "expired" | "exhausted" }
  /** Wait this many seconds before the next try. */
  | { status: "rate_limited"; retryAfter: number }
  /** The ticket is unknown, expired or already used: sign-in starts again. */
  | { status: "ticket_dead" }
  | { status: "unanswered"; reason: string };

/** The server's own wait when it names none: its per-account window (PRO-550). */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export const AUTH_CONFIG: AuthConfig = {
  authorizeEndpoint: "https://login.terminalx.ai/v1/auth/authorize",
  sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
  refreshEndpoint: "https://login.terminalx.ai/v1/auth/refresh",
  logoutEndpoint: "https://login.terminalx.ai/v1/auth/logout",
  accessCodeEndpoint: "https://login.terminalx.ai/v1/auth/access-code/redeem",
  clientId: "terminalx-mobile",
};

/**
 * Why the sign-in sheet failed, or null when it did not. iOS reports a sheet
 * it could not present, and one the person closed, as the same "cancel"; only
 * the error tells them apart. A person closing it (AuthenticationServices
 * error 1, canceledLogin) is not a failure and is not reported.
 */
export function authSessionFailure(result: { type: string; error?: string | null }): string | null {
  if (result.type === "success" || !result.error) return null;
  if (/WebAuthenticationSession error 1\.\)?$/.test(result.error)) return null;
  return `The sign-in page could not open: ${result.error}`;
}

export function buildAuthorizeUrl(config: AuthConfig, challenge: string, state: string, nonce: string): string {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", MOBILE_REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("scope", "openid profile email offline_access");
  return url.toString();
}

export function isAuthCallbackUrl(value: string): boolean {
  const path = value.split("?")[0]?.replace(/\/+$/, "") ?? "";
  return path === MOBILE_REDIRECT_URI;
}

export function parseCallbackUrl(value: string): { code: string | null; state: string | null; error: string | null } {
  const query = value.includes("?") ? value.slice(value.indexOf("?") + 1) : "";
  const params = new URLSearchParams(query);
  return { code: params.get("code"), state: params.get("state"), error: params.get("error") };
}

export async function exchangeAuthorizationCode(args: {
  config: AuthConfig;
  callbackUrl: string;
  verifier: string | null;
  expectedState: string | null;
  nonce: string | null;
  fetchImpl?: typeof fetch;
}): Promise<ExchangeOutcome> {
  if (!isAuthCallbackUrl(args.callbackUrl)) return { ok: false, reason: "invalid_callback_uri" };
  const callback = parseCallbackUrl(args.callbackUrl);
  if (callback.error) return { ok: false, reason: callback.error };
  if (!callback.code || !args.verifier || !args.nonce) return { ok: false, reason: "missing_authorization_code" };
  if (!callback.state || !args.expectedState || callback.state !== args.expectedState) return { ok: false, reason: "state_mismatch" };
  try {
    const response = await postJson(args.config.sessionEndpoint, {
      code: callback.code,
      codeVerifier: args.verifier,
      redirectUri: MOBILE_REDIRECT_URI,
      clientId: args.config.clientId,
      nonce: args.nonce,
    }, args.fetchImpl ?? fetch);
    if (response.status === 403) {
      const hold = parseAccessHold(await response.json().catch(() => null));
      if (hold) return { ok: false, reason: "access_code_required", hold };
    }
    if (!response.ok) return { ok: false, reason: `exchange_failed_${response.status}` };
    const session = parseSession(await response.json());
    return session ? { ok: true, session } : { ok: false, reason: "invalid_session_response" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "exchange_failed" };
  }
}

/**
 * Sends an access code with the held sign-in's ticket. The server matches
 * the code without regard to capitals or the space around it; the phone sends
 * it trimmed and otherwise as entered.
 */
export async function redeemAccessCode(config: AuthConfig, hold: Pick<AccessHold, "ticket">, code: string, fetchImpl: typeof fetch = fetch): Promise<RedeemOutcome> {
  let response: Response;
  try {
    response = await postJson(config.accessCodeEndpoint, { accessTicket: hold.ticket, code: code.trim(), clientId: config.clientId }, fetchImpl);
  } catch (error) {
    return { status: "unanswered", reason: error instanceof Error && error.name === "AbortError" ? "redeem_timed_out" : "redeem_unreachable" };
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const error = body && typeof body === "object" ? body.error : undefined;
  if (response.ok) {
    const session = body && body.status === "accepted" ? parseSession(body) : null;
    return session ? { status: "accepted", session } : { status: "unanswered", reason: "invalid_redeem_response" };
  }
  if (response.status === 404 && error === "invalid") return { status: "invalid" };
  if (response.status === 410 && error === "expired") return { status: "expired" };
  if (response.status === 409 && error === "exhausted") return { status: "exhausted" };
  if (response.status === 401 && error === "invalid_grant") return { status: "ticket_dead" };
  if (response.status === 429) return { status: "rate_limited", retryAfter: retryAfterSeconds(body?.retryAfter, response.headers.get("retry-after")) };
  return { status: "unanswered", reason: `redeem_failed_${response.status}` };
}

/** Whole seconds to wait: the body's `retryAfter`, else the `Retry-After` header, else the server's window. */
function retryAfterSeconds(fromBody: unknown, fromHeader: string | null): number {
  const header = fromHeader !== null && /^\s*\d+\s*$/.test(fromHeader) ? Number(fromHeader) : NaN;
  const seconds = typeof fromBody === "number" && Number.isFinite(fromBody) ? fromBody : header;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : DEFAULT_RETRY_AFTER_SECONDS;
}

export type RefreshOutcome =
  | { status: "refreshed"; session: CloudSession }
  | { status: "rejected" }
  | { status: "unavailable"; reason: string };

export async function refreshSession(config: AuthConfig, session: CloudSession, fetchImpl: typeof fetch = fetch): Promise<RefreshOutcome> {
  try {
    const response = await postJson(config.refreshEndpoint, { refreshToken: session.refreshToken, clientId: config.clientId }, fetchImpl);
    if ([400, 401, 403].includes(response.status)) return { status: "rejected" };
    if (!response.ok) return { status: "unavailable", reason: `refresh_failed_${response.status}` };
    const refreshed = parseSession(await response.json());
    return refreshed ? { status: "refreshed", session: refreshed } : { status: "unavailable", reason: "invalid_refresh_response" };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "refresh_failed" };
  }
}

export async function revokeSession(config: AuthConfig, session: CloudSession, fetchImpl: typeof fetch = fetch): Promise<void> {
  await postJson(config.logoutEndpoint, { refreshToken: session.refreshToken, clientId: config.clientId }, fetchImpl, session.accessToken).catch(() => undefined);
}

export function parseStoredSession(value: string): CloudSession | null {
  try {
    return parseSession(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseSession(value: unknown): CloudSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const user = record.user as Record<string, unknown> | undefined;
  if (!user || typeof record.accessToken !== "string" || !record.accessToken || typeof record.refreshToken !== "string" || !record.refreshToken || typeof record.expiresAt !== "number" || !Number.isInteger(record.expiresAt) || record.expiresAt <= 0 || typeof user.userId !== "string" || !user.userId || typeof user.email !== "string" || !user.email || (user.displayName !== undefined && typeof user.displayName !== "string")) return null;
  return { accessToken: record.accessToken, refreshToken: record.refreshToken, expiresAt: record.expiresAt, user: { userId: user.userId, email: user.email, ...(typeof user.displayName === "string" && user.displayName ? { displayName: user.displayName } : {}) } };
}

function parseAccessHold(value: unknown): AccessHold | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.error !== "access_code_required" || typeof record.accessTicket !== "string" || !record.accessTicket || typeof record.accessTicketExpiresAt !== "number" || !Number.isInteger(record.accessTicketExpiresAt) || record.accessTicketExpiresAt <= 0 || typeof record.email !== "string" || !record.email) return null;
  return { ticket: record.accessTicket, expiresAt: record.accessTicketExpiresAt, email: record.email };
}

async function postJson(url: string, body: Record<string, unknown>, fetchImpl: typeof fetch, accessToken?: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body), redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
