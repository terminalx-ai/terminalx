import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { AUTH_CONFIG, buildAuthorizeUrl, exchangeAuthorizationCode, parseStoredSession, refreshSession, revokeSession, type CloudSession } from "./protocol";

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

export async function beginSignIn(): Promise<CloudSession | null> {
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
  return result.type === "success" ? finishSignIn(result.url) : null;
}

export async function finishSignIn(callbackUrl: string): Promise<CloudSession> {
  const [verifier, expectedState, nonce] = await Promise.all([
    SecureStore.getItemAsync(VERIFIER_KEY, OPTIONS),
    SecureStore.getItemAsync(STATE_KEY, OPTIONS),
    SecureStore.getItemAsync(NONCE_KEY, OPTIONS),
  ]);
  await Promise.all([VERIFIER_KEY, STATE_KEY, NONCE_KEY].map((key) => SecureStore.deleteItemAsync(key, OPTIONS).catch(() => undefined)));
  const outcome = await exchangeAuthorizationCode({ config: AUTH_CONFIG, callbackUrl, verifier, expectedState, nonce });
  if (!outcome.ok) throw new Error(outcome.reason);
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(outcome.session), OPTIONS);
  return outcome.session;
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
