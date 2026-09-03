import { x25519 } from "@noble/curves/ed25519";
import * as Crypto from "expo-crypto";
import { AUTH_CONFIG, type CloudSession } from "../auth/protocol";
import { readHosts, removeAutomaticHosts } from "../store/hosts";
import { AccountPairingClient, type AccountHost } from "./account-client";
import { base64Url } from "./bytes";
import { ACCOUNT_PAIRING_CAPABILITY, PairingOfferSchema } from "./contracts";
import { openAccountPairingEnvelope } from "./hpke";
import { clearInstallation, loadOrCreateInstallation, registrationProof, signGrantRequest } from "./installation";
import { pairFromOffer } from "./pair";

export type InstallationState = "ready" | "approval-required" | "reauthentication-required";

export async function discoverMachines(session: CloudSession): Promise<{ hosts: AccountHost[]; installationState: InstallationState }> {
  const client = new AccountPairingClient(AUTH_CONFIG.sessionEndpoint, session);
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
  if (host.reachability !== "live") throw new Error("account_pairing_host_offline");
  const client = new AccountPairingClient(AUTH_CONFIG.sessionEndpoint, session);
  const identity = await loadOrCreateInstallation(session.user.userId);
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
  while (grant.state === "pending" && Date.parse(grant.expiresAt) > Date.now()) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    grant = await client.grant(grantRequestId, identity.clientInstallationId);
  }
  if (grant.state !== "granted" || !grant.envelope) throw new Error("account_pairing_grant_unavailable");
  try {
    const offer = PairingOfferSchema.parse(JSON.parse(new TextDecoder().decode(openAccountPairingEnvelope({ recipientPrivateKey: ephemeralPrivateKey, encapsulatedKey: grant.envelope.encapsulatedKey, ciphertext: grant.envelope.ciphertext, associatedData: grant.associatedData }))));
    if (offer.publicKeyB64 !== host.hostPublicKeyB64) throw new Error("account_pairing_host_key_mismatch");
    await pairFromOffer({ offer, label: host.displayName, preferredHostId: host.hostId, provenance: { kind: "automatic", userId: identity.userId } });
    await client.consume(grant, identity.userId);
  } catch (error) {
    await client.revoke(grant, identity.userId).catch(() => undefined);
    throw error;
  }
}

export async function signOutPairing(session: CloudSession): Promise<void> {
  const identity = await loadOrCreateInstallation(session.user.userId);
  await new AccountPairingClient(AUTH_CONFIG.sessionEndpoint, session).logout(identity.clientInstallationId).catch(() => undefined);
  await removeAutomaticHosts(session.user.userId);
  await clearInstallation();
}
