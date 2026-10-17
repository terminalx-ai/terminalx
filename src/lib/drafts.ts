import { useSyncExternalStore } from "react";

/**
 * Unsent text per tab, module-level so a remount of the composer (switching
 * tabs, collapsing the panel) never loses what was typed.
 */
const drafts = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
/** Told of every change, e.g. to keep a cloud tab's draft with its cache. */
const changes = new Set<(tabId: string, text: string) => void>();

export function getDraft(tabId: string): string {
  return drafts.get(tabId) ?? "";
}

export function setDraft(tabId: string, text: string) {
  drafts.set(tabId, text);
  for (const l of listeners.get(tabId) ?? []) l();
  for (const change of changes) change(tabId, text);
}

/** Forget the drafts of the tabs that match, e.g. another account's cloud tabs. Views showing one go empty. */
export function clearDrafts(matches: (tabId: string) => boolean) {
  for (const tabId of [...drafts.keys()]) {
    if (!matches(tabId)) continue;
    drafts.delete(tabId);
    for (const l of listeners.get(tabId) ?? []) l();
  }
}

export function subscribeDrafts(change: (tabId: string, text: string) => void): () => void {
  changes.add(change);
  return () => changes.delete(change);
}

export function useDraft(tabId: string): string {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(tabId);
      if (!set) listeners.set(tabId, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    () => drafts.get(tabId) ?? "",
    () => "",
  );
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
