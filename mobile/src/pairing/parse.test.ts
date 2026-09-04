import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { base64Url } from "./bytes";
import { parsePairingCode } from "./parse";

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

  it("rejects unknown fields and expired invites", () => {
    expect(parsePairingCode(encode({ ...offer, extra: true }), () => now)).toBeNull();
    expect(parsePairingCode(encode({ ...offer, relay: { ...offer.relay, inviteExpiresAt: now } }), () => now)).toBeNull();
  });

  it("rejects a relay host id that is not derived from the pinned desktop key", () => {
    expect(parsePairingCode(encode({ ...offer, relay: { ...offer.relay, relayHostId: "AbCdEf0123_-xyZ9" } }), () => now)).toBeNull();
  });
});
