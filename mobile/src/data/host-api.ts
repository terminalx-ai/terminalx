import * as Crypto from "expo-crypto";
import { mergeAgentEvents, type AgentEvent } from "@terminalx/portable/events";
import { isAgentEvent, isSyncCursor, type SyncCursor } from "./transcript-cache";
import type { HostConnection } from "../transport/connection";

export type SessionStatus = "idle" | "in_progress" | "completed" | "waiting";
export interface SessionSummary {
  id: string;
  title: string;
  project: string;
  worktree: string;
  modified: string;
  lastPrompt?: string;
  lastReply?: string;
  issueRef?: string;
  tabs: { id: string; title?: string | null; harness: string; status: SessionStatus }[];
}

/** A note promoted to a tab's agent: the `seq` of the user message it became (#541). */
export interface NotePromotion { tabId: string; seq: number }
export interface ChatNote { id: string; body: string; createdAt: number; author: { userId: string; displayName?: string }; promotedTo?: NotePromotion[] }
export type PostNoteResult = { sent: true; note: ChatNote } | { sent: false; message: string };
export type SendResult = { sent: true; queued: boolean } | { sent: false; message: string };
export interface AttachmentInput { mediaType: string; data: string; name?: string }
/**
 * What the Mac understands beyond the first protocol. `sendIds`: sends and notes take a `clientMessageId` (#675).
 * `sessionCreate`: it starts sessions as its new-session view does. `macSettings`: it shows and changes its settings.
 */
export interface HostFeatures { transcript?: number; conditionalLists?: number; sendIds?: number; sessionCreate?: number; macSettings?: number }

/** A project on the Mac, named by an id that is not its path. */
export interface NewSessionProject { id: string; name: string; git: boolean; lastUsed: boolean }
export interface NewSessionModel { id: string; label: string; isDefault: boolean; efforts: string[]; defaultEffort?: string | null }
export interface NewSessionAgent { id: string; name: string; available: boolean; installHint: string; effort: boolean; permissionModes: boolean; models: NewSessionModel[] }
/** What the Mac's new-session view lets a person choose. */
export interface NewSessionOptions { projects: NewSessionProject[]; agents: NewSessionAgent[]; modes: { id: string; label: string }[]; defaultMode: string; nativeCodex: boolean }
export interface NewSessionRequest {
  /** A quick chat, or a project's session: in a new worktree, or on its checkout. */
  where: { quick: true } | { projectId: string; useWorktree: boolean };
  agent: string;
  model: string;
  effort?: string | null;
  mode?: string | null;
  title?: string;
  text: string;
  attachments?: AttachmentInput[];
}
/** A session the Mac started. `sendError`: its first message was not sent, and the session is there to retry in. */
export type NewSessionResult =
  | { created: true; sessionId: string; tabId: string; title: string; native: boolean; queued?: boolean; sendError?: string }
  | { created: false; message: string };
/** This Mac's settings a phone shows and may change. */
export interface MacSettings { nativeCodex: boolean }

export class HostApi {
  private readonly clientId = `mobile-${Crypto.randomUUID()}`;

  private capabilities?: Promise<HostFeatures>;
  private lists = new Map<string, { version: string; value: unknown }>();
  private pendingLists = new Map<string, Promise<unknown>>();

  constructor(private readonly connection: HostConnection) {}

  resetConnection(hostChanged = false): void {
    this.capabilities = undefined;
    if (hostChanged) { this.lists = new Map(); this.pendingLists = new Map(); }
  }

  /** The path requests go over right now; null while disconnected. */
  transport(): "direct" | "relay" | null {
    return this.connection.transport();
  }

  /** Whether the Mac reassembles fragments, which also means it sizes transcript pages to the connection (#669). */
  reassemblesFragments(): Promise<boolean> {
    return this.connection.reassemblesFragments();
  }

  features(): Promise<HostFeatures> {
    if (this.capabilities) return this.capabilities;
    const pending = this.connection.request<HostFeatures>("sync.capabilities")
      .then((result) => result.ok ? result.value : {})
      .catch((cause) => { if (this.capabilities === pending) this.capabilities = undefined; throw cause; });
    this.capabilities = pending;
    return pending;
  }

  private async list(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const key = JSON.stringify([method, params]);
    const pending = this.pendingLists.get(key);
    if (pending) return pending;
    const cache = this.lists;
    const requests = this.pendingLists;
    const task = (async () => {
      const supported = (await this.features()).conditionalLists === 1;
      if (cache !== this.lists) return null;
      const previous = cache.get(key);
      const result = await this.connection.request<Record<string, unknown>>(method, supported && previous ? { ...params, version: previous.version } : params);
      if (!result.ok) return null;
      if (result.value.notModified === true) return previous?.value ?? null;
      if (supported && typeof result.value.version === "string") cache.set(key, { version: result.value.version, value: result.value });
      return result.value;
    })();
    requests.set(key, task);
    try { return await task; } finally { requests.delete(key); }
  }

  async syncTranscript(sessionId: string, tabId: string, cursor?: SyncCursor): Promise<SyncPage> {
    const result = await this.connection.request<unknown>("session.sync", { sessionId, tabId, ...(cursor ? { cursor } : {}) });
    if (!result.ok) throw new Error(result.refusal.message);
    const page = result.value as SyncPage;
    if (page?.deleted === true) return page;
    if (!page || !Array.isArray(page.events) || page.events.length > 500 || !page.events.every((e) => isAgentEvent(e) && e.sessionId === sessionId && e.tabId === tabId) || !isSyncCursor(page.cursor) || typeof page.reset !== "boolean" || typeof page.hasMore !== "boolean" || typeof page.hasEarlier !== "boolean") throw new Error("Invalid transcript sync response");
    if (!page.reset && (!cursor || page.cursor.offset !== cursor.offset + page.events.length || (page.hasMore && !page.events.length))) throw new Error("Non-contiguous transcript sync response");
    return page;
  }

  /** What the computer calls itself (PRO-87). Null from a desktop that predates the question, or when it has no name to give. */
  async describe(): Promise<string | null> {
    const result = await this.connection.request<unknown>("host.describe");
    if (!result.ok) return null;
    const name = (result.value as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : null;
  }

  /** Ask the computer to drop this phone from its paired devices. Best effort: true only when it said it did. */
  async forgetPairing(): Promise<boolean> {
    const result = await this.connection.request<unknown>("pairing.forget");
    return result.ok && (result.value as { forgotten?: unknown } | null)?.forgotten === true;
  }

  async summaries(): Promise<SessionSummary[] | null> {
    const value = await this.list("sessions.summaries") as { sessions?: unknown } | null;
    return Array.isArray(value?.sessions) ? value.sessions.filter(isSessionSummary) : null;
  }

  async tail(sessionId: string, tabId: string, before?: number): Promise<{ events: AgentEvent[]; hasMore: boolean }> {
    // Load the newest turn first and page backwards. Older Macs do not bound
    // transcript bytes, so asking for many tool-heavy turns can close the socket.
    const result = await this.connection.request<unknown>("session.tail", { sessionId, tabId, ...(before === undefined ? {} : { before }), limit: 1 });
    if (!result.ok) throw new Error(result.refusal.message);
    const value = result.value as { events?: unknown; hasMore?: unknown };
    if (!Array.isArray(value?.events) || !value.events.every(isAgentEvent) || typeof value.hasMore !== "boolean" || (value.hasMore && !value.events.length)) {
      throw new Error("The Mac returned an invalid transcript page. Try loading it again.");
    }
    return { events: value.events, hasMore: value.hasMore };
  }

  subscribeSession(tabId: string, listener: (event: AgentEvent) => void, ready?: () => void): () => void {
    return this.connection.subscribe("session.subscribe", { tabId }, (result) => {
      if (result && typeof result === "object" && "subscriptionId" in result) ready?.();
      const event = result && typeof result === "object" && "event" in result ? (result as { event?: unknown }).event : result;
      if (isAgentEvent(event) && event.tabId === tabId) listener(event);
    });
  }

  async listNotes(sessionId: string): Promise<ChatNote[]> {
    const value = await this.list("chat.list", { worktreeId: sessionId, limit: 100 }) as { messages?: unknown } | null;
    const messages = value?.messages;
    return Array.isArray(messages) ? messages.flatMap(readNote).sort((left, right) => left.createdAt - right.createdAt) : [];
  }

  /**
   * `messageId` names the draft (#675): sending it again after a lost reply
   * gets the Mac's first reply instead of a second note or prompt. An older
   * Mac refuses the field, so it is sent only to one that reports `sendIds`.
   */
  async postNote(sessionId: string, text: string, messageId?: string): Promise<PostNoteResult> {
    const result = await this.connection.request<{ status?: unknown; message?: unknown }>("chat.post", { worktreeId: sessionId, body: text, ...await this.messageId(messageId) });
    if (!result.ok) return { sent: false, message: result.refusal.message };
    if (result.value.status === "sent" && isChatNote(result.value.message)) return { sent: true, note: result.value.message };
    return { sent: false, message: "The host did not add this note." };
  }

  /** `messageId`: as for `postNote`. */
  async sendSession(tabId: string, text: string, attachments: AttachmentInput[] = [], messageId?: string): Promise<SendResult> {
    const result = await this.connection.request<{ status?: unknown; queued?: unknown }>("session.send", {
      tabId,
      text,
      ...(attachments.length ? { attachments } : {}),
      ...await this.messageId(messageId),
    });
    if (!result.ok) return { sent: false, message: result.refusal.message };
    if (result.value.status === "sent" && typeof result.value.queued === "boolean") return { sent: true, queued: result.value.queued };
    return { sent: false, message: "The host did not send this message to the agent." };
  }

  private async messageId(messageId: string | undefined): Promise<{ clientMessageId?: string }> {
    if (!messageId) return {};
    return (await this.features()).sendIds === 1 ? { clientMessageId: messageId } : {};
  }

  async respondPermission(sessionId: string, tabId: string, requestId: string, optionId: string): Promise<{ answered: true } | { answered: false; message: string }> {
    const result = await this.connection.request<{ status?: string }>("permission.respond", { sessionId, tabId, requestId, optionId });
    if (result.ok && result.value.status === "answered") return { answered: true };
    return { answered: false, message: result.ok ? "The host did not answer this request." : result.refusal.message };
  }

  subscribeTerminal(sessionId: string, tabId: string, listener: (value: { type: string; chunk?: string; serialized?: string }) => void): () => void {
    return this.connection.subscribe("terminal.subscribe", {
      worktreeId: sessionId,
      tabId,
      attachMode: "observe",
      client: { id: this.clientId, type: "mobile" },
      capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1, writeUnavailable: 1 },
    }, (result) => {
      if (!result || typeof result !== "object") return;
      const value = result as { type?: unknown; chunk?: unknown; serialized?: unknown };
      if (typeof value.type !== "string") return;
      listener({ type: value.type, ...(typeof value.chunk === "string" ? { chunk: value.chunk } : {}), ...(typeof value.serialized === "string" ? { serialized: value.serialized } : {}) });
    });
  }

  async readTerminal(sessionId: string, tabId: string): Promise<string | null> {
    const result = await this.connection.request<unknown>("terminal.read", { worktreeId: sessionId, tabId });
    if (!result.ok) return null;
    const value = result.value as { text?: unknown };
    return typeof value?.text === "string" ? value.text : null;
  }

  async queueInput(sessionId: string, tabId: string, text: string): Promise<boolean> {
    return (await this.connection.request("steerLease.queueInput", { worktreeId: sessionId, tabId, text })).ok;
  }

  async releaseInput(sessionId: string, tabId: string): Promise<void> {
    await this.connection.request("steerLease.release", { worktreeId: sessionId, tabId }).catch(() => undefined);
  }

  /** What a new session can be started with; null from a Mac that cannot start one for a phone. */
  async newSessionOptions(): Promise<NewSessionOptions | null> {
    if ((await this.features()).sessionCreate !== 1) return null;
    const result = await this.connection.request<unknown>("sessions.options");
    if (!result.ok) throw new Error(result.refusal.message);
    if (!isNewSessionOptions(result.value)) throw new Error("The Mac returned new-session choices this phone cannot read.");
    return result.value;
  }

  /** `messageId` names the draft (#675): starting it again after a lost reply gets the first session, not a second one. */
  async createSession(request: NewSessionRequest, messageId?: string): Promise<NewSessionResult> {
    if ((await this.features()).sessionCreate !== 1) return { created: false, message: "Update TerminalX on this Mac to start sessions from your phone." };
    const where = "quick" in request.where ? { quick: true } : { projectId: request.where.projectId, useWorktree: request.where.useWorktree };
    const result = await this.connection.request<Record<string, unknown>>("sessions.create", {
      ...where,
      agent: request.agent,
      model: request.model,
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.title?.trim() ? { title: request.title.trim() } : {}),
      text: request.text,
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
      ...(messageId ? { clientMessageId: messageId } : {}),
    });
    if (!result.ok) return { created: false, message: result.refusal.message };
    const value = result.value;
    if (typeof value.sessionId !== "string" || typeof value.tabId !== "string") return { created: false, message: "The Mac did not say which session it started." };
    const sent = value.sent as { status?: unknown; queued?: unknown } | undefined;
    return {
      created: true,
      sessionId: value.sessionId,
      tabId: value.tabId,
      title: typeof value.title === "string" ? value.title : "New session",
      native: value.native === true,
      ...(sent && typeof sent.queued === "boolean" ? { queued: sent.queued } : {}),
      ...(typeof value.sendError === "string" ? { sendError: value.sendError } : !sent ? { sendError: "The Mac did not say whether it sent the first message." } : {}),
    };
  }

  /** This Mac's settings; null from a Mac that does not offer them to a phone. */
  async macSettings(): Promise<MacSettings | null> {
    if ((await this.features()).macSettings !== 1) return null;
    const result = await this.connection.request<unknown>("mac.settings");
    if (!result.ok) throw new Error(result.refusal.message);
    if (!isMacSettings(result.value)) throw new Error("The Mac returned settings this phone cannot read.");
    return result.value;
  }

  async setNativeCodex(on: boolean): Promise<MacSettings> {
    const result = await this.connection.request<unknown>("mac.setSettings", { nativeCodex: on });
    if (!result.ok) throw new Error(result.refusal.message);
    if (!isMacSettings(result.value)) throw new Error("The Mac returned settings this phone cannot read.");
    return result.value;
  }
}

function isNewSessionOptions(value: unknown): value is NewSessionOptions {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const strings = (item: unknown, ...keys: string[]) => !!item && typeof item === "object" && keys.every((key) => typeof (item as Record<string, unknown>)[key] === "string");
  return Array.isArray(record.projects) && record.projects.every((project) => strings(project, "id", "name") && typeof (project as NewSessionProject).git === "boolean")
    && Array.isArray(record.agents) && record.agents.every((agent) => strings(agent, "id", "name") && typeof (agent as NewSessionAgent).available === "boolean"
      && Array.isArray((agent as NewSessionAgent).models) && (agent as NewSessionAgent).models.every((model) => strings(model, "id", "label") && Array.isArray(model.efforts)))
    && Array.isArray(record.modes) && record.modes.every((mode) => strings(mode, "id", "label"))
    && typeof record.defaultMode === "string" && typeof record.nativeCodex === "boolean";
}

function isMacSettings(value: unknown): value is MacSettings {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).nativeCodex === "boolean";
}

export function mergeEvents(existing: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  return mergeAgentEvents(existing, incoming);
}

export type SyncPage = { deleted: true } | { deleted?: false; events: AgentEvent[]; cursor: SyncCursor; reset: boolean; hasMore: boolean; hasEarlier: boolean };

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.title === "string" && typeof record.project === "string" && typeof record.worktree === "string" && typeof record.modified === "string" && Array.isArray(record.tabs) && record.tabs.every(isSummaryTab);
}

function isSummaryTab(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.harness === "string" && ["idle", "in_progress", "completed", "waiting"].includes(String(record.status));
}

function isChatNote(value: unknown): value is ChatNote {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const author = record.author as Record<string, unknown> | undefined;
  return typeof record.id === "string" && typeof record.body === "string" && typeof record.createdAt === "number" && !!author && typeof author.userId === "string" && (author.displayName === undefined || typeof author.displayName === "string");
}

/** A promotion this phone cannot read only costs the note its de-duplication; the note is still shown. */
function readNote(value: unknown): ChatNote[] {
  if (!isChatNote(value)) return [];
  const { promotedTo, ...note } = value as ChatNote & { promotedTo?: unknown };
  const promotions = Array.isArray(promotedTo) ? promotedTo.filter(isNotePromotion) : [];
  return [promotions.length ? { ...note, promotedTo: promotions } : note];
}

function isNotePromotion(value: unknown): value is NotePromotion {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.tabId === "string" && typeof record.seq === "number";
}
