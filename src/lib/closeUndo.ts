import { useSyncExternalStore } from "react";
import { isTerminalTab } from "@/lib/tabFront";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * Undo for closing a session's last running tab (#721). Closing an agent tab
 * stops its agent; when it was the last one the session had running, nothing
 * of the session is left going, and a close by mistake (a stray ⌘W, a click
 * on the wrong ×) left the reader to find "Reopen closed tab" by themselves.
 * The notice says the agent stopped, and Undo reopens the tab on the same
 * conversation.
 *
 * Only what the backend kept can come back: a tab with nothing in it is not
 * reopenable, and the notice offers nothing for it (`CloseUndoNotices` reads
 * the closed tabs).
 */
export interface CloseUndo {
  id: string;
  sessionId: string;
  /** The tabs the close took, in the order they stood: Undo reopens each. */
  tabs: TabEntry[];
}

/** How long Undo is offered. The session's own page lists its closed tabs after that. */
export const UNDO_OFFERED_MS = 12_000;

let offers: CloseUndo[] = [];
let next = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function set(list: CloseUndo[]) {
  offers = list;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCloseUndos(): CloseUndo[] {
  return useSyncExternalStore(subscribe, () => offers, () => offers);
}

export function getCloseUndos(): CloseUndo[] {
  return offers;
}

/** A tab with an agent in it: closing it stops that agent. A tab that is a terminal now (#437) has none. */
function runsAgent(tab: TabEntry): boolean {
  return !isTerminalTab(tab);
}

/**
 * The tabs among `closing` that are the last ones running in their session:
 * once they close, the session has no agent left. By session; a session that
 * keeps an agent tab open is not among them.
 */
export function lastRunning(sessions: readonly SessionEntry[], closing: readonly { sessionId: string; tab: TabEntry }[]): Map<string, TabEntry[]> {
  const out = new Map<string, TabEntry[]>();
  for (const session of sessions) {
    const going = closing.filter((entry) => entry.sessionId === session.id && runsAgent(entry.tab)).map((entry) => entry.tab);
    if (!going.length) continue;
    const ids = new Set(going.map((tab) => tab.id));
    if (session.tabs.some((tab) => !ids.has(tab.id) && runsAgent(tab))) continue;
    out.set(session.id, going);
  }
  return out;
}

/** Offer Undo for these closed tabs of a session. A newer close of the same session takes the place of its older offer. */
export function offerCloseUndo(sessionId: string, tabs: TabEntry[]): string {
  const id = `close-undo-${++next}`;
  for (const old of offers.filter((offer) => offer.sessionId === sessionId)) clearTimer(old.id);
  set([...offers.filter((offer) => offer.sessionId !== sessionId), { id, sessionId, tabs }]);
  timers.set(id, setTimeout(() => dismissCloseUndo(id), UNDO_OFFERED_MS));
  return id;
}

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

/**
 * Keep an offer up until it is dismissed: its Undo is under way, and how that
 * ends (an error that says why it could not) must still be there to read.
 */
export function holdCloseUndo(id: string) {
  clearTimer(id);
}

export function dismissCloseUndo(id: string) {
  clearTimer(id);
  if (offers.some((offer) => offer.id === id)) set(offers.filter((offer) => offer.id !== id));
}

/** Withdraw what is offered for a session's tab once it is back by another way (its page, ⌘⌥T). */
export function forgetCloseUndoFor(sessionId: string, tabId: string) {
  for (const offer of offers) {
    if (offer.sessionId !== sessionId || !offer.tabs.some((tab) => tab.id === tabId)) continue;
    const tabs = offer.tabs.filter((tab) => tab.id !== tabId);
    if (!tabs.length) dismissCloseUndo(offer.id);
    else set(offers.map((other) => (other.id === offer.id ? { ...other, tabs } : other)));
  }
}

/** Tests only. */
export function resetCloseUndos() {
  for (const id of [...timers.keys()]) clearTimer(id);
  set([]);
}
