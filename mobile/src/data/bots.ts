/**
 * The bots as a phone reads them (PRO-479), from a Mac that names `bots`:
 * the desktop's own types (`src/types/bots.ts`, `src/types/botItems.ts`), so
 * the two sides read one wire, plus what only the phone's screens are sent.
 * A state or kind a newer Mac writes arrives as its own string and is shown
 * as itself.
 */
import type { Bot, BotList } from "../../../src/types/bots";
import type { BotItem, BotItemList, BotItemQuestion, NeedsYou, NeedsYouEntry } from "../../../src/types/botItems";

export type { Bot, BotItem, BotItemQuestion, NeedsYou, NeedsYouEntry };

/** What a bot is doing, for its row on the Bots tab. */
export interface BotTeamLine {
  botId: string;
  /** Its most recently changed item in progress. */
  working?: string | null;
  workingSince?: string | null;
  /** The soonest next run of its duties that are on. */
  nextCheck?: string | null;
}

/** `bots.list`: every bot, what needs the owner across them, and what each is doing. */
export interface BotsOverview {
  bots: BotList;
  needsYou: NeedsYou;
  team: BotTeamLine[];
}

/** One of a bot's chats: an ordinary session on the Mac. */
export interface BotChat {
  sessionId: string;
  tabId: string | null;
  title: string;
  modified: string;
  /** The bot's home chat, where its owner's answers go. */
  home: boolean;
  /** A duty's run. */
  duty: boolean;
  running: boolean;
}

/** A duty as the phone shows it: an automation that names its bot. */
export interface BotDuty {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { kind: string; preset?: string; cron?: string; hour?: number; minute?: number; weekdays?: string[] };
  /** Wakes on events rather than (or as well as) its schedule. */
  events: boolean;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastOutcome?: string | null;
}

/** `bots.home`: a bot's record, list, chats, duties and role. */
export interface BotHome {
  bot: Bot;
  items: BotItemList;
  chats: BotChat[];
  duties: BotDuty[];
  role: { text: string; cut: boolean } | { unreadable: string };
}

/** What an answer from the phone comes back with: the item as saved, and whether it reached the bot's home chat. */
export interface BotAnswerResult {
  item: BotItem | null;
  delivery?: { sent: boolean; sessionId?: string; error?: string };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, ...keys: string[]): value is Record<string, unknown> => object(value) && keys.every((key) => typeof value[key] === "string");

function isBot(value: unknown): value is Bot {
  return strings(value, "id", "name", "roleTitle");
}

function isItem(value: unknown): value is BotItem {
  return object(value) && Number.isSafeInteger(value.number) && typeof value.title === "string" && typeof value.state === "string";
}

function isItemList(value: unknown): value is BotItemList {
  return object(value) && Array.isArray(value.items) && value.items.every(isItem);
}

function isEntry(value: unknown): value is NeedsYouEntry {
  if (!strings(value, "kind", "botId")) return false;
  if (value.kind === "item") return isItem(value.item);
  if (value.kind === "agentQuestion") return strings(value, "sessionId", "tabId", "requestId") && Array.isArray(value.questions);
  // A kind a newer Mac sends: kept out of the list rather than drawn wrong.
  return false;
}

/** A `bots.list` answer, with any entry this phone cannot read left out. */
export function readOverview(value: unknown): BotsOverview | null {
  if (!object(value) || !object(value.bots) || !Array.isArray(value.bots.bots) || !object(value.needsYou) || !Array.isArray(value.needsYou.entries)) return null;
  const bots = value.bots.bots.filter(isBot);
  const needs = value.needsYou as Record<string, unknown>;
  return {
    bots: { revision: Number(value.bots.revision) || 0, bots, unreadable: Number(value.bots.unreadable) || 0 },
    needsYou: {
      entries: (needs.entries as unknown[]).filter(isEntry),
      counts: Array.isArray(needs.counts) ? needs.counts.filter((count) => strings(count, "botId")) as unknown as NeedsYou["counts"] : [],
    },
    team: Array.isArray(value.team) ? value.team.filter((line) => strings(line, "botId")) as unknown as BotTeamLine[] : [],
  };
}

/** A `bots.home` answer. */
export function readHome(value: unknown): BotHome | null {
  if (!object(value) || !isBot(value.bot) || !isItemList(value.items)) return null;
  const chats = Array.isArray(value.chats) ? value.chats.filter((chat) => strings(chat, "sessionId", "title")) as unknown as BotChat[] : [];
  const duties = Array.isArray(value.duties) ? value.duties.filter((duty) => strings(duty, "id", "name") && object(duty.schedule)) as unknown as BotDuty[] : [];
  const role = object(value.role) && typeof value.role.text === "string" ? { text: value.role.text, cut: value.role.cut === true }
    : { unreadable: object(value.role) && typeof value.role.unreadable === "string" ? value.role.unreadable : "The role could not be read." };
  return { bot: value.bot, items: value.items, chats, duties, role };
}

export function readAnswer(value: unknown): BotAnswerResult | null {
  if (!object(value)) return null;
  const item = isItem(value.item) ? value.item : null;
  const delivery = object(value.delivery) && typeof value.delivery.sent === "boolean" ? value.delivery as BotAnswerResult["delivery"] : undefined;
  return { item, ...(delivery ? { delivery } : {}) };
}

/** A question's answers in the order the phone offers them: the recommended one first, each with its index on the Mac. */
export function answerOrder(question: Pick<BotItemQuestion, "answers" | "recommended">): { index: number; label: string; recommended: boolean }[] {
  const answers = question.answers.map((label, index) => ({ index, label, recommended: index === question.recommended }));
  return [...answers.filter((answer) => answer.recommended), ...answers.filter((answer) => !answer.recommended)];
}

/** What names the question an answer is for (`bots.answer`'s `question`): its id, or when it was asked for one an older Mac asked. */
export function questionKey(question: Pick<BotItemQuestion, "id" | "asked">): string {
  return question.id || question.asked;
}

/** "now", "8m", "3h", "2d": how long ago, as the lists say it. Empty for a time that cannot be read. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "13:30", in the phone's time. */
export function clock(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export type TeamTone = "needs" | "working" | "quiet" | "paused";

/** A bot's row on the Bots tab (23.08): what it is doing, in a word or a line, and since when. */
export function teamStatus(bot: Bot, line: BotTeamLine | undefined, needsYou: number, now = Date.now()): { text: string; tone: TeamTone; at: string } {
  if (bot.paused) return { text: "Paused", tone: "paused", at: ago(bot.paused.at, now) };
  if (needsYou > 0) return { text: "Needs your answer", tone: "needs", at: "" };
  if (line?.working) return { text: line.working, tone: "working", at: ago(line.workingSince, now) };
  const next = line?.nextCheck ? clock(line.nextCheck) : "";
  return { text: next ? `Quiet · next check ${next}` : "Quiet", tone: "quiet", at: "" };
}

/** The question an entry asks, in one line. */
export function entryQuestion(entry: NeedsYouEntry): string {
  if (entry.kind === "item") return entry.item.question?.text ?? entry.item.title;
  const [first, ...rest] = entry.questions;
  if (!first) return entry.sessionTitle;
  return rest.length ? `${first.question} (and ${rest.length} more)` : first.question;
}

const DAYS: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };

/** When a duty wakes, as the desktop's duty list says it (`describeSchedule`). */
export function dutyWhen(duty: BotDuty): string {
  if (duty.events) return "On events";
  const { schedule } = duty;
  const at = `${String(schedule.hour ?? 9).padStart(2, "0")}:${String(schedule.minute ?? 0).padStart(2, "0")}`;
  if (schedule.kind === "cron") {
    const cron = schedule.cron?.trim() ?? "";
    const everyMinutes = cron.match(/^\*\/(\d+) \* \* \* \*$/);
    if (everyMinutes) return `Every ${everyMinutes[1]} minutes`;
    const hourly = cron.match(/^(\d{1,2}) \* \* \* \*$/);
    if (hourly) return `Every hour at :${hourly[1].padStart(2, "0")}`;
    return "Custom schedule";
  }
  switch (schedule.preset) {
    case "hourly": return schedule.minute ? `Every hour at :${String(schedule.minute).padStart(2, "0")}` : "Hourly";
    case "daily": return `Daily at ${at}`;
    case "weekdays": return `Weekdays at ${at}`;
    case "weekly": {
      const day = DAYS[schedule.weekdays?.[0] ?? ""];
      return day ? `${day}s at ${at}` : `Weekly at ${at}`;
    }
    default: return "Schedule";
  }
}

/** A duty's last run, in words. */
export function dutyOutcome(outcome: string | null | undefined): string {
  switch (outcome) {
    case "completed": return "Last run finished";
    case "failed": return "Last run failed";
    case "timedOut": return "Last run timed out";
    case "cancelled": return "Last run cancelled";
    case "running": case "pending": return "Running";
    case "skippedPrecheck": return "Nothing new last time";
    case "skippedMissed": case "skippedUnavailable": return "Last run skipped";
    case null: case undefined: case "": return "Not run yet";
    default: return outcome;
  }
}
