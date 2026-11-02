import { useSyncExternalStore } from "react";
import { getDraft, setDraft } from "./drafts";
import type { AgentEvent } from "@/types/events";

/** Connection generations govern attachment, not an unresolved mailbox enqueue. */
export function composerSendScope(backend: { kind: string; key: string; logSessionId: string }, tabId: string): string {
  // Keep the full key (including cloud organization/workspace), backend kind,
  // destination session and tab. Never reduce ownership to just a tab ID.
  return JSON.stringify([backend.kind, backend.key, backend.logSessionId, tabId]);
}

/**
 * A message on its way (#727). The composer hands it to the chat as soon as
 * Send is pressed, where it is drawn as sending until the runtime has it.
 */
export interface SendingMessage {
  text: string;
  /** Thumbnails of the images it carries. */
  images: { url: string; name?: string }[];
  /** When Send was pressed, by this window's clock (milliseconds since the epoch). */
  pressedAt: number;
  /** The tab's newest event when Send was pressed: the message's own comes after it. */
  afterSeq: number;
}

// UI ownership only, not a delivery receipt or a transport retry token. The
// draft is not the send's: the composer clears it on Send and a failure puts
// the message back into whatever it holds then (`withReturned`).
export interface ComposerSend {
  /** What is being sent, for the chat to draw meanwhile. */
  message: SendingMessage | null;
}
interface Snapshot {
  pending: ComposerSend | null;
  error: unknown;
}
const EMPTY: Snapshot = { pending: null, error: null };
const states = new Map<string, Snapshot>();
const listeners = new Map<string, Set<() => void>>();
function publish(key: string, state: Snapshot) {
  if (!state.pending && state.error == null) states.delete(key);
  else states.set(key, state);
  for (const listener of listeners.get(key) ?? []) listener();
}
export function useComposerSend(key: string): Snapshot {
  return useSyncExternalStore((listener) => {
    const set = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(key);
    };
  }, () => states.get(key) ?? EMPTY, () => EMPTY);
}
export function beginComposerSend(key: string, message: SendingMessage | null = null): ComposerSend | null {
  if (states.get(key)?.pending) return null;
  const operation: ComposerSend = { message };
  publish(key, { pending: operation, error: null });
  return operation;
}
export function finishComposerSend(key: string, operation: ComposerSend, error: unknown = null) {
  if (states.get(key)?.pending === operation) publish(key, { pending: null, error });
}

/** An explicit successful recovery supersedes the prior send failure. */
export function clearComposerSendError(key: string) {
  const state = states.get(key);
  if (state?.error != null) publish(key, { ...state, error: null });
}

/**
 * The draft once a message that was not sent has come back to it (#727):
 * alone in an empty draft, else ahead of what has been typed since, unless
 * that already holds it. Nothing typed is lost.
 */
export function withReturned(draft: string, text: string): string {
  if (!text || draft.includes(text)) return draft;
  return draft.trim() ? `${text}\n\n${draft}` : text;
}

/** `withReturned` for a tab whose composer is not on screen: into its saved draft. */
export function returnToDraft(tabId: string, text: string) {
  const now = getDraft(tabId);
  const back = withReturned(now, text);
  if (back !== now) setDraft(tabId, back);
}

/**
 * Whether a message being sent has its own event in the conversation yet: a
 * message of the same text after Send was pressed. The runtime's broadcast of
 * it can come before its answer to the send.
 */
export function hasArrived(events: readonly AgentEvent[], message: Pick<SendingMessage, "text" | "afterSeq">): boolean {
  for (let index = events.length - 1; index >= 0 && events[index].seq > message.afterSeq; index--) {
    const payload = events[index].payload;
    // A shared tab's message carries who it is from ahead of the text.
    if (payload.type === "user_message" && (payload.text === message.text || payload.text.endsWith(message.text))) return true;
  }
  return false;
}
