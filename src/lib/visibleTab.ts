import { useSyncExternalStore } from "react";
import type { SelectedSessionTab } from "@/lib/terminal";

/**
 * The tab each open session view is showing, as the view itself resolved it
 * (the requested tab when it still exists, else its fallback). The sidebar
 * marks that row, so the selected row is always the tab on screen.
 */
let visible: Record<string, SelectedSessionTab> = {};
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by a session view with the tab it shows; `null` when it shows none or goes away. */
export function setVisibleSessionTab(sessionId: string, tab: SelectedSessionTab | null) {
  const current = visible[sessionId];
  if (tab ? current?.kind === tab.kind && current.id === tab.id : !current) return;
  const next = { ...visible };
  if (tab) next[sessionId] = tab;
  else delete next[sessionId];
  visible = next;
  for (const listener of [...listeners]) listener();
}

export function useVisibleSessionTab(sessionId: string): SelectedSessionTab | null {
  return useSyncExternalStore(subscribe, () => visible[sessionId] ?? null, () => null);
}

/**
 * The tab a session shows for a request: the requested one while it exists,
 * else the one it already shows (`current`, when the caller says so), else
 * the session's active agent tab, its first agent tab, its first terminal.
 *
 * `current` is for a session other people share. Its active tab is the
 * runtime's, one value for everyone: it moves to a tab the moment anyone adds
 * one. A view that was showing a tab by fallback (nobody here picked one)
 * stays on it; the active tab only decides what a view opens on.
 */
export function resolveSessionTab(input: {
  requested: SelectedSessionTab | undefined;
  current?: SelectedSessionTab | null;
  agentIds: readonly string[];
  activeTab?: string | null;
  terminalIds: readonly string[];
  browserIds?: readonly string[];
}): SelectedSessionTab | null {
  const { agentIds, terminalIds } = input;
  const exists = (tab: SelectedSessionTab | null | undefined): tab is SelectedSessionTab =>
    !!tab && (tab.kind === "agent" ? agentIds.includes(tab.id) : tab.kind === "terminal" ? terminalIds.includes(tab.id) : !!input.browserIds?.includes(tab.id));
  if (exists(input.requested)) return input.requested;
  if (exists(input.current)) return input.current;
  const agent = (input.activeTab && agentIds.includes(input.activeTab) ? input.activeTab : null) ?? agentIds[0];
  if (agent) return { kind: "agent", id: agent };
  return terminalIds.length ? { kind: "terminal", id: terminalIds[0] } : null;
}
