import { sha256 } from "@noble/hashes/sha256";
import * as Crypto from "expo-crypto";
import { DeviceCredentialInstalledSchema, PairingGetEndpointsResultSchema } from "../pairing/contracts";
import { base64Url, utf8 } from "../pairing/bytes";
import { updateStoredHost, writeHostCredential, type HostCredential, type StoredHost } from "../store/hosts";
import type { RelayClient } from "./relay-client";

const ROTATION_WINDOW_MS = 7 * 24 * 60 * 60_000;
type RelayHostCredential = HostCredential & { current: NonNullable<HostCredential["current"]> };

export async function rotateCredentialIfNeeded(args: { client: RelayClient; host: StoredHost; credential: HostCredential }): Promise<{ host: StoredHost; credential: RelayHostCredential }> {
  let credential = args.credential;
  if (!credential.current || !args.host.relay) throw new Error("Relay credential rotation requires a relay host");
  const current = credential.current;
  const malformedHash = current.hash !== hashCredential(current.token);
  if (!credential.pending && !malformedHash && current.expiresAt - Date.now() > ROTATION_WINDOW_MS) return { ...args, credential: { ...credential, current } };
  if (!credential.pending) {
    const token = base64Url(await Crypto.getRandomBytesAsync(32));
    credential = { ...credential, pending: { token, hash: hashCredential(token), reqId: `rotate-${base64Url(await Crypto.getRandomBytesAsync(16))}` } };
    await writeHostCredential(args.host.id, credential);
  }
  const pending = credential.pending!;
  let endpointResult = await getEndpoints(args.client, pending.reqId);
  if (!committed(endpointResult)) {
    const provision = await args.client.request("pairing.provisionRelay", { reqId: pending.reqId, newResumeTokenHash: pending.hash, expectedCurrentHash: current.hash });
    if (!provision.ok) throw new Error(`${provision.refusal.code}: ${provision.refusal.message}`);
    const installed = DeviceCredentialInstalledSchema.parse(provision.value);
    endpointResult = await getEndpoints(args.client, pending.reqId);
    if (!committed(endpointResult) || JSON.stringify(endpointResult.installStatus!.result) !== JSON.stringify(installed)) throw new Error("Relay credential rotation was not reconciled");
  }
  const installed = DeviceCredentialInstalledSchema.parse(endpointResult.installStatus!.result);
  if (!endpointResult.relay) throw new Error("Relay credential rotation returned no endpoint");
  const nextCredential: RelayHostCredential = {
    v: 1,
    deviceToken: credential.deviceToken,
    current: { token: pending.token, hash: pending.hash, version: installed.currentVersion, expiresAt: installed.resumeExpiresAt },
    ...(installed.graceExpiresAt ? { grace: { ...current, expiresAt: installed.graceExpiresAt } } : {}),
  };
  const nextHost: StoredHost = { ...args.host, relay: endpointResult.relay };
  await writeHostCredential(args.host.id, nextCredential);
  await updateStoredHost(nextHost);
  return { host: nextHost, credential: nextCredential };
}

function hashCredential(token: string): string { return base64Url(sha256(utf8(token))); }

async function getEndpoints(client: RelayClient, reqId: string): Promise<EndpointState> {
  const result = await client.request<unknown>("pairing.getEndpoints", { installReqId: reqId });
  if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.message}`);
  return PairingGetEndpointsResultSchema.parse(result.value);
}

type EndpointState = ReturnType<typeof PairingGetEndpointsResultSchema.parse>;

const committed = (value: EndpointState): value is EndpointState & { installStatus: { state: "committed"; result: unknown } } => value.installStatus?.state === "committed";
