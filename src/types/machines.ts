/**
 * Pairing two computers by code (PRO-342, docs/MACHINES.md "Pairing by code",
 * "As built (PRO-342)"). The Rust side (`machine_wire`, the `machines_*`
 * Tauri commands) serialises to exactly these shapes.
 */

/** How the operating computer reaches a machine. */
export type MachineRoute = "relayAndNearby" | "thisNetwork";

export interface MachineOs {
  family: "macos" | "linux" | string;
  version: string | null;
}

/** A machine as its code (and later `machine.describe`) names it. */
export interface MachineIdentity {
  machineId: string;
  name: string;
  os: MachineOs;
  /** The TerminalX version on the machine. */
  version: string;
}

/** A computer that may operate this machine. No credential. */
export interface PairedComputer {
  id: string;
  label: string;
  platform: string | null;
  approvedAt: number;
  lastSeenAt: number | null;
  connected: boolean;
}

/** A computer asking to operate this machine, waiting for Allow. */
export interface PendingComputer {
  requestId: string;
  label: string;
  platform: string | null;
  /** Four groups, "·"-separated, e.g. "CEF4·2468·FE26·9E4B". */
  fingerprint: string;
  transport: "direct" | "relay";
  requestedAt: number;
  expiresAt: number;
}

/** The runtime's machine host (`machine_wire::Status`). */
export interface MachineHostStatus {
  enabled: boolean;
  hostKey: "ready" | "needed" | "error";
  machineId: string | null;
  listening: string | null;
  takesPort: boolean;
  phoneRoute: boolean;
  computers: PairedComputer[];
  error: string | null;
  pending: PendingComputer | null;
  /** The live pairing code's expiry; the code itself only `createCode` returns. */
  code: { expiresAt: number } | null;
  /** Pairing is paused after five wrong attempts in a minute, until then. */
  pausedUntil: number | null;
}

/** `machines_host_status`, `machines_set_allow_operating`, the `machines_host_changed` event. */
export interface MachineHostView {
  /** `machines.allowOperating` in settings. */
  allowOperating: boolean;
  /** `pairing.keepAwake`, shared with phones. */
  keepAwake: boolean;
  /** Null while the runtime cannot be reached. */
  status: MachineHostStatus | null;
}

/** `machines_create_code`. */
export interface MachinePairingCode {
  code: string;
  expiresAt: number;
}

/** `machines_inspect_code`: what the operating computer shows before it connects. */
export interface InspectedMachineCode {
  machine: MachineIdentity;
  /** This computer's fingerprint for the code: the machine shows the same. */
  fingerprint: string;
  expiresAt: number;
  directEndpoints: string[];
  hasRelay: boolean;
  /** This computer already paired with the machine (it is paired again). */
  alreadyPaired: boolean;
}

/** A machine this computer paired with (`machines.json`). */
export interface PairedMachine {
  machineId: string;
  name: string;
  os: MachineOs;
  version: string;
  publicKeyB64: string;
  directEndpoints: string[];
  route: MachineRoute;
  pairedAt: number;
  lastSeenAt: number | null;
}

/**
 * Why `machines_pair` did not pair:
 * - `not-approved`: "Don't allow", or no answer in two minutes.
 * - `code-inactive`: expired, used, or replaced by a newer code.
 * - `another-computer`: another computer is waiting for approval.
 * - `pairing-paused`: too many wrong attempts; try again in a minute.
 * - `unreachable`: no endpoint answered.
 * - `invalid-code`: not a machine code, or its ids disagree.
 * - `cancelled`: `machines_cancel_pairing`.
 */
export type MachinePairingFailure =
  | "not-approved"
  | "code-inactive"
  | "another-computer"
  | "pairing-paused"
  | "unreachable"
  | "invalid-code"
  | "cancelled";

/**
 * `machines_pair`. Expected outcomes come back as `paired: false`; a rejected
 * promise (a plain string, as every command's error) is a fault such as an
 * unreadable Keychain.
 */
export type MachinePairResult =
  | { paired: true; machine: PairedMachine }
  | { paired: false; reason: MachinePairingFailure; message: string };

export const MACHINE_CODE_PREFIX = "txm2." as const;
export const MACHINE_CODE_TTL_MS = 5 * 60_000;
export const MACHINE_APPROVAL_TTL_MS = 120_000;
