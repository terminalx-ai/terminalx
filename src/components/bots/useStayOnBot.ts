import { useLayoutEffect, useRef } from "react";
import { botAfterChatClosed } from "@/lib/botChats";
import { openBot, useSessionStore } from "@/lib/sessions";
import type { Bot } from "@/types/bots";

/**
 * A bot's chat archived or deleted while it is open leaves the reader on its bot, not on Welcome (PRO-521): the bot's
 * view opens on its home chat. Run before paint, so Welcome is never drawn in between. `botView` is what the window
 * shows (`botViewFor`).
 */
export function useStayOnBot(botsOn: boolean, bots: readonly Pick<Bot, "id">[], botView: { botId: string; chatId: string | null } | null) {
  const store = useSessionStore();
  const shown = useRef<{ botId: string; chatId: string } | null>(null);
  useLayoutEffect(() => {
    const before = shown.current;
    // An archived chat opened from the archive is not one that closes under the reader.
    const open = botView?.chatId ? store.sessions.find((session) => session.id === botView.chatId && !session.archived) : undefined;
    shown.current = botView && open ? { botId: botView.botId, chatId: open.id } : null;
    const stay = botsOn ? botAfterChatClosed(before, bots, store) : null;
    if (stay) openBot(stay);
  });
}
