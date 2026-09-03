import AsyncStorage from "@react-native-async-storage/async-storage";
import { x25519 } from "@noble/curves/ed25519";
import * as Crypto from "expo-crypto";
import { AUTH_CONFIG, type CloudSession } from "../auth/protocol";
import { readHosts, removeAutomaticHosts, removeHost } from "../store/hosts";
import { AccountPairingClient, type AccountHost } from "./account-client";
import { base64Url } from "./bytes";
import { ACCOUNT_PAIRING_CAPABILITY, PairingOfferSchema, hostIdForPublicKey } from "./contracts";
import { openAccountPairingEnvelope } from "./hpke";
import { clearInstallation, loadOrCreateInstallation, readInstallation, registrationProof, signGrantRequest } from "./installation";
import { pairFromOffer } from "./pair";

export type InstallationState = "ready" | "approval-required" | "reauthentication-required";
const LOGOUT_OUTBOX_KEY = "terminalx:account-pairing:logout-outbox:v1";
let pairingEpoch = 0;

export async function discoverMachines(session: CloudSession): Promise<{ hosts: AccountHost[]; installationState: InstallationState }> {
  const client = new AccountPairingClient(AUTH_CONFIG.sessionEndpoint, session);
  await flushPendingLogouts(client, session.user.userId);
  const identity = await loadOrCreateInstallation(session.user.userId);
  const registration = await client.registerInstallation(identity.clientInstallationId, await registrationProof(identity));
  if (registration.reauthenticationRequired || registration.installation.trustState !== "trusted") {
    return { hosts: [], installationState: registration.reauthenticationRequired ? "reauthentication-required" : "approval-required" };
  }
  const pairedKeys = new Set((await readHosts()).map((host) => host.publicKeyB64));
  return { hosts: (await client.hosts()).filter((host) => !pairedKeys.has(host.hostPublicKeyB64)), installationState: "ready" };
}

export async function pairDiscoveredMachine(session: CloudSession, host: AccountHost): Promise<void> {
  if (!host.capabilities.includes(ACCOUNT_PAIRING_CAPABILITY)) throw new Error("account_pairing_host_incompatible");
  if (!accountHostIdentityMatches(host)) throw new Error("account_pairing_host_key_mismatch");
  if (host.reachability !== "live") throw new Error("account_pairing_host_offline");
  const client = new AccountPairingClient(AUTH_CONFIG.sessionEndpoint, session);
  const operationEpoch = pairingEpoch;
  const identity = await loadOrCreateInstallation(session.user.userId);
  assertPairingCurrent(operationEpoch);
  const ephemeralPrivateKey = await Crypto.getRandomBytesAsync(32);
  const ephemeralPublicKey = base64Url(x25519.getPublicKey(ephemeralPrivateKey));
  const grantRequestId = Crypto.randomUUID();
  const nonce = base64Url(await Crypto.getRandomBytesAsync(24));
  const fields = [identity.userId, host.hostId, identity.clientInstallationId, grantRequestId, String(host.bindingGeneration), ephemeralPublicKey, nonce, "mobile"];
  let grant = await client.requestGrant({
    userId: identity.userId,
    hostId: host.hostId,
    clientInstallationId: identity.clientInstallationId,
    grantRequestId,
    bindingGeneration: host.bindingGeneration,
    clientEphemeralPublicKey: ephemeralPublicKey,
    nonce,
    requestedScope: "mobile",
    proofSignature: signGrantRequest(identity, fields),
  });
  while (operationEpoch === pairingEpoch && grant.state === "pending" && Date.parse(grant.expiresAt) > Date.now()) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    grant = await client.grant(grantRequestId, identity.clientInstallationId);
  }
  if (operationEpoch !== pairingEpoch || grant.state !== "granted" || !grant.envelope) throw new Error("account_pairing_grant_unavailable");
  try {
    const offer = PairingOfferSchema.parse(JSON.parse(new TextDecoder().decode(openAccountPairingEnvelope({ recipientPrivateKey: ephemeralPrivateKey, encapsulatedKey: grant.envelope.encapsulatedKey, ciphertext: grant.envelope.ciphertext, associatedData: grant.associatedData }))));
    if (offer.publicKeyB64 !== host.hostPublicKeyB64) throw new Error("account_pairing_host_key_mismatch");
    assertPairingCurrent(operationEpoch);
    await pairFromOffer({ offer, label: host.displayName, preferredHostId: host.hostId, provenance: { kind: "automatic", userId: identity.userId } });
    assertPairingCurrent(operationEpoch);
    await client.consume(grant, identity.userId);
  } catch (error) {
    await client.revoke(grant, identity.userId).catch(() => undefined);
    await removeHost(host.hostId).catch(() => undefined);
    throw error;
  }
}

export function accountHostIdentityMatches(host: AccountHost): boolean {
  return hostIdForPublicKey(host.hostPublicKeyB64) === host.hostId;
}

export async function signOutPairing(session: CloudSession): Promise<void> {
  pairingEpoch++;
  const identity = await readInstallation();
  if (identity?.userId === session.user.userId) {
    try {
      await new AccountPairingClient(AUTH_CONFIG.sessionEndpoint, session).logout(identity.clientInstallationId);
      await removePendingLogout(identity.clientInstallationId);
    } catch {
      await queuePendingLogout(identity.userId, identity.clientInstallationId);
    }
  }
  await removeAutomaticHosts(session.user.userId);
  await clearInstallation();
}

function assertPairingCurrent(epoch: number): void {
  if (epoch !== pairingEpoch) throw new Error("account_pairing_cancelled");
}

async function readPendingLogouts(): Promise<{ userId: string; clientInstallationId: string }[]> {
  try {
    const raw = await AsyncStorage.getItem(LOGOUT_OUTBOX_KEY);
    const values = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(values) ? values.filter((value): value is { userId: string; clientInstallationId: string } => !!value && typeof value === "object" && typeof (value as Record<string, unknown>).userId === "string" && typeof (value as Record<string, unknown>).clientInstallationId === "string") : [];
  } catch {
    return [];
  }
}

async function queuePendingLogout(userId: string, clientInstallationId: string): Promise<void> {
  const pending = await readPendingLogouts();
  await AsyncStorage.setItem(LOGOUT_OUTBOX_KEY, JSON.stringify([...pending.filter((item) => item.clientInstallationId !== clientInstallationId), { userId, clientInstallationId }]));
}

async function removePendingLogout(clientInstallationId: string): Promise<void> {
  await AsyncStorage.setItem(LOGOUT_OUTBOX_KEY, JSON.stringify((await readPendingLogouts()).filter((item) => item.clientInstallationId !== clientInstallationId)));
}

async function flushPendingLogouts(client: AccountPairingClient, userId: string): Promise<void> {
  for (const pending of (await readPendingLogouts()).filter((item) => item.userId === userId)) {
    await client.logout(pending.clientInstallationId).then(() => removePendingLogout(pending.clientInstallationId)).catch(() => undefined);
  }
}
