export type PairingStage = "parsing" | "transport" | "host-verification" | "credential-installation" | "persistence";
export type PairingCategory = "invalid-offer" | "expired-offer" | "connection-failed" | "relay-rejected" | "invalid-host" | "credential-rejected" | "save-failed";

const recovery: Record<PairingCategory, string> = {
  "invalid-offer": "This pairing code is invalid or unsupported. Generate a fresh offer in Settings → Devices on your Mac and copy the full code.",
  "expired-offer": "This pairing offer has expired. Generate a fresh offer in Settings → Devices on your Mac. Check both devices’ clocks if a new offer also expires immediately.",
  "connection-failed": "Couldn’t establish a secure connection to your Mac. Keep TerminalX open, check Relay and your network, then retry. If this offer was already used, generate a fresh one.",
  "relay-rejected": "Relay rejected this pairing attempt. The offer may have expired or already been used. Retry to recover an interrupted pairing, or generate a fresh offer on your Mac.",
  "invalid-host": "Couldn’t verify the Mac’s secure pairing response. Update both apps and generate a fresh pairing offer.",
  "credential-rejected": "Couldn’t finish installing the pairing credential. Keep TerminalX open on your Mac and retry to recover this attempt. If it still fails, generate a fresh offer.",
  "save-failed": "Couldn’t save the pairing on this phone. Unlock the phone and retry to recover the pairing.",
};
const categoryForStage: Record<PairingStage, PairingCategory> = {
  parsing: "invalid-offer", transport: "connection-failed", "host-verification": "invalid-host",
  "credential-installation": "credential-rejected", persistence: "save-failed",
};

/** Only allowlisted diagnostics cross into UI/logs; never attach a raw cause. */
export class PairingFailure extends Error {
  constructor(readonly stage: PairingStage, readonly category: PairingCategory = categoryForStage[stage], relayCode?: number) {
    const code = typeof relayCode === "number" && Number.isInteger(relayCode) && relayCode >= 1000 && relayCode <= 4999 ? `/${relayCode}` : "";
    super(`${recovery[category]} [pairing:${stage}/${category}${code}]`);
    this.name = "PairingFailure";
  }
}

export async function pairingStep<T>(stage: PairingStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) { throw cause instanceof PairingFailure ? cause : new PairingFailure(stage); }
}
