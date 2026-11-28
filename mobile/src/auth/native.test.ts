import { beforeEach, expect, it, vi } from "vitest";

// On Android the sign-in callback reaches the app twice: as the sign-in's own result and as a link.
const mocks = vi.hoisted(() => ({ store: new Map<string, string>(), exchange: vi.fn() }));
vi.mock("expo-crypto", () => ({}));
vi.mock("expo-web-browser", () => ({}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => mocks.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.store.set(key, value); },
  deleteItemAsync: async (key: string) => { mocks.store.delete(key); },
}));
vi.mock("./protocol", () => ({ exchangeAuthorizationCode: mocks.exchange, AUTH_CONFIG: {} }));
const { finishSignIn } = await import("./native");

const session = { accessToken: "a", refreshToken: "r", expiresAt: 0 };

beforeEach(() => {
  mocks.store = new Map([["terminalx.cloud.pkce.verifier", "v"], ["terminalx.cloud.pkce.state", "s"], ["terminalx.cloud.pkce.nonce", "n"]]);
  // Like the server: the verifier is spent by the first exchange, so a second one fails.
  mocks.exchange.mockReset().mockImplementation(async ({ verifier }: { verifier: string | null }) => verifier ? { ok: true, session } : { ok: false, reason: "The sign-in expired. Try again." });
});

it("finishes a callback that arrives twice once, giving both the same outcome", async () => {
  const url = "terminalx://auth/callback?code=one&state=s";
  const [first, second] = await Promise.all([finishSignIn(url), finishSignIn(url)]);
  expect(first).toEqual({ status: "signed-in", session });
  expect(second).toBe(first);
  expect(await finishSignIn(url)).toBe(first);
  expect(mocks.exchange).toHaveBeenCalledTimes(1);
});

it("still finishes a new sign-in's own callback", async () => {
  await finishSignIn("terminalx://auth/callback?code=two&state=s");
  mocks.store.set("terminalx.cloud.pkce.verifier", "v2");
  mocks.store.set("terminalx.cloud.pkce.state", "s2");
  mocks.store.set("terminalx.cloud.pkce.nonce", "n2");
  await finishSignIn("terminalx://auth/callback?code=three&state=s2");
  expect(mocks.exchange).toHaveBeenCalledTimes(2);
});
