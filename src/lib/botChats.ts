import { botsApi } from "@/lib/api";
import type { Bot } from "@/types/bots";
import type { SessionEntry } from "@/types/session";

/**
 * A bot's chats (PRO-468). Each is an ordinary quick chat that runs in the
 * bot's home folder and names its bot (`session.bot`). They are listed under
 * their bot, not in the project lists; "Started by" a bot are the sessions
 * one of its chats started (`parent`).
 */

/** Where a chat that a mention started came from (PRO-480): "GitHub · acme/app#12", or nothing for any other chat. */
export function chatSource(chat: Pick<SessionEntry, "botChannel">): string | null {
  const source = chat.botChannel;
  if (!source || typeof source.label !== "string") return null;
  const names: Record<string, string> = { github: "GitHub", linear: "Linear", slack: "Slack", telegram: "Telegram" };
  const service = names[source.kind] ?? source.kind;
  return `${service} · ${source.label}`;
}

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

/**
 * Where the window goes when the bot chat it showed is closed (PRO-521). Archiving or deleting the selected session
 * lands on Welcome, as for any session; a chat closed from its bot's Chat tab leaves the reader on that bot instead,
 * which opens on its home chat. `shown` is the chat the window showed, while it was not archived. The bot's id, or
 * null to stay where the store went: the chat is still open (the reader left it), another session or view was chosen
 * since, or the bot is not listed any more.
 */
export function botAfterChatClosed(
  shown: { botId: string; chatId: string } | null,
  bots: readonly Pick<Bot, "id">[],
  store: { view: string; selectedSessionId: string | null; sessions: readonly Pick<SessionEntry, "id" | "archived">[] },
): string | null {
  if (!shown || store.selectedSessionId || store.view !== "welcome") return null;
  if (store.sessions.some((session) => session.id === shown.chatId && !session.archived)) return null;
  return bots.some((bot) => bot.id === shown.botId) ? shown.botId : null;
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

/** What a bot is doing now, read from its sessions (PRO-515). */
export interface BotDoing {
  /** `working`: a session of its is in a turn. `waiting`: none is, and one waits on the person. */
  state: "working" | "waiting";
  /** The session it is on, by its title: a duty's run first, then a chat. Absent when only its runs' workers are at work. */
  what: string | null;
  /** Its runs' workers in that state. */
  workers: number;
}

type DoingSession = Pick<SessionEntry, "bot" | "botStarted" | "botDuty" | "runWorker" | "archived" | "title" | "tabs">;

/**
 * What bot `botId` is doing, from the sessions as the app already keeps them: its chats (the home chat, a hand-off's,
 * a run's lead), its duties' runs and the sessions those started, a run's workers among them. A tab `in_progress` is
 * a turn; one `waiting` is a turn stopped on the person. Nothing here is kept: it is read again whenever the sessions
 * change, so the line follows a turn as it starts and ends. `null` when nothing of the bot's is in a turn.
 */
export function botDoing(sessions: readonly DoingSession[], botId: string): BotDoing | null {
  const own = sessions.filter((session) => !session.archived && actingBotOf(session) === botId);
  for (const state of ["working", "waiting"] as const) {
    const status = state === "working" ? "in_progress" : "waiting";
    const busy = own.filter((session) => session.tabs.some((tab) => tab.status === status));
    if (!busy.length) continue;
    const workers = busy.filter((session) => session.runWorker === true);
    const others = busy.filter((session) => session.runWorker !== true);
    const on = others.find(isDutyRun) ?? others[0] ?? null;
    return { state, what: on ? on.title.trim() || null : null, workers: workers.length };
  }
  return null;
}

/** A bot's doing in a line: "Working · Home chat · 2 workers", "Working · 1 worker", "Waiting for you · Review #12". */
export function doingLine(doing: BotDoing): string {
  const workers = doing.workers === 0 ? null : doing.workers === 1 ? "1 worker" : `${doing.workers} workers`;
  return [doing.state === "working" ? "Working" : "Waiting for you", doing.what, workers].filter(Boolean).join(" · ");
}

/** The bot's home chat, made again by the app when it is missing. */
export function openHomeChat(botId: string): Promise<SessionEntry> {
  return botsApi.homeChat(botId);
}

/** A new chat with the bot, working in `org` ("personal" or an organisation it works in; PRO-483), or its first place. */
export function startBotChat(botId: string, org?: string): Promise<SessionEntry> {
  return botsApi.newChat(botId, org);
}

/** A place a bot works in, as its chats name it. */
export interface BotPlace {
  /** "personal" or an organisation's id, as `worksIn` has it. */
  key: string;
  name: string;
}

/**
 * The places `bot` works in, in its `worksIn` order, named by the organisations the owner is in (PRO-483). An
 * organisation the account does not list (left, or not read yet) is named by its id.
 */
export function botPlaces(bot: Pick<Bot, "worksIn">, orgs: readonly { id: string; name: string }[]): BotPlace[] {
  return bot.worksIn.map((key) => ({ key, name: key === "personal" ? "Personal" : (orgs.find((org) => org.id === key)?.name ?? key) }));
}

/**
 * The place a chat of `bot` works in, by its key: the one it recorded, or the bot's first place for a chat that
 * records none (made by an earlier build, or a duty's run). Null for a place the bot no longer works in.
 */
export function chatPlace(chat: Pick<SessionEntry, "bot" | "botStarted">, bot: Pick<Bot, "worksIn">): string | null {
  const recorded = chat.bot ? chat.bot.org : chat.botStarted?.org;
  const key = typeof recorded === "string" ? recorded : (bot.worksIn[0] ?? "personal");
  return bot.worksIn.includes(key) || (key === "personal" && bot.worksIn.length === 0) ? key : null;
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
