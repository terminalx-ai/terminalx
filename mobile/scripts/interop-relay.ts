import { randomBytes } from "node:crypto";
import { stdin } from "node:process";
import { sha256 } from "@noble/hashes/sha256";
import { DeviceCredentialInstalledSchema, PairingGetEndpointsResultSchema } from "../src/pairing/contracts";
import { base64Url, utf8 } from "../src/pairing/bytes";
import { parsePairingCode } from "../src/pairing/parse";
import { RelayClient } from "../src/transport/relay-client";

const encodedOffer = (await readStdin()).trim();
const offer = parsePairingCode(encodedOffer);
if (!offer?.relay) throw new Error("Expected one unexpired v2 relay pairing code on stdin");

const inviteClient = new RelayClient({ relay: offer.relay, credential: offer.relay.inviteToken, credentialKind: "invite", deviceToken: offer.deviceToken, desktopPublicKeyB64: offer.publicKeyB64 });
try {
  await inviteClient.connect();
  const first = await inviteClient.request("status.get");
  if (!first.ok) throw new Error(`status.get refused: ${first.refusal.code}`);

  const resumeToken = randomBytes(32).toString("base64url");
  const resumeHash = base64Url(sha256(utf8(resumeToken)));
  const reqId = `interop-${randomBytes(16).toString("base64url")}`;
  const provisioned = await inviteClient.request("pairing.provisionRelay", { reqId, newResumeTokenHash: resumeHash });
  if (!provisioned.ok) throw new Error(`pairing.provisionRelay refused: ${provisioned.refusal.code}`);
  const installed = DeviceCredentialInstalledSchema.parse(provisioned.value);
  const endpointResponse = await inviteClient.request("pairing.getEndpoints", { installReqId: reqId });
  if (!endpointResponse.ok) throw new Error(`pairing.getEndpoints refused: ${endpointResponse.refusal.code}`);
  const endpoints = PairingGetEndpointsResultSchema.parse(endpointResponse.value);
  if (!endpoints.relay) throw new Error("Desktop returned no resume relay endpoint");
  inviteClient.close();

  const resumeClient = new RelayClient({ relay: endpoints.relay, credential: resumeToken, credentialKind: "resume", credentialVersion: installed.currentVersion, deviceToken: offer.deviceToken, desktopPublicKeyB64: offer.publicKeyB64 });
  try {
    await resumeClient.connect();
    const frame = await resumeClient.request("status.get");
    if (!frame.ok) throw new Error(`resume status.get refused: ${frame.refusal.code}`);
    console.log(`Interop passed: relay v1, E2EE framing v2, resume credential version ${installed.currentVersion}, encrypted RPC response received.`);
  } finally {
    resumeClient.close();
  }
} finally {
  inviteClient.close();
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => { value += chunk; });
    stdin.on("end", () => resolve(value));
    stdin.on("error", reject);
  });
}
