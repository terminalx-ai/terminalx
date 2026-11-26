import { beforeEach, expect, it, vi } from "vitest";

// PRO-584: signing in again before deleting the account must really sign in, in a sheet that shares nothing with the
// browser (the web console's sign-in page approves at once when the browser is signed in), and as the same account.
const mocks = vi.hoisted(() => ({ store: new Map<string, string>(), exchange: vi.fn(), open: vi.fn(), revoke: vi.fn(async () => undefined) }));
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
}));
const { beginSignIn, forgetStoredSession } = await import("./native");

const SESSION_KEY = "terminalx.cloud.session.v1";
const ada = { accessToken: "a2", refreshToken: "r2", expiresAt: 1, user: { userId: "user-ada", email: "ada@example.com" } };
const other = { accessToken: "b", refreshToken: "rb", expiresAt: 1, user: { userId: "user-other", email: "other@example.com" } };

beforeEach(() => {
  mocks.store = new Map([[SESSION_KEY, JSON.stringify({ ...ada, accessToken: "a1" })]]);
  mocks.exchange.mockReset();
  mocks.revoke.mockClear();
  mocks.open.mockReset().mockResolvedValue({ type: "success", url: "terminalx://auth/callback?code=c&state=s" });
});

it("asks the browser sheet for a private session when the sign-in must be fresh", async () => {
  mocks.exchange.mockResolvedValue({ ok: true, session: ada });
  await beginSignIn({ fresh: true, expectUserId: "user-ada" });
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

it("treats an address held at the private beta as another account when signing in again", async () => {
  mocks.exchange.mockResolvedValue({ ok: false, reason: "held", hold: { ticket: "t", expiresAt: 1, email: "new@example.com" } });
  expect(await beginSignIn({ fresh: true, expectUserId: "user-ada" })).toEqual({ status: "other-account" });
});

it("forgets the stored session without asking the server", async () => {
  await forgetStoredSession();
  expect(mocks.store.has(SESSION_KEY)).toBe(false);
  expect(mocks.revoke).not.toHaveBeenCalled();
});
