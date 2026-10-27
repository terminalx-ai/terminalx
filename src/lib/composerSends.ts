import { useSyncExternalStore } from "react";
import { getDraft, subscribeDrafts } from "./drafts";

/** Connection generations govern attachment, not an unresolved mailbox enqueue. */
export function composerSendScope(backend: { kind: string; key: string; logSessionId: string }, tabId: string): string {
  // Keep the full key (including cloud organization/workspace), backend kind,
  // destination session and tab. Never reduce ownership to just a tab ID.
  return JSON.stringify([backend.kind, backend.key, backend.logSessionId, tabId]);
}

// UI ownership only, not a delivery receipt or a transport retry token.
export interface ComposerSend {
  edited: boolean;
  ownsDraft: () => boolean;
  release: () => void;
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
export function beginComposerSend(key: string, tabId: string): ComposerSend | null {
  if (states.get(key)?.pending) return null;
  const initialDraft = getDraft(tabId);
  const operation: ComposerSend = { edited: false, ownsDraft: () => !operation.edited && getDraft(tabId) === initialDraft, release: () => {} };
  // This subscription belongs to the request, so edits while its view is absent
  // (including identical writes) still invalidate draft ownership.
  operation.release = subscribeDrafts((id) => {
    if (id === tabId) operation.edited = true;
  });
  publish(key, { pending: operation, error: null });
  return operation;
}
export function editComposerSend(key: string) {
  const operation = states.get(key)?.pending;
  if (operation) operation.edited = true;
}
export function finishComposerSend(key: string, operation: ComposerSend, error: unknown = null) {
  operation.release();
  if (states.get(key)?.pending === operation) publish(key, { pending: null, error });
}

/** An explicit successful recovery supersedes the prior send failure. */
export function clearComposerSendError(key: string) {
  const state = states.get(key);
  if (state?.error != null) publish(key, { ...state, error: null });
}
