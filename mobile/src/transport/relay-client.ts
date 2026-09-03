import type { RpcCallResult, RpcErrorData } from "@terminalx/portable/rpc";
import { RelayPhoneHelloSchema, type PairingRelay } from "../pairing/contracts";
import { MobileE2EESession } from "./e2ee-session";
import { secureRandom } from "./random";

export type RelayConnectionState = "connecting" | "handshaking" | "connected" | "disconnected";
export type RelayEvent = { method: string; params?: unknown };

type PendingRequest = {
  resolve: (result: RpcCallResult<unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RelayOuterError extends Error {
  constructor(readonly code: number) {
    super(`relay_outer_${code}`);
  }
}

export class RelayClient {
  private socket: WebSocket | null = null;
  private session: MobileE2EESession | null = null;
  private outerReady = false;
  private handshakeReady = false;
  private authenticated = false;
  private requestCounter = 0;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(event: RelayEvent) => void>();
  private stateListeners = new Set<(state: RelayConnectionState) => void>();
  private state: RelayConnectionState = "disconnected";
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;

  constructor(
    private readonly options: {
      relay: Omit<PairingRelay, "inviteToken" | "inviteExpiresAt">;
      credential: string;
      credentialKind: "invite" | "resume";
      deviceToken: string;
      desktopPublicKeyB64: string;
      createSocket?: (url: string) => WebSocket;
    },
  ) {}

  connect(): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.setState("connecting");
    this.outerReady = false;
    this.handshakeReady = false;
    this.authenticated = false;
    this.session = MobileE2EESession.create({
      desktopPublicKeyB64: this.options.desktopPublicKeyB64,
      transport: "relay",
      relayHostId: this.options.relay.relayHostId,
      random: secureRandom,
    });
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(relaySocketUrl(this.options.relay));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "relay-auth", v: 1, mode: "connect", credential: this.options.credential }));
    socket.onmessage = (event) => void this.handleMessage(event.data).catch((error: unknown) => this.fail(asError(error)));
    socket.onerror = () => this.fail(new RelayOuterError(1006));
    socket.onclose = (event) => this.fail(new RelayOuterError(event.code || 1006));
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
      this.socket!.send(this.session!.sealText(JSON.stringify({ id, deviceToken: this.options.deviceToken, method, ...(params === undefined ? {} : { params }) })));
    });
  }

  subscribe(listener: (event: RelayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeState(listener: (state: RelayConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.fail(new Error("Relay connection closed"));
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!this.socket || !this.session) return;
    if (!this.outerReady) {
      if (typeof raw !== "string") throw new Error("Expected plaintext relay hello");
      const parsed = RelayPhoneHelloSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("Invalid relay hello");
      if (!parsed.data.ok) throw new RelayOuterError(parsed.data.code);
      if (parsed.data.credentialKind !== this.options.credentialKind) throw new Error("Unexpected relay credential kind");
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
    const plaintext = typeof raw === "string" ? this.session.openText(raw) : this.session.openBinary(await bytesFromSocket(raw));
    if (plaintext === null) throw new Error("Invalid or out-of-order E2EE frame");
    const text = typeof plaintext === "string" ? plaintext : new TextDecoder().decode(plaintext);
    const value = parseJson(text);
    if (!this.authenticated) {
      if (!isAuthenticated(value, this.session.transcriptHashB64)) throw new Error("E2EE device authentication rejected");
      this.authenticated = true;
      this.setState("connected");
      this.resolveConnect?.();
      this.connectPromise = null;
      this.resolveConnect = null;
      this.rejectConnect = null;
      return;
    }
    if (isRpcResponse(value)) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      pending.resolve(value.ok ? { ok: true, value: value.result } : { ok: false, refusal: value.error });
      return;
    }
    if (isEvent(value)) for (const listener of this.listeners) listener(value);
  }

  private fail(error: Error): void {
    if (this.state === "disconnected" && !this.connectPromise) return;
    this.setState("disconnected");
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connectPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: RelayConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
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
