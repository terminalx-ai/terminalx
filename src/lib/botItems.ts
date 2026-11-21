import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/api";
import { actingBotOf } from "@/lib/botChats";
import type { BotItem, BotItemAct, BotItemList, BotItemQuestion, NeedsYou, NeedsYouEntry } from "@/types/botItems";
import type { SessionEntry } from "@/types/session";

/**
 * A bot's work items and what needs the owner (PRO-469). Booted with the bots, only while Settings → Experimental →
 * Bots is on: off, nothing here listens or asks the app for anything.
 *
 * Every count (the Bots page, a bot's sidebar row, the Bots destination, a bot's Home tab) is read from the one
 * `needsYou` answer kept here, so they always agree. It is read again when a bot's list changes (`bot_items_changed`),
 * when the bots change (`bots_changed`), after the live connection comes back, and when a session working for a bot
 * changes its tabs' states (a question card opens or is answered there). Those reads are gathered for a moment, so
 * a bot that changes its list often costs one read, not one per change. A read that fails is kept and shown as an
 * error, never as nothing waiting.
 */

export const botItemsApi = {
  items: (id: string) => invoke<BotItemList>("bot_items", { id }),
  item: (id: string, number: number) => invoke<BotItem>("bot_item", { id, number }),
  needsYou: () => invoke<NeedsYou>("bots_needs_you"),
  /** One of the question's answers (counted from 0), or the owner's own words. `question` names the question answered. */
  answer: (id: string, number: number, choice: { answer: number } | { text: string }, question: string | null) =>
    invoke<BotItemAct>("bot_item_answer", { id, number, answer: "answer" in choice ? choice.answer : null, text: "text" in choice ? choice.text : null, question }),
  comment: (id: string, number: number, text: string) => invoke<BotItemAct>("bot_item_comment", { id, number, text }),
  give: (id: string, title: string, summary: string) => invoke<BotItemAct>("bot_item_give", { id, title, summary: summary || null }),
  stop: (id: string, number: number) => invoke<BotItemAct>("bot_item_stop", { id, number }),
  /** Send again what the owner said about an item that did not reach the bot's home chat. */
  resend: (id: string, number: number) => invoke<BotItemAct>("bot_item_resend", { id, number }),
  /** The owner reopens a done or dropped item. */
  reopen: (id: string, number: number) => invoke<BotItemAct>("bot_item_reopen", { id, number }),
};

/** What names a question when it is answered: its id, or when it was asked for one an older runtime asked. */
export function questionKey(question: BotItemQuestion): string {
  return question.id || question.asked;
}

interface State {
  /** What needs the owner across the bots; null until read. */
  needs: NeedsYou | null;
  /** Each bot's list, once a view asked for it. */
  lists: Record<string, BotItemList>;
  /** Each item a page has open, by `botId#number`, with its activity. */
  items: Record<string, BotItem>;
  /** Why the last read failed, if it did. */
  error: string | null;
  /** An item the next bot view should open: `openBotItem` sets it, the bot's view takes it. */
  opening: { botId: string; number: number } | null;
  /** Why the last read of what needs the owner failed: shown as an error, never as nothing waiting. */
  needsError: string | null;
}

const EMPTY: State = { needs: null, lists: {}, items: {}, error: null, opening: null, needsError: null };
let state: State = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function reason(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

const itemKey = (botId: string, number: number) => `${botId}#${number}`;

let booted = false;
let generation = 0;
let unlisten: (() => void)[] = [];

async function readNeeds(mine: number) {
  try {
    const needs = await botItemsApi.needsYou();
    if (mine === generation && needs && Array.isArray(needs.entries)) set({ needs, needsError: null });
  } catch (error) {
    if (mine === generation) set({ needsError: reason(error) });
  }
}

async function readList(botId: string, mine = generation) {
  try {
    const list = await botItemsApi.items(botId);
    if (mine === generation && list && Array.isArray(list.items)) set({ lists: { ...state.lists, [botId]: list } });
  } catch (error) {
    if (mine === generation) set({ error: reason(error) });
  }
}

async function readItem(botId: string, number: number, mine = generation) {
  try {
    const item = await botItemsApi.item(botId, number);
    if (mine === generation && item) set({ items: { ...state.items, [itemKey(botId, number)]: item } });
  } catch (error) {
    if (mine === generation) set({ error: reason(error) });
  }
}

/** How long reads asked for together are gathered into one. */
export const REFRESH_MS = 300;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** The bots whose lists are to be read again; "all" for every one. */
let refreshing: Set<string> | "all" | null = null;

/** Read again what is shown of bot `botId` (every bot's when null), once the changes of the moment are in. */
function refresh(botId: string | null) {
  if (!booted) return;
  refreshing = botId === null || refreshing === "all" ? "all" : new Set([...(refreshing ?? []), botId]);
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    const which = refreshing;
    refreshing = null;
    readNow(which === "all" ? null : which ?? new Set());
  }, REFRESH_MS);
}

/** One read of what needs the owner, and of the lists and items shown of `bots` (every bot when null). */
function readNow(bots: Set<string> | null) {
  if (!booted) return;
  const mine = generation;
  void readNeeds(mine);
  const shown = (id: string) => bots === null || bots.has(id);
  for (const id of Object.keys(state.lists)) if (shown(id)) void readList(id, mine);
  for (const key of Object.keys(state.items)) {
    const [id, number] = key.split("#");
    if (shown(id)) void readItem(id, Number(number), mine);
  }
}

export async function bootBotItems() {
  if (booted) return;
  booted = true;
  const mine = ++generation;
  try {
    const stops = await Promise.all([
      listen<{ botId?: string }>("bot_items_changed", (event) => {
        if (mine === generation) refresh(typeof event.payload?.botId === "string" ? event.payload.botId : null);
      }),
      listen("local_runtime_reattached", () => {
        if (mine === generation) refresh(null);
      }),
      // A bot hired, paused, renamed or removed changes the counts.
      listen("bots_changed", () => {
        if (mine === generation) refresh(null);
      }),
    ]);
    if (mine === generation) unlisten = stops;
    else for (const stop of stops) stop();
  } catch {
    /* outside a webview */
  }
  await readNeeds(mine);
}

/** The switch went off: stop listening and forget what was read. */
export function shutBotItems() {
  if (!booted) return;
  booted = false;
  generation++;
  for (const stop of unlisten) stop();
  unlisten = [];
  clearTimeout(sessionsTimer);
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  refreshing = null;
  sessionsKey = "";
  set(EMPTY);
}

let sessionsKey = "";
let sessionsTimer: ReturnType<typeof setTimeout> | undefined;

/** What says a question card may have opened or closed in a session working for a bot: its tabs' states. */
export function botSessionsKey(sessions: readonly SessionEntry[]): string {
  const parts: string[] = [];
  for (const session of sessions) {
    if (session.archived || !actingBotOf(session)) continue;
    parts.push(`${session.id}:${session.tabs.map((tab) => tab.status).join(",")}`);
  }
  return parts.sort().join("|");
}

/** The sessions changed: when one working for a bot changed its tabs' states, read what needs the owner again. */
export function noteBotSessions(sessions: readonly SessionEntry[]) {
  if (!booted) return;
  const key = botSessionsKey(sessions);
  if (key === sessionsKey) return;
  const first = sessionsKey === "";
  sessionsKey = key;
  if (first) return;
  clearTimeout(sessionsTimer);
  const mine = generation;
  sessionsTimer = setTimeout(() => void readNeeds(mine), 250);
}

function useStore(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function useNeedsYou(): NeedsYou | null {
  return useStore().needs;
}

/** Why what needs the owner could not be read, if the last read failed. */
export function useNeedsYouError(): string | null {
  return useStore().needsError;
}

/** How many things wait on the owner from bot `botId` (every bot when null). */
export function needsYouCount(needs: NeedsYou | null, botId: string | null): number {
  if (!needs) return 0;
  return needs.counts.filter((count) => !botId || count.botId === botId).reduce((sum, count) => sum + count.needsYou, 0);
}

/**
 * Why a count cannot be trusted: the read of what needs the owner failed, or bot `botId`'s list (any bot's when null)
 * could not be read. Shown as an error where the count would be, never as zero.
 */
export function needsYouTrouble(needs: NeedsYou | null, failed: string | null, botId: string | null): string | null {
  if (failed) return failed;
  const broken = (needs?.counts ?? []).find((count) => count.error && (!botId || count.botId === botId));
  return broken?.error ?? null;
}

/** An older runtime that does not know the work lists answers this way: only restarting it helps. */
export function olderRuntime(error: string | null): boolean {
  return !!error && /Unknown bots operation (needsYou|items|item)\b/.test(error);
}

/** The entries of `needs` for bot `botId`, newest first. */
export function needsYouOf(needs: NeedsYou | null, botId: string): NeedsYouEntry[] {
  return (needs?.entries ?? []).filter((entry) => entry.botId === botId);
}

/** Bot `botId`'s list, read when a view first asks for it. */
export function useBotItems(botId: string): { list: BotItemList | null; error: string | null } {
  const store = useStore();
  useEffect(() => {
    if (booted && !state.lists[botId]) void readList(botId);
  }, [botId]);
  return { list: store.lists[botId] ?? null, error: store.error };
}

/** One item with its activity, read when its page opens. */
export function useBotItem(botId: string, number: number): BotItem | null {
  const store = useStore();
  useEffect(() => {
    if (booted) void readItem(botId, number);
  }, [botId, number]);
  return store.items[itemKey(botId, number)] ?? store.lists[botId]?.items.find((item) => item.number === number) ?? null;
}

/** Take an act's answer at once; its `bot_items_changed` follows. */
function took(botId: string, act: BotItemAct): BotItemAct {
  const item = act.item;
  if (!item) {
    void readNeeds(generation);
    return act;
  }
  const list = state.lists[botId];
  const items = { ...state.items };
  if (items[itemKey(botId, item.number)]) items[itemKey(botId, item.number)] = item;
  const lists = list
    ? { ...state.lists, [botId]: { ...list, items: list.items.some((value) => value.number === item.number) ? list.items.map((value) => (value.number === item.number ? { ...value, ...item } : value)) : [item, ...list.items] } }
    : state.lists;
  set({ items, lists });
  void readNeeds(generation);
  return act;
}

export async function answerBotItem(botId: string, number: number, choice: { answer: number } | { text: string }, question: string | null) {
  return took(botId, await botItemsApi.answer(botId, number, choice, question));
}

export async function reopenBotItem(botId: string, number: number) {
  return took(botId, await botItemsApi.reopen(botId, number));
}

export async function resendBotItem(botId: string, number: number) {
  return took(botId, await botItemsApi.resend(botId, number));
}

export async function commentOnBotItem(botId: string, number: number, text: string) {
  return took(botId, await botItemsApi.comment(botId, number, text));
}

export async function giveBotWork(botId: string, title: string, summary: string) {
  return took(botId, await botItemsApi.give(botId, title, summary));
}

export async function stopBotItem(botId: string, number: number) {
  return took(botId, await botItemsApi.stop(botId, number));
}

/** Read what needs the owner again now (after answering a session's question card). */
export function refreshNeedsYou() {
  if (booted) void readNeeds(generation);
}

/** Open item `number` of bot `botId` on its bot's Home tab. */
export function openBotItem(botId: string, number: number, open: (botId: string) => void) {
  set({ opening: { botId, number } });
  open(botId);
}

/** The item a bot view should open now, once: taking it clears it. */
export function useOpeningItem(botId: string): number | null {
  const store = useStore();
  return store.opening?.botId === botId ? store.opening.number : null;
}

export function tookOpening() {
  if (state.opening) set({ opening: null });
}

/** Whether an item is out of the way until a later time. */
export function snoozed(item: Pick<BotItem, "snoozedUntil" | "state">, now = Date.now()): boolean {
  if (!item.snoozedUntil || item.state === "done" || item.state === "dropped" || item.state === "needsYou") return false;
  const until = Date.parse(item.snoozedUntil);
  return !Number.isNaN(until) && until > now;
}

/** Whether `iso` falls on the same local day as `now`. */
export function sameDay(iso: string | undefined, now = new Date()): boolean {
  if (!iso) return false;
  const at = new Date(iso);
  return !Number.isNaN(at.getTime()) && at.toDateString() === now.toDateString();
}

/** For tests: what was read, and the item a bot view should open. */
export function getNeedsForTests(): NeedsYou | null {
  return state.needs;
}

export function getNeedsErrorForTests(): string | null {
  return state.needsError;
}

export function getOpeningForTests() {
  return state.opening;
}

/** For tests: forget everything, listeners included. */
export function resetBotItemsForTests() {
  shutBotItems();
  state = EMPTY;
  listeners.clear();
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
