import type { RpcCallResult, RpcErrorData } from "@terminalx/portable/rpc";
import { PairingGetEndpointsResultSchema, RelayPhoneHelloSchema, type DeviceResumeConfirmed, type PairingRelay } from "../pairing/contracts";
import { MobileE2EESession } from "./e2ee-session";
import { secureRandom } from "./random";
import { decodeTerminalFrame } from "./terminal-stream";
import { delivery, encodeFragments, FragmentAssembler, FRAGMENTS_VERSION, isFragment, MessageTooLargeError } from "./wire";

export type RelayConnectionState = "connecting" | "handshaking" | "connected" | "disconnected";
export type RelayEvent = { method: string; params?: unknown };

type PendingRequest = {
  resolve: (result: RpcCallResult<unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type StreamRecord = {
  method: string;
  listener: (result: unknown) => void;
  streamIds: Set<number>;
  subscriptionId?: string;
};

/**
 * The socket closed, or the relay refused it, with this code. `reason` and
 * `wasClean` are what the close event said, and are left out when there was
 * no close event (a refused relay hello). The reason is what tells a relay
 * close (4408) from iOS ending the stream itself (1001 "Stream end
 * encountered", #669). React Native never sets `wasClean`, so on the phone it
 * is always false.
 */
export class RelayOuterError extends Error {
  // The message is the code alone: the reason is the relay's or the OS's own
  // text, and goes to the connection log (`closeDetail`), not a screen (#670).
  constructor(readonly code: number, readonly reason = "", readonly wasClean?: boolean) {
    super(`relay_outer_${code}`);
  }
}

type RelayClientOptions =
  | {
      transport?: "relay";
      relay: Omit<PairingRelay, "inviteToken" | "inviteExpiresAt">;
      credential: string;
      credentialKind: "invite" | "resume";
      credentialVersion?: number;
      deviceToken: string;
      desktopPublicKeyB64: string;
      clientSecretKey?: Uint8Array;
      createSocket?: (url: string) => WebSocket;
    }
  | {
      transport: "direct";
      endpoint: string;
      deviceToken: string;
      desktopPublicKeyB64: string;
      clientSecretKey?: Uint8Array;
      createSocket?: (url: string) => WebSocket;
    };

export class RelayClient {
  private socket: WebSocket | null = null;
  private session: MobileE2EESession | null = null;
  private outerReady = false;
  private handshakeReady = false;
  private authenticated = false;
  private requestCounter = 0;
  private pending = new Map<string, PendingRequest>();
  private streams = new Map<string, StreamRecord>();
  private terminalStreams = new Map<number, (result: unknown) => void>();
  private terminalSnapshots = new Map<number, { meta: Record<string, unknown>; chunks: string[] }>();
  private listeners = new Set<(event: RelayEvent) => void>();
  private stateListeners = new Set<(state: RelayConnectionState, cause?: Error) => void>();
  private state: RelayConnectionState = "disconnected";
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private resumeConfirmation: DeviceResumeConfirmed | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the Mac reassembles fragments; settles soon after authentication. */
  private fragments: Promise<boolean> = Promise.resolve(false);
  private assembler = new FragmentAssembler();

  constructor(private readonly options: RelayClientOptions) {}

  getTransport(): "direct" | "relay" {
    return this.options.transport === "direct" ? "direct" : "relay";
  }

  /** Whether the Mac reassembles fragments, as one from #669 on does; false until it has said so. */
  reassemblesFragments(): Promise<boolean> {
    return this.fragments;
  }

  connect(): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.setState("connecting");
    this.outerReady = false;
    this.handshakeReady = false;
    this.authenticated = false;
    this.resumeConfirmation = null;
    this.fragments = Promise.resolve(false);
    this.assembler = new FragmentAssembler();
    const direct = this.options.transport === "direct";
    this.session = MobileE2EESession.create({
      desktopPublicKeyB64: this.options.desktopPublicKeyB64,
      transport: direct ? "direct" : "relay",
      ...(!direct ? { relayHostId: this.options.relay.relayHostId } : {}),
      random: secureRandom,
      ...(this.options.clientSecretKey ? { clientSecretKey: this.options.clientSecretKey } : {}),
    });
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(direct ? this.options.endpoint : relaySocketUrl(this.options.relay));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => this.fail(new Error(`${direct ? "Direct" : "Relay"} handshake timed out after 15 seconds`)), 15_000);
    socket.onopen = () => {
      if (direct) {
        this.outerReady = true;
        this.setState("handshaking");
        socket.send(JSON.stringify(this.session!.hello));
      } else {
        socket.send(JSON.stringify({ type: "relay-auth", v: 1, mode: "connect", credential: this.options.credential }));
      }
    };
    socket.onmessage = (event) => void this.handleMessage(event.data).catch((error: unknown) => this.fail(asError(error)));
    // React Native fires a bare "error" and then, at once, a "close" that
    // carries the reason. Let that close speak first; the error stands in
    // only when no close follows.
    socket.onerror = () => queueMicrotask(() => {
      if (this.socket === socket) this.fail(direct ? new Error("WebSocket connection failed (network unavailable or connection refused)") : new RelayOuterError(1006));
    });
    socket.onclose = (event) => this.fail(new RelayOuterError(event.code || 1006, typeof event.reason === "string" ? event.reason : "", event.wasClean === true));
    return this.connectPromise;
  }

  request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<RpcCallResult<T>> {
    if (!this.authenticated || !this.session || !this.socket || this.socket.readyState !== this.socket.OPEN) {
      return Promise.reject(new Error("Relay connection unavailable"));
    }
    const id = `mobile-${Date.now()}-${++this.requestCounter}`;
    return new Promise<RpcCallResult<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (result) => resolve(result as RpcCallResult<T>), reject, timer });
      this.sendRequestFrame(id, method, params);
    });
  }

  subscribeStream(method: string, params: unknown, listener: (result: unknown) => void): () => void {
    if (!this.authenticated || !this.session || !this.socket || this.socket.readyState !== this.socket.OPEN) {
      listener({ type: "error", message: "Relay connection unavailable" });
      return () => undefined;
    }
    const id = `mobile-stream-${Date.now()}-${++this.requestCounter}`;
    this.streams.set(id, { method, listener, streamIds: new Set() });
    this.sendRequestFrame(id, method, params);
    return () => this.cancelStream(id);
  }

  subscribe(listener: (event: RelayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** `cause` comes with "disconnected": what ended the connection, the same error its pending requests fail with. */
  subscribeState(listener: (state: RelayConnectionState, cause?: Error) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  getResumeConfirmation(): DeviceResumeConfirmed | null {
    return this.resumeConfirmation;
  }

  close(): void {
    this.fail(new Error("Relay connection closed"));
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!this.socket || !this.session) return;
    if (!this.outerReady) {
      if (this.options.transport === "direct") throw new Error("Unexpected direct connection state");
      if (typeof raw !== "string") throw new Error("Expected plaintext relay hello");
      const parsed = RelayPhoneHelloSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("Invalid relay hello");
      if (!parsed.data.ok) throw new RelayOuterError(parsed.data.code);
      if (parsed.data.credentialKind !== this.options.credentialKind) throw new Error("Unexpected relay credential kind");
      if (parsed.data.credentialKind === "resume" && this.options.credentialVersion !== undefined && parsed.data.acceptedCredentialVersion !== this.options.credentialVersion) throw new Error("Relay resume credential version mismatch");
      this.outerReady = true;
      this.setState("handshaking");
      this.socket.send(JSON.stringify(this.session.hello));
      return;
    }
    if (!this.handshakeReady) {
      if (typeof raw !== "string" || !this.session.acceptReady(parseJson(raw))) throw new Error("Invalid E2EE ready");
      this.handshakeReady = true;
      this.socket.send(this.session.sealText(JSON.stringify({ type: "e2ee_auth", v: 2, transcriptHashB64: this.session.transcriptHashB64, deviceToken: this.options.deviceToken })));
      return;
    }
    // An ArrayBuffer is opened at once: waiting would let a text frame sent
    // after it be opened first, out of counter order.
    const frame = typeof raw === "string" || raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : await bytesFromSocket(raw);
    const plaintext = typeof frame === "string" ? this.session.openText(frame) : this.session.openBinary(frame);
    if (plaintext === null) throw new Error("Invalid or out-of-order E2EE frame");
    let text: string;
    if (typeof plaintext === "string") text = plaintext;
    else if (this.authenticated && isFragment(plaintext)) {
      const message = this.assembler.push(plaintext);
      if (!message) return;
      text = new TextDecoder().decode(message);
    } else {
      this.handleTerminalBinary(plaintext);
      return;
    }
    const value = parseJson(text);
    if (!this.authenticated) {
      if (!isAuthenticated(value, this.session.transcriptHashB64)) throw new Error("E2EE device authentication rejected");
      this.authenticated = true;
      // Asked first and not waited for: only a request too large for one frame waits for the answer.
      this.fragments = this.request<{ fragments?: unknown } | null>("transport.negotiate", { fragments: FRAGMENTS_VERSION }, 10_000)
        .then((result) => result.ok && result.value?.fragments === FRAGMENTS_VERSION, () => false);
      if (this.options.transport !== "direct" && this.options.credentialKind === "resume") {
        const reqId = `confirm-${encodeBase64Url(secureRandom.bytes(16))}`;
        const result = await this.request<unknown>("pairing.getEndpoints", { resumeConfirmReqId: reqId });
        if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.message}`);
        const endpoints = PairingGetEndpointsResultSchema.parse(result.value);
        const confirmation = endpoints.resumeConfirmation;
        if (!confirmation || confirmation.reqId !== reqId || endpoints.relay?.relayHostId !== this.options.relay.relayHostId) throw new Error("Relay resume confirmation missing");
        this.resumeConfirmation = confirmation;
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.setState("connected");
      this.resolveConnect?.();
      this.connectPromise = null;
      this.resolveConnect = null;
      this.rejectConnect = null;
      return;
    }
    if (isRpcResponse(value)) {
      const pending = this.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        pending.resolve(value.ok ? { ok: true, value: value.result } : { ok: false, refusal: value.error });
        return;
      }
      this.handleStreamResponse(value);
      return;
    }
    if (isEvent(value)) for (const listener of this.listeners) listener(value);
  }

  private fail(error: Error): void {
    if (this.state === "disconnected" && !this.connectPromise) return;
    this.setState("disconnected", error);
    const socket = this.socket;
    this.socket = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connectPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.streams.clear();
    this.terminalStreams.clear();
    this.terminalSnapshots.clear();
    socket?.close();
  }

  private sendRequestFrame(id: string, method: string, params?: unknown): void {
    const message = new TextEncoder().encode(JSON.stringify({ id, deviceToken: this.options.deviceToken, method, ...(params === undefined ? {} : { params }) }));
    const socket = this.socket!;
    const session = this.session!;
    const transport = this.getTransport();
    if (delivery(transport, message.length, false) === "frame") {
      socket.send(session.sealTextBytes(message));
      return;
    }
    // Too large for one frame, which would close the connection (#669): sent
    // as fragments once the Mac has said it reassembles them, refused if not.
    void this.fragments.then((agreed) => {
      if (this.socket !== socket || this.session !== session || (!this.pending.has(id) && !this.streams.has(id))) return;
      if (delivery(transport, message.length, agreed) === "fragments") {
        for (const fragment of encodeFragments(message, transport)) socket.send(session.sealBinary(fragment));
      } else this.refuse(id, new MessageTooLargeError(transport, message.length, agreed));
    });
  }

  private refuse(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
      return;
    }
    this.streams.get(id)?.listener({ type: "error", message: error.message });
    this.removeStream(id);
  }

  private handleStreamResponse(value: RpcWireResponse): void {
    const stream = this.streams.get(value.id);
    if (!stream) return;
    if (!value.ok) {
      stream.listener({ type: "error", message: value.error.message, error: value.error });
      this.removeStream(value.id);
      return;
    }
    const result = value.result;
    if (result && typeof result === "object") {
      const metadata = result as Record<string, unknown>;
      if (typeof metadata.subscriptionId === "string") stream.subscriptionId = metadata.subscriptionId;
      if (typeof metadata.streamId === "number" && Number.isSafeInteger(metadata.streamId)) {
        stream.streamIds.add(metadata.streamId);
        this.terminalStreams.set(metadata.streamId, stream.listener);
      }
      stream.listener(result);
      if (metadata.type === "end") this.removeStream(value.id);
      return;
    }
    stream.listener(result);
  }

  private cancelStream(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.removeStream(id);
    if (stream.subscriptionId && this.authenticated && this.socket) {
      this.sendRequestFrame(`mobile-${Date.now()}-${++this.requestCounter}`, stream.method.replace(/\.subscribe$/, ".unsubscribe"), { subscriptionId: stream.subscriptionId });
    }
  }

  private removeStream(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    for (const streamId of stream.streamIds) {
      this.terminalStreams.delete(streamId);
      this.terminalSnapshots.delete(streamId);
    }
    this.streams.delete(id);
  }

  private handleTerminalBinary(bytes: Uint8Array): void {
    const frame = decodeTerminalFrame(bytes);
    if (!frame) return;
    const listener = this.terminalStreams.get(frame.streamId);
    if (!listener) return;
    if (frame.opcode === 1) listener({ type: "data", streamId: frame.streamId, seq: frame.seq, chunk: new TextDecoder().decode(frame.payload) });
    else if (frame.opcode === 2) {
      const meta = parseJson(new TextDecoder().decode(frame.payload));
      if (meta && typeof meta === "object") this.terminalSnapshots.set(frame.streamId, { meta: meta as Record<string, unknown>, chunks: [] });
    } else if (frame.opcode === 3) this.terminalSnapshots.get(frame.streamId)?.chunks.push(new TextDecoder().decode(frame.payload));
    else if (frame.opcode === 4) {
      const snapshot = this.terminalSnapshots.get(frame.streamId);
      if (!snapshot) return;
      this.terminalSnapshots.delete(frame.streamId);
      listener({ ...snapshot.meta, type: snapshot.meta.kind === "resized" ? "resized" : "scrollback", streamId: frame.streamId, seq: frame.seq, serialized: snapshot.chunks.join("") });
    } else if (frame.opcode === 5 || frame.opcode === 12) {
      const meta = parseJson(new TextDecoder().decode(frame.payload));
      if (meta && typeof meta === "object") listener({ ...(meta as Record<string, unknown>), type: frame.opcode === 5 ? "resized" : "metadata", streamId: frame.streamId, seq: frame.seq });
    } else if (frame.opcode === 6) listener({ type: "error", streamId: frame.streamId, seq: frame.seq, message: new TextDecoder().decode(frame.payload) });
  }

  private setState(state: RelayConnectionState, cause?: Error): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state, cause);
  }
}

function relaySocketUrl(relay: { cellUrl: string; relayHostId: string }): string {
  const url = new URL(relay.cellUrl);
  url.protocol = "wss:";
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`;
  return url.toString();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid relay JSON");
  }
}

function isAuthenticated(value: unknown, hash: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "transcriptHashB64,type,v" && record.type === "e2ee_authenticated" && record.v === 2 && record.transcriptHashB64 === hash;
}

function isRpcResponse(value: unknown): value is { id: string; ok: true; result: unknown } | { id: string; ok: false; error: RpcErrorData } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.ok !== "boolean") return false;
  if (record.ok) return Object.hasOwn(record, "result");
  const error = record.error as Record<string, unknown> | undefined;
  return !!error && typeof error.code === "string" && typeof error.message === "string";
}

type RpcWireResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: RpcErrorData };

function isEvent(value: unknown): value is RelayEvent {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).method === "string";
}

async function bytesFromSocket(raw: unknown): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw && typeof raw === "object" && "arrayBuffer" in raw) return new Uint8Array(await (raw as Blob).arrayBuffer());
  throw new Error("Invalid relay binary frame");
}

const asError = (value: unknown) => (value instanceof Error ? value : new Error(String(value)));
function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
