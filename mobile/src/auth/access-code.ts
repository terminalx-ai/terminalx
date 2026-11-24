import type { RedeemOutcome } from "./protocol";

/**
 * A sign-in held at the private beta, as the screens see it (PRO-551): the
 * address the code would be used for, and a new `id` for each hold, so a
 * second sign-in starts the screen afresh. The ticket is not here: it stays
 * inside the app provider, in memory only.
 */
export interface AccessCodeRequest {
  id: number;
  email: string;
}

/** The server's answer to a code, as the screen is told it: an accepted code's session goes to the app, not the screen. */
export type AccessCodeAnswer = Exclude<RedeemOutcome, { status: "accepted" }> | { status: "accepted" };

/** A code the server refused, said under the field. */
export type AccessCodeRefusal = "invalid" | "expired" | "exhausted";

/**
 * Board 25.08's sentences. The opening one is the web console's, unchanged;
 * the refusals are the console's without the exclamation mark and with what
 * to do next. Too many tries and an ended sign-in are the contract's
 * (PRO-550) answers the board does not draw.
 */
export const ACCESS_CODE_TEXT = {
  title: "Access code",
  cancel: "Cancel",
  intro: "TerminalX is in private beta. Enter your access code to create an account.",
  forAccount: "The code is used for this account.",
  label: "Access code",
  placeholder: "10 letters and digits",
  helper: "Capitals or not, it is the same code.",
  /** The owner's answer (2026-11-24) to what a person without a code can do: nothing, so it is said plainly. */
  noCode: "An access code is needed to continue. Without one, Cancel signs you out.",
  continue: "Continue",
  checking: "Checking the code…",
  accepted: "Access code accepted",
  signedInAs: (email: string) => `Signed in as ${email}.`,
  invalid: "That access code is not valid. Check it and try again.",
  expired: "That access code has expired. Enter a different one.",
  exhausted: "That access code has been fully used. Enter a different one.",
  offline: "Offline. The code was not sent.",
  unanswered: "The code could not be checked. Try again: a code is never used twice for the same account.",
  tryAgain: "Try again",
  /** Shown while the wait the server asked for runs out, with the time left on Try again. */
  rateLimited: "Too many tries. Wait a moment, then try again.",
  tryAgainIn: (clock: string) => `Try again in ${clock}`,
  ticketDead: "This sign-in has ended. Sign in again to enter your code.",
  signInAgain: "Sign in again",
} as const;

export function refusalText(refusal: AccessCodeRefusal): string {
  return ACCESS_CODE_TEXT[refusal];
}

/** How long the accepted page shows before it closes onto the Cloud tab (25.08: "shown for a moment"). */
export const ACCEPTED_PAUSE_MS = 1_200;
