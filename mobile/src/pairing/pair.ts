import { sha256 } from "@noble/hashes/sha256";
import { z } from "zod";
import {
  DeviceCredentialInstalledSchema,
  HostStatusSchema,
  PairingGetEndpointsResultSchema,
  hostIdForPublicKey,
  type DeviceCredentialInstalled,
  type PairingOffer,
} from "./contracts";
import { base64Url, utf8 } from "./bytes";
import { RelayClient } from "../transport/relay-client";
import { loadOrCreateE2EESecretKey } from "../transport/e2ee-keypair";
import { savePairedHost, type StoredHost } from "../store/hosts";
import {
  clearPairingJournal,
  createPairingJournal,
  journalMatchesOffer,
  offerFromJournal,
  readPairingJournal,
  type PairingJournal,
} from "./journal";
import { isSameInstalledCredential } from "./install-reconciliation";

type PairingCandidate = {
  client: RelayClient;
  path: "direct" | "relay";
  credentialKind: "direct" | "invite" | "resume";
};

const RelayResolvedSchema = z.object({
  v: z.literal(1),
  cellUrl: z.string().url(),
  assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  leaseExpiresAt: z.number().int().nonnegative(),
}).strict();

export async function pairFromOffer(args: {
  offer: PairingOffer;
  label: string;
  preferredHostId?: string;
  provenance: StoredHost["provenance"];
}): Promise<StoredHost> {
  const { offer } = args;
  const clientSecretKey = await loadOrCreateE2EESecretKey();
  if (!offer.relay) return pairDirect(args, clientSecretKey);
  const existing = await readPairingJournal();
  if (existing && !journalMatchesOffer(existing, offer)) await clearPairingJournal();
  if (existing && journalMatchesOffer(existing, offer)) return recoverPairing(existing, clientSecretKey);
  const journal = await createPairingJournal({
    ...args,
    offer: offer as PairingOffer & { relay: NonNullable<PairingOffer["relay"]> },
  });
  return finishNewPairing(journal, clientSecretKey);
}

export async function recoverPendingPairing(): Promise<StoredHost | null> {
  const journal = await readPairingJournal();
  return journal ? recoverPairing(journal, await loadOrCreateE2EESecretKey()) : null;
}

async function finishNewPairing(journal: PairingJournal, clientSecretKey: Uint8Array): Promise<StoredHost> {
  const offer = offerFromJournal(journal);
  const candidates: PairingCandidate[] = [directCandidate(offer, clientSecretKey)];
  if (offer.relay.inviteExpiresAt > Date.now()) candidates.push(inviteCandidate(offer, clientSecretKey));
  const winner = await firstVerified(candidates);
  try {
    const { installed, endpoints } = await provisionCredential(winner, journal);
    return publishCommitted(journal, installed, endpoints);
  } finally {
    winner.client.close();
  }
}

async function recoverPairing(journal: PairingJournal, clientSecretKey: Uint8Array): Promise<StoredHost> {
  const offer = offerFromJournal(journal);
  const candidates: (() => Promise<PairingCandidate>)[] = [
    async () => resumeCandidate(offer, journal.secrets.pendingResumeToken, clientSecretKey),
    async () => directCandidate(offer, clientSecretKey),
  ];
  if (offer.relay.inviteExpiresAt > Date.now()) candidates.push(async () => inviteCandidate(offer, clientSecretKey));

  let lastError: unknown = new Error("Pairing recovery has no usable credential");
  for (const createCandidate of candidates) {
    let candidate: PairingCandidate | null = null;
    try {
      candidate = await createCandidate();
      await verifyCandidate(candidate);
      const endpoints = await pairingEndpoints(candidate.client, journal.metadata.installReqId);
      if (endpoints.installStatus?.state === "committed") {
        return publishCommitted(journal, endpoints.installStatus.result, endpoints);
      }
      if (candidate.credentialKind !== "resume") {
        const provisioned = await provisionCredential(candidate, journal);
        return publishCommitted(journal, provisioned.installed, provisioned.endpoints);
      }
    } catch (cause) {
      lastError = cause;
    } finally {
      candidate?.client.close();
    }
  }
  throw lastError;
}

async function pairDirect(args: {
  offer: PairingOffer;
  label: string;
  preferredHostId?: string;
  provenance: StoredHost["provenance"];
}, clientSecretKey: Uint8Array): Promise<StoredHost> {
  const client = new RelayClient({
    transport: "direct",
    endpoint: args.offer.endpoint,
    deviceToken: args.offer.deviceToken,
    desktopPublicKeyB64: args.offer.publicKeyB64,
    clientSecretKey,
  });
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

function firstVerified(candidates: PairingCandidate[]): Promise<PairingCandidate> {
  return new Promise((resolve, reject) => {
    const successes: PairingCandidate[] = [];
    let failures = 0;
    let settled = false;
    let selectionQueued = false;
    let lastError: unknown;
    for (const candidate of candidates) {
      void verifyCandidate(candidate).then(() => {
        if (settled) return candidate.client.close();
        successes.push(candidate);
        if (selectionQueued) return;
        selectionQueued = true;
        queueMicrotask(() => {
          if (settled) return;
          settled = true;
          const winner = successes.find(({ path }) => path === "direct") ?? successes[0]!;
          for (const other of candidates) if (other !== winner) other.client.close();
          resolve(winner);
        });
      }).catch((error: unknown) => {
        candidate.client.close();
        lastError = error;
        failures++;
        if (!settled && failures === candidates.length && successes.length === 0) reject(lastError);
      });
    }
  });
}

async function verifyCandidate(candidate: PairingCandidate): Promise<void> {
  await candidate.client.connect();
  const status = await candidate.client.request("status.get");
  if (!status.ok) throw new Error(`${status.refusal.code}: ${status.refusal.message}`);
  HostStatusSchema.parse(status.value);
}

function directCandidate(offer: PairingOffer, clientSecretKey: Uint8Array): PairingCandidate {
  return {
    client: new RelayClient({
      transport: "direct",
      endpoint: offer.endpoint,
      deviceToken: offer.deviceToken,
      desktopPublicKeyB64: offer.publicKeyB64,
      clientSecretKey,
    }),
    path: "direct",
    credentialKind: "direct",
  };
}

function inviteCandidate(offer: PairingOffer & { relay: NonNullable<PairingOffer["relay"]> }, clientSecretKey: Uint8Array): PairingCandidate {
  return {
    client: new RelayClient({
      relay: offer.relay,
      credential: offer.relay.inviteToken,
      credentialKind: "invite",
      deviceToken: offer.deviceToken,
      desktopPublicKeyB64: offer.publicKeyB64,
      clientSecretKey,
    }),
    path: "relay",
    credentialKind: "invite",
  };
}

async function resumeCandidate(
  offer: PairingOffer & { relay: NonNullable<PairingOffer["relay"]> },
  resumeToken: string,
  clientSecretKey: Uint8Array,
): Promise<PairingCandidate> {
  const relay = await resolveResumeRelay(offer.relay, resumeToken).catch(() => offer.relay);
  return {
    client: new RelayClient({
      relay,
      credential: resumeToken,
      credentialKind: "resume",
      deviceToken: offer.deviceToken,
      desktopPublicKeyB64: offer.publicKeyB64,
      clientSecretKey,
    }),
    path: "relay",
    credentialKind: "resume",
  };
}

async function resolveResumeRelay(
  relay: NonNullable<PairingOffer["relay"]>,
  resumeToken: string,
): Promise<NonNullable<PairingOffer["relay"]>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(new URL("/v1/resolve", relay.directorUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, relayHostId: relay.relayHostId, resumeToken }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Relay director returned ${response.status}`);
    const raw = await response.text();
    if (new TextEncoder().encode(raw).length > 16 * 1_024) throw new Error("Relay director response was too large");
    const resolved = RelayResolvedSchema.parse(JSON.parse(raw));
    return { ...relay, cellUrl: resolved.cellUrl, assignmentEpoch: resolved.assignmentEpoch };
  } finally {
    clearTimeout(timeout);
  }
}

async function provisionCredential(candidate: PairingCandidate, journal: PairingJournal) {
  const resumeHash = base64Url(sha256(utf8(journal.secrets.pendingResumeToken)));
  const provision = await candidate.client.request("pairing.provisionRelay", {
    reqId: journal.metadata.installReqId,
    newResumeTokenHash: resumeHash,
  });
  if (!provision.ok) throw new Error(`${provision.refusal.code}: ${provision.refusal.message}`);
  const installed = DeviceCredentialInstalledSchema.parse(provision.value);
  const expectedMode = candidate.path === "direct" ? "authenticated-direct" : "relay-basis";
  if (installed.reqId !== journal.metadata.installReqId || installed.authorizationMode !== expectedMode) {
    throw new Error("Relay credential install did not match this pairing attempt");
  }
  const endpoints = await pairingEndpoints(candidate.client, journal.metadata.installReqId);
  assertCommittedInstall(endpoints.installStatus, installed);
  return { installed, endpoints };
}

async function pairingEndpoints(client: RelayClient, installReqId: string) {
  const response = await client.request("pairing.getEndpoints", { installReqId });
  if (!response.ok) throw new Error(`${response.refusal.code}: ${response.refusal.message}`);
  return PairingGetEndpointsResultSchema.parse(response.value);
}

async function publishCommitted(
  journal: PairingJournal,
  installed: DeviceCredentialInstalled,
  endpoints: Awaited<ReturnType<typeof pairingEndpoints>>,
): Promise<StoredHost> {
  if (!endpoints.relay) throw new Error("Desktop returned no relay endpoint after credential install");
  const offer = offerFromJournal(journal);
  const resumeToken = journal.secrets.pendingResumeToken;
  const resumeHash = base64Url(sha256(utf8(resumeToken)));
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
    current: {
      token: resumeToken,
      hash: resumeHash,
      version: installed.currentVersion,
      expiresAt: installed.resumeExpiresAt,
    },
  });
  await clearPairingJournal();
  return host;
}

function assertCommittedInstall(
  status: { state: "not-found" } | { state: "committed"; result: DeviceCredentialInstalled } | undefined,
  installed: DeviceCredentialInstalled,
): void {
  if (!status || status.state !== "committed" || !isSameInstalledCredential(status.result, installed)) {
    throw new Error("Relay credential install was not reconciled");
  }
}
