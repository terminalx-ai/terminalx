import { describe, expect, it, vi } from "vitest";
import { AUTH_CONFIG, MOBILE_REDIRECT_URI, authSessionFailure, buildAuthorizeUrl, exchangeAuthorizationCode, parseCallbackUrl, redeemAccessCode, refreshSession } from "./protocol";

describe("mobile OAuth PKCE", () => {
  it("builds the registered first-party authorization request", () => {
    const url = new URL(buildAuthorizeUrl(AUTH_CONFIG, "challenge", "state", "nonce"));
    expect(url.origin).toBe("https://login.terminalx.ai");
    expect(url.searchParams.get("client_id")).toBe("terminalx-mobile");
    expect(url.searchParams.get("redirect_uri")).toBe(MOBILE_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("profileId")).toBe(false);
  });

  it("asks the server for a sign-in, not the browser's remembered one, only when it must be fresh (PRO-584)", () => {
    const fresh = new URL(buildAuthorizeUrl(AUTH_CONFIG, "challenge", "state", "nonce", { fresh: true }));
    expect(fresh.searchParams.get("prompt")).toBe("login");
    expect(fresh.searchParams.get("max_age")).toBe("0");
    const usual = new URL(buildAuthorizeUrl(AUTH_CONFIG, "challenge", "state", "nonce"));
    expect(usual.searchParams.has("prompt")).toBe(false);
    expect(usual.searchParams.has("max_age")).toBe(false);
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

describe("the sign-in sheet's outcome", () => {
  it("reports a sheet iOS could not present", () => {
    expect(authSessionFailure({ type: "cancel", error: "The operation couldn’t be completed. (com.apple.AuthenticationServices.WebAuthenticationSession error 2.)" }))
      .toBe("The sign-in page could not open: The operation couldn’t be completed. (com.apple.AuthenticationServices.WebAuthenticationSession error 2.)");
  });

  it("says nothing when the person closed it, or it succeeded", () => {
    expect(authSessionFailure({ type: "cancel", error: "The operation couldn’t be completed. (com.apple.AuthenticationServices.WebAuthenticationSession error 1.)" })).toBeNull();
    expect(authSessionFailure({ type: "cancel" })).toBeNull();
    expect(authSessionFailure({ type: "dismiss", error: null })).toBeNull();
    expect(authSessionFailure({ type: "success", error: "ignored" })).toBeNull();
  });
});

// PRO-551: the private beta's hold at sign-in and the access code, as docs/mobile-sign-in-access-code.md (terminalx-saas, PRO-550) sets them.
describe("the private beta's access code", () => {
  const SESSION = { accessToken: "access", refreshToken: "refresh", expiresAt: 1_795_200_000_000, user: { userId: "u-new", email: "person@example.com" } };
  const HELD = { error: "access_code_required", accessTicket: "cah_ticket.secret", accessTicketExpiresAt: 1_795_200_000_000, email: "person@example.com" };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const exchange = (fetchImpl: typeof fetch) => exchangeAuthorizationCode({ config: AUTH_CONFIG, callbackUrl: "terminalx://auth/callback?code=code&state=right", verifier: "verifier", expectedState: "right", nonce: "nonce", fetchImpl });
  const HOLD = { ticket: "cah_ticket.secret", expiresAt: HELD.accessTicketExpiresAt, email: HELD.email };

  it("hands back the hold, not a failure, when sign-in answers 403 access_code_required", async () => {
    await expect(exchange(json(403, HELD))).resolves.toEqual({ ok: false, reason: "access_code_required", hold: HOLD });
  });

  it("treats any other 403, or a hold missing a field, as the failure it was", async () => {
    await expect(exchange(json(403, { error: "forbidden" }))).resolves.toEqual({ ok: false, reason: "exchange_failed_403" });
    for (const missing of ["accessTicket", "accessTicketExpiresAt", "email"]) {
      const body: Record<string, unknown> = { ...HELD };
      delete body[missing];
      await expect(exchange(json(403, body))).resolves.toEqual({ ok: false, reason: "exchange_failed_403" });
    }
    await expect(exchange(json(403, { ...HELD, accessTicketExpiresAt: 1.5 }))).resolves.toEqual({ ok: false, reason: "exchange_failed_403" });
    await expect(exchange(vi.fn(async () => new Response("not json", { status: 403 })) as unknown as typeof fetch)).resolves.toEqual({ ok: false, reason: "exchange_failed_403" });
  });

  it("still signs in on 200, and still fails on the exchange's own refusals", async () => {
    await expect(exchange(json(200, SESSION))).resolves.toEqual({ ok: true, session: SESSION });
    await expect(exchange(json(400, { error: "invalid_grant" }))).resolves.toEqual({ ok: false, reason: "exchange_failed_400" });
  });

  it("sends the ticket, the code without the space around it, and the phone's client id to the redeem route", async () => {
    const fetchImpl = json(200, { status: "accepted", ...SESSION });
    await redeemAccessCode(AUTH_CONFIG, HOLD, "  k7qm2x9trb \n", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://login.terminalx.ai/v1/auth/access-code/redeem");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ accessTicket: "cah_ticket.secret", code: "k7qm2x9trb", clientId: "terminalx-mobile" });
  });

  it("reads 200 accepted as the session", async () => {
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(200, { status: "accepted", ...SESSION }))).resolves.toEqual({ status: "accepted", session: SESSION });
  });

  it("does not sign in on a 200 that is not an accepted session", async () => {
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(200, SESSION))).resolves.toEqual({ status: "unanswered", reason: "invalid_redeem_response" });
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(200, { status: "accepted", accessToken: "a" }))).resolves.toEqual({ status: "unanswered", reason: "invalid_redeem_response" });
  });

  it.each([
    [404, "invalid"],
    [410, "expired"],
    [409, "exhausted"],
  ] as const)("reads %i %s as that refusal", async (status, error) => {
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(status, { error }))).resolves.toEqual({ status: error });
  });

  it("reads 401 invalid_grant as a ticket that is gone: sign-in starts again", async () => {
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(401, { error: "invalid_grant" }))).resolves.toEqual({ status: "ticket_dead" });
  });

  it("reads 429 rate_limited with the wait the body names, else the header's, else the server's own window", async () => {
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(429, { error: "rate_limited", retryAfter: 4 }, { "retry-after": "9" }))).resolves.toEqual({ status: "rate_limited", retryAfter: 4 });
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(429, { error: "rate_limited" }, { "retry-after": "2" }))).resolves.toEqual({ status: "rate_limited", retryAfter: 2 });
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(429, { error: "rate_limited" }))).resolves.toEqual({ status: "rate_limited", retryAfter: 5 });
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(429, { error: "rate_limited", retryAfter: 1.2 }))).resolves.toEqual({ status: "rate_limited", retryAfter: 2 });
  });

  it.each([
    [400, { error: "invalid_request" }],
    [413, { error: "invalid_request" }],
    [500, { error: "server_error" }],
    [502, "Bad gateway"],
    [404, { error: "not_found" }],
  ])("says nothing about the code on %i: it could not be checked", async (status, body) => {
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", json(status, body))).resolves.toEqual({ status: "unanswered", reason: `redeem_failed_${status}` });
  });

  it("tells no network from no answer in time, and never puts the ticket in the reason", async () => {
    const unreachable = vi.fn(async () => { throw new TypeError("Network request failed cah_ticket.secret"); }) as unknown as typeof fetch;
    const timedOut = vi.fn(async () => { throw Object.assign(new Error("Aborted"), { name: "AbortError" }); }) as unknown as typeof fetch;
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", unreachable)).resolves.toEqual({ status: "unanswered", reason: "redeem_unreachable" });
    await expect(redeemAccessCode(AUTH_CONFIG, HOLD, "CODE", timedOut)).resolves.toEqual({ status: "unanswered", reason: "redeem_timed_out" });
  });
});
