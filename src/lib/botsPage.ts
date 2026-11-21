import { useEffect, useSyncExternalStore } from "react";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { openBots, openWelcome, useSessionStore } from "@/lib/sessions";

/**
 * Which Bots screen the main slot shows while the view is `bots` (PRO-467): the team (23.02, or 23.11 with no bots)
 * or Hire a bot (23.03) with a role picked. Kept apart from the session store so the view union stays one value.
 * `focus` asks the team page to take the keyboard focus when it shows (after a hire, whose page is gone).
 */
export type BotsPage = { page: "team"; focus?: boolean } | { page: "hire"; roleId: string | null } | { page: "settings"; botId: string };

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

export function getBotsPage(): BotsPage {
  return current;
}

/** The team page: the table, or the first-bot page while there are none. `focus` moves the keyboard focus to it. */
export function showBotsTeam(focus = false) {
  set(focus ? { page: "team", focus: true } : { page: "team" });
  openBots();
}

/** Hire a bot, with `roleId` picked (the first role when left out). */
export function showHireBot(roleId: string | null = null) {
  set({ page: "hire", roleId });
  openBots();
}

/** A bot's settings (23.07, PRO-478), by its id. */
export function showBotSettings(botId: string) {
  set({ page: "settings", botId });
  openBots();
}

/** The team page took the focus it was asked to. */
export function focusTaken() {
  if (current.page === "team" && current.focus) current = { page: "team" };
}

/**
 * The switch went off (Settings → Experimental → Bots) while the Bots page was open, or behind the new-session
 * dialog: leave it for the resting screen. Nothing happens before the switches are read.
 */
export function useLeaveBotsWhenOff() {
  const switches = useExperimentalSettings();
  const store = useSessionStore();
  const off = !!switches && switches.bots !== true;
  useEffect(() => {
    // A bot's own view too (PRO-468).
    if (off && (store.view === "bots" || store.view === "bot")) openWelcome();
  }, [off, store.view]);
}

/** For tests. */
export function resetBotsPageForTests() {
  current = { page: "team" };
  listeners.clear();
}
