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
 * else the session's active agent tab, its first agent tab, its first terminal.
 */
export function resolveSessionTab(input: {
  requested: SelectedSessionTab | undefined;
  agentIds: readonly string[];
  activeTab?: string | null;
  terminalIds: readonly string[];
  browserIds?: readonly string[];
}): SelectedSessionTab | null {
  const { requested, agentIds, terminalIds } = input;
  if (requested?.kind === "agent" && agentIds.includes(requested.id)) return requested;
  if (requested?.kind === "terminal" && terminalIds.includes(requested.id)) return requested;
  if (requested?.kind === "browser" && input.browserIds?.includes(requested.id)) return requested;
  const agent = (input.activeTab && agentIds.includes(input.activeTab) ? input.activeTab : null) ?? agentIds[0];
  if (agent) return { kind: "agent", id: agent };
  return terminalIds.length ? { kind: "terminal", id: terminalIds[0] } : null;
}
