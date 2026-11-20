import { useSyncExternalStore } from "react";
import { openBots } from "@/lib/sessions";

/**
 * Which Bots screen the main slot shows while the view is `bots` (PRO-467): the team (23.02, or 23.11 with no bots)
 * or Hire a bot (23.03) with a role picked. Kept apart from the session store so the view union stays one value.
 */
export type BotsPage = { page: "team" } | { page: "hire"; roleId: string | null };

let current: BotsPage = { page: "team" };
const listeners = new Set<() => void>();

function set(next: BotsPage) {
  current = next;
  for (const listener of [...listeners]) listener();
}

export function useBotsPage(): BotsPage {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}

/** The team page: the table, or the first-bot page while there are none. */
export function showBotsTeam() {
  set({ page: "team" });
  openBots();
}

/** Hire a bot, with `roleId` picked (the first role when left out). */
export function showHireBot(roleId: string | null = null) {
  set({ page: "hire", roleId });
  openBots();
}

/** For tests. */
export function resetBotsPageForTests() {
  current = { page: "team" };
  listeners.clear();
}
