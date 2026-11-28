import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  open: vi.fn(),
  exchange: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(async () => undefined),
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { BASE64: "base64" },
  getRandomBytesAsync: async (n: number) => new Uint8Array(n).fill(9),
  digestStringAsync: async () => "ZGlnZXN0",
}));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: mocks.open }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 5,
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
  deleteItemAsync: mocks.deleteItemAsync,
}));
vi.mock("./protocol", () => ({
  AUTH_CONFIG: {},
  buildAuthorizeUrl: (_c: unknown, _ch: string, state: string) => `https://login.terminalx.ai/v1/auth/authorize?state=${state}`,
  authSessionFailure: (r: { type: string; error?: string | null }) => (r.error ? `failed: ${r.error}` : null),
  exchangeAuthorizationCode: mocks.exchange,
  refreshSession: mocks.refresh,
  revokeSession: mocks.revoke,
  parseStoredSession: (raw: string) => JSON.parse(raw),
}));

const {
  beginSignIn,
  finishSignIn,
  forgetStoredSession,
  readSession,
  refreshStoredSession,
  resetSessionCacheForTests,
  signOut,
} = await import("./native");

const SESSION_KEY = "terminalx.cloud.session.v1";
const VERIFIER_KEY = "terminalx.cloud.pkce.verifier";
const STATE_KEY = "terminalx.cloud.pkce.state";
const NONCE_KEY = "terminalx.cloud.pkce.nonce";
const GENERATED_STATE = "CQkJCQkJCQkJCQkJCQkJCQ";

beforeEach(() => {
  resetSessionCacheForTests();
  mocks.store.clear();
  mocks.getItemAsync.mockReset().mockImplementation(async (key: string) => mocks.store.get(key) ?? null);
  mocks.setItemAsync.mockReset().mockImplementation(async (key: string, value: string) => { mocks.store.set(key, value); });
  mocks.deleteItemAsync.mockReset().mockImplementation(async (key: string) => { mocks.store.delete(key); });
  mocks.open.mockReset();
  mocks.exchange.mockReset();
  mocks.refresh.mockReset();
  mocks.revoke.mockClear();
});

describe("P-76: in-memory CloudSession cache in auth/native.ts", () => {
  it("caches a fresh CloudSession in memory and skips SecureStore reads until invalidated or near expiry", async () => {
    const fresh = {
      accessToken: "tok-fresh",
      refreshToken: "ref-fresh",
      expiresAt: Date.now() + 10 * 60_000,
      user: { userId: "u-1", email: "ada@example.com" },
    };
    mocks.store.set(SESSION_KEY, JSON.stringify(fresh));

    // First call hits SecureStore once.
    expect(await refreshStoredSession()).toEqual({ status: "fresh", session: fresh });
    expect(mocks.getItemAsync).toHaveBeenCalledTimes(1);

    // Subsequent Cloud API token lookups hit the in-memory cache with ZERO SecureStore reads.
    expect(await refreshStoredSession()).toEqual({ status: "fresh", session: fresh });
    expect(await readSession()).toEqual(fresh);
    expect(await refreshStoredSession()).toEqual({ status: "fresh", session: fresh });
    expect(mocks.getItemAsync).toHaveBeenCalledTimes(1);

    // Sign-out / forget invalidates the cache.
    await forgetStoredSession();
    expect(await readSession()).toBeNull();
    expect(mocks.getItemAsync).toHaveBeenCalledTimes(2);
  });

  it("invalidates cache on signOut and updates cache on refresh", async () => {
    const expiring = {
      accessToken: "tok-old",
      refreshToken: "ref-old",
      expiresAt: Date.now() + 10_000, // within REFRESH_SKEW_MS
      user: { userId: "u-1", email: "ada@example.com" },
    };
    const refreshed = {
      accessToken: "tok-new",
      refreshToken: "ref-new",
      expiresAt: Date.now() + 15 * 60_000,
      user: { userId: "u-1", email: "ada@example.com" },
    };
    mocks.store.set(SESSION_KEY, JSON.stringify(expiring));
    mocks.refresh.mockResolvedValueOnce({ status: "refreshed", session: refreshed });

    expect(await refreshStoredSession()).toEqual({ status: "refreshed", session: refreshed });
    mocks.getItemAsync.mockClear();

    // Cached immediately after refresh without re-reading SecureStore.
    expect(await refreshStoredSession()).toEqual({ status: "fresh", session: refreshed });
    expect(mocks.getItemAsync).not.toHaveBeenCalled();

    // Sign-out invalidates the cache.
    await signOut(refreshed);
    expect(await refreshStoredSession()).toEqual({ status: "rejected" });
    expect(mocks.getItemAsync).toHaveBeenCalledTimes(1);
  });
});

describe("S-47: PKCE state validation before deletion and cleanup on cancel/error", () => {
  it("does NOT wipe PKCE keys when an unsolicited callback arrives with a mismatched state, letting the real callback succeed", async () => {
    mocks.store.set(VERIFIER_KEY, "real-verifier");
    mocks.store.set(STATE_KEY, "real-state-token");
    mocks.store.set(NONCE_KEY, "real-nonce");
    const session = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 300_000,
      user: { userId: "u-1", email: "ada@example.com" },
    };
    mocks.exchange.mockResolvedValueOnce({ ok: true, session });

    // Attacker sends unsolicited deep link with bogus state.
    await expect(finishSignIn("terminalx://auth/callback?code=evil&state=wrong-state")).rejects.toThrow("state_mismatch");
    // PKCE state must remain intact in SecureStore!
    expect(mocks.store.get(VERIFIER_KEY)).toBe("real-verifier");
    expect(mocks.store.get(STATE_KEY)).toBe("real-state-token");
    expect(mocks.store.get(NONCE_KEY)).toBe("real-nonce");
    expect(mocks.exchange).not.toHaveBeenCalled();

    // Unsolicited invalid callback URI also leaves PKCE state intact.
    await expect(finishSignIn("https://evil.example/callback?code=evil&state=real-state-token")).rejects.toThrow("invalid_callback_uri");
    expect(mocks.store.get(VERIFIER_KEY)).toBe("real-verifier");

    // Legitimate callback with matching state succeeds and consumes PKCE keys.
    expect(await finishSignIn("terminalx://auth/callback?code=real-code&state=real-state-token")).toEqual({ status: "signed-in", session });
    expect(mocks.store.has(VERIFIER_KEY)).toBe(false);
    expect(mocks.store.has(STATE_KEY)).toBe(false);
    expect(mocks.store.has(NONCE_KEY)).toBe(false);
  });

  it("purges PKCE keys from SecureStore when beginSignIn is canceled or throws", async () => {
    mocks.open.mockResolvedValueOnce({ type: "cancel" });
    expect(await beginSignIn()).toBeNull();
    expect(mocks.store.has(VERIFIER_KEY)).toBe(false);
    expect(mocks.store.has(STATE_KEY)).toBe(false);
    expect(mocks.store.has(NONCE_KEY)).toBe(false);

    mocks.open.mockRejectedValueOnce(new Error("browser crashed"));
    await expect(beginSignIn()).rejects.toThrow("browser crashed");
    expect(mocks.store.has(VERIFIER_KEY)).toBe(false);
    expect(mocks.store.has(STATE_KEY)).toBe(false);
    expect(mocks.store.has(NONCE_KEY)).toBe(false);

    // Sanity check: successful flow still works with matching state.
    const session = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 300_000, user: { userId: "u-1", email: "a@b.c" } };
    mocks.open.mockResolvedValueOnce({ type: "success", url: `terminalx://auth/callback?code=ok&state=${GENERATED_STATE}` });
    mocks.exchange.mockResolvedValueOnce({ ok: true, session });
    expect(await beginSignIn()).toEqual({ status: "signed-in", session });
  });
});
