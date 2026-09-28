import { ZodError } from "zod";
import { RelayHandshakeError, RelayOuterError } from "../transport/relay-client";

export type PairingStage = "parsing" | "transport" | "host-verification" | "credential-installation" | "persistence";
export type PairingPath = "direct" | "relay";
type PairingCategory = "invalid-offer" | "expired-offer" | "connection-failed" | "relay-refused" | "invalid-response" | "credential-rejected" | "storage-unavailable";

const guidance: Record<PairingCategory, string> = {
  "invalid-offer": "Copy the full pairing code or scan a fresh QR code from Settings → Devices on your Mac.",
  "expired-offer": "This pairing offer expired. Generate a fresh offer in Settings → Devices on your Mac.",
  "connection-failed": "Couldn’t establish a secure connection. Keep your Mac awake, check connectivity, then retry. If the offer was already used, generate a fresh one.",
  "relay-refused": "The relay refused this connection. The offer may be expired or already used. Generate a fresh offer on your Mac and try again.",
  "invalid-response": "The Mac’s secure pairing response could not be verified. Check that both apps are up to date, then generate a fresh offer.",
  "credential-rejected": "The Mac could not finish installing the pairing credential. Retry to recover this attempt, or generate a fresh offer.",
  "storage-unavailable": "The phone could not save pairing data. Unlock the phone and retry to recover this attempt.",
};

/** Only bounded categories cross into UI/logs; never forward server, schema or storage error text. */
export class PairingError extends Error {
  constructor(readonly stage: PairingStage, readonly category: PairingCategory, readonly path?: PairingPath) {
    super(`${guidance[category]} (${stage}/${category}${path ? `/${path}` : ""})`);
    this.name = "PairingError";
  }
}

export async function atPairingStage<T>(stage: PairingStage, operation: () => Promise<T>, path?: PairingPath): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PairingError) throw error;
    if (error instanceof RelayHandshakeError) throw new PairingError("host-verification", "invalid-response", path);
    const category: PairingCategory = stage === "persistence" ? "storage-unavailable"
      : error instanceof RelayOuterError && error.code >= 4000 && error.code <= 4999 ? "relay-refused"
      : stage === "host-verification" || error instanceof ZodError ? "invalid-response"
      : stage === "credential-installation" ? "credential-rejected" : "connection-failed";
    throw new PairingError(stage, category, path);
  }
}

/** Preserve the most advanced failure; an unreachable LAN dial must not hide a relay refusal. */
export function preferPairingFailure(previous: unknown, next: unknown): unknown {
  const priority = (error: unknown) => {
    if (!(error instanceof PairingError)) return -1;
    const stage = { parsing: 0, transport: 1, "host-verification": 2, "credential-installation": 3, persistence: 4 }[error.stage];
    return stage * 2 + (error.path === "relay" ? 1 : 0);
  };
  return priority(previous) > priority(next) ? previous : next;
}
