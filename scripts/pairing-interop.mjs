#!/usr/bin/env node

// A deliberately small counterpart to the shipped mobile transport. It proves
// the public pairing contract without importing desktop internals or printing
// any credential material. Pass a pairing URL or bare code on stdin.

import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import nacl from "tweetnacl";
import WebSocket from "ws";

const input = (await readStdin()).trim();
if (!input) throw new Error("Pass a TerminalX pairing URL or code on stdin");
const offer = parseOffer(input);
const relay = offer.relay;
const transport = relay ? "relay" : "direct";
const endpoint = relay ? relaySocketUrl(relay) : offer.endpoint;
const socket = await openSocket(endpoint);

if (relay) {
  const accepted = nextText(socket);
  socket.send(JSON.stringify({ type: "relay-auth", v: 1, mode: "connect", credential: relay.inviteToken }));
  const hello = JSON.parse(await accepted);
  requireExactKeys(hello, ["type", "ok", "credentialKind", "leaseExpiresAt"]);
  if (hello.type !== "relay-hello" || hello.ok !== true || hello.credentialKind !== "invite") {
    throw new Error("Relay did not accept the one-time invite");
  }
}

const clientKey = nacl.box.keyPair();
const clientNonce = randomBytes(32);
const context = {
  protocol: "terminalx-mobile-e2ee",
  initiator: "mobile",
  responder: "desktop",
  transport,
  ...(relay ? { relayHostId: relay.relayHostId } : {}),
};
const hello = {
  type: "e2ee_hello",
  v: 2,
  clientPublicKeyB64: b64(clientKey.publicKey),
  clientNonceB64: b64(clientNonce),
  capabilities: { framing: [2], payloadKinds: ["text", "binary"] },
  context,
};
const readyFrame = nextText(socket);
socket.send(JSON.stringify(hello));
const ready = JSON.parse(await readyFrame);
validateReady(hello, ready, offer.publicKeyB64);

const transcript = encodeTranscript(hello, ready);
const transcriptHash = sha256(transcript);
const salt = sha256(concat(utf8("terminalx-mobile-e2ee/v2/salt\0"), clientNonce, fromB64(ready.desktopNonceB64)));
const info = concat(utf8("terminalx-mobile-e2ee/v2/session\0"), transcriptHash);
const shared = nacl.box.before(fromB64(offer.publicKeyB64), clientKey.secretKey);
const expanded = new Uint8Array(hkdfSync("sha256", shared, salt, info, 96));
const session = {
  mobileKey: expanded.slice(0, 32),
  desktopKey: expanded.slice(32, 64),
  sessionId: expanded.slice(64, 96),
  outbound: 0n,
  inbound: 0n,
};

const authenticatedFrame = nextText(socket);
sendEncrypted(socket, session, {
  type: "e2ee_auth",
  v: 2,
  transcriptHashB64: b64(transcriptHash),
  deviceToken: offer.deviceToken,
});
const authenticated = receiveEncrypted(await authenticatedFrame, session);
requireExactKeys(authenticated, ["type", "v", "transcriptHashB64"]);
if (
  authenticated.type !== "e2ee_authenticated" ||
  authenticated.v !== 2 ||
  authenticated.transcriptHashB64 !== b64(transcriptHash)
) {
  throw new Error("Desktop did not authenticate the transcript-bound device credential");
}

const status = await rpc(socket, session, "status.get");
if (!status.ok || status.result?.protocolVersion !== 2 || status.result?.product !== "TerminalX") {
  throw new Error("Encrypted status RPC failed");
}

let installMode = "not requested";
if (relay) {
  const reqId = randomUUID();
  const resumeToken = randomBytes(32);
  const installed = await rpc(socket, session, "pairing.provisionRelay", {
    reqId,
    newResumeTokenHash: b64url(sha256(resumeToken)),
  });
  if (!installed.ok || installed.result?.reqId !== reqId || installed.result?.v !== 1) {
    throw new Error(`Relay credential install failed: ${installed.error?.message ?? "invalid response"}`);
  }
  const endpoints = await rpc(socket, session, "pairing.getEndpoints", { installReqId: reqId });
  if (
    !endpoints.ok ||
    endpoints.result?.installStatus?.state !== "committed" ||
    endpoints.result?.relay?.relayHostId !== relay.relayHostId
  ) {
    throw new Error("Relay credential install could not be reconciled");
  }
  installMode = installed.result.authorizationMode;
  resumeToken.fill(0);
}

console.log(`Pairing passed over ${transport}: pinned host key, E2EE frame, status RPC, relay install ${installMode}.`);
console.log("Revoke the scripted device in Settings → Devices; waiting for its socket to close…");
await waitForClose(socket, 120_000);
console.log("Interop passed: revocation closed the live encrypted connection.");

async function rpc(socket, session, method, params) {
  const id = randomUUID();
  const responseFrame = nextText(socket);
  sendEncrypted(socket, session, { id, deviceToken: offer.deviceToken, method, ...(params === undefined ? {} : { params }) });
  const response = receiveEncrypted(await responseFrame, session);
  if (response.id !== id) throw new Error("Desktop returned an RPC response for another request");
  return response;
}

function sendEncrypted(socket, session, value) {
  const frame = sealFrame(utf8(JSON.stringify(value)), session.mobileKey, session.sessionId, 0, 0, session.outbound++);
  socket.send(b64(frame));
}

function receiveEncrypted(value, session) {
  const bytes = openFrame(fromB64(value), session.desktopKey, session.sessionId, 1, 0, session.inbound++);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function sealFrame(payload, key, sessionId, direction, kind, counter) {
  const nonce = frameNonce(sessionId, direction, kind, counter);
  const plaintext = concat(frameHeader(sessionId, direction, kind, counter), payload);
  return concat(nonce, nacl.secretbox(plaintext, nonce, key));
}

function openFrame(frame, key, sessionId, direction, kind, counter) {
  const nonce = frameNonce(sessionId, direction, kind, counter);
  if (!equal(frame.slice(0, 24), nonce)) throw new Error("Encrypted frame nonce did not match the ordered counter");
  const plaintext = nacl.secretbox.open(frame.slice(24), nonce, key);
  const header = frameHeader(sessionId, direction, kind, counter);
  if (!plaintext || !equal(plaintext.slice(0, header.length), header)) throw new Error("Encrypted frame authentication failed");
  return plaintext.slice(header.length);
}

function frameHeader(sessionId, direction, kind, counter) {
  return concat(sessionId, Uint8Array.of(direction, kind), u64(counter));
}

function frameNonce(sessionId, direction, kind, counter) {
  return concat(sessionId.slice(0, 12), Uint8Array.of(2, direction, kind, 0), u64(counter));
}

function validateReady(hello, ready, pinnedKey) {
  requireExactKeys(ready, ["type", "v", "desktopPublicKeyB64", "clientNonceB64", "desktopNonceB64", "selection", "context"]);
  if (
    ready.type !== "e2ee_ready" ||
    ready.v !== 2 ||
    ready.desktopPublicKeyB64 !== pinnedKey ||
    ready.clientNonceB64 !== hello.clientNonceB64 ||
    JSON.stringify(ready.selection) !== JSON.stringify({ framing: 2, payloadKinds: ["text", "binary"] }) ||
    JSON.stringify(ready.context) !== JSON.stringify(hello.context)
  ) {
    throw new Error("Desktop returned an invalid or unpinned E2EE handshake");
  }
  fromB64(ready.desktopNonceB64, 32);
}

function encodeTranscript(hello, ready) {
  const fields = [
    ["domain", utf8("terminalx-mobile-e2ee/v2/transcript")],
    ["mobile-to-desktop.type", utf8(hello.type)],
    ["mobile-to-desktop.version", u32(hello.v)],
    ["mobile-to-desktop.client-public-key", fromB64(hello.clientPublicKeyB64)],
    ["mobile-to-desktop.client-nonce", fromB64(hello.clientNonceB64)],
    ["mobile-to-desktop.capabilities.framing", numberList(hello.capabilities.framing)],
    ["mobile-to-desktop.capabilities.payload-kinds", stringList(hello.capabilities.payloadKinds)],
    ["mobile-to-desktop.context.protocol", utf8(hello.context.protocol)],
    ["mobile-to-desktop.context.initiator", utf8(hello.context.initiator)],
    ["mobile-to-desktop.context.responder", utf8(hello.context.responder)],
    ["mobile-to-desktop.context.transport", utf8(hello.context.transport)],
    ["mobile-to-desktop.context.relay-host-id", utf8(hello.context.relayHostId ?? "")],
    ["desktop-to-mobile.type", utf8(ready.type)],
    ["desktop-to-mobile.version", u32(ready.v)],
    ["desktop-to-mobile.desktop-public-key", fromB64(ready.desktopPublicKeyB64)],
    ["desktop-to-mobile.client-nonce-echo", fromB64(ready.clientNonceB64)],
    ["desktop-to-mobile.desktop-nonce", fromB64(ready.desktopNonceB64)],
    ["desktop-to-mobile.selection.framing", u32(ready.selection.framing)],
    ["desktop-to-mobile.selection.payload-kinds", stringList(ready.selection.payloadKinds)],
    ["desktop-to-mobile.context.protocol", utf8(ready.context.protocol)],
    ["desktop-to-mobile.context.initiator", utf8(ready.context.initiator)],
    ["desktop-to-mobile.context.responder", utf8(ready.context.responder)],
    ["desktop-to-mobile.context.transport", utf8(ready.context.transport)],
    ["desktop-to-mobile.context.relay-host-id", utf8(ready.context.relayHostId ?? "")],
  ];
  return concat(...fields.map(([name, value]) => concat(u32(utf8(name).length), utf8(name), u32(value.length), value)));
}

function parseOffer(value) {
  const trimmed = value.trim();
  const code = trimmed.includes("://") ? new URL(trimmed).searchParams.get("code") : trimmed;
  if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("Invalid pairing code");
  const offer = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  requireExactKeys(offer, ["v", "endpoint", "deviceToken", "publicKeyB64", "pairedDeviceId", "scope", "identityMode", ...(offer.relay ? ["relay"] : [])]);
  if (offer.v !== 2 || offer.scope !== "mobile" || !["inherit", "authenticate"].includes(offer.identityMode)) throw new Error("Unsupported pairing offer");
  fromB64(offer.publicKeyB64, 32);
  if (offer.relay) {
    requireExactKeys(offer.relay, ["v", "directorUrl", "cellUrl", "assignmentEpoch", "relayHostId", "inviteToken", "inviteExpiresAt", "e2eeFraming"]);
    if (offer.relay.v !== 1 || offer.relay.e2eeFraming !== 2 || offer.relay.inviteExpiresAt <= Date.now()) throw new Error("Invalid or expired relay offer");
    const derived = b64url(sha256(fromB64(offer.publicKeyB64))).slice(0, 16);
    if (derived !== offer.relay.relayHostId) throw new Error("Relay host id does not match the pinned host key");
  }
  return offer;
}

function relaySocketUrl(relay) {
  const url = new URL(relay.cellUrl);
  if (url.protocol !== "https:" || url.origin !== relay.cellUrl) throw new Error("Relay cell is not a canonical HTTPS origin");
  url.protocol = "wss:";
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`;
  return url.toString();
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 });
    const timer = setTimeout(() => reject(new Error("WebSocket connection timed out")), 15_000);
    socket.once("open", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function nextText(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket response timed out")), 30_000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      if (isBinary) reject(new Error("Expected a text WebSocket frame"));
      else resolve(data.toString());
    });
    socket.once("close", (code) => { clearTimeout(timer); reject(new Error(`WebSocket closed (${code})`)); });
  });
}

function waitForClose(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => reject(new Error("Timed out waiting for device revocation")), timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      const elapsed = Date.now() - startedAt;
      if (elapsed > timeoutMs) reject(new Error("Revocation did not close the socket in time"));
      else resolve();
    });
  });
}

function requireExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("JSON contract contained unexpected fields");
}

function numberList(values) { return concat(u32(values.length), ...values.map(u32)); }
function stringList(values) { return concat(u32(values.length), ...values.map((value) => concat(u32(utf8(value).length), utf8(value)))); }
function utf8(value) { return new TextEncoder().encode(value); }
function sha256(bytes) { return new Uint8Array(createHash("sha256").update(bytes).digest()); }
function b64(bytes) { return Buffer.from(bytes).toString("base64"); }
function b64url(bytes) { return Buffer.from(bytes).toString("base64url"); }
function fromB64(value, length) {
  if (typeof value !== "string" || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("Non-canonical base64 value");
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (length !== undefined && bytes.length !== length) throw new Error("Unexpected decoded byte length");
  return bytes;
}
function u32(value) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, false); return bytes; }
function u64(value) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, false); return bytes; }
function concat(...parts) { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; }
function equal(left, right) { return left.length === right.length && left.every((byte, index) => byte === right[index]); }
function readStdin() { return new Promise((resolve, reject) => { let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { value += chunk; }); process.stdin.on("end", () => resolve(value)); process.stdin.on("error", reject); }); }
