import type { RandomSource } from "../transport/e2ee-session";
import { secureRandom } from "../transport/random";
import { CloudApiError, type CloudApi, type CloudCommand } from "./api";
import { commandAad, IV_LEN, open, openReceipt, parseV1, sealCommand, type CommandEnvelope, type CommandKind, type CommandReceipt, type CommandScope } from "./crypto";
import type { WorkspaceKeys } from "./keys";
import type { BlobStorage } from "./transcripts";

/**
 * What this phone has asked a cloud agent to do (contract §11), as the
 * desktop's outbox does it (`src-tauri/src/cloud_agent_client.rs`):
 *
 * - A command is encrypted once. Its envelope is written to the phone before
 *   the first request and resent byte for byte until the API has it, so a
 *   lost answer never becomes a second command.
 * - Only the envelope is kept. The text shown for an entry is opened from it
 *   with the workspace key each time; nothing of a message is stored in the
 *   clear, and neither is the runtime's receipt.
 * - A permission request gets one decision, ever.
 *
 * Posting a command is the one thing here that can start a stopped workspace
 * (the server resumes it for a command, by the sender's role, and answers
 * `wake`). That holds for a first post and for a resend alike, so both are
 * the caller's decision: `enqueue` posts only with `post`, and `sync`
 * delivers what is unsent only with `deliver`. Without them an entry is
 * held on the phone, and `sync` only reads states.
 */

export type OutboxState = "unsent" | "queued" | "leased" | "applied" | "rejected" | "cancelled" | "outcome-unknown";
export const TERMINAL_OUTBOX_STATES: ReadonlySet<OutboxState> = new Set(["applied", "rejected", "cancelled", "outcome-unknown"]);
const KNOWN_STATES: ReadonlySet<string> = new Set(["queued", "leased", "applied", "rejected", "cancelled", "outcome-unknown"]);
/** Settled entries kept for display, per workspace. */
const SETTLED_KEPT = 50;

export type OutboxPayload = { text: string; model?: string; effort?: string | null; mode?: string } | { requestId: string; optionId: string } | { requestId: string; answers: Record<string, string> } | Record<string, never>;

interface Stored {
  envelope: CommandEnvelope;
  state: OutboxState;
  wake: string | null;
  category: string | null;
  /** The runtime's receipt, still encrypted. */
  resultIv: string | null;
  resultCiphertext: string | null;
  createdAt: number;
  updatedAt: number;
  /** The last delivery error code while unsent. */
  error: string | null;
}

export interface OutboxEntry {
  clientCommandId: string;
  tabId: string;
  kind: CommandKind;
  /** Opened from the envelope; null when this phone no longer holds its key. */
  text: string | null;
  requestId: string | null;
  state: OutboxState;
  wake: string | null;
  category: string | null;
  receipt: CommandReceipt | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export class OutboxError extends Error {
  constructor(readonly code: "no-key" | "already-decided") {
    super(code);
    this.name = "OutboxError";
  }
}

const itemName = (scope: CommandScope) => `terminalx:cloud-outbox:${scope.organizationId}:${scope.workspaceId}`;

function uuid(random: RandomSource): string {
  const bytes = random.bytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface OutboxOptions {
  scope: CommandScope;
  api: Pick<CloudApi, "enqueue" | "commandStatuses" | "cancelCommand">;
  keys: WorkspaceKeys;
  storage: BlobStorage;
  random?: RandomSource;
  now?: () => number;
}

export class CloudOutbox {
  private items: Stored[] = [];
  private loaded: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  /** Request ids a decision is being sealed for right now. */
  private readonly deciding = new Set<string>();
  /** One write at a time, in order. */
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly options: OutboxOptions) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  load(): Promise<void> {
    return (this.loaded ??= (async () => {
      await this.options.keys.load();
      const raw = await this.options.storage.getItem(itemName(this.options.scope)).catch(() => null);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as { v?: unknown; items?: Stored[] };
        if (parsed.v === 1 && Array.isArray(parsed.items)) this.items = parsed.items.filter((item) => item?.envelope?.clientCommandId && typeof item.state === "string");
      } catch {
        this.items = [];
      }
    })());
  }

  /** The entries of a tab (or of the workspace), oldest first. */
  entries(tabId?: string): OutboxEntry[] {
    return this.items.filter((item) => !tabId || item.envelope.tabId === tabId).map((item) => this.view(item));
  }

  /** Whether anything is still on its way. */
  get pending(): boolean {
    return this.items.some((item) => !TERMINAL_OUTBOX_STATES.has(item.state));
  }

  /** Whether the server has commands whose outcome is not known yet. */
  get awaiting(): boolean {
    return this.items.some((item) => item.state === "queued" || item.state === "leased");
  }

  /** Whether anything has not left the phone. */
  get unsent(): boolean {
    return this.items.some((item) => item.state === "unsent");
  }

  /** A decision for this request that is, or may be, on its way: never queue another. */
  decisionFor(requestId: string): OutboxEntry | null {
    return (
      this.entries().find((entry) => entry.kind === "permission-decision" && entry.requestId === requestId && !(entry.state === "cancelled" || (entry.state === "rejected" && entry.category !== "request-not-pending"))) ?? null
    );
  }

  isDeciding(requestId: string): boolean {
    return this.deciding.has(requestId) || !!this.decisionFor(requestId);
  }

  /**
   * Seal and keep, then post if `post`. An entry that was not posted, or
   * could not be (offline), stays `unsent` until a `sync` that may deliver.
   */
  async enqueue(tabId: string, kind: CommandKind, payload: OutboxPayload, options: { post?: boolean } = {}): Promise<OutboxEntry> {
    await this.load();
    const requestId = kind === "permission-decision" && "requestId" in payload ? payload.requestId : null;
    if (requestId) {
      const existing = this.decisionFor(requestId);
      if (existing) return existing;
      if (this.deciding.has(requestId)) throw new OutboxError("already-decided");
      this.deciding.add(requestId);
    }
    try {
      const held = this.options.keys.current();
      // Without the workspace key nothing can be sealed: this phone has to connect to the running workspace once.
      if (!held) throw new OutboxError("no-key");
      const random = this.options.random ?? secureRandom;
      const now = (this.options.now ?? Date.now)();
      const envelope = sealCommand({ scope: this.options.scope, tabId, clientCommandId: uuid(random), kind, payload, keyId: held.keyId, key: held.key, iv: random.bytes(IV_LEN) });
      const item: Stored = { envelope, state: "unsent", wake: null, category: null, resultIv: null, resultCiphertext: null, createdAt: now, updatedAt: now, error: null };
      this.items = [...this.items, item];
      // On the phone before it is on the wire.
      await this.save();
      this.publish();
      if (options.post !== false) {
        await this.post(item);
        await this.save();
        this.publish();
      }
      return this.view(item);
    } finally {
      if (requestId) this.deciding.delete(requestId);
    }
  }

  /**
   * Read the state of what is on its way and, only with `deliver`, post what
   * is unsent. Posting to a stopped workspace starts it, so the caller says
   * `deliver` only while the workspace runs or the person agreed to start it.
   * Returns whether anything changed.
   */
  async sync(options: { deliver?: boolean | (() => boolean) } = {}): Promise<boolean> {
    await this.load();
    const before = this.fingerprint();
    const { deliver } = options;
    // A function is asked again before each post: the permission can end while earlier ones are on their way.
    const may = () => (typeof deliver === "function" ? deliver() : deliver === true);
    for (const item of this.items.filter((entry) => entry.state === "unsent")) {
      if (!may()) break;
      await this.post(item);
    }
    const open_ = this.items.filter((entry) => entry.state === "queued" || entry.state === "leased");
    if (open_.length) {
      const commands = await this.options.api.commandStatuses(this.options.scope.organizationId, this.options.scope.workspaceId, open_.map((entry) => entry.envelope.clientCommandId));
      for (const command of commands) {
        const item = this.items.find((entry) => entry.envelope.clientCommandId === command.clientCommandId);
        if (item) this.apply(item, command);
      }
    }
    const changed = this.fingerprint() !== before;
    if (changed) {
      await this.save();
      this.publish();
    }
    return changed;
  }

  /** Withdraw a command the runtime has not taken yet. One that never left the phone is dropped here. */
  async cancel(clientCommandId: string): Promise<void> {
    await this.load();
    const item = this.items.find((entry) => entry.envelope.clientCommandId === clientCommandId);
    if (!item || TERMINAL_OUTBOX_STATES.has(item.state)) return;
    try {
      this.apply(item, await this.options.api.cancelCommand(this.options.scope.organizationId, this.options.scope.workspaceId, clientCommandId));
    } catch (error) {
      // The server never had it: it is cancelled by not being sent.
      if (item.state === "unsent" && error instanceof CloudApiError && error.status === 404) this.settle(item, "cancelled", null);
      else throw error;
    }
    await this.save();
    this.publish();
  }

  /** Forget everything of this workspace (deleted, access removed, signed out). */
  async clear(): Promise<void> {
    this.items = [];
    this.loaded = Promise.resolve();
    await this.options.storage.removeItem(itemName(this.options.scope)).catch(() => undefined);
    this.publish();
  }

  private async post(item: Stored): Promise<void> {
    try {
      const answer = await this.options.api.enqueue(this.options.scope.organizationId, this.options.scope.workspaceId, item.envelope);
      item.wake = answer.wake;
      item.error = null;
      this.apply(item, answer.command);
    } catch (error) {
      const api = error instanceof CloudApiError ? error : new CloudApiError("cloud_workspace_unavailable", null);
      // The service or the network: it stays unsent, to be delivered later. A refusal (no access, viewer, workspace gone) is the answer.
      if (api.unreachable || api.status === 401) item.error = api.code;
      else this.settle(item, "rejected", api.code);
    }
  }

  private apply(item: Stored, command: CloudCommand): void {
    // An answer for another command or tab is not this entry's.
    if (command.clientCommandId !== item.envelope.clientCommandId || command.tabId !== item.envelope.tabId) return;
    if (!KNOWN_STATES.has(command.state)) return;
    // A settled entry never goes back.
    if (TERMINAL_OUTBOX_STATES.has(item.state) && item.state !== command.state) return;
    const next = command.state as OutboxState;
    if (next !== item.state || (command.resultCiphertext && !item.resultCiphertext)) item.updatedAt = (this.options.now ?? Date.now)();
    item.state = next;
    item.category = command.outcomeCategory ?? item.category;
    if (command.resultIv && command.resultCiphertext) {
      item.resultIv = command.resultIv;
      item.resultCiphertext = command.resultCiphertext;
    }
  }

  private settle(item: Stored, state: OutboxState, category: string | null): void {
    item.state = state;
    item.category = category;
    item.error = null;
    item.updatedAt = (this.options.now ?? Date.now)();
  }

  private view(item: Stored): OutboxEntry {
    const { envelope } = item;
    const scope = this.options.scope;
    let payload: Record<string, unknown> | null = null;
    const held = this.options.keys.get(envelope.keyId);
    if (held) {
      try {
        payload = parseV1(open(held.key, envelope.iv, envelope.ciphertext, commandAad(scope.organizationId, scope.workspaceId, envelope.tabId, envelope.clientCommandId, envelope.kind, envelope.keyId)));
      } catch {
        payload = null;
      }
    }
    let receipt: CommandReceipt | null = null;
    if (item.resultIv && item.resultCiphertext) {
      const own = held ? [held] : [];
      receipt = openReceipt({ scope, clientCommandId: envelope.clientCommandId, resultIv: item.resultIv, resultCiphertext: item.resultCiphertext, keys: [...own, ...this.options.keys.all().filter((key) => key !== held)] });
    }
    return {
      clientCommandId: envelope.clientCommandId,
      tabId: envelope.tabId,
      kind: envelope.kind,
      text: typeof payload?.text === "string" ? payload.text : null,
      requestId: typeof payload?.requestId === "string" ? payload.requestId : null,
      state: item.state,
      wake: item.wake,
      category: (typeof receipt?.category === "string" ? receipt.category : null) ?? item.category,
      receipt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      error: item.error,
    };
  }

  private fingerprint(): string {
    return JSON.stringify(this.items.map((item) => [item.envelope.clientCommandId, item.state, item.updatedAt, item.error, item.resultCiphertext ? 1 : 0]));
  }

  private save(): Promise<void> {
    const settled = this.items.filter((item) => TERMINAL_OUTBOX_STATES.has(item.state));
    if (settled.length > SETTLED_KEPT) {
      const drop = new Set(settled.slice(0, settled.length - SETTLED_KEPT));
      this.items = this.items.filter((item) => !drop.has(item));
    }
    const body = JSON.stringify({ v: 1, items: this.items });
    this.saving = this.saving.then(() => this.options.storage.setItem(itemName(this.options.scope), body)).catch(() => undefined);
    return this.saving;
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
