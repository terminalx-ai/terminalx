import { useSyncExternalStore } from "react";

/**
 * Unsent text per tab, module-level so a remount of the composer (switching
 * tabs, collapsing the panel) never loses what was typed.
 */
// v1 contained unclassified raw tab IDs, including account-owned cloud drafts.
// Never hydrate that format into the account-unscoped composer map.
const LEGACY_RECOVERY_DRAFTS = "terminalx.localRuntime.drafts.v1";
const RECOVERY_DRAFTS = "terminalx.localRuntime.localDrafts.v2";

function restoreRecoveryDrafts(): Map<string, string> {
  try {
    sessionStorage.removeItem(LEGACY_RECOVERY_DRAFTS);
    const saved: unknown = JSON.parse(sessionStorage.getItem(RECOVERY_DRAFTS) ?? "[]");
    if (!Array.isArray(saved) || !saved.every((entry) => Array.isArray(entry)
      && entry.length === 2 && entry.every((value) => typeof value === "string"))) return new Map();
    // Consume once. Later sends/clears cannot resurrect an old checkpoint on
    // an unrelated reload; the next recovery saves the current map afresh.
    sessionStorage.removeItem(RECOVERY_DRAFTS);
    return new Map(saved as [string, string][]);
  } catch { return new Map(); }
}

const drafts = restoreRecoveryDrafts();

/** Synchronous, window-scoped handoff for positively identified local tabs only.
 * The caller supplies IDs from the local session index, never a cloud catalog.
 * Cloud/issue drafts retain their own scoped persistence and clearing metadata.
 * Let storage failure abort the reload rather than discard unsent local text. */
export function checkpointDraftsForRecovery(localTabIds: Iterable<string>) {
  const local = new Set(localTabIds);
  sessionStorage.setItem(RECOVERY_DRAFTS, JSON.stringify([...drafts].filter(([id]) => local.has(id))));
}
const revisions = new Map<string, number>();
let nextRevision = 0;
const listeners = new Map<string, Set<() => void>>();
/** Told of every change, e.g. to keep a cloud tab's draft with its cache. */
const changes = new Set<(tabId: string, text: string) => void>();

export function getDraft(tabId: string): string {
  return drafts.get(tabId) ?? "";
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
