import { describe, expect, it } from "vitest";
import type {
  MobileE2EEHelloV2,
  PairingOfferV2,
  RelayHostControlOutbound,
} from "./pairing";

describe("pairing wire contracts", () => {
  it("keeps the version-2 offer compatible with the deployed companion", () => {
    const offer: PairingOfferV2 = {
      v: 2,
      endpoint: "ws://192.0.2.10:6768",
      deviceToken: "device-token",
      publicKeyB64: "A".repeat(43) + "=",
      pairedDeviceId: "device-id",
      scope: "mobile",
      identityMode: "inherit",
      relay: {
        v: 1,
        directorUrl: "https://relay.terminalx.ai",
        cellUrl: "https://cell.relay.terminalx.ai",
        assignmentEpoch: 4,
        relayHostId: "AbCdEf0123_-xyZ9",
        inviteToken: "i".repeat(43),
        inviteExpiresAt: 1_800_000_000_000,
        e2eeFraming: 2,
      },
    };

    expect(Object.keys(offer)).toEqual([
      "v",
      "endpoint",
      "deviceToken",
      "publicKeyB64",
      "pairedDeviceId",
      "scope",
      "identityMode",
      "relay",
    ]);
    expect(Object.keys(offer.relay!)).toEqual([
      "v",
      "directorUrl",
      "cellUrl",
      "assignmentEpoch",
      "relayHostId",
      "inviteToken",
      "inviteExpiresAt",
      "e2eeFraming",
    ]);
  });

  it("pins the exact E2EE v2 negotiation and relay hello shapes", () => {
    const hello: MobileE2EEHelloV2 = {
      type: "e2ee_hello",
      v: 2,
      clientPublicKeyB64: "A".repeat(43) + "=",
      clientNonceB64: "B".repeat(43) + "=",
      capabilities: { framing: [2], payloadKinds: ["text", "binary"] },
      context: {
        protocol: "terminalx-mobile-e2ee",
        initiator: "mobile",
        responder: "desktop",
        transport: "relay",
        relayHostId: "AbCdEf0123_-xyZ9",
      },
    };
    const hostHello: RelayHostControlOutbound = {
      type: "host-hello",
      v: 1,
      relayHostId: "AbCdEf0123_-xyZ9",
      assignmentEpoch: 4,
      hostPublicKeyB64: "A".repeat(43) + "=",
      appVersion: "0.1.0",
    };

    expect(hello.capabilities).toEqual({ framing: [2], payloadKinds: ["text", "binary"] });
    expect(Object.keys(hostHello)).toEqual([
      "type",
      "v",
      "relayHostId",
      "assignmentEpoch",
      "hostPublicKeyB64",
      "appVersion",
    ]);
  });
});
