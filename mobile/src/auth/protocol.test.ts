import { describe, expect, it, vi } from "vitest";
import { AUTH_CONFIG, MOBILE_REDIRECT_URI, buildAuthorizeUrl, exchangeAuthorizationCode, parseCallbackUrl } from "./protocol";

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

  it("parses the custom-scheme callback without trusting URL polyfills", () => {
    expect(parseCallbackUrl("terminalx://auth/callback?code=a%2Fb&state=s")).toEqual({ code: "a/b", state: "s", error: null });
  });
});
