import nacl from "tweetnacl";
import { hostIdForPublicKey } from "../pairing/contracts";
import { encodeBase64, encodeHandshakeTranscript, validateHandshake, type MobileE2EEHello } from "../transport/e2ee-contract";
import { openFrame, sealFrame } from "../transport/e2ee-framing";
import { deriveKeySchedule } from "../transport/e2ee-session";

// A workspace runtime for tests: the relay hello, the real encrypted
// handshake and frames (nothing of the session is mocked), `rpc.hello`, and
// whatever methods a test adds.

export const hostKey = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(17));
export const publicKeyB64 = encodeBase64(hostKey.publicKey);
export const relayHostId = hostIdForPublicKey(publicKeyB64)!;
export const NOW = 1_800_000_000_000;

export function pairingCode(fields: Record<string, unknown> = {}): string {
  const offer = {
    v: 2,
    endpoint: `relay:${relayHostId}`,
    deviceToken: "device-token-0123456789",
    publicKeyB64,
    scope: "session",
    identityMode: "authenticate",
    relay: { v: 1, directorUrl: "https://relay.example.test", cellUrl: "https://cell.example.test", assignmentEpoch: 1, relayHostId, inviteToken: "i".repeat(43), inviteExpiresAt: NOW + 5 * 60_000, e2eeFraming: 2 },
    ...fields,
  };
  return btoa(JSON.stringify(offer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class Runtime {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  binaryType = "";
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  url = "";
  auth: Record<string, unknown> | null = null;
  requests: { id: string; method: string; params: unknown }[] = [];
  deviceToken: string | null = null;
  generation = 3;
  authority = "participate";
  refuse: number | null = null;
  provision = true;
  you: Record<string, unknown> = { userId: "u-me", role: "driver", canApprove: false };
  /** Answers for further methods: return undefined to refuse with `method_not_found`. */
  methods: Record<string, (params: Record<string, unknown>) => unknown> = { "session.tabs": () => ({ tabs: [{ tabId: "t1" }] }) };
  private schedule: ReturnType<typeof deriveKeySchedule> | null = null;
  private received = 0n;
  private sentFrames = 0n;

  private plain(value: unknown) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) }));
  }

  encrypted(value: unknown) {
    const schedule = this.schedule!;
    const frame = sealFrame({ payload: new TextEncoder().encode(JSON.stringify(value)), key: schedule.desktopToMobileKey, sessionId: schedule.sessionId, direction: "desktop-to-mobile", payloadKind: "text", counter: this.sentFrames++ });
    queueMicrotask(() => this.onmessage?.({ data: encodeBase64(frame) }));
  }

  send(raw: unknown) {
    if (!this.schedule) {
      const value = JSON.parse(String(raw));
      if (value.type === "relay-auth") {
        this.auth = value;
        if (this.refuse !== null) return this.plain({ type: "relay-hello", ok: false, code: this.refuse });
        const resume = value.credential !== "i".repeat(43);
        return this.plain({ type: "relay-hello", ok: true, credentialKind: resume ? "resume" : "invite", leaseExpiresAt: NOW + 60_000, ...(resume ? { acceptedCredentialVersion: 1, acceptedAs: "current", resumeExpiresAt: NOW + 60_000 } : {}) });
      }
      const hello = value as MobileE2EEHello;
      const ready = { type: "e2ee_ready", v: 2, desktopPublicKeyB64: publicKeyB64, clientNonceB64: hello.clientNonceB64, desktopNonceB64: encodeBase64(new Uint8Array(32).fill(23)), selection: { framing: 2, payloadKinds: ["text", "binary"] }, context: hello.context };
      const handshake = validateHandshake(hello, ready)!;
      const shared = nacl.box.before(Uint8Array.from(atob(hello.clientPublicKeyB64), (c) => c.charCodeAt(0)), hostKey.secretKey);
      this.schedule = deriveKeySchedule(shared, encodeHandshakeTranscript(handshake), handshake.clientNonce, handshake.desktopNonce);
      return this.plain(ready);
    }
    const plaintext = openFrame({ frame: Uint8Array.from(atob(String(raw)), (c) => c.charCodeAt(0)), key: this.schedule.mobileToDesktopKey, sessionId: this.schedule.sessionId, direction: "mobile-to-desktop", payloadKind: "text", expectedCounter: this.received++ });
    const value = JSON.parse(new TextDecoder().decode(plaintext!));
    if (value.type === "e2ee_auth") {
      this.deviceToken = value.deviceToken;
      return this.encrypted({ type: "e2ee_authenticated", v: 2, transcriptHashB64: value.transcriptHashB64 });
    }
    this.requests.push(value);
    if (value.method === "pairing.provisionRelay") return this.encrypted(this.provision ? { id: value.id, ok: true, result: { reqId: value.params.reqId } } : { id: value.id, ok: false, error: { code: "unavailable", message: "no" } });
    if (value.method === "rpc.hello") {
      return this.encrypted({ id: value.id, ok: true, result: { protocol: "terminalx-workspace-rpc/1", runtime: { version: "0.2.7", runtimeGeneration: this.generation, epoch: "e1" }, capabilities: value.params.want, authority: this.authority, limits: {}, you: this.you } });
    }
    const answer = this.methods[value.method]?.(value.params ?? {});
    if (answer !== undefined) return this.encrypted({ id: value.id, ok: true, result: answer });
    this.encrypted({ id: value.id, ok: false, error: { code: "method_not_found", message: value.method } });
  }

  close() {
    this.readyState = 3;
  }

  /** The relay closes the connection with a code. */
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
