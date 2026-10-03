import { sha256 } from "@noble/hashes/sha256";
import type { RpcWireRequest } from "@terminalx/portable/rpc";
import type { WorkspaceConnectionState, WorkspaceTransport, WorkspaceYou } from "@terminalx/portable/workspace";
import { RelayPhoneHelloSchema, type PairingOffer } from "../pairing/contracts";
import { parsePairingCodeOrThrow } from "../pairing/parse";
import { MobileE2EESession, type RandomSource } from "../transport/e2ee-session";
import { secureRandom } from "../transport/random";
import { CloudApiError, type AttachTicket, type CloudApi } from "./api";
import { b64 } from "./crypto";

/**
 * The phone's connection to one cloud workspace's runtime: the transport the
 * shared `WorkspaceRpcClient` runs on (`packages/portable/src/workspace.ts`).
 * It follows the desktop's supervisor (`src-tauri/src/remote/client.rs`):
 *
 *   open (API) → relay attach with the ticket → the end-to-end encrypted
 *   handshake the phone already speaks → `rpc.hello` → frames.
 *
 * Looking never wakes compute, and this class cannot: it has no call that
 * resumes a workspace. It asks for an attachment only while the list says the
 * workspace is running; for a stopped or archived one it parks as
 * `suspended` and waits to be told the list changed (`listChanged`). A
 * stopped workspace is resumed only by a queued command, which is the
 * mailbox's business, not this connection's.
 *
 * A phone is always a `participate` attachment (session scope).
 */

export const WORKSPACE_PROTOCOL = "terminalx-workspace-rpc/1";
/** What a phone asks for: agent sessions, the content key, sharing. No terminals, files or Git. */
export const PHONE_CAPABILITIES = ["session/1", "session/2", "keys/1", "collab/1", "agents/1"] as const;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 10_000;
const WAITING_POLL_MS = 1_500;
/** A ticket this close to its expiry is not used for a new connection. */
const TICKET_MARGIN_MS = 10_000;

type SocketLike = Pick<WebSocket, "send" | "close" | "readyState"> & {
  binaryType: string;
  OPEN: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
};

export interface CloudLinkOptions {
  api: Pick<CloudApi, "open">;
  target: { orgId: string; workspaceId: string };
  clientInstallationId: string;
  /** The workspace's state as the list last said it (`ready`, `suspended`, `provisioning`, `archived`, …); null when it is not listed. */
  workspaceState: () => string | null;
  appVersion: string;
  createSocket?: (url: string) => SocketLike;
  random?: RandomSource;
  now?: () => number;
}

/** Why the connection is not up, beside its state: the API's or the relay's own word, for the screen to put in words. */
export type CloudLinkProblem = { kind: "api"; code: string; unreachable: boolean } | { kind: "relay"; code: number | null } | { kind: "protocol"; message: string } | null;

export class CloudWorkspaceLink implements WorkspaceTransport {
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly states = new Set<(state: WorkspaceConnectionState) => void>();
  private current: WorkspaceConnectionState = { state: "idle" };
  private issue: CloudLinkProblem = null;
  private socket: SocketLike | null = null;
  private session: MobileE2EESession | null = null;
  private running = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The offer of the attachment in use: the relay and the runtime's pinned key. */
  private offer: PairingOffer | null = null;
  /** Installed after an invite connect, in memory only: reconnects use it instead of a new pairing. */
  private resumeToken: string | null = null;
  private refreshPairing = false;
  private calls = 0;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** Bumped whenever the connection in progress is abandoned, so its late callbacks do nothing. */
  private generation = 0;

  constructor(private readonly options: CloudLinkOptions) {}

  get state(): WorkspaceConnectionState {
    return this.current;
  }

  /** What stands in the way, when not connected. */
  get problem(): CloudLinkProblem {
    return this.issue;
  }

  /** Start connecting, and keep the connection up until `close`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.attach();
  }

  /** The workspace list was read again: a parked link looks at the new state. */
  listChanged(): void {
    if (!this.running) return;
    const parked = this.current.state === "suspended" || this.current.state === "stopped" || this.current.state === "waitingForRuntime";
    if (parked && !this.socket) {
      this.clearTimer();
      void this.attach();
    }
  }

  send(frame: RpcWireRequest): boolean {
    // Refused at once while not connected, so the caller resends after the next connect.
    if (this.current.state !== "connected" || !this.socket || !this.session || this.socket.readyState !== this.socket.OPEN) return false;
    this.socket.send(this.session.sealText(JSON.stringify(frame)));
    return true;
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onState(listener: (state: WorkspaceConnectionState) => void): () => void {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }

  close(): void {
    this.running = false;
    this.clearTimer();
    this.dropSocket();
    this.resumeToken = null;
    this.offer = null;
    this.setState({ state: "idle" });
  }

  // ---- supervisor ----------------------------------------------------------

  private async attach(): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    const listed = this.options.workspaceState();
    // Never asked of a workspace that is not running: asking is how a desktop
    // wakes one, and a phone only looks.
    if (listed !== "ready") {
      this.issue = null;
      if (listed === "provisioning") {
        this.setState({ state: "waitingForRuntime" });
        this.later(WAITING_POLL_MS, () => void this.attach());
      } else if (listed === "suspended" || listed === "archived") {
        this.setState({ state: "suspended" });
      } else {
        // Not listed for this person, deleted, or needing attention: nothing to connect to.
        this.setState({ state: "stopped" });
      }
      return;
    }
    this.setState(this.attempt === 0 ? { state: "opening" } : this.current);
    let attachment;
    try {
      attachment = await this.options.api.open(this.options.target.orgId, this.options.target.workspaceId, this.options.clientInstallationId, { refreshPairing: this.refreshPairing });
    } catch (error) {
      if (generation !== this.generation || !this.running) return;
      const api = error instanceof CloudApiError ? error : new CloudApiError("cloud_workspace_unavailable", null);
      this.issue = { kind: "api", code: api.code, unreachable: api.unreachable };
      // The service or the network: try again. A refusal (no access, stopped
      // meanwhile, signed out) is an answer: wait for the list to say otherwise.
      if (api.unreachable) this.retry(`api:${api.code}`);
      else this.setState({ state: "stopped" });
      return;
    }
    if (generation !== this.generation || !this.running) return;
    if (attachment.state !== "ready" || !attachment.pairingCode) {
      this.issue = null;
      this.setState({ state: "waitingForRuntime" });
      this.later(WAITING_POLL_MS, () => void this.attach());
      return;
    }
    const ticket = attachment.attachTicket ?? null;
    let offer: PairingOffer;
    try {
      offer = parsePairingCodeOrThrow(attachment.pairingCode, this.options.now);
      // A phone attaches with session scope and proves who it is; anything else is not this API's offer.
      if (!offer.relay || offer.scope !== "session" || offer.identityMode !== "authenticate") throw new Error("offer");
    } catch {
      // A resume credential needs no fresh invite: the relay and key of the offer already held still stand.
      if (!this.resumeToken || !this.offer) {
        this.issue = { kind: "protocol", message: "The workspace's pairing offer could not be read." };
        this.refreshPairing = true;
        this.retry("offer");
        return;
      }
      offer = this.offer;
    }
    if (ticket && ticket.expiresAt - (this.options.now?.() ?? Date.now()) < TICKET_MARGIN_MS) {
      // Too close to its expiry to finish a handshake with: ask again.
      this.later(0, () => void this.attach());
      return;
    }
    this.refreshPairing = false;
    // The same runtime key means the resume credential installed earlier is still its own.
    const resume = this.resumeToken && this.offer && this.offer.publicKeyB64 === offer.publicKeyB64 ? this.resumeToken : null;
    if (!resume) this.resumeToken = null;
    this.offer = offer;
    this.connect(generation, offer, ticket, resume);
  }

  private connect(generation: number, offer: PairingOffer, ticket: AttachTicket | null, resume: string | null): void {
    const relay = offer.relay!;
    this.setState({ state: "connecting", attempt: this.attempt });
    const session = MobileE2EESession.create({ desktopPublicKeyB64: offer.publicKeyB64, transport: "relay", relayHostId: relay.relayHostId, random: this.options.random ?? secureRandom });
    const url = new URL(relay.cellUrl);
    url.protocol = "wss:";
    url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`;
    const socket = (this.options.createSocket ?? ((target: string) => new WebSocket(target) as unknown as SocketLike))(url.toString());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.session = session;
    let phase: "relay" | "ready" | "auth" | "open" = "relay";
    const stale = () => generation !== this.generation || this.socket !== socket;
    const fail = (problem: CloudLinkProblem, code: number | null) => {
      if (stale()) return;
      this.issue = problem;
      this.dropSocket();
      this.closed(code);
    };
    this.handshakeTimer = setTimeout(() => fail({ kind: "protocol", message: "The workspace did not answer in time." }, null), HANDSHAKE_TIMEOUT_MS);
    socket.onopen = () => {
      if (stale()) return;
      const credential = resume ?? relay.inviteToken;
      socket.send(JSON.stringify(ticket ? { type: "relay-auth", v: 2, mode: "connect", credential, attachTicket: ticket.token } : { type: "relay-auth", v: 1, mode: "connect", credential }));
    };
    socket.onerror = () => fail({ kind: "relay", code: null }, null);
    socket.onclose = (event) => fail({ kind: "relay", code: event.code ?? null }, event.code ?? null);
    socket.onmessage = (event) => {
      if (stale()) return;
      try {
        if (phase === "relay") {
          const hello = RelayPhoneHelloSchema.safeParse(JSON.parse(String(event.data)));
          if (!hello.success) throw new Error("The relay sent no hello.");
          if (!hello.data.ok) return fail({ kind: "relay", code: hello.data.code }, hello.data.code);
          if (hello.data.credentialKind !== (resume ? "resume" : "invite")) throw new Error("The relay accepted a different credential.");
          phase = "ready";
          socket.send(JSON.stringify(session.hello));
          return;
        }
        if (phase === "ready") {
          if (typeof event.data !== "string" || !session.acceptReady(JSON.parse(event.data))) throw new Error("The workspace's key did not match its offer.");
          phase = "auth";
          socket.send(session.sealText(JSON.stringify({ type: "e2ee_auth", v: 2, transcriptHashB64: session.transcriptHashB64, deviceToken: offer.deviceToken })));
          return;
        }
        if (typeof event.data !== "string") return; // The phone asks for nothing binary.
        const text = session.openText(event.data);
        if (text === null) throw new Error("An encrypted frame was out of order.");
        const value: unknown = JSON.parse(text);
        if (phase === "auth") {
          const record = value as { type?: unknown; transcriptHashB64?: unknown };
          if (record.type !== "e2ee_authenticated" || record.transcriptHashB64 !== session.transcriptHashB64) throw new Error("The workspace did not authenticate this device.");
          phase = "open";
          void this.establish(generation, ticket, !resume).catch((error: unknown) => fail({ kind: "protocol", message: error instanceof Error ? error.message : String(error) }, error instanceof GenerationMismatch ? 4101 : null));
          return;
        }
        this.receive(value);
      } catch (error) {
        fail({ kind: "protocol", message: error instanceof Error ? error.message : String(error) }, null);
      }
    };
  }

  /** Install a resume credential on an invite connection, then negotiate `rpc.hello` and check the generation against the ticket. */
  private async establish(generation: number, ticket: AttachTicket | null, invited: boolean): Promise<void> {
    if (invited) {
      const token = b64((this.options.random ?? secureRandom).bytes(32));
      try {
        await this.call("pairing.provisionRelay", { reqId: `resume-${b64((this.options.random ?? secureRandom).bytes(16))}`, newResumeTokenHash: b64(sha256(new TextEncoder().encode(token))) });
        this.resumeToken = token;
      } catch {
        // Still usable now; the next reconnect asks for a new pairing.
        this.resumeToken = null;
      }
    }
    const hello = (await this.call("rpc.hello", { protocol: WORKSPACE_PROTOCOL, client: { app: "terminalx-mobile", version: this.options.appVersion }, want: [...PHONE_CAPABILITIES] })) as {
      runtime?: { version?: unknown; runtimeGeneration?: unknown; epoch?: unknown };
      capabilities?: unknown;
      authority?: unknown;
      you?: unknown;
    };
    if (generation !== this.generation) return;
    const runtimeGeneration = typeof hello.runtime?.runtimeGeneration === "number" ? hello.runtime.runtimeGeneration : 0;
    // Defence in depth behind the relay's own fence: an older runtime's answer is not this attachment's.
    if (ticket && runtimeGeneration !== ticket.runtimeGeneration) throw new GenerationMismatch();
    // The API never gives a phone runtime scope; a runtime that says otherwise is not believed.
    if (hello.authority !== "participate") throw new Error("The workspace granted a phone more than it may hold.");
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.attempt = 0;
    this.issue = null;
    const you = hello.you && typeof hello.you === "object" ? (hello.you as WorkspaceYou) : undefined;
    this.setState({
      state: "connected",
      runtimeGeneration,
      runtimeEpoch: typeof hello.runtime?.epoch === "string" ? hello.runtime.epoch : undefined,
      runtimeVersion: typeof hello.runtime?.version === "string" ? hello.runtime.version : "",
      capabilities: Array.isArray(hello.capabilities) ? hello.capabilities.filter((item): item is string => typeof item === "string") : [],
      authority: "participate",
      ...(you ? { you } : {}),
    });
  }

  private call(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    const session = this.session;
    if (!socket || !session) return Promise.reject(new Error("not connected"));
    const id = `link-${++this.calls}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(session.sealText(JSON.stringify({ id, method, params })));
    });
  }

  private receive(value: unknown): void {
    const record = value as { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (typeof record?.id === "string" && this.pending.has(record.id)) {
      const waiting = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      if (record.ok === true) waiting.resolve(record.result);
      else waiting.reject(new Error(`${String(record.error?.code ?? "refused")}`));
      return;
    }
    for (const listener of [...this.messages]) listener(value);
  }

  /** The socket went away: what its close code asks for (`remote/protocol.rs`, `close_action`). */
  private closed(code: number | null): void {
    if (!this.running) return;
    if (code === 4103) {
      // The runtime speaks a newer protocol: only an app update helps.
      this.setState({ state: "updateRequired" });
      return;
    }
    if (code === 4401) {
      // The relay refused the credential itself: it is gone, ask for a new pairing.
      this.resumeToken = null;
      this.refreshPairing = true;
    }
    // 4100/4404 (not ready), 4101 (older generation), 4102 (ticket), 4409 (another cell) and anything else all go back through `open`, which answers with what is current.
    if (!this.resumeToken) this.refreshPairing = true;
    this.retry(code === null ? "closed" : `relay:${code}`);
  }

  private retry(reason: string): void {
    if (!this.running) return;
    this.attempt += 1;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(this.attempt - 1, 10));
    // Jitter, so many phones do not return at the same instant.
    const jitter = (this.options.random ?? secureRandom).bytes(1)[0]! / 255;
    const retryInMs = Math.round(ceiling / 2 + (ceiling / 2) * jitter);
    this.setState({ state: "reconnecting", attempt: this.attempt, reason, retryInMs });
    this.later(retryInMs, () => void this.attach());
  }

  private later(ms: number, run: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private dropSocket(): void {
    this.generation += 1;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.session = null;
    for (const waiting of this.pending.values()) waiting.reject(new Error("closed"));
    this.pending.clear();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }

  private setState(state: WorkspaceConnectionState): void {
    this.current = state;
    for (const listener of [...this.states]) listener(state);
  }
}

class GenerationMismatch extends Error {
  constructor() {
    super("The workspace runtime was replaced since this attachment was issued.");
  }
}
