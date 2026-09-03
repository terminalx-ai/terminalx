import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { ACCOUNT_PAIRING_CAPABILITY } from "./contracts";
import { base64Url, decodeBase64Url, utf8 } from "./bytes";

const KEY = "terminalx.account-pairing.installation.v1";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export interface InstallationIdentity {
  version: 1;
  userId: string;
  clientInstallationId: string;
  privateKey: string;
}

export async function loadOrCreateInstallation(userId: string): Promise<InstallationIdentity> {
  const existing = parseIdentity(await SecureStore.getItemAsync(KEY, OPTIONS));
  if (existing?.userId === userId) return existing;
  if (existing) throw new Error("account_pairing_identity_account_switch_required");
  const seed = await Crypto.getRandomBytesAsync(48);
  const identity: InstallationIdentity = { version: 1, userId, clientInstallationId: Crypto.randomUUID(), privateKey: base64Url(p256.utils.randomPrivateKey(seed)) };
  await SecureStore.setItemAsync(KEY, JSON.stringify(identity), OPTIONS);
  return identity;
}

export async function clearInstallation(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTIONS).catch(() => undefined);
}

export async function registrationProof(identity: InstallationIdentity) {
  const privateKey = decodeBase64Url(identity.privateKey);
  const publicKey = p256.getPublicKey(privateKey, false);
  const publicKeyJwk = { kty: "EC" as const, crv: "P-256" as const, x: base64Url(publicKey.slice(1, 33)), y: base64Url(publicKey.slice(33, 65)) };
  const thumbprint = base64Url(sha256(utf8(JSON.stringify({ crv: "P-256", kty: "EC", x: publicKeyJwk.x, y: publicKeyJwk.y }))));
  const proofNonce = base64Url(await Crypto.getRandomBytesAsync(24));
  const deviceLabel = "TerminalX Mobile";
  const platform = Platform.OS;
  const transcript = ["terminalx-client-installation-registration/v1", identity.userId, identity.clientInstallationId, thumbprint, deviceLabel, platform, ACCOUNT_PAIRING_CAPABILITY, proofNonce].join("\n");
  return { publicKeyJwk, deviceLabel, platform, capabilities: [ACCOUNT_PAIRING_CAPABILITY], proofNonce, proofSignature: base64Url(p256.sign(utf8(transcript), privateKey, { prehash: true }).toCompactRawBytes()) };
}

export function signGrantRequest(identity: InstallationIdentity, fields: string[]): string {
  return base64Url(p256.sign(utf8(["terminalx-pairing-grant-request/v1", ...fields].join("\n")), decodeBase64Url(identity.privateKey), { prehash: true }).toCompactRawBytes());
}

function parseIdentity(raw: string | null): InstallationIdentity | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<InstallationIdentity>;
    return value.version === 1 && typeof value.userId === "string" && typeof value.clientInstallationId === "string" && typeof value.privateKey === "string" && decodeBase64Url(value.privateKey).length === 32 ? value as InstallationIdentity : null;
  } catch {
    return null;
  }
}
