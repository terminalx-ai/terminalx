/**
 * Wire contracts shared with the TerminalX companion and deployed relay.
 *
 * Relay messages are deliberately closed shapes. Adding a field is a protocol
 * change: deployed clients reject unknown relay fields instead of ignoring them.
 */

export const PAIRING_OFFER_VERSION = 2 as const;
export const RELAY_PROTOCOL_VERSION = 1 as const;
export const MOBILE_E2EE_VERSION = 2 as const;
export const ACCOUNT_PAIRING_CAPABILITY = "account-bound-host-pairing.v1" as const;
export const ACCOUNT_PAIRING_HPKE_ALGORITHM =
  "HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305" as const;

export type PairingScope = "mobile" | "runtime" | "session";
export type PairingIdentityMode = "inherit" | "authenticate";

export interface PairingRelayV1 {
  v: typeof RELAY_PROTOCOL_VERSION;
  directorUrl: string;
  cellUrl: string;
  assignmentEpoch: number;
  relayHostId: string;
  inviteToken: string;
  inviteExpiresAt: number;
  e2eeFraming: typeof MOBILE_E2EE_VERSION;
}

export interface PairingOfferV2 {
  v: typeof PAIRING_OFFER_VERSION;
  endpoint: string;
  deviceToken: string;
  publicKeyB64: string;
  pairedDeviceId?: string;
  scope?: PairingScope;
  identityMode?: PairingIdentityMode;
  relay?: PairingRelayV1;
}

export interface AccountPairingGrantRequest {
  userId: string;
  hostId: string;
  clientInstallationId: string;
  grantRequestId: string;
  bindingGeneration: number;
  installationGeneration: number;
  clientEphemeralPublicKey: string;
  associatedDataVersion: 1;
  associatedData: string;
  requestedScope: "mobile";
  expiresAt: string;
  state: string;
}

export interface AccountPairingEnvelopeV1 {
  bindingGeneration: number;
  version: 1;
  algorithm: typeof ACCOUNT_PAIRING_HPKE_ALGORITHM;
  encapsulatedKey: string;
  ciphertext: string;
}

export type MobileE2EETransport = "direct" | "relay";

export interface MobileE2EEContext {
  protocol: "terminalx-mobile-e2ee";
  initiator: "mobile";
  responder: "desktop";
  transport: MobileE2EETransport;
  relayHostId?: string;
}

export interface MobileE2EEHelloV2 {
  type: "e2ee_hello";
  v: typeof MOBILE_E2EE_VERSION;
  clientPublicKeyB64: string;
  clientNonceB64: string;
  capabilities: { framing: [2]; payloadKinds: ["text", "binary"] };
  context: MobileE2EEContext;
}

export interface MobileE2EEReadyV2 {
  type: "e2ee_ready";
  v: typeof MOBILE_E2EE_VERSION;
  desktopPublicKeyB64: string;
  clientNonceB64: string;
  desktopNonceB64: string;
  selection: { framing: 2; payloadKinds: ["text", "binary"] };
  context: MobileE2EEContext;
}

export interface MobileE2EEAuthV2 {
  type: "e2ee_auth";
  v: typeof MOBILE_E2EE_VERSION;
  transcriptHashB64: string;
  deviceToken: string;
}

export interface MobileE2EEAuthenticatedV2 {
  type: "e2ee_authenticated";
  v: typeof MOBILE_E2EE_VERSION;
  transcriptHashB64: string;
}

export type RelayHostControlInbound =
  | {
      type: "host-challenge";
      challengeId: string;
      relayEphemeralPublicKeyB64: string;
      nonceB64: string;
      ciphertextB64: string;
      expiresAt: number;
    }
  | {
      type: "host-hello-ack";
      v: 1;
      generation: number;
      controlResumeSecret: string;
      leaseExpiresAt: number;
      activeConnIds: string[];
      pendingConns: Array<{ connId: string; connTicket: string }>;
    }
  | {
      type: "conn-open";
      connId: string;
      connTicket: string;
      kind: "invite" | "resume";
      relayDeviceId: string;
      attachDeadlineMs: number;
    }
  | { type: "ping"; t: number }
  | { type: "drain"; graceMs: number; recovery: "resolve-director" }
  | { type: "invite-created"; reqId: string; inviteToken: string; expiresAt: number; maxAttempts: number }
  | { type: "device-revoked"; reqId: string }
  | { type: "control-error"; reqId?: string; code: string };

export type RelayHostControlOutbound =
  | {
      type: "host-hello";
      v: 1;
      relayHostId: string;
      assignmentEpoch: number;
      hostPublicKeyB64: string;
      appVersion: string;
      previousGeneration?: number;
      controlResumeSecret?: string;
    }
  | { type: "host-challenge-ack"; challengeId: string; proofB64: string }
  | { type: "pong"; t: number }
  | { type: "auth-refresh"; relayJwt: string }
  | { type: "invite-create"; reqId: string; relayDeviceId: string }
  | { type: "device-revoke"; reqId: string; relayDeviceId: string };

export interface RelayHostDataAuth {
  type: "host-data-auth";
  v: 1;
  connTicket: string;
  generation: number;
}

export interface RelayPhoneAuth {
  type: "relay-auth";
  v: 1;
  mode: "connect";
  credential: string;
}

export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
export const RECONNECT_TRICKLE_DELAY_MS = 90_000 as const;
