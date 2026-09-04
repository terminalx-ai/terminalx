import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";

const KEY = "terminalx.mobile-e2ee-keypair.v1";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const StoredKeySchema = z.object({ v: z.literal(1), secretKeyB64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }).strict();

let keyPromise: Promise<Uint8Array> | null = null;

export function loadOrCreateE2EESecretKey(): Promise<Uint8Array> {
  keyPromise ??= loadOrCreate().catch((error: unknown) => {
    keyPromise = null;
    throw error;
  });
  return keyPromise.then((key) => new Uint8Array(key));
}

async function loadOrCreate(): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (stored) {
    const parsed = StoredKeySchema.safeParse(JSON.parse(stored));
    if (!parsed.success) throw new Error("The device E2EE key is unavailable. Reinstall TerminalX Mobile and pair again.");
    return decodeCanonicalKey(parsed.data.secretKeyB64);
  }
  const secretKey = new Uint8Array(await Crypto.getRandomBytesAsync(32));
  if (secretKey.length !== 32) throw new Error("Secure random generation returned an invalid E2EE key");
  await SecureStore.setItemAsync(KEY, JSON.stringify({ v: 1, secretKeyB64: encodeBase64(secretKey) }), OPTIONS);
  return secretKey;
}

function decodeCanonicalKey(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.length !== 32 || encodeBase64(bytes) !== value) throw new Error("The device E2EE key is invalid");
  return bytes;
}

function encodeBase64(value: Uint8Array): string {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
}
