import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { mergeAgentEvents, type AgentEvent } from "@terminalx/portable/events";
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
  tabs: { id: string; title?: string; harness: string; status: SessionStatus }[];
}

export interface ChatNote { id: string; body: string; createdAt: number; author: { userId: string; displayName?: string } }

export class HostApi {
  private readonly clientId = `mobile-${Crypto.randomUUID()}`;

  constructor(private readonly connection: HostConnection) {}

  async summaries(): Promise<SessionSummary[] | null> {
    const result = await this.connection.request<unknown>("sessions.summaries");
    if (!result.ok) return null;
    const value = result.value as { sessions?: unknown };
    return Array.isArray(value?.sessions) ? value.sessions.filter(isSessionSummary) : null;
  }

  async tail(sessionId: string, tabId: string, before?: number): Promise<{ events: AgentEvent[]; hasMore: boolean } | null> {
    const result = await this.connection.request<unknown>("session.tail", { sessionId, tabId, ...(before === undefined ? {} : { before }), limit: 20 });
    if (!result.ok) return null;
    const value = result.value as { events?: unknown; hasMore?: unknown };
    if (!Array.isArray(value?.events)) return null;
    return { events: value.events.filter(isAgentEvent), hasMore: value.hasMore === true };
  }

  subscribeSession(tabId: string, listener: (event: AgentEvent) => void): () => void {
    return this.connection.subscribe("session.subscribe", { tabId }, (result) => {
      const event = result && typeof result === "object" && "event" in result ? (result as { event?: unknown }).event : result;
      if (isAgentEvent(event) && event.tabId === tabId) listener(event);
    });
  }

  async listNotes(sessionId: string): Promise<ChatNote[]> {
    const result = await this.connection.request<unknown>("chat.list", { worktreeId: sessionId, limit: 100 });
    if (!result.ok) return [];
    const messages = (result.value as { messages?: unknown })?.messages;
    return Array.isArray(messages) ? messages.filter(isChatNote).sort((left, right) => left.createdAt - right.createdAt) : [];
  }

  async postNote(sessionId: string, text: string): Promise<boolean> {
    const result = await this.connection.request<{ status?: string }>("chat.post", { worktreeId: sessionId, body: text });
    return result.ok && result.value.status === "sent";
  }

  async promoteNote(sessionId: string, tabId: string, noteId: string): Promise<boolean> {
    const result = await this.connection.request<{ status?: string }>("chat.promoteToAgent", { worktreeId: sessionId, tabId, messageIds: [noteId] });
    return result.ok && result.value.status === "sent";
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

export async function readTranscriptCache(hostId: string, sessionId: string, tabId: string): Promise<AgentEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(hostId, sessionId, tabId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isAgentEvent) : [];
  } catch {
    return [];
  }
}

export async function writeTranscriptCache(hostId: string, sessionId: string, tabId: string, events: AgentEvent[]): Promise<void> {
  await AsyncStorage.setItem(cacheKey(hostId, sessionId, tabId), JSON.stringify(events.slice(-500)));
}

const cacheKey = (hostId: string, sessionId: string, tabId: string) => `terminalx:transcript:${hostId}:${sessionId}:${tabId}`;

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

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.sessionId === "string" && typeof record.tabId === "string" && typeof record.harness === "string" && Number.isSafeInteger(record.seq) && typeof record.ts === "string" && !!record.payload && typeof record.payload === "object" && typeof (record.payload as Record<string, unknown>).type === "string";
}

function isChatNote(value: unknown): value is ChatNote {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const author = record.author as Record<string, unknown> | undefined;
  return typeof record.id === "string" && typeof record.body === "string" && typeof record.createdAt === "number" && !!author && typeof author.userId === "string" && (author.displayName === undefined || typeof author.displayName === "string");
}
