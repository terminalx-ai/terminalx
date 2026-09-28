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
