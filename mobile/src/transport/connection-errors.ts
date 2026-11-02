import { RelayOuterError } from "./relay-client";

/**
 * What a transport failure means to the person holding the phone (#670).
 * Screens show `problemText`; the raw close code goes to the connection log
 * only (`closeDetail`).
 */
export type ConnectionProblem = "pairing-invalid" | "mac-offline" | "dropped" | "reconnecting" | "network" | "too-large" | "no-answer";

/** Null when the failure is not the connection's: the Mac answered, and its message can be shown as it is. */
export function connectionProblem(cause: unknown): ConnectionProblem | null {
  if (cause instanceof RelayOuterError) {
    switch (cause.code) {
      case 4401: return "pairing-invalid";
      case 4404: return "mac-offline";
      case 4409: return "reconnecting";
      // The relay's typed close for an oversized message (#669 fix 5).
      case 4413: return "too-large";
      case 1006: return "network";
      // 4408 (the other leg closed), 1001 (iOS: "Stream end encountered") and any other close.
      default: return "dropped";
    }
  }
  if (!(cause instanceof Error)) return null;
  // These are raised on this side: `HostConnection.request` and `RelayClient`.
  if (["Host is disconnected", "Relay connection unavailable", "Relay connection closed"].includes(cause.message)) return "dropped";
  if (cause.message.startsWith("WebSocket connection failed")) return "network";
  if (cause.message.startsWith("RPC timed out")) return "no-answer";
  return null;
}

const text: Record<ConnectionProblem, string> = {
  "pairing-invalid": "this phone is no longer paired with your Mac; pair it again from Machines",
  "mac-offline": "your Mac is offline",
  dropped: "the connection to your Mac dropped",
  reconnecting: "the phone is reconnecting to your Mac",
  network: "a network problem interrupted the connection to your Mac",
  "too-large": "a message too large for Relay dropped the connection to your Mac",
  "no-answer": "your Mac didn't answer in time",
};

/** A clause in plain words, to follow "Not sent:" or to start a sentence. */
export function problemText(problem: ConnectionProblem): string {
  return text[problem];
}

/** Whether asking again can help. A pairing the relay refuses stays refused. */
export function canRetry(problem: ConnectionProblem): boolean {
  return problem !== "pairing-invalid";
}

/**
 * Whether a request that failed here most likely reached the Mac anyway: the
 * connection stayed up and the Mac never answered. Safe to repeat for a read,
 * not for a send, which the Mac does not de-duplicate (#675).
 */
export function mayHaveArrived(problem: ConnectionProblem): boolean {
  return problem === "no-answer";
}

/** For the connection log: the code, and what the close said when there was a close. */
export function closeDetail(error: RelayOuterError): string {
  if (error.wasClean === undefined) return error.message;
  return `${error.message} (${error.reason ? `reason "${error.reason}"` : "no reason"}, ${error.wasClean ? "clean" : "not clean"})`;
}
