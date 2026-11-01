import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { deriveKeySchedule } from "./e2ee-session";
import { encodeBase64, encodeHandshakeTranscript, validateHandshake, type MobileE2EEHello } from "./e2ee-contract";
import { openFrame, sealFrame } from "./e2ee-framing";
import { RelayClient, RelayOuterError } from "./relay-client";
import { MAC_NEEDS_UPDATE } from "./refusal";
import { encodeFragments, RELAY_MESSAGE_BYTES_LIMIT, textPlaintextLimit } from "./wire";

class FakeSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  binaryType = "";
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  sent: unknown[] = [];

  send(value: unknown) { this.sent.push(value); }
  close() { this.readyState = 3; }
}

describe("direct E2EE transport", () => {
  it("starts the same v2 handshake without a plaintext relay credential", async () => {
    const socket = new FakeSocket();
    const client = new RelayClient({
      transport: "direct",
      endpoint: "ws://192.0.2.10:4040",
      deviceToken: "device-token",
      desktopPublicKeyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(4))),
      createSocket: () => socket as unknown as WebSocket,
    });

    const connecting = client.connect();
    socket.onopen?.();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(String(socket.sent[0]))).toMatchObject({
      type: "e2ee_hello",
      v: 2,
      context: { protocol: "terminalx-mobile-e2ee", transport: "direct" },
    });
    expect(String(socket.sent[0])).not.toContain("device-token");

    client.close();
    await expect(connecting).rejects.toThrow("Relay connection closed");
  });
});


// An encrypted peer exercises the shipped RelayClient without mocking its session.
// The wire shapes match src-tauri/src/pairing/mod.rs and the v2 crypto contract.
class EncryptedPeer extends FakeSocket {
  readonly key = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(17));
  private schedule: ReturnType<typeof deriveKeySchedule> | null = null;
  private received = 0n;
  private sentFrames = 0n;
  private kind = "invite";
  private agreed = false;
  private partial: { bytes: Uint8Array; received: number } | null = null;
  /** The largest WebSocket message each way, as the relay cell would count it. */
  largestFromPhone = 0;
  largestToPhone = 0;
  requests: { method: string; params?: unknown }[] = [];

  /** `fragments`: whether this Mac agrees to them, as a desktop from #669 on does. `unanswered`: a method it never replies to. `refuse`: the error it answers a method with, if any. */
  constructor(private readonly options: { fragments?: boolean; reply?: (method: string) => unknown; unanswered?: string; refuse?: (method: string) => { code: string; message: string } | undefined } = {}) { super(); }

  private emit(value: unknown) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) })); }
  private encrypted(value: unknown) {
    const schedule = this.schedule!;
    const payload = new TextEncoder().encode(JSON.stringify(value));
    if (this.agreed && payload.length > textPlaintextLimit("relay")) {
      for (const fragment of encodeFragments(payload, "relay")) {
        const frame = sealFrame({ payload: fragment, key: schedule.desktopToMobileKey, sessionId: schedule.sessionId, direction: "desktop-to-mobile", payloadKind: "binary", counter: this.sentFrames++ });
        this.largestToPhone = Math.max(this.largestToPhone, frame.length);
        // React Native delivers binary messages as ArrayBuffers (binaryType "arraybuffer").
        queueMicrotask(() => this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) }));
      }
      return;
    }
    const frame = encodeBase64(sealFrame({ payload, key: schedule.desktopToMobileKey, sessionId: schedule.sessionId, direction: "desktop-to-mobile", payloadKind: "text", counter: this.sentFrames++ }));
    this.largestToPhone = Math.max(this.largestToPhone, frame.length);
    queueMicrotask(() => this.onmessage?.({ data: frame }));
  }
  /** Read independently of wire.ts: the layout is the desktop's. */
  private reassemble(fragment: Uint8Array): Uint8Array | null {
    const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    expect([fragment[0], fragment[1], fragment[2], fragment[3]]).toEqual([0x66, 1, 0, 0]);
    const total = view.getUint32(4, true);
    const offset = view.getUint32(8, true);
    if (offset === 0) this.partial = { bytes: new Uint8Array(total), received: 0 };
    expect(this.partial?.received).toBe(offset);
    this.partial!.bytes.set(fragment.subarray(12), offset);
    this.partial!.received += fragment.length - 12;
    if (this.partial!.received < total) return null;
    const message = this.partial!.bytes;
    this.partial = null;
    return message;
  }
  override send(raw: unknown) {
    this.sent.push(raw);
    this.largestFromPhone = Math.max(this.largestFromPhone, typeof raw === "string" ? raw.length : (raw as Uint8Array).byteLength);
    if (!this.schedule) {
      const value = JSON.parse(String(raw));
      if (value.type === "relay-auth") {
        this.kind = value.credential === "test-resume" ? "resume" : "invite";
        this.emit({ type: "relay-hello", ok: true, credentialKind: this.kind, leaseExpiresAt: Date.now() + 60_000,
          ...(this.kind === "resume" ? { acceptedCredentialVersion: 1, acceptedAs: "current", resumeExpiresAt: Date.now() + 60_000 } : {}),
        });
        return;
      }
      const hello = value as MobileE2EEHello;
      const ready = { type: "e2ee_ready", v: 2, desktopPublicKeyB64: encodeBase64(this.key.publicKey), clientNonceB64: hello.clientNonceB64,
        desktopNonceB64: encodeBase64(new Uint8Array(32).fill(23)), selection: { framing: 2, payloadKinds: ["text", "binary"] }, context: hello.context };
      const handshake = validateHandshake(hello, ready)!;
      const shared = nacl.box.before(Uint8Array.from(atob(hello.clientPublicKeyB64), (c) => c.charCodeAt(0)), this.key.secretKey);
      this.schedule = deriveKeySchedule(shared, encodeHandshakeTranscript(handshake), handshake.clientNonce, handshake.desktopNonce);
      this.emit(ready);
      return;
    }
    const schedule = this.schedule;
    const binary = typeof raw !== "string";
    const opened = openFrame({ frame: binary ? raw as Uint8Array : Uint8Array.from(atob(String(raw)), (c) => c.charCodeAt(0)), key: schedule.mobileToDesktopKey,
      sessionId: schedule.sessionId, direction: "mobile-to-desktop", payloadKind: binary ? "binary" : "text", expectedCounter: this.received++ });
    expect(opened).not.toBeNull();
    const plaintext = binary ? this.reassemble(opened!) : opened;
    if (!plaintext) return;
    const value = JSON.parse(new TextDecoder().decode(plaintext));
    if (value.method) this.requests.push({ method: value.method, params: value.params });
    if (value.type === "e2ee_auth") {
      expect(value.deviceToken).toBe("test-device-token");
      expect(value.transcriptHashB64).toBe(encodeBase64(schedule.transcriptHash));
      this.encrypted({ type: "e2ee_authenticated", v: 2, transcriptHashB64: value.transcriptHashB64 });
    } else if (value.method && value.method === this.options.unanswered) {
      // Still in flight when the socket closes.
    } else if (value.method && this.options.refuse?.(value.method)) {
      this.encrypted({ id: value.id, ok: false, error: this.options.refuse(value.method) });
    } else if (value.method === "pairing.getEndpoints") {
      this.encrypted({ id: value.id, ok: true, result: { v: 1, relay: relayEndpoint,
        resumeConfirmation: { v: 1, reqId: value.params.resumeConfirmReqId, currentVersion: 1, acceptedAs: "current", renewed: false, resumeExpiresAt: Date.now() + 60_000 },
      } });
    } else if (value.method === "transport.negotiate") {
      this.agreed = !!this.options.fragments && value.params?.fragments === 1;
      // A Mac from before #669 refuses the method, as static_rpc_response does.
      this.encrypted(this.options.fragments ? { id: value.id, ok: true, result: { fragments: 1 } }
        : { id: value.id, ok: false, error: { code: "forbidden", message: "Method 'transport.negotiate' is not available to this paired device" } });
    } else {
      this.encrypted({ id: value.id, ok: true, result: this.options.reply?.(value.method) ?? (value.method === "status.get" ? { protocolVersion: 2, product: "TerminalX", deviceScope: "driver" } : { sessions: [] }) });
    }
  }
}
const relayEndpoint = { v: 1 as const, directorUrl: "https://relay.example.test", cellUrl: "https://relay.example.test", assignmentEpoch: 1, relayHostId: "AbCdEf0123_-xyZ9", e2eeFraming: 2 as const };

it.each(["direct", "invite", "resume"] as const)("completes encrypted authentication, status and session RPCs using %s", async (kind) => {
  const socket = new EncryptedPeer();
  const common = { deviceToken: "test-device-token", desktopPublicKeyB64: encodeBase64(socket.key.publicKey), createSocket: () => socket as unknown as WebSocket };
  const client = new RelayClient(kind === "direct" ? { ...common, transport: "direct", endpoint: "ws://example.test" } : {
    ...common, relay: relayEndpoint, credential: `test-${kind}`, credentialKind: kind, ...(kind === "resume" ? { credentialVersion: 1 } : {}),
  });
  try {
    const connected = client.connect();
    socket.onopen?.();
    await connected;
    expect(await client.request("status.get")).toEqual({ ok: true, value: { protocolVersion: 2, product: "TerminalX", deviceScope: "driver" } });
    expect(await client.request("sessions.summaries")).toEqual({ ok: true, value: { sessions: [] } });
    if (kind === "resume") expect(client.getResumeConfirmation()).toMatchObject({ currentVersion: 1, acceptedAs: "current" });
  } finally { client.close(); }
});

it("rejects a refused invite before sending the inner device credential", async () => {
  const socket = new FakeSocket();
  const client = new RelayClient({ relay: relayEndpoint, credential: "test-invite", credentialKind: "invite", deviceToken: "test-device-token",
    desktopPublicKeyB64: encodeBase64(new Uint8Array(32).fill(4)), createSocket: () => socket as unknown as WebSocket });
  const connecting = client.connect();
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ type: "relay-hello", ok: false, code: 4001 }) });
  await expect(connecting).rejects.toMatchObject({ code: 4001 });
  expect(socket.sent).toHaveLength(1);
  expect(String(socket.sent[0])).not.toContain("test-device-token");
});

// #669/#670: the close code alone cannot tell a relay close from iOS ending the stream.
describe("a connection that closes with requests in flight", () => {
  const open = async () => {
    const socket = new EncryptedPeer({ unanswered: "session.sync" });
    const client = new RelayClient({ relay: relayEndpoint, credential: "test-resume", credentialKind: "resume", credentialVersion: 1, deviceToken: "test-device-token",
      desktopPublicKeyB64: encodeBase64(socket.key.publicKey), createSocket: () => socket as unknown as WebSocket });
    const connected = client.connect();
    socket.onopen?.();
    await connected;
    const states: [string, Error | undefined][] = [];
    client.subscribeState((state, cause) => states.push([state, cause]));
    return { socket, client, states, pending: client.request("session.sync") };
  };

  it("keeps the close code, reason and wasClean, and fails what was in flight with them", async () => {
    const { socket, states, pending } = await open();
    socket.onclose?.({ code: 1001, reason: "Stream end encountered", wasClean: false });
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RelayOuterError);
    expect(error).toMatchObject({ code: 1001, reason: "Stream end encountered", wasClean: false, message: "relay_outer_1001" });
    expect(states.at(-1)).toEqual(["disconnected", error]);
  });

  it("lets the close that follows a socket error carry its reason", async () => {
    const { socket, pending } = await open();
    // React Native: a bare error, then at once a close with the reason.
    socket.onerror?.();
    socket.onclose?.({ code: 1006, reason: "The network connection was lost." });
    await expect(pending).rejects.toMatchObject({ code: 1006, reason: "The network connection was lost.", wasClean: false });
  });

  it("still fails at once on an error that no close follows", async () => {
    const { socket, pending } = await open();
    socket.onerror?.();
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 1006, reason: "" });
    expect((error as RelayOuterError).wasClean).toBeUndefined();
  });
});

function relayClient(socket: EncryptedPeer): RelayClient {
  return new RelayClient({ relay: relayEndpoint, credential: "test-invite", credentialKind: "invite", deviceToken: "test-device-token",
    desktopPublicKeyB64: encodeBase64(socket.key.publicKey), createSocket: () => socket as unknown as WebSocket });
}

// A 3 MB attachment: about 4 MB of base64 in one request, four times what the relay cell accepts in one message (#669).
const attachment = { mediaType: "image/png", data: "A".repeat(4_000_000), name: "photo.png" };

describe("messages larger than one relay frame (#669)", () => {
  it("cross as fragments both ways once the Mac agrees, and the connection stays usable", async () => {
    const transcript = { events: [], blob: "🦝 \"tool\" output\n".repeat(150_000) };
    const socket = new EncryptedPeer({ fragments: true, reply: (method) => method === "session.sync" ? transcript : undefined });
    const client = relayClient(socket);
    try {
      const connected = client.connect();
      socket.onopen?.();
      await connected;
      expect(await client.request("session.send", { tabId: "tab", text: "", attachments: [attachment] })).toEqual({ ok: true, value: { sessions: [] } });
      expect(socket.requests.find((request) => request.method === "session.send")?.params).toEqual({ tabId: "tab", text: "", attachments: [attachment] });
      expect(await client.request("session.sync", { sessionId: "session", tabId: "tab" })).toEqual({ ok: true, value: transcript });
      expect(await client.request("status.get")).toMatchObject({ ok: true });
      expect(socket.largestFromPhone).toBeLessThanOrEqual(RELAY_MESSAGE_BYTES_LIMIT);
      expect(socket.largestToPhone).toBeLessThanOrEqual(RELAY_MESSAGE_BYTES_LIMIT);
      // About 4 MB of request, in four fragments.
      expect(socket.sent.filter((frame) => typeof frame !== "string")).toHaveLength(4);
    } finally { client.close(); }
  });

  it("are refused before sending when the Mac cannot reassemble them, and nothing else fails", async () => {
    const socket = new EncryptedPeer();
    const client = relayClient(socket);
    try {
      const connected = client.connect();
      socket.onopen?.();
      await connected;
      await expect(client.request("session.send", { tabId: "tab", text: "", attachments: [attachment] }))
        .rejects.toThrow("This is too large to send over Relay (4.0 MB; the limit is 0.8 MB). Update TerminalX on your Mac, or send it on the same Wi-Fi as your Mac.");
      expect(socket.requests.map((request) => request.method)).not.toContain("session.send");
      expect(socket.largestFromPhone).toBeLessThanOrEqual(RELAY_MESSAGE_BYTES_LIMIT);
      expect(await client.request("status.get")).toMatchObject({ ok: true });
    } finally { client.close(); }
  });

  it("go one frame at a time on a direct connection, as they always have", async () => {
    const socket = new EncryptedPeer();
    const client = new RelayClient({ transport: "direct", endpoint: "ws://example.test", deviceToken: "test-device-token",
      desktopPublicKeyB64: encodeBase64(socket.key.publicKey), createSocket: () => socket as unknown as WebSocket });
    try {
      const connected = client.connect();
      socket.onopen?.();
      await connected;
      expect(await client.request("session.send", { tabId: "tab", text: "", attachments: [attachment] })).toMatchObject({ ok: true });
      expect(socket.sent.every((frame) => typeof frame === "string")).toBe(true);
    } finally { client.close(); }
  });
});

it("keeps the close frame's reason while connecting, which tells an oversized message from a lost network", async () => {
  const socket = new FakeSocket();
  const client = new RelayClient({ relay: relayEndpoint, credential: "test-invite", credentialKind: "invite", deviceToken: "test-device-token",
    desktopPublicKeyB64: encodeBase64(new Uint8Array(32).fill(4)), createSocket: () => socket as unknown as WebSocket });
  const connecting = client.connect();
  socket.onopen?.();
  socket.onclose?.({ code: 1001, reason: "Stream end encountered" });
  // The reason is for the connection log; the message stays the code (#670).
  await expect(connecting).rejects.toMatchObject({ code: 1001, reason: "Stream end encountered", wasClean: false, message: "relay_outer_1001" });
});

/** #730: a Mac app newer than its runtime offered a feature the runtime then refused, and passed the refusal on as it was. */
it("says the Mac needs updating when it refuses an operation it does not know, and stays usable", async () => {
  const socket = new EncryptedPeer({ refuse: (method) => method === "terminal.open" ? { code: "unavailable", message: "internal: Unsupported paired-device owner operation." }
    : method === "session.stop" ? { code: "unavailable", message: "The tab is not running." } : undefined });
  const client = new RelayClient({ deviceToken: "test-device-token", desktopPublicKeyB64: encodeBase64(socket.key.publicKey), createSocket: () => socket as unknown as WebSocket, transport: "direct", endpoint: "ws://example.test" });
  try {
    const connected = client.connect();
    socket.onopen?.();
    await connected;
    expect(await client.request("terminal.open", { worktreeId: "s", tabId: "t" })).toEqual({ ok: false, refusal: { code: "unavailable", message: MAC_NEEDS_UPDATE } });
    expect(await client.request("session.stop", { sessionId: "s", tabId: "t" })).toEqual({ ok: false, refusal: { code: "unavailable", message: "The tab is not running." } });
    expect(await client.request("sessions.summaries")).toEqual({ ok: true, value: { sessions: [] } });
  } finally { client.close(); }
});
