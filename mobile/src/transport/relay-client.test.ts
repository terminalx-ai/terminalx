import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { deriveKeySchedule } from "./e2ee-session";
import { encodeBase64, encodeHandshakeTranscript, validateHandshake, type MobileE2EEHello } from "./e2ee-contract";
import { openFrame, sealFrame } from "./e2ee-framing";
import { RelayClient } from "./relay-client";

class FakeSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  binaryType = "";
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
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

  private emit(value: unknown) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) })); }
  private encrypted(value: unknown) {
    const schedule = this.schedule!;
    const frame = sealFrame({ payload: new TextEncoder().encode(JSON.stringify(value)), key: schedule.desktopToMobileKey, sessionId: schedule.sessionId, direction: "desktop-to-mobile", payloadKind: "text", counter: this.sentFrames++ });
    queueMicrotask(() => this.onmessage?.({ data: encodeBase64(frame) }));
  }
  override send(raw: unknown) {
    this.sent.push(raw);
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
    const plaintext = openFrame({ frame: Uint8Array.from(atob(String(raw)), (c) => c.charCodeAt(0)), key: schedule.mobileToDesktopKey,
      sessionId: schedule.sessionId, direction: "mobile-to-desktop", payloadKind: "text", expectedCounter: this.received++ });
    expect(plaintext).not.toBeNull();
    const value = JSON.parse(new TextDecoder().decode(plaintext!));
    if (value.type === "e2ee_auth") {
      expect(value.deviceToken).toBe("test-device-token");
      expect(value.transcriptHashB64).toBe(encodeBase64(schedule.transcriptHash));
      this.encrypted({ type: "e2ee_authenticated", v: 2, transcriptHashB64: value.transcriptHashB64 });
    } else if (value.method === "pairing.getEndpoints") {
      this.encrypted({ id: value.id, ok: true, result: { v: 1, relay: relayEndpoint,
        resumeConfirmation: { v: 1, reqId: value.params.resumeConfirmReqId, currentVersion: 1, acceptedAs: "current", renewed: false, resumeExpiresAt: Date.now() + 60_000 },
      } });
    } else {
      this.encrypted({ id: value.id, ok: true, result: value.method === "status.get" ? { protocolVersion: 2, product: "TerminalX", deviceScope: "driver" } : { sessions: [] } });
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
