import { getPrefs, setPrefs } from "@/lib/prefs";
import { resetLastView, savePanelTab, savedPanelTab } from "@/lib/lastView";

/** The tabs of a session's right panel. Ports is a cloud session's only, for someone who may use previews; Browser and Computer a local session's. */
export type PanelTab = "branch" | "changes" | "files" | "browser" | "ports" | "computer";

let pending: PanelTab | null = null;
const listeners = new Set<(tab: PanelTab) => void>();

/**
 * Opens the right panel on `tab`, from a menu elsewhere in the window. The
 * panel takes the request when it is next drawn, or at once when it is
 * already on screen.
 */
export function showPanelTab(tab: PanelTab) {
  pending = tab;
  if (!getPrefs().panelOpen) setPrefs({ panelOpen: true });
  for (const listener of listeners) listener(tab);
}

/** The tab asked for before the panel was drawn, once. */
export function takePanelTab(): PanelTab | null {
  const tab = pending;
  pending = null;
  return tab;
}

export function onPanelTab(listener: (tab: PanelTab) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The tab a session's panel last showed, per session (PRO-130). Going back
 * to a session, or launching the app on it, opens its panel on that tab; a
 * cloud session's panel, drawn anew when its workspace reconnects, too
 * (Ports included). Kept with the last view, so it outlives a quit.
 */
const shown = new Map<string, PanelTab>();

export function rememberPanelTab(sessionId: string, tab: PanelTab) {
  if (shown.get(sessionId) === tab) return;
  shown.set(sessionId, tab);
  savePanelTab(sessionId, tab);
}

export function rememberedPanelTab(sessionId: string): PanelTab | null {
  return shown.get(sessionId) ?? savedPanelTab(sessionId);
}

/** Forgets every remembered and asked-for tab (tests). */
export function resetPanelTabs() {
  shown.clear();
  pending = null;
  resetLastView();
}
