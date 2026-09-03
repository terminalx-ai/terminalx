import { sha256 } from "@noble/hashes/sha256";
import { DeviceCredentialInstalledSchema, HostStatusSchema, PairingGetEndpointsResultSchema, type PairingOffer } from "./contracts";
import { base64Url, utf8 } from "./bytes";
import { RelayClient } from "../transport/relay-client";
import { savePairedHost, type StoredHost } from "../store/hosts";
import { clearPairingJournal, createPairingJournal, journalMatchesOffer, offerFromJournal, readPairingJournal, type PairingJournal } from "./journal";

export async function pairFromOffer(args: {
  offer: PairingOffer;
  label: string;
  preferredHostId?: string;
  provenance: StoredHost["provenance"];
}): Promise<StoredHost> {
  const { offer } = args;
  if (!offer.relay) throw new Error("This desktop does not advertise relay pairing");
  const existing = await readPairingJournal();
  if (existing && !journalMatchesOffer(existing, offer)) await clearPairingJournal();
  const journal = existing && journalMatchesOffer(existing, offer) ? existing : await createPairingJournal({ ...args, offer: offer as PairingOffer & { relay: NonNullable<PairingOffer["relay"]> } });
  return finishPairing(journal);
}

export async function recoverPendingPairing(): Promise<StoredHost | null> {
  const journal = await readPairingJournal();
  return journal ? finishPairing(journal) : null;
}

async function finishPairing(journal: PairingJournal): Promise<StoredHost> {
  const offer = offerFromJournal(journal);
  const resumeToken = journal.secrets.pendingResumeToken;
  const resumeHash = base64Url(sha256(utf8(resumeToken)));
  let client: RelayClient | null = null;
  try {
    client = await connectPairingClient(offer, resumeToken);
    const status = await client.request("status.get");
    if (!status.ok) throw new Error(`${status.refusal.code}: ${status.refusal.message}`);
    HostStatusSchema.parse(status.value);
    const reqId = journal.metadata.installReqId;
    let endpointsResponse = await client.request("pairing.getEndpoints", { installReqId: reqId });
    if (!endpointsResponse.ok) throw new Error(`${endpointsResponse.refusal.code}: ${endpointsResponse.refusal.message}`);
    let endpoints = PairingGetEndpointsResultSchema.parse(endpointsResponse.value);
    if (endpoints.installStatus?.state !== "committed") {
      const provision = await client.request("pairing.provisionRelay", { reqId, newResumeTokenHash: resumeHash });
      if (!provision.ok) throw new Error(`${provision.refusal.code}: ${provision.refusal.message}`);
      const installed = DeviceCredentialInstalledSchema.parse(provision.value);
      if (installed.reqId !== reqId || installed.authorizationMode !== "relay-basis") throw new Error("Relay credential install did not match this pairing attempt");
      endpointsResponse = await client.request("pairing.getEndpoints", { installReqId: reqId });
      if (!endpointsResponse.ok) throw new Error(`${endpointsResponse.refusal.code}: ${endpointsResponse.refusal.message}`);
      endpoints = PairingGetEndpointsResultSchema.parse(endpointsResponse.value);
      assertCommittedInstall(endpointsResponse.value, installed);
    }
    if (endpoints.installStatus?.state !== "committed") throw new Error("Relay credential install was not reconciled");
    const installed = endpoints.installStatus.result;
    if (!endpoints.relay) throw new Error("Desktop returned no relay endpoint after credential install");

    const host: StoredHost = {
      id: journal.metadata.preferredHostId ?? offer.pairedDeviceId ?? offer.relay.relayHostId,
      label: journal.metadata.label,
      publicKeyB64: offer.publicKeyB64,
      endpoint: offer.endpoint,
      relay: endpoints.relay,
      lastConnectedAt: Date.now(),
      provenance: journal.metadata.provenance,
    };
    await savePairedHost(host, {
      v: 1,
      deviceToken: offer.deviceToken,
      current: { token: resumeToken, hash: resumeHash, version: installed.currentVersion, expiresAt: installed.resumeExpiresAt },
    });
    await clearPairingJournal();
    return host;
  } finally {
    client?.close();
  }
}

async function connectPairingClient(offer: PairingOffer & { relay: NonNullable<PairingOffer["relay"]> }, resumeToken: string): Promise<RelayClient> {
  const invite = new RelayClient({ relay: offer.relay, credential: offer.relay.inviteToken, credentialKind: "invite", deviceToken: offer.deviceToken, desktopPublicKeyB64: offer.publicKeyB64 });
  if (offer.relay.inviteExpiresAt > Date.now()) {
    try { await invite.connect(); return invite; } catch { invite.close(); }
  }
  const resume = new RelayClient({ relay: offer.relay, credential: resumeToken, credentialKind: "resume", deviceToken: offer.deviceToken, desktopPublicKeyB64: offer.publicKeyB64 });
  await resume.connect();
  return resume;
}

function assertCommittedInstall(raw: unknown, installed: unknown): void {
  if (!raw || typeof raw !== "object") throw new Error("Relay credential install was not reconciled");
  const status = (raw as Record<string, unknown>).installStatus as Record<string, unknown> | undefined;
  if (!status || status.state !== "committed" || JSON.stringify(status.result) !== JSON.stringify(installed)) throw new Error("Relay credential install was not reconciled");
}
