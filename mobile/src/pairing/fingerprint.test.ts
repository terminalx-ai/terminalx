import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { fingerprintForOffer, pairingFingerprint } from "./fingerprint";

describe("pairing fingerprint", () => {
  it("matches the contract's test vector", () => {
    expect(pairingFingerprint(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))).toBe("1177·11ED");
  });

  it("depends on the order of the keys", () => {
    expect(pairingFingerprint(new Uint8Array(32).fill(2), new Uint8Array(32).fill(1))).not.toBe("1177·11ED");
  });

  it("derives the phone key from its secret key and decodes the offer's host key", () => {
    const secret = new Uint8Array(32).fill(9);
    const phone = nacl.scalarMult.base(secret);
    const hostB64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
    expect(fingerprintForOffer(hostB64, secret)).toBe(pairingFingerprint(new Uint8Array(32).fill(1), phone));
    expect(fingerprintForOffer(hostB64, secret)).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
  });

  it("refuses keys of the wrong length", () => {
    expect(() => pairingFingerprint(new Uint8Array(31), new Uint8Array(32))).toThrow();
  });
});
