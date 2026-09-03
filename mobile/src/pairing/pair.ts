import { sha256 } from "@noble/hashes/sha256";
import { DeviceCredentialInstalledSchema, HostStatusSchema, PairingGetEndpointsResultSchema, hostIdForPublicKey, type PairingOffer } from "./contracts";
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
  if (!offer.relay) return pairDirect(args);
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
      const expectedMode = client.getTransport() === "direct" ? "authenticated-direct" : "relay-basis";
      if (installed.reqId !== reqId || installed.authorizationMode !== expectedMode) throw new Error("Relay credential install did not match this pairing attempt");
      endpointsResponse = await client.request("pairing.getEndpoints", { installReqId: reqId });
      if (!endpointsResponse.ok) throw new Error(`${endpointsResponse.refusal.code}: ${endpointsResponse.refusal.message}`);
      endpoints = PairingGetEndpointsResultSchema.parse(endpointsResponse.value);
      assertCommittedInstall(endpointsResponse.value, installed);
    }
    if (endpoints.installStatus?.state !== "committed") throw new Error("Relay credential install was not reconciled");
    const installed = endpoints.installStatus.result;
    if (!endpoints.relay) throw new Error("Desktop returned no relay endpoint after credential install");

    const host: StoredHost = {
      id: journal.metadata.preferredHostId ?? offer.pairedDeviceId ?? hostIdForPublicKey(offer.publicKeyB64)!,
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
  const candidates = [new RelayClient({ transport: "direct", endpoint: offer.endpoint, deviceToken: offer.deviceToken, desktopPublicKeyB64: offer.publicKeyB64 })];
  if (offer.relay.inviteExpiresAt > Date.now()) {
    candidates.push(new RelayClient({ relay: offer.relay, credential: offer.relay.inviteToken, credentialKind: "invite", deviceToken: offer.deviceToken, desktopPublicKeyB64: offer.publicKeyB64 }));
  }
  candidates.push(new RelayClient({ relay: offer.relay, credential: resumeToken, credentialKind: "resume", deviceToken: offer.deviceToken, desktopPublicKeyB64: offer.publicKeyB64 }));
  return firstConnected(candidates);
}

async function pairDirect(args: { offer: PairingOffer; label: string; preferredHostId?: string; provenance: StoredHost["provenance"] }): Promise<StoredHost> {
  const client = new RelayClient({ transport: "direct", endpoint: args.offer.endpoint, deviceToken: args.offer.deviceToken, desktopPublicKeyB64: args.offer.publicKeyB64 });
  try {
    await client.connect();
    const status = await client.request("status.get");
    if (!status.ok) throw new Error(`${status.refusal.code}: ${status.refusal.message}`);
    HostStatusSchema.parse(status.value);
    const host: StoredHost = {
      id: args.preferredHostId ?? args.offer.pairedDeviceId ?? hostIdForPublicKey(args.offer.publicKeyB64)!,
      label: args.label,
      publicKeyB64: args.offer.publicKeyB64,
      endpoint: args.offer.endpoint,
      lastConnectedAt: Date.now(),
      provenance: args.provenance,
    };
    await savePairedHost(host, { v: 1, deviceToken: args.offer.deviceToken });
    return host;
  } finally {
    client.close();
  }
}

function firstConnected(candidates: RelayClient[]): Promise<RelayClient> {
  return new Promise((resolve, reject) => {
    let failures = 0;
    let settled = false;
    let lastError: unknown;
    for (const candidate of candidates) {
      void candidate.connect().then(() => {
        if (settled) return candidate.close();
        settled = true;
        for (const other of candidates) if (other !== candidate) other.close();
        resolve(candidate);
      }).catch((error: unknown) => {
        lastError = error;
        failures++;
        if (!settled && failures === candidates.length) reject(lastError);
      });
    }
  });
}

function assertCommittedInstall(raw: unknown, installed: unknown): void {
  if (!raw || typeof raw !== "object") throw new Error("Relay credential install was not reconciled");
  const status = (raw as Record<string, unknown>).installStatus as Record<string, unknown> | undefined;
  if (!status || status.state !== "committed" || JSON.stringify(status.result) !== JSON.stringify(installed)) throw new Error("Relay credential install was not reconciled");
}
