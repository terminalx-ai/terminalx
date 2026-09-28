// `terminalx-workspace-rpc/1`: the versioned pty/fs/git/session surface a
// cloud workspace runtime serves (terminalx-saas
// `apps/api/docs/cloud-workspace-remote-runtime-contract.md`). The same
// portable RPC envelope the phone uses carries it; this client adds what a
// connection that drops and comes back needs:
// - mutations carry a `clientRequestId` that is kept across resends, so the
//   runtime answers a resend from its idempotency cache instead of writing
//   or prompting twice;
// - terminal writes carry a per-terminal `seq`, and the runtime drops one it
//   already applied;
// - subscriptions resume from their last offset or cursor after a
//   reconnect, and resync from a snapshot when the runtime generation moved.
import { PortableRpcClient, type RpcCallResult, type RpcErrorData, type RpcResponse, type RpcWireRequest } from "./rpc";

export const WORKSPACE_PROTOCOL = "terminalx-workspace-rpc/1";
export const WORKSPACE_CAPABILITIES = ["pty/1", "fs/1", "git/1", "session/1"] as const;
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

/** How much a caller may cost: only an interactive action may wake compute. */
export type Activation = "cache-only" | "sync" | "connect" | "wake";

export const MUTATING_METHODS = new Set([
  "session.create",
  "session.close",
  "session.send",
  "pty.create",
  "fs.write",
  "fs.rename",
  "fs.delete",
  "fs.mkdir",
  "git.checkout",
  "git.commit",
  "git.stage",
  "git.unstage",
  "git.push",
  "git.pull",
]);

export type WorkspaceConnectionState =
  | { state: "idle" | "opening" | "waitingForRuntime" | "suspended" | "updateRequired" | "stopped" }
  | { state: "connecting"; attempt: number }
  | { state: "reconnecting"; attempt: number; reason: string; retryInMs: number }
  | { state: "connected"; runtimeGeneration: number; runtimeVersion: string; capabilities: string[]; authority: "manage" | "participate" };

/** Frames in and out of one supervised connection (the desktop's Rust supervisor). */
export interface WorkspaceTransport {
  send(frame: RpcWireRequest): boolean;
  onMessage(listener: (message: unknown) => void): () => void;
  onState(listener: (state: WorkspaceConnectionState) => void): () => void;
  close(): void;
}

export interface WorkspaceNotification {
  event: string;
  params: Record<string, unknown> & { subscriptionId?: string };
}

export class WorkspaceRpcError extends Error {
  constructor(readonly code: string, message: string, readonly method: string) {
    super(message);
  }
}

type Subscription = {
  method: "pty.attach" | "session.subscribe" | "fs.watch";
  /** Re-sent on reconnect, with the resume point updated. */
  params: Record<string, unknown>;
  listener: (notification: WorkspaceNotification) => void;
  onReplay?: (result: Record<string, unknown>) => void;
  serverId?: string;
};

const RESEND_WAIT_MS = 15_000;

export class WorkspaceRpcClient {
  private readonly rpc: PortableRpcClient;
  private readonly responseListeners = new Set<(response: RpcResponse) => void>();
  private readonly stateListeners = new Set<(state: WorkspaceConnectionState) => void>();
  private readonly detach: (() => void)[] = [];
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly writeSeq = new Map<string, number>();
  private state: WorkspaceConnectionState = { state: "idle" };
  private nextLocal = 0;
  private closed = false;
  private readonly dropWaiters = new Set<() => void>();

  constructor(private readonly transport: WorkspaceTransport, private readonly newRequestId: () => string = randomRequestId, timeoutMs = 30_000) {
    this.rpc = new PortableRpcClient(
      {
        send: (request) => transport.send(request),
        subscribe: (listener) => {
          this.responseListeners.add(listener);
          return () => this.responseListeners.delete(listener);
        },
      },
      timeoutMs,
    );
    this.detach.push(transport.onMessage((message) => this.receive(message)));
    this.detach.push(transport.onState((state) => this.changeState(state)));
  }

  get connection(): WorkspaceConnectionState {
    return this.state;
  }

  get generation(): number | null {
    return this.state.state === "connected" ? this.state.runtimeGeneration : null;
  }

  onState(listener: (state: WorkspaceConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  /** A read, or a mutation with an explicit `clientRequestId`. */
  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.assertGranted(method);
    if (MUTATING_METHODS.has(method) && typeof params.clientRequestId !== "string") {
      return this.mutate<T>(method, params);
    }
    const result = await this.rpc.request<T>(method, params);
    return unwrap(method, result);
  }

  /**
   * A mutation. The id is fixed before the first send, so a resend after a
   * dropped connection is the same request to the runtime.
   */
  async mutate<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, clientRequestId = this.newRequestId()): Promise<T> {
    this.assertGranted(method);
    const request = { ...params, clientRequestId };
    return this.resending(() => this.untilDropped(this.rpc.request<T>(method, request)).then((result) => unwrap(method, result)));
  }

  /** Terminal input, numbered per terminal so a resend is not typed twice. */
  async write(ptyId: string, data: string): Promise<boolean> {
    const seq = (this.writeSeq.get(ptyId) ?? 0) + 1;
    this.writeSeq.set(ptyId, seq);
    const result = await this.resending(() =>
      this.untilDropped(this.rpc.request<{ applied: boolean }>("pty.write", { ptyId, data, seq })).then((value) => unwrap("pty.write", value)),
    );
    return result.applied;
  }

  /**
   * Send, and if the connection drops before the answer, send the same
   * request again once it is back. A refusal from the runtime is final.
   */
  private async resending<T>(attempt: () => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        if (error instanceof WorkspaceRpcError || this.closed || tries >= 5) throw error;
        await this.connected(RESEND_WAIT_MS);
      }
    }
  }

  /** Reject as soon as the connection drops, instead of waiting for the timeout. */
  private untilDropped<T>(request: Promise<T>): Promise<T> {
    if (this.state.state !== "connected") return request;
    return new Promise<T>((resolve, reject) => {
      const dropped = () => reject(new Error("Workspace connection dropped"));
      this.dropWaiters.add(dropped);
      request.then(resolve, reject).finally(() => this.dropWaiters.delete(dropped));
    });
  }

  /** Stream a terminal from `sinceOffset`, resuming from the last byte seen after a reconnect. */
  attachPty(
    ptyId: string,
    onData: (bytes: Uint8Array, offset: number) => void,
    onExit?: (code: number | null) => void,
  ): Promise<() => void> {
    let nextOffset: number | undefined;
    // Offsets count bytes of one runtime generation's terminal.
    let offsetGeneration: number | null = null;
    const emit = (dataB64: string, offset: number) => {
      offsetGeneration = this.generation;
      const bytes = decodeBase64(dataB64);
      // Replay and live output can overlap by a chunk around a reconnect.
      const skip = nextOffset === undefined ? 0 : Math.max(0, nextOffset - offset);
      if (skip < bytes.length) onData(bytes.subarray(skip), offset + skip);
      nextOffset = Math.max(nextOffset ?? 0, offset + bytes.length);
    };
    return this.subscribe({
      method: "pty.attach",
      params: { ptyId },
      resumeParams: () => (nextOffset === undefined || offsetGeneration === null ? {} : { sinceOffset: nextOffset, runtimeGeneration: offsetGeneration }),
      onCursorExpired: () => {
        nextOffset = undefined;
      },
      onReplay: (result) => {
        if (result.truncated === true) nextOffset = undefined;
        emit(String(result.data ?? ""), Number(result.offset ?? 0));
        if (result.exited === true) onExit?.((result.exitCode as number | null | undefined) ?? null);
      },
      listener: (notification) => {
        if (notification.event === "pty.output") emit(String(notification.params.data), Number(notification.params.offset));
        else if (notification.event === "pty.exit") onExit?.((notification.params.code as number | null | undefined) ?? null);
      },
    });
  }

  /** An agent tab's events, replayed after the last cursor seen. */
  subscribeSession(sessionId: string, tabId: string, onEvent: (event: unknown) => void): Promise<() => void> {
    let cursor: string | undefined;
    return this.subscribe({
      method: "session.subscribe",
      params: { sessionId, tabId },
      resumeParams: () => (cursor ? { sinceCursor: cursor } : {}),
      onReplay: (result) => {
        for (const entry of (result.events as { cursor: string; event: unknown }[] | undefined) ?? []) onEvent(entry.event);
        if (typeof result.cursor === "string") cursor = result.cursor;
      },
      listener: (notification) => {
        if (notification.event !== "session.event") return;
        cursor = String(notification.params.cursor);
        onEvent(notification.params.event);
      },
      onCursorExpired: () => {
        cursor = undefined;
      },
    });
  }

  close(): void {
    this.closed = true;
    for (const stop of this.detach) stop();
    this.rpc.close("Workspace connection closed");
    this.subscriptions.clear();
    this.writeSeq.clear();
    this.transport.close();
  }

  private async subscribe(spec: {
    method: Subscription["method"];
    params: Record<string, unknown>;
    resumeParams: () => Record<string, unknown>;
    listener: Subscription["listener"];
    onReplay: (result: Record<string, unknown>) => void;
    onCursorExpired?: () => void;
  }): Promise<() => void> {
    const localId = `local-${++this.nextLocal}`;
    const subscription: Subscription & { resume: () => Promise<void> } = {
      method: spec.method,
      params: spec.params,
      listener: spec.listener,
      onReplay: spec.onReplay,
      resume: async () => {
        let result: RpcCallResult<Record<string, unknown>>;
        result = await this.rpc.request(spec.method, { ...spec.params, ...spec.resumeParams() });
        if (!result.ok && result.refusal.code === "cursor_expired") {
          // Another runtime generation: resync from a full snapshot.
          spec.onCursorExpired?.();
          result = await this.rpc.request(spec.method, spec.params);
        }
        const value = unwrap(spec.method, result);
        subscription.serverId = String(value.subscriptionId);
        spec.onReplay(value);
      },
    };
    this.assertGranted(spec.method);
    this.subscriptions.set(localId, subscription);
    // Not connected yet (or the link drops mid-call): the subscription is
    // registered and resumes on the next connect. A runtime refusal is final.
    if (this.state.state === "connected") {
      try {
        await subscription.resume();
      } catch (error) {
        if (error instanceof WorkspaceRpcError) {
          this.subscriptions.delete(localId);
          throw error;
        }
      }
    }
    return () => {
      const current = this.subscriptions.get(localId);
      this.subscriptions.delete(localId);
      const unsubscribe = spec.method === "pty.attach" ? "pty.detach" : spec.method === "fs.watch" ? "fs.unwatch" : "session.unsubscribe";
      if (current?.serverId && this.state.state === "connected") void this.rpc.request(unsubscribe, { subscriptionId: current.serverId }).catch(() => undefined);
    };
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.ok === "boolean") {
      for (const listener of this.responseListeners) listener(record as unknown as RpcResponse);
      return;
    }
    if (typeof record.event === "string" && record.params && typeof record.params === "object") {
      const notification = record as unknown as WorkspaceNotification;
      const target = notification.params.subscriptionId;
      for (const subscription of this.subscriptions.values()) {
        if (subscription.serverId === target) subscription.listener(notification);
      }
    }
  }

  private changeState(state: WorkspaceConnectionState): void {
    const wasConnected = this.state.state === "connected";
    this.state = state;
    if (wasConnected && state.state !== "connected") {
      for (const dropped of [...this.dropWaiters]) dropped();
      this.dropWaiters.clear();
    }
    if (state.state === "connected" && !wasConnected) {
      // A new E2EE session: every server-side subscription is gone.
      for (const subscription of this.subscriptions.values()) {
        subscription.serverId = undefined;
        void (subscription as Subscription & { resume: () => Promise<void> }).resume().catch(() => undefined);
      }
    }
    for (const listener of this.stateListeners) listener(state);
  }

  private connected(withinMs: number): Promise<void> {
    if (this.state.state === "connected") return new Promise((resolve) => setTimeout(resolve, 50));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Workspace runtime did not reconnect"));
      }, Math.max(0, withinMs));
      const stop = this.onState((state) => {
        if (state.state !== "connected") return;
        clearTimeout(timer);
        queueMicrotask(stop);
        resolve();
      });
    });
  }

  private assertGranted(method: string): void {
    if (this.state.state !== "connected") return;
    const namespace = method.split(".")[0];
    if (!this.state.capabilities.some((capability) => capability.startsWith(`${namespace}/`))) {
      throw new WorkspaceRpcError("capability_not_granted", `${namespace} is not available from this runtime`, method);
    }
  }
}

function unwrap<T>(method: string, result: RpcCallResult<T>): T {
  if (result.ok) return result.value;
  const refusal: RpcErrorData = result.refusal;
  throw new WorkspaceRpcError(refusal.code, refusal.message, method);
}

function randomRequestId(): string {
  return `req-${crypto.randomUUID().replace(/-/g, "")}`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
