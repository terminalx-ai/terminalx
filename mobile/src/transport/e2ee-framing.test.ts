import { describe, expect, it } from "vitest";
import { decodeAnyCanonicalBase64, decodeCanonicalBase64, encodeBase64, encodeHandshakeTranscript, validateHandshake, type MobileE2EEHello, type MobileE2EEReady } from "./e2ee-contract";
import { openFrame, sealFrame } from "./e2ee-framing";
import { deriveKeySchedule, MobileE2EESession } from "./e2ee-session";

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const repeated = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));

describe("relay E2EE v2 framing", () => {
  it("reuses the device client key while generating a fresh nonce per connection", () => {
    let nonce = 10;
    const random = { bytes: (length: number) => new Uint8Array(length).fill(nonce++) };
    const create = () => MobileE2EESession.create({
      desktopPublicKeyB64: repeated(3),
      transport: "direct",
      random,
      clientSecretKey: new Uint8Array(32).fill(9),
    }).hello;

    const first = create();
    const second = create();
    expect(first.clientPublicKeyB64).toBe(second.clientPublicKeyB64);
    expect(first.clientNonceB64).not.toBe(second.clientNonceB64);
  });

  it("matches the legacy normative transcript and key schedule", () => {
    const context = { protocol: "terminalx-mobile-e2ee" as const, initiator: "mobile" as const, responder: "desktop" as const, transport: "relay" as const, relayHostId: "AbCdEf0123_-xyZ9" };
    const hello: MobileE2EEHello = { type: "e2ee_hello", v: 2, clientPublicKeyB64: repeated(1), clientNonceB64: repeated(2), capabilities: { framing: [2], payloadKinds: ["text", "binary"] }, context };
    const ready: MobileE2EEReady = { type: "e2ee_ready", v: 2, desktopPublicKeyB64: repeated(3), clientNonceB64: repeated(2), desktopNonceB64: repeated(4), selection: { framing: 2, payloadKinds: ["text", "binary"] }, context };
    const handshake = validateHandshake(hello, ready)!;
    const transcript = encodeHandshakeTranscript(handshake);
    const schedule = deriveKeySchedule(new Uint8Array(32).fill(5), transcript, handshake.clientNonce, handshake.desktopNonce);
    expect(transcript).toHaveLength(1362);
    expect(hex(schedule.transcriptHash)).toBe("e5aefcbe977547916c2c4538eedd4c50c2b03156dd0ac57ce21d249f03819cc9");
    expect(hex(schedule.mobileToDesktopKey)).toBe("db1a8f4463da4e59efe16040978c36f4754b7c276552a345d73ba221f2e3c560");
    expect(hex(schedule.desktopToMobileKey)).toBe("d0270b96a99c58e19ae5c9d6b64f7f6e9ced4518db632637f356460baecaaab7");
    expect(hex(schedule.sessionId)).toBe("30212a647cdc2b86a51e1800a5084bf09063371734a239f9b40bb7958a04e2a1");
  });

  it("uses an exact-next counter and rejects replay, gaps, reflection, and kind confusion", () => {
    const key = new Uint8Array(32).fill(7);
    const sessionId = new Uint8Array(32).fill(8);
    const frame = sealFrame({ payload: new TextEncoder().encode("frame"), key, sessionId, direction: "mobile-to-desktop", payloadKind: "text", counter: 0n });
    expect(hex(frame.subarray(0, 24))).toBe("080808080808080808080808020000000000000000000000");
    const open = (overrides = {}) => openFrame({ frame, key, sessionId, direction: "mobile-to-desktop", payloadKind: "text", expectedCounter: 0n, ...overrides });
    expect(new TextDecoder().decode(open()!)).toBe("frame");
    expect(open({ expectedCounter: 1n })).toBeNull();
    expect(open({ direction: "desktop-to-mobile" as const })).toBeNull();
    expect(open({ payloadKind: "binary" as const })).toBeNull();
  });

  it("encodes and validates canonical base64 via Buffer without round-trip re-encoding (P-44)", () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 65_537]) {
      const full = new Uint8Array(length + 7);
      for (let i = 0; i < full.length; i++) full[i] = (i * 73 + 19) & 0xff;
      // Subarray with non-zero byteOffset verifies slice-safe Buffer view encoding.
      const slice = full.subarray(5, 5 + length);
      const encoded = encodeBase64(slice);
      expect(encoded).toBe(Buffer.from(slice).toString("base64"));
      const decoded = decodeAnyCanonicalBase64(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded).toEqual(slice);
      expect(decodeCanonicalBase64(encoded, length)).toEqual(slice);
    }

    // Reject non-canonical trailing bits, missing/extra padding, whitespace, and URL-safe alphabet.
    for (const invalid of [
      "AB==",          // trailing 4 bits non-zero (valid chars are [AQgw])
      "AAB=",          // trailing 2 bits non-zero (valid chars are [AEIMQUYcgkosw048])
      "AA",            // missing padding
      "AAA",           // missing padding
      "AAAA=",         // invalid length
      "AA=A",          // padding in middle
      " AAAA",         // whitespace
      "AAAA\n",        // trailing newline
      "ab-c",          // base64url '-'
      "ab_c",          // base64url '_'
    ]) {
      expect(decodeAnyCanonicalBase64(invalid)).toBeNull();
    }
    expect(decodeCanonicalBase64("AAAA", 1)).toBeNull();
    expect(decodeCanonicalBase64("AA==", 2)).toBeNull();
  });
});
