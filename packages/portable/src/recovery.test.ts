import { describe, expect, it } from "vitest";
import { recoveryOffer } from "./recovery";

describe("the recovery offer the desktop and the phone share", () => {
  it("retries a failed turn safely, continues it, or carries it into a new session", () => {
    const offer = recoveryOffer("failed", { asks: 0, canResend: true, canSendContinue: true });
    expect(offer).toMatchObject({ title: "Needs attention", retry: "Retry safely", sendContinue: true, resend: false, chooseModel: false, continueInNewSession: true });
  });

  it("resends a prompt the agent never had instead of retrying a turn that never was", () => {
    expect(recoveryOffer("unsent", { asks: 0, canResend: true })).toMatchObject({ title: "Prompt not received", resend: true, retry: null });
    expect(recoveryOffer("unsent", { asks: 0, canResend: false }).resend).toBe(false);
  });

  it("offers another model at capacity or out of usage, and continue only once a usage window has reset", () => {
    expect(recoveryOffer("capacity", { asks: 0, canSendContinue: true })).toMatchObject({ chooseModel: true, sendContinue: true, retry: "Retry safely" });
    expect(recoveryOffer("usage_limit", { asks: 0, canSendContinue: true })).toMatchObject({ chooseModel: true, sendContinue: false, retry: null });
    expect(recoveryOffer("usage_limit", { asks: 0, canSendContinue: true, limitReset: true }).sendContinue).toBe(true);
  });

  it("puts a retry after signing in, and offers signing in only where it can be done", () => {
    expect(recoveryOffer("signed_out", { asks: 0, canSignIn: true })).toMatchObject({ signIn: true, retry: "Retry" });
    expect(recoveryOffer("signed_out", { asks: 0 }).signIn).toBe(false);
  });

  it("never offers an action that would answer a waiting request or clear an unsent prompt", () => {
    expect(recoveryOffer("failed", { asks: 1, canResend: true, canSendContinue: true })).toMatchObject({ title: "Waiting for input", retry: null, sendContinue: false, chooseModel: false });
    expect(recoveryOffer("delivery_unconfirmed", { asks: 0, canSendContinue: true })).toMatchObject({ retry: null, sendContinue: false });
    expect(recoveryOffer(null, { asks: 0 })).toMatchObject({ retry: null, continueInNewSession: false });
  });

  it("points a waiting native Codex tab at its conversation, not at a terminal it does not have (#644)", () => {
    const native = recoveryOffer(null, { asks: 0, native: true });
    expect(native).toMatchObject({ title: "Waiting for input", message: "Review the conversation above, then send a message or stop the session." });
    expect(native.message).not.toMatch(/terminal/i);
    // A tab whose agent runs in its terminal is told to look there, as before.
    expect(recoveryOffer(null, { asks: 0 }).message).toBe("Check the terminal for a pending decision, or stop the session.");
    // A request, or a known recovery, says the same on either.
    expect(recoveryOffer(null, { asks: 1, native: true }).message).toBe("Review the pending request to continue.");
    expect(recoveryOffer("signed_out", { asks: 0, native: true }).message).toBe(recoveryOffer("signed_out", { asks: 0 }).message);
  });
});
