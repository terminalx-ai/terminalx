import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha256";
import { Gunzip } from "fflate";

/**
 * What the phone encrypts and decrypts for a cloud workspace, under the
 * workspace content key the runtime hands over the end-to-end encrypted
 * channel (`keys.get`). It mirrors `src-tauri/src/cloud_agents/crypto.rs`
 * byte for byte (terminalx-saas contract §13): AES-256-GCM, a 12-byte random
 * IV, the tag appended to the ciphertext, base64url without padding, and
 * additional data that is the compact JSON array naming what the ciphertext
 * belongs to. The server stores only ciphertext and never holds a key.
 */

export const KEY_LEN = 32;
export const IV_LEN = 12;
/** Command and receipt ciphertext limit (§11.1). */
export const MAX_COMMAND_CIPHERTEXT = 64 * 1024;
/** Decoded checkpoint ciphertext limit (§12). */
export const MAX_CHECKPOINT_CIPHERTEXT = 1024 * 1024;
/** A checkpoint never inflates past this, so a hostile one cannot exhaust memory. */
export const MAX_CHECKPOINT_PLAINTEXT = 8 * 1024 * 1024;
export const CHECKPOINT_SCHEMA = 1;

export class CloudCryptoError extends Error {
  constructor(readonly code: "decrypt-failed" | "invalid" | "too-large" | "integrity") {
    super(code);
    this.name = "CloudCryptoError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64(text: string): Uint8Array {
  const trimmed = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(trimmed)) throw new CloudCryptoError("invalid");
  const binary = atob(trimmed.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (trimmed.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function keyFromB64(text: string): Uint8Array {
  const key = unb64(text);
  if (key.length !== KEY_LEN) throw new CloudCryptoError("invalid");
  return key;
}

/** The compact JSON array, as `serde_json` writes it: no spaces, numbers as integers. */
const aad = (parts: (string | number)[]): Uint8Array => encoder.encode(JSON.stringify(parts));

export const commandAad = (organizationId: string, workspaceId: string, tabId: string, clientCommandId: string, kind: string, keyId: string) =>
  aad(["terminalx-agent-command/1", organizationId, workspaceId, tabId, clientCommandId, kind, keyId]);

export const receiptAad = (organizationId: string, workspaceId: string, clientCommandId: string, outcome: string, keyId: string) =>
  aad(["terminalx-agent-command-result/1", organizationId, workspaceId, clientCommandId, outcome, keyId]);

export const checkpointAad = (organizationId: string, workspaceId: string, tabId: string, epoch: number, version: number, schemaVersion: number, keyId: string) =>
  aad(["terminalx-transcript-checkpoint/1", organizationId, workspaceId, tabId, epoch, version, schemaVersion, keyId]);

/** `{ iv, ciphertext }`, both base64url. `iv` must be 12 fresh random bytes. */
export function seal(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, additional: Uint8Array): { iv: string; ciphertext: string } {
  if (key.length !== KEY_LEN || iv.length !== IV_LEN) throw new CloudCryptoError("invalid");
  return { iv: b64(iv), ciphertext: b64(gcm(key, iv, additional).encrypt(plaintext)) };
}

export function open(key: Uint8Array, iv: string, ciphertext: string | Uint8Array, additional: Uint8Array): Uint8Array {
  const nonce = unb64(iv);
  if (key.length !== KEY_LEN || nonce.length !== IV_LEN) throw new CloudCryptoError("invalid");
  try {
    return gcm(key, nonce, additional).decrypt(typeof ciphertext === "string" ? unb64(ciphertext) : ciphertext);
  } catch {
    // Wrong key, or the ciphertext or what it is bound to was changed.
    throw new CloudCryptoError("decrypt-failed");
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Inflate at most `limit` bytes. */
export function gunzip(bytes: Uint8Array, limit: number): Uint8Array {
  // A gzip stream: its magic number, the deflate method, and at least a header and a trailer.
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) throw new CloudCryptoError("invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const stream = new Gunzip((chunk) => {
    size += chunk.length;
    if (size > limit) throw new CloudCryptoError("too-large");
    chunks.push(chunk);
  });
  try {
    // Fed in pieces, so an oversized stream stops early instead of being inflated whole.
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) stream.push(bytes.subarray(offset, offset + 64 * 1024), offset + 64 * 1024 >= bytes.length);
  } catch (error) {
    if (error instanceof CloudCryptoError) throw error;
    throw new CloudCryptoError("invalid");
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A decrypted JSON object with `"v": 1`. */
export function parseV1(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new CloudCryptoError("invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { v?: unknown }).v !== 1) throw new CloudCryptoError("invalid");
  return value as Record<string, unknown>;
}

export type CommandKind = "send" | "steer" | "stop" | "permission-decision";

export interface CommandScope {
  organizationId: string;
  workspaceId: string;
}

/** The envelope posted to `agent-commands` (§11.1). It is kept and resent byte for byte: the same id is never encrypted twice. */
export interface CommandEnvelope {
  v: 1;
  clientCommandId: string;
  tabId: string;
  kind: CommandKind;
  keyId: string;
  iv: string;
  ciphertext: string;
}

export function sealCommand(input: { scope: CommandScope; tabId: string; clientCommandId: string; kind: CommandKind; payload: Record<string, unknown>; keyId: string; key: Uint8Array; iv: Uint8Array }): CommandEnvelope {
  const plaintext = encoder.encode(JSON.stringify({ ...input.payload, v: 1 }));
  const sealed = seal(input.key, input.iv, plaintext, commandAad(input.scope.organizationId, input.scope.workspaceId, input.tabId, input.clientCommandId, input.kind, input.keyId));
  if (unb64(sealed.ciphertext).length > MAX_COMMAND_CIPHERTEXT) throw new CloudCryptoError("too-large");
  return { v: 1, clientCommandId: input.clientCommandId, tabId: input.tabId, kind: input.kind, keyId: input.keyId, ...sealed };
}

export const RECEIPT_OUTCOMES = ["applied", "rejected", "outcome-unknown"] as const;
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];

export interface CommandReceipt extends Record<string, unknown> {
  outcome: ReceiptOutcome;
  category?: string;
}

/**
 * The runtime's receipt for a command. Its outcome is part of what the
 * ciphertext is bound to and is not sent in clear, so each outcome is tried,
 * with the command's own key first and then every other key held (the key
 * may have rotated in between). Null when none opens it.
 */
export function openReceipt(input: { scope: CommandScope; clientCommandId: string; resultIv: string; resultCiphertext: string; keys: { keyId: string; key: Uint8Array }[] }): CommandReceipt | null {
  for (const { keyId, key } of input.keys) {
    for (const outcome of RECEIPT_OUTCOMES) {
      try {
        const value = parseV1(open(key, input.resultIv, input.resultCiphertext, receiptAad(input.scope.organizationId, input.scope.workspaceId, input.clientCommandId, outcome, keyId)));
        return { ...value, outcome };
      } catch {
        // Not this outcome or key.
      }
    }
  }
  return null;
}

export interface CheckpointEnvelope {
  tabId: string;
  epoch: number;
  version: number;
  schemaVersion: number;
  keyId: string;
  iv: string;
  ciphertext: string;
  sha256: string;
}

/**
 * A transcript checkpoint, opened: the digest is checked first, then the
 * ciphertext under what it is bound to (workspace, tab, epoch, version), then
 * it is inflated within a limit. The result is the runtime's projection of
 * the tab (`{ v: 1, sessionId, tabId, status, events, … }`).
 */
export function openCheckpoint(scope: CommandScope, envelope: CheckpointEnvelope, key: Uint8Array): Record<string, unknown> {
  if (envelope.schemaVersion !== CHECKPOINT_SCHEMA) throw new CloudCryptoError("invalid");
  if (![envelope.epoch, envelope.version].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new CloudCryptoError("invalid");
  const ciphertext = unb64(envelope.ciphertext);
  if (ciphertext.length > MAX_CHECKPOINT_CIPHERTEXT) throw new CloudCryptoError("too-large");
  if (sha256Hex(ciphertext) !== envelope.sha256.toLowerCase()) throw new CloudCryptoError("integrity");
  const packed = open(key, envelope.iv, ciphertext, checkpointAad(scope.organizationId, scope.workspaceId, envelope.tabId, envelope.epoch, envelope.version, envelope.schemaVersion, envelope.keyId));
  return parseV1(gunzip(packed, MAX_CHECKPOINT_PLAINTEXT));
}
