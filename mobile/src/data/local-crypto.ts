import * as SecureStore from "expo-secure-store";
import { b64, IV_LEN, KEY_LEN, open, seal, unb64 } from "../cloud/crypto";
import { secureRandom } from "../transport/random";

/**
 * Device-bound AES-256-GCM encryption for local-host data cached in `AsyncStorage`
 * (transcript chunks, saved session summaries, and unsent prompt drafts; S-48).
 *
 * The 256-bit key lives only in `SecureStore` under `WHEN_UNLOCKED_THIS_DEVICE_ONLY`,
 * so app-container backups or post-sign-out storage dumps cannot read cached local
 * conversations or drafts.
 */
export const LOCAL_STORAGE_KEY = "terminalx.local.storage.key.v1";
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedKey: Uint8Array | null = null;
let keyInFlight: Promise<Uint8Array> | null = null;

interface SealedEnvelope {
  v: 1;
  enc: "aes-256-gcm";
  iv: string;
  ct: string;
}

function aadFor(purpose: string): Uint8Array {
  return encoder.encode(JSON.stringify(["terminalx-local/1", purpose]));
}

export async function getLocalStorageKey(): Promise<Uint8Array> {
  if (cachedKey) return cachedKey;
  if (keyInFlight) return keyInFlight;
  const run = (async () => {
    const existing = await SecureStore.getItemAsync(LOCAL_STORAGE_KEY, SECURE_OPTIONS).catch(() => null);
    if (existing) {
      try {
        const decoded = unb64(existing);
        if (decoded.length === KEY_LEN) {
          cachedKey = decoded;
          return decoded;
        }
      } catch {
        // Damaged key entry: rotate to a fresh device-bound key below.
      }
    }
    const created = secureRandom.bytes(KEY_LEN);
    await SecureStore.setItemAsync(LOCAL_STORAGE_KEY, b64(created), SECURE_OPTIONS).catch(() => undefined);
    cachedKey = created;
    return created;
  })();
  keyInFlight = run.finally(() => {
    if (keyInFlight === run) keyInFlight = null;
  });
  return run;
}

/** Deletes the device-bound key from SecureStore and clears the in-memory cache (called on sign-out). */
export async function clearLocalStorageKey(): Promise<void> {
  cachedKey = null;
  keyInFlight = null;
  await SecureStore.deleteItemAsync(LOCAL_STORAGE_KEY, SECURE_OPTIONS).catch(() => undefined);
}

/** Resets only the in-memory key cache (for tests simulating app restart). */
export function resetLocalStorageKeyCacheForTests(): void {
  cachedKey = null;
  keyInFlight = null;
}

export function isSealedLocalEnvelope(raw: string): boolean {
  if (!raw.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(raw) as Partial<SealedEnvelope> | null;
    return !!parsed && parsed.v === 1 && parsed.enc === "aes-256-gcm" && typeof parsed.iv === "string" && typeof parsed.ct === "string";
  } catch {
    return false;
  }
}

export function sealLocalStringWithKey(key: Uint8Array, plaintext: string, purpose: string): string {
  const iv = secureRandom.bytes(IV_LEN);
  const { iv: ivB64, ciphertext } = seal(key, iv, encoder.encode(plaintext), aadFor(purpose));
  const envelope: SealedEnvelope = { v: 1, enc: "aes-256-gcm", iv: ivB64, ct: ciphertext };
  return JSON.stringify(envelope);
}

export async function sealLocalString(plaintext: string, purpose: string): Promise<string> {
  const key = await getLocalStorageKey();
  return sealLocalStringWithKey(key, plaintext, purpose);
}

export function openLocalStringWithKey(key: Uint8Array, raw: string, purpose: string): string | null {
  if (!raw.startsWith("{")) return null;
  let envelope: Partial<SealedEnvelope> | null;
  try {
    envelope = JSON.parse(raw) as Partial<SealedEnvelope> | null;
  } catch {
    return null;
  }
  if (!envelope || envelope.v !== 1 || envelope.enc !== "aes-256-gcm" || typeof envelope.iv !== "string" || typeof envelope.ct !== "string") {
    return null;
  }
  try {
    const decrypted = open(key, envelope.iv, envelope.ct, aadFor(purpose));
    return decoder.decode(decrypted);
  } catch {
    return null;
  }
}

export async function openLocalString(raw: string, purpose: string): Promise<string | null> {
  if (!isSealedLocalEnvelope(raw)) return null;
  const key = await getLocalStorageKey();
  return openLocalStringWithKey(key, raw, purpose);
}
