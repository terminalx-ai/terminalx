import { z } from "zod";
import { sha256 } from "@noble/hashes/sha256";
import { base64Url } from "./bytes";

export const PAIRING_OFFER_VERSION = 2;
export const RELAY_PROTOCOL_VERSION = 1;
export const MOBILE_E2EE_VERSION = 2;
export const ACCOUNT_PAIRING_CAPABILITY = "account-bound-host-pairing.v1";
export const HEADLESS_PHONE_PAIRING_CAPABILITY = "headless-phone-pairing.v1";
export const ACCOUNT_PAIRING_HPKE_ALGORITHM = "HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305";
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
export const RECONNECT_TRICKLE_MS = 90_000;

export const canonicalHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return value.length <= 2_048 && url.protocol === "https:" && url.origin === value && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
};

export const canonicalRelayCellUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return value.length <= 2_048 && (url.protocol === "https:" || url.protocol === "wss:") && url.origin === value && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
};

/**
 * Whether a hostname refers to a local LAN, RFC1918/RFC6598 private address,
 * loopback, link-local, ULA IPv6, or mDNS `.local` address where cleartext `ws:`
 * is permitted for direct local pairing (S-46).
 */
export function isLanOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.endsWith(".local") && host.length > ".local".length) return true;
  if (/^(fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/i.test(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // RFC 6598 shared address space (Tailscale / CGNAT VPN direct endpoints).
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

const canonicalPublicKey = (value: string): boolean => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    const decoded = atob(value);
    return decoded.length === 32 && btoa(decoded) === value;
  } catch {
    return false;
  }
};

export const hostIdForPublicKey = (value: string): string | null => {
  if (!canonicalPublicKey(value)) return null;
  const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return base64Url(sha256(decoded)).slice(0, 16);
};

export const DirectEndpointsSchema = z.array(z.string().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.hash) return false;
    if (url.protocol === "wss:") return true;
    return url.protocol === "ws:" && isLanOrPrivateHost(url.hostname);
  } catch { return false; }
})).max(64);

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
      directEndpoints: DirectEndpointsSchema.optional(),
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
      const expectedHostId = hostIdForPublicKey(offer.publicKeyB64);
      if (!expectedHostId) context.addIssue({ code: "custom", path: ["publicKeyB64"], message: "Pairing offers require a canonical 32-byte public key" });
      else if (offer.relay && offer.relay.relayHostId !== expectedHostId) context.addIssue({ code: "custom", path: ["relay", "relayHostId"], message: "Relay host does not match the desktop public key" });
    });
}

export const PairingOfferSchema = createPairingOfferSchema();
export type PairingOffer = z.infer<typeof PairingOfferSchema>;
export type PairingRelay = NonNullable<PairingOffer["relay"]>;

export const HostStatusSchema = z
  .object({
    protocolVersion: z.literal(MOBILE_E2EE_VERSION),
    product: z.literal("TerminalX"),
    deviceScope: z.literal("driver"),
  })
  .strict();

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
    directEndpoints: DirectEndpointsSchema.optional(),
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

export type DeviceCredentialInstalled = z.infer<typeof DeviceCredentialInstalledSchema>;

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
    directEndpoints: DirectEndpointsSchema.optional(),
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
