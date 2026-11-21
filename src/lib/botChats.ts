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

/** The bot `session` works for, by id: the bot it is a chat of, or whose chat started it, however far back. */
export function actingBotOf(session: Pick<SessionEntry, "bot" | "botStarted">): string | null {
  return botOf(session) ?? (session.botStarted && typeof session.botStarted.id === "string" ? session.botStarted.id : null);
}

/**
 * Whether the sidebar leaves `session` to its bot's view: a bot's chats and the sessions working for it that they
 * started, only while Bots is on and the bot is listed, so a session whose bot is gone, or cannot be read, stays
 * where it can still be found.
 */
export function listedUnderBot(session: Pick<SessionEntry, "bot" | "botStarted">, bots: readonly Pick<Bot, "id">[]): boolean {
  const id = actingBotOf(session);
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
  if (selected) {
    const id = botOf(selected);
    // A chat opens in its bot's view; a session the bot started opens as itself, from wherever it was selected.
    return id && listedUnderBot(selected, bots) ? { botId: id, chatId: selected.id } : null;
  }
  return view.view === "bot" && view.selectedBotId ? { botId: view.selectedBotId, chatId: null } : null;
}

export interface BotChats {
  /** The home chat first (the newest made, if there are two), then the others, last written in first. */
  chats: SessionEntry[];
  /** Sessions that work for this bot without being its chats (started by a chat, or by what one started), newest first. */
  startedBy: SessionEntry[];
  /** The runs of its duties (PRO-471), newest first: its sessions too, listed apart from the chats. */
  dutyRuns: SessionEntry[];
}

/** Whether `session` is a run of one of its bot's duties. */
export function isDutyRun(session: Pick<SessionEntry, "botDuty">): boolean {
  return !!session.botDuty && typeof session.botDuty.id === "string";
}

const newest = (a: SessionEntry, b: SessionEntry) => (b.modified || b.created).localeCompare(a.modified || a.created);
/** The home chat the app answers with is the newest made (`bots::chat::home_chat`), so the list goes by that too. */
const newestMade = (a: SessionEntry, b: SessionEntry) => b.created.localeCompare(a.created);

export function botChats(sessions: readonly SessionEntry[], botId: string): BotChats {
  const own = sessions.filter((session) => botOf(session) === botId && !session.archived);
  const ids = new Set(own.map((session) => session.id));
  const home = own.filter((session) => session.bot?.home).sort(newestMade);
  const others = own.filter((session) => !session.bot?.home && !isDutyRun(session)).sort(newest);
  const dutyRuns = own.filter((session) => !session.bot?.home && isDutyRun(session)).sort(newest);
  // Marked by the app as working for the bot (`botStarted`), or, from before the mark, started by one of its chats.
  const startedBy = sessions
    .filter((session) => !session.archived && !ids.has(session.id) && (actingBotOf(session) === botId || (!!session.parent && ids.has(session.parent.sessionId))))
    .sort(newest);
  return { chats: [...home, ...others], startedBy, dutyRuns };
}

/** The bot's home chat, made again by the app when it is missing. */
export function openHomeChat(botId: string): Promise<SessionEntry> {
  return botsApi.homeChat(botId);
}

export function startBotChat(botId: string): Promise<SessionEntry> {
  return botsApi.newChat(botId);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What the bot's sessions spent today, at Stats' prices (`bots::spent_today`); a dash until it is read. */
export function spentTodayLabel(spent: number | null): string {
  return `${spent === null ? "—" : usd.format(spent)} today`;
}

export function botSpentToday(botId: string): Promise<{ usd: number; day: string }> {
  return botsApi.spentToday(botId);
}

/**
 * A key that moves whenever any of `sessions` records new usage, for reading the day's spend again then. The
 * usage on an entry is its whole conversation's, so it only tells when to read, never what today cost.
 */
export function usageKey(sessions: readonly SessionEntry[]): string {
  let total = 0;
  for (const session of sessions) {
    for (const tab of session.tabs) {
      for (const model of tab.usage?.models ?? []) total += model.costUsd ?? 0;
    }
  }
  return total.toFixed(6);
}
