/** Composer state that stays in this webview, outside the transferable text drafts. */
const owners = new Set<() => boolean>();

export function registerWindowDraft(hasUnsentState: () => boolean): () => void {
  owners.add(hasUnsentState);
  return () => { owners.delete(hasUnsentState); };
}

export function hasWindowDrafts(): boolean {
  return [...owners].some((hasUnsentState) => hasUnsentState());
}
