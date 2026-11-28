import { beforeEach, expect, it, vi } from "vitest";

// PRO-584: signing in again before deleting the account must really sign in, in a sheet that shares nothing with the
// browser (the web console's sign-in page approves at once when the browser is signed in), and as the same account.
const mocks = vi.hoisted(() => ({ store: new Map<string, string>(), exchange: vi.fn(), open: vi.fn(), revoke: vi.fn(async () => undefined), refresh: vi.fn() }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { BASE64: "base64" },
  getRandomBytesAsync: async (n: number) => new Uint8Array(n).fill(7),
  digestStringAsync: async () => "ZGlnZXN0",
}));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: mocks.open }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => mocks.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.store.set(key, value); },
  deleteItemAsync: async (key: string) => { mocks.store.delete(key); },
}));
vi.mock("./protocol", () => ({
  AUTH_CONFIG: {},
  buildAuthorizeUrl: (_config: unknown, _challenge: string, _state: string, _nonce: string, options?: { fresh?: boolean }) => `https://login.terminalx.ai/v1/auth/authorize?x${options?.fresh ? "&prompt=login&max_age=0" : ""}`,
  authSessionFailure: () => null,
  exchangeAuthorizationCode: mocks.exchange,
  revokeSession: mocks.revoke,
  refreshSession: mocks.refresh,
  parseStoredSession: (value: string) => JSON.parse(value),
}));
const { beginSignIn, forgetStoredSession, refreshStoredSession, resetSessionCacheForTests } = await import("./native");

const SESSION_KEY = "terminalx.cloud.session.v1";
const MOCK_STATE = "BwcHBwcHBwcHBwcHBwcHBw";
const ada = { accessToken: "a2", refreshToken: "r2", expiresAt: 1, user: { userId: "user-ada", email: "ada@example.com" } };
const other = { accessToken: "b", refreshToken: "rb", expiresAt: 1, user: { userId: "user-other", email: "other@example.com" } };

beforeEach(() => {
  resetSessionCacheForTests();
  mocks.store = new Map([[SESSION_KEY, JSON.stringify({ ...ada, accessToken: "a1" })]]);
  mocks.exchange.mockReset();
  mocks.revoke.mockClear();
  mocks.refresh.mockReset();
  mocks.open.mockReset().mockResolvedValue({ type: "success", url: `terminalx://auth/callback?code=c&state=${MOCK_STATE}` });
});

it("asks the browser sheet for a private session when the sign-in must be fresh", async () => {
  mocks.exchange.mockResolvedValue({ ok: true, session: ada });
  expect(await beginSignIn({ fresh: true, expectUserId: "user-ada" })).toEqual({ status: "signed-in", session: ada, replaced: { ...ada, accessToken: "a1" } });
  // The server is asked for a sign-in too (Android has no private sheet), and iOS's sheet keeps no cookie.
  expect(mocks.open).toHaveBeenCalledWith(expect.stringContaining("&prompt=login&max_age=0"), "terminalx://auth/callback", { preferEphemeralSession: true });
  expect(JSON.parse(mocks.store.get(SESSION_KEY)!)).toEqual(ada);
});

it("opens the ordinary sheet for an ordinary sign-in", async () => {
  mocks.exchange.mockResolvedValue({ ok: true, session: ada });
  expect(await beginSignIn()).toEqual({ status: "signed-in", session: ada });
  expect(mocks.open).toHaveBeenCalledWith(expect.not.stringContaining("prompt="), "terminalx://auth/callback", undefined);
});

it("keeps nothing of a sign-in again as another account, and ends that session", async () => {
  mocks.exchange.mockResolvedValue({ ok: true, session: other });
  expect(await beginSignIn({ fresh: true, expectUserId: "user-ada" })).toEqual({ status: "other-account" });
  expect(mocks.revoke).toHaveBeenCalledWith({}, other);
  // The account being deleted is still the one signed in.
  expect(JSON.parse(mocks.store.get(SESSION_KEY)!).accessToken).toBe("a1");
});

it("says an address held at the private beta has no account when signing in again, and keeps nothing", async () => {
  mocks.exchange.mockResolvedValue({ ok: false, reason: "held", hold: { ticket: "t", expiresAt: 1, email: "new@example.com" } });
  expect(await beginSignIn({ fresh: true, expectUserId: "user-ada" })).toEqual({ status: "no-account" });
  expect(JSON.parse(mocks.store.get(SESSION_KEY)!).accessToken).toBe("a1");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const old = { ...ada, accessToken: "a1", refreshToken: "r1" };

it("signing in again waits for a refresh of the old session, and hands back the old one as refreshed to be ended", async () => {
  const refreshed = { ...old, accessToken: "a1b", refreshToken: "r1b", expiresAt: 2 };
  const refresh = deferred<{ status: "refreshed"; session: typeof refreshed }>();
  mocks.refresh.mockReturnValue(refresh.promise);
  mocks.exchange.mockResolvedValue({ ok: true, session: ada });
  mocks.store.set(SESSION_KEY, JSON.stringify(old));
  const refreshing = refreshStoredSession();
  const signingIn = beginSignIn({ fresh: true, expectUserId: "user-ada" });
  await tick();
  refresh.resolve({ status: "refreshed", session: refreshed });
  await refreshing;
  // Ended with its current refresh token: the copy from before the refresh would be refused without a word.
  expect(await signingIn).toEqual({ status: "signed-in", session: ada, replaced: refreshed });
  expect(JSON.parse(mocks.store.get(SESSION_KEY)!)).toEqual(ada);
});

it("a refresh of the old session that is refused after a sign-in stored a new one leaves the new one", async () => {
  const refresh = deferred<{ status: "rejected" }>();
  mocks.refresh.mockReturnValue(refresh.promise);
  mocks.exchange.mockResolvedValue({ ok: true, session: ada });
  mocks.store.set(SESSION_KEY, JSON.stringify(old));
  const refreshing = refreshStoredSession();
  await beginSignIn();
  refresh.resolve({ status: "rejected" });
  expect(await refreshing).toEqual({ status: "fresh", session: ada });
  expect(JSON.parse(mocks.store.get(SESSION_KEY)!)).toEqual(ada);
});

it("a refresh that ends after the session was forgotten does not write it back", async () => {
  const refresh = deferred<{ status: "refreshed"; session: typeof old }>();
  mocks.refresh.mockReturnValue(refresh.promise);
  mocks.store.set(SESSION_KEY, JSON.stringify(old));
  const refreshing = refreshStoredSession();
  await forgetStoredSession();
  refresh.resolve({ status: "refreshed", session: { ...old, accessToken: "a1c" } });
  expect(await refreshing).toEqual({ status: "rejected" });
  expect(mocks.store.has(SESSION_KEY)).toBe(false);
});

// PRO-600: the server ends the whole sign-in when a refresh token it has replaced comes back after its minute's grace.
// A copy of the session kept elsewhere is never what is refreshed: only the stored one is.
it("refreshes the stored session, which a refresh elsewhere may have replaced, and sends nothing for a fresh one", async () => {
  const later = { ...old, accessToken: "a1b", refreshToken: "r1b", expiresAt: 2 };
  mocks.store.set(SESSION_KEY, JSON.stringify(old));
  mocks.refresh.mockResolvedValueOnce({ status: "refreshed", session: later });
  expect(await refreshStoredSession()).toEqual({ status: "refreshed", session: later });
  // Due again: refreshed with the refresh token stored now, never the replaced one.
  mocks.refresh.mockResolvedValueOnce({ status: "refreshed", session: { ...later, refreshToken: "r1c" } });
  await refreshStoredSession();
  expect(mocks.refresh.mock.calls.map(([, session]) => session.refreshToken)).toEqual(["r1", "r1b"]);
  const fresh = { ...later, refreshToken: "r1d", expiresAt: Date.now() + 10 * 60_000 };
  mocks.store.set(SESSION_KEY, JSON.stringify(fresh));
  expect(await refreshStoredSession()).toEqual({ status: "fresh", session: fresh });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

it("sends nothing when no session is stored, and says so", async () => {
  mocks.store.delete(SESSION_KEY);
  expect(await refreshStoredSession()).toEqual({ status: "rejected" });
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("shares one refresh between callers that ask at once", async () => {
  const refresh = deferred<{ status: "refreshed"; session: typeof old }>();
  mocks.refresh.mockReturnValue(refresh.promise);
  mocks.store.set(SESSION_KEY, JSON.stringify(old));
  const first = refreshStoredSession();
  const second = refreshStoredSession();
  await tick();
  refresh.resolve({ status: "refreshed", session: { ...old, refreshToken: "r1b" } });
  expect(await first).toEqual(await second);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

it("forgets the stored session without asking the server", async () => {
  await forgetStoredSession();
  expect(mocks.store.has(SESSION_KEY)).toBe(false);
  expect(mocks.revoke).not.toHaveBeenCalled();
});
