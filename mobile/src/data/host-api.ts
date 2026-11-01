import * as Crypto from "expo-crypto";
import type { ModelInfo } from "@terminalx/portable/agentSettings";
import type { ContinuationContext } from "@terminalx/portable/continuation";
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
 * `sessionControls`: stop, interrupt, recovery, settings and continuing in a new tab, as on the desktop.
 * `terminal`: `terminal.open`, and terminal output that says the pane's size, which the terminal view needs.
 */
export interface HostFeatures { transcript?: number; conditionalLists?: number; sendIds?: number; sessionControls?: number; terminal?: number }
/** A terminal observation: retained output first, then live output, and the pane's size when it changes; `error` when the Mac refused or ended it. */
export interface TerminalPacket { type: string; chunk?: string; serialized?: string; cols?: number; rows?: number; message?: string }
/** What a tab runs, and what it was asked to switch to and has not yet: the desktop's pickers read the same. */
export interface TabControls {
  harness: string;
  model: string;
  effort?: string | null;
  permissionMode: string;
  requestedModel?: string | null;
  requestedEffort?: string | null;
  requestedPermissionMode?: string | null;
  status: SessionStatus;
}
/** The agent and settings a new tab starts with. */
export interface NewTabSettings { harness: string; model: string; effort?: string | null; permissionMode?: string | null }
export type ControlResult = { done: true } | { done: false; message: string };
/** "Continue in new session": the tab exists once `started`, whether or not the handoff was confirmed. */
export type ContinueResult = { started: true; tabId: string; delivered: boolean; inInput: boolean; message?: string } | { started: false; message: string };

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

  /** Whether this Mac takes the session controls; an older one offers sending and answering only. */
  async sessionControls(): Promise<boolean> {
    return (await this.features()).sessionControls === 1;
  }

  async tabControls(sessionId: string, tabId: string): Promise<TabControls | null> {
    const result = await this.connection.request<TabControls>("session.tab", { sessionId, tabId });
    return result.ok && typeof result.value?.harness === "string" ? result.value : null;
  }

  /** The Mac's models, as its own pickers list them; `refresh` asks the agents again. */
  async models(refresh = false): Promise<ModelInfo[]> {
    const result = await this.connection.request<ModelInfo[]>("models.list", refresh ? { refresh } : {});
    return result.ok && Array.isArray(result.value) ? result.value.filter((model) => typeof model?.id === "string" && typeof model.harness === "string") : [];
  }

  async stop(sessionId: string, tabId: string): Promise<ControlResult> {
    return this.control("session.stop", { sessionId, tabId });
  }

  /** Escape, as the agent takes it: the running turn ends and the agent stays. */
  async interrupt(sessionId: string, tabId: string): Promise<ControlResult> {
    return this.control("session.interrupt", { sessionId, tabId });
  }

  async setModel(sessionId: string, tabId: string, model: string): Promise<ControlResult> {
    return this.control("session.setModel", { sessionId, tabId, model });
  }

  /** `null`: the agent's own default effort. */
  async setEffort(sessionId: string, tabId: string, effort: string | null): Promise<ControlResult> {
    return this.control("session.setEffort", { sessionId, tabId, effort });
  }

  async setMode(sessionId: string, tabId: string, mode: string): Promise<ControlResult> {
    return this.control("session.setMode", { sessionId, tabId, mode });
  }

  /** "Resend last prompt": the prompt the agent never received, as it was sent. */
  async resendUnsent(sessionId: string, tabId: string): Promise<SendResult> {
    const result = await this.connection.request<{ queued?: unknown }>("session.resendUnsent", { sessionId, tabId });
    if (!result.ok) return { sent: false, message: result.refusal.message };
    return typeof result.value?.queued === "boolean" ? { sent: true, queued: result.value.queued } : { sent: false, message: "The host did not send the prompt again." };
  }

  async prepareContinuation(sessionId: string, tabId: string): Promise<ContinuationContext> {
    const result = await this.connection.request<ContinuationContext>("session.prepareContinuation", { sessionId, tabId });
    if (!result.ok) throw new Error(result.refusal.message);
    return result.value;
  }

  async continueInNewTab(sessionId: string, tabId: string, tab: NewTabSettings, prompt: string): Promise<ContinueResult> {
    const result = await this.connection.request<{ tab?: { id?: unknown }; delivered?: unknown; inInput?: unknown; error?: unknown }>("session.continue", { sessionId, tabId, tab, prompt });
    if (!result.ok) return { started: false, message: result.refusal.message };
    const id = result.value?.tab?.id;
    if (typeof id !== "string") return { started: false, message: "The host did not open the new conversation." };
    return { started: true, tabId: id, delivered: result.value.delivered === true, inInput: result.value.inInput === true, ...(typeof result.value.error === "string" ? { message: result.value.error } : {}) };
  }

  private async control(method: string, params: Record<string, unknown>): Promise<ControlResult> {
    const result = await this.connection.request<unknown>(method, params);
    return result.ok ? { done: true } : { done: false, message: result.refusal.message };
  }

  async respondPermission(sessionId: string, tabId: string, requestId: string, optionId: string): Promise<{ answered: true } | { answered: false; message: string }> {
    const result = await this.connection.request<{ status?: string }>("permission.respond", { sessionId, tabId, requestId, optionId });
    if (result.ok && result.value.status === "answered") return { answered: true };
    return { answered: false, message: result.ok ? "The host did not answer this request." : result.refusal.message };
  }

  /** Start the tab's agent in its terminal, as opening the desktop's terminal view does; a native Codex tab moves there for good. */
  async openTerminal(sessionId: string, tabId: string): Promise<{ opened: true } | { opened: false; message: string }> {
    const result = await this.connection.request("terminal.open", { worktreeId: sessionId, tabId });
    return result.ok ? { opened: true } : { opened: false, message: result.refusal.message };
  }

  subscribeTerminal(sessionId: string, tabId: string, listener: (value: TerminalPacket) => void): () => void {
    return this.connection.subscribe("terminal.subscribe", {
      worktreeId: sessionId,
      tabId,
      attachMode: "observe",
      client: { id: this.clientId, type: "mobile" },
      capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1, writeUnavailable: 1 },
    }, (result) => {
      if (!result || typeof result !== "object") return;
      const value = result as { type?: unknown; chunk?: unknown; serialized?: unknown; cols?: unknown; rows?: unknown; error?: { message?: unknown } };
      if (typeof value.type !== "string") return;
      if (value.type === "error") { listener({ type: "error", message: typeof value.error?.message === "string" ? value.error.message : "The Mac ended the terminal view." }); return; }
      const size = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 1000;
      listener({ type: value.type, ...(typeof value.chunk === "string" ? { chunk: value.chunk } : {}), ...(typeof value.serialized === "string" ? { serialized: value.serialized } : {}),
        ...(size(value.cols) && size(value.rows) ? { cols: value.cols as number, rows: value.rows as number } : {}) });
    });
  }

  /** Type into the tab's terminal; the phone holds the tab's driver lease until it releases it. Refused with the Mac's reason. */
  async queueInput(sessionId: string, tabId: string, text: string): Promise<{ accepted: true } | { accepted: false; message: string }> {
    const result = await this.connection.request("steerLease.queueInput", { worktreeId: sessionId, tabId, text });
    return result.ok ? { accepted: true } : { accepted: false, message: result.refusal.message };
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
