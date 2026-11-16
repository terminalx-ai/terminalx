import { useSyncExternalStore } from "react";
import type { FileInput, ImageInput } from "@/lib/api";

/**
 * The first message of a new session, held from Create until its send returns
 * (PRO-397): the chat draws it at once, with the start progress under it,
 * rather than waiting for the events the send brings back. A send that fails
 * keeps it on screen with the error. `sendHeldFirstMessage` (sessionBackend)
 * holds, sends and releases it.
 */
export interface HeldFirstMessage {
  sessionId: string;
  tabId: string;
  text: string;
  images: { url: string; name?: string }[];
  files: { name: string }[];
  /** When Create was pressed, by this window's clock. */
  startedAt: number;
  /** Why the send failed; null while it is on its way. */
  error: string | null;
}

let held: readonly HeldFirstMessage[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => held;
function set(next: readonly HeldFirstMessage[]) {
  held = next;
  for (const listener of listeners) listener();
}
const same = (message: HeldFirstMessage, sessionId: string, tabId: string) => message.sessionId === sessionId && message.tabId === tabId;

/** Hold a first message for its tab, until `releaseFirstMessage` or `failFirstMessage`. */
export function holdFirstMessage(sessionId: string, tabId: string, text: string, images?: ImageInput[], files?: FileInput[], startedAt = Date.now()) {
  const message: HeldFirstMessage = {
    sessionId,
    tabId,
    text,
    images: (images ?? []).map((image) => ({ url: `data:${image.mediaType};base64,${image.data}`, name: image.name })),
    files: (files ?? []).map((file) => ({ name: file.name })),
    startedAt,
    error: null,
  };
  set([...held.filter((item) => !same(item, sessionId, tabId)), message]);
}

/** The send's own events are in the conversation now: the held message goes. */
export function releaseFirstMessage(sessionId: string, tabId: string) {
  if (held.some((item) => same(item, sessionId, tabId))) set(held.filter((item) => !same(item, sessionId, tabId)));
}

/** The send failed: the message stays, with why. */
export function failFirstMessage(sessionId: string, tabId: string, error: unknown) {
  const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "The agent did not take it.";
  set(held.map((item) => (same(item, sessionId, tabId) ? { ...item, error: reason || "The agent did not take it." } : item)));
}

/** The message held for a session's tab; `tabId` undefined takes the session's. */
export function heldFirstMessage(sessionId: string, tabId?: string): HeldFirstMessage | null {
  return held.find((item) => item.sessionId === sessionId && (tabId === undefined || item.tabId === tabId)) ?? null;
}

export function useHeldFirstMessage(sessionId: string, tabId?: string): HeldFirstMessage | null {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return all.find((item) => item.sessionId === sessionId && (tabId === undefined || item.tabId === tabId)) ?? null;
}

/** Tests only. */
export function resetFirstMessages() {
  set([]);
}
