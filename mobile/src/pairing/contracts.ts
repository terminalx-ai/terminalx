import { z } from "zod";

export const PAIRING_OFFER_VERSION = 2;
export const RELAY_PROTOCOL_VERSION = 1;
export const MOBILE_E2EE_VERSION = 2;
export const ACCOUNT_PAIRING_CAPABILITY = "account-bound-host-pairing.v1";
export const ACCOUNT_PAIRING_HPKE_ALGORITHM = "HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305";
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
export const RECONNECT_TRICKLE_MS = 90_000;

const canonicalHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return value.length <= 2_048 && url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

const canonicalPublicKey = (value: string): boolean => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    const decoded = atob(value);
    return decoded.length === 32 && btoa(decoded) === value;
  } catch {
    return false;
  }
};

export function createPairingOfferSchema(now: () => number = Date.now) {
  const relay = z
    .object({
      v: z.literal(RELAY_PROTOCOL_VERSION),
      directorUrl: z.string().refine(canonicalHttpsOrigin),
      cellUrl: z.string().refine(canonicalHttpsOrigin),
      assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
      inviteToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      inviteExpiresAt: z
        .number()
        .int()
        .refine((value) => value > now() && value <= now() + 10 * 60_000 + 30_000),
      e2eeFraming: z.literal(MOBILE_E2EE_VERSION),
    })
    .strict();

  return z
    .object({
      v: z.literal(PAIRING_OFFER_VERSION),
      endpoint: z.string().min(1).max(16 * 1_024),
      deviceToken: z.string().min(1).max(64 * 1_024),
      publicKeyB64: z.string().min(1).max(4 * 1_024),
      pairedDeviceId: z.string().min(1).max(128).optional(),
      scope: z.enum(["mobile", "runtime", "session"]).optional(),
      identityMode: z.enum(["inherit", "authenticate"]).optional(),
      relay: relay.optional(),
    })
    .strict()
    .superRefine((offer, context) => {
      if (offer.relay && !canonicalPublicKey(offer.publicKeyB64)) {
        context.addIssue({ code: "custom", path: ["publicKeyB64"], message: "Relay offers require a canonical 32-byte public key" });
      }
    });
}

export const PairingOfferSchema = createPairingOfferSchema();
export type PairingOffer = z.infer<typeof PairingOfferSchema>;
export type PairingRelay = NonNullable<PairingOffer["relay"]>;

export const RelayPhoneHelloSchema = z.union([
  z.object({ type: z.literal("relay-hello"), ok: z.literal(false), code: z.number().int().min(4_000).max(4_999) }).strict(),
  z.object({ type: z.literal("relay-hello"), ok: z.literal(true), credentialKind: z.literal("invite"), leaseExpiresAt: z.number().int().nonnegative() }).strict(),
  z
    .object({
      type: z.literal("relay-hello"),
      ok: z.literal(true),
      credentialKind: z.literal("resume"),
      leaseExpiresAt: z.number().int().nonnegative(),
      acceptedCredentialVersion: z.number().int().positive(),
      acceptedAs: z.enum(["current", "grace"]),
      resumeExpiresAt: z.number().int().nonnegative(),
      graceExpiresAt: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

export const PairingEndpointsResultSchema = z
  .object({
    v: z.literal(1),
    relay: z
      .object({
        v: z.literal(1),
        directorUrl: z.string().refine(canonicalHttpsOrigin),
        cellUrl: z.string().refine(canonicalHttpsOrigin),
        assignmentEpoch: z.number().int().nonnegative(),
        relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
        e2eeFraming: z.literal(2),
      })
      .strict()
      .nullable(),
  })
  .passthrough();

export const DeviceCredentialInstalledSchema = z
  .object({
    v: z.literal(1),
    reqId: z.string().min(1).max(128),
    authorizationMode: z.enum(["relay-basis", "authenticated-direct"]),
    currentVersion: z.number().int().positive(),
    resumeExpiresAt: z.number().int().nonnegative(),
    graceExpiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const DeviceResumeConfirmedSchema = z
  .object({
    v: z.literal(1),
    reqId: z.string().min(1).max(128),
    currentVersion: z.number().int().positive(),
    acceptedAs: z.enum(["current", "grace"]),
    renewed: z.boolean(),
    resumeExpiresAt: z.number().int().nonnegative(),
    graceExpiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type DeviceResumeConfirmed = z.infer<typeof DeviceResumeConfirmedSchema>;

export const PairingGetEndpointsResultSchema = z
  .object({
    v: z.literal(1),
    relay: PairingEndpointsResultSchema.shape.relay,
    installStatus: z
      .union([
        z.object({ v: z.literal(1), reqId: z.string().min(1).max(128), state: z.literal("not-found") }).strict(),
        z.object({ v: z.literal(1), reqId: z.string().min(1).max(128), state: z.literal("committed"), result: DeviceCredentialInstalledSchema }).strict(),
      ])
      .optional(),
    resumeConfirmation: DeviceResumeConfirmedSchema.optional(),
  })
  .strict();
