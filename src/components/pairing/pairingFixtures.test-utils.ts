// Pairing statuses shaped as src/types/pairing.ts says the Mac sends them, for the pairing UI's tests.
import type { PairedDevice, PairingCodeStatus, PairingStatus } from "@/types/pairing";

export const emptyStatus: PairingStatus = {
  relay: { phase: "off", message: null, attempt: 0 },
  host: null,
  devices: [],
  activePairing: null,
  pendingApproval: null,
  keepAwake: true,
  lastError: null,
};

export const relayReady: PairingStatus["relay"] = { phase: "connected", message: null, attempt: 0 };

export function device(patch: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: "phone-1",
    label: "Priya's iPhone",
    platform: "ios",
    token: "hash",
    scope: "driver",
    provenance: "explicit",
    bindingGeneration: 0,
    publicKey: "key",
    createdAt: "2026-09-03T00:00:00Z",
    fingerprint: "7F3A·91C2",
    ...patch,
  };
}

export function code(patch: Partial<PairingCodeStatus> = {}): PairingCodeStatus {
  return {
    pairingUrl: "terminalx://pair?code=relay-code",
    expiresAt: Date.now() + 292_000,
    connectionMode: "automatic",
    directAvailable: true,
    transport: "relay",
    ...patch,
  };
}

export const localCode = (patch: Partial<PairingCodeStatus> = {}) =>
  code({ pairingUrl: "terminalx://pair?code=local-code", connectionMode: "local-only", transport: "direct", ...patch });
