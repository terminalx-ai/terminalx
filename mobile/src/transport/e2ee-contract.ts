export type MobileE2EETransport = "direct" | "relay";
export type MobileE2EEPayloadKind = "text" | "binary";
export type MobileE2EEDirection = "mobile-to-desktop" | "desktop-to-mobile";

export interface MobileE2EEContext {
  protocol: "terminalx-mobile-e2ee";
  initiator: "mobile";
  responder: "desktop";
  transport: MobileE2EETransport;
  relayHostId?: string;
}

export interface MobileE2EEHello {
  type: "e2ee_hello";
  v: 2;
  clientPublicKeyB64: string;
  clientNonceB64: string;
  capabilities: { framing: [2]; payloadKinds: ["text", "binary"] };
  context: MobileE2EEContext;
}

export interface MobileE2EEReady {
  type: "e2ee_ready";
  v: 2;
  desktopPublicKeyB64: string;
  clientNonceB64: string;
  desktopNonceB64: string;
  selection: { framing: 2; payloadKinds: ["text", "binary"] };
  context: MobileE2EEContext;
}

export interface MobileE2EEHandshake {
  hello: MobileE2EEHello;
  ready: MobileE2EEReady;
  clientPublicKey: Uint8Array;
  desktopPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  desktopNonce: Uint8Array;
}

export function validateHandshake(helloValue: unknown, readyValue: unknown): MobileE2EEHandshake | null {
  if (!isExactRecord(helloValue, ["type", "v", "clientPublicKeyB64", "clientNonceB64", "capabilities", "context"])) return null;
  if (!isExactRecord(readyValue, ["type", "v", "desktopPublicKeyB64", "clientNonceB64", "desktopNonceB64", "selection", "context"])) return null;
  if (helloValue.type !== "e2ee_hello" || helloValue.v !== 2 || readyValue.type !== "e2ee_ready" || readyValue.v !== 2) return null;
  if (!exactCapabilities(helloValue.capabilities) || !exactSelection(readyValue.selection)) return null;
  const helloContext = parseContext(helloValue.context);
  const readyContext = parseContext(readyValue.context);
  if (!helloContext || !readyContext || !contextsEqual(helloContext, readyContext)) return null;
  if (readyValue.clientNonceB64 !== helloValue.clientNonceB64) return null;
  const clientPublicKey = decodeCanonicalBase64(helloValue.clientPublicKeyB64, 32);
  const desktopPublicKey = decodeCanonicalBase64(readyValue.desktopPublicKeyB64, 32);
  const clientNonce = decodeCanonicalBase64(helloValue.clientNonceB64, 32);
  const desktopNonce = decodeCanonicalBase64(readyValue.desktopNonceB64, 32);
  if (!clientPublicKey || !desktopPublicKey || !clientNonce || !desktopNonce) return null;
  return { hello: helloValue as unknown as MobileE2EEHello, ready: readyValue as unknown as MobileE2EEReady, clientPublicKey, desktopPublicKey, clientNonce, desktopNonce };
}

export function encodeHandshakeTranscript(handshake: MobileE2EEHandshake): Uint8Array {
  const { hello, ready } = handshake;
  const fields: [string, Uint8Array][] = [
    ["domain", utf8("terminalx-mobile-e2ee/v2/transcript")],
    ["mobile-to-desktop.type", utf8(hello.type)],
    ["mobile-to-desktop.version", uint32(hello.v)],
    ["mobile-to-desktop.client-public-key", handshake.clientPublicKey],
    ["mobile-to-desktop.client-nonce", handshake.clientNonce],
    ["mobile-to-desktop.capabilities.framing", encodeNumberList(hello.capabilities.framing)],
    ["mobile-to-desktop.capabilities.payload-kinds", encodeStringList(hello.capabilities.payloadKinds)],
    ["mobile-to-desktop.context.protocol", utf8(hello.context.protocol)],
    ["mobile-to-desktop.context.initiator", utf8(hello.context.initiator)],
    ["mobile-to-desktop.context.responder", utf8(hello.context.responder)],
    ["mobile-to-desktop.context.transport", utf8(hello.context.transport)],
    ["mobile-to-desktop.context.relay-host-id", utf8(hello.context.relayHostId ?? "")],
    ["desktop-to-mobile.type", utf8(ready.type)],
    ["desktop-to-mobile.version", uint32(ready.v)],
    ["desktop-to-mobile.desktop-public-key", handshake.desktopPublicKey],
    ["desktop-to-mobile.client-nonce-echo", handshake.clientNonce],
    ["desktop-to-mobile.desktop-nonce", handshake.desktopNonce],
    ["desktop-to-mobile.selection.framing", uint32(ready.selection.framing)],
    ["desktop-to-mobile.selection.payload-kinds", encodeStringList(ready.selection.payloadKinds)],
    ["desktop-to-mobile.context.protocol", utf8(ready.context.protocol)],
    ["desktop-to-mobile.context.initiator", utf8(ready.context.initiator)],
    ["desktop-to-mobile.context.responder", utf8(ready.context.responder)],
    ["desktop-to-mobile.context.transport", utf8(ready.context.transport)],
    ["desktop-to-mobile.context.relay-host-id", utf8(ready.context.relayHostId ?? "")],
  ];
  return concat(fields.map(([name, value]) => concat([uint32(utf8(name).length), utf8(name), uint32(value.length), value])));
}

export function encodeBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export function decodeCanonicalBase64(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== "string" || value.length !== Math.ceil(length / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.length === length && encodeBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const utf8 = (value: string) => new TextEncoder().encode(value);
const uint32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};
const encodeNumberList = (values: readonly number[]) => concat([uint32(values.length), ...values.map(uint32)]);
const encodeStringList = (values: readonly string[]) => concat([uint32(values.length), ...values.map((value) => concat([uint32(utf8(value).length), utf8(value)]))]);

function parseContext(value: unknown): MobileE2EEContext | null {
  if (!isRecord(value)) return null;
  const transport = value.transport;
  const keys = transport === "relay" ? ["protocol", "initiator", "responder", "transport", "relayHostId"] : ["protocol", "initiator", "responder", "transport"];
  if (!isExactRecord(value, keys) || value.protocol !== "terminalx-mobile-e2ee" || value.initiator !== "mobile" || value.responder !== "desktop" || (transport !== "direct" && transport !== "relay")) return null;
  if (transport === "relay" && (typeof value.relayHostId !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(value.relayHostId))) return null;
  return value as unknown as MobileE2EEContext;
}

const exactCapabilities = (value: unknown) => isExactRecord(value, ["framing", "payloadKinds"]) && Array.isArray(value.framing) && value.framing.length === 1 && value.framing[0] === 2 && Array.isArray(value.payloadKinds) && value.payloadKinds.length === 2 && value.payloadKinds[0] === "text" && value.payloadKinds[1] === "binary";
const exactSelection = (value: unknown) => isExactRecord(value, ["framing", "payloadKinds"]) && value.framing === 2 && Array.isArray(value.payloadKinds) && value.payloadKinds.length === 2 && value.payloadKinds[0] === "text" && value.payloadKinds[1] === "binary";
const contextsEqual = (left: MobileE2EEContext, right: MobileE2EEContext) => left.protocol === right.protocol && left.initiator === right.initiator && left.responder === right.responder && left.transport === right.transport && left.relayHostId === right.relayHostId;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isExactRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
