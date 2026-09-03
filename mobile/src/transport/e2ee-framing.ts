import nacl from "tweetnacl";
import type { MobileE2EEDirection, MobileE2EEPayloadKind } from "./e2ee-contract";
import { concat } from "./e2ee-contract";

const NONCE_LENGTH = 24;
const SESSION_ID_LENGTH = 32;
const HEADER_LENGTH = SESSION_ID_LENGTH + 1 + 1 + 8;
const MAX_COUNTER = (1n << 64n) - 1n;

type FrameFields = {
  key: Uint8Array;
  sessionId: Uint8Array;
  direction: MobileE2EEDirection;
  payloadKind: MobileE2EEPayloadKind;
};

export function sealFrame(args: FrameFields & { payload: Uint8Array; counter: bigint }): Uint8Array {
  validate(args.key, args.sessionId, args.counter);
  const header = encodeHeader(args);
  const nonce = encodeNonce(args);
  return concat([nonce, nacl.secretbox(concat([header, args.payload]), nonce, args.key)]);
}

export function openFrame(args: FrameFields & { frame: Uint8Array; expectedCounter: bigint }): Uint8Array | null {
  validate(args.key, args.sessionId, args.expectedCounter);
  if (args.frame.length < NONCE_LENGTH + nacl.secretbox.overheadLength + HEADER_LENGTH) return null;
  const expected = { ...args, counter: args.expectedCounter };
  const nonce = encodeNonce(expected);
  if (!equal(args.frame.subarray(0, NONCE_LENGTH), nonce)) return null;
  const plaintext = nacl.secretbox.open(args.frame.subarray(NONCE_LENGTH), nonce, args.key);
  if (!plaintext || !equal(plaintext.subarray(0, HEADER_LENGTH), encodeHeader(expected))) return null;
  return plaintext.slice(HEADER_LENGTH);
}

function encodeHeader(args: Omit<FrameFields, "key"> & { counter: bigint }): Uint8Array {
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(args.sessionId);
  header[32] = args.direction === "mobile-to-desktop" ? 0 : 1;
  header[33] = args.payloadKind === "text" ? 0 : 1;
  writeUint64(header, 34, args.counter);
  return header;
}

function encodeNonce(args: Omit<FrameFields, "key"> & { counter: bigint }): Uint8Array {
  const nonce = new Uint8Array(NONCE_LENGTH);
  nonce.set(args.sessionId.subarray(0, 12));
  nonce[12] = 2;
  nonce[13] = args.direction === "mobile-to-desktop" ? 0 : 1;
  nonce[14] = args.payloadKind === "text" ? 0 : 1;
  writeUint64(nonce, 16, args.counter);
  return nonce;
}

function validate(key: Uint8Array, sessionId: Uint8Array, counter: bigint): void {
  if (key.length !== nacl.secretbox.keyLength) throw new Error(`Invalid E2EE v2 key length: ${key.length}`);
  if (sessionId.length !== SESSION_ID_LENGTH) throw new Error(`Invalid E2EE v2 session ID length: ${sessionId.length}`);
  if (counter < 0n || counter > MAX_COUNTER) throw new Error(`Invalid E2EE v2 counter: ${counter}`);
}

function writeUint64(target: Uint8Array, offset: number, value: bigint): void {
  let remaining = value;
  for (let index = 7; index >= 0; index--) {
    target[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
