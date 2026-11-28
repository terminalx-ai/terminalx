import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { botsApi } from "@/lib/api";
import { botSessionsKey } from "@/lib/botItems";
import type { Bot, BotPauseFrom, PauseHeld, PauseHeldEntry } from "@/types/bots";
import type { SessionEntry } from "@/types/session";

/**
 * What the paused bots hold (PRO-474, 23.12), as the sidebar rows, a bot's header and the Bots page show it. Booted
 * with the bots, only while Settings → Experimental → Bots is on, and read only while some bot is paused: with none
 * paused nothing is held, and nothing is asked for.
 *
 * It is read again, gathered for a moment, when the bots change (a pause or a resume), when a bot's list, its
 * hand-offs or a duty's runs change, when a session working for a bot changes its tabs' states (a worker ends the
 * step it was on), and after the live connection comes back. A read that fails is kept and shown as an error, never
 * as nothing held.
 */
interface State {
  held: PauseHeld | null;
  error: string | null;
}

const EMPTY: State = { held: null, error: null };
let state: State = EMPTY;
const listeners = new Set<() => void>();
const __subscribe_listeners = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function reason(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

let booted = false;
let generation = 0;
let anyPaused = false;
let unlisten: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sessionsKey = "";

/** How long reads asked for together are gathered into one. */
export const PAUSE_REFRESH_MS = 300;

async function read(mine: number) {
  try {
    const held = await botsApi.pauseHeld();
    if (mine === generation && held && Array.isArray(held.entries)) set({ held, error: null });
  } catch (error) {
    if (mine === generation) set({ error: reason(error) });
  }
}

function refresh() {
  if (!booted || !anyPaused) return;
  if (timer !== undefined) return;
  const mine = generation;
  timer = setTimeout(() => {
    timer = undefined;
    void read(mine);
  }, PAUSE_REFRESH_MS);
}

/** The bots as now read: with one paused, what is held is read (again); with none, it is forgotten. */
export function noteBotsForPause(bots: readonly Bot[]) {
  if (!booted) return;
  const paused = bots.some((bot) => !!bot.paused);
  const was = anyPaused;
  anyPaused = paused;
  if (!paused) {
    if (state.held || state.error) set(EMPTY);
    return;
  }
  if (!was) void read(generation);
  else refresh();
}

/** The sessions changed: a worker that ended its step, or a chat stopped, changes what is still in a turn. */
export function noteSessionsForPause(sessions: readonly SessionEntry[]) {
  if (!booted) return;
  const key = botSessionsKey(sessions);
  if (key === sessionsKey) return;
  sessionsKey = key;
  refresh();
}

export async function bootBotPause() {
  if (booted) return;
  booted = true;
  const mine = ++generation;
  try {
    const stops = await Promise.all(
      ["bots_changed", "bot_items_changed", "bot_handoffs_changed", "automation_run", "local_runtime_reattached"].map((name) =>
        listen(name, () => {
          if (mine === generation) refresh();
        }),
      ),
    );
    if (mine === generation) unlisten = stops;
    else for (const stop of stops) stop();
  } catch {
    /* outside a webview */
  }
}

/** The switch went off: stop listening and forget what was read. */
export function shutBotPause() {
  if (!booted) return;
  booted = false;
  generation++;
  anyPaused = false;
  sessionsKey = "";
  for (const stop of unlisten) stop();
  unlisten = [];
  clearTimeout(timer);
  timer = undefined;
  set(EMPTY);
}

/** For tests: forget everything, listeners included. */
export function resetBotPauseForTests() {
  shutBotPause();
  state = EMPTY;
  listeners.clear();
}

function useStore(): State {
  return useSyncExternalStore(
    __subscribe_listeners,
    () => state,
    () => state,
  );
}

export function usePauseHeld(): PauseHeld | null {
  return useStore().held;
}

export function usePauseHeldError(): string | null {
  return useStore().error;
}

// ---------------------------------------------------------------- words

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** "four", or "13" past twelve: how the banner counts the bots. */
export function numberWord(n: number): string {
  return NUMBERS[n] ?? String(n);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Where a pause came from, as "You paused them … at 13:42" says it. */
export function fromWords(from: BotPauseFrom | undefined): string {
  switch (from) {
    case "phone":
      return "from your phone";
    case "shortcut":
      return "with the Pause all shortcut";
    case "cli":
      return "from the command line";
    case "app":
      return "in TerminalX";
    default:
      return "";
  }
}

/** "13:42", in this computer's time. */
export function clockTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "18 minutes ago", "just now", "3 hours ago", "2 days ago". */
export function agoWords(at: string, now: number = Date.now()): string {
  const then = new Date(at).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute", "minutes")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour", "hours")} ago`;
  return `${plural(Math.floor(hours / 24), "day", "days")} ago`;
}

/** The newest pause among `bots`: what the banner tells of. */
export function latestPause(bots: readonly Bot[]): Bot["paused"] | null {
  let latest: Bot["paused"] | null = null;
  for (const bot of bots) if (bot.paused && (!latest || bot.paused.at > latest.at)) latest = bot.paused;
  return latest;
}

/**
 * The banner's first sentence: who paused them, from where, when. "You paused them from your phone at 13:42, 18
 * minutes ago." `subjects` are the bots it tells of; a bot that paused itself (or every bot) is named from `everyone`.
 */
export function pausedBySentence(subjects: readonly Bot[], everyone: readonly Bot[] = subjects, now: number = Date.now()): string {
  const paused = subjects.filter((bot) => !!bot.paused);
  const pause = latestPause(paused);
  if (!pause) return "";
  const who = pause.by === "owner" ? "You" : everyone.find((bot) => bot.id === pause.by)?.name ?? "A bot";
  const whom = paused.length === 1 ? (pause.by === paused[0].id ? "itself" : "it") : "them";
  const where = fromWords(pause.from);
  const time = clockTime(pause.at);
  const ago = agoWords(pause.at, now);
  const when = [time && `at ${time}`, ago].filter(Boolean).join(", ");
  return `${who} paused ${whom}${where ? ` ${where}` : ""}${when ? ` ${when}` : ""}.`;
}

/** The entries held for bot `botId`. */
export function heldFor(held: PauseHeld | null, botId: string): PauseHeldEntry[] {
  return held?.entries.filter((entry) => entry.botId === botId) ?? [];
}

/** Scheduled runs skipped, counting folded repeats. */
export function skippedCount(entries: readonly PauseHeldEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.kind === "skipped" ? entry.count : 0), 0);
}

export function keptCount(entries: readonly PauseHeldEntry[]): number {
  return entries.filter((entry) => entry.kind === "kept").length;
}

/** The workers of `bot` that the pause let finish, still in their step, from the pause's own record and what is in a turn now. */
function workers(bot: Bot, held: PauseHeld | null): { stopped: number; finishing: number } {
  const stopped = bot.paused?.stopped?.workers ?? 0;
  const inTurn = held?.bots.find((value) => value.id === bot.id)?.inTurn ?? 0;
  return { stopped, finishing: Math.min(stopped, inTurn) };
}

/**
 * The second line of a paused bot's row on the paused page: what is held for it, most telling first. "2 workers
 * stopped after their current step", "Your answer is kept and used on resume", "3 checks skipped so far".
 */
export function heldLine(bot: Bot, held: PauseHeld | null): string {
  const entries = heldFor(held, bot.id);
  const parts: string[] = [];
  const { stopped, finishing } = workers(bot, held);
  if (finishing > 0) parts.push(`${plural(finishing, "worker finishes its", "workers finish their")} current step, then ${finishing === 1 ? "stops" : "stop"}`);
  else if (stopped > 0) parts.push(`${plural(stopped, "worker", "workers")} stopped after ${stopped === 1 ? "its" : "their"} current step`);
  const chats = bot.paused?.stopped?.chats ?? 0;
  if (chats > 0) parts.push(`${plural(chats, "chat", "chats")} stopped mid-turn`);
  const duties = bot.paused?.stopped?.duties ?? 0;
  if (duties > 0) parts.push(`${plural(duties, "duty run", "duty runs")} stopped`);
  const answers = entries.filter((entry) => entry.source === "answer").length;
  if (answers > 0) parts.push(answers === 1 ? "Your answer is kept and used on resume" : `${answers} of your messages are kept and used on resume`);
  else if ((held?.bots.find((value) => value.id === bot.id)?.needsYou ?? 0) > 0) parts.push("Waits for your answer; it is used on resume");
  const skipped = skippedCount(entries);
  if (skipped > 0) parts.push(`${plural(skipped, "check", "checks")} skipped so far`);
  const handed = entries.filter((entry) => entry.source === "handoff").length;
  if (handed > 0) parts.push(`${plural(handed, "hand-off waits", "hand-offs wait")} for resume`);
  const events = entries.filter((entry) => entry.source === "events").length;
  if (events > 0) parts.push(`${plural(events, "duty's events wait", "duties' events wait")} for resume`);
  const messages = entries.filter((entry) => entry.source === "message").length;
  if (messages > 0) parts.push(`${plural(messages, "message waits", "messages wait")} for resume`);
  if (parts.length === 0) return "Nothing held";
  const [first, ...rest] = parts;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" · ");
}

/** The status line of a paused bot's sidebar row: "Paused · 2 workers stopped", "Paused · waits for your answer". */
export function pausedStatus(bot: Bot, held: PauseHeld | null): string {
  if (bot.resumeRequest) return "Paused · asks to resume";
  const entries = heldFor(held, bot.id);
  const { stopped } = workers(bot, held);
  if (stopped > 0) return `Paused · ${plural(stopped, "worker", "workers")} stopped`;
  const answers = entries.filter((entry) => entry.source === "answer").length;
  if (answers > 0) return "Paused · your answer is kept";
  if ((held?.bots.find((value) => value.id === bot.id)?.needsYou ?? 0) > 0) return "Paused · waits for your answer";
  const skipped = skippedCount(entries);
  if (skipped > 0) return `Paused · ${plural(skipped, "check", "checks")} skipped`;
  const kept = keptCount(entries);
  if (kept > 0) return `Paused · ${kept} kept for resume`;
  return "Paused";
}

/** The first line of a paused bot's row: "Paused · was working on “…”". */
export function wasLine(bot: Bot): string {
  const was = bot.paused?.stopped?.was;
  return was ? `Paused · ${was}` : "Paused";
}

/** What an entry of "Held while paused" says, with its bots named: "Argus · Stalled sessions and runs". */
export function heldEntryText(entry: PauseHeldEntry, bots: readonly Bot[]): string {
  const name = (id: string) => bots.find((bot) => bot.id === id)?.name ?? "A removed bot";
  const bot = name(entry.botId);
  switch (entry.source) {
    case "duty":
      return `${bot} · ${entry.name}`;
    case "events":
      return `${bot} · ${entry.name}: what arrives waits`;
    case "handoff":
      return `${entry.by === "owner" ? "You" : name(entry.fromId)} handed ${bot} #${entry.number}: ${entry.title}`;
    case "message":
      return `${entry.fromId === "owner" ? "You" : entry.fromId === "terminalx" ? "TerminalX" : name(entry.fromId)} · ${messageWords(entry.messageKind)} to ${bot}${entry.handoff ? ` on hand-off ${entry.handoff}` : ""}`;
    case "answer":
      return `Your ${entry.messageKind === "comment" ? "comment" : entry.messageKind === "work" ? "work" : "answer"} for ${bot} on #${entry.number}`;
    default:
      return bot;
  }
}

function messageWords(kind: string): string {
  switch (kind) {
    case "tell":
      return "message";
    case "answer":
      return "answer";
    case "stopped":
      return "stop";
    case "failed":
      return "failure";
    default:
      return kind || "message";
  }
}

/** What happens to an entry: "skipped", "skipped · 3 times", "kept · runs on resume". */
export function heldEntryStatus(entry: PauseHeldEntry): string {
  switch (entry.source) {
    case "duty":
      return entry.count > 1 ? `skipped · ${entry.count} times` : "skipped";
    case "events":
      return "kept · read on resume";
    case "handoff":
      return "kept · starts on resume";
    case "message":
      return "kept · sent on resume";
    case "answer":
      return "kept · used on resume";
    default:
      return "kept";
  }
}

/** The "Held while paused" card's note: "3 checks skipped · 2 events kept". */
export function heldNote(entries: readonly PauseHeldEntry[]): string {
  const skipped = skippedCount(entries);
  const kept = keptCount(entries);
  const parts = [skipped > 0 ? `${plural(skipped, "check", "checks")} skipped` : "", kept > 0 ? `${kept} kept for resume` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing has come due";
}
