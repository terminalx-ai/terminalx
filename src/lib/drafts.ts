import { useSyncExternalStore } from "react";

/**
 * Unsent text per tab, module-level so a remount of the composer (switching
 * tabs, collapsing the panel) never loses what was typed.
 */
const drafts = new Map<string, string>();
const revisions = new Map<string, number>();
let nextRevision = 0;
const listeners = new Map<string, Set<() => void>>();
/** Told of every change, e.g. to keep a cloud tab's draft with its cache. */
const changes = new Set<(tabId: string, text: string) => void>();

export function getDraft(tabId: string): string {
  return drafts.get(tabId) ?? "";
}

/** Every unsent tab in this window, including tabs whose composers are unmounted. */
export function snapshotDrafts(): Map<string, string> {
  return new Map([...drafts].filter(([, text]) => text.length > 0));
}

/** Changes on every write, including identical text; forgetting a draft invalidates it. */
export function getDraftRevision(tabId: string): number | undefined {
  return revisions.get(tabId);
}

export function setDraft(tabId: string, text: string): number {
  const revision = ++nextRevision;
  revisions.set(tabId, revision);
  drafts.set(tabId, text);
  for (const l of listeners.get(tabId) ?? []) l();
  for (const change of changes) change(tabId, text);
  return revision;
}

/** Forget the drafts of the tabs that match, e.g. another account's cloud tabs. Views showing one go empty. */
export function clearDrafts(matches: (tabId: string) => boolean) {
  for (const tabId of [...drafts.keys()]) {
    if (!matches(tabId)) continue;
    drafts.delete(tabId);
    revisions.delete(tabId);
    for (const l of listeners.get(tabId) ?? []) l();
  }
}

export function subscribeDrafts(change: (tabId: string, text: string) => void): () => void {
  changes.add(change);
  return () => changes.delete(change);
}

/** Views can follow several tabs without treating cache eviction as a new write. */
export function subscribeTabDrafts(tabIds: readonly string[], changed: () => void): () => void {
  const ids = [...new Set(tabIds)];
  for (const id of ids) {
    let set = listeners.get(id);
    if (!set) listeners.set(id, (set = new Set()));
    set.add(changed);
  }
  return () => {
    for (const id of ids) {
      const set = listeners.get(id);
      set?.delete(changed);
      if (!set?.size) listeners.delete(id);
    }
  };
}

export function useDraft(tabId: string): string {
  return useSyncExternalStore(
    (cb) => subscribeTabDrafts([tabId], cb),
    () => drafts.get(tabId) ?? "",
    () => "",
  );
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
