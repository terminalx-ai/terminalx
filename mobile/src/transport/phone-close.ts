/**
 * The close codes this app closes its connection to the Mac with (#1282),
 * mirrored in `src-tauri/src/phone/mod.rs` (`PHONE_CLOSE_*`). The relay passes
 * a code in 4000–4999 through to the Mac's leg unchanged and turns any other
 * into 4408, so these are what let the Mac's `relay-diagnostics.json` tell the
 * phone closing on purpose from a probe that went unanswered and from a leg
 * the relay or the network dropped. The Mac never sends them, so they never
 * reach `connectionProblem`.
 */
export const PHONE_CLOSE = {
  /** Closed on purpose: the person left, the app reconnected, another path won. */
  closed: 4000,
  /** The liveness probe (`pairing.getEndpoints`) went unanswered. */
  probeTimeout: 4001,
  /** Something failed on this side: a handshake that timed out, a frame it could not read. */
  failed: 4002,
} as const;

export type PhoneCloseCode = (typeof PHONE_CLOSE)[keyof typeof PHONE_CLOSE];
