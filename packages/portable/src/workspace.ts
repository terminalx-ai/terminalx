// `terminalx-workspace-rpc/1`: the versioned pty/fs/git/session surface a
// cloud workspace runtime serves (terminalx-saas
// `apps/api/docs/cloud-workspace-remote-runtime-contract.md`). The same
// portable RPC envelope the phone uses carries it; this client adds what a
// connection that drops and comes back needs:
// - mutations carry a `clientRequestId` that is kept across resends, so the
//   runtime answers a resend from its idempotency cache instead of writing
//   or prompting twice;
// - terminal input is queued per terminal and sent one numbered write at a
//   time (`writerId` + `seq`), so it arrives once and in order across drops,
//   and a refusal is reported rather than dropped;
// - terminals belong to one runtime process (`epoch`): after a restart or
//   replacement nothing is sent to them and their views are told they ended;
// - subscriptions resume from their last offset or cursor after a
//   reconnect, and resync from a snapshot when the runtime generation moved.
import { PortableRpcClient, type RpcCallResult, type RpcErrorData, type RpcResponse, type RpcWireRequest } from "./rpc";

export const WORKSPACE_PROTOCOL = "terminalx-workspace-rpc/1";
/**
 * Namespace versions, as `src-tauri/src/remote/protocol.rs` `CAPABILITIES`.
 * A newer version only adds to its namespace (CS-12):
 * - `session/2`: `session.update`, `session.addTab`, `session.delete` and the
 *   `session.sessions` notification;
 * - `pty/2`: `pty.create` takes a `sessionId`, and `pty.list` returns it;
 * - `agents/1`: `runtime.agents`;
 * - `agent-pty/1` (PRO-86): the terminal an agent tab's CLI runs in answers
 *   the `pty.*` methods as `agentPtyId(tabId)`. It adds no method;
 * - `composer/1` (PRO-22): `session.commands`, the slash commands an agent
 *   tab's composer offers this person;
 * - `composer/2`: `session.files`, the session's files by name, for the
 *   composer's `@` list;
 * - `composer/3`: `session.attach`, an image uploaded in parts for the
 *   message that then names it;
 * - `ports/1` (PRO-28): streams to TCP ports on the workspace's loopback, for
 *   private previews (docs/CLOUD-PREVIEWS.md): `listPorts` here; the streams
 *   themselves are carried by the desktop's native forwarder.
 * An older runtime grants none of them; check `hasCapability` before offering
 * the matching action.
 */
export const WORKSPACE_CAPABILITIES = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "lifecycle/1", "agents/1", "collab/1", "agent-pty/1", "composer/1", "composer/2", "composer/3", "ports/1"] as const;
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

/**
 * Methods served only under a specific namespace version. Every other method
 * needs any version of the namespace it is named after.
 */
export const METHOD_CAPABILITIES: Readonly<Record<string, WorkspaceCapability>> = {
  "session.update": "session/2",
  "session.addTab": "session/2",
  "session.delete": "session/2",
  "runtime.agents": "agents/1",
  "session.commands": "composer/1",
  "session.files": "composer/2",
  "session.attach": "composer/3",
  // `collab/1` (PRO-30, docs/CLOUD-SHARING.md) also grants presence, notes
  // and tab leases, which are not named after it.
  "presence.update": "collab/1",
  "notes.list": "collab/1",
  "notes.post": "collab/1",
  "lease.acquire": "collab/1",
  "lease.release": "collab/1",
  "lease.takeOver": "collab/1",
};

/**
 * The terminal an agent tab's own CLI runs in, on a runtime that granted
 * `agent-pty/1`. It is attached, typed into, sized and controlled like a
 * shell (`attachPty`, `write`, `resizePty`, `controlPty`), is never in
 * `pty.list`, and cannot be killed: it closes with its tab. Typing and sizing
 * also need the tab's lease to be free or this person's.
 */
export function agentPtyId(tabId: string): string {
  return `tab:${tabId}`;
}

/** How much a caller may cost: only an interactive action may wake compute. */
export type Activation = "cache-only" | "sync" | "connect" | "wake";

export const MUTATING_METHODS = new Set([
  "session.create",
  "session.close",
  "session.send",
  "session.configure",
  "session.update",
  "session.addTab",
  "session.delete",
  "pty.create",
  "fs.write",
  "fs.writePart",
  "fs.rename",
  "fs.delete",
  "fs.mkdir",
  "git.checkout",
  "git.commit",
  "git.stage",
  "git.unstage",
  "git.push",
  "git.pull",
  "git.fetch",
  "git.prCreate",
  "git.prReady",
  "git.prMerge",
  "notes.post",
]);

/** A person's collaboration role on a shared workspace (saas contract §21.1). */
export type CollaborationRole = "manager" | "driver" | "viewer" | "none";

/** Who this connection is, from `rpc.hello` when `collab/1` is granted. */
export interface WorkspaceYou {
  userId: string;
  role: CollaborationRole;
  canApprove: boolean;
  /** False while the runtime has no member list yet (then `role` says nothing about sharing). */
  listed?: boolean;
}

export type WorkspaceConnectionState =
  | { state: "idle" | "opening" | "waitingForRuntime" | "suspended" | "updateRequired" | "stopped" }
  | { state: "connecting"; attempt: number }
  | { state: "reconnecting"; attempt: number; reason: string; retryInMs: number }
  | {
      state: "connected";
      runtimeGeneration: number;
      /** The runtime process; absent from a runtime older than PRO-26. */
      runtimeEpoch?: string;
      runtimeVersion: string;
      capabilities: string[];
      authority: "manage" | "participate";
      /** The person behind this connection; only from a runtime that granted `collab/1`. */
      you?: WorkspaceYou | null;
    };

/** Who drives a terminal's input and size: this client, another device, or nobody. */
export type PtyControl = "you" | "other" | "none";

/** An agent process on the runtime. A tab whose process ended keeps its saved conversation. */
export type AgentProcessState = "running" | "exited" | "not-started";
export type AgentTabStatus = "idle" | "in_progress" | "waiting" | "completed";

/** An agent tab as `session.tabs` and `session.configure` describe it (docs/CLOUD-AGENT-TABS.md). */
export interface AgentTabInfo {
  sessionId: string;
  tabId: string;
  title: string | null;
  harness: string;
  model: string;
  effort: string | null;
  permissionMode: string;
  status: AgentTabStatus;
  process: AgentProcessState;
  pendingPermissions: { requestId: string; toolName: string; input: unknown; options: unknown[] }[];
  /** `actorId`: who queued it, on a runtime with `collab/1`. */
  followUps: { clientCommandId: string; text: string; actorId?: string | null }[];
  /** Who holds the tab's input lease, on a runtime with `collab/1`. */
  lease?: { tabId: string; holderId: string; acquiredAt: number; expiresAt: number } | null;
  /**
   * Set when the tab's agent has no way to sign in (PRO-78): `state` is
   * `not-connected` when the organization has no login for `provider`, else
   * the server's state for the one it has (`revoked`, `disconnected`,
   * `unavailable`, with a `reason` such as `token-expired`).
   */
  signIn?: { provider: string; state: string; reason?: string | null } | null;
  lastSeq: number;
  created: string;
  modified: string;
}

/** An agent tab as the runtime's session index stores it. */
export interface RuntimeSessionTab {
  id: string;
  harness: string;
  title?: string | null;
  model: string;
  effort?: string | null;
  permissionMode: string;
  status: AgentTabStatus;
  created: string;
  modified: string;
}

/**
 * A session in the runtime's own index (`session.list`, `session.sessions`).
 * `cwd` and `projectPath` are paths on the VM: never hand them to a local command.
 */
export interface RuntimeSession {
  id: string;
  projectPath: string;
  cwd: string;
  worktreeName?: string | null;
  branch?: string | null;
  title: string;
  created: string;
  modified: string;
  archived: boolean;
  pinned: boolean;
  tabs: RuntimeSessionTab[];
  activeTab?: string | null;
}

/** `session.update`: `undefined` leaves a field as it is. Archiving only hides the session. */
export interface RuntimeSessionPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

/** One model of an agent (`runtime.agents`). */
export interface RuntimeAgentModel {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  acceptsImages: boolean;
  isDefault: boolean;
  upgrade: string | null;
  description: string | null;
  /** A family alias (`opus`): it follows the latest release rather than staying on one version. */
  alias?: boolean;
  /** The full model id an alias runs now, per the runtime's own CLI. */
  resolved?: string | null;
}

/** An agent installed on the runtime (`runtime.agents`, `agents/1`). */
export interface RuntimeAgent {
  id: string;
  name: string;
  caps: Record<string, boolean>;
  models: RuntimeAgentModel[];
  /** Launch modes it takes; empty when it has none. */
  modes: string[];
  defaultMode: string;
}

/** `session.status`: a subscribed tab's turn or process state changed. */
export interface AgentTabStatusChange {
  sessionId: string;
  tabId: string;
  status: AgentTabStatus;
  /** Not sent by the runtime with a status change (it arrives with `session.tabs`). */
  process?: AgentProcessState;
}

export interface SessionSubscribeOptions {
  /** Resume after this cursor instead of replaying the whole transcript. */
  sinceCursor?: string;
  /** The cursor after each event or replay, to keep for the next subscription. */
  onCursor?(cursor: string | undefined): void;
  onStatus?(change: AgentTabStatusChange): void;
}

/** A terminal as `pty.create`, `pty.list` and `pty.attach` describe it. */
export interface PtyInfo {
  ptyId: string;
  number: number;
  /** The runtime process the terminal runs in. */
  epoch: string;
  pid: number | null;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** Bytes the terminal has written so far. */
  offset: number;
  exited: boolean;
  exitCode: number | null;
  control: PtyControl;
  /** The person controlling the terminal (PRO-30); null when nobody does, absent from older runtimes. */
  controllerId?: string | null;
  /** The session the terminal was opened for (`pty/2`); absent otherwise and from older runtimes. */
  sessionId?: string;
  /** An agent tab's own terminal (`agent-pty/1`): the tab, and whether its CLI runs now. */
  tabId?: string;
  running?: boolean;
}

/** Where a terminal view left off, to resume without replaying what it shows. */
export interface PtyCursor {
  offset: number;
  epoch: string;
}

export interface PtyHandlers {
  /**
   * `replay`: the bytes were written before this attach (the ring's replay,
   * or what was missed while away). A terminal emulator must not answer the
   * queries it finds in them: the program that asked is long past them.
   */
  onData(bytes: Uint8Array, offset: number, replay: boolean): void;
  onExit?(code: number | null): void;
  onControl?(control: PtyControl, controllerId?: string | null): void;
  /** The controller resized the terminal; a viewer should match it. */
  onResize?(cols: number, rows: number): void;
  /** Output older than the runtime's ring was lost while away. */
  onTruncated?(): void;
  /** The terminal is gone: closed, or its runtime restarted or was replaced. */
  onGone?(reason: "closed" | "runtime-restarted"): void;
  /** Resume after this point instead of replaying the whole ring. */
  since?: PtyCursor;
}

export interface PtyAttachment {
  /** Where the view is now; keep it to resume on a later connection. */
  cursor(): PtyCursor | undefined;
  detach(): void;
}

/** UTF-16 units per `pty.write`; at most 4 UTF-8 bytes each keeps it under the runtime's 64 KiB. */
const WRITE_CHUNK = 16 * 1024;
const BACKPRESSURE_RETRY_MS = 200;

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
  constructor(readonly code: string, message: string, readonly method: string, readonly data?: unknown) {
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

class PtyInput {
  writerId = randomRequestId();
  /** Last seq the runtime accepted from this writer. */
  seq = 0;
  running = false;
  pending: { data: string; report: boolean; resolve: () => void; reject: (error: unknown) => void }[] = [];

  reset(): void {
    this.writerId = randomRequestId();
    this.seq = 0;
  }
}

const RESEND_WAIT_MS = 15_000;

export class WorkspaceRpcClient {
  private readonly rpc: PortableRpcClient;
  private readonly responseListeners = new Set<(response: RpcResponse) => void>();
  private readonly stateListeners = new Set<(state: WorkspaceConnectionState) => void>();
  private readonly notificationListeners = new Set<(notification: WorkspaceNotification) => void>();
  private readonly detach: (() => void)[] = [];
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly inputs = new Map<string, PtyInput>();
  /** Notifications for a subscription whose id is not known yet (its answer is still being handled). */
  private unrouted: WorkspaceNotification[] = [];
  /** Subscribe requests awaiting their answer. */
  private resuming = 0;
  /** The runtime process each known terminal belongs to. */
  private readonly ptyEpochs = new Map<string, string>();
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

  /**
   * Terminal input. Queued per terminal and sent one numbered write at a
   * time, so it is typed once and in order even across reconnects. Resolves
   * once the runtime accepted it; rejects (never silently drops) when the
   * runtime refuses it, e.g. `not_controller`, an exited terminal, or one
   * whose runtime restarted.
   */
  write(ptyId: string, data: string, options: { report?: boolean } = {}): Promise<void> {
    let input = this.inputs.get(ptyId);
    if (!input) this.inputs.set(ptyId, (input = new PtyInput()));
    // `report`: bytes the terminal emulator produced by itself (a focus
    // report, the answer to a query), not typed by a person. The runtime
    // delivers the controller's, and counts them neither as use of the
    // workspace nor as driving an agent tab.
    const report = options.report === true;
    return new Promise<void>((resolve, reject) => {
      input.pending.push({ data, report, resolve, reject });
      if (!input.running) void this.pumpInput(ptyId, input);
    });
  }

  private async pumpInput(ptyId: string, input: PtyInput): Promise<void> {
    input.running = true;
    try {
      while (input.pending.length && !this.closed) {
        // One write carries input of one kind: what was typed is never sent as a report, nor the other way round.
        const report = input.pending[0]!.report;
        const run = input.pending.findIndex((entry) => entry.report !== report);
        const batch = input.pending.splice(0, run < 0 ? input.pending.length : run);
        try {
          const text = batch.map((entry) => entry.data).join("");
          for (let start = 0; start < text.length; ) {
            let end = Math.min(text.length, start + WRITE_CHUNK);
            // Never split a surrogate pair across two writes.
            if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
            await this.sendInput(ptyId, input, text.slice(start, end), report);
            start = end;
          }
          for (const entry of batch) entry.resolve();
        } catch (error) {
          // Input typed after a refusal was meant for the same state; report it too.
          for (const entry of [...batch, ...input.pending.splice(0)]) entry.reject(error);
        }
      }
    } finally {
      input.running = false;
    }
  }

  private async sendInput(ptyId: string, input: PtyInput, data: string, report: boolean): Promise<void> {
    const seq = input.seq + 1;
    for (;;) {
      const epoch = this.ptyEpochs.get(ptyId);
      if (epoch && this.state.state === "connected" && this.state.runtimeEpoch && this.state.runtimeEpoch !== epoch) {
        throw new WorkspaceRpcError("not_found", "the terminal's runtime restarted", "pty.write");
      }
      try {
        const params = { ptyId, data, seq, writerId: input.writerId, ...(epoch ? { epoch } : {}), ...(report ? { report: true } : {}) };
        await this.resending(() => this.untilDropped(this.rpc.request("pty.write", params)).then((value) => unwrap("pty.write", value)));
        input.seq = seq;
        return;
      } catch (error) {
        if (error instanceof WorkspaceRpcError && error.code === "backpressure" && !this.closed) {
          // The program is not reading yet: the runtime kept nothing, try the same seq again.
          await new Promise((resolve) => setTimeout(resolve, BACKPRESSURE_RETRY_MS));
          continue;
        }
        if (!(error instanceof WorkspaceRpcError)) {
          // Unknown whether it landed; a fresh writer keeps later input from
          // being held behind (or merged with) it.
          input.reset();
        }
        throw error;
      }
    }
  }

  /** `sessionId` needs `pty/2`; an older runtime would open a terminal that belongs to no session. */
  async createPty(params: { cols: number; rows: number; cwd?: string; sessionId?: string }): Promise<PtyInfo> {
    if (params.sessionId !== undefined) this.assertCapability("pty/2", "pty.create");
    const info = await this.mutate<PtyInfo>("pty.create", params);
    this.ptyEpochs.set(info.ptyId, info.epoch);
    return info;
  }

  /**
   * The workspace's listening ports and this connection's open streams
   * (`ports/1`, docs/CLOUD-PREVIEWS.md). `detected: false` where the runtime
   * cannot tell which ports listen. Refused unless the person may open a
   * port: a manager, or a driver who may approve.
   */
  async listPorts(): Promise<{ detected: boolean; ports: { port: number }[]; streams: { streamId: string; port: number }[] }> {
    const listed = await this.call<{ detected?: boolean; ports?: { port: number }[]; streams?: { streamId: string; port: number }[] }>("ports.list");
    return { detected: listed.detected === true, ports: listed.ports ?? [], streams: listed.streams ?? [] };
  }

  async listPtys(): Promise<{ epoch: string; terminals: PtyInfo[] }> {
    const listed = await this.call<{ epoch: string; terminals: PtyInfo[] }>("pty.list");
    for (const info of listed.terminals) this.ptyEpochs.set(info.ptyId, info.epoch);
    return listed;
  }

  /** Only the controller's size is applied; a viewer gets `not_controller`. */
  resizePty(ptyId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
    return this.call("pty.resize", this.withEpoch(ptyId, { ptyId, cols, rows }));
  }

  /**
   * Take over a terminal's input and size explicitly, at this view's size.
   * `start` (an agent tab's terminal only) also starts the tab's CLI when it
   * is not running; without it nothing is ever started.
   */
  controlPty(ptyId: string, cols?: number, rows?: number, options: { start?: boolean } = {}): Promise<PtyInfo> {
    return this.call<PtyInfo>("pty.control", this.withEpoch(ptyId, { ptyId, ...(cols && rows ? { cols, rows } : {}), ...(options.start ? { start: true } : {}) }));
  }

  async killPty(ptyId: string): Promise<void> {
    await this.call("pty.kill", this.withEpoch(ptyId, { ptyId }));
    this.forgetPty(ptyId);
  }

  private withEpoch(ptyId: string, params: Record<string, unknown>): Record<string, unknown> {
    const epoch = this.ptyEpochs.get(ptyId);
    return epoch ? { ...params, epoch } : params;
  }

  private forgetPty(ptyId: string): void {
    this.ptyEpochs.delete(ptyId);
    this.inputs.delete(ptyId);
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

  /**
   * Stream a terminal: replay from the runtime's ring (after `since`, when
   * given), then live output, resuming from the last byte seen after every
   * reconnect or `pty.lagged`. A terminal whose runtime process is no longer
   * the connected one is reported gone, never re-attached by id elsewhere.
   */
  async attachPty(ptyId: string, handlers: PtyHandlers): Promise<PtyAttachment> {
    let cursor: PtyCursor | undefined = handlers.since;
    if (cursor && !this.ptyEpochs.has(ptyId)) this.ptyEpochs.set(ptyId, cursor.epoch);
    let gone = false;
    /** Output before this offset was written before the attach. */
    let replayUntil = 0;
    const markGone = (reason: "closed" | "runtime-restarted") => {
      if (gone) return;
      gone = true;
      this.forgetPty(ptyId);
      handlers.onGone?.(reason);
    };
    const emit = (dataB64: string, offset: number) => {
      const bytes = decodeBase64(dataB64);
      // Replay and live output can overlap by a chunk around a reconnect.
      const skip = cursor === undefined ? 0 : Math.max(0, cursor.offset - offset);
      if (skip < bytes.length) handlers.onData(bytes.subarray(skip), offset + skip, offset + skip < replayUntil);
      cursor = { offset: Math.max(cursor?.offset ?? 0, offset + bytes.length), epoch: this.ptyEpochs.get(ptyId) ?? cursor?.epoch ?? "" };
    };
    const stop = await this.subscribe({
      method: "pty.attach",
      params: { ptyId },
      resumeParams: () => {
        const epoch = this.ptyEpochs.get(ptyId);
        return cursor === undefined || !epoch || this.generation === null
          ? {}
          : { sinceOffset: cursor.offset, runtimeGeneration: this.generation, epoch };
      },
      beforeResume: () => {
        if (gone) return false;
        const epoch = this.ptyEpochs.get(ptyId);
        const runtimeEpoch = this.state.state === "connected" ? this.state.runtimeEpoch : undefined;
        if (epoch && runtimeEpoch && epoch !== runtimeEpoch) {
          markGone("runtime-restarted");
          return false;
        }
        return true;
      },
      onRefused: (error) => {
        if (error.code !== "not_found") return false;
        markGone("closed");
        return true;
      },
      onCursorExpired: () => {
        cursor = undefined;
      },
      onReplay: (result) => {
        const info = result as Partial<PtyInfo> & { data?: string; truncated?: boolean; end?: number; replayEnd?: number };
        if (typeof info.epoch === "string") this.ptyEpochs.set(ptyId, info.epoch);
        // An older runtime does not say where the replay ends: then it is the slice in the answer.
        const sliceEnd = Number(info.offset ?? 0) + decodeBase64(String(info.data ?? "")).length;
        replayUntil = Math.max(Number(info.replayEnd ?? 0), Number(info.end ?? 0), sliceEnd);
        if (info.truncated === true) handlers.onTruncated?.();
        emit(String(info.data ?? ""), Number(info.offset ?? 0));
        if (info.control) handlers.onControl?.(info.control, info.controllerId);
        if (info.cols && info.rows) handlers.onResize?.(info.cols, info.rows);
        if (info.exited === true) handlers.onExit?.(info.exitCode ?? null);
      },
      listener: (notification, resubscribe) => {
        const params = notification.params;
        switch (notification.event) {
          case "pty.output":
            emit(String(params.data), Number(params.offset));
            break;
          case "pty.exit":
            handlers.onExit?.((params.code as number | null | undefined) ?? null);
            break;
          case "pty.control":
            handlers.onControl?.(params.control as PtyControl, params.controllerId as string | null | undefined);
            break;
          case "pty.resized":
            handlers.onResize?.(Number(params.cols), Number(params.rows));
            break;
          case "pty.closed":
            // Closed by another client, or dropped from the exited-terminal limit.
            markGone("closed");
            break;
          case "pty.lagged":
            // The runtime ended this stream because the link fell behind;
            // pick it up again from the last byte shown.
            resubscribe();
            break;
        }
      },
    });
    return { cursor: () => cursor, detach: stop };
  }

  /** An agent tab's events, replayed after the last cursor seen. */
  subscribeSession(sessionId: string, tabId: string, onEvent: (event: unknown) => void, options: SessionSubscribeOptions = {}): Promise<() => void> {
    let cursor: string | undefined = options.sinceCursor;
    const moved = (next: string | undefined) => {
      cursor = next;
      options.onCursor?.(next);
    };
    return this.subscribe({
      method: "session.subscribe",
      params: { sessionId, tabId },
      resumeParams: () => (cursor ? { sinceCursor: cursor } : {}),
      onReplay: (result) => {
        for (const entry of (result.events as { cursor: string; event: unknown }[] | undefined) ?? []) onEvent(entry.event);
        if (typeof result.cursor === "string") moved(result.cursor);
      },
      listener: (notification) => {
        if (notification.event === "session.status") {
          const params = notification.params as unknown as AgentTabStatusChange;
          options.onStatus?.({ sessionId: params.sessionId, tabId: params.tabId, status: params.status, process: params.process });
          return;
        }
        if (notification.event !== "session.event") return;
        moved(String(notification.params.cursor));
        onEvent(notification.params.event);
      },
      // Another runtime generation: the snapshot that follows starts over.
      onCursorExpired: () => moved(undefined),
    });
  }

  /** Every agent tab on the runtime, with its turn and process state. */
  async listAgentTabs(): Promise<AgentTabInfo[]> {
    const result = await this.call<{ tabs?: AgentTabInfo[] }>("session.tabs");
    return result.tabs ?? [];
  }

  /**
   * A new agent tab: one session with one agent process. `useWorktree` gives
   * the session its own worktree on the VM; `prompt` is sent as its first
   * message (both from `session/1`, read by the runtime's `session_ops`).
   */
  createAgentTab(params: {
    agent: string;
    model?: string;
    effort?: string | null;
    mode?: string;
    title?: string;
    prompt?: string;
    useWorktree?: boolean;
  }): Promise<{ sessionId: string; tabId: string; tab?: AgentTabInfo; session?: RuntimeSession }> {
    const defined = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    return this.mutate("session.create", defined);
  }

  /** Stop a tab's agent process; `remove` also drops the tab and its checkpoints. */
  closeAgentTab(sessionId: string, tabId?: string, remove = false): Promise<{ sessionId: string }> {
    return this.mutate("session.close", { sessionId, ...(tabId ? { tabId } : {}), ...(remove ? { remove: true } : {}) });
  }

  async configureAgentTab(params: { sessionId: string; tabId: string; model?: string; effort?: string | null; mode?: string }): Promise<AgentTabInfo> {
    const result = await this.mutate<{ tab: AgentTabInfo }>("session.configure", params);
    return result.tab;
  }

  async markAgentTabRead(sessionId: string, tabId: string): Promise<void> {
    await this.call("session.markRead", { sessionId, tabId });
  }

  /** The sessions this connection may see (`session.list`). */
  async listSessions(): Promise<RuntimeSession[]> {
    const result = await this.call<{ sessions?: RuntimeSession[] }>("session.list");
    return result.sessions ?? [];
  }

  /** Rename, pin or archive a session (`session/2`, manage only). */
  async updateSession(sessionId: string, patch: RuntimeSessionPatch): Promise<RuntimeSession> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const result = await this.mutate<{ session: RuntimeSession }>("session.update", { sessionId, ...defined });
    return result.session;
  }

  /** Another agent tab in an existing session (`session/2`, manage only). */
  addSessionTab(
    sessionId: string,
    params: { agent: string; model?: string; effort?: string | null; mode?: string },
  ): Promise<{ sessionId: string; tabId: string; session: RuntimeSession; tab?: AgentTabInfo | null }> {
    const defined = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    return this.mutate("session.addTab", { sessionId, ...defined });
  }

  /**
   * Delete a session and its transcripts (`session/2`, manage only). With
   * `removeWorktree`, its worktree goes too, with every session in it;
   * `deleted` names them all.
   */
  deleteSession(sessionId: string, options: { removeWorktree?: boolean } = {}): Promise<{ sessionId: string; deleted: string[] }> {
    return this.mutate("session.delete", { sessionId, ...(options.removeWorktree ? { removeWorktree: true } : {}) });
  }

  /** The agents installed on the runtime, with their models, efforts and modes (`agents/1`). */
  async listRuntimeAgents(): Promise<RuntimeAgent[]> {
    const result = await this.call<{ agents?: RuntimeAgent[] }>("runtime.agents");
    return result.agents ?? [];
  }

  /** `session.sessions`: the whole visible session list, after any create, update or delete (`session/2`). */
  onSessions(listener: (sessions: RuntimeSession[]) => void): () => void {
    return this.onNotification((notification) => {
      if (notification.event !== "session.sessions") return;
      const sessions = notification.params.sessions;
      if (Array.isArray(sessions)) listener(sessions as RuntimeSession[]);
    });
  }

  /**
   * Whether the connected runtime granted `capability`. False while not
   * connected: an action that needs a newer runtime stays hidden until it is
   * known to be there.
   */
  hasCapability(capability: WorkspaceCapability): boolean {
    return this.state.state === "connected" && this.state.capabilities.includes(capability);
  }

  /** Ask the runtime to poll the command mailbox now rather than at its next interval. */
  async nudgeMailbox(): Promise<void> {
    await this.call("session.nudge", {});
  }

  /**
   * Changes under a workspace directory (`fs.watch`). `onChange` gets the
   * changed workspace-relative paths, or null when everything shown should
   * be re-read: after a reconnect (changes made while away were not seen)
   * or a burst too large to name.
   */
  watchFiles(path: string, onChange: (paths: string[] | null) => void): Promise<() => void> {
    let resumed = false;
    return this.subscribe({
      method: "fs.watch",
      params: { path },
      resumeParams: () => ({}),
      onReplay: () => {
        if (resumed) onChange(null);
        resumed = true;
      },
      listener: (notification) => {
        if (notification.event !== "fs.changed") return;
        // Too many to name (an install, a checkout): re-read everything.
        if (notification.params.overflow === true) return onChange(null);
        const paths = notification.params.paths;
        if (Array.isArray(paths)) onChange(paths.filter((entry): entry is string => typeof entry === "string"));
      },
    });
  }

  /** Every notification the runtime sends, including broadcasts such as `session.tabs`. */
  onNotification(listener: (notification: WorkspaceNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    for (const stop of this.detach) stop();
    this.rpc.close("Workspace connection closed");
    this.subscriptions.clear();
    this.notificationListeners.clear();
    for (const input of this.inputs.values()) for (const entry of input.pending.splice(0)) entry.reject(new Error("Workspace connection closed"));
    this.inputs.clear();
    this.transport.close();
  }

  private async subscribe(spec: {
    method: Subscription["method"];
    params: Record<string, unknown>;
    resumeParams: () => Record<string, unknown>;
    /** The runtime ended the stream; call this to resume it. */
    listener: (notification: WorkspaceNotification, resubscribe: () => void) => void;
    onReplay: (result: Record<string, unknown>) => void;
    onCursorExpired?: () => void;
    /** False: the subscription is over and is dropped instead of resumed. */
    beforeResume?: () => boolean;
    /** True: the refusal was handled and ends the subscription quietly. */
    onRefused?: (error: WorkspaceRpcError) => boolean;
  }): Promise<() => void> {
    const localId = `local-${++this.nextLocal}`;
    const subscription: Subscription & { resume: () => Promise<void> } = {
      method: spec.method,
      params: spec.params,
      listener: (notification) =>
        spec.listener(notification, () => {
          if (this.subscriptions.get(localId) !== subscription) return;
          subscription.serverId = undefined;
          // Keep trying while the link is up; a reconnect resumes it anyway.
          const retry = (attempt: number) => {
            if (this.closed || this.state.state !== "connected" || this.subscriptions.get(localId) !== subscription || subscription.serverId) return;
            subscription.resume().catch(() => setTimeout(() => retry(attempt + 1), Math.min(10_000, 250 * 2 ** attempt)));
          };
          retry(0);
        }),
      onReplay: spec.onReplay,
      resume: async () => {
        if (spec.beforeResume && !spec.beforeResume()) {
          this.subscriptions.delete(localId);
          return;
        }
        let result: RpcCallResult<Record<string, unknown>>;
        this.resuming++;
        try {
          result = await this.rpc.request(spec.method, { ...spec.params, ...spec.resumeParams() });
        } finally {
          this.resuming--;
        }
        if (!result.ok && result.refusal.code === "cursor_expired") {
          // Another runtime generation: resync from a full snapshot.
          spec.onCursorExpired?.();
          this.resuming++;
          try {
            result = await this.rpc.request(spec.method, spec.params);
          } finally {
            this.resuming--;
          }
        }
        if (!result.ok && spec.onRefused?.(new WorkspaceRpcError(result.refusal.code, result.refusal.message, spec.method))) {
          this.subscriptions.delete(localId);
          return;
        }
        const value = unwrap(spec.method, result);
        subscription.serverId = String(value.subscriptionId);
        spec.onReplay(value);
        const early = this.unrouted.filter((notification) => notification.params.subscriptionId === subscription.serverId);
        if (early.length) {
          this.unrouted = this.unrouted.filter((notification) => notification.params.subscriptionId !== subscription.serverId);
          for (const notification of early) subscription.listener(notification);
        }
        if (this.resuming === 0) this.unrouted = [];
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
      for (const listener of this.notificationListeners) listener(notification);
      const target = notification.params.subscriptionId;
      let routed = false;
      for (const subscription of this.subscriptions.values()) {
        if (subscription.serverId === target) {
          subscription.listener(notification);
          routed = true;
        }
      }
      // Only a subscription whose answer is still on its way can own it;
      // anything else is for a stream this client already ended.
      if (!routed && target && this.resuming > 0) {
        this.unrouted.push(notification);
        if (this.unrouted.length > 256) this.unrouted.shift();
      }
    }
  }

  private changeState(state: WorkspaceConnectionState): void {
    const wasConnected = this.state.state === "connected";
    this.state = state;
    if (wasConnected && state.state !== "connected") {
      this.unrouted = [];
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
    // Nothing reconnects from these on its own; do not hold input for them.
    if (["suspended", "stopped", "updateRequired"].includes(this.state.state)) {
      return Promise.reject(new Error(`Workspace runtime is ${this.state.state}`));
    }
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
    const required = METHOD_CAPABILITIES[method];
    if (required) return this.assertCapability(required, method);
    const namespace = method.split(".")[0];
    if (!this.state.capabilities.some((capability) => capability.startsWith(`${namespace}/`))) {
      throw new WorkspaceRpcError("capability_not_granted", `${namespace} is not available from this runtime`, method);
    }
  }

  /** Refuse before sending when the connected runtime did not grant `capability`. */
  private assertCapability(capability: WorkspaceCapability, method: string): void {
    if (this.state.state !== "connected") return;
    if (!this.state.capabilities.includes(capability)) {
      throw new WorkspaceRpcError("capability_not_granted", `${capability} is not available from this runtime`, method);
    }
  }
}

function unwrap<T>(method: string, result: RpcCallResult<T>): T {
  if (result.ok) return result.value;
  const refusal: RpcErrorData = result.refusal;
  throw new WorkspaceRpcError(refusal.code, refusal.message, method, refusal.data);
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
