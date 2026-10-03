import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { base64Url } from "./bytes";
import { extractPairingNameFromUrl, parsePairingCode, parsePairingCodeOrThrow } from "./parse";

const now = 1_900_000_000_000;
const publicKey = new Uint8Array(32).fill(7);
const offer = {
  v: 2,
  endpoint: "wss://192.0.2.4:4040",
  deviceToken: "short-lived-device-token",
  publicKeyB64: btoa(String.fromCharCode(...publicKey)),
  scope: "mobile",
  identityMode: "authenticate",
  relay: {
    v: 1,
    directorUrl: "https://relay.terminalx.ai",
    cellUrl: "https://relay.terminalx.ai",
    assignmentEpoch: 3,
    relayHostId: base64Url(sha256(publicKey)).slice(0, 16),
    inviteToken: "A".repeat(43),
    inviteExpiresAt: now + 60_000,
    e2eeFraming: 2,
  },
};

const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("pairing payload parsing", () => {
  it("accepts the exact v2 relay offer as a code or TerminalX URL", () => {
    const code = encode(offer);
    expect(parsePairingCode(code, () => now)).toEqual(offer);
    expect(parsePairingCode(`terminalx://pair?code=${code}`, () => now)).toEqual(offer);
  });

  it("accepts a direct-only offer with the same pinned E2EE key", () => {
    const { relay: _, ...direct } = offer;
    expect(parsePairingCode(encode(direct), () => now)).toEqual(direct);
  });

  it("preserves bounded LAN, VPN and Bonjour candidates", () => {
    const updated = { ...offer, directEndpoints: ["ws://192.168.1.2:6768", "ws://100.93.49.78:6768", "ws://mac.local:6768"] };
    expect(parsePairingCode(encode(updated), () => now)).toEqual(updated);
    for (const directEndpoints of [["https://example.com"], ["ws://user:secret@mac.local"], Array(65).fill("ws://mac.local:6768")]) {
      expect(parsePairingCode(encode({ ...offer, directEndpoints }), () => now)).toBeNull();
    }
  });

  it("rejects unknown fields and expired invites", () => {
    expect(parsePairingCode(encode({ ...offer, extra: true }), () => now)).toBeNull();
    expect(parsePairingCode(encode({ ...offer, relay: { ...offer.relay, inviteExpiresAt: now } }), () => now)).toBeNull();
  });

  it("rejects a relay host id that is not derived from the pinned desktop key", () => {
    expect(parsePairingCode(encode({ ...offer, relay: { ...offer.relay, relayHostId: "AbCdEf0123_-xyZ9" } }), () => now)).toBeNull();
  });
});


describe("safe pairing parse errors", () => {
  it("distinguishes expiry from a malformed offer and gives a fresh-offer action", () => {
    expect(() => parsePairingCodeOrThrow(encode({ ...offer, relay: { ...offer.relay, inviteExpiresAt: now } }), () => now)).toThrow("[pairing:parsing/expired-offer]");
    expect(() => parsePairingCodeOrThrow("private-name or partial code", () => now)).toThrow("[pairing:parsing/invalid-offer]");
    expect(() => parsePairingCodeOrThrow(encode({ ...offer, unknownPrivateField: "secret" }), () => now)).toThrow("Generate a fresh offer");
    try { parsePairingCodeOrThrow(encode({ ...offer, unknownPrivateField: "secret" }), () => now); }
    catch (cause) { expect(String(cause)).not.toMatch(/unknownPrivateField|secret/); }
  });
});

// PRO-87: the computer's name rides beside the offer in the pairing link.
describe("the computer's name in a pairing link", () => {
  const link = `terminalx://pair?code=${encode(offer)}`;

  it("is read from the link, and a link without one or a bare code has none", () => {
    expect(extractPairingNameFromUrl(`${link}&name=Paresh%E2%80%99s+Mac+mini`)).toBe("Paresh’s Mac mini");
    expect(extractPairingNameFromUrl(`${link}&name=A%26B%20%3D%20C`)).toBe("A&B = C");
    expect(extractPairingNameFromUrl(link)).toBeNull();
    expect(extractPairingNameFromUrl(encode(offer))).toBeNull();
    expect(extractPairingNameFromUrl("https://example.com/?name=evil")).toBeNull();
    expect(extractPairingNameFromUrl(`terminalx://other?code=x&name=evil`)).toBeNull();
  });

  it("does not change what the offer is: the same offer parses with or without the name", () => {
    const named = `${link}&name=Paresh%E2%80%99s+Mac+mini`;
    expect(parsePairingCodeOrThrow(named, () => now)).toEqual(parsePairingCodeOrThrow(link, () => now));
    // A name is never taken for the code.
    expect(parsePairingCode(`terminalx://pair?name=${encode(offer)}`, () => now)).toBeNull();
  });
});
