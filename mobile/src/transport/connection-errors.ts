import { CREDENTIAL_REFUSED, CredentialRefusedError, RelayOuterError } from "./relay-client";

/**
 * What a transport failure means to the person holding the phone (#670).
 * Screens show `problemText`; the raw close code goes to the connection log
 * only (`closeDetail`).
 */
export type ConnectionProblem = "pairing-invalid" | "mac-offline" | "dropped" | "reconnecting" | "network" | "too-large" | "no-answer";

/**
 * A connection path's failure, or a whole attempt's when every path failed
 * (#1316): the message is already redacted for the connection log, and
 * `problem` keeps what the failure meant, which the message no longer says.
 */
export class ConnectionAttemptError extends Error {
  constructor(message: string, readonly problem: ConnectionProblem | null) {
    super(message);
  }
}

/** Null when the failure is not the connection's: the Mac answered, and its message can be shown as it is. */
export function connectionProblem(cause: unknown): ConnectionProblem | null {
  if (cause instanceof ConnectionAttemptError) return cause.problem;
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

/**
 * What one path's failure says about the pairing while connecting. A 4401
 * counts as the pairing refused only when it is the refusal of this pairing:
 * a `CredentialRefusedError` (the relay or the pinned Mac), and not one for a
 * grace credential after a rotation (`entitled` false). A plain 4401 came
 * from a party not entitled to refuse it, such as a stale LAN address now
 * answered by another computer, and says nothing (null).
 */
export function pathProblem(cause: unknown, entitled = true): ConnectionProblem | null {
  if (cause instanceof RelayOuterError && cause.code === CREDENTIAL_REFUSED && !(entitled && cause instanceof CredentialRefusedError)) return null;
  return connectionProblem(cause);
}

/**
 * Most telling first: what an attempt that failed on every path reports.
 * A refused pairing needs pairing again; the relay saying the Mac is not
 * there explains a LAN path that never answered; a typed relay close says
 * more than a socket that never opened; a plain drop says least.
 */
const PRECEDENCE: readonly ConnectionProblem[] = ["pairing-invalid", "mac-offline", "too-large", "network", "no-answer", "reconnecting", "dropped"];

/**
 * The one classification for an attempt whose paths failed with `problems`,
 * the same whatever order the paths failed in; null when none was known.
 */
export function decisiveProblem(problems: readonly (ConnectionProblem | null)[]): ConnectionProblem | null {
  return PRECEDENCE.find((problem) => problems.includes(problem)) ?? null;
}

/**
 * Messages this side raises while making or keeping the connection
 * (`HostConnection`, `RelayClient`, the E2EE handshake). They are for the
 * connection log: the screen says the connection state instead (#983).
 */
const TRANSPORT_MESSAGES = [
  /^Host is disconnected$/, /^Relay connection (unavailable|closed)$/, /^Connection attempt cancelled$/,
  /^Relay endpoint unavailable$/, /^Relay director (returned|response)/, /^no answer \d+ s after Relay failed$/,
  /^(Direct|Relay) handshake timed out/, /^WebSocket connection failed/, /^RPC timed out/,
  /^Unexpected (direct connection state|relay credential kind)$/, /^Expected plaintext relay hello$/, /^Invalid relay (hello|JSON|binary frame)$/,
  /^Relay resume (credential version mismatch|confirmation missing)$/, /^Invalid E2EE ready$/, /^Invalid or out-of-order E2EE frame$/,
  /^E2EE device authentication rejected$/, /^relay_outer/, /^relay endpoint: /,
];
/** An address or a host name: never shown, whatever carried it. */
const ADDRESS = /\b(wss?|https?):\/\/|\b\d{1,3}(\.\d{1,3}){3}\b|\[[0-9a-f:]+\]|\[redacted-endpoint\]/i;

/** Whether a failure is the connection's own, worded for the log and not for the screen. */
export function isTransportError(cause: unknown): boolean {
  if (connectionProblem(cause) !== null) return true;
  if (!(cause instanceof Error)) return false;
  return TRANSPORT_MESSAGES.some((pattern) => pattern.test(cause.message)) || ADDRESS.test(cause.message);
}

/**
 * What a screen may say about a failure: the Mac's own message as it is, and
 * `fallback` for the connection's (which the connection state already shows)
 * or for anything that is not an error.
 */
export function screenMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error) || isTransportError(cause) || !cause.message.trim()) return fallback;
  return cause.message;
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
