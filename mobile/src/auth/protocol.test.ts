import { describe, expect, it, vi } from "vitest";
import { AUTH_CONFIG, MOBILE_REDIRECT_URI, buildAuthorizeUrl, exchangeAuthorizationCode, parseCallbackUrl, refreshSession } from "./protocol";

describe("mobile OAuth PKCE", () => {
  it("builds the registered first-party authorization request", () => {
    const url = new URL(buildAuthorizeUrl(AUTH_CONFIG, "challenge", "state", "nonce"));
    expect(url.origin).toBe("https://login.terminalx.ai");
    expect(url.searchParams.get("client_id")).toBe("terminalx-mobile");
    expect(url.searchParams.get("redirect_uri")).toBe(MOBILE_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("profileId")).toBe(false);
  });

  it("rejects a callback whose state does not match", async () => {
    const fetchImpl = vi.fn();
    const outcome = await exchangeAuthorizationCode({ config: AUTH_CONFIG, callbackUrl: "terminalx://auth/callback?code=code&state=wrong", verifier: "verifier", expectedState: "right", nonce: "nonce", fetchImpl });
    expect(outcome).toEqual({ ok: false, reason: "state_mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an authorization code delivered to any other route", async () => {
    const fetchImpl = vi.fn();
    const outcome = await exchangeAuthorizationCode({ config: AUTH_CONFIG, callbackUrl: "terminalx://auth?code=code&state=right", verifier: "verifier", expectedState: "right", nonce: "nonce", fetchImpl });
    expect(outcome).toEqual({ ok: false, reason: "invalid_callback_uri" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses the custom-scheme callback without trusting URL polyfills", () => {
    expect(parseCallbackUrl("terminalx://auth/callback?code=a%2Fb&state=s")).toEqual({ code: "a/b", state: "s", error: null });
  });

  it("distinguishes refresh revocation from a temporary service outage", async () => {
    const session = { accessToken: "access", refreshToken: "refresh", expiresAt: 1, user: { userId: "user", email: "user@example.test" } };
    const rejected = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const unavailable = vi.fn(async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(refreshSession(AUTH_CONFIG, session, rejected)).resolves.toEqual({ status: "rejected" });
    await expect(refreshSession(AUTH_CONFIG, session, unavailable)).resolves.toEqual({ status: "unavailable", reason: "refresh_failed_503" });
  });
});
