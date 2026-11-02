import type { RpcErrorData } from "@terminalx/portable/rpc";

/** What the phone says when its Mac refuses an operation TerminalX there does not know (#730). */
export const MAC_NEEDS_UPDATE = "TerminalX on your Mac needs updating or restarting to do this.";

/**
 * How a Mac's background runtime refuses an operation it does not know. A Mac
 * app newer than its runtime offered the feature and passed the refusal on as
 * it was, with an error code in front of it.
 */
const UNKNOWN_OPERATION = "Unsupported paired-device owner operation.";

/** A refusal as the person holding the phone reads it: an unknown operation says what to do about it. Anything else is left as the Mac said it. */
export function plainRefusal(refusal: RpcErrorData): RpcErrorData {
  return typeof refusal?.message === "string" && refusal.message.includes(UNKNOWN_OPERATION) ? { ...refusal, message: MAC_NEEDS_UPDATE } : refusal;
}
