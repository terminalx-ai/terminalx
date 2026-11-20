import { botsApi } from "@/lib/api";
import type { Bot } from "@/types/bots";
import type { SessionEntry } from "@/types/session";

/**
 * A bot's chats (PRO-468). Each is an ordinary quick chat that runs in the
 * bot's home folder and names its bot (`session.bot`). They are listed under
 * their bot, not in the project lists; "Started by" a bot are the sessions
 * one of its chats started (`parent`).
 */

/** The bot `session` is a chat of, by id. */
export function botOf(session: Pick<SessionEntry, "bot">): string | null {
  return session.bot && typeof session.bot.id === "string" ? session.bot.id : null;
}

/**
 * Whether the sidebar leaves `session` to its bot's view: only while Bots is on and the bot is listed, so a
 * chat whose bot is gone, or cannot be read, stays where it can still be found.
 */
export function listedUnderBot(session: Pick<SessionEntry, "bot">, bots: readonly Pick<Bot, "id">[]): boolean {
  const id = botOf(session);
  return !!id && bots.some((bot) => bot.id === id);
}

/**
 * The bot view the main window shows, if it shows one: a selected chat of a listed bot opens in its bot's view,
 * wherever it was selected from, and `openBot` opens a bot's view on its home chat. Nothing while Bots is off.
 */
export function botViewFor(
  botsOn: boolean,
  bots: readonly Pick<Bot, "id">[],
  selected: SessionEntry | null,
  view: { view: string; selectedBotId: string | null },
): { botId: string; chatId: string | null } | null {
  if (!botsOn) return null;
  if (selected) return listedUnderBot(selected, bots) ? { botId: botOf(selected)!, chatId: selected.id } : null;
  return view.view === "bot" && view.selectedBotId ? { botId: view.selectedBotId, chatId: null } : null;
}

export interface BotChats {
  /** The home chat first (the newest made, if there are two), then the others, last written in first. */
  chats: SessionEntry[];
  /** Sessions a chat of this bot started, newest first. */
  startedBy: SessionEntry[];
}

const newest = (a: SessionEntry, b: SessionEntry) => (b.modified || b.created).localeCompare(a.modified || a.created);
/** The home chat the app answers with is the newest made (`bots::chat::home_chat`), so the list goes by that too. */
const newestMade = (a: SessionEntry, b: SessionEntry) => b.created.localeCompare(a.created);

export function botChats(sessions: readonly SessionEntry[], botId: string): BotChats {
  const own = sessions.filter((session) => botOf(session) === botId && !session.archived);
  const ids = new Set(own.map((session) => session.id));
  const home = own.filter((session) => session.bot?.home).sort(newestMade);
  const others = own.filter((session) => !session.bot?.home).sort(newest);
  const startedBy = sessions.filter((session) => !session.archived && !ids.has(session.id) && !!session.parent && ids.has(session.parent.sessionId)).sort(newest);
  return { chats: [...home, ...others], startedBy };
}

/** The bot's home chat, made again by the app when it is missing. */
export function openHomeChat(botId: string): Promise<SessionEntry> {
  return botsApi.homeChat(botId);
}

export function startBotChat(botId: string): Promise<SessionEntry> {
  return botsApi.newChat(botId);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * What the bot's own chats have spent in all, as their tabs' usage reads it: a tab's usage is its whole
 * conversation's, so there is no day's share of it to show. For information only: bots have no budget or cap (PRO-459).
 */
export function spentInChats(chats: readonly SessionEntry[]): string {
  let total = 0;
  for (const session of chats) {
    for (const tab of session.tabs) {
      for (const model of tab.usage?.models ?? []) total += model.costUsd ?? 0;
    }
  }
  return `${usd.format(total)} spent`;
}
