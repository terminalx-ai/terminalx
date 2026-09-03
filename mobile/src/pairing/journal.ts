import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { sha256 } from "@noble/hashes/sha256";
import { z } from "zod";
import type { StoredHost } from "../store/hosts";
import { base64Url, utf8 } from "./bytes";
import type { PairingOffer } from "./contracts";

const METADATA_KEY = "terminalx:mobile:pairing-journal:v1";
const SECRETS_KEY = "terminalx.mobile-pairing-journal.secrets.v1";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const provenanceSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("explicit") }), z.object({ kind: z.literal("automatic"), userId: z.string().min(1) })]);
const metadataSchema = z.object({
  v: z.literal(1),
  journalId: z.string().min(1).max(128),
  offerFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  installReqId: z.string().min(1).max(128),
  createdAt: z.number().int().nonnegative(),
  label: z.string().min(1),
  preferredHostId: z.string().min(1).optional(),
  provenance: provenanceSchema,
  offer: z.object({
    endpoint: z.string().min(1).max(16 * 1_024),
    publicKeyB64: z.string().min(1).max(4 * 1_024),
    pairedDeviceId: z.string().min(1).max(128).optional(),
    scope: z.enum(["mobile", "runtime", "session"]).optional(),
    identityMode: z.enum(["inherit", "authenticate"]).optional(),
    relay: z.object({
      v: z.literal(1),
      directorUrl: z.string().url(),
      cellUrl: z.string().url(),
      assignmentEpoch: z.number().int().nonnegative(),
      relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
      inviteExpiresAt: z.number().int().nonnegative(),
      e2eeFraming: z.literal(2),
    }).strict(),
  }).strict(),
}).strict();

const secretsSchema = z.object({
  v: z.literal(1),
  journalId: z.string().min(1).max(128),
  deviceToken: z.string().min(1),
  inviteToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  pendingResumeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export type PairingJournal = { metadata: z.infer<typeof metadataSchema>; secrets: z.infer<typeof secretsSchema> };

export async function createPairingJournal(args: { offer: PairingOffer & { relay: NonNullable<PairingOffer["relay"]> }; label: string; preferredHostId?: string; provenance: StoredHost["provenance"] }): Promise<PairingJournal> {
  const journalId = `pair-${base64Url(await Crypto.getRandomBytesAsync(16))}`;
  const { inviteToken, ...relay } = args.offer.relay;
  const metadata = metadataSchema.parse({
    v: 1,
    journalId,
    offerFingerprint: fingerprint(args.offer),
    installReqId: `install-${base64Url(await Crypto.getRandomBytesAsync(16))}`,
    createdAt: Date.now(),
    label: args.label,
    ...(args.preferredHostId ? { preferredHostId: args.preferredHostId } : {}),
    provenance: args.provenance,
    offer: { endpoint: args.offer.endpoint, publicKeyB64: args.offer.publicKeyB64, ...(args.offer.pairedDeviceId ? { pairedDeviceId: args.offer.pairedDeviceId } : {}), ...(args.offer.scope ? { scope: args.offer.scope } : {}), ...(args.offer.identityMode ? { identityMode: args.offer.identityMode } : {}), relay },
  });
  const secrets = secretsSchema.parse({ v: 1, journalId, deviceToken: args.offer.deviceToken, inviteToken, pendingResumeToken: base64Url(await Crypto.getRandomBytesAsync(32)) });
  // Secrets land first: a crash can leave an unreferenced Keychain item, but never metadata that points at missing credential material.
  await SecureStore.setItemAsync(SECRETS_KEY, JSON.stringify(secrets), OPTIONS);
  await AsyncStorage.setItem(METADATA_KEY, JSON.stringify(metadata));
  return { metadata, secrets };
}

export async function readPairingJournal(): Promise<PairingJournal | null> {
  try {
    const [metadataRaw, secretsRaw] = await Promise.all([AsyncStorage.getItem(METADATA_KEY), SecureStore.getItemAsync(SECRETS_KEY, OPTIONS)]);
    if (!metadataRaw || !secretsRaw) return null;
    const metadata = metadataSchema.parse(JSON.parse(metadataRaw));
    const secrets = secretsSchema.parse(JSON.parse(secretsRaw));
    return metadata.journalId === secrets.journalId ? { metadata, secrets } : null;
  } catch {
    return null;
  }
}

export async function clearPairingJournal(): Promise<void> {
  await Promise.all([AsyncStorage.removeItem(METADATA_KEY), SecureStore.deleteItemAsync(SECRETS_KEY, OPTIONS).catch(() => undefined)]);
}

export function journalMatchesOffer(journal: PairingJournal, offer: PairingOffer): boolean {
  return journal.metadata.offerFingerprint === fingerprint(offer);
}

export function offerFromJournal(journal: PairingJournal): PairingOffer & { relay: NonNullable<PairingOffer["relay"]> } {
  return { v: 2, ...journal.metadata.offer, deviceToken: journal.secrets.deviceToken, relay: { ...journal.metadata.offer.relay, inviteToken: journal.secrets.inviteToken } };
}

const fingerprint = (offer: PairingOffer) => base64Url(sha256(utf8(JSON.stringify(offer))));
