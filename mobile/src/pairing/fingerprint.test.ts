import { sha256 } from "@noble/hashes/sha256";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes";
import { fingerprintForOffer, pairingFingerprint } from "./fingerprint";

const bytes = (value: number) => new Uint8Array(32).fill(value);
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));

describe("pairing fingerprint", () => {
  it("matches the contract's test vectors", () => {
    expect(pairingFingerprint(bytes(1), bytes(2), bytes(3))).toBe("CEF4·2468·FE26·9E4B");
    expect(pairingFingerprint(bytes(1), bytes(2), sha256(utf8("token-abc")))).toBe("6B3C·CA5D·54D0·FCB6");
  });

  it("depends on the order of the keys", () => {
    expect(pairingFingerprint(bytes(2), bytes(1), bytes(3))).not.toBe("CEF4·2468·FE26·9E4B");
  });

  it("is different for every pairing code, even for the same phone and Mac", () => {
    expect(pairingFingerprint(bytes(1), bytes(2), bytes(5))).not.toBe("CEF4·2468·FE26·9E4B");
  });

  it("derives the phone key from its secret key and reads the offer's host key and token", () => {
    const secret = new Uint8Array(32).fill(9);
    const phone = nacl.scalarMult.base(secret);
    const offer = { publicKeyB64: b64(bytes(1)), deviceToken: "token-abc" };
    expect(fingerprintForOffer(offer, secret)).toBe(pairingFingerprint(bytes(1), phone, sha256(utf8("token-abc"))));
    expect(fingerprintForOffer(offer, secret)).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}$/);
  });

  it("refuses inputs of the wrong length", () => {
    expect(() => pairingFingerprint(new Uint8Array(31), bytes(2), bytes(3))).toThrow();
    expect(() => pairingFingerprint(bytes(1), bytes(2), new Uint8Array(16))).toThrow();
  });
});
