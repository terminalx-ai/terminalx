import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import nacl from "tweetnacl";
import { concat, decodeCanonicalBase64, encodeBase64, encodeHandshakeTranscript, validateHandshake, type MobileE2EEHello, type MobileE2EETransport } from "./e2ee-contract";
import { openFrame, sealFrame } from "./e2ee-framing";

const SALT_LABEL = new TextEncoder().encode("terminalx-mobile-e2ee/v2/salt\0");
const INFO_LABEL = new TextEncoder().encode("terminalx-mobile-e2ee/v2/session\0");

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export class MobileE2EESession {
  readonly hello: MobileE2EEHello;
  private readonly secretKey: Uint8Array;
  private readonly pinnedDesktopKey: Uint8Array;
  private schedule: KeySchedule | null = null;
  private inboundCounter = 0n;
  private outboundCounter = 0n;

  private constructor(secretKey: Uint8Array, desktopKey: Uint8Array, hello: MobileE2EEHello) {
    this.secretKey = secretKey;
    this.pinnedDesktopKey = desktopKey;
    this.hello = hello;
  }

  static create(args: { desktopPublicKeyB64: string; transport: MobileE2EETransport; relayHostId?: string; random: RandomSource }): MobileE2EESession {
    const secretKey = new Uint8Array(args.random.bytes(32));
    const publicKey = nacl.scalarMult.base(secretKey);
    const clientNonce = new Uint8Array(args.random.bytes(32));
    if (secretKey.length !== 32 || clientNonce.length !== 32) throw new Error("Secure random source returned an invalid length");
    const desktopKey = decodeCanonicalBase64(args.desktopPublicKeyB64, 32);
    if (!desktopKey) throw new Error("Invalid desktop public key");
    const context = {
      protocol: "terminalx-mobile-e2ee" as const,
      initiator: "mobile" as const,
      responder: "desktop" as const,
      transport: args.transport,
      ...(args.relayHostId ? { relayHostId: args.relayHostId } : {}),
    };
    return new MobileE2EESession(secretKey, desktopKey, {
      type: "e2ee_hello",
      v: 2,
      clientPublicKeyB64: encodeBase64(publicKey),
      clientNonceB64: encodeBase64(clientNonce),
      capabilities: { framing: [2], payloadKinds: ["text", "binary"] },
      context,
    });
  }

  acceptReady(value: unknown): boolean {
    const handshake = validateHandshake(this.hello, value);
    if (!handshake || !equal(handshake.desktopPublicKey, this.pinnedDesktopKey)) return false;
    const sharedSecret = nacl.box.before(new Uint8Array(this.pinnedDesktopKey), new Uint8Array(this.secretKey));
    this.schedule = deriveKeySchedule(sharedSecret, encodeHandshakeTranscript(handshake), handshake.clientNonce, handshake.desktopNonce);
    return true;
  }

  get transcriptHashB64(): string {
    if (!this.schedule) throw new Error("E2EE v2 ready has not been accepted");
    return encodeBase64(this.schedule.transcriptHash);
  }

  sealText(plaintext: string): string {
    if (!this.schedule) throw new Error("E2EE v2 ready has not been accepted");
    const frame = sealFrame({ payload: new TextEncoder().encode(plaintext), key: this.schedule.mobileToDesktopKey, sessionId: this.schedule.sessionId, direction: "mobile-to-desktop", payloadKind: "text", counter: this.outboundCounter });
    this.outboundCounter++;
    return encodeBase64(frame);
  }

  openText(frameB64: string): string | null {
    if (!this.schedule) return null;
    const frame = decodeAnyCanonicalBase64(frameB64);
    if (!frame) return null;
    const plaintext = openFrame({ frame, key: this.schedule.desktopToMobileKey, sessionId: this.schedule.sessionId, direction: "desktop-to-mobile", payloadKind: "text", expectedCounter: this.inboundCounter });
    if (!plaintext) return null;
    this.inboundCounter++;
    return new TextDecoder().decode(plaintext);
  }

  sealBinary(plaintext: Uint8Array): Uint8Array {
    if (!this.schedule) throw new Error("E2EE v2 ready has not been accepted");
    const frame = sealFrame({ payload: plaintext, key: this.schedule.mobileToDesktopKey, sessionId: this.schedule.sessionId, direction: "mobile-to-desktop", payloadKind: "binary", counter: this.outboundCounter });
    this.outboundCounter++;
    return frame;
  }

  openBinary(frame: Uint8Array): Uint8Array | null {
    if (!this.schedule) return null;
    const plaintext = openFrame({ frame, key: this.schedule.desktopToMobileKey, sessionId: this.schedule.sessionId, direction: "desktop-to-mobile", payloadKind: "binary", expectedCounter: this.inboundCounter });
    if (plaintext) this.inboundCounter++;
    return plaintext;
  }
}

interface KeySchedule {
  mobileToDesktopKey: Uint8Array;
  desktopToMobileKey: Uint8Array;
  sessionId: Uint8Array;
  transcriptHash: Uint8Array;
}

export function deriveKeySchedule(sharedSecret: Uint8Array, transcript: Uint8Array, clientNonce: Uint8Array, desktopNonce: Uint8Array): KeySchedule {
  if (sharedSecret.length !== 32 || clientNonce.length !== 32 || desktopNonce.length !== 32) throw new Error("Invalid E2EE v2 key material");
  const transcriptHash = sha256(transcript);
  const salt = sha256(concat([SALT_LABEL, clientNonce, desktopNonce]));
  const expanded = hkdf(sha256, sharedSecret, salt, concat([INFO_LABEL, transcriptHash]), 96);
  return { mobileToDesktopKey: expanded.slice(0, 32), desktopToMobileKey: expanded.slice(32, 64), sessionId: expanded.slice(64, 96), transcriptHash };
}

function decodeAnyCanonicalBase64(value: string): Uint8Array | null {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return encodeBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
