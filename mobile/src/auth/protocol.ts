export const MOBILE_REDIRECT_URI = "terminalx://auth/callback";

export interface AuthConfig {
  authorizeEndpoint: string;
  sessionEndpoint: string;
  refreshEndpoint: string;
  logoutEndpoint: string;
  clientId: string;
}

export interface CloudSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: { userId: string; email: string; displayName?: string };
}

export const AUTH_CONFIG: AuthConfig = {
  authorizeEndpoint: "https://login.terminalx.ai/v1/auth/authorize",
  sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
  refreshEndpoint: "https://login.terminalx.ai/v1/auth/refresh",
  logoutEndpoint: "https://login.terminalx.ai/v1/auth/logout",
  clientId: "terminalx-mobile",
};

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
}): Promise<{ ok: true; session: CloudSession } | { ok: false; reason: string }> {
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
    if (!response.ok) return { ok: false, reason: `exchange_failed_${response.status}` };
    const session = parseSession(await response.json());
    return session ? { ok: true, session } : { ok: false, reason: "invalid_session_response" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "exchange_failed" };
  }
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

async function postJson(url: string, body: Record<string, unknown>, fetchImpl: typeof fetch, accessToken?: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body), redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
