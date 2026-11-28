import { useSyncExternalStore, type SetStateAction } from "react";

interface Entry<T> {
  snapshot: () => T;
  subscribe: (listener: () => void) => () => void;
  update: (next: SetStateAction<T>) => void;
  subscriberCount: () => number;
  markEvictOnIdle: () => void;
}

/** Heavy conversation keys capped by LRU eviction to prevent unbounded memory growth. */
export const HEAVY_KEY_SUFFIXES = [":events", ":notes", ":attachments"] as const;
/** Maximum number of inactive tabs whose heavy state (`:events`, `:notes`, `:attachments`) is retained in memory. */
export const MAX_RETAINED_HEAVY_TABS = 6;

function heavyTabPrefix(key: string): string | null {
  for (const suffix of HEAVY_KEY_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  }
  return null;
}

function createEntry<T>(key: string, initial: T): Entry<T> {
  let value = initial;
  let evictOnIdle = false;
  const listeners = new Set<() => void>();
  const entry: Entry<T> = {
    snapshot: () => value,
    subscribe(listener: () => void) {
      evictOnIdle = false;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && evictOnIdle && retained.get(key) === entry) {
          retained.delete(key);
          cleanupHeavyTabIfEmpty(key);
        }
      };
    },
    update(next: SetStateAction<T>) {
      value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
      touchHeavyKey(key);
      for (const listener of listeners) listener();
    },
    subscriberCount: () => listeners.size,
    markEvictOnIdle() {
      evictOnIdle = true;
    },
  };
  return entry;
}

// Retain pane state when navigating away or changing Chat/Terminal. Keys include
// the Mac, worktree and tab; a provider name is never a conversation identity.
const retained = new Map<string, Entry<unknown>>();
const heavyTabLru = new Set<string>();

function cleanupHeavyTabIfEmpty(key: string): void {
  const prefix = heavyTabPrefix(key);
  if (!prefix) return;
  if (HEAVY_KEY_SUFFIXES.every((suffix) => !retained.has(prefix + suffix))) {
    heavyTabLru.delete(prefix);
  }
}

function touchHeavyKey(key: string): void {
  const prefix = heavyTabPrefix(key);
  if (!prefix) return;
  heavyTabLru.delete(prefix);
  heavyTabLru.add(prefix);
  evictOverflowHeavyTabs();
}

function hasActiveHeavySubscribers(prefix: string): boolean {
  for (const suffix of HEAVY_KEY_SUFFIXES) {
    const entry = retained.get(prefix + suffix);
    if (entry && entry.subscriberCount() > 0) return true;
  }
  return false;
}

function evictOverflowHeavyTabs(): void {
  if (heavyTabLru.size <= MAX_RETAINED_HEAVY_TABS) return;
  for (const prefix of [...heavyTabLru]) {
    if (heavyTabLru.size <= MAX_RETAINED_HEAVY_TABS) break;
    if (hasActiveHeavySubscribers(prefix)) continue;
    for (const suffix of HEAVY_KEY_SUFFIXES) retained.delete(prefix + suffix);
    heavyTabLru.delete(prefix);
  }
}

export function useConversationState<T>(key: string, initial: T) {
  if (!retained.has(key)) retained.set(key, createEntry<unknown>(key, initial));
  touchHeavyKey(key);
  const state = retained.get(key) as Entry<T>;
  const value = useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
  return [value, state.update] as const;
}

/** Set what a conversation's screen will show under `key`, from outside it (a first message given back to its tab's composer). */
export function setConversationState<T>(key: string, value: T): void {
  const entry = retained.get(key) as Entry<T> | undefined;
  if (entry) entry.update(value);
  else {
    retained.set(key, createEntry<unknown>(key, value));
    touchHeavyKey(key);
  }
}

/** What is kept under `key`, taken: it is no longer kept (a launch's first task, put back once by Launch again). */
export function takeConversationState<T>(key: string): T | undefined {
  const entry = retained.get(key) as Entry<T> | undefined;
  retained.delete(key);
  cleanupHeavyTabIfEmpty(key);
  return entry?.snapshot();
}

/**
 * Evict a single retained key (such as `:events` on unmount, relying on disk
 * `transcript-cache` for fast reload). If a subscriber is still detaching in
 * the same commit, eviction completes as soon as the last subscriber leaves.
 */
export function evictConversationKey(key: string): void {
  const entry = retained.get(key);
  if (!entry) return;
  if (entry.subscriberCount() === 0) {
    retained.delete(key);
    cleanupHeavyTabIfEmpty(key);
  } else {
    entry.markEvictOnIdle();
  }
}

/** Drop retained state whose key starts with `prefix` (the person signed out: their drafts do not wait for the next one). */
export function forgetConversationState(prefix: string): void {
  for (const key of [...retained.keys()]) if (key.startsWith(prefix)) retained.delete(key);
  for (const tabPrefix of [...heavyTabLru]) if (tabPrefix.startsWith(prefix) || prefix === "") heavyTabLru.delete(tabPrefix);
  // A message held for a Mac that is forgotten, or for a person who signed out, is never sent.
  for (const key of [...heldSends.keys()]) if (key.startsWith(prefix)) heldSends.delete(key);
}

/** Exposed for diagnostics and tests: whether `key` is currently retained in memory. */
export function hasRetainedConversationKey(key: string): boolean {
  return retained.has(key);
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
