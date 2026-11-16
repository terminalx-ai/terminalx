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

/**
 * `machines_host_status`, `machines_set_allow_operating`, `machines_approve`,
 * `machines_decline`, `machines_revoke`, and the `machines_host_changed` event.
 */
export interface MachineHostView {
  /** `machines.allowOperating` in settings. */
  allowOperating: boolean;
  /** `pairing.keepAwake`, shared with phones. */
  keepAwake: boolean;
  /** Null while the runtime cannot be reached. */
  status: MachineHostStatus | null;
}

/**
 * `machines_create_code`. Refused with a string starting `pairing_paused:` or
 * `not_enabled:`; the status's `pausedUntil` says until when.
 */
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

/** A machine this computer paired with (`machines.json`); `machines_set_route` answers the updated one. */
export interface PairedMachine {
  machineId: string;
  name: string;
  os: MachineOs;
  version: string;
  publicKeyB64: string;
  /** The machine's latest direct addresses (from its code, then from `machine.describe`). */
  directEndpoints: string[];
  route: MachineRoute;
  pairedAt: number;
  lastSeenAt: number | null;
  /** The route that last worked; null before the first connection (PRO-345). */
  lastRoute?: MachineRouteUsed | null;
  /** Where this computer reaches the machine through the relay; null without a relay credential. Never the credential. */
  relay?: MachineRelayInfo | null;
}

/**
 * The connection to a machine (PRO-345, docs/MACHINES.md "As built
 * (PRO-345)"). One supervisor per machine owns it.
 */

/** How a route reaches the machine: a direct address on this network, a Tailscale address, or the relay. */
export type MachineRouteKind = "lan" | "tailscale" | "relay";

/** One route as used: `endpoint` is the direct `ws://…/machine/1` address, null for the relay. */
export interface MachineRouteUsed {
  kind: MachineRouteKind;
  endpoint: string | null;
}

export interface MachineRelayInfo {
  directorUrl: string;
  cellUrl: string;
  assignmentEpoch: number;
  relayHostId: string;
  relayDeviceId: string;
  /** The account that obtained the credential; the relay is used only while it is signed in. */
  userId: string;
}

/**
 * - `idle`: not attached; nothing touches the network.
 * - `connecting`: the first round of routes is being tried.
 * - `direct`: connected on this network or Tailscale (`route.kind` says which).
 * - `relay`: connected through TerminalX Relay.
 * - `reconnecting`: a link was lost less than 30 s ago.
 * - `offline`: no route answered for 30 s; it keeps retrying every 10 s at most.
 * - `needsUpdate`: the runtime does not serve `machine/1`, or refused `rpc.hello` with `update_required`; `side` says which computer updates.
 * - `updating`: the machine is handing its runtime over to a new version; a lost link is expected (PRO-354).
 * - `accessRemoved`: the machine refused this computer's credential; nothing retries until "Try again".
 *
 * `localNetworkDenied`: macOS refused Local Network access to a `lan` address.
 */
export type MachineConnectionState =
  | { state: "idle" }
  | { state: "connecting"; trying: MachineRouteKind[]; localNetworkDenied?: boolean }
  | {
      state: "direct" | "relay";
      route: MachineRouteUsed;
      /** When this link was established (ms since epoch). */
      since: number;
      /** End-to-end round trip of the last `machine.describe`; null until measured. */
      rttMs: number | null;
      localNetworkDenied?: boolean;
    }
  | {
      state: "reconnecting";
      /** When the link was lost (ms since epoch): "Lost it 12 seconds ago". */
      lostAt: number;
      attempt: number;
      retryInMs: number;
      trying: MachineRouteKind[];
      localNetworkDenied?: boolean;
    }
  | { state: "offline"; lastSeenAt: number | null; retryInMs: number; localNetworkDenied?: boolean }
  | {
      state: "needsUpdate";
      /** The machine's TerminalX version, when known. */
      version: string | null;
      /** Which side must update (PRO-354): the older machine, or this Mac when the machine is newer. */
      side: MachineUpdateSide;
    }
  | {
      /** The machine is handing its runtime over to a new version (PRO-354): "Updating · Back in under a minute". */
      state: "updating";
      version: string;
      since: number;
    }
  | { state: "accessRemoved" };

/** Which computer must update for the two to work together. */
export type MachineUpdateSide = "machine" | "thisMac";

/** `machines_connections` and the `machines_connection_changed` event. */
export interface MachineConnectionView {
  machineId: string;
  state: MachineConnectionState;
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

/**
 * Versions and updates (PRO-354, docs/MACHINES.md "Versions and updates").
 * `machine.updateStatus`, `machine.update` and `machine.updateChanged`
 * (`machine/3`) answer this shape.
 */

export type {
  MachineUpdateBlocker,
  MachineUpdateMethod,
  MachineUpdateOtherComputer,
  MachineUpdatePhase,
  MachineUpdateProgress,
  MachineUpdateRequest,
  MachineUpdateStatus,
} from "@terminalx/portable/workspace";

/** The window's report of its own updater run (`machines_app_update_report`). */
export interface MachineAppUpdateReport {
  phase: "checking" | "downloading" | "installing" | "restarting" | "upToDate" | "failed";
  step?: string | null;
  message?: string | null;
  /** The version this Mac's updater found: the machine's `available` for an app machine. */
  available?: string | null;
}

/** The Tauri event the desktop re-emits when another computer asks this Mac's app to update. */
export const MACHINES_APP_UPDATE_REQUESTED_EVENT = "machines_app_update_requested" as const;
