import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { AUTH_CONFIG, authSessionFailure, buildAuthorizeUrl, exchangeAuthorizationCode, parseStoredSession, redeemAccessCode, refreshSession, revokeSession, type AccessHold, type CloudSession, type RedeemOutcome } from "./protocol";

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const SESSION_KEY = "terminalx.cloud.session.v1";
const VERIFIER_KEY = "terminalx.cloud.pkce.verifier";
const STATE_KEY = "terminalx.cloud.pkce.state";
const NONCE_KEY = "terminalx.cloud.pkce.nonce";
const REFRESH_SKEW_MS = 60_000;
let refreshInFlight: Promise<StoredRefreshOutcome> | null = null;

export type StoredRefreshOutcome =
  | { status: "fresh" | "refreshed"; session: CloudSession }
  | { status: "rejected" }
  | { status: "unavailable"; session: CloudSession; reason: string };

/**
 * How a finished sign-in ends: signed in, or held at the private beta until an
 * access code is accepted (PRO-551). A held sign-in stores nothing: its ticket
 * is handed back to be kept in memory only.
 */
export type SignInResult =
  | { status: "signed-in"; session: CloudSession }
  | { status: "held"; hold: AccessHold };

export async function beginSignIn(): Promise<SignInResult | null> {
  // A new sign-in: a callback seen before belongs to an earlier one.
  finished = null;
  const verifier = base64Url(await Crypto.getRandomBytesAsync(32));
  const state = base64Url(await Crypto.getRandomBytesAsync(16));
  const nonce = base64Url(await Crypto.getRandomBytesAsync(16));
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
  const challenge = digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await Promise.all([
    SecureStore.setItemAsync(VERIFIER_KEY, verifier, OPTIONS),
    SecureStore.setItemAsync(STATE_KEY, state, OPTIONS),
    SecureStore.setItemAsync(NONCE_KEY, nonce, OPTIONS),
  ]);
  const result = await WebBrowser.openAuthSessionAsync(buildAuthorizeUrl(AUTH_CONFIG, challenge, state, nonce), "terminalx://auth/callback");
  if (result.type === "success") return finishSignIn(result.url);
  const failure = authSessionFailure(result as { type: string; error?: string | null });
  if (failure) throw new Error(failure);
  return null;
}

/**
 * The last callback finished, and how. On Android the callback reaches the app twice, as the sign-in's
 * own result and as a link: the second gets the first's outcome rather than finding the one-time
 * verifier already spent and reporting a failure.
 */
let finished: { url: string; outcome: Promise<SignInResult> } | null = null;

export function finishSignIn(callbackUrl: string): Promise<SignInResult> {
  if (finished?.url === callbackUrl) return finished.outcome;
  const outcome = completeSignIn(callbackUrl);
  finished = { url: callbackUrl, outcome };
  return outcome;
}

async function completeSignIn(callbackUrl: string): Promise<SignInResult> {
  const [verifier, expectedState, nonce] = await Promise.all([
    SecureStore.getItemAsync(VERIFIER_KEY, OPTIONS),
    SecureStore.getItemAsync(STATE_KEY, OPTIONS),
    SecureStore.getItemAsync(NONCE_KEY, OPTIONS),
  ]);
  await Promise.all([VERIFIER_KEY, STATE_KEY, NONCE_KEY].map((key) => SecureStore.deleteItemAsync(key, OPTIONS).catch(() => undefined)));
  const outcome = await exchangeAuthorizationCode({ config: AUTH_CONFIG, callbackUrl, verifier, expectedState, nonce });
  if (!outcome.ok) {
    if (outcome.hold) return { status: "held", hold: outcome.hold };
    throw new Error(outcome.reason);
  }
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(outcome.session), OPTIONS);
  return { status: "signed-in", session: outcome.session };
}

/** Redeems an access code for a held sign-in; an accepted code's session is stored as after any sign-in. */
export async function redeemHeldAccessCode(hold: AccessHold, code: string): Promise<RedeemOutcome> {
  const outcome = await redeemAccessCode(AUTH_CONFIG, hold, code);
  if (outcome.status === "accepted") await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(outcome.session), OPTIONS);
  return outcome;
}

export async function readSession(): Promise<CloudSession | null> {
  const value = await SecureStore.getItemAsync(SESSION_KEY, OPTIONS).catch(() => null);
  return value ? parseStoredSession(value) : null;
}

export function refreshStoredSession(session: CloudSession): Promise<StoredRefreshOutcome> {
  if (session.expiresAt > Date.now() + REFRESH_SKEW_MS) return Promise.resolve({ status: "fresh", session });
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshSession(AUTH_CONFIG, session).then(async (outcome): Promise<StoredRefreshOutcome> => {
    if (outcome.status === "refreshed") {
      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(outcome.session), OPTIONS);
      return outcome;
    }
    if (outcome.status === "rejected") {
      await SecureStore.deleteItemAsync(SESSION_KEY, OPTIONS).catch(() => undefined);
      return outcome;
    }
    return { ...outcome, session };
  }).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function signOut(session: CloudSession): Promise<void> {
  await revokeSession(AUTH_CONFIG, session);
  await SecureStore.deleteItemAsync(SESSION_KEY, OPTIONS).catch(() => undefined);
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
