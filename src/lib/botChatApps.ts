/**
 * A bot's Slack and Telegram view (PRO-481), shared by its Channels settings and its home chat's "Also sends to":
 * read when first shown, every 30 seconds while something shows it, and at once after a change. A runtime that does
 * not know the call answers with an error, and the view is then `null`: nothing about chat apps is shown.
 */
import { useEffect, useSyncExternalStore } from "react";
import { botsApi } from "@/lib/api";
import type { BotChatAppsView } from "@/types/botChatApps";

type Entry = { view: BotChatAppsView | null; watchers: number; timer: number | null; reading: Promise<void> | null };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

function entry(id: string): Entry {
  let found = entries.get(id);
  if (!found) {
    found = { view: null, watchers: 0, timer: null, reading: null };
    entries.set(id, found);
  }
  return found;
}

/** Read `id`'s view again now. */
export function refreshChatApps(id: string): Promise<void> {
  const held = entry(id);
  if (held.reading) return held.reading;
  held.reading = Promise.resolve()
    .then(() => botsApi.chatApps(id))
    .then((view) => { held.view = view; }, () => { held.view = null; })
    .finally(() => {
      held.reading = null;
      notify();
    });
  return held.reading;
}

/** Take a view a change answered with, as the newest. */
export function setChatApps(id: string, view: BotChatAppsView) {
  entry(id).view = view;
  notify();
}

export function useChatApps(id: string | null): BotChatAppsView | null {
  const view = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (id ? entries.get(id)?.view ?? null : null),
  );
  useEffect(() => {
    if (!id) return;
    const held = entry(id);
    held.watchers += 1;
    if (held.watchers === 1) {
      void refreshChatApps(id);
      held.timer = window.setInterval(() => void refreshChatApps(id), 30_000);
    }
    return () => {
      held.watchers -= 1;
      if (held.watchers === 0 && held.timer !== null) {
        window.clearInterval(held.timer);
        held.timer = null;
      }
    };
  }, [id]);
  return view;
}

export const CHAT_APP_NAME: Record<string, string> = { slack: "Slack", telegram: "Telegram" };

export function chatAppName(service: string): string {
  return CHAT_APP_NAME[service] ?? service;
}

/** For tests: forget every view. */
export function resetChatAppsForTests() {
  for (const held of entries.values()) if (held.timer !== null) window.clearInterval(held.timer);
  entries.clear();
  listeners.clear();
}
