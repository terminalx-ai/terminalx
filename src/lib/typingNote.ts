import { agent } from "@/lib/api";

/**
 * Typing in a tab's composer, told to the runtime (#981): automatic account
 * switching never restarts a tab's agent while the person is typing in it.
 * At most once every few seconds per tab, and never in the way of typing:
 * a failure (an older runtime, no runtime yet) is dropped.
 */
const EVERY_MS = 5_000;
const told = new Map<string, number>();

export function noteComposerTyping(sessionId: string, tabId: string, now = Date.now()) {
  const key = `${sessionId}:${tabId}`;
  const last = told.get(key);
  if (last !== undefined && now - last < EVERY_MS) return;
  told.set(key, now);
  void Promise.resolve().then(() => agent.noteTyping(sessionId, tabId)).catch(() => {});
}

/** Forget what was told: for tests. */
export function resetTypingNotes() {
  told.clear();
}
