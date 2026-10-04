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

export interface ChatNote { id: string; body: string; createdAt: number; author: { userId: string; displayName?: string } }
export type PostNoteResult = { sent: true; note: ChatNote } | { sent: false; message: string };
export type PromoteNoteResult = { sent: true; queued: boolean } | { sent: false; message: string };
export interface AttachmentInput { mediaType: string; data: string; name?: string }

export class HostApi {
  private readonly clientId = `mobile-${Crypto.randomUUID()}`;

  private capabilities?: Promise<{ transcript?: number; conditionalLists?: number }>;
  private lists = new Map<string, { version: string; value: unknown }>();
  private pendingLists = new Map<string, Promise<unknown>>();

  constructor(private readonly connection: HostConnection) {}

  resetConnection(hostChanged = false): void {
    this.capabilities = undefined;
    if (hostChanged) { this.lists = new Map(); this.pendingLists = new Map(); }
  }

  features(): Promise<{ transcript?: number; conditionalLists?: number }> {
    if (this.capabilities) return this.capabilities;
    const pending = this.connection.request<{ transcript?: number; conditionalLists?: number }>("sync.capabilities")
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
    const result = await this.connection.request<unknown>("session.tail", { sessionId, tabId, ...(before === undefined ? {} : { before }), limit: 20 });
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
    return Array.isArray(messages) ? messages.filter(isChatNote).sort((left, right) => left.createdAt - right.createdAt) : [];
  }

  async postNote(sessionId: string, text: string): Promise<PostNoteResult> {
    const result = await this.connection.request<{ status?: unknown; message?: unknown }>("chat.post", { worktreeId: sessionId, body: text });
    if (!result.ok) return { sent: false, message: result.refusal.message };
    if (result.value.status === "sent" && isChatNote(result.value.message)) return { sent: true, note: result.value.message };
    return { sent: false, message: "The host did not add this note." };
  }

  async promoteNote(sessionId: string, tabId: string, noteId: string, attachments: AttachmentInput[] = []): Promise<PromoteNoteResult> {
    const result = await this.connection.request<{ status?: unknown; queued?: unknown }>("chat.promoteToAgent", {
      worktreeId: sessionId,
      tabId,
      messageIds: [noteId],
      ...(attachments.length ? { attachments } : {}),
    });
    if (!result.ok) return { sent: false, message: result.refusal.message };
    if (result.value.status === "sent" && typeof result.value.queued === "boolean") return { sent: true, queued: result.value.queued };
    return { sent: false, message: "The host did not send this note to the agent." };
  }

  async sendSession(tabId: string, text: string, attachments: AttachmentInput[] = []): Promise<PromoteNoteResult> {
    const result = await this.connection.request<{ status?: unknown; queued?: unknown }>("session.send", {
      tabId,
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    if (!result.ok) return { sent: false, message: result.refusal.message };
    if (result.value.status === "sent" && typeof result.value.queued === "boolean") return { sent: true, queued: result.value.queued };
    return { sent: false, message: "The host did not send this message to the agent." };
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
