import { sha256 } from "@noble/hashes/sha256";
import * as Crypto from "expo-crypto";
import { DeviceCredentialInstalledSchema, PairingEndpointsResultSchema, type PairingOffer } from "./contracts";
import { base64Url, utf8 } from "./bytes";
import { RelayClient } from "../transport/relay-client";
import { savePairedHost, type StoredHost } from "../store/hosts";

export async function pairFromOffer(args: {
  offer: PairingOffer;
  label: string;
  preferredHostId?: string;
  provenance: StoredHost["provenance"];
}): Promise<StoredHost> {
  const { offer } = args;
  if (!offer.relay) throw new Error("This desktop does not advertise relay pairing");
  const client = new RelayClient({
    relay: offer.relay,
    credential: offer.relay.inviteToken,
    credentialKind: "invite",
    deviceToken: offer.deviceToken,
    desktopPublicKeyB64: offer.publicKeyB64,
  });
  try {
    await client.connect();
    const status = await client.request("status.get");
    if (!status.ok) throw new Error(`${status.refusal.code}: ${status.refusal.message}`);

    const resumeToken = base64Url(await Crypto.getRandomBytesAsync(32));
    const resumeHash = base64Url(sha256(utf8(resumeToken)));
    const reqId = `install-${base64Url(await Crypto.getRandomBytesAsync(16))}`;
    const provision = await client.request("pairing.provisionRelay", { reqId, newResumeTokenHash: resumeHash });
    if (!provision.ok) throw new Error(`${provision.refusal.code}: ${provision.refusal.message}`);
    const installed = DeviceCredentialInstalledSchema.parse(provision.value);
    const endpointsResponse = await client.request("pairing.getEndpoints", { installReqId: reqId });
    if (!endpointsResponse.ok) throw new Error(`${endpointsResponse.refusal.code}: ${endpointsResponse.refusal.message}`);
    const endpoints = PairingEndpointsResultSchema.parse(endpointsResponse.value);
    assertCommittedInstall(endpointsResponse.value, installed);
    if (!endpoints.relay) throw new Error("Desktop returned no relay endpoint after credential install");

    const host: StoredHost = {
      id: args.preferredHostId ?? offer.pairedDeviceId ?? offer.relay.relayHostId,
      label: args.label,
      publicKeyB64: offer.publicKeyB64,
      endpoint: offer.endpoint,
      relay: endpoints.relay,
      lastConnectedAt: Date.now(),
      provenance: args.provenance,
    };
    await savePairedHost(host, {
      v: 1,
      deviceToken: offer.deviceToken,
      current: { token: resumeToken, hash: resumeHash, version: installed.currentVersion, expiresAt: installed.resumeExpiresAt },
    });
    return host;
  } finally {
    client.close();
  }
}

function assertCommittedInstall(raw: unknown, installed: unknown): void {
  if (!raw || typeof raw !== "object") throw new Error("Relay credential install was not reconciled");
  const status = (raw as Record<string, unknown>).installStatus as Record<string, unknown> | undefined;
  if (!status || status.state !== "committed" || JSON.stringify(status.result) !== JSON.stringify(installed)) throw new Error("Relay credential install was not reconciled");
}
