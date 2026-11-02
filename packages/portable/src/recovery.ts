import type { AgentEvent, RecoveryKind } from "./events";

export const RECOVERY_MESSAGES: Record<RecoveryKind, string> = {
  capacity: "The provider is at capacity. Retry or choose another available model.",
  usage_limit: "Your plan's usage limit is reached. Wait for it to reset, or continue on another model.",
  tool: "A tool or command failed. Review its outcome before continuing.",
  timeout: "No progress was confirmed before the timeout. The process outcome is unknown.",
  delivery_unconfirmed: "Prompt delivery could not be confirmed. Check the terminal: if your message is still in the agent's input, press Enter there to send it. To resend instead, stop the session, then press Up in the composer to recall your message.",
  unsent: "The agent never received your last prompt, so its conversation starts without it. Resend it, or send something new.",
  disconnected: "The connection was lost. The process outcome is unknown.",
  permission_expired: "The permission request expired. Check the terminal for a new request or stop the session.",
  signed_out: "The agent is signed out, or its sign-in expired. Sign in again, then retry.",
  failed: "The agent encountered an error. Review the conversation before continuing.",
};

/** Never echo arbitrary IPC/provider errors in recovery controls. */
export function classifyRecovery(message: string): RecoveryKind {
  // The agents' own sign-in wording only, as `recovery.rs` reads it: another service's 401 is that tool's failure.
  if (/run \/login|authentication_failed|oauth token has expired|run codex login|agent is signed out/i.test(message)) return "signed_out";
  if (/usage.?limit|hit your|limit reached|quota/i.test(message)) return "usage_limit";
  if (/capacity|overloaded|rate.?limit|too many requests|429|529/i.test(message)) return "capacity";
  if (/timeout|timed out|no progress/i.test(message)) return "timeout";
  if (/network|disconnect|connection|broken pipe|closed|eof/i.test(message)) return "disconnected";
  return "failed";
}

export function recoveryFromEvents(events: AgentEvent[]): RecoveryKind | null {
  let kind: RecoveryKind | null = null;
  for (const event of events) {
    if (event.subagent) continue;
    const p = event.payload;
    if (p.type === "recovery") kind = p.kind;
    else if (p.type === "user_message" && !p.queued) kind = null;
  }
  return kind;
}

// A new conversation turn, never a replay of tool input or the original prompt.
export const RECOVERY_PROMPT = "Review the previous interrupted or failed turn and check the current outcome first. Do not repeat completed tool calls. If a command may still be running or its side effects are unknown, verify its state before taking further action. Continue only the unfinished work; ask me if you cannot safely determine what remains.";

// The light nudge (#665): what a reader would type to have the agent carry on in the same conversation.
export const CONTINUE_PROMPT = "continue";

/** What the recovery banner offers, the same on every screen that draws one. */
export interface RecoveryOffer {
  title: string;
  message: string;
  signIn: boolean;
  /** Unsent: the last prompt goes again as it was sent; there is no turn to retry. */
  resend: boolean;
  /** Signed out, a retry only fails again until the agent is signed in: it is offered second, for after. */
  retry: "Retry" | "Retry safely" | null;
  /** Send "continue" in this same conversation, with no stop first. */
  sendContinue: boolean;
  /** Retry on another model, for a provider at capacity or a plan out of usage. */
  chooseModel: boolean;
  continueInNewSession: boolean;
}

export function recoveryOffer(kind: RecoveryKind | null, { asks, limitReset = false, canResend = false, canSendContinue = false, canSignIn = false }: {
  /** Requests waiting for an answer: the banner then only says so, and nothing else answers them by accident. */
  asks: number;
  /** A usage limit whose window has reset. */
  limitReset?: boolean;
  canResend?: boolean;
  canSendContinue?: boolean;
  canSignIn?: boolean;
}): RecoveryOffer {
  const open = asks === 0;
  return {
    title: asks ? "Waiting for input" : kind === "usage_limit" ? "Usage limit reached" : kind === "signed_out" ? "Signed out" : kind === "unsent" ? "Prompt not received" : kind ? "Needs attention" : "Waiting for input",
    message: kind ? RECOVERY_MESSAGES[kind] : asks ? "Review the pending request to continue." : "Check the terminal for a pending decision, or stop the session.",
    signIn: kind === "signed_out" && canSignIn && open,
    resend: kind === "unsent" && canResend && open,
    retry: kind && kind !== "usage_limit" && kind !== "permission_expired" && kind !== "delivery_unconfirmed" && kind !== "unsent" && open
      ? (kind === "signed_out" ? "Retry" : "Retry safely") : null,
    // "continue" only where the turn has ended or the agent's process has gone (a send starts it again): a usage
    // limit once its window has reset, and signed out as the step after signing in. Not on a turn still open (a
    // timeout, or an older log's failed tool), where it would queue behind it; not when delivery is unconfirmed,
    // where the unsent prompt may still be in the CLI's input and "continue" would only wait behind it (#722); not
    // over a request, which it would answer.
    sendContinue: canSendContinue && open && (kind === "failed" || kind === "capacity" || kind === "disconnected" || kind === "signed_out" || (kind === "usage_limit" && limitReset)),
    chooseModel: (kind === "capacity" || kind === "usage_limit") && open,
    continueInNewSession: kind !== null,
  };
}
