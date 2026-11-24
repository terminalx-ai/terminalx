import { useSyncExternalStore, type SetStateAction } from "react";

function createEntry<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(next: SetStateAction<T>) {
      value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
      for (const listener of listeners) listener();
    },
  };
}

// Retain pane state when navigating away or changing Chat/Terminal. Keys include
// the Mac, worktree and tab; a provider name is never a conversation identity.
const retained = new Map<string, unknown>();
export function useConversationState<T>(key: string, initial: T) {
  if (!retained.has(key)) retained.set(key, createEntry(initial));
  const state = retained.get(key) as ReturnType<typeof createEntry<T>>;
  const value = useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
  return [value, state.update] as const;
}

/**
 * Keep `value` under `key` for a screen that is not open yet (a launch's
 * first task, put back by Launch again), in the same memory as the drafts:
 * on the phone only, and gone on sign-out with them.
 */
export function keepConversationState<T>(key: string, value: T): void {
  if (retained.has(key)) (retained.get(key) as ReturnType<typeof createEntry<T>>).update(value);
  else retained.set(key, createEntry(value));
}

/** What is kept under `key`, taken: it is no longer kept. */
export function takeConversationState<T>(key: string): T | undefined {
  const entry = retained.get(key) as ReturnType<typeof createEntry<T>> | undefined;
  retained.delete(key);
  return entry?.snapshot();
}

/** Drop retained state whose key starts with `prefix` (the person signed out: their drafts do not wait for the next one). */
export function forgetConversationState(prefix: string): void {
  for (const key of [...retained.keys()]) if (key.startsWith(prefix)) retained.delete(key);
  // A message held for a Mac that is forgotten, or for a person who signed out, is never sent.
  for (const key of [...heldSends.keys()]) if (key.startsWith(prefix)) heldSends.delete(key);
}

// A message sent while not connected (#983), one per conversation, kept past its screen: it goes when
// the phone connects to that Mac, whether or not the conversation is open then.
const heldSends = new Map<string, { host: string; deliver: () => Promise<void> }>();
// Conversations on screen: their screen sends what they hold, as it knows the conversation is still on the Mac.
const shownConversations = new Map<string, number>();

/** Holds `key`'s message until the phone connects to `host`; `deliver` sends it, once. */
export function holdSend(key: string, host: string, deliver: () => Promise<void>): void {
  heldSends.set(key, { host, deliver });
}

/** The message is no longer held (edited, or sent). */
export function releaseSend(key: string): void {
  heldSends.delete(key);
}

/** Takes `key`'s held message to send it: whoever takes it sends it, so it goes at most once. */
export function takeHeldSend(key: string): (() => Promise<void>) | null {
  const held = heldSends.get(key);
  heldSends.delete(key);
  return held?.deliver ?? null;
}

/** The conversation is on screen until the returned function is called. */
export function showConversation(key: string): () => void {
  shownConversations.set(key, (shownConversations.get(key) ?? 0) + 1);
  return () => {
    const count = (shownConversations.get(key) ?? 1) - 1;
    if (count > 0) shownConversations.set(key, count);
    else shownConversations.delete(key);
  };
}

/** The phone connected to `host`: every message held for it that is not on screen is sent now. */
export function sendHeldMessages(host: string): void {
  for (const [key, held] of [...heldSends]) {
    if (held.host !== host || shownConversations.has(key)) continue;
    void takeHeldSend(key)?.().catch(() => undefined);
  }
}
